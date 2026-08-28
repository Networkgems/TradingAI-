/**
 * TRA-4201 — the realized figure has to survive a `protected_snapshot`.
 *
 * The defect: `makeRealizedBackfillReport` reconstructs a genuine broker-truth
 * realized P&L for every candidate day, and on the live book almost every day is
 * owned by a 21:00 `tradier-balance` snapshot, so `decideCalendarRowWrite`
 * returns `skip / protected_snapshot` and the number is computed and dropped on
 * the floor. One row holds one `combinedPnl`; there was nowhere to put a second
 * measure.
 *
 * The guard is RIGHT and is not what these tests grade. What they grade is the
 * three properties the companion has to have to be safe to write onto a row the
 * guard just protected:
 *
 *   1. the authoritative fields do not move — not their values, not their key
 *      ORDER, so a re-serialized protected row differs only in the companion;
 *   2. absence does not read as zero — `closeCount: 0` is "did not trade", and
 *      the day must be excludable from a total and a win-rate denominator on
 *      that basis alone (TRA-3101's lesson, one level down);
 *   3. it is idempotent — a re-run with the same figures writes NOTHING, so a
 *      pass that runs at every startup cannot churn the file or its timestamp.
 *
 * The August 2026 fixture on account ***0154 (from TRA-4199) is used directly,
 * so the episode this ticket was filed about fails by name if it regresses.
 */

import { describe, expect, it } from 'vitest';
import {
  applyBrokerRealizedCompanion,
  buildBrokerRealizedCompanion,
  companionFiguresEqual,
  type BrokerRealizedCompanion,
  type CompanionCarrier,
} from './broker-realized-companion.js';
import { decideCalendarRowWrite } from './calendar-write-decision.js';

const AT = '2026-08-28T02:00:00.000Z';

/**
 * A stored `tradier-balance` row, in roughly the key order the server writes it.
 * Only the fields the companion path can plausibly touch are modelled; the point
 * of the byte-identity assertions below is that it must touch none of them.
 *
 * Typed rather than `Record<string, unknown>` so the assertions below read the
 * real field names — and so this file survives `tsc -b --force`, which
 * type-checks `.test.ts` and fails the DEPLOY BUILD without failing the suite
 * (CLAUDE.md; the exact trap AC6 exists for).
 */
type StoredRow = CompanionCarrier & {
  date: string;
  generatedAt: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  optionsPnl: number;
  combinedPnl: number;
  totalEquity: number;
  trades: unknown[];
  winRate: number;
  totalTrades: number;
  pnlSource: 'tradier-balance' | 'engine' | 'realized-backfill' | 'live-intraday';
  markdown: string;
  /** TRA-3102 / TRA-3101 audit blocks — shape irrelevant here, presence is not. */
  pnlUnreconciled?: Record<string, unknown>;
  pnlUnknown?: Record<string, unknown>;
};

function protectedRow(over: Partial<StoredRow> = {}): StoredRow {
  return {
    date: '2026-08-18',
    generatedAt: 1_756_000_000_000,
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: -196.44,
    optionsPnl: 0,
    combinedPnl: -196.44,
    totalEquity: 678.68,
    trades: [],
    winRate: 0,
    totalTrades: 0,
    pnlSource: 'tradier-balance' as const,
    markdown: '> **Live P&L (TRA-359).** 2026-08-18 …',
    ...over,
  };
}

/**
 * The 08-17 / 08-18 episode measured on TRA-4199: hand-placed calls bought for
 * $691.44 and sold the next session for $297.52. Under the balance measure that
 * is TWO loss cells (−197.36 opening mark, −196.44 the mark reversing). It is
 * ONE realized −393.92, and it belongs entirely to the settlement day.
 */
const AUG_EPISODE = {
  openDay: { date: '2026-08-17', balanceCell: -197.36, closes: 0, realized: 0 },
  settleDay: { date: '2026-08-18', balanceCell: -196.44, closes: 1, realized: -393.92 },
};

/** The fee-and-mark residue days. Real balance deltas, zero broker closes. */
const FEE_ONLY_DAYS = [-0.42, -0.13, -0.12, -0.1, -0.08, -0.04];

