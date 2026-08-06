/**
 * TRA-3100 — grade the WRITE DECISION, not the compute.
 *
 * The defect this file exists for: TRA-2864 landed four arithmetic fixes that
 * reproduce broker truth to the cent, and 43 of 49 live calendar cells did not
 * move, because `isBackfillRow()` protects every row the backfill did not write
 * itself — including the pre-fix corrupt ones. The passing arithmetic suite said
 * nothing about that, because it only ever asked "is the number right".
 *
 * So every test here asks the other question: *which rows is this allowed to
 * overwrite, and are the broken ones in that set?*
 *
 * The nine days enumerated on the issue against the account's own `gainloss.csv`
 * are used as the fixture, so a regression that re-strands them fails by name.
 */

import { describe, expect, it } from 'vitest';
import {
  decideCalendarRowWrite,
  isBackfillRow,
  triageForceDates,
  type ExistingCalendarRow,
} from './calendar-write-decision.js';

/**
 * The days TRA-3100 enumerated: a live cell the calendar renders, the source
 * that owns it, and the account's own broker-realized figure for that date.
 * Every one of these carries a row, which is precisely why the widened backfill
 * window could not reach any of them.
 */
const STRANDED_DAYS: Array<{
  date: string;
  liveCell: number;
  source: 'tradier-balance' | 'engine';
  brokerRealized: number;
  closes: number;
}> = [
  { date: '2026-06-11', liveCell: 23.81, source: 'tradier-balance', brokerRealized: -80.72, closes: 3 },
  { date: '2026-06-12', liveCell: 0.0, source: 'tradier-balance', brokerRealized: -141.72, closes: 4 },
  { date: '2026-06-15', liveCell: 104.84, source: 'tradier-balance', brokerRealized: 125.75, closes: 2 },
  { date: '2026-06-16', liveCell: -122.77, source: 'tradier-balance', brokerRealized: -163.15, closes: 5 },
  { date: '2026-06-25', liveCell: -86.6, source: 'tradier-balance', brokerRealized: -409.59, closes: 6 },
  { date: '2026-07-01', liveCell: -42.18, source: 'tradier-balance', brokerRealized: -116.48, closes: 2 },
  { date: '2026-07-08', liveCell: 61.91, source: 'tradier-balance', brokerRealized: -106.24, closes: 3 },
  { date: '2026-07-31', liveCell: 739.0, source: 'engine', brokerRealized: 713.73, closes: 8 },
  { date: '2026-08-03', liveCell: 0.0, source: 'engine', brokerRealized: 74.65, closes: 1 },
];

const rowFor = (d: (typeof STRANDED_DAYS)[number]): ExistingCalendarRow => ({
  pnlSource: d.source,
  combinedPnl: d.liveCell,
  markdown: `# EOD ${d.date}\n\nCombined P&L $${d.liveCell.toFixed(2)}.`,
});

describe('TRA-3100 — the clobber guard is why the fix did not land', () => {
  it('refuses every one of the 9 enumerated days WITHOUT a force (this is the reported defect)', () => {
    const reached = STRANDED_DAYS.filter(
      d =>
        decideCalendarRowWrite({
          existing: rowFor(d),
          dayRealized: d.brokerRealized,
          dayCloseCount: d.closes,
          forced: false,
        }).action === 'write',
    );
    // 0 of 9 — the arithmetic being exact changes nothing about reachability.
    expect(reached.map(d => d.date)).toEqual([]);
  });

  it('reaches all 9 WITH an explicit force, and records what each one replaced', () => {
    const outcomes = STRANDED_DAYS.map(d => ({
      date: d.date,
      decision: decideCalendarRowWrite({
        existing: rowFor(d),
        dayRealized: d.brokerRealized,
        dayCloseCount: d.closes,
        forced: true,
      }),
    }));

    // A count with a denominator: 9 of 9, named.
    expect(outcomes.filter(o => o.decision.action === 'write').map(o => o.date)).toEqual(
      STRANDED_DAYS.map(d => d.date),
    );

    for (const [i, o] of outcomes.entries()) {
      const src = STRANDED_DAYS[i]!;
      expect(o.decision).toMatchObject({
        action: 'write',
        forced: true,
        superseded: { pnlSource: src.source, combinedPnl: src.liveCell },
      });
    }
  });

  it('a forced overwrite still refuses when the broker tape has NO closes for the day', () => {
    // The dangerous shape: force 06-12 while the tape is empty (fetch returned
    // nothing for that date). Writing the reconstruction would put $0.00 over a
    // real snapshot on the strength of no evidence at all.
    const decision = decideCalendarRowWrite({
      existing: { pnlSource: 'tradier-balance', combinedPnl: -141.72 },
      dayRealized: 0,
      dayCloseCount: 0,
      forced: true,
    });
    expect(decision.action).toBe('refuse_force');
    expect(decision).toMatchObject({ reason: expect.stringContaining('no_broker_closes') });
  });

  it('force is scoped to the named dates only — an unnamed protected neighbour is untouched', () => {
    // The issue is explicit that this must not become "recompute everything": a
    // genuine 21:00 snapshot is authoritative and must survive the repair.
    const named = new Set(['2026-06-12']);
    const results = STRANDED_DAYS.map(d =>
      decideCalendarRowWrite({
        existing: rowFor(d),
        dayRealized: d.brokerRealized,
        dayCloseCount: d.closes,
        forced: named.has(d.date),
      }),
    );
    expect(results.filter(r => r.action === 'write')).toHaveLength(1);
    expect(results.filter(r => r.action === 'skip')).toHaveLength(8);
  });
});

