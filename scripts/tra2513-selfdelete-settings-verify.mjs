#!/usr/bin/env node
// TRA-2513 — did `DELETE /api/account` actually destroy the `account_settings`
// SQLite row on the live box, and does it hold?
//
// ── Why the obvious test is WORTHLESS here ───────────────────────────────────
//
// The obvious recipe is: mark credentials → self-delete → re-signup the same name
// → assert the successor sees defaults. Once TRA-2520 is live that assertion is
// GREEN WITH OR WITHOUT THIS FIX, because `retireOrphanedBook` runs at SIGNUP and
// detects a row-only orphan all by itself — it would clean up the leftover row on
// the way in and hand the successor a clean read either way. A grader built that
// way measures TRA-2520 and reports it as TRA-2513.
//
// So this script never asks the successor. It asks the two surfaces that can tell
// WHICH call site did the work:
//
//  1. THE WIPE RECEIPT. `DELETE /api/account` returns `settingsRowExisted` /
//     `settingsRowRemoved` / `settingsCredentialFieldsCleared`, all NEW in this
//     fix and ABSENT in every prior build. Absent ⇒ UNDEPLOYED (exit 2), never
//     "there was no row".
//  2. THE ADMIN RE-CREATE. `POST /api/admin/users` emits `retiredOrphanedBook`
//     ONLY when `orphanFound` is true. After a self-delete under this fix the row
//     is already gone and the tree is already gone, so the key must be ABSENT.
//     WITHOUT this fix the row survives the wipe, `orphanFound` is true off the
//     row alone, and the key comes back carrying `settingsRowFound: true`. That
//     single key is the entire difference between the two builds.
//
// ── And absence needs a positive control ─────────────────────────────────────
//
// "the key was absent" is also what you get from a field that never fires, a
// route that 500s, or a fixture that was never really deleted. So cohort P does an
// ADMIN delete (files retained by design, TRA-142 — the row is NOT wiped on that
// path and is not meant to be) and re-creates: it must come back with the key
// PRESENT and `settingsRowFound: true`. Cohort A's absence only means something
// beside cohort P's presence, measured on the same host in the same run.
//
// Every cohort also carries a VERIFIED POSITIVE MARK — six credential fields
// written and read back non-blank before anything is deleted. A mark that did not
// apply is a HARNESS FAULT (exit 2), never a red and never a green, because it
// makes every downstream "it's clean" assertion vacuous.
//
// Names are `qa_*` on `@qa.test` deliberately: anything outside
// BUILTIN_TEST_PATTERNS lands inside the firm-wide desk number (TRA-2488, twice).
//
// Usage:
//   RENDER_ADMIN_USER=… RENDER_ADMIN_PASS=… node scripts/tra2513-selfdelete-settings-verify.mjs
//   (defaults to TRADING_ADMIN_USERNAME / TRADING_ADMIN_PASSWORD)
//
// Exit 0 = every assertion held. Exit 1 = at least one red (the leak is live).
// Exit 2 = harness fault or UNDEPLOYED — never conflated with a pass.

const HOST = process.env.TRA2513_HOST ?? 'https://tradingai-bqb1.onrender.com';
const ADMIN_USER = process.env.RENDER_ADMIN_USER ?? process.env.TRADING_ADMIN_USERNAME;
const ADMIN_PASS = process.env.RENDER_ADMIN_PASS ?? process.env.TRADING_ADMIN_PASSWORD;

/** Obviously-fake by construction. Never a real secret. */
const MARK_KEY = 'FAKE-KEY-tra2513-do-not-use';
const MARK_SECRET = 'FAKE-SECRET-tra2513-do-not-use';
const MARK_ACCT = 'FAKE-ACCT-tra2513';
const MARK_EQUITY = 31337;
const MARK_LIMIT = 7;
const FIXTURE_PASS = 'Qa2513pass!';

