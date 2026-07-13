#!/usr/bin/env node
// TRA-1684 — fail the build when the TypeScript import graph contains a cycle.
//
// THE HAZARD
// ----------
// A circular import is not automatically fatal. Whether it throws depends on which
// module you enter the graph through. TRA-1674:
//
//   crypto-account -> observability/index (barrel) -> health-routes
//                  -> crypto-regime-tsmom-demo-route -> crypto-account   <-- closes
//
// with a `new CryptoPaperAccount()` at MODULE SCOPE inside the loop. Production
// entered at `health-routes`, so `crypto-account` finished evaluating before the
// `new` ran, and prod was fine for months. The test entered at `crypto-account`,
// which re-entered it mid-evaluation with the class binding still in TDZ, and threw
// `CryptoPaperAccount is not a constructor` — three suites dead at collection.
//
// Same graph, same code, different door. So: a green suite is NOT evidence the graph
// is sound. That cycle was one import statement away from being a boot crash on prod
// and nothing in CI would have said a word. This script is that word.
//
// WHAT IS AN EDGE
// ---------------
// Only edges that exist at RUNTIME, because only those can deadlock evaluation:
//
//   counted      `import { x } from './a.js'`     value import, evaluated eagerly
//                `export { x } from './a.js'`     re-export, same thing (this is the
//                                                 exact shape that caused TRA-1674)
//   NOT counted  `import type { T } from './a.js'`   erased by tsc, no runtime import
//                `import { type T } from './a.js'`   erased when ALL specifiers are types
//                `await import('./a.js')`            deferred; the standard cycle break
//                'express', '@trading-app/shared'    non-relative; not our graph
//
// FAIL CLOSED
// -----------
// Three ways this exits non-zero, and none of them is "cycle found" alone:
//
//   1. a cycle that is not in ALLOWED_CYCLES;
//   2. an ALLOWED_CYCLES entry that no longer matches a real cycle — a stale allowlist
//      is a guard that lies, and lying green is the failure mode this whole family of
//      bugs shares (TRA-1660 stale emit, TRA-1675 presence != validity, TRA-1679 the
//      guard's own remedy pinned it green). If you fix a cycle, delete its entry;
//   3. a relative import that resolves to nothing — an edge we cannot see is an edge
//      we cannot check, and a blind spot must be loud, not silent.
//
// There is exactly one `process.exit(0)` below and it is on the fully-clean path.
//
// Usage:
//   node scripts/check-cycles.mjs           # report + exit 1 on any cycle
//   node scripts/check-cycles.mjs --list    # print the graph size and exit (debug)
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Known cycles we are knowingly carrying, keyed by the sorted member list.
// Each entry MUST carry a ticket. Empty is the goal state — and an empty allowlist
// that is honest beats a padded one that hides a boot crash.
const ALLOWED_CYCLES = new Map([
  // e.g. ['packages/server/src/a.ts|packages/server/src/b.ts', 'TRA-XXXX — reason'],
]);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'coverage',
  '.turbo',
  '.git',
  '.pnpm-store',
  'gen',
]);

const TS_RE = /\.(ts|tsx|mts|cts)$/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && TS_RE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

// Static `import ... from '<spec>'` / `export ... from '<spec>'`. Deliberately does not
// match `import('<spec>')` — a dynamic import is deferred and cannot deadlock evaluation.
const IMPORT_RE = /(?:^|\n)\s*(import|export)\b([^;'"]*?)\bfrom\s*['"]([^'"]+)['"]/g;

/** True when the statement is erased by the compiler and so has no runtime edge. */
function isTypeOnly(clause) {
  if (/^\s*type\b/.test(clause)) return true; // `import type { T } from`
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (!braces) return false; // default/namespace import — a real binding
  const names = braces[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // `import { type A, type B } from` — every specifier erased, nothing left to evaluate.
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/** Resolve a relative specifier to a TS file on disk, mirroring how tsc/vite see it. */
function resolveSpec(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.jsx$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    base,
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && TS_RE.test(c) && !c.endsWith('.d.ts')) return c;
  }
  return null;
}

const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, '/');

// ---- build the graph --------------------------------------------------------
const graph = new Map(); // file -> Set<file>
const unresolved = [];

for (const file of walk(REPO_ROOT)) {
  const src = readFileSync(file, 'utf8');
  const deps = new Set();
  for (const [, kind, clause, spec] of src.matchAll(IMPORT_RE)) {
    if (!spec.startsWith('.')) continue; // package / alias — not our graph
    if (isTypeOnly(clause)) continue; // erased; no runtime edge
    // Imports into build output (root `scripts/*.ts` reaching for `packages/*/dist/`)
    // cross an artifact boundary: `dist` is emitted, never re-enters the source graph,
    // and so cannot be a member of a source cycle. Skipped as out-of-graph, not as a
    // blind spot — that distinction is the difference between honest and convenient.
    if (spec.includes('/dist/')) continue;
    const target = resolveSpec(file, spec);
    if (!target) {
      // A relative import we cannot see is an edge we cannot check. Non-TS assets
      // (.json/.css/.svg) are leaves and can never be part of a cycle, so they are
      // not a blind spot — anything else is.
      if (!/\.(json|css|scss|svg|png|jpg|txt|html|wasm)$/.test(spec)) {
        unresolved.push({ file, spec, kind });
      }
      continue;
    }
    if (target !== file) deps.add(target);
  }
  graph.set(file, deps);
}

