#!/usr/bin/env node
// TRA-2298 — QA RE-VERIFICATION of the prod hardening (headers + CORS allowlist).
//
// This is QADesigner's INDEPENDENT instrument. It deliberately does not import,
// call, or share code with `scripts/tra2298-verify-headers.mjs` (the CTO's
// verifier that shipped with the fix). Grading a fix with the implementer's own
// instrument tests the fix and the instrument together; if they share a wrong
// premise they agree, and the agreement reads as corroboration. The assertions
// below are re-derived from the ORIGINAL ticket text (TRA-2298) plus the
// re-verification contract QA wrote into it, not from the fix's source.
//
// USAGE:
//   node scripts/tra2298-qa-reverify.mjs [--base=https://host] [--json=out.json]
//
// EXIT: 0 PASS · 1 FAIL · 3 BLIND
//
// ── Verdict ranking: FAIL OUTRANKS BLIND ─────────────────────────────────────
// If any leg is red the verdict is FAIL even when a different leg was
// unreadable. A red leg is a fact about the world; an unreadable leg is only a
// fact about the instrument. Ranking BLIND first prints "the instrument didn't
// work" over the top of "the box is unhardened", which is the more expensive of
// the two misreadings. BLIND is reserved for a run with nothing decisive to say.

import fs from 'node:fs';

const baseArg = process.argv.find((a) => a.startsWith('--base='));
const BASE = (baseArg ? baseArg.slice('--base='.length) : 'https://tradingai-bqb1.onrender.com').replace(/\/$/, '');
const jsonArg = process.argv.find((a) => a.startsWith('--json='));
const JSON_OUT = jsonArg ? jsonArg.slice('--json='.length) : null;
const IS_TLS = BASE.startsWith('https://');

const legs = [];
let blindReasons = [];

function leg(group, name, status, detail) {
  legs.push({ group, name, status, detail });
  console.log(`[${status}] ${group} :: ${name}${detail ? ` — ${detail}` : ''}`);
}

