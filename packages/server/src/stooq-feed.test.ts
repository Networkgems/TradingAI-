import { describe, it, expect } from 'vitest';
import { parseStooqCsv, toStooqSymbol } from './stooq-feed.js';

describe('toStooqSymbol', () => {
  it('lowercases and appends .us suffix for plain tickers', () => {
    expect(toStooqSymbol('AAPL')).toBe('aapl.us');
    expect(toStooqSymbol('SPY')).toBe('spy.us');
  });

  it('replaces dots with dashes for class shares', () => {
    expect(toStooqSymbol('BRK.B')).toBe('brk-b.us');
  });
});

describe('parseStooqCsv', () => {
  it('parses a well-formed quote row', () => {
    const csv = [
      'Symbol,Date,Time,Open,High,Low,Close,Volume',
      'AAPL.US,2026-04-27,15:30:00,180.00,182.50,179.10,181.20,12345678',
    ].join('\n');
    const q = parseStooqCsv(csv);
    expect(q).not.toBeNull();
    expect(q!.price).toBe(181.20);
    expect(q!.volume).toBe(12345678);
    // Intraday change: close (181.20) − open (180.00) = +1.20
    expect(q!.change).toBeCloseTo(1.20, 5);
    expect(q!.changePct).toBeCloseTo((1.20 / 180.00) * 100, 5);
  });

  it('returns null for the N/D sentinel Stooq returns for unknown symbols', () => {
    const csv = [
      'Symbol,Date,Time,Open,High,Low,Close,Volume',
      'BOGUS.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D',
    ].join('\n');
    expect(parseStooqCsv(csv)).toBeNull();
  });

  it('returns null when the body has no data row', () => {
    expect(parseStooqCsv('Symbol,Date,Time,Open,High,Low,Close,Volume')).toBeNull();
    expect(parseStooqCsv('')).toBeNull();
  });

  it('returns null when open is non-positive (would divide by zero)', () => {
    const csv = [
      'Symbol,Date,Time,Open,High,Low,Close,Volume',
      'AAPL.US,2026-04-27,15:30:00,0,0,0,0,0',
    ].join('\n');
    expect(parseStooqCsv(csv)).toBeNull();
  });
});
