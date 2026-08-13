// TRA-3390 (impl child of TRA-2628) — the ENGINE legs.
//
// AC1 asks that `SymbolState` carry the currency the ADAPTER reported, and that
// an absent currency never resolve to USD. AC4 asks that the entry path decide,
// in code, whether a non-USD row may be sized at all. Both are graded here
// against the real code paths:
//
//   - `applyQuotes` (both branches — the quote branch AND the carry-forward
//     branch, because that second one republishes the previous tick's LEVEL and
//     therefore has to republish its UNIT),
//   - `quoteCurrencyEntryVerdict`, the method both equity entry chokepoints
//     consult.
//
// Fixtures are the live rows from bqb1 build `eb1dcf0c8a6f` pid 73 (2026-08-12).

import { describe, it, expect } from 'vitest';
import { SignalEngine, type SymbolState } from './signal-engine.js';

type QuoteLike = {
  price: number; volume: number; change: number; changePct: number; currency?: string;
};

/** Reach `applyQuotes` and the engine's own `symbolState` map. */
type EngineInternals = {
  applyQuotes(quotes: Map<string, QuoteLike>, activeSymbols: string[]): Map<string, number>;
  symbolState: Map<string, SymbolState>;
  quoteCurrencyEntryVerdict(symbol: string): { allowed: true } | { allowed: false; reason: string };
};

const asInternals = (e: SignalEngine) => e as unknown as EngineInternals;

const quote = (price: number, changePct: number, currency?: string): QuoteLike => ({
  price, volume: 1_000, change: (price * changePct) / 100, changePct,
  ...(currency !== undefined ? { currency } : {}),
});

describe('applyQuotes carries the quote currency (TRA-3390 AC1)', () => {
  it('stamps the adapter-reported currency onto the SymbolState row', () => {
    const engine = asInternals(new SignalEngine());
    engine.applyQuotes(
      new Map<string, QuoteLike>([
        ['005930.KS', quote(255500, -1.2, 'KRW')],
        ['AZN.L', quote(11714, 0.9, 'GBX')],
        ['RHM.DE', quote(1173.8, 0.4, 'EUR')],
        ['AAPL', quote(211.2, 0.6, 'USD')],
      ]),
      ['005930.KS', 'AZN.L', 'RHM.DE', 'AAPL'],
    );
    expect(engine.symbolState.get('005930.KS')?.currency).toBe('KRW');
    expect(engine.symbolState.get('AZN.L')?.currency).toBe('GBX');
    expect(engine.symbolState.get('RHM.DE')?.currency).toBe('EUR');
    // The other direction, so this is not a test that merely proves the field is
    // writable: the USD row is USD, not "some currency".
    expect(engine.symbolState.get('AAPL')?.currency).toBe('USD');
  });

  it('leaves the currency ABSENT when the source reported none — never USD', () => {
    // The Stooq fallback shape. A `?? 'USD'` anywhere on this path would make
    // this row indistinguishable from a genuine US quote, which is the original
    // defect converted from loud to silent.
    const engine = asInternals(new SignalEngine());
    engine.applyQuotes(new Map<string, QuoteLike>([['STOOQROW', quote(12.5, 1.1)]]), ['STOOQROW']);
    const row = engine.symbolState.get('STOOQROW');
    expect(row).toBeDefined();
    expect(row!.currency).toBeUndefined();
    expect(row!.currency).not.toBe('USD');
  });

  it('CARRIES the currency forward on the no-quote branch, with the level it carries', () => {
    const engine = asInternals(new SignalEngine());
    engine.applyQuotes(new Map<string, QuoteLike>([['005930.KS', quote(255500, -1.2, 'KRW')]]), ['005930.KS']);
    // Second pass: the symbol is active but the fetch returned nothing for it, so
    // the branch republishes the previous price. The unit has to come with it.
    engine.applyQuotes(new Map<string, QuoteLike>(), ['005930.KS']);
    const row = engine.symbolState.get('005930.KS')!;
    expect(row.price).toBe(255500);
    expect(row.quoteStatus).not.toBe('ok');
    expect(row.currency, 'the carried level lost its unit').toBe('KRW');
  });

  it('does not invent a currency on the no-quote branch for a row that never had one', () => {
    const engine = asInternals(new SignalEngine());
    engine.applyQuotes(new Map<string, QuoteLike>(), ['NEVERQUOTED']);
    expect(engine.symbolState.get('NEVERQUOTED')?.currency).toBeUndefined();
  });
});

describe('quoteCurrencyEntryVerdict — the AC4 gate, BOTH directions', () => {
  // AC5: "prove it CAN admit a USD signal AND can refuse a non-USD one. A filter
  // that reduces nothing may simply have had nothing to reduce (TRA-2590)."

  it('ADMITS a USD-quoted row', () => {
    const engine = asInternals(new SignalEngine());
    engine.applyQuotes(new Map<string, QuoteLike>([['AAPL', quote(211.2, 0.6, 'USD')]]), ['AAPL']);
    expect(engine.quoteCurrencyEntryVerdict('AAPL')).toEqual({ allowed: true });
  });

  it('REFUSES the live ENR.DE EUR row — the case AC4 was written about', () => {
    const engine = asInternals(new SignalEngine());
    engine.applyQuotes(new Map<string, QuoteLike>([['ENR.DE', quote(165.7, 0.3, 'EUR')]]), ['ENR.DE']);
    const v = engine.quoteCurrencyEntryVerdict('ENR.DE');
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error('unreachable');
    expect(v.reason).toContain('EUR');
  });

  it('REFUSES every live foreign exemplar', () => {
    const engine = asInternals(new SignalEngine());
    const rows: Array<[string, number, string]> = [
      ['005930.KS', 255500, 'KRW'],
      ['AZN.L', 11714, 'GBX'],
      ['2330.TW', 2415, 'TWD'],
      ['RHM.DE', 1173.8, 'EUR'],
      ['DSV.CO', 1365, 'DKK'],
      ['EVO.ST', 738.2, 'SEK'],
    ];
    engine.applyQuotes(
      new Map<string, QuoteLike>(rows.map(([s, p, c]) => [s, quote(p, 0.5, c)])),
      rows.map(([s]) => s),
    );
    for (const [sym] of rows) {
      expect(engine.quoteCurrencyEntryVerdict(sym).allowed, sym).toBe(false);
    }
  });

  it('ADMITS a US ticker the engine has never quoted (no row at all)', () => {
    // The absent-row path must land on the same verdict as an unknown currency,
    // and must not take the US book dark.
    const engine = asInternals(new SignalEngine());
    expect(engine.quoteCurrencyEntryVerdict('AAPL')).toEqual({ allowed: true });
  });

  it('REFUSES a foreign-suffixed ticker the engine has never quoted', () => {
    const engine = asInternals(new SignalEngine());
    expect(engine.quoteCurrencyEntryVerdict('005930.KS').allowed).toBe(false);
  });
});
