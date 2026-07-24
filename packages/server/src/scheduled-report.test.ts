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
    const carol: ReportUser = {
      username: 'weekly-carol',
      snapshots: [snap('2026-07-20', 10, 1), snap('2026-07-26', 5, 1)],
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
