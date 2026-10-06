import { describe, it, expect, afterEach } from 'vitest';
import type { ChainDay } from '@trading-app/backtest';
import { realizedVolFromDailyCloses, type OptionChainRow } from '@trading-app/engine';
import {
  buildShortPremiumRetroRows,
  ensureShortPremiumRetroFresh,
  readShortPremiumRetroSync,
  resetShortPremiumRetroForTests,
  RETRO_RV_LOOKBACK_DAYS,
  FWD_REALIZED_VOL_CALENDAR_DAYS,
} from './short-premium-retro.js';
import { MIN_IV_SAMPLES } from './iv-rank-store.js';

// TRA-5241 — the read-only retro emitter TRA-5173 item 3 grades the IVR>=50
// floor with. The properties under test are the three the issue calls
// load-bearing: (1) an incomplete forward window is COMPUTED AND FLAGGED, never
// silently truncated or dropped; (2) a null ivRank row is EMITTED with its
// reason, never dropped (dropping nulls conditions the population on the thing
// being graded); (3) backward statistics at D are unchanged by anything
// recorded after D (no look-ahead).

function row(strike: number, iv: number, type: 'call' | 'put' = 'call'): OptionChainRow {
  return {
    symbol: `X${strike}${type}`,
    underlying: 'X',
    expiration: '2026-12-18',
    strike,
    optionType: type,
    bid: 1,
    ask: 1.2,
    last: 1.1,
    volume: 10,
    openInterest: 100,
    smvVol: iv,
  } as unknown as OptionChainRow;
}

function day(date: string, symbol: string, iv: number, spot: number | null): ChainDay {
  return {
    date,
    bySymbol: new Map([
      [
        symbol,
        {
          symbol,
          spot,
          recordedAt: Date.parse(`${date}T20:00:00Z`),
          expirations: ['2026-12-18'],
          // Nearest strike to spot≈100 carries the IV to be ranked; the far
          // strike exists so `atmIvFromRows` makes a real nearest-strike choice.
          rows: [row(100, iv), row(140, iv * 2)],
        },
      ],
    ]),
  };
}

const dayAt = (i: number): string =>
  new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);

/** `n` consecutive calendar days; IV and spot follow the given series. */
function archive(
  n: number,
  ivAt: (i: number) => number,
  spotAt: (i: number) => number | null = () => 100,
  symbol = 'AAPL',
): ChainDay[] {
  const days: ChainDay[] = [];
  for (let i = 0; i < n; i++) days.push(day(dayAt(i), symbol, ivAt(i), spotAt(i)));
  return days;
}

// Varying IV (never flat) and varying spot (so realised vol is finite-positive).
const iv = (i: number) => 0.2 + 0.005 * i;
const spot = (i: number) => 100 + (i % 2);

const noSpotEstimate = (): number | null => null;

afterEach(() => resetShortPremiumRetroForTests());

