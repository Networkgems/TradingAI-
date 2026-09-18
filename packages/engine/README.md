# @trading-app/engine

Trading engine sidecar — signal generation, order management, position tracking,
and broker integrations.

Currently supported brokers:

- **Alpaca** (equities + options) — REST orders + WebSocket data feed.
- **Tradier** (equities + options) — REST orders + polling data feed (Phase 1).

## Tradier integration

Tradier is the second broker integration, added under [TRA-151](../../). The
classes are shape-compatible with the Alpaca clients so a strategy can swap
brokers without changing call sites.

### Environment variables

| Var                   | Required | Notes                                                                   |
| --------------------- | -------- | ----------------------------------------------------------------------- |
| `TRADIER_API_TOKEN`   | yes      | Bearer token. Sandbox tokens are issued from the Tradier dashboard.     |
| `TRADIER_ACCOUNT_ID`  | yes (orders) | Account number used in the `/accounts/{id}/orders` path.            |
| `TRADIER_ENV`         | no       | `sandbox` (default) or `production`. Flip to `production` only after the sandbox smoke test passes. |

### Usage

```ts
import {
  TradierOrderClient,
  TradierOptionsClient,
  TradierFeed,
} from '@trading-app/engine';

const orders = new TradierOrderClient(
  process.env.TRADIER_API_TOKEN!,
  process.env.TRADIER_ACCOUNT_ID!,
  (process.env.TRADIER_ENV as 'sandbox' | 'production') ?? 'sandbox',
);

const options = new TradierOptionsClient(
  process.env.TRADIER_API_TOKEN!,
  process.env.TRADIER_ACCOUNT_ID!,
  'sandbox',
);

// Find an ATM call expiring 2-5 weeks out and buy 1 contract.
const contract = await options.findATMContract('AAPL', 'call', 150);
if (contract) {
  await options.buyContracts(contract.optionSymbol, 1);
}

// Phase-1 polling feed — emits `quote` and `trade` events with the same shape
// as `AlpacaFeed`, so strategies can swap data sources.
const feed = new TradierFeed({
  apiToken: process.env.TRADIER_API_TOKEN!,
  symbols: ['AAPL', 'SPY'],
  env: 'sandbox',
});
feed.on('quote', (q) => console.log(q));
feed.start();
```

### Sandbox smoke test

Before flipping `TRADIER_ENV=production`, a sandbox round-trip should succeed
end to end:

1. `getExpirations('AAPL')` returns at least one date.
2. `findATMContract('AAPL', 'call', <spot>)` resolves a contract.
3. `buyContracts(contract.optionSymbol, 1)` returns an order id.
4. `getOptionMid(contract.optionSymbol)` returns a number.
5. `sellContracts(contract.optionSymbol, 1)` returns an order id.

A scripted version of this lives in the PR description for [TRA-151].

### Phase 2 (not in this ticket)

- Replace `TradierFeed`'s polling loop with the long-poll
  `https://stream.tradier.com/v1/markets/events` session endpoint.
- Introduce a `BrokerOrderClient` interface once both Alpaca and Tradier are
  running side-by-side in production.

## OTM mispricing scanner (TRA-158)

Pure-function scanner that flags out-of-the-money contracts whose market mark
deviates from a Black-Scholes theoretical price. Built off Tradier's smoothed
IV (`smv_vol`) when available, falling back to neighbour-strike `mid_iv`
smoothing.

```ts
import {
  TradierOptionsClient,
  findMispricedOtmContracts,
} from '@trading-app/engine';

const client = new TradierOptionsClient(token, accountId, 'sandbox');
const chain = await client.getChainSnapshot('AAPL', '2026-05-15'); // greeks=true
const candidates = findMispricedOtmContracts(chain, /* spot */ 187.50, {
  mispricingThresholdPct: 0.20, // |mark/theo - 1| > 20% → flagged
  maxSpreadPct: 0.20,           // reject (ask-bid)/mid > 20%
  minOpenInterest: 50,
});
// → ranked OtmMispricingCandidate[] with classification: 'expensive' | 'cheap' | 'fair'
```

Server-side wrapper with caching/breaker:
[`packages/server/src/options-scanner.ts`](../server/src/options-scanner.ts)
exposes `GET /api/options/otm-mispricing?symbol=...` and a sibling
`GET /api/health/options-mispricing` diagnostics endpoint. Disabled
(`reason: 'no_credentials'`) until `TRADIER_API_TOKEN` and
`TRADIER_ACCOUNT_ID` are set.

## OTM risk parameters (TRA-160)

OTM long-premium tickets opened via `PaperOptionsAccount.openOptionFromCandidate`
follow a different risk schedule than ATM directional plays — defined as the
`OTM_RISK_PARAMS` bundle in `@trading-app/shared`. Defaults:

