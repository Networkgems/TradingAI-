// TRA-4442 — the TRA-817 capital-gate manifest at the SECOND equity chokepoint.
//
// TRA-1540 ratified equity = paper-only on the premise that the manifest
// (`PASSED_LIVE_ENTRIES`) is empty, so no stock strategy can open real capital.
// But the manifest was consulted only in `openSma200Pullback` and the tsmom
// router — never in `routeEquitySignal`, which carries ORB / BB-fade / Ichimoku
// into a real Tradier OTOCO in live mode. Under swing mode Ichimoku evaluates
// unconditionally, so on bqb1 the only thing between it and the book was
// `stocksAutoTradingEnabledLive` (default-true). Board ruling on card
// `17786a70`: gate_the_hole — fix `8ae21f09`, scoped to live mode.
//
// These drive the REAL chokepoint, both directions: the live book must name
// `capital_gate_manifest`, and the demo paper book (the forward-test population
// the ruling did not order closed) must still admit the identical signal.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignalEngine, type SymbolState } from './signal-engine.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { TradeSignal } from '@trading-app/shared';
import { PASSED_LIVE_ENTRIES } from './capital-gate-manifest.js';
import {
  beginEquityEntryPass,
  summarizeEquityEntryFunnel,
  __resetEquityEntryFunnelForTests,
} from './equity-entry-funnel.js';

type QuoteLike = {
  price: number; volume: number; change: number; changePct: number; currency?: string;
};

type EngineInternals = {
  applyQuotes(quotes: Map<string, QuoteLike>, activeSymbols: string[]): Map<string, number>;
  symbolState: Map<string, SymbolState>;
  routeEquitySignal(
    signal: TradeSignal,
    price: number | undefined,
    source?: 'deterministic' | 'agent-gating',
  ): Promise<unknown>;
  feedContextKey: string;
};

const asInternals = (e: SignalEngine) => e as unknown as EngineInternals;

const ichimoku = (mode: 'live' | 'demo'): TradeSignal => ({
  id: `sig-ichimoku-${mode}`,
  symbol: 'AAPL',
  type: 'ichimoku',
  side: 'buy',
  entryPrice: 211.2,
  stopLoss: 205,
  takeProfit: 224,
  riskRewardRatio: 2,
  timestamp: Date.now(),
  mode,
} as unknown as TradeSignal);

describe('TRA-4442 — routeEquitySignal consults the capital-gate manifest in live mode', () => {
  const priorSwing = process.env.EQUITY_SWING_MODE;

  beforeEach(() => {
    __resetEquityEntryFunnelForTests();
    // ON is the live posture — the one under which Ichimoku is the path that reaches here.
    process.env.EQUITY_SWING_MODE = 'true';
  });

  afterEach(() => {
    if (priorSwing === undefined) delete process.env.EQUITY_SWING_MODE;
    else process.env.EQUITY_SWING_MODE = priorSwing;
    __resetEquityEntryFunnelForTests();
  });

  async function engineIn(mode: 'live' | 'demo'): Promise<SignalEngine> {
    const engine = new SignalEngine(undefined, undefined, undefined);
    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode });
    const priv = asInternals(engine);
    priv.applyQuotes(new Map<string, QuoteLike>([['AAPL', {
      price: 211.2, volume: 1_000, change: 1.26, changePct: 0.6, currency: 'USD',
    }]]), ['AAPL']);
    beginEquityEntryPass(mode, priv.feedContextKey, { symbolsConsidered: 21 });
    return engine;
  }

  it('precondition: ichimoku is NOT in the manifest (else this file grades nothing)', () => {
    expect(PASSED_LIVE_ENTRIES.some(e => e.strategyId === 'ichimoku')).toBe(false);
  });

  it('LIVE: an in-universe USD ichimoku signal is refused and the funnel names capital_gate_manifest', async () => {
    const engine = await engineIn('live');
    const signal = ichimoku('live');

    const pos = await asInternals(engine).routeEquitySignal(signal, 211.2, 'deterministic');

    expect(pos).toBeNull();
    const [live] = summarizeEquityEntryFunnel().live;
    expect(live.lastPass.candidatesEvaluated).toBe(1);
    expect(live.lastPass.admitted).toBe(0);
    // The discriminating assertion. Any other reason (a missing live client, a
    // swing-universe miss) is a refusal for an unrelated cause — the shape this
    // ticket was filed about.
    expect(live.lastPass.rejectedByReason).toEqual({ capital_gate_manifest: 1 });
    expect((signal as unknown as { liveSkipReason?: string }).liveSkipReason).toMatch(/capital-gate manifest/);
  });

  it('DEMO: the identical signal is still admitted — the guard is scoped, not a book-wide kill', async () => {
    const engine = await engineIn('demo');

    await asInternals(engine).routeEquitySignal(ichimoku('demo'), 211.2, 'deterministic');

    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.lastPass.rejectedByReason).toEqual({});
    expect(demo.lastPass.admitted).toBe(1);
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(true);
  });
});
