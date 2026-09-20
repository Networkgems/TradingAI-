#!/usr/bin/env node
// TRA-4747 — wait for the deploy carrying the scope census to serve, then GRADE
// the fields on the live pin. "Merged" is not "in force": the whole point of
// this ticket is a surface a grader reads, so the acceptance is the payload off
// bqb1, not the test suite.
//
// Polls `/api/health/options-live` until `build.commit` starts with the target
// sha, then reads the same two export queries the filing did and asserts:
//   * `summary.scope.bookOptionJournalCloses` is a number
//   * `summary.scope.bookLatestOptionJournalCloseIso` is an ISO string or null
//   * both are IDENTICAL across the 0-row and the 106-row read (pre-filter)
//   * the windowed read is still a 200 with count 0 (Q3: no 400 regression)
//   * `coverage.note` carries the OPEN-floor correction
// Exit: 0 PASS, 1 FAIL, 3 BLIND.

const BASE = 'https://tradingai-bqb1.onrender.com';
const TARGET = process.env.TRA4747_SHA ?? 'c5963166';
const DEADLINE = Date.now() + Number(process.env.TRA4747_WAIT_MS ?? 900_000);

const user = process.env.TRADING_ADMIN_USERNAME;
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!user || !pass) { console.error('creds missing - BLIND'); process.exit(3); }

async function j(url, init) {
  try {
    const r = await fetch(url, init);
    const t = await r.text();
    let body; try { body = JSON.parse(t); } catch { body = { raw: t.slice(0, 300) }; }
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: { error: String(e) } }; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function token() {
  const l = await j(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  return l.status === 200 && l.body?.token ? l.body.token : null;
}

let H = null;
let pin = null;
while (Date.now() < DEADLINE) {
  H ??= await (async () => { const t = await token(); return t ? { authorization: `Bearer ${t}` } : null; })();
  if (H) {
    const live = await j(`${BASE}/api/health/options-live`, { headers: H });
    if (live.status === 401) { H = null; continue; }
    const b = live.body?.build ?? {};
    pin = { commit: b.commitShort ?? b.commit, pid: b.pid, startedAt: b.startedAt };
    if (typeof pin.commit === 'string' && pin.commit.startsWith(TARGET)) break;
    console.log(`[${new Date().toISOString()}] serving ${pin.commit} pid ${pin.pid}; waiting for ${TARGET}`);
  }
  await sleep(20_000);
}
if (!pin || !String(pin.commit).startsWith(TARGET)) {
  console.error(`deploy did not land inside the wait window (serving ${pin?.commit}) - BLIND`);
  process.exit(3);
}
console.log(`\nLIVE PIN ${JSON.stringify(pin)}\n`);

const [all, win] = await Promise.all([
  j(`${BASE}/api/trades/export?format=json&markets=options`, { headers: H }),
  j(`${BASE}/api/trades/export?format=json&markets=options&from=2026-09-08&to=2026-09-20`, { headers: H }),
]);

const fails = [];
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails.push(msg); };

const sAll = all.body?.summary ?? {};
const sWin = win.body?.summary ?? {};
console.log('unfiltered scope:', JSON.stringify({ ...sAll.scope, note: undefined }));
console.log('windowed   scope:', JSON.stringify({ ...sWin.scope, note: undefined }));
console.log(`unfiltered count=${sAll.count} sources=${JSON.stringify(sAll.sources)}`);
console.log(`windowed   count=${sWin.count} sources=${JSON.stringify(sWin.sources)} httpStatus=${win.status}\n`);

check(typeof sWin.scope?.bookOptionJournalCloses === 'number',
  'windowed read publishes scope.bookOptionJournalCloses');
check(sWin.scope?.bookLatestOptionJournalCloseIso === null
  || typeof sWin.scope?.bookLatestOptionJournalCloseIso === 'string',
  'windowed read publishes scope.bookLatestOptionJournalCloseIso');
check(sWin.scope?.bookOptionJournalCloses === sAll.scope?.bookOptionJournalCloses
  && sWin.scope?.bookLatestOptionJournalCloseIso === sAll.scope?.bookLatestOptionJournalCloseIso,
  'the census is PRE-FILTER: identical on the 0-row and the unfiltered read');
check(sWin.scope?.bookOptionJournalCloses === sAll.sources?.journal,
  `census (${sWin.scope?.bookOptionJournalCloses}) equals the unfiltered journal row count (${sAll.sources?.journal})`);
check(win.status === 200 && sWin.count === 0,
  'Q3 REGRESSION GUARD: the in-floor empty window is still a served 200, not a 400');
check(typeof sWin.coverage?.note === 'string'
  && sWin.coverage.note.includes('OPEN the journal holds for it, NOT its earliest close'),
  'coverage.note carries the OPEN-floor correction');
check(typeof sWin.scope?.note === 'string' && sWin.scope.note.includes('TRA-4747'),
  'scope.note points the reader at the census before filing staleness');

// The decisive read for the filing: the window starts AFTER this book's newest
// close, so the zero is explained by the payload alone.
const latest = sWin.scope?.bookLatestOptionJournalCloseIso;
console.log(`\nDISCRIMINATOR: window starts 2026-09-08; this book's newest close is ${latest}`);
console.log(latest && latest < '2026-09-08'
  ? '=> the emptiness is EXPLAINED by the response itself. No second request needed.'
  : '=> book has closes at/after the window start; a zero here would need investigation.');

console.log(fails.length ? `\nFAIL (${fails.length})` : '\nPASS');
process.exit(fails.length ? 1 : 0);
