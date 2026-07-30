import { describe, it, expect } from 'vitest';
import {
  findMispricedOtmContracts,
  blackScholesPrice,
  daysToExpiration,
  type OptionChainRow,
} from '@trading-app/engine';
import {
  rebaseOnMark,
  rebaseMispricing,
  parseMispricingBasis,
  OTM_MISPRICING_BASIS,
  OTM_DEFAULT_MISPRICING_BASIS,
  OTM_PANEL_MISPRICING_THRESHOLD,
  type MarkBasisCandidate,
} from './otm-mark-basis.js';
import { applyTheoFloor } from './otm-theo-floor.js';
import { applyDeltaFloor } from './otm-delta-floor.js';

/**
 * TRA-2564 — the mark-basis re-normalisation.
 *
 * Like TRA-2341 and TRA-2388 before it, the rows this touches are
 * ARITHMETICALLY CORRECT under the old formula: there is no wrong sum to catch,
 * so every assertion has to be about the PROJECTION.
 *
 * What these lock down, in order of how much it would hurt to lose:
 *   1. the RE-SORT — the one defect no single row's value can reveal;
 *   2. the direction of the cheap-side shift, which is why the engine is not
 *      touched (it would widen a live entry gate);
 *   3. the panel threshold constant really equals the engine's, driven through
 *      the REAL engine rather than restated;
 *   4. an unusable `mark` cannot masquerade as a mark-basis read;
 *   5. the bound is ONE-SIDED — asserted as a failing cheap row, so that a
 *      future "|pct| < 1" grader cannot be written without tripping this first.
 */

function c(mark: number, theo: number): MarkBasisCandidate & { id: string } {
  return {
    id: `${mark}/${theo}`,
    mark,
    theo,
    // Theo-basis value, exactly as the engine emits it — the input state.
    mispricingPct: (mark - theo) / theo,
    classification: 'fair',
  };
}

describe('rebaseOnMark — the formula', () => {
  it('normalises by mark, not theo', () => {
    // mark 1.20 vs theo 1.00: theo-basis +20%, mark-basis +16.67%.
    const [row] = rebaseOnMark([c(1.2, 1.0)]).candidates;
    expect(row.mispricingPct).toBeCloseTo(0.2 / 1.2, 12);
    expect(row.mispricingPct).not.toBeCloseTo(0.2, 6);
  });

  it('preserves the sign convention: positive is still expensive', () => {
    const { candidates } = rebaseOnMark([c(2.0, 1.0), c(0.5, 1.0)]);
    expect(candidates.find((r) => r.mark === 2.0)!.mispricingPct).toBeGreaterThan(0);
    expect(candidates.find((r) => r.mark === 0.5)!.mispricingPct).toBeLessThan(0);
  });

  it('reports the basis it applied', () => {
    expect(rebaseOnMark([]).basis).toBe('mark');
    expect(OTM_MISPRICING_BASIS).toBe('mark');
  });
});

describe('rebaseOnMark — the re-sort is load-bearing', () => {
  /**
   * The defect this exists to catch: `r ↦ r/(1+r)` is strictly increasing, so
   * re-basing preserves rank WITHIN a sign and inverts it ACROSS signs. The
   * panel ranks on |ratio| and the route slices to top-N AFTER this, so a
   * missing re-sort would emit correct numbers in the wrong order and silently
   * drop the strongest read. No single row's VALUE is wrong in that state.
   */
  it('re-ranks a cheap row above an expensive one when the magnitudes invert', () => {
    const expensive = c(3.0, 1.0); //  theo-basis +200%, mark-basis  +66.7%
    const cheap = c(0.5, 1.0); //  theo-basis  −50%, mark-basis −100.0%

    // Precondition: the ENGINE's order puts expensive first.
    expect(Math.abs(expensive.mispricingPct)).toBeGreaterThan(Math.abs(cheap.mispricingPct));

    const { candidates } = rebaseOnMark([expensive, cheap]);
    // Postcondition: the mark basis inverts it.
    expect(candidates.map((r) => r.id)).toEqual([cheap.id, expensive.id]);
  });

  it('MUTATION CONTROL: the assertion above fails against a rebase that skips the sort', () => {
    const input = [c(3.0, 1.0), c(0.5, 1.0)];
    const unsorted = input.map((r) => ({ ...r, mispricingPct: (r.mark - r.theo) / r.mark }));
    // Same numbers, original order — this is the broken implementation.
    expect(unsorted.map((r) => r.id)).not.toEqual(
      rebaseOnMark(input).candidates.map((r) => r.id),
    );
  });
});

