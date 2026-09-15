import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveConfig,
  evaluateSample,
  startEventLoopWatchdog,
  getWatchdogStatus,
  resolveTripLogPath,
  readLastTrip,
  resolveLivenessLogPath,
  readLastLiveness,
  isUnexplainedDeath,
  _resetWatchdogForTests,
  readCgroupMemoryLimitBytes,
  DEFAULT_WATCHDOG,
  type WatchdogConfig,
  type WatchdogSample,
  type WatchdogState,
  type TripDecision,
} from './event-loop-watchdog.js';

afterEach(() => {
  _resetWatchdogForTests();
});

const cfg = (over: Partial<WatchdogConfig> = {}): WatchdogConfig => ({ ...DEFAULT_WATCHDOG, ...over });
const freshState = (): WatchdogState => ({ consecutiveHeapBreaches: 0, consecutiveLagBreaches: 0 });
const sample = (over: Partial<WatchdogSample> = {}): WatchdogSample => ({
  heapUsedBytes: 100e6,
  heapLimitBytes: 1536e6,
  heapPct: 100e6 / 1536e6,
  lagMeanMs: 5,
  lagMaxMs: 20,
  rssBytes: 400e6,
  ...over,
});

describe('resolveConfig', () => {
  it('is ON with restart ON by default (no env) — meets the self-restart acceptance', () => {
    // cgroup limit injected as null: resolveConfig() otherwise READS THE REAL BOX (TRA-1687),
    // so this assertion would pass on a dev laptop and fail on containerised CI. A test whose
    // verdict depends on where it runs is not a test.
    const c = resolveConfig({}, null);
    expect(c.enabled).toBe(true);
    expect(c.restartEnabled).toBe(true);
    expect(c).toEqual(DEFAULT_WATCHDOG);
  });

  it('TRA-4560 — the default heap trip sits BELOW the measured V8 OOM point on bqb1', () => {
    // bqb1 heap_size_limit = 1811939328 B; the three exit-134 deaths read heapUsed 1601-1605 MB.
    const limit = 1_811_939_328;
    const lowestMeasuredDeath = 1_601e6;
    expect(DEFAULT_WATCHDOG.heapPct * limit).toBeLessThan(lowestMeasuredDeath);
    // 10 samples at the 09-15 priorLiveness reading (1601 MB, 16s before the abort) trip it.
    const c = cfg({ rssMaxBytes: 0 });
    const s = freshState();
    const atDeath = sample({ heapUsedBytes: lowestMeasuredDeath, heapLimitBytes: limit, heapPct: lowestMeasuredDeath / limit });
    let d: TripDecision = { trip: false };
    for (let i = 0; i < c.breachSamples; i++) d = evaluateSample(atDeath, s, c);
    expect(d).toMatchObject({ trip: true, reason: 'heap' });
  });

  it('honours explicit disable spellings', () => {
    expect(resolveConfig({ WATCHDOG_ENABLED: 'false' }).enabled).toBe(false);
    expect(resolveConfig({ WATCHDOG_ENABLED: '0' }).enabled).toBe(false);
    expect(resolveConfig({ WATCHDOG_RESTART_ENABLED: 'off' }).restartEnabled).toBe(false);
  });

  it('clamps numeric knobs to safe ranges', () => {
    expect(resolveConfig({ WATCHDOG_HEAP_PCT: '2' }).heapPct).toBe(0.99);
    expect(resolveConfig({ WATCHDOG_HEAP_PCT: '0.1' }).heapPct).toBe(0.5);
    expect(resolveConfig({ WATCHDOG_LAG_MS: '50' }).lagMs).toBe(100);
    expect(resolveConfig({ WATCHDOG_BREACH_SAMPLES: '3.9' }).breachSamples).toBe(3);
    expect(resolveConfig({ WATCHDOG_SAMPLE_MS: 'abc' }).sampleMs).toBe(DEFAULT_WATCHDOG.sampleMs);
  });

  it('TRA-1082 — block trip defaults to 4s and is env-tunable / clamped', () => {
    expect(resolveConfig({}).lagMaxMs).toBe(4_000);
    expect(resolveConfig({ WATCHDOG_BLOCK_MS: '3000' }).lagMaxMs).toBe(3_000);
    expect(resolveConfig({ WATCHDOG_BLOCK_MS: '100' }).lagMaxMs).toBe(500); // clamped up
  });

  it('TRA-1084 — boot grace defaults to 120s and is env-tunable / clamped', () => {
    expect(resolveConfig({}).bootGraceMs).toBe(120_000);
    expect(resolveConfig({ WATCHDOG_BOOT_GRACE_MS: '0' }).bootGraceMs).toBe(0); // disable allowed
    expect(resolveConfig({ WATCHDOG_BOOT_GRACE_MS: '30000' }).bootGraceMs).toBe(30_000);
    expect(resolveConfig({ WATCHDOG_BOOT_GRACE_MS: '9999999' }).bootGraceMs).toBe(1_800_000); // clamped down
  });

  it('TRA-1374 — RSS ceiling is env-tunable (MB→bytes), clamped, and 0 disables', () => {
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: '3500' }, null).rssMaxBytes).toBe(3_500 * 1e6);
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: '0' }, null).rssMaxBytes).toBe(0); // explicit disable
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: '-5' }, null).rssMaxBytes).toBe(0); // non-positive disables
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: '100' }, null).rssMaxBytes).toBe(256 * 1e6); // clamped up
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: '999999' }, null).rssMaxBytes).toBe(32_768 * 1e6); // clamped down
  });
});

