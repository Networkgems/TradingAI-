import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import type { AccountSettings, Position } from '@trading-app/shared';
import type { BacktestResult } from '@trading-app/backtest';

// DATA_DIR is read at module-eval time inside trade-store / promotion-store, so
// it must be set BEFORE those modules load. We therefore set it here and pull
// the units in via dynamic import() inside beforeAll (after the env is set).
const DATA_DIR = mkdtempSync(join(tmpdir(), 'promo-svc-'));
process.env['DATA_DIR'] = DATA_DIR;

const USER = 'alice';

let svc: typeof import('./promotion-service.js');
let store: typeof import('./promotion-store.js');
let tradeStore: typeof import('./trade-store.js');

const DAY_MS = 24 * 60 * 60 * 1000;

function paperTrade(pnl: number, i: number): Position {
  // Space trades one per day so the ledger spans ~weeks — long enough for the
  // gate to annualize the paper Sharpe (TRA-538); a near-zero span would mark
  // the Sharpe unverified and fail Stage 2.
  return {
    id: `t${i}`,
    symbol: 'SPY',
    side: 'buy',
    signalType: 'dca',
    entryPrice: 100,
    quantity: 1,
    stopLoss: 99, // risk distance 1 → R == pnl
    takeProfit: 103,
    openedAt: i * DAY_MS,
    closedAt: i * DAY_MS + 3_600_000,
    pnl,
    mode: 'demo',
  };
}

function passingReport(): BacktestResult {
  return {
    sharpeRatio: 1.3,
    expectancy: 0.2,
    profitFactor: 1.6,
    maxDrawdown: 0.12,
    totalTrades: 130,
  } as BacktestResult;
}

/**
 * TRA-1465 — a passing accumulation-backtest verdict for the accumulate-class
 * `dca` strategy. DCA has no per-trade timing edge for the six-guard battery, so
 * its Stage 1 is cleared with accumulation-robustness metrics (a long OOS window,
 * a firing-but-not-degenerate trend gate, bounded drawdown that beats lump-sum,
 * cadence robustness, and per-fill cost survival) rather than an optimization
 * verdict — registering a six-guard verdict for `dca` is now rejected by the store.
 */
function passingAccumBacktestMetrics(): import('@trading-app/shared').AccumulationBacktestGateMetrics {
  return {
    oosDays: 200,
    deploymentRatio: 0.6,
    valueInvestedMaxDrawdown: 0.2,
    lumpSumMaxDrawdown: 0.4,
    oosReturn: 0.3,
    lumpSumReturn: 0.25,
    cadenceVariantsTested: 3,
    cadenceVariantsConsistent: 3,
    feeAdjustedValueRatio: 1.05,
  };
}

beforeAll(async () => {
  svc = await import('./promotion-service.js');
  store = await import('./promotion-store.js');
  tradeStore = await import('./trade-store.js');
});

// TRA-4629 — the crypto engine (and with it the live-crypto promotion axis and
// the DCA accumulation demo book) is removed. What remains under test here:
// buildPromotionStatus stays FAIL-CLOSED for the accumulate class (its Stage-2
// ledger source is gone, so the leg reads `missing` and can never pass), and a
// demo save is never gated.
describe('TRA-4629 promotion gate — accumulate class is fail-closed without its ledger', () => {
  it('dca stays canGoLive=false even with a passing Stage-1 accumulation verdict', async () => {
    await store.registerAccumulationBacktestVerdict({
      strategyId: 'dca',
      metrics: passingAccumBacktestMetrics(),
      reportId: 'TRA-695',
      registeredBy: 'qt',
    });
    const status = await svc.buildPromotionStatus(USER, 'dca');
    expect(status.strategyClass).toBe('accumulate');
    expect(status.backtest.state).toBe('pass'); // Stage 1 evidence still honoured…
    expect(status.paper.state).toBe('missing'); // …but Stage 2 has no source left
    expect(status.paper.accumulation ?? null).toBeNull();
    expect(status.canGoLive).toBe(false);
    expect(status.blockedReasons.join(' ')).toMatch(/Stage 2 \(accumulation\) missing/);
  });

  it('never blocks a settings change that stays in Demo', async () => {
    const demoSettings = { mode: 'demo' } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate('bob-unpromoted', demoSettings);
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });
});

