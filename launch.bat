@echo off
setlocal
title Lyria 3 Pro
cd /d "%~dp0"

echo.
echo  ============================================
echo    LYRIA 3 PRO
echo  ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  [X] Node.js not found. Install it from https://nodejs.org and run install.bat first.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo  [!] Dependencies missing - running installer first...
    call npm install
    if errorlevel 1 (
        echo  [X] npm install failed. See output above.
        pause
        exit /b 1
    )
)

if not exist ".env.local" (
    copy ".env.example" ".env.local" >nul
    echo  [!] Created .env.local - no API key set yet.
    echo      Add GEMINI_API_KEY there, or use the in-app Settings ^(gear icon^).
    echo.
)

echo  Starting server on http://localhost:3001 ...
echo  Close this window ^(or press Ctrl+C^) to stop.
echo.

REM Open the browser once the server is up
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3001"

call npm run dev
pause
