import { describe, it, expect } from 'vitest';
import { buildForwardTestReport } from './options-forward-test.js';
import { evaluateLiveCapitalGate, LIVE_CAPITAL_GATE } from './live-capital-gate.js';
import {
  MATERIAL_SLEEVE_WEIGHT,
  BLOCKING_SLEEVE_WEIGHT,
  APPROACHING_BLOCKING_SLEEVE_WEIGHT,
} from './gate-feasibility.js';
import { BAR, MONOTONICITY_CASES, type MonotonicityCase } from './gate-sleeve-blocking-fixtures.js';

// TRA-2361 (parent TRA-2353 → TRA-2335 → TRA-2332) — rule R1: a MATERIAL infeasible
// sleeve BLOCKS the capital path.
//
// R1, pre-registered by QuantTrader BEFORE the first per-sleeve read (so the constant
// cannot be tuned to a result afterwards). A sleeve blocks `positive_expectancy` iff ALL:
//   1. `verdict === 'infeasible'` — a POSITIVE determination. `unknown` NEVER blocks.
//   2. `weight >= 0.20`, `weight = sleeve.n / bookN`, `n` counting ALL partition members
//      INCLUDING `unusable` ones.
//   3. on EITHER axis — `byStructure` OR `byPremiumDirection`.
// The gate blocks iff ≥1 sleeve blocks. No sample-size floor, no exemption.

const CRITERIA = { ...LIVE_CAPITAL_GATE, minExpectancyR: BAR };
const ET_NOON = Date.parse('2026-02-23T16:00:00.000Z');

const gateFor = (c: MonotonicityCase) =>
  evaluateLiveCapitalGate(buildForwardTestReport(c.outcomes, { asOf: ET_NOON }), CRITERIA);

const caseByKey = (key: string): MonotonicityCase => {
  const c = MONOTONICITY_CASES().find((x) => x.key === key);
  if (!c) throw new Error(`fixture ${key} is gone — the AC5 matrix below is pinned by key`);
  return c;
};
const gateOf = (key: string) => gateFor(caseByKey(key));
const sleeve = (g: ReturnType<typeof gateOf>, axis: 'byStructure' | 'byPremiumDirection', key: string) =>
  g.sleeveFeasibility[axis].sleeves.find((s) => s.key === key)!;

describe('TRA-2361 · AC1 — a SECOND constant, and the label must fire before the block', () => {
  it('`BLOCKING_SLEEVE_WEIGHT` is 0.2 and `MATERIAL_SLEEVE_WEIGHT` is UNCHANGED at 0.1', () => {
    // ⚠️ Raising MATERIAL to 0.2 and reusing it would REDUCE VISIBILITY: a sleeve at 12%
    // reads `material: true` today and would silently stop doing so. Two jobs, two
    // constants. This test is the thing that notices if someone "simplifies" them.
    expect(BLOCKING_SLEEVE_WEIGHT).toBe(0.2);
    expect(MATERIAL_SLEEVE_WEIGHT).toBe(0.1);
  });

  it('THE INVARIANT: BLOCKING >= MATERIAL — a sleeve is always SEEN before it BITES', () => {
    expect(BLOCKING_SLEEVE_WEIGHT).toBeGreaterThanOrEqual(MATERIAL_SLEEVE_WEIGHT);
    // AC4's band sits between them and is strictly below the block, so the warning
    // genuinely precedes the stop rather than coinciding with it.
    expect(APPROACHING_BLOCKING_SLEEVE_WEIGHT).toBeGreaterThanOrEqual(MATERIAL_SLEEVE_WEIGHT);
    expect(APPROACHING_BLOCKING_SLEEVE_WEIGHT).toBeLessThan(BLOCKING_SLEEVE_WEIGHT);
  });

  it('every blocking sleeve is necessarily also `material` (the ordering, exercised)', () => {
    // The invariant above is arithmetic on two constants; this is the same claim measured
    // on real output, which is what actually protects a reader of the payload.
    for (const c of MONOTONICITY_CASES()) {
      const g = gateFor(c);
      for (const axis of ['byStructure', 'byPremiumDirection'] as const) {
        for (const s of g.sleeveFeasibility[axis].sleeves) {
          if (s.blocking) expect(s.material, `${c.key}/${axis}/${s.key}`).toBe(true);
        }
      }
    }
  });
});

