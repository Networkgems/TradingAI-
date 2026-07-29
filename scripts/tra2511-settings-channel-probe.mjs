#!/usr/bin/env node
// TRA-2511 — isolate WHICH channel carries state across a username recycle.
//
// The arm-2 run showed an exact inversion between two fingerprints:
//   watchlist  behaves correctly  (retired on re-register, restored on adopt)
//   equity     behaves backwards  (survives re-register, LOST on adopt)
//
// Hypothesis: `account_settings` is a SQLite table keyed by the raw username
// (`account-settings.ts:29`), while `retireOrphanedBook` moves the `users/<name>/`
// DIRECTORY. A directory move cannot touch a database row, so the settings row is
// a fourth channel alongside the three the guard does close (primary dir, backup
// generations, shared option journal).
//
// This probe reads `/api/account/settings` — not a derived engine number — at each
// transition, so the answer does not depend on how `totalEquity` is seeded.
//
// Exit 0 = probe ran (read the verdict); exit 2 = could not run.

const HOST = process.env.TRA2511_HOST ?? 'https://tradingai-bqb1.onrender.com';
const ADMIN_USER = process.env.RENDER_ADMIN_USER ?? process.env.TRADING_ADMIN_USERNAME;
const ADMIN_PASS = process.env.RENDER_ADMIN_PASS ?? process.env.TRADING_ADMIN_PASSWORD;

const MARK_EQUITY = 31337;
const MARK_LIMIT = 7; // dailyTradesLimit — a second settings field, default is not 7
const PASS = 'Qa2511pass!';
const U = `qa_cto2511_probe_${Math.floor(Date.now() / 1000)}`;

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

async function snapshot(label, token) {
  const s = await api('/api/account/settings', { token });
  const st = await api('/api/state', { token });
  const wl = await api('/api/watchlist/stocks', { token });
  const row = {
    label,
    'settings.demoEquity': s.json?.demoEquity,
    'settings.demoEquityStocks': s.json?.demoEquityStocks,
    'settings.dailyTradesLimit': s.json?.dailyTradesLimit,
    'state.totalEquity': st.json?.account?.totalEquity,
    'watchlist.added': JSON.stringify(wl.json?.added ?? []),
  };
  console.log(`\n── ${label}`);
  for (const [k, v] of Object.entries(row)) if (k !== 'label') console.log(`   ${k.padEnd(28)} ${v}`);
  return row;
}

async function main() {
  if (!ADMIN_USER || !ADMIN_PASS) { console.log('HARNESS FAULT: no admin credential'); process.exit(2); }
  const v = await api('/api/health/version');
  console.log(`live SHA ${v.json?.commit} booted ${v.json?.startedAt}`);
  console.log(`fixture  ${U}`);

  const admin = (await api('/api/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } })).json?.token;
  if (!admin) { console.log('HARNESS FAULT: admin login failed'); process.exit(2); }

  // 1 — create and mark, via TWO settings fields so the finding does not rest on
  //     `demoEquity` alone (which is also read by the engine reset path).
  const t1 = (await api('/api/auth/signup', { method: 'POST', body: { username: U, password: PASS, email: `${U}@qa.test` } })).json?.token;
  if (!t1) { console.log('HARNESS FAULT: signup failed'); process.exit(2); }
  await api('/api/account/settings', {
    method: 'PUT', token: t1,
    body: { demoEquity: MARK_EQUITY, demoEquityStocks: MARK_EQUITY, dailyTradesLimit: MARK_LIMIT },
  });
  await api('/api/account/reset-demo', { method: 'POST', token: t1, body: { market: 'stocks' } });
  await api('/api/watchlist/stocks', { method: 'POST', token: t1, body: { symbol: 'ZVZZT' } });
  const before = await snapshot('1. predecessor, marked', t1);

  // 2 — admin delete (retains files by design).
  const del = await api(`/api/admin/users/${U}`, { method: 'DELETE', token: admin });
  console.log(`\n── 2. admin delete → http=${del.status} ${JSON.stringify(del.json)}`);

  // 3 — re-register the SAME name via signup. The guard should have retired the book.
  const t2 = (await api('/api/auth/signup', { method: 'POST', body: { username: U, password: PASS, email: `${U}@qa.test` } })).json?.token;
  if (!t2) { console.log('HARNESS FAULT: re-signup failed'); process.exit(2); }
  const after = await snapshot('3. successor, after re-register', t2);

  // ── Verdict, field by field.
  console.log('\n' + '='.repeat(72));
  const leaked = [];
  const clean = [];
  for (const k of Object.keys(before)) {
    if (k === 'label') continue;
    (before[k] === after[k] && String(before[k]) !== 'undefined' ? leaked : clean).push(
      `${k}: predecessor=${before[k]} successor=${after[k]}`);
  }
  // `watchlist.added` legitimately matches when BOTH are '[]', so re-classify it.
  console.log('CARRIED OVER (successor sees the predecessor value):');
  for (const l of leaked) console.log(`   ${l}`);
  console.log('RESET (successor sees a fresh value):');
  for (const c of clean) console.log(`   ${c}`);

  const settingsLeaked = before['settings.dailyTradesLimit'] === after['settings.dailyTradesLimit']
    && after['settings.dailyTradesLimit'] === MARK_LIMIT;
  console.log('\nVERDICT:');
  console.log(settingsLeaked
    ? `  account_settings LEAKS across a username recycle — successor inherited dailyTradesLimit=${MARK_LIMIT}\n` +
      '  and demoEquity, i.e. the whole AccountSettings row (which also holds saved\n' +
      '  broker credential fields: liveApiKeyOptionsProduction / liveApiKeyOptionsSandbox).'
    : '  account_settings did NOT leak — the successor got default settings.');

  await api(`/api/admin/users/${U}`, { method: 'DELETE', token: admin });
  console.log(`\ncleanup: ${U} removed`);
}

main().catch((e) => { console.log(`HARNESS FAULT: ${e?.message ?? e}`); process.exit(2); });
