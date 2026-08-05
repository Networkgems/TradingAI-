# EOD ledger: permanent fleet-wide gap, 2026-07-30 / 07-31 / 08-03 — TRA-2888

Parent: TRA-2886 (CFO ruling, 2026-08-04 — branch (i) + item 3 YES). Root cause on
tape under TRA-2817 and routine `2e6a9e6b` fire-4.

> **If you are reading EOD ledger data covering 2026-07-30 through 2026-08-03: those
> three sessions do not exist and never will.** Every book steps 2026-07-29 →
> 2026-08-04. This is not a query bug, not a filter, and not a pending back-fill.

## The gap

| | |
|---|---|
| Sessions | **2026-07-30** (Thu), **2026-07-31** (Fri), **2026-08-03** (Mon) |
| Scope | **Fleet-wide.** Not live-book-only. |
| Status | **Permanent and unrecoverable** |
| Capture | **NEVER CAPTURED** — not lost in transit |
| Back-fill | **Not authorised.** `ENABLE_EOD_ROW_BACKFILL` stays `false` on bqb1 |

### Measured, not assumed

Independent re-read of `GET /api/health/pnl-reconciliation` on bqb1,
**2026-08-05T03:17Z, build `237c147e`**, 62 engines / 61 with rows:

- **47** books have a history that spans the window (a row on/before 2026-07-29
  **and** a row on/after 2026-08-04).
- **47 of 47 are missing all three dates. Zero partials.**
- **No book anywhere holds a row on any of the three dates.**

The parent ruling cited 61. 61 is the count of engines with *any* rows; 47 is the
count whose history actually spans the window and can therefore be graded on it.
The remaining 14 are qa/verify books created after the outage. The finding is
unchanged, and tighter: 47/47, not 47/61.

## Why the figures cannot be recovered

`/data` was at **ENOSPC from 2026-07-30 through 2026-08-04T21:20Z** — out of
**inodes, not bytes**. Appends kept succeeding while file *creates* failed, so
every disk-space axis read green throughout (TRA-2817).

The 21:00 ET archive fired **on time**, on the closes on tape, on both nights.
Each EOD report/snapshot write then died with `EOD report failed ... ENOSPC`
across 47 books. **The capture failed at the only moment the figures existed.**

No upstream store holds these sessions. There is nothing to restore — which is
why widening the back-fill was *refused*, not deferred. If anyone proposes arming
`ENABLE_EOD_ROW_BACKFILL` to fill these dates, this ruling is the answer.

## Why every health field read green over it

An absent session leaves **no row to flag**. All three shipped presence axes
iterate rows that exist:

| Axis | Why it cannot fire |
|---|---|
| `eodRowMissing` (per row) | Walks `days[]`, built *from* the persisted snapshots. A session with no snapshot is not in `days[]`, so it is never walked. |
| `eodRowsPresentOk` | Folds the above. Inherits the blindness exactly. |
| `eodTailStaleSessions` (TRA-2817) | *Does* enumerate from the calendar — but only over `(newestRow, lastSettledSession]`. A **tail**, and a tail empties the moment a later row lands. |

At the 2026-08-04T21:38Z reference read `eodTailMaxStaleSessions` was **3**. When
the fleet wrote its 2026-08-04 rows the anchor advanced 07-29 → 08-04 and the
three sessions left the cohort. The metric went **3 → 0**, which reads as a full
recovery and is in fact the evidence being **evicted** from the only cohort that
could see it.

### Retired acceptance predicate

The TRA-2829 acceptance line — **"`liveEodTailStaleBooks` is empty"** — is
**RETIRED and must not be graded.** It is already true on live and it
discriminates nothing: it went green by *eviction*, not by repair, and now reads
identically on a healthy ledger and on one missing three fleet-wide sessions.
Any tail-shaped predicate inherits this; the emptiness is structural, not
evidential.

Grade the **set of usernames in `eodInteriorAbsentBooks`** instead.

> **2026-08-05, TRA-2943 — this pointer used to name `eodInteriorAbsentOk` and
> that is now wrong.** The fleet boolean is **RETIRED — PINNED FALSE** by the
> adjudicated `enock` absence and would not move if a second book went interior
> absent; a *count* is exactly as dead the moment one book permanently occupies
> slot one. Grade the **SET**. See
> [The retirement of `eodInteriorAbsentOk`](#the-retirement-of-eodinteriorabsentok-tra-2943)
> below. `liveEodInteriorAbsentOk` is a different cohort and stays gradeable.

## The replacement detector (TRA-2888 AC2)

`packages/server/src/eod-ledger-gap.ts`. It enumerates expected sessions **from
the NYSE exchange calendar** — the same one the 21:00 ET archive runs on — and
diffs against the rows actually present, rather than iterating existing rows.
That inversion is the whole fix: *you cannot discover a missing session by
iterating the sessions you have.*

Published on `/api/health/pnl-reconciliation`:

| Field | Meaning |
|---|---|
| `eodInteriorAbsentBooks` | **The discriminator of record** (TRA-2943) — new interior holes, named, with dates |
| `eodInteriorAbsentOk` | Tri-state fleet fold; `null` = NOT MEASURED, never green. **RETIRED — pinned false, TRA-2943. Do not grade** |
| `eodInteriorAbsentOkRetirement` | That retirement, machine-readable: the ruling, the identity it is pinned by, and the four closed remedies |
| `eodInteriorAbsentRawBookCount` | **The acceptance arm** — books absent *before* the documented-gap exclusion |
| `eodInteriorDocumentedGapBooks` | Books carrying this documented gap |
| `eodDocumentedGap` | This ruling, machine-readable, incl. `backfillAuthorised: false` |
| `liveEodInteriorAbsentOk` | Live-cohort scoping of the verdict |

Span is `[max(firstRow, reconciliation baseline), lastSettledSession]`; *interior*
is an absent session strictly before the book's own newest row (the tail keeps
its own axis, so the two stay disjoint and a resumed writer's green tail cannot
mask the hole behind it). The `max` is load-bearing: a book is never graded over
sessions that predate its own first row.

