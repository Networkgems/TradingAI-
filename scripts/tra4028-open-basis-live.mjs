#!/usr/bin/env node
// TRA-4028 — grade (and, on request, APPLY) the entry-basis restatement of the
// 2026-08-21 BAC import row on LIVE bqb1 bytes.
//
// Reads, in one beat:
//   1. the process pin (`build.commitShort` / `pid` / `startedAt`);
//   2. `/api/health/option-journal?rows=all` — the row itself (`atRiskUsd`,
//      `atRiskBasis`, `realizedR`, `supersededOpenBasis[]`) and the
//      `openBasisAmends` witness (AC1 / AC3);
//   3. `/api/health/live-options-fee-slippage` — the `buy_to_open` fills on the
//      OCC the basis is priced from (AC1: the 1.65 engine fill and the 1.17
//      desk fill whose blend is the $141);
//   4. `/api/trades/export?format=json&markets=options&modes=live` — the served
//      `pnl_r` for the row (AC3's grade: −0.026 ± 0.002).
//
// `--apply` POSTs `/api/health/option-journal/amend-open-basis` — DRY RUN
// first, then `?apply=true&confirm=TRA-4028` — and re-reads the export. It
// REFUSES inside RTH (13:30–20:00Z Mon–Fri): the TRA-3945 window re-reads the
// restated R on its next tick and a denominator must not move mid-session.
//
// Exit 0 = every read succeeded and the verdict lines were printed. A read
// failure exits 3 (BLIND — report NOTHING as pass). Nothing writes without
// `--apply`.
//
//   TRADING_ADMIN_USERNAME=… TRADING_ADMIN_PASSWORD=… node scripts/tra4028-open-basis-live.mjs
//   [--base=https://tradingai-bqb1.onrender.com] [--id=6bbc5d17-…] [--occ=BAC260925C00063000]
//   [--entry=1.17] [--provenance='TRA-3958 …'] [--apply] [--rth-override]

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const BASE = String(args.base ?? 'https://tradingai-bqb1.onrender.com').replace(/\/$/, '');
const ROW_ID = String(args.id ?? '6bbc5d17-40da-4999-ab4e-f8920fe42adb');
const OCC = String(args.occ ?? 'BAC260925C00063000');
const ENTRY = Number(args.entry ?? 1.17);
const PROVENANCE = String(args.provenance ?? 'TRA-3958 operator-pinned desk lot basis 1.17 (ledger buy_to_open 1 @ 1.17, history_import 2026-08-20); TRA-4028 AC3');
const APPLY = args.apply === true;
const EXPECTED_R = -0.026;
const TOL = 0.002;

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

function insideRth(d = new Date()) {
  const dow = d.getUTCDay();
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return dow >= 1 && dow <= 5 && m >= 13 * 60 + 30 && m < 20 * 60;
}

