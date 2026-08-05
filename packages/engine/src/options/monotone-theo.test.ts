import { describe, it, expect } from 'vitest';
import { pavaMonotone, type MonotoneDirection } from './monotone-theo.js';

function isMonotone(values: number[], direction: MonotoneDirection): boolean {
  for (let i = 0; i + 1 < values.length; i += 1) {
    // Strict-inequality violation predicate — same as the TRA-2662 guard, so
    // ties (flat segments) pass.
    const bad =
      direction === 'nonincreasing' ? values[i + 1] > values[i] : values[i + 1] < values[i];
    if (bad) return false;
  }
  return true;
}

describe('pavaMonotone', () => {
  it('is the identity on already-monotone input (values returned unchanged, ===)', () => {
    const inc = [0.1, 0.5, 0.5, 1.3, 2.7];
    expect(pavaMonotone(inc, 'nondecreasing')).toEqual(inc);
    const dec = [5.2, 3.0, 1.5, 1.5, 0.2];
    expect(pavaMonotone(dec, 'nonincreasing')).toEqual(dec);
    // Not merely close — byte-identical elements.
    pavaMonotone(inc, 'nondecreasing').forEach((v, i) => expect(v).toBe(inc[i]));
  });

  it('pools a single violating pair to its mean', () => {
    // Nondecreasing (put direction): 0.5 > 0.3 violates → both become 0.4.
    expect(pavaMonotone([0.5, 0.3], 'nondecreasing')).toEqual([0.4, 0.4]);
    // Nonincreasing (call direction): 3 < 5 violates → both become 4.
    expect(pavaMonotone([3, 5], 'nonincreasing')).toEqual([4, 4]);
  });

  it('handles multi-block pooling with back-merging', () => {
    // Nondecreasing: [3, 1, 2] → pooling 3,1 gives 2,2; next value 2 ties, so
    // the result is [2, 2, 2]. Then [4, 3, 1, 5]: 4,3 → 3.5; 3.5 > 1 → pool all
    // three → 8/3; 5 stays.
    expect(pavaMonotone([3, 1, 2], 'nondecreasing')).toEqual([2, 2, 2]);
    const r = pavaMonotone([4, 3, 1, 5], 'nondecreasing');
    expect(r.slice(0, 3)).toEqual([8 / 3, 8 / 3, 8 / 3]);
    expect(r[3]).toBe(5);
    expect(isMonotone(r, 'nondecreasing')).toBe(true);
  });

  it('leaves ties as ties (flat segments pass the strict guard)', () => {
    const flat = [1.5, 1.5, 1.5];
    expect(pavaMonotone(flat, 'nondecreasing')).toEqual(flat);
    expect(pavaMonotone(flat, 'nonincreasing')).toEqual(flat);
  });

  it('handles empty and single-element input', () => {
    expect(pavaMonotone([], 'nondecreasing')).toEqual([]);
    expect(pavaMonotone([0.42], 'nonincreasing')).toEqual([0.42]);
  });

  it('projection is monotone for both directions on adversarial input', () => {
    const values = [5, 1, 4, 2, 3, 3, 0.5, 6];
    expect(isMonotone(pavaMonotone(values, 'nondecreasing'), 'nondecreasing')).toBe(true);
    expect(isMonotone(pavaMonotone(values, 'nonincreasing'), 'nonincreasing')).toBe(true);
  });

  // Mutation control — the repair DIRECTION must be able to fail. Feeding the
  // deliberately wrong direction flag to a violating ladder must produce output
  // that fails the correct-direction predicate; if this ever passes, the assert
  // upstream is vacuous (the TRA-2331 class: a mutation test that cannot mutate
  // reads as passing).
  it('mutation control: the wrong direction flag flips the monotonicity assert', () => {
    // Chosen so the WRONG-direction projection is not flat (a flat sequence is
    // monotone both ways and would let a broken direction flag pass):
    // nonincreasing-PAVA on [5, 1, 2] pools only the tail → [5, 1.5, 1.5],
    // which FAILS the nondecreasing predicate the put ladder requires.
    const putLadder = [5, 1, 2]; // violates nondecreasing at idx 0→1
    const wrong = pavaMonotone(putLadder, 'nonincreasing'); // deliberately wrong
    expect(wrong).toEqual([5, 1.5, 1.5]);
    expect(isMonotone(wrong, 'nondecreasing')).toBe(false);
    const right = pavaMonotone(putLadder, 'nondecreasing');
    expect(isMonotone(right, 'nondecreasing')).toBe(true);
  });
});

/**
 * Regression fixture — the live 2026-08-05T10:38Z capture's three theo
 * violations (the failing cell has rotated again vs prior captures, which is
 * the reason the repair has zero tunable parameters): SPY put 600/625
 * 0.4631 → 0.3440, SPY put 660/675 1.3931 → 1.3030, TSLA call 500/555
 * 0.5169 → 0.6359. Neighbouring strikes are coherent fillers; the assertions
 * that matter are (a) post-repair monotonicity and (b) every non-violating row
 * unchanged to the cent (exact ===, not closeTo).
 */
describe('TRA-2917 regression — live 2026-08-05T10:38Z violations', () => {
  it('repairs the two SPY put violations and leaves coherent strikes untouched', () => {
    //            575   600      625     650   660      675     700
    const theos = [0.3, 0.4631, 0.344, 0.9, 1.3931, 1.303, 2.5];
    const repaired = pavaMonotone(theos, 'nondecreasing');

    expect(isMonotone(repaired, 'nondecreasing')).toBe(true);
    // Violating pairs pooled to their means…
    const pooled600 = (0.4631 + 0.344) / 2;
    const pooled660 = (1.3931 + 1.303) / 2;
    expect(repaired[1]).toBeCloseTo(pooled600, 10);
    expect(repaired[2]).toBeCloseTo(pooled600, 10);
    expect(repaired[4]).toBeCloseTo(pooled660, 10);
    expect(repaired[5]).toBeCloseTo(pooled660, 10);
    // …and the coherent rows byte-unchanged.
    expect(repaired[0]).toBe(0.3);
    expect(repaired[3]).toBe(0.9);
    expect(repaired[6]).toBe(2.5);
  });

  it('repairs the TSLA call violation and leaves coherent strikes untouched', () => {
    //            450   500      555     600
    const theos = [1.2, 0.5169, 0.6359, 0.25];
    const repaired = pavaMonotone(theos, 'nonincreasing');

    expect(isMonotone(repaired, 'nonincreasing')).toBe(true);
    const pooled = (0.5169 + 0.6359) / 2;
    expect(repaired[1]).toBeCloseTo(pooled, 10);
    expect(repaired[2]).toBeCloseTo(pooled, 10);
    expect(repaired[0]).toBe(1.2);
    expect(repaired[3]).toBe(0.25);
  });
});
