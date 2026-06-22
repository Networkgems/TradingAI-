// TRA-1003 — the scheduled external-intel trigger. The contract that matters for
// landing this OFF safely: a tick with ENABLE_EXTERNAL_INTEL unset must NOT build
// deps, must NOT touch the LLM / public sources, and must NOT run a cycle. With
// the flag on it builds deps and runs exactly one cycle. Fully deterministic —
// the deps builder and the cycle runner are injected spies, no network/LLM.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runExternalIntelTick,
  resolveIntervalMs,
  DEFAULT_INTERVAL_MS,
  startExternalIntelSchedule,
  type ExternalIntelTickDeps,
} from './external-intel-scheduler.js';
import type { ExternalIntelDeps, ExternalIntelCycleResult } from './external-intel.js';

function fakeDeps(): ExternalIntelDeps {
  return {
    sources: [{ sourceKey: 'stub', async fetch() { return []; } }],
    extractor: async () => [],
    pipeline: { baseConfig: {}, runBacktest: async () => ({
      sharpe: 0, expectancy: 0, profitFactor: 0, maxDrawdown: 0, tradeCount: 0,
    }) },
  };
}

function fakeResult(): ExternalIntelCycleResult {
  return {
    enabled: true, fetched: 0, ingested: 0, duplicates: 0,
    candidates: 0, rejected: 0, enqueued: [], attributed: 0,
  };
}

beforeEach(() => {
  delete process.env['ENABLE_EXTERNAL_INTEL'];
  delete process.env['EXTERNAL_INTEL_INTERVAL_MS'];
});
afterEach(() => {
  delete process.env['ENABLE_EXTERNAL_INTEL'];
  delete process.env['EXTERNAL_INTEL_INTERVAL_MS'];
  vi.restoreAllMocks();
});

describe('runExternalIntelTick — flag gate', () => {
  it('does NOT build deps or run a cycle when the flag is off', async () => {
    const buildDeps = vi.fn(() => fakeDeps());
    const runCycle = vi.fn(async () => fakeResult());
    const inject: ExternalIntelTickDeps = { buildDeps, runCycle };

    const outcome = await runExternalIntelTick(1_700_000_000_000, {}, inject);

    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toBe('disabled');
    expect(buildDeps).not.toHaveBeenCalled();
    expect(runCycle).not.toHaveBeenCalled();
  });

  it('builds deps and runs exactly one cycle when the flag is on', async () => {
    const buildDeps = vi.fn(() => fakeDeps());
    const runCycle = vi.fn(async () => fakeResult());
    const env = { ENABLE_EXTERNAL_INTEL: '1' } as NodeJS.ProcessEnv;

    const outcome = await runExternalIntelTick(1_700_000_000_000, env, { buildDeps, runCycle });

    expect(outcome.ran).toBe(true);
    expect(buildDeps).toHaveBeenCalledTimes(1);
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(runCycle).toHaveBeenCalledWith(expect.anything(), 1_700_000_000_000, env);
  });

  it('skips cleanly (no cycle) when enabled but no deps are configured', async () => {
    const buildDeps = vi.fn(() => null);
    const runCycle = vi.fn(async () => fakeResult());
    const env = { ENABLE_EXTERNAL_INTEL: '1' } as NodeJS.ProcessEnv;

    const outcome = await runExternalIntelTick(1, env, { buildDeps, runCycle });

    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toBe('no-deps');
    expect(buildDeps).toHaveBeenCalledTimes(1);
    expect(runCycle).not.toHaveBeenCalled();
  });
});

describe('resolveIntervalMs', () => {
  it('defaults to hourly with no env override', () => {
    expect(resolveIntervalMs({})).toBe(DEFAULT_INTERVAL_MS);
  });
  it('honours a valid override', () => {
    expect(resolveIntervalMs({ EXTERNAL_INTEL_INTERVAL_MS: '120000' })).toBe(120_000);
  });
  it('clamps below the 60s floor', () => {
    expect(resolveIntervalMs({ EXTERNAL_INTEL_INTERVAL_MS: '5000' })).toBe(60_000);
  });
  it('falls back to the default on garbage / non-positive input', () => {
    expect(resolveIntervalMs({ EXTERNAL_INTEL_INTERVAL_MS: 'nope' })).toBe(DEFAULT_INTERVAL_MS);
    expect(resolveIntervalMs({ EXTERNAL_INTEL_INTERVAL_MS: '-5' })).toBe(DEFAULT_INTERVAL_MS);
  });
});

describe('startExternalIntelSchedule', () => {
  it('arms a timer that fires the tick, and stop() halts further ticks', () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn(async () => ({ ran: false as const, reason: 'disabled' as const }));
      const handle = startExternalIntelSchedule({
        env: {} as NodeJS.ProcessEnv,
        intervalMs: 1000,
        now: () => 42,
        tick,
      });

      expect(tick).not.toHaveBeenCalled(); // setInterval doesn't fire immediately
      vi.advanceTimersByTime(2500);
      expect(tick).toHaveBeenCalledTimes(2);
      expect(tick).toHaveBeenCalledWith(42, expect.anything());

      handle.stop();
      vi.advanceTimersByTime(5000);
      expect(tick).toHaveBeenCalledTimes(2); // no more ticks after stop()
    } finally {
      vi.useRealTimers();
    }
  });
});
