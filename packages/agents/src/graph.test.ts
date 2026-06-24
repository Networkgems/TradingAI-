import { describe, it, expect } from 'vitest';
import { validateAgentRecommendation, type Candle, type RiskVerdict, type TradeSignal } from '@trading-app/shared';
import { runAgentGraph, personalizeRiskVerdict, memorySizingTilt } from './graph.js';
import type { AgentGraphInput, UserTradingMemory } from './types.js';
import type { LlmClient, LlmCompletionRequest } from './llm-client.js';

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
      expect(reco.analystReports).toHaveLength(4);
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

describe('runAgentGraph (TRA-747 LLM path)', () => {
  // A canned LlmClient: analysts return their requested kind, the trader BUYs,
  // and the risk manager APPROVEs. Each call bills $0.01 so we can assert the
  // graph SUMS real cost onto the recommendation.
  function cannedLlm(costPerCall = 0.01): LlmClient & { calls: LlmCompletionRequest[] } {
    const calls: LlmCompletionRequest[] = [];
    return {
      calls,
      async complete(req) {
        calls.push(req);
        const kind = req.purpose.startsWith('analyst:') ? req.purpose.split(':')[1] : null;
        let text: string;
        if (kind) {
          text = JSON.stringify({
            kind, stance: 0.6, confidence: 0.7, horizonDays: 5,
            keyLevels: { support: 90, resistance: 130 }, drivers: ['mom'], notes: 'ok',
          });
        } else if (req.purpose === 'trader') {
          text = JSON.stringify({
            action: 'BUY', conviction: 0.7, proposedEntry: 100, proposedStop: 98,
            proposedTarget: 106, riskRewardRatio: 3, thesis: 'buy it', dissent: 'thin news',
          });
        } else {
          text = JSON.stringify({
            verdict: 'APPROVE', sizeMultiplier: 0.6,
            panel: [
              { persona: 'aggressive', sizeMultiplier: 0.6, reasons: ['x'] },
              { persona: 'neutral', sizeMultiplier: 0.5, reasons: ['x'] },
              { persona: 'conservative', sizeMultiplier: 0.3, reasons: ['x'] },
            ],
            reasons: ['ok'],
          });
        }
        return { text, costUsd: costPerCall, model: req.tier === 'fast' ? 'claude-haiku-4-5' : 'claude-sonnet-4-6' };
      },
    };
  }

  it('routes through the LlmClient, sums real cost, and stays schema-valid', async () => {
    const llm = cannedLlm(0.01);
    const reco = await runAgentGraph(input(rising()), { llm });
    expect(validateAgentRecommendation(reco)).toEqual([]);
    // 4 analysts (fast) + trader + risk (strong) = 6 calls → $0.06.
    expect(llm.calls).toHaveLength(6);
    expect(llm.calls.filter((c) => c.tier === 'fast')).toHaveLength(4);
    expect(llm.calls.filter((c) => c.tier === 'strong')).toHaveLength(2);
    expect(reco.costUsd).toBeCloseTo(0.06, 6);
    expect(reco.action).toBe('BUY');
    expect(reco.verdict).toBe('APPROVE');
    expect(reco.proposedSignal).not.toBeNull();
  });

  it('with no llm runs the deterministic path at zero cost (P3 replay determinism)', async () => {
    const reco = await runAgentGraph(input(rising()));
    expect(reco.costUsd).toBe(0);
  });

  it('TRA-1042 — deps.thinking propagates to the judgment tiers only, not the analysts', async () => {
    const llm = cannedLlm(0.01);
    await runAgentGraph(input(rising()), { llm, thinking: { effort: 'high' } });
    const trader = llm.calls.find((c) => c.purpose === 'trader');
    const risk = llm.calls.find((c) => c.purpose === 'risk-manager');
    const analysts = llm.calls.filter((c) => c.purpose.startsWith('analyst:'));
    expect(trader?.thinking).toEqual({ effort: 'high' });
    expect(risk?.thinking).toEqual({ effort: 'high' });
    // The Haiku analyst fan-out must NOT carry thinking (effort would 400 there).
    expect(analysts.every((c) => c.thinking === undefined)).toBe(true);
  });

  it('TRA-1042 — without deps.thinking, no call carries a thinking knob (default off)', async () => {
    const llm = cannedLlm(0.01);
    await runAgentGraph(input(rising()), { llm });
    expect(llm.calls.every((c) => c.thinking === undefined)).toBe(true);
  });
});

