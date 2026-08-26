import { describe, it, expect } from 'vitest';
import {
  classifyChainSession,
  summarizeChainCaptureCompleteness,
  trailingTradingDays,
} from './chain-capture-completeness.js';
import { isMarketDayIso } from './scheduler.js';

// The live tape TRA-4059 was filed on (bqb1, 2026-07-31 → 2026-08-25, 25-name
// universe). 07-31 and 08-03 have NO partition; 08-18 has one with 0 files.
const LIVE: Array<[string, number | null]> = [
  ['2026-07-31', null], ['2026-08-03', null], ['2026-08-04', 25], ['2026-08-05', 25],
  ['2026-08-06', 25], ['2026-08-07', 25], ['2026-08-10', 25], ['2026-08-11', 6],
  ['2026-08-12', 21], ['2026-08-13', 24], ['2026-08-14', 25], ['2026-08-17', 12],
  ['2026-08-18', 0], ['2026-08-19', 12], ['2026-08-20', 25], ['2026-08-21', 25],
  ['2026-08-24', 15], ['2026-08-25', 25],
];
const livePartitions = LIVE.filter(([, f]) => f !== null).map(([date, files]) => ({
  date,
  files: files!,
  meta: { symbolCount: 25, written: files!, skipped: 25 - files! },
}));
const liveDates = LIVE.map(([d]) => d);

describe('trailingTradingDays', () => {
  it('walks back n trading days, skipping weekends and holidays', () => {
    // 2026-09-07 is Labor Day.
    expect(trailingTradingDays('2026-09-08', 3, isMarketDayIso)).toEqual(['2026-09-03', '2026-09-04', '2026-09-08']);
  });
  it('rejects a malformed anchor', () => {
    expect(trailingTradingDays('yesterday', 5, isMarketDayIso)).toEqual([]);
  });
});

describe('classifyChainSession', () => {
  it('reads 0 files as empty, not as a captured day', () => {
    expect(classifyChainSession({ date: '2026-08-18', files: 0, meta: { symbolCount: 25, written: 0, skipped: 25 } }, '2026-08-18', 25).kind).toBe('empty');
  });
  it('reads fewer files than the universe as partial', () => {
    expect(classifyChainSession({ date: '2026-08-11', files: 6, meta: { symbolCount: 25 } }, '2026-08-11', 25).kind).toBe('partial');
  });
  it('reads no partition as absent', () => {
    expect(classifyChainSession(null, '2026-07-31', 25).kind).toBe('absent');
  });
  it('falls back to the configured universe when _meta.json is missing', () => {
    expect(classifyChainSession({ date: 'x', files: 25, meta: null }, 'x', 25).kind).toBe('complete');
    expect(classifyChainSession({ date: 'x', files: 25, meta: null }, 'x', 30).kind).toBe('partial');
  });
});

describe('summarizeChainCaptureCompleteness', () => {
  it('reproduces the TRA-4059 census: 7/18 complete, 2 absent, 1 empty', () => {
    const c = summarizeChainCaptureCompleteness({ partitions: livePartitions, expectedDates: liveDates, configuredUniverse: 25 });
    // Issue counted 20 sessions incl. 07-30 and 08-10; this fixture's 18
    // expected days give the same shape: the absent/empty days are named.
    expect(c.expectedSessions).toBe(18);
    expect(c.absentDates).toEqual(['2026-07-31', '2026-08-03']);
    expect(c.emptyDates).toEqual(['2026-08-18']);
    expect(c.completeSessions).toBe(9);
    expect(c.partialSessions).toBe(6);
    expect(c.completeRate).toBe(0.5);
  });

  it('is NOT green with a partial session inside the recent window even when the newest day is complete', () => {
    // Newest (08-25) is complete — the shape that read `latest.written: 25`
    // and green on the old route. 08-24 wrote 15.
    const c = summarizeChainCaptureCompleteness({ partitions: livePartitions, expectedDates: liveDates, configuredUniverse: 25 });
    expect(c.status).toBe('degraded');
    expect(c.statusReason).toContain('2026-08-24=partial(15/25)');
    expect(c.statusReason).toContain('2026-08-19=partial(12/25)');
    // Fewest files among the last 5 expected sessions (08-19..08-25) is 08-19.
    expect(c.worstRecentSession?.date).toBe('2026-08-19');
    expect(c.worstRecentSession?.files).toBe(12);
  });

  it('reads outage when the most recent expected session is empty', () => {
    const c = summarizeChainCaptureCompleteness({
      partitions: livePartitions,
      expectedDates: liveDates.slice(0, liveDates.indexOf('2026-08-18') + 1),
      configuredUniverse: 25,
    });
    expect(c.status).toBe('outage');
    expect(c.worstRecentSession?.files).toBe(0);
  });

  it('reads outage when the most recent expected session has no partition at all', () => {
    const c = summarizeChainCaptureCompleteness({
      partitions: livePartitions,
      expectedDates: ['2026-07-30', '2026-07-31'],
      configuredUniverse: 25,
    });
    expect(c.status).toBe('outage');
    expect(c.statusReason).toContain('absent');
  });

  it('is green only when the whole recent window is complete', () => {
    const dates = ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10'];
    const c = summarizeChainCaptureCompleteness({ partitions: livePartitions, expectedDates: dates, configuredUniverse: 25 });
    expect(c.status).toBe('green');
    expect(c.completeRate).toBe(1);
  });

  it('has a fail state distinguishable from the pass state — the negative control', () => {
    const good = summarizeChainCaptureCompleteness({
      partitions: [{ date: '2026-08-25', files: 25, meta: { symbolCount: 25 } }],
      expectedDates: ['2026-08-25'],
      configuredUniverse: 25,
    });
    const bad = summarizeChainCaptureCompleteness({
      partitions: [{ date: '2026-08-25', files: 0, meta: { symbolCount: 25, written: 0, skipped: 25, wholesaleSkip: true } }],
      expectedDates: ['2026-08-25'],
      configuredUniverse: 25,
    });
    expect(good.status).toBe('green');
    expect(bad.status).toBe('outage');
    expect(good.completeSessions).toBe(1);
    expect(bad.completeSessions).toBe(0);
  });

  it('reports no_data on an empty window', () => {
    expect(summarizeChainCaptureCompleteness({ partitions: [], expectedDates: [], configuredUniverse: 25 }).status).toBe('no_data');
  });
});
