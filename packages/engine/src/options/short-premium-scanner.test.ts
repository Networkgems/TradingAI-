import { describe, it, expect } from 'vitest';
import {
  findShortPremiumStructures,
  type ShortPremiumCandidate,
} from './short-premium-scanner.js';
import { blackScholesPrice, daysToExpiration } from './black-scholes.js';
import type { OptionChainRow } from './otm-mispricing.js';

const NOW = Date.parse('2024-01-15T15:00:00Z');
const EXP = '2024-02-15'; // ~31 DTE — inside the 7–60 day window
const T = daysToExpiration(EXP, NOW) / 365;
const R = 0.045;
const SPOT = 100;

/**
 * A liquid chain row whose mark is the Black-Scholes price at `iv` and whose
 * `smvVol` advertises that same IV (so the scanner's delta/VRP read is exact).
 */
function row(
  strike: number,
  optionType: 'call' | 'put',
  iv: number,
  overrides: Partial<OptionChainRow> = {},
): OptionChainRow {
  const mark = blackScholesPrice({
    spot: SPOT,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: R,
    volatility: iv,
    optionType,
  });
  const halfSpread = Math.max(mark * 0.02, 0.01);
  return {
    optionSymbol: `TEST${strike}${optionType[0]!.toUpperCase()}`,
    underlying: 'TEST',
    optionType,
    strike,
    expiration: EXP,
    bid: mark - halfSpread,
    ask: mark + halfSpread,
    last: mark,
    volume: 500,
    openInterest: 2000,
    smvVol: iv,
    midIv: iv,
    ...overrides,
  };
}

/** A dense strike ladder around spot at a fixed IV — elevated vs the RV baseline. */
function ladder(iv = 0.4): OptionChainRow[] {
  const strikes = [80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120];
  const rows: OptionChainRow[] = [];
  for (const k of strikes) {
    rows.push(row(k, 'put', iv));
    rows.push(row(k, 'call', iv));
  }
  return rows;
}

const RV = 0.25; // VRP positive: IV 0.40 / RV 0.25 = 1.6

function byStructure(out: ShortPremiumCandidate[], s: ShortPremiumCandidate['structure']) {
  return out.find((c) => c.structure === s);
}

describe('findShortPremiumStructures', () => {
  it('builds a defined-risk put credit spread with an in-band short delta', () => {
    const out = findShortPremiumStructures(ladder(), SPOT, RV, { now: NOW, ivRank: 70 });
    const put = byStructure(out, 'put_credit_spread');
    expect(put).toBeDefined();
    // short strike is OTM (below spot) and its wing is further OTM.
    const short = put!.legs.find((l) => l.action === 'sell')!;
    const long = put!.legs.find((l) => l.action === 'buy')!;
    expect(short.strike).toBeLessThan(SPOT);
    expect(long.strike).toBeLessThan(short.strike);
    // short delta in the 0.15–0.30 band.
    expect(put!.shortDelta).toBeGreaterThanOrEqual(0.15);
    expect(put!.shortDelta).toBeLessThanOrEqual(0.3);
    // VRP positive and defined risk.
    expect(put!.ivRvRatio).toBeGreaterThan(1);
    expect(put!.maxLoss).toBeGreaterThan(0);
    expect(put!.netCredit).toBeGreaterThan(0);
    expect(put!.width).toBeCloseTo(short.strike - long.strike, 6);
    // PoP tracks 1 − |shortΔ| (the ~60–70%+ target).
    expect(put!.estPoP).toBeCloseTo(1 - put!.shortDelta, 6);
    expect(put!.estPoP).toBeGreaterThan(0.6);
  });

  it('builds a bear call credit spread and an iron condor', () => {
    const out = findShortPremiumStructures(ladder(), SPOT, RV, { now: NOW, ivRank: 70 });
    const call = byStructure(out, 'call_credit_spread');
    const condor = byStructure(out, 'iron_condor');
    expect(call).toBeDefined();
    const cs = call!.legs.find((l) => l.action === 'sell')!;
    const cl = call!.legs.find((l) => l.action === 'buy')!;
    expect(cs.strike).toBeGreaterThan(SPOT);
    expect(cl.strike).toBeGreaterThan(cs.strike);

    expect(condor).toBeDefined();
    expect(condor!.legs).toHaveLength(4);
    // IC PoP is the joint between-strikes probability, below either single side.
    expect(condor!.estPoP).toBeLessThan(call!.estPoP);
    // IC max loss = wider side − total credit, and stays defined.
    expect(condor!.maxLoss).toBeGreaterThan(0);
    expect(condor!.netCredit).toBeGreaterThan(call!.netCredit);
  });

  it('suppresses the scan when a finite IV-rank below the floor is passed', () => {
    const out = findShortPremiumStructures(ladder(), SPOT, RV, { now: NOW, ivRank: 40 });
    expect(out).toHaveLength(0);
  });

  it('does not gate on rank when IV-rank is unknown (null)', () => {
    const out = findShortPremiumStructures(ladder(), SPOT, RV, { now: NOW, ivRank: null });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.ivRank === null)).toBe(true);
  });

  it('produces nothing when VRP is negative (IV below realised vol)', () => {
    // RV well above the 0.40 chain IV ⇒ IV/RV < 1 ⇒ no short-premium edge.
    const out = findShortPremiumStructures(ladder(), SPOT, 0.6, { now: NOW, ivRank: 70 });
    expect(out).toHaveLength(0);
  });

  it('rejects a spread whose credit is too thin relative to its width', () => {
    const out = findShortPremiumStructures(ladder(), SPOT, RV, {
      now: NOW,
      ivRank: 70,
      minCreditToWidth: 0.99, // impossibly rich requirement
    });
    expect(out).toHaveLength(0);
  });

  it('sorts candidates by score (best expected-value-per-risk first)', () => {
    const out = findShortPremiumStructures(ladder(), SPOT, RV, { now: NOW, ivRank: 70 });
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]!.score).toBeGreaterThanOrEqual(out[i]!.score);
    }
  });
});
