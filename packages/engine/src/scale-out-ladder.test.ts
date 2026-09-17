import { describe, it, expect } from 'vitest';
import { scaleOutLadderDecision } from './scale-out-ladder.js';
import { SCALE_OUT_TAKER_FEE_EQUITY } from '@trading-app/shared';

/** A materially higher per-side taker fee (63 bps) used to exercise the feeRate override. */
const HIGH_TAKER_FEE = 0.0063;

describe('scaleOutLadderDecision — TRA-1300 scale-out (take-profit) ladder', () => {
  const base = { side: 'buy' as const, avgEntry: 100, baseQty: 1000 };

  it('fires no rung below the first threshold (+25%)', () => {
    const d = scaleOutLadderDecision({ ...base, currentPrice: 120 }); // +20%
    expect(d.gainPct).toBeCloseTo(0.2, 10);
    expect(d.triggered).toHaveLength(0);
    expect(d.downsideDeferred).toBe(false); // above entry, just not far enough
    expect(d.fullyExited).toBe(false);
  });

  it('fires the +25% rung → sell 10% of base, fee-aware (taker)', () => {
    const d = scaleOutLadderDecision({ ...base, currentPrice: 125 }); // exactly +25%
    expect(d.triggered).toHaveLength(1);
    const t = d.triggered[0]!;
    expect(t.up).toBe(0.25);
    expect(t.sellPctBase).toBeCloseTo(0.1, 10);
    expect(t.trimQty).toBeCloseTo(100, 10); // 10% of 1000
    expect(t.grossProceeds).toBeCloseTo(100 * 125, 10); // 12,500
    expect(t.feeCost).toBeCloseTo(12_500 * SCALE_OUT_TAKER_FEE_EQUITY, 10);
    expect(t.netProceeds).toBeCloseTo(12_500 - 12_500 * SCALE_OUT_TAKER_FEE_EQUITY, 10);
    expect(t.isFullExit).toBe(false);
    expect(d.cumulativeSoldPctBase).toBeCloseTo(0.1, 10);
  });

  it('applies a custom taker fee when supplied', () => {
    const d = scaleOutLadderDecision({ ...base, currentPrice: 125, feeRate: HIGH_TAKER_FEE });
    const t = d.triggered[0]!;
    expect(d.feeRate).toBe(HIGH_TAKER_FEE);
    expect(t.feeCost).toBeCloseTo(12_500 * HIGH_TAKER_FEE, 10);
    // the override fee (63bps) is materially larger than equity (5bps)
    expect(t.feeCost).toBeGreaterThan(12_500 * SCALE_OUT_TAKER_FEE_EQUITY);
  });

  it('does not re-fire a rung already in firedRungs', () => {
    const d = scaleOutLadderDecision({ ...base, currentPrice: 130, firedRungs: [0.25] }); // +30%
    // only the +25% rung is armed by +30%, and it already fired
    expect(d.triggered).toHaveLength(0);
    expect(d.cumulativeSoldPctBase).toBeCloseTo(0.1, 10); // reflects prior fired rung
  });

  it('crosses multiple rungs in one gap-up, ascending, cumulative', () => {
    const d = scaleOutLadderDecision({ ...base, currentPrice: 150 }); // +50% → arms 25/35/45
    expect(d.triggered.map((t) => t.up)).toEqual([0.25, 0.35, 0.45]);
    expect(d.triggered.map((t) => t.sellPctBase)).toEqual([0.1, 0.2, 0.3]);
    expect(d.cumulativeSoldPctBase).toBeCloseTo(0.6, 10);
    expect(d.fullyExited).toBe(false);
  });

  it('the +100% rung exits the remainder (leftover base fraction), full exit', () => {
    // prior rungs sold 10+20+30+40 = 100% would leave nothing; use partial fired history
    const d = scaleOutLadderDecision({
      ...base,
      currentPrice: 200, // +100% → arms every rung
      firedRungs: [0.25, 0.35, 0.45, 0.60], // sold 10+20+30+40 = 100% already
    });
    // remainder is 0 left, so remainder rung still marks a full exit but trims 0
    expect(d.fullyExited).toBe(true);
    expect(d.triggered).toHaveLength(0); // nothing left to trim
  });

  it('the numeric rungs sum to 100% by +60%: full scale-out marked, remainder is a 0-qty no-op', () => {
    const d = scaleOutLadderDecision({
      ...base,
      currentPrice: 200, // +100% arms all five rungs at once
      firedRungs: [],
    });
    // 25/35/45/60 sell 10/20/30/40 = 100%; the +100% remainder rung has 0 leftover
    // so it never emits a trim. The +60% trim carries isFullExit (reaches 100%).
    expect(d.triggered.map((t) => t.up)).toEqual([0.25, 0.35, 0.45, 0.6]); // no 1.0 rung
    const soldFractions = d.triggered.map((t) => t.sellPctBase);
    expect(soldFractions.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 10);
    expect(d.triggered.at(-1)!.up).toBe(0.6);
    expect(d.triggered.at(-1)!.isFullExit).toBe(true);
    expect(d.fullyExited).toBe(true);
  });

  it('remainder rung trims the true leftover when earlier rungs were skipped', () => {
    // 20+30+40 = 90% sold historically, 25-rung skipped. A jump to +100% arms the
    // unfired 0.25 (sells the clamped 10%) which completes 100% — the remainder is 0.
    const d = scaleOutLadderDecision({
      side: 'buy',
      avgEntry: 100,
      baseQty: 1000,
      currentPrice: 200,
      firedRungs: [0.35, 0.45, 0.60], // sold 20+30+40 = 90% already
    });
    expect(d.triggered.map((t) => t.up)).toEqual([0.25]); // remainder is 0-qty, not emitted
    expect(d.triggered[0]!.sellPctBase).toBeCloseTo(0.1, 10);
    expect(d.triggered[0]!.isFullExit).toBe(true); // 90% + 10% = 100%
    expect(d.cumulativeSoldPctBase).toBeCloseTo(1, 10);
    expect(d.fullyExited).toBe(true);
  });

  it('remainder rung DOES emit when the ladder under-sells (custom rungs summing < 100%)', () => {
    // A hypothetical ladder whose numeric rungs sum to only 60% leaves a real
    // leftover for the remainder rung to exit.
    const rungs = [
      { up: 0.25, sellPctBase: 0.2 },
      { up: 0.5, sellPctBase: 0.4 },
      { up: 1.0, sellPctBase: 'remainder' as const },
    ];
    const d = scaleOutLadderDecision({ ...base, currentPrice: 200, rungs }); // +100%
    const remainder = d.triggered.find((t) => t.up === 1.0)!;
    expect(remainder.sellPctBase).toBeCloseTo(0.4, 10); // 100% − (20%+40%)
    expect(remainder.isFullExit).toBe(true);
    expect(d.cumulativeSoldPctBase).toBeCloseTo(1, 10);
  });

  it('DOWNSIDE HANDOFF: at/below avg entry emits no trim and flags downsideDeferred', () => {
    const flat = scaleOutLadderDecision({ ...base, currentPrice: 100 }); // exactly avg
    expect(flat.gainPct).toBe(0);
    expect(flat.downsideDeferred).toBe(true);
    expect(flat.triggered).toHaveLength(0);

    const down = scaleOutLadderDecision({ ...base, currentPrice: 70 }); // −30%
    expect(down.downsideDeferred).toBe(true);
    expect(down.triggered).toHaveLength(0);
    expect(down.fullyExited).toBe(false);
  });

  it('short side: favorable is a price drop below avg entry', () => {
    const d = scaleOutLadderDecision({ side: 'sell', avgEntry: 100, baseQty: 500, currentPrice: 80 });
    // short gain = 100/80 - 1 = +25%
    expect(d.gainPct).toBeCloseTo(0.25, 10);
    expect(d.triggered).toHaveLength(1);
    expect(d.triggered[0]!.up).toBe(0.25);
    // a price ABOVE entry is the short's downside → deferred
    const adverse = scaleOutLadderDecision({ side: 'sell', avgEntry: 100, baseQty: 500, currentPrice: 130 });
    expect(adverse.downsideDeferred).toBe(true);
    expect(adverse.triggered).toHaveLength(0);
  });

  it('degenerate inputs (non-positive avg/price/qty) emit nothing', () => {
    expect(scaleOutLadderDecision({ ...base, avgEntry: 0, currentPrice: 125 }).triggered).toHaveLength(0);
    expect(scaleOutLadderDecision({ ...base, currentPrice: 0 }).triggered).toHaveLength(0);
    expect(scaleOutLadderDecision({ ...base, baseQty: 0, currentPrice: 125 }).triggered).toHaveLength(0);
    expect(scaleOutLadderDecision({ ...base, currentPrice: NaN }).downsideDeferred).toBe(false);
  });
});
