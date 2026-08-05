import { describe, it, expect } from 'vitest';
import {
  EOD_DOCUMENTED_GAP,
  EOD_DOCUMENTED_GAP_DATES,
  PNL_EOD_DOCUMENTED_GAP_NOTE,
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
});
