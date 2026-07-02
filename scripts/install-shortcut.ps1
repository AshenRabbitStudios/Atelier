# Installs an "Atelier" shortcut (Desktop + Start Menu) that launches the built
# app with no console window, using the app icon. Pin the Start Menu entry to your
# taskbar afterwards (right-click -> Pin to taskbar).
#
#   Run:  powershell -ExecutionPolicy Bypass -File scripts\install-shortcut.ps1
#   or:   npm run app:pin
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "C:\Program Files\nodejs;$env:Path"

$icon     = Join-Path $root 'resources\atelier.ico'
$launcher = Join-Path $root 'scripts\launch.ps1'
$pwsh     = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

# Ensure the icon exists.
if (-not (Test-Path $icon)) {
  Write-Host 'Generating icon...'
  & node (Join-Path $root 'scripts\make-icon.mjs')
}

# The shortcut runs launch.ps1 (rebuilds only if source changed, then starts the app) instead of
# electron.exe directly against a frozen out/ build — so a pinned launch always reflects current code.
function New-AtelierShortcut([string]$linkPath) {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($linkPath)
  $sc.TargetPath       = $pwsh
  $sc.Arguments        = '-ExecutionPolicy Bypass -WindowStyle Minimized -File "' + $launcher + '"'
  $sc.WorkingDirectory = $root
  $sc.IconLocation     = $icon
  $sc.WindowStyle      = 7   # start minimized (build output flashes only when a rebuild is needed)
  $sc.Description       = 'Atelier - dockable Claude workbench'
  $sc.Save()
  Write-Host "  created: $linkPath"
}

$desktop   = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'

New-AtelierShortcut (Join-Path $desktop   'Atelier.lnk')
New-AtelierShortcut (Join-Path $startMenu 'Atelier.lnk')

Write-Host ''
Write-Host 'Done. To pin Atelier to your taskbar:'
Write-Host '  1. Open the Start menu and type: Atelier'
Write-Host '  2. Right-click the result -> Pin to taskbar'
Write-Host '     (or drag the Desktop "Atelier" shortcut onto the taskbar)'
Write-Host ''
Write-Host 'The shortcut auto-rebuilds when source changed, so launching always reflects current code.'
