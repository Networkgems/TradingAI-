# Market data fixes and the CORE paper runner

This change fixes four data problems and adds a sandbox paper runner for CORE (the SPY put credit spread).

## 1. Option chains come from production market data

**Problem.** The PM2 host pins `TRADIER_ENV=sandbox` so that it can only place paper orders. The chain reader followed that pin. Tradier's sandbox data is **15 minutes delayed and has no greeks or IV**, while equity quotes on the same host are real-time production. So the scanners compared a live stock price with a 15-minute-old option chain.

**Fix.** Set `TRADIER_MARKET_DATA_TOKEN` (the production key) and chains are read from production. Orders are untouched: the scanner client only calls `/markets/options/expirations` and `/markets/options/chains`.

| Env | Effect |
|---|---|
| `TRADIER_MARKET_DATA_TOKEN` | Read chains from production (new default when set). |
| `TRADIER_CHAINS_ENV=sandbox` | Opt out and keep the old behaviour. |
| `TRADIER_CHAIN_BUDGET_PER_MIN` | Caps upstream chain and expiration calls per minute. Default **20** when chains share the production token, because Tradier allows 120 req/min per token and quotes plus timesales already use about 90. `none` removes the cap. Calls over the budget report `quota_held`, counted under `chainBudget` in the scanner diagnostics. |

**Verify.**

- The boot log line `rv-scanner initialized` shows `chainsEnv`, `chainsSource` and `chainBudgetPerMin`.
- The scanner diagnostics show `marketData.env`.

## 2. Greeks age is now checked

**Problem.** Tradier refreshes greeks once an hour (ORATS), and the app never read `greeks.updated_at`. OTM "mispricing" was mostly the market having moved since ORATS last fitted the surface. The test `tradier-data-freshness.test.ts` reproduces this: an hour-stale σ produces false signals, and the live σ removes them.

**Fix.**

- `updated_at` is parsed into `greeksUpdatedMs` on each chain row.
- When vendor greeks are older than the limit, or missing (sandbox), the OTM theo uses σ solved from the neighbouring strikes' **current** mids.
- Each candidate carries `ivSource` and `greeksAgeMs`.

| Env | Effect |
|---|---|
| `OTM_MAX_GREEKS_AGE_MIN` | Default `90`. `none` restores the old behaviour (age ignored). |
| `OTM_THEO_IV_SOURCE=live` | Always use the locally solved σ. |
| `TRADIER_GREEKS_UPDATED_AT_TZ` | Default `America/New_York`. Tradier sends a naive timestamp with no zone. If the observed `greeksAgeMs` reads about 4–5 hours too young or negative, set this to `UTC`. |

This changes which σ prices theo. It does not change which gate admits a trade.

## 3. Real-time quotes from the stream

**Problem.** Quotes refresh every 20–30 seconds over REST. The `/markets/events` WebSocket existed but only fed a status page.

**Fix.** With `ENABLE_TRADIER_STREAM=1`, stream ticks are written into the shared quote cache.

- Subscribed symbols (25 by default, led by SPY and QQQ) get sub-second prices and bid/ask everywhere `fetchQuotes` is read.
- They also stop costing REST quote calls.
- REST still refreshes each streamed row at least every 2 minutes, for volume and previous close.
- Set `TRADIER_STREAM_FEEDS_QUOTES=0` to keep the stream status-only.
- `GET /api/market-data/stream` → `quoteOverlay` shows the applied and skipped counts.

Polling all 100 symbols every 5 seconds is not possible: Tradier allows 120 REST req/min. The stream is the only real-time path.

## 4. OTM scans more of the chain

`OTM_SCAN_MAX_EXPIRATIONS` (default 1, maximum 6) prices the DTE-picked expiration plus the nearest other in-window expirations. Each extra expiration is one more chain call and counts against the budget. The result lists `scannedExpirations`.

The spread filter was left alone on purpose. About half of OTM contracts fail it because their bid-ask spread is a real cost, so loosening it would make expectancy worse.

## 5. CORE paper runner (sandbox only)

```
pnpm --filter @trading-app/backtest build
node packages/backtest/dist/run-core-paper.js --check-account   # read-only: can the LIVE account trade CORE?
node packages/backtest/dist/run-core-paper.js                   # dry run: the spread it would open/close today
node packages/backtest/dist/run-core-paper.js --execute         # place SANDBOX multileg orders
node packages/backtest/dist/run-core-paper.js --summary         # results vs the 40-trade paper gate
```

**How it trades.**

- It applies the frozen `CORE_RULES` to the live chain: 35 DTE, the first put at or below 16Δ, $5 wide, 50% take-profit, 2× stop, exit at 21 DTE, at most 2 open, and one entry every 5 trading days.
- Run it once per trading day at about 15:30 ET.
- Orders always go to sandbox (`TRADIER_SANDBOX_API_TOKEN` / `TRADIER_SANDBOX_ACCOUNT_ID`). No flag reaches production.
- Each order is a day limit. If it is not filled within `--fill-wait` seconds (default 60), it is canceled.
- State is kept in `$DATA_DIR/core-paper-state.json`, written atomically.

**What to watch.**

- `--summary` reports **entry fill vs model**. That is the number the backtest could not measure.
- `--check-account` reports why the live account is not ready yet: a cash account, under $2,000, and below spread level.

**Go-live gate.** Run the full backtest (`run-put-spread-core.js`) first. If it fails, stop. If it passes, paper trade to about 40 closed trades. Then go live only on a margin account with at least $2,000 and spread approval, starting with 1 spread.
