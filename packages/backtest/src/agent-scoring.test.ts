import { describe, it, expect } from 'vitest';
import type { Candle, TradeSignal } from '@trading-app/shared';
import { realizedR, summarizeAccuracy, scoreSignal } from './agent-scoring.js';

function c(close: number, high = close, low = close): Candle {
  return { symbol: 'X', timestamp: 0, open: close, high, low, close, volume: 1 };
}

const longSig: TradeSignal = {
  id: 's', symbol: 'X', type: 'momentum', side: 'buy',
  entryPrice: 100, stopLoss: 98, takeProfit: 104, riskRewardRatio: 2, timestamp: 0,
};

describe('realizedR', () => {
  it('pays +rewardR when the target is hit first', () => {
    // risk = 2, reward = 4 → 2R
    const r = realizedR(longSig, [c(101, 105, 100)]);
    expect(r).toBe(2);
  });

  it('pays -1R when the stop is hit first', () => {
    const r = realizedR(longSig, [c(99, 99.5, 97)]);
    expect(r).toBe(-1);
  });

  it('treats a same-bar touch of both stop and target as a stop (pessimistic)', () => {
    const r = realizedR(longSig, [c(100, 105, 97)]);
    expect(r).toBe(-1);
  });

  it('marks to market on the last close when unresolved', () => {
    // entry 100, last close 101, risk 2 → +0.5R
    const r = realizedR(longSig, [c(100.5, 101, 99.5), c(101, 101.5, 100)]);
    expect(r).toBeCloseTo(0.5, 6);
  });

  it('returns 0 for a zero-risk signal or empty future', () => {
    const zeroRisk: TradeSignal = { ...longSig, stopLoss: 100 };
    expect(realizedR(zeroRisk, [c(105)])).toBe(0);
    expect(realizedR(longSig, [])).toBe(0);
  });

  it('handles short signals symmetrically', () => {
    const shortSig: TradeSignal = { ...longSig, side: 'sell', stopLoss: 102, takeProfit: 96 };
    expect(realizedR(shortSig, [c(97, 99, 95)])).toBe(2); // target hit
    expect(realizedR(shortSig, [c(101, 103, 100)])).toBe(-1); // stop hit
  });
});

describe('summarizeAccuracy', () => {
  it('reports hit-rate as winRate and avg R as avgRR', () => {
    const acc = summarizeAccuracy([
      { signal: longSig, r: 2, win: true },
      { signal: longSig, r: -1, win: false },
      { signal: longSig, r: 2, win: true },
    ]);
    expect(acc.totalSignals).toBe(3);
    expect(acc.winningSignals).toBe(2);
    expect(acc.winRate).toBeCloseTo(0.6667, 3);
    expect(acc.avgRR).toBeCloseTo(1, 6); // (2 -1 +2)/3
  });

  it('is all-zero on an empty set, and says WHY the winRate is zero', () => {
    const acc = summarizeAccuracy([]);
    // ⚠️ REPAIRED 2026-10-01 (TRA-5021). `19c26272` (TRA-4998) added
    // `resolvedSignals` / `unresolvedSignals` / `winRateBasis`, so this exact-shape
    // `toEqual` went red on three fields the source had legitimately gained.
    //
    // The exact-shape form is KEPT on purpose — it is what makes a silently added
    // field visible — but the stale literal is the reason this was the SIXTH red test
    // in the monorepo while the headline count said five. `winRateBasis` is now
    // asserted rather than merely accommodated: a `winRate: 0` that means "nothing to
    // grade" must not read the same as a measured 0% (CLAUDE.md — absent evidence is
    // its own named state), and that distinction is the whole of TRA-4998.
    expect(acc).toEqual({
      totalSignals: 0,
      winningSignals: 0,
      winRate: 0,
      avgRR: 0,
      resolvedSignals: 0,
      unresolvedSignals: 0,
      winRateBasis: 'no_signals',
    });
  });
});

describe('scoreSignal — future window slicing', () => {
  it('only scores bars strictly after the decision bar', () => {
    const series: Candle[] = [c(100), c(100), c(105, 105, 100), c(100)];
    // decision at index 1; future = [c(105...), c(100)] → target (104) hit → 2R
    const scored = scoreSignal(longSig, series, 1, 10);
    expect(scored.r).toBe(2);
    expect(scored.win).toBe(true);
  });
});
