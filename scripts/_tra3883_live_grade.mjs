// TRA-3883 — grade the residual on LIVE bytes, read-only GETs.
//
// AC4: build pin read BEFORE and AFTER every probe, and the TRA-3874 controls
// re-run alongside so a refuse-everything regression cannot pass. Exit 0 PASS ·
// 1 FAIL · 3 BLIND (pin moved / unreadable / login failed). A pin move between
// the two reads INVALIDATES the whole run — it does not degrade to a FAIL,
// because the rows would then be a mix of two builds.
//
// The refusals are graded on the REASON, not just the status code. The filing's
// own probe had `Markets=options` 400'ing for TRA-3860's range refusal on a
// widened `markets`; a status-code-only assertion reads that as coverage while
// the hole is wide open.
const HOST = 'https://tradingai-bqb1.onrender.com';
const SRV = 'srv-d7mb7rr7uimc73ev0chg';
const KEY = process.env.RENDER_API_KEY;
const EXPECT = process.argv.find(a => a.startsWith('--expect='))?.slice(9) ?? null;

const blind = m => { console.error(`BLIND — ${m}`); process.exit(3); };
if (!KEY) blind('RENDER_API_KEY unset');

async function pin() {
  const r = await fetch(`${HOST}/api/health/options-live`).then(x => x.json()).catch(() => null);
  if (!r) return null;
  const b = r.build ?? r;
  return { commit: b.commit, pid: b.pid, startedAt: b.startedAt };
}

const before = await pin();
if (!before?.commit) blind('pin unreadable before the probe');
console.log(`# pin BEFORE  commit=${before.commit} pid=${before.pid} startedAt=${before.startedAt}`);
if (EXPECT && !before.commit.startsWith(EXPECT)) {
  blind(`live commit ${before.commit} is not the graded build ${EXPECT}`);
}

