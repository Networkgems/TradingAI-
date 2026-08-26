// TRA-3449 — the live-money NAV tripwire, made independent of an agent run.
//
// The four acceptance criteria ARE the test plan:
//   1. a durable non-LLM daily assertion on the three fail conditions -> the grading block;
//   2. the result is durable and a MISSED DAY is distinguishable from a clean one
//      -> the coverage block (which replays the actual 2026-08-06..08-12 outage);
//   3. never grade on `ok` / `drift` / `maxDriftUsd` (TRA-2630 Defect A) -> the
//      forbidden-operand block;
//   4. `null` is not a pass -> the fail-closed block, extended to an ABSENT field,
//      because a gate reading a payload it does not own must assume the payload moves.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  gradeLiveNavTripwirePayload,
  computeLiveLagDenominators,
  recordLiveNavTripwireAssertion,
  runLiveNavTripwireTick,
  hydrateLiveNavTripwireFromDisk,
  summarizeLiveNavTripwire,
  clearLiveNavTripwire,
  liveNavTripwireLogPath,
  liveNavObservationStartPath,
  liveNavEtDay,
  liveNavEtWallClockToUtcMs,
  liveNavWriterDueAtMs,
  resolveLiveNavObservationStart,
  seedLiveNavObservationStartForTest,
  LIVE_NAV_OBSERVATION_START_FILENAME,
  LIVE_NAV_WRITER_DUE_GRACE_MS,
  LIVE_NAV_TRIPWIRE_FILENAME,
  LIVE_NAV_GRADED_FIELDS,
  LIVE_NAV_FORBIDDEN_FIELDS,
} from './live-nav-tripwire-ledger.js';

/**
 * TRA-3450 — `admin`'s real day series, reduced to the two operands of the lag predicate.
 *
 * These are the actual figures served at 2026-08-13T03:53:21Z. What matters: the last non-zero
 * `stockDaily` is **2026-07-29**, one session BEFORE the book's own `liveOptionsOnsetDate` of
 * 2026-07-30, while every non-zero `optionsDaily` since (08-05, 08-06, 08-11) landed on a day
 * whose successor booked no stock P&L. So the two trip-capable pairs in the whole series are
 * (07-25→07-28) and (07-28→07-29), and BOTH are pre-onset — post-onset trip-capable is 0.
 */
const ADMIN_LIVE_DAYS = [
  { date: '2026-07-25', stockDaily: 0, optionsDaily: 217.5 },
  { date: '2026-07-28', stockDaily: -0.94, optionsDaily: 54.4 },
  { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 114 },
  { date: '2026-08-05', stockDaily: 0, optionsDaily: -424 },
  { date: '2026-08-06', stockDaily: 0, optionsDaily: -20 },
  { date: '2026-08-11', stockDaily: 0, optionsDaily: -16 },
  { date: '2026-08-12', stockDaily: 0, optionsDaily: 0 },
];

/** `v0nni` — live, $25,000, and has never traded. Every operand zero, onset `null`. */
const V0NNI_LIVE_DAYS = [
  { date: '2026-08-11', stockDaily: 0, optionsDaily: 0 },
  { date: '2026-08-12', stockDaily: 0, optionsDaily: 0 },
];

/**
 * A series carrying ONE post-onset trip-capable pair that does not trip: 08-11 books
 * `optionsDaily -16`, 08-12 books `stockDaily -5.5`. Both operands non-zero, 08-12 is after
 * onset, and -5.50 != -16.00 — so the lag predicate had a reachable failing state and did not
 * fire. This is what a genuinely CLEAN day looks like, as opposed to a vacuous one.
 */
const TRIP_CAPABLE_DAYS = [
  { date: '2026-08-11', stockDaily: 0, optionsDaily: -16 },
  { date: '2026-08-12', stockDaily: -5.5, optionsDaily: 0 },
];

/**
 * The shape actually served by bqb1 at 2026-08-13T03:32Z (build `10e68acf9c2e`), reduced
 * to the fields this gate reads. Pinned from a real pull, not invented: the point of a
 * self-fetching gate is that it grades the served contract, so the fixture must be the
 * served contract.
 *
 * As pulled, this is NOT clean — `liveGradeableBookCount: 1` against `liveBookCount: 2`,
 * because `v0nni` (live since 2026-08-05, $25,000, TRA-3417) has not filled yet — and per
 * TRA-3450 it is not clean for a second, independent reason: BOTH live books carry a zero
 * post-onset trip-capable denominator.
 */
function servedPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: '2026-08-13T03:32:59.422Z',
    ok: false,
    maxDriftUsd: 765,
    drift: 765,
    eodInteriorAbsentOk: false,
    ungradeableFields: ['ok', 'maxDriftUsd', 'engines[].drift', 'eodInteriorAbsentOk'],
    livePriorOptionsLagOk: true,
    livePriorOptionsLagBooks: [],
    liveBookCount: 2,
    liveGradeableBookCount: 1,
    liveEodRowsPresentOk: true,
    liveEodRowMissingBooks: [],
    liveEodTailMaxStaleSessions: 0,
    liveEodTailStaleBooks: [],
    liveEodInteriorAbsentBooks: [
      { username: 'admin', dates: ['2026-08-07'] },
      { username: 'v0nni', dates: ['2026-08-07'] },
    ],
    engines: [
      {
        username: 'admin',
        mode: 'live',
        liveOptionsOnsetDate: '2026-07-30',
        days: ADMIN_LIVE_DAYS,
        priorOptionsLagOk: true,
        priorOptionsLagEligibleDates: ['2026-07-16', '2026-08-12'],
      },
      {
        username: 'v0nni',
        mode: 'live',
        liveOptionsOnsetDate: null,
        days: V0NNI_LIVE_DAYS,
        priorOptionsLagOk: null,
        priorOptionsLagEligibleDates: [],
      },
      {
        username: 'Richard',
        mode: 'sandbox',
        liveOptionsOnsetDate: null,
        days: TRIP_CAPABLE_DAYS,
        priorOptionsLagOk: false,
        priorOptionsLagEligibleDates: ['2026-07-28'],
      },
    ],
    ...over,
  };
}

/**
 * The same payload with the coverage hole closed AND a non-empty post-onset trip-capable
 * denominator on both live books — i.e. what CLEAN looks like post-TRA-3417.
 *
 * TRA-3450 made the second half of that sentence load-bearing. Before the amendment this
 * fixture graded clean off `liveGradeableBookCount: 2` alone, which is precisely the vacuous
 * green the amendment exists to make unreachable.
 */
function coveredPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return servedPayload({
    liveGradeableBookCount: 2,
    engines: [
      {
        username: 'admin',
        mode: 'live',
        liveOptionsOnsetDate: '2026-07-30',
        days: TRIP_CAPABLE_DAYS,
        priorOptionsLagOk: true,
        priorOptionsLagEligibleDates: ['2026-08-12'],
      },
      {
        username: 'v0nni',
        mode: 'live',
        liveOptionsOnsetDate: '2026-08-06',
        days: TRIP_CAPABLE_DAYS,
        priorOptionsLagOk: true,
        priorOptionsLagEligibleDates: ['2026-08-12'],
      },
    ],
    ...over,
  });
}

describe('TRA-3449 grading — the three fail conditions', () => {
  it('fires FAIL when livePriorOptionsLagOk is false — the tripwire itself', () => {
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({
        livePriorOptionsLagOk: false,
        livePriorOptionsLagBooks: [{ username: 'admin', dates: ['2026-08-12'] }],
      }),
    );
    expect(g.verdict).toBe('fail');
    expect(g.alarm).toBe(true);
    expect(g.axes.lag).toEqual({ status: 'fail', reason: 'live_book_overstated_nav', kind: 'assertion' });
    // The offending rows have to come out of the record ready to print — the whole reason
    // the endpoint publishes `livePriorOptionsLagBooks` rather than just a boolean.
    expect(g.lagBooks).toEqual([{ username: 'admin', dates: ['2026-08-12'] }]);
  });

  it('fires FAIL when liveEodRowsPresentOk is false — an unwritten EOD row on a live book', () => {
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({
        liveEodRowsPresentOk: false,
        liveEodRowMissingBooks: [{ username: 'admin', dates: ['2026-08-11'] }],
      }),
    );
    expect(g.verdict).toBe('fail');
    expect(g.axes.eodRows.status).toBe('fail');
    expect(g.eodRowMissingBooks).toEqual([{ username: 'admin', dates: ['2026-08-11'] }]);
  });

  it('fires FAIL when liveEodTailMaxStaleSessions > 0 — a dead tail on a live book', () => {
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({
        liveEodTailMaxStaleSessions: 3,
        liveEodTailStaleBooks: [{ username: 'admin', staleSessions: 3 }],
      }),
    );
    expect(g.verdict).toBe('fail');
    expect(g.axes.eodTail).toEqual({ status: 'fail', reason: 'live_book_eod_tail_stale:3', kind: 'assertion' });
  });

  it('FAIL outranks BLIND — a real breach is not downgraded by an unrelated coverage hole', () => {
    // The served (uncovered) payload with the tripwire tripped. If precedence went the
    // other way, `v0nni` never filling would MASK a $-real NAV overstatement on `admin`.
    const g = gradeLiveNavTripwirePayload(servedPayload({ livePriorOptionsLagOk: false }));
    expect(g.axes.coverage.status).toBe('blind');
    expect(g.verdict).toBe('fail');
  });

  it('grades the real served payload as BLIND — not clean, not fail', () => {
    const g = gradeLiveNavTripwirePayload(servedPayload());
    expect(g.axes.lag.status).toBe('pass');
    expect(g.axes.eodRows.status).toBe('pass');
    expect(g.axes.eodTail.status).toBe('pass');
    expect(g.axes.coverage).toEqual({
      status: 'blind',
      // TRA-3711 — the reason now names the CLASS of the hole, not just its size.
      reason: 'ungraded_live_books:1_of_2:no_eligible_dates',
      kind: 'coverage',
    });
    expect(g.verdict).toBe('blind');
    // TRA-3711 — the verdict is unchanged and the ALARM is not. `blind` is a hole in the
    // instrument, so it rides `degraded`/`attention`; `alarm` is reserved for a trip.
    expect(g.alarm).toBe(false);
    expect(g.degraded).toBe(true);
    expect(g.attention).toBe(true);
    // AC4 — the ungraded live book is NAMED, with the reason it could not be graded.
    // `no_eligible_dates` is benign TODAY and becomes a live grade the instant it fills.
    expect(g.ungradedBooks).toEqual([{ username: 'v0nni', reason: 'no_eligible_dates' }]);
  });

  it('distinguishes an ungraded-with-eligible-dates book from a never-traded one', () => {
    // Live, HAS eligible sessions, and still null: that is a grader defect, not a quiet
    // book, and folding the two into one reason would hide it.
    const g = gradeLiveNavTripwirePayload(
      servedPayload({
        engines: [
          { username: 'admin', mode: 'live', priorOptionsLagOk: null, priorOptionsLagEligibleDates: ['2026-08-12'] },
          { username: 'v0nni', mode: 'live', priorOptionsLagOk: null, priorOptionsLagEligibleDates: [] },
        ],
      }),
    );
    expect(g.ungradedBooks).toEqual([
      { username: 'admin', reason: 'ungraded' },
      { username: 'v0nni', reason: 'no_eligible_dates' },
    ]);
  });

  it('is CLEAN only when every axis genuinely passed', () => {
    const g = gradeLiveNavTripwirePayload(coveredPayload());
    expect(g.verdict).toBe('clean');
    expect(g.alarm).toBe(false);
    expect(g.ungradedBooks).toEqual([]);
  });
});

