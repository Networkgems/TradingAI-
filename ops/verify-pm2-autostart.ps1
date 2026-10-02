# ─────────────────────────────────────────────────────────────────────────────
# verify-pm2-autostart.ps1 — TRA-605 gate-4 check. NO ADMIN REQUIRED.
#
# TRA-605 sat for 36 days in `in_review` waiting on a human to reboot the box and
# report back. The reboot happened on its own (2026-07-12 07:33Z) and nobody
# noticed it had FAILED: the "PM2 Resurrect" task was not registered on the host
# at all, so trading-server stayed down ~16.7h. A gate nobody can re-check on
# demand is a gate that silently rots.
#
# This makes that gate self-serve. Any human or agent can run it, any time, with
# no elevation and no reboot, and get a verdict:
#
#   C1 task registered?
#   C2 does the -File it will run at boot actually exist? (a dangling path is
#      SILENT at boot — the exact TRA-605 regression)
#   C3 is there a saved dump.pm2 for it to restore?
#   C2S does the wrapper the installer PROMISES to stage actually exist at the
#      stable path, and does it match the repo? (checkable with NO elevation,
#      unlike C2 — TRA-4853)
#   C3 is there a saved dump.pm2 for it to restore?
#   C4 boot evidence: if the host HAS rebooted since, did trading-server come
#      back near boot, or hours later (i.e. by a human)?
#
# Exit 0 = PASS (autostart is armed) · 1 = FAIL (reasons printed)
#      · 2 = UNVERIFIED (nothing failed, but a load-bearing fact could not be
#        read — TRA-4853).
#
# TRA-4853: this script used to exit 0 / "VERDICT: PASS - PM2 autostart is
# armed" in a state where it had checked almost nothing. When the task is
# registered-but-unreadable (the normal non-elevated case here), C1 printed
# PASS-UNREADABLE, C2 never ran at all because it is nested inside `if ($task)`,
# and the C4 finding "it did NOT autostart" was appended to $fail only under
# that same `if ($task)` — so it was SWALLOWED in exactly the state where the
# task cannot be read. The gate therefore reported the strongest possible verdict
# while the -File target was unknown AND the promised staged path was an empty
# directory. Per this repo's own rule (CLAUDE.md, "A health field reports the
# outcome of the last REAL attempt"): absent evidence is its own named state and
# an alarm, not a pass. "Could not check" and "checked and it is fine" must never
# share an exit code.
#
# -SelfTest runs the boot-log parser against a synthetic MIXED-ENCODING fixture
# and exits without touching the host (TRA-4853, 2026-10-02). See
# Get-BootLogEntries for why that parser needs a control at all.
# ─────────────────────────────────────────────────────────────────────────────
param([switch]$SelfTest)

$taskName   = 'PM2 Resurrect'
$pm2Home    = 'C:\Users\eetienne\.pm2'
$health     = 'http://localhost:4242/api/health'
$stableDir  = 'C:\ProgramData\TradingAI\ops'
$stableWrap = Join-Path $stableDir 'pm2-resurrect-boot.ps1'
$repoWrap   = Join-Path $PSScriptRoot 'pm2-resurrect-boot.ps1'
$bootLog    = Join-Path $pm2Home 'resurrect-boot.log'
$fail       = @()
$unverified = @()
# C1 could not read the task; whether that is still a load-bearing unknown is
# decided after C4, which may have recovered the -File from the boot log.
$c1Unreadable = $false
$bootLogFile  = $null

