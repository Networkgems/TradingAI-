// TRA-3985 — raw dump of every surface's RIG260925C00006000 rows (journal, export ±mode filter, state).
const BASE = 'https://tradingai-bqb1.onrender.com';
const SVC = 'srv-d7mb7rr7uimc73ev0chg';
const RIG = 'RIG260925C00006000';
async function j(url, init) { const r = await fetch(url, init); let body = null; try { body = await r.json(); } catch {} return { status: r.status, body }; }
let pass = process.env.TRADING_ADMIN_PASSWORD;
if (!pass) {
  const ev = await j(`https://api.render.com/v1/services/${SVC}/env-vars?limit=100`, { headers: { authorization: `Bearer ${process.env.RENDER_API_KEY}` } });
  pass = ev.body.map((x) => x.envVar ?? x).find((x) => x.key === 'ADMIN_PASSWORD')?.value;
}
const login = await j(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: pass }) });
const H = { authorization: `Bearer ${login.body.token}` };
const [jr, expLive, expAll, st, health] = await Promise.all([
  j(`${BASE}/api/health/option-journal?rows=all`, { headers: H }),
  j(`${BASE}/api/trades/export?format=json&markets=options&modes=live`, { headers: H }),
  j(`${BASE}/api/trades/export?format=json&markets=options`, { headers: H }),
  j(`${BASE}/api/state`, { headers: H }),
  j(`${BASE}/api/health/options-live`),
]);
console.log('build', String(health.body?.build?.commit).slice(0, 12), 'pid', health.body?.build?.pid, 'now', new Date().toISOString());
const rows = jr.body?.rows ?? [];
console.log('journal keys:', Object.keys(jr.body ?? {}).join(','));
console.log('\n=== JOURNAL rows for RIG:');
for (const r of rows.filter((r) => (r.optionSymbol ?? r.symbol) === RIG)) console.log(JSON.stringify(r, null, 1));
for (const [name, e] of [['EXPORT modes=live', expLive], ['EXPORT all modes', expAll]]) {
  const t = (e.body?.trades ?? []).filter((t) => t.symbol === RIG);
  console.log(`\n=== ${name}: rows=${(e.body?.trades ?? []).length} summary=${JSON.stringify(e.body?.summary)} RIG rows=${t.length}`);
  for (const x of t) console.log(JSON.stringify(x, null, 1));
}
const opts = st.body?.options ?? {};
console.log('\n=== STATE options keys:', Object.keys(opts).join(','));
for (const k of Object.keys(opts)) {
  const v = opts[k];
  if (Array.isArray(v)) {
    const hit = v.filter((x) => x && (x.optionSymbol === RIG || x.symbol === RIG));
    if (hit.length) { console.log(`--- state.options.${k} RIG rows=${hit.length}`); for (const x of hit) console.log(JSON.stringify(x, null, 1)); }
  }
}
