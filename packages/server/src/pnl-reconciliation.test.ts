import { describe, it, expect } from 'vitest';
import {
  reconcilePnl,
  resolveLiveAnchorState,
  ANCHOR_BASIS_LIVE_PRIOR_ARCHIVED_CLOSE,
  resolvePnlBaselineDate,
  foldJournalClosesByEtDay,
  liveOptionsOnsetEtDate,
  summarizeLiveLagTripwire,
  summarizeJournalDayCellAgreement,
  ACKNOWLEDGED_JOURNAL_DAY_CELL_SUPERSESSIONS,
  summarizeLiveCreditObservation,
  summarizeLiveEodRowPresence,
  summarizeLiveCombinedAgreement,
  summarizeLiveCohortIntegrity,
  countStaleTailSessions,
  summarizeDriftGradeability,
  summarizePostOnsetLiveCredit,
  PNL_RECONCILE_DEFAULT_BASELINE_DATE,
  PNL_RECONCILIATION_CAVEATS,
  PNL_DRIFT_DECOMPOSITION_NOTE,
  PNL_ABSENT_EOD_ROW_NOTE,
  PNL_POST_ONSET_JOURNAL_CREDIT_NOTE,
  PNL_COMBINED_AGREEMENT_NOTE,
} from './pnl-reconciliation.js';
import type { EquitySourceEraBoundary, PostOnsetLiveCredit } from './pnl-reconciliation.js';
import type { DailySnapshot } from './pnl-tracker.js';

/**
 * TRA-2919 — the journal-sourced post-onset axis, NOT MEASURED. Every fixture in
 * the `summarizeLiveCreditObservation` blocks below predates this field and grades
 * a different question, so the default has to be the state that changes no verdict
 * they were written to make: no live onset, therefore no numerator.
 */
const NO_POST_ONSET_CREDIT: PostOnsetLiveCredit = {
  onsetDate: null,
  journalCensusAvailable: true,
  anchorBasis: null,
  leftAnchorDate: null,
  leftAnchorEquity: null,
  rightAnchorDate: null,
  rightAnchorEquity: null,
  leftAnchorEquityBasis: null,
  rightAnchorEquityBasis: null,
  windowSessions: null,
  windowRowDates: [],
  absentSessions: null,
  journalOptionsUsd: null,
  dayCellOptionsUsd: null,
  stockDailyUsd: null,
  equityGrowthUsd: null,
  windowNetCashFlowUsd: null,
  uncreditedOptionsUsd: null,
  notMeasuredReason: 'no-live-options-onset',
  legs: [],
};

/**
 * TRA-3589 — no NAV source-of-record boundary on this book's series.
 *
 * Every `summarizeLiveCreditObservation` fixture below predates the field and
 * grades a different question, so the default is the state that changes none of
 * their verdicts. It must be the NON-straddling one specifically: a fixture that
 * straddled by default would null `uncreditedOptionsUsd` fleet-wide and silence
 * the TRA-2635/2831/2922 assertions rather than failing them.
 */
const NO_EQUITY_SOURCE_ERA_BOUNDARY: EquitySourceEraBoundary = {
  brokerOnsetDate: null,
  brokerOnsetOpeningEquity: null,
  priorEraRowDate: null,
  priorEraRowEquitySourceEra: null,
  priorEraRowClosingEquity: null,
  restatementUsd: null,
  eraCensus: {},
  seriesSpansBrokerBoundary: false,
};

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
    // TRA-2637 — was `0`, which is the same value a reconciled day writes. Absence
    // is still not a MISMATCH (`ok` stays true) but it is no longer a PASS.
    expect(r.days[0].drift).toBeNull();
    expect(r.days[0].eodRowMissing).toBe(true);
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
      expect(Math.abs(legacy.drift!)).toBeGreaterThan(1000);
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
      expect(m.get('2026-07-13')).toEqual({ closes: 2, partialCloses: 0, realizedPnlUsd: 241.5 });
      expect(m.get('2026-07-15')).toEqual({ closes: 1, partialCloses: 0, realizedPnlUsd: 17 });
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
    // TRA-2895 — `[date, closes, pnl]` with an optional 4th `partialCloses`
    // term, so the existing full-close cases stay byte-identical and the
    // trim-only case can be expressed.
    const census = (rows: Array<[string, number, number] | [string, number, number, number]>) =>
      new Map(rows.map(([d, closes, pnl, partialCloses]) =>
        [d, { closes, partialCloses: partialCloses ?? 0, realizedPnlUsd: pnl }]));

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
      // TRA-2641 — this asserted `true` and that was the SAME trap one leg over.
      // With no report file there is no second operand on the options leg either,
      // so a green graded nothing. `null` = NOT MEASURED.
      expect(r.optionsLegOk).toBeNull();
      expect(r.optionsLegMeasuredCount).toBe(0);
      expect(r.optionsLegSlavedCount).toBe(0);
    });

    it('TRA-2641 — a JOURNAL-SLAVED row is not independent evidence: the file leg IS the day cell', () => {
      // THE LIVE SHAPE, `admin` 2026-07-29 under build 239f2b5. TRA-2641's
      // `syncEodReportOptionsLegs` writes the day cell's `optionsDailyPnl` into
      // the report file's options leg on every `journal`/`journal-repair` row, so
      // `optionsLegDrift` is 0 BY CONSTRUCTION — one source vs a copy of itself.
      // A boolean rendered this as a green, and it flipped false→true across that
      // deploy (`maxOptionsLegDriftUsd` 217.50 → 0.00), which reads as "fixed".
      const r = reconcilePnl(
        [{ ...snap('2026-07-29', -17.87, 250.01), optionsDailyPnlSource: 'journal-repair' }],
        new Map([['2026-07-29', 250.01]]),
        '2026-07-12',
        null,
        new Map([['2026-07-29', 250.01]]), // written FROM the day cell above
        new Map([['2026-07-29', 0]]),
      );
      expect(r.days[0]).toMatchObject({ optionsLegDrift: 0, optionsDailyPnlSource: 'journal-repair' });
      expect(r.optionsLegOk).toBeNull();
      expect(r.optionsLegMeasuredCount).toBe(0);
      expect(r.optionsLegSlavedCount).toBe(1);
      // The numbers stay fully visible — `null` suppresses the VERDICT, not evidence.
      expect(r.maxOptionsLegDriftUsd).toBe(0);
    });

    it('TRA-2641 — MUTATION: the same agreeing legs on an UNSLAVED row ARE evidence ⇒ true', () => {
      // The discriminator. Identical numbers, identical 0.00 drift; the ONLY
      // difference is whether a writer joined the operands. Without this the fix
      // could be "always null", which grades exactly as much as always-true did.
      const r = reconcilePnl(
        [{ ...snap('2026-07-29', 0, 250.01), optionsDailyPnlSource: 'bucket-journal-silent' }],
        new Map([['2026-07-29', 250.01]]),
        '2026-07-12',
        null,
        new Map([['2026-07-29', 250.01]]),
        new Map([['2026-07-29', 0]]),
      );
      expect(r.optionsLegOk).toBe(true);
      expect(r.optionsLegMeasuredCount).toBe(1);
      expect(r.optionsLegSlavedCount).toBe(0);
    });

    it('TRA-2641 — RED outranks NOT MEASURED: a slaved row that STILL disagrees is a real defect', () => {
      // If the sync writer failed to persist, a journal-slaved row can genuinely
      // disagree. The empty-denominator `null` must never swallow that — it is
      // evidence `syncEodReportOptionsLegs` did not run, not evidence of nothing.
      const r = reconcilePnl(
        [{ ...snap('2026-07-17', 0, 0), optionsDailyPnlSource: 'journal-repair' }],
        new Map([['2026-07-17', 217.5]]),
        '2026-07-12',
        null,
        new Map([['2026-07-17', 217.5]]), // file never got rewritten to 0
        new Map([['2026-07-17', 0]]),
      );
      expect(r.days[0]).toMatchObject({ optionsLegDrift: 217.5 });
      expect(r.optionsLegMeasuredCount).toBe(0); // no independent cohort...
      expect(r.optionsLegOk).toBe(false);        // ...and STILL red, not null
      expect(r.optionsLegOffendingDates).toEqual(['2026-07-17']);
    });

    it('TRA-2641 — an UNSLAVED row with 0.00 on BOTH legs is vacuous, not a pass', () => {
      // The other 20 of the 167 live post-baseline rows. Two zeroes agreeing is
      // the same non-evidence that killed `stockLegOk`.
      const r = reconcilePnl(
        [snap('2026-07-13', 0, 0)],
        new Map([['2026-07-13', 0]]),
        '2026-07-12',
        null,
        new Map([['2026-07-13', 0]]),
        new Map([['2026-07-13', 0]]),
      );
      expect(r.days[0]).toMatchObject({ optionsLegDrift: 0 });
      expect(r.optionsLegMeasuredCount).toBe(0);
      expect(r.optionsLegOk).toBeNull();
    });

    // -------------------------------------------------------------------------
    // TRA-2924 — the COVERAGE axis. 602c276 published the denominator and the
    // gate STILL graded a fleet-wide green off it: live 2026-08-05 (build
    // 237c147e) read `optionsLegOk: true` on 1 measured row against 207 slaved.
    // These controls are built to the 602c276 template — identical numbers,
    // identical verdict under the old code, must grade differently now.
    // -------------------------------------------------------------------------
    it('TRA-2924 AC2 — MUTATION: identical drift, identical MEASURED count, different COVERAGE ⇒ different verdicts', () => {
      // The discriminator, and it is deliberately sharper than "different share".
      // Both arms measure EXACTLY ONE row, that row is byte-identical, every
      // drift is 0 and neither arm has an offender. The only difference is
      // whether other rows that had something to say were excluded. If the fix
      // were keyed on the denominator (which 602c276 already published) both
      // arms would grade the same — which is precisely how the live `true` got
      // asserted off n=1.
      const measuredRow = { ...snap('2026-07-29', 0, 250.01), optionsDailyPnlSource: 'bucket-journal-silent' as const };

      // ARM A — that row is the WHOLE cohort. Nothing was silenced.
      const a = reconcilePnl(
        [measuredRow],
        new Map([['2026-07-29', 250.01]]),
        '2026-07-12',
        null,
        new Map([['2026-07-29', 250.01]]),
        new Map([['2026-07-29', 0]]),
      );

      // ARM B — the SAME row plus three journal-slaved rows carrying real
      // figures. Their operands are joined, so they are excluded from the
      // denominator (TRA-2641, correctly) — but they had something to say and
      // were never asked. This is the live shape at 1-vs-207, scaled down.
      const b = reconcilePnl(
        [
          measuredRow,
          { ...snap('2026-07-27', 0, 140), optionsDailyPnlSource: 'journal-repair' as const },
          { ...snap('2026-07-28', 0, 114), optionsDailyPnlSource: 'journal' as const },
          { ...snap('2026-07-30', 0, 33.5), optionsDailyPnlSource: 'journal-repair' as const },
        ],
        new Map([
          ['2026-07-27', 140], ['2026-07-28', 114], ['2026-07-29', 250.01], ['2026-07-30', 33.5],
        ]),
        '2026-07-12',
        null,
        new Map([
          ['2026-07-27', 140], ['2026-07-28', 114], ['2026-07-29', 250.01], ['2026-07-30', 33.5],
        ]),
        new Map([
          ['2026-07-27', 0], ['2026-07-28', 0], ['2026-07-29', 0], ['2026-07-30', 0],
        ]),
      );

      // The arithmetic is provably identical on both arms — the verdicts cannot
      // be resting on a number that differs.
      expect(a.maxOptionsLegDriftUsd).toBe(0);
      expect(b.maxOptionsLegDriftUsd).toBe(0);
      expect(a.optionsLegOffendingDates).toEqual([]);
      expect(b.optionsLegOffendingDates).toEqual([]);
      // ...and so is the DENOMINATOR 602c276 shipped. One row measured, both arms.
      expect(a.optionsLegMeasuredCount).toBe(1);
      expect(b.optionsLegMeasuredCount).toBe(1);
      expect(a.optionsLegCoveredDates).toEqual(['2026-07-29']);
      expect(b.optionsLegCoveredDates).toEqual(['2026-07-29']);

      // THE SEPARATION. Under the pre-TRA-2924 code both of these were `true`.
      expect(a.optionsLegScope).toBe('fleet');
      expect(a.optionsLegOk).toBe(true);
      expect(a.optionsLegSilencedDates).toEqual([]);

      expect(b.optionsLegScope).toBe('partial');
      expect(b.optionsLegOk).toBeNull();
      expect(b.optionsLegSilencedDates).toEqual(['2026-07-27', '2026-07-28', '2026-07-30']);
      // Descriptive only — nothing branches on it, but it must report the thinness.
      expect(b.optionsLegCoverageShare).toBe(0.25);
      expect(a.optionsLegCoverageShare).toBe(1);
    });

    it('TRA-2924 — the LIVE 1-vs-207 shape: a lone independent row cannot speak for a slaved fleet', () => {
      // The exact degradation the ticket was filed on, at n=1 measured against a
      // slaved majority. On 07-30 this read `null` (nothing independent existed);
      // one independent row appeared and it flipped to `true`. The green must not
      // be purchasable that cheaply.
      const days = [
        { ...snap('2026-07-29', 0, 250.01), optionsDailyPnlSource: 'bucket-journal-silent' as const },
        ...Array.from({ length: 20 }, (_, i) => ({
          ...snap(`2026-08-${String(i + 1).padStart(2, '0')}`, 0, 12.5),
          optionsDailyPnlSource: 'journal' as const,
        })),
      ];
      const eod = new Map(days.map(d => [d.date, d.optionsDailyPnl ?? 0]));
      const r = reconcilePnl(
        days, eod, '2026-07-12', null, eod,
        new Map(days.map(d => [d.date, 0])),
      );
      expect(r.optionsLegMeasuredCount).toBe(1);
      expect(r.optionsLegSlavedCount).toBe(20);
      expect(r.optionsLegSilencedDates).toHaveLength(20);
      expect(r.optionsLegScope).toBe('partial');
      expect(r.optionsLegOk).toBeNull();
      // `null` suppresses the CLAIM, never the finding: the row that DID have
      // independent operands and DID agree is still named.
      expect(r.optionsLegCoveredDates).toEqual(['2026-07-29']);
    });

    it('TRA-2924 — RED still outranks a PARTIAL scope: a thin cohort never hides a live defect', () => {
      // The `null` branch is now reachable two ways, so it is twice as attractive
      // a hiding place. A disagreeing row wins over both of them.
      const r = reconcilePnl(
        [
          { ...snap('2026-07-29', 0, 250.01), optionsDailyPnlSource: 'bucket-journal-silent' as const },
          { ...snap('2026-07-17', 0, 0), optionsDailyPnlSource: 'journal-repair' as const },
        ],
        new Map([['2026-07-29', 250.01], ['2026-07-17', 217.5]]),
        '2026-07-12',
        null,
        new Map([['2026-07-29', 250.01], ['2026-07-17', 217.5]]),
        new Map([['2026-07-29', 0], ['2026-07-17', 0]]),
      );
      expect(r.optionsLegScope).toBe('partial'); // coverage is still thin...
      expect(r.optionsLegOk).toBe(false);        // ...and the verdict is still RED
      expect(r.optionsLegOffendingDates).toEqual(['2026-07-17']);
    });

    it('TRA-2924 — a VACUOUS excluded row silences nothing, so the fleet green survives', () => {
      // The rule must key on rows that HAD SOMETHING TO SAY, not on every row it
      // failed to measure. A slaved row carrying 0.00 on both legs could not have
      // disagreed under any writer, so excluding it costs the verdict no
      // coverage. Without this the scope would read `partial` forever on any book
      // with a quiet day, and a gate that can never be green grades nothing —
      // the same dead state TRA-2630 found on `ok`.
      const r = reconcilePnl(
        [
          { ...snap('2026-07-29', 0, 250.01), optionsDailyPnlSource: 'bucket-journal-silent' as const },
          { ...snap('2026-07-13', 0, 0), optionsDailyPnlSource: 'journal' as const },
        ],
        new Map([['2026-07-29', 250.01], ['2026-07-13', 0]]),
        '2026-07-12',
        null,
        new Map([['2026-07-29', 250.01], ['2026-07-13', 0]]),
        new Map([['2026-07-29', 0], ['2026-07-13', 0]]),
      );
      expect(r.optionsLegSlavedCount).toBe(1);   // it WAS excluded...
      expect(r.optionsLegSilencedDates).toEqual([]); // ...and it had nothing to say
      expect(r.optionsLegScope).toBe('fleet');
      expect(r.optionsLegOk).toBe(true);
    });

    it('TRA-2924 — an ABSENT report leg over a non-zero day cell is SILENCED, not vacuous', () => {
      // The TRA-2637 absent-row hazard, seen from the coverage side. The row is
      // forced to drift 0 because `eodOptionsPnl` is null, so it contributes no
      // offender and drops out of the denominator — but the journal booked
      // $140.00 that day and the report never answered. That is an unasked
      // question, not a quiet day.
      const r = reconcilePnl(
        [
          { ...snap('2026-07-29', 0, 250.01), optionsDailyPnlSource: 'bucket-journal-silent' as const },
          { ...snap('2026-07-27', 0, 140), optionsDailyPnlSource: 'bucket-journal-silent' as const },
        ],
        new Map([['2026-07-29', 250.01]]),
        '2026-07-12',
        null,
        new Map([['2026-07-29', 250.01]]), // 07-27 has NO report options leg
        new Map([['2026-07-29', 0]]),
      );
      expect(r.days.find(d => d.date === '2026-07-27')).toMatchObject({
        eodOptionsPnl: null,
        optionsLegDrift: 0,
      });
      expect(r.optionsLegSilencedDates).toEqual(['2026-07-27']);
      expect(r.optionsLegScope).toBe('partial');
      expect(r.optionsLegOk).toBeNull();
    });

    it('TRA-2924 — the coverage rule holds no constant: 200 measured with ONE silenced row is still partial', () => {
      // The anti-threshold control. A minimum-cohort-size rule ("n >= 20") or a
      // share rule ("share >= 0.9") would pass this at 200-vs-1 and would have to
      // be re-tuned every time the fleet changes shape. The identity does not
      // move: one unasked row means the verdict does not cover the cohort.
      const dayAfterBaseline = (i: number) =>
        new Date(Date.UTC(2026, 6, 13 + i)).toISOString().slice(0, 10);
      const measured = Array.from({ length: 200 }, (_, i) => ({
        ...snap(dayAfterBaseline(i), 0, 10),
        optionsDailyPnlSource: 'bucket-journal-silent' as const,
      }));
      const days = [
        ...measured,
        { ...snap(dayAfterBaseline(500), 0, 99), optionsDailyPnlSource: 'journal' as const },
      ];
      const eod = new Map(days.map(d => [d.date, d.optionsDailyPnl ?? 0]));
      const r = reconcilePnl(days, eod, '2026-07-12', null, eod, new Map(days.map(d => [d.date, 0])));
      expect(r.optionsLegMeasuredCount).toBe(200);
      expect(r.optionsLegSilencedDates).toEqual([dayAfterBaseline(500)]);
      expect(r.optionsLegCoverageShare).toBe(0.995);
      expect(r.optionsLegScope).toBe('partial');
      expect(r.optionsLegOk).toBeNull();
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

describe('TRA-2658 — the FROZEN counter (the signature counterDurable could not see)', () => {
  // THE PINNED LIVE OBSERVATION. Every number here was read off bqb1
  // `/api/health/pnl-reconciliation` at 2026-07-30T14:08:29Z for `admin`, BEFORE
  // this axis existed — the counters are in-memory and bqb1 restarts several
  // times an hour, so a test written against a later pull would be grading a
  // different book. `openingEquity` is set to the value the row's own arithmetic
  // implies (`closingEquity − dailyPnl − creditInWindow`), which is how the real
  // rows were written; it is not read by `reconcilePnl` and is here for the
  // reader.
  const adminLive = (): DailySnapshot[] => [
    // 07-13: the first evaluated session. Counter not yet written (pre-TRA-2323
    // rows carry no field at all), so it serves `null`, never 0.
    { date: '2026-07-13', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: 0, combinedPnl: 0, trades: 0 },
    // 07-14 .. 07-24: the PRE-BRIDGE sessions (`ec09e42` went live 07-25T22:34Z).
    // Equity does not move a cent across all 11 of them while the options leg
    // books +$529.59. The full series is carried, not abridged: `uncreditedOptionsUsd`
    // sums Σ optionsDaily over the SPANNED rows, so dropping a session silently
    // shrinks the very figure this test pins.
    { date: '2026-07-14', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: 0, combinedPnl: 0, trades: 0 },
    { date: '2026-07-15', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: 17, combinedPnl: 17, trades: 0 },
    { date: '2026-07-16', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: -4.5, combinedPnl: -4.5, trades: 0 },
    { date: '2026-07-17', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: 217.5, combinedPnl: 217.5, trades: 0 },
    { date: '2026-07-20', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: 75.3, combinedPnl: 75.3, trades: 0 },
    { date: '2026-07-21', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: 80.5, combinedPnl: 80.5, trades: 0 },
    { date: '2026-07-22', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: 54.4, combinedPnl: 54.4, trades: 0 },
    { date: '2026-07-23', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: 29.89, combinedPnl: 29.89, trades: 0 },
    { date: '2026-07-24', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: 59.5, combinedPnl: 59.5, trades: 0 },
    // 07-27: first row that carries the counter — and it carries 0.
    { date: '2026-07-27', openingEquity: 2_008.29, closingEquity: 2_008.29, dailyPnl: 0, optionsPnl: 0, optionsDailyPnl: 140, optionsCreditedCumulative: 0, combinedPnl: 140, trades: 0 },
    // 07-28: equity +139.06 against a −0.94 stock leg ⇒ +140.00 arrived and was
    // absorbed by `openingEquity` across a boot. Counter still 0.
    { date: '2026-07-28', openingEquity: 2_148.29, closingEquity: 2_147.35, dailyPnl: -0.94, optionsPnl: 0, optionsDailyPnl: 68, optionsCreditedCumulative: 0, combinedPnl: 67.06, trades: 0 },
    // 07-29: equity +96.13 against a −17.87 stock leg ⇒ +114.00 arrived. Still 0.
    { date: '2026-07-29', openingEquity: 2_261.35, closingEquity: 2_243.48, dailyPnl: -17.87, optionsPnl: 0, optionsDailyPnl: 250.01, optionsCreditedCumulative: 0, combinedPnl: 232.14, trades: 0 },
  ];

  it('reproduces the live admin book: counterDurable was TRUE over $254.00 of lost credit', () => {
    const r = reconcilePnl(adminLive(), new Map(), '2026-07-12');
    // The reset-only predicate is still empty — that is the whole finding. Neither
    // original signature fires, so the PRE-TRA-2658 verdict was `true`.
    expect(r.counterResetDates).toEqual([]);
    expect(r.priorOptionsLagOk).toBe(true);
    // And the counter is nonetheless recording nothing at all.
    const byDate = new Map(r.days.map(d => [d.date, d]));
    expect(byDate.get('2026-07-28')!.optionsCreditedInWindow).toBe(0);
    expect(byDate.get('2026-07-29')!.optionsCreditedInWindow).toBe(0);
    // The third signature, to the cent, against the pinned live figures.
    expect(byDate.get('2026-07-28')!.unbookedEquityMoveUsd).toBeCloseTo(140, 2);
    expect(byDate.get('2026-07-29')!.unbookedEquityMoveUsd).toBeCloseTo(114, 2);
    expect(r.counterFrozenDates).toEqual(['2026-07-28', '2026-07-29']);
    expect(r.maxUnbookedEquityMoveUsd).toBeCloseTo(140, 2);
    // AC2 now has a failing state on this book.
    expect(r.counterDurable).toBe(false);
    expect(r.counterNonDurableDates).toEqual(['2026-07-28', '2026-07-29']);
    // 140.00 + 114.00 = the $254.00 that reached equity.
    const credited = (byDate.get('2026-07-28')!.unbookedEquityMoveUsd ?? 0)
      + (byDate.get('2026-07-29')!.unbookedEquityMoveUsd ?? 0);
    expect(credited).toBeCloseTo(254, 2);
    // And the state measurement is unchanged by any of this — it needs no counter.
    expect(r.uncreditedOptionsUsd).toBeCloseTo(733.6, 2);
    expect(r.postBaselineEquityGrowth).toBeCloseTo(235.19, 2);
    expect(r.postBaselineOptionsRealized).toBeCloseTo(987.6, 2);
    expect(r.postBaselineStockDaily).toBeCloseTo(-18.81, 2);
    // The residue decomposes with NO remainder: 529.59 pre-bridge (07-14..07-24,
    // never credited, no bridge existed) + 204.01 of 07-29's 250.01 still pending
    // (46.00 of it was credited inside 07-29's own window, which is what made the
    // 114.00 exceed 07-28's realized 68.00 — a settle-vs-21:00-close boundary, not
    // an unattributed credit).
    expect(529.59 + (250.01 - 46)).toBeCloseTo(733.6, 2);
  });

  it('the equityAbsorbedOptionsOk verdict retreats to NOT MEASURED, not a manufactured red', () => {
    const r = reconcilePnl(adminLive(), new Map(), '2026-07-12');
    // Pre-TRA-2658 this served `false` — "equity absorbed none of it" — off a
    // counter that was provably not recording. $254.00 HAD been absorbed. A
    // counter this untrustworthy must not produce a verdict in either direction.
    expect(r.equityAbsorbedOptionsOk).toBeNull();
  });

  it('a continuously-run book has NO un-booked move — the passing state is reachable', () => {
    const r = reconcilePnl(
      [
        creditSnap('2026-07-27', 10, 40, 100, 2_100),
        // Counter moved +50, equity moved +60, stock leg +10. Fully explained.
        creditSnap('2026-07-28', 10, 40, 150, 2_160),
      ],
      new Map(),
      '2026-07-12',
    );
    expect(r.days[1]!.unbookedEquityMoveUsd).toBeCloseTo(0, 2);
    expect(r.counterFrozenDates).toEqual([]);
    expect(r.counterDurable).toBe(true);
    expect(r.equityAbsorbedOptionsOk).toBe(true);
  });

  it('does NOT accuse a starting-balance edit: an un-booked move with no option P&L in the window', () => {
    // `PaperAccount.applyEquity()` rebases equity on a settings save. That is an
    // un-booked move and is NOT a counter defect. Flagging it would manufacture a
    // red on every book whose operator edited demo equity.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-27', 0, 0, 100, 2_000),
        creditSnap('2026-07-28', 0, 0, 100, 3_000),
      ],
      new Map(),
      '2026-07-12',
    );
    expect(r.days[1]!.unbookedEquityMoveUsd).toBeCloseTo(1_000, 2);
    // Visible, but unattributed — no accusation, and the verdict stays green.
    expect(r.unbookedEquityMoveDates).toEqual(['2026-07-28']);
    expect(r.counterFrozenDates).toEqual([]);
    expect(r.counterDurable).toBe(true);
  });

  it('does NOT accuse a starting-balance edit on a book that DID trade options', () => {
    // The harder arm, and the one a control caught: option P&L in the window is
    // not enough to attribute an arbitrary move. A $1,000 rebase on a book that
    // realized $40 of options is not a lost $1,000 credit — a credit cannot exceed
    // what was realized, which is the ceiling term.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-27', 0, 40, 100, 2_000),
        creditSnap('2026-07-28', 0, 0, 100, 3_000),
      ],
      new Map(),
      '2026-07-12',
    );
    expect(r.days[1]!.unbookedEquityMoveUsd).toBeCloseTo(1_000, 2);
    expect(r.unbookedEquityMoveDates).toEqual(['2026-07-28']);
    expect(r.counterFrozenDates).toEqual([]);
    expect(r.counterDurable).toBe(true);
  });

  it('a FULLY CREDITED book cannot produce a frozen claim — the pool is empty', () => {
    // 1,000 realized and 1,000 recorded, then a +50 starting-balance edit. A bare
    // "≤ cumulative realized" ceiling would let the 50 through and accuse it;
    // subtracting what the counter already recorded is what closes that arm.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-27', 0, 1_000, 0, 2_000),
        creditSnap('2026-07-28', 0, 0, 1_000, 3_000),
        creditSnap('2026-07-29', 0, 0, 1_000, 3_050),
      ],
      new Map(),
      '2026-07-12',
    );
    expect(r.days[2]!.unbookedEquityMoveUsd).toBeCloseTo(50, 2);
    expect(r.unbookedEquityMoveDates).toEqual(['2026-07-29']);
    expect(r.counterFrozenDates).toEqual([]);
    expect(r.counterDurable).toBe(true);
  });

  it('the pool is CUMULATIVE, so a freeze spanning many sessions is still caught', () => {
    // A per-window ceiling (prev 0 + cur 0) would clear this, i.e. clear exactly
    // the longest freezes — the worst ones.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-27', 0, 500, 0, 2_000),
        creditSnap('2026-07-28', 0, 0, 0, 2_000),
        creditSnap('2026-07-29', 0, 0, 0, 2_500),
      ],
      new Map(),
      '2026-07-12',
    );
    expect(r.days[2]!.unbookedEquityMoveUsd).toBeCloseTo(500, 2);
    expect(r.counterFrozenDates).toEqual(['2026-07-29']);
    expect(r.counterDurable).toBe(false);
  });

  it('flags a frozen counter off the CURRENT session\'s option P&L too, not just the prior', () => {
    // A credit can settle and be absorbed inside the same session that realized
    // it (the $46.00 on admin's 07-29). Requiring the PRIOR session to be the
    // only trigger would miss it.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-27', 0, 0, 0, 2_000),
        creditSnap('2026-07-28', 0, 75, 0, 2_075),
      ],
      new Map(),
      '2026-07-12',
    );
    expect(r.days[1]!.unbookedEquityMoveUsd).toBeCloseTo(75, 2);
    expect(r.counterFrozenDates).toEqual(['2026-07-28']);
    expect(r.counterDurable).toBe(false);
  });

  it('is null on the first row and on an absent closingEquity endpoint — never a zero', () => {
    const r = reconcilePnl([creditSnap('2026-07-28', 10, 40, 100, 2_100)], new Map(), '2026-07-12');
    expect(r.days[0]!.unbookedEquityMoveUsd).toBeNull();
    expect(r.counterFrozenDates).toEqual([]);
  });

  it('counterDurable stays NOT MEASURED when the counter was never written at all', () => {
    // The frozen signature must not manufacture a durability verdict on a book
    // that predates the counter entirely — `creditWrittenDays` still gates it.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-27', 0, 60, undefined, 2_000),
        creditSnap('2026-07-28', 0, 0, undefined, 2_060),
      ],
      new Map(),
      '2026-07-12',
    );
    expect(r.days[1]!.unbookedEquityMoveUsd).toBeCloseTo(60, 2);
    expect(r.counterFrozenDates).toEqual(['2026-07-28']);
    expect(r.counterDurable).toBeNull();
  });

  it('a RESET counter is still reported as a reset, distinctly from a freeze', () => {
    // The two need opposite remediations, so the narrower field keeps its meaning.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-27', 0, 40, 200, 2_000),
        creditSnap('2026-07-28', 0, 0, 0, 2_000),
      ],
      new Map(),
      '2026-07-12',
    );
    expect(r.counterResetDates).toEqual(['2026-07-28']);
    expect(r.counterDurable).toBe(false);
  });
});

