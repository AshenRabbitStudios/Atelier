@echo off
setlocal
rem Atelier launcher (Windows). One job: find Node, then hand off everything to
rem scripts\bootstrap.mjs (checks deps, Claude CLI, login, build; then starts the app).
rem Usage: run.bat [dev|doctor] [--yes] [--no-launch]
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 goto :run
if exist "C:\Program Files\nodejs\node.exe" (
  set "PATH=C:\Program Files\nodejs;%PATH%"
  goto :run
)
echo Node.js is required but was not found on this machine.
echo Install it with:   winget install OpenJS.NodeJS.LTS
echo   (or download from https://nodejs.org)
echo Then run run.bat again.
pause
exit /b 10

:run
node scripts\bootstrap.mjs %*
set EXITCODE=%errorlevel%
if not %EXITCODE%==0 pause
exit /b %EXITCODE%
