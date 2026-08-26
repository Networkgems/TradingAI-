#!/usr/bin/env node
// TRA-3933 AC5 — how many journal rows are duplicate records of ONE close, and
// how much realized money is inside them?
//
// "MINT=3 REBIND=0" on the TRA-2951 grade run is the reason this exists: three
// mints is not obviously one duplicate, and a fix sized off one contract is a
// fix that has not been sized at all.
//
// ── Why it imports the predicate instead of re-spelling it ───────────────────
// TRA-3930 already decided what "the same close" means, in `closeIdentityKey`
// (`mode | optionSymbol | closeTs`), and `/api/trades/export` collapses on it.
// A census with its own private definition answers a DIFFERENT question than the
// export answers, and the gap between the two is invisible in both outputs. So
// the predicate is imported from the built server package — run `pnpm build`
// first; a missing dist is a HOLD, not a zero.
//
// ── What a duplicate costs ───────────────────────────────────────────────────
// Both rows of a group carry `realizedPnlUsd`. Every fold that sums the journal
// without collapsing (expectancy, `byExitReason`, any day/period P&L computed off
// the journal alone once the 21:00 ET archive has removed the book half) counts
// the close once per row. The overstatement is therefore the group's total MINUS
// the one record that should survive — reported per group and in aggregate.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   node scripts/tra3933-duplicate-close-census.mjs
//   node scripts/tra3933-duplicate-close-census.mjs --host=http://127.0.0.1:3000
//   node scripts/tra3933-duplicate-close-census.mjs --file=oj.json --json=out.json
//
// Exit codes:
//   0  censused, ZERO duplicate groups   1  duplicates found (the defect)
//   2  usage/arg error                   3  BLIND — could not read; report NOTHING

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'packages', 'server', 'dist', 'export-history.js');

let host = process.env.HOST_BASE ?? 'https://tradingai-bqb1.onrender.com';
let file = null;
let jsonOut = null;
for (const a of process.argv.slice(2)) {
  let m;
  if ((m = /^--host=(.+)$/.exec(a))) host = m[1].replace(/\/$/, '');
  else if ((m = /^--file=(.+)$/.exec(a))) file = m[1];
  else if ((m = /^--json=(.+)$/.exec(a))) jsonOut = m[1];
  else { console.error(`unknown arg ${a}`); process.exit(2); }
}

