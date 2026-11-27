@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" http://localhost:5317
node tools/serve.js
pause
