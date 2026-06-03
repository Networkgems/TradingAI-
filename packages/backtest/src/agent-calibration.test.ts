import { describe, it, expect } from 'vitest';
import type { AgentRecommendation, Candle, TradeSignal } from '@trading-app/shared';
import type { AgentReplayRecord } from './agent-replay.js';
import { netOfCostEdge, reliabilityCurve } from './agent-calibration.js';

function c(close: number, high = close, low = close): Candle {
  return { symbol: 'X', timestamp: 0, open: close, high, low, close, volume: 1 };
}

// A long signal: risk 2, reward 4 (2R) — target at 104, stop at 98.
function longSig(): TradeSignal {
  return {
    id: 's', symbol: 'X', type: 'momentum', side: 'buy',
    entryPrice: 100, stopLoss: 98, takeProfit: 104, riskRewardRatio: 2, timestamp: 0,
  };
}

/** Minimal record carrying just the fields the calibration/edge readers touch. */
function rec(
  barIndex: number,
  conviction: number,
  proposedSignal: TradeSignal | null,
  costUsd = 0,
): AgentReplayRecord {
  const recommendation = {
    symbol: 'X', asOf: 0, action: 'BUY', conviction, sizeMultiplier: conviction,
    proposedSignal, verdict: 'APPROVE',
    analystReports: [], debateTranscript: { rounds: [], survivingThesis: '', netLean: 0 },
    traderDecision: {} as never, riskVerdict: {} as never,
    costUsd, latencyMs: 1,
  } as unknown as AgentRecommendation;
  return { recommendation, candidateSignal: proposedSignal, barIndex, asOf: 0 };
}

describe('reliabilityCurve', () => {
  it('bins routable recommendations by conviction and scores observed hit-rate', () => {
    // Build a series where index 0 is the decision bar and index 1 hits target.
    const series: Candle[] = [c(100), c(105, 105, 100)]; // target 104 hit
    const win = rec(0, 0.85, longSig());
    const series2: Candle[] = [c(100), c(97, 99, 96)]; // stop 98 hit → loss
    // To score two records on different series we score each on its own slice;
    // calibration takes one candle array, so use one series per call.
    const curveWin = reliabilityCurve([win], series, 5, 10);
    expect(curveWin.sampleSize).toBe(1);
    const bin = curveWin.bins.find((b) => b.count > 0)!;
    expect(bin.lo).toBe(0.8);
    expect(bin.hi).toBe(0.9);
    expect(bin.hitRate).toBe(1);
    expect(bin.meanConviction).toBeCloseTo(0.85, 6);

    const loss = rec(0, 0.85, longSig());
    const curveLoss = reliabilityCurve([loss], series2, 5, 10);
    expect(curveLoss.bins.find((b) => b.count > 0)!.hitRate).toBe(0);
  });

  it('excludes HOLD/VETO (null proposedSignal) recommendations', () => {
    const series: Candle[] = [c(100), c(105, 105, 100)];
    const curve = reliabilityCurve([rec(0, 0.5, null)], series, 5, 10);
    expect(curve.sampleSize).toBe(0);
    expect(curve.expectedCalibrationError).toBe(0);
    expect(curve.brierScore).toBe(0);
  });

  it('puts conviction === 1 in the top bin', () => {
    const series: Candle[] = [c(100), c(105, 105, 100)];
    const curve = reliabilityCurve([rec(0, 1, longSig())], series, 5, 10);
    const top = curve.bins[curve.bins.length - 1]!;
    expect(top.count).toBe(1);
  });

  it('computes a Brier score of (conviction − win)^2 averaged', () => {
    const series: Candle[] = [c(100), c(105, 105, 100)]; // win=1
    const curve = reliabilityCurve([rec(0, 0.7, longSig())], series, 5, 10);
    expect(curve.brierScore).toBeCloseTo((0.7 - 1) ** 2, 6);
  });
});

describe('netOfCostEdge', () => {
  it('turns gross R into $ at the risk budget and subtracts cost', () => {
    const series: Candle[] = [c(100), c(105, 105, 100)]; // 2R win
    const edge = netOfCostEdge([rec(0, 0.8, longSig(), 0)], series, 5, 100);
    expect(edge.trades).toBe(1);
    expect(edge.grossEdgeR).toBe(2);
    expect(edge.grossEdgeUsd).toBe(200); // 2R * $100 * 1 trade
    expect(edge.totalCostUsd).toBe(0);
    expect(edge.netEdgeUsd).toBe(200);
    expect(edge.netEdgePerTradeUsd).toBe(200);
  });

  it('subtracts LLM cost across ALL recommendations, including HOLDs', () => {
    const series: Candle[] = [c(100), c(105, 105, 100)];
    const edge = netOfCostEdge(
      [rec(0, 0.8, longSig(), 0.5), rec(0, 0.1, null, 0.3)],
      series, 5, 100,
    );
    expect(edge.trades).toBe(1); // only the routable one took risk
    expect(edge.totalCostUsd).toBeCloseTo(0.8, 6); // 0.5 + 0.3
    expect(edge.netEdgeUsd).toBeCloseTo(200 - 0.8, 2);
  });
});
