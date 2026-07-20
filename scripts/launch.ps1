# Atelier launcher — wired to the Desktop/Start-Menu shortcut by install-shortcut.ps1.
# Thin wrapper: all install/staleness/auth/build logic lives in scripts/bootstrap.mjs
# (see docs/INSTALL.md). The bootstrap rebuilds only when sources changed, then starts
# the app detached, so this window can close while Atelier keeps running.
#
#   Run:  powershell -ExecutionPolicy Bypass -File scripts\launch.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "C:\Program Files\nodejs;$env:Path"
Set-Location $root

& node scripts\bootstrap.mjs run
if ($LASTEXITCODE -ne 0) {
  Read-Host 'Startup FAILED (see above). Press Enter to close (the app was not started)'
  exit $LASTEXITCODE
}
