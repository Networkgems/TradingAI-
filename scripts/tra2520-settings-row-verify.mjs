#!/usr/bin/env node
// TRA-2520 — did the `account_settings` retirement actually reach the live box,
// and does it hold?
//
// ── The instrument problem this script is built around ───────────────────────
//
// The fix DELETES a row. "the row was dropped" and "there was never a row"
// produce BYTE-IDENTICAL `GET /api/account/settings` output — defaults, in both
// cases. So a successor reading blank credentials is not, by itself, evidence of
// anything: it is also what you see against a host that never got the deploy, or
// against a fingerprint that silently failed to apply.
//
// Three things make the green here discriminating, and the script REFUSES to
// report a pass without all three:
//
//  1. A VERIFIED POSITIVE MARK. Four credential fields are written and READ BACK
//     non-blank before the delete. A mark that did not apply is a HARNESS FAULT
//     (exit 2), never a red and never a green — otherwise every "it's clean"
//     assertion below is vacuous.
//  2. A DEPLOY DETECTOR THAT FAILS CLOSED. `POST /api/admin/users` gained
//     `settingsRowFound` in this fix, so the key is ABSENT in every prior build.
//     An absent key therefore means UNDEPLOYED — exit 2 — and can never be read
//     as "no row was there". (A new key proves a deploy only if it is absent in
//     the prior build; this one is, by construction.)
//  3. A NEGATIVE CONTROL ON THE DISK. Cohort C re-creates with
//     `adoptExistingBook: true` and asks the predecessor's book BACK. Its
//     watchlist mark returning is what proves the retained files were on disk and
//     reachable at the moment cohort B came back clean — i.e. that B measured a
//     guard doing its job rather than an empty disk.
//
// ── Why the admin path, not a self-delete loop ───────────────────────────────
//
// `DELETE /api/account` wipes the tree first, so the re-signup finds
// `orphanFound: false` and the guard is never entered. Only
// `DELETE /api/admin/users/:username`, which RETAINS the files by design
// (TRA-142), makes a real orphan. That route is `requireAdmin`.
//
// And `POST /api/admin/users` is the ONLY path where the retirement is visible
// over the wire at all — the signup route merely `log.warn`s it, and this host
// exposes no log surface to a grader.
//
// Names are `qa_*` on `@qa.test` deliberately: anything outside
// BUILTIN_TEST_PATTERNS lands inside the firm-wide desk number (TRA-2488, twice).
//
// Usage:
//   RENDER_ADMIN_USER=… RENDER_ADMIN_PASS=… node scripts/tra2520-settings-row-verify.mjs
//   (defaults to TRADING_ADMIN_USERNAME / TRADING_ADMIN_PASSWORD)
//
// Exit 0 = every assertion held. Exit 1 = at least one red (the leak is live).
// Exit 2 = harness fault or UNDEPLOYED — never conflated with a pass.

const HOST = process.env.TRA2520_HOST ?? 'https://tradingai-bqb1.onrender.com';
const ADMIN_USER = process.env.RENDER_ADMIN_USER ?? process.env.TRADING_ADMIN_USERNAME;
const ADMIN_PASS = process.env.RENDER_ADMIN_PASS ?? process.env.TRADING_ADMIN_PASSWORD;

/** Obviously-fake by construction. Never a real secret. */
const MARK_KEY = 'FAKE-KEY-tra2520-do-not-use';
const MARK_ACCT = 'FAKE-ACCT-tra2520';
const MARK_EQUITY = 31337;
const MARK_LIMIT = 7;
/** Not one of the 25 default symbols, so its presence is never a default. */
const MARK_SYMBOL = 'ZVZZT';
const FIXTURE_PASS = 'Qa2520pass!';

/**
 * The four credential fields the live probe measured riding the row across a
 * recycle. Two of them (`*Stocks`) are NOT in the shared `LiveCredentialField`
 * type — which is exactly why the fix does not redact by that type.
 */
const CRED_FIELDS = [
  'liveApiKeyStocks',
  'liveAccountIdStocks',
  'liveApiKeyOptionsSandbox',
  'liveAccountIdOptionsSandbox',
];

const stamp = Math.floor(Date.now() / 1000);
const results = [];
let harnessFault = null;
/**
 * Cleanup state, hoisted so the `finally` can reach it. An abort is the MOST
 * likely outcome on an undeployed host, and it is exactly when fixtures would
 * otherwise be left behind — a stale `qa_*` book is the next grader's confound.
 */
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
      liveApiKeyStocks: MARK_KEY,
      liveAccountIdStocks: MARK_ACCT,
      liveApiKeyOptionsSandbox: MARK_KEY,
      liveAccountIdOptionsSandbox: MARK_ACCT,
    },
  });
  // The TREE channel, so cohort C can prove the disk still held the book.
  await api('/api/watchlist/stocks', { method: 'POST', token, body: { symbol: MARK_SYMBOL } });
  return token;
}

