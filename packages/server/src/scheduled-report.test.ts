import { describe, it, expect } from 'vitest';
import {
  aggregatePeriod,
  buildPeriodReport,
  isPeriodEnd,
  periodStartFor,
  periodLabel,
  runScheduledReports,
  type ReportUser,
} from './scheduled-report.js';
import type { DailySnapshot } from './pnl-tracker.js';
import { DEFAULT_ALERT_PREFERENCES, type AlertPreferences, type ReportCadence } from '@trading-app/shared';
import type { ReportAlertEvent } from './notifications/index.js';

// ── snapshot builder ─────────────────────────────────────────────────────────

function snap(date: string, dailyPnl: number, trades: number, extra: Partial<DailySnapshot> = {}): DailySnapshot {
  return {
    date,
    openingEquity: 25_000,
    closingEquity: 25_000 + dailyPnl,
    dailyPnl,
    optionsPnl: 0,
    combinedPnl: dailyPnl,
    trades,
    ...extra,
  };
}

function prefsWith(cadence: ReportCadence): AlertPreferences {
  return { ...structuredClone(DEFAULT_ALERT_PREFERENCES), reportCadence: cadence };
}

// ── boundary detection ───────────────────────────────────────────────────────

describe('isPeriodEnd', () => {
  it('daily fires every day', () => {
    expect(isPeriodEnd('daily', '2026-07-22')).toBe(true);
    expect(isPeriodEnd('daily', '2026-07-26')).toBe(true);
  });

  it('weekly fires ONLY on Sunday (the Mon–Sun week close)', () => {
    // 2026-07-26 is a Sunday; 2026-07-20 is the Monday that opens that week.
    expect(isPeriodEnd('weekly', '2026-07-26')).toBe(true); // Sunday
    expect(isPeriodEnd('weekly', '2026-07-20')).toBe(false); // Monday
    expect(isPeriodEnd('weekly', '2026-07-24')).toBe(false); // Friday
  });

  it('monthly fires only on the calendar month\'s last day', () => {
    expect(isPeriodEnd('monthly', '2026-07-31')).toBe(true);
    expect(isPeriodEnd('monthly', '2026-07-30')).toBe(false);
    expect(isPeriodEnd('monthly', '2026-02-28')).toBe(true); // 2026 is not a leap year
    expect(isPeriodEnd('monthly', '2026-02-27')).toBe(false);
  });

  it('yearly fires only on Dec 31', () => {
    expect(isPeriodEnd('yearly', '2026-12-31')).toBe(true);
    expect(isPeriodEnd('yearly', '2026-12-30')).toBe(false);
    expect(isPeriodEnd('yearly', '2026-01-01')).toBe(false);
  });
});

describe('periodStartFor', () => {
  it('rolls each cadence back to its inclusive start', () => {
    expect(periodStartFor('daily', '2026-07-24')).toBe('2026-07-24');
    // Monday-started week containing Sunday 2026-07-26 opens Monday 2026-07-20.
    expect(periodStartFor('weekly', '2026-07-26')).toBe('2026-07-20');
    // Friday 2026-07-24 is in the same Mon–Sun week.
    expect(periodStartFor('weekly', '2026-07-24')).toBe('2026-07-20');
    expect(periodStartFor('monthly', '2026-07-31')).toBe('2026-07-01');
    expect(periodStartFor('yearly', '2026-12-31')).toBe('2026-01-01');
  });
});

// ── aggregation ──────────────────────────────────────────────────────────────

