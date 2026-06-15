import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  confluenceSide,
  confluenceReads,
  evaluateSupertrendConfluence,
  evaluateSupertrendConfluenceRow,
  SupertrendConfluenceStrategy,
} from './supertrend-confluence.js';
import { rsi } from '../indicators/rsi.js';

/**
 * Build an OHLCV series from explicit closes. high/low sit `spread` either side
 * of the running close, open = prior close, 15-minute timestamps from 0 —
 * deterministic, so these confluence fixtures are golden.
 */
function build(closes: number[], spread = 0.5, step = 15 * 60_000): Candle[] {
  return closes.map((close, i) => ({
    symbol: 'TEST',
    timestamp: i * step,
    open: i > 0 ? closes[i - 1] : close,
    high: Math.max(close, i > 0 ? closes[i - 1] : close) + spread,
    low: Math.min(close, i > 0 ? closes[i - 1] : close) - spread,
    close,
    volume: 1_000,
  }));
}

/**
 * Sawtooth uptrend: `k` up-bars of +u then one down-bar of −d, repeated, always
 * ending on an up-bar. The periodic dips cool RSI into the [50,70] entry band
 * while the net drift keeps the SMA stack aligned and MACD positive — exactly
 * the "pullback inside an uptrend" the confluence is meant to buy.
 */
function sawUp(n: number, u = 0.5, d = 1.0, k = 3): number[] {
  const closes: number[] = [];
  let p = 100;
  let i = 0;
  while (closes.length < n) {
    const inUp = i % (k + 1) !== k;
    closes.push(p);
    p += inUp ? u : -d;
    i++;
  }
  while (closes.length > 2 && closes[closes.length - 1] <= closes[closes.length - 2]) closes.pop();
  return closes;
}

/** Mirror of {@link sawUp}: a sawtooth downtrend (reflect closes around 100). */
function sawDown(n: number, u = 0.5, d = 1.0, k = 3): number[] {
  return sawUp(n, u, d, k).map(c => 200 - c);
}

const upCloses = sawUp(80);
const downCloses = sawDown(80);
const longSignal = build(upCloses);
const shortSignal = build(downCloses);

describe('confluenceSide (single timeframe gates)', () => {
  it('returns null when there are too few bars', () => {
    expect(confluenceSide(build(upCloses.slice(0, 20)))).toBeNull();
  });

  it('fires a long when ST green + MA stack + MACD≥0 + RSI in band & rising', () => {
    const decision = confluenceSide(longSignal);
    expect(decision).not.toBeNull();
    expect(decision!.side).toBe('buy');
    expect(decision!.reads.supertrendGreen).toBe(true);
    expect(decision!.reads.maStackAligned).toBe(true);
    expect(decision!.reads.macdOk).toBe(true);
    expect(decision!.reads.rsiOk).toBe(true);
    // The fixture's RSI genuinely sits in the [50,70] entry band.
    const r = rsi(upCloses, 14);
    expect(r).toBeGreaterThanOrEqual(50);
    expect(r).toBeLessThanOrEqual(70);
  });

  it('fires a short on the mirror series', () => {
    const decision = confluenceSide(shortSignal);
    expect(decision).not.toBeNull();
    expect(decision!.side).toBe('sell');
    expect(decision!.reads.maStackAligned).toBe(true);
  });

  it('rejects a steep uptrend whose RSI is above the [50,70] band', () => {
    // A pure monotonic ramp has no down bars → RSI = 100, outside the band.
    const steep = build(Array.from({ length: 80 }, (_, i) => 100 + i * 1.0));
    expect(rsi(steep.map(c => c.close), 14)).toBeGreaterThan(70);
    expect(confluenceSide(steep)).toBeNull();
  });
});

