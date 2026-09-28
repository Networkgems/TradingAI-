# -----------------------------------------------------------------------------
# cutover-data-dir.ps1 -- TRA-4896. ONE elevated command to apply the data-dir
# relocation, verify it, and leave the box serving either way.
#
# Why this wrapper exists, when ops/relocate-data-dir.mjs already moves the bytes:
# the relocation needs THREE steps in a load-bearing order, and two of them are
# pm2 calls that are EPERM from an agent session. The card asking a human to
# compose `pm2 stop` -> relocate -> `pm2 delete; pm2 start; pm2 save` sat
# unanswered for three days. A sequence a human has to assemble by hand, under
# elevation, with an ordering whose failure mode is a silently-empty book, is not
# a one-minute task no matter how short the command list reads. So it ships as
# one command with the preconditions asserted UP FRONT.
#
# -- Why `pm2 restart` is not enough (the thing that looks like it should work) --
# `resolveDataDir()` takes `process.env.DATA_DIR` VERBATIM when set, and
# C:\Users\eetienne\.pm2\dump.pm2 records the OLD in-scratch-tree path explicitly.
# A plain `pm2 restart` re-execs the app with that SAVED env, so it reproduces the
# old path exactly. Only `pm2 delete` + `pm2 start ecosystem.config.cjs` re-reads
# the config and replaces the saved env. This was measured: the server restarted
# on its own at 2026-09-27T22:23Z, after the relocation was already live at HEAD,
# and still reported the old dataDir. Do not "simplify" the delete away.
#
# -- Two preconditions that silently DEFEAT the cutover, so both are asserted --
# 1. Elevation. pm2's RPC socket is EPERM unelevated. Checked BEFORE anything is
#    stopped, because failing after the stop leaves the box down.
# 2. `DATA_DIR` must NOT be set in the calling shell. ecosystem.config.cjs honours
#    an inherited DATA_DIR over its own default (that is the TRA-522 contract), so
#    an elevated prompt that happens to export the old path would re-pin it and
#    the cutover would read as having done nothing.
#
# Usage, from an ELEVATED PowerShell:
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\cutover-data-dir.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\cutover-data-dir.ps1
#
# Exit codes (a non-zero is never "probably fine"):
#   0  DONE      -- cut over, and /api/health/durability verified green
#   1  PRECOND   -- not elevated / DATA_DIR inherited / repo or tool missing. Nothing touched.
#   2  REFUSED   -- relocate-data-dir.mjs refused; server RESTARTED, nothing moved.
#   3  PM2_FAIL  -- a pm2 step failed. Read the message; the source dir is intact.
#   4  UNVERIFIED-- cutover ran but durability did not go green. Loud on purpose.
# -----------------------------------------------------------------------------
# KEEP THIS FILE PURE ASCII. It has no BOM (matching the other ops/*.ps1), and
# PowerShell 5.1 therefore reads it as cp1252. A UTF-8 em-dash (E2 80 94) decodes
# to `a-EUR-U+201D`, and U+201D is a STRING DELIMITER to PowerShell's tokenizer --
# so one em-dash inside a string literal makes the whole file fail to parse. The
# other ops scripts survive their em-dashes only because theirs sit in COMMENTS.
# Verify with:
#   [System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$null,[ref]$e)
[CmdletBinding()]
param(
  [switch]$DryRun,
  [int]$Port = 4242,
  [int]$HealthTimeoutSec = 90
)

$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\eetienne\.paperclip\instances\default\projects\fc64eaf4-0c08-4270-9a4c-31ee16594dec\b6a879bc-aabf-4ee4-9e47-12404018a8f1\_default\tradingai_repo'
$pm2  = 'C:\Users\eetienne\AppData\Roaming\npm\node_modules\pm2\bin\pm2'
$node = 'C:\Program Files\nodejs\node.exe'
$app  = 'trading-server'
$env:PM2_HOME = 'C:\Users\eetienne\.pm2'

$healthUrl = "http://localhost:$Port/api/health/durability"

function Say($m) { Write-Output "[cutover] $m" }
function Fail($code, $m) { Write-Output "[cutover] FAIL($code): $m"; exit $code }

# -- 1. preconditions -- assert BEFORE stopping anything -----------------------
# -DryRun writes nothing and stops nothing, so it deliberately requires NEITHER
# elevation nor a clean DATA_DIR: the preview has to be runnable from the same
# unelevated session that is reading this file, or nobody checks it first.
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated -and -not $DryRun) {
  Fail 1 "Must run ELEVATED (pm2's RPC socket is EPERM otherwise). Re-run from an Administrator PowerShell: powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
}

if ($env:DATA_DIR -and $env:DATA_DIR.Trim()) {
  if ($DryRun) {
    Say "WARN: DATA_DIR is set in this shell ('$($env:DATA_DIR)'). A real run would REFUSE -- ecosystem.config.cjs honours an inherited DATA_DIR over its own default, so it would re-pin the old path and appear to do nothing."
  } else {
    Fail 1 "DATA_DIR is set in this shell ('$($env:DATA_DIR)'). ecosystem.config.cjs honours an inherited DATA_DIR over its own default, so this run would re-pin the old path and appear to do nothing. Open a shell without it (or ``Remove-Item Env:DATA_DIR``) and re-run."
  }
}

foreach ($p in @(@{n='repo';v=$repo}, @{n='pm2';v=$pm2}, @{n='node';v=$node})) {
  if (-not (Test-Path $p.v)) { Fail 1 "$($p.n) not found at $($p.v)" }
}

