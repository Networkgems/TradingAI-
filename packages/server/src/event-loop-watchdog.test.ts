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
  _resetWatchdogForTests,
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
    const c = resolveConfig({});
    expect(c.enabled).toBe(true);
    expect(c.restartEnabled).toBe(true);
    expect(c).toEqual(DEFAULT_WATCHDOG);
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

  it('TRA-1374 — RSS ceiling defaults to 1900MB, is env-tunable (MB→bytes), clamped, and 0 disables', () => {
    expect(resolveConfig({}).rssMaxBytes).toBe(1_900 * 1e6);
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: '3500' }).rssMaxBytes).toBe(3_500 * 1e6);
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: '0' }).rssMaxBytes).toBe(0); // explicit disable
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: '-5' }).rssMaxBytes).toBe(0); // non-positive disables
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: '100' }).rssMaxBytes).toBe(256 * 1e6); // clamped up
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: '999999' }).rssMaxBytes).toBe(32_768 * 1e6); // clamped down
    expect(resolveConfig({ WATCHDOG_RSS_MAX_MB: 'abc' }).rssMaxBytes).toBe(0); // non-numeric disables
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
