#!/usr/bin/env node
// TRA-2511 arm 1 — the close-then-re-register handshake, on the SELF-delete path.
//
// This arm is deliberately the WEAK one and it is worth being explicit about why.
// `DELETE /api/account` (TRA-2421) wipes the tree before the name comes free, so
// the re-signup sees `orphanFound: false` and the TRA-2410 adoption guard is never
// entered. This arm therefore does NOT test the guard — arm 2
// (`tra2511-adoption-guard-verify.mjs`) does. What this arm tests is the OTHER
// half: that the self-delete wipe itself is complete, i.e. that a name freed this
// way comes back clean.
//
// For that to mean anything the fixture must be OLD ENOUGH TO HAVE BEEN BACKED UP.
// `rotateBackups()` runs at boot and then every 30 min (`index.ts:11450`), keeping
// 24 generations. A fixture younger than one rotation has nothing in `backups/`,
// so the wipe's backup-sweep has nothing to sweep and the receipt's
// `backupGenerationsWithData: 0` is the tell that the arm had no teeth — which is
// exactly what happened on TRA-2511's first attempt (and what TRA-2410 AC2 warns
// about). This script REFUSES to report a pass on a 0.
//
// Usage:  node scripts/tra2511-arm1-selfdelete-handshake.mjs <username>
// The fixture must already exist and predate a rotation; the script waits for the
// next boundary if needed. Exit 0 = green, 1 = red, 2 = harness fault / no teeth.

