# TRA-266 — §8 Walk-Forward Sweep Report

Generated: 2026-05-03T02:18:44.042Z

Universe: BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD
Date span: 2022-01-01 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=180d, test=90d, step=90d, windows=15

## §8 Acceptance bars

| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | ------- |
| 0 | 2022-06-30→2022-09-27 | 0 | 0.0 | 0.000 | $0 | 0.04 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 1 | 2022-09-28→2022-12-26 | 4 | 0.0 | -1.007 | $-335 | 1.62 | ❌ | expectancy -1.007R < 0.10R; hit rate 0.0% < 35% |
| 2 | 2022-12-27→2023-03-26 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 3 | 2023-03-27→2023-06-24 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 4 | 2023-06-25→2023-09-22 | 1 | 0.0 | -1.010 | $-146 | 0.59 | ❌ | expectancy -1.010R < 0.10R; hit rate 0.0% < 35% |
| 5 | 2023-09-23→2023-12-21 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 6 | 2023-12-22→2024-03-20 | 2 | 0.0 | -1.011 | $-299 | 1.24 | ❌ | expectancy -1.011R < 0.10R; hit rate 0.0% < 35% |
| 7 | 2024-03-21→2024-06-18 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 8 | 2024-06-19→2024-09-16 | 0 | 0.0 | 0.000 | $0 | 0.39 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 9 | 2024-09-17→2024-12-15 | 2 | 0.0 | -1.008 | $-228 | 1.28 | ❌ | expectancy -1.008R < 0.10R; hit rate 0.0% < 35% |
| 10 | 2024-12-16→2025-03-15 | 3 | 100.0 | 1.153 | $405 | 0.69 | ✅ | — |
| 11 | 2025-03-16→2025-06-13 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 12 | 2025-06-14→2025-09-11 | 3 | 0.0 | -1.008 | $-427 | 1.71 | ❌ | expectancy -1.008R < 0.10R; hit rate 0.0% < 35% |
| 13 | 2025-09-12→2025-12-10 | 2 | 0.0 | -0.842 | $-216 | 1.08 | ❌ | expectancy -0.842R < 0.10R; hit rate 0.0% < 35% |
| 14 | 2025-12-11→2026-03-10 | 3 | 100.0 | 1.981 | $624 | 0.03 | ✅ | — |

Failing windows: 13 / 15

## Per-symbol per-window summary

| Window | BTC-USD (n / hit% / R) | ETH-USD (n / hit% / R) | SOL-USD (n / hit% / R) | XRP-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- | --- | --- | --- |
| 0 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 1 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 4 / 0% / -1.01R |
| 2 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 3 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 4 | 0 / 0% / 0.00R | 1 / 0% / -1.01R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 5 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 6 | 1 / 0% / -1.01R | 1 / 0% / -1.01R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 7 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 8 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 9 | 0 / 0% / 0.00R | 1 / 0% / -1.01R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 1 / 0% / -1.01R |
| 10 | 0 / 0% / 0.00R | 1 / 100% / 1.99R | 0 / 0% / 0.00R | 2 / 100% / 0.74R | 0 / 0% / 0.00R |
| 11 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 12 | 0 / 0% / 0.00R | 1 / 0% / -1.01R | 0 / 0% / 0.00R | 2 / 0% / -1.01R | 0 / 0% / 0.00R |
| 13 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 1 / 0% / -0.68R | 1 / 0% / -1.00R | 0 / 0% / 0.00R |
| 14 | 0 / 0% / 0.00R | 1 / 100% / 1.98R | 0 / 0% / 0.00R | 1 / 100% / 1.98R | 1 / 100% / 1.98R |

### Consecutive-failure streaks (spec §8: park ≥ 4)

- BTC-USD: 🔴 PARK (max streak 15)
- ETH-USD: 🔴 PARK (max streak 10)
- SOL-USD: 🔴 PARK (max streak 15)
- XRP-USD: 🔴 PARK (max streak 10)
- DOGE-USD: 🔴 PARK (max streak 14)

## Sensitivity sweep (±20%)

| Knob | Factor | Total PnL | Min window expectancy R | Min window hit % | Rolling 90d DD % | Net positive? | Note |
| ---- | ------ | --------- | ----------------------- | ---------------- | ---------------- | ------------- | ---- |
| baseline | 1.00 | $-623 | -1.011 | 0.0 | 3.37 | ❌ |  |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 0.80 | $-623 | -1.011 | 0.0 | 3.37 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 1.20 | $-623 | -1.011 | 0.0 | 3.37 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| regime hysteresis flipBars | 0.80 | $105 | -1.010 | 0.0 | 2.74 | ✅ |  |
| regime hysteresis flipBars | 1.20 | $-766 | -1.011 | 0.0 | 3.37 | ❌ |  |
| Momentum atrStopMultiplier | 0.80 | $-570 | -1.012 | 0.0 | 3.37 | ❌ |  |
| Momentum atrStopMultiplier | 1.20 | $-621 | -1.011 | 0.0 | 3.37 | ❌ |  |
| Breakout atrStopMultiplier | 0.80 | $-623 | -1.011 | 0.0 | 3.37 | ❌ |  |
| Breakout atrStopMultiplier | 1.20 | $-623 | -1.011 | 0.0 | 3.37 | ❌ |  |
| Breakout atrTpMultiplier | 0.80 | $-623 | -1.011 | 0.0 | 3.37 | ❌ |  |
| Breakout atrTpMultiplier | 1.20 | $-623 | -1.011 | 0.0 | 3.37 | ❌ |  |

## Pre-route skip reasons (baseline)

| Reason | Count |
| ------ | ----- |
| BTC trend up — alt short blocked | 41 |
| single-symbol short cap | 12 |
| 3 consecutive short losses — symbol cooldown | 2 |
| max 3 concurrent shorts | 1 |

## Decision

**FAIL** — One or more windows missed §8 acceptance bars. TRA-261 reassigned to QuantTrader for parameter revision per spec §8 protocol.