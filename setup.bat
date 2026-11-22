@echo off
REM PARASHURAMA: set up and start (Windows). The Linux / macOS twin is setup.sh; both do the same steps.
REM   setup.bat             install what is missing, build, start the unit server and open http://localhost:8080
REM   setup.bat --offline   web app only, no unit server (http://localhost:5173)
REM   Other options: --port N, --rebuild, --check (install and build only), --no-open, --keep-running
REM Node.js 22.5 or newer is needed. Order: a portable copy in .node\ inside this folder, then the system's Node.js;
REM if neither fits (missing or too old), the official Node.js 22 for this PC is downloaded from nodejs.org into .node\
REM and its SHA-256 checksum is verified (scripts\get-node.ps1). No administrator rights, nothing installed system-wide.
setlocal
cd /d "%~dp0"

REM 1. A portable Node.js from an earlier run.
if exist "%~dp0.node\node.exe" set "PATH=%~dp0.node;%PATH%"
REM 2. The system's Node.js.
call :node_ok
if %errorlevel%==0 if not "%PARASHURAMA_FORCE_NODE_DOWNLOAD%"=="1" goto run

where node >nul 2>nul
if %errorlevel%==0 (
  for /f "delims=" %%v in ('node -v') do echo [setup] Node.js %%v is too old or not usable; PARASHURAMA needs 22.5 or newer.
) else (
  echo [setup] Node.js 22.5 or newer was not found.
)
REM 3. Download the official Node.js 22 into .node\ (PARASHURAMA_FORCE_NODE_DOWNLOAD=1 forces this, for testing).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-node.ps1"
if not %errorlevel%==0 goto manual
set "PATH=%~dp0.node;%PATH%"
call :node_ok
if %errorlevel%==0 goto run

:manual
echo [setup] Node.js could not be downloaded. Check the internet connection and run setup.bat again,
echo [setup] or install Node.js 22 from https://nodejs.org (LTS, Windows Installer) and run setup.bat again.
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
