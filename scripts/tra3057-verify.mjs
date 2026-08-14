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
//   exit 0  PROVEN     — all four legs pass
//   exit 1  NOT PROVEN — a leg was measured and FAILED
//   exit 3  BLIND      — a leg could not be READ (TRA-3722). Separate from 1 on purpose:
//                        the remedy for "the fix is not live" is a deploy, and the remedy
//                        for "I cannot tell" is `git fetch origin --unshallow`. Emitting
//                        the wrong one is how a gate gets routed around.
//
// Usage: node scripts/tra3057-verify.mjs [--host=https://...]

import { execFileSync } from 'node:child_process';
import { gradedAncestry, blindReason } from './lib/shallow-ancestry.mjs';

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

// Leg 1's ancestry decision, as a function (TRA-3722), so the shallow-graft repro can drive
// THIS FILE'S ROUTING inside a real graft rather than the shared grader alone.
//   'contains' -> leg 1 PASSes · 'absent' -> leg 1 FAILs · BLIND -> leg 1 is unreadable
function legOneState(fixSha, liveSha) {
  const { verdict, answer } = gradedAncestry(fixSha, liveSha);
  return { state: answer === true ? 'contains' : answer === false ? 'absent' : 'BLIND', verdict };
}

// `--ancestry-probe=<fixSha>:<liveSha>` — print leg 1's state and nothing else, then exit.
// Everything below does network I/O at module load, so the repro cannot import this module;
// it runs these SHIPPED BYTES as a subprocess inside a grafted clone. Printing `BLIND` there
// is the whole finding — `absent` was the false RED.
// Prints `contains|absent|BLIND <verdict>`. Exit 0 = the probe ran · 2 = bad usage.
{
  const probe = process.argv.find((a) => a.startsWith('--ancestry-probe='));
  if (probe !== undefined) {
    const [fixSha, liveSha] = probe.slice('--ancestry-probe='.length).split(':');
    if (!fixSha || !liveSha) {
      console.error('usage: --ancestry-probe=<fixSha>:<liveSha>');
      process.exit(2);
    }
    const { state, verdict } = legOneState(fixSha, liveSha);
    console.log(`${state} ${verdict}`);
    process.exit(0);
  }
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

// A leg is true (PASS), false (FAIL) or BLIND (TRA-3722 — could not be READ).
//
// BLIND had to be ADDED here; the sibling files in this sweep already had one. Before it,
// leg 1's ancestry was a bare `catch { contains = false }`, so rc 128, no git, an unknown
// object and a SHALLOW GRAFT all read as "the fix is not live" and leg 1 FAILed against a
// build that carries it. Three legs already printed the WORD "BLIND" in their detail while
// recording `ok:false` — those are upgraded to the real state, because a refusal that
// prescribes "the fix is not deployed" sends the reader to deploy something that is
// already deployed.
//
// ⚠ BLIND is a STRING and therefore TRUTHY. The tally at the bottom tests `=== true`, not
// truthiness — `legs.every(l => l.ok)` would pass every blind leg, which is the fail-open
// this ticket's sibling exists to fix. Do not "simplify" it back.
const BLIND = 'BLIND';
const legs = [];
const leg = (n, name, ok, detail) => {
  legs.push({ n, name, ok, detail });
  log(`[tra3057] LEG ${n} ${ok === true ? 'PASS' : ok === BLIND ? 'BLIND' : 'FAIL'} — ${name}`);
  if (detail) for (const d of String(detail).split('\n')) log(`[tra3057]        ${d}`);
};

log(`[tra3057] host : ${HOST}`);

// ---- Leg 1: is the fix actually running? -----------------------------------
const version = await getJson('/api/health/version');
let liveSha = null;
if (version.status !== 200 || !version.body?.commit) {
  leg(1, 'live SHA at/after f045ed5', BLIND,
    `/api/health/version unreachable or shape-less (HTTP ${version.status}). ` +
    'Refusing to grade legs 2-4 against an unknown build.');
} else {
  liveSha = version.body.commit;
  let known = true;
  try {
    git('cat-file', '-e', `${liveSha}^{commit}`);
  } catch {
    known = false;
  }
  if (!known) {
    leg(1, 'live SHA at/after f045ed5', BLIND,
      `live ${liveSha.slice(0, 8)} is UNKNOWN to this checkout — fetch, then re-run.`);
  } else {
    // TRA-3722: only the NEGATIVE is re-graded. rc 0 stands on its own — an affirmative is
    // proven by objects that are present, and a graft can only hide history, never invent it.
    const { state, verdict } = legOneState(FIX_COMMIT, liveSha);
    let behind = '(not read)';
    try {
      behind = git('rev-list', '--count', `${liveSha}..origin/main`);
    } catch {
      // On a graft `origin/main` may not even be a walkable ref. It is context, not a leg;
      // losing it must not change the verdict.
    }
    const facts = `live=${liveSha.slice(0, 8)}  fix=${FIX_COMMIT}  ancestry=${verdict}  behind origin/main=${behind}`;
    if (state === BLIND) {
      leg(1, 'live SHA at/after f045ed5', BLIND,
        `${facts}\n${blindReason(verdict)}\n` +
        'This is NOT "the fix is not live" — that verdict would prescribe deploying a commit ' +
        'that may already be deployed (TRA-3722).');
    } else {
      leg(1, 'live SHA at/after f045ed5', state === 'contains', facts);
    }
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

// `=== true`, not truthiness: BLIND is a non-empty string (see the `leg` helper).
const blindLegs = legs.filter((l) => l.ok === BLIND);
const failedLegs = legs.filter((l) => l.ok === false);
const allOk = legs.every((l) => l.ok === true);
log('');
if (blindLegs.length) {
  // BLIND outranks FAIL, the way every other gate in this repo orders it
  // (BLIND > BROKEN > CLEAN, BLIND > STRANDED > LATE). "I could not check" and
  // "I checked and it is broken" must not share an exit code, and they must not
  // share a REMEDY either: a blind leg is fixed by `git fetch origin --unshallow`,
  // a failed one by deploying.
  log(`[tra3057] BLIND — ${blindLegs.map((l) => `leg ${l.n}`).join(', ')} could not be READ. NOT PROVEN, and not a failure either.`);
  if (failedLegs.length) log(`[tra3057]         (${failedLegs.map((l) => `leg ${l.n}`).join(', ')} also FAILED — but grade the blind first.)`);
  process.exit(3);
}
log(`[tra3057] ${allOk ? 'PROVEN — all four acceptance legs pass.' : 'NOT PROVEN — ' + failedLegs.map((l) => `leg ${l.n}`).join(', ') + ' failed.'}`);
process.exit(allOk ? 0 : 1);
