# TRA-3693 / TRA-3688 — AC1-AC7 evidence, graded against live bqb1

Graded 2026-09-09T01:29-01:40Z by LeadDev. Pre-registered ACs are in the TRA-3693 description;
the spec is the TRA-3688 comment of 2026-08-14T01:54Z (S-1..S-4).

## Build pin (read in the grading beat)

```
GET /api/health/options-live @ 2026-09-09T01:29:19Z
  commit    c7b452c0fc92 (c7b452c0fc9259dc232cdf752f9d0f9810500a8a)
  pid       76
  startedAt 2026-09-08T20:49:38.003Z
```

Ancestry (local checkout, post-fetch): `git merge-base --is-ancestor 3308eb12 c7b452c0` -> TRUE.
The TRA-3688 impl commit `3308eb12` is serving on bqb1. `c7b452c0` is itself an ancestor of the
local/origin main tip `752e12dc` (9 commits behind tip; see AC7).

## Live queue state at grade time — the fact that shapes this grade

`GET /api/state` @ 01:29Z and again @ 01:31Z:

- `signals`: **array[0]** — zero rows of any type, so zero `sma200_pullback`/`sma200_reclaim`.
- `sma200SignalVoids`: **array[0]** — the key is served (C3 surface is live) but holds no records.
- `lastScanAt` 2026-09-09T01:30:12Z (current — the engine is scanning), `marketOpen: false`.

Both arrays are snapshot-persisted across boots (`signal-engine.ts` snapshot/restore carries
`sma200SignalVoids`; verified in source at the live commit), so the empties are a genuinely empty
pre-boot queue, not a boot-reset artifact. The 8-signal baseline in the ticket is 26 days old
(2026-08-14) and those rows left the queue long before the impl deployed — which is why no void
was recorded for them.

