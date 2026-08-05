// TRA-2660 — read the admin-gated desk-roster names off bqb1. Credentials come
// from the Render env API (GET only — never a PUT, that verb REPLACES the whole
// set, TRA-2136). Prints the raw JSON.
const HOST = 'https://tradingai-bqb1.onrender.com';
const SRV = 'srv-d7mb7rr7uimc73ev0chg';
const KEY = process.env.RENDER_API_KEY;
if (!KEY) { console.error('BLIND — RENDER_API_KEY unset'); process.exit(3); }

const vars = await fetch(`https://api.render.com/v1/services/${SRV}/env-vars?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
}).then(r => (r.ok ? r.json() : null)).catch(() => null);
if (!vars) { console.error('BLIND — cannot read env vars'); process.exit(3); }
const rows = vars.map(x => x.envVar || x);
const pick = k => rows.find(v => v.key === k)?.value;
const user = pick('ADMIN_USERNAME') ?? 'admin';
const pass = pick('ADMIN_PASSWORD');
if (!pass) { console.error('BLIND — ADMIN_PASSWORD unreadable'); process.exit(3); }

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) {
  console.error(`login ${login.status} — ${JSON.stringify(lb).slice(0, 200)}`);
  process.exit(3);
}
const ver = await fetch(`${HOST}/api/health/version`).then(r => r.json());
console.log(`# live commit ${ver.commit} startedAt ${ver.startedAt}`);
const res = await fetch(`${HOST}/api/admin/desk-roster`, {
  headers: { Authorization: `Bearer ${lb.token}` },
});
console.log(`# GET /api/admin/desk-roster -> ${res.status}`);
console.log(JSON.stringify(await res.json(), null, 2));