// ---------------------------------------------------------------------------
// TRA-1687 — the ceiling must be DERIVED FROM THE BOX, not hardcoded.
//
// The test this file used to carry read:
//     expect(resolveConfig({}).rssMaxBytes).toBe(1_900 * 1e6);
// It passed for months. It passed all the way through TRA-1683, while the guard it
// was allegedly testing self-restarted a healthy engine ~40x per session. It passed
// BECAUSE it asserted the constant instead of the property — THE TEST ENCODED THE BUG,
// and a green suite is exactly how the defect stayed invisible.
//
// The property is not "the ceiling is 1900MB", nor "the ceiling is 3400MB" — that is
// the same mistake with a fresher number, and it re-arms the moment the box is resized
// again. The property is: THE CEILING TRACKS THE BOX. Every test below grades that.
// ---------------------------------------------------------------------------
const PRO_CGROUP = 4 * 1024 ** 3; // 4 GiB — bqb1 today
const STANDARD_CGROUP = 2 * 1024 ** 3; // 2 GiB — bqb1 when 1900MB was written
const OBSERVED_RTH_PEAK = 2_208 * 1e6; // highest RSS ever seen on a real session (TRA-1683)

describe('TRA-1687 — RSS ceiling derives from the real cgroup limit', () => {
  it('THE REGRESSION: with no override, the derived ceiling clears the real RTH working set', () => {
    // This is the assertion whose absence cost us TRA-1683. 1900MB sat BELOW the
    // 2.0-2.2GB working set, so the guard executed a healthy engine instead of saving it.
    const c = resolveConfig({}, PRO_CGROUP);
    expect(c.rssMaxSource).toBe('cgroup-derived');
    expect(c.rssMaxBytes).toBeGreaterThan(OBSERVED_RTH_PEAK); // cannot fire on healthy load
    expect(c.rssMaxBytes).toBeLessThan(PRO_CGROUP - 300e6); // can still pre-empt the SIGKILL
    expect(c.cgroupLimitBytes).toBe(PRO_CGROUP);
  });

  it('the SAME code on a SMALLER box derives a SMALLER ceiling — it tracks the environment', () => {
    // The whole defect in one assertion: identical source, identical env, different box.
    // The old constant could not do this, which is why moving the box silently inverted it.
    const pro = resolveConfig({}, PRO_CGROUP).rssMaxBytes;
    const standard = resolveConfig({}, STANDARD_CGROUP).rssMaxBytes;
    expect(standard).toBeLessThan(pro);
    expect(standard).toBeLessThan(STANDARD_CGROUP);
    expect(pro).toBeLessThan(PRO_CGROUP);
  });

  it('flags the EXACT TRA-1683 config as suspect instead of silently obeying it', () => {
    // 1900MB on a 4GiB box: 44% of capacity, inside the healthy working set. This is the
    // config that ran in prod for weeks. It is honoured (an operator override is not ours
    // to silently raise) but it now SAYS SO OUT LOUD — the thing nothing ever did.
    const c = resolveConfig({ WATCHDOG_RSS_MAX_MB: '1900' }, PRO_CGROUP);
    expect(c.rssMaxBytes).toBe(1_900 * 1e6); // honoured, not overridden
    expect(c.rssMaxSource).toBe('env-suspect');
    expect(c.rssMaxWarning).toMatch(/44% of the 4295MB cgroup limit/);
  });

  it('clamps DOWN an override that could not pre-empt the kernel — the one safe direction', () => {
    // A ceiling at/above the kill line is not a guard: the kernel gets there first and we
    // take the abrupt 137 the trip exists to prevent. Clamping down can only make it fire
    // earlier and more gracefully, so it is safe to do silently — and we still say so.
    const c = resolveConfig({ WATCHDOG_RSS_MAX_MB: '4200' }, PRO_CGROUP);
    expect(c.rssMaxSource).toBe('env-clamped');
    expect(c.rssMaxBytes).toBeLessThan(PRO_CGROUP - 300e6);
    expect(c.rssMaxWarning).toMatch(/kernel would SIGKILL first/);
  });

  it('a TYPO no longer silently removes the OOM guard', () => {
    // Old behaviour: `resolveConfig({WATCHDOG_RSS_MAX_MB:'abc'}).rssMaxBytes === 0`. A
    // fat-fingered env var DISABLED the guard and nothing anywhere said a word.
    const c = resolveConfig({ WATCHDOG_RSS_MAX_MB: 'abc' }, PRO_CGROUP);
    expect(c.rssMaxBytes).toBeGreaterThan(OBSERVED_RTH_PEAK); // guard still armed
    expect(c.rssMaxSource).toBe('cgroup-derived');
    expect(c.rssMaxWarning).toMatch(/is not a number/);
  });

  it('an explicit 0 still disables — the operator asked, so obey', () => {
    const c = resolveConfig({ WATCHDOG_RSS_MAX_MB: '0' }, PRO_CGROUP);
    expect(c.rssMaxBytes).toBe(0);
    expect(c.rssMaxSource).toBe('disabled');
    expect(c.rssMaxWarning).toBeNull();
  });

  it('no cgroup AND no override → guard OFF, loudly (there is no cgroup kill to pre-empt)', () => {
    const c = resolveConfig({}, null);
    expect(c.rssMaxBytes).toBe(0);
    expect(c.rssMaxSource).toBe('unresolved-disabled');
    expect(c.rssMaxWarning).toMatch(/RSS trip disabled/);
  });
});