const vars = await fetch(`https://api.render.com/v1/services/${SRV}/env-vars?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
}).then(r => (r.ok ? r.json() : null)).catch(() => null);
if (!vars) blind('cannot read env vars');
const rows = vars.map(x => x.envVar ?? x);
const pick = k => rows.find(v => v.key === k)?.value;
const user = pick('ADMIN_USERNAME') ?? 'admin';
const pass = pick('ADMIN_PASSWORD');
if (!pass) blind('ADMIN_PASSWORD unreadable');

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) blind(`login ${login.status} — ${JSON.stringify(lb).slice(0, 160)}`);
const AUTH = { Authorization: `Bearer ${lb.token}` };

async function get(qs) {
  const res = await fetch(`${HOST}/api/trades/export?${qs}`, { headers: AUTH });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, body, text };
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const WINDOW = 'format=json&from=2026-08-18&to=2026-08-18&markets=options';

// ── R1: the case-variant keys that served two LIVE rows on 2e4654b1 ──────────
for (const key of ['Mode', 'MODE', 'MODES', 'Modes']) {
  const r = await get(`${WINDOW}&${key}=demo`);
  const liveRows = r.status === 200 ? (r.body?.trades ?? []).filter(t => t.mode === 'live') : [];
  check(
    `R1 ${key}=demo refuses`,
    r.status === 400 && r.body?.parameter === key && liveRows.length === 0,
    `status=${r.status} parameter=${r.body?.parameter ?? '-'} liveRowsServed=${liveRows.length}`,
  );
}
for (const key of ['Market', 'Book', 'Username', 'BOOK']) {
  const r = await get(`${WINDOW}&${key}=x`);
  check(`R1 ${key} refuses`, r.status === 400 && r.body?.parameter === key,
    `status=${r.status} parameter=${r.body?.parameter ?? '-'}`);
}
// The filing's warning: this one 400'd BEFORE the fix too, for the wrong reason.
{
  const r = await get('format=json&from=2026-08-18&to=2026-08-18&Markets=options&modes=live');
  check('R1 Markets=options refuses ON THE KEY (not TRA-3860 range)',
    r.status === 400 && r.body?.parameter === 'Markets',
    `status=${r.status} parameter=${r.body?.parameter ?? '-'} error=${String(r.body?.error).slice(0, 70)}`);
}
{
  // …and the same request with the `from` bound dropped, which was a silent 200.
  const r = await get('format=json&to=2026-08-18&Markets=options&modes=live');
  const served = r.status === 200 ? (r.body?.trades ?? []).length : 0;
  check('R1 Markets=options with no `from` is no longer a silent 200',
    r.status === 400 && r.body?.parameter === 'Markets', `status=${r.status} rowsServed=${served}`);
}
for (const key of ['From', 'To', 'Format', 'FORMAT']) {
  const r = await get(`format=json&markets=options&${key}=2026-08-18`);
  check(`R1 ${key} (case-variant of a REAL key) refuses`,
    r.status === 400 && r.body?.parameter === key,
    `status=${r.status} parameter=${r.body?.parameter ?? '-'}`);
}

// ── R2: an unparseable bound must not resolve to "no bound" ──────────────────
const R2 = 'format=json&to=2026-08-18&markets=options&modes=live';
for (const token of ['2026-31-01', 'last-monday', '18-08-2026']) {
  const r = await get(`${R2}&from=${encodeURIComponent(token)}`);
  const served = r.status === 200 ? (r.body?.trades ?? []).length : 0;
  check(`R2 from=${token} refuses`,
    r.status === 400 && r.body?.parameter === 'from' && (r.body?.rejected ?? []).includes(token),
    `status=${r.status} rejected=${JSON.stringify(r.body?.rejected ?? null)} rowsServed=${served}`);
}
{
  const r = await get(`${R2}&from=`);
  check('R2 from= (present, blank) refuses', r.status === 400 && r.body?.parameter === 'from',
    `status=${r.status}`);
}
{
  const r = await get(`${R2}&from=2026-08-01&from=2026-08-18`);
  check('R2 repeated ?from= refuses', r.status === 400 && /more than once/.test(String(r.body?.error)),
    `status=${r.status} error=${String(r.body?.error).slice(0, 60)}`);
}
// The correctly-spelled floor request STILL refuses for TRA-3860's reason — the
// guard the typo used to defeat has to still be there.
{
  const r = await get(`${R2}&from=2026-01-01`);
  check('R2 CONTROL from=2026-01-01 still refuses for the TRA-3860 reason',
    r.status === 400 && /attest/i.test(JSON.stringify(r.body ?? {})),
    `status=${r.status} error=${String(r.body?.error).slice(0, 70)}`);
}
// AC3's control set — this must not ship as a date-parser tightening. The bare
// epoch-ms is 2026-08-18, not 0: a 1970 floor is legitimately refused by
// TRA-3860's range guard, which would make the control fail for the right reason
// and read as a regression.
for (const token of ['2026-08-18', '2026/08/18', '08-18-2026', 'Aug 18 2026', '2026-08-18T00:00', '2026-8-18', '1787011200000']) {
  const r = await get(`format=json&markets=options&modes=live&from=${encodeURIComponent(token)}`);
  check(`R2 CONTROL from=${token} still resolves (200)`, r.status === 200,
    `status=${r.status} error=${String(r.body?.error ?? '').slice(0, 60)}`);
}

// ── The TRA-3874 controls, re-run: a refuse-everything fix must not pass ─────
{
  const r = await get('format=json&from=2026-08-18&to=2026-08-18&markets=options&modes=live');
  const n = (r.body?.trades ?? []).length;
  check('CONTROL modes=live → 200 with the 2 live rows', r.status === 200 && n === 2,
    `status=${r.status} rows=${n}`);
}
{
  const r = await get('format=json&from=2026-08-18&to=2026-08-18&markets=options&modes=demo');
  const n = (r.body?.trades ?? []).length;
  check('NEGATIVE CONTROL modes=demo → 200 with 0 rows', r.status === 200 && n === 0,
    `status=${r.status} rows=${n}`);
}
{
  const r = await get('format=json&from=2026-08-18&to=2026-08-18&markets=options');
  check('CONTROL absent modes key → 200 (the one input still allowed to widen)',
    r.status === 200 && r.body?.summary?.filtersRequested?.modes === false,
    `status=${r.status} filtersRequested.modes=${r.body?.summary?.filtersRequested?.modes}`);
}
{
  const r = await get('format=json&markets=options&_cacheBust=1');
  check('CONTROL an unknown-but-harmless key still passes', r.status === 200, `status=${r.status}`);
}

const after = await pin();
if (!after?.commit) blind('pin unreadable after the probe');
console.log(`# pin AFTER   commit=${after.commit} pid=${after.pid} startedAt=${after.startedAt}`);
if (after.commit !== before.commit || after.pid !== before.pid || after.startedAt !== before.startedAt) {
  blind('the build pin MOVED mid-probe — these rows straddle two builds and are not a grade');
}

const failed = results.filter(r => !r.pass);
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length} on ${before.commit.slice(0, 12)} pid=${before.pid}`);
process.exit(failed.length === 0 ? 0 : 1);
