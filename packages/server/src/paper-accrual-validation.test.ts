import { describe, it, expect } from 'vitest';
import {
  pairFillsIntoRoundTrips,
  computeCohortStats,
  requiredSampleSize,
  gradeSleeve,
  CONTRACT_MULTIPLIER,
  type HarnessFill,
} from './paper-accrual-validation';

/**
 * TRA-4604 — the harness must be wrong in the CONSERVATIVE direction or not at
 * all. Every arm below pairs a refusal with the PROCEED case it differs from by
 * one variable; a suite that only asserts refusals stays green on a harness that
 * has jammed shut and reports every strategy as unvalidated.
 */

function fill(over: Partial<HarnessFill> = {}): HarnessFill {
  return {
    ts: 0,
    etDay: '2026-09-01',
    sleeve: 'single_leg_otm',
    book: 'admin',
    optionSymbol: 'ATEC260918C00011000',
    side: 'buy_to_open',
    contracts: 1,
    filledPrice: 1.0,
    midAtSubmit: 1.0,
    fees: 0,
    source: 'paper',
    ...over,
  };
}

describe('pairFillsIntoRoundTrips', () => {
  it('prices a clean round-trip: net = fill-to-fill − fees; the spread is ATTRIBUTED, not deducted again', () => {
    const { roundTrips, unpaired } = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', filledPrice: 1.0, midAtSubmit: 0.98, fees: 1.3 }),
      fill({ ts: 2, side: 'sell_to_close', filledPrice: 1.5, midAtSubmit: 1.52, fees: 1.3 }),
    ]);
    expect(unpaired).toHaveLength(0);
    expect(roundTrips).toHaveLength(1);
    const t = roundTrips[0]!;
    // gross = (1.50 − 1.00) × 100 = 50 — on FILL prices, so the 4¢ crossed is already in it
    expect(t.grossPnl).toBeCloseTo(50, 6);
    expect(t.fees).toBeCloseTo(2.6, 6);
    // slippage = (1.00−0.98)×100 + (1.52−1.50)×100 = 2 + 2 = 4
    expect(t.slippageCost).toBeCloseTo(4, 6);
    // TRA-4730: NOT 50 − 2.6 − 4. That charged the 4¢ a second time.
    expect(t.netPnl).toBeCloseTo(50 - 2.6, 6);
    expect(t.netReturnPct).toBeCloseTo(47.4 / 100, 6);
    // The identity the attribution must satisfy: mid-to-mid − crossing − fees = net.
    expect((1.52 - 0.98) * 100 - t.slippageCost! - t.fees).toBeCloseTo(t.netPnl, 6);
  });

  it('THE POINT: the crossing can flip a mid-to-mid winner into a cash loser', () => {
    // The mid rose 3¢, but 5¢ was paid to get in and 5¢ to get out. The fills
    // carry that: gross is −7, and nothing needs subtracting on top of it.
    const { roundTrips } = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', filledPrice: 1.05, midAtSubmit: 1.0, fees: 1.3 }),
      fill({ ts: 2, side: 'sell_to_close', filledPrice: 0.98, midAtSubmit: 1.03, fees: 1.3 }),
    ]);
    const t = roundTrips[0]!;
    expect(t.slippageCost).toBeCloseTo(10, 6);
    expect(t.grossPnl).toBeCloseTo(-7, 6);
    expect(t.netPnl).toBeCloseTo(-7 - 2.6, 6);
  });

  it('price improvement is SIGNED negative, never charged as a cost (TRA-4730, RIG exit 0.18 vs 0.16 mid)', () => {
    const { roundTrips } = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', filledPrice: 0.33, midAtSubmit: 0.33, fees: 0.11 }),
      fill({ ts: 2, side: 'sell_to_close', filledPrice: 0.18, midAtSubmit: 0.16, fees: 0.13 }),
    ]);
    const t = roundTrips[0]!;
    expect(t.slippageCost).toBeCloseTo(-2, 6);
    // Tradier `gainloss` for this lot: −15.24.
    expect(t.netPnl).toBeCloseTo(-15.24, 6);
  });

  it('a stamped close pairs to an UNATTRIBUTED open of its symbol, flagged (TRA-4730)', () => {
    const { roundTrips, unpaired } = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', book: null, filledPrice: 0.71 }),
      fill({ ts: 2, side: 'sell_to_close', book: 'v0nni', filledPrice: 0.75 }),
    ]);
    expect(unpaired).toHaveLength(0);
    expect(roundTrips).toHaveLength(1);
    expect(roundTrips[0]!.openBookInferred).toBe(true);
    expect(roundTrips[0]!.book).toBe('v0nni');
  });

  it('prefers the close\'s OWN book before any unattributed open, and never crosses two named books', () => {
    const own = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', book: null, filledPrice: 0.5 }),
      fill({ ts: 2, side: 'buy_to_open', book: 'admin', filledPrice: 0.9 }),
      fill({ ts: 3, side: 'sell_to_close', book: 'admin', filledPrice: 1.0 }),
    ]);
    expect(own.roundTrips).toHaveLength(1);
    expect(own.roundTrips[0]!.openPrice).toBe(0.9);
    expect(own.roundTrips[0]!.openBookInferred).toBe(false);
    expect(own.unpaired.map((u) => u.reason)).toEqual(['still_open']);

    const crossed = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', book: 'admin' }),
      fill({ ts: 2, side: 'sell_to_close', book: 'v0nni', filledPrice: 1.5 }),
    ]);
    expect(crossed.roundTrips).toHaveLength(0);
    expect(crossed.unpaired.map((u) => u.reason).sort()).toEqual(['no_matching_open', 'still_open']);
  });

  it('refuses to price a fill with an UNREPORTED fee — null is not zero (TRA-1707)', () => {
    const { roundTrips, unpaired } = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', fees: null }),
      fill({ ts: 2, side: 'sell_to_close', filledPrice: 1.5 }),
    ]);
    expect(roundTrips).toHaveLength(0);
    expect(unpaired.map((u) => u.reason)).toContain('unreported_fees');
  });

  it('PROCEEDS when that same fee is reported as an explicit zero (the control)', () => {
    // The negative control for the arm above. Without this, "refuses
    // everything" would pass the suite.
    const { roundTrips, unpaired } = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', fees: 0 }),
      fill({ ts: 2, side: 'sell_to_close', filledPrice: 1.5, fees: 0 }),
    ]);
    expect(roundTrips).toHaveLength(1);
    expect(unpaired).toHaveLength(0);
  });

  it('refuses an unpriced fill', () => {
    const a = pairFillsIntoRoundTrips([fill({ filledPrice: null })]);
    expect(a.unpaired[0]!.reason).toBe('unpriced_fill');
  });

  it('PRICES a trip with a null mid on either leg; only the attribution goes UNMEASURED (TRA-4736)', () => {
    // SOFI on the live OTM ledger: 1.23 → 0.90, no mid on the close.
    for (const [openMid, closeMid] of [[1.205, null], [null, 0.91], [null, null]] as const) {
      const { roundTrips, unpaired } = pairFillsIntoRoundTrips([
        fill({ ts: 1, side: 'buy_to_open', filledPrice: 1.23, midAtSubmit: openMid, fees: 0.11 }),
        fill({ ts: 2, side: 'sell_to_close', filledPrice: 0.9, midAtSubmit: closeMid, fees: 0.13 }),
      ]);
      expect(unpaired).toHaveLength(0);
      expect(roundTrips).toHaveLength(1);
      expect(roundTrips[0]!.netPnl).toBeCloseTo(-33.24, 6);
      // null, NEVER 0 — a zero would read as "filled at mid".
      expect(roundTrips[0]!.slippageCost).toBeNull();
    }
  });

  it('totalSlippage sums the MEASURED trips only and counts the rest beside it', () => {
    const { roundTrips } = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', filledPrice: 1.0, midAtSubmit: 0.98, fees: 0 }),
      fill({ ts: 2, side: 'sell_to_close', filledPrice: 1.5, midAtSubmit: 1.52, fees: 0 }),
      fill({ ts: 3, side: 'buy_to_open', filledPrice: 1.0, midAtSubmit: 0.9, fees: 0 }),
      fill({ ts: 4, side: 'sell_to_close', filledPrice: 0.5, midAtSubmit: null, fees: 0 }),
    ]);
    const s = computeCohortStats(roundTrips);
    expect(s.n).toBe(2);
    expect(s.totalNetPnl).toBeCloseTo(0, 6);
    expect(s.totalSlippage).toBeCloseTo(4, 6);
    expect(s.slippageUnattributed).toBe(1);
  });

  it('reports a still-open position instead of discarding it', () => {
    const { roundTrips, unpaired } = pairFillsIntoRoundTrips([fill({ ts: 1 })]);
    expect(roundTrips).toHaveLength(0);
    expect(unpaired[0]!.reason).toBe('still_open');
  });

  it('reports a close with no matching open instead of inventing one', () => {
    const { unpaired } = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'sell_to_close', filledPrice: 1.5 }),
    ]);
    expect(unpaired[0]!.reason).toBe('no_matching_open');
  });

  it('pairs FIFO and supports partial closes', () => {
    const { roundTrips } = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', contracts: 2, filledPrice: 1.0, fees: 2 }),
      fill({ ts: 2, side: 'buy_to_open', contracts: 1, filledPrice: 2.0, fees: 1 }),
      fill({ ts: 3, side: 'sell_to_close', contracts: 2, filledPrice: 1.5, fees: 2 }),
    ]);
    // Consumes both contracts of the FIRST lot, not the cheaper-basis second.
    expect(roundTrips).toHaveLength(1);
    expect(roundTrips[0]!.contracts).toBe(2);
    expect(roundTrips[0]!.openPrice).toBe(1.0);
    expect(roundTrips[0]!.grossPnl).toBeCloseTo(0.5 * CONTRACT_MULTIPLIER * 2, 6);
  });

  it('a round-trip with ANY paper leg is paper evidence', () => {
    const { roundTrips } = pairFillsIntoRoundTrips([
      fill({ ts: 1, side: 'buy_to_open', source: 'live' }),
      fill({ ts: 2, side: 'sell_to_close', filledPrice: 1.5, source: 'paper' }),
    ]);
    expect(roundTrips[0]!.source).toBe('paper');
  });
});

