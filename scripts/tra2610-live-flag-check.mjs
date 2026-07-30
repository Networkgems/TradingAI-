// TRA-2610 — grade the deployed fix against the LIVE box. Two independent legs:
//
//   LEG 1 (the erasure). Every row the deployed rule calls suspect must carry
//   `moveSuspect`, whatever its `quoteStatus` says, and no row may still carry the
//   retired `quoteStatus:'suspect'`. This is the leg that fails if the flag is being
//   overwritten again.
//
//   LEG 2 (the headline). No stored top-movers table for today may contain a row that
//   is fabricated ON ITS OWN PUBLISHED NUMBERS.
//
// Two rules this script obeys about its own honesty, both learned the hard way:
//
//   * An EMPTY list passes every "is X absent?" assertion. Each leg therefore reports
//     BLIND when it had nothing to grade, and the exit code is 3 (HOLD) rather than 0
//     if BOTH legs are blind. A zero is only evidence when a non-empty read was
//     possible in the same run.
//   * A stored report is graded on the numbers IT published, never against today's
//     live tape. Joining a dated artifact to a current quote is the very cross-unit
//     error this ticket exists to fix: DFNS is $24/+83.21% (plausible, r=1.83) in the
//     stored 07-29 table and $50.22/+109.25% (suspect) on the live tape hours later,
//     and cross-joining them manufactures a failure that is an artefact of the join.
//
// Usage: node scripts/tra2610-live-flag-check.mjs   [HOST=… ADMIN_PASSWORD=…]
// Exit:  0 PASS (at least one leg graded) · 1 FAIL · 3 BLIND/unreadable
import fs from 'node:fs';
import { assessQuotePlausibility, isMoveSuspect, SUSPECT_MOVE_RATIO } from '../packages/shared/dist/index.js';

