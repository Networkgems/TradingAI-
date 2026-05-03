# TRA-296 — §8 Walk-Forward Sweep Report (4H Phase-1.2.1 regime-gated mean-reversion long — r9 SOL+DOGE)

Generated: 2026-05-03T22:19:30.297Z

Granularity: 4h
Universe: SOL-USD, DOGE-USD (r9 binding — TRA-292 Momentum-long & Breakout-long parked for 4H/r9)
Date span: 2023-07-13 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=1080×4H, test=540×4H, step=540×4H, windows=9

## Triggers (TRA-296 deltas vs TRA-295)

- **BB-reentry-long (UNCHANGED):** close[i-1] ≤ lower BB(20, 2σ), close[i] > lower BB(20, 2σ), AND RSI(14)[i] > RSI(14)[i-1] with RSI(14)[i-1] < 30. Entry on open of bar i+1.
- **ATR-pullback-long (TIGHTENED):** close[i-1] ≤ EMA(50)[i-1] − **2.5×ATR(14)[i-1]** *(was 2.0×)*, **RSI(14)[i-1] < 40** *(NEW)*, bullish reversal candle on bar i (close>open AND close>close[i-1]) with volume[i] > **1.5×mean(volume[i-20..i-1])** *(was 1.2×)*. Entry on open of bar i+1.

## BTC-dominance regime gate (new, binding)

Daily BTC-dominance series with a 50-period SMA filter. On 4H bar i, look up the most-recent-completed daily BTC.D close; if ≥ SMA(50) the entry is suppressed (BTC-favorable regime), if below the entry is allowed (alt-favorable regime).

Source — synthetic 5-coin basket (LeadDev choice; rationale documented in harness header). BTC mcap divided by Σ(BTC + ETH + SOL + DOGE + XRP) mcaps using mid-period 2024 circulating-supply constants from existing daily Coinbase caches. Reproducible offline, no API key required. The synthetic basket overstates BTC.D in absolute terms (excludes USDT/USDC/BNB/etc.) but tracks the *trend* of real CRYPTOCAP:BTC.D, which is what the regime gate cares about.

BTC.D synthetic series: 1584 daily points spanning 2022-01-01 → 2026-05-03; SMA(50) warm-up extended back from 2022-01-01 (≥ 558d before aligned start, comfortably > 50d).

Risk knobs (binding, UNCHANGED): 1% account risk per trade, ATR-2.0 stop below entry, 1:2 R:R minimum target, ATR-trail engages at +1R favorable (trail = high-water close − 2.0×ATR(14)).

§5.1 funding gate stays wired direction-aware (no-op for longs).

§8 acceptance bar (TRA-296 — all four bars binding):
- Density ≥ 4 trades / window (post-gate)
- Hit rate ≥ 35%
- Expectancy ≥ +0.10R
- Rolling-90d DD ≤ 25% (binding now per §8.1 amendment ratified in TRA-294 — see reports/SPEC.md)
- Pass criterion: clear all four bars on **≥ 5 of 9** windows.

## §8 Acceptance bars (binding: trades + hit + expectancy + DD90)

| Window | Test span | Trades | Hit % | Expectancy R | DD90 % | Total PnL | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | ------ | --------- | ----- | ------- |
| 0 | 2024-01-09→2024-04-08 | 4 | 50.0 | 0.483 | 2.17 | $382 | ✅ | — |
| 1 | 2024-04-08→2024-07-07 | 16 | 50.0 | 0.039 | 7.26 | $-576 | ❌ | expectancy 0.039R < 0.10R |
| 2 | 2024-07-07→2024-10-05 | 0 | 0.0 | 0.000 | 0.00 | $0 | ❌ | trades 0 < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 3 | 2024-10-05→2025-01-03 | 8 | 12.5 | -0.849 | 9.05 | $-1838 | ❌ | expectancy -0.849R < 0.10R; hit rate 12.5% < 35% |
| 4 | 2025-01-03→2025-04-03 | 0 | 0.0 | 0.000 | 0.00 | $0 | ❌ | trades 0 < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 5 | 2025-04-03→2025-07-02 | 6 | 66.7 | 0.725 | 3.82 | $791 | ✅ | — |
| 6 | 2025-07-02→2025-09-30 | 8 | 37.5 | 0.105 | 3.86 | $-137 | ✅ | — |
| 7 | 2025-09-30→2025-12-30 | 1 | 0.0 | -1.010 | 1.48 | $-304 | ❌ | trades 1 < 4; expectancy -1.010R < 0.10R; hit rate 0.0% < 35% |
| 8 | 2025-12-30→2026-03-30 | 0 | 0.0 | 0.000 | 0.00 | $0 | ❌ | trades 0 < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |

Passing windows (binding): 3 / 9 (acceptance: ≥ 5 / 9)
Failing windows: 6 / 9

## Aggregate (across all 9 test windows)

- Trades: 43
- Hit rate: 41.9%
- Mean expectancy: -0.001R
- Rolling 90d DD (concatenated equity curve): 10.15%

