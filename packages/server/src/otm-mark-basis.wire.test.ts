import { describe, it, expect } from 'vitest';
import {
  findMispricedOtmContracts,
  blackScholesPrice,
  daysToExpiration,
  type OptionChainRow,
} from '@trading-app/engine';
import {
  rebaseMispricing,
  OTM_DEFAULT_MISPRICING_BASIS,
  type MispricingBasis,
} from './otm-mark-basis.js';
import { applyTheoFloor, OTM_PANEL_THEO_FLOOR } from './otm-theo-floor.js';
import { applyDeltaFloor, OTM_PANEL_DELTA_FLOOR } from './otm-delta-floor.js';

/**
 * TRA-2564 → TRA-2659/TRA-2661 acceptance, executed off-host.
 *
 * The ticket's acceptance is a property of the LIVE 200 response, and QuantTrader
 * runs the RTH re-measure after deploy. This pins the same properties against the
 * REAL engine and the REAL route pipeline so a regression is caught in CI rather
 * than by a human reading a live panel — and, more to the point, so the
 * acceptance has a defined FAILING state that does not depend on bqb1 being
 * reachable.
 *
 * ⚠️ What this CANNOT do: it cannot prove the live box serves this build. That is
 * a deploy question (`pnpm check:deploy-drift`), not a test question. A green run
 * here says the code is right, never that it is running.
 *
 * ## ⛔ WHAT THE ACCEPTANCE IS, AFTER TRA-2659
 *
 * The old bar — "max |mispricingPct| < 100%", and its `< 75%` variant — is
 * RETIRED, not re-tuned. Under the new `max` default it is an algebraic identity:
 * it passes on every chain forever, including one whose `theo` is garbage, so it
 * reads identically in the pass and the fail state. It survives below only as a
 * TAUTOLOGY CHECK ON THE IMPLEMENTATION, labelled as such.
 *
 * What carries the weight instead is CHEAP-SIDE ENGINE PARITY: every row with
 * `mark < theo` must carry exactly the engine's own `(mark − theo)/theo`. The
 * engine emits that basis (`otm-mispricing.ts:252`) and the live `single_leg_otm`
 * sleeve gates on `classification === 'cheap'`, so this is the property that
 * makes the flip safe — and the one that breaks if someone later "improves" the
 * formula. It is asserted here per row, against a chain that really has a cheap
 * side.
 */

const NOW = Date.parse('2026-07-30T15:00:00Z');
const EXP = '2026-08-31';
const T = daysToExpiration(EXP, NOW) / 365;
const R = 0.045;
const SPOT = 738.93; // SPY on the 2026-07-25 read TRA-2341 tabulates
const SIGMA = 0.18;
const STRIKES = [420, 470, 490, 620, 680, 700, 720, 730];

function theoAt(strike: number): number {
  return blackScholesPrice({
    spot: SPOT,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: R,
    volatility: SIGMA,
    optionType: 'put',
  });
}

function quote(strike: number, mark: number): OptionChainRow {
  const half = Math.max(0.01, mark * 0.02);
  return {
    optionSymbol: `SPY260831P00${strike}000`,
    underlying: 'SPY',
    optionType: 'put',
    strike,
    expiration: EXP,
    bid: mark - half,
    ask: mark + half,
    volume: 500,
    openInterest: 1000,
    smvVol: SIGMA,
    midIv: SIGMA,
  };
}

/**
 * The EXPENSIVE-tailed chain: far-OTM puts whose theo collapses under a flat σ
 * while the bid stays pinned near the minimum tick, plus near-the-money strikes
 * that price honestly. This is the shape that made the theo basis read +74215.7%
 * / +1510.9%, and the regime TRA-2388 measured.
 */
function expensiveChain(): OptionChainRow[] {
  return STRIKES.map((k) => quote(k, Math.max(0.1, theoAt(k) * 1.04)));
}

