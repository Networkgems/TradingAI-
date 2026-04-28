import { describe, it, expect } from 'vitest';
import { findMispricedOtmContracts, type OptionChainRow } from './otm-mispricing.js';
import { blackScholesPrice, daysToExpiration } from './black-scholes.js';

const NOW = Date.parse('2024-01-15T15:00:00Z');
const EXP = '2024-02-15';
// Use the same DTE the scanner uses so theo in the fixture and the scanner agree exactly.
const T = daysToExpiration(EXP, NOW) / 365;
const R = 0.045;
const SIGMA = 0.30;
const SPOT = 100;

function liquidRow(
  strike: number,
  optionType: 'call' | 'put',
  markBias: number,
  overrides: Partial<OptionChainRow> = {},
): OptionChainRow {
  // Build a row whose mark = theo * (1 + markBias). bid/ask kept tight (<5% spread).
  const theo = blackScholesPrice({
    spot: SPOT,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: R,
    volatility: SIGMA,
    optionType,
  });
  const mark = Math.max(0.05, theo * (1 + markBias));
  const halfSpread = mark * 0.02;
  return {
    optionSymbol: `TEST${strike}${optionType.toUpperCase()}`,
    underlying: 'TEST',
    optionType,
    strike,
    expiration: EXP,
    bid: mark - halfSpread,
    ask: mark + halfSpread,
    last: mark,
    volume: 500,
    openInterest: 1000,
    smvVol: SIGMA, // model σ = pricing σ → fair when markBias = 0
    midIv: SIGMA,
    ...overrides,
  };
}

describe('findMispricedOtmContracts', () => {
  it('flags an OTM call whose mark is well above theo as expensive', () => {
    const chain: OptionChainRow[] = [
      liquidRow(110, 'call', 0.30), // 30% above theo
      liquidRow(105, 'call', 0),
      liquidRow(115, 'call', 0),
    ];
    const result = findMispricedOtmContracts(chain, SPOT, { now: NOW });
    const expensive = result.find(r => r.strike === 110);
    expect(expensive).toBeDefined();
    expect(expensive!.classification).toBe('expensive');
    expect(expensive!.mispricingPct).toBeGreaterThan(0.15);
  });

  it('flags a cheap OTM put', () => {
    const chain: OptionChainRow[] = [
      liquidRow(90, 'put', -0.25),
      liquidRow(95, 'put', 0),
    ];
    const result = findMispricedOtmContracts(chain, SPOT, { now: NOW });
    const cheap = result.find(r => r.strike === 90);
    expect(cheap).toBeDefined();
    expect(cheap!.classification).toBe('cheap');
    expect(cheap!.mispricingPct).toBeLessThan(-0.15);
  });

  it('skips ITM contracts', () => {
    const chain: OptionChainRow[] = [
      liquidRow(90, 'call', 0.30),  // ITM call — must be filtered out
      liquidRow(110, 'put', 0.30),  // ITM put — filtered out
    ];
    const result = findMispricedOtmContracts(chain, SPOT, { now: NOW });
    expect(result).toHaveLength(0);
  });

  it('rejects contracts with wide bid-ask spreads', () => {
    const wide = liquidRow(110, 'call', 0.40);
    wide.bid = 0.50;
    wide.ask = 1.50; // 100% spread
    const result = findMispricedOtmContracts([wide], SPOT, { now: NOW });
    expect(result).toHaveLength(0);
  });

  it('rejects contracts with low open interest', () => {
    const illiquid = liquidRow(110, 'call', 0.40, { openInterest: 5 });
    const result = findMispricedOtmContracts([illiquid], SPOT, { now: NOW });
    expect(result).toHaveLength(0);
  });

  it('rejects contracts whose mark is below the dollar floor', () => {
    const penny = liquidRow(150, 'call', 0); // far OTM → very cheap
    penny.bid = 0.01;
    penny.ask = 0.03;
    const result = findMispricedOtmContracts([penny], SPOT, { now: NOW });
    expect(result).toHaveLength(0);
  });

  it('falls back to neighbour midIv smoothing when smvVol is missing', () => {
    const chain: OptionChainRow[] = [
      liquidRow(105, 'call', 0, { smvVol: undefined, midIv: SIGMA }),
      liquidRow(110, 'call', 0.30, { smvVol: undefined, midIv: undefined }),
      liquidRow(115, 'call', 0, { smvVol: undefined, midIv: SIGMA }),
    ];
    const result = findMispricedOtmContracts(chain, SPOT, { now: NOW });
    const target = result.find(r => r.strike === 110);
    expect(target).toBeDefined();
    expect(target!.classification).toBe('expensive');
    expect(target!.ivUsed).toBeCloseTo(SIGMA, 5);
  });

  it('sorts results by absolute mispricing magnitude', () => {
    const chain: OptionChainRow[] = [
      liquidRow(105, 'call', 0.20),
      liquidRow(110, 'call', 0.40),
      liquidRow(115, 'call', -0.30),
    ];
    const result = findMispricedOtmContracts(chain, SPOT, { now: NOW });
    expect(result.map(r => r.strike)).toEqual([110, 115, 105]);
  });

  it('returns an empty list for non-finite spot prices', () => {
    expect(findMispricedOtmContracts([liquidRow(110, 'call', 0.3)], NaN)).toHaveLength(0);
    expect(findMispricedOtmContracts([liquidRow(110, 'call', 0.3)], 0)).toHaveLength(0);
  });

  it('classifies a fairly-priced contract as fair', () => {
    const chain = [liquidRow(110, 'call', 0)];
    const result = findMispricedOtmContracts(chain, SPOT, { now: NOW });
    expect(result[0].classification).toBe('fair');
    expect(Math.abs(result[0].mispricingPct)).toBeLessThan(0.001);
  });
});
