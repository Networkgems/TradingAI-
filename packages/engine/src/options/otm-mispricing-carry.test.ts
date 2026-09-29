import { describe, it, expect } from 'vitest';
import {
  findMispricedOtmContracts,
  parityImpliedCarry,
  type OptionChainRow,
} from './otm-mispricing.js';
import { blackScholesPrice, daysToExpiration } from './black-scholes.js';

// TRA-OTM-UNBLOCK — parity-implied carry + executable mispricing basis.

const NOW = Date.parse('2024-01-15T15:00:00Z');
const EXP = '2024-02-15';
const T = daysToExpiration(EXP, NOW) / 365;
const R = 0.045;
const SIGMA = 0.3;
const SPOT = 100;
const Q = 0.04; // a 4% dividend payer — the case q = 0 misprices

function row(
  strike: number,
  optionType: 'call' | 'put',
  q: number,
  opts: { bias?: number; halfSpreadPct?: number } = {},
): OptionChainRow {
  const theo = blackScholesPrice({
    spot: SPOT,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: R,
    volatility: SIGMA,
    optionType,
    dividendYield: q,
  });
  const mark = Math.max(0.05, theo * (1 + (opts.bias ?? 0)));
  const half = mark * (opts.halfSpreadPct ?? 0.02);
  return {
    optionSymbol: `T${strike}${optionType[0].toUpperCase()}`,
    underlying: 'T',
    optionType,
    strike,
    expiration: EXP,
    bid: mark - half,
    ask: mark + half,
    last: mark,
    volume: 500,
    openInterest: 1000,
    smvVol: SIGMA,
    midIv: SIGMA,
  };
}

function fairChain(q: number): OptionChainRow[] {
  const out: OptionChainRow[] = [];
  for (const k of [90, 95, 100, 105, 110]) {
    out.push(row(k, 'call', q), row(k, 'put', q));
  }
  return out;
}

describe('parityImpliedCarry', () => {
  it('recovers the dividend yield a fairly priced chain was built with', () => {
    const q = parityImpliedCarry(fairChain(Q), SPOT, T, R);
    expect(q).not.toBeNull();
    expect(q!).toBeCloseTo(Q, 3);
  });

  it('returns ~0 on a non-dividend chain', () => {
    expect(parityImpliedCarry(fairChain(0), SPOT, T, R)!).toBeCloseTo(0, 3);
  });

  it('returns null when no strike has both legs quoted', () => {
    const calls = fairChain(Q).filter((r) => r.optionType === 'call');
    expect(parityImpliedCarry(calls, SPOT, T, R)).toBeNull();
  });

  it('returns null (falls back) on an absurd implied carry', () => {
    const broken = fairChain(0).map((r) =>
      r.optionType === 'call' ? { ...r, bid: 0.01, ask: 0.02 } : r,
    );
    expect(parityImpliedCarry(broken, SPOT, T, R)).toBeNull();
  });
});

describe('findMispricedOtmContracts — impliedCarry', () => {
  it('LEGACY (q=0) reads a fairly priced dividend chain as cheap calls / expensive puts', () => {
    // This is the side bias the fix removes: nothing here is mispriced.
    const res = findMispricedOtmContracts(fairChain(Q), SPOT, {
      now: NOW,
      mispricingThresholdPct: 0.02,
    });
    const calls = res.filter((c) => c.optionType === 'call');
    const puts = res.filter((c) => c.optionType === 'put');
    expect(calls.every((c) => c.mispricingPct < 0)).toBe(true);
    expect(puts.every((c) => c.mispricingPct > 0)).toBe(true);
  });

  it('with impliedCarry, the same fair chain reads fair on BOTH sides', () => {
    const res = findMispricedOtmContracts(fairChain(Q), SPOT, {
      now: NOW,
      impliedCarry: true,
      mispricingThresholdPct: 0.02,
    });
    expect(res.length).toBeGreaterThan(0);
    for (const c of res) {
      expect(c.carrySource).toBe('parity');
      expect(Math.abs(c.mispricingPct)).toBeLessThan(0.01);
      expect(c.classification).toBe('fair');
    }
  });

  it('default options are byte-identical to legacy (carry fixed at dividendYield)', () => {
    const res = findMispricedOtmContracts(fairChain(Q), SPOT, { now: NOW });
    for (const c of res) {
      expect(c.carrySource).toBe('fixed');
      expect(c.carryUsed).toBe(0);
    }
  });
});

describe('findMispricedOtmContracts — executable basis', () => {
  it('a mid 16% cheap inside a 19%-wide market is NOT cheap on the executable basis', () => {
    const chain = [...fairChain(0)];
    const i = chain.findIndex((r) => r.strike === 110 && r.optionType === 'call');
    chain[i] = row(110, 'call', 0, { bias: -0.16, halfSpreadPct: 0.095 });
    const mid = findMispricedOtmContracts(chain, SPOT, { now: NOW });
    const exe = findMispricedOtmContracts(chain, SPOT, { now: NOW, mispricingBasis: 'executable' });
    expect(mid.find((c) => c.strike === 110 && c.optionType === 'call')!.classification).toBe('cheap');
    const e = exe.find((c) => c.strike === 110 && c.optionType === 'call')!;
    expect(e.edgeVsAskPct!).toBeLessThan(0.15);
    expect(e.classification).toBe('fair');
  });

  it('an ask below theo by more than the threshold IS cheap on the executable basis', () => {
    const chain = [...fairChain(0)];
    const i = chain.findIndex((r) => r.strike === 110 && r.optionType === 'call');
    chain[i] = row(110, 'call', 0, { bias: -0.25, halfSpreadPct: 0.02 });
    const exe = findMispricedOtmContracts(chain, SPOT, { now: NOW, mispricingBasis: 'executable' });
    const e = exe.find((c) => c.strike === 110 && c.optionType === 'call')!;
    expect(e.edgeVsAskPct!).toBeGreaterThan(0.15);
    expect(e.classification).toBe('cheap');
  });
});
