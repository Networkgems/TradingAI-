/**
 * Smoke test for the comprehensive crypto backtest script (TRA-180).
 *
 * Asserts:
 *   1. Cost args round-trip into BacktestConfig and into BacktestResult —
 *      worstCaseTotalPnl !== totalPnl whenever the runner records ambiguous
 *      single-bar SL+TP fills.
 *   2. STRATEGY_PLAN exercises all seven backtestable strategy classes
 *      (orb, reversal, macd_trend, bb_fade, ichimoku, scalping, swing).
 *   3. --no-cost zeroes out commissions/slippage end-to-end.
 *
 * No network, no Yahoo. Synthetic candles are hand-crafted to drive an ORB
 * breakout into an ambiguous wide-range exit so the round-trip is observable
 * via BacktestResult, not just BacktestConfig.
 */

import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { BacktestRunner } from '@trading-app/backtest';
import {
  STRATEGY_PLAN,
  buildBacktestConfig,
  effectiveCostBps,
  resolveCostMode,
  resolvedFillFor,
  COMMISSION_BPS,
  SLIPPAGE_BPS,
  cryptoSessionAnchor,
} from './backtest-crypto.js';

/**
 * Strategy classes the runner instantiates per BacktestConfig['strategyType'].
 * macd_bollinger triggers BOTH macd_trend + bb_fade per the TRA-170 split.
 */
const TRIGGERED_CLASSES: Record<string, string[]> = {
  orb: ['orb'],
  reversal: ['reversal'],
  macd: ['macd_trend'],
  macd_trend: ['macd_trend'],
  bb_fade: ['bb_fade'],
  macd_bollinger: ['macd_trend', 'bb_fade'],
  ichimoku: ['ichimoku'],
  scalping: ['scalping'],
  swing: ['swing'],
  combined: ['orb', 'reversal', 'macd_trend', 'bb_fade', 'ichimoku', 'scalping', 'swing'],
};

describe('backtest-crypto STRATEGY_PLAN coverage (TRA-180)', () => {
  it('exercises all seven backtestable strategy classes per symbol', () => {
    const triggered = new Set<string>();
    for (const run of STRATEGY_PLAN) {
      const classes = TRIGGERED_CLASSES[run.strategyType] ?? [];
      for (const c of classes) triggered.add(c);
    }
    expect([...triggered].sort()).toEqual([
      'bb_fade', 'ichimoku', 'macd_trend', 'orb', 'reversal', 'scalping', 'swing',
    ]);
  });

  it('wires the crypto ORB anchor and 24/7 time filter into the ORB run', () => {
    const orb = STRATEGY_PLAN.find(r => r.strategyType === 'orb');
    expect(orb).toBeDefined();
    expect(orb!.opts.orbOpts?.timeFilter).toBeDefined();
    expect(orb!.opts.orbOpts?.sessionAnchorTimestampOf).toBeDefined();
    expect(orb!.opts.orbOpts?.rangeMinutes).toBe(60);
  });

  it('cryptoSessionAnchor returns the UTC midnight bucket of its candle', () => {
    const ts = Date.UTC(2024, 4, 15, 17, 42, 13);
    const anchor = cryptoSessionAnchor({
      symbol: 'BTC-USD', timestamp: ts, open: 0, high: 0, low: 0, close: 0, volume: 0,
    });
    expect(anchor).toBe(Date.UTC(2024, 4, 15));
  });
});