describe('TRA-2361 · AC2 — label every sleeve, filter NONE', () => {
  it('`sleeves` is emitted WHOLE: sum(sleeve.n) === bookN on BOTH axes, every fixture', () => {
    // This is the check that proves nothing was dropped. A sleeve filtered out BECAUSE it
    // is infeasible is strictly worse than one that reads `infeasible` — it would restore
    // exactly the invisibility this instrument family exists to end.
    for (const c of MONOTONICITY_CASES()) {
      const report = buildForwardTestReport(c.outcomes, { asOf: ET_NOON });
      const g = gateFor(c);
      for (const axis of ['byStructure', 'byPremiumDirection'] as const) {
        const a = g.sleeveFeasibility[axis];
        expect(a.bookN, `${c.key}/${axis}`).toBe(report.totals.resolved);
        expect(a.sleeves.reduce((acc, s) => acc + s.n, 0), `${c.key}/${axis}`).toBe(
          report.totals.resolved,
        );
      }
    }
  });

  it('`blockingSleeves` is a DERIVED projection — it agrees with the per-sleeve flags', () => {
    for (const c of MONOTONICITY_CASES()) {
      const g = gateFor(c);
      for (const axis of ['byStructure', 'byPremiumDirection'] as const) {
        const a = g.sleeveFeasibility[axis];
        expect(a.blockingSleeves, `${c.key}/${axis}`).toEqual(
          a.sleeves.filter((s) => s.blocking).map((s) => s.key),
        );
      }
    }
  });

  it('R1(1) — a POSITIVE `infeasible` is required: an `unknown` sleeve at 25% does NOT block', () => {
    const g = gateOf('unknown-heavy-sleeve-never-blocks');
    const lc = sleeve(g, 'byStructure', 'long_call');
    expect(lc.weight).toBeCloseTo(12 / 48, 4);
    expect(lc.weight!).toBeGreaterThanOrEqual(BLOCKING_SLEEVE_WEIGHT); // heavy enough…
    expect(lc.verdict).toBe('unknown'); // …but not a positive determination
    expect(lc.blocking).toBe(false);
    expect(g.sleeveFeasibility.byStructure.blockingSleeves).toEqual([]);
    expect(g.sleeveFeasibility.byPremiumDirection.blockingSleeves).toEqual([]);
    // …and the flag is still LABELLED on the payload — not blocking is not not-reported.
    expect(lc.material).toBe(true);
  });

  it('R1(2) — `weight` counts UNUSABLE members: 12/48 blocks where nUsable would read 7/43', () => {
    // The asymmetry QuantTrader pre-registered: `nUsable` would shrink an offender's
    // apparent weight EXACTLY when its rewards become underivable.
    const c = caseByKey('unusable-rows-count-toward-weight');
    const report = buildForwardTestReport(c.outcomes, { asOf: ET_NOON });
    const axis = report.totals.ceilingAxes.byStructure;
    const raw = axis.sleeves.find((s) => s.key === 'bull_put_spread')!;
    expect(raw.n).toBe(12);
    expect(raw.nUsable).toBe(7); // the fixture really CONTAINS the rows the loose read drops
    expect(raw.weight).toBeCloseTo(12 / 48, 4);
    // The rejected alternative, computed here so the discrimination is visible, not asserted:
    const usableWeight = raw.nUsable / axis.sleeves.reduce((a, s) => a + s.nUsable, 0);
    expect(usableWeight).toBeLessThan(BLOCKING_SLEEVE_WEIGHT); // would NOT have blocked

    const g = gateFor(c);
    expect(sleeve(g, 'byStructure', 'bull_put_spread').blocking).toBe(true);
    expect(g.passed).toBe(false);
  });

  it('R1(3) — the two-axis OR: sub-threshold BY STRUCTURE, blocking BY PREMIUM DIRECTION', () => {
    const g = gateOf('premium-axis-only-block');
    // Neither structure sleeve reaches 0.20 on its own…
    for (const key of ['bull_put_spread', 'bear_call_spread']) {
      const s = sleeve(g, 'byStructure', key);
      expect(s.verdict).toBe('infeasible');
      expect(s.weight!).toBeLessThan(BLOCKING_SLEEVE_WEIGHT);
      expect(s.blocking).toBe(false);
    }
    expect(g.sleeveFeasibility.byStructure.blockingSleeves).toEqual([]);
    // …but they coarsen to one 25% credit sleeve, and the OR catches it.
    expect(g.sleeveFeasibility.byPremiumDirection.blockingSleeves).toEqual(['credit']);
    expect(g.passed).toBe(false);
  });
});

