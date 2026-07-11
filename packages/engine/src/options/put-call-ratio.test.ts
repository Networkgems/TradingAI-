import { describe, it, expect } from 'vitest';
import {
  computePutCallRatio,
  pcrRegime,
  pcrZScore,
  PCR_DEFAULTS,
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
  it('returns null below the minimum sample size', () => {
    expect(pcrZScore(1.0, [])).toBeNull();
    expect(pcrZScore(1.0, [0.9])).toBeNull();
  });
  it('returns null for a degenerate (zero-σ) sample', () => {
    expect(pcrZScore(1.0, [0.8, 0.8, 0.8])).toBeNull();
  });
  it('computes a positive z for a value above the trailing mean', () => {
    // history mean 1.0, population σ = sqrt(0.25) = 0.5; value 1.5 → z = 1.0
    const z = pcrZScore(1.5, [0.5, 1.5, 0.5, 1.5]);
    expect(z).toBeCloseTo(1.0, 10);
  });
  it('computes a negative z for a value below the trailing mean', () => {
    const z = pcrZScore(0.5, [0.5, 1.5, 0.5, 1.5]);
    expect(z).toBeCloseTo(-1.0, 10);
  });
  it('ignores non-finite history entries', () => {
    const z = pcrZScore(1.5, [0.5, Number.NaN, 1.5, 0.5, 1.5]);
    expect(z).toBeCloseTo(1.0, 10);
  });
});
