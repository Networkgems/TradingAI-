import { describe, it, expect } from 'vitest';
import type { TradierTradeHistoryFill } from '@trading-app/engine';
import {
  equitySymbolsInvalidatedByCorporateActions,
  realizedOptionsPnlByCloseDate,
  realizedPnlByCloseDate,
} from './tradier-reconcile.js';
import { LIVE_TRADIER_TAPE } from './tra2864-live-tradier-tape.fixture.js';

// TRA-2876 -- "Equity realized P&L never reaches the live calendar backfill cell".
//
// TRA-2864 pinned 2026-06-16 at the OPTIONS-only -163.15 and named the
// all-instrument -162.35 in a comment, so the gap would be visible rather than a
// silent 80-cent drift. This file is that gap closing: the same live-production
// tape, now measured against Tradier's ALL-INSTRUMENT gain/loss.
//
// The numbers below are the broker's, taken from the issue's own reading of the
// uploaded export -- an independent second source, not our output snapshotted
// back at us. Every equity expectation is stated as BOTH the all-instrument
// total AND the options-only figure it must differ from, because a matcher that
// silently kept dropping equity would otherwise pass a test that only asserted
// "some number came out".

/** Tradier gain/loss, ALL instruments, for the days the equity legs land on. */
const TRADIER_ALL_INSTRUMENT_BY_DATE: Record<string, number> = {
  '2026-06-16': -162.35, // options -163.15 + MIR +0.80
};

/** The equity-only slice, per the round trips the issue enumerates. */
const EQUITY_REALIZED_BY_DATE: Record<string, number> = {
  '2026-06-16': 0.8, // MIR: bought 06-12 -16.64, sold 06-16 +17.44
  '2026-06-09': -10.37, // CIFR -1.31, IREN -2.40, INTC -2.10, GM -0.66, RKLB -3.90
  '2026-06-08': -0.3, // RDW -0.16, LASE -0.14
};

const equityScope = { includeEquity: true } as const;

