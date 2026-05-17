# Architecture

Spun out of the TRA-402 review (§6 — "no architecture diagram"). This document
explains how the layers fit together and how to extend the system with a new
strategy.

## 1. Big picture

TradeAI is a pnpm monorepo. One long-lived Node process (`@trading-app/server`)
hosts the trading engines and serves both a REST API and a WebSocket feed. A
React app (`apps/desktop`) is the only client — it runs either as a native
Tauri window or as a plain web page; both talk to the same server.

```
                       ┌──────────────────────────────────────┐
                       │            apps/desktop               │
                       │   React UI · App.tsx · Login · Tabs    │
                       └───────────────┬──────────────────────┘
                          REST (fetch) │ │ WebSocket (state push)
                                       │ │
        ┌──────────────────────────────▼─▼──────────────────────────────┐
        │                  @trading-app/server (Express)                │
        │                                                                │
        │  HTTP routes ──► per-user UserContext ──► broadcast(state)      │
        │  WS upgrade  ──► token auth ──► per-user broadcast bus          │
        │  Scheduler (60s loop) ──► EOD / archive / alerts / backups      │
        └───────┬───────────────────┬───────────────────┬───────────────┘
                │                   │                   │
       ┌────────▼────────┐ ┌────────▼────────┐ ┌─────────▼─────────┐
       │ @trading-app/   │ │ @trading-app/   │ │ @trading-app/     │
       │ engine          │ │ backtest        │ │ shared            │
       │ strategies,     │ │ walk-forward,   │ │ types & constants │
       │ indicators,     │ │ Monte-Carlo,    │ │ used everywhere   │
       │ broker clients  │ │ replay harness  │ │                   │
       └────────┬────────┘ └─────────────────┘ └───────────────────┘
                │
       ┌────────▼─────────────────────────────────┐
       │ Brokers / data feeds                      │
       │ Tradier (equities + options) · Coinbase   │
       │ (crypto spot + perps) · Alpaca · Yahoo    │
       │ Finance · CoinMarketCap · Twelve Data     │
       └───────────────────────────────────────────┘
```

### Package responsibilities

| Package | Responsibility |
|---|---|
| `@trading-app/shared` | Pure types and constants (`Candle`, `TradeSignal`, threshold constants). No runtime deps; imported by every other package. |
| `@trading-app/engine` | The trading core — strategies, technical indicators, regime detection, the strategy router, risk manager, position manager, and broker order/feed clients. |
| `@trading-app/backtest` | Offline evaluation — walk-forward, Monte-Carlo bootstrap, options replay. Not on the live request path. |
| `@trading-app/server` | Express HTTP + WebSocket server, the per-user engine instances, the market-day scheduler, persistence and backups, observability. |
| `apps/desktop` | React dashboard. Talks to the server only; holds no trading logic. |

Build order is `shared → engine → backtest → server`; `desktop` depends only on
`shared`.

## 2. How HTTP, WebSocket and state interact

This is the part most worth understanding before changing the server.

### Per-user context

Every authenticated user gets a `UserContext` (`packages/server/src/user-context.ts`)
containing their own equity engine, crypto engine, data directory, watchlists
and settings. Contexts are created on signup / admin-create and rebuilt lazily
on first auth. Two users never share engine state.

### The request → state-push cycle

1. **Client sends a REST request.** The React app calls an endpoint such as
   `POST /api/trading/start` or `POST /api/positions/:id/close`. Auth is a
   bearer token (`Authorization: Bearer <token>`) verified by `requireAuth`.
2. **The handler mutates the user's engine.** It looks up the caller's
   `UserContext`, runs the action against `ctx.engine` / `ctx.cryptoEngine`.
3. **The handler broadcasts new state.** Almost every mutating handler ends with
   `broadcastEngineState(ctx)` / `broadcastCryptoState(ctx)`. The REST response
   itself is usually a thin ack (`{ ok: true }`); the *real* result arrives over
   the WebSocket as a fresh state snapshot.
4. **The engine also ticks on its own.** Independently of any request, each
   engine emits `onTick(state)` as candles arrive. The server wires that stream
   straight into the same per-user broadcast, so the dashboard updates live
   without polling.

**Takeaway:** the WebSocket is the source of truth for UI state. REST endpoints
are commands; they confirm receipt and then let the state push carry the
result. When adding an endpoint that changes engine state, broadcast afterwards
or the UI will look stale until the next tick.

### WebSocket protocol

- **Connection:** the client opens `ws://<host>:<port>/?token=<jwt>`. The HTTP
  `upgrade` handler verifies the token *before* completing the handshake and
  rejects with `401` if it fails. The authenticated username is tagged onto the
  socket.
- **Scoping:** `broadcastToUser(username, msg)` sends only to that user's open
  sockets — state and EOD reports never leak across users.
