// TRA-3443 — guard the exit-region taxonomy and its refuse-to-publish gate.
//
// The taxonomy that STEP 2 of routine `368ce26f` reports against used to be twenty
// phase names typed into a routine description on 2026-07-30. By 2026-08-12 it had
// gone wrong three ways at once (wrong denominator, two missing in-region phases,
// four over-broad RESIDUAL entries). `scripts/tra3443-exit-region-taxonomy.mjs`
// replaces it with a derivation from `signal-engine.ts`, so it cannot go stale the
// same way again — but a DERIVATION has its own failure mode: if the parse breaks,
// it returns empty sets and everything downstream passes trivially.
//
// So this file asserts two different things, and the second is the one that is
// usually skipped:
//
//   * the derivation still finds the region and puts the load-bearing phases in the
//     right class (it is not vacuous, and it did not drift);
//   * the refuse-to-publish gate fires on the known-bad AND STAYS SILENT ON THE
//     KNOWN-GOOD. A control that can only ever say "refuse" is a rubber stamp with
//     an alarm attached — it looks like judgement and is not (TRA-1787). The
//     known-bad here is the REAL 2026-08-12 census, so the positive control
//     contains exactly what the instrument detects (TRA-1727).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'tra3443-exit-region-taxonomy.mjs');
const CENSUS_0812 = join(REPO, 'scripts', 'fixtures', 'tra3443-census-2026-08-12.json');

/** Run the script; return {status, stdout}. Never throws on a non-zero exit — the
 *  exit code IS the verdict here (3 = REFUSED is a result, not a crash). */
