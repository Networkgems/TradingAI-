#!/usr/bin/env node
// TRA-3849 — NAME THE NON-SESSION LEDGER ROWS, AND WATCH THE POPULATION MOVE.
//
// `/api/health/pnl-reconciliation` `engines[].days[]` is every row of every
// book's `daily-snapshots.json`, unwindowed and uncalendared on the way out —
// a COMPLETE census of the durable series with no retention bound. Nothing on
// that endpoint graded a `days[].date` against the exchange calendar. Every EOD
// presence axis runs the other way: `eodRowMissing` grades a session for a
// missing row, `eodInterior` (TRA-2888) enumerates sessions the ledger lacks,
// `eodTailStaleSessions` counts settled sessions past the newest row. None of
// them can see a row on a date that was never a session, so `days[]` has carried
// phantom date keys since 2026-05-03 and everything downstream — including the
// passes that walk `days[i-1]` — read them as ordinary rows.
//
//     live b70404f, 2026-08-18:  83 non-session rows / 918
//                                63 books · 11 date keys · 82 of 83 SUNDAYS
//                                the 2026-08-09 cohort alone is 63 books, one pass
//
// ⛔ RED IS THE EXPECTED STEADY STATE. This detector is not an outage alarm.
// The 83 rows are deliberately LEFT IN PLACE — `ENABLE_EOD_ROW_BACKFILL` is
// false, the TRA-2886/TRA-2888 ruling against restating banked rows stands, and
// whether these should ever be retracted is a BOARD question that cannot be
// asked coherently until the population is named and stable. Clearing the red
// by deleting rows is the one response this script is written to make loud.
//
// ── WHAT IS ACTUALLY ACTIONABLE: MOVEMENT, IN EITHER DIRECTION ───────────────
// A count that only goes up is a tripwire. A count that can be pushed DOWN by
// anything other than a ruled retraction is not one, and this one can:
//
//   · a book leaving `getAllUserContexts()` takes its rows out of the census
//   · a stale holiday table re-grades a phantom as a session (the TRA-3267
//     defect itself: a calendar answering `true` for Sunday zeroes this count
//     without one row changing — proven in `eod-nonsession-row.test.ts`)
//   · a truncated or partially-served payload undercounts and reads as repair
//
// So the population is diffed by NAME (book · mode · date) against a committed
// manifest, and each way it can move gets its own label:
//
//   NEW            a non-session row that is not in the manifest — some writer
//                  is minting phantoms again. THE PAGEABLE DIRECTION.
//   ROW-RETRACTED  a manifest row gone while its book is still in the census —
//                  someone restated a banked row. Needs a ruling to be OK.
//   BOOK-ABSENT    a manifest row's book is not in `engines[]` at all — the
//                  census shrank. NOT a retraction, and must never read as one.
//
// Exit codes — precedence BLIND > MOVED > RED > CLEAN:
//   0 CLEAN   no non-session rows at all (the post-ruling end state)
//   1 RED     the population is present and matches the manifest exactly
//   5 MOVED   the population differs from the manifest in either direction
//   2 usage
//   3 BLIND   a control failed — publish nothing
//
// ── `--movement-only` — the ROUTINE grading mode (board ruling, TRA-3849 Q2,
// 2026-10-04, recorded under the TRA-5122 delegation) ────────────────────────
// "A detector whose RED is its expected steady state is not a detector — it is
// a light that is always on." Under this flag the steady state (population
// present AND matching the manifest row-for-row) exits 0 STEADY instead of
// 1 RED, so a scheduled run pages on MOVEMENT and on BLIND, never on the
// documented standing 83. Everything else is UNCHANGED — the census still
// runs in full, the standing count is still PRINTED as a number (the ruling's
// condition (a): published, not assumed), and MOVED/BLIND exit exactly as
// above. The flag cannot swallow an alert: it is consulted only on the branch
// that already proved zero movement against the named manifest, and the
// selftest runs a paired arm proving a NEW row still exits 5 under it.
//
// Usage:
//   node scripts/check-nonsession-rows.mjs                  # live bqb1, RED=1
//   node scripts/check-nonsession-rows.mjs --movement-only   # routine mode, steady=0
//   node scripts/check-nonsession-rows.mjs --fixture=f.json
//   node scripts/check-nonsession-rows.mjs --selftest       # paired arms + controls

