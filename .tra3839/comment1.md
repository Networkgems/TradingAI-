## Built, merged, controlled. NOT deployed -- and the ticket's suggested shape would have shipped the inverse defect.

`8620ca37` on `origin/main`, pre-push deploy-build gate CLEAN. Baseline pinned in this same beat off the LIVE route: bqb1 `b70404f3c07b`, pid 75, 42 top-level keys, `liveStopActionability` PRESENT and carrying no `unacted` key -- so the field's arrival is gradeable as a transition rather than asserted.

## The join reproduces live, and its cause is not the one the ticket assumed

Measured 2026-08-18T21:34Z:

```
/api/health/options-live   liveStopActionability : breached 0, actionable 0, inert 0
/api/health/exit-cadence   books.live            : enabled false, engineCount 3,
                                                   armedEngineCount 0, verdict "disarmed"
                           books.live.tickPassCount : 318
```

That last line is the finding. The ticket suggested qualifying the row grade with `cadenceArmed`, and **keying on `armedEngineCount` / `timerArmed` would have been wrong in the expensive direction.** Those grade the DECOUPLED hoist; `doTick` calls `runOptionsExitPass` unconditionally at `signal-engine.ts:5905`. The live book is reading `armedEngineCount: 0` NEXT TO `tickPassCount: 318` right now -- TRA-3821's finding, still true. A detector keyed on that arm flags the entire healthy live fleet as unattended, and an over-matching detector voids every future clean read, which is strictly worse than the blindness it replaces.

The decisive fact is not on `/api/health/exit-cadence` at all:

```
signal-engine.ts:5551
const optionsExitsActive = this.mode === 'demo' || isStockMarketOpen();
const optsClosed = optionsExitsActive ? this.optionsAccount.checkExits(...) : [];
```

