import { describe, it, expect, beforeEach } from 'vitest';
import {
  __recordChartSplitsForTests as recordChartSplits,
  __resetSplitCalendarForTests as resetCalendar,
  knownSplits,
  knownSplitForSession,
} from './yahoo-feed.js';

// TRA-3068 (parent TRA-3065) — the SPLIT CALENDAR harvested off `yf.chart`.
//
// TRA-3065 measured that both deployed plausibility rules are blind to a
// sub-2.0 corporate action: they are internal-consistency tests, and an
// unadjusted action is internally consistent. The ex-date is the only input that
// separates a 3:2 split from a genuine -33% session, and this is where it enters
// the process.
//
// ⛔ THE FAILURE MODE THIS FILE EXISTS FOR IS A THROW, NOT A MISS. The parser
// runs inside the quote hot path, against a payload we do not control, under
// `validation: { logErrors: true }` — which LOGS a schema drift rather than
// throwing, so a drifted shape reaches this function intact. A split calendar
// that can throw takes out the quote it was supposed to annotate. Every
// malformed case below must degrade to NO CALENDAR ENTRY (the pre-TRA-3068
// behaviour), never to an exception and never to a bogus entry.

// RELATIVE to now, not a fixed calendar date: the harvest drops anything outside
// its retention window, so a hardcoded ex-date would pass on the day it was
// written and silently start testing the retention branch a month later.
const NVDA_MS = Date.now() - 2 * 86_400_000;
const ET_DAY = new Date(NVDA_MS).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

describe('TRA-3068 split-calendar harvest', () => {
  beforeEach(() => resetCalendar());

  it('reads the ARRAY payload shape (`return: "array"`, our default)', () => {
    recordChartSplits('nvda', {
      events: { splits: [{ date: new Date(NVDA_MS), numerator: 10, denominator: 1, splitRatio: '10:1' }] },
    });
    expect(knownSplits('NVDA')).toEqual([
      { exDate: ET_DAY, numerator: 10, denominator: 1, splitRatio: '10:1' },
    ]);
    // Keyed case-insensitively — the engine stamps upper, the feed is handed raw.
    expect(knownSplits('nvda')).toHaveLength(1);
  });

  it('reads the OBJECT payload shape, keyed by unix seconds', () => {
    // The literal payload verified against NVDA's 10:1 on the ticket.
    recordChartSplits('NVDA', {
      events: {
        splits: {
          [String(Math.floor(NVDA_MS / 1000))]: {
            date: Math.floor(NVDA_MS / 1000), numerator: 10, denominator: 1, splitRatio: '10:1',
          },
        },
      },
    });
    expect(knownSplits('NVDA')[0]).toMatchObject({ exDate: ET_DAY, numerator: 10, denominator: 1 });
  });

  it('accepts `date` as a Date OR as unix SECONDS — the same duality `toIsoTime` exists for', () => {
    recordChartSplits('AAA', { events: { splits: [{ date: new Date(NVDA_MS), numerator: 2, denominator: 1 }] } });
    recordChartSplits('BBB', { events: { splits: [{ date: NVDA_MS / 1000, numerator: 2, denominator: 1 }] } });
    expect(knownSplits('AAA')[0]!.exDate).toBe(knownSplits('BBB')[0]!.exDate);
  });

  it('answers the session-window question the two predicates consume', () => {
    recordChartSplits('NVDA', {
      events: { splits: [{ date: new Date(NVDA_MS), numerator: 10, denominator: 1, splitRatio: '10:1' }] },
    });
    // Half-open on (prior, current]: the ex-date session itself matches.
    expect(knownSplitForSession('NVDA', priorDay(ET_DAY), ET_DAY)?.splitRatio).toBe('10:1');
    // The NEXT session does not — that row's prevClose is already post-action.
    expect(knownSplitForSession('NVDA', ET_DAY, nextDay(ET_DAY))).toBeNull();
    // The LIVE quote path passes no prior session and collapses to an exact match.
    expect(knownSplitForSession('NVDA', null, ET_DAY)?.numerator).toBe(10);
    expect(knownSplitForSession('NVDA', null, nextDay(ET_DAY))).toBeNull();
    // A symbol never harvested is not "clean", it is UNKNOWN — and unknown reads
    // as no action, i.e. the pre-TRA-3068 behaviour for that row.
    expect(knownSplitForSession('NEVER_FETCHED', null, ET_DAY)).toBeNull();
  });

  it('drops events older than the retention window rather than growing forever', () => {
    const old = Date.now() - 400 * 86_400_000;
    recordChartSplits('OLD', { events: { splits: [{ date: new Date(old), numerator: 2, denominator: 1 }] } });
    expect(knownSplits('OLD')).toEqual([]);
  });

  const malformed: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'nope'],
    ['no events key', { quotes: [] }],
    ['events without splits', { events: {} }],
    ['splits: null', { events: { splits: null } }],
    ['splits: a number', { events: { splits: 7 } }],
    ['an empty array', { events: { splits: [] } }],
    ['a null entry', { events: { splits: [null] } }],
    ['a string entry', { events: { splits: ['10:1'] } }],
    ['no date', { events: { splits: [{ numerator: 2, denominator: 1 }] } }],
    ['a NaN date', { events: { splits: [{ date: NaN, numerator: 2, denominator: 1 }] } }],
    ['a zero date', { events: { splits: [{ date: 0, numerator: 2, denominator: 1 }] } }],
    ['a string date', { events: { splits: [{ date: '2026-07-06', numerator: 2, denominator: 1 }] } }],
    ['non-numeric ratio parts', { events: { splits: [{ date: NVDA_MS / 1000, numerator: '2', denominator: '1' }] } }],
  ];

  it.each(malformed)('never throws and never invents an entry on %s', (_label, payload) => {
    expect(() => recordChartSplits('ZZZ', payload)).not.toThrow();
    expect(knownSplits('ZZZ')).toEqual([]);
  });

  it('a later harvest REPLACES the symbol rather than accumulating duplicates', () => {
    const one = { events: { splits: [{ date: new Date(NVDA_MS), numerator: 2, denominator: 1 }] } };
    recordChartSplits('DUP', one);
    recordChartSplits('DUP', one);
    expect(knownSplits('DUP')).toHaveLength(1);
  });

  it('a harvest with NOTHING usable leaves the previous answer standing', () => {
    // Fail-open in the direction that matters: a drifted payload must not silently
    // erase a calendar entry a good response already established.
    recordChartSplits('KEEP', { events: { splits: [{ date: new Date(NVDA_MS), numerator: 2, denominator: 1 }] } });
    recordChartSplits('KEEP', { events: { splits: [] } });
    expect(knownSplits('KEEP')).toHaveLength(1);
  });
});

function priorDay(iso: string): string {
  return shift(iso, -1);
}
function nextDay(iso: string): string {
  return shift(iso, 1);
}
function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
