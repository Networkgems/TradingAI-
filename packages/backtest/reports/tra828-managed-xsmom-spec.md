# TRA-828 — Frozen Spec: `managed_xsmom` (Cycle-3 candidate)

**Author:** QuantTrader (Lead Quant). **Status:** FROZEN spec — build delegated to LeadDev.
**Parent:** TRA-814 turnaround (standing 6-week "Continue" mandate; no re-approval needed).
**Predecessors:** cycle-1 `tsmom_majors` (FAILED, TRA-821/TRA-817); cycle-2 `xsmom_liquid` (FAILED, TRA-825/TRA-827).
**Gate:** unchanged fixed fee-aware keeper gate (TRA-523 / TRA-817 / TRA-825). **No methodology change.**

---

## 0. Why this candidate (the structural read from two failed cycles)

Both prior cycles failed OOS with the **identical signature**: a large IS/bull edge that **inverts in the 2025 chop regime**.

- Cycle-1 `tsmom_majors` (absolute TSMOM, BTC/ETH/SOL): +3.5R 2024 bull → **−4.9R 2025 chop**; also thin (9 OOS trips, p5 uncomputable).
- Cycle-2 `xsmom_liquid` (cross-sectional rel-strength, 10 names): walk-forward **+1.92R (2023 recovery) → +0.80R (2024 bull) → −2.08R (2025 chop)**. The cross-sectional structure **fixed thinness** (32 OOS trips, p5 computable) and halved the cycle-1 loss, but did **not** remove regime dependence.

Per-symbol cycle-2 OOS pins the mechanism precisely: **BTC +4.0R / ETH +5.3R stayed positive even in chop**, while the rank rotated into high-beta alts that had just run and then reversed — **ADA −4.6, AVAX −6.2, DOGE −4.7, LINK −3.3, SOL −2.3**.

**The sole, repeated failure mode:** momentum has no defence in chop — it keeps rotating into recently-run names that mean-revert. Re-tuning the cross-section (cycle-2) did not fix it.

## 1. The hypothesis (one structural change, not a re-tune)

Momentum's edge is **conditional on a trending aggregate market**; in chop it crashes. The well-documented fix is **momentum-crash management** (Barroso–Santa-Clara 2015; Daniel–Moskowitz 2016): **gate exposure by an aggregate-market trend regime filter** rather than keep re-tuning the cross-section.

**Rule change vs cycle-2 (the ONLY change):** hold the equal-weight cross-sectional top-K book **only when the aggregate market is in an uptrend; go fully to cash otherwise.** This would have flattened the 2025 chop book — the exact period that sank cycle-2 — while leaving the 2023/2024 trending books (where cycle-2 was already positive) essentially intact.

This is an **economic prior**, not a parameter sweep. The regime grid below is small and pre-registered.

---

## 2. Universe, data, bars — UNCHANGED from TRA-825 §1 (carried forward verbatim)

```
BTC-USD, ETH-USD, SOL-USD, ADA-USD, AVAX-USD,
LINK-USD, DOT-USD, LTC-USD, XRP-USD, DOGE-USD
```

- **Data source:** 4h Coinbase bars from the existing offline cache (`packages/backtest/data/<sym>.4h.json`), cached-only switch (no network) for determinism. Same source as TRA-523/TRA-827.
- **Eligibility per bar:** a name contributes only if it has a full ranking-lookback `L` of history at that bar. Drop (and **log**) any name lacking history; **require ≥ 8 names retained** through IS and OOS, else the run is invalid.
- 4h cache starts 2023-05, so walk-forward spans **3** regimes (2023-recovery → 2024-bull → 2025-chop), satisfying the ≥2-regime requirement.

## 3. Signal & rules — UNCHANGED from TRA-825 §2, plus ONE pre-registered regime gate

The cross-sectional ranking, dual-momentum floor, rebalance cadence, fill convention, and sizing-only stop are **identical to TRA-825 §2** and reuse `xsmom-portfolio-runner.ts` **verbatim**. Restated for completeness, with the new gate in **§3.1**:

- **Rebalance cadence:** weekly = **42 bars** (7d × 6, 4h bars). Decisions at rebalance-bar close; fills at the **next bar open**.
- **Ranking score:** trailing total return `r_i = close_{i,t} / close_{i,t-L} − 1`.
- **Dual-momentum floor:** name `i` eligible long only if `r_i ≥ absFloorPct/100`.
- **Target book at rebalance `t`** (cross-section): eligible set `E = { i : r_i ≥ absFloorPct/100 }`; rank `E` desc by `r_i`; target `T` = top `min(K, |E|)`, equal weight. Held∉T → exit (closes a round-trip); T∉held → enter; both → hold.
- **Long-or-flat spot only. No shorts, no perps, no funding, no leverage.** Sizing-only protective stop (1R = one daily vol-target σ); the runner does not arm a real bracket — the only exit is a rebalance crossing **or a regime flip to risk-off (§3.1)**.

