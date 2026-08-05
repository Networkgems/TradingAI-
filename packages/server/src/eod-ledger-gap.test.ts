import { describe, it, expect } from 'vitest';
import {
  EOD_DOCUMENTED_GAP,
  EOD_DOCUMENTED_GAP_DATES,
  EOD_INTERIOR_ABSENT_OK_RETIREMENT,
  PNL_EOD_DOCUMENTED_GAP_NOTE,
  PNL_EOD_INTERIOR_RETIREMENT_NOTE,
  detectEodInteriorAbsence,
  sessionsInRange,
  summarizeEodInteriorAbsence,
} from './eod-ledger-gap.js';
import { PNL_RECONCILIATION_CAVEATS } from './pnl-reconciliation.js';

// TRA-2888 — the acceptance arms, PRE-REGISTERED on the issue before this file
// existed, encoded so they cannot drift:
//
//   A. RED-before-exclusion  — the detector fires on the KNOWN 07-30/31/08-03
//      hole. A detector that cannot go red on a hole we know is there has not
//      been tested. This is the arm the ticket says must exist.
//   B. GREEN-after-exclusion — the documented gap is excludable, so the axis is
//      readable on today's fleet rather than permanently red.
//   C. Clean control         — a book that did NOT participate in the outage is
//      never red. Guards the offender-only-cohort trap.
//   D. Not blinded           — a NEW interior hole still fires THROUGH the
//      exclusion. This is what separates a three-date allow-list from a blanket
//      suppression that also swallows the next incident.
//
// The `absentSessionsCovered` / `absentSessionsUncovered` counters from
// `eod-row-backfill.ts` are deliberately NOT asserted anywhere here: both
// increment only while iterating `absentSessions`, which is empty fleet-wide, so
// an assertion on them scores 0 whether or not anything was examined.

