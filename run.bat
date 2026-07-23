@echo off
setlocal
rem Atelier launcher (Windows). One job: find Node, then hand off everything to
rem scripts\bootstrap.mjs (checks deps, Claude CLI, sign-in, build; then starts the app).
rem Usage: run.bat [dev|doctor] [--yes] [--no-launch]
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 goto :run
if exist "C:\Program Files\nodejs\node.exe" (
  set "PATH=C:\Program Files\nodejs;%PATH%"
  goto :run
)
echo ============================================================
echo  Atelier needs Node.js, which is not installed on this PC.
echo ============================================================
echo.
echo  Node.js is the runtime Atelier is built on (version 20.19+ or 22.12+).
echo.
echo  Easiest, works on every PC:
echo    Download the Windows Installer (LTS) from https://nodejs.org and
echo    run it like any other program.
echo.
rem Offer winget only if it's actually on this PC (absent on older Windows builds).
where winget >nul 2>nul
if %errorlevel%==0 (
  echo  Or, since winget is installed here, paste this into this window
  echo  or PowerShell and press Enter:
  echo.
  echo        winget install OpenJS.NodeJS.LTS
  echo.
)
echo  When it finishes, CLOSE this window ^(open windows keep the old PATH^),
echo  reopen it, and double-click run.bat again.
echo.
pause
exit /b 10

:run
set "ATELIER_SHELL=cmd"
node scripts\bootstrap.mjs %*
set EXITCODE=%errorlevel%
if not %EXITCODE%==0 pause
exit /b %EXITCODE%
