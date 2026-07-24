import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
  MAX_MARKETABLE_HALF_SPREAD_FRAC,
  clampHalfSpreadFrac,
  halfSpreadFracFromQuote,
  marketableMarkPerShare,
  marketableUnrealizedUsd,
  positionSide,
  normalizeMarketableConfig,
} from './marketable-open-mtm.js';

describe('clampHalfSpreadFrac', () => {
  it('passes a sane fraction through', () => {
    expect(clampHalfSpreadFrac(0.134)).toBeCloseTo(0.134, 12);
  });
  it('floors negative / non-finite / zero to 0 (no haircut)', () => {
    expect(clampHalfSpreadFrac(-0.2)).toBe(0);
    expect(clampHalfSpreadFrac(0)).toBe(0);
    expect(clampHalfSpreadFrac(Number.NaN)).toBe(0);
    expect(clampHalfSpreadFrac(Infinity)).toBe(0);
  });
  it('caps a corrupt wide fraction at the max', () => {
    expect(clampHalfSpreadFrac(0.9)).toBe(MAX_MARKETABLE_HALF_SPREAD_FRAC);
  });
});

describe('halfSpreadFracFromQuote', () => {
  it('derives (mid-bid)/mid from a symmetric book', () => {
    // bid 0.90, ask 1.10, mid 1.00 → half-spread 0.10
    expect(halfSpreadFracFromQuote({ bid: 0.9, ask: 1.1, mark: 1.0 })).toBeCloseTo(0.1, 12);
  });
  it('uses the recorded mid even when the book is asymmetric', () => {
    // recorded mid 1.00 but bid 0.80 → mid→bid haircut is 0.20, not (ask−bid)/(2·mid)
    expect(halfSpreadFracFromQuote({ bid: 0.8, ask: 1.3, mark: 1.0 })).toBeCloseTo(0.2, 12);
  });
  it('returns null on a crossed book', () => {
    expect(halfSpreadFracFromQuote({ bid: 1.2, ask: 1.0, mark: 1.1 })).toBeNull();
  });
  it('returns null on non-finite / non-positive mid', () => {
    expect(halfSpreadFracFromQuote({ bid: 0.9, ask: 1.1, mark: 0 })).toBeNull();
    expect(halfSpreadFracFromQuote({ bid: 0.9, ask: 1.1 })).toBeNull();
    expect(halfSpreadFracFromQuote({ bid: Number.NaN, ask: 1.1, mark: 1.0 })).toBeNull();
  });
  it('clamps a wide-book fraction', () => {
    expect(halfSpreadFracFromQuote({ bid: 0.1, ask: 1.9, mark: 1.0 })).toBe(
      MAX_MARKETABLE_HALF_SPREAD_FRAC,
    );
  });
});

describe('marketableMarkPerShare', () => {
  it('longs are valued at the bid via the modeled fraction', () => {
    // mid 2.00, h 0.10 → 1.80
    expect(marketableMarkPerShare({ midPerShare: 2.0, side: 'long', halfSpreadFrac: 0.1 })).toBeCloseTo(
      1.8,
      12,
    );
  });
  it('shorts are valued at the ask via the modeled fraction', () => {
    // mid 2.00, h 0.10 → 2.20 (buy-back is worse for a short)
    expect(marketableMarkPerShare({ midPerShare: 2.0, side: 'short', halfSpreadFrac: 0.1 })).toBeCloseTo(
      2.2,
      12,
    );
  });
  it('defaults to the measured mean fraction when none supplied', () => {
    expect(marketableMarkPerShare({ midPerShare: 1.0, side: 'long' })).toBeCloseTo(
      1 - DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
      12,
    );
  });
  it('an explicit usable quote overrides the model (long → exact bid)', () => {
    expect(
      marketableMarkPerShare({
        midPerShare: 2.0,
        side: 'long',
        halfSpreadFrac: 0.1,
        quote: { bid: 1.55, ask: 2.45, mark: 2.0 },
      }),
    ).toBe(1.55);
  });
  it('an explicit usable quote overrides the model (short → exact ask)', () => {
    expect(
      marketableMarkPerShare({
        midPerShare: 2.0,
        side: 'short',
        quote: { bid: 1.55, ask: 2.45, mark: 2.0 },
      }),
    ).toBe(2.45);
  });
  it('falls back to the model when the quote lacks the needed side', () => {
    // long needs a bid; quote has only ask → model 2.00·(1−0.1)=1.80
    expect(
      marketableMarkPerShare({ midPerShare: 2.0, side: 'long', halfSpreadFrac: 0.1, quote: { ask: 2.4 } }),
    ).toBeCloseTo(1.8, 12);
  });
  it('never returns negative and returns 0 on an unusable mid', () => {
    expect(marketableMarkPerShare({ midPerShare: 0, side: 'long' })).toBe(0);
    expect(marketableMarkPerShare({ midPerShare: Number.NaN, side: 'long' })).toBe(0);
    expect(marketableMarkPerShare({ midPerShare: -1, side: 'long' })).toBe(0);
  });
  it('a zero fraction reproduces the MID exactly (the dark default identity)', () => {
    expect(marketableMarkPerShare({ midPerShare: 3.33, side: 'long', halfSpreadFrac: 0 })).toBe(3.33);
    expect(marketableMarkPerShare({ midPerShare: 3.33, side: 'short', halfSpreadFrac: 0 })).toBe(3.33);
  });
});

