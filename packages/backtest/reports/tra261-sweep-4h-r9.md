# TRA-266 — §8 Walk-Forward Sweep Report (4H Phase-1.1 — TRA-255 r9 §4.4 Layer 3 v3 / §8.3)

Generated: 2026-05-03T19:42:29.568Z

Granularity: 4h
Universe: BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD
Date span: 2023-07-13 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=10804h, test=5404h, step=5404h, windows=9

## §8 Acceptance bars

| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | ------- |
| 0 | 2024-01-09→2024-04-08 | 3 | 0.0 | -0.936 | $-320 | 1.30 | ❌ | expectancy -0.936R < 0.10R; hit rate 0.0% < 35% |
| 1 | 2024-04-08→2024-07-07 | 6 | 66.7 | 0.601 | $268 | 1.31 | ✅ | — |
| 2 | 2024-07-07→2024-10-05 | 5 | 40.0 | -0.083 | $-155 | 1.29 | ❌ | expectancy -0.083R < 0.10R |
| 3 | 2024-10-05→2025-01-03 | 1 | 0.0 | -0.812 | $-73 | 0.29 | ❌ | expectancy -0.812R < 0.10R; hit rate 0.0% < 35% |
| 4 | 2025-01-03→2025-04-03 | 2 | 50.0 | 0.473 | $37 | 0.40 | ✅ | — |
| 5 | 2025-04-03→2025-07-02 | 6 | 66.7 | 0.551 | $236 | 1.28 | ✅ | — |
| 6 | 2025-07-02→2025-09-30 | 4 | 25.0 | -0.619 | $-295 | 1.32 | ❌ | expectancy -0.619R < 0.10R; hit rate 25.0% < 35% |
| 7 | 2025-09-30→2025-12-30 | 6 | 33.3 | 0.311 | $106 | 0.68 | ❌ | hit rate 33.3% < 35% |
| 8 | 2025-12-30→2026-03-30 | 3 | 66.7 | 0.712 | $133 | 0.39 | ✅ | — |

Failing windows: 5 / 9

Density bar (r9 §8.3): ≥ 4 trades / window in 5 / 9 windows ❌ (need ≥ 6 / 9)

## Per-symbol per-window summary

| Window | BTC-USD (n / hit% / R) | ETH-USD (n / hit% / R) | SOL-USD (n / hit% / R) | XRP-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- | --- | --- | --- |
| 0 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 1 / 0% / -1.01R | 0 / 0% / 0.00R | 2 / 0% / -0.90R |
| 1 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 4 / 50% / 0.49R | 0 / 0% / 0.00R | 2 / 100% / 0.82R |
| 2 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 3 / 33% / -0.22R | 0 / 0% / 0.00R | 2 / 50% / 0.13R |
| 3 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 1 / 0% / -0.81R |
| 4 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 2 / 50% / 0.47R |
| 5 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 3 / 67% / 0.54R | 0 / 0% / 0.00R | 3 / 67% / 0.56R |
| 6 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 1 / 0% / -0.83R | 0 / 0% / 0.00R | 3 / 33% / -0.55R |
| 7 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 3 / 33% / 0.45R | 0 / 0% / 0.00R | 3 / 33% / 0.17R |
| 8 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 1 / 100% / 0.53R | 0 / 0% / 0.00R | 2 / 50% / 0.80R |

### Consecutive-failure streaks (spec §8: park ≥ 4)

- BTC-USD: 🔴 PARK (max streak 9)
- ETH-USD: 🔴 PARK (max streak 9)
- SOL-USD: OK (max streak 3)
- XRP-USD: 🔴 PARK (max streak 9)
- DOGE-USD: OK (max streak 2)

## Sensitivity sweep (±20%)

| Knob | Factor | Total PnL | Min window expectancy R | Min window hit % | Rolling 90d DD % | Net positive? | Note |
| ---- | ------ | --------- | ----------------------- | ---------------- | ---------------- | ------------- | ---- |
| baseline | 1.00 | $-64 | -0.936 | 0.0 | 1.87 | ❌ |  |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 0.80 | $-64 | -0.936 | 0.0 | 1.87 | ❌ | funding gate wired but historical feed not yet sourced; per-bar lookup returns undefined |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 1.20 | $-64 | -0.936 | 0.0 | 1.87 | ❌ | funding gate wired but historical feed not yet sourced; per-bar lookup returns undefined |
| regime hysteresis flipBars | 0.80 | $-64 | -0.936 | 0.0 | 1.87 | ❌ |  |
| regime hysteresis flipBars | 1.20 | $-400 | -0.619 | 16.7 | 1.87 | ❌ |  |
| Momentum atrStopMultiplier | 0.80 | $-160 | -1.013 | 0.0 | 2.32 | ❌ |  |
| Momentum atrStopMultiplier | 1.20 | $156 | -0.893 | 0.0 | 1.56 | ✅ |  |
| Breakout atrStopMultiplier | 0.80 | $-122 | -0.936 | 0.0 | 1.87 | ❌ |  |
| Breakout atrStopMultiplier | 1.20 | $-73 | -0.936 | 0.0 | 1.87 | ❌ |  |
| Breakout atrTpMultiplier | 0.80 | $37 | -0.936 | 0.0 | 1.87 | ✅ |  |
| Breakout atrTpMultiplier | 1.20 | $-64 | -0.936 | 0.0 | 1.87 | ❌ |  |

## Pre-route skip reasons (baseline)

| Reason | Count |
| ------ | ----- |
| diagnostic — router emitted no signal | 71946 |
| diagnostic — router emitted a long signal (dropped pre-short-gate) | 471 |
| parked — failed §8 4H r9 | 327 |
| BTC trend up — alt short blocked | 48 |
| single-symbol short cap | 13 |

## Decision

**FAIL** — One or more windows missed §8 acceptance bars. TRA-261 reassigned to QuantTrader for parameter revision per spec §8 protocol.