describe('TRA-1687 — readCgroupMemoryLimitBytes', () => {
  const reader = (files: Record<string, string>) => (p: string) => {
    if (!(p in files)) throw new Error('ENOENT');
    return files[p];
  };

  it('reads the cgroup v2 limit', () => {
    expect(readCgroupMemoryLimitBytes(reader({ '/sys/fs/cgroup/memory.max': '4294967296\n' }))).toBe(4294967296);
  });

  it('falls back to cgroup v1 when v2 is absent', () => {
    const v1 = { '/sys/fs/cgroup/memory/memory.limit_in_bytes': '2147483648\n' };
    expect(readCgroupMemoryLimitBytes(reader(v1))).toBe(2147483648);
  });

  it('treats BOTH spellings of "unlimited" as no-limit, not as a ceiling', () => {
    // v2 says `max` -> NaN. v1 says a page-aligned 2^63 sentinel -> a finite number that
    // would derive a ~9 EXABYTE ceiling: a guard that can never fire, dressed as a configured
    // one. Silently-disabled-but-looks-armed is the worst state available, so reject both.
    expect(readCgroupMemoryLimitBytes(reader({ '/sys/fs/cgroup/memory.max': 'max\n' }))).toBeNull();
    const v1Unlimited = { '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n' };
    expect(readCgroupMemoryLimitBytes(reader(v1Unlimited))).toBeNull();
  });

  it('returns null off-container (no cgroup files at all)', () => {
    expect(readCgroupMemoryLimitBytes(reader({}))).toBeNull();
  });
});