// TRA-1436 (parent TRA-1434) — the promotion gate must be ENVIRONMENT-AWARE when
// armed: Live + Tradier Environment = Sandbox (paper) risks zero real capital and
// is the intended paper-validation path, so it must NOT be blocked by strategy
// promotion. Live + Tradier Production (real money) stays fail-closed. Since
// TRA-4601 the Production axis is graded regardless of the PROMOTION_GATE_ENV_AWARE
// flag. The flag is read from process.env at call time, so we toggle it per-test.
describe('TRA-1436 promotion gate — environment-aware (Tradier Sandbox exempt)', () => {
  const FLAG = 'PROMOTION_GATE_ENV_AWARE';
  const ENV_USER = 'env-aware-user'; // no promoted strategies seeded for this user

  // Live options-only intent; the RV/OTM sleeves are unpromoted for ENV_USER,
  // so a Production route must block.
  function liveOptions(env: 'sandbox' | 'production'): AccountSettings {
    return {
      mode: 'live',
      liveTradierEnvOptions: env,
    } as AccountSettings;
  }

  it('(a) Live + Tradier Sandbox + unpromoted strategy → ALLOWED (zero real capital)', async () => {
    process.env[FLAG] = '1';
    try {
      const gate = await svc.evaluateLiveTransitionGate(ENV_USER, liveOptions('sandbox'));
      expect(gate.allowed).toBe(true);
      expect(gate.blocked).toHaveLength(0);
    } finally {
      delete process.env[FLAG];
    }
  });

  it('(b) Live + Tradier Production → BLOCKED on the OPTIONS sleeves (TRA-1916)', async () => {
    process.env[FLAG] = '1';
    try {
      const gate = await svc.evaluateLiveTransitionGate(ENV_USER, liveOptions('production'));
      expect(gate.allowed).toBe(false);
      const blockedIds = gate.blocked.map(b => b.strategyId);
      // TRA-1916 — an options production switch is judged against the options
      // roster the board named (RV + OTM Mispricing), fail-closed while both are
      // unpromoted.
      expect(blockedIds).toContain('single_leg_rv');
      expect(blockedIds).toContain('single_leg_otm');
    } finally {
      delete process.env[FLAG];
    }
  });

  it('TRA-4601: Production options are gated even with the env-aware flag OFF', async () => {
    // WAS: "flag OFF (default) preserves the legacy crypto-only trigger —
    // Production options NOT gated", asserting `allowed === true`.
    //
    // That was a characterization of the defect, not a requirement. The flag
    // defaults OFF and is declared in neither the production intent manifest nor
    // render.yaml, so the shipped configuration never checked a Production
    // options route against the RV/OTM promotion records. The axis is now graded
    // unconditionally; the flag no longer speaks for it.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, liveOptions('production'));
    expect(gate.allowed).toBe(false);
    expect(gate.blocked.map((b) => b.strategyId).sort()).toEqual(
      ['single_leg_otm', 'single_leg_rv'],
    );
  });

  it('TRA-4601: Sandbox options stay ungated with the flag OFF — zero capital is exempt', async () => {
    // The negative control. If the row above went red for a reason OTHER than
    // the production axis, this one would go red too — sandbox risks no real
    // money and IS the paper environment the gate demands.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, liveOptions('sandbox'));
    expect(gate.allowed).toBe(true);
  });
});

// TRA-1590 — de-escalation exemption. A PUT that HOLDS or REDUCES real-capital
// intent must never block on the current state's gate failure, so an operator
// can always move toward safety. Only an axis the save NEWLY activates is gated.
// ENV_USER has no promoted strategies, so any *escalating* save would block.
describe('TRA-1590 promotion gate — de-escalation saves are never blocked', () => {
  const ENV_USER = 'env-aware-user';

  it('an unrelated edit that HOLDS an already-live Production route still saves', async () => {
    // The deadlock the exemption exists for: the exposed roster is unchanged,
    // so no NEW real-capital intent → the save must succeed even though the
    // sleeves are unpromoted for this user.
    const previous = {
      mode: 'live',
      liveTradierEnvOptions: 'production',
    } as AccountSettings;
    const updated = { ...previous, riskPerTrade: 1 } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });
});