describe('computeCohortStats', () => {
  function tripsFrom(netReturns: number[]) {
    return netReturns.map((r, i) => ({
      sleeve: 'single_leg_otm',
      book: 'admin',
      optionSymbol: 'X',
      source: 'paper' as const,
      openTs: i,
      closeTs: i + 1,
      daysHeld: 1,
      contracts: 1,
      openPrice: 1,
      closePrice: 1 + r,
      grossPnl: r * 100,
      fees: 0,
      slippageCost: 0,
      netPnl: r * 100,
      netReturnPct: r,
      openBookInferred: false,
    }));
  }

  it('compounds returns rather than summing them', () => {
    // +50% then −50% is −25%, not 0%. Summing would report break-even on a
    // series that lost a quarter of the capital.
    const s = computeCohortStats(tripsFrom([0.5, -0.5]));
    expect(s.compoundedReturnPct).toBeCloseTo(-0.25, 6);
  });

  it('computes expectancy, profit factor and max drawdown', () => {
    const s = computeCohortStats(tripsFrom([0.7, -0.4, 0.7, -0.4]));
    expect(s.n).toBe(4);
    expect(s.winRate).toBeCloseTo(0.5, 6);
    expect(s.expectancy).toBeCloseTo(15, 6); // (70+70−40−40)/4
    expect(s.profitFactor).toBeCloseTo(140 / 80, 6);
    expect(s.maxDrawdown).toBeCloseTo(40, 6);
  });

  it('leaves profit factor UNDEFINED rather than infinite when nothing lost', () => {
    expect(computeCohortStats(tripsFrom([0.2, 0.3])).profitFactor).toBeNull();
  });

  it('uses the sample SD (n−1), which is larger and therefore conservative', () => {
    const s = computeCohortStats(tripsFrom([0.1, 0.3]));
    // mean 0.2; sample SD = sqrt(((0.1)²+(0.1)²)/1) ≈ 0.1414, population ≈ 0.1
    expect(s.stdDevNetReturnPct).toBeCloseTo(0.14142, 4);
  });
});