function run(args: string[]): { status: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function taxonomy(): {
  residual: string[]; prefix: string[]; post: string[];
  contested: Array<{ phase: string }>;
} {
  const { status, out } = run(['--json']);
  expect(status, out).toBe(0);
  return JSON.parse(out).taxonomy;
}

describe('TRA-3443: tickExitRegionActive taxonomy is derived, not typed', () => {
  it('derives a non-vacuous three-way split (the parse did not silently fail)', () => {
    const t = taxonomy();
    // A broken parse yields empty sets and every assertion below would pass on
    // nothing. These floors are the positive control for the parse itself.
    expect(t.residual.length).toBeGreaterThanOrEqual(7);
    expect(t.prefix.length).toBeGreaterThanOrEqual(15);
    expect(t.post.length).toBeGreaterThanOrEqual(19);
    // The three classes must be disjoint — a phase in two classes double-counts.
    const all = [...t.residual, ...t.prefix, ...t.post];
    expect(new Set(all).size).toBe(all.length);
  });

  it('puts the interlock\'s own named calls in RESIDUAL', () => {
    const t = taxonomy();
    // These are the calls signal-engine.ts:1252-1257 says the region serialises.
    // `submit-option-exits` can place a real broker sell_to_close; if it ever falls
    // out of RESIDUAL the narrowing question has changed shape and a human must look.
    expect(t.residual).toContain('signal.doTick.submit-option-exits');
    expect(t.residual).toContain('signal.doTick.resolve-option-exits');
    // TRA-3443 — in NEITHER of the 2026-07-30 lists despite being the equity
    // `checkExits` the interlock exists to serialise. This assertion is the
    // regression test for that specific miss.
    expect(t.residual).toContain('signal.doTick.equity-checkExits');
  });

  it('keeps the tick\'s three largest sinks OUT of the region entirely', () => {
    const t = taxonomy();
    // otm-scan + cold-bar-scan + short-premium-scan were 73.99% of doTick on
    // 2026-08-12 and were read as "UNCLASSIFIED — the taxonomy covers 13% of the
    // tick". They are POST-REGION by construction: narrowing the interlock says
    // nothing about them, and putting them in a denominator with PREFIX/RESIDUAL is
    // the defect. If one ever moves inside the region, that is a real change to
    // what the interlock costs and it must not land silently.
    expect(t.post).toContain('signal.doTick.otm-scan');
    expect(t.post).toContain('signal.doTick.cold-bar-scan');
    expect(t.post).toContain('signal.doTick.short-premium-scan');
    expect(t.prefix).toContain('signal.doTick.quote-batch'); // in-region, and the largest measured one
  });

  it('flags the contested exclusions instead of silently resolving them', () => {
    const t = taxonomy();
    // refreshExitsOnly does not re-run these, so they derive as PREFIX; but the
    // interlock docstring names the pending-close reconciler as a serialisation
    // target. That conflict is TRA-2268's to rule on. The instrument must SURFACE
    // it — a taxonomy that quietly picked a side would be supplying the answer to
    // the question it was built to measure.
    const contested = t.contested.map(c => c.phase);
    expect(contested).toContain('signal.doTick.reconcile-pending-closes');
    for (const p of contested) expect(t.prefix).toContain(p);
  });
});

describe('TRA-3443: the refuse-to-publish gate discriminates in BOTH directions', () => {
  it('REFUSES the real 2026-08-12 census (known-bad contains what it detects)', () => {
    const { status, out } = run([`--census=${CENSUS_0812}`]);
    expect(status).toBe(3);
    expect(out).toContain('REFUSED');
    expect(out).toContain('censoring interval');
    // ABSENT must never render as 0 — that equivalence is the whole defect.
    expect(out).toContain('<<ABSENT>>');
    expect(out).not.toMatch(/submit-option-exits\s+n=0\s+0\.0s/);
  });

  it('PUBLISHES a census with no censoring headroom (the gate is not a rubber stamp)', () => {
    // Same taxonomy, same script, same gate — only the censoring changes. If this
    // test cannot go green, the gate never says "publish" and its REFUSE carries no
    // information.
    const t = taxonomy();
    const phases: Record<string, { n: number; sumS: number; maxS: number }> = {};
    // Every phase observed on nearly every tick => (nParent - nObs) is tiny => the
    // upper bound collapses onto the lower one.
    for (const p of [...t.residual, ...t.prefix, ...t.post]) {
      phases[p] = { n: 10_000, sumS: 20_000, maxS: 9 };
    }
    const dir = mkdtempSync(join(tmpdir(), 'tra3443-'));
    const file = join(dir, 'clean-census.json');
    writeFileSync(file, JSON.stringify({
      source: 'synthetic positive control',
      parent: { n: 10_000, sumS: 900_000 },
      phases,
    }));

    const { status, out } = run([`--census=${file}`]);
    expect(status, out).toBe(0);
    expect(out).toContain('PUBLISHED');
    expect(out).not.toContain('REFUSED');
  });

  it('REFUSES a census naming a phase this build does not emit', () => {
    // The tape and the build under measurement disagreeing is not a small thing: it
    // means the shares describe a different program than the one being narrowed.
    const dir = mkdtempSync(join(tmpdir(), 'tra3443-'));
    const file = join(dir, 'wrong-build.json');
    writeFileSync(file, JSON.stringify({
      source: 'synthetic wrong-build control',
      parent: { n: 10_000, sumS: 900_000 },
      phases: { 'signal.doTick.a-phase-that-was-deleted': { n: 5_000, sumS: 100, maxS: 1 } },
    }));

    const { status, out } = run([`--census=${file}`]);
    expect(status).toBe(3);
    expect(out).toContain('does not emit');
  });
});

describe('TRA-3443: the 2026-08-12 census fixture is complete', () => {
  it('reconciles to its own declared record count', async () => {
    // parent n + every phase n must equal the boot-excluded record count the tape
    // reported. If it does not, a phase was dropped in transcription and every
    // conclusion drawn from this fixture is about a different population. This is
    // the check that lets "absent from the fixture" mean "absent from the TAPE".
    const census = (await import(`${CENSUS_0812.replace(/\\/g, '/')}`, { with: { type: 'json' } })).default as {
      parent: { n: number };
      window: { records: number };
      phases: Record<string, { n: number }>;
    };
    const total = census.parent.n + Object.values(census.phases).reduce((a, p) => a + p.n, 0);
    expect(total).toBe(census.window.records);
  });
});
