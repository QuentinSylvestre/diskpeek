@echo off
cd /d "%~dp0server"
start "" /B node server.js
set RETRIES=0
:wait
set /a RETRIES+=1
if %RETRIES% gtr 30 (
  echo Server did not start within 30 seconds. Check server/server.js for errors.
  pause
  exit /b 1
)
timeout /t 1 /nobreak > nul
netstat -an 2>nul | findstr /C:"127.0.0.1:3000" > nul
if errorlevel 1 goto wait
start "" "http://localhost:3000"