/**
 * The MIXED chain — a cheap tail (the regime the 2026-07-30 live SPY read was
 * actually in, and the one the old fixture could not produce at all) alongside an
 * expensive head, in ONE response.
 *
 * Near the money the tape is quoted BELOW the flat-σ model, which is what a smile
 * does to a model that does not carry one; far out, the minimum tick still floors
 * the quote above a collapsed theo.
 *
 * The factor is DIFFERENT at every strike on purpose. A single constant factor
 * makes `(m−t)/m` the same number on every row, and a fixture with no variation
 * has nothing to detect — the whole chain would read identically however the
 * ranking or the per-row formula broke.
 *
 * Under σ=0.18 / 32d / spot 738.93 the engine drops 420/470/490 outright (their
 * theo rounds to 0 and `otm-mispricing.ts` skips `theo <= 0`), so the factors
 * below are keyed to the five strikes that actually survive.
 *
 * ⚠️ If a change to the engine or these strikes ever leaves this chain one-sided,
 * the parity assertions below would go VACUOUSLY green — which is why the first
 * test in that block counts BOTH sides and fails at zero.
 */
const MIXED_FACTORS: Record<number, number> = {
  620: 27.0, // theo 0.003703, tick-floored quote → EXPENSIVE, the artifact regime
  680: 1.35, // theo 0.821376                     → EXPENSIVE, moderate
  700: 0.3, //  theo 2.704132                     → CHEAP, deep
  720: 0.55, // theo 7.005808                     → CHEAP
  730: 0.88, // theo 10.428783                    → CHEAP, but inside the band (`fair`)
};

function mixedChain(): OptionChainRow[] {
  return STRIKES.map((k) => quote(k, Math.max(0.06, theoAt(k) * (MIXED_FACTORS[k] ?? 1.04))));
}

/** The exact composition `/api/options/otm-mispricing` performs, in order. */
function route(
  opts: {
    chain?: OptionChainRow[];
    basis?: MispricingBasis;
    minDelta?: number;
    minTheo?: number;
    limit?: number;
  } = {},
) {
  const candidates = findMispricedOtmContracts(opts.chain ?? expensiveChain(), SPOT, { now: NOW });
  // `basis` omitted ⇒ the route's real no-`?basis=` path, which is the thing
  // TRA-2661 changed. Hardcoding 'mark' here — as this file used to — would have
  // left every assertion below grading the SUPERSEDED basis while reading green.
  const rebased = rebaseMispricing(candidates, opts.basis ?? OTM_DEFAULT_MISPRICING_BASIS);
  const floored = applyTheoFloor(rebased.candidates, opts.minTheo ?? OTM_PANEL_THEO_FLOOR);
  const deltaFloored = applyDeltaFloor(floored.kept, opts.minDelta ?? OTM_PANEL_DELTA_FLOOR);
  const body = {
    symbol: 'SPY',
    candidates: deltaFloored.kept.slice(0, opts.limit ?? 15),
    mispricingBasis: rebased.basis,
    markBasis: { threshold: rebased.threshold, unbasisable: rebased.unbasisable },
    theoFloor: {
      applied: floored.floor,
      suppressed: floored.suppressed,
      maxSuppressedMispricingPct: floored.maxSuppressedMispricingPct,
    },
    deltaFloor: {
      applied: deltaFloored.floor,
      suppressed: deltaFloored.suppressed,
      maxSuppressedMispricingPct: deltaFloored.maxSuppressedMispricingPct,
    },
  };
  // Round-trip through the wire. `res.json` is `JSON.stringify` — a field that
  // does not survive it is not an instrument, however present it is in the type.
  return JSON.parse(JSON.stringify(body)) as typeof body;
}

/**
 * Both floors OFF, so the rows each fixture was designed around actually reach
 * the assertion. With the default theo floor the 620 artifact row is suppressed
 * before it can be graded, which would quietly remove the most extreme row from
 * every bound check below.
 */
const raw = (chain: OptionChainRow[], basis?: MispricingBasis) =>
  route({ chain, basis, minDelta: 0, minTheo: 0, limit: 50 });

const worstOn = (chain: OptionChainRow[], basis?: MispricingBasis) =>
  Math.max(...raw(chain, basis).candidates.map((c) => Math.abs(c.mispricingPct)));

