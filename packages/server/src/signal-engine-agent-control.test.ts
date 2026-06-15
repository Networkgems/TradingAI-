import { describe, it, expect } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { AgentRecommendation, TradeSignal } from '@trading-app/shared';

// TRA-848 — human-in-the-loop manual approve/reject from the inbound chat
// surface. Unlike TRA-796 auto-gating, manual approval is the human gate, so it
// routes the proposedSignal even with gating OFF — while keeping the live
// go-live gate, halt, and dedup. These tests drive the engine methods the
// Telegram webhook calls.

type Privates = { latestAgentRecommendations: AgentRecommendation[] };

function buildReco(
  symbol: string,
  asOf: number,
  verdict: 'APPROVE' | 'VETO' = 'APPROVE',
  mode: 'demo' | 'live' = 'demo',
): AgentRecommendation {
  const proposedSignal: TradeSignal | null =
    verdict === 'APPROVE'
      ? {
          id: `agent-${symbol}-${asOf}`,
          symbol,
          type: 'momentum',
          side: 'buy',
          entryPrice: 100,
          stopLoss: 95,
          takeProfit: 110,
          riskRewardRatio: 2,
          timestamp: asOf,
          mode,
        }
      : null;
  return {
    symbol,
    asOf,
    action: verdict === 'APPROVE' ? 'BUY' : 'HOLD',
    conviction: 0.8,
    sizeMultiplier: 0.6,
    proposedSignal,
    verdict,
    analystReports: [],
    debateTranscript: { rounds: [], judgeSummary: '' },
    traderDecision: {
      action: 'BUY', conviction: 0.8, proposedEntry: 100, proposedStop: 95,
      proposedTarget: 110, riskRewardRatio: 2, rationale: '',
    },
    riskVerdict: { verdict, sizeMultiplier: 0.6, panel: [], reasons: [] },
    costUsd: 0,
    latencyMs: 1,
  } as unknown as AgentRecommendation;
}

async function engineFor(mode: 'demo' | 'live'): Promise<SignalEngine> {
  const engine = new SignalEngine(undefined, undefined, undefined);
  await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode });
  return engine;
}

function setRecos(engine: SignalEngine, recos: AgentRecommendation[]): void {
  (engine as unknown as Privates).latestAgentRecommendations = recos;
}

describe('SignalEngine — TRA-848 manual approve/reject', () => {
  it('demo: manual approve routes a risk-checked position even with auto-gating OFF', async () => {
    const engine = await engineFor('demo');
    expect(engine.isTradingAgentsGatingEnabled()).toBe(false); // human is the gate
    setRecos(engine, [buildReco('AAPL', 1_000)]);

    const res = await engine.approveRecommendationById('agent-AAPL-1000', 100);
    expect(res.ok).toBe(true);
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(true);
    // routed reco is dropped from the pending set
    expect(engine.getAgentRecommendations()).toHaveLength(0);
  });

  it('resolves a recommendation by bare symbol, not just the full id', async () => {
    const engine = await engineFor('demo');
    setRecos(engine, [buildReco('TSLA', 2_000)]);
    // price must sit inside the proposedSignal bracket (stop 95 / target 110).
    const res = await engine.approveRecommendationById('tsla', 100);
    expect(res.ok).toBe(true);
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'TSLA')).toBe(true);
  });

  it('refuses to approve a non-APPROVE (VETO) recommendation', async () => {
    const engine = await engineFor('demo');
    setRecos(engine, [buildReco('NVDA', 3_000, 'VETO')]);
    const res = await engine.approveRecommendationById('NVDA', 100);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/VETO/);
    // nothing routed, reco stays pending
    expect(engine.getState().account.openPositions).toHaveLength(0);
  });

  it('refuses an unknown target', async () => {
    const engine = await engineFor('demo');
    setRecos(engine, [buildReco('AAPL', 1_000)]);
    const res = await engine.approveRecommendationById('MSFT', 100);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no pending recommendation/);
  });

  it('live without the board+CTO go-live gate refuses to route', async () => {
    const engine = await engineFor('live');
    expect(engine.isTradingAgentsLiveGatingEnabled()).toBe(false);
    setRecos(engine, [buildReco('AAPL', 1_000, 'APPROVE', 'live')]);
    const res = await engine.approveRecommendationById('AAPL', 100);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/live routing disabled/);
  });

  it('two concurrent approve taps of the same reco open exactly one position', async () => {
    // TRA-848 — TOCTOU hardening: a double-tap (or Telegram redelivering the
    // same update) fires approveRecommendationById twice before the first fill
    // lands. The synchronous id-claim must let exactly one win.
    const engine = await engineFor('demo');
    setRecos(engine, [buildReco('AAPL', 1_000)]);

    const [a, b] = await Promise.all([
      engine.approveRecommendationById('AAPL', 100),
      engine.approveRecommendationById('AAPL', 100),
    ]);

    const okCount = [a, b].filter(r => r.ok).length;
    expect(okCount).toBe(1);
    expect([a, b].find(r => !r.ok)!.reason).toMatch(/already routed|no pending recommendation/);
    expect(engine.getState().account.openPositions.filter(p => p.symbol === 'AAPL')).toHaveLength(1);
    expect(engine.getAgentRecommendations()).toHaveLength(0);
  });

  it('a skipped approve (no quote) releases the claim so a retry can route', async () => {
    // The claim must roll back when routeEquitySignal opens nothing, otherwise a
    // transient skip would permanently wedge the recommendation as "already routed".
    const engine = await engineFor('demo');
    setRecos(engine, [buildReco('AAPL', 1_000)]);

    // No price + no live quote source -> routeEquitySignal opens nothing.
    const skipped = await engine.approveRecommendationById('AAPL', undefined);
    expect(skipped.ok).toBe(false);

    // Retry with a valid in-bracket price now succeeds (claim was released).
    const retry = await engine.approveRecommendationById('AAPL', 100);
    expect(retry.ok).toBe(true);
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(true);
  });

  it('reject drops the recommendation from the pending set without routing', async () => {
    const engine = await engineFor('demo');
    setRecos(engine, [buildReco('AAPL', 1_000), buildReco('TSLA', 1_000)]);
    const res = engine.rejectRecommendationById('AAPL');
    expect(res.ok).toBe(true);
    const remaining = engine.getAgentRecommendations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.symbol).toBe('TSLA');
    expect(engine.getState().account.openPositions).toHaveLength(0);
  });

  it('reject of an unknown target is a no-op failure', async () => {
    const engine = await engineFor('demo');
    setRecos(engine, [buildReco('AAPL', 1_000)]);
    const res = engine.rejectRecommendationById('ZZZZ');
    expect(res.ok).toBe(false);
    expect(engine.getAgentRecommendations()).toHaveLength(1);
  });
});
