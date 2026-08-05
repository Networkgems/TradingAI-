import { describe, it, expect } from 'vitest';
import {
  findVerticalArbitrage,
  toArbitrageDiagnostic,
  ARBITRAGE_DETAIL_LIMIT,
  type ArbitrageCandidate,
} from './otm-theo-arbitrage.js';

/**
 * TRA-2662 — the whole point of this suite is that BOTH arms have a real pass
 * state AND a real fail state. Four tickets in this chain died on instruments
 * that could not fail; a monotonicity guard is especially prone to it, because
 * the trivial way to satisfy it is to flatten the surface until nothing moves.
 *
 * So every arm below is asserted in BOTH directions:
 *   • coherent surface   → 0 violations   (the guard is not always-red)
 *   • one row perturbed  → flagged        (the guard is not always-green)
 */

function row(
  strike: number,
  optionType: 'call' | 'put',
  theo: number,
  mark: number,
  expiration = '2026-09-04',
): ArbitrageCandidate {
  return {
    optionSymbol: `X${expiration.replace(/-/g, '')}${optionType[0].toUpperCase()}${strike}`,
    optionType,
    strike,
    expiration,
    theo,
    mark,
  };
}

/** A coherent call surface: both theo and mark strictly decreasing in K. */
const COHERENT_CALLS = [
  row(100, 'call', 5.0, 5.2),
  row(105, 'call', 3.0, 3.1),
  row(110, 'call', 1.5, 1.6),
  row(115, 'call', 0.5, 0.6),
];

/** A coherent put surface: both theo and mark strictly increasing in K. */
const COHERENT_PUTS = [
  row(90, 'put', 0.5, 0.6),
  row(95, 'put', 1.5, 1.6),
  row(100, 'put', 3.0, 3.1),
];

describe('findVerticalArbitrage — the theo arm', () => {
  it('PASSES a coherent call surface (a green is reachable)', () => {
    const r = findVerticalArbitrage(COHERENT_CALLS);
    expect(r.pairsTested).toBe(3);
    expect(r.theoViolations).toHaveLength(0);
    expect(r.worstTheoGapPerContract).toBeNull();
  });

  it('FAILS when a call theo RISES with strike (a red is reachable)', () => {
    // MUTATION: 110's theo lifted above 105's. Nothing else changes.
    const mutated = COHERENT_CALLS.map((c) => (c.strike === 110 ? { ...c, theo: 3.4 } : c));
    const r = findVerticalArbitrage(mutated);
    expect(r.theoViolations).toHaveLength(1);
    const v = r.theoViolations[0];
    expect(v.basis).toBe('theo');
    expect(v.optionType).toBe('call');
    expect(v.lowStrike).toBe(105);
    expect(v.highStrike).toBe(110);
    // (3.4 − 3.0) × 100 = $40/contract of free credit.
    expect(v.gapPerContract).toBeCloseTo(40, 6);
    expect(r.worstTheoGapPerContract).toBeCloseTo(40, 6);
    // The negative control must stay clean — the mutation touched theo only.
    expect(r.markViolations).toHaveLength(0);
  });

  it('PASSES a coherent put surface, and FAILS when a put theo FALLS with strike', () => {
    expect(findVerticalArbitrage(COHERENT_PUTS).theoViolations).toHaveLength(0);
    // MUTATION: 100's theo dropped below 95's — the put-side direction.
    const mutated = COHERENT_PUTS.map((c) => (c.strike === 100 ? { ...c, theo: 1.2 } : c));
    const r = findVerticalArbitrage(mutated);
    expect(r.theoViolations).toHaveLength(1);
    expect(r.theoViolations[0].optionType).toBe('put');
    expect(r.theoViolations[0].gapPerContract).toBeCloseTo(30, 6);
  });
});

describe('findVerticalArbitrage — the mark arm (negative control)', () => {
  it('PASSES a coherent market surface', () => {
    const r = findVerticalArbitrage([...COHERENT_CALLS, ...COHERENT_PUTS]);
    expect(r.markViolations).toHaveLength(0);
  });

  it('FAILS a crossed market surface — the control is NOT hard-wired to zero', () => {
    // This is the arm most likely to rot into a tautology: if `markViolations`
    // could never be non-zero, "mark: 0" would be decoration rather than a
    // control, and the theo arm would have nothing to be graded against.
    const mutated = COHERENT_CALLS.map((c) => (c.strike === 110 ? { ...c, mark: 3.9 } : c));
    const r = findVerticalArbitrage(mutated);
    expect(r.markViolations).toHaveLength(1);
    expect(r.markViolations[0].basis).toBe('mark');
    expect(r.markViolations[0].gapPerContract).toBeCloseTo(80, 6);
    // ...and the model arm stays clean, so the two are independently sourced.
    expect(r.theoViolations).toHaveLength(0);
  });
});

