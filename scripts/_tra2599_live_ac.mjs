// TRA-2599 — live read-back of AC1/AC2/AC3/AC5 against bqb1, plus emit an admin
// token on fd 3 for the AC4 run. Credentials come from the Render env API
// (GET only — never a PUT, that verb REPLACES the whole set, TRA-2136).
const HOST = 'https://tradingai-bqb1.onrender.com';
const SRV = 'srv-d7mb7rr7uimc73ev0chg';
const KEY = process.env.RENDER_API_KEY;
if (!KEY) { console.error('BLIND — RENDER_API_KEY unset'); process.exit(3); }

const OPEN = '/api/health/storage';
const DETAIL = '/api/health/storage/detail';

// Derived from the PAYLOAD, not transcribed from the ticket's list (that list was
// missing settingsFile/tradesStocksFile/tradesCryptoFile — see the 07-30 comment).
const OPEN_ALLOWLIST = ['dataDir_exists', 'tra142Migrated', 'backupsDir_exists', 'disk'];
const OPEN_DISK = ['readable', 'belowThreshold', 'monitor'];
const OPEN_MONITOR = ['stalled', 'ageSec'];
const MUST_BE_GATED = [
  'dataDir', 'dataDirEnv', 'userCount', 'userContextCount', 'usersFile',
  'adminSettingsFile', 'adminTradesStocksFile', 'adminTradesCryptoFile',
  'settingsFile', 'tradesStocksFile', 'tradesCryptoFile', 'backupsCount',
  'processStart', 'usage',
];

const fails = [];
const ok = (cond, label, detail) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) fails.push(label);
};