/**
 * TRA-2926 — `counterFrozen` / the `unbookedEquityMoveUsd` accusation carry the
 * IDENTICAL prior-row dependency the lag detector does, and TRA-2888's gate was
 * not applied to them. On 2026-08-04 (the first session after the permanent
 * 07-30/07-31/08-03 hole) every row's `prevClosingEquity` was 07-29 — a
 * six-day span graded as one window — so 36/36 unbooked rows and 12/12 frozen
 * rows sat on a non-adjacent prior: the mirror image of TRA-2664's vacuous
 * GREEN on the lag axis, a spurious RED on this one. The fix is a GATE, not a
 * recomputation: the gap stays permanent, the denominator gets smaller and
 * honest.
 */
describe('TRA-2926 — the frozen accusation is gated on calendar adjacency', () => {
  const isMarketDay = (iso: string): boolean => {
    const [y, m, d] = iso.split('-').map(Number);
    const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    return dow !== 0 && dow !== 6;
  };
  const cal = (lastSettledSession: string) => ({ lastSettledSession, isMarketDay });

  it('AC2: the post-gap row reads NOT MEASURED (null) on the counter axis, not false — and never true', () => {
    // The exact live shape: 07-29 realized options the counter never recorded,
    // 08-04's equity window spans the gap and carries that money.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-29', 0, 100, 0, 2_000),
        creditSnap('2026-08-04', 0, 0, 0, 2_100),
      ],
      new Map(), '2026-07-12', null, null, null, cal('2026-08-04'),
    );
    const row = r.days.find(d => d.date === '2026-08-04')!;
    expect(row.priorSessionAdjacent).toBe(false);
    expect(row.counterFrozen).toBeNull();
    // AC1: the suppressed row contributes to NO verdict...
    expect(r.counterFrozenDates).toEqual([]);
    // ...but the raw arithmetic is fenced, not deleted — it is still the only
    // non-motion detector of the frozen signature (issue point 4).
    expect(row.unbookedEquityMoveUsd).toBeCloseTo(100, 2);
    expect(r.unbookedEquityMoveDates).toEqual(['2026-08-04']);
    // AC3: the suppression is enumerable, never silent.
    expect(r.counterGapSuppressedDates).toEqual(['2026-08-04']);
    expect(r.counterFrozenGradeableDates).toEqual([]);
  });

  it('an ALL-suppressed cohort reads NOT MEASURED, not vacuously green', () => {
    // The other wrong answer the gate could introduce: with every measurable
    // row suppressed, `counterNonDurableDates` is empty and the pre-fix fold
    // would claim `counterDurable: true` off a detector that graded nothing.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-29', 0, 100, 0, 2_000),
        creditSnap('2026-08-04', 0, 0, 0, 2_100),
      ],
      new Map(), '2026-07-12', null, null, null, cal('2026-08-04'),
    );
    expect(r.counterDurable).toBeNull();
  });

  it('AC4: an ADJACENT prior with a genuinely frozen counter still goes RED', () => {
    // Identical arithmetic to the gap fixture, adjacent pair (Tue -> Wed). If
    // this stops firing the gate silenced the true positives too, which is a
    // regression, not a fix.
    const r = reconcilePnl(
      [
        creditSnap('2026-07-28', 0, 100, 0, 2_000),
        creditSnap('2026-07-29', 0, 0, 0, 2_100),
      ],
      new Map(), '2026-07-12', null, null, null, cal('2026-07-29'),
    );
    expect(r.days.find(d => d.date === '2026-07-29')!.priorSessionAdjacent).toBe(true);
    expect(r.days.find(d => d.date === '2026-07-29')!.counterFrozen).toBe(true);
    expect(r.counterFrozenDates).toEqual(['2026-07-29']);
    expect(r.counterDurable).toBe(false);
    // AC4 asks for the surviving cohort size explicitly: an all-suppressed
    // cohort would make this test vacuous in the other direction.
    console.log(`TRA-2926 AC4 surviving gradeable cohort: ${r.counterFrozenGradeableDates.length} session(s)`);
    expect(r.counterFrozenGradeableDates.length).toBeGreaterThan(0);
    expect(r.counterGapSuppressedDates).toEqual([]);
  });

  it('a clean adjacent history keeps its green — the gap row alone is fenced', () => {
    const r = reconcilePnl(
      [
        creditSnap('2026-07-28', 0, 50, 0, 2_000),
        // Window +50, equity +50: fully explained, graded clean.
        creditSnap('2026-07-29', 0, 0, 50, 2_050),
        // Across the gap: +100 of raw un-booked move, suppressed.
        creditSnap('2026-08-04', 0, 0, 50, 2_150),
      ],
      new Map(), '2026-07-12', null, null, null, cal('2026-08-04'),
    );
    expect(r.counterFrozenGradeableDates).toEqual(['2026-07-29']);
    expect(r.counterGapSuppressedDates).toEqual(['2026-08-04']);
    expect(r.counterFrozenDates).toEqual([]);
    expect(r.counterDurable).toBe(true);
    expect(r.days.find(d => d.date === '2026-08-04')!.unbookedEquityMoveUsd).toBeCloseTo(100, 2);
  });

  it('a NEGATIVE window across the gap is still a RESET red — that signature is gap-robust', () => {
    // A cumulative counter cannot decrease over ANY span, so the reset
    // signature needs no adjacency and a red from it beats NOT MEASURED (the
    // standing TRA-2641 verdict order).
    const r = reconcilePnl(
      [
        creditSnap('2026-07-29', 0, 40, 200, 2_000),
        creditSnap('2026-08-04', 0, 0, 0, 2_000),
      ],
      new Map(), '2026-07-12', null, null, null, cal('2026-08-04'),
    );
    expect(r.counterResetDates).toEqual(['2026-08-04']);
    expect(r.counterFrozenDates).toEqual([]);
    expect(r.counterDurable).toBe(false);
  });

  it('changes nothing when no calendar is supplied — a gap cannot be proven, so behaviour is unchanged', () => {
    const r = reconcilePnl(
      [
        creditSnap('2026-07-29', 0, 100, 0, 2_000),
        creditSnap('2026-08-04', 0, 0, 0, 2_100),
      ],
      new Map(), '2026-07-12',
    );
    expect(r.days.find(d => d.date === '2026-08-04')!.counterFrozen).toBe(true);
    expect(r.counterFrozenDates).toEqual(['2026-08-04']);
    expect(r.counterGapSuppressedDates).toEqual([]);
  });

  // TRA-3267 — the `sessionsInRange(...).length === 2` adjacency test assumes
  // both endpoints are sessions. The 21:00 ET archive's host-UTC weekday read
  // wrote a PHANTOM Sunday row fleet-wide on 2026-08-09 while dropping Friday
  // 08-07, and [Thu 08-06, Sun 08-09] contains exactly two sessions (Thursday
  // and the unwritten Friday) — so the phantom pair graded ADJACENT and carried
  // Friday's real P&L as a frozen-counter accusation on 3 live-fleet books.
  it('TRA-3267: a row dated on a NON-SESSION can never grade adjacent — the phantom Sunday is fenced, not accused', () => {
    const r = reconcilePnl(
      [
        // Thursday close.
        creditSnap('2026-08-06', 0, 50, 0, 2_000),
        // Phantom Sunday row: Friday's +40.89 sits in its window, unbooked.
        creditSnap('2026-08-09', 0, 0, 0, 2_040.89),
        // Legitimate Monday row.
        creditSnap('2026-08-10', 0, 0, 0, 2_040.89),
      ],
      new Map(), '2026-07-12', null, null, null, cal('2026-08-10'),
    );
    const sunday = r.days.find(d => d.date === '2026-08-09')!;
    expect(sunday.priorSessionAdjacent).toBe(false);
    expect(sunday.counterFrozen).toBeNull();
    expect(r.counterFrozenDates).toEqual([]);
    // The raw arithmetic stays published — fenced, not deleted — and the
    // suppression is enumerable, never silent (same contract as TRA-2926).
    expect(sunday.unbookedEquityMoveUsd).toBeCloseTo(40.89, 2);
    expect(r.counterGapSuppressedDates).toContain('2026-08-09');
  });
});

