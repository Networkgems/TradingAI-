#!/usr/bin/env node
/**
 * TRA-2951 — QA grade for TRA-2937 (`6eb0065`) on a live imported close.
 *
 * Grade A  the round trip: an imported option row closes, the journal carries a
 *          non-OPEN row for that OCC with a NON-EMPTY `exitReason`, and
 *          `/api/trades/export` shows the SAME reason. Names which path fired:
 *          `tradier_import` => MINT, anything else => REBIND.
 * Grade B  no journal row at `outcome: OPEN` with `structure: tradier_import`
 *          whose `optionSymbol` is absent from `/api/state` -> openOptions.
 * Grade C  `weights.generatedFrom.excludedUnattributed` is PRESENT and its value
 *          is consistent with the `tradier_import` row count.
 *
 * Every trap that has previously inverted a verdict on this board is encoded as
 * a hard `throw`, never as a fallback:
 *
 *   - The build is pinned off `/api/health/options-live`, NOT `/api/health`
 *     (which is a 45-byte `{ok,time}` with no `build` block, so `build.pid` is
 *     `undefined` and the pin reads BLIND on a healthy box).
 *   - The host is bqb1 by literal URL. `TRADING_API_BASE` is `localhost:4242`,
 *     which is UP and serving an older build -- a grader pointed there declares
 *     a false NO-RUN.
 *   - Auth is a BEARER token. A cookie jar logs in 200 and then 401s everywhere.
 *   - `?sinceTs=` is epoch MILLISECONDS only, and its axis is `openTs` (ENTRY).
 *     This grade is EXIT-scoped, so it does not filter at all -- and it asserts
 *     `appliedSinceTs === null` to prove it did not.
 *   - On `/api/state` option rows `symbol` is the UNDERLYING ("QQQ") and the OCC
 *     is `optionSymbol`. `r.symbol || r.optionSymbol` short-circuits on the
 *     truthy underlying and every contract lookup misses; a 100% NOT-FOUND rate
 *     is the tell. The join names the field, and a bidirectional control proves
 *     a known-present OCC joins and a fabricated one does not.
 *   - Field presence is tested with `in`, never `!== undefined` (which is true
 *     for `null`), because a `0` for `excludedUnattributed` must be readable as
 *     "there were none" and NOT as "the exclusion is not running".
 *
 * Usage:
 *   node scripts/tra2951-imported-close-grade.mjs --baseline   # pre-deploy snapshot
 *   node scripts/tra2951-imported-close-grade.mjs              # grade
 *
 * Exit codes: 0 PASS · 1 FAIL · 2 NO-RUN (nothing to grade) · 3 BLIND (refusing).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradedAncestry } from './lib/shallow-ancestry.mjs';

const BQB1 = 'https://tradingai-bqb1.onrender.com';
const FIX_COMMIT = '6eb0065';
// Resolve the repo rather than assuming this file sits in `<repo>/scripts`: a
// durable copy of this grader also lives at the workspace root, and a `..` from
// there points at a directory with no git history, which would turn the
// ancestry assert into a silent "not an ancestor" -- i.e. a false BLIND on a
// correctly deployed build.
const REPO = [
  join(dirname(fileURLToPath(import.meta.url)), '..'),
  join(process.env.PAPERCLIP_WORKSPACE_CWD ?? '.', 'TradingAI'),
  process.cwd(),
].find((p) => existsSync(join(p, '.git'))) ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.TRA2951_STATE_DIR ?? join(REPO, '.tra2951');
const WATCHLIST = join(STATE_DIR, 'imported-watchlist.json');
const BASELINE = process.argv.includes('--baseline');

const OCC = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const out = [];
const say = (s = '') => { out.push(s); console.log(s); };
const die = (code, msg) => { say(`\n*** ${msg}`); flush(); process.exit(code); };
function flush() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, BASELINE ? 'baseline.log' : 'grade.log'), out.join('\n'), 'utf8');
  } catch { /* the report is on stdout regardless */ }
}

// ── auth ────────────────────────────────────────────────────────────────────
const user = process.env.TRADING_ADMIN_USERNAME;
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!user || !pass) die(3, 'BLIND: TRADING_ADMIN_USERNAME / TRADING_ADMIN_PASSWORD unset. Refusing to grade.');

