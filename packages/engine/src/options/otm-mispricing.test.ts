import { describe, it, expect } from 'vitest';
import { findMispricedOtmContracts, type OptionChainRow } from './otm-mispricing.js';
import { blackScholesPrice, blackScholesDelta, daysToExpiration } from './black-scholes.js';

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

  // TRA-1407 — minAbsDelta floor: drop far-OTM low-delta lottery tickets, keep
  // the near-money reads. With SPOT=100 a 102 call sits ~0.44 delta while a 110
  // call is ~0.16, so a 0.40 floor removes 110 but keeps 102.
  it('drops candidates below the minAbsDelta floor but keeps near-money ones', () => {
    const chain: OptionChainRow[] = [
      liquidRow(102, 'call', 0.30), // near-money, |delta| ~0.44 → kept
      liquidRow(110, 'call', 0.30), // far-OTM, |delta| ~0.16 → dropped by 0.40 floor
    ];
    const unfloored = findMispricedOtmContracts(chain, SPOT, { now: NOW });
    expect(unfloored.map(r => r.strike).sort((a, b) => a - b)).toEqual([102, 110]);

    const floored = findMispricedOtmContracts(chain, SPOT, { now: NOW, minAbsDelta: 0.4 });
    expect(floored.map(r => r.strike)).toEqual([102]);
    expect(Math.abs(floored[0].delta)).toBeGreaterThanOrEqual(0.4);
  });

  it('minAbsDelta of 0 is a no-op (legacy far-OTM behaviour preserved)', () => {
    const chain = [liquidRow(110, 'call', 0.30)];
    const withZero = findMispricedOtmContracts(chain, SPOT, { now: NOW, minAbsDelta: 0 });
    const without = findMispricedOtmContracts(chain, SPOT, { now: NOW });
    expect(withZero.map(r => r.strike)).toEqual(without.map(r => r.strike));
    expect(withZero).toHaveLength(1);
  });

  it('classifies a fairly-priced contract as fair', () => {
    const chain = [liquidRow(110, 'call', 0)];
    const result = findMispricedOtmContracts(chain, SPOT, { now: NOW });
    expect(result[0].classification).toBe('fair');
    expect(Math.abs(result[0].mispricingPct)).toBeLessThan(0.001);
  });
});

/**
 * TRA-2341 — theo underflow. NOT a bug in this file's arithmetic; a pin on the
 * behaviour the route-layer guard exists to compensate for.
 *
 * Far OTM, `theo` decays toward zero much faster than the market's bid, which
 * stays pinned near a penny by the minimum tick and lottery-ticket demand. The
 * ratio `(mark − theo) / theo` then reports the TICK SIZE rather than any
 * disagreement with the vol surface — live SPY on 2026-07-25 showed mark 0.095
 * over theo 0.000128, rendering as +74215.7%. Since candidates are ranked by
 * `|mispricingPct|` descending, those rows crowd every genuine read off a
 * limit=15 panel: SPY's default panel was 15 of 15 artifacts.
 *
 * Note `liquidRow` reproduces the mechanism faithfully all on its own — its
 * `Math.max(0.05, theo * (1 + markBias))` is exactly the minimum tick doing to
 * the fixture what it does to the real book.
 *
 * These tests assert the CURRENT engine behaviour deliberately. The guard lives
 * in `packages/server/src/otm-theo-floor.ts`, applied by the read-only
 * `/api/options/otm-mispricing` route, because `findMispricedOtmContracts` is
 * also reached in-process by the `single_leg_otm` sleeve via
 * `rvScanner.scanOtm()` — changing DEFAULTS here would be a live trading-logic
 * change. If the engine ever does grow a denominator floor (ticket option 2,
 * needs the sleeve owner), these are the tests that should fail and be updated.
 */
describe('TRA-2341 — far-OTM theo underflow explodes the mispricing ratio', () => {
  // 73-strike put at SPOT=100 is ~27% OTM with ~31 DTE: the same order of
  // moneyness as SPY's 420 put against a 738.93 spot.
  const UNDERFLOW_STRIKE = 73;

  it('emits a sub-tick theo against a tick-floored mark', () => {
    const row = liquidRow(UNDERFLOW_STRIKE, 'put', 0);
    const result = findMispricedOtmContracts([row], SPOT, { now: NOW });

    expect(result).toHaveLength(1);
    const artifact = result[0];
    // The denominator is below one minimum tick — the model says the contract
    // is worth less than the smallest price at which it can trade.
    expect(artifact.theo).toBeGreaterThan(0); // `theo <= 0` did NOT fire
    expect(artifact.theo).toBeLessThan(0.01);
    // ...while the numerator clears `minMark` comfortably. This is why a floor
    // on the NUMERATOR (minMark 0.05, documented as guarding exactly this) does
    // not catch it.
    expect(artifact.mark).toBeGreaterThanOrEqual(0.05);
    // Result: a ratio that is arithmetically correct and completely meaningless.
    expect(artifact.mispricingPct).toBeGreaterThan(1); // >100%
    expect(artifact.classification).toBe('expensive');
  });

  it('ranks the underflow artifact above a genuine 30% read', () => {
    const chain: OptionChainRow[] = [
      liquidRow(110, 'call', 0.3), // genuine +30% divergence
      liquidRow(UNDERFLOW_STRIKE, 'put', 0), // artifact
    ];
    const result = findMispricedOtmContracts(chain, SPOT, { now: NOW });

    // THE DEFECT: rank order puts the meaningless row first, so a limit=1 slice
    // returns the artifact and discards the real read.
    expect(result[0].strike).toBe(UNDERFLOW_STRIKE);
    expect(Math.abs(result[0].mispricingPct)).toBeGreaterThan(
      Math.abs(result[1].mispricingPct),
    );
  });

  it('minAbsDelta would catch it, but is off by default', () => {
    const chain = [liquidRow(UNDERFLOW_STRIKE, 'put', 0)];
    // Every live SPY artifact row had |delta| < 0.001.
    expect(Math.abs(findMispricedOtmContracts(chain, SPOT, { now: NOW })[0].delta)).toBeLessThan(
      0.01,
    );
    expect(findMispricedOtmContracts(chain, SPOT, { now: NOW, minAbsDelta: 0.01 })).toHaveLength(0);
  });
});

