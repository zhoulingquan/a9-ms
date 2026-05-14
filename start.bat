@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ====================================
echo  A9 Marketing System
echo ====================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found! Please install Node.js v18+ from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules" (
    echo [INFO] First launch - installing dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Dependency installation failed.
        pause
        exit /b 1
    )
    echo [INFO] Dependencies installed.
)

echo [INFO] Starting server...

:: Start server in a separate minimized window (independent of this window)
start "" /MIN node server.js

:: Wait for server to start
echo Waiting for server to start...
timeout /t 2 /nobreak >nul

:: Open default browser
start http://localhost:3000

echo.
echo ====================================
echo  Server is running at http://localhost:3000
echo ====================================
echo.
echo  Press any key to close this window.
echo  The server will keep running in background.
echo  Use stop.bat to stop the server.
echo.
pause >nul
exit
