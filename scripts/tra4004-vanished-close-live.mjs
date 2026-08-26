#!/usr/bin/env node
// TRA-4004 — grade the vanished 2026-08-24 BAC close on LIVE bqb1 bytes.
//
// Reads, in one beat, every surface a verdict on this ticket needs:
//   1. the process pin (`build.commitShort` / `pid` / `startedAt`);
//   2. `/api/trades/export?format=json&markets=options` — which BAC closes are
//      SERVED (AC4: the 08-24 close must be a row);
//   3. `/api/health/option-journal?rows=all` — the row `6bbc5d17` itself, its
//      `closeTs`/`exitReason`/`supersededCloses`, and the `closeSupersedes`
//      witness (AC1/AC3: the row's close and who moved it);
//   4. `/api/health/live-options-fee-slippage` — the durable fill the close is
//      priced from (AC5: order 143160792, sell_to_close 1 @ 1.14);
//   5. `/api/health/options-live` `evaluationWindow` — whether the recovered
//      row changes the TRA-3945 window's `n` (AC4's last clause).
//
// Exit 0 = every read succeeded and the verdict lines were printed. A read
// failure exits 3 (BLIND — report NOTHING as pass). Nothing here writes.
//
//   TRADING_ADMIN_USERNAME=… TRADING_ADMIN_PASSWORD=… node scripts/tra4004-vanished-close-live.mjs
//   [--base=https://tradingai-bqb1.onrender.com] [--id=6bbc5d17-…] [--occ=BAC260925C00063000] [--order=143160792]

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const BASE = String(args.base ?? process.env.TRA4004_BASE ?? 'https://tradingai-bqb1.onrender.com').replace(/\/$/, '');
const ROW_ID = String(args.id ?? '6bbc5d17-40da-4999-ab4e-f8920fe42adb');
const OCC = String(args.occ ?? 'BAC260925C00063000');
const ORDER = String(args.order ?? '143160792');
const REAL_CLOSE_ISO = '2026-08-24T20:51:08.062Z';

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

const [live, exp, jr, fs] = await Promise.all([
  j(`${BASE}/api/health/options-live`, { headers: H }),
  j(`${BASE}/api/trades/export?format=json&markets=options`, { headers: H }),
  j(`${BASE}/api/health/option-journal?rows=all`, { headers: H }),
  j(`${BASE}/api/health/live-options-fee-slippage`, { headers: H }),
]);
for (const [name, r] of [['options-live', live], ['export', exp], ['option-journal', jr], ['fee-slippage', fs]]) {
  if (r.status !== 200) { console.error(`${name} read failed`, r.status, JSON.stringify(r.body).slice(0, 300)); process.exit(3); }
}

const b = live.body.build ?? {};
console.log(`TRA-4004 live grade  ${new Date().toISOString()}`);
console.log(`  pin      ${b.commitShort ?? b.commit} pid ${b.pid} startedAt ${b.startedAt}`);

// ── 2. export ───────────────────────────────────────────────────────────────
const trades = exp.body.trades ?? [];
const bac = trades.filter((t) => t.symbol === OCC);
console.log(`  export   ${trades.length} rows, sources ${JSON.stringify(exp.body.summary?.sources ?? null)}; ${bac.length} row(s) on ${OCC}:`);
for (const t of bac) {
  console.log(`           ${t.exit_time}  ${t.exit_reason.padEnd(24)} entry ${t.entry_price} gross ${t.gross_pnl_usd} pnl_r ${t.pnl_r} src=${t.source} basis=${t.pnl_basis} journal=${t.journal_id} ord=${t.broker_order_id}`);
}
const served0824 = bac.find((t) => t.exit_time === REAL_CLOSE_ISO);
console.log(`  AC4      08-24 close ${REAL_CLOSE_ISO} SERVED: ${served0824 ? 'YES' : 'NO'}`);

// ── 3. journal row + witness ────────────────────────────────────────────────
const rows = Array.isArray(jr.body.rows) ? jr.body.rows : null;
if (!rows) { console.error('option-journal rows is not an array — BLIND'); process.exit(3); }
const row = rows.find((r) => r.id === ROW_ID);
const occRows = rows.filter((r) => r.optionSymbol === OCC && r.mode === 'live');
console.log(`  journal  ${rows.length} rows; ${occRows.length} live row(s) on ${OCC}:`);
for (const r of occRows) {
  console.log(`           ${r.id.slice(0, 8)} ${String(r.structure).padEnd(16)} acct=${r.account} ${r.outcome} closeTs=${r.closeTs ? new Date(r.closeTs).toISOString() : null} reason=${r.exitReason} pnl=${r.realizedPnlUsd} R=${r.realizedR} atRisk=${r.atRiskUsd} ord=${r.brokerOrderId ?? null} superseded=${(r.supersededCloses ?? []).length}`);
}
const rowHasRealClose = !!row && row.closeTs === Date.parse(REAL_CLOSE_ISO);
console.log(`  AC1/AC3  ${ROW_ID.slice(0, 8)} carries the 08-24 close: ${rowHasRealClose ? 'YES' : 'NO'}${row?.supersededCloses?.length ? ` (superseded ${row.supersededCloses.map((s) => `${new Date(s.closeTs).toISOString()} ${s.exitReason} ${s.realizedPnlUsd}`).join('; ')})` : ''}`);
const w = jr.body.closeSupersedes;
console.log(`  witness  closeSupersedes ${w ? `total ${w.total} applied ${w.applied} refused ${w.refused} live ${w.live}` : 'ABSENT (route predates TRA-4004 build)'}`);
for (const s of (w?.recent ?? []).slice(-5)) {
  console.log(`           ${s.id.slice(0, 8)} applied=${s.applied} refusal=${s.refusal} reason=${s.reason} ${s.supersededCloseTs ? new Date(s.supersededCloseTs).toISOString() : null} -> ${s.closeTs ? new Date(s.closeTs).toISOString() : null} pnl ${s.supersededRealizedPnlUsd} -> ${s.realizedPnlUsd}`);
}

// ── 4. the fill ─────────────────────────────────────────────────────────────
const fill = (fs.body.records ?? []).find((f) => String(f.orderId) === ORDER && f.optionSymbol === OCC);
console.log(`  AC5      ledger fill ord ${ORDER}: ${fill ? `${new Date(fill.ts).toISOString()} ${fill.side} ${fill.contracts} @ ${fill.filledPrice} fees ${fill.fees} (${fill.feeSource}) origin=${fill.origin}` : 'NOT FOUND'}`);
const gl = (fs.body.autoReconcile?.lastGainLossSample ?? []).find((l) => l.symbol === OCC && l.closeDate === '2026-08-24');
if (gl) console.log(`           Tradier gainloss lot: qty ${gl.quantity} cost ${gl.cost} proceeds ${gl.proceeds} open ${gl.openDate} close ${gl.closeDate}`);

// ── 5. the window ───────────────────────────────────────────────────────────
const ew = live.body.evaluationWindow;
if (ew) {
  console.log(`  window   status=${ew.status} n=${ew.n} startedAt=${ew.startedAt} excludedCloses.n=${ew.excludedCloses?.n} reasons=${JSON.stringify(ew.excludedCloses?.reasons ?? null)}`);
} else {
  console.log('  window   evaluationWindow ABSENT on options-live');
}
console.log('');
console.log(`VERDICT: served=${served0824 ? 'yes' : 'no'} rowCarriesRealClose=${rowHasRealClose ? 'yes' : 'no'} fillMeasured=${fill ? 'yes' : 'no'}`);
