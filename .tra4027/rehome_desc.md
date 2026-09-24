## Deferred grade, re-homed from TRA-4027 AC5 (precedent: TRA-4357 AC5 -> TRA-4441)

TRA-4027 shipped `c4b9ca2a` (live on bqb1 since 2026-08-26): a book-served options row with a journal OPEN twin divides `pnl_r` by the twin's `atRiskUsd` (open mark), publishes `premium_basis_usd` (the divisor) and a partitionable `pnl_r_basis` (`premium-open-mark` | `premium-fill` | `stop-distance`). AC1-AC4 are graded (unit twin with fill != mark, 162/162 tests) and the identity `pnl_r == net_pnl_usd / premium_basis_usd` has held on 8 consecutive live reads across 4 weeks and 5+ builds - but every one of those reads was 100% journal-served. The half that was defective, the BOOK mapper live across the 21:00 ET archive edge, was never graded on a real row, because the fleet stopped opening options: 20 consecutive flat sessions (09-03..09-22), `daysWithOptionOrders=[]`, and TRA-4376 ruling rev 2 (09-16) wrote the OTM evaluation window terminal (`verdict_insufficient_population` atN 4) with NO successor authorized (armed selector `[0.25,0.40]` disjoint from the cell; TRA-4569 standing NO-GO). TRA-4027's recorded decision rule therefore closed it on AC1-AC4 + the journal-side identity and re-homed the live book-side grade here.

## What this issue owns

**The live archive-edge invariance grade, when option flow resumes:**

1. Detector (lossless at any cadence inside the ~30d capture retention): `node scripts/tra4027-export-r-instant-live.mjs --since=<last read ET day>` reads `/api/health/order-provenance-capture` per-ET-day option-order counts (includes `sell_to_close`) + `/api/state` `openOptionsNow`. Carry each day's `attestation` (a `partial` day covered one account). Exercise the positive control (`--since=2026-08-24` fires and names 6 days) in the same beat as any empty reading.
2. On a close day with |net| >= $10: pre-archive (post-close, before 01:00Z) `--out=<before.json>`; post-archive `--compare=<before.json>`. Every row joined on `journal_id` must publish the SAME `pnl_r` and `premium_basis_usd` with `crossedEdge: true`. Both reads pinned by `build.pid` + `startedAt`; a pid move between reads = re-pin, never compare across builds.

## Un-park trigger (a FLOW fact, never a date)

This issue rests `todo` and is actionable the session the detector names an option-order day or `openOptionsNow > 0` (same park shape as TRA-4249 AC3). Any successor OTM window is a fresh nomination decision (TRA-4376 rev 2); non-OTM option entries also un-park this - the export grade is sleeve-agnostic.

## Non-goals

Everything TRA-4027 already graded. No code change is expected: this is a grade-only issue unless the graded read fails.

Filed by LeadDev off the TRA-4027 close (fire #8 read, pin `8b87cac15b06` pid 72, startedAt 2026-09-22T21:06:36.896Z). DO NOT ACCEPT any interaction card on this issue - none is intended.
