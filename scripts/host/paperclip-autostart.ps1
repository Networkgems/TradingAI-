<#
  paperclip-autostart.ps1  --  TRA-5054

  Restores Paperclip scheduling without a human in the loop.

  The Paperclip scheduler is a plain setInterval INSIDE the server process
  (TRA-4938 point 1), so "no process" means no ticks for routines, monitors or
  heartbeats alike. Before this script the server was started only by a human
  typing `npx paperclipai onboard --yes` after each boot, which cost 33.58h of
  host-UP scheduler darkness over 2026-09-21..10-01 (TRA-5053).

  This script is the ACTION behind the Paperclip-Autostart scheduled task. It is
  deliberately idempotent so it can double as a crash supervisor: the task also
  carries a repetition interval, and every repetition that finds a healthy
  server is a logged no-op.

  Exit codes:
    0  server was already listening (no-op), or the server ran and exited cleanly
    0  -DryRun printed the resolved command without executing it
    N  the server process exited non-zero (surfaced as the task's LastTaskResult)

  NOTE on the command we run: `npx paperclipai onboard --yes` is not a guess. It
  is byte-for-byte the ancestry of the server process that was live and healthy
  when this was authored (PID 22940, created 2026-10-01T15:15:09Z). The CLI's own
  `paperclipai service install` is NOT usable here -- it answers
  {"supported": false, "message": "Service management is not supported on win32"}.
#>
[CmdletBinding()]
param(
  [int]$Port = 3100,
  [switch]$DryRun,
  # TEST ONLY. Appends `-d <dir>` so the cold-start path can be exercised against a
  # disposable instance (paired with PAPERCLIP_SERVER_PORT /
  # PAPERCLIP_EMBEDDED_POSTGRES_PORT) without disturbing the live server on :3100.
  # The installed task never passes this, so the production command line is exactly
  # the ancestry of the known-good hand-started process.
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'

$Root    = Join-Path $env:USERPROFILE '.paperclip\autostart'
$LogDir  = Join-Path $Root 'logs'
$LogFile = Join-Path $LogDir 'autostart.log'
$OutFile = Join-Path $LogDir "server.$Port.out.log"
$ErrFile = Join-Path $LogDir "server.$Port.err.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

function Write-Log {
  param([string]$Level, [string]$Message)
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  $line  = "$stamp [$Level] $Message"
  try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
  Write-Output $line
}

# Keep the forensic log bounded; one roll-over is enough history for a boot audit.
try {
  if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 5MB)) {
    Move-Item -Path $LogFile -Destination "$LogFile.1" -Force
  }
} catch { }

function Get-ServerPid {
  param([int]$P)
  try {
    $conn = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch { }
  return 0
}

# Second, port-independent guard. MEASURED 2026-10-02: when :3100 is already taken
# the CLI does not fail -- it silently binds the next free port (observed shifting to
# :3101 and serving the live database). So "nothing is listening on 3100" is NOT the
# same as "no server is running", and a port-only guard could stack servers on 3101,
# 3102, ... We therefore also refuse to start if a paperclipai onboard process exists.
function Get-OnboardPid {
  try {
    $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -and
                        $_.CommandLine -match 'paperclipai' -and
                        $_.CommandLine -match '\bonboard\b' -and
                        $_.ProcessId -ne $PID } |
         Select-Object -First 1
    if ($p) { return [int]$p.ProcessId }
  } catch { }
  return 0
}

# Resolve node + npx by absolute path. The scheduled task runs with a trimmed
# environment and PATH is not guaranteed to carry nodejs.
$NodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$NpxCli  = Join-Path $env:ProgramFiles 'nodejs\node_modules\npm\bin\npx-cli.js'
$CmdArgs = @($NpxCli, 'paperclipai', 'onboard', '--yes')
if ($DataDir) { $CmdArgs += @('-d', $DataDir) }

Write-Log 'INFO' "autostart invoked (port=$Port dryRun=$($DryRun.IsPresent) user=$env:USERNAME session=$([System.Diagnostics.Process]::GetCurrentProcess().SessionId))"

if (-not (Test-Path $NodeExe)) { Write-Log 'ERROR' "node not found at $NodeExe"; exit 9 }
if (-not (Test-Path $NpxCli))  { Write-Log 'ERROR' "npx-cli not found at $NpxCli"; exit 9 }

$resolved = '"' + $NodeExe + '" "' + ($CmdArgs -join '" "') + '"'

if ($DryRun) {
  Write-Log 'DRYRUN' "resolved command: $resolved"
  exit 0
}

