#!/usr/bin/env node
// TRA-3848 — census the artifacts `generateAndSaveReport` mints, per surface,
// each on its OWN denominator.
//
// The filing lists four surfaces reachable through the ungated
// `POST /api/reports/generate`. They do NOT share a denominator and they do not
// share a retention story, so one number cannot cover them:
//
//   S1  `<targetDir>/<date>.json`  archive cell   — permanent, months of history
//   S2  `<targetDir>/latest.json`  replacement    — one value, no history at all
//   S3  daily equity snapshot row (`saveSnapshot`) — permanent, months of history
//   S4  "the EOD ledger row" (TRA-2817)            — see BELOW: same write as S3
//
// ── S3 and S4 are the same disk write ────────────────────────────────────────
// `eod-ledger-gap.ts` states it outright: "`eodRowMissing` per-row — walks
// `days[]`, which is built FROM the persisted snapshots. A session with no
// snapshot is not in `days[]`". And `index.ts:2153` books "the ledger row"
// when the report FILE write fails, leaving "a ledger row whose `eodCombined`
// is null". The ledger row IS the `daily-snapshots.json` row. There are three
// distinct writes on this path, not four, and this census reports three.
//
// ── Why `/api/health/pnl-reconciliation` is a COMPLETE census of S3/S4 ────────
// `engines[]` is built from `getAllUserContexts()` and each `days[]` is built
// from `ctx.tracker.getSnapshots()` — i.e. every row of every book's
// `daily-snapshots.json`, with no window and no calendar filter applied on the
// way out. That is the whole persisted series, so a non-market date key here is
// residue no matter when it was written. NOT retention-bounded.
//
// ── Why S1/S2 are only partly reachable, and what that costs ─────────────────
// No route enumerates archive-cell filenames across books; `GET /api/reports`
// readdirs the CALLER's book only. So S1 gets three instruments, and the census
// says which is a count and which is a floor:
//
//   (a) the JOINT-WITNESS argument — the only non-backfill caller writes S1 and
//       S3 in the SAME invocation, and every step between them is wrapped
//       (`Promise.all(writes)` catch at :2176, the tape drain's own catch at
//       :1580, `writeCloseLedger`'s catch at :2226). So over ALL history a
//       phantom S1 cell implies a phantom S3 row, and the complete S3 census
//       above answers for it. Two enumerated escape hatches, both named in the
//       output rather than waved away.
//   (b) Render logs — `EOD report saved|backfilled` carries `datePath`, so every
//       SUCCESSFUL write is one line naming book, mode and date. Inside the
//       window this is a count, before it this instrument is silent, and the
//       script says so instead of printing a floor as a total.
//
//       ⛔ TWO INSTRUMENT DEFECTS, both found the hard way, both now controlled:
//
//       1. RETENTION IS 7 DAYS ON THIS SERVICE, NOT 30. Measured, not assumed
//          (`measureRetention` below walks T-1d..T-30d and finds the cliff between
//          T-7d REACHABLE and T-8d EMPTY). A 30-day window is accepted by the API
//          and returns 7 days of data with `hasMore:false` — i.e. a silent
//          truncation that reads exactly like "nothing happened in week three".
//          This also corrects TRA-3847's commit message, which claimed 30-day
//          retention; that census's conclusion survives (its writer went live
//          2026-08-13T11:20Z, inside 7 days) but its stated margin did not.
//
//       2. `text=EOD report saved` ALSO MATCHES `crypto EOD report saved` — a
//          different writer, on a 24/7 market, emitting 67 lines every calendar
//          day INCLUDING weekends. Un-anchored, this instrument reported 134
//          phantom Saturday/Sunday stock cells that do not exist. The filter is
//          now anchored on the JSON field (`"msg":"EOD report saved"`) and the
//          crypto cohort is counted separately as a positive control: it MUST be
//          non-zero on a weekend, because that is what distinguishes "the stock
//          writer was correctly silent" from "the reader was blind".
//   (c) the admin book's own `GET /api/reports?mode=live|sandbox` — an exact
//       readdir, one book. `mode=demo` is EXCLUDED on purpose: TRA-1572 unions
//       the firm-wide demo journal's trading days into that list, so it is not a
//       file census (TRA-2407 is the same trap from the other side).
//
// S2 has no history by construction — it is one file that the next EOD
// overwrites. The only measurable question is whether it is a phantom RIGHT NOW.
//
// Exit codes: 0 censused · 2 usage · 3 BLIND (a control failed — publish nothing)