### The exclusion is an allow-list, never a range

The three dates are excluded from the *verdict* and reported separately —
fleet-level under `eodInteriorDocumentedGapBooks`, and per book under
`engines[].eodInterior.interiorAbsentDocumented`, so a reader pulling one book's
range encounters the gap on that book's own object. The exclusion is a
**three-element allow-list** —
not a date range, not a `>=` bound, not a suppression window. A range would
swallow the next incident and a bound would swallow every incident after it. A
fourth absent session is a **new incident** and goes red.

## The retirement of `eodInteriorAbsentOk` (TRA-2943)

**CFO ruling 2026-08-05, adjudicating TRA-2942, disposition C: accept the standing
red.** The fleet boolean is now permanently `false` for an adjudicated reason, so
it discriminates exactly as little as a predicate pinned `true`.

**The incident, recorded as an IDENTITY and not as a date list:**

> `enock` has no EOD ledger row for **any NYSE session in 2026-06-15..2026-07-24**;
> the rows were **never written**. Plus two isolated legacy absences, **2026-05-08**
> and **2026-05-15** (the TRA-388 blank-calendar incident). **Thirty absent
> sessions** — 28 contiguous + 2 isolated.

The ten dates the route publishes for `enock` (2026-07-13..07-24) are the
post-baseline **remainder**, a clamp artifact of
`spanStart = max(firstRow, baselineDate)` with `baselineDate` env-pinned at
2026-07-12 by `resolvePnlBaselineDate(process.env)`. They under-size the incident
by **64%**, and they would change if that env ever moved without one ledger row
changing. A dates-list record decays; an identity does not. This is also why the
red **does not self-heal**.

**Cause: NOT MEASURED**, ratified. The two candidates — the book had no
`UserContext` in `getAllUserContexts()` those nights, or `generateAndSaveReport`
threw inside `runDailyCloseForAllUsers` — are both swallowed to a single
`log.warn`, neither leaves a durable artifact, and Render retention does not reach
2026-06-15. The 2026-07-27 resumption is suggestive and is **not** evidence.

**Nothing is excluded.** `enock` stays inside `eodInteriorAbsentBooks` with its
dates and the verdict stays red. That is the entire difference between this record
and a suppression: misuse of an annotation stays visible in the raw array, misuse
of an exclusion does not.

**Closed remedies** (all four refused by the ruling; see
`eodInteriorAbsentOkRetirement.forbiddenRemedies`):

1. Adding `enock`'s dates to `EOD_DOCUMENTED_GAP_DATES` — that constant is
   fleet-wide and cannot scope per book; it would suppress 28 sessions across 61
   books to green one demo book.
2. Building a per-book exclusion primitive — the cost is a permanent blinding
   primitive plus the raw audit arm needed to keep it honest.
3. Arming `ENABLE_EOD_ROW_BACKFILL` — these rows were never captured; TRA-2888
   stands verbatim and is not reopened.
4. Advancing the `baselineDate` env past 2026-07-24 — it greens the field by
   moving a data-integrity cutoff and changes what every other post-baseline
   verdict measures.

Exposure: **zero live capital.** `enock` is `mode: demo`;
`liveEodInteriorAbsentOk` is `true` with `liveEodInteriorAbsentBooks` empty across
both live books, and `liveEodBackfillArmed` is `false`.

### Acceptance arms (pre-registered before the detector was built)

| Arm | Cohort | Required | Measured |
|---|---|---|---|
| **A** RED before exclusion | 47 participants | red on all | **47/47 red** |
| **B** GREEN after exclusion | 46 participants | green | **46/46 green** |
| **C** Clean control | 14 non-participants | never red | **14/14 green** |
| **D** Not blinded by the exclusion | fleet | a new hole still fires | **1 red: `enock`** |

Arm A is the one that matters: a detector that cannot go red on a hole we *know*
is there has not been tested. There is **no** clean control inside the outage —
47/47 participants missed all three — so arm C uses the 14 books whose history
does not span the window, which is a real control rather than the offender set
re-read.

`absentSessionsCovered` / `absentSessionsUncovered` (from `eod-row-backfill.ts`)
are **not** acceptance for anything. Both increment only while iterating
`absentSessions`, which is empty fleet-wide, so both score 0 whether or not
anything was examined. Zero there means "nothing was examined", not "nothing was
wrong".

## Arm D found a second, unrelated hole

`enock` post-baseline rows are `2026-07-27, 07-28, 07-29, 08-04`, while its ledger
starts 2026-05-03 — the book existed throughout. That is **10 absent post-baseline
sessions, 2026-07-13 .. 07-24**, in the interior of a live ledger, reading green on
every field published before this ticket.

This is a **separate incident** from the ENOSPC outage and is **not** folded into
the documented gap. It is the live demonstration that the exclusion did not blind
the detector.

## What this does NOT discharge

The **TRA-2829 provenance ceiling still binds.** The live book's post-baseline
`optionsDailyPnlSource` is **`journal-repair`, not `journal`**. A resumed ledger
confirms the ledger resumed, nothing more. Neither AC1 nor AC2 completion may be
read as provenance restoration.
