#!/usr/bin/env node
// TRA-4747 — why does `/api/trades/export?markets=options` stop at 2026-09-02
// while `/api/health/option-journal` shows 15 closes through 2026-09-18?
//
// The hypothesis under test is the TRA-4358 shape: the export is BOOK-SCOPED
// (`journalRowsForBook(rows, authUser)`, index.ts:10265) while the health route
// is FIRM-WIDE. If every close in the gap window belongs to an account other
// than the authenticated one, the export's `0` is correct-for-this-book and the
// defect is a legibility defect, not a staleness defect. If admin's own rows
// are in the window and still missing, it is a real read bug.
//
// Reads, one login, one beat:
//   /api/health/options-live                                — the pin
//   /api/trades/export?format=json&markets=options          — unfiltered control
//   /api/trades/export?...&from=2026-09-08&to=2026-09-20    — the subject
//   /api/health/option-journal?rows=all                     — firm-wide journal
//
// Prints: per-account close census by ET day, admin-only closes in the window,
// export coverage/scope echo. Exit 0 always (measurement, not a gate).

const BASE = process.env.TRADING_API_BASE ?? 'https://tradingai-bqb1.onrender.com';
const FROM = process.env.TRA4747_FROM ?? '2026-09-08';
const TO = process.env.TRA4747_TO ?? '2026-09-20';

const user = process.env.TRADING_ADMIN_USERNAME;
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!user || !pass) { console.error('creds missing — BLIND'); process.exit(3); }

async function j(url, init) {
  const r = await fetch(url, init);
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch { body = { raw: t.slice(0, 400) }; }
  return { status: r.status, body };
}

const login = await j(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
if (login.status !== 200 || !login.body?.token) {
  console.error('login failed — BLIND', login.status, login.body); process.exit(3);
}
const H = { authorization: `Bearer ${login.body.token}` };

const readAt = new Date().toISOString();
const [live, expAll, expWin, jr, me] = await Promise.all([
  j(`${BASE}/api/health/options-live`, { headers: H }),
  j(`${BASE}/api/trades/export?format=json&markets=options`, { headers: H }),
  j(`${BASE}/api/trades/export?format=json&markets=options&from=${FROM}&to=${TO}`, { headers: H }),
  j(`${BASE}/api/health/option-journal?rows=all`, { headers: H }),
  j(`${BASE}/api/auth/me`, { headers: H }),
]);

const build = live.body?.build ?? {};
console.log('readAt          ', readAt);
console.log('pin             ', JSON.stringify({ commit: build.commitShort ?? build.commit, pid: build.pid, startedAt: build.startedAt }));
console.log('authUser        ', user, '| /auth/me =', JSON.stringify(me.body ?? null).slice(0, 200));
console.log('');

// ── the two export reads ─────────────────────────────────────────────────────
for (const [label, e] of [['UNFILTERED', expAll], [`WINDOW ${FROM}..${TO}`, expWin]]) {
  const s = e.body?.summary ?? {};
  const rows = (e.body?.trades ?? []).filter(r => r.market === 'options');
  const exits = rows.map(r => r.exit_time).filter(Boolean).sort();
  console.log(`export ${label}: status=${e.status} count=${s.count} sources=${JSON.stringify(s.sources)}`);
  console.log(`  scope     = ${JSON.stringify(s.scope ?? null)}`);
  console.log(`  coverage  = ${JSON.stringify(s.coverage?.options ?? null)}`);
  console.log(`  optionRows=${rows.length} earliestExit=${exits[0] ?? null} latestExit=${exits[exits.length - 1] ?? null}`);
  const byStrat = {};
  for (const r of rows) byStrat[r.strategy ?? '(null)'] = (byStrat[r.strategy ?? '(null)'] ?? 0) + 1;
  console.log(`  strategy  = ${JSON.stringify(byStrat)}`);
  console.log('');
}

// ── the firm-wide journal, folded by ACCOUNT ─────────────────────────────────
function findRows(o, depth = 0) {
  if (depth > 6 || o == null || typeof o !== 'object') return null;
  if (Array.isArray(o)) {
    return o.length && typeof o[0] === 'object' && o[0] !== null
      && ('openTs' in o[0] || 'occSymbol' in o[0] || 'account' in o[0]) ? o : null;
  }
  for (const v of Object.values(o)) { const f = findRows(v, depth + 1); if (f) return f; }
  return null;
}
const jrows = findRows(jr.body) ?? [];
console.log(`option-journal: status=${jr.status} rowsFound=${jrows.length} topKeys=${Object.keys(jr.body ?? {}).join(',')}`);

const etDay = ts => typeof ts === 'number' && Number.isFinite(ts)
  ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null;

const closed = jrows.filter(r => typeof r.closeTs === 'number' && Number.isFinite(r.closeTs));
const byAcct = {};
for (const r of closed) {
  const a = r.account ?? '(no account)';
  byAcct[a] ??= { total: 0, inWindow: 0, latest: null, strat: {} };
  const b = byAcct[a];
  b.total++;
  const d = etDay(r.closeTs);
  if (d && d >= FROM && d <= TO) {
    b.inWindow++;
    b.strat[r.strategy ?? r.mode ?? '(null)'] = (b.strat[r.strategy ?? r.mode ?? '(null)'] ?? 0) + 1;
  }
  if (!b.latest || (d && d > b.latest)) b.latest = d;
}
console.log('\nCLOSED journal rows by account:');
for (const [a, b] of Object.entries(byAcct).sort((x, y) => y[1].total - x[1].total)) {
  console.log(`  ${a.padEnd(18)} total=${String(b.total).padStart(4)} latestCloseEtDay=${b.latest} inWindow(${FROM}..${TO})=${b.inWindow} ${b.inWindow ? JSON.stringify(b.strat) : ''}`);
}

// ── the decisive cell: THIS book's closes in the window ──────────────────────
const mine = closed.filter(r => r.account === user);
const mineWin = mine.filter(r => { const d = etDay(r.closeTs); return d && d >= FROM && d <= TO; });
console.log(`\nDECISIVE — account='${user}' closed journal rows in ${FROM}..${TO}: ${mineWin.length}`);
for (const r of mineWin.slice(0, 40)) {
  console.log(`  ${etDay(r.closeTs)} ${r.occSymbol ?? r.symbol} id=${r.id} strategy=${r.strategy} mode=${r.mode} realizedPnlUsd=${r.realizedPnlUsd}`);
}
const mineDays = [...new Set(mine.map(r => etDay(r.closeTs)))].sort();
console.log(`\naccount='${user}' close ET days (last 12): ${mineDays.slice(-12).join(', ')}`);

// also: per-account rows opened but not closed, and the openTs identity-epoch risk
const noAcct = closed.filter(r => r.account == null || r.account === '');
console.log(`\nunattributable (no account) CLOSED rows: ${noAcct.length}  — these are dropped from EVERY book's export by journalRowsForBook`);
const noAcctWin = noAcct.filter(r => { const d = etDay(r.closeTs); return d && d >= FROM && d <= TO; });
console.log(`  ...of which in window: ${noAcctWin.length}`);
