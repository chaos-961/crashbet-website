@echo off
title Lowpoly Garage server - close this window to stop
cd /d "%~dp0"

rem -- free port 5183 if a stale server is still holding it --
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr /c:":5183 "') do (
  if not "%%p"=="0" if not "%%p"=="4" taskkill /f /pid %%p >nul 2>&1
)

start "" http://localhost:5183

echo.
echo   Lowpoly Garage running at http://localhost:5183
echo   Close this window (or press Ctrl+C) to stop the server.
echo.

npx -y http-server -p 5183 -c-1 .
