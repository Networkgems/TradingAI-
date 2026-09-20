// TRA-4650 — the TRA-4655 choke point proven to BIND, not just to exist.
//
// hard-controls.test.ts already proves each of the seven controls refuses at
// module level. A limiter can exist, be called, be tested — and not bind
// (TRA-3905's arm-census lesson): so these tests drive the REAL order seams —
// `SignalEngine.mirrorLiveOptionOpen` and `SignalEngine.placeTradierEquityBracket`,
// reached via the private-cast seam the other signal-engine tests use — and
// assert a refused order never reaches the broker stub, while an admitted one
// does. Plus the fleet bridge: kill fan-out, born-halted engines, the
// force-close handler, and the realized-P&L feed into the daily lockout.

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import { bindOptionsPnlToEquityBook } from './options-equity-bridge.js';
import {
  bindHardControlsToEngines,
  noteEngineBornForHardControls,
  type HardControlsBridgedEngine,
} from './hard-controls-bridge.js';
import {
  __resetHardControlsForTest,
  engageHardKillSwitch,
  getHardControlsState,
  recordHardControlsPnl,
  releaseHardKillSwitch,
  requestForceCloseAll,
} from './hard-controls.js';

// The smart-open walk retries on its own timers; under fake timers a real call
// would hang the test. The sentinel throw is caught by the seam's own
// try/catch (which voids the open) — reaching the mock IS the assertion.
vi.mock('./tradier-smart-open.js', () => ({
  submitSmartBuyToOpen: vi.fn(async () => {
    throw new Error('SENTINEL-REACHED-BROKER');
  }),
}));
import { submitSmartBuyToOpen } from './tradier-smart-open.js';

// A weekday mid-session instant (2026-09-16 14:00 ET) so the TRA-726
// market-hours gate on the equity seam is open.
const NOW = Date.parse('2026-09-16T18:00:00.000Z');

type EnginePrivates = {
  mode: string;
  tradierLiveClient: unknown;
  tradierLiveEquityClient: unknown;
  liveTradierBalance: unknown;
  managedAccountRatio: number;
  riskPerTrade: number;
  mirrorLiveOptionOpen: (
    opened: unknown,
    surfaceLiveSkip: (reason: string) => void,
    opts?: unknown,
  ) => Promise<boolean>;
  placeTradierEquityBracket: (
    signal: unknown,
    currentPrice: number,
    capScale?: number,
  ) => Promise<{ ok: true; orderId: number | string } | { ok: false; reason: string }>;
};

const priv = (e: SignalEngine) => e as unknown as EnginePrivates;

function liveEngine(): SignalEngine {
  const engine = new SignalEngine(undefined, undefined, undefined);
  priv(engine).mode = 'live';
  return engine;
}

let seq = 0;
function fakeOpened(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `opt-${++seq}`,
    optionSymbol: 'AAPL260918C00100000',
    contracts: 1,
    premiumPaid: 0.5, // notional $50 — inside the $100 canary ceiling on purpose
    openedAt: NOW,
    mode: 'live',
    ...overrides,
  };
}

function fakeSignal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `sig-${++seq}`,
    symbol: 'AAPL',
    type: 'momentum',
    side: 'buy',
    entryPrice: 5,
    stopLoss: 4.75,
    takeProfit: 5.5,
    riskRewardRatio: 2,
    timestamp: NOW,
    mode: 'live',
    ...overrides,
  };
}

