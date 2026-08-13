// TRA-3496 — guard the UNCENSORED reader in `scripts/tra3443-exit-region-taxonomy.mjs`.
//
// TRA-3444 shipped `books.<book>.tickExitRegionMs.exitWorkMs` and it went live on
// bqb1, but NOTHING READ IT. The instrument STEP 2 of routine `368ce26f` runs is a
// census-tape grader whose refusal is driven by `censorRatio = regionHi/regionLo`
// (15.6x on the 2026-08-12 tape) — a computation the new field does not touch. So
// the 13:00 ET read would have published "REFUSED — censoring interval 15.6x wide"
// with the exact answer one HTTP GET away. A live field nobody reads produces no
// answer.
//
// Every refusal asserted below shares one shape of danger: the failure produces a
// PLAUSIBLE SMALL PREFIX rather than an obvious error, and a small prefix is
// precisely the reading that makes narrowing a money-book interlock look cheap.
// So each is asserted as a REFUSAL (exit 3), never a warning.
//
// And each is paired with the known-good that must still PUBLISH. A control that
// can only ever say "refuse" is a rubber stamp with an alarm attached — it looks
// like judgement and is not (TRA-1787). Both directions, every time.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'tra3443-exit-region-taxonomy.mjs');
const CENSUS_0812 = join(REPO, 'scripts', 'fixtures', 'tra3443-census-2026-08-12.json');