**On a LIVE book `checkExits` is not called outside RTH at all** (TRA-726's no-day-trading hold), while `stampExitPass('tick')` fires unconditionally either way -- so a rising `exitPassCount` is NOT a witness that any live row was evaluated. At 21:03Z the reason nothing would have acted was the session gate, not the disarmed hoist.

## What ships

**`unacted` is the number.** `unacted = inert + noExitPass`, published on the same object, covering both causes the ticket names:

- `unactedByCause: { rowGate, noExitPass }` keeps them separable.
- `exitPass: { reaches, blockedBy, resumesAt, lastPassAgeMs }` per book. The walk is outermost-first, so `blockedBy` names the thing that would still refuse if everything below it cleared: `no_pass_observed` -> `pass_stalled` -> `engine_mode_demo` (the TRA-231 mode filter skips every live row when the engine is demo) -> `market_closed`.
- `market_closed` is the only blocker with a clock, so it is the only one that gets `resumesAt`. `exitPassResumesAt` / `exitPassIndefinite` at fleet level mirror `releasesAt` / `indefinite` exactly.
- `nextStockMarketOpen` is DEFINED by `isStockMarketOpen` (coarse scan + minute walk), not a second formula for the session boundary. A horizon that models the gate independently is the same defect class this ticket closes. It inherits the gate's holiday blindness deliberately: it predicts when the CODE resumes evaluating, which is the question being asked.
- `optionsExitPassRuns` is now the SINGLE expression at both the `checkExits` call site and the health readout, so the route cannot claim a pass runs when the pass site disagrees.

## Constraints -- measured, not asserted

`git diff -U0 | grep "^-[^-]"` over the four modified files deletes only two import lines, the `optionsExitsActive` expression and one docblock I rewrote. **No line of `summarizeLiveUnmanagedRisk`, `summarizeLiveStopActionability`, `mergeLiveStopActionability` or the chandelier counter is touched.** TRA-2820's dropped-schedule signal and TRA-3217's structural-break canary are not widened, and neither is `actionable` -- the join composes on top of its meaning rather than editing it. TRA-3822's 26 tests and TRA-3829's 7 both re-run green, unchanged.

`inFlight` is deliberately EXCLUDED from `unacted` even when no pass reaches: something IS working at the broker, and whether it is stalling is `staleWorkingExits` / `abandonedStagedExits` on this same route. Folding it in would double-book one incident across three counters.

The blind branch nulls the new fields with the rest -- a blind instrument publishing `unacted: 0` is the exact reading this field exists to prevent.

No OCC symbols added: counts, reason codes and timestamps only (TRA-2163 standing).

## Controls: 34 green, and all four mutations bite

The green run is not the evidence; the mutations are.

| mutation | expected catcher | red |
|---|---|---|
| M1 over-match -- cadence keyed on an always-disarmed arm | negative reach controls | **4** (all 3 + mid-session end-to-end) |
| M2 under-match -- `market_closed` dropped = the PRE-FIX blindness | positive controls | **3** incl. THE TICKET end-to-end test |
| M3 over-match on the row axis -- `inFlight` folded into `unacted` | in-flight negative control | **1** |
| M4 horizon from a second model (hardcoded EDT 13:30Z) | boundary control | **2**, caught by the EST fixture |

**A control-design defect I found and fixed mid-build, worth recording:** the first cut graded the two halves only at their injected seam, and M2 -- the ticket's own central defect -- cost a SINGLE assertion, because nothing composed the real walk with the real join. Two stubbed halves can both be green while the wiring between them is the bug. I added an end-to-end block that builds the cadence fact from raw engine facts exactly as `getLiveStopActionability` does; M2 then killed 3 including the ticket fixture. The numbers above are all post-fix.

Both fixtures the ticket pins are in the suite: the 21:03Z flat book must stay 0 (it does -- a cadence-only detector would alarm every evening), and that same cadence state with one synthetic breached live row carrying no gate must NOT read as an all-clear (it reads `unacted: 1`, `blockedBy: market_closed`, `resumesAt: 2026-08-19T13:30:00.000Z`).

## Why I did NOT deploy tonight

We are outside the `render-redeploy.mjs` freeze right now, so the gate would have let me. I held anyway: `b70404f3` reached bqb1 at 20:41Z and **TRA-3827 still has to verify ITS live bytes on that build**. Re-pinning the host now moves the subject out from under someone else's pending live grade. Next slot is after Wed 2026-08-19 close (20:00Z), which is what this ticket's own disposition already says.

## Separately: `main` is RED on 24 live-OPEN tests, and it is not mine

Found while establishing a clean baseline for this change, and reported because it sits on the real-money entry path. I ran the full server suite against a detached worktree at clean `HEAD` to check whether my failures were pre-existing. They were -- **every failure in my tree is a strict subset of the baseline's** (mine 24 failed / 3 files, baseline 25 / 4). Bisected: green at `0ce72266`, red at `b70404f3` = **TRA-3836's canary ceiling**. The shape is `expect(buyContractsLimit).toHaveBeenCalledTimes(1)` -> called 0 times, i.e. the fails-closed $100 per-order ceiling now refuses fixtures whose premium exceeds it, across TRA-319 / TRA-1929 / TRA-2763 / TRA-3216 / TRA-3445.

The guard is behaving as ratified; the suite that protects the live entry path is what is now uninformative, and 24 permanently-red tests are how a suite gets tuned out. Filing it as a first-class issue rather than fixing it here -- it is not this ticket's scope, and the fixtures encode a posture decision that is not mine to make.

## Disposition

`in_review` behind a monitor at 2026-08-19T20:30Z -- after the deploy slot opens. Remaining: deploy, then grade `unacted` on LIVE bytes (key present, `instrumentBlind: false`, and the fold non-vacuous via `booksGraded` against `liveArmCensus.booksScanned`). The live read will be VACUOUS while the book is flat, exactly as TRA-3822's was -- detection power comes from the controls above, never from a clean live zero, and I will say so again at close rather than let the zero read as a pass.
