@echo off
REM SECURITY NOTE: This script elevates the entire Node.js server process to Administrator.
REM All HTTP endpoints (including /delete) will run with admin rights.
REM The server binds to 127.0.0.1 only to mitigate LAN exposure.
powershell -NoProfile -File "%~dp0launch-admin.ps1"
