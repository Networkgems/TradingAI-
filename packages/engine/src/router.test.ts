import { describe, it, expect } from 'vitest';
import type { Candle, TradeSignal } from '@trading-app/shared';
import { RegimeDetector, type Regime } from './regime.js';
import { MomentumStrategy } from './strategies/momentum.js';
import { MeanReversionCryptoStrategy } from './strategies/mean-reversion-crypto.js';
import { BreakoutVolStrategy } from './strategies/breakout-vol.js';
import { StrategyRouter, DEFAULT_ROUTER_PRIORITY } from './router.js';
import type { SupertrendConfluenceStrategy } from './strategies/supertrend-confluence.js';

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

describe('StrategyRouter — TRA-421 per-strategy universe filter', () => {
  // The TRA-405 §8 out-of-sample go/no-go gates each strategy to a validated
  // symbol set. These tests pin the router-level gate: a strategy fires for a
  // symbol only when the universe whitelist admits it. Stub strategies that
  // always fire isolate the gate from the regime/indicator logic.
  const fixedSig = (type: TradeSignal['type'], symbol: string): TradeSignal => ({
    id: `${type}-${symbol}`,
    symbol,
    type,
    side: 'buy',
    entryPrice: 100,
    stopLoss: 99,
    takeProfit: 102,
    riskRewardRatio: 2,
    timestamp: 0,
  });
  // Stub whose evaluate echoes a signal stamped with the symbol it was called
  // for, so a test can prove the gate keyed off the evaluated symbol.
  const firesFor = (type: TradeSignal['type']) => ({
    evaluate: (symbol: string) => fixedSig(type, symbol),
  });

  function buildStubRouter(universe?: Record<string, readonly string[]>): StrategyRouter {
    return new StrategyRouter({
      regime: new RegimeDetector(),
      momentum: firesFor('momentum') as unknown as MomentumStrategy,
      breakout: firesFor('breakout_vol') as unknown as BreakoutVolStrategy,
      meanReversion: firesFor('mean_reversion') as unknown as MeanReversionCryptoStrategy,
      universe,
    });
  }

  it('emits a gated strategy only for symbols in its universe list', () => {
    const router = buildStubRouter({ momentum: ['BTC-USD', 'SOL-USD'] });
    // In-universe: momentum is highest priority and wins.
    expect(router.evaluate('BTC-USD', [])?.type).toBe('momentum');
    expect(router.evaluate('SOL-USD', [])?.type).toBe('momentum');
    // Out-of-universe: momentum is dropped, so the next-priority strategy
    // (breakout_vol — unrestricted here) wins instead.
    const eth = router.evaluateDetailed('ETH-USD', []);
    expect(eth.signal?.type).toBe('breakout_vol');
    expect(eth.fired.map(f => f.priority)).not.toContain('momentum');
  });

  it('treats an empty universe list as "disabled on every symbol"', () => {
    // Per TRA-405 §8, momentum and breakout_vol are OOS-negative everywhere.
    const router = buildStubRouter({ momentum: [], breakout_vol: [] });
    for (const sym of ['BTC-USD', 'SOL-USD', 'ETH-USD']) {
      const r = router.evaluateDetailed(sym, []);
      // Only the unrestricted mean_reversion survives.
      expect(r.signal?.type).toBe('mean_reversion');
      expect(r.fired.map(f => f.priority)).toEqual(['mean_reversion']);
    }
  });

  it('leaves a strategy absent from the universe map unrestricted', () => {
    // Only momentum is gated; breakout_vol / mean_reversion are unmapped and
    // must still fire on any symbol.
    const router = buildStubRouter({ momentum: ['BTC-USD'] });
    expect(router.evaluate('DOGE-USD', [])?.type).toBe('breakout_vol');
  });

  it('applies no symbol gating when no universe is configured', () => {
    const router = buildStubRouter();
    expect(router.evaluate('ANY-USD', [])?.type).toBe('momentum');
  });

  it('setUniverse re-points a live router (cached per symbol by the engine)', () => {
    const router = buildStubRouter();
    expect(router.evaluate('ETH-USD', [])?.type).toBe('momentum');
    // The crypto engine caches one router per symbol and re-points it when the
    // active preset changes; setUniverse must take effect on the next evaluate.
    router.setUniverse({ momentum: ['BTC-USD'] });
    expect(router.evaluate('ETH-USD', [])?.type).toBe('breakout_vol');
    router.setUniverse({});
    expect(router.evaluate('ETH-USD', [])?.type).toBe('momentum');
  });

  it('gates the evaluated symbol, not the candle symbol field', () => {
    // The stub stamps each signal with the symbol evaluate() was called for;
    // confirm the gate keys off that argument.
    const router = buildStubRouter({ momentum: ['SOL-USD'] });
    expect(router.evaluate('SOL-USD', [])?.symbol).toBe('SOL-USD');
    expect(router.evaluateDetailed('BTC-USD', []).fired.map(f => f.priority))
      .not.toContain('momentum');
  });
});

