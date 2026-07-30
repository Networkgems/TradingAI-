// TRA-2610 residual (TRA-2631) — the fix repairs report GENERATION. It does not
// rewrite the report FILES already on disk, and those files are still being SERVED.
// Scan the archive and count how many stored top-movers tables carry a row the
// deployed rule calls fabricated, using the rule itself rather than eyeballing the
// percentages.
//
// ── REV 2 (TRA-2631): THE FOLD ENUMERATION WAS WRONG IN BOTH DIRECTIONS ────────
// Rev 1 scanned `?mode=demo` + `?mode=live` and reported "22 tables / 17 dirty /
// 17 at #1". That is the number TRA-2631 was sized off. Two independent defects:
//
//   UNDER-count — `resolveStockReportMode` (index.ts:8097) accepts
//     `demo | live | sandbox`, and `stockReportsDirFor` is `join(reportsDir, mode)`
//     ⇒ THREE distinct directories. `sandbox` was never read by any scan.
//
//   OVER-count — the no-`?mode` "default fold" is NOT a third population. The same
//     resolver falls through to `stockModeKey(getSettings(username))`, i.e. the
//     CALLING USER'S SAVED SETTING, which is one of those same three folds. Adding
//     it as a fourth row double-counts whichever fold it aliases. (This is why a
//     four-row scan reports 31/23/23 on bqb1: 22 + the 9 aliased demo tables.)
//
// So the default fold is an ALIAS whose target is CALLER-DEPENDENT — "what
// /api/reports/latest serves" has no single answer; it depends on who is reading.
// This script therefore reports DISTINCT ARTIFACTS (deduped by identity), prints
// which fold the default resolves to for THIS token, and grades /latest per fold.
//
// Exit: 0 scanned · 3 BLIND (no non-empty table readable, or a control failed).
import fs from 'node:fs';
import { assessQuotePlausibility, SUSPECT_MOVE_RATIO } from '../packages/shared/dist/index.js';

const HOST = process.env.HOST ?? 'https://tradingai-bqb1.onrender.com';
const DAYS = Number(process.env.DAYS ?? 21);
// Folds to enumerate. `null` = send no `?mode` at all (the alias).
const FOLDS = ['demo', 'live', 'sandbox', null];

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: env.ADMIN_USERNAME ?? 'admin', password: env.ADMIN_PASSWORD }),
});
if (!login.ok) { console.error(`login ${login.status} — BLIND`); process.exit(3); }
const token = (await login.json()).token;
const H = { Authorization: `Bearer ${token}` };

const label = f => (f === null ? 'default' : f);
const qs = f => (f === null ? '' : `?mode=${f}`);

// A 404 is a real negative (no stored report for that fold/day). Anything else
// non-OK, or a non-JSON body, is UNREADABLE and must not be counted as a zero.
async function readReport(path) {
  const r = await fetch(`${HOST}${path}`, { headers: H });
  if (r.status === 404) return { kind: 'absent' };
  const text = await r.text();
  if (!r.ok) return { kind: 'unreadable', why: `HTTP ${r.status}` };
  try { return { kind: 'ok', rep: JSON.parse(text) }; }
  catch { return { kind: 'unreadable', why: 'non-JSON body' }; }
}

const grade = mv => mv
  .map((m, i) => ({ i, m, v: assessQuotePlausibility({ price: m.price, changePct: m.changePct }) }))
  .filter(x => x.v.suspect);

// ── the archive sweep ─────────────────────────────────────────────────────────
// ET date is excluded: `/api/reports/{date}` for TODAY is GENERATED LIVE from the
// running (post-fix) engine, not read off disk, so it is not an archive artifact.
const etToday = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);

