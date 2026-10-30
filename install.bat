@echo off
REM Installs the 9router CLI globally on Windows from this repo checkout.
REM Usage: double-click, or run from a terminal:  install.bat
REM Builds the bundled app first (scripts/build-cli.js), so the installed CLI
REM always embeds the current source of the gateway, not a stale build.

setlocal
set "REPO_ROOT=%~dp0"
set "REPO_ROOT=%REPO_ROOT:~0,-1%"

where npm >nul 2>nul
if errorlevel 1 (
  echo [9router] npm not found on PATH. Install Node.js first: https://nodejs.org
  exit /b 1
)

echo [9router] building CLI bundle (root npm install + build, ~9 min)...
pushd "%REPO_ROOT%"
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [9router] root npm install failed. Fix errors above, then rerun install.bat.
  popd
  exit /b 1
)
call npm run cli:pack
if errorlevel 1 (
  echo [9router] npm run cli:pack failed. Fix errors above, then rerun install.bat.
  popd
  exit /b 1
)
popd

REM npm pack --pack-destination .. drops the tgz in the root next to cli/.
setlocal enabledelayedexpansion
set "TGZ="
for %%f in ("%REPO_ROOT%\9router-*.tgz") do if not defined TGZ set "TGZ=%%f"
echo [9router] installing global CLI from !TGZ! ...
call npm install -g "!TGZ!"
if errorlevel 1 (
  echo [9router] npm install -g failed. Fix the errors above, then rerun install.bat.
  exit /b 1
)

call 9router --version >nul 2>nul
if errorlevel 1 (
  echo [9router] installed, but ^"9router^" is not on PATH yet. Open a new terminal and run: 9router
  exit /b 0
)
echo [9router] done. Run ^"9router^" in any terminal to start.
endlocal
