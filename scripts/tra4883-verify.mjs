// TRA-4883 AC3 + AC4 + AC5 — grade the bound OFF THE DEPLOYED BUILD.
// AC4: `retentionDays` is readable on the health surface without grepping source.
// AC5: the `compaction` block proves the boot hook actually RAN (a retention constant
//      that ships without a working hook reads identically to one that works).
// AC3: `/data` freeBytes + the file's own bytes, after.
const HOST = process.env.TRA4883_HOST ?? 'https://tradingai-bqb1.onrender.com';
const user = process.env.TRADING_ADMIN_USERNAME ?? 'admin';
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!pass) { console.error('BLIND — TRADING_ADMIN_PASSWORD unset'); process.exit(3); }

const live = await fetch(`${HOST}/api/health/options-live`).then(r => r.json());
console.log(`# live build ${live.build?.commitShort} pid ${live.build?.pid} startedAt ${live.build?.startedAt} uptimeSec ${live.build?.uptimeSec}`);

// A one-minute window in the far past: `count` 0, `signals` empty, but the ledger-level
// fields are computed all the same. Keeps the probe off the multi-MiB payload.
const thin = new URL(`${HOST}/api/health/reversal-shadow-signals`);
thin.searchParams.set('from', '1');
thin.searchParams.set('to', '2');
const probe = await fetch(thin).then(r => r.json());
console.log('## /api/health/reversal-shadow-signals (AC4 + AC5)');
console.log(JSON.stringify({
  issue: probe.issue,
  flagEnabled: probe.flagEnabled,
  retentionDays: probe.retentionDays,
  compaction: probe.compaction,
  countInWindow: probe.count,
}, null, 2));

const lw = new URL(`${HOST}/api/health/learned-weights`);
lw.searchParams.set('from', '1'); lw.searchParams.set('to', '2');
const lwj = await fetch(lw).then(r => r.json());
console.log(`## /api/health/learned-weights retentionDays = ${lwj.retentionDays}`);

// Oldest surviving record — must sit at or after the published cutoff.
const countTo = async (to) => {
  const u = new URL(`${HOST}/api/health/reversal-shadow-signals`);
  u.searchParams.set('from', '1'); u.searchParams.set('to', String(to));
  return (await fetch(u).then(r => r.json())).count;
};
let lo = Date.UTC(2026, 0, 1), hi = Date.now();
for (let i = 0; i < 48 && hi - lo > 60_000; i++) {
  const mid = Math.floor((lo + hi) / 2);
  if (await countTo(mid) > 0) hi = mid; else lo = mid;
}
console.log(`## oldest surviving record ts <= ${new Date(hi).toISOString()} (cutoff was ${probe.compaction?.cutoff})`);

const l = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
}).then(r => r.json());
const det = await fetch(`${HOST}/api/health/storage/detail`, {
  headers: { Authorization: `Bearer ${l.token}` },
}).then(r => r.json());
const find = (o, p, out = []) => {
  if (Array.isArray(o)) o.forEach(v => find(v, p, out));
  else if (o && typeof o === 'object') { if (p(o)) out.push(o); Object.values(o).forEach(v => find(v, p, out)); }
  return out;
};
const vol = find(det, o => o.path === '/data' && typeof o.freeBytes === 'number')[0];
const f = find(det, o => o.name === 'reversal-shadow-signals.jsonl')[0];
console.log('## /api/health/storage/detail (AC3), read', new Date().toISOString());
console.log(JSON.stringify({
  totalBytes: vol.totalBytes, freeBytes: vol.freeBytes, usedBytes: vol.usedBytes,
  freePct: vol.freePct, minFreePct: vol.minFreePct, belowThreshold: vol.belowThreshold,
}, null, 2));
console.log(`reversal-shadow-signals.jsonl bytes = ${f?.bytes} (allocated ${f?.allocatedBytes})`);

// Top objects, so the "largest object on /data" claim can be re-graded.
const files = find(det, o => o.kind === 'file' && typeof o.bytes === 'number')
  .sort((a, b) => b.bytes - a.bytes).slice(0, 6);
console.log('## largest objects now:');
for (const x of files) console.log(`  ${String(x.bytes).padStart(10)}  ${(x.bytes / 1048576).toFixed(2)} MiB  ${x.name}`);
