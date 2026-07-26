import { describe, it, expect } from 'vitest';
import { findMispricedOtmContracts, type OptionChainRow } from '@trading-app/engine';
import { blackScholesPrice, daysToExpiration } from '@trading-app/engine';
import { applyDeltaFloor, OTM_PANEL_DELTA_FLOOR } from './otm-delta-floor.js';
import { applyTheoFloor, OTM_PANEL_THEO_FLOOR } from './otm-theo-floor.js';

/**
 * TRA-2388 fixtures are the live 2026-07-26 reads the TRA-2354 decision
 * tabulates. As with TRA-2341, the artifact rows are ARITHMETICALLY CORRECT —
 * there is no wrong sum to catch, so the failing state has to be asserted at the
 * projection layer.
 *
 * What these lock down, in order of how much they'd hurt to lose:
 *   1. the SUPPRESSED COUNT is reported (a silent drop reads as a thin chain);
 *   2. the negative control — the floor is a NO-OP on healthy symbols;
 *   3. `?minDelta=0` really escapes;
 *   4. the route-layer filter is EQUIVALENT to the engine's TRA-1407 filter on
 *      the kept set, which is the claim the whole containment argument rests on.
 *
 * Deliberately NOT pinned: the constant's exact value in an assertion that would
 * silently re-bless a retune. Where a number matters, the DIRECTION is asserted
 * (SPY collapses out of the artifact regime; NVDA/QQQ/AAPL are untouched).
 */

/** SPY / TSLA rows from the live sweep — inside the artifact band. */
const ARTIFACTS = [
  { optionSymbol: 'SPY260831P00470000', delta: -0.0041, mispricingPct: 15.109 },
  { optionSymbol: 'TSLA260821C00520000', delta: 0.0106, mispricingPct: 13.122 },
  { optionSymbol: 'SPY260831P00490000', delta: -0.0116, mispricingPct: 1.11 },
];

/**
 * The rows the panel exists to show. NVDA's `cheap` read sits at |delta| 0.0404
 * — it is the ONLY cheap classification in the whole 5-symbol sweep, and it is
 * the reason the floor is 0.02 and not the 0.05 the ticket floated.
 */
const REAL_READS = [
  { optionSymbol: 'NVDA260821C00230000', delta: 0.0404, mispricingPct: -0.254 },
  { optionSymbol: 'AAPL260821C00250000', delta: 0.0731, mispricingPct: 0.171 },
  { optionSymbol: 'QQQ260831C00640000', delta: 0.1902, mispricingPct: 0.095 },
];

