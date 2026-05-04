# TRA-309 — §8 Walk-Forward Sweep Report (4H Phase-1.2.4 BB+tight-ATR + asset-side EMA(200)+slope(EMA(50)) OR overlay supplementing SMA(50) BTC.D gate — r9 SOL+DOGE)

Generated: 2026-05-04T03:52:57.628Z

Granularity: 4h
Universe: SOL-USD, DOGE-USD (r9 binding)
Date span: 2023-07-13 → 2026-05-04
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=1080×4H, test=540×4H, step=540×4H, windows=9

## Triggers (TRA-309 deltas vs TRA-299/TRA-308)

- **BB-reentry-long (UNCHANGED, TRA-295 spec):** close[i-1] ≤ lower BB(20, 2σ), close[i] > lower BB(20, 2σ), AND RSI(14)[i] > RSI(14)[i-1] with RSI(14)[i-1] < 30. Entry on open of bar i+1.
- **ATR-pullback-long (RE-TIGHTENED to TRA-296 spec, was loose in TRA-299):** close[i-1] ≤ EMA(50)[i-1] − **2.5×ATR(14)[i-1]** *(TRA-299 had 2.0×)*, bullish reversal candle on bar i (close>open AND close>close[i-1]) with volume[i] > **1.5×mean(volume[i-20..i-1])** *(TRA-299 had 1.2×)*, AND **RSI(14)[i-1] < 40** *(TRA-299 had no RSI filter)*. Entry on open of bar i+1.

## Gate (BTC.D leg + asset-side EMA(200)+slope(EMA(50)) leg, OR-combined)

Each candidate trigger fire on bar `i` (4H) is admitted if EITHER:
- **(BTC.D leg, existing)** most-recent-completed daily synthetic BTC.D close < SMA(synthetic BTC.D, 50), OR
- **(asset overlay leg, NEW — replaces TRA-299 plain-EMA(50))** `close[i-1] > EMA(close, 200)[i-1]` **AND** `EMA(close, 50)[i-1] > EMA(close, 50)[i-2]` on the entered asset itself (4H bars). Both sub-conditions are required (internal AND); the asset leg as a whole is OR'd with the BTC.D leg.

Rationale (per TRA-309 §3): TRA-308 found the plain-EMA(50) overlay structurally inert across all 9 windows. ATR-pullback is mathematically excluded (its trigger requires `close < EMA(50) − 2×ATR`, implying `close < EMA(50)`); BB-reentry is empirically excluded — on SOL+DOGE 4H, lower-band-touch coincides 100% with `close < EMA(50)`. EMA(200) on 4H is ~33-day trend baseline — far enough from BB(20)'s ~3-day centering that the geometric coincidence problem from TRA-308 should not recur. The slope(EMA(50)) condition adds independent momentum information that does not share the trigger's anchor. The OR (not AND) at the gate level is deliberate — we *add* firing opportunity, not further restrict.

Source — synthetic 5-coin basket loader (`./btc-dominance-synthetic.ts`), shared with TRA-296/297/298/299. BTC mcap divided by Σ(BTC + ETH + SOL + DOGE + XRP) mcaps using mid-period 2024 circulating-supply constants from existing daily Coinbase caches. Reproducible offline, no API key required.

BTC.D synthetic series: 1584 daily points spanning 2022-01-01 → 2026-05-04; SMA(50) warm-up extended back from 2022-01-01 (≥ 558d before aligned start, comfortably > 50d).

Asset-side EMA(200) warm-up: each window's slice covers train(1080×4H) + test(540×4H) = 1620 bars per asset. The 1080-bar train alone is ≥ 200, so EMA(200) is fully warm at every window's `testStart`. EMA(50) slope (which needs 2 prior values) is warm at `testStart` for the same reason. Confirmed.

Risk knobs (binding, UNCHANGED): 1% account risk per trade, ATR-2.0 stop below entry, 1:2 R:R minimum target, ATR-trail engages at +1R favorable (trail = high-water close − 2.0×ATR(14)).

§5.1 funding gate stays wired direction-aware (no-op for longs).

§8 acceptance bar (UNCHANGED — all four bars binding):
- Density ≥ 4 trades / window (post-gate)
- Hit rate ≥ 35%
- Expectancy ≥ +0.10R
- Rolling-90d DD ≤ 25% (binding per §8.1 amendment ratified in TRA-294 — see reports/SPEC.md)
- Pass criterion: clear all four bars on **≥ 5 of 9** windows.

## §8 Acceptance bars (binding: trades + hit + expectancy + DD90)