async function readSettings(token) {
  const s = await api('/api/account/settings', { token });
  return { status: s.status, settings: s.json ?? {} };
}

async function loginAs(username) {
  const r = await api('/api/auth/login', { method: 'POST', body: { username, password: FIXTURE_PASS } });
  return r.status === 200 ? r.json?.token : null;
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
    harnessFault = `admin login → ${login.status} — cannot make a real orphan without it`;
    return;
  }
  if (junk.status === 200) {
    harnessFault = 'admin login accepts a junk password — the 200 is not discriminating';
    return;
  }
  const admin = login.json.token;
  adminToken = admin;
  console.log(`admin     login 200, junk password ${junk.status} (discriminating)\n`);

  const cohorts = { B: `qa_tra2520_b_${stamp}`, C: `qa_tra2520_c_${stamp}` };
  fixtures.push(...Object.values(cohorts));

  // ── Stage 1 — mark, and PROVE the mark applied. ────────────────────────────
  console.log('stage 1 — write the credential mark and read it back');
  for (const [cohort, username] of Object.entries(cohorts)) {
    const token = await createAndMark(username);
    const { settings } = await readSettings(token);
    const applied = CRED_FIELDS.filter((f) => settings[f] === MARK_KEY || settings[f] === MARK_ACCT);
    record(cohort, 'credential mark applied', applied.length === CRED_FIELDS.length,
      `${applied.length}/${CRED_FIELDS.length} fields, demoEquity=${settings.demoEquity}, limit=${settings.dailyTradesLimit}`);
    if (applied.length !== CRED_FIELDS.length) {
      harnessFault =
        `cohort ${cohort} (${username}) never carried the credential mark ` +
        `(${applied.length}/${CRED_FIELDS.length} applied). Every "the successor sees no credentials" ` +
        'assertion below would be vacuous — aborting rather than reporting a toothless green.';
      return;
    }
  }

  // ── Stage 2 — admin delete. Retains the files BY DESIGN: this is what makes a
  //    real orphan, and the whole reason the fix has anything to do.
  console.log('\nstage 2 — admin delete (files retained by design, TRA-142)');
  for (const [cohort, username] of Object.entries(cohorts)) {
    const del = await api(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE', token: admin });
    record(cohort, 'admin delete accepted', del.status === 200, `http=${del.status}`);
    if (del.status !== 200) {
      harnessFault = `cohort ${cohort}: admin delete → ${del.status}; no orphan was made, so nothing below is measuring the guard`;
      return;
    }
  }

  // ── Stage 3 — cohort B: re-create the name. The teeth.
  console.log('\nstage 3 — cohort B: admin re-create (the guard MUST fire)');
  const recreated = await api('/api/admin/users', {
    method: 'POST',
    token: admin,
    body: { username: cohorts.B, email: `${cohorts.B}@qa.test`, password: FIXTURE_PASS },
  });
  record('B', 'admin re-create accepted', recreated.status === 201, `http=${recreated.status}`);
  const retired = recreated.json?.retiredOrphanedBook;
  if (!retired) {
    harnessFault =
      'response carries no `retiredOrphanedBook` — the TRA-2410 guard itself did not fire. ' +
      'This is not a TRA-2520 red; the orphan was never detected at all.';
    return;
  }

  // THE DEPLOY DETECTOR. `settingsRowFound` did not exist before this fix, so an
  // absent key means the build under test predates it. Fails CLOSED: exit 2.
  if (!Object.prototype.hasOwnProperty.call(retired, 'settingsRowFound')) {
    harnessFault =
      'UNDEPLOYED — `retiredOrphanedBook.settingsRowFound` is absent. That key is new in the ' +
      'TRA-2520 fix, so this host is running an older build. An absent field means undeployed, ' +
      'NEVER "no row was there": re-derive the live SHA and deploy before grading. ' +
      `(live=${version.json?.commit})`;
    return;
  }

  record('B', 'guard reports the settings ROW channel', retired.settingsRowFound === true,
    `settingsRowFound=${retired.settingsRowFound}`);
  record('B', 'the row was archived AND verified gone', retired.settingsRowRetired === true,
    `settingsRowRetired=${retired.settingsRowRetired} archivedTo=${retired.settingsQuarantinedTo}`);
  record('B', 'credential fields were cleared at retirement',
    (retired.settingsCredentialFieldsCleared ?? 0) >= CRED_FIELDS.length,
    `cleared=${retired.settingsCredentialFieldsCleared} (want >= ${CRED_FIELDS.length})`);

  // ── Stage 4 — the successor's own read. The channel the user actually sees.
  console.log('\nstage 4 — cohort B: what the SUCCESSOR reads back');
  const bToken = await loginAs(cohorts.B);
  if (!bToken) {
    harnessFault = `cohort B: could not log in as the re-created ${cohorts.B}`;
    return;
  }
  const { settings: after } = await readSettings(bToken);
  const leaked = CRED_FIELDS.filter((f) => !blank(after[f]));
  record('B', 'successor inherits NO broker credentials', leaked.length === 0,
    leaked.length ? `STILL SET: ${leaked.join(', ')}` : `all ${CRED_FIELDS.length} blank`);
  // A SECOND channel, because the two can disagree: a fix that blanked the
  // credential fields but left the row would pass the assertion above and fail
  // this one.
  record('B', 'successor inherits NO predecessor state', after.demoEquity !== MARK_EQUITY && after.dailyTradesLimit !== MARK_LIMIT,
    `demoEquity=${after.demoEquity} (mark ${MARK_EQUITY}), dailyTradesLimit=${after.dailyTradesLimit} (mark ${MARK_LIMIT})`);
  const state = await api('/api/state', { token: bToken });
  record('B', 'user-visible equity is not the predecessor\'s', state.json?.account?.totalEquity !== MARK_EQUITY,
    `totalEquity=${state.json?.account?.totalEquity}`);

  // ── Stage 5 — cohort C: the negative control. Ask for the book BACK.
  console.log('\nstage 5 — cohort C: NEGATIVE CONTROL (adoptExistingBook)');
  const adopted = await api('/api/admin/users', {
    method: 'POST',
    token: admin,
    body: { username: cohorts.C, email: `${cohorts.C}@qa.test`, password: FIXTURE_PASS, adoptExistingBook: true },
  });
  record('C', 'admin re-create (adopt) accepted', adopted.status === 201, `http=${adopted.status}`);
  record('C', 'no retirement on the adopt path', adopted.json?.retiredOrphanedBook === undefined,
    adopted.json?.retiredOrphanedBook ? 'retiredOrphanedBook PRESENT — adopt was overridden' : 'absent as expected');
  const cToken = await loginAs(cohorts.C);
  if (!cToken) {
    harnessFault = `cohort C: could not log in as ${cohorts.C} — the control cannot be read`;
    return;
  }
  const wl = await api('/api/watchlist/stocks', { token: cToken });
  const cameBack = (wl.json?.added ?? []).includes(MARK_SYMBOL) || (wl.json?.all ?? []).includes(MARK_SYMBOL);
  record('C', `THE CONTROL — the predecessor's book was on disk and reachable (${MARK_SYMBOL} returns)`, cameBack,
    `added=${JSON.stringify(wl.json?.added ?? [])}`);
  if (!cameBack) {
    harnessFault =
      'the adopt control did NOT get the book back, so cohort B\'s clean read cannot be attributed ' +
      'to the guard — an empty disk produces the same output. Aborting rather than claiming a pass.';
    return;
  }

}

