@echo off
title CCTV - Starting...
color 0A
cd /d "%~dp0"

echo.
echo ========================================================================
echo   CCTV SURVEILLANCE SERVER  -  ONE-CLICK LAUNCHER
echo ========================================================================
echo.

REM [0/4] First time run check
if not exist "%~dp0bin\mediamtx.exe" (
    echo [!] First time run detected: core streaming binaries missing.
    echo     Running automated installer first...
    call "%~dp0install.bat"
)

REM [1/4] Kill stale processes
echo [1/4] Cleaning up old processes...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
taskkill /F /IM ffmpeg.exe    >nul 2>&1
taskkill /F /IM mediamtx.exe  >nul 2>&1
taskkill /F /IM cloudflared.exe >nul 2>&1
echo     Done.

REM [2/4] RAM Disk setup (zero disk I/O for all streams)
echo.
echo [2/4] Setting up RAM disk (zero disk I/O streaming)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_ramdisk.ps1"
if %errorlevel% neq 0 (
    echo     [WARN] RAM disk setup failed. Falling back to disk-based streaming.
) else (
    echo     RAM disk ready.
)

REM [3/4] Start Cloudflare tunnel in a separate window
echo.
echo [3/4] Launching Cloudflare tunnel (watch new window for your public URL)...
start "Cloudflare Tunnel - CCTV" cmd /c "%~dp0start_cloudflare_tunnel.bat"
echo     Cloudflare tunnel window opened.

REM [4/4] Start CCTV server (this window)
echo.
echo [4/4] Starting CCTV server...
echo ========================================================================
echo.
title CCTV Surveillance Server
python run_server.py
pause
