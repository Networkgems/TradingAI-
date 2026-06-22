// TRA-1004 — the autonomous demo trading loop. The contract that matters for
// landing this OFF safely: a tick with ENABLE_AUTONOMOUS_DEMO_LOOP unset must
// NOT enumerate books and must NOT drive any engine. With the flag on it drives
// crypto on every book and stocks/options only in-session, and SKIPS any book
// the autopilot has halted (so a halt demonstrably stops the loop). Fully
// deterministic — the book enumerator and market-open check are injected.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  runAutonomousDemoTick,
  resolveAutonomousLoopIntervalMs,
  isAutonomousDemoLoopEnabled,
  startAutonomousDemoSchedule,
  getAutonomousDemoStatus,
  buildAutonomousDemoLoopReport,
  resetAutonomousDemoStatusForTest,
  DEFAULT_INTERVAL_MS,
  type DemoBookEngine,
  type AutonomousDemoLoopDeps,
} from './autonomous-demo-loop.js';

/** A fully-spied fake demo book. */
function fakeBook(over: Partial<DemoBookEngine> & { username: string }): DemoBookEngine {
  return {
    username: over.username,
    isHalted: over.isHalted ?? (() => false),
    haltReason: over.haltReason ?? (() => null),
    riskThrottle: over.riskThrottle ?? (() => 1),
    regime: over.regime ?? (() => null),
    recentAutopilotActions: over.recentAutopilotActions ?? (() => []),
    openStocks: over.openStocks ?? (() => 0),
    openCrypto: over.openCrypto ?? (() => 0),
    driveStocks: over.driveStocks ?? (() => {}),
    driveCrypto: over.driveCrypto ?? (() => {}),
  };
}

beforeEach(() => {
  delete process.env['ENABLE_AUTONOMOUS_DEMO_LOOP'];
  delete process.env['AUTONOMOUS_DEMO_LOOP_INTERVAL_MS'];
  resetAutonomousDemoStatusForTest();
});
afterEach(() => {
  delete process.env['ENABLE_AUTONOMOUS_DEMO_LOOP'];
  delete process.env['AUTONOMOUS_DEMO_LOOP_INTERVAL_MS'];
  vi.restoreAllMocks();
});

describe('isAutonomousDemoLoopEnabled', () => {
  it('is off by default and on for truthy spellings', () => {
    expect(isAutonomousDemoLoopEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(isAutonomousDemoLoopEnabled({ ENABLE_AUTONOMOUS_DEMO_LOOP: v })).toBe(true);
    }
    expect(isAutonomousDemoLoopEnabled({ ENABLE_AUTONOMOUS_DEMO_LOOP: '0' })).toBe(false);
    expect(isAutonomousDemoLoopEnabled({ ENABLE_AUTONOMOUS_DEMO_LOOP: 'off' })).toBe(false);
  });
});

describe('runAutonomousDemoTick — flag gate (zero cost off)', () => {
  it('does NOT enumerate books or drive any engine when the flag is off', async () => {
    const listBooks = vi.fn((): DemoBookEngine[] => []);
    const isStocksMarketOpen = vi.fn(() => true);
    const deps: AutonomousDemoLoopDeps = { listBooks, isStocksMarketOpen };

    const outcome = await runAutonomousDemoTick(1_700_000_000_000, {}, deps);

    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toBe('disabled');
    expect(listBooks).not.toHaveBeenCalled();
    expect(isStocksMarketOpen).not.toHaveBeenCalled();
  });
});