## Per-trigger aggregate decomposition (post-gate trades only)

| Trigger | Trades | Winners | Hit % | Expectancy R |
| ------- | ------ | ------- | ----- | ------------ |
| bb_reentry_long | 23 | 11 | 47.8 | 0.091 |
| atr_pullback_long | 20 | 7 | 35.0 | -0.106 |

## Per-trigger pre-gate-fire / post-gate-tradeable histogram (per window, test span only)

| Window | BB pre-gate | BB post-gate | BB gated | ATR pre-gate | ATR post-gate | ATR gated | BTC.D warm-up missing |
| ------ | ----------- | ------------ | -------- | ------------ | ------------- | --------- | --------------------- |
| 0 | 4 | 3 | 1 | 4 | 2 | 2 | 0 |
| 1 | 15 | 7 | 8 | 34 | 14 | 20 | 0 |
| 2 | 14 | 0 | 14 | 9 | 0 | 9 | 0 |
| 3 | 7 | 3 | 4 | 10 | 7 | 3 | 0 |
| 4 | 14 | 0 | 14 | 20 | 0 | 20 | 0 |
| 5 | 11 | 5 | 6 | 14 | 1 | 13 | 0 |
| 6 | 7 | 5 | 2 | 9 | 4 | 5 | 0 |
| 7 | 13 | 0 | 13 | 25 | 1 | 24 | 0 |
| 8 | 15 | 0 | 15 | 18 | 0 | 18 | 0 |

Notes: pre-gate counts every signal that fires per trigger (independently — both can fire on the same bar). Post-gate is the subset where the BTC.D regime gate was alt-favorable. Gated is the subset where the gate suppressed the signal. Pre-gate = post-gate + gated + warm-up-missing per trigger.

## Per-symbol per-window R decomposition

| Window | SOL-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- |
| 0 | 3 / 67% / 0.98R | 1 / 0% / -1.00R |
| 1 | 7 / 71% / 0.66R | 9 / 33% / -0.44R |
| 2 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 3 | 5 / 20% / -0.76R | 3 / 0% / -1.01R |
| 4 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 5 | 3 / 67% / 0.48R | 3 / 67% / 0.97R |
| 6 | 3 / 67% / 0.97R | 5 / 20% / -0.41R |
| 7 | 1 / 0% / -1.01R | 0 / 0% / 0.00R |
| 8 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |

## Per-trigger per-window decomposition (post-gate trades only)

| Window | BB-reentry (n / hit% / R) | ATR-pullback (n / hit% / R) |
| ------ | ------------------------- | --------------------------- |
| 0 | 3 / 33% / -0.01R | 1 / 100% / 1.97R |
| 1 | 7 / 57% / 0.08R | 9 / 44% / 0.00R |
| 2 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 3 | 3 / 33% / -0.59R | 5 / 0% / -1.01R |
| 4 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 5 | 5 / 60% / 0.48R | 1 / 100% / 1.96R |
| 6 | 5 / 40% / 0.18R | 3 / 33% / -0.02R |
| 7 | 0 / 0% / 0.00R | 1 / 0% / -1.01R |
| 8 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |

## Side-by-side TRA-295 vs TRA-296 (per window)

| Window | TRA-295 trades | TRA-296 trades | Δ trades | TRA-295 hit% | TRA-296 hit% | TRA-295 R | TRA-296 R | TRA-296 pass? |
| ------ | -------------- | -------------- | -------- | ------------ | ------------ | --------- | --------- | ------------- |
| 0 | 16 | 4 | -12 | 56.3 | 50.0 | 0.318 | 0.483 | ✅ |
| 1 | 52 | 16 | -36 | 40.4 | 50.0 | -0.111 | 0.039 | ❌ |
| 2 | 23 | 0 | -23 | 17.4 | 0.0 | -0.525 | 0.000 | ❌ |
| 3 | 17 | 8 | -9 | 17.6 | 12.5 | -0.562 | -0.849 | ❌ |
| 4 | 43 | 0 | -43 | 27.9 | 0.0 | -0.310 | 0.000 | ❌ |
| 5 | 26 | 6 | -20 | 61.5 | 66.7 | 0.229 | 0.725 | ✅ |
| 6 | 14 | 8 | -6 | 28.6 | 37.5 | -0.084 | 0.105 | ✅ |
| 7 | 59 | 1 | -58 | 44.1 | 0.0 | -0.226 | -1.010 | ❌ |
| 8 | 52 | 0 | -52 | 40.4 | 0.0 | 0.050 | 0.000 | ❌ |

## Decision

**FAIL** — Only 3 / 9 windows clear all four binding §8 bars (≥ 5 / 9 required). Per task spec, do **not** silently tune. Reassign back to QuantTrader with the per-window pre-gate vs post-gate trade counts (above), per-trigger split post-gate, and density-failure list (any window where post-gate density dropped below 4 trades).