# TRA-266 — §8 Walk-Forward Sweep Report (1D parked baseline — TRA-255 r3 §8.1)

Generated: 2026-05-03T02:44:46.528Z

Granularity: 1d
Universe: BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD
Date span: 2022-01-01 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=180d, test=90d, step=90d, windows=15

> **Parked baseline.** Per TRA-255 r3 §8.1 every 1D short emission is suppressed with `parked — failed §8 daily` before sizing. Trade counts here are expected to be 0; the report exists so the parked decision is auditable.

## §8 Acceptance bars

| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | ------- |
| 0 | 2022-06-30→2022-09-27 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 1 | 2022-09-28→2022-12-26 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 2 | 2022-12-27→2023-03-26 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 3 | 2023-03-27→2023-06-24 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 4 | 2023-06-25→2023-09-22 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 5 | 2023-09-23→2023-12-21 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 6 | 2023-12-22→2024-03-20 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 7 | 2024-03-21→2024-06-18 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 8 | 2024-06-19→2024-09-16 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 9 | 2024-09-17→2024-12-15 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 10 | 2024-12-16→2025-03-15 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 11 | 2025-03-16→2025-06-13 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 12 | 2025-06-14→2025-09-11 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 13 | 2025-09-12→2025-12-10 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 14 | 2025-12-11→2026-03-10 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |

Failing windows: 15 / 15

## Per-symbol per-window summary

| Window | BTC-USD (n / hit% / R) | ETH-USD (n / hit% / R) | SOL-USD (n / hit% / R) | XRP-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- | --- | --- | --- |
| 0 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 1 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 2 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 3 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 4 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 5 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 6 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 7 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 8 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 9 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 10 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 11 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 12 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 13 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 14 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |

### Consecutive-failure streaks (spec §8: park ≥ 4)

- BTC-USD: 🔴 PARK (max streak 15)
- ETH-USD: 🔴 PARK (max streak 15)
- SOL-USD: 🔴 PARK (max streak 15)
- XRP-USD: 🔴 PARK (max streak 15)
- DOGE-USD: 🔴 PARK (max streak 15)

## Sensitivity sweep (±20%)

| Knob | Factor | Total PnL | Min window expectancy R | Min window hit % | Rolling 90d DD % | Net positive? | Note |
| ---- | ------ | --------- | ----------------------- | ---------------- | ---------------- | ------------- | ---- |
| baseline | 1.00 | $0 | 0.000 | 0.0 | 0.00 | ❌ |  |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 0.80 | $0 | 0.000 | 0.0 | 0.00 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 1.20 | $0 | 0.000 | 0.0 | 0.00 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| regime hysteresis flipBars | 0.80 | $0 | 0.000 | 0.0 | 0.00 | ❌ |  |
| regime hysteresis flipBars | 1.20 | $0 | 0.000 | 0.0 | 0.00 | ❌ |  |
| Momentum atrStopMultiplier | 0.80 | $0 | 0.000 | 0.0 | 0.00 | ❌ |  |
| Momentum atrStopMultiplier | 1.20 | $0 | 0.000 | 0.0 | 0.00 | ❌ |  |
| Breakout atrStopMultiplier | 0.80 | $0 | 0.000 | 0.0 | 0.00 | ❌ |  |
| Breakout atrStopMultiplier | 1.20 | $0 | 0.000 | 0.0 | 0.00 | ❌ |  |
| Breakout atrTpMultiplier | 0.80 | $0 | 0.000 | 0.0 | 0.00 | ❌ |  |
| Breakout atrTpMultiplier | 1.20 | $0 | 0.000 | 0.0 | 0.00 | ❌ |  |

## Pre-route skip reasons (baseline)

| Reason | Count |
| ------ | ----- |
| parked — failed §8 daily | 102 |

## Decision

**PARKED** — TRA-255 r3 §8.1 baseline. Phase-1 daily is parked by design (zero opens by `SKIP_PARKED_1D_DAILY`); the failing-window count above is expected and reflects "no trades in window" only. The live evaluation track is the 4H run gated on TRA-267.