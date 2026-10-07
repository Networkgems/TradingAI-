# CORE: SPY put credit spreads

## Why one strategy, and why this one

Five months of signals have each been graded flat or negative:

- TRA-4386 found no daily feeder that predicts 5-session returns.
- The sweep-and-reclaim study did worse than random entry.
- Every directional and OTM cost-bar cell is negative.

The one documented, persistent return source a small options account can harvest is the **volatility risk premium**: index implied volatility has, on average, been higher than the volatility that actually followed. A defined-risk put credit spread is the simplest way to sell it. It wins often and loses big occasionally, and the exit rules exist to keep the occasional loss bounded.

**This is not a promise of profit.** The premium is real but thin after costs, and it disappears in some years. This study measures whether these rules capture it after honest costs.

## Rules (frozen in `CORE_RULES`, `packages/backtest/src/put-spread-core.ts`)

| | |
|---|---|
| Underlying | SPY (QQQ with `--symbol QQQ --vix ^VXN`) |
| Entry | at most one new spread every 5 trading days; ≤ 2 open |
| Expiry | 35 calendar days |
| Short strike | the first $1 strike at or below **0.16 delta** |
| Width | $5 (max loss per spread ≈ $450–490) |
| Take profit | buy back at ≤ 50% of the credit |
| Stop | loss ≥ 2× the credit |
| Time exit | 21 days to expiry |

**Pricing:**

- Black-Scholes on the daily close.
- The short leg is priced at VIX. That is conservative, because real 16-delta puts trade a couple of points above VIX.
- The long leg adds 0.6 vol points per 1% of moneyness between the strikes (put skew), so protection is priced dearer.

**Costs:**

- $0.03 per spread is charged on entry and again on every exit.
- $0.10 per contract per leg per side.

**Not modelled:** dividends, early assignment, intraday stops (a stop fills at the close that breached it, so gaps are in the model).

## Pre-registration (fixed before the first real-data run)

**Variants (k = 2):**

- **V1:** managed. 50% take profit, 21-DTE exit, 2× stop.
- **V2:** hold to expiry, no stop. The width is the stop.

**PASS requires all of:**

- n ≥ 200 trades.
- The month-clustered bootstrap CI of mean return-on-risk excludes 0 at two-sided α = 0.025.
- Total P&L > 0.
- At least 60% of calendar years are positive.
- Max drawdown ≤ 50% of the capital the variant ties up.

**Also reported:** the 2008, 2018 (Volmageddon), 2020 and 2022 stress windows.

**Harness controls** (`put-spread-core.test.ts`, run frictionless and held to expiry so they test the harness, not the rules):

- Implied 4 vol points **above** realized ⇒ positive.
- Implied 4 points **below** realized ⇒ negative.
- More premium ⇒ more P&L (monotone).
- Costs only ever subtract.

**A sobering synthetic result, recorded before any real data.** On a simulated market with a constant 4-point premium and the costs above, both variants lose money:

- V1: −1.1% mean return-on-risk.
- V2: −1.5%.

At 16 delta and $5 wide, the credit is about $0.45, and a few cents of friction per round trip is a large share of it. Whether real SPY data clears the bar depends on how large the real premium is, including put skew, which this model leaves out for the short leg. The real-data run decides.

## How to run

```
pnpm --filter @trading-app/engine build && pnpm --filter @trading-app/backtest build
node packages/backtest/dist/run-put-spread-core.js --json core-spy.json
```

This fetches SPY and ^VIX daily bars from Yahoo, 2007 → today, cached under `packages/backtest/data/`. Offline, use `--spy-csv spy.csv --vix-csv vix.csv` (columns `date,open,high,low,close[,volume]`).

## Account reality (owner's live account is a CASH account, ~$400)

- **Credit spreads need a margin account** at Tradier.
- **A margin account needs at least $2,000** of equity (FINRA).
- **A cash-secured put on SPY ties up about $65,000.** On anything you can secure with $300, it means a sub-$3 stock, which is low quality.

**So:**

1. **Backtest first** (this doc). If it fails, stop and don't build execution.
2. **If it passes, paper trade on the Tradier sandbox account** ($58k paper, margin-enabled), placing real sandbox multi-leg orders, so fills are measured against the model.
3. **Go live only after** the account holds ≥ $2,000, margin plus spread approval is granted, and the paper fills agree with the model. Start with 1 spread.

Until then, the live account can only buy options. The live learning budget (B) is the only automated live path, and it buys fills for evidence. It is not an income strategy.