const HOLIDAYS = new Set(['2026-07-03', '2026-05-25', '2026-06-19', '2026-09-07']);
const isMarketDay = (iso: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  if (HOLIDAYS.has(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return dow !== 0 && dow !== 6;
};
const calendar = { lastSettledSession: '2026-08-04', isMarketDay };

/**
 * The live fleet's shape, measured on bqb1 2026-08-05T03:17Z build `237c147e`:
 * every one of the 47 participating books steps 2026-07-29 -> 2026-08-04, with
 * the three outage sessions absent and nothing else missing post-baseline.
 */
const PARTICIPANT_ROWS = [
  '2026-07-27',
  '2026-07-28',
  '2026-07-29',
  '2026-08-04',
];

describe('sessionsInRange — the independent cohort source', () => {
  it('enumerates sessions the ledger does not have, which is the whole point', () => {
    // 07-30 Thu, 07-31 Fri, 08-03 Mon. 08-01/08-02 is a weekend and must not appear.
    expect(sessionsInRange('2026-07-29', '2026-08-04', isMarketDay)).toEqual([
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
      '2026-08-03',
      '2026-08-04',
    ]);
  });

  it('skips holidays and never runs backwards', () => {
    expect(sessionsInRange('2026-07-02', '2026-07-06', isMarketDay)).toEqual([
      '2026-07-02',
      '2026-07-06',
    ]);
    expect(sessionsInRange('2026-08-04', '2026-07-29', isMarketDay)).toEqual([]);
  });
});

describe('AC2 arm A — RED on the known hole BEFORE the documented-gap exclusion', () => {
  it('fires on a book that steps 2026-07-29 -> 2026-08-04', () => {
    const r = detectEodInteriorAbsence(PARTICIPANT_ROWS, calendar, '2026-07-12');
    // The arm that proves the detector can fail at all.
    expect(r.interiorAbsentRaw).toEqual(['2026-07-30', '2026-07-31', '2026-08-03']);
    expect(r.interiorAbsentDocumented).toEqual(['2026-07-30', '2026-07-31', '2026-08-03']);
    expect(r.interiorGradeableCount).toBeGreaterThan(0);
  });

  it('sees what every shipped presence axis is blind to: there is no row to flag', () => {
    // The absent sessions are absent from the INPUT. Any check that iterates the
    // rows present cannot reach them — this is the structural blindness.
    expect(PARTICIPANT_ROWS).not.toContain('2026-07-30');
    const r = detectEodInteriorAbsence(PARTICIPANT_ROWS, calendar, '2026-07-12');
    expect(r.interiorAbsentRaw).toContain('2026-07-30');
  });

  it('is INTERIOR, not tail — it still fires once a later row lands', () => {
    // This is the eviction that emptied `liveEodTailStaleBooks`. The 08-04 row
    // advances the anchor past the hole; a tail construction goes to zero here.
    const withoutTailRow = PARTICIPANT_ROWS.slice(0, -1); // hole is the TAIL
    const withTailRow = PARTICIPANT_ROWS; // hole is now INTERIOR
    expect(detectEodInteriorAbsence(withTailRow, calendar, '2026-07-12').interiorAbsentRaw)
      .toEqual(['2026-07-30', '2026-07-31', '2026-08-03']);
    // Same three sessions, still absent, and the tail-shaped view of them is now
    // empty — which is exactly the false recovery this detector replaces.
    expect(
      detectEodInteriorAbsence(withoutTailRow, calendar, '2026-07-12').interiorAbsentRaw,
    ).toEqual([]);
  });
});

describe('AC2 arm B — GREEN after the exclusion, so the axis is readable', () => {
  it('grades the live fleet shape clean once the documented gap is excluded', () => {
    const r = detectEodInteriorAbsence(PARTICIPANT_ROWS, calendar, '2026-07-12');
    expect(r.interiorAbsentNet).toEqual([]);
    expect(r.interiorAbsentOk).toBe(true);
  });

  it('does not fabricate absence before the book existed', () => {
    // A book whose first row is 2026-07-27 is not accused of missing 07-13.
    const r = detectEodInteriorAbsence(PARTICIPANT_ROWS, calendar, '2026-07-12');
    expect(r.spanStart).toBe('2026-07-27');
    expect(r.absentSessions).not.toContain('2026-07-13');
  });
});

describe('AC2 arm C — the clean control never goes red', () => {
  it('a book that did not participate in the outage reads green', () => {
    // The 14 live non-participants (qa_*/ctoverify_*/qtverify_*) exist entirely
    // after the outage. There is NO book that holds rows on the three dates —
    // 47 of 47 participants miss all three — so this is the only real control
    // available, and an offender-only cohort would have skipped it.
    const postOutage = ['2026-08-04'];
    const r = detectEodInteriorAbsence(postOutage, calendar, '2026-07-12');
    expect(r.interiorAbsentNet).toEqual([]);
    expect(r.interiorAbsentOk).not.toBe(false);
  });

  it('a fully-recorded book with no gap at all is green, not merely unmeasured', () => {
    const complete = sessionsInRange('2026-07-13', '2026-08-04', isMarketDay);
    const r = detectEodInteriorAbsence(complete, calendar, '2026-07-12');
    expect(r.interiorAbsentRaw).toEqual([]);
    expect(r.interiorAbsentOk).toBe(true);
    expect(r.interiorGradeableCount).toBeGreaterThan(0);
  });
});

describe('AC2 arm D — the exclusion does not blind the detector to a NEW hole', () => {
  it('fires on an interior hole adjacent to the documented gap', () => {
    // 2026-07-29 removed as well: a fourth session, touching the gap, which a
    // range-shaped or `>=`-bounded suppression would have swallowed.
    const rows = ['2026-07-27', '2026-07-28', '2026-08-04'];
    const r = detectEodInteriorAbsence(rows, calendar, '2026-07-12');
    expect(r.interiorAbsentNet).toEqual(['2026-07-29']);
    expect(r.interiorAbsentOk).toBe(false);
  });

  it('reproduces the live `enock` hole the detector found before shipping', () => {
    // enock's post-baseline rows on bqb1 2026-08-05, ledger starting 2026-05-03
    // so the book demonstrably existed throughout: 10 absent sessions
    // 2026-07-13..07-24 that read GREEN on every field published before this
    // ticket. Separate incident from the ENOSPC outage; NOT folded into AC1.
    const enock = ['2026-05-04', ...PARTICIPANT_ROWS];
    const r = detectEodInteriorAbsence(enock, calendar, '2026-07-12');
    expect(r.interiorAbsentOk).toBe(false);
    expect(r.interiorAbsentNet).toEqual([
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
    ]);
    // ...and the documented gap is still reported, just not graded.
    expect(r.interiorAbsentDocumented).toEqual(EOD_DOCUMENTED_GAP_DATES);
  });

  it('a future absent session is NOT absorbed by the ruling', () => {
    // The exclusion is a three-element allow-list. A fourth failed night is a
    // new incident and must go red — the failure mode `eod-row-backfill.ts`
    // calls out for date literals, closed here by construction.
    const rows = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-08-04', '2026-08-06'];
    const cal = { lastSettledSession: '2026-08-06', isMarketDay };
    const r = detectEodInteriorAbsence(rows, cal, '2026-07-12');
    expect(r.interiorAbsentNet).toEqual(['2026-08-05']);
    expect(r.interiorAbsentOk).toBe(false);
  });
});

describe('NOT MEASURED is never a pass', () => {
  it('returns null for a book with no rows', () => {
    expect(detectEodInteriorAbsence([], calendar, '2026-07-12').interiorAbsentOk).toBeNull();
  });

  it('returns null when no calendar is supplied', () => {
    expect(detectEodInteriorAbsence(PARTICIPANT_ROWS, null, '2026-07-12').interiorAbsentOk)
      .toBeNull();
  });

  it('returns null when the calendar has no settled session', () => {
    const r = detectEodInteriorAbsence(
      PARTICIPANT_ROWS,
      { lastSettledSession: null, isMarketDay },
      '2026-07-12',
    );
    expect(r.interiorAbsentOk).toBeNull();
  });

  it('returns null — not true — when the interior cohort is empty', () => {
    // A single-row book has nothing strictly before its newest row. `true` here
    // would be `every` on the empty set: the vacuous pass this ticket was filed
    // over. The denominator is what makes the two readings distinguishable.
    const r = detectEodInteriorAbsence(['2026-08-04'], calendar, '2026-07-12');
    expect(r.interiorGradeableCount).toBe(0);
    expect(r.interiorAbsentOk).toBeNull();
  });
});

describe('fleet fold', () => {
  const book = (username: string, mode: string, rows: string[]) => ({
    username,
    mode,
    interior: detectEodInteriorAbsence(rows, calendar, '2026-07-12'),
  });

  it('folds RED > NOT MEASURED > GREEN and keeps the raw arm visible', () => {
    const s = summarizeEodInteriorAbsence([
      book('admin', 'live', PARTICIPANT_ROWS), // documented gap only -> green
      book('enock', 'demo', ['2026-05-04', ...PARTICIPANT_ROWS]), // new hole -> red
      book('qa_after', 'live', ['2026-08-04']), // control -> not measured
    ]);
    expect(s.eodInteriorAbsentOk).toBe(false);
    expect(s.eodInteriorAbsentBooks.map(b => b.username)).toEqual(['enock']);
    // The live cohort is clean even though the fleet is not — a real distinction,
    // and one a pooled verdict would have hidden.
    expect(s.liveEodInteriorAbsentOk).toBe(true);
    // ARM A as a published field: the known hole is still SEEN after exclusion.
    expect(s.eodInteriorAbsentRawBookCount).toBe(2);
    expect(s.eodInteriorDocumentedGapBooks.map(b => b.username)).toEqual(['admin', 'enock']);
  });

  it('an all-unmeasured cohort is null, never green', () => {
    const s = summarizeEodInteriorAbsence([book('qa_a', 'live', []), book('qa_b', 'live', [])]);
    expect(s.eodInteriorAbsentOk).toBeNull();
    expect(s.liveEodInteriorAbsentOk).toBeNull();
    expect(s.eodInteriorGradeableBookCount).toBe(0);
  });
});

describe('AC1 — the gap is recorded permanently and surfaces where the ledger is read', () => {
  it('names the three sessions and states they were NEVER CAPTURED', () => {
    expect(EOD_DOCUMENTED_GAP.dates).toEqual(['2026-07-30', '2026-07-31', '2026-08-03']);
    expect(EOD_DOCUMENTED_GAP.capture).toContain('NEVER CAPTURED');
    expect(EOD_DOCUMENTED_GAP.capture).toContain('not lost in transit');
  });

  it('records the scope as fleet-wide, not live-book-only', () => {
    expect(EOD_DOCUMENTED_GAP.scope).toContain('Fleet-wide');
    expect(EOD_DOCUMENTED_GAP.scope).toContain('47 of 47');
  });

  it('keeps back-fill permanently unauthorised', () => {
    expect(EOD_DOCUMENTED_GAP.backfillAuthorised).toBe(false);
    expect(EOD_DOCUMENTED_GAP.backfillFlag).toBe('ENABLE_EOD_ROW_BACKFILL');
  });

  it('explicitly retires the TRA-2829 acceptance line, with the reason', () => {
    const retired = EOD_DOCUMENTED_GAP.retiredAcceptanceLines.find(r => r.ticket === 'TRA-2829');
    expect(retired?.line).toBe('liveEodTailStaleBooks is empty');
    expect(retired?.why).toContain('eviction');
  });

  it('surfaces in the endpoint caveats, not only in a ticket comment', () => {
    // AC1: "a ticket comment is not sufficient". `caveats` is hoisted to the top
    // level of /api/health/pnl-reconciliation (TRA-2630 AC1), so a reader of the
    // affected range encounters it beside the presence axes it explains.
    expect(PNL_RECONCILIATION_CAVEATS).toContain(PNL_EOD_DOCUMENTED_GAP_NOTE);
    for (const d of EOD_DOCUMENTED_GAP_DATES) {
      expect(PNL_EOD_DOCUMENTED_GAP_NOTE).toContain(d);
    }
    expect(PNL_EOD_DOCUMENTED_GAP_NOTE).toContain('ENABLE_EOD_ROW_BACKFILL stays false');
  });

  it('only names fields that actually exist on the published shape', () => {
    // A note that points at a field name the payload does not carry is a NAME
    // MISS: the reader queries it, gets `undefined`, and reads that as "clean".
    // TRA-2831's note documents this exact failure happening in production with
    // `optionsDailyPnl`. The first draft of this note cited
    // `eodInteriorDocumentedGapDates`, which was never a field.
    const published = Object.keys(summarizeEodInteriorAbsence([]));
    for (const named of PNL_EOD_DOCUMENTED_GAP_NOTE.match(/`eodInterior[A-Za-z]+`/g) ?? []) {
      expect(published).toContain(named.replace(/`/g, ''));
    }
    expect(published).toContain('eodInteriorDocumentedGapBooks');
    // The per-book path the note advertises must resolve too.
    const perBook = detectEodInteriorAbsence(PARTICIPANT_ROWS, calendar, '2026-07-12');
    expect(Object.keys(perBook)).toContain('interiorAbsentDocumented');
  });

  it('does NOT claim the provenance ceiling is discharged', () => {
    expect(PNL_EOD_DOCUMENTED_GAP_NOTE).toContain('journal-repair');
    expect(PNL_EOD_DOCUMENTED_GAP_NOTE).toContain('does NOT discharge');
  });

  it('no longer points a grader at the boolean TRA-2943 retired', () => {
    // The TRA-2888 replacement pointer named `eodInteriorAbsentOk`. That pointer
    // is now stale in the one way that matters: it sends a grader to a field
    // pinned false. Both the structured `why` and the prose note must name the
    // ARRAY. This is the "a routed repair instruction can be stale" shape.
    const retired = EOD_DOCUMENTED_GAP.retiredAcceptanceLines.find(r => r.ticket === 'TRA-2829');
    expect(retired?.why).toContain('eodInteriorAbsentBooks');
    expect(retired?.why).toContain('TRA-2943');
    expect(PNL_EOD_DOCUMENTED_GAP_NOTE).toContain('`eodInteriorAbsentBooks`');
    expect(PNL_EOD_DOCUMENTED_GAP_NOTE).not.toContain('Grade `eodInteriorAbsentOk` instead');
  });
});

// TRA-2943 (CFO ruling, adjudicating TRA-2942) — disposition C: accept the
// standing red, record the retirement IN BAND beside the field, and record the
// incident as an IDENTITY rather than as the clamped date list.
describe('TRA-2943 — the in-band retirement of eodInteriorAbsentOk', () => {
  const book = (username: string, mode: string, rows: string[]) => ({
    username,
    mode,
    interior: detectEodInteriorAbsence(rows, calendar, '2026-07-12'),
  });

  it('publishes the retirement beside the field, not only in a ticket', () => {
    // The failure this exists to prevent: a reader six weeks out pulls the route,
    // sees `eodInteriorAbsentOk: false`, and reads a dead pin as a live signal.
    const published = summarizeEodInteriorAbsence([]);
    expect(published.eodInteriorAbsentOkRetirement.field).toBe('eodInteriorAbsentOk');
    expect(published.eodInteriorAbsentOkRetirement.ticket).toBe('TRA-2943');
    expect(published.eodInteriorAbsentOkRetirement.state).toContain('PINNED FALSE');
    expect(PNL_RECONCILIATION_CAVEATS).toContain(PNL_EOD_INTERIOR_RETIREMENT_NOTE);
  });

  it('names the ARRAY as the discriminator, and rules out a count as well', () => {
    // The ruling is explicit that a count is exactly as dead as the boolean once
    // one book permanently occupies slot one, so "publish a count instead" is not
    // an escape hatch and must not read as one.
    expect(EOD_INTERIOR_ABSENT_OK_RETIREMENT.discriminatorOfRecord)
      .toContain('eodInteriorAbsentBooks');
    expect(EOD_INTERIOR_ABSENT_OK_RETIREMENT.discriminatorOfRecord).toContain('SET OF USERNAMES');
    expect(EOD_INTERIOR_ABSENT_OK_RETIREMENT.discriminatorOfRecord).toContain('not a count');
    expect(PNL_EOD_INTERIOR_RETIREMENT_NOTE).toContain('COUNT');
  });

  it('scopes the retirement to the FLEET fold and leaves the live axis gradeable', () => {
    // Over-reading the retirement would retire a field that still discriminates:
    // `enock` is demo, so the live cohort is a different cohort with a reachable
    // red — and it is green today, which is the whole reason this closes under
    // owner authority.
    const s = summarizeEodInteriorAbsence([
      book('admin', 'live', PARTICIPANT_ROWS),
      book('enock', 'demo', ['2026-05-04', ...PARTICIPANT_ROWS]),
    ]);
    expect(s.eodInteriorAbsentOk).toBe(false);
    expect(s.liveEodInteriorAbsentOk).toBe(true);
    expect(EOD_INTERIOR_ABSENT_OK_RETIREMENT.stillGradeable.join(' '))
      .toContain('liveEodInteriorAbsentOk');
    expect(EOD_INTERIOR_ABSENT_OK_RETIREMENT.selfHeals).toBe(false);
  });

  it('EXCLUDES NOTHING — enock stays named in the raw array with its dates', () => {
    // This is the entire difference between the adopted disposition C and the
    // rejected option A. If a future change makes the adjudicated book vanish
    // from `eodInteriorAbsentBooks`, it has become a suppression primitive and
    // this assertion is what catches it.
    const s = summarizeEodInteriorAbsence([
      book('enock', 'demo', ['2026-05-04', ...PARTICIPANT_ROWS]),
    ]);
    expect(s.eodInteriorAbsentBooks.map(b => b.username)).toEqual(['enock']);
    expect(s.eodInteriorAbsentBooks[0]!.dates.length).toBeGreaterThan(0);
    expect(EOD_INTERIOR_ABSENT_OK_RETIREMENT.adjudicated.excludedFromVerdict).toBe(false);
    expect(EOD_DOCUMENTED_GAP_DATES).not.toContain('2026-07-13');
  });

  it('records the incident as an IDENTITY, thirty sessions, not the ten on the wire', () => {
    const a = EOD_INTERIOR_ABSENT_OK_RETIREMENT.adjudicated;
    expect(a.identity).toContain('2026-06-15..2026-07-24');
    expect(a.identity).toContain('never written');
    expect(a.sessionCount).toBe(30);
    expect(a.isolatedLegacySessions).toEqual(['2026-05-08', '2026-05-15']);
    expect(a.publishedDatesAreClamped).toContain('max(firstRow, baselineDate)');
    // The arithmetic of the record, checked against the calendar rather than
    // trusted as prose: 28 contiguous sessions + 2 isolated legacy = 30.
    const contiguous = sessionsInRange('2026-06-15', '2026-07-24', isMarketDay);
    expect(contiguous.length).toBe(a.contiguousSessionCount);
    expect(a.contiguousSessionCount + a.isolatedLegacySessions.length).toBe(a.sessionCount);
  });

  it('keeps the cause NOT MEASURED and the capture NEVER CAPTURED', () => {
    const a = EOD_INTERIOR_ABSENT_OK_RETIREMENT.adjudicated;
    expect(a.capture).toContain('NEVER CAPTURED');
    expect(a.cause).toContain('NOT MEASURED');
    // The 07-27 resumption is suggestive, not evidence — the ruling refuses the
    // upgrade explicitly, so the record must not quietly perform it.
    expect(a.cause).toContain('NOT evidence');
    expect(a.backfillAuthorised).toBe(false);
  });

  it('carries the four closed remedies so none is re-proposed from scratch', () => {
    const all = EOD_INTERIOR_ABSENT_OK_RETIREMENT.forbiddenRemedies.join(' ');
    expect(all).toContain('EOD_DOCUMENTED_GAP_DATES');
    expect(all).toContain('per-book exclusion');
    expect(all).toContain('ENABLE_EOD_ROW_BACKFILL');
    expect(all).toContain('baselineDate');
    expect(EOD_INTERIOR_ABSENT_OK_RETIREMENT.forbiddenRemedies.length).toBe(4);
  });

  it('only names fields that actually exist on the published shape', () => {
    // Same NAME-MISS guard the AC1 note carries: a note pointing at a field the
    // payload does not have reads as `undefined`, which a reader takes for clean.
    const published = Object.keys(summarizeEodInteriorAbsence([]));
    for (const named of PNL_EOD_INTERIOR_RETIREMENT_NOTE.match(/`eodInterior[A-Za-z]+`/g) ?? []) {
      expect(published).toContain(named.replace(/`/g, ''));
    }
    expect(published).toContain('eodInteriorAbsentOkRetirement');
  });
});