describe('TRA-2658 — liveCounterDurableOk', () => {
  const cbook = (username: string, mode: string, counterDurable: boolean | null) => ({
    username,
    mode,
    equityAbsorbedOptionsOk: null as boolean | null,
    counterDurable,
    counterFrozenDates: counterDurable === false ? ['2026-07-28'] : [],
    counterNonDurableDates: counterDurable === false ? ['2026-07-28'] : [],
    maxUnbookedEquityMoveUsd: counterDurable === false ? 140 : 0,
    optionsCreditedMeasuredCount: 1,
    optionsCreditedLatest: 0,
    optionsCreditedDates: [] as string[],
    closingEquityLatest: 2_243.48,
    closingEquityLatestDate: '2026-07-29',
    uncreditedOptionsUsd: 733.6,
    postBaselineEquityGrowth: 235.19,
    postBaselineOptionsRealized: 987.6,
    postBaselineStockDaily: -18.81,
    // TRA-2831 — attributable by default so the assertions in this block keep
    // grading what they were written to grade. Contamination has its own block.
    liveOptionsOnsetDate: '2026-07-13' as string | null,
    optionsRealizedBeforeLiveOnsetUsd: 0,
    preLiveOnsetOptionsDates: [] as string[],
    postOnsetCredit: NO_POST_ONSET_CREDIT,
    // TRA-3589 — no era boundary by default; see NO_EQUITY_SOURCE_ERA_BOUNDARY.
    uncreditedOptionsNotMeasuredReason: null as string | null,
    postBaselineEquityGrowthSpansEquitySourceEras: false,
    equitySourceEraBoundary: NO_EQUITY_SOURCE_ERA_BOUNDARY,
  });

  it('is NOT MEASURED on an empty live cohort — never a passing durability grade', () => {
    // bqb1 serves this state intermittently on a boot-arm miss: 2026-07-30T14:08Z
    // had liveBookCount 0 with `admin` resolved `demo`.
    const r = summarizeLiveCreditObservation([cbook('admin', 'demo', false)]);
    expect(r.liveCreditBookCount).toBe(0);
    expect(r.liveCounterDurableOk).toBeNull();
  });

  it('goes RED on a live book with a non-durable counter', () => {
    const r = summarizeLiveCreditObservation([cbook('admin', 'live', false)]);
    expect(r.liveCounterDurableOk).toBe(false);
    expect(r.liveCreditBooks[0]!.counterFrozenDates).toEqual(['2026-07-28']);
    expect(r.liveCreditBooks[0]!.maxUnbookedEquityMoveUsd).toBe(140);
  });

  it('claims green only off a live book that actually wrote the counter', () => {
    expect(summarizeLiveCreditObservation([cbook('admin', 'live', null)]).liveCounterDurableOk)
      .toBeNull();
    expect(summarizeLiveCreditObservation([cbook('admin', 'live', true)]).liveCounterDurableOk)
      .toBe(true);
  });

  it('a RED live book wins over a green one', () => {
    const r = summarizeLiveCreditObservation([
      cbook('admin', 'live', true),
      cbook('operator2', 'live', false),
    ]);
    expect(r.liveCounterDurableOk).toBe(false);
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
    counterDurable: true as boolean | null,
    counterFrozenDates: [] as string[],
    counterNonDurableDates: [] as string[],
    maxUnbookedEquityMoveUsd: 0,
    optionsCreditedMeasuredCount,
    optionsCreditedLatest: 0,
    optionsCreditedDates: [] as string[],
    closingEquityLatest: 2_000,
    closingEquityLatestDate: '2026-07-29',
    uncreditedOptionsUsd: equityAbsorbedOptionsOk === false ? 733.6 : 0,
    postBaselineEquityGrowth: 235.19,
    postBaselineOptionsRealized: 987.6,
    postBaselineStockDaily: -18.81,
    // TRA-2831 — attributable by default so the assertions in this block keep
    // grading what they were written to grade. Contamination has its own block.
    liveOptionsOnsetDate: '2026-07-13' as string | null,
    optionsRealizedBeforeLiveOnsetUsd: 0,
    preLiveOnsetOptionsDates: [] as string[],
    postOnsetCredit: NO_POST_ONSET_CREDIT,
    // TRA-3589 — no era boundary by default; see NO_EQUITY_SOURCE_ERA_BOUNDARY.
    uncreditedOptionsNotMeasuredReason: null as string | null,
    postBaselineEquityGrowthSpansEquitySourceEras: false,
    equitySourceEraBoundary: NO_EQUITY_SOURCE_ERA_BOUNDARY,
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

  // TRA-2831 (CFO) — THE 733.60 IS DEMO MONEY WEARING A LIVE LABEL.
  //
  // Live bqb1 2026-08-04T22:22Z, book `admin`, the fleet's ONLY live book:
  //
  //   liveUncreditedOptionsUsd 733.60
  //     = postBaselineOptionsRealized 987.60
  //     − (postBaselineEquityGrowth 235.19 − postBaselineStockDaily −18.81)
  //
  // and the 987.60 is Σ of eleven `journal-repair` day cells dated 2026-07-15 …
  // 2026-07-29 — a window in which admin held ZERO live options. Its first live
  // position opened 2026-07-30 09:36 ET; its only live closes are 3 rows on
  // 07-31 worth +739.00, which are in NO period at all because 07-30/07-31/08-03
  // have no snapshot rows (TRA-2827).
  //
  // The population the repair read is admin's OWN journal rows scoped by
  // `account` and MODE-BLIND (`journalRowsForBook`) — i.e. its demo history. The
  // proof off the published surface: summing every book's `journal-repair` cells
  // fleet-wide reproduces the demo-mode fleet total to the cent on every test
  // date the CFO checked — 07-15 → 301.30, 07-17 → 102.00, 07-22 → 4,919.50 —
  // with admin contributing 17.00 / 217.50 / 54.40. The partitions ARE the demo
  // population; comparing an unpartitioned fleet total against one book's share
  // is what made it look like a third, unidentifiable population.
  describe('TRA-2831 — a demo→live book must not fold its demo P&L into the live figure', () => {
    const flipped = (username: string, preOnsetUsd: number) => ({
      ...book(username, 'live', false),
      liveOptionsOnsetDate: '2026-07-30' as string | null,
      optionsRealizedBeforeLiveOnsetUsd: preOnsetUsd,
      preLiveOnsetOptionsDates: preOnsetUsd === 0 ? [] : ['2026-07-15', '2026-07-29'],
    });

    it('reads NOT MEASURED — not 733.60 — when the numerator predates live onset', () => {
      const r = summarizeLiveCreditObservation([flipped('admin', 987.6)]);
      expect(r.liveCreditBookCount).toBe(1);
      expect(r.liveUncreditedOptionsUsd).toBeNull();
      // The DAY-CELL figure stays disqualified, and the attribution is published.
      // TRA-2919 moved `liveUncreditedOptionsGradeable` off this predicate — see
      // the block below for why it had no reachable true state on `admin` — so the
      // suspension is asserted here on the two fields that carry it.
      expect(r.liveModeSpanContaminatedBooks).toHaveLength(1);
    });

    it('keeps the arithmetic published as a MEASUREMENT, so the evidence survives', () => {
      // CFO suspended 733.60 as a live-money figure but explicitly kept it
      // published. Deleting it would destroy the evidence the suspension rests
      // on, and a reader must be able to see the disqualification directly by
      // comparing these two fields.
      const r = summarizeLiveCreditObservation([flipped('admin', 987.6)]);
      expect(r.liveUncreditedOptionsUsdUnscoped).toBeCloseTo(733.6, 2);
      expect(r.liveModeSpanContaminatedBooks).toEqual([{
        username: 'admin',
        liveOptionsOnsetDate: '2026-07-30',
        optionsRealizedBeforeLiveOnsetUsd: 987.6,
        preLiveOnsetOptionsDates: ['2026-07-15', '2026-07-29'],
        postBaselineOptionsRealized: 987.6,
        uncreditedOptionsUsd: 733.6,
      }]);
    });

    it('separates "no measurable live book" from "measured, and the money is not live"', () => {
      // Both states publish `liveUncreditedOptionsUsd: null`. They need OPPOSITE
      // remediations — one waits for a live book, the other waits for a
      // mode-scoped ledger — so collapsing them is the whole defect repeating.
      const empty = summarizeLiveCreditObservation([book('Richard', 'demo', false)]);
      expect(empty.liveUncreditedOptionsUsd).toBeNull();
      expect(empty.liveModeSpanContaminatedBooks).toEqual([]);
      expect(empty.liveUncreditedOptionsGradeable).toBe(false);
      expect(empty.liveOnsetCreditNumeratorBookCount).toBe(0);

      const dirty = summarizeLiveCreditObservation([flipped('admin', 987.6)]);
      expect(dirty.liveUncreditedOptionsUsd).toBeNull();
      expect(dirty.liveModeSpanContaminatedBooks).toHaveLength(1);
    });

    it('still grades a live book whose whole window IS post-onset', () => {
      // The gate must not be a permanent null — a book that only ever traded
      // live keeps its figure, or this "fix" is just a mute button.
      const r = summarizeLiveCreditObservation([flipped('admin', 0)]);
      expect(r.liveUncreditedOptionsUsd).toBeCloseTo(733.6, 2);
      expect(r.liveModeSpanContaminatedBooks).toEqual([]);
    });

    it('ONE contaminated book disqualifies the fold — a clean book cannot mask it', () => {
      const r = summarizeLiveCreditObservation([
        flipped('operator2', 0),
        flipped('admin', 987.6),
      ]);
      expect(r.liveUncreditedOptionsUsd).toBeNull();
      expect(r.liveModeSpanContaminatedBooks.map(b => b.username)).toEqual(['admin']);
      // The unscoped sum still adds BOTH, so it stays a checkable arithmetic
      // total rather than quietly becoming the clean subset.
      expect(r.liveUncreditedOptionsUsdUnscoped).toBeCloseTo(1_467.2, 2);
    });

    it('publishes provenance on EVERY live book, not only the contaminated ones', () => {
      // A reader must be able to SEE that a book's figure is attributable, not
      // infer it from absence from the contaminated list.
      const r = summarizeLiveCreditObservation([flipped('admin', 987.6)]);
      expect(r.liveCreditBooks[0]!.liveOptionsOnsetDate).toBe('2026-07-30');
      expect(r.liveCreditBooks[0]!.optionsRealizedBeforeLiveOnsetUsd).toBeCloseTo(987.6, 2);
    });

    it('a book that never traded a live option is contaminated in FULL, not credited', () => {
      // `liveOptionsOnsetDate: null` means nothing in the window is provably
      // live. The safe reading is "none of it", never "all of it".
      const never = {
        ...book('admin', 'live', false),
        liveOptionsOnsetDate: null,
        optionsRealizedBeforeLiveOnsetUsd: 987.6,
        preLiveOnsetOptionsDates: ['2026-07-15'],
      };
      const r = summarizeLiveCreditObservation([never]);
      expect(r.liveUncreditedOptionsUsd).toBeNull();
      expect(r.liveUncreditedOptionsGradeable).toBe(false);
    });
  });
});

describe('TRA-2831 — reconcilePnl partitions the numerator by live onset', () => {
  // Shape of the live tape: an anchor row, then options money booked BEFORE the
  // book ever traded a live option, then one post-onset session.
  const snaps = [
    snap('2026-07-14', 0, 0),      // anchor — outside the telescoped window
    snap('2026-07-15', 0, 17),
    snap('2026-07-29', -17.87, 250.01),
    snap('2026-07-31', 0, 739),
  ];

  it('splits `postBaselineOptionsRealized` into pre- and post-onset money', () => {
    const r = reconcilePnl(snaps, new Map(), '2026-07-12', null, null, null, null, '2026-07-30');
    // The numerator sums the SPANNED rows (1..N), so the anchor is excluded from
    // both sides and the two figures remain subtractable.
    expect(r.postBaselineOptionsRealized).toBeCloseTo(1_006.01, 2);
    expect(r.optionsRealizedBeforeLiveOnsetUsd).toBeCloseTo(267.01, 2);
    expect(r.preLiveOnsetOptionsDates).toEqual(['2026-07-15', '2026-07-29']);
    expect(r.liveOptionsOnsetDate).toBe('2026-07-30');
    // Post-onset remainder is the genuinely live money: 1006.01 − 267.01 = 739.
    expect(r.postBaselineOptionsRealized - r.optionsRealizedBeforeLiveOnsetUsd)
      .toBeCloseTo(739, 2);
  });

  it('treats a NULL onset as "none of this is provably live"', () => {
    // The default for every existing caller, and for a book with no live rows.
    // It must disqualify the whole numerator, never credit it.
    const r = reconcilePnl(snaps, new Map(), '2026-07-12');
    expect(r.liveOptionsOnsetDate).toBeNull();
    expect(r.optionsRealizedBeforeLiveOnsetUsd)
      .toBeCloseTo(r.postBaselineOptionsRealized, 2);
  });

  it('never reports more contamination than the numerator it qualifies', () => {
    // Folding over `evaluated` rather than `spanned` would count the anchor row's
    // options money on one side only — a contamination figure exceeding the
    // numerator, on exactly the books whose first row is active.
    const active = [
      snap('2026-07-14', 0, 500),    // anchor, and NOT quiet
      snap('2026-07-15', 0, 17),
    ];
    const r = reconcilePnl(active, new Map(), '2026-07-12', null, null, null, null, '2026-07-30');
    expect(r.postBaselineOptionsRealized).toBeCloseTo(17, 2);
    expect(r.optionsRealizedBeforeLiveOnsetUsd).toBeCloseTo(17, 2);
    expect(r.preLiveOnsetOptionsDates).toEqual(['2026-07-15']);
  });
});

// TRA-2919 (CFO) — THE LIVE CREDIT AXIS, RE-SOURCED FROM THE JOURNAL.
//
// The state this block reproduces is `admin` on bqb1 as measured 2026-08-05
// (build 237c147e) and re-measured 2026-08-06T16:56Z (build f19fb1fa):
//
//   liveOptionsOnsetDate            2026-07-30
//   eleven day cells 07-15..07-29   Σ optionsDaily 987.60   (all DEMO money)
//   2026-07-30 / 07-31 / 08-03      NO ROW — the permanent TRA-2888 hole
//   2026-08-04                      optionsDaily −2.00, bucket-journal-silent
//   journal, close-dated 07-31      3 closes, +739.00 — booked to NO day cell
//
// Two numerators are available and they disagree by $741.00. The day cells say
// −2.00; the journal says +739.00. The journal is right, and the fixtures below
// are the durable record of that — AC3 asks specifically that the rejected
// arithmetic live in the repo rather than only in the ticket.
describe('TRA-2919 — summarizePostOnsetLiveCredit', () => {
  // NYSE sessions: weekdays. Enough for a window that never crosses a holiday.
  const isMarketDay = (d: string) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  };
  const calendar = { lastSettledSession: '2026-08-05', isMarketDay };
  const row = (date: string, optionsDaily: number, stockDaily: number, closingEquity: number | null) =>
    ({ date, optionsDaily, stockDaily, closingEquity });

  // `admin`'s tape, trimmed to the rows that matter. Eleven pre-onset cells are
  // represented by their two endpoints plus their sum on 07-29 — the arithmetic
  // this axis must EXCLUDE is identical either way.
  const adminRows = [
    row('2026-07-15', 17, 0, 1_500),
    row('2026-07-28', 68, -0.94, 2_147.35),
    row('2026-07-29', 250.01, -17.87, 2_243.48),
    // 2026-07-30 / 07-31 / 08-03 — NEVER CAPTURED. There is no row to write here.
    row('2026-08-04', -2, 0, 2_603.49),
  ];
  const adminJournal = new Map([
    ['2026-07-15', { closes: 1, partialCloses: 0, realizedPnlUsd: 17 }],
    ['2026-07-29', { closes: 6, partialCloses: 0, realizedPnlUsd: 250.01 }],
    // The money the ledger lost. Close-dated, so the journal holds it with no row.
    ['2026-07-31', { closes: 3, partialCloses: 0, realizedPnlUsd: 739 }],
  ]);
  // `admin` IS a `mode: live` book, and since TRA-3288 stating that arms the
  // surface gate: none of these rows carries a broker basis, so the published
  // reason on the live tape is now `equity-anchor-not-broker-sourced` — with
  // the absence evidence still enumerated beside it. Tests that exercise the
  // ABSENCE mechanics in isolation pass `bookMode: 'demo'` below.
  const admin = () => summarizePostOnsetLiveCredit({
    rows: adminRows,
    liveOptionsOnsetDate: '2026-07-30',
    journalClosesByDate: adminJournal,
    calendar,
    bookMode: 'live',
  });

  it('AC1 — the numerator INCLUDES the 07-31 +739.00 and EXCLUDES every pre-onset cell', () => {
    const r = admin();
    expect(r.journalOptionsUsd).toBeCloseTo(739, 2);
    // Positive proof of the exclusion, not just the total: the pre-onset money is
    // 267.01 on these rows, so a numerator that leaked it would read 1006.01.
    expect(r.journalOptionsUsd).not.toBeCloseTo(1_006.01, 2);
    expect(r.legs.map(l => l.date)).toEqual(['2026-07-31', '2026-08-04']);
    expect(r.legs[0]).toEqual({
      date: '2026-07-31',
      journalOptionsUsd: 739,
      journalCloses: 3,
      journalPartialCloses: 0,
      // THE HOLE, per date: real money on a session with no ledger row at all.
      dayCellOptionsUsd: null,
      hasLedgerRow: false,
    });
  });

  it('AC3 — a DAY-CELL numerator would have published −2.00 against that +739.00', () => {
    // The whole reason this was not built the obvious way. `dayCellOptionsUsd` is
    // the rejected arithmetic, computed over the SAME window and published beside
    // the real figure so a reader of the live surface sees both.
    const r = admin();
    expect(r.dayCellOptionsUsd).toBeCloseTo(-2, 2);
    expect(r.journalOptionsUsd).toBeCloseTo(739, 2);
    expect((r.journalOptionsUsd ?? 0) - (r.dayCellOptionsUsd ?? 0)).toBeCloseTo(741, 2);
  });

  it('AC2 — the comparison is NOT MEASURED, and TRA-3288 names the SURFACE, not the hole', () => {
    const r = admin();
    expect(r.anchorBasis).toBe('pre-onset-close');
    expect(r.leftAnchorDate).toBe('2026-07-29');
    expect(r.leftAnchorEquity).toBeCloseTo(2_243.48, 2);
    expect(r.rightAnchorDate).toBe('2026-08-04');
    // The absence evidence is still enumerated and published…
    expect(r.absentSessions).toEqual(['2026-07-30', '2026-07-31', '2026-08-03']);
    // …but on a live book whose anchors are demo-book rows the REASON is the
    // surface gate, with precedence: the hole gate was right by accident (it
    // clears itself the moment a window has full rows), and the real
    // disqualifier is that both anchors read the PaperAccount, not the broker.
    expect(r.notMeasuredReason).toBe('equity-anchor-not-broker-sourced');
    expect(r.leftAnchorEquityBasis).toBeNull();
    expect(r.rightAnchorEquityBasis).toBeNull();
    // The number is what must NOT appear. Had it been published it would read
    // 739.00 + 0.00 − 360.01 = +378.99, an entirely invented shortfall: the equity
    // delta 2243.48 → 2603.49 also absorbs three sessions nobody recorded.
    expect(r.uncreditedOptionsUsd).toBeNull();
  });

  it('the equity growth stays published even when the comparison cannot be made', () => {
    // Suppressing the operands as well would leave a reader unable to see WHY the
    // subtraction was refused — the same mistake as deleting the 733.60 evidence.
    const r = admin();
    expect(r.equityGrowthUsd).toBeCloseTo(360.01, 2);
    expect(r.stockDailyUsd).toBeCloseTo(0, 2);
    // (07-29, 08-04] holds four sessions — 07-30, 07-31, 08-03, 08-04 — and the
    // book has a row for exactly one of them.
    expect(r.windowSessions).toBe(4);
    expect(r.windowRowDates).toEqual(['2026-08-04']);
  });

  it('PUBLISHES the comparison once the window has no hole in it', () => {
    // The arm that proves this is not a permanent null wearing a new name. Same
    // book, same journal, with the three sessions present: 739 + 0 − 360.01.
    const healed = [
      ...adminRows.slice(0, 3),
      row('2026-07-30', 0, 0, 2_243.48),
      row('2026-07-31', 0, 0, 2_605.49),
      row('2026-08-03', 0, 0, 2_605.49),
      row('2026-08-04', -2, 0, 2_603.49),
    ];
    // TRA-3288 — `bookMode: 'demo'`: on a DEMO book the paper account IS the
    // book, so a hole-free window publishes with no broker basis required.
    // (The same tape under `bookMode: 'live'` is the surface-gate arm below.)
    const r = summarizePostOnsetLiveCredit({
      rows: healed,
      liveOptionsOnsetDate: '2026-07-30',
      journalClosesByDate: adminJournal,
      calendar,
      bookMode: 'demo',
    });
    expect(r.absentSessions).toEqual([]);
    expect(r.notMeasuredReason).toBeNull();
    expect(r.uncreditedOptionsUsd).toBeCloseTo(378.99, 2);
  });

  it('a NEW hole outside the documented three still disqualifies the comparison', () => {
    // Absence is enumerated from the CALENDAR, so this predicate cannot be
    // satisfied by a hard-coded allow-list of the TRA-2888 dates, and cannot go
    // green by eviction the way `liveEodTailStaleBooks` did.
    const r = summarizePostOnsetLiveCredit({
      rows: [
        row('2026-07-29', 0, 0, 2_000),
        // 2026-07-30 present, 07-31 and 08-03 present, 08-04 MISSING.
        row('2026-07-30', 0, 0, 2_000),
        row('2026-07-31', 739, 0, 2_739),
        row('2026-08-03', 0, 0, 2_739),
        row('2026-08-05', 0, 0, 2_739),
      ],
      liveOptionsOnsetDate: '2026-07-30',
      journalClosesByDate: adminJournal,
      calendar,
      // Demo mode so the ABSENCE gate is the one under test, not the surface gate.
      bookMode: 'demo',
    });
    expect(r.absentSessions).toEqual(['2026-08-04']);
    expect(r.notMeasuredReason).toBe('equity-anchor-spans-absent-session');
    expect(r.uncreditedOptionsUsd).toBeNull();
  });

  it('reads NOT MEASURED, with a distinct reason, on each way of having no window', () => {
    // Four nulls that need four different remediations. Collapsing any pair of
    // them is the defect this module has now shipped in several shapes.
    const noOnset = summarizePostOnsetLiveCredit({
      rows: adminRows, liveOptionsOnsetDate: null, journalClosesByDate: adminJournal, calendar,
      bookMode: 'live',
    });
    expect(noOnset.notMeasuredReason).toBe('no-live-options-onset');
    expect(noOnset.journalOptionsUsd).toBeNull();

    // `v0nni` as armed on 2026-08-06: live, funded, one row, no live option yet.
    const oneRow = summarizePostOnsetLiveCredit({
      rows: [row('2026-08-05', 0, 0, 25_000)],
      liveOptionsOnsetDate: '2026-08-05',
      journalClosesByDate: new Map(),
      calendar,
      bookMode: 'live',
    });
    expect(oneRow.notMeasuredReason).toBe('no-post-anchor-span');

    const noAnchor = summarizePostOnsetLiveCredit({
      rows: [row('2026-08-04', -2, 0, null), row('2026-08-05', 0, 0, null)],
      liveOptionsOnsetDate: '2026-07-30',
      journalClosesByDate: adminJournal,
      calendar,
      bookMode: 'live',
    });
    expect(noAnchor.notMeasuredReason).toBe('no-equity-anchor');

    // Demo mode: on a live book the TRA-3288 surface gate outranks calendar
    // availability, so `no-session-calendar` is only reachable off-live here.
    const noCalendar = summarizePostOnsetLiveCredit({
      rows: adminRows, liveOptionsOnsetDate: '2026-07-30', journalClosesByDate: adminJournal,
      calendar: null,
      bookMode: 'demo',
    });
    expect(noCalendar.notMeasuredReason).toBe('no-session-calendar');
    // The numerator survives — it does not need a calendar. Only the comparison does.
    expect(noCalendar.journalOptionsUsd).toBeCloseTo(739, 2);
    expect(noCalendar.uncreditedOptionsUsd).toBeNull();
  });

  it('a MISSING journal is not a zero numerator', () => {
    // `?? 0` here would publish a $0.00 live numerator for a book whose entire
    // live record is in the file we failed to read — the TRA-2314 false zero one
    // layer up, and it would carry a comparison that looks perfectly ordinary.
    // `bookMode: 'live'` deliberately: a missing NUMERATOR outranks even the
    // TRA-3288 surface gate — with no journal there is nothing to compare on
    // ANY equity surface, and neither reason path can reach a publish.
    const r = summarizePostOnsetLiveCredit({
      rows: adminRows, liveOptionsOnsetDate: '2026-07-30', journalClosesByDate: null, calendar,
      bookMode: 'live',
    });
    expect(r.journalCensusAvailable).toBe(false);
    expect(r.notMeasuredReason).toBe('no-journal-census');
    expect(r.journalOptionsUsd).toBeNull();
    expect(r.uncreditedOptionsUsd).toBeNull();
    // The day-cell leg is still summed, so the −2.00 foil survives the degraded
    // mode and the two legs stay comparable when the journal returns.
    expect(r.dayCellOptionsUsd).toBeCloseTo(-2, 2);
  });

  it('publishes a day cell the journal does NOT support, rather than dropping it', () => {
    // `admin` 2026-08-05 booked −424.00 from the VOLATILE bucket against zero
    // journal closes (`bucket-journal-silent`). The journal-sourced numerator
    // excludes it by construction; if the leg were not published the divergence
    // would vanish, and a $424 discrepancy on real capital would be invisible.
    const r = summarizePostOnsetLiveCredit({
      rows: [...adminRows, row('2026-08-05', -424, 0, 2_603.49)],
      liveOptionsOnsetDate: '2026-07-30',
      journalClosesByDate: adminJournal,
      calendar,
      bookMode: 'demo',
    });
    const leg = r.legs.find(l => l.date === '2026-08-05');
    expect(leg).toEqual({
      date: '2026-08-05',
      journalOptionsUsd: 0,
      journalCloses: 0,
      journalPartialCloses: 0,
      dayCellOptionsUsd: -424,
      hasLedgerRow: true,
    });
    expect(r.journalOptionsUsd).toBeCloseTo(739, 2);
    expect(r.dayCellOptionsUsd).toBeCloseTo(-426, 2);
  });

  it('excludes pre-onset money even when the anchor sits well BEFORE the onset', () => {
    // A book whose last pre-onset row is 07-15 and whose onset is 07-30: the
    // window opens at 07-16, so 07-29's 250.01 of DEMO money is inside the equity
    // delta. The numerator must still be floored at the onset — and because the
    // sessions between are then rowless, the comparison fails closed rather than
    // subtracting spans that do not match.
    const r = summarizePostOnsetLiveCredit({
      rows: [row('2026-07-15', 17, 0, 1_500), row('2026-08-04', -2, 0, 2_603.49)],
      liveOptionsOnsetDate: '2026-07-30',
      journalClosesByDate: adminJournal,
      calendar,
      // Demo mode so the failing gate under test is the ABSENCE one.
      bookMode: 'demo',
    });
    expect(r.journalOptionsUsd).toBeCloseTo(739, 2);
    expect(r.notMeasuredReason).toBe('equity-anchor-spans-absent-session');
    expect(r.absentSessions).toContain('2026-07-29');
  });

  it('falls back to the first post-onset close when the book has no pre-onset row', () => {
    const r = summarizePostOnsetLiveCredit({
      rows: [row('2026-08-04', 0, 0, 2_500), row('2026-08-05', 100, 0, 2_600)],
      liveOptionsOnsetDate: '2026-08-04',
      journalClosesByDate: new Map([['2026-08-05', { closes: 1, partialCloses: 0, realizedPnlUsd: 100 }]]),
      calendar,
      bookMode: 'demo',
    });
    expect(r.anchorBasis).toBe('first-post-onset-close');
    expect(r.leftAnchorDate).toBe('2026-08-04');
    // The anchor's own session is outside the telescoped window, on BOTH legs.
    expect(r.journalOptionsUsd).toBeCloseTo(100, 2);
    expect(r.uncreditedOptionsUsd).toBeCloseTo(0, 2);
  });
});

describe('TRA-3288 — the SURFACE gate: a live comparison needs broker-sourced anchors', () => {
  const isMarketDay = (d: string) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  };
  const calendar = { lastSettledSession: '2026-08-05', isMarketDay };
  const brow = (
    date: string, optionsDaily: number, closingEquity: number, closingEquityBasis: string | null,
    netCashFlowUsd?: number | null,
  ) => ({ date, optionsDaily, stockDaily: 0, closingEquity, closingEquityBasis, netCashFlowUsd });
  const journal = new Map([
    ['2026-08-04', { closes: 1, partialCloses: 0, realizedPnlUsd: 125 }],
  ]);

  it('THE v0nni CASE — a live book with FULL rows is still refused on demo anchors', () => {
    // This is the only test that proves the gate does anything: `absentSessions`
    // is `[]`, so the pre-existing hole gate would have OPENED and published the
    // entire journal numerator (125.00 + 0.00 − 0.00, the flat-25k demo seed
    // contributing a zero delta) as live money that never reached NAV, on the
    // first 21:00 ET archive after v0nni's first live close. A test where the
    // absence gate would also have fired proves nothing.
    const r = summarizePostOnsetLiveCredit({
      rows: [
        brow('2026-08-03', 0, 25_000, 'engine-paper-account'),
        brow('2026-08-04', 0, 25_000, 'engine-paper-account'),
        brow('2026-08-05', 0, 25_000, 'engine-paper-account'),
      ],
      liveOptionsOnsetDate: '2026-08-04',
      journalClosesByDate: journal,
      calendar,
      bookMode: 'live',
    });
    expect(r.absentSessions).toEqual([]);
    expect(r.journalOptionsUsd).toBeCloseTo(125, 2);
    expect(r.notMeasuredReason).toBe('equity-anchor-not-broker-sourced');
    expect(r.leftAnchorEquityBasis).toBe('engine-paper-account');
    expect(r.rightAnchorEquityBasis).toBe('engine-paper-account');
    expect(r.uncreditedOptionsUsd).toBeNull();
  });

  it('an ABSENT basis reads as NOT broker-sourced — absent is not broker', () => {
    // Every historical row has the field absent, including the demo-book live
    // rows this gate exists to disqualify. Treating a missing field as a pass
    // would open the gate on precisely the rows that motivated it.
    const r = summarizePostOnsetLiveCredit({
      rows: [
        brow('2026-08-03', 0, 25_000, null),
        brow('2026-08-04', 0, 25_000, null),
        brow('2026-08-05', 0, 25_000, null),
      ],
      liveOptionsOnsetDate: '2026-08-04',
      journalClosesByDate: journal,
      calendar,
      bookMode: 'live',
    });
    expect(r.absentSessions).toEqual([]);
    expect(r.notMeasuredReason).toBe('equity-anchor-not-broker-sourced');
    expect(r.uncreditedOptionsUsd).toBeNull();
  });

  it('ONE non-broker anchor is enough to refuse — the check is per-anchor, both ends', () => {
    // A broker right anchor against a demo left anchor still subtracts a demo
    // number from a broker number: the two-surface error, one operand at a time.
    const r = summarizePostOnsetLiveCredit({
      rows: [
        brow('2026-08-03', 0, 25_000, 'engine-paper-account'),
        brow('2026-08-04', 0, 25_050, 'broker-eod-balance'),
        brow('2026-08-05', 0, 25_110, 'broker-eod-balance'),
      ],
      liveOptionsOnsetDate: '2026-08-04',
      journalClosesByDate: journal,
      calendar,
      bookMode: 'live',
    });
    expect(r.notMeasuredReason).toBe('equity-anchor-not-broker-sourced');
    expect(r.leftAnchorEquityBasis).toBe('engine-paper-account');
    expect(r.rightAnchorEquityBasis).toBe('broker-eod-balance');
    expect(r.uncreditedOptionsUsd).toBeNull();
  });

  it('POSITIVE CONTROL — broker-sourced anchors on a live book DO produce a number', () => {
    // Without this the gate could be permanently closed for the wrong reason
    // (a typo in the basis compare, an inverted mode test) and every other test
    // here would still pass. The denominator is printed, not assumed: `every`
    // is TRUE on an empty cohort. Flows are MEASURED zeros (item 2): a live
    // publish requires the cash-flow leg, and 0-measured is not 0-assumed.
    const r = summarizePostOnsetLiveCredit({
      rows: [
        brow('2026-08-03', 0, 25_000, 'broker-eod-balance', 0),
        brow('2026-08-04', 0, 25_050, 'broker-eod-balance', 0),
        brow('2026-08-05', 0, 25_110, 'broker-eod-balance', 0),
      ],
      liveOptionsOnsetDate: '2026-08-04',
      journalClosesByDate: journal,
      calendar,
      bookMode: 'live',
    });
    // THE DENOMINATOR: two expected sessions, two rows, zero absences.
    expect(r.windowSessions).toBe(2);
    expect(r.windowRowDates).toEqual(['2026-08-04', '2026-08-05']);
    expect(r.absentSessions).toEqual([]);
    expect(r.notMeasuredReason).toBeNull();
    expect(r.windowNetCashFlowUsd).toBeCloseTo(0, 2);
    // 125.00 journal + 0.00 stock − (110.00 equity growth − 0.00 flow).
    expect(r.uncreditedOptionsUsd).toBeCloseTo(15, 2);
  });

  it('ITEM 2 — a deposit inside the window is netted out, not read as uncredited P&L', () => {
    // Broker equity grew 1110: 110 of trading and a 1000 deposit on 08-05. An
    // assumed-zero flow would publish 125 − 1110 = −985 (options massively
    // over-credited); the measured flow nets to the same +15 as above.
    const r = summarizePostOnsetLiveCredit({
      rows: [
        brow('2026-08-03', 0, 25_000, 'broker-eod-balance', 0),
        brow('2026-08-04', 0, 25_050, 'broker-eod-balance', 0),
        brow('2026-08-05', 0, 26_110, 'broker-eod-balance', 1_000),
      ],
      liveOptionsOnsetDate: '2026-08-04',
      journalClosesByDate: journal,
      calendar,
      bookMode: 'live',
    });
    expect(r.equityGrowthUsd).toBeCloseTo(1_110, 2);
    expect(r.windowNetCashFlowUsd).toBeCloseTo(1_000, 2);
    expect(r.uncreditedOptionsUsd).toBeCloseTo(15, 2);
  });

  it('ITEM 2 — ANY unmeasured window flow refuses the comparison; 0 is never assumed', () => {
    const r = summarizePostOnsetLiveCredit({
      rows: [
        brow('2026-08-03', 0, 25_000, 'broker-eod-balance', 0),
        // The TRA-359 cash fetch failed on this row's run: flow NOT MEASURED.
        brow('2026-08-04', 0, 25_050, 'broker-eod-balance', null),
        brow('2026-08-05', 0, 25_110, 'broker-eod-balance', 0),
      ],
      liveOptionsOnsetDate: '2026-08-04',
      journalClosesByDate: journal,
      calendar,
      bookMode: 'live',
    });
    expect(r.absentSessions).toEqual([]);
    expect(r.notMeasuredReason).toBe('cash-flow-not-measured');
    expect(r.uncreditedOptionsUsd).toBeNull();
    // The demo path never requires a flow: same rows, demo mode, publishes.
    const demo = summarizePostOnsetLiveCredit({
      rows: [
        brow('2026-08-03', 0, 25_000, null),
        brow('2026-08-04', 0, 25_050, null),
        brow('2026-08-05', 0, 25_110, null),
      ],
      liveOptionsOnsetDate: '2026-08-04',
      journalClosesByDate: journal,
      calendar,
      bookMode: 'demo',
    });
    expect(demo.notMeasuredReason).toBeNull();
    expect(demo.windowNetCashFlowUsd).toBeNull();
  });

  it('outranks `no-session-calendar` on a live book — the surface verdict is already known', () => {
    const r = summarizePostOnsetLiveCredit({
      rows: [
        brow('2026-08-03', 0, 25_000, 'engine-paper-account'),
        brow('2026-08-05', 0, 25_000, 'engine-paper-account'),
      ],
      liveOptionsOnsetDate: '2026-08-04',
      journalClosesByDate: journal,
      calendar: null,
      bookMode: 'live',
    });
    expect(r.notMeasuredReason).toBe('equity-anchor-not-broker-sourced');
    expect(r.uncreditedOptionsUsd).toBeNull();
  });

  it('a DEMO book is untouched: no broker basis required, hole-free window publishes', () => {
    const r = summarizePostOnsetLiveCredit({
      rows: [
        brow('2026-08-03', 0, 25_000, null),
        brow('2026-08-04', 0, 25_050, null),
        brow('2026-08-05', 0, 25_110, null),
      ],
      liveOptionsOnsetDate: '2026-08-04',
      journalClosesByDate: journal,
      calendar,
      bookMode: 'demo',
    });
    expect(r.notMeasuredReason).toBeNull();
    expect(r.uncreditedOptionsUsd).toBeCloseTo(15, 2);
  });

  it('ITEM 2 — drift and the frozen-counter axis go NOT MEASURED on broker-shaped rows', () => {
    // Both are ENGINE-book identities. A broker-shaped row books `dailyPnl: 0`
    // and carries the broker day P&L in `combinedPnl`, so grading
    // `eodCombined == stockDaily + optionsDaily` against it flags every live
    // session for agreeing with the broker; and the frozen-counter `move`
    // becomes a cross-surface difference the pool (journal money) would fund
    // nightly. NOT MEASURED, never a pass, and never an offender.
    const snaps = [
      { ...snap('2026-08-04', 0, -16), closingEquity: 2_207.5, closingEquityBasis: 'broker-eod-balance' },
      { ...snap('2026-08-05', 0, 0), closingEquity: 2_101.5, closingEquityBasis: 'broker-eod-balance' },
    ];
    // The report carries the broker override (−106 − (−16) = −90 of residual
    // the engine legs cannot decompose).
    const eod = new Map([['2026-08-05', -106]]);
    const r = reconcilePnl(
      snaps, eod, '2026-07-12', null, null, null, calendar, '2026-08-04', 'live',
    );
    const day = r.days.find(d => d.date === '2026-08-05')!;
    expect(day.drift).toBeNull();
    expect(r.offendingDates).toEqual([]);
    expect(r.ok).toBe(true);
    // The broker equity moved −106 while the paper counter recorded nothing —
    // on paper operands that is the frozen-counter signature; across surfaces
    // it is noise, so the accusation is fenced and the raw figure withheld.
    expect(day.unbookedEquityMoveUsd).toBeNull();
    expect(day.counterFrozen).toBeNull();
  });

  it('reconcilePnl wires the mode and the per-row basis through to the gate', () => {
    // The armed path end-to-end: recorded-style snapshots (basis stamped
    // `engine-paper-account` per TRA-3288's writer change), full window, live
    // mode — refused on the surface, with the bases readable off `days[]`.
    const snaps = [
      { ...snap('2026-08-03', 0, 0), closingEquity: 25_000, closingEquityBasis: 'engine-paper-account' },
      { ...snap('2026-08-04', 0, 0), closingEquity: 25_000, closingEquityBasis: 'engine-paper-account' },
      { ...snap('2026-08-05', 0, 0), closingEquity: 25_000, closingEquityBasis: 'engine-paper-account' },
    ];
    const r = reconcilePnl(
      snaps, new Map(), '2026-07-12', journal, null, null, calendar, '2026-08-04', 'live',
    );
    expect(r.days.map(d => d.closingEquityBasis)).toEqual([
      'engine-paper-account', 'engine-paper-account', 'engine-paper-account',
    ]);
    expect(r.postOnsetCredit.absentSessions).toEqual([]);
    expect(r.postOnsetCredit.journalOptionsUsd).toBeCloseTo(125, 2);
    expect(r.postOnsetCredit.notMeasuredReason).toBe('equity-anchor-not-broker-sourced');
    expect(r.postOnsetCredit.uncreditedOptionsUsd).toBeNull();
  });
});

