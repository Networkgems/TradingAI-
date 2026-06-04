# Observability — logging, error telemetry & alerting

TRA-406 (Phase 1 of the TRA-402 review). This is the runbook for debugging a
production incident on TradeAI.

## TL;DR for an incident

1. A user reports a failed action and quotes a **trace id** (the
   `X-Trace-Id` header / the `traceId` in a 500 response body).
2. `grep '"traceId":"<id>"' <DATA_DIR>/logs/app.jsonl` — every log line for that
   request.
3. `grep '"traceId":"<id>"' <DATA_DIR>/logs/errors.jsonl` — the exception(s),
   with stack and structured context.
4. `GET /api/health/alerts` (authenticated) — recent alerts + 15-min error count.

All log files are JSON-lines; pipe through `jq` for anything non-trivial.

## What gets written, and where

Files live under `<LOG_DIR>` — `LOG_DIR` env var, defaulting to
`<DATA_DIR>/logs` so they land on the Render persistent disk. Each file
rotates to `<name>.1` once it passes 10 MB.

| File | Contents |
|---|---|
| `app.jsonl` | Every structured log line (also mirrored to stdout). |
| `errors.jsonl` | Captured exceptions — dedicated, queryable error stream. |
| `trade-audit.jsonl` | Append-only who/what/when for every position open & close. |
| `alerts.jsonl` | Every operational alert that fired. |
| `boot-history.jsonl` | One line per process boot — feeds the restart-storm alert. |

stdout/stderr carry the same JSON, so Render's log stream and PM2 logs are
also queryable; the on-disk files are the box-local backstop for a log-stream
gap.

## Structured logging

`packages/server/src/observability/logger.ts`. Use it instead of `console.*`:

```ts
import { logger } from './observability/index.js';
const log = logger.child({ module: 'my-feature' });
log.info('did the thing', { symbol: 'BTC-USD', qty: 3 });
log.warn('degraded', { reason: err.message });
```

Every record carries `ts`, `level`, `msg`, plus the active request's `traceId`
and `user` automatically (see trace correlation below). `LOG_LEVEL` (`debug` →
`error`, default `info`) gates what is emitted.

## Trace correlation

`trace.ts` opens an `AsyncLocalStorage` trace per HTTP request
(`traceMiddleware`). The id is:

- honoured from an inbound `X-Trace-Id` header if the client sent one;
- echoed on the `X-Trace-Id` response header;
- stamped onto every log line and captured error for that request;
- returned in the body of a 500 response (`{ "traceId": "..." }`).

Background jobs can open their own trace with `runWithTrace({}, fn)`.

## Error telemetry

