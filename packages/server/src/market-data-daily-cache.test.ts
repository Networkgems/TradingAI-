import { describe, it, expect, beforeEach } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { atr } from '@trading-app/engine';
import {
  getDailyBars,
  setDailyBars,
  getDailyCloses,
  setDailyCloses,
  dailyBarsDepth,
  marketDataDailyCacheSizes,
  marketDataDailyCacheCensusTarget,
  __resetMarketDataDailyCacheForTest,
} from './market-data-daily-cache.js';
import { foldCensus } from './heap-retainer-census.js';

/**
 * TRA-4158 — the shared daily-market-data store.
 *
 * The store exists to delete 68 per-user copies of user-independent market data,
 * and the two things that could go wrong are BOTH silent:
 *
 *  1. a write rule that moves a published number (the OTM entry ATR reads
 *     `atr()` over every candle it is handed, so series DEPTH is not cosmetic);
 *  2. the census losing sight of the container, which reads exactly like a
 *     successful eviction.
 *
 * So both are graded here, each with the control that separates the pass from the
 * failure that looks like it.
 */

function bar(i: number, base = 100): Candle {
  const close = base + (i % 7);
  return {
    symbol: 'AAA',
    timestamp: Date.UTC(2026, 0, 1 + i),
    open: close - 0.5,
    high: close + 1.5,
    low: close - 1.5,
    close,
    volume: 1_000 + i,
  };
}

const series = (n: number, base = 100): Candle[] => Array.from({ length: n }, (_, i) => bar(i, base));

describe('TRA-4158 shared daily market-data store', () => {
  beforeEach(() => {
    __resetMarketDataDailyCacheForTest();
  });

  it('is empty after the test reset — the control for every assertion below', () => {
    setDailyCloses('AAA', [1, 2, 3]);
    setDailyBars('AAA', series(20));
    expect(marketDataDailyCacheSizes()).toEqual({ dailyCloses: 1, dailyBars: 1 });
    __resetMarketDataDailyCacheForTest();
    expect(marketDataDailyCacheSizes()).toEqual({ dailyCloses: 0, dailyBars: 0 });
    expect(getDailyCloses('AAA')).toBeUndefined();
    expect(getDailyBars('AAA')).toBeUndefined();
  });

  it('closes are LAST-WRITER-WINS, including when the newer series is SHORTER', () => {
    // The preserved semantics of the per-engine `dailyCloseCache`. A trailing
    // realised-vol series wants the freshest pull; a short fresh one must be able
    // to replace a long stale one, so this is deliberately NOT deepest-wins.
    setDailyCloses('AAA', [1, 2, 3, 4, 5]);
    setDailyCloses('AAA', [9, 8]);
    expect(getDailyCloses('AAA')).toEqual([9, 8]);
  });

  it('bars refuse a strictly SHALLOWER write and accept an EQUAL-depth refresh', () => {
    const deep = series(260);
    expect(setDailyBars('AAA', deep)).toBe(true);
    expect(dailyBarsDepth('AAA')).toBe(260);

    // The cold `OTM_DAILY_ATR_BARS = 40` pull must not clobber the 260-bar series
    // the technical-snapshot pass maintains.
    expect(setDailyBars('AAA', series(40, 500))).toBe(false);
    expect(dailyBarsDepth('AAA')).toBe(260);
    expect(getDailyBars('AAA')).toBe(deep);

    // …but an ordinary same-depth refresh still lands, or the store would freeze
    // on the first series it ever saw. That is the control that separates
    // "deepest-OR-EQUAL wins" from "first write wins".
    const refreshed = series(260, 700);
    expect(setDailyBars('AAA', refreshed)).toBe(true);
    expect(getDailyBars('AAA')).toBe(refreshed);
  });

  it('the depth rule is load-bearing: 40 and 260 bars yield DIFFERENT ATRs', () => {
    // Wilder smoothing runs over every candle handed in, so the two writers'
    // depths are not interchangeable. This is why the store pins one of them
    // instead of leaving the published `otmAtrInvalidationLevel` dependent on
    // which writer ran last.
    const deep = series(260);
    const shallow = deep.slice(-40);
    const a260 = atr(deep);
    const a40 = atr(shallow);
    expect(a260).not.toBeNull();
    expect(a40).not.toBeNull();
    expect(a260).not.toBeCloseTo(a40 as number, 6);
  });

  it('is keyed only by symbol, so two readers of one symbol see one series', () => {
    // The whole point of the hoist: user-independent data, one copy. Two callers
    // standing in for two per-user engines must observe the same object, not two.
    setDailyBars('AAA', series(60));
    const first = getDailyBars('AAA');
    const second = getDailyBars('AAA');
    expect(first).toBe(second);
    expect(marketDataDailyCacheSizes().dailyBars).toBe(1);
  });

  it('stays VISIBLE to the heap census — the control against a blind instrument', () => {
    // A successful hoist drops `signalEngine.dailyCloseCache` /
    // `signalEngine.otmDailyBarCache` to zero owners, which is byte-identical to
    // the census going blind on them. The replacement rows must appear, with a
    // deep nested sum, or the AC2 plateau proof cannot tell the two apart.
    setDailyCloses('AAA', [1, 2, 3]);
    setDailyCloses('BBB', [4, 5]);
    setDailyBars('AAA', series(30));
    const rows = foldCensus([{ klass: 'marketData', target: marketDataDailyCacheCensusTarget }], { deep: true });
    const byName = new Map(rows.map((r) => [r.name, r]));

    const closes = byName.get('marketData.dailyCloses');
    expect(closes).toBeDefined();
    expect(closes?.kind).toBe('map');
    expect(closes?.entries).toBe(2);
    expect(closes?.nested).toBe(5);

    const bars = byName.get('marketData.dailyBars');
    expect(bars).toBeDefined();
    expect(bars?.entries).toBe(1);
    expect(bars?.nested).toBe(30);
  });
});
