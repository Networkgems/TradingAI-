# TRA-825 — Frozen Spec: `xsmom_liquid` (Cycle-2 candidate)

**Author:** QuantTrader (Lead Quant). **Status:** FROZEN spec — build delegated to LeadDev.
**Parent:** TRA-814 turnaround. **Cycle-1 predecessor:** `tsmom_majors` (FAILED, TRA-821/TRA-817).
**Gate:** unchanged fixed fee-aware keeper gate (TRA-523 / TRA-817). No methodology change.

---

## 0. Why this candidate (and why it fixes what sank cycle 1)

`tsmom_majors` (long-or-flat daily TSMOM on BTC/ETH/SOL) failed two ways:
1. **Thinness** — only **9 pooled OOS round-trips** (< 12), so the block-bootstrap p5 leg
   was *uncomputable*. Three names + daily + wide hysteresis bands can go quiet across the
   whole universe at once.
2. **Regime dependence** — a single absolute-trend signal that was +3.5R in the 2024 bull
   collapsed to −4.9R in 2025 chop. It is one bet (crypto-beta-is-trending) wearing three tickers.

**Economic prior for `xsmom_liquid`:** *cross-sectional momentum / relative strength.* Rank a
broad liquid universe by trailing return each week and hold the strongest names; pull a name to
cash only when its **own** trailing return is also negative (dual-momentum, Antonacci 2014;
Jegadeesh–Titman 1993 for the cross-sectional effect; documented in crypto by
Liu–Tsyvinski 2021 and others).

Why this structurally repairs both failures:
- **Round-trips:** the *ranking churns* every week regardless of whether the aggregate market
  trends. With ~10 names + weekly rebalance + top-K rotation over a ~74-week OOS, round-trips
  are in the dozens, not single digits. Thinness is fixed by construction, not by luck.
- **Regime dependence:** trading *relative* strength + an absolute-momentum cash filter
  diversifies the single beta bet. In chop, capital still rotates to whichever names lead; in a
  sustained downtrend the absolute filter forces cash instead of bleeding long.

This is a **prior**, not a parameter sweep. The IS grid below is small and pre-registered.

---

## 1. Universe (10 liquid Coinbase names, all 4h-cached offline)

```
BTC-USD, ETH-USD, SOL-USD, ADA-USD, AVAX-USD,
LINK-USD, DOT-USD, LTC-USD, XRP-USD, DOGE-USD
```

- **Data source:** 4h Coinbase bars from the existing offline cache
  (`packages/backtest/data/<sym>.4h.json`), same source as TRA-523. Run with the
  cached-only switch (no network) for determinism.
- **Eligibility per bar:** a name contributes only if it has a full ranking-lookback `L` of
  history at that bar. Drop (and **log**) any name lacking history; **require ≥ 8 names retained**
  through IS and OOS, else the run is invalid (insufficient cross-section).
- Rationale for 4h (vs the daily Yahoo set tsmom used): only BTC/ETH/SOL have daily caches,
  whereas all 44 names have 4h caches → fully offline + deterministic, and the higher bar
  frequency directly serves the ≥12-round-trip mandate. Trade-off accepted: 4h cache starts
  2023-05, so walk-forward spans **3** regimes (2023-recovery → 2024-bull → 2025-chop), which
  satisfies the ≥2-regime requirement.

## 2. Signal & rules (frozen)

Bars are 4h (6 bars/day). All lookbacks are expressed in **days** and converted ×6 to bars.

- **Rebalance cadence:** weekly = **42 bars** (7d × 6). Decisions evaluated at the rebalance
  bar close; fills at the **next bar open**.
- **Ranking score:** trailing total return `r_i = close_{i,t} / close_{i,t-L} − 1`.
- **Absolute-momentum (dual-momentum) filter:** name `i` is *eligible long* only if
  `r_i ≥ absFloorPct/100`.
- **Target book at each rebalance `t`:**
  1. Compute `r_i` for every name with valid `L`-bar history.
  2. Eligible set `E = { i : r_i ≥ absFloorPct/100 }`.
  3. Rank `E` descending by `r_i`; target `T` = top `min(K, |E|)` names, **equal weight**.
  4. Held name **not** in `T` → exit at next bar open (**this closes a round-trip**).
  5. Name in `T` not currently held → enter long at next bar open.
  6. Name in both → hold (no churn).
- **No intra-week management.** The only exits are rebalance-driven rank/floor crossings.
  As in `tsmom_majors`, the protective stop is **sizing-only** (defines 1R = one daily-target-σ
  move); the runner does **not** arm a real bracket. Long-or-flat, never short, never leverage.