describe('TRA-2919 — reconcilePnl wires the journal axis, and the fold splits the two cohorts', () => {
  const isMarketDay = (d: string) => {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  };
  const calendar = { lastSettledSession: '2026-08-05', isMarketDay };
  // Same tape as the block above, as SNAPSHOTS this time, so the wiring through
  // `reconcilePnl` is graded and not just the pure helper.
  const snaps = [
    { ...snap('2026-07-15', 0, 17), closingEquity: 1_500 },
    { ...snap('2026-07-29', -17.87, 250.01), closingEquity: 2_243.48 },
    { ...snap('2026-08-04', 0, -2), closingEquity: 2_603.49 },
  ];
  const census = new Map([
    ['2026-07-15', { closes: 1, partialCloses: 0, realizedPnlUsd: 17 }],
    ['2026-07-29', { closes: 6, partialCloses: 0, realizedPnlUsd: 250.01 }],
    ['2026-07-31', { closes: 3, partialCloses: 0, realizedPnlUsd: 739 }],
  ]);
  const run = () => reconcilePnl(
    snaps, new Map(), '2026-07-12', census, null, null, calendar, '2026-07-30',
  );

  it('publishes the journal axis on the reconciliation result', () => {
    const r = run();
    expect(r.postOnsetCredit.journalOptionsUsd).toBeCloseTo(739, 2);
    expect(r.postOnsetCredit.dayCellOptionsUsd).toBeCloseTo(-2, 2);
    expect(r.postOnsetCredit.notMeasuredReason).toBe('equity-anchor-spans-absent-session');
    expect(r.postOnsetCredit.uncreditedOptionsUsd).toBeNull();
  });

  it('AC4 — the TRA-2831 day-cell evidence is published UNCHANGED beside it', () => {
    // The suspension of the 733.60 rests on these three, so this fix must not
    // rescale, gate or delete any of them.
    const r = run();
    expect(r.postBaselineOptionsRealized).toBeCloseTo(248.01, 2);
    expect(r.optionsRealizedBeforeLiveOnsetUsd).toBeCloseTo(250.01, 2);
    expect(r.preLiveOnsetOptionsDates).toEqual(['2026-07-29']);
    const fold = summarizeLiveCreditObservation([{
      username: 'admin',
      mode: 'live',
      equityAbsorbedOptionsOk: null,
      counterDurable: true,
      counterFrozenDates: [],
      counterNonDurableDates: [],
      maxUnbookedEquityMoveUsd: 0,
      optionsCreditedMeasuredCount: 0,
      optionsCreditedLatest: 0,
      optionsCreditedDates: [],
      closingEquityLatest: r.closingEquityLatest,
      closingEquityLatestDate: r.closingEquityLatestDate,
      uncreditedOptionsUsd: r.uncreditedOptionsUsd,
      postBaselineEquityGrowth: r.postBaselineEquityGrowth,
      postBaselineOptionsRealized: r.postBaselineOptionsRealized,
      postBaselineStockDaily: r.postBaselineStockDaily,
      liveOptionsOnsetDate: r.liveOptionsOnsetDate,
      optionsRealizedBeforeLiveOnsetUsd: r.optionsRealizedBeforeLiveOnsetUsd,
      preLiveOnsetOptionsDates: r.preLiveOnsetOptionsDates,
      postOnsetCredit: r.postOnsetCredit,
      // TRA-3589 — threaded from the real engine summary rather than stubbed, so
      // if this fixture's series ever grows a broker row the fold sees it.
      uncreditedOptionsNotMeasuredReason: r.uncreditedOptionsNotMeasuredReason,
      postBaselineEquityGrowthSpansEquitySourceEras:
        r.postBaselineEquityGrowthSpansEquitySourceEras,
      equitySourceEraBoundary: r.equitySourceEraBoundary,
    }]);
    // Still suspended, still attributed — the day-cell axis is untouched.
    expect(fold.liveUncreditedOptionsUsd).toBeNull();
    expect(fold.liveUncreditedOptionsUsdUnscoped).not.toBeNull();
    expect(fold.liveModeSpanContaminatedBooks).toHaveLength(1);
    // AC1 — and the axis is GRADEABLE again: the numerator is journal-sourced.
    expect(fold.liveUncreditedOptionsGradeable).toBe(true);
    expect(fold.liveOnsetOptionsRealizedJournalUsd).toBeCloseTo(739, 2);
    expect(fold.liveOnsetOptionsDayCellUsd).toBeCloseTo(-2, 2);
    expect(fold.liveOnsetCreditNumeratorBookCount).toBe(1);
    // AC2 — and the comparison is NOT MEASURED, in the published silenced set.
    expect(fold.liveOnsetUncreditedOptionsUsd).toBeNull();
    expect(fold.liveOnsetCreditComparisonBookCount).toBe(0);
    expect(fold.liveOnsetCreditNotMeasuredBooks).toEqual([{
      username: 'admin',
      // `run()` passes no `bookMode`, so the surface gate is disarmed and the
      // absence reason is reachable — the TRA-3288 wiring arm below grades the
      // armed path.
      reason: 'equity-anchor-spans-absent-session',
      onsetDate: '2026-07-30',
      leftAnchorDate: '2026-07-29',
      rightAnchorDate: '2026-08-04',
      leftAnchorEquityBasis: null,
      rightAnchorEquityBasis: null,
      absentSessions: ['2026-07-30', '2026-07-31', '2026-08-03'],
      journalOptionsUsd: 739,
      dayCellOptionsUsd: -2,
    }]);
  });

  it('a caller that passes no census gets NOT MEASURED, never a zero numerator', () => {
    // Every pre-existing caller of `reconcilePnl` is in this shape.
    const r = reconcilePnl(snaps, new Map(), '2026-07-12');
    expect(r.postOnsetCredit.journalOptionsUsd).toBeNull();
    expect(r.postOnsetCredit.notMeasuredReason).toBe('no-live-options-onset');
  });

  it('the caveat naming the rejected day-cell numerator ships on the endpoint', () => {
    // AC3's durability requirement, on the wire and not only in a test name.
    expect(PNL_RECONCILIATION_CAVEATS).toContain(PNL_POST_ONSET_JOURNAL_CREDIT_NOTE);
    expect(PNL_POST_ONSET_JOURNAL_CREDIT_NOTE).toContain('-2.00');
    expect(PNL_POST_ONSET_JOURNAL_CREDIT_NOTE).toContain('+739.00');
    expect(PNL_POST_ONSET_JOURNAL_CREDIT_NOTE).toContain('equity-anchor-spans-absent-session');
  });
});

