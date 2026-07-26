// TRA-2361 — the SHARED fixture set for rule R1 (a material infeasible sleeve blocks).
//
// ⚠️ WHY THIS IS A MODULE AND NOT TWO COPIES OF THE SAME LITERALS.
//
// AC5's monotonicity claim (`passed′ ≤ passed` pointwise) is a statement about the
// RELATION between two builds, so it is proven by running BOTH builds over the IDENTICAL
// inputs and cross-tabulating. "Identical" is doing the work: two hand-copied fixture
// lists that drift by one row turn the whole differential into a comparison of two
// different questions, and it would still print a clean matrix. So the fixtures live here
// once, and both consumers import them:
//
//   • `gate-sleeve-blocking.test.ts`               — the shipped suite
//   • `scripts/tra2361-monotonicity-matrix.mjs`    — the pre-fix/post-fix differential
//
// ⚠️ EVERY FIXTURE IS ARITHMETICALLY COHERENT: each row's `pnlR` is ≤ its own
// `maxProfitUsd ÷ maxLossUsd`. That is not decoration — it is the pathwise identity this
// whole module family rests on, and a fixture that violates it is a book that cannot
// exist, so a `true → false` cell measured on one would prove nothing about any real book.

import type { IdeaOutcome } from './options-forward-test.js';

/** The bar every fixture is graded against — the live `safetyMarginR`. */
export const BAR = 0.2;

// A real-priced DEBIT vertical: 253 max profit on 250 max loss ⇒ rewardR = 1.012.
const DEBIT_MAX_PROFIT = 253;
const DEBIT_MAX_LOSS = 250;
const DEBIT_COST_R = 0.05;

// The live CREDIT vertical, from the TRA-2332 measurement: pooled credit/width k = 0.0366
// ⇒ credit 36.6 against a width of 1000 ⇒ maxLoss = 963.4 ⇒ rewardR = 0.0380, and a cost
// drag of 0.0389R puts the cost-NET ceiling at ≈ −0.0009R. Flatly infeasible vs a 0.20R
// bar, at any hit rate, which is the state R1 exists to stop.
const CREDIT_MAX_PROFIT = 36.6;
const CREDIT_MAX_LOSS = 963.4;
const CREDIT_COST_R = 0.0389;

const WEEK = (i: number): string => `2026-W${String((i % 8) + 1).padStart(2, '0')}`;

function base(over: Partial<IdeaOutcome> & { key: string }): IdeaOutcome {
  return {
    ticker: 'SPY',
    strategy: 'bull_call_spread',
    surfacedDate: '2026-01-05',
    surfacedWeek: '2026-W01',
    expiration: '2026-02-20',
    // hitRate is 1.00 on every fixture below, so a 0.95 stated POP puts
    // `popCalibrationGap = 1.00 − 0.95 = 0.05` inside the ±0.10 band.
    pop: 0.95,
    maxLossUsd: DEBIT_MAX_LOSS,
    maxProfitUsd: DEBIT_MAX_PROFIT,
    // − = net debit paid; + = net credit collected. `byPremiumDirection` reads this SIGN.
    entryNetUsd: -DEBIT_MAX_LOSS,
    status: 'resolved',
    valuedAt: '2026-02-20',
    liquidationUsd: 0,
    pnlUsd: 137.5,
    pnlR: 0.55, // ≤ rewardR 1.012 ✓
    costsUsd: DEBIT_MAX_LOSS * DEBIT_COST_R,
    pnlNetUsd: 125,
    pnlNetR: 0.5,
    costEfficiencyRatio: DEBIT_COST_R,
    win: true,
    maxLossBreached: false,
    excluded: false,
    excludeReason: null,
    settleLagDays: 0,
    ...over,
  };
}

/** A winning DEBIT vertical — the rows that make the book clear every criterion. */
export const debitWinner = (i: number, over: Partial<IdeaOutcome> = {}): IdeaOutcome =>
  base({ key: `dbt-${i}`, surfacedWeek: WEEK(i), ...over });

/**
 * A CREDIT vertical at the live ratio: a winner on every trade, netting ≈ 0.00R.
 * `pnlR = 0.038 = rewardR` exactly — the sleeve has ATTAINED its ceiling, which is the
 * live fact that makes "more sample cannot resolve this" true rather than rhetorical.
 */
export const creditAtCeiling = (i: number, over: Partial<IdeaOutcome> = {}): IdeaOutcome =>
  base({
    key: `crd-${i}`,
    surfacedWeek: WEEK(i),
    strategy: 'bull_put_spread',
    maxProfitUsd: CREDIT_MAX_PROFIT,
    maxLossUsd: CREDIT_MAX_LOSS,
    entryNetUsd: CREDIT_MAX_PROFIT,
    costEfficiencyRatio: CREDIT_COST_R,
    pnlUsd: CREDIT_MAX_PROFIT,
    pnlR: 0.038,
    pnlNetUsd: -0.9,
    pnlNetR: -0.001,
    win: true,
    ...over,
  });

/**
 * A `long_call`: the feed caps upside at 2× debit and stamps `priced: true`, so the row
 * sails past the `!excluded` filter with a FABRICATED `rewardR ≡ 2.000`. A sleeve of
 * these grades `unknown` — a ceiling that rests on fabricated rewards can sustain an
 * `infeasible` (it is an upper bound) but can never certify reachability.
 */
export const sketchCapped = (i: number, over: Partial<IdeaOutcome> = {}): IdeaOutcome =>
  base({
    key: `lc-${i}`,
    surfacedWeek: WEEK(i),
    strategy: 'long_call',
    maxProfitUsd: 600,
    maxLossUsd: 300,
    entryNetUsd: -300,
    pnlR: 0.55,
    pnlNetR: 0.5,
    ...over,
  });

