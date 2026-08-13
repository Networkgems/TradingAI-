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
  liveNavEtDay,
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
    expect(g.axes.lag).toEqual({ status: 'fail', reason: 'live_book_overstated_nav' });
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
    expect(g.axes.eodTail).toEqual({ status: 'fail', reason: 'live_book_eod_tail_stale:3' });
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
      reason: 'ungraded_live_books:1_of_2',
    });
    expect(g.verdict).toBe('blind');
    expect(g.alarm).toBe(true);
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
    expect(g.axes.lag).toEqual({ status: 'blind', reason: 'operand_declared_ungradeable' });
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
    expect(g.axes[axis]).toEqual({ status: 'blind', reason: 'not_measured' });
    expect(g.verdict).toBe('blind');
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
    expect(g.axes[axis]).toEqual({ status: 'blind', reason: 'missing_field' });
    expect(g.verdict).toBe('blind');
  });

  it('grades a wrong-typed operand as BLIND, not by coercion', () => {
    // `"true"` is truthy. A gate that coerced would read this as a pass.
    const g = gradeLiveNavTripwirePayload(coveredPayload({ livePriorOptionsLagOk: 'true' }));
    expect(g.axes.lag).toEqual({ status: 'blind', reason: 'field_wrong_type' });
    expect(g.verdict).toBe('blind');
  });

  it('grades an EMPTY live cohort as BLIND — the TRA-2630 AC3 manufactured green', () => {
    // "No live book was affected" and "there was no live book" must never read alike.
    // bqb1 has served an empty live cohort on a boot-arm miss (TRA-2649).
    const g = gradeLiveNavTripwirePayload(
      coveredPayload({ liveBookCount: 0, liveGradeableBookCount: 0, engines: [] }),
    );
    expect(g.axes.coverage).toEqual({ status: 'blind', reason: 'empty_live_cohort' });
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
    expect(s.alarm).toBe(true);
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
    // The amendment's core ask: it is an ALARM, and it is NOT green.
    expect(g.alarm).toBe(true);
    expect(g.verdict).not.toBe('clean');
    expect(g.observed.postOnsetTripCapablePairs).toBe(0);
    expect(g.axes.lagDenominator.reason).toContain('admin=no_post_onset_trip_capable_pairs');
    expect(g.axes.lagDenominator.reason).toContain('v0nni=no_live_options_onset');
  });

  it('grades CLEAN only when every live book has a post-onset trip-capable pair', () => {
    const g = gradeLiveNavTripwirePayload(coveredPayload());
    expect(g.axes.lagDenominator).toEqual({ status: 'pass', reason: null });
    expect(g.verdict).toBe('clean');
    expect(g.observed.postOnsetTripCapablePairs).toBe(2); // one per live book
  });

  it('one busy book cannot cover for a silent one — the census is PER BOOK', () => {
    // admin has evidence, v0nni has none. A fleet SUM would read 1 > 0 and pass.
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
            liveOptionsOnsetDate: null,
            days: V0NNI_LIVE_DAYS,
            priorOptionsLagOk: true,
            priorOptionsLagEligibleDates: [],
          },
        ],
      }),
    );
    expect(g.observed.postOnsetTripCapablePairs).toBe(1); // the sum is non-zero...
    expect(g.axes.lagDenominator.status).toBe('vacuous'); // ...and it still does not pass
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
    expect(g.axes.lagDenominator).toEqual({ status: 'blind', reason: 'engines_unreadable' });
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
    });
    expect(g.verdict).toBe('fail');
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
