@echo off
title CCTV Streaming Server - RAM Disk Mode
color 0A

echo.
echo ============================================================
echo   CCTV SERVER - RAM DISK MODE
echo ============================================================
echo.

:: Step 1: Setup RAM Disk (copies opt_*.mp4 to R:\ for zero disk I/O)
echo [1/2] Setting up RAM disk...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_ramdisk.ps1"

if %errorlevel% neq 0 (
    echo.
    echo [WARN] RAM disk setup failed. Falling back to disk-based streaming.
    echo        This may cause high disk I/O with many streams.
    echo.
    pause
)

:: Step 2: Start the CCTV server
echo.
echo [2/2] Starting CCTV server...
echo.

cd /d "%~dp0"
python run_server.py
