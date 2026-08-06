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

// Creds from `.env` if this checkout has one, else from the process env. A
// checkout without `.env` must not throw: an uncaught `ENOENT` is a stack trace,
// and a stack trace is an UNREADABLE verdict that a reader can easily file under
// "the census could not be run" — when the census is in fact perfectly runnable.
// Same fallback order as `tra2631-provenance-stamp-check.mjs`, deliberately, so
// the two instruments cannot disagree about which host/identity they graded.
// (TRA-3072: this threw on an agent checkout while the pre-deploy capture was
// the thing being asked for.)
function loadEnv() {
  try {
    return Object.fromEntries(
      fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
        .filter(l => l.includes('=') && !l.startsWith('#'))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
  } catch {
    return {};
  }
}
const fileEnv = loadEnv();
const env = {
  ADMIN_USERNAME: process.env.ADMIN_USERNAME ?? process.env.TRADING_ADMIN_USERNAME ?? fileEnv.ADMIN_USERNAME,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? process.env.TRADING_ADMIN_PASSWORD ?? fileEnv.ADMIN_PASSWORD,
};
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

// ⛔ TRA-2631 (board ruling A) — RECONSTRUCT THE PUBLISHED TABLE BEFORE GRADING.
//
// This census grades the ARCHIVE, and it reads it through `/api/reports/{date}`.
// Once the read-time filter is live, that route no longer serves the fabricated
// rows — so grading `top5Movers` alone would report **0 of 105 dirty** and read
// exactly like "the archive is clean". It would be the same instrument failure
// this census exists to detect, inflicted on the census by its own remedy.
//
// The filter is non-destructive precisely so this stays measurable: a suppressed
// row survives verbatim in `moversProvenance.filtered`. Re-uniting the two gives
// back the PUBLISHED table — what the stored file holds — which is the population
// this census has always been about.
//
// Order matters for the `#1` statistic: `top5Movers` ranks on `|changePct|`, and
// the fabricated rows are at #1 *because* they are the biggest moves. Re-sorting
// on the same key restores their published rank rather than appending them last.
function publishedMovers(rep) {
  const served = Array.isArray(rep.top5Movers) ? rep.top5Movers : [];
  const filtered = Array.isArray(rep.moversProvenance?.filtered) ? rep.moversProvenance.filtered : [];
  if (filtered.length === 0) return { mv: served, reconstructed: false };
  const mv = [...served, ...filtered].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return { mv, reconstructed: true };
}

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
let reconstructedArtifacts = 0;
const foldRows = [];          // every (date, fold) hit, including aliases
const artifacts = new Map();  // identity -> { date, folds[], mv, flagged }
for (const date of dates) {
  for (const fold of FOLDS) {
    const got = await readReport(`/api/reports/${date}${qs(fold)}`);
    if (got.kind === 'absent') continue;
    if (got.kind === 'unreadable') { unreadable++; console.error(`  ! ${date} ${label(fold)}: ${got.why}`); continue; }
    const { mv, reconstructed } = publishedMovers(got.rep);
    if (reconstructed) reconstructedArtifacts++;
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
console.log(`reconstructed reads  : ${reconstructedArtifacts}  <-- TRA-2631 read-time filter was ACTIVE on these; graded on the PUBLISHED table (served + moversProvenance.filtered), not on what was served`);
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
  const { mv, reconstructed } = publishedMovers(got.rep);
  if (!Array.isArray(mv) || mv.length === 0) { console.log(`  ${label(fold).padEnd(8)} date=${got.rep.date} (no movers)`); continue; }
  const f = grade(mv);
  const head = f.some(x => x.i === 0);
  // `suppressed` is what a HUMAN on this fold now actually sees removed. The
  // `FABRICATED AT #1` verdict is about the PUBLISHED artifact and stays true
  // after the filter ships — the row is still in the file, it is just no longer
  // served. Reporting only one of the two would be misleading in either
  // direction, so both are printed.
  const suppressed = got.rep.moversProvenance?.filteredCount ?? 0;
  console.log(`  ${label(fold).padEnd(8)} date=${got.rep.date}  #1=${mv[0].symbol} $${mv[0].price} ${Number(mv[0].changePct).toFixed(2)}%` +
    `  suspect=${f.length}/${mv.length}  ${head ? '*** FABRICATED AT #1 ***' : 'headline clean'}` +
    `${reconstructed ? `  [read-time filter SUPPRESSED ${suppressed} — served headline is ${got.rep.top5Movers[0]?.symbol ?? '(none left)'}]` : ''}`);
}

console.log('\n=== distinct dirty artifacts, worst first ===');
for (const a of dirty.sort((x, y) => (y.flagged[0]?.v.ratio ?? 0) - (x.flagged[0]?.v.ratio ?? 0))) {
  console.log(`${a.date} [${a.folds.join(',')}] ${a.flagged.length}/${a.mv.length} suspect  ${a.flagged
    .map(x => `#${x.i + 1} ${x.m.symbol} $${x.m.price} ${Number(x.m.changePct).toFixed(2)}% r=${x.v.ratio?.toFixed(2)}`).join('  ')}`);
}
