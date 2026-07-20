// TRA-2075 / TRA-2076 — executable tripwire for the deploy-floor SCOPE EXEMPTION.
//
// `sentiment-ic-harness` is graded by running `tsx src/run-tra822-sentiment-ic.ts` out of the
// agent workspace checkout, so fixes to it are live-on-merge and the Render deploy floor
// (TRA-1715) does NOT gate them. That exemption does not rest on "`packages/backtest` isn't
// deployed" — the package IS a server runtime dependency (`packages/server/package.json`:
// `"@trading-app/backtest": "workspace:*"`) and DOES ship to Render.
//
// The real predicate is REACHABILITY: the harness is not on the package's public surface and
// nothing in the server's import graph pulls it in. Those two claims grade identically today
// and come apart silently — add `export * from './sentiment-ic-harness.js'` to the barrel and
// call `gradeGate` server-side, and the exemption LAPSES while "isn't deployed" still reads
// true to whoever greps the thread next.
//
// This file is the part that notices. If it goes red, the deploy floor has started applying to
// the sentiment-IC grading path: `d9e312e`-class fixes are no longer live-on-merge and must be
// deployed before any verdict computed from them is trusted.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARREL = resolve(HERE, 'index.ts');
const PKG_JSON = resolve(HERE, '..', 'package.json');
const SERVER_SRC = resolve(HERE, '..', '..', 'server', 'src');

/** The harness module, and the graded symbols whose escalation branch writes to Paperclip. */
const HARNESS_MODULE = 'sentiment-ic-harness';
const GRADED_SYMBOLS = ['gradeGate', 'gradeSignalAlone', 'computeIc'];

/**
 * Strip line and block comments so a prose mention of the harness (there are two in the
 * server today) is not mistaken for an import. Deliberately crude — it only has to be right
 * about comments, and a false RED here is cheap while a false GREEN defeats the guard.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('TRA-2075 scope exemption — sentiment-IC harness stays unreachable from the server', () => {
  it('is absent from the package barrel', () => {
    const barrel = stripComments(readFileSync(BARREL, 'utf8'));
    expect(
      barrel.includes(HARNESS_MODULE),
      `${HARNESS_MODULE} entered src/index.ts. The harness is now on the package's public ` +
        'surface, so the TRA-1715 deploy floor applies to the sentiment-IC grading path. ' +
        'Re-grade the exemption before trusting a verdict computed from an unshipped fix.',
    ).toBe(false);
  });

  it('has no subpath export that would surface it around the barrel', () => {
    const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    // A wildcard ("./*") or an explicit harness subpath both make it importable without the
    // barrel — the barrel check above would stay green while reachability is already lost.
    const subpaths = Object.keys(pkg.exports ?? {});
    expect(subpaths).toEqual(['.']);
  });

  it('is not imported anywhere in the server source (prose comments do not count)', () => {
    const offenders: string[] = [];
    const files = globTs(SERVER_SRC);
    expect(files.length, 'server source scan found no files — the guard would pass blindly').
      toBeGreaterThan(0);

    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (code.includes(HARNESS_MODULE)) {
        offenders.push(`${file}: references ${HARNESS_MODULE} outside a comment`);
        continue;
      }
      // Catch a barrel-mediated import too: `import { gradeGate } from '@trading-app/backtest'`.
      for (const sym of GRADED_SYMBOLS) {
        if (new RegExp(`\\b${sym}\\b`).test(code)) {
          offenders.push(`${file}: references graded symbol ${sym}`);
        }
      }
    }

    expect(
      offenders,
      'The sentiment-IC grading path is now reachable from the server import graph, so the ' +
        'TRA-1715 deploy floor gates it. Fixes are no longer live-on-merge.',
    ).toEqual([]);
  });
});

/** Recursively collect .ts sources, skipping dist/node_modules. */
function globTs(root: string): string[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}
