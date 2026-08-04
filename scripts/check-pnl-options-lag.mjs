#!/usr/bin/env node
/**
 * TRA-2630 AC3 — regression guard for the T+1 options-credit lag (TRA-2629),
 * plus the per-leg drift verdicts that replace the ungradeable `drift`.
 *
 * THE SHAPE
 * ---------
 * `stockDaily` for session N equals `optionsDaily` for session N-1, TO THE CENT.
 * The equity book re-books the previous session's realized option credit into
 * this session's STOCK leg.
 *
 * Root cause (TRA-2629, fixed in `ec05639`): the 21:00 ET writer computes
 *
 *     dailyPnl = (equity - openingEquity) - (credited_now - credited_on_last_row)
 *
 * and `PaperAccountSnapshot.optionsCredited` was never declared on the DURABLE
 * type, so `importSnapshot`'s `?? 0` fired on every boot. `equity` came back
 * holding the option credits while the counter that exists to cancel them came
 * back 0. bqb1 restarts several times an hour, so every session lost the left
 * endpoint of that subtraction.
 *
 * WHY THIS SCRIPT EXISTS RATHER THAN A UNIT TEST ALONE
 * ---------------------------------------------------
 * The unit tests in `pnl-reconciliation.test.ts` pin the DETECTOR. They cannot
 * pin the WRITER, because the writer's failure mode is a durability seam — an
 * in-memory export→import round trip passes while production is broken (the
 * TRA-2629 lesson, and the reason the defect supplied a false regression signal
 * on a money ticket for 5 days). Only a live pull, over sessions that actually
 * booted and restarted, can grade it.
 *
 * THE REAL-MONEY AXIS — WHY `mode` IS PARTITIONED, NOT POOLED
 * ----------------------------------------------------------
 * On the 2026-07-30T04:19:30Z pull all 18 lag sessions were `mode: demo` across
 * 13 books, and the single `mode: live` book (`admin`) was clean. That is the
 * whole basis for TRA-2630's demo-only / $0-live-capital verdict, and with it
 * the standing decision NOT to roll back TRA-2323.
 *
 * So a live hit is not "one more row" — it is a NAV overstatement of a full
 * session of realized options P&L (~$68-$250/session at current volumes) and a
 * different severity class entirely. It therefore gets its OWN exit code, and
 * is counted separately so a noisy fixture book can never mask it. Pooling the
 * two is the TRA-2193 trap this endpoint has already been bitten by twice; the
 * 13 demo books are also clone fixtures (`ctoverify_*` / `qa_*` seeded from
 * shared values), so their COUNT overstates breadth — roughly 6 independent
 * books. The live/demo split is the axis that carries meaning.
 *
 * FAILS CLOSED
 * ------------
 * An unreachable endpoint, a non-200, unparseable JSON, or a payload with no
 * engines exits BLIND (3) — never 0. A guard that reports green because it could
 * not read anything is worse than no guard: that is exactly the "ABSENCE IS NOT
 * A PASS" failure this endpoint produced when `admin 2026-07-29` wrote a null
 * EOD row and scored `drift 0` (TRA-2637).
 *
 * THE LAG AXIS CANNOT GRADE THE MONEY ON ITS OWN (TRA-2635)
 * ---------------------------------------------------------
 * CEO's TRA-2635 retracts the part of the TRA-2633 grade that closed TRA-2629 on
 * lag evidence alone. The lag signature is a MIS-BUCKET detector: it fires when a
 * credit lands in the wrong leg. It reads perfectly CLEAN when the credit never
 * landed AT ALL, because there is no mis-bucket without a credit. On the live
 * `admin` book that is exactly the state: 0 lag rows while its options leg had
 * earned +$987.60. Two mutually exclusive readings fit those rows equally well —
 *
 *   1. the credit path IS writing to `PaperAccount` and `stockDaily` correctly
 *      excludes it (admin genuinely clean), or
 *   2. the credit path has NEVER FIRED on the live book, so its equity has never
 *      received a cent of that +987.60 (admin is the BROKEN one).
 *
 * No delta on the row separates those. `stockDaily` / `optionsDaily` /
 * `priorOptionsLagDates` are identical under both. So this script now grades a
 * SECOND, independent axis off durable STATE (`closingEquity`,
 * `optionsCreditedCumulative`), and a CLEAN lag verdict no longer licenses a pass
 * on its own.
 *
 * EXIT CODES
 * ----------
 *   0  CLEAN     — no book shows the lag AND the live book's equity is confirmed
 *                  to have absorbed realized option P&L. Requires at least one
 *                  `mode: live` book to have been graded on BOTH axes.
 *   1  LIVE LAG  — a `mode: live` book shows it. ESCALATE. Stop netting the
 *                  credit path and re-open the TRA-2323 rollback question.
 *   2  DEMO LAG  — demo books only, live cohort NON-EMPTY and clean. Real,
 *                  $0 live capital at risk.
 *   3  BLIND     — could not grade. Never conflated with a pass. Includes the
 *                  EMPTY LIVE COHORT case: with 0 `mode: live` books the
 *                  real-money tripwire looked at nothing, so "0 live books
 *                  affected" is an absence, not a clean bill of health. Also
 *                  covers a build that serves no `optionsCreditedCumulative`
 *                  (predates TRA-2635) and a live book that realized no option
 *                  P&L to absorb.
 *   4  LIVE CREDIT UNSHIPPED — a `mode: live` book realized option P&L and its
 *                  equity absorbed NONE of it. ESCALATE: TRA-2323 scope item 1
 *                  is unshipped on real capital, and every sizing decision on
 *                  that book is being made off an understated NAV.
 *   6  LIVE COHORT RECLASSIFIED (TRA-2761) — open `mode:'live'` journal rows
 *                  exist whose holder is no longer classified `mode: live` (or
 *                  that no current book claims). The live cohort emptied out
 *                  from under open real-money notional; every live axis above
 *                  reads NOT MEASURED while the money is unobserved. Outranks
 *                  the BLIND it would otherwise land on.
 *
 * THE COHORT IS PINNED, NOT LEARNED AT READ TIME (TRA-2630 AC2)
 * -------------------------------------------------------------
 * The AC2 delta reports `N book(s) that COULD have shown one`. N is discovered
 * from the same payload it grades, so a book that was eligible and then produced
 * no row does not fail anything — it shrinks N, and the verdict still prints
 * PASS. `AC2_EXPECTED_GRADEABLE_BOOKS` therefore fixes the 15 books eligible for
 * the 2026-07-30 read off the already-written, immutable 2026-07-29 rows, pulled
 * BEFORE the graded session existed. Every arm prints observed-vs-pinned and
 * names any book that dropped out. It is deliberately NOT wired to the exit code:
 * thin evidence is a reading to widen, not a build to fail — but it is never
 * silent, because silence is the defect. The pin refuses to apply to any other
 * `--since` rather than decay into the shrinkage it detects.
 *
 * USAGE
 * -----
 *   node scripts/check-pnl-options-lag.mjs
 *   node scripts/check-pnl-options-lag.mjs --url=https://host/api/health/pnl-reconciliation
 *   node scripts/check-pnl-options-lag.mjs --file=./recon.json   # grade a saved pull
 *   node scripts/check-pnl-options-lag.mjs --since=YYYY-MM-DD    # move the AC2 delta boundary
 *   node scripts/check-pnl-options-lag.mjs --no-writer-check     # skip writer attribution
 *   node scripts/check-pnl-options-lag.mjs --selftest            # both-direction controls
 *
 * `--no-writer-check` suppresses the Render/git calls in {@link gradeWriterProvenance}
 * and reports `writer: NOT CHECKED`. It does NOT make the grade cleaner — a PASS
 * under it is unattributed to the writer, which is what that line says.
 *
 * THE VERDICT IS THE PRINTED TEXT, NOT THE EXIT CODE
 * --------------------------------------------------
 * Five axes are reported and only the lag/credit pair reaches `process.exit`. The
 * AC2 delta, the cohort pin, the top-level disclaimer and the writer attribution
 * are print-only by design (each one's reason is on its own doc block), so a
 * grader must read stdout. Every arm prints its verdict BEFORE any early return.
 */

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This script's own repo, so the ancestry probe reads the checkout it shipped in. */
const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_URL = 'https://tradingai-bqb1.onrender.com/api/health/pnl-reconciliation';
/** Same penny tolerance the reconciler uses — "to the cent" is the signature. */
const TOLERANCE_USD = 0.01;

const EXIT_CLEAN = 0;
const EXIT_LIVE_LAG = 1;
const EXIT_DEMO_LAG = 2;
const EXIT_BLIND = 3;
/** TRA-2635 — a live book realized option P&L and equity absorbed none of it. */
const EXIT_LIVE_CREDIT_UNSHIPPED = 4;
/**
 * TRA-2630 AC3 — a live book's counter is FROZEN: the credit reached NAV but no
 * daily row records it. Distinct from exit 4, where the money never arrived.
 */
const EXIT_LIVE_COUNTER_FROZEN = 5;
/**
 * TRA-2761 — open `mode:'live'` journal rows exist whose account the read-time
 * classifier no longer resolves as `mode: live` (or that no current book claims
 * at all). The live cohort emptied OUT FROM UNDER open real-money notional, so
 * every `live*` verdict above reads NOT MEASURED while the money is unobserved.
 * Distinct from EXIT_BLIND: BLIND is "nothing to grade", this is "there is
 * something to grade and the observer was reclassified away from it".
 */
const EXIT_LIVE_COHORT_RECLASSIFIED = 6;

/**
 * THE PREDICATE. Returns the lag dates for one book's day list.
 *
 * `days` must be ascending by date. Two terms, both load-bearing:
 *
 *  - exact equality within a cent — the production signature is an exact credit
 *    re-book, so a near-miss is honest trading and must read clean;
 *  - `stockDaily` itself non-zero — without it every quiet day (`stockDaily 0`
 *    after `optionsDaily 0`) satisfies "equal to the cent" and the check fires
 *    on 127 of the 167 clean sessions in the live pull. A predicate that is true
 *    in the passing state has no failing state and measures nothing (the
 *    TRA-2301 / TRA-2642 lesson).
 */
export function findPriorOptionsLagDates(days) {
  const sorted = [...days].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const hits = [];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = sorted[i - 1];
    const sd = Number(cur?.stockDaily);
    const priorOd = Number(prev?.optionsDaily);
    if (!Number.isFinite(sd) || !Number.isFinite(priorOd)) continue;
    if (Math.abs(sd) <= TOLERANCE_USD) continue;
    if (Math.abs(sd - priorOd) <= TOLERANCE_USD) {
      hits.push({ date: cur.date, stockDaily: sd, priorDate: prev.date, priorOptionsDaily: priorOd });
    }
  }
  return hits;
}

/**
 * TRA-2630 AC2 — THE DENOMINATOR for {@link findPriorOptionsLagDates}. Returns
 * the dates on which that predicate COULD have fired for one book.
 *
 * A session is gradeable iff its PRIOR session carried a non-zero `optionsDaily`.
 * The lag hypothesis names one exact value for `stockDaily` in that case, so any
 * other observation — `0.00` included — refutes it. When the prior is `0.00` the
 * hypothesis predicts `stockDaily == 0.00`, indistinguishable from a quiet day:
 * no failing state, therefore no evidence either way.
 *
 * This is the denominator the script was missing. `0 hits` over 0 gradeable
 * sessions and `0 hits` over 40 gradeable sessions were the same output, which is
 * the identical confusion `liveBookCount` was added to resolve one level out.
 * Measured on bqb1 2026-07-30T08:02Z: 7 of the 13 books CURRENTLY carrying a lag
 * date have a zero prior on their latest session, so they cannot verify the fix
 * on the next session whatever it writes.
 */
export function findPriorOptionsLagGradeableDates(days) {
  const sorted = [...days].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const gradeable = [];
  for (let i = 1; i < sorted.length; i++) {
    const priorOd = Number(sorted[i - 1]?.optionsDaily);
    if (!Number.isFinite(priorOd)) continue;
    if (Math.abs(priorOd) > TOLERANCE_USD) gradeable.push(sorted[i].date);
  }
  return gradeable;
}

/**
 * TRA-2630 AC2 — the first session date written UNDER the deployed Defect-B fix.
 *
 * TRA-2629 shipped in `ec05639`, deployed to bqb1 2026-07-30T04:36:04Z. Every EOD
 * row before that was written by the broken writer, so the 18 historical lag
 * sessions on 13 demo books CANNOT clear and are NOT a regression. AC2 is a
 * DELTA — "no NEW lag session dated on/after this date" — and grading it as an
 * absolute reports a red on a fix that works.
 */
export const AC2_FIX_DEPLOY_DATE = '2026-07-30';

/**
 * TRA-2630 AC2 — THE COHORT, PINNED BEFORE THE OBSERVATION.
 *
 * `gradeableBookCount` is a denominator the grader learns AT READ TIME, which
 * means it can only ever report the cohort that showed up. A book that was
 * eligible and then silently failed to produce a row shrinks the denominator
 * instead of failing anything, and the verdict still prints `PASS — 0 new lag
 * sessions across N book(s) that COULD have shown one`. N just gets smaller.
 * That is the same manufactured green the BLIND arm exists to stop, one notch
 * in: not "nobody looked" but "fewer looked than we knew were eligible", and it
 * is invisible from the read alone because nothing records what N should be.
 *
 * So the expected cohort is pinned HERE, measured off live prod BEFORE the
 * session it grades exists. Eligibility for the 2026-07-30 read is fixed by the
 * 2026-07-29 rows, which were already written and immutable when this was
 * measured — every book below carries a non-zero `optionsDaily` on 07-29, so
 * each one names an exact `stockDaily` that the 07-30 row can refute.
 *
 *   source: GET https://tradingai-bqb1.onrender.com/api/health/pnl-reconciliation
 *   pulled: 2026-07-30T11:11:29Z, live SHA 6153420, 59 engine books / 47 with rows
 *
 * The pin is keyed to ONE read and does NOT decay silently: {@link compareAc2Cohort}
 * refuses to compare unless `since` is exactly {@link AC2_FIX_DEPLOY_DATE}, because
 * on any later date eligibility is fixed by a different prior session and this list
 * is simply the wrong question. A pin that quietly kept applying would manufacture
 * the shrinkage it exists to detect.
 */
export const AC2_EXPECTED_GRADEABLE_BOOKS = Object.freeze([
  { username: 'admin', mode: 'live', priorOptionsDaily: 250.01 },
  { username: 'Richard', mode: 'demo', priorOptionsDaily: -5.11 },
  { username: 'ctoverify_2225_1784856407', mode: 'demo', priorOptionsDaily: 73.05 },
  { username: 'ctoverify_2225b_1784856491', mode: 'demo', priorOptionsDaily: 42 },
  { username: 'ctoverify_qa2407v1785284396', mode: 'demo', priorOptionsDaily: 42 },
  { username: 'ctoverify_tra2227', mode: 'demo', priorOptionsDaily: -61 },
  { username: 'ctoverify_tra2284', mode: 'demo', priorOptionsDaily: 12 },
  { username: 'ctoverify_tra2331b', mode: 'demo', priorOptionsDaily: 10 },
  { username: 'ctoverify_tra2333', mode: 'demo', priorOptionsDaily: 73.05 },
  { username: 'enock', mode: 'demo', priorOptionsDaily: -4 },
  { username: 'qa_mirror_1578_38096', mode: 'demo', priorOptionsDaily: -39 },
  { username: 'qa_reg_0710202220', mode: 'demo', priorOptionsDaily: -7.5 },
  { username: 'qa_tra1475_1783821169', mode: 'demo', priorOptionsDaily: -342 },
  { username: 'qa_tra2251_7b0483ee', mode: 'demo', priorOptionsDaily: 73.05 },
  { username: 'qa_tra2282_5beed8b8', mode: 'demo', priorOptionsDaily: 36.16 },
]);

/**
 * TRA-2630 AC2 — grade the OBSERVED cohort against the PINNED one.
 *
 * Three states, and the middle one is the whole point:
 *
 *  - `NOT_APPLICABLE` — `since` is not the pinned read date. Says so; compares nothing.
 *  - `SHRANK`         — an expected book produced no gradeable post-fix session. The
 *                       pass, if any, covers less ground than it claims and names which.
 *  - `INTACT`         — every pinned book presented. `extra` books are reported but are
 *                       NOT a defect: a book that was quiet on 07-29 and traded on 07-30
 *                       legitimately joins the cohort.
 *
 * Deliberately NOT wired to the exit code. A shrunken cohort does not mean the fix
 * regressed — it means the evidence is thinner than planned, which is a reading to
 * widen, not a build to fail. Silence is the failure mode being fixed, so it prints
 * loudly on every arm including BLIND.
 */
export function compareAc2Cohort(gradeableBooks, since) {
  if (String(since) !== AC2_FIX_DEPLOY_DATE) {
    return {
      verdict: 'NOT_APPLICABLE',
      reason:
        `the pinned cohort fixes eligibility from the 2026-07-29 rows and grades the`
        + ` ${AC2_FIX_DEPLOY_DATE} read only; --since=${since} asks a different question`,
      expectedCount: AC2_EXPECTED_GRADEABLE_BOOKS.length,
      observedCount: gradeableBooks.length,
      missing: [],
      extra: [],
    };
  }
  const observed = new Set(gradeableBooks.map((b) => b.username));
  const expected = new Set(AC2_EXPECTED_GRADEABLE_BOOKS.map((b) => b.username));
  const missing = AC2_EXPECTED_GRADEABLE_BOOKS.filter((b) => !observed.has(b.username));
  const extra = gradeableBooks.filter((b) => !expected.has(b.username));
  return {
    verdict: missing.length > 0 ? 'SHRANK' : 'INTACT',
    reason: null,
    expectedCount: AC2_EXPECTED_GRADEABLE_BOOKS.length,
    observedCount: gradeableBooks.length,
    missing,
    extra,
  };
}

/**
 * TRA-2630 AC2 — THE DELTA, WITH ITS OWN DENOMINATOR.
 *
 * Splits lag hits into the pre-fix baseline and sessions written under the fix,
 * and — this is the load-bearing half — counts how many books could have
 * produced a post-fix hit at all. Three states, not two:
 *
 *  - PASS  — at least one book carries a gradeable post-fix session, none lagged;
 *  - FAIL  — a post-fix session lagged;
 *  - BLIND — NO book carries a gradeable post-fix session, so "0 new lag" is the
 *            absence of a measurement, not a pass.
 *
 * The BLIND arm is the one that matters on a scheduled read. This guard's grader
 * fires at 21:30 ET, 30 minutes after the 21:00 ET EOD writer. If that writer is
 * late, skipped, or the row is absent for any other reason, every book reports
 * zero new lag sessions and a two-state verdict calls that a green — the exact
 * shape of TRA-2637, where an ABSENT EOD row scored `drift: 0`.
 *
 * "Gradeable" carries the same meaning as {@link findPriorOptionsLagGradeableDates}:
 * the session's PRIOR row must carry a non-zero `optionsDaily`, because only then
 * does the lag hypothesis name one exact `stockDaily` that an observation can
 * refute. A post-fix session whose prior was `0.00` reads clean either way, so it
 * is not evidence — 7 of the 13 currently-lagging books are in exactly that state.
 */
export function gradeAc2Delta(engines, since) {
  const cutoff = String(since);
  let rowBookCount = 0;
  const newLag = [];
  const newFrozen = [];
  // Named, not just counted — a bare count cannot be checked against the pinned
  // cohort, and "N books could have shown one" is exactly the claim that silently
  // gets smaller when a book drops out (see AC2_EXPECTED_GRADEABLE_BOOKS).
  const gradeableBooks = [];
  for (const e of engines) {
    const days = Array.isArray(e?.days) ? e.days : [];
    const sorted = [...days].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (sorted.some((d) => String(d.date) >= cutoff)) rowBookCount++;
    // The denominator: a post-fix session whose PRIOR carried non-zero optionsDaily.
    const gradeableDates = findPriorOptionsLagGradeableDates(sorted).filter((d) => String(d) >= cutoff);
    if (gradeableDates.length > 0) {
      gradeableBooks.push({
        username: e.username ?? '(unnamed)',
        mode: e.mode ?? '(unknown)',
        dates: gradeableDates,
      });
    }
    const hits = findPriorOptionsLagDates(sorted).filter((h) => String(h.date) >= cutoff);
    if (hits.length > 0) {
      newLag.push({ username: e.username ?? '(unnamed)', mode: e.mode ?? '(unknown)', hits });
    }
    // TRA-2658 — the FROZEN axis, gated on the SAME delta boundary and for exactly
    // the same reason the lag axis is. `counterFrozenDates` is an absolute over the
    // book's whole history, and admin's 07-28/07-29 rows were both written before
    // `ec05639` landed (2026-07-30T04:10:50Z), so an absolute `counterDurable ===
    // true` can NEVER go green on that book no matter what ships. A permanently-red
    // gate is exactly as uninformative as the permanently-green one this ticket was
    // filed about — the pre-fix rows are the baseline and do not clear
    // retroactively. Wired here rather than as a separate arm so a single `--since`
    // moves both axes together and they can never disagree about the boundary.
    const frozenHits = frozenSessionsForBook(sorted).filter((h) => String(h.date) >= cutoff);
    if (frozenHits.length > 0) {
      newFrozen.push({
        username: e.username ?? '(unnamed)',
        mode: e.mode ?? '(unknown)',
        hits: frozenHits,
      });
    }
  }
  const gradeableBookCount = gradeableBooks.length;
  const rows = newLag.reduce((n, r) => n + r.hits.length, 0);
  const liveRows = newLag.filter((r) => r.mode === 'live').reduce((n, r) => n + r.hits.length, 0);
  const frozenRows = newFrozen.reduce((n, r) => n + r.hits.length, 0);
  const liveFrozenRows = newFrozen
    .filter((r) => r.mode === 'live')
    .reduce((n, r) => n + r.hits.length, 0);
  // A NEW frozen session is a FAIL on the same footing as a new lag session: both
  // mean the post-fix writer produced a row whose credit accounting is broken.
  const verdict =
    rows > 0 || frozenRows > 0 ? 'FAIL' : gradeableBookCount === 0 ? 'BLIND' : 'PASS';
  return {
    since: cutoff,
    verdict,
    rows,
    liveRows,
    frozenRows,
    liveFrozenRows,
    frozenBooks: newFrozen,
    books: newLag,
    gradeableBookCount,
    gradeableBooks,
    rowBookCount,
    cohort: compareAc2Cohort(gradeableBooks, cutoff),
  };
}

