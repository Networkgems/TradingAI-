import { describe, it, expect } from 'vitest';
import {
  reconcilePnl,
  resolvePnlBaselineDate,
  PNL_RECONCILE_DEFAULT_BASELINE_DATE,
} from './pnl-reconciliation.js';
import type { DailySnapshot } from './pnl-tracker.js';

// TRA-1633 FIX 3 — cross-surface reconciliation guard. The identity that must
// hold per ET day is EOD.combinedPnl == stock dailyPnl + day-only options.

const snap = (
  date: string, dailyPnl: number, optionsDailyPnl: number | undefined,
): DailySnapshot => ({
  date,
  openingEquity: 25_000,
  closingEquity: 25_000 + dailyPnl,
  dailyPnl,
  optionsPnl: 0,
  optionsDailyPnl,
  combinedPnl: dailyPnl + (optionsDailyPnl ?? 0),
  trades: 1,
});

describe('reconcilePnl', () => {
  it('reports ok with maxDriftUsd 0 when every day reconciles', () => {
    const snaps = [snap('2026-07-06', 100, 30), snap('2026-07-07', -20, 0)];
    const eod = new Map([
      ['2026-07-06', 130], // 100 + 30
      ['2026-07-07', -20], // -20 + 0
    ]);
    const r = reconcilePnl(snaps, eod);
    expect(r.ok).toBe(true);
    expect(r.maxDriftUsd).toBe(0);
    expect(r.offendingDates).toEqual([]);
    expect(r.days).toHaveLength(2);
    expect(r.days[0]).toMatchObject({ date: '2026-07-06', eodCombined: 130, stockDaily: 100, optionsDaily: 30, drift: 0 });
  });

  it('flags a day whose EOD combined drifts past the penny tolerance', () => {
    const snaps = [snap('2026-07-06', 100, 30)];
    const eod = new Map([['2026-07-06', 175]]); // 175 vs 130 → drift +45
    const r = reconcilePnl(snaps, eod);
    expect(r.ok).toBe(false);
    expect(r.offendingDates).toEqual(['2026-07-06']);
    expect(r.maxDriftUsd).toBeCloseTo(45, 2);
    expect(r.days[0].drift).toBeCloseTo(45, 2);
  });

  it('does not flag a sub-penny rounding drift', () => {
    const snaps = [snap('2026-07-06', 100.004, 30.004)];
    const eod = new Map([['2026-07-06', 130.01]]);
    const r = reconcilePnl(snaps, eod);
    expect(r.ok).toBe(true);
    expect(r.maxDriftUsd).toBeLessThanOrEqual(0.01);
  });

  it('treats a snapshot with no matching EOD file as null (not a mismatch)', () => {
    const snaps = [snap('2026-07-06', 100, 30)];
    const r = reconcilePnl(snaps, new Map());
    expect(r.ok).toBe(true);
    expect(r.days[0].eodCombined).toBeNull();
    expect(r.days[0].drift).toBe(0);
  });

  it('treats a legacy snapshot without optionsDailyPnl as 0 options', () => {
    const snaps = [snap('2026-07-06', 100, undefined)];
    const eod = new Map([['2026-07-06', 100]]);
    const r = reconcilePnl(snaps, eod);
    expect(r.ok).toBe(true);
    expect(r.days[0].optionsDaily).toBe(0);
  });

  // TRA-1636 — baseline cutoff: pre-fix legacy rows must not keep the guard red.
  describe('baseline cutoff (TRA-1636)', () => {
    it('excludes below-baseline drift from the verdict but still reports the row', () => {
      const snaps = [snap('2026-05-18', 277.38, 0), snap('2026-07-13', -20, 0)];
      const eod = new Map([
        ['2026-05-18', -19_471], // legacy pre-fix leak → drift ~-19,748
        ['2026-07-13', -20],     // clean post-fix day
      ]);
      const r = reconcilePnl(snaps, eod, '2026-07-12');
      expect(r.ok).toBe(true);
      expect(r.offendingDates).toEqual([]);
      expect(r.maxDriftUsd).toBe(0);
      expect(r.baselineDate).toBe('2026-07-12');
      expect(r.belowBaselineCount).toBe(1);
      // the dirty legacy row is still surfaced, just flagged + excluded
      const legacy = r.days.find(d => d.date === '2026-05-18')!;
      expect(legacy.belowBaseline).toBe(true);
      expect(Math.abs(legacy.drift)).toBeGreaterThan(1000);
    });

    it('still flags a post-baseline day that genuinely drifts', () => {
      const snaps = [snap('2026-05-18', 277.38, 0), snap('2026-07-13', 100, 30)];
      const eod = new Map([['2026-05-18', -19_471], ['2026-07-13', 175]]); // +45 drift
      const r = reconcilePnl(snaps, eod, '2026-07-12');
      expect(r.ok).toBe(false);
      expect(r.offendingDates).toEqual(['2026-07-13']);
      expect(r.maxDriftUsd).toBeCloseTo(45, 2);
    });

    it('evaluates every day when baseline is null (historical behaviour)', () => {
      const snaps = [snap('2026-05-18', 277.38, 0)];
      const eod = new Map([['2026-05-18', -19_471]]);
      const r = reconcilePnl(snaps, eod, null);
      expect(r.ok).toBe(false);
      expect(r.belowBaselineCount).toBe(0);
      expect(r.baselineDate).toBeNull();
      expect(r.days[0].belowBaseline).toBe(false);
    });
  });

  describe('resolvePnlBaselineDate (TRA-1636)', () => {
    it('defaults to the post-fix baseline when unset', () => {
      expect(resolvePnlBaselineDate({})).toBe(PNL_RECONCILE_DEFAULT_BASELINE_DATE);
    });
    it('honours a valid override', () => {
      expect(resolvePnlBaselineDate({ PNL_RECONCILE_BASELINE_DATE: '2026-08-01' })).toBe('2026-08-01');
    });
    it('disables the cutoff on none/off/empty', () => {
      for (const v of ['none', 'off', 'all', '', '  ', '0']) {
        expect(resolvePnlBaselineDate({ PNL_RECONCILE_BASELINE_DATE: v })).toBeNull();
      }
    });
    it('falls back to the default on an unparseable value', () => {
      expect(resolvePnlBaselineDate({ PNL_RECONCILE_BASELINE_DATE: 'garbage' })).toBe(PNL_RECONCILE_DEFAULT_BASELINE_DATE);
    });
  });
});