import { readFileSync } from 'node:fs';

const HOST = process.env.HOST_BASE ?? 'https://tradingai-bqb1.onrender.com';
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
const KEY = process.env.RENDER_API_KEY;

const blind = (m) => { console.error(`BLIND — ${m}`); process.exit(3); };

// ── CONTROL 0: the calendar this census grades with must be the deployed one ──
// `isMarketDayIso` is imported from `dist/`, which can lag `src/`. A census run
// against a stale holiday table would grade a real session as a phantom (or the
// reverse) and every number below it would be worthless. Compare the holiday
// literals directly rather than trusting an mtime.
const holidaysOf = (path) => {
  const set = new Set((readFileSync(path, 'utf-8').match(/'2\d{3}-\d{2}-\d{2}'/g) ?? []));
  return [...set].sort().join(',');
};
const hSrc = holidaysOf('packages/server/src/scheduler.ts');
const hDist = holidaysOf('packages/server/dist/scheduler.js');
if (hSrc !== hDist || hSrc.length === 0) {
  blind(`scheduler calendar drift src(${hSrc.split(',').length}) vs dist(${hDist.split(',').length}) — rebuild before censusing`);
}
const { isMarketDayIso } = await import('../packages/server/dist/scheduler.js');
if (isMarketDayIso('2026-08-15') !== false || isMarketDayIso('2026-08-14') !== true) {
  blind('isMarketDayIso failed its Sat/Fri self-test');
}
console.log(`CONTROL 0  calendar src==dist (${hSrc.split(',').length} holiday literals), Sat/Fri self-test OK\n`);

const ver = await fetch(`${HOST}/api/health/version`).then(r => r.json()).catch(() => null);
if (!ver) blind('version route unreachable');
console.log(`live build ${String(ver.commit).slice(0, 7)}  booted ${ver.startedAt}\n`);

// ─────────────────────────────────────────────────────────────────────────────
// S3 / S4 — the persisted snapshot (= ledger) series. COMPLETE, NOT retention-bounded.
// ─────────────────────────────────────────────────────────────────────────────
const recon = await fetch(`${HOST}/api/health/pnl-reconciliation`).then(r => r.json()).catch(() => null);
if (!recon || !Array.isArray(recon.engines)) blind('pnl-reconciliation unreadable');
const engines = recon.engines;
if (engines.length === 0) blind('0 engines — the census would be a vacuous zero');

let rowTotal = 0;
const dateKeys = new Set();
const phantomRows = [];       // {username, mode, date}
const booksWithRows = new Set();
for (const e of engines) {
  const days = Array.isArray(e.days) ? e.days : [];
  if (days.length > 0) booksWithRows.add(e.username);
  for (const d of days) {
    rowTotal += 1;
    dateKeys.add(d.date);
    if (!isMarketDayIso(d.date)) phantomRows.push({ username: e.username, mode: e.mode, date: d.date });
  }
}
const phantomDateKeys = [...dateKeys].filter(d => !isMarketDayIso(d)).sort();
console.log('=== S3/S4  daily-snapshot / EOD-ledger rows  (COMPLETE — no retention bound) ===');
console.log(`denominator : ${rowTotal} rows across ${engines.length} books (${booksWithRows.size} with >=1 row), ${dateKeys.size} distinct date keys`);
console.log(`span        : ${[...dateKeys].sort()[0]} .. ${[...dateKeys].sort().slice(-1)[0]}`);
console.log(`NON-MARKET DATE KEYS : ${phantomDateKeys.length}  ${phantomDateKeys.length ? phantomDateKeys.join(' ') : '(none)'}`);
console.log(`NON-MARKET ROWS      : ${phantomRows.length}`);
for (const p of phantomRows.slice(0, 40)) console.log(`  ${p.date}  ${p.username} (${p.mode})`);