/**
 * Six fields across all three markets. A fix that only covered the `*Stocks` pair
 * — the one the original live probe happened to measure — fails here.
 */
const CRED_MARKS = {
  liveApiKeyStocks: MARK_KEY,
  liveAccountIdStocks: MARK_ACCT,
  liveApiKeyCrypto: MARK_KEY,
  liveApiSecretCrypto: MARK_SECRET,
  liveApiKeyOptionsSandbox: MARK_KEY,
  liveAccountIdOptionsSandbox: MARK_ACCT,
};
const CRED_FIELDS = Object.keys(CRED_MARKS);

const stamp = Math.floor(Date.now() / 1000);
const results = [];
let harnessFault = null;
/** Hoisted so `finally` can reach it — an abort is exactly when fixtures leak. */
let adminToken = null;
const fixtures = [];

function record(cohort, name, ok, detail) {
  results.push({ cohort, name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${cohort}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 400) }; }
  return { status: res.status, json };
}

const blank = (v) => (v ?? '') === '';

/** Sign up a fixture and stamp the credential + state marks onto its row. */
async function createAndMark(username) {
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: { username, password: FIXTURE_PASS, email: `${username}@qa.test` },
  });
  if (signup.status !== 200 || !signup.json?.token) {
    throw new Error(`signup ${username} → ${signup.status} ${JSON.stringify(signup.json).slice(0, 200)}`);
  }
  const token = signup.json.token;
  await api('/api/account/settings', {
    method: 'PUT',
    token,
    body: {
      demoEquity: MARK_EQUITY,
      // `forceReset` reads `demoEquityStocks ?? demoEquity`, and the PUT handler
      // defaults `demoEquityStocks` to its own current value — so setting
      // `demoEquity` alone is a silent no-op on the equity the user sees.
      demoEquityStocks: MARK_EQUITY,
      dailyTradesLimit: MARK_LIMIT,
      ...CRED_MARKS,
    },
  });
  return token;
}

/** Write the mark and PROVE it landed. Returns the token, or sets `harnessFault`. */
async function markAndProve(cohort, username) {
  const token = await createAndMark(username);
  const read = await api('/api/account/settings', { token });
  const settings = read.json ?? {};
  const applied = CRED_FIELDS.filter((f) => settings[f] === CRED_MARKS[f]);
  record(cohort, 'credential mark applied', applied.length === CRED_FIELDS.length,
    `${applied.length}/${CRED_FIELDS.length} fields, demoEquity=${settings.demoEquity}, limit=${settings.dailyTradesLimit}`);
  if (applied.length !== CRED_FIELDS.length) {
    harnessFault =
      `cohort ${cohort} (${username}) never carried the credential mark ` +
      `(${applied.length}/${CRED_FIELDS.length} applied). Every assertion below would be vacuous — ` +
      'aborting rather than reporting a toothless green.';
    return null;
  }
  return token;
}

