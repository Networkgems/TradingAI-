#!/usr/bin/env node
// TRA-2511 arm 2 — does the TRA-2410 adoption guard actually hold on the LIVE box?
//
// ── Why this script exists at all ────────────────────────────────────────────
//
// The obvious live check — sign up, self-delete, re-register, see an empty book —
// PROVES NOTHING. `DELETE /api/account` (TRA-2421) wipes the tree first, so by the
// time the re-signup runs, `retireOrphanedBook` reports `orphanFound: false` and
// the guard is never entered. A perfect guard and a guard deleted from the source
// produce byte-identical output on that loop.
//
// The only way to make a REAL orphan — a book on disk under a name that is free —
// is `DELETE /api/admin/users/:username`, which deliberately RETAINS the files
// (TRA-142). That is `requireAdmin`, which is why this arm waited on TRA-2503.
//
// ── Why an empty book is not, by itself, evidence ────────────────────────────
//
// A brand-new book is empty too. "25000 / 0 positions" after re-registering is
// exactly what you would see if the predecessor's book had never existed, if the
// admin delete had destroyed it, or if the guard were refusing every name
// indiscriminately. So every cohort here is FINGERPRINTED before deletion
// (a non-default `demoEquity` + a watchlist symbol outside the default 25), and
// cohort C is a NEGATIVE CONTROL that asks for the fingerprint BACK.
//
// Cohort C passing is what makes cohorts A and B mean anything: it proves the
// retained files were on disk and reachable at the moment the other two came back
// clean. Without it this script cannot tell "guard worked" from "nothing to adopt".
//
//   A  teeth (signup path)  fingerprint → admin delete → POST /api/auth/signup
//                           ⇒ book MUST be clean
//   B  teeth (admin path)   fingerprint → admin delete → POST /api/admin/users
//                           ⇒ book MUST be clean AND the response MUST carry
//                             `retiredOrphanedBook` — the signup path only LOGS
//                             `orphanFound`, so this is the one cohort where the
//                             guard firing is directly observable over the wire.
//   C  control (adopt)      fingerprint → admin delete → POST /api/admin/users
//                             with `adoptExistingBook: true`
//                           ⇒ fingerprint MUST come BACK, and there MUST be no
//                             `retiredOrphanedBook`.
//
// Names are `qa_*` on `@qa.test` deliberately: anything outside
// BUILTIN_TEST_PATTERNS lands inside the firm-wide desk number (TRA-2488, twice).
//
// Usage:
//   RENDER_ADMIN_USER=… RENDER_ADMIN_PASS=… node scripts/tra2511-adoption-guard-verify.mjs
//   (defaults to TRADING_ADMIN_USERNAME / TRADING_ADMIN_PASSWORD)
//
// Exit 0 = every assertion held. Exit 1 = at least one red. Exit 2 = harness fault
// (could not log in, could not reach the host) — never conflated with a pass.

const HOST = process.env.TRA2511_HOST ?? 'https://tradingai-bqb1.onrender.com';
const ADMIN_USER = process.env.RENDER_ADMIN_USER ?? process.env.TRADING_ADMIN_USERNAME;
const ADMIN_PASS = process.env.RENDER_ADMIN_PASS ?? process.env.TRADING_ADMIN_PASSWORD;

/** The fingerprint. `demoEquity` is clamped to [1_000, 10_000_000] server-side. */
const MARK_EQUITY = 31337;
/** Not one of the 25 default symbols — so its presence is never a default. */
const MARK_SYMBOL = 'ZVZZT';
/** A second settings field, so the finding never rests on `demoEquity` alone. */
const MARK_LIMIT = 7;
/** Credential-shaped sentinel. Obviously fake by construction. */
const MARK_CRED = 'FAKE-ACCT-tra2511';
const FIXTURE_PASS = 'Qa2511pass!';

const stamp = Math.floor(Date.now() / 1000);
const results = [];
let harnessFault = null;

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

