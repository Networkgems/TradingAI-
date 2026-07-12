# TRA-1617 — QQQ weekly 25-wide PCS + call-rescue through the promotion gate (Stage-1)

**Verdict: FAIL — quantitative NO-TRADE.** This is the gate's own six-guard
re-evaluation of the strategy the TRA-1614 marketing clip sells, not a hand-typed
claim (TRA-527 §3). It confirms the TRA-1614 teardown (NO-TRADE as marketed) with
numbers over every regime the single-bull clip never showed.

## What was modeled (verbatim from the spec)
- **Every Friday:** sell a 25-wide QQQ put credit spread, short put ~10–15Δ
  (centre 0.125Δ), 7DTE.
- **Manage:** close when the short put goes ITM (intraday touch of the short
  strike) OR the managed-close cost ≥ 1.5× the credit; never carry ITM into expiry.
- **Rescue:** on a breach that left a loss, buy a ~180d slightly-ITM long call and
  sell weekly ATM calls (a PMCC/diagonal) until price reclaims the breach strike,
  then unwind; abandon after > 3 weeks or the long leg −25%. The rescue's P&L is
  folded into the P&L of the week it rescues (the martingale add-on rides on the
  loss it chases).

## Realism
- **Data:** real QQQ daily bars, 2015-01-01 → 2025-12-30 (2,787 bars), covering
  Q4-2018, Mar-2020, all-2022, Aug-2024.
- **Pricing:** Black-Scholes (engine pricer) on a realized-vol IV model
  (VRP 1.05) — the TRA-731 board-ratified synthetic basis (real ≥12mo equity option
  history does not exist).
- **Costs:** $0.65/contract commission on every leg open and close; bid/ask fills
  with a spread that **widens for cheap options**, so the deep-OTM long wing is
  bought rich and sold cheap. No mid-price fantasy.

## Headline (primary params: 0.125Δ / 1.5× stop / rescue ON)
| Metric | Value |
|---|---|
| Weeks (trades) | 553 |
| Win rate | 65.5% |
| Avg credit | $0.42/share ($42/spread) — vs the "~$0.60" marketed |
| **Expectancy** | **−0.005 R/week (−$12.10/week)** |
| Total P&L | −$6,694 |
| Profit factor | 0.73 |
| **Sharpe (ann.)** | **−0.51** — fails Stage-1 minSharpe 1.0 outright |
| Sortino | −0.66 |
| **Max drawdown** | **75.8%** ($7,577 on a $10k account) — fails 20% ceiling |
| Breach rate | 12.1% (rescue reclaimed 81% of breaches) |
| Tail | worst week −0.38R; worst-5% avg −0.20R; tail:win ≈ 18:1 |

The high win rate is the credit-selling illusion: it wins most weeks and still
loses money — the collected credit does not cover managed-close losses + rescue
costs + commissions + slippage. Only Mar-2020 (a V-bottom the rescue caught) was
net positive; **every other regime, including the 2015-2021 bull, was net negative.**

## Six-guard overfitting battery (all RED)
| Guard | Result | Value |
|---|---|---|
| G1 OOS holdout efficiency | FAIL | 0 (OOS 2022-2025 expectancy ≤ 0) |
| G2 Deflated Sharpe (PSR) | FAIL | 0.044 (need > 0.95) |
| G3 PBO (CSCV) | FAIL | 0.83 (need < 0.50) |
| G4 Bootstrap OOS floor | FAIL | −0.016 (5% CI lower bound of mean R < 0) |
| G5 Holdout confirmation | FAIL | −0.10 (OOS Sharpe < 0) |
| G6 Cost/slippage stress (1.5×) | FAIL | −0.010 (expectancy < 0) |

`evaluateBacktestGate` → **Stage-1 FAIL** (fail-closed; the six-guard verdict is
authoritative).

## Registration
`reports/tra1617-qqq-pcs-gate.json` carries the ready-to-POST body for
`POST /api/promotion/optimization { strategyId: "qqq_weekly_pcs_rescue", verdict }`
(admin-only). Registering the FAIL verdict records the NO-GO on the gate; it flips
**nothing** (Stage-3 board sign-off still gates any live transition). Because the
gate is fail-closed, the strategy cannot reach live regardless.

## Reproduce
```
pnpm --filter @trading-app/backtest exec tsx src/run-tra1617-qqq-pcs-gate.ts
```
The QQQ cache (`packages/backtest/data/qqq.json`, gitignored like all bar caches)
is warmed from Yahoo on first run. `run-tra1617-qqq-pcs-gate.test.ts` locks the
FAIL verdict and skips cleanly if the cache is absent.

## Caveats (honest)
- Synthetic IV (realized-vol × VRP), not recorded option chains — the board-
  ratified stand-in; a persistent IV over/under-estimate would shift credits.
- Breaches close at the touched day's **close** fills (optimistic vs a gap-through);
  this *helps* the strategy and it still fails.
- The rescue is bounded (3 weeks / −25% long stop), so the modeled per-week tail is
  tamer than the unbounded martingale a live operator might run — i.e. the real
  tail risk is *worse* than −0.38R, not better.
