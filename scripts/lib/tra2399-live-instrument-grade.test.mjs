// TRA-2399 — the CONTROL SUITE for the AC7 live-instrument grade.
//
// ⚠️⚠️ WHAT MAKES A GREEN RUN HERE MEAN ANYTHING ⚠️⚠️
//
//   The bug this file exists for is NOT "the assertions are missing". All four AC7
//   assertions existed, ran, and returned clean — over `sleeves: []`, where every one of
//   them is a no-op. The script then printed its full ✅ banner with a build SHA beside it.
//   So a suite that only asserted "well-formed payload => OK" would have passed against
//   the BROKEN script too and proved nothing.
//
//   Three things carry the weight here, and they are the three that would go red if
//   someone "simplified" the fix:
//
//     1. BOTH DIRECTIONS. `POSITIVE:` tests assert the populated book still GREENS.
//        `NEGATIVE:` tests assert the empty book does NOT. A one-directional control is
//        half a control: a grader hard-wired to `ungraded` would satisfy the negative half
//        alone, and a grader hard-wired to `ok` would satisfy the positive half alone.
//        The pass state and the fail state must be demonstrably DISTINGUISHABLE.
//     2. `VACUITY:` tests demonstrate the defect rather than asserting it. Each of the
//        four mutations that reliably REDS the populated fixture is applied to the empty
//        one, and each is shown NOT to fire there. That is the ticket's claim, executed.
//        Without these, "empty => ungraded" is just a rule someone typed.
//     3. `AC2-SEPARATION:` tests pin the thing the new exit code must NOT break — a live
//        `infeasible` book and a LIVE R1 BLOCK are facts about the trading book and still
//        exit 0. If the vacuity rule ever starts reding the book, these go red.
//
// Run: node --test scripts/lib/tra2399-live-instrument-grade.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gradeLiveSleeveInstrument, EXIT_CODE, VERDICT } from './tra2399-live-instrument-grade.mjs';

// Every fixture below is a FACTORY, not a shared literal: each test mutates its payload,
// and a shared object would let one test's mutation decide another test's verdict.
const fragility = (leaveOneOut = []) => ({
  bookVerdict: 'feasible',
  largestSleeveKey: null,
  largestSleeveExcluded: null,
  leaveOneOut,
  flipsOnSingleSleeveRemoval: false,
  flippingSleeves: [],
});

const sleeve = (key, n, bookN, over) => ({
  key,
  n,
  nUsable: n,
  weight: n / bookN,
  ceilingGrossR: 0.31,
  avgCostR: 0.04,
  ceilingNetR: 0.27,
  verdict: 'feasible',
  material: n / bookN >= 0.1,
  blocking: false,
  approachingBlockingThreshold: n / bookN >= 0.15 && n / bookN < 0.2,
  reason: 'reachable at a hit rate below 1',
  ...over,
});

// ── THE POPULATED FIXTURE ────────────────────────────────────────────────────
//
// Shaped on the live bqb1 book QuantTrader cited on TRA-2399: n=47, ceilingSources
// {47,0,0}, and `bull_call_spread` at 9/47 = 19.15% (the sleeve sitting 0.85pp under
// BLOCKING_SLEEVE_WEIGHT, per gate-feasibility.ts). Both axes partition the SAME 47 rows,
// which is what `sum(sleeve.n) === bookN` exists to assert.
const POPULATED = () => ({
  asOfDate: '2026-07-26',
  passed: false,
  summary: 'live capital gate: 3 of 5 criteria met',
  criteria: [{ name: 'positive_expectancy', status: 'FAIL', pass: false }],
  feasibility: {
    verdict: 'feasible',
    ceilingGrossR: 0.3112,
    avgCostR: 0.0721,
    ceilingR: 0.2391,
    barR: 0.2,
    ceilingSources: { credit: 47, debit: 0, unknown: 0 },
  },
  sleeveFeasibility: {
    byStructure: {
      axis: 'strategy',
      barR: 0.2,
      bookN: 47,
      sleeves: [
        sleeve('bull_put_spread', 31, 47),
        sleeve('bull_call_spread', 9, 47),
        sleeve('bear_call_spread', 7, 47),
      ],
      blockingSleeves: [],
      worstSleeve: null,
      infeasibleWeight: 0,
      fragility: fragility(),
      note: null,
    },
    byPremiumDirection: {
      axis: 'premium_direction',
      barR: 0.2,
      bookN: 47,
      sleeves: [sleeve('credit', 38, 47), sleeve('debit', 9, 47)],
      blockingSleeves: [],
      worstSleeve: null,
      infeasibleWeight: 0,
      fragility: fragility(),
      note: null,
    },
  },
});

