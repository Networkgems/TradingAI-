#!/usr/bin/env node
// TRA-5145: per-stage candidate attrition census, universe -> cost-bar arrival.
//
// Read-only. Pulls three durable health surfaces off the live host and prints the
// per-stage waterfall for a chosen ET day (or inclusive day range), split by
// path x accountClass x mode (options sleeves) plus the equity-entry-funnel sleeve.
//
//   node scripts/tra5145-attrition-census.mjs 2026-10-02
//   node scripts/tra5145-attrition-census.mjs 2026-09-14 2026-09-18
//   TRADING_API_BASE=https://tradingai-bqb1.onrender.com node scripts/tra5145-attrition-census.mjs 2026-10-02
//
// Sources (all unauthenticated GETs):
//   /api/health/rv-scan              censusByEtDay (30d retained; options paths rv_scan/otm/directional)
//   /api/health/equity-entry-funnel  retained.byEtDay (30d retained; equity sleeve)
//   /api/health/cost-aware-gate      retained (7d demo cost-bar ledger; reconciliation only)
//
// Caveats carried from the surfaces' own notes (do not strip when quoting output):
//   - rv-scan `scans`/`candidatesEvaluated` are LOWER BOUNDS (5-min flush throttle, watchdog kills).
//   - an ABSENT cell is the absence of a reading, not a zero.
//   - cost-aware-gate ledger is DEMO verdicts only; rv-scan census counts both modes.
//   - rejectionsByGate + candidatesPassed sums to candidatesEvaluated per cell (verified 2026-10-05);
//     the script asserts this and flags any cell where it no longer holds.

// Deliberately NOT keyed on TRADING_API_BASE: that var flips between localhost and
// hosts in agent shells (TRA-traps §x29/§x56) and a localhost read grades the wrong box.
// Override only via the census-specific var.
const BASE = (process.env.TRA5145_CENSUS_BASE || 'https://tradingai-bqb1.onrender.com').replace(/\/$/, '');
const from = process.argv[2];
const to = process.argv[3] || from;
if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
  console.error('usage: node scripts/tra5145-attrition-census.mjs <etDayFrom> [etDayTo]');
  process.exit(2);
}

const inRange = (d) => d >= from && d <= to;
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(3) + '%' : 'n/a');

