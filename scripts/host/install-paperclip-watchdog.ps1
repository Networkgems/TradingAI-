<#
  install-paperclip-watchdog.ps1  --  TRA-5156

  Installs (or verifies) the Paperclip-Watchdog scheduled task: a PT5M run of
  paperclip-watchdog.cjs. DETECT-AND-REPORT by default; the kill is armed only by
  creating %USERPROFILE%\.paperclip\autostart\watchdog.arm (see the .cjs header).

  Control-plane scope only (CEO condition 1, TRA-5156): the action touches nothing
  but 127.0.0.1:3100 and the Paperclip server's own process chain.

  Same principal limits as Paperclip-Autostart (TRA-5105): InteractiveToken, so it
  runs only while this user is logged on. If the Autostart task is flipped to a
  Password principal, flip this one the same way.

  No EndBoundary anywhere (the TRA1648-Watchdog death mode); -Verify asserts it.
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Paperclip-Watchdog',
  [int]$EveryMinutes = 5,
  [switch]$Verify
)
$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $env:USERPROFILE '.paperclip\autostart'
$Installed  = Join-Path $InstallDir 'paperclip-watchdog.cjs'
$Source     = Join-Path $PSScriptRoot 'paperclip-watchdog.cjs'
$NodeExe    = Join-Path $env:ProgramFiles 'nodejs\node.exe'
function Fail { param([string]$m) Write-Output "FAIL: $m"; exit 1 }
function Ok   { param([string]$m) Write-Output "ok   : $m" }

if ($Verify) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { Fail "scheduled task '$TaskName' is not registered" }
  if ($t.State -eq 'Disabled') { Fail 'task is Disabled' }
  Ok "registered; State=$($t.State)"
  [xml]$xml = Export-ScheduledTask -TaskName $TaskName
  if ($xml.SelectNodes('//*[local-name()="EndBoundary"]').Count -gt 0) { Fail 'EndBoundary present' }
  Ok 'no EndBoundary'
  if (-not (Test-Path $Installed)) { Fail "watchdog missing at $Installed" }
  Ok "watchdog present at $Installed"
  $rep = $xml.SelectNodes('//*[local-name()="Repetition"]/*[local-name()="Interval"]')
  if ($rep.Count -lt 1) { Fail 'no repetition interval' }
  Ok "repetition: $(($rep | ForEach-Object { $_.'#text' }) -join ', ')"
  $armed = Test-Path (Join-Path $InstallDir 'watchdog.arm')
  Ok "kill armed: $armed (detect-and-report unless watchdog.arm exists)"
  Write-Output 'VERIFY: PASS (definition only -- liveness is watchdog-state.json checkedAt advancing)'
  exit 0
}

if (-not (Test-Path $Source)) { Fail "source not found at $Source" }
if (-not (Test-Path $NodeExe)) { Fail "node not found at $NodeExe" }
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path $Source -Destination $Installed -Force   # out of the shared checkout on purpose
Write-Output "installed watchdog -> $Installed"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"& '$NodeExe' '$Installed'`""
$userId = "$env:USERDOMAIN\$env:USERNAME"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $userId
$logon.Repetition = $trigger.Repetition
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $trigger) -Settings $settings -Principal $principal `
  -Description 'TRA-5156: Paperclip control-plane liveness watchdog (detect-and-report; kill gated by watchdog.arm). Do NOT add an EndBoundary.' -Force | Out-Null
Write-Output "registered scheduled task '$TaskName'"
& $PSCommandPath -TaskName $TaskName -Verify
