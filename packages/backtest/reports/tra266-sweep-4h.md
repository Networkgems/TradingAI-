# TRA-266 — §8 Walk-Forward Sweep Report (4H Phase-1.1 — TRA-255 r3 §12)

Generated: 2026-05-03T12:16:18.537Z

Granularity: 4h
Universe: BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD
Date span: 2022-01-01 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=10804h, test=5404h, step=5404h, windows=9

## §8 Acceptance bars

| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | ------- |
| 0 | —→— | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 1 | —→— | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 2 | —→— | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 3 | —→— | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 4 | —→— | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 5 | —→— | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 6 | —→— | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 7 | —→— | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 8 | —→— | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | no trades in window; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |

Failing windows: 9 / 9

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

### Consecutive-failure streaks (spec §8: park ≥ 4)

- BTC-USD: 🔴 PARK (max streak 9)
- ETH-USD: 🔴 PARK (max streak 9)
- SOL-USD: 🔴 PARK (max streak 9)
- XRP-USD: 🔴 PARK (max streak 9)
- DOGE-USD: 🔴 PARK (max streak 9)

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

## Decision

**FAIL** — One or more windows missed §8 acceptance bars. TRA-261 reassigned to QuantTrader for parameter revision per spec §8 protocol.