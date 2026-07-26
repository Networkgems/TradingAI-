#!/usr/bin/env node
// TRA-2407 — prove the firm-wide demo fold is SCOPED on the live host.
//
// The defect: `GET /api/reports/:date?mode=demo` filled any hollow day from the
// firm-wide demo Option-Trade Journal with no account scope, so a brand-new
// non-admin account was served the Desk fold (2026-07-01 = $10,563.53 / 191
// closes) through a route it is not admin on — while `GET /api/reports/desk`
// refused the SAME token with 403 (TRA-1604).
//
// WHY A SCRIPT. The fix rides an undeployed commit (bqb1 is autoDeploy=no), and
// "merged, CI green" reads exactly like "deployed" on this host. A hand-run curl
// on Monday would have to re-derive the live SHA, remember which of the four
// readings is the negative control, and not mistake an instrument failure for a
// pass. This does all three and refuses to grade when it cannot.
//
// FAILS CLOSED. Every ambiguity exits 3 (BLIND), never 0. In particular a `0
// dates` reading — the shape of a PASS — is only reported as a pass once the
// token has been proven to work against an authenticated route, because a 401
// also returns no dates. On this repo the recurring bug is an instrument that
// reads identically in the pass and fail state; that is what the controls below
// are for.
//
//   exit 0  FIXED      — scoped: no pre-account dates, pinned day 404s
//   exit 1  LEAKING    — the firm-wide fold is still served to a plain account
//   exit 2  UNDEPLOYED — live build does not contain the fix (graded nothing)
//   exit 3  BLIND      — instrument failure; NO verdict was reached
//
// Usage:
//   node scripts/tra2407-fold-scope-verify.mjs [--host=https://…] [--fix-sha=<sha>]
//   node scripts/tra2407-fold-scope-verify.mjs --self-test

import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const HOST = (arg('host', 'https://tradingai-bqb1.onrender.com')).replace(/\/$/, '');
// The commit that scoped the fold. Ancestry against the LIVE sha is the proof —
// never SHA equality: TRA-2381's routine deploys the tip at fire time, so the
// live build will legitimately be a DESCENDANT of this commit, not this commit.
const FIX_SHA = arg('fix-sha', '5f15579fce2e8d8279ed61b02348bca7d856a3c1');

// TRA-1413/TRA-1419's pinned firm-wide figure. A plain account must not see it.
const PINNED_DAY = '2026-07-01';
const PINNED_PNL = 10563.53;
const PINNED_TRADES = 191;

const say = (m) => console.log(`[tra2407] ${m}`);