/** Run the script. The exit code IS the verdict here (3 = REFUSED is a result). */
function run(args: string[]): { status: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

interface BookCounters {
  samples: number;
  sumMs: number;
  work: { samples: number; sumMs: number } | null;
}

/** A `/api/health/exit-cadence` payload, in the shape the route actually serves. */
function routeRead(o: {
  at: string;
  pid: number;
  startedAt: string;
  commit?: string;
  live: BookCounters;
  demo: BookCounters;
}): unknown {
  const region = (b: BookCounters) => ({
    samples: b.samples,
    sumMs: b.sumMs,
    maxMs: 999,
    atOrAbove20s: 0,
    atOrAbove30s: 0,
    ...(b.work ? { exitWorkMs: { samples: b.work.samples, sumMs: b.work.sumMs, maxMs: 99 } } : {}),
  });
  const fleet: BookCounters = {
    samples: o.live.samples + o.demo.samples,
    sumMs: o.live.sumMs + o.demo.sumMs,
    work: o.live.work && o.demo.work
      ? { samples: o.live.work.samples + o.demo.work.samples, sumMs: o.live.work.sumMs + o.demo.work.sumMs }
      : null,
  };
  return {
    ok: true,
    time: o.at,
    marketOpen: true,
    partitionedBy: 'mode',
    build: {
      commit: o.commit ?? 'e44a6d406a6be7e437c6177d8ebd3246b24a16e9',
      pid: o.pid,
      startedAt: o.startedAt,
    },
    books: {
      live: {
        book: 'live',
        enabled: false,
        armedEngineCount: 0,
        notGradeableReason: 'the hoist is disarmed on this book',
        tickExitRegionMs: region(o.live),
      },
      demo: {
        book: 'demo',
        enabled: true,
        armedEngineCount: 63,
        notGradeableReason: null,
        tickExitRegionMs: region(o.demo),
      },
    },
    tickExitRegionMs: region(fleet),
  };
}

const DIR = mkdtempSync(join(tmpdir(), 'tra3496-'));
let seq = 0;
function fixture(payload: unknown): string {
  const p = join(DIR, `read-${seq++}.json`);
  writeFileSync(p, JSON.stringify(payload));
  return p;
}

// Both marks inside RTH (13:30Z-20:00Z) so the window guard is never what fires.
const T0_AT = '2026-08-12T14:00:00.000Z';
const T1_AT = '2026-08-12T19:00:00.000Z';
const BOOT = '2026-08-12T13:45:00.000Z';

/** A healthy pair: 1:1 samples, contained exit work, exactly 50% PREFIX per book. */
function healthyPair(): { t0: string; t1: string } {
  return {
    t0: fixture(routeRead({
      at: T0_AT, pid: 74, startedAt: BOOT,
      live: { samples: 100, sumMs: 100_000, work: { samples: 100, sumMs: 40_000 } },
      demo: { samples: 200, sumMs: 200_000, work: { samples: 200, sumMs: 80_000 } },
    })),
    t1: fixture(routeRead({
      at: T1_AT, pid: 74, startedAt: BOOT,
      live: { samples: 200, sumMs: 300_000, work: { samples: 200, sumMs: 140_000 } },
      demo: { samples: 400, sumMs: 600_000, work: { samples: 400, sumMs: 280_000 } },
    })),
  };
}

/** T1 differing from `healthyPair()`'s T1 only in the live book's counters. */
function pairWithLive(live: BookCounters, pid = 74, startedAt = BOOT): { t0: string; t1: string } {
  const { t0 } = healthyPair();
  return {
    t0,
    t1: fixture(routeRead({
      at: T1_AT, pid, startedAt, live,
      demo: { samples: 400, sumMs: 600_000, work: { samples: 400, sumMs: 280_000 } },
    })),
  };
}

describe('TRA-3496: the uncensored reader publishes where the tape structurally cannot', () => {
  it('publishes a per-book split from a healthy pair, naming its source uncensored', () => {
    const { t0, t1 } = healthyPair();
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(0);
    expect(out).toContain('UNCENSORED');
    // live: region delta 200_000ms, work delta 100_000ms -> PREFIX exactly 50%.
    expect(out).toMatch(/books\.live\s+PREFIX = 50\.00%/);
    // demo: region delta 400_000ms, work delta 200_000ms -> 50%.
    expect(out).toMatch(/books\.demo\s+PREFIX = 50\.00%/);
  });

  it('rescues the REAL 2026-08-12 census: the tape still refuses, the run still publishes', () => {
    // The exact scenario TRA-3496 was filed for. Before this reader existed, this
    // combination exited 3 with "censoring interval is 15.6x wide" and published
    // nothing — while the answer sat unread on the route.
    const { t0, t1 } = healthyPair();
    const { status, out } = run([`--census=${CENSUS_0812}`, `--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(0);
    // The tape's own refusal is PRESERVED, not silenced — it is correct for the tape.
    expect(out).toContain('THE CENSORED TAPE REFUSES');
    expect(out).toContain('VERDICT: PUBLISHED');
    expect(out).toContain('SOURCE: UNCENSORED');
  });

  it('accepts a lone T1 whose process booted inside RTH (the single-fire case)', () => {
    // The counters are cumulative since boot, so a process that booted AFTER the
    // open needs no T0 — the implicit zero vector at `build.startedAt` is exact.
    // This is what lets a single-fire routine step publish at all.
    const t1 = fixture(routeRead({
      at: T1_AT, pid: 74, startedAt: BOOT,
      live: { samples: 200, sumMs: 300_000, work: { samples: 200, sumMs: 150_000 } },
      demo: { samples: 400, sumMs: 600_000, work: { samples: 400, sumMs: 300_000 } },
    }));
    const { status, out } = run([`--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(0);
    expect(out).toContain('implicit zero vector at process boot');
    expect(out).toMatch(/books\.live\s+PREFIX = 50\.00%/);
  });

  it('REFUSES a lone T1 whose process booted BEFORE the open (pre-open contamination)', () => {
    // The contamination TRA-3438 retimed the read to avoid: "since boot" at a
    // 13:00 ET read includes pre-open minutes unless the process booted after 13:30Z.
    const t1 = fixture(routeRead({
      at: T1_AT, pid: 74, startedAt: '2026-08-12T11:00:00.000Z',
      live: { samples: 200, sumMs: 300_000, work: { samples: 200, sumMs: 150_000 } },
      demo: { samples: 400, sumMs: 600_000, work: { samples: 400, sumMs: 300_000 } },
    }));
    const { status, out } = run([`--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('NOT contained in RTH');
  });

  it('never publishes a fleet-only figure (TRA-2645/TRA-2677)', () => {
    const { t0, t1 } = healthyPair();
    const { out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(out).toContain('fleet aggregate is deliberately NOT published');
    expect(out).toMatch(/books\.live/);
    expect(out).toMatch(/books\.demo/);
  });
});

describe('TRA-3496: a pair that cannot be differenced REFUSES, never reports a small prefix', () => {
  it('REFUSES when the pid changed mid-window (the counters reset)', () => {
    const { t0, t1 } = pairWithLive(
      { samples: 200, sumMs: 300_000, work: { samples: 200, sumMs: 140_000 } },
      75,
    );
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('RESTARTED');
    expect(out).toContain('pid: 74 -> 75');
  });

  it('REFUSES when startedAt changed even though the pid was REUSED', () => {
    // A restart can be handed the same pid. `startedAt` is the discriminator, so a
    // pid-only check would pass this and difference two different processes.
    const { t0, t1 } = pairWithLive(
      { samples: 200, sumMs: 300_000, work: { samples: 200, sumMs: 140_000 } },
      74,
      '2026-08-12T17:30:00.000Z',
    );
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('RESTARTED');
    expect(out).toContain('startedAt');
  });

  it('REFUSES a NEGATIVE delta — it must never surface as a small prefix', () => {
    // The dangerous case: a counter went backwards while pid/startedAt were
    // preserved, so the restart guard does not fire and only the sign catches it.
    const { t0, t1 } = pairWithLive({ samples: 200, sumMs: 50_000, work: { samples: 200, sumMs: 10_000 } });
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('NEGATIVE delta');
    expect(out).not.toMatch(/books\.live\s+PREFIX/);
  });

  it('REFUSES when exit work exceeds the region (containment broken => negative PREFIX)', () => {
    const { t0, t1 } = pairWithLive({ samples: 200, sumMs: 150_000, work: { samples: 200, sumMs: 190_000 } });
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('CONTAINMENT BROKEN');
  });

  it('REFUSES a window in which NO region closed — BLIND is not a 0% prefix', () => {
    const { t0, t1 } = pairWithLive({ samples: 100, sumMs: 100_000, work: { samples: 100, sumMs: 40_000 } });
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('ZERO regions closed');
  });

  it('REFUSES when exit-work and region samples diverge (1:1 parity holds by construction)', () => {
    const { t0, t1 } = pairWithLive({ samples: 200, sumMs: 300_000, work: { samples: 150, sumMs: 140_000 } });
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('parity BROKEN');
  });

  it('REFUSES a build predating TRA-3444 instead of reading the absent field as zero', () => {
    const t0 = fixture(routeRead({
      at: T0_AT, pid: 74, startedAt: BOOT,
      live: { samples: 100, sumMs: 100_000, work: null },
      demo: { samples: 200, sumMs: 200_000, work: null },
    }));
    const t1 = fixture(routeRead({
      at: T1_AT, pid: 74, startedAt: BOOT,
      live: { samples: 200, sumMs: 300_000, work: null },
      demo: { samples: 400, sumMs: 600_000, work: null },
    }));
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('predates TRA-3444');
  });
});

describe('TRA-3496: the window must be RTH-scoped (TRA-3438)', () => {
  // Measured on bqb1 at 05:45Z on 2026-08-13: PREFIX reads 99.35%/92.62% off-hours
  // purely because both exit passes are idle. TRA-3444 is explicit that this
  // figure must never reach TRA-2268 — it measures the instrument, not the market.
  const offHours = () => {
    const t0 = fixture(routeRead({
      at: '2026-08-13T05:22:58.913Z', pid: 74, startedAt: '2026-08-13T05:22:58.913Z',
      live: { samples: 0, sumMs: 0, work: { samples: 0, sumMs: 0 } },
      demo: { samples: 0, sumMs: 0, work: { samples: 0, sumMs: 0 } },
    }));
    const t1 = fixture(routeRead({
      at: '2026-08-13T05:45:08.319Z', pid: 74, startedAt: '2026-08-13T05:22:58.913Z',
      live: { samples: 132, sumMs: 52_300, work: { samples: 132, sumMs: 337 } },
      demo: { samples: 2716, sumMs: 308_100, work: { samples: 2716, sumMs: 22_700 } },
    }));
    return [`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`];
  };

  it('REFUSES an off-hours window by default', () => {
    const { status, out } = run(offHours());
    expect(status, out).toBe(3);
    expect(out).toContain('NOT contained in RTH');
  });

  it('publishes under --allow-outside-rth but brands it an INSTRUMENT CHECK', () => {
    // The escape exists so the meter can be validated off-hours. It must carry its
    // own caveat, so the number cannot be quoted as an answer without it.
    const { status, out } = run([...offHours(), '--allow-outside-rth']);
    expect(status, out).toBe(0);
    expect(out).toContain('INSTRUMENT CHECK');
    expect(out).toContain('must NOT reach TRA-2268');
  });
});

describe('TRA-3496: notDifferenceable is READ, never typed', () => {
  it('honours a not-differenceable list declared ON the payload', () => {
    // A TRA-2840 snapshot line carries its own list. This one declares `sumMs`
    // not-differenceable — something the real list does NOT say — so a script
    // holding a hand-typed copy would sail straight past it and subtract anyway.
    const snap = (at: string, sumMs: number, workSumMs: number, samples: number) => ({
      marker: 'exit-cadence-snapshot',
      ticket: 'TRA-2840',
      mark: 'T0-open',
      at,
      process: { startedAt: BOOT, pid: 74, commit: 'e44a6d406a6b' },
      partialWindow: false,
      missedOpenMinutes: 0,
      notDifferenceable: ['books.live.tickExitRegionMs.sumMs'],
      rollup: routeRead({
        at, pid: 74, startedAt: BOOT,
        live: { samples, sumMs, work: { samples, sumMs: workSumMs } },
        demo: { samples, sumMs, work: { samples, sumMs: workSumMs } },
      }),
    });
    const t0 = fixture(snap(T0_AT, 100_000, 40_000, 100));
    const t1 = fixture(snap(T1_AT, 300_000, 140_000, 200));
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('NOT differenceable');
    expect(out).toContain('books.live.tickExitRegionMs.sumMs');
  });

  it('resolves the list from source when the payload does not declare one', () => {
    // The raw route does NOT carry `notDifferenceable` (measured on bqb1
    // 2026-08-13). The fallback is EXIT_CADENCE_NOT_DIFFERENCEABLE parsed from
    // exit-cadence-snapshot.ts — never a literal in the script.
    const { t0, t1 } = healthyPair();
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(0);
    expect(out).toContain('exit-cadence-snapshot.ts');
    expect(out).toContain('6 entries, honoured');
  });

  it('REFUSES rather than falling back to a typed list when the source will not parse', () => {
    // Fail closed. A fallback to a typed list is the staleness defect, not a recovery.
    const { t0, t1 } = healthyPair();
    const empty = join(DIR, 'no-constant.ts');
    writeFileSync(empty, '// deliberately does not define the constant\n');
    const { status, out } = run([
      `--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`, `--snapshot-src=${empty}`,
    ]);
    expect(status, out).toBe(3);
    expect(out).toContain('cannot resolve EXIT_CADENCE_NOT_DIFFERENCEABLE');
  });

  it('carries no hand-typed copy of the not-differenceable entries in its source', () => {
    // The anti-fossil assertion. Those entries must be reached by READING the
    // constant, never by re-typing them — a typed copy is exactly the staleness
    // defect (TRA-3443 defect #2) rebuilt one level in.
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toContain("'books.live.tickExitRegionMs.maxMs'");
    expect(src).not.toContain("'books.demo.tickExitRegionMs.maxMs'");
    expect(src).not.toContain("'tickExitRegionMs.exitWorkMs.maxMs'");
    expect(src).toContain('EXIT_CADENCE_NOT_DIFFERENCEABLE');
  });
});

describe('TRA-3496: the cross-check discriminates in BOTH directions', () => {
  // The censored 2026-08-12 tape bounds the PREFIX share to [17.12%, 99.78%]. That
  // is a weak bound — it is 15.6x censored — but it is a real one, and a reading
  // outside it means one of the two instruments is not measuring what it claims.
  // Silently preferring the newer one is the failure this guards.
  const pairAtWorkFraction = (workFrac: number) => {
    const t0 = fixture(routeRead({
      at: T0_AT, pid: 74, startedAt: BOOT,
      live: { samples: 100, sumMs: 0, work: { samples: 100, sumMs: 0 } },
      demo: { samples: 200, sumMs: 0, work: { samples: 200, sumMs: 0 } },
    }));
    const t1 = fixture(routeRead({
      at: T1_AT, pid: 74, startedAt: BOOT,
      live: { samples: 200, sumMs: 1_000_000, work: { samples: 200, sumMs: Math.round(1_000_000 * workFrac) } },
      demo: { samples: 400, sumMs: 1_000_000, work: { samples: 400, sumMs: Math.round(1_000_000 * workFrac) } },
    }));
    return [`--census=${CENSUS_0812}`, `--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`];
  };

  it('REFUSES when the uncensored share falls OUTSIDE the censored interval', () => {
    // 90% of the region as exit work -> PREFIX 10%, below the 17.12% floor.
    const { status, out } = run(pairAtWorkFraction(0.9));
    expect(status, out).toBe(3);
    expect(out).toContain('CONTRADICT');
    expect(out).toContain('VERDICT: REFUSED');
  });

  it('PUBLISHES when the two instruments agree (not a rubber stamp)', () => {
    // 50% exit work -> PREFIX 50%, comfortably inside [17.12%, 99.78%].
    const { status, out } = run(pairAtWorkFraction(0.5));
    expect(status, out).toBe(0);
    expect(out).toContain('AGREE');
    expect(out).toContain('VERDICT: PUBLISHED');
  });
});
