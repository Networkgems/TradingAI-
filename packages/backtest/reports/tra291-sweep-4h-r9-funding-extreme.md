# TRA-291 — §8 Walk-Forward Sweep Report (4H r9 funding-extreme-short, TRA-293)

Generated: 2026-05-03T21:18:33.082Z

Granularity: 4h
Universe: SOL-USD, DOGE-USD (TRA-255 §4.4 v3 r9)
Date span: 2023-07-13 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=10804h, test=5404h, step=5404h, windows=9

> **§4.4 Layer 3 alternate trigger.** Funding-extreme-short fires when the per-hour funding rate (Binance USD-M `fundingRate` history ÷ 8) is ≥ +0.0005 (= +0.05%/h) for 6 consecutive 8h intervals (= 48h sustained positive carry) at the 4H bar close. Position opens at the next 4H bar open. Stop ATR-2.0 above entry; 1:2 R:R take-profit; ATR-1.5 trail above the lowest-low after +1R; 24-bar time stop; carry-broken force-exit on 2 consecutive 8h intervals ≤ 0%. Cascade-leg trigger is parked on this run (sibling long-side child handles the engine-side park separately) so funding-extreme-short is the only Layer 3 trigger that can fire.

> Funding feed: Binance USD-M futures, ~8h resolution. Live `fapi.binance.com` is geo-blocked from this dev host so the sweep falls back to the public Binance Vision monthly CSV dumps (`data.binance.vision/data/futures/um/monthly/fundingRate/...`). Same 8h-interval rates, no second feed introduced — see `packages/backtest/src/funding-feed.ts`.

## §8 Acceptance bars

| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Trigger fires (raw → trade) | Carry-broken exits | Reasons |
| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | --------------------------- | ------------------ | ------- |
| 0 | 2024-01-09→2024-04-07 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | 0 → 0 | 0 | only 0 trade(s) in window < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 1 | 2024-04-08→2024-07-06 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | 0 → 0 | 0 | only 0 trade(s) in window < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 2 | 2024-07-07→2024-10-04 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | 0 → 0 | 0 | only 0 trade(s) in window < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 3 | 2024-10-05→2025-01-02 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | 0 → 0 | 0 | only 0 trade(s) in window < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 4 | 2025-01-03→2025-04-02 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | 0 → 0 | 0 | only 0 trade(s) in window < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 5 | 2025-04-03→2025-07-01 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | 0 → 0 | 0 | only 0 trade(s) in window < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 6 | 2025-07-02→2025-09-29 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | 0 → 0 | 0 | only 0 trade(s) in window < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 7 | 2025-09-30→2025-12-29 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | 0 → 0 | 0 | only 0 trade(s) in window < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |
| 8 | 2025-12-29→2026-03-29 | 0 | 0.0 | 0.000 | $0 | 0.00 | ❌ | 0 → 0 | 0 | only 0 trade(s) in window < 4; expectancy 0.000R < 0.10R; hit rate 0.0% < 35% |

Passing windows: 0 / 9

## Per-symbol per-window R decomposition

| Window | SOL-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- |
| 0 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 1 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 2 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 3 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 4 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 5 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 6 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 7 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 8 | 0 / 0% / 0.00R | 0 / 0% / 0.00R |

## Aggregate (SOL+DOGE rollup, all windows)

- Trades: 0 (winners 0)
- Hit rate: 0.0%
- Mean expectancy: 0.000R
- Total PnL: $0
- Rolling-90d DD (concatenated): 0.00%
- Trigger fires: 0 raw → 0 trades after universe / cap / cooldown gating
- Carry-broken force exits: 0

## Funding feed coverage

| Symbol | Intervals | First | Last | Min /h | Max /h | Median /h | p99 /h |
| ------ | --------- | ----- | ---- | ------ | ------ | --------- | ------ |
| SOL-USD | 4818 | 2022-01-01 | 2026-04-30 | -2.500e-3 | 1.491e-4 | 6.373e-6 | 6.732e-5 |
| DOGE-USD | 4743 | 2022-01-01 | 2026-04-30 | -1.703e-4 | 1.284e-4 | 1.174e-5 | 6.686e-5 |

## Threshold-sensitivity diagnostic (no positions opened — informational)

Count of bars where the trigger condition would have fired against the per-symbol funding history, varying the per-hour threshold and consecutive-interval count. Binding spec is the **+0.0005/h × 6-interval** row.

| Per-hour threshold | Consecutive intervals | SOL-USD fires | DOGE-USD fires |
| ------------------ | --------------------- | ---- | ---- |
| 0.050% (binding) | 6 | 0 | 0 |
| 0.040% | 6 | 0 | 0 |
| 0.040% | 4 | 0 | 0 |
| 0.050% | 4 | 0 | 0 |
| 0.010% | 6 | 0 | 0 |
| 0.010% | 4 | 0 | 0 |
| 0.008% | 6 | 1 | 0 |
| 0.008% | 4 | 3 | 0 |
| 0.005% | 6 | 5 | 3 |
| 0.005% | 4 | 7 | 6 |
| 0.003% | 6 | 10 | 8 |
| 0.003% | 4 | 12 | 17 |

## Decision

**FAIL — trigger never fires on the r9 universe.** 0 / 9 windows met §8 acceptance bars; the +0.0005/h × 6-interval condition never triggered against the Binance USD-M funding history for SOL+DOGE over the full 4-year span (peak observed: SOL-USD=0.0149%/h, DOGE-USD=0.0128%/h).

The spec-suggested relaxation pass (lower threshold to +0.04%/h, OR shorten consecutive count from 6 → 4, OR both) does **not** move the count off zero — the threshold-sensitivity table above shows the trigger only fires once the per-hour threshold is dropped to ≤ +0.01%/h, and in any meaningful count only at ≤ +0.005%/h.

Per TRA-293 spec, **do not relax the entry threshold here** — reassign to QuantTrader for the relaxation pass with this empirical funding distribution attached. Candidate thresholds the data supports (see "Threshold-sensitivity diagnostic" above): per-hour ≤ +0.008%/h × 6 intervals, or ≤ +0.005%/h × 4 intervals.