`errors.ts`. `captureException(err, scope, context?)` writes a structured
record to `errors.jsonl`, logs it at `error` level, and — if `ERROR_WEBHOOK_URL`
is set — POSTs it to that endpoint. The webhook is the integration seam for a
real Sentry/Datadog ingest proxy or a Slack channel; no vendor SDK is bundled,
so wiring an actual Sentry DSN is a config-only follow-up (point a thin proxy
at the DSN, or use Sentry's `envelope` HTTP endpoint behind the webhook URL).

`installGlobalErrorHandlers()` (called at startup) captures `uncaughtException`
(then exits so PM2 restarts a clean process) and `unhandledRejection`.
`errorMiddleware` is mounted last in the Express stack.

## Trade audit log

`audit.ts`. A `TradeAuditTracker` per user-engine diffs successive engine
states off the existing `onTick` stream: a position id entering `openPositions`
is an `open`, one leaving it is a `close`. This covers automated and manual
trades, demo and live, without touching engine internals. Pre-existing
positions at boot are not re-audited as fresh opens.

## Alerting

`alerts.ts`, driven by the scheduler's `onMonitor` hook (every 60s). Each alert
key throttles itself (`ALERT_THROTTLE_MS`, default 30 min) so a sustained
outage produces one alert per window, not one per minute.

| Alert key | Fires when |
|---|---|
| `health-check` | `GET /api/health` stops returning `{ ok: true }`. |
| `disk-near-full` | Free space on the data disk drops below `DISK_MIN_FREE_PCT` (10%). |
| `restart-storm` | More than `MAX_BOOTS_PER_WINDOW` (5) process boots in 10 min — the in-process proxy for PM2 approaching `max_restarts: 10`. |
| `trade-volume-zero` | No positions opened by 12:00 ET on a stock-market trading day. |
| `error-spike` | More than `ERROR_SPIKE_THRESHOLD` (25) errors captured in 15 min. |

Delivery is best-effort to two optional sinks: email (`ALERT_EMAIL`,
comma-separated, via the existing SMTP config) and a webhook
(`ALERT_WEBHOOK_URL`). With neither configured, alerts still land in
`alerts.jsonl`, the logs, and `GET /api/health/alerts`.

### Verifying an alert fires

`runHealthCheck` accepts an injected probe — the test suite
(`observability.test.ts`) simulates a health-check failure with
`runHealthCheck(async () => false)` and asserts a `health-check` alert is
raised. To exercise it against a live box, stop the server and confirm the
next monitor tick logs `ALERT health-check`.

## Environment variables

All optional — defaults are listed in `render.yaml`.

| Var | Purpose |
|---|---|
| `LOG_LEVEL` | `debug`/`info`/`warn`/`error` (default `info`). |
| `LOG_DIR` | Log directory (default `<DATA_DIR>/logs`). |
| `ERROR_WEBHOOK_URL` | HTTPS sink for captured errors. |
| `ALERT_EMAIL` | Comma-separated ops alert recipients. |
| `ALERT_WEBHOOK_URL` | HTTPS sink for operational alerts. |
| `ALERT_THROTTLE_MS` | Per-key alert throttle (default 1800000). |
| `DISK_MIN_FREE_PCT` | Disk-free % alert threshold (default 10). |
| `MAX_BOOTS_PER_WINDOW` | Restart-storm threshold (default 5 / 10 min). |
| `ERROR_SPIKE_THRESHOLD` | Errors-per-15-min alert threshold (default 25). |

## Live-equity acceptance probe (TRA-580)

`GET /api/health/live-equity` is an **unauthenticated, read-only** probe (parity
with `GET /api/health/version`) that proves the first organic **production**
Tradier equity OTOCO bracket fired correctly — without shipping broker
credentials into a dev/agent env. It enumerates every engine and returns ONLY
booleans / counts / timestamps; **never** a symbol, quantity, price, order id,
account id, or balance.

```bash
curl -s https://<deployment>/api/health/live-equity | jq
```

Maps to the four TRA-580 acceptance lines:

| Field | Acceptance line |
| --- | --- |
| `totals.liveSignals` / `liveEngineCount` | 1 — a signal fired in `mode:live`. |
| `totals.liveEquityBracketsWithBothLegs` | 2 — OTOCO has paired OCO TP + SL legs. |
| `totals.liveEquityMirrorsWithOrderId`, `lastLiveEquityFillAt` | 3 — engine mirrored the Tradier fill (`mode:live`). |
| `totals.liveSkipReasons` | 4 — broker rejects surface (not silently dropped). |

`firstLiveEquityFillConfirmed` is the headline bit: `true` once any engine has a
mirror carrying both OCO legs **and** a captured order id. `productionEngineCount`
confirms the reading is against a `production`-env engine, not sandbox.

## Known follow-ups

- Desktop-app (Electron) error telemetry — tracked separately; the renderer
  and main process need their own capture wired to the same webhook.
- Migrating the remaining ~320 `console.*` calls and ~45 bare `catch {}`
  blocks to the structured logger — mechanical sweep, tracked separately. The
  critical broker/feed paths (Coinbase feed, Tradier smart open/close) were
  done as part of TRA-406.
