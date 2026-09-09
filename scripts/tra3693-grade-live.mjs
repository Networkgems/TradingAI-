// TRA-3693 one-shot live grade of AC1-AC5 against bqb1. Scratch tool, not shipped.
const HOST = 'https://tradingai-bqb1.onrender.com';
const user = process.env.TRADING_ADMIN_USERNAME || 'admin';
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!pass) { console.error('no TRADING_ADMIN_PASSWORD'); process.exit(2); }

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
if (!login.ok) { console.error('login', login.status); process.exit(2); }
const { token } = await login.json();
const auth = { Authorization: `Bearer ${token}` };

const health = await (await fetch(`${HOST}/api/health/options-live`)).json();
console.log('PIN:', JSON.stringify({ commit: health.build?.commitShort, pid: health.build?.pid, startedAt: health.build?.startedAt, time: health.time }));

const stateRes = await fetch(`${HOST}/api/state`, { headers: auth });
if (!stateRes.ok) { console.error('/api/state', stateRes.status); process.exit(2); }
const state = await stateRes.json();

const all = state.signals || state.recentSignals || [];
const rows = all.filter(s => s.type === 'sma200_pullback' || s.type === 'sma200_reclaim');
console.log(`rows: ${rows.length} sma200 of ${all.length} total; symbols: ${rows.map(r => r.symbol + '/' + r.type).join(', ')}`);

const fin = x => Number.isFinite(x) && x > 0;
let ac1 = true, ac2 = true, ac3 = true, ac4live = true;
for (const r of rows) {
  const p = [];
  if (r.riskRewardRatio !== null || r.takeProfit !== null) { ac1 = false; p.push(`AC1 FAIL rr=${r.riskRewardRatio} tp=${r.takeProfit}`); }
  if (!fin(r.atr14) || !fin(r.stopAtr) || typeof r.stopBasis !== 'string' || !('maxDistAtr' in r)) { ac2 = false; p.push(`AC2 FAIL atr14=${r.atr14} stopAtr=${r.stopAtr} stopBasis=${r.stopBasis} maxDistAtr key=${'maxDistAtr' in r}`); }
  const e1 = Math.abs(r.stopAtr - (r.distAtr + 1.0));
  const e2 = Math.abs((r.entryPrice - r.stopLoss) / r.atr14 - r.stopAtr);
  if (!(e1 < 1e-6 && e2 < 1e-3)) { ac3 = false; p.push(`AC3 FAIL e1=${e1} e2=${e2}`); }
  // dark gate: Infinity serializes to null in JSON — the key must be PRESENT and be null (or a finite echo if a value were set)
  if (!('maxDistAtr' in r) || (r.maxDistAtr !== null && Number.isFinite(r.maxDistAtr))) { ac4live = false; p.push(`AC4 live FAIL maxDistAtr=${r.maxDistAtr}`); }
  const ageH = ((Date.now() - r.barTimestamp) / 3600e3).toFixed(1);
  console.log(`${r.symbol} ${r.type} entry=${r.entryPrice} stop=${r.stopLoss} atr14=${r.atr14} distAtr=${r.distAtr} stopAtr=${r.stopAtr} basis=${r.stopBasis} maxDistAtr=${JSON.stringify(r.maxDistAtr)} rr=${JSON.stringify(r.riskRewardRatio)} tp=${JSON.stringify(r.takeProfit)} barAge=${ageH}h validFor=${r.validForBarTimestamp === r.barTimestamp} ${p.join(' | ')}`);
}
console.log('AC1', ac1 ? 'PASS' : 'FAIL', '| AC2', ac2 ? 'PASS' : 'FAIL', '| AC3', ac3 ? 'PASS' : 'FAIL', '| AC4-live-dark', ac4live ? 'PASS' : 'FAIL');

const voids = state.sma200SignalVoids || [];
console.log(`AC5 voids recorded: ${voids.length}`);
for (const v of voids.slice(-10)) console.log('  void:', JSON.stringify(v));
if (rows.length === 0) console.log('AC5 note: queue EMPTY at grade time — empty is NOT a pass by itself');