async function probe(path, { method = 'GET', origin = undefined, acrm = null, token = null, timeoutMs = 30000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = {};
    // `origin === undefined` means SEND NO Origin HEADER AT ALL. That is a
    // distinct case from `Origin: null` (sandboxed iframe / file://) and both
    // are distinct from a non-allowlisted origin. Collapsing them is how a
    // verifier reports a pass it never tested.
    if (origin !== undefined) headers['Origin'] = origin;
    if (acrm) headers['Access-Control-Request-Method'] = acrm;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(`${BASE}${path}`, { method, headers, signal: ctl.signal, redirect: 'manual' });
    const h = {};
    for (const [k, v] of r.headers.entries()) h[k.toLowerCase()] = v;
    return { ok: true, status: r.status, h };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

// ── Expected values. Graded BY VALUE, never by presence. ─────────────────────
// A header that is present but wrong (`max-age=0`, `X-Frame-Options: ALLOWALL`)
// is the exact state a presence check calls green.
const EXPECT_EXACT = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};
const EXPECT_HSTS = 'max-age=31536000; includeSubDomains';

function gradeSecurityHeaders(group, res) {
  if (!res.ok) {
    blindReasons.push(`${group}: ${res.error}`);
    leg(group, 'reachable', 'BLIND', res.error);
    return;
  }
  for (const [name, want] of Object.entries(EXPECT_EXACT)) {
    const got = res.h[name];
    if (got === undefined) leg(group, name, 'FAIL', 'header absent');
    else if (got.trim() !== want) leg(group, name, 'FAIL', `value is "${got}", expected "${want}"`);
    else leg(group, name, 'PASS', got);
  }

  // CSP: the enforced slot must carry the clickjacking directive. The ticket
  // called `frame-ancestors` the sharpest edge, so this is the leg that matters
  // most, and it is graded on the ENFORCED header only — a directive that lives
  // in Report-Only enforces nothing.
  const csp = res.h['content-security-policy'];
  if (!csp) leg(group, 'content-security-policy (enforced)', 'FAIL', 'header absent');
  else if (!/frame-ancestors\s+'none'/.test(csp)) leg(group, 'content-security-policy (enforced)', 'FAIL', `no frame-ancestors 'none' in "${csp}"`);
  else leg(group, 'content-security-policy (enforced)', 'PASS', csp);

  const cspRo = res.h['content-security-policy-report-only'];
  if (!cspRo) leg(group, 'content-security-policy-report-only', 'FAIL', 'staged policy absent');
  else if (!/default-src\s+'self'/.test(cspRo)) leg(group, 'content-security-policy-report-only', 'FAIL', `no default-src 'self': "${cspRo}"`);
  else leg(group, 'content-security-policy-report-only', 'PASS', `${cspRo.slice(0, 60)}…`);

  // HSTS is expected ONLY over TLS. Asserting it unconditionally would demand a
  // header whose presence on http://localhost:4242 would be a YEAR-LONG,
  // user-unclearable break of every dev loop — i.e. the test would be asking
  // for the bug.
  const hsts = res.h['strict-transport-security'];
  if (IS_TLS) {
    if (!hsts) leg(group, 'strict-transport-security', 'FAIL', 'absent on a TLS response');
    else if (hsts.trim() !== EXPECT_HSTS) leg(group, 'strict-transport-security', 'FAIL', `value is "${hsts}"`);
    else leg(group, 'strict-transport-security', 'PASS', hsts);
  } else if (hsts) {
    leg(group, 'strict-transport-security', 'FAIL', 'HSTS sent over PLAIN HTTP — would force-upgrade this origin for a year');
  } else {
    leg(group, 'strict-transport-security', 'PASS', 'correctly absent over plain http');
  }

  const xpb = res.h['x-powered-by'];
  if (xpb) leg(group, 'x-powered-by absent', 'FAIL', `still advertising "${xpb}"`);
  else leg(group, 'x-powered-by absent', 'PASS', 'removed');
}

const run = async () => {
  // ── Build identity ─────────────────────────────────────────────────────────
  // Record WHICH BYTES were graded. A header grade with no build identity
  // cannot be re-attached to a commit later.
  const ver = await probe('/api/health/version');
  let liveSha = null;
  if (ver.ok) {
    const r = await fetch(`${BASE}/api/health/version`).then((x) => x.json()).catch(() => null);
    liveSha = r?.commit ?? null;
    leg('identity', 'live build', liveSha ? 'PASS' : 'BLIND', liveSha ?? 'version route unparseable');
    if (!liveSha) blindReasons.push('could not read live commit');
  } else {
    blindReasons.push(`version route: ${ver.error}`);
    leg('identity', 'live build', 'BLIND', ver.error);
  }

  // ── A. Headers on every response class, not just the happy path ────────────
  // A header stamped only on 200s is not a control: the clickjacking surface is
  // the SPA SHELL, and an error page is just as framable as a dashboard.
  gradeSecurityHeaders('A1 api-200', await probe('/api/health/version'));
  gradeSecurityHeaders('A2 spa-shell', await probe('/'));
  gradeSecurityHeaders('A3 not-found', await probe('/api/tra2298-no-such-route-qa'));
  gradeSecurityHeaders('A4 unauth-401', await probe('/api/account/settings'));

  // ── B. CORS allowlist ──────────────────────────────────────────────────────
  // `networkgems.github.io` is FIRST and is the leg that would have failed had
  // the allowlist this ticket originally proposed shipped. It is a live,
  // backend-less GitHub Pages build with wss://tradingai-bqb1 baked into its
  // shipped bundle — re-confirmed from the deployed artifact this run, not from
  // the ticket and not from the config.
  const MUST_ECHO = [
    'https://networkgems.github.io',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'http://localhost:1420',
  ];
  const MUST_NOT_ECHO = ['https://evil.example', 'null', 'https://networkgems.github.io.evil.example'];

  let saidYes = 0;
  let saidNo = 0;

  for (const o of MUST_ECHO) {
    const res = await probe('/api/health/version', { origin: o });
    if (!res.ok) { blindReasons.push(`cors ${o}: ${res.error}`); leg('B allow', o, 'BLIND', res.error); continue; }
    const acao = res.h['access-control-allow-origin'];
    if (acao === o) { saidYes++; leg('B allow', o, 'PASS', `echoed exactly`); }
    else if (acao === '*') leg('B allow', o, 'FAIL', 'still wildcard');
    else leg('B allow', o, 'FAIL', `expected echo, got ${acao === undefined ? '<none> — THIS CONSUMER IS NOW BLOCKED' : `"${acao}"`}`);
  }

  for (const o of MUST_NOT_ECHO) {
    const res = await probe('/api/health/version', { origin: o });
    if (!res.ok) { blindReasons.push(`cors ${o}: ${res.error}`); leg('B deny', o, 'BLIND', res.error); continue; }
    const acao = res.h['access-control-allow-origin'];
    if (acao === undefined) { saidNo++; leg('B deny', o, 'PASS', 'no ACAO header'); }
    else if (acao === '*') leg('B deny', o, 'FAIL', 'WILDCARD — the reported bug is still live');
    else leg('B deny', o, 'FAIL', `echoed "${acao}"`);
  }

  // The ticket's exact repro, verbatim: a preflight from an arbitrary origin.
  const pf = await probe('/api/auth/login', { method: 'OPTIONS', origin: 'https://evil.example', acrm: 'POST' });
  if (!pf.ok) { blindReasons.push(`preflight: ${pf.error}`); leg('B deny', 'preflight /api/auth/login (ticket repro)', 'BLIND', pf.error); }
  else {
    const acao = pf.h['access-control-allow-origin'];
    if (acao === undefined) { saidNo++; leg('B deny', 'preflight /api/auth/login (ticket repro)', 'PASS', `${pf.status}, no ACAO`); }
    else leg('B deny', 'preflight /api/auth/login (ticket repro)', 'FAIL', `ACAO "${acao}"`);
  }

  // A preflight from the load-bearing consumer must still be answered fully, or
  // the public app breaks on its first non-simple request.
  const pfGood = await probe('/api/auth/login', { method: 'OPTIONS', origin: 'https://networkgems.github.io', acrm: 'POST' });
  if (!pfGood.ok) { blindReasons.push(`preflight pages: ${pfGood.error}`); leg('B allow', 'preflight from pages origin', 'BLIND', pfGood.error); }
  else {
    const acao = pfGood.h['access-control-allow-origin'];
    const meth = pfGood.h['access-control-allow-methods'];
    if (acao === 'https://networkgems.github.io' && /POST/.test(meth ?? '')) { saidYes++; leg('B allow', 'preflight from pages origin', 'PASS', `${pfGood.status}, ACAO+methods`); }
    else leg('B allow', 'preflight from pages origin', 'FAIL', `ACAO=${acao} methods=${meth}`);
  }

  // No Origin at all — curl, ops scripts, tra425_full_regression.mjs. This must
  // keep working: an origin-based REJECTION would break every tool on the box.
  const noOrigin = await probe('/api/health/version', { origin: undefined });
  if (!noOrigin.ok) { blindReasons.push(`no-origin: ${noOrigin.error}`); leg('B ops', 'no Origin header still served', 'BLIND', noOrigin.error); }
  else if (noOrigin.status === 200 && noOrigin.h['access-control-allow-origin'] === undefined) leg('B ops', 'no Origin header still served', 'PASS', '200, no ACAO');
  else leg('B ops', 'no Origin header still served', noOrigin.status === 200 ? 'FAIL' : 'FAIL', `status ${noOrigin.status}, ACAO ${noOrigin.h['access-control-allow-origin']}`);

  // Vary: Origin — Cloudflare fronts this service. Without it a response cached
  // for an allowlisted origin is replayed to another, handing the `*` behaviour
  // straight back through the cache. This is part of the fix, not a nicety.
  const varyRes = await probe('/api/health/version', { origin: 'https://networkgems.github.io' });
  if (!varyRes.ok) leg('B cache', 'Vary: Origin', 'BLIND', varyRes.error);
  else {
    const vary = varyRes.h['vary'] ?? '';
    if (/\bOrigin\b/i.test(vary)) leg('B cache', 'Vary: Origin', 'PASS', vary);
    else leg('B cache', 'Vary: Origin', 'FAIL', `vary is "${vary}" — cache can replay one origin's ACAO to another`);
  }

  // ── C. Auth boundary unchanged ─────────────────────────────────────────────
  // The hardening must not have moved the thing that was already correct.
  const unauth = await probe('/api/account/settings');
  if (!unauth.ok) leg('C auth', 'unauthenticated protected route', 'BLIND', unauth.error);
  else leg('C auth', 'unauthenticated protected route', unauth.status === 401 ? 'PASS' : 'FAIL', `status ${unauth.status}`);
  const forged = await probe('/api/account/settings', { token: 'tra2298-qa-forged-bearer-not-a-real-token' });
  if (!forged.ok) leg('C auth', 'forged bearer rejected', 'BLIND', forged.error);
  else leg('C auth', 'forged bearer rejected', forged.status === 401 ? 'PASS' : 'FAIL', `status ${forged.status}`);

  // ── D. One-sidedness guard ─────────────────────────────────────────────────
  // An allowlist that only ever says NO is an outage; one that only ever says
  // YES is the original bug. A run that only observed one answer has not tested
  // an allowlist at all, and must not be allowed to print PASS.
  const oneSided = saidYes === 0 || saidNo === 0;
  if (oneSided) {
    blindReasons.push(`allowlist demonstrated only one answer (yes=${saidYes}, no=${saidNo})`);
    leg('D control', 'allowlist answered BOTH ways', 'BLIND', `yes=${saidYes} no=${saidNo} — refusing to grade`);
  } else {
    leg('D control', 'allowlist answered BOTH ways', 'PASS', `yes=${saidYes} no=${saidNo}`);
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  const fails = legs.filter((l) => l.status === 'FAIL');
  const blinds = legs.filter((l) => l.status === 'BLIND');
  const passes = legs.filter((l) => l.status === 'PASS');

  console.log(`\n── TRA-2298 QA re-verification — ${BASE}`);
  console.log(`   build: ${liveSha ?? 'UNKNOWN'}`);
  console.log(`   ${passes.length} PASS · ${fails.length} FAIL · ${blinds.length} BLIND`);

  let verdict;
  let code;
  if (fails.length > 0) {
    // FAIL outranks BLIND, deliberately. See the header.
    verdict = 'FAIL';
    code = 1;
    console.log(`\n   VERDICT: FAIL — ${fails.length} red leg(s):`);
    for (const f of fails) console.log(`     ✗ ${f.group} :: ${f.name} — ${f.detail}`);
    if (blinds.length) console.log(`   (${blinds.length} leg(s) also unreadable; the red legs stand regardless)`);
  } else if (blinds.length > 0) {
    verdict = 'BLIND';
    code = 3;
    console.log(`\n   VERDICT: BLIND — refusing to grade. Reasons:`);
    for (const b of blindReasons) console.log(`     ? ${b}`);
  } else {
    verdict = 'PASS';
    code = 0;
    console.log(`\n   VERDICT: PASS — every leg green.`);
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, liveSha, verdict, legs }, null, 2));
    console.log(`   wrote ${JSON_OUT}`);
  }
  process.exit(code);
};

run().catch((e) => {
  console.error('harness threw:', e);
  process.exit(3);
});