describe('requiredSampleSize', () => {
  it('reproduces the textbook n for α=0.05, power=0.80', () => {
    // (1.959964 + 0.841621)² ≈ 7.849 → n = 7.849 · (σ/δ)²; σ/δ = 1 → 8.
    expect(requiredSampleSize({ stdDevNetReturnPct: 1, minDetectableEffectPct: 1 }).requiredN).toBe(8);
  });

  it('brackets the recorded 727 requirement at a plausible σ/δ', () => {
    // The live gate's 727 corresponds to σ/δ ≈ 9.62. This anchors the formula
    // to the number already in the repo rather than to an invented one.
    const n = requiredSampleSize({ stdDevNetReturnPct: 0.962, minDetectableEffectPct: 0.1 }).requiredN;
    expect(n).toBeGreaterThan(700);
    expect(n).toBeLessThan(760);
  });

  it('THE LEVER: halving σ cuts required N by ~4×', () => {
    const big = requiredSampleSize({ stdDevNetReturnPct: 1.0, minDetectableEffectPct: 0.1 }).requiredN;
    const small = requiredSampleSize({ stdDevNetReturnPct: 0.5, minDetectableEffectPct: 0.1 }).requiredN;
    expect(big / small).toBeCloseTo(4, 1);
  });

  it('rejects a non-positive minimum detectable effect', () => {
    expect(() => requiredSampleSize({ stdDevNetReturnPct: 1, minDetectableEffectPct: 0 })).toThrow();
  });
});