describe('TRA-3449 AC3 — the forbidden operands (TRA-2630 Defect A)', () => {
  it('does not key on ok / drift / maxDriftUsd / eodInteriorAbsentOk', () => {
    // The clean fixture carries `ok: false`, `maxDriftUsd: 765`, `drift: 765` and
    // `eodInteriorAbsentOk: false` — every ungradeable field in its WORST state. A gate
    // keyed on any of them reads red here. This one must read CLEAN.
    const g = gradeLiveNavTripwirePayload(coveredPayload());
    expect(g.observed.ungradeableFields).toContain('ok');
    expect(g.verdict).toBe('clean');

    // And flipping them to their BEST state must not move the verdict either — a field
    // that cannot change the answer in either direction is genuinely not an operand.
    const flipped = gradeLiveNavTripwirePayload(
      coveredPayload({ ok: true, maxDriftUsd: 0, drift: 0, eodInteriorAbsentOk: true }),
    );
    expect(flipped.verdict).toBe('clean');
    expect(flipped.axes).toEqual(g.axes);
  });

  it('keeps the graded and forbidden field lists disjoint', () => {
    // A greppable seam: if someone later adds `maxDriftUsd` to the graded set, this trips
    // before the false-red ships and gets the gate switched off.
    for (const f of LIVE_NAV_GRADED_FIELDS) {
      expect(LIVE_NAV_FORBIDDEN_FIELDS as readonly string[]).not.toContain(f);
    }
  });

  it('goes BLIND when the endpoint disowns one of OUR operands', () => {
    // `ungradeableFields` growing to cover a field we grade means that field has joined
    // the class that reads identically in the pass and fail state. Publishing a verdict
    // off it after that is Defect A, one ticket later.
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({
        ungradeableFields: ['ok', 'maxDriftUsd', 'livePriorOptionsLagOk'],
      }),
    );
    expect(g.axes.lag).toEqual({ status: 'blind', reason: 'operand_declared_ungradeable', kind: 'assertion' });
    expect(g.verdict).toBe('blind');
  });

  it('records liveEodInteriorAbsentBooks without grading it', () => {
    // TRA-2943's discriminator of record is non-empty on both live books TODAY. Gating on
    // it would ship a born-red gate; recording it keeps a NEW interior absence recoverable
    // by diffing consecutive rows.
    const g = gradeLiveNavTripwirePayload(coveredPayload());
    expect(g.interiorAbsentBooks).toEqual([
      { username: 'admin', dates: ['2026-08-07'] },
      { username: 'v0nni', dates: ['2026-08-07'] },
    ]);
    expect(g.verdict).toBe('clean');
  });
});

describe('TRA-3449 AC4 — null is not a pass, and neither is an absent field', () => {
  it.each([
    ['livePriorOptionsLagOk', 'lag'],
    ['liveEodRowsPresentOk', 'eodRows'],
    ['liveEodTailMaxStaleSessions', 'eodTail'],
  ] as const)('grades %s: null as BLIND on the %s axis', (field, axis) => {
    const g = gradeLiveNavTripwirePayload(coveredPayload({ [field]: null }));
    expect(g.axes[axis]).toEqual({ status: 'blind', reason: 'not_measured', kind: 'assertion' });
    expect(g.verdict).toBe('blind');
    // TRA-3711 — an unreadable operand is a hole in the instrument, not a trip. It is
    // still never green: `degraded` and `attention` both carry it.
    expect(g.alarm).toBe(false);
    expect(g.degraded).toBe(true);
    expect(g.attention).toBe(true);
  });

  it.each([
    ['livePriorOptionsLagOk', 'lag'],
    ['liveEodRowsPresentOk', 'eodRows'],
    ['liveEodTailMaxStaleSessions', 'eodTail'],
  ] as const)('grades an ABSENT %s as BLIND on the %s axis', (field, axis) => {
    // A deploy that renames or drops a field must not degrade the gate to green. This is
    // the generalisation of "null is not a pass" to the field itself.
    const p = coveredPayload();
    delete p[field];
    const g = gradeLiveNavTripwirePayload(p);
    expect(g.axes[axis]).toEqual({ status: 'blind', reason: 'missing_field', kind: 'assertion' });
    expect(g.verdict).toBe('blind');
    // TRA-3711 — an unreadable operand is a hole in the instrument, not a trip. It is
    // still never green: `degraded` and `attention` both carry it.
    expect(g.alarm).toBe(false);
    expect(g.degraded).toBe(true);
    expect(g.attention).toBe(true);
  });

  it('grades a wrong-typed operand as BLIND, not by coercion', () => {
    // `"true"` is truthy. A gate that coerced would read this as a pass.
    const g = gradeLiveNavTripwirePayload(coveredPayload({ livePriorOptionsLagOk: 'true' }));
    expect(g.axes.lag).toEqual({ status: 'blind', reason: 'field_wrong_type', kind: 'assertion' });
    expect(g.verdict).toBe('blind');
  });

  it('grades an EMPTY live cohort as BLIND — the TRA-2630 AC3 manufactured green', () => {
    // "No live book was affected" and "there was no live book" must never read alike.
    // bqb1 has served an empty live cohort on a boot-arm miss (TRA-2649).
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({ liveBookCount: 0, liveGradeableBookCount: 0, engines: [] }),
    );
    expect(g.axes.coverage).toEqual({ status: 'blind', reason: 'empty_live_cohort', kind: 'coverage' });
    expect(g.verdict).toBe('blind');
  });

  it.each([[null], [undefined], ['not json'], [42], [[]]])(
    'grades an unusable payload (%p) as BLIND on every axis',
    (payload) => {
      const g = gradeLiveNavTripwirePayload(payload);
      expect(g.verdict).toBe('blind');
      for (const a of Object.values(g.axes)) expect(a.status).toBe('blind');
    },
  );
});

describe('TRA-3449 AC2 — durable, and a missed day is distinguishable from a clean one', () => {
  let dir: string;
  const T = (etDay: string): number => Date.parse(`${etDay}T21:20:00-04:00`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra3449-'));
    clearLiveNavTripwire();
    hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));
    // TRA-4001 — this block replays the 08-06..08-12 outage AS IF the ledger had been
    // observing it. The hydrate above pins the marker at 08-13, which would (correctly, for
    // the real ledger that did not exist then) file the whole window NOT MEASURED. Pin the
    // start before the window so the replay grades what it was written to grade.
    seedLiveNavObservationStartForTest(Date.parse('2026-08-05T00:00:00-04:00'));
  });
  afterEach(() => {
    clearLiveNavTripwire();
    rmSync(dir, { recursive: true, force: true });
  });

  function assertOn(etDay: string, payload: unknown): void {
    recordLiveNavTripwireAssertion({
      grade: gradeLiveNavTripwirePayload(payload),
      source: 'served',
      now: T(etDay),
    });
  }

  it('replays the outage: 5 lost sessions read as 0% realized coverage, not as clean', () => {
    // The actual TRA-3449 window. 2026-08-06 Thu .. 2026-08-12 Wed = 5 NYSE sessions, and
    // the routine graded NONE of them. Nothing is written here at all — that IS the state.
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    expect(s.coverage.marketDaysExpected).toBe(5);
    expect(s.coverage.marketDaysRecorded).toBe(0);
    expect(s.coverage.realizedCoverage).toBe(0);
    expect(s.coverage.marketDaysMissing).toEqual([
      '2026-08-12',
      '2026-08-11',
      '2026-08-10',
      '2026-08-07',
      '2026-08-06',
    ]);
    // The reading that the routine's `status: active` / `enabled: true` could not give.
    expect(s.verdict).toBe('blind');
    // TRA-3711 — a week the writer never reached is a COVERAGE fact, so it lands on
    // `degraded`/`attention`, not on the trip channel. It must stay just as loud: the
    // named missing sessions, the 0% realized coverage and `consecutiveMissingSessions`
    // are all still here, and the driver says WHY in one field.
    expect(s.attention).toBe(true);
    expect(s.degraded).toBe(true);
    expect(s.alarm).toBe(false);
    expect(s.driver).toEqual({
      axis: 'writer',
      kind: 'coverage',
      status: 'blind',
      reason: 'no_assertion_row',
    });
    expect(s.signalClasses).toEqual({
      sessionsTrip: 0,
      sessionsDegradedOnly: 5,
      sessionsClean: 0,
      sessionsAttention: 5,
    });
    expect(s.consecutiveMissingSessions).toBe(5);
  });

  it('never lets the row set supply its own denominator', () => {
    // One clean row inside the outage window. A summary whose day list came from the rows
    // would now report 1/1 = 100% coverage over the week that had 0%.
    assertOn('2026-08-12', coveredPayload());
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    expect(s.coverage.marketDaysExpected).toBe(5);
    expect(s.coverage.marketDaysRecorded).toBe(1);
    expect(s.coverage.realizedCoverage).toBeCloseTo(0.2);
    expect(s.verdict).toBe('blind'); // 4 missing sessions — not clean
  });

  it('does not count a weekend as a miss', () => {
    // 2026-08-08 Sat / 08-09 Sun. Folding non-sessions into the denominator would bury a
    // real miss under ~30% expected absence.
    for (const d of ['2026-08-10', '2026-08-11', '2026-08-12']) assertOn(d, coveredPayload());
    const s = summarizeLiveNavTripwire(3, '2026-08-12');
    expect(s.coverage.marketDaysExpected).toBe(3);
    const weekendRows = summarizeLiveNavTripwire(5, '2026-08-12').byDay.filter((d) => !d.marketDay);
    expect(weekendRows.map((d) => d.etDay)).toEqual(['2026-08-09', '2026-08-08']);
    for (const w of weekendRows) expect(w.alarm).toBe(false);
  });

  it('reads CLEAN only when every session in the window has a passing row', () => {
    for (const d of ['2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12']) {
      assertOn(d, coveredPayload());
    }
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    expect(s.verdict).toBe('clean');
    expect(s.alarm).toBe(false);
    expect(s.degraded).toBe(false);
    expect(s.attention).toBe(false);
    expect(s.driver).toBeNull();
    expect(s.signalClasses).toEqual({
      sessionsTrip: 0,
      sessionsDegradedOnly: 0,
      sessionsClean: 5,
      sessionsAttention: 0,
    });
    expect(s.coverage.realizedCoverage).toBe(1);
    expect(s.consecutiveMissingSessions).toBe(0);
  });

  it('surfaces the fail day and keeps FAIL above BLIND across the window', () => {
    assertOn('2026-08-11', coveredPayload({ livePriorOptionsLagOk: false }));
    assertOn('2026-08-12', coveredPayload());
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    expect(s.verdict).toBe('fail');
    expect(s.lastFailDay).toBe('2026-08-11');
  });

  it('survives a restart — the record is the disk, not the process', () => {
    // Constraint 1 of the same ruling that produced TRA-2930. A deploy eats an in-memory
    // ring, and an empty ring reads exactly like a week of clean days.
    assertOn('2026-08-11', coveredPayload({ livePriorOptionsLagOk: false }));
    assertOn('2026-08-12', coveredPayload());
    expect(existsSync(join(dir, LIVE_NAV_TRIPWIRE_FILENAME))).toBe(true);

    clearLiveNavTripwire();
    expect(summarizeLiveNavTripwire(7, '2026-08-12').coverage.marketDaysRecorded).toBe(0);

    const h = hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));
    expect(h.records).toBe(2);
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    expect(s.coverage.marketDaysRecorded).toBe(2);
    expect(s.lastFailDay).toBe('2026-08-11');
    expect(s.durability.hydratedRecords).toBe(2);
  });

  it('upserts per ET day, so a hand re-run corrects the row it targets', () => {
    assertOn('2026-08-12', coveredPayload({ livePriorOptionsLagOk: false }));
    assertOn('2026-08-12', coveredPayload());
    clearLiveNavTripwire();
    hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    expect(s.coverage.marketDaysRecorded).toBe(1);
    expect(s.byDay[0]).toMatchObject({ etDay: '2026-08-12', verdict: 'clean' });
    expect(s.lastFailDay).toBeNull();
  });

  it('skips a torn line without losing the rest of the record', () => {
    assertOn('2026-08-11', coveredPayload());
    const path = liveNavTripwireLogPath(dir);
    writeFileSync(path, readFileSync(path, 'utf8') + '{"kind":"assert","ts":' + '\n', 'utf8');
    clearLiveNavTripwire();
    const h = hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));
    expect(h.records).toBe(1);
    // and the torn tail is compacted away, so it cannot re-cost the hydrate every boot
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('publishes durability so an empty ledger on an ephemeral disk cannot read as clean', () => {
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    expect(s.durability.dataDir).toBe(dir);
    expect(typeof s.durability.ephemeral).toBe('boolean');
    expect(s.durability.appendErrors).toBe(0);
  });
});