// TRA-4601 — the options-production axis is graded UNCONDITIONALLY (the
// env-aware flag defaults OFF and is absent from the production intent
// manifest; leaving the axis behind it would have disarmed the gate entirely
// once the crypto-only legacy trigger was removed with TRA-4629).
describe('TRA-4601 promotion gate — options production graded unconditionally', () => {
  const FLAG = 'PROMOTION_GATE_ENV_AWARE';
  const ENV_USER = 'env-aware-user'; // no promoted strategies

  it('TRA-4601: the options axis is gated on escalation even with the flag OFF', async () => {
    // WAS: "the options axis is still ungated while the env-aware flag is OFF",
    // asserting `allowed === true`. Sandbox → Production IS an escalation of
    // real-capital intent and is exactly what the gate exists to stop; the
    // TRA-1590 de-escalation exemption still lets the reverse move through (see
    // the sandbox control below).
    delete process.env[FLAG];
    const previous = {
      mode: 'live',
      liveTradierEnvOptions: 'sandbox',
    } as AccountSettings;
    const updated = { ...previous, liveTradierEnvOptions: 'production' } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
    expect(gate.allowed).toBe(false);
  });

  it('TRA-4601: de-escalation Production → Sandbox is still always allowed', async () => {
    // The direction that must never block, or an operator cannot wind down a
    // gate-failing live path.
    delete process.env[FLAG];
    const previous = {
      mode: 'live',
      liveTradierEnvOptions: 'production',
    } as AccountSettings;
    const updated = { ...previous, liveTradierEnvOptions: 'sandbox' } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
    expect(gate.allowed).toBe(true);
  });
});

// TRA-541 — buildPromotionStatus must honor a registered TRA-540 optimization
// verdict: the Stage-1 leg passes iff verdict.pass, regardless of how strong the
// ingested headline metrics look.
describe('TRA-541 promotion gate — optimization verdict gates Stage 1', () => {
  const strongMetrics = { sharpe: 1.4, expectancy: 0.25, profitFactor: 1.7, maxDrawdown: 0.1, tradeCount: 120 };

  it('FAILS Stage 1 when verdict.pass=false even with strong ingested metrics', async () => {
    await store.registerOptimizationVerdict({
      strategyId: 'reversal',
      verdict: {
        pass: false,
        guards: { G2: { pass: false, value: 1 }, G4: { pass: false, value: -50 } },
        blessedParams: { strategy: 'reversal', label: 'rsiOverbought=70,lookback=5' },
        backtestMetrics: strongMetrics,
      },
      reportId: 'tra540-reversal',
      registeredBy: 'qt',
    });
    const status = await svc.buildPromotionStatus(USER, 'reversal');
    expect(status.backtest.metrics?.sharpe).toBe(1.4); // strong metrics ingested 1:1
    expect(status.backtest.state).toBe('fail'); // …but the verdict blocks the leg
    expect(status.backtest.verdict?.pass).toBe(false);
    expect(status.backtest.failedChecks.join(' ')).toMatch(/verdict FAIL/);
    expect(status.canGoLive).toBe(false);
  });

  it('PASSES Stage 1 once a verdict.pass=true is registered', async () => {
    await store.registerOptimizationVerdict({
      strategyId: 'reversal',
      verdict: {
        pass: true,
        guards: { G1: { pass: true, value: 0.8 } },
        blessedParams: { strategy: 'reversal', label: 'rsiOverbought=70,lookback=5' },
        backtestMetrics: strongMetrics,
      },
      reportId: 'tra540-reversal-v2',
      registeredBy: 'qt',
    });
    const status = await svc.buildPromotionStatus(USER, 'reversal');
    expect(status.backtest.state).toBe('pass');
    expect(status.backtest.verdict?.pass).toBe(true);
  });
});

