# TRA-284 — §8 4H Walk-Forward Sweep Report (v2 sidecar — TRA-255 §4.4 v2 BTC RSI-extreme bracket)

> **v2 sidecar — adds the BTC RSI-extreme bracket on top of the r7
> cascade-leg trigger (alt-cluster path).** Snapshot of the [TRA-255](/TRA/issues/TRA-255#document-strategy)
> §4.4 v2 4H sweep run on 2026-05-03. v2 introduces a structurally distinct
> entry trigger family for BTC-USD only — RSI(14) ≥ 70 + recent-high anchor
> (0.98 × max(high, 20), current-bar excluded) + bearish-rejection candle
> (`close < open` AND close in lower-half range) + softened daily-regime
> gate (`!== 'trend_up'`) — routed via the new
> `paramsByDirection.short.lowCascadeDensitySymbols: ['BTC-USD']` knob.
> Routing is exclusive on `symbol`: BTC-USD evaluates the bracket; alts
> (ETH / SOL / XRP / DOGE) keep the r7 cascade-leg trigger byte-unchanged.
> §4.1 risk knobs (stop / TP / trail / time-stop / re-arm), §3 / §5 / §6
> / §7 controls, breakout-short 4H knobs all stay byte-unchanged from r7.
>
> **Result: FAIL — three of the five v2 acceptance bars miss.**
>
> | Bar | Threshold | v2 result | Pass? |
> | --- | --------- | --------- | ----- |
> | Density (alt non-regression) | > 0 trades in ≥ 6 / 9 windows | 9 / 9 windows fire | ✅ |
> | §8 per-window pass count | ≥ 6 / 9 windows pass §8 | 4 / 9 (windows 1, 2, 7, 8) | ❌ |
> | BTC density | ≥ 1 BTC trade in ≥ 3 / 9 windows | **0 / 9 windows — bracket never fires on BTC** | ❌ |
> | Universe expectancy | ≥ +0.10 R/trade | +0.098 R (volume-weighted, 61 trades) | ❌ (0.002 R below the bar) |
> | Universe hit rate | ≥ 35 % | 39.3 % (24 / 61) | ✅ |
> | Universe rolling-90d DD | ≤ 8 % | 2.13 % (max across windows) | ✅ |
> | Long-side regression | zero | confirmed via `momentum.test.ts` cases shipped in `97feda1` | ✅ |
>
> **Smoking gun — BTC structural mismatch persists across two trigger
> families.** Both r7 (cascade flush: drop-bar + lower-33% close + 1.75×
> volume + recent-high anchor + softened daily-regime) and v2 (RSI extreme
> + recent-high anchor + bearish rejection + softened daily-regime) fire
> **0 / 9 windows on BTC** at spec-default parameters. The cascade-leg and
> the RSI-extreme bracket exhaust the two structural archetypes the spec
> menu enumerated for BTC's 4H Coinbase distribution; both come up dry
> with the spec's recent-high-anchor + softened-regime gating retained as
> common skeleton. The recent-high anchor at 0.98× and the
> `regime !== 'trend_up'` gate appear to be the binding gates on BTC
> across both trigger families — BTC's 4H bars during the 2023-07-13 →
> 2026-05-03 window either don't pull back to the 0.98× recent-high anchor
> when RSI prints overbought, or the daily regime sits in `trend_up` when
> they do. r8+ retunes within the bracket numeric envelope (RSI threshold,
> anchor ratio, range fraction) without lifting either of those two gates
> are unlikely to change the 0/9 outcome.
>
> **Per-symbol totals (61 trades total, $-599 PnL):**
>
> - BTC-USD: **0 trades** (bracket fired 0/9 windows; cascade-leg byte-skipped via routing predicate)
> - ETH-USD: 16 trades, $-514 PnL — cascade-leg path byte-identical to r7
> - SOL-USD: 16 trades, $32 PnL — cascade-leg path byte-identical to r7
> - XRP-USD: 9 trades, $-23 PnL — cascade-leg path byte-identical to r7
> - DOGE-USD: 20 trades, $-93 PnL — cascade-leg path byte-identical to r7
>
> The alt-cluster numbers carry over near-byte-identically from r7 (windows 5
> rolling-90d DD shifts 2.30 → 2.13 % because BTC freeing a `MAX_CONCURRENT_SHORTS`
> slot lets one DOGE / SOL fill earlier). v2 is additive in spirit: it does
> not regress alt density and does not alter alt fills materially. The
> entire delta from r7 is the BTC slot, which ships zero v2 trades.
>
> **Per-symbol streaks (§8 PARK threshold ≥ 4):** BTC PARK (streak 9 — never
> fired under bracket either), ETH PARK (streak 4), XRP PARK (streak 5),
> SOL OK (streak 3), DOGE OK (streak 2). Streaks identical to r7 modulo
> floating-point noise; no symbol moved out of PARK under the v2 bracket.
>
> Sensitivity sweep r8 confirms the §4.1 stop multiplier still has
> direction-flipped headroom: `Momentum.atrStopMultiplier 1.20×` lifts
> universe-rollup from $-599 → $-262 (56 % improvement). Out of scope for
> v2 / r8 — captured for the future §4.1 review prompt.
>
> **Decision:** **FAIL — do not ship.** Per [TRA-284](/TRA/issues/TRA-284)
> acceptance bar ("if any window misses the bar, do **not** ship — file a
> parameter-revision interaction back on [TRA-255](/TRA/issues/TRA-255) for
> QuantTrader review before retrying"). Filing structural-revision
> interaction on [TRA-255](/TRA/issues/TRA-255) — the v2 bracket exhausts
> the second of two trigger archetypes spec'd for BTC 4H without lifting
> the recent-high anchor or the daily-regime gate. r9 (or v3) needs a
> trigger that releases at least one of those two gates, or BTC needs to
> be parked at the strategy level on Phase-1.1 4H pending a different data
> input (liquidations stream, OI delta) that the bracket / cascade-leg
> archetypes can't simulate from OHLCV alone.

---

# TRA-266 — §8 Walk-Forward Sweep Report (4H Phase-1.1 — TRA-255 r7 §4.4 Layer 3)

Generated: 2026-05-03T18:15:40.277Z

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
| 5 | 2025-04-03→2025-07-02 | 10 | 40.0 | 0.100 | $-151 | 2.13 | ❌ | expectancy 0.100R < 0.10R |
| 6 | 2025-07-02→2025-09-30 | 8 | 37.5 | -0.243 | $-319 | 1.47 | ❌ | expectancy -0.243R < 0.10R |
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
| baseline | 1.00 | $-599 | -0.897 | 0.0 | 3.26 | ❌ |  |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 0.80 | $-599 | -0.897 | 0.0 | 3.26 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| FUNDING_GATE_THRESHOLD_PER_HOUR | 1.20 | $-599 | -0.897 | 0.0 | 3.26 | ❌ | funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5 |
| regime hysteresis flipBars | 0.80 | $-599 | -0.897 | 0.0 | 3.26 | ❌ |  |
| regime hysteresis flipBars | 1.20 | $-929 | -0.619 | 16.7 | 3.16 | ❌ |  |
| Momentum atrStopMultiplier | 0.80 | $-903 | -1.013 | 0.0 | 2.85 | ❌ |  |
| Momentum atrStopMultiplier | 1.20 | $-262 | -0.489 | 0.0 | 3.10 | ❌ |  |
| Breakout atrStopMultiplier | 0.80 | $-659 | -0.897 | 0.0 | 3.19 | ❌ |  |
| Breakout atrStopMultiplier | 1.20 | $-627 | -0.556 | 25.0 | 3.82 | ❌ |  |
| Breakout atrTpMultiplier | 0.80 | $-499 | -0.897 | 0.0 | 3.26 | ❌ |  |
| Breakout atrTpMultiplier | 1.20 | $-598 | -0.897 | 0.0 | 3.26 | ❌ |  |

## Pre-route skip reasons (baseline)

| Reason | Count |
| ------ | ----- |
| diagnostic — router emitted no signal | 71951 |
| diagnostic — router emitted a long signal (dropped pre-short-gate) | 473 |
| single-symbol short cap | 204 |
| BTC trend up — alt short blocked | 98 |
| total short notional cap | 3 |
| 3 consecutive short losses — symbol cooldown | 3 |
| cross-strategy per-symbol short cap | 3 |

## Decision

**FAIL** — One or more windows missed §8 acceptance bars. TRA-261 reassigned to QuantTrader for parameter revision per spec §8 protocol.