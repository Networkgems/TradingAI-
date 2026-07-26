#!/usr/bin/env node
// TRA-2335 — a RE-RUNNABLE prover for the payoff-ceiling feasibility precondition.
//
// Why a checker and not a pasted number: a feasibility verdict is BUILD-SCOPED. It is a
// statement about the bytes currently live, and it perishes the moment anyone deploys.
// Run this against the built server modules to reproduce the numbers from scratch; it
// exits non-zero if the precondition is not doing its job.
//
//   node scripts/tra2335-feasibility-check.mjs                # the live credit book
//   node scripts/tra2335-feasibility-check.mjs --render       # + the roll-up markdown
//
// Inputs are the live figures cited on TRA-2332, with provenance:
//   pooled credit/width k = 0.0366, n = 35 (31 bull_put_spread + 4 bear_call_spread)
//   GET /api/health/options-ideas-decomposition, 2026-07-25, build 073b2b94161d
//   cost drag 0.0389R (avgCostR over the graded set)
//
// Requires a build first: `pnpm -r --filter "@trading-app/*" build && pnpm --filter
// @trading-app/server exec tsc -b` (or just `pnpm typecheck`, which emits dist/).

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
const BAR = 0.2;
const gate = evaluateLiveCapitalGate(report, { ...LIVE_CAPITAL_GATE, minExpectancyR: BAR });
const c3 = gate.criteria.find((c) => c.name === 'positive_expectancy');

console.log('── TRA-2335 feasibility precondition ─────────────────────────────');
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

if (process.argv.includes('--render')) {
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

if (problems.length > 0) {
  console.error(`\n❌ FAIL — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`   · ${p}`);
  process.exit(1);
}
console.log('\n✅ PASS — the bar is reported INFEASIBLE, it blocks promotion, and the countdown is withheld.');