/**
 * TRA-2658 — the frozen-counter sessions for ONE book's day list, ascending.
 *
 * Extracted so the delta grade and {@link gradeCreditObservation} apply the SAME
 * predicate. Two copies of an attribution this fiddly is the TRA-2210 "filter at
 * SOME call sites" shape, and a per-axis disagreement would be invisible: the
 * credit axis would escalate a book the delta axis passed.
 *
 * See {@link gradeCreditObservation} for the pool arithmetic and why both weaker
 * predicates that preceded it failed a control.
 */
/**
 * TRA-2658 — every material un-booked equity move, INCLUDING the ones no lost
 * credit can explain. Reported without an accusation so a starting-balance edit
 * (`PaperAccount.applyEquity`) stays visible rather than being either silently
 * dropped or wrongly folded into a durability verdict. On the live `admin` book
 * this is 14 pre-baseline rebases up to $24,000 — none of them counter defects.
 */
export function unbookedMovesForBook(days) {
  const out = [];
  for (let i = 1; i < days.length; i++) {
    const cur = days[i];
    const prev = days[i - 1];
    if (!Number.isFinite(Number(cur?.closingEquity))) continue;
    if (!Number.isFinite(Number(prev?.closingEquity))) continue;
    const curCredit = Number(cur?.optionsCreditedCumulative);
    const prevCredit = Number(prev?.optionsCreditedCumulative);
    const creditWindow =
      Number.isFinite(curCredit) && Number.isFinite(prevCredit) ? curCredit - prevCredit : 0;
    const stockDaily = Number.isFinite(Number(cur?.stockDaily)) ? Number(cur.stockDaily) : 0;
    const move =
      Math.round(
        ((Number(cur.closingEquity) - Number(prev.closingEquity)) - stockDaily - creditWindow) * 100,
      ) / 100;
    if (Math.abs(move) > TOLERANCE_USD) out.push({ date: cur.date, move });
  }
  return out;
}

export function frozenSessionsForBook(days) {
  const out = [];
  let pool = 0;
  for (let i = 0; i < days.length; i++) {
    const cur = days[i];
    if (!cur?.belowBaseline) pool += Math.abs(Number(cur?.optionsDaily) || 0);
    if (i === 0) continue;
    const prev = days[i - 1];
    if (!Number.isFinite(Number(cur?.closingEquity))) continue;
    if (!Number.isFinite(Number(prev?.closingEquity))) continue;
    const curCredit = Number(cur?.optionsCreditedCumulative);
    const prevCredit = Number(prev?.optionsCreditedCumulative);
    const creditWindow =
      Number.isFinite(curCredit) && Number.isFinite(prevCredit) ? curCredit - prevCredit : 0;
    const stockDaily = Number.isFinite(Number(cur?.stockDaily)) ? Number(cur.stockDaily) : 0;
    const move =
      Math.round(
        ((Number(cur.closingEquity) - Number(prev.closingEquity)) - stockDaily - creditWindow) * 100,
      ) / 100;
    pool -= Math.abs(creditWindow);
    if (Math.abs(move) <= TOLERANCE_USD) continue;
    if (Math.abs(creditWindow) > TOLERANCE_USD) continue;
    if (Math.abs(move) > pool + TOLERANCE_USD) continue;
    out.push({ date: cur.date, move });
    pool -= Math.abs(move);
  }
  return out;
}

/**
 * TRA-2630 AC2 — the commit whose PRESENCE IN THE WRITER is what a PASS claims.
 *
 * `ec05639` is the TRA-2629 durability fix. AC2's whole assertion is "the row
 * written under the deployed fix carries no lag", so the commit has to have been
 * in the build that WROTE the row — not merely in the build that happens to be
 * serving when the grader reads it.
 */
export const AC2_WRITER_FIX_COMMIT = 'ec05639';

/**
 * TRA-2630 AC2 — WHICH BUILD WROTE THE ROW BEING GRADED.
 *
 * The hole this closes. `gradeAc2Delta` grades the VALUE in the 07-30 row; the
 * only provenance the instrument had was `/api/health/version`, and that is a
 * POINT-IN-TIME read taken ~30 minutes AFTER the write. It cannot see what was
 * serving during the write window, so it cannot tell these two apart:
 *
 *   1. the fixed writer wrote a clean row  -> PASS means the fix works;
 *   2. a rollback was serving at 21:00 ET, the broken writer wrote the row, and a
 *      descendant build was redeployed before 21:30 -> the same PASS text, over a
 *      row the fix never touched.
 *
 * That is not a hypothetical on this service. bqb1 took EIGHT deploys between
 * 08:33Z and 12:10Z on 2026-07-30 alone (~1 per 30 min), and a redeploy pinned to
 * a stale `--commit=` is a known event class here — it silently discards every
 * commit main has taken since the pin. So the build serving at 01:00Z tomorrow is
 * genuinely unknown today, and a one-shot grade that cannot name its own writer is
 * exactly the "grade the WRITER, not the value" failure.
 *
 * A build serves from its own `finishedAt` until the next SERVED deploy finishes.
 * Deploys that never served (`build_failed`, `canceled`, `pre_deploy_failed`) are
 * dropped: they occupy a timestamp but no traffic. `live` and `deactivated` both
 * served — `deactivated` only means something later replaced it.
 *
 * Returns the builds whose serving interval INTERSECTS [startIso, endIso),
 * ascending. Intersection, not point sampling: if a rollback served for ten
 * minutes across the writer's window that is the build under suspicion even though
 * neither endpoint of the window lands inside it.
 */
export function buildsServingDuring(deploys, startIso, endIso) {
  const served = (Array.isArray(deploys) ? deploys : [])
    .map((d) => (d?.deploy && typeof d.deploy === 'object' ? d.deploy : d))
    .filter((d) => d?.finishedAt && (d?.commit?.id || d?.sha))
    .filter((d) => d?.status === 'live' || d?.status === 'deactivated')
    .map((d) => ({
      id: d.id ?? null,
      sha: String(d.commit?.id ?? d.sha),
      finishedAt: String(d.finishedAt),
      status: d.status,
    }))
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  const start = String(startIso);
  const end = String(endIso);
  const hits = [];
  for (let i = 0; i < served.length; i++) {
    const from = served[i].finishedAt;
    // The newest served build has no successor, so it is still serving: open-ended.
    const until = i + 1 < served.length ? served[i + 1].finishedAt : null;
    const startsBeforeEnd = from < end;
    const endsAfterStart = until === null || until > start;
    if (startsBeforeEnd && endsAfterStart) hits.push({ ...served[i], servedUntil: until });
  }
  return { serving: hits, earliestRecordAt: served.length > 0 ? served[0].finishedAt : null };
}

/**
 * TRA-2630 AC2 — the EOD write instant for a graded session date.
 *
 * The writer runs at 21:00 ET. Expressed with an explicit `-04:00` (EDT) rather
 * than a timezone library, and the DST question is answered by the WINDOW rather
 * than by getting the offset exactly right: a whole hour of error still lands
 * inside the lookback below, and anything ambiguous resolves to NOT MEASURED
 * instead of to a guess.
 */
export function eodWriteInstant(gradedDate) {
  return new Date(`${gradedDate}T21:00:00-04:00`).toISOString();
}

/**
 * TRA-2630 AC2 — GRADE THE WRITER. Pure: every input is injected, so `--selftest`
 * drives both directions without touching the network or a git checkout.
 *
 * The window is ASYMMETRIC on purpose. Builds deployed AFTER the row was written
 * cannot have written it, so a post-write rollback must not invalidate an honest
 * PASS — that would hand the fleet's deploy cadence a veto over this gate and make
 * it unreachable, which is its own defect class. The lookback absorbs DST error
 * and an early writer; the short forward margin absorbs a writer delayed by a
 * restart.
 *
 * Four verdicts, and the two middle ones are the point:
 *
 *   CONFIRMED       — every build serving the write window descends from
 *                     {@link AC2_WRITER_FIX_COMMIT}. A PASS here means the fix.
 *   PRE_FIX_WRITER  — a build serving that window provably does NOT. The row was
 *                     written by the broken writer, so NEITHER a pass nor a fail
 *                     is attributable to the fix. This is the one arm wired to
 *                     downgrade the AC2 verdict.
 *   NOT_YET_WRITTEN — the graded session's EOD row is not due yet. A pre-check run
 *                     must not report the build serving TODAY as the writer of a
 *                     row due tomorrow.
 *   UNATTRIBUTABLE  — no deploy history, history that does not reach back to the
 *                     window, or ancestry that could not be resolved (no git
 *                     checkout, shallow clone, missing object). NOT a pass and NOT
 *                     a red. Deliberately NOT wired: on a non-git harness checkout
 *                     this is the normal reading, and failing on it would make the
 *                     guard unrunnable exactly where it runs (the AC2 grader's
 *                     workspace was not a git repository on 2026-07-30T11:3xZ).
 *   NOT_APPLICABLE  — nothing was graded, so there is no writer to attribute.
 *
 * `isDescendant(sha)` must return `true` / `false` / `null`, where `null` means
 * "could not determine" — never a boolean guess, because a false negative here
 * accuses a working fix of never having shipped.
 */
export function gradeWriterProvenance({
  deploys,
  isDescendant,
  gradedDate,
  liveCommit = null,
  now = new Date().toISOString(),
  lookbackMinutes = 60,
  forwardMinutes = 45,
} = {}) {
  if (!gradedDate) {
    return {
      verdict: 'NOT_APPLICABLE',
      reason: 'no graded session date — there is no row, so there is no writer to attribute',
      gradedDate: null, writeInstant: null, windowStart: null, windowEnd: null,
      serving: [], liveCommit, fixCommit: AC2_WRITER_FIX_COMMIT,
    };
  }
  const writeInstant = eodWriteInstant(gradedDate);
  const t = new Date(writeInstant).getTime();
  const windowStart = new Date(t - lookbackMinutes * 60_000).toISOString();
  const windowEnd = new Date(t + forwardMinutes * 60_000).toISOString();
  const base = {
    gradedDate: String(gradedDate), writeInstant, windowStart, windowEnd,
    liveCommit, fixCommit: AC2_WRITER_FIX_COMMIT,
  };
  // A WRITE THAT HAS NOT HAPPENED CANNOT BE ATTRIBUTED. The newest served build is
  // open-ended by construction ("still serving"), so it intersects any future
  // window and a pre-check run would print CONFIRMED about a row nobody has written
  // — a prediction wearing a verdict's clothes. On this service that prediction is
  // worth little: 8 deploys landed in the 3.5h before this arm was written, so the
  // build serving at 21:00 ET is genuinely not knowable in advance.
  if (String(now) < writeInstant) {
    return {
      ...base, verdict: 'NOT_YET_WRITTEN', serving: [],
      reason: `the ${gradedDate} EOD row is written at ${writeInstant}, which is still in the`
        + ` future at ${now} — the build currently serving is a forecast, not the writer`,
    };
  }
  if (deploys == null) {
    return {
      ...base, verdict: 'UNATTRIBUTABLE', serving: [],
      reason: 'no Render deploy history (RENDER_API_KEY / RENDER_SERVICE_ID absent, or the'
        + ' API call failed) — the build serving the write window cannot be named',
    };
  }
  const { serving, earliestRecordAt } = buildsServingDuring(deploys, windowStart, windowEnd);
  if (serving.length === 0) {
    return {
      ...base, verdict: 'UNATTRIBUTABLE', serving: [],
      reason: earliestRecordAt == null
        ? 'the deploy history carried no build that ever served'
        : `the deploy history only reaches back to ${earliestRecordAt}, after the write`
          + ` window opened at ${windowStart} — page further back before grading`,
    };
  }
  // INTERSECTING THE WINDOW IS NOT ENOUGH — the history has to name the build that
  // was serving at the WRITE INSTANT itself. A page that begins 40 minutes after
  // 21:00 ET intersects the forward margin while omitting the actual writer, and
  // the arm above cannot see that because it only tests for emptiness. Caught by
  // its own control; a build serving the margin was being reported as CONFIRMED
  // for a row it demonstrably did not write.
  const atInstant = buildsServingDuring(deploys, writeInstant, new Date(t + 1).toISOString()).serving;
  if (atInstant.length === 0) {
    return {
      ...base, verdict: 'UNATTRIBUTABLE', serving,
      reason: `no build in the deploy history was serving at the write instant ${writeInstant}`
        + ` (earliest served record ${earliestRecordAt}) — ${serving.length} build(s) touch the`
        + ' margin around it, but none of them wrote the row; page further back before grading',
    };
  }
  const resolved = serving.map((b) => ({ ...b, descendsFromFix: isDescendant ? isDescendant(b.sha) : null }));
  const preFix = resolved.filter((b) => b.descendsFromFix === false);
  const unknown = resolved.filter((b) => b.descendsFromFix == null);
  if (preFix.length > 0) {
    return {
      ...base, verdict: 'PRE_FIX_WRITER', serving: resolved,
      reason: `${preFix.length} build(s) serving the write window do NOT descend from`
        + ` ${AC2_WRITER_FIX_COMMIT}: ${preFix.map((b) => b.sha.slice(0, 9)).join(', ')}`,
    };
  }
  if (unknown.length > 0) {
    return {
      ...base, verdict: 'UNATTRIBUTABLE', serving: resolved,
      reason: `ancestry unresolved for ${unknown.length} of ${resolved.length} serving build(s)`
        + ` (${unknown.map((b) => b.sha.slice(0, 9)).join(', ')}) — no git checkout, a shallow`
        + ` clone, or the fix object is absent locally`,
    };
  }
  return {
    ...base, verdict: 'CONFIRMED', serving: resolved,
    reason: `all ${resolved.length} build(s) serving the write window descend from ${AC2_WRITER_FIX_COMMIT}`,
  };
}

/**
 * TRA-2630 AC2 — apply the writer verdict to the value verdict.
 *
 * ONE arm is wired: a row written by a pre-fix build cannot grade the fix in
 * either direction, so both PASS and FAIL become BLIND and the original verdict is
 * preserved in `downgradedFrom` rather than erased. A FAIL matters here — reported
 * bare it reads "the fix regressed" when the truthful reading is "the fix was not
 * running". Every other writer verdict passes the value verdict through untouched
 * and is reported alongside it; UNATTRIBUTABLE must not veto a grade, or the
 * guard's normal (non-git) reading would permanently withhold the AC2 pass.
 */
export function applyWriterProvenanceToAc2(ac2, provenance) {
  if (!ac2) return ac2;
  if (provenance?.verdict !== 'PRE_FIX_WRITER') return { ...ac2, writer: provenance ?? null };
  return { ...ac2, verdict: 'BLIND', downgradedFrom: ac2.verdict, writer: provenance };
}

/** Grade a whole payload. Pure — no I/O, so `--selftest` can drive it. */
export function gradePayload(payload, opts = {}) {
  const engines = Array.isArray(payload?.engines) ? payload.engines : null;
  if (engines == null || engines.length === 0) {
    return { verdict: 'BLIND', reason: 'payload carried no engines[] array', live: [], demo: [] };
  }
  const live = [];
  const demo = [];
  for (const e of engines) {
    const days = Array.isArray(e?.days) ? e.days : [];
    const hits = findPriorOptionsLagDates(days);
    if (hits.length === 0) continue;
    const row = { username: e.username ?? '(unnamed)', mode: e.mode ?? '(unknown)', hits };
    if (e.mode === 'live') live.push(row);
    else demo.push(row);
  }
  // TRA-2630 follow-up — THE COHORT MUST BE NON-EMPTY BEFORE "no live hit" MEANS
  // ANYTHING. `live.length === 0` has two causes that are indistinguishable from
  // the hit list alone: every live book passed, or there was no live book to
  // grade. Only the second one was true on bqb1 at 2026-07-30T05:16Z — 58/58
  // books resolved `mode: demo` after the TRA-713/TRA-1652 boot-arm failed to
  // converge (`bootArmDrift: ['mode']`), having carried `admin` as `mode: live`
  // three hours earlier. Reporting "0 live books" as reassurance in that state is
  // the same manufactured green as scoring an absent EOD row `drift 0` (TRA-2637).
  const liveBookCount = engines.filter((e) => e?.mode === 'live').length;
  // TRA-2630 AC2 — THE SECOND EMPTY COHORT, one level in from the one above.
  // `liveBookCount >= 1` proves a live book was LOOKED AT. It does NOT prove the
  // predicate could have fired on it: a live book whose every session follows a
  // zero-`optionsDaily` prior is graded by a predicate with no failing state, and
  // reporting that as CLEAN is the same manufactured green with a non-empty
  // filter in front of it. So the cohort test is gradeable sessions, not books.
  const liveGradeableBookCount = engines.filter(
    (e) => e?.mode === 'live' && findPriorOptionsLagGradeableDates(Array.isArray(e?.days) ? e.days : []).length > 0,
  ).length;
  const verdict =
    live.length > 0
      ? 'LIVE_LAG'
      : liveBookCount === 0 || liveGradeableBookCount === 0
        ? 'LIVE_UNMEASURABLE'
        : demo.length > 0
          ? 'DEMO_LAG'
          : 'CLEAN';
  return {
    verdict,
    live,
    demo,
    // TRA-2630 AC2 — the delta verdict, reported ALONGSIDE the absolute one above.
    // The absolute verdict stays DEMO_LAG for as long as the 18 pre-fix rows exist,
    // so it can never answer "did the fix work"; this field is what AC2 grades.
    ac2: gradeAc2Delta(engines, opts.since ?? AC2_FIX_DEPLOY_DATE),
    engineCount: engines.length,
    liveBookCount,
    liveGradeableBookCount,
    // Named so the BLIND message can say WHICH of the two empty cohorts fired;
    // they need different fixes (boot-arm convergence vs. wait for a real close).
    unmeasurableReason:
      live.length > 0
        ? null
        : liveBookCount === 0
          ? 'no book resolved mode:live'
          : liveGradeableBookCount === 0
            ? 'live book(s) present but no session follows a non-zero optionsDaily'
            : null,
  };
}

/**
 * TRA-2635 — THE SECOND AXIS: did realized option P&L actually reach the live
 * book's EQUITY? Pure, so `--selftest` and `--file=` can drive it.
 *
 * Graded off durable STATE, not a delta. `optionsCreditedCumulative` is
 * `PaperAccount.getOptionsCredited()` as the 21:00 ET writer saw it, and the
 * ONLY reading that answers the question is whether it ever moved off zero on a
 * session where option P&L was realized.
 *
 * THREE separate NOT-MEASURED states, all of which a boolean would render green:
 *
 *   NO_LIVE_BOOK  — the cohort is empty (bqb1 serves this intermittently on a
 *                   boot-arm miss; see the LIVE_UNMEASURABLE note above).
 *   FIELD_ABSENT  — the build predates TRA-2635 and serves no such field.
 *                   Counting `undefined` as "0 credited" would ACCUSE a working
 *                   bridge; counting it as "graded" would clear a broken one.
 *   UNMEASURABLE  — the live book realized no option P&L, so there was nothing
 *                   for equity to absorb and nothing to conclude.
 *
 * The gradeable cohort is derived from the TRIGGER (`optionsDaily` non-zero AND
 * the counter written), never from the fleet: a book that never traded an option
 * cannot verify the bridge, and 7 of the 13 lag books on 2026-07-29 had a zero
 * prior and could never have verified the fix no matter what shipped.
 */
