// TRA-4883 AC1 — measure `reversal-shadow-signals.jsonl` on bqb1: current bytes off
// the admin storage detail, and the earliest/latest record timestamps INSIDE the file
// off the open `/api/health/reversal-shadow-signals` probe (bisected on `?to=` / `?from=`
// so we never pull the whole 133 MiB ledger over the wire).
const HOST = process.env.TRA4883_HOST ?? 'https://tradingai-bqb1.onrender.com';
const user = process.env.TRADING_ADMIN_USERNAME ?? 'admin';
const pass = process.env.TRADING_ADMIN_PASSWORD;
if (!pass) { console.error('BLIND — TRADING_ADMIN_PASSWORD unset'); process.exit(3); }

const ver = await fetch(`${HOST}/api/health/options-live`).then(r => r.json());
console.log(`# live ${ver.build?.commitShort} pid ${ver.build?.pid} startedAt ${ver.build?.startedAt}`);

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) { console.error(`login ${login.status} ${JSON.stringify(lb).slice(0,200)}`); process.exit(3); }

const det = await fetch(`${HOST}/api/health/storage/detail`, {
  headers: { Authorization: `Bearer ${lb.token}` },
});
console.log(`# GET /api/health/storage/detail -> ${det.status}`);
const dj = await det.json();
const blob = JSON.stringify(dj);
// Print the volume figures and every entry mentioning our file.
const find = (o, pred, out = []) => {
  if (Array.isArray(o)) o.forEach(v => find(v, pred, out));
  else if (o && typeof o === 'object') {
    if (pred(o)) out.push(o);
    Object.values(o).forEach(v => find(v, pred, out));
  }
  return out;
};
const vol = find(dj, o => typeof o.freeBytes === 'number' || typeof o.free === 'number');
console.log('## volume rows:');
for (const v of vol.slice(0, 4)) console.log(JSON.stringify(v).slice(0, 600));
const mine = find(dj, o => typeof o.name === 'string' && o.name.includes('reversal-shadow'))
  .concat(find(dj, o => typeof o.path === 'string' && o.path.includes('reversal-shadow')));
console.log('## reversal-shadow rows:');
for (const m of mine.slice(0, 6)) console.log(JSON.stringify(m).slice(0, 400));
if (mine.length === 0) {
  const i = blob.indexOf('reversal-shadow');
  console.log('## raw slice:', i >= 0 ? blob.slice(Math.max(0, i - 260), i + 160) : 'NOT PRESENT');
}

// ── record-timestamp bounds, bisected ────────────────────────────────────────
const countIn = async (from, to) => {
  const u = new URL(`${HOST}/api/health/reversal-shadow-signals`);
  if (from !== undefined) u.searchParams.set('from', String(from));
  if (to !== undefined) u.searchParams.set('to', String(to));
  const r = await fetch(u);
  if (!r.ok) throw new Error(`probe ${r.status}`);
  const j = await r.json();
  return { count: j.count, flagEnabled: j.flagEnabled, signals: j.signals };
};

const NOW = Date.now();
const ORIGIN = Date.UTC(2024, 0, 1);
// earliest: smallest T with count(to=T) > 0
let lo = ORIGIN, hi = NOW;
const head = await countIn(undefined, ORIGIN);
console.log(`# flagEnabled=${head.flagEnabled}`);
if (head.count > 0) { lo = 0; hi = ORIGIN; }
for (let i = 0; i < 48 && hi - lo > 60_000; i++) {
  const mid = Math.floor((lo + hi) / 2);
  const c = (await countIn(undefined, mid)).count;
  if (c > 0) hi = mid; else lo = mid;
}
const earliestBound = hi;
// latest: largest T with count(from=T) > 0
let l2 = ORIGIN, h2 = NOW;
for (let i = 0; i < 48 && h2 - l2 > 60_000; i++) {
  const mid = Math.floor((l2 + h2) / 2);
  const c = (await countIn(mid, undefined)).count;
  if (c > 0) l2 = mid; else h2 = mid;
}
const latestBound = l2;
console.log(`# earliest record ts <= ${earliestBound} (${new Date(earliestBound).toISOString()})`);
console.log(`# latest   record ts >= ${latestBound} (${new Date(latestBound).toISOString()})`);

// exact bounds from the two thin windows
const firstWin = await countIn(undefined, earliestBound + 60_000);
const lastWin = await countIn(latestBound - 60_000, undefined);
const tsOf = s => s.map(r => r.ts);
const minTs = Math.min(...tsOf(firstWin.signals));
const maxTs = Math.max(...tsOf(lastWin.signals));
console.log(`EARLIEST_TS=${minTs} ${new Date(minTs).toISOString()}`);
console.log(`LATEST_TS=${maxTs} ${new Date(maxTs).toISOString()}`);
console.log(`SPAN_DAYS=${((maxTs - minTs) / 86400000).toFixed(3)}`);

// per-day row counts over the last N complete UTC days (cheap: count only)
const DAY = 86400000;
console.log('## rows per 24h window (most recent 10):');
for (let d = 1; d <= 10; d++) {
  const to = NOW - (d - 1) * DAY, from = NOW - d * DAY;
  const c = await countIn(from, to);
  console.log(`  [-${d}d] ${new Date(from).toISOString().slice(0, 16)} .. ${new Date(to).toISOString().slice(0, 16)}  rows=${c.count}`);
}
