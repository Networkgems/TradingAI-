import { describe, it, expect } from 'vitest';
import type { ChainDay } from '@trading-app/backtest';
import type { OptionChainRow } from '@trading-app/engine';
import {
  buildIvSeriesFromChains,
  reconstructIvRankAt,
  isIvArchiveSeedEnabled,
  MAX_IV_STALENESS_DAYS,
} from './iv-rank-archive.js';
import { MIN_IV_SAMPLES, mergeMissingDays, type IvSample } from './iv-rank-store.js';

// TRA-2206 — the reconstruction that back-fills IV-rank for the 81% of the
// resolved cohort the cold trailing-IV store stamped `null`. The property under
// test that actually matters is NO LOOK-AHEAD: a reconstructed rank must be
// computable from partitions dated at/before the idea's surface date, and must
// be *unchanged* by anything recorded afterwards. A contaminated IV-rank would
// be worse than the null it replaces.

function row(strike: number, iv: number, type: 'call' | 'put' = 'call'): OptionChainRow {
  return {
    symbol: `X${strike}${type}`,
    underlying: 'X',
    expiration: '2026-08-21',
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

function day(date: string, symbol: string, iv: number, spot: number | null = 100): ChainDay {
  return {
    date,
    bySymbol: new Map([
      [
        symbol,
        {
          symbol,
          spot,
          recordedAt: Date.parse(`${date}T20:00:00Z`),
          expirations: ['2026-08-21'],
          // Nearest strike to spot=100 carries the IV we want ranked; the far
          // strike exists so `atmIvFromRows` has a real nearest-strike choice.
          rows: [row(100, iv), row(140, iv * 2)],
        },
      ],
    ]),
  };
}

/** A synthetic archive: `n` ascending days whose ATM IV follows `ivAt`. */
function archive(n: number, ivAt: (i: number) => number, symbol = 'AAPL'): ChainDay[] {
  const days: ChainDay[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 5) + i * 86_400_000).toISOString().slice(0, 10);
    days.push(day(d, symbol, ivAt(i)));
  }
  return days;
}

const noSpotEstimate = (): number | null => null;

describe('buildIvSeriesFromChains', () => {
  it('derives one ascending ATM-IV sample per (symbol, partition day)', () => {
    const series = buildIvSeriesFromChains(archive(3, (i) => 0.2 + i * 0.05), noSpotEstimate);
    expect(series.get('AAPL')).toEqual([
      { day: '2026-01-05', iv: 0.2 },
      { day: '2026-01-06', iv: 0.25 },
      { day: '2026-01-07', iv: expect.closeTo(0.3, 10) },
    ]);
  });

  it('dates each sample by the partition it came from, never by anything later', () => {
    const series = buildIvSeriesFromChains(archive(5, () => 0.3), noSpotEstimate);
    const days = (series.get('AAPL') ?? []).map((s) => s.day);
    expect(days).toEqual([...days].sort());
    expect(days.at(-1)).toBe('2026-01-09');
  });

  it('falls back to the spot estimator when the recorder stored no spot', () => {
    const days = [day('2026-01-05', 'MSFT', 0.4, null)];
    expect(buildIvSeriesFromChains(days, noSpotEstimate).get('MSFT')).toBeUndefined();
    expect(buildIvSeriesFromChains(days, () => 100).get('MSFT')).toEqual([
      { day: '2026-01-05', iv: 0.4 },
    ]);
  });

  it('emits no sample — never a fabricated one — when no row carries a usable IV', () => {
    const days: ChainDay[] = [
      {
        date: '2026-01-05',
        bySymbol: new Map([
          [
            'NVDA',
            {
              symbol: 'NVDA',
              spot: 100,
              recordedAt: 0,
              expirations: ['2026-08-21'],
              rows: [{ strike: 100, optionType: 'call' } as unknown as OptionChainRow],
            },
          ],
        ]),
      },
    ];
    expect(buildIvSeriesFromChains(days, noSpotEstimate).size).toBe(0);
  });
});

describe('reconstructIvRankAt — no look-ahead', () => {
  // 30 ascending days of IV climbing 0.20 → 0.49. Ranking on day 20 must see a
  // window topping out at that day's IV, not the series maximum.
  const rising = buildIvSeriesFromChains(
    archive(30, (i) => 0.2 + i * 0.01),
    noSpotEstimate,
  ).get('AAPL') as IvSample[];

  it('ranks a monotonically rising series at 100 on its own last known day', () => {
    // On 2026-01-24 (index 19) the current IV *is* the window max ⇒ rank 100.
    const r = reconstructIvRankAt(rising, '2026-01-24');
    expect(r.ivRank).toBe(100);
    expect(r.miss).toBeNull();
    expect(r.windowSamples).toBe(20);
  });

  it('is UNCHANGED by samples recorded after the surface date', () => {
    const onDate = '2026-01-24';
    const truncated = rising.filter((s) => s.day <= onDate);
    // The full series knows the IV keeps climbing to 0.49; the truncated one does
    // not. If any future sample leaked into the window the two would disagree.
    expect(reconstructIvRankAt(rising, onDate)).toEqual(reconstructIvRankAt(truncated, onDate));
  });

  it('appending future history cannot revise an already-reconstructed rank', () => {
    const onDate = '2026-01-24';
    const before = reconstructIvRankAt(rising, onDate);
    const withFuture = [
      ...rising,
      // A violent post-hoc IV spike — would crush the rank to a low percentile
      // if the window were computed over the whole series.
      { day: '2026-03-01', iv: 5 },
    ];
    expect(reconstructIvRankAt(withFuture, onDate)).toEqual(before);
    expect(before.ivRank).toBe(100);
  });

  it('ranks against the trailing window, reflecting only prior extremes', () => {
    // Flat 0.30 for 24 days, then a dip to 0.10 on day 25, then back to 0.30.
    const samples = buildIvSeriesFromChains(
      archive(30, (i) => (i === 24 ? 0.1 : 0.3)),
      noSpotEstimate,
    ).get('AAPL') as IvSample[];
    // Day index 23 (2026-01-28) — the dip has NOT happened yet, so the window is
    // flat and honestly unrankable.
    expect(reconstructIvRankAt(samples, '2026-01-28').miss).toBe('insufficient_history');
    // Day index 26 (2026-01-31) — the dip is now in the past, so 0.30 ranks at
    // the top of a [0.10, 0.30] range.
    expect(reconstructIvRankAt(samples, '2026-01-31').ivRank).toBe(100);
  });
});