# ---- boot-log parser (TRA-4853) ----------------------------------------------
# The boot log is a MIXED-ENCODING append-only artifact and the grader has to
# tolerate it. The wrapper's own Log() lines are UTF-8, but it appends the pm2 and
# staleness-guard subprocess streams with `*>> $log`, and in the LOCAL_SYSTEM boot
# context those arrive UTF-16LE. Read back as single bytes, a UTF-16LE CRLF
# (0D 00 0A 00) ends the line on the 0A and leaves the trailing 00 as the FIRST
# CHARACTER of the next line — so every wrapper line written immediately after a
# captured subprocess carries a leading U+0000, and an ^-anchored match drops it.
#
# Measured 2026-10-02 against the live log: exactly the two entries that follow a
# subprocess — `pm2 resurrect exit code` and `TRA-4851 staleness guard` — were
# invisible, 0 of 4 parsed, across BOTH the 09-28 and 10-01 boots. The guard line
# is the only witness that TRA-4851's refuse-path ran, so this gate printed "that
# fire booted UNGUARDED against a stale checkout" about a boot whose guard had in
# fact run and logged FRESH. A DETECTOR defect, not a finding — and it pointed at
# the opposite remedy (re-stage the wrapper) from the real one (fix this parser).
#
# Do NOT drop the ^ anchor to fix it: the anchor is what stops a timestamp
# embedded mid-line in pm2's output from being read as a wrapper entry. Strip the
# control noise, then match anchored.
function Get-BootLogEntries([string]$Path) {
  @(Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue |
    ForEach-Object { ($_ -replace "[`0`r`n]", '').Trim() } |
    Select-String -Pattern '^(\d{4}-\d{2}-\d{2}T[\d:.]+[+-]\d{2}:\d{2})\s+(.*)$' |
    ForEach-Object {
      # NB: [ref] needs a TYPED target - seeding $ts with $null makes 5.1 fail
      # overload resolution ("Cannot find an overload ... argument count: 2").
      [datetime]$ts = [datetime]::MinValue
      if ([datetime]::TryParse($_.Matches[0].Groups[1].Value, [ref]$ts)) {
        [pscustomobject]@{ When = $ts; Text = $_.Matches[0].Groups[2].Value.Trim() }
      }
    })
}

if ($SelfTest) {
  # Rebuild the live log's byte shape: UTF-8 wrapper lines interleaved with
  # UTF-16LE subprocess blobs, no BOM. Two of the four wrapper entries land
  # directly after a blob and so carry the orphan NUL.
  $fx = Join-Path ([System.IO.Path]::GetTempPath()) "tra4853-bootlog-fixture-$PID.log"
  $parts = @(
    @{ enc='utf8';  text="2026-10-01T11:13:21.7260701-04:00  boot resurrect starting (PM2_HOME=C:\Users\eetienne\.pm2)`r`n" },
    @{ enc='utf16'; text="[PM2] Spawning PM2 daemon`r`n[PM2] Resurrecting`r`n" },
    @{ enc='utf8';  text="2026-10-01T11:13:37.3075908-04:00  pm2 resurrect exit code = 0`r`n" },
    @{ enc='utf8';  text="2026-10-01T11:18:28.6062752-04:00  health after resurrect: OK 200`r`n" },
    @{ enc='utf16'; text="[boot-staleness] verdict: FRESH (exit 0)`r`n" },
    @{ enc='utf8';  text="2026-10-01T11:18:29.8846699-04:00  TRA-4851 staleness guard: FRESH (exit 0)`r`n" }
  )
  $fs = [System.IO.File]::Create($fx)
  try {
    foreach ($p in $parts) {
      $b = if ($p.enc -eq 'utf16') { [System.Text.Encoding]::Unicode.GetBytes($p.text) }
           else                    { [System.Text.Encoding]::UTF8.GetBytes($p.text) }
      $fs.Write($b, 0, $b.Length)
    }
  } finally { $fs.Dispose() }

  Write-Output "TRA-4853 boot-log parser selftest"
  Write-Output "  fixture: $fx"
  $errs = @()

  # NEGATIVE CONTROL first. If the fixture does not reproduce the defect, the
  # positive assert below is vacuous — it would pass against the old parser too.
  $old = @(Get-Content -LiteralPath $fx -ErrorAction SilentlyContinue |
    Select-String -Pattern '^(\d{4}-\d{2}-\d{2}T[\d:.]+[+-]\d{2}:\d{2})\s+(.*)$')
  Write-Output "  ARM 0 (old ^-anchored parser, no NUL strip): parsed $($old.Count) of 4 wrapper lines"
  if ($old.Count -ne 2) {
    $errs += "ARM 0: fixture does not reproduce the defect (expected the old parser to parse exactly 2 of 4, got $($old.Count)) - the ARM 1 assert below would be VACUOUS."
  }
  if (@($old | Where-Object { $_.Line -match 'TRA-4851 staleness guard' }).Count -ne 0) {
    $errs += "ARM 0: the old parser found the guard line, so the fixture is not the live shape."
  }

  # ARM 1: the shipped parser must recover all four, including the NUL-prefixed.
  $new = Get-BootLogEntries $fx
  Write-Output "  ARM 1 (shipped parser):                      parsed $($new.Count) of 4 wrapper lines"
  foreach ($need in @('boot resurrect starting', 'pm2 resurrect exit code = 0',
                      'health after resurrect: OK 200', 'TRA-4851 staleness guard: FRESH')) {
    if (@($new | Where-Object { $_.Text -match [regex]::Escape($need) }).Count -eq 0) {
      $errs += "ARM 1: shipped parser LOST '$need'."
    }
  }
  # And it must still refuse the untimestamped subprocess noise.
  if (@($new | Where-Object { $_.Text -match 'Resurrecting|boot-staleness' }).Count -ne 0) {
    $errs += "ARM 1: shipped parser admitted a subprocess line as a wrapper entry - the ^ anchor is no longer load-bearing."
  }

  Remove-Item -LiteralPath $fx -Force -ErrorAction SilentlyContinue
  Write-Output ""
  if ($errs.Count -gt 0) {
    $errs | ForEach-Object { Write-Output "  FAIL: $_" }
    Write-Output "SELFTEST: FAIL"
    exit 1
  }
  Write-Output "SELFTEST: PASS (defect reproduced by ARM 0, repaired by ARM 1)"
  exit 0
}