| Window | Test span | Trades | Hit % | Expectancy R | DD90 % | Total PnL | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | ------ | --------- | ----- | ------- |
| 0 | 2024-01-09→2024-04-08 | 4 | 50.0 | 0.483 | 2.17 | $382 | PASS | — |
| 1 | 2024-04-08→2024-07-07 | 16 | 50.0 | 0.039 | 7.26 | $-576 | FAIL | expectancy 0.039R < 0.10R |
| 2 | 2024-07-07→2024-10-05 | 0 | 0.0 | 0.000 | 0.00 | $0 | FAIL | trades 0 < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 3 | 2024-10-05→2025-01-03 | 8 | 12.5 | -0.849 | 9.05 | $-1838 | FAIL | expectancy -0.849R < 0.10R; hit rate 12.5% < 35% |
| 4 | 2025-01-03→2025-04-03 | 0 | 0.0 | 0.000 | 0.00 | $0 | FAIL | trades 0 < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 5 | 2025-04-03→2025-07-02 | 6 | 66.7 | 0.725 | 3.82 | $791 | PASS | — |
| 6 | 2025-07-02→2025-09-30 | 8 | 37.5 | 0.105 | 3.86 | $-137 | PASS | — |
| 7 | 2025-09-30→2025-12-30 | 1 | 0.0 | -1.010 | 1.48 | $-304 | FAIL | trades 1 < 4; expectancy -1.010R < 0.10R; hit rate 0.0% < 35% |
| 8 | 2025-12-30→2026-03-30 | 0 | 0.0 | 0.000 | 0.00 | $0 | FAIL | trades 0 < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |

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

## Per-trigger pre-gate-fire / post-gate-tradeable / blocked (per window, test span)

| Window | BB pre-gate | BB post-gate | BB blocked | ATR pre-gate | ATR post-gate | ATR blocked | BTC.D warm-up missing |
| ------ | ----------- | ------------ | ---------- | ------------ | ------------- | ----------- | --------------------- |
| 0 | 4 | 3 | 1 | 4 | 2 | 2 | 0 |
| 1 | 15 | 7 | 8 | 34 | 14 | 20 | 0 |
| 2 | 14 | 0 | 14 | 9 | 0 | 9 | 0 |
| 3 | 7 | 3 | 4 | 10 | 7 | 3 | 0 |
| 4 | 14 | 0 | 14 | 20 | 0 | 20 | 0 |
| 5 | 11 | 5 | 6 | 14 | 1 | 13 | 0 |
| 6 | 7 | 5 | 2 | 9 | 4 | 5 | 0 |
| 7 | 13 | 0 | 13 | 25 | 1 | 24 | 0 |
| 8 | 15 | 0 | 15 | 18 | 0 | 18 | 0 |

Notes: per-trigger pre-gate counts every signal fire (BB and ATR are independent). Post-gate-tradeable = `(BTC.D leg open) OR (asset overlay leg open)` AND BTC.D warm-up satisfied (or asset leg alone admits if warm-up missing). Blocked = BTC.D warm-up satisfied AND neither leg open.

## Per-window per-asset gate-leg attribution (TRA-309 §3 reporting)

Per-trigger fire counts bucketed by which leg(s) of the OR-gate were open on the trigger bar. Counts are independent per trigger (BB and ATR can both fire on the same bar). Pre-gate = BTCD-only + Asset-only + Both + Blocked + warm-up missing.