export function gradeCreditObservation(payload) {
  const engines = Array.isArray(payload?.engines) ? payload.engines : [];
  const liveEngines = engines.filter((e) => e?.mode === 'live');
  let fieldPresentRows = 0;
  const books = liveEngines.map((e) => {
    const days = [...(e?.days ?? [])].sort((a, b) =>
      String(a?.date).localeCompare(String(b?.date)),
    );
    const written = days.filter(
      (d) =>
        d?.optionsCreditedCumulative !== undefined
        && d?.optionsCreditedCumulative !== null
        && Number.isFinite(Number(d.optionsCreditedCumulative)),
    );
    fieldPresentRows += written.length;
    // Baseline-gated exactly like the endpoint: the bridge did not exist before
    // the baseline, so a pre-fix row carrying no credit is correct behaviour.
    const gradeable = written.filter(
      (d) => !d?.belowBaseline && Math.abs(Number(d?.optionsDaily)) > TOLERANCE_USD,
    );
    // TRA-2635 SECOND PASS — A ZERO COUNTER IS NOT EVIDENCE OF ABSENCE unless the
    // counter is DURABLE, and on the live fleet it is not. `Richard` wrote 0 on
    // three consecutive sessions while `closingEquity` moved +67.50 then +22.50 —
    // exactly the two prior sessions' `optionsDaily`. The money arrived; the
    // counter did not survive the boot. Two row-level signatures prove the reset,
    // and either forces NOT MEASURED rather than a manufactured red:
    //   - a `lagsPriorOptionsDaily` session (the TRA-2629 signature — and its
    //     presence PROVES a credit reached equity);
    //   - a negative credit window (a cumulative counter cannot decrease).
    const lagDates = findPriorOptionsLagDates(days).map((h) => h.date);
    let negativeWindow = false;
    for (let i = 1; i < written.length; i++) {
      const delta =
        Number(written[i].optionsCreditedCumulative)
        - Number(written[i - 1].optionsCreditedCumulative);
      if (delta < -TOLERANCE_USD) negativeWindow = true;
    }
    // TRA-2658 — THE THIRD SIGNATURE, and the one both terms above are blind to.
    //
    // `lagDates` and `negativeWindow` are both MOTION detectors. A counter frozen
    // at exactly 0 never decreases, and never pushes a credit into the stock leg
    // either — because `openingEquity` absorbed the credit across a boot before
    // the 21:00 close ran, leaving `stockDaily` as the true stock leg. So the
    // pre-TRA-2658 predicate reported `counterDurable: true` on `admin` while
    // $254.00 of option credit that had demonstrably reached equity was recorded
    // as nothing. Live bqb1 2026-07-30T14:08Z: `counterResetDates: []`,
    // `optionsCreditedCumulative: 0` on 07-27/07-28/07-29, `closingEquity`
    // 2008.29 -> 2147.35 -> 2243.48 against stock legs of -0.94 and -17.87.
    //
    // COMPUTED HERE FROM THE RAW DAY FIELDS, not read off a new endpoint field, on
    // purpose. Deriving it locally is what lets this checker grade a build that
    // predates the endpoint-side fix — `closingEquity`, `stockDaily`,
    // `optionsDaily` and `optionsCreditedCumulative` have all shipped since
    // TRA-2635, so the frozen signature is recoverable from any current pull. A
    // checker that could only see the defect after the fix deployed could never
    // have found it.
    //
    //   unbookedMove = (closingEquity - prevClosingEquity) - stockDaily - creditWindow
    //
    // which is algebraically `openingEquity - prevClosingEquity`, i.e. equity that
    // moved with no daily row explaining it. The `optionsDaily` term is the
    // ATTRIBUTION: a starting-balance edit (`PaperAccount.applyEquity`) is also an
    // un-booked move and is NOT a counter defect, so an un-attributable move is
    // reported without an accusation and never folded into the verdict.
    // THE ATTRIBUTION POOL: realized option P&L that nothing has accounted for.
    //
    //     pool = Σ |optionsDaily| − Σ |recorded credit window| − Σ attributed moves
    //
    // A move is charged to a lost credit only if the pool can pay for it. Two
    // weaker predicates each failed a control on the way here: "option P&L in the
    // ADJACENT sessions" cleared exactly the longest freezes (a week-long freeze
    // delivers several sessions' credit into one window whose neighbours are both
    // quiet), and "≤ cumulative realized" alone accused a $50 starting-balance
    // edit on a book that had realized $1,000 and been fully credited. Subtracting
    // what the counter already recorded closes the second: a fully credited book
    // has an EMPTY pool and cannot produce a frozen-counter claim at all.
    //
    // ONE predicate, shared with the AC2 delta grade — see the note on
    // {@link frozenSessionsForBook}. Two copies of this arithmetic would let the
    // credit axis escalate a book the delta axis passed, invisibly.
    const frozenDates = frozenSessionsForBook(days);
    const unbookedMoveDates = unbookedMovesForBook(days);
    const counterDurable =
      written.length === 0
        ? null
        : lagDates.length === 0 && !negativeWindow && frozenDates.length === 0;
    // Asymmetric on purpose: a counter that MOVED is positive evidence regardless
    // of durability — money that was recorded was recorded.
    const absorbed = gradeable.some((d) => Number(d.optionsCreditedCumulative) !== 0)
      ? true
      : gradeable.length === 0 || counterDurable !== true
        ? null
        : false;
    const realized = days
      .filter((d) => !d?.belowBaseline && Number.isFinite(Number(d?.optionsDaily)))
      .reduce((sum, d) => sum + Number(d.optionsDaily), 0);
    // Reported for context; the SHORTFALL arithmetic below uses the telescoping
    // `spanned` slice instead (see the comment there).
    const latest = written.length > 0 ? written[written.length - 1] : null;
    const equityRows = days.filter((d) => Number.isFinite(Number(d?.closingEquity)));
    const latestEquity = equityRows.length > 0 ? equityRows[equityRows.length - 1] : null;
    // TRA-2635 — THE COUNTER-FREE STATE MEASUREMENT, which is what carries the
    // finding when the boolean is NOT MEASURED. Equity either grew or it did not.
    // UPPER BOUND when `counterDurable === false`: the lagged credit is already
    // inside `stockDaily` there, so that leg double-counts it.
    // THE OPERANDS MUST TELESCOPE. `closingEquity[last] − closingEquity[first]`
    // spans the windows of rows 1..N, so the P&L sums skip row 0 — its session's
    // P&L landed in a delta whose left endpoint is outside the series. Summing
    // 0..N against a 1..N delta fabricates a shortfall equal to row 0's P&L.
    const evaluatedEquity = days.filter(
      (d) => !d?.belowBaseline && Number.isFinite(Number(d?.closingEquity)),
    );
    const equityGrowth =
      evaluatedEquity.length < 2
        ? null
        : Math.round(
          (Number(evaluatedEquity[evaluatedEquity.length - 1].closingEquity)
            - Number(evaluatedEquity[0].closingEquity)) * 100,
        ) / 100;
    const spanned = evaluatedEquity.slice(1);
    const spannedOptions = spanned.reduce(
      (s, d) => s + (Number.isFinite(Number(d?.optionsDaily)) ? Number(d.optionsDaily) : 0),
      0,
    );
    const stockSum = spanned.reduce(
      (s, d) => s + (Number.isFinite(Number(d?.stockDaily)) ? Number(d.stockDaily) : 0),
      0,
    );
    const uncredited =
      equityGrowth === null
        ? null
        : Math.round((spannedOptions + stockSum - equityGrowth) * 100) / 100;
    return {
      username: e.username ?? '(unnamed)',
      absorbed,
      counterDurable,
      counterResetDates: lagDates,
      // TRA-2658 — the ATTRIBUTION for a non-durable counter. A ZEROED counter and
      // a FROZEN one need opposite remediations: a reset has already double-booked
      // the credit into `stockDaily` (so `uncredited` is an upper bound), while a
      // freeze leaves the stock leg exact and the credit present in `closingEquity`
      // but absent from every daily row. Reporting only the boolean loses that.
      counterFrozenDates: frozenDates,
      unbookedMoveDates,
      maxUnbookedMoveUsd: unbookedMoveDates.reduce((m, r) => Math.max(m, Math.abs(r.move)), 0),
      equityGrowth,
      stockSum: Math.round(stockSum * 100) / 100,
      uncredited,
      measuredSessions: gradeable.length,
      writtenSessions: written.length,
      optionsRealizedUsd: Math.round(realized * 100) / 100,
      creditedLatest: latest == null ? null : Number(latest.optionsCreditedCumulative),
      creditedLatestDate: latest?.date ?? null,
      closingEquityLatest: latestEquity == null ? null : Number(latestEquity.closingEquity),
      closingEquityLatestDate: latestEquity?.date ?? null,
    };
  });
  // TRA-2635 — the STATE measurement escalates on its own. It needs no counter, so
  // it is the path that still reports a real-money NAV shortfall when the counter
  // axis is NOT MEASURED. $1.00 materiality floor so penny rounding cannot trip it.
  const SHORTFALL_FLOOR_USD = 1;
  const shortfall = books.filter((b) => b.uncredited != null && b.uncredited > SHORTFALL_FLOOR_USD);
  const verdict =
    liveEngines.length === 0
      ? 'NO_LIVE_BOOK'
      : books.some((b) => b.absorbed === false) || shortfall.length > 0
        ? 'LIVE_CREDIT_UNSHIPPED'
        : fieldPresentRows === 0
          ? 'FIELD_ABSENT'
          : books.some((b) => b.absorbed === true)
            ? 'CREDIT_OK'
            : 'UNMEASURABLE';
  return { verdict, liveBookCount: liveEngines.length, fieldPresentRows, books, shortfall };
}

/**
 * TRA-2630 AC1 — grade the DISCLAIMER, not the metric.
 *
 * AC1's close was "keep `drift` options-only but document it so no future gate
 * mistakes it for a reconciliation error". The prose shipped inside
 * `reconcilePnl`'s result, so on the wire it sat at `engines[i].caveats` while
 * `ok` / `maxDriftUsd` sat at the top. TRA-2624's C5 keyed on the top level. A
 * disclaimer a gate author never scrolls to has not closed anything, so the hoist
 * needs its own guard or the next refactor drops it in silence.
 *
 * Three distinguishable states, and the middle one is the point:
 *
 *   - `PRESENT`     — top-level `driftGradeable: false` AND a top-level `caveats`
 *                     array carrying the decomposition note.
 *   - `PARTIAL`     — one of the two is there. Someone edited the response shape
 *                     and took half the disclaimer with them.
 *   - `ABSENT`      — neither. Either a build predating this fix, or a regression.
 *                     Those two are NOT distinguishable from the payload alone,
 *                     which is why this never touches the exit code — compare
 *                     `/api/health/version` against the fix commit to tell them
 *                     apart.
 *
 * A `driftGradeable: true` is loud on purpose: it is a positive claim that the
 * pooled metric became gradeable, which only a writer change can justify.
 */
function describeGradeabilityDisclaimer(payload) {
  const flag = payload?.driftGradeable;
  const caveats = Array.isArray(payload?.caveats) ? payload.caveats : null;
  const hasNote = caveats != null && caveats.some((c) => typeof c === 'string' && c.includes('TRA-2630'));
  const fields = Array.isArray(payload?.ungradeableFields) ? payload.ungradeableFields : [];
  if (flag === true) {
    return {
      verdict: 'CLAIMS GRADEABLE',
      detail: 'payload asserts `driftGradeable: true` — a pooled lossy/durable metric cannot'
        + ' become gradeable without a writer change. Verify before grading anything off `ok`.',
    };
  }
  if (flag === false && hasNote) {
    return {
      verdict: 'PRESENT',
      detail: `\`driftGradeable: false\` + ${caveats.length} top-level caveat(s); `
        + `ungradeableFields=[${fields.join(', ')}]`,
    };
  }
  if (flag === false || hasNote) {
    return {
      verdict: 'PARTIAL',
      detail: `driftGradeable=${JSON.stringify(flag)}, top-level TRA-2630 caveat=${hasNote}`
        + ' — half the disclaimer is missing from the response head.',
    };
  }
  return {
    verdict: 'ABSENT',
    detail: 'no top-level `driftGradeable` and no top-level `caveats` — the disclaimer for'
      + ' `ok`/`maxDriftUsd` is not where they are read. Pre-fix build, or a regression;'
      + ' check /api/health/version to tell which.',
  };
}

/**
 * Per-leg drift roll-up, reported alongside the tripwire.
 *
 * ONLY `optionsLeg` IS GRADEABLE (TRA-2633). This function used to present both
 * legs as "the gradeable fields that replace `drift`", which is the instruction
 * TRA-2633 retracted from the endpoint caveat in `32dac46` — that commit touched
 * `pnl-reconciliation.ts` only, so the retracted sentence survived HERE, in the
 * tool the AC2 grader is told to run. Fixed in TRA-2630.
 *
 * The stock leg is options-vs-nothing: `eodStockPnl` is the EOD report's
 * `realizedPnl`, summed from `allClosedPositions` — the list the TRA-219 archive
 * clears at the SAME 21:00 ET the report is written. Measured live on 167/167
 * post-baseline rows, `eodStockPnl == 0`, so `stockLegDrift == -stockDaily` and
 * `stockBad` is a restatement of "the equity delta moved". No fix to stock
 * reconciliation can move it, so a red there is NOT a defect signal.
 *
 * Hence `stockMeasurable`: the count of present rows whose report figure is
 * actually non-zero. When it is 0 the stock leg graded NOTHING and the verdict is
 * tri-state `null` = NOT MEASURED, matching the endpoint's own `stockLegOk`.
 *
 * ABSENCE IS NOT A PASS. `present` counts the rows that actually CARRY
 * `stockLegDrift` / `optionsLegDrift`. A build predating TRA-2630 serves neither
 * field, and counting `undefined` as "not over tolerance" would print
 * `0 offending` — a green that measures nothing, which is the exact failure this
 * endpoint already produced when `admin 2026-07-29` wrote a null EOD row and
 * scored `drift 0` (TRA-2637). The caller must check `present` before reading
 * the counts.
 */
function summarizeLegs(payload) {
  const engines = Array.isArray(payload?.engines) ? payload.engines : [];
  let stockBad = 0;
  let optionsBad = 0;
  let maxStock = 0;
  let maxOptions = 0;
  let graded = 0;
  let present = 0;
  let stockMeasurable = 0;
  let optionsMeasurable = 0;
  let optionsSlaved = 0;
  for (const e of engines) {
    for (const d of e?.days ?? []) {
      if (d?.belowBaseline) continue;
      graded++;
      const sl = Number(d?.stockLegDrift);
      const ol = Number(d?.optionsLegDrift);
      const hasLegs =
        d?.stockLegDrift !== undefined && d?.optionsLegDrift !== undefined
        && Number.isFinite(sl) && Number.isFinite(ol);
      if (!hasLegs) continue;
      present++;
      // A zeroed report figure means the archive race ate the operand, not that
      // the leg reconciled. Only a non-zero `eodStockPnl` is evidence either way.
      const esp = Number(d?.eodStockPnl);
      if (Number.isFinite(esp) && esp !== 0) stockMeasurable++;
      // TRA-2641 — the options leg is only INDEPENDENT evidence where the report
      // file's leg was not written FROM the day cell. `syncEodReportOptionsLegs`
      // overwrites it on every `journal`/`journal-repair` row, so on those
      // `optionsLegDrift` is 0 by construction: one source vs a copy of itself.
      // Recomputed here rather than trusting the endpoint's own count, because
      // this guard exists to disagree with the endpoint when one of them is wrong.
      const slaved = d?.optionsDailyPnlSource === 'journal'
        || d?.optionsDailyPnlSource === 'journal-repair';
      const eop = Number(d?.eodOptionsPnl);
      const od = Number(d?.optionsDaily);
      if (slaved) {
        optionsSlaved++;
      } else if (d?.eodOptionsPnl != null && Number.isFinite(eop) && (eop !== 0 || od !== 0)) {
        // 0.00 vs 0.00 is the same vacuous pass that made `stockLegOk` dead.
        optionsMeasurable++;
      }
      if (Math.abs(sl) > TOLERANCE_USD) {
        stockBad++;
        maxStock = Math.max(maxStock, Math.abs(sl));
      }
      if (Math.abs(ol) > TOLERANCE_USD) {
        optionsBad++;
        maxOptions = Math.max(maxOptions, Math.abs(ol));
      }
    }
  }
  // Tri-state, deliberately NOT a boolean: `null` = NOT MEASURED. Treating that
  // null as a pass is the bug TRA-2633 exists to stop.
  const stockLegOk = present === 0 || stockMeasurable === 0
    ? null
    : stockBad === 0;
  // TRA-2641 — tri-state, and RED outranks NOT MEASURED. A slaved row that still
  // disagrees means the sync writer failed; that red must never be masked by the
  // empty-denominator null.
  const optionsLegOk = optionsBad > 0
    ? false
    : present === 0 || optionsMeasurable === 0
      ? null
      : true;
  return {
    graded, present, stockBad, optionsBad, maxStock, maxOptions,
    stockMeasurable, stockLegOk,
    optionsMeasurable, optionsSlaved, optionsLegOk,
  };
}

/**
 * TRA-2630 AC2 — the SESSION DATE the AC2 verdict actually rests on: the newest
 * gradeable post-cutoff session any book presented. That is the row whose writer
 * has to be attributed. Falls back to the cutoff itself so a BLIND read still
 * reports which window it looked at, and `null` only when nothing was graded.
 */
export function latestGradedDate(ac2) {
  const dates = (ac2?.gradeableBooks ?? []).flatMap((b) => b.dates ?? []).map(String);
  if (dates.length > 0) return dates.sort().at(-1);
  return ac2?.since ?? null;
}

/**
 * Render deploy history. Fails SOFT to `null` — never to `[]`, which
 * {@link gradeWriterProvenance} would read as "history exists and named nobody"
 * and report as a history-coverage gap rather than as an absent credential.
 *
 * `limit=50` because the window graded is ~22h behind the read and this service
 * takes up to a deploy every 30 minutes; a short page would routinely fail to
 * reach back to the write window and report UNATTRIBUTABLE for the wrong reason.
 */