describe('TRA-2831 — liveOptionsOnsetEtDate', () => {
  const etDate = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const D = (iso: string) => Date.parse(`${iso}T15:00:00Z`);

  it('is the EARLIEST live-mode open, ignoring demo rows entirely', () => {
    expect(liveOptionsOnsetEtDate([
      { mode: 'demo', openTs: D('2026-07-15') },
      { mode: 'live', openTs: D('2026-07-31') },
      { mode: 'live', openTs: D('2026-07-30') },
      { mode: 'demo', openTs: D('2026-07-29') },
    ], etDate)).toBe('2026-07-30');
  });

  it('is null when the book has never opened a live option', () => {
    // Demo books, and live books that have not yet traded one. Both must read
    // "nothing here is provably live" rather than a date that credits the window.
    expect(liveOptionsOnsetEtDate([{ mode: 'demo', openTs: D('2026-07-15') }], etDate)).toBeNull();
    expect(liveOptionsOnsetEtDate([], etDate)).toBeNull();
  });

  it('keys on openTs, not closeTs', () => {
    // A live position OPENED on the 30th and closed on the 31st proves the book
    // was live on the 30th. Dating onset off the close would wrongly mark the
    // 30th pre-onset and discard a genuinely live session.
    expect(liveOptionsOnsetEtDate(
      [{ mode: 'live', openTs: D('2026-07-30'), closeTs: D('2026-07-31') }] as Array<
        { mode: string; openTs: number; closeTs: number }
      >,
      etDate,
    )).toBe('2026-07-30');
  });

  it('skips a live row with no usable openTs rather than dating onset to the epoch', () => {
    expect(liveOptionsOnsetEtDate([
      { mode: 'live' },
      { mode: 'live', openTs: Number.NaN },
      { mode: 'live', openTs: D('2026-07-30') },
    ], etDate)).toBe('2026-07-30');
    expect(liveOptionsOnsetEtDate([{ mode: 'live' }], etDate)).toBeNull();
  });
});

// TRA-2637 (QuantTrader) — AN ABSENT EOD ROW IS NOT A PASS.
//
// The live tape this locks: on 2026-07-30T02:17:30Z `admin` (the only mode:live
// book on bqb1) served 2026-07-29 as `eodCombined: null`, `eodOptionsPnl: null`,
// `journalOptionsPnl: 250.01` over 6 real closes — and `drift: 0`. Every gate
// that counts matches read that session GREEN, and `optionsFalseZero` was false
// too because the value was not a wrong zero, it was missing.
describe('TRA-2637 — absent EOD row is its own state, not a reconciled 0', () => {
  const closes = (date: string, n: number, pnl: number) =>
    new Map([[date, { closes: n, partialCloses: 0, realizedPnlUsd: pnl }]]);

  it('reproduces the live admin 2026-07-29 row: null drift, not 0', () => {
    const snaps = [snap('2026-07-29', -17.87, 250.01)];
    const r = reconcilePnl(
      snaps,
      new Map(), // no EOD report file for the session — the defect
      '2026-07-12',
      closes('2026-07-29', 6, 250.01),
      new Map(),
      new Map(),
    );
    expect(r.days[0].eodCombined).toBeNull();
    expect(r.days[0].drift).toBeNull();
    expect(r.days[0].eodRowMissing).toBe(true);
    // The pre-existing tripwires are all blind to it, which is why a new axis
    // was needed rather than a tweak to one of them.
    expect(r.days[0].optionsFalseZero).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.optionsFalseZeroOk).toBe(true);
    // ...and the new axis is what actually catches it.
    expect(r.eodRowsPresentOk).toBe(false);
    expect(r.eodRowMissingDates).toEqual(['2026-07-29']);
    expect(r.eodRowGradeableCount).toBe(1);
  });

  it('is GREEN when every active session wrote its row', () => {
    const snaps = [snap('2026-07-28', -0.94, 68), snap('2026-07-29', -17.87, 250.01)];
    const eod = new Map([['2026-07-28', 67.06], ['2026-07-29', 232.14]]);
    const r = reconcilePnl(snaps, eod, '2026-07-12');
    expect(r.eodRowsPresentOk).toBe(true);
    expect(r.eodRowMissingDates).toEqual([]);
    expect(r.eodRowGradeableCount).toBe(2);
  });

  it('is NOT MEASURED (null) — never green — when no evaluated session had activity', () => {
    const snaps = [snap('2026-07-29', 0, 0)];
    const r = reconcilePnl(snaps, new Map(), '2026-07-12');
    expect(r.eodRowGradeableCount).toBe(0);
    expect(r.eodRowsPresentOk).toBeNull();
    // The row is still absent-flagged; only the VERDICT abstains.
    expect(r.days[0].eodRowMissing).toBe(true);
    expect(r.days[0].drift).toBeNull();
  });

  it('does not accuse a genuinely quiet session that has no report file', () => {
    const snaps = [snap('2026-07-28', 0, 0), snap('2026-07-29', -17.87, 250.01)];
    const eod = new Map([['2026-07-29', 232.14]]);
    const r = reconcilePnl(snaps, eod, '2026-07-12');
    expect(r.eodRowMissingDates).toEqual([]);
    expect(r.eodRowsPresentOk).toBe(true);
    expect(r.eodRowGradeableCount).toBe(1);
  });

  it('grades off a non-zero P&L leg even when the journal census is unavailable', () => {
    // An unreadable journal must not silently empty the cohort — that is the
    // `every`-is-true-on-the-empty-set trap this module has shipped twice.
    const snaps = [snap('2026-07-29', -17.87, 250.01)];
    const r = reconcilePnl(snaps, new Map(), '2026-07-12', null);
    expect(r.days[0].journalCloses).toBeNull();
    expect(r.eodRowGradeableCount).toBe(1);
    expect(r.eodRowsPresentOk).toBe(false);
  });

  it('leaves `ok` / `maxDriftUsd` / `offendingDates` byte-identical', () => {
    const snaps = [snap('2026-07-28', 100, 30), snap('2026-07-29', -17.87, 250.01)];
    const eod = new Map([['2026-07-28', 175]]); // 07-28 drifts +45, 07-29 absent
    const r = reconcilePnl(snaps, eod, '2026-07-12');
    expect(r.ok).toBe(false);
    expect(r.offendingDates).toEqual(['2026-07-28']);
    expect(r.maxDriftUsd).toBeCloseTo(45, 2);
  });

  it('excludes a below-baseline absent row from the verdict', () => {
    const snaps = [snap('2026-05-18', 277.38, 0), snap('2026-07-29', -17.87, 250.01)];
    const eod = new Map([['2026-07-29', 232.14]]);
    const r = reconcilePnl(snaps, eod, '2026-07-12');
    expect(r.eodRowMissingDates).toEqual([]);
    expect(r.eodRowsPresentOk).toBe(true);
  });
});

describe('TRA-2637 — summarizeLiveEodRowPresence', () => {
  const book = (
    username: string,
    mode: string,
    eodRowsPresentOk: boolean | null,
    eodRowMissingDates: string[] = [],
    eodRowGradeableCount = 3,
  ) => ({ username, mode, eodRowsPresentOk, eodRowMissingDates, eodRowGradeableCount });

  it('is NOT MEASURED on an EMPTY live cohort — never a pass', () => {
    // bqb1 serves this state intermittently (TRA-2649 boot-arm miss), and it is
    // the same instability that split the write path in the first place.
    const r = summarizeLiveEodRowPresence([book('Richard', 'demo', false, ['2026-07-29'])]);
    expect(r.liveEodRowBookCount).toBe(0);
    expect(r.liveEodRowsPresentOk).toBeNull();
    expect(r.liveEodRowMissingBooks).toEqual([]);
  });

  it('goes RED on the live book and names the dates', () => {
    const r = summarizeLiveEodRowPresence([
      book('admin', 'live', false, ['2026-07-29'], 12),
      book('Richard', 'demo', true),
    ]);
    expect(r.liveEodRowsPresentOk).toBe(false);
    expect(r.liveEodRowMissingBooks).toEqual([
      { username: 'admin', dates: ['2026-07-29'], gradeableCount: 12 },
    ]);
  });

  it('a RED live book wins over a green one', () => {
    const r = summarizeLiveEodRowPresence([
      book('admin', 'live', true),
      book('operator2', 'live', false, ['2026-07-29']),
    ]);
    expect(r.liveEodRowsPresentOk).toBe(false);
  });

  it('claims green only off a genuinely measured live book', () => {
    const r = summarizeLiveEodRowPresence([
      book('admin', 'live', true),
      book('operator2', 'live', null, [], 0),
    ]);
    expect(r.liveEodRowsPresentOk).toBe(true);
  });

  it('all-NOT-MEASURED live books stay null', () => {
    const r = summarizeLiveEodRowPresence([book('admin', 'live', null, [], 0)]);
    expect(r.liveEodRowBookCount).toBe(1);
    expect(r.liveEodRowsPresentOk).toBeNull();
  });
});

describe('TRA-2761 — summarizeLiveCohortIntegrity', () => {
  const book = (
    username: string,
    mode: string,
    openLiveJournalRowCount: number | null,
    openLiveJournalAtRiskUsd: number | null = 0,
  ) => ({ username, mode, openLiveJournalRowCount, openLiveJournalAtRiskUsd });
  const opts = (
    unattributedOpenLiveRowCount = 0,
    unattributedOpenLiveAtRiskUsd = 0,
  ) => ({ journalCensusAvailable: true, unattributedOpenLiveRowCount, unattributedOpenLiveAtRiskUsd });

  it('goes RED when the cohort empties out from under open live rows — the TRA-2761 shape', () => {
    // 2026-08-02T00:47Z live: 61/61 books resolved demo while admin held 7 open
    // mode:'live' rows, $1,401.50 at risk. Every live* verdict read null; this
    // fold is the one that must carry the RED.
    const r = summarizeLiveCohortIntegrity(
      [book('admin', 'demo', 7, 1401.5), book('Richard', 'sandbox', 0)],
      opts(),
    );
    expect(r.liveCohortIntegrityOk).toBe(false);
    expect(r.liveCohortReclassifiedBooks).toEqual([
      { username: 'admin', mode: 'demo', openLiveJournalRowCount: 7, openLiveJournalAtRiskUsd: 1401.5 },
    ]);
    expect(r.liveOpenJournalRowCount).toBe(7);
    expect(r.liveOpenJournalAtRiskUsd).toBe(1401.5);
  });

  it('a sandbox reclassification is just as RED as a demo one', () => {
    const r = summarizeLiveCohortIntegrity([book('admin', 'sandbox', 3, 500)], opts());
    expect(r.liveCohortIntegrityOk).toBe(false);
  });

  it('is GREEN when every holder of open live rows is inside the live cohort', () => {
    const r = summarizeLiveCohortIntegrity(
      [book('admin', 'live', 12, 2455.5), book('Richard', 'sandbox', 0)],
      opts(),
    );
    expect(r.liveCohortIntegrityOk).toBe(true);
    expect(r.liveCohortReclassifiedBooks).toEqual([]);
    expect(r.liveOpenJournalRowCount).toBe(12);
  });

  it('no open live rows anywhere is null (nothing to protect) with a published 0, not a manufactured green', () => {
    const r = summarizeLiveCohortIntegrity(
      [book('admin', 'demo', 0), book('Richard', 'demo', 0)],
      opts(),
    );
    expect(r.liveCohortIntegrityOk).toBeNull();
    expect(r.liveOpenJournalRowCount).toBe(0);
    expect(r.liveOpenJournalAtRiskUsd).toBe(0);
  });

  it('an unavailable journal census is NOT MEASURED on every field — never a pass, never a zero', () => {
    const r = summarizeLiveCohortIntegrity(
      [book('admin', 'live', null, null)],
      { journalCensusAvailable: false, unattributedOpenLiveRowCount: 0, unattributedOpenLiveAtRiskUsd: 0 },
    );
    expect(r.liveCohortIntegrityOk).toBeNull();
    expect(r.liveOpenJournalRowCount).toBeNull();
    expect(r.liveOpenJournalAtRiskUsd).toBeNull();
    expect(r.liveCohortReclassifiedBooks).toBeNull();
  });

  it('orphaned open live rows no book claims are RED even with a healthy cohort', () => {
    // Identity retirement moves the account epoch out from under the rows; a
    // pre-TRA-1475 row carries no account at all. Either way the notional is
    // outside every live-axis gate.
    const r = summarizeLiveCohortIntegrity(
      [book('admin', 'live', 2, 400)],
      opts(3, 750),
    );
    expect(r.liveCohortIntegrityOk).toBe(false);
    expect(r.liveOpenJournalUnattributedRowCount).toBe(3);
    expect(r.liveOpenJournalRowCount).toBe(5);
    expect(r.liveOpenJournalAtRiskUsd).toBe(1150);
  });

  it('closed live rows do not trip anything — only OPEN notional is protected', () => {
    // The caller only feeds OPEN rows into the per-book counts; a book whose
    // live rows all closed contributes 0 and the verdict stays null.
    const r = summarizeLiveCohortIntegrity([book('admin', 'demo', 0)], opts());
    expect(r.liveCohortIntegrityOk).toBeNull();
  });
});

// TRA-2630 AC1 — the documented close is only closed if the documentation is
// reachable from where the disclaimed field is read. `caveats` shipped inside
// `reconcilePnl`'s result, i.e. at `engines[i].caveats`; `ok` / `maxDriftUsd` are
// top-level. This helper is what puts the disclaimer beside the fields.
describe('TRA-2630 AC1 — summarizeDriftGradeability', () => {
  it('names every ungradeable field, including the per-row one they fold from', () => {
    const r = summarizeDriftGradeability();
    // `drift` is the per-row operand; omitting it would leave a consumer free to
    // grade `engines[i].days[j].drift` directly, which is the ORIGINAL defect.
    // TRA-2943 added `eodInteriorAbsentOk` — retained for existing consumers but
    // PINNED FALSE by an adjudicated absence, so a gate keying on this list now
    // fails closed on it too. `liveEodInteriorAbsentOk` is deliberately NOT here.
    // TRA-3948 added the last two, and they are SCOPED strings rather than bare
    // field names on purpose: both fields still grade the DEMO cohort correctly
    // (`stockDaily` there is a real equity delta), and are structurally 0 only on
    // broker-shaped LIVE rows where the writer pins `dailyPnl: 0`. Listing them
    // unscoped would retire a working demo signal to fix a live one. The bare
    // names are asserted absent below for exactly that reason.
    expect(r.ungradeableFields).toEqual([
      'ok',
      'maxDriftUsd',
      'engines[].drift',
      'eodInteriorAbsentOk',
      'maxStockLegDriftUsd (live cohort only — structurally 0)',
      'engines[].stockLegDrift (broker-shaped rows only — structurally 0)',
    ]);
    expect(r.ungradeableFields).not.toContain('liveEodInteriorAbsentOk');
    expect(r.ungradeableFields).not.toContain('maxStockLegDriftUsd');
    expect(r.ungradeableFields).not.toContain('engines[].stockLegDrift');
  });

  it('emits the disclaimer machine-readably, not only as prose', () => {
    // A checker cannot assert an English sentence in a string array. This is the
    // half of the close that a gate can actually fail closed on.
    expect(summarizeDriftGradeability().driftGradeable).toBe(false);
  });

  it('carries the decomposition and absent-row notes so the hoist loses nothing', () => {
    const r = summarizeDriftGradeability();
    expect(r.caveats).toContain(PNL_DRIFT_DECOMPOSITION_NOTE);
    expect(r.caveats).toContain(PNL_ABSENT_EOD_ROW_NOTE);
    expect(r.caveats).toEqual(PNL_RECONCILIATION_CAVEATS);
  });

  it('hands out a COPY of the field list — a caller cannot mutate the constant', () => {
    // The route spreads this into a JSON response once per request; a consumer
    // (or a test) pushing onto the returned array must not poison the next call.
    summarizeDriftGradeability().ungradeableFields.push('injected');
    expect(summarizeDriftGradeability().ungradeableFields).not.toContain('injected');
  });
});

