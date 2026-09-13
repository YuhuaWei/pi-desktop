@echo off
rem pi 桌面版启动脚本
rem 注意: "%~dp0." 末尾的点用于避免 "\" 与引号组合被转义
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
