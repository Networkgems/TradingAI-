import { describe, it, expect } from 'vitest';
import {
  findIvRvMispricings,
  realizedVolFromDailyCloses,
  type IvRvMispricingCandidate,
} from './iv-rv-mispricing.js';
import { blackScholesPrice, daysToExpiration } from './black-scholes.js';
import { trailingRealisedVol } from '../vol-kelly-sizer.js';
import type { OptionChainRow } from './otm-mispricing.js';

const NOW = Date.parse('2024-01-15T15:00:00Z');
const EXP = '2024-02-15'; // ~31 DTE — inside the 90-day window
const T = daysToExpiration(EXP, NOW) / 365;
const R = 0.045;
const SPOT = 100;

/**
 * Build a liquid chain row whose mark is the Black-Scholes price at `impliedVol`
 * and whose `smvVol` advertises that same IV. The scanner then compares this
 * mark to a fair value priced at the `realizedVol` baseline the test passes in.
 */
function row(
  strike: number,
  optionType: 'call' | 'put',
  impliedVol: number,
  overrides: Partial<OptionChainRow> = {},
): OptionChainRow {
  const mark = blackScholesPrice({
    spot: SPOT,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: R,
    volatility: impliedVol,
    optionType,
  });
  const halfSpread = mark * 0.02; // 4% spread — inside the 20% gate
  return {
    optionSymbol: `TEST${strike}${optionType[0].toUpperCase()}`,
    underlying: 'TEST',
    optionType,
    strike,
    expiration: EXP,
    bid: mark - halfSpread,
    ask: mark + halfSpread,
    last: mark,
    volume: 500,
    openInterest: 2000,
    smvVol: impliedVol,
    midIv: impliedVol,
    ...overrides,
  };
}

