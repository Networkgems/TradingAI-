import { describe, it, expect } from 'vitest';
import { parseShortInterestFundamentals } from './yahoo-feed.js';

describe('parseShortInterestFundamentals', () => {
  it('maps a full Yahoo quoteSummary payload', () => {
    const qs = {
      defaultKeyStatistics: {
        shortPercentOfFloat: 0.2453,
        sharesShort: 12_300_000,
        shortRatio: 6.4,
        floatShares: 41_000_000,
        sharesOutstanding: 60_000_000,
        // Yahoo epoch-SECONDS FINRA settlement date → normalized to ms below.
        dateShortInterest: 1_749_600_000,
      },
      summaryDetail: {
        marketCap: 2_400_000_000,
        averageDailyVolume10Day: 2_750_000,
      },
      price: { marketCap: 2_400_000_000 },
    };
    const r = parseShortInterestFundamentals('GME', qs, 1234);
    expect(r).toEqual({
      symbol: 'GME',
      shortPercentOfFloat: 0.2453,
      sharesShort: 12_300_000,
      daysToCover: 6.4,
      floatShares: 41_000_000,
      sharesOutstanding: 60_000_000,
      marketCap: 2_400_000_000,
      averageDailyVolume: 2_750_000,
      shortInterestAsOf: 1_749_600_000_000,
      asOf: 1234,
    });
  });

  it('unwraps the legacy { raw } field shape', () => {
    const qs = {
      defaultKeyStatistics: { shortPercentOfFloat: { raw: 0.31, fmt: '31.00%' }, sharesShort: { raw: 9_000_000 } },
    };
    const r = parseShortInterestFundamentals('XYZ', qs, 0);
    expect(r.shortPercentOfFloat).toBe(0.31);
    expect(r.sharesShort).toBe(9_000_000);
  });

  it('falls back to price.marketCap and impliedSharesOutstanding', () => {
    const qs = {
      defaultKeyStatistics: { impliedSharesOutstanding: 70_000_000 },
      price: { marketCap: 5_000_000_000 },
    };
    const r = parseShortInterestFundamentals('XYZ', qs, 0);
    expect(r.sharesOutstanding).toBe(70_000_000);
    expect(r.marketCap).toBe(5_000_000_000);
  });

  it('degrades every field to null when modules are missing', () => {
    const r = parseShortInterestFundamentals('XYZ', {}, 42);
    expect(r).toEqual({
      symbol: 'XYZ',
      shortPercentOfFloat: null,
      sharesShort: null,
      daysToCover: null,
      floatShares: null,
      sharesOutstanding: null,
      marketCap: null,
      averageDailyVolume: null,
      shortInterestAsOf: null,
      asOf: 42,
    });
  });

  it('tolerates null / undefined quoteSummary', () => {
    expect(parseShortInterestFundamentals('XYZ', null, 0).marketCap).toBeNull();
    expect(parseShortInterestFundamentals('XYZ', undefined, 0).sharesShort).toBeNull();
  });

  it('ignores non-finite numbers', () => {
    const qs = { summaryDetail: { marketCap: NaN, averageVolume: Infinity } };
    const r = parseShortInterestFundamentals('XYZ', qs, 0);
    expect(r.marketCap).toBeNull();
    expect(r.averageDailyVolume).toBeNull();
  });
});
