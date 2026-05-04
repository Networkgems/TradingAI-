# TRA-299 — §8 Walk-Forward Sweep Report (4H Phase-1.2.3 BB+ATR + asset-side EMA(50) overlay supplementing SMA(50) BTC.D gate — r9 SOL+DOGE)

Generated: 2026-05-04T03:34:50.561Z

Granularity: 4h
Universe: SOL-USD, DOGE-USD (r9 binding)
Date span: 2023-07-13 → 2026-05-04
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=1080×4H, test=540×4H, step=540×4H, windows=9

## Triggers (TRA-299 deltas vs TRA-296)

- **BB-reentry-long (UNCHANGED, TRA-295 spec):** close[i-1] ≤ lower BB(20, 2σ), close[i] > lower BB(20, 2σ), AND RSI(14)[i] > RSI(14)[i-1] with RSI(14)[i-1] < 30. Entry on open of bar i+1.
- **ATR-pullback-long (REVERTED to TRA-295, was tightened in TRA-296):** close[i-1] ≤ EMA(50)[i-1] − **2.0×ATR(14)[i-1]** *(TRA-296 had 2.5×)*, bullish reversal candle on bar i (close>open AND close>close[i-1]) with volume[i] > **1.2×mean(volume[i-20..i-1])** *(TRA-296 had 1.5×)*, **NO RSI(14)[i-1] < 40 filter** *(TRA-296 added; reverted)*. Entry on open of bar i+1.

## Gate (BTC.D leg + asset-side EMA(50) leg, OR-combined)

Each candidate trigger fire on bar `i` (4H) is admitted if EITHER:
- **(BTC.D leg, existing)** most-recent-completed daily synthetic BTC.D close < SMA(synthetic BTC.D, 50), OR
- **(EMA leg, NEW)** `close[i-1] > EMA(close, 50)[i-1]` on the entered asset itself (4H bars).

Rationale (per TRA-308 §3): TRA-298 confirmed dead-zone windows W2/W4/W7/W8 had synthetic BTC.D monotonically rising — no trailing MA on a monotone-up series ever flips below — so the BTC.D-only gate never opens those quarters. The OR with an asset-side trend filter admits BB-reentry candidates during BTC-favorable quarters when the asset itself is in an uptrend. The OR (not AND) is deliberate — we *add* firing opportunity, not further restrict.

Note: ATR-pullback fires only when `close[i-1] ≤ EMA(50)[i-1] − 2.0×ATR(14)[i-1]`, which by definition implies `close[i-1] < EMA(50)[i-1]`. So the EMA(50) leg can NEVER admit an ATR-pullback signal — only BB-reentry-long benefits from this overlay.

Source — synthetic 5-coin basket loader (`./btc-dominance-synthetic.ts`), shared with TRA-296/297/298. BTC mcap divided by Σ(BTC + ETH + SOL + DOGE + XRP) mcaps using mid-period 2024 circulating-supply constants from existing daily Coinbase caches. Reproducible offline, no API key required.

BTC.D synthetic series: 1584 daily points spanning 2022-01-01 → 2026-05-04; SMA(50) warm-up extended back from 2022-01-01 (≥ 558d before aligned start, comfortably > 50d).

Asset-side EMA(50) warm-up: each window's slice covers train(1080×4H) + test(540×4H) = 1620 bars per asset, well above the 50-bar warm-up requirement. The EMA leg is fully warm at every window's `testStart`. Confirmed.

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
| 0 | 2024-01-09→2024-04-08 | 9 | 44.4 | 0.134 | 4.42 | $-57 | PASS | — |
| 1 | 2024-04-08→2024-07-07 | 23 | 34.8 | -0.279 | 12.69 | $-2571 | FAIL | expectancy -0.279R < 0.10R; hit rate 34.8% < 35% |
| 2 | 2024-07-07→2024-10-05 | 0 | 0.0 | 0.000 | 0.00 | $0 | FAIL | trades 0 < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 3 | 2024-10-05→2025-01-03 | 12 | 16.7 | -0.715 | 11.12 | $-2201 | FAIL | expectancy -0.715R < 0.10R; hit rate 16.7% < 35% |
| 4 | 2025-01-03→2025-04-03 | 0 | 0.0 | 0.000 | 0.00 | $0 | FAIL | trades 0 < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 5 | 2025-04-03→2025-07-02 | 8 | 62.5 | 0.662 | 5.65 | $896 | PASS | — |
| 6 | 2025-07-02→2025-09-30 | 12 | 33.3 | 0.071 | 4.96 | $-290 | FAIL | expectancy 0.071R < 0.10R; hit rate 33.3% < 35% |
| 7 | 2025-09-30→2025-12-30 | 2 | 0.0 | -1.010 | 2.84 | $-604 | FAIL | trades 2 < 4; expectancy -1.010R < 0.10R; hit rate 0.0% < 35% |
| 8 | 2025-12-30→2026-03-30 | 4 | 25.0 | -0.416 | 3.07 | $-608 | FAIL | expectancy -0.416R < 0.10R; hit rate 25.0% < 35% |

