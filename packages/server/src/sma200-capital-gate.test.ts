import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Candle, Sma200Signal } from '@trading-app/shared';
import { SignalEngine } from './signal-engine.js';
import { isLiveEntryGatePassed, PASSED_LIVE_ENTRIES } from './capital-gate-manifest.js';
import * as yahooFeed from './yahoo-feed.js';
import { __resetSma200CandleMemoForTest } from './sma200-scan-admission.js';

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
    // TRA-3688 S-2 — no exit model, no target: both null on every emitted row.
    takeProfit: null,
    riskRewardRatio: null,
    timestamp: TRADING_TIME,
    mode: 'live',
    rsi: 60,
    distAtr: 1.5,
    trendQuality: true,
    goldenCross: true,
    context: 'continuation — pullback-to-200 bounce',
    // TRA-3688 C1 — the record reports its own ruler: (108 − 90) / 7.2 = 2.5
    // = distAtr + 1.0 exactly, per the pullback stop identity.
    atr14: 7.2,
    stopAtr: 2.5,
    stopBasis: 'sma200_minus_1atr',
    maxDistAtr: Infinity,
    validForBarTimestamp: TRADING_TIME,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  // TRA-4457 S2 — the sweep's daily-bar memo is process-wide; without this a
  // later test's spy would never be asked for bars an earlier test memoized.
  __resetSma200CandleMemoForTest();
  // TRA-4411 — the default gate is now finite (3.0) and this file's fixture
  // fires at distAtr ≈ 4.2, so every capital-gate / dedupe test below pins the
  // pre-flip DARK gate via the AC2 escape hatch. The finite default's own
  // server-side behavior is tested in the TRA-4411 describe at the bottom.
  process.env.SMA200_PULLBACK_MAX_DIST_ATR = 'Infinity';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.SMA200_PULLBACK_MAX_DIST_ATR;
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

describe('TRA-1926 — SMA-200 scan does not pile up duplicate cards across restarts', () => {
  const pullbacks = (e: SignalEngine) =>
    e.getState().signals.filter(s => s.type === 'sma200_pullback');

  it('stamps the source daily-bar timestamp on the emitted signal', async () => {
    const engine = new SignalEngine();
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(pullbackSeries());

    await (engine as unknown as {
      runSma200Scan: (symbols: string[]) => Promise<void>;
    }).runSma200Scan(['TEST']);

    const sig = pullbacks(engine)[0] as Sma200Signal;
    expect(sig).toBeDefined();
    // Fixture is 250 bars at index*DAY, so the latest bar is 249 * DAY.
    expect(sig.barTimestamp).toBe(249 * DAY);
  });

  it('re-scanning the same daily bar after an in-memory-map wipe (a redeploy) adds no second card', async () => {
    const engine = new SignalEngine();
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(pullbackSeries());
    const scan = () => (engine as unknown as {
      runSma200Scan: (symbols: string[]) => Promise<void>;
    }).runSma200Scan(['TEST']);

    await scan();
    expect(pullbacks(engine)).toHaveLength(1);

    // Simulate a redeploy: the in-memory debounce map is lost, but the display
    // feed is restored from the snapshot (recentSignals survives).
    (engine as unknown as { sma200LastFired: Map<string, number> }).sma200LastFired.clear();

    await scan();
    // The restart-proof feed dedupe keeps it at a single card.
    expect(pullbacks(engine)).toHaveLength(1);
  });

  it('importTradeSnapshot rehydrates the debounce map from the restored feed', () => {
    const source = new SignalEngine();
    const base = source.exportTradeSnapshot();
    const restored = makePullbackSignal({ barTimestamp: 249 * DAY, mode: 'demo' });

    const engine = new SignalEngine();
    engine.importTradeSnapshot({ ...base, recentSignals: [restored] });

    const map = (engine as unknown as { sma200LastFired: Map<string, number> }).sma200LastFired;
    expect(map.get('TEST:sma200_pullback')).toBe(249 * DAY);
  });
});