Write-Output "TRA-605 PM2 autostart verification - $((Get-Date).ToUniversalTime().ToString('u'))"
Write-Output ""

# ---- C1: task registered -----------------------------------------------------
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  # TRA-4851: Get-ScheduledTask silently FILTERS tasks this session lacks read
  # access to, so "absent" and "registered but unreadable" looked identical —
  # the verifier reported FAIL(absent) against a task that ran at the last boot.
  # schtasks by exact name discriminates: a missing task says "cannot find the
  # file specified"; an unreadable one says "Access is denied".
  $probe = & schtasks /query /tn $taskName 2>&1 | Out-String
  if ($probe -match 'Access is denied') {
    Write-Output "C1 task registered      : PASS-UNREADABLE (task exists but this session cannot read it; its -File target is UNVERIFIABLE without elevation)"
    Write-Output "   WARN: C2 cannot run. Re-run this verifier from an ELEVATED PowerShell to check what the task actually points at."
    # TRA-4853: this is the load-bearing unknown, so it must reach the verdict.
    # Every non-elevated read of the -File target is denied - schtasks, the
    # Schedule.Service COM API, HKLM\...\Schedule\TaskCache and
    # C:\Windows\System32\Tasks all return access-denied, and Get-ScheduledTask
    # filters the task out entirely. C2S below is the non-elevated substitute:
    # it cannot say what the task points AT, but it can say whether the path the
    # installer promises to point it at is intact.
    # …and C4 is the THIRD way in: if the last boot's fire logged a TRA-4853
    # identity line, the -File is no longer unknown and this must stop reporting it
    # as such (measured 2026-10-02 — the 10-01 boot named it). So defer: record
    # that C1/C2 could not read it, and let the C4 resolution below decide whether
    # that is still a load-bearing unknown.
    $c1Unreadable = $true
  } else {
    $fail += "C1 task '$taskName' is NOT registered. Fix: run ops/install-pm2-autostart.ps1 from an ELEVATED PowerShell."
    Write-Output "C1 task registered      : FAIL (absent)"
  }
} else {
  Write-Output "C1 task registered      : PASS (state=$($task.State), user=$($task.Principal.UserId))"
  if ($task.State -eq 'Disabled') { $fail += "C1 task is registered but DISABLED - it will not run at boot." }

  # ---- C2: the boot -File must resolve ---------------------------------------
  # NB: not $args - that is a PowerShell automatic variable.
  $taskArgs = ($task.Actions | Select-Object -First 1).Arguments
  $bootFile = if ($taskArgs -match '-File\s+"([^"]+)"') { $Matches[1] } elseif ($taskArgs -match '-File\s+(\S+)') { $Matches[1] } else { $null }
  if (-not $bootFile) {
    $fail += "C2 could not parse a -File path out of the task action: $taskArgs"
    Write-Output "C2 boot script resolves : FAIL (unparseable)"
  } elseif (-not (Test-Path $bootFile)) {
    $fail += "C2 task points at '$bootFile' which DOES NOT EXIST - it will fail silently at boot. Re-run ops/install-pm2-autostart.ps1 elevated to re-stage it."
    Write-Output "C2 boot script resolves : FAIL (dangling -> $bootFile)"
  } else {
    Write-Output "C2 boot script resolves : PASS ($bootFile)"
    if ($bootFile -notlike 'C:\ProgramData\*') {
      Write-Output "   WARN: boot script lives outside C:\ProgramData - if that path is a repo checkout it can be wiped. Re-run the installer to re-stage."
    }
  }
}

