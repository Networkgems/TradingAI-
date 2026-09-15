<#
.SYNOPSIS
    Creates a desktop icon (shortcut) that runs the Paperclip onboarding command.

.DESCRIPTION
    Generates a Windows .lnk shortcut on the current user's Desktop. Double-clicking
    it opens a PowerShell window and runs:

        npx paperclipai onboard --yes

    This replaces having to open PowerShell and type the command by hand (TRA-808).

    The shortcut uses -NoExit so the window stays open after onboarding finishes,
    letting you read any output or follow-up prompts.

.PARAMETER Name
    The shortcut file name (without extension). Defaults to "Run Paperclip".

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File ops\windows\create-paperclip-shortcut.ps1
#>
[CmdletBinding()]
param(
    [string]$Name = 'Run Paperclip'
)

$ErrorActionPreference = 'Stop'

$desktop      = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "$Name.lnk"
$psExe        = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

# -NoExit keeps the console open so the user can see the result / answer prompts.
# -Command runs the onboarding flow non-interactively (--yes auto-accepts).
$arguments = '-NoExit -ExecutionPolicy Bypass -Command "npx paperclipai onboard --yes"'

$shell    = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath       = $psExe
$shortcut.Arguments        = $arguments
$shortcut.WorkingDirectory = $env:USERPROFILE
$shortcut.IconLocation     = "$psExe,0"
$shortcut.Description       = 'Run Paperclip onboarding (npx paperclipai onboard --yes)'
$shortcut.WindowStyle       = 1   # normal window
$shortcut.Save()

# Release the COM object so the file handle is not held open.
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

Write-Host "Created desktop shortcut: $shortcutPath"