// ── The predicate, imported ──────────────────────────────────────────────────
let closeIdentityKey;
try {
  ({ closeIdentityKey } = await import(pathToFileURL(resolve(DIST)).href));
} catch (err) {
  console.error(`cannot load closeIdentityKey from ${DIST} — run \`pnpm build\` first.`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  console.error('BLIND: refusing to census with a re-spelled predicate.');
  process.exit(3);
}
if (typeof closeIdentityKey !== 'function') {
  console.error('closeIdentityKey is not a function in the built package — BLIND.');
  process.exit(3);
}

// ── The rows ─────────────────────────────────────────────────────────────────
let payload;
if (file) {
  try { payload = JSON.parse(readFileSync(file, 'utf8')); }
  catch (err) { console.error(`cannot read ${file}: ${err.message} — BLIND`); process.exit(3); }
} else {
  const url = `${host}/api/health/option-journal?rows=all`;
  const r = await fetch(url).catch(e => ({ ok: false, err: e }));
  if (!r.ok) { console.error(`GET ${url} -> ${r.status ?? r.err} — BLIND`); process.exit(3); }
  payload = await r.json();
}
const rows = payload.rows;
if (!Array.isArray(rows)) {
  console.error('payload.rows is not an array — the route shape changed. BLIND.');
  process.exit(3);
}
// `rows=all` is what makes this a census. A truncated projection would report a
// smaller population as if it were the whole one, so the row count is checked
// against the route's own total rather than trusted.
const claimed = payload.summary?.total ?? payload.rowsFiltered ?? null;
console.log(`source     ${file ?? host}`);
// `build` is an object on this route (commit + boot), not a string — printed as
// JSON so the census names the code it measured instead of `[object Object]`.
console.log(`build      ${payload.build === undefined ? '(unstated)' : JSON.stringify(payload.build)}`);
console.log(`rows       ${rows.length}${claimed != null ? `  (route reports ${claimed})` : ''}`);

// ── Group ────────────────────────────────────────────────────────────────────
const groups = new Map();
let keyed = 0;
for (const r of rows) {
  const k = closeIdentityKey(r);
  if (k === null) continue;   // still OPEN, or no contract identity to join on
  keyed += 1;
  const g = groups.get(k);
  if (g) g.push(r); else groups.set(k, [r]);
}
const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
console.log(`closed rows carrying a close-identity key : ${keyed}`);
console.log(`distinct closes                           : ${groups.size}`);
console.log(`closes recorded MORE THAN ONCE            : ${dupes.length}`);
console.log('');

// TRA-3930's ruling, reused rather than re-decided: the ENGINE-authored record
// wins the description. Whatever survives, the money the folds overstate is the
// group total minus the single surviving record — so rank the same way the
// export does and treat the top-ranked row as the survivor.
const TRADIER_IMPORT_STRUCTURE = 'tradier_import';
const RECONSTRUCTED_EXIT_REASON = 'reconstructed-TRA-3472';
function descriptiveRank(r) {
  let rank = 0;
  if (r.structure !== TRADIER_IMPORT_STRUCTURE) rank += 2;
  if (r.exitReason && r.exitReason !== RECONSTRUCTED_EXIT_REASON) rank += 1;
  return rank;
}

let overstatedUsd = 0;
const report = [];
for (const [key, members] of dupes) {
  const ranked = [...members].sort((a, b) => descriptiveRank(b) - descriptiveRank(a));
  const survivor = ranked[0];
  const losers = ranked.slice(1);
  const groupTotal = members.reduce((a, r) => a + (Number(r.realizedPnlUsd) || 0), 0);
  const overstate = groupTotal - (Number(survivor.realizedPnlUsd) || 0);
  overstatedUsd += overstate;
  const entry = {
    key,
    mode: members[0].mode,
    optionSymbol: members[0].optionSymbol,
    rows: members.length,
    survivorId: survivor.id,
    overstatedUsd: overstate,
    members: members.map(r => ({
      id: r.id,
      structure: r.structure,
      outcome: r.outcome,
      exitReason: r.exitReason ?? null,
      openTs: r.openTs,
      realizedPnlUsd: r.realizedPnlUsd,
      realizedR: r.realizedR,
      atRiskUsd: r.atRiskUsd,
      pnlBasis: r.pnlBasis ?? null,
    })),
  };
  report.push(entry);
  console.log(`${key}   ${members.length} rows`);
  const openTsSpread = Math.max(...members.map(r => r.openTs)) - Math.min(...members.map(r => r.openTs));
  console.log(`  openTs spread across the group: ${openTsSpread} ms`);
  for (const r of ranked) {
    const tag = r === survivor ? 'SURVIVES' : 'duplicate';
    console.log(
      `  ${tag}  ${r.id}  ${String(r.structure).padEnd(16)} ${String(r.outcome).padEnd(5)} `
      + `${String(r.exitReason ?? '-').padEnd(24)} pnl=${r.realizedPnlUsd} R=${r.realizedR} atRisk=${r.atRiskUsd}`,
    );
  }
  console.log(`  folds that do not collapse overstate this close by $${overstate.toFixed(2)}`);
  console.log('');
  void losers;
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ rows: rows.length, keyed, closes: groups.size, dupes: report }, null, 2));
  console.log(`wrote ${jsonOut}`);
}

if (dupes.length === 0) {
  console.log('CLEAN — every close in the journal is recorded exactly once.');
  process.exit(0);
}
console.log(`DUPLICATES: ${dupes.length} close(s), $${overstatedUsd.toFixed(2)} of realized P&L counted twice.`);
process.exit(1);