# ---- C2S: the promised staged wrapper (NO elevation needed) — TRA-4853 -------
# C2 can only grade the path the task actually holds, which is unreadable without
# admin. But install-pm2-autostart.ps1 promises a specific stable path and points
# the task there, so that path is independently checkable — and on 2026-09-25 it
# was an EMPTY DIRECTORY while this script still verdicted PASS. If the task does
# point here (what the installer guarantees), a missing wrapper is silent at boot:
# the TRA-605 regression, and nothing else in this gate could see it.
if (-not (Test-Path $stableWrap)) {
  $hint = if (Test-Path $stableDir) { "the directory exists but holds no wrapper" } else { "the directory does not exist either" }
  $fail += "C2S the promised staged wrapper is MISSING at $stableWrap ($hint). If the task points here - which is what ops/install-pm2-autostart.ps1 guarantees - the next boot runs a dangling -File and resurrects NOTHING, silently. Fix: copy ops/pm2-resurrect-boot.ps1 there (no elevation needed to write the file), or re-run the installer ELEVATED to re-stage AND re-register."
  Write-Output "C2S staged wrapper      : FAIL (absent -> $stableWrap)"
} else {
  $stagedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stableWrap).Hash
  $repoHash   = if (Test-Path $repoWrap) { (Get-FileHash -Algorithm SHA256 -LiteralPath $repoWrap).Hash } else { $null }
  $stagedText = Get-Content -LiteralPath $stableWrap -Raw

  # The guard is the whole point of TRA-4851. A staged copy predating it boots
  # UNGUARDED, which reads exactly like a guarded boot in every other surface.
  if ($stagedText -notmatch 'check-boot-staleness\.mjs') {
    $fail += "C2S the staged wrapper at $stableWrap does NOT carry the TRA-4851 staleness guard - a boot running it re-serves a stale checkout silently. Re-stage it from ops/pm2-resurrect-boot.ps1."
    Write-Output "C2S staged wrapper      : FAIL (present but UNGUARDED - no TRA-4851 staleness guard)"
  } elseif (-not $repoHash) {
    Write-Output "C2S staged wrapper      : PASS-PARTIAL (present and guarded; could not compare against $repoWrap)"
  } elseif ($stagedHash -eq $repoHash) {
    Write-Output "C2S staged wrapper      : PASS (present, guarded, byte-identical to ops/pm2-resurrect-boot.ps1)"
  } else {
    # Drift is not automatically a defect - the repo copy may simply have moved
    # on. It IS a reason not to claim the committed wrapper is what boots.
    $unverified += "C2S the staged wrapper at $stableWrap is guarded but DIFFERS from this checkout's ops/pm2-resurrect-boot.ps1 (staged $($stagedHash.Substring(0,12)) vs repo $($repoHash.Substring(0,12))). The bytes that boot are not the bytes committed here. Re-stage if the repo copy is newer."
    Write-Output "C2S staged wrapper      : DRIFT (guarded, but not the same bytes as this checkout's copy)"
  }

  if ($stagedText -notmatch 'TRA-4853 wrapper identity') {
    $unverified += "C2S the staged wrapper predates the TRA-4853 self-identification block, so the next boot will NOT record which -File ran. Re-stage from ops/pm2-resurrect-boot.ps1 to make the boot name its own path."
    Write-Output "   WARN: staged copy has no TRA-4853 identity block - the next boot will not self-identify."
  } else {
    Write-Output "   staged copy self-identifies at boot (TRA-4853) -> next boot records its own -File in resurrect-boot.log."
  }
}

