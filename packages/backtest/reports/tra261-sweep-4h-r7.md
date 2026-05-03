# TRA-261 — §8 4H Walk-Forward Sweep Report (r7 sidecar — TRA-255 §4.4 Layer 3 cascade-trigger parameter revision)

> **r7 sidecar — preserves the r3 → r4 → r5 → r6 → r7 audit trail.** Snapshot
> of the [TRA-255](/TRA/issues/TRA-255#document-strategy) §4.4 Layer 3 r7 4H
> sweep run on 2026-05-03. r7 retunes three numeric primitives inside the r6
> cascade-leg trigger per the §4.4 r6 "density met but §8 misses" branch:
> drop-bar `1.5× → 1.25× ATR(14)`, recent-high anchor `0.95 → 0.97 ×
> max(high, 20)`, volume `1.5× → 1.75× SMA(volume, 20)`. Trigger structure
> (drop-bar AND lower-33% close AND volume AND recent-high anchor AND
> softened daily-regime gate `!== 'trend_up'`) byte-unchanged from r6.
> Breakout-short 4H knobs, §3 / §5 / §6 / §7 risk controls, and §4.1 stop /
> TP / trail / time-stop / re-arm stay byte-unchanged.
>
> **Result:**
>
> * **Density bar:** **MET** — 9 / 9 windows fire, 61 trades total (r6:
>   67). Density is approximately neutral relative to r6 (the magnitude
>   relaxation pulls more candidate bars in; the tighter recent-high anchor
>   and 1.75× volume floor filter a comparable number out).
> * **§8 acceptance:** **4 / 9 windows pass** (windows 1, 2, 7, 8). r6 passed
>   3 / 9 (1, 7, 8) — window 2 flipped from FAIL to PASS under r7. Failing
>   windows: 0, 3, 4, 5, 6.
> * **§8 universe-rollup totals:** -$598 PnL (r6: -$1,244 — 52% improvement),
>   rolling-90d short-book DD 3.45% (r6: 3.47%, both inside the 8% bar).
> * **BTC density check:** **0 / 9 windows fired any BTC trade** — the
>   smoking-gun diagnostic from r6 *did not unblock* under the drop-bar
>   relaxation. The volume retune (1.5 → 1.75×) appears to be the new
>   binding gate on BTC: its 4H cascade flushes don't reliably print at
>   1.75× the trailing 20-bar volume SMA on Coinbase Phase-1 history.
> * **Per-symbol streaks (§8 PARK threshold ≥ 4):** BTC PARK (streak 9 —
>   never fired), ETH PARK (streak 4 — improved from r6 streak 7), XRP
>   PARK (streak 5 — improved from r6 streak 6), SOL OK (streak 3), DOGE
>   OK (streak 2 — improved from r6 streak 3).
>
> **Decision:** **FAIL** — three numeric retunes within the §4.4 r6 branch
> menu have been exhausted. Per the §4.4 r7 spec branch ("Density bar met
> BUT ≤ 4 / 9 windows pass §8"), reassigning to QuantTrader for **Layer 3
> structural revision (v2 strategy ticket per §4.4)**. The BTC 0 / 9
> persistence is the structural-evidence flag — the cascade-leg trigger
> (drop-bar + close-in-lower-33% + volume + recent-high anchor + softened
> daily-regime) does not match BTC's Coinbase 4H distribution at any of the
> r6/r7 parameter points, suggesting the BTC short layer needs a different
> trigger family (e.g. liquidation-impulse driven, OI-delta driven, or a
> mean-reversion/RSI-extreme bracket distinct from the alt cluster's cascade
> flush profile). r8+ retunes within the r6/r7 numeric envelope are
> unlikely to recover BTC density.
>
> Sensitivity sweep r7 confirms the §4.1 stop multiplier still has
> meaningful headroom: `Momentum.atrStopMultiplier 1.20×` cuts the
> universe-rollup loss from -$598 → -$85 (86% improvement, vs r6 sweep's
> 0.80× factor at -$1,244 → -$405). Direction flipped vs r6 — under r7's
> tighter cascade gate the longer-tailed stop now adds expectancy by
> outliving the immediate post-entry bounces. Captured here for the future
> §4.1 review prompt; out of scope for r7 / r8.

---

# TRA-266 — §8 Walk-Forward Sweep Report (4H Phase-1.1 — TRA-255 r7 §4.4 Layer 3)

Generated: 2026-05-03T15:08:33.149Z

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
| 5 | 2025-04-03→2025-07-02 | 10 | 40.0 | 0.100 | $-151 | 2.30 | ❌ | expectancy 0.100R < 0.10R |
| 6 | 2025-07-02→2025-09-30 | 8 | 37.5 | -0.243 | $-318 | 1.47 | ❌ | expectancy -0.243R < 0.10R |
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
| baseline | 1.00 | $-598 | -0.897 | 0.0 | 3.45 | ❌ |  |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 0.80 | $-598 | -0.897 | 0.0 | 3.45 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 1.20 | $-598 | -0.897 | 0.0 | 3.45 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| regime hysteresis flipBars | 0.80 | $-598 | -0.897 | 0.0 | 3.45 | ❌ |  |
| regime hysteresis flipBars | 1.20 | $-929 | -0.619 | 16.7 | 3.16 | ❌ |  |
| Momentum atrStopMultiplier | 0.80 | $-903 | -1.013 | 0.0 | 2.85 | ❌ |  |
| Momentum atrStopMultiplier | 1.20 | $-85 | -0.489 | 0.0 | 3.27 | ❌ |  |
| Breakout atrStopMultiplier | 0.80 | $-658 | -0.897 | 0.0 | 3.38 | ❌ |  |
| Breakout atrStopMultiplier | 1.20 | $-626 | -0.556 | 25.0 | 4.01 | ❌ |  |
| Breakout atrTpMultiplier | 0.80 | $-498 | -0.897 | 0.0 | 3.45 | ❌ |  |
| Breakout atrTpMultiplier | 1.20 | $-597 | -0.897 | 0.0 | 3.45 | ❌ |  |

## Pre-route skip reasons (baseline)

| Reason | Count |
| ------ | ----- |
| diagnostic — router emitted no signal | 71946 |
| diagnostic — router emitted a long signal (dropped pre-short-gate) | 471 |
| single-symbol short cap | 208 |
| BTC trend up — alt short blocked | 98 |
| total short notional cap | 3 |
| 3 consecutive short losses — symbol cooldown | 3 |
| cross-strategy per-symbol short cap | 3 |

## Decision

**FAIL** — One or more windows missed §8 acceptance bars. TRA-261 reassigned to QuantTrader for parameter revision per spec §8 protocol.
