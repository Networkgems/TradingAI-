#!/usr/bin/env bash
# Bootstraps the development environment from scratch.
set -euo pipefail

echo "==> Checking prerequisites..."
command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found — install via: npm i -g pnpm"; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "cargo not found — install Rust via rustup.rs"; exit 1; }

echo "==> Installing JS dependencies..."
pnpm install

echo "==> Building shared packages..."
pnpm --filter @trading-app/shared build
pnpm --filter @trading-app/engine build
pnpm --filter @trading-app/backtest build

echo "==> Done. Run 'pnpm dev' to launch the Tauri dev window."
