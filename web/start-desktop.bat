@echo off
title pi Desktop
cd /d C:\Users\17662
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  start "pi-web-server" /min "C:\Users\17662\AppData\Local\pi-node\current\node.exe" "C:\Users\17662\pi-web\server.mjs"
  timeout /t 4 >nul
)
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:8787