describe('backtest-crypto cost mode (TRA-180)', () => {
  it('defaults to 40 bps commission + 5 bps slippage', () => {
    expect(effectiveCostBps(false)).toEqual({
      commissionBps: COMMISSION_BPS,
      slippageBps: SLIPPAGE_BPS,
    });
    expect(COMMISSION_BPS).toBe(40);
    expect(SLIPPAGE_BPS).toBe(5);
  });

  it('--no-cost zeroes both fields', () => {
    expect(effectiveCostBps(true)).toEqual({ commissionBps: 0, slippageBps: 0 });
  });

  it('buildBacktestConfig stamps the cost args onto every config it produces', () => {
    const candles: Candle[] = [
      { symbol: 'BTC-USD', timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { symbol: 'BTC-USD', timestamp: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    for (const run of STRATEGY_PLAN) {
      const config = buildBacktestConfig('BTC-USD', candles, run, effectiveCostBps(false));
      expect(config.commissionBps).toBe(40);
      expect(config.slippageBps).toBe(5);
      expect(config.strategyType).toBe(run.strategyType);
    }
  });
});

describe('backtest-crypto TRA-185 tiered cost mode', () => {
  it('resolveCostMode("tiered") attaches a CostModel and resolves majors below small-caps', () => {
    const tiered = resolveCostMode('tiered');
    expect(tiered.costModel).toBeDefined();
    const major = resolvedFillFor('BTC-USD', tiered);
    const small = resolvedFillFor('ADA-USD', tiered);
    expect(major.commissionBps + major.slippageBps).toBeLessThan(
      small.commissionBps + small.slippageBps,
    );
  });

  it('resolveCostMode("flat") leaves costModel undefined so the runner uses flat bps', () => {
    const flat = resolveCostMode('flat');
    expect(flat.costModel).toBeUndefined();
    expect(flat.commissionBps).toBe(40);
    expect(flat.slippageBps).toBe(5);
    expect(resolvedFillFor('BTC-USD', flat)).toEqual({ commissionBps: 40, slippageBps: 5 });
    expect(resolvedFillFor('ADA-USD', flat)).toEqual({ commissionBps: 40, slippageBps: 5 });
  });

  it('resolveCostMode("none") zeroes both fields and uses no costModel', () => {
    const none = resolveCostMode('none');
    expect(none).toEqual({
      commissionBps: 0,
      slippageBps: 0,
      label: 'cost-free baseline (--no-cost)',
    });
  });

  it('buildBacktestConfig threads costModel through to the BacktestConfig', () => {
    const candles: Candle[] = [
      { symbol: 'BTC-USD', timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { symbol: 'BTC-USD', timestamp: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const tiered = resolveCostMode('tiered');
    const config = buildBacktestConfig('BTC-USD', candles, STRATEGY_PLAN[0], tiered);
    expect(config.costModel).toBe(tiered.costModel);
  });
});

/**
 * Hand-rolled candle stream that:
 *   - leads with a steep 30-bar pre-market uptrend so ADX seeds well above 20
 *   - forms a tight 3-min opening range at 14:30–14:32 UTC (9:30–9:32 ET) so
 *     rangeMinutes=2 captures it as the session range
 *   - skips two filler bars (14:33–14:34 UTC = 9:33–9:34 ET) that the equity
 *     time filter rejects (the morning window starts at 9:35 ET)
 *   - breaks out at 14:35 UTC with the volume spike and close above rangeHigh
 *   - exits on a wide-range bar whose high covers TP and low covers SL — the
 *     single-bar ambiguity the runner records via `ambiguousTrades`
 * Uses ORB equity defaults (not the crypto anchor) so the test doesn't have
 * to align with isValidCryptoTradingWindow's hour-of-day buckets.
 */
function buildAmbiguousOrbStream(): Candle[] {
  const symbol = 'TEST';
  const candles: Candle[] = [];

  // Steep pre-market uptrend: 30 bars from 13:30 to 13:59 UTC. Each bar opens
  // 0.5 above the prior open, so DI+ dominates and ADX accumulates well past
  // 20 long before the range forms.
  const preStart = Date.UTC(2024, 0, 8, 13, 30, 0);
  for (let i = 0; i < 30; i++) {
    const base = 90 + i * 0.5;
    candles.push({
      symbol, timestamp: preStart + i * 60_000,
      open: base, high: base + 0.3, low: base - 0.2, close: base + 0.4,
      volume: 5_000,
    });
  }

  // Opening range bars at 14:30–14:32 UTC (anchor = first bar ≥ 9:30 ET; with
  // rangeMinutes=2 the cutoff is 14:32 inclusive). Tight $0.20 range.
  const rangeStart = Date.UTC(2024, 0, 8, 14, 30, 0);
  for (let i = 0; i < 3; i++) {
    candles.push({
      symbol, timestamp: rangeStart + i * 60_000,
      open: 104.9, high: 105.0, low: 104.8, close: 104.9,
      volume: 5_000,
    });
  }

  // Filler bars at 14:33–14:34 UTC. Time filter rejects them (9:33–9:34 ET is
  // outside the 9:35 morning window) so they generate no signals, but they
  // keep the candle stream contiguous for ADX/indicator continuity.
  for (let i = 3; i < 5; i++) {
    candles.push({
      symbol, timestamp: rangeStart + i * 60_000,
      open: 104.9, high: 105.0, low: 104.8, close: 104.9,
      volume: 5_000,
    });
  }

  // Breakout at 14:35 UTC = 9:35 ET (first bar inside the morning window).
  // close=106 > rangeHigh=105.0; volume=12000 > avgRangeVolume*1.5=7500.
  // ORB fires: side=buy, entry=106, stopLoss=104.8, stopDistance=1.2,
  // takeProfit = 106 + 2.4 = 108.4.
  candles.push({
    symbol, timestamp: rangeStart + 5 * 60_000,
    open: 105.0, high: 106.2, low: 104.9, close: 106,
    volume: 12_000,
  });

  // Ambiguous exit at 14:36 UTC = 9:36 ET. high covers TP (≥108.4) and low
  // covers SL (≤104.8) → the runner increments ambiguousTrades and the
  // pessimistic worstCaseTotalPnl diverges from the optimistic totalPnl.
  candles.push({
    symbol, timestamp: rangeStart + 6 * 60_000,
    open: 106, high: 109, low: 104, close: 107,
    volume: 5_000,
  });

  return candles;
}

describe('backtest-crypto cost args round-trip into BacktestResult (TRA-180)', () => {
  it('records ambiguous trades and worstCaseTotalPnl !== totalPnl with costs applied', async () => {
    const candles = buildAmbiguousOrbStream();
    const config = buildBacktestConfig(
      'TEST',
      candles,
      // Use a minimal ORB run instead of the crypto ORB so we don't have to
      // align the candle timestamps with the crypto trading windows.
      { strategyType: 'orb', label: 'orb-test', opts: { orbOpts: { rangeMinutes: 2, minVolume: 100 } } },
      effectiveCostBps(false),
    );

    const result = await new BacktestRunner().run(config, candles);

    // Cost args must be present in the BacktestConfig the runner echoes back.
    expect(result.config.commissionBps).toBe(40);
    expect(result.config.slippageBps).toBe(5);

    // Round-trip: at least one ambiguous SL+TP-on-the-same-bar exit, and the
    // pessimistic (SL) PnL must diverge from the optimistic (TP) PnL.
    expect(result.ambiguousTrades).toBeGreaterThan(0);
    expect(result.worstCaseTotalPnl).not.toBe(result.totalPnl);
  });
});
