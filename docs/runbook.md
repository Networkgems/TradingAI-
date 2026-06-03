# Ops Runbook

Spun out of the TRA-402 review (§5 — "no documented backup-recovery / scaling
runbook"). This is the operational guide for running TradeAI in production.

For incident debugging (logs, trace ids, error telemetry) see
[`observability.md`](observability.md) — this runbook covers deploy, backups,
scaling and alert response.

## 1. Production topology

> **TRA-547 (CTO update, 2026-06-03) — READ FIRST, supersedes the TRA-444 note
> below on the public-backend question.** The public TradeAI site
> (<https://networkgems.github.io/TradingAI-/>, GitHub Pages) is now served by a
> **live Render backend at `https://tradingai-bqb1.onrender.com`**
> (`wss://tradingai-bqb1.onrender.com` for the WebSocket bus) — verified
> `GET /api/health → {ok:true}` on 2026-06-03. This is the **canonical public
> backend URL**; it is the single hardcoded fallback in
> [`apps/desktop/src/server-url.ts`](../apps/desktop/src/server-url.ts)
> (`PROD_BACKEND_URL`) and the CI `VITE_SERVER_URL` secret. The old name
> `tradingai-server.onrender.com` is **dead (404)** — do not reference it.
>
> ✅ **Live-broker ownership — RESOLVED (TRA-549, CTO decision, 2026-06-03).**
> The app is not multi-instance safe, so exactly one instance may hold live
> (production) Tradier credentials. **Render `tradingai-bqb1` is that single
> owner** — it is the only publicly-reachable backend (it serves the GitHub
> Pages site), whereas the PM2 self-host on `PG-DEVOPS14` (below) binds
> host-local with **no reverse proxy** and cannot be the public live-trading
> instance. The PM2 self-host is therefore **stood down to sandbox-only**:
> `TRADIER_ENV=sandbox` is hard-pinned in
> [`ecosystem.config.cjs`](../ecosystem.config.cjs) (TRA-549), so it can only
> ever route **paper** orders even if production `TRADIER_*` are set out-of-band
> on the host. Set the production `TRADIER_*` pair and `TRADIER_ENV=production`
> **only in the Render dashboard** — never on the PM2 host.
>
> **Gate:** this ownership must hold (or be explicitly re-decided — de-credential
> the loser *first*) before any change flips `LIVE_STRATEGY_PRESET` off
> `no_trade`. To hand live ownership to the PM2 self-host instead, you must
> (1) clear `TRADIER_*` / set `TRADIER_ENV=sandbox` on Render bqb1, (2) drop the
> `TRADIER_ENV: 'sandbox'` pin in `ecosystem.config.cjs`, and (3) update this
> §1, the [`render.yaml`](../render.yaml) header, and the
> [`server-url.ts`](../apps/desktop/src/server-url.ts) note — in one change.
>
> ---
>
> **TRA-444 (CTO decision, 2026-05-17) — historical, see TRA-547 above:**
> production ran **self-hosted under PM2**, not on Render, and the Render service
> that earlier docs named (`https://tradingai-server.onrender.com`) was
> **unprovisioned**. [`render.yaml`](../render.yaml) is retained as a blueprint
> (see its file header). The PM2 operational detail below remains accurate for
> the self-hosted instance; the public backend is now Render bqb1 per TRA-547.

- **Host:** `PG-DEVOPS14` — a single company-operated Windows workstation. The
  server is a self-hosted Node process managed by **PM2**
  ([`ecosystem.config.cjs`](../ecosystem.config.cjs), app name `trading-server`).
  This is the operational instance TRA-438/TRA-441/TRA-442 were verified
  against.
- **Topology:** one instance, engine state and the WebSocket bus in-process.
  There is **no failover** and the app is **not multi-instance safe** — run
  exactly one `trading-server` process (see §4). Never run two instances against
  the **same live broker credentials**: per TRA-549 (note above) live Tradier
  ownership belongs to Render `tradingai-bqb1`, and this PM2 self-host is pinned
  to `TRADIER_ENV=sandbox` so the two never collide on the same live account.
- **Process:** `node packages/server/dist/index.js`, launched by PM2 with
  `NODE_ENV=production`, `autorestart: true`, `restart_delay: 3000`,
  `max_restarts: 10`.
- **Port:** the server listens on `$PORT` (default `4242`) and binds
  host-local on `PG-DEVOPS14`. **No public URL or reverse proxy is provisioned**
  — the operational instance is reachable only on the host itself at
  `http://localhost:4242` (`ws://localhost:4242` for the WebSocket bus). The
  desktop client falls back to `ws://localhost:4242` whenever it is not served
  from a remote origin (see
  [`apps/desktop/src/server-url.ts`](../apps/desktop/src/server-url.ts)). If a
  reverse proxy is added later, record its public URL here.
- **Data dir:** all user data, backups and logs live under `DATA_DIR`.
  [`ecosystem.config.cjs`](../ecosystem.config.cjs) now **sets `DATA_DIR`
  explicitly** to an absolute path anchored to the repo it launches from
  (`<repo>/packages/server/data/`), so a PM2 restart always resolves the **same**
  store regardless of the working directory it was launched from (TRA-522).
  Override `DATA_DIR` in the process environment to relocate onto a dedicated
  volume — recommended for production. **The override MUST be the same absolute
  path on every launch.**
  - ⚠️ **Single canonical launch path (TRA-522).** Start the server **only** via
    [`ops/bootstrap-trading-server.sh`](../ops/bootstrap-trading-server.sh) (or
    `npx pm2 start ecosystem.config.cjs` from the canonical repo). Do **not**
    launch from a second clone (e.g. a sibling `~/TradingAI`): each clone has its
    own `packages/server/data/`, and a restart from the wrong clone silently
    loads a **different account book**. See "Account-snapshot swap (TRA-522)"
    under §6.
- **Auth secret:** the server **refuses to start in production without
  `AUTH_SECRET`** and uses an ephemeral one otherwise (all sessions drop on
  restart). Set a stable `AUTH_SECRET` in the environment. (The Render blueprint
  injected this automatically via `generateValue: true`; self-hosting must
  provide it.)
- **Health check:** `GET /api/health` returns `{ ok: true }`. Poll it after
  every restart/deploy before considering the process healthy.

## 2. Deploy procedure

### Standard deploy (self-hosted PM2)

1. On the production machine, sync the target commit — deploys track `main`:
   `git fetch origin && git checkout main && git pull`.
2. Build: `pnpm install --frozen-lockfile && pnpm run web:build`.
3. Restart the process: `npx pm2 restart trading-server`
   (first run on a fresh box: `npx pm2 start ecosystem.config.cjs`).
4. PM2 keeps the process up via `autorestart`; verify `/api/health` before
   declaring the deploy done. PM2 stops retrying after `max_restarts` (10) — the
   `restart-storm` alert (§5) is the in-process proxy for noticing that.

> **Render alternative (not currently provisioned).** If the company later
> deploys the [`render.yaml`](../render.yaml) blueprint, Render auto-deploys
> from `main`: it runs the build, starts `node packages/server/dist/index.js`,
> and polls `/api/health` until `{ ok: true }` before cutting traffic over.
> Provisioning Render is tracked in TRA-444 and needs dashboard access — do not
> run it alongside the self-hosted instance.

### Verify a deploy

```bash
curl -s http://<host>/api/health            # { "ok": true, "time": "..." }
curl -s http://<host>/api/health/storage    # confirm dataDir_exists + backupsCount > 0
```

Then log into the dashboard and confirm a `state` snapshot arrives over the
WebSocket (the UI populates).

### What a redeploy does to running state

- A PM2 restart sends `SIGINT`/`SIGTERM`, which triggers `gracefulShutdown()` —
  the current engine tick finishes and the process exits cleanly inside the
  signal grace window.
- In-flight broker orders are **not** held across the restart; the next
  reconcile pass picks them up. Avoid redeploying during active trading hours
  if it can wait.
- Session tokens **survive** a restart **only if `AUTH_SECRET` is a stable env
  var** (see §1). With an ephemeral secret every restart logs all users out.

### Rollback

Roll back by checking out the last-good commit and redeploying: on the
production machine `git checkout <good-commit>`, rebuild (step 2 above) and
`npx pm2 restart trading-server`. Or revert the offending commit on `main` and
redeploy. The data dir is untouched by a rollback, so user data is unaffected.
If a rollback crosses a data-format migration, restore data from a backup taken
before the bad deploy (see §3). (On Render: use **"Rollback to this deploy"**.)

### Environment / secret changes

Broker credentials and all tuning knobs are env vars — the annotated list lives
in [`render.yaml`](../render.yaml) (the keys are the same whether self-hosted or
on Render; `sync: false` there just means "set out-of-band, never committed").
For the self-hosted process, set them in the environment PM2 launches with
(shell env, an `env` block in `ecosystem.config.cjs`, or a process-manager
`.env`). Changing one requires a `pm2 restart` to take effect.

## 3. Backup & recovery

### How backups work

- `rotateBackups()` snapshots every file under `DATA_DIR` into
  `$DATA_DIR/backups/<ISO-timestamp>/` **every 30 minutes** (and once on boot).
- The last **24** snapshots are kept (~12 hours); older folders are pruned.
- Backups mirror the live layout: global files at the snapshot root, per-user
  trees under `backups/<ts>/users/<username>/`.

### Automatic recovery

On startup, if a primary file (a user's trades, settings, equity, or
`users.json`) is **missing or corrupt**, `trade-store.ts` automatically restores
it from the most recent backup and logs a `Restored file from backup` warning.
For most single-file corruption, no operator action is needed — just restart.

### Manual recovery

If automatic restore is not enough (e.g. you need an older point in time):

1. Open a shell on the production machine (on Render: dashboard → **Shell**).
2. List snapshots — newest last:
   ```bash
   ls -1 $DATA_DIR/backups
   ```
3. Pick a timestamp from *before* the corruption. To restore everything:
   ```bash
   cp -r $DATA_DIR/backups/<timestamp>/* $DATA_DIR/
   ```
   To restore one user only:
   ```bash
   cp -r $DATA_DIR/backups/<timestamp>/users/<username> $DATA_DIR/users/
   ```
4. Restart the service (`npx pm2 restart trading-server`).
5. Verify with `GET /api/health/storage` and a dashboard login.

> **Backups are on the same disk.** The 30-min snapshots protect against file
> corruption and bad writes, **not** disk loss. For disaster recovery, copy
> `$DATA_DIR` (or the latest `backups/<ts>/`) off-box periodically — currently a
> manual step; an off-box backup is a known gap.

## 4. Scaling guide

### Current limits

The self-hosted single instance is **one process on one machine** — fine for a
small user base, paper trading, and a controlled live test. Constraints to
watch:

- **Disk.** Logs rotate at 10 MB per file; backups keep ~12h of snapshots;
  trade history and option-chain caches grow over time. The `disk-near-full`
  alert fires below `DISK_MIN_FREE_PCT` (10%).
- **CPU / memory.** Every active user runs their own equity + crypto engine in
  the single process. Engine count scales with user count.
- **No horizontal scale.** Engine state and the WebSocket bus are in-process;
  the app is **not** multi-instance safe today. Run exactly one instance.

### When to scale up

| Symptom | Action |
|---|---|
| `disk-near-full` alert; `health/storage` shows low free space | Prune old option-chain caches; attach a larger volume / raise free space on the `DATA_DIR` disk. |
| Tick loop lagging / high memory under user growth | Move the process to a larger machine — vertical scale only. |
| Need true HA / horizontal scale | Larger effort: extract engine state to shared storage and add a message bus. Not supported today; scope as a project. |

### Scaling steps (vertical)

1. Provision a larger machine / bigger volume.
2. Deploy the process there per §2 and migrate `$DATA_DIR` (copy the data dir,
   then start the new instance — never run both at once).
3. Confirm via `GET /api/health/storage`.

(On Render, vertical scale is a `plan` / `disk.sizeGB` bump in `render.yaml`.)

## 5. Alert response

Alerts are produced by the scheduler's 60s monitor hook and delivered to
`ALERT_EMAIL` and/or `ALERT_WEBHOOK_URL`. They always land in
`$DATA_DIR/logs/alerts.jsonl` and `GET /api/health/alerts` even with no sink
configured. Each alert key self-throttles (~30 min) so an outage produces one
alert per window.

| Alert | Meaning | First response |
|---|---|---|
| `health-check` | `GET /api/health` stopped returning `{ ok: true }`. | Check the PM2 process (`npx pm2 status`) and logs. If the process is down, `npx pm2 restart trading-server`. Confirm `/api/health` recovers. |
| `disk-near-full` | Free space on the `DATA_DIR` disk below 10%. | `GET /api/health/storage` for sizes. Prune old option-chain caches and stale logs; if structurally full, attach a larger volume (§4). |
| `restart-storm` | >5 process boots in 10 min — instance is crash-looping. | Read `errors.jsonl` / PM2 logs for the crash cause (bad deploy, corrupt data, OOM). Roll back the deploy (§2) or restore data (§3). Note PM2 gives up after `max_restarts` (10). |
| `trade-volume-zero` | No positions opened by 12:00 ET on a stock trading day. | Often benign (no qualifying signals). Confirm data feeds are fresh (`GET /api/health/quotes`) and auto-trading is enabled. Escalate only if feeds are stale. |
| `error-spike` | >25 errors captured in 15 min. | Grep `errors.jsonl` for the dominant error; correlate by `traceId`. See `observability.md`. |

### Triage workflow

1. **`GET /api/health/alerts`** (authenticated) — recent alerts + 15-min error
   count, without shelling into the box.
2. **Logs** — `$DATA_DIR/logs/` (and `npx pm2 logs trading-server`). `app.jsonl`,
   `errors.jsonl` are JSON-lines; pipe through `jq`. Query by `traceId`.
3. **Storage** — `GET /api/health/storage` for disk / data-file state.
4. **Feeds** — `GET /api/health/quotes` for market-data freshness.

## 6. Routine operations

| Task | How |
|---|---|
| Tail logs | `npx pm2 logs trading-server`, or `$DATA_DIR/logs/*.jsonl` (on Render: dashboard → **Logs**) |
| Restart | `npx pm2 restart trading-server` (on Render: dashboard → **Manual Deploy / Restart**) |
| Check health | `curl http://<host>/api/health` |
| Inspect storage | `curl -H 'Authorization: Bearer <token>' http://<host>/api/health/storage` |
| Lock / unlock a user | `POST /api/admin/users/:username/lock` (admin token) |
| Reset a user's password | `POST /api/admin/users/:username/reset-password` (admin token) |

### Account-snapshot swap on restart (TRA-522)

**Symptom.** After a `trading-server` restart the demo/live book changes
wholesale — equity, open positions, options and closed history all flip to a
different, stale set (observed 2026-06-03: $1,000 → $26,397, QBTS/NVAX/GM →
IREN/ASTC, open options → none). This is **not** drift; it is a *different book*.

**Root cause.** Account state persists under `DATA_DIR`. When `DATA_DIR` is
unset, the server falls back to a path anchored to its own module —
`<repo>/packages/server/data/`. The host carries **two clones** of the repo
(`_default/tradingai_repo` and a sibling `~/TradingAI`, each with its own
`ecosystem.config.cjs` using `cwd: __dirname`). A restart launched from the
*other* clone / ecosystem file therefore reads that clone's
`packages/server/data/` — a different snapshot — and the live book becomes
invisible (it is not lost, just not loaded).

**Fix (shipped).** `ecosystem.config.cjs` now sets `DATA_DIR` explicitly, and
`trade-store.resolveDataDir()` guarantees the path is launch-cwd independent
(regression: `packages/server/src/data-dir-persistence.test.ts`). Start the
server only from the canonical path via
[`ops/bootstrap-trading-server.sh`](../ops/bootstrap-trading-server.sh).

**If it recurs — confirm a second instance / wrong clone:**

```bash
npx pm2 jlist | npx --yes json -a name pm_cwd                 # PM2 cwd per app
npx pm2 describe trading-server | grep -E 'cwd|exec cwd|script'
# Any second listener on :4242 (a parallel instance)?
ss -ltnp 'sport = :4242'      # Linux
netstat -ano | findstr :4242  # Windows
# Which data dir did the live process actually resolve?
grep -F 'DATA_DIR resolved' "$DATA_DIR/logs/"*.jsonl | tail -1
ls -1d ~/TradingAI/packages/server/data ~/_default/*/packages/server/data 2>/dev/null
```

Recovery: stop the stray/duplicate process, relaunch the single instance from
the canonical path, and confirm `/api/state` shows the expected book. If the
wrong clone overwrote nothing (it never does — it writes only its own dir), the
live book is intact under the canonical `DATA_DIR`; no data restore is needed.

## 7. Known operational gaps

Carried forward from the TRA-402 review — be aware when on call:

- **No off-box backup** — snapshots share the data disk; disk loss loses them.
- **Single instance, no failover** — an instance outage is a full outage.
- **No vendor APM** — error telemetry is a webhook seam (`ERROR_WEBHOOK_URL`),
  not a wired Sentry/Datadog SDK.
- **PM2 stops after 10 restarts** (`max_restarts`); the `restart-storm` alert is
  the in-process proxy for noticing that.
- **No external access path** — the instance binds host-local on `PG-DEVOPS14`
  with no reverse proxy, so it can only be reached from the host itself.
  Recorded in §1 (closes the TRA-444 / TRA-447 documentation follow-up).