describe('evaluateSample — TRA-1374 acute RSS trip', () => {
  it('trips immediately on a single sample over the RSS ceiling (beats the cgroup OOM-137)', () => {
    const c = cfg({ rssMaxBytes: 1_900e6 });
    const state = freshState();
    const decision = evaluateSample(sample({ rssBytes: 1_950e6 }), state, c);
    expect(decision.trip).toBe(true);
    expect(decision.reason).toBe('rss');
  });

  it('does not trip when RSS is below the ceiling even with a healthy heap', () => {
    const c = cfg({ rssMaxBytes: 1_900e6 });
    const state = freshState();
    expect(evaluateSample(sample({ rssBytes: 1_800e6 }), state, c).trip).toBe(false);
  });

  it('fires even though the V8 heap is nowhere near its limit — the failure mode heap trip is blind to', () => {
    const c = cfg({ rssMaxBytes: 1_900e6 });
    const state = freshState();
    // Low heap (native/external memory is the burst), high RSS.
    const decision = evaluateSample(
      sample({ heapUsedBytes: 200e6, heapPct: 200 / 1536, rssBytes: 1_920e6 }),
      state,
      c,
    );
    expect(decision.trip).toBe(true);
    expect(decision.reason).toBe('rss');
  });

  it('is disabled when rssMaxBytes is 0 — no RSS trip regardless of RSS', () => {
    const c = cfg({ rssMaxBytes: 0 });
    const state = freshState();
    expect(evaluateSample(sample({ rssBytes: 8_000e6 }), state, c).trip).toBe(false);
  });
});

describe('evaluateSample — heap trip', () => {
  it('does not trip on a single breach; trips only after breachSamples consecutive', () => {
    const c = cfg({ breachSamples: 3, heapPct: 0.9 });
    const state = freshState();
    const hot = sample({ heapUsedBytes: 1500e6, heapLimitBytes: 1536e6, heapPct: 1500 / 1536 });
    expect(evaluateSample(hot, state, c).trip).toBe(false);
    expect(evaluateSample(hot, state, c).trip).toBe(false);
    const third = evaluateSample(hot, state, c);
    expect(third.trip).toBe(true);
    expect(third.reason).toBe('heap');
  });

  it('resets the counter when a healthy sample lands between breaches', () => {
    const c = cfg({ breachSamples: 3, heapPct: 0.9 });
    const state = freshState();
    const hot = sample({ heapPct: 0.95 });
    const cool = sample({ heapPct: 0.2 });
    evaluateSample(hot, state, c);
    evaluateSample(hot, state, c);
    evaluateSample(cool, state, c); // resets
    expect(state.consecutiveHeapBreaches).toBe(0);
    expect(evaluateSample(hot, state, c).trip).toBe(false);
  });
});

describe('evaluateSample — lag trip', () => {
  it('trips on sustained event-loop lag independent of heap', () => {
    const c = cfg({ breachSamples: 2, lagMs: 2000, lagMaxMs: 600_000 });
    const state = freshState();
    // lagMaxMs kept below the (disabled-high) block threshold so this exercises
    // the SUSTAINED mean-lag path, not the new acute single-block trip.
    const laggy = sample({ lagMeanMs: 3500, lagMaxMs: 3900, heapPct: 0.1 });
    expect(evaluateSample(laggy, state, c).trip).toBe(false);
    const d: TripDecision = evaluateSample(laggy, state, c);
    expect(d.trip).toBe(true);
    expect(d.reason).toBe('lag');
    expect(d.detail).toContain('event-loop');
  });
});

describe('evaluateSample — TRA-1082 acute single-block trip', () => {
  it('trips IMMEDIATELY on one window whose max lag exceeds the block threshold', () => {
    const c = cfg({ lagMaxMs: 4000, breachSamples: 10 });
    const state = freshState();
    // A single 6s block: max lag ~6000ms in one window, mean still modest. The
    // sustained trip (breachSamples=10) would need 10 windows; the block trip
    // fires on the first so a clean restart beats Render's 5s health-check kill.
    const blocked = sample({ lagMeanMs: 800, lagMaxMs: 6000, heapPct: 0.2 });
    const d = evaluateSample(blocked, state, c);
    expect(d.trip).toBe(true);
    expect(d.reason).toBe('block');
    expect(d.detail).toContain('single event-loop block');
  });

  it('does not trip on a sub-threshold spike (one normal slow tick)', () => {
    const c = cfg({ lagMaxMs: 4000, breachSamples: 10 });
    const state = freshState();
    const spike = sample({ lagMeanMs: 200, lagMaxMs: 3500, heapPct: 0.2 });
    expect(evaluateSample(spike, state, c).trip).toBe(false);
  });
});

