import { describe, expect, it } from 'vitest';
import {
  CROSSED_LONG_PREMIUM_STRUCTURES,
  foldCrossedCells,
  foldSpreadCells,
  priceCrossedRow,
  type CrossedPricingRow,
} from './option-crossed-pnl.js';
import {
  GATE_R_BASIS_STRUCTURES,
  summarizeOptionTradeJournal,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';

/**
 * TRA-4674 — crossed P&L beside booked P&L.
 *
 * The load-bearing fixture is the LIVE TAPE, not an invented one: the 13
 * `accountClass: desk` closes of 2026-09-09..09-17, read verbatim from bqb1
 * serving `0dc2baea` (`/api/health/option-journal?rows=all&sinceEtDay=
 * 2026-09-09&untilEtDay=2026-09-17`, fetched 2026-09-17). QuantTrader's
 * measurement on those rows (TRA-4671 comment `49abc97a`) is the acceptance:
 * 9 priced rows summing to crossed −$87.00 against booked −$32.07 on the SAME
 * 9, PGY `a22d5bbc` at −$10.00, and the 4 quote-less rows moving neither
 * column. If the shipped arithmetic drifts from that comment, this file is
 * what goes red.
 */

/** One live desk close, reduced to the fields the crossed pricing reads. */
function deskRow(
  symbol: string,
  contracts: number,
  atRiskUsd: number,
  entryBid: number,
  entryAsk: number,
  exitQuote: { bid: number; ask: number } | null,
  realizedPnlUsd: number,
): CrossedPricingRow & { symbol: string } {
  return {
    symbol,
    outcome: realizedPnlUsd > 0 ? 'WIN' : realizedPnlUsd < 0 ? 'LOSS' : 'SCRATCH',
    structure: 'single_leg_directional',
    contracts,
    atRiskUsd,
    realizedPnlUsd,
    entryBidAtOpen: entryBid,
    entryAskAtOpen: entryAsk,
    entrySpreadPct: (entryAsk - entryBid) / ((entryAsk + entryBid) / 2),
    markProvenance: { quoteAtFire: exitQuote },
  };
}

/** The 13 desk closes, 2026-09-09..09-17, verbatim from the live journal. */
const LIVE_DESK_CLOSES = [
  deskRow('NVTS', 1, 134, 1.29, 1.39, null, 0),
  deskRow('PFE', 1, 84.5, 0.82, 0.87, null, -2.0000000000000018),
  deskRow('SOFI', 1, 97, 0.96, 0.98, { bid: 0.86, ask: 0.89 }, -20.500000000000007),
  deskRow('MO', 1, 115.49999999999999, 1.13, 1.18, { bid: 0.97, ask: 1.03 }, -15.49999999999998),
  deskRow('SIRI', 1, 123.49999999999999, 1.18, 1.29, null, 24.390943435977608),
  deskRow('NOK', 2, 136, 0.67, 0.69, null, 22.4766473822098),
  deskRow('XLF', 1, 119.49999999999999, 1.15, 1.24, { bid: 1.06, ask: 1.15 }, -19.327349154568463),
  deskRow('XLF', 1, 113.5, 1.1, 1.17, { bid: 1.02, ask: 1.17 }, -4.0000000000000036),
  deskRow('SOFI', 1, 92.5, 0.9, 0.95, { bid: 0.95, ask: 0.99 }, 8.999999999999986),
  deskRow('XLF', 1, 112.99999999999999, 1.08, 1.18, { bid: 1.07, ask: 1.15 }, -4.0000000000000036),
  deskRow('TLT', 1, 131.5, 1.31, 1.32, { bid: 1.4, ask: 1.43 }, 17.7610272262525),
  deskRow('SOFI', 1, 104.5, 1.01, 1.08, { bid: 1.0, ask: 1.04 }, -5.499999999999972),
  deskRow('PGY', 1, 147.5, 1.45, 1.5, { bid: 1.4, ask: 1.65 }, 9.999999999999964),
];

describe('priceCrossedRow (TRA-4674 AC1/AC2)', () => {
  it('prices PGY a22d5bbc at −$10.00 — the +$10.00 booked win, crossed to a loss', () => {
    const pgy = LIVE_DESK_CLOSES[12]!;
    const p = priceCrossedRow(pgy);
    // (exit bid 1.40 − entry ask 1.50) × 100 × 1
    expect(p.crossedPnlUsd).toBe(-10);
    expect(p.crossedR).toBeCloseTo(-10 / 147.5, 4);
    expect(p.crossedUnpriced).toBeNull();
    expect(pgy.realizedPnlUsd).toBeCloseTo(10, 10); // booked stays a win
  });

  it('a row with no exit quote is null + exit_quote_missing — never 0', () => {
    const p = priceCrossedRow(LIVE_DESK_CLOSES[0]!); // NVTS, quoteAtFire null
    expect(p).toEqual({ crossedPnlUsd: null, crossedR: null, crossedUnpriced: 'exit_quote_missing' });
  });

  it('an OPEN row, a multi-leg structure, and a missing contract count each name their reason', () => {
    const base = LIVE_DESK_CLOSES[12]!;
    expect(priceCrossedRow({ ...base, outcome: 'OPEN' }).crossedUnpriced).toBe('open_row');
    expect(priceCrossedRow({ ...base, structure: 'iron_condor' }).crossedUnpriced).toBe(
      'structure_not_crossable',
    );
    expect(priceCrossedRow({ ...base, contracts: undefined }).crossedUnpriced).toBe(
      'contracts_unknown',
    );
    expect(
      priceCrossedRow({ ...base, entryAskAtOpen: null, entryAsk: undefined }).crossedUnpriced,
    ).toBe('entry_quote_missing');
    expect(
      priceCrossedRow({ ...base, markProvenance: { quoteAtFire: { bid: 0, ask: 1.65 } } })
        .crossedUnpriced,
    ).toBe('exit_quote_unusable');
  });

  it('falls back to the TRA-1656 scanner snapshot when the TRA-3990 stamp is absent', () => {
    const base = LIVE_DESK_CLOSES[12]!;
    const p = priceCrossedRow({
      ...base,
      entryBidAtOpen: null,
      entryAskAtOpen: null,
      entryBid: 1.45,
      entryAsk: 1.5,
    });
    expect(p.crossedPnlUsd).toBe(-10);
  });

  it('mirrors the sign for short premium: sell the bid at entry, pay the ask at exit', () => {
    const p = priceCrossedRow({
      outcome: 'WIN',
      structure: 'cash_secured_put',
      contracts: 1,
      atRiskUsd: 100,
      realizedPnlUsd: 30,
      entryBidAtOpen: 1.0,
      entryAskAtOpen: 1.1,
      entrySpreadPct: null,
      markProvenance: { quoteAtFire: { bid: 0.6, ask: 0.75 } },
    });
    // Collected the 1.00 bid, buy back at the 0.75 ask → +$25.
    expect(p.crossedPnlUsd).toBe(25);
  });

  it('multiplies by the contract count', () => {
    const nokPriced = priceCrossedRow({
      ...LIVE_DESK_CLOSES[5]!, // NOK, 2 contracts
      markProvenance: { quoteAtFire: { bid: 0.8, ask: 0.84 } },
    });
    // (0.80 − 0.69) × 100 × 2
    expect(nokPriced.crossedPnlUsd).toBe(22);
  });
});

describe('foldCrossedCells over the live desk tape (TRA-4674 AC2/AC3)', () => {
  it('reproduces QuantTrader’s matched 9-vs-9 comparison exactly', () => {
    const cells = foldCrossedCells(LIVE_DESK_CLOSES);
    expect(cells.priced).toBe(9);
    expect(cells.unpriced).toBe(4);
    expect(cells.unpricedReasons).toEqual({ exit_quote_missing: 4 });
    expect(cells.crossedPnlUsd).toBe(-87);
    expect(cells.bookedPnlUsdPriced).toBe(-32.07);
    expect(cells.spreadDragUsd).toBe(-54.93);
    // Booked 3W/6L on the priced subset → crossed 1W/7L/1F.
    expect(cells.win).toBe(1); // TLT
    expect(cells.loss).toBe(7);
    expect(cells.flat).toBe(1); // SOFI 09-15: exit bid 0.95 == entry ask 0.95
    expect(cells.crossedRSampled).toBe(9);
  });

  it('NEGATIVE CONTROL (AC3): a row missing its exit quote moves NEITHER column', () => {
    const priced9 = LIVE_DESK_CLOSES.filter(
      (r) => r.markProvenance?.quoteAtFire != null,
    );
    const withUnpriced = foldCrossedCells(LIVE_DESK_CLOSES);
    const without = foldCrossedCells(priced9);
    expect(withUnpriced.crossedPnlUsd).toBe(without.crossedPnlUsd);
    expect(withUnpriced.bookedPnlUsdPriced).toBe(without.bookedPnlUsdPriced);
    // The 4 excluded rows are visible, not vanished.
    expect(withUnpriced.unpriced - without.unpriced).toBe(4);
  });

  it('a fold with nothing priced reads null everywhere a sum would go — never $0', () => {
    const cells = foldCrossedCells([LIVE_DESK_CLOSES[0]!, LIVE_DESK_CLOSES[1]!]);
    expect(cells.priced).toBe(0);
    expect(cells.crossedPnlUsd).toBeNull();
    expect(cells.bookedPnlUsdPriced).toBeNull();
    expect(cells.spreadDragUsd).toBeNull();
    expect(cells.avgCrossedR).toBeNull();
  });
});

describe('foldSpreadCells (TRA-4674 "also useful")', () => {
  it('reproduces the measured entry-spread distribution: min 0.76%, median 5.92%, max 8.91%', () => {
    const { entry, exit } = foldSpreadCells(LIVE_DESK_CLOSES);
    expect(entry.sampled).toBe(13);
    expect(entry.min!).toBeCloseTo(0.0076, 4);
    expect(entry.median!).toBeCloseTo(0.0592, 4);
    expect(entry.max!).toBeCloseTo(0.0891, 4);
    expect(exit.sampled).toBe(9); // only rows carrying quoteAtFire
  });

  it('an empty set folds to sampled 0 and nulls', () => {
    const { entry, exit } = foldSpreadCells([]);
    expect(entry).toEqual({ sampled: 0, mean: null, median: null, min: null, max: null });
    expect(exit).toEqual({ sampled: 0, mean: null, median: null, min: null, max: null });
  });
});

describe('wiring + vocabulary drift', () => {
  it('the crossed long-premium set stays equal to GATE_R_BASIS_STRUCTURES', () => {
    // Both sets mean "the long single-leg debit sleeves"; they are duplicated
    // only to avoid a runtime import cycle. If one gains a structure the other
    // must too — this is the drift guard the duplication owes.
    expect([...CROSSED_LONG_PREMIUM_STRUCTURES].sort()).toEqual(
      [...GATE_R_BASIS_STRUCTURES].sort(),
    );
  });

  it('summarizeOptionTradeJournal publishes crossed + spreads, and per-structure crossed cells', () => {
    const record = (over: Partial<OptionTradeJournalRecord>): OptionTradeJournalRecord =>
      ({
        id: Math.random().toString(36).slice(2),
        openTs: 1,
        symbol: 'PGY',
        structure: 'single_leg_directional',
        mode: 'demo',
        ivRank: null,
        trend: 'up',
        sentiment: null,
        entryDelta: 0.47,
        entryDte: 29,
        atRiskUsd: 147.5,
        outcome: 'SCRATCH',
        closeTs: 2,
        realizedPnlUsd: 10,
        realizedR: 0.0678,
        exitReason: 'chandelier',
        holdDays: 0,
        contracts: 1,
        entryBidAtOpen: 1.45,
        entryAskAtOpen: 1.5,
        entrySpreadPct: 0.0339,
        markProvenance: { markSource: 'quote', staleMarkTicks: 0, quoteAtFire: { bid: 1.4, ask: 1.65 }, at: 2 },
        ...over,
      }) as OptionTradeJournalRecord;
    const summary = summarizeOptionTradeJournal([
      record({}),
      // The unpriceable sibling: same structure, no exit quote.
      record({ markProvenance: { markSource: 'quote', staleMarkTicks: 0, quoteAtFire: null, at: 2 } }),
    ]);
    expect(summary.crossed.priced).toBe(1);
    expect(summary.crossed.crossedPnlUsd).toBe(-10);
    expect(summary.crossed.bookedPnlUsdPriced).toBe(10);
    expect(summary.crossed.unpricedReasons).toEqual({ exit_quote_missing: 1 });
    expect(summary.spreads.entry.sampled).toBe(2);
    const cell = summary.byStructure.find((s) => s.structure === 'single_leg_directional');
    expect(cell?.crossed.crossedPnlUsd).toBe(-10);
    // The booked headline is UNCHANGED by all of this: both rows still fold.
    expect(summary.realizedPnlUsd).toBe(20);
  });
});
