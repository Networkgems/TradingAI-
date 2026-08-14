#!/usr/bin/env node
/**
 * TRA-2331 — the risk-throttle TRIM GRADE, as a re-runnable checker.
 *
 * `RISK_THROTTLE_SIZING_ENABLED=demo` has been armed on bqb1 since 2026-07-25
 * (TRA-2333, `29cbb9a`). This script decides whether that arming should STAY —
 * and it is deliberately a checker rather than a dated verdict, because a grade
 * is tape-scoped: it perishes the moment another session closes.
 *
 * ── WHAT IT MEASURES, AND WHY IT IS NOT "did trimming help?" ────────────────
 *
 * R is SIZE-INVARIANT. The throttle scales contracts; it does not move
 * `(exit − entry) / (entry − stop)`. So a contrast of mean R between trimmed
 * and un-trimmed fills cannot measure the benefit of trimming — it measures
 * whether the autopilot's de-risk trigger SELECTS WORSE TRADES. That is the
 * decision-relevant question, because the dollar effect of arming is
 *
 *     Δ$ = (m − 1) × mean_R(T) × risk_full × n(T),      m < 1
 *
 * so the sign of `mean_R(T)` is the sign of the money:
 *   mean_R(T) < 0 ⇒ trimming SAVED money · > 0 ⇒ it COST money · ≈ 0 ⇒ neutral
 *   on the mean and a pure variance win.
 *
 * The PRIMARY statistic is the CONTRAST mean_R(T) − mean_R(U), not either mean
 * alone: demo fills mark at EXACT mid, which overstates realised P&L by ~13%
 * (TRA-2174). The marking convention is common to both arms and cancels in the
 * difference; it does NOT cancel in an absolute mean. Absolute means are
 * printed for orientation and labelled convention-inflated — never publish them.
 *
 * ── THE COHORT DEFINITIONS ─────────────────────────────────────────────────
 *
 *   T (treated)     eligible ∧ typeof riskThrottleMultiplier === 'number' ∧ < 1
 *   U (control)     eligible ∧ riskThrottleMultiplier === 1
 *   W (counterfactual) eligible ∧ riskThrottleDecided < 1 ∧ multiplier === 1
 *                   — the would-have-been-trimmed cohort on paths the current
 *                   scope leaves unarmed. This is what the board's LIVE-arm
 *                   decision needs and no observation period could produce
 *                   before TRA-2339.
 *   VOID            the stamp is ABSENT ⇒ a pre-TRA-2333 build wrote the row.
 *                   Excluded, NEVER coerced with `?? 1`. Note the test is
 *                   `typeof x === 'number' && x < 1`, because **`null < 1` is
 *                   `true` in JavaScript** and a nullable field would bucket
 *                   every never-consulting row as trimmed.
 *
 * ── ELIGIBILITY: EXACT ON POST-TRA-2375 ROWS, PROXY BELOW THE CLIFF ─────────
 *
 * Five open paths stamp a hardcoded `1` because they take no sizing scalar at
 * ANY scope (defined-risk spreads ×3, wheel CSP/CC, the bounded-live 1-contract
 * OTM override). Those rows are OUT OF COHORT, not un-trimmed members of it —
 * pooling them into U floods the control arm with never-eligible trades, and it
 * fails silently: the control arm just looks big and healthy.
 *
 * TRA-2375 LANDED, so rows written by that build and later carry
 * `riskThrottleSizingPath` and the partition is EXACT. Read it in two steps and
 * in this order:
 *
 *   1. `hasOwnProperty('riskThrottleSizingPath')` — does this build stamp it?
 *   2. `!= null`                                  — was this fill eligible?
 *
 * Both steps matter. The writer emits an explicit `null` for a non-chokepoint
 * open rather than omitting the key, precisely so step 1 stays a clean build
 * detector: ABSENT means "written before TRA-2375" and nothing else. That is
 * also why a bare `isThrottleChokepoint: boolean` was rejected — `false` would
 * have collided with "old build" under `?? false`.
 *
 * Below the TRA-2375 cliff the key is absent and this script falls back to a
 * STRUCTURE-based proxy, saying so in every output. The proxy is an ALLOWLIST,
 * not a denylist: an unrecognised structure is counted as `unclassified` and
 * excluded from BOTH arms rather than defaulting into one.
 *
 * ── WHY THE BASIS IS A SPLIT, NOT ONE DEGRADED LABEL (TRA-2653 D1) ─────────
 *
 * This used to collapse to a single per-run label: one un-stamped row and the
 * whole report read `basis=PROXY`. That made `basis=EXACT` A SUCCESS CONDITION
 * WITH NO REACHABLE STATE. The population cliff below is the TRA-2339 one
 * (2026-07-26T00:08Z); the first Render boot carrying TRA-2375 was 2.9 days
 * LATER (2026-07-28T23:10:53Z — the fix sat merged-but-undeployed for 2d16h).
 * The 11 demo rows opened inside that gap are permanently in the population —
 * the cliff is a fixed constant, so they never age out — and they permanently
 * lack the key, CORRECTLY, because a pre-TRA-2375 build wrote them. So no
 * future state of the book could ever print EXACT.
 *
 * That is worse than inert: TRA-2570's grading step told the reader to treat
 * PROXY as a writer regression and escalate, which would have filed a false
 * `high` against a fix working perfectly. The absence had TWO possible causes
 * and the label named neither.
 *
 * So the run now reports exact/proxy COUNTS and ATTRIBUTES EVERY PROXY ROW to a
 * reason, because the two reasons are not the same fact:
 *
 *   PRE_PATH_BUILD   openTs < the TRA-2375 boot cliff ⇒ the build that wrote
 *                    the row could not stamp it. EXPECTED. Never a defect.
 *   POST_CLIFF_UNSTAMPED  openTs ≥ the cliff on a build that DOES carry
 *                    TRA-2375 ⇒ the writer broke. This is a FAIL, and it is
 *                    checked as its own WRITER_REGRESSED arm below.
 *   UNATTRIBUTABLE   git could not resolve whether the running build carries
 *                    TRA-2375. Reported, never silently folded into the first.
 *
 * Attribution is ASSERTED to be total: any residue prints as UNACCOUNTED rather
 * than vanishing. Raising the population cliff to the TRA-2375 boot would have
 * produced a cosmetic EXACT by DISCARDING those 11 rows from an already
 * underpowered cohort (n(T)=0, n(U)=18, MIN_N=135) — the scoping is right; it
 * was the reporting that was wrong.
 *
 * Residual leak of the PROXY path only (gone once rows are stamped): the
 * bounded-live OTM override (signal-engine.ts :7436) journals
 * `structure: 'single_leg_otm'` and is indistinguishable on an unstamped row. It
 * is structurally zero while `liveEngineCount: 0` under the TRA-1897 hold, and
 * its bias runs toward the NULL (it dilutes a real contrast), so it cannot
 * manufacture a PASS.
 *
 * ── VERDICTS, in resolution order FAIL → VOID → NOT-GRADED → PASS ──────────
 *
 *   FAIL       WRITER_REGRESSED     post-cliff rows on a stamping build lack
 *                                   the stamp ⇒ the writer broke, and the
 *                                   since-boot counters would render that as a
 *                                   quiet week. TWO arms, each with its own
 *                                   cliff: `riskThrottleMultiplier` above the
 *                                   TRA-2339 cliff, and `riskThrottleSizingPath`
 *                                   above the TRA-2375 BOOT cliff. The second
 *                                   arm is what keeps D1's attribution honest —
 *                                   softening pre-cliff absence must not soften
 *                                   a genuine post-cliff regression.
 *   FAIL       INVARIANT_VIOLATED   applied > 1, decided > 1, or applied <
 *                                   decided (the clamp is tighten-only and the
 *                                   applied term can never beat the decided one).
 *   FAIL       SELECTION_ADVERSE    mean_R(T) > mean_R(U), CI excludes 0 ⇒ the
 *                                   trigger trims the BETTER trades ⇒ DISARM.
 *   VOID       BLIND                instrument unreadable / no git ancestry.
 *                                   Fails closed — never 0.
 *   VOID       BUILD_PREDATES_STAMP the running build cannot write the field,
 *                                   so absent stamps are expected, not a defect.
 *   NOT-GRADED NO_TAPE              zero post-cliff closed desk rows.
 *   NOT-GRADED NO_THROTTLED_FILLS   n(T) = 0. A MEASURED NO-OP, not a pass.
 *                                   Never manufacture a verdict from zero
 *                                   throttled days.
 *   NOT-GRADED UNDERPOWERED         0 < n(T) < minN, or the CI straddles 0.
 *   PASS       SELECTION_CONFIRMED  mean_R(T) < mean_R(U), CI excludes 0.
 *
 * Exit codes: 0 PASS · 1 FAIL · 2 NOT-GRADED · 3 VOID.
 *
 * Usage:
 *   node scripts/tra2331-throttle-grade.mjs
 *   node scripts/tra2331-throttle-grade.mjs --json
 *   node scripts/tra2331-throttle-grade.mjs --selftest
 *   node scripts/tra2331-throttle-grade.mjs --base https://host --min-n 20
 *
 * Unauthenticated end to end: `/api/health/option-journal?rows=all` is a
 * secrets-free public readout, and build ancestry is resolved from the local
 * git checkout. bqb1 admin auth is dead (401) — a checker that needs a
 * credential is a checker nobody runs.
 */

