#!/usr/bin/env node
// check-csp-collector.mjs — TRA-2344 (for TRA-2321)
//
// Answers ONE question about a host: can the Report-Only CSP be graded there yet?
//
// ── The reading error this exists to make impossible ─────────────────────────
//
// TRA-2298 shipped the full candidate policy as `Content-Security-Policy-Report-Only`
// and left `frame-ancestors 'none'` enforced. Nothing collected the reports, so
// violations reached a browser console and stopped. The trap is the DIRECTION of
// that failure: a Report-Only header with no collector produces exactly the same
// observation as a perfectly clean policy — nothing. TRA-2321's promotion decision
// is "one clean RTH session of reports", and "no reports" is the input to that
// decision, so the missing instrument does not look like a missing instrument. It
// looks like a pass.
//
// TRA-2344 built the collector. That moved the trap rather than removing it: on a
// host where the collector is not DEPLOYED, `/api/health/csp-reports` 404s, and a
// grader who reads "no violations" off a 404 makes the identical mistake with more
// confidence. bqb1 has `autoDeploy=no` (TRA-1653), so merged is NOT deployed and
// nothing anywhere says so (TRA-2229).
//
// So the rule this encodes, which is the same rule TRA-2399 had to add to the AC7
// prover: EMPTY IS UNGRADED, NEVER PASSED. A zero only means "clean" once you have
// separately proven the thing that would have counted a non-zero was live, durable,
// and actually being exercised by a browser.
//
// Usage:
//   node scripts/check-csp-collector.mjs                          # localhost:4242
//   node scripts/check-csp-collector.mjs --host=https://tradingai-bqb1.onrender.com
//   node scripts/check-csp-collector.mjs --since=2026-07-27       # grade one ET day
//   node scripts/check-csp-collector.mjs --require-traffic        # see exit 4
//
// Exit codes — FAILS CLOSED:
//   0  GRADABLE     — collector is live, durable, and has counted at least one
//                     report. `violations` on this host is a real measurement.
//                     With --require-traffic this ALSO demands the window is
//                     non-empty; without it, a live+durable collector that has
//                     legitimately seen zero traffic still passes, because a
//                     browser may simply not have hit the box yet.
//   1  NOT DEPLOYED — the read route is absent (404). The build carrying TRA-2344
//                     is not on this host. Any "no violations" read here is the
//                     absence of an endpoint, not the absence of violations.
//   2  NOT WIRED    — collector answers, but the Report-Only CSP on this host does
//                     not carry `report-uri`/`report-to`, or `Reporting-Endpoints`
//                     is missing. Browsers are being told nothing, so the counters
//                     will stay at zero no matter how broken the app is.
//   3  BLIND        — a leg could not be READ: host unreachable, non-JSON payload,
//                     missing fields. NEVER a pass. "I could not check" is not
//                     "it is clean".
//   4  UNGRADED     — live and wired, but the window is EMPTY and --require-traffic
//                     was given, or the store is not durable (DATA_DIR ephemeral,
//                     so counters are since-boot and a restart silently reset them
//                     mid-session). An empty partition is ungraded, not passed.
//   5  DIRTY        — at least one violation is UNEXPLAINED against the ENFORCED
//                     policy. This is a SUCCESSFUL measurement; the offending
//                     buckets are named. (TRA-4531) Violations the live enforced
//                     header explicitly permits — the Report-Only candidate is
//                     deliberately stricter, to probe whether the wasm carve-out
//                     can be retired — and `.invalid` positive controls do NOT
//                     count: a tape of only those reads exit 0,
//                     `GRADABLE (controls/allowed only)`, every bucket classified.

import { enforcedShape, gradeBuckets, CLASS } from './lib/csp-bucket-grade.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = name => args.includes(`--${name}`);

