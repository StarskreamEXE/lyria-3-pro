@echo off
setlocal
title Lyria 3 Pro - Installer
cd /d "%~dp0"

echo.
echo  ============================================
echo    LYRIA 3 PRO - INSTALLER
echo  ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  [X] Node.js not found. Install it from https://nodejs.org and run this again.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo  [OK] Node.js %%v found

echo.
echo  Installing dependencies...
call npm install
if errorlevel 1 (
    echo  [X] npm install failed. See output above.
    pause
    exit /b 1
)
echo  [OK] Dependencies installed

if not exist ".env.local" (
    copy ".env.example" ".env.local" >nul
    echo  [OK] Created .env.local
    echo.
    echo  NOTE: Add your Gemini API key to .env.local ^(GEMINI_API_KEY=...^)
    echo        or set it later in the app's Settings ^(gear icon^).
) else (
    echo  [OK] .env.local already exists
)

echo.
echo  ============================================
echo    Install complete. Run launch.bat to start.
echo  ============================================
echo.
pause
