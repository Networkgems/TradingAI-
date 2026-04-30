import { describe, it, expect } from 'vitest';
import type { Candle, TradeSignal } from '@trading-app/shared';
import { RegimeDetector, type Regime } from './regime.js';
import { MomentumStrategy } from './strategies/momentum.js';
import { MeanReversionCryptoStrategy } from './strategies/mean-reversion-crypto.js';
import { BreakoutVolStrategy } from './strategies/breakout-vol.js';
import { StrategyRouter, DEFAULT_ROUTER_PRIORITY } from './router.js';

/**
 * Synthetic candle generators for the router integration test. The trend /
 * range / high-vol builders mirror those in regime.test.ts and momentum.test.ts
 * so a router-level failure can be diagnosed against the same primitives the
 * detector and individual strategies were built against.
 */

function basingPhase(length: number, mid = 100, range = 0.6, startTs = 0): Candle[] {
  const out: Candle[] = [];
  let prev = mid;
  for (let i = 0; i < length; i++) {
    const next = mid + Math.sin(i * 0.7) * (range / 4);
    out.push({
      symbol: 'TEST',
      timestamp: startTs + i * 60_000,
      open: prev,
      high: Math.max(prev, next) + range / 2,
      low: Math.min(prev, next) - range / 2,
      close: next,
      volume: 1_000,
    });
    prev = next;
  }
  return out;
}

function trendPhase(
  length: number,
  start: number,
  perBar: number,
  range = 0.4,
  startTs = 0,
): Candle[] {
  const out: Candle[] = [];
  let prev = start;
  for (let i = 0; i < length; i++) {
    const next = prev * (1 + perBar);
    out.push({
      symbol: 'TEST',
      timestamp: startTs + i * 60_000,
      open: prev,
      high: Math.max(prev, next) + range / 2,
      low: Math.min(prev, next) - range / 2,
      close: next,
      volume: 1_000,
    });
    prev = next;
  }
  return out;
}

function replay(
  router: StrategyRouter,
  candles: Candle[],
  warmupBars = 60,
): Array<{ barIndex: number; signal: TradeSignal }> {
  const out: Array<{ barIndex: number; signal: TradeSignal }> = [];
  for (let i = warmupBars; i <= candles.length; i++) {
    const sig = router.evaluate('TEST', candles.slice(0, i));
    if (sig) out.push({ barIndex: i, signal: sig });
  }
  return out;
}

function buildRouter(): StrategyRouter {
  const regime = new RegimeDetector();
  // Shorter MA / Donchian periods so the test exercises the production code
  // paths without needing 1k bars of warm-up. The defaults (50/200/20) would
  // require a ~250-bar transition series per phase to fire reliably.
  const momentum = new MomentumStrategy(regime, {
    fastMaPeriod: 10,
    slowMaPeriod: 50,
    donchianPeriod: 15,
  });
  return new StrategyRouter({
    regime,
    momentum,
    meanReversion: new MeanReversionCryptoStrategy(),
    breakout: new BreakoutVolStrategy(),
  });
}

