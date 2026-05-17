# Monte Carlo report — BTC-USD (real Coinbase 4H data)

Initial equity: $25000.00  •  Data source: coinbase-exchange  •  Block bootstrap: 3000 iterations, block length 5, seed 7

IS window: 2023-05-01 → 2024-12-31  •  OOS window: 2025-01-01 → 2026-05-17

| Strategy | Window | Trades | Win % | Realised P&L | Signal-edge % | p5 final | p50 final | p95 final | Worst DD |
|---|---|---|---|---|---|---|---|---|---|
| reversal | IS | 0 | 0.00% | $0.00 | 0.00% | $25000.00 | $25000.00 | $25000.00 | 0.00% |
| reversal | OOS | 2 | 100.00% | $623.21 | 100.00% | $25623.21 | $25623.21 | $25623.21 | 0.00% |
| macd_bollinger | IS | 37 | 24.32% | $-330.78 | 70.21% | $23127.16 | $24642.16 | $26342.40 | 12.50% |
| macd_bollinger | OOS | 26 | 19.23% | $-380.84 | 66.67% | $23482.48 | $24596.17 | $25813.81 | 9.91% |
| momentum | IS | 30 | 50.00% | $1501.58 | 60.61% | $25302.61 | $26506.86 | $27672.77 | 5.19% |
| momentum | OOS | 35 | 34.29% | $-412.82 | 48.57% | $23236.55 | $24664.34 | $25895.72 | 13.02% |
| breakout_vol | IS | 39 | 51.28% | $-95.99 | 52.50% | $23955.68 | $24896.47 | $25900.34 | 7.64% |
| breakout_vol | OOS | 31 | 54.84% | $-442.56 | 52.78% | $23625.39 | $24539.23 | $25670.23 | 7.92% |
| mean_reversion | IS | 8 | 50.00% | $468.66 | 66.67% | $25181.50 | $25468.66 | $25755.82 | 0.91% |
| mean_reversion | OOS | 1 | 100.00% | $31.48 | 100.00% | $25031.48 | $25031.48 | $25031.48 | 0.00% |

## Notes

- Runs on real Coinbase Exchange 4H bars after the TRA-185 tiered crypto cost
  model. Synthetic data is no longer used for evaluation (TRA-420 §1).
- `IS` overlaps the era the production constants were tuned on; `OOS` is the
  genuinely unseen period after — compare the two rows per strategy to see how
  much of the in-sample edge survives out of sample.
- Confidence bands are **moving-block** bootstrap percentiles of *final equity*
  (block length 5): blocks of consecutive trades are resampled so losing
  streaks / winning clusters survive the resample (TRA-420 §2). The IID
  resample understated tail drawdown by assuming trade independence.
- Worst DD is the worst peak-to-trough drawdown observed across all bootstrap
  iterations — a tail-risk sanity check, not the realised drawdown.
- `Signal-edge %` is the share of generated signals where price reached the
  +/- 1R target within 24 bars of the signal, regardless of whether the bracket
  order would have triggered. Bypasses fill assumptions.
