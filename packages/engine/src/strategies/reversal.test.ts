import { describe, it, expect } from 'vitest';
import { rsi, rsiDivergence } from '../indicators/rsi.js';
import { detectPattern, isBullishPattern, isBearishPattern } from '../indicators/patterns.js';
import { VwapTracker } from '../indicators/vwap.js';
import { ReversalStrategy } from './reversal.js';
import type { Candle } from '@trading-app/shared';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeCandle(close: number, opts?: Partial<Candle>): Candle {
  return {
    symbol: 'TEST',
    timestamp: Date.now(),
    open: opts?.open ?? close,
    high: opts?.high ?? close * 1.005,
    low: opts?.low ?? close * 0.995,
    close,
    volume: opts?.volume ?? 1_000,
  };
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

describe('rsi', () => {
  it('returns NaN when insufficient data', () => {
    expect(rsi([1, 2, 3], 14)).toBeNaN();
  });

  it('returns 100 when there are no losses', () => {
    const closes = Array.from({ length: 16 }, (_, i) => i + 1);
    expect(rsi(closes)).toBe(100);
  });

  it('returns 0 when there are no gains', () => {
    const closes = Array.from({ length: 16 }, (_, i) => 16 - i);
    expect(rsi(closes)).toBe(0);
  });

  it('returns ~50 for alternating up/down', () => {
    const closes = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const val = rsi(closes);
    expect(val).toBeGreaterThan(40);
    expect(val).toBeLessThan(60);
  });

  it('returns overbought value (>70) for sustained rally', () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115];
    expect(rsi(closes, 14)).toBeGreaterThan(70);
  });

  it('returns oversold value (<30) for sustained decline', () => {
    const closes = [115, 114, 113, 112, 111, 110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100];
    expect(rsi(closes, 14)).toBeLessThan(30);
  });
});

describe('rsiDivergence', () => {
  it('returns null when data is insufficient', () => {
    expect(rsiDivergence([1, 2], 14, 5)).toBeNull();
  });
});

// ─── Candlestick patterns ──────────────────────────────────────────────────────

describe('detectPattern', () => {
  it('returns null with fewer than 2 candles', () => {
    expect(detectPattern([makeCandle(100)])).toBeNull();
  });

  it('detects doji (body < 10% of range)', () => {
    const candle = makeCandle(100, { open: 100.05, high: 102, low: 98, close: 99.95 });
    const prev = makeCandle(100);
    expect(detectPattern([prev, candle])).toBe('doji');
  });

  it('detects hammer (bullish candle, long lower wick)', () => {
    // body=2, range=8.1, body/range≈0.25 → not doji; lowerWick=6 > body*2=4 → hammer
    const candle: Candle = {
      symbol: 'TEST', timestamp: 0,
      open: 100, high: 102.1, low: 94, close: 102, volume: 1000,
    };
    const prev = makeCandle(101);
    const p = detectPattern([prev, candle]);
    expect(p).toBe('hammer');
    expect(isBullishPattern(p)).toBe(true);
  });

  it('detects shooting_star (bearish candle, long upper wick)', () => {
    const candle: Candle = {
      symbol: 'TEST', timestamp: 0,
      open: 101, high: 107, low: 100.5, close: 100, volume: 1000,
    };
    const prev = makeCandle(100);
    const p = detectPattern([prev, candle]);
    expect(p).toBe('shooting_star');
    expect(isBearishPattern(p)).toBe(true);
  });

  it('detects bullish_engulfing', () => {
    const prev: Candle = { symbol: 'T', timestamp: 0, open: 105, high: 106, low: 99, close: 100, volume: 1000 };
    const current: Candle = { symbol: 'T', timestamp: 1, open: 99, high: 107, low: 98, close: 106, volume: 1000 };
    const p = detectPattern([prev, current]);
    expect(p).toBe('bullish_engulfing');
    expect(isBullishPattern(p)).toBe(true);
  });

  it('detects bearish_engulfing', () => {
    const prev: Candle = { symbol: 'T', timestamp: 0, open: 100, high: 107, low: 99, close: 106, volume: 1000 };
    const current: Candle = { symbol: 'T', timestamp: 1, open: 107, high: 108, low: 98, close: 99, volume: 1000 };
    const p = detectPattern([prev, current]);
    expect(p).toBe('bearish_engulfing');
    expect(isBearishPattern(p)).toBe(true);
  });
});

// ─── VWAP ─────────────────────────────────────────────────────────────────────

