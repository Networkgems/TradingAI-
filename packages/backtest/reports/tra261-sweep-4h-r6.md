# TRA-261 — §8 4H Walk-Forward Sweep Report (r6 sidecar — TRA-255 §4.4 Layer 3)

> **r6 sidecar — preserves the r3 → r4 → r5 → r6 audit trail.** Snapshot of the
> [TRA-255](/TRA/issues/TRA-255#document-strategy) §4.4 r6 4H sweep run on 2026-05-03.
> r4 (Layer 1) and r5 (Layer 2) sidecars stayed at 0 / 9 trades, which matched
> the in-flight harness behaviour described in those revisions but masked any
> real entry-trigger evidence: a pre-existing harness bug had XRP (listed
> mid-2023 on Coinbase Exchange) shift index-based walk-forward windowing out
> of sync with BTC / ETH / SOL / DOGE, so the per-window `baseTimestamps`
> intersection across the 5-symbol universe was empty for every window. r6
> lands the cascade-leg trigger ([TRA-275](/TRA/issues/TRA-275)), the
> Breakout-short 4H knob relaxations, and the universe-alignment fix.
>
> With alignment fixed, the cascade-leg trigger fires across every walk-forward
> window: 67 trades total across 9 windows, **density bar (≥ 6 of 9 with > 0
> trades) MET** (9 / 9 fire), §8 acceptance bars met in 3 / 9 windows
> (1, 7, 8). Rolling-90d short-book DD comfortably under the 8% bar at 3.47%.
> Reassigned to QuantTrader for cascade-trigger parameter revision per §4.4
> r6 branch ("Density bar met BUT §8 bars miss").

---

# TRA-266 — §8 Walk-Forward Sweep Report (4H Phase-1.1 — TRA-255 r6 §4.4 Layer 3)

Generated: 2026-05-03T13:53:30.099Z

Granularity: 4h
Universe: BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD
Date span: 2023-07-13 → 2026-05-03
Initial equity: $25,000, fees 40 bps taker, slippage 5 bps
Walk-forward: train=10804h, test=5404h, step=5404h, windows=9

## §8 Acceptance bars

| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Reasons |
| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | ------- |
| 0 | 2024-01-09→2024-04-08 | 4 | 25.0 | -0.559 | $-268 | 1.38 | ❌ | expectancy -0.559R < 0.10R; hit rate 25.0% < 35% |
| 1 | 2024-04-08→2024-07-07 | 7 | 42.9 | 0.441 | $129 | 1.44 | ✅ | — |
| 2 | 2024-07-07→2024-10-05 | 6 | 33.3 | -0.143 | $-156 | 1.97 | ❌ | expectancy -0.143R < 0.10R; hit rate 33.3% < 35% |
| 3 | 2024-10-05→2025-01-03 | 2 | 0.0 | -0.621 | $-206 | 1.08 | ❌ | expectancy -0.621R < 0.10R; hit rate 0.0% < 35% |
| 4 | 2025-01-03→2025-04-03 | 9 | 33.3 | 0.086 | $-142 | 2.03 | ❌ | expectancy 0.086R < 0.10R; hit rate 33.3% < 35% |
| 5 | 2025-04-03→2025-07-02 | 12 | 33.3 | -0.066 | $-328 | 3.47 | ❌ | expectancy -0.066R < 0.10R; hit rate 33.3% < 35% |
| 6 | 2025-07-02→2025-09-30 | 6 | 16.7 | -0.377 | $-313 | 1.79 | ❌ | expectancy -0.377R < 0.10R; hit rate 16.7% < 35% |
| 7 | 2025-09-30→2025-12-30 | 11 | 45.5 | 0.181 | $19 | 2.20 | ✅ | — |
| 8 | 2025-12-30→2026-03-30 | 10 | 40.0 | 0.293 | $19 | 1.24 | ✅ | — |

Failing windows: 6 / 9

## Per-symbol per-window summary

| Window | BTC-USD (n / hit% / R) | ETH-USD (n / hit% / R) | SOL-USD (n / hit% / R) | XRP-USD (n / hit% / R) | DOGE-USD (n / hit% / R) |
| ------ | --- | --- | --- | --- | --- |
| 0 | 0 / 0% / 0.00R | 1 / 100% / 0.57R | 1 / 0% / -1.01R | 0 / 0% / 0.00R | 2 / 0% / -0.90R |
| 1 | 0 / 0% / 0.00R | 2 / 0% / -0.12R | 3 / 33% / 0.28R | 0 / 0% / 0.00R | 2 / 100% / 1.24R |
| 2 | 0 / 0% / 0.00R | 3 / 33% / 0.10R | 1 / 100% / 0.37R | 0 / 0% / 0.00R | 2 / 0% / -0.77R |
| 3 | 0 / 0% / 0.00R | 1 / 0% / -0.98R | 1 / 0% / -0.26R | 0 / 0% / 0.00R | 0 / 0% / 0.00R |
| 4 | 0 / 0% / 0.00R | 3 / 33% / 0.35R | 1 / 0% / 0.00R | 2 / 0% / -0.73R | 3 / 67% / 0.39R |
| 5 | 0 / 0% / 0.00R | 4 / 25% / -0.03R | 4 / 50% / 0.16R | 2 / 0% / -0.51R | 2 / 50% / -0.14R |
| 6 | 0 / 0% / 0.00R | 1 / 0% / -0.19R | 2 / 0% / -0.59R | 1 / 100% / 0.87R | 2 / 0% / -0.89R |
| 7 | 0 / 0% / 0.00R | 4 / 50% / 0.03R | 4 / 50% / 0.67R | 1 / 0% / -1.01R | 2 / 50% / 0.09R |
| 8 | 0 / 0% / 0.00R | 2 / 50% / 0.47R | 3 / 33% / -0.02R | 1 / 0% / -0.47R | 4 / 50% / 0.63R |

### Consecutive-failure streaks (spec §8: park ≥ 4)

- BTC-USD: 🔴 PARK (max streak 9)
- ETH-USD: 🔴 PARK (max streak 7)
- SOL-USD: OK (max streak 2)
- XRP-USD: 🔴 PARK (max streak 6)
- DOGE-USD: OK (max streak 3)

## Sensitivity sweep (±20%)

| Knob | Factor | Total PnL | Min window expectancy R | Min window hit % | Rolling 90d DD % | Net positive? | Note |
| ---- | ------ | --------- | ----------------------- | ---------------- | ---------------- | ------------- | ---- |
| baseline | 1.00 | $-1244 | -0.621 | 0.0 | 3.47 | ❌ |  |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 0.80 | $-1244 | -0.621 | 0.0 | 3.47 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 1.20 | $-1244 | -0.621 | 0.0 | 3.47 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| regime hysteresis flipBars | 0.80 | $-1244 | -0.621 | 0.0 | 3.47 | ❌ |  |
| regime hysteresis flipBars | 1.20 | $-1771 | -0.595 | 14.3 | 3.47 | ❌ |  |
| Momentum atrStopMultiplier | 0.80 | $-405 | -0.572 | 0.0 | 2.74 | ❌ |  |
| Momentum atrStopMultiplier | 1.20 | $-232 | -0.335 | 0.0 | 2.70 | ❌ |  |
| Breakout atrStopMultiplier | 0.80 | $-1264 | -0.621 | 0.0 | 3.47 | ❌ |  |
| Breakout atrStopMultiplier | 1.20 | $-1263 | -0.417 | 16.7 | 3.47 | ❌ |  |
| Breakout atrTpMultiplier | 0.80 | $-1245 | -0.621 | 0.0 | 3.47 | ❌ |  |
| Breakout atrTpMultiplier | 1.20 | $-1244 | -0.621 | 0.0 | 3.47 | ❌ |  |

## Pre-route skip reasons (baseline)

| Reason | Count |
| ------ | ----- |
| diagnostic — router emitted no signal | 71933 |
| diagnostic — router emitted a long signal (dropped pre-short-gate) | 477 |
| single-symbol short cap | 205 |
| BTC trend up — alt short blocked | 102 |
| total short notional cap | 14 |
| 3 consecutive short losses — symbol cooldown | 2 |

## Decision

**FAIL** — One or more windows missed §8 acceptance bars. TRA-261 reassigned to QuantTrader for parameter revision per spec §8 protocol.