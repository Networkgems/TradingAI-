// TRA-1768 — equity entry funnel instrument.
//
// The point of the ticket is that `no positions` currently reads IDENTICALLY whether
// the signal side is dry or a guardrail is eating every candidate. So the tests that
// matter are the ones that prove those two states now produce DIFFERENT bytes — and
// they must drive the SAME function the engine calls. A test that re-implements the
// entry loop proves nothing about the loop that runs, so the funnel assertions below
// go through the real `SignalEngine.routeEquitySignal` / `openSma200Pullback`, reached
// via the private-cast seam the existing signal-engine tests already use.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import { DEFAULT_ACCOUNT_SETTINGS, isStockMarketOpen } from '@trading-app/shared';
import type { Candle, TradeSignal } from '@trading-app/shared';
import {
  beginEquityEntryPass,
  recordEquityEntryPassGated,
  recordEquitySymbolEvaluated,
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
  /** TRA-1793 — the universe sweep. THE loop the engine runs; the tests call the same one. */
  sweepEquityEntryUniverse: (activeSymbols: string[]) => Promise<Array<{ sym: string; candles: Candle[] }>>;
  candleCache: Map<string, Candle[]>;
  /**
   * TRA-1834 — the engine's stable per-instance funnel key. A test that opens a pass
   * DIRECTLY must use the SAME id the engine records candidates under, or the candidate
   * folds into a different slot and the assertion is meaningless.
   */
  feedContextKey: string;
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

/** TRA-1834 — a stable engineId for tests that open a pass DIRECTLY (no engine). */
const E1 = 'engine-test-1';

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

  it('no pass since boot: NO engine block at all — "no reading" is not "the signal is dry"', () => {
    // TRA-1834 — with per-engine keying, "no pass since boot" is an EMPTY list: no engine
    // of that mode has ticked, so there is genuinely nothing to report — not a zero row.
    const { demo, live } = summarizeEquityEntryFunnel();
    expect(demo).toEqual([]);
    expect(live).toEqual([]);
  });

  it('acceptance 2a — a pass that RAN and saw nothing: candidatesEvaluated 0, funnelStatus no_candidates', () => {
    beginEquityEntryPass('demo', E1, { symbolsConsidered: 21 });

    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.label).toBe('demo-1');
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
    // TRA-1834 — no sibling engine nulled this pass, so nothing was truncated.
    expect(demo.passesTruncated).toBe(0);
  });

  it('a GATED pass is NOT a dry signal: candidatesEvaluated stays null and the gate is named', () => {
    // The whole reason passGateBlockedReason exists. A shut market must never be able
    // to stamp `candidatesEvaluated: 0` and libel the strategy as "generating no ideas".
    recordEquityEntryPassGated('demo', E1, 'market_closed');

    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.funnelStatus).toBe('gated');
    expect(demo.funnelStatus).not.toBe('no_candidates'); // the collision this kills
    expect(demo.cumulative.candidatesEvaluated).toBeNull();
    expect(demo.passGateBlockedReason).toBe('market_closed');
    // The tick still fired — never_ran and gated are different states.
    expect(demo.passCount).toBe(1);
    expect(demo.iteratedPassCount).toBe(0);
    // A gate that lands on NO open pass is a clean close, not a truncation.
    expect(demo.passesTruncated).toBe(0);
  });

  // ── Driven through the REAL engine entry chokepoint ─────────────────────────

  it('ENGINE: a candidate that reaches the book counts as admitted (funnelStatus admitting)', async () => {
    const engine = await demoEngine();
    beginEquityEntryPass('demo', priv(engine).feedContextKey, { symbolsConsidered: 21 });

    await priv(engine).routeEquitySignal(buildSignal(), 100, 'deterministic');

    // Sanity: the real engine actually opened the position we are claiming to count.
    expect(engine.getState().account.openPositions.some(p => p.symbol === 'AAPL')).toBe(true);

    const [demo] = summarizeEquityEntryFunnel().demo;
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

    beginEquityEntryPass('demo', priv(engine).feedContextKey, { symbolsConsidered: 21 });
    await priv(engine).routeEquitySignal(buildSignal(), 100, 'deterministic');

    const [demo] = summarizeEquityEntryFunnel().demo;
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
    beginEquityEntryPass('demo', priv(engine).feedContextKey, { symbolsConsidered: 21 });

    // A thin small-cap that cannot be in the curated 21-name liquid universe.
    await priv(engine).routeEquitySignal(buildSignal('ZZZZ', 'sig-zzzz'), 100, 'deterministic');

    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.lastPass.candidatesEvaluated).toBe(1);
    expect(demo.lastPass.admitted).toBe(0);
    expect(demo.lastPass.rejectedByReason).toEqual({ swing_universe: 1 });
    expect(demo.funnelStatus).toBe('all_rejected');
  });

  it('ENGINE: a candidate with no quote is counted and named (was a silent return null)', async () => {
    const engine = await demoEngine();
    beginEquityEntryPass('demo', priv(engine).feedContextKey, { symbolsConsidered: 21 });

    await priv(engine).routeEquitySignal(buildSignal(), undefined, 'deterministic');

    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.lastPass.candidatesEvaluated).toBe(1);
    expect(demo.lastPass.rejectedByReason).toEqual({ no_quote: 1 });
  });

  // ── demo and live are never pooled ──────────────────────────────────────────

  it('demo and live are reported SEPARATELY — a live sleeve holding no risk cannot hide behind demo', async () => {
    const engine = await demoEngine();
    beginEquityEntryPass('demo', priv(engine).feedContextKey, { symbolsConsidered: 21 });
    await priv(engine).routeEquitySignal(buildSignal(), 100, 'deterministic');

    const { demo, live } = summarizeEquityEntryFunnel();
    expect(demo[0].funnelStatus).toBe('admitting');
    // The live book was never touched, and it says so — it does NOT inherit demo's health.
    // No live engine ticked, so the live list is EMPTY (fleet-level never_ran).
    expect(live).toEqual([]);
  });

  it('the cumulative verdict survives a later flat pass — one quiet tick cannot report no_candidates over a book that opened', async () => {
    const engine = await demoEngine();
    const eid = priv(engine).feedContextKey;
    beginEquityEntryPass('demo', eid, { symbolsConsidered: 21 });
    await priv(engine).routeEquitySignal(buildSignal(), 100, 'deterministic');
    // A later tick generates nothing (perfectly normal in a flat market).
    beginEquityEntryPass('demo', eid, { symbolsConsidered: 21 });

    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.lastPass.candidatesEvaluated).toBe(0); // this pass was dry...
    expect(demo.funnelStatus).toBe('admitting');       // ...but the sleeve is demonstrably alive
    expect(demo.cumulative.admitted).toBe(1);
    expect(demo.passCount).toBe(2);
  });

  // ── TRA-1834 — two demo engines never pool, and neither drops the other's counts ──

  it('acceptance 4 — a gated tick on demo-2 does NOT null demo-1 mid-sweep: all 6 symbols counted, passesTruncated 0', () => {
    // The exact regime the 20:10Z capture sat inside: demo-1 is iterating a pass while
    // demo-2 is halted and gates every tick. Before the split, demo-2's gate nulled the
    // SHARED open pass and every symbol demo-1 recorded after it was silently dropped.
    const demo1 = 'engine-demo-1';
    const demo2 = 'engine-demo-2';

    // demo-1 opens a pass and records 3 symbols…
    beginEquityEntryPass('demo', demo1, { symbolsConsidered: 6 });
    recordEquitySymbolEvaluated('demo', demo1);
    recordEquitySymbolEvaluated('demo', demo1);
    recordEquitySymbolEvaluated('demo', demo1);

    // …then demo-2 (halted, "no new entries for the day") gates mid-sweep…
    recordEquityEntryPassGated('demo', demo2, 'risk_halted');

    // …and demo-1 resumes and records 3 more. Under the old mode-only keying these last
    // three hit the null-guard and vanished.
    recordEquitySymbolEvaluated('demo', demo1);
    recordEquitySymbolEvaluated('demo', demo1);
    recordEquitySymbolEvaluated('demo', demo1);

    const { demo } = summarizeEquityEntryFunnel();
    // Two engines, two labelled blocks — never summed into one row.
    expect(demo.map(b => b.engineId).sort()).toEqual([demo1, demo2]);
    const b1 = demo.find(b => b.engineId === demo1)!;
    const b2 = demo.find(b => b.engineId === demo2)!;

    // All 6 survive — nothing was dropped, and NOTHING was truncated.
    expect(b1.lastPass.symbolsEvaluated).toBe(6);
    expect(b1.cumulative.symbolsEvaluated).toBe(6);
    expect(b1.passesTruncated).toBe(0);

    // demo-2's gate landed on ITS OWN (empty) slot — it never touched demo-1's pass.
    expect(b2.funnelStatus).toBe('gated');
    expect(b2.passGateBlockedReason).toBe('risk_halted');
    expect(b2.passesTruncated).toBe(0);
  });
});

