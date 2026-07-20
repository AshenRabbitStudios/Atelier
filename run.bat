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
echo  Node.js is the runtime Atelier is built on. To install it:
echo.
echo  1. Open PowerShell: press the Windows key, type "powershell",
echo     press Enter.
echo  2. Paste this line into it and press Enter:
echo.
echo         winget install OpenJS.NodeJS.LTS
echo.
echo     (Or download the installer from https://nodejs.org and
echo     run it like any other program.)
echo  3. When it finishes, CLOSE this window and that PowerShell
echo     window (open windows keep the old settings), then
echo     double-click run.bat again.
echo.
pause
exit /b 10

:run
node scripts\bootstrap.mjs %*
set EXITCODE=%errorlevel%
if not %EXITCODE%==0 pause
exit /b %EXITCODE%
