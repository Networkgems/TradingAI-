import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateShortSqueeze,
  DEFAULT_SHORT_SQUEEZE_THRESHOLDS,
  type ShortSqueezeFundamentals,
  type ShortSqueezePriceStats,
} from '@trading-app/engine';
import { recordShortSqueezeCapture } from './short-squeeze-capture-recorder.js';
import type { ShortSqueezeScanResult } from './short-squeeze-scanner.js';
import type { ShortInterestFundamentals } from './yahoo-feed.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'short-squeeze-capture-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const NOW = () => Date.parse('2026-06-30T19:55:00Z');

// A genuine qualifying evaluation (heavy short float + crowded + small float +
// RVOL 3.0 + above SMA) so the persisted row carries a real `filters` array.
function okResult(symbol: string, over: Partial<ShortSqueezePriceStats> = {}): ShortSqueezeScanResult {
  const fundamentals: ShortSqueezeFundamentals = {
    shortPercentOfFloat: 0.32,
    sharesShort: 12_000_000,
    daysToCover: 7.5,
    floatShares: 40_000_000,
    sharesOutstanding: 55_000_000,
    marketCap: 2_500_000_000,
  };
  const priceStats: ShortSqueezePriceStats = {
    price: 11,
    avgDailyVolume: 1_000_000,
    rvol: 3.0,
    sma50: 9.5,
    ...over,
  };
  const evaluation = evaluateShortSqueeze(symbol, fundamentals, priceStats);
  // The scan result carries the raw ShortInterestFundamentals so the recorder can
  // project the discrete rawInputs legs (incl. the FINRA as-of date).
  const rawFundamentals: ShortInterestFundamentals = {
    symbol,
    shortPercentOfFloat: 0.32,
    sharesShort: 12_000_000,
    daysToCover: 7.5,
    floatShares: 40_000_000,
    sharesOutstanding: 55_000_000,
    marketCap: 2_500_000_000,
    averageDailyVolume: 1_000_000,
    shortInterestAsOf: Date.parse('2026-06-15T00:00:00Z'),
    asOf: NOW(),
  };
  return { symbol, evaluation, fundamentals: rawFundamentals, priceStats, reason: 'ok' };
}

describe('recordShortSqueezeCapture', () => {
  it('writes a date-partitioned short-squeeze.json with the full per-criterion filters', async () => {
    const result = await recordShortSqueezeCapture({
      symbols: ['gme', 'AMC'],
      scanUniverse: async () => [okResult('GME'), okResult('AMC', { rvol: 1.2 })],
      outDir: tmpRoot,
      thresholds: DEFAULT_SHORT_SQUEEZE_THRESHOLDS,
      universeSource: 'demo-watchlist:admin',
      now: NOW,
    });

    expect(result.date).toBe('2026-06-30');
    const file = join(tmpRoot, result.date, 'short-squeeze.json');
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    expect(parsed.date).toBe('2026-06-30');
    expect(parsed.universeSource).toBe('demo-watchlist:admin');
    // Capture cut is the shipped permissive RVOL>1.0 (not 1.5).
    expect(parsed.thresholds.minRvol).toBe(1.0);
    expect(parsed.symbols).toHaveLength(2);

    const gme = parsed.symbols.find((s: { symbol: string }) => s.symbol === 'GME');
    expect(gme.outcome).toBe('ok');
    expect(gme.qualifies).toBe(true);
    // Full filters array is persisted — including the RVOL reading + threshold.
    const rvolFilter = gme.filters.find((f: { key: string }) => f.key === 'rvol');
    expect(rvolFilter.value).toBe(3.0);
    expect(rvolFilter.threshold).toBe(1.0);
    expect(rvolFilter.pass).toBe(true);
    expect(typeof gme.passedCount).toBe('number');
    expect(typeof gme.applicableCount).toBe('number');
    expect(Array.isArray(gme.missingInputs)).toBe(true);

    // Discrete raw legs (point-in-time, non-reconstructable) are surfaced for the
    // Step-2 grader — incl. the entry close (forward-MFE denominator) and the
    // FINRA short-interest as-of date.
    expect(gme.scanTs).toBe(NOW());
    expect(gme.rawInputs.price).toBe(11);
    expect(gme.rawInputs.rvol).toBe(3.0);
    expect(gme.rawInputs.sma50).toBe(9.5);
    expect(gme.rawInputs.shortPercentOfFloat).toBe(0.32);
    expect(gme.rawInputs.sharesShort).toBe(12_000_000);
    expect(gme.rawInputs.shortInterestAsOf).toBe(Date.parse('2026-06-15T00:00:00Z'));
    // Forward outcome is unset at capture time — the resolver appends it later.
    expect(gme.forward).toBeNull();
  });

  it('records a no_data result fail-closed with null qualifier fields', async () => {
    const result = await recordShortSqueezeCapture({
      symbols: ['NVDA'],
      scanUniverse: async () => [
        { symbol: 'NVDA', evaluation: null, fundamentals: null, priceStats: null, reason: 'no_data' },
      ],
      outDir: tmpRoot,
      thresholds: DEFAULT_SHORT_SQUEEZE_THRESHOLDS,
      universeSource: 'SHORT_SQUEEZE_WATCHLIST',
      now: NOW,
    });

    const row = result.symbols[0];
    expect(row.outcome).toBe('no_data');
    expect(row.qualifies).toBeNull();
    expect(row.score).toBeNull();
    expect(row.filters).toBeNull();
  });

  it('maps a fetch_error result and preserves the error message', async () => {
    const result = await recordShortSqueezeCapture({
      symbols: ['BAD'],
      scanUniverse: async () => [
        {
          symbol: 'BAD',
          evaluation: null,
          fundamentals: null,
          priceStats: null,
          reason: 'fetch_error',
          errorMessage: 'yahoo 503',
        },
      ],
      outDir: tmpRoot,
      thresholds: DEFAULT_SHORT_SQUEEZE_THRESHOLDS,
      universeSource: 'demo-watchlist:admin',
      now: NOW,
    });

    expect(result.symbols[0].outcome).toBe('fetch_error');
    expect(result.symbols[0].errorMessage).toContain('503');
  });

  it('writes a _meta.json summarising the run', async () => {
    const result = await recordShortSqueezeCapture({
      symbols: ['GME', 'AMC', 'NVDA'],
      scanUniverse: async () => [
        okResult('GME'),
        okResult('AMC', { rvol: 1.2 }),
        { symbol: 'NVDA', evaluation: null, fundamentals: null, priceStats: null, reason: 'no_data' },
      ],
      outDir: tmpRoot,
      thresholds: DEFAULT_SHORT_SQUEEZE_THRESHOLDS,
      universeSource: 'demo-watchlist:admin',
      now: NOW,
    });

    const meta = JSON.parse(readFileSync(join(tmpRoot, result.date, '_meta.json'), 'utf-8'));
    expect(meta.symbolCount).toBe(3);
    expect(meta.ok).toBe(2);
    expect(meta.qualifiers).toBe(2);
    expect(meta.noData).toBe(1);
    expect(meta.errored).toBe(0);
  });
});
