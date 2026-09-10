#!/usr/bin/env node
/**
 * TRA-4489 — the lockout-and-recover drill the ticket owes (item 3).
 *
 * Drives the REAL auth routes of a locally-booted server against a throwaway
 * account. Nothing here touches a live host: point BASE at a server booted with
 * an isolated DATA_DIR.
 *
 *   DATA_DIR=<scratch> AUTH_SECRET=<test> PORT=3199 pnpm --filter @trading-app/server dev
 *   node scripts/tra4489-2fa-lockout-drill.mjs
 *
 * It answers three questions the ruling depends on, by execution rather than by
 * reading the source:
 *
 *   Q1  Can an account reach the fail-open state (2FA enabled, no email) WITHOUT
 *       an administrator? The ticket's premise says no.
 *   Q2  Does the fail-open actually admit — i.e. is the bypass real, not just
 *       reachable in principle?
 *   Q3  If REFUSE or RESTRICT ships, does a recovery path already exist for an
 *       account in that state, and does it survive having no email?
 *
 * Exit 0 = drill completed and every assertion held. Exit 1 = an assertion
 * failed, which means one of the premises above is wrong and the transcript
 * says which. Exit 2 = the drill could not run (server down, route missing) —
 * "could not check" must never share an exit code with "checked and it is fine".
 */

const BASE = process.env.DRILL_BASE ?? 'http://127.0.0.1:3199';
const USER = process.env.DRILL_USER ?? `drill4489-${Date.now()}`;
const EMAIL = `${USER}@drill.invalid`;
const PASSWORD = 'Drill-4489-passphrase!';

const lines = [];
let step = 0;

function say(s = '') {
  lines.push(s);
  console.log(s);
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    say(`\n!! ${method} ${path} — TRANSPORT FAILURE: ${err.message}`);
    process.exit(2);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body; keep the text */
  }
  return { status: res.status, json, text };
}

/** Redact anything that would put a live-looking secret in the transcript. */
function show(o) {
  if (o === null || o === undefined) return String(o);
  const clone = JSON.parse(JSON.stringify(o));
  for (const k of ['token', 'pendingToken']) {
    if (typeof clone[k] === 'string') clone[k] = `<${k} ${clone[k].length}ch>`;
  }
  if (Array.isArray(clone.backupCodes)) {
    clone.backupCodes = `<${clone.backupCodes.length} codes withheld>`;
  }
  return JSON.stringify(clone);
}

function record(label, r) {
  step += 1;
  say(`\n[${String(step).padStart(2, '0')}] ${label}`);
  say(`     -> ${r.status} ${show(r.json ?? r.text)}`);
}