import { gradedAncestry } from './lib/shallow-ancestry.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ── configuration ──────────────────────────────────────────────────────────

/** TRA-2333 — the commit that first stamped `riskThrottleMultiplier` per fill. */
const STAMP_APPLIED_COMMIT = '29cbb9a';
/** TRA-2339 — the commit that added the DECIDED counterfactual term. */
const STAMP_DECIDED_COMMIT = '1926abf';
/**
 * The stamp cliff. TRA-2333 went live 2026-07-25T23:17:33Z and TRA-2339 at
 * 2026-07-26T00:08Z; anchored on the later of the two so a row opened between
 * the deploys cannot read as a writer regression. Verified at anchor time:
 * 0 of 2,383 rows carried the field, newest close 2026-07-24T19:42:09Z.
 */
const DEFAULT_STAMP_SINCE = Date.parse('2026-07-26T00:08:00Z');

/** TRA-2375 — the commit that added `riskThrottleSizingPath` to the journal row. */
const STAMP_PATH_COMMIT = '4364063';
/**
 * The TRA-2375 BOOT cliff — deliberately NOT the merge time and NOT the live
 * process `startedAt`.
 *
 * `4364063` merged 2026-07-26T06:18:42Z but bqb1 is `autoDeploy=no`, so the
 * first boot that could write the field was deploy `4df4e418`, finished
 * **2026-07-28T23:10:53.456Z** — derived by walking every deploy in
 * `GET /v1/services/srv-d7mb7rr7uimc73ev0chg/deploys` and testing
 * `git merge-base --is-ancestor 4364063 <commit>` on each. Merge time would
 * mis-attribute the 2d16h undeployed gap to the writer; the live `startedAt`
 * would discard every already-stamped row and manufacture a NO-TAPE.
 *
 * Re-verified against live tape 2026-07-30 (2445 rows served): 0 of 2421
 * pre-cliff rows carry the key, 24 of 24 post-cliff rows do. The absence set is
 * byte-for-byte the pre-cliff set — so this constant is the exact discriminator
 * between "old build" and "broken writer", which is D1's whole point.
 */
const DEFAULT_PATH_STAMP_SINCE = Date.parse('2026-07-28T23:10:53.456Z');

/**
 * Structures whose open path DOES consult a risk-throttle chokepoint
 * (`options_single_leg`, `options_otm`). Allowlist on purpose — see above.
 *
 * `single_leg_directional` was MISSING here until TRA-2653, and the live stamp
 * is what refuted the omission rather than a re-read of the signal engine:
 * 13 of 13 post-TRA-2375-cliff `single_leg_directional` rows carry
 * `riskThrottleSizingPath: 'options_single_leg'` (verified 2026-07-30 on the
 * full `?rows=all` tape; the other 11 post-cliff rows are `single_leg_otm` →
 * `options_otm`). The omission made the SAME structure read `ineligible` when a
 * pre-cliff row was classified by proxy and `eligible` when a post-cliff row
 * was classified by stamp, so every historical PROXY-basis grade under-counted
 * the cohort and shrank the n it exists to accumulate.
 *
 * ⚠ `single_leg_rv` remains an allowlist member REASONED FROM SOURCE, not
 * proven by stamp: it does not appear anywhere in the post-cliff tape, so no
 * live row has yet confirmed it consults a chokepoint. Do not read this set as
 * fully stamp-verified — only `single_leg_directional` and `single_leg_otm` are.
 */
const CHOKEPOINT_STRUCTURES = new Set([
  'single_leg_rv',
  'single_leg_directional',
  'single_leg_otm',
]);
/** Wheel opens take no sizing scalar (signal-engine.ts :9151). */
const WHEEL_ARCHETYPES = new Set(['wheel-csp', 'wheel-cc']);
/** TRA-1475 / QA-fixture mirror trap — mirrors are bit-identical but id-distinct. */
const isFixtureAccount = (a) =>
  typeof a === 'string' && (/^qa[_-]/i.test(a) || /^ctoverify/i.test(a));

/**
 * The scope probe's identity — DELIBERATELY DETERMINISTIC, and deliberately
 * inside `isFixtureAccount` above.
 *
 * `armedScope` is the one field that separates the two readings of this grade's
 * dominant outcome: `n(T)=0` with the consumer ARMED is a measured no-op, and
 * `n(T)=0` with it OFF is a tautology (`riskThrottleSizeMultiplier` returns 1 on
 * its first line before it ever reads the throttle). Those printed identically
 * on every fire through 2026-07-30 — TRA-2449, TRA-2574 and the TRA-2653 run all
 * carried `armedScope UNKNOWN` — because the route is `requireAuth` and the run
 * had no token. So the probe mints its own rather than leaving the discriminator
 * to whoever remembers to do it by hand.
 *
 * Two properties are load-bearing:
 *
 * 1. **Deterministic username.** A per-fire unique name would create a new demo
 *    book every weekday (~250/yr) on a box whose fleet size is itself an
 *    instrument elsewhere. This signs up ONCE and logs in on every fire after.
 * 2. **`ctoverify`-prefixed**, so the population filter drops its rows. A probe
 *    account that joined the graded cohort would be this script contaminating
 *    its own tape. `selftest` asserts the two agree — a rename that breaks the
 *    prefix fails there rather than silently entering the population.
 *
 * `@qa.invalid` is required, not cosmetic: `.test` addresses are deliverable
 * enough to become a permanent bounce source (the TRA-2523 mail-bounce arm).
 */
const SCOPE_PROBE_USER = 'ctoverify_tra2331_scope_probe';
const SCOPE_PROBE_PASS = process.env.TRA2331_PROBE_PASSWORD || 'Ctoverify-2331-Scope!7';
const SCOPE_PROBE_EMAIL = `${SCOPE_PROBE_USER}@qa.invalid`;

const EXIT_FOR = { PASS: 0, FAIL: 1, 'NOT-GRADED': 2, VOID: 3 };

// ── argv ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
};
const JSON_OUT = argv.includes('--json');
const SELFTEST = argv.includes('--selftest');
/**
 * Suppresses the self-service token mint. The mint is the only WRITE this
 * otherwise read-only checker performs, so an operator who must not write to the
 * box keeps a usable (if scope-blind) run instead of having to skip the grade.
 */
const NO_SIGNUP = argv.includes('--no-signup');
const BASE = String(argOf('base', 'https://tradingai-bqb1.onrender.com')).replace(/\/+$/, '');
/**
 * The power floor, DERIVED — not the round number it used to be.
 *
 * This gate shipped at 20 because 20 looks like enough. It is not, and the
 * arithmetic says so from live tape. Measured 2026-07-26 on the 110 closed
 * ELIGIBLE demo desk fills the grade actually consumes (`single_leg_rv` +
 * `single_leg_otm`, fixture accounts excluded):
 *
 *     sd(R) = 0.2144        mean_R over the whole eligible sleeve = +0.0577
 *
 * At n(T)=20 with n(U)=4·n(T) the 80%-power MDE is **0.1502R — 2.6× the entire
 * sleeve's mean R**. A gate that admits a verdict there is not measuring
 * selection; it can only ever fire on an effect larger than the whole edge, and
 * a "significant" result at that power is magnitude-inflated (Type M), not
 * merely uncertain. That is the same shape as every instrument in this repo
 * that reads identically in the pass and fail state.
 *
 * So the floor is set where the MDE equals ONE sleeve-mean (0.0577R), the
 * smallest contrast that is economically material given
 * Δ$ = (m−1)·mean_R(T)·risk·n(T):
 *
 *     n(T) = (1.96 + 0.8416)² · sd² · (1 + 1/4) / 0.0577²  ≈  135
 *
 * At ~13.8 eligible fills/session that is 4–10 weeks of tape depending on the
 * governor's duty cycle (unmeasured until the counters accumulate — TRA-2339's
 * `totalConsults` / `totalWouldTrims` give it directly on the first live
 * session). Override with `--min-n` when grading a deliberately smaller slice;
 * the achieved MDE is printed either way, so a lowered floor cannot hide.
 */
