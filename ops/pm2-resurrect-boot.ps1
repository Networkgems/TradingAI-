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
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = 'Stop'

$env:PM2_HOME = 'C:\Users\eetienne\.pm2'
$pm2  = 'C:\Users\eetienne\AppData\Roaming\npm\node_modules\pm2\bin\pm2'
$node = 'C:\Program Files\nodejs\node.exe'
$log  = Join-Path $env:PM2_HOME 'resurrect-boot.log'

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
} catch {
  Log "ERROR: $_"
  exit 1
}
