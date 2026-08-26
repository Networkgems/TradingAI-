#!/usr/bin/env node
// TRA-4031 AC1 live exercise -- does the FIRST live option close after the fix
// build publish the SAME `entry_price` under `entry_price_basis: 'book-basis'`
// on BOTH sides of the 21:00 ET archive?
//
// The fix (d75510f7) rides the journal CLOSE write, so no row closed before the
// fix build booted can prove it; the unit of grade is a close whose `exit_time`
// is at/after the fix build's `startedAt` (pid 76, 2026-08-26T09:33:28.525Z).
// Read-only. Appends exactly one JSONL line per read to the tape so the
// PRE-archive read (book row) survives to be compared against the POST-archive
// read (journal row) hours later, across heartbeats.
//
//   TRADING_ADMIN_USERNAME=... TRADING_ADMIN_PASSWORD=... \
//     node scripts/tra4031-entry-basis-live.mjs --slot=pre|post
//       [--base=https://tradingai-bqb1.onrender.com]
//       [--since=2026-08-26T09:33:28.525Z] [--fix-commit=d75510f7...]
//       [--tape=evidence/tra4031/entry-basis-tape.jsonl] [--no-tape]
//
// Exit codes:
//   0 PASS     a qualifying close read `book-basis` (or the higher-preference
//              `broker-fill`) with the SAME entry_price on the pre-archive book
//              row and the post-archive journal row.
//   1 PENDING  no qualifying close yet, or only one side is on tape. Roll.
//   2 FAIL     a post-fix journal row reads `pre-trade-mid`, or the two sides
//              disagree on entry_price / basis. The defect, re-occurring.
//   3 BLIND    login/route failed, or the live build does not carry the fix
//              commit by ancestry. Never grade on BLIND.
// Precedence: BLIND > FAIL > PASS > PENDING (a FAIL on any row is a FAIL).

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const SLOT = String(args.slot ?? 'adhoc');
if (!['pre', 'post', 'adhoc'].includes(SLOT)) { console.error('--slot must be pre|post|adhoc'); process.exit(3); }
const BASE = String(args.base ?? 'https://tradingai-bqb1.onrender.com').replace(/\/$/, '');
const SINCE_ISO = String(args.since ?? '2026-08-26T09:33:28.525Z');
const SINCE = Date.parse(SINCE_ISO);
const FIX = String(args['fix-commit'] ?? 'd75510f7b80379761cb380228b18e06833df1460');
const TAPE = String(args.tape ?? 'evidence/tra4031/entry-basis-tape.jsonl');
const WRITE_TAPE = args['no-tape'] !== true;
const OK_BASES = new Set(['book-basis', 'broker-fill']);

const user = process.env.TRADING_ADMIN_USERNAME;
const pass = process.env.TRADING_ADMIN_PASSWORD;

function out(verdict, code, detail) {
  const line = { ts: new Date().toISOString(), slot: SLOT, verdict, ...detail };
  if (WRITE_TAPE) {
    const dir = dirname(TAPE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(TAPE, JSON.stringify(line) + '\n');
  }
  console.log(JSON.stringify(line, null, 2));
  console.log(`VERDICT: ${verdict} (exit ${code})`);
  process.exit(code);
}

async function j(url, init) {
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: { error: String(e) } };
  }
}

function ancestry(liveCommit) {
  // The live SHA must be KNOWN to this checkout and carry the fix by ancestry.
  try { execFileSync('git', ['fetch', '-q', 'origin', 'main'], { stdio: 'ignore' }); } catch { /* offline: grade on what we have */ }
  try { execFileSync('git', ['cat-file', '-e', `${liveCommit}^{commit}`], { stdio: 'ignore' }); } catch { return 'unknown_commit'; }
  try { execFileSync('git', ['merge-base', '--is-ancestor', FIX, liveCommit], { stdio: 'ignore' }); return 'carries_fix'; } catch { return 'predates_fix'; }
}

