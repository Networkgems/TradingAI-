import { describe, it, expect } from 'vitest';
import {
  computePutCallRatio,
  pcrRegime,
  pcrZScore,
  PCR_DEFAULTS,
  PCR_Z_MIN_SAMPLES,
} from './put-call-ratio.js';
import type { OptionChainRow } from './otm-mispricing.js';

function row(
  optionType: 'call' | 'put',
  strike: number,
  volume: number,
  openInterest: number,
  expiration = '2026-08-21',
): OptionChainRow {
  return {
    optionSymbol: `X${expiration}${optionType[0].toUpperCase()}${strike}`,
    underlying: 'X',
    optionType,
    strike,
    expiration,
    volume,
    openInterest,
  };
}

describe('computePutCallRatio', () => {
  it('aggregates put/call volume and OI into the primary and secondary ratios', () => {
    const rows: OptionChainRow[] = [
      row('put', 100, 300, 500),
      row('put', 95, 300, 500),
      row('call', 105, 400, 1000),
      row('call', 110, 400, 1000),
    ];
    const pcr = computePutCallRatio(rows);
    expect(pcr.putVolume).toBe(600);
    expect(pcr.callVolume).toBe(800);
    expect(pcr.aggregateVolume).toBe(1400);
    expect(pcr.pcrVolume).toBeCloseTo(0.75, 10);
    // OI: 1000 put / 2000 call.
    expect(pcr.pcrOi).toBeCloseTo(0.5, 10);
    expect(pcr.regime).toBe('neutral');
    expect(pcr.contrarian).toBeNull();
    expect(pcr.reason).toBeNull();
    expect(pcr.insufficientLiquidity).toBe(false);
  });

  it('buckets a low ratio bullish and flags the contrarian read bearish', () => {
    // Heavy call flow → PCR 0.5 (< 0.7) → bullish regime, contrarian bearish.
    const rows = [row('put', 100, 200, 10), row('call', 105, 400, 10)];
    const pcr = computePutCallRatio(rows);
    expect(pcr.pcrVolume).toBeCloseTo(0.5, 10);
    expect(pcr.regime).toBe('bullish');
    expect(pcr.contrarian).toBe('bearish');
  });

  it('buckets a high ratio bearish and flags the contrarian read bullish', () => {
    // Heavy put flow → PCR 2.0 (> 1.0) → bearish regime, contrarian bullish.
    const rows = [row('put', 100, 800, 10), row('call', 105, 400, 10)];
    const pcr = computePutCallRatio(rows);
    expect(pcr.pcrVolume).toBeCloseTo(2.0, 10);
    expect(pcr.regime).toBe('bearish');
    expect(pcr.contrarian).toBe('bullish');
  });

  it('nulls the ratio with a reason when aggregate volume is below the floor', () => {
    const rows = [row('put', 100, 100, 50), row('call', 105, 100, 50)];
    const pcr = computePutCallRatio(rows); // 200 < 500 default floor
    expect(pcr.aggregateVolume).toBe(200);
    expect(pcr.insufficientLiquidity).toBe(true);
    expect(pcr.pcrVolume).toBeNull();
    expect(pcr.pcrOi).toBeNull();
    expect(pcr.regime).toBeNull();
    expect(pcr.reason).toMatch(/insufficient_liquidity/);
  });

  it('honours a custom liquidity floor', () => {
    const rows = [row('put', 100, 400, 50), row('call', 105, 400, 50)];
    const pcr = computePutCallRatio(rows, { minAggregateVolume: 100 });
    expect(pcr.insufficientLiquidity).toBe(false);
    expect(pcr.pcrVolume).toBeCloseTo(1.0, 10);
    expect(pcr.regime).toBe('neutral');
  });

  it('returns no_option_rows when nothing contributes', () => {
    const pcr = computePutCallRatio([]);
    expect(pcr.reason).toBe('no_option_rows');
    expect(pcr.pcrVolume).toBeNull();
    expect(pcr.expiriesUsed).toEqual([]);
  });

  it('reports zero_call_volume when the denominator is empty but the floor is met', () => {
    const rows = [row('put', 100, 600, 10), row('call', 105, 0, 0)];
    const pcr = computePutCallRatio(rows);
    expect(pcr.aggregateVolume).toBe(600);
    expect(pcr.pcrVolume).toBeNull();
    expect(pcr.reason).toBe('zero_call_volume');
  });

  it('ignores non-finite / negative volume and OI without poisoning the aggregate', () => {
    const rows: OptionChainRow[] = [
      { ...row('put', 100, 600, 100), volume: Number.NaN },
      row('put', 95, 600, 100),
      { ...row('call', 105, 400, 100), volume: -5 },
      row('call', 110, 400, 100),
    ];
    const pcr = computePutCallRatio(rows);
    expect(pcr.putVolume).toBe(600); // NaN leg dropped
    expect(pcr.callVolume).toBe(400); // negative leg dropped
    expect(pcr.pcrVolume).toBeCloseTo(1.5, 10);
  });

  it('restricts aggregation to the requested expiries and records those used', () => {
    const rows = [
      row('put', 100, 600, 100, '2026-08-21'),
      row('call', 105, 400, 100, '2026-08-21'),
      row('put', 100, 9000, 100, '2026-12-18'),
      row('call', 105, 10, 100, '2026-12-18'),
    ];
    const pcr = computePutCallRatio(rows, { expiries: ['2026-08-21'] });
    expect(pcr.expiriesUsed).toEqual(['2026-08-21']);
    expect(pcr.pcrVolume).toBeCloseTo(1.5, 10);
  });

  it('sorts distinct contributing expiries ascending', () => {
    const rows = [
      row('call', 105, 600, 100, '2026-12-18'),
      row('put', 100, 600, 100, '2026-08-21'),
    ];
    const pcr = computePutCallRatio(rows);
    expect(pcr.expiriesUsed).toEqual(['2026-08-21', '2026-12-18']);
  });
});