**Consequence: AC1, AC2, AC3, the live half of AC4, and AC5 are row-level reads and cannot be
graded on zero rows. An empty queue is NOT a pass (AC5's own text). They are declared
empty-at-grade-time below and re-graded at the next scan that emits sma200 rows.**

## Per-AC grade

| AC | verdict | evidence |
|---|---|---|
| AC1 rr/tp null on live rows | **DECLARED EMPTY — re-grade** | 0 rows. Grader `scripts/tra3693-grade-live.mjs` ran and printed PASS, but a PASS over an empty denominator is vacuous and is not claimed. |
| AC2 atr14/stopAtr/stopBasis/maxDistAtr present, Number.isFinite-graded | **DECLARED EMPTY — re-grade** | 0 rows. Unit-level: engine test "stamps atr14 / stopAtr / stopBasis / maxDistAtr on a pullback, with both AC3 identities" — green. |
| AC3 both equalities on live rows | **DECLARED EMPTY — re-grade** | 0 rows. Both identities are asserted in the same green engine test (and the reclaim variant asserts the measured-distance form). |
| AC4 gate, both arms + dark default | **PASS (unit) / live control deferred** | `packages/engine/src/sma200-signals.test.ts:261-308`, all green in a full engine run (1214/1214): rejects `distAtr≈4.2` at gate 2.0; admits `distAtr≈1.66` and stamps the gate value; shipped default byte-identical to explicit `Infinity`; non-positive/non-finite env reads as DARK never reject-everything (TRA-3440 guard); reclaim not gated. Live no-behavior-change control (count/symbol-set unchanged, `maxDistAtr` reads dark): the pre-deploy baseline is 26 days stale and the queue is empty — deferred to the row re-grade, where every row must read `maxDistAtr: null` (JSON of Infinity). |
| AC5 zero S-3a violations + a void witness | **DECLARED EMPTY — re-grade** | Queue empty, 0 voids. Per the AC's own clause: "explicitly state the queue was empty at grade time and re-grade at the next scan." Unit-level: `packages/server/src/sma200-validity.test.ts` green (11 tests incl. both `voidReason` values). Note the witness may take two sessions: a row fired at the next close cannot void until the following bar (S-3a) or a 0.5-ATR drift (S-3b). |
| AC6 consumer sweep, no null-as-0/NaN/- | **PASS** | See below. |
| AC7 deploy-drift 0 in the grading beat | **PASS surface-scoped (literal read DRIFT=9, all foreign)** | See below. |

## AC6 detail — every consumer touched or swept for C2

- `apps/desktop/src/components/Sma200SignalCard.tsx` — the card sma200 rows render on
  **structurally omits the Target and R:R chips**; `null` has no render path at all. Exports the
  typed predicate `isSma200Signal`.
- `apps/desktop/src/components/dashboard/StockSignalsPanel.tsx:57-61` — partition point: only
  `!isSma200Signal` rows (genuine `TradeSignal`s with numeric tp/rr) reach the generic card's
  `Target`/`1:{rr}` chips. An sma200 row cannot arrive there by type.
- `apps/desktop/src/types/app.ts` — `Sma200Signal` no longer extends `TradeSignal`; the feed is an
  explicit union, so a consumer reaching for `.takeProfit` on an sma200 row is a compile error.
- `packages/server/src/morning-brief.ts:411-413` — `Number.isFinite` guard maps `null` to
  "no target", identically to `undefined`.
- `apps/desktop/src/components/dashboard/panels.test.tsx:202-234` — QA smoke asserting the sma200
  card renders display-only with **no** Target/R:R chips.
- `packages/server/src/reports/eod-report.ts:192` and `crypto-eod-report.ts:101` — read
  `pos.takeProfit` on **positions**, not signal rows. sma200 rows are capital-gated off live and
  cannot become positions; the sole demo-only exception (TRA-1289 forward-test) derives its 2R
  bracket locally at the order seam (`signal-engine.ts:7498-7504`) and never publishes it, so a
  position there still carries numbers. Unaffected by the null.
- `apps/desktop/src/lib/format.ts` — untouched; its formatters are only reached by the fenced
  generic card for these two fields.

Judgment call flagged for QuantTrader (also flagged by CTO on TRA-3693): the order-seam copy
keeping `riskRewardRatio: 2` for the TRA-1289 paper book is an S-2 interpretation — the PUBLISHED
record is null, the bracket mechanics keep the historical 2R so the forward-test book stays
comparable. If S-2 is read as "no 2R anywhere", that seam needs a ruling.

## AC7 detail — drift, and why the counter is not zero

`pnpm check:deploy-drift` in the grading beat reads **DRIFT = 9**: live `c7b452c0` is 9 commits
behind main tip `752e12dc`. Every row is foreign to this ticket (TRA-4412 docs, TRA-4009 fix,
TRA-4009/4145/4241/4350 staging, TRA-3660 slice meter, 2x TRA-4158 tape rows, TRA-4412 doc, the
TRA-3693 grader chore itself).

Surface-scoped drift for the graded contract is **0**: of the 12 drifted files, only
`packages/server/src/signal-engine.ts` overlaps a C1-C4 surface, and its 22 drift hunks contain
zero changed lines matching `sma200|stopAtr|atr14|maxDistAtr|riskReward|takeProfit|voidReason|`
`MAX_DIST` — the nearest hunk is TRA-3660's tick-pacer yield at `:6753`. The sma200 contract
bytes at `c7b452c0` are identical to main tip; the grade is measured against live bytes.

Deliberately NOT deploying to zero the literal counter this beat: CTO ruled on-thread that
"nothing needs to be deployed for this leaf", and another post-close train tonight would destroy
a TRA-4158 boot pair (see commit `5602d74c`, which documents exactly that loss shape at the
20:14Z/20:49Z boots today).

## Suite health note (not an AC)

sma200 server tests green in isolation (`sma200-validity` 10 + `sma200-capital-gate` 11). The
full server suite carries 5 failing tests in non-sma200 files (pre-existing on main; TRA-3744
tracks the red pretest) — the three captured by name: `live-enforce-gate-ledger.test.ts`,
`tra4225-breaker-cause-and-partition.test.ts`, `tra4020-profit-floor-trail.test.ts`, 1 test each,
none touching any C1-C4 surface. Engine suite fully green 1214/1214.
