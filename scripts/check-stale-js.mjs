#!/usr/bin/env node
// TRA-1660 — fail loudly when compiler output shadows a TypeScript source.
//
// THE HAZARD
// ----------
// `tsc <file>` ignores tsconfig.json entirely: given explicit file arguments the
// compiler never reads the config, so `outDir`/`noEmit` are silently dropped and
// it emits next to the input. One agent running `npx tsc src/foo.ts` for a quick
// syntax check leaves `src/foo.js` sitting beside `src/foo.ts`.
//
// That stale sibling then WINS resolution, two different ways:
//   - server: sources import with explicit ESM extensions (`./demo-flags.js`).
//     Vite normally maps that back to `./demo-flags.ts` — but only when no real
//     `.js` exists. When one does, the stale file is loaded.
//   - desktop: imports are extensionless, and Vite's default `resolve.extensions`
//     lists `.js` BEFORE `.ts`. Same outcome.
//
// Either way vitest exercises the compiled copy, not the source. If the stale
// copy is an OLDER PASSING build and the current `.ts` is broken, the suite goes
// GREEN against code that is not the code being shipped. That false green is
// silent and sails straight through a verification gate — which is why this is a
// test-integrity check and not a style nit.
//
// WHAT IS FLAGGED
// ---------------
// Only *shadow pairs*: an emitted artifact that has a TypeScript sibling of the
// same basename. A standalone `.js` with no `.ts` next to it is a legitimate hand
// written file and is left alone — so `vite.config.js`, `*.mjs` scripts and
// hand-written `.d.ts` such as `vite-env.d.ts` never trip this.
//
// Usage:
//   node scripts/check-stale-js.mjs          # report + exit 1 if any shadow pair
//   node scripts/check-stale-js.mjs --fix    # delete the emitted artifacts
import { readdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Scan the WHOLE repo, skipping only build output and vendored trees.
//
// This deliberately does NOT use an allowlist of source roots. An earlier cut
// listed `apps/desktop/src`, `packages/*/src` and `scripts`, and silently missed
// five shadow pairs in `packages/server/scripts/` — reporting a clean tree while
// the hazard was live. A check against silent staleness must fail CLOSED: scanning
// everything means a new package or script directory is covered the day it lands.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'coverage',
  '.turbo',
  '.git',
  '.pnpm-store',
  'gen', // apps/desktop/src-tauri/gen — Tauri codegen
]);

// An artifact is "emit" if stripping this suffix leaves a basename that has a
// TypeScript sibling. Order matters: `.d.ts.map` must be tested before `.d.ts`.
const EMIT_SUFFIXES = ['.d.ts.map', '.js.map', '.d.ts', '.jsx', '.js'];
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

/** Return the shadowed TS source for `file`, or null if it is not emit. */
function shadowedSource(file) {
  const suffix = EMIT_SUFFIXES.find((s) => file.endsWith(s));
  if (!suffix) return null;
  const base = file.slice(0, -suffix.length);
  return TS_EXTENSIONS.map((ext) => base + ext).find(existsSync) ?? null;
}

const found = [];
for (const file of walk(REPO_ROOT)) {
  const source = shadowedSource(file);
  if (source) found.push({ artifact: file, source });
}

if (found.length === 0) {
  console.log('[check-stale-js] OK — no compiler output is shadowing a TypeScript source.');
  process.exit(0);
}

const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, '/');

if (process.argv.includes('--fix')) {
  for (const { artifact } of found) rmSync(artifact);
  console.log(`[check-stale-js] removed ${found.length} emitted artifact(s).`);
  process.exit(0);
}

// `.js`/`.jsx` hijack MODULE resolution — these are the ones that cause a false
// green. The `.d.ts`/`.map` files lose to their `.ts` sibling in tsc's resolution
// order, so they are inert; they still fail the check because they are emit, and
// emit means someone ran `tsc <file>` and the shadowing `.js` may be one slip away.
const shadowing = found.filter((f) => /\.jsx?$/.test(f.artifact));
const detritus = found.filter((f) => !/\.jsx?$/.test(f.artifact));

console.error(`\n[check-stale-js] FAIL — ${found.length} emitted artifact(s) sit beside TypeScript sources.\n`);

if (shadowing.length > 0) {
  console.error(
    `${shadowing.length} of them SHADOW a source and win module resolution. Tests exercise the stale\n` +
      'compiled copy, not the source. If that copy is an older passing build, the suite goes GREEN\n' +
      'against code you are not shipping:\n',
  );
  for (const { artifact, source } of shadowing) {
    console.error(`  ${rel(artifact)}\n      shadows  ${rel(source)}`);
  }
}

if (detritus.length > 0) {
  const byDir = new Map();
  for (const { artifact } of detritus) {
    const dir = rel(artifact).split('/').slice(0, -1).join('/');
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  const dirs = [...byDir].sort((a, b) => b[1] - a[1]);
  console.error(
    `\n${detritus.length} more are .d.ts/.map emit — inert on their own, but proof the tree was\n` +
      'compiled in place. Top directories:\n',
  );
  for (const [dir, count] of dirs.slice(0, 10)) console.error(`  ${String(count).padStart(4)}  ${dir}`);
  if (dirs.length > 10) console.error(`  ... and ${dirs.length - 10} more directories`);
}

console.error(
  '\nFix:  node scripts/check-stale-js.mjs --fix\n\n' +
    'Cause: `tsc <file>` ignores tsconfig.json (outDir/noEmit are dropped) and emits in place.\n' +
    'Never type-check a single file that way — use `pnpm typecheck` or `pnpm build`.\n',
);
process.exit(1);