describe('startEventLoopWatchdog', () => {
  it('returns null and never samples when disabled', () => {
    const handle = startEventLoopWatchdog({ env: { WATCHDOG_ENABLED: 'false' } });
    expect(handle).toBeNull();
  });

  it('fires onTrip with a clean exit reason when heap is pinned high', () => {
    const trips: TripDecision[] = [];
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_BREACH_SAMPLES: '2', WATCHDOG_HEAP_PCT: '0.9', WATCHDOG_BOOT_GRACE_MS: '0' },
      readHeap: () => ({ usedBytes: 1500e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      onTrip: d => trips.push(d),
    });
    expect(handle).not.toBeNull();
    handle!.sampleNow();
    expect(trips).toHaveLength(0);
    handle!.sampleNow();
    expect(trips).toHaveLength(1);
    expect(trips[0]?.reason).toBe('heap');

    const status = handle!.status();
    expect(status.tripped).toBe(true);
    expect(status.trippedReason).toBe('heap');
    expect(getWatchdogStatus()?.tripped).toBe(true);
    handle!.stop();
  });

  it('observe-only mode surfaces the trip but never calls onTrip', () => {
    const trips: TripDecision[] = [];
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_BREACH_SAMPLES: '1', WATCHDOG_HEAP_PCT: '0.9', WATCHDOG_RESTART_ENABLED: 'false', WATCHDOG_BOOT_GRACE_MS: '0' },
      readHeap: () => ({ usedBytes: 1500e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      onTrip: d => trips.push(d),
    });
    handle!.sampleNow();
    expect(trips).toHaveLength(0); // restart disabled ⇒ onTrip not invoked
    expect(handle!.status().tripped).toBe(true);
    handle!.stop();
  });

  it('TRA-1084 — suppresses the restart trip during the boot grace, then arms after it elapses', () => {
    const trips: TripDecision[] = [];
    let clock = 1_000_000;
    const handle = startEventLoopWatchdog({
      // Heap pinned high so a single sample breaches (breachSamples=1); grace 120s.
      env: { WATCHDOG_BREACH_SAMPLES: '1', WATCHDOG_HEAP_PCT: '0.9', WATCHDOG_BOOT_GRACE_MS: '120000' },
      readHeap: () => ({ usedBytes: 1500e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      now: () => clock,
      onTrip: d => trips.push(d),
    });

    // 30s in — within the grace window: the breach is evaluated but the restart
    // is suppressed, and the sustained counter is reset so it can't carry over.
    clock = 1_000_000 + 30_000;
    handle!.sampleNow();
    expect(trips).toHaveLength(0);
    expect(handle!.status().tripped).toBe(false);
    expect(handle!.status().inBootGrace).toBe(true);
    expect(handle!.status().consecutiveHeapBreaches).toBe(0); // reset on suppressed trip

    // 130s in — past the grace window: the same breach now fires the restart.
    clock = 1_000_000 + 130_000;
    handle!.sampleNow();
    expect(trips).toHaveLength(1);
    expect(trips[0]?.reason).toBe('heap');
    expect(handle!.status().tripped).toBe(true);
    expect(handle!.status().inBootGrace).toBe(false);
    handle!.stop();
  });

  it('TRA-1084 — boot-grace=0 arms immediately (parity with pre-grace behavior)', () => {
    const trips: TripDecision[] = [];
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_BREACH_SAMPLES: '1', WATCHDOG_HEAP_PCT: '0.9', WATCHDOG_BOOT_GRACE_MS: '0' },
      readHeap: () => ({ usedBytes: 1500e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      onTrip: d => trips.push(d),
    });
    handle!.sampleNow();
    expect(trips).toHaveLength(1);
    expect(handle!.status().inBootGrace).toBe(false);
    handle!.stop();
  });

  it('TRA-1089 — peakSinceBoot/recentHighLag stay empty during boot grace, then populate after it', () => {
    let clock = 1_000_000;
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_BREACH_SAMPLES: '5', WATCHDOG_HEAP_PCT: '0.95', WATCHDOG_BOOT_GRACE_MS: '120000' },
      readHeap: () => ({ usedBytes: 100e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      now: () => clock,
      onTrip: () => {},
    });

    // 30s in — within grace: warmup samples must never seed the steady-state peak.
    clock = 1_000_000 + 30_000;
    handle!.sampleNow();
    expect(handle!.status().peakSinceBoot).toBeNull();
    expect(handle!.status().recentHighLag).toEqual([]);

    // 130s in — past grace: the peak now folds in steady-state samples.
    clock = 1_000_000 + 130_000;
    handle!.sampleNow();
    const status = handle!.status();
    expect(status.peakSinceBoot).not.toBeNull();
    expect(typeof status.peakSinceBoot?.lagMaxMs).toBe('number');
    expect(Array.isArray(status.recentHighLag)).toBe(true);
    handle!.stop();
  });

  it('TRA-1374 — fires onTrip with reason "rss" on a single RSS-ceiling breach (native-memory burst, low heap)', () => {
    const trips: TripDecision[] = [];
    const handle = startEventLoopWatchdog({
      // Default heap/lag thresholds; RSS ceiling 1500MB, no boot grace.
      env: { WATCHDOG_RSS_MAX_MB: '1500', WATCHDOG_BOOT_GRACE_MS: '0' },
      // Heap is low (200MB/1536MB) — the burst is native/external memory, so the
      // heap trip is blind to it. RSS reads above the ceiling.
      readHeap: () => ({ usedBytes: 200e6, limitBytes: 1536e6, rssBytes: 1_560e6 }),
      onTrip: d => trips.push(d),
    });
    handle!.sampleNow(); // one sample is enough — acute trip, no consecutive requirement
    expect(trips).toHaveLength(1);
    expect(trips[0]?.reason).toBe('rss');
    expect(handle!.status().trippedReason).toBe('rss');
    expect(handle!.status().lastSample?.rssBytes).toBe(1_560e6);
    handle!.stop();
  });

  it('publishes a snapshot with heap % and breach counters for the health probe', () => {
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_BREACH_SAMPLES: '5', WATCHDOG_HEAP_PCT: '0.95' },
      readHeap: () => ({ usedBytes: 768e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      onTrip: () => {},
    });
    handle!.sampleNow();
    const status = getWatchdogStatus();
    expect(status?.lastSample?.heapPct).toBeCloseTo(0.5, 5);
    expect(status?.tripped).toBe(false);
    expect(status?.config.breachSamples).toBe(5);
    handle!.stop();
  });
});

