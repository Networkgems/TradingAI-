import { describe, it, expect, vi } from 'vitest';
import { ShortSqueezeScannerService } from './short-squeeze-scanner.js';
import type { ShortInterestFundamentals } from './yahoo-feed.js';
import type { Candle } from '@trading-app/shared';

function hotFundamentals(over: Partial<ShortInterestFundamentals> = {}): ShortInterestFundamentals {
  return {
    symbol: 'GME',
    shortPercentOfFloat: 0.32,
    sharesShort: 12_000_000,
    daysToCover: 7.5,
    floatShares: 40_000_000,
    sharesOutstanding: 55_000_000,
    marketCap: 2_500_000_000,
    averageDailyVolume: 3_000_000,
    shortInterestAsOf: null,
    asOf: 0,
    ...over,
  };
}

// 61 ascending daily bars: closes 8.00→11.00 (price ends above its 50-SMA),
// prior-20 volume avg 1,000,000 with today at 3,000,000 → RVOL 3.0.
function risingBars(count = 61): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const close = 8 + (3 * i) / (count - 1);
    bars.push({
      symbol: 'GME',
      timestamp: i * 86_400_000,
      open: close,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: i === count - 1 ? 3_000_000 : 1_000_000,
    });
  }
  return bars;
}

function makeService(over: Partial<{
  fundamentals: ShortInterestFundamentals | null;
  bars: Candle[];
  now: () => number;
}> = {}) {
  const fetchFundamentals = vi.fn(async () =>
    'fundamentals' in over ? over.fundamentals ?? null : hotFundamentals(),
  );
  const fetchDailyBars = vi.fn(async () => ('bars' in over ? over.bars ?? [] : risingBars()));
  const svc = new ShortSqueezeScannerService({
    fetchFundamentals,
    fetchDailyBars,
    now: over.now,
  });
  return { svc, fetchFundamentals, fetchDailyBars };
}

describe('ShortSqueezeScannerService', () => {
  it('screens a symbol into a qualifying strong candidate', async () => {
    const { svc } = makeService();
    const r = await svc.scan('GME');
    expect(r.reason).toBe('ok');
    expect(r.evaluation).not.toBeNull();
    expect(r.evaluation!.qualifies).toBe(true);
    expect(r.evaluation!.classification).toBe('strong');
  });

  it('derives RVOL and 50-day SMA from the daily bars', async () => {
    const { svc } = makeService();
    const r = await svc.scan('GME');
    expect(r.priceStats!.rvol).toBeCloseTo(3.0, 5);
    expect(r.priceStats!.avgDailyVolume).toBeCloseTo(1_000_000, 5);
    expect(r.priceStats!.price).toBeCloseTo(11, 5);
    // price (11) sits above the 50-day SMA of a rising series.
    expect(r.priceStats!.sma50).toBeLessThan(11);
    expect(r.evaluation!.filters.find((f) => f.key === 'above_sma50')!.pass).toBe(true);
  });

  it('leaves borrow-fee not-applicable on the Yahoo path (no free feed)', async () => {
    const { svc } = makeService();
    const r = await svc.scan('GME');
    const bf = r.evaluation!.filters.find((f) => f.key === 'borrow_fee')!;
    expect(bf.applicable).toBe(false);
    expect(r.evaluation!.missingInputs).toContain('borrow_fee');
  });

  it('returns no_data when both feeds are cold', async () => {
    const { svc } = makeService({ fundamentals: null, bars: [] });
    const r = await svc.scan('ZZZZ');
    expect(r.reason).toBe('no_data');
    expect(r.evaluation).toBeNull();
  });

  it('still screens on bars alone when fundamentals are cold', async () => {
    const { svc } = makeService({ fundamentals: null });
    const r = await svc.scan('GME');
    expect(r.reason).toBe('ok');
    // Short-interest criteria are unknown, so it cannot qualify, but the
    // technical criteria are still judged.
    expect(r.evaluation!.qualifies).toBe(false);
    expect(r.evaluation!.missingInputs).toContain('short_float');
    expect(r.evaluation!.filters.find((f) => f.key === 'rvol')!.applicable).toBe(true);
  });

  it('caches fundamentals within the TTL', async () => {
    let clock = 1_000_000;
    const { svc, fetchFundamentals, fetchDailyBars } = makeService({ now: () => clock });
    await svc.scan('GME');
    clock += 60_000; // 1 min < 15 min TTL
    await svc.scan('GME');
    expect(fetchFundamentals).toHaveBeenCalledTimes(1);
    // Bars are always refetched (they change intraday).
    expect(fetchDailyBars).toHaveBeenCalledTimes(2);
  });

  it('refetches fundamentals after the TTL expires', async () => {
    let clock = 1_000_000;
    const { svc, fetchFundamentals } = makeService({ now: () => clock });
    await svc.scan('GME');
    clock += 16 * 60_000; // past the 15-min TTL
    await svc.scan('GME');
    expect(fetchFundamentals).toHaveBeenCalledTimes(2);
  });

  it('maps a thrown feed error to a typed fetch_error', async () => {
    const fetchFundamentals = vi.fn(async () => { throw new Error('yahoo down'); });
    const fetchDailyBars = vi.fn(async () => risingBars());
    const svc = new ShortSqueezeScannerService({ fetchFundamentals, fetchDailyBars });
    const r = await svc.scan('GME');
    expect(r.reason).toBe('fetch_error');
    expect(r.errorMessage).toContain('yahoo down');
  });

  it('ranks qualifiers above non-qualifiers in a universe scan', async () => {
    const fetchFundamentals = vi.fn(async (symbol: string) =>
      symbol === 'HOT'
        ? hotFundamentals({ symbol: 'HOT' })
        : hotFundamentals({ symbol: 'COLD', shortPercentOfFloat: 0.03, sharesShort: 500_000, daysToCover: 1 }),
    );
    const fetchDailyBars = vi.fn(async () => risingBars());
    const svc = new ShortSqueezeScannerService({ fetchFundamentals, fetchDailyBars });
    const results = await svc.scanUniverse(['COLD', 'HOT']);
    expect(results[0].symbol).toBe('HOT');
    expect(results[0].evaluation!.qualifies).toBe(true);
    expect(results[1].symbol).toBe('COLD');
    expect(results[1].evaluation!.qualifies).toBe(false);
    expect(svc.diagnostics().lastScan).toEqual({ at: expect.any(Number), scanned: 2, qualifiers: 1 });
  });
});
