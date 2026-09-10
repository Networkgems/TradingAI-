#!/usr/bin/env node
// TRA-4478 — generator for the checked-in NYSE exchange-calendar bundles.
//
// Exchange policy does not belong inline in application code, and it also does
// not belong in a hand-typed list: `MARKET_HOLIDAYS` in `scheduler.ts` was a
// hand-typed `Set` covering 2025-2026 only, so from 2027-01-01 every NYSE
// holiday silently read as a trading day. This script encodes the OBSERVANCE
// RULES once and emits the dates, so extending coverage is a re-run, not a
// typing exercise.
//
//   node scripts/gen-nyse-calendar.mjs            # write the bundle
//   node scripts/gen-nyse-calendar.mjs --check    # exit 1 if the checked-in
//                                                 # file is not what the rules
//                                                 # produce (drift detector)
//   node scripts/gen-nyse-calendar.mjs --print    # dump to stdout, write nothing
//   node scripts/gen-nyse-calendar.mjs --selftest # grade the rules against
//                                                 # independently-known dates
//
// ── The rules (NYSE Rule 7.2) ────────────────────────────────────────────────
//
// FULL CLOSURES
//   New Year's Day        Jan 1
//   MLK Day               3rd Monday of January            (from 1998)
//   Washington's Birthday 3rd Monday of February
//   Good Friday           the Friday before Easter Sunday
//   Memorial Day          last Monday of May
//   Juneteenth            Jun 19                            (from 2022)
//   Independence Day      Jul 4
//   Labor Day             1st Monday of September
//   Thanksgiving          4th Thursday of November
//   Christmas             Dec 25
//
// WEEKEND OBSERVATION
//   Saturday -> observed the preceding Friday.
//   Sunday   -> observed the following Monday.
//   ⛔ ONE EXCEPTION, and it is the one a naive implementation gets wrong:
//      when Jan 1 falls on a SATURDAY the NYSE does NOT close the preceding
//      Friday (Dec 31) and does NOT close Jan 3 either — there is simply no
//      New Year's holiday that season. Rolling it back into December would
//      also push the holiday into the PREVIOUS year's bundle, which is how a
//      per-year generator quietly loses a date at a bundle seam.
//
// EARLY CLOSES (13:00 ET)
//   The Friday after Thanksgiving                — always.
//   Dec 24, when it falls Mon-Thu                — when Dec 24 is a Friday the
//                                                  25th is a Saturday, so the
//                                                  24th is not an eve session.
//   Jul 3, when it falls Mon-Thu                 — when Jul 3 is a Friday, Jul 4
//                                                  is a Saturday and Jul 3 is
//                                                  itself the observed holiday
//                                                  (a full closure, not an
//                                                  early close).
//   An early close is only emitted when the day is otherwise a session: never
//   on a weekend, and never on a day already in the closure list.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT = resolve(REPO, 'packages/server/src/data/nyse-calendar.generated.ts');

/**
 * Coverage the checked-in bundle carries. Extend END and re-run to widen it.
 *
 * ⛔ THE FLOOR IS AS LOAD-BEARING AS THE CLIFF, and it is the half that is easy
 * to leave out. A calendar starting at "now" refuses every historical date, so
 * a replay/backtest run, or any fixture pinned to a past instant, reads as an
 * uncovered date and halts — a 2024-06-04 fixture found exactly that during
 * TRA-4478. Start early enough to cover the fixtures and the replay window.
 *
 * ⚠️ Reaching back means reaching past two RULE CHANGES. See `EFFECTIVE_FROM`.
 */
export const COVERAGE_START_YEAR = 2015;
export const COVERAGE_END_YEAR = 2035;

/**
 * The first year the NYSE observed a given holiday. Emitting a holiday for a
 * year before it existed is the mirror image of missing one after: both
 * mis-date the fold, and the historical direction is quieter because nobody
 * looks at a 2019 fixture twice.
 *
 *   Juneteenth — first observed 2022 (2022-06-20; Jun 19 fell on a Sunday).
 *   MLK Day    — first observed 1998.
 */