describe('applyDeltaFloor — TRA-2388 / TRA-2354 option 1', () => {
  it('suppresses the far-tail rows and keeps the genuine reads, reporting the count', () => {
    // Rank order as the scanner emits it: |mispricingPct| descending, so every
    // artifact outranks every real read. A limit=15 slice of THIS list is what
    // the desk was looking at after TRA-2341 shipped.
    const ranked = [...ARTIFACTS, ...REAL_READS];

    const result = applyDeltaFloor(ranked, OTM_PANEL_DELTA_FLOOR);

    expect(result.kept.map((c) => c.optionSymbol)).toEqual([
      'NVDA260821C00230000',
      'AAPL260821C00250000',
      'QQQ260831C00640000',
    ]);
    expect(result.suppressed).toBe(3);
    // The panel must be able to SAY how absurd the discarded reads were. An
    // empty table plus a zero here is indistinguishable from a thin chain.
    expect(result.maxSuppressedMispricingPct).toBeCloseTo(15.109, 3);
  });

  it('collapses the top read out of the artifact regime — the positive control', () => {
    // The reported symptom: SPY's default panel topped out at 1510.9% and TSLA
    // at 1312.2% WITH the TRA-2341 theo floor already deployed. Assert the
    // direction (a ratio that is no longer an order of magnitude), not the
    // post-fix number, which moves with the tape.
    const ranked = [...ARTIFACTS, ...REAL_READS];
    const before = Math.max(...ranked.map((c) => Math.abs(c.mispricingPct)));
    expect(before).toBeGreaterThan(10); // >1000%: fixture guard

    const after = Math.max(
      ...applyDeltaFloor(ranked, OTM_PANEL_DELTA_FLOOR).kept.map((c) =>
        Math.abs(c.mispricingPct),
      ),
    );
    expect(after).toBeLessThan(1); // <100%, i.e. a read a human can act on
    expect(after).toBeLessThan(before);
  });

  it('is a NO-OP on the healthy symbols — the negative control', () => {
    // NVDA / QQQ / AAPL were bit-identical at every floor from 0 through 0.03
    // with `suppressed: 0`. That property is what made TRA-2341 credible; a
    // floor that quietly trims healthy symbols is a different change entirely.
    for (const floor of [0.005, 0.01, OTM_PANEL_DELTA_FLOOR, 0.03]) {
      const result = applyDeltaFloor(REAL_READS, floor);
      expect(result.kept).toEqual(REAL_READS);
      expect(result.suppressed).toBe(0);
      expect(result.maxSuppressedMispricingPct).toBeNull();
    }
  });

  it('keeps the only `cheap` read in the sweep — why the floor is not 0.05', () => {
    // NVDA at |delta| 0.0404 survives the shipped floor and dies at 0.05. If a
    // future retune walks the constant up past this row, this test is the thing
    // that says so out loud instead of the panel quietly losing the read.
    const nvda = REAL_READS[0]!;
    expect(applyDeltaFloor([nvda], OTM_PANEL_DELTA_FLOOR).kept).toHaveLength(1);
    expect(applyDeltaFloor([nvda], 0.05).suppressed).toBe(1);
  });

  it('keeps a contract sitting exactly ON the floor', () => {
    const onFloor = [{ optionSymbol: 'X', delta: OTM_PANEL_DELTA_FLOOR, mispricingPct: 8.5 }];
    expect(applyDeltaFloor(onFloor, OTM_PANEL_DELTA_FLOOR).kept).toHaveLength(1);
  });

  it('applies to |delta|, so puts are not all suppressed', () => {
    // `delta` is sign-adjusted — every put is negative. A `delta >= floor`
    // predicate would silently delete the entire put side of the panel while
    // still looking like a working filter.
    const puts = [
      { optionSymbol: 'P_FAR', delta: -0.004, mispricingPct: 9 },
      { optionSymbol: 'P_NEAR', delta: -0.31, mispricingPct: 0.2 },
    ];
    const result = applyDeltaFloor(puts, OTM_PANEL_DELTA_FLOOR);
    expect(result.kept.map((c) => c.optionSymbol)).toEqual(['P_NEAR']);
    expect(result.suppressed).toBe(1);
  });

  it('floor of 0 disables the guard — the `?minDelta=0` escape hatch', () => {
    const ranked = [...ARTIFACTS, ...REAL_READS];
    const result = applyDeltaFloor(ranked, 0);
    expect(result.kept).toEqual(ranked);
    expect(result.floor).toBe(0);
    expect(result.suppressed).toBe(0);
    expect(result.maxSuppressedMispricingPct).toBeNull();
  });

  it('a non-finite floor degrades to the legacy projection, not an empty table', () => {
    // `?minDelta=abc` -> NaN. Every comparison against NaN is false, so a naive
    // `|delta| >= floor` would suppress EVERYTHING and the panel would report a
    // healthy scan of a thin chain. It must degrade the other way.
    const ranked = [...ARTIFACTS, ...REAL_READS];
    for (const bad of [Number.NaN, -1]) {
      const result = applyDeltaFloor(ranked, bad);
      expect(result.kept).toHaveLength(ranked.length);
      expect(result.floor).toBe(0);
    }
  });

  it('fails closed on a non-finite delta, matching the engine predicate', () => {
    // TRA-1407 uses `!(Math.abs(delta) >= floor)` — an un-scored contract does
    // not get admitted past a distance gate. Note this is the OPPOSITE
    // disposition from a NaN FLOOR: a broken caller gets the raw view, a broken
    // ROW gets suppressed.
    const broken = [{ optionSymbol: 'NAN', delta: Number.NaN, mispricingPct: Number.NaN }, ...REAL_READS];
    const result = applyDeltaFloor(broken, OTM_PANEL_DELTA_FLOOR);
    expect(result.kept).toEqual(REAL_READS);
    expect(result.suppressed).toBe(1);
    // A NaN ratio must not poison the reported max.
    expect(result.maxSuppressedMispricingPct).toBeNull();
  });

  it('empty input is a clean pass, not a suppression', () => {
    const result = applyDeltaFloor([], OTM_PANEL_DELTA_FLOOR);
    expect(result.kept).toHaveLength(0);
    expect(result.suppressed).toBe(0);
    expect(result.maxSuppressedMispricingPct).toBeNull();
  });

  it('composes with the theo floor: sequential counts, both before the slice', () => {
    // The route runs theo first, then delta on what theo kept. The two counts
    // are NOT partitions of the same population, and a reader who adds them is
    // double-counting nothing — but a reader who expects `deltaFloor.suppressed`
    // to cover the theo-underflow rows is wrong. Pin the composition.
    const underflow = { optionSymbol: 'UNDERFLOW', theo: 0.0001, delta: -0.5, mispricingPct: 742 };
    const farTail = { optionSymbol: 'FAR', theo: 0.09, delta: -0.004, mispricingPct: 15 };
    const good = { optionSymbol: 'GOOD', theo: 1.9, delta: 0.31, mispricingPct: -0.25 };

    const theo = applyTheoFloor([underflow, farTail, good], OTM_PANEL_THEO_FLOOR);
    const delta = applyDeltaFloor(theo.kept, OTM_PANEL_DELTA_FLOOR);

    expect(theo.suppressed).toBe(1);
    // The underflow row is already gone, so it is NOT counted again here — and
    // note the delta floor alone would have KEPT it (|delta| 0.5). The two axes
    // catch different rows; neither subsumes the other.
    expect(delta.suppressed).toBe(1);
    expect(delta.kept.map((c) => c.optionSymbol)).toEqual(['GOOD']);
  });
});

