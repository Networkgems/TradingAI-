# Swing setup taxonomy (A–E) + dislocation→confirmation sequencing — DESIGN

**TRA-4421** · CTO · 2026-09-08 · Spec source: board comment `031e6ff0` on TRA-4412
(2026-09-09T02:17:52Z).

> ## STATUS — 2026-09-09, two board actions and one shipped item
>
> **1. APPROVED.** Board card `70e36987` on plan rev 1 was **accepted 2026-09-09T12:50:48Z** by
> `local-board`, clean — no counter-proposal, no reject reason. That ratifies **the build order 0→6**
> and **the four §11 defaults**, which are now board policy rather than CTO preference.
>
> **2. UNFROZEN.** The header of this doc used to read *"DESIGN ONLY — no code lands before
> 2026-09-18"*. Board comment `adaebaa2` on TRA-4412 (2026-09-09T11:13:38Z) — *"Unfreeze this,
> authorize by the board to implement the tasks on this TRA-4412 ticket"* — overtook that. The
> TRA-4383 freeze still stands for everything outside this family.
>
> **3. ⚠ ITEM 6 HAS ALREADY SHIPPED, and it takes a §5 net-new item with it.** LeadDev landed
> `fdc9efab` *"cross-expiration term-structure RV pass + skew-coefficient export"* and `c442353d`
> (shadow wiring + counters) under **TRA-4413**, whose item 4 was the same work. Verified by symbol,
> not by commit message: `fitSkewCurves()` (`relative-value.ts:568`) exports the `{a,b,c}`
> coefficients, and `findTermStructureDislocations()` (`:746`) implements §7's grouping verbatim.
> ⇒ **§7 / item 6 are done, and setups A and B no longer carry any net-new quant at all.**
>
> **⛔ What the acceptance does NOT cover.** The card payload was written 03:28Z; the *fifth*
> decision — that the enforce flip must relocate the refusal **below** `entry_window`, because an
> enforcing gate above it would eat that gate's denominator — was discovered at 11:41Z, after. An
> acceptance ratifies the payload it was asked about, not a comment appended later. That decision is
> open and carried on **TRA-4422**.

---

## 1. The finding, stated as a measurement

The `single_leg_otm` open has **no directional gate anywhere on its path**. The nominator is
`|mispricingPct|` descending — `packages/engine/src/options/otm-mispricing.ts:325`:

```ts
candidates.sort((a, b) => Math.abs(b.mispricingPct) - Math.abs(a.mispricingPct));
```

…and the sleeve is long-only, so the option's **side** (call vs put) is chosen by which wing of the
chain is cheap, never by what the underlying is doing.

The gate list below is not inferred. It is the enumerated set of `scanRun.reject('…')` call sites on
the OTM sweep body in `packages/server/src/signal-engine.ts` (lines 12457–13300), in execution order:

| # | reject code | line | asks about the underlying? |
|---|---|---|---|
| 1 | `scan:*` | 12467 | no — data health |
| 2 | `no_candidates` | 12468 | no — empty chain |
| 3 | contract-floor codes | 12513 | no — premium / \|Δ\| / DTE |
| 4 | `no_in_band_strike` | 12578 | no — Δ band abstention |
| 5 | `no_cheap_candidate` | 12580 | no — chain cheapness |
| 6 | `recent_duplicate` | 12637 | no — churn brake |
| 7 | `entry_window_closed` | §`otmEntryWindowRejectReason` (7987) | no — **wall clock** |
| 8 | `live_universe` | 12798 | no — allowlist |
| 9 | `asset_class_refused` | 12823 | no — allowlist |
| 10 | `entry_delta_ceiling_live` | 12880 | no — \|Δ\| |
| 11 | `otm_delta_floor_live` | 12929 | no — \|Δ\| |
| 12 | `cost_bar` | 12962 | no — expected value |
| 13 | `entry_delta_ceiling` | 12985 | no — \|Δ\| |
| 14 | `live_otm_dark` | 13021 | no — kill switch |
| 15 | `no_ask` | 13033 | no — quote |
| 16 | `no_balance_snapshot` | 13057 | no — cash |
| 17 | `over_entry_cap` | 13087 | no — sizing |
| 18 | `over_aggregate_cap` | 13297 | no — sizing |

