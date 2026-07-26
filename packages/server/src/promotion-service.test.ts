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
// TRA-2348 — the universe primitives under test live in shared. Pulled in the
// same way as the units above purely for symmetry; shared reads no env.
let shared: typeof import('@trading-app/shared');

const DAY_MS = 24 * 60 * 60 * 1000;

function paperTrade(pnl: number, i: number): Position {
  // Space trades one per day so the ledger spans ~weeks — long enough for the
  // gate to annualize the paper Sharpe (TRA-538); a near-zero span would mark
  // the Sharpe unverified and fail Stage 2.
  return {
    id: `t${i}`,
    symbol: 'BTC-USD',
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

/**
 * TRA-1461 — one OPEN demo DCA accumulation position. `dca` is an accumulate-
 * class strategy, so its Stage-2 leg validates on accumulation correctness
 * (fills built into a held, growing position over a time-based soak) rather than
 * closed-trade PF/expectancy — a hold-mode strategy never closes by construction.
 */
function dcaAccumulation(fills: number, soakDays: number): Position {
  return {
    id: 'dca-accum-1',
    symbol: 'BTC-USD',
    side: 'buy',
    signalType: 'dca',
    entryPrice: 100,
    quantity: fills, // one unit per fill
    stopLoss: 90, // strictly below blended entry — fixed-stop risk invariant holds
    takeProfit: 0, // hold-mode: no per-leg TP
    openedAt: Date.now() - soakDays * DAY_MS,
    dcaHold: true,
    dcaFills: fills,
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

// Settings whose RESULT runs live crypto auto-trading on the go-forward
// DCA-only preset. TRA-697 retired the dca legacy roster, so the gate is
// now exercised against `crypto_core` (enabledStrategies ['dca']), the only
// roster a live crypto user can select post-retirement.
const liveSettings = {
  mode: 'live',
  cryptoAutoTradingEnabledLive: true,
  activeStrategyPreset: 'crypto_core', // enabledStrategies: ['dca']
} as AccountSettings;

// TRA-2348 — the same live crypto posture on the BOARD-RATIFIED live universe.
// `crypto_core` above is the demo/full-catalog roster (≈395 pairs), which
// QuantTrader's live-money sign-off is NO-GO on (TRA-1304); the majors preset is
// what that sign-off was actually granted for. Both are `enabledStrategies:
// ['dca']`, which is precisely why the roster delta cannot tell them apart.
const liveMajorsSettings = {
  mode: 'live',
  cryptoAutoTradingEnabledLive: true,
  activeStrategyPreset: 'crypto_core_live_majors',
} as AccountSettings;

beforeAll(async () => {
  svc = await import('./promotion-service.js');
  store = await import('./promotion-store.js');
  tradeStore = await import('./trade-store.js');
  shared = await import('@trading-app/shared');

  // Seed 60 monitored dca paper trades (50 winners +1.5R, 10 losers -0.5R) — kept
  // so snapshotPaperMetrics still reflects a real ledger — PLUS the OPEN, held
  // accumulation the Stage-2 accumulate leg actually gates on (TRA-1461).
  const closed = Array.from({ length: 60 }, (_, i) => paperTrade(i % 6 === 0 ? -0.5 : 1.5, i));
  await tradeStore.saveCryptoTradeSnapshot(USER, {
    version: 1,
    savedAt: new Date().toISOString(),
    openPositions: [dcaAccumulation(10, 20)],
    closedPositions: closed,
    demoClosedPositions: closed,
    recentSignals: [],
    account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, openingEquityToday: 25_000 },
  });
});

describe('TRA-532 promotion gate — end-to-end enforcement', () => {
  it('blocks the live transition when no strategy is promoted (all three stages fail)', async () => {
    const gate = await svc.evaluateLiveTransitionGate(USER, liveSettings);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked[0]?.strategyId).toBe('dca');
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/Stage 1/);
  });

  it('still blocks after only the backtest is registered (paper + sign-off missing)', async () => {
    // TRA-1465 — dca is accumulate-class, so its Stage 1 is cleared by an
    // accumulation-backtest verdict (accumulation robustness on an OOS window),
    // NOT the six-guard timing verdict, which the store now rejects for dca.
    await store.registerAccumulationBacktestVerdict({
      strategyId: 'dca',
      metrics: passingAccumBacktestMetrics(),
      reportId: 'TRA-695',
      registeredBy: 'qt',
    });
    const status = await svc.buildPromotionStatus(USER, 'dca');
    expect(status.backtest.state).toBe('pass');
    expect(status.backtest.accumulationBacktest?.oosDays).toBe(200);
    expect(status.backtest.metrics).toBeNull(); // no close-based timing metrics
    // TRA-1461 — dca is accumulate-class: Stage 2 passes from the seeded OPEN
    // accumulation (not closed trades), but sign-off is still absent.
    expect(status.strategyClass).toBe('accumulate');
    expect(status.paper.state).toBe('pass');
    expect(status.paper.accumulation?.positionCount).toBe(1);
    expect(status.signoff).toBe('absent');
    expect(status.canGoLive).toBe(false);

    const gate = await svc.evaluateLiveTransitionGate(USER, liveSettings);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/sign-off/i);
  });

  it('allows the live transition once backtest + paper pass AND a sign-off is recorded', async () => {
    await store.recordSignoff({
      strategyId: 'dca',
      reviewer: 'QuantTrader',
      backtestMetrics: store.deriveBacktestGateMetrics(passingReport()),
      paperMetrics: await svc.snapshotPaperMetrics(USER, 'dca'),
    });
    const status = await svc.buildPromotionStatus(USER, 'dca');
    expect(status.canGoLive).toBe(true);
    expect(status.blockedReasons).toHaveLength(0);

    // TRA-2348 — the transition that opens is onto a BOARD-RATIFIED universe.
    // This assertion used `liveSettings` (preset `crypto_core`, ≈395 pairs) until
    // TRA-2348 found that a strategy-keyed sign-off cannot authorize a universe
    // QuantTrader explicitly ruled NO-GO on (TRA-1304). Full promotion of `dca`
    // is now necessary but not sufficient; the ratified majors preset is the
    // universe the sign-off was granted for, and it still saves.
    const gate = await svc.evaluateLiveTransitionGate(USER, liveMajorsSettings);
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('TRA-2348 — the SAME fully-promoted strategy is still refused on the un-ratified full universe', async () => {
    // The other half of the assertion above, and the reason it had to move: the
    // promotion record is keyed by strategyId alone, so without a universe check
    // `dca`'s sign-off would grandfather `crypto_core`'s ≈395 pairs outright.
    const status = await svc.buildPromotionStatus(USER, 'dca');
    expect(status.canGoLive).toBe(true); // fully promoted — the gate is NOT closed on evidence

    const gate = await svc.evaluateLiveTransitionGate(USER, liveSettings);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked.map(b => b.strategyId)).toEqual(['dca']);
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/WIDENS the live symbol universe/i);
  });

  it('never blocks a settings change that turns live OFF (Demo edits are unrestricted)', async () => {
    const demoSettings = { ...liveSettings, mode: 'demo' } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate('bob-unpromoted', demoSettings);
    expect(gate.allowed).toBe(true);
  });

  // TRA-575 — a stocks-only Tradier user flips the single global `mode` to live
  // with crypto auto-trading OFF (the new default). The crypto promotion gate
  // must stay dormant: live stocks must NOT be blocked by crypto strategy
  // promotion, even when no crypto strategy is promoted on the account.
  it('allows a live transition when crypto auto-trading is OFF, even with zero promoted strategies', async () => {
    const stocksOnlyLive = {
      mode: 'live',
      cryptoAutoTradingEnabledLive: false,
      activeStrategyPreset: 'crypto_core', // an unpromoted crypto roster — irrelevant while crypto is OFF
    } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate('stocks-only-user', stocksOnlyLive);
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  // TRA-575 — but the gate must remain fully intact the moment live crypto
  // auto-trading is explicitly enabled on an unpromoted roster.
  it('still blocks once live crypto auto-trading is explicitly turned ON with unpromoted strategies', async () => {
    const cryptoLive = {
      mode: 'live',
      cryptoAutoTradingEnabledLive: true,
      activeStrategyPreset: 'crypto_core',
    } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate('stocks-only-user', cryptoLive);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked.length).toBeGreaterThan(0);
  });

  it('computed paper metrics reflect the ledger (count and positive expectancy)', async () => {
    const m = await svc.snapshotPaperMetrics(USER, 'dca');
    expect(m?.tradeCount).toBe(60);
    expect(m?.expectancy).toBeGreaterThan(0.5);
  });
});

// TRA-1436 (parent TRA-1434) — the promotion gate must be ENVIRONMENT-AWARE when
// armed: Live + Tradier Environment = Sandbox (paper) risks zero real capital and
// is the intended paper-validation path, so it must NOT be blocked by strategy
// promotion. Live + Tradier Production (real money) stays fail-closed. Behind the
// default-OFF PROMOTION_GATE_ENV_AWARE flag ⇒ the legacy crypto-only trigger is
// preserved verbatim until the board arms it. The flag is read from process.env
// at call time, so we toggle it per-test.
describe('TRA-1436 promotion gate — environment-aware (Tradier Sandbox exempt)', () => {
  const FLAG = 'PROMOTION_GATE_ENV_AWARE';
  const ENV_USER = 'env-aware-user'; // no promoted strategies seeded for this user

  // Live options-only intent (crypto auto-trading OFF) on the DCA roster, whose
  // 'dca' strategy is unpromoted for ENV_USER → the full gate would block it.
  function liveOptions(env: 'sandbox' | 'production'): AccountSettings {
    return {
      mode: 'live',
      cryptoAutoTradingEnabledLive: false,
      activeStrategyPreset: 'crypto_core',
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

  it('(b) Live + Tradier Production → BLOCKED on the OPTIONS sleeves, never on crypto dca (TRA-1916)', async () => {
    process.env[FLAG] = '1';
    try {
      const gate = await svc.evaluateLiveTransitionGate(ENV_USER, liveOptions('production'));
      expect(gate.allowed).toBe(false);
      const blockedIds = gate.blocked.map(b => b.strategyId);
      // TRA-1916 — an options production switch is judged against the options
      // roster the board named (RV + OTM Mispricing), fail-closed while both are
      // unpromoted. The crypto `dca` strategy must NEVER appear here — that was
      // the mis-scoping bug.
      expect(blockedIds).toContain('single_leg_rv');
      expect(blockedIds).toContain('single_leg_otm');
      expect(blockedIds).not.toContain('dca');
    } finally {
      delete process.env[FLAG];
    }
  });

  it('(c) Live + Tradier Production + a fully promoted CRYPTO strategy → still BLOCKED (TRA-1916: dca promotion does not clear an options go-live)', async () => {
    // USER has dca fully promoted (backtest + paper + sign-off) from the
    // end-to-end block above. Pre-TRA-1916 that wrongly ALLOWED an options
    // production switch; the options axis is now gated on options-sleeve
    // evidence, which USER does not have, so the switch must stay blocked and
    // must not be cleared by the crypto dca sign-off.
    process.env[FLAG] = '1';
    try {
      const gate = await svc.evaluateLiveTransitionGate(USER, liveOptions('production'));
      expect(gate.allowed).toBe(false);
      const blockedIds = gate.blocked.map(b => b.strategyId);
      expect(blockedIds).toContain('single_leg_rv');
      expect(blockedIds).toContain('single_leg_otm');
      expect(blockedIds).not.toContain('dca');
    } finally {
      delete process.env[FLAG];
    }
  });

  it('keeps crypto live gated as-is even with Tradier Sandbox (crypto has no sandbox)', async () => {
    // Crypto auto-trading ON is always real capital → gated regardless of the
    // Tradier options environment.
    process.env[FLAG] = '1';
    try {
      const cryptoLiveSandbox = {
        mode: 'live',
        cryptoAutoTradingEnabledLive: true,
        activeStrategyPreset: 'crypto_core',
        liveTradierEnvOptions: 'sandbox',
      } as AccountSettings;
      const gate = await svc.evaluateLiveTransitionGate(ENV_USER, cryptoLiveSandbox);
      expect(gate.allowed).toBe(false);
      expect(gate.blocked[0]?.strategyId).toBe('dca');
    } finally {
      delete process.env[FLAG];
    }
  });

  it('flag OFF (default) preserves the legacy crypto-only trigger — Production options NOT gated', async () => {
    // With the flag off, an options-only live switch (crypto OFF) is allowed even
    // to Production, because the legacy gate only fires on live crypto. This is
    // the behaviour-preserving default until the board arms the change.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, liveOptions('production'));
    expect(gate.allowed).toBe(true);
  });
});

// TRA-1590 — de-escalation exemption. A PUT that HOLDS or REDUCES real-capital
// intent must never block on the current state's gate failure, so an operator
// can always move toward safety. Only an axis the save NEWLY activates is gated.
// ENV_USER has no promoted strategies, so any *escalating* save would block.
describe('TRA-1590 promotion gate — de-escalation saves are never blocked', () => {
  const FLAG = 'PROMOTION_GATE_ENV_AWARE';
  const ENV_USER = 'env-aware-user';

  const cryptoLive = (env: 'sandbox' | 'production'): AccountSettings =>
    ({
      mode: 'live',
      cryptoAutoTradingEnabledLive: true,
      activeStrategyPreset: 'crypto_core',
      liveTradierEnvOptions: env,
    } as AccountSettings);

  it('legacy trigger — routing options prod → sandbox while live crypto stays ON is ALLOWED', async () => {
    // The exact bqb1 deadlock: crypto already live+failing; the operator only
    // wants to de-escalate options to sandbox. crypto axis is unchanged (on→on),
    // so no NEW real-capital intent → the save must succeed.
    delete process.env[FLAG];
    const previous = cryptoLive('production');
    const updated = cryptoLive('sandbox');
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('env-aware — holding live crypto ON while options is already sandbox is ALLOWED', async () => {
    process.env[FLAG] = '1';
    try {
      const previous = cryptoLive('sandbox');
      const updated = cryptoLive('sandbox');
      const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
      expect(gate.allowed).toBe(true);
    } finally {
      delete process.env[FLAG];
    }
  });

  it('env-aware — NEWLY turning options → production still BLOCKS even while crypto is already ON', async () => {
    // De-escalation must not leak: crypto already-on does not exempt a *new*
    // options-production escalation in the same PUT.
    process.env[FLAG] = '1';
    try {
      const previous = cryptoLive('sandbox');
      const updated = cryptoLive('production');
      const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
      expect(gate.allowed).toBe(false);
      // TRA-1916 — crypto is already ON (not escalating), so only the options
      // axis escalates and the block is scoped to the options roster, not dca.
      const blockedIds = gate.blocked.map(b => b.strategyId);
      expect(blockedIds).toContain('single_leg_rv');
      expect(blockedIds).toContain('single_leg_otm');
      expect(blockedIds).not.toContain('dca');
    } finally {
      delete process.env[FLAG];
    }
  });

  it('legacy trigger — NEWLY turning live crypto ON (from Demo) still BLOCKS', async () => {
    delete process.env[FLAG];
    const previous = { mode: 'demo', cryptoAutoTradingEnabledLive: false } as AccountSettings;
    const updated = cryptoLive('sandbox');
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked[0]?.strategyId).toBe('dca');
  });

  it('omitting the previous snapshot preserves the pre-1590 fail-closed trigger', async () => {
    // The crypto-start path passes no `previous`; every active axis reads as
    // newly-on, so a gate-failing live crypto config still blocks.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, cryptoLive('sandbox'));
    expect(gate.allowed).toBe(false);
    expect(gate.blocked[0]?.strategyId).toBe('dca');
  });
});

// TRA-2343 — the gate fired on an AXIS flip, but graded a ROSTER, and the roster
// can change while the axis stays latched ON. That made it bypassable in two
// saves the gate itself approves. These tests are written as the bypass: each
// `it` below FAILS on the pre-TRA-2343 gate (it returned allowed:true) except
// the ones marked as TRA-1590 regressions, which must keep passing — the fix has
// to be graded in BOTH directions or it re-creates the deadlock that exemption
// was written for.
describe('TRA-2343 promotion gate — the roster delta is gated, not just the axis', () => {
  const FLAG = 'PROMOTION_GATE_ENV_AWARE';
  const ENV_USER = 'env-aware-user'; // no promoted strategies

  const demo = { mode: 'demo', cryptoAutoTradingEnabledLive: false } as AccountSettings;
  const cryptoLiveOn = (preset: string): AccountSettings =>
    ({
      mode: 'live',
      cryptoAutoTradingEnabledLive: true,
      activeStrategyPreset: preset,
      liveTradierEnvOptions: 'sandbox',
    } as AccountSettings);

  it('SAVE A — arming live crypto under the EMPTY no_trade roster is REFUSED', async () => {
    // The stepping stone. `no_trade` has enabledStrategies: [] ⇒ the pre-fix
    // loop had nothing to iterate, blocked.length === 0, allowed:true. An empty
    // enumeration must never sail through a fail-closed check.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, cryptoLiveOn('no_trade'), demo);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/EMPTY strategy roster/i);
  });

  it('SAVE A (unknown preset id) — the no_trade fallback is refused the same way', async () => {
    // resolveStrategyPreset falls back to `no_trade` for an unknown id, so a
    // typo'd/absent preset was the same empty-roster hole by another route.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, cryptoLiveOn('not_a_preset'), demo);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/EMPTY strategy roster/i);
  });

  it('SAVE A via /api/crypto/trading/start (no previous snapshot) is REFUSED too', async () => {
    // The TRA-575 crypto-start path passes no `previous`. Pre-fix, a user whose
    // saved preset was `no_trade` could start LIVE crypto auto-trading through
    // that endpoint completely ungated.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, cryptoLiveOn('no_trade'));
    expect(gate.allowed).toBe(false);
  });

  it('SAVE B — re-selecting a real preset while live crypto is already ON is GATED on the new roster', async () => {
    // The core defect: axis on→on ⇒ `cryptoEscalates` false ⇒ the pre-fix gate
    // never fired, and `dca` was never graded. This is live DCA across ~395
    // Coinbase pairs with zero promotion evidence.
    delete process.env[FLAG];
    const previous = cryptoLiveOn('no_trade');
    const updated = cryptoLiveOn('crypto_core');
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked.map(b => b.strategyId)).toContain('dca');
  });

  it('SAVE B is ALLOWED when the newly-exposed strategy IS promoted (the gate still opens)', async () => {
    // Both directions: the fix must not degenerate into "block every roster
    // change". USER has dca fully promoted (backtest + paper + sign-off) from
    // the end-to-end block above, so the same save is approved.
    //
    // TRA-2348 — the target preset moved from `crypto_core` to the ratified
    // majors preset for the same reason as the end-to-end control: a
    // strategy-keyed sign-off does not authorize the ≈395-pair universe. The
    // roster delta being exercised here ({} → {dca}) is identical either way.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(
      USER,
      cryptoLiveOn('crypto_core_live_majors'),
      cryptoLiveOn('no_trade'),
    );
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('TRA-1590 regression — NARROWING the roster to no_trade while live crypto stays ON is ALLOWED', async () => {
    // A de-escalation lands on an empty roster too, but the axis is not
    // escalating (on→on), so the empty-roster refusal must not trip: an
    // operator standing the engine down must never be blocked.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(
      ENV_USER,
      cryptoLiveOn('no_trade'),
      cryptoLiveOn('crypto_core'),
    );
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('TRA-1590 regression — an unrelated edit that HOLDS an already-failing live roster still saves', async () => {
    // The original deadlock: crypto live + unpromoted `dca`. Any edit that
    // leaves the exposed roster unchanged must save, or the operator cannot
    // move toward safety.
    delete process.env[FLAG];
    const previous = cryptoLiveOn('crypto_core');
    const updated = { ...cryptoLiveOn('crypto_core'), riskPerTrade: 1 } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
    expect(gate.allowed).toBe(true);
  });

  it('TRA-1590 regression — options production → sandbox while live crypto stays ON is ALLOWED', async () => {
    process.env[FLAG] = '1';
    try {
      const previous = {
        ...cryptoLiveOn('crypto_core'),
        liveTradierEnvOptions: 'production',
      } as AccountSettings;
      const updated = cryptoLiveOn('crypto_core'); // sandbox
      const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
      expect(gate.allowed).toBe(true);
      expect(gate.blocked).toHaveLength(0);
    } finally {
      delete process.env[FLAG];
    }
  });

  it('the options axis is still ungated while the env-aware flag is OFF', async () => {
    // The roster comparison must not arm the options axis behind the flag's
    // back — with the flag off, an options → production switch stays allowed.
    delete process.env[FLAG];
    const previous = {
      mode: 'live',
      cryptoAutoTradingEnabledLive: false,
      activeStrategyPreset: 'crypto_core',
      liveTradierEnvOptions: 'sandbox',
    } as AccountSettings;
    const updated = { ...previous, liveTradierEnvOptions: 'production' } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
    expect(gate.allowed).toBe(true);
  });
});

// TRA-2348 — the residual TRA-2343 leaves behind, one level finer.
//
// TRA-2343 moved the graded unit from the AXIS BOOLEAN to the STRATEGY ROSTER.
// That closes "arm the axis under the empty `no_trade` roster, then re-select the
// real preset". It does not close the same shape between two REAL presets,
// because every shipped live crypto preset enables the same single strategy and
// differs only in SYMBOL UNIVERSE:
//
//   crypto_core_live_canary_btc → ['dca'], {BTC-USD}
//   crypto_core_live_majors     → ['dca'], {BTC-USD, ETH-USD, SOL-USD}
//   crypto_core                 → ['dca'], ⊤  (≈395 Coinbase pairs, symbolFilter null)
//
// So canary → `crypto_core` while live crypto is already ON is roster {dca} →
// {dca}: an EMPTY delta, no axis flip, gate silent — while the universe widens
// ≈130×. And the sign-off it inherits is explicitly narrower than what it would
// then trade: QuantTrader's live-money adjudication is CONDITIONAL GO on the
// OOS-validated majors and NO-GO on the full `crypto_core` universe (TRA-1304,
// quoted verbatim in that preset's description). A universe-blind promotion
// record lets a majors/canary sign-off grandfather a 395-pair roster.
//
// WHY THE REMEDY IS A REFUSAL, NOT A RE-GRADE. The natural-looking fix — "count a
// widening as newly-exposed and grade it" — is a NO-OP. Reaching this state
// requires `dca` to be fully promoted already (that is how the operator got
// live), and `buildPromotionStatus` is universe-blind, so the re-grade returns
// canGoLive:true and the widening is allowed anyway. The check must refuse
// against a universe the board named. Until the promotion RECORD carries the
// universe it was granted for, `LIVE_RATIFIED_CRYPTO_PRESETS` is that record.
describe('TRA-2348 promotion gate — the graded unit is (strategy, UNIVERSE)', () => {
  const FLAG = 'PROMOTION_GATE_ENV_AWARE';
  const ENV_USER = 'env-aware-user'; // no promoted strategies

  // USER (alice) has `dca` fully promoted from the end-to-end block above, which
  // is what isolates the universe rule: every refusal below is about the
  // universe alone, never about missing evidence.
  const cryptoLiveOn = (preset: string): AccountSettings =>
    ({
      mode: 'live',
      cryptoAutoTradingEnabledLive: true,
      activeStrategyPreset: preset,
      liveTradierEnvOptions: 'sandbox',
    } as AccountSettings);

  // ── Direction 1: what must now be REFUSED (these FAIL against f2f6360) ───────

  it('THE DEFECT — canary BTC → crypto_core while live crypto is ON is REFUSED', async () => {
    delete process.env[FLAG];
    const previous = cryptoLiveOn('crypto_core_live_canary_btc');
    const updated = cryptoLiveOn('crypto_core');
    const gate = await svc.evaluateLiveTransitionGate(USER, updated, previous);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked.map(b => b.strategyId)).toEqual(['dca']);
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/WIDENS the live symbol universe/i);
  });

  it('the roster delta really is EMPTY on that save — the universe check is the only thing that can see it', async () => {
    // The load-bearing premise. If the two presets ever stop sharing a roster,
    // TRA-2343 would catch the swap on its own and this rule would be belt-and-
    // braces; today it is the ONLY control, so pin the premise explicitly rather
    // than trusting the prose above.
    const canary = shared.resolveStrategyPreset('crypto_core_live_canary_btc');
    const core = shared.resolveStrategyPreset('crypto_core');
    expect([...canary.enabledStrategies]).toEqual([...core.enabledStrategies]);
    expect([...core.enabledStrategies]).toEqual(['dca']);
  });

  it('majors → crypto_core is REFUSED for the same reason', async () => {
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(
      USER,
      cryptoLiveOn('crypto_core'),
      cryptoLiveOn('crypto_core_live_majors'),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/not on the board-ratified live-crypto list/i);
  });

  it('the crypto-start path (no previous snapshot) refuses the un-ratified universe even for a promoted strategy', async () => {
    // No `previous` ⇒ the previous live universe is EMPTY, so any live universe
    // reads as a widening. Fail-closed, matching the rest of the gate on that
    // path. Pre-TRA-2348 this returned ALLOWED for a promoted `dca`.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveCryptoStartGate(USER, {
      mode: 'demo',
      cryptoAutoTradingEnabledLive: false,
      activeStrategyPreset: 'crypto_core',
    } as AccountSettings);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked.map(b => b.strategyId)).toEqual(['dca']);
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/WIDENS the live symbol universe/i);
  });

  // ── Direction 2: what must STAY allowed (these PASS against f2f6360 too) ─────

  it('NARROWING — majors → canary BTC is ALLOWED', async () => {
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(
      USER,
      cryptoLiveOn('crypto_core_live_canary_btc'),
      cryptoLiveOn('crypto_core_live_majors'),
    );
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('NARROWING — crypto_core → majors is ALLOWED even though the PREVIOUS universe was un-ratified', async () => {
    // The de-escalation direction (TRA-1590). An operator standing exposure DOWN
    // must never have to clear a gate first, even from a state that would not be
    // granted today — otherwise the rule becomes a trap that pins them at the
    // widest universe.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(
      USER,
      cryptoLiveOn('crypto_core_live_majors'),
      cryptoLiveOn('crypto_core'),
    );
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('HOLD — an unrelated edit that keeps the SAME un-ratified universe still saves', async () => {
    // ⊤ ⊆ ⊤. If `isSymbolUniverseSubset` treated the unbounded universe as
    // "never a subset of anything", an operator already live on `crypto_core`
    // could not save any setting at all — the exact TRA-1590 deadlock this
    // family of rules exists to avoid.
    delete process.env[FLAG];
    const previous = cryptoLiveOn('crypto_core');
    const updated = { ...previous, riskPerTrade: 1 } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate(USER, updated, previous);
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('THE RATIFIED STEP-UP — canary BTC → majors is a widening but is ALLOWED', async () => {
    // TRA-1304 adjudicated the canary INSIDE the existing majors sign-off:
    // "on canary PASS the step-up is env-only, no code change and no re-gate".
    // The rule must not re-gate the one widening the board already granted.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(
      USER,
      cryptoLiveOn('crypto_core_live_majors'),
      cryptoLiveOn('crypto_core_live_canary_btc'),
    );
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('THE ESCAPE HATCH — widening the preset while turning live crypto OFF in the same save is ALLOWED', async () => {
    // A refusal that cannot be cleared in one save is a deadlock. Reducing
    // exposure is never blocked, so the refusal text can honestly say so.
    delete process.env[FLAG];
    const previous = cryptoLiveOn('crypto_core_live_canary_btc');
    const updated = {
      ...cryptoLiveOn('crypto_core'),
      cryptoAutoTradingEnabledLive: false,
    } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate(USER, updated, previous);
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('a DEMO-mode snapshot on crypto_core is untouched (demo breadth is not a real-capital decision)', async () => {
    // `crypto_core` IS the demo roster (TRA-693 board directive, DEMO_STRATEGY_PRESET
    // on bqb1). The rule must not leak into paper money.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(USER, {
      mode: 'demo',
      cryptoAutoTradingEnabledLive: false,
      cryptoAutoTradingEnabledDemo: true,
      activeStrategyPreset: 'crypto_core',
    } as AccountSettings);
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('the universe rule does not REPLACE the promotion check on a ratified preset', async () => {
    // Both gates are live: a ratified universe with no promotion evidence still
    // blocks on evidence. Being on the allowlist is permission to be graded, not
    // a bypass.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(
      ENV_USER,
      cryptoLiveOn('crypto_core_live_majors'),
      { mode: 'demo', cryptoAutoTradingEnabledLive: false } as AccountSettings,
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blocked.map(b => b.strategyId)).toEqual(['dca']);
    expect(gate.blocked[0]?.reasons.join(' ')).not.toMatch(/WIDENS the live symbol universe/i);
  });

  // ── The universe primitives themselves ──────────────────────────────────────

  it('resolveStrategySymbolUniverse INTERSECTS both preset gates, and reports ⊤ as null', () => {
    // `presetAllowsStrategySymbol` requires BOTH gates to pass, so reading only
    // one of them would understate the cap for a preset that pins both to
    // different sets. The shipped majors preset pins both to the same three, so
    // the intersection is exercised on a synthetic preset too.
    const majors = shared.resolveStrategyPreset('crypto_core_live_majors');
    expect(shared.resolveStrategySymbolUniverse(majors, 'dca')).toEqual([
      'BTC-USD',
      'ETH-USD',
      'SOL-USD',
    ]);
    expect(shared.resolveStrategySymbolUniverse(shared.resolveStrategyPreset('crypto_core'), 'dca')).toBeNull();
    expect(shared.resolveStrategySymbolUniverse(shared.resolveStrategyPreset('no_trade'), 'dca')).toEqual([]);

    const mixed = {
      ...majors,
      symbolFilter: ['BTC-USD', 'ETH-USD'],
      strategyUniverse: { dca: ['ETH-USD', 'SOL-USD'] },
    } as typeof majors;
    expect(shared.resolveStrategySymbolUniverse(mixed, 'dca')).toEqual(['ETH-USD']);

    const wideFilterOnly = { ...majors, symbolFilter: null } as typeof majors;
    expect(shared.resolveStrategySymbolUniverse(wideFilterOnly, 'dca')).toEqual([
      'BTC-USD',
      'ETH-USD',
      'SOL-USD',
    ]);
  });

  it('isSymbolUniverseSubset reads null as ⊤ in BOTH positions', () => {
    const { isSymbolUniverseSubset: sub } = shared;
    expect(sub(['BTC-USD'], ['BTC-USD', 'ETH-USD'])).toBe(true); // narrowing
    expect(sub(['BTC-USD', 'ETH-USD'], ['BTC-USD'])).toBe(false); // widening
    expect(sub(null, ['BTC-USD'])).toBe(false); // ⊤ ⊄ a finite list — THE defect
    expect(sub(['BTC-USD'], null)).toBe(true); // anything ⊆ ⊤
    expect(sub(null, null)).toBe(true); // ⊤ ⊆ ⊤ — the HOLD case
    expect(sub([], ['BTC-USD'])).toBe(true); // stand-down
    expect(sub([], null)).toBe(true);
  });

  it('every ratified preset id resolves to a real preset (the allowlist cannot rot into a typo)', () => {
    // A typo'd id would fall back to `no_trade` and silently make the allowlist
    // entry meaningless — the allowlist would still "contain" it while the gate
    // compared against the wrong universe.
    for (const id of shared.LIVE_RATIFIED_CRYPTO_PRESETS) {
      expect(shared.resolveStrategyPreset(id).id).toBe(id);
    }
    // …and the un-ratified full-catalog roster is NOT on it.
    expect(shared.LIVE_RATIFIED_CRYPTO_PRESETS).not.toContain('crypto_core');
  });
});

// TRA-2351 — THE THIRD PATH. Independent QA grading of the TRA-2343 fix found a
// bypass that neither TRA-2343 nor TRA-2342 closes, because it defeats the two
// controls in different places:
//
//   `POST /api/crypto/trading/start` takes its mode from the REQUEST BODY
//   (`resolveTradingMode`, index.ts:8488-8495 — a body `mode` wins outright over
//   `settings.mode`), but composes the snapshot it hands the gate as
//   `{ ...settings, cryptoAutoTradingEnabledLive: true }` (index.ts:9346-9351),
//   which carries the PERSISTED `mode`. So when the operator is on `demo` and the
//   request says `{"mode":"live"}`, the gate is asked to authorize a LIVE action
//   against a snapshot that says DEMO — and `realCapitalIntentAxes` short-circuits
//   on `s.mode !== 'live'` and returns all-false. Every downstream term collapses:
//   `cryptoEscalates` false, both rosters empty, `emptyRosterAxes` empty ⇒ the
//   TRA-2343 roster delta is empty ⇒ ALLOWED. Not "graded and passed" — never
//   graded, and it does not even emit the TRA-532 refusal log.
//
//   The route then runs `setAutoTrading(true, 'live')` and PERSISTS
//   `cryptoAutoTradingEnabledLive: true` (index.ts:9389-9390).
//
// This does not trade on its own — `doTick` gates the live branch on
// `this.mode === 'live' && this.liveAccount` (crypto-engine.ts:1803), so step 1
// ARMS, it does not FIRE. The harm is that the arm is durable and its remaining
// condition is the one step already on the go-live calendar:
//
//   Step 2. `TRADIER_ENV=production` (TRA-1648's ratified arming step). The equity
//   boot-arm force-writes `settings.mode = 'live'` (user-context.ts:749), and the
//   crypto boot-arm below it is guarded by
//   `settings.cryptoAutoTradingEnabledLive !== true && shouldBootArmLiveCrypto(...)`
//   (user-context.ts:801) — a flag ALREADY `true` short-circuits on the FIRST
//   conjunct, so TRA-2342's `LIVE_CRYPTO_BOOT_ARM` interlock is never consulted.
//   That interlock stops a boot from CREATING the arm; it does not stop a boot
//   from INHERITING one. The engine is then constructed live + armed on the
//   operator's `activeStrategyPreset` with zero promotion evidence.
//
// The tests below FAILED at f2f6360 and PASS from the fix, which is a NAMED entry
// point — `evaluateLiveCryptoStartGate` — rather than a new rule inside the gate.
//
// WHY THE REMEDY IS AT THE CALL SITE, NOT IN `realCapitalIntentAxes`. The obvious
// alternative is to make the crypto axis mode-blind (grade a persisted
// `cryptoAutoTradingEnabledLive: true` even under `mode: 'demo'`, since the boot
// path force-writes the mode anyway). That is WRONG, and dangerously so: it also
// lifts the axis on the PREVIOUS snapshot, so bqb1's real shape — an arm CREATED
// ungated by the TRA-1340 boot path, sitting under `mode: demo` — would read as
// "already exposed", the TRA-1590 grandfathering would swallow it, and the
// operator's demo → live PUT would go from REFUSED to ALLOWED. The mode-gated
// axis is what makes that flip the graded moment. Grandfathering is only sound
// over exposure that was itself graded; the boot path is ungated by design, so
// the last line of defence must stay where it is. Do not "simplify" this by
// deleting the intent argument.
describe('TRA-2351 — a LIVE crypto start against a DEMO-mode snapshot must not be ungated', () => {
  const FLAG = 'PROMOTION_GATE_ENV_AWARE';
  const ENV_USER = 'env-aware-user'; // no promoted strategies

  /**
   * The operator's PERSISTED settings — what `POST /api/crypto/trading/start`
   * reads via `getSettings(username)` before it composes anything. `mode` is
   * `demo` and the live arm is OFF: this is the pre-request state, and the
   * request body is what says `{"mode":"live"}`.
   */
  const persistedDemoOperator = (preset: string): AccountSettings =>
    ({
      mode: 'demo',
      cryptoAutoTradingEnabledLive: false,
      activeStrategyPreset: preset,
      liveTradierEnvOptions: 'sandbox',
    } as AccountSettings);

  it('refuses the live crypto start that arms an UNGRADED roster (bqb1 preset crypto_core)', async () => {
    // `crypto_core` is the operator's live preset on bqb1 (TRA-2336). `dca` has
    // no promotion evidence for ENV_USER, so this must block — it is the same
    // roster TRA-2343 SAVE B correctly refuses when the snapshot says `live`.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveCryptoStartGate(
      ENV_USER,
      persistedDemoOperator('crypto_core'),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blocked.map(b => b.strategyId)).toContain('dca');
  });

  it('refuses the live crypto start onto the EMPTY no_trade roster too', async () => {
    // The TRA-2343 empty-roster hardening is scoped to an ESCALATING axis, and
    // no axis escalated when the snapshot read `demo` — so the stepping stone
    // that hardening was written to remove was reachable again on this route.
    // The declared intent makes the crypto axis escalate, so it fires.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveCryptoStartGate(
      ENV_USER,
      persistedDemoOperator('no_trade'),
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/EMPTY strategy roster/i);
  });

  it('still refuses when the operator is ALREADY persisted live (the pre-fix-safe case)', async () => {
    // The one input the TRA-2343 suite pinned. It must keep working — the fix
    // must not have moved the safe case, only added the unsafe one.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveCryptoStartGate(ENV_USER, {
      ...persistedDemoOperator('crypto_core'),
      mode: 'live',
    } as AccountSettings);
    expect(gate.allowed).toBe(false);
    expect(gate.blocked.map(b => b.strategyId)).toContain('dca');
  });

  it('THE REGRESSION GUARD — the raw snapshot the route USED to build is still allowed', async () => {
    // This is the defect, reproduced exactly: `{ ...settings, cryptoAutoTradingEnabledLive: true }`
    // carrying the PERSISTED `demo` mode. The general gate answers it correctly
    // (nothing in that state puts capital at risk) — which is precisely why the
    // route could not be fixed by "passing a better snapshot" and why the fix is
    // a named entry point instead. If someone reverts the route to compose its
    // own snapshot, THIS is the value they will get back.
    delete process.env[FLAG];
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, {
      ...persistedDemoOperator('crypto_core'),
      cryptoAutoTradingEnabledLive: true,
    } as AccountSettings);
    expect(gate.allowed).toBe(true);
  });

  it('the declared intent lifts ONLY the crypto axis — options production is untouched', async () => {
    // With PROMOTION_GATE_ENV_AWARE armed, a snapshot routing options to Tradier
    // PRODUCTION would normally be graded on OPTIONS_PRODUCTION_STRATEGIES. A
    // crypto start must not drag that axis in and refuse for an unrelated
    // reason, so the blocked set names the crypto roster only. (Lifting the whole
    // snapshot to `mode: 'live'` instead of the single axis would fail this.)
    process.env[FLAG] = '1';
    try {
      const gate = await svc.evaluateLiveCryptoStartGate(ENV_USER, {
        ...persistedDemoOperator('crypto_core'),
        liveTradierEnvOptions: 'production',
      } as AccountSettings);
      expect(gate.allowed).toBe(false);
      expect(gate.blocked.map(b => b.strategyId)).toEqual(['dca']);
    } finally {
      delete process.env[FLAG];
    }
  });

  // ── Direction 2: what the TRA-2343 empty-roster hardening NEWLY refuses ──────
  // These two PASS at f2f6360 and are pinned here as the other-direction record.
  // The hardening does change one previously-allowed save: an operator carrying a
  // stale `cryptoAutoTradingEnabledLive: true` with a `no_trade` preset who flips
  // `mode` to live (the Options+Stock go-live step, TRA-1575) now gets a 422 where
  // pre-fix they got a 200. That is the SAVE A hazard, so refusing it is correct —
  // and it is NOT a TRA-1590 deadlock, because clearing the crypto flag in the
  // same PUT is a de-escalation and still saves. It is not currently on bqb1's
  // path (TRA-2336 disarmed the flag on 07-25 and the preset is `crypto_core`),
  // but the refusal TEXT names the wrong remedy for this operator — see TRA-2351.
  it('DIRECTION 2 — a live-mode flip carrying a STALE crypto arm + no_trade is newly REFUSED', async () => {
    delete process.env[FLAG];
    const previous = {
      mode: 'demo',
      cryptoAutoTradingEnabledLive: true, // stale arm, inert while mode is demo
      activeStrategyPreset: 'no_trade',
    } as AccountSettings;
    const updated = { ...previous, mode: 'live' } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
    expect(gate.allowed).toBe(false);
    // The message tells them to arm the axis WITH promoted strategies — but an
    // Options+Stock operator does not want live crypto at all; their remedy is
    // the next test. The reason text does not mention it.
    expect(gate.blocked[0]?.reasons.join(' ')).toMatch(/EMPTY strategy roster/i);
  });

  it('DIRECTION 2 — …and the escape hatch works: clearing the crypto arm in the same PUT saves', async () => {
    // Proves the above is friction, not a deadlock: dropping the stale arm is a
    // de-escalation, so the go-live mode flip still lands in one save.
    delete process.env[FLAG];
    const previous = {
      mode: 'demo',
      cryptoAutoTradingEnabledLive: true,
      activeStrategyPreset: 'no_trade',
    } as AccountSettings;
    const updated = {
      ...previous,
      mode: 'live',
      cryptoAutoTradingEnabledLive: false,
    } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, updated, previous);
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });

  it('BOTH DIRECTIONS — a DEMO crypto start is still never gated', async () => {
    // The remedy must not gate demo starts. `POST /api/crypto/trading/start`
    // with mode `demo` never enters the gate branch at all (index.ts:9358), and
    // a snapshot with live crypto OFF must stay allowed regardless.
    delete process.env[FLAG];
    const demoStart = {
      mode: 'demo',
      cryptoAutoTradingEnabledLive: false,
      cryptoAutoTradingEnabledDemo: true,
      activeStrategyPreset: 'crypto_core',
    } as AccountSettings;
    const gate = await svc.evaluateLiveTransitionGate(ENV_USER, demoStart);
    expect(gate.allowed).toBe(true);
    expect(gate.blocked).toHaveLength(0);
  });
});

