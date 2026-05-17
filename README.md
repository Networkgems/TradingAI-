# TradeAI

A multi-asset auto-trading platform — equities, crypto spot, crypto perps and
options — built as a TypeScript monorepo. A long-running Node server runs the
signal/strategy engines and broker integrations; a React desktop app (Tauri or
plain web) is the dashboard.

> **Status:** strong research / paper-trading engine with live broker plumbing.
> Treat live-capital trading as experimental — see the [TRA-402 review](docs/)
> for the honest profitability and reliability assessment.

---

## Repository layout

```
apps/
  desktop/            React + Vite dashboard, packaged with Tauri (also runs as a plain web app)
packages/
  shared/             Cross-cutting types & constants (@trading-app/shared)
  engine/             Signal generation, strategies, indicators, broker order clients (@trading-app/engine)
  backtest/            Walk-forward / Monte-Carlo backtesting harnesses (@trading-app/backtest)
  server/             Express HTTP + WebSocket server, schedulers, persistence (@trading-app/server)
docs/                 Architecture, ops runbook, API spec, cost model, observability
scripts/              Dev-setup, web-start, smoke and one-off research scripts
ecosystem.config.cjs  PM2 process definition for the production server
render.yaml           Render.com deployment blueprint
```

Build dependency order: `shared` → `engine` → `backtest` → `server`; `desktop`
depends only on `shared`.

## Prerequisites

- **Node 20.x** (see `.node-version`) and **pnpm ≥ 9** (`npm i -g pnpm`).
- **Rust + cargo** (via [rustup](https://rustup.rs)) — only needed to build the
  native Tauri desktop binary. The web UI does not need it.

## Quick start (web UI — no Rust required)

```bash
git clone https://github.com/Networkgems/TradingAI-.git
cd TradingAI-
bash scripts/start-web.sh
```

`start-web.sh` installs dependencies, builds the packages, starts the server
under PM2 (auto-restart on crash), waits for `/api/health`, and launches the
Vite dev server. When it finishes:

- Dashboard: <http://localhost:1420>
- Server / health: <http://localhost:4242/api/health>

The server keeps running under PM2 after you stop the UI (`Ctrl+C`). Stop it
with `npx pm2 stop trading-server`; tail logs with `npx pm2 logs
trading-server`.

### Manual web start

```bash
pnpm install
pnpm web:dev          # runs the server + the Vite UI together via concurrently
```

## Quick start (native desktop app)

```bash
bash scripts/dev-setup.sh   # checks prereqs, installs deps, builds shared packages
pnpm dev                    # launches the Tauri dev window
```

## First login

The server seeds an `admin` account on first boot. Set its password with the
`ADMIN_PASSWORD` environment variable before the first start (otherwise check
the boot logs). New users can self-register from the sign-up screen; each user
gets an isolated per-user engine, equity, trade history and settings.

## Common commands

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies. |
| `pnpm web:dev` | Server + web UI together (dev). |
| `pnpm dev` | Tauri desktop dev window. |
| `pnpm server:dev` | Server only, watched (`tsx`). |
| `pnpm typecheck` | Build the `@trading-app/*` packages and run `tsc` everywhere. |
| `pnpm lint` | ESLint with `--max-warnings 0`. |
| `pnpm test` | Run every package's test suite (Vitest). |
| `pnpm web:build` | Production build of packages + web bundle. |
| `pnpm render-build` | Full production build used by Render. |

## Configuration

The server reads all configuration from environment variables. The complete,
annotated list is in [`render.yaml`](render.yaml). The essentials:

| Var | Purpose |
|---|---|
| `PORT` | HTTP/WS port (default `4242`). |
| `DATA_DIR` | Persistent data root — **must** be a durable volume in production. |
| `AUTH_SECRET` | HMAC signing key for session tokens. Render generates & persists it. |
| `AUTH_TOKEN_TTL_HOURS` | Session-token max lifetime (default 24h). |
| `ADMIN_PASSWORD` | Initial admin password. |
| `TRADIER_*`, `CMC_API_KEY`, `TWELVE_DATA_API_KEY` | Broker & market-data API credentials. |
| `LOG_LEVEL`, `ERROR_WEBHOOK_URL`, `ALERT_EMAIL`, `ALERT_WEBHOOK_URL` | Observability — see [`docs/observability.md`](docs/observability.md). |

Without broker credentials the platform still runs in demo / paper mode; only
live order routing is disabled.

## Documentation

| Doc | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | How the HTTP / WebSocket / engine layers interact; how to add a strategy. |
| [`docs/runbook.md`](docs/runbook.md) | Deploy, backup recovery, scaling, alert response. |
| [`docs/openapi.yaml`](docs/openapi.yaml) | OpenAPI 3 spec for the server REST API. |
| [`docs/observability.md`](docs/observability.md) | Structured logging, error telemetry, alerting. |
| [`docs/cost-model.md`](docs/cost-model.md) | Transaction-cost model and per-asset strategy economics. |

## Deployment

The server deploys to [Render](https://render.com) from
[`render.yaml`](render.yaml) as a single `web` service with a 1 GB persistent
disk mounted at `/data`. See [`docs/runbook.md`](docs/runbook.md) for the deploy
procedure, rollback, backup recovery and scaling guidance.
