# Monte Carlo report — BTC-USD (90-day synthetic)

Initial equity: $25000.00  •  Bootstrap iterations: 1000  •  Seed: 7

| Strategy | Trades | Win % | Realised P&L | Signal-edge % | p5 final | p50 final | p95 final | Worst DD |
|---|---|---|---|---|---|---|---|---|
| reversal | 0 | 0.00% | $0.00 | 0.00% | $25000.00 | $25000.00 | $25000.00 | 0.00% |
| macd_bollinger | 2 | 0.00% | $-236.88 | 77.78% | $24751.13 | $24763.12 | $24775.12 | 1.00% |
| orb | 0 | 0.00% | $0.00 | 11.11% | $25000.00 | $25000.00 | $25000.00 | 0.00% |
| ichimoku | 0 | 0.00% | $0.00 | 0.00% | $25000.00 | $25000.00 | $25000.00 | 0.00% |
| combined | 2 | 0.00% | $-236.88 | 15.07% | $24751.13 | $24763.12 | $24775.12 | 1.00% |

## Notes

- Confidence bands are bootstrap percentiles of *final equity* over 1,000 resamples
  of the realised closed-trade list. They quantify how dependent the headline
  number is on trade ordering and on the small sample size.
- Worst DD is the worst peak-to-trough drawdown observed across all bootstrap
  iterations — a tail-risk sanity check, not the realised drawdown.
- `Signal-edge %` is the share of generated signals where price reached the
  +/- 1R target within 24 bars of the signal, regardless of whether the bracket
  order would have triggered. Bypasses fill assumptions.