const rows = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

/**
 * The fixture set both builds are run over.
 *
 * ⚠️ ORDER AND KEYS ARE PART OF THE ARTIFACT. The AC5 matrix is pinned by `key`, so
 * renaming or reordering a case invalidates the recorded pre-fix vector rather than
 * silently re-labelling it. Add new cases at the END and re-run the script.
 */
export interface MonotonicityCase {
  key: string;
  /** What this case is FOR — printed in the matrix so a reader can audit coverage. */
  what: string;
  outcomes: IdeaOutcome[];
}

export const MONOTONICITY_CASES = (): MonotonicityCase[] => [
  {
    key: 'known-bad-25pct-infeasible-sleeve',
    what: 'AC6 KNOWN-BAD — every criterion passes and the book is `feasible`, but a 25% sleeve is positively `infeasible` on BOTH axes. This is the required `true → false` cell.',
    // 36 debit winners + 12 credit-at-ceiling ⇒ n=48, credit weight 12/48 = 0.25.
    outcomes: [...rows(36, (i) => debitWinner(i)), ...rows(12, (i) => creditAtCeiling(i))],
  },
  {
    key: 'known-good-5pct-infeasible-sleeve',
    what: 'AC6 KNOWN-GOOD — CONTAINS an infeasible sleeve, at 5% (2/40), below the 0.20 threshold. `blocking` must be false and `passed` byte-identical to pre-fix. A fixture with NO infeasible sleeve could not tell "the threshold works" from "the flag never fires".',
    outcomes: [...rows(38, (i) => debitWinner(i)), ...rows(2, (i) => creditAtCeiling(i))],
  },
  {
    key: 'premium-axis-only-block',
    what: 'R1(3), the two-axis OR — 8 `bull_put_spread` (16.7%) + 4 `bear_call_spread` (8.3%) are each UNDER the threshold by structure, but they coarsen to a 25% `credit` sleeve. A structure-only rule misses this entirely.',
    outcomes: [
      ...rows(36, (i) => debitWinner(i)),
      ...rows(8, (i) => creditAtCeiling(i)),
      ...rows(4, (i) => creditAtCeiling(i + 8, { strategy: 'bear_call_spread' })),
    ],
  },
  {
    key: 'unknown-heavy-sleeve-never-blocks',
    what: 'R1(1) — a 25% sleeve whose ceiling rests on FABRICATED (sketch-capped) rewards grades `unknown`, not `infeasible`, and must NOT block. Treating `unknown` as a stop would make the gate unpassable the moment one `long_call` entered the book: a NEW false negative, not a fix.',
    outcomes: [...rows(36, (i) => debitWinner(i)), ...rows(12, (i) => sketchCapped(i))],
  },
  {
    key: 'unusable-rows-count-toward-weight',
    what: 'R1(2) — a 12-row credit sleeve of which 5 have no usable denominator. `n` counts ALL 12 (weight 12/48 = 0.25 ⇒ BLOCKS); a `nUsable`-based weight would read 7/43 = 0.163 and let it through — i.e. an offender would shrink exactly when its rewards became underivable.',
    outcomes: [
      ...rows(36, (i) => debitWinner(i)),
      ...rows(7, (i) => creditAtCeiling(i)),
      ...rows(5, (i) =>
        creditAtCeiling(i + 7, { maxLossUsd: 0, pnlR: 0, pnlNetR: 0, costEfficiencyRatio: null }),
      ),
    ],
  },
  {
    key: 'clean-book-all-sleeves-feasible',
    what: 'The NEGATIVE control for the whole rule — a mixed book where every sleeve clears the bar. Nothing may block, and `passed` must be true under BOTH builds (otherwise the change is not monotone, it is just strict).',
    outcomes: [...rows(36, (i) => debitWinner(i)), ...rows(12, (i) => sketchCapped(i, { strategy: 'bear_call_spread', maxProfitUsd: 253, maxLossUsd: 250, entryNetUsd: 253 }))],
  },
  {
    key: 'book-level-infeasible',
    what: 'The pre-existing TRA-2335 stop — the WHOLE book is infeasible. Already `false` before this change; must stay `false` (a `false → false` cell, not a `false → true` one).',
    outcomes: rows(35, (i) => creditAtCeiling(i)),
  },
  {
    key: 'failing-book-below-bar',
    what: 'An ordinary FAIL — book feasible, no blocking sleeve, expectancy simply under the bar. Untouched by R1 in either direction.',
    outcomes: rows(40, (i) => debitWinner(i, { pnlR: 0.1, pnlNetR: 0.05, pnlNetUsd: 12.5 })),
  },
  {
    key: 'thin-book-below-sample-floor',
    what: 'Already blocked on `sample_size`/`weeks_of_evidence` AND carrying a 25% infeasible sleeve. R1 has no sample-size floor by design, so the sleeve blocks here too — but `passed` was already false, so this is a `false → false` cell and proves the rule adds no NEW pass.',
    outcomes: [...rows(6, (i) => debitWinner(i)), ...rows(2, (i) => creditAtCeiling(i))],
  },
  {
    key: 'approaching-not-yet-blocking',
    what: 'AC4 — a 9/47 = 19.15% infeasible sleeve, 0.85pp under the threshold: the LIVE `bull_call_spread` weight on 2026-07-26. It must be LABELLED `approachingBlockingThreshold` and must NOT block. One more resolution (10/48 = 20.83%) flips it, with no code change anywhere.',
    outcomes: [...rows(38, (i) => debitWinner(i)), ...rows(9, (i) => creditAtCeiling(i))],
  },
];