// TRA-4411 (AC6) — under the FINITE default, a gate-rejected pullback must be
// recorded on a durable surface: census counter + `sma200GateRejections` on
// state + snapshot persistence. Without these the rejected cohort exists
// nowhere and AC7's admitted-vs-rejected comparison is ungradable.
describe('TRA-4411 — S-1 finite default records max-dist rejections', () => {
  const scan = (e: SignalEngine) => (e as unknown as {
    runSma200Scan: (symbols: string[]) => Promise<void>;
  }).runSma200Scan(['TEST']);

  it('default gate (env unset) REJECTS the ≈4.2-ATR fixture and records it everywhere it must', async () => {
    delete process.env.SMA200_PULLBACK_MAX_DIST_ATR; // the shipped default, 3.0
    const engine = new SignalEngine();
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(pullbackSeries());

    await scan(engine);

    const state = engine.getState();
    // Not on the feed …
    expect(state.signals.find(s => s.type === 'sma200_pullback')).toBeUndefined();
    // … but on the rejection ledger, with the fields AC6 names.
    expect(state.sma200GateRejections).toHaveLength(1);
    const rej = state.sma200GateRejections![0];
    expect(rej.symbol).toBe('TEST');
    expect(rej.kind).toBe('sma200_pullback');
    expect(rej.distAtr).toBeGreaterThan(3.0);
    expect(rej.maxDistAtr).toBe(3.0);
    expect(rej.barTimestamp).toBe(249 * DAY);
    expect(Number.isFinite(rej.entryPrice) && Number.isFinite(rej.stopLoss)).toBe(true);
    // The census carries the counter (and stamps the finite regime).
    expect(state.sma200ScanStats?.rejectedMaxDist).toBe(1);
    expect(state.sma200ScanStats?.maxDistAtr).toBe(3.0);
    expect(state.sma200ScanStats?.fired).toBe(0);
    // A rejection must NOT consume the FIRE debounce (a name rejected on bar t
    // may fire admitted on t+1..t+4 — the admitted cohort is not a subset of
    // the dark cohort, per the grader note on TRA-4411).
    const fireMap = (engine as unknown as { sma200LastFired: Map<string, number> }).sma200LastFired;
    expect(fireMap.get('TEST:sma200_pullback')).toBeUndefined();

    // Re-scanning the same daily bar records no duplicate.
    await scan(engine);
    expect(engine.getState().sma200GateRejections).toHaveLength(1);
  });

  it('a DARK gate (explicit Infinity) records nothing — an empty ledger under Infinity is structural', async () => {
    process.env.SMA200_PULLBACK_MAX_DIST_ATR = 'Infinity';
    const engine = new SignalEngine();
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(pullbackSeries());

    await scan(engine);

    const state = engine.getState();
    expect(state.signals.find(s => s.type === 'sma200_pullback')).toBeDefined();
    expect(state.sma200GateRejections).toEqual([]);
    expect(state.sma200ScanStats?.rejectedMaxDist).toBe(0);
    expect(state.sma200ScanStats?.maxDistAtr).toBeNull();
  });

  it('the rejection ledger and its own debounce survive a snapshot round-trip', async () => {
    delete process.env.SMA200_PULLBACK_MAX_DIST_ATR;
    const source = new SignalEngine();
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(pullbackSeries());
    await scan(source);
    const snap = source.exportTradeSnapshot();
    expect(snap.sma200GateRejections).toHaveLength(1);

    const engine = new SignalEngine();
    engine.importTradeSnapshot(snap);
    expect(engine.getState().sma200GateRejections).toHaveLength(1);
    const rejMap = (engine as unknown as { sma200LastRejected: Map<string, number> }).sma200LastRejected;
    expect(rejMap.get('TEST:sma200_pullback')).toBe(249 * DAY);

    // Post-restore, a boot re-scan of the SAME daily bar stays deduped even
    // though the restart-proof check now rides the restored ledger.
    __resetSma200CandleMemoForTest();
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(pullbackSeries());
    await scan(engine);
    expect(engine.getState().sma200GateRejections).toHaveLength(1);
  });
});