describe('TRA-4201 — companion construction', () => {
  it('derives combinedPnl from its own two sleeves, so the total cannot disagree with them', () => {
    const c = buildBrokerRealizedCompanion({
      optionsPnl: -393.92,
      equityPnl: 12.5,
      closeCount: 2,
      equityIncluded: true,
      reconstructedAt: AT,
    });
    expect(c.combinedPnl).toBe(-381.42);
    expect(c.combinedPnl).toBe(Number((c.optionsPnl + c.equityPnl).toFixed(2)));
  });

  it('keeps the option/stock sleeves SPLIT (TRA-2876) rather than folding them', () => {
    const c = buildBrokerRealizedCompanion({
      optionsPnl: -393.92,
      equityPnl: 0,
      closeCount: 1,
      equityIncluded: true,
      reconstructedAt: AT,
    });
    expect(c.optionsPnl).toBe(-393.92);
    expect(c.equityPnl).toBe(0);
  });

  it('rounds to the cent — float residue in a money field is a bug, not a rounding taste', () => {
    const c = buildBrokerRealizedCompanion({
      optionsPnl: 0.1 + 0.2,
      equityPnl: 0,
      closeCount: 1,
      equityIncluded: true,
      reconstructedAt: AT,
    });
    expect(c.optionsPnl).toBe(0.3);
    expect(c.combinedPnl).toBe(0.3);
  });

  it('records equityIncluded:false so an OPTIONS-ONLY figure cannot pass as all-instrument', () => {
    // TRA-2876 — when the corporate-action feed is unreadable, equity is
    // WITHHELD. `equityPnl: 0` from an abstention and `equityPnl: 0` from a day
    // with no stock closes are the same bytes; only this flag separates them.
    const withheld = buildBrokerRealizedCompanion({
      optionsPnl: -393.92,
      equityPnl: 0,
      closeCount: 1,
      equityIncluded: false,
      reconstructedAt: AT,
    });
    expect(withheld.equityIncluded).toBe(false);
    expect(withheld.equityPnl).toBe(0);
  });
});

describe('TRA-4201 — a PROTECTED row gains the companion and loses nothing', () => {
  it('the guard still says protected_snapshot on the settlement day (this ticket does not relax it)', () => {
    const decision = decideCalendarRowWrite({
      existing: protectedRow(),
      dayRealized: AUG_EPISODE.settleDay.realized,
      dayCloseCount: AUG_EPISODE.settleDay.closes,
      forced: false,
    });
    expect(decision).toEqual({ action: 'skip', reason: 'protected_snapshot' });
  });

  it('protected row + non-zero closes → companion written, authoritative fields untouched', () => {
    const before = protectedRow();
    const companion = buildBrokerRealizedCompanion({
      optionsPnl: AUG_EPISODE.settleDay.realized,
      equityPnl: 0,
      closeCount: AUG_EPISODE.settleDay.closes,
      equityIncluded: true,
      reconstructedAt: AT,
    });
    const { changed, row } = applyBrokerRealizedCompanion(before, companion);

    expect(changed).toBe(true);
    expect(row.brokerRealized?.combinedPnl).toBe(-393.92);
    expect(row.brokerRealized?.closeCount).toBe(1);

    // The whole point: the day's OWN figure is still the balance delta.
    expect(row.combinedPnl).toBe(AUG_EPISODE.settleDay.balanceCell);
    expect(row.pnlSource).toBe('tradier-balance');
    expect(row.realizedPnl).toBe(before.realizedPnl);
    expect(row.optionsPnl).toBe(before.optionsPnl);
    expect(row.markdown).toBe(before.markdown);
  });

  it('serialises byte-identically apart from the companion — key ORDER included', () => {
    // Not a pedantic assertion. `combinedPnl` surviving with the right value but
    // in a different position still rewrites the whole file, which destroys
    // "the file changed" as a signal that a NUMBER changed.
    const before = protectedRow();
    const companion = buildBrokerRealizedCompanion({
      optionsPnl: -393.92, equityPnl: 0, closeCount: 1, equityIncluded: true, reconstructedAt: AT,
    });
    const { row } = applyBrokerRealizedCompanion(before, companion);

    const strip = (o: StoredRow) => {
      const { brokerRealized: _drop, ...rest } = o;
      return JSON.stringify(rest, null, 2);
    };
    expect(strip(row)).toBe(strip(before));
    expect(Object.keys(row).filter(k => k !== 'brokerRealized')).toEqual(Object.keys(before));
  });

  it('leaves the TRA-3101 / TRA-3102 audit blocks alone — a flagged row stays flagged', () => {
    const flagged = protectedRow({
      pnlUnreconciled: { reason: 'engine_close_without_broker_fill', renderedPnl: 385.8 },
      pnlUnknown: { reason: 'stale_balance_anchor', anchorDate: '2026-08-17' },
    });
    const { row } = applyBrokerRealizedCompanion(
      flagged,
      buildBrokerRealizedCompanion({
        optionsPnl: 0, equityPnl: 0, closeCount: 0, equityIncluded: true, reconstructedAt: AT,
      }),
    );
    expect(row.pnlUnreconciled).toEqual(flagged.pnlUnreconciled);
    expect(row.pnlUnknown).toEqual(flagged.pnlUnknown);
  });
});

