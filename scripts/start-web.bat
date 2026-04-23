@echo off
REM Start TradingAI web UI + server
REM Run this from the repo root: scripts\start-web.bat

cd /d "%~dp0.."

echo Installing dependencies...
call pnpm install

echo Building packages...
call pnpm --filter @trading-app/shared build
call pnpm --filter @trading-app/engine build
call pnpm --filter @trading-app/server build

echo Starting trading server on http://localhost:4242 ...
start "TradingAI Server" cmd /k "node packages\server\dist\index.js"

echo Waiting 4 seconds for server to be ready...
timeout /t 4 /nobreak >nul

echo Starting web UI on http://localhost:1420 ...
start "TradingAI UI" cmd /k "pnpm --filter desktop vite:dev"

echo.
echo ======================================================
echo   TradingAI is starting!
echo   Open your browser at: http://localhost:1420
echo ======================================================
echo.
echo Close the two terminal windows to stop.
pause