// The joint-witness argument's two escape hatches, stated as measurements not asides.
const cellPresentOnPhantom = phantomRows.length; // graded below if any
console.log(`\njoint-witness escape hatches (a phantom S1 cell WITHOUT a phantom S3 row):`);
console.log(`  1. a backfill call — writes S1, never S3. Bounded by \`missedTradingDays\`, which`);
console.log(`     filters \`isMarketDayIso\` (scheduler.ts:156), so it cannot name a non-session.`);
console.log(`  2. an uncaught throw between the file writes (:2145) and \`saveSnapshot\` (:2281).`);
console.log(`     The wrapped steps cannot do it; \`getEquitySnapshot\`/\`shapeLiveRecordedRow\`/`);
console.log(`     \`loadTradierBalanceSnapshots\` are UNWRAPPED and live-mode-only. Named, not excluded.`);
if (cellPresentOnPhantom === 0) console.log(`  ⇒ with 0 phantom S3 rows, S1 residue can only come from hatch 1 or 2.`);

// ─────────────────────────────────────────────────────────────────────────────
// S2 — `latest.json` right now, per book. It has no history; this is the only question.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== S2  latest.json — current value (no history exists by construction) ===');
const tailBad = [];
for (const e of engines) {
  const d = e.eodTailLatestRowDate;
  if (d && !isMarketDayIso(d)) tailBad.push(`${e.username}:${d}`);
}
console.log(`newest LEDGER row per book, graded: ${engines.length} books, non-market: ${tailBad.length} ${tailBad.join(' ')}`);
console.log(`(the ledger tail is the same-invocation twin of latest.json; the file itself is read below for the admin book)`);

