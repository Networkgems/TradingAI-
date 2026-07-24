// TRA-2210 — a STATIC guard that the QA/test de-noise cannot be bypassed by the
// NEXT consumer of the demo option journal.
//
// Why this exists as a test and not a comment. The de-noise has now been forgotten
// once, and the miss was invisible until the board read the number:
//
//   • TRA-1475 added `excludeTestAccountRows` at the two `/api/reports/desk*` call
//     sites — the only two consumers of the fold at the time.
//   • TRA-1572 then added a THIRD consumer: the per-account DEMO calendar fills a
//     day the personal book was silent on from that SAME firm-wide journal. It
//     called the bare `aggregateDeskCalendar`, so it summed the QA churn Desk drops.
//     On 2026-07-22 "My Account" read **+$4,919.50** against Desk's **+$119.50** —
//     a per-user book showing 41x the whole firm, $4,800 of it three fixture mirrors
//     of ONE SMCI close (+$1,600 x3, each with a distinct `id`, so id-dedupe sees no
//     duplicate).
//
// The failure mode is what makes it expensive: an unfiltered fold does not throw,
// log, or read as wrong. It returns a well-formed cell with a plausible number, and
// the only tell is a cross-view comparison nobody runs until a board member does.
//
// `buildJournalCalendarCells` composes filter+fold into one entry point so no call
// site CAN omit the filter — but that is only true while the bare folds stay
// unreferenced. Both are still `export`ed (their own unit tests need them), so
// consumer #4 can still import one and re-open the hole. This test is the part that
// notices. Add such an import and it fails HERE, at commit time, instead of in a
// number the board reads three weeks later.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The module that owns the folds; it is allowed — required — to reference them. */
const OWNER = 'reports/desk-calendar.ts';

/** The single composed entry point every production consumer must go through. */
const ENTRY = 'buildJournalCalendarCells';

/**
 * The un-composed folds. Reaching either one directly skips `excludeTestAccountRows`
 * and re-creates the TRA-2210 overstatement.
 *
 * `buildDeskDayReport` is listed alongside `aggregateDeskCalendar` deliberately: it
 * is the per-day half of the same fold, it takes the same unfiltered row list, and a
 * route that wanted "just one day" is exactly the plausible next caller.
 */
const BARE_FOLDS = ['aggregateDeskCalendar', 'buildDeskDayReport'] as const;

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Blank out strings/comments so a prose mention of a fold is not read as a call. */
function mask(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i);
      const stop = j < 0 ? src.length : j;
      for (let k = i; k < stop; k++) out[k] = ' ';
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      const stop = j < 0 ? src.length : j + 2;
      for (let k = i; k < stop; k++) out[k] = ' ';
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      for (let k = i + 1; k < Math.min(j - 1, src.length) + 1; k++) out[k] = ' ';
      i = j;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Every production `.ts` under packages/server/src — tests and .d.ts excluded. */
function productionSources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      productionSources(p, acc);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/** Repo-relative, forward-slashed, so assertions read the same on Windows and CI. */
const rel = (p: string) => relative(SRC_ROOT, p).split(sep).join('/');

describe('TRA-2210: the journal->calendar de-noise has exactly one entry point', () => {
  const files = productionSources(SRC_ROOT).map((p) => ({
    path: rel(p),
    code: mask(readFileSync(p, 'utf8')),
  }));

  const owner = files.find((f) => f.path === OWNER);

  it('scans a real, populated tree (guard is not vacuous)', () => {
    // A positive control. If the walk silently returned nothing — wrong root, a
    // rename, a moved package — every assertion below would pass trivially on an
    // empty list and this guard would be decorative rather than protective.
    expect(files.length).toBeGreaterThan(50);
    expect(owner).toBeDefined();
  });

  it('still has the folds it is guarding (a rename must not silently disarm it)', () => {
    // The guard names its targets as literals, so renaming a fold would make the
    // ban match nothing and go quiet while the hole reopened. Pin the names to the
    // owning module: rename one and this fails, forcing the ban list to follow.
    for (const fold of BARE_FOLDS) {
      expect(owner!.code, `${fold} missing from ${OWNER}`).toContain(fold);
    }
    expect(owner!.code).toContain(ENTRY);
  });

  it('routes production consumers through buildJournalCalendarCells', () => {
    // The three call sites of TRA-2210: the per-account DEMO calendar fill and the
    // two /api/reports/desk* routes. Asserted as a floor, not an equality — a fourth
    // legitimate consumer is fine, it just has to come through the front door.
    const consumers = files.filter((f) => f.path !== OWNER && f.code.includes(ENTRY));
    const callSites = consumers.reduce(
      (n, f) => n + (f.code.match(new RegExp(`\\b${ENTRY}\\s*\\(`, 'g')) ?? []).length,
      0,
    );
    expect(callSites).toBeGreaterThanOrEqual(3);
  });

  it('lets no production module outside the fold module touch a bare fold', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.path === OWNER) continue;
      for (const fold of BARE_FOLDS) {
        if (new RegExp(`\\b${fold}\\b`).test(f.code)) offenders.push(`${f.path} -> ${fold}`);
      }
    }
    // Each entry here is a consumer folding the journal WITHOUT the QA de-noise —
    // the TRA-2210 defect verbatim. Route it through `buildJournalCalendarCells`.
    expect(offenders).toEqual([]);
  });
});