// ── TRA-1793 — the SYMBOL layer ────────────────────────────────────────────────
//
// `candidatesEvaluated: 0` on an ITERATED pass is TRA-1768's alarm and reads as "the
// strategy is dry". But three per-symbol `continue`s can skip EVERY symbol before a
// single strategy runs — the pass still iterates, still produces zero candidates, and
// still stamps that byte. That is a DATA problem wearing a STRATEGY verdict's clothes.
//
// Every test below drives `sweepEquityEntryUniverse` — the real method the tick calls.
// Nothing here re-implements the loop, because a test that re-implements the loop proves
// nothing about the loop that runs.

/** 15+ bars ending at `endTs`, one minute apart — enough to clear the `< 15` candle floor. */
function candles(sym: string, endTs: number, count = 20): Candle[] {
  return Array.from({ length: count }, (_v, i) => ({
    symbol: sym,
    timestamp: endTs - (count - 1 - i) * 60_000,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 1_000_000,
  }));
}

/** Mon 2026-07-13, 11:00 ET (15:00 UTC, EDT = UTC-4) — inside RTH, so the TRA-418 gate is ARMED. */
const RTH_OPEN_MS = Date.UTC(2026, 6, 13, 15, 0, 0);

describe('TRA-1793 — a dry signal vs a dead feed', () => {
  const priorSwing = process.env.EQUITY_SWING_MODE;

  beforeEach(() => {
    __resetEquityEntryFunnelForTests();
    delete process.env.EQUITY_SWING_MODE;
    vi.useFakeTimers();
    // The freshness gate only applies while the market is OPEN, and `isStockMarketOpen`
    // reads the wall clock. Pin it inside RTH rather than mocking the module, so the
    // engine runs against the REAL gate — a mocked-open market would prove nothing about
    // the gate that ships.
    vi.setSystemTime(RTH_OPEN_MS);
    expect(isStockMarketOpen()).toBe(true); // the premise of every stale_feed test below
  });

  afterEach(() => {
    vi.useRealTimers();
    if (priorSwing === undefined) delete process.env.EQUITY_SWING_MODE;
    else process.env.EQUITY_SWING_MODE = priorSwing;
    __resetEquityEntryFunnelForTests();
  });

  it('acceptance 2 — EVERY symbol stale: symbolsEvaluated 0, {stale_feed: N}, candidatesEvaluated 0. The pass ran and evaluated NOTHING.', async () => {
    const engine = await demoEngine();
    const universe = ['AAPL', 'MSFT', 'NVDA'];
    // Bars from an hour ago: past MAX_CANDLE_AGE_MS (12 min) — the equity feed is DEAD.
    for (const sym of universe) priv(engine).candleCache.set(sym, candles(sym, RTH_OPEN_MS - 60 * 60_000));

    const evaluable = await priv(engine).sweepEquityEntryUniverse(universe);

    expect(evaluable).toHaveLength(0); // no strategy ran on any symbol
    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.lastPass.symbolsConsidered).toBe(3);
    expect(demo.lastPass.symbolsEvaluated).toBe(0);                     // THE ALARM
    expect(demo.lastPass.symbolsSkippedByReason).toEqual({ stale_feed: 3 });
    // …and here is the collision TRA-1793 exists to kill: the pass ITERATED, so the
    // TRA-1768 funnel reports exactly what a dry Ichimoku would report.
    expect(demo.lastPass.candidatesEvaluated).toBe(0);
    expect(demo.funnelStatus).toBe('no_candidates');
    // The ONLY thing separating "the strategy is dry" from "the feed is dead" is the
    // symbol layer. Without it these two states are byte-identical.
    expect(demo.cumulative.symbolsEvaluated).toBe(0);
    expect(demo.cumulative.symbolsSkippedByReason).toEqual({ stale_feed: 3 });
  });

  it('a COLD candle cache (post-reboot) is insufficient_candles — not a dry strategy', async () => {
    const engine = await demoEngine();
    // Nothing in the cache at all: exactly the state minutes after a redeploy.
    const evaluable = await priv(engine).sweepEquityEntryUniverse(['AAPL', 'MSFT']);

    expect(evaluable).toHaveLength(0);
    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.lastPass.symbolsEvaluated).toBe(0);
    expect(demo.lastPass.symbolsSkippedByReason).toEqual({ insufficient_candles: 2 });
    expect(demo.funnelStatus).toBe('no_candidates'); // …which is why the buckets are load-bearing
  });

  it('swing mode: off_swing_universe is the BENIGN bucket — the evaluated count still separates it from a dead feed', async () => {
    process.env.EQUITY_SWING_MODE = 'true';
    const engine = await demoEngine();
    // AAPL is in the locked 21-name universe; ZZZZ is not. Both have FRESH bars.
    priv(engine).candleCache.set('AAPL', candles('AAPL', RTH_OPEN_MS - 60_000));
    priv(engine).candleCache.set('ZZZZ', candles('ZZZZ', RTH_OPEN_MS - 60_000));

    const evaluable = await priv(engine).sweepEquityEntryUniverse(['AAPL', 'ZZZZ']);

    // The universe gate ate ZZZZ — and AAPL still REACHED strategy evaluation, which is
    // the whole point: a large off_swing_universe count is not an outage.
    expect(evaluable.map(e => e.sym)).toEqual(['AAPL']);
    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.lastPass.symbolsConsidered).toBe(2);
    expect(demo.lastPass.symbolsEvaluated).toBe(1); // > 0 ⇒ the strategy DID run: a real reading
    expect(demo.lastPass.symbolsSkippedByReason).toEqual({ off_swing_universe: 1 });
  });

  it('a GATED pass leaves symbolsEvaluated NULL — never 0. A shut market did not evaluate zero symbols; it evaluated none.', () => {
    recordEquityEntryPassGated('demo', E1, 'market_closed');

    const [demo] = summarizeEquityEntryFunnel().demo;
    expect(demo.funnelStatus).toBe('gated');
    expect(demo.lastPass.symbolsEvaluated).toBeNull();       // NOT 0
    expect(demo.lastPass.symbolsConsidered).toBeNull();
    expect(demo.lastPass.symbolsSkippedByReason).toBeNull();
    expect(demo.cumulative.symbolsEvaluated).toBeNull();
    expect(demo.cumulative.symbolsSkippedByReason).toBeNull();
  });

  it('the symbol counters accrue CUMULATIVELY across passes, and demo never leaks into live', async () => {
    const engine = await demoEngine();
    priv(engine).candleCache.set('AAPL', candles('AAPL', RTH_OPEN_MS - 60_000));

    await priv(engine).sweepEquityEntryUniverse(['AAPL', 'MSFT']); // MSFT: no candles
    await priv(engine).sweepEquityEntryUniverse(['AAPL', 'MSFT']);

    const { demo, live } = summarizeEquityEntryFunnel();
    expect(demo[0].cumulative.symbolsConsidered).toBe(4);
    expect(demo[0].cumulative.symbolsEvaluated).toBe(2);
    expect(demo[0].cumulative.symbolsSkippedByReason).toEqual({ insufficient_candles: 2 });
    expect(demo[0].lastPass.symbolsEvaluated).toBe(1); // the per-pass view is not the cumulative one
    // TRA-1834 — two clean sweeps, no sibling null: nothing truncated.
    expect(demo[0].passesTruncated).toBe(0);
    // The live book swept nothing. No live engine registered, so the list is EMPTY.
    expect(live).toEqual([]);
  });
});
