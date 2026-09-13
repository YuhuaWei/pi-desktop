@echo off
rem 启动后端 + 用默认浏览器打开（无 Electron 时的轻量方式）
cd /d "%~dp0"
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  cd /d "%USERPROFILE%"
  start "pi-web-server" /min "%LOCALAPPDATA%\pi-node\current\node.exe" "%~dp0server.mjs"
  timeout /t 4 >nul
)
start "" http://localhost:8787
