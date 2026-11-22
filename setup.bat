@echo off
REM PARASHURAMA: set up and start (Windows). The Linux / macOS twin is setup.sh; both do the same steps.
REM   setup.bat             install what is missing, build, start the unit server and open http://localhost:8080
REM   setup.bat --offline   web app only, no unit server (http://localhost:5173)
REM   Other options: --port N, --rebuild, --check (install and build only), --no-open, --keep-running,
REM                  --update (pull the latest code first)
REM This one file is enough: run on its own, it gets the project first (Git clone, or a GitHub download without Git).
REM Node.js 22.5 or newer is needed. Order: a portable copy in .node\ inside this folder, then the system's Node.js;
REM if neither fits (missing or too old), the official Node.js 22 for this PC is downloaded from nodejs.org into .node\
REM and its SHA-256 checksum is verified (scripts\get-node.ps1). No administrator rights, nothing installed system-wide.
setlocal
cd /d "%~dp0"
set "REPO_URL=https://github.com/Babanstar456/parashurama.git"
set "REPO_ZIP=https://github.com/Babanstar456/parashurama/archive/refs/heads/main.zip"

REM ---------- 0. The project itself ----------
if exist "%~dp0package.json" if exist "%~dp0scripts\setup.mjs" goto inproject
set "DEST=%~dp0parashurama"
if not "%PARASHURAMA_DIR%"=="" set "DEST=%PARASHURAMA_DIR%"
call :git_ok
set "HAVEGIT=%errorlevel%"
if exist "%DEST%\.git" if "%HAVEGIT%"=="0" goto updateclone
if exist "%DEST%\scripts\setup.mjs" goto haveproject
if "%HAVEGIT%"=="0" goto clone
where git >nul 2>nul
if %errorlevel%==0 echo [setup] Git is older than 2.0: downloading the project without Git.
if not %errorlevel%==0 echo [setup] Git is not installed: downloading the project without Git.
echo [setup] Downloading the project into %DEST% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Net.ServicePointManager]::SecurityProtocol='Tls12';$z=Join-Path $env:TEMP ('parashurama-'+[guid]::NewGuid()+'.zip');$t=Join-Path $env:TEMP ('parashurama-'+[guid]::NewGuid());Invoke-WebRequest -UseBasicParsing $env:REPO_ZIP -OutFile $z;Expand-Archive $z $t;Move-Item (Join-Path $t 'parashurama-main') $env:DEST;Remove-Item -Recurse -Force $z,$t -ErrorAction SilentlyContinue"
if not %errorlevel%==0 goto fetchfailed
goto haveproject

:updateclone
for /f "delims=" %%v in ('git --version') do echo [setup] Updating the project in %DEST% (%%v)...
git -C "%DEST%" pull --ff-only
if not %errorlevel%==0 echo [setup] Could not update (offline, or local changes): using the copy as it is.
goto haveproject

:clone
for /f "delims=" %%v in ('git --version') do echo [setup] %%v found: cloning the project into %DEST% ...
git clone --depth 1 "%REPO_URL%" "%DEST%"
if not %errorlevel%==0 goto fetchfailed
goto haveproject

:haveproject
echo [setup] Starting the project's setup in %DEST%.
call "%DEST%\setup.bat" %*
exit /b %errorlevel%

:fetchfailed
echo [setup] Could not get the project. Check the internet connection and run setup.bat again.
pause
exit /b 1

:inproject
REM --update: pull the latest code first (a Git clone only).
echo %* | findstr /c:"--update" >nul
if not %errorlevel%==0 goto node
call :git_ok
if not %errorlevel%==0 goto noupdate
if not exist "%~dp0.git" goto noupdate
echo [setup] --update: pulling the latest code...
git -C "%~dp0." pull --ff-only
if not %errorlevel%==0 echo [setup] Could not update (offline, or local changes): continuing with this copy.
goto node
:noupdate
echo [setup] --update needs Git and a Git clone of the project: skipped.

:node
REM 1. A portable Node.js from an earlier run.
if exist "%~dp0.node\node.exe" set "PATH=%~dp0.node;%PATH%"
REM 2. The system's Node.js.
call :node_ok
if %errorlevel%==0 if not "%PARASHURAMA_FORCE_NODE_DOWNLOAD%"=="1" goto run

where node >nul 2>nul
if %errorlevel%==0 for /f "delims=" %%v in ('node -v') do echo [setup] Node.js %%v is too old or not usable; PARASHURAMA needs 22.5 or newer.
if not %errorlevel%==0 echo [setup] Node.js 22.5 or newer was not found.
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

:git_ok
where git >nul 2>nul || exit /b 1
for /f "tokens=3 delims= " %%v in ('git --version') do for /f "tokens=1 delims=." %%m in ("%%v") do if %%m GEQ 2 exit /b 0
exit /b 1
