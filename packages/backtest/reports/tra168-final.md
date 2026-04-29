# TRA-168 final read — TRA-177 consolidated run

Generated 2026-04-29T12:55:31.793Z.

## Reproduction

```bash
pnpm --filter @trading-app/backtest build
pnpm --filter @trading-app/backtest exec tsx src/run-tra177.ts
```

- **Cost model**: commission 40 bps + slippage 10 bps, applied per fill (TRA-169).
- **In-sample window**: 2026-01-29 → 2026-04-29 (90d × 1h Coinbase, BTC/ETH/SOL).
- **Walk-forward window**: 2025-12-30 → 2026-04-29 (120d × 1h Coinbase). The TRA-177 brief asks for "60d train / 30d test rolling windows (slide every 15d → at least 3 folds)"; that requires more than 90d of data, so the walk-forward leg fetches 120d while the in-sample leg keeps the requested 90d window.
- **Monte Carlo**: 1000 bootstrap iterations on the in-sample closed-trade list (seed=7, initial equity $25000.00).

## 1. Commission-adjusted in-sample read

| Symbol | Strategy | Trades | Win % | Net P&L | Worst-case P&L | PF | Sharpe | Signal-edge |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| BTC-USD | reversal | 0 | — | $0.00 | $0.00 | 0.00 | — | 100.0% (2/2) |
| BTC-USD | macd_trend | 0 | — | $0.00 | $0.00 | 0.00 | — | 33.3% (4/12) |
| BTC-USD | bb_fade | 4 | 0.00% | $-9141.70 | $-9141.70 | 0.00 | -1.10 | 85.7% (18/21) |
| BTC-USD | ichimoku | 0 | — | $0.00 | $0.00 | 0.00 | — | 32.0% (8/25) |
| BTC-USD | combined | 4 | 0.00% | $-9141.70 | $-9141.70 | 0.00 | -1.10 | 61.6% (53/86) |
| ETH-USD | reversal | 3 | 0.00% | $-1305.87 | $-1305.87 | 0.00 | -1.80 | 75.0% (3/4) |
| ETH-USD | macd_trend | 11 | 27.27% | $-663.91 | $-663.91 | 0.42 | -0.42 | 27.8% (5/18) |
| ETH-USD | bb_fade | 14 | 35.71% | $-4868.49 | $-4868.49 | 0.13 | -0.60 | 89.5% (17/19) |
| ETH-USD | ichimoku | 14 | 21.43% | $-901.17 | $-901.17 | 0.36 | -0.50 | 17.4% (4/23) |
| ETH-USD | combined | 50 | 24.00% | $-8733.25 | $-8733.25 | 0.18 | -0.50 | 37.5% (36/96) |
| SOL-USD | reversal | 6 | 16.67% | $-1989.18 | $-1989.18 | 0.05 | -0.87 | 100.0% (6/6) |
| SOL-USD | macd_trend | 12 | 16.67% | $-1181.03 | $-1181.03 | 0.27 | -0.66 | 13.3% (2/15) |
| SOL-USD | bb_fade | 19 | 15.79% | $-9400.26 | $-9400.26 | 0.17 | -0.56 | 75.9% (22/29) |
| SOL-USD | ichimoku | 11 | 27.27% | $-518.08 | $-518.08 | 0.56 | -0.27 | 28.0% (7/25) |
| SOL-USD | combined | 47 | 19.15% | $-12256.88 | $-12256.88 | 0.18 | -0.44 | 47.6% (40/84) |

## 2. Walk-forward OOS read

60d train / 30d test rolling windows, slide=15d. Train picks Sharpe-best params on gross edge; OOS test applies the cost model. Tie-break = trade count when Sharpe ties.

### BTC-USD

