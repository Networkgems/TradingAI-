#!/usr/bin/env node
// TRA-5110 — READ-ONLY quote census over the `contracts_unknown` cohort.
//
// Question: Rung 3 (mark_minus_slippage_plus_fees) is dead on the unattributed
// cohort (0 of 2164 rows carry any slippage sample), so Rung 2
// (crossed_plus_fees) is the only grading path left — and Rung 2 needs
// `contracts` AND a usable entry quote AND a resolvable exit quote. The
// TRA-5000 backfill can only deliver `contracts`. This script measures whether
// the QUOTES are already there, i.e. whether a contracts backfill would
// actually move `coverage.graded` or merely relabel `contracts_unknown` as
// `entry_quote_missing`/`exit_quote_missing`.
//
// Method: `priceCrossedRow` tests `contracts` BEFORE either quote side
// (option-crossed-pnl.ts:212 vs 219/226), so on every `contracts_unknown` row
// the quote verdict is MASKED on all published surfaces. We replicate the
// module's own predicates verbatim (usableSide, the TRA-3990-stamp-then-
// TRA-1656-snapshot entry precedence, resolveCrossedExitQuote's fire-tick-
// then-close-seam precedence incl. the EXIT_QUOTE_MAX_AGE_MS staleness
// refusal) and evaluate them per row with the contracts test lifted.
//
// Read-only: one GET of /api/health/option-journal?rows=all. No write, no
// deploy, no schema change.
//
// Exit codes (the check:deploy-build convention): 0 MEASURED · 2 usage ·
// 3 BLIND (route unreachable / dump missing / cohort shape unrecognisable).
// BLIND never masquerades as a zero census.

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
const EXIT_QUOTE_MAX_AGE_MS = 10 * 60_000; // option-exit-quote.ts:50

const LONG = new Set(['single_leg', 'single_leg_otm', 'single_leg_rv', 'single_leg_directional', 'directional']);
const SHORT = new Set(['covered_call', 'cash_secured_put']);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) { console.error(`unrecognised arg: ${a}`); process.exit(2); }
    return [m[1], m[2] ?? true];
  }),
);
const host = typeof args.host === 'string' ? args.host : DEFAULT_HOST;

const usableSide = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// option-crossed-pnl.ts:173-203, verbatim precedence.
function resolveExit(row) {
  const fire = row.markProvenance?.quoteAtFire ?? null;
  if (fire !== null && fire !== undefined) return { quote: fire, source: 'fire_tick' };
  const stamp = row.exitQuote ?? null;
  if (stamp === null || stamp === undefined) return { quote: null, reason: 'exit_quote_missing' };
  const ageMs = typeof stamp.ageMs === 'number' && Number.isFinite(stamp.ageMs) ? stamp.ageMs : Number.POSITIVE_INFINITY;
  if (ageMs > EXIT_QUOTE_MAX_AGE_MS) return { quote: null, reason: 'exit_quote_stale' };
  return { quote: { bid: stamp.bid, ask: stamp.ask }, source: stamp.source === 'fire_tick' ? 'fire_tick' : 'last_known' };
}

function blind(why) {
  console.error(`BLIND: ${why}`);
  console.error('No census was produced. An unreadable cohort must not read as an empty one.');
  process.exit(3);
}

const url = `${host.replace(/\/$/, '')}/api/health/option-journal?rows=all`;
let payload;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) blind(`GET ${url} -> HTTP ${res.status}`);
  payload = await res.json();
} catch (e) {
  blind(`GET ${url} failed: ${e?.message ?? e}`);
}
if (!Array.isArray(payload.rows)) blind('payload carries no rows[] dump (rows=all not honoured?)');

const build = payload.build?.commit ?? payload.build ?? 'unknown';
const closedUnattributed = payload.rows.filter((r) => r.accountClass === 'unattributed' && r.outcome !== 'OPEN');

// The cohort identity check: unattributed closed = contracts_unknown + structure_not_crossable.
const reasonCensus = {};
for (const r of closedUnattributed) {
  const k = r.crossedUnpriced ?? (r.crossedPnlUsd !== null ? 'PRICED' : 'null_no_reason');
  reasonCensus[k] = (reasonCensus[k] ?? 0) + 1;
}

const cohort = closedUnattributed.filter((r) => r.crossedUnpriced === 'contracts_unknown');

