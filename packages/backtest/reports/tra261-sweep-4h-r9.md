# TRA-266 — §8 Walk-Forward Sweep Report (4H Phase-1.1 r9 — TRA-255 r9 §4.4 v3 / §8.3, funding gate active)

Generated: 2026-05-03T20:43:06.363Z

Granularity: 4h
Universe: BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD
Date span: 2023-07-13 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=10804h, test=5404h, step=5404h, windows=9

> **r9 universe (TRA-287).** 4H routing reduced to `SOL-USD, DOGE-USD` per TRA-255 r9 §4.4 Layer 3 v3. BTC-USD / ETH-USD / XRP-USD are parked with `parked — failed §8 4H r9`. The §5.1 funding gate is wired against the Binance USD-M futures funding history (cached locally, ~8h resolution / ÷ 8 → per-hour) — see `packages/backtest/src/funding-feed.ts` for the Coinbase INTX vs Binance basis rationale.

## §8 Acceptance bars

| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | ------- |
| 0 | 2024-01-09→2024-04-08 | 3 | 0.0 | -1.012 | $-380 | 1.55 | ❌ | only 3 trade(s) in window < 4; expectancy -1.012R < 0.10R; hit rate 0.0% < 35% |
| 1 | 2024-04-08→2024-07-07 | 13 | 23.1 | -0.246 | $-654 | 3.51 | ❌ | expectancy -0.246R < 0.10R; hit rate 23.1% < 35% |
| 2 | 2024-07-07→2024-10-05 | 7 | 28.6 | -0.262 | $-204 | 1.98 | ❌ | expectancy -0.262R < 0.10R; hit rate 28.6% < 35% |
| 3 | 2024-10-05→2025-01-03 | 3 | 0.0 | -1.010 | $-307 | 1.27 | ❌ | only 3 trade(s) in window < 4; expectancy -1.010R < 0.10R; hit rate 0.0% < 35% |
| 4 | 2025-01-03→2025-04-03 | 13 | 23.1 | -0.290 | $-640 | 2.61 | ❌ | expectancy -0.290R < 0.10R; hit rate 23.1% < 35% |
| 5 | 2025-04-03→2025-07-02 | 6 | 33.3 | -0.014 | $-96 | 1.87 | ❌ | expectancy -0.014R < 0.10R; hit rate 33.3% < 35% |
| 6 | 2025-07-02→2025-09-30 | 1 | 0.0 | -1.019 | $-99 | 0.48 | ❌ | only 1 trade(s) in window < 4; expectancy -1.019R < 0.10R; hit rate 0.0% < 35% |
| 7 | 2025-09-30→2025-12-30 | 8 | 12.5 | -0.302 | $-241 | 1.51 | ❌ | expectancy -0.302R < 0.10R; hit rate 12.5% < 35% |
| 8 | 2025-12-30→2026-03-30 | 17 | 29.4 | -0.127 | $-438 | 3.34 | ❌ | expectancy -0.127R < 0.10R; hit rate 29.4% < 35% |

Failing windows: 9 / 9

## Per-symbol per-window summary

| Window | BTC-USD (n / hit% / R) | ETH-USD (n / hit% / R) | SOL-USD (n / hit% / R) | XRP-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- | --- | --- | --- |
| 0 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 2 / 0% / -1.01R | 0 / 0% / 0.00R | 1 / 0% / -1.02R |
| 1 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 7 / 14% / -0.64R | 0 / 0% / 0.00R | 6 / 33% / 0.22R |
| 2 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 2 / 50% / 0.12R | 0 / 0% / 0.00R | 5 / 20% / -0.41R |
| 3 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 1 / 0% / -1.01R | 0 / 0% / 0.00R | 2 / 0% / -1.01R |
| 4 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 7 / 14% / -0.57R | 0 / 0% / 0.00R | 6 / 33% / 0.04R |
| 5 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 3 / 33% / -0.01R | 0 / 0% / 0.00R | 3 / 33% / -0.02R |
| 6 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 1 / 0% / -1.02R |
| 7 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 3 / 33% / 0.21R | 0 / 0% / 0.00R | 5 / 0% / -0.61R |
| 8 | 0 / 0% / 0.00R | 0 / 0% / 0.00R | 8 / 38% / 0.02R | 0 / 0% / 0.00R | 9 / 22% / -0.26R |

### Consecutive-failure streaks (spec §8: park ≥ 4)

- BTC-USD: 🔴 PARK (max streak 9)
- ETH-USD: 🔴 PARK (max streak 9)
- SOL-USD: 🔴 PARK (max streak 6)
- XRP-USD: 🔴 PARK (max streak 9)
- DOGE-USD: 🔴 PARK (max streak 9)

## Sensitivity sweep (±20%)

| Knob | Factor | Total PnL | Min window expectancy R | Min window hit % | Rolling 90d DD % | Net positive? | Note |
| ---- | ------ | --------- | ----------------------- | ---------------- | ---------------- | ------------- | ---- |
| baseline | 1.00 | $-3059 | -1.019 | 0.0 | 3.51 | ❌ |  |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 0.80 | $-4263 | -0.949 | 0.0 | 5.25 | ❌ | threshold lives on engine constant, not ShortSpec — gate itself is active via Binance funding feed (TRA-287) |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 1.20 | $-4263 | -0.949 | 0.0 | 5.25 | ❌ | threshold lives on engine constant, not ShortSpec — gate itself is active via Binance funding feed (TRA-287) |
| regime hysteresis flipBars | 0.80 | $-3367 | -0.949 | 0.0 | 4.46 | ❌ |  |
| regime hysteresis flipBars | 1.20 | $-3600 | -0.949 | 0.0 | 5.15 | ❌ |  |
| Momentum atrStopMultiplier | 0.80 | $-3219 | -1.013 | 0.0 | 6.14 | ❌ |  |
| Momentum atrStopMultiplier | 1.20 | $-4437 | -0.875 | 0.0 | 5.84 | ❌ |  |
| Breakout atrStopMultiplier | 0.80 | $-4303 | -0.949 | 0.0 | 5.25 | ❌ |  |
| Breakout atrStopMultiplier | 1.20 | $-4389 | -0.934 | 0.0 | 5.83 | ❌ |  |
| Breakout atrTpMultiplier | 0.80 | $-4165 | -0.949 | 0.0 | 5.25 | ❌ |  |
| Breakout atrTpMultiplier | 1.20 | $-4263 | -0.949 | 0.0 | 5.25 | ❌ |  |

## Pre-route skip reasons (baseline)

| Reason | Count |
| ------ | ----- |
| parked — failed §8 4H r9 | 341 |
| BTC trend up — alt short blocked | 56 |
| single-symbol short cap | 39 |
| 3 consecutive short losses — symbol cooldown | 9 |
| cross-strategy per-symbol short cap | 1 |

## Decision

**FAIL** — only 0 / 9 windows met §8 acceptance bars (quorum 6). r9 is the smallest spec-compliant universe; per TRA-287 routing, reassign TRA-255 to QuantTrader for Phase-1.2 timeframe / strategy-family escalation.