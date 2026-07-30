import { describe, it, expect } from 'vitest';
import {
  reconcilePnl,
  resolvePnlBaselineDate,
  foldJournalClosesByEtDay,
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

  // ── TRA-2302 — the options false-zero detector ────────────────────────────
  //
  // `optionsDailyPnl` reported 0.00 on all 95 desk book-days while the durable
  // option-trade journal held 110 CLOSED desk round trips (+$844.99). Those two
  // states produced the identical number here, so the endpoint could not tell a
  // book with no option activity from a book whose closes never reached the
  // ledger. The census below is the count that separates them.
  describe('foldJournalClosesByEtDay (TRA-2302)', () => {
    const ET = (ts: number) =>
      new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    // 2026-07-13 14:00Z = 10:00 ET, comfortably inside the ET day.
    const T13 = Date.parse('2026-07-13T14:00:00Z');
    const T15 = Date.parse('2026-07-15T14:00:00Z');

    it('buckets closes by ET day and sums realized P&L', () => {
      const m = foldJournalClosesByEtDay(
        [
          { closeTs: T13, realizedPnlUsd: 200 },
          { closeTs: T13, realizedPnlUsd: 41.5 },
          { closeTs: T15, realizedPnlUsd: 17 },
        ],
        ET,
      );
      expect(m.get('2026-07-13')).toEqual({ closes: 2, realizedPnlUsd: 241.5 });
      expect(m.get('2026-07-15')).toEqual({ closes: 1, realizedPnlUsd: 17 });
    });

    it('ignores rows that never closed — an OPEN row is not a day of activity', () => {
      const m = foldJournalClosesByEtDay(
        [{ realizedPnlUsd: 999 }, { closeTs: undefined, realizedPnlUsd: 999 }],
        ET,
      );
      expect(m.size).toBe(0);
    });
  });

  describe('options false-zero detection (TRA-2302)', () => {
    const census = (rows: Array<[string, number, number]>) =>
      new Map(rows.map(([d, closes, pnl]) => [d, { closes, realizedPnlUsd: pnl }]));

    it('FLAGS a 0.00 options day the journal says had closes', () => {
      const snaps = [snap('2026-07-13', 0, 0)];
      const eod = new Map([['2026-07-13', 0]]);
      const r = reconcilePnl(snaps, eod, null, census([['2026-07-13', 4, 241.5]]));

      expect(r.falseZeroDates).toEqual(['2026-07-13']);
      expect(r.optionsFalseZeroOk).toBe(false);
      expect(r.days[0]).toMatchObject({
        optionsDaily: 0,
        journalCloses: 4,
        journalOptionsPnl: 241.5,
        optionsFalseZero: true,
      });
      // The pre-existing drift verdict is untouched — this identity still holds.
      expect(r.ok).toBe(true);
    });

    it('MUTATION: the same day with the P&L actually booked is NOT flagged', () => {
      // Only `optionsDailyPnl` changes vs the case above. If the detector fired
      // on this too it would be a threshold rule, not a detector.
      const snaps = [snap('2026-07-13', 0, 241.5)];
      const eod = new Map([['2026-07-13', 241.5]]);
      const r = reconcilePnl(snaps, eod, null, census([['2026-07-13', 4, 241.5]]));

      expect(r.falseZeroDates).toEqual([]);
      expect(r.optionsFalseZeroOk).toBe(true);
      expect(r.days[0].optionsFalseZero).toBe(false);
    });

    it('TRA-2642: closes that net EXACTLY $0.00 are agreement, not a false zero', () => {
      // Found grading TRA-2625. `optionsDaily === 0` is the CORRECT booking for a
      // scratch-only options day, and the repair cannot clear the accusation
      // (moving 0 → 0 is not a move), so the old predicate left
      // `optionsFalseZeroOk` with no passing state — two fixture books held
      // `falseZeroDates:['2026-07-27']` while the repair re-ran on 34 boots.
      const r = reconcilePnl(
        [snap('2026-07-27', 0, 0)],
        new Map([['2026-07-27', 0]]),
        null,
        census([['2026-07-27', 2, 0]]),
      );
      expect(r.falseZeroDates).toEqual([]);
      expect(r.optionsFalseZeroOk).toBe(true);
      // The day stays fully visible — only the accusation is withdrawn.
      expect(r.days[0]).toMatchObject({
        journalCloses: 2,
        journalOptionsPnl: 0,
        optionsFalseZero: false,
      });
    });

    it('MUTATION: a genuinely option-less day is NOT flagged', () => {
      const r = reconcilePnl(
        [snap('2026-07-14', 0, 0)],
        new Map([['2026-07-14', 0]]),
        null,
        census([]), // journal agrees: no closes that day
      );
      expect(r.falseZeroDates).toEqual([]);
      expect(r.days[0]).toMatchObject({ journalCloses: 0, optionsFalseZero: false });
    });

    it('claims nothing when NO census was supplied — absent is not zero', () => {
      // The default call shape (every existing caller). A missing journal must
      // never manufacture a clean verdict OR a false-zero accusation.
      const r = reconcilePnl([snap('2026-07-13', 0, 0)], new Map([['2026-07-13', 0]]));
      expect(r.days[0].journalCloses).toBeNull();
      expect(r.days[0].journalOptionsPnl).toBeNull();
      expect(r.days[0].optionsFalseZero).toBe(false);
      expect(r.optionsFalseZeroOk).toBe(true);
      expect(r.falseZeroDates).toEqual([]);
    });

    it('sweeps BELOW the baseline too — a lost close is not pre-fix drift', () => {
      // 2026-07-01 predates the 2026-07-12 TRA-1636 baseline. The drift verdict
      // still excludes it; the false-zero sweep must not, or the history the
      // parent TRA-2297 is arguing about stays invisible.
      const r = reconcilePnl(
        [snap('2026-07-01', 0, 0)],
        new Map([['2026-07-01', 0]]),
        '2026-07-12',
        census([['2026-07-01', 3, 483.52]]),
      );
      expect(r.days[0].belowBaseline).toBe(true);
      expect(r.belowBaselineCount).toBe(1);
      expect(r.falseZeroDates).toEqual(['2026-07-01']);
      expect(r.optionsFalseZeroOk).toBe(false);
    });

    it('separates an ABSENT optionsDailyPnl field from one written as 0', () => {
      const r = reconcilePnl(
        [snap('2026-07-13', 0, undefined), snap('2026-07-14', 0, 0)],
        new Map(),
      );
      expect(r.days[0]).toMatchObject({ optionsDaily: 0, optionsFieldPresent: false });
      expect(r.days[1]).toMatchObject({ optionsDaily: 0, optionsFieldPresent: true });
      expect(r.optionsFieldMissingCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // TRA-2630 DEFECT A — `drift` pools a LOSSY stock leg against a DURABLE one.
  // These drive the exact live numbers off the 2026-07-30T04:19:30Z prod pull.
  // ---------------------------------------------------------------------------
  describe('TRA-2630 — per-leg decomposition of drift', () => {
    it('ATTRIBUTES the live signature: a lost stock close, not an options error', () => {
      // `Richard 2026-07-29` on the live pull: stockDaily 22.50, optionsDaily
      // -5.11, eodCombined -5.11 (so the report's realizedPnl is 0.00 — the
      // 21:00 ET archive cleared `allClosedPositions` before it was written).
      // The pooled `drift` reads -22.50 and names no cause. Decomposed, the
      // stock leg carries the whole error and the options leg is EXACT.
      const r = reconcilePnl(
        [snap('2026-07-29', 22.5, -5.11)],
        new Map([['2026-07-29', -5.11]]),
        '2026-07-12',
        null,
        new Map([['2026-07-29', -5.11]]), // report optionsPnl
        new Map([['2026-07-29', 0]]),     // report realizedPnl — the lost leg
      );
      expect(r.days[0]).toMatchObject({
        drift: -22.5,          // unchanged for existing consumers
        eodStockPnl: 0,
        stockLegDrift: -22.5,  // the entire error lands here...
        optionsLegDrift: 0,    // ...and the options leg reconciles exactly
      });
      expect(r.stockLegOk).toBe(false);
      expect(r.stockLegOffendingDates).toEqual(['2026-07-29']);
      expect(r.maxStockLegDriftUsd).toBe(22.5);
      // The working signal survives the decomposition — this is what pooling
      // destroyed, and what a gate should key on.
      expect(r.optionsLegOk).toBe(true);
      expect(r.maxOptionsLegDriftUsd).toBe(0);
      // `ok` is deliberately untouched: still keyed on the pooled drift.
      expect(r.ok).toBe(false);
      expect(r.maxDriftUsd).toBe(22.5);
    });

    it('isolates an OPTIONS-leg error to the options leg, leaving stock clean', () => {
      // The mirror case. Both legs must be independently attributable or the
      // decomposition is just a rename.
      const r = reconcilePnl(
        [snap('2026-07-29', 40, 10)],
        new Map([['2026-07-29', 90]]),
        '2026-07-12',
        null,
        new Map([['2026-07-29', 50]]), // report booked 50 options, snapshot 10
        new Map([['2026-07-29', 40]]), // stock legs agree
      );
      expect(r.days[0]).toMatchObject({ stockLegDrift: 0, optionsLegDrift: 40 });
      expect(r.stockLegOk).toBe(true);
      expect(r.optionsLegOk).toBe(false);
      expect(r.optionsLegOffendingDates).toEqual(['2026-07-29']);
      expect(r.maxOptionsLegDriftUsd).toBe(40);
    });

    it('has a REACHABLE GREEN state — both legs agree ⇒ both verdicts pass', () => {
      // The property `ok` lacks. A gate keyed on a metric with no green state
      // grades nothing no matter how correct the code is.
      const r = reconcilePnl(
        [snap('2026-07-29', 40, 10)],
        new Map([['2026-07-29', 50]]),
        '2026-07-12',
        null,
        new Map([['2026-07-29', 10]]),
        new Map([['2026-07-29', 40]]),
      );
      expect(r.days[0]).toMatchObject({ stockLegDrift: 0, optionsLegDrift: 0, drift: 0 });
      expect(r.stockLegOk).toBe(true);
      expect(r.optionsLegOk).toBe(true);
      expect(r.ok).toBe(true);
    });

    it('scores ABSENCE as 0 on both legs — a missing report is not a mismatch', () => {
      // Same rule `drift` already applies to a null `eodCombined`. Without it a
      // book with no report files would read as maximally broken.
      const r = reconcilePnl([snap('2026-07-29', 40, 10)], new Map(), '2026-07-12');
      expect(r.days[0]).toMatchObject({
        eodStockPnl: null,
        eodOptionsPnl: null,
        stockLegDrift: 0,
        optionsLegDrift: 0,
      });
      expect(r.stockLegOk).toBe(true);
      expect(r.optionsLegOk).toBe(true);
    });

    it('baseline-gates both leg verdicts, exactly like ok', () => {
      const r = reconcilePnl(
        [snap('2026-07-01', 686.43, 0)],
        new Map([['2026-07-01', 42.77]]),
        '2026-07-12',
        null,
        new Map([['2026-07-01', 0]]),
        new Map([['2026-07-01', 42.77]]),
      );
      expect(r.days[0].belowBaseline).toBe(true);
      expect(r.days[0].stockLegDrift).toBeCloseTo(-643.66, 2); // still visible on the row
      expect(r.stockLegOk).toBe(true);                          // but never graded
      expect(r.stockLegOffendingDates).toEqual([]);
      expect(r.maxStockLegDriftUsd).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // TRA-2630 AC3 / TRA-2629 — the T+1 credit-lag tripwire.
  // ---------------------------------------------------------------------------
  describe('TRA-2630 AC3 — prior-session options lag tripwire', () => {
    it('FIRES on the live signature: stockDaily == prior session optionsDaily', () => {
      // `Richard` on the 2026-07-30 pull: 07-27 od 67.50 -> 07-28 sd 67.50,
      // then 07-28 od 22.50 -> 07-29 sd 22.50. Two consecutive exact-to-the-cent
      // matches, which is what ruled out coincidence in the field.
      const r = reconcilePnl(
        [snap('2026-07-27', 0, 67.5), snap('2026-07-28', 67.5, 22.5), snap('2026-07-29', 22.5, -5.11)],
        new Map(),
        '2026-07-12',
      );
      expect(r.days.map(d => d.lagsPriorOptionsDaily)).toEqual([false, true, true]);
      expect(r.priorOptionsLagDates).toEqual(['2026-07-28', '2026-07-29']);
      expect(r.priorOptionsLagOk).toBe(false);
    });

    it('MUTATION: a quiet day does NOT fire — the flag has a failing state', () => {
      // The guard that matters. `stockDaily 0.00` after `optionsDaily 0.00` is
      // "equal to the cent", so without the non-zero term this fires on the 127
      // clean sessions of the live pull and can never go green. A flag that is
      // true in the passing state measures nothing (TRA-2301 / TRA-2642).
      const r = reconcilePnl(
        [snap('2026-07-27', 0, 0), snap('2026-07-28', 0, 0), snap('2026-07-29', 0, 140)],
        new Map(),
        '2026-07-12',
      );
      expect(r.days.map(d => d.lagsPriorOptionsDaily)).toEqual([false, false, false]);
      expect(r.priorOptionsLagOk).toBe(true);
    });

    it('MUTATION: real stock P&L that merely RESEMBLES the prior options figure', () => {
      // A cent of separation is enough — the field signature is exact equality,
      // so a near-miss must read clean or the tripwire indicts honest trading.
      const r = reconcilePnl(
        [snap('2026-07-27', 0, 67.5), snap('2026-07-28', 67.51, 0)],
        new Map(),
        '2026-07-12',
      );
      expect(r.days[1].lagsPriorOptionsDaily).toBe(false);
      expect(r.priorOptionsLagOk).toBe(true);
    });

    it('does NOT fire on the CLEAN live book — the admin sessions from the pull', () => {
      // `admin` (mode: live) is the book the demo-only verdict rests on:
      // 07-28 sd -0.94 vs prior od 140.00, 07-29 sd -17.87 vs prior od 68.00.
      // Both must read clean or the real-money escalation fires spuriously.
      const r = reconcilePnl(
        [snap('2026-07-27', 0, 140), snap('2026-07-28', -0.94, 68), snap('2026-07-29', -17.87, 250.01)],
        new Map(),
        '2026-07-12',
      );
      expect(r.priorOptionsLagDates).toEqual([]);
      expect(r.priorOptionsLagOk).toBe(true);
    });

    it('is NOT baseline-gated — the lag is a writer defect, not pre-fix drift', () => {
      const r = reconcilePnl(
        [snap('2026-07-01', 0, 67.5), snap('2026-07-02', 67.5, 0)],
        new Map(),
        '2026-07-12',
      );
      expect(r.days[1].belowBaseline).toBe(true);
      expect(r.priorOptionsLagDates).toEqual(['2026-07-02']);
      expect(r.priorOptionsLagOk).toBe(false);
    });
  });
});
