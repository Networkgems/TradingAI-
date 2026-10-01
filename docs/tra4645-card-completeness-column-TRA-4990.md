# The TRA-4645 priority-1 column is NOT `summary.complete` (TRA-4990)

**Status:** decided and landed, 2026-10-01. Supersedes every prior reading of
`summary.complete` as the acceptance column for TRA-4645 priorities 1 and 4.
Source read at `73ab0025` — the live `tradingai-bqb1` build at 2026-10-01T20:40Z,
DRIFT 0.

## The decision, in one paragraph

`summary.complete` **cannot** answer "does this product produce an actionable
Trade Opportunity Card", because it is the OTM sleeve's **admission rate**
expressed as a card statistic. The column that answers the question priority 1
actually asked is **`completeExceptAdmission`**: every one of the ten fields
populated, and the only thing refusing is the sleeve's own admission decision.
It ships on the card, on `summarizeCards`, on the TRA-4936 per-ET-day fold
(`byWindow.<bucket>.completeExceptAdmission`, hoisted as
`completeExceptAdmissionInWindow`) and on the never-evicting since-boot roll
(`etDaysWithCompleteExceptAdmission`, `lastCompleteExceptAdmissionEtDay`).

## Why `complete` is the admission rate

`trade-opportunity-card.ts` appends, for **any** `signalSkipReason` /
`liveSkipReason`:

```ts
criteria.push({ name: 'not_suppressed', ..., kind: 'admission', pass: false });
```

An `admission`-kind failure with no failing `data` criterion makes `entryTrigger`
**`refused`**, and `complete` is `incompleteFields.length === 0 &&
refusedFields.length === 0`. So a `complete: true` OTM card requires a signal
that cleared every gate and reached `openOptionFromCandidate` — there are exactly
two such sites in `runOtmScan`.

What TRA-4645 priority 1 asked for was:

> Convert **every signal** into a clear proposed trade: setup, entry trigger,
> invalidation, target, holding period, contract choice, liquidity, estimated
> slippage, position size, and "why now."