/**
 * TRA-2817 — THE TAIL AXIS.
 *
 * TRA-2637 gave the INTERIOR a failing state: an absent `eodCombined` inside the
 * measured range is no longer scored `drift: 0`. It could not give the TAIL one,
 * and the reason is structural. The presence check walks the dates already in
 * `days[]`, and `days[]` is built from the persisted snapshots — so a session
 * with no snapshot is never walked and can never be counted missing. When the
 * writer stops entirely the axis goes GREEN, and the more completely it has
 * stopped the greener it looks.
 *
 * Live proof this is not hypothetical: on 2026-08-04 all 47 books with a ledger
 * carried `closingEquityLatestDate: "2026-07-29"` — three completed, overdue
 * sessions unwritten fleet-wide, because `/data` had been returning `ENOSPC` on
 * every write since 2026-07-30T23:40:19Z — while `liveEodRowsPresentOk` served
 * `true` and `liveEodRowMissingBooks` served `[]`.
 */
describe('TRA-2817 EOD tail staleness', () => {
  // Weekday calendar: 2026-07-27 Mon .. 2026-07-31 Fri, 2026-08-03 Mon.
  const isMarketDay = (iso: string): boolean => {
    const [y, m, d] = iso.split('-').map(Number);
    const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    return dow !== 0 && dow !== 6;
  };
  const cal = (lastSettledSession: string | null) => ({ lastSettledSession, isMarketDay });

  describe('countStaleTailSessions', () => {
    it('counts SESSIONS, not elapsed days: 2026-07-29 -> 2026-08-03 is 3', () => {
      // 07-30 Thu, 07-31 Fri, 08-03 Mon. Five calendar days, three sessions.
      // 08-03 is a MONDAY, not a weekend (the TRA-2764 correction).
      expect(countStaleTailSessions('2026-07-29', '2026-08-03', isMarketDay)).toBe(3);
    });

    it('is 0 when the newest row IS the last settled session', () => {
      expect(countStaleTailSessions('2026-08-03', '2026-08-03', isMarketDay)).toBe(0);
    });

    it('is 0 across a weekend: a Friday row read on a Sunday is current', () => {
      expect(countStaleTailSessions('2026-07-31', '2026-07-31', isMarketDay)).toBe(0);
    });

    it('is 0, not negative, when the row is AHEAD of the settled session', () => {
      // The normal weekday-afternoon read: today's row exists (a backfill, an
      // intraday write) but today's 21:00 ET archive has not settled yet.
      expect(countStaleTailSessions('2026-08-04', '2026-08-03', isMarketDay)).toBe(0);
    });

    it('is null, NOT 0, when either endpoint is absent', () => {
      // A book with no rows has no anchor. Inventing 0 for it would hand the
      // EMPTIEST ledger the cleanest reading on the endpoint.
      expect(countStaleTailSessions(null, '2026-08-03', isMarketDay)).toBeNull();
      expect(countStaleTailSessions('2026-07-29', null, isMarketDay)).toBeNull();
    });
  });

  describe('reconcilePnl tail verdict', () => {
    // The live shape: a book that reconciled cleanly through 07-29, then stopped.
    const snaps = [snap('2026-07-28', 100, 0), snap('2026-07-29', 50, 0)];
    const eod = new Map([['2026-07-28', 100], ['2026-07-29', 50]]);

    it('reports eodRowsPresentOk FALSE on a dead tail whose interior is spotless', () => {
      const r = reconcilePnl(snaps, eod, '2026-07-12', null, null, null, cal('2026-08-03'));
      expect(r.eodTailStaleSessions).toBe(3);
      expect(r.eodTailLatestRowDate).toBe('2026-07-29');
      expect(r.eodTailSettledSession).toBe('2026-08-03');
      // The interior really is clean — that is the whole point. Before this
      // ticket those two lines were the entire verdict and it read `true`.
      expect(r.eodRowMissingDates).toEqual([]);
      expect(r.eodRowsPresentOk).toBe(false);
    });

    it('stays green when the tail is current', () => {
      const r = reconcilePnl(snaps, eod, '2026-07-12', null, null, null, cal('2026-07-29'));
      expect(r.eodTailStaleSessions).toBe(0);
      expect(r.eodRowsPresentOk).toBe(true);
    });

    it('a stale tail outranks an interior that is NOT MEASURED', () => {
      // A quiet book: no activity, so the interior cohort is empty and the
      // interior verdict is `null`. `null` reads as "nothing to check" when the
      // truth here is "nothing was written" — the tail must still win.
      const quiet = [snap('2026-07-29', 0, 0)];
      const r = reconcilePnl(quiet, new Map(), '2026-07-12', null, null, null, cal('2026-08-03'));
      expect(r.eodRowGradeableCount).toBe(0);
      expect(r.eodRowsPresentOk).toBe(false);
    });

    it('reports NOT MEASURED, never a fabricated 0, when no calendar is supplied', () => {
      const r = reconcilePnl(snaps, eod, '2026-07-12');
      expect(r.eodTailStaleSessions).toBeNull();
      expect(r.eodTailSettledSession).toBeNull();
      // The pre-TRA-2817 verdict is preserved exactly for a caller that has not
      // wired the calendar: this must not become a silent fleet-wide red.
      expect(r.eodRowsPresentOk).toBe(true);
    });

    it('anchors on the newest row INCLUDING below-baseline ones', () => {
      // The baseline is a data-integrity cutoff for grading drift, not evidence
      // the writer was dead. Anchoring on `evaluated` would score a book whose
      // whole history predates the baseline as maximally stale while its writer
      // is working perfectly.
      const r = reconcilePnl(snaps, eod, '2027-01-01', null, null, null, cal('2026-07-29'));
      expect(r.eodTailLatestRowDate).toBe('2026-07-29');
      expect(r.eodTailStaleSessions).toBe(0);
    });
  });

  describe('summarizeLiveEodRowPresence tail list', () => {
    const book = (over: Record<string, unknown> = {}) => ({
      username: 'admin',
      mode: 'live',
      eodRowsPresentOk: false as boolean | null,
      eodRowMissingDates: [] as string[],
      eodRowGradeableCount: 12,
      eodTailStaleSessions: 3 as number | null,
      eodTailLatestRowDate: '2026-07-29' as string | null,
      ...over,
    });

    it('enumerates a tail gap that contributes NO missing dates', () => {
      // This is the reading the live endpoint served for five days:
      // `liveEodRowMissingBooks: []`. Empty is now a legitimate answer meaning
      // "the tail, not the interior" — and it needs its own list, or the gap is
      // only reachable by re-deriving `days[]` by hand.
      const s = summarizeLiveEodRowPresence([book()]);
      expect(s.liveEodRowMissingBooks).toEqual([]);
      expect(s.liveEodRowsPresentOk).toBe(false);
      expect(s.liveEodTailStaleBooks).toEqual([
        { username: 'admin', latestRowDate: '2026-07-29', staleSessions: 3 },
      ]);
      expect(s.liveEodTailMaxStaleSessions).toBe(3);
    });

    it('reports max stale as null, not 0, on a wholly unmeasured cohort', () => {
      const s = summarizeLiveEodRowPresence([
        book({ eodTailStaleSessions: null, eodRowsPresentOk: true }),
      ]);
      expect(s.liveEodTailStaleBooks).toEqual([]);
      expect(s.liveEodTailMaxStaleSessions).toBeNull();
    });

    it('ignores non-live books: the tail list is live-scoped like the rest', () => {
      const s = summarizeLiveEodRowPresence([book({ mode: 'demo' })]);
      expect(s.liveEodRowBookCount).toBe(0);
      expect(s.liveEodTailStaleBooks).toEqual([]);
      expect(s.liveEodTailMaxStaleSessions).toBeNull();
    });
  });
});

/**
 * TRA-2835 — the T+1 credit-lag detector pairs `days[i]` with `days[i-1]`, which
 * is ARRAY-adjacent, not CALENDAR-adjacent. A gap in `days[]` did not suppress
 * eligibility, so the first row landing after the permanent TRA-2888 hole
 * (2026-07-30 / 07-31 / 08-03, fleet-wide) was graded against 2026-07-29 as if
 * it were T+1.
 *
 * The hazard is a FALSE PASS, which is the dangerous direction: a clean reading
 * across a three-session hole is not evidence the writer was fixed, it is the
 * tripwire's trigger condition never having been met and being scored anyway.
 */
describe('TRA-2835 — lag eligibility requires CALENDAR adjacency, not array adjacency', () => {
  // 2026-07-29 Wed .. 2026-08-05 Wed. Weekends only; 07-30/07-31/08-03 are real
  // sessions the exchange held and the ledger missed — that is the whole point.
  const isMarketDay = (iso: string): boolean => {
    const [y, m, d] = iso.split('-').map(Number);
    const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    return dow !== 0 && dow !== 6;
  };
  const cal = (lastSettledSession: string) => ({ lastSettledSession, isMarketDay });

  it('suppresses the 2026-08-04 row: its predecessor row is 07-29, three sessions back', () => {
    // The exact live shape. `admin` on bqb1 at 2026-08-05T09:12Z:
    //   07-29 optionsDaily 250.01  ->  08-04 optionsDaily -2.00
    // with 07-30 / 07-31 / 08-03 absent from days[] entirely.
    const r = reconcilePnl(
      [snap('2026-07-28', 0, 68), snap('2026-07-29', 0, 250.01), snap('2026-08-04', 0, -2)],
      new Map(), '2026-07-12', null, null, null, cal('2026-08-04'),
    );

    const byDate = new Map(r.days.map(d => [d.date, d]));
    expect(byDate.get('2026-07-29')!.priorSessionAdjacent).toBe(true);
    expect(byDate.get('2026-08-04')!.priorSessionAdjacent).toBe(false);

    // 08-04 is NOT gradeable. Pre-fix it was, because prev.optionsDaily = 250.01
    // is non-zero and nothing checked the distance.
    expect(r.priorOptionsLagEligibleDates).toEqual(['2026-07-29']);
    expect(r.priorOptionsLagEligibleDates).not.toContain('2026-08-04');
    // ...and the drop is PUBLISHED, not silent.
    expect(r.priorOptionsLagGapSuppressedDates).toEqual(['2026-08-04']);
  });

  it('does not let a lag FIRE across the gap either', () => {
    // stockDaily on 08-04 exactly equals 07-29's optionsDaily. Pre-fix this is a
    // red flag; it is not one, because the two sessions are not T and T+1.
    const r = reconcilePnl(
      [snap('2026-07-29', 0, 250.01), snap('2026-08-04', 250.01, 0)],
      new Map(), '2026-07-12', null, null, null, cal('2026-08-04'),
    );
    expect(r.days.map(d => d.lagsPriorOptionsDaily)).toEqual([false, false]);
    expect(r.priorOptionsLagDates).toEqual([]);
  });

  it('still pairs across a WEEKEND — Monday against Friday is genuinely T+1', () => {
    // The pre-existing behaviour that must NOT regress: 07-31 Fri -> 08-03 Mon
    // is three calendar days but ONE session apart.
    const r = reconcilePnl(
      [snap('2026-07-31', 0, 140), snap('2026-08-03', 0, 0)],
      new Map(), '2026-07-12', null, null, null, cal('2026-08-03'),
    );
    const byDate = new Map(r.days.map(d => [d.date, d]));
    expect(byDate.get('2026-08-03')!.priorSessionAdjacent).toBe(true);
    expect(r.priorOptionsLagEligibleDates).toEqual(['2026-08-03']);
    expect(r.priorOptionsLagGapSuppressedDates).toEqual([]);
  });

  it('reads NOT MEASURED and changes nothing when no calendar is supplied', () => {
    // Fail-open is wrong here and fail-closed is also wrong: without a calendar
    // we cannot prove a gap, so behaviour is unchanged and the field says so.
    const r = reconcilePnl(
      [snap('2026-07-29', 0, 250.01), snap('2026-08-04', 0, -2)],
      new Map(), '2026-07-12',
    );
    expect(r.days.map(d => d.priorSessionAdjacent)).toEqual([null, null]);
    expect(r.priorOptionsLagEligibleDates).toEqual(['2026-08-04']);
    expect(r.priorOptionsLagGapSuppressedDates).toEqual([]);
  });

  it('the whole-book verdict goes NOT MEASURED rather than green when the gap is the only cohort', () => {
    // The false PASS in its purest form: 08-04 was the ONLY eligible session, so
    // pre-fix the book reported priorOptionsLagOk = true over one observation
    // that could never have failed. It must now read null.
    const r = reconcilePnl(
      [snap('2026-07-29', 0, 250.01), snap('2026-08-04', 0, -2)],
      new Map(), '2026-07-12', null, null, null, cal('2026-08-04'),
    );
    expect(r.priorOptionsLagEligibleDates).toEqual([]);
    expect(r.priorOptionsLagOk).toBeNull();
  });
});

// TRA-3043 — the anchor and its provenance must SURVIVE the row builder.
//
// `reconcilePnl` maps each `DailySnapshot` into a `PnlReconcileDay` field by
// field, and that shape is what `/api/health/pnl-reconciliation` serialises. A
// field added to the snapshot but not to the mapper is written to disk by the
// 21:00 ET writer and then silently dropped on the way out of the endpoint —
// which is exactly how `openingEquity` came to be a durable recorded field that
// no reader could see, forcing the inference these tests exist to retire.
describe('TRA-3043 — openingEquity / openingEquityBasis reach the payload', () => {
  const row = (date: string, over: Partial<DailySnapshot>): DailySnapshot => ({
    date,
    openingEquity: 25_000,
    closingEquity: 25_100,
    dailyPnl: 100,
    optionsPnl: 0,
    optionsDailyPnl: 0,
    combinedPnl: 100,
    trades: 1,
    ...over,
  });

  it('publishes the recorded anchor and the writer declaration verbatim', () => {
    const res = reconcilePnl(
      [row('2026-08-06', { openingEquityBasis: 'verified-prior-session-close' })],
      new Map(),
      '2026-01-01',
    );
    const d = res.days.find(x => x.date === '2026-08-06')!;
    expect(d.openingEquity).toBe(25_000);
    expect(d.openingEquityBasis).toBe('verified-prior-session-close');
  });

  it('the telescoping invariant is now a comparison of two PUBLISHED fields', () => {
    // `openingEquity(N) === closingEquity(N-1)` is the direct read of whether a
    // session advanced its anchor across the prior close — the thing the
    // TRA-3039 day-roll defect breaks. Until this ticket it could only be
    // reached by inverting `stockDaily` off three other fields.
    const res = reconcilePnl(
      [
        row('2026-08-05', { openingEquity: 24_900, closingEquity: 25_000 }),
        // The defect's signature: the anchor did NOT advance to 25,000.
        row('2026-08-06', { openingEquity: 24_900, closingEquity: 25_100 }),
      ],
      new Map(),
      '2026-01-01',
    );
    const [prev, cur] = res.days;
    expect(cur!.openingEquity).not.toBe(prev!.closingEquity);
    expect(cur!.openingEquity).toBe(24_900);
  });

  it('an unmeasured anchor publishes NULL, never a flat-broke zero', () => {
    // TRA-2829: a back-filled row whose broker equity anchor could not be
    // measured carries `openingEquity: null`. `?? 0` here would publish a book
    // that opened the day at nothing and manufacture a book-sized daily P&L for
    // anyone differencing it.
    const res = reconcilePnl(
      [row('2026-08-06', { openingEquity: null, closingEquity: null })],
      new Map(),
      '2026-01-01',
    );
    expect(res.days[0]!.openingEquity).toBeNull();
  });

  it('a row written before this ticket publishes NULL, not a default declaration', () => {
    // The two NOT-MEASURED cases (a pre-TRA-3043 build, and a back-fill row the
    // live process declined to speak for) must both arrive as `null`. Defaulting
    // to `prior-session-close` would make every legacy row assert the exact
    // clean bill of health the field exists to withhold.
    const res = reconcilePnl([row('2026-08-06', {})], new Map(), '2026-01-01');
    expect(res.days[0]!.openingEquityBasis).toBeNull();
    // An empty string is a writer bug, not a declaration — same treatment.
    const blank = reconcilePnl(
      [row('2026-08-06', { openingEquityBasis: '' })],
      new Map(),
      '2026-01-01',
    );
    expect(blank.days[0]!.openingEquityBasis).toBeNull();
  });
});