describe('TRA-3100 — the unforced defaults are unchanged', () => {
  it('rewrites a prior realized-backfill row without any force (idempotent re-run)', () => {
    const decision = decideCalendarRowWrite({
      existing: { pnlSource: 'realized-backfill', combinedPnl: -180.27 },
      dayRealized: -180.27,
      dayCloseCount: 2,
      forced: false,
    });
    expect(decision).toMatchObject({ action: 'write', forced: false, superseded: null });
  });

  it('recognises a pre-`pnlSource` backfill row by its header alone', () => {
    // Back-compat arm: rows written before the field existed carry only the
    // TRA-244 header. Losing this arm would strand every one of them.
    expect(isBackfillRow({ markdown: '> **Live calendar backfill (TRA-244).** …' })).toBe(true);
    expect(isBackfillRow({ markdown: '# EOD 2026-06-11\n\nnothing special' })).toBe(false);
  });

  it('leaves a no-activity day with no artifact ABSENT rather than writing a phantom $0.00', () => {
    const decision = decideCalendarRowWrite({
      existing: null,
      dayRealized: 0,
      dayCloseCount: 0,
      forced: false,
    });
    expect(decision).toMatchObject({ action: 'skip', reason: 'no_activity_no_row' });
  });

  it('writes a brand-new day that HAS broker closes', () => {
    const decision = decideCalendarRowWrite({
      existing: null,
      dayRealized: 11.85,
      dayCloseCount: 1,
      forced: false,
    });
    expect(decision).toMatchObject({ action: 'write', forced: false, superseded: null });
  });

  it('an unlabelled protected row is superseded as `unlabelled`, not silently as engine', () => {
    const decision = decideCalendarRowWrite({
      existing: { combinedPnl: 12.5, markdown: '# EOD\n' },
      dayRealized: -3.25,
      dayCloseCount: 2,
      forced: true,
    });
    expect(decision).toMatchObject({
      action: 'write',
      superseded: { pnlSource: 'unlabelled', combinedPnl: 12.5 },
    });
  });
});

describe('TRA-3100 — force-list triage names every rejection', () => {
  const ctx = { writeStart: '2024-08-01', todayExclusive: '2026-08-06', includeEquity: true };

  it('accepts the 9 enumerated dates', () => {
    const { accepted, refused } = triageForceDates(STRANDED_DAYS.map(d => d.date), ctx);
    expect([...accepted].sort()).toEqual(STRANDED_DAYS.map(d => d.date).sort());
    expect(refused).toEqual([]);
  });

  it('refuses — and NAMES — a date outside the write window rather than dropping it', () => {
    // The silent-drop shape is the one that matters: the operator reads `ok:true`
    // and believes the day was corrected.
    const { accepted, refused } = triageForceDates(['2020-01-02', '2026-08-06'], ctx);
    expect([...accepted]).toEqual([]);
    expect(refused).toHaveLength(2);
    expect(refused.map(r => r.date)).toEqual(['2020-01-02', '2026-08-06']);
    for (const r of refused) expect(r.reason).toContain('outside_write_window');
  });

  it('refuses today itself — today is owned by the intraday cell and the 9 PM snapshot', () => {
    const { accepted } = triageForceDates([ctx.todayExclusive], ctx);
    expect([...accepted]).toEqual([]);
  });

  it('refuses a malformed date instead of coercing it', () => {
    const { accepted, refused } = triageForceDates(['06/11/2026', '', '2026-6-11'], ctx);
    expect([...accepted]).toEqual([]);
    expect(refused.map(r => r.reason)).toEqual([
      expect.stringContaining('malformed_date'),
      expect.stringContaining('malformed_date'),
      expect.stringContaining('malformed_date'),
    ]);
  });

  it('fails CLOSED when equity is withheld — an options-only figure may not overwrite an all-instrument row', () => {
    const { accepted, refused } = triageForceDates(['2026-06-11'], { ...ctx, includeEquity: false });
    expect([...accepted]).toEqual([]);
    expect(refused[0]?.reason).toContain('equity_withheld_this_pass');
  });

  it('an empty force list is inert — nothing is accepted and nothing is refused', () => {
    // The force path ships DISARMED. Absent an explicit list, behaviour is
    // byte-for-byte the pre-TRA-3100 behaviour.
    const { accepted, refused } = triageForceDates([], ctx);
    expect(accepted.size).toBe(0);
    expect(refused).toEqual([]);
  });
});
