#!/usr/bin/env bash
# Start the trading server + web UI (no Rust/Tauri required).
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

echo "==> Starting trading server on http://localhost:4242 ..."
node packages/server/dist/index.js &
SERVER_PID=$!

echo "==> Waiting for server to be ready..."
until curl -sf http://localhost:4242/api/health >/dev/null 2>&1; do sleep 1; done
echo "    Server is up."

echo "==> Starting web UI on http://localhost:1420 ..."
pnpm --filter desktop vite:dev &
UI_PID=$!

echo ""
echo "======================================================"
echo "  TradingAI is running!"
echo "  Open: http://localhost:1420"
echo "======================================================"
echo ""
echo "Press Ctrl+C to stop both processes."

cleanup() {
  echo "Stopping..."
  kill "$SERVER_PID" "$UI_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait "$SERVER_PID" "$UI_PID"
