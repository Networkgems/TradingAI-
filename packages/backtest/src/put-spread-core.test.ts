import { describe, it, expect } from 'vitest';
import {
  simulatePutSpreads,
  spreadValue,
  strikeForDelta,
  summarize,
  CORE_RULES,
  CORE_COSTS,
  joinSpyVix,
  type DailyBar,
} from './put-spread-core.js';
import { rng } from './sweep-reclaim-backtest.js';

const DAY = 86_400_000;

function flat(n: number, spot = 500, vix = 18): DailyBar[] {
  return Array.from({ length: n }, (_, i) => ({ ts: i * DAY, close: spot, vix }));
}

describe('pricing helpers', () => {
  it('short strike sits at or beyond the target delta, below spot', () => {
    const k = strikeForDelta(500, 35 / 365, 18, 0.16, 0.03);
    expect(k).toBeLessThan(500);
    expect(k).toBeGreaterThan(450);
  });
  it('spread value is between 0 and width', () => {
    const v = spreadValue(500, 470, 465, 35 / 365, 18);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(5);
  });
});

describe('exit rules', () => {
  it('a calm market takes profit (theta) before the time exit', () => {
    const { trades } = simulatePutSpreads(flat(60), { ...CORE_RULES, maxOpen: 1, entryEveryNDays: 1000 });
    expect(trades).toHaveLength(1);
    expect(['take_profit', 'time_exit']).toContain(trades[0].exitReason);
    expect(trades[0].pnlUsd).toBeGreaterThan(0);
  });

  it('a crash triggers the stop and the loss is bounded by the width', () => {
    const bars = flat(5);
    for (let i = 5; i < 40; i++) bars.push({ ts: i * DAY, close: 500 * (1 - 0.02 * (i - 4)), vix: 45 });
    const { trades } = simulatePutSpreads(bars, { ...CORE_RULES, maxOpen: 1, entryEveryNDays: 1000 });
    expect(trades[0].exitReason).toBe('stop_loss');
    expect(trades[0].pnlUsd).toBeLessThan(0);
    expect(trades[0].pnlUsd).toBeGreaterThanOrEqual(-trades[0].maxRiskUsd - 1);
  });

  it('held to expiry settles at intrinsic', () => {
    const rules = { ...CORE_RULES, maxOpen: 1, entryEveryNDays: 1000, takeProfitFrac: 0.999, stopLossMultiple: 1e9, exitAtDte: -1 };
    const bars = flat(1);
    for (let i = 1; i <= 40; i++) bars.push({ ts: i * DAY, close: 300, vix: 18 }); // deep through both strikes
    const { trades } = simulatePutSpreads(bars, rules);
    expect(trades[0].exitReason).toBe('expiry');
    expect(trades[0].exitDebitPerShare).toBeCloseTo(5);
  });
});

/** GBM with a chosen realised vol; VIX series set to realised vol + premium (vol points). */
function gbm(nDays: number, realisedVol: number, vrpPoints: number, seed: number): DailyBar[] {
  const rand = rng(seed);
  const gauss = () => {
    const u = Math.max(1e-12, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const out: DailyBar[] = [];
  let s = 400;
  const dt = 1 / 252;
  for (let i = 0; i < nDays; i++) {
    s *= Math.exp(-0.5 * realisedVol ** 2 * dt + realisedVol * Math.sqrt(dt) * gauss());
    out.push({ ts: i * (365 / 252) * DAY, close: s, vix: realisedVol * 100 + vrpPoints });
  }
  return out;
}

// The controls run FRICTIONLESS and HOLD-TO-EXPIRY — the purest read of the
// premium — so they test the harness, not the rule set or the cost model.
const PURE_RULES = { ...CORE_RULES, takeProfitFrac: 0.999, stopLossMultiple: 1e9, exitAtDte: -1 };
const NO_COSTS = { ...CORE_COSTS, slippagePerSpread: 0, feePerContractLeg: 0 };
function pooled(rv: number, vrp: number, rules = PURE_RULES, costs = NO_COSTS): number {
  let total = 0;
  for (let seed = 1; seed <= 6; seed++) total += summarize(simulatePutSpreads(gbm(2520, rv, vrp, seed), rules, costs).trades).totalPnlUsd;
  return total;
}

describe('controls — the harness must SEE the premium when it exists and not invent one', () => {
  it('ARM-VRP: implied 4 vol points above realised ⇒ positive', () => {
    expect(pooled(0.15, 4)).toBeGreaterThan(0);
  });
  it('ARM-NEG-VRP: implied 4 points BELOW realised ⇒ negative', () => {
    expect(pooled(0.15, -4)).toBeLessThan(0);
  });
  it('ARM-MONOTONE: more premium ⇒ more P&L', () => {
    expect(pooled(0.15, 8)).toBeGreaterThan(pooled(0.15, 4));
    expect(pooled(0.15, 4)).toBeGreaterThan(pooled(0.15, 0));
  });
  it('ARM-COSTS: costs only ever subtract', () => {
    expect(pooled(0.15, 4, PURE_RULES, CORE_COSTS)).toBeLessThan(pooled(0.15, 4));
  });
});

describe('plumbing', () => {
  it('joins SPY and VIX by calendar day', () => {
    const c = (t: number, x: number) => ({ symbol: 'X', timestamp: t, open: x, high: x, low: x, close: x, volume: 0 });
    const j = joinSpyVix([c(0, 500), c(DAY, 501), c(2 * DAY, 502)], [c(0, 15), c(2 * DAY, 17)]);
    expect(j.map((b) => b.vix)).toEqual([15, 17]);
  });
  it('summary capital and drawdown are coherent', () => {
    const r = summarize(simulatePutSpreads(gbm(1000, 0.15, 3, 9)).trades);
    expect(r.capitalUsd).toBeGreaterThan(0);
    expect(r.maxDrawdownUsd).toBeGreaterThanOrEqual(0);
    expect(r.n).toBeGreaterThan(10);
    expect(CORE_COSTS.slippagePerSpread).toBeGreaterThan(0);
  });
});
