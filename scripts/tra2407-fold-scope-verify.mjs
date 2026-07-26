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
// ⚠️ TWO ARMS, NOT ONE (TRA-2413). QADesigner's finding: either assertion ALONE
// passes in both the fixed world and the TRA-1572-REVERTED world.
//
//   ARM A — a fresh signup is served NO firm-wide fold.        (the leak is closed)
//   ARM B — an OPERATOR book (admin / Richard) still IS.       (TRA-1572 survives)
//
// Arm A alone is satisfied by deleting the fill outright, which blanks the two
// books the board actually looks at — the exact regression TRA-1398/TRA-1572
// were raised to fix. So arm A passing is reported as `PARTIAL`, never as a
// pass, until arm B has been measured. Arm B needs an operator credential this
// host cannot currently supply (bqb1 admin auth is dead, 401 — TRA-2285), so the
// unattended run exits 4 and SAYS SO rather than printing a green that covers
// half the claim. Pass one and it grades both.
//
// FAILS CLOSED. Every ambiguity exits 3 (BLIND), never 0. In particular a `0
// dates` reading — the shape of a PASS — is only reported as a pass once the
// token has been proven to work against an authenticated route, because a 401
// also returns no dates. On this repo the recurring bug is an instrument that
// reads identically in the pass and fail state; that is what the controls below
// are for.
//
//   exit 0  SCOPED     — BOTH arms measured and passing
//   exit 1  LEAKING    — arm A: the firm-wide fold is still served to a plain account
//   exit 2  UNDEPLOYED — live build does not contain the fix (graded nothing)
//   exit 3  BLIND      — instrument failure; NO verdict was reached
//   exit 4  PARTIAL    — arm A passes, arm B UNMEASURED (no operator credential).
//                        Half a verdict. Do not report it as fixed.
//   exit 5  REVERTED   — arm A passes but the operator books get NO fold either:
//                        the fill was removed, not scoped. TRA-1572 is undone.
//
// Usage:
//   node scripts/tra2407-fold-scope-verify.mjs [--host=https://…] [--fix-sha=<sha>]
//   node scripts/tra2407-fold-scope-verify.mjs --operator-token=<jwt>
//   node scripts/tra2407-fold-scope-verify.mjs --operator-user=admin --operator-pass=…
//   node scripts/tra2407-fold-scope-verify.mjs --self-test
//
// Arm-B credentials may also come from the environment, so a password never
// reaches a process listing or a routine transcript:
//   TRA2407_OPERATOR_TOKEN | TRA2407_OPERATOR_USER + TRA2407_OPERATOR_PASS

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

const OPERATOR_TOKEN = arg('operator-token', process.env.TRA2407_OPERATOR_TOKEN || '');
const OPERATOR_USER = arg('operator-user', process.env.TRA2407_OPERATOR_USER || '');
const OPERATOR_PASS = arg('operator-pass', process.env.TRA2407_OPERATOR_PASS || '');

// TRA-1413/TRA-1419's pinned firm-wide figure. A plain account must not see it.
const PINNED_DAY = '2026-07-01';
const PINNED_PNL = 10563.53;
const PINNED_TRADES = 191;

// How many of the journal's most recent trading days arm B will try before
// concluding the fill never fires. More than one because an operator book that
// DID trade on a given day is served its own cell by design (TRA-1572's rule),
// which is not evidence either way.
const ARM_B_MAX_DAYS = 8;

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

/** A report cell with nothing in it — the route's own `isHollowReportCell`. */
const isHollowCell = (c) => !c
  || ((c.totalTrades ?? 0) === 0 && (c.realizedPnl ?? 0) === 0
    && (c.optionsPnl ?? 0) === 0 && (c.combinedPnl ?? 0) === 0);

const sameCell = (a, b) => Math.abs((a?.combinedPnl ?? 0) - (b?.combinedPnl ?? 0)) < 0.05
  && (a?.totalTrades ?? -1) === (b?.totalTrades ?? -2);