// ── THE EMPTY-BOOK FIXTURE — the exact payload that used to green ───────────
//
// `bookN: 0`, `sleeves: []`, `blockingSleeves: []` on BOTH axes. Everything else is
// well-formed: the block is PRESENT, the fields are PRESENT. That is the whole point —
// the absent-field case was already handled (it exits 1); the hole was present-but-empty.
const EMPTY = () => ({
  asOfDate: '2026-07-26',
  passed: false,
  summary: 'live capital gate: 0 of 5 criteria met',
  criteria: [{ name: 'positive_expectancy', status: 'FAIL', pass: false }],
  feasibility: {
    verdict: 'unknown',
    ceilingGrossR: null,
    avgCostR: null,
    ceilingR: null,
    barR: 0.2,
    ceilingSources: { credit: 0, debit: 0, unknown: 0 },
  },
  sleeveFeasibility: {
    byStructure: {
      axis: 'strategy',
      barR: 0.2,
      bookN: 0,
      sleeves: [],
      blockingSleeves: [],
      worstSleeve: null,
      infeasibleWeight: null,
      fragility: fragility(),
      note: null,
    },
    byPremiumDirection: {
      axis: 'premium_direction',
      barR: 0.2,
      bookN: 0,
      sleeves: [],
      blockingSleeves: [],
      worstSleeve: null,
      infeasibleWeight: null,
      fragility: fragility(),
      note: null,
    },
  },
});

// The empty fixture's `feasibility.verdict` is `unknown` while criterion 3 reads FAIL,
// which trips the (unrelated, pre-existing) TRA-2353 AC4 headline check. Real servers put
// the REACHABILITY UNKNOWN sentence in the summary there; so does this fixture, otherwise
// every empty-book test below would go FAIL for a reason that has nothing to do with
// vacuity and the suite would prove the wrong thing.
const EMPTY_OK_HEADLINE = () => {
  const g = EMPTY();
  g.summary = 'live capital gate: REACHABILITY UNKNOWN — no resolved ideas';
  return g;
};

// ═══════════════════════════════════════════════════════ POSITIVE DIRECTION ══
// Without these, "empty does not green" is satisfied by a grader that never greens.

test('POSITIVE: the populated book GREENS — verdict ok, no problems, both axes graded', () => {
  const r = gradeLiveSleeveInstrument(POPULATED());
  assert.deepEqual(r.problems, []);
  assert.equal(r.verdict, VERDICT.OK);
  assert.deepEqual(r.gradedAxes, ['byStructure', 'byPremiumDirection']);
  assert.deepEqual(r.vacuousAxes, []);
  assert.equal(EXIT_CODE[r.verdict], 0);
});

test('POSITIVE: the populated book reports the rows it actually graded (47 on each axis)', () => {
  // A green whose stated population is 0 is the artefact this ticket is about. The count
  // has to travel with the verdict, or the banner is unfalsifiable again.
  const r = gradeLiveSleeveInstrument(POPULATED());
  assert.deepEqual(
    r.axes.map((a) => [a.name, a.sumN, a.bookN, a.graded]),
    [
      ['byStructure', 47, 47, true],
      ['byPremiumDirection', 47, 47, true],
    ],
  );
});

// AC4, PINNED: one sleeve is ENOUGH to grade. Decided on purpose — see the module header.
// If someone extends the vacuity rule to `length === 1` later, this test is where that
// decision gets re-argued rather than silently flipped.
test('AC4: a SINGLE-sleeve axis with rows is GRADED (decided, not inherited)', () => {
  const g = POPULATED();
  g.sleeveFeasibility.byStructure.sleeves = [sleeve('bull_put_spread', 47, 47)];
  g.sleeveFeasibility.byPremiumDirection.sleeves = [sleeve('credit', 47, 47)];
  const r = gradeLiveSleeveInstrument(g);
  assert.equal(r.verdict, VERDICT.OK);
  assert.deepEqual(r.vacuousAxes, []);
  assert.equal(r.axes[0].graded, true);
});