/**
 * The containment claim, executed rather than asserted in prose.
 *
 * `otm-delta-floor.ts` argues that filtering the RETURNED candidates is
 * equivalent to forwarding `minAbsDelta` into the engine — same `delta`, same
 * predicate, no aggregate derived downstream — and that the route may therefore
 * stop forwarding it. If that equivalence ever breaks (an engine-side aggregate,
 * a delta recomputed after the filter), the route silently starts returning a
 * different set of rows than TRA-1407's gate would. This is the test that fails.
 */
describe('TRA-2388 — route-layer filter is equivalent to the engine minAbsDelta gate', () => {
  const NOW = Date.parse('2026-07-24T15:00:00Z');
  const EXP = '2026-08-21';
  const T = daysToExpiration(EXP, NOW) / 365;
  const R = 0.045;
  const SIGMA = 0.3;
  const SPOT = 100;

  /**
   * A liquid OTM row. `mark` is floored at $0.05 (the minimum tick), which is
   * exactly how the far tail manufactures its ratio: theo decays past a penny
   * while the book stays pinned at one.
   */
  function row(strike: number, optionType: 'call' | 'put'): OptionChainRow {
    const theo = blackScholesPrice({
      spot: SPOT,
      strike,
      timeToExpiryYears: T,
      riskFreeRate: R,
      volatility: SIGMA,
      optionType,
    });
    const mark = Math.max(0.06, theo * 1.02);
    const half = mark * 0.02;
    return {
      optionSymbol: `TEST${strike}${optionType.toUpperCase()}`,
      underlying: 'TEST',
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

  // Strikes spanning near-money to deep tail, both sides.
  const chain: OptionChainRow[] = [
    ...[104, 108, 112, 118, 125, 135, 150, 170].map((k) => row(k, 'call')),
    ...[96, 92, 88, 82, 75, 65, 50, 30].map((k) => row(k, 'put')),
  ];

  it('produces the same kept set as the engine gate, for every floor tested', () => {
    for (const floor of [0.005, 0.01, OTM_PANEL_DELTA_FLOOR, 0.05, 0.4]) {
      // What the route does now: scan with NO delta option, filter after.
      const routeSide = applyDeltaFloor(
        findMispricedOtmContracts(chain, SPOT, { now: NOW }),
        floor,
      ).kept.map((c) => c.optionSymbol);

      // What forwarding into the engine would have done.
      const engineSide = findMispricedOtmContracts(chain, SPOT, {
        now: NOW,
        minAbsDelta: floor,
      }).map((c) => c.optionSymbol);

      expect(routeSide).toEqual(engineSide);
    }
  });

  it('the shipped floor actually removes rows on this chain — fixture guard', () => {
    // Without this, the equivalence test above would pass vacuously on a chain
    // where no row is below the floor. A no-op comparison proves nothing.
    const result = applyDeltaFloor(
      findMispricedOtmContracts(chain, SPOT, { now: NOW }),
      OTM_PANEL_DELTA_FLOOR,
    );
    expect(result.suppressed).toBeGreaterThan(0);
    expect(result.kept.length).toBeGreaterThan(0);
  });
});
