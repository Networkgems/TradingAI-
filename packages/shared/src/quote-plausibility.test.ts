import { describe, it, expect } from 'vitest';
import {
  SUSPECT_MOVE_RATIO,
  assessQuotePlausibility,
  describeQuoteSuspicion,
  impliedPrevClose,
  isQuoteMoveSuspect,
  isMoveSuspect,
  type QuoteMoveRow,
} from './quote-plausibility.js';

/**
 * TRA-2379 — every case below is a VERBATIM row from the live bqb1 `/api/state`
 * read of 2026-07-26T06:58:35Z (587 symbols), not a hand-invented number.
 *
 * Both directions of control are asserted on purpose, because a one-directional
 * control is half a control: the known-bad must FIRE, and the known-good must stay
 * SILENT. A detector that only proves it can see FFAI would also pass while
 * flagging every microcap on the board.
 */

/** The defect. price 6.49 against an unadjusted prev close of 0.07 => r = 92.71. */
const FFAI = { symbol: 'FFAI', price: 6.49, change: 6.42, changePct: 8951.61 };

/**
 * The six genuine sub-$7 microcap movers from the same read. These are the
 * false-positive population the ticket specifically demanded be checked on the
 * finer partition — 25-40% single-session moves that are REAL.
 */
const GENUINE_MICROCAPS = [
  { symbol: 'GSUN', price: 0.21, change: -0.14, changePct: -39.60 }, // largest genuine mover on the tape
  { symbol: 'JEM', price: 6.35, change: 1.61, changePct: 33.97 },
  { symbol: 'BIYA', price: 1.93, change: -0.75, changePct: -27.99 },
  { symbol: 'ATER', price: 0.40, change: -0.15, changePct: -27.10 },
  { symbol: 'LGHL', price: 0.91, change: -0.33, changePct: -26.58 },
  { symbol: 'AEHL', price: 0.54, change: -0.18, changePct: -25.07 },
];

/** Ordinary large-cap rows from the same read. */
const ORDINARY = [
  { symbol: 'AAPL', price: 333.02, change: 11.36, changePct: 3.54 },
  { symbol: 'ZVRA', price: 9.53, change: -3.00, changePct: -23.93 },
  { symbol: 'MXL', price: 71.59, change: -19.65, changePct: -21.54 },
];

describe('TRA-2379 quote plausibility — the threshold itself', () => {
  it('is pinned to the smallest real corporate-action factor', () => {
    // If someone moves this, the reasoning in the module header no longer holds:
    // any value above 2 opens a hole at a 2:1 / 1:2 split.
    expect(SUSPECT_MOVE_RATIO).toBe(2);
  });
});

describe('TRA-2379 known-BAD control — the detector must fire', () => {
  it('flags the live FFAI row and reports the ratio, without touching the numbers', () => {
    const v = assessQuotePlausibility(FFAI);
    expect(v.suspect).toBe(true);
    expect(v.reason).toBe('implausible_move_ratio');
    expect(v.impliedPrevClose).toBeCloseTo(0.07, 2);
    expect(v.ratio).toBeCloseTo(92.71, 1);
    // Flag, never clamp (decision 1): the input object is not mutated.
    expect(FFAI.changePct).toBe(8951.61);
    expect(FFAI.change).toBe(6.42);
  });

  it('flags an impossible (non-positive) implied previous close', () => {
    const v = assessQuotePlausibility({ price: 5, change: 5 }); // prev = 0
    expect(v.suspect).toBe(true);
    expect(v.reason).toBe('nonpositive_prev_close');
  });

  it('flags a non-finite change percentage', () => {
    expect(assessQuotePlausibility({ price: 10, changePct: NaN }).reason).toBe('non_finite');
    expect(assessQuotePlausibility({ price: 10, change: Infinity }).reason).toBe('non_finite');
  });
});