- **Messages (server → client), JSON):**
  | `type` | `payload` |
  |---|---|
  | `state` | Full equity-engine state snapshot. |
  | `crypto_state` | Full crypto-engine state snapshot. |
  | `eod_report` | The latest end-of-day report (sent on connect and at archive time). |
- On connect the server immediately sends one `state`, one `crypto_state` and
  (if present) one `eod_report` so the client renders without waiting for a
  tick. The protocol is currently server-push only; clients do not send
  messages.

### The scheduler

`packages/server/src/scheduler.ts` runs a 1-minute polling loop (no external
cron). It fires:

- the **EOD callback** at 4:05 PM ET on NYSE trading days,
- the **archive callback** at 9:00 PM ET every calendar day,
- the **monitor hook** every 60s, which drives the alert checks.

Trading-day / day-boundary logic must go through the ET-correct date helper in
`scheduler.ts` — deriving a day from a UTC ISO string rolls the day 4–5 hours
early and can drop a risk halt (see TRA-407).

Two more timers run alongside it: a 30-minute `rotateBackups()` snapshot timer,
and the engine tick loops themselves.

### Graceful shutdown

`gracefulShutdown()` is bound to `SIGINT` / `SIGTERM` (re-entrancy guarded). On
a redeploy (a PM2 restart, or a Render redeploy) it finishes the current tick
and closes cleanly within the signal grace window.

## 3. Persistence

All durable state lives under `DATA_DIR` (a persistent volume in prod):

```
$DATA_DIR/
  users.json                       global user registry
  reset-tokens.json                password-reset tokens
  .tra-142-migrated                migration marker
  users/<username>/                per-user trees: trades, settings, watchlist, equity, broker cursors
  backups/<ISO-timestamp>/          30-min snapshots, last 24 kept (~12h)
  logs/                            app.jsonl, errors.jsonl, trade-audit.jsonl, alerts.jsonl, boot-history.jsonl
```

`trade-store.ts` writes the per-user files and, on startup, auto-restores any
missing or corrupt primary file from the most recent backup.

## 4. How to add a strategy

Strategies live in `packages/engine/src/strategies/`. Each is a class that
consumes candles and emits a `TradeSignal` (or `null`). Use an existing one as
the template — `bb-fade.ts` (mean-reversion) or `momentum.ts` (trend) are the
cleanest references.

### Steps

1. **Create the strategy file** — `packages/engine/src/strategies/my-strategy.ts`.
   - Export an `Options` interface for every tunable knob, each with a documented
     default. Do **not** hard-code magic numbers in the class body; the TRA-402
     review specifically flagged in-code constants as an overfitting risk.
   - Export a class whose constructor takes the options and whose evaluation
     method takes recent `Candle[]` and returns `TradeSignal | null`.
   - Compute indicators with the helpers in `packages/engine/src/indicators/`
     (`bollinger`, `rsi`, `adx`, `atr`, …) rather than rolling your own.
   - **No look-ahead.** Only read bars at or before the signal bar — never a bar
     after it. This was a named §4 finding; an expanding-window slice that
     includes future bars silently inflates backtest metrics.

2. **Export it from the engine barrel** — add the class and its `Options` type
   to `packages/engine/src/index.ts` so the server and backtest harness can
   import it.

3. **Register it with the router** — `packages/engine/src/router.ts` dedupes
   strategies that fire on the same bar by priority (`DEFAULT_ROUTER_PRIORITY`).
   Add your strategy's `SignalType` at the correct priority. Higher-priority
   strategies win the tick. If your signal uses a new `SignalType`, add it to
   `@trading-app/shared` first.

4. **Gate it to a validated universe.** The cost model proves several strategies
   are unprofitable on small-cap symbols. Do not let a new strategy fire on
   symbols where its edge is unproven — restrict it via the engine's per-strategy
   universe filter rather than firing everywhere.

5. **Write tests** — add `my-strategy.test.ts` next to the file. Cover: it fires
   when entry conditions are met, it stays silent when they are not, and stop /
   target prices are sane. The existing `*.test.ts` files in that directory show
   the expected shape.

6. **Backtest before shipping defaults.** Run the strategy through the
   `@trading-app/backtest` walk-forward harness on **real** historical data and
   report in-sample vs out-of-sample separately (per the §2 review finding).
   Grid-search any tunable on the train window; report OOS on the test window.
   Do not ship in-sample-tuned constants as production defaults.

### Strategy contract checklist

- [ ] All knobs are constructor options with documented defaults.
- [ ] Indicators come from `engine/src/indicators/`.
- [ ] No bar after the signal bar is read (no look-ahead).
- [ ] Exported from `engine/src/index.ts`.
- [ ] Registered in `router.ts` with a priority.
- [ ] Restricted to a validated symbol universe.
- [ ] Unit tests cover fire / no-fire / stop-target.
- [ ] Walk-forward OOS results recorded before it becomes a default.