describe('TRA-4201 — absence must not read as zero', () => {
  it('protected row + ZERO closes → a companion with closeCount 0, not a missing one', () => {
    // The distinction the calendar renders: no companion at all = "never
    // reconstructed"; companion with closeCount 0 = "reconstructed, and this day
    // did not trade". Deleting the companion instead would collapse them.
    const { changed, row } = applyBrokerRealizedCompanion(
      protectedRow({ date: '2026-08-19', combinedPnl: -0.42 }),
      buildBrokerRealizedCompanion({
        optionsPnl: 0, equityPnl: 0, closeCount: 0, equityIncluded: true, reconstructedAt: AT,
      }),
    );
    expect(changed).toBe(true);
    expect(row.brokerRealized).toBeDefined();
    expect(row.brokerRealized?.closeCount).toBe(0);
    expect(row.brokerRealized?.combinedPnl).toBe(0);
    // …and the row's own fee-residue figure is untouched.
    expect(row.combinedPnl).toBe(-0.42);
  });

  it('the six fee-only August days all reconstruct to closeCount 0 — excludable as untraded', () => {
    const companions = FEE_ONLY_DAYS.map(() =>
      buildBrokerRealizedCompanion({
        optionsPnl: 0, equityPnl: 0, closeCount: 0, equityIncluded: true, reconstructedAt: AT,
      }),
    );
    expect(companions.every(c => c.closeCount === 0)).toBe(true);

    // A reader excluding on `closeCount === 0` drops exactly these six and
    // nothing else — the AC2 denominator correction, at the data layer.
    const withSettlement = [
      ...companions,
      buildBrokerRealizedCompanion({
        optionsPnl: -393.92, equityPnl: 0, closeCount: 1, equityIncluded: true, reconstructedAt: AT,
      }),
    ];
    const traded = withSettlement.filter(c => c.closeCount > 0);
    expect(traded).toHaveLength(1);
    expect(traded.reduce((s, c) => s + c.combinedPnl, 0)).toBe(-393.92);
  });

  it('the 08-17/08-18 episode collapses to ONE realized figure on the settlement day', () => {
    // Under the balance measure this is two cells summing to -393.80; under the
    // realized measure it is one cell of -393.92 and one untraded day. The two
    // measures are close in TOTAL and completely different in SHAPE, which is
    // why a win rate computed off the first one is not a strategy statistic.
    const open = buildBrokerRealizedCompanion({
      optionsPnl: AUG_EPISODE.openDay.realized, equityPnl: 0,
      closeCount: AUG_EPISODE.openDay.closes, equityIncluded: true, reconstructedAt: AT,
    });
    const settle = buildBrokerRealizedCompanion({
      optionsPnl: AUG_EPISODE.settleDay.realized, equityPnl: 0,
      closeCount: AUG_EPISODE.settleDay.closes, equityIncluded: true, reconstructedAt: AT,
    });
    expect(open.closeCount).toBe(0);            // renders `--`, not -197.36
    expect(settle.combinedPnl).toBe(-393.92);   // the whole trip, on the day it settled
    expect([open, settle].filter(c => c.closeCount > 0)).toHaveLength(1);
  });

  it('a day that traded FLAT is not the same as a day that did not trade', () => {
    const flat = buildBrokerRealizedCompanion({
      optionsPnl: 0, equityPnl: 0, closeCount: 2, equityIncluded: true, reconstructedAt: AT,
    });
    const untraded = buildBrokerRealizedCompanion({
      optionsPnl: 0, equityPnl: 0, closeCount: 0, equityIncluded: true, reconstructedAt: AT,
    });
    expect(flat.combinedPnl).toBe(untraded.combinedPnl); // identical money…
    expect(flat.closeCount).not.toBe(untraded.closeCount); // …distinguishable anyway
  });
});

