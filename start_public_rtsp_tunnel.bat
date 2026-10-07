@echo off
title Public RTSP Stream Tunnel (Port 8554 via ngrok)
cd /d "%~dp0"
echo ======================================================================
echo   STARTING PUBLIC RTSP TUNNEL (Port 8554)
echo ======================================================================
echo   This creates a worldwide public RTSP link for VLC, NVRs, and OpenCV.
echo   Look for the 'Forwarding' URL below:
echo   Example:  tcp://4.tcp.ngrok.io:12345
echo   Your Public RTSP Stream will be:
echo   rtsp://4.tcp.ngrok.io:12345/cam1
echo ======================================================================
echo.
ngrok tcp 8554
pause