const HOST = (arg('host', 'http://localhost:4242')).replace(/\/+$/, '');
const SINCE = arg('since', '');
const REQUIRE_TRAFFIC = has('require-traffic');
const TIMEOUT_MS = Number(arg('timeout', '15000'));

const say = msg => console.log(`[csp-collector] ${msg}`);

function done(code, verdict, lines = []) {
  say('');
  say(`VERDICT = ${verdict}  (exit ${code})`);
  for (const l of lines) say(`  ${l}`);
  process.exit(code);
}

async function get(path, accept = 'application/json') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${HOST}${path}`, { headers: { accept }, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

say(`host        : ${HOST}`);

// ── Leg 1: is the collector's read route even there? ─────────────────────────
let res;
try {
  res = await get('/api/health/csp-reports' + (SINCE ? `?since=${encodeURIComponent(SINCE)}` : ''));
} catch (err) {
  done(3, 'BLIND', [`host unreachable: ${err?.message ?? err}`, 'Not a pass. Nothing was measured.']);
}

if (res.status === 404) {
  done(1, 'NOT DEPLOYED', [
    'GET /api/health/csp-reports -> 404. The build carrying TRA-2344 is not on this host.',
    'bqb1 has autoDeploy=no (TRA-1653) — merging ships nothing. Check:',
    '  pnpm check:deploy-drift',
    'Any "no violations" read against this host right now is the absence of an',
    'ENDPOINT, not the absence of violations.',
  ]);
}
if (!res.ok) done(3, 'BLIND', [`GET /api/health/csp-reports -> HTTP ${res.status}`]);

let snap;
try {
  snap = await res.json();
} catch (err) {
  done(3, 'BLIND', [`read route did not return JSON: ${err?.message ?? err}`]);
}
if (!snap || typeof snap !== 'object' || typeof snap.violations !== 'number') {
  done(3, 'BLIND', ['read route payload is missing `violations` — wrong route, or an older build.']);
}

say(`startedAt   : ${snap.startedAt ?? '(none)'}`);
say(`lastReportAt: ${snap.lastReportAt ?? '(never)'}`);
say(`durable     : ${snap.durable}`);
say(`since       : ${snap.since ?? '(all retained days)'}`);
say(`violations  : ${snap.violations}`);

// ── Leg 2: are browsers actually being TOLD to report? ───────────────────────
//
// Graded separately from leg 1 on purpose. A collector that is live but unwired
// counts zero forever and is indistinguishable, at the read route, from a clean
// session — which is this ticket's whole failure mode wearing a different hat.
let headRes;
try {
  headRes = await get('/api/health/version', 'text/html');
} catch (err) {
  done(3, 'BLIND', [`could not read headers from this host: ${err?.message ?? err}`]);
}
const reportOnly = headRes.headers.get('content-security-policy-report-only') ?? '';
const reportingEndpoints = headRes.headers.get('reporting-endpoints') ?? '';
const enforced = headRes.headers.get('content-security-policy') ?? '';

const missing = [];
if (!reportOnly.includes('report-uri')) missing.push('CSP-Report-Only has no `report-uri`');
if (!reportOnly.includes('report-to')) missing.push('CSP-Report-Only has no `report-to`');
if (!reportingEndpoints.includes('csp-endpoint')) missing.push('no `Reporting-Endpoints: csp-endpoint=…`');
if (missing.length) {
  done(2, 'NOT WIRED', [
    ...missing,
    'Browsers are being told nothing, so these counters stay at zero however broken',
    'the app is. A zero here is not evidence.',
  ]);
}
say(`wired       : report-uri + report-to + Reporting-Endpoints present`);

// The positive control for the SIBLING risk: this checker greening must never be
// read as "the promotion happened". TRA-4429 promoted deliberately, so there are now
// exactly TWO legitimate enforced shapes; anything else is the finding.
//   - `frame-ancestors 'none'` alone: pre-4429 build, or CSP_ENFORCED_POLICY=frame-ancestors
//     (the kill switch) has been pulled.
//   - the promoted policy: default-src + the explicit `'wasm-unsafe-eval'` carve-out,
//     and NEVER a bare `'unsafe-eval'` token (which would enable eval()).
const shape = enforcedShape(enforced);
if (shape === 'none') {
  say('WARNING: no enforced CSP at all — the clickjacking fix (TRA-2298) is gone.');
} else if (shape === 'frame-ancestors-only') {
  say("enforced    : frame-ancestors only (pre-TRA-4429 build, or the CSP_ENFORCED_POLICY kill switch is pulled)");
} else if (shape === 'promoted') {
  say('enforced    : TRA-4429 promoted policy');
} else {
  say(`WARNING: enforced CSP matches neither sanctioned shape — it is: ${enforced}`);
  say('WARNING: that is an unreviewed widening/narrowing; compare with TRA-4429 before trusting this box.');
}

// ── Leg 3: is the window gradable, and what does it say? ─────────────────────
if (snap.durable === false) {
  done(4, 'UNGRADED', [
    'The collector is live and wired, but its store is NOT durable (DATA_DIR is',
    'ephemeral). Counters are since-boot, so a restart mid-session silently resets',
    'them and the survivors read as a clean session. Fix DATA_DIR before grading.',
  ]);
}

const totals = snap.totals ?? {};
if (totals.droppedRateLimited > 0) {
  say(`NOTE: ${totals.droppedRateLimited} request(s) refused by the rate cap — reports were dropped.`);
}
if (totals.overflowed > 0) {
  say(`NOTE: ${totals.overflowed} violation(s) landed in the overflow bucket (cardinality cap).`);
}

if (snap.violations === 0) {
  const empty = [
    'Zero violations in the window.',
    `Requests received by the collector: ${totals.requestsReceived ?? 'unknown'}.`,
  ];
  if (REQUIRE_TRAFFIC) {
    done(4, 'UNGRADED', [
      ...empty,
      'An EMPTY window is UNGRADED, never PASSED (the TRA-2399 rule). Nothing has',
      'exercised the policy yet, so nothing has been measured. Load the app in a',
      'browser across a real RTH session, then re-run.',
    ]);
  }
  done(0, 'GRADABLE (clean so far)', [
    ...empty,
    'The instrument is live, wired and durable, so this zero is a real reading —',
    'but only over whatever traffic has actually hit the box. Re-run with',
    '--require-traffic to refuse a window nothing exercised.',
  ]);
}

// ── Violations: grade every bucket against the ENFORCED policy (TRA-4531) ────
//
// Not against the Report-Only candidate: that header is deliberately stricter than
// the enforced one (no wasm carve-out, TRA-4429), so it files a fresh report on
// every wasm page load and a raw count would read DIRTY forever. Only UNEXPLAINED
// buckets go non-zero; the judgement lives in scripts/lib/csp-bucket-grade.mjs.
const graded = gradeBuckets({ violations: snap.violations, buckets: snap.buckets, enforced });
const TAG = { [CLASS.ALLOWED]: 'ALLOWED    ', [CLASS.CONTROL]: 'CONTROL    ', [CLASS.UNEXPLAINED]: 'UNEXPLAINED' };
say('');
say('violations by (day, directive, blocked-origin), graded against the ENFORCED policy:');
for (const r of graded.rows.slice(0, 25)) {
  const b = r.bucket;
  say(`  ${TAG[r.class]} ${String(b.count).padStart(6)}  ${b.day}  ${b.directive} <- ${b.blockedUri}  (${r.reason})`);
}
if (graded.rows.length > 25) {
  const hidden = graded.rows.slice(25).filter(r => r.class === CLASS.UNEXPLAINED).length;
  say(`  … and ${graded.rows.length - 25} more bucket(s), ${hidden} of them unexplained`);
}

done(graded.exitCode, graded.verdict, graded.lines);