function priorTape() {
  if (!existsSync(TAPE)) return [];
  return readFileSync(TAPE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

if (!user || !pass) out('BLIND', 3, { reason: 'TRADING_ADMIN_USERNAME/PASSWORD not set' });

const pinRead = await j(`${BASE}/api/health/options-live`);
if (pinRead.status !== 200 || !pinRead.body?.build?.commit) out('BLIND', 3, { reason: 'options-live unreadable', status: pinRead.status });
const pin = { commit: pinRead.body.build.commit, pid: pinRead.body.build.pid, startedAt: pinRead.body.build.startedAt };
const anc = ancestry(pin.commit);
if (anc !== 'carries_fix') out('BLIND', 3, { reason: `live build ${anc}`, pin, fixCommit: FIX });

const login = await j(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
if (login.status !== 200 || !login.body?.token) out('BLIND', 3, { reason: 'login failed', status: login.status, pin });
const H = { authorization: `Bearer ${login.body.token}` };

const fromDay = new Date(SINCE - 24 * 3600_000).toISOString().slice(0, 10);
const ex = await j(`${BASE}/api/trades/export?format=json&markets=options&modes=live&from=${fromDay}`, { headers: H });
if (ex.status !== 200) out('BLIND', 3, { reason: 'export unreadable', status: ex.status, pin });
const rows = Array.isArray(ex.body) ? ex.body : (ex.body.rows ?? ex.body.trades ?? ex.body.data ?? []);
const sources = ex.body.summary?.sources ?? null;

const qualifying = rows
  .filter((r) => Number.isFinite(Date.parse(r.exit_time)) && Date.parse(r.exit_time) >= SINCE)
  .map((r) => ({
    symbol: r.symbol, source: r.source, journal_id: r.journal_id ?? null, lot_id: r.lot_id ?? null,
    entry_price: r.entry_price ?? null, entry_price_basis: r.entry_price_basis ?? null,
    exit_price: r.exit_price ?? null, exit_time: r.exit_time, pnl_basis: r.pnl_basis ?? null,
  }));

// FAIL first: any post-fix JOURNAL row still on the pre-trade mid is the defect.
const regressed = qualifying.filter((q) => q.source === 'journal' && q.entry_price_basis === 'pre-trade-mid');
if (regressed.length) out('FAIL', 2, { reason: 'post-fix journal row publishes pre-trade-mid', pin, sources, qualifying, regressed });

// Pair every qualifying journal row (post-archive) with a book row (pre-archive)
// for the same journal_id from THIS read or a prior tape line.
const prior = priorTape().flatMap((l) => l.qualifying ?? []);
const bookRows = [...qualifying, ...prior].filter((q) => q.source === 'book' && q.journal_id);
const pairs = [];
const mismatches = [];
for (const jr of qualifying.filter((q) => q.source === 'journal')) {
  const pre = bookRows.find((b) => b.journal_id === jr.journal_id);
  if (!pre) continue;
  const same = Number(pre.entry_price) === Number(jr.entry_price) && OK_BASES.has(pre.entry_price_basis) && OK_BASES.has(jr.entry_price_basis);
  (same ? pairs : mismatches).push({ journal_id: jr.journal_id, symbol: jr.symbol, pre: { entry_price: pre.entry_price, basis: pre.entry_price_basis }, post: { entry_price: jr.entry_price, basis: jr.entry_price_basis } });
}
if (mismatches.length) out('FAIL', 2, { reason: 'pre/post entry_price or basis disagree', pin, sources, qualifying, mismatches });
if (pairs.length) out('PASS', 0, { pin, sources, qualifying, pairs, since: SINCE_ISO });

const bookOnly = qualifying.filter((q) => q.source === 'book');
const badBook = bookOnly.filter((q) => !OK_BASES.has(q.entry_price_basis));
if (badBook.length) out('FAIL', 2, { reason: 'post-fix book row lacks book-basis', pin, sources, qualifying, badBook });
out('PENDING', 1, {
  reason: qualifying.length === 0 ? 'no qualifying live close since the fix build' : 'one side on tape; awaiting the other side of the archive',
  pin, sources, qualifying, since: SINCE_ISO,
});