describe('reconstructIvRankAt — honest misses', () => {
  const flat = buildIvSeriesFromChains(archive(30, () => 0.3), noSpotEstimate).get(
    'AAPL',
  ) as IvSample[];
  const rising = buildIvSeriesFromChains(
    archive(30, (i) => 0.2 + i * 0.01),
    noSpotEstimate,
  ).get('AAPL') as IvSample[];

  it('reports no_archive_coverage when the ticker was never recorded', () => {
    expect(reconstructIvRankAt([], '2026-01-24')).toEqual({
      ivRank: null,
      miss: 'no_archive_coverage',
      windowSamples: 0,
    });
  });

  it('reports no_sample_at_or_before when the idea predates the archive', () => {
    expect(reconstructIvRankAt(rising, '2025-12-01').miss).toBe('no_sample_at_or_before');
  });

  it(`reports stale_iv past ${MAX_IV_STALENESS_DAYS} days rather than ranking an old read`, () => {
    // Archive ends 2026-02-03; an idea surfaced weeks later has no fresh IV.
    expect(reconstructIvRankAt(rising, '2026-03-15').miss).toBe('stale_iv');
    // Just inside the staleness bound, it still reconstructs.
    expect(reconstructIvRankAt(rising, '2026-02-06').ivRank).not.toBeNull();
  });

  it('reports insufficient_history below the live path’s sample floor', () => {
    const thin = rising.slice(0, MIN_IV_SAMPLES - 1);
    const r = reconstructIvRankAt(thin, thin.at(-1)?.day as string);
    expect(r.miss).toBe('insufficient_history');
    expect(r.windowSamples).toBe(MIN_IV_SAMPLES - 1);
    // One more sample clears the same floor `ivRankSync` enforces.
    expect(reconstructIvRankAt(rising.slice(0, MIN_IV_SAMPLES), rising[MIN_IV_SAMPLES - 1]!.day)
      .ivRank).not.toBeNull();
  });

  it('reports insufficient_history on a flat window instead of a meaningless 0/100', () => {
    expect(reconstructIvRankAt(flat, '2026-02-03').miss).toBe('insufficient_history');
  });
});

describe('mergeMissingDays', () => {
  it('adds only days the store lacks and never overwrites a live-recorded sample', () => {
    const existing = new Map<string, IvSample[]>([
      ['AAPL', [{ day: '2026-01-05', iv: 0.99 }]],
    ]);
    const archived = new Map<string, IvSample[]>([
      [
        'aapl',
        [
          { day: '2026-01-05', iv: 0.2 }, // collides — the live 0.99 must survive
          { day: '2026-01-06', iv: 0.25 }, // genuine hole — filled
        ],
      ],
    ]);
    const { merged, samplesAdded, symbolsTouched } = mergeMissingDays(existing, archived);
    expect(samplesAdded).toBe(1);
    expect(symbolsTouched).toBe(1);
    expect(merged.get('AAPL')).toEqual([
      { day: '2026-01-05', iv: 0.99 },
      { day: '2026-01-06', iv: 0.25 },
    ]);
  });

  it('is a no-op when the archive adds nothing', () => {
    const existing = new Map<string, IvSample[]>([['AAPL', [{ day: '2026-01-05', iv: 0.2 }]]]);
    const r = mergeMissingDays(existing, new Map([['AAPL', [{ day: '2026-01-05', iv: 0.2 }]]]));
    expect(r.samplesAdded).toBe(0);
    expect(r.symbolsTouched).toBe(0);
  });

  it('keeps the merged series ascending and drops non-positive IVs', () => {
    const existing = new Map<string, IvSample[]>([['X', [{ day: '2026-01-10', iv: 0.3 }]]]);
    const archived = new Map<string, IvSample[]>([
      [
        'X',
        [
          { day: '2026-01-08', iv: 0.2 },
          { day: '2026-01-09', iv: 0 },
          { day: '2026-01-11', iv: 0.4 },
        ],
      ],
    ]);
    const { merged, samplesAdded } = mergeMissingDays(existing, archived);
    expect(samplesAdded).toBe(2);
    expect(merged.get('X')?.map((s) => s.day)).toEqual(['2026-01-08', '2026-01-10', '2026-01-11']);
  });
});

describe('isIvArchiveSeedEnabled', () => {
  it('is OFF by default so a deploy alone changes no live surfacing', () => {
    expect(isIvArchiveSeedEnabled({})).toBe(false);
  });

  it('parses the opt-in allowlist and rejects everything else', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'ON', ' true ']) {
      expect(isIvArchiveSeedEnabled({ ENABLE_IV_RANK_ARCHIVE_SEED: v })).toBe(true);
    }
    for (const v of ['', '0', 'false', 'off', 'no', 'maybe']) {
      expect(isIvArchiveSeedEnabled({ ENABLE_IV_RANK_ARCHIVE_SEED: v })).toBe(false);
    }
  });
});
