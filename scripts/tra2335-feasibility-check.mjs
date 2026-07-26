#!/usr/bin/env node
// TRA-2335 / TRA-2353 — the payoff-ceiling feasibility precondition, in TWO modes.
//
// ⚠️⚠️ READ THIS BEFORE QUOTING ANY OUTPUT OF THIS SCRIPT (TRA-2353 AC5) ⚠️⚠️
//
//   The DEFAULT mode is a MECHANISM prover over a HAND-BUILT RECONSTRUCTION of the credit
//   book (`CREDIT = 36.6 / MAX_LOSS = 963.4`, hand-set `pnlR`). It is a UNIT TEST WITH A
//   CLI. It will print `INFEASIBLE` forever, no matter what the live book does, because
//   its input is a constant in this file. Its green proves the CODE PATH works; it says
//   NOTHING WHATSOEVER about the state of the live gate.
//
//   Only `--live` reads the deployed service. Only `--live` output may be quoted as a
//   statement about the live gate — and only with the build SHA it prints beside it,
//   because a feasibility verdict is BUILD-SCOPED and perishes on the next deploy.
//
//   node scripts/tra2335-feasibility-check.mjs             # RECONSTRUCTION (mechanism)
//   node scripts/tra2335-feasibility-check.mjs --render    # + the roll-up markdown
//   node scripts/tra2335-feasibility-check.mjs --live      # THE LIVE GATE (a monitor)
//   node scripts/tra2335-feasibility-check.mjs --live --base=https://host
//
// Exit codes (both modes fail CLOSED — an unreadable input is never a pass):
//   0 OK · 1 FAIL (the instrument is broken) · 3 BLIND (could not read; NOT a pass)
//
// Reconstruction inputs, with provenance — the live figures cited on TRA-2332:
//   pooled credit/width k = 0.0366, n = 35 (31 bull_put_spread + 4 bear_call_spread)
//   GET /api/health/options-ideas-decomposition, 2026-07-25, build 073b2b94161d
//   cost drag 0.0389R (avgCostR over the graded set)
//
// The reconstruction mode requires a build first: `pnpm typecheck` (which emits dist/).
// `--live` needs no build — it reads the deployed route over HTTP.

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const BAR = 0.2;
const baseArg = argv.find((a) => a.startsWith('--base='));
const BASE = (baseArg ? baseArg.slice('--base='.length) : 'https://tradingai-bqb1.onrender.com')
  .replace(/\/+$/, '');

