# Redeploys a locally-built 9router CLI over the globally installed one.
#
# Usage (regular PowerShell, no admin needed):
#   powershell -ExecutionPolicy Bypass -File scripts\redeploy-local.ps1
# Options:
#   -SkipBuild   Reuse an existing 9router-*.tgz in the repo root (no rebuild)
#
# What it does:
#   1. Checks free disk space (build needs ~4 GB+)
#   2. Stops any running 9router instance installed under Roaming\npm
#      (matches the install path, so it never touches this repo or other apps)
#   3. Builds the CLI tarball (npm run cli:pack) unless -SkipBuild
#   4. Swaps the global package: uninstall registry copy -> install local tgz
#   5. Starts the server detached in tray mode with --skip-update
#   6. Waits for http://127.0.0.1:20128/api/health to return OK
#
# Your data lives in %APPDATA%\9router and is never touched by this script.

param(
    [switch]$SkipBuild,
    [int]$Port = 20128
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# --- 1. free-space guard ------------------------------------------------------
$freeGB = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
if ($freeGB -lt 4) {
    throw "Only $freeGB GB free on C:. The build needs ~4 GB+; free some space first."
}
Write-Host "Free space: $freeGB GB" -ForegroundColor Gray

# --- 2. stop the running global instance --------------------------------------
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" |
    Where-Object { $_.CommandLine -imatch 'node_modules[\\/]9router' }
if ($procs) {
    $procs | ForEach-Object { Write-Host ("Stopping PID {0}: {1}" -f $_.ProcessId, ($_.CommandLine.Split(' ')[0])) -ForegroundColor Gray }
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
} else {
    Write-Host 'No running 9router instance found.' -ForegroundColor Gray
}

# --- 3. build the tarball ------------------------------------------------------
if (-not $SkipBuild) {
    if (-not (Test-Path node_modules)) {
        Write-Host 'Installing app dependencies...' -ForegroundColor Gray
        npm install 2>&1 | Out-Host
    }
    if (-not (Test-Path cli\node_modules)) {
        Write-Host 'Installing CLI dependencies (esbuild for the MITM bundle)...' -ForegroundColor Gray
        npm install --prefix cli 2>&1 | Out-Host
    }
    Write-Host 'Building (takes a few minutes)...' -ForegroundColor Gray
    npm run cli:pack 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'cli:pack failed - see output above' }
}

$tgz = Get-ChildItem "$repoRoot\9router-*.tgz" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $tgz) { throw 'No 9router-*.tgz found in the repo root.' }
Write-Host "Tarball: $($tgz.Name)" -ForegroundColor Gray

# --- 4. swap the global package ------------------------------------------------
npm uninstall -g 9router 2>&1 | Out-Host
npm install -g $tgz.FullName 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'global install failed - see output above' }
Write-Host ("Installed version: {0}" -f (& "$env:APPDATA\npm\9router.cmd" --version)) -ForegroundColor Gray

# --- 5. start detached (tray, no auto-update) ----------------------------------
Start-Process -FilePath "$env:APPDATA\npm\9router.cmd" -ArgumentList '--tray', '--skip-update' -WindowStyle Hidden

# --- 6. health check -----------------------------------------------------------
foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
        if ($r.StatusCode -eq 200) {
            Write-Host "Deployed and healthy: $($r.Content) (dashboard: http://127.0.0.1:$Port)" -ForegroundColor Green
            exit 0
        }
    } catch {}
}
Write-Warning "Server did not come up on port $Port - run '9router --skip-update' manually to see the startup logs."
exit 1