describe('runAutonomousDemoTick — driving', () => {
  const ON = { ENABLE_AUTONOMOUS_DEMO_LOOP: '1' } as NodeJS.ProcessEnv;

  it('drives crypto on every book and stocks only when the market is open', async () => {
    const driveStocks = vi.fn();
    const driveCrypto = vi.fn();
    const book = fakeBook({ username: 'u1', driveStocks, driveCrypto });
    const deps: AutonomousDemoLoopDeps = {
      listBooks: () => [book],
      isStocksMarketOpen: () => true,
    };

    const outcome = await runAutonomousDemoTick(1, ON, deps);

    expect(driveCrypto).toHaveBeenCalledTimes(1);
    expect(driveStocks).toHaveBeenCalledTimes(1);
    expect(outcome.ran).toBe(true);
    expect(outcome.booksDriven).toBe(1);
    expect(outcome.decisions[0]).toMatchObject({ username: 'u1', droveStocks: true, droveCrypto: true });
  });

  it('skips stocks (but still drives crypto) when the equity market is closed', async () => {
    const driveStocks = vi.fn();
    const driveCrypto = vi.fn();
    const book = fakeBook({ username: 'u1', driveStocks, driveCrypto });
    const deps: AutonomousDemoLoopDeps = {
      listBooks: () => [book],
      isStocksMarketOpen: () => false,
    };

    const outcome = await runAutonomousDemoTick(1, ON, deps);

    expect(driveCrypto).toHaveBeenCalledTimes(1);
    expect(driveStocks).not.toHaveBeenCalled();
    expect(outcome.decisions[0]).toMatchObject({ droveStocks: false, droveCrypto: true });
  });

  it('autopilot HALT demonstrably stops the loop — a halted book drives nothing', async () => {
    const driveStocks = vi.fn();
    const driveCrypto = vi.fn();
    const book = fakeBook({
      username: 'halted',
      isHalted: () => true,
      haltReason: () => 'daily drawdown −8% — autopilot halted',
      driveStocks,
      driveCrypto,
    });
    const deps: AutonomousDemoLoopDeps = {
      listBooks: () => [book],
      isStocksMarketOpen: () => true,
    };

    const outcome = await runAutonomousDemoTick(1, ON, deps);

    expect(driveStocks).not.toHaveBeenCalled();
    expect(driveCrypto).not.toHaveBeenCalled();
    expect(outcome.booksDriven).toBe(0);
    expect(outcome.decisions[0]).toMatchObject({
      halted: true,
      haltReason: 'daily drawdown −8% — autopilot halted',
      droveStocks: false,
      droveCrypto: false,
    });
  });

  it('a throwing drive is contained — other books still run, loop never rejects', async () => {
    const good = fakeBook({ username: 'good', driveCrypto: vi.fn() });
    const bad = fakeBook({
      username: 'bad',
      driveCrypto: () => {
        throw new Error('feed blew up');
      },
    });
    const deps: AutonomousDemoLoopDeps = {
      listBooks: () => [bad, good],
      isStocksMarketOpen: () => false,
    };

    const outcome = await runAutonomousDemoTick(1, ON, deps);

    expect(outcome.ran).toBe(true);
    // 'bad' threw before flipping droveCrypto; 'good' still drove.
    expect(outcome.booksDriven).toBe(1);
    expect(outcome.decisions.find((d) => d.username === 'good')?.droveCrypto).toBe(true);
  });

  it('records throttle + regime per book for the health/EOD surface', async () => {
    const book = fakeBook({
      username: 'u1',
      riskThrottle: () => 0.5,
      regime: () => 'high_vol',
      recentAutopilotActions: () => [
        { kind: 'throttle', trigger: 'regime_shift', reason: 'high vol', throttleMultiplier: 0.5 },
      ],
    });
    const deps: AutonomousDemoLoopDeps = {
      listBooks: () => [book],
      isStocksMarketOpen: () => true,
    };

    await runAutonomousDemoTick(1, ON, deps);
    const report = buildAutonomousDemoLoopReport(ON);

    expect(report.throttles).toEqual([{ username: 'u1', riskThrottle: 0.5 }]);
    expect(report.halts).toEqual([]);
    expect(report.lastBooksDriven).toBe(1);
  });
});

describe('getAutonomousDemoStatus', () => {
  it('reflects ticks run + last tick time after a run', async () => {
    const ON = { ENABLE_AUTONOMOUS_DEMO_LOOP: '1' } as NodeJS.ProcessEnv;
    const deps: AutonomousDemoLoopDeps = {
      listBooks: () => [fakeBook({ username: 'u1' })],
      isStocksMarketOpen: () => true,
    };
    await runAutonomousDemoTick(1_700_000_000_000, ON, deps);

    const st = getAutonomousDemoStatus(ON);
    expect(st.enabled).toBe(true);
    expect(st.ticksRun).toBe(1);
    expect(st.lastTickAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(st.lastOutcome?.booksDriven).toBe(1);
  });

  it('a disabled tick does not record into recent', async () => {
    const deps: AutonomousDemoLoopDeps = {
      listBooks: () => [fakeBook({ username: 'u1' })],
      isStocksMarketOpen: () => true,
    };
    await runAutonomousDemoTick(1, {}, deps);
    const st = getAutonomousDemoStatus({});
    expect(st.enabled).toBe(false);
    expect(st.ticksRun).toBe(0);
    expect(st.recent).toEqual([]);
  });
});

describe('resolveAutonomousLoopIntervalMs', () => {
  it('defaults to per-minute with no override', () => {
    expect(resolveAutonomousLoopIntervalMs({})).toBe(DEFAULT_INTERVAL_MS);
  });
  it('honours a valid override', () => {
    expect(resolveAutonomousLoopIntervalMs({ AUTONOMOUS_DEMO_LOOP_INTERVAL_MS: '30000' })).toBe(30_000);
  });
  it('clamps below the 15s floor (no sub-minute HFT)', () => {
    expect(resolveAutonomousLoopIntervalMs({ AUTONOMOUS_DEMO_LOOP_INTERVAL_MS: '2000' })).toBe(15_000);
  });
  it('falls back to the default on garbage / non-positive input', () => {
    expect(resolveAutonomousLoopIntervalMs({ AUTONOMOUS_DEMO_LOOP_INTERVAL_MS: 'nope' })).toBe(DEFAULT_INTERVAL_MS);
    expect(resolveAutonomousLoopIntervalMs({ AUTONOMOUS_DEMO_LOOP_INTERVAL_MS: '-5' })).toBe(DEFAULT_INTERVAL_MS);
  });
});

describe('startAutonomousDemoSchedule', () => {
  it('arms a timer that fires the tick, and stop() halts further ticks', () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn(async () => ({
        ran: false as const,
        reason: 'disabled' as const,
        tickAtMs: 42,
        stocksMarketOpen: false,
        booksDriven: 0,
        decisions: [],
      }));
      const handle = startAutonomousDemoSchedule({
        env: {} as NodeJS.ProcessEnv,
        intervalMs: 1000,
        now: () => 42,
        tick,
      });

      expect(tick).not.toHaveBeenCalled(); // setInterval doesn't fire immediately
      vi.advanceTimersByTime(2500);
      expect(tick).toHaveBeenCalledTimes(2);
      expect(tick).toHaveBeenCalledWith(42, expect.anything(), undefined);

      handle.stop();
      vi.advanceTimersByTime(5000);
      expect(tick).toHaveBeenCalledTimes(2); // no more ticks after stop()
    } finally {
      vi.useRealTimers();
    }
  });
});
