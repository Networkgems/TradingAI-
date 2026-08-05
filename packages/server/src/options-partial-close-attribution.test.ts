import { describe, it, expect } from 'vitest';
import { foldJournalClosesByEtDay, reconcilePnl } from './pnl-reconciliation.js';
import {
  journalRealizingEvents,
  planOptionsDailyPnlRepair,
  resolveDailyOptionsPnl,
} from './options-daily-pnl-source.js';
import type { DailySnapshot } from './pnl-tracker.js';

// TRA-2895 (found grading TRA-2314 fire 4, ET day 2026-08-04) — a PARTIAL exit
// realizes dollars the day census could not see.
//
// The journal writes a CLOSE row only when a position FULLY closes, and stamps
// it with the position's CUMULATIVE P&L at the full-close timestamp. Two
// consequences, both live on bqb1:
//
//   1. the trim's own day named ZERO closes, so `resolveDailyOptionsPnl` booked
//      `bucket-journal-silent` — the source that means "the journal is behind".
//      It was not behind, it was structurally blind, so that cell could NEVER
//      converge to `journal` and the TRA-2314/TRA-2870 C2 instrument inherited a
//      permanent yellow with no discharge path;
//   2. the eventual full close carried the trim's dollars a SECOND time, on a
//      different day, while the day-only bucket had already booked them on the
//      trim's day. Any multi-day sum over day cells overstated by the trim.
//
// The whole fix is arithmetic on ONE identity, and every test here is a way of
// asking it:
//
//     Σ over day cells of a trade's life  ==  the trade's cumulative P&L
//
// Live shape being reproduced (admin desk book, ET 2026-08-04, build 237c147e):
// `optionsDailyPnlSource: bucket-journal-silent, optionsDaily: -2.00,
// journalCloses: 0, journalOptionsPnl: 0.00` against a tape holding a manual
// `sell_to_close` of 4 contracts plus two engine tp1 slices.

const ET = (ts: number) =>
  new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// 14:00Z = 10:00 ET — comfortably inside the ET day on both dates.
const D1 = Date.parse('2026-08-04T14:00:00Z'); // the trim
const D2 = Date.parse('2026-08-06T14:00:00Z'); // the full close

/** A journal record that trimmed on D1 (+40) and fully closed on D2 (+100 cumulative). */
const TRIMMED_TRADE = {
  closeTs: D2,
  realizedPnlUsd: 100, // CUMULATIVE — contains the 40
  partials: [{ ts: D1, realizedPnlUsd: 40 }],
};

function snap(date: string, optionsDailyPnl: number): DailySnapshot {
  return {
    date,
    openingEquity: 0,
    closingEquity: 0,
    dailyPnl: 0,
    optionsPnl: 0,
    optionsDailyPnl,
    combinedPnl: 0,
    trades: 0,
  } as DailySnapshot;
}

describe('TRA-2895 — the census dates a partial exit on ITS OWN day', () => {
  it('splits a trimmed trade across the two days it actually realized on', () => {
    const m = foldJournalClosesByEtDay([TRIMMED_TRADE], ET);

    // The trim's day: real dollars, no round trip finished. That pair —
    // `closes: 0` with a non-zero figure — is the exact state that used to be
    // unrepresentable and therefore booked `bucket-journal-silent`.
    expect(m.get('2026-08-04')).toEqual({ closes: 0, partialCloses: 1, realizedPnlUsd: 40 });
    // The close day: the RESIDUAL, not the cumulative. 100 − 40.
    expect(m.get('2026-08-06')).toEqual({ closes: 1, partialCloses: 0, realizedPnlUsd: 60 });
  });

  it('the identity: Σ day cells == the trade cumulative, so nothing is counted twice', () => {
    const m = foldJournalClosesByEtDay([TRIMMED_TRADE], ET);
    const total = [...m.values()].reduce((s, v) => s + v.realizedPnlUsd, 0);
    expect(total).toBeCloseTo(100, 5);
    // And specifically NOT 140 — the pre-fix number, where the day-only bucket
    // held the trim on 08-04 and the census re-credited it on 08-06.
    expect(total).not.toBeCloseTo(140, 5);
  });

  it('MUTATION: the SAME trade with no partial rows folds exactly as it did pre-fix', () => {
    // The negative control for the whole ticket. A legacy record (written before
    // partials were journalled) must fold byte-identically to the old code, or
    // the historical repair stops being reproducible against its own history.
    const legacy = { closeTs: D2, realizedPnlUsd: 100 };
    const m = foldJournalClosesByEtDay([legacy], ET);
    expect(m.get('2026-08-04')).toBeUndefined();
    expect(m.get('2026-08-06')).toEqual({ closes: 1, partialCloses: 0, realizedPnlUsd: 100 });
  });

  it('counts a trim on a position that has NOT closed — the dollars are already spent', () => {
    // The live 08-04 case: three slices sold, twelve journal rows still OPEN
    // afterwards. If an open row contributed nothing, the day would stay silent
    // until the residual finally closed — possibly in a different month.
    const m = foldJournalClosesByEtDay(
      [{ partials: [{ ts: D1, realizedPnlUsd: -2 }] }],
      ET,
    );
    expect(m.get('2026-08-04')).toEqual({ closes: 0, partialCloses: 1, realizedPnlUsd: -2 });
  });

  it('keeps an unplaceable slice inside the close-day figure rather than deleting it', () => {
    // A slice with no usable timestamp cannot be dated, so it is NOT subtracted
    // from the cumulative close row. Dating a dollar late beats losing it.
    const m = foldJournalClosesByEtDay(
      [{ closeTs: D2, realizedPnlUsd: 100, partials: [{ ts: NaN, realizedPnlUsd: 40 }] }],
      ET,
    );
    expect(m.get('2026-08-06')!.realizedPnlUsd).toBe(100);
  });
});