describe('findVerticalArbitrage — grouping and edges', () => {
  it('does not compare across expirations or across option types', () => {
    // A Sep call at 0.5 and an Oct call at 9.9 are NOT a vertical pair; nor is a
    // call vs a put at the same strike. If the grouping key were dropped, the
    // sorted sequence would interleave and manufacture violations.
    const mixed = [
      row(100, 'call', 5.0, 5.2, '2026-09-04'),
      row(105, 'call', 3.0, 3.1, '2026-09-04'),
      row(100, 'call', 9.0, 9.2, '2026-10-16'),
      row(105, 'call', 7.0, 7.1, '2026-10-16'),
      row(95, 'put', 1.0, 1.1, '2026-09-04'),
      row(100, 'put', 2.0, 2.1, '2026-09-04'),
    ];
    const r = findVerticalArbitrage(mixed);
    expect(r.theoViolations).toHaveLength(0);
    expect(r.markViolations).toHaveLength(0);
    // 3 buckets × 1 adjacent pair each.
    expect(r.pairsTested).toBe(3);
  });

  it('reports pairsTested 0 for a chain too thin to test — NOT a pass', () => {
    // `0 violations / 0 pairs` is the vacuous green this ticket chain kept
    // hitting. The detector must make it visible rather than report a bare 0.
    const r = findVerticalArbitrage([row(100, 'call', 5, 5.2)]);
    expect(r.pairsTested).toBe(0);
    expect(r.theoViolations).toHaveLength(0);
  });

  it('skips a non-finite value on ONE surface without shrinking the other arm', () => {
    const rows = [
      row(100, 'call', 5.0, 5.2),
      { ...row(105, 'call', Number.NaN, 3.1) },
      row(110, 'call', 1.5, 1.6),
    ];
    const r = findVerticalArbitrage(rows);
    // Both theo pairs involving the NaN row are skipped; mark is still fully
    // tested across all 2 pairs and stays clean.
    expect(r.theoViolations).toHaveLength(0);
    expect(r.markViolations).toHaveLength(0);
    expect(r.pairsTested).toBe(2);
  });

  it('sorts by strike rather than trusting input order', () => {
    const shuffled = [COHERENT_CALLS[2], COHERENT_CALLS[0], COHERENT_CALLS[3], COHERENT_CALLS[1]];
    expect(findVerticalArbitrage(shuffled).theoViolations).toHaveLength(0);
  });
});

describe('the live defect — regression fixture from bqb1 9fbc9077, 2026-08-05T10:29Z', () => {
  // Served values, copied from the capture. These are the rows the panel
  // actually returned; if a future refactor stops flagging them, the guard has
  // regressed against the real defect rather than against a synthetic one.
  const SPY_PUTS = [
    row(600, 'put', 0.4634, 0.47, '2026-09-18'),
    row(625, 'put', 0.3442, 0.55, '2026-09-18'),
    row(650, 'put', 1.3092, 1.36, '2026-09-18'),
    row(675, 'put', 1.3034, 2.32, '2026-09-18'),
  ];
  const TSLA_CALLS = [
    row(500, 'call', 0.5172, 0.53, '2026-09-18'),
    row(555, 'call', 0.6362, 0.30, '2026-09-18'),
  ];

  it('flags the two SPY put violations and the TSLA call violation', () => {
    const r = findVerticalArbitrage([...SPY_PUTS, ...TSLA_CALLS]);
    expect(r.theoViolations).toHaveLength(3);
    const pairs = r.theoViolations.map((v) => `${v.optionType}:${v.lowStrike}/${v.highStrike}`);
    expect(pairs).toContain('put:600/625');
    expect(pairs).toContain('put:650/675');
    expect(pairs).toContain('call:500/555');
  });

  it('finds the market coherent on the SAME rows — model broken, tape not', () => {
    // This is the comparison that makes the finding mean something. Same rows,
    // same detector, same instant: only the `theo` column violates.
    const r = findVerticalArbitrage([...SPY_PUTS, ...TSLA_CALLS]);
    expect(r.markViolations).toHaveLength(0);
  });

  it('reports the worst gap in dollars per contract', () => {
    const r = findVerticalArbitrage([...SPY_PUTS, ...TSLA_CALLS]);
    // SPY 600/625: |0.3442 − 0.4634| × 100 = $11.92.
    expect(r.worstTheoGapPerContract).toBeCloseTo(11.92, 2);
  });
});

describe('toArbitrageDiagnostic', () => {
  it('reports exact counts and caps only the detail array', () => {
    // 12 violating call pairs → counts must stay exact, detail capped at 10.
    const many: ArbitrageCandidate[] = [];
    for (let i = 0; i < 13; i += 1) many.push(row(100 + i, 'call', 1 + i * 0.1, 5 - i * 0.1));
    const d = toArbitrageDiagnostic(findVerticalArbitrage(many));
    expect(d.pairsTested).toBe(12);
    expect(d.theoViolations).toBe(12);
    expect(d.markViolations).toBe(0);
    expect(d.violations).toHaveLength(ARBITRAGE_DETAIL_LIMIT);
  });

  it('orders the detail worst-first and tags each entry with its basis', () => {
    const rows = COHERENT_CALLS.map((c) =>
      c.strike === 110 ? { ...c, theo: 3.4, mark: 4.5 } : c,
    );
    const d = toArbitrageDiagnostic(findVerticalArbitrage(rows));
    expect(d.theoViolations).toBe(1);
    expect(d.markViolations).toBe(1);
    // mark gap ($140) > theo gap ($40), so mark leads.
    expect(d.violations[0].basis).toBe('mark');
    expect(d.violations[1].basis).toBe('theo');
  });

  it('emits a zero-violation diagnostic rather than nothing on a clean chain', () => {
    // Presence of the key is what distinguishes "measured, clean" from "build
    // without the guard". An absent key reads identically to a pass.
    const d = toArbitrageDiagnostic(findVerticalArbitrage(COHERENT_CALLS));
    expect(d).toMatchObject({ pairsTested: 3, theoViolations: 0, markViolations: 0 });
    expect(d.worstTheoGapPerContract).toBeNull();
    expect(d.violations).toEqual([]);
  });
});