describe('TRA-3517 — the row/report `combinedPnl` agreement gets a READER', () => {
  const BASELINE = '2026-07-12';
  const OVERRIDE = new Map([['2026-08-05', 'tradier-balance']]);

  /**
   * A TRA-3349 broker-shaped recorded row, as `shapeLiveRecordedRow` writes it:
   * stock leg booked `0` with a falsifiable probe beside it, broker equity
   * basis, and `combinedPnl` carrying the override's broker day P&L.
   *
   * `combinedPnl` is passed SEPARATELY from the legs on purpose — that is the
   * whole point of the axis. On a broker row the legs do not sum to it, so a
   * fixture that derived one from the other could not express a disagreement.
   */
  const brokerRow = (
    date: string,
    combinedPnl: number,
    over: Partial<DailySnapshot> = {},
  ): DailySnapshot => ({
    ...snap(date, 0, 0),
    closingEquity: 2_101.5,
    closingEquityBasis: 'broker-eod-balance',
    openingEquity: 2_207.5,
    openingEquityBasis: 'broker-prev-eod-balance',
    netCashFlowUsd: 0,
    stockLegBasis: 'zero-probe-agrees',
    stockLegProbeUsd: 0,
    combinedPnl,
    ...over,
  });

  // ── ITEM 1: the two stock-leg fields reach the surface ────────────────────

  it('projects `stockLegBasis` / `stockLegProbeUsd` onto the row', () => {
    // Before this ticket both strings occurred ZERO times in the full
    // /api/health/pnl-reconciliation payload, on every probed opt-in variant.
    // The booked `0` stock leg was unfalsifiable from the published surface.
    const r = reconcilePnl(
      [brokerRow('2026-08-05', -106, {
        stockLegBasis: 'zero-probe-disagrees',
        stockLegProbeUsd: -42.5,
      })],
      new Map(), BASELINE,
    );
    expect(r.days[0]!.stockLegBasis).toBe('zero-probe-disagrees');
    expect(r.days[0]!.stockLegProbeUsd).toBeCloseTo(-42.5, 2);
  });

  it('an unmeasured probe is `null`, NOT the `0` that means "the leg was inert"', () => {
    // `round2(null)` is 0, and 0 is the PASSING value of this field. An absent
    // probe rendering as a pass is the exact collapse the field exists to stop.
    const r = reconcilePnl(
      [brokerRow('2026-08-05', -106, {
        stockLegBasis: 'zero-probe-not-measured',
        stockLegProbeUsd: null,
      })],
      new Map(), BASELINE,
    );
    expect(r.days[0]!.stockLegProbeUsd).toBeNull();
    expect(r.days[0]!.stockLegBasis).toBe('zero-probe-not-measured');
  });

  it('an ordinary recorded row carries neither field and reads null on both', () => {
    const r = reconcilePnl([snap('2026-08-05', 100, 30)], new Map(), BASELINE);
    expect(r.days[0]!.stockLegBasis).toBeNull();
    expect(r.days[0]!.stockLegProbeUsd).toBeNull();
  });

  // ── ITEM 2: the agreement axis, and its three states ──────────────────────

  it('POSITIVE — row and report agree on the override figure: `agree`', () => {
    const r = reconcilePnl(
      [brokerRow('2026-08-05', -106)],
      new Map([['2026-08-05', -106]]),
      BASELINE, null, null, null, null, null, 'live', OVERRIDE,
    );
    const day = r.days[0]!;
    expect(day.rowCombinedPnl).toBeCloseTo(-106, 2);
    expect(day.eodCombined).toBeCloseTo(-106, 2);
    expect(day.combinedAgreement).toBe('agree');
    expect(day.combinedAgreementDeltaUsd).toBeCloseTo(0, 2);
    expect(day.combinedAgreementReason).toBeNull();
    // `drift` is still suppressed — this axis is its REPLACEMENT, not its peer.
    expect(day.drift).toBeNull();
    expect(day.combinedPnlHasNoReader).toBe(false);
    expect(r.combinedAgreementOk).toBe(true);
    expect(r.combinedAgreementGradeableCount).toBe(1);
    expect(r.combinedPnlNoReaderDates).toEqual([]);
  });

  it('NEGATIVE — a row whose `combinedPnl` differs from the override reads `disagree`', () => {
    // THE FALSIFICATION TEST the ask names. Without it the axis is unfalsifiable:
    // agreement holds by construction on the same tick today, so a green proves
    // nothing unless a red is demonstrably reachable. The report carries the
    // override -106; the stored row carries -90.
    const r = reconcilePnl(
      [brokerRow('2026-08-05', -90)],
      new Map([['2026-08-05', -106]]),
      BASELINE, null, null, null, null, null, 'live', OVERRIDE,
    );
    const day = r.days[0]!;
    expect(day.combinedAgreement).toBe('disagree');
    expect(day.combinedAgreementDeltaUsd).toBeCloseTo(16, 2);
    expect(day.combinedAgreementReason).toBeNull();
    expect(day.combinedPnlHasNoReader).toBe(false);
    expect(r.combinedAgreementOk).toBe(false);
    expect(r.combinedAgreementDisagreeDates).toEqual(['2026-08-05']);
    expect(r.combinedAgreementMaxDeltaUsd).toBeCloseTo(16, 2);
  });

  it('a sub-penny difference is rounding, not a disagreement', () => {
    const r = reconcilePnl(
      [brokerRow('2026-08-05', -106.004)],
      new Map([['2026-08-05', -106.01]]),
      BASELINE, null, null, null, null, null, 'live', OVERRIDE,
    );
    expect(r.days[0]!.combinedAgreement).toBe('agree');
    expect(r.combinedAgreementOk).toBe(true);
  });

  it('NOT MEASURED when the override did not compute — and it does NOT read `agree`', () => {
    // The report fell back to the ENGINE figure (`pnlSource: 'engine'`), and it
    // happens to EQUAL the row. A pass here would be the vacuous true this
    // ticket exists to prevent: on a broker row `drift` is null, so a green
    // sourced from a comparison that measured nothing is the same reading as a
    // real pass on the one cohort with no second reader.
    const r = reconcilePnl(
      [brokerRow('2026-08-05', -106)],
      new Map([['2026-08-05', -106]]),
      BASELINE, null, null, null, null, null, 'live',
      new Map([['2026-08-05', 'engine']]),
    );
    const day = r.days[0]!;
    expect(day.combinedAgreement).toBe('not-measured');
    expect(day.combinedAgreementReason).toBe('override-not-computed');
    // The delta stays NULL. `0` here is byte-identical to a perfect agreement.
    expect(day.combinedAgreementDeltaUsd).toBeNull();
    expect(r.combinedAgreementOk).toBeNull();
    expect(r.combinedAgreementOk).not.toBe(true);
    expect(r.combinedAgreementGradeableCount).toBe(0);
    expect(r.combinedAgreementMaxDeltaUsd).toBeNull();
  });

  it('an ABSENT `pnlSource` is NOT-OVERRIDDEN, never a default source', () => {
    // 46 of the 69 stored live rows carry no `pnlSource` at all (TRA-3102). If
    // absence defaulted to the override this axis would grade all of them
    // against an engine figure and manufacture a fleet of disagreements — or,
    // worse, of agreements.
    const r = reconcilePnl(
      [brokerRow('2026-08-05', -106)],
      new Map([['2026-08-05', -106]]),
      BASELINE, null, null, null, null, null, 'live', new Map(),
    );
    expect(r.days[0]!.combinedAgreementReason).toBe('override-not-computed');
    expect(r.combinedAgreementOk).toBeNull();
  });

  it('a caller that wires no `pnlSource` map at all grades NOTHING', () => {
    // Omission must fail toward NOT MEASURED. The parameter is optional so
    // existing callers keep compiling, and the default cannot be one that
    // manufactures a green.
    const r = reconcilePnl(
      [brokerRow('2026-08-05', -106)],
      new Map([['2026-08-05', -106]]),
      BASELINE, null, null, null, null, null, 'live',
    );
    expect(r.days[0]!.combinedAgreement).toBe('not-measured');
    expect(r.combinedAgreementOk).toBeNull();
  });

  it('NOT MEASURED with `no-report-row` when the report file is absent', () => {
    const r = reconcilePnl(
      [brokerRow('2026-08-05', -106)],
      new Map(), BASELINE, null, null, null, null, null, 'live', OVERRIDE,
    );
    expect(r.days[0]!.combinedAgreementReason).toBe('no-report-row');
    expect(r.combinedAgreementOk).toBeNull();
  });

  it('an ENGINE-shaped row ABSTAINS — `drift` is its reader, and it still grades', () => {
    // The axis must not double-accuse. On a non-broker row `drift` is live, so
    // this reason is an abstention rather than a coverage hole — which is why
    // `combinedPnlHasNoReader` stays false here.
    const r = reconcilePnl(
      [snap('2026-08-05', 100, 30)],
      new Map([['2026-08-05', 175]]),
      BASELINE, null, null, null, null, null, 'live', OVERRIDE,
    );
    const day = r.days[0]!;
    expect(day.combinedAgreementReason).toBe('row-not-broker-shaped');
    expect(day.combinedAgreement).toBe('not-measured');
    expect(day.combinedPnlHasNoReader).toBe(false);
    expect(day.drift).toBeCloseTo(45, 2);
    expect(r.combinedPnlNoReaderDates).toEqual([]);
  });

  // ── The coverage hole itself is published ─────────────────────────────────

  it('names the sessions BOTH readers abstain on — `combinedPnlHasNoReader`', () => {
    // 08-04: broker-shaped, override computed -> graded.
    // 08-05: broker-shaped, override did NOT compute -> drift null AND agreement
    //        not-measured. Real money, observed by nothing. That state was
    //        previously indistinguishable from a clean session at a glance.
    const r = reconcilePnl(
      [brokerRow('2026-08-04', -16), brokerRow('2026-08-05', -106)],
      new Map([['2026-08-04', -16], ['2026-08-05', -106]]),
      BASELINE, null, null, null, null, null, 'live',
      new Map([['2026-08-04', 'tradier-balance'], ['2026-08-05', 'engine']]),
    );
    expect(r.days.map(d => d.combinedPnlHasNoReader)).toEqual([false, true]);
    expect(r.combinedPnlNoReaderDates).toEqual(['2026-08-05']);
    // One graded session is still a graded session — the verdict is a real
    // `true`, and the hole travels beside it rather than inside it.
    expect(r.combinedAgreementOk).toBe(true);
    expect(r.combinedAgreementGradeableCount).toBe(1);
    expect(r.combinedAgreementNotMeasuredCounts).toEqual({ 'override-not-computed': 1 });
  });

  it('attributes an empty denominator by reason instead of leaving it merely empty', () => {
    const r = reconcilePnl(
      [
        snap('2026-08-03', 10, 0),
        brokerRow('2026-08-04', -16, { combinedPnl: Number.NaN }),
        brokerRow('2026-08-05', -106),
      ],
      new Map([['2026-08-03', 10]]),
      BASELINE, null, null, null, null, null, 'live', OVERRIDE,
    );
    expect(r.combinedAgreementOk).toBeNull();
    expect(r.combinedAgreementNotMeasuredCounts).toEqual({
      'row-not-broker-shaped': 1,
      'row-combined-absent': 1,
      'no-report-row': 1,
    });
    expect(r.days[1]!.rowCombinedPnl).toBeNull();
  });

  it('publishes the same-tick caveat so a green is not over-read', () => {
    expect(PNL_RECONCILIATION_CAVEATS).toContain(PNL_COMBINED_AGREEMENT_NOTE);
    expect(PNL_COMBINED_AGREEMENT_NOTE).toContain('NOT independent corroboration');
    expect(PNL_COMBINED_AGREEMENT_NOTE).toContain('MUST NEVER be folded into');
  });
});

describe('TRA-3517 — summarizeLiveCombinedAgreement', () => {
  const book = (
    username: string,
    mode: string,
    ok: boolean | null,
    graded: number,
    disagree: string[] = [],
    maxDelta: number | null = null,
    noReader: string[] = [],
    discriminating: number = graded,
  ) => ({
    username,
    mode,
    combinedAgreementOk: ok,
    combinedAgreementGradeableCount: graded,
    combinedAgreementDiscriminatingCount: discriminating,
    combinedAgreementDisagreeDates: disagree,
    combinedAgreementMaxDeltaUsd: maxDelta,
    combinedPnlNoReaderDates: noReader,
  });

  it('one live disagreement outranks every green', () => {
    const r = summarizeLiveCombinedAgreement([
      book('admin', 'live', false, 3, ['2026-08-05'], 16),
      book('v0nni', 'live', true, 4, [], 0),
    ]);
    expect(r.liveCombinedAgreementOk).toBe(false);
    expect(r.liveCombinedAgreementDisagreeBooks).toEqual([
      { username: 'admin', dates: ['2026-08-05'], maxDeltaUsd: 16 },
    ]);
    expect(r.liveCombinedAgreementMaxDeltaUsd).toBe(16);
    expect(r.liveCombinedAgreementGradedCount).toBe(7);
  });

  it('a green needs a REAL reading — all-NOT-MEASURED stays null, never true', () => {
    const r = summarizeLiveCombinedAgreement([
      book('admin', 'live', null, 0, [], null, ['2026-08-04', '2026-08-05']),
      book('v0nni', 'live', null, 0),
    ]);
    expect(r.liveCombinedAgreementOk).toBeNull();
    expect(r.liveCombinedAgreementGradedCount).toBe(0);
    expect(r.liveCombinedAgreementBookCount).toBe(2);
    // The discriminator a bare `null` cannot carry: this is a coverage HOLE on
    // two real-money sessions, not an empty live cohort.
    expect(r.liveCombinedPnlNoReaderBooks).toEqual([
      { username: 'admin', dates: ['2026-08-04', '2026-08-05'] },
    ]);
    expect(r.liveCombinedAgreementMaxDeltaUsd).toBeNull();
  });

  it('an EMPTY live cohort is null with a zero denominator, not a pass', () => {
    // `every` is true on the empty set; `some` is the construction that is not.
    const r = summarizeLiveCombinedAgreement([book('demo1', 'demo', null, 0)]);
    expect(r.liveCombinedAgreementOk).toBeNull();
    expect(r.liveCombinedAgreementBookCount).toBe(0);
    expect(r.liveCombinedPnlNoReaderBooks).toEqual([]);
  });

  it('a demo book cannot move the live verdict in either direction', () => {
    const r = summarizeLiveCombinedAgreement([
      book('admin', 'live', true, 2, [], 0),
      book('demo1', 'demo', false, 5, ['2026-08-05'], 99),
    ]);
    expect(r.liveCombinedAgreementOk).toBe(true);
    expect(r.liveCombinedAgreementBookCount).toBe(1);
    expect(r.liveCombinedAgreementGradedCount).toBe(2);
    expect(r.liveCombinedAgreementDisagreeBooks).toEqual([]);
  });
});