describe('TRA-2895 — a trim-only day is journal-sourced, not bucket-journal-silent', () => {
  const census = foldJournalClosesByEtDay([TRIMMED_TRADE], ET);

  it('reproduces the live 2026-08-04 cell and books it from the journal', () => {
    const trimDay = census.get('2026-08-04')!;
    const decision = resolveDailyOptionsPnl({
      bucketPnl: 40, // the bucket DID carry the live slice — that is the -2.00 case
      census: trimDay,
      censusAvailable: true,
    });

    expect(decision.source).toBe('journal');
    expect(decision.source).not.toBe('bucket-journal-silent');
    expect(decision.value).toBe(40);
    // Both counts persisted: `journal` + `journalCloses: 0` is only legible as a
    // trim-only day if the partial count rides alongside it.
    expect(decision.journalCloses).toBe(0);
    expect(decision.journalPartialCloses).toBe(1);
  });

  it('MUTATION: a genuinely silent journal still books bucket-journal-silent', () => {
    // The guard that keeps the fix from being a blanket "always trust the
    // journal". Same bucket figure, same `censusAvailable`, ZERO realizing
    // events — the original failing state must survive untouched, or this
    // ticket would have deleted a detector instead of extending one.
    const decision = resolveDailyOptionsPnl({
      bucketPnl: 40,
      census: { closes: 0, partialCloses: 0, realizedPnlUsd: 0 },
      censusAvailable: true,
    });
    expect(decision.source).toBe('bucket-journal-silent');
    expect(decision.value).toBe(40);
  });

  it('books the close day off the RESIDUAL, so the two cells sum to the trade', () => {
    const trim = resolveDailyOptionsPnl({
      bucketPnl: 40,
      census: census.get('2026-08-04')!,
      censusAvailable: true,
    });
    const close = resolveDailyOptionsPnl({
      // The bucket's own cumulative quirk: `closedOptions` is pushed at full
      // close carrying the whole trade. The journal is authoritative here, which
      // is precisely how the double-attribution stops reaching the day cell.
      bucketPnl: 100,
      census: census.get('2026-08-06')!,
      censusAvailable: true,
    });
    expect(close.source).toBe('journal');
    expect(close.value).toBe(60);
    expect(close.bucketPnl).toBe(100); // the disagreement stays readable on the row
    expect(trim.value + close.value).toBeCloseTo(100, 5);
  });

  it('journalRealizingEvents is the one predicate — null census is 0 events', () => {
    expect(journalRealizingEvents(null)).toBe(0);
    expect(journalRealizingEvents(undefined)).toBe(0);
    expect(journalRealizingEvents({ closes: 0, partialCloses: 2, realizedPnlUsd: -2 })).toBe(2);
    expect(journalRealizingEvents({ closes: 3, partialCloses: 1, realizedPnlUsd: 10 })).toBe(4);
  });
});

describe('TRA-2895 — the repair and the checker scope with the writer', () => {
  it('the historical repair moves a trim-only false zero', () => {
    // TRA-2314's standing invariant: writer, repair and checker grade the same
    // population. A trim-only day the writer now books from the journal but the
    // repair skips would be a day that can never be corrected in history.
    const plan = planOptionsDailyPnlRepair(
      [snap('2026-08-04', 0)],
      foldJournalClosesByEtDay([TRIMMED_TRADE], ET),
    );
    expect(plan.deltas).toHaveLength(1);
    expect(plan.deltas[0]).toMatchObject({
      date: '2026-08-04',
      before: 0,
      after: 40,
      journalCloses: 0,
      journalPartialCloses: 1,
    });
  });

  it('the false-zero checker accuses a trim-only day too', () => {
    const r = reconcilePnl(
      [snap('2026-08-04', 0)],
      new Map([['2026-08-04', 0]]),
      null,
      foldJournalClosesByEtDay([TRIMMED_TRADE], ET),
    );
    expect(r.falseZeroDates).toEqual(['2026-08-04']);
    expect(r.days[0]).toMatchObject({
      journalCloses: 0,
      journalPartialCloses: 1,
      journalOptionsPnl: 40,
      optionsFalseZero: true,
    });
  });
});
