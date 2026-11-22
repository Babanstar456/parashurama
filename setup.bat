@echo off
REM PARASHURAMA: set up and start (Windows).
REM   setup.bat             install what is missing, build, start the unit server and open http://localhost:8080
REM   setup.bat --offline   web app only, no unit server (http://localhost:5173)
REM   Other options: --port N, --rebuild, --check (install and build only), --no-open
REM Needs Node.js 22.5 or newer. If it is missing or too old, it is installed with winget.
setlocal
cd /d "%~dp0"

call :node_ok
if %errorlevel%==0 goto run

where node >nul 2>nul
if %errorlevel%==0 (
  for /f "delims=" %%v in ('node -v') do echo [setup] Node.js %%v is too old; PARASHURAMA needs 22.5 or newer.
) else (
  echo [setup] Node.js is not installed.
)

where winget >nul 2>nul
if not %errorlevel%==0 goto manual
echo [setup] Installing Node.js LTS with winget...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
REM This window does not see the new PATH yet: add the default install folder.
set "PATH=%ProgramFiles%\nodejs;%PATH%"
call :node_ok
if %errorlevel%==0 goto run

:manual
echo [setup] Please install Node.js 22 or newer from https://nodejs.org (LTS, Windows Installer),
echo [setup] then close this window and run setup.bat again.
start "" https://nodejs.org/en/download
pause
exit /b 1

:run
for /f "delims=" %%v in ('node -v') do echo [setup] Node.js %%v
node scripts\setup.mjs %*
set "CODE=%errorlevel%"
if not "%CODE%"=="0" pause
exit /b %CODE%

:node_ok
where node >nul 2>nul || exit /b 1
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)" >nul 2>nul
exit /b %errorlevel%