| Param                | OTM (TRA-160) | ATM defaults | Why the OTM value differs                             |
| -------------------- | ------------- | ------------ | ----------------------------------------------------- |
| `budgetRatio`        | **0.025**     | 0.05         | Smaller per-ticket exposure — most far-OTM expire 0.  |
| `slPct`              | **0.20**      | 0.25         | Tighter — theta on short-DTE OTM erodes premium fast. |
| `tp1Pct`             | **0.50**      | 0.25         | Wider — capture the asymmetric upside on winners.     |
| `partialExitRatio`   | **0.40**      | 0.50         | Lower — keep more contracts running for the right tail. |
| `trailActivatePct`   | **0.30**      | 0.20         | Wait longer before engaging trailing.                 |
| `trailOffsetPct`     | **0.20**      | 0.12         | Wider — OTM marks are noisier per dollar of premium.  |
| `dailyLimit`         | **2**         | 4 (ATM cap)  | Separate cap so OTM doesn't crowd out ATM signals.    |

Daily limits are tracked independently — the OTM cap (`dailyLimit` above)
bounds OTM entries while `OPTIONS_DAILY_LIMIT` continues to bound the legacy
ATM `openOption` path. `dailyOptionsCount` exposed via `getState()` reports
the combined total for UI compatibility.

These values were chosen via the parameter sweep in
[`packages/backtest/src/run-otm-sweep.ts`](../backtest/src/run-otm-sweep.ts),
which replays 3,000 synthetic premium paths (1,000 each across trending,
choppy, and crashy/theta-dominant regimes) through the same partial/SL/trail
machinery used in `PaperOptionsAccount.checkExits`. Headline result vs. the
ATM-default baseline on the same paths:

| Metric            | ATM baseline | OTM proposed |  Δ          |
| ----------------- | ------------ | ------------ | ----------- |
| Total P&L         | $202,905     | $275,692     | **+$72,788** |
| Expectancy/trade  | $67.6        | $91.9        | +$24.3      |
| Max drawdown      | $198,541     | $95,617      | **−$102,924** |
| Hard-stop %       | 48.7%        | 58.7%        | +10.0 pp    |
| Win rate          | 50.6%        | 40.8%        | −9.8 pp     |

The drop in win rate is intentional — the tighter SL hits more often on
adverse moves, but the asymmetric TP1 + wider trailing compensates and cuts
peak-to-trough drawdown roughly in half. Run the sweep yourself with:

```bash
pnpm --filter @trading-app/shared build
node --import tsx packages/backtest/src/run-otm-sweep.ts
```

(or `tsx` from any workspace `node_modules/.bin/` once `@trading-app/shared`
is built — the sweep only depends on `OTM_RISK_PARAMS` from shared).

## Risk sizing notional cap (TRA-178)

`RiskManager.sizeFromStop(entryPrice, stopPrice)` returns the smaller of two
limits:

1. **Risk-budget sizing** — `maxRiskPerTrade() / stopDistance`, the classic
   "fixed-% per-trade risk over the stop distance" formula.
2. **Notional cap** — `maxNotionalRatio × managedEquity / entryPrice`, capping
   the position's notional exposure at a fraction of current managed equity
   (default `1.0` — i.e. no leverage past the managed slice).

Why the cap exists: a tight ATR/BB-derived stop (e.g. 5–10 bps of price)
drives the risk-budget formula toward unbounded notional. The TRA-168 round-2
backtest produced -30,000% MACD-BB rows on BTC because a $500 risk budget
over a 5 bps stop sized to ~60 BTC ≈ $3.6M on a $100k account — round-trip
commission alone exceeded the supposed risk budget by 60×. In live trading
the broker would reject the order, but the engine itself enforced nothing, so
backtest equity curves were effectively unbounded. The cap makes the engine
authoritative for sizing instead of relying on broker buying-power as the
only safety net.

```ts
import { RiskManager } from '@trading-app/engine';

// Default behavior: notional capped at 1.0 × managed equity.
const risk = new RiskManager(account);

// Opt-in margin headroom (broker-rejected if not authorized live).
const leveredRisk = new RiskManager(account, { maxNotionalRatio: 2.0 });
```

The cap interacts cleanly with the drawdown brake — both shrink size in
parallel; sizing is always `min(risk-budget, notional-cap)`. See
`packages/engine/src/risk.ts` and the `risk.test.ts` cases tagged TRA-178.

## Tests

```bash
pnpm --filter @trading-app/engine test
```

Network is mocked via `globalThis.fetch = vi.fn()` for REST clients. No live
API calls are made.