// Per-row verdict with the contracts test lifted.
const byStructure = new Map();
const cell = () => ({
  rows: 0,
  // 2x2: entry {present,absent} x exit {present,absent}. "exit present" =
  // resolveCrossedExitQuote returns a book AND the transacting side is usable
  // (a book whose relevant side is 0 cannot price, so counting it as present
  // would overstate the backfill yield).
  bothPresent: 0, entryOnly: 0, exitOnly: 0, neither: 0,
  // exit-side sub-census so "absent" stays attributable
  exitFireTick: 0, exitLastKnown: 0, exitStale: 0, exitMissing: 0, exitUnusable: 0,
  atRiskBasis: { fill: 0, mark: 0, null: 0 },
});
const total = cell();

for (const r of cohort) {
  const long = LONG.has(r.structure);
  const short = !long && SHORT.has(r.structure);
  if (!long && !short) {
    // cannot happen: priceCrossedRow tests structure BEFORE contracts, so a
    // contracts_unknown row is crossable by construction. Refuse rather than guess.
    blind(`row ${r.id ?? '?'} is contracts_unknown but structure '${r.structure}' is not crossable — predicate drift vs the deployed build`);
  }
  const entryPresent = long
    ? (usableSide(r.entryAskAtOpen) || usableSide(r.entryAsk))
    : (usableSide(r.entryBidAtOpen) || usableSide(r.entryBid));
  const resolved = resolveExit(r);
  let exitPresent = false;
  let exitKind;
  if (resolved.quote === null) {
    exitKind = resolved.reason; // exit_quote_missing | exit_quote_stale
  } else if (!usableSide(long ? resolved.quote.bid : resolved.quote.ask)) {
    exitKind = 'exit_quote_unusable';
  } else {
    exitPresent = true;
    exitKind = resolved.source; // fire_tick | last_known
  }
  const basis = r.atRiskBasis === 'fill' || r.atRiskBasis === 'mark' ? r.atRiskBasis : 'null';

  const s = byStructure.get(r.structure) ?? cell();
  byStructure.set(r.structure, s);
  for (const c of [s, total]) {
    c.rows += 1;
    if (entryPresent && exitPresent) c.bothPresent += 1;
    else if (entryPresent) c.entryOnly += 1;
    else if (exitPresent) c.exitOnly += 1;
    else c.neither += 1;
    if (exitKind === 'fire_tick') c.exitFireTick += 1;
    else if (exitKind === 'last_known') c.exitLastKnown += 1;
    else if (exitKind === 'exit_quote_stale') c.exitStale += 1;
    else if (exitKind === 'exit_quote_unusable') c.exitUnusable += 1;
    else c.exitMissing += 1;
    c.atRiskBasis[basis] += 1;
  }
}

const out = {
  issue: 'TRA-5110',
  measuredAt: new Date().toISOString(),
  source: url,
  liveBuild: build,
  closedUnattributed: closedUnattributed.length,
  crossedUnpricedCensus: reasonCensus,
  cohort: 'crossedUnpriced === contracts_unknown over closed unattributed rows',
  cohortRows: cohort.length,
  exitStalenessCeilingMs: EXIT_QUOTE_MAX_AGE_MS,
  note:
    'bothPresent = rows a contracts-only backfill would make Rung-2 priceable. '
    + 'entryOnly/exitOnly/neither = rows it would merely relabel to a quote-missing reason.',
  total,
  byStructure: Object.fromEntries([...byStructure.entries()].sort((a, b) => b[1].rows - a[1].rows)),
};

console.log(JSON.stringify(out, null, 2));

// The two yield bars from the issue, graded against what was measured.
const rv = byStructure.get('single_leg_rv');
if (rv) {
  const rvYield = rv.bothPresent / rv.rows;
  console.error(`\n[yield] single_leg_rv: ${rv.bothPresent}/${rv.rows} both-quotes (${(rvYield * 100).toFixed(1)}%) vs 19.4% needed for n>=300`);
}
const g2Yield = total.bothPresent / Math.max(1, total.rows);
console.error(`[yield] whole cohort: ${total.bothPresent}/${total.rows} both-quotes (${(g2Yield * 100).toFixed(1)}%) vs 79.1% needed for G2 >= 0.80`);
