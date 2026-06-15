import { describe, it, expect } from 'vitest';
import {
  parseRoutine,
  symbolMatchesFilter,
  formatScan,
  filterLabel,
  type ScanSignalLike,
} from './routine-spec.js';

describe('TRA-851 parseRoutine', () => {
  it('parses "brief me at 8:30" → brief @ 08:30', () => {
    const r = parseRoutine('brief me at 8:30');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.routine.action).toBe('brief');
    expect(r.routine.timeEt).toBe('08:30');
    expect(r.routine.filter).toBeUndefined();
    expect(r.routine.marketDaysOnly).toBe(true);
  });

  it('parses "scan semis daily" → scan @ default with sector filter', () => {
    const r = parseRoutine('scan semis daily');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.routine.action).toBe('scan');
    expect(r.routine.timeEt).toBe('09:30'); // scan default
    expect(r.routine.filter).toEqual({ sector: 'semis' });
  });

  it('parses an explicit uppercase ticker list', () => {
    const r = parseRoutine('scan AAPL, MSFT at 10am');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.routine.action).toBe('scan');
    expect(r.routine.timeEt).toBe('10:00');
    expect(r.routine.filter).toEqual({ symbols: ['AAPL', 'MSFT'] });
  });

  it('does not read lowercase words like "me" as tickers', () => {
    const r = parseRoutine('brief me at 7am');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.routine.filter).toBeUndefined();
    expect(r.routine.timeEt).toBe('07:00');
  });

  it('converts 12h pm times to 24h', () => {
    expect(extract('positions at 4pm')).toBe('16:00');
    expect(extract('status at 12pm')).toBe('12:00');
    expect(extract('status at 12am')).toBe('00:00');
    expect(extract('scan at 3:45pm')).toBe('15:45');
  });

  it('uses an action-specific default time when none is named', () => {
    expect(extract('brief me')).toBe('08:30');
    expect(extract('scan semis')).toBe('09:30');
    expect(extract('status')).toBe('16:05');
    expect(extract('positions')).toBe('16:05');
  });

  it('opts into weekends only when explicitly asked', () => {
    const a = parseRoutine('scan BTC-USD daily');
    const b = parseRoutine('scan BTC-USD including weekends at 9');
    expect(a.ok && a.routine.marketDaysOnly).toBe(true);
    expect(b.ok && b.routine.marketDaysOnly).toBe(false);
  });

  it('rejects a phrase with no recognisable action', () => {
    const r = parseRoutine('do something nice at 8');
    expect(r.ok).toBe(false);
  });

  it('rejects an out-of-range time', () => {
    const r = parseRoutine('brief me at 25:00');
    expect(r.ok).toBe(false);
  });

  it('rejects empty input', () => {
    expect(parseRoutine('').ok).toBe(false);
    expect(parseRoutine(null).ok).toBe(false);
  });
});

function extract(text: string): string | undefined {
  const r = parseRoutine(text);
  return r.ok ? r.routine.timeEt : undefined;
}

describe('TRA-851 symbolMatchesFilter', () => {
  it('an absent filter matches everything', () => {
    expect(symbolMatchesFilter('AAPL', undefined)).toBe(true);
  });

  it('an explicit symbol list matches by exact ticker', () => {
    const f = { symbols: ['AAPL', 'MSFT'] };
    expect(symbolMatchesFilter('aapl', f)).toBe(true);
    expect(symbolMatchesFilter('NVDA', f)).toBe(false);
  });

  it('the "semis" alias matches its curated ticker set', () => {
    expect(symbolMatchesFilter('NVDA', { sector: 'semis' })).toBe(true);
    expect(symbolMatchesFilter('AAPL', { sector: 'semis' })).toBe(false);
  });

  it('a coarse "tech" alias matches via the shared sector bucket', () => {
    expect(symbolMatchesFilter('AAPL', { sector: 'tech' })).toBe(true);
    expect(symbolMatchesFilter('XLF', { sector: 'tech' })).toBe(false);
  });
});

describe('TRA-851 formatScan', () => {
  const sigs: ScanSignalLike[] = [
    { symbol: 'NVDA', side: 'long', type: 'orb', entryPrice: 120.5, timestamp: 3 },
    { symbol: 'AAPL', side: 'short', type: 'bb_fade', entryPrice: 200, timestamp: 2 },
    { symbol: 'AMD', side: 'long', type: 'ichimoku', entryPrice: 150, timestamp: 1 },
  ];

  it('filters to the sector and sorts newest-first', () => {
    const out = formatScan(sigs, { sector: 'semis' });
    expect(out).toContain('NVDA long orb @ 120.50');
    expect(out).toContain('AMD long ichimoku @ 150.00');
    expect(out).not.toContain('AAPL');
    expect(out.indexOf('NVDA')).toBeLessThan(out.indexOf('AMD'));
  });

  it('reports no matches rather than an empty message', () => {
    expect(formatScan([], { sector: 'semis' })).toBe('Scan (semis): no matching signals.');
  });
});

describe('TRA-851 filterLabel', () => {
  it('labels each filter shape', () => {
    expect(filterLabel(undefined)).toBe('all');
    expect(filterLabel({ symbols: ['AAPL', 'MSFT'] })).toBe('AAPL, MSFT');
    expect(filterLabel({ sector: 'semis' })).toBe('semis');
  });
});
