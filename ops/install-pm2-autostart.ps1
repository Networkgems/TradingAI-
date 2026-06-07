# ─────────────────────────────────────────────────────────────────────────────
# install-pm2-autostart.ps1 — TRA-605 / TRA-493 Part A (Option B, the plan's
# pre-approved fallback).
#
# Registers the "PM2 Resurrect" scheduled task that runs ops/pm2-resurrect-boot.ps1
# at machine start as LOCAL_SYSTEM, so the PM2 daemon + trading-server come back
# up after an unattended reboot of PG-DEVOPS14 with no human running the
# bootstrap script.
#
# Why a scheduled task and not `pm2-installer`:
#   - `pm2-installer` is NOT a published npm package (`npm view pm2-installer`
#     -> 404). The real tool is the GitHub project jessety/pm2-installer, whose
#     `npm run configure` relocates the MACHINE-WIDE npm global prefix + cache to
#     ProgramData. PG-DEVOPS14 launches the Paperclip control plane via
#     `npx paperclipai`, so relocating the global prefix risks breaking the
#     control-plane runtime company-wide. The TRA-493 plan pre-approved a
#     scripted scheduled task as the Part A fallback for exactly this situation.
#
# Run ELEVATED (admin). Idempotent: re-running re-registers the task.
# Uninstall:  Unregister-ScheduledTask -TaskName 'PM2 Resurrect' -Confirm:$false
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'

$taskName = 'PM2 Resurrect'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$wrapper   = Join-Path $scriptDir 'pm2-resurrect-boot.ps1'
if (-not (Test-Path $wrapper)) { throw "wrapper not found: $wrapper" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""

$trigger = New-ScheduledTaskTrigger -AtStartup

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' `
  -LogonType ServiceAccount -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'TRA-605: resurrect PM2 daemon + trading-server at machine start (unattended-reboot recovery).' `
  -Force | Out-Null

Write-Output "Registered scheduled task '$taskName' (AtStartup, SYSTEM, highest)."
Get-ScheduledTask -TaskName $taskName | Format-List TaskName, State
