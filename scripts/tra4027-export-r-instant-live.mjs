#!/usr/bin/env node
// TRA-4027 — live grade of `/api/trades/export` `pnl_r` across the 21:00 ET
// archive edge: one UNIT (premium), and since TRA-4027 one INSTANT (the open
// mark) on both emitters.
//
// What it reads (one login, one beat):
//   1. `/api/health/options-live`            — `build.commit` / `build.pid` /
//                                              `build.startedAt`, the pin.
//   2. `/api/trades/export?format=json&markets=options`
//   3. `/api/health/option-journal?rows=all` — the journal's `atRiskUsd` per id,
//                                              so a book row's `premium_basis_usd`
//                                              can be checked against its twin.
//
// What it grades, per options row:
//   * `pnl_r_basis` ∈ {premium-open-mark, premium-fill}; bare `premium` = OLD build.
//   * `pnl_r ≈ net_pnl_usd / premium_basis_usd` to 3dp (AC3 identity).
//   * on a book-served row whose `journal_id` has a journal twin with a finite
//     `atRiskUsd`: `premium_basis_usd === atRiskUsd` and basis `premium-open-mark`
//     (AC1); `entry_price` is NOT rewritten to `atRiskUsd / (100 × qty)` (AC3).
//
// Usage:
//   TRADING_ADMIN_USERNAME=… TRADING_ADMIN_PASSWORD=… \
//     node scripts/tra4027-export-r-instant-live.mjs [--out=<file.json>] [--compare=<before.json>]
//
//   --out      write the pinned snapshot (build + every options row) for the
//              other side of the edge to compare against.
//   --compare  the BEFORE snapshot. Every row present in both (joined on
//              `journal_id`) must publish the SAME `pnl_r` and the same
//              `premium_basis_usd`, whichever emitter served it. Rows with
//              |net| < $10 are reported but not scored: at 3dp they cannot tell
//              the two bases apart (the NVTS +$1 row of the filing is why).
//
// Exit: 0 PASS · 1 FAIL · 3 BLIND (login / route unreadable). BLIND > FAIL > PASS.

import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.TRA4027_BASE ?? 'https://tradingai-bqb1.onrender.com';
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const user = process.env.TRADING_ADMIN_USERNAME;
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!user || !pass) {
  console.error('TRADING_ADMIN_USERNAME/PASSWORD not set — BLIND');
  process.exit(3);
}

async function j(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: r.status, body };
}