const HOST = process.env.TRA2511_HOST ?? 'https://tradingai-bqb1.onrender.com';
const USER = process.argv[2];
const PASS = 'Qa2511pass!';
const MARK_SYMBOL = 'ZVZZT';
const MARK_EQUITY = 31337;
const MARK_LIMIT = 7;
const MARK_KEY = 'FAKE-KEY-tra2511-arm1-do-not-use';   // obvious sentinel, never a real secret
const MARK_ACCT = 'FAKE-ACCT-tra2511-arm1';
const BACKUP_INTERVAL_MS = 30 * 60_000;

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!USER) { console.log('usage: node scripts/tra2511-arm1-selfdelete-handshake.mjs <username>'); process.exit(2); }

  const v = await api('/api/health/version');
  const bootedAt = Date.parse(v.json?.startedAt ?? '');
  console.log(`live SHA  ${v.json?.commit}`);
  console.log(`booted    ${v.json?.startedAt}`);
  console.log(`fixture   ${USER}`);

  // ── Wait for a rotation boundary to pass, so the fixture is actually in
  // `backups/`. Rotations run at boot + every 30 min.
  //
  // TRA2511_NO_WAIT=1 skips the wait for a fixture that has ALREADY outlived a
  // rotation (e.g. a re-run after a harness fault). This does not weaken the arm:
  // the teeth are enforced downstream by the receipt's own
  // `backupGenerationsWithData > 0`, which is measured, not assumed. The wait is
  // only a convenience for getting a fresh fixture over that line.
  if (Number.isFinite(bootedAt) && process.env.TRA2511_NO_WAIT !== '1') {
    const elapsed = Date.now() - bootedAt;
    const nextBoundary = bootedAt + Math.ceil(elapsed / BACKUP_INTERVAL_MS) * BACKUP_INTERVAL_MS;
    const waitMs = nextBoundary - Date.now() + 45_000; // +45s slack for the sweep to finish
    if (waitMs > 0) {
      console.log(`\nwaiting ${Math.round(waitMs / 1000)}s for the rotateBackups boundary at ${new Date(nextBoundary).toISOString()}`);
      await sleep(waitMs);
      console.log(`resumed at ${new Date().toISOString()}`);
    }
  }

  const login = await api('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
  if (login.status !== 200 || !login.json?.token) {
    console.log(`HARNESS FAULT: login for ${USER} → ${login.status}`);
    process.exit(2);
  }
  const token = login.json.token;

  // ── Mark the book so "clean afterwards" is a discriminating claim, not a
  // tautology. TWO INDEPENDENT CHANNELS, because they are cleared by different
  // code and their DISAGREEMENT is the finding:
  //
  //   tree     — `users/<name>/`, what `wipeAccountData` removes.
  //   settings — the `account_settings` SQLite row, keyed by the raw username.
  //
  // A single-channel version of this script asserted `equity === 25000` against a
  // fixture still sitting at the 25000 DEFAULT — vacuous, since a fresh book and a
  // fully-leaked one both read 25000. Both marks are read back and gated below.
  await api('/api/watchlist/stocks', { method: 'POST', token, body: { symbol: MARK_SYMBOL } });
  const wlBefore = await api('/api/watchlist/stocks', { token });
  const marked = (wlBefore.json?.added ?? []).includes(MARK_SYMBOL);
  console.log(`\npredecessor marked (tree): watchlist.added=${JSON.stringify(wlBefore.json?.added)}`);
  if (!marked) { console.log('HARNESS FAULT: tree fingerprint did not take'); process.exit(2); }

  // `demoEquityStocks` is set EXPLICITLY: the PUT handler defaults it to its own
  // current value, and the engine seeds from `demoEquityStocks ?? demoEquity`
  // (`signal-engine.ts:3246`), so marking `demoEquity` alone silently does nothing.
  await api('/api/account/settings', {
    method: 'PUT', token,
    body: {
      demoEquity: MARK_EQUITY, demoEquityStocks: MARK_EQUITY, dailyTradesLimit: MARK_LIMIT,
      liveApiKeyStocks: MARK_KEY, liveAccountIdStocks: MARK_ACCT,
    },
  });
  await api('/api/account/reset-demo', { method: 'POST', token, body: { market: 'stocks' } });
  const setBefore = (await api('/api/account/settings', { token })).json;
  const sB = setBefore?.settings ?? setBefore;
  const eqBefore = (await api('/api/state', { token })).json?.account?.totalEquity;
  console.log(`predecessor marked (settings): demoEquityStocks=${sB?.demoEquityStocks} dailyTradesLimit=${sB?.dailyTradesLimit} liveApiKeyStocks=${JSON.stringify(sB?.liveApiKeyStocks)} totalEquity=${eqBefore}`);
  if (sB?.demoEquityStocks !== MARK_EQUITY || sB?.dailyTradesLimit !== MARK_LIMIT
      || sB?.liveApiKeyStocks !== MARK_KEY || eqBefore !== MARK_EQUITY) {
    console.log('HARNESS FAULT: settings fingerprint did not fully take — refusing to grade a channel whose teeth I cannot show');
    process.exit(2);
  }

  // ── Self-delete. The receipt is the instrument.
  // `DELETE /api/account` is irreversible, so a bare token is NOT enough — the
  // route re-checks the password (`index.ts:6033`) and 400s without one. Omitting
  // it cost this arm a full 30-min rotation wait on the first run.
  const del = await api('/api/account', { method: 'DELETE', token, body: { password: PASS } });
  console.log(`\nDELETE /api/account → http=${del.status}`);
  console.log(JSON.stringify(del.json, null, 1));
  const receipt = del.json?.receipt ?? del.json;
  const gens = receipt?.backupGenerationsWithData;

  // A 400/401/429 here is the HARNESS failing to ask correctly — a missing or
  // wrong password, or the shared login throttle — NOT the product failing to
  // delete. Grading those as a product red would file a bug against working code.
  if (del.status === 400 || del.status === 401 || del.status === 429) {
    console.log(`\nHARNESS FAULT: the delete request was rejected before any wipe ran (http=${del.status}).`);
    console.log('Nothing was destroyed and the fixture is still marked — fix the request and re-run.');
    process.exit(2);
  }
  if (del.status !== 200 || receipt?.ok !== true) { console.log('RED: self-delete did not succeed'); process.exit(1); }

  if (!(typeof gens === 'number' && gens > 0)) {
    console.log(`\nNO TEETH: backupGenerationsWithData=${gens}. The fixture was never backed up, so`);
    console.log('the wipe had no backup generations to sweep and a clean re-registration proves');
    console.log('nothing about the backup channel. Not reporting this as a pass.');
    process.exit(2);
  }
  console.log(`\nteeth confirmed: backupGenerationsWithData=${gens} (>0, the wipe had generations to sweep)`);

  // Token must be dead immediately (TRA-2421).
  const afterTok = await api('/api/state', { token });
  console.log(`old token after delete → http=${afterTok.status} (want 401)`);

  // ── Re-register the same name.
  const re = await api('/api/auth/signup', { method: 'POST', body: { username: USER, password: PASS, email: `${USER}@qa.test` } });
  if (re.status !== 200 || !re.json?.token) { console.log(`RED: re-signup → ${re.status}`); process.exit(1); }
  const t2 = re.json.token;
  const st = await api('/api/state', { token: t2 });
  const wl = await api('/api/watchlist/stocks', { token: t2 });
  const added = wl.json?.added ?? [];

  const setAfter = (await api('/api/account/settings', { token: t2 })).json;
  const sA = setAfter?.settings ?? setAfter;

  // Reported as TWO channels. They are cleared by different code, so collapsing
  // them into one number would hide exactly the asymmetry this arm exists to find.
  const treeChecks = [
    ['token revoked on delete', afterTok.status === 401, `http=${afterTok.status}`],
    ['0 open positions', st.json?.account?.openPositions?.length === 0, `n=${st.json?.account?.openPositions?.length}`],
    ['0 closed positions', st.json?.closedPositions?.length === 0, `n=${st.json?.closedPositions?.length}`],
    ['0 open options', st.json?.options?.openOptions?.length === 0, `n=${st.json?.options?.openOptions?.length}`],
    [`predecessor ${MARK_SYMBOL} not adopted`, !added.includes(MARK_SYMBOL), `added=${JSON.stringify(added)}`],
  ];
  const settingsChecks = [
    ['demoEquityStocks reset to default', sA?.demoEquityStocks !== MARK_EQUITY, `value=${sA?.demoEquityStocks} (mark=${MARK_EQUITY})`],
    ['dailyTradesLimit reset to default', sA?.dailyTradesLimit !== MARK_LIMIT, `value=${sA?.dailyTradesLimit} (mark=${MARK_LIMIT})`],
    ['liveApiKeyStocks not inherited', sA?.liveApiKeyStocks !== MARK_KEY, `value=${JSON.stringify(sA?.liveApiKeyStocks)}`],
    ['liveAccountIdStocks not inherited', sA?.liveAccountIdStocks !== MARK_ACCT, `value=${JSON.stringify(sA?.liveAccountIdStocks)}`],
    ['totalEquity is fresh 25000', st.json?.account?.totalEquity === 25000, `equity=${st.json?.account?.totalEquity} (mark=${MARK_EQUITY})`],
  ];

  const run = (label, checks) => {
    console.log(`\n── ${label}`);
    let bad = 0;
    for (const [name, ok, detail] of checks) {
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
      if (!ok) bad++;
    }
    return bad;
  };
  const treeRed = run('TREE channel — users/<name>/, what wipeAccountData removes (TRA-2410/TRA-2421 scope)', treeChecks);
  const setRed = run('SETTINGS channel — account_settings SQLite row, keyed by raw username (TRA-2520 scope)', settingsChecks);

  console.log('\n' + '='.repeat(68));
  console.log(treeRed ? `TREE     RED — ${treeRed} failed` : 'TREE     GREEN — self-delete freed the name cleanly, with teeth.');
  console.log(setRed ? `SETTINGS RED — ${setRed} failed — the row survived a self-delete` : 'SETTINGS GREEN — the settings row did not survive.');
  console.log(`fixture ${USER} left registered; delete it when done.`);
  process.exit(treeRed + setRed ? 1 : 0);
}

main().catch((e) => { console.log(`HARNESS FAULT: ${e?.message ?? e}`); process.exit(2); });