// TRA-542 — fail-closed: registering a bare backtest report (the legacy
// `POST /api/promotion/backtest` path, no TRA-540 verdict) must NOT clear Stage 1,
// even when its metrics beat every legacy raw threshold.
describe('TRA-542 promotion gate — Stage 1 is fail-closed without a verdict', () => {
  it('keeps Stage 1 failing when only a verdict-less backtest report is registered', async () => {
    await store.registerBacktestReport({
      strategyId: 'legacy_only',
      report: passingReport(), // clears every legacy raw threshold
      reportId: 'TRA-405-legacy',
      registeredBy: 'qt',
    });
    const status = await svc.buildPromotionStatus(USER, 'legacy_only');
    expect(status.backtest.metrics?.sharpe).toBe(1.3); // metrics ingested…
    expect(status.backtest.verdict ?? null).toBeNull(); // …but no verdict on record
    expect(status.backtest.state).toBe('fail'); // → fail-closed
    expect(status.backtest.failedChecks.join(' ')).toMatch(/no TRA-540 optimization verdict registered/);
    expect(status.canGoLive).toBe(false);
  });
});

// TRA-536 — the paper fill paths now stamp realized/modeled slippage on each
// closed Position. Once present in the ledger the Stage-2 slippage check stops
// being advisory: the gate computes a non-null ratio and hard-fails a strategy
// whose realized slippage runs above 1.5× modeled.
describe('TRA-536 promotion gate — slippage check enforces once instrumented', () => {
  const SLIP_USER = 'carol';
  // Slippage is a CLOSE-based Stage-2 check (it lives on the closed-trade paper
  // leg), so it is exercised against a close-based strategy.
  const SLIP_STRAT = 'bb_fade';

  function slipTrade(pnl: number, i: number, realized: number, modeled: number): Position {
    return {
      ...paperTrade(pnl, i),
      id: `s${i}`,
      signalType: SLIP_STRAT,
      realizedSlippage: realized,
      modeledSlippage: modeled,
    };
  }

  async function seedSlipLedger(closed: Position[]): Promise<void> {
    await tradeStore.saveStocksTradeSnapshot(SLIP_USER, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: [],
      closedPositions: closed,
      recentSignals: [],
      dailySignals: [],
      positionSignalType: [],
      options: {
        openOptions: [], closedOptions: [], optionsPnl: 0,
        dailyCount: 0, currentDayKey: '1970-01-01', cash: 25_000, equity: 25_000,
      },
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0 },
    });
  }

  it('surfaces a non-null slippageRatio and blocks when realized > 1.5× modeled', async () => {
    // 60 monitored close-based trades that clear count / expectancy / Sharpe, but
    // each fill drifted 2× the modeled budget → ratio 2.0 > 1.5 cap.
    const closed = Array.from({ length: 60 }, (_, i) => slipTrade(i % 6 === 0 ? -0.5 : 1.5, i, 2, 1));
    await seedSlipLedger(closed);

    const status = await svc.buildPromotionStatus(SLIP_USER, SLIP_STRAT);
    // The close-based paper leg governs Stage 2 for this strategy; the slippage
    // ratio is computed from the instrumented fills and fails above the cap.
    expect(status.paper.metrics?.slippageRatio).toBeCloseTo(2, 6);
    expect(status.paper.metrics?.slippageSampleSize).toBe(60);
    expect(status.paper.state).toBe('fail');
    expect(status.paper.failedChecks.join(' ')).toMatch(/realized slippage .*modeled/i);
    expect(status.canGoLive).toBe(false);
  });

  it('passes the slippage check when realized stays within the 1.5× cap', async () => {
    const closed = Array.from({ length: 60 }, (_, i) => slipTrade(i % 6 === 0 ? -0.5 : 1.5, i, 1, 1));
    await seedSlipLedger(closed);

    const status = await svc.buildPromotionStatus(SLIP_USER, SLIP_STRAT);
    expect(status.paper.metrics?.slippageRatio).toBeCloseTo(1, 6);
    expect(status.paper.failedChecks.join(' ')).not.toMatch(/slippage/i);
    expect(status.paper.state).toBe('pass');
  });
});

