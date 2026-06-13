import { describe, it, expect } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { AgentRecommendation, TradeSignal } from '@trading-app/shared';

// TRA-796 (TRA-529 P4) — gating mode: an APPROVE recommendation's proposedSignal
// is routed as a risk-checked order through the SAME deterministic order path,
// demo-first. These tests drive routeAgentApprovals directly (the per-tick caller
// is already gated on market-hours + halt) so the risk/idempotency/live-gate
// behaviour is asserted in isolation.

type Privates = {
  latestAgentRecommendations: AgentRecommendation[];
  routeAgentApprovals: (prices: Map<string, number>) => Promise<void>;
};

function buildApprove(symbol: string, asOf: number, mode: 'demo' | 'live' = 'demo'): AgentRecommendation {
  const proposedSignal: TradeSignal = {
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
  };
  // routeAgentApprovals only reads verdict + proposedSignal; the rest of the
  // contract is filled with inert values so we don't couple the test to the
  // analyst/debate internals.
  return {
    symbol,
    asOf,
    action: 'BUY',
    conviction: 0.8,
    sizeMultiplier: 0.6,
    proposedSignal,
    verdict: 'APPROVE',
    analystReports: [],
    debateTranscript: { rounds: [], judgeSummary: '' },
    traderDecision: {
      action: 'BUY', conviction: 0.8, proposedEntry: 100, proposedStop: 95,
      proposedTarget: 110, riskRewardRatio: 2, rationale: '',
    },
    riskVerdict: { verdict: 'APPROVE', sizeMultiplier: 0.6, panel: [], reasons: [] },
    costUsd: 0,
    latencyMs: 1,
  } as unknown as AgentRecommendation;
}

async function demoEngine(): Promise<SignalEngine> {
  const engine = new SignalEngine(undefined, undefined, undefined);
  await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
  return engine;
}

function priv(engine: SignalEngine): Privates {
  return engine as unknown as Privates;
}

describe('SignalEngine — TRA-796 agent gating mode', () => {
  it('demo: an APPROVE recommendation routes a risk-checked paper position', async () => {
    const engine = await demoEngine();
    engine.setTradingAgents(true);
    engine.setTradingAgentsGating(true);
    expect(engine.isTradingAgentsGatingEnabled()).toBe(true);

    priv(engine).latestAgentRecommendations = [buildApprove('AAPL', 1_000)];
    await priv(engine).routeAgentApprovals(new Map([['AAPL', 100]]));

    const state = engine.getState();
    expect(state.account.openPositions.some(p => p.symbol === 'AAPL')).toBe(true);
    expect(state.tradingAgentsGatingEnabled).toBe(true);
    expect(state.tradingAgentsLiveGatingEnabled).toBe(false);
  });

  it('advisor-only (gating OFF): an APPROVE recommendation never opens a position', async () => {
    const engine = await demoEngine();
    engine.setTradingAgents(true);
    // gating left OFF
    priv(engine).latestAgentRecommendations = [buildApprove('AAPL', 1_000)];
    await priv(engine).routeAgentApprovals(new Map([['AAPL', 100]]));
    expect(engine.getState().account.openPositions.length).toBe(0);
  });

  it('HOLD/VETO recommendations (no proposedSignal) never route', async () => {
    const engine = await demoEngine();
    engine.setTradingAgents(true);
    engine.setTradingAgentsGating(true);
    const veto = buildApprove('AAPL', 1_000);
    (veto as { verdict: string }).verdict = 'VETO';
    (veto as { proposedSignal: TradeSignal | null }).proposedSignal = null;
    priv(engine).latestAgentRecommendations = [veto];
    await priv(engine).routeAgentApprovals(new Map([['AAPL', 100]]));
    expect(engine.getState().account.openPositions.length).toBe(0);
  });

  it('kill switch overrides agent orders — nothing routes while engaged', async () => {
    const engine = await demoEngine();
    engine.setTradingAgents(true);
    engine.setTradingAgentsGating(true);
    engine.engageKillSwitch('test halt');
    priv(engine).latestAgentRecommendations = [buildApprove('AAPL', 1_000)];
    await priv(engine).routeAgentApprovals(new Map([['AAPL', 100]]));
    expect(engine.getState().account.openPositions.length).toBe(0);

    // Releasing the kill switch lets the same recommendation route.
    engine.releaseKillSwitch();
    await priv(engine).routeAgentApprovals(new Map([['AAPL', 100]]));
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(true);
  });

  it('idempotency: the same recommendation cannot double-fire across ticks', async () => {
    const engine = await demoEngine();
    engine.setTradingAgents(true);
    engine.setTradingAgentsGating(true);
    const reco = buildApprove('AAPL', 1_000);
    priv(engine).latestAgentRecommendations = [reco];
    await priv(engine).routeAgentApprovals(new Map([['AAPL', 100]]));
    await priv(engine).routeAgentApprovals(new Map([['AAPL', 100]]));
    const opened = engine.getState().account.openPositions.filter(p => p.symbol === 'AAPL');
    expect(opened.length).toBe(1);
  });

  it('demo-first: live mode is blocked unless the live go-live flag is set', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' });
    engine.setTradingAgents(true);
    engine.setTradingAgentsGating(true); // gating on, live flag OFF
    expect(engine.isTradingAgentsLiveGatingEnabled()).toBe(false);

    const reco = buildApprove('AAPL', 1_000, 'live');
    priv(engine).latestAgentRecommendations = [reco];
    await priv(engine).routeAgentApprovals(new Map([['AAPL', 100]]));

    // Never reached the order path: the signal is stamped with the live-gate
    // skip reason and no broker call was attempted.
    expect(reco.proposedSignal?.liveSkipReason).toMatch(/live routing disabled/i);
  });

  it('live go-live flag lets routing reach the risk path (past the gating block)', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' });
    engine.setTradingAgents(true);
    engine.setTradingAgentsGating(true, true); // both flags on
    expect(engine.isTradingAgentsLiveGatingEnabled()).toBe(true);

    const reco = buildApprove('AAPL', 1_000, 'live');
    priv(engine).latestAgentRecommendations = [reco];
    await priv(engine).routeAgentApprovals(new Map([['AAPL', 100]]));

    // With no Tradier equity client wired in this unit test, the order path
    // itself declines — but with the gating-disabled reason, proving the live
    // gate opened the path through to the deterministic risk/broker step.
    expect(reco.proposedSignal?.liveSkipReason).not.toMatch(/live routing disabled/i);
    expect(reco.proposedSignal?.liveSkipReason).toMatch(/Tradier equity client not configured/i);
  });
});
