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
 * ── ELIGIBILITY IS A PROXY UNTIL TRA-2375 LANDS ────────────────────────────
 *
 * Five open paths stamp a hardcoded `1` because they take no sizing scalar at
 * ANY scope (defined-risk spreads ×3, wheel CSP/CC, the bounded-live 1-contract
 * OTM override). Those rows are OUT OF COHORT, not un-trimmed members of it —
 * pooling them into U floods the control arm with never-eligible trades, and it
 * fails silently: the control arm just looks big and healthy.
 *
 * Nothing on the row separates them today (`riskThrottleArmedScope` is stamped
 * unconditionally at the account layer and reads `"demo"` on both). So this
 * script uses a STRUCTURE-based proxy and says so in every output. It is an
 * ALLOWLIST, not a denylist: an unrecognised structure is counted as
 * `unclassified` and excluded from BOTH arms rather than defaulting into one.
 *
 * When TRA-2375 lands, rows carry `riskThrottleSizingPath` (ABSENT = not a
 * chokepoint — a presence test, because `false` would collide with "old
 * build"). This script switches to it automatically and relabels the basis
 * `exact`. No edit required.
 *
 * Residual leak of the proxy: the bounded-live OTM override (signal-engine.ts
 * :7436) journals `structure: 'single_leg_otm'` and is indistinguishable on the
 * row. It is structurally zero while `liveEngineCount: 0` under the TRA-1897
 * hold, and its bias runs toward the NULL (it dilutes a real contrast), so it
 * cannot manufacture a PASS.
 *
 * ── VERDICTS, in resolution order FAIL → VOID → NOT-GRADED → PASS ──────────
 *
 *   FAIL       WRITER_REGRESSED     post-cliff rows on a stamping build lack
 *                                   the stamp ⇒ the writer broke, and the
 *                                   since-boot counters would render that as a
 *                                   quiet week.
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

import { execFileSync } from 'node:child_process';
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

/**
 * Structures whose open path DOES consult a risk-throttle chokepoint
 * (`options_single_leg`, `options_otm`). Allowlist on purpose — see above.
 */
const CHOKEPOINT_STRUCTURES = new Set(['single_leg_rv', 'single_leg_otm']);
/** Wheel opens take no sizing scalar (signal-engine.ts :9151). */
const WHEEL_ARCHETYPES = new Set(['wheel-csp', 'wheel-cc']);
/** TRA-1475 / QA-fixture mirror trap — mirrors are bit-identical but id-distinct. */
const isFixtureAccount = (a) =>
  typeof a === 'string' && (/^qa[_-]/i.test(a) || /^ctoverify/i.test(a));

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
const BASE = String(argOf('base', 'https://tradingai-bqb1.onrender.com')).replace(/\/+$/, '');
const MIN_N = Number(argOf('min-n', 20));
const STAMP_SINCE = Number(argOf('stamp-since', DEFAULT_STAMP_SINCE));

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
  };
}