// TRA-850 — persistent per-user memory personalizes the advisory read.
function withMemory(closes: number[], userMemory: UserTradingMemory): AgentGraphInput {
  return { ...input(closes), userMemory };
}

function verdict(over: Partial<RiskVerdict> = {}): RiskVerdict {
  return {
    verdict: 'APPROVE',
    sizeMultiplier: 0.8,
    panel: [
      { persona: 'aggressive', sizeMultiplier: 0.8, reasons: ['a'] },
      { persona: 'neutral', sizeMultiplier: 0.6, reasons: ['n'] },
      { persona: 'conservative', sizeMultiplier: 0.4, reasons: ['c'] },
    ],
    reasons: ['base'],
    ...over,
  };
}

describe('memorySizingTilt (TRA-850 de-risk preference)', () => {
  it('absent memory or no preference ⇒ 1 (no change)', () => {
    expect(memorySizingTilt(undefined)).toBe(1);
    expect(memorySizingTilt({})).toBe(1);
    expect(memorySizingTilt({ riskTolerance: 'moderate' })).toBe(1);
    expect(memorySizingTilt({ riskTolerance: 'aggressive' })).toBe(1); // can only de-risk
  });
  it('explicit sizingMultiplier wins and is clamped to (0,1]', () => {
    expect(memorySizingTilt({ sizingMultiplier: 0.5 })).toBe(0.5);
    expect(memorySizingTilt({ sizingMultiplier: 2 })).toBe(1);
    expect(memorySizingTilt({ sizingMultiplier: 0, riskTolerance: 'aggressive' })).toBe(0.01);
  });
  it('conservative tolerance halves when no explicit multiplier', () => {
    expect(memorySizingTilt({ riskTolerance: 'conservative' })).toBe(0.5);
  });
});

describe('personalizeRiskVerdict (TRA-850)', () => {
  it('shrinks final + persona sizes by the tilt and records a reason', () => {
    const out = personalizeRiskVerdict(verdict(), { sizingMultiplier: 0.5 });
    expect(out.sizeMultiplier).toBe(0.4);
    expect(out.panel.map((p) => p.sizeMultiplier)).toEqual([0.4, 0.3, 0.2]);
    expect(out.reasons.at(-1)).toContain('Personalized');
  });
  it('never enlarges and never flips the verdict (preference is de-risk only)', () => {
    const out = personalizeRiskVerdict(verdict(), { sizingMultiplier: 0.5 });
    expect(out.verdict).toBe('APPROVE');
    expect(out.sizeMultiplier).toBeLessThan(0.8);
  });
  it('is a no-op for a VETO/size-0 verdict (nothing to size)', () => {
    const v = verdict({ verdict: 'VETO', sizeMultiplier: 0 });
    expect(personalizeRiskVerdict(v, { sizingMultiplier: 0.3 })).toBe(v);
  });
  it('is a no-op when memory implies no shrink', () => {
    const v = verdict();
    expect(personalizeRiskVerdict(v, { riskTolerance: 'aggressive' })).toBe(v);
    expect(personalizeRiskVerdict(v, undefined)).toBe(v);
  });
});

describe('runAgentGraph honours user memory (TRA-850)', () => {
  it('a conservative user gets a smaller size than the default, same verdict', async () => {
    const plain = await runAgentGraph(input(rising()));
    const personalized = await runAgentGraph(withMemory(rising(), { riskTolerance: 'conservative' }));
    expect(personalized.verdict).toBe(plain.verdict);
    expect(personalized.sizeMultiplier).toBeCloseTo(plain.sizeMultiplier * 0.5, 6);
    expect(validateAgentRecommendation(personalized)).toEqual([]);
  });
});