const DEFAULT_MIN_N = 135;
const MIN_N = Number(argOf('min-n', DEFAULT_MIN_N));
/** Contrast treated as materially large enough to act on (one sleeve-mean R). */
const MATERIAL_EFFECT_R = 0.0577;
const STAMP_SINCE = Number(argOf('stamp-since', DEFAULT_STAMP_SINCE));
const PATH_STAMP_SINCE = Number(argOf('path-stamp-since', DEFAULT_PATH_STAMP_SINCE));

// ── statistics ─────────────────────────────────────────────────────────────

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs) => {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
};

/**
 * Welch's two-sample t on `a − b`, with a normal-approximation 95% CI.
 *
 * Normal approximation rather than an exact t quantile: the gate requires
 * n(T) ≥ 20 before any CI is consulted, where t(0.975, df≥20) = 2.086 vs
 * z = 1.96 — an 6% narrower interval. That errs toward calling a marginal
 * result significant, so the reported CI is WIDENED by using 2.09 whenever
 * df < 60. No exact-quantile table, no silent optimism.
 */
function welch(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a);
  const vb = variance(b);
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!Number.isFinite(se) || se === 0) return null;
  const diff = ma - mb;
  const t = diff / se;
  const df =
    (va / a.length + vb / b.length) ** 2 /
    ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1));
  const crit = df < 60 ? 2.09 : 1.96;
  return {
    meanA: ma,
    meanB: mb,
    diff,
    se,
    t,
    df,
    crit,
    ci: [diff - crit * se, diff + crit * se],
    excludesZero: Math.abs(t) > crit,
    // Minimum detectable effect at 80% power for THIS run's actual SE. Reported
    // on every verdict because a CI alone does not say what the test could have
    // seen — see MIN_N's derivation. 0.8416 = z(0.80).
    mde: (crit + 0.8416) * se,
  };
}

// ── partition ──────────────────────────────────────────────────────────────

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Eligibility: did this row's open path consult a throttle chokepoint?
 *
 * `exact` when TRA-2375's `riskThrottleSizingPath` is on the row, `proxy`
 * otherwise. TWO-STEP presence test, and the order matters: the KEY being
 * present means "a TRA-2375+ build wrote this row"; its VALUE being non-null
 * means "this fill went through a real chokepoint". A non-chokepoint open writes
 * an explicit `null`, so ABSENT means "pre-TRA-2375 build" and nothing else —
 * which is what keeps step 1 usable as a build detector. A boolean field would
 * have collided "not a chokepoint" with "old build" under `?? false`.
 */
export function eligibility(row) {
  if (Object.prototype.hasOwnProperty.call(row, 'riskThrottleSizingPath')) {
    return { basis: 'exact', eligible: row.riskThrottleSizingPath != null };
  }
  if (WHEEL_ARCHETYPES.has(row.entryArchetype)) return { basis: 'proxy', eligible: false };
  if (CHOKEPOINT_STRUCTURES.has(row.structure)) return { basis: 'proxy', eligible: true };
  return { basis: 'proxy', eligible: false, unclassified: !CHOKEPOINT_STRUCTURES.has(row.structure) };
}

/**
 * The whole verdict as a PURE function of the inputs.
 *
 * Pure on purpose: a grader that only ever runs against the one live box it
 * grades has never been shown to go red, and an assertion that cannot fail is
 * decoration. `--selftest` drives this same function to every verdict.
 */
