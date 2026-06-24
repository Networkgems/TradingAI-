import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveConfig,
  evaluateSample,
  startEventLoopWatchdog,
  getWatchdogStatus,
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
    const c = cfg({ breachSamples: 2, lagMs: 2000 });
    const state = freshState();
    const laggy = sample({ lagMeanMs: 3500, lagMaxMs: 9000, heapPct: 0.1 });
    expect(evaluateSample(laggy, state, c).trip).toBe(false);
    const d: TripDecision = evaluateSample(laggy, state, c);
    expect(d.trip).toBe(true);
    expect(d.reason).toBe('lag');
    expect(d.detail).toContain('event-loop');
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
      env: { WATCHDOG_BREACH_SAMPLES: '2', WATCHDOG_HEAP_PCT: '0.9' },
      readHeap: () => ({ usedBytes: 1500e6, limitBytes: 1536e6 }),
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
      env: { WATCHDOG_BREACH_SAMPLES: '1', WATCHDOG_HEAP_PCT: '0.9', WATCHDOG_RESTART_ENABLED: 'false' },
      readHeap: () => ({ usedBytes: 1500e6, limitBytes: 1536e6 }),
      onTrip: d => trips.push(d),
    });
    handle!.sampleNow();
    expect(trips).toHaveLength(0); // restart disabled ⇒ onTrip not invoked
    expect(handle!.status().tripped).toBe(true);
    handle!.stop();
  });

  it('publishes a snapshot with heap % and breach counters for the health probe', () => {
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_BREACH_SAMPLES: '5', WATCHDOG_HEAP_PCT: '0.95' },
      readHeap: () => ({ usedBytes: 768e6, limitBytes: 1536e6 }),
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
