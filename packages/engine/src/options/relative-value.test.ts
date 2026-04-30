import { describe, it, expect } from 'vitest';
import {
  findRelativeValueOpportunities,
  type RelativeValueCandidate,
} from './relative-value.js';
import type { OptionChainRow } from './otm-mispricing.js';
import { blackScholesPrice, daysToExpiration } from './black-scholes.js';

const NOW = Date.parse('2024-01-15T15:00:00Z');
const EXP = '2024-02-15';
const T = daysToExpiration(EXP, NOW) / 365;
const R = 0.045;
const SPOT = 100;

/**
 * Build a same-expiration chain where every contract's mark equals BS-fair at
 * `iv`, with a 4% bid-ask spread and ample liquidity. Pass per-strike `ivOverride`
 * to inject relative-value anomalies (one strike priced off-curve).
 */
function buildChain(
  strikes: number[],
  optionType: 'call' | 'put',
  ivBase: number,
  ivOverrides: Map<number, number> = new Map(),
  rowOverrides: Map<number, Partial<OptionChainRow>> = new Map(),
): OptionChainRow[] {
  return strikes.map((strike) => {
    const iv = ivOverrides.get(strike) ?? ivBase;
    const fair = blackScholesPrice({
      spot: SPOT,
      strike,
      timeToExpiryYears: T,
      riskFreeRate: R,
      volatility: iv,
      optionType,
    });
    const mark = Math.max(0.05, fair);
    const half = mark * 0.02;
    return {
      optionSymbol: `TEST${strike}${optionType.toUpperCase()}`,
      underlying: 'TEST',
      optionType,
      strike,
      expiration: EXP,
      bid: Math.max(0.01, mark - half),
      ask: mark + half,
      last: mark,
      volume: 500,
      openInterest: 1000,
      midIv: iv,
      ...(rowOverrides.get(strike) ?? {}),
    };
  });
}

