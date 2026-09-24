#!/usr/bin/env node
// TRA-4254 — A JOURNAL ROW STILL `OPEN` PAST ITS CONTRACT'S EXPIRATION.
//
// A long option cannot be open after it expires. It is exercised or it is
// worthless; either way the position is gone and the journal owes a CLOSE. A row
// that is still `OPEN` past expiry is therefore a JOURNAL ZOMBIE by construction
// — no market read, no broker call and no ledger is needed to know it.
//
// Measured live on `092d0877` (2026-09-01T11:31Z), `?rows=all`, 3471 rows:
//
//     60 OPEN rows in the journal · 33 of them past implied expiry
//        single_leg_rv    21 OPEN · 21 past expiry (newest expiry 2026-08-28)
//        iron_condor       9 OPEN ·  9 past expiry
//        bear_put_spread   1 OPEN ·  1 past expiry
//        single_leg_otm   27 OPEN ·  2 past expiry
//
// The 21 `single_leg_rv` rows are TRA-4254's Ask 4. They are not real book state.
//
// ── WHY THE SWEEP THAT EXISTS READS CLEAN OVER THEM ──────────────────────────
//
// `zombie-open-journal-sweep.ts` already hunts stale OPEN rows, and on the same
// response it published:
//
//     zombieSweep.counts.liveOpenRows: 3
//     zombieSweep.counts.zombieOpenRows: 0     lastOutcome: "clean"
//
// Both true. Its universe is `listLiveJournalRows()` — the LIVE book — because
// its adjudicator is the live option-fill ledger, which has nothing to say about
// a demo row. All 33 stale rows are `mode: "demo"`, so 57 of the journal's 60
// OPEN rows are outside the only instrument that grades OPEN rows at all, and its
// `clean` is a true statement about a universe that excludes them. That is not a
// bug in the sweep — it is the shape of the gap, and it is why this check grades
// EVERY mode and does not reuse the sweep's verdict.
//
// ── THE ADJUDICATOR, AND ITS ONE HONEST LIMIT ────────────────────────────────
//
// `/api/health/option-journal` does NOT project a contract expiration. It
// projects `openTs` and `entryDte` (days-to-expiration AT OPEN), so expiry is
// IMPLIED: `openTs + entryDte days`. That is a whole-day count and the row does
// not carry the expiry instant, so the comparison is run with a grace period
// (default 3 days) and a row is only called stale when it clears that grace.
// The error direction is deliberate: this UNDER-reports, never over-reports.
//
// A row this cannot adjudicate — `entryDte` absent, null or non-finite — is not
// clean. It reads BLIND. "I could not check this row" and "this row is fine"
// must never share an exit code, which is the whole reason the sweep's `clean`
// was readable as coverage in the first place.
//
// ── EXIT CODES — FAILS CLOSED ────────────────────────────────────────────────
//
//   0  CLEAN  — every OPEN row was adjudicated and none is past expiry + grace.
//   1  STALE  — at least one OPEN row is past expiry. Each is named.
//   2  usage
//   3  BLIND  — a leg could not be READ: route unreachable, non-JSON, `rows`
//               absent, `rowsMode !== "all"` (a PAGED fold silently under-counts
//               the population and would read as repair), or an OPEN row whose
//               `entryDte` cannot be adjudicated.
//
//   Precedence: BLIND > STALE > CLEAN.
//
// ⛔ RED IS THE EXPECTED STEADY STATE UNTIL SOMEONE RULES ON THE ROWS. Clearing
// this red by deleting or force-closing journal rows is the one response this
// script exists to make loud: a retraction restates banked history and is a
// board question (same posture as TRA-3849's non-session rows). Naming the
// population is the deliverable; disposing of it is not this script's call.
//
// Usage:
//   node scripts/check-journal-stale-opens.mjs
//   node scripts/check-journal-stale-opens.mjs --host=https://tradingai-bqb1.onrender.com
//   node scripts/check-journal-stale-opens.mjs --grace-days=3
//   node scripts/check-journal-stale-opens.mjs --json
//   node scripts/check-journal-stale-opens.mjs --fixture=path/to/payload.json
//   node scripts/check-journal-stale-opens.mjs --selftest    # paired arms + controls

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
const ROUTE = '/api/health/option-journal?rows=all';
const DEFAULT_GRACE_DAYS = 3;
const DAY_MS = 86_400_000;