test('AC4: the single-sleeve partition check is FALSIFIABLE — that is why it counts', () => {
  // The reason one sleeve grades and zero sleeves do not: at one sleeve a dropped row is
  // still observable. At zero it is not. This is that claim, executed.
  const g = POPULATED();
  g.sleeveFeasibility.byStructure.sleeves = [sleeve('bull_put_spread', 46, 47)]; // one row lost
  g.sleeveFeasibility.byPremiumDirection.sleeves = [sleeve('credit', 47, 47)];
  const r = gradeLiveSleeveInstrument(g);
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.ok(r.problems.some((p) => p.includes('sum(sleeve.n) = 46') && p.includes('bookN = 47')));
});

// ═══════════════════════════════════════════════════════ NEGATIVE DIRECTION ══

test('AC1: the EMPTY book does NOT green — verdict ungraded, exit 4, no ✅ path', () => {
  const r = gradeLiveSleeveInstrument(EMPTY_OK_HEADLINE());
  assert.notEqual(r.verdict, VERDICT.OK);
  assert.equal(r.verdict, VERDICT.UNGRADED);
  assert.equal(EXIT_CODE[r.verdict], 4);
  assert.notEqual(EXIT_CODE[r.verdict], 0);
  assert.deepEqual(r.gradedAxes, []);
  assert.deepEqual(r.vacuousAxes, ['byStructure', 'byPremiumDirection']);
});

test('AC1: the ungraded reason NAMES the cause — vacuity, not a book verdict', () => {
  const r = gradeLiveSleeveInstrument(EMPTY_OK_HEADLINE());
  assert.ok(r.ungradedReason, 'an ungraded verdict with no stated reason is an unexplained hold');
  assert.match(r.ungradedReason, /empty|no axes/i);
  // It must not read as a claim about the book. `infeasible` is the word an operator
  // would act on wrongly.
  assert.doesNotMatch(r.ungradedReason, /infeasible/i);
});

test('AC1: `sleeveFeasibility: {}` — present, zero axes — is UNGRADED, not OK', () => {
  const g = EMPTY_OK_HEADLINE();
  g.sleeveFeasibility = {};
  const r = gradeLiveSleeveInstrument(g);
  assert.equal(r.verdict, VERDICT.UNGRADED);
  assert.match(r.ungradedReason, /NO axes/);
});

test('AC1: sleeve OBJECTS present but every n=0 is UNGRADED — rows are the preimage', () => {
  const g = EMPTY_OK_HEADLINE();
  g.sleeveFeasibility.byStructure.sleeves = [{ ...sleeve('bull_put_spread', 0, 1), n: 0, weight: 0 }];
  g.sleeveFeasibility.byPremiumDirection.sleeves = [{ ...sleeve('credit', 0, 1), n: 0, weight: 0 }];
  const r = gradeLiveSleeveInstrument(g);
  assert.equal(r.verdict, VERDICT.UNGRADED);
});

test('AC1: an axis carrying NO `sleeves` array is a FAIL, not a silent skip', () => {
  // It used to be dropped by `.filter(([, a]) => a && a.sleeves)` — same vacuity class,
  // one level up: an axis that grades nothing while contributing to a green.
  const g = POPULATED();
  delete g.sleeveFeasibility.byPremiumDirection.sleeves;
  const r = gradeLiveSleeveInstrument(g);
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.ok(r.problems.some((p) => p.includes('no `sleeves` array')));
});

test('REGRESSION: the real `note` sibling is NOT an axis and must not be graded as one', () => {
  // `BookSleeveFeasibility` carries `note: string | null` alongside the two axes, and the
  // live payload emits it (observed on localhost:4242 build ef4f568 as `note: null`).
  // Reding it as an axis-without-sleeves would false-block every well-formed payload —
  // the axis detector is keyed on SHAPE for exactly this reason.
  const g = POPULATED();
  g.sleeveFeasibility.note = null;
  assert.equal(gradeLiveSleeveInstrument(g).verdict, VERDICT.OK);
  g.sleeveFeasibility.note = 'SLEEVE INFEASIBLE (⛔ BLOCKING — TRA-2361 R1, strategy)';
  const r = gradeLiveSleeveInstrument(g);
  assert.equal(r.verdict, VERDICT.OK);
  assert.deepEqual(r.gradedAxes, ['byStructure', 'byPremiumDirection']);
  assert.equal(r.axes.length, 2, '`note` must not appear in the graded axis list');
});