describe('TRA-2876 equity realized reaches the backfill cell', () => {
  it('2026-06-16 now ties out to Tradier all-instrument, not options-only', () => {
    const { realizedByDate } = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, equityScope);
    const { realizedByDate: optionsOnly } = realizedOptionsPnlByCloseDate(LIVE_TRADIER_TAPE);
    // The pre-fix number, still exactly reproducible on the options-only path.
    expect(optionsOnly.get('2026-06-16')).toBeCloseTo(-163.15, 2);
    // ...and the number a user reconciling against their statement sees.
    expect(realizedByDate.get('2026-06-16')).toBeCloseTo(
      TRADIER_ALL_INSTRUMENT_BY_DATE['2026-06-16'],
      2,
    );
  });

  it.each(Object.entries(EQUITY_REALIZED_BY_DATE))(
    '%s books the equity round trips the calendar showed nothing for (%s)',
    (date, expected) => {
      const { equityRealizedByDate } = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, equityScope);
      expect(equityRealizedByDate.get(date)).toBeCloseTo(expected, 2);
    },
  );

  it('un-flattens 2026-06-08 and de-greens 2026-06-09', () => {
    // These are the two days where the omission changed what the cell SAYS,
    // not just by how much:
    //   06-08 is not a key at all on the options path -- no option close
    //         matched that day -- so the calendar renders a flat day on a day
    //         the account lost 30 cents.
    //   06-09 reads +$11.85 green on options while the real all-instrument day
    //         is +$1.48: the equity cluster ate 88% of it and the cell showed
    //         no sign of that.
    const { realizedByDate: optionsOnly } = realizedOptionsPnlByCloseDate(LIVE_TRADIER_TAPE);
    expect(optionsOnly.has('2026-06-08')).toBe(false);
    expect(optionsOnly.get('2026-06-09')).toBeCloseTo(11.85, 2);
    const { realizedByDate } = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, equityScope);
    expect(realizedByDate.get('2026-06-08')).toBeCloseTo(-0.3, 2);
    expect(realizedByDate.get('2026-06-09')).toBeCloseTo(1.48, 2);
  });

  it('leaves every OPTIONS figure exactly where TRA-2864 pinned it', () => {
    // Equity must ADD a sleeve, never perturb one. The options slice of the
    // all-instrument pass has to equal the options-only path day for day.
    const { optionsRealizedByDate } = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, equityScope);
    const { realizedByDate: optionsOnly } = realizedOptionsPnlByCloseDate(LIVE_TRADIER_TAPE);
    for (const [date, value] of optionsOnly) {
      expect(optionsRealizedByDate.get(date)).toBeCloseTo(value, 6);
    }
    // The reverse direction too: no options day invented by the equity pass.
    for (const [date, value] of optionsRealizedByDate) {
      if (Math.abs(value) < 1e-9) continue; // an equity-only day carries a 0 options slice
      expect(optionsOnly.get(date)).toBeCloseTo(value, 6);
    }
  });

  it('splits the day into the two tiles the report actually renders', () => {
    // `combinedPnl = realizedPnl (stocks) + optionsPnl` is the report's own
    // invariant; the calendar detail view shows both as separate tiles. Booking
    // the combined figure into the options tile would tie the cell out while
    // lying about which sleeve earned it.
    const { realizedByDate, equityRealizedByDate, optionsRealizedByDate } =
      realizedPnlByCloseDate(LIVE_TRADIER_TAPE, equityScope);
    for (const [date, total] of realizedByDate) {
      const stocks = equityRealizedByDate.get(date) ?? 0;
      const options = optionsRealizedByDate.get(date) ?? 0;
      expect(stocks + options).toBeCloseTo(total, 6);
    }
    expect(optionsRealizedByDate.get('2026-06-16')).toBeCloseTo(-163.15, 2);
    expect(equityRealizedByDate.get('2026-06-16')).toBeCloseTo(0.8, 2);
  });

  it('books a fractional share count at its real per-share basis', () => {
    // The live tape trades TDIC at $0.3947 and LASE at $3.3699. A matcher that
    // assumed integer share counts (or integer division of the lot) would be
    // wrong here, not just imprecise.
    const fractional: TradierTradeHistoryFill[] = [
      mkEquity('2026-07-01', 'FRAC', 0.5, -5.0, 'f-open'),
      mkEquity('2026-07-02', 'FRAC', 0.25, 3.5, 'f-close-1'),
      mkEquity('2026-07-03', 'FRAC', 0.25, 3.5, 'f-close-2'),
    ];
    const { equityRealizedByDate } = realizedPnlByCloseDate(fractional, equityScope);
    // basis $10/share; each close sells 0.25 at $14/share ⇒ +$1.00.
    expect(equityRealizedByDate.get('2026-07-02')).toBeCloseTo(1.0, 6);
    expect(equityRealizedByDate.get('2026-07-03')).toBeCloseTo(1.0, 6);
  });

  it('is fail-closed: withholding equity reproduces the options-only cell exactly', () => {
    // This is the setting the caller MUST use when the corporate-action read
    // was unavailable. It has to degrade to the old behaviour, not to a guess.
    const withheld = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, { includeEquity: false });
    const { realizedByDate: optionsOnly } = realizedOptionsPnlByCloseDate(LIVE_TRADIER_TAPE);
    expect([...withheld.realizedByDate.keys()].sort()).toEqual([...optionsOnly.keys()].sort());
    for (const [date, value] of optionsOnly) {
      expect(withheld.realizedByDate.get(date)).toBeCloseTo(value, 6);
    }
    expect(withheld.equityRealizedByDate.size).toBe(0);
    // Default argument is the withholding one -- a caller that forgets the
    // corporate-action read cannot accidentally get unguarded equity.
    expect(realizedPnlByCloseDate(LIVE_TRADIER_TAPE).equityRealizedByDate.size).toBe(0);
  });
});