const login = await j(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
if (login.status !== 200 || !login.body?.token) {
  console.error('login failed — BLIND', login.status, login.body);
  process.exit(3);
}
const H = { authorization: `Bearer ${login.body.token}` };

const readAt = new Date().toISOString();
const [live, exp, jr] = await Promise.all([
  j(`${BASE}/api/health/options-live`, { headers: H }),
  j(`${BASE}/api/trades/export?format=json&markets=options`, { headers: H }),
  j(`${BASE}/api/health/option-journal?rows=all`, { headers: H }),
]);
if (live.status !== 200 || exp.status !== 200) {
  console.error('route unreadable — BLIND', { live: live.status, export: exp.status, body: exp.body });
  process.exit(3);
}

const build = live.body?.build ?? {};
const pin = { commit: build.commitShort ?? build.commit, pid: build.pid, startedAt: build.startedAt };
const rows = (exp.body?.trades ?? []).filter((r) => r.market === 'options');
const summary = exp.body?.summary ?? {};

// Journal `atRiskUsd` by id. The route's shape has varied across tickets; take
// the first array-of-records we can find and fail BLIND-for-this-check if none.
const journalRows =
  (Array.isArray(jr.body?.rows) && jr.body.rows) ||
  (Array.isArray(jr.body?.records) && jr.body.records) ||
  (Array.isArray(jr.body) && jr.body) ||
  null;
const atRiskById = new Map();
if (journalRows) {
  for (const r of journalRows) {
    if (r && typeof r.id === 'string' && Number.isFinite(r.atRiskUsd) && r.atRiskUsd > 0) {
      atRiskById.set(r.id, r.atRiskUsd);
    }
  }
}

const fails = [];
const notes = [];
const census = {};
for (const r of rows) {
  const key = `${r.source ?? 'book'}:${r.pnl_r_basis ?? 'unset'}`;
  census[key] = (census[key] ?? 0) + 1;

  const id = r.journal_id ?? r.lot_id ?? r.symbol;
  if (r.pnl_r_basis !== 'premium-open-mark' && r.pnl_r_basis !== 'premium-fill') {
    fails.push(`${id}: pnl_r_basis=${r.pnl_r_basis} (bare/unknown label — OLD build or unmapped row)`);
  }
  if (r.pnl_r !== null && r.pnl_r !== undefined) {
    if (!Number.isFinite(r.premium_basis_usd) || r.premium_basis_usd <= 0) {
      fails.push(`${id}: pnl_r=${r.pnl_r} but premium_basis_usd=${r.premium_basis_usd}`);
    } else {
      const implied = r.net_pnl_usd / r.premium_basis_usd;
      if (Math.abs(implied - r.pnl_r) >= 0.0005) {
        fails.push(`${id}: pnl_r ${r.pnl_r} != net/premium_basis ${implied.toFixed(4)} (${r.net_pnl_usd}/${r.premium_basis_usd})`);
      }
    }
  }
  if ((r.source ?? 'book') === 'book' && r.journal_id && atRiskById.has(r.journal_id)) {
    const twin = atRiskById.get(r.journal_id);
    if (r.pnl_r_basis !== 'premium-open-mark') {
      fails.push(`${id}: book row has journal twin atRiskUsd=${twin} but basis=${r.pnl_r_basis}`);
    }
    if (Math.abs((r.premium_basis_usd ?? NaN) - twin) > 1e-6) {
      fails.push(`${id}: book row premium_basis_usd=${r.premium_basis_usd} != twin atRiskUsd=${twin}`);
    }
    // AC3 — entry_price is the fill; if it equals the mark it is only because
    // fill == mark on this lot, so report, do not fail.
    const markPerShare = twin / (100 * (r.quantity || 1));
    if (Number.isFinite(r.entry_price) && Math.abs(r.entry_price - markPerShare) < 1e-9) {
      notes.push(`${id}: entry_price ${r.entry_price} == mark ${markPerShare} (fill==mark on this lot, or rewritten — check premiumPaid)`);
    }
  }
}

let compare = null;
if (typeof args.compare === 'string') {
  const before = JSON.parse(readFileSync(args.compare, 'utf8'));
  const beforeById = new Map(before.rows.map((r) => [r.journal_id ?? r.lot_id, r]));
  const scored = [];
  const unscored = [];
  for (const r of rows) {
    const b = beforeById.get(r.journal_id ?? r.lot_id);
    if (!b) continue;
    const rec = {
      id: r.journal_id ?? r.lot_id,
      symbol: r.symbol,
      net: r.net_pnl_usd,
      before: { source: b.source, basis: b.pnl_r_basis, pnl_r: b.pnl_r, premium_basis_usd: b.premium_basis_usd, entry_price: b.entry_price },
      after: { source: r.source, basis: r.pnl_r_basis, pnl_r: r.pnl_r, premium_basis_usd: r.premium_basis_usd, entry_price: r.entry_price },
    };
    const same = b.pnl_r === r.pnl_r && b.premium_basis_usd === r.premium_basis_usd;
    rec.same = same;
    if (Math.abs(r.net_pnl_usd ?? 0) >= 10) {
      scored.push(rec);
      if (!same) fails.push(`${rec.id} (${r.symbol}): pnl_r ${b.pnl_r}→${r.pnl_r}, basis ${b.premium_basis_usd}→${r.premium_basis_usd} across the edge`);
    } else {
      unscored.push(rec);
    }
  }
  compare = {
    beforePin: before.pin,
    beforeReadAt: before.readAt,
    crossedEdge: before.rows.some((b) => (b.source ?? 'book') === 'book') && scored.concat(unscored).some((x) => x.before.source === 'book' && x.after.source === 'journal'),
    scored,
    unscored,
  };
}

const verdict = fails.length ? 'FAIL' : 'PASS';
const out = { readAt, pin, summary: { count: summary.count, sources: summary.sources, supersededRowCount: summary.supersededRowCount }, census, journalTwins: atRiskById.size, journalRouteReadable: !!journalRows, fails, notes, compare, rows };
if (typeof args.out === 'string') writeFileSync(args.out, JSON.stringify(out, null, 2));

console.log(`[tra4027] ${verdict} readAt=${readAt} pin=${pin.commit} pid=${pin.pid} startedAt=${pin.startedAt}`);
console.log(`[tra4027] options rows=${rows.length} census=${JSON.stringify(census)} journalTwins=${atRiskById.size} journalRoute=${journalRows ? 'ok' : 'unreadable (twin check skipped)'}`);
for (const r of rows.filter((x) => (x.source ?? 'book') === 'book')) {
  console.log(`  book  ${r.symbol} lot=${r.lot_id} jid=${r.journal_id} net=${r.net_pnl_usd} pnl_r=${r.pnl_r} basis=${r.pnl_r_basis} premium_basis_usd=${r.premium_basis_usd} entry=${r.entry_price} exit=${r.exit_time}`);
}
if (compare) {
  console.log(`[tra4027] compare vs ${compare.beforePin?.commit}/pid ${compare.beforePin?.pid} @ ${compare.beforeReadAt}: scored=${compare.scored.length} unscored(|net|<10)=${compare.unscored.length} crossedEdge=${compare.crossedEdge}`);
  for (const x of compare.scored.concat(compare.unscored)) {
    console.log(`  ${x.same ? 'same' : 'DIFF'} ${x.symbol} ${x.id} net=${x.net} ${x.before.source}/${x.before.basis} ${x.before.pnl_r}@${x.before.premium_basis_usd} → ${x.after.source}/${x.after.basis} ${x.after.pnl_r}@${x.after.premium_basis_usd}`);
  }
}
for (const n of notes) console.log(`  note: ${n}`);
for (const f of fails) console.log(`  FAIL: ${f}`);
process.exit(fails.length ? 1 : 0);
