#!/usr/bin/env bash
# Start the trading server + web UI (no Rust/Tauri required).
# Server is managed by pm2 and auto-restarts on crash.
# Usage: bash scripts/start-web.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

cd "$ROOT"

echo "==> Installing dependencies..."
pnpm install

echo "==> Building packages..."
pnpm --filter @trading-app/shared build
pnpm --filter @trading-app/engine build
pnpm --filter @trading-app/server build

echo "==> Starting trading server via pm2 (auto-restart enabled)..."
npx pm2 delete trading-server 2>/dev/null || true
npx pm2 start ecosystem.config.cjs
npx pm2 save

echo "==> Waiting for server to be ready..."
until curl -sf http://localhost:4242/api/health >/dev/null 2>&1; do sleep 1; done
echo "    Server is up: $(curl -s http://localhost:4242/api/health)"

echo "==> Starting web UI on http://localhost:1420 ..."
pnpm --filter desktop vite:dev &
UI_PID=$!

echo ""
echo "======================================================"
echo "  TradingAI is running!"
echo "  Dashboard: http://localhost:1420"
echo "  Server:    http://localhost:4242/api/health"
echo ""
echo "  Server is managed by pm2 (auto-restarts on crash)."
echo "  To stop server: npx pm2 stop trading-server"
echo "  To view logs:   npx pm2 logs trading-server"
echo "======================================================"
echo ""
echo "Press Ctrl+C to stop the web UI (server keeps running via pm2)."

cleanup() {
  echo "Stopping web UI..."
  kill "$UI_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait "$UI_PID"
