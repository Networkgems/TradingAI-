import { describe, it, expect } from 'vitest';
import {
  reconcilePnl,
  resolvePnlBaselineDate,
  foldJournalClosesByEtDay,
  liveOptionsOnsetEtDate,
  summarizeLiveLagTripwire,
  summarizeLiveCreditObservation,
  summarizeLiveEodRowPresence,
  summarizeLiveCohortIntegrity,
  countStaleTailSessions,
  summarizeDriftGradeability,
  PNL_RECONCILE_DEFAULT_BASELINE_DATE,
  PNL_RECONCILIATION_CAVEATS,
  PNL_DRIFT_DECOMPOSITION_NOTE,
  PNL_ABSENT_EOD_ROW_NOTE,
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
      expect(r.liveUncreditedOptionsGradeable).toBe(false);
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

      const dirty = summarizeLiveCreditObservation([flipped('admin', 987.6)]);
      expect(dirty.liveUncreditedOptionsUsd).toBeNull();
      expect(dirty.liveModeSpanContaminatedBooks).toHaveLength(1);
    });

    it('still grades a live book whose whole window IS post-onset', () => {
      // The gate must not be a permanent null — a book that only ever traded
      // live keeps its figure, or this "fix" is just a mute button.
      const r = summarizeLiveCreditObservation([flipped('admin', 0)]);
      expect(r.liveUncreditedOptionsGradeable).toBe(true);
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
    expect(r.ungradeableFields).toEqual(['ok', 'maxDriftUsd', 'engines[].drift']);
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