// TRA-801 — SupertrendConfluence is promoted to a monitored PAPER forward test
// (Stage-2 accrual) while its real-chain backtest is still blocked on TRA-382 and
// no Stage-3 sign-off exists. The SAFETY INVARIANT: no matter how strong the paper
// metrics get, `evaluatePromotion` must keep `canGoLive=false` until a Stage-1
// verdict AND a Stage-3 sign-off are on record. Paper trades for the strategy land
// in the STOCKS ledger's `closedPositions` stamped `signalType:supertrend_confluence`.
describe('TRA-801 SupertrendConfluence paper accrual — live stays gated', () => {
  const ST_USER = 'supertrend-forward';
  const STRATEGY = 'supertrend_confluence';

  function stPaperTrade(pnl: number, i: number): Position {
    // One trade per day so the ledger spans enough calendar days for the gate
    // to annualize the paper Sharpe (mirrors the dca helper above).
    return {
      id: `st${i}`,
      symbol: 'AAPL',
      side: 'buy',
      signalType: STRATEGY,
      entryPrice: 100,
      quantity: 1,
      stopLoss: 99,
      takeProfit: 103,
      openedAt: i * DAY_MS,
      closedAt: i * DAY_MS + 3_600_000,
      pnl,
      mode: 'demo',
    };
  }

  async function seedStocksLedger(closed: Position[]): Promise<void> {
    await tradeStore.saveStocksTradeSnapshot(ST_USER, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: [],
      closedPositions: closed,
      recentSignals: [],
      dailySignals: [],
      positionSignalType: [],
      options: {
        openOptions: [], closedOptions: [], optionsPnl: 0,
        dailyCount: 0, currentDayKey: '1970-01-01', cash: 25_000, equity: 25_000,
      },
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0 },
    });
  }

  it('surfaces Stage-2 paper accruing from the stocks ledger for the supertrend strategyId', async () => {
    // A handful of closed paper trades — count climbing, below the 50 threshold.
    await seedStocksLedger(Array.from({ length: 12 }, (_, i) => stPaperTrade(i % 6 === 0 ? -0.5 : 1.5, i)));
    const status = await svc.buildPromotionStatus(ST_USER, STRATEGY);
    expect(status.paper.tradeCount).toBe(12);
    expect(status.paper.metrics?.tradeCount).toBe(12);
    // Below the 50-trade Stage-2 threshold → not yet a pass, but accruing.
    expect(status.paper.state).toBe('fail');
    expect(status.canGoLive).toBe(false);
  });

  it('keeps canGoLive=false even once paper metrics fully PASS (Stage 1 missing + no sign-off)', async () => {
    // 60 monitored paper trades that clear count / expectancy / Sharpe.
    await seedStocksLedger(Array.from({ length: 60 }, (_, i) => stPaperTrade(i % 6 === 0 ? -0.5 : 1.5, i)));
    const status = await svc.buildPromotionStatus(ST_USER, STRATEGY);
    expect(status.paper.state).toBe('pass'); // Stage 2 fully satisfied…
    expect(status.backtest.state).toBe('missing'); // …but Stage 1 backtest blocked (TRA-382)
    expect(status.signoff).toBe('absent'); // …and no Stage-3 sign-off
    expect(status.canGoLive).toBe(false); // → SAFETY INVARIANT holds
    expect(status.blockedReasons.join(' ')).toMatch(/Stage 1/);
    expect(status.blockedReasons.join(' ')).toMatch(/sign-off/i);
  });

  // TRA-936 — the durable cumulative ledger (`supertrendPaperClosed`) is the
  // restart/archive-stable source for Stage-2: trades counted from it even when
  // the nightly archive has blanked `closedPositions`, and a trade present in
  // BOTH lists (same id, e.g. mid-session) is counted exactly once.
  it('counts Stage-2 paper trades from the durable supertrendPaperClosed ledger (archive-stable, de-duped)', async () => {
    // Distinct user so this does not clobber ST_USER's 60-trade seed that the
    // TRA-803 probe block below depends on.
    const DURABLE_USER = 'supertrend-durable';
    const durable = Array.from({ length: 12 }, (_, i) => stPaperTrade(i % 6 === 0 ? -0.5 : 1.5, i));
    await tradeStore.saveStocksTradeSnapshot(DURABLE_USER, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: [],
      // `closedPositions` blanked by the nightly archive; the first two trades
      // are ALSO still present here (overlap) to prove de-dupe by id.
      closedPositions: durable.slice(0, 2),
      recentSignals: [],
      dailySignals: [],
      positionSignalType: [],
      options: {
        openOptions: [], closedOptions: [], optionsPnl: 0,
        dailyCount: 0, currentDayKey: '1970-01-01', cash: 25_000, equity: 25_000,
      },
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0 },
      supertrendPaperClosed: durable,
    });
    const status = await svc.buildPromotionStatus(DURABLE_USER, STRATEGY);
    expect(status.paper.tradeCount).toBe(12); // 12 durable ∪ 2 overlapping = 12, not 14
  });

  it('an empty promotion record (ensureStrategyRegistered) does not advance the gate', async () => {
    // Registering the strategy so it appears on the overview list must NOT clear
    // any stage — Stage 1 stays `missing`, live stays refused.
    await store.ensureStrategyRegistered(STRATEGY);
    const rec = await store.getStrategyRecord(STRATEGY);
    expect(rec?.backtest ?? null).toBeNull();
    expect(rec?.decisions ?? []).toHaveLength(0);
    const status = await svc.buildPromotionStatus(ST_USER, STRATEGY);
    expect(status.canGoLive).toBe(false);
  });
});

