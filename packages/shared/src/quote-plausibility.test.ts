import { describe, it, expect } from 'vitest';
import {
  SUSPECT_MOVE_RATIO,
  assessQuotePlausibility,
  describeQuoteSuspicion,
  impliedPrevClose,
  isQuoteMoveSuspect,
  isMoveSuspect,
  assessLevelContinuity,
  describeLevelContinuity,
  CONTINUITY_RESIDUAL_TOLERANCE,
  REPUBLICATION_CHANGE_PCT_EPSILON,
  corporateActionFactor,
  corporateActionInSessionWindow,
  describeCorporateAction,
  type QuoteMoveRow,
  type CorporateAction,
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

// ── TRA-2634 — LEVEL CONTINUITY ───────────────────────────────────────────────
//
// Every pair below is a VERBATIM adjacent-session pair pulled out of the stored
// report archive on 2026-07-30 (`/api/reports/{date}?mode={fold}` -> `top5Movers`,
// full JSON precision, bqb1 all three folds 2026-05-03 -> 07-30 plus the
// localhost archive). Not one is hand-invented, and the offenders and the
// known-goods come from the SAME population — the point of the measurement was
// that a hand-picked control set proves only that the grader agrees with itself.

/**
 * OFFENDERS the deployed session-move rule already catches. Kept so a regression
 * that breaks the OR shows up as a change here rather than as silence.
 */
const CONTINUITY_BAD_ALREADY_CAUGHT = [
  { // the ticket's headline: FROZEN $8.30, changePct moved +69.04% -> +110.66%
    symbol: 'FGMC', priorDate: '2026-07-28',
    prior: { price: 8.3, changePct: 69.04276985743381 },
    current: { price: 8.3, changePct: 110.6598984771574 },
    residual: 2.106599,
  },
  { symbol: 'SDOT', priorDate: '2026-06-23',
    prior: { price: 9.25, changePct: -42.84 },
    current: { price: 21.45, changePct: 247.09 },
    residual: 1.496775 },
  { symbol: 'JEM', priorDate: '2026-07-13',
    prior: { price: 0.5412, changePct: -51.68 },
    current: { price: 6.05, changePct: 1102.07 },
    residual: 1.075306 },
];

/**
 * ⭐ THE POPULATION THIS TICKET EXISTS FOR: offenders the deployed r >= 2 rule
 * PASSES and ranked anyway. Six real archived rows. If this list ever empties,
 * the instrument has stopped adding anything over TRA-2379.
 */
const CONTINUITY_BAD_NEW = [
  { // TRA-2634 positive control #2 — FROZEN $0.02, +100.00% -> +33.34%, r = 1.3334
    symbol: 'FLYYQ', priorDate: '2026-07-16',
    prior: { price: 0.02, changePct: 100 },
    current: { price: 0.02, changePct: 33.34 },
    residual: 1.3334, sessionRatio: 1.3334,
  },
  { // price MOVED 38.51 -> 36.18 yet the implied prev close is 26.59, not 38.51
    symbol: 'VEEE', priorDate: '2026-07-15',
    prior: { price: 38.51, changePct: 54.91 },
    current: { price: 36.18, changePct: 36.07 },
    residual: 1.448329, sessionRatio: 1.3607,
  },
  { symbol: 'ABTC', priorDate: '2026-07-07',
    prior: { price: 6.52, changePct: -23.2038 },
    current: { price: 5.86, changePct: -30.977620730270907 },
    residual: 1.302147, sessionRatio: 1.4488 },
  { // the "+99% fabrication is caught by nothing today" case, live in the archive
    symbol: 'CRNX', priorDate: '2026-07-07',
    prior: { price: 83.53, changePct: 98.739 },
    current: { price: 83.49, changePct: 98.64382583868664 },
    residual: 1.987390, sessionRatio: 1.9864,
  },
  { symbol: '000660.KS', priorDate: '2026-07-13',
    prior: { price: 1845000, changePct: -15.366973 },
    current: { price: 2117000, changePct: 10.663878 },
    residual: 1.036856, sessionRatio: 1.1066 },
  { // the TIGHTEST real offender — 2.5%. No session-move test reaches this at any threshold.
    symbol: 'TDIC', priorDate: '2026-06-17',
    prior: { price: 7.6, changePct: 39.97 },
    current: { price: 6.13, changePct: -21.31 },
    residual: 1.025008, sessionRatio: 1.2708,
  },
];

/**
 * KNOWN-GOOD: real adjacent-session pairs whose implied prev close reproduces our
 * own published close. Includes the two rows that make the point loudest —
 * FLYYQ `0.01 -> 0.02 / +100%` (which the SESSION rule calls suspect at r = 2.000
 * exactly) and DFNS `13.10 -> 24 / +83.21%` (the row an earlier TRA-2610 checker
 * falsely condemned by joining a dated artifact to a live tape).
 */
const CONTINUITY_GOOD = [
  { symbol: 'FLYYQ', priorDate: '2026-07-23',
    prior: { price: 0.01, changePct: -50 }, current: { price: 0.02, changePct: 100 } },
  { symbol: 'DFNS', priorDate: '2026-07-28',
    prior: { price: 13.1, changePct: 201.15 }, current: { price: 24, changePct: 83.21 } },
  { symbol: 'VRAX', priorDate: '2026-07-10',
    prior: { price: 6.36, changePct: 100 }, current: { price: 4.08, changePct: -35.85 } },
  { symbol: 'HTCO', priorDate: '2026-05-11',
    prior: { price: 7.05, changePct: 20.72 }, current: { price: 11.28, changePct: 60 } },
  { symbol: 'TDIC', priorDate: '2026-06-15',
    prior: { price: 5.43, changePct: 2263.96 }, current: { price: 7.6, changePct: 39.97 } },
  { symbol: 'INLF', priorDate: '2026-07-01',
    prior: { price: 0.0328, changePct: -42.96 }, current: { price: 0.0216, changePct: -34.15 } },
  { symbol: 'ATLN', priorDate: '2026-06-23',
    prior: { price: 1.33, changePct: 202.41 }, current: { price: 0.7801, changePct: -41.35 } },
  { // the WORST healthy pair measured, 1.0056 — most likely a stale prior snapshot
    // ($30.84 published vs $30.67 implied). This is the row that sizes the headroom.
    symbol: 'NVTS', priorDate: '2026-06-03',
    prior: { price: 30.84, changePct: 19.2575 }, current: { price: 25.08, changePct: -18.2263 } },
];

/**
 * REPUBLICATIONS — 189 of 223 adjacent-session pairs on bqb1. A report generated
 * for date D off a tape that never advanced past D-1. There is no second
 * observation here, so there is nothing to be continuous with. Grading them fires
 * on 87% of everything, which is a rubber stamp with an alarm attached.
 *
 * SNDK and LEGN are why the `changePct` comparison is a TOLERANCE and not `===`:
 * the same observation re-serialised at a different precision.
 */
const CONTINUITY_REPUBLICATIONS = [
  { symbol: 'SOXL', prior: { price: 91.99, changePct: -16.0215 }, current: { price: 91.99, changePct: -16.0215 } },
  { symbol: 'CLPT', prior: { price: 16.81, changePct: 26.02 }, current: { price: 16.81, changePct: 26.02 } },
  { symbol: 'SELX', prior: { price: 0.34, changePct: 844.4444444444447 }, current: { price: 0.34, changePct: 844.4444444444447 } },
  { symbol: 'SNDK', prior: { price: 2184.75, changePct: 11.5351 }, current: { price: 2184.75, changePct: 11.535121 } },
  { symbol: 'LEGN', prior: { price: 27.93, changePct: -16.6766 }, current: { price: 27.93, changePct: -16.67661 } },
];

describe('TRA-2634 continuity threshold — derived, and controlled on both sides', () => {
  it('sits in the empty band the archive measured, with a control at each edge', () => {
    // Worst healthy pair 1.005543 (NVTS) < tolerance < tightest real offender
    // 1.025008 (TDIC). Moving this constant outside that band breaks one of the
    // two control sets below, which is the only reason it is safe to have a
    // constant here at all.
    expect(CONTINUITY_RESIDUAL_TOLERANCE).toBeGreaterThan(1.005543);
    expect(CONTINUITY_RESIDUAL_TOLERANCE).toBeLessThan(1.025008);
    // And it must stay far below the smallest corporate action (a factor of 2),
    // or it would start masking the artefact class it exists to catch.
    expect(CONTINUITY_RESIDUAL_TOLERANCE).toBeLessThan(SUSPECT_MOVE_RATIO);
  });

  it('the republication epsilon is under the publication grid and far under a real move', () => {
    expect(REPUBLICATION_CHANGE_PCT_EPSILON).toBeLessThan(0.005 * 4); // 2-dp grid
    // FGMC's move is 41.6 percentage points — 4,000x the epsilon.
    expect(REPUBLICATION_CHANGE_PCT_EPSILON * 1000).toBeLessThan(41.6);
  });
});

describe('TRA-2634 known-BAD control — the continuity check must fire', () => {
  it.each(CONTINUITY_BAD_NEW)(
    'flags $symbol, which the deployed r>=2 rule PASSES (residual $residual)',
    ({ symbol, priorDate, prior, current, residual, sessionRatio }) => {
      // Leg 1: the deployed session-move rule genuinely does not see this row.
      // Without this assertion the test could pass on a row TRA-2379 already
      // caught, and the new instrument would be measuring nothing.
      expect(isQuoteMoveSuspect(current)).toBe(false);
      expect(assessQuotePlausibility(current).ratio).toBeCloseTo(sessionRatio, 3);
      // Leg 2: the continuity rule does.
      const v = assessLevelContinuity(prior, current);
      expect(v.verdict).toBe('suspect');
      expect(v.reason).toBe('level_discontinuity');
      expect(v.residual).toBeCloseTo(residual, 4);
      expect(v.priorClose).toBe(prior.price);
      // Flag, never clamp (TRA-2379 decision 1) — inputs untouched.
      expect(current.changePct).toBe(current.changePct);
      expect(describeLevelContinuity(symbol, priorDate, prior, current))
        .toContain('level_discontinuity');
    },
  );

  it.each(CONTINUITY_BAD_ALREADY_CAUGHT)(
    'also flags $symbol, which the session rule already caught (residual $residual)',
    ({ prior, current, residual }) => {
      const v = assessLevelContinuity(prior, current);
      expect(v.verdict).toBe('suspect');
      expect(v.residual).toBeCloseTo(residual, 4);
    },
  );

  it('catches BOTH sides of the FGMC series the ticket is named after — and says which', () => {
    // 07-29 (r = 2.1066): caught by the session rule AND by continuity.
    const d29 = { price: 8.3, changePct: 110.6598984771574 };
    const d28 = { price: 8.3, changePct: 69.04276985743381 };
    expect(isQuoteMoveSuspect(d29)).toBe(true);
    expect(assessLevelContinuity(d28, d29).verdict).toBe('suspect');

    // ⛔ 07-29 is the row this instrument RECOVERS. The 07-28 row is FGMC's first
    // appearance in the archive, so there is no prior observation and the verdict
    // is ABSTAIN — explicitly NOT 'consistent'. A cross-artifact test is blind to
    // day 1 by construction; that is the honest scope of the report boundary and
    // it is why the feed-boundary follow-up exists.
    expect(isQuoteMoveSuspect(d28)).toBe(false);             // r = 1.6904, below 2
    const day1 = assessLevelContinuity(null, d28);
    expect(day1.verdict).toBe('abstain');
    expect(day1.verdict).not.toBe('consistent');
    expect(day1.reason).toBe('no_prior_observation');
  });
});

describe('TRA-2634 known-GOOD control — the continuity check must stay silent', () => {
  it.each(CONTINUITY_GOOD)(
    'does NOT flag $symbol, continuous with our own published close',
    ({ prior, current }) => {
      const v = assessLevelContinuity(prior, current);
      expect(v.verdict).toBe('consistent');
      expect(v.residual).toBeLessThan(CONTINUITY_RESIDUAL_TOLERANCE);
    },
  );

  it('and it PRESERVES the disagreement with the session rule in both directions', () => {
    // FLYYQ 0.01 -> 0.02 / +100% is r = 2.000 EXACTLY: the session rule flags it,
    // continuity passes it. TDIC 7.60 -> 6.13 / -21.31% is the mirror image.
    // Neither instrument is a superset of the other, so neither threshold moved
    // and the report ORs the two verdicts.
    const flyyq = { price: 0.02, changePct: 100 };
    expect(isQuoteMoveSuspect(flyyq)).toBe(true);
    expect(assessLevelContinuity({ price: 0.01, changePct: -50 }, flyyq).verdict).toBe('consistent');

    const tdic = { price: 6.13, changePct: -21.31 };
    expect(isQuoteMoveSuspect(tdic)).toBe(false);
    expect(assessLevelContinuity({ price: 7.6, changePct: 39.97 }, tdic).verdict).toBe('suspect');
  });

  it('⭐ does NOT condemn a quiet name that legitimately prints the same close twice', () => {
    // THE control the ticket named: "a low-priced or illiquid name can legitimately
    // print the same close two sessions running WITH a changePct consistent with
    // that price." An identical close means the true session change is ~0, and a
    // row publishing ~0 is continuous. Note the ticket's own proposed predicate —
    // "price identical AND changePct materially different" — CONDEMNS this row,
    // because yesterday's changePct was +3.2% and today's is 0.00%. The residual
    // form does not, because it asks about the ARITHMETIC, not about the delta.
    const quiet = assessLevelContinuity(
      { price: 4.85, changePct: 3.19 },   // yesterday: a real +3.19% session
      { price: 4.85, changePct: 0 },      // today: same close, so 0.00%
    );
    expect(quiet.verdict).toBe('consistent');
    expect(quiet.residual).toBeCloseTo(1, 10);

    // Same for a penny name, where a repeated close is routine.
    expect(assessLevelContinuity(
      { price: 0.0216, changePct: -12.5 },
      { price: 0.0216, changePct: 0 },
    ).verdict).toBe('consistent');
  });
});

describe('TRA-2634 abstain — a blind read must never read as a clean one', () => {
  it.each(CONTINUITY_REPUBLICATIONS)(
    'abstains on the $symbol republication instead of grading it',
    ({ prior, current }) => {
      const v = assessLevelContinuity(prior, current);
      expect(v.verdict).toBe('abstain');
      expect(v.reason).toBe('republished_prior_row');
    },
  );

  it('would FIRE on the republications if the epsilon were an equality test', () => {
    // The falsification for the tolerance. SNDK/LEGN differ only in the 6th
    // significant figure of `changePct`; an `===` comparison classes them as two
    // observations and produces residuals of 1.12 and 1.20. Asserting this keeps
    // the tolerance from being quietly reverted to equality.
    for (const { prior, current } of CONTINUITY_REPUBLICATIONS) {
      const asTwoObservations = Math.max(
        prior.price / impliedPrevClose(current)!,
        impliedPrevClose(current)! / prior.price,
      );
      expect(asTwoObservations).toBeGreaterThanOrEqual(CONTINUITY_RESIDUAL_TOLERANCE);
    }
  });

  it('abstains rather than guessing on the ungradeable shapes', () => {
    const cur = { price: 8.3, changePct: 110.66 };
    expect(assessLevelContinuity(null, cur).reason).toBe('no_prior_observation');
    expect(assessLevelContinuity(undefined, cur).reason).toBe('no_prior_observation');
    expect(assessLevelContinuity({ price: 0 }, cur).reason).toBe('prior_unusable');
    expect(assessLevelContinuity({ price: NaN }, cur).reason).toBe('prior_unusable');
    // Today's numbers imply nothing about a prev close — the session-move rule owns that.
    expect(assessLevelContinuity({ price: 10 }, { price: 10 }).reason).toBe('current_unusable');
    expect(assessLevelContinuity({ price: 10 }, { price: 10, changePct: -100 }).reason)
      .toBe('current_unusable');
    // and NONE of them is 'consistent'
    for (const prior of [null, undefined, { price: 0 }, { price: NaN }]) {
      expect(assessLevelContinuity(prior, cur).verdict).not.toBe('consistent');
    }
  });

  it('never returns a residual it did not compute', () => {
    expect(assessLevelContinuity(null, { price: 1, changePct: 1 }).residual).toBeNull();
    expect(assessLevelContinuity({ price: 1, changePct: 1 }, { price: 1, changePct: 1 }).residual).toBeNull();
  });
});

// ── TRA-3068 — THE SPLIT CALENDAR ─────────────────────────────────────────────
//
// Filed off TRA-3065, where the question was MEASURED and came back GAP: a
// corporate action with factor < 2.0 evades BOTH deployed detectors, and no
// threshold change reaches it. Every row below is built the way
// `scripts/tra3065-corporate-action-evasion.mjs` builds its grid — the row a feed
// actually publishes on an ex-date — so these tests and that checker grade the
// same artifact from two directions.
//
//   D-1  our published close is the pre-action level P0.
//   D    ex-date. Traded price P1 = (P0 / k) * (1 + m), `m` a GENUINE session move.
//   (a) UNADJUSTED feed  prevClose_D = P0       -> `changePct` is FABRICATED
//   (b) ADJUSTED   feed  prevClose_D = P0 / k   -> `changePct` is CORRECT
//
// ⛔ EVERY assertion here is paired with the SAME row assessed WITHOUT the
// calendar. Without that negative control a green test proves only that the row
// is suspect, not that the NEW LEG is what made it so — and "already caught by
// the ratio rule" is the exact failure mode this ticket exists to correct.

const CA_P0 = 12.34;
const round2dp = (x: number) => Math.round(x * 100) / 100;

/** The row a feed publishes on the ex-date, under behaviour `a` or `b`. */
function exDateRow(k: number, mPct: number, behaviour: 'a' | 'b') {
  const price = (CA_P0 / k) * (1 + mPct / 100);
  const feedPrevClose = behaviour === 'a' ? CA_P0 : CA_P0 / k;
  return { price, changePct: round2dp(((price - feedPrevClose) / feedPrevClose) * 100) };
}

const SPLIT_3_2: CorporateAction = {
  exDate: '2026-06-30', numerator: 3, denominator: 2, splitRatio: '3:2',
};
const CA_PRIOR = { price: CA_P0, changePct: 1.23 };

/**
 * The residual an UNADJUSTED ex-date row can reach, DERIVED rather than fitted.
 *
 * Under (a) the residual is algebraically 1; it misses only because `changePct`
 * publishes on a 2-dp grid, and the same expression the
 * `CONTINUITY_RESIDUAL_TOLERANCE` docblock uses bounds that: a half-grid of
 * 0.005 pct points gives `d(impliedPrev)/impliedPrev = 0.005 / |100 + pct|`.
 *
 * Asserted this way for the reason `tra3065-corporate-action-evasion.mjs` states
 * outright — a hand-picked `toBeCloseTo` slack would let a REAL residual hide
 * inside the tolerance and the test would still be green.
 */
const twoDpRoundingBound = (publishedPct: number) => 1 + 0.005 / Math.abs(100 + publishedPct);

describe('TRA-3068 the gap: a sub-2.0 corporate action, WITH and WITHOUT the calendar', () => {
  // The exact row TRA-3065 proved evades both detectors: a FLAT 3:2 forward
  // split. Published -33.33%, session ratio 1.4999, residual 1.00005.
  const flat32a = exDateRow(1.5, 0, 'a');

  it('NEGATIVE CONTROL — without the calendar the row is clean on BOTH rules', () => {
    const session = assessQuotePlausibility(flat32a);
    expect(session.suspect).toBe(false);
    expect(session.ratio!).toBeLessThan(SUSPECT_MOVE_RATIO);
    expect(session.ratio!).toBeCloseTo(1.5, 3);

    const cont = assessLevelContinuity(CA_PRIOR, flat32a);
    expect(cont.verdict).toBe('consistent');
    expect(cont.residual!).toBeLessThan(CONTINUITY_RESIDUAL_TOLERANCE);
    // The load-bearing number from the ticket: under (a) the residual is not
    // merely inside the tolerance, it is AT the identity. The continuity rule is
    // blind here by ALGEBRA, not by a threshold being slightly too loose — which
    // is what the corrected `:214` comment now says. 1.01 is ~130x further away
    // than the entire rounding grid.
    expect(cont.residual!).toBeLessThanOrEqual(twoDpRoundingBound(flat32a.changePct));
  });

  it('WITH the calendar the session rule flags it, naming the CAUSE not the symptom', () => {
    const v = assessQuotePlausibility(flat32a, SPLIT_3_2);
    expect(v.suspect).toBe(true);
    expect(v.reason).toBe('corporate_action');
    expect(v.reason).not.toBe('implausible_move_ratio');
    // The ratio is still carried, and it is still UNDER the bar — i.e. this
    // verdict is unreachable by any change to SUSPECT_MOVE_RATIO short of one
    // that condemns half the tape.
    expect(v.ratio!).toBeLessThan(SUSPECT_MOVE_RATIO);
    expect(v.corporateAction).toEqual(SPLIT_3_2);
  });

  it('FLAG, NEVER CLAMP — the raw numbers survive the verdict untouched', () => {
    const row = { ...flat32a };
    assessQuotePlausibility(row, SPLIT_3_2);
    assessLevelContinuity(CA_PRIOR, row, SPLIT_3_2);
    expect(row.price).toBe(flat32a.price);
    expect(row.changePct).toBe(flat32a.changePct);
  });

  it('logs the ratio, so the flag is evidence rather than an assertion', () => {
    const line = describeQuoteSuspicion('UPC', flat32a, SPLIT_3_2);
    expect(line).toContain('corporate_action');
    expect(line).toContain('corporateAction=3:2');
    expect(line).toContain('exDate=2026-06-30');
    expect(line).toContain('factor=1.500000');
  });

  it('reaches the whole sub-2.0 class, at every factor and every genuine move', () => {
    // TRA-3065 measured 34 of 64 unadjusted rows evading BOTH rules. None of
    // them evades the calendar, and the sweep over `m` is the load-bearing part:
    // the session rule's exposure is a function of the genuine move, not of the
    // action factor alone, so a single m = 0 row would prove nothing.
    for (const [num, den] of [[5, 4], [4, 3], [3, 2], [2, 3]] as const) {
      for (const m of [-30, -25, -10, 0, 10, 25, 100, 200]) {
        const row = exDateRow(num / den, m, 'a');
        const action: CorporateAction = { exDate: '2026-06-30', numerator: num, denominator: den };
        expect(assessQuotePlausibility(row, action).reason).toBe('corporate_action');
      }
    }
  });
});

describe('TRA-3068 acceptance 4 — a KNOWN ex-date reads `abstain`, never `suspect`', () => {
  it('abstains under an UNADJUSTED feed, where the rule was already blind', () => {
    const rowA = exDateRow(1.5, 0, 'a');
    const v = assessLevelContinuity(CA_PRIOR, rowA, SPLIT_3_2);
    expect(v.verdict).toBe('abstain');
    expect(v.verdict).not.toBe('suspect');
    expect(v.verdict).not.toBe('consistent');   // ⛔ an abstain is NOT a clearance
    expect(v.reason).toBe('corporate_action');
    // Carried, because THIS is the live discriminator between the two feed
    // branches TRA-3065 could not settle from the archive: ~1 says the feed
    // handed us an unadjusted prev close and the headline is fabricated.
    expect(v.residual!).toBeLessThanOrEqual(twoDpRoundingBound(rowA.changePct));
    expect(v.corporateAction).toEqual(SPLIT_3_2);
  });

  it('abstains under an ADJUSTED feed, suppressing a FALSE POSITIVE on a CORRECT row', () => {
    // ⭐ The premise TRA-3065 corrected: case (b) is not "defended", it is the
    // rule MISFIRING. The published `changePct` is RIGHT; only our stored prior
    // close is un-back-adjusted, so the residual is the action factor k and the
    // rule fires on 64 of 64 such rows. Inheriting that would trade one defect
    // for another.
    const rowB = exDateRow(1.5, 0, 'b');
    const withoutCal = assessLevelContinuity(CA_PRIOR, rowB);
    expect(withoutCal.verdict).toBe('suspect');            // the misfire, today
    expect(withoutCal.residual!).toBeCloseTo(1.5, 3);      // == k, not noise

    const withCal = assessLevelContinuity(CA_PRIOR, rowB, SPLIT_3_2);
    expect(withCal.verdict).toBe('abstain');
    expect(withCal.reason).toBe('corporate_action');
    expect(withCal.residual!).toBeCloseTo(1.5, 3);         // still on the record
    expect(describeLevelContinuity('X', '2026-06-29', CA_PRIOR, rowB, SPLIT_3_2))
      .toContain('residualExpectedIfAdjusted=1.500000');
  });

  it('does not soften a real continuity break when NO action is in the window', () => {
    // TDIC, a real TRA-2634 offender. Nothing about the calendar leg's existence
    // may change this verdict.
    const tdic = { price: 6.13, changePct: -21.31 };
    const v = assessLevelContinuity({ price: 7.6, changePct: 39.97 }, tdic, null);
    expect(v.verdict).toBe('suspect');
    expect(v.reason).toBe('level_discontinuity');
  });

  it('a republication still reads `republished_prior_row`, not `corporate_action`', () => {
    // Order matters: a stale republication's residual is garbage by construction
    // (1.22 .. 14.17 on bqb1), and letting it wear the `corporate_action` label
    // would contaminate the very branch measurement the abstain's residual feeds.
    const row = { price: 8.3, changePct: 69.04 };
    const v = assessLevelContinuity({ ...row }, row, SPLIT_3_2);
    expect(v.reason).toBe('republished_prior_row');
    expect(v.verdict).toBe('abstain');
  });
});

describe('TRA-3068 the window is HALF-OPEN on (priorSession, currentSession]', () => {
  const cal: CorporateAction[] = [{ exDate: '2026-06-30', numerator: 2, denominator: 1 }];

  it('matches an ex-date ON the current session', () => {
    expect(corporateActionInSessionWindow(cal, '2026-06-29', '2026-06-30')).toEqual(cal[0]);
  });

  it('does NOT match an ex-date ON the prior session — that close is already post-action', () => {
    expect(corporateActionInSessionWindow(cal, '2026-06-30', '2026-07-01')).toBeNull();
  });

  it('matches a weekend-straddling window (Friday split, Monday row)', () => {
    const friday: CorporateAction[] = [{ exDate: '2026-07-03', numerator: 2, denominator: 1 }];
    expect(corporateActionInSessionWindow(friday, '2026-07-02', '2026-07-06')).toEqual(friday[0]);
  });

  it('does NOT match a FUTURE ex-date', () => {
    expect(corporateActionInSessionWindow(cal, '2026-06-01', '2026-06-29')).toBeNull();
  });

  it('collapses to an exact match when the prior session is unknown (the LIVE quote path)', () => {
    // For a live quote `prevClose` is the immediately preceding session's close,
    // and splits ex-date on trading days, so today's is the ONLY ex-date that can
    // straddle it. Opening the lower bound to -infinity would flag every row for
    // weeks after a split.
    expect(corporateActionInSessionWindow(cal, null, '2026-06-30')).toEqual(cal[0]);
    expect(corporateActionInSessionWindow(cal, null, '2026-07-01')).toBeNull();
    expect(corporateActionInSessionWindow(cal, undefined, '2026-07-01')).toBeNull();
  });

  it('takes the LATEST qualifying ex-date when two land in one window', () => {
    const two: CorporateAction[] = [
      { exDate: '2026-07-03', numerator: 2, denominator: 1 },
      { exDate: '2026-07-06', numerator: 3, denominator: 1 },
    ];
    expect(corporateActionInSessionWindow(two, '2026-07-02', '2026-07-06')?.exDate).toBe('2026-07-06');
  });

  it('is inert on an empty / absent calendar and on a missing current session', () => {
    expect(corporateActionInSessionWindow([], '2026-06-29', '2026-06-30')).toBeNull();
    expect(corporateActionInSessionWindow(null, '2026-06-29', '2026-06-30')).toBeNull();
    expect(corporateActionInSessionWindow(undefined, '2026-06-29', '2026-06-30')).toBeNull();
    expect(corporateActionInSessionWindow(cal, '2026-06-29', undefined)).toBeNull();
  });
});

describe('TRA-3068 FAIL-CLOSED — an uninterpretable action can never silence a detector', () => {
  // A known action SILENCES the continuity rule and REDIRECTS the session rule's
  // reason, so a garbage provider row must degrade to NO KNOWN ACTION — i.e. the
  // pre-TRA-3068 behaviour — and never to a suppressed verdict.
  const degenerate: Array<[string, CorporateAction]> = [
    ['zero numerator', { exDate: '2026-06-30', numerator: 0, denominator: 1 }],
    ['zero denominator', { exDate: '2026-06-30', numerator: 2, denominator: 0 }],
    ['negative', { exDate: '2026-06-30', numerator: -2, denominator: 1 }],
    ['NaN', { exDate: '2026-06-30', numerator: NaN, denominator: 1 }],
    ['Infinity', { exDate: '2026-06-30', numerator: Infinity, denominator: 1 }],
    ['a 1:1 no-op', { exDate: '2026-06-30', numerator: 1, denominator: 1 }],
    ['non-numeric', { exDate: '2026-06-30', numerator: '2' as unknown as number, denominator: 1 }],
  ];

  it.each(degenerate)('%s yields no factor and no log line', (_label, action) => {
    expect(corporateActionFactor(action)).toBeNull();
    expect(describeCorporateAction(action)).toBe('');
  });

  it.each(degenerate)('%s does NOT suppress a real continuity break', (_label, action) => {
    const v = assessLevelContinuity({ price: 7.6, changePct: 39.97 }, { price: 6.13, changePct: -21.31 }, action);
    expect(v.verdict).toBe('suspect');
    expect(v.reason).toBe('level_discontinuity');
  });

  it.each(degenerate)('%s does NOT invent a session-rule verdict either', (_label, action) => {
    expect(assessQuotePlausibility({ price: 100, changePct: 1.5 }, action).suspect).toBe(false);
    // and a row the ratio rule DOES catch is still caught, under its own reason.
    expect(assessQuotePlausibility({ price: 6.49, changePct: 8951.61 }, action).reason)
      .toBe('implausible_move_ratio');
  });

  it('never matches a window on a missing / malformed ex-date', () => {
    const bad = [
      { exDate: '', numerator: 2, denominator: 1 },
      { exDate: undefined as unknown as string, numerator: 2, denominator: 1 },
    ];
    expect(corporateActionInSessionWindow(bad, '2026-06-29', '2026-06-30')).toBeNull();
  });

  it('corporateActionFactor is null on null / undefined', () => {
    expect(corporateActionFactor(null)).toBeNull();
    expect(corporateActionFactor(undefined)).toBeNull();
  });
});

describe('TRA-3068 acceptance 3 + backwards compatibility', () => {
  it('SUSPECT_MOVE_RATIO is UNCHANGED at 2', () => {
    // Not decoration. TRA-3065 measured the alternative: reaching a 3:2 needs
    // R = 1.5, which flags 53.9% of every row we publish (283 of 525 bqb1
    // symbol-rows vs the deployed 131) against an archive holding ZERO confirmed
    // corporate actions — and it still would not close the class.
    expect(SUSPECT_MOVE_RATIO).toBe(2);
    expect(CONTINUITY_RESIDUAL_TOLERANCE).toBe(1.01);
  });

  it('omitting the calendar reproduces the pre-TRA-3068 verdicts EXACTLY', () => {
    // The compatibility that keeps both TRA-3065 checkers and the TRA-2634
    // control set grading the rule they were written against.
    const rows = [
      { price: 6.49, changePct: 8951.61 },     // FFAI — ratio rule
      { price: 8.3, changePct: 110.66 },       // FGMC 07-29
      { price: 0.02, changePct: 100 },         // FLYYQ — r = 2.000 exactly
      { price: 91.99, changePct: -16.02 },     // SOXL — genuinely clean
    ];
    for (const r of rows) {
      expect(assessQuotePlausibility(r, null)).toEqual(assessQuotePlausibility(r));
      expect(assessQuotePlausibility(r, undefined)).toEqual(assessQuotePlausibility(r));
      expect(assessLevelContinuity(CA_PRIOR, r, null)).toEqual(assessLevelContinuity(CA_PRIOR, r));
    }
  });

  it('the calendar only ever ADDS a session verdict — it never clears one', () => {
    // FFAI is r = 92.71. A known split in the window must not downgrade it to
    // "explained"; it stays suspect, and the reason names the better cause.
    const ffai = { price: 6.49, changePct: 8951.61 };
    expect(assessQuotePlausibility(ffai).suspect).toBe(true);
    const v = assessQuotePlausibility(ffai, SPLIT_3_2);
    expect(v.suspect).toBe(true);
    expect(v.reason).toBe('corporate_action');
  });
});