| Strategy | Fold | Train | Test | Picked | Train Sharpe (trades) | OOS Sharpe | OOS P&L | OOS Win % | OOS Trades | OOS Edge |
|---|---:|---|---|---|---|---:|---:|---:|---:|---:|
| reversal | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | volMult=1.2 | 0.00 (0) | — | $0.00 | — | 0 | 100.0% |
| reversal | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | volMult=1.2 | 0.00 (0) | — | $0.00 | — | 0 | 100.0% |
| reversal | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | volMult=1.2 | 0.00 (0) | — | $0.00 | — | 0 | 0.0% |
| bb_fade | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | rsiOversold=25 | -44.10 (2) | -2.40 | $-2352.13 | 0.00% | 2 | 66.7% |
| bb_fade | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | rsiOversold=25 | -44.10 (2) | -2.40 | $-2352.13 | 0.00% | 2 | 70.0% |
| bb_fade | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | rsiOversold=25 | -13.32 (4) | 0.00 | $-734.66 | 0.00% | 1 | 100.0% |
| macd_trend | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | volMult=1 | 0.00 (0) | — | $0.00 | — | 0 | 33.3% |
| macd_trend | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | volMult=1 | 0.00 (0) | — | $0.00 | — | 0 | 33.3% |
| macd_trend | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | volMult=1 | 0.00 (0) | — | $0.00 | — | 0 | 0.0% |
| ichimoku | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | kumo>=0.003 | 0.00 (0) | — | $0.00 | — | 0 | 20.0% |
| ichimoku | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | kumo>=0.003 | 0.00 (0) | — | $0.00 | — | 0 | 20.0% |
| ichimoku | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | kumo>=0.003 | 0.00 (0) | — | $0.00 | — | 0 | 20.0% |

### ETH-USD

| Strategy | Fold | Train | Test | Picked | Train Sharpe (trades) | OOS Sharpe | OOS P&L | OOS Win % | OOS Trades | OOS Edge |
|---|---:|---|---|---|---|---:|---:|---:|---:|---:|
| reversal | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | volMult=1.2 | 0.00 (0) | -1.66 | $-1267.97 | 0.00% | 3 | 33.3% |
| reversal | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | volMult=1.2 | 0.00 (1) | -1.52 | $-1216.38 | 0.00% | 3 | 66.7% |
| reversal | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | volMult=1.3 | -53.62 (3) | — | $0.00 | — | 0 | 0.0% |
| bb_fade | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | rsiOversold=25 | 0.05 (8) | -0.85 | $-3420.56 | 20.00% | 5 | 71.4% |
| bb_fade | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | rsiOversold=25 | -0.01 (9) | -1.26 | $-1357.86 | 25.00% | 4 | 60.0% |
| bb_fade | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | rsiOversold=25 | -0.07 (12) | 1.76 | $197.56 | 100.00% | 2 | 100.0% |
| macd_trend | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | volMult=1 | 0.07 (8) | -0.54 | $-332.13 | 25.00% | 4 | 16.7% |
| macd_trend | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | volMult=1 | -0.00 (9) | 0.25 | $138.65 | 66.67% | 3 | 40.0% |
| macd_trend | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | volMult=1 | 0.00 (9) | -0.04 | $-19.19 | 50.00% | 2 | 100.0% |
| ichimoku | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | kumo>=0.005 | -0.13 (7) | -6.73 | $-499.12 | 0.00% | 4 | 0.0% |
| ichimoku | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | kumo>=0.005 | -0.45 (6) | 0.12 | $118.25 | 50.00% | 6 | 20.0% |
| ichimoku | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | kumo>=0.005 | -7.84 (7) | -0.22 | $-213.38 | 33.33% | 6 | 25.0% |

### SOL-USD