# ---- C3: something to resurrect ----------------------------------------------
$dump = Join-Path $pm2Home 'dump.pm2'
if (Test-Path $dump) {
  $age = [math]::Round(((Get-Date) - (Get-Item $dump).LastWriteTime).TotalDays, 1)
  Write-Output "C3 saved dump.pm2       : PASS (last 'pm2 save' was $age days ago)"
} else {
  $fail += "C3 no dump.pm2 at $dump - 'pm2 resurrect' would restore NOTHING. Fix: start the processes, then run 'pm2 save'."
  Write-Output "C3 saved dump.pm2       : FAIL (absent)"
}

# ---- C4: boot evidence -------------------------------------------------------
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
Write-Output "C4 last boot            : $($boot.ToUniversalTime().ToString('u')) ($([math]::Round(((Get-Date) - $boot).TotalHours,1))h ago)"

# TRA-4853: the boot log is the DIRECT witness to whether the wrapper ran, and
# this check used to ignore it in favour of two bad inferences:
#   (a) it judged autostart by the CURRENT :4242 listener's process age, which any
#       later legitimate `pm2 restart` invalidates. On 2026-09-25 that printed
#       "came up 1491 min AFTER boot -> it did NOT autostart" when the wrapper had
#       in fact run and passed its health gate 2 min after boot - the 1491 min pid
#       was the TRA-4849 remediation restart. A rebuild+restart is normal
#       operation; it must not read as an autostart failure.
#   (b) it recorded that finding only `if ($task)` - i.e. never, in the normal
#       non-elevated case - so the one direction that WAS a real alarm could not
#       reach the verdict either.
# Grade the wrapper's own log, and keep the listener age as context only.
if (-not (Test-Path $bootLog)) {
  $unverified += "C4 no boot log at $bootLog, so whether the wrapper ran at the last boot is UNKNOWN."
  Write-Output "   boot log              : ABSENT ($bootLog) - cannot tell whether the wrapper ran."
} else {
  # The log interleaves the wrapper's own UTF-8 Log() lines with raw pm2 stdout
  # (ANSI + wide chars), so match the timestamped Log() lines and ignore the rest.
  $entries = Get-BootLogEntries $bootLog

  $starts = @($entries | Where-Object { $_.Text -match 'boot resurrect starting' })
  # A fire belongs to THIS boot if it began within 10 min of it. The task is
  # AtStartup, so a genuine boot fire is seconds away, not hours.
  $thisBoot = @($starts | Where-Object { [math]::Abs((($_.When) - $boot).TotalMinutes) -le 10 })

  if ($thisBoot.Count -gt 0) {
    $t0 = ($thisBoot | Select-Object -Last 1).When
    Write-Output "   boot log              : the wrapper RAN at this boot ($([math]::Round((($t0) - $boot).TotalMinutes,1)) min after boot) -> autostart fired."
    # Everything this fire logged, up to the next fire. That upper bound is
    # load-bearing and used to be missing: with only `-ge $t0`, a LATER hand-run of
    # the wrapper donated its identity and guard lines to this boot's block, so
    # running the staged copy by hand could manufacture a staged-path PASS for a
    # boot that actually ran something else (TRA-4853, 2026-10-02).
    $nextStart = @($starts | Where-Object { $_.When -gt $t0 } | Select-Object -First 1)
    $after = if ($nextStart.Count -gt 0) {
      @($entries | Where-Object { $_.When -ge $t0 -and $_.When -lt $nextStart[0].When })
    } else {
      @($entries | Where-Object { $_.When -ge $t0 })
    }
    $ident = @($after | Where-Object { $_.Text -match 'TRA-4853 wrapper identity: -File=(.*)$' })
    if ($ident.Count -gt 0) {
      $ranFile = ([regex]'-File=(.*)$').Match($ident[0].Text).Groups[1].Value.Trim()
      $bootLogFile = $ranFile
      Write-Output "   boot -File (TRA-4853) : $ranFile"
      if ($ranFile -eq $stableWrap) {
        Write-Output "     -> that IS the stable staged path. The TRA-605 dangling-path risk is closed for this task."
      } else {
        # Name the risk PRECISELY. This used to read "if that path is a per-agent
        # checkout it can be reset or wiped" - but a per-agent ephemeral checkout
        # and the SHARED project checkout are very different severities, and the
        # boot log now tells us which. Paperclip allocates one checkout per project
        # (PAPERCLIP_WORKSPACE_STRATEGY=project_primary, CLAUDE.md), so the shared
        # `_default` tree is durable and is the same tree the dump already serves;
        # the live exposure there is a `git reset --hard`/branch switch to a commit
        # predating the wrapper, not a wipe. An agent-scoped path is the wipe case.
        $kind = if ($ranFile -like '*\_default\*') {
          "it is the SHARED project checkout - durable, and the same tree the dump already serves, so the exposure is a reset/branch-switch to a commit predating the wrapper rather than a wipe"
        } else {
          "it is OUTSIDE the shared _default checkout, so it may be a per-agent ephemeral tree that can be WIPED - the TRA-605 dangling-path shape, which cost 16.7h of downtime"
        }
        $fail += "C4 the boot task's -File is '$ranFile', NOT the stable staged path '$stableWrap': $kind. Either way a working tree is not a deployment target and a dangling -File is SILENT at boot. Fix: run ops/install-pm2-autostart.ps1 ELEVATED to re-point the task at the staged copy."
        Write-Output "     -> NOT the stable staged path - see FAIL below."
      }
    } else {
      $unverified += "C4 this boot's fire logged no TRA-4853 identity line, so the wrapper copy it ran is UNKNOWN (that boot predates the self-identification block, or ran a wrapper copy that does not carry it). The next boot after re-staging will record it."
      Write-Output "   boot -File (TRA-4853) : NOT RECORDED (fire predates the identity block) - which copy ran is unknown."
    }
    $guardLines = @($after | Where-Object { $_.Text -match 'TRA-4851' })
    if ($guardLines.Count -gt 0) {
      Write-Output "   TRA-4851 guard at boot: $($guardLines[0].Text)"
    } else {
      # This is a real alarm, so it has to REACH THE VERDICT. Until 2026-10-02 it
      # was printed and dropped on the floor - the same swallowed-finding shape
      # this script's own header describes fixing for C1/C2.
      $fail += "C4 this boot's fire logged NO TRA-4851 staleness verdict, so the boot cannot be shown to have been guarded against re-serving a stale build: either it ran a wrapper copy predating the guard, or scripts/check-boot-staleness.mjs is missing from the served checkout. Fix: re-stage ops/pm2-resurrect-boot.ps1 and confirm the guard script exists in the checkout the dump points at."
      Write-Output "   TRA-4851 guard at boot: NO staleness verdict logged -> cannot show this boot was guarded (see FAIL below)."
    }
  } else {
    $lastStart = if ($starts.Count -gt 0) { ($starts | Select-Object -Last 1).When.ToUniversalTime().ToString('u') } else { 'never' }
    $fail += "C4 the wrapper did NOT run at the last boot ($($boot.ToUniversalTime().ToString('u'))) - no 'boot resurrect starting' entry within 10 min of it in $bootLog (last fire: $lastStart). Either the task did not fire or its -File is dangling; both are silent at boot. Fix: run ops/install-pm2-autostart.ps1 ELEVATED, then ops/verify-pm2-autostart.ps1."
    Write-Output "   boot log              : NO fire at the last boot (last: $lastStart) -> autostart did NOT run."
  }
}

