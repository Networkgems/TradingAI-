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

// TRA-3514 — `llmUsed` now defaults to `true` here, and that default is the honest
// one: `adviseSymbol` stamps EVERY recommendation it mints (true on the paid path,
// false on the deterministic fallback), so an unstamped recommendation is not a state
// production can reach. Pass `false` to exercise the fallback-read refusal.
function buildApprove(
  symbol: string,
  asOf: number,
  conviction = 0.8,
  mode: 'demo' | 'live' = 'demo',
  llmUsed = true,
): AgentRecommendation {
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
    costUsd: 0, latencyMs: 1, llmUsed,
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

  // ── TRA-3514 (TRA-3460 (c) §3) — acceptance #2, at the ENGINE boundary ──────
  //
  // ⭐ This is the pair the acceptance criterion actually asks for, and the value is
  // in the pair, not either half. The test above and the test below are IDENTICAL in
  // every input the ratified gate reads — same $1,000 equity, same $100 notional, same
  // 0.80 conviction, same toggles — and differ in exactly ONE bit: `llmUsed`. So the
  // first proves the rail still routes a real read (a refuse-everything clause would
  // break it), and the second proves a fallback read cannot reach capital. Holding
  // every other axis fixed is what makes the difference attributable to the backing.
  it('REFUSES to auto-confirm the identical proposal when the read is a deterministic fallback', async () => {
    const engine = await demoEngine(1_000);
    engine.setTradingAgents(true);
    priv(engine).latestAgentRecommendations = [buildApprove('AAPL', 1_000, 0.8, 'demo', false)];

    await priv(engine).processAgentProposals(new Map([['AAPL', 100]]));

    // Nothing reached capital...
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(false);
    expect(engine.getAgentOrderAudit().length).toBe(0);
    // ...but the proposal is NOT silently dropped either. The ticket is explicit that
    // a fallback recommendation must still be published; it just waits for a human.
    const pending = engine.getPendingProposals();
    expect(pending.length).toBe(1);
    expect(pending[0]!.symbol).toBe('AAPL');
    // And the card carries the backing, so the panel can badge it after the
    // recommendation set has rotated away.
    expect(pending[0]!.llmUsed).toBe(false);
  });

  it('carries llmUsed:true onto the proposal for an LLM-backed read', async () => {
    // The positive half of the snapshot: the field must not be write-only-false.
    const engine = await demoEngine(); // large notional ⇒ stays pending, so we can read it
    engine.setTradingAgents(true);
    priv(engine).latestAgentRecommendations = [buildApprove('MSFT', 3_000)];

    await priv(engine).processAgentProposals(new Map([['MSFT', 100]]));
    expect(engine.getPendingProposals()[0]!.llmUsed).toBe(true);
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

  it('TRA-1138: a pending proposal still confirms after the advisory set is replaced (new bar)', async () => {
    // Queue a proposal on bar A (large notional → stays pending for a manual confirm).
    const engine = await demoEngine();
    engine.setTradingAgents(true);
    priv(engine).latestAgentRecommendations = [buildApprove('AAPL', 1_000)];
    await priv(engine).processAgentProposals(new Map([['AAPL', 100]]));
    const pending = engine.getPendingProposals();
    expect(pending.length).toBe(1);

    // A later advisory tick rolls to a NEW bar: the set is wholesale-replaced and
    // the proposedSignal id changes (agent-AAPL-2000), so the bar-A reco is gone.
    // Pre-fix this made the proposal unconfirmable ("source recommendation … no
    // longer pending — re-request") even though it was well inside its 15-min TTL.
    priv(engine).latestAgentRecommendations = [buildApprove('MSFT', 2_000)];

    const res = await engine.confirmProposalById((pending[0] as TradeProposal).id, 100);
    expect(res.ok).toBe(true);
    expect(res.reason).not.toMatch(/no longer pending/i);
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(true);
    expect(engine.getAgentOrderAudit().length).toBe(1);
  });

  it('TRA-1138: a pending proposal still rejects after the advisory set is cleared', async () => {
    const engine = await demoEngine();
    engine.setTradingAgents(true);
    priv(engine).latestAgentRecommendations = [buildApprove('NEXR', 1_000)];
    await priv(engine).processAgentProposals(new Map([['NEXR', 100]]));
    const pending = engine.getPendingProposals();
    expect(pending.length).toBe(1);

    priv(engine).latestAgentRecommendations = []; // advisory set wiped (layer churn)

    const res = engine.rejectProposalById((pending[0] as TradeProposal).id, 'changed my mind');
    expect(res.ok).toBe(true);
    expect(engine.getPendingProposals().length).toBe(0);
    expect(engine.getState().account.openPositions.length).toBe(0);
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
