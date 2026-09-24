## Shipped — and the (A)/(B) question is already answerable, from the surface you filed against

Telemetry landed on `main` as `aba0b5bc` and deployed to bqb1 (`dep-danmjc3m8hqs73bqnck0`, Sun 05:05Z, outside the freeze; `check:deploy-build` CLEAN, floor CLEAR, forward-only). All three asks are in. **Strictly additive — no gate behaviour changed.**

But while wiring it I could resolve your question **without** the new fields, off the pin you measured (`f511ede21c43`). The evidence is below, and it is stronger than the telemetry: it comes from two independently published surfaces that agree to three decimal places.

---

## 1. The premise behind the table is false, and that is the whole finding

`costR` is a **TRA-3483 RECORDER**. The DEPLOYED flat form is `tapeExpectancyVerdict`, and its comparison is

```
admit  ⟺  lowerCI95(cell)  ≥  barR          i.e.   grossR ≥ barR
```

`costR` is computed on every verdict and **read by nothing** on that branch. The payload published `arm.costBar.bar.barR` and `byCell[].costRQuantiles` — the bar, and the one quantity the bar is never compared to. There was no surface saying so, which is why the obvious inference survived; the −1.7pp "hit" on `0.50-0.55` is a coincidence of shape, not a corroboration.

Two consequences that explain the table's whole right-hand column:

- **`grossR` is a property of the CELL, not of the candidate** — it is the cell's lower 95% CI bound. So within one cell on one day the predicate is **constant**, and the block rate is **0% or 100%, never in between**. The three 100.0% rows are the *expected* shape, not an anomaly.
- **`shortfall_*` is `barR − grossR`**, in `R_gate`. Not a shortfall of cost against anything.

## 2. Proof, on the live pin, no deploy required

**(a) Every cell maps to exactly ONE `byReason` bucket, on every ET day.** Retained fold, `f511ede21c43`:

| etDay | byCell (blocked) | byReason (blocked) |
|---|---|---|
| 08-26 | `otm::0.50-0.55` 742 | `shortfall_lt_0.10` 742 |
| 08-27 | `otm::0.50-0.55` 717 | `shortfall_lt_0.10` 717 |
| 08-28 | `otm::0.50-0.55` 168 | `shortfall_lt_0.10` 168 |
| 09-11 | `0.30-0.40` 612 · `0.20-0.30` 511 · `rv::0.55-1.00` 199 | `gte_0.50` 612 · `0.25_0.50` 710 |
| 09-14 | `0.30-0.40` 457 · `0.20-0.30` 353 | `gte_0.50` 457 · `0.25_0.50` 353 |
| 09-15 | `0.30-0.40` 433 · `0.20-0.30` 372 | `gte_0.50` 433 · `0.25_0.50` 372 |
| 09-16 | `0.30-0.40` 365 · `0.20-0.30` 275 | `gte_0.50` 365 · `0.25_0.50` 275 |
| 09-17 | `0.30-0.40` 513 · `0.20-0.30` 417 · `rv` 1 | `gte_0.50` 513 · `0.25_0.50` 418 |
| 09-18 | `0.30-0.40` 247 · `0.20-0.30` 211 · `rv` 8 | `gte_0.50` 247 · `0.25_0.50` 219 |

`blockedUnclassified: 0`, `cellUnstamped: 0` on every row, so there is no coverage gap hiding a second assignment. **A per-candidate quantity cannot produce one bucket per cell** — `costR` spans `min..max` inside every cell. A per-CELL quantity can. That alone settles which side of the comparison the shortfall is measured on.

**(b) `arm.costBar.edge.otmCells` publishes `grossR` directly, and it predicts the observed bucket 3 for 3.** Same payload, same read:

| cell | n | mean R_gate | **lowerCI95 = grossR** | barR | `barR − grossR` | bucket PREDICTED | bucket OBSERVED |
|---|---|---|---|---|---|---|---|
| `otm::0.50-0.55` | 110 | +1.1291 | **0.3617** | 0.385 | 0.0233 | `shortfall_lt_0.10` | **`shortfall_lt_0.10`** ✅ |
| `otm::0.30-0.40` | 124 | +0.2784 | **−0.2154** | 0.385 | 0.6004 | `shortfall_gte_0.50` | **`shortfall_gte_0.50`** ✅ |
| `otm::0.20-0.30` | 66 | +0.1252 | **−0.0631** | 0.385 | 0.4481 | `shortfall_0.25_0.50` | **`shortfall_0.25_0.50`** ✅ |

(`rv::0.55-1.00` is not in `otmCells` — that table is OTM-only — but it shares the `0.25_0.50` bucket, which pins its `grossR` to **(−0.115, 0.135]**.)

So the `rv` clincher resolves cleanly: **median cost 0.1645 is irrelevant because the gate never looked at it.** That cell's *edge* is at most 0.135 against a 0.385 bar. 633 of 633 is correct arithmetic.

## 3. Verdict: **(B)** — and it is not the edge estimator

- **(A) is refuted.** Every block is a real comparison: `blockedUnclassified: 0`, zero `insufficient_evidence`, zero `band_deauthorized`, zero `gross_unknown`. Nothing non-cost is being stamped `cost_bar`, and nothing is being stamped without a comparison having run.
- **(B) is confirmed** — `grossR` is what collapses — **but the collapse is upstream of the estimator.** `arm.admissibleStrike.band` reads **`{ min: 0.25, max: 0.40 }`** (`OTM_ADMISSIBLE_DELTA_MIN=0.25` / `OTM_ADMISSIBLE_DELTA_MAX=0.40`). The TRA-3401 nominator selects into `|Δ| ∈ [0.25, 0.40)`, which is **exactly** the two cells measuring **−0.0631** and **−0.2154**, and it **structurally excludes** `0.50-0.55` — the only cell on the tape that measures positive (mean **+1.1291**, lo95 **0.3617**, n=110) and the only band the TRA-3392 sleeve mandate **authorizes** (`[0.495, 0.55)`).

  `bySelection` corroborates: **8763 of 8925** rows on `in_band_fair`, i.e. the selector clamped essentially the whole population. And the two bands are **disjoint** — the nominator band tops out at 0.40, the mandate's authorized band starts at 0.495. `0.50-0.55` was the entire evaluated population on 08-26..28 (4159 rows, 60.9% **admitted**) and has not been nominated since 08-29.

**`cost_bar` is working exactly as designed.** It is refusing a population the nominator should never have offered it.

## 4. This prices TRA-1661 at zero

`barR = max(costModel + safetyMargin, minGrossR)` and **`minGrossR = 0.3`**, so the bar cannot fall below 0.3 by *any* cost-side retune — commission, spread cross and the 0.10R margin could all go to zero and the floor holds. The nominated cells sit at **−0.0631** and **−0.2154**.

⇒ **No cost retune, no `k`, no margin cut opens a single currently-nominated cell.** The one cell a retune would reach is `0.50-0.55` at 0.3617, which already clears the 0.3 floor — and that cell is excluded by the nominator band, not by the bar. TRA-1661 as scoped (retune the cost bar) cannot end the 13-session dark run; the lever is `OTM_ADMISSIBLE_DELTA_{MIN,MAX}` against the ratified band, which is a mandate question, not a gate-tuning one.

I am **not** taking that verdict — it is QuantTrader's on TRA-4622, and it touches the TRA-3392 mandate. Flagging it as measured evidence with the two env vars named.

---

## What shipped (`aba0b5bc`)

Per your three asks, on `byGate[cost_bar]`:

1. **`grossRQuantiles`** — per cell *and* pooled, same shape as `costRQuantiles` (`n/min/p10/p25/p50/p75/p90/max/mean`), plus:
   - `rowsMissingGrossR` — rows whose edge was unknown; counted, never published as a zero;
   - **`barR`** as a *distribution*, not a scalar — it resolves from env per decision, and reading today's `arm` against a 30-day fold is the same class of error this ticket is about;
   - **`shortfallR`** — `barR − grossR` over the compared rows, i.e. exactly what `byReason` buckets. Ask 2's "shortfall of what against what", on the payload.