// ── partition ──────────────────────────────────────────────────────────────

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Eligibility: did this row's open path consult a throttle chokepoint?
 *
 * `exact` when TRA-2375's `riskThrottleSizingPath` is on the row (PRESENCE
 * test — absent means "not a chokepoint", and a boolean `false` would have
 * collided with "old build"). `proxy` otherwise.
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
export function grade({ rows, buildCommit, stampsSupported, stampSince = DEFAULT_STAMP_SINCE, minN = 20 }) {
  const lines = [];
  const dropped = { fixture: 0, unattributed: 0, open: 0, notDemo: 0, preCliff: 0, ineligible: 0, unclassified: 0, void: 0 };

  lines.push(`build      ${buildCommit ?? 'UNKNOWN'}  stampsSupported=${stampsSupported}`);
  lines.push(`cliff      openTs >= ${new Date(stampSince).toISOString()}  (TRA-2333 ${STAMP_APPLIED_COMMIT} / TRA-2339 ${STAMP_DECIDED_COMMIT})`);

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
      unstampedIds: unstamped.slice(0, 20).map((r) => r.id),
    };
  }

  if (desk.length === 0) {
    lines.push('NOT-GRADED  NO_TAPE — no closed desk rows since the stamp cliff. Nothing to grade; this is not a pass.');
    return { verdict: 'NOT-GRADED', reason: 'NO_TAPE', lines, dropped, cohorts: { T: 0, U: 0, W: 0 }, stats: null };
  }

  // ── eligibility ─────────────────────────────────────────────────────────
  let basis = 'exact';
  const eligible = [];
  for (const r of desk) {
    const e = eligibility(r);
    if (e.basis === 'proxy') basis = 'proxy';
    if (e.unclassified) dropped.unclassified += 1;
    if (!e.eligible) { dropped.ineligible += 1; continue; }
    eligible.push(r);
  }
  lines.push(
    `eligibility basis=${basis.toUpperCase()}  eligible=${eligible.length}  ineligible(out-of-cohort)=${dropped.ineligible}  unclassified-structure=${dropped.unclassified}`,
  );
  if (basis === 'proxy') {
    lines.push('  ⚠ PROXY partition — TRA-2375 (riskThrottleSizingPath) not on these rows. Residual leak: bounded-live OTM 1-ct override, biases toward the NULL.');
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
    return { verdict: 'FAIL', reason: 'INVARIANT_VIOLATED', lines, dropped, cohorts: null, stats: null, badIds: bad.slice(0, 20).map((r) => r.id) };
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
    return { verdict: 'NOT-GRADED', reason: 'NO_THROTTLED_FILLS', lines, dropped, cohorts, stats: null };
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
  }

  if (T.length < minN || !stats) {
    lines.push(
      `NOT-GRADED  UNDERPOWERED — n(T)=${T.length} < ${minN}${stats ? '' : ' (or a cohort too small for a variance)'}. ` +
        `Keep the routine armed and re-run; do not read a small-n point estimate as a verdict.`,
    );
    return { verdict: 'NOT-GRADED', reason: 'UNDERPOWERED', lines, dropped, cohorts, stats };
  }

  if (!stats.excludesZero) {
    lines.push('NOT-GRADED  UNDERPOWERED — the 95% CI on the contrast straddles 0. No selection effect is demonstrated in either direction.');
    return { verdict: 'NOT-GRADED', reason: 'UNDERPOWERED', lines, dropped, cohorts, stats };
  }

  if (stats.diff > 0) {
    lines.push(
      `FAIL  SELECTION_ADVERSE — throttled fills realise HIGHER R than un-throttled ones (diff=${stats.diff.toFixed(4)}, CI excludes 0). ` +
        `The trigger is trimming the better trades: Δ$ = (m−1)·mean_R(T)·risk·n < 0. DISARM (set RISK_THROTTLE_SIZING_ENABLED=off).`,
    );
    return { verdict: 'FAIL', reason: 'SELECTION_ADVERSE', lines, dropped, cohorts, stats };
  }

  lines.push(
    `PASS  SELECTION_CONFIRMED — throttled fills realise LOWER R (diff=${stats.diff.toFixed(4)}, CI excludes 0). ` +
      `The de-risk trigger selects worse trades, so trimming them is money-positive on the mean. ` +
      `This grades the DEMO sleeve only; the live arm remains a separate board call under the TRA-1897 hold.`,
  );
  return { verdict: 'PASS', reason: 'SELECTION_CONFIRMED', lines, dropped, cohorts, stats };
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
  out.push(`PASS / FAIL:SELECTION_ADVERSE  ${label} — needs n(T)≥${MIN_N} eligible demo fills opened while the governor read < 1. The demo option paths ARE armed at scope=demo, so T is populated by ordinary tape.`);
  out.push(`NOT-GRADED:NO_THROTTLED_FILLS  REACHABLE and EXPECTED — the autopilot sits at 1.0 most sessions.`);
  out.push(`FAIL:WRITER_REGRESSED         REACHABLE — any post-cliff desk row missing the stamp.`);
  out.push(`VOID                          REACHABLE — a redeploy to a pre-${STAMP_DECIDED_COMMIT} build, or a blind read.`);
  if (!known) {
    // The whole point of this ticket is that a field reading the same in the
    // pass and fail state proves nothing. An unread `armedScope` is UNKNOWN and
    // must never be rendered as `off` — those are the two states that matter.
    out.push(`⚠ armedScope UNKNOWN — /api/health/live is auth-gated and the unauthenticated read did not return it. This is NOT evidence the flag is off. Read it with a token (a non-admin signup reaches the route; bqb1 admin auth is dead) or pass --scope=<off|demo|all> once verified.`);
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

  console.log(`\n${fails.length === 0 ? 'SELFTEST PASS' : `SELFTEST FAIL (${fails.length}): ${fails.join(', ')}`}`);
  console.log('\nNOTE: fixture reachability is NOT box reachability. The live run prints the on-box reachability of each verdict.');
  return fails.length === 0 ? 0 : 1;
}

// ── live run ───────────────────────────────────────────────────────────────

function stampsSupportedFor(commit) {
  if (!commit) return null;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', STAMP_DECIDED_COMMIT, commit], {
      cwd: REPO,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    // Distinguish "not an ancestor" (exit 1) from "unknown object / no git"
    // (exit 128 or spawn failure). The second is BLIND and must not read as a
    // clean `false` — a stale checkout would otherwise VOID a current build.
    if (err && err.status === 1) return false;
    return null;
  }
}

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

  // Best effort: the sizing snapshot is auth-gated and bqb1 admin auth is dead.
  // It is used ONLY to label reachability — never to gate the verdict, so its
  // absence degrades the commentary, not the grade.
  if (!scopeOverride) {
    try {
      const token = process.env.TRADING_ADMIN_TOKEN || '';
      const res = await fetch(`${BASE}/api/health/live`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const body = await res.json();
        const stack = [body];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur || typeof cur !== 'object') continue;
          if (Object.prototype.hasOwnProperty.call(cur, 'armedScope')) {
            scopeRead = { known: true, scope: cur.armedScope, source: '/api/health/live' };
            break;
          }
          for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
        }
      }
    } catch { /* 401/network — stays UNKNOWN, which is a different fact from `off` */ }
  }

  const commit = journal?.build?.commit ?? null;
  const result = grade({
    rows: Array.isArray(journal?.rows) ? journal.rows : [],
    buildCommit: commit,
    stampsSupported: stampsSupportedFor(commit),
    stampSince: STAMP_SINCE,
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