describe('TRA-1463 — durable trip-reason breadcrumb', () => {
  it('resolveTripLogPath: DATA_DIR → file on the persistent disk, none → null (inert in dev)', () => {
    expect(resolveTripLogPath({ DATA_DIR: '/data' })).toBe(join('/data', 'watchdog-last-trip.json'));
    expect(resolveTripLogPath({ WATCHDOG_TRIP_LOG_PATH: '/tmp/x.json' })).toBe('/tmp/x.json');
    expect(resolveTripLogPath({})).toBeNull(); // no durable disk configured
  });

  it('persists the trip on exit and re-reads it on the next boot as lastTrip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wd-trip-'));
    const path = join(dir, 'watchdog-last-trip.json');
    const env = { WATCHDOG_TRIP_LOG_PATH: path, WATCHDOG_RSS_MAX_MB: '1500', WATCHDOG_BOOT_GRACE_MS: '0' };

    // Boot 1: a native-memory (RSS) burst trips the watchdog → breadcrumb written.
    const first = startEventLoopWatchdog({
      env,
      readHeap: () => ({ usedBytes: 200e6, limitBytes: 1536e6, rssBytes: 1_560e6 }),
      onTrip: () => {}, // don't actually exit the test runner
    });
    first!.sampleNow();
    expect(first!.status().trippedReason).toBe('rss');
    first!.stop();

    const persisted = readLastTrip(env);
    expect(persisted?.reason).toBe('rss');
    expect(persisted?.rssMB).toBe(1560);
    expect(typeof persisted?.uptimeSecAtTrip).toBe('number');

    // Boot 2 (fresh, healthy): surfaces the PRIOR trip as lastTrip so the soak
    // can read WHY the box died without any Render-log access.
    _resetWatchdogForTests();
    const second = startEventLoopWatchdog({
      env: { WATCHDOG_TRIP_LOG_PATH: path, WATCHDOG_BOOT_GRACE_MS: '0' },
      readHeap: () => ({ usedBytes: 100e6, limitBytes: 1536e6, rssBytes: 300e6 }),
      onTrip: () => {},
    });
    second!.sampleNow();
    expect(second!.status().tripped).toBe(false);
    expect(second!.status().lastTrip?.reason).toBe('rss');
    second!.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  it('is inert (no throw, no lastTrip) when no durable disk is configured', () => {
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_RSS_MAX_MB: '1500', WATCHDOG_BOOT_GRACE_MS: '0' }, // no DATA_DIR / path
      readHeap: () => ({ usedBytes: 200e6, limitBytes: 1536e6, rssBytes: 1_560e6 }),
      onTrip: () => {},
    });
    handle!.sampleNow(); // trips, but persistence must no-op
    expect(handle!.status().lastTrip).toBeNull();
    handle!.stop();
  });
});