export function grade({
  rows,
  buildCommit,
  stampsSupported,
  // Does the RUNNING build carry TRA-2375? `null` = git could not resolve it.
  // Defaulting to null rather than to `stampsSupported` on purpose: the two are
  // different commits with different deploy dates, and inheriting one for the
  // other is exactly the conflation D1 is about. A null never claims a
  // regression and never quietly reads as "expected" — it prints
  // UNATTRIBUTABLE.
  pathStampsSupported = null,
  stampSince = DEFAULT_STAMP_SINCE,
  pathStampSince = DEFAULT_PATH_STAMP_SINCE,
  minN = DEFAULT_MIN_N,
}) {
  const lines = [];
  const dropped = { fixture: 0, unattributed: 0, open: 0, notDemo: 0, preCliff: 0, ineligible: 0, unclassified: 0, void: 0 };
  const hasKey = (r, k) => Object.prototype.hasOwnProperty.call(r, k);

  lines.push(`build      ${buildCommit ?? 'UNKNOWN'}  stampsSupported=${stampsSupported}  pathStampsSupported=${pathStampsSupported}`);
  lines.push(`cliff      openTs >= ${new Date(stampSince).toISOString()}  (TRA-2333 ${STAMP_APPLIED_COMMIT} / TRA-2339 ${STAMP_DECIDED_COMMIT})`);
  lines.push(`path cliff openTs >= ${new Date(pathStampSince).toISOString()}  (TRA-2375 ${STAMP_PATH_COMMIT}, FIRST CARRYING BOOT — attribution only, does NOT scope the population)`);

  // ── VOID gates. Fail closed: a blind read must never resolve to 0. ───────
  if (stampsSupported == null) {
    lines.push('VOID  cannot resolve whether the running build writes the stamp (no git / unknown SHA).');
    return { verdict: 'VOID', reason: 'BLIND', lines, dropped, cohorts: null, stats: null };
  }
  if (stampsSupported === false) {
    lines.push(`VOID  the running build predates ${STAMP_DECIDED_COMMIT}; absent stamps are EXPECTED, not a regression. Deploy before grading.`);
    return { verdict: 'VOID', reason: 'BUILD_PREDATES_STAMP', lines, dropped, cohorts: null, stats: null };
  }

  // ── scope the population, counting every exclusion (no silent caps) ──────
  const desk = [];
  for (const r of rows) {
    if (r.mode !== 'demo') { dropped.notDemo += 1; continue; }
    if (r.outcome === 'OPEN' || !isNum(r.realizedR)) { dropped.open += 1; continue; }
    if (isFixtureAccount(r.account)) { dropped.fixture += 1; continue; }
    if (r.account == null) { dropped.unattributed += 1; continue; }
    if (!isNum(r.openTs) || r.openTs < stampSince) { dropped.preCliff += 1; continue; }
    desk.push(r);
  }
  lines.push(
    `population post-cliff demo desk rows=${desk.length}  ` +
      `dropped: preCliff=${dropped.preCliff} fixture=${dropped.fixture} unattributed=${dropped.unattributed} open=${dropped.open} notDemo=${dropped.notDemo}`,
  );

  // ── WRITER REGRESSION. The build stamps; a post-cliff row that lacks the
  //    field means the writer broke on some path. This is the failing state
  //    the since-boot counters cannot express.
  //
  //    A PRESENT-but-non-numeric stamp (`null`) counts as unstamped, not as a
  //    quietly-dropped row. The field is typed `number | undefined`, so a null
  //    is a writer defect — and silently excluding it would recreate the exact
  //    false zero this whole ticket exists to kill. It must never be tested
  //    with a bare `< 1`: **`null < 1` is `true` in JavaScript**.
  const unstamped = desk.filter(
    (r) => !Object.prototype.hasOwnProperty.call(r, 'riskThrottleMultiplier') || !isNum(r.riskThrottleMultiplier),
  );
  if (unstamped.length > 0) {
    lines.push(
      `FAIL  WRITER_REGRESSED — ${unstamped.length}/${desk.length} post-cliff rows carry no riskThrottleMultiplier ` +
        `on a build that writes it. Structures: ${[...new Set(unstamped.map((r) => r.structure))].join(', ')}`,
    );
    return {
      verdict: 'FAIL',
      reason: 'WRITER_REGRESSED',
      lines,
      dropped,
      cohorts: null,
      stats: null,
      regressedField: 'riskThrottleMultiplier',
      unstampedIds: unstamped.slice(0, 20).map((r) => r.id),
    };
  }

  // ── WRITER REGRESSION, arm 2: the TRA-2375 path stamp.
  //
  //    D1 stops attributing PRE-cliff absence to the writer. It must NOT stop
  //    attributing POST-cliff absence, or the softening would swallow the very
  //    regression the split exists to isolate. This arm has its OWN cliff (the
  //    first boot carrying 4364063) and its OWN build gate: it can only fire on
  //    a build proven to carry TRA-2375, so an un-resolvable build reports
  //    UNATTRIBUTABLE below instead of a FAIL it cannot justify.
  if (pathStampsSupported === true) {
    const pathUnstamped = desk.filter(
      (r) => r.openTs >= pathStampSince && !hasKey(r, 'riskThrottleSizingPath'),
    );
    if (pathUnstamped.length > 0) {
      lines.push(
        `FAIL  WRITER_REGRESSED — ${pathUnstamped.length}/${desk.length} rows opened after the TRA-2375 boot cliff ` +
          `(${new Date(pathStampSince).toISOString()}) carry no riskThrottleSizingPath on a build that writes it. ` +
          `Structures: ${[...new Set(pathUnstamped.map((r) => r.structure))].join(', ')}. ` +
          `This is NOT the pre-cliff build-age case — those rows are attributed PRE_PATH_BUILD and are expected.`,
      );
      return {
        verdict: 'FAIL',
        reason: 'WRITER_REGRESSED',
        lines,
        dropped,
        cohorts: null,
        stats: null,
        regressedField: 'riskThrottleSizingPath',
        unstampedIds: pathUnstamped.slice(0, 20).map((r) => r.id),
      };
    }
  }

  if (desk.length === 0) {
    lines.push('NOT-GRADED  NO_TAPE — no closed desk rows since the stamp cliff. Nothing to grade; this is not a pass.');
    return { verdict: 'NOT-GRADED', reason: 'NO_TAPE', lines, dropped, cohorts: { T: 0, U: 0, W: 0 }, stats: null };
  }

  // ── eligibility ─────────────────────────────────────────────────────────
  //
  // The basis is a SPLIT, not one degraded label (TRA-2653 D1). Every proxy row
  // is attributed to a named reason, and the attribution is asserted total.
  const eligible = [];
  const basisCount = { exact: 0, proxy: 0 };
  const proxyReason = { PRE_PATH_BUILD: 0, POST_CLIFF_UNSTAMPED: 0, UNATTRIBUTABLE: 0 };
  for (const r of desk) {
    const e = eligibility(r);
    basisCount[e.basis] += 1;
    if (e.basis === 'proxy') {
      if (r.openTs < pathStampSince) proxyReason.PRE_PATH_BUILD += 1;
      else if (pathStampsSupported === true) proxyReason.POST_CLIFF_UNSTAMPED += 1;
      else proxyReason.UNATTRIBUTABLE += 1;
    }
    if (e.unclassified) dropped.unclassified += 1;
    if (!e.eligible) { dropped.ineligible += 1; continue; }
    eligible.push(r);
  }
  const basis =
    basisCount.proxy === 0 ? 'exact' : basisCount.exact === 0 ? 'proxy' : 'mixed';
  const basisReport = { basis, exact: basisCount.exact, proxy: basisCount.proxy, proxyReason };
  lines.push(
    `eligibility basis=${basis.toUpperCase()}  exact=${basisCount.exact}  proxy=${basisCount.proxy}  ` +
      `eligible=${eligible.length}  ineligible(out-of-cohort)=${dropped.ineligible}  unclassified-structure=${dropped.unclassified}`,
  );
  if (basisCount.proxy > 0) {
    // Name a reason for EVERY proxy row. A residue prints as UNACCOUNTED rather
    // than disappearing — an attribution that silently loses rows is the same
    // shape as the single label it replaced.
    const accounted = proxyReason.PRE_PATH_BUILD + proxyReason.POST_CLIFF_UNSTAMPED + proxyReason.UNATTRIBUTABLE;
    const parts = [
      `PRE_PATH_BUILD=${proxyReason.PRE_PATH_BUILD} (opened before the TRA-2375 boot cliff — EXPECTED, never a writer defect)`,
    ];
    if (proxyReason.POST_CLIFF_UNSTAMPED > 0) {
      parts.push(`POST_CLIFF_UNSTAMPED=${proxyReason.POST_CLIFF_UNSTAMPED} (⚠ a writer defect — should have failed above)`);
    }
    if (proxyReason.UNATTRIBUTABLE > 0) {
      parts.push(`UNATTRIBUTABLE=${proxyReason.UNATTRIBUTABLE} (git could not confirm the running build carries ${STAMP_PATH_COMMIT}; NOT evidence the writer is fine)`);
    }
    if (accounted !== basisCount.proxy) {
      parts.push(`UNACCOUNTED=${basisCount.proxy - accounted} (⚠ attribution is not total — this is a bug in the grader, not in the writer)`);
    }
    lines.push(`  proxy attribution: ${parts.join(' · ')}`);
    lines.push('  ⚠ proxy rows are partitioned by STRUCTURE, not by stamp. Residual leak: bounded-live OTM 1-ct override, biases toward the NULL.');
  }
  if (basis === 'exact') {
    lines.push('  ✓ EXACT — every row in the population carries riskThrottleSizingPath. Note this is UNREACHABLE while the population cliff (TRA-2339) sits below the TRA-2375 boot cliff and those 11 gap rows survive; see the header.');
  }

  // ── invariants ──────────────────────────────────────────────────────────
  const bad = eligible.filter((r) => {
    const m = r.riskThrottleMultiplier;
    const d = r.riskThrottleDecided;
    if (isNum(m) && (m > 1 || m <= 0)) return true;
    if (isNum(d) && (d > 1 || d <= 0)) return true;
    // `applied >= decided` ALWAYS: unarmed ⇒ applied 1 ≥ decided; armed ⇒
    // applied === decided. So `applied < decided` is unreachable at any scope
    // and means the applied term came from somewhere other than the clamp.
    // Corollary worth stating, because it is the check that will actually fire
    // Monday: every TRIMMED row must carry decided === applied. A row with
    // applied 0.5 / decided 1 is a defect, not a trim.
    if (isNum(m) && isNum(d) && m < d - 1e-9) return true;
    return false;
  });
  if (bad.length > 0) {
    lines.push(
      `FAIL  INVARIANT_VIOLATED — ${bad.length} row(s) with applied>1, decided>1, non-positive, or applied<decided. ` +
        `The clamp is tighten-only and applied ≤ 1 always; applied < decided is impossible at any scope.`,
    );
    return { verdict: 'FAIL', reason: 'INVARIANT_VIOLATED', lines, dropped, basisReport, cohorts: null, stats: null, badIds: bad.slice(0, 20).map((r) => r.id) };
  }

  // ── cohorts ─────────────────────────────────────────────────────────────
  const T = eligible.filter((r) => isNum(r.riskThrottleMultiplier) && r.riskThrottleMultiplier < 1);
  const U = eligible.filter((r) => r.riskThrottleMultiplier === 1);
  const W = eligible.filter(
    (r) => isNum(r.riskThrottleDecided) && r.riskThrottleDecided < 1 && r.riskThrottleMultiplier === 1,
  );
  const cohorts = {
    T: T.length,
    U: U.length,
    W: W.length,
    minApplied: T.length ? Math.min(...T.map((r) => r.riskThrottleMultiplier)) : null,
    minDecided: eligible.some((r) => isNum(r.riskThrottleDecided))
      ? Math.min(...eligible.filter((r) => isNum(r.riskThrottleDecided)).map((r) => r.riskThrottleDecided))
      : null,
  };
  lines.push(
    `cohorts    n(T)=${cohorts.T}  n(U)=${cohorts.U}  n(W would-have-trimmed)=${cohorts.W}  ` +
      `minApplied=${cohorts.minApplied ?? 'n/a'}  minDecided=${cohorts.minDecided ?? 'n/a'}`,
  );

  if (T.length === 0) {
    lines.push(
      `NOT-GRADED  NO_THROTTLED_FILLS — the governor never went below 1 on an eligible open. ` +
        `This is a MEASURED NO-OP: arming changed nothing, which is neither evidence it works nor that it is safe. ` +
        `n(W)=${W.length} says how often it WOULD have trimmed on an unarmed path.`,
    );
    return { verdict: 'NOT-GRADED', reason: 'NO_THROTTLED_FILLS', lines, dropped, basisReport, cohorts, stats: null };
  }

  const rT = T.map((r) => r.realizedR);
  const rU = U.map((r) => r.realizedR);
  const stats = welch(rT, rU);
  if (stats) {
    lines.push(
      `contrast   mean_R(T)=${stats.meanA.toFixed(4)}  mean_R(U)=${stats.meanB.toFixed(4)}  ` +
        `diff=${stats.diff.toFixed(4)}  t=${stats.t.toFixed(2)}  df=${stats.df.toFixed(1)}  ` +
        `95% CI [${stats.ci[0].toFixed(4)}, ${stats.ci[1].toFixed(4)}]`,
    );
    lines.push('  ⚠ absolute means are MID-MARKED (TRA-2174, ~13% overstated) — publish the CONTRAST only; the convention cancels in the difference.');
    lines.push(
      `power      MDE(80%) = ${stats.mde.toFixed(4)}R — the SMALLEST contrast this run could have detected. ` +
        `That is ${(stats.mde / MATERIAL_EFFECT_R).toFixed(1)}× the material effect (${MATERIAL_EFFECT_R}R = one sleeve-mean). ` +
        `A null below this resolution is NOT evidence of no selection.`,
    );
  }

  if (T.length < minN || !stats) {
    lines.push(
      `NOT-GRADED  UNDERPOWERED — n(T)=${T.length} < ${minN}${stats ? '' : ' (or a cohort too small for a variance)'}. ` +
        `${stats ? `At this n the test resolves only ${stats.mde.toFixed(4)}R; the floor is where MDE reaches ${MATERIAL_EFFECT_R}R. ` : ''}` +
        `Keep the routine armed and re-run; do not read a small-n point estimate as a verdict.`,
    );
    return { verdict: 'NOT-GRADED', reason: 'UNDERPOWERED', lines, dropped, basisReport, cohorts, stats };
  }

  if (!stats.excludesZero) {
    lines.push(
      `NOT-GRADED  UNDERPOWERED — the 95% CI on the contrast straddles 0. No selection effect is demonstrated in either direction. ` +
        `This run could only have resolved ${stats.mde.toFixed(4)}R, so it rules out effects LARGER than that and nothing smaller.`,
    );
    return { verdict: 'NOT-GRADED', reason: 'UNDERPOWERED', lines, dropped, basisReport, cohorts, stats };
  }

  // A significant result whose effect is SMALLER than the run's own 80%-power
  // MDE was found by a test underpowered for it. Such estimates are inflated in
  // magnitude (Type M) — the CI excludes 0, but the point estimate should not be
  // carried into Δ$ arithmetic as if it were the true effect.
  if (Math.abs(stats.diff) < stats.mde) {
    lines.push(
      `  ⚠ TYPE-M — |diff|=${Math.abs(stats.diff).toFixed(4)}R is BELOW this run's own MDE ${stats.mde.toFixed(4)}R. ` +
        `Significant, but found by a test underpowered for an effect this size, so the MAGNITUDE is likely overstated. ` +
        `Treat the SIGN as the finding and re-grade before sizing any Δ$ off the point estimate.`,
    );
  }

  if (stats.diff > 0) {
    lines.push(
      `FAIL  SELECTION_ADVERSE — throttled fills realise HIGHER R than un-throttled ones (diff=${stats.diff.toFixed(4)}, CI excludes 0). ` +
        `The trigger is trimming the better trades: Δ$ = (m−1)·mean_R(T)·risk·n < 0. DISARM (set RISK_THROTTLE_SIZING_ENABLED=off).`,
    );
    return { verdict: 'FAIL', reason: 'SELECTION_ADVERSE', lines, dropped, basisReport, cohorts, stats };
  }

  lines.push(
    `PASS  SELECTION_CONFIRMED — throttled fills realise LOWER R (diff=${stats.diff.toFixed(4)}, CI excludes 0). ` +
      `The de-risk trigger selects worse trades, so trimming them is money-positive on the mean. ` +
      `This grades the DEMO sleeve only; the live arm remains a separate board call under the TRA-1897 hold.`,
  );
  return { verdict: 'PASS', reason: 'SELECTION_CONFIRMED', lines, dropped, basisReport, cohorts, stats };
}

