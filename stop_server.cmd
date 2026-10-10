@echo off
rem stop_server.cmd - Stop the hidden local server (start_demo.ps1).
rem Closing the terminal does NOT stop it; netstat shows PID 4 (http.sys),
rem so match the powershell process by command line instead of by port.
set MSYSTEM=
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*start_demo.ps1*' } | ForEach-Object { Write-Host ('Stopping PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"
echo.
echo Done. Old server stopped (if any). Now run start_server.cmd again.
pause
