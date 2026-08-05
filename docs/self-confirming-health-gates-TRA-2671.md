# Health-gate comparison audit — operands JOINED by a repair writer (TRA-2671)

**Owner:** CTO · **Filed by:** LeadDev off TRA-2630 · **Audited:** 2026-08-05 against live `bqb1`
build `9fbc9077` (`/api/health/*`) and `main` at `b70941e`.

## The mechanism

A verdict computed as `A - B` or `A == B` is only evidence while `A` and `B` are maintained
independently. A repair/sync/backfill writer that assigns one operand FROM the other is usually the
*correct* fix for the data and always destroys the instrument: after it runs the difference is 0 **by
construction**, and the gate flips to green in a way that reads exactly like the defect being fixed.

Nothing in the codebase links a repair writer to the gates that read its output, which is why this
has now been re-found four times in six days (TRA-2630, TRA-2641, TRA-2888/AC2, TRA-2662).

**This is not the empty-cohort bug (TRA-2635).** There the denominator is missing. Here the
denominator is *non-empty and tautological* — the rows are present, the comparison runs, and it
cannot fail. A reviewer counting rows sees a healthy cohort.

## AC1 — every `/api/health/*` comparison verdict, with both operands' last writer

| Route | Verdict | Operand A / last writer | Operand B / last writer | Joined? | Disposition |
|---|---|---|---|---|---|
| `pnl-reconciliation` | `optionsLegOk` (`eodOptionsPnl − optionsDaily`) | report-file options leg — **`syncEodReportOptionsLegs`** (TRA-2641) | day-cell `optionsDailyPnl` — journal | **YES** | Tri-stated + `optionsLegMeasuredCount` / `optionsLegSlavedCount` (`602c276`); coverage-gated on `optionsLegScope` (TRA-2924). |
| `demo-book`, `demo-book-public` | `cashInvariant.ok` (`availableCash − expectedCash`) | `PaperAccount.cash` — **`repairDriftedCash()`** | `equity − committedCapital()` — `PaperAccount.equity` | **YES** | **Fixed this ticket** — tri-stated + `repairSlaved`. |
| `pnl-reconciliation` | `stockLegOk` (`eodStockPnl − stockDaily`) | report `realizedPnl` — EOD report writer, **zeroed** by the TRA-219 21:00 ET archive | snapshot `dailyPnl` — `PaperAccount` equity delta | no | Tri-stated for a *different* reason (lossy operand, TRA-2633). Live `null`, measured 71. |
| `pnl-reconciliation` | `drift` / `ok` / `maxDriftUsd` | pooled stock leg (lossy) | pooled options leg (durable) | no | **Not gradeable** — pools a lossy leg with a durable one, cannot attribute. Retained for existing consumers only. |
| `pnl-reconciliation` | `equityAbsorbedOptionsOk` / `uncreditedOptionsUsd` | option-trade journal | equity ledger | **no** | **Falsifiable.** Known-good template. |
| `pnl-reconciliation` | `counterDurableOk` (`unbookedEquityMoveUsd`) | `closingEquity − prevClosingEquity` | `stockDaily` + `optionsCreditedInWindow` | **no** — three durable snapshot fields | **Falsifiable.** Live RED. |
| `pnl-reconciliation` | `priorOptionsLagOk` | day cell `optionsDaily` | preceding **exchange session**'s cell | no | **Falsifiable** since TRA-2835 fixed the gap-spanning pairing. Live RED. |
| `options-live` | `bootArmDrift[]` | persisted settings | ratified live-arm constants | **YES** — **`applyLiveBrokerArm`** (boot *and* settings-write) | **No `*Ok` verdict is folded off it** — published as a raw list beside `bootArmRepairedAtBoot` / `bootArmWriteRepairs`, which name the writer's own output. Disclosed, not self-confirming. Guard: TRA-2910 routine `020d81b5`. |
| `env-drift` | `ok` (`driftCount === 0`) | `render.yaml` declared literals | **running** `process.env` | **no** — self-healed keys are *excluded* from `comparedKeys` and bucketed separately; comparison is against the running value, not the seed map (TRA-2224) | **Falsifiable.** Live: `comparedKeys: 40`, `selfHealed: 10`, `driftCount: 0`. Second known-good template. |
| `parity-reconcile` | `parityGapUsd` | broker `fillPx` | quoted `requestedPx` (mid) | **no** | **Falsifiable.** |
| `options-mispricing` | — | — | — | n/a | Carries **no comparison verdict** (cache/breaker status only). The audit scope named `otm-mispricing`; no such route exists. |
| `option-journal` | — | — | — | n/a | Cohort **counts** only (`accountClassCountsSumToRows` is a partition identity, not a two-source comparison). |