That is a statement about the **card**, not about whether the sleeve entered. A
card that states all ten things and says "the cost bar refused this entry" is
priority 1 **delivered**. `complete` scores it as a failure. Priority 4
("Decision-quality UI: What is the trade? Why is it valid? What breaks it? How
much can I lose?") likewise asks for a stated proposal, and "how much can I
lose" is the sizing field — Pin 2 below.

⛔ **The remedy is not to loosen `not_suppressed`.** TRA-4974 ruled that out and
the criterion is correct: a suppressed signal is not an actionable proposal, and
a refused card still must not reach `proposed` (TRA-4651). The criterion still
reads `pass: false`, `entryTrigger` is still `refused`, `complete` is unchanged.
Only the question being asked changed.

## The reading order

| Cell | Means | Who acts |
| --- | --- | --- |
| `unbuildable` | ≥1 field the builder **could not populate** | us — missing inputs / coverage hole |
| `completeExceptAdmission` | all ten fields stated; only admission refuses | **the priority-1 answer** |
| `refusedByCardRule` | fully built, declined by a **card** rule (sizing, contract, costs) | us — the rule may not be the enforced one |
| `complete` | …and the sleeve admitted the entry | the sleeve / the market |

The first three are an **exhaustive partition** of `built`, asserted as a sum
identity in `tra4990-card-admission-and-sizing.test.ts` AC2 — and derived
independently (the card's boolean vs its two field arrays) so the identity can
actually fail rather than being true by construction.

`completeExceptAdmission − complete` **is** the admission rate. It was always
being reported; it was just wearing a completeness costume.

### On a window-gated family, read it beside the window bucket

TRA-4936's `builtInWindow` says whether the in-window population was sampled at
all; `wiring[].verdict` says whether a zero there is real. Only then is
`byWindow.in_window.completeExceptAdmission` meaningful. `>0` beside
`completeInWindow: 0` is a **healthy product whose sleeve admitted nothing** —
a finding about the gates and the market, not about the card surface. That pair
is exactly what three grading attempts on TRA-4645 could not express.

## Pin 2 — the card's sizing model was not the one the sleeve enforces

The card refused `sizing` when
`floor(managedEquity × riskPerTrade / (stopDistance × 100)) === 0`.

**No OTM entry path runs that model.** Measured in source:

- **live bounded test** — `capOtmEntryContracts(resolveLiveOptionTestContracts(
  askLimit, min(availableCash, testCap), maxContracts), otmFloor)`, and exactly
  1 under a TRA-3401 one-shot grant;
- **demo / paper** — `floor(otmBudgetPerTrade / (premium × 100))` via
  `sizeContracts`, then `capOtmEntryContracts(..., maxContractsPerEntry)`.

Both are **premium-notional** models clamped to the contract floor's 2-per-entry.
Stop distance is an input to neither. So the two disagree in the direction that
matters — the engine opens 1 contract while a stop-distance budget buys 0 — which
was **47 of the 50** cards retained on 2026-10-01. A card describing a row the
engine actually placed, and refusing it, is an instrument that cannot grade the
sleeve.

### What landed

1. `OptionsAccount.otmSizedContracts` — the contract count extracted out of
   `openOptionFromCandidate` as **one expression**, so the open path and the
   card's preview cannot fork. No bound moved: `maxContractsPerEntry`, the
   per-position cap and the bounded-live override are consumed exactly as before.
2. `OptionsAccount.previewOtmContracts(mark, mode, opts)` — a read. Opens
   nothing, spends nothing. `0` ⇒ the enforced sizer refuses; `null` ⇒ the mark
   was unreadable, which must never be published as an enforced zero.
3. `CardBuildContext.enforcedOptionSizing` — the count the caller already
   computed, never a bound re-implemented inside the instrument. Supplied ⇒ it
   **governs** `fields.sizing`, and the stop-distance figure drops to an advisory
   number beside it (`riskBudgetContracts`, `divergesFromRiskBudget`).
4. `signal-engine.ts` supplies it for `WINDOW_GATED_CARD_SIGNAL_TYPES` only —
   claiming the OTM model for an RV or directional option row would publish a
   bound that row's exec path never applies.
5. Absent ⇒ the **verdict is unchanged** (no capital behaviour change, no silent
   re-bucketing) but the `basis` string now says `RISK-BUDGET ADVISORY … NOT the
   enforced model`. A basis naming a model the engine does not run was the defect.

`divergesFromRiskBudget` is three-valued on purpose: `true` / `false` / `null`
for "only one model was read". "Could not compare" must never share a value with
"checked and they agree".

## Why the live population is not cited here

The `/api/cards` ring was **empty** at 2026-10-01T20:40Z: `cards: 0`,
`summary.total: 0`, `retained.kept: 0`. The box booted at 20:19:52Z, 20 minutes
after the close. A fold over that population would have reported every new cell
as `0` and proved nothing — so the two pins are re-derived from the builder and
the account in `tra4990-card-admission-and-sizing.test.ts`, with both the passing
and the failing direction on every assertion. The 47-of-50 figure above is
TRA-4974's measurement against `faae938837bf`; it is quoted, not re-read.

## Negative controls that were actually run

| Control | Planted | Fails exactly |
| --- | --- | --- |
| A | `completeExceptAdmission := complete` (the pre-fix column) | the 3 AC1 column tests + all 3 AC2 partition tests |
| B | the enforced sizing branch ignored (pre-fix Pin 2) | the 3 AC3 enforced tests, plus the AC1/AC2 cases whose fixture stops being `complete` — Pin 2's divergence contaminating Pin 1's column, which is the whole ticket |
| C | `previewOtmContracts` forked off `otmSizedContracts` | the 2 AC4 one-expression tests, and nothing else |

Each control was graded by **which** tests failed, not merely that any did.

## What this does NOT do

- No capital behaviour change. Both pins are instrument-side.
- `maxContractsPerEntry` and every capital bound are untouched.
- It does not make `complete: true` reachable from a refusal, and must not be
  read as having done so.
- `pnpm test` in `packages/server`: **10947 passed, 5 failed** — the identical
  five that are red on `73ab0025` before this change
  (`tra3942` AC1, `tra3944` AC4, `tra3953`, `live-nav-tripwire` TRA-3449,
  `option-spread-cost` TRA-2306 census). `tra3944` AC4's failure is
  `expected -1 to be greater than -1`: its literal
  `const testContracts = capOtmEntryContracts(` was renamed by TRA-3401, so the
  predicate is **blind**, and it short-circuits before reaching its account-side
  assertion. That assertion's exact string survives this refactor byte-identical
  — verified directly, since the test cannot. Repairing TRA-3401's stale literal
  is filed separately rather than folded in here.