describe('TRA-3517 — a 0.00-vs-0.00 agreement is a MEASUREMENT, not evidence', () => {
  const BASELINE = '2026-07-12';
  const brokerRow = (
    date: string,
    combinedPnl: number,
  ): DailySnapshot => ({
    ...snap(date, 0, 0),
    closingEquity: 2_101.5,
    closingEquityBasis: 'broker-eod-balance',
    openingEquity: 2_207.5,
    openingEquityBasis: 'broker-prev-eod-balance',
    netCashFlowUsd: 0,
    stockLegBasis: 'zero-probe-agrees',
    stockLegProbeUsd: 0,
    combinedPnl,
  });

  it('THE LIVE CASE — `v0nni` 2026-08-12: agrees at zero, discriminates nothing, verdict null', () => {
    // First live read of this axis, 2026-08-13T08:39Z on build 3877000. Both
    // sides 0.00. A writer that never threaded the override into the row books
    // the `dailyPnl + optionsDailyPnl` identity, which on a quiet session is
    // ALSO 0.00 — so this session emits `agree` no matter how broken the wiring
    // is. It has no failing state and must not fund a verdict. The ticket's own
    // hand analysis pre-registered this: "DEGENERATE -- it discriminates
    // nothing. Do not count it."
    const r = reconcilePnl(
      [brokerRow('2026-08-12', 0)],
      new Map([['2026-08-12', 0]]),
      BASELINE, null, null, null, null, null, 'live',
      new Map([['2026-08-12', 'tradier-balance']]),
    );
    const day = r.days[0]!;
    // The agreement is REAL and stays published — hiding it would lose a
    // measurement. What it does not do is count.
    expect(day.combinedAgreement).toBe('agree');
    expect(day.combinedAgreementDeltaUsd).toBeCloseTo(0, 2);
    expect(day.combinedAgreementDiscriminating).toBe(false);
    expect(r.combinedAgreementGradeableCount).toBe(1);
    expect(r.combinedAgreementDiscriminatingCount).toBe(0);
    // The whole point: a green here would be vacuous, so there is no green.
    expect(r.combinedAgreementOk).toBeNull();
    expect(r.combinedAgreementOk).not.toBe(true);
  });

  it('THE LIVE CASE — `admin` 2026-08-12 at -0.10 IS sharp and does count', () => {
    // -0.10 = 1143.96 - 1144.06, the override shape (equity delta net of a 0
    // flow). Any other value on either side refutes the agreement, so this
    // session is genuine evidence.
    const r = reconcilePnl(
      [brokerRow('2026-08-12', -0.1)],
      new Map([['2026-08-12', -0.1]]),
      BASELINE, null, null, null, null, null, 'live',
      new Map([['2026-08-12', 'tradier-balance']]),
    );
    expect(r.days[0]!.combinedAgreementDiscriminating).toBe(true);
    expect(r.combinedAgreementDiscriminatingCount).toBe(1);
    expect(r.combinedAgreementOk).toBe(true);
  });

  it('the two denominators diverge, and BOTH are published', () => {
    // Exactly the live shape across one book: one sharp session, one degenerate.
    const r = reconcilePnl(
      [brokerRow('2026-08-11', 0), brokerRow('2026-08-12', -0.1)],
      new Map([['2026-08-11', 0], ['2026-08-12', -0.1]]),
      BASELINE, null, null, null, null, null, 'live',
      new Map([['2026-08-11', 'tradier-balance'], ['2026-08-12', 'tradier-balance']]),
    );
    expect(r.combinedAgreementGradeableCount).toBe(2);
    expect(r.combinedAgreementDiscriminatingCount).toBe(1);
    expect(r.combinedAgreementOk).toBe(true);
    expect(r.days.map(d => d.combinedAgreementDiscriminating)).toEqual([false, true]);
  });

  it('a DISAGREEMENT is discriminating by construction and cannot be narrowed away', () => {
    // The ordering guard: the two sides differ, so they cannot both be 0.00.
    // A red must survive the discriminating gate no matter where it lands.
    const r = reconcilePnl(
      [brokerRow('2026-08-11', 0), brokerRow('2026-08-12', -90)],
      new Map([['2026-08-11', 0], ['2026-08-12', -106]]),
      BASELINE, null, null, null, null, null, 'live',
      new Map([['2026-08-11', 'tradier-balance'], ['2026-08-12', 'tradier-balance']]),
    );
    expect(r.combinedAgreementOk).toBe(false);
    expect(r.combinedAgreementDisagreeDates).toEqual(['2026-08-12']);
    expect(r.days[1]!.combinedAgreementDiscriminating).toBe(true);
  });

  it('a book of ONLY degenerate sessions reads null, never a green', () => {
    const r = reconcilePnl(
      [brokerRow('2026-08-11', 0), brokerRow('2026-08-12', 0)],
      new Map([['2026-08-11', 0], ['2026-08-12', 0]]),
      BASELINE, null, null, null, null, null, 'live',
      new Map([['2026-08-11', 'tradier-balance'], ['2026-08-12', 'tradier-balance']]),
    );
    expect(r.combinedAgreementGradeableCount).toBe(2);
    expect(r.combinedAgreementDiscriminatingCount).toBe(0);
    expect(r.combinedAgreementOk).toBeNull();
  });

  it('the fleet fold quotes the DISCRIMINATING denominator, and it can be 0 under a green-looking graded count', () => {
    const r = summarizeLiveCombinedAgreement([
      {
        username: 'admin',
        mode: 'live',
        combinedAgreementOk: true,
        combinedAgreementGradeableCount: 1,
        combinedAgreementDiscriminatingCount: 1,
        combinedAgreementDisagreeDates: [],
        combinedAgreementMaxDeltaUsd: 0,
        combinedPnlNoReaderDates: [],
      },
      {
        username: 'v0nni',
        mode: 'live',
        combinedAgreementOk: null,
        combinedAgreementGradeableCount: 1,
        combinedAgreementDiscriminatingCount: 0,
        combinedAgreementDisagreeDates: [],
        combinedAgreementMaxDeltaUsd: 0,
        combinedPnlNoReaderDates: [],
      },
    ]);
    // graded 2, discriminating 1 — the live 2026-08-13 reading. Publishing only
    // the first doubles the apparent coverage of one real session.
    expect(r.liveCombinedAgreementGradedCount).toBe(2);
    expect(r.liveCombinedAgreementDiscriminatingCount).toBe(1);
    expect(r.liveCombinedAgreementOk).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3864 AC1 — the day cell vs the JOURNAL, subtracted.
//
// `optionsDaily` is PERSISTED at the 21:00 ET archive. `journalOptionsPnl` is
// RECOMPUTED per request from the append-only journal. The TRA-2819 close-basis
// restatement (applied in bulk by the TRA-3730 sweep) moves the journal row
// AFTERWARDS, so the two diverge — and both numbers rode the same published
// object with nothing subtracting them.
//
// Live on bqb1 build `bc92e57109c1`, 2026-08-19T21:2xZ: 985 day cells, 853
// journal-authoritative, 3 divergent — TWO on the live money book.
//
//   admin/live 2026-08-18   optionsDaily -393.00   journal -271.23   delta -121.77
//   admin/live 2026-08-11   optionsDaily  -16.00   journal  -16.86   delta   +0.86
//
// The 08-18 delta is the `SPY260821C00777000` restatement -278.00 -> -156.23 to
// the cent. Every fixture below is those live numbers, not a synthetic shape.
//
// ⚠️ `optionsLegDrift` reads 0.00 on all three and is CORRECT to — TRA-2641's
// `syncEodReportOptionsLegs` writes the day cell INTO the report file's options
// leg on exactly this cohort, so that axis has no failing state here. The last
// test in this block pins that, so a future reader cannot mistake the two.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-3864 AC1 — a superseded day cell is published, not left unread', () => {
  const journalSnap = (
    date: string,
    optionsDailyPnl: number,
    source: string | null = 'journal',
  ): DailySnapshot => ({
    ...snap(date, 0, optionsDailyPnl),
    optionsDailyPnlSource: source,
  } as DailySnapshot);
  const census = (rows: Array<[string, number, number]>) =>
    new Map(rows.map(([d, closes, pnl]) =>
      [d, { closes, partialCloses: 0, realizedPnlUsd: pnl }]));

  it('flags BOTH live cells, with the delta to the cent', () => {
    const r = reconcilePnl(
      [journalSnap('2026-08-11', -16), journalSnap('2026-08-18', -393)],
      new Map(),
      null,
      census([['2026-08-11', 1, -16.86], ['2026-08-18', 2, -271.23]]),
    );

    expect(r.journalSupersededDates).toEqual(['2026-08-11', '2026-08-18']);
    expect(r.journalAgreementOk).toBe(false);
    expect(r.journalAgreementGradeableCount).toBe(2);
    expect(r.maxJournalSupersessionUsd).toBe(121.77);
    expect(r.days[0]).toMatchObject({
      journalOptionsPnlDeltaUsd: 0.86,
      optionsDailySupersededByJournal: true,
    });
    expect(r.days[1]).toMatchObject({
      journalOptionsPnlDeltaUsd: -121.77,
      optionsDailySupersededByJournal: true,
    });
    // Untouched: this is not a claim about the drift identity.
    expect(r.optionsFalseZeroOk).toBe(true);
  });

  it('MUTATION: the SAME cell carrying the restated figure is clean, not silent', () => {
    // Only `optionsDaily` moves vs the case above. A green here has to be a real
    // pass — the gradeable count is what proves something was looked at.
    const r = reconcilePnl(
      [journalSnap('2026-08-18', -271.23)],
      new Map(),
      null,
      census([['2026-08-18', 2, -271.23]]),
    );
    expect(r.journalSupersededDates).toEqual([]);
    expect(r.journalAgreementOk).toBe(true);
    expect(r.journalAgreementGradeableCount).toBe(1);
    expect(r.maxJournalSupersessionUsd).toBe(0);
    expect(r.days[0].journalOptionsPnlDeltaUsd).toBe(0);
    expect(r.days[0].optionsDailySupersededByJournal).toBe(false);
  });

  it('catches a ONE-CENT divergence — the tolerance is half a cent, not one cent', () => {
    // Both operands are round2-ed, so 0.01 is the smallest disagreement this axis
    // can express. Reusing `PNL_RECONCILE_TOLERANCE_USD` (1c, strict >) would
    // leave the boundary with no failing state and silence exactly the one-cent
    // restatement deltas the TRA-3730 cohort is made of.
    const r = reconcilePnl(
      [journalSnap('2026-08-06', -16.85)],
      new Map(),
      null,
      census([['2026-08-06', 1, -16.86]]),
    );
    expect(r.days[0].journalOptionsPnlDeltaUsd).toBe(0.01);
    expect(r.journalSupersededDates).toEqual(['2026-08-06']);
    expect(r.journalAgreementOk).toBe(false);
  });

  it('grades `journal-repair` too, and ABSTAINS on a bucket-sourced cell', () => {
    // `isJournalAuthoritativeSource` is the ONE shared predicate. A `bucket-*`
    // row is one the report file is the better record for — a difference there is
    // not an accusation, so it must read NOT MEASURED rather than clean or red.
    const r = reconcilePnl(
      [
        journalSnap('2026-08-11', -16, 'journal-repair'),
        journalSnap('2026-08-12', -16, 'bucket-journal-silent'),
        journalSnap('2026-08-13', -16, null),
      ],
      new Map(),
      null,
      census([['2026-08-11', 1, -16.86], ['2026-08-12', 1, -16.86], ['2026-08-13', 1, -16.86]]),
    );
    expect(r.journalSupersededDates).toEqual(['2026-08-11']);
    expect(r.journalAgreementGradeableCount).toBe(1);
    expect(r.days[1].journalOptionsPnlDeltaUsd).toBeNull();
    expect(r.days[1].optionsDailySupersededByJournal).toBe(false);
    expect(r.days[2].journalOptionsPnlDeltaUsd).toBeNull();
  });

  it('NOT MEASURED, never 0, when no census was supplied', () => {
    // The default call shape. A `0` delta here is byte-identical to perfect
    // agreement — the collapse TRA-2637 fixed on `drift` and TRA-3517 on
    // `combinedAgreementDeltaUsd`.
    const r = reconcilePnl([journalSnap('2026-08-18', -393)], new Map());
    expect(r.days[0].journalOptionsPnlDeltaUsd).toBeNull();
    expect(r.days[0].optionsDailySupersededByJournal).toBe(false);
    expect(r.journalAgreementGradeableCount).toBe(0);
    expect(r.journalAgreementOk).toBeNull();
    expect(r.maxJournalSupersessionUsd).toBeNull();
  });

  it('is NOT baseline-gated — a superseded cell below the baseline still counts', () => {
    // The TRA-1636 baseline keeps PRE-FIX rows out of the drift verdict. It has
    // nothing to say here: the gate is the provenance stamp, which post-dates
    // TRA-2314, so a row old enough for the baseline to matter is already outside
    // the cohort. Gating on it would shrink the denominator by an unrelated rule
    // and stop the published set matching the hand-run repro.
    const r = reconcilePnl(
      [journalSnap('2026-07-28', 48.5)],
      new Map(),
      '2026-08-01',
      census([['2026-07-28', 4, 111.5]]),
    );
    expect(r.belowBaselineCount).toBe(1);
    expect(r.journalSupersededDates).toEqual(['2026-07-28']);
    expect(r.days[0].journalOptionsPnlDeltaUsd).toBe(-63);
  });

  it('the SLAVED leg reads 0.00 on the very same row — this axis is the independent one', () => {
    // TRA-2630/TRA-2641: `syncEodReportOptionsLegs` writes the day cell into the
    // report file's options leg on every journal-authoritative row, so
    // `eodOptionsPnl - optionsDaily` compares a source against a copy of itself.
    // QA swept for that ruling before filing; this pins WHY the old reader was
    // blind, so nobody re-raises the finding as an `optionsLegDrift` bug.
    const r = reconcilePnl(
      [journalSnap('2026-08-18', -393)],
      new Map(),
      null,
      census([['2026-08-18', 2, -271.23]]),
      new Map([['2026-08-18', -393]]), // the file leg, slaved to the cell
    );
    expect(r.days[0].optionsLegDrift).toBe(0);
    expect(r.days[0].journalOptionsPnlDeltaUsd).toBe(-121.77);
    expect(r.journalAgreementOk).toBe(false);
  });
});

describe('TRA-3864 — the fleet fold names the LIVE books', () => {
  const book = (
    username: string,
    mode: string,
    dates: string[],
    gradeable: number,
    maxDelta: number | null,
  ) => ({
    username,
    mode,
    journalAgreementOk: dates.length > 0 ? false : gradeable > 0 ? true : null,
    journalSupersededDates: dates,
    journalAgreementGradeableCount: gradeable,
    maxJournalSupersessionUsd: maxDelta,
  });

  it('reproduces the filed fleet measurement: 853 gradeable, 3 divergent, 2 live', () => {
    const s = summarizeJournalDayCellAgreement([
      book('admin', 'live', ['2026-08-11', '2026-08-18'], 67, 121.77),
      book('qa_mirror_1578_38096', 'demo', ['2026-07-28'], 40, 63),
      book('v0nni', 'live', [], 20, 0),
      book('quiet', 'demo', [], 726, 0),
    ]);
    expect(s.journalDayCellAgreementOk).toBe(false);
    expect(s.journalDayCellGradeableCount).toBe(853);
    expect(s.journalDayCellSupersededCount).toBe(3);
    expect(s.liveJournalDayCellAgreementOk).toBe(false);
    // The question a desk asks first: which of these is REAL MONEY.
    expect(s.liveJournalDayCellSupersededBooks).toEqual([
      { username: 'admin', dates: ['2026-08-11', '2026-08-18'] },
    ]);
    expect(s.liveJournalDayCellGradeableBookCount).toBe(2);
  });

  it('a demo-only divergence goes RED fleet-wide and stays GREEN on the live cohort', () => {
    const s = summarizeJournalDayCellAgreement([
      book('qa_mirror_1578_38096', 'demo', ['2026-07-28'], 40, 63),
      book('admin', 'live', [], 67, 0),
    ]);
    expect(s.journalDayCellAgreementOk).toBe(false);
    expect(s.liveJournalDayCellAgreementOk).toBe(true);
    expect(s.liveJournalDayCellSupersededBooks).toEqual([]);
  });

  it('an EMPTY live cohort reads NOT MEASURED, never OK', () => {
    // `every` is true on the empty set — the manufactured green this endpoint has
    // already shipped twice (TRA-2924 on `optionsLegOk`, TRA-2630 AC2 on the lag
    // tripwire). bqb1 serves an empty live cohort on a boot-arm miss.
    const s = summarizeJournalDayCellAgreement([book('someone', 'demo', [], 12, 0)]);
    expect(s.liveJournalDayCellAgreementOk).toBeNull();
    expect(s.liveJournalDayCellGradeableBookCount).toBe(0);
    expect(s.journalDayCellAgreementOk).toBe(true);
  });

  it('a fleet where nobody was gradeable reads NOT MEASURED, not a pass', () => {
    const s = summarizeJournalDayCellAgreement([
      book('a', 'live', [], 0, null),
      book('b', 'demo', [], 0, null),
    ]);
    expect(s.journalDayCellAgreementOk).toBeNull();
    expect(s.journalDayCellGradeableCount).toBe(0);
    expect(s.journalDayCellGradeableBookCount).toBe(0);
  });

  it('RED wins over NOT MEASURED — an ungradeable book cannot mask a superseded one', () => {
    const s = summarizeJournalDayCellAgreement([
      book('a', 'live', ['2026-08-18'], 5, 121.77),
      book('b', 'live', [], 0, null),
    ]);
    expect(s.liveJournalDayCellAgreementOk).toBe(false);
    expect(s.journalDayCellAgreementOk).toBe(false);
  });
});
describe('TRA-3867 — the gateable verdict subtracts the RULED set, and only that set', () => {
  // Same shape as the TRA-3864 helper above, re-declared so this block reads
  // standalone and a later edit to that one cannot silently move these.
  const book = (
    username: string,
    mode: string,
    dates: string[],
    gradeable: number,
    maxDelta: number | null,
  ) => ({
    username,
    mode,
    journalAgreementOk: dates.length > 0 ? false : gradeable > 0 ? true : null,
    journalSupersededDates: dates,
    journalAgreementGradeableCount: gradeable,
    maxJournalSupersessionUsd: maxDelta,
  });

  /** The 2026-08-19T22:5xZ live bqb1 fleet, to the cell. */
  const LIVE_FLEET = () => [
    book('admin', 'live', ['2026-08-11', '2026-08-18'], 67, 121.77),
    book('qa_mirror_1578_38096', 'demo', ['2026-07-28'], 40, 63),
    book('v0nni', 'live', [], 20, 0),
    book('quiet', 'demo', [], 726, 0),
  ];

  it('the live fleet as it stands: raw identity RED, gateable verdict GREEN', () => {
    const s = summarizeJournalDayCellAgreement(LIVE_FLEET());
    // The raw identity is unmoved and STILL RED — the 3 are not hidden.
    expect(s.journalDayCellAgreementOk).toBe(false);
    expect(s.liveJournalDayCellAgreementOk).toBe(false);
    expect(s.journalDayCellSupersededCount).toBe(3);
    expect(s.journalDayCellSupersededBooks).toEqual([
      { username: 'admin', mode: 'live', dates: ['2026-08-11', '2026-08-18'], maxDeltaUsd: 121.77 },
      { username: 'qa_mirror_1578_38096', mode: 'demo', dates: ['2026-07-28'], maxDeltaUsd: 63 },
    ]);
    // ...and the gateable one is reachable-green, because all 3 are ruled.
    expect(s.journalDayCellNoNewSupersessionOk).toBe(true);
    expect(s.liveJournalDayCellNoNewSupersessionOk).toBe(true);
    expect(s.journalDayCellUnacknowledgedCount).toBe(0);
    expect(s.journalDayCellUnacknowledgedBooks).toEqual([]);
    expect(s.liveJournalDayCellUnacknowledgedBooks).toEqual([]);
    expect(s.journalDayCellStaleAcknowledgements).toEqual([]);
  });

  // ── THE WHOLE POINT OF THE TICKET ────────────────────────────────────────
  // A 4th cell arriving must be distinguishable FROM THE FIELD A GATE BINDS TO.
  // Before this change both states rendered `journalDayCellAgreementOk: false`.
  it('a 4th, UNRULED divergence flips the gateable verdict while the raw one cannot move', () => {
    const before = summarizeJournalDayCellAgreement(LIVE_FLEET());
    const after = summarizeJournalDayCellAgreement([
      book('admin', 'live', ['2026-08-11', '2026-08-18', '2026-08-19'], 68, 121.77),
      book('qa_mirror_1578_38096', 'demo', ['2026-07-28'], 40, 63),
      book('v0nni', 'live', [], 20, 0),
      book('quiet', 'demo', [], 726, 0),
    ]);
    // The old field is INDISTINGUISHABLE across the two states. That is the bug.
    expect(before.journalDayCellAgreementOk).toBe(after.journalDayCellAgreementOk);
    expect(before.liveJournalDayCellAgreementOk).toBe(after.liveJournalDayCellAgreementOk);
    // The new one is not.
    expect(before.journalDayCellNoNewSupersessionOk).toBe(true);
    expect(after.journalDayCellNoNewSupersessionOk).toBe(false);
    expect(after.liveJournalDayCellNoNewSupersessionOk).toBe(false);
    expect(after.journalDayCellUnacknowledgedCount).toBe(1);
    expect(after.journalDayCellUnacknowledgedBooks).toEqual([
      { username: 'admin', mode: 'live', dates: ['2026-08-19'] },
    ]);
    expect(after.liveJournalDayCellUnacknowledgedBooks).toEqual([
      { username: 'admin', dates: ['2026-08-19'] },
    ]);
    // ...and the 3 ruled cells STILL publish. The exemption suppresses a
    // verdict, never a row: the count must read 4, not 1.
    expect(after.journalDayCellSupersededCount).toBe(4);
  });

  it('a 4th on a DEMO book goes red fleet-wide and leaves the live verdict green', () => {
    const s = summarizeJournalDayCellAgreement([
      book('admin', 'live', ['2026-08-11', '2026-08-18'], 67, 121.77),
      book('some_demo', 'demo', ['2026-08-19'], 12, 5),
    ]);
    expect(s.journalDayCellNoNewSupersessionOk).toBe(false);
    expect(s.liveJournalDayCellNoNewSupersessionOk).toBe(true);
    expect(s.liveJournalDayCellUnacknowledgedBooks).toEqual([]);
  });

  // The acknowledgement is keyed on username|mode|date, all three. A ruled cell
  // is a ruled CELL, not a ruled book and not a ruled date.
  it('the exemption does not leak across book, mode, or date', () => {
    const notTheSameBook = summarizeJournalDayCellAgreement([
      book('someone_else', 'live', ['2026-08-18'], 5, 121.77),
    ]);
    expect(notTheSameBook.journalDayCellNoNewSupersessionOk).toBe(false);

    const notTheSameMode = summarizeJournalDayCellAgreement([
      book('admin', 'demo', ['2026-08-18'], 5, 121.77),
    ]);
    expect(notTheSameMode.journalDayCellNoNewSupersessionOk).toBe(false);

    const notTheSameDate = summarizeJournalDayCellAgreement([
      book('admin', 'live', ['2026-08-12'], 5, 121.77),
    ]);
    expect(notTheSameDate.journalDayCellNoNewSupersessionOk).toBe(false);
  });

  it('NOT MEASURED, never a pass: an empty/ungradeable fleet is null on BOTH verdicts', () => {
    // `[].some(...)` is false, so a naive spelling would call this GREEN — the
    // manufactured pass this module has shipped twice (TRA-2924, TRA-2630 AC2).
    const s = summarizeJournalDayCellAgreement([book('a', 'live', [], 0, null)]);
    expect(s.journalDayCellNoNewSupersessionOk).toBeNull();
    expect(s.liveJournalDayCellNoNewSupersessionOk).toBeNull();
    expect(summarizeJournalDayCellAgreement([]).journalDayCellNoNewSupersessionOk).toBeNull();
    expect(summarizeJournalDayCellAgreement([]).liveJournalDayCellNoNewSupersessionOk).toBeNull();
  });

  it('an unruled cell wins over an ungradeable book — red beats NOT MEASURED', () => {
    const s = summarizeJournalDayCellAgreement([
      book('nobody', 'live', ['2026-08-19'], 5, 9),
      book('b', 'live', [], 0, null),
    ]);
    expect(s.liveJournalDayCellNoNewSupersessionOk).toBe(false);
    expect(s.journalDayCellNoNewSupersessionOk).toBe(false);
  });

  it('the exemption is PUBLISHED on the wire, so it can be audited without reading source', () => {
    const s = summarizeJournalDayCellAgreement(LIVE_FLEET());
    expect(s.journalDayCellAcknowledgedCount).toBe(3);
    expect(s.journalDayCellAcknowledgedCells).toEqual([
      { username: 'admin', mode: 'live', date: '2026-08-11', ticket: 'TRA-3864' },
      { username: 'admin', mode: 'live', date: '2026-08-18', ticket: 'TRA-3864' },
      { username: 'qa_mirror_1578_38096', mode: 'demo', date: '2026-07-28', ticket: 'TRA-3864' },
    ]);
    // Every entry cites the ruling that froze it. An uncited exemption is a
    // ban-list row (TRA-3831) wearing the name of this axis.
    for (const a of ACKNOWLEDGED_JOURNAL_DAY_CELL_SUPERSESSIONS) {
      expect(a.ticket).toMatch(/^TRA-\d+$/);
      expect(a.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.note.length).toBeGreaterThan(0);
    }
  });

  it('a stale acknowledgement is PUBLISHED, not dropped — it pre-exempts that cell', () => {
    // The QA mirror leaves the fleet. Its acknowledgement stays in the pinned
    // list and would silently exempt a future re-divergence on that same cell.
    const s = summarizeJournalDayCellAgreement([
      book('admin', 'live', ['2026-08-11', '2026-08-18'], 67, 121.77),
    ]);
    expect(s.journalDayCellStaleAcknowledgements).toEqual([
      { username: 'qa_mirror_1578_38096', mode: 'demo', date: '2026-07-28', ticket: 'TRA-3864' },
    ]);
    // ...but a stale entry is not an incident on its own, so it must not page.
    expect(s.journalDayCellNoNewSupersessionOk).toBe(true);
  });

  it('an EMPTY acknowledged set degenerates to the raw identity — no vacuous green', () => {
    // The control in the other direction: if the set were ever emptied, the new
    // verdict must go red on the live fleet, not stay green.
    const s = summarizeJournalDayCellAgreement(LIVE_FLEET(), []);
    expect(s.journalDayCellNoNewSupersessionOk).toBe(false);
    expect(s.journalDayCellNoNewSupersessionOk).toBe(s.journalDayCellAgreementOk);
    expect(s.journalDayCellUnacknowledgedCount).toBe(3);
    expect(s.journalDayCellAcknowledgedCount).toBe(0);
  });
});

describe('TRA-4337 — resolveLiveAnchorState repoints a LIVE anchor at the broker basis', () => {
  const frozen = {
    // The measured v0nni defect verbatim: the frozen pre-TRA-3349 paper equity,
    // republished every fire with the day-roll label.
    openingDate: '2026-09-03',
    openingEquity: 25_000,
    openingEquityBasis: 'day-roll-state-equity',
  };
  const row = (date: string, closingEquity: number | null) => ({ date, closingEquity });

  it('a live book pairs with its newest archived close STRICTLY before openingDate', () => {
    const out = resolveLiveAnchorState(frozen, 'live', [
      row('2026-08-29', 395.30),
      row('2026-09-02', 383.38),
      // Same-date row must NOT pair: openingDate's own close is today's, not prior.
      row('2026-09-03', 999.99),
    ]);
    expect(out.openingEquity).toBe(383.38);
    expect(out.openingEquityBasis).toBe(ANCHOR_BASIS_LIVE_PRIOR_ARCHIVED_CLOSE);
    expect(out.openingEquityPairedCloseDate).toBe('2026-09-02');
    expect(out.openingDate).toBe('2026-09-03');
  });

  it('an unsorted snapshot list still pairs the NEWEST prior close', () => {
    const out = resolveLiveAnchorState(frozen, 'live', [
      row('2026-09-02', 383.38),
      row('2026-08-28', 401.12),
    ]);
    expect(out.openingEquity).toBe(383.38);
    expect(out.openingEquityPairedCloseDate).toBe('2026-09-02');
  });

  it('a NULL close (NOT MEASURED, TRA-2829) is skipped, never zeroed', () => {
    const out = resolveLiveAnchorState(frozen, 'live', [
      row('2026-08-29', 395.30),
      row('2026-09-02', null),
    ]);
    expect(out.openingEquity).toBe(395.30);
    expect(out.openingEquityPairedCloseDate).toBe('2026-08-29');
  });

  it('with NO measurable prior close the tracker declaration passes through unchanged', () => {
    // Honest absent: never a fabricated number, and the stale label survives so
    // the tripwire can keep annotating the condition.
    const out = resolveLiveAnchorState(frozen, 'live', [row('2026-09-02', null)]);
    expect(out).toBe(frozen);
    expect(out.openingEquityBasis).toBe('day-roll-state-equity');
  });

  it('demo and sandbox anchors are returned BY REFERENCE, byte-identical', () => {
    for (const mode of ['demo', 'sandbox']) {
      const out = resolveLiveAnchorState(frozen, mode, [row('2026-09-02', 383.38)]);
      expect(out).toBe(frozen);
    }
  });

  it('an already-verified live anchor is still repointed to the SAME value it verified against', () => {
    // On a healthy live book the newest prior close IS what the attestation
    // matched, so the repair is value-neutral there — only the basis string and
    // paired date are added. Guards against the repair moving a sound anchor.
    const sound = {
      openingDate: '2026-09-03',
      openingEquity: 438.06,
      openingEquityBasis: 'verified-prior-session-close',
    };
    const out = resolveLiveAnchorState(sound, 'live', [row('2026-09-02', 438.06)]);
    expect(out.openingEquity).toBe(438.06);
    expect(out.openingEquityBasis).toBe(ANCHOR_BASIS_LIVE_PRIOR_ARCHIVED_CLOSE);
  });
});
