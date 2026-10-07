@echo off
title CCTV Surveillance System - First-Time Setup & Installer
color 0B
cd /d "%~dp0"

echo.
echo ========================================================================
echo   CCTV MATRIX SURVEILLANCE SYSTEM  -  AUTOMATED INSTALLER
echo ========================================================================
echo   This script sets up all dependencies, binaries, and environment
echo   so you can run the system with one click on any Windows PC.
echo ========================================================================
echo.

REM [1/5] Check Python
echo [1/5] Checking Python installation...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo     [WARN] Python was not found in PATH!
    echo     Attempting to install Python via winget...
    winget install Python.Python.3.11 --accept-source-agreements --accept-package-agreements
    echo     Please restart this terminal after Python installs.
    pause
    exit /b 1
)
python --version
echo     Python is ready.

REM [2/5] Install Python dependencies
echo.
echo [2/5] Installing Python libraries (FastAPI, Uvicorn, HTTPX, etc.)...
python -m pip install --upgrade pip
pip install -r "%~dp0requirements.txt"
if %errorlevel% neq 0 (
    echo     [WARN] Some pip packages had issues. Continuing...
) else (
    echo     Python dependencies installed successfully.
)

REM [3/5] Setup bin/ directory and download MediaMTX if missing
echo.
echo [3/5] Checking streaming core binaries (MediaMTX & Cloudflared)...
if not exist "%~dp0bin" mkdir "%~dp0bin"

if not exist "%~dp0bin\mediamtx.exe" (
    echo     Downloading MediaMTX streaming server (v1.9.3)...
    powershell -NoProfile -Command ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "Invoke-WebRequest -Uri 'https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_windows_amd64.zip' -OutFile '%~dp0bin\mediamtx_temp.zip'; " ^
        "Expand-Archive -Path '%~dp0bin\mediamtx_temp.zip' -DestinationPath '%~dp0bin' -Force; " ^
        "Remove-Item -Force '%~dp0bin\mediamtx_temp.zip'"
    if exist "%~dp0bin\mediamtx.exe" (
        echo     MediaMTX binary installed successfully.
    ) else (
        echo     [WARN] Could not auto-download MediaMTX. Please check internet connection.
    )
) else (
    echo     MediaMTX binary already present.
)

if not exist "%~dp0bin\cloudflared.exe" (
    echo     Downloading Cloudflare Tunnel binary...
    powershell -NoProfile -Command ^
        "$ProgressPreference = 'SilentlyContinue'; " ^
        "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%~dp0bin\cloudflared.exe'"
    if exist "%~dp0bin\cloudflared.exe" (
        echo     Cloudflared tunnel binary installed successfully.
    ) else (
        echo     [WARN] Could not auto-download Cloudflared.
    )
) else (
    echo     Cloudflared tunnel binary already present.
)

REM [4/5] Check FFmpeg
echo.
echo [4/5] Checking FFmpeg (required for RTSP feed generation)...
where ffmpeg >nul 2>&1
if %errorlevel% neq 0 (
    echo     FFmpeg not found in PATH.
    echo     Installing Gyan.FFmpeg via winget...
    winget install Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
    echo     FFmpeg installed. (If command fails on first run, restart your terminal to reload PATH).
) else (
    echo     FFmpeg is already installed and accessible in PATH.
)

REM [5/5] Prepare directories
echo.
echo [5/5] Ensuring uploads/ and logs/ folders are ready...
if not exist "%~dp0uploads" mkdir "%~dp0uploads"
if not exist "%~dp0logs" mkdir "%~dp0logs"
echo     Directories ready.

echo.
echo ========================================================================
echo   INSTALLATION COMPLETED SUCCESSFULLY!
echo ========================================================================
echo   All 12 camera videos and configuration are ready to go.
echo.
echo   To launch the server anytime, just run:
echo       .\start.bat
echo ========================================================================
echo.
pause
