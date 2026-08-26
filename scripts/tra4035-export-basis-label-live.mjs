#!/usr/bin/env node
// TRA-4035 — grade the `pnl_r_basis` LABEL on LIVE bqb1 bytes against the journal's
// own `atRiskBasis` (TRA-4028), row by row, for every served options row.
//
// Reads, in one beat:
//   1. the process pin (`build.commitShort` / `pid` / `startedAt`) off
//      `/api/health/options-live`;
//   2. `/api/health/option-journal?rows=all` — per row `atRiskBasis`, `structure`;
//   3. `/api/trades/export?format=json&markets=options&modes=live` — per row
//      `pnl_r_basis`, `premium_basis_usd`, `pnl_r`, `source`, `journal_id`.
//
// The predicate, per served row joined on `journal_id`:
//   journal `atRiskBasis === 'fill'`  ⇒ export `pnl_r_basis === 'premium-fill'`
//   anything else ('mark' / ABSENT)   ⇒ export `pnl_r_basis === 'premium-open-mark'`
//   (a BOOK-served row with NO twin is inline ⇒ 'premium-fill' by construction and
//   is reported, not graded, since it has no journal statement to grade against)
//
// AC3 named rows: BAC `6bbc5d17` (fill ⇒ premium-fill, pnl_r -0.026, basis 117) and
// SPY `b1c20694` (whatever its journal says). Every engine `single_leg_otm` row must
// still read 'premium-open-mark' (its open IS the scanner mark; no field).
//
// Exit 0 = PASS on every graded row; 1 = at least one mismatch; 3 = BLIND (a read
// failed — report NOTHING as pass). Read-only; writes nothing.
//
//   TRADING_ADMIN_USERNAME=… TRADING_ADMIN_PASSWORD=… node scripts/tra4035-export-basis-label-live.mjs
//   [--base=https://tradingai-bqb1.onrender.com] [--expect-pin=fbc80542]

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const BASE = String(args.base ?? 'https://tradingai-bqb1.onrender.com').replace(/\/$/, '');
const EXPECT_PIN = args['expect-pin'] ? String(args['expect-pin']) : null;
const BAC_ID = '6bbc5d17-40da-4999-ab4e-f8920fe42adb';
const SPY_PREFIX = 'b1c20694';

const user = process.env.TRADING_ADMIN_USERNAME;
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!user || !pass) { console.error('TRADING_ADMIN_USERNAME/PASSWORD not set — BLIND'); process.exit(3); }

async function j(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: r.status, body };
}

