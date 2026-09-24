# ─────────────────────────────────────────────────────────────────────────────
# pm2-resurrect-boot.ps1 — TRA-605 / TRA-493 Part A.
#
# Runs at machine start (as LOCAL_SYSTEM, via the "PM2 Resurrect" scheduled task
# created by ops/install-pm2-autostart.ps1). Re-spawns the PM2 daemon and
# restores the saved process list so `trading-server` comes back up after an
# unattended reboot of PG-DEVOPS14.
#
# TRA-491 root cause: after a host reboot the PM2 daemon was dead and nothing
# restored the saved process list, silently taking trading-server (and the
# News-tab POST path) down until a human re-ran ops/bootstrap-trading-server.sh.
#
# Design notes
# - PM2_HOME is PINNED to the eetienne user home so we resurrect the SAME
#   dump.pm2 (which carries the baked-in ADMIN_PASSWORD / AUTH_SECRET — the
#   server has no dotenv loader, secrets live only in the saved process env).
# - The pm2 entry point is referenced by ABSOLUTE PATH (no npx/PATH dependence,
#   which is unreliable in the SYSTEM boot context with no network guarantee).
# - `pm2 resurrect` auto-spawns the daemon if it is not already running, then
#   restores the dump. It is a short-lived command; the daemon it spawns is the
#   long-running process.
# - TRA-4851 staleness guard: the dump points trading-server at the SHARED
#   checkout ($repo below), so every boot re-serves whatever HEAD that checkout
#   holds — on 2026-09-24 that was 42 days / ~600 commits stale, silently, for
#   at least 3 boots (TRA-4849). After the health gate this wrapper runs
#   scripts/check-boot-staleness.mjs FROM that checkout; a CONFIRMED-stale HEAD
#   (older than the threshold AND origin/main ahead) stops trading-server so
#   the failure mode is no-listener/loud instead of stale-listener/silent. The
#   guard's logic lives in the repo (agent-editable/testable, selftest'd); this
#   wrapper only maps its exit code to a disposition.
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'

$env:PM2_HOME = 'C:\Users\eetienne\.pm2'
$pm2  = 'C:\Users\eetienne\AppData\Roaming\npm\node_modules\pm2\bin\pm2'
$node = 'C:\Program Files\nodejs\node.exe'
$log  = Join-Path $env:PM2_HOME 'resurrect-boot.log'
$repo = 'C:\Users\eetienne\.paperclip\instances\default\projects\fc64eaf4-0c08-4270-9a4c-31ee16594dec\b6a879bc-aabf-4ee4-9e47-12404018a8f1\_default\tradingai_repo'

function Log($m) { "$(Get-Date -Format o)  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

try {
  Log "boot resurrect starting (PM2_HOME=$env:PM2_HOME)"
  & $node $pm2 resurrect *>> $log
  Log "pm2 resurrect exit code = $LASTEXITCODE"

  # Health gate: wait up to 60s for trading-server to answer on :4242.
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing 'http://localhost:4242/api/health' -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
  }
  Log ("health after resurrect: " + ($(if ($ok) { 'OK 200' } else { 'NOT healthy within 60s' })))

  # ── TRA-4851: refuse to silently re-serve a stale checkout ──────────────────
  # Exit codes: 0 FRESH · 1 STALE_CONFIRMED (stop the server: no-listener/loud)
  # · 2 STALE_UNCONFIRMED (origin unreachable: loud, keep serving) · 3 BLIND.
  $guard = Join-Path $repo 'scripts\check-boot-staleness.mjs'
  if (-not (Test-Path $guard)) {
    Log "TRA-4851 WARNING: staleness guard missing at $guard - this boot is UNGUARDED against re-serving a stale build."
  } else {
    & $node $guard "--repo=$repo" *>> $log
    $guardExit = $LASTEXITCODE
    switch ($guardExit) {
      0 { Log "TRA-4851 staleness guard: FRESH (exit 0)" }
      1 {
        Log "TRA-4851 STALE_CONFIRMED: the checkout this boot just re-served is confirmed stale (HEAD over threshold AND origin/main ahead)."
        Log "Stopping trading-server: a missing listener on :4242 is LOUD; a stale one graded as live health is the TRA-4849 incident."
        & $node $pm2 stop trading-server *>> $log
        $marker = Join-Path $env:PM2_HOME 'stale-boot-refused.marker'
        "$(Get-Date -Format o)  TRA-4851: boot refused - stale checkout at $repo. Remedy: git pull; pnpm --filter @trading-app/server build; pm2 restart trading-server; pm2 save. Details in resurrect-boot.log." |
          Out-File -FilePath $marker -Encoding utf8
        Log "Marker written: $marker. Task exits 1 so the refusal is visible in Task Scheduler history."
        exit 1
      }
      2 { Log "TRA-4851 STALE_UNCONFIRMED: HEAD is over the age threshold but origin was unreachable - SERVING CONTINUES; treat every read as suspect until the checkout is confirmed current." }
      3 { Log "TRA-4851 BLIND: the guard could not read the checkout at all - SERVING CONTINUES but this boot's build identity is UNVERIFIED." }
      default { Log "TRA-4851 guard returned unexpected exit $guardExit - treating as unverified, serving continues." }
    }
  }
} catch {
  Log "ERROR: $_"
  exit 1
}