| Strategy | Fold | Train | Test | Picked | Train Sharpe (trades) | OOS Sharpe | OOS P&L | OOS Win % | OOS Trades | OOS Edge |
|---|---:|---|---|---|---|---:|---:|---:|---:|---:|
| reversal | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | volMult=1.2 | 0.00 (0) | -0.58 | $-879.68 | 50.00% | 2 | 100.0% |
| reversal | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | volMult=1.2 | 0.00 (1) | -1.29 | $-1947.82 | 16.67% | 6 | 83.3% |
| reversal | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | volMult=1.5 | 0.35 (2) | -1.44 | $-926.98 | 0.00% | 3 | 100.0% |
| bb_fade | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | rsiOversold=25 | 0.02 (11) | -0.73 | $-1801.88 | 20.00% | 5 | 57.1% |
| bb_fade | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | rsiOversold=25 | -0.01 (12) | -0.55 | $-2239.88 | 25.00% | 8 | 75.0% |
| bb_fade | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | rsiOversold=25 | 0.06 (15) | -3.65 | $-1514.11 | 0.00% | 3 | 83.3% |
| macd_trend | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | volMult=1.2 | -0.13 (11) | -22.03 | $-490.88 | 0.00% | 3 | 0.0% |
| macd_trend | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | volMult=1 | -0.07 (10) | — | $0.00 | — | 0 | 0.0% |
| macd_trend | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | volMult=1 | -0.25 (9) | -7.89 | $-560.13 | 0.00% | 3 | 0.0% |
| ichimoku | 0 | 2025-12-30 → 2026-02-28 | 2026-02-28 → 2026-03-30 | kumo>=0.008 | 0.29 (4) | 0.45 | $281.93 | 66.67% | 3 | 0.0% |
| ichimoku | 1 | 2026-01-14 → 2026-03-15 | 2026-03-15 → 2026-04-14 | kumo>=0.005 | -0.10 (7) | -8.22 | $-316.63 | 0.00% | 2 | 25.0% |
| ichimoku | 2 | 2026-01-29 → 2026-03-30 | 2026-03-30 → 2026-04-29 | kumo>=0.005 | 0.08 (8) | 0.00 | $-225.34 | 0.00% | 1 | 16.7% |

## 3. Monte Carlo confidence bands (in-sample trades)

| Symbol | Strategy | Trades | Realised P&L | p5 final | p50 final | p95 final | Worst DD |
|---|---|---:|---:|---:|---:|---:|---:|
| BTC-USD | reversal | 0 | $0.00 | $25000.00 | $25000.00 | $25000.00 | 0.00% |
| BTC-USD | macd_trend | 0 | $0.00 | $25000.00 | $25000.00 | $25000.00 | 0.00% |
| BTC-USD | bb_fade | 4 | $-9141.70 | $11237.75 | $15858.30 | $20478.85 | 85.73% |
| BTC-USD | ichimoku | 0 | $0.00 | $25000.00 | $25000.00 | $25000.00 | 0.00% |
| BTC-USD | combined | 4 | $-9141.70 | $11237.75 | $15858.30 | $20478.85 | 85.73% |
| ETH-USD | reversal | 3 | $-1305.87 | $23262.11 | $23694.13 | $24126.16 | 8.56% |
| ETH-USD | macd_trend | 11 | $-663.91 | $23677.56 | $24324.33 | $25086.36 | 6.89% |
| ETH-USD | bb_fade | 14 | $-4868.49 | $16448.73 | $20187.08 | $23214.95 | 58.12% |
| ETH-USD | ichimoku | 14 | $-901.17 | $23398.94 | $24079.97 | $24964.58 | 8.33% |
| ETH-USD | combined | 50 | $-8733.25 | $11785.65 | $16495.68 | $19925.73 | 69.36% |
| SOL-USD | reversal | 6 | $-1989.18 | $21615.01 | $23053.75 | $24291.35 | 19.11% |
| SOL-USD | macd_trend | 12 | $-1181.03 | $23048.09 | $23812.16 | $24648.57 | 8.30% |
| SOL-USD | bb_fade | 19 | $-9400.26 | $8968.60 | $15891.68 | $21251.40 | 109.99% |
| SOL-USD | ichimoku | 11 | $-518.08 | $23709.77 | $24466.17 | $25507.25 | 6.98% |
| SOL-USD | combined | 47 | $-12256.88 | $5230.89 | $13001.43 | $18831.88 | 106.20% |

## Notes

- `Worst-case P&L` resolves ambiguous OHLC bars (range covers both stop and target) with stop-first instead of target-first. Equal to net P&L when no ambiguous bars occurred.
- `Signal-edge` is the share of generated signals where price reached ±1R within 24 bars of the signal, regardless of bracket-order plumbing. A fill-independent quality check.
- Monte Carlo bootstraps the realised closed-trade list 1,000× — it does not invent new edges, only resamples the ones we observed. Treat the band as a *floor* on uncertainty.
- ATR stops / compounding RiskManager (TRA-171) are out of scope for this read; rerun once they merge.