describe('TRA-2379 known-GOOD control — the detector must stay silent', () => {
  it.each(GENUINE_MICROCAPS)('does NOT flag the genuine microcap mover $symbol ($changePct%)', (row) => {
    const v = assessQuotePlausibility(row);
    expect(v.suspect).toBe(false);
    // and it stays comfortably under the bar, so this is not a near-miss pass
    expect(v.ratio).toBeLessThan(SUSPECT_MOVE_RATIO);
  });

  it.each(ORDINARY)('does NOT flag the ordinary row $symbol', (row) => {
    expect(isQuoteMoveSuspect(row)).toBe(false);
  });

  it('leaves the no-quote rows to the existing unavailable/rate_limited statuses', () => {
    // SBLX on the 07-26 tape: price 0, already quoteStatus:'unavailable'. The
    // predicate must not reclassify it — price <= 0 is not our jurisdiction.
    expect(assessQuotePlausibility({ price: 0, change: 0, changePct: 0 }).suspect).toBe(false);
    expect(assessQuotePlausibility({ price: -1, changePct: 5 }).suspect).toBe(false);
  });

  it('says nothing about a quote that carries no move at all', () => {
    expect(assessQuotePlausibility({ price: 10 }).suspect).toBe(false);
  });

  it('does not flag a perfectly flat session', () => {
    expect(assessQuotePlausibility({ price: 10, change: 0, changePct: 0 }).suspect).toBe(false);
  });
});

describe('TRA-2379 direction symmetry — the reason a ratio was chosen over a flat percent', () => {
  // A flat 100% threshold catches NO forward-split artefact at any factor, because
  // changePct is bounded below at -100%. The ratio statistic is direction-free.
  const factors = [2, 3, 5, 10, 50, 100];

  it.each(factors)('flags an unadjusted 1:%i REVERSE split (large positive changePct)', (k) => {
    const price = 10;
    const prev = price / k;
    const row = { price, change: price - prev, changePct: (k - 1) * 100 };
    const v = assessQuotePlausibility(row);
    expect(v.suspect).toBe(true);
    expect(v.ratio).toBeCloseTo(k, 6);
  });

  it.each(factors)('flags an unadjusted %i:1 FORWARD split (large negative changePct)', (k) => {
    const price = 10;
    const prev = price * k;
    const row = { price, change: price - prev, changePct: (1 / k - 1) * 100 };
    const v = assessQuotePlausibility(row);
    expect(v.suspect).toBe(true);
    expect(v.ratio).toBeCloseTo(k, 6);
    // the whole point: a flat 100% test could never have seen this one
    expect(Math.abs(row.changePct)).toBeLessThan(100);
  });

  it('gives the SAME ratio to a reverse and a forward split of the same factor', () => {
    const up = assessQuotePlausibility({ price: 10, change: 8, changePct: 400 });
    const down = assessQuotePlausibility({ price: 10, change: -40, changePct: -80 });
    expect(up.ratio).toBeCloseTo(5, 6);
    expect(down.ratio).toBeCloseTo(5, 6);
  });
});

describe('TRA-2379 boundary behaviour', () => {
  it('fires exactly AT the threshold, not just above it', () => {
    // a 2:1 split: price 10, prev 20 => r = 2 exactly
    expect(assessQuotePlausibility({ price: 10, change: -10, changePct: -50 }).suspect).toBe(true);
    // just inside: r = 1.98
    expect(assessQuotePlausibility({ price: 10, change: -9.8989898, changePct: -49.75 }).suspect).toBe(false);
  });

  it('recovers the previous close from the percentage when no absolute change is given', () => {
    // the Tradier / Yahoo-quote paths supply a provider percentage directly
    expect(impliedPrevClose({ price: 6.49, changePct: 8951.61 })).toBeCloseTo(0.0717, 3);
    expect(assessQuotePlausibility({ price: 6.49, changePct: 8951.61 }).suspect).toBe(true);
  });
});

