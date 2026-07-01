import { describe, it, expect } from 'vitest';
import {
  evaluateShortSqueeze,
  DEFAULT_SHORT_SQUEEZE_THRESHOLDS,
  type ShortSqueezeFundamentals,
  type ShortSqueezePriceStats,
} from './short-squeeze.js';

// A textbook squeeze setup that clears every criterion (borrow fee supplied).
function hotFundamentals(over: Partial<ShortSqueezeFundamentals> = {}): ShortSqueezeFundamentals {
  return {
    shortPercentOfFloat: 0.32, // 32% > 20%
    sharesShort: 12_000_000, // > 5M
    daysToCover: 7.5, // > 5
    floatShares: 40_000_000, // < 100M
    sharesOutstanding: 55_000_000,
    marketCap: 2_500_000_000, // < $10B
    borrowFeeRate: 0.45, // 45% > 10%
    ...over,
  };
}

function hotPrice(over: Partial<ShortSqueezePriceStats> = {}): ShortSqueezePriceStats {
  return {
    price: 12.5,
    avgDailyVolume: 3_000_000, // > 500k
    rvol: 2.4, // > 1.0
    sma50: 10.0, // price above SMA50
    ...over,
  };
}

describe('evaluateShortSqueeze', () => {
  it('classifies a textbook squeeze as strong and qualifying', () => {
    const r = evaluateShortSqueeze('GME', hotFundamentals(), hotPrice());
    expect(r.qualifies).toBe(true);
    expect(r.classification).toBe('strong');
    expect(r.score).toBe(100);
    expect(r.applicableCount).toBe(9); // all nine criteria judged
    expect(r.passedCount).toBe(9);
    expect(r.missingInputs).toEqual([]);
  });

  it('fails the core gate when short float is below threshold', () => {
    const r = evaluateShortSqueeze('AAPL', hotFundamentals({ shortPercentOfFloat: 0.05 }), hotPrice());
    expect(r.qualifies).toBe(false);
    expect(r.filters.find((f) => f.key === 'short_float')!.pass).toBe(false);
    // Still scores > 0 (other criteria pass) but never classifies as a candidate.
    expect(r.classification).toBe('none');
    expect(r.score).toBeGreaterThan(0);
  });

  it('qualifies on days-to-cover alone when shares-short is light (OR gate)', () => {
    const r = evaluateShortSqueeze(
      'XYZ',
      hotFundamentals({ sharesShort: 1_000_000, daysToCover: 9 }),
      hotPrice(),
    );
    expect(r.filters.find((f) => f.key === 'short_interest')!.pass).toBe(false);
    expect(r.filters.find((f) => f.key === 'days_to_cover')!.pass).toBe(true);
    expect(r.qualifies).toBe(true);
  });

  it('does not qualify when neither shares-short nor days-to-cover clears', () => {
    const r = evaluateShortSqueeze(
      'XYZ',
      hotFundamentals({ sharesShort: 1_000_000, daysToCover: 2 }),
      hotPrice(),
    );
    expect(r.qualifies).toBe(false);
  });

  it('fails the momentum leg when RVOL is cold', () => {
    const r = evaluateShortSqueeze('XYZ', hotFundamentals(), hotPrice({ rvol: 0.6 }));
    expect(r.filters.find((f) => f.key === 'rvol')!.pass).toBe(false);
    expect(r.qualifies).toBe(false);
  });

  it('fails the momentum leg when price is below the 50-day SMA', () => {
    const r = evaluateShortSqueeze('XYZ', hotFundamentals(), hotPrice({ price: 9, sma50: 10 }));
    const f = r.filters.find((x) => x.key === 'above_sma50')!;
    expect(f.applicable).toBe(true);
    expect(f.pass).toBe(false);
    expect(r.qualifies).toBe(false);
  });

  it('fails the supply constraint when the float is too large', () => {
    const r = evaluateShortSqueeze('XYZ', hotFundamentals({ floatShares: 500_000_000 }), hotPrice());
    expect(r.filters.find((f) => f.key === 'float_size')!.pass).toBe(false);
    expect(r.qualifies).toBe(false);
  });

  it('marks missing inputs as not-applicable and excludes them from the score', () => {
    const r = evaluateShortSqueeze(
      'XYZ',
      hotFundamentals({ borrowFeeRate: null, marketCap: null }),
      hotPrice(),
    );
    expect(r.missingInputs).toContain('borrow_fee');
    expect(r.missingInputs).toContain('market_cap');
    expect(r.applicableCount).toBe(7);
    // The other 7 all pass → still a perfect score over applicable criteria.
    expect(r.score).toBe(100);
    // Core gate does not depend on borrow fee / market cap, so it still qualifies.
    expect(r.qualifies).toBe(true);
  });

  it('skips the borrow-fee criterion entirely when borrowFeeRate is undefined', () => {
    const f = hotFundamentals();
    delete (f as { borrowFeeRate?: number | null }).borrowFeeRate;
    const r = evaluateShortSqueeze('XYZ', f, hotPrice());
    expect(r.filters.find((x) => x.key === 'borrow_fee')!.applicable).toBe(false);
    expect(r.qualifies).toBe(true);
  });

  it('respects overridden thresholds', () => {
    // Raise the short-float bar above the sample so it now fails.
    const r = evaluateShortSqueeze('XYZ', hotFundamentals({ shortPercentOfFloat: 0.25 }), hotPrice(), {
      thresholds: { minShortPercentOfFloat: 0.3 },
    });
    expect(r.filters.find((f) => f.key === 'short_float')!.pass).toBe(false);
    expect(r.qualifies).toBe(false);
  });

  it('can disable the above-50d-SMA requirement', () => {
    const r = evaluateShortSqueeze('XYZ', hotFundamentals(), hotPrice({ price: 9, sma50: 10 }), {
      thresholds: { requireAboveSma50: false },
    });
    const f = r.filters.find((x) => x.key === 'above_sma50')!;
    expect(f.applicable).toBe(false);
    // Momentum leg now only needs RVOL, which passes → qualifies.
    expect(r.qualifies).toBe(true);
  });

  it('returns score 0 and classification none when nothing is applicable', () => {
    const empty: ShortSqueezeFundamentals = {
      shortPercentOfFloat: null, sharesShort: null, daysToCover: null,
      floatShares: null, sharesOutstanding: null, marketCap: null, borrowFeeRate: null,
    };
    const r = evaluateShortSqueeze('XYZ', empty, { price: null, avgDailyVolume: null, rvol: null, sma50: null });
    expect(r.applicableCount).toBe(0);
    expect(r.score).toBe(0);
    expect(r.classification).toBe('none');
    expect(r.qualifies).toBe(false);
  });

  it('exposes spec-default thresholds', () => {
    expect(DEFAULT_SHORT_SQUEEZE_THRESHOLDS.minShortPercentOfFloat).toBe(0.2);
    expect(DEFAULT_SHORT_SQUEEZE_THRESHOLDS.minDaysToCover).toBe(5);
    expect(DEFAULT_SHORT_SQUEEZE_THRESHOLDS.maxFloatShares).toBe(100_000_000);
    expect(DEFAULT_SHORT_SQUEEZE_THRESHOLDS.maxMarketCap).toBe(10_000_000_000);
    expect(DEFAULT_SHORT_SQUEEZE_THRESHOLDS.minAvgDailyVolume).toBe(500_000);
    expect(DEFAULT_SHORT_SQUEEZE_THRESHOLDS.minRvol).toBe(1.0);
  });
});
