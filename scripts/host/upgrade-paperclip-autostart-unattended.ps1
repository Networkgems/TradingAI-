<#
  upgrade-paperclip-autostart-unattended.ps1  --  TRA-5105

  OPERATOR SCRIPT. Run it interactively, at the host, as PRIMEROGA\eetienne.
  It prompts for that account's Windows password (Get-Credential) and the
  credential never leaves the machine -- it goes straight into
  Register-ScheduledTask -Password, which stores it with the task. An agent
  cannot run this: it has no password, and the no-credential alternative
  (-LogonType S4U) is denied to the non-admin operating account
  (re-measured 2026-10-04: "Access is denied.", same as 2026-10-02).

  WHAT IT CHANGES AND WHY
    TRA-5054 installed `Paperclip-Autostart` under LogonType=Interactive,
    which Task Scheduler refuses to launch unless the user is interactively
    logged on -- regardless of trigger. After the unattended NinjaRMM reboot
    on 2026-10-04 the task's own PT5M trigger fired 70 consecutive times
    (07:35:59Z..13:20:59Z) and every one was refused with event Id 332
    ("user '(NONE)' was not logged on"): 5.81h of host-UP scheduler darkness,
    95% of the dark window.

    Those 70 refusals are also the proof of the fix's shape: the trigger was
    ALREADY firing all through the window -- only the principal refused it.
    So this script:
      1. flips the principal to LogonType=Password ("run whether user is
         logged on or not"), which ALONE bounds post-boot recovery at ~5 min
         via the existing repeating TimeTrigger; and
      2. adds a BootTrigger so recovery is seconds, not minutes -- boot
         triggers need elevation, so if registration with it is denied the
         script retries without it and says so. Run elevated to get it.

    Password is preferred over S4U deliberately (TRA-5105): S4U runs in a
    non-interactive session with no loaded profile, and the server chain
    (node <- npx <- paperclipai onboard, plus ACP adapters spawned under the
    user profile) has never been proven in one. A server that boots but
    cannot execute runs is worse than dark. Password gets a real user token
    with the profile loaded.

  CAVEATS
    - After a Windows password change the stored credential goes stale and
      the task fails 0x8007052E until this script is re-run.
    - If the account lacks the "Log on as a batch job" right, registration
      succeeds but every launch fails 0x80070569; an administrator must grant
      the right (secpol.msc > Local Policies > User Rights Assignment).

  ACCEPTANCE (TRA-5105) -- a config diff is NOT a pass. The task read
  State=Running all through the 5.81h outage. The gate is a real unattended
  boot: reboot with nobody logged on, then assert
    (a) a heartbeat_runs row within ~10 min of LastBootUpTime,
    (b) ZERO Id-332 events for this task in that window, and
    (c) one agent run completing with error_code IS NULL on the ACP lane.
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Paperclip-Autostart',
  [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'

function Fail { param([string]$m) Write-Output "FAIL: $m"; exit 1 }
function Ok   { param([string]$m) Write-Output "ok   : $m" }

$winid    = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]$winid).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Ok "running as $($winid.Name); elevated=$elevated"
if (-not $elevated) {
  Write-Output 'note : not elevated -- the Password principal flip should still work, but the BootTrigger add may be refused (boot triggers need elevation). The PT5M TimeTrigger bounds recovery at ~5 min either way.'
}

$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $t) { Fail "task '$TaskName' is not registered -- run install-paperclip-autostart.ps1 first" }

[xml]$xml = Export-ScheduledTask -TaskName $TaskName
$ns = 'http://schemas.microsoft.com/windows/2004/02/mit/task'

$principal = $xml.Task.Principals.Principal
Ok "current LogonType: $($principal.LogonType)"
$principal.LogonType = 'Password'

$hadBoot = $xml.Task.Triggers.SelectNodes('*[local-name()="BootTrigger"]').Count -gt 0
if (-not $hadBoot) {
  $bt = $xml.CreateElement('BootTrigger', $ns)
  $en = $xml.CreateElement('Enabled', $ns)
  $en.InnerText = 'true'
  [void]$bt.AppendChild($en)
  [void]$xml.Task.Triggers.AppendChild($bt)
}