describe('rebaseOnMark — why packages/engine is not touched', () => {
  /**
   * The containment argument in `otm-mark-basis.ts`. The live `single_leg_otm`
   * sleeve gates entry on `classification === 'cheap'`, so if this transform
   * ran in the engine it would move that gate. Pin the DIRECTION and the
   * MAGNITUDE of the shift, because "it only affects the panel" is the claim
   * the whole route-layer decision rests on.
   */
  it('the cheap band is strictly wider on the mark basis, at every ratio', () => {
    for (const x of [0.1, 0.3, 0.5, 0.7, 0.85, 0.95, 0.99]) {
      const theoBasis = Math.abs(x - 1); //   |mark/theo − 1|
      const markBasis = Math.abs(1 - 1 / x); // |1 − theo/mark|
      expect(markBasis).toBeGreaterThan(theoBasis);
    }
  });

  it('at the shipped threshold the cheap admission band widens 0.8500 -> 0.8696 of theo', () => {
    const t = OTM_PANEL_MISPRICING_THRESHOLD;
    // theo basis: cheap iff mark/theo < 1 − t
    expect(1 - t).toBeCloseTo(0.85, 12);
    // mark basis: cheap iff 1 − theo/mark < −t  ⟺  mark/theo < 1/(1 + t)
    expect(1 / (1 + t)).toBeCloseTo(0.8695652, 6);

    // A row inside the widened sliver: `fair` on theo basis, `cheap` on mark basis.
    const sliver = c(0.86, 1.0);
    expect(sliver.mispricingPct).toBeGreaterThan(-t); // engine says fair
    expect(rebaseOnMark([sliver]).candidates[0].classification).toBe('cheap');
  });
});

describe('rebaseOnMark — the threshold', () => {
  const NOW = Date.parse('2024-01-15T15:00:00Z');
  const EXP = '2024-02-15';
  const T = daysToExpiration(EXP, NOW) / 365;
  const R = 0.045;
  const SIGMA = 0.3;
  const SPOT = 100;

  function row(strike: number, markBias: number): OptionChainRow {
    const theo = blackScholesPrice({
      spot: SPOT,
      strike,
      timeToExpiryYears: T,
      riskFreeRate: R,
      volatility: SIGMA,
      optionType: 'call',
    });
    const mark = Math.max(0.05, theo * (1 + markBias));
    const halfSpread = mark * 0.02;
    return {
      optionSymbol: `T${strike}C${markBias}`,
      underlying: 'TEST',
      optionType: 'call',
      strike,
      expiration: EXP,
      bid: mark - halfSpread,
      ask: mark + halfSpread,
      volume: 500,
      openInterest: 1000,
      smvVol: SIGMA,
      midIv: SIGMA,
    };
  }

  /**
   * `OTM_PANEL_MISPRICING_THRESHOLD` duplicates the engine's unexported
   * `DEFAULTS.mispricingThresholdPct`. Pin it by DRIVING THE REAL ENGINE across
   * its own boundary rather than restating the literal — a restated constant
   * agrees with itself no matter what the engine does.
   */
  it('equals the engine default, driven through the real engine', () => {
    const t = OTM_PANEL_MISPRICING_THRESHOLD;
    const chain = [row(110, t + 0.02), row(112, t - 0.02), row(105, 0), row(115, 0)];
    const out = findMispricedOtmContracts(chain, SPOT, { now: NOW });

    const above = out.find((r) => r.strike === 110)!;
    const below = out.find((r) => r.strike === 112)!;
    expect(above.classification).toBe('expensive'); // engine's cutoff is <= t
    expect(below.classification).toBe('fair'); // engine's cutoff is >= t
  });

  it('an explicit threshold moves the cutoff', () => {
    const row0 = c(1.3, 1.0); // mark basis +23.1%
    expect(rebaseOnMark([row0], 0.15).candidates[0].classification).toBe('expensive');
    expect(rebaseOnMark([row0], 0.30).candidates[0].classification).toBe('fair');
  });

  it('a garbage threshold degrades to the panel default, never to all-expensive', () => {
    for (const bad of [NaN, -1, Infinity]) {
      const out = rebaseOnMark([c(1.05, 1.0)], bad); // mark basis +4.8%
      expect(out.threshold).toBe(OTM_PANEL_MISPRICING_THRESHOLD);
      expect(out.candidates[0].classification).toBe('fair');
    }
  });
});

