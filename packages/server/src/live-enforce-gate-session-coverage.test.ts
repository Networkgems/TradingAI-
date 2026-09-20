// TRA-4748 (parent TRA-4746) — the session-coverage fold.
//
// The acceptance criteria that matter here are 3, 4 and 5, and 4 is the one
// that keeps this instrument from being worse than no instrument: the
// comparison against the NYSE calendar must run in ONE direction only.
import { describe, it, expect } from 'vitest';
import {
  foldSessionCoverage,
  previousSessionEtDay,
} from './live-enforce-gate-session-coverage.js';
import { resolveSessionDate, MARKET_CALENDAR_VERSION } from './market-calendar.js';
import type { LiveEnforceGate, LiveEnforceGateSummary } from './live-enforce-gate-ledger.js';

/**
 * A `retained.byGate[]` row carrying only the fields this fold reads. The real
 * summary carries a dozen more axes; building them here would test `foldGates`,
 * not this module.
 */
function gate(
  name: LiveEnforceGate,
  perDay: Record<string, number>,
): LiveEnforceGateSummary {
  const byEtDay = Object.entries(perDay).map(([etDay, evaluated]) => ({
    etDay,
    evaluated,
    blocked: 0,
    blockRate: null,
    byCell: [],
    bySelection: [],
    byReason: [],
    blockedUnclassified: 0,
    cellUnstamped: { evaluated: 0, blocked: 0 },
    selectionUnstamped: { evaluated: 0, blocked: 0 },
  }));
  return {
    gate: name,
    evaluated: byEtDay.reduce((a, r) => a + r.evaluated, 0),
    blocked: 0,
    blockRate: null,
    byEtDay,
    byScope: [],
    byReason: [],
    blockedUnclassified: 0,
    byBook: [],
    byCell: [],
    cellUnstamped: { evaluated: 0, blocked: 0 },
    bySelection: [],
    selectionUnstamped: { evaluated: 0, blocked: 0 },
    bySymbol: null,
    byRatifiedSet: null,
    costRQuantiles: null,
    netEdgeShadow: null,
  } as unknown as LiveEnforceGateSummary;
}