## 3. Sizing (unchanged conventions — not a new variable)

Reuse the existing **VolKellySizer**: equal-weight target across the `K` slots, each slot
vol-targeted to `volTargetAnnualPct` annual, per-trade risk fraction clamped to **[0.5%, 1.75%]**,
Kelly-capped off *validated OOS* net expectancy (never in-sample). Identical to `tsmom_majors`
and TRA-523 so sizing introduces no new degree of freedom.

## 4. Pre-registered IS selection grid (3×2×2 = 12 configs)

| Param | Values | Swept? |
|---|---|---|
| `lookbackDays` (L) | {60, 90, 120} | yes |
| `topK` (K) | {3, 4} | yes |
| `absFloorPct` | {0, 5} | yes |
| `rebalanceBars` | 42 (weekly) | **fixed** |
| `volTargetAnnualPct` | 60 | **fixed** |

**Selection rule (pre-registered, no peeking at OOS):** among IS configs satisfying
*all* of — IS pooled net expectancy `> 0`, IS pooled round-trips `≥ 30`, IS bootstrap p5
computable (≥ 12 IS round-trips) — pick the one with the **highest IS bootstrap p5 final-equity
multiple**. Ties broken by higher IS pooled round-trip count (favor robustness/turnover).
Freeze that single config. If *no* IS config qualifies → record FAIL (signal has no IS edge to
even carry forward) and stop.

## 5. Validation gate (IDENTICAL fixed fee-aware keeper gate)

- **Windows:** warmup from 2023-05-01−L; **IS 2023-05-01 → 2024-12-31**;
  **OOS 2025-01-01 → OOS_END** (pin via env, e.g. `2026-06-03`, for deterministic re-run).
- **Cost arms (both must PASS):**
  - `maker_entry` — `feeBps {maker:25, taker:60}`, `executionMode:'limit'` (realistic).
  - `taker_80` — `feeBps 80`, `executionMode:'market'` (conservative).
- **Keeper verdict (per arm):** pooled OOS block-bootstrap **p5 final-equity multiple > 1.0**
  AND pooled OOS **net expectancy > 0**. Bootstrap = same moving-block (blockLen 5, 5000 iters,
  seed 523, 1% risk compounding) used in `run-tra523-fee-aware.ts`.
- **Thinness floor:** **≥ 12 pooled OOS round-trips** so p5 is computable (the cycle-1 lesson).
- **Walk-forward:** report the same frozen config across folds **2023_recovery / 2024_bull /
  2025_chop**, no per-fold re-tuning.
- **Neighbor stability:** report the gate for the ±1-step neighbors of the picked config
  (flex L, K, absFloorPct by one grid step) — for fragility diagnosis, not part of PASS/FAIL.

## 6. Report (commit under `packages/backtest/reports/tra825-xsmom-liquid.json`)

Mirror the `tra817-tsmom-majors.json` schema, with an `xsmom_liquid` block:
`issue`, `strategy:"xsmom_liquid"`, `universe`, `barTimeframe:"4h"`, `dataSource:"coinbase-exchange"`,
`windows`, `costArms`, `keeperGate` string, `paramGrid`, `isSelectionTable` (all 12 configs with
IS trades / p5 / net expectancy), `pickedConfig`, `oos` (per arm: round-trips, symbolsContributing,
expectancyNet, profitFactor, bootstrap{n,p5,p50,p95,worstDdPct}, keeper, perSymbol),
`walkForward` (per fold × arm), `neighborStability`. Add `roundTripDefinition` and a
`thinnessCheck:{pooledOosRoundTrips, ge12:true|false}` field so the cycle-1 lesson is auditable.

## 7. Build note for LeadDev (why this is real code work, not a config change)

`tsmom_majors`/TRA-523 ran **one symbol at a time** then pooled. Cross-sectional ranking needs a
**portfolio/multi-asset runner** that advances all symbols on a shared clock so it can rank them
at each rebalance and rotate the top-K book. That joint-state runner does not exist yet — it is
the core of this build. Suggested entry point: a new `run-tra825-xsmom-liquid.ts` harness +
whatever shared portfolio-loop primitive the engine needs. Keep the gate/bootstrap/cost-arm code
reused verbatim from `run-tra523-fee-aware.ts` so the gate stays identical.

## 8. Grading (QuantTrader, after build returns the report)

I grade PASS only if **both** cost arms clear (p5 > 1.0 AND net expectancy > 0) with **≥ 12
pooled OOS round-trips**. A FAIL is an acceptable, valuable outcome — I record it, name the
failure mode, and form the next hypothesis. **Nothing is promoted to a live preset without a PASS.**