### 3.1 NEW: aggregate-market trend regime gate (the only new knob)

Evaluated **at each rebalance bar close, before** constructing the target book:

- **Regime index:** the **equal-weight close-level index** of the eligible universe, `M_t = mean_i(close_{i,t})` over names with full `regimeMA` history. (Pre-registered primary definition. See §3.2 for the BTC-proxy robustness variant — diagnostic only, not part of PASS/FAIL.)
- **Regime state:** `risk_on` iff `M_t > SMA(M, regimeMA)_t` (index above its own trailing simple moving average of length `regimeMA` bars); else `risk_off`.
- **Action:**
  - `risk_on` → construct the top-K book exactly as TRA-825 §2 (no change).
  - `risk_off` → **target book = ∅ (all cash).** Every currently-held name exits at next bar open (each closes a round-trip). No new entries while risk-off.
- **Re-entry:** when the regime flips back to `risk_on` at a later rebalance, the book is rebuilt from that rebalance's fresh cross-sectional ranking (no memory of the pre-cash book).
- The regime gate is a **rebalance-time overlay only** — it changes which names are *targeted*, nothing else. Fills, fees, sizing, and the round-trip/R accounting are byte-for-byte the cycle-2 path.

### 3.2 Pre-registered regime-filter parameter

| Param | Values | Swept? | Notes |
|---|---|---|---|
| `regimeMA` (SMA length, 4h bars) | {30, 60, 90} | **yes** | ≈ 5 / 10 / 15 calendar days |

Regime index definition is **frozen to the equal-weight universe index** for selection/grading. A BTC-close proxy (`M_t = close_{BTC,t}`) is reported as a **robustness variant only** (§7 `regimeIndexVariant`), not a selectable knob — no post-hoc swap of the index definition.

## 4. Sizing — UNCHANGED (TRA-825 §3)

Reuse **VolKellySizer**: equal-weight target across `K` slots, each vol-targeted to `volTargetAnnualPct` annual, per-trade risk clamped **[0.5%, 1.75%]**, Kelly cap off validated OOS net expectancy (never in-sample). No new sizing degree of freedom.

## 5. Pre-registered IS selection grid (3×2×2×3 = **36 configs**)

Existing cycle-2 momentum grid (12) **crossed with** the new 3-value regime grid:

| Param | Values | Swept? |
|---|---|---|
| `lookbackDays` (L) | {60, 90, 120} | yes |
| `topK` (K) | {3, 4} | yes |
| `absFloorPct` | {0, 5} | yes |
| `regimeMA` | {30, 60, 90} | **yes (new)** |
| `rebalanceBars` | 42 (weekly) | **fixed** |
| `volTargetAnnualPct` | 60 | **fixed** |

**Selection rule (pre-registered, no peeking at OOS — IDENTICAL to TRA-825 §4):** among IS configs satisfying *all* of — IS pooled net expectancy `> 0`, IS pooled round-trips `≥ 30`, IS bootstrap p5 computable (≥ 12 IS round-trips) — pick the one with the **highest IS bootstrap p5 final-equity multiple**. Tie-break: higher IS pooled round-trip count. Freeze that single config.

**Selection-leg interaction with the new gate (call it out):** the regime filter *removes* trades, so it will push some configs below the **≥ 30 IS round-trips** selection floor — especially long `L` × small `K` × long `regimeMA`. That is expected and is *part of the test*: a config that cannot clear the IS round-trip floor with the filter active is not eligible, by construction, not by hand-waving. **If NO config qualifies → record FAIL (the gated signal has no IS edge thick enough to carry forward) and stop.** Run on `maker_entry` for selection (the realistic arm), consistent with TRA-827.

## 6. Validation gate — IDENTICAL fixed fee-aware keeper gate (TRA-825 §5)

- **Windows:** warmup from `2023-05-01 − max(L, regimeMA)`; **IS 2023-05-01 → 2024-12-31**; **OOS 2025-01-01 → OOS_END** (pin via env, `2026-06-03`, for deterministic re-run — same pin as TRA-827).
- **Cost arms (BOTH must PASS):**
  - `maker_entry` — `feeBps {maker:25, taker:60}`, `executionMode:'limit'`.
  - `taker_80` — `feeBps 80`, `executionMode:'market'`.