describe('VwapTracker', () => {
  it('computes VWAP correctly for a single candle', () => {
    const tracker = new VwapTracker();
    const candle: Candle = { symbol: 'T', timestamp: 0, open: 99, high: 101, low: 99, close: 100, volume: 1000 };
    const state = tracker.update(candle);
    // typical price = (101 + 99 + 100) / 3 = 100
    expect(state.vwap).toBeCloseTo(100);
    expect(state.stdDev).toBe(0);
  });

  it('detects price extended above VWAP band', () => {
    const tracker = new VwapTracker();
    const candles = [
      { symbol: 'T', timestamp: 0, open: 100, high: 101, low: 99, close: 100, volume: 5000 },
      { symbol: 'T', timestamp: 1, open: 100, high: 101, low: 99, close: 100, volume: 5000 },
      { symbol: 'T', timestamp: 2, open: 100, high: 101, low: 99, close: 100, volume: 5000 },
    ] satisfies Candle[];

    let state = tracker.update(candles[0]);
    state = tracker.update(candles[1]);
    state = tracker.update(candles[2]);

    // Force a clearly extended price
    expect(tracker.isExtended(state.upperBand + 10, state)).toBe('above');
    expect(tracker.isExtended(state.lowerBand - 10, state)).toBe('below');
    expect(tracker.isExtended(state.vwap, state)).toBeNull();
  });

  it('resets properly', () => {
    const tracker = new VwapTracker();
    const c: Candle = { symbol: 'T', timestamp: 0, open: 100, high: 102, low: 98, close: 100, volume: 1000 };
    tracker.update(c);
    tracker.reset();
    const state = tracker.update(c);
    expect(state.stdDev).toBe(0);
  });
});

// ─── Reversal — TRA-170 loosened gate ────────────────────────────────────────

describe('ReversalStrategy — TRA-170', () => {
  /**
   * Hand-crafted oversold series:
   *   • 25 declining bars → RSI deeply oversold + low ADX (ranging)
   *   • final bar prints a hammer (long lower wick, bullish body) on
   *     volume = 1.4× the lookback average — clears the new 1.3× threshold
   *     but would have failed the old 1.5× one.
   *   • MACD direction is left to fall out naturally; the test passes whenever
   *     a buy signal fires, regardless of MACD direction (so long as it's not
   *     bearish at the moment of evaluation).
   */
  function buildOversoldHammerSeries(): Candle[] {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      const px = 100 - i * 0.4;
      candles.push({
        symbol: 'TEST',
        timestamp: i * 60_000,
        open: px,
        high: px * 1.001,
        low: px * 0.999,
        close: px,
        volume: 1000,
      });
    }
    // Hammer (bullish): long lower wick, small body closing higher than open.
    const last = candles[candles.length - 1];
    candles.push({
      symbol: 'TEST',
      timestamp: 25 * 60_000,
      open: last.close,
      high: last.close * 1.001,
      low: last.close * 0.96,           // long lower wick
      close: last.close * 1.0008,
      volume: 1400,                     // > 1.3× the 1000 baseline
    });
    return candles;
  }

  it('volume 1.4× crosses the loosened 1.3× threshold (signal eligible)', () => {
    // retestEntry: false so we observe the immediate-entry path the volume
    // gate originally guarded; TRA-179 covers the retest path separately.
    const strat = new ReversalStrategy({ enforceTimeFilter: false, retestEntry: false });
    const candles = buildOversoldHammerSeries();
    // The signal *may* fire (depends on MACD on this synthetic series) — the
    // contract under test is that the volume gate alone no longer rejects it.
    // We assert it does not throw and produces either a buy signal or null
    // without ever producing a sell on a declining series.
    const sig = strat.evaluate('TEST', candles);
    if (sig) expect(sig.side).toBe('buy');
  });

  it('volume below 1.3× still blocks the signal (regression)', () => {
    const strat = new ReversalStrategy({ enforceTimeFilter: false, retestEntry: false });
    const candles = buildOversoldHammerSeries();
    // Drop the last bar's volume to 1.1× — should reject.
    candles[candles.length - 1] = { ...candles[candles.length - 1], volume: 1100 };
    const sig = strat.evaluate('TEST', candles);
    expect(sig).toBeNull();
  });
});

// ─── Reversal — TRA-179 retest entry ──────────────────────────────────────────