const EFFECTIVE_FROM = {
  juneteenth: 2022,
  mlk: 1998,
};

// ── date helpers (all UTC-anchored; these are calendar dates, not instants) ──

const iso = ms => new Date(ms).toISOString().slice(0, 10);
const mk = (y, m, d) => Date.UTC(y, m - 1, d);
/** 0=Sun … 6=Sat, timezone-independent because the value is date-only. */
const dow = ms => new Date(ms).getUTCDay();

/** The `n`-th `weekday` of `month` in `year` (n is 1-based). */
function nthWeekday(year, month, weekday, n) {
  const first = mk(year, month, 1);
  const delta = (weekday - dow(first) + 7) % 7;
  return first + (delta + (n - 1) * 7) * 86_400_000;
}

/** The last `weekday` of `month` in `year`. */
function lastWeekday(year, month, weekday) {
  const last = mk(year, month + 1, 1) - 86_400_000;
  return last - ((dow(last) - weekday + 7) % 7) * 86_400_000;
}

/**
 * Easter Sunday (Gregorian), Meeus/Jones/Butcher. Good Friday is Easter - 2d.
 * Spelled out rather than table-driven so extending coverage never needs a
 * second data source.
 */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return mk(year, month, day);
}

/**
 * Apply the weekend-observation rule. Returns `null` for the New Year's
 * Saturday case — see the ⛔ note in the header.
 */
function observe(ms, { isNewYears = false } = {}) {
  const wd = dow(ms);
  if (wd === 6) return isNewYears ? null : ms - 86_400_000; // Sat -> Fri
  if (wd === 0) return ms + 86_400_000; // Sun -> Mon
  return ms;
}

// ── the rules ────────────────────────────────────────────────────────────────

