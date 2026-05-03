# TRA-298 — §8 Walk-Forward Sweep Report (4H Phase-1.2.2 BB-reentry-only + SMA(20) BTC.D regime gate — r9 SOL+DOGE)

Generated: 2026-05-03T23:02:28.905Z

Granularity: 4h
Universe: SOL-USD, DOGE-USD (r9 binding — TRA-292 trend-stack triggers parked, TRA-296 ATR-pullback parked-by-evidence)
Date span: 2023-07-13 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=1080×4H, test=540×4H, step=540×4H, windows=9

## Diff vs TRA-296

1. **ATR-pullback-long DROPPED.** TRA-296 ran -0.106R post-gate aggregate even after the §3 selectivity tightening. Park-by-evidence on this universe at this timeframe.
2. **BTC.D gate SMA(50) → SMA(20).** TRA-296 had a density-floor problem (W2/W4/W7/W8 → 0/0/1/0 post-gate trades), not an edge-floor problem. A faster MA flips alt-favorable / alt-bleed sooner, recovering density on borderline quarters.

## BB-reentry-long trigger (UNCHANGED from TRA-295/296)

- close[i-1] ≤ lower BB(20, 2σ)
- close[i] > lower BB(20, 2σ)
- RSI(14)[i] > RSI(14)[i-1] AND RSI(14)[i-1] < 30
- Entry: open of bar i+1

## BTC-dominance regime gate — SMA(20)

Source: synthetic 5-coin basket (BTC mcap / Σ(BTC+ETH+SOL+DOGE+XRP) on existing daily Coinbase caches with mid-period 2024 supply constants). Same source as TRA-296 — basket composition explicitly out-of-scope per task.

Filter: SMA(20) on dominance. On 4H bar i, look up most-recent-completed daily synthetic-BTC.D close; if ≥ SMA(20) suppress entry, if below allow.

BTC.D series: 1584 daily points spanning 2022-01-01 → 2026-05-03; SMA(20) warm-up trivially covered (≥ 558d before aligned start, much more than 20d needed).

Risk knobs (binding, UNCHANGED): 1% account risk per trade, ATR-2.0 stop, 1:2 R:R minimum target, ATR-trail engages at +1R favorable.

§8 acceptance bar (UNCHANGED — all four bars binding): density ≥ 4 / hit ≥ 35% / expectancy ≥ +0.10R / DD90 ≤ 25%. Pass on ≥ 5 / 9 windows.

## §8 Acceptance bars (binding: trades + hit + expectancy + DD90)

| Window | Test span | Trades | Hit % | Expectancy R | DD90 % | Total PnL | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | ------ | --------- | ----- | ------- |
| 0 | 2024-01-09→2024-04-08 | 3 | 33.3 | -0.013 | 1.49 | $-88 | ❌ | trades 3 < 4; expectancy -0.013R < 0.10R; hit rate 33.3% < 35% |
| 1 | 2024-04-08→2024-07-07 | 5 | 80.0 | 1.120 | 2.04 | $1241 | ✅ | — |
| 2 | 2024-07-07→2024-10-05 | 0 | 0.0 | 0.000 | 0.87 | $0 | ❌ | trades 0 < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 3 | 2024-10-05→2025-01-03 | 3 | 33.3 | -0.585 | 4.82 | $-540 | ❌ | trades 3 < 4; expectancy -0.585R < 0.10R; hit rate 33.3% < 35% |
| 4 | 2025-01-03→2025-04-03 | 1 | 0.0 | -1.010 | 1.18 | $-289 | ❌ | trades 1 < 4; expectancy -1.010R < 0.10R; hit rate 0.0% < 35% |
| 5 | 2025-04-03→2025-07-02 | 1 | 100.0 | 0.479 | 1.14 | $82 | ❌ | trades 1 < 4 |
| 6 | 2025-07-02→2025-09-30 | 1 | 0.0 | -1.007 | 1.28 | $-280 | ❌ | trades 1 < 4; expectancy -1.007R < 0.10R; hit rate 0.0% < 35% |
| 7 | 2025-09-30→2025-12-30 | 2 | 0.0 | -1.008 | 3.08 | $-573 | ❌ | trades 2 < 4; expectancy -1.008R < 0.10R; hit rate 0.0% < 35% |
| 8 | 2025-12-30→2026-03-30 | 0 | 0.0 | 0.000 | 0.00 | $0 | ❌ | trades 0 < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |

Passing windows (binding): 1 / 9 (acceptance: ≥ 5 / 9)
Failing windows: 8 / 9

## Aggregate (across all 9 test windows)

- Trades: 16
- Hit rate: 43.8%
- Mean expectancy: 0.016R
- Rolling 90d DD (concatenated equity curve): 10.41%

## BB-reentry pre-gate-fire / post-gate-tradeable histogram (per window, test span only)

| Window | BB pre-gate | BB post-gate | BB gated | BTC.D warm-up missing |
| ------ | ----------- | ------------ | -------- | --------------------- |
| 0 | 4 | 3 | 1 | 0 |
| 1 | 15 | 5 | 10 | 0 |
| 2 | 14 | 1 | 13 | 0 |
| 3 | 7 | 3 | 4 | 0 |
| 4 | 14 | 1 | 13 | 0 |
| 5 | 11 | 1 | 10 | 0 |
| 6 | 7 | 1 | 6 | 0 |
| 7 | 13 | 2 | 11 | 0 |
| 8 | 15 | 0 | 15 | 0 |

Pre-gate = post-gate + gated + warm-up-missing per trigger.

## Per-symbol per-window R decomposition

| Window | SOL-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- |
| 0 | 2 / 50% / 0.48R | 1 / 0% / -1.00R |
| 1 | 2 / 100% / 1.33R | 3 / 67% / 0.98R |
| 2 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 3 | 2 / 50% / -0.38R | 1 / 0% / -1.00R |
| 4 | 0 / 0% / 0.00R | 1 / 0% / -1.01R |
| 5 | 1 / 100% / 0.48R | 0 / 0% / 0.00R |
| 6 | 0 / 0% / 0.00R | 1 / 0% / -1.01R |
| 7 | 1 / 0% / -1.01R | 1 / 0% / -1.01R |
| 8 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |

## Side-by-side TRA-296 vs TRA-298 (per window)

| Window | TRA-296 trades | TRA-298 trades | Δ trades | TRA-296 hit% | TRA-298 hit% | TRA-296 R | TRA-298 R | TRA-298 pass? |
| ------ | -------------- | -------------- | -------- | ------------ | ------------ | --------- | --------- | ------------- |
| 0 | 4 | 3 | -1 | 50.0 | 33.3 | 0.483 | -0.013 | ❌ |
| 1 | 16 | 5 | -11 | 50.0 | 80.0 | 0.039 | 1.120 | ✅ |
| 2 | 0 | 0 | +0 | 0.0 | 0.0 | 0.000 | 0.000 | ❌ |
| 3 | 8 | 3 | -5 | 12.5 | 33.3 | -0.849 | -0.585 | ❌ |
| 4 | 0 | 1 | +1 | 0.0 | 0.0 | 0.000 | -1.010 | ❌ |
| 5 | 6 | 1 | -5 | 66.7 | 100.0 | 0.725 | 0.479 | ❌ |
| 6 | 8 | 1 | -7 | 37.5 | 0.0 | 0.105 | -1.007 | ❌ |
| 7 | 1 | 2 | +1 | 0.0 | 0.0 | -1.010 | -1.008 | ❌ |
| 8 | 0 | 0 | +0 | 0.0 | 0.0 | 0.000 | 0.000 | ❌ |

## Decision

**FAIL** — Only 1 / 9 windows clear all four binding §8 bars (≥ 5 / 9 required). Per task spec, do **not** silently tune. Reassign back to QuantTrader with the per-window pre-gate vs post-gate trade counts (above), per-window BB-reentry-only expectancy (was W3 still negative without ATR-pullback?), and explicit notes on whether SMA(20) recovered density on TRA-296's W2/W4/W7/W8 dead-zones.