/** Read the three book facts that matter, from the two independent readers. */
async function readBook(token) {
  const state = await api('/api/state', { token });
  // `/api/watchlist/stocks` returns `{ all, added, hidden }`. `added` is the
  // per-user delta over the 25 defaults — it is `[]` on a fresh book, so it is a
  // cleaner fingerprint than `all` (which is non-empty either way). Assert on
  // BOTH: a reader that only looked at `all` would still be reading a list that
  // is 25/26 identical between a clean book and an adopted one.
  const wl = await api('/api/watchlist/stocks', { token });
  const all = wl.json?.all ?? [];
  const added = wl.json?.added ?? [];
  // The `account_settings` ROW is a separate channel from the `users/<name>/`
  // TREE, and the two do not move together — see the header note. Read it
  // directly rather than inferring it from `totalEquity`.
  const s = await api('/api/account/settings', { token });
  return {
    ok: state.status === 200,
    status: state.status,
    equity: state.json?.account?.totalEquity,
    settingsEquity: s.json?.demoEquityStocks,
    settingsLimit: s.json?.dailyTradesLimit,
    settingsCred: s.json?.liveAccountIdStocks,
    openPositions: state.json?.account?.openPositions?.length,
    closedPositions: state.json?.closedPositions?.length,
    openOptions: state.json?.options?.openOptions?.length,
    hasMarkSymbol: all.includes(MARK_SYMBOL) || added.includes(MARK_SYMBOL),
    addedCount: added.length,
    symbolCount: all.length,
  };
}