describe('TRA-4201 — idempotency', () => {
  const companionAt = (at: string): BrokerRealizedCompanion =>
    buildBrokerRealizedCompanion({
      optionsPnl: -393.92, equityPnl: 0, closeCount: 1, equityIncluded: true, reconstructedAt: at,
    });

  it('a re-run with the same figures reports changed:false and hands back the SAME object', () => {
    const first = applyBrokerRealizedCompanion(protectedRow(), companionAt(AT));
    const second = applyBrokerRealizedCompanion(first.row, companionAt('2026-08-29T02:00:00.000Z'));
    expect(second.changed).toBe(false);
    // Identity, not just equality: the caller skips `writeFile` entirely, so the
    // file — `reconstructedAt` included — stays byte-identical across passes.
    expect(second.row).toBe(first.row);
    expect(second.row.brokerRealized?.reconstructedAt).toBe(AT);
  });

  it('a CHANGED figure does write, so a corrected reconstruction is not stuck behind the cache', () => {
    const first = applyBrokerRealizedCompanion(protectedRow(), companionAt(AT));
    const corrected = buildBrokerRealizedCompanion({
      optionsPnl: -393.92, equityPnl: -12.5, closeCount: 2, equityIncluded: true, reconstructedAt: '2026-08-29T02:00:00.000Z',
    });
    const second = applyBrokerRealizedCompanion(first.row, corrected);
    expect(second.changed).toBe(true);
    expect(second.row.brokerRealized?.combinedPnl).toBe(-406.42);
  });

  it('an equityIncluded flip is a change even when every figure is identical', () => {
    // Otherwise a pass that RECOVERED the corporate-action feed would leave the
    // row asserting "options only" forever, on numbers that are now complete.
    const optionsOnly = buildBrokerRealizedCompanion({
      optionsPnl: -393.92, equityPnl: 0, closeCount: 1, equityIncluded: false, reconstructedAt: AT,
    });
    const complete = buildBrokerRealizedCompanion({
      optionsPnl: -393.92, equityPnl: 0, closeCount: 1, equityIncluded: true, reconstructedAt: AT,
    });
    expect(companionFiguresEqual(optionsOnly, complete)).toBe(false);
    expect(applyBrokerRealizedCompanion({ brokerRealized: optionsOnly }, complete).changed).toBe(true);
  });

  it('companionFiguresEqual ignores reconstructedAt and nothing else', () => {
    const a = companionAt(AT);
    const b = companionAt('2027-01-01T00:00:00.000Z');
    expect(companionFiguresEqual(a, b)).toBe(true);
    expect(companionFiguresEqual(a, { ...a, closeCount: 2 })).toBe(false);
    expect(companionFiguresEqual(a, { ...a, combinedPnl: 0 })).toBe(false);
    expect(companionFiguresEqual(a, { ...a, optionsPnl: 0 })).toBe(false);
    expect(companionFiguresEqual(a, { ...a, equityPnl: 1 })).toBe(false);
    expect(companionFiguresEqual(undefined, a)).toBe(false);
    expect(companionFiguresEqual(undefined, undefined)).toBe(true);
  });

  it('a row with NO prior companion is a change (first pass writes it)', () => {
    expect(applyBrokerRealizedCompanion(protectedRow(), companionAt(AT)).changed).toBe(true);
  });
});

describe('TRA-4201 — a BACKFILL-OWNED row is not double-counted', () => {
  it('the guard still writes it, and the companion mirrors the row rather than adding to it', () => {
    // AC5's third arm. A `realized-backfill` row IS the realized figure, so the
    // companion is redundant there BY CONSTRUCTION — same pass, same inputs. It
    // is carried anyway so the realized VIEW reads one field on every row
    // instead of branching on `pnlSource` and then having no close count to
    // build a denominator from. Redundant-and-identical is the safe kind of
    // duplication; the unsafe kind is two numbers that can drift.
    const decision = decideCalendarRowWrite({
      existing: { pnlSource: 'realized-backfill', combinedPnl: -80.72 },
      dayRealized: -80.72,
      dayCloseCount: 3,
      forced: false,
    });
    expect(decision.action).toBe('write');

    const companion = buildBrokerRealizedCompanion({
      optionsPnl: -80.72, equityPnl: 0, closeCount: 3, equityIncluded: true, reconstructedAt: AT,
    });
    // The row's own combined figure and the companion's are the SAME number, so
    // no view can produce a doubled total whichever field it reads.
    expect(companion.combinedPnl).toBe(-80.72);
  });

  it('a forced overwrite REPLACES the companion rather than merging a stale one', () => {
    // The row was a protected snapshot carrying a companion; an operator forces
    // it, so the row itself becomes the realized figure. Carrying the earlier
    // block forward would leave the cell holding two realized numbers with
    // nothing saying which pass produced which.
    const stale = buildBrokerRealizedCompanion({
      optionsPnl: -100, equityPnl: 0, closeCount: 1, equityIncluded: true, reconstructedAt: '2026-08-01T00:00:00.000Z',
    });
    const fresh = buildBrokerRealizedCompanion({
      optionsPnl: -393.92, equityPnl: 0, closeCount: 1, equityIncluded: true, reconstructedAt: AT,
    });
    const { row } = applyBrokerRealizedCompanion({ brokerRealized: stale }, fresh);
    expect(row.brokerRealized).toEqual(fresh);
    expect(row.brokerRealized?.combinedPnl).not.toBe(stale.combinedPnl);
  });
});