describe('TRA-3449 — the tick always leaves a trace', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra3449-tick-'));
    clearLiveNavTripwire();
    hydrateLiveNavTripwireFromDisk(dir, Date.parse('2026-08-12T21:20:00-04:00'));
  });
  afterEach(() => {
    clearLiveNavTripwire();
    rmSync(dir, { recursive: true, force: true });
  });

  const now = Date.parse('2026-08-12T21:20:00-04:00');

  it('writes a BLIND row when the self-fetch throws', async () => {
    // ENOTFOUND is literally one of the three causes that lost the agent fires. The
    // difference is that here it produces a ROW saying so, not a silent non-run.
    const rec = await runLiveNavTripwireTick({
      fetchPayload: async () => {
        throw new Error('ENOTFOUND');
      },
      now,
    });
    expect(rec.source).toBe('unreachable');
    expect(rec.fetchError).toBe('ENOTFOUND');
    expect(rec.verdict).toBe('blind');
    expect(rec.etDay).toBe('2026-08-12');
    expect(summarizeLiveNavTripwire(1, '2026-08-12').coverage.marketDaysRecorded).toBe(1);
  });

  it('writes a BLIND row on a non-200, and does not grade the error body', async () => {
    const rec = await runLiveNavTripwireTick({
      fetchPayload: async () => ({ ok: false, status: 503, body: coveredPayload() }),
      now,
    });
    expect(rec.fetchError).toBe('http_503');
    expect(rec.verdict).toBe('blind');
  });

  it('writes a graded row on a 200, stamped with the payload time', async () => {
    const rec = await runLiveNavTripwireTick({
      fetchPayload: async () => ({ ok: true, status: 200, body: coveredPayload() }),
      now,
    });
    expect(rec.source).toBe('served');
    expect(rec.verdict).toBe('clean');
    expect(rec.payloadTime).toBe('2026-08-13T03:32:59.422Z');
    expect(rec.marketDay).toBe(true);
  });

  it('stamps the ET day, not the UTC day — a 21:20 ET assertion is not tomorrow', () => {
    // 2026-08-12T21:20 ET is 2026-08-13T01:20Z. A UTC stamp would file the Wednesday
    // session's assertion under Thursday and leave Wednesday reading `missing` forever.
    expect(liveNavEtDay(now)).toBe('2026-08-12');
    expect(new Date(now).toISOString().slice(0, 10)).toBe('2026-08-13');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3450 — `livePriorOptionsLagOk` is a VACUOUS true.
//
// The amended criterion 1: the gate alarms on BOTH (a) a real trip and (b) a post-onset
// trip-capable denominator of ZERO, and (b) is persisted as its own state, never folded into
// green. Everything below is keyed to the measurement on the live payload, which this file's
// fixtures reproduce operand-for-operand.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3450 — the denominator, and why a `true` scalar is not a pass', () => {
  it('reproduces the live census: admin 2 trip-capable pairs, BOTH pre-onset', () => {
    const books = computeLiveLagDenominators(servedPayload());
    expect(books).not.toBeNull();
    const admin = books!.find((b) => b.username === 'admin')!;
    expect(admin.onsetDate).toBe('2026-07-30');
    expect(admin.tripCapablePairs).toBe(2); // 07-25→07-28 and 07-28→07-29
    // THE finding: both of them predate the book's own live-options onset.
    expect(admin.postOnsetTripCapablePairs).toBe(0);
    expect(admin.postOnsetTripPairs).toBe(0);
    expect(admin.vacuousReason).toBe('no_post_onset_trip_capable_pairs');
  });

  it('a book that has never traded is vacuous for its OWN reason', () => {
    const books = computeLiveLagDenominators(servedPayload())!;
    const v0nni = books.find((b) => b.username === 'v0nni')!;
    expect(v0nni.onsetDate).toBeNull();
    expect(v0nni.postOnsetTripCapablePairs).toBe(0);
    // Distinct from admin's: "never opened a live option" and "opened one but never booked
    // stock P&L after it" need different remediations, so they must not share a label.
    expect(v0nni.vacuousReason).toBe('no_live_options_onset');
  });

  it('counts only LIVE books — a sandbox book cannot supply the live denominator', () => {
    // `Richard` is sandbox and carries a trip-capable series. If the census pooled it, the
    // live tripwire would read as covered off a book whose money is not real.
    const books = computeLiveLagDenominators(servedPayload())!;
    expect(books.map((b) => b.username)).toEqual(['admin', 'v0nni']);
  });

  it('grades VACUOUS — not clean — on the payload served today', () => {
    const g = gradeLiveNavTripwirePayload(
      // Coverage hole closed, so the ONLY thing left to catch is the empty denominator.
      servedPayload({ liveGradeableBookCount: 2 }),
    );
    expect(g.axes.lag.status).toBe('pass'); // the scalar says true...
    expect(g.axes.lagDenominator.status).toBe('vacuous'); // ...over nothing
    expect(g.verdict).toBe('vacuous');
    // The amendment's core ask: it is NOT green, and it raises attention. TRA-3711 moved
    // WHICH channel carries it — `vacuous` means "graded nothing", which is a coverage
    // statement, so it rides `degraded`/`attention` and not the trip channel. It is still
    // never `clean` and still never silent.
    expect(g.attention).toBe(true);
    expect(g.degraded).toBe(true);
    expect(g.alarm).toBe(false);
    expect(g.verdict).not.toBe('clean');
    expect(g.observed.postOnsetTripCapablePairs).toBe(0);
    expect(g.axes.lagDenominator.reason).toContain('admin=no_post_onset_trip_capable_pairs');
    // TRA-3952 — v0nni is outside the gate now, and the reason string still NAMES it.
    expect(g.axes.lagDenominator.reason).toContain('excluded_no_onset:v0nni');
    expect(g.lagDenominatorScope).toEqual({ graded: ['admin'], excludedNoOnset: ['v0nni'], suspectOnset: [] });
  });

  it('grades CLEAN only when every live book has a post-onset trip-capable pair', () => {
    const g = gradeLiveNavTripwirePayload(coveredPayload());
    expect(g.axes.lagDenominator).toEqual({ status: 'pass', reason: null, kind: 'coverage' });
    expect(g.verdict).toBe('clean');
    expect(g.observed.postOnsetTripCapablePairs).toBe(2); // one per live book
  });

  it('one busy book cannot cover for a silent one — the census is PER BOOK', () => {
    // admin has evidence, v0nni has an onset but no post-onset trip-capable pair. A fleet
    // SUM would read 1 > 0 and pass. (TRA-3952: v0nni carries an onset here so it is IN the
    // gate — the no-onset shape is the scoped case, tested in the TRA-3952 block below.)
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({
        engines: [
          {
            username: 'admin',
            mode: 'live',
            liveOptionsOnsetDate: '2026-07-30',
            days: TRIP_CAPABLE_DAYS,
            priorOptionsLagOk: true,
            priorOptionsLagEligibleDates: ['2026-08-12'],
          },
          {
            username: 'v0nni',
            mode: 'live',
            liveOptionsOnsetDate: '2026-08-10',
            days: V0NNI_LIVE_DAYS,
            priorOptionsLagOk: true,
            priorOptionsLagEligibleDates: [],
          },
        ],
      }),
    );
    expect(g.observed.postOnsetTripCapablePairs).toBe(1); // the sum is non-zero...
    expect(g.axes.lagDenominator.status).toBe('vacuous'); // ...and it still does not pass
    expect(g.axes.lagDenominator.reason).toBe(
      'no_post_onset_trip_capable_pairs:v0nni=no_post_onset_trip_capable_pairs',
    );
    expect(g.verdict).toBe('vacuous');
  });

  it('publishes the WEAKER eligible cohort beside it, so the two readings stay comparable', () => {
    // `priorOptionsLagEligible` needs only a non-zero PRIOR options figure, so on the live
    // data it reads 3 post-onset dates where trip-capable reads 0. Both are on the row.
    const books = computeLiveLagDenominators(
      servedPayload({
        engines: [
          {
            username: 'admin',
            mode: 'live',
            liveOptionsOnsetDate: '2026-07-30',
            days: ADMIN_LIVE_DAYS,
            priorOptionsLagOk: true,
            // The real served set: 13 eligible, of which 3 are post-onset.
            priorOptionsLagEligibleDates: ['2026-07-16', '2026-07-29', '2026-08-05', '2026-08-06', '2026-08-12'],
          },
        ],
      }),
    )!;
    expect(books[0]!.postOnsetEligiblePairs).toBe(3); // 08-05, 08-06, 08-12
    expect(books[0]!.postOnsetTripCapablePairs).toBe(0);
  });

  // ── the two states `vacuous` must never be confused with ──────────────────
  it('BLIND, not vacuous, when the census cannot be taken at all', () => {
    // No `engines` ⇒ we did not measure the denominator. "The census said zero" and "there
    // was no census" are different facts — this ticket's own lesson, one level down.
    const g = gradeLiveNavTripwirePayload(coveredPayload({ engines: undefined }));
    expect(g.axes.lagDenominator).toEqual({ status: 'blind', reason: 'engines_unreadable', kind: 'coverage' });
    expect(g.verdict).toBe('blind');
    expect(g.observed.postOnsetTripCapablePairs).toBeNull();
  });

  it('BLIND, not vacuous, on an empty live cohort', () => {
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({ engines: [{ username: 'Richard', mode: 'sandbox', days: TRIP_CAPABLE_DAYS }] }),
    );
    expect(g.axes.lagDenominator.reason).toBe('empty_live_cohort');
  });

  it('BLIND outranks VACUOUS — an unreadable operand could be hiding either', () => {
    const g = gradeLiveNavTripwirePayload(servedPayload()); // coverage blind AND denominator vacuous
    expect(g.axes.coverage.status).toBe('blind');
    expect(g.axes.lagDenominator.status).toBe('vacuous');
    expect(g.verdict).toBe('blind');
  });

  it('FAIL outranks VACUOUS — an empty denominator never downgrades a real breach', () => {
    const g = gradeLiveNavTripwirePayload(
      servedPayload({ liveGradeableBookCount: 2, livePriorOptionsLagOk: false }),
    );
    expect(g.axes.lagDenominator.status).toBe('vacuous');
    expect(g.verdict).toBe('fail');
  });

  it('FAILS when a post-onset trip exists that the served scalar did not report', () => {
    // The day rows say the predicate fired; `livePriorOptionsLagOk` says true. That is the
    // endpoint contradicting its own data, and it is louder than vacuous.
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({
        engines: [
          {
            username: 'admin',
            mode: 'live',
            liveOptionsOnsetDate: '2026-07-30',
            days: [
              { date: '2026-08-11', stockDaily: 0, optionsDaily: -16 },
              { date: '2026-08-12', stockDaily: -16, optionsDaily: 0 }, // equal to the cent
            ],
            priorOptionsLagOk: true,
            priorOptionsLagEligibleDates: ['2026-08-12'],
          },
        ],
      }),
    );
    expect(g.axes.lagDenominator).toEqual({
      status: 'fail',
      reason: 'post_onset_trip_not_reported_by_scalar',
      kind: 'coverage',
    });
    expect(g.verdict).toBe('fail');
    // TRA-3711 — the trip channel is keyed on STATUS, not on axis KIND. This axis is filed
    // `coverage` (its `vacuous` branch is what it exists for), but a `fail` on it means the
    // endpoint's own verdict contradicts its own day rows, which IS an assertion failing.
    // Gating `alarm` on `kind === 'assertion'` would have silenced exactly this.
    expect(g.alarm).toBe(true);
    expect(g.driver).toEqual({
      axis: 'lagDenominator',
      kind: 'coverage',
      status: 'fail',
      reason: 'post_onset_trip_not_reported_by_scalar',
    });
  });

  it('the ungradeable-field guard covers the denominator axis too', () => {
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({ ungradeableFields: ['ok', 'livePriorOptionsLagOk'] }),
    );
    expect(g.axes.lagDenominator.reason).toBe('operand_declared_ungradeable');
  });

  it('a missing operand on a pair is not counted as evidence', () => {
    // An absent `stockDaily` must not inflate the very denominator whose emptiness is the
    // finding — same direction as AC4: absence is never credited.
    const books = computeLiveLagDenominators(
      coveredPayload({
        engines: [
          {
            username: 'admin',
            mode: 'live',
            liveOptionsOnsetDate: '2026-07-30',
            days: [
              { date: '2026-08-11', optionsDaily: -16 },
              { date: '2026-08-12', stockDaily: null, optionsDaily: 0 },
            ],
            priorOptionsLagOk: true,
            priorOptionsLagEligibleDates: [],
          },
        ],
      }),
    )!;
    expect(books[0]!.totalPairs).toBe(1);
    expect(books[0]!.tripCapablePairs).toBe(0);
  });
});

