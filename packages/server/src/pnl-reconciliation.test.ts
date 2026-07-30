import { describe, it, expect } from 'vitest';
import {
  reconcilePnl,
  resolvePnlBaselineDate,
  foldJournalClosesByEtDay,
  summarizeLiveLagTripwire,
  summarizeLiveCreditObservation,
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
      // TRA-2633 — this used to assert `false`, i.e. "the stock legs DISAGREE".
      // That was the bug: the report leg is not disagreeing, it is ABSENT-as-zero
      // (the archive cleared it), so `stockLegDrift` is just `-stockDaily`.
      // Claiming a regression here is how the pooled-`drift` defect survived the
      // decomposition. NOT MEASURED is the honest verdict.
      expect(r.stockLegOk).toBeNull();
      expect(r.stockLegMeasuredCount).toBe(1); // a row COULD have disagreed...
      // ...and the raw evidence stays fully visible on the row and in the
      // aggregates. `null` suppresses the VERDICT, never the numbers.
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
      // TRA-2633 — absence is still not a MISMATCH (no offending date, drift 0),
      // but it is not a PASS either: there was no cohort to grade. `true` here
      // was the empty-set trap that shipped live as `livePriorOptionsLagOk`.
      expect(r.stockLegOk).toBeNull();
      expect(r.stockLegMeasuredCount).toBe(0);
      expect(r.stockLegOffendingDates).toEqual([]);
      expect(r.optionsLegOk).toBe(true);
    });

    it('TRA-2633 — a row with stockDaily 0 is NOT evidence, so it cannot vacuously pass', () => {
      // The exact shape that made C5 of TRA-2625 read green off two books: both
      // legs are 0, so they "agree" no matter how broken the source is. This is
      // the vacuous pass the measured-cohort rule exists to refuse.
      const r = reconcilePnl(
        [snap('2026-07-27', 0, 140)],
        new Map([['2026-07-27', 140]]),
        '2026-07-12',
        null,
        new Map([['2026-07-27', 140]]),
        new Map([['2026-07-27', 0]]), // agrees only because both sides are 0
      );
      expect(r.days[0]).toMatchObject({ stockLegDrift: 0, drift: 0 });
      expect(r.stockLegMeasuredCount).toBe(0);
      expect(r.stockLegOk).toBeNull();
      // The options leg on that same row IS real evidence and does pass.
      expect(r.optionsLegOk).toBe(true);
    });

    it('TRA-2633 — AUTO-HEALS: one real report figure hands the verdict back to a boolean', () => {
      // The `null` must not be a one-way latch. The moment the EOD report carries
      // a genuine stock figure on any row that could disagree, the leg is
      // gradeable again — no code change, no flag, no ticket. Here 07-28 is still
      // zeroed but 07-29 is live and AGREES, so the verdict is a true green.
      const r = reconcilePnl(
        [snap('2026-07-28', 22.5, 0), snap('2026-07-29', 40, 0)],
        new Map([['2026-07-28', 0], ['2026-07-29', 40]]),
        '2026-07-12',
        null,
        new Map([['2026-07-28', 0], ['2026-07-29', 0]]),
        new Map([['2026-07-28', 0], ['2026-07-29', 40]]), // 07-29 leg is REAL
      );
      expect(r.stockLegMeasuredCount).toBe(2);
      expect(r.stockLegOk).toBe(false); // 07-28 is now a genuine, gradeable miss
      expect(r.stockLegOffendingDates).toEqual(['2026-07-28']);
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
      // TRA-2633 — every row is below baseline, so the measured cohort is empty
      // and the verdict is NOT MEASURED rather than a green earned by exclusion.
      expect(r.stockLegOk).toBeNull();
      expect(r.stockLegMeasuredCount).toBe(0);
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
      // TRA-2630 AC2 — and the BOOK verdict here is `null`, NOT `true`. Every
      // session in this fixture follows a zero-`optionsDaily` prior, so the
      // tripwire had no failing state available on any of them. It used to read
      // `true`, which asserted a clean bill of health over zero observations —
      // the same manufactured green as `livePriorOptionsLagOk` over an empty live
      // cohort, reproduced inside this very test file.
      expect(r.priorOptionsLagEligibleDates).toEqual([]);
      expect(r.priorOptionsLagOk).toBeNull();
    });

    it('TRI-STATE: the SAME quiet book reads true once ONE session has a gradeable prior', () => {
      // The discriminator for the field above. Only difference from the fixture
      // in the previous test: 07-28 carries a non-zero `optionsDaily`, so 07-29
      // becomes gradeable and its clean reading is now worth something.
      const r = reconcilePnl(
        [snap('2026-07-27', 0, 0), snap('2026-07-28', 0, 140), snap('2026-07-29', 0, 0)],
        new Map(),
        '2026-07-12',
      );
      expect(r.days.map(d => d.lagsPriorOptionsDaily)).toEqual([false, false, false]);
      expect(r.priorOptionsLagEligibleDates).toEqual(['2026-07-29']);
      expect(r.priorOptionsLagOk).toBe(true);
    });

    it('a session that PASSES on a gradeable prior counts as evidence', () => {
      // `stockDaily 0.00` after a 250.01 options session is not a quiet day — the
      // lag hypothesis predicted exactly 250.01 there and got 0.00. Eligibility
      // must therefore NOT depend on the current row, or the gradeable cohort
      // collapses to the offenders and the fix can never be verified.
      const r = reconcilePnl(
        [snap('2026-07-28', 0, 250.01), snap('2026-07-29', 0, 0)],
        new Map(),
        '2026-07-12',
      );
      expect(r.priorOptionsLagEligibleDates).toEqual(['2026-07-29']);
      expect(r.priorOptionsLagOk).toBe(true);
    });

    it('a lag date is ALWAYS also a gradeable date — red implies measured', () => {
      // Invariant: the flag can only fire when `stockDaily` is non-zero AND
      // equals the prior `optionsDaily`, which forces that prior non-zero too. If
      // this ever broke, a book could read `false` while claiming 0 observations.
      const r = reconcilePnl(
        [snap('2026-07-27', 0, 67.5), snap('2026-07-28', 67.5, 22.5), snap('2026-07-29', 22.5, -5.11)],
        new Map(),
        '2026-07-12',
      );
      for (const d of r.priorOptionsLagDates) {
        expect(r.priorOptionsLagEligibleDates).toContain(d);
      }
      expect(r.priorOptionsLagOk).toBe(false);
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

// TRA-2630 follow-up — the real-money tripwire must distinguish "every live book
// passed" from "there was no live book". The shipped spelling was
// `engines.every(e => e.mode !== 'live' || e.priorOptionsLagOk)`, and `every` is
// true on the empty set, so an all-demo fleet manufactured a green over real
// money it never inspected. bqb1 served exactly that at 2026-07-30T05:16Z.
describe('summarizeLiveLagTripwire — an empty live cohort is NOT MEASURED, never OK', () => {
  // `eligible` defaults to a non-empty cohort so the pre-existing controls below
  // keep asserting what they were written to assert (the mode partition), and the
  // gradeable-cohort axis is exercised explicitly in its own block.
  const book = (
    username: string,
    mode: string,
    ok: boolean | null,
    dates: string[] = [],
    eligible: string[] = ['2026-07-29'],
  ) => ({
    username,
    mode,
    priorOptionsLagOk: ok,
    priorOptionsLagDates: dates,
    priorOptionsLagEligibleDates: eligible,
  });

  it('reports null (NOT MEASURED) when no book resolves mode:live', () => {
    // The live bqb1 shape: 58 demo books, 0 live, boot-arm drifted on `mode`.
    const r = summarizeLiveLagTripwire([
      book('admin', 'demo', true),
      book('Richard', 'demo', false, ['2026-07-28', '2026-07-29']),
    ]);
    expect(r.liveBookCount).toBe(0);
    expect(r.livePriorOptionsLagOk).toBeNull();
    expect(r.livePriorOptionsLagBooks).toEqual([]);
    // The regression this pins: it must NOT read as a pass.
    expect(r.livePriorOptionsLagOk).not.toBe(true);
  });

  it('reports true only when a live book was actually graded and is clean', () => {
    const r = summarizeLiveLagTripwire([
      book('Richard', 'demo', false, ['2026-07-28']),
      book('admin', 'live', true),
    ]);
    expect(r.liveBookCount).toBe(1);
    expect(r.livePriorOptionsLagOk).toBe(true);
    expect(r.livePriorOptionsLagBooks).toEqual([]);
  });

  it('reports false and names the book when a live book shows the lag', () => {
    const r = summarizeLiveLagTripwire([
      book('admin', 'live', false, ['2026-07-29']),
    ]);
    expect(r.liveBookCount).toBe(1);
    expect(r.livePriorOptionsLagOk).toBe(false);
    expect(r.livePriorOptionsLagBooks).toEqual([{ username: 'admin', dates: ['2026-07-29'] }]);
  });

  it('does not count a sandbox-mode book as live coverage', () => {
    // stockModeKey returns 'sandbox' for live-armed-but-paper-routed. Correctly
    // outside a REAL-MONEY tripwire, and equally not evidence that one ran.
    const r = summarizeLiveLagTripwire([book('admin', 'sandbox', true)]);
    expect(r.liveBookCount).toBe(0);
    expect(r.livePriorOptionsLagOk).toBeNull();
  });

  it('is NOT MEASURED on an empty fleet', () => {
    expect(summarizeLiveLagTripwire([]).livePriorOptionsLagOk).toBeNull();
  });

  // TRA-2630 AC2 — THE SECOND EMPTY COHORT. `liveBookCount: 1` closed the "was a
  // live book looked at" hole. It does NOT close "could the tripwire have fired
  // on it": a live book whose every session follows a zero-`optionsDaily` prior is
  // graded by a predicate with no failing state. Same manufactured green, one
  // level in, and it survives a non-empty `liveBookCount`.
  it('reports null when a live book EXISTS but has no gradeable session', () => {
    const r = summarizeLiveLagTripwire([book('admin', 'live', null, [], [])]);
    expect(r.liveBookCount).toBe(1);
    expect(r.liveGradeableBookCount).toBe(0);
    expect(r.livePriorOptionsLagOk).toBeNull();
    // The regression this pins: a non-empty live cohort is not sufficient.
    expect(r.livePriorOptionsLagOk).not.toBe(true);
  });

  it('MUTATION: the same live book reads true once it has one gradeable session', () => {
    const r = summarizeLiveLagTripwire([book('admin', 'live', true, [], ['2026-07-30'])]);
    expect(r.liveBookCount).toBe(1);
    expect(r.liveGradeableBookCount).toBe(1);
    expect(r.livePriorOptionsLagOk).toBe(true);
  });

  it('RED WINS over an ungradeable live book — never masked by NOT MEASURED', () => {
    const r = summarizeLiveLagTripwire([
      book('admin', 'live', false, ['2026-07-30'], ['2026-07-30']),
      book('admin2', 'live', null, [], []),
    ]);
    expect(r.liveGradeableBookCount).toBe(1);
    expect(r.livePriorOptionsLagOk).toBe(false);
    expect(r.livePriorOptionsLagBooks).toEqual([{ username: 'admin', dates: ['2026-07-30'] }]);
  });

  it('a NOT-MEASURED live book is not reported as an offender', () => {
    // `!e.priorOptionsLagOk` was the old offender filter and it coerces `null` to
    // truthy-negative, which would name an unmeasured book in the escalation list
    // and fire the real-money alarm on the absence of data.
    const r = summarizeLiveLagTripwire([
      book('admin', 'live', null, [], []),
      book('admin2', 'live', true, [], ['2026-07-30']),
    ]);
    expect(r.livePriorOptionsLagBooks).toEqual([]);
    expect(r.livePriorOptionsLagOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TRA-2635 (CEO) — "clean" and "the credit path never fired here" are the SAME
// reading on a delta metric. The live `admin` book showed ZERO T+1-lag rows while
// its options leg had earned +$987.60, and that reading was equally consistent
// with a working bridge and a completely unshipped one. These tests pin the
// STATE-based discriminator that separates them.
// ---------------------------------------------------------------------------

const creditSnap = (
  date: string,
  dailyPnl: number,
  optionsDailyPnl: number | undefined,
  optionsCreditedCumulative: number | undefined,
  closingEquity = 2_000 + dailyPnl,
): DailySnapshot => ({
  date,
  openingEquity: 2_000,
  closingEquity,
  dailyPnl,
  optionsPnl: 0,
  optionsDailyPnl,
  optionsCreditedCumulative,
  combinedPnl: dailyPnl + (optionsDailyPnl ?? 0),
  trades: 1,
});

describe('TRA-2635 — equityAbsorbedOptionsOk (did the credit reach equity?)', () => {
  it('publishes the durable closingEquity STATE on every row', () => {
    const r = reconcilePnl([creditSnap('2026-07-28', 10, 0, 0, 2_517.5)], new Map());
    expect(r.days[0]!.closingEquity).toBe(2_517.5);
    expect(r.closingEquityLatest).toBe(2_517.5);
    expect(r.closingEquityLatestDate).toBe('2026-07-28');
  });

  it('leaves optionsCreditedCumulative NULL when the writer never wrote it (never 0)', () => {
    const r = reconcilePnl([creditSnap('2026-07-28', 10, 25, undefined)], new Map());
    expect(r.days[0]!.optionsCreditedCumulative).toBeNull();
    expect(r.optionsCreditedLatest).toBeNull();
    // No counter => nothing to grade, and NOT MEASURED is never a pass.
    expect(r.equityAbsorbedOptionsOk).toBeNull();
    expect(r.optionsCreditedMeasuredCount).toBe(0);
  });

  it('is NOT MEASURED on a book that realized no option P&L, even with the counter written', () => {
    const r = reconcilePnl(
      [creditSnap('2026-07-28', 10, 0, 0), creditSnap('2026-07-29', -4, 0, 0)],
      new Map(),
    );
    // A book that never traded an option cannot verify the bridge — counting it
    // green is the vacuous pass TRA-2625 C5 shipped.
    expect(r.equityAbsorbedOptionsOk).toBeNull();
    expect(r.optionsCreditedMeasuredCount).toBe(0);
  });

  it('is RED when option P&L was realized and equity absorbed none of it', () => {
    // The `admin` shape CEO described: options leg earning, credit counter flat
    // at 0 on every session that realized P&L.
    const r = reconcilePnl(
      [creditSnap('2026-07-28', 0, 450, 0), creditSnap('2026-07-29', 0, 537.6, 0)],
      new Map(),
    );
    expect(r.equityAbsorbedOptionsOk).toBe(false);
    expect(r.counterDurable).toBe(true);
    expect(r.optionsCreditedMeasuredCount).toBe(2);
    expect(r.optionsCreditedDates).toEqual([]);
  });

  // ── The correction found on the FIRST live pull of this field (07:48Z). ──
  it('a ZERO counter on a NON-DURABLE book is NOT MEASURED, not RED', () => {
    // The live `Richard` shape: counter 0 on both sessions while equity moved by
    // exactly the prior session's optionsDaily. The money arrived; the counter
    // that records it did not survive the boot. Calling that `false` is a
    // manufactured red — the same error class as the manufactured green.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-27', 0, 67.5, 0, 2_233.91),
        creditSnap('2026-07-28', 67.5, 22.5, 0, 2_301.41),
        creditSnap('2026-07-29', 22.5, -5.11, 0, 2_323.91),
      ],
      new Map(),
    );
    expect(r.priorOptionsLagDates).toEqual(['2026-07-28', '2026-07-29']);
    expect(r.counterDurable).toBe(false);
    expect(r.counterResetDates).toEqual(['2026-07-28', '2026-07-29']);
    expect(r.equityAbsorbedOptionsOk).toBeNull();
  });

  it('a NEGATIVE credit window also proves the reset (a cumulative cannot decrease)', () => {
    const r = reconcilePnl(
      [creditSnap('2026-07-28', 0, 67.5, 90), creditSnap('2026-07-29', 0, 22.5, 22.5)],
      new Map(),
    );
    expect(r.counterDurable).toBe(false);
    expect(r.counterResetDates).toEqual(['2026-07-29']);
    // A counter that MOVED is still positive evidence — money recorded is
    // recorded, so the guard is asymmetric on purpose.
    expect(r.equityAbsorbedOptionsOk).toBe(true);
  });

  it('publishes the counter-free STATE measurement — the live admin numbers', () => {
    // Equity flat at 2008.29 while the options leg earned, then +235.19 total.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-13', 0, 0, undefined, 2_008.29),
        creditSnap('2026-07-17', 0, 217.5, undefined, 2_008.29),
        creditSnap('2026-07-27', 0, 140, 0, 2_008.29),
        creditSnap('2026-07-28', -0.94, 68, 0, 2_147.35),
        creditSnap('2026-07-29', -17.87, 250.01, 0, 2_243.48),
      ],
      new Map(),
    );
    expect(r.postBaselineEquityGrowth).toBeCloseTo(235.19, 2);
    expect(r.postBaselineOptionsRealized).toBeCloseTo(675.51, 2);
    expect(r.postBaselineStockDaily).toBeCloseTo(-18.81, 2);
    // (675.51 + -18.81) - 235.19
    expect(r.uncreditedOptionsUsd).toBeCloseTo(421.51, 2);
  });

  it('leaves the state measurement NULL on a single-session book (no delta to take)', () => {
    const r = reconcilePnl([creditSnap('2026-07-28', 0, 450, 0)], new Map());
    expect(r.postBaselineEquityGrowth).toBeNull();
    expect(r.uncreditedOptionsUsd).toBeNull();
  });

  it('is GREEN when a session that realized option P&L shows a non-zero credited cumulative', () => {
    const r = reconcilePnl(
      [creditSnap('2026-07-28', 0, 67.5, 67.5), creditSnap('2026-07-29', 0, 22.5, 90)],
      new Map(),
    );
    expect(r.equityAbsorbedOptionsOk).toBe(true);
    expect(r.optionsCreditedMeasuredCount).toBe(2);
    // The window delta names the session the credit actually landed in.
    expect(r.days[1]!.optionsCreditedInWindow).toBeCloseTo(22.5, 2);
    expect(r.optionsCreditedDates).toEqual(['2026-07-29']);
    expect(r.optionsCreditedLatest).toBe(90);
  });

  it('leaves the window NULL when either endpoint is absent (an absent endpoint is not a zero)', () => {
    const r = reconcilePnl(
      [creditSnap('2026-07-28', 0, 67.5, undefined), creditSnap('2026-07-29', 0, 22.5, 90)],
      new Map(),
    );
    expect(r.days[1]!.optionsCreditedInWindow).toBeNull();
  });

  it('reports a NEGATIVE window rather than clamping it — that is the TRA-2629 boot reset', () => {
    const r = reconcilePnl(
      [creditSnap('2026-07-28', 0, 67.5, 90), creditSnap('2026-07-29', 0, 22.5, 22.5)],
      new Map(),
    );
    expect(r.days[1]!.optionsCreditedInWindow).toBeCloseTo(-67.5, 2);
  });

  it('THE DISCRIMINATOR: identical delta rows, identical lag verdict, OPPOSITE credit verdict', () => {
    // Both books realized the same option P&L on the same sessions and neither
    // shows the T+1 mis-bucket. `priorOptionsLagOk` cannot tell them apart —
    // which is exactly why grading the live book off it alone was wrong.
    const credited = reconcilePnl(
      [creditSnap('2026-07-28', 0, 450, 450), creditSnap('2026-07-29', 0, 537.6, 987.6)],
      new Map(),
    );
    const uncredited = reconcilePnl(
      [creditSnap('2026-07-28', 0, 450, 0), creditSnap('2026-07-29', 0, 537.6, 0)],
      new Map(),
    );
    expect(credited.priorOptionsLagOk).toBe(true);
    expect(uncredited.priorOptionsLagOk).toBe(true);
    expect(credited.days.map(d => d.optionsDaily))
      .toEqual(uncredited.days.map(d => d.optionsDaily));
    expect(credited.equityAbsorbedOptionsOk).toBe(true);
    expect(uncredited.equityAbsorbedOptionsOk).toBe(false);
  });

  it('does not grade pre-baseline sessions (the bridge did not exist then)', () => {
    const r = reconcilePnl([creditSnap('2026-07-01', 0, 450, 0)], new Map(), '2026-07-12');
    expect(r.equityAbsorbedOptionsOk).toBeNull();
    expect(r.optionsCreditedMeasuredCount).toBe(0);
  });
});

describe('TRA-2635 — summarizeLiveCreditObservation', () => {
  const book = (
    username: string,
    mode: string,
    equityAbsorbedOptionsOk: boolean | null,
    optionsCreditedMeasuredCount = 1,
  ) => ({
    username,
    mode,
    equityAbsorbedOptionsOk,
    counterDurable: true,
    optionsCreditedMeasuredCount,
    optionsCreditedLatest: 0,
    optionsCreditedDates: [] as string[],
    closingEquityLatest: 2_000,
    closingEquityLatestDate: '2026-07-29',
    uncreditedOptionsUsd: equityAbsorbedOptionsOk === false ? 733.6 : 0,
    postBaselineEquityGrowth: 235.19,
    postBaselineOptionsRealized: 987.6,
    postBaselineStockDaily: -18.81,
  });

  it('is NOT MEASURED on an EMPTY live cohort — never a pass', () => {
    const r = summarizeLiveCreditObservation([book('Richard', 'demo', false)]);
    expect(r.liveCreditBookCount).toBe(0);
    expect(r.liveEquityAbsorbedOptionsOk).toBeNull();
    expect(r.liveCreditBooks).toEqual([]);
  });

  it('is NOT MEASURED when the live book itself was never gradeable', () => {
    const r = summarizeLiveCreditObservation([book('admin', 'live', null, 0)]);
    expect(r.liveCreditBookCount).toBe(1);
    expect(r.liveEquityAbsorbedOptionsOk).toBeNull();
  });

  it('goes RED on a live book whose equity absorbed nothing, and names it', () => {
    const r = summarizeLiveCreditObservation([
      book('admin', 'live', false),
      book('Richard', 'demo', true),
    ]);
    expect(r.liveEquityAbsorbedOptionsOk).toBe(false);
    expect(r.liveCreditBooks.map(b => b.username)).toEqual(['admin']);
  });

  it('a RED live book wins over a green one', () => {
    const r = summarizeLiveCreditObservation([
      book('admin', 'live', true),
      book('operator2', 'live', false),
    ]);
    expect(r.liveEquityAbsorbedOptionsOk).toBe(false);
  });

  it('claims green only off a genuinely measured live book', () => {
    const r = summarizeLiveCreditObservation([
      book('admin', 'live', true),
      book('operator2', 'live', null, 0),
    ]);
    expect(r.liveEquityAbsorbedOptionsOk).toBe(true);
  });

  it('a SANDBOX-armed book is outside the live cohort and still empties it', () => {
    const r = summarizeLiveCreditObservation([book('admin', 'sandbox', false)]);
    expect(r.liveCreditBookCount).toBe(0);
    expect(r.liveEquityAbsorbedOptionsOk).toBeNull();
    // A zero dollar figure must never be reachable by absence.
    expect(r.liveUncreditedOptionsUsd).toBeNull();
  });

  it('carries the DOLLAR figure, which holds the finding when the boolean is NOT MEASURED', () => {
    const notMeasured = { ...book('admin', 'live', null, 0), uncreditedOptionsUsd: 733.6 };
    const r = summarizeLiveCreditObservation([notMeasured]);
    expect(r.liveEquityAbsorbedOptionsOk).toBeNull();
    expect(r.liveUncreditedOptionsUsd).toBeCloseTo(733.6, 2);
  });
});