describe('findRelativeValueOpportunities', () => {
  it('flags an IV outlier well above the fitted skew as expensive', () => {
    const strikes = [85, 90, 95, 100, 105, 110, 115, 120];
    const ivs = new Map<number, number>([
      // ATM bump: the call price still falls monotonically across strikes,
      // so the only signal exposed is the IV residual itself.
      [100, 0.45],
    ]);
    const calls = buildChain(strikes, 'call', 0.30, ivs);
    const result = findRelativeValueOpportunities(calls, SPOT, { now: NOW });

    const flagged = result.find((r) => r.strike === 100 && r.optionType === 'call');
    expect(flagged).toBeDefined();
    expect(flagged!.classification).toBe('expensive');
    expect(flagged!.zScore).toBeGreaterThan(2);
    expect(flagged!.mispricingPct).toBeGreaterThan(0);
    // Anchor strikes around the curve should not be flagged.
    const anchor = result.find((r) => r.strike === 90);
    expect(anchor!.classification).toBe('fair');
  });

  it('flags an IV outlier well below the fitted skew as cheap', () => {
    const strikes = [85, 90, 95, 100, 105, 110, 115];
    const ivs = new Map<number, number>([
      // Mild collapse — keeps the put price monotonically increasing across
      // strikes so the only signal is the IV residual.
      [95, 0.22],
    ]);
    const puts = buildChain(strikes, 'put', 0.30, ivs);
    const result = findRelativeValueOpportunities(puts, SPOT, { now: NOW });

    const cheap = result.find((r) => r.strike === 95 && r.optionType === 'put');
    expect(cheap).toBeDefined();
    expect(cheap!.classification).toBe('cheap');
    expect(cheap!.zScore).toBeLessThan(-2);
    expect(cheap!.mispricingPct).toBeLessThan(0);
  });

  it('flags an adjacent-strike vertical-spread monotonic violation', () => {
    // Build a fair call chain, then bump strike-105 above strike-100 so calls go
    // 100 < 105 in mid, which can never happen in a clean chain.
    const strikes = [90, 95, 100, 105, 110, 115];
    const calls = buildChain(strikes, 'call', 0.30);
    const idx100 = calls.findIndex((c) => c.strike === 100);
    const idx105 = calls.findIndex((c) => c.strike === 105);
    const m100 = (calls[idx100].bid! + calls[idx100].ask!) / 2;
    // Push strike 105 mid 30% ABOVE strike 100 mid — clear monotonic break.
    const newMid = m100 * 1.3;
    calls[idx105].bid = newMid * 0.99;
    calls[idx105].ask = newMid * 1.01;

    const result = findRelativeValueOpportunities(calls, SPOT, { now: NOW });
    const flagged = result.find((r) => r.strike === 105);
    expect(flagged).toBeDefined();
    expect(['monotonic_violation', 'expensive']).toContain(flagged!.classification);
    // The 100-strike neighbour is also part of the violating pair.
    const partner = result.find((r) => r.strike === 100);
    expect(partner!.classification === 'monotonic_violation' || flagged!.classification === 'monotonic_violation').toBe(true);
  });

  it('flags below-intrinsic ITM contracts via the no-arb hard floor', () => {
    const strikes = [80, 85, 90, 95, 100, 105];
    const calls = buildChain(strikes, 'call', 0.30);
    // Force the deep-ITM 80 strike to trade at $5 — far below the ~$20 intrinsic.
    const idx = calls.findIndex((c) => c.strike === 80);
    calls[idx].bid = 4.95;
    calls[idx].ask = 5.05;

    const result = findRelativeValueOpportunities(calls, SPOT, { now: NOW });
    const flagged = result.find((r) => r.strike === 80);
    expect(flagged).toBeDefined();
    expect(flagged!.classification).toBe('below_intrinsic');
  });

  it('rejects rows with wide bid/ask spreads', () => {
    const strikes = [95, 100, 105, 110, 115, 120];
    const calls = buildChain(strikes, 'call', 0.30);
    // Inject a 200% spread on strike 110 — it should be filtered before fit.
    const idx = calls.findIndex((c) => c.strike === 110);
    calls[idx].bid = 0.20;
    calls[idx].ask = 1.20;

    const result = findRelativeValueOpportunities(calls, SPOT, { now: NOW });
    expect(result.find((r) => r.strike === 110)).toBeUndefined();
    // Other strikes still scan normally.
    expect(result.length).toBe(strikes.length - 1);
  });

  it('rejects rows with low open interest', () => {
    const strikes = [90, 95, 100, 105, 110, 115];
    const overrides = new Map<number, Partial<OptionChainRow>>([
      [105, { openInterest: 5 }],
    ]);
    const calls = buildChain(strikes, 'call', 0.30, undefined, overrides);

    const result = findRelativeValueOpportunities(calls, SPOT, { now: NOW });
    expect(result.find((r) => r.strike === 105)).toBeUndefined();
  });

  it('skips groups smaller than minGroupSize', () => {
    const calls = buildChain([95, 100, 105], 'call', 0.30); // 3 < default 5
    const result = findRelativeValueOpportunities(calls, SPOT, { now: NOW });
    expect(result).toHaveLength(0);
  });

  it('falls back to BS-implied IV when neither midIv nor smvVol is present', () => {
    const strikes = [90, 95, 100, 105, 110, 115];
    // Strip explicit IV but keep mark prices at fair-IV levels.
    const overrides = new Map<number, Partial<OptionChainRow>>(
      strikes.map((s) => [s, { midIv: undefined, smvVol: undefined }]),
    );
    const calls = buildChain(strikes, 'call', 0.30, undefined, overrides);
    const result = findRelativeValueOpportunities(calls, SPOT, { now: NOW });
    expect(result.length).toBe(strikes.length);
    for (const c of result) {
      // Implied vol should land near the originating 0.30 ± noise.
      expect(c.ivUsed).toBeGreaterThan(0.20);
      expect(c.ivUsed).toBeLessThan(0.40);
    }
  });

  it('ranks candidates by composite score (anomalies above fair)', () => {
    const strikes = [85, 90, 95, 100, 105, 110, 115, 120];
    const ivs = new Map<number, number>([
      [100, 0.45], // expensive outlier
      [95, 0.20],  // cheap outlier
    ]);
    const calls = buildChain(strikes, 'call', 0.30, ivs);
    const result = findRelativeValueOpportunities(calls, SPOT, { now: NOW });

    expect(result.length).toBeGreaterThan(0);
    // The flagged anomalies should outrank the fair rows.
    const top = result[0];
    expect(top.classification === 'expensive' || top.classification === 'cheap').toBe(true);
    const fairRanks = result.findIndex((c) => c.classification === 'fair');
    if (fairRanks !== -1) {
      const flaggedAbove = result.slice(0, fairRanks).every(
        (c) => c.classification !== 'fair',
      );
      expect(flaggedAbove).toBe(true);
    }
  });

  it('returns empty for an empty chain or non-finite spot', () => {
    expect(findRelativeValueOpportunities([], 100, { now: NOW })).toEqual([]);
    const calls = buildChain([95, 100, 105, 110, 115], 'call', 0.30);
    expect(findRelativeValueOpportunities(calls, NaN, { now: NOW })).toEqual([]);
    expect(findRelativeValueOpportunities(calls, 0, { now: NOW })).toEqual([]);
  });

  it('classifies fairly-priced contracts as fair with |z| < threshold', () => {
    const calls = buildChain([90, 95, 100, 105, 110, 115], 'call', 0.30);
    const result = findRelativeValueOpportunities(calls, SPOT, { now: NOW });
    for (const c of result) {
      expect(c.classification).toBe('fair');
      expect(Math.abs(c.zScore)).toBeLessThan(2);
    }
  });

  it('attaches a non-empty reason string to every non-fair classification', () => {
    const strikes = [85, 90, 95, 100, 105, 110, 115, 120];
    const ivs = new Map<number, number>([[100, 0.45]]);
    const calls = buildChain(strikes, 'call', 0.30, ivs);
    const result = findRelativeValueOpportunities(calls, SPOT, { now: NOW });
    const flagged = result.filter((r: RelativeValueCandidate) => r.classification !== 'fair');
    expect(flagged.length).toBeGreaterThan(0);
    for (const c of flagged) {
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });
});