describe('aggregatePeriod', () => {
  it('sums day-only P&L + trades across the window and picks best/worst day', () => {
    const snaps = [
      snap('2026-07-20', 100, 2),
      snap('2026-07-21', -40, 1, { optionsDailyPnl: 10 }), // net -30
      snap('2026-07-22', 250, 3),
      snap('2026-07-27', 999, 9), // OUTSIDE the Mon–Sun window; must be excluded
    ];
    const stats = aggregatePeriod(snaps, '2026-07-20', '2026-07-26');
    expect(stats).not.toBeNull();
    expect(stats!.totalPnl).toBe(100 - 30 + 250); // 320 — the out-of-window 999 excluded
    expect(stats!.totalTrades).toBe(6);
    expect(stats!.tradingDays).toBe(3);
    expect(stats!.winDays).toBe(2);
    expect(stats!.lossDays).toBe(1);
    expect(stats!.optionsPnl).toBe(10);
    expect(stats!.bestDay).toEqual({ date: '2026-07-22', pnl: 250, trades: 3 });
    expect(stats!.worstDay).toEqual({ date: '2026-07-21', pnl: -30, trades: 1 });
  });

  it('merges stocks + crypto rows that share a date (no double window, one summed row)', () => {
    // Same date from two trackers → one merged day summing both books.
    const combined = [
      snap('2026-07-24', 100, 2), // stocks
      snap('2026-07-24', 50, 1), // crypto, same date
    ];
    const stats = aggregatePeriod(combined, '2026-07-24', '2026-07-24');
    expect(stats!.tradingDays).toBe(1);
    expect(stats!.totalPnl).toBe(150);
    expect(stats!.totalTrades).toBe(3);
  });

  it('returns null for an EMPTY period (no trades AND flat P&L) — the documented skip', () => {
    const flat = [snap('2026-07-24', 0, 0), snap('2026-07-25', 0, 0)];
    expect(aggregatePeriod(flat, '2026-07-20', '2026-07-26')).toBeNull();
    // ...but a flat day WITH a trade still reports (activity happened).
    const traded = [snap('2026-07-24', 0, 1)];
    expect(aggregatePeriod(traded, '2026-07-20', '2026-07-26')).not.toBeNull();
    // ...and a no-trade day with non-zero P&L (e.g. funding) still reports.
    const moved = [snap('2026-07-24', -12, 0)];
    expect(aggregatePeriod(moved, '2026-07-20', '2026-07-26')).not.toBeNull();
  });

  it('returns null when no snapshot falls in the window', () => {
    expect(aggregatePeriod([snap('2026-06-01', 500, 5)], '2026-07-20', '2026-07-26')).toBeNull();
  });
});

// ── event build ──────────────────────────────────────────────────────────────

describe('buildPeriodReport', () => {
  const week = [snap('2026-07-20', 100, 2), snap('2026-07-24', 250, 3)];

  it('fires with the RIGHT weekly boundaries on Sunday', () => {
    const ev = buildPeriodReport('alice', 'weekly', week, '2026-07-26', 1_700_000_000_000);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('report');
    expect(ev!.cadence).toBe('weekly');
    expect(ev!.periodStart).toBe('2026-07-20');
    expect(ev!.periodEnd).toBe('2026-07-26');
    expect(ev!.stats.totalPnl).toBe(350);
    expect(ev!.periodLabel).toBe(periodLabel('weekly', '2026-07-20', '2026-07-26'));
  });

  it('does NOT fire mid-week (weekly boundary not reached)', () => {
    expect(buildPeriodReport('alice', 'weekly', week, '2026-07-24', 1)).toBeNull(); // Friday
  });

  it('does NOT fire on a boundary with an empty period', () => {
    const flatWeek = [snap('2026-07-24', 0, 0)];
    expect(buildPeriodReport('alice', 'weekly', flatWeek, '2026-07-26', 1)).toBeNull();
  });
});

// ── fan-out ──────────────────────────────────────────────────────────────────

describe('runScheduledReports', () => {
  function collect(users: ReportUser[], asOfDate: string): ReportAlertEvent[] {
    const emitted: ReportAlertEvent[] = [];
    runScheduledReports({ users: () => users, asOfDate, now: 1, emit: (e) => emitted.push(e) });
    return emitted;
  }

  it('emits only for opted-in users whose cadence closes today', () => {
    const users: ReportUser[] = [
      { username: 'daily-bob', snapshots: [snap('2026-07-24', 80, 1)], prefs: prefsWith('daily') },
      { username: 'weekly-carol', snapshots: [snap('2026-07-20', 10, 1)], prefs: prefsWith('weekly') },
      { username: 'off-dave', snapshots: [snap('2026-07-24', 80, 1)], prefs: prefsWith('off') },
    ];
    // 2026-07-24 is a Friday: daily closes, weekly does not, off never fires.
    const emitted = collect(users, '2026-07-24');
    expect(emitted.map((e) => e.username)).toEqual(['daily-bob']);
    expect(emitted[0]!.cadence).toBe('daily');
  });

  it('prove-it-fires: the SAME weekly user fires once the boundary (Sunday) is reached', () => {
    // TRA-5215 — the second row used to sit on Sunday 2026-07-26 itself, which
    // the non-session read-time exclusion now (correctly) drops from the
    // totals. The subject of THIS test is the boundary firing, so the row
    // moved to Thursday; the Sunday-row behaviour has its own block below.
    const carol: ReportUser = {
      username: 'weekly-carol',
      snapshots: [snap('2026-07-20', 10, 1), snap('2026-07-23', 5, 1)],
      prefs: prefsWith('weekly'),
    };
    expect(collect([carol], '2026-07-24')).toHaveLength(0); // Friday — nothing
    const sunday = collect([carol], '2026-07-26');
    expect(sunday).toHaveLength(1); // Sunday — fires
    expect(sunday[0]!.periodStart).toBe('2026-07-20');
    expect(sunday[0]!.stats.totalPnl).toBe(15);
  });

  it('one user\'s failure does not starve the rest of the fleet', () => {
    const boom = {
      get username(): string {
        return 'boom';
      },
      get snapshots(): DailySnapshot[] {
        throw new Error('snapshot read blew up');
      },
      prefs: prefsWith('daily'),
    } as unknown as ReportUser;
    const ok: ReportUser = { username: 'ok', snapshots: [snap('2026-07-24', 5, 1)], prefs: prefsWith('daily') };
    const emitted = collect([boom, ok], '2026-07-24');
    expect(emitted.map((e) => e.username)).toEqual(['ok']);
  });
});

