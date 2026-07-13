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
#   C4 boot evidence: if the host HAS rebooted since, did trading-server come
#      back near boot, or hours later (i.e. by a human)?
#
# Exit 0 = PASS (autostart is armed) · 1 = FAIL (reasons printed).
# ─────────────────────────────────────────────────────────────────────────────
$taskName = 'PM2 Resurrect'
$pm2Home  = 'C:\Users\eetienne\.pm2'
$health   = 'http://localhost:4242/api/health'
$fail     = @()

Write-Output "TRA-605 PM2 autostart verification - $((Get-Date).ToUniversalTime().ToString('u'))"
Write-Output ""

# ---- C1: task registered -----------------------------------------------------
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  $fail += "C1 task '$taskName' is NOT registered. Fix: run ops/install-pm2-autostart.ps1 from an ELEVATED PowerShell."
  Write-Output "C1 task registered      : FAIL (absent)"
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

$listener = Get-NetTCPConnection -LocalPort 4242 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($proc) {
    $mins = [math]::Round(($proc.CreationDate - $boot).TotalMinutes)
    if ($mins -le 10) {
      Write-Output "   trading-server came up $mins min after boot -> consistent with autostart."
    } else {
      Write-Output "   trading-server came up $mins min AFTER boot -> it did NOT autostart; something/someone else started it."
      if ($task) { $fail += "C4 server started $mins min after boot despite the task being registered - check $pm2Home\resurrect-boot.log." }
    }
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

# ---- verdict -----------------------------------------------------------------
Write-Output ""
if ($fail.Count -eq 0) {
  Write-Output "VERDICT: PASS - PM2 autostart is armed; an unattended reboot will restore trading-server."
  exit 0
}
Write-Output "VERDICT: FAIL"
$fail | ForEach-Object { Write-Output "  - $_" }
exit 1