/**
 * Runs on EVERY exit path, including the aborts. Deletes are best-effort and
 * never change the verdict — a fixture that will not delete is a warning, not a
 * red, because it says nothing about the channel under test.
 */
async function cleanup() {
  if (!adminToken || fixtures.length === 0) return;
  console.log('\ncleanup');
  for (const username of fixtures) {
    try {
      const del = await api(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE', token: adminToken });
      console.log(`  ${del.status === 200 || del.status === 404 ? 'ok  ' : 'WARN'} ${username} (http=${del.status})`);
    } catch (err) {
      console.log(`  WARN ${username} — ${err?.message ?? String(err)}`);
    }
  }
}

main()
  .catch((err) => { harnessFault = `unhandled: ${err?.message ?? String(err)}`; })
  .then(cleanup)
  .catch(() => { /* cleanup failures never change the verdict */ })
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log('\n' + '─'.repeat(72));
    if (harnessFault) {
      console.log(`HARNESS FAULT / UNDEPLOYED — ${harnessFault}`);
      console.log('exit 2 — this is NOT a pass and NOT a red.');
      process.exit(2);
    }
    if (failed.length) {
      console.log(`RED — ${failed.length}/${results.length} assertion(s) failed:`);
      for (const r of failed) console.log(`  [${r.cohort}] ${r.name} — ${r.detail}`);
      console.log('exit 1 — the account_settings channel is still open on this host.');
      process.exit(1);
    }
    console.log(`GREEN — ${results.length}/${results.length} assertions held.`);
    console.log('The settings row is retired with the tree, and the successor inherits no credentials.');
    process.exit(0);
  });