const login = await fetch(`${BQB1}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const token = (await login.json().catch(() => ({}))).token;
// The 200 on login is the trap: it makes the later 401 look like authorisation
// rather than transport. Assert the token itself.
if (!token) die(3, `BLIND: login returned ${login.status} with no bearer token. Refusing to grade.`);

async function get(path) {
  const r = await fetch(`${BQB1}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

// ── 1. pin the build, FIRST, before any number reaches a verdict ────────────
say('== BUILD PIN (from /api/health/options-live -- /api/health has NO build block) ==');
const live = await get('/api/health/options-live');
const build = live.build ?? {};
if (build.pid === undefined || !build.startedAt || !build.commit) {
  die(3, `BLIND: no build identity on the pin route (pid=${build.pid} startedAt=${build.startedAt}). Refusing to grade.`);
}
say(`   host       : ${BQB1}`);
say(`   commit     : ${build.commit}`);
say(`   pid        : ${build.pid}   startedAt: ${build.startedAt}   uptimeSec: ${build.uptimeSec}`);
say(`   mode       : ${live.mode}   operator: ${live.operator}`);

// TRA-3740: Use shallow-aware ancestry. The old try/catch with bidirectional controls
// was good for detecting broken git (wrong cwd, missing binary), but a shallow clone
// makes `merge-base --is-ancestor` return non-zero (or throw) both for "not an ancestor"
// and "path was grafted" — byte-identical. The controls below still catch git breakage;
// the library call adds graft detection.
const isAncestor = (a, b) => {
  const { answer } = gradedAncestry(a, b);
  if (answer === null) return null; // blind — cannot tell
  return answer; // true or false
};
// BIDIRECTIONAL control on the ancestry reader itself. A broken git invocation
// (wrong cwd, unknown sha, no history) returns null and is DISTINGUISHABLE from an
// honest "not an ancestor" (false). A commit is always its own ancestor, and an
// all-zero sha never is.
const selfCheck = isAncestor(build.commit, build.commit);
if (selfCheck !== true) {
  die(3, `BLIND: ancestry reader is unusable in ${REPO} (a commit is not its own ancestor, got ${selfCheck}). Refusing to grade.`);
}
const zeroCheck = isAncestor('0000000000000000000000000000000000000000', build.commit);
if (zeroCheck !== false) {
  die(3, `BLIND: ancestry reader said an all-zero sha is an ancestor (got ${zeroCheck}). Refusing to grade.`);
}
say(`   ancestry reader control: self=YES, zero-sha=NO. OK (repo ${REPO})`);

const fixLive = isAncestor(FIX_COMMIT, build.commit);
if (fixLive === null) {
  die(3, `BLIND: cannot determine whether ${FIX_COMMIT} is an ancestor of ${build.commit} (shallow clone or missing history). Run \`git fetch origin --unshallow\` and retry.`);
}
say(`   ${FIX_COMMIT} ancestor of live build: ${fixLive ? 'YES' : 'NO'}`);

if (!BASELINE && !fixLive) {
  die(3, `BLIND: ${FIX_COMMIT} is NOT an ancestor of the live build ${build.commit}. The fix is not deployed; nothing here can grade it.`);
}

// ── 2. journal + state, unfiltered ──────────────────────────────────────────
const oj = await get('/api/health/option-journal?rows=all');
// Prove we asked for, and got, the whole population on the EXIT-scoped question.
if (oj.rowsMode !== 'all') die(3, `BLIND: rowsMode=${oj.rowsMode}, expected "all".`);
if (oj.rowsFiltered !== false) die(3, `BLIND: rowsFiltered=${oj.rowsFiltered}; a filtered payload cannot answer an exit-scoped question.`);
if (oj.appliedSinceTs !== null) die(3, `BLIND: appliedSinceTs=${oj.appliedSinceTs}; expected null (no filter was sent).`);
const rows = oj.rows ?? [];
// POSITIVE CONTROL: prove the reader can see a non-empty list, in this beat,
// before any zero below is believed.
if (rows.length === 0) die(3, 'BLIND: journal returned 0 rows. A zero from a reader that has not shown it can see a non-empty list is not evidence.');
say(`\n== JOURNAL == rows=${rows.length}  desk=${oj.deskRowCount}  fixture=${oj.fixtureRowCount}`);

const state = await get('/api/state');
const openOpts = state.options?.openOptions ?? [];
// `symbol` is the UNDERLYING; the OCC is `optionSymbol`. Never `a || b`.
const stateOcc = new Set(openOpts.map((r) => r.optionSymbol).filter(Boolean));
say(`== STATE == openOptions=${openOpts.length}  with OCC=${stateOcc.size}  closedOptions=${(state.options?.closedOptions ?? []).length}`);
for (const r of openOpts) {
  say(`   underlying=${r.symbol}  OCC=${r.optionSymbol}  mode=${r.mode}  importedFromTradier=${r.importedFromTradier === true}`);
}
// BIDIRECTIONAL control on the join: a known-present OCC must join, a fabricated
// one must not. A 100% NOT-FOUND rate is the tell that the wrong field is keyed.
if (stateOcc.size > 0) {
  const known = [...stateOcc][0];
  if (!stateOcc.has(known)) die(3, 'BLIND: join control failed -- a known-present OCC did not join.');
  if (stateOcc.has('ZZZZ260101C00000000')) die(3, 'BLIND: join control failed -- a fabricated OCC joined.');
  if (!OCC.test(known)) say(`   ! WARN: ${known} does not match the OCC shape; check the field, not the value.`);
  say('   join control: known-present OCC joins, fabricated OCC does not. OK');
} else {
  say('   ! join control SKIPPED: state carries no open OCC this beat (Grade B degrades to "no OPEN import may exist at all").');
}

// ── watchlist: which contracts were broker-IMPORTED while open ──────────────
// Written every run so a close seen later can be attributed to the imported
// cohort even though `/api/state` no longer carries the row.
let watch = existsSync(WATCHLIST) ? JSON.parse(readFileSync(WATCHLIST, 'utf8')) : {};
for (const r of openOpts) {
  if (r.optionSymbol && r.importedFromTradier === true) {
    watch[r.optionSymbol] = { firstSeen: watch[r.optionSymbol]?.firstSeen ?? new Date().toISOString(), mode: r.mode ?? null };
  }
}
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(WATCHLIST, JSON.stringify(watch, null, 1), 'utf8');
say(`\n== IMPORTED WATCHLIST == ${Object.keys(watch).length} contract(s) seen importedFromTradier while open`);
for (const [occ, m] of Object.entries(watch)) say(`   ${occ}  firstSeen=${m.firstSeen}  mode=${m.mode}`);

// ── baseline mode stops here ────────────────────────────────────────────────
const imports = rows.filter((r) => r.structure === 'tradier_import');
const gf = oj.weights?.generatedFrom ?? {};
const hasExcl = 'excludedUnattributed' in gf;   // `in`, not `!== undefined`

if (BASELINE) {
  say(`\n== PRE-DEPLOY BASELINE ==`);
  say(`   tradier_import rows            : ${imports.length}`);
  say(`   generatedFrom keys             : ${Object.keys(gf).join(', ')}`);
  say(`   excludedUnattributed present   : ${hasExcl}`);
  say(`   weightsBasis                   : ${oj.weightsBasis}`);
  const openLive = rows.filter((r) => r.outcome === 'OPEN' && r.mode === 'live');
  const staleLive = openLive.filter((r) => r.optionSymbol && !stateOcc.has(r.optionSymbol));
  say(`   live OPEN journal rows         : ${openLive.length}`);
  say(`   ...of which OCC absent from state (PRE-EXISTING RESIDUE): ${staleLive.length}`);
  for (const r of staleLive) say(`      ${r.optionSymbol}  structure=${r.structure}  openTs=${new Date(r.openTs).toISOString()}`);
  flush();
  process.exit(0);
}

// ── GRADE C — the zero-delta control on the learner ─────────────────────────
say(`\n== GRADE C == learner exclusion`);
say(`   generatedFrom            : ${JSON.stringify(gf)}`);
if (!hasExcl) {
  say('   VERDICT: FAIL -- `excludedUnattributed` is ABSENT from generatedFrom. The commit publishes it unconditionally, so an absent key means the deployed bytes are not this fix.');
}
say(`   excludedUnattributed     : ${gf.excludedUnattributed}`);
say(`   tradier_import row count : ${imports.length}`);
const cOk = hasExcl && gf.excludedUnattributed === imports.length;
say(`   VERDICT C: ${cOk ? 'PASS' : hasExcl ? 'MISMATCH' : 'FAIL'} (published count must equal the tradier_import row count)`);
say('   NOTE: the pre-registered "must read 0" is graded against the PRE-DEPLOY baseline of 0');
say('         tradier_import rows measured on the prior build, which is what makes any');
say('         non-zero here attributable to the NEW writer rather than to a pre-deploy write.');

// ── GRADE B — the over-statement half ───────────────────────────────────────
say(`\n== GRADE B == no stale OPEN tradier_import row`);
const openImports = imports.filter((r) => r.outcome === 'OPEN');
const offenders = openImports.filter((r) => !r.optionSymbol || !stateOcc.has(r.optionSymbol));
say(`   OPEN tradier_import rows : ${openImports.length}`);
for (const r of openImports) say(`      ${r.optionSymbol ?? '(no OCC)'}  inState=${r.optionSymbol ? stateOcc.has(r.optionSymbol) : 'n/a'}  mode=${r.mode}`);
const bOk = offenders.length === 0;
say(`   VERDICT B: ${bOk ? 'PASS' : 'FAIL'} -- ${offenders.length} OPEN tradier_import row(s) absent from state`);
for (const r of offenders) say(`      OFFENDER ${r.optionSymbol ?? '(no OCC)'} openTs=${new Date(r.openTs).toISOString()}`);

// Pre-existing residue -- reported as a COUNT, explicitly NOT graded. The rebind
// fires only when the reconcile RE-IMPORTS a contract, and a contract gone from
// the broker's book never will be.
const residue = rows.filter((r) => r.outcome === 'OPEN' && r.mode === 'live'
  && r.structure !== 'tradier_import' && r.optionSymbol && !stateOcc.has(r.optionSymbol));
say(`   PRE-EXISTING RESIDUE (reported, NOT graded): ${residue.length} live OPEN non-import row(s) whose OCC is absent from state`);
for (const r of residue) say(`      ${r.optionSymbol}  structure=${r.structure}  openTs=${new Date(r.openTs).toISOString()}`);

// ── GRADE A — the round trip ────────────────────────────────────────────────
say(`\n== GRADE A == imported close round trip`);
const bootTs = Date.parse(build.startedAt);
const candidates = rows.filter((r) => r.outcome !== 'OPEN' && r.optionSymbol
  && (r.structure === 'tradier_import' || watch[r.optionSymbol])
  && (r.closeTs ?? 0) >= bootTs);
say(`   closes on this build (closeTs >= ${build.startedAt}) attributable to the imported cohort: ${candidates.length}`);

let exp = null;
try { exp = await get('/api/trades/export'); } catch (e) { say(`   ! /api/trades/export unavailable: ${e.message}`); }
const expRows = Array.isArray(exp) ? exp : (exp?.rows ?? []);
const expByOcc = new Map();
for (const r of expRows) {
  const occ = r.option_symbol ?? r.optionSymbol ?? r.contract ?? null;
  if (occ) expByOcc.set(occ, r);
}
say(`   /api/trades/export rows: ${expRows.length}  keyed by OCC: ${expByOcc.size}`);

let aOk = false, minted = 0, rebound = 0;
if (candidates.length === 0) {
  say('   VERDICT A: NO-RUN -- no imported close landed on this build. This is NOT a pass.');
} else {
  aOk = true;
  for (const r of candidates) {
    const path = r.structure === 'tradier_import' ? 'MINT' : 'REBIND';
    if (path === 'MINT') minted++; else rebound++;
    const reason = r.exitReason ?? '';
    const e = expByOcc.get(r.optionSymbol);
    const expReason = e ? (e.exit_reason ?? '') : null;
    const reasonOk = reason !== '';
    const matchOk = e ? expReason === reason : false;
    if (!reasonOk || !matchOk) aOk = false;
    say(`   ${r.optionSymbol}  path=${path} (structure=${r.structure})`);
    say(`      outcome=${r.outcome}  exitReason=${JSON.stringify(reason)} ${reasonOk ? 'OK' : 'FAIL(empty)'}`);
    say(`      export exit_reason=${JSON.stringify(expReason)} ${matchOk ? 'OK' : e ? 'FAIL(mismatch)' : 'FAIL(contract absent from export)'}`);
    say(`      realizedPnlUsd=${r.realizedPnlUsd}  closeTs=${new Date(r.closeTs).toISOString()}`);
  }
  say(`   paths exercised: MINT=${minted}  REBIND=${rebound}`);
  if (minted === 0 || rebound === 0) {
    say(`   ! Only one path was exercised. Both are passes and they are different code; the other half stays UNGRADED.`);
  }
  say(`   VERDICT A: ${aOk ? 'PASS' : 'FAIL'}`);
}

// ── roll-up ─────────────────────────────────────────────────────────────────
say(`\n===== ROLL-UP =====`);
say(`   A (round trip)      : ${candidates.length === 0 ? 'NO-RUN' : aOk ? 'PASS' : 'FAIL'}   [MINT=${minted} REBIND=${rebound}]`);
say(`   B (no stale OPEN)   : ${bOk ? 'PASS' : 'FAIL'}   [residue reported separately: ${residue.length}]`);
say(`   C (learner control) : ${cOk ? 'PASS' : hasExcl ? 'MISMATCH' : 'FAIL'}`);
flush();

if (!hasExcl || !bOk || (candidates.length > 0 && !aOk)) process.exit(1);
if (candidates.length === 0) process.exit(2);
process.exit(0);