describe('TRA-2876 corporate actions cannot corrupt the equity lot book', () => {
  // The board's tape holds 7 TDIC shares (2 bought 06-08, 5 bought 06-09) and a
  // REVERSE SPLIT that removes them at zero cash, as an `adjustment` carrying no
  // trade row. Post-split the account holds 0.7 shares. This is the sell that
  // would land next.
  const tdicSell = mkEquity('2026-06-20', 'TDIC', 0.7, 2.1, 'tdic-sell');
  const tdicTape = [...LIVE_TRADIER_TAPE, tdicSell];
  const split = {
    date: '2026-06-09',
    type: 'adjustment',
    description: 'REVERSE SPLIT - TDIC',
    quantity: -7,
  };

  it('would book a WRONG number if the split were ignored (the failure being guarded)', () => {
    // Un-guarded, FIFO matches 0.7 shares against the $0.5199 lot: +$1.73 of
    // pure profit, on a position that actually lost money. Nothing about that
    // number looks wrong on a calendar. This assertion exists so the guard
    // below cannot pass vacuously -- if the matcher ever stopped booking TDIC
    // for an unrelated reason, this fails first.
    const { equityRealizedByDate } = realizedPnlByCloseDate(tdicTape, equityScope);
    expect(equityRealizedByDate.get('2026-06-20')).toBeCloseTo(1.73, 2);
  });

  it('withholds exactly the affected ticker once the action is read', () => {
    const scope = equitySymbolsInvalidatedByCorporateActions([split], tdicTape);
    expect([...scope.excludeSymbols]).toEqual(['TDIC']);
    expect(scope.withholdAllEquity).toBe(false);
    expect(scope.reasons.join(' ')).toContain('TDIC');

    const { equityRealizedByDate, realizedByDate } = realizedPnlByCloseDate(tdicTape, {
      includeEquity: true,
      excludeSymbols: scope.excludeSymbols,
    });
    // The corrupt day is gone...
    expect(equityRealizedByDate.has('2026-06-20')).toBe(false);
    expect(realizedByDate.has('2026-06-20')).toBe(false);
    // ...and the quarantine is SCOPED: the other tickers still tie out. A
    // window-wide withhold would have taken the 06-16 tie-out down with it.
    expect(realizedByDate.get('2026-06-16')).toBeCloseTo(-162.35, 2);
    expect(equityRealizedByDate.get('2026-06-09')).toBeCloseTo(-10.37, 2);
  });

  it('withholds ALL equity when an action cannot be pinned to a ticker', () => {
    // Tradier owns this description string and is free to change it. When the
    // ticker is not in it, the honest answer is "some equity book in this
    // window is wrong and I cannot say which", not "carry on".
    const opaque = { ...split, description: 'MANDATORY REORGANIZATION' };
    const scope = equitySymbolsInvalidatedByCorporateActions([opaque], tdicTape);
    expect(scope.withholdAllEquity).toBe(true);
    expect(scope.excludeSymbols.size).toBe(0);
    expect(scope.reasons.join(' ')).toContain('all equity withheld');
  });

  it('withholds ALL equity when the description is ambiguous', () => {
    const ambiguous = { ...split, description: 'SPINOFF - TDIC / MIR' };
    const scope = equitySymbolsInvalidatedByCorporateActions([ambiguous], tdicTape);
    expect(scope.withholdAllEquity).toBe(true);
  });

  it('says nothing when the window holds no corporate action', () => {
    const scope = equitySymbolsInvalidatedByCorporateActions([], LIVE_TRADIER_TAPE);
    expect(scope.withholdAllEquity).toBe(false);
    expect(scope.excludeSymbols.size).toBe(0);
    expect(scope.reasons).toEqual([]);
  });
});

function mkEquity(
  date: string,
  symbol: string,
  quantity: number,
  amount: number,
  transactionId: string,
): TradierTradeHistoryFill {
  return {
    date,
    symbol,
    tradeType: 'equity',
    description: symbol,
    price: Math.abs(amount / quantity),
    quantity,
    amount,
    commission: 0,
    transactionId,
    orderId: null,
  };
}