async function fetchDeployHistory(env = process.env) {
  const key = env.RENDER_API_KEY;
  const service = env.RENDER_SERVICE_ID;
  if (!key || !service) return null;
  try {
    const res = await fetch(
      `https://api.render.com/v1/services/${service}/deploys?limit=50`,
      { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** `/api/health/version`, for the point-in-time SHA. Soft-fails to `null`. */
async function fetchLiveVersion(reconUrl) {
  try {
    const url = new URL(reconUrl);
    url.pathname = '/api/health/version';
    url.search = '';
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Ancestry resolver: is `sha` a descendant of the fix commit?
 *
 * Returns `null` — never `false` — when the question cannot be answered locally.
 * `false` is an accusation ("the fix was not in that build"), and a non-git
 * checkout, a shallow clone, or an unfetched object are all states in which we
 * simply do not know. This distinction is the whole reason UNATTRIBUTABLE exists
 * as a separate verdict from PRE_FIX_WRITER.
 */
function makeAncestryResolver(repoDir) {
  const cache = new Map();
  return (sha) => {
    if (cache.has(sha)) return cache.get(sha);
    let out = null;
    try {
      // Both objects must be present locally; `cat-file -e` distinguishes "absent"
      // from "not an ancestor", which `merge-base` alone conflates into exit 1.
      for (const rev of [AC2_WRITER_FIX_COMMIT, sha]) {
        const probe = spawnSync('git', ['cat-file', '-e', `${rev}^{commit}`], { cwd: repoDir, encoding: 'utf-8' });
        if (probe.error || probe.status !== 0) { cache.set(sha, null); return null; }
      }
      const r = spawnSync(
        'git', ['merge-base', '--is-ancestor', AC2_WRITER_FIX_COMMIT, sha],
        { cwd: repoDir, encoding: 'utf-8' },
      );
      if (r.error || (r.status !== 0 && r.status !== 1)) out = null;
      else out = r.status === 0;
    } catch {
      out = null;
    }
    cache.set(sha, out);
    return out;
  };
}

/**
 * TRA-2630 AC2 — print the writer attribution. Called from {@link printAc2} so it
 * appears on EVERY arm, above the verdict, for the same reason the instrument
 * revision does: the reading a stale or credential-less run produces must announce
 * its own limits rather than leave a grader to notice an absence.
 */
function printWriterProvenance(w) {
  if (!w) {
    console.log('  writer: NOT CHECKED — this run graded the row value without attributing the');
    console.log('    build that wrote it. Treat a PASS as unattributed (TRA-2630 AC2).');
    return;
  }
  if (w.verdict === 'CONFIRMED') {
    console.log(
      `  writer: CONFIRMED — ${w.serving.length} build(s) served the ${w.gradedDate} write window`
      + ` (${w.windowStart} .. ${w.windowEnd}), all descend from ${w.fixCommit}:`,
    );
    for (const b of w.serving) {
      console.log(`      ${b.sha.slice(0, 9)} served from ${b.finishedAt}${b.servedUntil ? ` until ${b.servedUntil}` : ' (still serving)'}`);
    }
    return;
  }
  if (w.verdict === 'PRE_FIX_WRITER') {
    console.log(`  writer: PRE-FIX BUILD — ${w.reason}.`);
    for (const b of w.serving) {
      console.log(
        `      ${b.sha.slice(0, 9)} descendsFromFix=${JSON.stringify(b.descendsFromFix)}`
        + ` served from ${b.finishedAt}${b.servedUntil ? ` until ${b.servedUntil}` : ' (still serving)'}`,
      );
    }
    console.log('    The graded row was written by a build without the TRA-2629 fix, so NEITHER a');
    console.log('    pass nor a fail is attributable to it. The verdict above is DOWNGRADED to');
    console.log('    BLIND for that reason. Redeploy a descendant build and grade the NEXT session.');
    return;
  }
  if (w.verdict === 'NOT_APPLICABLE') {
    console.log(`  writer: NOT APPLICABLE — ${w.reason}.`);
    return;
  }
  if (w.verdict === 'NOT_YET_WRITTEN') {
    console.log(`  writer: NOT YET WRITTEN — ${w.reason}.`);
    console.log('    This is a PRE-CHECK, not the grade. Re-run after the EOD write to attribute');
    console.log('    the row; any PASS/FAIL printed below is about earlier sessions only.');
    return;
  }
  console.log(`  writer: UNATTRIBUTED — ${w.reason}.`);
  console.log('    A point-in-time `/api/health/version` read cannot see a rollback that served');
  console.log('    the write window and was replaced before this grade ran, so the PASS/FAIL');
  console.log('    above is a statement about the ROW, not about the fix. Not wired to the exit');
  console.log('    code: on a non-git checkout this is the normal reading, and failing on it');
  console.log('    would make the guard unrunnable where it actually runs.');
}

/**
 * TRA-2630 — THE LIVE COHORT IS NOT STABLE WITHIN A SINGLE BUILD.
 *
 * Every empty-live-cohort defect on this ticket (the `Array.every` green in
 * `1b803bd`, the tri-state fold in `32dac46`) assumed the cohort it read was the
 * cohort that existed. Measured on bqb1 2026-07-30, that assumption is false at
 * the TRANSPORT layer, not the predicate layer:
 *
 *     14:57:45Z   admin mode: demo    liveBookCount 0    sha 9e7f1c72
 *     14:58:44Z   admin mode: live    liveBookCount 1    sha 9e7f1c72
 *     ... 21 consecutive pulls, all live, SAME sha ...
 *
 * Same build, ~60s apart, opposite live cohorts. The endpoint's own note at
 * `liveBookCount` names the mechanism: when the TRA-713/TRA-1652 boot arm fails
 * to converge (`bootArmDrift: ['mode']`) the serving instance resolves `admin` as
 * `demo`. So a point-in-time pull samples WHICH INSTANCE ANSWERED, not the fleet.
 *
 * This matters because AC2's real-money arm is a ONE-SHOT read of a perishable
 * row. A transient `demo` resolution does not fabricate a green — the tri-state
 * correctly reports NOT MEASURED — but it silently spends the only chance to
 * grade real money, and "not measured" is indistinguishable in the output from
 * "there is genuinely no live book".
 *
 * So: re-sample ONLY when the first pull resolves an empty live cohort (the rare
 * and dangerous direction), and adopt any sample that resolves a live book. The
 * bias is deliberately toward real money — one instance claiming a live book is
 * enough to grade it as live. The common path costs exactly one request.
 */
const LIVE_COHORT_SAMPLES = 5;
const LIVE_COHORT_SAMPLE_GAP_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countLiveBooks(payload) {
  const engines = Array.isArray(payload?.engines) ? payload.engines : [];
  return engines.filter((e) => e?.mode === 'live').length;
}

/**
 * Pure. Given the samples taken, choose which one grades and say why. Never
 * throws on a short or malformed sample list — an unusable set is reported as
 * such rather than silently becoming "no live books".
 */
function pickLiveCohortSample(samples) {
  const usable = (Array.isArray(samples) ? samples : []).filter(
    (s) => s && Array.isArray(s.engines),
  );
  if (usable.length === 0) {
    return { payload: null, adoptedIndex: -1, counts: [], flapped: false, confirmedEmpty: false };
  }
  const counts = usable.map(countLiveBooks);
  const firstLive = counts.findIndex((n) => n > 0);
  if (firstLive === -1) {
    // Every sample agreed the live cohort is empty. That is now a CONFIRMED
    // reading rather than a single-sample artifact — but only if we actually
    // took more than one sample.
    return {
      payload: usable[0],
      adoptedIndex: 0,
      counts,
      flapped: false,
      confirmedEmpty: usable.length > 1,
    };
  }
  return {
    payload: usable[firstLive],
    adoptedIndex: firstLive,
    counts,
    flapped: firstLive > 0,
    confirmedEmpty: false,
  };
}

async function loadPayload(argv) {
  const fileArg = argv.find((a) => a.startsWith('--file='));
  if (fileArg) {
    const path = fileArg.slice('--file='.length);
    // A fixture is deterministic by construction; re-sampling it would only
    // repeat the same bytes.
    return { payload: JSON.parse(await readFile(path, 'utf-8')), sampling: null };
  }
  const urlArg = argv.find((a) => a.startsWith('--url='));
  const url = urlArg ? urlArg.slice('--url='.length) : DEFAULT_URL;
  const samples = [];
  for (let i = 0; i < LIVE_COHORT_SAMPLES; i += 1) {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    samples.push(await res.json());
    // The live cohort is non-empty, so there is nothing to disambiguate.
    if (countLiveBooks(samples[i]) > 0) break;
    if (i < LIVE_COHORT_SAMPLES - 1) await sleep(LIVE_COHORT_SAMPLE_GAP_MS);
  }
  const picked = pickLiveCohortSample(samples);
  return {
    payload: picked.payload,
    sampling: { ...picked, sampleCount: samples.length, url },
  };
}

/**
 * Disclose the sampling whenever it did anything. Silence here would recreate
 * the defect: a reader cannot tell a confirmed-empty live cohort from a single
 * unlucky pull unless the instrument says which one it got.
 */
function reportLiveCohortSampling(sampling) {
  if (!sampling || sampling.sampleCount <= 1) return;
  console.log('');
  if (sampling.flapped) {
    console.log(
      `  LIVE COHORT FLAP — sample 1 of ${sampling.sampleCount} resolved 0 live book(s); `
        + `sample ${sampling.adoptedIndex + 1} resolved ${sampling.counts[sampling.adoptedIndex]}.`,
    );
    console.log(`    per-sample live book counts: [${sampling.counts.join(', ')}]`);
    console.log('    Adopted the live-resolving sample. The bias is deliberate: one instance');
    console.log('    claiming a live book is enough to grade it as real money. Had this run');
    console.log('    taken only the first pull, the real-money arm would have read NOT');
    console.log('    MEASURED and the one-shot chance to grade it would have been spent.');
  } else if (sampling.confirmedEmpty) {
    console.log(
      `  live cohort empty — CONFIRMED across ${sampling.sampleCount} samples `
        + `(counts [${sampling.counts.join(', ')}]).`,
    );
    console.log('    Still NOT a pass. This says the cohort is genuinely empty rather than');
    console.log('    unluckily sampled; it does not say real money was graded.');
  }
}

async function main(argv) {
  let payload;
  let sampling = null;
  try {
    const loaded = await loadPayload(argv);
    payload = loaded.payload;
    sampling = loaded.sampling;
  } catch (err) {
    console.error(`BLIND — could not read the reconciliation payload: ${err.message}`);
    console.error('Exiting 3. This is NOT a pass: an unreadable endpoint grades nothing.');
    return EXIT_BLIND;
  }
  if (!payload) {
    console.error('BLIND — no usable reconciliation payload after sampling the endpoint.');
    console.error('Exiting 3. This is NOT a pass.');
    return EXIT_BLIND;
  }
  reportLiveCohortSampling(sampling);

  // `--since=YYYY-MM-DD` moves the AC2 delta boundary. Defaults to the TRA-2629
  // fix-deploy date; a later fix gets its own boundary rather than inheriting a
  // baseline that was never written under it.
  const sinceArg = argv.find((a) => a.startsWith('--since='));
  const since = sinceArg ? sinceArg.slice('--since='.length) : AC2_FIX_DEPLOY_DATE;
  const g = gradePayload(payload, { since });
  if (g.verdict === 'BLIND') {
    console.error(`BLIND — ${g.reason}. Exiting 3; this is NOT a pass.`);
    return EXIT_BLIND;
  }

  // TRA-2630 AC2 — attribute the WRITER before reporting the value. Every input
  // soft-fails to a NOT-MEASURED reading rather than to an assumption: no Render
  // credential, no git checkout, or a history page that does not reach the write
  // window all land on UNATTRIBUTED, which prints loudly and changes no verdict.
  // Only a build provably lacking the fix downgrades the grade.
  const urlArg = argv.find((a) => a.startsWith('--url='));
  const reconUrl = urlArg ? urlArg.slice('--url='.length) : DEFAULT_URL;
  const [deploys, version] = await Promise.all([
    argv.includes('--no-writer-check') ? Promise.resolve(null) : fetchDeployHistory(),
    argv.includes('--no-writer-check') ? Promise.resolve(null) : fetchLiveVersion(reconUrl),
  ]);
  g.ac2 = applyWriterProvenanceToAc2(
    g.ac2,
    gradeWriterProvenance({
      deploys,
      isDescendant: makeAncestryResolver(REPO_DIR),
      gradedDate: latestGradedDate(g.ac2),
      liveCommit: version?.commit ?? null,
    }),
  );

  const legs = summarizeLegs(payload);
  console.log(`pulled ${payload.time ?? '(no timestamp)'} — ${g.engineCount} engine books`);
  console.log('');
  console.log('TRA-2630 Defect A — per-leg drift. NEITHER leg is gradeable (TRA-2641 retracts');
  console.log('the TRA-2633 "grade optionsLeg only" guidance). Both are EVIDENCE, not verdicts:');
  console.log(`  graded sessions (post-baseline) : ${legs.graded}`);
  if (legs.present === 0) {
    console.log('  per-leg drift              : NOT MEASURED — this build serves no');
    console.log('    `stockLegDrift`/`optionsLegDrift`, i.e. it predates TRA-2630. Reporting');
    console.log('    "0 offending" here would be a green over an absent field. Deploy first.');
  } else {
    if (legs.present < legs.graded) {
      console.log(`  WARNING: only ${legs.present}/${legs.graded} graded sessions carry the per-leg fields.`);
    }
    const optionsVerdict = legs.optionsLegOk === null
      ? 'NOT MEASURED'
      : legs.optionsLegOk ? 'OK' : 'RED';
    console.log(`  optionsLeg  NOT gradeable       : ${optionsVerdict} — ${legs.optionsBad}/${legs.present} offending (max |drift| $${legs.maxOptions.toFixed(2)}),`);
    console.log(`    only ${legs.optionsMeasurable}/${legs.present} rows are INDEPENDENT (${legs.optionsSlaved} journal-slaved).`);
    if (legs.optionsLegOk === null) {
      console.log('    NOT MEASURED is NOT a pass. TRA-2641\'s `syncEodReportOptionsLegs` writes the');
      console.log('    day cell\'s `optionsDailyPnl` INTO the report file\'s options leg on every');
      console.log('    `journal`/`journal-repair` row, so `optionsLegDrift` = `eodOptionsPnl` -');
      console.log('    `optionsDaily` compares one source against a copy of itself and is 0 by');
      console.log('    construction. This leg was the TRA-2633 recommended gate; that is RETRACTED.');
      console.log('    Grade the CREDIT axis below (`equityAbsorbedOptionsOk` / uncredited USD) —');
      console.log('    its operands are the journal and the equity ledger, which no writer joins.');
    }
    const stockVerdict = legs.stockLegOk === null
      ? 'NOT MEASURED'
      : legs.stockLegOk ? 'OK' : 'RED';
    console.log(`  stockLeg    NOT gradeable       : ${stockVerdict} — ${legs.stockBad}/${legs.present} offending (max |drift| $${legs.maxStock.toFixed(2)}),`);
    console.log(`    only ${legs.stockMeasurable}/${legs.present} rows carry a non-zero \`eodStockPnl\`.`);
    if (legs.stockLegOk === null) {
      console.log('    NOT MEASURED is NOT a pass and NOT a defect. `eodStockPnl` is zeroed by the');
      console.log('    TRA-219 21:00 ET archive race, so `stockLegDrift` == -`stockDaily` and the red');
      console.log('    count above just restates "the equity delta moved". No stock-reconciliation');
      console.log('    fix can move it. Do not open a regression off this line (TRA-2633).');
    }
    // The endpoint computes its own `stockLegOk`; if we disagree, one of us is
    // stale and the grader must not silently pick a side.
    if (payload?.stockLegOk !== undefined && payload.stockLegOk !== legs.stockLegOk) {
      console.log(`  WARNING: endpoint stockLegOk=${JSON.stringify(payload.stockLegOk)} but this guard computed`);
      console.log(`    ${JSON.stringify(legs.stockLegOk)} from the same rows. Guard and endpoint disagree — treat BOTH as unread.`);
    }
  }
  console.log(`  NOT gradeable, shown for continuity: ok=${payload.ok} maxDriftUsd=${payload.maxDriftUsd}`);
  // TRA-2630 AC1 — does the SERVED payload disclaim those two fields where they
  // are read? The prose caveat has always been in `engines[i].caveats`, one level
  // below the head of the response, which is where a gate author looks. This line
  // grades the hoist itself so a future refactor cannot silently un-document it.
  // Reported, never folded into the exit code: an OLD build legitimately lacks
  // the field, and turning that into a failure would make this guard unrunnable
  // against any pinned deploy.
  const gradeability = describeGradeabilityDisclaimer(payload);
  console.log(`  top-level disclaimer: ${gradeability.verdict} — ${gradeability.detail}`);
  console.log('');

  // TRA-2635 — the credit axis, printed BEFORE the lag axis because it is the
  // more fundamental question: the lag detector cannot fire at all on a book the
  // credit path never reached, so a clean lag verdict means nothing until this
  // one is graded.
  const credit = gradeCreditObservation(payload);
  console.log('TRA-2635 — did realized option P&L reach the LIVE book\'s equity? (durable STATE):');
  for (const b of credit.books) {
    const label =
      b.absorbed === true ? 'ABSORBED' : b.absorbed === false ? 'ABSORBED NOTHING' : 'NOT MEASURED';
    console.log(
      `  LIVE  ${b.username}: ${label} — ${b.measuredSessions} gradeable session(s), `
      + `post-baseline options P&L $${b.optionsRealizedUsd.toFixed(2)}`,
    );
    console.log(
      `        optionsCreditedCumulative ${b.creditedLatest === null ? 'ABSENT' : `$${b.creditedLatest.toFixed(2)}`}`
      + `${b.creditedLatestDate ? ` @ ${b.creditedLatestDate}` : ''}`
      + `  |  closingEquity ${b.closingEquityLatest === null ? 'ABSENT' : `$${b.closingEquityLatest.toFixed(2)}`}`
      + `${b.closingEquityLatestDate ? ` @ ${b.closingEquityLatestDate}` : ''}`,
    );
  }
  if (credit.verdict === 'NO_LIVE_BOOK') {
    console.log(`  NOT MEASURED — 0 of ${g.engineCount} books resolved \`mode: live\`.`);
  } else if (credit.verdict === 'FIELD_ABSENT') {
    console.log('  NOT MEASURED — this build serves no `optionsCreditedCumulative`, i.e. it');
    console.log('    predates TRA-2635. Reading `undefined` as "0 credited" would ACCUSE a');
    console.log('    working bridge; reading it as graded would CLEAR a broken one. Deploy first.');
  } else if (credit.verdict === 'UNMEASURABLE') {
    console.log('  NOT MEASURED — the live book realized no post-baseline option P&L, so there');
    console.log('    was nothing for equity to absorb. Not a pass and not a defect.');
  }
  // The endpoint computes its own fold; a disagreement means one side is stale.
  if (
    payload?.liveEquityAbsorbedOptionsOk !== undefined
    && credit.verdict !== 'FIELD_ABSENT'
  ) {
    const mine =
      credit.verdict === 'LIVE_CREDIT_UNSHIPPED'
        ? false
        : credit.verdict === 'CREDIT_OK'
          ? true
          : null;
    if (payload.liveEquityAbsorbedOptionsOk !== mine) {
      console.log(
        `  WARNING: endpoint liveEquityAbsorbedOptionsOk=${JSON.stringify(payload.liveEquityAbsorbedOptionsOk)}`
        + ` but this guard computed ${JSON.stringify(mine)} from the same rows.`,
      );
      console.log('    Guard and endpoint disagree — treat BOTH as unread.');
    }
  }
  // Graded here and printed unconditionally below, so no early return can hide it.
  const freeze = gradeLiveCounterFreeze(credit);
  printCounterFreezeAxis(freeze);
  // TRA-2761 — likewise printed unconditionally: the reclassified state is the one
  // where every OTHER live axis reads NOT MEASURED, so any early return that could
  // hide this line would hide the only red left.
  const integrity = gradeLiveCohortIntegrity(payload);
  printCohortIntegrityAxis(integrity);
  console.log('');
  console.log('TRA-2630 AC3 — T+1 options-credit lag (stockDaily == prior session optionsDaily):');

  if (g.verdict === 'CLEAN') {
    console.log(
      `  CLEAN — 0 books show the lag, on either mode (${g.liveBookCount} live book(s) graded,`
      + ` ${g.liveGradeableBookCount} with a gradeable session).`,
    );
    printAc2(g.ac2);
    // TRA-2635 — and a clean lag verdict is NOT sufficient on its own. This early
    // `return EXIT_CLEAN` is the exact shape CEO retracted: it passes the fleet on
    // an axis that cannot fire on a book the credit path never reached.
    if (credit.verdict === 'LIVE_CREDIT_UNSHIPPED') return reportCreditUnshipped(credit);
    // Ranked ABOVE the credit BLIND: a freeze is a concrete real-money finding and
    // reporting it as "graded nothing" loses it. `admin`'s real shape lands here
    // once its shortfall clears — `absorbed` goes null on a frozen counter, which
    // is UNMEASURABLE, which is BLIND.
    if (freeze.verdict === 'FROZEN') return reportCounterFrozen(freeze);
    // TRA-2761 — same rule: reclassified-under-open-notional is a finding, and the
    // BLIND both it and the credit axis would otherwise land on loses it.
    if (integrity.verdict === 'RECLASSIFIED') return reportCohortReclassified(integrity);
    if (credit.verdict !== 'CREDIT_OK') return reportCreditBlind(credit);
    console.log('');
    console.log(`CLEAN — all three axes graded on ${credit.liveBookCount} live book(s).`);
    return EXIT_CLEAN;
  }

  for (const row of [...g.live, ...g.demo]) {
    console.log(`  ${row.mode === 'live' ? 'LIVE ' : 'demo '} ${row.username}`);
    for (const h of row.hits) {
      console.log(
        `      ${h.date} stockDaily ${h.stockDaily.toFixed(2)} == ${h.priorDate} optionsDaily ${h.priorOptionsDaily.toFixed(2)}`,
      );
    }
  }
  const lagRows = [...g.live, ...g.demo].reduce((n, r) => n + r.hits.length, 0);
  console.log('');
  // Printed BEFORE every early return below — including the exit-4 credit
  // short-circuit, which outranks demo lag on the EXIT CODE but must not
  // suppress the one verdict AC2 is graded on.
  printAc2(g.ac2);

  if (g.live.length > 0) {
    console.error(`LIVE LAG — ${g.live.length} mode:live book(s), ${lagRows} lag session(s) total.`);
    console.error('ESCALATE IMMEDIATELY. This is a real-money NAV overstatement of one session');
    console.error('of realized options P&L. Stop netting the credit path and re-open the');
    console.error('TRA-2323 rollback question — TRA-2630\'s demo-only verdict is now falsified.');
    return EXIT_LIVE_LAG;
  }
  // TRA-2630 AC3 — real money, and it outranks both the BLIND below and the demo
  // verdict: a freeze is a finding, and "$0 live capital at risk" is misleading
  // while a live book's daily rows are understated by a credit sitting in NAV.
  // Ranked below LIVE LAG (a NAV overstatement is worse than a mis-attribution)
  // and below the exit-4 shortfall (money absent beats money mislabelled).
  if (credit.verdict === 'LIVE_CREDIT_UNSHIPPED') return reportCreditUnshipped(credit);
  if (freeze.verdict === 'FROZEN') return reportCounterFrozen(freeze);
  // TRA-2761 — checked ABOVE the LIVE_UNMEASURABLE BLIND: when the cohort empties
  // under open live notional, LIVE_UNMEASURABLE is exactly the arm that fires, and
  // exiting BLIND there reports "graded nothing" over what is actually a
  // loss-of-observer on real open money. The specific verdict must win.
  if (integrity.verdict === 'RECLASSIFIED') return reportCohortReclassified(integrity);
  // Ordered ABOVE the demo verdict deliberately. With no live book in the fleet
  // the sentence "0 live books, so $0 live capital is at risk" is not a finding —
  // it is the absence of one, and it must not be printed as reassurance.
  if (g.verdict === 'LIVE_UNMEASURABLE') {
    console.error(
      `BLIND — the real-money tripwire graded NOTHING: ${g.unmeasurableReason}`
      + ` (${g.liveBookCount} of ${g.engineCount} books resolved \`mode: live\`,`
      + ` ${g.liveGradeableBookCount} with a session whose prior carried non-zero optionsDaily).`,
    );
    console.error('"No live book was affected" and "there was no live book" are the same reading');
    console.error('here, so this is NOT a pass and NOT evidence for the demo-only verdict.');
    if (g.demo.length > 0) {
      console.error(`(${g.demo.length} demo book(s) / ${lagRows} lag session(s) listed above still stand.)`);
    }
    console.error('');
    console.error('DIAGNOSE FIRST — the cohort is usually empty because the operator boot-arm');
    console.error('did not converge, not because the fleet is genuinely all-demo:');
    console.error('  curl -s https://tradingai-bqb1.onrender.com/api/health/options-live');
    console.error('  -> bootArmEligible:true + bootArmDrift:["mode"] means admin SHOULD be live');
    console.error('     and is not (TRA-713 / TRA-1652). Re-arm, then re-run this check.');
    return EXIT_BLIND;
  }
  // TRA-2635 — a live credit failure outranks demo lag: it is real money, and the
  // "$0 live capital at risk" sentence below is FALSE while it is true. Both this
  // and the frozen axis are now checked ABOVE the LIVE_UNMEASURABLE BLIND as well
  // — a real-money finding must not be reported as "graded nothing".
  console.error(
    `DEMO LAG — ${g.demo.length} demo book(s), ${lagRows} lag session(s). ${g.liveBookCount} live book(s) graded, 0 affected.`,
  );
  console.error('Real, but $0 live trading capital at risk. TRA-2630 Defect B / TRA-2629.');
  console.error('Note: ctoverify_* / qa_* are clone fixtures, so book COUNT overstates breadth.');
  // The demo-only severity verdict rests on the live book being CLEAN, and the lag
  // axis alone cannot establish that (TRA-2635). Say so rather than implying it.
  if (credit.verdict !== 'CREDIT_OK') {
    console.error('');
    console.error('CAVEAT: the credit axis above is NOT MEASURED, so "0 live books affected" is');
    console.error('carried by the lag axis alone — which reads clean on a book the credit path');
    console.error('never reached. The demo-only severity verdict is NOT confirmed by this run.');
  }
  return EXIT_DEMO_LAG;
}

/**
 * TRA-2630 AC2 — this instrument's own provenance, printed ABOVE the verdict on
 * EVERY arm.
 *
 * The AC2 grade fires ONCE (routine `89f86715`, 21:30 ET). Its worst failure mode
 * is not a wrong verdict — it is a real-looking verdict produced by a STALE copy
 * of this script. A checkout predating `f7a8cb0` prints no AC2 section at all; one
 * predating `09f3821` prints the verdict with NO cohort pin, so a denominator that
 * shrank from 15 books to 1 reads as a clean PASS — the exact defect `09f3821`
 * exists to kill. Both are live risks: the grader runs from whatever checkout the
 * harness hands the run, and on 2026-07-30T11:3xZ the handed `PAPERCLIP_WORKSPACE_CWD`
 * was not a git repository at all while `$AGENT_HOME/trading-app` sat 3 commits stale.
 *
 * A stale script cannot warn you that it is stale. So this line is written to state
 * what its OWN ABSENCE means, and the routine requires it: absence becomes a
 * positive stale signal instead of something a reader must notice is missing.
 */
const AC2_INSTRUMENT_REV = 'pin + writer-attribution era (09f3821+, writer arm)';

function printAc2Provenance() {
  console.log(`  instrument: check-pnl-options-lag.mjs — AC2 ${AC2_INSTRUMENT_REV}.`);
  console.log('  If this line is ABSENT from your output you are running a STALE checkout:');
  console.log('  that reading is BLIND, not a verdict. `git pull origin main`, then re-run.');
  console.log('  The same applies to the `writer:` line below — a copy that prints no writer');
  console.log('  attribution cannot tell a fixed writer from a rolled-back one.');
}

/**
 * TRA-2630 AC2 — print the DELTA verdict. Always runs before the early returns,
 * because the exit code is owned by whichever axis outranks (a live credit
 * shortfall beats demo lag) and AC2 must stay readable underneath it.
 */
function printAc2(ac2) {
  if (!ac2) return;
  console.log(`TRA-2630 AC2 — NEW lag sessions dated >= ${ac2.since} (the fix-deploy boundary):`);
  printAc2Provenance();
  printWriterProvenance(ac2.writer);
  if (ac2.verdict === 'BLIND' && ac2.downgradedFrom) {
    console.log(
      `  BLIND — DOWNGRADED from ${ac2.downgradedFrom}. The row value was ${ac2.rows} new lag`
      + ` session(s) over ${ac2.gradeableBookCount} gradeable book(s), but the writer above is a`
      + ' pre-fix build, so that number grades the ROW and not the FIX. NOT a pass.',
    );
    printAc2Cohort(ac2.cohort);
    return;
  }
  if (ac2.verdict === 'BLIND') {
    console.log(
      `  BLIND — NOT MEASURED. 0 books carry a gradeable session on/after ${ac2.since}`
      + ` (${ac2.rowBookCount} book(s) have a row at all).`,
    );
    console.log('  This is NOT a pass. "No new lag session" and "no session to grade" are the');
    console.log('  same output here — the TRA-2637 shape, where an absent EOD row scored drift 0.');
    console.log('  The 21:00 ET writer has not produced a gradeable row yet; re-run, do not grade.');
    printAc2Cohort(ac2.cohort);
    return;
  }
  if (ac2.verdict === 'PASS') {
    console.log(
      `  PASS — 0 new lag sessions AND 0 new frozen-counter sessions across`
      + ` ${ac2.gradeableBookCount} book(s) that COULD have shown one.`,
    );
    console.log('  The pre-fix rows listed above are the baseline and do not clear retroactively.');
    printAc2Cohort(ac2.cohort);
    return;
  }
  console.log(
    `  FAIL — ${ac2.rows} NEW lag session(s) and ${ac2.frozenRows ?? 0} NEW frozen-counter`
    + ` session(s) written under the deployed fix, over ${ac2.gradeableBookCount} gradeable book(s).`,
  );
  for (const row of ac2.books) {
    for (const h of row.hits) {
      console.log(
        `      ${row.mode === 'live' ? 'LIVE ' : 'demo '} ${row.username} ${h.date}`
        + ` stockDaily ${h.stockDaily.toFixed(2)} == ${h.priorDate} optionsDaily ${h.priorOptionsDaily.toFixed(2)}`,
      );
    }
  }
  // TRA-2658 — the frozen arm, named the same way. A FAIL that does not say WHICH
  // axis failed sends the reader to the wrong fix: a lag session means the credit
  // was re-booked into the stock leg, a frozen session means it was never recorded
  // at all.
  for (const row of ac2.frozenBooks ?? []) {
    for (const h of row.hits) {
      console.log(
        `      ${row.mode === 'live' ? 'LIVE ' : 'demo '} ${row.username} ${h.date}`
        + ` FROZEN counter — $${h.move.toFixed(2)} of equity moved with no credit recorded`,
      );
    }
  }
  if (ac2.liveRows > 0 || (ac2.liveFrozenRows ?? 0) > 0) {
    console.log('  A mode:live book is among them — TRA-2630\'s demo-only verdict is FALSIFIED.');
  }
  printAc2Cohort(ac2.cohort);
}

/**
 * TRA-2630 AC2 — observed cohort vs the cohort pinned before the observation.
 * Printed on EVERY arm: a shrunken cohort changes what a PASS covers, changes
 * which books a FAIL failed to check, and is the difference between "the writer
 * ran and nothing was eligible" and "the writer skipped 15 eligible books".
 */
function printAc2Cohort(cohort) {
  if (!cohort) return;
  if (cohort.verdict === 'NOT_APPLICABLE') {
    console.log(`  cohort pin: NOT APPLICABLE — ${cohort.reason}.`);
    return;
  }
  if (cohort.verdict === 'INTACT') {
    console.log(
      `  cohort pin: INTACT — all ${cohort.expectedCount} book(s) eligible off the 2026-07-29`
      + ` rows presented a gradeable session${
        cohort.extra.length > 0 ? `, plus ${cohort.extra.length} that newly became eligible` : ''
      }.`,
    );
    return;
  }
  console.log(
    `  cohort pin: SHRANK — ${cohort.missing.length} of ${cohort.expectedCount} pinned book(s)`
    + ` produced NO gradeable session; ${cohort.observedCount} observed.`,
  );
  console.log('  The verdict above covers only the books that presented. This is not a regression');
  console.log('  in the fix — it is missing evidence, and it is the reason the count is smaller.');
  for (const b of cohort.missing) {
    console.log(
      `      ${b.mode === 'live' ? 'LIVE ' : 'demo '} ${b.username}`
      + ` — 2026-07-29 optionsDaily ${b.priorOptionsDaily.toFixed(2)}, no ${AC2_FIX_DEPLOY_DATE} row to refute it`,
    );
  }
  if (cohort.missing.some((b) => b.mode === 'live')) {
    console.log('  The LIVE book is among the missing — the real-money arm of AC2 did NOT grade.');
  }
}

/** TRA-2635 — the real-money escalation, in one place so both call sites agree. */
function reportCreditUnshipped(credit) {
  const bad = credit.books.filter(
    (b) => b.absorbed === false || (b.uncredited != null && b.uncredited > 1),
  );
  console.error('');
  console.error(
    `LIVE CREDIT SHORTFALL — ${bad.length} mode:live book(s) hold realized option P&L`,
  );
  console.error('that never reached NAV. ESCALATE.');
  for (const b of bad) {
    console.error(
      `  ${b.username}: $${b.optionsRealizedUsd.toFixed(2)} realized, equity grew `
      + `$${(b.equityGrowth ?? 0).toFixed(2)} on a $${b.stockSum.toFixed(2)} stock leg`,
    );
    // TRA-2658 — the upper-bound caveat belongs to a RESET counter ONLY, not to
    // every `counterDurable: false`. A reset re-books the lagged credit INTO
    // `stockDaily`, so that leg double-counts and the shortfall overstates. A
    // FROZEN counter does the opposite: `openingEquity` absorbed the credit before
    // the close, so `stockDaily` is the exact stock leg and the figure is EXACT.
    // Keying the caveat on the boolean printed both claims at once — the previous
    // spelling called admin's $733.60 an upper bound directly above the line
    // proving its stock leg was exact.
    const resetBound = (b.counterResetDates ?? []).length > 0;
    const frozenOnly = !resetBound && (b.counterFrozenDates ?? []).length > 0;
    console.error(
      `      => $${(b.uncredited ?? 0).toFixed(2)} ABSENT FROM NAV`
      + (resetBound
        ? ' (UPPER BOUND — counter RESET, so the lagged credit double-counts in the stock leg)'
        : frozenOnly
          ? ' (EXACT — counter FROZEN, not reset: the stock leg was never re-booked)'
          : ''),
    );
    console.error(
      `      counter: optionsCreditedCumulative $${(b.creditedLatest ?? 0).toFixed(2)}`
      + ` over ${b.measuredSessions} gradeable session(s), durable=${JSON.stringify(b.counterDurable)}`,
    );
    // TRA-2658 — WHY the counter is not durable, which decides the remediation.
    if ((b.counterFrozenDates ?? []).length > 0) {
      console.error(
        `      counter FROZEN (TRA-2658) on ${b.counterFrozenDates.length} session(s):`
        + ` ${b.counterFrozenDates.map((r) => `${r.date} $${r.move.toFixed(2)}`).join(', ')}`,
      );
      console.error(
        '      => that credit DID reach closingEquity and was recorded as nothing. The stock'
        + ' leg is exact; the money is in NAV but in no daily row. Contrast a RESET counter,'
        + ' where the credit was re-booked INTO stockDaily and double-counts.',
      );
    }
    if ((b.counterResetDates ?? []).length > 0) {
      console.error(
        `      counter RESET (TRA-2629) on: ${b.counterResetDates.join(', ')}`,
      );
    }
    const unattributed = (b.unbookedMoveDates ?? []).filter(
      (r) => !(b.counterFrozenDates ?? []).some((f) => f.date === r.date),
    );
    if (unattributed.length > 0) {
      console.error(
        `      un-booked equity moves NOT attributed to a lost credit (a starting-balance edit`
        + ` is the benign cause): ${unattributed.map((r) => `${r.date} $${r.move.toFixed(2)}`).join(', ')}`,
      );
    }
  }
  console.error('TRA-2323 scope item 1 is UNSHIPPED on real capital. The book value every');
  console.error('sizing decision reads is understated by the whole realized options leg, and');
  console.error('a "clean" lag verdict is exactly what that state looks like (TRA-2635).');
  return EXIT_LIVE_CREDIT_UNSHIPPED;
}

/**
 * TRA-2630 AC3 — THE FROZEN AXIS AS A FIRST-CLASS VERDICT.
 *
 * AC3 says "assert `stockDaily != prior session optionsDaily` for every book, and
 * fail loudly for any `mode: live` book". That predicate is STRUCTURALLY BLIND to
 * the live book's actual failure. Measured on bqb1 2026-07-30T17:29:48Z, `admin`:
 *
 *     2026-07-27  optionsDaily 140.00                         closingEquity 2008.29
 *     2026-07-28  stockDaily -0.94   optionsDaily  68.00      closingEquity 2147.35
 *
 * `stockDaily -0.94` is nowhere near the prior `optionsDaily 140.00`, so AC3 reads
 * `priorOptionsLagOk: true` and the book is reported CLEAN — while the un-booked
 * equity move on that same session is +$140.00, EQUAL TO THE CENT to the prior
 * session's realized options P&L. Same T+1 mechanism, different landing site:
 * `openingEquity` absorbed the credit across a boot before the 21:00 close ran, so
 * the money is in NAV and in no daily row. AC3 only watches `stockDaily`.
 *
 * The axis existed (`counterFrozenDates`) but was printed ONLY from inside
 * {@link reportCreditUnshipped} — i.e. only while the credit axis was ALREADY
 * failing. That coupling is the trap, and it opens exactly when the repair lands:
 * a FROZEN counter puts the money in `closingEquity`, so `uncredited` falls to ~0
 * and the shortfall clears, while `absorbed` reads `true` off any session where
 * the counter did move. Verdict becomes `CREDIT_OK`, the frozen print is behind a
 * branch that no longer fires, and the run returns EXIT_CLEAN. Reproduced against
 * this script before the fix (`--file=` fixture, live book, $60 frozen):
 *
 *     CLEAN — both axes graded on 1 live book(s).        exit 0
 *
 * So this grades independently of the credit verdict and blocks EXIT_CLEAN.
 * Tri-state, like every other axis here: `null` is NOT MEASURED and never a pass.
 */
function gradeLiveCounterFreeze(credit) {
  const books = (credit?.books ?? []).filter((b) => (b.counterFrozenDates ?? []).length > 0);
  if (books.length > 0) return { verdict: 'FROZEN', books, gradeableBookCount: null };
  // The DENOMINATOR. A book with no written counter session cannot exhibit a
  // freeze OR refute one, so "0 frozen" over 0 gradeable books is NOT MEASURED —
  // the same empty-cohort green this whole ticket was filed about.
  const gradeable = (credit?.books ?? []).filter((b) => b.counterDurable !== null);
  if ((credit?.liveBookCount ?? 0) === 0 || gradeable.length === 0) {
    return { verdict: 'NOT_MEASURED', books: [], gradeableBookCount: gradeable.length };
  }
  return { verdict: 'CLEAN', books: [], gradeableBookCount: gradeable.length };
}

/**
 * Printed on EVERY path, before any early return. A higher-ranked axis
 * short-circuiting must not be able to suppress this verdict — that is the exact
 * shape that let the frozen axis go unread for a whole ticket.
 */
function printCounterFreezeAxis(freeze) {
  console.log('');
  console.log('TRA-2630 AC3 (second landing site) — is the LIVE counter FROZEN? (credit in NAV,');
  console.log('recorded in no daily row — invisible to the `stockDaily` predicate above):');
  if (freeze.verdict === 'NOT_MEASURED') {
    console.log(
      `  NOT MEASURED — ${freeze.gradeableBookCount} live book(s) carry a written counter session.`,
    );
    console.log('    Not a pass. "No freeze" and "nothing to freeze" are the same reading here.');
    return;
  }
  if (freeze.verdict === 'CLEAN') {
    console.log(`  CLEAN — 0 of ${freeze.gradeableBookCount} gradeable live book(s) show a freeze.`);
    return;
  }
  for (const b of freeze.books) {
    console.log(
      `  LIVE  ${b.username} — FROZEN on ${b.counterFrozenDates.length} session(s): `
      + b.counterFrozenDates.map((r) => `${r.date} $${r.move.toFixed(2)}`).join(', '),
    );
  }
}

/** TRA-2630 AC3 — the frozen axis fired on real money and nothing else would say so. */
function reportCounterFrozen(freeze) {
  console.error('');
  console.error(
    `LIVE COUNTER FROZEN — ${freeze.books.length} mode:live book(s) hold realized option P&L`,
  );
  console.error('that reached NAV and was recorded in NO daily row. The `stockDaily == prior');
  console.error('optionsDaily` tripwire CANNOT see this: `openingEquity` absorbed the credit, so');
  console.error('the stock leg stays exact and AC3 reads clean. Every daily row understates.');
  for (const b of freeze.books) {
    const total = b.counterFrozenDates.reduce((s, r) => s + r.move, 0);
    console.error(
      `  ${b.username}: $${Math.round(total * 100) / 100} across `
      + `${b.counterFrozenDates.length} session(s) — `
      + b.counterFrozenDates.map((r) => `${r.date} $${r.move.toFixed(2)}`).join(', '),
    );
    console.error(
      `      counter: optionsCreditedCumulative $${(b.creditedLatest ?? 0).toFixed(2)}`
      + ` over ${b.measuredSessions} gradeable session(s), durable=${JSON.stringify(b.counterDurable)}`,
    );
  }
  console.error('NOT a NAV overstatement and NOT the TRA-2630 escalation trigger — the money is');
  console.error('present and correct in `closingEquity`. It is an ATTRIBUTION defect: sizing and');
  console.error('reporting that read the daily rows are understated by the frozen amount.');
  console.error('Remediation differs from a RESET counter — a reset re-books the credit INTO');
  console.error('`stockDaily` and double-counts; a freeze leaves the stock leg exact (TRA-2658).');
  return EXIT_LIVE_COUNTER_FROZEN;
}

/**
 * TRA-2761 — cohort-membership integrity, read from the endpoint's own fold.
 * Pure, so `--selftest` and `--file=` can drive it.
 *
 * The state this exists for: 2026-08-02T00:47Z, all 61 books resolved
 * `mode:"demo"` while the option journal held 7 OPEN `mode:"live"` rows against
 * `admin`, $1,401.50 at risk. Every `live*` verdict went FALSE → null and this
 * script's honest answer was BLIND — which is true but toothless: BLIND says
 * "graded nothing", not "there is open real money nothing is grading". The
 * endpoint's `liveCohortIntegrityOk` cross-checks the read-time classifier
 * against the journal's durable open live rows; this arm consumes it.
 *
 * FIELD_ABSENT handling mirrors the credit axis: a build that predates the fold
 * serves `undefined`, and reading that as either verdict would grade an absent
 * field. Print NOT MEASURED and change nothing.
 */
function gradeLiveCohortIntegrity(payload) {
  if (payload?.liveCohortIntegrityOk === undefined) {
    return { verdict: 'FIELD_ABSENT', books: [], openRowCount: null, atRiskUsd: null, unattributed: null };
  }
  const books = payload.liveCohortReclassifiedBooks ?? [];
  const base = {
    books,
    openRowCount: payload.liveOpenJournalRowCount ?? null,
    atRiskUsd: payload.liveOpenJournalAtRiskUsd ?? null,
    unattributed: payload.liveOpenJournalUnattributedRowCount ?? null,
  };
  if (payload.liveCohortIntegrityOk === false) return { verdict: 'RECLASSIFIED', ...base };
  if (payload.liveCohortIntegrityOk === true) return { verdict: 'INTACT', ...base };
  // null — either the journal census was unavailable (counts null) or there are
  // genuinely no open live rows (count 0). Different sentences, same non-verdict.
  return {
    verdict: base.openRowCount === null ? 'NOT_MEASURED' : 'NO_OPEN_LIVE_ROWS',
    ...base,
  };
}

/** Printed on EVERY path, before any early return — same rule as the freeze axis. */
function printCohortIntegrityAxis(integrity) {
  console.log('');
  console.log('TRA-2761 — is every OPEN live-mode journal row inside the live cohort that');
  console.log('grades it? (durable journal stamp vs read-time classifier):');
  if (integrity.verdict === 'FIELD_ABSENT') {
    console.log('  NOT MEASURED — this build serves no `liveCohortIntegrityOk`, i.e. it predates');
    console.log('    TRA-2761. A cohort that empties under open live notional is INVISIBLE to');
    console.log('    every axis above on such a build. Deploy first.');
    return;
  }
  if (integrity.verdict === 'NOT_MEASURED') {
    console.log('  NOT MEASURED — the journal census was unavailable on this pull. Not a pass.');
    return;
  }
  if (integrity.verdict === 'NO_OPEN_LIVE_ROWS') {
    console.log('  NOTHING TO PROTECT — 0 open live-mode journal rows anywhere. (This is the');
    console.log('    published-count 0, not an unmeasured absence.)');
    return;
  }
  if (integrity.verdict === 'INTACT') {
    console.log(
      `  INTACT — ${integrity.openRowCount} open live row(s), $${(integrity.atRiskUsd ?? 0).toFixed(2)} at risk,`
      + ' every holder classified mode:live.',
    );
    return;
  }
  for (const b of integrity.books) {
    console.log(
      `  LIVE-ROW HOLDER ${b.username} — classified mode:${b.mode} with `
      + `${b.openLiveJournalRowCount} open live row(s), $${b.openLiveJournalAtRiskUsd.toFixed(2)} at risk`,
    );
  }
  if ((integrity.unattributed ?? 0) > 0) {
    console.log(`  ORPHANED — ${integrity.unattributed} open live row(s) no current book claims at all.`);
  }
}

/** TRA-2761 — the observer was reclassified away from open real money. */
function reportCohortReclassified(integrity) {
  console.error('');
  console.error(
    `LIVE COHORT RECLASSIFIED — ${integrity.openRowCount} open mode:live journal row(s),`
    + ` $${(integrity.atRiskUsd ?? 0).toFixed(2)} at risk, are OUTSIDE the live cohort every`,
  );
  console.error('live-axis verdict above is folded over. Those verdicts reading null/green is a');
  console.error('verdict-masking flip (TRA-2630/TRA-2709 class), not a repair. ESCALATE: either');
  console.error('the operator book was genuinely de-armed with positions still open, or the');
  console.error('classifier is mis-labelling a live engine — check /api/health/options-live');
  console.error('(`bootArmEligible`/`bootArmDrift`, TRA-713/TRA-1652) and re-arm, then re-run.');
  return EXIT_LIVE_COHORT_RECLASSIFIED;
}

/** TRA-2635 — the credit axis graded nothing; a clean lag verdict cannot cover for it. */
function reportCreditBlind(credit) {
  console.error('');
  console.error(`BLIND — the lag axis is clean but the CREDIT axis graded NOTHING (${credit.verdict}).`);
  console.error('These are different questions: the lag detector fires when a credit lands in');
  console.error('the wrong leg, and cannot fire at all when no credit ever landed. Passing on');
  console.error('the lag axis alone is the grade CEO retracted in TRA-2635.');
  return EXIT_BLIND;
}

/**
 * Both-direction controls. Every one of these is a state the live pull actually
 * produced or a mutation of the predicate that must not pass silently.
 */
function selftest() {
  const cases = [];
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    cases.push({ name, ok, actual, expected });
  };

  // POSITIVE — the live Richard sequence: two consecutive exact re-books.
  check(
    'fires on the live Richard 07-28/07-29 lag',
    findPriorOptionsLagDates([
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
      { date: '2026-07-28', stockDaily: 67.5, optionsDaily: 22.5 },
      { date: '2026-07-29', stockDaily: 22.5, optionsDaily: -5.11 },
    ]).map((h) => h.date),
    ['2026-07-28', '2026-07-29'],
  );

  // NEGATIVE — the clean live `admin` book. Both sessions have a non-zero
  // stockDaily AND a non-zero prior optionsDaily, so this is a real pass and
  // not an absence artifact.
  check(
    'stays clean on the live admin book (the demo-only verdict rests on this)',
    findPriorOptionsLagDates([
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 140 },
      { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68 },
      { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 250.01 },
    ]),
    [],
  );

  // NEGATIVE — the mutation that matters. Quiet days are "equal to the cent".
  check(
    'MUTATION: quiet days (0 == 0) do NOT fire',
    findPriorOptionsLagDates([
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 0 },
      { date: '2026-07-28', stockDaily: 0, optionsDaily: 0 },
      { date: '2026-07-29', stockDaily: 0, optionsDaily: 140 },
    ]),
    [],
  );

  // NEGATIVE — a cent of separation is honest trading.
  check(
    'MUTATION: a near-miss (67.51 vs 67.50) does NOT fire',
    findPriorOptionsLagDates([
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
      { date: '2026-07-28', stockDaily: 67.51, optionsDaily: 0 },
    ]),
    [],
  );

  // ORDERING — an unsorted day list must not change the verdict.
  check(
    'sorts before comparing — verdict is order-independent',
    findPriorOptionsLagDates([
      { date: '2026-07-28', stockDaily: 67.5, optionsDaily: 22.5 },
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
    ]).map((h) => h.date),
    ['2026-07-28'],
  );

  // MODE PARTITION — a live hit must not be absorbed by demo noise.
  check(
    'a LIVE hit outranks demo hits',
    gradePayload({
      engines: [
        { username: 'qa_x', mode: 'demo', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 450 },
          { date: '2026-07-28', stockDaily: 450, optionsDaily: 0 },
        ] },
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 68 },
          { date: '2026-07-28', stockDaily: 68, optionsDaily: 0 },
        ] },
      ],
    }).verdict,
    'LIVE_LAG',
  );

  // ── TRA-2630 AC2 DELTA ────────────────────────────────────────────────────
  // The pre-fix baseline: 18 rows on 07-28/07-29 that CANNOT clear. Grading AC2
  // as an absolute reports these as a red on a fix that works.
  const PREFIX_BASELINE = [
    { username: 'Richard', mode: 'demo', days: [
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
      { date: '2026-07-28', stockDaily: 67.5, optionsDaily: 22.5 },
      { date: '2026-07-29', stockDaily: 22.5, optionsDaily: -5.11 },
    ] },
  ];

  check(
    'AC2: pre-fix lag rows are EXCLUDED from the delta',
    gradeAc2Delta(PREFIX_BASELINE, '2026-07-30').rows,
    0,
  );

  // THE ONE THAT MATTERS. 0 new lag rows, but no session on/after the cutoff —
  // the 21:30 ET grader firing before the 21:00 ET writer landed a row. A
  // two-state verdict calls this a pass; it measured nothing.
  check(
    'AC2: no post-fix session at all => BLIND, never PASS',
    gradeAc2Delta(PREFIX_BASELINE, '2026-07-30').verdict,
    'BLIND',
  );

  // A post-fix row EXISTS but its prior optionsDaily is 0.00 — the predicate has
  // no failing state on it, so it is still not evidence. 7 of the 13 lagging
  // books are in exactly this state.
  check(
    'AC2: post-fix row with a ZERO prior is still BLIND, not PASS',
    gradeAc2Delta([
      { username: 'qa_zero', mode: 'demo', days: [
        { date: '2026-07-29', stockDaily: 0, optionsDaily: 0 },
        { date: '2026-07-30', stockDaily: 0, optionsDaily: 0 },
      ] },
    ], '2026-07-30').verdict,
    'BLIND',
  );

  // A genuine pass: the prior carried 250.01, so the hypothesis predicted
  // stockDaily == 250.01 and the observation refuted it.
  check(
    'AC2: post-fix row with a non-zero prior that does NOT lag => PASS',
    gradeAc2Delta([
      { username: 'admin', mode: 'live', days: [
        { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 250.01 },
        { date: '2026-07-30', stockDaily: -3.4, optionsDaily: 12 },
      ] },
    ], '2026-07-30').verdict,
    'PASS',
  );

  // The real-money falsifier, spelled exactly as the routine pins it.
  check(
    'AC2: admin 07-30 stockDaily == 250.01 => FAIL with a live row',
    (() => {
      const r = gradeAc2Delta([
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 250.01 },
          { date: '2026-07-30', stockDaily: 250.01, optionsDaily: 0 },
        ] },
      ], '2026-07-30');
      return [r.verdict, r.rows, r.liveRows];
    })(),
    ['FAIL', 1, 1],
  );

  // A NEW demo lag must fail the delta even while the baseline rows sit above it.
  check(
    'AC2: a new demo lag on 07-30 => FAIL, and is not masked by the baseline',
    (() => {
      const r = gradeAc2Delta([
        ...PREFIX_BASELINE,
        { username: 'qa_new', mode: 'demo', days: [
          { date: '2026-07-29', stockDaily: 0, optionsDaily: 42 },
          { date: '2026-07-30', stockDaily: 42, optionsDaily: 0 },
        ] },
      ], '2026-07-30');
      return [r.verdict, r.rows, r.liveRows];
    })(),
    ['FAIL', 1, 0],
  );

  // The gradeable count is a DENOMINATOR, not a book count: a book with a
  // post-fix row but a zero prior must not inflate it.
  check(
    'AC2: gradeableBookCount counts only books whose post-fix prior is non-zero',
    (() => {
      const r = gradeAc2Delta([
        { username: 'qa_zero', mode: 'demo', days: [
          { date: '2026-07-29', stockDaily: 0, optionsDaily: 0 },
          { date: '2026-07-30', stockDaily: 0, optionsDaily: 0 },
        ] },
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 250.01 },
          { date: '2026-07-30', stockDaily: -3.4, optionsDaily: 12 },
        ] },
      ], '2026-07-30');
      return [r.rowBookCount, r.gradeableBookCount];
    })(),
    [2, 1],
  );

  check(
    'demo-only hits grade DEMO_LAG, not LIVE_LAG',
    gradePayload({
      engines: [
        { username: 'qa_x', mode: 'demo', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 450 },
          { date: '2026-07-28', stockDaily: 450, optionsDaily: 0 },
        ] },
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 140 },
          { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68 },
        ] },
      ],
    }).verdict,
    'DEMO_LAG',
  );

  // TRA-2630 AC2 — THE GRADEABLE COHORT (the denominator). These four are the
  // controls the CLEAN path was missing: a live book present but never gradeable
  // used to read CLEAN, which is "0 hits over 0 chances to hit".
  check(
    'gradeable dates require a NON-ZERO prior optionsDaily',
    findPriorOptionsLagGradeableDates([
      { date: '2026-07-27', stockDaily: 0, optionsDaily: 0 },
      { date: '2026-07-28', stockDaily: 25, optionsDaily: 68 },
      { date: '2026-07-29', stockDaily: 0, optionsDaily: 0 },
    ]),
    // 07-28's prior is 0.00 -> not gradeable; 07-29's prior is 68 -> gradeable.
    ['2026-07-29'],
  );
  check(
    'a session whose prior had options P&L is gradeable even when it PASSES (stockDaily 0)',
    findPriorOptionsLagGradeableDates([
      { date: '2026-07-28', stockDaily: 0, optionsDaily: 250.01 },
      { date: '2026-07-29', stockDaily: 0, optionsDaily: 0 },
    ]),
    ['2026-07-29'],
  );
  check(
    'a live book with NO gradeable session is LIVE_UNMEASURABLE, not CLEAN',
    gradePayload({
      engines: [
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 0 },
          { date: '2026-07-28', stockDaily: 0, optionsDaily: 0 },
        ] },
      ],
    }).verdict,
    'LIVE_UNMEASURABLE',
  );
  check(
    'a live book WITH a gradeable session that passes is CLEAN',
    gradePayload({
      engines: [
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-28', stockDaily: 0, optionsDaily: 250.01 },
          { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 0 },
        ] },
      ],
    }).verdict,
    'CLEAN',
  );
  // A red live book must still outrank an ungradeable cohort — red beats unmeasured.
  check(
    'a LIVE hit still outranks an ungradeable second live book',
    gradePayload({
      engines: [
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 68 },
          { date: '2026-07-28', stockDaily: 68, optionsDaily: 0 },
        ] },
        { username: 'admin2', mode: 'live', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 0 },
          { date: '2026-07-28', stockDaily: 0, optionsDaily: 0 },
        ] },
      ],
    }).verdict,
    'LIVE_LAG',
  );

  // FAILS CLOSED — AN EMPTY LIVE COHORT IS BLIND, NEVER CLEAN OR DEMO_LAG.
  // This is the bqb1 2026-07-30T05:16Z state: 58 demo books, 0 live, because the
  // boot-arm left `bootArmDrift: ['mode']`. The pre-fix code read `true` here.
  check(
    'an all-demo fleet with NO lag is LIVE_UNMEASURABLE, not CLEAN',
    gradePayload({
      engines: [
        { username: 'qa_x', mode: 'demo', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 140 },
          { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68 },
        ] },
      ],
    }).verdict,
    'LIVE_UNMEASURABLE',
  );

  check(
    'an all-demo fleet WITH demo lag is LIVE_UNMEASURABLE, not DEMO_LAG',
    gradePayload({
      engines: [
        { username: 'Richard', mode: 'demo', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
          { date: '2026-07-28', stockDaily: 67.5, optionsDaily: 22.5 },
        ] },
      ],
    }).verdict,
    'LIVE_UNMEASURABLE',
  );

  // POSITIVE CONTROL for the same predicate — the ONLY difference from the case
  // above is that a live book exists and is clean. Without this pair the new
  // verdict could be hardwired on and nothing would notice.
  check(
    'the SAME demo lag grades DEMO_LAG once one clean live book is present',
    gradePayload({
      engines: [
        { username: 'Richard', mode: 'demo', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5 },
          { date: '2026-07-28', stockDaily: 67.5, optionsDaily: 22.5 },
        ] },
        { username: 'admin', mode: 'live', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 140 },
          { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68 },
        ] },
      ],
    }).verdict,
    'DEMO_LAG',
  );

  // `sandbox` is a THIRD mode (stockModeKey: 'demo' | 'live' | 'sandbox'). A book
  // armed live but pointed at the Tradier sandbox routes paper fills, so it is
  // correctly OUTSIDE the real-money tripwire — and it must not be mistaken for
  // live coverage either.
  check(
    'a sandbox-mode book does NOT satisfy the live cohort',
    gradePayload({
      engines: [
        { username: 'admin', mode: 'sandbox', days: [
          { date: '2026-07-27', stockDaily: 0, optionsDaily: 140 },
          { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68 },
        ] },
      ],
    }).verdict,
    'LIVE_UNMEASURABLE',
  );

  check(
    'liveBookCount counts only mode:live',
    gradePayload({
      engines: [
        { username: 'a', mode: 'demo', days: [] },
        { username: 'b', mode: 'sandbox', days: [] },
        { username: 'c', mode: 'live', days: [] },
      ],
    }).liveBookCount,
    1,
  );

  // FAILS CLOSED — an empty payload is BLIND, never CLEAN.
  check('an engine-less payload is BLIND, not CLEAN', gradePayload({ engines: [] }).verdict, 'BLIND');
  check('a malformed payload is BLIND, not CLEAN', gradePayload({}).verdict, 'BLIND');

  // ABSENCE IS NOT A PASS — a pre-TRA-2630 payload must report the per-leg
  // fields as NOT MEASURED, never as 0 offending.
  check(
    'per-leg fields absent ⇒ present:0, NOT a clean count',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68, drift: 0.94 },
      ] }],
    }),
    {
      graded: 1, present: 0, stockBad: 0, optionsBad: 0, maxStock: 0, maxOptions: 0,
      stockMeasurable: 0, stockLegOk: null,
      optionsMeasurable: 0, optionsSlaved: 0, optionsLegOk: null,
    },
  );

  // TRA-2633 — the stock leg is structurally zero, so a red count there is a
  // restatement of `stockDaily`, not a defect. This is the LIVE shape: the row
  // carries a non-zero equity delta and an `eodStockPnl` the archive race zeroed.
  check(
    'stock leg with a ZEROED eodStockPnl ⇒ stockLegOk null (NOT MEASURED), not false',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-28', stockDaily: 22.5, eodStockPnl: 0, stockLegDrift: -22.5, optionsLegDrift: 0 },
      ] }],
    }),
    {
      graded: 1, present: 1, stockBad: 1, optionsBad: 0, maxStock: 22.5, maxOptions: 0,
      stockMeasurable: 0, stockLegOk: null,
      // TRA-2641 — was `optionsLegOk: true`. This row carries NO `eodOptionsPnl`,
      // so there was never a second operand: the old green graded nothing.
      optionsMeasurable: 0, optionsSlaved: 0, optionsLegOk: null,
    },
  );

  // MUTATION — if `eodStockPnl` is ever genuinely reported, the leg becomes
  // measurable and MUST go back to a hard boolean. Guards against "always null".
  check(
    'MUTATION: a non-zero eodStockPnl makes the stock leg measurable again ⇒ false',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-28', stockDaily: 22.5, eodStockPnl: 10, stockLegDrift: -12.5, optionsLegDrift: 0 },
      ] }],
    }),
    {
      graded: 1, present: 1, stockBad: 1, optionsBad: 0, maxStock: 12.5, maxOptions: 0,
      stockMeasurable: 1, stockLegOk: false,
      optionsMeasurable: 0, optionsSlaved: 0, optionsLegOk: null,
    },
  );

  // The gradeable leg must stay falsifiable in BOTH directions.
  check(
    'options leg over tolerance ⇒ optionsLegOk false, even with an EMPTY denominator',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-17', stockDaily: 0, eodStockPnl: 0, stockLegDrift: 0, optionsLegDrift: 217.5 },
      ] }],
    }),
    {
      graded: 1, present: 1, stockBad: 0, optionsBad: 1, maxStock: 0, maxOptions: 217.5,
      stockMeasurable: 0, stockLegOk: null,
      // RED outranks NOT MEASURED. `optionsMeasurable` is 0 here, and the verdict
      // is STILL false — an offending row is a real defect (the sync writer failed)
      // and must never be swallowed by the empty-denominator null.
      optionsMeasurable: 0, optionsSlaved: 0, optionsLegOk: false,
    },
  );

  // ── TRA-2641 — the options leg is SELF-CONFIRMING on journal-slaved rows.
  // This is the live shape: `syncEodReportOptionsLegs` wrote the day cell into
  // the report file, so the two legs agree BY CONSTRUCTION. A boolean rendered
  // this as a green, and it flipped false→true across the TRA-2641 deploy, which
  // reads as "the defect was fixed".
  check(
    'TRA-2641: a journal-slaved row is NOT independent evidence ⇒ NOT MEASURED, not green',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        {
          date: '2026-07-29', stockDaily: -17.87, optionsDaily: 250.01,
          eodStockPnl: 0, eodOptionsPnl: 250.01,
          optionsDailyPnlSource: 'journal-repair',
          stockLegDrift: 17.87, optionsLegDrift: 0,
        },
      ] }],
    }),
    {
      graded: 1, present: 1, stockBad: 1, optionsBad: 0, maxStock: 17.87, maxOptions: 0,
      stockMeasurable: 0, stockLegOk: null,
      optionsMeasurable: 0, optionsSlaved: 1, optionsLegOk: null,
    },
  );

  // MUTATION — the SAME agreeing legs on a row the journal is NOT authority for.
  // Nothing overwrote the file there, so agreement is real evidence and the
  // verdict must return to a hard boolean. Guards against "always null".
  check(
    'MUTATION: an UNSLAVED row with agreeing legs is real evidence ⇒ true',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        {
          date: '2026-07-29', stockDaily: 0, optionsDaily: 250.01,
          eodStockPnl: 0, eodOptionsPnl: 250.01,
          optionsDailyPnlSource: 'bucket-journal-silent',
          stockLegDrift: 0, optionsLegDrift: 0,
        },
      ] }],
    }),
    {
      graded: 1, present: 1, stockBad: 0, optionsBad: 0, maxStock: 0, maxOptions: 0,
      stockMeasurable: 0, stockLegOk: null,
      optionsMeasurable: 1, optionsSlaved: 0, optionsLegOk: true,
    },
  );

  // The OTHER vacuous-pass arm: unslaved, both legs present, both 0.00. Agreement
  // between two zeroes is not evidence the reconciliation works — the same rule
  // that killed `stockLegOk`. 20 of the 167 live post-baseline rows are this shape.
  check(
    'TRA-2641: an UNSLAVED row with 0.00 on BOTH legs is vacuous ⇒ NOT MEASURED',
    summarizeLegs({
      engines: [{ username: 'admin', mode: 'live', days: [
        {
          date: '2026-07-13', stockDaily: 0, optionsDaily: 0,
          eodStockPnl: 0, eodOptionsPnl: 0,
          optionsDailyPnlSource: null,
          stockLegDrift: 0, optionsLegDrift: 0,
        },
      ] }],
    }),
    {
      graded: 1, present: 1, stockBad: 0, optionsBad: 0, maxStock: 0, maxOptions: 0,
      stockMeasurable: 0, stockLegOk: null,
      optionsMeasurable: 0, optionsSlaved: 0, optionsLegOk: null,
    },
  );

  // THE DISCRIMINATOR for this defect: the two states that a boolean rendered
  // IDENTICALLY. Same agreeing legs, same 0.00 drift, opposite verdicts — and the
  // only difference is whether a writer joined the operands.
  check(
    'THE DISCRIMINATOR: slaved vs unslaved agreement give OPPOSITE verdicts',
    [
      summarizeLegs({ engines: [{ username: 'a', mode: 'demo', days: [{
        date: '2026-07-29', stockDaily: 0, optionsDaily: 42, eodOptionsPnl: 42,
        optionsDailyPnlSource: 'journal', stockLegDrift: 0, optionsLegDrift: 0,
      }] }] }).optionsLegOk,
      summarizeLegs({ engines: [{ username: 'a', mode: 'demo', days: [{
        date: '2026-07-29', stockDaily: 0, optionsDaily: 42, eodOptionsPnl: 42,
        optionsDailyPnlSource: 'bucket-no-census', stockLegDrift: 0, optionsLegDrift: 0,
      }] }] }).optionsLegOk,
    ],
    [null, true],
  );

  // A book with no lag at all contributes nothing.
  check(
    'a fully clean payload grades CLEAN',
    gradePayload({
      engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-27', stockDaily: 12.5, optionsDaily: 68 },
        { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 22.5 },
      ] }],
    }).verdict,
    'CLEAN',
  );

  // ── TRA-2635 — the CREDIT axis. Both directions, plus all three NOT-MEASURED
  // states, because each of them would have been rendered green by a boolean.
  // `closingEquity` defaults to 2_000 (FLAT). On a session that realized option
  // P&L, flat equity is itself a shortfall — which is the point of the state axis —
  // so any fixture meant to read CREDIT_OK must pass a growing `closingEquity`.
  const liveDay = (date, optionsDaily, optionsCreditedCumulative, extra = {}) => ({
    date, stockDaily: 0, optionsDaily, closingEquity: 2_000, ...extra,
    ...(optionsCreditedCumulative === undefined ? {} : { optionsCreditedCumulative }),
  });

  check(
    'CREDIT: a live book whose counter never moved off zero is LIVE_CREDIT_UNSHIPPED',
    gradeCreditObservation({
      engines: [{ username: 'admin', mode: 'live', days: [
        liveDay('2026-07-28', 450, 0),
        liveDay('2026-07-29', 537.6, 0),
      ] }],
    }).verdict,
    'LIVE_CREDIT_UNSHIPPED',
  );

  // POSITIVE CONTROL for the SAME rows — only the counter differs. Without this
  // pair the verdict could be hardwired red and nothing would notice.
  check(
    'CREDIT: the SAME sessions with a moving counter grade CREDIT_OK',
    gradeCreditObservation({
      engines: [{ username: 'admin', mode: 'live', days: [
        liveDay('2026-07-28', 450, 450, { closingEquity: 2_450 }),
        liveDay('2026-07-29', 537.6, 987.6, { closingEquity: 2_987.6 }),
      ] }],
    }).verdict,
    'CREDIT_OK',
  );

  check(
    'CREDIT: an EMPTY live cohort is NO_LIVE_BOOK, never CREDIT_OK',
    gradeCreditObservation({
      engines: [{ username: 'Richard', mode: 'demo', days: [liveDay('2026-07-28', 450, 0)] }],
    }).verdict,
    'NO_LIVE_BOOK',
  );

  check(
    'CREDIT: a build serving no counter is FIELD_ABSENT, never CREDIT_OK',
    gradeCreditObservation({
      engines: [{ username: 'admin', mode: 'live', days: [
        liveDay('2026-07-28', 450, undefined, { closingEquity: 2_450 }),
        liveDay('2026-07-29', 537.6, undefined, { closingEquity: 2_987.6 }),
      ] }],
    }).verdict,
    'FIELD_ABSENT',
  );

  check(
    'CREDIT: a live book that realized no option P&L is UNMEASURABLE, never CREDIT_OK',
    gradeCreditObservation({
      engines: [{ username: 'admin', mode: 'live', days: [
        liveDay('2026-07-28', 0, 0),
        liveDay('2026-07-29', 0, 0),
      ] }],
    }).verdict,
    'UNMEASURABLE',
  );

  check(
    'CREDIT: pre-baseline sessions do not grade the bridge (it did not exist)',
    gradeCreditObservation({
      engines: [{ username: 'admin', mode: 'live', days: [
        liveDay('2026-07-01', 450, 0, { belowBaseline: true }),
      ] }],
    }).verdict,
    'UNMEASURABLE',
  );

  check(
    'CREDIT: a sandbox-armed book does NOT satisfy the live cohort',
    gradeCreditObservation({
      engines: [{ username: 'admin', mode: 'sandbox', days: [liveDay('2026-07-28', 450, 0)] }],
    }).verdict,
    'NO_LIVE_BOOK',
  );

  // THE WHOLE POINT — identical delta rows, identical lag verdict, opposite
  // credit verdict. This is the pair the retracted grade could not tell apart.
  // THE CORRECTION, found on the first live pull of the new field (07:48Z).
  check(
    'CREDIT: a zero counter on a NON-DURABLE book is NOT a red on the counter axis',
    (() => {
      // Richard's live shape, promoted to mode:live so the cohort is non-empty.
      const p = { engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-27', stockDaily: 0, optionsDaily: 67.5, optionsCreditedCumulative: 0, closingEquity: 2233.91 },
        { date: '2026-07-28', stockDaily: 67.5, optionsDaily: 22.5, optionsCreditedCumulative: 0, closingEquity: 2301.41 },
        { date: '2026-07-29', stockDaily: 22.5, optionsDaily: -5.11, optionsCreditedCumulative: 0, closingEquity: 2323.91 },
      ] }] };
      const c = gradeCreditObservation(p);
      return { counterDurable: c.books[0].counterDurable, absorbed: c.books[0].absorbed };
    })(),
    { counterDurable: false, absorbed: null },
  );

  // ── TRA-2658: the FROZEN counter ────────────────────────────────────────────
  // Both directions, because the failing arm is the whole finding: the pre-fix
  // predicate reported a CLEAN durability grade on this exact live shape.
  check(
    'CREDIT/TRA-2658: a counter FROZEN at 0 is NOT durable (the pre-fix predicate said it was)',
    (() => {
      // `admin` off bqb1 2026-07-30T14:08:29Z, promoted to mode:live so the cohort
      // is non-empty (it resolved `demo` on that boot — the TRA-2649 boot-arm flap).
      // Neither reset signature fires here: no lag session, no negative window.
      const p = { engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-27', stockDaily: 0, optionsDaily: 140, optionsCreditedCumulative: 0, closingEquity: 2008.29 },
        { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68, optionsCreditedCumulative: 0, closingEquity: 2147.35 },
        { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 250.01, optionsCreditedCumulative: 0, closingEquity: 2243.48 },
      ] }] };
      const b = gradeCreditObservation(p).books[0];
      return {
        counterDurable: b.counterDurable,
        resets: b.counterResetDates,
        frozen: b.counterFrozenDates,
        maxMove: b.maxUnbookedMoveUsd,
      };
    })(),
    {
      counterDurable: false,
      resets: [],
      frozen: [{ date: '2026-07-28', move: 140 }, { date: '2026-07-29', move: 114 }],
      maxMove: 140,
    },
  );

  check(
    'CREDIT/TRA-2658: a continuously-run book is DURABLE — the passing state is reachable',
    (() => {
      const p = { engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-28', stockDaily: 10, optionsDaily: 40, optionsCreditedCumulative: 100, closingEquity: 2100 },
        { date: '2026-07-29', stockDaily: 10, optionsDaily: 40, optionsCreditedCumulative: 150, closingEquity: 2160 },
      ] }] };
      const b = gradeCreditObservation(p).books[0];
      return { counterDurable: b.counterDurable, frozen: b.counterFrozenDates, absorbed: b.absorbed };
    })(),
    { counterDurable: true, frozen: [], absorbed: true },
  );

  check(
    'CREDIT/TRA-2658: a starting-balance edit is an un-booked move but NOT a frozen counter',
    (() => {
      // No option P&L in the window, so nothing attributes the move to a lost
      // credit. Visible on `unbookedMoveDates`, absent from the verdict.
      const p = { engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-28', stockDaily: 0, optionsDaily: 40, optionsCreditedCumulative: 100, closingEquity: 2000 },
        { date: '2026-07-29', stockDaily: 0, optionsDaily: 0, optionsCreditedCumulative: 100, closingEquity: 3000 },
      ] }] };
      const b = gradeCreditObservation(p).books[0];
      return {
        counterDurable: b.counterDurable,
        frozen: b.counterFrozenDates,
        unbooked: b.unbookedMoveDates,
      };
    })(),
    {
      counterDurable: true,
      frozen: [],
      unbooked: [{ date: '2026-07-29', move: 1000 }],
    },
  );

  check(
    'CREDIT/TRA-2658: a freeze spanning MANY sessions stays inside the cumulative ceiling',
    (() => {
      // The ceiling must be cumulative, not per-window. Here 07-27 realized 500
      // and the whole 500 arrives as one un-booked move two sessions later; a
      // per-window bound (prev 0 + cur 0) would clear it — clearing exactly the
      // longest freezes, which are the worst ones.
      const p = { engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-27', stockDaily: 0, optionsDaily: 500, optionsCreditedCumulative: 0, closingEquity: 2000 },
        { date: '2026-07-28', stockDaily: 0, optionsDaily: 0, optionsCreditedCumulative: 0, closingEquity: 2000 },
        { date: '2026-07-29', stockDaily: 0, optionsDaily: 0, optionsCreditedCumulative: 0, closingEquity: 2500 },
      ] }] };
      const b = gradeCreditObservation(p).books[0];
      return { counterDurable: b.counterDurable, frozen: b.counterFrozenDates };
    })(),
    { counterDurable: false, frozen: [{ date: '2026-07-29', move: 500 }] },
  );

  // ── TRA-2630 AC3: the frozen axis as its own VERDICT ────────────────────────
  // THE HOLE, pinned. `counterFrozenDates` existed but was printed only from
  // inside `reportCreditUnshipped`, so it was readable only while the credit axis
  // was already failing. This fixture is the state the credit REPAIR produces: the
  // counter moved once (so `absorbed: true`), the money is all in `closingEquity`
  // (so `uncredited: 0`, no shortfall) — and $60 of it is recorded in no row.
  const FROZEN_BUT_CREDIT_OK = { engines: [{ username: 'admin', mode: 'live', days: [
    { date: '2026-07-27', stockDaily: 0, optionsDaily: 100, optionsCreditedCumulative: 100, closingEquity: 2000 },
    { date: '2026-07-28', stockDaily: 0, optionsDaily: 60, optionsCreditedCumulative: 100, closingEquity: 2000 },
    { date: '2026-07-29', stockDaily: 0, optionsDaily: 0, optionsCreditedCumulative: 100, closingEquity: 2060 },
  ] }] };

  check(
    'AC3/FROZEN: the credit axis reads CREDIT_OK on a book whose counter is frozen',
    (() => {
      const c = gradeCreditObservation(FROZEN_BUT_CREDIT_OK);
      return {
        verdict: c.verdict,
        shortfall: c.shortfall.length,
        frozen: c.books[0].counterFrozenDates.map((r) => r.date),
      };
    })(),
    { verdict: 'CREDIT_OK', shortfall: 0, frozen: ['2026-07-29'] },
  );

  check(
    'AC3/FROZEN: the frozen axis fires anyway — it no longer rides on the credit verdict',
    gradeLiveCounterFreeze(gradeCreditObservation(FROZEN_BUT_CREDIT_OK)).verdict,
    'FROZEN',
  );

  check(
    'AC3/FROZEN: the lag predicate is BLIND to it — stockDaily never equals prior optionsDaily',
    findPriorOptionsLagDates(FROZEN_BUT_CREDIT_OK.engines[0].days).length,
    0,
  );

  // The PASSING state must be reachable, or this is just another permanent red.
  check(
    'AC3/FROZEN: a continuously-run live book grades CLEAN, with a published denominator',
    (() => {
      const p = { engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-28', stockDaily: 10, optionsDaily: 40, optionsCreditedCumulative: 100, closingEquity: 2100 },
        { date: '2026-07-29', stockDaily: 10, optionsDaily: 40, optionsCreditedCumulative: 150, closingEquity: 2160 },
      ] }] };
      const f = gradeLiveCounterFreeze(gradeCreditObservation(p));
      return { verdict: f.verdict, denom: f.gradeableBookCount };
    })(),
    { verdict: 'CLEAN', denom: 1 },
  );

  // ...and the empty cohort must NOT read as that CLEAN. Same `every`-on-empty
  // trap the whole ticket is about, one axis further in.
  check(
    'AC3/FROZEN: 0 live books is NOT MEASURED, not CLEAN',
    (() => {
      const p = { engines: [{ username: 'Richard', mode: 'demo', days: [
        { date: '2026-07-29', stockDaily: 0, optionsDaily: 40, optionsCreditedCumulative: 0, closingEquity: 2000 },
      ] }] };
      const f = gradeLiveCounterFreeze(gradeCreditObservation(p));
      return { verdict: f.verdict, denom: f.gradeableBookCount };
    })(),
    { verdict: 'NOT_MEASURED', denom: 0 },
  );

  // The DELTA boundary on the frozen axis. Without it AC2 can never go green:
  // admin's frozen sessions are 07-28/07-29, both written before `ec05639` landed
  // (2026-07-30T04:10:50Z), and `counterFrozenDates` is an absolute over history.
  // A permanently-red gate is exactly as uninformative as the permanently-green
  // one this ticket was filed about.
  const ADMIN_FROZEN_DAYS = [
    { date: '2026-07-27', stockDaily: 0, optionsDaily: 140, optionsCreditedCumulative: 0, closingEquity: 2008.29 },
    { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 68, optionsCreditedCumulative: 0, closingEquity: 2147.35 },
    { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 250.01, optionsCreditedCumulative: 0, closingEquity: 2243.48 },
  ];

  check(
    'AC2/TRA-2658: the PRE-FIX frozen rows are the baseline and do NOT fail the delta',
    (() => {
      const a = gradeAc2Delta(
        [{ username: 'admin', mode: 'live', days: ADMIN_FROZEN_DAYS }],
        '2026-07-30',
      );
      return { verdict: a.verdict, frozenRows: a.frozenRows };
    })(),
    // BLIND, not PASS: no gradeable session on/after the cutoff yet. Absence is
    // never a pass here — but crucially it is not a FAIL off history either.
    { verdict: 'BLIND', frozenRows: 0 },
  );

  check(
    'AC2/TRA-2658: a NEW frozen session written under the deployed fix is a FAIL',
    (() => {
      const a = gradeAc2Delta(
        [{ username: 'admin', mode: 'live', days: [
          ...ADMIN_FROZEN_DAYS,
          // 07-30 closes with equity up 204.01 and the counter still recording 0.
          // 204.01 is what the pool can actually fund: of the 458.01 realized
          // 07-27..07-29, 254.00 was already attributed to the 07-28/07-29 freezes,
          // leaving 204.01 of 07-29's 250.01 still uncredited. A larger figure would
          // be an arithmetically impossible credit and the pool correctly refuses it.
          { date: '2026-07-30', stockDaily: 0, optionsDaily: 10, optionsCreditedCumulative: 0, closingEquity: 2447.49 },
        ] }],
        '2026-07-30',
      );
      return { verdict: a.verdict, frozenRows: a.frozenRows, liveFrozenRows: a.liveFrozenRows };
    })(),
    { verdict: 'FAIL', frozenRows: 1, liveFrozenRows: 1 },
  );

  check(
    'AC2/TRA-2658: a post-fix session that RECORDS its credit passes the delta',
    (() => {
      const a = gradeAc2Delta(
        [{ username: 'admin', mode: 'live', days: [
          ...ADMIN_FROZEN_DAYS,
          // The fixed writer: the SAME +204.01 of equity as the FAIL arm above, and
          // the counter records exactly it. Identical money, opposite verdict — that
          // is the discrimination this axis exists to make.
          { date: '2026-07-30', stockDaily: 0, optionsDaily: 10, optionsCreditedCumulative: 204.01, closingEquity: 2447.49 },
        ] }],
        '2026-07-30',
      );
      return { verdict: a.verdict, frozenRows: a.frozenRows };
    })(),
    { verdict: 'PASS', frozenRows: 0 },
  );

  check(
    'CREDIT/TRA-2658: a FULLY CREDITED book cannot produce a frozen claim — the pool is empty',
    (() => {
      // 1,000 realized and 1,000 recorded, then a +50 starting-balance edit. Under
      // a bare "<= cumulative realized" ceiling the 50 fits and gets accused; the
      // pool is 0 because the counter already accounted for every cent.
      const p = { engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-27', stockDaily: 0, optionsDaily: 1000, optionsCreditedCumulative: 0, closingEquity: 2000 },
        { date: '2026-07-28', stockDaily: 0, optionsDaily: 0, optionsCreditedCumulative: 1000, closingEquity: 3000 },
        { date: '2026-07-29', stockDaily: 0, optionsDaily: 0, optionsCreditedCumulative: 1000, closingEquity: 3050 },
      ] }] };
      const b = gradeCreditObservation(p).books[0];
      return {
        counterDurable: b.counterDurable,
        frozen: b.counterFrozenDates,
        unbooked: b.unbookedMoveDates,
      };
    })(),
    { counterDurable: true, frozen: [], unbooked: [{ date: '2026-07-29', move: 50 }] },
  );

  check(
    'CREDIT/TRA-2658: the frozen signature does not manufacture a verdict on a book with no counter',
    (() => {
      const p = { engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-28', stockDaily: 0, optionsDaily: 60, closingEquity: 2000 },
        { date: '2026-07-29', stockDaily: 0, optionsDaily: 0, closingEquity: 2060 },
      ] }] };
      const b = gradeCreditObservation(p).books[0];
      return { counterDurable: b.counterDurable, frozen: b.counterFrozenDates.map((r) => r.date) };
    })(),
    { counterDurable: null, frozen: ['2026-07-29'] },
  );

  check(
    'CREDIT: the STATE measurement escalates even when the counter axis is NOT MEASURED',
    (() => {
      // The LIVE admin numbers: equity +235.19, options +987.60, stock -18.81.
      const p = { engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-13', stockDaily: 0, optionsDaily: 0, closingEquity: 2008.29 },
        { date: '2026-07-27', stockDaily: 0, optionsDaily: 737.6, optionsCreditedCumulative: 0, closingEquity: 2008.29 },
        { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 0, optionsCreditedCumulative: 0, closingEquity: 2147.35 },
        { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 250, optionsCreditedCumulative: 0, closingEquity: 2243.48 },
      ] }] };
      const c = gradeCreditObservation(p);
      return { verdict: c.verdict, uncredited: c.books[0].uncredited, growth: c.books[0].equityGrowth };
    })(),
    { verdict: 'LIVE_CREDIT_UNSHIPPED', uncredited: 733.6, growth: 235.19 },
  );

  // POSITIVE CONTROL — a book whose credit fully reached NAV must read ~0 shortfall
  // and CREDIT_OK. Without this the shortfall path could be permanently red.
  check(
    'CREDIT: a fully-credited book has no shortfall and grades CREDIT_OK',
    (() => {
      const p = { engines: [{ username: 'admin', mode: 'live', days: [
        { date: '2026-07-27', stockDaily: 0, optionsDaily: 0, optionsCreditedCumulative: 0, closingEquity: 2000 },
        { date: '2026-07-28', stockDaily: -10, optionsDaily: 100, optionsCreditedCumulative: 100, closingEquity: 2090 },
      ] }] };
      const c = gradeCreditObservation(p);
      return { verdict: c.verdict, uncredited: c.books[0].uncredited };
    })(),
    { verdict: 'CREDIT_OK', uncredited: 0 },
  );

  check(
    'THE DISCRIMINATOR: same lag verdict (CLEAN) on both, opposite credit verdict',
    (() => {
      // Same DELTA rows on both. Only the STATE differs: the credited book's
      // equity grew by the credit, the uncredited book's did not.
      const mk = (c1, c2, eq1, eq2) => ({ engines: [{ username: 'admin', mode: 'live', days: [
        liveDay('2026-07-28', 450, c1, { closingEquity: eq1 }),
        liveDay('2026-07-29', 537.6, c2, { closingEquity: eq2 }),
      ] }] });
      const credited = mk(450, 987.6, 2_450, 2_987.6);
      const uncredited = mk(0, 0, 2_000, 2_000);
      return {
        lagCredited: gradePayload(credited).verdict,
        lagUncredited: gradePayload(uncredited).verdict,
        creditCredited: gradeCreditObservation(credited).verdict,
        creditUncredited: gradeCreditObservation(uncredited).verdict,
      };
    })(),
    {
      lagCredited: 'CLEAN',
      lagUncredited: 'CLEAN',
      creditCredited: 'CREDIT_OK',
      creditUncredited: 'LIVE_CREDIT_UNSHIPPED',
    },
  );

  // TRA-2630 AC1 — controls for the DISCLAIMER guard. Both directions, because
  // "the disclaimer is present" and "this build predates the disclaimer" are the
  // two readings that must never collapse into one another.
  const TRA2630_NOTE = 'TRA-2630: `drift` pools a LOSSY stock leg …';
  check(
    'DISCLAIMER: both halves at the top level grade PRESENT',
    describeGradeabilityDisclaimer({
      ok: false, maxDriftUsd: 765, driftGradeable: false,
      ungradeableFields: ['ok', 'maxDriftUsd', 'engines[].drift'],
      caveats: ['unrelated caveat', TRA2630_NOTE],
    }).verdict,
    'PRESENT',
  );
  check(
    'DISCLAIMER: a pre-fix payload grades ABSENT, not PRESENT',
    // The exact shape bqb1 served before this fix: the note existed, but only
    // inside each engine. A guard that searched `engines[i].caveats` would have
    // called this closed.
    describeGradeabilityDisclaimer({
      ok: false, maxDriftUsd: 765,
      engines: [{ username: 'admin', caveats: [TRA2630_NOTE] }],
    }).verdict,
    'ABSENT',
  );
  check(
    'DISCLAIMER: flag without caveats, and caveats without flag, are both PARTIAL',
    {
      flagOnly: describeGradeabilityDisclaimer({ driftGradeable: false }).verdict,
      caveatsOnly: describeGradeabilityDisclaimer({ caveats: [TRA2630_NOTE] }).verdict,
    },
    { flagOnly: 'PARTIAL', caveatsOnly: 'PARTIAL' },
  );
  check(
    'DISCLAIMER: a payload CLAIMING the pooled metric is gradeable is called out',
    describeGradeabilityDisclaimer({ driftGradeable: true, caveats: [TRA2630_NOTE] }).verdict,
    'CLAIMS GRADEABLE',
  );

  // TRA-2630 AC2 COHORT PIN — the failure this exists to catch is a PASS whose
  // denominator quietly shrank, so the controls have to drive the pass path.
  const cohortBooks = (names) => names.map((u) => ({ username: u, mode: u === 'admin' ? 'live' : 'demo', dates: [AC2_FIX_DEPLOY_DATE] }));
  const ALL_PINNED = AC2_EXPECTED_GRADEABLE_BOOKS.map((b) => b.username);
  check(
    'COHORT: every pinned book present reads INTACT',
    compareAc2Cohort(cohortBooks(ALL_PINNED), AC2_FIX_DEPLOY_DATE).verdict,
    'INTACT',
  );
  check(
    'COHORT: a book that newly became eligible is `extra`, not a defect',
    (() => {
      const c = compareAc2Cohort(cohortBooks([...ALL_PINNED, 'qa_brand_new_book']), AC2_FIX_DEPLOY_DATE);
      return { verdict: c.verdict, extra: c.extra.map((b) => b.username) };
    })(),
    { verdict: 'INTACT', extra: ['qa_brand_new_book'] },
  );
  check(
    'COHORT: one pinned book missing reads SHRANK and NAMES it',
    (() => {
      const c = compareAc2Cohort(cohortBooks(ALL_PINNED.filter((u) => u !== 'enock')), AC2_FIX_DEPLOY_DATE);
      return { verdict: c.verdict, missing: c.missing.map((b) => b.username), observed: c.observedCount };
    })(),
    { verdict: 'SHRANK', missing: ['enock'], observed: 14 },
  );
  check(
    'COHORT: the LIVE book dropping out is SHRANK even with 14 demo books present',
    (() => {
      const c = compareAc2Cohort(cohortBooks(ALL_PINNED.filter((u) => u !== 'admin')), AC2_FIX_DEPLOY_DATE);
      return { verdict: c.verdict, missingLive: c.missing.filter((b) => b.mode === 'live').map((b) => b.username) };
    })(),
    { verdict: 'SHRANK', missingLive: ['admin'] },
  );
  check(
    'COHORT: a PASS over ONE surviving book is SHRANK, not a clean 15-book pass',
    (() => {
      const c = compareAc2Cohort(cohortBooks(['Richard']), AC2_FIX_DEPLOY_DATE);
      return { verdict: c.verdict, missing: c.missing.length, observed: c.observedCount };
    })(),
    { verdict: 'SHRANK', missing: 14, observed: 1 },
  );
  check(
    'COHORT: the pin does NOT decay — a later --since compares nothing',
    (() => {
      const c = compareAc2Cohort(cohortBooks(['Richard']), '2026-08-14');
      return { verdict: c.verdict, missing: c.missing.length };
    })(),
    { verdict: 'NOT_APPLICABLE', missing: 0 },
  );
  check(
    'COHORT: gradeAc2Delta carries the pin, and a shrunken PASS reports BOTH',
    (() => {
      const day = (date, sd, od) => ({ date, stockDaily: sd, optionsDaily: od });
      const g = gradeAc2Delta(
        [{ username: 'Richard', mode: 'demo', days: [day('2026-07-29', 0, -5.11), day('2026-07-30', 3.25, 0)] }],
        AC2_FIX_DEPLOY_DATE,
      );
      return { verdict: g.verdict, gradeable: g.gradeableBookCount, cohort: g.cohort.verdict };
    })(),
    { verdict: 'PASS', gradeable: 1, cohort: 'SHRANK' },
  );

  // PROVENANCE: a one-shot grade read off a stale checkout is the failure mode
  // `printAc2Provenance` exists to make detectable. These controls drive the real
  // printer and capture stdout, because the property under test IS the printed
  // text — asserting on a returned object would prove nothing about what a grader
  // actually reads. The line must appear on ALL THREE arms: the arm most likely to
  // be misread (BLIND) is the one a stale script would render as a bare PASS.
  const capturePrintAc2 = (ac2) => {
    const lines = [];
    const real = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      printAc2(ac2);
    } finally {
      console.log = real;
    }
    return lines.join('\n');
  };
  const day = (date, sd, od) => ({ date, stockDaily: sd, optionsDaily: od });
  const graded = (days) => gradeAc2Delta(
    [{ username: 'Richard', mode: 'demo', days }],
    AC2_FIX_DEPLOY_DATE,
  );
  const arms = {
    BLIND: graded([day('2026-07-29', 0, -5.11)]),
    PASS: graded([day('2026-07-29', 0, -5.11), day('2026-07-30', 3.25, 0)]),
    FAIL: graded([day('2026-07-29', 0, -5.11), day('2026-07-30', -5.11, 0)]),
  };
  for (const [arm, g] of Object.entries(arms)) {
    const out = capturePrintAc2(g);
    check(
      `PROVENANCE: the ${arm} arm carries the instrument-revision line`,
      { verdict: g.verdict, hasRev: out.includes(AC2_INSTRUMENT_REV), saysStaleIsBlind: /ABSENT[\s\S]*STALE[\s\S]*BLIND/.test(out) },
      { verdict: arm, hasRev: true, saysStaleIsBlind: true },
    );
  }
  check(
    'PROVENANCE: the line sits ABOVE the verdict, so a truncated read still shows it',
    (() => {
      const out = capturePrintAc2(arms.PASS).split('\n');
      const revAt = out.findIndex((l) => l.includes(AC2_INSTRUMENT_REV));
      const verdictAt = out.findIndex((l) => l.includes('PASS —'));
      return { revBeforeVerdict: revAt >= 0 && verdictAt >= 0 && revAt < verdictAt };
    })(),
    { revBeforeVerdict: true },
  );

  // ── TRA-2630 AC2 WRITER ATTRIBUTION ───────────────────────────────────────
  // The failure this arm exists for: a rollback serves the 21:00 ET write window,
  // the broken writer writes the row, a descendant build is redeployed before the
  // 21:30 grade, and `/api/health/version` reports the good SHA. Every control
  // below is driven in BOTH directions, because an attribution that can only ever
  // say CONFIRMED is decoration.
  const dep = (sha, finishedAt, status = 'deactivated') => ({ id: `dep-${sha}`, status, finishedAt, commit: { id: sha } });
  // 2026-07-30 21:00 ET == 2026-07-31T01:00Z, so the window is 00:00Z..01:45Z.
  const GOOD = 'fffffff000';
  const BAD = 'aaaaaaa000';
  // The routine grades at 21:30 ET == 01:30Z, half an hour after the write.
  const GRADE_AT = '2026-07-31T01:30:00Z';
  const descendantOnly = (sha) => (sha === GOOD ? true : sha === BAD ? false : null);

  check(
    'WRITER: the write instant for a graded date is 21:00 ET, i.e. 01:00Z next day',
    eodWriteInstant('2026-07-30'),
    '2026-07-31T01:00:00.000Z',
  );
  check(
    'WRITER: a build serving the whole window and descended from the fix => CONFIRMED',
    gradeWriterProvenance({
      deploys: [dep(GOOD, '2026-07-30T12:10:24Z', 'live')],
      isDescendant: descendantOnly, gradedDate: '2026-07-30', now: GRADE_AT,
    }).verdict,
    'CONFIRMED',
  );
  // THE ONE THAT MATTERS. The rollback served 00:30Z-01:20Z, i.e. across the write,
  // and the good build was back before the grade ran. Point-in-time SHA: clean.
  check(
    'WRITER: a rollback across the write window, replaced before the grade => PRE_FIX_WRITER',
    (() => {
      const w = gradeWriterProvenance({
        deploys: [
          dep(GOOD, '2026-07-30T12:10:24Z'),
          dep(BAD, '2026-07-31T00:30:00Z'),
          dep(GOOD, '2026-07-31T01:20:00Z', 'live'),
        ],
        isDescendant: descendantOnly, gradedDate: '2026-07-30', now: GRADE_AT, liveCommit: GOOD,
      });
      return { verdict: w.verdict, serving: w.serving.length };
    })(),
    { verdict: 'PRE_FIX_WRITER', serving: 3 },
  );
  // ... and that verdict must reach the AC2 grade, in BOTH directions.
  check(
    'WRITER: PRE_FIX_WRITER downgrades a PASS to BLIND and preserves the original',
    (() => {
      const a = applyWriterProvenanceToAc2({ verdict: 'PASS', rows: 0, gradeableBookCount: 3 }, { verdict: 'PRE_FIX_WRITER' });
      return { verdict: a.verdict, from: a.downgradedFrom };
    })(),
    { verdict: 'BLIND', from: 'PASS' },
  );
  check(
    'WRITER: PRE_FIX_WRITER also downgrades a FAIL — "not running" is not "regressed"',
    applyWriterProvenanceToAc2({ verdict: 'FAIL', rows: 2 }, { verdict: 'PRE_FIX_WRITER' }).downgradedFrom,
    'FAIL',
  );
  check(
    'WRITER: MUTATION — UNATTRIBUTABLE must NOT veto the grade (else the gate is unreachable)',
    applyWriterProvenanceToAc2({ verdict: 'PASS', rows: 0 }, { verdict: 'UNATTRIBUTABLE' }).verdict,
    'PASS',
  );
  check(
    'WRITER: CONFIRMED passes the verdict through untouched',
    applyWriterProvenanceToAc2({ verdict: 'PASS', rows: 0 }, { verdict: 'CONFIRMED' }).verdict,
    'PASS',
  );
  // A post-write rollback did NOT write the row. Failing on it would hand the
  // fleet's deploy cadence a veto over this gate.
  check(
    'WRITER: a rollback deployed AFTER the window does not invalidate the grade',
    gradeWriterProvenance({
      deploys: [dep(GOOD, '2026-07-30T12:10:24Z'), dep(BAD, '2026-07-31T02:30:00Z', 'live')],
      isDescendant: descendantOnly, gradedDate: '2026-07-30', now: GRADE_AT,
    }).verdict,
    'CONFIRMED',
  );
  // ABSENCE IS NOT A PASS, three ways — and none of them may read CONFIRMED.
  check(
    'WRITER: no credential => UNATTRIBUTABLE, never CONFIRMED',
    gradeWriterProvenance({ deploys: null, isDescendant: descendantOnly, gradedDate: '2026-07-30', now: GRADE_AT }).verdict,
    'UNATTRIBUTABLE',
  );
  check(
    'WRITER: unresolvable ancestry (no git checkout) => UNATTRIBUTABLE, never PRE_FIX_WRITER',
    gradeWriterProvenance({
      deploys: [dep(GOOD, '2026-07-30T12:10:24Z', 'live')],
      isDescendant: () => null, gradedDate: '2026-07-30', now: GRADE_AT,
    }).verdict,
    'UNATTRIBUTABLE',
  );
  check(
    'WRITER: history that starts AFTER the window opened => UNATTRIBUTABLE',
    gradeWriterProvenance({
      deploys: [dep(GOOD, '2026-07-31T01:40:00Z', 'live')],
      isDescendant: descendantOnly, gradedDate: '2026-07-30', now: GRADE_AT,
    }).verdict,
    'UNATTRIBUTABLE',
  );
  // A build that never served occupies a timestamp but no traffic. Counting it
  // would report a PRE_FIX_WRITER on a rollback attempt that failed to deploy.
  check(
    'WRITER: a build_failed rollback never served, so it cannot be the writer',
    gradeWriterProvenance({
      deploys: [
        dep(GOOD, '2026-07-30T12:10:24Z', 'live'),
        dep(BAD, '2026-07-31T00:30:00Z', 'build_failed'),
      ],
      isDescendant: descendantOnly, gradedDate: '2026-07-30', now: GRADE_AT,
    }).verdict,
    'CONFIRMED',
  );
  check(
    'WRITER: RED outranks UNKNOWN — a proven pre-fix build is not masked by an unresolved one',
    gradeWriterProvenance({
      deploys: [dep(BAD, '2026-07-31T00:30:00Z'), dep('unknown123', '2026-07-31T01:20:00Z', 'live')],
      isDescendant: descendantOnly, gradedDate: '2026-07-30', now: GRADE_AT,
    }).verdict,
    'PRE_FIX_WRITER',
  );
  // A PRE-CHECK MUST NOT LOOK LIKE THE GRADE. The newest served build is
  // open-ended, so before the EOD write it intersects the window and would print
  // CONFIRMED about a row nobody has written yet — and the same inputs must flip to
  // a real verdict once the write instant has passed.
  check(
    'WRITER: before the EOD write => NOT_YET_WRITTEN, never CONFIRMED',
    gradeWriterProvenance({
      deploys: [dep(GOOD, '2026-07-30T12:10:24Z', 'live')],
      isDescendant: descendantOnly, gradedDate: '2026-07-30', now: '2026-07-30T14:30:00Z',
    }).verdict,
    'NOT_YET_WRITTEN',
  );
  check(
    'WRITER: the SAME inputs attribute the writer once the write instant has passed',
    gradeWriterProvenance({
      deploys: [dep(GOOD, '2026-07-30T12:10:24Z', 'live')],
      isDescendant: descendantOnly, gradedDate: '2026-07-30', now: '2026-07-31T01:30:00Z',
    }).verdict,
    'CONFIRMED',
  );
  check(
    'WRITER: the NOT_YET_WRITTEN arm says PRE-CHECK in the printed output',
    (() => {
      const lines = [];
      const real = console.log;
      console.log = (...a) => lines.push(a.join(' '));
      try { printWriterProvenance({ verdict: 'NOT_YET_WRITTEN', reason: 'r', serving: [] }); } finally { console.log = real; }
      return lines.join('\n').includes('PRE-CHECK, not the grade');
    })(),
    true,
  );
  check(
    'WRITER: NOT_YET_WRITTEN does not veto the grade either',
    applyWriterProvenanceToAc2({ verdict: 'BLIND', rows: 0 }, { verdict: 'NOT_YET_WRITTEN' }).verdict,
    'BLIND',
  );
  check(
    'WRITER: nothing graded => NOT_APPLICABLE, not a silent CONFIRMED',
    gradeWriterProvenance({ deploys: [], isDescendant: descendantOnly, gradedDate: null }).verdict,
    'NOT_APPLICABLE',
  );
  // The date AC2 rests on is the newest gradeable session, not the cutoff.
  check(
    'WRITER: the attributed date is the newest GRADEABLE session, falling back to the cutoff',
    [
      latestGradedDate({ since: '2026-07-30', gradeableBooks: [{ dates: ['2026-07-30'] }, { dates: ['2026-07-31', '2026-07-30'] }] }),
      latestGradedDate({ since: '2026-07-30', gradeableBooks: [] }),
      latestGradedDate(null),
    ],
    ['2026-07-31', '2026-07-30', null],
  );
  // The printed text is the deliverable: the grader reads stdout, not an object.
  for (const [label, w, needle] of [
    ['PRE_FIX_WRITER', { verdict: 'PRE_FIX_WRITER', reason: 'r', serving: [] }, 'PRE-FIX BUILD'],
    ['UNATTRIBUTABLE', { verdict: 'UNATTRIBUTABLE', reason: 'r', serving: [] }, 'UNATTRIBUTED'],
    ['absent', null, 'NOT CHECKED'],
  ]) {
    check(
      `WRITER: the ${label} arm says so in the printed output`,
      (() => {
        const lines = [];
        const real = console.log;
        console.log = (...a) => lines.push(a.join(' '));
        try { printWriterProvenance(w); } finally { console.log = real; }
        return lines.join('\n').includes(needle);
      })(),
      true,
    );
  }
  // And the downgraded BLIND arm must not print the "writer has not produced a row
  // yet, re-run" text — that names the wrong cause and invites a pointless re-read.
  check(
    'WRITER: a downgraded BLIND names the pre-fix writer, not a missing row',
    (() => {
      const a = applyWriterProvenanceToAc2(
        graded([day('2026-07-29', 0, -5.11), day('2026-07-30', 3.25, 0)]),
        { verdict: 'PRE_FIX_WRITER', reason: 'rolled back', serving: [], gradedDate: '2026-07-30' },
      );
      const out = capturePrintAc2(a);
      return { downgraded: out.includes('DOWNGRADED from PASS'), noStaleRerun: !out.includes('has not produced a gradeable row yet') };
    })(),
    { downgraded: true, noStaleRerun: true },
  );

  // TRA-2630 — LIVE COHORT SAMPLING. The measured bqb1 flap: same sha, one pull
  // resolves `admin` demo and the next resolves it live. These controls pin the
  // fail-safe direction, because the tempting "majority wins" reading would
  // discard the single live sample that is the whole point.
  const eng = (...modes) => ({ engines: modes.map((m, i) => ({ username: `b${i}`, mode: m })) });

  check(
    'COHORT: a live book in the FIRST sample is adopted with no re-sampling',
    (() => {
      const p = pickLiveCohortSample([eng('live', 'demo')]);
      return { idx: p.adoptedIndex, flapped: p.flapped, confirmedEmpty: p.confirmedEmpty };
    })(),
    { idx: 0, flapped: false, confirmedEmpty: false },
  );

  check(
    'COHORT: the measured flap — sample 1 demo-only, sample 2 live => adopt sample 2',
    (() => {
      const p = pickLiveCohortSample([eng('demo', 'demo'), eng('live', 'demo')]);
      return { idx: p.adoptedIndex, flapped: p.flapped, live: countLiveBooks(p.payload) };
    })(),
    { idx: 1, flapped: true, live: 1 },
  );

  check(
    'COHORT: MUTATION — a LONE live sample beats four demo samples (never majority-wins)',
    (() => {
      const p = pickLiveCohortSample([
        eng('demo'), eng('demo'), eng('demo'), eng('demo'), eng('live'),
      ]);
      return { idx: p.adoptedIndex, flapped: p.flapped, live: countLiveBooks(p.payload) };
    })(),
    { idx: 4, flapped: true, live: 1 },
  );

  check(
    'COHORT: all samples empty => confirmedEmpty, and NOT reported as a flap',
    (() => {
      const p = pickLiveCohortSample([eng('demo'), eng('demo'), eng('demo')]);
      return { flapped: p.flapped, confirmedEmpty: p.confirmedEmpty, live: countLiveBooks(p.payload) };
    })(),
    { flapped: false, confirmedEmpty: true, live: 0 },
  );

  check(
    'COHORT: a SINGLE empty sample is not "confirmed" empty (one pull proves nothing)',
    pickLiveCohortSample([eng('demo')]).confirmedEmpty,
    false,
  );

  check(
    'COHORT: no usable sample => null payload, never a silent zero-live reading',
    (() => {
      const p = pickLiveCohortSample([null, { notEngines: true }]);
      return { payload: p.payload, idx: p.adoptedIndex, confirmedEmpty: p.confirmedEmpty };
    })(),
    { payload: null, idx: -1, confirmedEmpty: false },
  );

  check(
    'COHORT: the flap disclosure names both counts and says the first pull would have missed it',
    (() => {
      const out = [];
      const orig = console.log;
      console.log = (...a) => out.push(a.join(' '));
      try {
        reportLiveCohortSampling({
          ...pickLiveCohortSample([eng('demo'), eng('live')]),
          sampleCount: 2,
        });
      } finally {
        console.log = orig;
      }
      const t = out.join('\n');
      return {
        saysFlap: t.includes('LIVE COHORT FLAP'),
        saysCounts: t.includes('[0, 1]'),
        saysMissed: t.includes('NOT'),
      };
    })(),
    { saysFlap: true, saysCounts: true, saysMissed: true },
  );

  check(
    'COHORT: a single pull discloses NOTHING (no noise on the common path)',
    (() => {
      const out = [];
      const orig = console.log;
      console.log = (...a) => out.push(a.join(' '));
      try {
        reportLiveCohortSampling({ ...pickLiveCohortSample([eng('live')]), sampleCount: 1 });
        reportLiveCohortSampling(null);
      } finally {
        console.log = orig;
      }
      return out.length;
    })(),
    0,
  );

  // TRA-2761 — the reclassified-cohort arm, both directions plus the two
  // non-verdict states that must not be conflated with either.
  check(
    'TRA-2761: cohort emptied under open live rows → RECLASSIFIED',
    gradeLiveCohortIntegrity({
      liveCohortIntegrityOk: false,
      liveOpenJournalRowCount: 7,
      liveOpenJournalAtRiskUsd: 1401.5,
      liveOpenJournalUnattributedRowCount: 0,
      liveCohortReclassifiedBooks: [
        { username: 'admin', mode: 'demo', openLiveJournalRowCount: 7, openLiveJournalAtRiskUsd: 1401.5 },
      ],
    }).verdict,
    'RECLASSIFIED',
  );
  check(
    'TRA-2761: every holder classified live → INTACT',
    gradeLiveCohortIntegrity({
      liveCohortIntegrityOk: true,
      liveOpenJournalRowCount: 12,
      liveOpenJournalAtRiskUsd: 2455.5,
      liveOpenJournalUnattributedRowCount: 0,
      liveCohortReclassifiedBooks: [],
    }).verdict,
    'INTACT',
  );
  check(
    'TRA-2761: a build without the fold is FIELD_ABSENT, never a verdict',
    gradeLiveCohortIntegrity({ liveBookCount: 1 }).verdict,
    'FIELD_ABSENT',
  );
  check(
    'TRA-2761: null with a published count 0 is NO_OPEN_LIVE_ROWS, null counts are NOT_MEASURED',
    [
      gradeLiveCohortIntegrity({ liveCohortIntegrityOk: null, liveOpenJournalRowCount: 0 }).verdict,
      gradeLiveCohortIntegrity({ liveCohortIntegrityOk: null, liveOpenJournalRowCount: null }).verdict,
    ],
    ['NO_OPEN_LIVE_ROWS', 'NOT_MEASURED'],
  );

  let failed = 0;
  for (const c of cases) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (!c.ok) {
      failed++;
      console.log(`        expected ${JSON.stringify(c.expected)}`);
      console.log(`        actual   ${JSON.stringify(c.actual)}`);
    }
  }
  console.log('');
  console.log(`${cases.length - failed}/${cases.length} controls passed`);
  return failed === 0 ? EXIT_CLEAN : EXIT_DEMO_LAG;
}

const argv = process.argv.slice(2);
const run = argv.includes('--selftest') ? Promise.resolve(selftest()) : main(argv);
run
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`BLIND — unexpected failure: ${err?.stack ?? err}`);
    process.exit(EXIT_BLIND);
  });