Passing windows (binding): 2 / 9 (acceptance: ≥ 5 / 9)
Failing windows: 7 / 9

## Aggregate (across all 9 test windows)

- Trades: 70
- Hit rate: 34.3%
- Mean expectancy: -0.162R
- Rolling 90d DD (concatenated equity curve): 12.69%

## Per-trigger aggregate decomposition (post-gate trades only)

| Trigger | Trades | Winners | Hit % | Expectancy R |
| ------- | ------ | ------- | ----- | ------------ |
| bb_reentry_long | 23 | 11 | 47.8 | 0.091 |
| atr_pullback_long | 47 | 13 | 27.7 | -0.286 |

## Per-trigger pre-gate-fire / post-gate-tradeable / blocked (per window, test span)

| Window | BB pre-gate | BB post-gate | BB blocked | ATR pre-gate | ATR post-gate | ATR blocked | BTC.D warm-up missing |
| ------ | ----------- | ------------ | ---------- | ------------ | ------------- | ----------- | --------------------- |
| 0 | 4 | 3 | 1 | 14 | 7 | 7 | 0 |
| 1 | 15 | 7 | 8 | 55 | 22 | 33 | 0 |
| 2 | 14 | 0 | 14 | 20 | 0 | 20 | 0 |
| 3 | 7 | 3 | 4 | 18 | 11 | 7 | 0 |
| 4 | 14 | 0 | 14 | 40 | 0 | 40 | 0 |
| 5 | 11 | 5 | 6 | 21 | 3 | 18 | 0 |
| 6 | 7 | 5 | 2 | 16 | 9 | 7 | 0 |
| 7 | 13 | 0 | 13 | 56 | 2 | 54 | 0 |
| 8 | 15 | 0 | 15 | 45 | 4 | 41 | 0 |

Notes: per-trigger pre-gate counts every signal fire (BB and ATR are independent). Post-gate-tradeable = `(BTC.D leg open) OR (asset-side EMA(50) leg open)` AND BTC.D warm-up satisfied (or EMA leg alone admits if warm-up missing). Blocked = BTC.D warm-up satisfied AND neither leg open.

## Per-window per-asset gate-leg attribution (TRA-308 §3 reporting)

Per-trigger fire counts bucketed by which leg(s) of the OR-gate were open on the trigger bar. Counts are independent per trigger (BB and ATR can both fire on the same bar). Pre-gate = BTCD-only + EMA-only + Both + Blocked + warm-up missing.

| Window | Asset | BB pre-gate | BB BTCD-only | BB EMA-only | BB Both | BB Blocked | ATR pre-gate | ATR BTCD-only | ATR EMA-only | ATR Both | ATR Blocked |
| ------ | ----- | ----------- | ------------ | ----------- | ------- | ---------- | ------------ | ------------- | ------------ | -------- | ----------- |
| 0 | SOL-USD | 2 | 2 | 0 | 0 | 0 | 7 | 5 | 0 | 0 | 2 |
| 0 | DOGE-USD | 2 | 1 | 0 | 0 | 1 | 7 | 2 | 0 | 0 | 5 |
| 1 | SOL-USD | 6 | 2 | 0 | 0 | 4 | 26 | 12 | 0 | 0 | 14 |
| 1 | DOGE-USD | 9 | 5 | 0 | 0 | 4 | 29 | 10 | 0 | 0 | 19 |
| 2 | SOL-USD | 7 | 0 | 0 | 0 | 7 | 9 | 0 | 0 | 0 | 9 |
| 2 | DOGE-USD | 7 | 0 | 0 | 0 | 7 | 11 | 0 | 0 | 0 | 11 |
| 3 | SOL-USD | 4 | 2 | 0 | 0 | 2 | 12 | 8 | 0 | 0 | 4 |
| 3 | DOGE-USD | 3 | 1 | 0 | 0 | 2 | 6 | 3 | 0 | 0 | 3 |
| 4 | SOL-USD | 6 | 0 | 0 | 0 | 6 | 22 | 0 | 0 | 0 | 22 |
| 4 | DOGE-USD | 8 | 0 | 0 | 0 | 8 | 18 | 0 | 0 | 0 | 18 |
| 5 | SOL-USD | 5 | 3 | 0 | 0 | 2 | 9 | 1 | 0 | 0 | 8 |
| 5 | DOGE-USD | 6 | 2 | 0 | 0 | 4 | 12 | 2 | 0 | 0 | 10 |
| 6 | SOL-USD | 3 | 2 | 0 | 0 | 1 | 6 | 1 | 0 | 0 | 5 |
| 6 | DOGE-USD | 4 | 3 | 0 | 0 | 1 | 10 | 8 | 0 | 0 | 2 |
| 7 | SOL-USD | 6 | 0 | 0 | 0 | 6 | 24 | 1 | 0 | 0 | 23 |
| 7 | DOGE-USD | 7 | 0 | 0 | 0 | 7 | 32 | 1 | 0 | 0 | 31 |
| 8 | SOL-USD | 6 | 0 | 0 | 0 | 6 | 21 | 1 | 0 | 0 | 20 |
| 8 | DOGE-USD | 9 | 0 | 0 | 0 | 9 | 24 | 3 | 0 | 0 | 21 |

