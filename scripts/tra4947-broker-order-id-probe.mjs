// TRA-4947 — grade the `brokerOrderId === null` conjunct from a surface that
// actually CARRIES it.
//
// Why this script exists: `CloseBasisPlanRow` has no `brokerOrderId` field, so
// the dry-run plan reads `undefined` for EVERY row and any predicate ANDed with
// `brokerOrderId == null` is vacuously true there. The 32-of-32 "W1" reading in
// tra4947-population-gate.mjs is that artefact, NOT the measured tape-wide
// false-positive population. `/api/trades/export?format=json` publishes
// `broker_order_id` off the journal record (export-history.ts:622, `??` so a
// numeric 0 survives), which is the same field the planner reads.
const HOST = process.env.TRA4947_HOST ?? 'https://tradingai-bqb1.onrender.com';
const user = process.env.TRADING_ADMIN_USERNAME ?? 'admin';
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!pass) { console.error('BLIND — TRADING_ADMIN_PASSWORD unset'); process.exit(3); }

const ver = await fetch(`${HOST}/api/health/options-live`).then((r) => r.json());
console.log(`# serving commit ${ver.build?.commit} pid ${ver.build?.pid}`);
console.log(`# read at ${new Date().toISOString()}`);

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) { console.error(`login ${login.status}`); process.exit(3); }

const url = `${HOST}/api/trades/export?format=json&modes=live&markets=options&from=2026-07-31&to=2026-10-02`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${lb.token}` } });
const body = await res.json();
console.log(`# GET ${url.replace(HOST, '')} -> ${res.status}`);
if (!res.ok) { console.error(JSON.stringify(body).slice(0, 800)); process.exit(3); }
const rows = body.rows ?? body.trades ?? body.data ?? [];
console.log(`# rows=${rows.length}  keys=${JSON.stringify(Object.keys(rows[0] ?? {})).slice(0, 400)}`);

const closed = rows.filter((r) => r.exit_reason != null || r.outcome !== 'OPEN');
let withOrder = 0;
let withoutOrder = 0;
const reconcileNoOrder = [];
for (const r of closed) {
  const hasOrder = r.broker_order_id !== null && r.broker_order_id !== undefined;
  if (hasOrder) withOrder += 1; else withoutOrder += 1;
  if (r.exit_reason === 'broker_reconcile' && !hasOrder) reconcileNoOrder.push(r);
}
console.log(`\n# closed live export rows: ${closed.length}`);
console.log(`#   broker_order_id PRESENT : ${withOrder}`);
console.log(`#   broker_order_id NULL    : ${withoutOrder}   <= the W1 population (brokerOrderId===null ALONE)`);
console.log(`#   exit_reason===broker_reconcile && no order : ${reconcileNoOrder.length}`);
for (const r of reconcileNoOrder) {
  console.log(`      journal_id=${r.journal_id} ${r.option_symbol ?? r.occ_symbol} net_pnl_usd=${r.net_pnl_usd} pnl_r=${r.pnl_r} outcome=${r.outcome} pnl_basis=${r.pnl_basis}`);
}

console.log('\n# the two broker_reconcile rows, in full (the W3 pair)');
for (const r of closed) {
  if (r.exit_reason !== 'broker_reconcile') continue;
  console.log(`  ${r.journal_id} ${r.option_symbol ?? r.occ_symbol} broker_order_id=${JSON.stringify(r.broker_order_id)} net_pnl_usd=${r.net_pnl_usd} outcome=${r.outcome} premium_basis_usd=${r.premium_basis_usd} pnl_basis=${r.pnl_basis}`);
}