## AC2 — disposition of every joined pair

Three pairs are joined by a writer. None is left silently self-confirming:

1. **`optionsLegOk`** — tri-stated with published denominators (`602c276`, TRA-2641), and since
   TRA-2924 a green additionally requires full coverage (`optionsLegScope === 'fleet'`). Live
   `partial` ⇒ `null`; see the coverage section below.
2. **`cashInvariant.ok`** — **fixed in this ticket.** Was a flat boolean; the docstring already
   described the trap in prose (*"a book the one-shot repair fixed and a book that never drifted both
   show `gap: 0`"*) and the verdict never consumed it. Now tri-state + `repairSlaved`.
3. **`bootArmDrift`** — no verdict folded off it; the repair's own output is published beside it.
   Left as-is.

### The live evidence for #2

`bqb1` 2026-08-05T10:48Z, build `9fbc9077`, book `demo-1`:

```
cashInvariant.ok        true
cashInvariant.gap       -9.09e-13      <- float residue of an ASSIGNMENT
cashInvariant.repaired  { delta: 3243.54, from: 207.14, to: 3450.67 }
```

A green verdict sitting beside a record that the invariant was off by **$3,243.54** and was snapped
shut. `gap: -9e-13` is not "this book is consistent" — it is the floating-point signature of
`cash := expectedCash`. `repairDriftedCash()` runs on **every restore**, and the record is persisted
in the snapshot, so the join survives reboots exactly as the joined cash figure does.

Note the docstring's claim that the repair is *"one-shot … a permanent no-op once the persisted
snapshot has been rewritten"* — `appliedAt` dates to **2026-07-26**, ten days before the boot that
served this read. The record is durable; the claim is about firing, and the *join* outlives the fire.

## Residual: a green off n=1 is a coverage failure, not a vacuity failure

CFO re-measured `optionsLegOk` on 2026-08-05T08:32Z:

```
optionsLegOk             true    <- was `null` on 2026-07-30
optionsLegMeasuredCount  1
optionsLegSlavedCount    207
```

`602c276` did its job — the gate is falsifiable and the denominator is published — but **`null`
degraded to `true`**. `null` said "not measured"; `true` says "passed", and any acceptance criterion
reading the boolean now consumes a fleet-wide green asserted off **one** row against 207 slaved ones.
The counts sit right there and a naive reader steps past them.

This is a distinct axis from the join and was **not** closed by this ticket: it needs a coverage rule,
not an independence fix. **Fixed on TRA-2924** (below); this ticket also handed it the post-deploy
live re-measure of both this cohort and the `cashInvariant` fix.

It is the **third** failure mode of this family, and the standing rule at the end of this document
now covers all three:

| # | Shape | Ticket | Covered by the rule? |
|---|---|---|---|
| 1 | cohort **empty**, `every` scores green | TRA-2635 | yes — clause 2 |
| 2 | cohort non-empty but **tautological** | TRA-2671 | yes — clause 1 |
| 3 | cohort non-empty, non-tautological, but **negligible** | TRA-2924 | yes — **clause 5** |

### TRA-2924 — the coverage fix

`optionsLegOk` is now gated on `optionsLegScope`, a `'fleet' | 'partial' | 'not-measured'` label
computed from one identity: **`optionsLegSilencedDates` — evaluated rows carrying a non-zero figure
on at least one leg that were nonetheless kept out of the denominator — must be EMPTY** for a green.
No row count and no share threshold appears anywhere in the branch. `partial` reports `null` and
keeps the residual evidence in `optionsLegCoveredDates`; `optionsLegCoverageShare` is published as
description only and nothing branches on it. The route-level fold is gated on the same identity, not
on the per-book labels — a book can be `not-measured` and still be silencing rows, and folding labels
would let that silence hide behind another book's `fleet`.

**Live verdict, 2026-08-05T23:42Z, build `237c147e`** (all 228 post-baseline rows replayed through
the new rule):

```
optionsLegOk            true  ->  null        (the deployed value, and what it becomes)
optionsLegScope                   partial
optionsLegMeasuredCount 1         admin 2026-08-04 — the only independently-graded row on the fleet
optionsLegSilencedDates 85        all 85 journal-slaved; 0 from an absent report leg
optionsLegCoverageShare           0.0116
```

Note the honest denominator is **86, not 208**: of the 207 slaved rows, 122 carry 0.00 on both legs
and could not have disagreed under any writer, so they silence nothing. The gate was claiming the
fleet off **1.16%** of the rows that had something to say.

**The fleet green is currently unreachable, and that is the finding rather than a defect in the
gate.** While `syncEodReportOptionsLegs` slaves every journal row, no build can produce an empty
silenced set. The instrument now says so instead of reporting a green. The independent signal to
grade in the meantime is the credit axis (`equityAbsorbedOptionsOk` / `uncreditedOptionsUsd`), item
1 of AC4 below.

## AC3 — regression controls

Per fixed pair, a control that **fails on the tautological version**, built to the `602c276`
template: *a slaved row and an unslaved row with IDENTICAL numbers must grade differently.*

| Pair | Control | Verified to fail on the tautology? |
|---|---|---|
| `optionsLegOk` (independence) | `pnl-reconciliation.test.ts` — slaved/unslaved rows, measured/slaved counts, RED-outranks-NOT-MEASURED | yes (`602c276`) |
| `optionsLegOk` (coverage) | `pnl-reconciliation.test.ts` → 6 `TRA-2924` arms — identical drift, identical MEASURED count, coverage the only difference | **yes** — reverting the green branch to `measurable.length === 0 ? null : true` reds 4 of 6 with `expected true to be null` |
| `cashInvariant.ok` | `health-routes.test.ts` → `TRA-2671 cashInvariant is not self-confirming` (3 arms) | **yes** — reverting `ok` to `Math.abs(cashGap) < 0.01` reds 2 of 3 arms with `expected true to be null` |

The `cashInvariant` control pins all three edges deliberately:

- a repair-slaved book and an independent book with **byte-identical** equity/cash/positions grade
  `null` vs `true` — the arithmetic is provably identical on both arms (asserted), so the verdict
  cannot be resting on it;
- **RED outranks NOT MEASURED** — drift re-opened *after* the repair still reads `false`, so the
  `null` branch never becomes a hiding place for a live defect;
- `repairSlaved` keys on the **record**, not the delta's magnitude — a zero-delta repair joins the
  operands just as completely as a $3,243 one.

## AC4 — the short list: gates that survive as genuinely falsifiable

Future graders may treat a green from these as evidence. Everything not on this list must be read
with its denominator.

1. `pnl-reconciliation` → **`equityAbsorbedOptionsOk` / `uncreditedOptionsUsd`** — journal vs equity
   ledger, no joining writer. (Read `liveUncreditedOptionsGradeable` on the `live*` variants: TRA-2831
   scopes them for mode-span contamination.)
2. `pnl-reconciliation` → **`counterDurableOk`** — three durable snapshot fields, explicitly unjoined.
3. `pnl-reconciliation` → **`priorOptionsLagOk`** — exchange-session-adjacent since TRA-2835. A
   post-gap PASS remains provisional; a FAIL is conclusive.
4. `env-drift` → **`ok`** — with `comparedKeys` as the denominator. *(Caveat: if every declared
   literal were self-healed, `comparedKeys` would reach 0 and `ok` would read `true` on an empty
   cohort — the TRA-2635 shape, not this one. Live it is 40.)*
5. `parity-reconcile` → **`parityGapUsd`** — fill vs quoted mid, two independent sources.
6. `demo-book` → **`cashInvariant.ok` when `repairSlaved: false`** — that qualifier is the whole
   point of the fix.

**Not gradeable, whatever they read:** `drift` / `ok` / `maxDriftUsd` on `pnl-reconciliation`
(pooled lossy + durable); `stockLegOk` (lossy operand); `optionsLegOk` whenever `optionsLegScope`
is not `'fleet'` — which is every build while `syncEodReportOptionsLegs` slaves the journal rows.
Read the SCOPE, never the bare boolean.

## The standing rule

Proposed by CFO on this ticket and adopted here, because an inventory decays and a rule does not:

> **1. Every comparison verdict publishes the size of the cohort that could have falsified it.**
> Not the rows iterated — the rows on which a disagreement was *possible*. Rows whose operands a
> writer joined are excluded from that count and published separately.
>
> **2. A verdict whose measurable cohort is empty reports `null` or RED. Never `true`.**
> `every` is true on the empty set; a boolean cannot distinguish "passed" from "never asked".
>
> **3. RED outranks NOT MEASURED outranks GREEN.** A joined row that *still* disagrees means the
> repair writer failed — a real defect the `null` must never swallow.
>
> **4. When you ship a repair/sync/backfill writer, grep for the gates that read its operands.**
> Converging two ledgers is the right fix for the data and destroys every instrument comparing them.
> Fixing the disagreement and reading the gate are the same two ledgers from opposite ends.
>
> **5. A verdict may claim the cohort it MEASURED and nothing else** (TRA-2924). Publishing the
> denominator is not enough — clause 1 shipped on `optionsLegOk` and it still graded a fleet-wide
> green off 1 row against 207. A green is quotable fleet-wide only when the set of rows that *had
> something to say and were not asked* is EMPTY. Publish that set; excluding a row for a good reason
> (joined operands, absent operand) is still excluding it. Otherwise the verdict is `partial`, which
> reads as `null`, and the rows that did pass are named separately so the finding survives.
>
> **The coverage rule takes no constant.** Not a minimum cohort size, not a share threshold. A
> constant decays exactly the way a dollar-denominated board card does: it needs re-tuning every time
> the fleet changes shape, and re-tuning is how a threshold quietly stops binding. The branch is
> `silenced.length === 0`, which holds identically at n=1 and at n=200. Publish a share if you like
> — as a *description*, with nothing branching on it.
>
> Corollary: **a rows-with-substance test, not a rows-excluded test.** A row that scores 0.00 on both
> legs could not have disagreed under any writer, so excluding it costs no coverage. Without that
> qualifier the scope reads `partial` on any book with a quiet day and the green becomes unreachable
> — a gate with no green state grades nothing, which is the dead end TRA-2630 found on `ok`.
>
> Corollary: **apply the rule at every level the verdict is folded at.** The live 2026-08-05 read did
> not come out of the per-book gate at all; it came out of `engines.some(e => e.optionsLegOk === true)`
> in the route, which let one book speak for 62. A coverage rule enforced one level down is not
> enforced.

### Reviewer checklist for a new comparison gate

- Name both operands' **last** writer. If it is the same function, there is no gate.
- Ask: *what row, existing or constructible, makes this verdict `false`?* If you cannot write one,
  you cannot ship the gate.
- Ship the control **before** the fix and watch it fail; a control never seen red is not a control.