describe('TRA-1463 — periodic liveness breadcrumb (external-kill attribution)', () => {
  it('resolveLivenessLogPath: DATA_DIR → file on the persistent disk, none → null (inert in dev)', () => {
    expect(resolveLivenessLogPath({ DATA_DIR: '/data' })).toBe(join('/data', 'watchdog-liveness.json'));
    expect(resolveLivenessLogPath({ WATCHDOG_LIVENESS_LOG_PATH: '/tmp/live.json' })).toBe('/tmp/live.json');
    expect(resolveLivenessLogPath({})).toBeNull(); // no durable disk configured
  });

  it('writes a last-known-alive heartbeat that the NEXT boot surfaces as priorLiveness — even with NO watchdog trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wd-live-'));
    const path = join(dir, 'watchdog-liveness.json');
    // Healthy box (no trip): the heartbeat still fires on the first steady-state sample.
    const env = { WATCHDOG_LIVENESS_LOG_PATH: path, WATCHDOG_BOOT_GRACE_MS: '0' };

    const first = startEventLoopWatchdog({
      env,
      readHeap: () => ({ usedBytes: 900e6, limitBytes: 1536e6, rssBytes: 1_450e6, externalBytes: 8e6, arrayBuffersBytes: 2e6 }),
      onTrip: () => {},
    });
    first!.sampleNow();
    first!.stop();

    // Simulate an EXTERNAL kill: the process vanished WITHOUT a watchdog trip, so
    // watchdog-last-trip.json was never written — but the liveness heartbeat was.
    const live = readLastLiveness(env);
    expect(live?.rssMB).toBe(1450);
    expect(live?.externalMB).toBe(8);
    expect(typeof live?.uptimeSec).toBe('number');

    // Boot 2 (fresh): reads the dead instance's last-known RSS/uptime as priorLiveness,
    // while lastTrip stays null — the exact signature of a SIGKILL 137 / SIGTERM death.
    _resetWatchdogForTests();
    const second = startEventLoopWatchdog({
      env: { WATCHDOG_LIVENESS_LOG_PATH: path, WATCHDOG_BOOT_GRACE_MS: '0' },
      readHeap: () => ({ usedBytes: 100e6, limitBytes: 1536e6, rssBytes: 300e6 }),
      onTrip: () => {},
    });
    second!.sampleNow();
    expect(second!.status().lastTrip).toBeNull();
    expect(second!.status().priorLiveness?.rssMB).toBe(1450);
    second!.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  it('is inert (no throw, no priorLiveness) when no durable disk is configured', () => {
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_BOOT_GRACE_MS: '0' }, // no DATA_DIR / liveness path
      readHeap: () => ({ usedBytes: 200e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      onTrip: () => {},
    });
    handle!.sampleNow();
    expect(handle!.status().priorLiveness).toBeNull();
    handle!.stop();
  });

  describe('TRA-4158 — isUnexplainedDeath: a graceful self-restart must NOT also report an external kill', () => {
    const IV = 15_000; // the shipped WATCHDOG_LIVENESS_INTERVAL_MS default

    it('a heartbeat with NO trip beside it is the real external-kill signature', () => {
      expect(isUnexplainedDeath({ lastTripAtMs: null, priorLivenessAtMs: 1_000, livenessIntervalMs: IV })).toBe(true);
    });

    it('no heartbeat at all attributes nothing', () => {
      expect(isUnexplainedDeath({ lastTripAtMs: 5_000, priorLivenessAtMs: null, livenessIntervalMs: IV })).toBe(false);
      expect(isUnexplainedDeath({ lastTripAtMs: null, priorLivenessAtMs: null, livenessIntervalMs: IV })).toBe(false);
    });

    // The regression. Under the old flat 5s threshold every gap here returned true
    // and emitted a spurious external-kill line beside a perfectly good trip record.
    it.each([6_000, 9_900, 14_999, 15_000, 29_999])(
      'stays silent for a %ims stale heartbeat — within one heartbeat interval of the trip',
      (gap) => {
        expect(isUnexplainedDeath({ lastTripAtMs: 0, priorLivenessAtMs: gap, livenessIntervalMs: IV })).toBe(false);
      },
    );

    it('still fires once the gap exceeds two heartbeat intervals', () => {
      expect(isUnexplainedDeath({ lastTripAtMs: 0, priorLivenessAtMs: 30_001, livenessIntervalMs: IV })).toBe(true);
      expect(isUnexplainedDeath({ lastTripAtMs: 0, priorLivenessAtMs: 120_000, livenessIntervalMs: IV })).toBe(true);
    });

    it('is symmetric — a heartbeat written just AFTER the trip record is still the same death', () => {
      expect(isUnexplainedDeath({ lastTripAtMs: 20_000, priorLivenessAtMs: 8_000, livenessIntervalMs: IV })).toBe(false);
    });

    it('scales with the configured interval rather than a hard-coded constant', () => {
      // A 1s heartbeat makes a 6s gap genuinely anomalous; a 60s heartbeat does not.
      expect(isUnexplainedDeath({ lastTripAtMs: 0, priorLivenessAtMs: 6_000, livenessIntervalMs: 1_000 })).toBe(true);
      expect(isUnexplainedDeath({ lastTripAtMs: 0, priorLivenessAtMs: 6_000, livenessIntervalMs: 60_000 })).toBe(false);
    });

    // Pinned to the live bqb1 tape: each of these deaths emitted BOTH the
    // self-restart line and the external-kill line at the same instant.
    it('the four measured bqb1 double-classifications all resolve to "explained"', () => {
      const measured = [
        { boot: '2026-09-01T18:05:07.381Z', tripAt: 1788285892434, liveAt: 1788285882452 }, // 9982ms
        { boot: '2026-08-28T01:49:54.110Z', tripAt: 1000_000, liveAt: 1000_000 - 9_982 },
        { boot: '2026-08-31T13:45:22.411Z', tripAt: 2000_000, liveAt: 2000_000 - 12_400 },
        { boot: '2026-09-01T15:01:45.430Z', tripAt: 3000_000, liveAt: 3000_000 - 7_100 },
      ];
      for (const m of measured) {
        expect(
          isUnexplainedDeath({ lastTripAtMs: m.tripAt, priorLivenessAtMs: m.liveAt, livenessIntervalMs: IV }),
        ).toBe(false);
      }
    });
  });

  it('honours WATCHDOG_LIVENESS_PERSIST=false (no heartbeat written)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wd-live-off-'));
    const path = join(dir, 'watchdog-liveness.json');
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_LIVENESS_LOG_PATH: path, WATCHDOG_LIVENESS_PERSIST: 'false', WATCHDOG_BOOT_GRACE_MS: '0' },
      readHeap: () => ({ usedBytes: 200e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      onTrip: () => {},
    });
    handle!.sampleNow();
    expect(readLastLiveness({ WATCHDOG_LIVENESS_LOG_PATH: path })).toBeNull();
    handle!.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