/** Sign up a fixture and stamp the fingerprint onto its book. */
async function createAndFingerprint(username) {
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: { username, password: FIXTURE_PASS, email: `${username}@qa.test` },
  });
  if (signup.status !== 200 || !signup.json?.token) {
    throw new Error(`signup ${username} → ${signup.status} ${JSON.stringify(signup.json).slice(0, 200)}`);
  }
  const token = signup.json.token;
  // Write the equity mark before resetting, and write BOTH keys: `forceReset`
  // reads `settings.demoEquityStocks ?? settings.demoEquity` (signal-engine.ts
  // :3246), and the PUT handler defaults `demoEquityStocks` to its own current
  // value — which is already 25000 — so setting `demoEquity` alone is a silent
  // no-op on `totalEquity`. That no-op is exactly the failure this arm is about:
  // it leaves a fingerprint that was never applied, which makes every downstream
  // "book is clean" assertion vacuous.
  await api('/api/account/settings', {
    method: 'PUT', token,
    body: {
      demoEquity: MARK_EQUITY,
      demoEquityStocks: MARK_EQUITY,
      dailyTradesLimit: MARK_LIMIT,
      // A credential-shaped sentinel. Obviously fake, never a real secret — its
      // only job is to show WHICH fields ride the settings row across a recycle.
      liveAccountIdStocks: MARK_CRED,
    },
  });
  await api('/api/account/reset-demo', { method: 'POST', token, body: { market: 'stocks' } });
  await api('/api/watchlist/stocks', { method: 'POST', token, body: { symbol: MARK_SYMBOL } });
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

  // ── Admin session, with the negative control that makes the 200 discriminating.
  const login = await api('/api/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  const junk = await api('/api/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: 'not-the-password-9f3a' } });
  if (login.status !== 200 || !login.json?.token) {
    harnessFault = `admin login → ${login.status} (TRA-2503 gate may have re-closed)`;
    return;
  }
  if (junk.status === 200) {
    harnessFault = 'admin login accepts a junk password — the 200 is not discriminating';
    return;
  }
  const admin = login.json.token;
  console.log(`admin     login 200, junk password ${junk.status} (discriminating)\n`);

  const cohorts = {
    A: `qa_cto2511_a_${stamp}`,
    B: `qa_cto2511_b_${stamp}`,
    C: `qa_cto2511_c_${stamp}`,
  };

  // ── Stage 1 — create + fingerprint + verify the fingerprint actually took.
  // A fingerprint that did not take is a HARNESS FAULT, not a red: every later
  // "book is clean" assertion would pass against a book that was already clean,
  // and the run would report a green arm with no teeth. Abort instead.
  console.log('stage 1 — fingerprint each cohort');
  for (const [cohort, username] of Object.entries(cohorts)) {
    const token = await createAndFingerprint(username);
    const book = await readBook(token);
    const took = book.equity === MARK_EQUITY && book.hasMarkSymbol;
    record(cohort, 'fingerprint written', took,
      `equity=${book.equity} ${MARK_SYMBOL}=${book.hasMarkSymbol} added=${book.addedCount}`);
    if (!took) {
      harnessFault =
        `cohort ${cohort} (${username}) never carried the fingerprint ` +
        `(equity=${book.equity} want ${MARK_EQUITY}; ${MARK_SYMBOL}=${book.hasMarkSymbol}). ` +
        'Without it the adoption assertions are vacuous — aborting rather than reporting a toothless green.';
      return;
    }
  }

  // ── Stage 2 — admin delete. The files must be RETAINED (TRA-142).
  console.log('\nstage 2 — admin delete (retains files by design)');
  for (const [cohort, username] of Object.entries(cohorts)) {
    const del = await api(`/api/admin/users/${username}`, { method: 'DELETE', token: admin });
    record(cohort, 'DELETE /api/admin/users → ok + resetTokensRevoked',
      del.status === 200 && del.json?.ok === true && del.json?.resetTokensRevoked !== undefined,
      `http=${del.status} resetTokensRevoked=${del.json?.resetTokensRevoked}`);
    const gone = await api('/api/auth/login', { method: 'POST', body: { username, password: FIXTURE_PASS } });
    record(cohort, 'credential row spliced out (login now 401)', gone.status === 401, `http=${gone.status}`);
  }

  // ── Stage 3 — re-register each cohort by its own path.
  console.log('\nstage 3 — re-register');

  // A: the signup path. Guard firing is only logged, so we assert on the OUTCOME.
  {
    const signup = await api('/api/auth/signup', {
      method: 'POST',
      body: { username: cohorts.A, password: FIXTURE_PASS, email: `${cohorts.A}@qa.test` },
    });
    record('A', 're-signup accepted', signup.status === 200 && !!signup.json?.token, `http=${signup.status}`);
    if (signup.json?.token) {
      const book = await readBook(signup.json.token);
      // ── TREE channel (`users/<name>/`) — what retireOrphanedBook actually moves.
      record('A', 'TREE: predecessor watchlist not adopted',
        book.hasMarkSymbol === false, `${MARK_SYMBOL} present=${book.hasMarkSymbol}`);
      record('A', 'TREE: no inherited positions',
        book.openPositions === 0 && book.closedPositions === 0 && book.openOptions === 0,
        `open=${book.openPositions} closed=${book.closedPositions} options=${book.openOptions}`);
      // ── SETTINGS-ROW channel (`account_settings`, SQLite, keyed by username).
      // `orphaned-books.ts` contains no reference to it, and no code path anywhere
      // deletes a settings row — `clearSettingsCache` only drops the in-memory
      // copy. So this is a fourth channel beside the three the guard closes.
      record('A', 'SETTINGS: predecessor demoEquityStocks not adopted',
        book.settingsEquity !== MARK_EQUITY, `demoEquityStocks=${book.settingsEquity} (predecessor ${MARK_EQUITY})`);
      record('A', 'SETTINGS: predecessor dailyTradesLimit not adopted',
        book.settingsLimit !== MARK_LIMIT, `dailyTradesLimit=${book.settingsLimit} (predecessor ${MARK_LIMIT})`);
      record('A', 'SETTINGS: predecessor BROKER CREDENTIAL not adopted',
        book.settingsCred !== MARK_CRED, `liveAccountIdStocks=${book.settingsCred} (predecessor ${MARK_CRED})`);
      record('A', 'derived: totalEquity not seeded from predecessor settings',
        book.equity === 25000, `equity=${book.equity}`);
    }
  }

  // B: the admin path — the only one that reports the retirement over the wire.
  {
    const created = await api('/api/admin/users', {
      method: 'POST', token: admin,
      body: { username: cohorts.B, email: `${cohorts.B}@qa.test`, password: FIXTURE_PASS },
    });
    record('B', 'admin re-create accepted', created.status === 201, `http=${created.status}`);
    const retired = created.json?.retiredOrphanedBook;
    record('B', 'GUARD OBSERVABLY FIRED — response carries retiredOrphanedBook',
      !!retired?.quarantinedTo && !!retired?.retiredAt,
      retired ? `quarantinedTo=${retired.quarantinedTo} retiredAt=${retired.retiredAt}` : 'ABSENT');
    const login2 = await api('/api/auth/login', { method: 'POST', body: { username: cohorts.B, password: FIXTURE_PASS } });
    if (login2.json?.token) {
      const book = await readBook(login2.json.token);
      record('B', 'TREE: clean after retirement', book.hasMarkSymbol === false,
        `${MARK_SYMBOL}=${book.hasMarkSymbol}`);
      record('B', 'SETTINGS: clean after retirement',
        book.settingsLimit !== MARK_LIMIT && book.settingsCred !== MARK_CRED,
        `dailyTradesLimit=${book.settingsLimit} liveAccountIdStocks=${book.settingsCred}`);
    }
  }

  // C: THE NEGATIVE CONTROL. Ask for the book back; it must come back.
  {
    const created = await api('/api/admin/users', {
      method: 'POST', token: admin,
      body: { username: cohorts.C, email: `${cohorts.C}@qa.test`, password: FIXTURE_PASS, adoptExistingBook: true },
    });
    record('C', 'admin re-create (adoptExistingBook) accepted', created.status === 201, `http=${created.status}`);
    record('C', 'no retirement reported on an intentional adopt',
      created.json?.retiredOrphanedBook === undefined,
      created.json?.retiredOrphanedBook ? 'retiredOrphanedBook PRESENT — adopt was overridden' : 'absent as expected');
    const login3 = await api('/api/auth/login', { method: 'POST', body: { username: cohorts.C, password: FIXTURE_PASS } });
    if (login3.json?.token) {
      const book = await readBook(login3.json.token);
      // This is the assertion that gives A and B their meaning: it proves the
      // retained files were on disk and reachable at the moment A and B came back
      // clean, so their clean TREE is a guard doing its job and not an empty disk.
      record('C', 'CONTROL — predecessor TREE restored (files were retained on disk)',
        book.hasMarkSymbol === true, `${MARK_SYMBOL}=${book.hasMarkSymbol}`);
    }
  }

  // ── Stage 4 — clean up. Admin delete retains files, so the fixtures are
  // retired rather than destroyed; that is the documented behaviour, not a leak.
  console.log('\nstage 4 — cleanup');
  for (const [cohort, username] of Object.entries(cohorts)) {
    const del = await api(`/api/admin/users/${username}`, { method: 'DELETE', token: admin });
    record(cohort, 'fixture removed from users.json', del.status === 200 || del.status === 404, `http=${del.status}`);
  }
  console.log(`\nfixtures: ${Object.values(cohorts).join(', ')}`);
}

main()
  .catch((err) => { harnessFault = err?.message ?? String(err); })
  .then(() => {
    console.log('\n' + '='.repeat(72));
    if (harnessFault) {
      console.log(`HARNESS FAULT — ${harnessFault}`);
      console.log('Not a pass and not a fail: the arm did not run.');
      process.exit(2);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`${results.length - failed.length}/${results.length} assertions held`);
    if (failed.length) {
      console.log('\nRED:');
      for (const f of failed) console.log(`  [${f.cohort}] ${f.name} — ${f.detail}`);
      process.exit(1);
    }
    console.log('TRA-2511 arm 2 GREEN — adoption guard holds, and the control proves it was discriminating.');
    process.exit(0);
  });
