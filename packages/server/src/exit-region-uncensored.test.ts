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

/** A book's ARM STATE as the route reports it (TRA-3507 #8). */
interface BookArm {
  enabled?: boolean | null;
  armedEngineCount?: number | null;
  verdict?: string;
}

/**
 * A `/api/health/exit-cadence` payload, in the shape the route actually serves.
 *
 * TRA-3507 — the defaults here USED to be `live: { enabled: false,
 * armedEngineCount: 0 }`, copied from the live off-hours read. That made the
 * suite's own known-good the exact shape TRA-3507 says may never publish: every
 * "must still PUBLISH" control was asserting a DISARMED money book. A positive
 * control built out of the forbidden world proves nothing about the world you
 * act in. The default is now ARMED, and the disarmed shape is asserted
 * explicitly, where it belongs.
 */
function routeRead(o: {
  at: string;
  pid: number;
  startedAt: string;
  commit?: string;
  live: BookCounters;
  demo: BookCounters;
  marketOpen?: boolean | null;
  liveArm?: BookArm;
  demoArm?: BookArm;
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
  const book = (name: string, counters: BookCounters, arm: BookArm) => {
    const armed = 'armedEngineCount' in arm ? arm.armedEngineCount : 3;
    return {
      book: name,
      enabled: 'enabled' in arm ? arm.enabled : true,
      armedEngineCount: armed,
      ...(arm.verdict === undefined ? {} : { verdict: arm.verdict }),
      notGradeableReason: null,
      tickExitRegionMs: region(counters),
    };
  };
  return {
    ok: true,
    time: o.at,
    ...(o.marketOpen === null ? {} : { marketOpen: o.marketOpen ?? true }),
    partitionedBy: 'mode',
    build: {
      commit: o.commit ?? 'e44a6d406a6be7e437c6177d8ebd3246b24a16e9',
      pid: o.pid,
      startedAt: o.startedAt,
    },
    books: {
      live: book('live', o.live, o.liveArm ?? { enabled: true, armedEngineCount: 3 }),
      demo: book('demo', o.demo, o.demoArm ?? { enabled: true, armedEngineCount: 63 }),
    },
    tickExitRegionMs: region(fleet),
  };
}

/**
 * What `rollUpExitCadence()` actually returns — i.e. what a TRA-2840 snapshot
 * line stores under `.rollup`.
 *
 * `ok`, `time`, `build` and `marketOpen` are stamped by the ROUTE HANDLER around
 * the rollup (health-routes.ts), so a snapshot line carries none of them. Using
 * a whole route payload as a stand-in for a rollup is a fixture that quietly
 * gives the snapshot path a field it can never have — and the guard under test
 * is exactly "this shape cannot answer #7".
 */
function rollupOnly(payload: unknown): unknown {
  const { ok: _ok, time: _time, build: _build, marketOpen: _marketOpen, ...rollup } =
    payload as Record<string, unknown>;
  return rollup;
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
  // `marketOpen: false` is what the route actually served at that hour. The books
  // are left ARMED here deliberately: this block's subject is the WINDOW guard,
  // and an arm-state suppression would decide the outcome before it fires. The
  // fully realistic shape — disarmed live and all — is asserted under TRA-3507.
  const offHours = () => {
    const t0 = fixture(routeRead({
      at: '2026-08-13T05:22:58.913Z', pid: 74, startedAt: '2026-08-13T05:22:58.913Z', marketOpen: false,
      live: { samples: 0, sumMs: 0, work: { samples: 0, sumMs: 0 } },
      demo: { samples: 0, sumMs: 0, work: { samples: 0, sumMs: 0 } },
    }));
    const t1 = fixture(routeRead({
      at: '2026-08-13T05:45:08.319Z', pid: 74, startedAt: '2026-08-13T05:22:58.913Z', marketOpen: false,
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

describe('TRA-3507 #9: THE POSITIVE CONTROL CONTAINS WHAT IT DETECTS', () => {
  // The live reproduction, verbatim: /api/health/exit-cadence on bqb1 at
  // 2026-08-13T05:41:59Z, build e44a6d406a6b, pid 74, booted 05:22:58.913Z.
  //
  //   books.live  n=111   sumMs=43751   exitWorkMs {samples:111,  sumMs:291}
  //   books.demo  n=2319  sumMs=289692  exitWorkMs {samples:2319, sumMs:19860}
  //   PREFIX(live) = 99.335%   PREFIX(demo) = 93.144%
  //
  // Every pre-existing guard PASSES it: same pid, same startedAt, same commit,
  // positive deltas, per-book, 1:1 sample parity, exit work contained. A control
  // set made only of MALFORMED inputs would not have covered it — which is why
  // the well-formedness is asserted here as its own test, not assumed.
  const REPRO_BOOT = '2026-08-13T05:22:58.913Z';
  const REPRO_T1 = '2026-08-13T05:41:59.000Z';
  const reproT1 = (over: Partial<Parameters<typeof routeRead>[0]> = {}) => fixture(routeRead({
    at: REPRO_T1, pid: 74, startedAt: REPRO_BOOT, commit: 'e44a6d406a6b',
    marketOpen: false,
    live: { samples: 111, sumMs: 43_751, work: { samples: 111, sumMs: 291 } },
    demo: { samples: 2319, sumMs: 289_692, work: { samples: 2319, sumMs: 19_860 } },
    liveArm: { enabled: true, armedEngineCount: 0, verdict: 'disarmed' },
    demoArm: { enabled: true, armedEngineCount: 12, verdict: 'ok' },
    ...over,
  }));

  it('REFUSES the 05:22-05:41Z shape on BOTH #7 (market closed) and #8 (live disarmed)', () => {
    const { status, out } = run([`--exit-cadence-t1=${reproT1()}`]);
    expect(status, out).toBe(3);
    // #7 — the market session, asserted on the payload's own fields.
    expect(out).toContain('marketOpen: false');
    expect(out).toContain('NOT inside one 09:30-16:00 America/New_York session');
    // #8 — the money book carries no answer, and does not carry a zero either.
    expect(out).toContain('<<DISARMED>>');
    expect(out).toContain('verdict="disarmed"');
  });

  it('the repro is WELL-FORMED: no other guard is what refuses it', () => {
    // The half of a positive control nobody runs. If the fixture tripped the
    // restart / negative-delta / parity / containment guards, the test above
    // would pass for the wrong reason and #7 and #8 would still be unproven.
    const { out } = run([`--exit-cadence-t1=${reproT1()}`]);
    expect(out).not.toContain('RESTARTED');
    expect(out).not.toContain('NEGATIVE delta');
    expect(out).not.toContain('parity BROKEN');
    expect(out).not.toContain('CONTAINMENT BROKEN');
    expect(out).not.toContain('ZERO regions closed');
    expect(out).not.toContain('predates TRA-3444');
    // …and it IS the same process at both ends, which is what made it plausible.
    expect(out).toContain('pid=74');
    expect(out).toContain(`startedAt=${REPRO_BOOT}`);
  });

  it('#9: the REFUSED read prints NO figure — not on stdout, not in --json', () => {
    // The leak this ticket found by running the repro: the reader printed the
    // full per-book table ABOVE its own refusal, so a correctly-refusing run put
    // 99.33% on the screen and into --json, one copy-paste from TRA-2268.
    const t1 = reproT1();
    for (const args of [[`--exit-cadence-t1=${t1}`], [`--exit-cadence-t1=${t1}`, '--json']]) {
      const { status, out } = run(args);
      expect(status, out).toBe(3);
      expect(out).not.toContain('99.33');
      expect(out).not.toContain('93.14');
      // …nor the millisecond terms a reader is one subtraction away from.
      expect(out).not.toContain('43460');
      expect(out).not.toContain('269832');
      expect(out).not.toMatch(/43\.[0-9]s/);
    }
  });

  it('#9 keeps what an operator needs to take a VALID read instead', () => {
    const { out } = run([`--exit-cadence-t1=${reproT1()}`]);
    expect(out).toContain('FIGURES WITHHELD');
    expect(out).toContain(REPRO_T1);          // the window it refused
    expect(out).toContain('pid=74');          // the process it read
  });
});

describe('TRA-3507 #7: the market session, read off the payload', () => {
  it('REFUSES `marketOpen: false` even on a window inside RTH', () => {
    // Isolates the flag from the clock: an RTH-contained window, armed books,
    // and the producer's own predicate saying the market is shut.
    const t1 = fixture(routeRead({
      at: T1_AT, pid: 74, startedAt: BOOT, marketOpen: false,
      live: { samples: 200, sumMs: 300_000, work: { samples: 200, sumMs: 150_000 } },
      demo: { samples: 400, sumMs: 600_000, work: { samples: 400, sumMs: 300_000 } },
    }));
    const { status, out } = run([`--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('marketOpen: false');
    expect(out).not.toMatch(/books\.live\s+PREFIX/);
  });

  it('REFUSES an ABSENT `marketOpen` — absent is not open', () => {
    const t1 = fixture(routeRead({
      at: T1_AT, pid: 74, startedAt: BOOT, marketOpen: null,
      live: { samples: 200, sumMs: 300_000, work: { samples: 200, sumMs: 150_000 } },
      demo: { samples: 400, sumMs: 600_000, work: { samples: 400, sumMs: 300_000 } },
    }));
    const { status, out } = run([`--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('does not declare `marketOpen`');
  });

  it('REFUSES an EST pre-open window the fixed-UTC bounds call RTH-contained', () => {
    // The DST hole. RTH_{OPEN,CLOSE}_UTC_MIN are 13:30-20:00Z, correct only under
    // EDT. On 2026-01-14 (EST) that window is 08:30-15:00 ET, so 13:35-14:20Z is
    // 08:35-09:20 ET — PRE-OPEN — and passes the UTC test. `marketOpen` is forged
    // true here precisely to prove the ET clock test is not redundant with it:
    // neither leg subsumes the other, so both are required.
    const t1 = fixture(routeRead({
      at: '2026-01-14T14:20:00.000Z', pid: 74, startedAt: '2026-01-14T13:35:00.000Z', marketOpen: true,
      live: { samples: 200, sumMs: 300_000, work: { samples: 200, sumMs: 150_000 } },
      demo: { samples: 400, sumMs: 600_000, work: { samples: 400, sumMs: 300_000 } },
    }));
    const { status, out } = run([`--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('RTH-contained');                            // the OLD guard passed it
    expect(out).toContain('NOT inside one 09:30-16:00 America/New_York session');
    expect(out).toContain('08:35 ET');
  });

  it('REFUSES a TRA-2840 snapshot line, which cannot carry `marketOpen`, and names the remedy', () => {
    // `marketOpen` is stamped by the route handler outside `rollUpExitCadence`, so
    // a snapshot line has no such field — the same location trap as
    // `notDifferenceable`, in the other direction. Fail closed, say where to look.
    const snap = (at: string, sumMs: number, workSumMs: number, samples: number) => ({
      marker: 'exit-cadence-snapshot', ticket: 'TRA-2840', mark: 'T1-close', at,
      process: { startedAt: BOOT, pid: 74, commit: 'e44a6d406a6b' },
      partialWindow: false, missedOpenMinutes: 0,
      notDifferenceable: ['books.live.tickExitRegionMs.maxMs'],
      rollup: rollupOnly(routeRead({
        at, pid: 74, startedAt: BOOT,
        live: { samples, sumMs, work: { samples, sumMs: workSumMs } },
        demo: { samples, sumMs, work: { samples, sumMs: workSumMs } },
      })),
    });
    const t0 = fixture(snap(T0_AT, 100_000, 40_000, 100));
    const t1 = fixture(snap(T1_AT, 300_000, 140_000, 200));
    const { status, out } = run([`--exit-cadence-t0=${t0}`, `--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('snapshot line does not carry it');
  });

  it('PUBLISHES the same window when the market is open and the books are armed', () => {
    // The other direction, every time. A guard that can only refuse is a rubber
    // stamp with an alarm attached (TRA-1787).
    const t1 = fixture(routeRead({
      at: T1_AT, pid: 74, startedAt: BOOT, marketOpen: true,
      live: { samples: 200, sumMs: 300_000, work: { samples: 200, sumMs: 150_000 } },
      demo: { samples: 400, sumMs: 600_000, work: { samples: 400, sumMs: 300_000 } },
    }));
    const { status, out } = run([`--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(0);
    expect(out).toMatch(/books\.live\s+PREFIX = 50\.00%/);
  });
});

describe('TRA-3507 #8: a disarmed book reports <<DISARMED>>, never a number and never a 0', () => {
  const rthPair = (liveArm: BookArm, demoArm?: BookArm) => fixture(routeRead({
    at: T1_AT, pid: 74, startedAt: BOOT, marketOpen: true,
    live: { samples: 200, sumMs: 300_000, work: { samples: 200, sumMs: 6_000 } },   // 98% PREFIX
    demo: { samples: 400, sumMs: 600_000, work: { samples: 400, sumMs: 300_000 } }, // 50% PREFIX
    liveArm, demoArm,
  }));

  it('suppresses a live book with armedEngineCount 0 while demo still publishes', () => {
    const { status, out } = run([`--exit-cadence-t1=${rthPair({ enabled: true, armedEngineCount: 0 })}`]);
    expect(status, out).toBe(0);                       // demo is a real, armed population
    expect(out).toContain('<<DISARMED>>');
    expect(out).toContain('armedEngineCount=0');
    expect(out).not.toContain('98.00%');               // never the number…
    expect(out).not.toMatch(/books\.live\s+PREFIX = 0/); // …and never a zero
    expect(out).toMatch(/books\.demo\s+PREFIX = 50\.00%/);
    expect(out).toContain('THIS READ CARRIES NO MONEY-BOOK ANSWER');
  });

  it('suppresses on `verdict: "disarmed"` even when the count would pass', () => {
    // The two fields can disagree. Either one saying disarmed is enough.
    const { out } = run([`--exit-cadence-t1=${rthPair({ enabled: true, armedEngineCount: 4, verdict: 'disarmed' })}`]);
    expect(out).toContain('<<DISARMED>>');
    expect(out).toContain('verdict="disarmed"');
    expect(out).not.toContain('98.00%');
  });

  it('reports <<ABSENT>> for a NULL arm count — a zero is a claim about a measurement nobody took', () => {
    const { out } = run([`--exit-cadence-t1=${rthPair({ enabled: true, armedEngineCount: null })}`]);
    expect(out).toContain('<<ABSENT>>');
    expect(out).toContain('book is blind');
    expect(out).not.toContain('<<DISARMED>>');
    expect(out).not.toContain('98.00%');
  });

  it('REFUSES outright when EVERY book is suppressed — BLIND, not a 0% split', () => {
    const t1 = rthPair({ enabled: true, armedEngineCount: 0 }, { enabled: true, armedEngineCount: 0 });
    const { status, out } = run([`--exit-cadence-t1=${t1}`]);
    expect(status, out).toBe(3);
    expect(out).toContain('EVERY book is suppressed');
    expect(out).toContain('That is BLIND, not a 0% split');
  });

  it('--allow-outside-rth does NOT lift the disarmed guard', () => {
    // The off-hours escape exists to validate the meter. A disarmed book has no
    // split at ANY hour, so there is nothing for that flag to release.
    const t1 = fixture(routeRead({
      at: '2026-08-13T05:41:59.000Z', pid: 74, startedAt: '2026-08-13T05:22:58.913Z', marketOpen: false,
      live: { samples: 111, sumMs: 43_751, work: { samples: 111, sumMs: 291 } },
      demo: { samples: 2319, sumMs: 289_692, work: { samples: 2319, sumMs: 19_860 } },
      liveArm: { enabled: true, armedEngineCount: 0, verdict: 'disarmed' },
    }));
    const { out } = run([`--exit-cadence-t1=${t1}`, '--allow-outside-rth']);
    expect(out).toContain('<<DISARMED>>');
    expect(out).not.toContain('99.33');
  });

  it('withholds the fleet aggregate whenever a book is suppressed', () => {
    // A fleet sum folding a disarmed book's idle time into an armed book's is a
    // contaminated positive control, and a contaminated control agrees with anything.
    const { out } = run([`--exit-cadence-t1=${rthPair({ enabled: true, armedEngineCount: 0 })}`,
      `--census=${CENSUS_0812}`]);
    expect(out).toContain('fleet aggregate is WITHHELD');
    expect(out).not.toContain('CROSS-CHECK (positive control)');
  });

  it('PUBLISHES both books when both are armed (not a rubber stamp)', () => {
    const { status, out } = run([`--exit-cadence-t1=${rthPair({ enabled: true, armedEngineCount: 2 })}`]);
    expect(status, out).toBe(0);
    expect(out).not.toContain('<<DISARMED>>');
    expect(out).toMatch(/books\.live\s+PREFIX = 98\.00%/);
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
      rollup: rollupOnly(routeRead({
        at, pid: 74, startedAt: BOOT,
        live: { samples, sumMs, work: { samples, sumMs: workSumMs } },
        demo: { samples, sumMs, work: { samples, sumMs: workSumMs } },
      })),
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
