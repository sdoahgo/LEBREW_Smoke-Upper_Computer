@echo off
setlocal
cd /d "%~dp0"
set "URL=http://127.0.0.1:8767/app.html"

rem ---- If port 8767 is already listening, the server is running; just open the page ----
netstat -ano | findstr ":8767" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo NOTE: port 8767 is busy - a server from an OLD folder may still be running.
    echo       If the page shows an old version, run stop_server.cmd first, then this script again.
    goto open
)

rem ---- Start the local server in a hidden window (keeps running after this window closes) ----
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0start_demo.ps1','-Page','app.html','-Port','8767','-NoOpen' -WindowStyle Hidden"
echo Starting local server...
timeout /t 2 >nul

:open
rem ---- Prefer Chrome, then Edge (Web Bluetooth / Web Serial need Chrome or Edge) ----
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%URL%"
    goto done
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%URL%"
    goto done
)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "%URL%"
    goto done
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" "%URL%"
    goto done
)
rem ---- Fallback: system default browser ----
start "" "%URL%"

:done
echo.
echo Upper computer ready: %URL%
echo Refresh the page if it is blank for 1-2 seconds.
echo To stop the server, kill the extra PowerShell process in Task Manager.
pause
