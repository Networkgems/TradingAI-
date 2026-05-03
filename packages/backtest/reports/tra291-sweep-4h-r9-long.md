# TRA-292 — §8 Walk-Forward Sweep Report (4H Phase-1.2 long-side mirror — r9 SOL+DOGE)

Generated: 2026-05-03T21:02:05.741Z

Granularity: 4h
Universe: SOL-USD, DOGE-USD (r9 binding — short-side spec implicitly parked for this run)
Date span: 2023-07-13 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=1080×4H, test=540×4H, step=540×4H, windows=9

Triggers (mirror of §4.4 short stack, inverted):
- **Momentum-long:** RSI(14)<30 at close[i-1] AND RSI(14)>35 at close[i] AND ATR(14)[i] ≥ 1.10×mean(ATR over trailing 20 bars). Entry on open of bar i+1.
- **Breakout-long:** close[i] > max(high over prior 20 bars) AND volume[i] > 1.50×mean(volume over prior 20 bars). Entry on open of bar i+1.

Risk knobs (binding): 1% account risk per trade, ATR-2.0 stop below entry, 1:2 R:R minimum target, ATR-trail engages at +1R favorable (trail = high-water close − 2.0×ATR(14)).

§5.1 funding gate stays wired but is a no-op for longs (per task spec); cap remains active for any short trigger that fires elsewhere.

## §8 Acceptance bars

| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | ------- |
| 0 | 2024-01-09→2024-04-08 | 43 | 30.2 | -0.206 | $-2479 | 15.70 | ❌ | expectancy -0.206R < 0.10R; hit rate 30.2% < 35%; rolling-90d DD 15.70% > 8% |
| 1 | 2024-04-08→2024-07-07 | 19 | 36.8 | -0.418 | $-1689 | 13.26 | ❌ | expectancy -0.418R < 0.10R; rolling-90d DD 13.26% > 8% |
| 2 | 2024-07-07→2024-10-05 | 48 | 31.3 | -0.166 | $-2946 | 21.09 | ❌ | expectancy -0.166R < 0.10R; hit rate 31.3% < 35%; rolling-90d DD 21.09% > 8% |
| 3 | 2024-10-05→2025-01-03 | 44 | 34.1 | -0.149 | $-2414 | 13.26 | ❌ | expectancy -0.149R < 0.10R; hit rate 34.1% < 35%; rolling-90d DD 13.26% > 8% |
| 4 | 2025-01-03→2025-04-03 | 36 | 19.4 | -0.421 | $-3566 | 22.50 | ❌ | expectancy -0.421R < 0.10R; hit rate 19.4% < 35%; rolling-90d DD 22.50% > 8% |
| 5 | 2025-04-03→2025-07-02 | 34 | 29.4 | -0.183 | $-2161 | 14.56 | ❌ | expectancy -0.183R < 0.10R; hit rate 29.4% < 35%; rolling-90d DD 14.56% > 8% |
| 6 | 2025-07-02→2025-09-30 | 48 | 35.4 | 0.046 | $-1308 | 17.94 | ❌ | expectancy 0.046R < 0.10R; rolling-90d DD 17.94% > 8% |
| 7 | 2025-09-30→2025-12-30 | 30 | 20.0 | -0.534 | $-4060 | 26.47 | ❌ | expectancy -0.534R < 0.10R; hit rate 20.0% < 35%; rolling-90d DD 26.47% > 8% |
| 8 | 2025-12-30→2026-03-30 | 37 | 27.0 | -0.380 | $-3700 | 22.94 | ❌ | expectancy -0.380R < 0.10R; hit rate 27.0% < 35%; rolling-90d DD 22.94% > 8% |

Passing windows: 0 / 9 (acceptance: ≥ 5 / 9)
Failing windows: 9 / 9

## Aggregate (across all 9 test windows)

- Trades: 339
- Hit rate: 29.5%
- Mean expectancy: -0.238R
- Rolling 90d DD: 26.47%

## Per-symbol per-window R decomposition

| Window | SOL-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- |
| 0 | 22 / 32% / -0.22R | 21 / 29% / -0.19R |
| 1 | 12 / 42% / -0.44R | 7 / 29% / -0.38R |
| 2 | 24 / 29% / -0.23R | 24 / 33% / -0.10R |
| 3 | 16 / 6% / -0.92R | 28 / 50% / 0.29R |
| 4 | 19 / 16% / -0.48R | 17 / 24% / -0.35R |
| 5 | 17 / 41% / 0.15R | 17 / 18% / -0.51R |
| 6 | 21 / 24% / -0.22R | 27 / 44% / 0.25R |
| 7 | 12 / 25% / -0.53R | 18 / 17% / -0.54R |
| 8 | 14 / 29% / -0.30R | 23 / 26% / -0.43R |

## Pre-route skip reasons

| Reason | Count |
| ------ | ----- |
| no trigger emitted | 28120 |
| §5.1 funding gate (no-op for longs) | 1040 |

## Decision

**FAIL** — Only 0 / 9 windows clear §8 acceptance bars (≥ 5 / 9 required). Per task spec, route back to QuantTrader for next strategy/parameter call. Do **not** silently tune.