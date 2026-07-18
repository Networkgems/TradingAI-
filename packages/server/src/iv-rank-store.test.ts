import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OptionChainRow } from '@trading-app/engine';
import {
  computeIvRank,
  computeIvPercentile,
  recordDailyIv,
  ivRankSync,
  ivPercentileSync,
  initIvRankStore,
  atmIvFromRows,
  setIvStoreFileForTests,
  MIN_IV_SAMPLES,
  type IvSample,
} from './iv-rank-store.js';

const DAY = 86_400_000;
function samples(ivs: number[], startMs: number): IvSample[] {
  return ivs.map((iv, i) => ({ day: new Date(startMs + i * DAY).toISOString().slice(0, 10), iv }));
}

describe('computeIvRank', () => {
  it('returns null below the minimum sample count', () => {
    expect(computeIvRank(samples([0.2, 0.3, 0.4], 0), 0.3)).toBeNull();
  });

  it('ranks current IV between the window min and max', () => {
    const s = samples(
      Array.from({ length: MIN_IV_SAMPLES }, (_, i) => 0.1 + (i / (MIN_IV_SAMPLES - 1)) * 0.3),
      0,
    ); // 0.10 .. 0.40
    expect(computeIvRank(s, 0.1)).toBeCloseTo(0, 6);
    expect(computeIvRank(s, 0.4)).toBeCloseTo(100, 6);
    expect(computeIvRank(s, 0.25)).toBeCloseTo(50, 6);
  });

  it('clamps an out-of-range current IV into [0,100]', () => {
    const s = samples(Array.from({ length: MIN_IV_SAMPLES }, () => 0).map((_, i) => 0.2 + i * 0.01), 0);
    expect(computeIvRank(s, 0.05)).toBe(0);
    expect(computeIvRank(s, 5)).toBe(100);
  });

  it('returns null when the window is flat', () => {
    expect(computeIvRank(samples(Array.from({ length: MIN_IV_SAMPLES }, () => 0.3), 0), 0.3)).toBeNull();
  });
});

describe('computeIvPercentile (TRA-2028)', () => {
  it('returns null below the minimum sample count', () => {
    expect(computeIvPercentile(samples([0.2, 0.3, 0.4], 0), 0.3)).toBeNull();
  });

  it('is the fraction of the window strictly below the current IV, scaled 0-100', () => {
    // 20 samples 0.10..0.29 (0.10 + i*0.01). currentIv 0.20 → 10 below (0.10..0.19).
    const s = samples(Array.from({ length: MIN_IV_SAMPLES }, (_, i) => 0.1 + i * 0.01), 0);
    expect(computeIvPercentile(s, 0.2)).toBeCloseTo(50, 6);
    expect(computeIvPercentile(s, 0.1)).toBeCloseTo(0, 6); // nothing strictly below the min
    expect(computeIvPercentile(s, 1.0)).toBeCloseTo(100, 6); // everything below
  });

  it('is robust to a single outlier high (unlike IV rank)', () => {
    // A cluster near 0.20 with one 1.00 spike: today's 0.25 sits above ~all the
    // cluster → high percentile, but IV RANK is dragged toward 0 by the outlier max.
    const base = Array.from({ length: MIN_IV_SAMPLES - 1 }, () => 0.2);
    const s = samples([...base, 1.0], 0);
    expect(computeIvPercentile(s, 0.25)).toBeCloseTo((19 / 20) * 100, 6);
    expect(computeIvRank(s, 0.25)).toBeLessThan(10); // outlier compresses the rank
  });
});

describe('atmIvFromRows', () => {
  const row = (strike: number, iv: number): OptionChainRow => ({
    optionSymbol: `O${strike}`,
    underlying: 'X',
    optionType: 'call',
    strike,
    expiration: '2026-07-17',
    smvVol: iv,
  });
  it('picks the IV of the strike nearest spot', () => {
    expect(atmIvFromRows([row(90, 0.5), row(100, 0.3), row(110, 0.6)], 101)).toBe(0.3);
  });
  it('returns null with no usable IV', () => {
    expect(atmIvFromRows([{ optionSymbol: 'O', underlying: 'X', optionType: 'put', strike: 100, expiration: '2026-07-17' }], 100)).toBeNull();
  });
});

describe('recordDailyIv + ivRankSync (disk-backed)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iv-store-'));
    setIvStoreFileForTests(join(dir, 'iv-history.json'));
  });
  afterEach(() => {
    setIvStoreFileForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null before the store is loaded', () => {
    expect(ivRankSync('AAA', 0.3)).toBeNull();
  });

  it('records a trailing series and ranks against it after init', async () => {
    const start = Date.parse('2025-06-01T00:00:00Z');
    for (let i = 0; i < MIN_IV_SAMPLES; i++) {
      await recordDailyIv('AAA', 0.1 + (i / (MIN_IV_SAMPLES - 1)) * 0.3, start + i * DAY);
    }
    await initIvRankStore();
    const asOf = start + (MIN_IV_SAMPLES - 1) * DAY;
    expect(ivRankSync('AAA', 0.4, asOf)).toBeCloseTo(100, 4);
    expect(ivRankSync('AAA', 0.1, asOf)).toBeCloseTo(0, 4);
  });

  it('dedupes multiple samples on the same UTC day', async () => {
    const day = Date.parse('2025-06-01T12:00:00Z');
    await recordDailyIv('BBB', 0.2, day);
    await recordDailyIv('BBB', 0.9, day + 1000); // same UTC day → replaces
    await initIvRankStore();
    // Only one sample → below MIN → null, proving no double-count.
    expect(ivRankSync('BBB', 0.5, day)).toBeNull();
  });

  it('ivPercentileSync reads the same store as ivRankSync (TRA-2028)', async () => {
    const start = Date.parse('2025-06-01T00:00:00Z');
    for (let i = 0; i < MIN_IV_SAMPLES; i++) {
      await recordDailyIv('CCC', 0.1 + i * 0.01, start + i * DAY); // 0.10..0.29
    }
    await initIvRankStore();
    const asOf = start + (MIN_IV_SAMPLES - 1) * DAY;
    expect(ivPercentileSync('CCC', 0.2, asOf)).toBeCloseTo(50, 4);
    expect(ivPercentileSync('CCC', 0.05, asOf)).toBeCloseTo(0, 4);
    expect(ivPercentileSync('DDD', 0.2, asOf)).toBeNull(); // uncovered symbol
  });

  it('ivPercentileSync returns null before the store is loaded', () => {
    expect(ivPercentileSync('AAA', 0.3)).toBeNull();
  });
});