describe('TRA-2379 exclusion log line', () => {
  it('names the symbol, the reason, the implied prev close and the threshold', () => {
    // A silent drop reads identically to "nothing was wrong" (decision 2), so the
    // log line has to carry enough to act on without re-deriving anything.
    const line = describeQuoteSuspicion('FFAI', FFAI);
    expect(line).toContain('FFAI');
    expect(line).toContain('implausible_move_ratio');
    expect(line).toContain('impliedPrevClose=0.07');
    expect(line).toContain('threshold=2');
    expect(line).toContain('8951.61');
  });

  it('says "plausible" for a row it did not flag', () => {
    expect(describeQuoteSuspicion('AAPL', ORDINARY[0])).toContain('plausible');
  });
});

/**
 * TRA-2610 — `isMoveSuspect` is the CONSUMER-side predicate, and it exists because
 * the old one keyed on the ABSENCE of a flag that a later write erased.
 *
 * The live row, verbatim from `/api/reports/2026-07-29` and the `/api/state` read
 * behind it: FGMC printed `price 8.30`, `changePct +110.66` (`ratio 2.107` vs the
 * threshold of 2), was flagged, and was then re-stamped `quoteStatus:'unavailable'`
 * by the next failed fetch 104 minutes later — which erased the verdict and put the
 * fabrication at #1 in the shipped EOD report two days running.
 */
const FGMC = { price: 8.30, changePct: 110.66 };

describe('TRA-2610 isMoveSuspect — the flag and the rule, so neither can be erased', () => {
  it('flags the live FGMC row from the RULE ALONE, with no flag present at all', () => {
    // The load-bearing case. If the producer ever drops the stamp again — a new
    // write path, a refactor, a persisted row from an older build — the consumer
    // still refuses the row. A flag-only guard is least reliable on exactly the
    // thin, badly-quoted names most likely to be fabricated.
    expect(isMoveSuspect(FGMC)).toBe(true);
    expect(assessQuotePlausibility(FGMC).ratio).toBeCloseTo(2.107, 3);
  });

  it('honours an explicit flag on numbers the rule would pass', () => {
    // The producer saw inputs the row no longer carries. A consumer must not
    // silently overrule the stamp published on /api/state.
    expect(isMoveSuspect({ price: 100, changePct: 1, moveSuspect: true })).toBe(true);
  });

  it('is unchanged by a freshness stamp — the whole point of the split', () => {
    // The two facts now live in two fields, so there is nothing for a
    // `quoteStatus` write to overwrite. Passing one changes nothing.
    // Typed as a real symbol row (which carries both fields) so the excess-property
    // check does not hide the point: the predicate ignores `quoteStatus` entirely.
    const row = (quoteStatus: string): QuoteMoveRow & { quoteStatus: string } =>
      ({ ...FGMC, moveSuspect: true, quoteStatus });
    expect(isMoveSuspect(row('unavailable'))).toBe(true);
    expect(isMoveSuspect(row('rate_limited'))).toBe(true);
    expect(isMoveSuspect(row('ok'))).toBe(true);
  });

  it('known-GOOD control: stays silent on a genuine mover, flagged or not', () => {
    // The other half of the control. A predicate that flagged everything would
    // pass every assertion above while discriminating nothing.
    for (const row of GENUINE_MICROCAPS) {
      expect(isMoveSuspect(row)).toBe(false);
      expect(isMoveSuspect({ ...row, moveSuspect: false })).toBe(false);
    }
    for (const row of ORDINARY) expect(isMoveSuspect(row)).toBe(false);
  });

  it('does NOT treat a missing price or a missing move as suspect', () => {
    // An unavailable row that never carried a fabricated move must stay rankable
    // on its own merits — the fix must not degrade into "exclude everything stale",
    // which would pass the FGMC test vacuously.
    expect(isMoveSuspect({})).toBe(false);
    expect(isMoveSuspect({ price: 0, change: 0, changePct: 0 })).toBe(false);
    expect(isMoveSuspect({ price: 8.30 })).toBe(false);
  });
});