Reading guide:
- **EMA-only** counts are the new opportunity the asset-overlay opens (BB-reentries that BTC.D-only would have blocked).
- ATR EMA-only is structurally always 0 (the trigger requires close[i-1] < EMA50[i-1]).
- A window where BB EMA-only ≈ BB Blocked-pre-overlay tells us the overlay rescued the trigger; if EMA-only is small or zero, the overlay was inert in that window.

## Per-symbol per-window R decomposition

| Window | SOL-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- |
| 0 | 6 / 67% / 0.71R | 3 / 0% / -1.01R |
| 1 | 12 / 42% / -0.04R | 11 / 27% / -0.54R |
| 2 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 3 | 9 / 22% / -0.62R | 3 / 0% / -1.01R |
| 4 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 5 | 4 / 75% / 0.85R | 4 / 50% / 0.48R |
| 6 | 3 / 67% / 0.97R | 9 / 22% / -0.23R |
| 7 | 1 / 0% / -1.01R | 1 / 0% / -1.01R |
| 8 | 1 / 0% / -1.02R | 3 / 33% / -0.22R |

## Per-trigger per-window decomposition (post-gate trades only)

| Window | BB-reentry (n / hit% / R) | ATR-pullback (n / hit% / R) |
| ------ | ------------------------- | --------------------------- |
| 0 | 3 / 33% / -0.01R | 6 / 50% / 0.21R |
| 1 | 7 / 57% / 0.08R | 16 / 25% / -0.44R |
| 2 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 3 | 3 / 33% / -0.59R | 9 / 11% / -0.76R |
| 4 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 5 | 5 / 60% / 0.48R | 3 / 67% / 0.97R |
| 6 | 5 / 40% / 0.18R | 7 / 29% / -0.01R |
| 7 | 0 / 0% / 0.00R | 2 / 0% / -1.01R |
| 8 | 0 / 0% / 0.00R | 4 / 25% / -0.42R |

## Side-by-side TRA-296 vs TRA-299 (per window)

| Window | TRA-296 trades | TRA-299 trades | Δ trades | TRA-296 hit% | TRA-299 hit% | TRA-296 R | TRA-299 R | TRA-296 DD90% | TRA-299 DD90% | TRA-296 pass? | TRA-299 pass? |
| ------ | -------------- | -------------- | -------- | ------------ | ------------ | --------- | --------- | ------------- | ------------- | ------------- | ------------- |
| 0 | 4 | 9 | +5 | 50.0 | 44.4 | 0.483 | 0.134 | 2.17 | 4.42 | PASS | PASS |
| 1 | 16 | 23 | +7 | 50.0 | 34.8 | 0.039 | -0.279 | 7.26 | 12.69 | FAIL | FAIL |
| 2 | 0 | 0 | +0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.00 | 0.00 | FAIL | FAIL |
| 3 | 8 | 12 | +4 | 12.5 | 16.7 | -0.849 | -0.715 | 9.05 | 11.12 | FAIL | FAIL |
| 4 | 0 | 0 | +0 | 0.0 | 0.0 | 0.000 | 0.000 | 0.00 | 0.00 | FAIL | FAIL |
| 5 | 6 | 8 | +2 | 66.7 | 62.5 | 0.725 | 0.662 | 3.82 | 5.65 | PASS | PASS |
| 6 | 8 | 12 | +4 | 37.5 | 33.3 | 0.105 | 0.071 | 3.86 | 4.96 | PASS | FAIL |
| 7 | 1 | 2 | +1 | 0.0 | 0.0 | -1.010 | -1.010 | 1.48 | 2.84 | FAIL | FAIL |
| 8 | 0 | 4 | +4 | 0.0 | 25.0 | 0.000 | -0.416 | 0.00 | 3.07 | FAIL | FAIL |

## Decision

**FAIL** — Only 2 / 9 windows clear all four binding §8 bars (≥ 5 / 9 required). Per task spec, do **not** silently tune. Reassign back to QuantTrader with the per-leg fire counts (above), per-window working-set comparison vs TRA-296, and W3 status. Possible follow-ups (QuantTrader call, in priority order):
1. **Different regime proxy** — TOTAL3/TOTAL ratio (excluding BTC, ETH, stables), or asset-only proxy `close > EMA(200) AND slope(EMA(50)) > 0`.
2. **Different trigger family** — RSI bullish divergence, VWAP-revert intraday. Only if BB+ATR with overlay aggregates negative.
3. **Accept partial-coverage acceptance** — concede mean-rev long is a 5/9-quarter-coverage strategy on SOL+DOGE 4H r9; universe needs a complementary BTC-favorable strategy. (Scope-redefinition decision, not a tuning iteration.)