# TRA-5156: the task now runs MultipleInstances=Parallel (IgnoreNew let the long-lived
# launcher instance mask every PT5M repetition -- 693 Id-322 skips, guard dead since
# 2026-10-03). Parallel means this guard+start window can overlap with the logon
# trigger's instance, so serialize it. Held only until the server is UP (or the guard
# no-ops); the long WaitForExit below runs OUTSIDE the mutex.
$startMutex = New-Object System.Threading.Mutex($false, 'GlobalPaperclip-Autostart-Start')
$haveMutex = $false
try { $haveMutex = $startMutex.WaitOne([TimeSpan]::FromMinutes(6)) } catch [System.Threading.AbandonedMutexException] { $haveMutex = $true }
if (-not $haveMutex) { Write-Log 'NOOP' 'could not take the start mutex in 6 minutes; another instance is mid-start'; exit 0 }
function Release-StartMutex { if ($script:haveMutex) { try { $script:startMutex.ReleaseMutex() } catch { } ; $script:haveMutex = $false } }

$existing = Get-ServerPid -P $Port
if ($existing -gt 0) {
  Release-StartMutex
  Write-Log 'NOOP' "server already listening on 127.0.0.1:$Port (pid=$existing); nothing to do"
  exit 0
}

$onboardPid = Get-OnboardPid
if ($onboardPid -gt 0) {
  Release-StartMutex
  Write-Log 'NOOP' "no listener on 127.0.0.1:$Port but a paperclipai onboard process is alive (pid=$onboardPid); it is still booting or has port-shifted -- refusing to stack a second server"
  exit 0
}

Write-Log 'START' "no listener on 127.0.0.1:$Port; starting: $resolved"

# Quote every element explicitly. Passing the raw array lets Start-Process join on
# spaces unquoted, which splits "C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js"
# at the first space and dies with Cannot find module 'C:\Program'. That failure is
# invisible on the already-running path (the guard no-ops before reaching here), so it
# would have shipped a task that reads Ready and never starts a server.
$argLine = ($CmdArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '

# TRA-5156: observe-only scheduler tick probe, preloaded into the server (and stripped
# from NODE_OPTIONS by the probe itself so agent children do not inherit it).
$Probe = Join-Path $Root 'paperclip-tick-probe.cjs'
if (Test-Path $Probe) {
  $env:NODE_OPTIONS = (($env:NODE_OPTIONS + ' --require "' + $Probe + '"')).Trim()
  Write-Log 'INFO' "tick probe preloaded: $Probe"
} else {
  Write-Log 'WARN' "tick probe NOT found at $Probe -- starting without it (watchdog will read tick_probe_absent)"
}

$proc = Start-Process -FilePath $NodeExe -ArgumentList $argLine `
          -NoNewWindow -PassThru `
          -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile

Write-Log 'SPAWNED' "launcher child pid=$($proc.Id); waiting for listener on 127.0.0.1:$Port"

# Confirm the server actually came up, so the log records liveness rather than
# merely "we typed the command" -- the health-field rule from CLAUDE.md applied
# to a launcher.
$deadline = (Get-Date).AddMinutes(5)
$serverPid = 0
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { break }
  $serverPid = Get-ServerPid -P $Port
  if ($serverPid -gt 0) { break }
  Start-Sleep -Seconds 5
}

if ($serverPid -gt 0) {
  Write-Log 'UP' "listener confirmed on 127.0.0.1:$Port (pid=$serverPid) after launcher child pid=$($proc.Id)"
} elseif ($proc.HasExited) {
  # WaitForExit() before reading ExitCode: on a Start-Process -PassThru object the
  # code is not populated by HasExited alone and reads back empty.
  $proc.WaitForExit()
  $tail = ''
  try { $tail = (Get-Content $ErrFile -Tail 3 -ErrorAction SilentlyContinue) -join ' | ' } catch { }
  Write-Log 'ERROR' "launcher child exited (code=$($proc.ExitCode)) before any listener appeared; stderr: $tail"
} else {
  Write-Log 'ERROR' "no listener on 127.0.0.1:$Port within 5 minutes; see $ErrFile"
}

Release-StartMutex

# Hold the task open for the lifetime of the server. Combined with the task's
# MultipleInstancesPolicy=Parallel the repetition keeps launching fresh guard
# instances (each a logged no-op while a server is up) -- that is what makes the interval
# a supervisor. The start mutex above, not IgnoreNew, is what prevents duplicate servers.
$proc.WaitForExit()
Write-Log 'EXIT' "server process pid=$($proc.Id) exited with code=$($proc.ExitCode)"
exit $proc.ExitCode