# ---- C1/C2 resolution (TRA-4853) ---------------------------------------------
# The task being unreadable non-elevated is only a load-bearing unknown while
# nothing ELSE can name the -File. The boot itself can, and does. So grade the
# unknown against the boot log rather than asserting it unconditionally - the
# version of this that always claimed "what it runs at boot is UNKNOWN" was
# printing that line directly underneath C4 printing the answer.
# It is still not a statement about NOW: the task could have been re-registered
# since that boot, so what is known is "the -File as of the last boot", dated.
if ($c1Unreadable -and -not $bootLogFile) {
  $unverified += "C1/C2 the task exists but is UNREADABLE non-elevated, and the last boot logged no TRA-4853 identity line, so what it runs at boot is UNKNOWN. C2S grades the promised staged path instead. To close this: run ops/verify-pm2-autostart.ps1 from an ELEVATED PowerShell, or read the 'wrapper identity' line in $bootLog after the next boot."
}

$listener = Get-NetTCPConnection -LocalPort 4242 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($proc) {
    $mins = [math]::Round(($proc.CreationDate - $boot).TotalMinutes)
    # Context only - a later rebuild/restart makes this large and says nothing
    # about autostart. The boot-log check above is the verdict-bearing one.
    Write-Output "   :4242 listener age    : started $mins min after boot (pid $($listener.OwningProcess)); >10 min just means it was restarted since - see the boot log above for the autostart verdict."
  }
} else {
  Write-Output "   nothing listening on :4242 - trading-server is DOWN right now."
}

