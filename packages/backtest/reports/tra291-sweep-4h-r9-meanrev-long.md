# TRA-295 — §8 Walk-Forward Sweep Report (4H Phase-1.2 real mean-reversion long — r9 SOL+DOGE)

Generated: 2026-05-03T21:59:04.238Z

Granularity: 4h
Universe: SOL-USD, DOGE-USD (r9 binding — TRA-292 Momentum-long & Breakout-long parked for 4H/r9 per consolidation)
Date span: 2023-07-13 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=1080×4H, test=540×4H, step=540×4H, windows=9

Triggers (real mean-reversion, replacing TRA-292's direction-inverted trend stack):
- **BB-reentry-long:** close[i-1] ≤ lower BB(20, 2σ), close[i] > lower BB(20, 2σ), AND RSI(14)[i] > RSI(14)[i-1] with RSI(14)[i-1] < 30. Entry on open of bar i+1.
- **ATR-pullback-long:** close[i-1] ≤ EMA(50)[i-1] − 2.0×ATR(14)[i-1], AND bar i closes bullish (close>open AND close>close[i-1]) with volume[i] > 1.2×mean(volume[i-20..i-1]). Entry on open of bar i+1.

Risk knobs (binding): 1% account risk per trade, ATR-2.0 stop below entry, 1:2 R:R minimum target, ATR-trail engages at +1R favorable (trail = high-water close − 2.0×ATR(14)).

§5.1 funding gate stays wired direction-aware (no-op for longs).

DD bars (reported side-by-side per task spec; **not** binding for pass/fail in this child — TRA-294 sibling is recalibrating):
- **existing**: rolling-90d DD ≤ 8% (the original §8 spec)
- **recalibrated**: rolling-90d DD ≤ 25% (TRA-294 landed value: ceil-to-5%(synthetic-MC p99 21.53% + 1.5% intra-trade buffer))

## §8 Acceptance bars (binding: trades + hit + expectancy)

| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | --------- | ----- | ------- |
| 0 | 2024-01-09→2024-04-08 | 16 | 56.3 | 0.318 | $682 | ✅ | — |
| 1 | 2024-04-08→2024-07-07 | 52 | 40.4 | -0.111 | $-3419 | ❌ | expectancy -0.111R < 0.10R |
| 2 | 2024-07-07→2024-10-05 | 23 | 17.4 | -0.525 | $-3243 | ❌ | expectancy -0.525R < 0.10R; hit rate 17.4% < 35% |
| 3 | 2024-10-05→2025-01-03 | 17 | 17.6 | -0.562 | $-2416 | ❌ | expectancy -0.562R < 0.10R; hit rate 17.6% < 35% |
| 4 | 2025-01-03→2025-04-03 | 43 | 27.9 | -0.310 | $-3567 | ❌ | expectancy -0.310R < 0.10R; hit rate 27.9% < 35% |
| 5 | 2025-04-03→2025-07-02 | 26 | 61.5 | 0.229 | $402 | ✅ | — |
| 6 | 2025-07-02→2025-09-30 | 14 | 28.6 | -0.084 | $-738 | ❌ | expectancy -0.084R < 0.10R; hit rate 28.6% < 35% |
| 7 | 2025-09-30→2025-12-30 | 59 | 44.1 | -0.226 | $-5487 | ❌ | expectancy -0.226R < 0.10R |
| 8 | 2025-12-30→2026-03-30 | 52 | 40.4 | 0.050 | $-1626 | ❌ | expectancy 0.050R < 0.10R |

Passing windows (binding): 2 / 9 (acceptance: ≥ 5 / 9)
Failing windows: 7 / 9

## DD bar side-by-side (reported, not binding)

| Window | Rolling-90d DD % | Existing 8% bar | Recalibrated 25% bar |
| ------ | ---------------- | --------------- | --------------------- |
| 0 | 5.32 | ✅ | ✅ |
| 1 | 18.83 | ❌ | ✅ |
| 2 | 17.74 | ❌ | ✅ |
| 3 | 13.87 | ❌ | ✅ |
| 4 | 24.67 | ❌ | ✅ |
| 5 | 5.72 | ✅ | ✅ |
| 6 | 7.84 | ✅ | ✅ |
| 7 | 24.62 | ❌ | ✅ |
| 8 | 24.51 | ❌ | ✅ |

Windows clearing existing 8% bar: 3 / 9
Windows clearing recalibrated 25% bar: 9 / 9

## Aggregate (across all 9 test windows)

- Trades: 302
- Hit rate: 38.4%
- Mean expectancy: -0.138R
- Rolling 90d DD: 32.38%

## Per-trigger aggregate decomposition

| Trigger | Trades | Winners | Hit % | Expectancy R |
| ------- | ------ | ------- | ----- | ------------ |
| bb_reentry_long | 94 | 36 | 38.3 | -0.164 |
| atr_pullback_long | 208 | 80 | 38.5 | -0.126 |

## Per-symbol per-window R decomposition

| Window | SOL-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- |
| 0 | 7 / 57% / 0.46R | 9 / 56% / 0.21R |
| 1 | 24 / 42% / -0.01R | 28 / 39% / -0.19R |
| 2 | 12 / 17% / -0.66R | 11 / 18% / -0.38R |
| 3 | 13 / 23% / -0.43R | 4 / 0% / -1.00R |
| 4 | 24 / 29% / -0.38R | 19 / 26% / -0.22R |
| 5 | 12 / 58% / 0.14R | 14 / 64% / 0.30R |
| 6 | 5 / 40% / 0.18R | 9 / 22% / -0.23R |
| 7 | 25 / 44% / -0.14R | 34 / 44% / -0.29R |
| 8 | 24 / 38% / -0.20R | 28 / 43% / 0.26R |

## Per-trigger per-window decomposition

| Window | BB-reentry (n / hit% / R) | ATR-pullback (n / hit% / R) |
| ------ | ------------------------- | --------------------------- |
| 0 | 4 / 50% / 0.19R | 12 / 58% / 0.36R |
| 1 | 14 / 64% / 0.42R | 38 / 32% / -0.30R |
| 2 | 13 / 8% / -0.78R | 10 / 30% / -0.20R |
| 3 | 5 / 20% / -0.75R | 12 / 17% / -0.48R |
| 4 | 14 / 14% / -0.58R | 29 / 34% / -0.18R |
| 5 | 11 / 73% / 0.49R | 15 / 53% / 0.04R |
| 6 | 5 / 40% / 0.18R | 9 / 22% / -0.23R |
| 7 | 13 / 46% / -0.08R | 46 / 43% / -0.27R |
| 8 | 15 / 33% / -0.35R | 37 / 43% / 0.21R |

## Pre-route skip / fire histogram

| Reason | Count |
| ------ | ----- |
| no trigger emitted | 28319 |
| §5.1 funding gate (no-op for longs) | 841 |
| fired: atr-pullback-long | 738 |
| fired: bb-reentry-long | 276 |

Fires → tradeable entries: BB-reentry-long fired 276× and ATR-pullback-long fired 738×; 302 total tradeable entries (BB-reentry takes precedence when both fire on the same bar).

## Decision

**FAIL** — Only 2 / 9 windows clear binding §8 bars (≥ 5 / 9 required). Per task spec, do **not** silently tune. Reassign back to QuantTrader and call out which trigger (BB-reentry vs ATR-pullback) is doing more or less of the work and which bars miss on which windows.