// TRA-803 — the tokenless public promotion probe (buildPublicPromotionProbe,
// served at GET /api/health/promotion-gate/:strategyId) must surface the SAME
// gate verdict as the authenticated per-user route, except it aggregates the
// Stage-2 paper ledger across every registered user (no caller identity). The
// invariant under test: it reports the accrued supertrend paper trades AND keeps
// `canGoLive=false` while Stage 1/3 are unmet — so QuantTrader reading it
// tokenless can never see a false "go".
describe('TRA-803 public promotion probe — aggregates paper, keeps gate honest', () => {
  const STRATEGY = 'supertrend_confluence';

  beforeAll(async () => {
    // The probe enumerates users via getAllUsers(); register the forward-test
    // user (its stocks ledger was seeded with 60 supertrend paper trades by the
    // TRA-801 block above) so the aggregation actually picks them up.
    writeFileSync(
      join(DATA_DIR, 'users.json'),
      JSON.stringify([
        {
          username: 'supertrend-forward',
          email: '',
          passwordHash: 'x',
          role: 'user',
          createdAt: '2026-06-01T00:00:00.000Z',
        },
      ]),
      'utf-8',
    );
    const users = await import('./users.js');
    await users.loadUsers();
  });

  it('reports accrued paper trades for supertrend_confluence with canGoLive=false', async () => {
    const status = await svc.buildPublicPromotionProbe(STRATEGY);
    // Aggregated from the registered user's stocks ledger (60 trades seeded above).
    expect(status.paper.tradeCount).toBe(60);
    expect(status.paper.metrics?.tradeCount).toBe(60);
    // Paper may fully pass, but Stage 1 (TRA-382-blocked backtest) is missing and
    // Stage 3 sign-off is absent → the safety invariant must hold.
    expect(status.backtest.state).toBe('missing');
    expect(status.signoff).toBe('absent');
    expect(status.canGoLive).toBe(false);
    expect(status.blockedReasons.join(' ')).toMatch(/Stage 1/);
  });

  it('exposes only gate telemetry — no account internals or secrets', async () => {
    const status = await svc.buildPublicPromotionProbe(STRATEGY);
    const keys = Object.keys(status).sort();
    expect(keys).toEqual(
      // TRA-2036 added the observe-only shadow-expectancy guard verdict to the
      // promotion status (null when the guard is off). It is gate telemetry, so
      // it belongs in this exposed-keys allowlist alongside the other gates.
      ['backtest', 'blockedReasons', 'canGoLive', 'paper', 'shadowExpectancy', 'signoff', 'strategyClass', 'strategyId'].sort(),
    );
  });
});
