// TRA-1768 — equity entry funnel instrument.
//
// The point of the ticket is that `no positions` currently reads IDENTICALLY whether
// the signal side is dry or a guardrail is eating every candidate. So the tests that
// matter are the ones that prove those two states now produce DIFFERENT bytes — and
// they must drive the SAME function the engine calls. A test that re-implements the
// entry loop proves nothing about the loop that runs, so the funnel assertions below
// go through the real `SignalEngine.routeEquitySignal` / `openSma200Pullback`, reached
// via the private-cast seam the existing signal-engine tests already use.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { TradeSignal } from '@trading-app/shared';
import {
  beginEquityEntryPass,
  recordEquityEntryPassGated,
  summarizeEquityEntryFunnel,
  __resetEquityEntryFunnelForTests,
} from './equity-entry-funnel.js';
import {
  CHURN_LOSS_BRAKE_FLAG,
  CHURN_SAME_SESSION_OPEN_CAP_VALUE,
} from './churn-loss-brake-flag.js';
import { clearChurnBrakeLedger } from './churn-brake-ledger.js';

/** The real engine internals we drive. No re-implementation — these ARE the loop. */
type Privates = {
  routeEquitySignal: (
    signal: TradeSignal,
    price: number | undefined,
    source?: 'deterministic' | 'agent-gating',
  ) => Promise<unknown>;
  recordChurnOpen: (symbol: string, sleeve?: string, now?: number) => void;
};

const priv = (e: SignalEngine) => e as unknown as Privates;

/** AAPL is in the locked 21-name swing universe (TRA-955), so it clears the universe gate. */
function buildSignal(symbol = 'AAPL', id = 'sig-1'): TradeSignal {
  return {
    id,
    symbol,
    type: 'momentum',
    side: 'buy',
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    riskRewardRatio: 2,
    timestamp: Date.now(),
    mode: 'demo',
  } as unknown as TradeSignal;
}

async function demoEngine(): Promise<SignalEngine> {
  const engine = new SignalEngine(undefined, undefined, undefined);
  await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
  return engine;
}

