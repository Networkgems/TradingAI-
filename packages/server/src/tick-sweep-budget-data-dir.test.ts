// TRA-2603 — `tick-sweep-budget.ts` must resolve DATA_DIR through `resolveDataDir()`.
//
// WHY THIS TEST LOOKS THE WAY IT DOES
// -----------------------------------
// A blank-but-present `DATA_DIR` is a state bqb1 has actually reached, twice
// (TRA-2136 / TRA-2193 / TRA-2195). The unguarded literal
//
//     process.env.DATA_DIR ?? join(__dirname, '..', 'data')
//
// takes the env branch for `' '`, because `' '` is truthy — `??` only guards
// null/undefined. `resolveDataDir()` additionally requires `.trim()`, so it falls
// through to the module-anchored root (TRA-522, TRA-1681).
//
// THE DISCRIMINATOR. Against the pre-fix file the cursor mirror lands in a
// directory literally named `" "` relative to `process.cwd()`, and
// `flushCursors` swallows its own write errors by design (it degrades to
// in-memory rather than failing the tick). So **nothing throws**: a test that
// asserts "no throw", or that uses a normal DATA_DIR value, passes against the
// bug. The assertion that has to be present is the pair —
//
//     ABSENT at the whitespace root  AND  PRESENT at the guarded root
//
// ...because either half alone is satisfiable by the broken code (the guarded
// root is a real directory that may already hold a file from a previous run,
// which is why the probe writes a SENTINEL and the file is removed first).
//
// `CURSOR_PATH` is not exported, so this asserts behaviourally rather than by
// reading a constant. `DATA_DIR` is a module-load-time `const`, so the env must
// be set BEFORE a dynamic `import()` — the same constraint `trade-store.test.ts`
// works around.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataDir } from './data-dir.js';

/** A present-but-blank env value: truthy, so `??` does not guard it. */
const BLANK_DATA_DIR = ' ';

// Must precede the dynamic import below — see the header.
process.env.DATA_DIR = BLANK_DATA_DIR;

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Where a GUARDED resolve puts the mirror. Computed from the real
 * `resolveDataDir` rather than re-derived by hand, so this test cannot drift
 * away from the predicate it is asserting (the TRA-1681 two-copies lesson).
 */
const GUARDED_ROOT = resolveDataDir({ DATA_DIR: BLANK_DATA_DIR } as NodeJS.ProcessEnv, SRC_DIR);
const GUARDED_CURSOR = join(GUARDED_ROOT, 'scan-cursors.json');

type TickSweepModule = typeof import('./tick-sweep-budget.js');
let mod: TickSweepModule;

/** cwd is controlled so the stray `" "` directory is created somewhere we own. */
let cwdSandbox: string;
let originalCwd: string;
let strayRoot: string;
let strayCursor: string;

/** The guarded root is a REAL repo directory; preserve whatever was already there. */
let savedGuarded: string | null = null;

beforeAll(async () => {
  originalCwd = process.cwd();
  cwdSandbox = mkdtempSync(join(tmpdir(), 'tra2603-cwd-'));
  process.chdir(cwdSandbox);

  // Resolve AFTER chdir: the pre-fix code joins a relative `' '`, so the stray
  // path is anchored to the cwd in force at write time.
  strayRoot = resolve(cwdSandbox, BLANK_DATA_DIR);
  strayCursor = join(strayRoot, 'scan-cursors.json');

  savedGuarded = existsSync(GUARDED_CURSOR) ? readFileSync(GUARDED_CURSOR, 'utf8') : null;

  mod = await import('./tick-sweep-budget.js');
});

afterAll(() => {
  process.chdir(originalCwd);
  // Restore the repo's real cursor file to exactly its prior state.
  if (savedGuarded === null) rmSync(GUARDED_CURSOR, { force: true });
  else writeFileSync(GUARDED_CURSOR, savedGuarded, 'utf8');
  rmSync(cwdSandbox, { recursive: true, force: true });
});

describe('TRA-2603 tick-sweep-budget resolves DATA_DIR through resolveDataDir()', () => {
  it('mirrors scan-cursors.json to the GUARDED root, not a directory named " "', () => {
    const { sweepCursors, resetSweepCursors, flushSweepCursors } = mod;

    // Sanity: the two roots must actually differ, or this test proves nothing.
    expect(strayRoot).not.toBe(GUARDED_ROOT);

    resetSweepCursors();

    // Warm the flush throttle so the SECOND set defers and `flushSweepCursors()`
    // is genuinely the call that writes (an unthrottled `set` writes inline).
    sweepCursors.set('tra2603-warm', 'WARM');

    // Clean slate at BOTH roots, so "present" below means "written by this flush".
    rmSync(strayRoot, { recursive: true, force: true });
    rmSync(GUARDED_CURSOR, { force: true });

    sweepCursors.set('tra2603-probe', 'SENTINEL-2603');
    flushSweepCursors();

    // Half 1 — nothing was written to the whitespace root.
    expect(
      existsSync(strayCursor),
      `cursor mirror leaked to a directory named " " at ${strayCursor}; ` +
        'DATA_DIR=" " took the `??` env branch instead of the trim() guard',
    ).toBe(false);

    // Half 2 — it was written to the guarded, module-anchored root.
    expect(
      existsSync(GUARDED_CURSOR),
      `no cursor mirror at the guarded root ${GUARDED_CURSOR}`,
    ).toBe(true);

    const written = JSON.parse(readFileSync(GUARDED_CURSOR, 'utf8')) as Record<string, string>;
    expect(written['tra2603-probe']).toBe('SENTINEL-2603');
  });

  it('negative control: the pre-fix path IS reachable and IS silent', () => {
    // Proves the two claims the discriminator rests on, independent of the fix:
    // (1) `' '` is truthy so `??` does not guard it, and (2) writing under a
    // directory named `" "` succeeds — there is no error for a test to catch.
    expect(BLANK_DATA_DIR ?? 'fallback').toBe(BLANK_DATA_DIR);
    expect(resolveDataDir({ DATA_DIR: BLANK_DATA_DIR } as NodeJS.ProcessEnv, SRC_DIR)).toBe(
      join(SRC_DIR, '..', 'data'),
    );

    const probe = join(strayRoot, 'reachable.json');
    mkdirSync(strayRoot, { recursive: true });
    expect(() => writeFileSync(probe, '{}', 'utf8')).not.toThrow();
    expect(existsSync(probe)).toBe(true);
    rmSync(strayRoot, { recursive: true, force: true });
  });
});