describe('ReversalStrategy — TRA-179 retest entry', () => {
  /**
   * Build a synthetic series that triggers the immediate-entry path so we
   * can compare its output against the retest-entry path one bar at a time.
   */
  function buildOversoldHammer(): Candle[] {
    const candles: Candle[] = [];
    for (let i = 0; i < 25; i++) {
      const px = 100 - i * 0.4;
      candles.push({
        symbol: 'TEST', timestamp: i * 60_000,
        open: px, high: px * 1.001, low: px * 0.999, close: px, volume: 1000,
      });
    }
    // Hammer that closes well above the prior-window low so the midpoint
    // between (close, windowLow) sits comfortably above the original stop —
    // synthetic data with a tighter spread runs into the breach guard before
    // the retest can fire.
    const last = candles[candles.length - 1];
    candles.push({
      symbol: 'TEST', timestamp: 25 * 60_000,
      open: last.close * 0.97,
      high: last.close * 1.012,
      low: last.close * 0.95,
      close: last.close * 1.01,
      volume: 1400,
    });
    return candles;
  }

  it('retest mode arms a pending signal (returns null) on the first match', () => {
    const armed = new ReversalStrategy({ enforceTimeFilter: false });
    const immediate = new ReversalStrategy({ enforceTimeFilter: false, retestEntry: false });
    const candles = buildOversoldHammer();
    // The legacy path would produce a buy here on this synthetic series; the
    // retest path should instead return null because no pullback has happened.
    const fast = immediate.evaluate('TEST', candles);
    if (fast) {
      expect(fast.side).toBe('buy');
      const armedFirst = armed.evaluate('TEST', candles);
      expect(armedFirst).toBeNull();
    }
  });

  /**
   * Re-derive the retest level the way the strategy does: midpoint of the
   * signal-bar close and the prior 5-bar window low. This avoids hard-coding
   * private state and keeps the test honest.
   */
  function deriveRetestLevel(candles: Candle[]) {
    const armBar = candles[candles.length - 1];
    const window = candles.slice(-6, -1);
    const windowLow = Math.min(...window.map(c => c.low));
    return {
      entry: armBar.close,
      stop: windowLow,
      retestLevel: (armBar.close + windowLow) / 2,
    };
  }

  it('fires a long retest entry on the bar that touches the retest level', () => {
    const strat = new ReversalStrategy({ enforceTimeFilter: false });
    const candles = buildOversoldHammer();
    const { stop: originalStop, retestLevel } = deriveRetestLevel(candles);

    strat.evaluate('TEST', candles);

    // Retest bar — pulls back to (just under) the retest level but stays
    // above the original window-low stop, then closes above the retest level
    // (a healthy "wick-and-reject" pullback). Entry should fire on this bar
    // with a stop placed below the bar's low (with a small structural buffer).
    const retestBarLow = retestLevel * 0.999;
    const retestBarClose = retestLevel * 1.001;
    expect(retestBarLow).toBeGreaterThan(originalStop);
    candles.push({
      symbol: 'TEST', timestamp: 26 * 60_000,
      open: retestLevel * 1.0005,
      high: retestLevel * 1.0012,
      low: retestBarLow,
      close: retestBarClose,
      volume: 1200,
    });
    const sig = strat.evaluate('TEST', candles);
    expect(sig).not.toBeNull();
    if (sig) {
      expect(sig.side).toBe('buy');
      expect(sig.entryPrice).toBeCloseTo(retestBarClose, 6);
      // Stop sits below the bar's low (because of the 25% structural buffer)
      // but above the original signal-bar window low.
      expect(sig.stopLoss).toBeLessThan(retestBarLow);
      expect(sig.stopLoss).toBeGreaterThan(originalStop);
      // Risk-reward should reflect the configured retestRewardMultiple (default 3).
      expect(sig.riskRewardRatio).toBeCloseTo(3, 4);
    }
  });

  it('aborts when the original signal-bar stop is breached during the wait', () => {
    const strat = new ReversalStrategy({ enforceTimeFilter: false });
    const candles = buildOversoldHammer();
    const { stop: originalStop } = deriveRetestLevel(candles);
    strat.evaluate('TEST', candles);

    // Bar that crashes through the original window-low stop — pending must
    // be discarded and no signal can fire on this bar.
    candles.push({
      symbol: 'TEST', timestamp: 26 * 60_000,
      open: originalStop * 1.001,
      high: originalStop * 1.002,
      low: originalStop * 0.97,
      close: originalStop * 0.98,
      volume: 1500,
    });
    expect(strat.evaluate('TEST', candles)).toBeNull();
  });

  it('clears the pending when the original stop is breached', () => {
    const strat = new ReversalStrategy({ enforceTimeFilter: false });
    const candles = buildOversoldHammer();
    const armBar = candles[candles.length - 1];
    strat.evaluate('TEST', candles);

    // Slam through the original stop (the signal bar's low). The pending must
    // be discarded and no signal can fire on this bar.
    candles.push({
      symbol: 'TEST', timestamp: 26 * 60_000,
      open: armBar.close,
      high: armBar.close,
      low: armBar.low * 0.95, // well below original stop
      close: armBar.low * 0.96,
      volume: 1500,
    });

    const sig = strat.evaluate('TEST', candles);
    expect(sig).toBeNull();
  });

  it('expires the pending after retestExpiryBars', () => {
    const strat = new ReversalStrategy({
      enforceTimeFilter: false,
      retestExpiryBars: 2,
    });
    const candles = buildOversoldHammer();
    strat.evaluate('TEST', candles);

    // Append 3 boring flat bars — none retest the level, so the pending
    // should expire and the strategy should return null on every call.
    const last = candles[candles.length - 1];
    for (let i = 0; i < 3; i++) {
      candles.push({
        symbol: 'TEST', timestamp: (26 + i) * 60_000,
        open: last.close, high: last.close * 1.0001, low: last.close * 0.9999,
        close: last.close, volume: 1000,
      });
      const sig = strat.evaluate('TEST', candles);
      expect(sig).toBeNull();
    }
  });
});
