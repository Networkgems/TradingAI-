#!/usr/bin/env node
// TRA-4478 — the exchange-calendar freshness alarm, as a repo check.
//
//   pnpm check:calendar-coverage
//   pnpm check:calendar-coverage:controls
//
// ── Why this exists as a CHECK and not only as a runtime gate ───────────────
//
// The runtime gate (`calendarEntryGate`) refuses entries once the active date
// falls outside the shipped bundle. That is the right last line, and it is the
// WRONG place to first find out: by the time it fires, trading has stopped on a
// day the exchange was open. The failure this ticket is about took ~114 days to
// arrive and would have arrived silently, so the detector has to run long
// before the cliff and in a place somebody looks — `pretest` and CI.
//
// ⛔ FAILS CLOSED. An unreadable bundle, an unresolvable ET date, or a
// generator that will not run all read BLIND (3), never 0. "Could not check"
// and "checked and it is covered" must never share an exit code.
//
// ── Exit codes ──────────────────────────────────────────────────────────────
//
//   0 FRESH     covered, with more than the warn horizon of runway left
//   1 STALE     ⛔ the active ET date is NOT covered — this IS the incident
//   2 usage
//   3 BLIND     ⛔ could not check
//   4 EXPIRING  covered, but the cliff is inside the warn horizon — extend it
//   5 DRIFT     the checked-in bundle is not what the generator produces, or
//               the generator's own rule selftest fails
//
// Precedence: BLIND > STALE > DRIFT > EXPIRING > FRESH. A tree that cannot be
// graded outranks a bad grade; an out-of-coverage TODAY outranks a bundle whose
// bytes disagree with the generator, because the first is live damage.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BUNDLE = resolve(REPO, 'packages/server/src/data/nyse-calendar.generated.ts');
const GENERATOR = resolve(REPO, 'scripts/gen-nyse-calendar.mjs');

export const EXIT = { FRESH: 0, STALE: 1, USAGE: 2, BLIND: 3, EXPIRING: 4, DRIFT: 5 };

/** Mirrors CALENDAR_RUNWAY_WARN_DAYS in `packages/server/src/market-calendar.ts`. */
export const WARN_DAYS = 180;

/**
 * Today's date in ET.
 *
 * ⛔ NOT `TZ=America/New_York date` and NOT `toISOString().slice(0,10)`. The
 * first returns UTC verbatim in this repo's Git Bash; the second rolls the day
 * at UTC midnight, which is 19:00/20:00 ET the PREVIOUS day — so between 20:00
 * ET and midnight this check would grade tomorrow's date. That is the exact
 * class of bug the module under test exists to stop, and it would be
 * embarrassing to ship it in the detector.
 */
export function etToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * Pull the coverage window out of the SHIPPED bundle.
 *
 * Deliberately read from the file rather than re-derived from the generator:
 * the file is what the server imports, and a grade computed off the generator
 * would agree with itself even if the two had diverged. The generator↔file
 * identity is a SEPARATE check (`--check`, a byte diff), so the two legs
 * cannot cover for each other.
 */
export function readBundleCoverage(text) {
  const start = /NYSE_CALENDAR_COVERAGE_START\s*=\s*'(\d{4}-\d{2}-\d{2})'/.exec(text);
  const end = /NYSE_CALENDAR_COVERAGE_END\s*=\s*'(\d{4}-\d{2}-\d{2})'/.exec(text);
  const version = /NYSE_CALENDAR_VERSION\s*=\s*'([^']+)'/.exec(text);
  const years = [...text.matchAll(/^\s{4}year:\s*(\d{4}),$/gm)].map(m => Number(m[1]));
  if (!start || !end || !version || years.length === 0) return null;
  return { start: start[1], end: end[1], version: version[1], years };
}

