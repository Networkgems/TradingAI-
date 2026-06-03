# Optimization report — reversal (BTC-USD)

Harness: `run-optimization@TRA-540` · Trials N: **9** · Verdict: **FAIL ❌**

## Data partition (chronological, no shuffle)

| Segment | Span | Bars |
|---|---|---|
| Optimization | 2023-05-01 → 2025-06-29 | 4742 |
| Purge + embargo gap | 250 warmup + 5 embargo | 255 |
| Locked holdout (OOS) | 2025-08-10 → 2026-06-03 | 1778 |

## Blessed parameters

`rsiOverbought=75,lookback=7` — plateau score 0.496, mean IS Sharpe 0.652, mean IS trades/window 0.3

> ⚠️ **0 of 9 trials cleared the §6 ≥20-trades/window activity floor** — the blessed pick is a fallback on a near-inactive grid; its OOS Sharpe is noise and the verdict FAILs.

## Guard battery (PASS only if all six pass)

| Guard | Value | Threshold | Result |
|---|---|---|---|
| G1 Walk-forward efficiency | 0.6420 | ≥ 0.5 and OOS Sharpe > 0 | PASS ✅ |
| G2 Deflated Sharpe Ratio | 1.0000 | PSR vs SR*(N=9) > 0.95, n ≥ 20 | FAIL ❌ |
| G3 Probability of Backtest Overfitting | 1.0000 | PBO < 0.5 (target < 0.25) | FAIL ❌ |
| G4 Bootstrap OOS floor | 580.8541 | p5 aggregate PnL > 0, n ≥ 20 | FAIL ❌ |
| G5 Holdout confirmation | 0.0000 | holdout Sharpe > 0 and holdout PnL ≥ G4 bootstrap p5 floor | FAIL ❌ |
| G6 Cost / slippage stress | 0.0000 | 1.5× cost expectancy > 0 and worst-case PnL > 0 | FAIL ❌ |

## OOS aggregate (WF) vs locked holdout

| Metric | WF-OOS | Holdout |
|---|---|---|
| Sharpe | 1.247 | 0.000 |
| Expectancy (R) | 2.888 | 0.000 |
| Profit factor | Infinity | 0.000 |
| Max drawdown | 0.7% | 0.0% |
| Trades | 2 | 0 |
| Total PnL | $581 | $0 |

> Verdict block + `backtestMetrics` (sharpe/expectancy/profitFactor/maxDrawdown/tradeCount)
> in `optimization-report.json` are shaped to feed the TRA-532 promotion-gate `backtest` leg.