// ─────────────────────────────────────────────────────────────────────────────
// S1 — instrument (c): exact readdir, admin book, file-backed modes only.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== S1  archive cells — admin book, exact readdir (1 book denominator) ===');
if (!KEY) {
  console.log('RENDER_API_KEY unset — admin login and the log census below are SILENT, not zero.');
} else {
  const vars = await fetch(`https://api.render.com/v1/services/${SERVICE}/env-vars?limit=100`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const rows = (vars ?? []).map(x => x.envVar || x);
  const pick = k => rows.find(v => v.key === k)?.value;
  const login = await fetch(`${HOST}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: pick('ADMIN_USERNAME') ?? 'admin', password: pick('ADMIN_PASSWORD') }),
  });
  const lb = await login.json().catch(() => ({}));
  if (!login.ok || !lb.token) {
    console.log(`admin login ${login.status} — this instrument is SILENT, not zero`);
  } else {
    const H = { Authorization: `Bearer ${lb.token}` };
    for (const mode of ['live', 'sandbox']) {   // demo EXCLUDED: TRA-1572 journal union
      const j = await fetch(`${HOST}/api/reports?mode=${mode}`, { headers: H }).then(r => r.json()).catch(() => null);
      const dates = (Array.isArray(j) ? j : j?.dates ?? []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
      const bad = dates.filter(d => !isMarketDayIso(d));
      console.log(`  mode=${mode}: ${dates.length} cells  ${dates.length ? `${dates.sort()[0]}..${dates.sort().slice(-1)[0]}` : ''}  NON-MARKET: ${bad.length} ${bad.join(' ')}`);
    }
    const latest = await fetch(`${HOST}/api/reports/latest?mode=live`, { headers: H }).then(r => r.json()).catch(() => null);
    const ld = latest?.date;
    console.log(`  latest.json (mode=live) date=${ld ?? 'n/a'} → ${ld ? (isMarketDayIso(ld) ? 'SESSION' : '** PHANTOM **') : 'unreadable'}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// S1/S2 — instrument (b): the write log, over the full retention window.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== S1/S2  write log — Render retention window (MEASURED, not assumed) ===');
if (!KEY) {
  console.log('RENDER_API_KEY unset — SILENT.');
  process.exit(0);
}
const END = new Date().toISOString();
// Find the retention cliff before choosing a window. Asking for 30 days on a
// 7-day service returns 7 days with `hasMore:false`, which is indistinguishable
// from "weeks 2-4 were quiet" — a silent truncation reported as a census.
async function measureRetention() {
  const probe = async (d) => {
    const u = new URL('https://api.render.com/v1/logs');
    u.searchParams.set('resource', SERVICE);
    if (OWNER) u.searchParams.set('ownerId', OWNER);
    u.searchParams.set('startTime', new Date(Date.now() - (d + 0.05) * 86_400_000).toISOString());
    u.searchParams.set('endTime', new Date(Date.now() - d * 86_400_000).toISOString());
    u.searchParams.set('limit', '5');
    // Retried for the same reason `pull` is: a transient Loki 503 here would be
    // read as "the window ends at T-7d" and silently shorten the census. An
    // exhausted retry returns null → BLIND, never a shorter window.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500 * attempt));
      const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      return Array.isArray(j.logs) ? j.logs.length : 0;
    }
    return null;
  };
  let deepest = 0;
  for (const d of [1, 3, 5, 6, 7, 8, 10, 14, 21, 30]) {
    const n = await probe(d);
    if (n === null) blind(`retention probe failed at T-${d}d`);
    if (n > 0) deepest = d; else break;
  }
  return deepest;
}
const retentionDays = await measureRetention();
if (retentionDays === 0) blind('no reachable logs at any depth');
console.log(`MEASURED retention: logs reachable at T-${retentionDays}d, empty beyond. Window set to ${retentionDays}d.`);
const START = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function pull({ text = null, limit = 100, endTime = END } = {}) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', START);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit));
  if (text !== null) u.searchParams.set('text', text);
  // Render's log API fronts Loki, which intermittently answers 503/504 under a
  // wide window. Retried with backoff — but NEVER swallowed into an empty array:
  // an aborted read is an undercount, and an undercount that reads as a zero is
  // the exact failure this whole file is built to avoid. After the retries it
  // throws, and the caller exits BLIND rather than publishing a number.
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
    if (r.status === 429 || r.status >= 500) { lastErr = `logs ${r.status}`; continue; }
    if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (j.logs !== null && !Array.isArray(j.logs)) throw new Error('logs field neither null nor array');
    return { lines: j.logs ?? [], hasMore: j.hasMore === true, nextEndTime: j.nextEndTime ?? null };
  }
  throw new Error(`${lastErr} after 4 attempts — refusing to read a failed query as zero`);
}
// Controls: the reader must be live, the filter must match a known-firing needle,
// and it must NOT match an impossible one. Render encodes zero matches and a wrong
// `resource=` identically as `logs: null`.
const c1 = await pull({ limit: 5 });
console.log(`CONTROL 1 reader unfiltered : ${c1.lines.length} line(s) ${c1.lines.length ? 'LIVE' : 'BLIND'}`);
if (c1.lines.length === 0) blind('reader returned 0 unfiltered');
const c3 = await pull({ text: 'tra3848-needle-that-cannot-exist', limit: 5 });
console.log(`CONTROL 3 impossible needle : ${c3.lines.length} (expect 0) ${c3.lines.length ? '** BROKEN OPEN **' : 'OK'}`);
if (c3.lines.length > 0) blind('impossible needle matched');

