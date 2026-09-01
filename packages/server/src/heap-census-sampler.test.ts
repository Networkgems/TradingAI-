import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  startHeapCensusSampler,
  stopHeapCensusSampler,
  getHeapCensusStatus,
  __resetHeapCensusForTest,
} from './heap-census-sampler.js';
import type { CensusSubject } from './heap-retainer-census.js';

// TRA-4158 — the sampler's failure modes are all silent. A sampler that stopped
// firing, that captured its subject list once at boot, or that got installed
// twice all produce a route payload that looks entirely ordinary; only the
// series is wrong, and the series is the whole evidence. Each case below pins
// one of those.

afterEach(() => {
  __resetHeapCensusForTest();
  vi.useRealTimers();
  delete process.env.HEAP_CENSUS_ENABLED;
});

class EngineLike {
  candleCache = new Map<string, number[]>();
}

describe('startHeapCensusSampler', () => {
  it('publishes a boot baseline immediately rather than an empty tape for the first interval', () => {
    // A box that restarts mid-session still owes the next read something to
    // difference against; five blank minutes at boot is where a truncated
    // series starts.
    const engine = new EngineLike();
    startHeapCensusSampler({
      subjects: () => [{ klass: 'signalEngine', target: engine }],
      intervalMs: 60_000,
    });
    const status = getHeapCensusStatus();
    expect(status.enabled).toBe(true);
    expect(status.samples).toBe(1);
  });

  it('re-enumerates its subjects every sample, so a context created later is counted', () => {
    // `ensureUserContext` materialises contexts lazily. A subject list captured
    // once at boot would under-count every one of them — and under-counting
    // reads as a healthy fleet.
    vi.useFakeTimers();
    const contexts: CensusSubject[] = [{ klass: 'signalEngine', target: new EngineLike() }];
    startHeapCensusSampler({ subjects: () => contexts, intervalMs: 1000 });
    expect(getHeapCensusStatus().tape[0].subjects).toBe(1);

    contexts.push({ klass: 'signalEngine', target: new EngineLike() });
    vi.advanceTimersByTime(1000);

    const tape = getHeapCensusStatus().tape;
    expect(tape).toHaveLength(2);
    expect(tape[1].subjects).toBe(2);
  });

  it('is idempotent — a double install must not double the cadence', () => {
    vi.useFakeTimers();
    const engine = new EngineLike();
    const subjects = () => [{ klass: 'signalEngine', target: engine }];
    startHeapCensusSampler({ subjects, intervalMs: 1000 });
    startHeapCensusSampler({ subjects, intervalMs: 1000 });
    vi.advanceTimersByTime(3000);
    // 1 boot baseline + 3 ticks. A doubled interval would give 7.
    expect(getHeapCensusStatus().samples).toBe(4);
  });

  it('stops firing after stop(), and says so', () => {
    vi.useFakeTimers();
    const engine = new EngineLike();
    const handle = startHeapCensusSampler({
      subjects: () => [{ klass: 'signalEngine', target: engine }],
      intervalMs: 1000,
    });
    vi.advanceTimersByTime(1000);
    const before = getHeapCensusStatus().samples;
    handle?.stop();
    vi.advanceTimersByTime(10_000);
    const after = getHeapCensusStatus();
    expect(after.samples).toBe(before);
    // A stopped sampler serving a stale tape must not read as a live one.
    expect(after.enabled).toBe(false);
  });

  it('survives a subject enumeration that throws instead of taking the process down', () => {
    vi.useFakeTimers();
    let calls = 0;
    startHeapCensusSampler({
      subjects: () => {
        calls += 1;
        throw new Error('context registry exploded');
      },
      intervalMs: 1000,
    });
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(calls).toBeGreaterThan(1);
    // The failure is visible on the route, not as a crash — and it must be
    // distinguishable from a sampler that was simply never started, which is
    // the other way `live` comes back null.
    const status = getHeapCensusStatus();
    expect(status.samples).toBe(0);
    expect(status.live).toBeNull();
    expect(status.liveError).toMatch(/context registry exploded/);
  });

  it('HEAP_CENSUS_ENABLED=false leaves nothing installed', () => {
    process.env.HEAP_CENSUS_ENABLED = 'false';
    const handle = startHeapCensusSampler({
      subjects: () => [{ klass: 'signalEngine', target: new EngineLike() }],
    });
    expect(handle).toBeNull();
    const status = getHeapCensusStatus();
    expect(status.enabled).toBe(false);
    expect(status.live).toBeNull();
    expect(status.liveError).toBeNull(); // switched off, not broken
    expect(status.samples).toBe(0);
  });
});

describe('getHeapCensusStatus', () => {
  it('reports the tape span so a gap in the series is self-evident', () => {
    let clock = 1_000_000;
    const engine = new EngineLike();
    vi.useFakeTimers();
    startHeapCensusSampler({
      subjects: () => [{ klass: 'signalEngine', target: engine }],
      intervalMs: 1000,
      now: () => clock,
    });
    clock += 3_600_000; // the sampler fired late — an hour late
    vi.advanceTimersByTime(1000);
    expect(getHeapCensusStatus().spanSec).toBe(3600);
  });

  it('keeps the deep sum off unless the caller asks for it', () => {
    const engine = new EngineLike();
    engine.candleCache.set('AAPL', [1, 2, 3]);
    startHeapCensusSampler({
      subjects: () => [{ klass: 'signalEngine', target: engine }],
      intervalMs: 60_000,
    });

    const shallow = getHeapCensusStatus();
    expect(shallow.deep).toBe(false);
    expect(shallow.live?.find(r => r.name === 'signalEngine.candleCache')?.nested).toBeNull();

    const deep = getHeapCensusStatus({ deep: true });
    expect(deep.deep).toBe(true);
    expect(deep.live?.find(r => r.name === 'signalEngine.candleCache')?.nested).toBe(3);
  });

  it('answers on a never-started sampler instead of throwing', () => {
    stopHeapCensusSampler();
    const status = getHeapCensusStatus();
    expect(status).toMatchObject({ enabled: false, samples: 0, spanSec: 0, live: null });
    expect(status.trends).toEqual([]);
  });
});