describe('StrategyRouter — regime-keyed dispatch on synthetic bars', () => {
  it('fires the momentum strategy on a flat → uptrend transition', () => {
    const router = buildRouter();
    const base = basingPhase(80, 100);
    const lastBaseTs = base[base.length - 1].timestamp;
    const startPx = base[base.length - 1].close;
    const trend = trendPhase(160, startPx, 0.005, 0.4, lastBaseTs + 60_000);
    const tape = [...base, ...trend];

    const fires = replay(router, tape);
    const momentum = fires.filter(f => f.signal.type === 'momentum');
    const breakout = fires.filter(f => f.signal.type === 'breakout_vol');

    // The trend window MUST produce at least one momentum buy. Regime
    // hysteresis can briefly leave the basing window labeled `range`, so the
    // dedupe rule still gives mean-reversion an honest shot during those
    // few bars — that's expected behaviour, not a failure mode. What's
    // load-bearing is that momentum eventually wins once the trend confirms.
    expect(momentum.length).toBeGreaterThan(0);
    expect(momentum[0].signal.side).toBe('buy');
    // Breakout's gate is `high_vol` (and the flat→high_vol transition bar);
    // a clean trend tape never satisfies the consolidation+volume premise so
    // we should see zero breakout fires.
    expect(breakout).toHaveLength(0);
  });

  it('fires the momentum strategy on a flat → downtrend transition', () => {
    const router = buildRouter();
    const base = basingPhase(80, 100);
    const lastBaseTs = base[base.length - 1].timestamp;
    const startPx = base[base.length - 1].close;
    const trend = trendPhase(160, startPx, -0.005, 0.4, lastBaseTs + 60_000);
    const tape = [...base, ...trend];

    const fires = replay(router, tape);
    const momentum = fires.filter(f => f.signal.type === 'momentum');
    const breakout = fires.filter(f => f.signal.type === 'breakout_vol');

    expect(momentum.length).toBeGreaterThan(0);
    expect(momentum[0].signal.side).toBe('sell');
    expect(breakout).toHaveLength(0);
  });

  it('does not fire momentum or breakout while regime is range', () => {
    // Mild sine-wave oscillation matching the rangeSeries used by
    // regime.test.ts — amplitude 1.5 around mid=100 gives a steady ADX-low
    // tape that the detector hysteresis-confirms as `range`. ADX stays well
    // below the 25 trend threshold so momentum's gate never opens; the wider
    // peak-to-peak of 3% still falls inside the breakout strategy's 6%
    // consolidation cap, but the volume-confirmation gate (2× SMA) is never
    // satisfied at flat baseline volume.
    const router = buildRouter();
    const length = 320;
    const candles: Candle[] = [];
    let prev = 100;
    for (let i = 0; i < length; i++) {
      const next = 100 + 1.5 * Math.sin((i / 12) * Math.PI * 2);
      candles.push({
        symbol: 'TEST',
        timestamp: i * 60_000,
        open: prev,
        high: Math.max(prev, next) + 0.2,
        low: Math.min(prev, next) - 0.2,
        close: next,
        volume: 1_000,
      });
      prev = next;
    }

    const fires = replay(router, candles);
    const momentum = fires.filter(f => f.signal.type === 'momentum');
    const breakout = fires.filter(f => f.signal.type === 'breakout_vol');
    expect(momentum).toHaveLength(0);
    expect(breakout).toHaveLength(0);
    // We don't require mean-reversion to fire — the BB/RSI gates (±2σ and
    // 25/75) are deliberately strict and the small-amplitude sine here may
    // never pierce them. What matters is that momentum and breakout are
    // both correctly suppressed by the regime label.
  });

  it('fires the breakout strategy on a quiet base → high-volume expansion bar', () => {
    // Tight consolidation (small range, baseline volume), then a single
    // high-volume break-up bar. Spec §4 lets breakout fire on `high_vol`
    // OR on the `flat → high_vol` transition bar; either path produces a
    // `breakout_vol` signal so this assertion holds regardless of which
    // side of the hysteresis the regime label landed on.
    const consolidation: Candle[] = [];
    let prev = 100;
    for (let i = 0; i < 80; i++) {
      const next = 100 + Math.sin(i * 0.4) * 0.15;
      consolidation.push({
        symbol: 'TEST',
        timestamp: i * 60_000,
        open: prev,
        high: Math.max(prev, next) + 0.1,
        low: Math.min(prev, next) - 0.1,
        close: next,
        volume: 1_000,
      });
      prev = next;
    }
    const consolidationHigh = Math.max(...consolidation.map(c => c.high));
    const breakoutClose = consolidationHigh * 1.015;
    const breakoutBar: Candle = {
      symbol: 'TEST',
      timestamp: 80 * 60_000,
      open: prev,
      high: breakoutClose + 0.05,
      low: prev,
      close: breakoutClose,
      volume: 3_000,
    };
    const tape = [...consolidation, breakoutBar];

    const router = buildRouter();
    const fires = replay(router, tape);
    expect(fires.filter(f => f.signal.type === 'momentum')).toHaveLength(0);
    const breakouts = fires.filter(f => f.signal.type === 'breakout_vol');
    expect(breakouts.length).toBeGreaterThan(0);
    expect(breakouts[0].signal.side).toBe('buy');
  });
});