describe('rebaseOnMark — never silent', () => {
  it('neutralises and COUNTS a row whose mark cannot be a denominator', () => {
    // The broken rows must arrive carrying a LOUD theo-basis value, otherwise
    // "neutralised" and "passed straight through" are the same bytes and this
    // test cannot fail. (It could not, until the mutation run caught it.)
    const broken = [
      { ...c(2.0, 1.0), mark: 0, classification: 'expensive' as const }, // pct 1.0 in
      { ...c(2.0, 1.0), mark: NaN, classification: 'expensive' as const },
    ];
    expect(broken.every((r) => r.mispricingPct === 1 && r.classification === 'expensive')).toBe(
      true,
    );

    const out = rebaseOnMark([c(1.5, 1.0), ...broken]); // healthy row re-bases to +0.333
    expect(out.unbasisable).toBe(2);
    const neutralised = out.candidates.filter((x) => !Number.isFinite(x.mark) || x.mark <= 0);
    expect(neutralised).toHaveLength(2);
    for (const r of neutralised) {
      expect(r.mispricingPct).toBe(0);
      expect(r.classification).toBe('fair');
    }
    // And they SINK: un-neutralised they would carry 1.0 and outrank the real
    // read at 0.333, i.e. a broken row would head the panel.
    expect(out.candidates[0].mark).toBe(1.5);
  });

  it('reports 0 unbasisable on a clean chain', () => {
    expect(rebaseOnMark([c(1.2, 1.0), c(0.8, 1.0)]).unbasisable).toBe(0);
  });

  it('does not mutate its input', () => {
    const input = [c(1.2, 1.0)];
    const before = input[0].mispricingPct;
    rebaseOnMark(input);
    expect(input[0].mispricingPct).toBe(before);
  });
});

describe('rebaseOnMark — the bound is ONE-SIDED', () => {
  /**
   * TRA-2564's acceptance calls the mark basis "bounded by construction". It is
   * bounded at +100% on the EXPENSIVE side only. This test exists so that a
   * future grader asserting `|mispricingPct| < 1` on an arbitrary chain cannot
   * be written without tripping it first.
   */
  it('expensive is capped below +100% however small theo gets', () => {
    // theo must be BELOW mark (0.1) for the row to be expensive at all — this
    // is the SPY artifact regime, where theo collapses and the bid holds a tick.
    for (const theo of [0.09, 0.01, 1e-6, 1e-12]) {
      const [r] = rebaseOnMark([c(0.1, theo)]).candidates;
      expect(r.mispricingPct).toBeLessThan(1);
      expect(r.mispricingPct).toBeGreaterThan(0);
    }
  });

  it('cheap is UNBOUNDED below — |pct| well past 100% is a legitimate read', () => {
    const [r] = rebaseOnMark([c(0.05, 0.5)]).candidates;
    expect(r.mispricingPct).toBeCloseTo(-9, 12); // −900%
    expect(Math.abs(r.mispricingPct)).toBeGreaterThan(1);
    expect(r.classification).toBe('cheap');
  });
});