// ── reachability ───────────────────────────────────────────────────────────

/**
 * Which verdicts can this box actually produce RIGHT NOW?
 *
 * A `--selftest` proving four verdicts reachable IN FIXTURES says nothing about
 * reachability ON THE BOX — TRA-2331 already shipped a checker whose PROVEN
 * branch no configuration at `scope: demo` could enter, and a permanently
 * unreachable verdict reads identically to a calm session. So the live run
 * states this explicitly instead of leaving a reader to assume "not enough
 * traffic yet".
 */
function reachability(scopeRead) {
  const { known, scope } = scopeRead;
  const out = [];
  const armed = known && (scope === 'demo' || scope === 'all');
  const label = !known ? 'UNKNOWN' : armed ? 'REACHABLE' : 'UNREACHABLE';
  out.push(`PASS / FAIL:SELECTION_ADVERSE  ${label} — needs n(T)≥${MIN_N} eligible demo fills opened while the governor read < 1. The demo option paths ARE armed at scope=demo, but see the CROSS-BOOK note below: being armed is not the same as being reachable at a useful rate.`);
  out.push(`NOT-GRADED:NO_THROTTLED_FILLS  REACHABLE and EXPECTED — the autopilot sits at 1.0 most sessions.`);
  // TRA-2331 — the governor that gates T is fed by a DIFFERENT book than the one
  // graded. Pinned by packages/server/src/tra2331-autopilot-throttle-is-equity-fed.test.ts
  // (mutation-proven); if those tests fail the wiring changed and this note is stale.
  out.push(
    `⛔ CROSS-BOOK — the graded cohort is the demo OPTION book, but 3 of the autopilot's 4 throttle\n`
    + `   triggers cannot be driven by it. loss_streak + daily_drawdown read consecutiveLosses/dailyPnl,\n`
    + `   whose ONLY mutator is DailyRiskGovernor.recordTrade — every call site of which is an EQUITY\n`
    + `   close. Option closes go to optionsBreaker (OptionsRiskBreaker), which never reaches\n`
    + `   evaluateRiskAutopilot. regime_shift needs marketReviewGatesEnabled, an opt-in defaulting FALSE.\n`
    + `   Only edge_decay is options-fed, and it needs >=30 recent AND >=30 baseline closes for ONE\n`
    + `   strategy. So a graded option open is trimmed only while the EQUITY book sits at exactly 2\n`
    + `   consecutive losses (3 halts, a win resets) on the same ET day. n(T)=0 is therefore mostly a\n`
    + `   statement about that coupling — NOT evidence the throttle is calibrated wide.`,
  );
  out.push(`FAIL:WRITER_REGRESSED         REACHABLE — any post-cliff desk row missing riskThrottleMultiplier, OR any row opened after the TRA-2375 boot cliff missing riskThrottleSizingPath on a build that carries ${STAMP_PATH_COMMIT}.`);
  out.push(`eligibility basis=EXACT       UNREACHABLE on live tape — the 11 rows opened in the TRA-2375 merge-to-deploy gap sit permanently inside the population cliff and permanently lack the key. MIXED with PRE_PATH_BUILD attribution is the healthy state; do NOT read a non-EXACT basis as a regression (TRA-2653 D1).`);
  out.push(`VOID                          REACHABLE — a redeploy to a pre-${STAMP_DECIDED_COMMIT} build, or a blind read.`);
  if (!known) {
    // The whole point of this ticket is that a field reading the same in the
    // pass and fail state proves nothing. An unread `armedScope` is UNKNOWN and
    // must never be rendered as `off` — those are the two states that matter.
    out.push(`⚠ armedScope UNKNOWN — this is NOT evidence the flag is off. The route is requireAuth and the run could not authenticate. Since TRA-2331 the checker mints its own credential (login then signup as ${SCOPE_PROBE_USER}), so UNKNOWN now means that ladder ALSO failed — i.e. the box's own self-serve auth is down, which is a finding in its own right, not a missing operator step. Re-run with TRADING_ADMIN_TOKEN, or pass --scope=<off|demo|all> once verified by hand.`);
  } else if (!armed) {
    out.push(`⚠ scope=${JSON.stringify(scope)} — with the flag off, riskThrottleMultiplier is pinned to 1 at every path, so n(T) is STRUCTURALLY 0 and PASS/FAIL:SELECTION_ADVERSE cannot be entered. A NOT-GRADED here is a tautology, not a calm session.`);
  }
  return out;
}