describe('TRA-2361 · AC3 — the block is wired, and the headline it prints is COHERENT', () => {
  it('THE KNOWN-BAD: feasible book + 25% infeasible sleeve ⇒ INFEASIBLE, passed false', () => {
    const g = gateOf('known-bad-25pct-infeasible-sleeve');

    // (1) The book really is `feasible` — this fixture is GREEN in the pre-fix world, which
    //     is the only shape that can produce a `true → false` cell.
    expect(g.feasibility.verdict).toBe('feasible');
    // (2) …and every OTHER criterion passes, so `passed` was true before this change.
    //     ⚠️ TRA-3368 EXCEPTS `sample_size`: this is a 48-row book, and the power
    //     criterion refuses any book that cannot resolve a 0.03R effect. R1's own claim
    //     is unaffected — it is about criterion 3 — but the exception must be NAMED here
    //     rather than loosened to "most criteria pass", or a future regression that broke
    //     an unrelated criterion would hide inside the same slack.
    for (const c of g.criteria.filter(
      (x) => x.name !== 'positive_expectancy' && x.name !== 'sample_size',
    )) {
      expect(c.pass, c.name).toBe(true);
    }
    expect(g.criteria.find((x) => x.name === 'sample_size')!.status).toBe('UNDERPOWERED');
    // (3) The sleeve inside it cannot reach the same bar at any hit rate.
    const s = sleeve(g, 'byStructure', 'bull_put_spread');
    expect(s.verdict).toBe('infeasible');
    expect(s.weight).toBeCloseTo(0.25, 4);
    expect(s.blocking).toBe(true);
    // (4) …and that is now a STOP, on the loud path, not a fourth state.
    const c3 = g.criteria.find((x) => x.name === 'positive_expectancy')!;
    expect(c3.status).toBe('INFEASIBLE');
    expect(c3.pass).toBe(false);
    expect(g.passed).toBe(false);
    // The measured expectancy CLEARS the bar — so nothing but R1 is stopping this.
    expect(g.criteria.find((x) => x.name === 'positive_expectancy')!.actual!).toBeGreaterThan(BAR);
  });

  it('THE HEADLINE NAMES THE SLEEVE, ITS WEIGHT AND ITS CEILING — and does not contradict itself', () => {
    // ⚠️ The defect this asserts against: the pre-existing headline prints the BOOK pair
    // `(bar 0.2R vs payoff ceiling 0.7213R)`, i.e. a sentence saying the criterion CANNOT
    // BE TESTED beside two numbers saying the bar is comfortably reachable.
    const g = gateOf('known-bad-25pct-infeasible-sleeve');
    expect(g.summary).toContain('INFEASIBLE — live capital stays gated');
    expect(g.summary).toContain('BLOCKED BY SLEEVE');
    expect(g.summary).toContain('`bull_put_spread`');
    expect(g.summary).toContain('25% of the graded book');
    expect(g.summary).toContain('cost-net payoff ceiling -0.0009R');
    // …and the book pair, when it appears, is explicitly labelled as NOT the binding one.
    expect(g.summary).toContain('is NOT the binding constraint');
    // The criterion-level field a reader lands on carries the same cause.
    const c3 = g.criteria.find((x) => x.name === 'positive_expectancy')!;
    expect(c3.feasibilityNote).toContain('⛔ SLEEVE BLOCK (TRA-2361 R1)');
    expect(c3.feasibilityNote).toContain('bull_put_spread');
    // The sleeve NOTE must stop calling itself "non-blocking" when it is the reason.
    expect(g.summary).toContain('⛔ BLOCKING');
    expect(g.summary).not.toContain('SLEEVE INFEASIBLE (non-blocking');
  });

  it('a BOOK-level infeasibility still prints the book pair, unchanged', () => {
    // Regression guard on the other branch of the same clause: R1 must not rewrite the
    // headline for the stop that already existed.
    const g = gateOf('book-level-infeasible');
    expect(g.feasibility.verdict).toBe('infeasible');
    expect(g.summary).toContain('payoff ceiling');
    expect(g.passed).toBe(false);
  });

  it('a SINGLE-SLEEVE infeasible book does not print the same sentence twice', () => {
    // ⚠️ Found by running the reconstruction prover, not by reading the diff. The first
    // draft of R1 overrode the sleeve-note suppressions "to be safe", which made a
    // one-sleeve infeasible book emit `sleeve X (100% of the graded book) … the book
    // verdict rests on the remainder` directly under `the book is infeasible` — the same
    // fact twice, with a remainder that does not exist. The suppressions are SOUND under
    // R1 because the headline builds its clause from the `blocking` flags directly, so
    // the cause is named either way. This test pins BOTH halves of that.
    const g = gateOf('book-level-infeasible');
    const s = sleeve(g, 'byStructure', 'bull_put_spread');
    expect(g.sleeveFeasibility.byStructure.sleeves).toHaveLength(1);
    expect(s.blocking).toBe(true); // it really does block…
    expect(g.sleeveFeasibility.note).toBeNull(); // …and the redundant sentence is withheld
    expect(g.summary).not.toContain('rests on the remainder');
    // …while the cause is STILL in the headline, from the flags rather than the note.
    expect(g.summary).toContain('BLOCKED BY SLEEVE');
    expect(g.summary).toContain('`bull_put_spread`');
  });
});