async function getJson(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

function aggregateRvScan(census) {
  const cells = new Map(); // key: path|class|mode
  for (const day of census) {
    if (!inRange(day.etDay)) continue;
    for (const c of day.cells) {
      const k = `${c.path}|${c.accountClass}|${c.mode}`;
      const a = cells.get(k) || {
        path: c.path, accountClass: c.accountClass, mode: c.mode,
        scans: 0, evaluated: 0, passed: 0, opens: 0, blindScans: 0,
        rejections: {}, badWaterfall: [],
      };
      a.scans += c.scans; a.evaluated += c.candidatesEvaluated;
      a.passed += c.candidatesPassed; a.opens += c.opensPlaced;
      a.blindScans += c.blindScans || 0;
      let rejSum = 0;
      for (const [g, n] of Object.entries(c.rejectionsByGate || {})) {
        a.rejections[g] = (a.rejections[g] || 0) + n;
        rejSum += n;
      }
      if (rejSum + c.candidatesPassed !== c.candidatesEvaluated) {
        a.badWaterfall.push(`${day.etDay}: rej ${rejSum} + passed ${c.candidatesPassed} != evaluated ${c.candidatesEvaluated}`);
      }
      cells.set(k, a);
    }
  }
  return [...cells.values()];
}

// Stage buckets for display. True gate order differs per path (signal-engine.ts):
//   rv_scan:     scan:* -> no_candidates -> no_trend_aligned_candidate -> ema_pullback_* ->
//                ivr_ceiling -> earnings_before_expiry -> cost_aware_bar -> recent_duplicate(AFTER bar)
//   otm:         scan:* -> no_candidates -> contract_floor_*(chain) -> no_in_band_strike ->
//                recent_duplicate(parked echoes, see caveat) -> taxonomy -> entry_window_closed ->
//                contract_floor(pick) -> live gates -> cost_bar
//   directional: no_shadow_series -> no_trend_confluence -> scan:*/no_chain -> no_liquid_contract ->
//                quality_gate:* -> churn_brake -> spread_ceiling -> cost_aware_bar
// ⚠ CAVEAT (TRA-4974): on the OTM path a cost-bar or entry-window refusal is parked in
// recentSignals and re-rejected as `recent_duplicate` on every subsequent sweep (~12/hr),
// so `recent_duplicate` double-counts downstream refusals as upstream deaths.
// Everything else falls into "other".
const STAGE_ORDER = [
  ['feed/scan', (g) => g.startsWith('scan:')],
  ['candidate generation', (g) => g === 'no_candidates' || g === 'no_shadow_series'],
  ['strategy gates', (g) => ['no_trend_confluence', 'no_trend_aligned_candidate', 'entry_window_closed', 'recent_duplicate', 'churn_brake'].includes(g)],
  ['contract selection', (g) => g.startsWith('contract_floor') || g === 'no_in_band_strike' || g === 'no_liquid_contract' || g.startsWith('quality_gate:')],
  ['spread ceiling', (g) => g === 'spread_ceiling'],
  ['cost bar', (g) => g === 'cost_aware_bar' || g === 'cost_bar'],
];

function printCell(a) {
  const total = a.evaluated;
  if (!total) return;
  const barRej = (a.rejections.cost_aware_bar || 0) + (a.rejections.cost_bar || 0);
  const arrivals = barRej + a.passed; // valid while the cost bar is the terminal gate
  console.log(`\n--- ${a.path} | ${a.accountClass} | ${a.mode}`);
  console.log(`scans ${a.scans}  evaluated ${total}  passed ${a.passed}  opensPlaced ${a.opens}  blindScans ${a.blindScans}`);
  console.log(`bar arrivals ${arrivals} (${pct(arrivals, total)} of evaluated)`);
  for (const [stage, match] of STAGE_ORDER) {
    const gates = Object.entries(a.rejections).filter(([g]) => match(g));
    if (!gates.length) continue;
    const sum = gates.reduce((s, [, n]) => s + n, 0);
    console.log(`  ${stage.padEnd(22)} ${String(sum).padStart(9)}  ${pct(sum, total)}`);
    for (const [g, n] of gates.sort((x, y) => y[1] - x[1])) {
      console.log(`      ${g.padEnd(32)} ${String(n).padStart(9)}  ${pct(n, total)}`);
    }
  }
  const known = new Set(STAGE_ORDER.flatMap(([, m]) => Object.keys(a.rejections).filter(m)));
  const other = Object.entries(a.rejections).filter(([g]) => !known.has(g));
  if (other.length) {
    console.log('  UNBUCKETED GATES (extend STAGE_ORDER):', other.map(([g, n]) => `${g}=${n}`).join(', '));
  }
  if (a.badWaterfall.length) {
    console.log('  !! WATERFALL MISMATCH (rej+passed != evaluated):', a.badWaterfall.join(' ; '));
  }
}

function printEquity(funnel) {
  const rows = funnel?.retained?.byEtDay || [];
  for (const d of rows) {
    if (!inRange(d.etDay)) continue;
    console.log(`\n--- equity funnel | ${d.etDay} | ${d.mode}`);
    console.log(`passesFired ${d.passesFired}  gated ${d.passesGated}  iterated ${d.passesIterated}`);
    console.log(`symbolsConsidered ${d.symbolsConsidered}  evaluated ${d.symbolsEvaluated}  candidates ${d.candidates}  admitted ${d.admitted}`);
    console.log(`skippedByReason ${JSON.stringify(d.symbolsSkippedByReason)}`);
    console.log(`candidatesBySource ${JSON.stringify(d.candidatesBySource)}  zeroedAtStage ${d.zeroedAtStage}`);
  }
}

const [rvScan, funnel, costGate] = await Promise.all([
  getJson('/api/health/rv-scan'),
  getJson('/api/health/equity-entry-funnel'),
  getJson('/api/health/cost-aware-gate'),
]);

console.log(`TRA-5145 attrition census  ${from}..${to}`);
console.log(`host ${BASE}  build ${rvScan.build?.commitShort}  read ${rvScan.time}`);
console.log(`rv-scan verdict ${rvScan.verdict}  rthStaleness ${JSON.stringify(rvScan.rthStaleness)}`);

const cells = aggregateRvScan(rvScan.censusByEtDay || []);
cells.sort((a, b) => (a.path + a.accountClass + a.mode).localeCompare(b.path + b.accountClass + b.mode));
for (const a of cells) printCell(a);

printEquity(funnel);

// Reconciliation: demo cost-bar ledger vs census demo cost_aware_bar counts (same days, see TRA-4439 D4 note).
const retained = costGate?.retained;
if (retained) {
  console.log(`\n--- cost-aware-gate demo ledger (7d retained: ${JSON.stringify(retained.etDays)})`);
  console.log(`armed ${costGate.armed}  admittedTotal ${retained.admittedTotal}  rejectedTotal ${retained.rejectedTotal}`);
  for (const s of retained.byStructure || []) {
    if (s.rejected || s.admitted) {
      console.log(`  ${s.structure}: admitted ${s.admitted} (merit ${s.admittedOnMerit}, bypass ${s.admittedByBypass})  rejected ${s.rejected}  maxRejectedGrossR ${s.maxRejectedGrossR}`);
    }
  }
}