const failures = [];
function assert(claim, ok, detail) {
  const verdict = ok ? 'HOLDS ' : 'BROKEN';
  say(`     ${verdict} :: ${claim}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(claim);
}

const run = async () => {
  say('='.repeat(78));
  say('TRA-4489 — 2FA fail-open: lockout-and-recover drill');
  say(`base=${BASE}  account=${USER}  at=${new Date().toISOString()}`);
  say('='.repeat(78));

  // ── Setup: a throwaway account WITH an email, enrolled in 2FA ──────────────
  const signup = await call('POST', '/api/auth/signup', {
    body: { username: USER, email: EMAIL, password: PASSWORD },
  });
  record('signup a throwaway account (with a real address on file)', signup);
  if (signup.status !== 200 || !signup.json?.token) {
    say('\n!! signup did not yield a session token; cannot run the drill.');
    process.exit(2);
  }
  let token = signup.json.token;

  const enable = await call('POST', '/api/auth/2fa/enable', {
    token,
    body: { password: PASSWORD },
  });
  record('enable 2FA (re-authenticated with the password)', enable);
  const backupCodes = enable.json?.backupCodes ?? [];
  assert(
    'ITEM 2a: enrolment actually ISSUES backup codes (not assumed)',
    Array.isArray(backupCodes) && backupCodes.length > 0,
    `${backupCodes.length} codes minted`,
  );

  const status0 = await call('GET', '/api/auth/2fa/status', { token });
  record('2FA status immediately after enrolment', status0);

  // Baseline: with an email on file the second factor genuinely binds.
  const loginBefore = await call('POST', '/api/auth/login', {
    body: { username: USER, password: PASSWORD },
  });
  record('CONTROL — login WITH an email on file', loginBefore);
  assert(
    'CONTROL: with an address on file the password alone does NOT mint a session',
    loginBefore.json?.twoFactorRequired === true && !loginBefore.json?.token,
    'twoFactorRequired=true, no token',
  );

  // ── Q1: can the account reach the fail-open state on its OWN authority? ────
  say('\n--- Q1: is an administrator required to reach the state? ---');
  const blank = await call('PATCH', '/api/auth/me', { token, body: { email: '' } });
  record("PATCH /api/auth/me {email:''} using the ACCOUNT'S OWN session", blank);
  assert(
    'Q1: a 2FA-enrolled user can blank its OWN email — no admin involved',
    blank.status === 200,
    `self-service, status ${blank.status}`,
  );

  const status1 = await call('GET', '/api/auth/2fa/status', { token });
  record('2FA status after the email was blanked', status1);
  assert(
    'Q1: blanking the address leaves 2FA still ENABLED (the fail-open state)',
    status1.json?.enabled === true,
    `enabled=${status1.json?.enabled}, codes=${status1.json?.backupCodesRemaining}`,
  );

  // ── Q2: does the fail-open actually admit? ────────────────────────────────
  say('\n--- Q2: does the fail-open actually admit? ---');
  const loginAfter = await call('POST', '/api/auth/login', {
    body: { username: USER, password: PASSWORD },
  });
  record('login again, now with NO email on file', loginAfter);
  assert(
    'Q2: the password ALONE now mints a full session — the bypass is real',
    !!loginAfter.json?.token && loginAfter.json?.twoFactorRequired !== true,
    'token returned, no second factor demanded',
  );

  const meCheck = await call('GET', '/api/auth/me', { token: loginAfter.json?.token });
  record('the bypassed session against a protected route', meCheck);
  assert(
    'Q2: that session is a FULL session, not a restricted one',
    meCheck.status === 200,
    'protected route accepted it',
  );

  // ── Q3: does a recovery path exist for an account in this state? ──────────
  say('\n--- Q3: if REFUSE/RESTRICT ships, can this account still get back in? ---');
  const codeReq = await call('POST', '/api/auth/login-code', { body: { username: USER } });
  record('POST /api/auth/login-code for an account with NO email', codeReq);
  assert(
    'Q3: a pendingToken is minted even with no address on file',
    typeof codeReq.json?.pendingToken === 'string' && codeReq.json.pendingToken.length > 0,
    'email-independent pendingToken',
  );

  const redeem = await call('POST', '/api/auth/2fa/verify', {
    body: { pendingToken: codeReq.json?.pendingToken, code: backupCodes[0] },
  });
  record('redeem a BACKUP CODE against that pendingToken', redeem);
  assert(
    'ITEM 2b: a backup code is REDEEMABLE today, with no email anywhere in the loop',
    !!redeem.json?.token,
    'full session recovered',
  );

  const reuse = await call('POST', '/api/auth/2fa/verify', {
    body: { pendingToken: codeReq.json?.pendingToken, code: backupCodes[0] },
  });
  record('re-submit the SAME backup code (single-use check)', reuse);
  assert(
    'Q3: a redeemed backup code is burned, not replayable',
    reuse.status === 401,
    `status ${reuse.status}`,
  );

  // ── Q3b: price the residual lockout — what if the codes are gone? ─────────
  //
  // `/api/auth/login-code` counts EVERY request as a throttle failure (5 free,
  // then exponential backoff), so a naive burn loop throttles itself part-way
  // and the follow-up redeem 400s for a missing pendingToken. A 400 and a
  // genuine "your codes are gone" 401 both yield "no token", so an assertion
  // written as `!token` PASSES on the throttle — the drill would report the
  // residual lockout as measured when it had never reached the cell. Every step
  // below therefore carries its own discriminator, and an unreached cell is
  // UNDETERMINED (exit 2), never a pass.
  say('\n--- Q3b: the residual lockout — an account with no email AND no codes ---');
  const recovered = redeem.json?.token;
  let burned = 1;
  let throttledAt = null;
  for (const c of backupCodes.slice(1)) {
    const t = await call('POST', '/api/auth/login-code', { body: { username: USER } });
    if (typeof t.json?.pendingToken !== 'string') {
      throttledAt = burned;
      say(`     login-code stopped issuing pendingTokens after ${burned} redemptions ` +
          `(status ${t.status}) — the RECOVERY PATH IS ITSELF RATE-LIMITED.`);
      break;
    }
    const r = await call('POST', '/api/auth/2fa/verify', {
      body: { pendingToken: t.json.pendingToken, code: c },
    });
    if (r.json?.token) burned += 1;
  }
  say(`\n     burned ${burned}/${backupCodes.length} backup codes`);

  const statusDrained = await call('GET', '/api/auth/2fa/status', { token: recovered });
  record('2FA status after the burn loop', statusDrained);

  const remaining = statusDrained.json?.backupCodesRemaining;
  if (remaining !== 0) {
    say(`     UNDETERMINED :: could not drive the account to zero backup codes ` +
        `(remaining=${remaining}${throttledAt !== null ? ', throttled' : ''}). ` +
        `The residual-lockout cell was NOT reached, so it is not graded. ` +
        `Re-run with AUTH_THROTTLE_FREE_ATTEMPTS / AUTH_THROTTLE_LOCKOUT_AFTER raised ` +
        `on the drill server to reach it.`);
    say(`\n${'='.repeat(78)}`);
    say('DRILL: INCOMPLETE — Q3b unreached (this is exit 2, not a pass).');
    say('='.repeat(78));
    return 2;
  }
  assert(
    'Q3b: the account can be driven to zero remaining backup codes',
    true,
    'remaining=0',
  );

  const deadRecovery = await call('POST', '/api/auth/login-code', { body: { username: USER } });
  if (typeof deadRecovery.json?.pendingToken !== 'string') {
    say(`     UNDETERMINED :: login-code refused a pendingToken (status ${deadRecovery.status}); ` +
        `cannot distinguish "codes exhausted" from "throttled". Not graded.`);
    return 2;
  }
  const deadRedeem = await call('POST', '/api/auth/2fa/verify', {
    body: { pendingToken: deadRecovery.json.pendingToken, code: backupCodes[0] },
  });
  record('attempt recovery with no email and no codes left', deadRedeem);
  assert(
    'Q3b: with no address AND no codes, the backup-code path is exhausted',
    // The discriminator: a REAL refusal of the code, not a 400 for a malformed
    // request and not a 429 for a throttle.
    deadRedeem.status === 401 && !deadRedeem.json?.token,
    `401 refusal of the code itself — this is the cell REFUSE would strand`,
  );

  // Re-adding an address is the other way out, and it needs a live session —
  // which is exactly what REFUSE would deny and RESTRICT would grant.
  const readd = await call('POST', '/api/auth/account/email', {
    token: recovered,
    body: { email: EMAIL },
  });
  record('re-attach an address using a live session (the RESTRICT escape hatch)', readd);
  assert(
    'Q3b: re-attaching an address needs an AUTHENTICATED session',
    readd.status === 200,
    'so the escape hatch exists only if the user is let in at all',
  );

  say(`\n${'='.repeat(78)}`);
  if (failures.length) {
    say(`DRILL: ${failures.length} assertion(s) BROKEN`);
    failures.forEach(f => say(`  - ${f}`));
    say('='.repeat(78));
    return 1;
  }
  say('DRILL: every assertion held.');
  say('='.repeat(78));
  return 0;
};

run()
  .then(async code => {
    const { writeFileSync } = await import('node:fs');
    if (process.env.DRILL_TRANSCRIPT) {
      writeFileSync(process.env.DRILL_TRANSCRIPT, lines.join('\n') + '\n');
    }
    process.exit(code);
  })
  .catch(err => {
    console.error(`\n!! drill aborted: ${err.stack ?? err.message}`);
    process.exit(2);
  });