test('REGRESSION: an ABSENT `sleeveFeasibility` block still FAILS (exit 1), unchanged', () => {
  // QuantTrader's own negative control against bqb1 build 408f06a5. This ticket must not
  // move it: FAIL outranks UNGRADED, so a broken payload keeps reading as broken.
  const g = EMPTY_OK_HEADLINE();
  delete g.sleeveFeasibility;
  const r = gradeLiveSleeveInstrument(g);
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(EXIT_CODE[r.verdict], 1);
  assert.ok(r.problems.some((p) => p.includes('carries NO `sleeveFeasibility` block')));
});

// ══════════════════════════════════════════════ THE VACUITY DEMONSTRATION ════
//
// Each mutation below REDS the populated fixture. Applied to the empty one, none of them
// can even be expressed or can fire. That asymmetry IS the defect — not asserted, run.

test('VACUITY: `weight` missing REDS a populated axis — and has no preimage on an empty one', () => {
  const bad = POPULATED();
  delete bad.sleeveFeasibility.byStructure.sleeves[0].weight;
  const red = gradeLiveSleeveInstrument(bad);
  assert.equal(red.verdict, VERDICT.FAIL);
  assert.ok(red.problems.some((p) => p.includes('carry no `weight`')));

  // On `sleeves: []` the same check is `[].filter(...).length` → 0. There is no sleeve to
  // strip the field from; the assertion cannot be made to fail at all.
  const empty = gradeLiveSleeveInstrument(EMPTY_OK_HEADLINE());
  assert.ok(!empty.problems.some((p) => p.includes('carry no `weight`')));
});

test('VACUITY: `blocking` missing REDS a populated axis — and has no preimage on an empty one', () => {
  const bad = POPULATED();
  for (const s of bad.sleeveFeasibility.byStructure.sleeves) delete s.blocking;
  const red = gradeLiveSleeveInstrument(bad);
  assert.equal(red.verdict, VERDICT.FAIL);
  assert.ok(red.problems.some((p) => p.includes('carry no `blocking` flag')));

  const empty = gradeLiveSleeveInstrument(EMPTY_OK_HEADLINE());
  assert.ok(!empty.problems.some((p) => p.includes('carry no `blocking` flag')));
});

test('VACUITY: the PARTITION check REDS a filtered populated axis — and compares 0 to 0 when empty', () => {
  // The load-bearing one. TRA-2361 AC2: nothing is filtered. Drop the largest sleeve.
  const bad = POPULATED();
  bad.sleeveFeasibility.byStructure.sleeves.shift();
  const red = gradeLiveSleeveInstrument(bad);
  assert.equal(red.verdict, VERDICT.FAIL);
  assert.ok(red.problems.some((p) => p.includes('sum(sleeve.n) = 16') && p.includes('bookN = 47')));

  // A partition that dropped EVERY sleeve is the MAXIMAL case of exactly that defect, and
  // it is the single input on which this check cannot fire: 0 === 0.
  const empty = gradeLiveSleeveInstrument(EMPTY_OK_HEADLINE());
  assert.ok(!empty.problems.some((p) => p.includes('sum(sleeve.n)')));
  assert.equal(empty.axes[0].sumN, 0);
  assert.equal(empty.axes[0].bookN, 0);
  // ...which is precisely why AC1 has to catch it somewhere else.
  assert.equal(empty.verdict, VERDICT.UNGRADED);
});

test('VACUITY: the `blockingSleeves` projection REDS on drift — and compares [] to [] when empty', () => {
  const bad = POPULATED();
  bad.sleeveFeasibility.byStructure.blockingSleeves = ['bull_put_spread']; // no sleeve is flagged
  const red = gradeLiveSleeveInstrument(bad);
  assert.equal(red.verdict, VERDICT.FAIL);
  assert.ok(red.problems.some((p) => p.includes('disagrees with the per-sleeve')));

  const empty = gradeLiveSleeveInstrument(EMPTY_OK_HEADLINE());
  assert.ok(!empty.problems.some((p) => p.includes('disagrees with the per-sleeve')));
});