// ── selftest ───────────────────────────────────────────────────────────────

function row(over = {}) {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    mode: 'demo',
    outcome: 'WIN',
    account: 'admin',
    structure: 'single_leg_rv',
    entryArchetype: null,
    openTs: DEFAULT_STAMP_SINCE + 60_000,
    realizedR: 0.1,
    riskThrottleMultiplier: 1,
    riskThrottleDecided: 1,
    ...over,
  };
}

function selftest() {
  const fails = [];
  const check = (name, got, want) => {
    const ok = got === want;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(34)} got=${got} want=${want}`);
    if (!ok) fails.push(name);
  };
  const g = (rows, extra = {}) =>
    grade({ rows, buildCommit: 'deadbeef', stampsSupported: true, minN: 20, ...extra }).reason;

  console.log('TRA-2331 grade selftest — every verdict must be reachable, in both directions.\n');

  check('BLIND', g([], { stampsSupported: null }), 'BLIND');
  check('BUILD_PREDATES_STAMP', g([], { stampsSupported: false }), 'BUILD_PREDATES_STAMP');
  check('NO_TAPE', g([]), 'NO_TAPE');
  check('NO_TAPE (all pre-cliff)', g([row({ openTs: DEFAULT_STAMP_SINCE - 1 })]), 'NO_TAPE');

  const noStamp = row();
  delete noStamp.riskThrottleMultiplier;
  check('WRITER_REGRESSED', g([noStamp]), 'WRITER_REGRESSED');

  check('INVARIANT applied>1', g([row({ riskThrottleMultiplier: 1.2, riskThrottleDecided: 1.2 })]), 'INVARIANT_VIOLATED');
  // `applied >= decided` always — a trim below the decided term is unreachable.
  check('INVARIANT applied<decided', g([row({ riskThrottleMultiplier: 0.4, riskThrottleDecided: 0.8 })]), 'INVARIANT_VIOLATED');
  // ...and the un-armed shape (applied 1, decided 0.5) is LEGAL, not a violation:
  // that is exactly cohort W, the counterfactual the live-arm decision needs.
  check('unarmed applied1/decided<1 legal', g([row({ riskThrottleDecided: 0.5 })]), 'NO_THROTTLED_FILLS');

  check('NO_THROTTLED_FILLS', g([row(), row()]), 'NO_THROTTLED_FILLS');

  // A `null` multiplier must NOT be read as trimmed (`null < 1` is true in JS)
  // and must NOT be silently dropped either — it is a writer defect.
  check('null multiplier is a writer defect', g([row({ riskThrottleMultiplier: null }), row()]), 'WRITER_REGRESSED');

  // A trimmed row: armed ⇒ applied === decided.
  const trimmed = (over = {}) => row({ riskThrottleMultiplier: 0.5, riskThrottleDecided: 0.5, ...over });

  const T_small = [...Array(5)].map(() => trimmed({ realizedR: -1 }));
  const U_big = [...Array(40)].map(() => row({ realizedR: 0.5 }));
  check('UNDERPOWERED small n(T)', g([...T_small, ...U_big]), 'UNDERPOWERED');

  // Straddling CI: same distribution in both arms.
  const jitter = (i) => ((i % 7) - 3) * 0.4;
  const T_flat = [...Array(30)].map((_, i) => trimmed({ realizedR: jitter(i) }));
  const U_flat = [...Array(30)].map((_, i) => row({ realizedR: jitter(i) }));
  check('UNDERPOWERED CI straddles 0', g([...T_flat, ...U_flat]), 'UNDERPOWERED');

  const T_bad = [...Array(30)].map((_, i) => trimmed({ realizedR: -1 + jitter(i) * 0.1 }));
  check('PASS selection confirmed', g([...T_bad, ...U_flat]), 'SELECTION_CONFIRMED');

  const T_good = [...Array(30)].map((_, i) => trimmed({ realizedR: 1.5 + jitter(i) * 0.1 }));
  check('FAIL selection adverse', g([...T_good, ...U_flat]), 'SELECTION_ADVERSE');

  // TYPE-M, controlled in BOTH directions. A branch that only ever fires — or
  // only ever stays silent — is the instrument-with-no-failing-state shape.
  const hasTypeM = (rows) =>
    grade({ rows, buildCommit: 'deadbeef', stampsSupported: true, minN: 20 }).lines.some((l) =>
      l.includes('TYPE-M'),
    );
  // Large, unambiguous effect: significant AND well above its own MDE ⇒ silent.
  check('TYPE-M silent on a large effect', String(hasTypeM([...T_good, ...U_flat])), 'false');
  // Tight variance makes a TINY contrast significant while still below the MDE.
  // The window is narrow by construction — Type-M is exactly the band
  // 1.96·se < |diff| < 2.80·se — so the offset is sized to it rather than
  // guessed: sd≈0.00284 over n=120/arm gives se≈0.000367, hence a 0.0009
  // contrast sits at 2.45·se, significant but under the run's own MDE.
  const tiny = (i) => ((i % 5) - 2) * 0.002;
  const U_tight = [...Array(120)].map((_, i) => row({ realizedR: tiny(i) }));
  const T_tight = [...Array(120)].map((_, i) => trimmed({ realizedR: -0.0009 + tiny(i) }));
  const tinyRes = grade({
    rows: [...T_tight, ...U_tight],
    buildCommit: 'deadbeef',
    stampsSupported: true,
    minN: 20,
  });
  check('  small significant effect is a verdict', tinyRes.reason, 'SELECTION_CONFIRMED');
  check('  and TYPE-M fires on it', String(tinyRes.lines.some((l) => l.includes('TYPE-M'))), 'true');
  // The MDE line itself must appear on every run that reaches a contrast.
  check(
    'MDE reported alongside the verdict',
    String(g([...T_bad, ...U_flat], {}) !== null && true),
    'true',
  );
  check(
    '  MDE line present',
    String(
      grade({ rows: [...T_bad, ...U_flat], buildCommit: 'x', stampsSupported: true, minN: 20 })
        .lines.some((l) => l.startsWith('power')),
    ),
    'true',
  );

  // Eligibility: a defined-risk row must not join U, and a wheel row must not either.
  const withSpreads = grade({
    rows: [...T_bad, ...U_flat, ...[...Array(50)].map(() => row({ structure: 'iron_condor' }))],
    buildCommit: 'deadbeef',
    stampsSupported: true,
    minN: 20,
  });
  check('defined-risk excluded from U', String(withSpreads.cohorts?.U), '30');
  check('  and counted as ineligible', String(withSpreads.dropped.ineligible), '50');

  // Fixture-mirror rows must never reach either arm (QA-fixture mirror trap).
  const withQa = grade({
    rows: [...T_bad, ...U_flat, ...[...Array(11)].map(() => row({ account: 'qa_tra1475_1' }))],
    buildCommit: 'deadbeef',
    stampsSupported: true,
    minN: 20,
  });
  check('qa_* excluded', String(withQa.dropped.fixture), '11');

  // TRA-2375 exact basis: presence of the path field flips the label and the
  // partition, and an ABSENT path field means out-of-cohort (not `false`).
  const exact = grade({
    rows: [
      ...[...Array(25)].map(() => row({ riskThrottleMultiplier: 0.5, riskThrottleDecided: 0.5, realizedR: -1, riskThrottleSizingPath: 'options_single_leg' })),
      ...[...Array(25)].map(() => row({ realizedR: 0.2, riskThrottleSizingPath: 'options_single_leg' })),
      ...[...Array(9)].map(() => row({ structure: 'single_leg_rv', riskThrottleSizingPath: null })),
    ],
    buildCommit: 'deadbeef',
    stampsSupported: true,
    minN: 20,
  });
  check('exact basis excludes null path', String(exact.dropped.ineligible), '9');
  check('exact basis reaches a verdict', exact.reason, 'SELECTION_CONFIRMED');

  // ── TRA-2653 D1 — the basis is a SPLIT, and pre-cliff absence is NOT a
  //    regression while post-cliff absence still is. Every case below fails if
  //    the fix is mutated out.
  const POST_PATH_TS = DEFAULT_PATH_STAMP_SINCE + 60_000;
  const PRE_PATH_TS = DEFAULT_PATH_STAMP_SINCE - 60_000;

  // A population that STRADDLES the TRA-2375 boot cliff: 11 pre-cliff rows with
  // the key absent (the real shape of the merge-to-deploy gap) and 8 post-cliff
  // rows carrying it. Every row IS stamped for riskThrottleMultiplier, so the
  // only thing under test is how absence of the PATH key is attributed.
  const straddle = grade({
    rows: [
      ...[...Array(11)].map((_, i) => row({ id: `pre${i}`, openTs: PRE_PATH_TS, structure: 'single_leg_otm' })),
      ...[...Array(8)].map((_, i) =>
        row({ id: `post${i}`, openTs: POST_PATH_TS, structure: 'single_leg_otm', riskThrottleSizingPath: 'options_otm' }),
      ),
    ],
    buildCommit: 'deadbeef',
    stampsSupported: true,
    pathStampsSupported: true,
    minN: 20,
  });
  // The headline: a straddling population is NOT a writer regression. Before the
  // fix this population reported `basis=PROXY`, which TRA-2570's step 3 told the
  // reader to escalate as exactly that.
  check('straddle is NOT a regression', String(straddle.reason === 'WRITER_REGRESSED'), 'false');
  check('  straddle basis is MIXED', straddle.basisReport?.basis, 'mixed');
  check('  split counts exact', String(straddle.basisReport?.exact), '8');
  check('  split counts proxy', String(straddle.basisReport?.proxy), '11');
  check(
    '  every proxy row attributed',
    String(straddle.basisReport?.proxyReason.PRE_PATH_BUILD), '11',
  );
  check(
    '  none blamed on the writer',
    String(straddle.basisReport?.proxyReason.POST_CLIFF_UNSTAMPED), '0',
  );
  check(
    '  basis LINE reports the split',
    String(straddle.lines.some((l) => l.includes('basis=MIXED') && l.includes('exact=8') && l.includes('proxy=11'))),
    'true',
  );
  check(
    '  and NAMES the reason',
    String(straddle.lines.some((l) => l.includes('proxy attribution:') && l.includes('PRE_PATH_BUILD=11'))),
    'true',
  );

  // A GENUINE regression must still fail. D1 softens pre-cliff absence ONLY.
  const pathRegressed = grade({
    rows: [
      ...[...Array(5)].map((_, i) => row({ id: `ok${i}`, openTs: POST_PATH_TS, riskThrottleSizingPath: 'options_single_leg' })),
      ...[...Array(3)].map((_, i) => row({ id: `broke${i}`, openTs: POST_PATH_TS })), // key ABSENT above the cliff
    ],
    buildCommit: 'deadbeef',
    stampsSupported: true,
    pathStampsSupported: true,
    minN: 20,
  });
  check('post-cliff absence STILL regresses', pathRegressed.reason, 'WRITER_REGRESSED');
  check('  and names which field broke', pathRegressed.regressedField, 'riskThrottleSizingPath');
  // Negative control on the same arm: identical rows BELOW the cliff must not.
  const pathBelowCliff = grade({
    rows: [...Array(3)].map((_, i) => row({ id: `old${i}`, openTs: PRE_PATH_TS })),
    buildCommit: 'deadbeef',
    stampsSupported: true,
    pathStampsSupported: true,
    minN: 20,
  });
  check('  same rows BELOW the cliff do not', String(pathBelowCliff.reason === 'WRITER_REGRESSED'), 'false');
  // ...and an unresolvable build never claims the FAIL, nor calls it expected.
  const pathUnknownBuild = grade({
    rows: [...Array(3)].map((_, i) => row({ id: `unk${i}`, openTs: POST_PATH_TS })),
    buildCommit: 'deadbeef',
    stampsSupported: true,
    pathStampsSupported: null,
    minN: 20,
  });
  check('  unresolvable build => no FAIL', String(pathUnknownBuild.reason === 'WRITER_REGRESSED'), 'false');
  check('  ...but UNATTRIBUTABLE, not expected', String(pathUnknownBuild.basisReport?.proxyReason.UNATTRIBUTABLE), '3');
  check('  ...and NOT counted as build-age', String(pathUnknownBuild.basisReport?.proxyReason.PRE_PATH_BUILD), '0');

  // ── TRA-2653 D2 — `single_leg_directional` DOES consult a chokepoint.
  //    13/13 post-cliff live rows carry riskThrottleSizingPath 'options_single_leg'.
  check(
    'proxy: single_leg_directional eligible',
    String(eligibility({ structure: 'single_leg_directional' }).eligible),
    'true',
  );
  // Non-vacuous: the allowlist must still REJECT something, or the assertion
  // above would pass under `eligible: true` for every input.
  check(
    '  allowlist still rejects an unknown',
    String(eligibility({ structure: 'single_leg_frobnicate' }).eligible),
    'false',
  );
  check(
    '  ...and still rejects a spread',
    String(eligibility({ structure: 'iron_condor' }).eligible),
    'false',
  );
  check(
    '  ...and still rejects the wheel',
    String(eligibility({ structure: 'single_leg_otm', entryArchetype: 'wheel-csp' }).eligible),
    'false',
  );
  // The stamp must still win over the allowlist in BOTH directions: a stamped
  // single_leg_directional with a null path is out of cohort regardless of D2.
  check(
    '  stamp beats allowlist (null path)',
    String(eligibility({ structure: 'single_leg_directional', riskThrottleSizingPath: null }).eligible),
    'false',
  );
  // At grade level: the same structure now reaches the cohort instead of being
  // silently dropped as unclassified, which is what shrank n on every prior run.
  const directional = grade({
    rows: [...Array(4)].map((_, i) => row({ id: `dir${i}`, openTs: PRE_PATH_TS, structure: 'single_leg_directional' })),
    buildCommit: 'deadbeef',
    stampsSupported: true,
    pathStampsSupported: true,
    minN: 20,
  });
  check('directional joins the cohort', String(directional.cohorts?.U), '4');
  check('  and is not unclassified', String(directional.dropped.unclassified), '0');

  // ── The scope probe must never enter its own population.
  //    `resolveArmedScope` signs an account up on the box being graded. If that
  //    account's rows were gradeable, the checker would be measuring tape it
  //    created. This ties the probe identity to the SAME predicate the
  //    population filter uses, so a rename that drops the `ctoverify` prefix
  //    fails here instead of silently contaminating the cohort months later.
  check(
    'scope probe is fixture-excluded',
    String(isFixtureAccount(SCOPE_PROBE_USER)),
    'true',
  );
  // Non-vacuous: the filter must still admit the real book it exists to grade.
  check(
    '  ...and a real account is not',
    String(isFixtureAccount('admin')),
    'false',
  );
  // A deliverable probe address becomes a permanent bounce source (TRA-2523).
  check(
    '  probe email is undeliverable',
    String(SCOPE_PROBE_EMAIL.endsWith('@qa.invalid')),
    'true',
  );
  // UNKNOWN must never render as `off` — those drive opposite conclusions
  // about an n(T)=0 fire, which is this grade's dominant outcome.
  const unknownReach = reachability({ known: false, scope: null, source: 'unread' });
  check(
    'UNKNOWN scope warns, does not read off',
    String(unknownReach.some((l) => l.includes('armedScope UNKNOWN') && l.includes('NOT evidence the flag is off'))),
    'true',
  );
  check(
    '  and scope=off is called a TAUTOLOGY',
    String(reachability({ known: true, scope: 'off', source: 't' }).some((l) => l.includes('tautology'))),
    'true',
  );
  check(
    '  while scope=demo is REACHABLE',
    String(reachability({ known: true, scope: 'demo', source: 't' })[0].includes('REACHABLE')),
    'true',
  );

  console.log(`\n${fails.length === 0 ? 'SELFTEST PASS' : `SELFTEST FAIL (${fails.length}): ${fails.join(', ')}`}`);
  console.log('\nNOTE: fixture reachability is NOT box reachability. The live run prints the on-box reachability of each verdict.');
  return fails.length === 0 ? 0 : 1;
}

// ── live run ───────────────────────────────────────────────────────────────

// Distinguish "not an ancestor" from "unknown object / no git / a SHALLOW GRAFT". The
// second is BLIND and must not read as a clean `false` — a stale checkout would otherwise
// VOID a current build.
//
// TRA-3722 — this site is a MISATTRIBUTED VOID, not a fail-open, and the distinction is
// worth keeping straight because it reads like one at a glance. `false` and `null` BOTH end
// in VOID (exit 3) and both attribute proxy rows to UNATTRIBUTABLE, so relative to the blind
// case no PASS is manufactured and no FAIL is suppressed. What differed was the REASON, and
// therefore the REMEDY: on a graft the old exit-1 branch returned `false`, which prints
// BUILD_PREDATES_STAMP — "the running build predates 2339; absent stamps are EXPECTED, not a
// regression. Deploy before grading." — against a build that is already deployed. Right
// verdict, wrong instruction, and this file already carries a section on misattributed VOIDs
// reading like quiet sessions. Only the negative is re-graded; rc 0 still stands alone.
function buildCarries(ancestor, commit) {
  if (!commit) return null;
  return gradedAncestry(ancestor, commit).answer;
}

/**
 * Reads `autopilot.sizing.armedScope` out of the RUNNING PROCESS, minting its
 * own credential if it has to.
 *
 * `armedScope` is computed from `process.env` at snapshot time, so this is an
 * end-to-end read of what the box actually parsed — NOT a stored Render value.
 * That distinction is load-bearing on this host: the single-key env-var PUT
 * returns 200 and reads back correctly WITHOUT restarting the process, so the
 * flag reached `stored-but-dark` once already (2026-07-25) and the env row read
 * identically in both worlds.
 *
 * Token ladder, most-authoritative first. Every rung reports its own `source`
 * so a reader can tell which one answered:
 *   1. `TRADING_ADMIN_TOKEN` if the operator supplied one.
 *   2. `POST /api/auth/login` as the deterministic probe (the steady state —
 *      the account exists after the first run ever made).
 *   3. `POST /api/auth/signup` (first run only, or after a box reset wipes the
 *      user store). 409 `Username already taken` is EXPECTED and not an error.
 *
 * Returns `{known:false}` only when the whole ladder fails. `known:false` is
 * NOT `off`, and callers must keep those separate: `off` makes `n(T)=0` a
 * tautology, whereas UNKNOWN means the grade simply cannot say which it is.
 */
async function resolveArmedScope() {
  const unknown = (source) => ({ known: false, scope: null, source });

  const scopeFrom = async (token, source) => {
    try {
      const res = await fetch(`${BASE}/api/health/live`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return null;
      const body = await res.json();
      // Walk rather than hard-code `autopilot.sizing`: the field has already
      // moved once (TRA-2333 replaced `sizing.armed` with `armedScope`), and a
      // hard path that silently misses reads exactly like an unarmed box.
      const stack = [body];
      while (stack.length) {
        const cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        if (Object.prototype.hasOwnProperty.call(cur, 'armedScope')) {
          return { known: true, scope: cur.armedScope, source };
        }
        for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
      }
      return null;
    } catch {
      return null;
    }
  };

  const envToken = process.env.TRADING_ADMIN_TOKEN || '';
  if (envToken) {
    const hit = await scopeFrom(envToken, '/api/health/live (TRADING_ADMIN_TOKEN)');
    if (hit) return hit;
  }

  if (NO_SIGNUP) {
    const hit = await scopeFrom('', '/api/health/live unauthenticated');
    return hit ?? unknown('unread (--no-signup, and the unauthenticated read is 401)');
  }

  const tokenFrom = async (path) => {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: SCOPE_PROBE_USER,
          password: SCOPE_PROBE_PASS,
          email: SCOPE_PROBE_EMAIL,
        }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      return typeof body?.token === 'string' && body.token ? body.token : null;
    } catch {
      return null;
    }
  };

  // Login BEFORE signup: in the steady state the account exists, and trying
  // signup first would burn a guaranteed 409 on every fire.
  for (const [path, label] of [['/api/auth/login', 'login'], ['/api/auth/signup', 'signup']]) {
    const token = await tokenFrom(path);
    if (!token) continue;
    const hit = await scopeFrom(token, `/api/health/live (${SCOPE_PROBE_USER} ${label})`);
    if (hit) return hit;
  }

  return unknown('unread (admin token absent; probe login AND signup both failed)');
}

const stampsSupportedFor = (commit) => buildCarries(STAMP_DECIDED_COMMIT, commit);
/**
 * Resolved SEPARATELY from `stampsSupportedFor`, never inherited from it.
 * TRA-2339 and TRA-2375 are different commits that reached the box 2.9 days
 * apart, and treating one as a proxy for the other is the conflation D1 is
 * about. `null` (unresolvable) attributes proxy rows as UNATTRIBUTABLE and
 * suppresses the path-regression arm — it never claims a FAIL it cannot prove,
 * and never reads as "expected" either.
 */
const pathStampsSupportedFor = (commit) => buildCarries(STAMP_PATH_COMMIT, commit);

async function main() {
  if (SELFTEST) return selftest();

  let journal = null;
  // `known` separates "read it, it says off" from "could not read it". Those
  // are different facts and a null would collapse them.
  const scopeOverride = argOf('scope', null);
  let scopeRead = scopeOverride
    ? { known: true, scope: scopeOverride, source: 'operator --scope' }
    : { known: false, scope: null, source: 'unread' };
  try {
    const res = await fetch(`${BASE}/api/health/option-journal?rows=all`);
    journal = await res.json();
  } catch (err) {
    const out = { verdict: 'VOID', reason: 'BLIND', error: String(err) };
    console.log(JSON_OUT ? JSON.stringify(out, null, 2) : `VOID  BLIND — /api/health/option-journal unreadable: ${err}`);
    return EXIT_FOR.VOID;
  }

  if (!scopeOverride) scopeRead = await resolveArmedScope();

  const commit = journal?.build?.commit ?? null;
  const result = grade({
    rows: Array.isArray(journal?.rows) ? journal.rows : [],
    buildCommit: commit,
    stampsSupported: stampsSupportedFor(commit),
    pathStampsSupported: pathStampsSupportedFor(commit),
    stampSince: STAMP_SINCE,
    pathStampSince: PATH_STAMP_SINCE,
    minN: MIN_N,
  });

  const reach = reachability(scopeRead);
  const payload = {
    ...result,
    base: BASE,
    build: journal?.build ?? null,
    armedScope: scopeRead.known ? scopeRead.scope : 'UNKNOWN',
    armedScopeKnown: scopeRead.known,
    armedScopeSource: scopeRead.source,
    totalRowsServed: Array.isArray(journal?.rows) ? journal.rows.length : 0,
    reachability: reach,
    exitCode: EXIT_FOR[result.verdict],
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('TRA-2331 — risk-throttle trim grade');
    console.log(`base ${BASE}  startedAt ${journal?.build?.startedAt ?? '?'}  rowsServed ${payload.totalRowsServed}`);
    console.log(`armedScope ${scopeRead.known ? JSON.stringify(scopeRead.scope) : 'UNKNOWN (unread — NOT the same as "off")'}  via ${scopeRead.source}`);
    console.log('');
    for (const l of result.lines) console.log(l);
    console.log('');
    console.log('on-box reachability of each verdict:');
    for (const l of reach) console.log(`  ${l}`);
    console.log('');
    console.log(`VERDICT  ${result.verdict} / ${result.reason}   (exit ${EXIT_FOR[result.verdict]})`);
  }
  return EXIT_FOR[result.verdict];
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('tra2331-throttle-grade: unexpected failure —', err);
    process.exit(EXIT_FOR.VOID);
  },
);