// Enumerate dates from the LIST route (`GET /api/reports?mode=X` readdirs the
// fold's directory) rather than from a guessed N-day window — a window is an
// argument you did not pass, and rev 1's 21 days truncated the sandbox fold,
// whose `latest` is dated 06-14. Fall back to a window only if the list is
// unusable, and say so: that route swallows a readdir failure into `dates = []`,
// so an empty list is NOT evidence the fold is empty.
const listed = new Set();
const listPerFold = {};
for (const fold of FOLDS) {
  const r = await fetch(`${HOST}/api/reports${qs(fold)}`, { headers: H });
  let ds = [];
  if (r.ok) {
    const j = await r.json().catch(() => null);
    ds = (Array.isArray(j) ? j : (j?.dates ?? [])).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  }
  listPerFold[label(fold)] = ds.length;
  for (const d of ds) if (d !== etToday) listed.add(d);
}
let dates = [...listed].sort().reverse();
let enumeratedVia = `list route (${JSON.stringify(listPerFold)})`;
if (dates.length === 0) {
  enumeratedVia = `${DAYS}-day WINDOW FALLBACK — the list route returned nothing, which that route cannot distinguish from an unreadable directory`;
  for (let i = 1; i <= DAYS; i++) {
    dates.push(new Date(Date.parse(`${etToday}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10));
  }
}

let unreadable = 0;
const foldRows = [];          // every (date, fold) hit, including aliases
const artifacts = new Map();  // identity -> { date, folds[], mv, flagged }
for (const date of dates) {
  for (const fold of FOLDS) {
    const got = await readReport(`/api/reports/${date}${qs(fold)}`);
    if (got.kind === 'absent') continue;
    if (got.kind === 'unreadable') { unreadable++; console.error(`  ! ${date} ${label(fold)}: ${got.why}`); continue; }
    const mv = got.rep.top5Movers;
    if (!Array.isArray(mv) || mv.length === 0) continue;
    foldRows.push({ date, fold });
    // Identity = the bytes that make it the same published artifact.
    const id = `${date}|${got.rep.generatedAt}|${JSON.stringify(mv)}`;
    if (!artifacts.has(id)) artifacts.set(id, { date, folds: [], mv, flagged: grade(mv) });
    artifacts.get(id).folds.push(label(fold));
  }
}

const all = [...artifacts.values()];
const dirty = all.filter(a => a.flagged.length > 0);
const dirtyFirst = dirty.filter(a => a.flagged.some(x => x.i === 0));

// ── controls, both directions (a one-directional control is half a control) ───
const sawNonEmpty = foldRows.length > 0;
const sawClean = all.some(a => a.flagged.length === 0);
const sawCleanRow = all.some(a => a.mv.some(m => !assessQuotePlausibility({ price: m.price, changePct: m.changePct }).suspect));

console.log(`threshold            : SUSPECT_MOVE_RATIO = ${SUSPECT_MOVE_RATIO}`);
console.log(`dates                : ${dates.length} (${dates[dates.length - 1]} .. ${dates[0]}); ET today ${etToday} EXCLUDED — served live, not from disk`);
console.log(`enumerated via       : ${enumeratedVia}`);
console.log(`folds enumerated     : ${FOLDS.map(label).join(', ')}`);
console.log(`fold hits (raw)      : ${foldRows.length}  <-- counts aliases twice; NOT the population`);
console.log(`DISTINCT artifacts   : ${all.length}`);
console.log(`  carrying a fabricated row : ${dirty.length}`);
console.log(`  with it at #1             : ${dirtyFirst.length}`);
console.log(`unreadable fold hits : ${unreadable}`);
console.log(`controls             : non-empty-readable=${sawNonEmpty} clean-table-exists=${sawClean} clean-row-exists=${sawCleanRow}`);

if (!sawNonEmpty) { console.error('BLIND — no non-empty stored table was readable; a zero here means nothing.'); process.exit(3); }
if (!sawCleanRow) { console.error('BLIND — the rule flagged EVERY row it saw; a detector that flags everything discriminates nothing.'); process.exit(3); }

// ── which fold does the bare default actually resolve to, for THIS token? ─────
console.log('\n=== default-fold alias resolution (this token) ===');
const aliasHits = all.filter(a => a.folds.includes('default'));
for (const a of aliasHits.slice(0, 4)) {
  console.log(`  ${a.date}: default == ${a.folds.filter(f => f !== 'default').join('+') || '(distinct — NOT an alias)'}`);
}
if (aliasHits.length === 0) console.log('  (no non-empty default-fold table in window)');

// ── /api/reports/latest, per fold: the most prominent read path ───────────────
console.log('\n=== /api/reports/latest, per fold (graded) ===');
for (const fold of FOLDS) {
  const got = await readReport(`/api/reports/latest${qs(fold)}`);
  if (got.kind !== 'ok') { console.log(`  ${label(fold).padEnd(8)} ${got.kind}${got.why ? ` (${got.why})` : ''}`); continue; }
  const mv = got.rep.top5Movers;
  if (!Array.isArray(mv) || mv.length === 0) { console.log(`  ${label(fold).padEnd(8)} date=${got.rep.date} (no movers)`); continue; }
  const f = grade(mv);
  const head = f.some(x => x.i === 0);
  console.log(`  ${label(fold).padEnd(8)} date=${got.rep.date}  #1=${mv[0].symbol} $${mv[0].price} ${Number(mv[0].changePct).toFixed(2)}%` +
    `  suspect=${f.length}/${mv.length}  ${head ? '*** FABRICATED AT #1 ***' : 'headline clean'}`);
}

console.log('\n=== distinct dirty artifacts, worst first ===');
for (const a of dirty.sort((x, y) => (y.flagged[0]?.v.ratio ?? 0) - (x.flagged[0]?.v.ratio ?? 0))) {
  console.log(`${a.date} [${a.folds.join(',')}] ${a.flagged.length}/${a.mv.length} suspect  ${a.flagged
    .map(x => `#${x.i + 1} ${x.m.symbol} $${x.m.price} ${Number(x.m.changePct).toFixed(2)}% r=${x.v.ratio?.toFixed(2)}`).join('  ')}`);
}