describe('TRA-3450 — vacuity is DURABLE and distinguishable after the fact', () => {
  let dir: string;
  const T = (etDay: string): number => Date.parse(`${etDay}T21:20:00-04:00`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra3450-'));
    clearLiveNavTripwire();
    hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));
  });
  afterEach(() => {
    clearLiveNavTripwire();
    rmSync(dir, { recursive: true, force: true });
  });

  function assertOn(etDay: string, payload: unknown): void {
    recordLiveNavTripwireAssertion({
      grade: gradeLiveNavTripwirePayload(payload),
      source: 'served',
      now: T(etDay),
    });
  }

  it('survives a restart as `vacuous`, with the per-book census intact', () => {
    assertOn('2026-08-12', servedPayload({ liveGradeableBookCount: 2 }));
    clearLiveNavTripwire();
    const h = hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));
    expect(h.records).toBe(1);
    const s = summarizeLiveNavTripwire(3, '2026-08-12');
    // The verdict word itself is on disk — a reader a year from now does not have to
    // re-derive it from the operands, and could not, since the payload is gone.
    expect(s.byDay[0]!.verdict).toBe('vacuous');
    expect(s.latest!.lagDenominatorBooks.map((b) => b.username)).toEqual(['admin', 'v0nni']);
    expect(s.vacuity.vacuousBooks).toEqual([
      { username: 'admin', reason: 'no_post_onset_trip_capable_pairs' },
      { username: 'v0nni', reason: 'no_live_options_onset' },
    ]);
  });

  it('a 100%-COVERED window can still be 100% vacuous, and says so', () => {
    // The reading that TRA-3449 alone could not produce: the check ran every session and
    // graded nothing on every one of them.
    for (const d of ['2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12']) {
      assertOn(d, servedPayload({ liveGradeableBookCount: 2 }));
    }
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    expect(s.coverage.realizedCoverage).toBe(1); // ran every session
    expect(s.verdict).toBe('vacuous'); // and graded nothing on any of them
    expect(s.vacuity.sessionsVacuous).toBe(5);
    expect(s.vacuity.sessionsWithTripCapableEvidence).toBe(0);
    expect(s.vacuity.consecutiveVacuousSessions).toBe(5);
  });

  it('clears by itself the session a live book books stock P&L after an options day', () => {
    assertOn('2026-08-11', servedPayload({ liveGradeableBookCount: 2 }));
    assertOn('2026-08-12', coveredPayload());
    // Both sessions in the window are recorded, so nothing here is `missing` — this asserts
    // the vacuous→clean transition, not coverage.
    const s = summarizeLiveNavTripwire(2, '2026-08-12');
    expect(s.byDay[0]!.verdict).toBe('clean');
    expect(s.byDay[0]!.postOnsetTripCapablePairs).toBe(2);
    // Newest-first, so the streak breaks immediately on the day evidence appears.
    expect(s.vacuity.consecutiveVacuousSessions).toBe(0);
    expect(s.vacuity.sessionsWithTripCapableEvidence).toBe(1);
    // The window still carries the vacuous day — the record is not rewritten by a later pass.
    expect(s.vacuity.sessionsVacuous).toBe(1);
    expect(s.verdict).toBe('vacuous');
  });

  it('a pre-TRA-3450 row reads as an UNKNOWN census, never as a zero one', () => {
    // A row written by the shipped TRA-3449 build has no `lagDenominatorBooks` at all.
    // Defaulting its census to 0 would back-date a vacuity finding onto a day nobody
    // measured for it — manufacturing the very evidence this axis exists to demand.
    const legacy = {
      kind: 'assert',
      ts: T('2026-08-12'),
      etDay: '2026-08-12',
      marketDay: true,
      source: 'served',
      verdict: 'clean',
      alarm: false,
      axes: { lag: { status: 'pass', reason: null } },
      lagBooks: [],
      ungradedBooks: [],
      observed: { livePriorOptionsLagOk: true },
    };
    writeFileSync(liveNavTripwireLogPath(dir), JSON.stringify(legacy) + '\n', 'utf8');
    hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));
    const s = summarizeLiveNavTripwire(3, '2026-08-12');
    expect(s.byDay[0]!.verdict).toBe('clean');
    expect(s.byDay[0]!.postOnsetTripCapablePairs).toBeNull();
    expect(s.vacuity.sessionsVacuous).toBe(0);
    // Not counted as evidence either — an unknown census proves nothing in either direction.
    expect(s.vacuity.sessionsWithTripCapableEvidence).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3711 — the ALARM was pinned on, so nobody could read it.
//
// The state that filed this, from the first ever written row (2026-08-13): `lag`,
// `eodRows`, `eodTail` all `pass`; `lagDenominator` correctly `vacuous`; `coverage`
// `blind` because `v0nni` is a live book with no eligible dates and no live-options
// onset. `blind` dominates the fold, and `alarm` was `verdict !== 'clean'` — so every
// session wrote `alarm: true` on an endpoint where nothing had tripped.
//
// The evidence bar this block has to clear is the one the ticket set, and it is three
// parts, not one:
//   (a) the blind case stops consuming the trip channel;
//   (b) the DISCRIMINATING arm — a genuine assertion failure still surfaces as a trip.
//       A change that only silences (a) is a mute button, not a fix;
//   (c) the PER-CLASS split before and after, measured on the SAME rows. An invariant
//       total with a flipped class split is what a relabelling looks like from outside.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3711 — `alarm` is the TRIP channel, `degraded` is the COVERAGE channel', () => {
  it('the filing row: four axes pass, coverage is structurally blind, and NOTHING tripped', () => {
    const g = gradeLiveNavTripwirePayload(servedPayload());
    // The exact row from the ticket, re-derived rather than quoted.
    expect(g.axes.lag.status).toBe('pass');
    expect(g.axes.eodRows.status).toBe('pass');
    expect(g.axes.eodTail.status).toBe('pass');
    expect(g.axes.lagDenominator.status).toBe('vacuous');
    expect(g.axes.coverage.status).toBe('blind');
    expect(g.ungradedBooks).toEqual([{ username: 'v0nni', reason: 'no_eligible_dates' }]);

    // THE fix. The verdict lattice is untouched — `blind` still dominates, and this row is
    // still not `clean`. What changed is that `blind` no longer spends the trip signal.
    expect(g.verdict).toBe('blind');
    expect(g.alarm).toBe(false);
    expect(g.degraded).toBe(true);
    // And the union that `alarm` USED to mean is still published, so a consumer that
    // genuinely wanted "anything wrong at all" re-binds instead of silently under-alerting.
    expect(g.attention).toBe(true);

    // The aggregate publishes WHICH axis drove it and WHY — the ticket's third ask. A rule
    // binds to this, not to `verdict`, and gets a CAUSE instead of a value.
    expect(g.driver).toEqual({
      axis: 'coverage',
      kind: 'coverage',
      status: 'blind',
      reason: 'ungraded_live_books:1_of_2:no_eligible_dates',
    });
  });

  it('THE DISCRIMINATING ARM — a real trip on the same payload still fires', () => {
    // Identical fixture, identical structural coverage hole, one operand flipped. If this
    // reads `alarm: false` the change is a mute button and not a fix.
    const g = gradeLiveNavTripwirePayload(
      servedPayload({
        livePriorOptionsLagOk: false,
        livePriorOptionsLagBooks: [{ username: 'admin', dates: ['2026-08-12'] }],
      }),
    );
    expect(g.axes.coverage.status).toBe('blind'); // the hole is STILL there
    expect(g.verdict).toBe('fail');
    expect(g.alarm).toBe(true);
    expect(g.degraded).toBe(true); // both channels can be hot at once; neither masks the other
    expect(g.attention).toBe(true);
    // The driver names the TRIP, not the coverage hole sitting next to it. Precedence the
    // other way would have a reader filing a live-money NAV overstatement as an instrument
    // problem — this ticket, reproduced one level down.
    expect(g.driver).toEqual({
      axis: 'lag',
      kind: 'assertion',
      status: 'fail',
      reason: 'live_book_overstated_nav',
    });
    expect(g.lagBooks).toEqual([{ username: 'admin', dates: ['2026-08-12'] }]);
  });

  it('every assertion axis reaches the trip channel — not just `lag`', () => {
    for (const [over, axis, reason] of [
      [{ liveEodRowsPresentOk: false }, 'eodRows', 'live_book_missing_eod_row'],
      [{ liveEodTailMaxStaleSessions: 2 }, 'eodTail', 'live_book_eod_tail_stale:2'],
    ] as const) {
      const g = gradeLiveNavTripwirePayload(servedPayload(over));
      expect(g.alarm, `${axis} must raise the trip channel`).toBe(true);
      expect(g.driver).toEqual({ axis, kind: 'assertion', status: 'fail', reason });
    }
  });

  it('separates a STRUCTURAL coverage hole from a GRADER DEFECT in the axis reason', () => {
    // Both books ungraded, but for different reasons and with different remediations:
    // `no_eligible_dates` clears itself when the book fills; `ungraded` is a bug in the
    // grader and never clears on its own. A count alone cannot say which repair applies.
    const g = gradeLiveNavTripwirePayload(
      servedPayload({
        liveGradeableBookCount: 0,
        engines: [
          {
            username: 'admin',
            mode: 'live',
            priorOptionsLagOk: null,
            priorOptionsLagEligibleDates: ['2026-08-12'],
          },
          { username: 'v0nni', mode: 'live', priorOptionsLagOk: null, priorOptionsLagEligibleDates: [] },
        ],
      }),
    );
    expect(g.axes.coverage.reason).toBe('ungraded_live_books:0_of_2:no_eligible_dates+ungraded');
    // Still degraded, still not a trip — the class is published so the reader can route it,
    // not so it can be escalated into the trip channel by string matching.
    expect(g.alarm).toBe(false);
    expect(g.degraded).toBe(true);
  });

  it('REJECTED ALTERNATIVE: a `no_eligible_dates` book is NOT dropped from the coverage cohort', () => {
    // The other candidate direction was to put `v0nni` out of cohort. It is rejected, and
    // this test is the guard: `liveBookCount` stays 2, the axis stays `blind`, and the book
    // stays NAMED. Excluding it would make this axis read `pass` over a cohort of one — so
    // the session `v0nni` finally fills with a grader still returning `null`, the coverage
    // hole this axis exists to catch would be invisible. TRA-3450's exclusion was legitimate
    // because it made a denominator STRICTER and published a LOUDER state; this one would
    // make a denominator weaker and publish GREEN.
    const g = gradeLiveNavTripwirePayload(servedPayload());
    expect(g.observed.liveBookCount).toBe(2);
    expect(g.observed.liveGradeableBookCount).toBe(1);
    expect(g.axes.coverage.status).toBe('blind');
    expect(g.axes.coverage.reason).toContain('1_of_2');
    expect(g.ungradedBooks.map((b) => b.username)).toContain('v0nni');
    // And the exclusion count that a cohort change WOULD have to report is non-zero and
    // named here already, which is what made the exclusion unnecessary.
    expect(g.ungradedBooks).toHaveLength(1);
  });
});

