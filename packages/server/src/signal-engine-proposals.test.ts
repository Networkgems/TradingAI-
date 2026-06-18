import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { AgentRecommendation, TradeProposal, TradeSignal } from '@trading-app/shared';
import { resetProposalStoreForTests } from './proposal-store.js';
import { resetExecutionCapsForTests, recordExecutedOrder } from './agent-execution-caps-store.js';
import { LLM_KILL_ENV_VAR } from './trading-agents-advisory.js';

// TRA-941 (TRA-813 P2/3) — end-to-end through the engine: an APPROVE
// recommendation becomes a pending proposal; the demo auto-confirm rule routes
// eligible ones; kill switches and the ratified daily caps block execution; and
// every placed order emits an audit-trail entry. We drive processAgentProposals
// (the per-tick caller, private) and the public confirm/reject methods directly.

type Privates = {
  latestAgentRecommendations: AgentRecommendation[];
  processAgentProposals: (prices: Map<string, number>) => Promise<void>;
  account: { applyEquity: (e: number) => void };
};

function buildApprove(symbol: string, asOf: number, conviction = 0.8, mode: 'demo' | 'live' = 'demo'): AgentRecommendation {
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
  return {
    symbol, asOf, action: 'BUY', conviction, sizeMultiplier: 0.6, proposedSignal,
    verdict: 'APPROVE', analystReports: [], debateTranscript: { rounds: [], judgeSummary: '' },
    traderDecision: { action: 'BUY', conviction, proposedEntry: 100, proposedStop: 95, proposedTarget: 110, riskRewardRatio: 2, thesis: 'breakout', dissent: 'overbought' },
    riskVerdict: { verdict: 'APPROVE', sizeMultiplier: 0.6, panel: [], reasons: [] },
    costUsd: 0, latencyMs: 1,
  } as unknown as AgentRecommendation;
}

async function demoEngine(equity?: number): Promise<SignalEngine> {
  const engine = new SignalEngine(undefined, undefined, undefined);
  await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
  if (equity !== undefined) (engine as unknown as Privates).account.applyEquity(equity);
  return engine;
}

function priv(engine: SignalEngine): Privates {
  return engine as unknown as Privates;
}

describe('SignalEngine — TRA-941 proposal queue + execution', () => {
  beforeEach(() => {
    resetProposalStoreForTests();
    resetExecutionCapsForTests();
    delete process.env[LLM_KILL_ENV_VAR];
  });
  afterEach(() => {
    delete process.env[LLM_KILL_ENV_VAR];
  });

  it('auto-confirms an eligible demo proposal, routes it, and emits an audit entry', async () => {
    // Small equity → notional ≈ $100 (≤ $250), conviction 0.8 (≥ 0.70) → auto-confirm.
    const engine = await demoEngine(1_000);
    engine.setTradingAgents(true);
    priv(engine).latestAgentRecommendations = [buildApprove('AAPL', 1_000)];

    await priv(engine).processAgentProposals(new Map([['AAPL', 100]]));

    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(true);
    const audit = engine.getAgentOrderAudit();
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({
      symbol: 'AAPL', mode: 'demo', agentId: 'trading-agents',
      recommendationId: 'agent-AAPL-1000',
    });
    expect(audit[0]!.proposalId).toMatch(/^prop-/);
    // No longer pending once executed.
    expect(engine.getPendingProposals().length).toBe(0);
  });

  it('queues (does NOT auto-confirm) a large-notional demo proposal; manual confirm routes it', async () => {
    const engine = await demoEngine(); // default equity → notional ≫ $250
    engine.setTradingAgents(true);
    priv(engine).latestAgentRecommendations = [buildApprove('MSFT', 2_000)];

    await priv(engine).processAgentProposals(new Map([['MSFT', 100]]));
    const pending = engine.getPendingProposals();
    expect(pending.length).toBe(1);
    expect(engine.getState().account.openPositions.length).toBe(0); // not auto-confirmed

    const res = await engine.confirmProposalById((pending[0] as TradeProposal).id, 100);
    expect(res.ok).toBe(true);
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'MSFT')).toBe(true);
    expect(engine.getAgentOrderAudit().length).toBe(1);
  });

  it('kill-switch-off (env kill) blocks execution — proposal stays pending, no position', async () => {
    process.env[LLM_KILL_ENV_VAR] = '1';
    const engine = await demoEngine(1_000);
    engine.setTradingAgents(true);
    priv(engine).latestAgentRecommendations = [buildApprove('AAPL', 1_000)];

    await priv(engine).processAgentProposals(new Map([['AAPL', 100]]));

    expect(engine.getState().account.openPositions.length).toBe(0);
    expect(engine.getPendingProposals().length).toBe(1); // queued, not dropped
    expect(engine.getAgentOrderAudit().length).toBe(0);
  });

  it('kill-switch-off (banner toggle) blocks a manual confirm', async () => {
    const engine = await demoEngine(); // large notional → stays pending
    engine.setTradingAgents(true);
    priv(engine).latestAgentRecommendations = [buildApprove('AAPL', 1_000)];
    await priv(engine).processAgentProposals(new Map([['AAPL', 100]]));
    const pending = engine.getPendingProposals();
    expect(pending.length).toBe(1);

    engine.setTradingAgents(false); // banner OFF cuts execution to zero
    const res = await engine.confirmProposalById((pending[0] as TradeProposal).id, 100);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/banner toggle is OFF/i);
    expect(engine.getState().account.openPositions.length).toBe(0);
  });

  it('cap-exceeded blocks execution (demo runaway soft cap)', async () => {
    // Pre-fill the day with 50 demo orders for the engine's (anonymous) user.
    for (let i = 0; i < 50; i++) recordExecutedOrder({ user: undefined, mode: 'demo', notional: 10 });
    const engine = await demoEngine(1_000); // would otherwise auto-confirm
    engine.setTradingAgents(true);
    priv(engine).latestAgentRecommendations = [buildApprove('AAPL', 1_000)];

    await priv(engine).processAgentProposals(new Map([['AAPL', 100]]));

    expect(engine.getState().account.openPositions.length).toBe(0);
    expect(engine.getPendingProposals().length).toBe(1); // queued for manual approval
    expect(engine.getAgentOrderAudit().length).toBe(0);
  });

  it('reject captures a reason and drops the proposal without routing', async () => {
    const engine = await demoEngine();
    engine.setTradingAgents(true);
    priv(engine).latestAgentRecommendations = [buildApprove('AAPL', 1_000)];
    await priv(engine).processAgentProposals(new Map([['AAPL', 100]]));
    const pending = engine.getPendingProposals();
    expect(pending.length).toBe(1);

    const empty = engine.rejectProposalById((pending[0] as TradeProposal).id, '   ');
    expect(empty.ok).toBe(false); // reason required

    const res = engine.rejectProposalById((pending[0] as TradeProposal).id, 'bad timing');
    expect(res.ok).toBe(true);
    expect(engine.getPendingProposals().length).toBe(0);
    expect(engine.getState().account.openPositions.length).toBe(0);
  });
});