describe('gradeSleeve', () => {
  /**
   * A REPRESENTATIVE cohort: it must contain losses. A synthetic all-winners
   * series has an undefined profit factor and is correctly refused by the
   * harness, which would make it useless as a control. 60% of trades return
   * `ret`, 40% return `−ret/2`, so expectancy tracks the sign of `ret`.
   */
  function paperTrips(n: number, ret: number, source: 'paper' | 'live' = 'paper') {
    return Array.from({ length: n }, (_, i) => {
      const r = i % 5 < 3 ? ret : -ret / 2;
      return {
        sleeve: 'single_leg_otm',
        book: 'admin',
        optionSymbol: 'X',
        source,
        openTs: i,
        closeTs: i + 1,
        daysHeld: 1,
        contracts: 1,
        openPrice: 1,
        closePrice: 1 + r,
        grossPnl: r * 100,
        fees: 0,
        slippageCost: 0,
        netPnl: r * 100,
        netReturnPct: r,
        openBookInferred: false,
      };
    });
  }

  it('BLOCKS a paper-only cohort even when it is large and profitable', () => {
    // The load-bearing refusal. Paper can show a strategy is worth validating;
    // it can never authorise capital on its own.
    const v = gradeSleeve({
      sleeve: 'single_leg_otm',
      trips: paperTrips(5_000, 0.2),
      minDetectableEffectPct: 0.05,
    });
    expect(v.passes).toBe(false);
    expect(v.blockers.join(' ')).toContain('paper accrual does not authorise capital');
  });

  it('PROCEEDS on the same cohort when the legs are live (the control)', () => {
    // Differs from the arm above by ONE variable: source. If this went red the
    // refusal above would be proving nothing.
    const trips = paperTrips(5_000, 0.2, 'live');
    const v = gradeSleeve({
      sleeve: 'single_leg_otm',
      trips,
      minDetectableEffectPct: 0.05,
    });
    expect(v.passes).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  it('BLOCKS an underpowered cohort and reports the shortfall', () => {
    const v = gradeSleeve({
      sleeve: 'single_leg_otm',
      trips: paperTrips(61, 0.2, 'live'),
      minDetectableEffectPct: 0.001,
    });
    expect(v.passes).toBe(false);
    expect(v.shortfall).toBeGreaterThan(0);
    expect(v.blockers.join(' ')).toContain('underpowered');
    expect(v.progress).toBeLessThan(1);
  });

  it('BLOCKS a negative net-of-fee expectancy however large the sample', () => {
    const v = gradeSleeve({
      sleeve: 'single_leg_otm',
      trips: paperTrips(5_000, -0.2, 'live'),
      minDetectableEffectPct: 0.05,
    });
    expect(v.passes).toBe(false);
    expect(v.blockers.join(' ')).toContain('non-positive net-of-fee expectancy');
  });

  it('scopes to the named sleeve and ignores others', () => {
    const mixed = [
      ...paperTrips(10, 0.2, 'live'),
      ...paperTrips(10, 0.2, 'live').map((t) => ({ ...t, sleeve: 'single_leg_rv' })),
    ];
    expect(gradeSleeve({ sleeve: 'single_leg_rv', trips: mixed, minDetectableEffectPct: 0.05 }).observedN).toBe(10);
  });
});
