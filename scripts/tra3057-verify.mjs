#!/usr/bin/env node
// TRA-3057 — post-deploy proof leg for TRA-3051.
//
// TRA-3051's whole finding is that a route can look answered while being
// unreachable: `/api/health/execution-quality` was registered TWICE, so the
// TRA-1981 KPI handler was shadowed by the TRA-2046 telemetry handler and
// "the KPI is wired" and "the KPI is unreachable" read identically from
// outside. A fix for that is not proven by a passing unit test — it is proven
// by the LIVE host returning the TRA-1981 body from the new path. Hence this
// script, and hence leg 1: measuring legs 2-4 against a stale build measures
// the OLD code and the numbers look completely ordinary (CLAUDE.md, TRA-2229).
//
// Four acceptance legs, all four must pass:
//   1. live SHA is at/after f045ed5 (the TRA-3051 fix)
//   2. GET /api/health/execution-quality-kpi  → 200, issue "TRA-1981", kpi object
//   3. GET /api/health/execution-quality      → 200, issue "TRA-2046", telemetry body
//      (the bare path must not change what it has always served)
//   4. record the observed decayRatio verbatim. Unmeasured legs read `null`,
//      never `0` (TRA-1707) — a null leg is a valid FIRST reading, not a failure.
//      This is the first time the number has ever been readable in production,
//      so it is captured, not graded.
//
// Fails closed: an unreachable host, unparseable body, or a live SHA this
// checkout does not know all exit non-zero. Never prints PROVEN on a doubt.
//
// Usage: node scripts/tra3057-verify.mjs [--host=https://...]

import { execFileSync } from 'node:child_process';

const HOST = (process.argv.find((a) => a.startsWith('--host=')) ?? '')
  .slice('--host='.length) || 'https://tradingai-bqb1.onrender.com';

// The commit that carries the TRA-3051 rename. Leg 1 is satisfied by this
// commit being an ANCESTOR of live — not by live equalling it — because this
// rides along with whatever deploy TRA-3044/TRA-3052 sequence, and that deploy
// will almost certainly carry later commits too.
const FIX_COMMIT = 'f045ed5';

const TIMEOUT_MS = 30_000;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

async function getJson(path) {
  const url = `${HOST}${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Leave body null — a non-JSON 200 is a failure, not a pass.
    }
    return { status: res.status, body, text };
  } catch (err) {
    return { status: 0, body: null, text: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const out = [];
const log = (s) => {
  out.push(s);
  console.log(s);
};

const legs = [];
const leg = (n, name, ok, detail) => {
  legs.push({ n, name, ok, detail });
  log(`[tra3057] LEG ${n} ${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (detail) for (const d of String(detail).split('\n')) log(`[tra3057]        ${d}`);
};

log(`[tra3057] host : ${HOST}`);

// ---- Leg 1: is the fix actually running? -----------------------------------
const version = await getJson('/api/health/version');
let liveSha = null;
if (version.status !== 200 || !version.body?.commit) {
  leg(1, 'live SHA at/after f045ed5', false,
    `/api/health/version unreachable or shape-less (HTTP ${version.status}). ` +
    'BLIND — refusing to grade legs 2-4 against an unknown build.');
} else {
  liveSha = version.body.commit;
  let known = true;
  try {
    git('cat-file', '-e', `${liveSha}^{commit}`);
  } catch {
    known = false;
  }
  if (!known) {
    leg(1, 'live SHA at/after f045ed5', false,
      `live ${liveSha.slice(0, 8)} is UNKNOWN to this checkout — fetch, then re-run. BLIND.`);
  } else {
    let contains = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', FIX_COMMIT, liveSha], { stdio: 'ignore' });
      contains = true;
    } catch {
      contains = false;
    }
    const behind = contains
      ? git('rev-list', '--count', `${liveSha}..origin/main`)
      : git('rev-list', '--count', `${liveSha}..origin/main`);
    leg(1, 'live SHA at/after f045ed5', contains,
      `live=${liveSha.slice(0, 8)}  fix=${FIX_COMMIT}  ancestor=${contains}  behind origin/main=${behind}`);
  }
}

// ---- Leg 2: the renamed path answers TRA-1981 ------------------------------
const kpi = await getJson('/api/health/execution-quality-kpi');
const kpiOk = kpi.status === 200
  && kpi.body?.issue === 'TRA-1981'
  && kpi.body?.kpi !== undefined
  && kpi.body?.kpi !== null;
leg(2, '/api/health/execution-quality-kpi → 200 issue TRA-1981 + kpi object', kpiOk,
  `HTTP ${kpi.status}  issue=${JSON.stringify(kpi.body?.issue)}  kpi=${kpi.body?.kpi ? 'object' : JSON.stringify(kpi.body?.kpi)}`
  + (kpi.status === 404 ? '\n404 with leg 1 PASS would be a REAL regression: the route is registered unconditionally, behind no flag.' : ''));

// ---- Leg 3: the bare path still answers TRA-2046 ---------------------------
const eq = await getJson('/api/health/execution-quality');
const eqOk = eq.status === 200
  && eq.body?.issue === 'TRA-2046'
  && eq.body?.telemetry !== undefined
  && eq.body?.telemetry !== null;
leg(3, '/api/health/execution-quality → 200 issue TRA-2046 + telemetry body (unchanged)', eqOk,
  `HTTP ${eq.status}  issue=${JSON.stringify(eq.body?.issue)}  telemetry=${eq.body?.telemetry ? 'object' : JSON.stringify(eq.body?.telemetry)}`);

// ---- Leg 4: record decayRatio verbatim -------------------------------------
// Not a grade. `null` is the expected FIRST reading for an unmeasured leg
// (TRA-1707); `0` on an unmeasured leg would be the bug. Capture, don't judge.
if (kpiOk) {
  log('[tra3057] LEG 4 — observed decayRatio (recorded, not graded):');
  const k = kpi.body.kpi;
  const rows = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if ('decayRatio' in node) rows.push([path || '(root)', node.decayRatio]);
    for (const [key, val] of Object.entries(node)) {
      if (val && typeof val === 'object') walk(val, path ? `${path}.${key}` : key);
    }
  };
  walk(k, '');
  if (rows.length === 0) {
    log('[tra3057]        no decayRatio field anywhere in the kpi object — report this verbatim.');
  }
  for (const [path, val] of rows) {
    const zeroOnUnmeasured = val === 0 ? '   <-- ZERO, not null: check TRA-1707' : '';
    log(`[tra3057]        ${path.padEnd(28)} decayRatio = ${JSON.stringify(val)}${zeroOnUnmeasured}`);
  }
  log('[tra3057]        --- full kpi body ---');
  for (const line of JSON.stringify(kpi.body, null, 2).split('\n')) log(`[tra3057]        ${line}`);
} else {
  log('[tra3057] LEG 4 SKIPPED — leg 2 did not pass, so there is no reading to record.');
}

const allOk = legs.every((l) => l.ok);
log('');
log(`[tra3057] ${allOk ? 'PROVEN — all four acceptance legs pass.' : 'NOT PROVEN — ' + legs.filter((l) => !l.ok).map((l) => `leg ${l.n}`).join(', ') + ' failed.'}`);
process.exit(allOk ? 0 : 1);