**Eighteen gates, zero signals.** Every one is a VETO on the *contract*; not one is a claim about the
*underlying*. This is precisely the rule the board's own spec forbids: *"Avoid entering simply because
the option is statistically cheap."*

### 1.1 The asymmetry that makes this cheap to fix

The sibling **RV-long** path in the same file *does* have a directional gate, and it rejects with
codes that have no counterpart on the OTM path:

```
signal-engine.ts:11076  confluenceSide(trendSeries) → trendSide
signal-engine.ts:11089  selectRvLongCandidate(result.candidates, { trendSide, … })
signal-engine.ts:11094  scanRun.reject('no_trend_aligned_candidate')
signal-engine.ts:11106  scanRun.reject('ema_pullback_no_series')
signal-engine.ts:11109  scanRun.reject('ema_pullback_not_fired')
```

Its own comment (11060–11073) says exactly what this issue says, about itself, in 2026:

> *…candidates purely on IV edge + liquidity, so its top `cheap` / `below_intrinsic` pick can be a long
> put into an uptrend, or a deep-OTM lottery strike — both contradict the swing spec's "align option
> direction to the daily-trend signal" rule…*

**So the directional machinery already exists and is wired to the sleeve that is OFF** (`RV_ENGINE_ENABLED`
— see TRA-4344/TRA-4385), **while the sleeve that trades live capital consumes none of it.** That is
the actual defect: not an absent capability, a mis-wired one.

### 1.2 TRA-3942's entry window is a bandage — and this design does not touch it

`otm-entry-window.ts` (10:15–11:30 / 15:00–15:45 ET) exists because 15 of 17 live OTM entries filled
13:35–13:51Z, *because* the overnight gap is the largest mispricing print on the chain and
`|mispricingPct|` is what the nominator ranks on. The window suppresses the symptom; the missing input
is still missing. **Do not close TRA-4421 by tightening that window.** It is gate #7 above and it stays
exactly as it is through this whole programme. See §8 for the one interaction that follow-up owes it.

---

## 2. ⚠ Correction: most of the "confirmed absent" list is present

The TRA-4421 issue body — and the CTO note behind it — claimed *"no consolidation detector, no
`relativeStrength` symbol, no gap-fill detector, no reversal-confirmation model, no cross-expiration
RV, no term structure, no setup taxonomy of any kind."* That was a **filename** grep. A **capability**
grep says otherwise, and the difference changes both the cost and the build order.

### Present, unit-tested, and NOT on the OTM path

| capability | symbol | file |
|---|---|---|
| **Reversal-confirmation model (4-leg)** | `reversalChecklist()` → `{atKeyLevel, trendBreak, unhealthyMove, pattern, score 0–4, confirmed, entry/stop/target/R}` | `engine/src/indicators/support-resistance.ts:232` |
| Support / resistance zones | `supportResistance()`, `findSwings()` | same file, `:79`, `:102` |
| **Volume-confirmed breakout** | `volumeConfirmedBreakout()` | `engine/src/options/swing-entries.ts` (TRA-1028) |
| **EMA-pullback trigger** | `emaPullbackTrigger()` | same file |
| **Opening range + break/fail** | `openingRangeBox()`, `openingRangeBoxSignal()`, `OrbSignalType` | `engine/src/indicators/opening-range-box.ts:137,171` |
| **RSI divergence** | `rsiDivergence()` | `engine/src/indicators/rsi.ts:31` |
| Candle reversal patterns | `detectPattern()`, `detectMultiBarPattern()` | `engine/src/indicators/patterns.ts:31,120` |
| Range/coil measures | `choppinessIndex()`, `efficiencyRatio()`, `donchian()`, `bollinger`, `double-bollinger` | `engine/src/indicators/` |
| Trend confluence | `confluenceSide()`, `supertrend()`, `adx`, `macd`, `mtf`, `vwap`, `atr` | `engine/src/indicators/` |
| Gap % arithmetic | `gapPct` (inline) | `server/src/news-catalyst-source.ts:244` |
| Earnings calendar + gate | `earnings-store.ts`, `catalyst-gate.ts` | `server/src/` |
| IV rank + 366-day history | `iv-rank-store.ts`, `iv-rank-archive.ts` (`reconstructIvRankAt`, `RECONSTRUCTION_TRAILING_DAYS=366`) | `server/src/` |
| Cross-STRIKE skew RV | `findRelativeValueOpportunities()`, quadratic fit `IV(x)=a+bx+cx²` per `(expiration × type)` | `engine/src/options/relative-value.ts:360` |
| IV-vs-realised mispricing | `iv-rv-mispricing.ts` + `iv-rv-scanner.ts` | observe-only, arm = TRA-4385 |