try {
  $r = Invoke-WebRequest -UseBasicParsing $health -TimeoutSec 5
  Write-Output "   health :4242          : $($r.StatusCode)"
} catch {
  Write-Output "   health :4242          : UNREACHABLE"
}

# ---- C5: staleness of the checkout a boot would re-serve (TRA-4851) ----------
# The dump points trading-server at a shared checkout; `pm2 resurrect` re-binds
# :4242 to whatever HEAD that checkout holds. On 2026-09-24 that HEAD was 42
# days / ~600 commits stale for at least 3 boots and read like quiet health
# (TRA-4849). Grade the checkout the dump ACTUALLY names, not the one this
# script happens to live in.
# NB: parsed with node, not ConvertFrom-Json — the dump's saved env carries
# case-duplicate keys (`username`/`USERNAME`) that PowerShell 5.1's JSON
# parser refuses outright.
$servedRepo = $null
if (Test-Path $dump) {
  try {
    $servedRepo = & node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const e=d.find(p=>p.name==='trading-server');process.stdout.write(e&&e.pm_cwd?e.pm_cwd:'')" $dump 2>$null
    if (-not $servedRepo) { $servedRepo = $null }
  } catch { }
}
$guardScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\check-boot-staleness.mjs'
if (-not $servedRepo) {
  Write-Output "C5 checkout staleness   : SKIP (could not read trading-server's pm_cwd out of dump.pm2)"
} elseif (-not (Test-Path $guardScript)) {
  $fail += "C5 staleness guard script missing at $guardScript - a boot would be unguarded."
  Write-Output "C5 checkout staleness   : FAIL (guard script missing)"
} else {
  & node $guardScript "--repo=$servedRepo" --fetch-attempts=1 | ForEach-Object { Write-Output "   $_" }
  switch ($LASTEXITCODE) {
    0 { Write-Output "C5 checkout staleness   : PASS (FRESH - a reboot now would re-serve a current build)" }
    1 { $fail += "C5 the checkout at $servedRepo is CONFIRMED STALE - the next reboot re-serves it (the TRA-4849 incident). Remedy: git pull + rebuild + pm2 restart + pm2 save."
        Write-Output "C5 checkout staleness   : FAIL (STALE_CONFIRMED)" }
    2 { Write-Output "C5 checkout staleness   : WARN (HEAD over age threshold, origin unreachable - could not confirm)" }
    default { Write-Output "C5 checkout staleness   : WARN (guard exit $LASTEXITCODE - could not grade)" }
  }
}

if ($c1Unreadable -and $bootLogFile) {
  Write-Output ""
  Write-Output "C1/C2 resolved via boot log: the task's -File as of the last boot was"
  Write-Output "   $bootLogFile"
  Write-Output "   (recovered with NO elevation, from the TRA-4853 identity line. It is a fact about"
  Write-Output "    that boot, not about now - a re-registration since would not show here.)"
}

# ---- verdict -----------------------------------------------------------------
Write-Output ""
# TRA-4853: precedence FAIL > UNVERIFIED > PASS. A PASS here is a claim that an
# unattended reboot WILL restore trading-server, so it may only be issued when
# every load-bearing fact was actually read. "Could not check" gets its own exit
# code (2) so no caller can mistake it for a clean run.
if ($fail.Count -gt 0) {
  Write-Output "VERDICT: FAIL"
  $fail | ForEach-Object { Write-Output "  - $_" }
  if ($unverified.Count -gt 0) {
    Write-Output "  also UNVERIFIED:"
    $unverified | ForEach-Object { Write-Output "  ? $_" }
  }
  exit 1
}
if ($unverified.Count -gt 0) {
  Write-Output "VERDICT: UNVERIFIED - nothing FAILED, but this run could not read a fact the PASS claim depends on."
  $unverified | ForEach-Object { Write-Output "  ? $_" }
  exit 2
}
Write-Output "VERDICT: PASS - PM2 autostart is armed; an unattended reboot will restore trading-server."
exit 0
