@echo off
cd /d "%~dp0"

echo ====================================
echo  A9 Marketing System - Stop Server
echo ====================================
echo.

taskkill /f /im node.exe 2>nul

if %ERRORLEVEL% equ 0 (
    echo [OK] Server stopped.
) else (
    echo [INFO] No running server found.
)

echo.
pause