// ── LIVE MODE — a real monitor over the deployed gate ────────────────────────
//
// What this grades, and what it deliberately does NOT:
//
//   IT GRADES THE INSTRUMENT. Is the sleeve decomposition actually published on the
//   route (the TRA-2335 field-map trap: an explicit whitelist SILENTLY DROPS every field
//   you add downstream of it, so the module stays correct, the unit tests stay green, and
//   the route you grade from shows no change)? And when the book is `feasible` while a
//   sleeve inside it is not, does the headline say so?
//
//   IT DOES NOT GRADE THE BOOK. A live `feasible` is not a pass and a live `infeasible`
//   is not a failure — those are facts about the trading book, not about this check.
//   Wiring them to the exit code would turn a market observation into a red build.
if (LIVE) {
  const url = `${BASE}/api/health/live-capital-gate`;
  let gate;
  let version = null;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.error(`\n⚠️  BLIND — ${url} returned HTTP ${res.status}. This is NOT a pass.`);
      process.exit(3);
    }
    gate = await res.json();
  } catch (err) {
    console.error(`\n⚠️  BLIND — could not read ${url}: ${err?.message ?? err}. This is NOT a pass.`);
    process.exit(3);
  }
  try {
    const v = await fetch(`${BASE}/api/health/version`, { headers: { accept: 'application/json' } });
    if (v.ok) version = await v.json();
  } catch {
    // Non-fatal: the verdict below is still readable, it just cannot be pinned to a SHA.
  }

  console.log('── TRA-2353 · LIVE gate feasibility ──────────────────────────────');
  console.log(`  source              : ${url}`);
  console.log(`  build               : ${version?.commit ?? '(unknown — verdict is UNPINNED)'}`);
  console.log(`  asOfDate            : ${gate.asOfDate}`);
  console.log(`  gate.passed         : ${gate.passed}`);
  console.log('');

  const f = gate.feasibility ?? {};
  console.log(`  book verdict        : ${f.verdict}`);
  console.log(`  book ceilingGrossR  : ${f.ceilingGrossR}`);
  console.log(`  book avgCostR       : ${f.avgCostR}`);
  console.log(`  book ceilingNetR    : ${f.ceilingR}   vs bar ${f.barR}R`);
  console.log(`  reward provenance   : ${JSON.stringify(f.ceilingSources)}`);

  const problems = [];
  const sf = gate.sleeveFeasibility;
  if (sf == null) {
    // The exact TRA-2335 trap, one ticket later: `index.ts` maps this payload field by
    // field. A new field that is not added there is dropped in silence.
    problems.push(
      'the route carries NO `sleeveFeasibility` block — either the build predates TRA-2353 or the field-by-field payload whitelist in index.ts dropped it',
    );
  } else {
    for (const [name, axis] of Object.entries(sf).filter(([, a]) => a && a.sleeves)) {
      console.log('');
      console.log(`  ── ${name} (${axis.axis}, bookN=${axis.bookN}) ──`);
      for (const s of axis.sleeves) {
        const pct = s.weight == null ? '  ?' : `${String(Math.round(s.weight * 100)).padStart(3)}`;
        console.log(
          `     ${String(s.key).padEnd(20)} n=${String(s.n).padStart(3)}  ${pct}%  ceilingNetR=${String(s.ceilingNetR).padStart(9)}  → ${s.verdict}${s.material ? '' : '  (immaterial)'}`,
        );
      }
      if (axis.worstSleeve) {
        console.log(
          `     ⚠️ worst: ${axis.worstSleeve.key} — infeasible, carrying ${Math.round((axis.infeasibleWeight ?? 0) * 100)}% of the graded book`,
        );
      }
      const fr = axis.fragility ?? {};
      console.log(
        `     fragility: flipsOnSingleSleeveRemoval=${fr.flipsOnSingleSleeveRemoval}${fr.flippingSleeves?.length ? ` via [${fr.flippingSleeves.join(', ')}]` : ''}`,
      );
      for (const l of fr.leaveOneOut ?? []) {
        console.log(
          `        without ${String(l.excludedKey).padEnd(20)} (n=${String(l.excludedN).padStart(3)}) → ceilingNetR=${String(l.ceilingNetR).padStart(9)}  ${l.verdict}${l.flipsBookVerdict ? '  ⚠️ FLIPS' : ''}`,
        );
      }

      // AC2, graded against the LIVE bytes: a book that is feasible in aggregate while a
      // sleeve inside it is infeasible MUST say so where an operator will see it.
      if (f.verdict === 'feasible' && axis.worstSleeve && axis.sleeves.length > 1) {
        if (!String(gate.summary ?? '').includes(axis.worstSleeve.key)) {
          problems.push(
            `the book reads \`feasible\` while sleeve \`${axis.worstSleeve.key}\` (${Math.round((axis.worstSleeve.weight ?? 0) * 100)}% of the book) is infeasible, and the headline summary does not name it`,
          );
        }
      }
    }
  }

  // AC4, graded against the LIVE bytes.
  const c3 = (gate.criteria ?? []).find((c) => c.name === 'positive_expectancy');
  if (c3 && c3.status === 'FAIL' && f.verdict === 'unknown') {
    if (!String(gate.summary ?? '').includes('REACHABILITY UNKNOWN')) {
      problems.push(
        'criterion 3 reads a bare FAIL while the ceiling is `unknown`, and the headline does not say so — a FAIL there asserts "the book underperformed", which is exactly the conflation this gate exists to prevent',
      );
    }
  }

  console.log('');
  console.log(`  summary: ${gate.summary}`);

  if (problems.length > 0) {
    console.error(`\n❌ FAIL — ${problems.length} problem(s) with the LIVE instrument:`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log(
    `\n✅ OK — the live gate publishes the sleeve decomposition and its headline matches it.` +
      `\n   ⚠️ This is a statement about build ${version?.commit ?? '(unpinned)'} at this instant, and it perishes on the next deploy.` +
      `\n   ⚠️ It says nothing about whether the BOOK is feasible — read the verdicts above for that.`,
  );
  process.exit(0);
}

// ── RECONSTRUCTION MODE — the mechanism, over a constant ─────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'packages', 'server', 'dist');

const { buildForwardTestReport, buildAccumulationMonitor, renderWeeklyRollupMarkdown } =
  await import(new URL(`file://${join(dist, 'options-forward-test.js')}`).href);
const { evaluateLiveCapitalGate, LIVE_CAPITAL_GATE } =
  await import(new URL(`file://${join(dist, 'live-capital-gate.js')}`).href);

// k = 0.0366 ⇒ credit 36.6 against a width of 1000 ⇒ maxLoss = width − credit = 963.4.
const CREDIT = 36.6;
const MAX_LOSS = 963.4;
const COST_R = 0.0389;
const N = 35;

const book = Array.from({ length: N }, (_, i) => ({
  key: `k${i}`,
  ticker: 'SPY',
  strategy: 'bull_put_spread',
  surfacedDate: '2026-01-05',
  surfacedWeek: `2026-W${String((i % 8) + 1).padStart(2, '0')}`,
  expiration: '2026-02-20',
  pop: 0.96,
  maxLossUsd: MAX_LOSS,
  maxProfitUsd: CREDIT,
  entryNetUsd: CREDIT,
  status: 'resolved',
  valuedAt: '2026-02-20',
  liquidationUsd: 0,
  pnlUsd: CREDIT,
  pnlR: 0.038,
  costsUsd: MAX_LOSS * COST_R,
  pnlNetUsd: CREDIT - MAX_LOSS * COST_R,
  pnlNetR: -0.001,
  costEfficiencyRatio: COST_R,
  win: true,
  maxLossBreached: false,
  excluded: false,
  excludeReason: null,
  settleLagDays: 0,
}));

const report = buildForwardTestReport(book, { asOf: Date.parse('2026-02-23T16:00:00Z') });
const t = report.totals;
const gate = evaluateLiveCapitalGate(report, { ...LIVE_CAPITAL_GATE, minExpectancyR: BAR });
const c3 = gate.criteria.find((c) => c.name === 'positive_expectancy');

console.log('── TRA-2335 feasibility precondition — RECONSTRUCTION (mechanism) ─');
console.log('  ⚠️ THIS IS A UNIT TEST WITH A CLI, NOT A MONITOR. The book below is a');
console.log('     CONSTANT in this file, so this output will read INFEASIBLE forever');
console.log('     regardless of the live book. For the live gate, run with `--live`.');
console.log('');
console.log(`  graded n            : ${t.resolved}`);
console.log(`  rewardR (ceiling)   : +${t.ceilingGrossR}R   gross, at a 100% hit rate`);
console.log(`  avgCostR (graded)   :  ${t.avgCostR}R`);
console.log(`  ceilingNetR         :  ${t.ceilingNetR}R   ← what criterion 3 grades against`);
console.log(`  bar (minExpectancyR): +${BAR}R   = ${(BAR / t.ceilingGrossR).toFixed(1)}× the gross ceiling`);
// Criterion 3 grades the cost-NET figure, so the cost drag belongs in the numerator:
//   p·rewardR − (1 − p) − costR = bar  ⇒  p = (bar + 1 + costR) ÷ (rewardR + 1)
// Omitting `costR` understates it (1.16 vs 1.19) and would contradict the ticket's
// verified arithmetic.
console.log(`  implied hit rate    :  ${((BAR + 1 + t.avgCostR) / (1 + t.ceilingGrossR)).toFixed(2)}  (a probability > 1)`);
console.log(`  reward provenance   :  ${JSON.stringify(t.ceilingSourceCounts)}`);
console.log('');
console.log(`  criterion 3 status  :  ${c3.status}      (pass=${c3.pass})`);
console.log(`  gate.passed         :  ${gate.passed}`);
console.log(`  feasibility verdict :  ${gate.feasibility.verdict}`);
console.log('');
console.log(`  summary: ${gate.summary}`);

const monitor = buildAccumulationMonitor({
  report,
  gate: { minWeeksWithResolved: 8, minResolvedIdeas: 30, minExpectancyR: BAR },
  chainOutDir: '/data/option-chains',
  chainDates: ['2026-01-05'],
  journalCount: N,
  firstJournaledDate: '2026-01-05',
  lastJournaledDate: '2026-01-05',
  tradierConfigured: true,
  anthropicConfigured: true,
});
console.log('');
console.log(`  monitor weeksRemaining   : ${JSON.stringify(monitor.gate.weeksRemaining)}  (null = withheld)`);
console.log(`  monitor resolvedRemaining: ${JSON.stringify(monitor.gate.resolvedRemaining)}`);

// TRA-2353 — the sleeve decomposition over the same reconstruction. This book is a SINGLE
// sleeve, so the sleeve verdict IS the book verdict; the interesting mixed case is
// covered by `gate-sleeve-feasibility.test.ts`, which is where the live 47-row mix lives.
const byStructure = gate.sleeveFeasibility?.byStructure;
console.log('');
console.log(`  sleeves (byStructure)    : ${byStructure ? byStructure.sleeves.map((s) => `${s.key}(n=${s.n} → ${s.verdict})`).join(', ') : '(absent)'}`);
console.log(`  leave-one-out sweep      : ${byStructure && byStructure.fragility.leaveOneOut.length === 0 ? 'none — a single-sleeve book has nothing to remove' : JSON.stringify(byStructure?.fragility?.flippingSleeves)}`);

if (argv.includes('--render')) {
  console.log('\n── weekly roll-up markdown ───────────────────────────────────────\n');
  console.log(
    renderWeeklyRollupMarkdown({ monitor, report, gatePassed: false, gateSummary: gate.summary }),
  );
}

// Fail closed: this script exists to prove the precondition BITES.
const problems = [];
if (c3.status !== 'INFEASIBLE') problems.push(`criterion 3 status is ${c3.status}, expected INFEASIBLE`);
if (c3.pass !== false) problems.push('INFEASIBLE did not carry pass:false — it must block exactly as FAIL does');
if (gate.passed !== false) problems.push('gate.passed is true on an unreachable bar');
if (monitor.gate.weeksRemaining !== null) problems.push('the accumulation countdown was published on an unreachable bar');
if (!gate.summary.includes('INFEASIBLE')) problems.push('the summary does not name the INFEASIBLE state');
if (byStructure == null) problems.push('TRA-2353: the gate result carries no `sleeveFeasibility` block');
else if (byStructure.sleeves.length !== 1 || byStructure.sleeves[0].verdict !== 'infeasible')
  problems.push('TRA-2353: the single-sleeve partition did not reproduce the book verdict');

if (problems.length > 0) {
  console.error(`\n❌ FAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`   · ${p}`);
  process.exit(1);
}
console.log('\n✅ PASS — the MECHANISM works: the bar is reported INFEASIBLE, it blocks promotion,');
console.log('   and the countdown is withheld.');
console.log('   ⚠️ This green is about the CODE PATH ONLY. It is not, and can never become,');
console.log('      a statement about the live book — run `--live` for that.');
