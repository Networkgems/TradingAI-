@echo off
REM Start TradingAI web UI + server (with pm2 for auto-restart)
REM Run this from the repo root or double-click

cd /d "%~dp0.."

echo Installing dependencies...
call pnpm install

echo Building packages...
call pnpm --filter @trading-app/shared build
call pnpm --filter @trading-app/engine build
call pnpm --filter @trading-app/server build

echo Starting trading server via pm2 (auto-restart enabled)...
call npx pm2 delete trading-server 2>nul
call npx pm2 start ecosystem.config.cjs
call npx pm2 save

echo Waiting for server to be ready...
timeout /t 5 /nobreak >nul

echo Starting web UI on http://localhost:1420 ...
start "TradingAI UI" cmd /k "pnpm --filter desktop vite:dev"

echo.
echo ======================================================
echo   TradingAI is running!
echo   Dashboard: http://localhost:1420
echo   Server:    http://localhost:4242/api/health
echo.
echo   Server is managed by pm2 (auto-restarts on crash).
echo   To stop server: npx pm2 stop trading-server
echo   To view logs:   npx pm2 logs trading-server
echo ======================================================
echo.
pause