const HOST = process.env.HOST ?? 'https://tradingai-bqb1.onrender.com';
let env = {};
try {
  env = Object.fromEntries(
    fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
} catch { /* fall through to process.env */ }
const password = process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD;
const username = process.env.ADMIN_USERNAME ?? env.ADMIN_USERNAME ?? 'admin';

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) { console.error(`BLIND — login ${login.status} at ${HOST}`); process.exit(3); }
const token = (await login.json()).token;
const get = async (p) => {
  const r = await fetch(`${HOST}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

const version = await get('/api/health/version').catch(() => ({}));
console.log(`host               : ${HOST}`);
console.log(`live commit        : ${version.commitShort ?? 'unknown'}  (booted ${version.startedAt ?? '?'})`);
console.log(`threshold          : SUSPECT_MOVE_RATIO = ${SUSPECT_MOVE_RATIO}`);

const fails = [];

// ── LEG 1: the erasure ──────────────────────────────────────────────────────────
const state = await get('/api/state');
const symbols = state.symbols ?? [];
const dist = {};
for (const s of symbols) dist[s.quoteStatus ?? 'undefined'] = (dist[s.quoteStatus ?? 'undefined'] ?? 0) + 1;
const ruleSuspect = symbols.filter(s => assessQuotePlausibility({ price: s.price, change: s.change, changePct: s.changePct }).suspect);
const flagged = symbols.filter(s => s.moveSuspect === true);
const legacy = symbols.filter(s => s.quoteStatus === 'suspect');

console.log(`\nsymbols            : ${symbols.length}`);
console.log(`quoteStatus dist   : ${JSON.stringify(dist)}`);
console.log(`rule-suspect rows  : ${ruleSuspect.length}  ${ruleSuspect.map(s => `${s.symbol}@${s.price}:${Number(s.changePct).toFixed(2)}%:${s.quoteStatus}`).join(', ')}`);
console.log(`moveSuspect:true   : ${flagged.length}  ${flagged.map(s => `${s.symbol}:${s.quoteStatus}`).join(', ')}`);
console.log(`legacy 'suspect'   : ${legacy.length} (must be 0 — the value was removed from the enum)`);

if (legacy.length > 0) fails.push(`${legacy.length} row(s) still carry the retired quoteStatus 'suspect': ${legacy.map(s => s.symbol).join(', ')}`);
for (const s of ruleSuspect) {
  const v = assessQuotePlausibility(s);
  if (s.moveSuspect !== true) {
    fails.push(`${s.symbol} is rule-suspect (ratio ${v.ratio?.toFixed(3)} >= ${SUSPECT_MOVE_RATIO}) but moveSuspect=${s.moveSuspect} at quoteStatus='${s.quoteStatus}' — THE FLAG IS BEING ERASED`);
  }
}
// The unavailable+suspect COMBINATION is the exact shape that shipped. Say whether
// this tape actually contained it, so a pass is never read as wider than it is.
const bothConditions = ruleSuspect.filter(s => s.quoteStatus === 'unavailable' || s.quoteStatus === 'rate_limited');

// ── LEG 2: the headline ─────────────────────────────────────────────────────────
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
let tablesGraded = 0;
console.log('');
for (const mode of ['', 'demo', 'live']) {
  const path = `/api/reports/${today}${mode ? `?mode=${mode}` : ''}`;
  let rep;
  try { rep = await get(path); } catch (e) { console.log(`${path} -> unreadable (${e.message})`); continue; }
  const movers = rep.top5Movers ?? rep.report?.top5Movers;
  if (!Array.isArray(movers) || movers.length === 0) {
    console.log(`${path} -> movers EMPTY — BLIND on this fold, NOT a pass`);
    continue;
  }
  tablesGraded++;
  console.log(`${path} -> ${movers.map(m => `${m.symbol} $${m.price} ${Number(m.changePct).toFixed(2)}%`).join(' | ')}`);
  for (const m of movers) {
    const v = assessQuotePlausibility({ price: m.price, changePct: m.changePct });
    if (v.suspect) fails.push(`${m.symbol} is in top5Movers and is fabricated on the report's OWN numbers (ratio ${v.ratio?.toFixed(2)}) — ${path}`);
  }
}
// Keep the consumer predicate exercised even when no stored table is readable, so a
// silent removal of isMoveSuspect from the ranking path cannot pass unnoticed.
if (ruleSuspect.length > 0 && !ruleSuspect.every(s => isMoveSuspect(s))) {
  fails.push('isMoveSuspect disagrees with the rule on a live row — the consumer predicate is broken');
}

// ── Verdict, with each leg's reachability stated ─────────────────────────────────
console.log(`\nreachability, flag leg     : ${ruleSuspect.length > 0
  ? `${ruleSuspect.length} rule-suspect row(s) — the erasure check had something to grade`
  : 'NO rule-suspect row on this tape — VACUOUS this run; absence proves nothing'}`);
console.log(`  ...incl. un-quoted       : ${bothConditions.length > 0
  ? `${bothConditions.length} row(s) are BOTH suspect and un-quoted — the exact shipped shape was present`
  : 'none — no row was both suspect AND un-quoted, so this run does not exercise that combination (the unit tests do)'}`);
console.log(`reachability, headline leg  : ${tablesGraded > 0
  ? `${tablesGraded} non-empty stored table(s) graded`
  : 'NO non-empty stored table on any fold — headline leg BLIND, NOT passed'}`);

if (fails.length > 0) {
  console.error(`\nFAIL:\n - ${fails.join('\n - ')}`);
  process.exit(1);
}
if (ruleSuspect.length === 0 && tablesGraded === 0) {
  console.error('\nBLIND — both legs were vacuous. HOLD the grade; this is not a pass.');
  process.exit(3);
}
console.log(`\nPASS — ${[
  ruleSuspect.length > 0 ? 'flag leg graded' : 'flag leg BLIND',
  tablesGraded > 0 ? 'headline leg graded' : 'headline leg BLIND',
].join(', ')}. No contradiction on the legs that could see anything.`);
process.exit(0);