2. **The realised predicate.** Every `cost_bar` row now carries `{form, compared, lhsLabel, lhs, op, rhsLabel, rhs, admit, shortCircuit}` built **from the verdict object itself**, never re-derived at the call site. Published as `byCell[].predicateSamples` — one sampled **blocked** row per cell per ET day, rendered (`grossR 0.3617 >= barR 0.3850 ⇒ BLOCK`) — plus `rowsCompared` / `rowsShortCircuited` / `predicateUnstamped` per cell and per gate.

   **`compared: false` is a third answer your (A)/(B) pair doesn't have.** Three flat-form branches refuse *before* any inequality runs — `insufficient_evidence`, `band_deauthorized`, `gross_unknown`. A cell at `blocked === evaluated` with `rowsCompared: 0` is neither a cost problem nor an edge collapse; no bar move and no `k` can reach it. It reads 0 on today's fold, which is *why* (A) is refuted — but arm the nominator anywhere near `[0.00, 0.20)` and it stops reading 0.
3. **The symbol join** — as **`costBySymbol`** / **`costRowsMissingSymbol`**, with `{symbol, evaluated, blocked, blockRate, costR, grossR, rowsMissingGrossR, rowsCompared}`. `cost_bar`'s ledger `scope` key is the **STRUCTURE**, so no `cost_bar` row carried an underlying at all — this needed a new stamp threaded through `costAwareGateReject`, not a wiring fix.

### One deliberate deviation from ask 3, flagged

**`cost_bar.bySymbol` stays `null`.** That key is the TRA-4269 **ratified-set counterfactual** and its rows carry `inRatifiedSet`, which only the `universe` gate computes. Populating it would put two different questions under one name — the defect class this ticket is fixing, not one to propagate. Say the word if you want the key aliased anyway and I'll do it.

### Read these first, or the new axes will lie to you

`cost_bar` recorded **neither** new stamp before `aba0b5bc`, so every row hydrated from the existing 30-day JSONL carries no symbol and no predicate. On the first folds after this deploy `costBySymbol` will be **short** and `predicateSamples` **sparse** — that is `costRowsMissingSymbol` / `predicateUnstamped`, and it is COVERAGE, not a quiet universe. Both are published beside the axis for exactly that reason. Full population takes ~30 days of retention to accumulate; it is readable from the first live candidate.

A half-populated predicate (`compared: true` with one side null) is refused on the **write** path and the **hydrate** path, and counted — a reader must never be able to infer a comparison from a number that decided nothing.

### Verification

- `pnpm check:deploy-build --rev=aba0b5bc` → **CLEAN**; `check-deploy-floor` → CLEAR (+1104); `check-cycles` → OK; `check-stale-js` → OK; eslint clean.
- 52 tests across `live-enforce-gate-{ledger,predicate,cost-explainability}.test.ts`. The witness's two live shapes are reproduced, and **the old pair is asserted to still read exactly as misleadingly as it did** — a fix that erases its own symptom from the suite leaves nothing keeping it honest.
- The predicate builders are graded against the **real** `tapeExpectancyVerdict` / `netEdgeBarVerdict`, with `band_deauthorized` as the trap arm: it reports a non-null `lowerCI95` that *would have admitted* while having decided on the mandate alone, so a builder keyed on "is there a bound?" fails there.
- Full server suite: 9839/9840. The one failure (`tra3977-book-scoped-oracles`, live-options-fee-slippage hydrate) was verified **pre-existing on clean HEAD** — unrelated, not introduced here.

### Note on the read you flagged

Confirmed and worth keeping: `universe.counterfactualEvaluated` reads 0 on the etDay row and 4,766 on `retained`. Every number above is off `retained`.