/** Grade a coverage window against an ET date. Pure, so the controls can drive it. */
export function grade(coverage, todayIso, warnDays = WARN_DAYS) {
  if (!coverage) {
    return { code: EXIT.BLIND, label: 'BLIND', detail: 'could not parse the coverage window out of the bundle' };
  }
  if (!ISO_DATE.test(todayIso)) {
    return { code: EXIT.BLIND, label: 'BLIND', detail: `ET date '${todayIso}' is not YYYY-MM-DD` };
  }
  // A year listed in the bundle but missing from [start, end] — or the reverse —
  // means the two halves disagree about what is covered, which is unusable.
  const firstYear = Math.min(...coverage.years);
  const lastYear = Math.max(...coverage.years);
  if (coverage.start.slice(0, 4) !== String(firstYear) || coverage.end.slice(0, 4) !== String(lastYear)) {
    return {
      code: EXIT.BLIND,
      label: 'BLIND',
      detail:
        `the bundle's declared window ${coverage.start}..${coverage.end} disagrees with the year blocks it ` +
        `actually carries (${firstYear}..${lastYear})`,
    };
  }
  if (coverage.years.length !== lastYear - firstYear + 1) {
    return {
      code: EXIT.BLIND,
      label: 'BLIND',
      detail: `the bundle has a HOLE: ${coverage.years.length} year blocks spanning ${firstYear}..${lastYear}`,
    };
  }
  const runwayDays = daysBetween(todayIso, coverage.end);
  if (todayIso < coverage.start || todayIso > coverage.end) {
    return {
      code: EXIT.STALE,
      label: 'STALE',
      runwayDays,
      detail:
        `the exchange calendar covers ${coverage.start}..${coverage.end} and makes NO statement about ` +
        `today (${todayIso}). Entries are failing closed on the live host RIGHT NOW.`,
    };
  }
  if (runwayDays <= warnDays) {
    return {
      code: EXIT.EXPIRING,
      label: 'EXPIRING',
      runwayDays,
      detail: `only ${runwayDays} day(s) of calendar runway remain (ends ${coverage.end}).`,
    };
  }
  return {
    code: EXIT.FRESH,
    label: 'FRESH',
    runwayDays,
    detail: `${runwayDays} day(s) of runway (through ${coverage.end}).`,
  };
}

// ── the run ──────────────────────────────────────────────────────────────────

function runGenerator(args) {
  const r = spawnSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), error: r.error };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'usage: node scripts/check-calendar-coverage.mjs [--selftest]\n' +
        '  0 FRESH · 1 STALE · 2 usage · 3 BLIND · 4 EXPIRING · 5 DRIFT',
    );
    return EXIT.USAGE;
  }
  const unknown = argv.filter(a => a !== '--selftest');
  if (unknown.length) {
    console.error(`unrecognised argument(s): ${unknown.join(' ')}`);
    return EXIT.USAGE;
  }

  let text;
  try {
    text = readFileSync(BUNDLE, 'utf8');
  } catch (e) {
    console.error(`BLIND — cannot read ${BUNDLE}: ${e.message}`);
    return EXIT.BLIND;
  }

  const coverage = readBundleCoverage(text);
  const today = etToday();
  const verdict = grade(coverage, today);

  // BLIND and STALE outrank the generator legs: if we cannot grade the tree, or
  // today is already uncovered, that is the headline and re-running a generator
  // will not change it.
  if (verdict.code === EXIT.BLIND || verdict.code === EXIT.STALE) {
    console.error(`${verdict.label} — ${verdict.detail}`);
    if (verdict.code === EXIT.STALE) {
      console.error('  remedy: raise COVERAGE_END_YEAR in scripts/gen-nyse-calendar.mjs, re-run it, ship.');
    }
    return verdict.code;
  }

  const selftest = runGenerator(['--selftest']);
  if (selftest.status !== 0) {
    console.error('DRIFT — the calendar generator\'s own rule selftest FAILS:');
    console.error(selftest.out.replace(/^/gm, '  '));
    return EXIT.DRIFT;
  }
  const drift = runGenerator(['--check']);
  if (drift.status !== 0) {
    console.error('DRIFT — the checked-in bundle is not what the generator produces:');
    console.error(drift.out.replace(/^/gm, '  '));
    return EXIT.DRIFT;
  }

  const line = `${verdict.label} — calendar ${coverage.version} covers ${today}; ${verdict.detail}`;
  if (verdict.code === EXIT.EXPIRING) {
    console.error(line);
    console.error('  remedy: raise COVERAGE_END_YEAR in scripts/gen-nyse-calendar.mjs, re-run it, ship.');
  } else {
    console.log(line);
  }
  return verdict.code;
}

// ── controls ─────────────────────────────────────────────────────────────────
//
// Every arm drives the PURE grader with a synthetic coverage window, so each
// exit code is exercised for real rather than asserted about. A control suite
// that only ever sees the healthy tree cannot tell you it would have gone red.