// TRA-1461 — a hold-mode DCA accumulation clears Stage 2 with ZERO closed
// trades, proving the old structural blocker (paper leg required closed demo
// trades a hold-mode strategy never produces) is gone — while still requiring
// Stage 1 + Stage 3, so the live flip stays board-gated.
describe('TRA-1461 accumulate-class Stage 2 — hold-mode DCA needs no closed trades', () => {
  const ACC_USER = 'dca-holder';

  it('is missing/blocked with no accumulation, and passes Stage 2 once a real soak exists', async () => {
    // No positions at all → Stage 2 missing (and Stage 1/3 also block).
    await tradeStore.saveCryptoTradeSnapshot(ACC_USER, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: [],
      closedPositions: [],
      demoClosedPositions: [],
      recentSignals: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, openingEquityToday: 25_000 },
    });
    const empty = await svc.buildPromotionStatus(ACC_USER, 'dca');
    expect(empty.strategyClass).toBe('accumulate');
    expect(empty.paper.state).toBe('missing');
    expect(empty.blockedReasons.join(' ')).toMatch(/Stage 2 \(accumulation\) missing/);

    // A real, well-soaked accumulation with NO closed trades → Stage 2 passes.
    await tradeStore.saveCryptoTradeSnapshot(ACC_USER, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: [dcaAccumulation(10, 20)],
      closedPositions: [],
      demoClosedPositions: [],
      recentSignals: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, openingEquityToday: 25_000 },
    });
    const soaked = await svc.buildPromotionStatus(ACC_USER, 'dca');
    expect(soaked.paper.state).toBe('pass');
    expect(soaked.paper.metrics).toBeNull(); // no closed-trade PF/expectancy leg
    expect(soaked.paper.accumulation?.totalFills).toBe(10);
  });

  it('fails Stage 2 when the soak is too short even with plenty of fills', async () => {
    await tradeStore.saveCryptoTradeSnapshot(ACC_USER, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: [dcaAccumulation(20, 3)], // 3-day soak < 14-day minimum
      closedPositions: [],
      demoClosedPositions: [],
      recentSignals: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, openingEquityToday: 25_000 },
    });
    const status = await svc.buildPromotionStatus(ACC_USER, 'dca');
    expect(status.paper.state).toBe('fail');
    expect(status.paper.failedChecks.join(' ')).toMatch(/soak/);
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
  // leg), so it is exercised against a close-based crypto strategy — TRA-1461
  // routes the accumulate-class `dca` to a leg with no slippage concept.
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

  it('surfaces a non-null slippageRatio and blocks when realized > 1.5× modeled', async () => {
    // 60 monitored close-based trades that clear count / expectancy / Sharpe, but
    // each fill drifted 2× the modeled budget → ratio 2.0 > 1.5 cap.
    const closed = Array.from({ length: 60 }, (_, i) => slipTrade(i % 6 === 0 ? -0.5 : 1.5, i, 2, 1));
    await tradeStore.saveCryptoTradeSnapshot(SLIP_USER, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: [],
      closedPositions: closed,
      demoClosedPositions: closed,
      recentSignals: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, openingEquityToday: 25_000 },
    });

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
    await tradeStore.saveCryptoTradeSnapshot(SLIP_USER, {
      version: 1,
      savedAt: new Date().toISOString(),
      openPositions: [],
      closedPositions: closed,
      demoClosedPositions: closed,
      recentSignals: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, openingEquityToday: 25_000 },
    });

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