/**
 * TRA-2917 — isotonic (PAVA) monotone repair of the theo surface, in the engine.
 *
 * The defect this repairs is TRA-2662: `smv_vol` is a per-contract vendor field
 * with no cross-strike constraint, so the BS theo ladder built on it violates
 * vertical-spread monotonicity. The fixture below reproduces the mechanism
 * faithfully — a single inflated `smvVol` on one strike makes that put's theo
 * exceed the next strike up, exactly what the live captures show.
 */
describe('TRA-2917 — PAVA monotone repair of the theo surface', () => {
  // Puts at 85/90 with the 85 strike's smvVol inflated to 0.60: theo(85) then
  // exceeds theo(90) computed at 0.30 — a nondecreasing violation.
  const HOT_SIGMA = 0.6;
  const rawTheo = (strike: number, optionType: 'call' | 'put', sigma: number) =>
    blackScholesPrice({
      spot: SPOT,
      strike,
      timeToExpiryYears: T,
      riskFreeRate: R,
      volatility: sigma,
      optionType,
    });

  const violatingChain = (): OptionChainRow[] => [
    liquidRow(85, 'put', 0, { smvVol: HOT_SIGMA }),
    liquidRow(90, 'put', 0),
    liquidRow(110, 'call', 0.3), // separate bucket — must be untouched
  ];

  it('fixture precondition: the raw put ladder actually violates (the mutation can mutate)', () => {
    expect(rawTheo(85, 'put', HOT_SIGMA)).toBeGreaterThan(rawTheo(90, 'put', SIGMA));
  });

  it('repairs the violating pair to its pooled mean and keeps theoRaw as the raw surface', () => {
    const result = findMispricedOtmContracts(violatingChain(), SPOT, { now: NOW });
    const p85 = result.find((r) => r.strike === 85)!;
    const p90 = result.find((r) => r.strike === 90)!;

    const raw85 = rawTheo(85, 'put', HOT_SIGMA);
    const raw90 = rawTheo(90, 'put', SIGMA);
    expect(p85.theoRaw).toBeCloseTo(raw85, 10);
    expect(p90.theoRaw).toBeCloseTo(raw90, 10);

    const pooled = (raw85 + raw90) / 2;
    expect(p85.theo).toBeCloseTo(pooled, 10);
    expect(p90.theo).toBeCloseTo(pooled, 10);
    // Post-repair the ladder is monotone (nondecreasing for puts, ties allowed).
    expect(p90.theo).toBeGreaterThanOrEqual(p85.theo);
  });

  it('recomputes mispricingPct and classification from the REPAIRED theo', () => {
    const result = findMispricedOtmContracts(violatingChain(), SPOT, { now: NOW });
    for (const strike of [85, 90]) {
      const row = result.find((r) => r.strike === strike)!;
      expect(row.mispricingPct).toBeCloseTo((row.mark - row.theo) / row.theo, 12);
      const expected =
        row.mispricingPct > 0.15 ? 'expensive' : row.mispricingPct < -0.15 ? 'cheap' : 'fair';
      expect(row.classification).toBe(expected);
    }
  });

  it('leaves delta and ivUsed computed from raw inputs (risk gate / vendor observable)', () => {
    const result = findMispricedOtmContracts(violatingChain(), SPOT, { now: NOW });
    const p85 = result.find((r) => r.strike === 85)!;
    expect(p85.ivUsed).toBe(HOT_SIGMA);
    expect(p85.delta).toBeCloseTo(
      // Sign-adjusted BS delta at the RAW sigma — the repair must not move it.
      blackScholesDelta({
        spot: SPOT,
        strike: 85,
        timeToExpiryYears: T,
        riskFreeRate: R,
        volatility: HOT_SIGMA,
        optionType: 'put',
      }),
      10,
    );
  });

  it('leaves rows outside the violating segment byte-unchanged (theo === theoRaw)', () => {
    const result = findMispricedOtmContracts(violatingChain(), SPOT, { now: NOW });
    const call = result.find((r) => r.strike === 110)!;
    expect(call.theo).toBe(call.theoRaw); // exact, not closeTo
  });

  it('is a no-op on an already-coherent chain: every row keeps theo === theoRaw', () => {
    const coherent: OptionChainRow[] = [
      liquidRow(105, 'call', 0.2),
      liquidRow(110, 'call', 0.1),
      liquidRow(115, 'call', 0),
      liquidRow(90, 'put', 0),
      liquidRow(95, 'put', 0.1),
    ];
    const result = findMispricedOtmContracts(coherent, SPOT, { now: NOW });
    expect(result.length).toBeGreaterThan(0);
    for (const row of result) {
      expect(row.theo).toBe(row.theoRaw);
      expect(row.mispricingPct).toBeCloseTo((row.mark - row.theo) / row.theo, 12);
    }
  });

  it('final ranking sorts on the repaired |mispricingPct|', () => {
    const result = findMispricedOtmContracts(violatingChain(), SPOT, { now: NOW });
    for (let i = 0; i + 1 < result.length; i += 1) {
      expect(Math.abs(result[i].mispricingPct)).toBeGreaterThanOrEqual(
        Math.abs(result[i + 1].mispricingPct),
      );
    }
  });
});
