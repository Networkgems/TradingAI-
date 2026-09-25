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
// TRA-4896 — the default is no longer anchored to `__dirname`, and that is the
// whole point of this block.
//
// TRA-522 pinned DATA_DIR to ONE path so two repos could not serve two books.
// That fixed the swap, but it pinned it to a path INSIDE the checkout, and on
// this self-host the checkout is
// `~/.paperclip/instances/default/projects/<company>/<project>/_default/tradingai_repo`
// — the Paperclip per-project scratch tree, which the harness may re-stage
// wholesale between runs. So the book was stable across restarts and erasable by
// an event no restart, no deploy record and no health field mentions. That is the
// same re-stageability TRA-4851 had to defend the PM2 boot path against, and it
// is why `/api/health/durability` read `ok:false` with `data_dir_ephemeral` on
// this box regardless of free disk (the disk axis was TRA-4854; they are
// independent and only the disk one is fixable by pruning).
//
// The default is therefore a machine-wide service-state path OUTSIDE every
// checkout and every agent scratch tree, resolved per-platform:
//   win32 → %ProgramData%\TradingAI\data   (SYSTEM- and user-writable; the PM2
//           daemon here is elevation-locked, so the location has to work for
//           BOTH owners, which a user-profile path does not)
//   posix → /srv/tradingai/data            (matches ops/bootstrap-trading-server.sh)
//
// `DATA_DIR` still wins verbatim when set, and when set it MUST be the same
// absolute path on every launch — that is the canonical store, see
// ops/bootstrap-trading-server.sh and docs/runbook.md §1.
//
// ⚠️ Changing this default does NOT move the bytes. A launch against a fresh,
// empty DATA_DIR boots a fresh, empty book — the TRA-522 swap in the other
// direction, and worse, because an empty multi-session ledger reads as a quiet
// window rather than as missing data. Run `node ops/relocate-data-dir.mjs`
// (server STOPPED) before the first launch on a new default.
//
// Node accepts forward slashes on every platform, so a template literal keeps
// this absolute and stable without a `require('path')` import.
function defaultDataDir() {
  if (process.platform === 'win32') {
    const programData = (process.env.ProgramData || 'C:\\ProgramData').replace(/\\/g, '/');
    return `${programData}/TradingAI/data`;
  }
  return '/srv/tradingai/data';
}

const DATA_DIR = process.env.DATA_DIR && process.env.DATA_DIR.trim()
  ? process.env.DATA_DIR
  : defaultDataDir();

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
        // TRA-1270 (parent TRA-1250) — enable the board-approved exit-side
        // loss-control rules (ATR chandelier + per-trade profit-lock + book
        // give-back cap / session stop). Rules approved via TRA-1249
        // (request_confirmation `d7175f7e`); threshold parity signed off by
        // QuantTrader (TRA-1307). This self-host is TRADIER_ENV=sandbox, so the
        // give-back guard only ever flattens/halts the PAPER book here.
        // NOTE: the SYSTEM-owned PM2 daemon reads this env only on a fresh
        // `pm2 start ecosystem.config.cjs` (delete+start or reboot→resurrect);
        // a plain restart / `/api/admin/restart` re-execs with the SAVED env and
        // will NOT pick this up. Accepts 1/true/yes/on.
        EXIT_RISK_RULES_ENABLED: '1',
      },
    },
  ],
};
