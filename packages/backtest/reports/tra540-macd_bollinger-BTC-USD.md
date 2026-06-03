# Optimization report — macd_bollinger (BTC-USD)

Harness: `run-optimization@TRA-540` · Trials N: **9** · Verdict: **FAIL ❌**

## Data partition (chronological, no shuffle)

| Segment | Span | Bars |
|---|---|---|
| Optimization | 2023-05-01 → 2025-06-29 | 4742 |
| Purge + embargo gap | 250 warmup + 5 embargo | 255 |
| Locked holdout (OOS) | 2025-08-10 → 2026-06-03 | 1778 |

## Blessed parameters

`bbPeriod=15,volumeMultiplier=2` — plateau score 0.107, mean IS Sharpe 0.223, mean IS trades/window 5.4

> ⚠️ **0 of 9 trials cleared the §6 ≥20-trades/window activity floor** — the blessed pick is a fallback on a near-inactive grid; its OOS Sharpe is noise and the verdict FAILs.

## Guard battery (PASS only if all six pass)

| Guard | Value | Threshold | Result |
|---|---|---|---|
| G1 Walk-forward efficiency | -0.4419 | ≥ 0.5 and OOS Sharpe > 0 | FAIL ❌ |
| G2 Deflated Sharpe Ratio | 0.0955 | PSR vs SR*(N=9) > 0.95, n ≥ 20 | FAIL ❌ |
| G3 Probability of Backtest Overfitting | 0.1795 | PBO < 0.5 (target < 0.25) | PASS ✅ |
| G4 Bootstrap OOS floor | -808.5303 | p5 aggregate PnL > 0, n ≥ 20 | FAIL ❌ |
| G5 Holdout confirmation | -0.3405 | holdout Sharpe > 0 and holdout PnL ≥ G4 bootstrap p5 floor | FAIL ❌ |
| G6 Cost / slippage stress | -0.3781 | 1.5× cost expectancy > 0 and worst-case PnL > 0 | FAIL ❌ |

## OOS aggregate (WF) vs locked holdout

| Metric | WF-OOS | Holdout |
|---|---|---|
| Sharpe | 0.639 | -0.340 |
| Expectancy (R) | 0.104 | -0.360 |
| Profit factor | 1.475 | 0.782 |
| Max drawdown | 3.6% | 3.0% |
| Trades | 29 | 13 |
| Total PnL | $898 | $-199 |

> Verdict block + `backtestMetrics` (sharpe/expectancy/profitFactor/maxDrawdown/tradeCount)
> in `optimization-report.json` are shaped to feed the TRA-532 promotion-gate `backtest` leg.
