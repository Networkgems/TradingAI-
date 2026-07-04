import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Candle, Sma200Signal } from '@trading-app/shared';
import { SignalEngine } from './signal-engine.js';
import { isLiveEntryGatePassed, PASSED_LIVE_ENTRIES } from './capital-gate-manifest.js';
import * as yahooFeed from './yahoo-feed.js';

// Inside an ET trading window: 10:00 AM ET on a Tuesday → 14:00 UTC during EDT.
// Picked so isStockMarketOpen() and the demo auto-trading gate are both OPEN,
// proving the capital gate — not a closed market — is what suppresses the open.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

const DAY = 86_400_000;

/**
 * Port of the engine-side `pullbackSeries` fixture (packages/engine
 * sma200-signals.test.ts): a 250-bar daily series whose final bar is a
 * decisive up-close above both prior highs after a pullback to a rising
 * 200-SMA — i.e. it fires a real `sma200_pullback` signal through
 * `evaluateSma200`. 250 bars exactly meets SMA200_MIN_BARS.
 */
function pullbackSeries(): Candle[] {
  const flat = (n: number, p: number): number[] => new Array<number>(n).fill(p);
  const base = flat(100, 70);
  const ramp = Array.from({ length: 144 }, (_, i) => 90 + i * 0.13); // 90 → ~108.6
  const tail = [107, 104, 101, 99, 98, 108];
  const closes = [...base, ...ramp, ...tail]; // 250 bars
  const lows: number[] = [];
  lows[closes.length - 2] = 91; // t-1 wicks down to the 200-SMA (≈92) — the touch
  return closes.map((close, i) => {
    const open = i > 0 ? closes[i - 1] : close;
    const low = lows[i] ?? Math.min(open, close) - 1;
    const high = Math.max(open, close) + 1;
    return { symbol: 'TEST', timestamp: i * DAY, open, high, low, close, volume: 1_000_000 };
  });
}

function makePullbackSignal(overrides: Partial<Sma200Signal> = {}): Sma200Signal {
  return {
    id: 'sig-pullback',
    symbol: 'TEST',
    type: 'sma200_pullback',
    side: 'buy',
    entryPrice: 108,
    stopLoss: 90,
    takeProfit: 144,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    mode: 'live',
    rsi: 60,
    distAtr: 1.5,
    trendQuality: true,
    goldenCross: true,
    context: 'continuation — pullback-to-200 bounce',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TRA-819 — capital-gate manifest', () => {
  it('is empty: no stock strategy has passed the OOS gate yet', () => {
    expect(PASSED_LIVE_ENTRIES).toHaveLength(0);
  });

  it('reports sma200_pullback as NOT gate-passed', () => {
    expect(isLiveEntryGatePassed('sma200_pullback')).toBe(false);
  });

  it('reports sma200_reclaim and unknown strategies as NOT gate-passed', () => {
    expect(isLiveEntryGatePassed('sma200_reclaim')).toBe(false);
    expect(isLiveEntryGatePassed('totally_unknown')).toBe(false);
  });
});

describe('TRA-819 — sma200_pullback live entry is gated off', () => {
  it('places NO live order off a fresh pullback while ungated, and stamps liveSkipReason', async () => {
    const engine = new SignalEngine();
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';

    // The decisive live-order path. If the gate ever leaked, this would fire.
    const placeBracket = vi.spyOn(
      engine as unknown as { placeTradierEquityBracket: (...a: unknown[]) => Promise<unknown> },
      'placeTradierEquityBracket',
    );

    const signal = makePullbackSignal();
    await (engine as unknown as {
      openSma200Pullback: (s: Sma200Signal) => Promise<void>;
    }).openSma200Pullback(signal);

    expect(placeBracket).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/capital-gate manifest/);
  });

  it('opens NO position in demo either, while still rendering the display signal', async () => {
    const engine = new SignalEngine(); // demo by default; auto-trading on
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(pullbackSeries());

    await (engine as unknown as {
      runSma200Scan: (symbols: string[]) => Promise<void>;
    }).runSma200Scan(['TEST']);

    const state = engine.getState();
    // Display-only signal still renders as context …
    const pullback = state.signals.find((s) => s.type === 'sma200_pullback');
    expect(pullback).toBeDefined();
    expect(pullback?.liveSkipReason).toMatch(/capital-gate manifest/);
    // … but no real position was opened off it.
    expect(state.account.openPositions).toHaveLength(0);
  });
});

describe('TRA-1289 — demo-only, flag-gated sma200_pullback forward-test fill', () => {
  const FLAG = 'ENABLE_SMA200_DEMO_FORWARD_TEST';

  afterEach(() => {
    delete process.env[FLAG];
  });

  it('LIVE mode: opens NO position and stamps liveSkipReason even with the flag ON', async () => {
    process.env[FLAG] = 'true';
    const engine = new SignalEngine();
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';

    const placeBracket = vi.spyOn(
      engine as unknown as { placeTradierEquityBracket: (...a: unknown[]) => Promise<unknown> },
      'placeTradierEquityBracket',
    );

    const signal = makePullbackSignal({ mode: 'live' });
    await (engine as unknown as {
      openSma200Pullback: (s: Sma200Signal) => Promise<void>;
    }).openSma200Pullback(signal);

    // The flag is structurally incapable of touching live capital: the live
    // branch stays hard-gated by the manifest.
    expect(placeBracket).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/capital-gate manifest/);
    expect(signal.forwardTestOnly).toBeUndefined();
  });

  it('DEMO mode: stays display-only (NO position) when the flag is OFF', async () => {
    delete process.env[FLAG]; // explicit: default OFF
    const engine = new SignalEngine(); // demo by default
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(pullbackSeries());

    await (engine as unknown as {
      runSma200Scan: (symbols: string[]) => Promise<void>;
    }).runSma200Scan(['TEST']);

    const state = engine.getState();
    const pullback = state.signals.find((s) => s.type === 'sma200_pullback');
    expect(pullback?.liveSkipReason).toMatch(/capital-gate manifest/);
    expect(pullback?.forwardTestOnly).toBeUndefined();
    expect(state.account.openPositions).toHaveLength(0);
  });

  it('DEMO mode: opens a forwardTestOnly-tagged paper position when the flag is ON', async () => {
    process.env[FLAG] = 'true';
    const engine = new SignalEngine(); // demo by default; auto-trading on
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(pullbackSeries());

    await (engine as unknown as {
      runSma200Scan: (symbols: string[]) => Promise<void>;
    }).runSma200Scan(['TEST']);

    const state = engine.getState();
    // A real demo paper fill lands …
    expect(state.account.openPositions).toHaveLength(1);
    const pos = state.account.openPositions[0];
    expect(pos.signalType).toBe('sma200_pullback');
    // … tagged forward-test-only so TRA-1242 accrual never reads it as OOS
    // keeper-gate evidence.
    expect(pos.forwardTestOnly).toBe(true);
    // The manifest allow-list is still empty — this path did NOT gate-pass.
    expect(PASSED_LIVE_ENTRIES).toHaveLength(0);
    expect(isLiveEntryGatePassed('sma200_pullback')).toBe(false);
  });
});