const login = await j(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
if (login.status !== 200 || !login.body?.token) { console.error('login failed', login.status, login.body); process.exit(3); }
const H = { authorization: `Bearer ${login.body.token}` };

async function readAll() {
  const [live, jr, fs, exp] = await Promise.all([
    j(`${BASE}/api/health/options-live`, { headers: H }),
    j(`${BASE}/api/health/option-journal?rows=all`, { headers: H }),
    j(`${BASE}/api/health/live-options-fee-slippage`, { headers: H }),
    j(`${BASE}/api/trades/export?format=json&markets=options&modes=live`, { headers: H }),
  ]);
  for (const [name, r] of [['options-live', live], ['option-journal', jr], ['fee-slippage', fs], ['export', exp]]) {
    if (r.status !== 200) { console.error(`${name} read failed`, r.status, JSON.stringify(r.body).slice(0, 300)); process.exit(3); }
  }
  return { live, jr, fs, exp };
}

function printRow(tag, jr, exp) {
  const rows = Array.isArray(jr.body.rows) ? jr.body.rows : null;
  if (!rows) { console.error('option-journal rows is not an array — BLIND'); process.exit(3); }
  const row = rows.find((r) => r.id === ROW_ID);
  if (!row) { console.error(`row ${ROW_ID} NOT in the journal — BLIND`); process.exit(3); }
  console.log(`  ${tag} journal ${ROW_ID.slice(0, 8)} ${row.structure} acct=${row.account} ${row.outcome} atRisk=${row.atRiskUsd} basis=${row.atRiskBasis ?? 'ABSENT'} prov=${row.atRiskProvenance ?? null} pnl=${row.realizedPnlUsd} R=${row.realizedR} contracts=${row.contracts} entryMark=${row.entryMarkUsd ?? null} superseded=${(row.supersededOpenBasis ?? []).map((s) => `${s.atRiskUsd}/${s.realizedR}@${new Date(s.supersededAt).toISOString()}`).join(';') || 'none'}`);
  const t = (exp.body.trades ?? []).find((x) => x.journal_id === ROW_ID);
  console.log(`  ${tag} export  ${t ? `pnl_r ${t.pnl_r} basis=${t.pnl_r_basis} premium_basis_usd=${t.premium_basis_usd} gross=${t.gross_pnl_usd} entry_price=${t.entry_price} src=${t.source}` : 'ROW NOT SERVED'}`);
  const w = jr.body.openBasisAmends;
  console.log(`  ${tag} witness openBasisAmends ${w ? `total ${w.total} applied ${w.applied} refused ${w.refused} live ${w.live}` : 'ABSENT (route predates TRA-4028 build)'}`);
  for (const s of (w?.recent ?? []).slice(-3)) {
    console.log(`           ${s.id.slice(0, 8)} applied=${s.applied} refusal=${s.refusal} ${s.atRiskUsdBefore} -> ${s.atRiskUsdAfter} R ${s.realizedRBefore} -> ${s.realizedRAfter} prov=${s.provenance}`);
  }
  return { row, served: t };
}

const first = await readAll();
const b = first.live.body.build ?? {};
console.log(`TRA-4028 live grade  ${new Date().toISOString()}`);
console.log(`  pin      ${b.commitShort ?? b.commit} pid ${b.pid} startedAt ${b.startedAt}`);

// ── AC1: the fills the blend was made of ────────────────────────────────────
const buys = (first.fs.body.records ?? []).filter((f) => f.optionSymbol === OCC && f.side === 'buy_to_open');
console.log(`  AC1      ledger buy_to_open on ${OCC}: ${buys.map((f) => `${new Date(f.ts).toISOString()} ${f.contracts}@${f.filledPrice} ord=${f.orderId} ${f.origin}`).join(' | ') || 'NONE'}`);
if (buys.length >= 2) {
  const blend = buys.reduce((s, f) => s + f.filledPrice * f.contracts, 0) / buys.reduce((s, f) => s + f.contracts, 0);
  console.log(`           quantity-weighted blend of those fills = ${blend.toFixed(4)} per contract (× 100 × 1 = $${(blend * 100).toFixed(2)})`);
}
const { row: before, served: servedBefore } = printRow('before', first.jr, first.exp);

if (!APPLY) {
  const ok = servedBefore && Math.abs(servedBefore.pnl_r - EXPECTED_R) <= TOL;
  console.log('');
  console.log(`VERDICT: atRiskUsd=${before.atRiskUsd} basis=${before.atRiskBasis ?? 'ABSENT'} export pnl_r=${servedBefore?.pnl_r ?? 'unserved'} AC3(${EXPECTED_R}±${TOL})=${ok ? 'PASS' : 'NOT YET'}  (read-only; pass --apply to restate)`);
  process.exit(0);
}

// ── AC3: apply ──────────────────────────────────────────────────────────────
if (insideRth() && args['rth-override'] !== true) {
  console.error('REFUSING --apply inside RTH (13:30–20:00Z Mon–Fri). Re-run pre-open / post-close, or pass --rth-override with the reason on the ticket.');
  process.exit(4);
}
const payload = JSON.stringify({ id: ROW_ID, entryPremium: ENTRY, provenance: PROVENANCE });
const dry = await j(`${BASE}/api/health/option-journal/amend-open-basis`, {
  method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: payload,
});
console.log(`  dry-run  ${dry.status} ok=${dry.body?.ok} planned=${JSON.stringify(dry.body?.planned ?? null)} fill=${dry.body?.fill ? `${dry.body.fill.contracts}@${dry.body.fill.filledPrice} ${dry.body.fill.origin}` : null} ${dry.body?.error ?? ''}`);
if (dry.status !== 200 || !dry.body?.ok) { console.error('dry run did not plan an amendment — NOT applying', JSON.stringify(dry.body).slice(0, 600)); process.exit(3); }

const wet = await j(`${BASE}/api/health/option-journal/amend-open-basis?apply=true&confirm=TRA-4028${args['rth-override'] === true ? '&rth_override=TRA-4028' : ''}`, {
  method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: payload,
});
console.log(`  apply    ${wet.status} ok=${wet.body?.ok} result=${JSON.stringify(wet.body?.result ?? null)} after=${JSON.stringify(wet.body?.after ?? null)}`);
if (wet.status !== 200 || !wet.body?.ok) { console.error('apply REFUSED', JSON.stringify(wet.body).slice(0, 600)); process.exit(3); }

const second = await readAll();
const { row: after, served: servedAfter } = printRow('after ', second.jr, second.exp);
const b2 = second.live.body.build ?? {};
const samePid = b2.pid === b.pid && b2.startedAt === b.startedAt;
const ok = servedAfter && Math.abs(servedAfter.pnl_r - EXPECTED_R) <= TOL;
console.log('');
console.log(`VERDICT: pid-stable=${samePid} atRiskUsd ${before.atRiskUsd} -> ${after.atRiskUsd} R ${before.realizedR} -> ${after.realizedR} export pnl_r ${servedBefore?.pnl_r} -> ${servedAfter?.pnl_r} AC3(${EXPECTED_R}±${TOL})=${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