$user = $winid.Name
$cred = Get-Credential -UserName $user -Message "Windows password for $user. Stored with task '$TaskName' so it can run at boot with nobody logged on (TRA-5105). It never leaves this host."
if (-not $cred) { Fail 'no credential supplied' }
$plain = $cred.GetNetworkCredential().Password

$bootTriggerInstalled = $true
try {
  Register-ScheduledTask -TaskName $TaskName -Xml $xml.OuterXml -User $user -Password $plain -Force -ErrorAction Stop | Out-Null
} catch {
  Write-Output "warn : registration WITH BootTrigger failed ($($_.Exception.Message.Trim())) -- retrying without it"
  $node = $xml.Task.Triggers.SelectSingleNode('*[local-name()="BootTrigger"]')
  if ($node) { [void]$xml.Task.Triggers.RemoveChild($node) }
  $bootTriggerInstalled = $false
  # A failure here is fatal, and should be: it means the principal flip
  # itself was refused, and the task is still logon-gated.
  Register-ScheduledTask -TaskName $TaskName -Xml $xml.OuterXml -User $user -Password $plain -Force -ErrorAction Stop | Out-Null
}
$plain = $null
$cred  = $null

# ---- post-registration asserts (definition level) --------------------------
[xml]$after = Export-ScheduledTask -TaskName $TaskName
$lt = $after.Task.Principals.Principal.LogonType
if ($lt -ne 'Password') { Fail "post-registration LogonType is '$lt', expected 'Password'" }
Ok 'principal: LogonType=Password (runs whether or not the user is logged on)'

$bootCount = $after.SelectNodes('//*[local-name()="BootTrigger"]').Count
if ($bootTriggerInstalled -and $bootCount -lt 1) { Fail 'BootTrigger missing after a registration that claimed to include it' }
if ($bootCount -ge 1) {
  Ok 'BootTrigger present (fires at boot, before any logon)'
} else {
  Write-Output 'note : BootTrigger NOT installed (refused without elevation). Post-boot recovery still bounded at ~5 min by the repeating TimeTrigger -- the same trigger that generated 70 Id-332 refusals on 2026-10-04 proves it fires unattended. Re-run elevated to add the BootTrigger.'
}

# Re-assert the TRA-5054 invariants (no EndBoundary, PT0S, IgnoreNew, ...)
& (Join-Path $PSScriptRoot 'install-paperclip-autostart.ps1') -TaskName $TaskName -Verify
if ($LASTEXITCODE -ne 0) { Fail 'TRA-5054 definition invariants regressed -- see above' }

# ---- smoke test (liveness level) --------------------------------------------
if (-not $SkipSmokeTest) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 15
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $hex  = '0x{0:X8}' -f $info.LastTaskResult
  switch ($info.LastTaskResult) {
    0          { Ok 'smoke run: LastTaskResult 0' }
    2147946720 { Ok "smoke run: $hex -- IgnoreNew refused the start because an instance is already live (designed shape, not a fault)" }
    2147943785 { Fail "$hex -- the account lacks the 'Log on as a batch job' right, so the Password principal cannot launch. An administrator must grant it: secpol.msc > Local Policies > User Rights Assignment > Log on as a batch job" }
    2147943726 { Fail "$hex -- stored credential rejected (wrong or stale password). Re-run this script" }
    default    { Write-Output "warn : smoke run LastTaskResult $hex -- inspect Microsoft-Windows-TaskScheduler/Operational" }
  }
  $listening = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    Ok "server listening on :3100 (pid $(@($listening)[0].OwningProcess))"
  } else {
    Write-Output 'warn : nothing listening on :3100 -- check %USERPROFILE%\.paperclip\autostart\logs\autostart.log'
  }
}

Write-Output ''
Write-Output 'UPGRADE: definition PASS. The ACCEPTANCE gate is a real unattended boot:'
Write-Output '  reboot with nobody logged on, then assert (a) a heartbeat_runs row within'
Write-Output '  ~10 min of LastBootUpTime, (b) zero Id-332 events for this task in that'
Write-Output '  window, (c) one ACP-lane agent run with error_code IS NULL. (TRA-5105)'