const EXIT_CLEAN = 0;
const EXIT_STALE = 1;
const EXIT_USAGE = 2;
const EXIT_BLIND = 3;

/**
 * Grade one already-parsed `/api/health/option-journal?rows=all` payload.
 *
 * Pure: no clock, no network. `nowMs` is injected so the selftest can pin it and
 * so a fixture grades against the instant it was captured rather than today.
 *
 * @returns {{verdict:'CLEAN'|'STALE'|'BLIND', reason:string|null, open:number,
 *            stale:Array<object>, unadjudicable:Array<object>, coverage:object}}
 */
export function gradeJournalStaleOpens(payload, nowMs, graceDays = DEFAULT_GRACE_DAYS) {
  const blind = (reason) => ({
    verdict: 'BLIND', reason, open: 0, stale: [], unadjudicable: [], coverage: null,
  });

  if (payload === null || typeof payload !== 'object') return blind('payload is not an object');
  if (!Array.isArray(payload.rows)) return blind('`rows` is absent or not an array — nothing to grade');
  // A paged fold under-counts the population, and an under-count reads as repair.
  if (payload.rowsMode !== 'all') {
    return blind(`rowsMode=${JSON.stringify(payload.rowsMode)} — need "all"; a paged fold cannot bound the OPEN population`);
  }

  const open = payload.rows.filter((r) => r && r.outcome === 'OPEN');

  const stale = [];
  const unadjudicable = [];
  for (const r of open) {
    const dte = r.entryDte;
    const openTs = r.openTs;
    if (typeof openTs !== 'number' || !Number.isFinite(openTs)
      || typeof dte !== 'number' || !Number.isFinite(dte)) {
      unadjudicable.push({ id: r.id ?? null, symbol: r.symbol ?? null, structure: r.structure ?? null, openTs, entryDte: dte });
      continue;
    }
    const impliedExpiryMs = openTs + dte * DAY_MS;
    const overdueDays = (nowMs - (impliedExpiryMs + graceDays * DAY_MS)) / DAY_MS;
    if (overdueDays > 0) {
      stale.push({
        id: r.id ?? null,
        symbol: r.symbol ?? null,
        structure: r.structure ?? null,
        mode: r.mode ?? null,
        accountClass: r.accountClass ?? null,
        openedAt: new Date(openTs).toISOString(),
        entryDte: dte,
        impliedExpiry: new Date(impliedExpiryMs).toISOString(),
        overdueDays: Math.round(overdueDays * 10) / 10,
        atRiskUsd: typeof r.atRiskUsd === 'number' ? r.atRiskUsd : null,
      });
    }
  }

  // Published so a reader can never again mistake the live-scoped sweep's
  // `clean` for coverage of the journal's OPEN population.
  const sweptLiveOpen = payload?.zombieSweep?.counts?.liveOpenRows;
  const coverage = {
    journalOpenRows: open.length,
    zombieSweepUniverse: typeof sweptLiveOpen === 'number' ? sweptLiveOpen : null,
    zombieSweepOutcome: payload?.zombieSweep?.lastOutcome ?? null,
    outsideZombieSweep: typeof sweptLiveOpen === 'number' ? open.length - sweptLiveOpen : null,
  };

  if (unadjudicable.length > 0) {
    return {
      verdict: 'BLIND',
      reason: `${unadjudicable.length} OPEN row(s) carry no usable openTs/entryDte — cannot adjudicate, and an unadjudicated row is not a clean one`,
      open: open.length, stale, unadjudicable, coverage,
    };
  }
  return {
    verdict: stale.length > 0 ? 'STALE' : 'CLEAN',
    reason: null,
    open: open.length, stale, unadjudicable, coverage,
  };
}