function controls() {
  const fails = [];
  const arm = (n, want, got, note) => {
    const ok = got === want;
    console.log(`  ARM ${n} ${ok ? 'PASS' : 'FAIL'} — want ${want}, got ${got} · ${note}`);
    if (!ok) fails.push(n);
  };

  const cov = (start, end) => ({
    start,
    end,
    version: 'synthetic',
    years: Array.from({ length: +end.slice(0, 4) - +start.slice(0, 4) + 1 }, (_, i) => +start.slice(0, 4) + i),
  });

  // ARM 0 — the real tree, right now. The one arm that is not synthetic.
  const real = readBundleCoverage(readFileSync(BUNDLE, 'utf8'));
  arm(0, EXIT.FRESH, grade(real, etToday()).code, `the shipped bundle vs today (${etToday()})`);

  // ARM 1 — THE INCIDENT, replayed. The pre-fix table covered 2025-2026 only;
  // 2027-01-01 is the first date it could not speak to.
  arm(1, EXIT.STALE, grade(cov('2025-01-01', '2026-12-31'), '2027-01-01').code,
    'the retired 2025-2026 table graded against 2027-01-01 (the first miss)');

  // ARM 2 — one day before the cliff is still covered, and must warn, not fail.
  arm(2, EXIT.EXPIRING, grade(cov('2025-01-01', '2026-12-31'), '2026-12-31').code,
    'the last covered day warns rather than reading clean');

  // ARM 3 — comfortably inside coverage.
  arm(3, EXIT.FRESH, grade(cov('2025-01-01', '2035-12-31'), '2026-09-10').code,
    'a wide bundle reads FRESH');

  // ARM 4 — the boundary between FRESH and EXPIRING is where it is claimed.
  arm(4, EXIT.EXPIRING, grade(cov('2025-01-01', '2026-12-31'), '2026-07-04', 180).code,
    `exactly ${180} days of runway is EXPIRING (the horizon is inclusive)`);
  arm(5, EXIT.FRESH, grade(cov('2025-01-01', '2026-12-31'), '2026-07-03', 180).code,
    '181 days of runway is FRESH');

  // ARM 6 — a date BEFORE coverage is stale too. A bundle that starts in the
  // future is just as unusable as one that ended in the past, and a
  // `today > end` check alone would call it clean.
  arm(6, EXIT.STALE, grade(cov('2030-01-01', '2035-12-31'), '2026-09-10').code,
    'a date before the coverage window is STALE, not FRESH');

  // ARM 7 — fail-closed on an unreadable date and an unparseable bundle.
  arm(7, EXIT.BLIND, grade(cov('2025-01-01', '2035-12-31'), 'garbage').code,
    'an unreadable ET date is BLIND, never FRESH');
  arm(8, EXIT.BLIND, grade(null, '2026-09-10').code, 'an unparseable bundle is BLIND, never FRESH');

  // ARM 9 — the two halves of the bundle disagreeing is BLIND, not a grade.
  arm(9, EXIT.BLIND,
    grade({ start: '2025-01-01', end: '2035-12-31', version: 'x', years: [2025, 2026] }, '2026-09-10').code,
    'declared window wider than the year blocks carried');
  arm(10, EXIT.BLIND,
    grade({ start: '2025-01-01', end: '2027-12-31', version: 'x', years: [2025, 2027] }, '2026-09-10').code,
    'a HOLE in the year blocks (2026 missing) is BLIND');

  // ARM 11 — the generator legs, driven for real.
  arm(11, 0, runGenerator(['--selftest']).status, 'the generator rule selftest passes on the shipped rules');
  arm(12, 0, runGenerator(['--check']).status, 'the checked-in bundle matches the generator byte-for-byte');

  // ARM 13/14 — NEGATIVE CONTROLS on the drift leg, in a temp dir so the real
  // tree is never touched. A drift detector that has only ever been run
  // against a clean tree is not evidence that it can go red; and one that
  // reports 0 when the file is simply ABSENT is the silent-green shape this
  // whole ticket is about.
  const tmp = mkdtempSync(join(tmpdir(), 'tra4478-'));
  try {
    const clean = readFileSync(BUNDLE, 'utf8');
    const corrupt = join(tmp, 'corrupt.ts');
    // Delete ONE closure — the smallest possible real drift.
    writeFileSync(corrupt, clean.replace(/^\s*\['2027-01-01'.*\n/m, ''), 'utf8');
    arm(13, 1, runGenerator([`--check`, `--file=${corrupt}`]).status,
      'a bundle missing exactly one closure (2027-01-01) reads DRIFT');
    arm(14, 1, runGenerator([`--check`, `--file=${join(tmp, 'absent.ts')}`]).status,
      'an ABSENT bundle reads DRIFT, never 0');
    const same = join(tmp, 'same.ts');
    writeFileSync(same, clean, 'utf8');
    arm(15, 0, runGenerator([`--check`, `--file=${same}`]).status,
      'an identical copy reads clean — ARMs 13/14 are not just always-red');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  arm(16, true, grade(cov('2025-01-01', '2026-12-31'), '2027-01-01').code !== grade(cov('2025-01-01', '2035-12-31'), '2027-01-01').code,
    'the grader DISTINGUISHES the broken bundle from the fixed one on the same date');

  console.log(fails.length ? `\ncheck:calendar-coverage controls: ${fails.length} FAILED (${fails.join(', ')})` : '\ncheck:calendar-coverage controls: ALL PASS');
  return fails.length ? 1 : 0;
}

const argv = process.argv.slice(2);
process.exit(argv.includes('--selftest') ? controls() : main(argv));