/** Full closures for `year`, as `{ date, name }`, ascending. */
export function closuresFor(year) {
  const out = [];
  const push = (ms, name) => {
    if (ms !== null) out.push({ date: iso(ms), name });
  };

  push(observe(mk(year, 1, 1), { isNewYears: true }), "New Year's Day");
  if (year >= EFFECTIVE_FROM.mlk) push(nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day');
  push(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  push(easterSunday(year) - 2 * 86_400_000, 'Good Friday');
  push(lastWeekday(year, 5, 1), 'Memorial Day');
  if (year >= EFFECTIVE_FROM.juneteenth) {
    push(observe(mk(year, 6, 19)), 'Juneteenth National Independence Day');
  }
  push(observe(mk(year, 7, 4)), 'Independence Day');
  push(nthWeekday(year, 9, 1, 1), 'Labor Day');
  push(nthWeekday(year, 11, 4, 4), 'Thanksgiving Day');
  push(observe(mk(year, 12, 25)), 'Christmas Day');

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** 13:00 ET early closes for `year`, as `{ date, name }`, ascending. */
export function earlyClosesFor(year) {
  const closed = new Set(closuresFor(year).map(h => h.date));
  const out = [];
  const push = (ms, name) => {
    const wd = dow(ms);
    if (wd === 0 || wd === 6) return; // never a session
    if (closed.has(iso(ms))) return; // a full closure outranks an early close
    out.push({ date: iso(ms), name });
  };

  push(nthWeekday(year, 11, 4, 4) + 86_400_000, 'Day after Thanksgiving');
  push(mk(year, 12, 24), 'Christmas Eve');
  push(mk(year, 7, 3), 'Day before Independence Day');

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// ── emit ─────────────────────────────────────────────────────────────────────

function render() {
  const years = [];
  for (let y = COVERAGE_START_YEAR; y <= COVERAGE_END_YEAR; y++) years.push(y);

  const bundle = years.map(y => ({
    year: y,
    closures: closuresFor(y),
    earlyCloses: earlyClosesFor(y),
  }));

  const body = bundle
    .map(b => {
      const cl = b.closures.map(h => `      ['${h.date}', '${h.name.replace(/'/g, "\\'")}'],`).join('\n');
      const ec = b.earlyCloses.map(h => `      ['${h.date}', '${h.name.replace(/'/g, "\\'")}'],`).join('\n');
      return [
        `  {`,
        `    year: ${b.year},`,
        `    closures: [`,
        cl,
        `    ],`,
        `    earlyCloses: [`,
        ec,
        `    ],`,
        `  },`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  return `// GENERATED by \`node scripts/gen-nyse-calendar.mjs\` — DO NOT EDIT BY HAND.
//
// TRA-4478 — NYSE exchange calendar, one bundle per year. Hand-editing this
// file silently breaks \`pnpm check:calendar-coverage\`, which re-runs the
// generator and diffs. To change coverage, edit COVERAGE_END_YEAR in the
// generator and re-run it.
//
// \`closures\` are full-day closures. \`earlyCloses\` are 13:00 ET sessions.
// Both are ET calendar dates (\`YYYY-MM-DD\`), ascending within a year.

/** One year of NYSE exchange policy. \`[date, name]\` pairs. */
export interface NyseCalendarYear {
  year: number;
  closures: ReadonlyArray<readonly [string, string]>;
  earlyCloses: ReadonlyArray<readonly [string, string]>;
}

/**
 * Bumped whenever the generated content changes, so a live host can report
 * WHICH calendar it is running rather than only that it has one.
 */
export const NYSE_CALENDAR_VERSION = 'nyse-${COVERAGE_START_YEAR}-${COVERAGE_END_YEAR}';

/** First and last ET dates this bundle makes a statement about. */
export const NYSE_CALENDAR_COVERAGE_START = '${COVERAGE_START_YEAR}-01-01';
export const NYSE_CALENDAR_COVERAGE_END = '${COVERAGE_END_YEAR}-12-31';

export const NYSE_CALENDAR_YEARS: readonly NyseCalendarYear[] = [
${body}
];
`;
}

// ── selftest: grade the rules against independently-known dates ──────────────

function selftest() {
  const fails = [];
  const ok = (cond, msg) => {
    if (!cond) fails.push(msg);
  };

  const closures = y => new Set(closuresFor(y).map(h => h.date));
  const earlies = y => new Set(earlyClosesFor(y).map(h => h.date));

  // 1. The two years the hand-typed table covered must reproduce EXACTLY. This
  //    is the generator's positive control: it is graded against a list written
  //    by a different method (by hand, from the NYSE site, in 2025).
  const HAND_2025 = [
    '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
    '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  ];
  const HAND_2026 = [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
    '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  ];
  for (const [year, hand] of [[2025, HAND_2025], [2026, HAND_2026]]) {
    const got = closuresFor(year).map(h => h.date);
    ok(
      got.length === hand.length && got.every((d, i) => d === hand[i]),
      `${year} closures differ from the hand-typed scheduler.ts table:\n    want ${hand.join(' ')}\n    got  ${got.join(' ')}`,
    );
  }

  // 2. The first miss the incident names.
  ok(closures(2027).has('2027-01-01'), '2027-01-01 (Friday) must be a closure — this is the first miss');

  // 3. Good Friday, independently known.
  const GOOD_FRIDAY = {
    2025: '2025-04-18', 2026: '2026-04-03', 2027: '2027-03-26',
    2028: '2028-04-14', 2029: '2029-03-30', 2030: '2030-04-19',
  };
  for (const [y, d] of Object.entries(GOOD_FRIDAY)) {
    ok(closures(+y).has(d), `Good Friday ${y} should be ${d}`);
    ok(dow(Date.parse(d + 'T00:00:00Z')) === 5, `${d} should be a Friday`);
  }

  // 4. Weekend observation, both directions plus the New Year's exception.
  //    2027-07-04 is a Sunday -> observed Monday 07-05.
  ok(closures(2027).has('2027-07-05'), '2027: Jul 4 is a Sunday -> holiday observed Mon Jul 5');
  ok(!closures(2027).has('2027-07-04'), '2027: Jul 4 itself is a Sunday, not a session at all');
  //    2026-07-04 is a Saturday -> observed Friday 07-03.
  ok(closures(2026).has('2026-07-03'), '2026: Jul 4 is a Saturday -> holiday observed Fri Jul 3');
  //    2028-01-01 is a Saturday -> NO New Year's holiday that season.
  ok(dow(mk(2028, 1, 1)) === 6, 'precondition: 2028-01-01 is a Saturday');
  ok(!closures(2027).has('2027-12-31'), '2028 New Year on a Saturday must NOT close Fri 2027-12-31');
  ok(!closures(2028).has('2028-01-03'), '2028 New Year on a Saturday must NOT roll forward to Mon Jan 3');
  ok(!closures(2028).has('2028-01-01'), '2028-01-01 is a Saturday, not a session');

  // 5. Early closes.
  ok(earlies(2025).has('2025-11-28'), '2025: day after Thanksgiving (Nov 28) is a 13:00 close');
  ok(earlies(2025).has('2025-12-24'), '2025: Dec 24 is a Wednesday -> 13:00 close');
  ok(earlies(2025).has('2025-07-03'), '2025: Jul 3 is a Thursday -> 13:00 close');
  ok(!earlies(2026).has('2026-07-03'), '2026: Jul 3 is the OBSERVED holiday, a full closure not an early close');
  ok(!earlies(2027).has('2027-07-03'), '2027: Jul 3 is a Saturday -> not a session, no early close');
  //    2027-12-24 is a Friday, so Dec 25 is a Saturday -> Dec 24 is the observed
  //    Christmas closure, NOT an early close.
  ok(dow(mk(2027, 12, 24)) === 5, 'precondition: 2027-12-24 is a Friday');
  ok(closures(2027).has('2027-12-24'), '2027: Christmas on a Saturday -> observed Fri Dec 24 (full closure)');
  ok(!earlies(2027).has('2027-12-24'), '2027: Dec 24 is a full closure, so it must not also be an early close');

  // 6. No date may be both a closure and an early close, in any covered year.
  for (let y = COVERAGE_START_YEAR; y <= COVERAGE_END_YEAR; y++) {
    const c = closures(y);
    for (const d of earlies(y)) ok(!c.has(d), `${d} is both a closure and an early close`);
    for (const d of c) {
      ok(d.startsWith(`${y}-`), `closure ${d} leaked out of its ${y} bundle`);
      const wd = dow(Date.parse(d + 'T00:00:00Z'));
      ok(wd !== 0 && wd !== 6, `closure ${d} lands on a weekend — the observation rule did not fire`);
    }
  }

  // 7. Every covered year must carry EXACTLY the count its rules imply. A bare
  //    "the list is non-empty" check would not see a missing or doubled
  //    holiday, and a loose "9 or 10" would not see Juneteenth leaking into a
  //    pre-2022 year.
  for (let y = COVERAGE_START_YEAR; y <= COVERAGE_END_YEAR; y++) {
    let want = 10;
    if (y < EFFECTIVE_FROM.juneteenth) want -= 1;
    if (y < EFFECTIVE_FROM.mlk) want -= 1;
    if (dow(mk(y, 1, 1)) === 6) want -= 1; // the New Year's-on-Saturday season
    const n = closuresFor(y).length;
    ok(n === want, `${y} has ${n} closures; the rules imply ${want}`);
  }

  // 7b. HISTORICAL RULE CHANGES. Reaching the coverage floor back past 2022
  //     means reaching past Juneteenth's introduction; emitting it for 2019 is
  //     the mirror image of missing 2027-01-01, and quieter.
  ok(!closures(2021).has('2021-06-18') && !closures(2021).has('2021-06-19'),
    '2021 must carry NO Juneteenth — the NYSE first observed it in 2022');
  ok(closures(2022).has('2022-06-20'),
    '2022: Juneteenth\'s first NYSE observance (Jun 19 was a Sunday -> Mon Jun 20)');
  ok(!closures(2021).has('2021-12-31') && !closures(2022).has('2022-01-03'),
    '2022 New Year fell on a Saturday -> no holiday (NYSE traded Fri 2021-12-31)');

  // 7c. Two more independently-known years, transcribed by hand like 2025/2026.
  const HAND_2024 = [
    '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27',
    '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  ];
  const HAND_2022 = [
    '2022-01-17', '2022-02-21', '2022-04-15', '2022-05-30', '2022-06-20',
    '2022-07-04', '2022-09-05', '2022-11-24', '2022-12-26',
  ];
  for (const [year, hand] of [[2024, HAND_2024], [2022, HAND_2022]]) {
    const got = closuresFor(year).map(h => h.date);
    ok(
      got.length === hand.length && got.every((d, i) => d === hand[i]),
      `${year} closures differ from the hand-transcribed NYSE list:\n    want ${hand.join(' ')}\n    got  ${got.join(' ')}`,
    );
  }
  ok(earlies(2024).has('2024-07-03') && earlies(2024).has('2024-11-29') && earlies(2024).has('2024-12-24'),
    '2024 early closes: Jul 3 (Wed), Nov 29 (Fri after Thanksgiving), Dec 24 (Tue)');

  // 7d. The coverage FLOOR must reach the fixtures. A calendar that starts at
  //     "now" refuses every historical date and halts replay — the direction
  //     this ticket nearly shipped (a 2024-06-04 fixture caught it).
  ok(COVERAGE_START_YEAR <= 2024, `coverage floor ${COVERAGE_START_YEAR} must reach the pre-2025 fixtures`);

  // 8. NEGATIVE CONTROL — the selftest must be able to FAIL. Re-run rule 4's
  //    New Year's assertion against a deliberately-wrong observer and require
  //    that it disagrees. A control suite that cannot go red is not a control.
  const naive = ms => (dow(ms) === 6 ? ms - 86_400_000 : dow(ms) === 0 ? ms + 86_400_000 : ms);
  ok(
    iso(naive(mk(2028, 1, 1))) === '2027-12-31' && observe(mk(2028, 1, 1), { isNewYears: true }) === null,
    'negative control broke: the naive observer no longer disagrees with the NYSE rule',
  );

  if (fails.length) {
    console.error(`gen-nyse-calendar selftest: ${fails.length} FAILED`);
    for (const f of fails) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`gen-nyse-calendar selftest: PASS (${COVERAGE_START_YEAR}-${COVERAGE_END_YEAR})`);
}

// ── main ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
  selftest();
} else if (argv.includes('--print')) {
  process.stdout.write(render());
} else if (argv.includes('--check')) {
  // `--file=<path>` grades some other copy instead of the checked-in one. It
  // exists so `check-calendar-coverage.mjs --selftest` can point this leg at a
  // deliberately-corrupted temp copy and prove it goes RED — a drift detector
  // that has only ever been run against a clean tree is not evidence.
  const override = argv.find(a => a.startsWith('--file='));
  const target = override ? resolve(override.slice('--file='.length)) : OUT;
  const want = render();
  let have;
  try {
    have = readFileSync(target, 'utf8');
  } catch {
    console.error(`MISSING: ${target} does not exist. Run: node scripts/gen-nyse-calendar.mjs`);
    process.exit(1);
  }
  if (have.replace(/\r\n/g, '\n') !== want.replace(/\r\n/g, '\n')) {
    console.error(`DRIFT: ${target} is not what the rules produce.`);
    console.error('       Re-run: node scripts/gen-nyse-calendar.mjs');
    process.exit(1);
  }
  console.log(`${target} matches the generator.`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, render(), 'utf8');
  console.log(`wrote ${OUT} (${COVERAGE_START_YEAR}-${COVERAGE_END_YEAR})`);
}