const login = await j(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
if (login.status !== 200 || !login.body?.token) { console.error('login failed', login.status, login.body); process.exit(3); }
const H = { authorization: `Bearer ${login.body.token}` };

const [live, jr, exp] = await Promise.all([
  j(`${BASE}/api/health/options-live`, { headers: H }),
  j(`${BASE}/api/health/option-journal?rows=all`, { headers: H }),
  j(`${BASE}/api/trades/export?format=json&markets=options&modes=live`, { headers: H }),
]);
for (const [name, r] of [['options-live', live], ['option-journal', jr], ['export', exp]]) {
  if (r.status !== 200) { console.error(`${name} read failed`, r.status, JSON.stringify(r.body).slice(0, 300)); process.exit(3); }
}
const b = live.body.build ?? {};
const pin = String(b.commitShort ?? b.commit ?? '');
console.log(`TRA-4035 live label grade  ${new Date().toISOString()}`);
console.log(`  pin      ${pin} pid ${b.pid} startedAt ${b.startedAt}`);
if (EXPECT_PIN && !pin.startsWith(EXPECT_PIN)) {
  console.error(`  pin ${pin} is not ${EXPECT_PIN} — the bytes under test are not serving. BLIND.`);
  process.exit(3);
}

const rows = Array.isArray(jr.body.rows) ? jr.body.rows : null;
const trades = Array.isArray(exp.body.trades) ? exp.body.trades : null;
if (!rows || !trades) { console.error('journal rows / export trades not arrays — BLIND'); process.exit(3); }
const byId = new Map(rows.map((r) => [r.id, r]));

const expectedLabel = (atRiskBasis) => (atRiskBasis === 'fill' ? 'premium-fill' : 'premium-open-mark');
const tally = { graded: 0, pass: 0, fail: 0, inlineNoTwin: 0, byStructure: {} };
const failures = [];
for (const t of trades) {
  const twin = t.journal_id ? byId.get(t.journal_id) : undefined;
  if (!twin) { tally.inlineNoTwin += 1; continue; }
  const want = expectedLabel(twin.atRiskBasis);
  const ok = t.pnl_r_basis === want;
  tally.graded += 1;
  tally[ok ? 'pass' : 'fail'] += 1;
  const s = twin.structure ?? '?';
  const bucket = (tally.byStructure[s] ??= { rows: 0, fill: 0, mark: 0, absent: 0, labels: {} });
  bucket.rows += 1;
  bucket[twin.atRiskBasis === 'fill' ? 'fill' : twin.atRiskBasis === 'mark' ? 'mark' : 'absent'] += 1;
  bucket.labels[t.pnl_r_basis] = (bucket.labels[t.pnl_r_basis] ?? 0) + 1;
  if (!ok) failures.push({ id: t.journal_id, sym: t.symbol, structure: s, atRiskBasis: twin.atRiskBasis ?? 'ABSENT', got: t.pnl_r_basis, want });
}

console.log(`  census   served ${trades.length} | graded (twinned) ${tally.graded} | PASS ${tally.pass} | FAIL ${tally.fail} | inline no-twin ${tally.inlineNoTwin}`);
for (const [s, v] of Object.entries(tally.byStructure)) {
  console.log(`           ${s.padEnd(16)} rows ${v.rows}  basis fill/mark/absent ${v.fill}/${v.mark}/${v.absent}  labels ${JSON.stringify(v.labels)}`);
}
for (const f of failures) console.log(`  FAIL     ${f.id.slice(0, 8)} ${f.sym} ${f.structure} atRiskBasis=${f.atRiskBasis} got=${f.got} want=${f.want}`);

// Named AC3 rows.
function named(tag, pred) {
  const t = trades.find(pred);
  const twin = t?.journal_id ? byId.get(t.journal_id) : undefined;
  if (!t) { console.log(`  ${tag} NOT SERVED`); return null; }
  console.log(`  ${tag} journal atRisk=${twin?.atRiskUsd} basis=${twin?.atRiskBasis ?? 'ABSENT'} | export pnl_r=${t.pnl_r} pnl_r_basis=${t.pnl_r_basis} premium_basis_usd=${t.premium_basis_usd} src=${t.source}`);
  return { t, twin };
}
const bac = named('BAC 6bbc5d17', (t) => t.journal_id === BAC_ID);
const spy = named('SPY b1c20694', (t) => typeof t.journal_id === 'string' && t.journal_id.startsWith(SPY_PREFIX));
const bacOk = !!bac && bac.t.pnl_r_basis === 'premium-fill' && Math.abs(bac.t.pnl_r - (-0.026)) <= 0.002 && bac.t.premium_basis_usd === 117;
const engine = tally.byStructure.single_leg_otm;
const engineOk = !engine || (engine.labels['premium-open-mark'] === engine.rows);

// Positive control on the predicate: it must be able to fail. A copy of the BAC
// row with the label flipped must read FAIL, or the census above is vacuous.
const controlFires = bac ? expectedLabel(bac.twin?.atRiskBasis) !== 'premium-open-mark' : false;

console.log('');
console.log(`VERDICT: rows ${tally.pass}/${tally.graded} label==f(atRiskBasis) | BAC(fill=>premium-fill,-0.026,117)=${bacOk ? 'PASS' : 'FAIL'} | engine single_leg_otm all open-mark=${engineOk ? 'PASS' : 'FAIL'} (${engine ? engine.rows : 0} rows) | SPY=${spy ? spy.t.pnl_r_basis : 'unserved'} | control(BAC flipped would FAIL)=${controlFires ? 'FIRES' : 'VACUOUS'}`);
process.exit(tally.fail === 0 && bacOk && engineOk && controlFires ? 0 : 1);