describe('TRA-1768 — equity entry funnel', () => {
  const priorFlag = process.env[CHURN_LOSS_BRAKE_FLAG];
  const priorCap = process.env[CHURN_SAME_SESSION_OPEN_CAP_VALUE];

  beforeEach(() => {
    __resetEquityEntryFunnelForTests();
    clearChurnBrakeLedger();
    delete process.env[CHURN_LOSS_BRAKE_FLAG];
    delete process.env[CHURN_SAME_SESSION_OPEN_CAP_VALUE];
  });

  afterEach(() => {
    if (priorFlag === undefined) delete process.env[CHURN_LOSS_BRAKE_FLAG];
    else process.env[CHURN_LOSS_BRAKE_FLAG] = priorFlag;
    if (priorCap === undefined) delete process.env[CHURN_SAME_SESSION_OPEN_CAP_VALUE];
    else process.env[CHURN_SAME_SESSION_OPEN_CAP_VALUE] = priorCap;
    __resetEquityEntryFunnelForTests();
    clearChurnBrakeLedger();
  });

  // ── The three-valued contract: null ≠ 0 ─────────────────────────────────────

  it('no pass since boot: candidatesEvaluated is NULL, not 0 — "no reading" is not "the signal is dry"', () => {
    const { demo } = summarizeEquityEntryFunnel();
    expect(demo.funnelStatus).toBe('never_ran');
    expect(demo.cumulative.candidatesEvaluated).toBeNull();
    expect(demo.lastPass.candidatesEvaluated).toBeNull();
    expect(demo.lastPass.rejectedByReason).toBeNull();
    expect(demo.passCount).toBe(0);
    expect(demo.lastPassAt).toBeNull();
  });

  it('acceptance 2a — a pass that RAN and saw nothing: candidatesEvaluated 0, funnelStatus no_candidates', () => {
    beginEquityEntryPass('demo');

    const { demo } = summarizeEquityEntryFunnel();
    expect(demo.lastPass.candidatesEvaluated).toBe(0);
    expect(demo.cumulative.candidatesEvaluated).toBe(0);
    expect(demo.funnelStatus).toBe('no_candidates');
    // Monotone proof the pass fires at all — the thing that was missing for 8 days.
    expect(demo.passCount).toBe(1);
    expect(demo.iteratedPassCount).toBe(1);
    expect(demo.lastPassAt).not.toBeNull();
    // It RAN. Nothing was held at the gate, so no gate may be blamed.
    expect(demo.passGateBlockedReason).toBeNull();
    // 0 candidates were REJECTED FOR A REASON — there were no candidates at all.
    expect(demo.lastPass.rejectedByReason).toEqual({});
  });

  it('a GATED pass is NOT a dry signal: candidatesEvaluated stays null and the gate is named', () => {
    // The whole reason passGateBlockedReason exists. A shut market must never be able
    // to stamp `candidatesEvaluated: 0` and libel the strategy as "generating no ideas".
    recordEquityEntryPassGated('demo', 'market_closed');

    const { demo } = summarizeEquityEntryFunnel();
    expect(demo.funnelStatus).toBe('gated');
    expect(demo.funnelStatus).not.toBe('no_candidates'); // the collision this kills
    expect(demo.cumulative.candidatesEvaluated).toBeNull();
    expect(demo.passGateBlockedReason).toBe('market_closed');
    // The tick still fired — never_ran and gated are different states.
    expect(demo.passCount).toBe(1);
    expect(demo.iteratedPassCount).toBe(0);
  });

  // ── Driven through the REAL engine entry chokepoint ─────────────────────────

  it('ENGINE: a candidate that reaches the book counts as admitted (funnelStatus admitting)', async () => {
    const engine = await demoEngine();
    beginEquityEntryPass('demo');

    await priv(engine).routeEquitySignal(buildSignal(), 100, 'deterministic');

    // Sanity: the real engine actually opened the position we are claiming to count.
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(true);

    const { demo } = summarizeEquityEntryFunnel();
    expect(demo.cumulative.candidatesEvaluated).toBe(1);
    expect(demo.cumulative.admitted).toBe(1);
    expect(demo.funnelStatus).toBe('admitting');
    expect(demo.cumulative.rejectedByReason).toEqual({});
    expect(demo.cumulative.candidatesBySource).toEqual({ deterministic: 1 });
    expect(demo.lastAdmittedAt).not.toBeNull();
  });

  it('acceptance 2b — ENGINE: 1 candidate eaten by the churn brake reads candidatesEvaluated 1, admitted 0, {churn_brake: 1}', async () => {
    const engine = await demoEngine();
    // Arm TRA-1408 with a cap of 1, then burn the name's single same-session open WITHOUT
    // opening a position — so the signal below dies at the churn brake specifically, not
    // at the already-open dedup that sits ahead of it.
    process.env[CHURN_LOSS_BRAKE_FLAG] = '1';
    process.env[CHURN_SAME_SESSION_OPEN_CAP_VALUE] = '1';
    priv(engine).recordChurnOpen('AAPL');

    beginEquityEntryPass('demo');
    await priv(engine).routeEquitySignal(buildSignal(), 100, 'deterministic');

    const { demo } = summarizeEquityEntryFunnel();
    // The signal FIRED — this is the state that must not look like a dry strategy.
    expect(demo.lastPass.candidatesEvaluated).toBe(1);
    expect(demo.lastPass.admitted).toBe(0);
    expect(demo.lastPass.rejectedByReason).toEqual({ churn_brake: 1 });
    expect(demo.funnelStatus).toBe('all_rejected');
    expect(demo.funnelStatus).not.toBe('no_candidates'); // the distinction that decides everything
    // And no position opened, so `admitted` is counting FILLS, not attempts.
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(false);
  });

  it('ENGINE: a candidate outside the swing universe is named, not silently dropped', async () => {
    const engine = await demoEngine();
    beginEquityEntryPass('demo');

    // A thin small-cap that cannot be in the curated 21-name liquid universe.
    await priv(engine).routeEquitySignal(buildSignal('ZZZZ', 'sig-zzzz'), 100, 'deterministic');

    const { demo } = summarizeEquityEntryFunnel();
    expect(demo.lastPass.candidatesEvaluated).toBe(1);
    expect(demo.lastPass.admitted).toBe(0);
    expect(demo.lastPass.rejectedByReason).toEqual({ swing_universe: 1 });
    expect(demo.funnelStatus).toBe('all_rejected');
  });

  it('ENGINE: a candidate with no quote is counted and named (was a silent return null)', async () => {
    const engine = await demoEngine();
    beginEquityEntryPass('demo');

    await priv(engine).routeEquitySignal(buildSignal(), undefined, 'deterministic');

    const { demo } = summarizeEquityEntryFunnel();
    expect(demo.lastPass.candidatesEvaluated).toBe(1);
    expect(demo.lastPass.rejectedByReason).toEqual({ no_quote: 1 });
  });

  // ── demo and live are never pooled ──────────────────────────────────────────

  it('demo and live are reported SEPARATELY — a live sleeve holding no risk cannot hide behind demo', async () => {
    const engine = await demoEngine();
    beginEquityEntryPass('demo');
    await priv(engine).routeEquitySignal(buildSignal(), 100, 'deterministic');

    const { demo, live } = summarizeEquityEntryFunnel();
    expect(demo.funnelStatus).toBe('admitting');
    // The live book was never touched, and it says so — it does NOT inherit demo's health.
    expect(live.funnelStatus).toBe('never_ran');
    expect(live.cumulative.candidatesEvaluated).toBeNull();
    expect(live.cumulative.admitted).toBeNull();
  });

  it('the cumulative verdict survives a later flat pass — one quiet tick cannot report no_candidates over a book that opened', async () => {
    const engine = await demoEngine();
    beginEquityEntryPass('demo');
    await priv(engine).routeEquitySignal(buildSignal(), 100, 'deterministic');
    // A later tick generates nothing (perfectly normal in a flat market).
    beginEquityEntryPass('demo');

    const { demo } = summarizeEquityEntryFunnel();
    expect(demo.lastPass.candidatesEvaluated).toBe(0); // this pass was dry...
    expect(demo.funnelStatus).toBe('admitting');       // ...but the sleeve is demonstrably alive
    expect(demo.cumulative.admitted).toBe(1);
    expect(demo.passCount).toBe(2);
  });
});