/** Small book ⇒ sized notional lands ≤ $150, inside the $300 hard cap. */
const SMALL_BALANCE = { totalCash: 1000, longMarketValue: 0, stockBuyingPower: 1000 };
/** Big book ⇒ sized notional lands in the thousands, over the $300 hard cap. */
const BIG_BALANCE = { totalCash: 100_000, longMarketValue: 0, stockBuyingPower: 100_000 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __resetHardControlsForTest({ dataDir: mkdtempSync(join(tmpdir(), 'hard-wiring-')), nowMs: NOW });
  vi.mocked(submitSmartBuyToOpen).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-4650 — choke point bound at the live-options open seam', () => {
  function optionsSeamEngine(): { engine: SignalEngine; skips: string[] } {
    const engine = liveEngine();
    priv(engine).tradierLiveClient = {};
    const skips: string[] = [];
    return { engine, skips };
  }

  it('fleet kill switch blocks the open before the broker is touched', async () => {
    const { engine, skips } = optionsSeamEngine();
    engageHardKillSwitch('test', 'drill', NOW);
    const ok = await priv(engine).mirrorLiveOptionOpen(fakeOpened(), (r) => skips.push(r));
    expect(ok).toBe(false);
    expect(skips.join(' ')).toContain('kill_switch_engaged');
    expect(submitSmartBuyToOpen).not.toHaveBeenCalled();
  });

  it('a stale quote (>5s) blocks the open', async () => {
    const { engine, skips } = optionsSeamEngine();
    const ok = await priv(engine).mirrorLiveOptionOpen(
      fakeOpened({ openedAt: NOW - 6_000 }),
      (r) => skips.push(r),
    );
    expect(ok).toBe(false);
    expect(skips.join(' ')).toContain('stale_quote');
    expect(submitSmartBuyToOpen).not.toHaveBeenCalled();
  });

  it('the daily loss lockout blocks the open', async () => {
    const { engine, skips } = optionsSeamEngine();
    recordHardControlsPnl(-600, NOW);
    const ok = await priv(engine).mirrorLiveOptionOpen(fakeOpened(), (r) => skips.push(r));
    expect(ok).toBe(false);
    expect(skips.join(' ')).toContain('daily_loss_lockout');
    expect(submitSmartBuyToOpen).not.toHaveBeenCalled();
  });

  it('an admitted open reaches the broker; the SAME row id re-admitted is a duplicate', async () => {
    const { engine, skips } = optionsSeamEngine();
    const opened = fakeOpened();
    // TRA-4752 — the sleeve is now load-bearing at this seam, one gate BELOW the
    // hard controls: an open carrying no readable sleeve fails closed
    // (`sleeve_unattributable`) and never reaches the submit, which would make
    // this test's `toHaveBeenCalledTimes(1)` fail for a reason that has nothing
    // to do with the choke point it grades. `single_leg_otm` is deliberately off
    // the stand-down roster, so it admits — see `sleeve-stand-down.ts`. Every
    // production caller of this seam passes a sleeve; this fixture did not.
    const SLEEVE = { sleeve: 'single_leg_otm' as const };
    const first = await priv(engine).mirrorLiveOptionOpen(opened, (r) => skips.push(r), SLEEVE);
    // The sentinel broker mock throws, so the seam voids the open — but it was
    // REACHED, which is what "admitted" means at this layer.
    expect(first).toBe(false);
    expect(submitSmartBuyToOpen).toHaveBeenCalledTimes(1);
    expect(skips.join(' ')).not.toContain('hard controls REFUSED');
    expect(skips.join(' ')).not.toContain('sleeve stand-down REFUSED');

    skips.length = 0;
    const second = await priv(engine).mirrorLiveOptionOpen({ ...opened }, (r) => skips.push(r), SLEEVE);
    expect(second).toBe(false);
    expect(skips.join(' ')).toContain('duplicate_order');
    expect(submitSmartBuyToOpen).toHaveBeenCalledTimes(1);
  });
});