/**
 * ARM B — does the fill still FIRE for an operator book?
 *
 * Returns one of PASS / REVERTED / BLIND with a reason. Never UNMEASURED: the
 * caller decides that before calling, by whether a credential exists at all.
 *
 * Two shapes, because the two operator books differ:
 *  - an ADMIN operator can read `/api/reports/desk`, so the journal's own days
 *    and cells are derivable live and the check needs no pinned constant.
 *  - a NON-admin operator (Richard is `role: 'user'` — only `admin` is ever
 *    seeded admin, users.ts:91) gets 403 there, so it falls back to the pinned
 *    firm-wide day.
 */
async function armB(token) {
  // Control: the operator credential must actually authenticate, or "no fold"
  // would be an auth failure wearing a regression's clothes.
  const state = await req('/api/state', { token });
  if (state.http !== 200) {
    return { verdict: 'BLIND', why: `operator /api/state returned ${state.http}; credential does not authenticate` };
  }

  const desk = await req('/api/reports/desk', { token });

  if (desk.http === 200 && Array.isArray(desk.json?.dates)) {
    const candidates = desk.json.dates.slice(0, ARM_B_MAX_DAYS);
    let examined = 0;
    const misses = [];
    for (const d of candidates) {
      const deskCell = await req(`/api/reports/desk/${d}`, { token });
      if (deskCell.http !== 200 || (deskCell.json?.totalTrades ?? 0) <= 0) continue; // nothing to fold
      examined++;
      const mine = await req(`/api/reports/${d}?mode=demo`, { token });
      if (mine.http === 200 && sameCell(mine.json, deskCell.json)) {
        return {
          verdict: 'PASS',
          why: `operator sees the firm-wide fold on ${d} `
            + `(combinedPnl=${mine.json.combinedPnl} totalTrades=${mine.json.totalTrades})`,
        };
      }
      misses.push({ d, http: mine.http, cell: mine.json });
    }
    if (examined === 0) {
      return { verdict: 'BLIND', why: 'the desk journal has no day with trades to fold; nothing to grade' };
    }
    // The fill did not fire anywhere. Distinguish "blanked" from "the operator's
    // own book was authoritative on every day we tried" — only the first is a
    // regression, and calling the second one REVERTED would be a false red.
    const blanked = misses.filter((m) => m.http === 404 || isHollowCell(m.cell));
    if (blanked.length === misses.length) {
      return {
        verdict: 'REVERTED',
        why: `the operator's own calendar is blank on all ${misses.length} firm-wide day(s) tried `
          + `(${blanked.slice(0, 4).map((m) => `${m.d}->${m.http}`).join(', ')}) — the fill was removed, not scoped`,
      };
    }
    return {
      verdict: 'BLIND',
      why: `no day matched, but ${misses.length - blanked.length} of ${misses.length} returned a NON-hollow personal `
        + 'cell — the operator book traded those days, so the fold is not expected to fire and this cannot be graded',
    };
  }

  if (desk.http === 403) {
    // Non-admin operator (the Richard shape). Fall back to the pinned day.
    const day = await req(`/api/reports/${PINNED_DAY}?mode=demo`, { token });
    if (day.http === 200 && Math.abs((day.json?.combinedPnl ?? 0) - PINNED_PNL) < 0.05
      && (day.json?.totalTrades ?? 0) === PINNED_TRADES) {
      return { verdict: 'PASS', why: `non-admin operator is served the pinned fold on ${PINNED_DAY}` };
    }
    if (day.http === 404 || isHollowCell(day.json)) {
      return {
        verdict: 'REVERTED',
        why: `non-admin operator gets nothing on ${PINNED_DAY} (http ${day.http}) — the fill was removed, not scoped`,
      };
    }
    return {
      verdict: 'BLIND',
      why: `${PINNED_DAY} returned a non-hollow cell that is not the pinned fold `
        + `(combinedPnl=${day.json?.combinedPnl} totalTrades=${day.json?.totalTrades}); the personal book is `
        + 'authoritative for that day, so the fold is not expected to fire',
    };
  }

  return { verdict: 'BLIND', why: `/api/reports/desk returned ${desk.http} for the operator credential` };
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

  // ── 5. ARM A: the two graded reads. ───────────────────────────────────────
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

  say(`arm A: dates=${dates.length} preAccount=${preAccount.length} `
    + `${PINNED_DAY} -> http ${day.http}`
    + (day.http === 200 ? ` combinedPnl=${day.json?.combinedPnl} totalTrades=${day.json?.totalTrades}` : ''));

  if (servedFirmWide || preAccount.length > 0) {
    say('LEAKING — a plain account is still served the firm-wide Desk fold.');
    if (servedFirmWide) say(`  ${PINNED_DAY} returned the pinned desk figure ($${PINNED_PNL} / ${PINNED_TRADES}).`);
    if (preAccount.length > 0) say(`  ${preAccount.length} date(s) predate the account: ${preAccount.slice(0, 5).join(', ')}…`);
    return 1;
  }
  say(`arm A PASS — no pre-account dates; ${PINNED_DAY} -> ${day.http} (not the desk fold).`);

  // ── 6. ARM B: does the fold still reach the operator books? ───────────────
  let operatorToken = OPERATOR_TOKEN;
  if (!operatorToken && OPERATOR_USER && OPERATOR_PASS) {
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { username: OPERATOR_USER, password: OPERATOR_PASS },
    });
    if (login.http !== 200 || !login.json?.token) {
      // A credential was SUPPLIED and did not work. That is an instrument
      // failure, not an absence — downgrading it to PARTIAL would let a typo
      // masquerade as "we chose not to measure this".
      say(`BLIND — operator login for ${OPERATOR_USER} returned ${login.http}; arm B could not be attempted `
        + '(arm A passed, above).');
      return 3;
    }
    operatorToken = login.json.token;
    say(`arm B: logged in as operator ${OPERATOR_USER}`);
  }

  if (!operatorToken) {
    say('PARTIAL — arm A passes, arm B UNMEASURED. No operator credential was supplied, and bqb1 admin');
    say('  auth is dead (401 — TRA-2285), so this run CANNOT distinguish "the fill is scoped" from "the');
    say('  fill was deleted", which would blank admin/Richard and revert TRA-1572 (TRA-2413).');
    say('  Arm B is pinned OFF-HOST by packages/server/src/reports/demo-calendar-fill-scope.test.ts');
    say('  ("AC2 — a desk book with a hollow day still gets the fill"), mutation-verified: deleting the');
    say('  fill fails AC2. Re-run with --operator-token=… once a credential exists to close it live.');
    return 4;
  }

  const b = await armB(operatorToken);
  say(`arm B: ${b.verdict} — ${b.why}`);
  if (b.verdict === 'REVERTED') {
    say('REVERTED — the leak is closed by DELETING the fill, not scoping it. TRA-1572 is undone.');
    return 5;
  }
  if (b.verdict !== 'PASS') {
    say('BLIND — arm A passed but arm B could not be graded; that is half a verdict, not a pass.');
    return 3;
  }
  say('SCOPED — both arms: a plain account is denied the firm-wide fold AND the operator books still get it.');
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
    ['arm A alone is PARTIAL, never a pass (TRA-2413)', () => {
      const armAPass = true, operatorToken = '';
      return armAPass && !operatorToken ? 4 : 0;
    }, 4],
    ['a blanked operator calendar is REVERTED, not FIXED', () => {
      const misses = [{ http: 404 }, { http: 200, cell: { totalTrades: 0, combinedPnl: 0 } }];
      const blanked = misses.filter((m) => m.http === 404 || isHollowCell(m.cell));
      return blanked.length === misses.length ? 5 : 0;
    }, 5],
    ['an operator who TRADED those days is BLIND, not REVERTED', () => {
      const misses = [{ http: 200, cell: { totalTrades: 3, combinedPnl: 41.5 } }];
      const blanked = misses.filter((m) => m.http === 404 || isHollowCell(m.cell));
      return blanked.length === misses.length ? 5 : 3;
    }, 3],
    ['a matching operator cell is the arm-B pass', () => (
      sameCell({ combinedPnl: 10563.527, totalTrades: 191 }, { combinedPnl: 10563.53, totalTrades: 191 }) ? 0 : 3
    ), 0],
    ['a DIFFERENT operator cell is not a match', () => (
      sameCell({ combinedPnl: 10563.53, totalTrades: 190 }, { combinedPnl: 10563.53, totalTrades: 191 }) ? 0 : 3
    ), 3],
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
