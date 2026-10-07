@echo off
title Cloudflare Free Web Surveillance Center Tunnel (Port 8000)
cd /d "%~dp0"
echo ======================================================================
echo Starting Cloudflare Free Quick Tunnel (No Sign-up / No Card)...
echo ======================================================================
echo Watch for the https://xxxx.trycloudflare.com link generated below.
echo Open that link on your phone, tablet, or PC anywhere in the world!
echo ======================================================================
echo.
bin\cloudflared.exe tunnel --url http://127.0.0.1:8000 --logfile logs\tunnel.log
pause
