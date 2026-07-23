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
//
// TRA-2091 — the three checks below are DIRECT-edge greps (barrel string, `exports` map, server
// scan). They are depth-1: each names one boundary and asserts the harness does not cross it.
// But reachability is transitive. A barrel-exported module — say `runner.ts`, which IS re-exported
// as `BacktestRunner` — importing the harness drags `gradeGate` into the server's load graph while
// all three direct-edge legs stay green (the barrel string never mentions the harness; the exports
// map is still `["."]`; the server imports `BacktestRunner`, not a graded symbol). The exemption
// lapses one hop below every direct check. The fourth leg walks the import graph from the barrel
// so the guard is depth-N, not depth-1. A companion synthetic test proves that leg catches a
// depth-2 edge the first three miss — the mutation test at depth 2 this board keeps asking for.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

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

  // TRA-2091 — depth-N. The three legs above are direct-edge greps; this one walks the graph.
  // Importing anything from `@trading-app/backtest` evaluates the barrel's whole re-export
  // closure (ESM evaluates the full module dependency graph, not just the binding you named), so
  // any module the barrel transitively pulls in is loaded into the server runtime. If the harness
  // is anywhere in that closure, the deploy floor gates the grading path — even when no direct
  // edge exists. Rooting at the barrel is deliberately conservative: a false RED (e.g. a re-export
  // a bundler could tree-shake) is cheap; a false GREEN defeats the guard.
  it('is not TRANSITIVELY reachable from the package barrel (walks the import graph, not just direct edges)', () => {
    const barrel = resolve(HERE, 'index.ts');
    const target = resolve(HERE, `${HARNESS_MODULE}.ts`);
    expect(
      existsSync(target),
      `${HARNESS_MODULE}.ts not found — the harness moved or was renamed; update this guard so it ` +
        'does not pass blindly against a target that no longer exists.',
    ).toBe(true);

    const path = findReachablePath(barrel, target, realImportEdges);
    expect(
      path === null,
      path
        ? `The harness is reachable from the barrel via: ${path.map((p) => basename(p)).join(' -> ')}. ` +
          'Importing anything from @trading-app/backtest now loads the sentiment-IC grading path into ' +
          'the server runtime graph, so the TRA-1715 deploy floor gates it. The scope exemption has ' +
          'LAPSED — re-grade it before trusting any verdict computed from an unshipped fix.'
        : 'unreachable',
    ).toBe(true);
  });

  // TRA-2091 — mutation test at DEPTH 2, baked in permanently. A synthetic graph where the barrel
  // reaches the harness only THROUGH an intermediate module. All three direct-edge legs would be
  // green against this shape (the barrel never names the harness; it re-exports the intermediate).
  // The walk must still find it — and, with the one separating edge removed, must report clean.
  // This is what proves the fourth leg is depth-2, not another depth-1 check wearing a graph coat.
  it('the transitive walk catches a depth-2 edge that the direct-edge legs cannot see', () => {
    const graph: Record<string, string[]> = {
      '/index.ts': ['/runner.ts', '/types.ts'], // barrel re-exports the intermediate, not the harness
      '/runner.ts': ['/engine.ts', '/sentiment-ic-harness.ts'], // the one separating edge
      '/types.ts': [],
      '/engine.ts': [],
      '/sentiment-ic-harness.ts': [],
    };
    const edgesOf = (f: string): string[] => graph[f] ?? [];

    expect(findReachablePath('/index.ts', '/sentiment-ic-harness.ts', edgesOf)).toEqual([
      '/index.ts',
      '/runner.ts',
      '/sentiment-ic-harness.ts',
    ]);

    // Control: same graph, separating edge removed. Same everything else — opposite verdict.
    const clean: Record<string, string[]> = { ...graph, '/runner.ts': ['/engine.ts'] };
    expect(
      findReachablePath('/index.ts', '/sentiment-ic-harness.ts', (f) => clean[f] ?? []),
    ).toBeNull();
  });
});

/**
 * Breadth-first walk of the transitive edge closure from `entry`. Returns the first path
 * (`[entry, …, target]`) by which `target` becomes reachable, or `null` if it never does.
 * `edgesOf` is injected so the walk is testable against a synthetic graph (see the depth-2
 * mutation test) independently of disk.
 */
function findReachablePath(
  entry: string,
  target: string,
  edgesOf: (file: string) => string[],
): string[] | null {
  const seen = new Set<string>();
  const queue: Array<{ file: string; path: string[] }> = [{ file: entry, path: [entry] }];
  while (queue.length > 0) {
    const { file, path } = queue.shift()!;
    if (file === target) return path;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of edgesOf(file)) {
      queue.push({ file: dep, path: [...path, dep] });
    }
  }
  return null;
}

/**
 * Real-disk edges: the resolved absolute `.ts` paths a module pulls in via a RELATIVE specifier.
 * Covers static `import`/`export … from`, side-effect `import '…'`, dynamic `import('…')`, and
 * `require('…')`. Bare specifiers (`@trading-app/engine`) leave the package and are not followed —
 * the harness lives in this package's src, so intra-package edges are the ones that can reach it.
 * Comments are stripped first (a commented-out import must not count). Type-only imports are NOT
 * filtered out: erased at runtime they cannot ship code, but counting them keeps the guard on the
 * conservative side, matching this file's "false RED is cheap" bias.
 */
function realImportEdges(file: string): string[] {
  let src: string;
  try {
    src = stripComments(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const resolved = resolveTsSpecifier(file, m[1]);
    if (resolved !== null) out.push(resolved);
  }
  return out;
}

/** Resolve a relative ESM specifier (`./runner.js`, `./foo`, `./dir`) to an on-disk `.ts` file. */
function resolveTsSpecifier(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.jsx?$/, '.ts'),
    base.replace(/\.jsx?$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
    base,
  ];
  for (const candidate of candidates) {
    if (candidate.endsWith('.ts') || candidate.endsWith('.tsx')) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Recursively collect .ts sources, skipping dist/node_modules. */
function globTs(root: string): string[] {
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