// ── TRA-5215 — read-time non-session exclusion (Option C, CFO-signed TRA-5214) ──
//
// `mergeByDate` drops rows whose date fails `isMarketDayIso` — the REAL
// production calendar, deliberately not a stub, because the binding condition
// is "one predicate, never a second calendar" (the TRA-3848 writer gate and
// `close-ledger.ts` grade with the same one). `aggregatePeriod` delegates to
// `mergeByDate`, so both the 21:00 ET scheduled reports and the on-demand path
// inherit the filter — that inheritance is what these pin. Dates used:
// 2026-05-01 is a Friday session; 2026-05-03 is the Sunday that carries the
// ONLY snapshot-leg money among the 23 live census rows (`enock|demo`,
// stockDaily +19.49).
describe('TRA-5215 — aggregatePeriod inherits the non-session exclusion through mergeByDate', () => {
  it('the measured split: −19.49 on the window holding the money Sunday, and the Sunday trade/day leave the counts', () => {
    const snaps = [
      snap('2026-05-01', 100, 2), // Friday — session
      snap('2026-05-03', 19.49, 1), // Sunday — the enock|demo money row
    ];
    const may = aggregatePeriod(snaps, '2026-05-01', '2026-05-31');
    expect(may).not.toBeNull();
    expect(may!.totalPnl).toBeCloseTo(100, 6); // pre-fix: 119.49
    expect(may!.stockPnl).toBeCloseTo(100, 6);
    expect(may!.totalTrades).toBe(2);
    expect(may!.tradingDays).toBe(1); // a Sunday is not a trading day
    expect(may!.bestDay).toEqual({ date: '2026-05-01', pnl: 100, trades: 2 });
  });

  it('ISO-week 2026-W18 ceases to exist: a window whose ONLY row is non-session aggregates to null', () => {
    const w18 = aggregatePeriod([snap('2026-05-03', 19.49, 1)], '2026-04-27', '2026-05-03');
    expect(w18).toBeNull(); // the report is not emitted at all, rather than re-totalling
    // …and through the real weekly event build (2026-05-03 IS the Sunday boundary):
    expect(buildPeriodReport('enock', 'weekly', [snap('2026-05-03', 19.49, 1)], '2026-05-03', 1)).toBeNull();
  });

  it('inert non-session rows (both legs $0.00 — 22 of the 23 census rows) move every published cell $0.00', () => {
    const sessions = [snap('2026-05-01', 100, 2), snap('2026-04-30', -40, 1)];
    const withInert = [
      ...sessions,
      // Inert Sunday CLOSING the window: pre-fix it supplied `endEquity` and a
      // `tradingDays` count; post-fix the stats must read as if it never existed.
      snap('2026-05-03', 0, 0),
      snap('2026-04-26', 0, 0), // inert Sunday ahead of the window's first session
    ];
    expect(aggregatePeriod(withInert, '2026-04-26', '2026-05-03'))
      .toEqual(aggregatePeriod(sessions, '2026-04-26', '2026-05-03'));
  });

  it('CONTROL — a session-day row at the window edge still counts (the filter is the calendar, not the boundary)', () => {
    const friday = aggregatePeriod([snap('2026-05-01', 100, 2)], '2026-05-01', '2026-05-01');
    expect(friday).not.toBeNull();
    expect(friday!.totalPnl).toBeCloseTo(100, 6);
    expect(friday!.tradingDays).toBe(1);
  });
});