$expectedTarget = Join-Path (Join-Path $env:ProgramData 'TradingAI') 'data'
Say "target DATA_DIR = $expectedTarget"

Push-Location $repo
try {
  # -- 2. dry run short-circuits: print the plan, touch nothing, leave app up --
  if ($DryRun) {
    Say "DRY RUN -- server is left running; nothing is stopped, copied or re-pinned."
    & $node 'ops\relocate-data-dir.mjs' '--dry-run' "--port=$Port"
    $rc = $LASTEXITCODE
    Say "relocate --dry-run exit = $rc"
    Say "Real run would then: pm2 stop $app -> relocate -> pm2 delete $app -> pm2 start ecosystem.config.cjs -> pm2 save -> verify $healthUrl"
    exit 0
  }

  # -- 3. stop the writer. The book is SQLite in WAL mode; copying state.db +
  #       -wal + -shm from under a live writer yields a torn snapshot whose
  #       corruption surfaces later, at hydrate. relocate-data-dir.mjs refuses
  #       while the port answers, so give the listener time to actually close.
  Say "stopping $app ..."
  & $node $pm2 stop $app
  if ($LASTEXITCODE -ne 0) { Fail 3 "pm2 stop exited $LASTEXITCODE -- nothing was moved." }

  $deadline = (Get-Date).AddSeconds(30)
  $portOpen = $true
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
      Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3 | Out-Null
    } catch {
      $portOpen = $false
      break
    }
  }
  if ($portOpen) { Fail 3 "port $Port still answering 30s after 'pm2 stop'. Something else serves it; refusing to copy a live WAL database." }
  Say "port $Port is closed."

  # -- 4. move the BYTES. Changing the pointer alone boots a fresh empty book,
  #       and an empty multi-session ledger reads as a QUIET WINDOW, not as
  #       missing data. Source is left intact as the rollback.
  Say "relocating data dir ..."
  & $node 'ops\relocate-data-dir.mjs' "--port=$Port"
  $rc = $LASTEXITCODE
  if ($rc -ne 0) {
    Say "relocate refused/failed (exit $rc). Restarting $app on the ORIGINAL dir so the box keeps serving."
    & $node $pm2 start $app
    Fail 2 "relocate-data-dir.mjs exit $rc (1=live writer, 2=target occupied, 3=blind, 4=usage). Nothing was moved; $app restarted on the old dir."
  }
  Say "bytes copied and verified."

  # -- 5. re-pin the pointer. delete+start, NOT restart (see header). ----------
  Say "re-pinning DATA_DIR via pm2 delete + start ..."
  & $node $pm2 delete $app
  if ($LASTEXITCODE -ne 0) { Say "WARN: pm2 delete exited $LASTEXITCODE (continuing; start is what matters)." }

  & $node $pm2 start 'ecosystem.config.cjs'
  if ($LASTEXITCODE -ne 0) { Fail 3 "pm2 start ecosystem.config.cjs exited $LASTEXITCODE. Bytes ARE copied; the old dir is intact. Recover with: $node $pm2 start ecosystem.config.cjs" }

  # pm2 save is load-bearing, not housekeeping: the boot task restores dump.pm2
  # and nothing else, so an unsaved cutover is reverted by the next reboot. The
  # dump on this box was last written 2026-06-06 -- it does NOT get saved by itself.
  & $node $pm2 save
  if ($LASTEXITCODE -ne 0) { Say "WARN: pm2 save exited $LASTEXITCODE -- the cutover will NOT survive a reboot until 'pm2 save' succeeds." }

  # -- 6. verify on the ROUTE, not on the flag we just wrote -------------------
  Say "waiting for $healthUrl ..."
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
  $h = $null
  while ((Get-Date) -lt $deadline) {
    try { $h = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5; break } catch { Start-Sleep -Seconds 3 }
  }
  if ($null -eq $h) { Fail 4 "no answer on $healthUrl after ${HealthTimeoutSec}s. Check: $node $pm2 logs $app" }

  Say "ok=$($h.ok)  ephemeral=$($h.ephemeral)  ephemeralReason=$($h.ephemeralReason)"
  Say "dataDir=$($h.dataDir)"
  Say "violations=$($h.violations -join ',')"

  $normLive = ($h.dataDir -replace '/', '\')
  $normWant = ($expectedTarget -replace '/', '\')
  if ($normLive -ne $normWant) { Fail 4 "dataDir is '$($h.dataDir)', expected '$expectedTarget'. The pointer did not move -- check for an inherited DATA_DIR in the pm2 daemon's own env." }
  if ($h.ephemeral) { Fail 4 "still ephemeral (reason=$($h.ephemeralReason)) at $($h.dataDir)." }
  # @() wraps a null/scalar so .Count is always defined -- a bare $h.violations.Count
  # throws on null under 5.1, which would read as a crash rather than as a verdict.
  $viol = @($h.violations)
  if ($viol.Count -ne 0) { Fail 4 "durability still reports violations: $($viol -join ',')" }
  if (-not $h.ok) { Fail 4 "violations are empty but ok=false -- report this, it is a predicate bug." }

  Say "DONE -- durability reads ok:true, violations:[], ephemeralReason:null at $($h.dataDir)"
  Say "Rollback, if ever needed: pm2 delete $app; set DATA_DIR back to the old path; pm2 start ecosystem.config.cjs; pm2 save. The old dir was left byte-intact."
  exit 0
}
finally {
  Pop-Location
}