describe('TRA-3711 — the per-class split, measured on the same rows', () => {
  const T = (etDay: string): number => Date.parse(`${etDay}T21:20:00-04:00`);
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra3711-'));
    clearLiveNavTripwire();
    hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));
    // TRA-4001 — see the AC2 block: the rowless 08-06/08-07 sessions below are meant to
    // read `missing`, which needs an observation start before the window.
    seedLiveNavObservationStartForTest(Date.parse('2026-08-05T00:00:00-04:00'));
  });
  afterEach(() => {
    clearLiveNavTripwire();
    rmSync(dir, { recursive: true, force: true });
  });

  function assertOn(etDay: string, payload: unknown): void {
    recordLiveNavTripwireAssertion({
      grade: gradeLiveNavTripwirePayload(payload),
      source: 'served',
      now: T(etDay),
    });
  }

  /**
   * The PRE-TRA-3711 rule, reconstructed from published fields rather than remembered:
   * `alarm` was exactly `verdict !== 'clean'`. Computing it off `byDay[].verdict` means the
   * before/after comparison is made on the SAME rows by the SAME reader, so a difference
   * cannot be an artefact of two different denominators.
   */
  function oldRuleAlarmingSessions(s: ReturnType<typeof summarizeLiveNavTripwire>): number {
    return s.byDay.filter((d) => d.marketDay && d.verdict !== 'clean').length;
  }

  it('BEFORE/AFTER: 5 alarming sessions become 0 TRIPS and 5 DEGRADED — total invariant', () => {
    // Every session in the window carries the real served row: structurally blind coverage,
    // every assertion passing. This is the state that will hold for as long as `v0nni` has
    // no live-options onset, i.e. indefinitely.
    for (const d of ['2026-08-06', '2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12']) {
      assertOn(d, servedPayload());
    }
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    expect(s.coverage.marketDaysRecorded).toBe(5);

    // BEFORE: every one of the 5 raised the alarm.
    expect(oldRuleAlarmingSessions(s)).toBe(5);

    // AFTER: the same 5 sessions, re-classified. The TOTAL is invariant — which is exactly
    // why the total is not the evidence. The SPLIT is.
    expect(s.signalClasses).toEqual({
      sessionsTrip: 0,
      sessionsDegradedOnly: 5,
      sessionsClean: 0,
      sessionsAttention: 5,
    });
    expect(s.signalClasses.sessionsAttention).toBe(oldRuleAlarmingSessions(s));
    expect(s.alarm).toBe(false);
    expect(s.degraded).toBe(true);
    expect(s.driver?.axis).toBe('coverage');
    expect(s.driver?.reason).toBe('ungraded_live_books:1_of_2:no_eligible_dates');
  });

  it('BEFORE/AFTER: one real trip among four blind sessions is now the ONLY thing in the trip class', () => {
    for (const d of ['2026-08-06', '2026-08-07', '2026-08-10', '2026-08-12']) {
      assertOn(d, servedPayload());
    }
    assertOn('2026-08-11', servedPayload({ livePriorOptionsLagOk: false }));

    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    // BEFORE: 5 of 5 alarming — the trip is INDISTINGUISHABLE from the four blind days.
    // That is the failure mode in one line.
    expect(oldRuleAlarmingSessions(s)).toBe(5);

    // AFTER: exactly one session is in the trip class, and it is the right one.
    expect(s.signalClasses).toEqual({
      sessionsTrip: 1,
      sessionsDegradedOnly: 4,
      sessionsClean: 0,
      sessionsAttention: 5,
    });
    expect(s.alarm).toBe(true);
    expect(s.lastFailDay).toBe('2026-08-11');
    expect(s.byDay.filter((d) => d.alarm).map((d) => d.etDay)).toEqual(['2026-08-11']);
    // The window driver is the TRIP, not one of the four coverage holes outranking it.
    expect(s.driver).toEqual({
      axis: 'lag',
      kind: 'assertion',
      status: 'fail',
      reason: 'live_book_overstated_nav',
    });
  });

  it('the three classes PARTITION the sessions — no row can fall out of the split', () => {
    assertOn('2026-08-10', coveredPayload()); // clean
    assertOn('2026-08-11', servedPayload()); // degraded
    assertOn('2026-08-12', coveredPayload({ livePriorOptionsLagOk: false })); // trip
    // 08-06 and 08-07 have no row at all -> degraded via `missing`.
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    const c = s.signalClasses;
    expect(c.sessionsTrip + c.sessionsDegradedOnly + c.sessionsClean).toBe(
      s.coverage.marketDaysExpected,
    );
    expect(c).toEqual({
      sessionsTrip: 1,
      sessionsDegradedOnly: 3,
      sessionsClean: 1,
      sessionsAttention: 4,
    });
  });

  it('a row written BEFORE this fix re-reads under the new rule, not under its stored boolean', () => {
    // The 2026-08-13 row is already on disk in production, carrying the OLD union
    // `alarm: true`. If the summary echoed that stored field, the pinned alarm would
    // survive the very deploy that fixes it — and the endpoint would report exactly what it
    // reported yesterday. The channels are derived from `axes`, which is the primitive.
    const legacy = {
      kind: 'assert',
      ts: T('2026-08-12'),
      etDay: '2026-08-12',
      marketDay: true,
      source: 'served',
      verdict: 'blind',
      alarm: true, // <- the stored pre-TRA-3711 value
      axes: {
        lag: { status: 'pass', reason: null },
        coverage: { status: 'blind', reason: 'ungraded_live_books:1_of_2' },
        eodRows: { status: 'pass', reason: null },
        eodTail: { status: 'pass', reason: null },
        lagDenominator: {
          status: 'vacuous',
          reason: 'no_post_onset_trip_capable_pairs:v0nni=no_live_options_onset',
        },
      },
      lagBooks: [],
      ungradedBooks: [{ username: 'v0nni', reason: 'no_eligible_dates' }],
      observed: { livePriorOptionsLagOk: true },
    };
    writeFileSync(liveNavTripwireLogPath(dir), JSON.stringify(legacy) + '\n', 'utf8');
    hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));

    const day = summarizeLiveNavTripwire(1, '2026-08-12').byDay[0]!;
    expect(day.verdict).toBe('blind'); // the persisted verdict is untouched
    expect(day.alarm).toBe(false); // ...and the stored `alarm: true` is NOT echoed
    expect(day.degraded).toBe(true);
    expect(day.attention).toBe(true);
    // The axis kind is re-derived from the axis NAME, so an old row with no `kind` field
    // classifies identically to a fresh one — no migration, no back-filled guess.
    expect(day.driver).toEqual({
      axis: 'coverage',
      kind: 'coverage',
      status: 'blind',
      reason: 'ungraded_live_books:1_of_2',
    });
  });

  it('an axis this build does not know about still counts in the fold', () => {
    // Forward-compat: a newer writer adds a sixth axis and an older reader hydrates the row.
    // Dropping the unknown axis would let a future FAIL read as clean on an old process —
    // the same silent-degradation class the ungradeable-field guard exists for.
    const future = {
      kind: 'assert',
      ts: T('2026-08-12'),
      etDay: '2026-08-12',
      marketDay: true,
      source: 'served',
      verdict: 'fail',
      alarm: true,
      axes: {
        lag: { status: 'pass', reason: null },
        coverage: { status: 'pass', reason: null },
        eodRows: { status: 'pass', reason: null },
        eodTail: { status: 'pass', reason: null },
        lagDenominator: { status: 'pass', reason: null },
        someNewAxis: { status: 'fail', reason: 'a_thing_this_build_never_heard_of' },
      },
      lagBooks: [],
      ungradedBooks: [],
      observed: { livePriorOptionsLagOk: true },
    };
    writeFileSync(liveNavTripwireLogPath(dir), JSON.stringify(future) + '\n', 'utf8');
    hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));
    const day = summarizeLiveNavTripwire(1, '2026-08-12').byDay[0]!;
    expect(day.alarm).toBe(true);
    expect(day.driver?.axis).toBe('someNewAxis');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3952 — the `lagDenominator` ANY-gate is SCOPED to live books with an onset.
