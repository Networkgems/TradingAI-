<#
  install-paperclip-autostart.ps1  --  TRA-5054

  Installs (or verifies) the Paperclip-Autostart scheduled task on this host.

  WHY A SCHEDULED TASK AND NOT A SERVICE
    `paperclipai service install` is the obvious remedy and it does not exist on
    this platform:
        > paperclipai service status --json
        {"supported": false, "message": "Service management is not supported on win32. ..."}
    Measured 2026-10-02 on PG-DEVOPS14. So Task Scheduler is the only supervisor
    surface available.

  WHY AtLogon AND NOT AtStartup
    TRA-5054 asks for AtStartup "run whether or not the user is logged on". That
    requires an S4U (or password-backed) principal, and registering one requires
    administrator rights. Measured on this host as the operating account
    (primeroga\eetienne, IsAdmin: False):
        Register-ScheduledTask -Principal (... -LogonType S4U) -> "Access is denied."
    An AtStartup trigger under an InteractiveToken principal registers happily
    and then never runs, because there is no interactive token at boot -- that is
    a task that reads Ready forever while doing nothing, which is precisely the
    TRA1648-Watchdog failure this ticket cites. We therefore use AtLogon, which
    the ticket names as the sanctioned fallback and which recovers all five
    window-B boots (each was followed by an interactive logon).

  NO EndBoundary IS SET ANYWHERE. TRA1648-Watchdog died silently because its only
  trigger carried EndBoundary 2026-07-13T17:05:00 and has read "Ready" ever since.
  -Verify asserts the absence.
#>
[CmdletBinding()]
param(
  [string]$TaskName         = 'Paperclip-Autostart',
  [int]$Port                = 3100,
  [int]$SuperviseMinutes    = 5,
  [switch]$Verify
)

$ErrorActionPreference = 'Stop'

$InstallDir    = Join-Path $env:USERPROFILE '.paperclip\autostart'
$InstalledPs1  = Join-Path $InstallDir 'paperclip-autostart.ps1'
$SourcePs1     = Join-Path $PSScriptRoot 'paperclip-autostart.ps1'

function Fail { param([string]$m) Write-Output "FAIL: $m"; exit 1 }
function Ok   { param([string]$m) Write-Output "ok   : $m" }

# ---------------------------------------------------------------- verify mode
if ($Verify) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { Fail "scheduled task '$TaskName' is not registered" }
  Ok "task '$TaskName' registered; State=$($t.State)"
  if ($t.State -eq 'Disabled') { Fail "task is Disabled" }

  [xml]$xml = Export-ScheduledTask -TaskName $TaskName

  $ends = $xml.SelectNodes('//*[local-name()="EndBoundary"]')
  if ($ends.Count -gt 0) { Fail "task carries $($ends.Count) EndBoundary element(s) -- the TRA1648-Watchdog failure mode" }
  Ok "no EndBoundary anywhere (TRA1648-Watchdog regression guard)"

  $etl = $xml.Task.Settings.ExecutionTimeLimit
  if ($etl -ne 'PT0S') { Fail "ExecutionTimeLimit=$etl -- must be PT0S (unlimited); the action lives as long as the server" }
  Ok "ExecutionTimeLimit=PT0S (unlimited)"

  $mip = $xml.Task.Settings.MultipleInstancesPolicy
  if ($mip -ne 'IgnoreNew') { Fail "MultipleInstancesPolicy=$mip -- must be IgnoreNew to stop the repetition spawning duplicate servers" }
  Ok "MultipleInstancesPolicy=IgnoreNew"

  if ($xml.Task.Settings.StartWhenAvailable -ne 'true') { Fail "StartWhenAvailable must be true so a missed trigger still runs" }
  Ok "StartWhenAvailable=true"

  if ($xml.Task.Settings.IdleSettings.StopOnIdleEnd -eq 'true') { Fail "StopOnIdleEnd=true would kill the server when the host leaves idle" }
  Ok "StopOnIdleEnd=false"

  $reps = $xml.SelectNodes('//*[local-name()="Repetition"]/*[local-name()="Interval"]')
  if ($reps.Count -lt 1) { Fail "no Repetition/Interval -- the task would not supervise a crashed server" }
  Ok "repetition interval(s): $(($reps | ForEach-Object { $_.'#text' }) -join ', ')"

  $logon = $xml.SelectNodes('//*[local-name()="LogonTrigger"]')
  Ok "LogonTrigger count: $($logon.Count)"

  $rc = $xml.Task.Settings.RestartOnFailure
  if ($rc) { Ok "RestartOnFailure: count=$($rc.Count) interval=$($rc.Interval)" } else { Ok "RestartOnFailure: (none)" }

  $cmd = $xml.Task.Actions.Exec.Command
  $arg = $xml.Task.Actions.Exec.Arguments
  Ok "action: $cmd $arg"
  if ($arg -notmatch [regex]::Escape($InstalledPs1)) { Fail "action does not point at $InstalledPs1" }
  if (-not (Test-Path $InstalledPs1)) { Fail "launcher missing at $InstalledPs1" }
  Ok "launcher present at $InstalledPs1"

  Write-Output ''
  Write-Output 'VERIFY: PASS (definition only -- liveness is proved by Start-ScheduledTask + a new :3100 pid + a new heartbeat_runs row)'
  exit 0
}

# --------------------------------------------------------------- install mode
if (-not (Test-Path $SourcePs1)) { Fail "source launcher not found at $SourcePs1" }
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null }

# Copy out of the git checkout on purpose: this checkout is shared by concurrent
# runs (CLAUDE.md "Concurrent runs share this checkout"), so a task pointing into
# a live worktree could execute a half-written file mid-checkout.
Copy-Item -Path $SourcePs1 -Destination $InstalledPs1 -Force
Write-Output "installed launcher -> $InstalledPs1"

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstalledPs1`" -Port $Port"

$userId = "$env:USERDOMAIN\$env:USERNAME"

# Trigger 1: recover the boot. Fires at this user's interactive logon.
$tLogon = New-ScheduledTaskTrigger -AtLogOn -User $userId

# Trigger 2: supervise. A past-dated one-shot with an indefinite repetition, so a
# server that dies mid-session is restarted within $SuperviseMinutes, and so the
# supervisor is armed even in a session where the logon trigger already fired.
$tSuper = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
            -RepetitionInterval (New-TimeSpan -Minutes $SuperviseMinutes)

# Give the logon trigger the same repetition so supervision survives a logon-only path.
$tLogon.Repetition = $tSuper.Repetition

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$settings.IdleSettings.StopOnIdleEnd = $false
$settings.IdleSettings.RestartOnIdle = $false

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
  -Action $action -Trigger @($tLogon, $tSuper) -Settings $settings -Principal $principal `
  -Description 'TRA-5054: restore Paperclip scheduling after boot/logon and supervise a crashed server. Action is idempotent (no-op when 127.0.0.1:3100 is already listening). Do NOT add an EndBoundary.' `
  -Force | Out-Null

Write-Output "registered scheduled task '$TaskName'"
Write-Output ''
& $PSCommandPath -TaskName $TaskName -Port $Port -Verify