describe('buildShortPremiumRetroRows — population and null discipline', () => {
  it('emits one row per (symbol, archive day), nulls preserved with reason codes', () => {
    const n = 5; // below MIN_IV_SAMPLES — every rank is an honest null
    const { rows } = buildShortPremiumRetroRows(archive(n, iv, spot), noSpotEstimate);
    expect(rows).toHaveLength(n);
    for (const r of rows) {
      expect(r.ivRank).toBeNull();
      expect(r.ivRankMiss).toBe('insufficient_history');
      expect(r.ivPercentile).toBeNull();
      expect(r.daysToNextEarnings).toBeNull();
    }
    // Depth grows one sample per day — the row carries the window it was graded on.
    expect(rows.map((r) => r.ivSampleDepth)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a day with no usable spot still emits its row, coded no_spot', () => {
    const days = archive(3, iv, (i) => (i === 2 ? null : spot(i)));
    const { rows } = buildShortPremiumRetroRows(days, noSpotEstimate);
    expect(rows).toHaveLength(3);
    const last = rows[2]!;
    expect(last.spot).toBeNull();
    expect(last.atmIv).toBeNull();
    expect(last.atmIvMiss).toBe('no_spot');
    expect(last.ivRvRatio).toBeNull();
    expect(last.vrpRealized).toBeNull();
    // The rank still grades off the backward series (previous day, within staleness).
    expect(last.ivRankMiss).toBe('insufficient_history');
  });

  it('publishes rank AND percentile side by side off the same window once depth clears the floor', () => {
    const n = MIN_IV_SAMPLES + 20;
    const { rows } = buildShortPremiumRetroRows(archive(n, iv, spot), noSpotEstimate);
    const last = rows[rows.length - 1]!;
    expect(last.ivSampleDepth).toBeGreaterThanOrEqual(MIN_IV_SAMPLES);
    // IV is strictly increasing ⇒ the newest sample tops its window.
    expect(last.ivRank).toBeCloseTo(100, 6);
    expect(last.ivRankMiss).toBeNull();
    expect(last.ivPercentile).toBeCloseTo(((n - 1) / n) * 100, 6);
  });
});

describe('buildShortPremiumRetroRows — the scanner-definition IV/RV and the forward outcome', () => {
  it('realizedVol is realizedVolFromDailyCloses over archive closes <= D, and ivRvRatio divides the ATM IV by it', () => {
    const n = 30;
    const { rows } = buildShortPremiumRetroRows(archive(n, iv, spot), noSpotEstimate);
    const last = rows[n - 1]!;
    const closes = Array.from({ length: n }, (_, i) => spot(i));
    const expected = realizedVolFromDailyCloses(closes, RETRO_RV_LOOKBACK_DAYS);
    expect(expected).not.toBeNull();
    expect(last.realizedVol).toBeCloseTo(expected!, 12);
    expect(last.realizedVolCloseCount).toBe(n);
    expect(last.atmIv).toBeCloseTo(iv(n - 1), 12);
    expect(last.ivRvRatio).toBeCloseTo(iv(n - 1) / expected!, 12);
  });

  it('computes the forward 30d realised vol and vrpRealized on a complete window', () => {
    const n = 40;
    const { rows } = buildShortPremiumRetroRows(archive(n, iv, spot), noSpotEstimate);
    const first = rows[0]!; // D+30 = day index 30 <= day index 39 ⇒ complete
    expect(first.fwdWindowComplete).toBe(true);
    expect(first.fwdCloseCount).toBe(FWD_REALIZED_VOL_CALENDAR_DAYS);
    const fwdCloses = Array.from({ length: FWD_REALIZED_VOL_CALENDAR_DAYS + 1 }, (_, i) => spot(i));
    const expected = realizedVolFromDailyCloses(fwdCloses, fwdCloses.length, 252);
    expect(first.fwdRealizedVol30).toBeCloseTo(expected!, 12);
    expect(first.vrpRealized).toBeCloseTo(iv(0) - expected!, 12);
  });

  it('an incomplete forward window is COMPUTED over what exists and FLAGGED, never dropped or padded', () => {
    const n = 40;
    const { rows } = buildShortPremiumRetroRows(archive(n, iv, spot), noSpotEstimate);
    // Day 35 of 40: only 4 forward closes exist — the row must carry an honest
    // partial-window estimate plus fwdWindowComplete:false, NOT a null and NOT
    // a value presented as complete.
    const partial = rows[35]!;
    expect(partial.fwdWindowComplete).toBe(false);
    expect(partial.fwdCloseCount).toBe(4);
    expect(partial.fwdRealizedVol30).not.toBeNull();
    // The very last day has no forward closes at all ⇒ null, still flagged.
    const last = rows[n - 1]!;
    expect(last.fwdWindowComplete).toBe(false);
    expect(last.fwdCloseCount).toBe(0);
    expect(last.fwdRealizedVol30).toBeNull();
    expect(last.vrpRealized).toBeNull();
  });

  it('NO LOOK-AHEAD: backward statistics at D are unchanged by partitions recorded after D', () => {
    const short = buildShortPremiumRetroRows(archive(35, iv, spot), noSpotEstimate).rows;
    const long = buildShortPremiumRetroRows(archive(45, iv, spot), noSpotEstimate).rows;
    const byDay = new Map(long.map((r) => [r.day, r]));
    for (const r of short) {
      const extended = byDay.get(r.day)!;
      expect(extended.ivRank).toEqual(r.ivRank);
      expect(extended.ivPercentile).toEqual(r.ivPercentile);
      expect(extended.realizedVol).toEqual(r.realizedVol);
      expect(extended.atmIv).toEqual(r.atmIv);
      expect(extended.ivRvRatio).toEqual(r.ivRvRatio);
      expect(extended.ivSampleDepth).toEqual(r.ivSampleDepth);
      // The forward fields are ALLOWED to differ — they are the outcome, not
      // the signal, and more archive legitimately completes more windows.
    }
  });
});

describe('cached read surface', () => {
  it('reads pending before the first walk, ready after, with provenance and the earnings disclosure', async () => {
    resetShortPremiumRetroForTests(async () => archive(25, iv, spot), 'injected-chains-dir');
    const before = readShortPremiumRetroSync();
    expect(before.status).toBe('pending');
    expect(before.retro).toBeNull();

    await ensureShortPremiumRetroFresh();
    const after = readShortPremiumRetroSync();
    expect(after.status).toBe('ready');
    expect(after.computeError).toBeNull();
    expect(after.retro!.chainsDir).toBe('injected-chains-dir');
    expect(after.retro!.rowCount).toBe(25);
    expect(after.retro!.symbolCount).toBe(1);
    expect(after.retro!.newestPartitionDay).toBe(dayAt(24));
    expect(after.retro!.minSamples).toBe(MIN_IV_SAMPLES);
    expect(after.retro!.earningsBasis).toBe('no_dated_earnings_series_on_host');
    expect(after.retro!.rows.every((r) => r.daysToNextEarnings === null)).toBe(true);
  });

  it('a failed walk lands in computeError, never a fabricated empty retro', async () => {
    resetShortPremiumRetroForTests(async () => {
      throw new Error('disk walk exploded');
    }, 'injected-chains-dir');
    await ensureShortPremiumRetroFresh();
    const read = readShortPremiumRetroSync();
    expect(read.status).toBe('pending');
    expect(read.retro).toBeNull();
    expect(read.computeError).toContain('disk walk exploded');
  });
});