//
// Decision of record (option (a) of TRA-3952). A live book with no live-options onset and
// no options P&L in any row has no lag predicate to grade: the predicate is about options
// money leaking into the stock leg, and the book has never held any. Holding the whole axis
// `vacuous` on it left the axis with NO reachable `pass` off any repair and NO terminating
// event anyone on the board controls (v0nni's first-ever live option). The set-aside books
// are published by NAME on every row — scoping is not silent exclusion — and a no-onset
// book that DOES carry options P&L is a contradicted onset operand and grades `blind`.
describe('TRA-3952 — the ANY-gate runs over books WITH an onset; the rest are named, not dropped', () => {
  const T = (etDay: string): number => Date.parse(`${etDay}T21:20:00-04:00`);
  const ADMIN_TRIP_CAPABLE = {
    username: 'admin',
    mode: 'live',
    liveOptionsOnsetDate: '2026-07-30',
    days: TRIP_CAPABLE_DAYS,
    priorOptionsLagOk: true,
    priorOptionsLagEligibleDates: ['2026-08-12'],
  };
  const V0NNI_NO_ONSET = {
    username: 'v0nni',
    mode: 'live',
    liveOptionsOnsetDate: null,
    days: V0NNI_LIVE_DAYS,
    priorOptionsLagOk: true,
    priorOptionsLagEligibleDates: [],
  };

  it('a never-traded live book is EXCLUDED from the gate and the axis can now PASS off admin', () => {
    const g = gradeLiveNavTripwirePayload(coveredPayload({ engines: [ADMIN_TRIP_CAPABLE, V0NNI_NO_ONSET] }));
    expect(g.axes.lagDenominator).toEqual({ status: 'pass', reason: null, kind: 'coverage' });
    expect(g.observed.postOnsetTripCapablePairs).toBe(1);
    expect(g.verdict).toBe('clean');
    // ...and the excluded book is on the row by name, not averaged away.
    expect(g.lagDenominatorScope).toEqual({ graded: ['admin'], excludedNoOnset: ['v0nni'], suspectOnset: [] });
    const v0nni = g.lagDenominatorBooks.find((b) => b.username === 'v0nni')!;
    expect(v0nni.lagScope).toBe('excluded_no_onset');
    expect(v0nni.optionsPnlRows).toBe(0);
    expect(v0nni.vacuousReason).toBe('no_live_options_onset'); // the per-book reading is unchanged
  });

  it('an EMPTY graded cohort is VACUOUS, never pass — the gate over nothing is not a gate', () => {
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({ engines: [{ ...V0NNI_NO_ONSET, username: 'admin' }, V0NNI_NO_ONSET] }),
    );
    expect(g.axes.lagDenominator.status).toBe('vacuous');
    expect(g.axes.lagDenominator.reason).toBe('no_live_book_with_options_onset;excluded_no_onset:admin,v0nni');
    expect(g.lagDenominatorScope.graded).toEqual([]);
    expect(g.verdict).toBe('vacuous');
  });

  it('a no-onset book carrying options P&L is a SUSPECT onset derivation and grades BLIND', () => {
    // The offender-only-cohort mistake one field over: if onset derivation broke, the book
    // it broke on must NOT quietly leave the cohort. Options P&L with no onset is that
    // contradiction, and it outranks both the pass admin would otherwise earn and vacuous.
    const suspect = {
      ...V0NNI_NO_ONSET,
      days: [
        { date: '2026-08-11', stockDaily: 0, optionsDaily: -16 },
        { date: '2026-08-12', stockDaily: 0, optionsDaily: 0 },
      ],
    };
    const g = gradeLiveNavTripwirePayload(coveredPayload({ engines: [ADMIN_TRIP_CAPABLE, suspect] }));
    expect(g.axes.lagDenominator).toEqual({
      status: 'blind',
      reason: 'onset_derivation_suspect:v0nni',
      kind: 'coverage',
    });
    expect(g.verdict).toBe('blind');
    expect(g.alarm).toBe(false); // a hole in the instrument, not a trip
    expect(g.degraded).toBe(true);
    expect(g.lagDenominatorScope).toEqual({ graded: ['admin'], excludedNoOnset: [], suspectOnset: ['v0nni'] });
    expect(g.lagDenominatorBooks.find((b) => b.username === 'v0nni')!.optionsPnlRows).toBe(1);
  });

  it('the suspect guard reads EVERY row, including the first one the pair loop skips', () => {
    const suspect = {
      ...V0NNI_NO_ONSET,
      days: [{ date: '2026-08-11', stockDaily: 0, optionsDaily: 3.25 }],
    };
    const g = gradeLiveNavTripwirePayload(coveredPayload({ engines: [ADMIN_TRIP_CAPABLE, suspect] }));
    expect(g.axes.lagDenominator.status).toBe('blind');
    expect(g.lagDenominatorScope.suspectOnset).toEqual(['v0nni']);
  });

  it('dust under the cent tolerance does not make a book suspect', () => {
    const dust = {
      ...V0NNI_NO_ONSET,
      days: [{ date: '2026-08-11', stockDaily: 0, optionsDaily: 0.004 }, ...V0NNI_LIVE_DAYS],
    };
    const g = gradeLiveNavTripwirePayload(coveredPayload({ engines: [ADMIN_TRIP_CAPABLE, dust] }));
    expect(g.lagDenominatorScope.excludedNoOnset).toEqual(['v0nni']);
    expect(g.axes.lagDenominator.status).toBe('pass');
  });

  it('a graded book at zero STILL holds the axis vacuous, and the excluded bucket rides the reason', () => {
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({
        engines: [
          { ...ADMIN_TRIP_CAPABLE, days: ADMIN_LIVE_DAYS, priorOptionsLagEligibleDates: ['2026-08-12'] },
          V0NNI_NO_ONSET,
        ],
      }),
    );
    expect(g.axes.lagDenominator.status).toBe('vacuous');
    expect(g.axes.lagDenominator.reason).toBe(
      'no_post_onset_trip_capable_pairs:admin=no_post_onset_trip_capable_pairs;excluded_no_onset:v0nni',
    );
  });

  it('a post-onset trip the scalar did not report still FAILS under scoping, bucket named', () => {
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({
        engines: [
          {
            ...ADMIN_TRIP_CAPABLE,
            days: [
              { date: '2026-08-11', stockDaily: 0, optionsDaily: -16 },
              { date: '2026-08-12', stockDaily: -16, optionsDaily: 0 },
            ],
          },
          V0NNI_NO_ONSET,
        ],
        livePriorOptionsLagOk: true,
      }),
    );
    expect(g.axes.lagDenominator.status).toBe('fail');
    expect(g.axes.lagDenominator.reason).toBe('post_onset_trip_not_reported_by_scalar;excluded_no_onset:v0nni');
  });

  it('the health summary publishes the latest scope, and reads null on a pre-TRA-3952 row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-nav-3952-'));
    try {
      hydrateLiveNavTripwireFromDisk(dir, T('2026-08-13'));
      recordLiveNavTripwireAssertion({
        grade: gradeLiveNavTripwirePayload(coveredPayload({ engines: [ADMIN_TRIP_CAPABLE, V0NNI_NO_ONSET] })),
        source: 'served',
        now: T('2026-08-12'),
      });
      const s = summarizeLiveNavTripwire(1, '2026-08-12');
      expect(s.vacuity.latestScope).toEqual({ graded: ['admin'], excludedNoOnset: ['v0nni'], suspectOnset: [] });
      expect(s.byDay[0]!.verdict).toBe('clean');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const legacyDir = mkdtempSync(join(tmpdir(), 'live-nav-3952-legacy-'));
    try {
      const legacy = {
        kind: 'assert',
        ts: T('2026-08-12'),
        etDay: '2026-08-12',
        marketDay: true,
        source: 'served',
        verdict: 'vacuous',
        alarm: false,
        axes: {
          lag: { status: 'pass', reason: null },
          coverage: { status: 'pass', reason: null },
          eodRows: { status: 'pass', reason: null },
          eodTail: { status: 'pass', reason: null },
          lagDenominator: { status: 'vacuous', reason: 'no_post_onset_trip_capable_pairs:v0nni=no_live_options_onset' },
        },
        lagBooks: [],
        ungradedBooks: [],
        lagDenominatorBooks: [
          { username: 'v0nni', onsetDate: null, totalPairs: 1, tripCapablePairs: 0, postOnsetTripCapablePairs: 0, postOnsetTripPairs: 0, postOnsetEligiblePairs: 0, vacuousReason: 'no_live_options_onset' },
        ],
        observed: { livePriorOptionsLagOk: true, postOnsetTripCapablePairs: 0 },
      };
      writeFileSync(liveNavTripwireLogPath(legacyDir), JSON.stringify(legacy) + '\n', 'utf8');
      hydrateLiveNavTripwireFromDisk(legacyDir, T('2026-08-13'));
      const s = summarizeLiveNavTripwire(1, '2026-08-12');
      // A cohort-complete row is not rewritten into a scoped one after the fact.
      expect(s.vacuity.latestScope).toBeNull();
      expect(s.byDay[0]!.verdict).toBe('vacuous');
      expect(s.vacuity.vacuousBooks).toEqual([{ username: 'v0nni', reason: 'no_live_options_onset' }]);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3947 — the watcher rule "PASS-live vs FAIL-A" has one UNSATISFIABLE half.
//
// TRA-3712's observer registered two outcomes on this axis, both branching on
// `postOnsetTripCapablePairs > 0`:
//
//   PASS-live  `lagDenominator.status` is `pass` AND the row's pairs read > 0
//   FAIL-A     `lagDenominator.status` is `pass` WHILE the row's pairs read {0, null}
//              — "the axis claimed clean while inert"
//
// FAIL-A cannot happen. It is not untested, it is UNSATISFIABLE, and the proof is two
// lines of this module: `vacuousReason === null` iff `postOnsetTripCapablePairs > 0`
// (per book), and the axis only reaches `pass` when NO book carries a `vacuousReason`.
// The published scalar is the SUM of the same per-book counts, and the empty-cohort
// branch guarantees at least one term, so `pass` forces the sum to >= 1. `null` is
// likewise reachable only when the census could not be taken, which is `blind`.
//
// That is good news about the instrument and BAD news about the rule: an alarm keyed
// to FAIL-A is a control that can never fire, so it can never be evidence. Its real
// content is an INVARIANT of this grader, and the honest place to hold an invariant is
// a test that goes red the day a refactor breaks it — at which point FAIL-A becomes
// reachable and someone has to re-decide. That is what this block is.
//
// ⚠ Scope: writer-side. The byDay READER can present (`pass`, `null`) off a disk row
// this build did not write — the forward-compat test above ('an axis this build has
// never heard of...') constructs exactly that shape by hand. No payload can make the
// grader emit it.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3947 — FAIL-A is unsatisfiable, and that is an invariant, not a passing run', () => {
  /** One live book per distinct denominator outcome the census can produce. */
  const BOOK_SHAPES: Record<string, Record<string, unknown>> = {
    // pairs 1, no trip — the only shape that can carry the axis to `pass`.
    tripCapable: {
      liveOptionsOnsetDate: '2026-07-30',
      days: TRIP_CAPABLE_DAYS,
      priorOptionsLagEligibleDates: ['2026-08-12'],
    },
    // pairs 0, `no_live_options_onset` — v0nni, live and never opened an option.
    noOnset: {
      liveOptionsOnsetDate: null,
      days: V0NNI_LIVE_DAYS,
      priorOptionsLagEligibleDates: [],
    },
    // pairs 0, `no_post_onset_trip_capable_pairs` — admin, whose 2 trip-capable pairs
    // both predate its own onset. NOTE its `postOnsetEligiblePairs` is NON-zero, which
    // is what makes it the discriminating row for the control at the bottom.
    onsetNoPairs: {
      liveOptionsOnsetDate: '2026-07-30',
      days: ADMIN_LIVE_DAYS,
      priorOptionsLagEligibleDates: ['2026-08-05', '2026-08-06', '2026-08-12'],
    },
    // pairs 1 AND the predicate fires — drives the axis's one reachable `fail`.
    tripping: {
      liveOptionsOnsetDate: '2026-07-30',
      days: [
        { date: '2026-08-11', stockDaily: 0, optionsDaily: -16 },
        { date: '2026-08-12', stockDaily: -16, optionsDaily: 0 },
      ],
      priorOptionsLagEligibleDates: ['2026-08-12'],
    },
  };
  const SHAPE_KEYS = Object.keys(BOOK_SHAPES);

  function book(shape: string, username: string): Record<string, unknown> {
    return { username, mode: 'live', priorOptionsLagOk: true, ...BOOK_SHAPES[shape]! };
  }

  /**
   * Every live cohort of size 1 and 2 over the shapes above, plus the three ways the
   * census itself can be un-takeable. Enumerated rather than sampled: the space is
   * small enough to cover exhaustively, and a sampled space can miss the one cell that
   * matters — which is the whole complaint TRA-3947 is making one level up.
   */
  function cohorts(): Array<{ label: string; engines: unknown }> {
    const out: Array<{ label: string; engines: unknown }> = [];
    for (const a of SHAPE_KEYS) out.push({ label: a, engines: [book(a, 'admin')] });
    for (const a of SHAPE_KEYS) {
      for (const b of SHAPE_KEYS) {
        out.push({ label: `${a}+${b}`, engines: [book(a, 'admin'), book(b, 'v0nni')] });
      }
    }
    out.push({ label: 'sandbox-only', engines: [{ username: 'Richard', mode: 'sandbox', days: TRIP_CAPABLE_DAYS }] });
    out.push({ label: 'engines-absent', engines: undefined });
    out.push({ label: 'engines-not-an-array', engines: 'nope' });
    return out;
  }

  /** Every payload this grader can be handed, as (label, payload) pairs. */
  function space(): Array<{ label: string; payload: unknown }> {
    const out: Array<{ label: string; payload: unknown }> = [];
    for (const c of cohorts()) {
      for (const scalar of [true, false, null, 'not-a-boolean']) {
        for (const disowned of [false, true]) {
          out.push({
            label: `${c.label}|scalar=${String(scalar)}|disowned=${disowned}`,
            payload: coveredPayload({
              engines: c.engines,
              livePriorOptionsLagOk: scalar,
              ungradeableFields: disowned ? ['ok', 'livePriorOptionsLagOk'] : ['ok'],
            }),
          });
        }
      }
    }
    // Not-an-object payloads, which must never reach a per-book branch at all.
    for (const p of [null, 42, 'payload', undefined]) out.push({ label: `raw=${String(p)}`, payload: p });
    return out;
  }

  it('no payload in the whole space produces FAIL-A (`pass` while pairs read 0 or null)', () => {
    const offenders: string[] = [];
    for (const { label, payload } of space()) {
      const g = gradeLiveNavTripwirePayload(payload);
      const pairs = g.observed.postOnsetTripCapablePairs;
      if (g.axes.lagDenominator.status === 'pass' && (pairs === null || pairs === 0)) {
        offenders.push(`${label} -> pairs=${String(pairs)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('and the space is not vacuously clean — every graded class is actually reached', () => {
    // `every`/`some` over an empty or one-sided cohort is the failure this file exists
    // to stop. If a refactor narrows the enumeration until `pass` is never produced,
    // the assertion above becomes a green that proves nothing. This is its denominator.
    const seen = { pass: 0, vacuous: 0, blind: 0, fail: 0 };
    const pairsSeen = { positive: 0, zero: 0, nullish: 0 };
    for (const { payload } of space()) {
      const g = gradeLiveNavTripwirePayload(payload);
      seen[g.axes.lagDenominator.status as keyof typeof seen] += 1;
      const pairs = g.observed.postOnsetTripCapablePairs;
      if (pairs === null) pairsSeen.nullish += 1;
      else if (pairs > 0) pairsSeen.positive += 1;
      else pairsSeen.zero += 1;
    }
    expect(seen.pass).toBeGreaterThan(0);
    expect(seen.vacuous).toBeGreaterThan(0);
    expect(seen.blind).toBeGreaterThan(0);
    expect(seen.fail).toBeGreaterThan(0);
    expect(pairsSeen.positive).toBeGreaterThan(0);
    expect(pairsSeen.zero).toBeGreaterThan(0);
    expect(pairsSeen.nullish).toBeGreaterThan(0);
  });

  it('PASS-live, the reachable half: `pass` always ships a pairs count of at least one', () => {
    let graded = 0;
    for (const { label, payload } of space()) {
      const g = gradeLiveNavTripwirePayload(payload);
      if (g.axes.lagDenominator.status !== 'pass') continue;
      graded += 1;
      expect(g.observed.postOnsetTripCapablePairs, label).not.toBeNull();
      expect(g.observed.postOnsetTripCapablePairs!, label).toBeGreaterThanOrEqual(1);
    }
    expect(graded).toBeGreaterThan(0);
  });

  it('a null pairs count is BLIND, never a grade — "no census" is not "the census said zero"', () => {
    let graded = 0;
    for (const { label, payload } of space()) {
      const g = gradeLiveNavTripwirePayload(payload);
      if (g.observed.postOnsetTripCapablePairs !== null) continue;
      graded += 1;
      expect(g.axes.lagDenominator.status, label).toBe('blind');
    }
    expect(graded).toBeGreaterThan(0);
  });

  // ── the positive control ──────────────────────────────────────────────────
  //
  // An invariant test that cannot go red is the same vacuous green one level up. So:
  // replay the SAME space against the mutation this axis is most likely to suffer, and
  // require FAIL-A to become reachable.
  //
  // The mutation is not invented. `postOnsetEligiblePairs` and `postOnsetTripCapablePairs`
  // are published side by side on every book precisely BECAUSE they diverge, and on the
  // live payload they read 4 and 0 on `admin`. Keying the vacuity test to the eligible
  // count — the weaker cohort, and the one a reader reaches for when asking "was there
  // anything to grade?" — makes the axis pass on a book whose PUBLISHED denominator is
  // still 0. That is FAIL-A exactly: clean over nothing, with the receipt still on the row.
  it('CONTROL — key the vacuity test to the ELIGIBLE count and FAIL-A becomes reachable', () => {
    const offenders: string[] = [];
    for (const { label, payload } of space()) {
      const real = gradeLiveNavTripwirePayload(payload);
      const denominators = computeLiveLagDenominators(payload);
      // Re-derive ONLY the vacuity branch under the wrong operand. Everything else —
      // the published pairs scalar, the blind screens — stays as shipped, so the mutant
      // differs from the real grader in exactly one variable.
      if (denominators === null || denominators.length === 0) continue;
      if (real.axes.lagDenominator.status === 'blind') continue;
      const mutantPass = denominators.every((b) => b.postOnsetEligiblePairs > 0);
      const pairs = real.observed.postOnsetTripCapablePairs;
      if (mutantPass && (pairs === null || pairs === 0)) offenders.push(`${label} -> pairs=${String(pairs)}`);
    }
    // If this ever reads empty, the control has stopped biting and the assertion above
    // is no longer evidence — fix the control before trusting the green.
    expect(offenders.length).toBeGreaterThan(0);
  });
});

// ── TRA-4001 — the coverage axis has an observation start, and a session is only owed once DUE ──

describe('TRA-4001 — observation-start marker, DUE sessions, and the NOT MEASURED bucket', () => {
  /**
   * The served state at 2026-08-25T18:43:21Z, reconstructed row for row: 12 served rows on
   * EVERY calendar day 2026-08-13..2026-08-24 (the archive fires daily, weekends included),
   * each written at the writer's real slot (~21:00:50 ET), `appendErrors 0`. The reading the
   * route gave for it was `WRITER DOWN - 1 consecutive session(s)` and `realizedCoverage
   * 0.25` (8/32). This block pins what it must read instead, and — so the repaired axis is
   * not itself unfalsifiable — what it must STILL read when a row is genuinely lost.
   */
  const LEDGER_DAYS = [
    '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18',
    '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24',
  ];
  /** The 23 sessions 2026-07-13..2026-08-12 that PREDATE the ledger. */
  const PRE_LEDGER_SESSION_COUNT = 23;
  /** The 8 sessions inside the ledger's life: 08-13, 14, 17, 18, 19, 20, 21, 24. */
  const LEDGER_SESSIONS = ['2026-08-24', '2026-08-21', '2026-08-20', '2026-08-19', '2026-08-18', '2026-08-17', '2026-08-14', '2026-08-13'];
  /** The filing pull: 2026-08-25 14:43 ET, ~6h before the writer's slot. */
  const PULL_NOW = Date.parse('2026-08-25T18:43:21Z');
  /** First boot of the build carrying this fix, well after the ledger's first row. */
  const POST_DEPLOY_BOOT = Date.parse('2026-08-26T03:00:00Z');
  const writerSlot = (etDay: string): number => Date.parse(`${etDay}T21:00:50-04:00`);

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra4001-'));
    clearLiveNavTripwire();
  });
  afterEach(() => {
    clearLiveNavTripwire();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write the production ledger to disk, then boot against it the way index.ts does. */
  function bootProductionLedger(opts: { drop?: string[]; tear?: string[] } = {}): void {
    hydrateLiveNavTripwireFromDisk(dir, Date.parse('2026-08-13T00:00:00Z'));
    seedLiveNavObservationStartForTest(null);
    for (const d of LEDGER_DAYS) {
      recordLiveNavTripwireAssertion({
        grade: gradeLiveNavTripwirePayload(servedPayload()),
        source: 'served',
        payloadTime: new Date(writerSlot(d)).toISOString(),
        now: writerSlot(d),
      });
    }
    // Reshape the file on disk, then hydrate it fresh — the marker written by the boot
    // above is deleted so the post-deploy boot creates its own, later, marker exactly as
    // the first boot of this build will on bqb1.
    const path = liveNavTripwireLogPath(dir);
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const kept = lines
      .filter((l) => !(opts.drop ?? []).some((d) => l.includes(`"etDay":"${d}"`)))
      .map((l) => ((opts.tear ?? []).some((d) => l.includes(`"etDay":"${d}"`)) ? l.slice(0, 40) : l));
    writeFileSync(path, kept.join('\n') + '\n', 'utf8');
    rmSync(liveNavObservationStartPath(dir), { force: true });
    clearLiveNavTripwire();
    hydrateLiveNavTripwireFromDisk(dir, POST_DEPLOY_BOOT);
  }

  it('DUE is 21:00 ET plus grace, DST-aware', () => {
    expect(liveNavEtWallClockToUtcMs('2026-08-25', 21)).toBe(Date.parse('2026-08-26T01:00:00Z')); // EDT
    expect(liveNavEtWallClockToUtcMs('2026-12-01', 21)).toBe(Date.parse('2026-12-02T02:00:00Z')); // EST
    expect(liveNavWriterDueAtMs('2026-08-25')).toBe(
      Date.parse('2026-08-26T01:00:00Z') + LIVE_NAV_WRITER_DUE_GRACE_MS,
    );
  });

  it('NEGATIVE CONTROL — the filing pull reads 100% realized coverage, today PENDING, 23 NOT MEASURED, no writer driver', () => {
    bootProductionLedger();
    const s = summarizeLiveNavTripwire(45, undefined, PULL_NOW);

    // The observation start is the ledger's FIRST ROW, not the post-deploy boot — the MIN
    // fold keeps the twelve days already on disk inside the window.
    expect(s.observation).toMatchObject({ startEtDay: '2026-08-13', source: 'first_row', firstRowEtDay: '2026-08-13' });
    expect(s.observation?.marker).toMatchObject({ boots: 1, firstBootEtDay: '2026-08-25' });

    expect(s.coverage.marketDaysInWindow).toBe(32);
    expect(s.coverage.marketDaysNotMeasured).toHaveLength(PRE_LEDGER_SESSION_COUNT);
    expect(s.coverage.marketDaysNotMeasured[0]).toBe('2026-08-12');
    expect(s.coverage.marketDaysNotMeasured.at(-1)).toBe('2026-07-13');
    expect(s.coverage.marketDaysPending).toEqual(['2026-08-25']);
    expect(s.coverage.marketDaysMissing).toEqual([]);
    expect(s.coverage.marketDaysExpected).toBe(8);
    expect(s.coverage.marketDaysRecorded).toBe(8);
    expect(s.coverage.realizedCoverage).toBe(1);
    expect(s.consecutiveMissingSessions).toBe(0);
    // The four buckets partition the calendar sessions.
    expect(
      s.coverage.marketDaysRecorded +
        s.coverage.marketDaysMissing.length +
        s.coverage.marketDaysPending.length +
        s.coverage.marketDaysNotMeasured.length,
    ).toBe(s.coverage.marketDaysInWindow);
    // ...and so do the signal classes, over the MEASURED denominator.
    const c = s.signalClasses;
    expect(c.sessionsTrip + c.sessionsDegradedOnly + c.sessionsClean).toBe(s.coverage.marketDaysExpected);

    // The writer driver must be nowhere in the window. What IS there is the real state:
    // every row is coverage-blind on v0nni, which is a different finding (TRA-3711).
    expect(s.driver?.axis).not.toBe('writer');
    expect(s.byDay.filter((d) => d.driver?.axis === 'writer')).toEqual([]);

    const today = s.byDay.find((d) => d.etDay === '2026-08-25')!;
    expect(today).toMatchObject({
      marketDay: true,
      bucket: 'pending',
      verdict: 'pending',
      alarm: false,
      degraded: false,
      attention: false,
      driver: null,
      dueAt: '2026-08-26T01:30:00.000Z',
    });
    const preLedger = s.byDay.find((d) => d.etDay === '2026-08-12')!;
    expect(preLedger).toMatchObject({ bucket: 'not_measured', verdict: 'not_measured', attention: false, driver: null });
    // Not measured is NOT clean either — no pre-observation session may read as a pass.
    expect(s.byDay.filter((d) => d.marketDay && d.verdict === 'clean')).toEqual([]);
    for (const d of LEDGER_SESSIONS) {
      expect(s.byDay.find((x) => x.etDay === d)?.bucket).toBe('recorded');
    }
  });

  it('POSITIVE CONTROL — one served row DELETED inside the window is EXACTLY one missing DUE session', () => {
    bootProductionLedger({ drop: ['2026-08-19'] });
    const s = summarizeLiveNavTripwire(45, undefined, PULL_NOW);
    expect(s.coverage.marketDaysMissing).toEqual(['2026-08-19']);
    expect(s.coverage.marketDaysExpected).toBe(8);
    expect(s.coverage.marketDaysRecorded).toBe(7);
    expect(s.coverage.realizedCoverage).toBeCloseTo(7 / 8);
    expect(s.coverage.marketDaysPending).toEqual(['2026-08-25']);
    expect(s.coverage.marketDaysNotMeasured).toHaveLength(PRE_LEDGER_SESSION_COUNT);
    // The lost session is named, loud, and on the coverage channel — not the trip channel.
    const lost = s.byDay.find((d) => d.etDay === '2026-08-19')!;
    expect(lost).toMatchObject({
      bucket: 'missing',
      verdict: 'missing',
      alarm: false,
      degraded: true,
      attention: true,
      driver: { axis: 'writer', kind: 'coverage', status: 'blind', reason: 'no_assertion_row' },
    });
    // 08-24 is recorded, so the writer is not down NOW — a historical miss is not a live one.
    expect(s.consecutiveMissingSessions).toBe(0);
  });

  it('POSITIVE CONTROL — one served row TORN on disk reads the same as a deleted one', () => {
    bootProductionLedger({ tear: ['2026-08-19'] });
    expect(readFileSync(liveNavTripwireLogPath(dir), 'utf8').trim().split('\n')).toHaveLength(11); // compacted
    const s = summarizeLiveNavTripwire(45, undefined, PULL_NOW);
    expect(s.coverage.marketDaysMissing).toEqual(['2026-08-19']);
    expect(s.coverage.marketDaysRecorded).toBe(7);
    expect(s.durability.hydratedRecords).toBe(11);
  });

  it('POSITIVE CONTROL — the LATEST due session lost is WRITER DOWN 1, with the writer as window driver', () => {
    bootProductionLedger({ drop: ['2026-08-24'] });
    const s = summarizeLiveNavTripwire(45, undefined, PULL_NOW);
    expect(s.coverage.marketDaysMissing).toEqual(['2026-08-24']);
    // Today is pending and is stepped OVER, not counted and not a break.
    expect(s.coverage.marketDaysPending).toEqual(['2026-08-25']);
    expect(s.consecutiveMissingSessions).toBe(1);
    expect(s.driver).toEqual({ axis: 'writer', kind: 'coverage', status: 'blind', reason: 'no_assertion_row' });
    expect(s.degraded).toBe(true);
    expect(s.alarm).toBe(false);
  });

  it('the DUE boundary: today is PENDING one second before its slot+grace and MISSING at it', () => {
    bootProductionLedger();
    const dueAt = liveNavWriterDueAtMs('2026-08-25');
    const before = summarizeLiveNavTripwire(45, undefined, dueAt - 1_000);
    expect(before.coverage.marketDaysPending).toEqual(['2026-08-25']);
    expect(before.coverage.marketDaysMissing).toEqual([]);
    expect(before.consecutiveMissingSessions).toBe(0);
    expect(before.coverage.realizedCoverage).toBe(1);

    const at = summarizeLiveNavTripwire(45, undefined, dueAt);
    expect(at.coverage.marketDaysPending).toEqual([]);
    expect(at.coverage.marketDaysMissing).toEqual(['2026-08-25']);
    expect(at.consecutiveMissingSessions).toBe(1);
    expect(at.coverage.marketDaysExpected).toBe(9);
    expect(at.coverage.realizedCoverage).toBeCloseTo(8 / 9);
    expect(at.driver?.axis).toBe('writer');
  });

  it('a row that lands INSIDE the grace window is recorded, and the bucket is recorded, not pending', () => {
    bootProductionLedger();
    recordLiveNavTripwireAssertion({
      grade: gradeLiveNavTripwirePayload(servedPayload()),
      source: 'served',
      now: writerSlot('2026-08-25'),
    });
    const s = summarizeLiveNavTripwire(45, undefined, writerSlot('2026-08-25') + 60_000);
    expect(s.byDay.find((d) => d.etDay === '2026-08-25')?.bucket).toBe('recorded');
    expect(s.coverage.marketDaysPending).toEqual([]);
    expect(s.coverage.marketDaysExpected).toBe(9);
    expect(s.coverage.realizedCoverage).toBe(1);
  });

  it('the marker is written on first hydrate, survives a re-hydrate unmoved, and counts boots', () => {
    const firstBoot = Date.parse('2026-08-20T13:00:00Z'); // Thu 09:00 ET
    hydrateLiveNavTripwireFromDisk(dir, firstBoot);
    expect(existsSync(join(dir, LIVE_NAV_OBSERVATION_START_FILENAME))).toBe(true);
    const m1 = JSON.parse(readFileSync(liveNavObservationStartPath(dir), 'utf8'));
    expect(m1).toMatchObject({ kind: 'observation_start', firstBootTs: firstBoot, firstBootEtDay: '2026-08-20', boots: 1 });

    clearLiveNavTripwire();
    const secondBoot = firstBoot + 3 * 86_400_000;
    hydrateLiveNavTripwireFromDisk(dir, secondBoot);
    const m2 = JSON.parse(readFileSync(liveNavObservationStartPath(dir), 'utf8'));
    expect(m2).toMatchObject({ firstBootTs: firstBoot, lastBootTs: secondBoot, boots: 2 });
    expect(resolveLiveNavObservationStart()).toMatchObject({ startTs: firstBoot, source: 'marker' });
  });

  it('a writer that is DEAD FROM ITS FIRST BOOT is caught by the marker — no first row is needed', () => {
    // Deployed Thursday 08-20 at 09:00 ET, never wrote a row. Read Friday 08-21 at 22:00 ET.
    hydrateLiveNavTripwireFromDisk(dir, Date.parse('2026-08-20T13:00:00Z'));
    const s = summarizeLiveNavTripwire(45, undefined, Date.parse('2026-08-22T02:00:00Z'));
    expect(s.observation?.source).toBe('marker');
    expect(s.coverage.marketDaysMissing).toEqual(['2026-08-21', '2026-08-20']);
    expect(s.consecutiveMissingSessions).toBe(2);
    expect(s.coverage.realizedCoverage).toBe(0);
    expect(s.coverage.marketDaysNotMeasured[0]).toBe('2026-08-19');
    expect(s.driver).toEqual({ axis: 'writer', kind: 'coverage', status: 'blind', reason: 'no_assertion_row' });
    expect(s.verdict).toBe('blind');
  });

  it('a boot AFTER the slot does not owe that day: 08-20 boot at 22:00 ET makes 08-20 NOT MEASURED, 08-21 missing', () => {
    hydrateLiveNavTripwireFromDisk(dir, Date.parse('2026-08-21T02:00:00Z'));
    const s = summarizeLiveNavTripwire(45, undefined, Date.parse('2026-08-22T02:00:00Z'));
    expect(s.coverage.marketDaysMissing).toEqual(['2026-08-21']);
    expect(s.coverage.marketDaysNotMeasured[0]).toBe('2026-08-20');
    expect(s.consecutiveMissingSessions).toBe(1);
  });

  it('NO observation start at all is BLIND / no_observation_start — never clean, never 0% coverage', () => {
    // No hydrate, no row, no seam: nothing pins a start. An instrument with no denominator
    // cannot say "0 of 5" any more than it can say "5 of 5".
    const s = summarizeLiveNavTripwire(7, '2026-08-12');
    expect(s.observation).toBeNull();
    expect(s.verdict).toBe('blind');
    expect(s.driver).toEqual({ axis: 'writer', kind: 'coverage', status: 'blind', reason: 'no_observation_start' });
    expect(s.degraded).toBe(true);
    expect(s.attention).toBe(true);
    expect(s.coverage.marketDaysMissing).toEqual([]);
    expect(s.coverage.marketDaysExpected).toBe(0);
    expect(s.coverage.realizedCoverage).toBeNull();
    expect(s.coverage.marketDaysNotMeasured).toHaveLength(5);
  });

  it('a fresh deployment mid-morning with nothing due yet is NOT MEASURED (verdict null), not blind and not clean', () => {
    hydrateLiveNavTripwireFromDisk(dir, Date.parse('2026-08-25T13:00:00Z')); // Tue 09:00 ET
    const s = summarizeLiveNavTripwire(45, undefined, PULL_NOW);
    expect(s.verdict).toBeNull();
    expect(s.degraded).toBe(false);
    expect(s.attention).toBe(false);
    expect(s.driver).toBeNull();
    expect(s.coverage.marketDaysPending).toEqual(['2026-08-25']);
    expect(s.coverage.marketDaysExpected).toBe(0);
    expect(s.coverage.realizedCoverage).toBeNull();
    expect(s.coverage.marketDaysNotMeasured).toHaveLength(31);
  });

  it('the marker etDay follows the row etDay convention (ET, not UTC)', () => {
    // A marker written at 2026-08-26T03:00Z is 2026-08-25 23:00 ET — same ET day as the last row.
    expect(liveNavEtDay(POST_DEPLOY_BOOT)).toBe('2026-08-25');
  });
});