const vars = await fetch(`https://api.render.com/v1/services/${SRV}/env-vars?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
}).then(r => (r.ok ? r.json() : null)).catch(() => null);
if (!vars) { console.error('BLIND — cannot read env vars'); process.exit(3); }
const rows = vars.map(x => x.envVar || x);
const pick = k => rows.find(v => v.key === k)?.value;
const user = pick('ADMIN_USERNAME') ?? 'admin';
const pass = pick('ADMIN_PASSWORD');
if (!pass) { console.error('BLIND — ADMIN_PASSWORD unreadable'); process.exit(3); }

const ver = await fetch(`${HOST}/api/health/version`).then(r => r.json());
console.log(`live commit ${ver.commit}  startedAt ${ver.startedAt}  node ${ver.nodeVersion}\n`);

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) { console.error(`login ${login.status}`); process.exit(3); }
const TOKEN = lb.token;

// ---- AC1 — the gated route -------------------------------------------------
console.log('AC1  gated route auth matrix');
const unauth = await fetch(`${HOST}${DETAIL}`);
ok(unauth.status === 401, 'unauthenticated GET detail -> 401', `got ${unauth.status}`);

const bogus = await fetch(`${HOST}${DETAIL}`, { headers: { Authorization: 'Bearer not.a.real.token' } });
ok(bogus.status === 401, 'malformed token GET detail -> 401', `got ${bogus.status}`);

const admin = await fetch(`${HOST}${DETAIL}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
const gated = await admin.json().catch(() => null);
ok(admin.status === 200, 'admin token GET detail -> 200', `got ${admin.status}`);
ok(!!gated, 'admin body parses as JSON');

const gatedKeys = gated ? Object.keys(gated) : [];
const missing = MUST_BE_GATED.filter(k => !gatedKeys.includes(k));
ok(missing.length === 0, 'every gated field present on detail', missing.length ? `missing ${missing}` : `${gatedKeys.length} top-level keys`);

// ---- AC3 — negative control: NON-DEFAULT values survive the gate ------------
console.log('\nAC3  negative control (values, not presence)');
const nonDefault = [
  ['dataDir', gated?.dataDir, v => typeof v === 'string' && v.length > 1 && v !== '.'],
  ['userCount', gated?.userCount, v => Number.isFinite(v) && v > 1],
  ['backupsCount', gated?.backupsCount, v => Number.isFinite(v) && v > 0],
  ['processStart', gated?.processStart, v => typeof v === 'string' && !Number.isNaN(Date.parse(v))],
  ['usersFile.size', gated?.usersFile?.size, v => Number.isFinite(v) && v > 0],
  ['usersFile.mtime', gated?.usersFile?.mtime, v => typeof v === 'string' && !Number.isNaN(Date.parse(v))],
  ['disk.totalBytes', gated?.disk?.totalBytes, v => Number.isFinite(v) && v > 0],
  ['disk.freeBytes', gated?.disk?.freeBytes, v => Number.isFinite(v) && v > 0],
  ['usage.entries', gated?.usage?.entries, v => Array.isArray(v) && v.length > 0],
];
for (const [name, val, pred] of nonDefault) {
  const shown = Array.isArray(val) ? `array(${val.length})` : JSON.stringify(val);
  ok(pred(val), `${name} is non-default`, shown);
}
// The two bodies must actually differ — a fixture serving the same thing proves nothing.
const openRes = await fetch(`${HOST}${OPEN}`);
const openRaw = await openRes.text();
const gatedRaw = JSON.stringify(gated);
ok(gatedRaw.length > openRaw.length * 3, 'gated body >3x open body', `${gatedRaw.length} vs ${openRaw.length} bytes`);

// ---- AC2 — the open route --------------------------------------------------
console.log('\nAC2  open route is the liveness subset only');
ok(openRes.status === 200, 'unauthenticated GET open -> 200', `got ${openRes.status}`);
const open = JSON.parse(openRaw);
const topSet = Object.keys(open).sort().join(',');
ok(topSet === [...OPEN_ALLOWLIST].sort().join(','), 'open top-level keys EXACT SET EQUALITY', topSet);
ok(Object.keys(open.disk ?? {}).sort().join(',') === [...OPEN_DISK].sort().join(','), 'open disk keys EXACT SET EQUALITY', Object.keys(open.disk ?? {}).join(','));
ok(Object.keys(open.disk?.monitor ?? {}).sort().join(',') === [...OPEN_MONITOR].sort().join(','), 'open disk.monitor keys EXACT SET EQUALITY', Object.keys(open.disk?.monitor ?? {}).join(','));

const leakedKeys = MUST_BE_GATED.filter(k => openRaw.includes(`"${k}"`));
ok(leakedKeys.length === 0, 'no gated KEY NAME appears in open body', leakedKeys.join(',') || 'none');

// Raw-bytes scan: catches a value escaping under a DIFFERENT key name.
const plantedValues = [
  gated?.dataDir, gated?.dataDirEnv, String(gated?.userCount),
  String(gated?.userContextCount), String(gated?.backupsCount), gated?.processStart,
  String(gated?.usersFile?.size), gated?.usersFile?.mtime,
  String(gated?.disk?.totalBytes), String(gated?.disk?.freeBytes),
].filter(v => typeof v === 'string' && v.length >= 3 && v !== 'null' && v !== 'undefined');
const leakedValues = plantedValues.filter(v => openRaw.includes(v));
ok(leakedValues.length === 0, 'no gated VALUE appears in open body', leakedValues.join(',') || `${plantedValues.length} values scanned, none present`);

// ---- AC5 — /api/health/version untouched and still ungated -----------------
console.log('\nAC5  /api/health/version still ungated');
const verRes = await fetch(`${HOST}/api/health/version`);
const verBody = await verRes.json().catch(() => ({}));
ok(verRes.status === 200, 'unauthenticated GET version -> 200', `got ${verRes.status}`);
ok(typeof verBody.commit === 'string' && verBody.commit.length >= 7, 'version still publishes commit SHA', verBody.commit);

console.log(`\n${fails.length === 0 ? 'ALL LIVE ACs PASS' : `FAILURES (${fails.length}): ${fails.join(' | ')}`}`);
// Hand the token to the caller without printing it.
if (process.env.TRA2599_TOKEN_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.TRA2599_TOKEN_OUT, TOKEN);
}
process.exit(fails.length === 0 ? 0 : 1);
