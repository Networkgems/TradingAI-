// TRA-3434 — a STATIC guard that the TRA-3391 tape-expectancy fold is warmed at
// BOOT, not at the first live candidate.
//
// This is a test rather than a comment because the defect it catches is invisible
// at every level a behavioural test can reach:
//
//   • `initTapeExpectancyCache()` shipped with a docstring saying "warm the fold at
//     boot" and ZERO callers. Nothing failed. Nothing logged. The symbol appeared
//     in exactly two places repo-wide, both inside its own file.
//   • The gate reads the table through `peekTapeExpectancyTable()`, the SYNC
//     accessor, which returns `null` until the first fold lands and merely
//     SCHEDULES a refold. `tapeExpectancyVerdict()` fail-closes on `null`, which is
//     correct — but it declines under `insufficient_evidence` with `n=0`, the SAME
//     reason code a genuinely unmeasured cell produces. A blind post-boot decline
//     is therefore byte-identical in `byReason` to a measured verdict.
//   • Measured on the 2026-08-12T22:23:58Z boot: 3.5 minutes at
//     `freshness.generation: 0` with `otmCells: []`, ending only because a health
//     route happened to hit the AWAITING `get()`. Hitting that route is also what
//     makes a BROKEN build read exactly like a fixed one, so even a manual live
//     check can confirm the wrong thing unless it reads the gates route first.
//
// The behavioural proof that the fold and the fail-closed decline work lives in
// `option-cost-gate.test.ts` / `otm-sleeve-mandate.test.ts`. This file guards the
// one thing those cannot see: that the boot path still calls the warm.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

/** The boot module. If the warm is not named here, it does not happen. */
const BOOT = 'index.ts';

/** The exported warm. */
const WARM = 'initTapeExpectancyCache';

/** The module that owns the cache + the warm. */
const CACHE_MODULE = 'option-tape-expectancy-cache.ts';

function read(file: string): string {
  return readFileSync(join(SRC, file), 'utf8');
}

/** Strip line + block comments so a mention inside prose cannot satisfy a check. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('TRA-3434 — the tape-expectancy fold is warmed at boot', () => {
  it(`${BOOT} CALLS ${WARM}() in executable code, not just in a comment`, () => {
    const src = code(read(BOOT));
    // The invocation, not merely the import — the defect was an exported function
    // with a docstring and no call, so "the name appears" is exactly the state
    // that shipped.
    expect(src).toMatch(new RegExp(`${WARM}\\s*\\(`));
  });

  it(`${BOOT} imports ${WARM} from its owning module`, () => {
    const src = code(read(BOOT));
    expect(src).toContain(WARM);
    expect(src).toContain(CACHE_MODULE.replace(/\.ts$/, '.js'));
  });

  it('does not AWAIT the warm at module scope — boot must not block on journal IO', () => {
    // Fire-and-forget is deliberate and matches the neighbouring boot warms.
    // Awaiting would trade a bounded blind window for a boot that stalls on a fold
    // whose cost grows with the journal — strictly worse, and the gate already
    // fails closed while it is cold.
    const src = code(read(BOOT));
    const call = new RegExp(`await\\s+${WARM}\\s*\\(`);
    expect(src).not.toMatch(call);
  });

  it('the warm survives a fold failure instead of taking the boot down', () => {
    // A rejected promise with no handler is an unhandled rejection; on a boot path
    // that is a crash loop, and the failure mode this guards is a COLD CACHE, which
    // the gate already handles by declining.
    const src = code(read(BOOT));
    const warmSite = src.slice(src.indexOf(`${WARM}(`));
    expect(warmSite.slice(0, 400)).toMatch(/\.catch\s*\(/);
  });

  it(`${WARM} is still exported by ${CACHE_MODULE} (the guard cannot silently pass)`, () => {
    // If the symbol is renamed or dropped, the checks above would keep passing off
    // a stale mention in index.ts. Pin the other end too.
    expect(code(read(CACHE_MODULE))).toMatch(new RegExp(`export\\s+async\\s+function\\s+${WARM}`));
  });
});
