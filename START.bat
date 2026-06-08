@echo off
chcp 65001 >nul
title VELIST Bot
color 0A

echo.
echo  ========================================
echo    VELIST Discord Bot - Launcher
echo  ========================================
echo.

cd /d "%~dp0"

REM ── Check Node.js ──────────────────────────────────────────────────────────
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is not installed!
    echo.
    echo  Please install Node.js from: https://nodejs.org
    echo  Download the LTS version, install it, then run this bat again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo  [OK] Node.js %NODE_VER% detected

REM ── Check .env ─────────────────────────────────────────────────────────────
if not exist ".env" (
    echo.
    echo  [ERROR] .env file not found!
    echo.
    echo  Copy .env.example to .env and fill in your credentials:
    echo    - DISCORD_TOKEN
    echo    - DISCORD_CLIENT_ID
    echo    - DISCORD_GUILD_ID
    echo    - DISCORD_CHANNEL_ID
    echo    - ALCHEMY_API_KEY
    echo.
    pause
    exit /b 1
)
echo  [OK] .env file found

REM ── Install dependencies ────────────────────────────────────────────────────
if not exist "node_modules" (
    echo.
    echo  [INFO] node_modules not found - installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo  [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo  [OK] Dependencies installed
) else (
    echo  [OK] node_modules exists
)

REM ── Install Puppeteer Chrome ────────────────────────────────────────────────
REM Only install if chrome executable is not present
set CHROME_FOUND=0
for /r "node_modules\.cache" %%f in (chrome.exe) do set CHROME_FOUND=1
for /r "%USERPROFILE%\.cache\puppeteer" %%f in (chrome.exe) do set CHROME_FOUND=1
for /r "%LOCALAPPDATA%\puppeteer" %%f in (chrome.exe) do set CHROME_FOUND=1

if %CHROME_FOUND% == 0 (
    echo.
    echo  [INFO] Installing Puppeteer Chrome browser (one-time, ~150MB)...
    call npx puppeteer browsers install chrome
    if %errorlevel% neq 0 (
        echo  [WARN] Chrome install had issues - bot may still work without it
    ) else (
        echo  [OK] Chrome installed
    )
) else (
    echo  [OK] Puppeteer Chrome found
)

REM ── Create required folders ─────────────────────────────────────────────────
if not exist "output" mkdir output
if not exist "data" mkdir data
if not exist "logs" mkdir logs

REM ── Launch bot ──────────────────────────────────────────────────────────────
echo.
echo  ========================================
echo    Starting VELIST Bot...
echo    Press Ctrl+C to stop
echo  ========================================
echo.

node src/bot.js

echo.
echo  Bot stopped. Press any key to exit.
pause >nul