describe('foldSessionCoverage (TRA-4748)', () => {
  it('publishes all five fields and names the calendar it ruled against', () => {
    const c = foldSessionCoverage(['2026-09-17', '2026-09-18'], [gate('entry_window', {
      '2026-09-17': 4,
      '2026-09-18': 7,
    })], '2026-09-20');
    expect(Object.keys(c).sort()).toEqual([
      'calendarVersion',
      'lastSessionEtDay',
      'missingSessions',
      'sessionsSinceLastDecision',
      'zeroEvaluatedSessions',
    ]);
    expect(c.calendarVersion).toBe(MARKET_CALENDAR_VERSION);
    expect(c.calendarVersion).toBe('nyse-2015-2035');
  });

  // ── AC2: the shape of the CURRENT live retained window ────────────────────
  it('the live 2026-08-21..2026-09-18 window is clean: no holes, nothing elapsed', () => {
    const etDays = [
      '2026-08-21', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
      '2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
      '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
      '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
      '2026-09-18',
    ];
    const perDay = Object.fromEntries(etDays.map((d) => [d, 100]));
    // Read on Sunday 2026-09-20, which is when TRA-4746 asked the question.
    const c = foldSessionCoverage(etDays, [gate('entry_window', perDay)], '2026-09-20');
    expect(c.missingSessions).toEqual([]);
    expect(c.zeroEvaluatedSessions).toEqual([]);
    expect(c.lastSessionEtDay).toBe('2026-09-18');
    expect(c.sessionsSinceLastDecision).toBe(0);
  });

  // ── AC3: the alarm actually fires ─────────────────────────────────────────
  it('a genuine missing session lands in missingSessions', () => {
    // 2026-09-16 (Wed) is a session and is absent from the ledger.
    expect(resolveSessionDate('2026-09-16')).toBe('session');
    const etDays = ['2026-09-14', '2026-09-15', '2026-09-17', '2026-09-18'];
    const perDay = Object.fromEntries(etDays.map((d) => [d, 50]));
    const c = foldSessionCoverage(etDays, [gate('entry_window', perDay)], '2026-09-20');
    expect(c.missingSessions).toEqual(['2026-09-16']);
    // …and it is a HOLE, not a silent day: the day is absent, so it cannot also
    // be reported as present-and-idle.
    expect(c.zeroEvaluatedSessions).toEqual([]);
  });

  it('a dead Monday raises on Tuesday, with the session count beside it', () => {
    const etDays = ['2026-09-17', '2026-09-18'];
    const c = foldSessionCoverage(
      etDays,
      [gate('entry_window', { '2026-09-17': 9, '2026-09-18': 9 })],
      '2026-09-22', // Tue; Mon 2026-09-21 has fully elapsed
    );
    expect(c.lastSessionEtDay).toBe('2026-09-21');
    expect(c.missingSessions).toEqual(['2026-09-21']);
    expect(c.sessionsSinceLastDecision).toBe(1);
  });

  // ── AC4: THE ONE-DIRECTIONAL PIN ──────────────────────────────────────────
  // This is the test that stops the instrument from alarming on every market
  // holiday. The entry-evaluation site does not honour the NYSE calendar, and
  // the live ledger really does hold 736 `entry_window` rows for Labor Day.
  it('LABOR DAY 2026-09-07: present in etDays, non_session on the calendar, and NOT red', () => {
    expect(resolveSessionDate('2026-09-07')).toBe('non_session');

    const etDays = [
      '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09',
      '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16',
      '2026-09-17', '2026-09-18',
    ];
    const perDay = Object.fromEntries(etDays.map((d) => [d, 100]));
    perDay['2026-09-07'] = 736; // the measured live count
    const c = foldSessionCoverage(etDays, [gate('entry_window', perDay)], '2026-09-20');

    expect(c.missingSessions).toEqual([]);
    expect(c.zeroEvaluatedSessions).toEqual([]);
    expect(c.sessionsSinceLastDecision).toBe(0);
  });

  it('weekends are never holes — a normal Sat/Sun gap reads clean', () => {
    // 2026-09-19 (Sat) and 2026-09-20 (Sun) are the days TRA-4746 asked about.
    expect(resolveSessionDate('2026-09-19')).toBe('non_session');
    expect(resolveSessionDate('2026-09-20')).toBe('non_session');
    const c = foldSessionCoverage(
      ['2026-09-17', '2026-09-18'],
      [gate('entry_window', { '2026-09-17': 3, '2026-09-18': 3 })],
      '2026-09-21', // Monday morning, before the first candidate
    );
    expect(c.missingSessions).toEqual([]);
    // Monday is STRICTLY excluded — it is still in progress.
    expect(c.lastSessionEtDay).toBe('2026-09-18');
    expect(c.sessionsSinceLastDecision).toBe(0);
  });

  // ── AC5: present-but-idle is its own bucket ───────────────────────────────
  it('a present etDay with zero evaluations lands in zeroEvaluatedSessions, NOT missingSessions', () => {
    const etDays = ['2026-09-16', '2026-09-17', '2026-09-18'];
    const c = foldSessionCoverage(
      etDays,
      [
        gate('entry_window', { '2026-09-16': 11, '2026-09-17': 0, '2026-09-18': 4 }),
        gate('cost_bar', { '2026-09-16': 0, '2026-09-17': 0, '2026-09-18': 0 }),
      ],
      '2026-09-20',
    );
    expect(c.zeroEvaluatedSessions).toEqual(['2026-09-17']);
    expect(c.missingSessions).toEqual([]);
    // The anchor is the last day that DECIDED something, and 09-18 did.
    expect(c.sessionsSinceLastDecision).toBe(0);
  });

  it('a day carrying ONLY shadow-gate rows is decision-free, and cannot mask a stall', () => {
    const etDays = ['2026-09-17', '2026-09-18'];
    const c = foldSessionCoverage(
      etDays,
      [
        gate('entry_window', { '2026-09-17': 12, '2026-09-18': 0 }),
        // The shadow recorder refuses nothing; its rows are not decisions.
        gate('entry_delta_ceiling_shadow', { '2026-09-17': 12, '2026-09-18': 9 }),
      ],
      '2026-09-22',
    );
    expect(c.zeroEvaluatedSessions).toEqual(['2026-09-18']);
    // Anchored on 09-17, so 09-18 AND 09-21 have elapsed since a real decision.
    expect(c.sessionsSinceLastDecision).toBe(2);
  });

  // ── degenerate inputs must be silent, not loud ────────────────────────────
  it('an empty ledger claims no holes — a cold boot must not page', () => {
    const c = foldSessionCoverage([], [], '2026-09-20');
    expect(c.missingSessions).toEqual([]);
    expect(c.zeroEvaluatedSessions).toEqual([]);
    expect(c.lastSessionEtDay).toBe('2026-09-18');
    expect(c.sessionsSinceLastDecision).toBeNull();
  });

  it('every retained day idle ⇒ no anchor, so the count is null rather than a fake 0', () => {
    const etDays = ['2026-09-17', '2026-09-18'];
    const c = foldSessionCoverage(
      etDays,
      [gate('entry_delta_ceiling_shadow', { '2026-09-17': 5, '2026-09-18': 5 })],
      '2026-09-20',
    );
    expect(c.zeroEvaluatedSessions).toEqual(etDays);
    expect(c.sessionsSinceLastDecision).toBeNull();
    expect(c.missingSessions).toEqual([]);
  });

  it('dates outside the calendar bundle are UNCOVERED, never a hole', () => {
    // 2036 is past the bundle's 2035-12-31 end.
    expect(resolveSessionDate('2036-03-04')).toBe('uncovered');
    const c = foldSessionCoverage(
      ['2036-03-02'],
      [gate('entry_window', { '2036-03-02': 1 })],
      '2036-03-06',
    );
    expect(c.missingSessions).toEqual([]);
    expect(c.lastSessionEtDay).toBeNull();
    expect(c.sessionsSinceLastDecision).toBeNull();
  });

  it('a roll row for a day outside etDays cannot invent a coverage day', () => {
    const c = foldSessionCoverage(
      ['2026-09-18'],
      [gate('entry_window', { '2026-09-18': 2, '2026-09-11': 99 })],
      '2026-09-20',
    );
    expect(c.zeroEvaluatedSessions).toEqual([]);
    // 09-11 is a session absent from etDays, so it IS a hole — the stray roll
    // row must not launder it into a covered day.
    expect(c.missingSessions).toEqual([]); // window starts at min(etDays) = 09-18
  });
});

describe('previousSessionEtDay (TRA-4748)', () => {
  it('skips the weekend', () => {
    expect(previousSessionEtDay('2026-09-21')).toBe('2026-09-18'); // Mon -> Fri
    expect(previousSessionEtDay('2026-09-20')).toBe('2026-09-18'); // Sun -> Fri
  });

  it('skips a holiday as well as the weekend', () => {
    // Tue 2026-09-08 -> back over Labor Day (Mon 09-07) and the weekend.
    expect(previousSessionEtDay('2026-09-08')).toBe('2026-09-04');
  });

  it('is strict: the argument day is never its own answer', () => {
    expect(resolveSessionDate('2026-09-18')).toBe('session');
    expect(previousSessionEtDay('2026-09-18')).toBe('2026-09-17');
  });

  it('refuses to guess for a malformed or uncovered date', () => {
    expect(previousSessionEtDay('not-a-date')).toBeNull();
    expect(previousSessionEtDay('2036-03-06')).toBeNull();
  });
});
