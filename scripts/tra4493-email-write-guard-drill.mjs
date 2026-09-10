#!/usr/bin/env node
/**
 * TRA-4493 — the email-write guard, measured by EXECUTION.
 *
 * `email-grammar.test.ts` proves two things and disclaims a third. It proves the
 * grammar answers correctly, and it proves — by source ORDER — that each route
 * consults it before it writes. It does NOT prove the guard runs, and an
 * unrouted guard is precisely the bug this repo keeps re-filing. That claim
 * needs a booted server, and this is it.
 *
 *   cd packages/server
 *   DATA_DIR=/tmp/drill4493 AUTH_SECRET=drill PORT=3198 NODE_ENV=development \
 *     ADMIN_PASSWORD=Drill-4493-admin! \
 *     AUTH_THROTTLE_FREE_ATTEMPTS=5000 AUTH_THROTTLE_LOCKOUT_AFTER=100000 \
 *     node --import tsx/esm src/index.ts &
 *   node scripts/tra4493-email-write-guard-drill.mjs
 *
 * Nothing here touches a live host: isolated DATA_DIR, private port, no broker
 * credentials.
 *
 * Exit 0 = every assertion held.
 * Exit 1 = an assertion BROKE — the transcript names which.
 * Exit 2 = the drill could not run, or a cell was never reached. "Could not
 *          check" must never share an exit code with "checked and it is fine";
 *          that distinction is the correction TRA-4489's drill had to make to
 *          its own instrument, and it is not re-learned here.
 *
 * ── What it asserts, and why each half is needed ─────────────────────────────
 *
 *   A  THE TRIGGER IS CLOSED. Every one of the five email-WRITE routes refuses a
 *      blank and a malformed address. `PATCH /api/auth/me {email:''}` on the
 *      account's own session — the exact call in TRA-4489's drill step 05 — is
 *      the headline; it returned 200 before this ticket.
 *
 *   B  THE CHAIN IS UNREACHABLE. After the refusal, 2FA still binds at the next
 *      login. This is the half that matters: A could hold while the account was
 *      degraded by some other path, and the source scan cannot see that.
 *
 *   C  POSITIVE CONTROL — a real address is still accepted, and is stored
 *      TRIMMED. A grammar that refuses real addresses is a lockout, which is a
 *      worse outage than the defect. Without C, an `acceptEmail` hard-wired to
 *      `{ok:false}` would score a perfect A and B.
 */

const BASE = process.env.DRILL_BASE ?? 'http://127.0.0.1:3198';
const STAMP = Date.now();
const USER = process.env.DRILL_USER ?? `drill4493-${STAMP}`;
const EMAIL = `${USER}@drill.invalid`;
const PASSWORD = 'Drill-4493-passphrase!';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Drill-4493-admin!';

/** Blank in every spelling a JSON body can carry it. */
const BLANKS = ['', ' ', '\t', '   \n  '];
/** Non-empty and unreachable by mail — the quieter half of the defect. */
const MALFORMED = ['nope', 'not-an-address', '@drill.invalid', 'user@', 'user@localhost', 'a b@drill.invalid'];

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

function show(o) {
  if (o === null || o === undefined) return String(o);
  const clone = JSON.parse(JSON.stringify(o));
  for (const k of ['token', 'pendingToken']) {
    if (typeof clone[k] === 'string') clone[k] = `<${k} ${clone[k].length}ch>`;
  }
  if (Array.isArray(clone.backupCodes)) clone.backupCodes = `<${clone.backupCodes.length} codes withheld>`;
  return JSON.stringify(clone);
}

function record(label, r) {
  step += 1;
  say(`\n[${String(step).padStart(2, '0')}] ${label}`);
  say(`     -> ${r.status} ${show(r.json ?? r.text)}`);
}

