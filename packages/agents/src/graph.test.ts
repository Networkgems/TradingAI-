import { describe, it, expect } from 'vitest';
import { validateAgentRecommendation, type Candle, type TradeSignal } from '@trading-app/shared';
import { runAgentGraph } from './graph.js';
import type { AgentGraphInput } from './types.js';

function candles(closes: number[], symbol = 'AAA', startTs = 1_000): Candle[] {
  return closes.map((c, i) => ({
    symbol,
    timestamp: startTs + i * 60_000,
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: 1_000,
  }));
}

function rising(n = 30): number[] {
  // ~ +8% over the last 10 bars → decisive bullish momentum.
  return Array.from({ length: n }, (_, i) => 100 + i * 0.8);
}
function falling(n = 30): number[] {
  return Array.from({ length: n }, (_, i) => 124 - i * 0.8);
}
function flat(n = 30): number[] {
  return Array.from({ length: n }, () => 100);
}

const asOf = 5_000_000;
let nowCounter = 0;
const fakeNow = () => (nowCounter += 5); // +5ms per call → deterministic latency

function input(closes: number[], candidateSignal: TradeSignal | null = null): AgentGraphInput {
  return { symbol: 'AAA', asOf, candles: candles(closes), candidateSignal };
}

describe('runAgentGraph (TRA-544 stub orchestration)', () => {
  it('always emits a schema-valid, zero-cost AgentRecommendation', async () => {
    for (const closes of [rising(), falling(), flat()]) {
      const reco = await runAgentGraph(input(closes));
      expect(validateAgentRecommendation(reco)).toEqual([]);
      expect(reco.costUsd).toBe(0); // no LLM spend in P1
      expect(reco.symbol).toBe('AAA');
      expect(reco.asOf).toBe(asOf);
      expect(reco.analystReports).toHaveLength(3);
    }
  });

  it('a decisive uptrend yields BUY → APPROVE with a routable proposedSignal', async () => {
    const reco = await runAgentGraph(input(rising()));
    expect(reco.action).toBe('BUY');
    expect(reco.verdict).toBe('APPROVE');
    expect(reco.proposedSignal).not.toBeNull();
    expect(reco.proposedSignal!.side).toBe('buy');
    expect(reco.proposedSignal!.symbol).toBe('AAA');
    expect(reco.sizeMultiplier).toBeGreaterThan(0);
    // The trader must record the opposing view it overrode (§3.3).
    expect(reco.traderDecision.dissent.length).toBeGreaterThan(0);
  });

  it('a decisive downtrend yields SELL → APPROVE with a sell signal', async () => {
    const reco = await runAgentGraph(input(falling()));
    expect(reco.action).toBe('SELL');
    expect(reco.proposedSignal?.side).toBe('sell');
  });

  it('a flat tape yields HOLD → VETO with no proposedSignal', async () => {
    const reco = await runAgentGraph(input(flat()));
    expect(reco.action).toBe('HOLD');
    expect(reco.verdict).toBe('VETO');
    expect(reco.proposedSignal).toBeNull();
    expect(reco.sizeMultiplier).toBe(0);
  });

  it('anchors proposed levels to the candidate signal when present', async () => {
    const candidate: TradeSignal = {
      id: 'strat-1', symbol: 'AAA', type: 'momentum', side: 'buy',
      entryPrice: 200, stopLoss: 196, takeProfit: 210, riskRewardRatio: 2.5, timestamp: asOf,
    };
    const reco = await runAgentGraph(input(rising(), candidate));
    expect(reco.traderDecision.proposedEntry).toBe(200);
    expect(reco.traderDecision.proposedStop).toBe(196);
    expect(reco.proposedSignal!.entryPrice).toBe(200);
    expect(reco.proposedSignal!.type).toBe('momentum');
  });

  it('VETOes a bullish read when the candidate reward:risk is below minimum', async () => {
    // Bullish tape but a candidate with R:R ≈ 0.5 (4 risk, 2 reward).
    const candidate: TradeSignal = {
      id: 'strat-2', symbol: 'AAA', type: 'momentum', side: 'buy',
      entryPrice: 100, stopLoss: 96, takeProfit: 102, riskRewardRatio: 0.5, timestamp: asOf,
    };
    const reco = await runAgentGraph(input(rising(), candidate));
    expect(reco.action).toBe('HOLD');
    expect(reco.verdict).toBe('VETO');
    expect(reco.proposedSignal).toBeNull();
  });

  it('reports deterministic latency from the injected clock', async () => {
    nowCounter = 0;
    const reco = await runAgentGraph(input(rising()), { now: fakeNow });
    expect(reco.latencyMs).toBe(5); // second call − first call
  });
});