describe('TRA-2361 · AC4 — a sleeve approaching the threshold is visible BEFORE it flips', () => {
  it('9/47 = 19.15% is LABELLED approaching and does NOT block (the live 2026-07-26 weight)', () => {
    const g = gateOf('approaching-not-yet-blocking');
    const s = sleeve(g, 'byStructure', 'bull_put_spread');
    expect(s.weight).toBeCloseTo(0.1915, 4);
    expect(s.weight!).toBeLessThan(BLOCKING_SLEEVE_WEIGHT);
    expect(s.weight!).toBeGreaterThanOrEqual(APPROACHING_BLOCKING_SLEEVE_WEIGHT);
    expect(s.approachingBlockingThreshold).toBe(true);
    expect(s.blocking).toBe(false);
    // ⚠️ TRA-3368 — this used to read `expect(g.passed).toBe(true)`, i.e. "R1 did not
    // stop this book". `passed` can no longer carry that claim: the power criterion closes
    // every 47-row fixture in this file, so a `false` here is now ambiguous between "the
    // warning became a stop" (the regression AC4 exists to catch) and "the sample is
    // small" (expected, and nothing to do with R1). So the claim is re-pointed at the
    // R1-attributable signal, which is unambiguous: criterion 3 is NOT INFEASIBLE and
    // nothing was blocked. Asserting the exact status also pins the precedence — an
    // approaching sleeve leaves the loud stop unclaimed.
    expect(g.criteria.find((c) => c.name === 'positive_expectancy')!.status).toBe('UNDERPOWERED');
    expect(g.sleeveFeasibility.byStructure.blockingSleeves).toEqual([]);
    expect(g.sleeveFeasibility.byPremiumDirection.blockingSleeves).toEqual([]);
    expect(g.summary).not.toContain('BLOCKED BY SLEEVE');
    expect(g.summary).toContain('APPROACHING THE BLOCKING THRESHOLD');
    expect(g.summary).toContain('COMPOSITION ALONE');
  });

  it('the label is WEIGHT-ONLY — it fires on a `feasible` sleeve in the band too', () => {
    // AC4 says "on all sleeves regardless of verdict", and that is the point: a sleeve
    // that is merely heavy today is a sleeve that can block the day its ceiling drops.
    const g = gateOf('approaching-not-yet-blocking');
    const flagged = g.sleeveFeasibility.byPremiumDirection.sleeves.filter(
      (s) => s.approachingBlockingThreshold,
    );
    expect(flagged.map((s) => s.key)).toEqual(['credit']);
    // The band is a half-open interval, so a BLOCKING sleeve is never also "approaching" —
    // the two labels partition, they do not overlap.
    const blocked = gateOf('known-bad-25pct-infeasible-sleeve');
    const b = sleeve(blocked, 'byStructure', 'bull_put_spread');
    expect(b.blocking).toBe(true);
    expect(b.approachingBlockingThreshold).toBe(false);
  });
});