const failures = [];
function assert(claim, ok, detail) {
  say(`     ${ok ? 'HOLDS ' : 'BROKEN'} :: ${claim}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(claim);
}

/** An unreached cell is exit 2, never a pass. */
function undetermined(claim, why) {
  say(`     UNDETERMINED :: ${claim} (${why})`);
  say('\n!! a cell was never reached; the drill cannot grade it.');
  process.exit(2);
}

const run = async () => {
  say('='.repeat(78));
  say('TRA-4493 — account-email write guard: does it actually run?');
  say(`base=${BASE}  account=${USER}  at=${new Date().toISOString()}`);
  say('='.repeat(78));

  // ── Setup ──────────────────────────────────────────────────────────────────
  const signup = await call('POST', '/api/auth/signup', {
    body: { username: USER, email: EMAIL, password: PASSWORD },
  });
  record('signup a throwaway account (with a real address on file)', signup);
  if (signup.status !== 200 || !signup.json?.token) {
    say('\n!! signup did not yield a session token; cannot run the drill.');
    process.exit(2);
  }
  const token = signup.json.token;

  const adminLogin = await call('POST', '/api/auth/login', {
    body: { username: 'admin', password: ADMIN_PASSWORD },
  });
  record('login as the seeded admin (for the two admin write routes)', adminLogin);
  const adminToken = adminLogin.json?.token;
  if (!adminToken) {
    undetermined(
      'the two ADMIN email-write routes are guarded',
      'no admin session — boot the server with ADMIN_PASSWORD, or pass it to this drill',
    );
  }

  const enable = await call('POST', '/api/auth/2fa/enable', { token, body: { password: PASSWORD } });
  record('enrol the account in email 2FA', enable);
  if (enable.status !== 200) {
    say('\n!! could not enrol in 2FA; the headline assertion would be vacuous.');
    process.exit(2);
  }

  const loginBefore = await call('POST', '/api/auth/login', { body: { username: USER, password: PASSWORD } });
  record('CONTROL — login with an address on file: the second factor binds', loginBefore);
  assert(
    'CONTROL: 2FA is genuinely armed before the drill starts',
    loginBefore.json?.twoFactorRequired === true && !loginBefore.json?.token,
    'twoFactorRequired=true, no token',
  );

  // ── A: the trigger ─────────────────────────────────────────────────────────
  say('\n--- A: is the trigger closed on every email-WRITE route? ---');

  // A1 — the headline. TRA-4489 drill step 05 made this exact call and got 200.
  const blank = await call('PATCH', '/api/auth/me', { token, body: { email: '' } });
  record("PATCH /api/auth/me {email:''} on the account's OWN session (was 200)", blank);
  assert(
    "A1: a 2FA-enrolled account can no longer blank its own address",
    blank.status === 409,
    `status ${blank.status} — 409 names the second factor it would have disarmed`,
  );
  assert(
    'A1: and the refusal SAYS what it protected, rather than "email is required"',
    /two-factor/i.test(blank.json?.error ?? ''),
    JSON.stringify(blank.json?.error ?? blank.text),
  );

  for (const value of BLANKS.slice(1)) {
    const r = await call('PATCH', '/api/auth/me', { token, body: { email: value } });
    assert(
      `A1: whitespace-only ${JSON.stringify(value)} is refused too (trim, not a === '' check)`,
      r.status === 409,
      `status ${r.status}`,
    );
  }

  // A2 — the quieter half.
  for (const value of MALFORMED) {
    const r = await call('PATCH', '/api/auth/me', { token, body: { email: value } });
    assert(
      `A2: PATCH /api/auth/me refuses ${JSON.stringify(value)} — 2FA stays armed, OTPs would go nowhere`,
      r.status === 400,
      `status ${r.status}`,
    );
  }

  // A3 — the account is UNCHANGED after every refusal. A 400 written after the
  // row was persisted reads identical to a refusal from the status line alone.
  const meAfter = await call('GET', '/api/auth/me', { token });
  record('the account after every refused write', meAfter);
  assert(
    'A3: the address on file is untouched — the refusals refused, they did not just report',
    meAfter.json?.email === EMAIL,
    `email=${JSON.stringify(meAfter.json?.email)}`,
  );

  // A4 — the same write reached with an ADMIN token. `requireAdmin` narrows WHO
  // can fire it, not what it does.
  const adminBlank = await call('PATCH', `/api/admin/users/${encodeURIComponent(USER)}`, {
    token: adminToken,
    body: { email: '' },
  });
  record(`PATCH /api/admin/users/${USER} {email:''} with an ADMIN session`, adminBlank);
  assert(
    'A4: an admin cannot blank a 2FA account\'s address either',
    adminBlank.status === 409,
    `status ${adminBlank.status}`,
  );
  const adminBad = await call('PATCH', `/api/admin/users/${encodeURIComponent(USER)}`, {
    token: adminToken,
    body: { email: 'nope' },
  });
  record('the same route with a malformed address', adminBad);
  assert('A4: and it refuses a malformed one', adminBad.status === 400, `status ${adminBad.status}`);

  // A5 — the admin email limb stays OPTIONAL. Grading an absent field would 400
  // every PATCH that is not editing the address, which is an outage dressed as a
  // fix. (The rename limb itself is 409-disabled by TRA-4475/audit H3, so an
  // omitted-email PATCH that changes nothing must still succeed.)
  const adminNoEmail = await call('PATCH', `/api/admin/users/${encodeURIComponent(USER)}`, {
    token: adminToken,
    body: {},
  });
  record('PATCH /api/admin/users/<user> with NO email field at all', adminNoEmail);
  assert(
    'A5: an omitted email field is "not editing the address", not a 400',
    adminNoEmail.status === 200,
    `status ${adminNoEmail.status}`,
  );

  // A6 — the two CREATE routes and the add-address route.
  const badSignup = await call('POST', '/api/auth/signup', {
    body: { username: `drill4493x-${STAMP}`, email: '', password: PASSWORD },
  });
  record("POST /api/auth/signup {email:''}", badSignup);
  assert('A6: signup refuses a blank address', badSignup.status === 400, `status ${badSignup.status}`);

  const badAdminCreate = await call('POST', '/api/admin/users', {
    token: adminToken,
    body: { username: `drill4493y-${STAMP}`, email: 'nope', password: PASSWORD },
  });
  record("POST /api/admin/users {email:'nope'} (was `typeof email === 'string'` and nothing else)", badAdminCreate);
  assert(
    'A6: admin create refuses a malformed address',
    badAdminCreate.status === 400,
    `status ${badAdminCreate.status}`,
  );

  const plainUser = `drill4493z-${STAMP}`;
  const plainSignup = await call('POST', '/api/auth/signup', {
    body: { username: plainUser, email: `${plainUser}@drill.invalid`, password: PASSWORD },
  });
  if (plainSignup.status !== 200 || !plainSignup.json?.token) {
    undetermined('POST /api/auth/account/email is guarded', 'could not create a second account to test it with');
  }
  const badAdd = await call('POST', '/api/auth/account/email', {
    token: plainSignup.json.token,
    body: { email: 'nope' },
  });
  record("POST /api/auth/account/email {email:'nope'}", badAdd);
  assert('A6: the add-address route refuses a malformed address', badAdd.status === 400, `status ${badAdd.status}`);

  // ── B: the chain ───────────────────────────────────────────────────────────
  say('\n--- B: is TRA-4489\'s fail-open chain now unreachable from here? ---');
  const status1 = await call('GET', '/api/auth/2fa/status', { token });
  record('2FA status after every refused write', status1);
  assert('B1: 2FA is still enabled', status1.json?.enabled === true, `enabled=${status1.json?.enabled}`);

  const loginAfter = await call('POST', '/api/auth/login', { body: { username: USER, password: PASSWORD } });
  record('login again — TRA-4489 drill step 07 minted a full session here', loginAfter);
  assert(
    'B2: the password ALONE still does NOT mint a session — the bypass is unreachable by this path',
    loginAfter.json?.twoFactorRequired === true && !loginAfter.json?.token,
    'twoFactorRequired=true, no token',
  );

  // ── C: the positive control ────────────────────────────────────────────────
  say('\n--- C: POSITIVE CONTROL — a real address is still accepted ---');
  const NEW_EMAIL = `${USER}.changed@drill.invalid`;
  const good = await call('PATCH', '/api/auth/me', { token, body: { email: `  ${NEW_EMAIL}\t` } });
  record('PATCH /api/auth/me with a real (padded) address', good);
  assert('C1: an ordinary email change still succeeds', good.status === 200, `status ${good.status}`);

  const meFinal = await call('GET', '/api/auth/me', { token });
  record('the account afterwards', meFinal);
  assert(
    'C2: the stored value is the TRIMMED one — validated and stored are the same string',
    meFinal.json?.email === NEW_EMAIL,
    `email=${JSON.stringify(meFinal.json?.email)}`,
  );

  const adminGood = await call('PATCH', `/api/admin/users/${encodeURIComponent(USER)}`, {
    token: adminToken,
    body: { email: `${USER}.admin@drill.invalid` },
  });
  record('CONTROL — an ordinary ADMIN email edit', adminGood);
  assert('C3: the admin email limb is not an outage', adminGood.status === 200, `status ${adminGood.status}`);

  // ── Verdict ────────────────────────────────────────────────────────────────
  say('\n' + '='.repeat(78));
  if (failures.length === 0) {
    say(`VERDICT: every assertion HELD across ${step} recorded calls.`);
    say('='.repeat(78));
    process.exit(0);
  }
  say(`VERDICT: ${failures.length} assertion(s) BROKEN:`);
  for (const f of failures) say(`  - ${f}`);
  say('='.repeat(78));
  process.exit(1);
};

run().catch((err) => {
  say(`\n!! drill threw: ${err?.stack ?? err}`);
  process.exit(2);
});
