import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIQUIDITY_GATE_CONFIG,
  evaluateLiquidityGate,
  type LiquidityGateConfig,
  type LiquidityGateInput,
} from './liquidity-gate.js';

// TRA-1967 — pins the allow / downsize / veto boundary of the pure liquidity gate.

const cfg: LiquidityGateConfig = DEFAULT_LIQUIDITY_GATE_CONFIG;

function buy(partial: Partial<LiquidityGateInput>): LiquidityGateInput {
  return { side: 'buy', bid: 99.9, ask: 100.1, orderQty: 100, ...partial };
}

describe('evaluateLiquidityGate — spread cost', () => {
  it('charges half the spread against the mid, per side', () => {
    // mid 100, ask 100.1 → buy pays 0.1 over mid = 10 bps.
    const r = evaluateLiquidityGate(buy({ bidSize: 100_000, askSize: 100_000 }));
    expect(r.spreadCostBps).toBeCloseTo(10, 6);
    expect(r.action).toBe('allow');
  });

  it('is mid-referenced, so buy and sell pay the same half-spread', () => {
    // mid = midpoint, so crossing to either touch is the same half-spread distance.
    const q = { bid: 99.0, ask: 100.1, orderQty: 1, bidSize: 1e9, askSize: 1e9 } as const;
    const b = evaluateLiquidityGate({ side: 'buy', ...q });
    const s = evaluateLiquidityGate({ side: 'sell', ...q });
    expect(b.spreadCostBps).toBeCloseTo(s.spreadCostBps!, 10);
    // And it uses the ACTUAL touch (not a nominal spread): (100.1-99.55)/99.55.
    expect(b.spreadCostBps).toBeCloseTo((0.55 / 99.55) * 1e4, 6);
  });

  it('vetoes when the spread alone blows the cost ceiling', () => {
    // bid 90 / ask 110 → mid 100, half-spread 10 → 1000 bps ≫ 50 bps ceiling.
    const r = evaluateLiquidityGate(buy({ bid: 90, ask: 110, bidSize: 1e9, askSize: 1e9 }));
    expect(r.action).toBe('veto');
    expect(r.reasons).toEqual(['SPREAD_TOO_WIDE']);
    // Spread veto is size-independent — deep book doesn't rescue it.
    expect(r.sizeFactor).toBe(0);
  });
});

describe('evaluateLiquidityGate — naive impact & downsize', () => {
  it('allows full size when the order is small vs displayed depth', () => {
    // order 100 sh, ask-depth 100k sh → impact ratio 0.001 → ~0.1 bps.
    const r = evaluateLiquidityGate(buy({ orderQty: 100, askSize: 100_000 }));
    expect(r.impactMeasured).toBe(true);
    expect(r.impactBps).toBeCloseTo(100 * (100 / 100_000), 6);
    expect(r.action).toBe('allow');
    expect(r.sizeFactor).toBe(1);
  });

  it('downsizes when the order is large vs depth but the floor still clears', () => {
    // Tight spread (10 bps), impact budget = 40 bps. impactCoeff 100 bps.
    // maxNotional = depth × 0.40. order = depth → factor 0.40 (≥ 0.25 floor) → downsize.
    const r = evaluateLiquidityGate(buy({ orderQty: 1000, askSize: 1000 }));
    expect(r.action).toBe('downsize');
    expect(r.reasons).toEqual(['THIN_BOOK_DOWNSIZE']);
    expect(r.sizeFactor).toBeCloseTo(0.4, 6);
    // Downsized fill sits right at the cost ceiling.
    const downsizedCost = r.spreadCostBps! + r.impactBps! * r.sizeFactor;
    expect(downsizedCost).toBeCloseTo(cfg.maxCostBps, 6);
  });

  it('vetoes when even the min downsize fraction cannot clear the budget', () => {
    // order 100× the depth → factor 0.40/100 = 0.004 ≪ 0.25 floor → veto.
    const r = evaluateLiquidityGate(buy({ orderQty: 100_000, askSize: 1000 }));
    expect(r.action).toBe('veto');
    expect(r.reasons).toEqual(['THIN_BOOK_VETO']);
    expect(r.sizeFactor).toBe(0);
  });

  it('lands exactly on the downsize floor without vetoing', () => {
    // factor exactly minDownsizeFactor (0.25) → still a downsize (>= is inclusive).
    // budget 40 bps, coeff 100 → maxNotional = depth×0.4. Want factor 0.25 → order = depth×0.4/0.25 = depth×1.6.
    const r = evaluateLiquidityGate(buy({ orderQty: 1600, askSize: 1000 }));
    expect(r.action).toBe('downsize');
    expect(r.sizeFactor).toBeCloseTo(0.25, 6);
  });
});