async function drain(text) {
  const seen = new Set(); const all = [];
  let cursor = END, pages = 0, truncated = false;
  for (;;) {
    const p = await pull({ text, limit: 100, endTime: cursor });
    for (const l of p.lines) { const k = `${l.timestamp}|${l.message}`; if (!seen.has(k)) { seen.add(k); all.push(l); } }
    pages += 1;
    if (!p.hasMore || !p.nextEndTime || p.nextEndTime === cursor) { truncated = p.hasMore; break; }
    cursor = p.nextEndTime;
    if (pages >= 300) { truncated = true; break; }
  }
  return { all, pages, truncated };
}
// `text=` is a substring match, so the STOCK writer's needle is anchored on the
// JSON field. `crypto EOD report saved` is a different function writing
// `crypto-reports/` on a 24/7 market and must not be pooled with it.
const ANCHOR = {
  'stock EOD write': (m) => m.includes('"msg":"EOD report saved"') || m.includes('"msg":"EOD report backfilled"'),
  'crypto EOD write (CONTROL)': (m) => m.includes('"msg":"crypto EOD report saved"'),
};
// Drained with the SUBSTRING needles that are known to work on this API (a bare
// `text=EOD report` returns `logs: null` — the plain-word trap), then classified
// with the anchored predicates above. `EOD report saved` deliberately catches the
// crypto writer too; that is what makes it the control.
const drains = await Promise.all(['EOD report saved', 'EOD report backfilled'].map(drain));
const seenAll = new Set(); const all = [];
for (const d of drains) for (const l of d.all) { const k = `${l.timestamp}|${l.message}`; if (!seenAll.has(k)) { seenAll.add(k); all.push(l); } }
const pages = drains.reduce((a, d) => a + d.pages, 0);
const truncated = drains.some(d => d.truncated);
if (all.length === 0) blind('both write needles returned nothing — the reader is not seeing this writer at all');
console.log(`\ndrained ${all.length} line(s) over ${pages} page(s)${truncated ? '  ** TRUNCATED → every number below is a FLOOR **' : ''}`);
const byFamily = {};
for (const [label, pred] of Object.entries(ANCHOR)) {
  const lines = all.filter(l => pred(l.message));
  const parsed = [];
  for (const l of lines) {
    const m = /(\d{4}-\d{2}-\d{2})\.json/.exec(l.message);
    const u = /users[\\/]([^\\/"]+)[\\/]/.exec(l.message);
    if (m) parsed.push({ date: m[1], username: u?.[1] ?? '?' });
  }
  const bad = parsed.filter(r => !isMarketDayIso(r.date));
  const perDate = {};
  for (const r of parsed) perDate[r.date] = (perDate[r.date] ?? 0) + 1;
  byFamily[label] = { lines: lines.length, parsed: parsed.length, bad, perDate };
  console.log(`\n${label} : ${lines.length} line(s), ${parsed.length} with a parsable date`);
  for (const d of Object.keys(perDate).sort()) {
    console.log(`   ${d}  ${isMarketDayIso(d) ? 'session ' : '** NON-SESSION **'}  n=${perDate[d]}`);
  }
  console.log(`   NON-MARKET writes: ${bad.length} ${bad.slice(0, 20).map(b => `${b.date}/${b.username}`).join(' ')}`);
  if (lines.length - parsed.length > 0) console.log(`   ${lines.length - parsed.length} line(s) carried no parsable date — NOT counted as clean`);
}
const unclassified = all.length - Object.values(byFamily).reduce((a, f) => a + f.lines, 0);
console.log(`\nunclassified "EOD report" lines: ${unclassified}${unclassified ? ' — the taxonomy is hiding something, do not read the zeros above as complete' : ''}`);

// POSITIVE CONTROL. The stock writer being silent on a weekend is the RESULT.
// It is only meaningful if the reader could have seen a weekend write at all —
// the crypto writer, on a 24/7 market, is the thing that proves it could.
const cryptoWeekend = byFamily['crypto EOD write (CONTROL)'].bad.length;
console.log(`CONTROL 4 crypto writes on non-sessions: ${cryptoWeekend} ${cryptoWeekend > 0
  ? '→ the reader CAN see a weekend write; the stock zero is a measurement'
  : '** the reader saw no weekend write at all — the stock zero proves nothing **'}`);

console.log(`\nRETENTION: this instrument covers ${retentionDays} days. The archive cells and the`);
console.log('snapshot series predate that by MONTHS; for them the S3/S4 census above (complete)');
console.log('and the joint-witness argument are the evidence, not this window.');
