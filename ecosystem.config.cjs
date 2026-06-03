// TRA-522 — pin the persistence root to an absolute, launch-independent path.
//
// Why: account state (equity, open positions, options, closed history) persists
// under `DATA_DIR`. When `DATA_DIR` is unset, the server falls back to a path
// anchored to its own module — `<repo>/packages/server/data`. The host has two
// repos (`_default/tradingai_repo` and a sibling `~/TradingAI`), so a restart
// launched from a *different* repo / ecosystem file silently loaded a different
// book (the $1,000 -> $26,397 swap). Setting DATA_DIR here makes every restart
// of THIS app resolve to one fixed directory regardless of launch cwd.
//
// `__dirname` is this file's directory, so the path is absolute and stable.
// Override with the `DATA_DIR` env var (e.g. to relocate onto a dedicated
// volume); when overridden it MUST be the same absolute path on every launch —
// that is the canonical store, see ops/bootstrap-trading-server.sh.
// Node accepts forward slashes on every platform, so a template literal keeps
// this absolute and stable without a `require('path')` import.
const DATA_DIR = process.env.DATA_DIR || `${__dirname}/packages/server/data`;

module.exports = {
  apps: [
    {
      name: 'trading-server',
      script: 'packages/server/dist/index.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        PORT: 4242,
        DATA_DIR,
        // TRA-549 — live-broker ownership stand-down. The app is NOT
        // multi-instance safe: two live instances must never run against the
        // same Tradier credentials. Per the TRA-549 decision, the SINGLE owner
        // of live (production) Tradier credentials is the Render service
        // `tradingai-bqb1` (the only publicly-reachable backend; this PM2
        // self-host binds host-local with no reverse proxy and cannot serve the
        // public site). This self-host is therefore hard-pinned to `sandbox` so
        // it can only ever route PAPER orders, even if production TRADIER_* are
        // set out-of-band in the shell env. Do NOT change this to `production`
        // here — if you ever need the self-host to own live trading instead,
        // first de-credential Render bqb1 (see render.yaml header / runbook §1).
        TRADIER_ENV: 'sandbox',
      },
    },
  ],
};
