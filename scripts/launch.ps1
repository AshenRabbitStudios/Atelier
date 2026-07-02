# Atelier launcher — wired to the Desktop/Start-Menu shortcut by install-shortcut.ps1.
# Rebuilds out/ ONLY when something under the source tree is newer than the last build, then
# starts the built app. This fixes the old shortcut, which ran a frozen out/ build and so never
# reflected code changes. Unchanged relaunches skip the build and start instantly.
#
#   Run:  powershell -ExecutionPolicy Bypass -File scripts\launch.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "C:\Program Files\nodejs;$env:Path"
Set-Location $root

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$outMain = Join-Path $root 'out\main\main.js'

# Decide whether a rebuild is needed: compare the newest source mtime against the last build.
# Only inputs that actually affect the bundle are considered (plugins/ load live from disk at
# runtime, so they are intentionally excluded — a plugin edit needs no rebuild).
$needBuild = $true
if (Test-Path $outMain) {
  $built = (Get-Item $outMain).LastWriteTimeUtc
  $srcDirs = @('electron', 'src') | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }
  $rootFiles = @('index.html', 'package.json', 'electron.vite.config.ts') |
    ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }
  $candidates = @()
  if ($srcDirs) { $candidates += Get-ChildItem -Path $srcDirs -Recurse -File -ErrorAction SilentlyContinue }
  if ($rootFiles) { $candidates += Get-Item -Path $rootFiles }
  $newest = $candidates | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($newest -and $newest.LastWriteTimeUtc -le $built) { $needBuild = $false }
}

if ($needBuild) {
  Write-Host 'Atelier: source changed since last build - rebuilding...'
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    Read-Host 'Build FAILED. Press Enter to close (the app was not started)'
    exit 1
  }
}

if (-not (Test-Path $electron)) { throw "Electron not found at $electron. Run 'npm install' first." }

# Start detached so this launcher window can close; the app keeps running.
Start-Process -FilePath $electron -ArgumentList ('"' + $root + '"') -WorkingDirectory $root