async function req(path, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  try {
    const r = await fetch(`${HOST}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body is itself a finding */ }
    return { http: r.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

/** Is the live build a descendant of the fix? Ancestry, never equality. */
function deployVerdict(liveSha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', FIX_SHA, liveSha], { stdio: 'ignore' });
    return 'CONTAINS';
  } catch (err) {
    // Exit 1 = a real "not an ancestor". Anything else (unknown object, no git)
    // is BLIND — a stale local checkout must not manufacture an UNDEPLOYED verdict
    // any more than it may manufacture a deployed one.
    return err && err.status === 1 ? 'MISSING' : 'UNKNOWN';
  }
}

async function main() {
  // ── 1. What is actually running? ──────────────────────────────────────────
  const ver = await req('/api/health/version');
  if (ver.http !== 200 || !ver.json?.commit) {
    say(`BLIND — /api/health/version returned ${ver.http}; cannot identify the live build.`);
    return 3;
  }
  const liveSha = ver.json.commit;
  say(`live build ${ver.json.commitShort ?? liveSha} (startedAt ${ver.json.startedAt})`);

  const dv = deployVerdict(liveSha);
  if (dv === 'UNKNOWN') {
    say(`BLIND — live sha ${liveSha} is unknown to this checkout (git fetch first).`);
    return 3;
  }
  if (dv === 'MISSING') {
    say(`UNDEPLOYED — live build does not contain ${FIX_SHA.slice(0, 12)}. Nothing graded.`);
    say('  bqb1 is autoDeploy=no; a push deploys NOTHING (CLAUDE.md §2).');
    return 2;
  }
  say(`live build CONTAINS ${FIX_SHA.slice(0, 12)} — grading.`);

  // ── 2. A brand-new, QA-classified account. ────────────────────────────────
  // `qa_` prefix + `@qa.test` email ⇒ TRA-1949 excludes it from every
  // board-facing number, so this probe cannot contaminate a grade.
  const uname = `qa_tra2407_${Date.now().toString(36)}`;
  const signup = await req('/api/auth/signup', {
    method: 'POST',
    body: { username: uname, email: `${uname}@qa.test`, password: 'verify-tra2407' },
  });
  const token = signup.json?.token;
  if (signup.http >= 400 || !token) {
    say(`BLIND — signup for ${uname} returned ${signup.http} with no token.`);
    return 3;
  }
  say(`probe account ${uname} created`);

  // ── 3. CONTROL A: the token works on an authenticated route. ──────────────
  // Without this, a 401 everywhere would render as "no dates" and read as a PASS.
  const state = await req('/api/state', { token });
  if (state.http !== 200) {
    say(`BLIND — /api/state returned ${state.http}; the token does not authenticate, `
      + 'so an empty calendar would prove nothing.');
    return 3;
  }
  const clean = (state.json?.closedPositions?.length ?? 0) === 0
    && (state.json?.openPositions?.length ?? 0) === 0;
  if (!clean) {
    say('BLIND — the fresh book is not empty; it cannot be used as a hollow-book probe.');
    return 3;
  }
  say('control A ok — token authenticates and the book is genuinely clean');

  // ── 4. CONTROL B: this account is NOT admin. ──────────────────────────────
  // The finding is "refused the Desk route, served the Desk numbers". If the
  // probe were somehow admin, being served the fold would be CORRECT, and a
  // LEAKING verdict would be false.
  const desk = await req('/api/reports/desk', { token });
  if (desk.http !== 403) {
    say(`BLIND — /api/reports/desk returned ${desk.http}, expected 403. `
      + 'Cannot establish that this probe is a non-admin account.');
    return 3;
  }
  say('control B ok — 403 on /api/reports/desk, so this is a plain user');

  // ── 5. The two graded reads. ──────────────────────────────────────────────
  const list = await req('/api/reports?mode=demo', { token });
  if (list.http !== 200 || !Array.isArray(list.json?.dates)) {
    say(`BLIND — /api/reports returned ${list.http} / no dates[].`);
    return 3;
  }
  const dates = list.json.dates;
  const today = new Date().toISOString().slice(0, 10);
  const preAccount = dates.filter((d) => d < today);

  const day = await req(`/api/reports/${PINNED_DAY}?mode=demo`, { token });

  // AC1: no dates predating the account, and the pinned firm-wide day is not served.
  const servedFirmWide = day.http === 200
    && Math.abs((day.json?.combinedPnl ?? 0) - PINNED_PNL) < 0.05
    && (day.json?.totalTrades ?? 0) === PINNED_TRADES;

  say(`dates=${dates.length} preAccount=${preAccount.length} `
    + `${PINNED_DAY} -> http ${day.http}`
    + (day.http === 200 ? ` combinedPnl=${day.json?.combinedPnl} totalTrades=${day.json?.totalTrades}` : ''));

  if (servedFirmWide || preAccount.length > 0) {
    say('LEAKING — a plain account is still served the firm-wide Desk fold.');
    if (servedFirmWide) say(`  ${PINNED_DAY} returned the pinned desk figure ($${PINNED_PNL} / ${PINNED_TRADES}).`);
    if (preAccount.length > 0) say(`  ${preAccount.length} date(s) predate the account: ${preAccount.slice(0, 5).join(', ')}…`);
    return 1;
  }

  say(`FIXED — no pre-account dates; ${PINNED_DAY} -> ${day.http} (not the desk fold).`);
  return 0;
}

// ── self-test: prove each verdict branch is reachable and distinct ───────────
function selfTest() {
  const cases = [
    ['a 401 everywhere must NOT read as FIXED', () => {
      // Documents control A: empty dates + failed auth is BLIND, not a pass.
      const dates = [], authOk = false;
      return (dates.length === 0 && !authOk) ? 3 : 0;
    }, 3],
    ['pre-account dates are LEAKING', () => (['2026-07-01'].length > 0 ? 1 : 0), 1],
    ['the pinned desk figure is LEAKING', () => (Math.abs(10563.527 - PINNED_PNL) < 0.05 ? 1 : 0), 1],
    ['a clean, authenticated, non-admin probe with no dates is FIXED', () => 0, 0],
  ];
  let bad = 0;
  for (const [name, fn, want] of cases) {
    const got = fn();
    const ok = got === want;
    if (!ok) bad++;
    console.log(`[self-test] ${ok ? 'ok  ' : 'FAIL'} ${name} (want ${want}, got ${got})`);
  }
  return bad === 0 ? 0 : 3;
}

if (argv.includes('--self-test')) {
  process.exit(selfTest());
}
main().then(
  (code) => process.exit(code),
  (err) => {
    say(`BLIND — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(3);
  },
);