- **Keeper verdict (per arm):** pooled OOS block-bootstrap **p5 final-equity multiple > 1.0** AND pooled OOS **net expectancy > 0**. Bootstrap = same moving-block (blockLen 5, 5000 iters, seed 523, 1% risk compounding) as `run-tra523-fee-aware.ts`.
- **Walk-forward:** report the SAME frozen config across folds **2023_recovery / 2024_bull / 2025_chop**, no per-fold re-tuning.
- **Neighbor stability:** report the gate for ±1-step neighbors of the picked config (flex L, K, absFloorPct, **and `regimeMA`** by one grid step) — fragility diagnosis only, not part of PASS/FAIL.

### 6.1 THINNESS GUARD (the one risk this candidate creates — do NOT paper over it)

The regime filter sits the book out during chop — which is **exactly the 2025 OOS window**. That risks **starving the ≥ 12 pooled OOS round-trip floor** (the cycle-1 defect we just fixed in cycle-2).

- **Hard requirement:** `thinnessCheck.ge12` must still hold **with the filter active**. **≥ 12 pooled OOS round-trips** on each graded arm.
- **If filtering drops pooled OOS round-trips below 12 → the candidate FAILS on thinness** (`verdict: "FAIL_THINNESS"`). We do **not** hand-wave it, do not relax the floor, do not pick a shorter `regimeMA` post-hoc to manufacture trades.
- This guard binds the regime-grid selection implicitly: a frozen config whose OOS trips fall below 12 fails grading even if IS looked strong.

## 7. Report (commit under `packages/backtest/reports/tra828-managed-xsmom.json`)

Mirror the **`tra825-xsmom-liquid.json` schema exactly**, with these additions:
- `strategy: "managed_xsmom"`, `issue`, `parent: "TRA-828"`.
- `paramGrid` extended with `regimeMA: [30,60,90]`.
- `regimeFilter` block: `{ definition, regimeIndex:"equal_weight_universe", regimeMA:<picked>, riskOffAction:"all_cash" }`.
- `isSelectionTable`: **all 36 configs** (IS trips / p5 / net expectancy / qualifies), each row carrying its `regimeMA`.
- Per arm in `oos[]` and per fold in `walkForward[]`, ADD:
  - `pctTimeInCash` — fraction of evaluated rebalances the book was risk-off (all cash).
  - `oosBarsRiskOff` (and `rebalancesRiskOff`) — count of risk-off rebalances, so the gate's behaviour is auditable.
- Keep `roundTripDefinition`, `perSymbol`, `bootstrap`, `neighborStability`, and a `thinnessCheck:{pooledOosRoundTrips, ge12}` field.
- `regimeIndexVariant`: a single diagnostic re-run of the **picked** config using the BTC-close proxy index (report OOS expectancy / p5 / round-trips / pctTimeInCash only — NOT graded).
- `verdict`: one of `PASS` | `FAIL_GATE` | `FAIL_THINNESS` | `FAIL_NO_IS_EDGE`.

## 8. Build note for LeadDev (scope — small, additive)

This is **NOT a new runner**. Reuse `xsmom-portfolio-runner.ts` and the `run-tra825-xsmom-liquid.ts` harness **verbatim**. The build is purely:
1. Add an optional `regimeMA` to `XsmomParams` and a rebalance-time regime check inside the portfolio loop: compute the equal-weight index SMA, and when `risk_off` force the target book to ∅ for that rebalance (existing exit/round-trip plumbing handles the liquidation — no new exit path).
2. Extend the grid to 36 configs, thread `regimeMA` through selection.
3. Emit the new report fields (`regimeFilter`, `pctTimeInCash`, `oosBarsRiskOff`, `regimeIndexVariant`) into the `tra828-managed-xsmom.json` schema above.
4. **Gate / bootstrap / cost-arm / selection code reused byte-for-byte** from `run-tra523-fee-aware.ts` / `run-tra825-xsmom-liquid.ts` so the gate stays identical. No engine, preset, or live-path changes.

## 9. Grading (QuantTrader, after build returns the report)

Grade **PASS only if both cost arms clear** (p5 > 1.0 AND net expectancy > 0) **with ≥ 12 pooled OOS round-trips with the filter active**. A FAIL — whether `FAIL_GATE`, `FAIL_THINNESS`, or `FAIL_NO_IS_EDGE` — is an acceptable, valuable outcome: I record it, name the failure mode, and form the cycle-4 hypothesis. **Nothing is promoted to a live preset without a PASS.**

### Cycle-4 pre-commitment (parked, flagged to program owner)
If cycle-3 FAILS, the remaining regime-robust candidates (cross-sectional reversal — IS-negative by construction so not gate-viable as-is; market-neutral long/short; perpetual funding-rate carry) **all require shorts/perps + new funding data → an engine + data-scope escalation beyond the long-only spot mandate.** That is a real scope/cost decision for the program owner (TRA-814), **not** cheap iteration — escalate explicitly before opening cycle-4.
