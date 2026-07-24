// TRA-2214 — a STATIC guard that a MODEL-FACING journal fold cannot go back to
// reading the raw, pooled journal.
//
// This is the second time the same omission has shipped, which is why it is a
// test and not a comment:
//
//   • TRA-1475 added `excludeTestAccountRows` at the two `/api/reports/desk*`
//     call sites — the only consumers at the time.
//   • TRA-2210 found a THIRD consumer (the per-account DEMO calendar) folding
//     bare, and closed it with a composed entry point.
//   • TRA-2212 then found FOUR MORE, all of them MODEL-facing: the autopilot
//     edge-decay refresh, the learned-weights cache, the analyst post-market
//     tuner, and the EOD journal blocks. Those four were not summing a number a
//     human reads — they were TRAINING on the QA fixture books.
//
// The behavioural proof that the predicate works lives in
// `model-facing-journal.test.ts`. This file guards the part a behavioural test
// cannot see: that the production call graph still goes through it. The failure
// it catches is silent by construction — folding pooled rows does not throw, log,
// or return a malformed shape. On the live journal the edge-decay verdict is
// `['single_leg_otm']` on BOTH bases, so even the downstream output reads
// identically; only `journalBasisCounts.fixtureExcluded` separates them.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The module that composes load+predicate; it alone may name the raw loader. */
const OWNER = 'model-facing-journal.ts';

/** The composed entry points every model-facing consumer must come through. */
const ENTRIES = [
  'loadModelFacingJournal',
  'loadModelFacingJournalRows',
  'foldModelFacingEodJournal',
  'applyModelFacingBasis',
] as const;

/** The raw loader. Reaching it directly folds the pooled population. */
const RAW_LOADER = 'listOptionTradeJournal';

/**
 * The four TRA-2212 model-facing consumers, each pinned to a symbol that proves
 * the module still does the job the guard thinks it does.
 *
 * The `stillDoes` literal is the anti-self-disarm control. A guard that only bans
 * `listOptionTradeJournal` in `analyst-scheduler.ts` passes trivially once the
 * post-market tuner moves to another file — the ban matches nothing and goes
 * quiet exactly when it should fire. Pinning the consumer's own distinguishing
 * symbol means a move or a rename fails HERE and forces this list to follow.
 */
const MODEL_FACING = [
  { path: 'signal-engine.ts', stillDoes: 'autopilotDecayingStrategies' },
  { path: 'learned-weights-cache.ts', stillDoes: 'computeOptionLearnedWeights' },
  { path: 'analyst-scheduler.ts', stillDoes: 'buildPostmarketDeps' },
  { path: 'model-facing-journal.ts', stillDoes: 'computeStrategyIntrospection' },
] as const;

/**
 * `index.ts` hosts BOTH the EOD model-facing fold and the `/api/reports/desk*`
 * routes, and the desk routes legitimately load the raw journal (they run their
 * own `excludeTestAccountRows` via `buildJournalCalendarCells`). So it cannot be
 * subject to a blanket ban on the raw loader.
 *
 * Instead the EOD fold was moved OUT of it (`foldModelFacingEodJournal`), which
 * converts the assertion from "does it filter?" — unanswerable with a regex —
 * into "does it still hold a fold at all?", which is answerable exactly.
 */
const EOD_HOST = 'index.ts';
const BARE_FOLDS = [
  'computeOptionLearnedWeights',
  'computeStrategyIntrospection',
  'optionJournalToStrategyRows',
  'summarizeOptionTradeJournal',
] as const;

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

/** Blank out strings/comments so a prose mention of a symbol is not read as a call. */
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

const rel = (p: string) => relative(SRC_ROOT, p).split(sep).join('/');

describe('TRA-2214: model-facing journal folds have one entry point', () => {
  const files = productionSources(SRC_ROOT).map((p) => ({
    path: rel(p),
    code: mask(readFileSync(p, 'utf8')),
  }));
  const find = (path: string) => files.find((f) => f.path === path);

  it('scans a real, populated tree (guard is not vacuous)', () => {
    // The positive control. A wrong root, a rename, or a moved package would make
    // the walk return nothing and every assertion below pass on an empty list.
    expect(files.length).toBeGreaterThan(50);
    expect(find(OWNER)).toBeDefined();
    expect(find(EOD_HOST)).toBeDefined();
  });

  it('the owner still exports the entry points the guard redirects to', () => {
    // Ban lists name their targets as string literals, so a rename anywhere here
    // makes the guard match nothing and go quiet while the hole reopens.
    const owner = find(OWNER)!;
    for (const entry of ENTRIES) {
      expect(owner.code, `${entry} missing from ${OWNER}`).toContain(entry);
    }
    expect(owner.code, 'the owner must be the one place naming the raw loader')
      .toContain(RAW_LOADER);
  });

  it.each(MODEL_FACING)('$path folds through the shared predicate', ({ path, stillDoes }) => {
    const f = find(path);
    expect(f, `${path} not found — did it move? update MODEL_FACING`).toBeDefined();
    // Anti-self-disarm: the module must still be the consumer this guard covers.
    expect(f!.code, `${path} no longer contains ${stillDoes}`).toContain(stillDoes);

    if (path !== OWNER) {
      // The defect verbatim: a model-facing consumer reading the pooled journal.
      expect(f!.code, `${path} reaches the raw ${RAW_LOADER}`).not.toContain(RAW_LOADER);
      expect(ENTRIES.some((e) => f!.code.includes(e)), `${path} imports no entry point`)
        .toBe(true);
    }
  });

  it('index.ts holds no bare journal fold (the EOD block moved to the owner)', () => {
    const host = find(EOD_HOST)!;
    // index.ts may still load the raw journal — the desk routes need it — but it
    // must no longer FOLD it, because a fold there is one edit away from being
    // handed the desk routes' pooled row list while still publishing a
    // `journalBasis: 'desk+unattributed'` label.
    const offenders = BARE_FOLDS.filter((fold) => host.code.includes(fold));
    expect(offenders).toEqual([]);
    expect(host.code).toContain('foldModelFacingEodJournal');
  });

  it('no production module folds learned weights off an unfiltered journal read', () => {
    // The sweep that found the fifth site the ticket did not name:
    // `/api/health/option-journal` fell back to `computeOptionLearnedWeights(rows)`
    // on a bare read whenever the weights cache was cold — one field, two bases,
    // switching on cache warmth. Any module that both loads the journal AND folds
    // weights must name the predicate.
    const offenders = files
      .filter((f) => f.path !== OWNER)
      .filter((f) => f.code.includes(RAW_LOADER) && f.code.includes('computeOptionLearnedWeights('))
      .filter((f) => !ENTRIES.some((e) => f.code.includes(e)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