describe('TRA-2661 acceptance 1 — the default really moved to `max`', () => {
  it('`mispricingBasis: "max"` with no ?basis=, and it survives JSON serialisation', () => {
    expect(route().mispricingBasis).toBe('max');
    expect(Object.keys(route())).toContain('mispricingBasis');
  });

  it('NEGATIVE CONTROL: an explicit ?basis= still echoes what it applied', () => {
    expect(route({ basis: 'theo' }).mispricingBasis).toBe('theo');
    expect(route({ basis: 'mark' }).mispricingBasis).toBe('mark');
  });

  it('the echo is not a constant: the three bases produce three different numbers', () => {
    // Guards the failure mode where `mispricingBasis` reads right and the
    // arithmetic does not. Uses the mixed chain, where all three genuinely differ.
    const [mark, theo, max] = [
      worstOn(mixedChain(), 'mark'),
      worstOn(mixedChain(), 'theo'),
      worstOn(mixedChain(), 'max'),
    ];
    expect(mark).not.toBeCloseTo(theo, 6);
    expect(max).toBeLessThan(mark); // max takes the bounded branch on this chain
    expect(max).toBeLessThan(1);
  });
});

describe('TRA-2661 acceptance 2 — CHEAP-SIDE ENGINE PARITY (the load-bearing one)', () => {
  /**
   * The engine emits `(mark − theo)/theo` and the live sleeve gates on
   * `classification === 'cheap'`. Under `max` the panel must reproduce that
   * number to floating-point equality on every cheap row, or the panel and the
   * sleeve disagree about which contracts are cheap.
   */
  it('the mixed fixture really has BOTH sides (the parity tests are not vacuous)', () => {
    const body = raw(mixedChain());
    expect(body.candidates.filter((c) => c.mark < c.theo).length).toBeGreaterThan(0);
    expect(body.candidates.filter((c) => c.mark > c.theo).length).toBeGreaterThan(0);
  });

  it('every cheap row equals the ENGINE’s own theo-basis ratio to < 1e-12', () => {
    const engine = new Map(
      findMispricedOtmContracts(mixedChain(), SPOT, { now: NOW }).map((c) => [
        c.optionSymbol,
        c.mispricingPct,
      ]),
    );
    let checked = 0;
    for (const c of raw(mixedChain()).candidates) {
      if (!(c.mark < c.theo)) continue;
      // Against the formula…
      expect(Math.abs(c.mispricingPct - (c.mark - c.theo) / c.theo)).toBeLessThan(1e-12);
      // …and against what the engine actually emitted for that same contract.
      expect(Math.abs(c.mispricingPct - engine.get(c.optionSymbol)!)).toBeLessThan(1e-12);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('every expensive row equals the MARK formula to < 1e-12', () => {
    let checked = 0;
    for (const c of raw(mixedChain()).candidates) {
      if (!(c.mark > c.theo)) continue;
      expect(Math.abs(c.mispricingPct - (c.mark - c.theo) / c.mark)).toBeLessThan(1e-12);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('MUTATION GUARD: the cheap side is NOT the mark basis the flip replaced', () => {
    // States the converse of the parity test explicitly, so re-pointing the
    // default back at `mark` fails with a legible message rather than a bare
    // float mismatch.
    const cheapRows = raw(mixedChain()).candidates.filter((c) => c.mark < c.theo);
    expect(cheapRows.length).toBeGreaterThan(0);
    for (const c of cheapRows) {
      expect(Math.abs(c.mispricingPct - (c.mark - c.theo) / c.mark)).toBeGreaterThan(1e-9);
    }
  });
});

describe('TRA-2661 acceptance 3 — the bound, as a TAUTOLOGY CHECK ONLY', () => {
  /**
   * ⛔ NOT EVIDENCE ABOUT THE MARKET. `|(m−t)/max(m,t)| < 1` holds for every
   * finite positive pair, so this passes on every chain forever — including one
   * whose `theo` is garbage. TRA-2659 retired it as an acceptance criterion for
   * exactly that reason. If it fails, the CODE is wrong, not the tape.
   */
  it('0 rows with |mispricingPct| >= 1, on BOTH the mixed and expensive-tailed chains', () => {
    for (const chain of [expensiveChain(), mixedChain()]) {
      const body = raw(chain);
      expect(body.candidates.length).toBeGreaterThan(0); // not vacuously true
      expect(body.candidates.filter((c) => Math.abs(c.mispricingPct) >= 1)).toHaveLength(0);
    }
  });

  it('the retired bar has NO FAIL STATE under `max` — but it does under the other two', () => {
    // The discriminator the old acceptance lacked. Under `mark` the cheap side
    // blows past 100%; under `theo` the expensive side does. `max` clears both,
    // which is why "under 100%" stopped carrying information the moment `max`
    // became the default.
    expect(worstOn(mixedChain(), 'mark')).toBeGreaterThan(1);
    expect(worstOn(expensiveChain(), 'theo')).toBeGreaterThan(1);
    expect(worstOn(mixedChain(), 'max')).toBeLessThan(1);
    expect(worstOn(expensiveChain(), 'max')).toBeLessThan(1);
  });
});

describe('TRA-2564 history — the finding that forced TRA-2659', () => {
  it('the expensive fixture really is in the artifact regime under the OLD theo basis', () => {
    // Negative control: if this stops holding, the tests above prove nothing,
    // because there was no defect to fix.
    const engine = findMispricedOtmContracts(expensiveChain(), SPOT, { now: NOW });
    expect(Math.max(...engine.map((c) => Math.abs(c.mispricingPct)))).toBeGreaterThan(1.0);
  });

  /**
   * THE LIVE COUNTER-EXAMPLE, pinned as a test so it cannot rot back into
   * folklore. Measured on bqb1 @17f9eae, 2026-07-30 07:48Z, SPY spot 729.46, exp
   * 2026-09-04, `limit=50&minDelta=0`: 25 of 50 rows were CHEAP and the worst read
   * −333.6% on the then-shipped `mark` basis against −76.9% on `theo`.
   *
   * This is what refuted TRA-2564's "bounded by construction" premise and forced
   * the TRA-2659 decision.
   */
  it('the live SPY cheap tail read 333.6% on `mark` — 3.5x WORSE than the basis it replaced', () => {
    // SPY260904C00807000 exactly as the live route returned it.
    const mark = 0.11;
    const theo = 0.47701;
    const markBasis = Math.abs((mark - theo) / mark);
    const theoBasis = Math.abs((mark - theo) / theo);
    const maxBasis = Math.abs((mark - theo) / Math.max(mark, theo));

    expect(markBasis).toBeCloseTo(3.336, 2); // 333.6%
    expect(theoBasis).toBeCloseTo(0.769, 2); // 76.9% — the basis it replaced
    expect(maxBasis).toBeCloseTo(0.769, 2); //  76.9% — max == theo when cheap

    expect(markBasis).toBeGreaterThan(theoBasis);
    expect(markBasis).toBeGreaterThan(1.0);
    expect(maxBasis).toBeLessThan(1.0);

    // ⚠️ 76.9% FAILS the `< 75%` bar TRA-2564 originally set. TRA-2659 retired the
    // bar rather than tuning it to fit — pinned here so nobody re-derives a 2pp
    // adjustment from this row.
    expect(maxBasis).toBeGreaterThan(0.75);
  });
});

describe('TRA-2564 — the pipeline properties the flip must not disturb', () => {
  it('the suppressed footnotes are quoted in the APPLIED basis, not the theo basis', () => {
    const body = route();
    for (const f of [body.theoFloor, body.deltaFloor]) {
      if (f.maxSuppressedMispricingPct !== null) {
        // A theo-basis leak here would be >1 on this fixture.
        expect(Math.abs(f.maxSuppressedMispricingPct)).toBeLessThan(1.0);
      }
    }
  });

  it('rows are ranked by the NEW |mispricingPct|, descending', () => {
    for (const chain of [expensiveChain(), mixedChain()]) {
      const pcts = raw(chain).candidates.map((c) => Math.abs(c.mispricingPct));
      for (let i = 1; i < pcts.length; i += 1) {
        expect(pcts[i - 1]).toBeGreaterThanOrEqual(pcts[i]);
      }
    }
  });

  it('every emitted row is self-consistent with the piecewise definition', () => {
    for (const chain of [expensiveChain(), mixedChain()]) {
      for (const c of raw(chain).candidates) {
        expect(c.mispricingPct).toBeCloseTo((c.mark - c.theo) / Math.max(c.mark, c.theo), 12);
      }
    }
  });
});