`emaPullbackTrigger` / `volumeConfirmedBreakout` are already flag-gated for the exec path via
`ENABLE_OPTION_EMA_PULLBACK` / `ENABLE_OPTION_VOLUME_BREAKOUT` (`server/src/option-exec-flag.ts:1170,1184`)
— both OFF by default, both scoped to the RV-long path only.

`reversalChecklist` is *already consumed in production code* — `signal-engine.ts:14363`
(reversal shadow ledger) and `analyst-agent.ts:195`. It is not shelf-ware; it is simply not asked on
the OTM open.

### Genuinely absent (the real net-new list)

1. ~~**Cross-EXPIRATION relative value**~~ — **SHIPPED 2026-09-09**, TRA-4413 `fdc9efab`.
   `findTermStructureDislocations()` (`relative-value.ts:746`). (Board item #5.)
2. ~~**Term structure**~~ — **SHIPPED** with (1), same commit. (Board item #7.)
3. **Relative strength vs a benchmark** — 0 symbols anywhere. Still absent.
4. **A reusable gap / gap-fill predicate** — the arithmetic exists inline in the news path; there is no
   shared detector and no gap-fill state.
5. **IV-collapse (post-event crush) detector** — `iv-rank-archive` holds the history to compute it;
   nothing computes it.
6. **The setup taxonomy itself**, and **the dislocation→confirmation sequencer**. Today the OTM path is
   a single tick: scan → gate → order. There is no state that parks a detected dislocation pending
   confirmation.

### ⚠ One prior result the board must weigh before ranking setup E

`packages/engine/src/strategies/archived/breakout-vol.ts` is **setup E's premise, already tested on this
desk's own data, and it failed**:

> *DORMANT / ARCHIVED — TRA-816. OOS-failed roster: **0 of 10 keeper-gate pools passed after costs**
> (TRA-306, TRA-523). … Entry premise: price has been coiling in a tight range (consolidation) and just
> printed a breakout candle with abnormally high volume.*

That was a **standalone directional crypto strategy graded on its own P&L**. Setup E here is a
different object: an **admission filter** on an entry that already carries a mispricing edge claim. A
premise that cannot stand alone can still be a useful filter. But it is prior evidence against E, it is
ours, and the board should see it before approving E first. It also fixes how E must be graded — against
the OTM sleeve's own **admit-set counterfactual**, never a standalone backtest.

---

## 3. Architecture

Three units. Two pure engine modules (golden-testable, no I/O), one server seam.

### (a) `packages/engine/src/options/setup-taxonomy.ts` — pure

```ts
export type SetupId = 'A_panic_reversal' | 'B_blow_off_reversal'
                    | 'C_post_earnings_continuation' | 'D_post_earnings_reversal'
                    | 'E_normal_breakout';

export interface SetupLeg { id: string; ok: boolean; value: number | null; }
export interface SetupVerdict {
  setup: SetupId;
  side: 'call' | 'put';       // the side the SETUP wants
  legs: SetupLeg[];
  score: number;              // legs satisfied
  required: number;
  confirmed: boolean;         // score >= required
}
export function evaluateSetups(ctx: SetupContext): SetupVerdict[];
```

**Each setup scored independently** — the board asked for five named setups, each independently scored,
so `evaluateSetups` returns all five verdicts every call and never blends them into one number. Blending
is what makes a taxonomy unfalsifiable: you can no longer say *which* setup was wrong.

### (b) `packages/engine/src/options/setup-sequencer.ts` — pure reducer

```
IDLE ──dislocation detected──▶ DISLOCATED(hold)
DISLOCATED ──underlying confirms──▶ CONFIRMED
CONFIRMED ──IV/spread/Δ re-check on FRESH quote──▶ REVALIDATED
REVALIDATED ──risk/sizing──▶ ARMED   (the only state that may order)
DISLOCATED ──ttl elapsed──▶ EXPIRED
any ──thesis broken (level lost / side flipped)──▶ INVALIDATED
```

`advance(state, obs) → state'` is a pure function; the server owns the `Map<symbol, SequencerState>`
and its persistence. Pure so the whole lifecycle is golden-testable without a tape.

**The re-quote at `CONFIRMED → REVALIDATED` is load-bearing.** Between dislocation and confirmation the
contract that was cheap may no longer be cheap, and its Δ may have left the band. Carrying the stale
quote forward would open on a price we measured but did not get — the entire class of bug this repo's
CLAUDE.md is about. The revalidation re-reads the chain and re-applies gates 3–5 and 10–13.

### (c) `packages/server/src/otm-setup-gate.ts` — the seam

Called in `signal-engine.ts` **after the nominator (`otmPick`, `selectAdmissibleOtmCandidate` at 12548)
and before `cost_bar` (12962)**.

*Why exactly there.* Above the nominator there is no nominee to stamp a verdict on — the file's own
`contract_floor` comment (12490–12505) draws this distinction and it applies unchanged. Below `cost_bar`
the new gate inherits `cost_bar`'s zero and can never be measured, which is the "a gate upstream of the
instrument's start leaves no trace at all" failure this desk has hit repeatedly.

It records through the existing ledger with a new `LiveEnforceGate` member
(`server/src/live-enforce-gate-ledger.ts:89`):

```ts
| 'setup_confirmation'
```

so it carries an `evaluated` denominator from its first tick, like `aggregate_cap` and `fleet_bound` do.

---

## 4. ⛔ The instrument, and why it ships FIRST

**Turning the taxonomy on is a restriction. `opensPlaced` goes down either way.** A directional gate
that works and a directional gate that is broken and admits nothing **read identically** on every
metric the sleeve currently publishes. That is this desk's single most recurring bug class, and it must
be designed out before the first setup is written, not after.

Three things make the two distinguishable:

**1. A reason-code histogram with a split for unreadability.**

| reasonCode | meaning |
|---|---|
| `no_setup_matched` | scored, nothing confirmed — a real negative |
| `setup_side_conflict` | a setup confirmed, but on the **opposite** side from the cheap wing |
| `awaiting_confirmation` | dislocation parked in `DISLOCATED`, correctly not ordering yet |
| `confirmation_expired` | parked and timed out |
| `series_unreadable` | **no candles / cold cache — the gate never ran** |

`series_unreadable` is separated from `no_setup_matched` for exactly the reason `entry_window` separates
`clock_unreadable` from `closed` (signal-engine.ts:8006–8012): an unreadable input is a runtime defect
that happens to fail closed, and folding it into the ordinary refusal hides a broken box inside a bucket
that is *supposed* to be large.

**2. An observe mode, defaulting to observe.**

```
OTM_SETUP_TAXONOMY_MODE = observe | enforce      (default: observe)
```

In `observe` the gate scores every nominee and records the full verdict **without refusing**. That buys
the admit/refuse counterfactual on live tape before any capital behaviour changes — we learn what the
gate *would* have blocked while the sleeve keeps trading as it does today.

**3. The mode must be readable from a health route, not inferred from defaults.**

`/api/health/otm-sleeve-mandate` (or a sibling) publishes `setupTaxonomy: { mode, setupsEnabled[],
evaluated, blocked, byReasonCode }`. Grading rules that follow from prior incidents on this desk:

- **`evaluated: 0` is `unmeasured`, never `pass`.** A gate that never ran is not a gate that never bit.
- **Defaults are not authorization.** The route reports the *live* mode; a design doc saying "default
  observe" is not evidence the box is in observe.
- `byReasonCode` must be read with `.find(x => x.code === …)`, not `byCode[…]` — the sibling
  `retained.byGate` is an **array**, and indexing it returns `undefined`, which reads as accrual death.

---

## 5. The five setups, as legs over what exists

`✓` = primitive exists today. `+` = net-new, and small.

### A — Panic Reversal → OTM **call** relatively cheap
| leg | primitive |
|---|---|
| ≥5% recent decline | ✓ closes |
| elevated IV | ✓ `ivRankSync` |
| steep put skew | ✓ **`fitSkewCurves()` — SHIPPED, TRA-4413 `fdc9efab`.** Was listed here as net-new; it no longer is |
| at support | ✓ `supportResistance()` |
| reversal confirmation | ✓ **`reversalChecklist()`, `side==='long'`, `score ≥ 3`** |

### B — Blow-Off Reversal → OTM **put** relatively cheap
| leg | primitive |
|---|---|
| ≥5–10% rally | ✓ closes |
| rich call wing | ✓ `fitSkewCurves()` — SHIPPED (same export as A) |
| at resistance | ✓ `supportResistance()` |
| momentum divergence | ✓ **`rsiDivergence()`** |
| breakdown confirmation | ✓ `reversalChecklist()`, `side==='short'` |

### C — Post-Earnings Continuation (**board's stated top priority**)
| leg | primitive |
|---|---|
| earnings released | ✓ `earnings-store.ts` / `earningsInDaysSync` |
| large gap | **+ gap predicate** (arithmetic exists at `news-catalyst-source.ts:244`; needs extracting) |
| IV collapse | **+ crush detector** — Δ IV-rank across the event, off `iv-rank-archive` (366d history exists) |
| relative strength | **+ vs benchmark** — genuinely absent |
| holding key levels | ✓ `supportResistance()` |

### D — Post-Earnings Reversal
| leg | primitive |
|---|---|
| gap | + (shared with C) |
| failed move | ✓ `reversalChecklist().trendBreak` |
| gap fill | **+ gap-fill state** |
| lost opening range | ✓ **`openingRangeBoxSignal()`** |

### E — Normal Breakout
| leg | primitive |
|---|---|
| consolidation | ✓ compose `donchian` width / `choppinessIndex` / `efficiencyRatio` — no new quant |
| breakout | ✓ `donchian()` close beyond channel |
| vol expansion | ✓ **`volumeConfirmedBreakout()`** + `atr` expansion |
| option not yet repriced | ✓ **this is the existing mispricing leg** — see §6 |

Net-new across all five, **as revised 2026-09-09**: the skew-coefficient export shipped with TRA-4413,
so **four** small pieces remain (gap predicate, gap-fill state, IV-collapse detector, relative
strength) plus the taxonomy/sequencer scaffolding — and a **seventh item the original list missed**:

⚠ **A daily-bar source (TRA-4424).** Every setup here is a multi-day thesis, and the only series at
the seam holds **~6.15 trading days** (2400 one-minute bars → ~480 five-minute bars). That passes
every `length >= N` guard while answering a swing question with intraday structure. A/B's "≥5% recent
decline / ≥5–10% rally", C's gap-and-crush, D's gap-fill and E's consolidation are all uncomputable
on it. This is a **prerequisite**, not a nicety, and it blocks setup E (TRA-4423).

---

## 6. Scope item 3 — combine the absolute and relative legs

Today `iv-rv-mispricing` (absolute: IV vs 20d realised) and `relative-value` (relative: residual vs the
fitted skew) are two scanners with two independent ranks, and neither confirms the other.

Design: a single `confirmedCheap` **predicate on the nominee** — the same contract must be cheap on
*both* reads (`ivRv` cheap **AND** skew residual `z ≤ −z*`).

⚠ **Intersecting two ranks is not intersecting two predicates.** "Top-N of list 1 ∩ top-N of list 2" is
a different, and much weaker, object than "this contract satisfies both tests" — the intersection of two
top-N lists is dominated by list length and is empty for reasons that have nothing to do with the
contract. The predicate is evaluated on the nominee, after nomination, or not at all.

## 7. Scope item 4 — cross-expiration RV and term structure ✅ SHIPPED 2026-09-09

**Done, by LeadDev under TRA-4413 (`fdc9efab` + `c442353d`) — not by this programme.** The design
below was implemented as written: `findTermStructureDislocations()` (`relative-value.ts:746`) groups
`${type}|${deltaBucket}` across expiries, fits IV against `√T` and z-scores the residual, reusing the
same machinery; `fitSkewCurves()` (`:568`) exports the `{a,b,c}` coefficients. Kept below as the
record of what was specified. **Do not rebuild it** — grep `findTermStructureDislocations` first.

`relative-value.ts:371` groups `${expiration}|${type}`. Add a **second pass** keyed
`${type}|${deltaBucket}` **across** expiries, fitting IV against `√T` (or `log T`) and z-scoring the
residual with the same `solve3x3` / `fitQuadraticSkew` machinery already in the file. Same code shape,
different grouping key. Independent of A–E and parallelisable to a different owner.

---

## 8. Explicitly out of scope

- **`otm-entry-window.ts` is not touched.** Not tightened, not widened, not removed. One follow-up it
  *does* own: once a real directional trigger runs in `enforce`, the window's justification (suppressing
  the overnight-gap mispricing print) is at least partly subsumed. That is a **re-grade after E ships**,
  filed separately, and it is not licence to relax the window now.
- **The delta band is not re-opened.** TRA-4412 answered `widen_live_anyway`; no re-litigation.
- **No code before 2026-09-18.** TRA-4383 freeze, carrier TRA-4384.
- **No unattended executor.** Nothing here creates an automated write to the live host.

---

## 9. Grading — per setup, before any enforce flip

Each setup, once built, runs in `observe` for a stated soak and publishes:

1. `evaluated` / `blocked` / `byReasonCode` over the soak (with `series_unreadable` broken out — a soak
   whose `series_unreadable` share is material is **void**, not clean).
2. The **admit-set counterfactual**: of the opens the sleeve actually placed, how many would this setup
   have blocked, and what did those trades do. This is the only comparison that survives the fact that
   the gate is a restriction.
3. A **negative control**: a deliberately impossible leg threshold must drive `blocked → evaluated`.
   If it does not, the gate is not wired and the observe numbers mean nothing.

Flipping any setup `observe → enforce` is a **separate board decision per setup**, not a consequence of
approving this design.

---

## 10. Recommended build order (for the board to overrule)

Revised from the order in the TRA-4421 issue body, because §2 changed the inventory.

| # | item | why here |
|---|---|---|
| **0** | **The instrument** — observe-mode gate, `setup_confirmation` ledger member, health readout, negative control. Zero setups; always admits. | Nothing after this is gradeable without it. This is the change from the issue body's order. |
| 1 | **E — Normal Breakout** | Least net-new (every primitive exists and is unit-tested). Cleanest instrument for the question *"does a directional trigger help this sleeve at all"*. ⚠ Carries the TRA-816 prior against its premise (§2) — which is a reason to grade it early and cheaply, not a reason to skip it. |
| 2 | **C — Post-Earnings Continuation** | Board's stated top priority. Three small net-new pieces (gap, IV-collapse, relative strength) on top of an existing earnings store. |
| 3 | **A / B — Panic & Blow-Off Reversal** | **Moved up from the issue body's order.** They were ranked late on the belief we had no reversal-confirmation model. We do: `reversalChecklist()`. A/B now need only the skew-coefficient export and (B) `rsiDivergence`, both present. |
| 4 | **D — Post-Earnings Reversal** | Needs gap-fill state, the least prior support of the five. |
| 5 | **The sequencer** | Only meaningful once ≥2 setups exist; before that "detect → hold → confirm" collapses to "confirm". |
| ~~6~~ | ~~**Cross-expiry RV + term structure**~~ ✅ **SHIPPED** | Was "parallelisable to a different owner at any point" — and that is exactly what happened: LeadDev landed it under TRA-4413 (`fdc9efab`) on 2026-09-09, before this order was ratified. |

**Two changes from the issue body's stated order**, both consequences of §2: the instrument precedes E,
and A/B move ahead of D.

---

## 11. Four defaults this design adopts, which approval also ratifies

Named explicitly so a reject can name one. Each is a policy call, not an engineering one.

1. **The gate is AND.** A nominee must be *both* mispriced *and* setup-confirmed. A confirmed setup does
   **not** override a failed mispricing read. (Recommended: the sleeve's edge claim is the mispricing;
   the setup is a filter on it, not a substitute for it.)
2. **Side conflict is a refusal, not a flip.** If a setup confirms on the opposite side from the cheap
   wing, the nominee is refused (`setup_side_conflict`) — the sleeve does not go shopping for the other
   wing. Flipping sides would make the taxonomy a nominator, which is a much larger change.
3. **`ARMED` re-nominates from a fresh chain read** rather than ordering the parked contract. Costs a
   round trip; refuses to open on a quote we measured and did not get.
4. **Default `observe`, per-setup enable list.** `OTM_SETUP_TAXONOMY_MODE=observe` and an explicit
   `OTM_SETUP_TAXONOMY_SETUPS` list, so a setup arriving in the codebase never arms itself.

---

## 12. Acceptance ✅ MET 2026-09-09

- ✅ This document, approved by the board via `request_confirmation` `70e36987` on plan rev 1 —
  **accepted 2026-09-09T12:50:48Z**, clean. Which setups to build, in what order, was a
  capital-allocation call and the board made it.
- ✅ Implementation subtasks filed for **item 0** (**TRA-4422** — the instrument) and **item 1**
  (**TRA-4423** — setup E), plus the prerequisite discovered while building item 0
  (**TRA-4424** — the daily-bar source, which now also blocks TRA-4423).
- ~~No code before 2026-09-18~~ — overtaken by the board's 11:13Z unfreeze of this family
  (`adaebaa2` on TRA-4412). The TRA-4383 freeze stands everywhere else.

### The remaining items are filed as approval lands per setup — this is deliberate

Items **2 (C)**, **3 (A/B)**, **4 (D)** and **5 (the sequencer)** are ratified in the build order but
are **not yet filed as issues**, and should not be. Each is downstream of a soak that has not started:
item 0 is code-complete but **not deployed**, and item 1 is blocked on both. Filing four rows that
cannot begin for a fortnight buys nothing and puts four stalled leaves on a queue.

**The trigger to file item 2 is TRA-4423's observe-soak grade** (§9: `evaluated`/`blocked`/
`byReasonCode`, the admit-set counterfactual, and the negative control). TRA-4423 carries that, and
it is where the next filing decision belongs.

⛔ **Before filing any of them, grep the symbol first.** Item 6 was ratified in the build order on
2026-09-09 having already shipped four hours earlier under someone else's ticket. The same can happen
to the gap predicate, the IV-collapse detector or relative strength — all four remaining net-new
pieces sit in territory TRA-4413 is actively working.
