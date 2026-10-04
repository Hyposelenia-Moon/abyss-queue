@echo off
rem Double-click friendly wrapper: runs the deploy script with ExecutionPolicy Bypass.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-windows.ps1" %*
echo.
pause