if (process.argv.includes('--list')) {
  const edges = [...graph.values()].reduce((n, s) => n + s.size, 0);
  console.log(`[check-cycles] ${graph.size} modules, ${edges} runtime edges.`);
  process.exit(1); // debug mode is not a pass
}

// ---- Tarjan: every strongly-connected component of size > 1 is a cycle ------
const index = new Map();
const low = new Map();
const onStack = new Set();
const stack = [];
const components = [];
let counter = 0;

function strongconnect(v) {
  // Iterative — the server graph is deep enough to blow the call stack recursively.
  const work = [[v, 0]];
  while (work.length > 0) {
    const frame = work[work.length - 1];
    const [node, i] = frame;
    if (i === 0) {
      index.set(node, counter);
      low.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
    }
    const deps = [...(graph.get(node) ?? [])];
    if (i < deps.length) {
      frame[1] += 1;
      const w = deps[i];
      if (!index.has(w)) {
        work.push([w, 0]);
      } else if (onStack.has(w)) {
        low.set(node, Math.min(low.get(node), index.get(w)));
      }
      continue;
    }
    if (low.get(node) === index.get(node)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== node);
      if (comp.length > 1) components.push(comp);
    }
    work.pop();
    if (work.length > 0) {
      const parent = work[work.length - 1][0];
      low.set(parent, Math.min(low.get(parent), low.get(node)));
    }
  }
}

for (const v of graph.keys()) if (!index.has(v)) strongconnect(v);

/** Walk an SCC to produce one concrete a -> b -> ... -> a path, for the message. */
function samplePath(comp) {
  const members = new Set(comp);
  const start = [...comp].sort()[0];
  const prev = new Map();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const node = queue.shift();
    for (const next of graph.get(node) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) {
        const path = [node];
        let cur = node;
        while (prev.has(cur)) {
          cur = prev.get(cur);
          path.push(cur);
        }
        return [...path.reverse(), start];
      }
      if (!seen.has(next)) {
        seen.add(next);
        prev.set(next, node);
        queue.push(next);
      }
    }
  }
  return [...comp, start];
}

const cycles = components.map((comp) => {
  const members = comp.map(rel).sort();
  return { key: members.join('|'), members, path: samplePath(comp).map(rel) };
});

const unexpected = cycles.filter((c) => !ALLOWED_CYCLES.has(c.key));
const staleAllowlist = [...ALLOWED_CYCLES.keys()].filter((k) => !cycles.some((c) => c.key === k));

if (unexpected.length === 0 && staleAllowlist.length === 0 && unresolved.length === 0) {
  const suffix = ALLOWED_CYCLES.size > 0 ? ` (${ALLOWED_CYCLES.size} allowlisted)` : '';
  console.log(`[check-cycles] OK — no import cycles across ${graph.size} modules${suffix}.`);
  process.exit(0);
}

if (unexpected.length > 0) {
  console.error(`\n[check-cycles] FAIL — ${unexpected.length} import cycle(s).\n`);
  for (const c of unexpected) {
    console.error(`  cycle (${c.members.length} modules):`);
    console.error(`      ${c.path.join('\n   -> ')}`);
    console.error('');
  }
  console.error(
    'A cycle is only fatal from SOME entry points — whichever module gets re-entered\n' +
      'mid-evaluation sees the other\'s bindings still in TDZ. Anything at module scope in\n' +
      'the loop (a `new`, a call, a spread) then throws. Prod and the tests enter through\n' +
      'different doors, so a green suite does not clear this.\n\n' +
      'Fix by cutting an edge, not by moving the crash:\n' +
      '  - import the LEAF module, not a barrel that re-exports half the tree;\n' +
      '  - do not re-export a route/service module out of a utility barrel;\n' +
      '  - make module-scope construction lazy only as a second resort — it defuses the\n' +
      '    blast, it does not remove the cycle.\n',
  );
}

if (staleAllowlist.length > 0) {
  console.error(
    `\n[check-cycles] FAIL — ${staleAllowlist.length} ALLOWED_CYCLES entr(ies) match no real cycle:\n`,
  );
  for (const k of staleAllowlist) console.error(`  ${k}\n      (${ALLOWED_CYCLES.get(k)})`);
  console.error(
    '\nThe cycle is gone or its members moved. Delete the entry — an allowlist that no\n' +
      'longer describes the tree is a guard reporting OK on a condition it never tested.\n',
  );
}

if (unresolved.length > 0) {
  console.error(`\n[check-cycles] FAIL — ${unresolved.length} relative import(s) resolve to nothing:\n`);
  for (const u of unresolved.slice(0, 20)) console.error(`  ${rel(u.file)}\n      ${u.kind} '${u.spec}'`);
  if (unresolved.length > 20) console.error(`  ... and ${unresolved.length - 20} more`);
  console.error('\nAn edge this script cannot see is an edge it cannot check. Blind spots fail loud.\n');
}

process.exit(1);
