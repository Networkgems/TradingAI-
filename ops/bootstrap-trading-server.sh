#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap-trading-server.sh — the single supported way to (re)start the
# self-hosted `trading-server` PM2 process.
#
# TRA-522. The demo/live account book persists under DATA_DIR. When DATA_DIR is
# unset the server falls back to `<repo>/packages/server/data`, anchored to the
# *running module's* location. The host carries more than one clone of this repo
# (`_default/tradingai_repo` and a sibling `~/TradingAI`), each with its own
# `packages/server/data`. Launching/restarting from a different clone or working
# directory therefore loaded a *different* book — the silent $1,000 -> $26,397
# snapshot swap.
#
# This script removes that ambiguity by always:
#   1. running from the canonical repo (the directory that contains this script's
#      parent), so `cwd` and the resolved `dist` are deterministic;
#   2. pinning DATA_DIR to one absolute path (overridable, but defaulted to the
#      canonical repo's data dir) and exporting it into the PM2 process env;
#   3. refusing to start when another listener already holds the port — a strong
#      proxy for "a second instance with its own book is already running".
#
# Usage:
#   ops/bootstrap-trading-server.sh              # build (unless --no-build) + (re)start
#   DATA_DIR=/srv/tradingai/data ops/bootstrap-trading-server.sh
#   ops/bootstrap-trading-server.sh --no-build   # skip the build step
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── 1. Canonical repo root = the directory containing this script's parent ────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"
cd "${REPO_ROOT}"

PORT="${PORT:-4242}"
APP_NAME="trading-server"
NO_BUILD=0
[ "${1:-}" = "--no-build" ] && NO_BUILD=1

# ── 2. Canonical, absolute, launch-independent, OUT-OF-TREE DATA_DIR ──────────
# TRA-4896 — the default moved OFF `${REPO_ROOT}/packages/server/data`.
#
# TRA-522 made the path launch-independent, which fixed the swap. But it left the
# book inside the CHECKOUT, and a checkout is disposable: on the self-host it sits
# in an agent scratch tree the harness may re-stage wholesale, and on any host it
# is inside the build bundle a redeploy replaces. `/api/health/durability` has been
# reporting that as `data_dir_ephemeral` — independent of free disk, so no amount
# of pruning (TRA-4854) could ever clear it.
#
# This default MUST agree with `defaultDataDir()` in ecosystem.config.cjs. Two
# copies of a path convention drift, and the one that drifts is the one somebody is
# trusting — the lesson that created packages/server/src/data-dir.ts.
#
# ⚠️ Changing where this points does NOT move the bytes, and a launch against an
# empty DATA_DIR boots an empty book that reads as a quiet window rather than as
# missing data. Run `node ops/relocate-data-dir.mjs` (server stopped) first.
DATA_DIR="${DATA_DIR:-/srv/tradingai/data}"
mkdir -p "${DATA_DIR}"
DATA_DIR="$(cd -- "${DATA_DIR}" >/dev/null 2>&1 && pwd -P)"
export DATA_DIR

echo "[bootstrap] repo root : ${REPO_ROOT}"
echo "[bootstrap] DATA_DIR  : ${DATA_DIR}"
echo "[bootstrap] port      : ${PORT}"

# ── 3. Guard: refuse to start a second instance over an existing listener ─────
# A second `trading-server` (e.g. launched from a sibling clone) would serve a
# different book — the exact failure this script exists to prevent. We only
# proceed if the existing listener (if any) is OUR PM2-managed app being
# restarted; any foreign listener is a hard stop.
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :${PORT} )" 2>/dev/null | grep -q ":${PORT}"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1  # cannot check — assume free, PM2 restart is still idempotent
  fi
}

pm2_has_app() {
  npx --yes pm2 describe "${APP_NAME}" >/dev/null 2>&1
}

if port_in_use && ! pm2_has_app; then
  echo "[bootstrap] ERROR: port ${PORT} is held by a process that is NOT the" >&2
  echo "[bootstrap]        PM2 '${APP_NAME}' app. Refusing to start a second" >&2
  echo "[bootstrap]        instance — it would serve a different account book." >&2
  echo "[bootstrap]        Identify and stop the stray process first:" >&2
  echo "[bootstrap]          ss -ltnp 'sport = :${PORT}'   # or: lsof -iTCP:${PORT} -sTCP:LISTEN" >&2
  exit 1
fi

# ── 4. Build (unless skipped) ─────────────────────────────────────────────────
if [ "${NO_BUILD}" -eq 0 ]; then
  echo "[bootstrap] installing deps + building…"
  pnpm install --frozen-lockfile
  pnpm run web:build
fi

# ── 5. (Re)start under PM2 from the canonical ecosystem file ──────────────────
if pm2_has_app; then
  echo "[bootstrap] restarting ${APP_NAME} (updating env)…"
  npx --yes pm2 restart "${APP_NAME}" --update-env
else
  echo "[bootstrap] starting ${APP_NAME} from ecosystem.config.cjs…"
  npx --yes pm2 start ecosystem.config.cjs
fi

# ── 6. Health check ───────────────────────────────────────────────────────────
echo "[bootstrap] waiting for health…"
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    echo "[bootstrap] healthy — ${APP_NAME} is up on :${PORT} with DATA_DIR=${DATA_DIR}"
    exit 0
  fi
  sleep 1
done

echo "[bootstrap] ERROR: ${APP_NAME} did not report healthy within 30s." >&2
echo "[bootstrap]        Check: npx pm2 logs ${APP_NAME}" >&2
exit 1
