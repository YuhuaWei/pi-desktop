@echo off
title pi Web
cd /d "%~dp0"
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  cd /d C:\Users\17662
  start "pi-web-server" /min "C:\Users\17662\AppData\Local\pi-node\current\node.exe" "C:\Users\17662\pi-web\server.mjs"
  timeout /t 4 >nul
)
start "" http://localhost:8787
