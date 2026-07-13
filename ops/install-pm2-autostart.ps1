# ─────────────────────────────────────────────────────────────────────────────
# install-pm2-autostart.ps1 — TRA-605 / TRA-493 Part A (Option B, the plan's
# pre-approved fallback).
#
# Registers the "PM2 Resurrect" scheduled task that runs pm2-resurrect-boot.ps1
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
# Verify afterwards (no admin needed):  ops/verify-pm2-autostart.ps1
# Uninstall:  Unregister-ScheduledTask -TaskName 'PM2 Resurrect' -Confirm:$false
#
# TRA-605 gate-4 postmortem (2026-07-13): PG-DEVOPS14 rebooted 2026-07-12 07:33Z
# and trading-server did NOT come back — it stayed down ~16.7h until a human
# restarted it. The task was not registered on the box at all. The installer
# used to point the task's -File at its own $scriptDir, i.e. at whatever checkout
# it was run from; the only checkouts here are ephemeral per-agent workspaces
# that get reset to origin/main and wiped, so a task installed from one decays
# into a dangling path and fails SILENTLY at boot. The wrapper is now STAGED to a
# stable machine-wide location and the task points THERE, so the boot path never
# depends on a working tree surviving.
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'

$taskName      = 'PM2 Resurrect'
$stableDir     = 'C:\ProgramData\TradingAI\ops'
$stableWrapper = Join-Path $stableDir 'pm2-resurrect-boot.ps1'

# Registering a SYSTEM-principal task without elevation dies with a bare
# "Access is denied." that names neither the cause nor the remedy.
$me = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Must run ELEVATED. Re-run from an Administrator PowerShell: powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
}

$scriptDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceWrapper = Join-Path $scriptDir 'pm2-resurrect-boot.ps1'
if (-not (Test-Path $sourceWrapper)) { throw "wrapper not found next to installer: $sourceWrapper" }

New-Item -ItemType Directory -Path $stableDir -Force | Out-Null
Copy-Item -Path $sourceWrapper -Destination $stableWrapper -Force
Write-Output "Staged wrapper -> $stableWrapper"

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$stableWrapper`""

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

# A task registered against a dangling -File is silent at boot, which is the
# exact failure this script exists to prevent. Assert the path it will actually
# run resolves before claiming success.
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$registeredArgs = ($task.Actions | Select-Object -First 1).Arguments
if ($registeredArgs -notmatch [regex]::Escape($stableWrapper)) {
  throw "post-install check FAILED: task does not reference the stable wrapper ($stableWrapper). Got: $registeredArgs"
}
if (-not (Test-Path $stableWrapper)) {
  throw "post-install check FAILED: task references $stableWrapper but nothing exists there."
}
Write-Output "Post-install check PASS: '$taskName' is $($task.State) and points at an existing stable wrapper."
Write-Output "Reminder: the boot task restores C:\Users\eetienne\.pm2\dump.pm2 and nothing else - re-run 'pm2 save' whenever the process list changes."