describe('TRA-2361 · AC6 — controls in BOTH directions', () => {
  it('THE KNOWN-GOOD CONTAINS AN INFEASIBLE SLEEVE, at 5% — and nothing blocks', () => {
    // ⚠️ A fixture with NO infeasible sleeve at all cannot distinguish "the threshold
    // works" from "the flag never fires". The negative control has to contain the thing.
    const g = gateOf('known-good-5pct-infeasible-sleeve');
    const s = sleeve(g, 'byStructure', 'bull_put_spread');
    expect(s.verdict).toBe('infeasible'); // ← the control genuinely contains it
    expect(s.weight).toBeCloseTo(0.05, 4);
    expect(s.blocking).toBe(false);
    expect(s.material).toBe(false);
    expect(s.approachingBlockingThreshold).toBe(false);
    expect(g.sleeveFeasibility.byStructure.blockingSleeves).toEqual([]);
    expect(g.sleeveFeasibility.byPremiumDirection.blockingSleeves).toEqual([]);
    // ⚠️ TRA-3368 — this used to read `passed === true` / criterion 3 `PASS`, the
    // "byte-identical to pre-fix" control. It is now `UNDERPOWERED`: a 40-row book cannot
    // resolve a 0.03R effect, so criterion 3 never reaches a plain verdict. What the
    // NEGATIVE CONTROL still has to show is that R1 stayed silent, and it does —
    // `UNDERPOWERED`, not `INFEASIBLE`, is precisely "the sleeve rule did not fire".
    // Keeping the two states distinguishable here is the control; `passed` alone is not,
    // because it is false in both worlds.
    expect(g.criteria.find((c) => c.name === 'positive_expectancy')!.status).toBe('UNDERPOWERED');
    expect(g.summary).not.toContain('BLOCKED BY SLEEVE');
    // …and the sub-threshold offender is STILL REPORTED. A threshold that hides is a new
    // blind spot in an instrument that exists because a true state was invisible.
    expect(g.sleeveFeasibility.byStructure.worstSleeve!.key).toBe('bull_put_spread');
    expect(g.summary).toContain('SLEEVE INFEASIBLE (non-blocking');
  });

  it('the clean mixed book stays SILENT and OPEN under both labels', () => {
    const g = gateOf('clean-book-all-sleeves-feasible');
    expect(g.sleeveFeasibility.byStructure.worstSleeve).toBeNull();
    expect(g.sleeveFeasibility.byStructure.blockingSleeves).toEqual([]);
    // ⚠️ TRA-3368 — same re-pointing as the 5% control above: "SILENT AND OPEN" is now
    // carried by the R1-attributable fields, because a 48-row book is UNDERPOWERED
    // regardless of what its sleeves do.
    expect(g.criteria.find((c) => c.name === 'positive_expectancy')!.status).toBe('UNDERPOWERED');
    expect(g.summary).not.toContain('BLOCKED BY SLEEVE');
    expect(g.summary).not.toContain('SLEEVE INFEASIBLE');
  });
});