// ── SELFTEST — paired arms + the negative control ─────────────────────────────
// Each arm differs from its partner in exactly ONE field, so a pass is evidence
// the check reads THAT field and not something correlated with it.
function selftest() {
  const NOW = Date.parse('2026-09-01T12:00:00Z');
  const openedAt = Date.parse('2026-06-25T18:06:53.761Z');
  const base = (rows) => ({ rowsMode: 'all', rows, zombieSweep: { lastOutcome: 'clean', counts: { liveOpenRows: 0 } } });
  const row = (over) => ({ id: 'r1', symbol: 'PYPL', structure: 'single_leg_rv', mode: 'demo', accountClass: 'unattributed', openTs: openedAt, entryDte: 36, atRiskUsd: 205, outcome: 'OPEN', ...over });

  const cases = [
    // 1 — the incident, verbatim shape: expired 2026-07-31, still OPEN.
    ['STALE  expired-and-open (the incident)', base([row({})]), 'STALE'],
    // 2 — NEGATIVE CONTROL, one field apart from #1: same row, outcome CLOSED.
    //     Proves the check keys on `outcome`, not on the age of the row.
    ['CLEAN  same row but already closed', base([row({ outcome: 'SCRATCH' })]), 'CLEAN'],
    // 3 — NEGATIVE CONTROL, one field apart from #1: same row, DTE long enough
    //     that implied expiry is still in the future. Proves the expiry maths runs.
    ['CLEAN  same row, not yet expired', base([row({ entryDte: 400 })]), 'CLEAN'],
    // 4 — inside the grace band: expired 1 day ago, grace 3 ⇒ NOT yet called.
    //     Proves the grace is real and the error direction is under-reporting.
    ['CLEAN  expired inside the grace band', base([row({ openTs: NOW - 37 * DAY_MS, entryDte: 36 })]), 'CLEAN'],
    // 5 — BLIND beats CLEAN: an OPEN row that cannot be adjudicated.
    ['BLIND  OPEN row with null entryDte', base([row({ entryDte: null })]), 'BLIND'],
    // 6 — BLIND beats STALE: one stale row AND one unadjudicable row.
    ['BLIND  unadjudicable outranks stale', base([row({}), row({ id: 'r2', entryDte: null })]), 'BLIND'],
    // 7 — a PAGED fold cannot bound the population, so it is never a pass —
    //     even though its visible rows are all clean.
    ['BLIND  rowsMode=page under-counts', { ...base([row({ outcome: 'WIN' })]), rowsMode: 'page' }, 'BLIND'],
    // 8 — `rows` absent entirely (route shape changed / error page).
    ['BLIND  rows absent', { rowsMode: 'all' }, 'BLIND'],
    // 9 — an empty journal is clean, not blind. Zero OPEN rows is a real answer.
    ['CLEAN  no rows at all', base([]), 'CLEAN'],
  ];

  let failed = 0;
  for (const [name, payload, want] of cases) {
    const got = gradeJournalStaleOpens(payload, NOW).verdict;
    const ok = got === want;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(44)} want=${want.padEnd(5)} got=${got}`);
  }

  // The coverage arithmetic is itself a claim — grade it.
  const cov = gradeJournalStaleOpens(
    { rowsMode: 'all', rows: [row({}), row({ id: 'r2', mode: 'live' })], zombieSweep: { lastOutcome: 'clean', counts: { liveOpenRows: 1 } } },
    NOW,
  ).coverage;
  const covOk = cov.journalOpenRows === 2 && cov.zombieSweepUniverse === 1 && cov.outsideZombieSweep === 1;
  if (!covOk) failed++;
  console.log(`  ${covOk ? 'ok  ' : 'FAIL'}  coverage gap arithmetic                      want=1 outside  got=${cov.outsideZombieSweep}`);

  // ── THE ENTRY GUARD — a ONE-VARIABLE PAIR (TRA-4867) ───────────────────────
  //
  // Grading a shipped blob means writing it somewhere else under some other
  // name. If the entry test keys on the NAME, that copy calls main() zero times
  // and exits 0 having printed nothing — which reads exactly like CLEAN. These
  // two arms differ in ONE variable, the entry predicate: the RENAMED-COPY arm
  // must reach the same STALE verdict the canonical call does, and its partner
  // replays the OLD name-keyed predicate over the SAME bytes and asserts it is
  // silent+0. The partner is what stops this pair from going green because the
  // hazard quietly stopped being real — an arm that can only pass is not a
  // control.
  //
  // The fixture's row expired 2026-07-31 and is still OPEN, so it is stale
  // against any clock from here on; the child needs no network and no pinned
  // time.
  const SELF = fileURLToPath(import.meta.url);
  const entryFixture = base([row({})]);
  const spawnRenamed = (transform) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-opens-entry-'));
    try {
      const dst = path.join(dir, 'graded-blob.mjs');
      const src = fs.readFileSync(SELF, 'utf8');
      fs.writeFileSync(dst, transform ? transform(src) : src, 'utf8');
      const fix = path.join(dir, 'payload.json');
      fs.writeFileSync(fix, JSON.stringify(entryFixture), 'utf8');
      const r = spawnSync(process.execPath, [dst, `--fixture=${fix}`], { encoding: 'utf8' });
      return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  let entryOk = true;
  let entryNote = '';
  try {
    const live = spawnRenamed();
    if (live.out.trim() === '') throw new Error('the renamed copy printed NOTHING — that is the failure this arm exists for');
    if (live.code !== EXIT_STALE) throw new Error(`renamed copy exited ${live.code}, want ${EXIT_STALE} (STALE); out=${live.out.slice(-400)}`);
    if (!live.out.includes('PYPL')) throw new Error('the renamed copy did not name the stale row');
  } catch (err) {
    entryOk = false;
    entryNote = err?.message ?? String(err);
  }
  if (!entryOk) failed++;
  console.log(`  ${entryOk ? 'ok  ' : 'FAIL'}  entry guard: RENAMED copy still runs        want=STALE+output  ${entryOk ? 'got=STALE+output' : `got=${entryNote}`}`);

  let oldOk = true;
  let oldNote = '';
  try {
    // Anchored on the NEWLINE so this arm cannot accidentally rewrite its own
    // literal a few lines up and then report the wrong reason for failing.
    const ANCHOR = '\nif (isEntrypoint) {';
    const OLD = "\nif (process.argv[1]?.endsWith('check-journal-stale-opens.mjs')) {";
    const dead = spawnRenamed((src) => {
      const i = src.lastIndexOf(ANCHOR);
      if (i === -1) throw new Error('the shipped entry guard is no longer `if (isEntrypoint) {` — this arm rewrites it by hand');
      return `${src.slice(0, i)}${OLD}${src.slice(i + ANCHOR.length)}`;
    });
    if (dead.code !== EXIT_CLEAN) throw new Error(`the old predicate exited ${dead.code}, not 0 — then it was not the silent-pass defect this fix names`);
    if (dead.out.trim() !== '') throw new Error('the old predicate printed something — then it was not silent and this pair proves nothing');
  } catch (err) {
    oldOk = false;
    oldNote = err?.message ?? String(err);
  }
  if (!oldOk) failed++;
  console.log(`  ${oldOk ? 'ok  ' : 'FAIL'}  entry guard: OLD predicate is silent+0      want=silent+0    ${oldOk ? 'got=silent+0' : `got=${oldNote}`}`);

  console.log('');
  if (failed > 0) {
    console.error(`[stale-opens] SELFTEST FAILED — ${failed} arm(s). The check does not grade what it claims to.`);
    process.exit(EXIT_STALE);
  }
  console.log('[stale-opens] selftest: all arms + controls pass.');
  process.exit(EXIT_CLEAN);
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(`--${f}`);
  const val = (f) => argv.find((a) => a.startsWith(`--${f}=`))?.slice(f.length + 3);

  if (has('help')) {
    console.log('usage: node scripts/check-journal-stale-opens.mjs [--host=URL] [--fixture=FILE] [--grace-days=N] [--json] [--selftest]');
    process.exit(EXIT_USAGE);
  }
  if (has('selftest')) return selftest();

  const graceRaw = val('grace-days');
  const graceDays = graceRaw === undefined ? DEFAULT_GRACE_DAYS : Number(graceRaw);
  if (!Number.isFinite(graceDays) || graceDays < 0) {
    console.error(`[stale-opens] usage: --grace-days must be a non-negative number, got ${JSON.stringify(graceRaw)}`);
    process.exit(EXIT_USAGE);
  }

  const fixture = val('fixture');
  const host = (val('host') ?? DEFAULT_HOST).replace(/\/$/, '');
  const source = fixture ?? `${host}${ROUTE}`;

  let payload;
  try {
    if (fixture) {
      const { readFile } = await import('node:fs/promises');
      payload = JSON.parse(await readFile(fixture, 'utf8'));
    } else {
      const res = await fetch(source, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        console.error(`[stale-opens] BLIND: ${source} returned HTTP ${res.status}`);
        console.error('[stale-opens] A leg could not be READ. This is never a pass.');
        process.exit(EXIT_BLIND);
      }
      payload = await res.json();
    }
  } catch (err) {
    console.error(`[stale-opens] BLIND: could not read ${source} — ${err?.message ?? err}`);
    console.error('[stale-opens] A leg could not be READ. This is never a pass.');
    process.exit(EXIT_BLIND);
  }

  const now = Date.now();
  const g = gradeJournalStaleOpens(payload, now, graceDays);

  if (has('json')) {
    console.log(JSON.stringify({ source, graceDays, gradedAt: new Date(now).toISOString(), build: payload?.build?.commitShort ?? null, ...g }, null, 2));
  } else {
    console.log(`[stale-opens] source ${source}`);
    console.log(`[stale-opens] build  ${payload?.build?.commitShort ?? 'unknown'}   grace ${graceDays}d   OPEN rows ${g.open}`);
    if (g.coverage) {
      console.log(`[stale-opens] zombie-sweep universe ${g.coverage.zombieSweepUniverse} (${g.coverage.zombieSweepOutcome}) — ${g.coverage.outsideZombieSweep} OPEN row(s) are OUTSIDE it`);
    }
    if (g.stale.length > 0) {
      console.log('');
      const byStructure = {};
      for (const s of g.stale) byStructure[s.structure] = (byStructure[s.structure] ?? 0) + 1;
      for (const [k, v] of Object.entries(byStructure).sort((a, b) => b[1] - a[1])) console.log(`[stale-opens]   ${String(v).padStart(3)}  ${k}`);
      console.log('');
      for (const s of g.stale) {
        console.log(`[stale-opens]   ${s.openedAt.slice(0, 10)}  ${String(s.symbol).padEnd(6)} ${s.structure.padEnd(22)} ${s.mode}/${s.accountClass}  dte=${s.entryDte}  expired ${s.impliedExpiry.slice(0, 10)}  +${s.overdueDays}d`);
      }
    }
    for (const u of g.unadjudicable) {
      console.log(`[stale-opens]   UNADJUDICABLE  id=${u.id} ${u.symbol} ${u.structure} openTs=${u.openTs} entryDte=${u.entryDte}`);
    }
  }

  console.log('');
  if (g.verdict === 'BLIND') {
    console.error(`[stale-opens] BLIND — ${g.reason}`);
    console.error('[stale-opens] "could not check" is not "checked and it is fine".');
    process.exit(EXIT_BLIND);
  }
  if (g.verdict === 'STALE') {
    console.error(`[stale-opens] STALE — ${g.stale.length} of ${g.open} OPEN journal row(s) are past contract expiry. They are not book state.`);
    console.error('[stale-opens] Do NOT clear this by deleting or force-closing rows: restating banked history is a BOARD call (TRA-4254 Ask 4).');
    process.exit(EXIT_STALE);
  }
  console.log(`[stale-opens] CLEAN — all ${g.open} OPEN journal row(s) adjudicated, none past expiry + ${graceDays}d grace.`);
  process.exit(EXIT_CLEAN);
}

// Importable for tests; only runs the CLI when invoked directly.
//
// ⛔ THE ENTRY TEST IS IDENTITY-FIRST, NOT NAME-FIRST (TRA-4867, the TRA-4821 class).
// What shipped here read
//     if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('…mjs'))
// and the first arm NEVER BOUND on Windows: `import.meta.url` is `file:///C:/…` while
// `file://${argv[1]}` is `file://C:\…`. So the canonical `pnpm check:journal-stale-opens`
// call was carried entirely by the NAME test — and this repo's grading discipline renames
// the file:
//     git show origin/main:scripts/check-journal-stale-opens.mjs > <scratch>/graded.mjs && node <scratch>/graded.mjs
// Under a name-keyed guard that run evaluates the module, calls NOTHING, prints NOT ONE
// LINE and exits 0 — at the call site indistinguishable from CLEAN, on a detector whose
// whole job is to be loud. The realpath arm makes a renamed copy run; the `endsWith` arm
// stays OR'd in so this can never be strictly LESS permissive than what shipped (a realpath
// that fails to compare — case-folding, a junction, an odd argv[1] — must not silence the
// canonical call). Do not collapse it to one arm, and do not delete the guard: the module
// is imported for its pure `gradeJournalStaleOpens`, and a bare top-level `main()` would
// run the CLI on every import.
const isEntrypoint = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    if (fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url))) return true;
  } catch { /* unreadable argv[1] — fall through to the name test */ }
  return argv1.endsWith('check-journal-stale-opens.mjs');
})();

if (isEntrypoint) {
  main();
}