describe('?basis= — the selector, and the DUALITY it exists to measure', () => {
  /**
   * The live 2026-07-30 re-measure refuted TRA-2564's "bounded by construction"
   * premise: SPY read 333.6% on `mark` against 94.1% on `theo`, because SPY's
   * tail is currently CHEAP. These pin the algebra behind that, so the finding
   * cannot quietly rot back into "mark fixed it".
   */
  it('the default is `mark` — the TRA-2562 decision, unchanged by the selector', () => {
    expect(OTM_DEFAULT_MISPRICING_BASIS).toBe('mark');
    expect(rebaseMispricing([c(1.2, 1.0)]).basis).toBe('mark');
    // The alias and the general form must not drift apart.
    expect(rebaseOnMark([c(1.2, 1.0)]).candidates[0].mispricingPct).toBe(
      rebaseMispricing([c(1.2, 1.0)], 'mark').candidates[0].mispricingPct,
    );
  });

  it('each basis uses its own denominator', () => {
    const row = c(1.2, 1.0); // mark 1.2, theo 1.0, diff +0.2
    const pct = (b: 'mark' | 'theo' | 'max') =>
      rebaseMispricing([row], b).candidates[0].mispricingPct;
    expect(pct('mark')).toBeCloseTo(0.2 / 1.2, 12);
    expect(pct('theo')).toBeCloseTo(0.2 / 1.0, 12);
    expect(pct('max')).toBeCloseTo(0.2 / 1.2, 12); // expensive -> max is mark
  });

  it('`max` picks the BOUNDED branch on each side: theo when cheap, mark when expensive', () => {
    const cheap = rebaseMispricing([c(0.5, 1.0)], 'max').candidates[0];
    expect(cheap.mispricingPct).toBeCloseTo(-0.5 / 1.0, 12); // = theo basis
    const exp = rebaseMispricing([c(2.0, 1.0)], 'max').candidates[0];
    expect(exp.mispricingPct).toBeCloseTo(1.0 / 2.0, 12); // = mark basis
  });

  it('THE DUALITY: `theo` blows up on the expensive tail, `mark` on the cheap tail', () => {
    // Expensive tail — the TRA-2388 artifact regime (theo collapses).
    const expensive = c(0.1, 1e-6);
    expect(rebaseMispricing([expensive], 'theo').candidates[0].mispricingPct).toBeGreaterThan(100);
    expect(
      Math.abs(rebaseMispricing([expensive], 'mark').candidates[0].mispricingPct),
    ).toBeLessThan(1);

    // Cheap tail — what SPY actually showed live on 2026-07-30.
    const cheap = c(0.11, 0.477);
    expect(Math.abs(rebaseMispricing([cheap], 'theo').candidates[0].mispricingPct)).toBeLessThan(1);
    expect(
      Math.abs(rebaseMispricing([cheap], 'mark').candidates[0].mispricingPct),
    ).toBeGreaterThan(3); // the live 333.6%

    // ...and `max` is under 100% on BOTH.
    for (const row of [expensive, cheap]) {
      expect(Math.abs(rebaseMispricing([row], 'max').candidates[0].mispricingPct)).toBeLessThan(1);
    }
  });

  it('`max` is bounded below 100% for every ratio, both signs', () => {
    for (const x of [1e-9, 0.01, 0.5, 0.99, 1, 1.01, 2, 100, 1e9]) {
      const [r] = rebaseMispricing([c(x, 1.0)], 'max').candidates;
      expect(Math.abs(r.mispricingPct)).toBeLessThan(1);
    }
  });

  it('an unrecognised ?basis= falls back to the default rather than erroring', () => {
    for (const bad of ['MARK', 'midpoint', '', 'theo ', null, undefined, 42, ['mark']]) {
      expect(parseMispricingBasis(bad)).toBe(OTM_DEFAULT_MISPRICING_BASIS);
    }
    for (const good of ['mark', 'theo', 'max']) {
      expect(parseMispricingBasis(good)).toBe(good);
    }
  });

  it('the result echoes the APPLIED basis, so a typo reads as the fallback it got', () => {
    expect(rebaseMispricing([c(1.2, 1)], parseMispricingBasis('MARK')).basis).toBe('mark');
    expect(rebaseMispricing([c(1.2, 1)], parseMispricingBasis('max')).basis).toBe('max');
  });

  it('a zero/negative denominator is neutralised under EVERY basis', () => {
    // theo <= 0 cannot happen out of the engine, but the guard must not assume it.
    for (const b of ['mark', 'theo', 'max'] as const) {
      const out = rebaseMispricing([{ ...c(2, 1), mark: 0, theo: 0 }], b);
      expect(out.unbasisable).toBe(1);
      expect(out.candidates[0].mispricingPct).toBe(0);
    }
  });
});

describe('rebaseOnMark — composition with the two floors', () => {
  /**
   * Order matters: the route re-bases BEFORE flooring, so both floors'
   * `maxSuppressedMispricingPct` footnotes are quoted in the basis the response
   * advertises. Re-basing afterwards would footnote theo-basis numbers under a
   * `mispricingBasis: 'mark'` label — which reads identically to a correct one.
   */
  it('the suppressed footnote is quoted in the mark basis', () => {
    const artifact = { ...c(0.1, 0.005), delta: 0.001 }; // theo-basis +1900%
    const healthy = { ...c(1.2, 1.0), delta: 0.5 };

    const rebased = rebaseOnMark([artifact, healthy]);
    const floored = applyTheoFloor(rebased.candidates, 0.01);
    expect(floored.suppressed).toBe(1);
    // Mark basis: (0.1 − 0.005)/0.1 = 0.95, NOT the theo-basis 19.0.
    expect(floored.maxSuppressedMispricingPct).toBeCloseTo(0.95, 12);
    expect(floored.maxSuppressedMispricingPct!).toBeLessThan(1);
  });

  it('the delta floor still reads the untouched delta', () => {
    const rebased = rebaseOnMark([
      { ...c(0.1, 0.005), delta: 0.001 },
      { ...c(1.2, 1.0), delta: 0.5 },
    ]);
    const out = applyDeltaFloor(rebased.candidates, 0.02);
    expect(out.suppressed).toBe(1);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0].delta).toBe(0.5);
  });
});
