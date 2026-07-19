/**
 * TRA-2052 — LEAN data-format encoder tests.
 *
 * These lock the on-disk contract LEAN reads (deci-cent prices, ms-since-
 * midnight minute rows, map/factor sentinels) so a later real Databento pull
 * that plugs into these encoders can't silently emit a format LEAN rejects.
 * The DBN ingestion stubs are asserted to fail loud (operator-gated).
 */
import { describe, it, expect } from 'vitest';
import {
  LEAN_SYMBOL_SET,
  toDeciCents,
  assertValidBar,
  encodeDailyCsv,
  encodeMinuteCsv,
  encodeMapFile,
  encodeFactorFile,
  readDatabentoDaily,
  readDatabentoTrades,
  type EquityBar,
} from './databento-to-lean.js';

const DAY = 86_400_000;
// 2024-01-02 00:00:00 UTC
const D0 = Date.UTC(2024, 0, 2, 0, 0, 0);

function bar(over: Partial<EquityBar> = {}): EquityBar {
  return { timestamp: D0, open: 100, high: 101, low: 99, close: 100.5, volume: 1_000, ...over };
}

describe('LEAN_SYMBOL_SET', () => {
  it('mirrors the equities WATCHLIST and includes SPY/QQQ benchmarks', () => {
    expect(LEAN_SYMBOL_SET.length).toBeGreaterThanOrEqual(20);
    expect(LEAN_SYMBOL_SET).toContain('SPY');
    expect(LEAN_SYMBOL_SET).toContain('QQQ');
  });
});

describe('toDeciCents', () => {
  it('scales dollars to deci-cents and rounds', () => {
    expect(toDeciCents(123.45)).toBe(1_234_500);
    expect(toDeciCents(0)).toBe(0);
    expect(toDeciCents(99.99999)).toBe(1_000_000); // rounds to nearest deci-cent
  });
  it('throws on non-finite / negative', () => {
    expect(() => toDeciCents(NaN)).toThrow();
    expect(() => toDeciCents(-1)).toThrow();
    expect(() => toDeciCents(Infinity)).toThrow();
  });
});

describe('assertValidBar', () => {
  it('accepts a well-formed bar', () => {
    expect(() => assertValidBar(bar())).not.toThrow();
  });
  it('rejects high < low, NaN, negative volume', () => {
    expect(() => assertValidBar(bar({ high: 98, low: 99 }))).toThrow();
    expect(() => assertValidBar(bar({ close: NaN }))).toThrow();
    expect(() => assertValidBar(bar({ volume: -5 }))).toThrow();
  });
});

describe('encodeDailyCsv', () => {
  it('emits sorted deci-cent rows keyed yyyyMMdd 00:00', () => {
    const csv = encodeDailyCsv([
      bar({ timestamp: D0 + DAY, close: 101 }),
      bar({ timestamp: D0 }),
    ]);
    const rows = csv.split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe('20240102 00:00,1000000,1010000,990000,1005000,1000');
    expect(rows[1].startsWith('20240103 00:00,')).toBe(true); // sorted ascending
  });
});

describe('encodeMinuteCsv', () => {
  it('emits ms-since-midnight rows in deci-cents', () => {
    const t = D0 + 9 * 3_600_000 + 30 * 60_000; // 09:30 UTC
    const csv = encodeMinuteCsv([bar({ timestamp: t })]);
    expect(csv).toBe('34200000,1000000,1010000,990000,1005000,1000');
  });
  it('rejects bars spanning more than one UTC day', () => {
    expect(() => encodeMinuteCsv([bar({ timestamp: D0 }), bar({ timestamp: D0 + DAY })])).toThrow();
  });
  it('returns empty string for no bars', () => {
    expect(encodeMinuteCsv([])).toBe('');
  });
});

describe('encodeMapFile', () => {
  it('brackets the window with a first row and a far-future sentinel', () => {
    const csv = encodeMapFile('SPY', D0, { exchange: 'P' });
    const rows = csv.split('\n');
    expect(rows[0]).toBe('20240102,spy,P');
    expect(rows[rows.length - 1]).toBe('20501231,spy,P');
  });
  it('carries an explicit rename row (e.g. SQ→XYZ)', () => {
    const csv = encodeMapFile('XYZ', Date.UTC(2015, 0, 1), {
      exchange: 'N',
      extraRows: ['20250112,sq,N'],
    });
    expect(csv).toContain('20250112,sq,N');
  });
});

describe('encodeFactorFile', () => {
  it('sorts rows and always terminates with the 20501231 sentinel', () => {
    const csv = encodeFactorFile([
      { timestamp: Date.UTC(2020, 5, 1), priceFactor: 0.5, splitFactor: 0.25, referencePrice: 400 },
    ]);
    const rows = csv.split('\n');
    expect(rows[0]).toBe('20200601,0.5,0.25,400');
    expect(rows[rows.length - 1]).toBe('20501231,1,1,0');
  });
  it('collapses to a lone sentinel when there are no corporate actions', () => {
    expect(encodeFactorFile([])).toBe('20501231,1,1,0');
  });
});

describe('Databento ingestion stubs (operator-gated)', () => {
  it('fail loud until an API key is provisioned', () => {
    expect(() => readDatabentoDaily('x.dbn', 'SPY')).toThrow(/operator-gated/);
    expect(() => readDatabentoTrades('x.dbn', 'SPY')).toThrow(/operator-gated/);
  });
});