test('VACUITY: a partially-empty payload is PARTIAL, not silently whole', () => {
  // Decided on purpose: one genuinely graded axis IS evidence, so this stays exit 0 — but
  // the empty axis is named rather than folded into the green.
  const g = POPULATED();
  g.sleeveFeasibility.byPremiumDirection.bookN = 0;
  g.sleeveFeasibility.byPremiumDirection.sleeves = [];
  const r = gradeLiveSleeveInstrument(g);
  assert.equal(r.verdict, VERDICT.OK);
  assert.deepEqual(r.gradedAxes, ['byStructure']);
  assert.deepEqual(r.vacuousAxes, ['byPremiumDirection']);
});

// ═════════════════════════════════════════════════════ AC2 — SEPARATION ══════
//
// The new exit code must not leak into the book. These are the states TRA-2361 AC7
// deliberately left green, and they must STAY green.

test('AC2-SEPARATION: a live INFEASIBLE book still exits 0 — a market observation, not a red', () => {
  const g = POPULATED();
  g.feasibility.verdict = 'infeasible';
  g.feasibility.ceilingR = 0.11;
  for (const s of g.sleeveFeasibility.byStructure.sleeves) s.verdict = 'infeasible';
  const r = gradeLiveSleeveInstrument(g);
  assert.deepEqual(r.problems, []);
  assert.equal(r.verdict, VERDICT.OK);
});

test('AC2-SEPARATION: a live R1 BLOCK, reported coherently, still exits 0', () => {
  const g = POPULATED();
  g.criteria = [{ name: 'positive_expectancy', status: 'INFEASIBLE', pass: false }];
  g.summary =
    'SLEEVE INFEASIBLE (⛔ BLOCKING — TRA-2361 R1) — sleeve `bear_call_spread` cannot reach the bar';
  const st = g.sleeveFeasibility.byStructure;
  st.sleeves[2].verdict = 'infeasible';
  st.sleeves[2].blocking = true;
  st.blockingSleeves = ['bear_call_spread'];
  st.worstSleeve = st.sleeves[2];
  st.infeasibleWeight = 7 / 47;
  const r = gradeLiveSleeveInstrument(g);
  assert.deepEqual(r.problems, []);
  assert.equal(r.verdict, VERDICT.OK, 'a live block is a fact about the BOOK, never a red build');
});

test('AC2-SEPARATION: a SELF-CONTRADICTORY block is still a FAIL (the instrument, not the book)', () => {
  // The other half of the separation: R1 biting while criterion 3 disagrees is an
  // instrument defect, and it must stay one.
  const g = POPULATED();
  const st = g.sleeveFeasibility.byStructure;
  st.sleeves[2].blocking = true;
  st.blockingSleeves = ['bear_call_spread'];
  const r = gradeLiveSleeveInstrument(g);
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.ok(r.problems.some((p) => p.includes('not INFEASIBLE')));
});

test('AC2-SEPARATION: the three exit codes are DISTINCT — ok/fail/ungraded cannot collapse', () => {
  // "It cannot separate the pass state from the fail state" is the defect. Pin the codes.
  assert.equal(EXIT_CODE.ok, 0);
  assert.equal(EXIT_CODE.fail, 1);
  assert.equal(EXIT_CODE.ungraded, 4);
  assert.equal(new Set(Object.values(EXIT_CODE)).size, 3);
  // 3 is BLIND and belongs to the CLI's fetch path — it must not be reused here.
  assert.ok(!Object.values(EXIT_CODE).includes(3));
});

// ══════════════════════════════════════════════════════════ THE WIRING ═══════
//
// Every test above grades the MODULE. This one grades the CHECK SCRIPT, which is the
// artefact people actually run — without it the whole suite can stay green while the
// script keeps its own stale copy of the logic, which is how this defect shipped.

test('WIRING: the check script routes through this module and exits 4 on ungraded', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../tra2335-feasibility-check.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(src, /from '\.\/lib\/tra2399-live-instrument-grade\.mjs'/);
  assert.match(src, /graded\.verdict === 'ungraded'/);
  assert.match(src, /process\.exit\(EXIT_CODE\.ungraded\)/);
  // The ✅ banner must sit BELOW the ungraded branch, or an empty book falls through to it.
  assert.ok(
    src.indexOf("graded.verdict === 'ungraded'") < src.indexOf('✅ OK — the live gate publishes'),
    'the ungraded branch must precede the ✅ banner',
  );
  // Exit 4 has to be documented in the header — AC2 asks for it by name.
  assert.match(src, /4 UNGRADED/);
});