describe('evaluateLiquidityGate — unknown depth (spread-only fallback)', () => {
  it('allows on a clear spread when no size is provided, and flags it unmeasured', () => {
    const r = evaluateLiquidityGate(buy({ orderQty: 100 })); // no bidSize/askSize
    expect(r.impactMeasured).toBe(false);
    expect(r.impactBps).toBeNull();
    expect(r.action).toBe('allow');
    expect(r.totalCostBps).toBeCloseTo(r.spreadCostBps!, 6);
  });

  it('still vetoes a too-wide spread with no depth', () => {
    const r = evaluateLiquidityGate(buy({ bid: 90, ask: 110, orderQty: 100 }));
    expect(r.action).toBe('veto');
    expect(r.reasons).toEqual(['SPREAD_TOO_WIDE']);
  });

  it('treats a non-positive size as unknown depth, not zero impact', () => {
    const r = evaluateLiquidityGate(buy({ orderQty: 100, askSize: 0 }));
    expect(r.impactMeasured).toBe(false);
    expect(r.action).toBe('allow');
  });
});

describe('evaluateLiquidityGate — unusable quotes are total, never throw', () => {
  const bad: Array<[string, Partial<LiquidityGateInput>]> = [
    ['crossed book', { bid: 101, ask: 100 }],
    ['non-finite ask', { ask: Number.NaN }],
    ['non-finite bid', { bid: Number.POSITIVE_INFINITY }],
    ['zero bid', { bid: 0 }],
    ['negative ask', { ask: -1 }],
  ];
  for (const [name, patch] of bad) {
    it(`vetoes on ${name}`, () => {
      const r = evaluateLiquidityGate(buy(patch));
      expect(r.action).toBe('veto');
      expect(r.reasons).toEqual(['UNUSABLE_QUOTE']);
      expect(r.spreadCostBps).toBeNull();
      expect(r.totalCostBps).toBeNull();
      expect(r.sizeFactor).toBe(0);
    });
  }

  it('does not throw on wholly garbage input', () => {
    expect(() =>
      evaluateLiquidityGate({
        side: 'buy',
        bid: Number.NaN,
        ask: Number.NaN,
        orderQty: Number.NaN,
      }),
    ).not.toThrow();
  });
});

describe('evaluateLiquidityGate — config is honoured and echoed', () => {
  it('respects an overridden ceiling', () => {
    // A 10 bps spread that passes the default 50 bps ceiling fails a 5 bps one.
    const r = evaluateLiquidityGate(buy({ bidSize: 1e9, askSize: 1e9 }), {
      ...cfg,
      maxCostBps: 5,
    });
    expect(r.action).toBe('veto');
    expect(r.reasons).toEqual(['SPREAD_TOO_WIDE']);
  });

  it('echoes the applied config on the result', () => {
    const custom: LiquidityGateConfig = { maxCostBps: 30, impactCoeffBps: 80, minDownsizeFactor: 0.1 };
    const r = evaluateLiquidityGate(buy({ askSize: 1000 }), custom);
    expect(r.config).toEqual(custom);
  });

  it('a looser floor turns a would-be veto into a downsize', () => {
    const input = buy({ orderQty: 100_000, askSize: 1000 });
    expect(evaluateLiquidityGate(input).action).toBe('veto');
    const loose = evaluateLiquidityGate(input, { ...cfg, minDownsizeFactor: 0.001 });
    expect(loose.action).toBe('downsize');
  });
});