describe('StrategyRouter — dedupe priority', () => {
  it('exposes the spec default ordering: momentum > breakout > mean_reversion', () => {
    expect(DEFAULT_ROUTER_PRIORITY).toEqual([
      'momentum',
      'breakout_vol',
      'mean_reversion',
    ]);
  });

  it('elects the highest-priority signal when multiple strategies fire', () => {
    // Build three stub strategies that always fire so we can exercise the
    // dedupe rule deterministically. The router only reads `evaluate()` from
    // each strategy, so a structural cast to the strategy type is safe — the
    // method shape is what's being tested.
    const fixedSig = (type: TradeSignal['type'], id: string): TradeSignal => ({
      id,
      symbol: 'TEST',
      type,
      side: 'buy',
      entryPrice: 100,
      stopLoss: 99,
      takeProfit: 102,
      riskRewardRatio: 2,
      timestamp: 0,
    });
    const alwaysFires = (sig: TradeSignal) => ({ evaluate: () => sig });

    const regime = new RegimeDetector();
    const router = new StrategyRouter({
      regime,
      momentum: alwaysFires(fixedSig('momentum', 'm-1')) as unknown as MomentumStrategy,
      breakout: alwaysFires(fixedSig('breakout_vol', 'b-1')) as unknown as BreakoutVolStrategy,
      meanReversion: alwaysFires(
        fixedSig('mean_reversion', 'r-1'),
      ) as unknown as MeanReversionCryptoStrategy,
    });
    const result = router.evaluateDetailed('TEST', []);
    expect(result.signal?.type).toBe('momentum');
    expect(result.signal?.id).toBe('m-1');
    expect(result.fired.map(f => f.priority)).toEqual([
      'momentum',
      'breakout_vol',
      'mean_reversion',
    ]);
  });

  it('honours a custom priority override', () => {
    const fixedSig = (type: TradeSignal['type'], id: string): TradeSignal => ({
      id,
      symbol: 'TEST',
      type,
      side: 'buy',
      entryPrice: 100,
      stopLoss: 99,
      takeProfit: 102,
      riskRewardRatio: 2,
      timestamp: 0,
    });
    const alwaysFires = (sig: TradeSignal) => ({ evaluate: () => sig });

    const regime = new RegimeDetector();
    const router = new StrategyRouter({
      regime,
      momentum: alwaysFires(fixedSig('momentum', 'm-1')) as unknown as MomentumStrategy,
      breakout: alwaysFires(fixedSig('breakout_vol', 'b-1')) as unknown as BreakoutVolStrategy,
      meanReversion: alwaysFires(
        fixedSig('mean_reversion', 'r-1'),
      ) as unknown as MeanReversionCryptoStrategy,
      priority: ['mean_reversion', 'breakout_vol', 'momentum'],
    });
    const result = router.evaluate('TEST', []);
    expect(result?.type).toBe('mean_reversion');
  });
});

describe('StrategyRouter — regime detector ownership', () => {
  it('updates the shared regime detector exactly once per evaluation', () => {
    // Spy on RegimeDetector.update to confirm the router doesn't double-tick
    // the hysteresis state when it dispatches to multiple strategies. Also
    // verifies that momentum (when given a label) does NOT call update again.
    let updateCalls = 0;
    let lastReturn: Regime = 'flat';
    const inner = new RegimeDetector();
    const spyDetector = {
      update(candles: Candle[]) {
        updateCalls += 1;
        lastReturn = inner.update(candles);
        return lastReturn;
      },
      current() { return inner.current(); },
      reset() { inner.reset(); },
    } as unknown as RegimeDetector;

    const router = new StrategyRouter({
      regime: spyDetector,
      momentum: new MomentumStrategy(spyDetector, {
        fastMaPeriod: 10,
        slowMaPeriod: 50,
        donchianPeriod: 15,
      }),
      meanReversion: new MeanReversionCryptoStrategy(),
      breakout: new BreakoutVolStrategy(),
    });

    const tape = trendPhase(120, 100, 0.005, 0.4);
    // Fire one evaluation — exactly one update should be observed even though
    // the router dispatches to three strategies and momentum's standalone path
    // would otherwise also call update.
    router.evaluate('TEST', tape.slice(0, 80));
    expect(updateCalls).toBe(1);

    // A second evaluation also does exactly one update.
    router.evaluate('TEST', tape.slice(0, 81));
    expect(updateCalls).toBe(2);
  });
});