async function main() {
  if (!ADMIN_USER || !ADMIN_PASS) {
    harnessFault = 'no admin credential in env (RENDER_ADMIN_USER/PASS or TRADING_ADMIN_USERNAME/PASSWORD)';
    return;
  }

  const version = await api('/api/health/version');
  console.log(`host      ${HOST}`);
  console.log(`live SHA  ${version.json?.commit} (booted ${version.json?.startedAt}, node ${version.json?.nodeVersion})`);

  const login = await api('/api/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  const junk = await api('/api/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: 'not-the-password-9f3a' } });
  if (login.status !== 200 || !login.json?.token) {
    harnessFault = `admin login → ${login.status} — cohort P needs it, and without P cohort A proves nothing`;
    return;
  }
  if (junk.status === 200) {
    harnessFault = 'admin login accepts a junk password — the 200 is not discriminating';
    return;
  }
  adminToken = login.json.token;
  console.log(`admin     login 200, junk password ${junk.status} (discriminating)\n`);

  const A = `qa_tra2513_a_${stamp}`;   // self-delete — the path under test
  const P = `qa_tra2513_p_${stamp}`;   // admin-delete — the positive control
  const BY = `qa_tra2513_by_${stamp}`; // bystander — never deleted
  fixtures.push(A, P, BY);

  // ── Stage 1 — mark all three, and prove every mark applied. ────────────────
  console.log('stage 1 — write the credential mark and read it back');
  const tokenA = await markAndProve('A', A);
  if (harnessFault) return;
  if (!(await markAndProve('P', P))) return;
  if (!(await markAndProve('BY', BY))) return;

  // ── Stage 2 — the self-delete, and its RECEIPT. This is the deploy detector.
  console.log('\nstage 2 — DELETE /api/account (the path under test) and read its receipt');
  // The password is REQUIRED in the body — irreversible, so a bare token is not
  // enough (a borrowed laptop must not be able to destroy the book). Omitting it
  // is a 400 with no receipt, which this script reports as a harness fault rather
  // than as a leak.
  const del = await api('/api/account', { method: 'DELETE', token: tokenA, body: { password: FIXTURE_PASS } });
  const receipt = del.json?.receipt ?? null;
  record('A', 'self-delete accepted', del.status === 200 && del.json?.ok === true,
    `http=${del.status} ok=${del.json?.ok}`);
  if (!receipt) {
    harnessFault = `self-delete returned no receipt (http=${del.status}) — nothing to grade`;
    return;
  }
  if (!('settingsRowExisted' in receipt)) {
    harnessFault =
      'UNDEPLOYED — the wipe receipt has no `settingsRowExisted`. That key is new in the TRA-2513 ' +
      'fix and absent in every prior build, so this host is running code from before it. ' +
      `Receipt keys seen: ${Object.keys(receipt).join(', ')}`;
    return;
  }
  record('A', 'receipt: the row was THERE to destroy', receipt.settingsRowExisted === true,
    `settingsRowExisted=${receipt.settingsRowExisted}`);
  record('A', 'receipt: the row is verified GONE', receipt.settingsRowRemoved === true,
    `settingsRowRemoved=${receipt.settingsRowRemoved}`);
  record('A', 'receipt: all six credential fields counted', receipt.settingsCredentialFieldsCleared === 6,
    `settingsCredentialFieldsCleared=${receipt.settingsCredentialFieldsCleared} (expected 6)`);
  record('A', 'receipt: the wipe reports no residue', receipt.ok === true,
    `ok=${receipt.ok} errorCount=${receipt.errorCount}`);

  // ── Stage 3 — the discriminator. Admin re-create both names. ───────────────
  //
  // A: the row was destroyed at DELETE time ⇒ nothing left to find ⇒ the
  //    `retiredOrphanedBook` key must be ABSENT.
  // P: admin delete RETAINS by design and does not touch the row ⇒ the key must
  //    be PRESENT with `settingsRowFound: true`. Without this the absence in A is
  //    indistinguishable from a field that never fires.
  console.log('\nstage 3 — admin delete P, then re-create both (the discriminator)');
  const delP = await api(`/api/admin/users/${encodeURIComponent(P)}`, { method: 'DELETE', token: adminToken });
  record('P', 'admin delete accepted', delP.status === 200, `http=${delP.status}`);

  const recreate = async (username) => api('/api/admin/users', {
    method: 'POST',
    token: adminToken,
    body: { username, email: `${username}@qa.test`, password: FIXTURE_PASS, role: 'user' },
  });

  const reP = await recreate(P);
  const retP = reP.json?.retiredOrphanedBook ?? null;
  record('P', 'POSITIVE CONTROL: the detector fires on a retained book',
    reP.status === 201 && retP?.settingsRowFound === true,
    `http=${reP.status} retiredOrphanedBook=${retP ? JSON.stringify(retP) : 'ABSENT'}`);
  if (reP.status === 201 && retP?.settingsRowFound !== true) {
    harnessFault =
      'the positive control did NOT fire — `retiredOrphanedBook.settingsRowFound` was not true after an ' +
      'admin delete that retains the book. Cohort A\'s absence below would then mean nothing at all ' +
      '(it would be the same absence a dead field produces). Aborting rather than reporting a green.';
    return;
  }

  const reA = await recreate(A);
  const retA = reA.json?.retiredOrphanedBook ?? null;
  record('A', 'THE VERDICT: nothing left for the signup guard to retire',
    reA.status === 201 && retA === null,
    `http=${reA.status} retiredOrphanedBook=${retA ? JSON.stringify(retA) : 'ABSENT (correct)'}`);
  if (retA?.settingsRowFound === true) {
    record('A', 'REGRESSION: the row survived the self-delete', false,
      'the signup guard found the row still there — `wipeAccountData` did not destroy it. ' +
      'This is the TRA-2513 leak, live.');
  }

  // ── Stage 4 — the successor read, as corroboration only. ───────────────────
  //
  // NOT the verdict: post-TRA-2520 this comes back clean either way (the signup
  // guard would have swept the leftover row). It is here to catch the case where
  // BOTH fixes are somehow bypassed.
  console.log('\nstage 4 — successor read (corroboration; stage 3 is the verdict)');
  const succ = await api('/api/auth/login', { method: 'POST', body: { username: A, password: FIXTURE_PASS } });
  if (succ.status === 200 && succ.json?.token) {
    const s = (await api('/api/account/settings', { token: succ.json.token })).json ?? {};
    const dirty = CRED_FIELDS.filter((f) => !blank(s[f]));
    record('A', 'successor holds no credential of the predecessor', dirty.length === 0,
      dirty.length ? `still set: ${dirty.join(', ')}` : 'all six blank');
    record('A', 'successor equity is the default, not 31337', s.demoEquity !== MARK_EQUITY,
      `demoEquity=${s.demoEquity}`);
  } else {
    record('A', 'successor login', false, `http=${succ.status} — could not corroborate`);
  }

  // ── Stage 5 — bystander. A delete that reached across usernames would pass
  //    every assertion above it.
  console.log('\nstage 5 — bystander (nobody else\'s row was touched)');
  const byToken = await api('/api/auth/login', { method: 'POST', body: { username: BY, password: FIXTURE_PASS } });
  if (byToken.status === 200 && byToken.json?.token) {
    const s = (await api('/api/account/settings', { token: byToken.json.token })).json ?? {};
    const kept = CRED_FIELDS.filter((f) => s[f] === CRED_MARKS[f]);
    record('BY', 'bystander keeps their own row intact', kept.length === CRED_FIELDS.length,
      `${kept.length}/${CRED_FIELDS.length} fields, demoEquity=${s.demoEquity}`);
  } else {
    record('BY', 'bystander login', false, `http=${byToken.status}`);
  }
}

/** Best-effort teardown on EVERY exit path, including the aborts. */
async function cleanup() {
  if (!adminToken) return;
  for (const username of fixtures) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE', token: adminToken });
    } catch { /* teardown is advisory; never turn a verdict into a crash */ }
  }
}

main()
  .catch((err) => { harnessFault = `unhandled: ${err instanceof Error ? err.message : String(err)}`; })
  .then(cleanup)
  .then(() => {
    console.log('');
    if (harnessFault) {
      console.log(`RESULT: HARNESS FAULT / UNDEPLOYED — ${harnessFault}`);
      console.log('This is NOT a pass. Do not close TRA-2513 on it.');
      process.exit(2);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`RESULT: ${failed.length === 0 ? 'GREEN' : 'RED'} — ${results.length - failed.length}/${results.length} assertions held`);
    for (const f of failed) console.log(`  FAILED [${f.cohort}] ${f.name} — ${f.detail}`);
    process.exit(failed.length === 0 ? 0 : 1);
  });