describe('positionSide', () => {
  it('treats a covered write as short and everything else as long', () => {
    expect(positionSide({ coveredWrite: 'cash_secured_put' })).toBe('short');
    expect(positionSide({})).toBe('long');
    expect(positionSide({ coveredWrite: undefined })).toBe('long');
  });
});

describe('marketableUnrealizedUsd', () => {
  const base = { premiumPaid: 1.0, currentPremium: 2.0, contracts: 3, contractsRemaining: 3 };

  it('marks a long gain at the bid (haircut vs the mid P&L)', () => {
    // mid P&L = (2.0−1.0)·3·100 = 300. Marketable bid 2.0·(1−0.1)=1.80 → (1.80−1.0)·300 = 240.
    expect(marketableUnrealizedUsd(base, { halfSpreadFrac: 0.1 })).toBeCloseTo(240, 9);
  });
  it('equals the mid P&L when the fraction is 0 (dark identity)', () => {
    expect(marketableUnrealizedUsd(base, { halfSpreadFrac: 0 })).toBeCloseTo(300, 9);
  });
  it('uses contractsRemaining after a partial exit', () => {
    expect(marketableUnrealizedUsd({ ...base, contractsRemaining: 1 }, { halfSpreadFrac: 0.1 })).toBeCloseTo(
      80,
      9,
    );
  });
  it('contributes 0 without a usable mark or basis', () => {
    expect(marketableUnrealizedUsd({ ...base, currentPremium: 0 }, { halfSpreadFrac: 0.1 })).toBe(0);
    expect(marketableUnrealizedUsd({ ...base, premiumPaid: 0 }, { halfSpreadFrac: 0.1 })).toBe(0);
    expect(marketableUnrealizedUsd({ ...base, contractsRemaining: 0 }, { halfSpreadFrac: 0.1 })).toBe(0);
  });
  it('an explicit bid quote is authoritative', () => {
    // exact bid 1.60 → (1.60−1.0)·3·100 = 180
    expect(
      marketableUnrealizedUsd(base, { quote: { bid: 1.6, ask: 2.4, mark: 2.0 } }),
    ).toBeCloseTo(180, 9);
  });
});

describe('normalizeMarketableConfig', () => {
  it('defaults to disabled with the measured fraction', () => {
    expect(normalizeMarketableConfig(undefined)).toEqual({
      enabled: false,
      halfSpreadFrac: DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
    });
  });
  it('coerces enabled to a strict boolean and clamps the fraction', () => {
    expect(normalizeMarketableConfig({ enabled: true, halfSpreadFrac: 0.9 })).toEqual({
      enabled: true,
      halfSpreadFrac: MAX_MARKETABLE_HALF_SPREAD_FRAC,
    });
    // truthy-but-not-true stays false (no accidental arming)
    expect(normalizeMarketableConfig({ enabled: 1 as unknown as boolean }).enabled).toBe(false);
  });
});
