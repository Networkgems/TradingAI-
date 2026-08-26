// TRA-3985 Defect 2 — can the ledger say WHICH lot an OTM exit consumed?
//
// Reads LIVE bqb1 (pin the build first), then for every export row with
// `exit_reason` set, joins it to the journal on `journal_id` and asks whether
// that journal id is UNIQUE among the rows sharing the same optionSymbol. If two
// lots (a closed one and a surviving residual) carry the same `journal_id`, the
// `journal_id` join is AMBIGUOUS and Defect 2 is not closed by a journal-side join.
//
// Usage:
//   RENDER_API_KEY=… node scripts/tra3985-lot-attribution-live.mjs
//   (or TRADING_ADMIN_PASSWORD=… to skip the Render read)
// Exit codes: 0 = every exit uniquely attributable, 2 = ambiguity found, 3 = BLIND.

const BASE = 'https://tradingai-bqb1.onrender.com';
const SVC = 'srv-d7mb7rr7uimc73ev0chg';
const user = process.env.TRADING_ADMIN_USERNAME ?? 'admin';
let pass = process.env.TRADING_ADMIN_PASSWORD;

async function j(url, init) {
  const r = await fetch(url, init);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

if (!pass) {
  const key = process.env.RENDER_API_KEY;
  if (!key) { console.error('need TRADING_ADMIN_PASSWORD or RENDER_API_KEY — BLIND'); process.exit(3); }
  const ev = await j(`https://api.render.com/v1/services/${SVC}/env-vars?limit=100`, { headers: { authorization: `Bearer ${key}` } });
  if (ev.status !== 200 || !Array.isArray(ev.body)) { console.error('render env-vars read failed', ev.status); process.exit(3); }
  const hit = ev.body.map((x) => x.envVar ?? x).find((x) => x.key === 'ADMIN_PASSWORD');
  if (!hit?.value) { console.error('ADMIN_PASSWORD not in render env-vars — BLIND'); process.exit(3); }
  pass = hit.value;
}

const health = await j(`${BASE}/api/health/options-live`);
const build = health.body?.build ?? {};
console.log(`build ${String(build.commit).slice(0, 12)} pid ${build.pid} startedAt ${build.startedAt}`);
const posture = health.body?.liveDayOneStopPosture ?? {};
console.log(`liveDayOneStopPosture population=${posture.population} books=${posture.books} rows=${posture.rows} otm=${JSON.stringify(posture.otmDayOneStop && { atrLegRows: posture.otmDayOneStop.atrLegRows, atrLegInertRows: posture.otmDayOneStop.atrLegInertRows, atrLegPopulationRows: posture.otmDayOneStop.atrLegPopulationRows })}`);

const login = await j(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
if (login.status !== 200 || !login.body?.token) { console.error('login failed', login.status); process.exit(3); }
const H = { authorization: `Bearer ${login.body.token}` };

const [jr, exp, st] = await Promise.all([
  j(`${BASE}/api/health/option-journal?rows=all`, { headers: H }),
  j(`${BASE}/api/trades/export?format=json&markets=options&modes=live`, { headers: H }),
  j(`${BASE}/api/state`, { headers: H }),
]);
for (const [name, r] of [['option-journal', jr], ['export', exp], ['state', st]]) {
  if (r.status !== 200) { console.error(`${name} -> ${r.status} — BLIND`); process.exit(3); }
}
const rows = jr.body?.rows ?? jr.body?.journal?.rows ?? jr.body?.entries;
const trades = exp.body?.trades ?? exp.body?.rows ?? exp.body;
if (!Array.isArray(rows) || !Array.isArray(trades)) { console.error('journal rows / export trades not arrays — BLIND', Object.keys(jr.body ?? {}), Object.keys(exp.body ?? {})); process.exit(3); }
console.log(`journal rows=${rows.length} export rows=${trades.length} sources=${JSON.stringify(exp.body?.summary?.sources ?? null)}`);

const open = st.body?.options?.openOptions ?? [];
console.log(`/api/state openOptions=${open.length}`);
for (const o of open) console.log(`  OPEN ${o.optionSymbol} journalId=${o.journalId ?? o.id} id=${o.id} openedAt=${o.openedAt} premiumPaid=${o.premiumPaid} atrLevel=${o.otmAtrInvalidationLevel ?? 'ABSENT'} deskAddBasis=${JSON.stringify(o.deskAddBasis ?? null)}`);

// journal rows grouped by option symbol
const sym = (r) => r.optionSymbol ?? r.symbol ?? r.contract;
const byId = new Map(rows.map((r) => [r.id, r]));
const bySym = new Map();
for (const r of rows) { const s = sym(r); if (!bySym.has(s)) bySym.set(s, []); bySym.get(s).push(r); }

const exits = trades.filter((t) => t.exit_reason);
let ambiguous = 0;
console.log(`\nexport rows with exit_reason: ${exits.length}`);
for (const t of exits) {
  const jid = t.journal_id;
  const twin = jid ? byId.get(jid) : undefined;
  const siblings = bySym.get(t.symbol) ?? [];
  const sameJid = siblings.filter((r) => r.id === jid || r.journalId === jid);
  const openSameJid = open.filter((o) => o.optionSymbol === t.symbol && (o.journalId === jid || o.id === jid));
  const amb = openSameJid.length > 0 || sameJid.length > 1;
  if (amb) ambiguous++;
  console.log(`  ${amb ? 'AMBIG' : 'ok   '} ${t.symbol} exit=${t.exit_reason} lot_id=${t.lot_id} journal_id=${jid} broker_order_id=${t.broker_order_id} closedAt=${t.exit_time ?? t.closed_at ?? t.exitAt} entry=${t.entry_price} exit=${t.exit_price} net=${t.net_pnl ?? t.net} | journal twin=${twin ? `${twin.status ?? '?'} opened=${twin.openedAt} premiumPaid=${twin.premiumPaid} lots=${JSON.stringify(twin.lots ?? twin.fills ?? null)?.slice(0, 200)}` : 'NONE'} | journal rows same symbol=${siblings.length} same jid=${sameJid.length} OPEN state rows sharing jid=${openSameJid.length}`);
}

// RIG deep-dive: every journal row and every open row for the motivating contract
const RIG = 'RIG260925C00006000';
console.log(`\nRIG journal rows (${(bySym.get(RIG) ?? []).length}):`);
for (const r of bySym.get(RIG) ?? []) console.log('  ' + JSON.stringify({ id: r.id, journalId: r.journalId, status: r.status, openedAt: r.openedAt, closedAt: r.closedAt, premiumPaid: r.premiumPaid, exitPrice: r.exitPrice, exitReason: r.exitReason, brokerOrderId: r.brokerOrderId ?? r.broker_order_id, lotId: r.lotId ?? r.lot_id, adoptionAuthority: r.adoptionAuthority, deskAddBasis: r.deskAddBasis }));
const rigExport = trades.filter((t) => t.symbol === RIG);
console.log(`RIG export rows (${rigExport.length}):`);
for (const t of rigExport) console.log('  ' + JSON.stringify({ lot_id: t.lot_id, journal_id: t.journal_id, broker_order_id: t.broker_order_id, source: t.source, entry: t.entry_price, exit: t.exit_price, exit_reason: t.exit_reason, pnl_basis: t.pnl_basis, net: t.net_pnl ?? t.net }));

console.log(`\nVERDICT: ${ambiguous === 0 ? 'every exit uniquely attributable via journal_id' : `${ambiguous} exit row(s) whose journal_id is SHARED with another lot (open or journal) — journal_id join is AMBIGUOUS`}`);
process.exit(ambiguous === 0 ? 0 : 2);