| Window | Asset | BB pre-gate | BB BTCD-only | BB Asset-only | BB Both | BB Blocked | ATR pre-gate | ATR BTCD-only | ATR Asset-only | ATR Both | ATR Blocked |
| ------ | ----- | ----------- | ------------ | ------------- | ------- | ---------- | ------------ | ------------- | -------------- | -------- | ----------- |
| 0 | SOL-USD | 2 | 2 | 0 | 0 | 0 | 3 | 2 | 0 | 0 | 1 |
| 0 | DOGE-USD | 2 | 1 | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 1 |
| 1 | SOL-USD | 6 | 2 | 0 | 0 | 4 | 14 | 7 | 0 | 0 | 7 |
| 1 | DOGE-USD | 9 | 5 | 0 | 0 | 4 | 20 | 7 | 0 | 0 | 13 |
| 2 | SOL-USD | 7 | 0 | 0 | 0 | 7 | 4 | 0 | 0 | 0 | 4 |
| 2 | DOGE-USD | 7 | 0 | 0 | 0 | 7 | 5 | 0 | 0 | 0 | 5 |
| 3 | SOL-USD | 4 | 2 | 0 | 0 | 2 | 5 | 4 | 0 | 0 | 1 |
| 3 | DOGE-USD | 3 | 1 | 0 | 0 | 2 | 5 | 3 | 0 | 0 | 2 |
| 4 | SOL-USD | 6 | 0 | 0 | 0 | 6 | 10 | 0 | 0 | 0 | 10 |
| 4 | DOGE-USD | 8 | 0 | 0 | 0 | 8 | 10 | 0 | 0 | 0 | 10 |
| 5 | SOL-USD | 5 | 3 | 0 | 0 | 2 | 4 | 0 | 0 | 0 | 4 |
| 5 | DOGE-USD | 6 | 2 | 0 | 0 | 4 | 10 | 1 | 0 | 0 | 9 |
| 6 | SOL-USD | 3 | 2 | 0 | 0 | 1 | 4 | 1 | 0 | 0 | 3 |
| 6 | DOGE-USD | 4 | 3 | 0 | 0 | 1 | 5 | 3 | 0 | 0 | 2 |
| 7 | SOL-USD | 6 | 0 | 0 | 0 | 6 | 13 | 1 | 0 | 0 | 12 |
| 7 | DOGE-USD | 7 | 0 | 0 | 0 | 7 | 12 | 0 | 0 | 0 | 12 |
| 8 | SOL-USD | 6 | 0 | 0 | 0 | 6 | 9 | 0 | 0 | 0 | 9 |
| 8 | DOGE-USD | 9 | 0 | 0 | 0 | 9 | 9 | 0 | 0 | 0 | 9 |

Reading guide:
- **Asset-only** counts are the new opportunity the asset-overlay opens (signals BTC.D-only would have blocked).
- A window where BB Asset-only > 0 (or ATR Asset-only > 0) tells us the EMA(200)+slope leg is no longer structurally inert as it was in TRA-308.
- A window where Asset-only ≈ 0 but Both > 0 means the leg was active but fully redundant with the BTC.D leg in that window — coverage was not opened.

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

## Side-by-side TRA-296 vs TRA-309 (per window)

| Window | TRA-296 trades | TRA-309 trades | Δ trades | TRA-296 hit% | TRA-309 hit% | TRA-296 R | TRA-309 R | TRA-296 DD90% | TRA-309 DD90% | TRA-296 pass? | TRA-309 pass? |
| ------ | -------------- | -------------- | -------- | ------------ | ------------ | --------- | --------- | ------------- | ------------- | ------------- | ------------- |
| 0 | 4 | 4 | +0 | 50.0 | 50.0 | 0.483 | 0.483 | 2.17 | 2.17 | PASS | PASS |
| 1 | 16 | 16 | +0 | 50.0 | 50.0 | 0.039 | 0.039 | 7.26 | 7.26 | FAIL | FAIL |
| 2 | 0 | 0 | +0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.00 | 0.00 | FAIL | FAIL |
| 3 | 8 | 8 | +0 | 12.5 | 12.5 | -0.849 | -0.849 | 9.05 | 9.05 | FAIL | FAIL |
| 4 | 0 | 0 | +0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.00 | 0.00 | FAIL | FAIL |
| 5 | 6 | 6 | +0 | 66.7 | 66.7 | 0.725 | 0.725 | 3.82 | 3.82 | PASS | PASS |
| 6 | 8 | 8 | +0 | 37.5 | 37.5 | 0.105 | 0.105 | 3.86 | 3.86 | PASS | PASS |
| 7 | 1 | 1 | +0 | 0.0 | 0.0 | -1.010 | -1.010 | 1.48 | 1.48 | FAIL | FAIL |
| 8 | 0 | 0 | +0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.00 | 0.00 | FAIL | FAIL |

## Decision

**FAIL** — Only 3 / 9 windows clear all four binding §8 bars (≥ 5 / 9 required). Per task spec, do **not** silently tune. Reassign back to QuantTrader with the per-leg fire counts (above), per-window working-set comparison vs TRA-296, and W3 status. Possible follow-ups (QuantTrader call per TRA-309 'Final gate-side iteration'):
- **≥ 4 / 9 with new asset-leg active and decoupled:** QuantTrader judgement on whether to tune ATR-pullback params (§1 carve-out only) or accept partial-coverage.
- **≤ 3 / 9 OR new asset-leg structurally inert again:** accept partial-coverage acceptance (handle (3) per TRA-308 recommendation §3). TRA-296 (3/9: W0/W5/W6) remains the validated SOL+DOGE 4H mean-rev-long strategy. Pivot to complementary BTC-favorable / dead-zone strategy work for W2/W4/W7/W8 (separate child of TRA-291).