describe('evaluateSupertrendConfluence (MTF gate + bracket)', () => {
  it('emits a supertrend_confluence buy with a Supertrend-line stop and R:R take-profit', () => {
    const sig = evaluateSupertrendConfluence('AMD', longSignal, longSignal)!;
    expect(sig).not.toBeNull();
    expect(sig.type).toBe('supertrend_confluence');
    expect(sig.side).toBe('buy');
    expect(sig.stopLoss).toBeLessThan(sig.entryPrice);
    expect(sig.takeProfit).toBeGreaterThan(sig.entryPrice);
    // Take-profit is rewardRiskRatio (default 2) × the stop distance.
    const stopDist = sig.entryPrice - sig.stopLoss;
    expect(sig.takeProfit - sig.entryPrice).toBeCloseTo(2 * stopDist, 6);
    expect(sig.riskRewardRatio).toBe(2);
  });

  it('blocks the long when the higher-timeframe Supertrend disagrees (red confirm)', () => {
    // Same long signal, but a downtrend confirm series ⇒ 60m trend is red ⇒ skip.
    const redConfirm = build(downCloses);
    expect(evaluateSupertrendConfluence('AMD', longSignal, redConfirm)).toBeNull();
  });

  it('allows the long when the confirm timeframe agrees (green confirm)', () => {
    expect(evaluateSupertrendConfluence('AMD', longSignal, longSignal)?.side).toBe('buy');
  });

  it('skips when confirm is required but missing', () => {
    expect(evaluateSupertrendConfluence('AMD', longSignal, null)).toBeNull();
  });

  it('skips when the confirm series is too short to be seed-independent (TRA-840)', () => {
    // A ~20-bar confirm is below the warm-up + seed-washout floor, so its read is
    // seed-pinned (TRA-809: deterministically red regardless of the real trend).
    // The guard must emit nothing rather than let it rubber-stamp a side.
    const shortConfirm = build(upCloses.slice(0, 20));
    expect(shortConfirm.length).toBeLessThan(30);
    expect(evaluateSupertrendConfluence('AMD', longSignal, shortConfirm)).toBeNull();
  });

  it('honours requireConfirmTrend:false (no confirm series needed)', () => {
    const sig = evaluateSupertrendConfluence('AMD', longSignal, null, { requireConfirmTrend: false });
    expect(sig?.side).toBe('buy');
  });
});

describe('SupertrendConfluenceStrategy (router adapter)', () => {
  it('derives the 60m confirm by resampling and fires a buy on a 15m uptrend', () => {
    // Enough 15m bars that the resampled 1h confirm clears the TRA-840 length
    // guard (≥30 hourly bars): 160 × 15m → 40h → 40 hourly buckets.
    const strat = new SupertrendConfluenceStrategy();
    const sig = strat.evaluate('AMD', build(sawUp(160)));
    expect(sig?.type).toBe('supertrend_confluence');
    expect(sig?.side).toBe('buy');
  });

  it('returns null on a flat tape (no confluence)', () => {
    const flat = build(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i * 0.3) * 0.2));
    expect(new SupertrendConfluenceStrategy().evaluate('AMD', flat)).toBeNull();
  });
});

describe('confluenceReads + evaluateSupertrendConfluenceRow (TRA-840 attribution)', () => {
  // Steep monotonic ramp: ST green + MA stack aligned + MACD>0, but RSI pins at
  // 100 (above the [50,70] band) so the emit gate fails — the canonical near-miss.
  const steep = build(Array.from({ length: 80 }, (_, i) => 100 + i * 1.0));

  it('confluenceReads returns the Supertrend-implied side reads even on a non-emit', () => {
    expect(confluenceSide(steep)).toBeNull(); // no emit (RSI out of band)
    const reads = confluenceReads(steep);
    expect(reads).not.toBeNull();
    expect(reads!.side).toBe('buy');
    // The failing component is VISIBLE — this is the variance Anomaly 2 lacked.
    expect(reads!.reads.rsiOk).toBe(false);
    expect(reads!.reads.maStackAligned).toBe(true);
  });

  it('captures a near-miss row (emitted:false) with a resolvable bracket', () => {
    const row = evaluateSupertrendConfluenceRow('AMD', steep, steep)!;
    expect(row).not.toBeNull();
    expect(row.side).toBe('buy');
    expect(row.emitted).toBe(false); // near-miss, never routable
    expect(row.reads.rsiOk).toBe(false);
    expect(row.stopLoss).toBeLessThan(row.entryPrice);
    expect(row.takeProfit).toBeGreaterThan(row.entryPrice);
  });

  it('marks a full-confluence pass emitted:true', () => {
    const row = evaluateSupertrendConfluenceRow('AMD', longSignal, longSignal)!;
    expect(row.emitted).toBe(true);
    expect(row.side).toBe('buy');
  });

  it('respects the confirm length guard (no row when confirm too short)', () => {
    expect(evaluateSupertrendConfluenceRow('AMD', longSignal, build(upCloses.slice(0, 20)))).toBeNull();
  });
});
