import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  simulateBracket,
  simulateIntents,
  rStats,
  clusteredBootstrapMeanCI,
  rng,
  runVariant,
  type PreRegistration,
} from './sweep-reclaim-backtest.js';

const DAY = 86_400_000;
const b = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  symbol: 'T', timestamp: i * DAY, open: o, high: h, low: l, close: c, volume: 1,
});

describe('simulateBracket — execution model', () => {
  const base = [b(0, 100, 101, 99, 100), b(1, 100, 101, 99, 100)];

  it('fills at the NEXT open, never the signal close', () => {
    const cs = [...base, b(2, 100.5, 103, 100, 102.9)];
    const r = simulateBracket('T', cs, { index: 1, side: 'long', stop: 98, target: 103 });
    expect(r.trade!.entry).toBe(100.5);
    expect(r.trade!.exitReason).toBe('target');
    expect(r.trade!.grossR).toBeCloseTo((103 - 100.5) / (100.5 - 98));
  });

  it('skips a gap through the stop on the entry bar', () => {
    const cs = [...base, b(2, 97, 99, 96, 98)];
    expect(simulateBracket('T', cs, { index: 1, side: 'long', stop: 98, target: 103 }).skip).toBe('gap_through_stop');
  });

  it('a later gap below the stop exits AT THE OPEN (worse than the stop)', () => {
    const cs = [...base, b(2, 100, 101, 99.5, 100), b(3, 96, 97, 95, 96.5)];
    const t = simulateBracket('T', cs, { index: 1, side: 'long', stop: 98, target: 105 }).trade!;
    expect(t.exitReason).toBe('stop_gap');
    expect(t.exit).toBe(96);
    expect(t.grossR).toBeLessThan(-1);
  });

  it('stop and target in the same bar ⇒ stop', () => {
    const cs = [...base, b(2, 100, 106, 97, 101)];
    expect(simulateBracket('T', cs, { index: 1, side: 'long', stop: 98, target: 105 }).trade!.exitReason).toBe('stop');
  });

  it('short side mirrors', () => {
    const cs = [...base, b(2, 100, 100.5, 96, 96.5)];
    const t = simulateBracket('T', cs, { index: 1, side: 'short', stop: 102, target: 97 }).trade!;
    expect(t.exitReason).toBe('target');
    expect(t.grossR).toBeCloseTo(3 / 2);
  });

  it('time stop exits at the close of the Nth held bar', () => {
    const cs = [...base];
    for (let i = 2; i < 30; i++) cs.push(b(i, 100, 100.5, 99.5, 100.2));
    const t = simulateBracket('T', cs, { index: 1, side: 'long', stop: 95, target: 110 }, { maxHoldBars: 5, costBpsPerSide: 0 }).trade!;
    expect(t.exitReason).toBe('time');
    expect(t.barsHeld).toBe(5);
  });

  it('costs are charged on both sides, in R', () => {
    const cs = [...base, b(2, 100, 103, 100, 102.9)];
    const t = simulateBracket('T', cs, { index: 1, side: 'long', stop: 98, target: 103 }, { maxHoldBars: 20, costBpsPerSide: 10 }).trade!;
    expect(t.grossR - t.netR).toBeCloseTo((0.001 * (100 + 103)) / 2);
  });

  it('one position per symbol: overlapping intents are skipped', () => {
    const cs = [...base];
    for (let i = 2; i < 12; i++) cs.push(b(i, 100, 100.5, 99.5, 100));
    const r = simulateIntents('T', cs, [
      { index: 1, side: 'long', stop: 95, target: 110 },
      { index: 3, side: 'long', stop: 95, target: 110 },
    ], { maxHoldBars: 5, costBpsPerSide: 0 });
    expect(r.trades).toHaveLength(1);
    expect(r.skips.position_open).toBe(1);
  });
});

describe('statistics', () => {
  it('rStats basics', () => {
    const s = rStats([1, -1, 2, -0.5]);
    expect(s.meanR).toBeCloseTo(0.375);
    expect(s.winRate).toBe(0.5);
    expect(s.profitFactor).toBeCloseTo(3 / 1.5);
  });

  it('clustered CI is WIDER than a naive per-trade CI when same-day trades co-move', () => {
    const rand = rng(3);
    const trades: { entryTs: number; netR: number }[] = [];
    for (let d = 0; d < 60; d++) {
      const shock = rand() < 0.5 ? -1 : 1; // one market move per day
      for (let k = 0; k < 10; k++) trades.push({ entryTs: d * DAY, netR: shock + (rand() - 0.5) * 0.1 });
    }
    const clustered = clusteredBootstrapMeanCI(trades, { seed: 1 });
    const naive = clusteredBootstrapMeanCI(trades.map((t, i) => ({ ...t, entryTs: i * DAY })), { seed: 1 });
    expect(clustered.upper! - clustered.lower!).toBeGreaterThan(2 * (naive.upper! - naive.lower!));
  });
});

/** Random-walk universe: no edge exists anywhere. */
function randomWalkUniverse(nSym: number, nBars: number, seed: number, plant?: 'sweep_then_up'): Map<string, Candle[]> {
  const rand = rng(seed);
  const out = new Map<string, Candle[]>();
  for (let s = 0; s < nSym; s++) {
    const cs: Candle[] = [];
    let p = 100;
    let drift = 0;
    for (let i = 0; i < nBars; i++) {
      const o = p;
      p = Math.max(5, p * (1 + (rand() - 0.5) * 0.03 + drift));
      let h = Math.max(o, p) * (1 + rand() * 0.01);
      let l = Math.min(o, p) * (1 - rand() * 0.01);
      drift = 0;
      if (plant === 'sweep_then_up' && i > 40 && rand() < 0.04) {
        // a long lower wick that closes near the high, then a strong up-drift
        l = Math.min(o, p) * 0.965;
        h = Math.max(o, p) * 1.002;
        drift = 0.012;
      }
      cs.push({ symbol: `S${s}`, timestamp: i * DAY, open: o, high: h, low: l, close: p, volume: 1 });
    }
    out.set(`S${s}`, cs);
  }
  return out;
}

const PREREG: PreRegistration = { minTrades: 50, ciAlpha: 0.025, placeboPercentile: 0.95 };

describe('study controls', () => {
  it('ARM-PLACEBO: on a pure random walk the study does NOT pass', () => {
    const r = runVariant('rw', randomWalkUniverse(12, 500, 11), {}, PREREG, undefined, { draws: 100, seed: 5 });
    expect(r.all.n).toBeGreaterThan(0);
    expect(r.verdict).not.toBe('PASS');
  });

  it('ARM-DETECT: the harness can SEE an edge when one is planted after sweep-like bars', () => {
    const planted = runVariant(
      'planted',
      randomWalkUniverse(12, 500, 11, 'sweep_then_up'),
      { sides: 'long', minTouches: 1 },
      PREREG,
      undefined,
      { draws: 100, seed: 5 },
    );
    const control = runVariant(
      'control',
      randomWalkUniverse(12, 500, 11),
      { sides: 'long', minTouches: 1 },
      PREREG,
      undefined,
      { draws: 100, seed: 5 },
    );
    expect(planted.all.meanR!).toBeGreaterThan(control.all.meanR! + 0.1);
    expect(planted.placebo.percentileOfReal!).toBeGreaterThan(control.placebo.percentileOfReal!);
  });
});