describe('TRA-2361 · AC5 — the MONOTONICITY property, pinned from a real differential', () => {
  /**
   * `passed′ ≤ passed` pointwise is the whole safety argument, and it is a claim about the
   * RELATION BETWEEN TWO BUILDS — so a green suite on this build cannot see it. It was
   * measured by running the pre-fix build and this one over the SAME fixtures:
   *
   *   scripts/tra2361-monotonicity-matrix.mjs   (pre-fix `88a072e`, run 2026-07-26)
   *
   * The vector below is a RECORDING of that run's OLD column, not a reading of the old
   * source. Re-derive it with the script — never by reasoning about the old code, which is
   * the exact substitution AC5 forbids. The script is the durable artifact; this test is
   * what keeps the property in the suite after the temp file is gone.
   */
  const OLD_PASSED: Record<string, boolean> = {
    'known-bad-25pct-infeasible-sleeve': true,
    'known-good-5pct-infeasible-sleeve': true,
    'premium-axis-only-block': true,
    'unknown-heavy-sleeve-never-blocks': true,
    'unusable-rows-count-toward-weight': true,
    'clean-book-all-sleeves-feasible': true,
    'book-level-infeasible': false,
    'failing-book-below-bar': false,
    'thin-book-below-sample-floor': false,
    'approaching-not-yet-blocking': true,
  };

  const matrix = () => {
    const cells = { tt: 0, tf: 0, ft: 0, ff: 0 } as Record<'tt' | 'tf' | 'ft' | 'ff', number>;
    const promoted: string[] = [];
    const demoted: string[] = [];
    // ⚠️ TRA-3368 — R1's OWN differential, isolated. A SECOND monotone non-increasing
    // criterion (the power criterion) now closes every fixture in this file, so `demoted`
    // above no longer measures R1: it measures the union of two changes, and R1 could be
    // deleted entirely without moving a single cell of it. The R1-attributable signal is
    // the one R1 actually writes — a non-empty `blockingSleeves` on either axis, which is
    // what makes criterion 3 INFEASIBLE. Pinning THAT is what keeps AC5 a test of R1
    // rather than a test of whichever criterion happens to be strictest today.
    const r1Demoted: string[] = [];
    for (const c of MONOTONICITY_CASES()) {
      const oldPassed = OLD_PASSED[c.key];
      expect(oldPassed, `no recorded pre-fix value for ${c.key} — re-run the script`).not.toBe(
        undefined,
      );
      const g = gateFor(c);
      const newPassed = g.passed;
      const r1Blocked =
        g.sleeveFeasibility.byStructure.blockingSleeves.length > 0 ||
        g.sleeveFeasibility.byPremiumDirection.blockingSleeves.length > 0;
      if (oldPassed && r1Blocked) r1Demoted.push(c.key);
      if (oldPassed && newPassed) {
        cells.tt += 1;
      } else if (oldPassed && !newPassed) {
        cells.tf += 1;
        demoted.push(c.key);
      } else if (!oldPassed && newPassed) {
        cells.ft += 1;
        promoted.push(c.key);
      } else {
        cells.ff += 1;
      }
    }
    return { cells, promoted, demoted, r1Demoted };
  };

  it('ZERO `false → true` cells — the change can only ever CLOSE a capital path', () => {
    // Still exactly the AC5 claim, and it now covers BOTH monotone criteria at once: the
    // OLD column is the pre-R1 recording, so this compares the pre-R1 build against the
    // post-TRA-3368 one. (TRA-3368's own pre/post differential is measured separately, in
    // `gate-power.test.ts`, against a PRE column recorded at `1d7f180d`.)
    const { cells, promoted } = matrix();
    expect(promoted, 'a fixture the pre-fix gate REFUSED now PASSES').toEqual([]);
    expect(cells.ft).toBe(0);
  });

  it('AT LEAST ONE `true → false` cell — otherwise the change is inert and proves nothing', () => {
    const { cells } = matrix();
    expect(cells.tf).toBeGreaterThanOrEqual(1);
  });

  it('and the demoted cells are R1`s OWN — named, so neutering R1 fails here', () => {
    // Named against the R1-attributable projection rather than `passed` (see `matrix`):
    // an edit that accidentally neuters R1 fails HERE, instead of passing a vacuous
    // "everything is closed anyway" check that TRA-3368 would satisfy on its own.
    const { r1Demoted } = matrix();
    expect(r1Demoted.sort()).toEqual([
      'known-bad-25pct-infeasible-sleeve',
      'premium-axis-only-block',
      'unusable-rows-count-toward-weight',
    ]);
  });

  it('the fixture set spans both outcomes under the OLD build (no one-sided matrix)', () => {
    // A transition matrix whose OLD column is all-true cannot exhibit a `false → true`
    // cell even if the change manufactured one — the property would be untestable.
    const olds = MONOTONICITY_CASES().map((c) => OLD_PASSED[c.key]);
    expect(olds.some((x) => x === true)).toBe(true);
    expect(olds.some((x) => x === false)).toBe(true);
  });
});
