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
  if (Number.isFinite(bootedAt)) {
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

  // Mark the book so "clean afterwards" is a discriminating claim, not a tautology.
  await api('/api/watchlist/stocks', { method: 'POST', token, body: { symbol: MARK_SYMBOL } });
  const wlBefore = await api('/api/watchlist/stocks', { token });
  const marked = (wlBefore.json?.added ?? []).includes(MARK_SYMBOL);
  console.log(`\npredecessor marked: watchlist.added=${JSON.stringify(wlBefore.json?.added)}`);
  if (!marked) { console.log('HARNESS FAULT: fingerprint did not take'); process.exit(2); }

  // ── Self-delete. The receipt is the instrument.
  const del = await api('/api/account', { method: 'DELETE', token });
  console.log(`\nDELETE /api/account → http=${del.status}`);
  console.log(JSON.stringify(del.json, null, 1));
  const receipt = del.json?.receipt ?? del.json;
  const gens = receipt?.backupGenerationsWithData;
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

  const checks = [
    ['token revoked on delete', afterTok.status === 401, `http=${afterTok.status}`],
    ['equity is fresh 25000', st.json?.account?.totalEquity === 25000, `equity=${st.json?.account?.totalEquity}`],
    ['0 open positions', st.json?.account?.openPositions?.length === 0, `n=${st.json?.account?.openPositions?.length}`],
    ['0 closed positions', st.json?.closedPositions?.length === 0, `n=${st.json?.closedPositions?.length}`],
    ['0 open options', st.json?.options?.openOptions?.length === 0, `n=${st.json?.options?.openOptions?.length}`],
    [`predecessor ${MARK_SYMBOL} not adopted`, !added.includes(MARK_SYMBOL), `added=${JSON.stringify(added)}`],
  ];
  console.log('');
  let red = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
    if (!ok) red++;
  }

  console.log('\n' + '='.repeat(68));
  console.log(red ? `ARM 1 RED — ${red} failed` : 'ARM 1 GREEN — self-delete freed the name cleanly, with teeth.');
  console.log(`fixture ${USER} left registered; delete it when done.`);
  process.exit(red ? 1 : 0);
}

main().catch((e) => { console.log(`HARNESS FAULT: ${e?.message ?? e}`); process.exit(2); });
