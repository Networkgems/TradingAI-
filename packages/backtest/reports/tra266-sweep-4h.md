# TRA-266 — §8 Walk-Forward Sweep Report (4H Phase-1.1 — TRA-255 r7 §4.4 Layer 3)

Generated: 2026-05-03T18:15:40.277Z

Granularity: 4h
Universe: BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD
Date span: 2023-07-13 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=10804h, test=5404h, step=5404h, windows=9

## §8 Acceptance bars

| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | ------- |
| 0 | 2024-01-09→2024-04-08 | 4 | 25.0 | -0.479 | $-232 | 1.15 | ❌ | expectancy -0.479R < 0.10R; hit rate 25.0% < 35% |
| 1 | 2024-04-08→2024-07-07 | 10 | 50.0 | 0.393 | $196 | 1.76 | ✅ | — |
| 2 | 2024-07-07→2024-10-05 | 9 | 44.4 | 0.200 | $25 | 1.71 | ✅ | — |
| 3 | 2024-10-05→2025-01-03 | 2 | 0.0 | -0.897 | $-228 | 0.91 | ❌ | expectancy -0.897R < 0.10R; hit rate 0.0% < 35% |
| 4 | 2025-01-03→2025-04-03 | 6 | 33.3 | 0.072 | $-117 | 1.10 | ❌ | expectancy 0.072R < 0.10R; hit rate 33.3% < 35% |
| 5 | 2025-04-03→2025-07-02 | 10 | 40.0 | 0.100 | $-151 | 2.13 | ❌ | expectancy 0.100R < 0.10R |
| 6 | 2025-07-02→2025-09-30 | 8 | 37.5 | -0.243 | $-319 | 1.47 | ❌ | expectancy -0.243R < 0.10R |
| 7 | 2025-09-30→2025-12-30 | 7 | 42.9 | 0.546 | $333 | 0.68 | ✅ | — |
| 8 | 2025-12-30→2026-03-30 | 5 | 40.0 | 0.130 | $-107 | 0.81 | ✅ | — |

Failing windows: 5 / 9

## Per-symbol per-window summary

| Window | BTC-USD (n / hit% / R) | ETH-USD (n / hit% / R) | SOL-USD (n / hit% / R) | XRP-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- | --- | --- | --- |
| 0 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 1 / 0% / -1.01R | 1 / 100% / 0.89R | 2 / 0% / -0.90R |
| 1 | 0 / 0% / 0.00R | 4 / 25% / 0.08R | 4 / 50% / 0.49R | 0 / 0% / 0.00R | 2 / 100% / 0.82R |
| 2 | 0 / 0% / 0.00R | 3 / 67% / 0.99R | 3 / 33% / -0.22R | 1 / 0% / -0.74R | 2 / 50% / 0.13R |
| 3 | 0 / 0% / 0.00R | 1 / 0% / -0.98R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 1 / 0% / -0.81R |
| 4 | 0 / 0% / 0.00R | 1 / 0% / -1.01R | 0 / 0% / 0.00R | 3 / 33% / 0.17R | 2 / 50% / 0.47R |
| 5 | 0 / 0% / 0.00R | 3 / 0% / -0.69R | 3 / 67% / 0.54R | 1 / 0% / -0.23R | 3 / 67% / 0.56R |
| 6 | 0 / 0% / 0.00R | 2 / 0% / -0.55R | 1 / 0% / -0.83R | 2 / 100% / 0.81R | 3 / 33% / -0.55R |
| 7 | 0 / 0% / 0.00R | 1 / 100% / 1.96R | 3 / 33% / 0.45R | 0 / 0% / 0.00R | 3 / 33% / 0.17R |
| 8 | 0 / 0% / 0.00R | 1 / 0% / -1.01R | 1 / 100% / 0.53R | 1 / 0% / -0.47R | 2 / 50% / 0.80R |

### Consecutive-failure streaks (spec §8: park ≥ 4)

- BTC-USD: 🔴 PARK (max streak 9)
- ETH-USD: 🔴 PARK (max streak 4)
- SOL-USD: OK (max streak 3)
- XRP-USD: 🔴 PARK (max streak 5)
- DOGE-USD: OK (max streak 2)

## Sensitivity sweep (±20%)

| Knob | Factor | Total PnL | Min window expectancy R | Min window hit % | Rolling 90d DD % | Net positive? | Note |
| ---- | ------ | --------- | ----------------------- | ---------------- | ---------------- | ------------- | ---- |
| baseline | 1.00 | $-599 | -0.897 | 0.0 | 3.26 | ❌ |  |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 0.80 | $-599 | -0.897 | 0.0 | 3.26 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 1.20 | $-599 | -0.897 | 0.0 | 3.26 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| regime hysteresis flipBars | 0.80 | $-599 | -0.897 | 0.0 | 3.26 | ❌ |  |
| regime hysteresis flipBars | 1.20 | $-929 | -0.619 | 16.7 | 3.16 | ❌ |  |
| Momentum atrStopMultiplier | 0.80 | $-903 | -1.013 | 0.0 | 2.85 | ❌ |  |
| Momentum atrStopMultiplier | 1.20 | $-262 | -0.489 | 0.0 | 3.10 | ❌ |  |
| Breakout atrStopMultiplier | 0.80 | $-659 | -0.897 | 0.0 | 3.19 | ❌ |  |
| Breakout atrStopMultiplier | 1.20 | $-627 | -0.556 | 25.0 | 3.82 | ❌ |  |
| Breakout atrTpMultiplier | 0.80 | $-499 | -0.897 | 0.0 | 3.26 | ❌ |  |
| Breakout atrTpMultiplier | 1.20 | $-598 | -0.897 | 0.0 | 3.26 | ❌ |  |

## Pre-route skip reasons (baseline)

| Reason | Count |
| ------ | ----- |
| diagnostic — router emitted no signal | 71951 |
| diagnostic — router emitted a long signal (dropped pre-short-gate) | 473 |
| single-symbol short cap | 204 |
| BTC trend up — alt short blocked | 98 |
| total short notional cap | 3 |
| 3 consecutive short losses — symbol cooldown | 3 |
| cross-strategy per-symbol short cap | 3 |

## Decision

**FAIL** — One or more windows missed §8 acceptance bars. TRA-261 reassigned to QuantTrader for parameter revision per spec §8 protocol.