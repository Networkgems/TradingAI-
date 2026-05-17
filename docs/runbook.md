# Ops Runbook

Spun out of the TRA-402 review (§5 — "no documented backup-recovery / scaling
runbook"). This is the operational guide for running TradeAI in production.

For incident debugging (logs, trace ids, error telemetry) see
[`observability.md`](observability.md) — this runbook covers deploy, backups,
scaling and alert response.

## 1. Production topology

- **Host:** [Render](https://render.com), one `web` service defined in
  [`render.yaml`](../render.yaml) at the repo root.
- **Plan:** `starter` — a single instance. There is **no failover.**
- **Process:** `node packages/server/dist/index.js`, started directly by Render.
  (PM2 / `ecosystem.config.cjs` is for self-hosting, not the Render deploy.)
- **Persistent disk:** 1 GB, mounted at `/data` (`DATA_DIR=/data`). Survives
  redeploys; this is where all user data, backups and logs live.
- **Health check:** Render polls `GET /api/health`; a non-200 blocks the deploy.
- **Port:** the server listens on `$PORT` (default `4242`).

## 2. Deploy procedure

### Standard deploy

1. Merge to `main`. Render auto-deploys from `main` (or trigger a manual deploy
   from the Render dashboard).
2. Render runs the build: `pnpm install --frozen-lockfile && pnpm run web:build`.
3. Render starts `node packages/server/dist/index.js` and polls
   `/api/health` until it returns `{ ok: true }`.
4. The new instance only takes traffic once the health check passes; the old
   instance is then stopped with `SIGTERM`.

### Verify a deploy

```bash
curl -s https://<host>/api/health            # { "ok": true, "time": "..." }
curl -s https://<host>/api/health/storage    # confirm dataDir_exists + backupsCount > 0
```

Then log into the dashboard and confirm a `state` snapshot arrives over the
WebSocket (the UI populates).

### What a redeploy does to running state

- `SIGTERM` triggers `gracefulShutdown()` — the current engine tick finishes and
  the process exits cleanly inside Render's grace window.
- In-flight broker orders are **not** held across the restart; the next
  reconcile pass picks them up. Avoid redeploying during active trading hours
  if it can wait.
- Session tokens **survive** a redeploy — `AUTH_SECRET` is generated once by
  Render (`generateValue: true`) and persisted.

### Rollback

Use Render's **"Rollback to this deploy"** on a previous successful deploy, or
revert the offending commit on `main` and let the auto-deploy run. The
persistent disk is untouched by a rollback, so user data is unaffected. If a
rollback crosses a data-format migration, restore data from a backup taken
before the bad deploy (see §3).

### Environment / secret changes

Broker credentials and all tuning knobs are env vars (`sync: false` in
`render.yaml` — set in the Render dashboard, never committed). Changing one
requires a restart to take effect. The full annotated list is in `render.yaml`.

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

1. Open a shell on the Render instance (Render dashboard → **Shell**).
2. List snapshots — newest last:
   ```bash
   ls -1 /data/backups
   ```
3. Pick a timestamp from *before* the corruption. To restore everything:
   ```bash
   cp -r /data/backups/<timestamp>/* /data/
   ```
   To restore one user only:
   ```bash
   cp -r /data/backups/<timestamp>/users/<username> /data/users/
   ```
4. Restart the service from the Render dashboard.
5. Verify with `GET /api/health/storage` and a dashboard login.

> **Backups are on the same disk.** The 30-min snapshots protect against file
> corruption and bad writes, **not** disk loss. For disaster recovery, copy
> `/data` (or the latest `backups/<ts>/`) off-box periodically — currently a
> manual step; an off-box backup is a known gap.

## 4. Scaling guide

### Current limits

The `starter` plan is **one instance with a 1 GB disk** — fine for a small user
base, paper trading, and a controlled live test. Constraints to watch:

- **Disk (1 GB).** Logs rotate at 10 MB per file; backups keep ~12h of
  snapshots; trade history and option-chain caches grow over time. The
  `disk-near-full` alert fires below `DISK_MIN_FREE_PCT` (10%).
- **CPU / memory.** Every active user runs their own equity + crypto engine in
  the single process. Engine count scales with user count.
- **No horizontal scale.** Engine state and the WebSocket bus are in-process;
  the app is **not** multi-instance safe today. Do not raise the instance count.

### When to scale up

| Symptom | Action |
|---|---|
| `disk-near-full` alert; `health/storage` shows low free space | Prune old option-chain caches; raise disk `sizeGB` in `render.yaml`. |
| Tick loop lagging / high memory under user growth | Move to a larger Render plan (more CPU/RAM) — vertical scale only. |
| Need true HA / horizontal scale | Larger effort: extract engine state to shared storage and add a message bus. Not supported today; scope as a project. |

### Scaling steps (vertical)

1. Edit `render.yaml` — bump `plan` and/or `disk.sizeGB`.
2. Merge to `main`; Render applies it on the next deploy. A disk resize is
   online and non-destructive.
3. Confirm via `GET /api/health/storage`.

## 5. Alert response

Alerts are produced by the scheduler's 60s monitor hook and delivered to
`ALERT_EMAIL` and/or `ALERT_WEBHOOK_URL`. They always land in
`$DATA_DIR/logs/alerts.jsonl` and `GET /api/health/alerts` even with no sink
configured. Each alert key self-throttles (~30 min) so an outage produces one
alert per window.

| Alert | Meaning | First response |
|---|---|---|
| `health-check` | `GET /api/health` stopped returning `{ ok: true }`. | Check Render service status & logs. If the process is down, redeploy / restart. Confirm `/api/health` recovers. |
| `disk-near-full` | Free space on `/data` below 10%. | `GET /api/health/storage` for sizes. Prune old option-chain caches and stale logs; if structurally full, raise `disk.sizeGB` (§4). |
| `restart-storm` | >5 process boots in 10 min — instance is crash-looping. | Read `errors.jsonl` / Render logs for the crash cause (bad deploy, corrupt data, OOM). Roll back the deploy (§2) or restore data (§3). |
| `trade-volume-zero` | No positions opened by 12:00 ET on a stock trading day. | Often benign (no qualifying signals). Confirm data feeds are fresh (`GET /api/health/quotes`) and auto-trading is enabled. Escalate only if feeds are stale. |
| `error-spike` | >25 errors captured in 15 min. | Grep `errors.jsonl` for the dominant error; correlate by `traceId`. See `observability.md`. |

### Triage workflow

1. **`GET /api/health/alerts`** (authenticated) — recent alerts + 15-min error
   count, without shelling into the box.
2. **Logs** — `$DATA_DIR/logs/` (also on Render's log stream). `app.jsonl`,
   `errors.jsonl` are JSON-lines; pipe through `jq`. Query by `traceId`.
3. **Storage** — `GET /api/health/storage` for disk / data-file state.
4. **Feeds** — `GET /api/health/quotes` for market-data freshness.

## 6. Routine operations

| Task | How |
|---|---|
| Tail logs (self-hosted PM2) | `npx pm2 logs trading-server` |
| Tail logs (Render) | Render dashboard → **Logs**, or `$DATA_DIR/logs/*.jsonl` |
| Restart | Render dashboard → **Manual Deploy / Restart**; self-hosted: `npx pm2 restart trading-server` |
| Check health | `curl https://<host>/api/health` |
| Inspect storage | `curl -H 'Authorization: Bearer <token>' https://<host>/api/health/storage` |
| Lock / unlock a user | `POST /api/admin/users/:username/lock` (admin token) |
| Reset a user's password | `POST /api/admin/users/:username/reset-password` (admin token) |

## 7. Known operational gaps

Carried forward from the TRA-402 review — be aware when on call:

- **No off-box backup** — snapshots share the data disk; disk loss loses them.
- **Single instance, no failover** — an instance outage is a full outage.
- **No vendor APM** — error telemetry is a webhook seam (`ERROR_WEBHOOK_URL`),
  not a wired Sentry/Datadog SDK.
- **Self-hosted PM2** stops after 10 restarts; the `restart-storm` alert is the
  in-process proxy for noticing that.