describe('StrategyRouter — TRA-728 SupertrendConfluence gated OFF by default', () => {
  // The SupertrendConfluence source must land in the router fully inert: until
  // the Phase-2 backtest gate validates it, an omitted/false `enableSupertrend`
  // means the strategy is never even evaluated, so the router behaves exactly as
  // it did before TRA-728. These tests pin that invariant.
  const stSig = (): TradeSignal => ({
    id: 'st-1',
    symbol: 'AMD',
    type: 'supertrend_confluence',
    side: 'buy',
    entryPrice: 100,
    stopLoss: 98,
    takeProfit: 104,
    riskRewardRatio: 2,
    timestamp: 0,
  });

  function spyingSupertrend(): { strat: SupertrendConfluenceStrategy; calls: () => number } {
    let calls = 0;
    const strat = {
      evaluate: () => {
        calls += 1;
        return stSig();
      },
    } as unknown as SupertrendConfluenceStrategy;
    return { strat, calls: () => calls };
  }

  it('never evaluates the supertrend strategy when the flag is omitted (default off)', () => {
    const { strat, calls } = spyingSupertrend();
    const router = new StrategyRouter({
      regime: new RegimeDetector(),
      momentum: new MomentumStrategy(new RegimeDetector(), { fastMaPeriod: 10, slowMaPeriod: 50, donchianPeriod: 15 }),
      meanReversion: new MeanReversionCryptoStrategy(),
      breakout: new BreakoutVolStrategy(),
      supertrend: strat,
      // enableSupertrend omitted ⇒ default false
    });
    const tape = trendPhase(120, 100, 0.005, 0.4);
    for (let i = 60; i <= tape.length; i++) router.evaluateDetailed('AMD', tape.slice(0, i));
    expect(calls()).toBe(0);
  });

  it('never surfaces a supertrend_confluence signal when off, even if it would fire', () => {
    const { strat } = spyingSupertrend();
    const router = new StrategyRouter({
      regime: new RegimeDetector(),
      momentum: { evaluate: () => null } as unknown as MomentumStrategy,
      meanReversion: { evaluate: () => null } as unknown as MeanReversionCryptoStrategy,
      breakout: { evaluate: () => null } as unknown as BreakoutVolStrategy,
      supertrend: strat,
      enableSupertrend: false,
    });
    const result = router.evaluateDetailed('AMD', []);
    expect(result.signal).toBeNull();
    expect(result.fired).toHaveLength(0);
  });

  it('evaluates and forwards the signal only once explicitly enabled', () => {
    const { strat, calls } = spyingSupertrend();
    const router = new StrategyRouter({
      regime: new RegimeDetector(),
      momentum: { evaluate: () => null } as unknown as MomentumStrategy,
      meanReversion: { evaluate: () => null } as unknown as MeanReversionCryptoStrategy,
      breakout: { evaluate: () => null } as unknown as BreakoutVolStrategy,
      supertrend: strat,
      enableSupertrend: true,
    });
    const result = router.evaluateDetailed('AMD', []);
    expect(calls()).toBe(1);
    expect(result.signal?.type).toBe('supertrend_confluence');
  });

  it('ranks last when enabled: never displaces a validated strategy on the same bar', () => {
    const { strat } = spyingSupertrend();
    const momentumSig: TradeSignal = {
      id: 'm-1', symbol: 'AMD', type: 'momentum', side: 'buy',
      entryPrice: 100, stopLoss: 99, takeProfit: 102, riskRewardRatio: 2, timestamp: 0,
    };
    const router = new StrategyRouter({
      regime: new RegimeDetector(),
      momentum: { evaluate: () => momentumSig } as unknown as MomentumStrategy,
      meanReversion: { evaluate: () => null } as unknown as MeanReversionCryptoStrategy,
      breakout: { evaluate: () => null } as unknown as BreakoutVolStrategy,
      supertrend: strat,
      enableSupertrend: true,
    });
    const result = router.evaluateDetailed('AMD', []);
    // Both fire, but the validated momentum strategy wins the dedupe joust.
    expect(result.signal?.type).toBe('momentum');
    expect(result.fired.map(f => f.priority)).toContain('supertrend_confluence');
    expect(result.fired[result.fired.length - 1].priority).toBe('supertrend_confluence');
  });
});
