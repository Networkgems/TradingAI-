// TRA-3882 — grade the CSV provenance header on LIVE bytes, read-only GETs.
//
// AC4: build pin read BEFORE and AFTER every probe, and the TRA-3874 controls
// re-run alongside so a fix that broke the filter it describes cannot pass.
// Exit 0 PASS · 1 FAIL · 3 BLIND (pin moved / unreadable / login failed). A pin
// move between the two reads INVALIDATES the run rather than degrading to FAIL:
// the rows would then be a mix of two builds.
//
// The subject is the DEFAULT format. Every probe below deliberately omits
// `format`, because the whole finding is that the artifact a human downloads
// without asking for anything is the one that carried no record of the request.
// A grader that sends `format=json` is measuring the path that was already fine
// — that exact mistake is what produced the three bogus FAIL rows in the parent
// monitor run that filed this ticket.
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
const envRows = vars.map(x => x.envVar ?? x);
const pick = k => envRows.find(v => v.key === k)?.value;
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

/** Every probe reads the HEADERS, which is where the deliverable lives. */
async function get(qs) {
  const res = await fetch(`${HOST}/api/trades/export?${qs}`, { headers: AUTH });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* csv, as expected on the default route */ }
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    provenance: res.headers.get('x-export-filters-requested'),
    coverage: res.headers.get('x-export-coverage'),
    body,
    text,
  };
}

/** Data rows of a CSV body — line 1 is the §2.3 column header. */
const dataRows = text => text.split(/\r?\n/).slice(1).filter(l => l.trim() !== '');
/** The parsed provenance header, or null if it is absent/unparseable. */
const provenanceOf = r => { try { return JSON.parse(r.provenance); } catch { return null; } };

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const WINDOW = 'from=2026-08-18&to=2026-08-18&markets=options';

// ── THE DEFECT: the two requests whose saved CSVs were indistinguishable ─────
// Measured on `2e4654b142d4`: both 200 text/csv, both 2 data rows, byte-identical
// first line. One asked for live; one asked for nothing.
const filtered = await get(`${WINDOW}&modes=live`);
const unfiltered = await get(WINDOW);

check('the default route is still CSV (the format under test)',
  /text\/csv/.test(filtered.contentType) && filtered.body === null,
  `contentType=${filtered.contentType} parsedAsJson=${filtered.body !== null}`);

check('AC1 modes=live CSV carries X-Export-Filters-Requested',
  filtered.status === 200 && provenanceOf(filtered) !== null,
  `status=${filtered.status} header=${filtered.provenance ?? '(absent)'}`);

check('AC1 the no-modes CSV carries it too',
  unfiltered.status === 200 && provenanceOf(unfiltered) !== null,
  `status=${unfiltered.status} header=${unfiltered.provenance ?? '(absent)'}`);

check('AC2 the two saved documents are now DISTINGUISHABLE',
  filtered.provenance !== null && filtered.provenance !== unfiltered.provenance,
  `asked=${filtered.provenance ?? '(absent)'} vs notAsked=${unfiltered.provenance ?? '(absent)'}`);

check('AC2 modes=live reads "requested"',
  provenanceOf(filtered)?.modes === true,
  `filtersRequested.modes=${provenanceOf(filtered)?.modes}`);

check('AC2 the absent modes key reads "NOT requested"',
  provenanceOf(unfiltered)?.modes === false,
  `filtersRequested.modes=${provenanceOf(unfiltered)?.modes}`);

// AC1's cost ceiling: provenance was bought with a header precisely so the body
// would not move. A `#`-comment line ahead of the column header breaks naive
// spreadsheet and `pandas.read_csv` imports — a real regression traded for it.
check('AC1 the CSV BODY is untouched — no comment row ahead of the column header',
  filtered.text.split(/\r?\n/)[0] === unfiltered.text.split(/\r?\n/)[0]
  && /^symbol,/.test(filtered.text),
  `firstLine=${JSON.stringify(filtered.text.split(/\r?\n/)[0].slice(0, 60))}`);

check('the sibling TRA-3860 coverage header still rides along',
  typeof filtered.coverage === 'string' && filtered.coverage.length > 0,
  `X-Export-Coverage=${String(filtered.coverage).slice(0, 60)}`);

// ── AC2: the header must AGREE with the JSON path's summary, request for ─────
// request. A provenance line that can disagree with the filter it describes is
// worse than no provenance line, and this is the only probe that can catch the
// two being computed twice.
for (const qs of [`${WINDOW}&modes=live`, WINDOW, `${WINDOW}&modes=demo`, 'markets=options']) {
  const csv = await get(qs);
  const json = await get(`format=json&${qs}`);
  const header = provenanceOf(csv);
  const summary = json.body?.summary?.filtersRequested ?? null;
  check(`AC2 header === summary.filtersRequested for ?${qs}`,
    header !== null && summary !== null && JSON.stringify(header) === JSON.stringify(summary),
    `header=${JSON.stringify(header)} summary=${JSON.stringify(summary)}`);
}

// ── AC3: the JSON path is unchanged ─────────────────────────────────────────
{
  const r = await get(`format=json&${WINDOW}&modes=live`);
  const fr = r.body?.summary?.filtersRequested;
  check('AC3 summary.filtersRequested keeps its four-boolean shape',
    r.status === 200 && fr !== undefined
    && JSON.stringify(Object.keys(fr).sort()) === JSON.stringify(['from', 'markets', 'modes', 'to'])
    && Object.values(fr).every(v => typeof v === 'boolean'),
    `filtersRequested=${JSON.stringify(fr ?? null)}`);
}

// ── AC4: the TRA-3874 controls, re-run on the format the header annotates ───
// A provenance line is worthless if the work that added it broke the filter it
// describes — and these must be read off the CSV path, because that is the path
// that changed.
{
  const n = dataRows(filtered.text).length;
  check('CONTROL modes=live → 200 CSV with the 2 live rows',
    filtered.status === 200 && n === 2, `status=${filtered.status} dataRows=${n}`);
}
{
  const r = await get(`${WINDOW}&modes=demo`);
  const n = dataRows(r.text).length;
  check('NEGATIVE CONTROL modes=demo → 200 CSV with 0 rows',
    r.status === 200 && n === 0, `status=${r.status} dataRows=${n}`);
}
{
  const n = dataRows(unfiltered.text).length;
  check('CONTROL absent modes key → 200 CSV, still the 2 rows (no refuse-everything)',
    unfiltered.status === 200 && n === 2, `status=${unfiltered.status} dataRows=${n}`);
}
// The parent's headline trap, on the default format: a caller who asks for demo
// must never be handed live money rows, and a refusal has no document to annotate.
{
  const r = await get(`${WINDOW}&mode=demo`);
  check('TRA-3874 TRAP mode=demo still refuses on the DEFAULT format',
    r.status === 400 && r.body?.parameter === 'mode' && r.provenance === null,
    `status=${r.status} parameter=${r.body?.parameter ?? '-'} header=${r.provenance ?? '(absent)'}`);
}
{
  const r = await get(`${WINDOW}&Mode=demo`);
  check('TRA-3883 TRAP Mode=demo still refuses on the DEFAULT format',
    r.status === 400 && r.body?.parameter === 'Mode' && r.provenance === null,
    `status=${r.status} parameter=${r.body?.parameter ?? '-'} header=${r.provenance ?? '(absent)'}`);
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