describe('findIvRvMispricings', () => {
  it('flags a contract whose IV is well above realised vol as SELL_PREMIUM', () => {
    const chain = [row(100, 'call', 0.45)];
    const out = findIvRvMispricings(chain, SPOT, 0.25, { now: NOW });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.action).toBe('SELL_PREMIUM');
    expect(c.ivRvRatio).toBeCloseTo(0.45 / 0.25, 6);
    expect(c.mispricingPct).toBeGreaterThan(0.25);
    expect(c.mark).toBeGreaterThan(c.fairValue);
  });

  it('flags a contract whose IV is well below realised vol as BUY_PREMIUM', () => {
    const chain = [row(100, 'call', 0.12)];
    const out = findIvRvMispricings(chain, SPOT, 0.25, { now: NOW });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.action).toBe('BUY_PREMIUM');
    expect(c.ivRvRatio).toBeLessThan(0.7);
    expect(c.mispricingPct).toBeLessThan(-0.25);
    expect(c.mark).toBeLessThan(c.fairValue);
  });

  it('excludes contracts within thresholds by default and includes them with includeFair', () => {
    const chain = [row(100, 'call', 0.27)]; // ratio ~1.08 — not actionable
    expect(findIvRvMispricings(chain, SPOT, 0.25, { now: NOW })).toHaveLength(0);

    const withFair = findIvRvMispricings(chain, SPOT, 0.25, { now: NOW, includeFair: true });
    expect(withFair).toHaveLength(1);
    expect(withFair[0].action).toBe('NONE');
  });

  it('requires BOTH the IV/RV ratio AND the price deviation to fire a signal', () => {
    // Ratio clears the SELL gate (1.4 >= 1.3) but the price gate is widened to
    // 200%, so no deviation here can clear it — must classify NONE.
    const chain = [row(100, 'call', 0.35)];
    const out = findIvRvMispricings(chain, SPOT, 0.25, {
      now: NOW,
      mispricingThresholdPct: 2.0,
      includeFair: true,
    });
    expect(out[0].action).toBe('NONE');
  });

  it('solves implied vol from the mark when smvVol and midIv are absent', () => {
    const chain = [
      row(100, 'call', 0.5, { smvVol: undefined, midIv: undefined }),
    ];
    const out = findIvRvMispricings(chain, SPOT, 0.2, { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe('SELL_PREMIUM');
    // Newton-Raphson should recover the IV the mark was priced at.
    expect(out[0].impliedVol).toBeCloseTo(0.5, 2);
  });

  describe('liquidity & window filters', () => {
    const baseSell = () => row(100, 'call', 0.45);

    it('rejects open interest below the floor', () => {
      const chain = [baseSell()];
      chain[0].openInterest = 500;
      expect(findIvRvMispricings(chain, SPOT, 0.25, { now: NOW })).toHaveLength(0);
    });

    it('rejects volume below the floor', () => {
      const chain = [baseSell()];
      chain[0].volume = 100;
      expect(findIvRvMispricings(chain, SPOT, 0.25, { now: NOW })).toHaveLength(0);
    });

    it('rejects a wide bid/ask spread', () => {
      const chain = [baseSell()];
      const mid = (chain[0].bid! + chain[0].ask!) / 2;
      chain[0].bid = mid * 0.5;
      chain[0].ask = mid * 1.5; // 100% spread
      expect(findIvRvMispricings(chain, SPOT, 0.25, { now: NOW })).toHaveLength(0);
    });

    it('rejects penny-quoted contracts below the mark floor', () => {
      const chain = [row(100, 'call', 0.45)];
      chain[0].bid = 0.04;
      chain[0].ask = 0.06; // mark 0.05 < 0.10 floor
      expect(findIvRvMispricings(chain, SPOT, 0.25, { now: NOW })).toHaveLength(0);
    });

    it('rejects contracts beyond the max-DTE window', () => {
      const chain = [row(100, 'call', 0.45, { expiration: '2024-12-20' })]; // ~340 DTE
      expect(findIvRvMispricings(chain, SPOT, 0.25, { now: NOW })).toHaveLength(0);
    });

    it('rejects expired / zero-DTE contracts', () => {
      const chain = [row(100, 'call', 0.45, { expiration: '2024-01-14' })]; // already past NOW
      expect(findIvRvMispricings(chain, SPOT, 0.25, { now: NOW })).toHaveLength(0);
    });
  });

  it('returns [] on degenerate inputs', () => {
    const chain = [row(100, 'call', 0.45)];
    expect(findIvRvMispricings(chain, 0, 0.25, { now: NOW })).toHaveLength(0);
    expect(findIvRvMispricings(chain, SPOT, 0, { now: NOW })).toHaveLength(0);
    expect(findIvRvMispricings(chain, SPOT, -0.1, { now: NOW })).toHaveLength(0);
    expect(findIvRvMispricings([], SPOT, 0.25, { now: NOW })).toHaveLength(0);
  });

  it('sorts results by score (deviation × liquidity) descending', () => {
    const chain = [
      row(95, 'put', 0.45, { optionSymbol: 'A' }), // milder edge
      row(100, 'call', 0.6, { optionSymbol: 'B' }), // strongest edge
      row(105, 'call', 0.42, { optionSymbol: 'C' }),
    ];
    const out: IvRvMispricingCandidate[] = findIvRvMispricings(chain, SPOT, 0.2, { now: NOW });
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
    // Top result is the highest-scoring candidate.
    expect(out[0].score).toBe(Math.max(...out.map(c => c.score)));
  });
});

describe('realizedVolFromDailyCloses', () => {
  it('matches the shared close-to-close estimator annualised on trading days', () => {
    const closes = [100, 101, 99, 102, 103, 101, 104, 105, 103, 106, 107, 105];
    const expected = trailingRealisedVol(closes, 20, 252);
    expect(realizedVolFromDailyCloses(closes, 20, 252)).toBeCloseTo(expected, 10);
  });

  it('returns null when there are too few closes to estimate', () => {
    expect(realizedVolFromDailyCloses([100], 20)).toBeNull();
    expect(realizedVolFromDailyCloses([], 20)).toBeNull();
  });

  it('produces a positive annualised vol for a moving series', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 2);
    const rv = realizedVolFromDailyCloses(closes, 20, 252);
    expect(rv).not.toBeNull();
    expect(rv!).toBeGreaterThan(0);
  });
});