describe('TRA-4650 — choke point bound at the live-equity submit seam', () => {
  function equitySeamEngine(balance: Record<string, unknown>): {
    engine: SignalEngine;
    submitBracketOrder: ReturnType<typeof vi.fn>;
  } {
    const engine = liveEngine();
    const submitBracketOrder = vi.fn(async () => ({ id: 4650, status: 'open' }));
    priv(engine).tradierLiveEquityClient = {
      submitBracketOrder,
      waitForOrderTerminalStatus: vi.fn(async () => null),
    };
    priv(engine).liveTradierBalance = balance;
    priv(engine).managedAccountRatio = 1;
    priv(engine).riskPerTrade = 0.01;
    return { engine, submitBracketOrder };
  }

  it('fleet kill switch blocks the bracket before the broker is touched', async () => {
    const { engine, submitBracketOrder } = equitySeamEngine(SMALL_BALANCE);
    engageHardKillSwitch('test', 'drill', NOW);
    const r = await priv(engine).placeTradierEquityBracket(fakeSignal(), 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('kill_switch_engaged');
    expect(submitBracketOrder).not.toHaveBeenCalled();
  });

  it('a stale signal fire instant (>5s) blocks the bracket', async () => {
    const { engine, submitBracketOrder } = equitySeamEngine(SMALL_BALANCE);
    const r = await priv(engine).placeTradierEquityBracket(fakeSignal({ timestamp: NOW - 6_000 }), 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('stale_quote');
    expect(submitBracketOrder).not.toHaveBeenCalled();
  });

  it('a sized notional over $300 is refused — the cap binds on the RESOLVED order, not the request', async () => {
    const { engine, submitBracketOrder } = equitySeamEngine(BIG_BALANCE);
    const r = await priv(engine).placeTradierEquityBracket(
      fakeSignal({ entryPrice: 100, stopLoss: 95, takeProfit: 110 }),
      100,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('max_order_notional');
    expect(submitBracketOrder).not.toHaveBeenCalled();
  });

  it('an admitted bracket reaches the broker; the SAME signal id resubmitted is a duplicate', async () => {
    const { engine, submitBracketOrder } = equitySeamEngine(SMALL_BALANCE);
    const signal = fakeSignal();
    const first = await priv(engine).placeTradierEquityBracket(signal, 5);
    expect(first.ok).toBe(true);
    expect(submitBracketOrder).toHaveBeenCalledTimes(1);

    const second = await priv(engine).placeTradierEquityBracket({ ...signal }, 5);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('duplicate_order');
    expect(submitBracketOrder).toHaveBeenCalledTimes(1);
  });
});

describe('TRA-4650 — the fleet bridge', () => {
  function fakeEngine(): HardControlsBridgedEngine & {
    engageKillSwitch: ReturnType<typeof vi.fn>;
    releaseKillSwitch: ReturnType<typeof vi.fn>;
    forceFlattenLiveOptionsForHardControls: ReturnType<typeof vi.fn>;
  } {
    let engaged = false;
    return {
      isKillSwitchEngaged: () => engaged,
      engageKillSwitch: vi.fn(() => {
        engaged = true;
      }),
      releaseKillSwitch: vi.fn(() => {
        engaged = false;
      }),
      forceFlattenLiveOptionsForHardControls: vi.fn(async () => ({
        closed: 2,
        errors: ['XYZ: rejected — broker said no'],
      })),
    };
  }

  it('engage fans out to every engine; release frees ONLY bridge-engaged engines', () => {
    const a = fakeEngine();
    const b = fakeEngine();
    b.engageKillSwitch('user own halt'); // the user's own TRA-526 kill, pre-existing
    b.engageKillSwitch.mockClear();
    bindHardControlsToEngines(() => [
      { username: 'a', engine: a },
      { username: 'b', engine: b },
    ]);

    engageHardKillSwitch('cto', 'fleet drill', NOW);
    expect(a.engageKillSwitch).toHaveBeenCalledTimes(1);
    expect(String(a.engageKillSwitch.mock.calls[0][0])).toContain('fleet hard kill switch');
    expect(b.engageKillSwitch).not.toHaveBeenCalled(); // already killed — left alone

    releaseHardKillSwitch();
    expect(a.releaseKillSwitch).toHaveBeenCalledTimes(1);
    expect(b.releaseKillSwitch).not.toHaveBeenCalled(); // the user's own halt STANDS
  });

  it('an engine born under an engaged persisted latch starts halted', () => {
    engageHardKillSwitch('cto', 'overnight latch', NOW);
    const late = fakeEngine();
    noteEngineBornForHardControls(late);
    expect(late.engageKillSwitch).toHaveBeenCalledTimes(1);
    expect(late.isKillSwitchEngaged()).toBe(true);
  });

  it('force-close-all runs the registered fleet handler and reports per-book results', async () => {
    const a = fakeEngine();
    bindHardControlsToEngines(() => [{ username: 'a', engine: a }]);
    const r = await requestForceCloseAll('cto', 'drill', NOW);
    const fleet = r.handlers.find((h) => h.name === 'live-option-books');
    expect(fleet).toBeDefined();
    expect(fleet!.closed).toBe(2);
    expect(fleet!.errors).toEqual(['a: XYZ: rejected — broker said no']);
    expect(a.forceFlattenLiveOptionsForHardControls).toHaveBeenCalledTimes(1);
    // Force-close engages the kill switch first; the observer fanned it out.
    expect(a.isKillSwitchEngaged()).toBe(true);
  });
});

describe('TRA-4650 — realized LIVE P&L feeds the daily lockout (control 2)', () => {
  function boundSink(): { sink: (mode: string, delta: number) => void; credit: ReturnType<typeof vi.fn> } {
    let sink: ((mode: string, delta: number) => void) | undefined;
    const optionsAccount = {
      setRealizedPnlSink: (s: (mode: string, delta: number) => void) => {
        sink = s;
      },
      setEquityBasisProvider: () => {},
    };
    const credit = vi.fn();
    const equityBook = {
      creditRealizedOptionsPnl: credit,
      getState: () => ({ totalEquity: 2000 }),
    };
    bindOptionsPnlToEquityBook(optionsAccount as never, equityBook as never);
    return { sink: sink!, credit };
  }

  it('live deltas accrue to the ET day and latch the lockout at −$500', () => {
    const { sink } = boundSink();
    sink('live', -200);
    sink('live', -350);
    const s = getHardControlsState(NOW);
    expect(s.dayLoss.realizedPnlUsd).toBe(-550);
    expect(s.dayLoss.lockedOut).toBe(true);
  });

  it('a NON-FINITE live delta latches the day unreadable (fail closed)', () => {
    const { sink } = boundSink();
    sink('live', Number.NaN);
    expect(getHardControlsState(NOW).dayLoss.unreadable).toBe(true);
  });

  it('demo deltas still credit the equity book and never touch the lockout', () => {
    const { sink, credit } = boundSink();
    sink('demo', 125);
    expect(credit).toHaveBeenCalledWith(125);
    expect(getHardControlsState(NOW).dayLoss.realizedPnlUsd).toBe(0);
  });
});