import { readFileSync } from 'node:fs';

const EXIT = { CLEAN: 0, RED: 1, USAGE: 2, BLIND: 3, MOVED: 5 };
const argv = process.argv.slice(2);
const arg = (k) => argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has = (k) => argv.includes(`--${k}`);

if (has('help')) {
  console.log(readFileSync(new URL(import.meta.url).pathname.replace(/^\//, ''), 'utf-8')
    .split('\n').filter(l => l.startsWith('//')).join('\n'));
  process.exit(EXIT.USAGE);
}

const HOST = arg('host') ?? process.env.HOST_BASE ?? 'https://tradingai-bqb1.onrender.com';
const MANIFEST_PATH = arg('manifest') ?? 'scripts/data/tra3849-nonsession-row-manifest.json';
const TOLERANCE_USD = 0.01; // == PNL_RECONCILE_TOLERANCE_USD

const blind = (m) => { console.error(`BLIND — ${m}`); process.exit(EXIT.BLIND); };

// ─────────────────────────────────────────────────────────────────────────────
// CONTROL 0 — the calendar this grades with must be the DEPLOYED one.
//
// `isMarketDayIso` is imported from `dist/`, which can lag `src/`. This is not
// hygiene: the calendar is the detector's ONE input, and a stale holiday table
// pushes the count DOWN — i.e. straight into the direction that reads as a
// repair. Compare the holiday literals directly; an mtime proves nothing.
// (Same control as `tra3848-phantom-cell-census.mjs`, same reason.)
// ─────────────────────────────────────────────────────────────────────────────
async function loadCalendar() {
  const holidaysOf = (path) => {
    const set = new Set(readFileSync(path, 'utf-8').match(/'2\d{3}-\d{2}-\d{2}'/g) ?? []);
    return [...set].sort().join(',');
  };
  // TRA-4478 moved the holiday table out of `scheduler.ts` into the generated
  // bundle `data/nyse-calendar.generated.ts` (scheduler re-exports the
  // interface). The drift compare follows the DATA, not the module that
  // delegates to it — scheduler.ts now contains zero date literals, which this
  // control correctly refused until it was re-pointed here.
  let hSrc, hDist;
  try {
    hSrc = holidaysOf('packages/server/src/data/nyse-calendar.generated.ts');
    hDist = holidaysOf('packages/server/dist/data/nyse-calendar.generated.js');
  } catch (e) {
    blind(`cannot read the exchange calendar bundle (${e.message}) — run \`pnpm build\` first`);
  }
  if (hSrc !== hDist || hSrc.length === 0) {
    blind(`exchange calendar drift src(${hSrc.split(',').length}) vs dist(${hDist.split(',').length}) — rebuild before grading`);
  }
  const { isMarketDayIso } = await import('../packages/server/dist/scheduler.js');
  // Sat/Fri self-test AND a known holiday, because the weekday rule alone would
  // pass a calendar with an empty holiday table.
  if (isMarketDayIso('2026-08-15') !== false || isMarketDayIso('2026-08-14') !== true) {
    blind('isMarketDayIso failed its Sat/Fri self-test');
  }
  if (isMarketDayIso('2026-01-01') !== false) {
    blind('isMarketDayIso failed its known-holiday self-test (2026-01-01 graded a session)');
  }
  console.log(`CONTROL 0  calendar src==dist (${hSrc.split(',').length} holiday literals), Sat/Fri self-test OK`);
  return isMarketDayIso;
}

const money = (v) => typeof v === 'number' && Math.abs(v) > TOLERANCE_USD;
const key = (r) => `${r.username}|${r.mode}|${r.date}`;

/**
 * Grade a `pnl-reconciliation` payload CLIENT-SIDE. Deliberately not reading
 * the server's own axis as the source of truth: this has to be able to run RED
 * on a live build that predates the axis, which is exactly the state bqb1 is in
 * on the day this ships. The server axis is used as a CROSS-CHECK below.
 */
function grade(payload, isMarketDayIso) {
  const engines = payload?.engines;
  if (!Array.isArray(engines)) blind('payload has no `engines[]` array');
  if (engines.length === 0) blind('0 engines — a census over an empty fleet is a vacuous zero');

  let denominatorRows = 0;
  const dateKeys = new Set();
  const rows = [];
  const booksSeen = new Set();
  for (const e of engines) {
    booksSeen.add(`${e.username}|${e.mode}`);
    for (const d of Array.isArray(e.days) ? e.days : []) {
      denominatorRows += 1;
      dateKeys.add(d.date);
      if (!isMarketDayIso(d.date)) {
        rows.push({
          username: e.username,
          mode: e.mode,
          date: d.date,
          moneyBearing: money(d.eodCombined) || money(d.stockDaily) || money(d.optionsDaily),
        });
      }
    }
  }
  if (denominatorRows === 0) blind('0 rows across all engines — the ledger read empty, which is not a clean census');
  rows.sort((a, b) => key(a).localeCompare(key(b)));
  return { engines, denominatorRows, denominatorBooks: engines.length, dateKeys, rows, booksSeen };
}

/**
 * CONTROL 2 — DUAL SOURCE. Once `summarizeNonSessionLedgerRows` is deployed the
 * payload carries its own count, computed server-side off the SAME calendar the
 * 21:00 ET archive runs on. Agreement is a real cross-check on both the client
 * grade and the deployed calendar; disagreement means one of them is wrong and
 * neither number may be published.
 *
 * Absence is REPORTED, never silently skipped — "the server axis is not
 * deployed yet" and "the server axis agrees" must not read the same.
 */
function crossCheck(payload, graded) {
  const served = payload.nonSessionLedgerRowCount;
  if (typeof served !== 'number') {
    console.log('CONTROL 2  server axis ABSENT — live build predates `summarizeNonSessionLedgerRows`.');
    console.log('           Grading CLIENT-SIDE only. This is a single-source reading, not a corroborated one.');
    return 'absent';
  }
  if (served !== graded.rows.length) {
    blind(`server axis says ${served} non-session rows, client grade says ${graded.rows.length} — the two calendars disagree`);
  }
  console.log(`CONTROL 2  server axis AGREES (${served}) — corroborated across two calendars`);
  return 'agree';
}

function diffManifest(rows, booksSeen) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch (e) {
    blind(`manifest unreadable at ${MANIFEST_PATH} (${e.message}) — a diff with no baseline is not a diff`);
  }
  if (!Array.isArray(manifest.rows)) blind('manifest has no `rows[]`');
  const baseline = new Map(manifest.rows.map(r => [key(r), r]));
  const observed = new Map(rows.map(r => [key(r), r]));

  const isNew = rows.filter(r => !baseline.has(key(r)));
  const gone = [];
  for (const [k, r] of baseline) {
    if (observed.has(k)) continue;
    // The load-bearing distinction. A row that vanished while its book is still
    // being censused is a RETRACTION; a row whose whole book left the census is
    // the census shrinking, and calling that a repair is the exact false green
    // this script exists to refuse.
    gone.push({ ...r, label: booksSeen.has(`${r.username}|${r.mode}`) ? 'ROW-RETRACTED' : 'BOOK-ABSENT' });
  }
  return { manifest, new: isNew, gone };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELFTEST — paired arms + the negative control, on synthetic payloads.
// ─────────────────────────────────────────────────────────────────────────────
async function selftest() {
  const isMarketDayIso = await loadCalendar();
  let failed = 0;
  const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? 'PASS' : '** FAIL **'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
    if (!ok) failed += 1;
  };

  const payload = {
    engines: [
      { username: 'admin', mode: 'live', days: [
        { date: '2026-08-06', eodCombined: 1.5, stockDaily: 1.5, optionsDaily: 0 },
        { date: '2026-08-09', eodCombined: -63.54, stockDaily: 0, optionsDaily: 0 }, // Sunday
        { date: '2026-08-10', eodCombined: 2.0, stockDaily: 2.0, optionsDaily: 0 },
      ] },
      { username: 'v0nni', mode: 'sandbox', days: [
        { date: '2026-08-09', eodCombined: 0, stockDaily: 0, optionsDaily: 0 },      // Sunday, inert
        { date: '2026-08-14', eodCombined: 0, stockDaily: 0, optionsDaily: 0 },
      ] },
    ],
  };

  console.log('\nPAIRED ARMS');
  const g = grade(payload, isMarketDayIso);
  // ARM A — the non-session row is flagged.
  check('ARM A  a non-session row IS flagged', g.rows.map(key), ['admin|live|2026-08-09', 'v0nni|sandbox|2026-08-09']);
  // ARM B — the real sessions on the SAME payload are not. Asserted as the
  // complement over the whole denominator, not as one spot check: "flags the
  // Sunday" and "flags everything" are indistinguishable from a single arm.
  check('ARM B  every real session is NOT flagged', g.denominatorRows - g.rows.length, 3);
  check('ARM B  denominator is the full series', g.denominatorRows, 5);
  check('       money-bearing split', g.rows.filter(r => r.moneyBearing).map(key), ['admin|live|2026-08-09']);

  console.log('\nNEGATIVE CONTROL — the detector CAN be made to miss');
  // The TRA-3267 defect itself: a calendar that answers `true` for Sunday.
  // Not one byte of the payload changes and the finding evaporates. This is why
  // CONTROL 0 exists and why a SHRINKING count is never read as a repair.
  const hostLocal = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 6;
  };
  const missed = grade(payload, hostLocal);
  check('  a host-local-weekday calendar zeroes the finding', missed.rows.length, 0);
  check('  …on an IDENTICAL payload (denominator unmoved)', missed.denominatorRows, g.denominatorRows);

  console.log('\nMANIFEST DIFF ARMS');
  const base = [
    { username: 'admin', mode: 'live', date: '2026-08-09' },
    { username: 'v0nni', mode: 'sandbox', date: '2026-08-09' },
  ];
  const diff = (rows, seen, baseline = base) => {
    const bm = new Map(baseline.map(r => [key(r), r]));
    const om = new Map(rows.map(r => [key(r), r]));
    return {
      new: rows.filter(r => !bm.has(key(r))).map(key),
      gone: [...bm].filter(([k]) => !om.has(k))
        .map(([, r]) => `${key(r)}:${seen.has(`${r.username}|${r.mode}`) ? 'ROW-RETRACTED' : 'BOOK-ABSENT'}`),
    };
  };
  check('  steady state → no movement', diff(g.rows, g.booksSeen), { new: [], gone: [] });
  const grown = grade({ engines: [...payload.engines, { username: 'nu', mode: 'demo', days: [{ date: '2026-08-16', eodCombined: 0, stockDaily: 0, optionsDaily: 0 }] }] }, isMarketDayIso);
  check('  a NEW phantom is named NEW', diff(grown.rows, grown.booksSeen).new, ['nu|demo|2026-08-16']);
  const retracted = grade({ engines: [{ ...payload.engines[0], days: payload.engines[0].days.filter(d => d.date !== '2026-08-09') }, payload.engines[1]] }, isMarketDayIso);
  check('  a row deleted from a LIVE book → ROW-RETRACTED', diff(retracted.rows, retracted.booksSeen).gone, ['admin|live|2026-08-09:ROW-RETRACTED']);
  const bookGone = grade({ engines: [payload.engines[1]] }, isMarketDayIso);
  check('  a book leaving the census → BOOK-ABSENT, NOT a retraction', diff(bookGone.rows, bookGone.booksSeen).gone, ['admin|live|2026-08-09:BOOK-ABSENT']);

  console.log('\nCONTROL 2 ARMS — the dual-source cross-check');
  // Exercised in-process rather than trusted: `crossCheck` calls `blind()`,
  // which exits, so the disagreement arm is run in a child.
  check('  absent server axis → reported as ABSENT, not as agreement', crossCheck(payload, g), 'absent');
  check('  matching server axis → AGREE', crossCheck({ ...payload, nonSessionLedgerRowCount: 2 }, g), 'agree');
  const { spawnSync } = await import('node:child_process');
  const tmp = `${process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? '.'}/tra3849-disagree.json`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tmp, JSON.stringify({ ...payload, nonSessionLedgerRowCount: 999 }));
  const child = spawnSync(process.execPath, ['scripts/check-nonsession-rows.mjs', `--fixture=${tmp}`], { encoding: 'utf-8' });
  check('  disagreeing server axis → BLIND (3), never a published number', child.status, EXIT.BLIND);
  check('  …and it says WHY', /calendars disagree/.test(child.stderr ?? ''), true);

  console.log('\nMOVEMENT-ONLY ARMS — the flag downgrades ONLY the steady state, never an alert');
  // Run in children against a manifest that names exactly the fixture's two
  // phantoms, so the steady/moved branches are exercised end-to-end through
  // the real exit paths rather than through the diff helper alone.
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? '.';
  const fixManifest = `${scratch}/tra3849-mo-manifest.json`;
  const fixSteady = `${scratch}/tra3849-mo-steady.json`;
  const fixGrown = `${scratch}/tra3849-mo-grown.json`;
  writeFileSync(fixManifest, JSON.stringify({
    capturedAtIso: '2026-10-04T00:00:00Z', liveBuild: 'selftest', rowCount: 2, denominatorRows: 5,
    rows: [
      { username: 'admin', mode: 'live', date: '2026-08-09' },
      { username: 'v0nni', mode: 'sandbox', date: '2026-08-09' },
    ],
  }));
  writeFileSync(fixSteady, JSON.stringify(payload));
  writeFileSync(fixGrown, JSON.stringify({ engines: [...payload.engines, { username: 'nu', mode: 'demo', days: [{ date: '2026-08-16', eodCombined: 0, stockDaily: 0, optionsDaily: 0 }] }] }));
  const run = (...extra) => spawnSync(process.execPath,
    ['scripts/check-nonsession-rows.mjs', `--manifest=${fixManifest}`, ...extra], { encoding: 'utf-8' });
  const steadyMo = run(`--fixture=${fixSteady}`, '--movement-only');
  check('  steady state + --movement-only → 0 STEADY, not paged', steadyMo.status, EXIT.CLEAN);
  check('  …and the standing count is still PUBLISHED as a number', /STEADY — 2 non-session rows \/ 5/.test(steadyMo.stdout ?? ''), true);
  check('  same steady state WITHOUT the flag → 1 RED (flag moves only this exit)', run(`--fixture=${fixSteady}`).status, EXIT.RED);
  check('  a NEW phantom + --movement-only → 5 MOVED (the flag cannot swallow an alert)', run(`--fixture=${fixGrown}`, '--movement-only').status, EXIT.MOVED);

  console.log(`\n${failed === 0 ? 'CONTROLS PASS' : `** ${failed} CONTROL(S) FAILED **`}`);
  process.exit(failed === 0 ? EXIT.CLEAN : EXIT.BLIND);
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  if (has('selftest')) return selftest();
  const isMarketDayIso = await loadCalendar();

  let payload;
  const fixture = arg('fixture');
  if (fixture) {
    try { payload = JSON.parse(readFileSync(fixture, 'utf-8')); }
    catch (e) { blind(`fixture unreadable (${e.message})`); }
    console.log(`CONTROL 1  source: fixture ${fixture}`);
  } else {
    const ver = await fetch(`${HOST}/api/health/version`).then(r => r.json()).catch(() => null);
    if (!ver) blind('version route unreachable');
    const r = await fetch(`${HOST}/api/health/pnl-reconciliation`).catch(() => null);
    if (!r || !r.ok) blind(`pnl-reconciliation ${r ? r.status : 'unreachable'}`);
    payload = await r.json().catch(() => null);
    if (!payload) blind('pnl-reconciliation returned unparsable JSON');
    console.log(`CONTROL 1  live ${HOST} build ${String(ver.commit).slice(0, 7)} booted ${ver.startedAt}`);
  }

  const g = grade(payload, isMarketDayIso);
  const crossed = crossCheck(payload, g);

  const sorted = [...g.dateKeys].sort();
  console.log('\n=== durable EOD ledger series — every days[].date graded on the exchange calendar ===');
  console.log(`denominator : ${g.denominatorRows} rows · ${g.denominatorBooks} books · ${g.dateKeys.size} date keys · ${sorted[0]} .. ${sorted[sorted.length - 1]}`);
  console.log(`NON-SESSION ROWS      : ${g.rows.length}`);
  console.log(`NON-SESSION BOOKS     : ${new Set(g.rows.map(r => `${r.username}|${r.mode}`)).size}`);
  console.log(`MONEY-BEARING         : ${g.rows.filter(r => r.moneyBearing).length}  (|eodCombined| or |stockDaily| or |optionsDaily| > ${TOLERANCE_USD})`);

  const byDate = new Map();
  for (const r of g.rows) {
    const c = byDate.get(r.date) ?? { books: 0, money: 0, modes: new Set() };
    c.books += 1; if (r.moneyBearing) c.money += 1; c.modes.add(r.mode);
    byDate.set(r.date, c);
  }
  if (byDate.size) {
    console.log('\ndate         dow  books  money  modes');
    for (const d of [...byDate.keys()].sort()) {
      const c = byDate.get(d);
      const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${d}T12:00:00Z`).getUTCDay()];
      console.log(`${d}   ${dow}  ${String(c.books).padStart(5)}  ${String(c.money).padStart(5)}  ${[...c.modes].sort().join('/')}`);
    }
  }

  const { manifest, new: added, gone } = diffManifest(g.rows, g.booksSeen);
  console.log(`\n=== diff vs manifest (${MANIFEST_PATH}, captured ${manifest.capturedAtIso} on ${String(manifest.liveBuild).slice(0, 7)}) ===`);
  console.log(`baseline: ${manifest.rowCount} rows / ${manifest.denominatorRows}   observed: ${g.rows.length} rows / ${g.denominatorRows}`);
  for (const r of added) console.log(`  NEW            ${key(r)}${r.moneyBearing ? '  [MONEY-BEARING]' : ''}`);
  for (const r of gone) console.log(`  ${r.label.padEnd(14)} ${key(r)}`);
  if (added.length === 0 && gone.length === 0) console.log('  (no movement)');

  if (added.length || gone.length) {
    console.log('\nMOVED — the population is not what the manifest names.');
    if (added.length) console.log(`  ${added.length} NEW: a writer is minting phantoms again. This is the regression direction; find the ungated write path.`);
    const retracted = gone.filter(r => r.label === 'ROW-RETRACTED');
    const absent = gone.filter(r => r.label === 'BOOK-ABSENT');
    if (retracted.length) console.log(`  ${retracted.length} ROW-RETRACTED: a banked row was restated. This needs a board ruling behind it; if there is one, cite it and update the manifest.`);
    if (absent.length) console.log(`  ${absent.length} BOOK-ABSENT: the census shrank — the book is not in engines[]. NOT a retraction and NOT a repair.`);
    process.exit(EXIT.MOVED);
  }

  if (g.rows.length === 0) {
    console.log('\nCLEAN — no non-session rows in the durable series.');
    process.exit(EXIT.CLEAN);
  }
  console.log(`\n${has('movement-only') ? 'STEADY' : 'RED'} — ${g.rows.length} non-session rows / ${g.denominatorRows}, matching the manifest exactly.`);
  console.log('This is the EXPECTED STEADY STATE: the population is named, stable, and left in place');
  console.log('pending the TRA-3849 impact analysis. Do not clear it by deleting rows.');
  if (crossed === 'absent') console.log('NOTE: graded client-side only — the server axis is not on the live build yet.');
  if (has('movement-only')) {
    console.log('movement-only: standing population is documented, not paged (board ruling 2026-10-04). Exit 0.');
    process.exit(EXIT.CLEAN);
  }
  process.exit(EXIT.RED);
}

main().catch(e => blind(e?.stack ?? String(e)));