describe('pcrRegime', () => {
  it('respects the default cut points', () => {
    expect(pcrRegime(0.69)).toBe('bullish');
    expect(pcrRegime(0.7)).toBe('neutral'); // boundary is inclusive-neutral
    expect(pcrRegime(1.0)).toBe('neutral');
    expect(pcrRegime(1.01)).toBe('bearish');
  });
  it('matches PCR_DEFAULTS', () => {
    expect(PCR_DEFAULTS.bullishBelow).toBe(0.7);
    expect(PCR_DEFAULTS.bearishAbove).toBe(1.0);
    expect(PCR_DEFAULTS.minAggregateVolume).toBe(500);
  });
});

describe('pcrZScore', () => {
  // A 10-sample history alternating 0.5/1.5: mean 1.0, sample σ (n-1) =
  // sqrt(2.5/9) = 0.5270. Population σ would be 0.5 — the old, biased-low basis.
  const TEN = [0.5, 1.5, 0.5, 1.5, 0.5, 1.5, 0.5, 1.5, 0.5, 1.5];
  const SAMPLE_SD = Math.sqrt(2.5 / 9);

  it('returns null below the minimum sample size', () => {
    expect(pcrZScore(1.0, [])).toBeNull();
    expect(pcrZScore(1.0, [0.9])).toBeNull();
  });

  // TRA-1663 — the defect this floor exists to kill. At n=2 the old default
  // emitted a z off a 2-point population σ; both of these used to return a
  // number, and the extremes they manufactured are what a promotion bar that
  // hunts extreme-|z| buckets would have read as edge.
  it('emits NO z until PCR_Z_MIN_SAMPLES trailing sessions exist', () => {
    expect(PCR_Z_MIN_SAMPLES).toBe(10);
    expect(pcrZScore(1.5, [0.5, 1.5])).toBeNull();
    expect(pcrZScore(1.5, TEN.slice(0, 9))).toBeNull();
    expect(pcrZScore(1.5, TEN)).not.toBeNull();
  });

  it('returns null for a degenerate (zero-σ) sample even at a full window', () => {
    expect(pcrZScore(1.0, Array(12).fill(0.8))).toBeNull();
  });

  it('uses the SAMPLE (n-1) σ, not the population σ', () => {
    // Population σ = 0.5 would give z = 1.0; the Bessel-corrected σ gives 0.949.
    // The old basis overstated |z| — exactly the extreme-manufacturing bias.
    const z = pcrZScore(1.5, TEN)!;
    expect(z).toBeCloseTo(0.5 / SAMPLE_SD, 10);
    expect(z).toBeLessThan(1.0);
  });

  it('computes a positive z for a value above the trailing mean', () => {
    expect(pcrZScore(1.5, TEN)!).toBeGreaterThan(0);
  });

  it('computes a negative z for a value below the trailing mean', () => {
    expect(pcrZScore(0.5, TEN)!).toBeCloseTo(-0.5 / SAMPLE_SD, 10);
  });

  it('ignores non-finite history entries', () => {
    // The NaN is dropped, so this is the same 10-sample history as TEN.
    const z = pcrZScore(1.5, [...TEN.slice(0, 5), Number.NaN, ...TEN.slice(5)]);
    expect(z).toBeCloseTo(0.5 / SAMPLE_SD, 10);
  });

  it('a non-finite entry can drop the sample BELOW the floor → null, not a z', () => {
    expect(pcrZScore(1.5, [...TEN.slice(0, 9), Number.NaN])).toBeNull();
  });

  it('never divides by zero when a caller passes a floor below 2', () => {
    expect(pcrZScore(1.5, [0.5], 1)).toBeNull();
    expect(pcrZScore(1.5, [], 0)).toBeNull();
  });
});
