import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { summarizeCostAwareGate, clearCostAwareGateLedger } from './cost-aware-gate-ledger.js';
// TRA-2945 — read the per-book mark tape the engine is supposed to WRITE.
import { summarizeMarkSanity, clearMarkSanityTape } from './option-mark-sanity.js';
// TRA-3879 — the cross-engine fleet-capital read. Wired per-test so the ORDER
// SITE can be shown to consult it; a resolver-only suite cannot see that seam.
import { setLiveOtmFleetCapitalProvider } from './live-otm-fleet-capital.js';
import type { PaperOptionsAccount } from './options-account.js'; // TRA-3445
import { etDateString } from './scheduler.js';
// TRA-1226 — evaluateIvRvScan now backfills the underlying's daily closes from
// the equity feed when the in-process dailyCloseCache is cold (the iv-rv option
// universe is NOT the set the TRA-533 technical-snapshot pass warms). Stub the
// feed so these unit tests stay hermetic: no network, and no real-timer
// retry/backoff hanging under vi.useFakeTimers(). Tests that need realised vol
// seed dailyCloseCache via seedCloses(); the dedicated backfill test overrides
// this mock per-case.
//
// TRA-1677 — this factory must NOT call `importActual()`. It used to:
//
//   vi.mock('./yahoo-feed.js', async (importActual) => {
//     const actual = await importActual<...>();
//     return { ...actual, fetchDailyCandles: vi.fn(async () => []), ... };
//   });
//
// …and with that form the mock reached THIS file's own `fetchDailyCandles`
// binding but NOT `signal-engine.ts`'s: the engine kept the real function and
// went to the live Yahoo network mid-test. The stub and the code under test were
// two different functions, so `expect(fetchDailyCandles).toHaveBeenCalled()` read
// 0 calls while the engine was really fetching 260 bars over the wire. Both
// TRA-1226/1230 backfill tests below failed for that reason alone — the product
// code they cover is fine.
//
// The tell is that the assertion fails while the behaviour it asserts is actually
// happening. `market-review.test.ts` mocks this same module with a plain factory
// and its stub propagates correctly, which is the shape used here.
//
// Because a plain factory REPLACES the module, every binding any module in this
// test's graph imports from yahoo-feed must be listed — a missing name is an
// undefined import, not a silent pass-through.
vi.mock('./yahoo-feed.js', () => ({
  // Network seams the engine drives — inert by default; tests that need data
  // override per-case with mockResolvedValueOnce.
  fetchDailyCandles: vi.fn(async () => []),
  fetchTradierDailyCandles: vi.fn(async () => []),
  fetchMinuteBars: vi.fn(async () => []),
  fetchMinuteBarsWithSource: vi.fn(async () => ({ bars: [], source: 'yahoo' as const })),
  fetchQuote: vi.fn(async () => null),
  fetchQuotes: vi.fn(async () => []),
  fetchStocksNews: vi.fn(async () => []),
  fetchMarketNews: vi.fn(async () => ({
    items: [],
    queriesAttempted: 0,
    queriesSucceeded: 0,
  })),
  fetchShortInterestFundamentals: vi.fn(async () => null),
  // Pure/stateful helpers other modules in the graph import. Faithful enough to
  // stand in; nothing in this file exercises them.
  parseShortInterestFundamentals: vi.fn(() => null),
  toIsoTime: vi.fn((t: Date | number | string | undefined | null) =>
    new Date(t ?? 0).toISOString()),
  isYahooBreakerOpen: vi.fn(() => false),
  isTradierDailyAvailable: vi.fn(() => false),
  tripYahooBreakerFromExternal: vi.fn(),
  setActiveInterestSymbols: vi.fn(),
  setTradierStocksFeedClient: vi.fn(),
  // TRA-3068 — the split calendar `applyQuotes` consults when it stamps
  // `moveSuspect`. Inert here: the calendar leg is exercised in
  // `quote-plausibility.test.ts` against the deployed predicate, and the point
  // of this stub is that the ratio-rule behaviour these tests assert is
  // UNCHANGED when no split is known. Per the note above, a name missing from
  // this factory is an undefined import, not a pass-through.
  knownSplitForSession: vi.fn(() => null),
  knownSplits: vi.fn(() => []),
  fetchRecentSplits: vi.fn(async () => []),
}));
import { fetchDailyCandles, fetchTradierDailyCandles, isYahooBreakerOpen } from './yahoo-feed.js';
// TRA-2262 — the per-tick fan-out bound on the doTick sinks.
import { resetSweepCursors, sweepCursorSnapshot, type SweepPass } from './tick-sweep-budget.js';
// TRA-3557 — read the OTM scan-run telemetry the engine is supposed to WRITE.
import { summarizeRvScanPath, __resetRvScanTelemetry } from './rv-scan-telemetry.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
// TRA-4692 — the TRA-4650 equity-seam admit runs every live bracket through the
// hard-controls choke point, whose kill/day-loss/idempotency state is module-
// global AND disk-persisted (48h retention). The bracket fixtures pin a fresh
// sandbox per test so they grade the seam, not residue from earlier tests or
// earlier RUNS of this suite.
import { __resetHardControlsForTest } from './hard-controls.js';
import { SignalEngine, sizeLiveEquityFromStop, shortBlockedOnCashAccount, isOccOptionSymbol, liveEquityDcaAddEnvAllowed, gateSignalOnReview, describeGatedStrategies, shouldBootArmLiveEquity, resolveLiveBrokerArmDrift, applyLiveBrokerArm, shouldRunRelativeValueScan, shouldRunOtmScan, isLiveBrokerOperator, resolveLiveBrokerOperator, activeOptionsDailyLimit, activeEquityDailyLimit, _resetSharedShadowForTests, _sharedShadowRefreshDue, _claimSharedShadowRefresh, _endSharedShadowRefresh, _sharedShadowEvalDue, _claimSharedShadowEval, shouldRunDecoupledQuoteRefresh, shouldRunDecoupledExitPass, decoupledExitPassDecision, emptyDecoupledExitSkips, DECOUPLED_EXIT_SKIP_REASONS, bucketExitInterval, emptyExitIntervalHistogram, EXIT_INTERVAL_BUCKETS, classifyExitInterval } from './signal-engine.js';
import { isStockMarketOpen } from '@trading-app/shared'; // TRA-2257
import { setShadowLedgerFileForTests } from './shadow-signal-ledger.js';
import { clearDirectionalOpenLedger } from './directional-open-ledger.js';
import {
  setReversalShadowLedgerFileForTests,
  buildReversalShadowOpen,
  recordReversalShadowSignal,
  resolveReversalShadowSignal,
  listReversalShadowSignals,
} from './reversal-shadow-ledger.js';
import {
  setOptionShadowLedgerFileForTests,
  initOptionShadowLedger,
  listOptionShadowSignals,
  OPTION_SHADOW_FLAG,
} from './option-shadow-ledger.js';
import { setIvStoreFileForTests, initIvRankStore, recordDailyIv, ivRankSync } from './iv-rank-store.js';
import {
  setOptionTradeJournalFileForTests,
  listOptionTradeJournal,
  OPTION_TRADE_JOURNAL_FLAG,
} from './option-trade-journal.js';
import {
  OPTION_DEMO_DIRECTIONAL_FLAG,
  OPTION_LIVE_DIRECTIONAL_FLAG,
  OPTION_IV_RV_SCANNER_FLAG,
  OPTION_IV_RV_ROUTING_FLAG,
  OPTION_SHORT_PREMIUM_SCANNER_FLAG,
  OPTION_WHEEL_ROUTING_FLAG,
  OPTION_LIVE_RV_LONG_FLAG,
  RV_ENGINE_FLAG, // TRA-4385
  OPTION_LIVE_OTM_FLAG,
  OPTION_LIVE_TEST_UNTIL_VAR,
  OPTION_OTM_DELTA_FLOOR_LIVE_FLAG,
  OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR,
} from './option-exec-flag.js';
import {
  clearLiveEnforceGateLedger,
  summarizeLiveEnforceGate,
} from './live-enforce-gate-ledger.js'; // TRA-2763
import { OPTION_LIVE_OTM_UNIVERSE_VAR } from './otm-live-universe-flag.js'; // TRA-3216
// TRA-4424 — the DAILY-BAR source behind the TRA-4422 setup seam. Read here
// rather than re-derived: the span this module publishes is the one the pure
// taxonomy computed, so a suite asserting on it cannot agree with itself while
// the seam scores some other series.
import {
  otmDailySeriesHealth,
  __resetOtmDailySeriesForTests,
  OTM_DAILY_SERIES_MAX_AGE_MS,
} from './otm-daily-series.js';
import { OTM_ADMISSIBLE_STRIKE_FLAG } from './otm-admissible-strike.js'; // TRA-3510
import { blackScholesPrice as bsPriceForWheel, daysToExpiration as dteForWheel } from '@trading-app/engine';
// TRA-3073 — the REAL client, as a value. The acceptance suite for the
// broker-flat sweep has to feed it status codes over a stubbed `fetch`: the
// whole defect is that a non-2xx and an empty book arrive at the sweep as the
// same `[]`, and a method-level stub cannot express that difference.
import { TradierOptionsClient as RealTradierOptionsClient } from '@trading-app/engine';
import {
  clearLiveOptionsFeeSlippageLedger,
  summarizeLiveOptionsFeeSlippage,
  knownLiveOptionBooks, // TRA-3977
} from './live-options-fee-slippage-ledger.js';
import {
  setPreTradeLiquidityLedgerFileForTests,
  listLiquidityGateDecisions,
  PRE_TRADE_LIQUIDITY_FLAG,
} from './pre-trade-liquidity-ledger.js';

// TRA-1929 — the RV live arm is now the flag AND an open bounded-test window
// (`OPTION_LIVE_TEST_UNTIL`). The armed-path suites below set a far-future window so
// the flag alone reaches the mirror mechanics they exercise.
const FAR_FUTURE_TEST_UNTIL = '99999999999999';
import { resetProposalStoreForTests, listProposals, getProposal } from './proposal-store.js';
import { PaperAccount } from './paper-account.js';
import type { RelativeValueScannerService, RelativeValueScanResult, OtmMispricingScanResult, SelectorChainSnapshot } from './relative-value-scanner.js';
import type { RelativeValueCandidate, OtmMispricingCandidate, TradierAccountBalance, TradierOptionsClient, TradierOrderClient, ReversalChecklist, SrZone } from '@trading-app/engine';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  isLiveTradierEquityEnabled,
  isLiveTradierOptionsEnabled,
  resolveLiveTradeEquitiesTradier,
  resolveLiveTradierMarkets,
  resolveMarketReviewGatesEnabled,
} from '@trading-app/shared';
import type {
  AccountSettings,
  TradeSignal,
  TradierEnv,
  MarketReview,
  MarketReviewGates,
  MarketRegimeLabel,
  Position,
  Candle,
} from '@trading-app/shared';

/**
 * TRA-4483 — a CONFIRMED clean cancel, the shape `cancelOrderConfirmed`
 * returns. The open-side maker walk calls this instead of `cancelOrder`
 * because it RE-PRICES over the cancel: `cancelOrder` reports whether the
 * DELETE was accepted (swallowing the 404/422 a FILLED order also returns),
 * which cannot tell a cancelled order from a filled one. `filledQty: 0` is a
 * real zero — the broker answered — so the walk may size a replacement from it.
 */
function stubConfirmedCancel(id: string | number) {
  return {
    kind: 'canceled' as const,
    terminalStatus: 'canceled',
    ackStatus: 200,
    ackError: null,
    detail: { id: Number(id), status: 'canceled', exec_quantity: 0 },
    filledQty: 0,
  };
}

// Inside an ET trading window: 10:20 AM ET on a Tuesday → 14:20 UTC during EDT.
//
// ⚠️ TRA-3942 moved this from 10:00 ET. The OTM sleeve now admits ENTRIES only
// inside 10:15–11:30 ET and 15:00–15:45 ET (board card `a29b2db8`, finding F1:
// 15 of 17 live entries filled 13:35–13:51Z, the widest-spread window of the
// session), and 10:00 ET is outside both — so every OTM-open case in this file
// was refused by the window before reaching the gate it was written to test,
// which is a vacuous pass wearing a red X. 10:20 ET is the same session, the
// same 50 minutes past the opening range, and inside the first window.
//
// It stays a SINGLE constant on purpose: a per-test clock would let the next
// entry-timing rule split this file into cases that were retimed and cases that
// were quietly left outside the window.
const TRADING_TIME = Date.parse('2024-06-04T14:20:00Z');

// TRA-1089 — the shadow 5m candle cache is now module-shared across engines, so
// it must be cleared between tests or a symbol seeded by one test leaks into a
// later test that relies on an empty cache (e.g. the "DO NOT seed → trend
// unknown" RV cases). Resets the fleet-wide window latches too.
afterEach(() => {
  _resetSharedShadowForTests();
});

function makeCandidate(overrides: Partial<RelativeValueCandidate> = {}): RelativeValueCandidate {
  return {
    optionSymbol: 'AAPL240705C00200000',
    underlying: 'AAPL',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    daysToExpiration: 31,
    mark: 1.20,
    bid: 1.18,
    ask: 1.22,
    spreadPct: 0.033,
    volume: 200,
    openInterest: 800,
    ivUsed: 0.22,
    ivFitted: 0.30,
    ivResidual: -0.08,
    zScore: -2.4,
    fairPrice: 1.55,
    mispricingPct: -0.226,
    classification: 'cheap',
    score: 5.6,
    reason: 'IV residual 2.40σ below fitted skew',
    // TRA-1159 — the default RV candidate must carry a *directional* delta (in the
    // 0.55–0.65 swing band) so `selectRvLongCandidate` admits it. TRA-972 added a
    // hard far-OTM |delta| floor (0.45, `RV_LONG_DELTA_FLOOR`): a deep-OTM cheap
    // strike (the old 0.18 default) is a pure vol-mispricing bet, not a directional
    // swing entry, so the selector now stands it down and no RV position opens. The
    // 0.18 fixture predated that floor; until the engine `dist` was rebuilt by the
    // TRA-1158 full-regression sweep the stale build masked it. These bridge/live
    // tests exercise RV open/sizing/mirror *mechanics*, not the OTM-rejection
    // policy, so the fixture now uses a 0.60 (in-band) delta. Tests that assert the
    // floor's stand-down override `delta` explicitly.
    delta: 0.60,
    ...overrides,
  };
}

// TRA-968 — the RV single-leg long now gates on the daily-trend confluence
// (the SAME Supertrend/MA-stack/MACD/RSI stack the spread selector reads),
// computed off the engine's cached 5m shadow series. Build a clean
// pullback-inside-an-uptrend tape so `confluenceSide` resolves `buy` → the
// default `call` candidate clears the gate. Mirrors the sawUp+build5m fixtures
// used by the SupertrendConfluence shadow tests below. Seed it before driving
// `runRelativeValueScan`; without a trend the scanner stands down (no entry).
function rvUptrend5m(): Candle[] {
  const closes: number[] = [];
  let p = 100;
  let i = 0;
  while (closes.length < 480) {
    const inUp = i % 4 !== 3; // 3 up-steps then 1 deeper dip — cools RSI, keeps drift up
    closes.push(p);
    p += inUp ? 0.5 : -1.0;
    i += 1;
  }
  while (closes.length > 2 && closes[closes.length - 1] <= closes[closes.length - 2]) closes.pop();
  const step = 5 * 60_000;
  return closes.map((close, idx) => ({
    symbol: 'AAPL',
    timestamp: idx * step,
    open: idx > 0 ? closes[idx - 1] : close,
    high: Math.max(close, idx > 0 ? closes[idx - 1] : close) + 0.5,
    low: Math.min(close, idx > 0 ? closes[idx - 1] : close) - 0.5,
    close,
    volume: 1_000,
  }));
}

function seedRvTrend(engine: SignalEngine, symbol = 'AAPL'): void {
  (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set(
    symbol,
    rvUptrend5m(),
  );
}

// TRA-1207 — OTM-mispricing candidate fixture (mirrors `makeCandidate` for the
// RV path). A cheap far-OTM call: mark below the BS theo built off smoothed IV.
function makeOtmCandidate(overrides: Partial<OtmMispricingCandidate> = {}): OtmMispricingCandidate {
  return {
    optionSymbol: 'AAPL240705C00210000',
    underlying: 'AAPL',
    optionType: 'call',
    strike: 210,
    expiration: '2024-07-05',
    daysToExpiration: 31,
    mark: 0.80,
    theo: 1.10,
    theoRaw: 1.10,
    mispricingPct: -0.27,
    classification: 'cheap',
    bid: 0.78,
    ask: 0.82,
    spreadPct: 0.05,
    openInterest: 600,
    volume: 150,
    ivUsed: 0.28,
    delta: 0.12,
    ...overrides,
  };
}

class StubScanner implements RelativeValueScannerService {
  scan = vi.fn<(symbol: string) => Promise<RelativeValueScanResult>>();
  scanOtm = vi.fn<(symbol: string) => Promise<OtmMispricingScanResult>>(async (symbol: string) => ({
    symbol, spot: null, expiration: null, candidates: [], reason: 'unavailable' as const,
  }));
  getSelectorChain = vi.fn<(symbol: string) => Promise<SelectorChainSnapshot | null>>(async () => null);
  getOptionMark = vi.fn<(symbol: string, expiration: string, optionSymbol: string) => Promise<number | null>>();
  diagnostics = vi.fn(() => ({
    configured: true,
    breakerOpen: false,
    breakerOpenedAtMs: null,
    cacheSize: 0,
    expirationsCacheSize: 0,
    chainCacheMaxEntries: 64,
    expirationsCacheMaxEntries: 64,
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  // TRA-3944 — the OTM contract floor is the FIRST cut on the OTM chain
  // (|Δ| ∈ [0.25, 0.40] by the board's ruling). The gates this file exercises
  // — the 0.55 delta ceiling, the 0.40 delta floor, the [0.495, 0.55) band
  // selector, the cost bar's measured cells — ALL live outside that band, so
  // under the ruled defaults the floor would eat their whole test population
  // and every assertion below would pass vacuously on an empty denominator
  // (the TRA-3926 trap, in a test). The band is widened HERE, for this file
  // only, via the same env knobs an operator would use; premium ($0.50) and
  // DTE ([21, 45]) keep the ruling and the fixtures clear them. The floor's
  // own behaviour is proved in `tra3944-otm-contract-floor.test.ts`.
  process.env.OTM_CONTRACT_FLOOR_DELTA_MIN = '0.01';
  process.env.OTM_CONTRACT_FLOOR_DELTA_MAX = '0.99';
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OTM_CONTRACT_FLOOR_DELTA_MIN;
  delete process.env.OTM_CONTRACT_FLOOR_DELTA_MAX;
});

describe('SignalEngine — relative-value scanner bridge', () => {
  // TRA-811 history: the board originally PAUSED RV (kill switch
  // `RV_ENGINE_ENABLED=false`). TRA-895 re-enabled it for the Jun 15-18 demo, and
  // on the TRA-1158 regression the board chose **defer** (RV stayed `true`).
  // TRA-1207 (board directive, 2026-06-30) SUPERSEDES that: "OTM Mispricing back
  // on and turn off Relative Value." That shipped as a compiled `false` kill
  // switch; TRA-4385 (board ruling TRA-4383, option c-rv-demo) env-resolved it
  // as `RV_ENGINE_ENABLED` (option-exec-flag.ts), DEFAULT OFF — so with the env
  // unset the RV gate still stands down even with every other condition
  // favorable, and arming the env starts the scan (demo evidence accrual; the
  // live entry stays dark behind `isOptionLiveRvLongArmed`).
  // The OTM engine below is armed in its place (see `shouldRunOtmScan` tests).
  // Existing managed RV exits run elsewhere and are intentionally not gated here.
  const favorable = {
    autoTradingEnabled: true,
    halted: false,
    hasScanner: true,
    marketOpen: true,
    skipOptionsForLiveEquityOnly: false,
  };
  const rvEngineArmed = { RV_ENGINE_ENABLED: '1' };

  it('shouldRunRelativeValueScan stays down even when every condition is favorable — RV_ENGINE_ENABLED unset defaults OFF (TRA-1207/TRA-4385)', () => {
    expect(shouldRunRelativeValueScan(favorable, {})).toBe(false);
  });

  it('TRA-4385 — arming the RV_ENGINE_ENABLED env flag starts the scan when conditions are favorable', () => {
    expect(shouldRunRelativeValueScan(favorable, rvEngineArmed)).toBe(true);
  });

  it('shouldRunRelativeValueScan stands down whenever any single gate input is unfavorable — even with the engine flag armed', () => {
    // Pre-TRA-4385 these asserted with the kill switch down, so every case was
    // vacuously false. Arm the engine flag so each input is load-bearing.
    expect(shouldRunRelativeValueScan({ ...favorable, autoTradingEnabled: false }, rvEngineArmed)).toBe(false);
    expect(shouldRunRelativeValueScan({ ...favorable, halted: true }, rvEngineArmed)).toBe(false);
    expect(shouldRunRelativeValueScan({ ...favorable, hasScanner: false }, rvEngineArmed)).toBe(false);
    expect(shouldRunRelativeValueScan({ ...favorable, marketOpen: false }, rvEngineArmed)).toBe(false);
    expect(shouldRunRelativeValueScan({ ...favorable, skipOptionsForLiveEquityOnly: true }, rvEngineArmed)).toBe(false);
  });

  // TRA-1207 — board directive (local-board): "OTM Mispricing back on and turn
  // off Relative Value." RV is now paused (asserted above) and the OTM engine
  // is armed, so its per-tick gate must return true when all conditions are
  // favorable — the mirror image of the RV gate now being off.
  it('shouldRunOtmScan returns true when armed and all conditions favorable (TRA-1207)', () => {
    expect(
      shouldRunOtmScan({
        autoTradingEnabled: true,
        halted: false,
        hasScanner: true,
        marketOpen: true,
        skipOptionsForLiveEquityOnly: false,
      }),
    ).toBe(true);
  });

  it('shouldRunOtmScan returns false when auto-trading is off (TRA-1207)', () => {
    expect(
      shouldRunOtmScan({
        autoTradingEnabled: false,
        halted: false,
        hasScanner: true,
        marketOpen: true,
        skipOptionsForLiveEquityOnly: false,
      }),
    ).toBe(false);
  });

  it('runOtmScan opens an OTM-mispricing position from a `cheap` candidate and records a signal (TRA-1207)', async () => {
    const scanner = new StubScanner();
    scanner.scanOtm.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeOtmCandidate()],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    const opened = state.options.openOptions[0];
    expect(opened.optionSymbol).toBe('AAPL240705C00210000');
    expect(opened.signalType).toBe('otm_mispricing');

    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].type).toBe('otm_mispricing');
    expect(state.signals[0].symbol).toBe('AAPL');
  });

  // TRA-1670 (TRA-1647B) — the entry-delta CEILING, end-to-end through the real OTM
  // open path. QuantTrader's explicit ask on the ticket: "carry a test asserting the
  // ceiling is REJECTING, not just present ... I'd rather the test fail loudly." The
  // cost-aware gate cannot make this cut — it is algebraically a delta FLOOR — so if
  // this assertion ever goes green-while-inert, the Δ>0.55 loss tail (n=14, NET
  // −1.813R) is back in the book with nothing above it.
  describe('entry-delta ceiling on the OTM open (TRA-1670)', () => {
    const CEILING_ENV = [
      'OPTION_ENTRY_DELTA_CEILING_ENABLED',
      'OPTION_ENTRY_DELTA_CEILING',
      'OPTION_ENTRY_DELTA_CEILING_STRUCTURES',
      'OPTION_ENTRY_DELTA_CEILING_OBSERVE_STRUCTURES',
      'DATA_DIR',
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of CEILING_ENV) saved[k] = process.env[k];
      // Resolve flags straight through process.env (no demo-flags.json overlay).
      delete process.env.DATA_DIR;
      clearCostAwareGateLedger();
    });
    afterEach(() => {
      for (const k of CEILING_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    const scanFor = (delta: number): StubScanner => {
      const scanner = new StubScanner();
      scanner.scanOtm.mockResolvedValue({
        symbol: 'AAPL',
        spot: 195,
        expiration: '2024-07-05',
        candidates: [makeOtmCandidate({ delta })],
        reason: 'ok',
      });
      return scanner;
    };

    const runOtm = async (scanner: StubScanner) => {
      const engine = new SignalEngine(undefined, undefined, scanner);
      await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);
      return engine;
    };

    it('REJECTS a Δ=0.60 OTM candidate when armed — no position opens, reason surfaced', async () => {
      process.env.OPTION_ENTRY_DELTA_CEILING_ENABLED = '1';
      const engine = await runOtm(scanFor(0.60));

      const state = engine.getState();
      expect(state.options.openOptions).toHaveLength(0);
      // The reject is VISIBLE (churn-brake pattern), not a silent drop.
      expect(state.signals).toHaveLength(1);
      expect(state.signals[0].signalSkipReason).toContain('entry delta ceiling');
    });

    it('ADMITS a Δ=0.50 OTM candidate when armed — the ceiling cuts the tail, not the sleeve', async () => {
      process.env.OPTION_ENTRY_DELTA_CEILING_ENABLED = '1';
      const engine = await runOtm(scanFor(0.50));

      const state = engine.getState();
      expect(state.options.openOptions).toHaveLength(1);
      expect(state.options.openOptions[0]!.signalType).toBe('otm_mispricing');
      expect(state.signals[0].signalSkipReason).toBeUndefined();
    });

    it('is DARK by default — the same Δ=0.60 candidate opens with the flag off', async () => {
      delete process.env.OPTION_ENTRY_DELTA_CEILING_ENABLED;
      const engine = await runOtm(scanFor(0.60));
      expect(engine.getState().options.openOptions).toHaveLength(1);
    });

    it('honours the OPTION_ENTRY_DELTA_CEILING override (TRA-1647 invalidation = a retune)', async () => {
      process.env.OPTION_ENTRY_DELTA_CEILING_ENABLED = '1';
      process.env.OPTION_ENTRY_DELTA_CEILING = '0.70';
      const engine = await runOtm(scanFor(0.60));
      expect(engine.getState().options.openOptions).toHaveLength(1);
    });

    // TRA-1689 — the per-structure form. Arming another sleeve at a looser number must
    // not drag OTM's MEASURED 0.55 up with it; under the old global scalar it did, and
    // the Δ>0.55 loss tail (n=14, NET −1.813R) came back with no error and no log line.
    it('arming RV at 0.65 leaves the OTM ceiling at 0.55 — the Δ=0.60 tail is still cut', async () => {
      process.env.OPTION_ENTRY_DELTA_CEILING_ENABLED = '1';
      process.env.OPTION_ENTRY_DELTA_CEILING_STRUCTURES = 'single_leg_otm,single_leg_rv:0.65';
      const engine = await runOtm(scanFor(0.60));

      expect(engine.getState().options.openOptions).toHaveLength(0);
      expect(engine.getState().signals[0]!.signalSkipReason).toContain('entry delta ceiling');
    });

    // TRA-1689 — observe-only. The breach is COUNTED and the trade STILL OPENS: that is
    // what lets a ceiling accrue an n on the tail it wants to cut before the sleeve pays
    // for the guess. An observed breach must never land on the REJECTED counter — one is
    // a trade that did not happen, the other is a trade that did (TRA-1682).
    it('OBSERVE-ONLY: a Δ=0.60 breach OPENS, and is counted as observed — never as rejected', async () => {
      process.env.OPTION_ENTRY_DELTA_CEILING_ENABLED = '1';
      process.env.OPTION_ENTRY_DELTA_CEILING_OBSERVE_STRUCTURES = 'single_leg_otm';
      const engine = await runOtm(scanFor(0.60));

      // The open PROCEEDED — same as if the ceiling were off.
      const state = engine.getState();
      expect(state.options.openOptions).toHaveLength(1);
      expect(state.signals[0]!.signalSkipReason).toBeUndefined();

      // ...but the breach is on the books, on its OWN axis.
      const summary = summarizeCostAwareGate(etDateString(new Date()));
      const otm = summary.byStructure.find((s) => s.structure === 'single_leg_otm');
      expect(otm?.deltaCeilingObserved).toBe(1);
      expect(otm?.avgDeltaCeilingObservedAbsDelta).toBeCloseTo(0.60, 5);
      expect(otm?.deltaCeilingRejected).toBe(0);
      expect(summary.deltaCeilingRejectedTotal).toBe(0);
      expect(summary.deltaCeilingObservedTotal).toBe(1);
    });
  });

  // ── TRA-3504 — THE HOIST, and the reason it needs a test of its own ────────
  //
  // The live ceiling used to sit BELOW `costAwareGateReject`, which `continue`s on
  // reject at a measured retained block rate of 0.9928 (1929/1943) with a deployed
  // tape admitting exactly one cell, `0.50-0.55`. Downstream of that bar every
  // surviving candidate has |Δ| ∈ [0.50, 0.55) and cannot breach a 0.55 ceiling —
  // so `entry_delta_ceiling_shadow.blocked` was pinned to 0 BY CONSTRUCTION and
  // read identically to a clean far-tail. QuantTrader held the observe flip on
  // TRA-3501 rather than publish that vacuous zero.
  //
  // These assert the ordering BEHAVIOURALLY: a candidate the armed live cost bar
  // DECLINES must still have reached the ceiling and been recorded. Against the
  // old order every one of them reads `evaluated: 0`. If someone re-sinks the
  // ceiling below the bar, this suite goes red instead of going quietly vacuous.
  describe('live entry-delta ceiling is ordered ABOVE the cost bar (TRA-3504)', () => {
    const HOIST_ENV = [
      'ENABLE_OPTION_COST_GATE_LIVE_ENFORCE',
      'ENABLE_OPTION_ENTRY_DELTA_CEILING_LIVE',
      'ENABLE_OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE',
      'OPTION_ENTRY_DELTA_CEILING_LIVE',
      'OPTION_LIVE_OTM_UNIVERSE',
      'DATA_DIR',
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of HOIST_ENV) saved[k] = process.env[k];
      for (const k of HOIST_ENV) delete process.env[k];
      clearLiveEnforceGateLedger();
      clearCostAwareGateLedger();
      // The bar ARMED AND ENFORCING on the live path — exactly how bqb1 runs it.
      process.env.ENABLE_OPTION_COST_GATE_LIVE_ENFORCE = '1';
      // The ceiling dark-but-recording: the state TRA-3501 wants to flip into.
      process.env.ENABLE_OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE = '1';
    });
    afterEach(() => {
      for (const k of HOIST_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    const runLiveOtm = async (delta: number) => {
      const scanner = new StubScanner();
      scanner.scanOtm.mockResolvedValue({
        symbol: 'AAPL',
        spot: 195,
        expiration: '2024-07-05',
        candidates: [makeOtmCandidate({ delta })],
        reason: 'ok',
      });
      const engine = new SignalEngine(undefined, undefined, scanner);
      (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
      await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);
      return engine;
    };
    const gate = (g: string) =>
      summarizeLiveEnforceGate(etDateString(new Date())).byGate.find((x) => x.gate === g);

    it('records the shadow verdict for a Δ=0.60 candidate the armed cost bar DECLINES', async () => {
      await runLiveOtm(0.60);

      // Precondition — this really is a candidate the bar refuses. Without this the
      // test could pass on a candidate the bar admitted, which proves nothing about
      // ordering (the old order handles that case fine).
      const bar = gate('cost_bar');
      expect(bar?.blocked).toBe(1);

      // THE HOIST. Below the bar this is `evaluated: 0` — the gate never runs.
      const shadow = gate('entry_delta_ceiling_shadow');
      expect(shadow?.evaluated).toBe(1);
      // ...and the far-tail breach is COUNTED, which is the read TRA-3501 needs.
      expect(shadow?.blocked).toBe(1);
      expect(shadow?.byReason[0]?.reasonCode).toBe('above_mandate_ceiling');
    });

    it('records the shadow verdict for a Δ=0.05 candidate the armed cost bar DECLINES', async () => {
      await runLiveOtm(0.05);

      expect(gate('cost_bar')?.blocked).toBe(1);

      // Evaluated but NOT breached: 0.05 is far below the 0.55 ceiling. This is the
      // per-band denominator that turns the zero above into a checkable zero — it
      // separates "looked at, did not breach" from "never looked at" (TRA-1407).
      const shadow = gate('entry_delta_ceiling_shadow');
      expect(shadow?.evaluated).toBe(1);
      expect(shadow?.blocked).toBe(0);
    });

    it('is a PURE INSTRUMENTATION hoist — observe mode still opens, and blocks nothing', async () => {
      const engine = await runLiveOtm(0.60);
      // The ceiling recorded and returned null; the open was stopped by the COST
      // BAR, on the cost bar's reason — attribution is unchanged while dark.
      expect(engine.getState().signals[0]?.liveSkipReason ?? '').not.toContain('ceiling');
      // Nothing landed on the ENFORCING gate — observe records on the shadow axis
      // only. (`byGate` enumerates every gate, so the read is `evaluated: 0`, not
      // an absent row — which is exactly the ambiguity the shadow counter exists
      // to resolve, and why the two tests above assert `evaluated`, not presence.)
      expect(gate('entry_delta_ceiling')?.evaluated).toBe(0);
    });

    it('stays OFF by default — no shadow gate exists with the observe flag clear', async () => {
      delete process.env.ENABLE_OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE;
      await runLiveOtm(0.60);

      // The bar still ran (proving the candidate reached the stack at all), but the
      // hoisted call recorded NOTHING: `mode === 'off'` returns before the ledger.
      expect(gate('cost_bar')?.blocked).toBe(1);
      expect(gate('entry_delta_ceiling_shadow')?.evaluated).toBe(0);
    });
  });

  // ── TRA-3510 — THE FLOOR HOIST, and the nominator-selection axis ───────────
  //
  // TRA-3504 hoisted the CEILING above the cost bar. The FLOOR half stayed below
  // it, and it is the worse pin of the two: the bar is ALGEBRAICALLY a delta floor
  // at 0.4950 (`3|Δ| − 1 ≥ 0.485`), so it blocks a strict SUPERSET of what a floor
  // at 0.40 would — the floor below it could never record a single block no matter
  // how the live tape moved. Measured on the retained window: 170 of 170 attributed
  // post-universe rows blocked `gross_negative`, i.e. every live nominee sat under
  // 0.495.
  //
  // These assert the ordering BEHAVIOURALLY, the same way the TRA-3504 suite does:
  // a candidate the armed live cost bar DECLINES must still have reached the floor
  // and been recorded. Against the old order the first one reads `evaluated: 0`.
  describe('live OTM delta floor is ordered ABOVE the cost bar (TRA-3510)', () => {
    const FLOOR_ENV = [
      'ENABLE_OPTION_COST_GATE_LIVE_ENFORCE',
      OPTION_OTM_DELTA_FLOOR_LIVE_FLAG,
      OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR,
      OTM_ADMISSIBLE_STRIKE_FLAG,
      'OPTION_LIVE_OTM_UNIVERSE',
      'DATA_DIR',
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of FLOOR_ENV) saved[k] = process.env[k];
      for (const k of FLOOR_ENV) delete process.env[k];
      clearLiveEnforceGateLedger();
      clearCostAwareGateLedger();
      // The bar ARMED AND ENFORCING on the live path — exactly how bqb1 runs it.
      // Without this the suite would prove nothing about ordering: the whole
      // question is what survives the 0.9928 `continue`.
      process.env.ENABLE_OPTION_COST_GATE_LIVE_ENFORCE = '1';
      // The floor armed at its shipped 0.40 default (no value override — the
      // deployed number is what the hoist has to be readable under).
      process.env[OPTION_OTM_DELTA_FLOOR_LIVE_FLAG] = '1';
    });
    afterEach(() => {
      for (const k of FLOOR_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    /** Drive the REAL `runOtmScan` live path over a one-candidate chain. */
    const runLiveOtm = async (candidates: OtmMispricingCandidate[]) => {
      const scanner = new StubScanner();
      scanner.scanOtm.mockResolvedValue({
        symbol: 'AAPL',
        spot: 195,
        expiration: '2024-07-05',
        candidates,
        reason: 'ok',
      });
      const engine = new SignalEngine(undefined, undefined, scanner);
      (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
      await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);
      return engine;
    };
    const gate = (g: string) =>
      summarizeLiveEnforceGate(etDateString(new Date())).byGate.find((x) => x.gate === g);

    it('records the floor verdict for a Δ=0.05 candidate the armed cost bar DECLINES', async () => {
      await runLiveOtm([makeOtmCandidate({ delta: 0.05 })]);

      // THE HOIST. Below the bar this is `evaluated: 0` — the gate never runs,
      // because the bar `continue`d on a candidate it is algebraically certain to
      // reject. That assertion is what proves the ordering rather than assuming it.
      const floor = gate('otm_delta_floor');
      expect(floor?.evaluated).toBe(1);
      expect(floor?.blocked).toBe(1);
      expect(floor?.byReason[0]?.reasonCode).toBe('below_floor');

      // ...and the attribution MOVED: the floor now `continue`s first, so the bar
      // never sees this candidate. That step-down in `cost_bar`'s denominator is
      // the correct attribution of a mandate breach, not a cost decline.
      expect(gate('cost_bar')?.evaluated).toBe(0);
    });

    it('records an ADMIT for a Δ=0.52 candidate — the per-band denominator that makes a zero checkable', async () => {
      await runLiveOtm([makeOtmCandidate({ delta: 0.52 })]);

      const floor = gate('otm_delta_floor');
      expect(floor?.evaluated).toBe(1);
      expect(floor?.blocked).toBe(0);

      // The candidate CLEARED the floor and went on to the bar, so the hoist is a
      // reordering and not a new rejection: `evaluated > 0` on both gates.
      expect(gate('cost_bar')?.evaluated).toBe(1);
    });

    it('is behaviour-neutral while DISARMED — the flag off records nothing and the bar still rules', async () => {
      delete process.env[OPTION_OTM_DELTA_FLOOR_LIVE_FLAG];
      const engine = await runLiveOtm([makeOtmCandidate({ delta: 0.05 })]);

      // The method returns null before recording anything, so the hoisted call is
      // inert and the open is stopped by the COST BAR on the cost bar's reason —
      // which is the whole "value-neutral" claim, asserted rather than asserted-of.
      expect(gate('otm_delta_floor')?.evaluated).toBe(0);
      expect(gate('cost_bar')?.blocked).toBe(1);
      expect(engine.getState().options.openOptions).toHaveLength(0);
    });

    // ── The nominator-selection axis (Ask 2) ────────────────────────────────
    //
    // `otm_delta_floor.blocked === 0` has two byte-identical causes once TRA-3401
    // is armed: the selector clamped every row into `[0.495, 0.55)` (vacuous — an
    // `in_band` nominee cannot breach a floor at 0.40 BY CONSTRUCTION), or the low
    // tail was nominated and genuinely cleared. `bySelection` is the only axis on
    // the payload that separates them.
    //
    // TRA-3856: armed, the low tail can no longer be nominated AT ALL — the old
    // fallback branch abstains, and an abstained scan reaches no gate. The axis
    // now discriminates the TIERS (`in_band` vs `in_band_fair`), and the absence
    // of a verdict is itself the abstention's signature (plus the scan-run
    // reject bucket `no_in_band_strike`, which is counted, not silent).
    describe('bySelection separates a clamped zero from a measured one', () => {
      beforeEach(() => {
        process.env[OTM_ADMISSIBLE_STRIKE_FLAG] = '1';
      });

      it('an in_band pick and an in_band_fair pick land on DISTINCT rows; an abstained chain lands on NONE', async () => {
        // Chain A: a cheap strike inside the ratified band ⇒ `in_band`.
        await runLiveOtm([
          makeOtmCandidate({ optionSymbol: 'AAPL240705C00200000', delta: 0.05 }),
          makeOtmCandidate({ optionSymbol: 'AAPL240705C00205000', delta: 0.52 }),
        ]);
        // Chain B: only a `fair` strike in band ⇒ TIER 2, `in_band_fair`.
        await runLiveOtm([
          makeOtmCandidate({ optionSymbol: 'AAPL240705C00210000', delta: 0.05 }),
          makeOtmCandidate({
            optionSymbol: 'AAPL240705C00220000', delta: 0.53, classification: 'fair',
          }),
        ]);
        // Chain C: nothing in band ⇒ ABSTAIN (TRA-3856). The far low tail is
        // never nominated, so no gate ever sees this chain.
        await runLiveOtm([makeOtmCandidate({ optionSymbol: 'AAPL240705C00215000', delta: 0.05 })]);

        const floor = gate('otm_delta_floor');
        expect(floor?.evaluated).toBe(2); // chains A and B only — C abstained

        const inBand = floor?.bySelection.find((s) => s.selection === 'in_band');
        const inBandFair = floor?.bySelection.find((s) => s.selection === 'in_band_fair');

        // Two rows, not one bucket — the axis discriminates the tiers; and no
        // `fallback_top_mispricing` row can exist post-TRA-3856.
        expect(floor?.bySelection).toHaveLength(2);
        expect(floor?.bySelection.some((s) => s.selection === 'fallback_top_mispricing')).toBe(false);

        // Both rows cleared the floor because the SELECTOR put them above
        // 0.495, not because the floor measured anything — the vacuous zero,
        // now on every armed row by construction.
        expect(inBand?.evaluated).toBe(1);
        expect(inBand?.blocked).toBe(0);
        expect(inBand?.meanCheapConsidered).toBe(2);
        expect(inBand?.meanCheapInBand).toBe(1);

        // The tier-2 row is definitionally `cheapInBand: 0` — the tier exists
        // precisely because nothing cheap was in band.
        expect(inBandFair?.evaluated).toBe(1);
        expect(inBandFair?.blocked).toBe(0);
        expect(inBandFair?.meanCheapInBand).toBe(0);
        expect(inBandFair?.rowsWithChainShape).toBe(1);
      });

      it('the axis is present on the RETAINED fold too, not only the current ET day', async () => {
        await runLiveOtm([
          makeOtmCandidate({ delta: 0.05 }),
          makeOtmCandidate({
            optionSymbol: 'AAPL240705C00220000', delta: 0.53, classification: 'fair',
          }),
        ]);
        const retained = summarizeLiveEnforceGate(etDateString(new Date()))
          .retained.byGate.find((x) => x.gate === 'otm_delta_floor');
        expect(retained?.bySelection.map((s) => s.selection)).toEqual(['in_band_fair']);
      });

      it('a DISARMED selector folds to `legacy` — armed-and-empty never reads as never-armed', async () => {
        delete process.env[OTM_ADMISSIBLE_STRIKE_FLAG];
        await runLiveOtm([makeOtmCandidate({ delta: 0.05 })]);

        const floor = gate('otm_delta_floor');
        expect(floor?.bySelection).toHaveLength(1);
        expect(floor?.bySelection[0]?.selection).toBe('legacy');
        // Dark ⇒ the band was never applied, so `cheapInBand` is 0 as a statement
        // about the SELECTOR, not about the chain. Same number, different fact —
        // which is why `selection` has to be read before either mean.
        expect(floor?.bySelection[0]?.meanCheapInBand).toBe(0);
      });

      // ── TRA-3619 × TRA-3856: the abstention end to end ─────────────────────
      //
      // Chains where nothing in band is nominable now ABSTAIN instead of
      // nominating the far tail. These drive the REAL live scan and assert the
      // abstention's signature: no gate verdict, no open — never a lottery-tail
      // nomination.
      it('an all-`expensive` band ABSTAINS: no gate verdict, no open', async () => {
        const engine = await runLiveOtm([
          makeOtmCandidate({ optionSymbol: 'AAPL240705C00210000', delta: 0.05 }),
          // In band but IV-rich — nominable under no tier.
          makeOtmCandidate({
            optionSymbol: 'AAPL240705C00205000', delta: 0.52, classification: 'expensive',
          }),
        ]);

        expect(gate('otm_delta_floor')?.evaluated ?? 0).toBe(0);
        expect(gate('cost_bar')?.evaluated ?? 0).toBe(0);
        expect(engine.getState().options.openOptions).toHaveLength(0);
      });

      it('a chain with NO in-band strike abstains identically — the far tail is never nominated', async () => {
        const engine = await runLiveOtm([
          makeOtmCandidate({ optionSymbol: 'AAPL240705C00210000', delta: 0.05 }),
          makeOtmCandidate({
            optionSymbol: 'AAPL240705C00215000', delta: 0.11, classification: 'expensive',
          }),
        ]);

        expect(gate('otm_delta_floor')?.evaluated ?? 0).toBe(0);
        expect(engine.getState().options.openOptions).toHaveLength(0);
      });

      it('the strike counts ride the in_band_fair rows that DO reach the fold', async () => {
        await runLiveOtm([
          makeOtmCandidate({ delta: 0.05 }),
          makeOtmCandidate({
            optionSymbol: 'AAPL240705C00205000', delta: 0.52, classification: 'expensive',
          }),
          makeOtmCandidate({
            optionSymbol: 'AAPL240705C00220000', delta: 0.53, classification: 'fair',
          }),
        ]);
        const retained = summarizeLiveEnforceGate(etDateString(new Date()))
          .retained.byGate.find((x) => x.gate === 'otm_delta_floor');
        const fair = retained?.bySelection
          .find((s) => s.selection === 'in_band_fair');
        expect(fair?.meanStrikesInBand).toBe(2); // the expensive 0.52 is counted
        expect(fair?.meanCheapInBand).toBe(0);
        expect(fair?.rowsWithStrikeShape).toBe(1);
      });
    });
  });

  it('runOtmScan ignores `expensive` OTM candidates (long-only path) (TRA-1207)', async () => {
    const scanner = new StubScanner();
    scanner.scanOtm.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeOtmCandidate({ classification: 'expensive', mispricingPct: 0.30 })],
      reason: 'ok',
    });
    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);
    expect(engine.getState().options.openOptions).toHaveLength(0);
  });

  // ── TRA-2262 (parent TRA-2203) — the per-tick fan-out bound, END TO END ────
  // The helper's own suite proves the sweep mechanics. These prove the bound is
  // WIRED: that the engine's real sink truncates at the budget and resumes at
  // the symbol it stopped on. Without them a green suite would only be saying
  // "nothing broke on a 1-symbol universe", which is every existing scan test.
  describe('runOtmScan is budgeted and cursored (TRA-2262)', () => {
    /** One "symbol" of feed latency, charged against the sweep's wall clock. */
    const chargeSeconds = (s: number) => vi.setSystemTime(new Date(Date.now() + s * 1000));

    const slowScanner = (secondsPerSymbol: number): StubScanner => {
      const scanner = new StubScanner();
      scanner.scanOtm.mockImplementation(async (sym: string) => {
        chargeSeconds(secondsPerSymbol);
        return { symbol: sym, spot: 195, expiration: '2024-07-05', candidates: [], reason: 'ok' };
      });
      return scanner;
    };
    const runScan = (engine: SignalEngine, symbols: string[]) =>
      (engine as unknown as { runOtmScan: (s: string[]) => Promise<SweepPass | null> }).runOtmScan(symbols);

    beforeEach(() => { resetSweepCursors(); });

    it('stops at the wall-clock budget instead of walking the whole universe', async () => {
      const engine = new SignalEngine(undefined, undefined, slowScanner(16));
      const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);

      const pass = await runScan(engine, symbols);

      // 2 × 16s trips the 30s budget; the old loop ran all 20 (320s in one tick).
      expect(pass!.processed).toEqual(['S0', 'S1']);
      expect(pass!.budgetExhausted).toBe(true);
      expect(pass!.complete).toBe(false);
      expect(pass!.resumeAt).toBe('S2');
    });

    it('the NEXT pass resumes where the last stopped, and the rotation covers the universe', async () => {
      const engine = new SignalEngine(undefined, undefined, slowScanner(16));
      const symbols = Array.from({ length: 6 }, (_, i) => `S${i}`);

      const seen: string[] = [];
      const starts: number[] = [];
      for (let n = 0; n < 3; n++) {
        const pass = await runScan(engine, symbols);
        starts.push(pass!.startIndex);
        seen.push(...pass!.processed);
      }

      expect(starts).toEqual([0, 2, 4]);
      expect(seen).toEqual(symbols); // every symbol exactly once, across 3 ticks
    });

    it('a cursor is per-ENGINE, so a second engine does not consume the first\'s rotation', async () => {
      const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
      const demo = new SignalEngine(undefined, undefined, slowScanner(16));
      const live = new SignalEngine(undefined, undefined, slowScanner(16));
      (live as unknown as { mode: 'demo' | 'live' }).mode = 'live';

      await runScan(demo, symbols);
      const livePass = await runScan(live, symbols);

      expect(livePass!.startIndex).toBe(0);
    });

    it('a fast sweep completes in one pass and clears its cursor (no behaviour change below the budget)', async () => {
      const engine = new SignalEngine(undefined, undefined, slowScanner(0));
      const symbols = ['AAPL', 'MSFT', 'NVDA'];

      const pass = await runScan(engine, symbols);

      expect(pass!.complete).toBe(true);
      expect(pass!.budgetExhausted).toBe(false);
      expect(pass!.processed).toEqual(symbols);
      expect(sweepCursorSnapshot()['demo:-:otm-scan']).toBeUndefined();
    });
  });

  // TRA-3557 — scan-run telemetry on the OTM sleeve.
  //
  // ⚠️ These drive the REAL `runOtmScan` and read the shared telemetry store. That
  // is the entire point: `rv-scan-telemetry.test.ts` already proves `RvScanRun`
  // counts correctly, and `health-routes.test.ts` proves the route publishes it —
  // neither can say the engine ever CALLS it. A test that opens its own
  // `beginRvScan('otm', …)` would pass just as green against an uninstrumented
  // `runOtmScan`, which is the state this ticket exists to fix.
  describe('runOtmScan opens a scan run (TRA-3557)', () => {
    const chargeSeconds = (s: number) => vi.setSystemTime(new Date(Date.now() + s * 1000));

    /** Scanner that returns `n` empty-but-OK chains, charging `secs` of latency each. */
    const emptyScanner = (secs = 0): StubScanner => {
      const scanner = new StubScanner();
      scanner.scanOtm.mockImplementation(async (sym: string) => {
        if (secs) chargeSeconds(secs);
        return { symbol: sym, spot: 195, expiration: '2024-07-05', candidates: [], reason: 'ok' };
      });
      return scanner;
    };
    const runScan = (engine: SignalEngine, symbols: string[]) =>
      (engine as unknown as { runOtmScan: (s: string[]) => Promise<SweepPass | null> }).runOtmScan(symbols);
    const otmView = () => summarizeRvScanPath('otm', { enabled: true, instrumented: true });

    beforeEach(() => { resetSweepCursors(); __resetRvScanTelemetry(); });

    // THE ticket. Before this, an all-`continue` OTM pass left nothing anywhere:
    // the `continue` is upstream of the nominator, of `recordLiveEnforceDecision`
    // and of the universe gate, so `cost_bar.evaluated === 0` was produced
    // identically by "scanned 10 names, found nothing" and "never scanned".
    it('a scan that finds NOTHING reports the symbols CONSIDERED, not zero', async () => {
      const engine = new SignalEngine(undefined, undefined, emptyScanner());

      await runScan(engine, ['AAPL', 'MSFT', 'NVDA']);

      const view = otmView();
      expect(view.scanCountSinceBoot).toBe(1);
      expect(view.lastScanAt).not.toBeNull();
      const last = view.lastScan!;
      // 3, not 0 — input-counted at the top of the loop body.
      expect(last.candidatesEvaluated).toBe(3);
      expect(last.universeSize).toBe(3);
      expect(last.candidatesPassed).toBe(0);
      expect(last.opensPlaced).toBe(0);
      expect(last.rejectionsByGate).toEqual({ no_candidates: 3 });
      expect(last.bucketsBalance).toBe(true);
      // A usable chain came back on every name, so the feed is healthy — this is
      // what separates a dead provider from a quiet tape on the OTM axis.
      expect(view.lastFetchOkAt).not.toBeNull();
    });

    // The fail state of the test above. If the sleeve stands down, it must record
    // NO scan at all — `lastScanAt: null`, "never ran" — rather than a zero-count
    // scan that reads as "ran, found nothing". This is why the run is opened BELOW
    // the early-return gates rather than at the top of the method.
    it('a stood-down sleeve records NO scan run at all', async () => {
      const engine = new SignalEngine(undefined, undefined, undefined);

      const pass = await runScan(engine, ['AAPL', 'MSFT', 'NVDA']);

      expect(pass).toBeNull();
      const view = otmView();
      expect(view.scanCountSinceBoot).toBe(0);
      expect(view.lastScanAt).toBeNull();
      expect(view.lastScan).toBeNull();
    });

    // Pooling these would re-create the ticket's own ambiguity one level down: an
    // empty chain is a negative to grade the sleeve on, a provider failure is an
    // outage that VOIDS the grade.
    it('splits a provider failure from a genuinely empty chain', async () => {
      const scanner = new StubScanner();
      scanner.scanOtm.mockImplementation(async (sym: string) =>
        sym === 'AAPL'
          ? { symbol: sym, spot: 0, expiration: null, candidates: [], reason: 'no_chain' }
          : { symbol: sym, spot: 195, expiration: '2024-07-05', candidates: [], reason: 'ok' });
      const engine = new SignalEngine(undefined, undefined, scanner);

      await runScan(engine, ['AAPL', 'MSFT']);

      const last = otmView().lastScan!;
      expect(last.rejectionsByGate).toEqual({ 'scan:no_chain': 1, no_candidates: 1 });
      expect(last.bucketsBalance).toBe(true);
    });

    // The constraint the ticket named: `runOtmScan` returns a budgeted `SweepPass`,
    // so a truncated pass must not close its run reading like a full sweep.
    it('a budget-TRUNCATED pass closes its run honestly', async () => {
      const engine = new SignalEngine(undefined, undefined, emptyScanner(16));
      const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);

      const pass = await runScan(engine, symbols);
      expect(pass!.budgetExhausted).toBe(true);

      const last = otmView().lastScan!;
      expect(last.universeSize).toBe(20);
      expect(last.candidatesEvaluated).toBe(2);
      // The 18-symbol gap is EXPLAINED. Without this it is indistinguishable from
      // the loop dying at symbol 2.
      expect(last.stoppedEarlyReason).toBe('sweep_budget_exhausted');
      expect(last.sweep).toEqual({
        startIndex: 0, processed: 2, complete: false,
        budgetExhausted: true, stopped: false, resumeAt: 'S2',
      });
    });

    // A RESUMED pass reaches the end of the universe (`complete: true`) having
    // walked only its tail — the case a completeness flag alone gets wrong.
    it('a RESUMED tail is named too, and its slice is published', async () => {
      const engine = new SignalEngine(undefined, undefined, emptyScanner(16));
      const symbols = Array.from({ length: 4 }, (_, i) => `S${i}`);

      await runScan(engine, symbols);          // S0,S1 — truncated
      const second = await runScan(engine, symbols); // S2,S3 — resumed, reaches the end

      expect(second!.complete).toBe(true);
      expect(second!.startIndex).toBe(2);
      const last = otmView().lastScan!;
      expect(last.candidatesEvaluated).toBe(2);
      expect(last.universeSize).toBe(4);
      expect(last.stoppedEarlyReason).toBe('sweep_resumed_tail');
      expect(last.sweep!.startIndex).toBe(2);
      // Two passes, two scan runs — the counter advances per PASS, not per sweep.
      expect(otmView().scanCountSinceBoot).toBe(2);
    });

    // POSITIVE CONTROL for the two above. If `stoppedEarlyReason` were set
    // unconditionally they would both pass against an instrument that reports
    // "truncated" always — the reason has to have a demonstrable null state.
    it('a FULL sweep from the head records NO early-stop reason', async () => {
      const engine = new SignalEngine(undefined, undefined, emptyScanner());

      const pass = await runScan(engine, ['AAPL', 'MSFT', 'NVDA']);

      expect(pass!.complete).toBe(true);
      const last = otmView().lastScan!;
      expect(last.stoppedEarlyReason).toBeNull();
      expect(last.sweep).toEqual({
        startIndex: 0, processed: 3, complete: true,
        budgetExhausted: false, stopped: false, resumeAt: null,
      });
    });

    // The other end of the ledger: a symbol that clears every gate and opens is
    // counted as passed AND opened, so `candidatesPassed - opensPlaced` isolates
    // account-level refusals from scanner-level rejections.
    it('counts a real open as passed AND opened, with the buckets balancing', async () => {
      const scanner = new StubScanner();
      scanner.scanOtm.mockImplementation(async (sym: string) =>
        sym === 'AAPL'
          ? { symbol: sym, spot: 195, expiration: '2024-07-05', candidates: [makeOtmCandidate()], reason: 'ok' }
          : { symbol: sym, spot: 195, expiration: '2024-07-05', candidates: [], reason: 'ok' });
      const engine = new SignalEngine(undefined, undefined, scanner);

      await runScan(engine, ['AAPL', 'MSFT']);

      expect(engine.getState().options.openOptions).toHaveLength(1);
      const last = otmView().lastScan!;
      expect(last.candidatesEvaluated).toBe(2);
      expect(last.candidatesPassed).toBe(1);
      expect(last.opensPlaced).toBe(1);
      expect(last.rejectionsByGate).toEqual({ no_candidates: 1 });
      // No `unattributed` residual ⇒ every symbol that entered is accounted for.
      expect(last.bucketsBalance).toBe(true);
      expect(last.rejectionsByGate.unattributed).toBeUndefined();
    });
  });

  it('runRelativeValueScan opens an RV position from a `cheap` candidate and records a signal', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate()],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    seedRvTrend(engine);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    const opened = state.options.openOptions[0];
    expect(opened.optionSymbol).toBe('AAPL240705C00200000');
    expect(opened.signalType).toBe('relative_value');
    expect(opened.premiumPaid).toBe(1.20);

    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].type).toBe('relative_value');
    expect(state.signals[0].symbol).toBe('AAPL');
  });

  // TRA-1231 — the iv-rv routing pass runs LAST in the demo tick and shares the
  // single `optionsDailyTradesLimit` with the RV/OTM entry scans that run first.
  // When routing is enabled the RV scan must leave `IV_RV_RESERVED_CAP_SLOTS`
  // of headroom so the iv-rv route isn't silently starved (the bug: zero
  // `iv-rv-buy-premium` rows despite live candidates). With the cap already at
  // the reservation floor, the RV scan stands down and opens nothing.
  it('runRelativeValueScan reserves cap headroom for iv-rv routing when routing is ON', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate()],
      reason: 'ok',
    });
    const engine = new SignalEngine(undefined, undefined, scanner);
    seedRvTrend(engine);
    // Cap == reserved slots ⇒ remaining (2) <= IV_RV_RESERVED_CAP_SLOTS (2) ⇒
    // the RV loop must break before entering, preserving the slots for iv-rv.
    const accts = (engine as unknown as {
      optionsAccounts: Record<string, { updateConfig: (c: { optionsDailyTradesLimit: number }) => void; optionsDailyRemaining: () => number }>;
    }).optionsAccounts;
    Object.values(accts).forEach(a => a.updateConfig({ optionsDailyTradesLimit: 2 }));

    // Routing is gated on BOTH flags (scanner ∧ routing), see isOptionIvRvRoutingEnabled.
    process.env[OPTION_IV_RV_SCANNER_FLAG] = '1';
    process.env[OPTION_IV_RV_ROUTING_FLAG] = '1';
    try {
      await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    } finally {
      delete process.env[OPTION_IV_RV_SCANNER_FLAG];
      delete process.env[OPTION_IV_RV_ROUTING_FLAG];
    }
    // Stood down — no RV entry consumed the reserved headroom.
    expect(engine.getState().options.openOptions).toHaveLength(0);
    Object.values(accts).forEach(a => expect(a.optionsDailyRemaining()).toBe(2));
  });

  // Control: with routing OFF there is no reservation, so the same near-floor cap
  // still admits an RV entry (unchanged prod/live behaviour).
  it('runRelativeValueScan does NOT reserve headroom when iv-rv routing is OFF', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate()],
      reason: 'ok',
    });
    const engine = new SignalEngine(undefined, undefined, scanner);
    seedRvTrend(engine);
    const accts = (engine as unknown as {
      optionsAccounts: Record<string, { updateConfig: (c: { optionsDailyTradesLimit: number }) => void }>;
    }).optionsAccounts;
    Object.values(accts).forEach(a => a.updateConfig({ optionsDailyTradesLimit: 2 }));

    // Routing flag left unset ⇒ the reservation guard is inert.
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().options.openOptions).toHaveLength(1);
  });

  it('also opens RV positions on below-intrinsic no-arb violations (a long-only signal)', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate({ classification: 'below_intrinsic', reason: 'mark below discounted intrinsic' })],
      reason: 'ok',
    });
    const engine = new SignalEngine(undefined, undefined, scanner);
    seedRvTrend(engine);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().options.openOptions).toHaveLength(1);
  });

  it('skips when the scanner returns no cheap or below-intrinsic candidates', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate({ classification: 'expensive', mispricingPct: 0.30, zScore: 2.6 })],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    seedRvTrend(engine); // trend present → the skip is genuinely the expensive classification, not the gate
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(engine.getState().options.openOptions).toHaveLength(0);
    expect(engine.getState().signals).toHaveLength(0);
  });

  it('refreshOptionMarks pulls live marks for open RV positions', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate({ mark: 1.20 })],
      reason: 'ok',
    });
    scanner.getOptionMark.mockResolvedValue(0.85);

    const engine = new SignalEngine(undefined, undefined, scanner);
    seedRvTrend(engine);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().options.openOptions).toHaveLength(1);

    const marks = await (engine as unknown as { refreshOptionMarks: () => Promise<Map<string, number>> }).refreshOptionMarks();
    expect(marks.get('AAPL240705C00200000')).toBe(0.85);
    expect(scanner.getOptionMark).toHaveBeenCalledWith('AAPL', '2024-07-05', 'AAPL240705C00200000');
  });

  // TRA-2945 — the TRA-2927 observer's per-BOOK partition against THIS pass's
  // cross-account symbol dedupe. Before the fix the assertion below read
  // `live.observed === 0` while the live book was being marked on every tick —
  // the same zero it publishes when it holds nothing at all, and the denominator
  // `boundReadiness` gates the give-back mark bound on.
  it('observes a shared contract ONCE PER BOOK, so the demo book cannot shadow the live one', async () => {
    clearMarkSanityTape();
    const scanner = new StubScanner();
    scanner.getOptionMark.mockResolvedValue(0.85);
    const engine = new SignalEngine(undefined, undefined, scanner);

    // Same contract, both books — the expected shape, not a corner case: demo and
    // live run the same OTM universe through the same selector.
    const row = (mode: 'demo' | 'live', currentPremium: number) => ({
      id: `row-${mode}`,
      symbol: 'SPY',
      optionSymbol: 'SPY260807C00650000',
      expiration: '2026-08-07',
      signalType: 'otm_mispricing',
      mode,
      currentPremium,
      premiumPaid: 0.3,
      contracts: 1,
      contractsRemaining: 1,
    });
    const book = (positions: ReturnType<typeof row>[]) => ({
      getState: () => ({ openOptions: positions }),
      refreshLiveDisplayMarks: vi.fn(),
      refreshOptionQuotes: vi.fn(),
      refreshOptionMarkSources: vi.fn(), // TRA-4055 — fanned on the same loop
    });
    (engine as unknown as { optionsAccounts: unknown }).optionsAccounts = {
      sandbox: book([row('demo', 0.5)]),
      production: book([row('live', 0.5)]),
    };

    await (engine as unknown as { refreshOptionMarks: () => Promise<Map<string, number>> }).refreshOptionMarks();

    // The FETCH dedupe is untouched — still one chain read for the shared contract…
    expect(scanner.getOptionMark).toHaveBeenCalledTimes(1);
    // …and yet BOTH books are credited, each against its own prior mark.
    const s = summarizeMarkSanity();
    expect(s.byMode.demo.observed).toBe(1);
    expect(s.byMode.live.observed).toBe(1);
    clearMarkSanityTape();
  });

  // ── TRA-2927 (A) — the ENFORCEMENT controls, driven through the LIVE CALL SITE ──
  //
  // Deliberately NOT `classifyMarkJump` in isolation. A control that grades a local
  // copy against a literal agrees with itself; the question here is whether the
  // 25x bound is WIRED into the seam that feeds `opt.currentPremium`, and the only
  // thing that answers it is running `refreshOptionMarks` and reading the map it
  // returns. Both consumers (`checkExits`, `refreshImportedMarks`) read that map,
  // so a mark absent from it cannot reach either book's positions — which is the
  // whole mechanism.
  describe('the 25x mark-jump bound', () => {
    const rowFor = (mode: 'demo' | 'live', currentPremium: number) => ({
      id: `row-${mode}`,
      symbol: 'SPY',
      optionSymbol: 'SPY260807C00650000',
      expiration: '2026-08-07',
      signalType: 'otm_mispricing',
      mode,
      currentPremium,
      premiumPaid: 0.3,
      contracts: 4,
      contractsRemaining: 4,
    });
    const engineWith = (mark: number, rows: ReturnType<typeof rowFor>[]) => {
      const scanner = new StubScanner();
      scanner.getOptionMark.mockResolvedValue(mark);
      const engine = new SignalEngine(undefined, undefined, scanner);
      const book = (positions: ReturnType<typeof rowFor>[]) => ({
        getState: () => ({ openOptions: positions }),
        refreshLiveDisplayMarks: vi.fn(),
        refreshOptionQuotes: vi.fn(),
        refreshOptionMarkSources: vi.fn(), // TRA-4055 — fanned on the same loop
      });
      (engine as unknown as { optionsAccounts: unknown }).optionsAccounts = {
        sandbox: book(rows.filter((r) => r.mode === 'demo')),
        production: book(rows.filter((r) => r.mode === 'live')),
      };
      return engine;
    };
    const refresh = (engine: SignalEngine) =>
      (engine as unknown as { refreshOptionMarks: () => Promise<Map<string, number>> }).refreshOptionMarks();

    beforeEach(() => clearMarkSanityTape());
    afterEach(() => clearMarkSanityTape());

    // POSITIVE CONTROL. 30 / 0.3 = 100x — the shape of the 2026-08-03 phantom.
    it('withholds a 100x mark from the map, on both books, and counts it', async () => {
      const rows = [rowFor('demo', 0.3), rowFor('live', 0.3)];
      const marks = await refresh(engineWith(30, rows));

      // (a) the mark never reaches the map, so it cannot reach `currentPremium`,
      //     `computeBookMark`, or the monotonic `peakOpenGain`…
      expect(marks.has('SPY260807C00650000')).toBe(false);
      // …and the rows are left on their PRIOR mark, not on 30.
      expect(rows.map((r) => r.currentPremium)).toEqual([0.3, 0.3]);

      const s = summarizeMarkSanity();
      // (b) the suppression is COUNTED, on the right books — without this a
      //     withheld mark is invisible in every downstream number and "never fired"
      //     reads exactly like "not wired".
      expect(s.byMode.demo.rejected).toBe(1);
      expect(s.byMode.live.rejected).toBe(1);
      // (c) …and it is STILL OBSERVED, so enforcement does not censor the tape the
      //     bound was derived from.
      expect(s.byMode.demo.observed).toBe(1);
      expect(s.byMode.live.observed).toBe(1);
      expect(s.byMode.live.maxJumpX).toBe(100);
      // (d) the headline says so.
      expect(s.note).toMatch(/^REJECTED/);
    });

    // NEGATIVE CONTROL, at 24.9x — an order of magnitude past the largest ratio in
    // the 418,384-mark tape (1.7593x) and still ACCEPTED. If this ever fails,
    // someone tightened the bound, which is the direction that disarms the
    // give-back cap.
    it('accepts a 24.9x mark — the bound is loose on purpose', async () => {
      const rows = [rowFor('live', 0.3)];
      const marks = await refresh(engineWith(0.3 * 24.9, rows));

      expect(marks.get('SPY260807C00650000')).toBeCloseTo(7.47, 10);
      const s = summarizeMarkSanity();
      expect(s.byMode.live.rejected).toBe(0);
      expect(s.byMode.live.observed).toBe(1);
      expect(s.byMode.live.flagged).toBe(1); // still CAPTURED for the histogram
      expect(s.note).toMatch(/^FLAGGED/);
    });

    // The map is keyed by OCC symbol and shared, so a rejection is symbol-wide. The
    // book that did not itself see an out-of-bound ratio still LOSES the mark, and
    // that has to land in its own counter rather than be folded into `rejected`
    // (which would claim it saw a bad mark) or dropped (which would hide the
    // suppression from the book it hit).
    it('counts the peer book’s loss of the mark apart from its own rejection', async () => {
      // demo prior 0.3 → 100x (rejects); live prior 20 → 1.5x (inside the bound).
      const rows = [rowFor('demo', 0.3), rowFor('live', 20)];
      const marks = await refresh(engineWith(30, rows));

      expect(marks.has('SPY260807C00650000')).toBe(false);
      const s = summarizeMarkSanity();
      expect(s.byMode.demo.rejected).toBe(1);
      expect(s.byMode.demo.suppressedByPeer).toBe(0);
      expect(s.byMode.live.rejected).toBe(0);
      expect(s.byMode.live.suppressedByPeer).toBe(1);
    });
  });

  it('dedups subsequent scans on the same OCC within the 1h dedup window', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate()],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    seedRvTrend(engine);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().signals).toHaveLength(1);

    vi.setSystemTime(TRADING_TIME + 10 * 60_000);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    expect(engine.getState().signals).toHaveLength(1);
    expect(engine.getState().options.openOptions).toHaveLength(1);
  });

  // TRA-968 — the single-leg long is gated on the daily-trend confluence. With
  // no cached trend series the scanner must stand down rather than open a
  // trend-blind long (the QuantTrader finding on TRA-953).
  it('stands down (no open) when there is no daily-trend confluence (TRA-968)', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate()],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    // Deliberately DO NOT seed shadowCandleCache → trend unknown.
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(engine.getState().options.openOptions).toHaveLength(0);
    expect(engine.getState().signals).toHaveLength(0);
  });

  // TRA-968 — in an uptrend the scanner may open calls but NOT a long put,
  // even when the put is the only (highest-scoring) cheap candidate.
  it('rejects a long put when the daily trend is up (TRA-968)', async () => {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeCandidate({
        optionSymbol: 'AAPL240705P00190000',
        optionType: 'put',
        strike: 190,
        delta: -0.6,
      })],
      reason: 'ok',
    });

    const engine = new SignalEngine(undefined, undefined, scanner);
    seedRvTrend(engine); // confluence resolves `buy` → calls only
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(engine.getState().options.openOptions).toHaveLength(0);
    expect(engine.getState().signals).toHaveLength(0);
  });
});

describe('SignalEngine — TRA-791 shadow channel state exposure', () => {
  it('getState() always carries a supertrendShadowSignals array (served by /api/state + WS state)', () => {
    // `GET /api/state` returns `ctx.engine.getState()` and the WS `state` frame
    // broadcasts the same object, so asserting on getState() covers both surfaces.
    const engine = new SignalEngine(undefined, undefined, undefined);
    const state = engine.getState();
    expect(Array.isArray(state.supertrendShadowSignals)).toBe(true);
  });

  it('getState() carries a catalystGateShadowDecisions array (TRA-1972 observe-only surface)', () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    const state = engine.getState();
    expect(Array.isArray(state.catalystGateShadowDecisions)).toBe(true);
  });
});

describe('SignalEngine — Tradier live balance surfacing (TRA-226)', () => {
  it('surfaces total_equity / total_cash from the cached Tradier balance in live mode', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    // Stub out the Tradier client and prime the cache so applySettings doesn't
    // need a real fetch. The internal field naming matches the source.
    const fakeClient = {
      getAccountBalance: vi.fn().mockResolvedValue({ totalEquity: 1234.56, totalCash: 200 }),
    } as unknown as TradierOptionsClient;
    (engine as unknown as { tradierLiveClient: TradierOptionsClient | null }).tradierLiveClient = fakeClient;
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    await (engine as unknown as { refreshTradierBalance: () => Promise<void> }).refreshTradierBalance();

    const state = engine.getState();
    expect(state.account.totalEquity).toBeCloseTo(1234.56);
    expect(state.account.availableCash).toBe(200);
    expect(state.account.openPositions).toEqual([]);
  });

  it('falls back to 0 in live mode when no Tradier balance has been fetched', () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';

    const state = engine.getState();
    expect(state.account.totalEquity).toBe(0);
    expect(state.account.availableCash).toBe(0);
  });

  it('clears the cached balance when leaving live mode', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number } | null }).liveTradierBalance = {
      totalEquity: 999,
      totalCash: 100,
    };

    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const internal = engine as unknown as { liveTradierBalance: unknown };
    expect(internal.liveTradierBalance).toBeNull();
  });
});

describe('SignalEngine — demo Account Summary breakdown (TRA-949)', () => {
  it('derives numeric stock/option value tiles in demo so the card reconciles instead of "—"', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });

    // Flat book: the three breakdown tiles are numbers (0), not undefined, so
    // the Account Summary card renders "$0.00" rather than "—" in demo/paper.
    let state = engine.getState();
    expect(state.account.stockLongValue).toBe(0);
    expect(state.account.optionLongValue).toBe(0);
    expect(state.account.optionShortValue).toBe(0);

    // Open a demo long stock position straight on the paper book.
    const acct = (engine as unknown as {
      account: { openPosition: (s: TradeSignal, p: number) => unknown };
    }).account;
    const opened = acct.openPosition(
      { id: 's1', symbol: 'AAPL', type: 'orb_breakout', side: 'buy', entryPrice: 100, stopLoss: 95, takeProfit: 110, riskRewardRatio: 2, timestamp: Date.now() },
      100,
    );
    expect(opened).not.toBeNull();

    state = engine.getState();
    // Long Stock Value now reflects the capital held in the open position…
    expect(state.account.stockLongValue!).toBeGreaterThan(0);
    // …and reconciles exactly: Long Stock Value + Cash = Total Value (demo
    // equity is cost-basis), which is the core Defect-1 acceptance.
    expect(state.account.stockLongValue! + state.account.availableCash)
      .toBeCloseTo(state.account.totalEquity, 6);
  });
});

describe('SignalEngine — mode-scoped dashboard state (TRA-231)', () => {
  it('hides demo-mode options from the live dashboard view and vice versa', () => {
    const engine = new SignalEngine(
      { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', liveTradierEnvOptions: 'sandbox' },
    );
    const accounts = (engine as unknown as {
      optionsAccounts: Record<TradierEnv, {
        getState: () => { openOptions: Array<{ mode?: string }> };
        getStateForMode: (m: 'demo' | 'live') => { openOptions: Array<{ mode?: string }>; closedOptions: Array<{ mode?: string }> };
      }>;
    }).optionsAccounts;

    // Pre-seed both demo and live opens in the SAME (sandbox) bucket — this
    // is the exact leak path TRA-231 fixes: a single env bucket holding both
    // mode's positions before the `mode` stamp existed.
    const demoOpt: { id: string; symbol: string; optionType: 'call'; contracts: number; contractsRemaining: number; premiumPaid: number; currentPremium: number; tp1Premium: number; tp1Hit: boolean; stopLossPremium: number; peakPremium: number; trailingActive: boolean; trailingStopPremium: number; underlyingEntryPrice: number; openedAt: number; signalId: string; signalType: 'relative_value'; mode: 'demo' | 'live' } = {
      id: 'demo-1', symbol: 'AAPL', optionType: 'call', contracts: 1, contractsRemaining: 1,
      premiumPaid: 1, currentPremium: 1, tp1Premium: 1.25, tp1Hit: false, stopLossPremium: 0.75,
      peakPremium: 1, trailingActive: false, trailingStopPremium: 1.2, underlyingEntryPrice: 195,
      openedAt: Date.now(), signalId: 'sig-d', signalType: 'relative_value', mode: 'demo',
    };
    const liveOpt: typeof demoOpt = { ...demoOpt, id: 'live-1', signalId: 'sig-l', mode: 'live' };
    const sandboxState = (accounts.sandbox as unknown as { openOptions: Map<string, typeof demoOpt> });
    sandboxState.openOptions.set('demo-1', demoOpt);
    sandboxState.openOptions.set('live-1', liveOpt);

    // In demo mode, only the demo-stamped option surfaces.
    const demoState = engine.getState();
    expect(demoState.options.openOptions.map(o => o.id)).toEqual(['demo-1']);

    // Flip into live; only the live-stamped option surfaces.
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    const liveState = engine.getState();
    expect(liveState.options.openOptions.map(o => o.id)).toEqual(['live-1']);
  });

  it('TRA-931: getActiveSymbols() always includes open-option underlyings so their spot is quoted', () => {
    const engine = new SignalEngine(
      { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', liveTradierEnvOptions: 'sandbox' },
    );
    // An off-watchlist underlying (SPCX) that the RV scanner opened on. Without
    // the fix it never enters the quote tape, so resolveSpot is blind and the
    // portfolio-Greeks gate reads 0 delta on a tradeable position.
    const spcxOpt = {
      id: 'rv-1', symbol: 'SPCX', optionType: 'call' as const, contracts: 1, contractsRemaining: 1,
      premiumPaid: 1.38, currentPremium: 1.38, tp1Premium: 1.7, tp1Hit: false, stopLossPremium: 1.0,
      peakPremium: 1.38, trailingActive: false, trailingStopPremium: 1.2, underlyingEntryPrice: 370,
      openedAt: Date.now(), signalId: 'sig-rv', signalType: 'relative_value' as const, mode: 'demo' as const,
    };
    const sandbox = (engine as unknown as {
      optionsAccounts: Record<TradierEnv, { openOptions: Map<string, typeof spcxOpt> }>;
    }).optionsAccounts.sandbox;
    sandbox.openOptions.set('rv-1', spcxOpt);

    const active = engine.getActiveSymbols();
    expect(active).toContain('SPCX');
    // Idempotent — the underlying appears exactly once even though it's not on
    // the base watchlist.
    expect(active.filter(s => s === 'SPCX')).toHaveLength(1);
  });

  it('TRA-2643: getQuoteFetchOrder() puts held risk FIRST and stays a permutation of the universe', () => {
    // TRA-931 got the underlying INTO the universe but appended it LAST, after
    // the entire discovery tail. The secondary fan-out truncates at ~200 of 614
    // by array position, so an off-watchlist underlying — by construction the
    // very last element — was unpriced on every degraded tick. That is TRA-931's
    // guarantee being silently undone for exactly the symbols it exists to
    // cover: the Greeks gate and the stale-mark exit backstop both read blind.
    const engine = new SignalEngine(
      { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', liveTradierEnvOptions: 'sandbox' },
    );
    const spcxOpt = {
      id: 'rv-1', symbol: 'SPCX', optionType: 'call' as const, contracts: 1, contractsRemaining: 1,
      premiumPaid: 1.38, currentPremium: 1.38, tp1Premium: 1.7, tp1Hit: false, stopLossPremium: 1.0,
      peakPremium: 1.38, trailingActive: false, trailingStopPremium: 1.2, underlyingEntryPrice: 370,
      openedAt: Date.now(), signalId: 'sig-rv', signalType: 'relative_value' as const, mode: 'demo' as const,
    };
    const priv = engine as unknown as {
      optionsAccounts: Record<TradierEnv, { openOptions: Map<string, typeof spcxOpt> }>;
      dynamicSymbols: Set<string>;
      getQuoteFetchOrder(symbols: readonly string[]): string[];
    };
    priv.optionsAccounts.sandbox.openOptions.set('rv-1', spcxOpt);
    // A discovery tail big enough that position matters — bqb1's is ~589.
    for (let i = 0; i < 600; i++) priv.dynamicSymbols.add(`TAIL${i}`);
    priv.dynamicSymbols.add('^VIX');

    const active = engine.getActiveSymbols();
    // The defect, restated: both the held underlying and the risk gate sit
    // outside the 200-symbol ceiling in the universe's natural order.
    expect(active.slice(0, 200)).not.toContain('SPCX');
    expect(active.slice(0, 200)).not.toContain('^VIX');

    const ordered = priv.getQuoteFetchOrder(active);
    expect(ordered[0]).toBe('SPCX');           // held risk first
    expect(ordered.slice(0, 200)).toContain('^VIX');

    // PERMUTATION, not a filter. If this ever reorders into a subset, symbols
    // stop being quoted with no log line at all — the silent-drop failure mode
    // TRA-2627 spent an incident diagnosing. `applyQuotes` is still fed the
    // ORIGINAL order, so the watchlist render order is untouched.
    expect(ordered).toHaveLength(active.length);
    expect([...ordered].sort()).toEqual([...active].sort());
  });

  it('scopes recentSignals to the active mode so a flip back to demo hides live signals', () => {
    const engine = new SignalEngine(
      { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' },
    );
    // Reach into the engine to seed both demo and live signals — exercising
    // the read path is sufficient; the doTick-time stamp is covered by the
    // RV scanner test below it.
    const internal = engine as unknown as { recentSignals: Array<{ id: string; mode?: 'demo' | 'live'; symbol: string; type: string; side: string; entryPrice: number; stopLoss: number; takeProfit: number; riskRewardRatio: number; timestamp: number }> };
    internal.recentSignals = [
      { id: 's-d', mode: 'demo', symbol: 'AAPL', type: 'orb', side: 'buy', entryPrice: 195, stopLoss: 190, takeProfit: 205, riskRewardRatio: 2, timestamp: Date.now() },
      { id: 's-l', mode: 'live', symbol: 'AAPL', type: 'relative_value', side: 'buy', entryPrice: 1.2, stopLoss: 0.9, takeProfit: 1.8, riskRewardRatio: 2, timestamp: Date.now() },
      { id: 's-legacy', symbol: 'AAPL', type: 'orb', side: 'buy', entryPrice: 195, stopLoss: 190, takeProfit: 205, riskRewardRatio: 2, timestamp: Date.now() },
    ];

    expect(engine.getState().signals.map(s => s.id).sort()).toEqual(['s-d', 's-legacy']);

    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    expect(engine.getState().signals.map(s => s.id)).toEqual(['s-l']);
  });
});

describe('SignalEngine — legacy options snapshot routing (TRA-237)', () => {
  it('legacy single-bucket options without a tradierEnv stamp restore into sandbox, not the engine\'s active env', () => {
    // Engine created with the user already on production env (the broken
    // pre-fix path attributed any pre-TRA-233 paper trades into the production
    // bucket, surfacing demo P&L in the Live Production header even when no
    // production order had ever been placed).
    const engine = new SignalEngine(
      { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live', liveTradierEnvOptions: 'production' },
    );
    expect((engine as unknown as { tradierEnv: TradierEnv }).tradierEnv).toBe('production');

    engine.importTradeSnapshot({
      closedPositions: [],
      recentSignals: [],
      dailySignals: [],
      positionSignalType: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0, openPositions: [] },
      // Legacy snapshot — no tradierEnv stamp, no optionsByEnv. These were the
      // sandbox-era trades from TRA-220.
      options: {
        openOptions: [],
        closedOptions: [],
        optionsPnl: 524.50,
        dailyCount: 10,
        currentDayKey: '2026-05-02',
        cash: 25_000,
        equity: 25_524.50,
      },
    });

    const accounts = (engine as unknown as { optionsAccounts: Record<TradierEnv, { getState: () => { optionsPnl: number; dailyOptionsCount: number } }> }).optionsAccounts;
    expect(accounts.sandbox.getState().optionsPnl).toBe(524.50);
    expect(accounts.sandbox.getState().dailyOptionsCount).toBe(10);
    expect(accounts.production.getState().optionsPnl).toBe(0);
    expect(accounts.production.getState().dailyOptionsCount).toBe(0);

    // The Live Production header reads the active env's bucket — it should
    // see the empty production bucket, not the legacy sandbox P&L.
    const state = engine.getState();
    expect(state.options.optionsPnl).toBe(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    expect(state.options.openOptions).toEqual([]);
  });

  it('legacy snapshot WITH a tradierEnv stamp still routes to that env', () => {
    const engine = new SignalEngine(
      { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live', liveTradierEnvOptions: 'sandbox' },
    );

    engine.importTradeSnapshot({
      closedPositions: [],
      recentSignals: [],
      dailySignals: [],
      positionSignalType: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0, openPositions: [] },
      options: {
        openOptions: [],
        closedOptions: [],
        optionsPnl: 100,
        dailyCount: 1,
        currentDayKey: '2026-05-02',
        cash: 25_000,
        equity: 25_100,
        // Stamp present — TRA-233 single-bucket persisted under the active env.
        tradierEnv: 'production',
      } as unknown as Parameters<typeof engine.importTradeSnapshot>[0]['options'],
    });

    const accounts = (engine as unknown as { optionsAccounts: Record<TradierEnv, { getState: () => { optionsPnl: number } }> }).optionsAccounts;
    expect(accounts.production.getState().optionsPnl).toBe(100);
    expect(accounts.sandbox.getState().optionsPnl).toBe(0);
  });
});

// ─── TRA-319 — live RV mirror reconciles Tradier rejections ─────────────────
// The unit tests cover voidOpenOption / waitForOrderTerminalStatus / the new
// optionBuyingPower extraction in isolation. These tests close the loop on
// the signal-engine wiring itself: when Tradier rejects the mirrored order,
// the dashboard must NOT show a phantom open and the daily slot must NOT be
// consumed. This is the integration substitute for the Tradier sandbox
// verification on a low-buying-power account.
describe('SignalEngine — TRA-319 live RV mirror reconciliation', () => {
  // TRA-1491 shipped a DARK live-capital gate that suppresses the ENTIRE live RV
  // entry (paper open included) unless ENABLE_OPTION_LIVE_RV_LONG is armed. These
  // tests exercise the ARMED path's mechanics — mirror reconciliation, sizing,
  // void-on-reject — not the arming policy, so they arm the flag. The dark default
  // gets its own coverage below ('live RV entry is suppressed while the dark flag
  // is off'), which is what actually protects real capital. (TRA-1677)
  beforeEach(() => {
    process.env[RV_ENGINE_FLAG] = '1'; // TRA-4385 — the arm now also requires a live producer
    process.env[OPTION_LIVE_RV_LONG_FLAG] = '1';
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = FAR_FUTURE_TEST_UNTIL; // TRA-1929 window open
  });
  afterEach(() => {
    delete process.env[RV_ENGINE_FLAG];
    delete process.env[OPTION_LIVE_RV_LONG_FLAG];
    delete process.env[OPTION_LIVE_TEST_UNTIL_VAR];
  });

  type WaitOpts = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
  /**
   * TRA-374 — the entry mirror now goes through `submitSmartBuyToOpen`, which
   * needs `getOptionQuote`, `buyContractsLimit`, `cancelOrder`, and
   * `waitForOrderTerminalStatus` on the client. The pre-TRA-374 tests used
   * a `buyContracts` (market) stub; the interface and call sites below are
   * updated to drive the new LIMIT walk path.
   */
  interface TradierLiveStub {
    getAccountBalance: ReturnType<typeof vi.fn>;
    getOptionQuote: ReturnType<typeof vi.fn>;
    buyContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    /** TRA-4483 — the walk re-prices over the cancel, so it needs the CONFIRMED one. */
    cancelOrderConfirmed: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
    sellContracts?: ReturnType<typeof vi.fn>;
  }

  function setupLiveEngine(stub: TradierLiveStub, scanner: StubScanner) {
    const engine = new SignalEngine(undefined, undefined, scanner);
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    seedRvTrend(engine); // TRA-968 — the RV long now needs a confirmed daily uptrend to fire
    return engine;
  }

  // TRA-3872 — mark 0.90 (was 1.20): one contract is $90 of premium, inside the
  // TRA-3836 canary ceiling every live open is now graded against ($100 at the
  // time of the fix; TRA-3870 re-ratified $300/order, which $90 also clears).
  // These tests exercise MIRROR mechanics, not the ceiling, so their subject
  // order must be one production could actually place at ANY ratified posture.
  function freshScanner(mark = 0.90): StubScanner {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate({ mark })],
      reason: 'ok',
    });
    return scanner;
  }

  /**
   * TRA-374 — quote that yields mid 0.90 (matches the scanner's mark) so the
   * smart-open walk submits at mid + 1¢ on the first attempt and a stub fill
   * at 0.91 reflects what the broker would have given us.
   */
  function tightQuote() {
    return { symbol: 'AAPL240705C00200000', bid: 0.85, ask: 0.95 };
  }

  it('voids the paper open, surfaces a skip-reason signal, and frees the slot when Tradier ends in canceled', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 1000, totalCash: 300, optionBuyingPower: 25_000,
      }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 7, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 7, status: 'canceled', reason_description: 'insufficient buying power',
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // Prime a balance so live-mode sizing has equity to work with. OBP is
    // comfortably above the order so the pre-checks pass and the test exercises
    // the post-submit reconciliation path — but NOT the old 999_999: sizing
    // keys off OBP (cash-account semantics), and that figure sized a 55-contract
    // ($4,950) ticket the TRA-3836 canary ceiling refuses before the broker
    // (TRA-3872). $25K sizes to the $150 ticket floor → 1 contract, $90.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 1000, totalCash: 300, optionBuyingPower: 25_000,
    };
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // The mirror DID submit a LIMIT (we only know it's bad after Tradier reconciles).
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(stub.waitForOrderTerminalStatus).toHaveBeenCalledTimes(1);

    const state = engine.getState();
    // No phantom row in the live-mode dashboard.
    expect(state.options.openOptions).toHaveLength(0);
    // Slot was reverted (this is the user-visible bug — losing daily slots
    // to trades the broker never accepted).
    expect(state.options.dailyOptionsCount).toBe(0);
    // No closed-options leak — voidOpenOption is NOT closeOption.
    expect(state.options.closedOptions).toHaveLength(0);
    expect(state.options.optionsPnl).toBe(0);
    // TRA-332 — the Signals panel now surfaces the rejected signal with a
    // liveSkipReason so the user can see the diagnosis instead of mining logs.
    expect(state.signals).toHaveLength(1);
    // TRA-374 — smart-open prefixes the reason with the order id and the
    // Tradier reason_description. The exact prefix is "Tradier order N rejected:".
    expect(state.signals[0].liveSkipReason).toMatch(/rejected/);
    expect(state.signals[0].liveSkipReason).toContain('insufficient buying power');
  });

  // TRA-3486 — the same caller-visible outcome, for the one abort branch that
  // did NOT produce it. `mirrorLiveOptionOpen` used to `return true` on a null
  // `tradierLiveClient`, and `true` is this caller's "mirrored" verdict: the scan
  // ran straight past `if (!mirrored) continue;` into `emitOptionFillAlert` and
  // stamped `signal.mode = 'live'`, so the dashboard showed a FILL and a live
  // open position for an order that never reached a broker. Nothing voided it,
  // so TRA-3472's journal retraction never fired either.
  //
  // A null client under `mode === 'live'` is not hypothetical — it is the
  // TRA-2693 bistable window (a mid-pass `mode` flip), the same window the EXIT
  // side needed `reapAbandonedStagedExits` for. The seam-level coverage lives in
  // `tra3486-unbacked-live-open.test.ts`; this pins the consequence at the
  // caller, which is where the phantom fill was actually user-visible.
  it('voids and surfaces a skip instead of a PHANTOM FILL when the live broker client is null (TRA-3486)', async () => {
    const scanner = freshScanner();
    const engine = new SignalEngine(undefined, undefined, scanner);
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    // THE window: live mode, options routed, arm flag on — and no client.
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = null;
    seedRvTrend(engine);
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 1000, totalCash: 300, optionBuyingPower: 999_999,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    const state = engine.getState();
    // No unbacked live position, and no slot burned on an order nobody placed.
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    expect(state.options.closedOptions).toHaveLength(0);
    // The signal is surfaced as SUPPRESSED, not as an entry. Pre-fix this row
    // existed too — but with `liveSkipReason` undefined, because it was pushed
    // by the FILL path, not by `surfaceLiveSkip`. That field is the whole
    // difference between "we told the user why nothing opened" and "we told the
    // user something opened".
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toBeDefined();
    expect(state.signals[0].liveSkipReason).toContain('no live Tradier options client');
  });

  // TRA-1677 — the tests in this block arm ENABLE_OPTION_LIVE_RV_LONG to reach the
  // mirror mechanics. That arming is exactly what must NOT be true by default, so
  // pin the dark default here: with the flag off, a live RV scan places NO broker
  // order and opens NOTHING (not even on the paper book, which would render a
  // phantom live fill with no broker behind it). This is the guard that keeps real
  // capital untouched until the board arms the sleeve — without it, the beforeEach
  // above would silently be the only statement this suite makes about the flag.
  it('live RV entry is suppressed entirely while the dark flag is off (TRA-1491)', async () => {
    delete process.env[OPTION_LIVE_RV_LONG_FLAG];
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({ totalEquity: 100_000, totalCash: 100_000, optionBuyingPower: 100_000 }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 9, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 9, status: 'filled' })),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    (engine as unknown as { liveTradierBalance: unknown }).liveTradierBalance = {
      totalEquity: 100_000, totalCash: 100_000, optionBuyingPower: 100_000,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // No broker order, and no paper position standing in for one.
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
  });

  // TRA-1677 — regression on an ALGEBRAICALLY dead gate. The armed live RV path
  // runs the TRA-1293 entry-greeks gate, which was handed `ENTRY_SHORT_DELTA_*`
  // ([0.30,0.40] — a SHORT-strike PoP band). `selectRvLongCandidate` can only ever
  // hand it |delta| >= RV_LONG_DELTA_FLOOR (0.45). Empty intersection ⇒ the gate
  // rejected 100% of RV longs, so the sleeve was a silent no-op wherever it was
  // armed and read as "no candidates" rather than "impossible gate". A 0.60-delta
  // candidate — dead centre of the selector's own 0.55–0.65 target — must open.
  it('armed live RV long admits the selector-targeted 0.60 delta (delta band is the RV long own, not the short-premium band)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({ totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000 }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 11, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 11, status: 'filled' })),
    };
    // 0.60 delta is the makeCandidate default and sits inside the selector's
    // 0.55–0.65 target band — the gate must not treat it as out-of-band.
    // TRA-3872 — $25K equity (was $100K): sizing at $100K wants 5 contracts
    // ($450), which the TRA-3836 canary ceiling refuses before the broker; this
    // test's subject is the DELTA BAND, so size to the 1 contract ($90) that
    // can actually reach the seam.
    const engine = setupLiveEngine(stub, freshScanner());
    (engine as unknown as { liveTradierBalance: unknown }).liveTradierBalance = {
      totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(engine.getState().options.openOptions).toHaveLength(1);
  });

  // TRA-483 — when Tradier's day-trade buying power (PDT limit) hits $0 the
  // broker rejects every same-day option round trip even though
  // `optionBuyingPower` may still be positive. The signal-time pre-check now
  // surfaces a skip signal up-front instead of submitting orders Tradier
  // will silently cancel for "insufficient day-trade buying power". The
  // dashboard then shows the DTBP-exhausted skip reason next to the failed
  // signal so the user can diagnose without mining logs (the issue's
  // screenshot showed positive Option BP but DTBP $0 and no trades opening).
  it('skips the order at the signal pre-check when dayTradeBuyingPower is below notional cost (TRA-483)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // Option BP large enough to clear the per-position cap, but DTBP=$0 —
    // the exact PDT-limit-reached failure mode from the issue's screenshot.
    (engine as unknown as {
      liveTradierBalance: {
        totalEquity: number;
        totalCash: number;
        optionBuyingPower: number;
        dayTradeBuyingPower: number;
      } | null;
    }).liveTradierBalance = {
      totalEquity: 25_000,
      totalCash: 25_000,
      optionBuyingPower: 25_000,
      dayTradeBuyingPower: 0,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // Broker never called — DTBP gate trips at the signal pre-check.
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].mode).toBe('live');
    expect(state.signals[0].liveSkipReason).toContain('day-trade buying power');
    expect(state.signals[0].liveSkipReason).toContain('DTBP exhausted');
  });

  it('stays permissive when dayTradeBuyingPower is null (cash accounts have no DTBP) (TRA-483)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
      }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 21, status: 'ok' }),
      cancelOrder: vi.fn(),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 21, status: 'filled', exec_quantity: 1, avg_fill_price: 0.91,
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // DTBP = null (cash accounts don't carry it). The gate must skip its
    // check rather than treating "no value" as "zero".
    (engine as unknown as {
      liveTradierBalance: {
        totalEquity: number;
        totalCash: number;
        optionBuyingPower: number;
        dayTradeBuyingPower: number | null;
      } | null;
    }).liveTradierBalance = {
      totalEquity: 25_000,
      totalCash: 25_000,
      optionBuyingPower: 25_000,
      dayTradeBuyingPower: null,
    };
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // The order DID submit — cash accounts have no DTBP and the gate is
    // skipped entirely. This locks in the cash-account regression boundary.
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
  });

  it('surfaces dayTradeBuyingPower on liveAccount when Tradier reports it (TRA-483)', () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    (engine as unknown as {
      liveTradierBalance: TradierAccountBalance | null;
    }).liveTradierBalance = {
      totalEquity: 25_000,
      totalCash: 25_000,
      optionBuyingPower: 25_000,
      stockBuyingPower: 25_000,
      longMarketValue: 0,
      dayTradeBuyingPower: 7500,
    };
    const state = engine.getState();
    expect(state.account.dayTradeBuyingPower).toBe(7500);
  });

  it('omits dayTradeBuyingPower on liveAccount for cash accounts (no DTBP bucket) (TRA-483)', () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    (engine as unknown as {
      liveTradierBalance: TradierAccountBalance | null;
    }).liveTradierBalance = {
      totalEquity: 500,
      totalCash: 480,
      optionBuyingPower: 480,
      stockBuyingPower: 480,
      longMarketValue: 0,
      dayTradeBuyingPower: null,
    };
    const state = engine.getState();
    expect(state.account.dayTradeBuyingPower).toBeUndefined();
  });

  it('skips the order entirely when cached optionBuyingPower is below notional cost (TRA-332 surfaces it on the dashboard)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(),
    };
    // TRA-497 — bump mark above the new $150 per-position cap floor so the
    // small-OBP skip still fires. Pre-TRA-497 a $1.20 mark ($120 cost) was
    // enough; the $150 cap floor now lets that through.
    const engine = setupLiveEngine(stub, freshScanner(1.60));
    // TRA-332 / TRA-378 / TRA-497: with a $50 OBP, a single $1.60-mark
    // contract ($160) blows past the 15% per-position cap (max($150, $7.50)
    // = $150), so even the forced 1-contract floor can't open it — the
    // engine's pre-check trips before any broker call and surfaces a
    // skip-reason signal.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 100, totalCash: 50, optionBuyingPower: 50,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // Pre-check fired — we never bothered the broker.
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    // TRA-332 — surfaces the skip on the dashboard so the user sees the diagnosis.
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].mode).toBe('live');
    expect(state.signals[0].liveSkipReason).toContain('per-position cap');
  });

  it('voids the paper open and surfaces a skip signal when the buyContractsLimit call itself throws (network/auth failure)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockRejectedValue(new Error('Tradier 401 unauthorized')),
      cancelOrder: vi.fn(),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // Prime a balance with enough OBP to clear the pre-checks so this test
    // exercises the catch-block void path.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    // TRA-332 — surface the broker-throw reason on the dashboard.
    expect(state.signals).toHaveLength(1);
    // TRA-374 — when buyContractsLimit throws, smart-open returns a `rejected`
    // outcome whose reason carries the thrown message; the engine surfaces it
    // through the "Tradier order ... rejected" path.
    expect(state.signals[0].liveSkipReason).toMatch(/rejected|threw/);
    // We never reached the polling step.
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();
  });

  it('keeps the paper open and records the signal on the happy path (Tradier filled)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
      }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 11, status: 'ok' }),
      cancelOrder: vi.fn(),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 11, status: 'filled', exec_quantity: 1, avg_fill_price: 0.91,
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // TRA-3872 — cache the balance like every other armed test here: without it
    // sizing falls back to PAPER equity (25K × 2% demo risk = $250 → 2
    // contracts, $180), which the TRA-3836 canary ceiling refuses at the seam.
    // Live sizing off $25K is the $150 ticket floor → 1 contract, $90.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
    };
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(stub.waitForOrderTerminalStatus).toHaveBeenCalledTimes(1);

    const state = engine.getState();
    // No-regression check on the happy path: the position survives, the
    // daily slot is consumed, and the Signals panel surfaces the entry.
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].optionSymbol).toBe('AAPL240705C00200000');
    expect(state.options.dailyOptionsCount).toBe(1);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].type).toBe('relative_value');
  });

  it('voids the paper open when the smart-open walk exhausts all 5 attempts without a fill (TRA-374)', async () => {
    // TRA-374 — pre-374 behaviour kept the position open on a non-terminal
    // wait, trusting the periodic balance poll to catch drift. The new
    // smart-open helper instead walks the LIMIT from mid+1¢ → ask in 0.25
    // steps and voids the paper open after 5 attempts, surfacing a clear
    // "walk to ask exhausted" reason. This test locks in that new
    // behaviour — a phantom long position that never actually filled at
    // any walk step is worse than a missed entry.
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
      }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 13, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      // Always pending → walk exhausts the full schedule.
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 13, status: 'pending',
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner());
    // Prime balance so the new TRA-332 pre-checks pass.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
    };
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    const state = engine.getState();
    // TRA-374 — walk_exhausted voids the paper open: no phantom position,
    // slot freed, walk-to-ask-exhausted surfaced as the skip reason.
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toContain('walk to ask exhausted');
    // The walk submitted 5 LIMITs and cancelled each in turn.
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(5);
    expect(stub.cancelOrderConfirmed).toHaveBeenCalledTimes(5);
  });

  // ─── TRA-4483 — the mirror must NOT void when contracts may be live ──────
  //
  // The test directly above is the CONTRAST that makes these two mean
  // something: identical setup, identical scan, and the ONLY thing that moves
  // is what the confirmed cancel reports. `walk_exhausted` (nothing executed)
  // voids and frees the slot; a measured partial and an unreadable cancel keep
  // the row, because voiding it is what leaves contracts live at the broker
  // with no paper row for any close path to key on (TRA-4476).

  function primedLiveEngine(stub: TradierLiveStub, mark?: number) {
    const engine = setupLiveEngine(stub, mark === undefined ? freshScanner() : freshScanner(mark));
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
    };
    return engine;
  }

  it('KEEPS the paper open when the walk ends on a measured partial fill (TRA-4483)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
      }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 13, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      // The first step executed a contract before the cancel landed; the rest
      // are clean, so the ladder runs out holding a real position.
      cancelOrderConfirmed: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'canceled',
          terminalStatus: 'canceled',
          ackStatus: 200,
          ackError: null,
          detail: { id: 13, status: 'canceled', exec_quantity: 1, avg_fill_price: 1.2 },
          filledQty: 1,
        })
        .mockImplementation(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 13, status: 'pending',
      })),
    };
    const engine = primedLiveEngine(stub, 0.05);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    const state = engine.getState();
    // ⭐ 1 contract is LIVE at the broker. Under the pre-TRA-4483 walk this
    // returned `walk_exhausted` and the row above was deleted on top of it.
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.dailyOptionsCount).toBe(1);
    expect(state.signals[0].liveSkipReason).toBeUndefined();
    // ⭐ AC1 END TO END, through the real mirror rather than the helper's own
    // fixtures: the sleeve asked for 30, one executed before the first cancel
    // landed, and every replacement asked for 29. Before TRA-4483 all five
    // submits read 30 — an aggregate of 150 against a request of 30.
    const submitted = (stub.buyContractsLimit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(submitted).toEqual([30, 29, 29, 29, 29]);
  });

  it('KEEPS the paper open when the cancel could not be confirmed, and submits only once (TRA-4483)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({
        totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000,
      }),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 13, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      cancelOrderConfirmed: vi.fn().mockResolvedValue({
        kind: 'unknown',
        reason: 'still_working',
        ackStatus: 200,
        ackError: null,
        detail: null,
        filledQty: null,
      }),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 13, status: 'pending',
      })),
    };
    const engine = primedLiveEngine(stub);
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    const state = engine.getState();
    // The order may still be working AND may still fill, so the row stays and
    // the exposure is left for the broker-position drift detector to name.
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toBeUndefined();
    // ⭐ ONE submit. The old walk re-priced over the unconfirmed cancel four
    // more times, so up to five orders could have been working at once.
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
  });
});

// ─── TRA-332 — live sizing reads the user's REAL Tradier equity ────────────
// Bug: PaperOptionsAccount is seeded from demo equity ($25 K default) and
// never rebased on a live flip. Sizing produced contracts a $300 cash account
// could never afford, TRA-319's pre-check voided every signal, and the user
// saw nothing on the dashboard. These tests lock in the fix:
//   • position size in live mode comes from `liveTradierBalance.optionBuyingPower`
//     / `totalEquity`, not the stale paper equity
//   • when even one contract won't fit, surface a clear `liveSkipReason` on
//     the dashboard so the user can self-diagnose
describe('SignalEngine — TRA-332 live sizing uses real Tradier equity', () => {
  // TRA-1677 — armed-path mechanics; see the TRA-319 block for why.
  beforeEach(() => {
    process.env[RV_ENGINE_FLAG] = '1'; // TRA-4385 — the arm now also requires a live producer
    process.env[OPTION_LIVE_RV_LONG_FLAG] = '1';
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = FAR_FUTURE_TEST_UNTIL; // TRA-1929 window open
  });
  afterEach(() => {
    delete process.env[RV_ENGINE_FLAG];
    delete process.env[OPTION_LIVE_RV_LONG_FLAG];
    delete process.env[OPTION_LIVE_TEST_UNTIL_VAR];
  });

  type WaitOpts = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
  /**
   * TRA-374 — see the TRA-319 describe block above for the same stub-surface
   * update rationale (smart-open replaces market `buyContracts`).
   */
  interface TradierLiveStub {
    getAccountBalance: ReturnType<typeof vi.fn>;
    getOptionQuote: ReturnType<typeof vi.fn>;
    buyContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    /** TRA-4483 — the walk re-prices over the cancel, so it needs the CONFIRMED one. */
    cancelOrderConfirmed: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }

  function tightQuote(symbol = 'AAPL240705C00200000') {
    return { symbol, bid: 1.15, ask: 1.25 };
  }

  function setupLiveEngine(stub: TradierLiveStub, scanner: StubScanner) {
    const engine = new SignalEngine(undefined, undefined, scanner);
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    seedRvTrend(engine); // TRA-968 — the RV long now needs a confirmed daily uptrend to fire
    return engine;
  }

  function freshScanner(mark = 1.20): StubScanner {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate({ mark })],
      reason: 'ok',
    });
    return scanner;
  }

  it('surfaces a budget-too-small skip signal for a $300 cash account (TRA-332, recalibrated for TRA-497 $150 cap)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(),
    };
    // TRA-497 — the per-position cap floor moved from $100 to $150 on
    // 2026-05-28. To still verify the skip reason on a $300 cash account
    // (the original TRA-332 report), use a $1.60-mark candidate whose $160
    // cost still exceeds the new $150 cap. Pre-TRA-497 this was $1.20 / $120
    // against the $100 cap.
    const engine = setupLiveEngine(stub, freshScanner(1.60));
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 300, totalCash: 300, optionBuyingPower: 300,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    // The dashboard now shows the user WHY their account isn't trading.
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].mode).toBe('live');
    expect(state.signals[0].liveSkipReason).toContain('per-position cap');
    expect(state.signals[0].liveSkipReason).toContain('$160.00');
    expect(state.signals[0].liveSkipReason).toContain('equity $300.00');
  });

  it('opens a 1-contract position for a small ($1k) live account (TRA-378 / TRA-497)', async () => {
    // Mark = $1 → 1 contract = $100 notional. Live equity = $1,000:
    // pctBudget = $1k * 0.5 * 0.01 = $5 (rounds well below one contract),
    // but the $150 ticket floor (TRA-497) lifts the budget so floor($150/$100)
    // = 1 contract clears the $150 per-position cap. Pre-TRA-378 this
    // account silently skipped the signal.
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 31, status: 'ok' }),
      cancelOrder: vi.fn(),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 31, status: 'filled', avg_fill_price: 1.01,
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner(1.0));
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 1000, totalCash: 1000, optionBuyingPower: 1000,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // The floor opened exactly one contract and mirrored it to the broker —
    // sized off the LIVE $1k equity, not the stale paper equity.
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].contracts).toBe(1);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toBeUndefined();
  });

  it('opens a sized position when live equity is sufficient (regression check on the override path)', async () => {
    // TRA-3872/TRA-3870 — this $200 (2-contract) order was refused while the
    // TRA-3836 ceiling stood at $100/order; the board's TRA-3870 re-ratification
    // ($300/order) makes it placeable in production again, so the original
    // property — the mirror submits the SIZED count off REAL Tradier equity —
    // is back. Ceiling-refusal coverage at this seam lives in the TRA-3216
    // "composes with the canary ceiling" block and canary-ceiling.test.ts.
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn().mockResolvedValue(tightQuote()),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 21, status: 'ok' }),
      cancelOrder: vi.fn(),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _opts?: WaitOpts) => ({
        id: 21, status: 'filled', avg_fill_price: 1.01,
      })),
    };
    const engine = setupLiveEngine(stub, freshScanner(1.0));
    // $50 K live equity → TRA-378 live budget = min(50_000 * 0.5 * 0.01,
    // 50_000 * 0.15) = $250 → 2 contracts at $100 each (riskPerTrade defaults
    // to 0.01 when the engine is built without settings).
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 50_000, totalCash: 50_000, optionBuyingPower: 50_000,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].contracts).toBe(2);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toBeUndefined();
  });

  it('falls back to paper equity when tradierLiveOptionsEnabled is false (TRA-357 defense-in-depth gate)', async () => {
    // Equity-only mode (liveTradierMarkets: 'equity'). The scan-level skip at
    // line ~887 normally prevents the RV path from running; this test pokes
    // `runRelativeValueScan` directly to lock in that the sizing path also
    // ignores the live balance when options routing is disabled. Without the
    // gate the engine would surface a budget-too-small skip for a $300
    // balance even though the user opted out of options routing entirely.
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEngine(stub, freshScanner(1.0));
    (engine as unknown as { tradierLiveOptionsEnabled: boolean }).tradierLiveOptionsEnabled = false;
    // Tiny live balance that WOULD trip the live-budget skip if honored.
    // With the gate, sizing falls back to the $25 K paper equity instead.
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 300, totalCash: 300, optionBuyingPower: 300,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // Paper equity sizing produces contracts (25000 * 0.5 * 0.02 = $250 budget
    // → 2 contracts at $100 each). No live-budget skip surfaces. The buy
    // mirror is also gated on `tradierLiveOptionsEnabled` (TRA-355) so the
    // broker call never fires.
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].contracts).toBe(2);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toBeUndefined();
  });

  it('falls back to optionBuyingPower over totalEquity when both are present (cash account semantics)', async () => {
    const stub: TradierLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
      cancelOrderConfirmed: vi.fn(async (id: string | number) => stubConfirmedCancel(id)),
      waitForOrderTerminalStatus: vi.fn(),
    };
    // TRA-495 / TRA-497 — the $150 ticket floor would normally let a
    // $1.0-mark contract through on a $200 OBP book ($100 cost ≤ $150 cap).
    // To still verify the engine picks OBP over totalEquity, use a
    // $1.60-mark candidate whose $160 cost blows past the $200-OBP cap
    // ($150) — but would have fit under the $50K-totalEquity cap ($7.5K).
    // The skip surfaces because the engine sized off the tighter OBP figure.
    const engine = setupLiveEngine(stub, freshScanner(1.60));
    (engine as unknown as { liveTradierBalance: { totalEquity: number; totalCash: number; optionBuyingPower: number } | null }).liveTradierBalance = {
      totalEquity: 50_000, totalCash: 50_000, optionBuyingPower: 200,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // $160 cost > $150 cap (max($150, $30)) under OBP sizing → skip. If the
    // engine had used totalEquity ($50K, cap $7,500) the contract would have
    // sized fine — proves OBP took precedence.
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0].liveSkipReason).toContain('equity $200.00');
    expect(state.signals[0].liveSkipReason).toContain('per-position cap');
  });
});

// TRA-336 / TRA-370 — `liveTradierMarkets` is the user-facing tri-state for
// "what should Tradier Live trade" (Options / Positions / Both). TRA-370
// flipped the absent-field default from 'options' to 'both' so a Live account
// mirrors Demo's signal flow (equity + options) out of the box. Users can
// still pick 'options' or 'equity' explicitly in Settings to narrow routing.
describe('shared/AccountSettings — TRA-336 liveTradierMarkets resolvers', () => {
  function withMarkets(markets: AccountSettings['liveTradierMarkets']): AccountSettings {
    return { ...DEFAULT_ACCOUNT_SETTINGS, liveTradierMarkets: markets };
  }

  it("defaults to 'both' (TRA-370) so absent saved settings mirror Demo's signal flow", () => {
    const s: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS };
    delete s.liveTradierMarkets;
    expect(resolveLiveTradierMarkets(s)).toBe('both');
    expect(isLiveTradierOptionsEnabled(s)).toBe(true);
    expect(isLiveTradierEquityEnabled(s)).toBe(true);
  });

  it("'options' enables only the options mirror", () => {
    const s = withMarkets('options');
    expect(isLiveTradierOptionsEnabled(s)).toBe(true);
    expect(isLiveTradierEquityEnabled(s)).toBe(false);
  });

  it("'equity' enables only the equity path (suppresses options mirror)", () => {
    const s = withMarkets('equity');
    expect(isLiveTradierOptionsEnabled(s)).toBe(false);
    expect(isLiveTradierEquityEnabled(s)).toBe(true);
  });

  it("'both' enables options mirror AND equity path", () => {
    const s = withMarkets('both');
    expect(isLiveTradierOptionsEnabled(s)).toBe(true);
    expect(isLiveTradierEquityEnabled(s)).toBe(true);
  });
});

// TRA-370 — Demo and Live (production) should fire the same signals and trade
// both equity positions AND options out of the box. The defaults + resolver
// fallbacks below are the wire-level contract that makes that true; pin them
// so a future change to TRA-336 routing doesn't silently regress a Live
// account back to options-only or equity-only behaviour.
describe('shared/AccountSettings — TRA-370 Live/Demo parity defaults', () => {
  it("DEFAULT_ACCOUNT_SETTINGS routes Live to BOTH equity + options", () => {
    expect(DEFAULT_ACCOUNT_SETTINGS.liveTradierMarkets).toBe('both');
    expect(DEFAULT_ACCOUNT_SETTINGS.liveTradeEquitiesTradier).toBe(true);
  });

  it("absent liveTradierMarkets resolves to 'both' so Live mirrors Demo's signal flow", () => {
    const s: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS };
    delete s.liveTradierMarkets;
    expect(resolveLiveTradierMarkets(s)).toBe('both');
    expect(isLiveTradierOptionsEnabled(s)).toBe(true);
    expect(isLiveTradierEquityEnabled(s)).toBe(true);
  });

  it("absent liveTradeEquitiesTradier resolves to true so Live opens equity brackets out of the box", () => {
    const s: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS };
    delete s.liveTradeEquitiesTradier;
    expect(resolveLiveTradeEquitiesTradier(s)).toBe(true);
  });

  it("explicit liveTradeEquitiesTradier === false still opts out (user-facing override survives)", () => {
    const s: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS, liveTradeEquitiesTradier: false };
    expect(resolveLiveTradeEquitiesTradier(s)).toBe(false);
  });
});

describe('SignalEngine — TRA-336 markets-selector gate', () => {
  // The flag the doTick gate consults. Confirms the engine reflects the
  // user's selection at construction and after applySettings — flipping
  // the tri-state must take effect on the next tick without a restart.
  it("constructs with tradierLiveOptionsEnabled === true under the default ('both', TRA-370)", () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' });
    expect(
      (engine as unknown as { tradierLiveOptionsEnabled: boolean }).tradierLiveOptionsEnabled,
    ).toBe(true);
  });

  it("constructs with tradierLiveOptionsEnabled === false under 'equity'", () => {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradierMarkets: 'equity',
    });
    expect(
      (engine as unknown as { tradierLiveOptionsEnabled: boolean }).tradierLiveOptionsEnabled,
    ).toBe(false);
  });

  it("applySettings flips tradierLiveOptionsEnabled when the user changes 'options' → 'equity' → 'both'", async () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' });
    const flag = () =>
      (engine as unknown as { tradierLiveOptionsEnabled: boolean }).tradierLiveOptionsEnabled;
    expect(flag()).toBe(true);

    await engine.applySettings({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradierMarkets: 'equity',
    });
    expect(flag()).toBe(false);

    await engine.applySettings({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradierMarkets: 'both',
    });
    expect(flag()).toBe(true);
  });

  // The actual doTick gate skips the RV scan in live mode when the markets
  // selector excludes options. We exercise the same condition the gate
  // checks rather than spinning up the full doTick (which needs Yahoo
  // fetchQuotes / news mocks to run).
  it('the live equity-only condition (mode=live ∧ !optionsEnabled) is true under equity-only and false otherwise', () => {
    const settings = (markets: AccountSettings['liveTradierMarkets']): AccountSettings => ({
      ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live', liveTradierMarkets: markets,
    });
    const skip = (s: AccountSettings) => s.mode === 'live' && !isLiveTradierOptionsEnabled(s);

    expect(skip(settings('options'))).toBe(false);
    expect(skip(settings('equity'))).toBe(true);
    expect(skip(settings('both'))).toBe(false);

    // Demo mode is unaffected — `liveTradierMarkets` is a live-only switch.
    const demoEquityOnly: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      liveTradierMarkets: 'equity',
    };
    expect(skip(demoEquityOnly)).toBe(false);
  });
});

// ─── TRA-335 — Tradier Live equity bracket trading ─────────────────────────
// Reverses TRA-220 for equities: when liveTradeEquitiesTradier is on AND
// Tradier creds are saved AND mode === 'live', BB-fade / ORB / Ichimoku
// entries fire as Tradier OTOCO bracket orders against the same Tradier
// account that powers options. These tests cover the placement + sizing +
// manual-close paths in isolation; the runTick wiring is exercised
// indirectly via the live equity gate in the open-loop dedup test.
describe('shortBlockedOnCashAccount (TRA-724)', () => {
  it('blocks a sell-to-open on a cash account', () => {
    expect(shortBlockedOnCashAccount('sell', { accountType: 'cash' })).toBe(true);
  });
  it('allows a buy on a cash account (only shorts are gated)', () => {
    expect(shortBlockedOnCashAccount('buy', { accountType: 'cash' })).toBe(false);
  });
  it('allows shorts on margin / pdt accounts', () => {
    expect(shortBlockedOnCashAccount('sell', { accountType: 'margin' })).toBe(false);
    expect(shortBlockedOnCashAccount('sell', { accountType: 'pdt' })).toBe(false);
  });
  it('stays permissive when the account type is indeterminate (null / undefined)', () => {
    expect(shortBlockedOnCashAccount('sell', { accountType: null })).toBe(false);
    expect(shortBlockedOnCashAccount('sell', {})).toBe(false);
  });
});

describe('isOccOptionSymbol (TRA-1305 — options hard-exclude, checklist item 4)', () => {
  it('matches OCC option contract symbols', () => {
    expect(isOccOptionSymbol('AAPL260117C00150000')).toBe(true);
    expect(isOccOptionSymbol('SPY260320P00450000')).toBe(true);
    expect(isOccOptionSymbol('spy260320p00450000')).toBe(true); // case-insensitive
  });
  it('does NOT match plain equity tickers (the live add fast-path)', () => {
    for (const sym of ['AAPL', 'MSFT', 'NVDA', 'SPY', 'BRK.B', 'COIN', 'MSTR', 'GOOGL']) {
      expect(isOccOptionSymbol(sym)).toBe(false);
    }
  });
  it('is null/undefined safe', () => {
    expect(isOccOptionSymbol('')).toBe(false);
    expect(isOccOptionSymbol(undefined as unknown as string)).toBe(false);
  });
});

describe('liveEquityDcaAddEnvAllowed (TRA-1439 — sandbox-first gate; TRA-971 production opened)', () => {
  it('permits the live conviction-DCA add path on the SANDBOX env (zero real capital)', () => {
    expect(liveEquityDcaAddEnvAllowed('sandbox')).toBe(true);
  });
  it('permits the add path on a PRODUCTION env now the board-ratified gate is OPEN (TRA-971/TRA-1597)', () => {
    // Gate opened 07-11: demo evidence 456/0, QT live-$ nod, board approval
    // `a1acc1a3` (dca-971-live). Named conditions satisfied — CFO soak TRA-1393
    // `done`, TRA-382 data gate MET 38/30. The ENV layer now allows production;
    // the belt-and-suspenders is preserved one level down — actual live
    // submission still requires the independent `liveEquityDcaAddsTradier` arm on
    // the LIVE AccountSettings, so opening this env gate alone moves no capital.
    expect(liveEquityDcaAddEnvAllowed('production')).toBe(true);
  });
});

describe('sizeLiveEquityFromStop (TRA-335)', () => {
  function balance(overrides: Partial<TradierAccountBalance> = {}): TradierAccountBalance {
    return {
      totalEquity: 25_000,
      totalCash: 10_000,
      optionBuyingPower: 10_000,
      stockBuyingPower: 20_000,
      longMarketValue: 15_000,
      // TRA-483 — DTBP default; tests can override via the `overrides` arg
      // when they need to exercise the PDT-exhausted path.
      dayTradeBuyingPower: null,
      ...overrides,
    };
  }

  it('sizes off (cash + LMV) × ratio × risk and floors to whole shares', () => {
    const qty = sizeLiveEquityFromStop({
      balance: balance(),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    });
    // managedEquity = 25000 * 0.5 = 12500. maxRisk = 12500 * 0.01 = 125.
    // dist = 5 → riskQty = floor(125/5) = 25.
    // equityCap = floor(12500/100) = 125. stockBP cap = floor(20000/100) = 200.
    // min(25, 125, 200) = 25.
    expect(qty).toBe(25);
  });

  it('caps qty by stockBuyingPower when cash + LMV would otherwise allow more', () => {
    const qty = sizeLiveEquityFromStop({
      balance: balance({ stockBuyingPower: 500 }),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.10,
      entryPrice: 50,
      stopPrice: 49,
      currentPrice: 50,
    });
    // managedEquity = 12500. maxRisk = 1250. dist = 1 → riskQty = 1250.
    // equityCap = 250. stockBP cap = floor(500/50) = 10. min = 10.
    expect(qty).toBe(10);
  });

  it('returns 0 when stop equals entry (zero risk distance)', () => {
    expect(sizeLiveEquityFromStop({
      balance: balance(),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 100,
      currentPrice: 100,
    })).toBe(0);
  });

  it('returns 0 when totalCash + LMV is non-positive', () => {
    expect(sizeLiveEquityFromStop({
      balance: balance({ totalCash: 0, longMarketValue: 0 }),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    })).toBe(0);
  });

  it('falls back to totalCash alone when longMarketValue is null', () => {
    const qty = sizeLiveEquityFromStop({
      balance: balance({ longMarketValue: null }),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    });
    // managedEquity = 10000 * 0.5 = 5000. maxRisk = 50. riskQty = floor(50/5) = 10.
    expect(qty).toBe(10);
  });

  it('skips the buying-power cap when stockBuyingPower is null (cash account fallback)', () => {
    const qty = sizeLiveEquityFromStop({
      balance: balance({ stockBuyingPower: null, totalCash: 5_000, longMarketValue: 0 }),
      managedAccountRatio: 1.0,
      riskPerTrade: 0.05,
      entryPrice: 50,
      stopPrice: 45,
      currentPrice: 50,
    });
    // managedEquity = 5000. maxRisk = 250. riskQty = floor(250/5) = 50.
    // equityCap = floor(5000/50) = 100. min(riskQty=50, equityCap=100) = 50.
    // No SBP cap (null). TRA-499 — perPositionCap(baseEquity=$5,000) =
    // max($150, 15% × $5,000) = $750; 50 × $50 = $2,500 > $750 → trim to
    // floor($750/$50) = 15 shares. The BP cap is still skipped (the test's
    // original intent); the new per-position notional cap is what binds.
    expect(qty).toBe(15);
  });
});

// TRA-499 — small-account equity sizing on a Tradier live book. Mirrors the
// 1-share LIVE floor + per-position notional cap from the options ticket
// budget (TRA-495/TRA-497) so a $550 live book can actually open positions
// without burning all its cash on one ticket. The board directive on
// TRA-494 routes live equities through Tradier (production); these tests
// pin down what "small book" sizing looks like on that path.
describe('sizeLiveEquityFromStop — TRA-499 small-book caps', () => {
  function smallBookBalance(overrides: Partial<TradierAccountBalance> = {}): TradierAccountBalance {
    return {
      totalEquity: 550,
      totalCash: 550,
      optionBuyingPower: 550,
      stockBuyingPower: 550,
      longMarketValue: 0,
      dayTradeBuyingPower: null,
      ...overrides,
    };
  }

  it('forces 1 share on a $50 stock that would otherwise size to 0 (LIVE 1-share floor)', () => {
    // managedEquity = 550 × 1.0 = $550. maxRisk = $550 × 0.10 = $55.
    // 5% stop dist on $50 = $2.50. riskQty = floor($55/$2.50) = 22.
    // equityCap = floor($550/$50) = 11. stockBP cap = floor($550/$50) = 11.
    // min(22, 11, 11) = 11 → cap = $150 → 11 × $50 = $550 > $150 →
    // trim to floor($150/$50) = 3. So the risk-from-stop sizing DOES
    // produce a non-zero qty here; the 1-share LIVE floor only fires when
    // risk math rounds to 0. Sanity-check the cap trim instead.
    const qty = sizeLiveEquityFromStop({
      balance: smallBookBalance(),
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
      entryPrice: 50,
      stopPrice: 47.50,
      currentPrice: 50,
    });
    expect(qty).toBe(3);
  });

  it('returns 0 when 1-share cost exceeds the per-position cap on a small book', () => {
    // baseEquity = $550 → cap = max($150, $82.50) = $150. A $200 stock has
    // 1-share cost $200 ≥ $150 cap → up-front reject. Risk math would
    // otherwise have produced 2 shares (riskQty=5, equityCap=2, min=2)
    // and the multi-share trim would have ground them down to
    // floor($150/$200)=0 anyway, but the early exit short-circuits the
    // whole sizing pass. Final: 0 — position is too concentrated for the
    // small-book swing thesis.
    const qty = sizeLiveEquityFromStop({
      balance: smallBookBalance(),
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
      entryPrice: 200,
      stopPrice: 190,
      currentPrice: 200,
    });
    expect(qty).toBe(0);
  });

  it('rejects a $150 single-ticket on a $550 book (strict-less-than cap admission, QT TRA-499 nit)', () => {
    // The cap is `max($150, 15% × $550) = $150`. A $150 stock has 1-share
    // cost = $150 = cap exactly. The risk-from-stop math here would otherwise
    // size up: managedEquity = $550, maxRisk = $55, stop $7.50 → riskQty = 7;
    // equityCap = floor($550/$150) = 3; sbp cap = 3; qty = 3. Pre-fix the
    // multi-share trim would have given floor($150/$150) = 1 → admit 1 share
    // (1 × $150 = $150 ≤ $150 cap). Post-fix: the up-front strict-less-than
    // admission check (`currentPrice >= cap`) short-circuits to 0 — a single
    // ticket that would consume 100% of the per-position cap is rejected.
    // This is asymmetric with `OptionsAccount.sizeContracts` on purpose; see
    // the in-code comment in `sizeLiveEquityFromStop`.
    const qty = sizeLiveEquityFromStop({
      balance: smallBookBalance(),
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
      entryPrice: 150,
      stopPrice: 142.50,
      currentPrice: 150,
    });
    expect(qty).toBe(0);
  });

  it('forces 1 share when the equity cap rounded sizing to 0 (1-share LIVE floor)', () => {
    // Edge case: a $25 stock where the BP/equity caps don't kick in but
    // we're constrained by an unusually tight risk knob. With
    // managedAccountRatio = 0.5, riskPerTrade = 0.01 on $550: maxRisk = $2.75.
    // 4% stop ($1 on $25) → riskQty = floor($2.75/$1) = 2. equityCap =
    // floor($275/$25) = 11. min = 2. cap = $150 → 2 × $25 = $50 ≤ $150.
    // qty = 2. So the floor doesn't actually need to fire here. Verify the
    // smaller cap doesn't accidentally trim a small-notional position.
    const qty = sizeLiveEquityFromStop({
      balance: smallBookBalance(),
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 25,
      stopPrice: 24,
      currentPrice: 25,
    });
    expect(qty).toBe(2);
  });

  it('1-share LIVE floor fires when risk-from-stop rounds to 0 but a single share fits the cap', () => {
    // Concoct a scenario where risk math gives 0: a very tight risk knob
    // and a wide stop. managedAccountRatio = 0.01, riskPerTrade = 0.01,
    // baseEquity = $550 → managedEquity = $5.50, maxRisk = $0.055.
    // 5% stop on $50 = $2.50 → riskQty = 0. equityCap = floor($5.50/$50) = 0.
    // qty = 0. Cap = $150, currentPrice $50 < $150 → up-front admit, forced
    // floor fires → qty = 1. Multi-share trim: 1 × $50 = $50 ≤ $150 → no
    // trim. Final: 1 share. Boundary semantics: the strict-less-than gate
    // bites only at currentPrice ≥ cap (see the $150 boundary test above).
    const qty = sizeLiveEquityFromStop({
      balance: smallBookBalance(),
      managedAccountRatio: 0.01,
      riskPerTrade: 0.01,
      entryPrice: 50,
      stopPrice: 47.50,
      currentPrice: 50,
    });
    expect(qty).toBe(1);
  });

  it('larger account behaviour is unchanged when per-position cap does not bind', () => {
    // Sanity check: a $50k book buying $100 stock at 5% stop with the
    // existing TRA-335 default knobs. cap = max($150, 15% × $50k) = $7,500.
    // qty from risk-from-stop with managedRatio=0.5, riskPerTrade=0.01:
    // managedEquity=$25k, maxRisk=$250, riskQty=floor($250/$5)=50; equityCap=
    // floor($25k/$100)=250; sbp cap floor($25k/$100)=250; qty=50.
    // cap recheck: 50 × $100 = $5,000 ≤ $7,500 → no trim. Pre-TRA-499 result
    // (50 shares) preserved.
    const qty = sizeLiveEquityFromStop({
      balance: {
        totalEquity: 50_000,
        totalCash: 25_000,
        optionBuyingPower: 25_000,
        stockBuyingPower: 25_000,
        longMarketValue: 25_000,
        dayTradeBuyingPower: null,
      },
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    });
    expect(qty).toBe(50);
  });
});

describe('sizeLiveEquityFromStop — TRA-711 available-funds gate', () => {
  // Mirrors the screenshot account: ~$226 cash with most of it committed to
  // open option orders so Available Funds (stockBuyingPower) is only ~$26,
  // while a swing signal fires on a ~$129 share. Pre-fix the buying-power cap
  // ground qty to 0 and the LIVE 1-share floor re-inflated it to 1, so Tradier
  // received — and rejected — a $129 order against $26 of available funds.
  it('returns 0 when available funds cannot cover even one share (no rejected order)', () => {
    const qty = sizeLiveEquityFromStop({
      balance: {
        totalEquity: 797.16,
        totalCash: 226.66,
        optionBuyingPower: 26.66,
        stockBuyingPower: 26.66,
        longMarketValue: 0,
        dayTradeBuyingPower: null,
      },
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
      entryPrice: 129.56,
      stopPrice: 123.0,
      currentPrice: 129.56,
    });
    expect(qty).toBe(0);
  });

  it('still admits 1 share when available funds cover exactly one share', () => {
    // Available funds $130 ≥ one $129.56 share → the 1-share floor is allowed
    // to fire. cap = max($150, 15% × baseEquity). baseEquity = $130 + $0 LMV
    // → cap = $150 > $129.56, so the up-front strict-less-than gate admits it.
    const qty = sizeLiveEquityFromStop({
      balance: {
        totalEquity: 130,
        totalCash: 130,
        optionBuyingPower: 130,
        stockBuyingPower: 130,
        longMarketValue: 0,
        dayTradeBuyingPower: null,
      },
      managedAccountRatio: 1.0,
      riskPerTrade: 0.01,
      entryPrice: 129.56,
      stopPrice: 123.0,
      currentPrice: 129.56,
    });
    expect(qty).toBe(1);
  });

  it('caps a multi-share order at the affordable-share ceiling', () => {
    // Risk-from-stop would want more shares than available funds can settle.
    // managedEquity = $5,000 cash → maxRisk ($5,000 × 0.10) = $500, $5 stop →
    // riskQty = 100; equityCap = floor($5,000/$50) = 100. But stockBuyingPower
    // is only $260 (most cash committed elsewhere) → affordableShares =
    // floor($260/$50) = 5. Per-position cap = max($150, 15% × $5,000=$750) =
    // $750 → no further trim. Final: capped to the 5 shares funds can cover.
    const qty = sizeLiveEquityFromStop({
      balance: {
        totalEquity: 5_000,
        totalCash: 5_000,
        optionBuyingPower: 260,
        stockBuyingPower: 260,
        longMarketValue: 0,
        dayTradeBuyingPower: null,
      },
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
      entryPrice: 50,
      stopPrice: 45,
      currentPrice: 50,
    });
    expect(qty).toBe(5);
  });

  it('stays permissive when stockBuyingPower is null (cash account, no bucket)', () => {
    // No buying-power bucket from Tradier → affordableShares = Infinity, so the
    // gate is a no-op and sizing falls back to the cash-based risk math. The
    // post-submit reconcile voids the mirror if the broker still rejects.
    const qty = sizeLiveEquityFromStop({
      balance: {
        totalEquity: 5_000,
        totalCash: 5_000,
        optionBuyingPower: null,
        stockBuyingPower: null,
        longMarketValue: 0,
        dayTradeBuyingPower: null,
      },
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    });
    expect(qty).toBeGreaterThan(0);
  });
});

describe('SignalEngine — TRA-335 live equity bracket placement', () => {
  type WaitOpts = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
  interface TradierEquityStub {
    submitBracketOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
    cancelOrder?: ReturnType<typeof vi.fn>;
  }

  function bbSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
    return {
      id: 'sig-1',
      symbol: 'AAPL',
      type: 'bb_fade',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      riskRewardRatio: 2,
      timestamp: Date.now(),
      ...overrides,
    };
  }

  function setupLiveEquityEngine(stub: TradierEquityStub) {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradeEquitiesTradier: true,
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
    });
    (engine as unknown as { tradierLiveEquityClient: unknown }).tradierLiveEquityClient = stub;
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance = {
      totalEquity: 25_000,
      totalCash: 10_000,
      optionBuyingPower: 10_000,
      stockBuyingPower: 20_000,
      longMarketValue: 15_000,
      dayTradeBuyingPower: null,
    };
    return engine;
  }

  // TRA-4692 — a fresh hard-controls sandbox per test: the choke point's
  // idempotency ledger is consume-on-admit and disk-persisted, so without the
  // pin a fixture's static signal id would be refused as `duplicate_order` by
  // the ledger a PREVIOUS run of this suite left in the real DATA_DIR.
  beforeEach(() => {
    __resetHardControlsForTest({ dataDir: mkdtempSync(join(tmpdir(), 'se-hard-controls-')) });
  });

  // TRA-4692 — a bracket fixture sized UNDER the $300 per-trade hard cap the
  // TRA-4650 equity-seam admit now enforces: $12,500 managed × 1% risk / $5
  // stop distance ⇒ qty 25, and at a $10 entry the notional is $250. The old
  // $100-entry fixtures sized to $2,500 and were refused (`max_order_notional`).
  // The controls are board policy — the fixtures are what changed.
  function underCap(overrides: Partial<TradeSignal> = {}): TradeSignal {
    return bbSignal({ entryPrice: 10, stopLoss: 5, takeProfit: 20, ...overrides });
  }

  it('placeTradierEquityBracket submits an OTOCO with the sized qty + entry/TP/SL legs and returns ok on a non-rejected Tradier response', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 42, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _o?: WaitOpts) => ({
        id: 42, status: 'filled', exec_quantity: 25, avg_fill_price: 10,
      })),
    };
    const engine = setupLiveEquityEngine(stub);

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number | string; reason?: string }>
    }).placeTradierEquityBracket(underCap({ id: 'sig-e1' }), 10);

    expect(result.ok).toBe(true);
    expect(result.orderId).toBe(42);
    expect(stub.submitBracketOrder).toHaveBeenCalledTimes(1);
    expect(stub.submitBracketOrder).toHaveBeenCalledWith({
      symbol: 'AAPL', qty: 25, side: 'buy',
      limitPrice: 10, takeProfitPrice: 20, stopLossPrice: 5,
    });
  });

  it('refuses a live equity bracket outside regular market hours and never hits the broker (TRA-726)', async () => {
    // Post-close: 2024-06-04T22:00:00Z = 18:00 ET (after the 16:00 close).
    vi.setSystemTime(Date.parse('2024-06-04T22:00:00Z'));
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 99, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEquityEngine(stub);

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number | string; reason?: string }>
    }).placeTradierEquityBracket(bbSignal(), 100);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/market closed/i);
    expect(stub.submitBracketOrder).not.toHaveBeenCalled();
  });

  it('skips a SHORT (sell-to-open) bracket on a cash account with a clear liveSkipReason and never hits the broker (TRA-724)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEquityEngine(stub);
    // Flip the cached balance to a cash account — cash accounts cannot short.
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance.accountType =
      'cash';

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number | string; reason?: string }>
    }).placeTradierEquityBracket(bbSignal({ side: 'sell' }), 100);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('short not supported on a cash account');
    // Critical: the order never reached Tradier (no guaranteed reject).
    expect(stub.submitBracketOrder).not.toHaveBeenCalled();
  });

  it('still submits a LONG (buy) bracket on a cash account — only shorts are gated (TRA-724)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 7, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 7, status: 'filled' })),
    };
    const engine = setupLiveEquityEngine(stub);
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance.accountType =
      'cash';

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; reason?: string }>
    }).placeTradierEquityBracket(underCap({ id: 'sig-e2', side: 'buy' }), 10);

    expect(result.ok).toBe(true);
    expect(stub.submitBracketOrder).toHaveBeenCalledTimes(1);
    expect(stub.submitBracketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'buy' }),
    );
  });

  it('still submits a SHORT bracket on a margin account — shorts are only blocked on cash (TRA-724)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 8, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 8, status: 'filled' })),
    };
    const engine = setupLiveEquityEngine(stub);
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance.accountType =
      'margin';

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; reason?: string }>
    }).placeTradierEquityBracket(underCap({ id: 'sig-e3', side: 'sell' }), 10);

    expect(result.ok).toBe(true);
    expect(stub.submitBracketOrder).toHaveBeenCalledTimes(1);
    expect(stub.submitBracketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'sell' }),
    );
  });

  it('returns ok:false with a reason when Tradier ends in canceled (e.g. insufficient buying power)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 99, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async () => ({
        id: 99, status: 'canceled', reason_description: 'insufficient buying power',
      })),
    };
    const engine = setupLiveEquityEngine(stub);

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number; reason?: string }>
    }).placeTradierEquityBracket(underCap({ id: 'sig-e4' }), 10);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('canceled');
    expect(result.reason).toContain('insufficient buying power');
  });

  it('returns ok:false when the broker call throws (network/auth failure) — never opens a phantom position', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockRejectedValue(new Error('Tradier 401 unauthorized')),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEquityEngine(stub);

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; reason?: string }>
    }).placeTradierEquityBracket(underCap({ id: 'sig-e5' }), 10);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Tradier 401 unauthorized');
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();
  });

  // TRA-4692 — the refusal path the old fixtures exercised by accident, now
  // asserted on purpose: this is the discriminator that fails if the TRA-4650
  // admit call is ever unwired from the equity seam. The default bbSignal
  // fixture sizes to qty 25 × $100 = $2,500, well over the $300 hard cap.
  it('hard controls REFUSE an oversized bracket (max_order_notional) before the broker is reached (TRA-4650)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEquityEngine(stub);

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; reason?: string }>
    }).placeTradierEquityBracket(bbSignal({ id: 'sig-oversized' }), 100);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('hard controls REFUSED (max_order_notional)');
    // The refusal never reaches Tradier.
    expect(stub.submitBracketOrder).not.toHaveBeenCalled();
  });

  // TRA-4692 — control 3 at this seam: one broker submit attempt per fired
  // signal, ever. The admit CONSUMES `live-equity-open:<signal.id>`, so a
  // second bracket for the same signal id is refused as a duplicate.
  it('hard controls REFUSE a second bracket for the same signal id (duplicate_order) — the broker is hit exactly once (TRA-4650)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 42, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 42, status: 'filled' })),
    };
    const engine = setupLiveEquityEngine(stub);
    const sig = underCap({ id: 'sig-dup' });
    const place = (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; reason?: string }>
    }).placeTradierEquityBracket.bind(engine);

    const first = await place(sig, 10);
    expect(first.ok).toBe(true);

    const second = await place(sig, 10);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('hard controls REFUSED (duplicate_order)');
    expect(stub.submitBracketOrder).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false when the cached Tradier balance is missing (engine refuses to size against an unknown balance)', async () => {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const engine = setupLiveEquityEngine(stub);
    (engine as unknown as { liveTradierBalance: TradierAccountBalance | null }).liveTradierBalance = null;

    const result = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; reason?: string }>
    }).placeTradierEquityBracket(bbSignal(), 100);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('balance');
    expect(stub.submitBracketOrder).not.toHaveBeenCalled();
  });

  it('manualClosePosition on a live equity position drops the position locally, marks pnl, and kicks off the Tradier OCO cancel for the entry order', async () => {
    // TRA-1159 — this test exercises the manual-close → Tradier OCO-cancel
    // *mechanics*, not the TRA-952 swing holding-period policy. TRA-952 added a
    // day-trade-close guard (`checkEquityDayTradingClose`) that is ON by default
    // (`EQUITY_SWING_MODE` ≠ off) and refuses a same-session discretionary close —
    // so opening and immediately closing here returns null. Opt this mechanics test
    // out of swing mode so the close path runs; a dedicated TRA-952 test covers the
    // holding-period block itself.
    const prevSwing = process.env.EQUITY_SWING_MODE;
    process.env.EQUITY_SWING_MODE = 'off';
    try {
    const stub: TradierEquityStub = {
      submitBracketOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
    };
    const engine = setupLiveEquityEngine(stub);

    // Seed a live equity open by calling the mirror helper.
    const sig = bbSignal();
    const pos = (engine as unknown as {
      openLiveEquityMirror: (s: TradeSignal, p: number, oid: number | string) => { id: string } | null;
    }).openLiveEquityMirror(sig, 100, 42);
    expect(pos).not.toBeNull();
    expect(engine.getState().account.openPositions).toHaveLength(1);

    const closed = engine.manualClosePosition(pos!.id, 105);
    expect(closed).not.toBeNull();
    expect(closed!.exitPrice).toBe(105);
    // pnl = (105 - 100) × 25 × 1 = 125 for a 25-share BUY.
    expect(closed!.pnl).toBe(125);
    // The live store no longer holds the position even before the
    // fire-and-forget broker close completes — the dashboard reflects
    // the close immediately.
    expect(engine.getState().account.openPositions).toHaveLength(0);

    // Flush microtasks queued by the fire-and-forget close path
    // (closeTradierEquityPosition awaits cancelOrder before issuing the
    // market-sell HTTP call). Awaiting a Promise.resolve cycle lets
    // cancelOrder's mock be invoked before the assertion below.
    await Promise.resolve();
    await Promise.resolve();
    expect(stub.cancelOrder).toHaveBeenCalledWith(42);
    } finally {
      if (prevSwing === undefined) delete process.env.EQUITY_SWING_MODE;
      else process.env.EQUITY_SWING_MODE = prevSwing;
    }
  });
});

describe('buildTradierLiveEquityClient gating (TRA-335)', () => {
  it('returns null when liveTradeEquitiesTradier is false even with full live creds', () => {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradeEquitiesTradier: false,
      liveApiKeyOptionsSandbox: 'tok',
      liveAccountIdOptionsSandbox: 'A1',
      liveTradierEnvOptions: 'sandbox',
    });
    const client = (engine as unknown as { tradierLiveEquityClient: TradierOrderClient | null }).tradierLiveEquityClient;
    expect(client).toBeNull();
  });

  it('returns a client when toggle is on AND creds are saved', () => {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradeEquitiesTradier: true,
      liveApiKeyOptionsSandbox: 'tok',
      liveAccountIdOptionsSandbox: 'A1',
      liveTradierEnvOptions: 'sandbox',
    });
    const client = (engine as unknown as { tradierLiveEquityClient: TradierOrderClient | null }).tradierLiveEquityClient;
    expect(client).not.toBeNull();
  });

  it('returns null in demo mode regardless of toggle', () => {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      liveTradeEquitiesTradier: true,
      liveApiKeyOptionsSandbox: 'tok',
      liveAccountIdOptionsSandbox: 'A1',
    });
    const client = (engine as unknown as { tradierLiveEquityClient: TradierOrderClient | null }).tradierLiveEquityClient;
    expect(client).toBeNull();
  });
});

// TRA-352 follow-up — end-to-end test of the pending-close reconciler the
// board asked us to add. Drives the engine's `reconcilePendingCloses` against
// stub Tradier clients for each env and asserts that the matching open row
// is filled / cleared / left pending based on the broker's status.
describe('SignalEngine — TRA-352 pending-close reconciler', () => {
  interface OrderStatusStub {
    getOrderStatus: ReturnType<typeof vi.fn>;
  }
  interface OptionsAcctStub {
    openOptionFromCandidate(sig: unknown, mode: 'live'): { id: string } | null;
    setPendingCloseOrderId(id: string, orderId: number): boolean;
    getState(): {
      openOptions: Array<{ id: string; pendingCloseOrderId?: number | string }>;
      closedOptions: Array<{ id: string; currentPremium: number; pnl?: number }>;
    };
  }
  type EngineInternals = {
    tradierOptionsClientByEnv: Record<TradierEnv, unknown>;
    optionsAccounts: Record<TradierEnv, OptionsAcctStub>;
  };

  function asInternals(engine: SignalEngine): EngineInternals {
    return engine as unknown as EngineInternals;
  }

  function setupEngine(stubs: { sandbox?: OrderStatusStub; production?: OrderStatusStub }) {
    const engine = new SignalEngine();
    asInternals(engine).tradierOptionsClientByEnv = {
      sandbox: stubs.sandbox ?? null,
      production: stubs.production ?? null,
    };
    return engine;
  }

  function openLiveEngineRow(
    engine: SignalEngine,
    env: TradierEnv,
    overrides: { symbol?: string; optionSymbol?: string } = {},
  ): { optionId: string; orderId: number } {
    const acct = asInternals(engine).optionsAccounts[env];
    const opened = acct.openOptionFromCandidate(
      {
        id: 'sig',
        symbol: overrides.symbol ?? 'AAPL',
        type: 'otm_mispricing',
        side: 'buy',
        entryPrice: 1.0,
        stopLoss: 0.75,
        takeProfit: 1.5,
        riskRewardRatio: 2,
        timestamp: TRADING_TIME,
        optionSymbol: overrides.optionSymbol ?? 'AAPL240705C00200000',
        optionType: 'call',
        strike: 200,
        expiration: '2024-07-05',
        mark: 1.0,
        theo: 1.3,
        mispricingPct: -0.23,
        delta: 0.18,
      },
      'live',
    );
    if (!opened) throw new Error('test setup: failed to open option');
    const orderId = Math.floor(Math.random() * 1_000_000) + 1;
    acct.setPendingCloseOrderId(opened.id, orderId);
    return { optionId: opened.id, orderId };
  }

  it('closes the engine-opened local row at the broker avg_fill_price when Tradier reports filled', async () => {
    const stub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({ id: 1, status: 'filled', avg_fill_price: 1.45 })),
    };
    const engine = setupEngine({ sandbox: stub });
    const { optionId } = openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcilePendingCloses();

    expect(summary.filled).toBe(1);
    expect(summary.cleared).toBe(0);
    // Read directly off the per-env account so the live-vs-demo getState mode
    // scoping doesn't hide the closed row. We're testing the reconciler's
    // mutation, not the public dashboard mask.
    const sandboxState = asInternals(engine).optionsAccounts.sandbox.getState();
    expect(sandboxState.openOptions.find(o => o.id === optionId)).toBeUndefined();
    const closed = sandboxState.closedOptions.find(o => o.id === optionId);
    expect(closed).toBeDefined();
    // Closed at the broker avg fill price, NOT the local mark.
    expect(closed?.currentPremium).toBeCloseTo(1.45, 5);
  });

  it('clears pendingCloseOrderId on a terminal non-fill so the user can re-click Close', async () => {
    const stub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({
        id: 1,
        status: 'canceled',
        reason_description: 'user cancelled on Tradier',
      })),
    };
    const engine = setupEngine({ sandbox: stub });
    const { optionId } = openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcilePendingCloses();

    expect(summary.cleared).toBe(1);
    expect(summary.filled).toBe(0);
    const stillOpen = asInternals(engine).optionsAccounts.sandbox
      .getState()
      .openOptions.find(o => o.id === optionId);
    expect(stillOpen).toBeDefined();
    expect(stillOpen?.pendingCloseOrderId).toBeUndefined();
  });

  it('leaves rows pending when the broker still reports open / pending', async () => {
    const stub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({ id: 1, status: 'open' })),
    };
    const engine = setupEngine({ sandbox: stub });
    const { optionId, orderId } = openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcilePendingCloses();

    expect(summary.stillPending).toBe(1);
    const stillOpen = asInternals(engine).optionsAccounts.sandbox
      .getState()
      .openOptions.find(o => o.id === optionId);
    // pendingCloseOrderId survives so the dashboard still shows "Pending #N".
    expect(stillOpen?.pendingCloseOrderId).toBe(orderId);
  });

  it('skips reconciliation for an env that has no Tradier client configured', async () => {
    const sandboxStub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({ id: 1, status: 'filled', avg_fill_price: 1.20 })),
    };
    // No production client — only sandbox creds saved.
    const engine = setupEngine({ sandbox: sandboxStub });
    const { optionId: sandboxId } = openLiveEngineRow(engine, 'sandbox');
    const { optionId: prodId } = openLiveEngineRow(engine, 'production', {
      optionSymbol: 'MSFT240705C00400000',
    });

    const summary = await engine.reconcilePendingCloses();

    expect(summary.filled).toBe(1);
    expect(summary.noClient).toBe(1);
    const states = asInternals(engine).optionsAccounts;
    // Sandbox row filled, production row still pending until creds are saved.
    expect(states.sandbox.getState().openOptions.find(o => o.id === sandboxId)).toBeUndefined();
    const prodRow = states.production.getState().openOptions.find(o => o.id === prodId);
    expect(prodRow?.pendingCloseOrderId).toBeDefined();
  });

  it('reconciles BOTH envs in a single sweep so cross-env pending closes resolve together', async () => {
    const sandboxStub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({ id: 1, status: 'filled', avg_fill_price: 1.30 })),
    };
    const prodStub: OrderStatusStub = {
      getOrderStatus: vi.fn(async () => ({
        id: 2,
        status: 'expired',
        reason_description: 'EOD expiration',
      })),
    };
    const engine = setupEngine({ sandbox: sandboxStub, production: prodStub });
    const { optionId: sandboxId } = openLiveEngineRow(engine, 'sandbox');
    const { optionId: prodId } = openLiveEngineRow(engine, 'production', {
      optionSymbol: 'MSFT240705C00400000',
    });

    const summary = await engine.reconcilePendingCloses();

    expect(summary.filled).toBe(1);
    expect(summary.cleared).toBe(1);
    // Sandbox closed via fill, production re-opened with cleared pending tag.
    const states = asInternals(engine).optionsAccounts;
    expect(states.sandbox.getState().openOptions.find(o => o.id === sandboxId)).toBeUndefined();
    const prodRow = states.production.getState().openOptions.find(o => o.id === prodId);
    expect(prodRow).toBeDefined();
    expect(prodRow?.pendingCloseOrderId).toBeUndefined();
  });

  it('survives a getOrderStatus throw without aborting the rest of the sweep', async () => {
    const sandboxStub: OrderStatusStub = {
      // Throws on first call, succeeds on second — the helper swallows the
      // throw into an `unknown` outcome so the second row still reconciles.
      getOrderStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error('socket reset'))
        .mockResolvedValueOnce({ id: 99, status: 'filled', avg_fill_price: 1.10 }),
    };
    const engine = setupEngine({ sandbox: sandboxStub });
    openLiveEngineRow(engine, 'sandbox');
    const { optionId: secondId } = openLiveEngineRow(engine, 'sandbox', {
      optionSymbol: 'AAPL240705C00250000',
    });

    const summary = await engine.reconcilePendingCloses();

    // First row: unknown → stillPending. Second row: filled.
    expect(summary.filled).toBe(1);
    expect(summary.stillPending).toBe(1);
    expect(
      asInternals(engine).optionsAccounts.sandbox.getState().openOptions.find(o => o.id === secondId),
    ).toBeUndefined();
  });
});

// TRA-392 — fill-chaser. A `sell_to_close` that stalls `pending` past the
// staleness window must be cancelled and resubmitted one step lower toward
// the bid by the engine's per-tick close reconciler, instead of sitting at
// the original limit until the operator manually reprices it. These tests
// drive `reconcilePendingCloses` against stub Tradier clients with the clock
// advanced past the staleness window.
describe('SignalEngine — TRA-392 pending-close fill-chaser', () => {
  interface ChaserClient {
    getOrderStatus: ReturnType<typeof vi.fn>;
    getOptionQuote: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    sellContractsLimit: ReturnType<typeof vi.fn>;
  }
  interface ChaserAcct {
    openOptionFromCandidate(sig: unknown, mode: 'live'): { id: string } | null;
    setPendingCloseOrderId(id: string, orderId: number): boolean;
    getState(): {
      openOptions: Array<{
        id: string;
        contractsRemaining: number;
        pendingCloseOrderId?: number | string;
        pendingCloseRepriceSteps?: number;
      }>;
      closedOptions: Array<{ id: string; currentPremium: number }>;
    };
  }
  type Internals = {
    tradierOptionsClientByEnv: Record<TradierEnv, unknown>;
    optionsAccounts: Record<TradierEnv, ChaserAcct>;
  };

  const T0 = Date.parse('2024-06-04T15:00:00Z');

  function asInternals(engine: SignalEngine): Internals {
    return engine as unknown as Internals;
  }

  function openPendingRow(engine: SignalEngine, client: ChaserClient, orderId: number) {
    asInternals(engine).tradierOptionsClientByEnv = { sandbox: client, production: null };
    const acct = asInternals(engine).optionsAccounts.sandbox;
    const opened = acct.openOptionFromCandidate(
      {
        id: 'sig',
        symbol: 'AAPL',
        type: 'otm_mispricing',
        side: 'buy',
        entryPrice: 1.0,
        stopLoss: 0.75,
        takeProfit: 1.5,
        riskRewardRatio: 2,
        timestamp: TRADING_TIME,
        optionSymbol: 'AAPL240705C00200000',
        optionType: 'call',
        strike: 200,
        expiration: '2024-07-05',
        mark: 1.0,
        theo: 1.3,
        mispricingPct: -0.23,
        delta: 0.18,
      },
      'live',
    );
    if (!opened) throw new Error('test setup: failed to open option');
    acct.setPendingCloseOrderId(opened.id, orderId);
    return { acct, optionId: opened.id };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels and reprices a stale pending close one step down toward the bid', async () => {
    const client: ChaserClient = {
      getOrderStatus: vi.fn(async () => ({ id: 700, status: 'open' })),
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL240705C00200000', bid: 16, ask: 18 })),
      cancelOrder: vi.fn(async () => undefined),
      sellContractsLimit: vi.fn(async () => ({ id: 5555, status: 'ok' })),
    };
    const engine = new SignalEngine();
    const { acct, optionId } = openPendingRow(engine, client, 700);
    const contracts = acct.getState().openOptions.find((o) => o.id === optionId)!.contractsRemaining;

    // Order has sat pending past the 20s staleness window.
    vi.setSystemTime(T0 + 25_000);
    const summary = await engine.reconcilePendingCloses();

    expect(summary.repriced).toBe(1);
    expect(summary.stillPending).toBe(0);
    // Stale order cancelled, fresh limit submitted at bid + 0.2·spread = 16.40.
    expect(client.cancelOrder).toHaveBeenCalledWith(700);
    expect(client.sellContractsLimit).toHaveBeenCalledWith('AAPL240705C00200000', contracts, 16.4);
    const row = acct.getState().openOptions.find((o) => o.id === optionId);
    expect(row?.pendingCloseOrderId).toBe(5555);
    expect(row?.pendingCloseRepriceSteps).toBe(1);
  });

  it('leaves a fresh pending close alone until it crosses the staleness window', async () => {
    const client: ChaserClient = {
      getOrderStatus: vi.fn(async () => ({ id: 700, status: 'open' })),
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL240705C00200000', bid: 16, ask: 18 })),
      cancelOrder: vi.fn(async () => undefined),
      sellContractsLimit: vi.fn(async () => ({ id: 5555, status: 'ok' })),
    };
    const engine = new SignalEngine();
    openPendingRow(engine, client, 700);

    // Reconcile immediately — the order is only milliseconds old.
    const summary = await engine.reconcilePendingCloses();

    expect(summary.repriced).toBe(0);
    expect(summary.stillPending).toBe(1);
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect(client.sellContractsLimit).not.toHaveBeenCalled();
  });

  it('closes the row at the broker fill once a repriced order fills on a later tick', async () => {
    const client: ChaserClient = {
      getOrderStatus: vi.fn(async () => ({ id: 700, status: 'open' })),
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL240705C00200000', bid: 16, ask: 18 })),
      cancelOrder: vi.fn(async () => undefined),
      sellContractsLimit: vi.fn(async () => ({ id: 5555, status: 'ok' })),
    };
    const engine = new SignalEngine();
    const { acct, optionId } = openPendingRow(engine, client, 700);

    // Tick 1: stale → reprice down to 16.40 (new order 5555).
    vi.setSystemTime(T0 + 25_000);
    await engine.reconcilePendingCloses();

    // Tick 2: the repriced order fills at the bid-tracking limit.
    client.getOrderStatus.mockResolvedValue({ id: 5555, status: 'filled', avg_fill_price: 16.4 });
    vi.setSystemTime(T0 + 60_000);
    const summary = await engine.reconcilePendingCloses();

    expect(summary.filled).toBe(1);
    const state = acct.getState();
    expect(state.openOptions.find((o) => o.id === optionId)).toBeUndefined();
    expect(state.closedOptions.find((o) => o.id === optionId)?.currentPremium).toBeCloseTo(16.4, 5);
  });

  it('holds the live order without repricing when the floor is reached (no $0 order)', async () => {
    const client: ChaserClient = {
      getOrderStatus: vi.fn(async () => ({ id: 700, status: 'open' })),
      // Dead contract — no usable bid/ask/last, so no lower limit can be priced.
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL240705C00200000', bid: 0, ask: 0, last: 0 })),
      cancelOrder: vi.fn(async () => undefined),
      sellContractsLimit: vi.fn(async () => ({ id: 5555, status: 'ok' })),
    };
    const engine = new SignalEngine();
    const { acct, optionId } = openPendingRow(engine, client, 700);

    vi.setSystemTime(T0 + 25_000);
    const summary = await engine.reconcilePendingCloses();

    expect(summary.repriced).toBe(0);
    expect(summary.stillPending).toBe(1);
    // Original order left LIVE — never cancelled into a no-order limbo.
    expect(client.cancelOrder).not.toHaveBeenCalled();
    expect(client.sellContractsLimit).not.toHaveBeenCalled();
    expect(acct.getState().openOptions.find((o) => o.id === optionId)?.pendingCloseOrderId).toBe(700);
  });

  it('stops repricing once the bounded walk is exhausted', async () => {
    const client: ChaserClient = {
      getOrderStatus: vi.fn(async () => ({ id: 700, status: 'open' })),
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL240705C00200000', bid: 16, ask: 18 })),
      cancelOrder: vi.fn(async () => undefined),
      sellContractsLimit: vi.fn(async (_s: string, _q: number, _p: number) => ({ id: 5000, status: 'ok' })),
    };
    const engine = new SignalEngine();
    const { acct, optionId } = openPendingRow(engine, client, 700);

    // Run enough stale ticks to exhaust the 4-step walk, then one more.
    for (let i = 1; i <= 6; i += 1) {
      vi.setSystemTime(T0 + i * 25_000);
      await engine.reconcilePendingCloses();
    }

    // The walk caps at PENDING_CLOSE_MAX_REPRICE_STEPS (4) resubmits.
    expect(client.sellContractsLimit).toHaveBeenCalledTimes(4);
    const row = acct.getState().openOptions.find((o) => o.id === optionId);
    expect(row?.pendingCloseRepriceSteps).toBe(4);
    // Final step lands exactly on the bid (most-aggressive marketable price).
    expect(client.sellContractsLimit).toHaveBeenLastCalledWith('AAPL240705C00200000', expect.any(Number), 16);
  });
});

// TRA-356 — periodic portfolio reconcile while live mode is active. The
// engine pulls Tradier's open positions on a cadence and feeds them
// through the existing `reconcileTradierPositions` rules so manual
// Tradier-side actions flow back into local state without a button press.
// These tests drive `reconcileLivePortfolio` directly so we can assert
// the skip / fetch / dedupe behaviours without standing up a full tick.
describe('SignalEngine — TRA-356 periodic portfolio reconcile', () => {
  // TRA-3073 — the sweep now reads through `readOpenOptionPositions`, which
  // keeps the failure state. `readOpenOptionPositions` returns `[]` for both a
  // real empty book and a 401, and feeding THAT to the broker-flat sweep is
  // what booked phantom closes. These stubs speak the envelope.
  interface ListPositionsStub {
    readOpenOptionPositions: ReturnType<typeof vi.fn>;
  }
  /** A 2xx read of a real book (possibly genuinely empty). */
  function okRead(positions: unknown[] = []) {
    return { ok: true as const, positions };
  }
  type EngineInternals = {
    tradierOptionsClientByEnv: Record<TradierEnv, unknown>;
    optionsAccounts: Record<TradierEnv, {
      openOptionFromCandidate(sig: unknown, mode: 'live'): { id: string } | null;
      getStateForMode(mode: 'demo' | 'live'): { openOptions: Array<{ id: string }> };
    }>;
    mode: 'demo' | 'live';
    tradierEnv: TradierEnv;
    lastTradierPortfolioReconcileAt: number;
  };

  function asInternals(engine: SignalEngine): EngineInternals {
    return engine as unknown as EngineInternals;
  }

  function setupEngine(opts: {
    mode?: 'demo' | 'live';
    env?: TradierEnv;
    client?: ListPositionsStub | null;
  } = {}) {
    const engine = new SignalEngine();
    const internals = asInternals(engine);
    internals.mode = opts.mode ?? 'live';
    const env = opts.env ?? 'sandbox';
    internals.tradierEnv = env;
    internals.tradierOptionsClientByEnv = {
      sandbox: env === 'sandbox' ? (opts.client ?? null) : null,
      production: env === 'production' ? (opts.client ?? null) : null,
    };
    return engine;
  }

  function openLiveEngineRow(
    engine: SignalEngine,
    env: TradierEnv,
    overrides: { symbol?: string; optionSymbol?: string } = {},
  ): { optionId: string } {
    const acct = asInternals(engine).optionsAccounts[env];
    const opened = acct.openOptionFromCandidate(
      {
        id: 'sig',
        symbol: overrides.symbol ?? 'AAPL',
        type: 'otm_mispricing',
        side: 'buy',
        entryPrice: 1.0,
        stopLoss: 0.75,
        takeProfit: 1.5,
        riskRewardRatio: 2,
        timestamp: TRADING_TIME,
        optionSymbol: overrides.optionSymbol ?? 'AAPL240705C00200000',
        optionType: 'call',
        strike: 200,
        expiration: '2024-07-05',
        mark: 1.0,
        theo: 1.3,
        mispricingPct: -0.23,
        delta: 0.18,
      },
      'live',
    );
    if (!opened) throw new Error('test setup: failed to open option');
    return { optionId: opened.id };
  }

  it('skips the network call entirely in demo mode', async () => {
    const stub: ListPositionsStub = { readOpenOptionPositions: vi.fn() };
    const engine = setupEngine({ mode: 'demo', client: stub });

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.skipped).toBe('mode');
    expect(stub.readOpenOptionPositions).not.toHaveBeenCalled();
  });

  it('skips when no Tradier client is configured for the active env', async () => {
    const engine = setupEngine({ mode: 'live', env: 'sandbox', client: null });

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.skipped).toBe('no-client');
  });

  it('skips when the active env has no open rows, no pending exits, and no pending closes', async () => {
    const stub: ListPositionsStub = { readOpenOptionPositions: vi.fn() };
    const engine = setupEngine({ client: stub });

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.skipped).toBe('empty');
    expect(stub.readOpenOptionPositions).not.toHaveBeenCalled();
  });

  it('fetches Tradier positions and imports a new external open into the active env', async () => {
    // Pre-seed an open row so the throttle gate lets us through, but use a
    // different OCC symbol than the Tradier response so the import path
    // adds the second row instead of just updating the seed.
    const stub: ListPositionsStub = {
      readOpenOptionPositions: vi.fn().mockResolvedValue(okRead([
        {
          optionSymbol: 'MSFT240705C00400000',
          underlying: 'MSFT',
          optionType: 'call',
          strike: 400,
          expiration: '2024-07-05',
          contracts: 2,
          premiumPaid: 1.10,
          acquiredAt: TRADING_TIME,
        },
      ])),
    };
    const engine = setupEngine({ client: stub });
    openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.skipped).toBeNull();
    expect(summary.added).toBe(1);
    expect(stub.readOpenOptionPositions).toHaveBeenCalledTimes(1);
    const liveRows = asInternals(engine).optionsAccounts.sandbox.getStateForMode('live').openOptions;
    expect(liveRows.map(r => (r as unknown as { optionSymbol?: string }).optionSymbol).sort()).toEqual([
      'AAPL240705C00200000',
      'MSFT240705C00400000',
    ]);
  });

  it('does not double-import an engine-opened row sharing the OCC symbol Tradier reports', async () => {
    // Engine-opened (importedFromTradier=false) row with the same OCC symbol
    // Tradier surfaces. Reconcile must skip it rather than mint a second copy.
    const stub: ListPositionsStub = {
      readOpenOptionPositions: vi.fn().mockResolvedValue(okRead([
        {
          optionSymbol: 'AAPL240705C00200000',
          underlying: 'AAPL',
          optionType: 'call',
          strike: 200,
          expiration: '2024-07-05',
          contracts: 1,
          premiumPaid: 1.0,
          acquiredAt: TRADING_TIME,
        },
      ])),
    };
    const engine = setupEngine({ client: stub });
    openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.added).toBe(0);
    expect(summary.updated).toBe(0);
    const liveRows = asInternals(engine).optionsAccounts.sandbox.getStateForMode('live').openOptions;
    expect(liveRows).toHaveLength(1);
  });

  it('enforces the cadence — a second call inside the window is short-circuited', async () => {
    const stub: ListPositionsStub = {
      readOpenOptionPositions: vi.fn().mockResolvedValue(okRead([])),
    };
    const engine = setupEngine({ client: stub });
    openLiveEngineRow(engine, 'sandbox');

    const first = await engine.reconcileLivePortfolio();
    expect(first.skipped).toBeNull();

    // Same fake-clock instant — second call must hit the cadence guard
    // without listing positions again.
    const second = await engine.reconcileLivePortfolio();
    expect(second.skipped).toBe('cadence');
    expect(stub.readOpenOptionPositions).toHaveBeenCalledTimes(1);

    // Advance past the cadence window and the next call goes out again.
    vi.setSystemTime(TRADING_TIME + 31_000);
    const third = await engine.reconcileLivePortfolio();
    expect(third.skipped).toBeNull();
    expect(stub.readOpenOptionPositions).toHaveBeenCalledTimes(2);
  });

  it('keeps the cadence timestamp unchanged when the gate skips so the next non-empty tick reconciles immediately', async () => {
    const stub: ListPositionsStub = {
      readOpenOptionPositions: vi.fn().mockResolvedValue(okRead([])),
    };
    const engine = setupEngine({ client: stub });

    const empty = await engine.reconcileLivePortfolio();
    expect(empty.skipped).toBe('empty');
    expect(asInternals(engine).lastTradierPortfolioReconcileAt).toBe(0);

    // Now open a row; the very next call (no clock advance) should reconcile.
    openLiveEngineRow(engine, 'sandbox');
    const summary = await engine.reconcileLivePortfolio();
    expect(summary.skipped).toBeNull();
    expect(stub.readOpenOptionPositions).toHaveBeenCalledTimes(1);
  });

  it('swallows list-positions failures and bumps the cadence timestamp so we do not tight-loop on a Tradier outage', async () => {
    const stub: ListPositionsStub = {
      readOpenOptionPositions: vi.fn().mockRejectedValue(new Error('socket reset')),
    };
    const engine = setupEngine({ client: stub });
    openLiveEngineRow(engine, 'sandbox');

    const summary = await engine.reconcileLivePortfolio();

    expect(summary.skipped).toBeNull();
    expect(summary.added).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.removed).toBe(0);
    // Timestamp advanced so the next same-instant call hits the cadence
    // guard instead of retrying the failed list call in a tight loop.
    expect(asInternals(engine).lastTradierPortfolioReconcileAt).toBe(TRADING_TIME);
    const second = await engine.reconcileLivePortfolio();
    expect(second.skipped).toBe('cadence');
    expect(stub.readOpenOptionPositions).toHaveBeenCalledTimes(1);
  });

  // TRA-3010 — the enabling precondition for the gate-A basis census.
  //
  // The census publishes `candidates: 0` in five states that mean completely
  // different things, and only ONE of them ("the sweep ran and there was no
  // engine-opened row") is honest BLIND. Without a positive witness that the
  // branch was reached, a Tradier outage or a dark live client is byte-
  // identical to a quiet day — which is the exact defect the gate exists to
  // avoid, reproduced one level up. These pin the discriminator.
  describe('TRA-3010 sweep witness', () => {
    it('records ZERO reached and names the reason for every state that never gets to the census', async () => {
      // dark: not in live mode
      const demo = setupEngine({ mode: 'demo', client: { readOpenOptionPositions: vi.fn() } });
      await demo.reconcileLivePortfolio();
      expect(demo.getEngineBasisSweepWitness()).toMatchObject({
        reached: 0,
        lastOutcome: 'mode',
        skipped: expect.objectContaining({ mode: 1 }),
      });

      // dark: no client for the active env
      const noClient = setupEngine({ mode: 'live', env: 'sandbox', client: null });
      await noClient.reconcileLivePortfolio();
      expect(noClient.getEngineBasisSweepWitness()).toMatchObject({
        reached: 0,
        lastOutcome: 'no-client',
        skipped: expect.objectContaining({ no_client: 1 }),
      });

      // idle: no open live rows, so the network read is never made
      const idle = setupEngine({ client: { readOpenOptionPositions: vi.fn().mockResolvedValue(okRead([])) } });
      await idle.reconcileLivePortfolio();
      expect(idle.getEngineBasisSweepWitness()).toMatchObject({
        reached: 0,
        lastOutcome: 'empty',
        skipped: expect.objectContaining({ empty: 1 }),
      });

      // broker unreadable: this is the one that most resembles a quiet day
      const outage = setupEngine({
        client: { readOpenOptionPositions: vi.fn().mockRejectedValue(new Error('socket reset')) },
      });
      openLiveEngineRow(outage, 'sandbox');
      await outage.reconcileLivePortfolio();
      expect(outage.getEngineBasisSweepWitness()).toMatchObject({
        reached: 0,
        lastOutcome: 'fetch-failed',
        skipped: expect.objectContaining({ fetch_failed: 1 }),
      });
      // and it must NOT be confusable with the idle case
      expect(outage.getEngineBasisSweepWitness().skipped.empty).toBe(0);
    });

    it('records reached>0 with a timestamp once the census branch actually runs, even when it matches nothing', async () => {
      const stub: ListPositionsStub = { readOpenOptionPositions: vi.fn().mockResolvedValue(okRead([])) };
      const engine = setupEngine({ client: stub });
      openLiveEngineRow(engine, 'sandbox');

      const summary = await engine.reconcileLivePortfolio();
      expect(summary.skipped).toBeNull();

      const witness = engine.getEngineBasisSweepWitness();
      // The broker reported nothing, so no row was matched and the census
      // denominator is legitimately zero — but the sweep DID reach it. That
      // pairing is what makes the zero readable instead of unread.
      expect(witness.reached).toBe(1);
      expect(witness.lastOutcome).toBe('reached');
      expect(witness.lastReachedAt).toBe(TRADING_TIME);
      expect(engine.getEngineBasisRestatementCensus('sandbox').candidates).toBe(0);
      // The distinguishing assertion: a zero denominator here is NOT the same
      // reading as the outage case above, which also publishes candidates: 0.
      expect(witness.skipped.fetch_failed).toBe(0);
    });
  });

  // TRA-3073 — the acceptance suite for "an unreadable broker is BLIND, never
  // flat".
  //
  // BOTH directions live in this one describe on purpose. A suite that only
  // asserts "an outage closes nothing" is UNFALSIFIABLE: deleting the TRA-2799
  // sweep outright passes it. The genuine-empty-book case below is the positive
  // control that says the sweep is still armed, and the two together are the
  // discriminator — the whole defect was that those two inputs read alike.
  //
  // These drive a REAL `TradierOptionsClient` over a stubbed `fetch`, not a
  // hand-rolled method stub, because the defect is HTTP-shaped: `getJson` maps
  // every non-2xx to `null`, `parseTradierPositions(null)` is `[]`, and `[]` is
  // byte-identical to the answer for a genuinely flat account. A stub that just
  // resolves `[]` cannot express the difference, so the status code has to be
  // the input under test.
  describe('TRA-3073 — an unreadable broker is BLIND, never flat', () => {
    /** > BROKER_MISSING_MIN_AGE_MS (5 min): a young row is exempt from the sweep. */
    const PAST_MIN_AGE_MS = 6 * 60_000;
    /** > TRADIER_PORTFOLIO_RECONCILE_MS (30s): the failure path bumps the cadence stamp too. */
    const PAST_CADENCE_MS = 31_000;

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function setupLiveClientEngine(respond: () => { status: number; body: unknown }) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          const { status, body } = respond();
          return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
          } as unknown as Response;
        }),
      );
      const engine = setupEngine({
        client: new RealTradierOptionsClient(
          'test-token',
          'ACCT-3073',
          'sandbox',
        ) as unknown as ListPositionsStub,
      });
      const { optionId } = openLiveEngineRow(engine, 'sandbox');
      return { engine, optionId };
    }

    /** The account's live map, where `brokerMissingSweeps` actually lives. */
    function liveRowMap(engine: SignalEngine) {
      return (asInternals(engine).optionsAccounts.sandbox as unknown as {
        openOptions: Map<string, { brokerMissingSweeps?: number }>;
      }).openOptions;
    }

    /** Sweep `i` — spaced past both the row-age floor and the cadence window. */
    async function sweepAt(engine: SignalEngine, i: number) {
      vi.setSystemTime(TRADING_TIME + PAST_MIN_AGE_MS + i * PAST_CADENCE_MS);
      return engine.reconcileLivePortfolio();
    }

    /**
     * Acceptance 1. Four sweeps is twice `BROKER_MISSING_SWEEPS_TO_CLOSE`, so
     * the old code had booked the phantom close by sweep 2 and this asserts
     * well past the point of no return. `brokerMissingSweeps` must not merely
     * stay below the trip — it must never be WRITTEN, because the counter is
     * only ever reset by the broker reporting the symbol, and an outage can
     * never do that. A half-counted streak survives the outage and trips on the
     * first real miss afterwards.
     */
    async function expectOutageClosesNothing(status: number, detail: string) {
      const { engine, optionId } = setupLiveClientEngine(() => ({ status, body: {} }));
      const rows = liveRowMap(engine);

      for (let i = 0; i < 4; i += 1) await sweepAt(engine, i);

      expect(rows.has(optionId)).toBe(true);
      expect(rows.get(optionId)?.brokerMissingSweeps).toBeUndefined();

      // Acceptance 3 — the skip is COUNTED, not silent, and the count names
      // which failure it was. 400 skips against `HTTP 401` is an ops incident;
      // 400 against a socket reset is a bad afternoon.
      const witness = engine.getEngineBasisSweepWitness();
      expect(witness.skipped.fetch_failed).toBe(4);
      expect(witness.lastOutcome).toBe('fetch-failed');
      expect(witness.lastFetchFailure).toMatchObject({ reason: 'http_status', detail });
      // And the sweep never reached the census, so a `candidates: 0` published
      // during the outage is not readable as "ran, found nothing".
      expect(witness.reached).toBe(0);
    }

    it('a 401 repeated past the 2-sweep guard removes and closes NOTHING', async () => {
      await expectOutageClosesNothing(401, 'HTTP 401');
    });

    it('a 500 repeated past the 2-sweep guard removes and closes NOTHING', async () => {
      await expectOutageClosesNothing(500, 'HTTP 500');
    });

    it('a transport failure is counted as `transport`, not as an empty book', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket reset'); }));
      const engine = setupEngine({
        client: new RealTradierOptionsClient('t', 'A', 'sandbox') as unknown as ListPositionsStub,
      });
      const { optionId } = openLiveEngineRow(engine, 'sandbox');
      const rows = liveRowMap(engine);

      for (let i = 0; i < 4; i += 1) await sweepAt(engine, i);

      expect(rows.has(optionId)).toBe(true);
      expect(rows.get(optionId)?.brokerMissingSweeps).toBeUndefined();
      expect(engine.getEngineBasisSweepWitness().lastFetchFailure).toMatchObject({
        reason: 'transport',
      });
    });

    /**
     * Acceptance 2 — the positive control. Tradier answers a genuinely flat
     * account with `2xx` and the LITERAL STRING `positions: "null"`. That is a
     * real reading of a real book, and the TRA-2799 sweep must still act on it
     * exactly as before: one miss arms the counter, the second books the close.
     * If this test goes green-by-not-closing, the repair has silently reverted
     * TRA-2799 and the stranded-row defect is back.
     */
    it('still books the close after two misses on a GENUINE empty book', async () => {
      const { engine, optionId } = setupLiveClientEngine(() => ({
        status: 200,
        body: { positions: 'null' },
      }));
      const rows = liveRowMap(engine);

      const first = await sweepAt(engine, 0);
      expect(first.skipped).toBeNull();
      expect(first.removed).toBe(0);
      // Armed but not tripped — this is the guard doing its intended job.
      expect(rows.get(optionId)?.brokerMissingSweeps).toBe(1);

      const second = await sweepAt(engine, 1);
      expect(second.removed).toBe(1);
      expect(rows.has(optionId)).toBe(false);

      // …and it got there through the census, not past it.
      const witness = engine.getEngineBasisSweepWitness();
      expect(witness.reached).toBe(2);
      expect(witness.skipped.fetch_failed).toBe(0);
      expect(witness.lastFetchFailure).toBeNull();
    });
  });
});

// TRA-415 — periodic equity-position reconcile while live mode is active.
// The equity-side counterpart of the TRA-356 options sweep: the engine
// pulls Tradier's open equity positions on a cadence and merges them into
// the TRA-335 live equity mirror so a stock opened / closed out-of-band
// (on Tradier's web UI, or by a failed mirror order) flows back into local
// state. These tests drive `reconcileLiveEquityPortfolio` directly so we
// can assert import / update / remove + the skip / dedupe behaviours.
describe('SignalEngine — TRA-415 periodic equity-position reconcile', () => {
  interface ListEquityStub {
    listOpenEquityPositions: ReturnType<typeof vi.fn>;
  }
  type EquityInternals = {
    mode: 'demo' | 'live';
    tradierLiveEquityClient: ListEquityStub | null;
    liveEquityPositions: Map<string, Position>;
    liveEquityOrderIds: Map<string, number | string>;
    lastTradierEquityReconcileAt: number;
    equityReconciledOnBoot: boolean;
  };

  function asEquityInternals(engine: SignalEngine): EquityInternals {
    return engine as unknown as EquityInternals;
  }

  function setupEquityEngine(opts: {
    mode?: 'demo' | 'live';
    client?: ListEquityStub | null;
  } = {}) {
    const engine = new SignalEngine();
    const internals = asEquityInternals(engine);
    internals.mode = opts.mode ?? 'live';
    internals.tradierLiveEquityClient = opts.client ?? null;
    return engine;
  }

  // Seed a row directly into the live equity mirror. `imported` rows carry
  // `importedFromTradier: true` (a prior reconcile sweep); engine-opened
  // rows leave the flag absent.
  function seedEquityRow(
    engine: SignalEngine,
    overrides: Partial<Position> & { imported?: boolean } = {},
  ): Position {
    const { imported, ...rest } = overrides;
    const pos: Position = {
      id: rest.id ?? `pos-${rest.symbol ?? 'AAPL'}`,
      symbol: 'AAPL',
      side: 'buy',
      signalType: imported ? 'tradier_import' : 'orb_breakout',
      entryPrice: 100,
      quantity: 10,
      stopLoss: imported ? 0 : 95,
      takeProfit: imported ? Number.POSITIVE_INFINITY : 110,
      openedAt: TRADING_TIME,
      mode: 'live',
      ...(imported ? { importedFromTradier: true } : {}),
      ...rest,
    };
    asEquityInternals(engine).liveEquityPositions.set(pos.id, pos);
    return pos;
  }

  function tradierEquityRow(overrides: Record<string, unknown> = {}) {
    return {
      symbol: 'AAPL',
      quantity: 10,
      side: 'buy' as const,
      costBasis: 100,
      acquiredAt: TRADING_TIME,
      ...overrides,
    };
  }

  it('skips the network call entirely in demo mode', async () => {
    const stub: ListEquityStub = { listOpenEquityPositions: vi.fn() };
    const engine = setupEquityEngine({ mode: 'demo', client: stub });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.skipped).toBe('mode');
    expect(stub.listOpenEquityPositions).not.toHaveBeenCalled();
  });

  it('skips when no Tradier equity client is configured', async () => {
    const engine = setupEquityEngine({ mode: 'live', client: null });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.skipped).toBe('no-client');
  });

  it('skips the network call when the live equity mirror is empty (idle account)', async () => {
    const stub: ListEquityStub = { listOpenEquityPositions: vi.fn() };
    const engine = setupEquityEngine({ client: stub });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.skipped).toBe('empty');
    expect(stub.listOpenEquityPositions).not.toHaveBeenCalled();
    // Idle skip leaves the cadence timestamp untouched so the next non-empty
    // tick reconciles immediately.
    expect(asEquityInternals(engine).lastTradierEquityReconcileAt).toBe(0);
  });

  it('force bypasses the idle throttle so the boot sweep imports a cold-start position', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([tradierEquityRow()]),
    };
    const engine = setupEquityEngine({ client: stub });

    // Mirror is empty — a non-forced sweep would skip. The boot sweep forces.
    const summary = await engine.reconcileLiveEquityPortfolio({ force: true });

    expect(summary.skipped).toBeNull();
    expect(summary.added).toBe(1);
    expect(stub.listOpenEquityPositions).toHaveBeenCalledTimes(1);
  });

  it('imports an out-of-band open as an importedFromTradier row with sentinel TP/SL', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([
        tradierEquityRow({ symbol: 'MSFT', quantity: 5, costBasis: 420 }),
      ]),
    };
    const engine = setupEquityEngine({ client: stub });
    // Seed an unrelated row so the idle throttle lets the sweep through.
    seedEquityRow(engine, { id: 'seed', symbol: 'NVDA', imported: true });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.added).toBe(1);
    const rows = Array.from(asEquityInternals(engine).liveEquityPositions.values());
    const msft = rows.find(r => r.symbol === 'MSFT');
    expect(msft).toBeDefined();
    expect(msft?.importedFromTradier).toBe(true);
    expect(msft?.quantity).toBe(5);
    expect(msft?.entryPrice).toBe(420);
    expect(msft?.signalType).toBe('tradier_import');
    // Sentinel TP/SL — a long can never reach a 0 stop or a +Infinity target.
    expect(msft?.stopLoss).toBe(0);
    expect(msft?.takeProfit).toBe(Number.POSITIVE_INFINITY);
  });

  it('imports a short out-of-band open with inverted sentinel TP/SL', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([
        tradierEquityRow({ symbol: 'TSLA', side: 'sell', quantity: 3, costBasis: 250 }),
      ]),
    };
    const engine = setupEquityEngine({ client: stub });
    seedEquityRow(engine, { id: 'seed', symbol: 'NVDA', imported: true });

    await engine.reconcileLiveEquityPortfolio();

    const tsla = Array.from(asEquityInternals(engine).liveEquityPositions.values())
      .find(r => r.symbol === 'TSLA');
    expect(tsla?.side).toBe('sell');
    expect(tsla?.stopLoss).toBe(Number.POSITIVE_INFINITY);
    expect(tsla?.takeProfit).toBe(0);
  });

  it('updates the quantity of an imported row on a partial fill', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([
        tradierEquityRow({ quantity: 7, costBasis: 101 }),
      ]),
    };
    const engine = setupEquityEngine({ client: stub });
    const seeded = seedEquityRow(engine, { id: 'imp', imported: true, quantity: 10, entryPrice: 100 });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.updated).toBe(1);
    expect(summary.added).toBe(0);
    expect(seeded.quantity).toBe(7);
    expect(seeded.entryPrice).toBe(101);
    // Still the same row — updated in place, not orphaned.
    expect(asEquityInternals(engine).liveEquityPositions.size).toBe(1);
  });

  it('drops an imported row Tradier no longer reports (closed out-of-band)', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([]),
    };
    const engine = setupEquityEngine({ client: stub });
    seedEquityRow(engine, { id: 'imp', imported: true });
    asEquityInternals(engine).liveEquityOrderIds.set('imp', 12345);

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.removed).toBe(1);
    expect(asEquityInternals(engine).liveEquityPositions.size).toBe(0);
    expect(asEquityInternals(engine).liveEquityOrderIds.has('imp')).toBe(false);
  });

  it('does not double-import or drop an engine-opened row sharing the Tradier symbol', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([tradierEquityRow()]),
    };
    const engine = setupEquityEngine({ client: stub });
    // Engine-opened row (no importedFromTradier flag) for the same symbol.
    seedEquityRow(engine, { id: 'engine', symbol: 'AAPL' });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.added).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.removed).toBe(0);
    const rows = asEquityInternals(engine).liveEquityPositions;
    expect(rows.size).toBe(1);
    expect(rows.get('engine')?.importedFromTradier).toBeUndefined();
  });

  it('leaves an engine-opened row untouched even when Tradier reports nothing', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([]),
    };
    const engine = setupEquityEngine({ client: stub });
    seedEquityRow(engine, { id: 'engine', symbol: 'AAPL' });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.removed).toBe(0);
    expect(asEquityInternals(engine).liveEquityPositions.has('engine')).toBe(true);
  });

  it('enforces the cadence — a second call inside the window is short-circuited', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockResolvedValue([tradierEquityRow()]),
    };
    const engine = setupEquityEngine({ client: stub });
    seedEquityRow(engine, { id: 'imp', imported: true });

    const first = await engine.reconcileLiveEquityPortfolio();
    expect(first.skipped).toBeNull();

    const second = await engine.reconcileLiveEquityPortfolio();
    expect(second.skipped).toBe('cadence');
    expect(stub.listOpenEquityPositions).toHaveBeenCalledTimes(1);

    vi.setSystemTime(TRADING_TIME + 31_000);
    const third = await engine.reconcileLiveEquityPortfolio();
    expect(third.skipped).toBeNull();
    expect(stub.listOpenEquityPositions).toHaveBeenCalledTimes(2);
  });

  it('swallows list-positions failures and bumps the cadence timestamp so we do not tight-loop', async () => {
    const stub: ListEquityStub = {
      listOpenEquityPositions: vi.fn().mockRejectedValue(new Error('socket reset')),
    };
    const engine = setupEquityEngine({ client: stub });
    seedEquityRow(engine, { id: 'imp', imported: true });

    const summary = await engine.reconcileLiveEquityPortfolio();

    expect(summary.skipped).toBeNull();
    expect(summary.added).toBe(0);
    expect(asEquityInternals(engine).lastTradierEquityReconcileAt).toBe(TRADING_TIME);
    const second = await engine.reconcileLiveEquityPortfolio();
    expect(second.skipped).toBe('cadence');
    expect(stub.listOpenEquityPositions).toHaveBeenCalledTimes(1);
  });
});

// TRA-349 — regression-lock the (mode × dashboard) sub-account wiring shipped
// in TRA-346. SignalEngine owns three stocks-side sub-accounts plus an
// engine-level pair of fields:
//
//   * `account` (PaperAccount, demo paper)         → (demo, stocks)
//   * `optionsAccounts.sandbox` (PaperOptionsAccount, demo paper) → (demo, stocks)
//   * `optionsAccounts.production` (PaperOptionsAccount, live)    → (live, stocks)
//   * `managedAccountRatio` / `riskPerTrade` (drive Tradier live equity sizing
//     via TRA-335)                                  → (live, stocks)
//
// These tests fail if any wire is rewired to read from the legacy un-suffixed
// `managedAccountRatio` / `riskPerTrade` field, the wrong dashboard bucket, or
// the wrong mode bucket. We use four distinct values across the four scoped
// buckets so a swap never accidentally type-checks.

interface PaperAccountInternals {
  managedAccountRatio: number;
  riskPerTrade: number;
}
interface OptionsAccountInternals {
  managedAccountRatio: number;
}
interface SignalEngineInternals {
  account: PaperAccountInternals;
  optionsAccounts: { sandbox: OptionsAccountInternals; production: OptionsAccountInternals };
  managedAccountRatio: number;
  riskPerTrade: number;
}

function fourBucketSettings(overrides: Partial<AccountSettings> = {}): AccountSettings {
  return {
    ...DEFAULT_ACCOUNT_SETTINGS,
    // Distinct values per (mode × market) so a wiring swap surfaces as a
    // numerical mismatch instead of silently coinciding with another bucket.
    managedAccountRatioDemoStocks: 0.10,
    managedAccountRatioLiveStocks: 0.20,
    managedAccountRatioDemoCrypto: 0.30,
    managedAccountRatioLiveCrypto: 0.40,
    riskPerTradeDemoStocks: 0.001,
    riskPerTradeLiveStocks: 0.002,
    riskPerTradeDemoCrypto: 0.005,
    riskPerTradeLiveCrypto: 0.01,
    // Sentinel values on the legacy un-suffixed fields — if any sub-account
    // reads from these instead of its scoped bucket, the test fails because
    // 0.99 / 0.49 don't match any scoped bucket above.
    managedAccountRatio: 0.99,
    riskPerTrade: 0.49,
    ...overrides,
  };
}

describe('SignalEngine — TRA-346 four-bucket sub-account wiring (TRA-349)', () => {
  it('constructor wires each stocks sub-account to its mode-locked bucket', () => {
    const engine = new SignalEngine(fourBucketSettings({ mode: 'demo' })) as unknown as SignalEngineInternals;
    // Demo paper account → (demo, stocks).
    expect(engine.account.managedAccountRatio).toBe(0.10);
    expect(engine.account.riskPerTrade).toBe(0.001);
    // Sandbox options account is paper-only → (demo, stocks).
    expect(engine.optionsAccounts.sandbox.managedAccountRatio).toBe(0.10);
    // Production options account is the live trading bucket → (live, stocks).
    expect(engine.optionsAccounts.production.managedAccountRatio).toBe(0.20);
    // Engine-level fields drive Tradier live equity sizing (TRA-335) →
    // (live, stocks). Pinning here ensures Tradier orders honour the
    // user's Live Risk slider regardless of which mode they're viewing.
    expect(engine.managedAccountRatio).toBe(0.20);
    expect(engine.riskPerTrade).toBe(0.002);
  });

  it('constructor still pins the live-side bucket to (live, stocks) when settings.mode is live', () => {
    // The wiring is mode-locked, not mode-active: switching settings.mode to
    // 'live' must NOT pull the demo paper account's ratio along — that
    // regression is exactly the original TRA-346 bug.
    const engine = new SignalEngine(fourBucketSettings({ mode: 'live' })) as unknown as SignalEngineInternals;
    expect(engine.account.managedAccountRatio).toBe(0.10);
    expect(engine.account.riskPerTrade).toBe(0.001);
    expect(engine.optionsAccounts.sandbox.managedAccountRatio).toBe(0.10);
    expect(engine.optionsAccounts.production.managedAccountRatio).toBe(0.20);
    expect(engine.managedAccountRatio).toBe(0.20);
    expect(engine.riskPerTrade).toBe(0.002);
  });

  it('applySettings re-pins each sub-account to its mode-locked bucket on every save', async () => {
    // Start from defaults so the first applySettings exercises the fresh
    // wiring path (no carryover from a previous settings snapshot).
    const engine = new SignalEngine() as unknown as SignalEngineInternals & {
      applySettings: (s: AccountSettings) => Promise<void>;
    };
    await engine.applySettings(fourBucketSettings({ mode: 'demo' }));

    expect(engine.account.managedAccountRatio).toBe(0.10);
    expect(engine.account.riskPerTrade).toBe(0.001);
    expect(engine.optionsAccounts.sandbox.managedAccountRatio).toBe(0.10);
    expect(engine.optionsAccounts.production.managedAccountRatio).toBe(0.20);
    expect(engine.managedAccountRatio).toBe(0.20);
    expect(engine.riskPerTrade).toBe(0.002);
  });

  it('applySettings: a Demo edit on stocks does NOT bleed into the production options bucket', async () => {
    // Headline TRA-346 invariant. Start with a saved snapshot scoping all four
    // stocks buckets, then save again with a Demo-only edit; the production
    // bucket must keep its original (live, stocks) value.
    const engine = new SignalEngine() as unknown as SignalEngineInternals & {
      applySettings: (s: AccountSettings) => Promise<void>;
    };
    await engine.applySettings(fourBucketSettings({ mode: 'demo' }));
    await engine.applySettings(fourBucketSettings({
      mode: 'demo',
      managedAccountRatioDemoStocks: 0.11,
      riskPerTradeDemoStocks: 0.0011,
    }));

    expect(engine.account.managedAccountRatio).toBe(0.11);
    expect(engine.account.riskPerTrade).toBe(0.0011);
    expect(engine.optionsAccounts.sandbox.managedAccountRatio).toBe(0.11);
    // Production stays put — the Demo edit must not pull live-mode sizing.
    expect(engine.optionsAccounts.production.managedAccountRatio).toBe(0.20);
    expect(engine.managedAccountRatio).toBe(0.20);
    expect(engine.riskPerTrade).toBe(0.002);
  });

  it('falls back to the legacy un-suffixed managedAccountRatio when scoped buckets are absent', async () => {
    // Saved-before-TRA-346 snapshot: only `managedAccountRatio`/`riskPerTrade`
    // are set, all eight scoped fields undefined. Each sub-account must
    // surface the legacy value via the resolver fallback chain.
    const engine = new SignalEngine() as unknown as SignalEngineInternals & {
      applySettings: (s: AccountSettings) => Promise<void>;
    };
    await engine.applySettings({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      managedAccountRatio: 0.42,
      riskPerTrade: 0.013,
    });

    expect(engine.account.managedAccountRatio).toBe(0.42);
    expect(engine.account.riskPerTrade).toBe(0.013);
    expect(engine.optionsAccounts.sandbox.managedAccountRatio).toBe(0.42);
    expect(engine.optionsAccounts.production.managedAccountRatio).toBe(0.42);
    expect(engine.managedAccountRatio).toBe(0.42);
    expect(engine.riskPerTrade).toBe(0.013);
  });
});

// ─── TRA-361 / TRA-450 — submitStagedOptionExits pricing ────────────────────
// TRA-361: the PaperOptionsAccount stages a pendingExit with `pricing:'market'`
// for deep-underwater imported positions; the engine must route those through
// `sellContracts` (market) and everything else through `sellContractsLimit`.
// TRA-450: a LIMIT exit must be repriced off a FRESH live quote at submit time
// — an SL / trailing exit sits on the bid (marketable), a TP1 / manual exit at
// the mid — instead of submitting at the stale entry-time trigger price.
describe('SignalEngine — TRA-361/TRA-450 submitStagedOptionExits pricing', () => {
  interface TradierExitStub {
    getOptionQuote: ReturnType<typeof vi.fn>;
    sellContractsLimit: ReturnType<typeof vi.fn>;
    sellContracts: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    getOrderStatus: ReturnType<typeof vi.fn>;
  }

  function makeStub(): TradierExitStub {
    return {
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'X', bid: 0.80, ask: 1.20 }),
      sellContractsLimit: vi.fn().mockResolvedValue({ id: 901, status: 'pending' }),
      sellContracts: vi.fn().mockResolvedValue({ id: 902, status: 'pending' }),
      // No terminal status — keep the pendingExit and let the next tick poll.
      waitForOrderTerminalStatus: vi.fn().mockResolvedValue(null),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      getOrderStatus: vi.fn().mockResolvedValue({ id: 901, status: 'canceled', exec_quantity: 0 }),
    };
  }

  function setupEngine(stub: TradierExitStub) {
    const engine = new SignalEngine();
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    return engine;
  }

  function bindSubmit(engine: SignalEngine) {
    return (engine as unknown as {
      submitStagedOptionExits: (s: import('@trading-app/shared').OptionPosition[]) => Promise<void>;
    }).submitStagedOptionExits.bind(engine);
  }

  function stagedExit(
    over: Partial<import('@trading-app/shared').OptionPendingExit> & { optionSymbol?: string },
  ): import('@trading-app/shared').OptionPosition {
    const { optionSymbol = 'SPY260515C00450000', ...exit } = over;
    return {
      id: 'opt-1',
      symbol: 'SPY',
      optionSymbol,
      pendingExit: {
        tradierOrderId: '',
        qty: 2,
        limitPrice: 1.50, // stale entry-time trigger — must NOT be submitted
        submittedAt: Date.now(),
        kind: 'sl',
        pricing: 'limit',
        ...exit,
      },
    } as unknown as import('@trading-app/shared').OptionPosition;
  }

  it('TRA-450 — reprices an SL LIMIT exit onto the live book, not the stale trigger', async () => {
    const stub = makeStub();
    const submit = bindSubmit(setupEngine(stub));
    await submit([stagedExit({ kind: 'sl' })]);
    // 0.80 / 1.20 is a 40%-wide book, so TRA-3418 caps the first ask at
    // mid − max(0.05, 5% of mid) = 1.00 − 0.05 = 0.95 rather than sitting on the
    // 0.80 bid. Either way the stale 1.50 trigger is never submitted.
    expect(stub.getOptionQuote).toHaveBeenCalledWith('SPY260515C00450000');
    expect(stub.sellContractsLimit).toHaveBeenCalledWith('SPY260515C00450000', 2, 0.95);
    expect(stub.sellContracts).not.toHaveBeenCalled();
  });

  it('TRA-450 — sits on the bid untouched when the book is tight enough that the cap is inert', async () => {
    const stub = makeStub();
    // mid 1.00, concession 0.02 — well inside max(0.05, 5% of mid).
    stub.getOptionQuote.mockResolvedValue({ symbol: 'X', bid: 0.98, ask: 1.02 });
    const submit = bindSubmit(setupEngine(stub));
    await submit([stagedExit({ kind: 'sl' })]);
    expect(stub.sellContractsLimit).toHaveBeenCalledWith('SPY260515C00450000', 2, 0.98);
    expect(stub.cancelOrder).not.toHaveBeenCalled();
  });

  it('TRA-450 — reprices a TP1 LIMIT exit onto the live mid', async () => {
    const stub = makeStub();
    const submit = bindSubmit(setupEngine(stub));
    await submit([stagedExit({ kind: 'tp1' })]);
    // mid of 0.80 / 1.20 = 1.00 — a profit-taking exit keeps the spread.
    expect(stub.sellContractsLimit).toHaveBeenCalledWith('SPY260515C00450000', 2, 1.00);
  });

  it('TRA-450 — falls back to the staged trigger price when the quote lookup fails', async () => {
    const stub = makeStub();
    stub.getOptionQuote.mockRejectedValueOnce(new Error('Tradier 503'));
    const submit = bindSubmit(setupEngine(stub));
    await submit([stagedExit({ kind: 'sl' })]);
    expect(stub.sellContractsLimit).toHaveBeenCalledWith('SPY260515C00450000', 2, 1.50);
  });

  it('escalates a MARKET-pricing intent through sellContracts (deep-underwater fallback)', async () => {
    const stub = makeStub();
    const engine = setupEngine(stub);
    const submit = (engine as unknown as {
      submitStagedOptionExits: (s: import('@trading-app/shared').OptionPosition[]) => Promise<void>;
    }).submitStagedOptionExits.bind(engine);

    const snapshot = {
      id: 'opt-2',
      symbol: 'NFLX',
      optionSymbol: 'NFLX260515P00400000',
      importedFromTradier: true,
      pendingExit: {
        tradierOrderId: '',
        qty: 1,
        limitPrice: 7.50, // SL trigger price, ignored because pricing='market'
        submittedAt: Date.now(),
        kind: 'sl',
        pricing: 'market',
      },
    } as unknown as import('@trading-app/shared').OptionPosition;
    await submit([snapshot]);

    expect(stub.sellContracts).toHaveBeenCalledWith('NFLX260515P00400000', 1);
    expect(stub.sellContractsLimit).not.toHaveBeenCalled();
  });
});

// ─── TRA-3418 — concession-cap escalation ────────────────────────────────────
// The cap asks ABOVE the bid on a wide book. That is only defensible because it
// is bounded: if the book won't meet the cap inside the submit-wait window the
// order is withdrawn and re-submitted at the un-capped price, so the state
// "resting above the bid" cannot survive the tick that created it.
//
// The failure mode these tests exist for is NOT a missed escalation — declining
// to escalate merely reproduces the pre-TRA-3418 price. It is a DOUBLE SELL:
// cancelling an order that filled between the last poll and the cancel, then
// re-submitting the full quantity, opens a naked short leg on a live account.
// Every "does NOT escalate" case below is that guard.
describe('SignalEngine — TRA-3418 capped-exit escalation', () => {
  interface EscalationStub {
    getOptionQuote: ReturnType<typeof vi.fn>;
    sellContractsLimit: ReturnType<typeof vi.fn>;
    sellContracts: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    getOrderStatus: ReturnType<typeof vi.fn>;
  }

  // The 2026-08-07 TROW book: mid 3.60, bid 3.00. Cap = 3.60 − 0.18 = 3.42.
  const TROW_QUOTE = { symbol: 'TROW260918C00115000', bid: 3.0, ask: 4.2 };

  function makeStub(over: Partial<EscalationStub> = {}): EscalationStub {
    return {
      getOptionQuote: vi.fn().mockResolvedValue(TROW_QUOTE),
      sellContractsLimit: vi.fn().mockResolvedValue({ id: 901, status: 'pending' }),
      sellContracts: vi.fn().mockResolvedValue({ id: 902, status: 'pending' }),
      // Working, untouched, past the wait window — the escalation trigger.
      waitForOrderTerminalStatus: vi.fn().mockResolvedValue({ id: 901, status: 'open', exec_quantity: 0 }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      getOrderStatus: vi.fn().mockResolvedValue({ id: 901, status: 'canceled', exec_quantity: 0 }),
      ...over,
    };
  }

  function submitWith(stub: EscalationStub) {
    const engine = new SignalEngine();
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    return (engine as unknown as {
      submitStagedOptionExits: (s: import('@trading-app/shared').OptionPosition[]) => Promise<void>;
    }).submitStagedOptionExits.bind(engine);
  }

  function trowExit(): import('@trading-app/shared').OptionPosition {
    return {
      id: 'opt-trow',
      symbol: 'TROW',
      optionSymbol: 'TROW260918C00115000',
      pendingExit: {
        tradierOrderId: '',
        qty: 1,
        limitPrice: 3.5,
        submittedAt: Date.now(),
        kind: 'sl',
        pricing: 'limit',
      },
    } as unknown as import('@trading-app/shared').OptionPosition;
  }

  it('asks 3.42 first and concedes to the 3.00 bid only after the book declines it', async () => {
    const stub = makeStub();
    await submitWith(stub)([trowExit()]);
    expect(stub.sellContractsLimit).toHaveBeenNthCalledWith(1, 'TROW260918C00115000', 1, 3.42);
    expect(stub.cancelOrder).toHaveBeenCalledWith(901);
    expect(stub.sellContractsLimit).toHaveBeenNthCalledWith(2, 'TROW260918C00115000', 1, 3.0);
    // Exactly one escalation — the walk is bounded, not a ladder.
    expect(stub.sellContractsLimit).toHaveBeenCalledTimes(2);
  });

  it('does NOT escalate when the capped limit filled — no cancel, no second order', async () => {
    const stub = makeStub({
      waitForOrderTerminalStatus: vi
        .fn()
        .mockResolvedValue({ id: 901, status: 'filled', exec_quantity: 1, avg_fill_price: 3.42 }),
    });
    await submitWith(stub)([trowExit()]);
    expect(stub.sellContractsLimit).toHaveBeenCalledTimes(1);
    expect(stub.cancelOrder).not.toHaveBeenCalled();
  });

  it('does NOT escalate a PARTIAL fill — the remaining qty is not the qty we would re-submit', async () => {
    const stub = makeStub({
      waitForOrderTerminalStatus: vi.fn().mockResolvedValue({ id: 901, status: 'open', exec_quantity: 1 }),
    });
    await submitWith(stub)([trowExit()]);
    expect(stub.sellContractsLimit).toHaveBeenCalledTimes(1);
    expect(stub.cancelOrder).not.toHaveBeenCalled();
  });

  it('does NOT escalate when the order state is unknown — never blind-cancel', async () => {
    // Every status poll failed. The order may be filled; cancelling and
    // re-submitting on that guess is the double-sell.
    const stub = makeStub({ waitForOrderTerminalStatus: vi.fn().mockResolvedValue(null) });
    await submitWith(stub)([trowExit()]);
    expect(stub.sellContractsLimit).toHaveBeenCalledTimes(1);
    expect(stub.cancelOrder).not.toHaveBeenCalled();
  });

  it('does NOT re-submit when the cancel throws — the capped order is still live at the broker', async () => {
    const stub = makeStub({ cancelOrder: vi.fn().mockRejectedValue(new Error('Tradier 500')) });
    await submitWith(stub)([trowExit()]);
    expect(stub.sellContractsLimit).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-submit when the cancel is not CONFIRMED terminal-and-zero-filled', async () => {
    // The cancel raced a fill: the re-read comes back filled, not canceled.
    const stub = makeStub({
      getOrderStatus: vi.fn().mockResolvedValue({ id: 901, status: 'filled', exec_quantity: 1 }),
    });
    await submitWith(stub)([trowExit()]);
    expect(stub.sellContractsLimit).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-submit when the post-cancel re-read is unavailable', async () => {
    const stub = makeStub({ getOrderStatus: vi.fn().mockResolvedValue(null) });
    await submitWith(stub)([trowExit()]);
    expect(stub.sellContractsLimit).toHaveBeenCalledTimes(1);
  });

  it('does NOT escalate a TP1 exit — the mid level is above the cap by construction', async () => {
    const stub = makeStub();
    const snapshot = trowExit();
    (snapshot.pendingExit as { kind: string }).kind = 'tp1';
    await submitWith(stub)([snapshot]);
    expect(stub.sellContractsLimit).toHaveBeenCalledTimes(1);
    expect(stub.sellContractsLimit).toHaveBeenCalledWith('TROW260918C00115000', 1, 3.6);
    expect(stub.cancelOrder).not.toHaveBeenCalled();
  });
});

// ── TRA-389 — market-review regime gate consumption ──────────────────────────

describe('TRA-389 — market-review regime gates', () => {
  function gates(o: Partial<MarketReviewGates> = {}): MarketReviewGates {
    return {
      orbLongs: true,
      orbShorts: true,
      meanReversionTilt: false,
      breakoutsEnabled: true,
      sizingMultiplier: 1,
      ...o,
    };
  }

  function sig(o: Partial<TradeSignal> = {}): TradeSignal {
    return {
      id: 'sig-1',
      symbol: 'AAPL',
      type: 'orb_breakout',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      riskRewardRatio: 2,
      timestamp: TRADING_TIME,
      ...o,
    };
  }

  function review(
    g: Partial<MarketReviewGates> = {},
    regime: MarketRegimeLabel = 'yellow',
  ): MarketReview {
    return {
      id: 'premarket-2024-06-04',
      kind: 'premarket',
      date: '2024-06-04',
      generatedAt: new Date(TRADING_TIME).toISOString(),
      regime,
      regimeRationale: 'test rationale',
      indexes: [],
      gates: gates(g),
      source: 'auto',
    };
  }

  describe('gateSignalOnReview / describeGatedStrategies — TRA-474 deprecation', () => {
    // TRA-389 / TRA-469 / TRA-472 originally let the premarket regime gate
    // suppress ORB signals and the dashboard report which legs were gated
    // off. TRA-474 removed that dependency on 2026-05-20 — a wrong report
    // could silently kill every ticket for the day. Both functions are
    // retained for ABI continuity, but the bodies are now no-ops. These
    // tests pin that contract so a future refactor can't re-introduce the
    // dependency accidentally.
    it('gateSignalOnReview returns null for every ORB gate configuration', () => {
      const cases: Partial<MarketReviewGates>[] = [
        {},
        { orbLongs: false },
        { orbShorts: false },
        { breakoutsEnabled: false },
        { orbLongs: false, orbShorts: false, breakoutsEnabled: false },
        { orbLongs: false, trendState: 'down' },
        { orbLongs: false, trendState: 'unknown' },
        { orbShorts: false, trendState: 'unknown' },
        { meanReversionTilt: false },
        { meanReversionTilt: true },
      ];
      for (const g of cases) {
        expect(gateSignalOnReview(sig({ side: 'buy' }), gates(g))).toBeNull();
        expect(gateSignalOnReview(sig({ side: 'sell' }), gates(g))).toBeNull();
      }
    });

    it('gateSignalOnReview returns null for non-ORB strategies regardless of gate state', () => {
      const g = gates({ orbLongs: false, orbShorts: false, breakoutsEnabled: false });
      expect(gateSignalOnReview(sig({ type: 'bb_fade', side: 'buy' }), g)).toBeNull();
      expect(gateSignalOnReview(sig({ type: 'bb_fade', side: 'sell' }), g)).toBeNull();
      expect(gateSignalOnReview(sig({ type: 'ichimoku', side: 'buy' }), g)).toBeNull();
    });

    it('describeGatedStrategies returns an empty list for every configuration', () => {
      const cases: Partial<MarketReviewGates>[] = [
        {},
        { orbLongs: false },
        { orbShorts: false },
        { breakoutsEnabled: false },
        { orbLongs: false, orbShorts: false, breakoutsEnabled: false },
        { orbLongs: false, trendState: 'down' },
        { orbLongs: false, trendState: 'unknown' },
      ];
      for (const g of cases) {
        expect(describeGatedStrategies(gates(g))).toEqual([]);
      }
    });
  });

  describe('sizeLiveEquityFromStop — sizingMultiplier path (TRA-389)', () => {
    const balance: TradierAccountBalance = {
      totalEquity: 25_000,
      totalCash: 10_000,
      optionBuyingPower: 10_000,
      stockBuyingPower: 20_000,
      longMarketValue: 15_000,
      dayTradeBuyingPower: null,
    };
    const base = {
      balance,
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      currentPrice: 100,
    };

    it('trims the share count by the multiplier and floors to whole shares', () => {
      // Un-trimmed qty is 25 (see TRA-335 suite). 0.5× → floor(12.5) = 12.
      expect(sizeLiveEquityFromStop(base)).toBe(25);
      expect(sizeLiveEquityFromStop({ ...base, sizeMultiplier: 0.5 })).toBe(12);
    });

    it('treats an absent / 1 / out-of-range multiplier as no trim', () => {
      expect(sizeLiveEquityFromStop({ ...base, sizeMultiplier: 1 })).toBe(25);
      expect(sizeLiveEquityFromStop({ ...base, sizeMultiplier: 0 })).toBe(25);
      expect(sizeLiveEquityFromStop({ ...base, sizeMultiplier: Number.NaN })).toBe(25);
    });
  });

  describe('PaperAccount.openPosition — sizingMultiplier path (TRA-389)', () => {
    it('scales the opened quantity by the multiplier', () => {
      const acct = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
      const full = acct.openPosition(sig(), 100);
      const acct2 = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
      const trimmed = acct2.openPosition(sig(), 100, 0.5);
      expect(full).not.toBeNull();
      expect(trimmed).not.toBeNull();
      expect(trimmed!.quantity).toBe(Math.floor(full!.quantity * 0.5));
    });

    it('multiplier of 1 leaves sizing unchanged', () => {
      const acct = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
      const a = acct.openPosition(sig(), 100);
      const acct2 = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
      const b = acct2.openPosition(sig(), 100, 1);
      expect(a!.quantity).toBe(b!.quantity);
    });
  });

  describe('PaperAccount.openPosition — bracket guard (TRA-520)', () => {
    const acct = () => new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });

    it('refuses a long with a negative stop (ASTC repro)', () => {
      expect(acct().openPosition(sig({ side: 'buy', stopLoss: -0.215, takeProfit: 148.93 }), 49.5)).toBeNull();
    });

    it('refuses a short with a negative target (PRFX repro)', () => {
      expect(acct().openPosition(sig({ side: 'sell', stopLoss: 4.64, takeProfit: -0.04 }), 3.05)).toBeNull();
    });

    it('refuses a long whose stop sits above the fill price', () => {
      // Bracket is fine vs the signal entry (95<100<110) but the actual fill
      // is below the stop — the guard validates against the fill price.
      expect(acct().openPosition(sig({ side: 'buy', stopLoss: 95, takeProfit: 110 }), 90)).toBeNull();
    });

    it('still opens a well-formed long', () => {
      expect(acct().openPosition(sig({ side: 'buy', stopLoss: 95, takeProfit: 110 }), 100)).not.toBeNull();
    });
  });

  describe('resolveMarketReviewGatesEnabled', () => {
    it('defaults off — absent or false both resolve false, only explicit true enables', () => {
      expect(resolveMarketReviewGatesEnabled(DEFAULT_ACCOUNT_SETTINGS)).toBe(false);
      expect(resolveMarketReviewGatesEnabled({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: undefined })).toBe(false);
      expect(resolveMarketReviewGatesEnabled({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: false })).toBe(false);
      expect(resolveMarketReviewGatesEnabled({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true })).toBe(true);
    });
  });

  describe('SignalEngine — flag plumbing + state envelope', () => {
    const flag = (e: SignalEngine) =>
      (e as unknown as { marketReviewGatesEnabled: boolean }).marketReviewGatesEnabled;

    it('constructs with the flag off by default and on when the setting is true', () => {
      expect(flag(new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS }))).toBe(false);
      expect(flag(new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true }))).toBe(true);
    });

    it('applySettings flips the flag and drops the cached review when turned off', async () => {
      const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true });
      // Seed a cached review as the doTick refresh would.
      (engine as unknown as { cachedMarketReview: MarketReview }).cachedMarketReview = review();
      await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: false });
      expect(flag(engine)).toBe(false);
      expect((engine as unknown as { cachedMarketReview: MarketReview | null }).cachedMarketReview).toBeNull();

      await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true });
      expect(flag(engine)).toBe(true);
    });

    it('getState surfaces a disabled envelope when the flag is off', () => {
      const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
      const mr = engine.getState().marketReview;
      expect(mr.enabled).toBe(false);
      expect(mr.regime).toBeNull();
      expect(mr.gatedStrategies).toEqual([]);
    });

    it('getState surfaces the regime context with no gated strategies once a review is cached', () => {
      // TRA-474 — the regime banner still renders for context (regime label,
      // rationale, raw gates), but `gatedStrategies` is now always empty
      // because the gate is no longer wired to the signal path.
      const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true });
      (engine as unknown as { cachedMarketReview: MarketReview }).cachedMarketReview =
        review({ orbLongs: false, sizingMultiplier: 0.75 }, 'yellow');
      const mr = engine.getState().marketReview;
      expect(mr.enabled).toBe(true);
      expect(mr.regime).toBe('yellow');
      expect(mr.reviewDate).toBe('2024-06-04');
      expect(mr.gates?.sizingMultiplier).toBe(0.75);
      expect(mr.gatedStrategies).toEqual([]);
    });

    it('activeSizingMultiplier is always 1 — TRA-474 removed the gate-driven trim', () => {
      // Pin the deprecation: even with the flag on AND a cached review
      // carrying a 0.5 sizingMultiplier, the engine sizes at 1.0× — sizing
      // is driven by managedAccountRatio / riskPerTrade only.
      const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, marketReviewGatesEnabled: true });
      const mult = () => (engine as unknown as { activeSizingMultiplier(): number }).activeSizingMultiplier();
      expect(mult()).toBe(1);
      (engine as unknown as { cachedMarketReview: MarketReview }).cachedMarketReview =
        review({ sizingMultiplier: 0.5 });
      expect(mult()).toBe(1);
    });
  });
});

// TRA-416 — partial-fill handling in the per-tick close reconciler. A
// `sell_to_close` that fills PART of its size then goes terminal (expire /
// cancel) must have the filled slice booked and the un-filled remainder
// re-ordered, end-to-end through `reconcilePendingCloses`.
describe('SignalEngine — TRA-416 partial-fill close reconciliation', () => {
  const OCC = 'AAPL240705C00200000';

  interface PartialClient {
    getOrderStatus: ReturnType<typeof vi.fn>;
    getOptionQuote: ReturnType<typeof vi.fn>;
    sellContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }
  interface PartialAcct {
    openOptionFromCandidate(sig: unknown, mode: 'live'): { id: string } | null;
    setPendingCloseOrderId(id: string, orderId: number): boolean;
    getState(): {
      openOptions: Array<{
        id: string;
        contracts: number;
        contractsRemaining: number;
        premiumPaid: number;
        pnl?: number;
        pendingCloseOrderId?: number | string;
        partialCloseBookedOrderId?: number | string;
      }>;
      closedOptions: Array<{ id: string; pnl?: number; currentPremium: number }>;
    };
  }
  type Internals = {
    tradierOptionsClientByEnv: Record<TradierEnv, unknown>;
    optionsAccounts: Record<TradierEnv, PartialAcct>;
  };

  function asInternals(engine: SignalEngine): Internals {
    return engine as unknown as Internals;
  }

  // Open an engine-opened live row, then normalise it to exactly 10 contracts
  // at $1.00 premium so a 60/40 partial split lands on whole numbers.
  function openTenContractRow(engine: SignalEngine, orderId: number): { acct: PartialAcct; optionId: string } {
    const acct = asInternals(engine).optionsAccounts.sandbox;
    const opened = acct.openOptionFromCandidate(
      {
        id: 'sig', symbol: 'AAPL', type: 'otm_mispricing', side: 'buy',
        entryPrice: 1.0, stopLoss: 0.75, takeProfit: 1.5, riskRewardRatio: 2,
        timestamp: TRADING_TIME, optionSymbol: OCC, optionType: 'call',
        strike: 200, expiration: '2024-07-05', mark: 1.0, theo: 1.3,
        mispricingPct: -0.23, delta: 0.18,
      },
      'live',
    );
    if (!opened) throw new Error('test setup: failed to open option');
    const row = acct.getState().openOptions.find((o) => o.id === opened.id)!;
    row.contracts = 10;
    row.contractsRemaining = 10;
    row.premiumPaid = 1.0;
    row.pnl = 0;
    acct.setPendingCloseOrderId(opened.id, orderId);
    return { acct, optionId: opened.id };
  }

  it('books a 60% partial fill, re-orders the 40% remainder, and P&L matches', async () => {
    const client: PartialClient = {
      // Order #700: filled 6 of 10 contracts at 1.50, then expired.
      getOrderStatus: vi.fn(async () => ({
        id: 700, status: 'expired', exec_quantity: 6, avg_fill_price: 1.50,
        reason_description: 'EOD expiration',
      })),
      getOptionQuote: vi.fn(async () => ({ symbol: OCC, bid: 1.0, ask: 1.2 })),
      sellContractsLimit: vi.fn(async () => ({ id: 800, status: 'ok' })),
      cancelOrder: vi.fn(async () => undefined),
      // Re-order #800 stays open inside the wait window → `pending` outcome.
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 800, status: 'open' })),
    };
    const engine = new SignalEngine();
    asInternals(engine).tradierOptionsClientByEnv = { sandbox: client, production: null };
    const { acct, optionId } = openTenContractRow(engine, 700);

    const summary = await engine.reconcilePendingCloses();

    // Slice booked = 1 fill; remainder re-ordered + still working = 1 pending.
    expect(summary.filled).toBe(1);
    expect(summary.stillPending).toBe(1);

    const row = acct.getState().openOptions.find((o) => o.id === optionId);
    expect(row).toBeDefined();
    // 60% closed → 40% (4 contracts) remain open.
    expect(row?.contractsRemaining).toBe(4);
    // Realised slice P&L = (1.50 − 1.00) × 6 × 100 = $300.
    expect(row?.pnl).toBeCloseTo(300, 5);
    // The terminal order id is stamped for the idempotency guard...
    expect(row?.partialCloseBookedOrderId).toBe(700);
    // ...and the remainder was re-ordered (new pending order #800).
    expect(row?.pendingCloseOrderId).toBe(800);
    // The re-submit was for the 4-contract remainder, not the original 10.
    expect(client.sellContractsLimit).toHaveBeenCalledWith(OCC, 4, expect.any(Number));
  });

  it('fully closes the position when the re-ordered remainder fills immediately', async () => {
    const client: PartialClient = {
      getOrderStatus: vi.fn(async () => ({
        id: 700, status: 'expired', exec_quantity: 6, avg_fill_price: 1.50,
      })),
      getOptionQuote: vi.fn(async () => ({ symbol: OCC, bid: 1.0, ask: 1.2 })),
      sellContractsLimit: vi.fn(async () => ({ id: 800, status: 'ok' })),
      cancelOrder: vi.fn(async () => undefined),
      // Re-order #800 fills at 1.10 inside the wait window.
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 800, status: 'filled', avg_fill_price: 1.10 })),
    };
    const engine = new SignalEngine();
    asInternals(engine).tradierOptionsClientByEnv = { sandbox: client, production: null };
    const { acct, optionId } = openTenContractRow(engine, 700);

    const summary = await engine.reconcilePendingCloses();

    // Slice fill + remainder fill = 2.
    expect(summary.filled).toBe(2);
    expect(acct.getState().openOptions.find((o) => o.id === optionId)).toBeUndefined();
    const closed = acct.getState().closedOptions.find((o) => o.id === optionId);
    expect(closed).toBeDefined();
    // Accumulated P&L = 300 (slice) + (1.10 − 1.00) × 4 × 100 = 300 + 40 = 340.
    expect(closed?.pnl).toBeCloseTo(340, 5);
  });

  it('leaves the reduced remainder OPEN for retry when the re-order finds no quote', async () => {
    const client: PartialClient = {
      getOrderStatus: vi.fn(async () => ({
        id: 700, status: 'canceled', exec_quantity: 6, avg_fill_price: 1.50,
      })),
      // Dead contract — no usable quote, so `submitSmartSellToClose` → no_quote.
      getOptionQuote: vi.fn(async () => ({ symbol: OCC, bid: 0, ask: 0, last: 0 })),
      sellContractsLimit: vi.fn(async () => ({ id: 800, status: 'ok' })),
      cancelOrder: vi.fn(async () => undefined),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 800, status: 'open' })),
    };
    const engine = new SignalEngine();
    asInternals(engine).tradierOptionsClientByEnv = { sandbox: client, production: null };
    const { acct, optionId } = openTenContractRow(engine, 700);

    const summary = await engine.reconcilePendingCloses();

    expect(summary.filled).toBe(1);
    expect(summary.cleared).toBe(1);
    const row = acct.getState().openOptions.find((o) => o.id === optionId);
    // Slice booked: 4 contracts remain, row open with the Close button back
    // (no pending marker) so the remainder can be re-closed.
    expect(row?.contractsRemaining).toBe(4);
    expect(row?.pnl).toBeCloseTo(300, 5);
    expect(row?.pendingCloseOrderId).toBeUndefined();
    expect(client.sellContractsLimit).not.toHaveBeenCalled();
  });

  it('does not re-book the slice when the sweep runs again before the re-order resolves', async () => {
    const client: PartialClient = {
      // #700 partial-expired; #800 (the re-order) still open on tick 2.
      getOrderStatus: vi.fn(async (id: number) =>
        id === 700
          ? { id: 700, status: 'expired', exec_quantity: 6, avg_fill_price: 1.50 }
          : { id: 800, status: 'open' },
      ),
      getOptionQuote: vi.fn(async () => ({ symbol: OCC, bid: 1.0, ask: 1.2 })),
      sellContractsLimit: vi.fn(async () => ({ id: 800, status: 'ok' })),
      cancelOrder: vi.fn(async () => undefined),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 800, status: 'open' })),
    };
    const engine = new SignalEngine();
    asInternals(engine).tradierOptionsClientByEnv = { sandbox: client, production: null };
    const { acct, optionId } = openTenContractRow(engine, 700);

    // Tick 1: partial fill booked, remainder re-ordered as #800.
    await engine.reconcilePendingCloses();
    // Tick 2: #800 still open — must not re-book the #700 slice.
    await engine.reconcilePendingCloses();

    const row = acct.getState().openOptions.find((o) => o.id === optionId);
    // P&L and contract count unchanged from the single slice booking.
    expect(row?.contractsRemaining).toBe(4);
    expect(row?.pnl).toBeCloseTo(300, 5);
    // The remainder was re-ordered exactly once across both sweeps.
    expect(client.sellContractsLimit).toHaveBeenCalledTimes(1);
  });
});

// TRA-495 — verify the stocks (Tradier equity) and options (Tradier options) routes
// both run on a live tick without either silently nulling the other. The board's
// $550 DCA flow needs both legs operational against one Tradier production account.
describe('SignalEngine — TRA-495 live stocks + options coexistence', () => {
  // TRA-1677 — the options leg of this coexistence check is the live RV long, so
  // it needs TRA-1491's dark flag armed; see the TRA-319 block.
  beforeEach(() => {
    process.env[RV_ENGINE_FLAG] = '1'; // TRA-4385 — the arm now also requires a live producer
    process.env[OPTION_LIVE_RV_LONG_FLAG] = '1';
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = FAR_FUTURE_TEST_UNTIL; // TRA-1929 window open
    // TRA-4692 — fresh hard-controls sandbox: both legs of this coexistence
    // check now pass the TRA-4650 choke point (option seam + equity seam), and
    // its idempotency ledger is disk-persisted across runs.
    __resetHardControlsForTest({ dataDir: mkdtempSync(join(tmpdir(), 'se-hard-controls-')) });
  });
  afterEach(() => {
    delete process.env[RV_ENGINE_FLAG];
    delete process.env[OPTION_LIVE_RV_LONG_FLAG];
    delete process.env[OPTION_LIVE_TEST_UNTIL_VAR];
  });

  type WaitOpts = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };

  interface OptionsTradierStub {
    getOptionQuote: ReturnType<typeof vi.fn>;
    buyContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }

  interface EquityTradierStub {
    submitBracketOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
    cancelOrder?: ReturnType<typeof vi.fn>;
  }

  function buildEngine(scanner: StubScanner): SignalEngine {
    const engine = new SignalEngine({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      stocksAutoTradingEnabledLive: true,
      liveTradeEquitiesTradier: true,
      liveTradierMarkets: 'both',
      // TRA-499 — board directive on TRA-494: stock signals also route to
      // Tradier production. Flipping this in the test asserts the unified
      // single-broker config still drives both legs (stocks + options)
      // through Tradier without one path nulling the other.
      liveBrokerageTypeStocks: 'tradier',
      liveTradierEnvOptions: 'production',
      managedAccountRatio: 0.5,
      riskPerTrade: 0.01,
    }, undefined, scanner);
    seedRvTrend(engine); // TRA-968 — the RV long now needs a confirmed daily uptrend to fire
    return engine;
  }

  function freshScanner(mark = 1.0): StubScanner {
    const scanner = new StubScanner();
    scanner.scan.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeCandidate({ mark })],
      reason: 'ok',
    });
    return scanner;
  }

  it('runs both routes on the same engine: RV opens an option and the equity bracket places a stock order', async () => {
    const optionsStub: OptionsTradierStub = {
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'AAPL240705C00200000', bid: 0.95, ask: 1.05 }),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 71, status: 'ok' }),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _o?: WaitOpts) => ({
        id: 71, status: 'filled', avg_fill_price: 1.0,
      })),
    };
    const equityStub: EquityTradierStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 42, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async (_id: number, _o?: WaitOpts) => ({
        id: 42, status: 'filled', exec_quantity: 25, avg_fill_price: 10,
      })),
    };

    const scanner = freshScanner(1.0);
    const engine = buildEngine(scanner);
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = optionsStub;
    (engine as unknown as { tradierLiveEquityClient: unknown }).tradierLiveEquityClient = equityStub;
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance = {
      totalEquity: 25_000,
      totalCash: 10_000,
      optionBuyingPower: 10_000,
      stockBuyingPower: 20_000,
      longMarketValue: 15_000,
      dayTradeBuyingPower: null,
    };

    // ── 1) Options leg: RV scanner fires an open. ─────────────────────────
    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);

    // ── 2) Equity leg: BB-fade signal places an OTOCO bracket. ────────────
    // TRA-4692 — sized under the $300 per-trade hard cap (TRA-4650): qty 25
    // at a $10 entry is $250 notional; the old $100 entry sized to $2,500.
    const sig: TradeSignal = {
      id: 'sig-stock-1',
      symbol: 'AAPL',
      type: 'bb_fade',
      side: 'buy',
      entryPrice: 10,
      stopLoss: 5,
      takeProfit: 20,
      riskRewardRatio: 2,
      timestamp: Date.now(),
    };
    const placement = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number | string; reason?: string }>;
    }).placeTradierEquityBracket(sig, 10);
    expect(placement.ok).toBe(true);
    expect(equityStub.submitBracketOrder).toHaveBeenCalledTimes(1);

    // Seed the live equity mirror so the dashboard's live bucket reflects the
    // open position. This is what runTick does immediately after a successful
    // bracket placement.
    (engine as unknown as {
      openLiveEquityMirror: (s: TradeSignal, p: number, oid: number | string) => { id: string } | null;
    }).openLiveEquityMirror(sig, 10, placement.orderId!);

    // ── 3) Both routes succeeded WITHOUT one silently nulling the other. ──
    expect(optionsStub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(equityStub.submitBracketOrder).toHaveBeenCalledTimes(1);

    const state = engine.getState();
    // Live bucket carries BOTH the option position AND the stock position.
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0].optionSymbol).toBe('AAPL240705C00200000');
    expect(state.account.openPositions).toHaveLength(1);
    expect(state.account.openPositions[0].symbol).toBe('AAPL');
    // Both signals surfaced.
    expect(state.signals.find(s => s.type === 'relative_value')).toBeDefined();
  });

  it('getStateForMode(live) returns both stock and option positions in the live bucket', async () => {
    // Same setup as the previous test, condensed to verify the per-mode state
    // accessor doesn't drop one path on its way out of the engine.
    const optionsStub: OptionsTradierStub = {
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'AAPL240705C00200000', bid: 0.95, ask: 1.05 }),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 71, status: 'ok' }),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 71, status: 'filled', avg_fill_price: 1.0 })),
    };
    const equityStub: EquityTradierStub = {
      submitBracketOrder: vi.fn().mockResolvedValue({ id: 42, status: 'ok' }),
      waitForOrderTerminalStatus: vi.fn(async () => ({
        id: 42, status: 'filled', exec_quantity: 25, avg_fill_price: 10,
      })),
    };
    const engine = buildEngine(freshScanner(1.0));
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = optionsStub;
    (engine as unknown as { tradierLiveEquityClient: unknown }).tradierLiveEquityClient = equityStub;
    (engine as unknown as { liveTradierBalance: TradierAccountBalance }).liveTradierBalance = {
      totalEquity: 25_000, totalCash: 10_000, optionBuyingPower: 10_000,
      stockBuyingPower: 20_000, longMarketValue: 15_000, dayTradeBuyingPower: null,
    };

    await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
    // TRA-4692 — under the $300 hard cap ($10 × qty 25 = $250), fresh signal id.
    const sig: TradeSignal = {
      id: 'sig-stock-2', symbol: 'AAPL', type: 'bb_fade', side: 'buy',
      entryPrice: 10, stopLoss: 5, takeProfit: 20, riskRewardRatio: 2, timestamp: Date.now(),
    };
    const placement = await (engine as unknown as {
      placeTradierEquityBracket: (s: TradeSignal, p: number) => Promise<{ ok: boolean; orderId?: number | string }>;
    }).placeTradierEquityBracket(sig, 10);
    // The bracket must genuinely place — a refused placement with the mirror
    // opened anyway would keep this test green while the live path is dark.
    expect(placement.ok).toBe(true);
    (engine as unknown as {
      openLiveEquityMirror: (s: TradeSignal, p: number, oid: number | string) => { id: string } | null;
    }).openLiveEquityMirror(sig, 10, placement.orderId!);

    const live = engine.getState();
    expect(live.options.openOptions.length).toBeGreaterThan(0);
    expect(live.account.openPositions.length).toBeGreaterThan(0);
  });
});

// TRA-544 (TRA-529 §2B) — the "Trading Agents" decision-path switch. ON makes
// the multi-agent layer the active decision-maker and SUSPENDS the
// deterministic auto-router; the per-mode start/stop preference is left intact
// so the UI still reports it. Reconciled from persisted settings on apply.
describe('SignalEngine — Trading Agents decision-path switch (TRA-544)', () => {
  it('defaults off: deterministic routing is active, agents path is not', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    expect(engine.isTradingAgentsEnabled()).toBe(false);
    // Auto-trading defaults on in demo → deterministic router may route.
    expect(engine.isDeterministicAutoTradingEnabled()).toBe(true);
    expect(engine.getState().tradingAgentsEnabled).toBe(false);
    expect(engine.getState().agentRecommendations).toEqual([]);
  });

  it('ON suspends the deterministic router while keeping auto-trading reported', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', tradingAgentsEnabled: true });
    expect(engine.isTradingAgentsEnabled()).toBe(true);
    // Deterministic auto-routing is suspended (never both deciding at once)…
    expect(engine.isDeterministicAutoTradingEnabled()).toBe(false);
    // …but the operator's start/stop preference is unchanged for the UI.
    expect(engine.isAutoTradingEnabled()).toBe(true);
    expect(engine.getState().tradingAgentsEnabled).toBe(true);
  });

  it('setTradingAgents flips the live runtime switch both ways', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    engine.setTradingAgents(true);
    expect(engine.isTradingAgentsEnabled()).toBe(true);
    expect(engine.isDeterministicAutoTradingEnabled()).toBe(false);
    engine.setTradingAgents(false);
    expect(engine.isTradingAgentsEnabled()).toBe(false);
    expect(engine.isDeterministicAutoTradingEnabled()).toBe(true);
  });
});

describe('SignalEngine.enterPaperOptionsIdea — single vs multi-leg routing (TRA-613)', () => {
  // Anchor contract ~31 DTE from the pinned Tuesday so the C3 entry-DTE floor
  // passes on both branches.
  const baseIntent = {
    ticker: 'AAPL',
    optionSymbol: 'AAPL240705P00095000',
    optionType: 'put' as const,
    strike: 95,
    expiration: '2024-07-05',
    mark: 1.5,
    delta: -0.3,
    spot: 100,
  };

  function demoEngine(): SignalEngine {
    // Default settings → demo mode, sandbox env. enterPaperOptionsIdea opens on
    // the sandbox bucket in demo mode, which getState() (demo) surfaces.
    return new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', liveTradierEnvOptions: 'sandbox' });
  }

  it('routes a multi-leg idea to a single defined-risk spread combo position', () => {
    const engine = demoEngine();
    const pos = engine.enterPaperOptionsIdea({
      ...baseIntent,
      strategy: 'bull_put_spread',
      legs: [
        { action: 'sell', optionType: 'put', strike: 95, expiration: '2024-07-05' },
        { action: 'buy', optionType: 'put', strike: 90, expiration: '2024-07-05' },
      ],
      netUsd: 180,
      maxLossUsd: 320,
      maxProfitUsd: 180,
      breakevens: [93.2],
    });

    expect(pos).not.toBeNull();
    expect(pos!.legs).toHaveLength(2);
    expect(pos!.spreadStrategy).toBe('bull_put_spread');
    expect(pos!.optionSymbol).toContain('COMBO:AAPL:bull_put_spread');
    expect(pos!.maxLossUsd).toBe(320);

    const open = engine.getState().options.openOptions;
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(pos!.id);
  });

  it('routes a single-leg idea through the long-only RV open path (anchor OCC)', () => {
    const engine = demoEngine();
    // No `legs` (or a 1-leg structure) ⇒ legacy single-leg long path.
    const pos = engine.enterPaperOptionsIdea({ ...baseIntent });

    expect(pos).not.toBeNull();
    expect(pos!.optionSymbol).toBe('AAPL240705P00095000');
    expect(pos!.legs).toBeUndefined();
  });
});

// TRA-1140 — an accepted AI Idea routes onto the SHARED proposal/execution rail
// (typed `options` proposal → shared execution gate → paper open) instead of the
// bespoke direct open. Same fake-clock pin (TRADING_TIME) so the C3 DTE floor
// passes; the proposal store is process-global so we reset it per test.
describe('SignalEngine.enterOptionsIdeaViaProposal — shared proposal rail (TRA-1140)', () => {
  const baseIntent = {
    ticker: 'AAPL',
    optionSymbol: 'AAPL240705P00095000',
    optionType: 'put' as const,
    strike: 95,
    expiration: '2024-07-05',
    mark: 1.5,
    delta: -0.3,
    spot: 100,
    strategy: 'long_put',
    legs: [] as { action: 'buy' | 'sell'; optionType: 'call' | 'put'; strike: number; expiration: string }[],
    netUsd: -150,
    maxLossUsd: 150,
    maxProfitUsd: 400,
    breakevens: [93.5],
    pop: 0.55,
    ideaId: 'live-aapl-long_put-1',
  };

  function demoEngine(): SignalEngine {
    return new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', liveTradierEnvOptions: 'sandbox' });
  }

  beforeEach(() => resetProposalStoreForTests());

  it('queues an options proposal and opens it through the shared gate when the kill-switch is clear', async () => {
    const engine = demoEngine();
    engine.setTradingAgents(true); // banner kill-switch clear (shared gate requirement)

    const result = await engine.enterOptionsIdeaViaProposal({ ...baseIntent });

    expect(result.ok).toBe(true);
    expect(result.position).not.toBeNull();
    expect(result.proposalId).toContain('prop-live-aapl-long_put-1');
    // The proposal it created is marked executed (not left pending).
    expect(getProposal(result.proposalId)?.status).toBe('executed');
    expect(getProposal(result.proposalId)?.kind).toBe('options');
    // And the paper book actually holds the opened position.
    const open = engine.getState().options.openOptions;
    expect(open.some(o => o.id === result.position!.id)).toBe(true);
  });

  it('leaves the proposal PENDING with the kill-switch reason when the banner toggle is OFF', async () => {
    const engine = demoEngine();
    engine.setTradingAgents(false); // banner OFF → shared kill-switch blocks execution

    const result = await engine.enterOptionsIdeaViaProposal({ ...baseIntent });

    expect(result.ok).toBe(false);
    expect(result.position).toBeNull();
    expect(result.reason).toContain('banner toggle is OFF');
    // Order is never silently dropped: the proposal is still pending in the queue.
    expect(getProposal(result.proposalId)?.status).toBe('pending');
    expect(listProposals({ status: 'pending' }).some(p => p.id === result.proposalId)).toBe(true);
    // Nothing opened.
    expect(engine.getState().options.openOptions).toHaveLength(0);
  });

  it('does not double-open on a re-click after the idea already filled', async () => {
    const engine = demoEngine();
    engine.setTradingAgents(true);

    const first = await engine.enterOptionsIdeaViaProposal({ ...baseIntent });
    const second = await engine.enterOptionsIdeaViaProposal({ ...baseIntent });

    expect(first.ok).toBe(true);
    // The paper book's own already-open guard refuses the second open, so the
    // re-click never double-opens (the meaningful safety guarantee).
    expect(second.ok).toBe(false);
    expect(engine.getState().options.openOptions).toHaveLength(1);
  });

  it('dedupes concurrent pending duplicates before either resolves (store idempotency)', async () => {
    const engine = demoEngine();
    engine.setTradingAgents(false); // block at the gate so the first stays PENDING

    const first = await engine.enterOptionsIdeaViaProposal({ ...baseIntent });
    const second = await engine.enterOptionsIdeaViaProposal({ ...baseIntent });

    // Both blocked + pending → the store returns the SAME pending proposal, so a
    // rapid double-click queues exactly one.
    expect(first.proposalId).toBe(second.proposalId);
    expect(listProposals({ status: 'pending' }).filter(p => p.kind === 'options')).toHaveLength(1);
  });
});

// TRA-1103 — the AI-ideas demo open paths now pass a `journalSetup` so the
// high-volume fills actually land in the option-trade journal (root cause of
// `option-journal total=0` on bqb1: only the Phase-B spread path journalled).
// The RV single-leg scan call site (signal-engine.ts:~3359) is structurally
// identical — same `openOptionFromRvCandidate(..., journalSetup)` call with the
// same honest-unknown `ivRank: null` — and the account-side emit is covered by
// options-account-journal.test.ts; here we lock the engine wiring end-to-end.
describe('SignalEngine.enterPaperOptionsIdea — option-trade journal wiring (TRA-1103)', () => {
  const baseIntent = {
    ticker: 'AAPL',
    optionSymbol: 'AAPL240705C00105000',
    optionType: 'call' as const,
    strike: 105,
    expiration: '2024-07-05',
    mark: 1.5,
    delta: 0.32,
    spot: 100,
  };
  const spreadIntent = {
    ...baseIntent,
    optionSymbol: 'AAPL240705P00095000',
    optionType: 'put' as const,
    strike: 95,
    strategy: 'bull_put_spread',
    legs: [
      { action: 'sell' as const, optionType: 'put' as const, strike: 95, expiration: '2024-07-05' },
      { action: 'buy' as const, optionType: 'put' as const, strike: 94, expiration: '2024-07-05' },
    ],
    // Per-lot max loss kept under the demo book's ~1%-of-equity per-trade cap
    // (~$250 on the default $25k managed book) so the spread actually opens and
    // we can assert it journalled — the wiring under test, not the sizing gate.
    netUsd: 60,
    maxLossUsd: 40,
    maxProfitUsd: 60,
    breakevens: [94.4],
  };

  let journalFile: string;
  let counter = 0;

  beforeEach(() => {
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    journalFile = join(tmpdir(), `tra1103-journal-${process.pid}-${counter++}.jsonl`);
    setOptionTradeJournalFileForTests(journalFile);
  });
  afterEach(() => {
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    rmSync(journalFile, { force: true });
  });

  function demoEngine(): SignalEngine {
    return new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo', liveTradierEnvOptions: 'sandbox' });
  }

  it('single-leg AI idea writes exactly one OPEN row then a folded CLOSE (flag on)', async () => {
    const engine = demoEngine();
    const pos = engine.enterPaperOptionsIdea({ ...baseIntent });
    expect(pos).not.toBeNull();
    await engine.flushOptionTradeJournal();

    let rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(pos!.id);
    // TRA-2245 — AI-Options-Ideas single-leg is a directional entry: `single_leg_directional`.
    expect(rows[0]!.structure).toBe('single_leg_directional');
    expect(rows[0]!.outcome).toBe('OPEN');
    expect(rows[0]!.ivRank).toBeNull(); // TRA-1103 honest-unknown (no per-tick chain fetch)
    expect(rows[0]!.trend).toBe('up'); // call ⇒ up
    expect(rows[0]!.entryDelta).toBeCloseTo(0.32, 5);

    // Round-trip → the close folds onto the same id (proves summary.closed > 0).
    engine.manualCloseOption(pos!.id, 3.0);
    await engine.flushOptionTradeJournal();
    rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).not.toBe('OPEN');
    expect(rows[0]!.closeTs).toBeDefined();
  });

  it('multi-leg AI idea writes one OPEN row with the canonical spread structure (flag on)', async () => {
    const engine = demoEngine();
    const pos = engine.enterPaperOptionsIdea({ ...spreadIntent });
    expect(pos).not.toBeNull();
    await engine.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.structure).toBe('bull_put'); // canonicalised from bull_put_spread
    expect(rows[0]!.trend).toBe('up'); // bull strategy ⇒ up
    expect(rows[0]!.ivRank).toBeNull();
  });

  it('writes nothing when the journal flag is off', async () => {
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    const engine = demoEngine();
    const pos = engine.enterPaperOptionsIdea({ ...baseIntent });
    expect(pos).not.toBeNull();
    engine.manualCloseOption(pos!.id, 3.0);
    await engine.flushOptionTradeJournal();
    expect(await listOptionTradeJournal()).toHaveLength(0);
  });
});

describe('shouldBootArmLiveEquity — TRA-713 persistent live-equity boot-arm', () => {
  const PIN = 'admin';
  // A production-ready settings snapshot: production options env + per-user prod creds.
  const prodSettings = (): AccountSettings => ({
    ...DEFAULT_ACCOUNT_SETTINGS,
    mode: 'demo',
    liveTradierEnvOptions: 'production',
    liveApiKeyOptionsProduction: 'tok-123',
    liveAccountIdOptionsProduction: 'acct-123',
  });
  const prodEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    LIVE_EQUITY_BOOT_USER: PIN,
    TRADIER_ENV: 'production',
    ...over,
  });

  it('arms the pinned user when prod env + prod creds resolve', () => {
    expect(shouldBootArmLiveEquity(prodSettings(), PIN, prodEnv())).toBe(true);
  });

  it('arms via server-env Tradier cred fallback when per-user creds are blank', () => {
    const s = { ...prodSettings(), liveApiKeyOptionsProduction: '', liveAccountIdOptionsProduction: '' };
    const env = prodEnv({ TRADIER_API_TOKEN: 'env-tok', TRADIER_ACCOUNT_ID: 'env-acct' });
    expect(shouldBootArmLiveEquity(s, PIN, env)).toBe(true);
  });

  it('never arms a non-pinned user (shared-account blast-radius guard)', () => {
    expect(shouldBootArmLiveEquity(prodSettings(), 'someone-else', prodEnv())).toBe(false);
  });

  it('TRA-716: unset pin ⇒ falls back to committed default "admin" and arms (Blueprint-sync-free activation)', () => {
    const env = prodEnv(); delete env['LIVE_EQUITY_BOOT_USER'];
    expect(shouldBootArmLiveEquity(prodSettings(), 'admin', env)).toBe(true);
  });

  it('TRA-716: unset pin ⇒ default only arms "admin", never another user', () => {
    const env = prodEnv(); delete env['LIVE_EQUITY_BOOT_USER'];
    expect(shouldBootArmLiveEquity(prodSettings(), 'someone-else', env)).toBe(false);
  });

  it('TRA-716: explicitly empty pin ⇒ disarms (clear-this-value kill-switch preserved)', () => {
    expect(shouldBootArmLiveEquity(prodSettings(), PIN, prodEnv({ LIVE_EQUITY_BOOT_USER: '' }))).toBe(false);
  });

  it('refuses to arm when the server is not in production Tradier mode', () => {
    expect(shouldBootArmLiveEquity(prodSettings(), PIN, prodEnv({ TRADIER_ENV: 'sandbox' }))).toBe(false);
  });

  it('TRA-1411: arms even when the persisted env still reads sandbox, when service is prod + prod creds resolve', () => {
    // The persisted `liveTradierEnvOptions` can only be flipped via an admin-authed
    // settings PUT (unreachable on redeploy-only bqb1). Prod intent must therefore come
    // from the SERVICE-level TRADIER_ENV, not the stale per-account setting — otherwise
    // the board-ratified arm is permanently inert. Per-user production creds still resolve.
    const s = { ...prodSettings(), liveTradierEnvOptions: 'sandbox' as const };
    expect(shouldBootArmLiveEquity(s, PIN, prodEnv())).toBe(true);
  });

  it('TRA-1411: arms a sandbox-persisted operator via the server-env prod cred fallback', () => {
    const s = {
      ...prodSettings(),
      liveTradierEnvOptions: 'sandbox' as const,
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
    };
    const env = prodEnv({ TRADIER_API_TOKEN: 'env-tok', TRADIER_ACCOUNT_ID: 'env-acct' });
    expect(shouldBootArmLiveEquity(s, PIN, env)).toBe(true);
  });

  it('refuses to arm when no production creds resolve anywhere', () => {
    const s = { ...prodSettings(), liveApiKeyOptionsProduction: '', liveAccountIdOptionsProduction: '' };
    expect(shouldBootArmLiveEquity(s, PIN, prodEnv())).toBe(false);
  });

  it('TRA-1482: overrides a persisted liveTradeEquitiesTradier:false opt-out (un-durable per-account toggle)', () => {
    // The persisted `liveTradeEquitiesTradier` opt-out is only settable via an admin-authed
    // settings PUT (unreachable on redeploy-only bqb1). Gating the arm on it regressed the
    // board-ratified boot-arm on the aabcfc8a redeploy (liveEquityClientConfigured:false /
    // 132 skipped live signals) — the same un-durable class TRA-1411 removed for
    // `liveTradierEnvOptions`. The arm now derives purely from the service env, and the
    // boot-arm block force-persists the toggle true. The durable kill-switch is the empty pin.
    const s = { ...prodSettings(), liveTradeEquitiesTradier: false };
    expect(shouldBootArmLiveEquity(s, PIN, prodEnv())).toBe(true);
  });

  it('TRA-1482: arms the exact aabcfc8a bqb1 regression shape (unset pin + env-only creds + demo + opt-out)', () => {
    // Reproduces the live regression: LIVE_EQUITY_BOOT_USER unset (bootArmPinConfigured:false
    // → default "admin"), no per-user creds (server-env TRADIER_* fallback only), operator
    // persisted mode:'demo' with liveTradeEquitiesTradier:false. Pre-TRA-1482 this returned
    // false and the arm stayed inert across every redeploy.
    const s: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      liveTradeEquitiesTradier: false,
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
    };
    const env = prodEnv({ TRADIER_API_TOKEN: 'env-tok', TRADIER_ACCOUNT_ID: 'env-acct' });
    delete env['LIVE_EQUITY_BOOT_USER'];
    expect(shouldBootArmLiveEquity(s, 'admin', env)).toBe(true);
  });
});

describe('resolveLiveBrokerArmDrift — TRA-1652 self-healing boot-arm convergence', () => {
  const PIN = 'admin';
  const prodEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    LIVE_EQUITY_BOOT_USER: PIN,
    TRADIER_ENV: 'production',
    TRADIER_API_TOKEN: 'env-tok',
    TRADIER_ACCOUNT_ID: 'env-acct',
    ...over,
  });
  /** The fully-converged operator: nothing left to repair. */
  const armedSettings = (): AccountSettings => ({
    ...DEFAULT_ACCOUNT_SETTINGS,
    mode: 'live',
    liveTradierEnvOptions: 'production',
    liveTradeEquitiesTradier: true,
  });

  it('reports NO drift once the operator is fully converged (idempotent — a steady-state boot re-persists nothing)', () => {
    expect(resolveLiveBrokerArmDrift(armedSettings(), PIN, prodEnv())).toEqual([]);
  });

  it('TRA-1652 REGRESSION: repairs a sandbox-drifted env even though mode is ALREADY live', () => {
    // The exact bqb1 pre-open blocker. The operator is already `mode:'live'` (persisted by
    // an earlier boot), but `liveTradierEnvOptions` has drifted back to 'sandbox'. The old
    // `settings.mode !== 'live'` latch skipped the whole boot-arm block here, so the env
    // selector could never be repaired: /api/health/options-live reported
    // optionsBrokerEnv:'sandbox', optionsBrokerConfigured:false, and the SANDBOX account
    // tail ***6703 instead of the signed-off production ***0154 — routing the board's
    // attended <=$100 options canary into the Tradier sandbox.
    const drifted: AccountSettings = { ...armedSettings(), liveTradierEnvOptions: 'sandbox' };
    expect(resolveLiveBrokerArmDrift(drifted, PIN, prodEnv())).toEqual(['liveTradierEnvOptions']);
  });

  it('TRA-1652: repairs a liveTradeEquitiesTradier:false opt-out that drifted in while already live', () => {
    const drifted: AccountSettings = { ...armedSettings(), liveTradeEquitiesTradier: false };
    expect(resolveLiveBrokerArmDrift(drifted, PIN, prodEnv())).toEqual(['liveTradeEquitiesTradier']);
  });

  it('TRA-1652: an absent liveTradeEquitiesTradier is NOT drift (TRA-370 absent ⇔ true)', () => {
    const s = { ...armedSettings() };
    delete (s as Partial<AccountSettings>).liveTradeEquitiesTradier;
    expect(resolveLiveBrokerArmDrift(s, PIN, prodEnv())).toEqual([]);
  });

  it('reports all three fields on a cold demo operator (the original TRA-713 first-boot arm)', () => {
    const cold: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      liveTradierEnvOptions: 'sandbox',
      liveTradeEquitiesTradier: false,
    };
    expect(resolveLiveBrokerArmDrift(cold, PIN, prodEnv()))
      .toEqual(['mode', 'liveTradierEnvOptions', 'liveTradeEquitiesTradier']);
  });

  it('never repairs a non-pinned user, however drifted (shared-account blast-radius guard)', () => {
    const drifted: AccountSettings = { ...armedSettings(), liveTradierEnvOptions: 'sandbox' };
    expect(resolveLiveBrokerArmDrift(drifted, 'someone-else', prodEnv())).toEqual([]);
  });

  it('never repairs on a non-production service (a sandbox deploy stays sandbox)', () => {
    const drifted: AccountSettings = { ...armedSettings(), liveTradierEnvOptions: 'sandbox' };
    expect(resolveLiveBrokerArmDrift(drifted, PIN, prodEnv({ TRADIER_ENV: 'sandbox' }))).toEqual([]);
  });

  it('the empty-pin kill-switch still disarms the repair entirely', () => {
    const drifted: AccountSettings = { ...armedSettings(), liveTradierEnvOptions: 'sandbox' };
    expect(resolveLiveBrokerArmDrift(drifted, PIN, prodEnv({ LIVE_EQUITY_BOOT_USER: '' }))).toEqual([]);
  });

  it('never repairs when no production creds resolve anywhere (never arm with no broker attached)', () => {
    const drifted: AccountSettings = { ...armedSettings(), liveTradierEnvOptions: 'sandbox' };
    const env = prodEnv();
    delete env['TRADIER_API_TOKEN'];
    delete env['TRADIER_ACCOUNT_ID'];
    expect(resolveLiveBrokerArmDrift(drifted, PIN, env)).toEqual([]);
  });

  // ── TRA-2649 — the same repair, now runnable on the settings WRITE path ──────
  //
  // The defect: TRA-1652's convergence loop only ever ran inside `createUserContext`,
  // i.e. once per boot. Between boots a settings write carrying `mode:'demo'` demoted
  // the pinned operator and NOTHING repaired it until the next redeploy. Measured on
  // bqb1 2026-07-30: the boot-arm converged at 05:38:26Z (persist logged OK) and
  // request-scoped writes demoted `mode` at 04:49:18Z and 12:36:25Z, leaving
  // `bootArmEligible:true` + `bootArmDrift:["mode"]` + `optionsBrokerConfigured:false`.
  describe('applyLiveBrokerArm — TRA-2649 write-path enforcement', () => {
    it('repairs a post-boot demotion of `mode` — the exact bqb1 regression', () => {
      const demoted: AccountSettings = { ...armedSettings(), mode: 'demo' };
      expect(applyLiveBrokerArm(demoted, PIN, prodEnv())).toEqual(['mode']);
      expect(demoted.mode).toBe('live');
    });

    it('repairs all three fields together and reports every one it touched', () => {
      const cold: AccountSettings = {
        ...DEFAULT_ACCOUNT_SETTINGS,
        mode: 'demo',
        liveTradierEnvOptions: 'sandbox',
        liveTradeEquitiesTradier: false,
      };
      expect(applyLiveBrokerArm(cold, PIN, prodEnv()))
        .toEqual(['mode', 'liveTradierEnvOptions', 'liveTradeEquitiesTradier']);
      expect(cold.mode).toBe('live');
      expect(cold.liveTradierEnvOptions).toBe('production');
      expect(cold.liveTradeEquitiesTradier).toBe(true);
    });

    it('is a NO-OP on an already-converged operator (idempotent — never rewrites a clean row)', () => {
      const armed = armedSettings();
      expect(applyLiveBrokerArm(armed, PIN, prodEnv())).toEqual([]);
      expect(armed).toEqual(armedSettings());
    });

    // The scope guards. These are what keep the write-path repair from being a
    // fleet-wide real-money arm: it must leave every non-operator settings write,
    // every sandbox service, and the documented kill-switch completely untouched.
    it('leaves a NON-OPERATOR settings write completely alone (no fleet-wide arm)', () => {
      const demoted: AccountSettings = { ...armedSettings(), mode: 'demo' };
      expect(applyLiveBrokerArm(demoted, 'someone-else', prodEnv())).toEqual([]);
      expect(demoted.mode).toBe('demo');
    });

    it('leaves a SANDBOX service alone (TRADIER_ENV must be production)', () => {
      const demoted: AccountSettings = { ...armedSettings(), mode: 'demo' };
      expect(applyLiveBrokerArm(demoted, PIN, prodEnv({ TRADIER_ENV: 'sandbox' }))).toEqual([]);
      expect(demoted.mode).toBe('demo');
    });

    it('the empty-pin kill-switch still wins — it stays the supported de-escalation path', () => {
      const demoted: AccountSettings = { ...armedSettings(), mode: 'demo' };
      expect(applyLiveBrokerArm(demoted, PIN, prodEnv({ LIVE_EQUITY_BOOT_USER: '' }))).toEqual([]);
      expect(demoted.mode).toBe('demo');
    });

    it('never arms with no broker attached (no resolvable production creds)', () => {
      const demoted: AccountSettings = { ...armedSettings(), mode: 'demo' };
      const env = prodEnv();
      delete env['TRADIER_API_TOKEN'];
      delete env['TRADIER_ACCOUNT_ID'];
      expect(applyLiveBrokerArm(demoted, PIN, env)).toEqual([]);
      expect(demoted.mode).toBe('demo');
    });

    it('agrees with resolveLiveBrokerArmDrift on every input (one predicate, two callers)', () => {
      for (const over of [
        { mode: 'demo' as const },
        { liveTradierEnvOptions: 'sandbox' as const },
        { liveTradeEquitiesTradier: false },
        {},
      ]) {
        const a: AccountSettings = { ...armedSettings(), ...over };
        const b: AccountSettings = { ...armedSettings(), ...over };
        expect(applyLiveBrokerArm(a, PIN, prodEnv()))
          .toEqual(resolveLiveBrokerArmDrift(b, PIN, prodEnv()));
      }
    });
  });
});

describe('isLiveBrokerOperator — TRA-857 shared-env operator pin', () => {
  it('matches the pinned operator', () => {
    expect(isLiveBrokerOperator('admin', { LIVE_EQUITY_BOOT_USER: 'admin' })).toBe(true);
  });

  it('rejects every non-pinned user (multi-tenant leak guard)', () => {
    expect(isLiveBrokerOperator('alice', { LIVE_EQUITY_BOOT_USER: 'admin' })).toBe(false);
  });

  it('rejects undefined / empty username', () => {
    expect(isLiveBrokerOperator(undefined, { LIVE_EQUITY_BOOT_USER: 'admin' })).toBe(false);
    expect(isLiveBrokerOperator('', { LIVE_EQUITY_BOOT_USER: 'admin' })).toBe(false);
  });

  it('unset pin ⇒ falls back to the committed "admin" default', () => {
    expect(isLiveBrokerOperator('admin', {})).toBe(true);
    expect(isLiveBrokerOperator('alice', {})).toBe(false);
    expect(resolveLiveBrokerOperator({})).toBe('admin');
  });

  it('explicitly empty pin ⇒ disarms for everyone (no operator)', () => {
    expect(isLiveBrokerOperator('admin', { LIVE_EQUITY_BOOT_USER: '' })).toBe(false);
    expect(resolveLiveBrokerOperator({ LIVE_EQUITY_BOOT_USER: '' })).toBe('');
  });
});

describe('buildTradierLiveEquityClient — TRA-857 operator-scoped env fallback', () => {
  // A live user with NO per-user Tradier creds (the fresh-signup case). The only
  // creds available are the shared server-env TRADIER_* values.
  const envOnlyLiveSettings = (): AccountSettings => ({
    ...DEFAULT_ACCOUNT_SETTINGS,
    mode: 'live',
    liveTradeEquitiesTradier: true,
    liveTradierEnvOptions: 'production',
    // no liveApiKeyOptionsProduction / liveAccountIdOptionsProduction
  });
  const readEquityClient = (e: SignalEngine): TradierOrderClient | null =>
    (e as unknown as { tradierLiveEquityClient: TradierOrderClient | null }).tradierLiveEquityClient;

  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      LIVE_EQUITY_BOOT_USER: process.env['LIVE_EQUITY_BOOT_USER'],
      TRADIER_API_TOKEN: process.env['TRADIER_API_TOKEN'],
      TRADIER_ACCOUNT_ID: process.env['TRADIER_ACCOUNT_ID'],
    };
    process.env['LIVE_EQUITY_BOOT_USER'] = 'admin';
    process.env['TRADIER_API_TOKEN'] = 'shared-env-tok';
    process.env['TRADIER_ACCOUNT_ID'] = 'shared-env-acct';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('does NOT resolve the shared env account for a non-operator user (TRA-856 leak closed)', () => {
    const engine = new SignalEngine(envOnlyLiveSettings());
    engine.setAlertUsername('freshly-signed-up-user');
    expect(readEquityClient(engine)).toBeNull();
  });

  it('still resolves the shared env account for the pinned operator', () => {
    const engine = new SignalEngine(envOnlyLiveSettings());
    engine.setAlertUsername('admin');
    expect(readEquityClient(engine)).not.toBeNull();
  });

  it('per-user creds work for a non-operator (precedence unchanged)', () => {
    const engine = new SignalEngine({
      ...envOnlyLiveSettings(),
      liveApiKeyOptionsProduction: 'her-own-tok',
      liveAccountIdOptionsProduction: 'her-own-acct',
    });
    engine.setAlertUsername('alice');
    expect(readEquityClient(engine)).not.toBeNull();
  });
});

// ── TRA-3977 — the engine DECLARES its book to the live fill ledger ─────────
// Measured 2026-08-27 on bqb1 `56804e1a`: two live books served, the ledger's
// registry read `["admin"]` (off one termination marker) and every book-scoped
// oracle answered fleet-wide. The wire-up half of the registry is what these
// pin: it fires for a LIVE book with an owner, not for a demo book (one live
// book + sixty QA demo books is ONE book to the ledger — AC4), and it fires
// again when a book flips to live at runtime.
describe('SignalEngine — TRA-3977 live-book declaration to the fill ledger', () => {
  beforeEach(() => {
    clearLiveOptionsFeeSlippageLedger();
  });
  afterEach(() => {
    clearLiveOptionsFeeSlippageLedger();
  });

  it('a LIVE engine declares its book when the owner is bound', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' });
    expect(knownLiveOptionBooks()).toEqual([]); // owner unknown at construction
    engine.setAlertUsername('v0nni');
    expect(knownLiveOptionBooks()).toEqual(['v0nni']);
  });

  it('a DEMO engine does NOT — a demo book cannot write the live ledger, so it is not a second book', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    engine.setAlertUsername('qa_reg_0710202220');
    expect(knownLiveOptionBooks()).toEqual([]);
  });

  it('a book that flips to live at runtime is declared at the flip', async () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    engine.setAlertUsername('alice');
    expect(knownLiveOptionBooks()).toEqual([]);
    await engine.applySettings({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' });
    expect(knownLiveOptionBooks()).toEqual(['alice']);
  });
});

// ── TRA-787 — SupertrendConfluence SHADOW channel ────────────────────────────
// Acceptance #5: a tick fed a synthetic uptrend-confluence window produces a
// shadow signal on the dedicated channel AND zero entries on the live order
// path. The live strategies stay byte-for-byte identical (untouched here).
describe('SignalEngine — SupertrendConfluence shadow channel (TRA-787)', () => {
  // The shadow pass calls recordShadowSignal, which would otherwise append to the
  // production data/shadow-signals.jsonl. Point the ledger at a throwaway temp
  // file per test so these runs never pollute QuantTrader's validation dataset.
  let ledgerFile: string;
  let ledgerN = 0;
  beforeEach(() => {
    ledgerN += 1;
    ledgerFile = join(tmpdir(), `signal-engine-shadow-${process.pid}-${ledgerN}.jsonl`);
    try { rmSync(ledgerFile); } catch { /* fresh */ }
    setShadowLedgerFileForTests(ledgerFile);
  });
  afterEach(() => {
    setShadowLedgerFileForTests(null);
    try { rmSync(ledgerFile); } catch { /* ignore */ }
  });

  // 5-minute OHLCV from explicit closes: high/low straddle the running close,
  // open = prior close. 5m step so resampling to the strategy's 1h confirm fold
  // yields enough buckets for the higher-timeframe Supertrend.
  function build5m(closes: number[], spread = 0.5): Candle[] {
    const step = 5 * 60_000;
    return closes.map((close, i) => ({
      symbol: 'TEST',
      timestamp: i * step,
      open: i > 0 ? closes[i - 1] : close,
      high: Math.max(close, i > 0 ? closes[i - 1] : close) + spread,
      low: Math.min(close, i > 0 ? closes[i - 1] : close) - spread,
      close,
      volume: 1_000,
    }));
  }

  // Sawtooth uptrend (pullback-inside-an-uptrend): periodic dips cool RSI into
  // the [50,70] entry band while the net drift keeps the SMA stack aligned and
  // MACD positive — the exact confluence the strategy is built to buy. Deep
  // enough that the 1h confirm fold has ≥ period+1 bars.
  function sawUp(n: number, u = 0.5, d = 1.0, k = 3): number[] {
    const closes: number[] = [];
    let p = 100;
    let i = 0;
    while (closes.length < n) {
      const inUp = i % (k + 1) !== k;
      closes.push(p);
      p += inUp ? u : -d;
      i++;
    }
    while (closes.length > 2 && closes[closes.length - 1] <= closes[closes.length - 2]) closes.pop();
    return closes;
  }

  it('surfaces a shadow signal on the dedicated channel and opens NOTHING on the live path', () => {
    const engine = new SignalEngine();
    const candles = build5m(sawUp(480));
    // Seed the shadow 5m series directly (the deep-pull refresh is feed-bound;
    // the per-tick evaluation reads this cache).
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', candles);

    (engine as unknown as { evaluateSupertrendShadow: (s: string[]) => void }).evaluateSupertrendShadow(['TEST']);

    const state = engine.getState();
    // Shadow channel carries the long signal …
    expect(state.supertrendShadowSignals).toHaveLength(1);
    expect(state.supertrendShadowSignals[0].type).toBe('supertrend_confluence');
    expect(state.supertrendShadowSignals[0].side).toBe('buy');
    expect(state.supertrendShadowSignals[0].symbol).toBe('TEST');
    // … and NOTHING reached the live order path: no live signal, no position.
    expect(state.signals).toHaveLength(0);
    expect(state.account.openPositions).toHaveLength(0);
  });

  it('emits no shadow signal on a flat tape (and still touches no live path)', () => {
    const engine = new SignalEngine();
    const flat = build5m(Array.from({ length: 240 }, () => 100));
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', flat);

    (engine as unknown as { evaluateSupertrendShadow: (s: string[]) => void }).evaluateSupertrendShadow(['TEST']);

    const state = engine.getState();
    expect(state.supertrendShadowSignals).toHaveLength(0);
    expect(state.signals).toHaveLength(0);
    expect(state.account.openPositions).toHaveLength(0);
  });

  // TRA-801 — Stage-2 PAPER accrual. The shadow signal now ALSO opens a position
  // in the dedicated forward-test paper book (distinct from the observe-only
  // shadow log AND from the user's demo account), which closes at SL/TP and lands
  // in the export snapshot's closedPositions stamped supertrend_confluence/demo.
  it('opens a paper forward-test position on a shadow signal — isolated from the user demo book', () => {
    const engine = new SignalEngine();
    const candles = build5m(sawUp(480));
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', candles);

    (engine as unknown as { evaluateSupertrendShadow: (s: string[]) => void }).evaluateSupertrendShadow(['TEST']);

    // The forward-test book holds one open paper position …
    const stPaper = (engine as unknown as { supertrendPaper: { getState(): { openPositions: Array<{ symbol: string; signalType: string }> } } }).supertrendPaper;
    const open = stPaper.getState().openPositions;
    expect(open).toHaveLength(1);
    expect(open[0].symbol).toBe('TEST');
    expect(open[0].signalType).toBe('supertrend_confluence');
    // … while the user's demo account is untouched (isolation invariant).
    expect(engine.getState().account.openPositions).toHaveLength(0);
  });

  it('closes the paper position at take-profit into closedPositions (supertrend_confluence/demo)', () => {
    const engine = new SignalEngine();
    const candles = build5m(sawUp(480));
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', candles);
    (engine as unknown as { evaluateSupertrendShadow: (s: string[]) => void }).evaluateSupertrendShadow(['TEST']);

    const stPaper = (engine as unknown as { supertrendPaper: { getState(): { openPositions: Array<{ takeProfit: number }> } } }).supertrendPaper;
    const tp = stPaper.getState().openPositions[0].takeProfit;

    // Drive the live price above the take-profit and run the forward-test exits.
    const prices = new Map<string, number>([['TEST', tp + 5]]);
    (engine as unknown as { runSupertrendPaperExits: (p: Map<string, number>) => void }).runSupertrendPaperExits(prices);

    // The closed paper trade is recorded for the promotion service's Stage-2 ledger.
    const snap = engine.exportTradeSnapshot();
    const stClosed = snap.closedPositions.filter(p => p.signalType === 'supertrend_confluence');
    expect(stClosed).toHaveLength(1);
    expect(stClosed[0].mode).toBe('demo');
    expect(stClosed[0].closedAt).toBeDefined();
    expect(stClosed[0].pnl ?? 0).toBeGreaterThan(0); // exited at TP → winning paper trade
    // The forward-test book is now flat again.
    expect((engine as unknown as { supertrendPaper: { getState(): { openPositions: unknown[] } } }).supertrendPaper.getState().openPositions).toHaveLength(0);
  });

  // TRA-834 regression — the paper book stalled at tradeCount=0 because exits ran
  // off a single point-sample tick quote, which misses a stop/target touched by a
  // 5m WICK that the shadow ledger's intra-bar high/low walk (resolveOutcome)
  // does count. With the one-position-per-symbol open guard, an unclosed position
  // blocked all further accrual. Exits now share the bar-walk, so a wick-touch
  // closes the position even when the latest quote never breached the bracket.
  it('TRA-834: closes a paper position on an intra-bar 5m wick the tick quote misses', () => {
    const engine = new SignalEngine();
    const stPaper = (engine as unknown as { supertrendPaper: PaperAccount }).supertrendPaper;

    // Open a long forward-test position directly: entry 100, stop 95, target 110.
    const signal = {
      id: 'sig-wick', symbol: 'WICK', side: 'buy', type: 'supertrend_confluence',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, timestamp: Date.now(),
    } as unknown as TradeSignal;
    const opened = stPaper.openPosition(signal, 100);
    expect(opened).not.toBeNull();

    // A later 5m bar wicks THROUGH the stop (low 94 ≤ 95) but its close recovers
    // to 100 — a point-sample quote at the close never sees the breach, while the
    // bar-walk resolver (low ≤ stop) records SL_HIT. Timestamp just after entry so
    // it lands in the same ET session the resolver requires.
    const after = (opened!.openedAt ?? Date.now()) + 60_000;
    const wickBar: Candle = {
      symbol: 'WICK', timestamp: after, open: 100, high: 101, low: 94, close: 100, volume: 1_000,
    };
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('WICK', [wickBar]);

    // EMPTY price map → the point-sample backstop cannot close anything; only the
    // bar-walk can. Proves the wick-touch path is what drains the book.
    (engine as unknown as { runSupertrendPaperExits: (p: Map<string, number>) => void })
      .runSupertrendPaperExits(new Map());

    const snap = engine.exportTradeSnapshot();
    const stClosed = snap.closedPositions.filter(p => p.signalType === 'supertrend_confluence');
    expect(stClosed).toHaveLength(1);
    expect(stClosed[0].exitReason).toBe('stop');
    expect(stClosed[0].exitPrice ?? 0).toBeCloseTo(95); // exited at the stop (−1R)
    expect(stClosed[0].pnl ?? 0).toBeLessThan(0);
    expect(stClosed[0].closedAt).toBeDefined();
    expect(stPaper.getState().openPositions).toHaveLength(0);
  });

  // TRA-936 — a closed forward-test trade must ALSO land in the durable
  // cumulative ledger (`supertrendPaperClosed`), survive the nightly TRA-219
  // archive (which clears the UI `closedPositions`), and round-trip through the
  // trade snapshot so the Stage-2 paper count survives a redeploy.
  it('TRA-936: durable forward-test ledger survives the nightly archive and an export/import round-trip', () => {
    const engine = new SignalEngine();
    const candles = build5m(sawUp(480));
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', candles);
    (engine as unknown as { evaluateSupertrendShadow: (s: string[]) => void }).evaluateSupertrendShadow(['TEST']);
    const stPaper = (engine as unknown as { supertrendPaper: { getState(): { openPositions: Array<{ takeProfit: number }> } } }).supertrendPaper;
    const tp = stPaper.getState().openPositions[0].takeProfit;
    (engine as unknown as { runSupertrendPaperExits: (p: Map<string, number>) => void })
      .runSupertrendPaperExits(new Map<string, number>([['TEST', tp + 5]]));

    // The closed trade is in BOTH the transient UI list and the durable ledger.
    const before = engine.exportTradeSnapshot();
    expect(before.closedPositions.filter(p => p.signalType === 'supertrend_confluence')).toHaveLength(1);
    expect(before.supertrendPaperClosed).toHaveLength(1);

    // The nightly 9 PM ET archive blanks the UI list but NOT the durable ledger.
    engine.archiveClosedTrades();
    const afterArchive = engine.exportTradeSnapshot();
    expect(afterArchive.closedPositions.filter(p => p.signalType === 'supertrend_confluence')).toHaveLength(0);
    expect(afterArchive.supertrendPaperClosed).toHaveLength(1);

    // The durable ledger round-trips through a redeploy (export → import).
    const restored = new SignalEngine();
    restored.importTradeSnapshot({
      closedPositions: afterArchive.closedPositions,
      recentSignals: afterArchive.recentSignals,
      dailySignals: afterArchive.dailySignals,
      positionSignalType: afterArchive.positionSignalType,
      account: afterArchive.account,
      options: afterArchive.options,
      supertrendPaper: afterArchive.supertrendPaper,
      supertrendPaperClosed: afterArchive.supertrendPaperClosed,
    });
    expect(restored.exportTradeSnapshot().supertrendPaperClosed).toHaveLength(1);
  });

  // TRA-3860 — the archive boundary is `/api/trades/export`'s coverage floor:
  // the route filters `from`/`to` over the in-memory closed-trade buckets that
  // this archive empties, so without a recorded boundary an archived day and an
  // empty day are the same `200 {"trades": []}`.
  it('TRA-3860: archiveClosedTrades stamps a durable boundary, even on a tick that archived nothing', () => {
    const engine = new SignalEngine();

    // Never archived ⇒ null, NOT 0. An epoch-0 floor would read as "this export
    // covers all of history", which is the one wrong answer the field prevents.
    expect(engine.exportTradeSnapshot().lastArchivedAt).toBeNull();

    // A tick that archived ZERO rows still resets what the export can attest to,
    // so it must stamp. Gating the stamp on `positions + options > 0` would leave
    // a quiet day's boundary unrecorded and hand the route a floor older than the
    // truth — the direction that lets an unservable range be answered.
    const at = Date.parse('2026-08-19T01:00:06.467Z');
    const counts = engine.archiveClosedTrades(at);
    expect(counts).toEqual({ positions: 0, options: 0 });
    expect(engine.exportTradeSnapshot().lastArchivedAt).toBe(at);

    // It survives a redeploy: the archive runs once a day, so a boundary that
    // reset on every restart would drop the export back to its conservative
    // process-start floor several times a week.
    const snap = engine.exportTradeSnapshot();
    const restored = new SignalEngine();
    restored.importTradeSnapshot({
      closedPositions: snap.closedPositions,
      recentSignals: snap.recentSignals,
      dailySignals: snap.dailySignals,
      positionSignalType: snap.positionSignalType,
      account: snap.account,
      options: snap.options,
      lastArchivedAt: snap.lastArchivedAt,
    });
    expect(restored.exportTradeSnapshot().lastArchivedAt).toBe(at);

    // A pre-TRA-3860 snapshot omits the key entirely. It must restore as null
    // (= no observed boundary), never as 0.
    const legacy = new SignalEngine();
    legacy.importTradeSnapshot({
      closedPositions: snap.closedPositions,
      recentSignals: snap.recentSignals,
      dailySignals: snap.dailySignals,
      positionSignalType: snap.positionSignalType,
      account: snap.account,
      options: snap.options,
    });
    expect(legacy.exportTradeSnapshot().lastArchivedAt).toBeNull();
  });

  // TRA-1082 — the full-universe shadow sweep must YIELD to the libuv event loop
  // mid-pass so the per-symbol supertrend()/confluenceSide() indicator math can't
  // run as one uninterrupted synchronous burst (the residual root cause of the
  // bqb1 502 flap: silent 5-8s loop blocks that blew Render's 5s health check).
  // A self-rescheduling setImmediate probe counts macrotask boundaries: if the
  // sweep ran fully synchronously the probe never gets a turn during it (ticks 0);
  // because the sweep awaits a setImmediate every EQUITY_EVAL_YIELD_EVERY (25)
  // symbols, a >25-symbol universe interleaves the probe at least once.
  it('TRA-1082: yields to the event loop mid-sweep so the universe is not one synchronous burst', async () => {
    // Real timers: the sweep (and the probe below) await a REAL setImmediate.
    // The global beforeEach fakes timers, which would stall both. afterEach
    // restores fake timers for the rest of the suite.
    vi.useRealTimers();
    const engine = new SignalEngine();
    const flat = build5m(Array.from({ length: 240 }, () => 100));
    const universe = Array.from({ length: 60 }, (_, i) => `SYM${i}`);
    const cache = (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache;
    for (const sym of universe) cache.set(sym, flat);

    let ticks = 0;
    let running = true;
    const probe = (): void => {
      if (!running) return;
      ticks++;
      setImmediate(probe);
    };
    setImmediate(probe);

    await (engine as unknown as { evaluateSupertrendShadow: (s: string[]) => Promise<void> })
      .evaluateSupertrendShadow(universe);
    running = false;

    // The sweep handed control back to the loop at least once (2 yields at idx
    // 25 and 50). A single-symbol call would leave this at 0 — exactly the
    // pre-fix synchronous-burst behaviour this guards against.
    expect(ticks).toBeGreaterThan(0);
  });
});

// TRA-1053 (TRA-1045 R3) — bound in-memory growth: per-day ledgers are released
// at the session close, and the closed-position history rehydrated at boot is
// capped so an abnormally large snapshot can't blow up boot memory.
describe('SignalEngine — TRA-1053 memory bounding', () => {
  function closedPos(id: string, closedAt: number): Position {
    return {
      id,
      symbol: 'AAPL',
      side: 'buy',
      quantity: 1,
      entryPrice: 100,
      stopLoss: 99,
      takeProfit: 102,
      openedAt: closedAt - 1,
      closedAt,
      pnl: 1,
      mode: 'demo',
      signalType: 'orb',
    } as unknown as Position;
  }

  it('clearDailySessionState() empties dailySignals without touching closed history or the account', () => {
    const engine = new SignalEngine();
    engine.importTradeSnapshot({
      closedPositions: [closedPos('c-1', 1_000), closedPos('c-2', 2_000)],
      recentSignals: [],
      dailySignals: [
        { id: 's1', symbol: 'AAPL', type: 'orb', firedAt: 1_000 },
        { id: 's2', symbol: 'MSFT', type: 'orb', firedAt: 2_000 },
      ] as unknown as Parameters<typeof engine.importTradeSnapshot>[0]['dailySignals'],
      positionSignalType: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0, openPositions: [] },
      options: { openOptions: [], closedOptions: [], optionsPnl: 0, dailyCount: 0, currentDayKey: '2026-06-23', cash: 25_000, equity: 25_000 },
    });
    expect(engine.getReportSnapshot().dailySignals).toHaveLength(2);

    engine.clearDailySessionState();

    expect(engine.getReportSnapshot().dailySignals).toHaveLength(0);
    // Closed-position history and the account are untouched (no decision impact).
    expect(engine.exportTradeSnapshot().closedPositions).toHaveLength(2);
    expect(engine.getState().account.totalEquity).toBe(25_000);
  });

  it('caps the closed-position history rehydrated at boot to the most-recent rows', () => {
    const engine = new SignalEngine();
    const huge = Array.from({ length: 2_001 }, (_, i) => closedPos(`c-${i}`, 1_000 + i));
    engine.importTradeSnapshot({
      closedPositions: huge,
      recentSignals: [],
      dailySignals: [],
      positionSignalType: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0, openPositions: [] },
      options: { openOptions: [], closedOptions: [], optionsPnl: 0, dailyCount: 0, currentDayKey: '2026-06-23', cash: 25_000, equity: 25_000 },
    });
    const restored = engine.exportTradeSnapshot().closedPositions;
    // Bounded to the 2_000 cap, keeping the newest rows (oldest c-0 dropped).
    expect(restored).toHaveLength(2_000);
    expect(restored[0]!.id).toBe('c-1');
    expect(restored.at(-1)!.id).toBe('c-2000');
  });

  it('leaves a normally-sized closed-position snapshot fully intact at boot', () => {
    const engine = new SignalEngine();
    const day = Array.from({ length: 50 }, (_, i) => closedPos(`c-${i}`, 1_000 + i));
    engine.importTradeSnapshot({
      closedPositions: day,
      recentSignals: [],
      dailySignals: [],
      positionSignalType: [],
      account: { cash: 25_000, equity: 25_000, initialEquity: 25_000, dailyPnl: 0, openPositions: [] },
      options: { openOptions: [], closedOptions: [], optionsPnl: 0, dailyCount: 0, currentDayKey: '2026-06-23', cash: 25_000, equity: 25_000 },
    });
    expect(engine.exportTradeSnapshot().closedPositions).toHaveLength(50);
  });
});

// TRA-917 (TRA-908 Phase A) — live wiring of the SHADOW option-structure
// selector. Proves the acceptance criterion end-to-end through the engine:
// flag OFF = silent (no chain fetch, nothing written); flag ON = a well-formed
// shadow option signal lands in the ledger, and NO order is ever routed.
describe('SignalEngine — option-shadow selector wiring (TRA-917)', () => {
  let ledgerFile: string;
  let ivFile: string;
  let n = 0;

  // 5m OHLCV from explicit closes (open = prior close; high/low straddle close).
  function build5m(closes: number[], spread = 0.5): Candle[] {
    const step = 5 * 60_000;
    return closes.map((close, i) => ({
      symbol: 'TEST',
      timestamp: i * step,
      open: i > 0 ? closes[i - 1] : close,
      high: Math.max(close, i > 0 ? closes[i - 1] : close) + spread,
      low: Math.min(close, i > 0 ? closes[i - 1] : close) - spread,
      close,
      volume: 1_000,
    }));
  }

  // Sawtooth uptrend — pullbacks cool RSI into the entry band while the net
  // drift keeps the SMA stack aligned and MACD positive: the confluence the
  // selector reads as trend 'up' (→ bull put spread under high IV-rank).
  function sawUp(count: number, u = 0.5, d = 1.0, k = 3): number[] {
    const closes: number[] = [];
    let p = 100;
    let i = 0;
    while (closes.length < count) {
      closes.push(p);
      p += i % (k + 1) !== k ? u : -d;
      i++;
    }
    while (closes.length > 2 && closes[closes.length - 1] <= closes[closes.length - 2]) closes.pop();
    return closes;
  }

  // A full delta-laddered chain around `spot`, every leg liquid, constant IV so
  // the ATM read is deterministic. Mirrors the option-shadow-ledger unit fixture.
  function chainRows(spot: number, iv: number) {
    const rows = [];
    const extrinsic = (kStrike: number) => Math.max(0.3, 2.0 - 0.08 * Math.abs(kStrike - spot));
    for (let kStrike = spot - 20; kStrike <= spot + 20; kStrike += 1) {
      const putMid = Math.max(kStrike - spot, 0) + extrinsic(kStrike);
      const callMid = Math.max(spot - kStrike, 0) + extrinsic(kStrike);
      rows.push({
        optionSymbol: `P${kStrike}`, underlying: 'TEST', optionType: 'put' as const, strike: kStrike,
        expiration: '2024-07-19', bid: putMid * 0.98, ask: putMid * 1.02, openInterest: 1000, smvVol: iv,
      });
      rows.push({
        optionSymbol: `C${kStrike}`, underlying: 'TEST', optionType: 'call' as const, strike: kStrike,
        expiration: '2024-07-19', bid: callMid * 0.98, ask: callMid * 1.02, openInterest: 1000, smvVol: iv,
      });
    }
    return rows;
  }

  // Seed a trailing-year IV window where `current` ranks high (≈88) so the
  // selector's IVR≥50 short-premium branch fires. 30 daily samples 0.10→0.50.
  function seedIvHistory(current: number): void {
    const samples = Array.from({ length: 30 }, (_, i) => ({
      day: new Date(TRADING_TIME - (i + 1) * 86_400_000).toISOString().slice(0, 10),
      iv: 0.1 + (0.4 * i) / 29,
    }));
    void current; // current IV is carried on the chain (smvVol), ranked against these
    writeFileSync(ivFile, JSON.stringify({ version: 1, updatedAt: TRADING_TIME, symbols: { TEST: samples } }));
  }

  function makeScanner(snapshot: SelectorChainSnapshot | null): {
    svc: RelativeValueScannerService;
    calls: { getSelectorChain: number };
  } {
    const calls = { getSelectorChain: 0 };
    const svc: RelativeValueScannerService = {
      scan: vi.fn(async () => ({ symbol: 'TEST', spot: null, expiration: null, candidates: [], reason: 'ok' as const })),
      scanOtm: vi.fn(async () => ({ symbol: 'TEST', spot: null, expiration: null, candidates: [], reason: 'unavailable' as const })),
      getSelectorChain: vi.fn(async () => {
        calls.getSelectorChain += 1;
        return snapshot;
      }),
      getOptionMark: vi.fn(async () => null),
      diagnostics: vi.fn(() => ({ configured: true, breakerOpen: false, breakerOpenedAtMs: null, cacheSize: 0, expirationsCacheSize: 0, chainCacheMaxEntries: 64, expirationsCacheMaxEntries: 64 })),
    };
    return { svc, calls };
  }

  beforeEach(() => {
    ledgerFile = join(tmpdir(), `opt-shadow-engine-${process.pid}-${n}.jsonl`);
    ivFile = join(tmpdir(), `iv-engine-${process.pid}-${n}.json`);
    n++;
    setOptionShadowLedgerFileForTests(ledgerFile);
    setIvStoreFileForTests(ivFile);
    delete process.env[OPTION_SHADOW_FLAG];
  });
  afterEach(() => {
    setOptionShadowLedgerFileForTests(null);
    setIvStoreFileForTests(null);
    delete process.env[OPTION_SHADOW_FLAG];
    try { rmSync(ledgerFile); } catch { /* ignore */ }
    try { rmSync(ivFile); } catch { /* ignore */ }
  });

  it('flag OFF — fetches no chain and writes nothing', async () => {
    const { svc, calls } = makeScanner({ symbol: 'TEST', spot: 100, expiration: '2024-07-19', rows: chainRows(100, 0.45) });
    const engine = new SignalEngine(undefined, undefined, svc);
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', build5m(sawUp(480)));
    await initOptionShadowLedger();

    await (engine as unknown as { evaluateOptionShadow: (s: string[]) => Promise<void> }).evaluateOptionShadow(['TEST']);

    expect(calls.getSelectorChain).toBe(0); // flag gate short-circuits BEFORE any Tradier work
    expect(await listOptionShadowSignals()).toHaveLength(0);
  });

  it('flag ON — writes a well-formed bull put spread and routes NOTHING', async () => {
    process.env[OPTION_SHADOW_FLAG] = 'true';
    seedIvHistory(0.45);
    await initIvRankStore();

    const { svc, calls } = makeScanner({ symbol: 'TEST', spot: 100, expiration: '2024-07-19', rows: chainRows(100, 0.45) });
    const engine = new SignalEngine(undefined, undefined, svc);
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', build5m(sawUp(480)));
    await initOptionShadowLedger();

    await (engine as unknown as { evaluateOptionShadow: (s: string[]) => Promise<void> }).evaluateOptionShadow(['TEST']);

    expect(calls.getSelectorChain).toBe(1);
    const rows = await listOptionShadowSignals();
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('TEST');
    expect(rows[0].strategy).toBe('bull_put_spread');
    expect(rows[0].legs).toHaveLength(2);
    expect(rows[0].expiration).toBe('2024-07-19');
    // The selector ladders by a BS delta we synthesized from the chain IV.
    expect(rows[0].shortDelta).toBeGreaterThan(0);
    // Observe-only: nothing reached the live order path.
    expect(engine.getState().signals).toHaveLength(0);
    expect(engine.getState().account.openPositions).toHaveLength(0);
  });

  it('flag ON but IV history cold — IVR null → stands down, writes nothing', async () => {
    process.env[OPTION_SHADOW_FLAG] = 'true';
    // No seedIvHistory → ivRankSync returns null → gate stands down.
    await initIvRankStore();

    const { svc } = makeScanner({ symbol: 'TEST', spot: 100, expiration: '2024-07-19', rows: chainRows(100, 0.45) });
    const engine = new SignalEngine(undefined, undefined, svc);
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set('TEST', build5m(sawUp(480)));
    await initOptionShadowLedger();

    await (engine as unknown as { evaluateOptionShadow: (s: string[]) => Promise<void> }).evaluateOptionShadow(['TEST']);

    expect(await listOptionShadowSignals()).toHaveLength(0);
  });
});

// ── TRA-1088 — shared shadow pass double-count guard ─────────────────────────
// TRA-1089 hoisted the per-book reversal/supertrend/option shadow research to a
// single fleet-wide pass per 5m series. The reversal shadow ledger is a GLOBAL
// file, so the deferred risk (TRA-1087 item 1) was that hoisting could change
// the OPEN/RESOLVE row COUNTS feeding the TRA-1064 priorRate accrual QuantTrader
// is validating (TRA-1062). These tests pin the coordinator invariant: across N
// simulated engines crossing the SAME window, the eval pass — and therefore the
// GLOBAL ledger append — runs exactly ONCE, not N-fold.
describe('SignalEngine — TRA-1088 shared shadow pass double-count guard', () => {
  const LEDGER_FILE = join(tmpdir(), 'tra1088-reversal-shadow.jsonl');

  beforeEach(() => {
    rmSync(LEDGER_FILE, { force: true });
    setReversalShadowLedgerFileForTests(LEDGER_FILE);
    _resetSharedShadowForTests();
  });

  afterEach(() => {
    setReversalShadowLedgerFileForTests(null);
    rmSync(LEDGER_FILE, { force: true });
  });

  // A finished checklist with a full bracket → buildReversalShadowOpen yields a
  // recordable OPEN (all of side/zone/entry/stop/target non-null; see the guard
  // in reversal-shadow-ledger.ts). Hand-built so the test is independent of the
  // exact tape that fires reversalChecklist() — we are pinning the COORDINATOR,
  // not the indicator (the latter is covered by the TRA-921 reversal tests).
  function bracketChecklist(side: 'long' | 'short'): ReversalChecklist {
    const zone: SrZone = {
      kind: side === 'long' ? 'support' : 'resistance',
      level: 100,
      lower: 99.5,
      upper: 100.5,
      touches: 3,
      lastTouchIndex: 40,
    };
    return {
      side,
      zone,
      atKeyLevel: true,
      trendBreak: true,
      unhealthyMove: true,
      pattern: null,
      score: 3,
      confirmed: false,
      entry: 100,
      stop: side === 'long' ? 99 : 101,
      target: side === 'long' ? 103 : 97,
      riskReward: 3,
      inTimingWindow: null,
    };
  }

  // Drive one fleet-wide tick through the EXACT refresh()/eval gate (the exported
  // coordinator predicates the engine calls): the refresh claim wraps the (here
  // synchronous) series refresh, then the eval claim gates the body. Returns
  // whether THIS engine ran the eval body.
  async function fleetTick(nowMs: number, evalBody: () => Promise<void>): Promise<boolean> {
    if (_sharedShadowRefreshDue(nowMs)) {
      _claimSharedShadowRefresh(nowMs);
      _endSharedShadowRefresh();
    }
    if (_sharedShadowEvalDue()) {
      _claimSharedShadowEval();
      await evalBody();
      return true;
    }
    return false;
  }

  it('N=3 engines over one series → exactly ONE OPEN row; a later series → exactly ONE RESOLVE row', async () => {
    const N = 3;
    const open = buildReversalShadowOpen('TEST', bracketChecklist('long'), TRADING_TIME);
    expect(open).not.toBeNull();

    // Window 1 — the setup prints on a fresh 5m series; all N engines tick.
    const w1 = TRADING_TIME;
    let openEvalRuns = 0;
    for (let i = 0; i < N; i++) {
      const ran = await fleetTick(w1, async () => {
        await recordReversalShadowSignal(open!); // the GLOBAL ledger append
      });
      if (ran) openEvalRuns += 1;
    }
    // The hoist guarantee: the append path executed once, not N times.
    expect(openEvalRuns).toBe(1);
    const afterOpen = await listReversalShadowSignals();
    expect(afterOpen.filter((r) => r.outcome === 'OPEN')).toHaveLength(1);

    // Window 2 — a NEW series advances the refresh window; the forward bars now
    // resolve the open setup. Again all N engines tick; only one resolves it.
    const w2 = w1 + 60_000;
    let resolveEvalRuns = 0;
    for (let i = 0; i < N; i++) {
      const ran = await fleetTick(w2, async () => {
        await resolveReversalShadowSignal(
          open!.id,
          { outcome: 'TP_HIT', realizedR: 1.5, barsToResolution: 4 },
          w2,
        );
      });
      if (ran) resolveEvalRuns += 1;
    }
    expect(resolveEvalRuns).toBe(1);

    const final = await listReversalShadowSignals();
    expect(final).toHaveLength(1); // still one row — open folded into resolved
    expect(final[0].outcome).toBe('TP_HIT');
    expect(final[0].resolvedAt).toBe(w2);
  });

  it('control: without the coordinator gate, N direct appends collapse to one row only via the dedup id — which is why we pin eval invocations, not row counts', async () => {
    // The parent (TRA-1087 item 1) flagged that the dedup id masks the
    // duplication: even an un-hoisted N-fold append yields one OPEN row because
    // `${symbol}:${side}:${entryBarTs}` collapses repeats. Document that here so
    // the guarantee above is understood to be about the EVAL/append count, not
    // the post-dedup row count.
    const N = 3;
    const open = buildReversalShadowOpen('TEST', bracketChecklist('short'), TRADING_TIME);
    expect(open).not.toBeNull();

    let appendedTrue = 0;
    for (let i = 0; i < N; i++) {
      // No fleetTick gate — every "engine" appends, mimicking per-engine behaviour.
      if (await recordReversalShadowSignal(open!)) appendedTrue += 1;
    }
    // recordReversalShadowSignal returns true only on the FIRST insert; the
    // ledger still holds exactly one row. The hoist's win is eliminating the N-1
    // redundant append ATTEMPTS (and the N-fold reversalChecklist() CPU), which
    // the first test pins via the eval-invocation count.
    expect(appendedTrue).toBe(1);
    expect((await listReversalShadowSignals()).filter((r) => r.outcome === 'OPEN')).toHaveLength(1);
  });
});

// TRA-1114 — demo-only deterministic directional call/put entry. Board
// escalation (3rd time): plumbing ON but no calls/puts ever fill in the demo
// paper book. Proves the new path opens REAL near-ATM single-leg longs in the
// demo book WITHOUT any IV-rank history (the exact condition that makes the
// spread selector stand down), a call on an uptrend symbol and a put on a
// downtrend one, and stays wholly inert when the flag is off.
describe('SignalEngine — demo directional option entry (TRA-1114)', () => {
  // 5m OHLCV from explicit closes (open = prior close; high/low straddle close).
  function build5m(closes: number[], spread = 0.5): Candle[] {
    const step = 5 * 60_000;
    return closes.map((close, i) => ({
      symbol: 'TEST', timestamp: i * step,
      open: i > 0 ? closes[i - 1] : close,
      high: Math.max(close, i > 0 ? closes[i - 1] : close) + spread,
      low: Math.min(close, i > 0 ? closes[i - 1] : close) - spread,
      close, volume: 1_000,
    }));
  }
  // Sawtooth drift the confluence stack reads as 'up' (calls) / 'down' (puts).
  function sawUp(count: number, u = 0.5, d = 1.0, k = 3): number[] {
    const closes: number[] = []; let p = 100; let i = 0;
    while (closes.length < count) { closes.push(p); p += i % (k + 1) !== k ? u : -d; i++; }
    while (closes.length > 2 && closes[closes.length - 1] <= closes[closes.length - 2]) closes.pop();
    return closes;
  }
  function sawDown(count: number, d = 0.5, u = 1.0, k = 3): number[] {
    const closes: number[] = []; let p = 300; let i = 0;
    while (closes.length < count) { closes.push(p); p -= i % (k + 1) !== k ? d : -u; i++; }
    while (closes.length > 2 && closes[closes.length - 1] >= closes[closes.length - 2]) closes.pop();
    return closes;
  }
  // Liquid delta-laddered chain around `spot`, ~45 DTE from the trading clock.
  // TRA-3872 — `atmPrem` parameterizes the ATM extrinsic: the LIVE tests below
  // pass 0.9 so a 1-contract open is ~$90 of premium, inside the TRA-3836
  // <=$100 canary ceiling (at the old flat 2.0 the ~$200 order was refused at
  // the broker seam before the stub could witness it). Demo tests keep 2.0.
  function chainRows(sym: string, spot: number, iv = 0.45, atmPrem = 2.0) {
    const rows = [];
    const extrinsic = (kStrike: number) => Math.max(0.3, atmPrem - 0.08 * Math.abs(kStrike - spot));
    for (let kStrike = spot - 20; kStrike <= spot + 20; kStrike += 1) {
      const putMid = Math.max(kStrike - spot, 0) + extrinsic(kStrike);
      const callMid = Math.max(spot - kStrike, 0) + extrinsic(kStrike);
      rows.push({ optionSymbol: `${sym}P${kStrike}`, underlying: sym, optionType: 'put' as const, strike: kStrike, expiration: '2024-07-19', bid: putMid * 0.98, ask: putMid * 1.02, openInterest: 1000, smvVol: iv });
      rows.push({ optionSymbol: `${sym}C${kStrike}`, underlying: sym, optionType: 'call' as const, strike: kStrike, expiration: '2024-07-19', bid: callMid * 0.98, ask: callMid * 1.02, openInterest: 1000, smvVol: iv });
    }
    return rows;
  }
  function scannerFor(snaps: Record<string, SelectorChainSnapshot>): RelativeValueScannerService {
    return {
      scan: vi.fn(async () => ({ symbol: '', spot: null, expiration: null, candidates: [], reason: 'ok' as const })),
      scanOtm: vi.fn(async () => ({ symbol: '', spot: null, expiration: null, candidates: [], reason: 'unavailable' as const })),
      getSelectorChain: vi.fn(async (sym: string) => snaps[sym] ?? null),
      getOptionMark: vi.fn(async () => null),
      diagnostics: vi.fn(() => ({ configured: true, breakerOpen: false, breakerOpenedAtMs: null, cacheSize: 0, expirationsCacheSize: 0, chainCacheMaxEntries: 64, expirationsCacheMaxEntries: 64 })),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME); // 10:20 ET — inside the options trading window (TRA-3942)
    delete process.env[OPTION_DEMO_DIRECTIONAL_FLAG];
    delete process.env[OPTION_LIVE_DIRECTIONAL_FLAG];
    delete process.env[OPTION_LIVE_TEST_UNTIL_VAR];
  });
  afterEach(() => {
    delete process.env[OPTION_DEMO_DIRECTIONAL_FLAG];
    delete process.env[OPTION_LIVE_DIRECTIONAL_FLAG];
    delete process.env[OPTION_LIVE_TEST_UNTIL_VAR];
    vi.useRealTimers();
  });

  function run(engine: SignalEngine, syms: string[]): Promise<void> {
    return (engine as unknown as { evaluateDemoDirectional: (s: string[]) => Promise<void> })
      .evaluateDemoDirectional(syms);
  }
  function seedTrend(engine: SignalEngine, sym: string, closes: number[]): void {
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> }).shadowCandleCache.set(sym, build5m(closes));
  }

  it('flag OFF — opens nothing (prod/live path unchanged)', async () => {
    const svc = scannerFor({ UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainRows('UPP', 100) } });
    const engine = new SignalEngine(undefined, undefined, svc);
    seedTrend(engine, 'UPP', sawUp(480));
    await run(engine, ['UPP']);
    expect(engine.getState().options.openOptions).toHaveLength(0);
  });

  it('flag ON, NO IV history — still fills a call on uptrend and a put on downtrend', async () => {
    process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
    // Deliberately NO IV-rank history seeded: this is the exact condition that
    // makes the spread selector stand down. The directional path must NOT need it.
    const svc = scannerFor({
      UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainRows('UPP', 100) },
      DWN: { symbol: 'DWN', spot: 300, expiration: '2024-07-19', rows: chainRows('DWN', 300) },
    });
    const engine = new SignalEngine(undefined, undefined, svc);
    seedTrend(engine, 'UPP', sawUp(480));
    seedTrend(engine, 'DWN', sawDown(480));

    await run(engine, ['UPP', 'DWN']);

    const open = engine.getState().options.openOptions;
    const call = open.find(o => o.optionType === 'call');
    const put = open.find(o => o.optionType === 'put');
    expect(call).toBeDefined();
    expect(put).toBeDefined();
    expect(call!.symbol).toBe('UPP');
    expect(put!.symbol).toBe('DWN');
    // Near-the-money strikes (closest liquid strike to spot).
    expect(Math.abs((call!.strike ?? 0) - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs((put!.strike ?? 0) - 300)).toBeLessThanOrEqual(1);
    // Surfaced in the signals feed so the probe's optionSignalCount reflects it.
    expect(engine.getState().signals.filter(s => s.type === 'relative_value').length).toBe(2);
  });

  it('flag ON but no confluence trend (range/cold series) — stands down', async () => {
    process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
    const svc = scannerFor({ FLAT: { symbol: 'FLAT', spot: 100, expiration: '2024-07-19', rows: chainRows('FLAT', 100) } });
    const engine = new SignalEngine(undefined, undefined, svc);
    seedTrend(engine, 'FLAT', build5m(Array.from({ length: 480 }, () => 100)).map(c => c.close));
    await run(engine, ['FLAT']);
    expect(engine.getState().options.openOptions).toHaveLength(0);
  });

  // TRA-1123 — the directional path is the ONLY single-leg demo open that fires
  // on a calm tape, but it previously passed no journalSetup, so the option
  // journal accrued only combo rows and never a single_leg_* row → could never
  // reach closed>0. TRA-2245 — the directional open now journals as
  // `single_leg_directional` (renamed out of the shared `single_leg_rv` label so
  // it is not confused with the compile-time-OFF True RV engine), with the
  // honest-unknown ivRank and the confluence-derived trend.
  it('flag ON + journal ON — directional open journals a single_leg_directional OPEN row (TRA-2245)', async () => {
    process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    const journalFile = join(tmpdir(), `tra1123-journal-${process.pid}.jsonl`);
    setOptionTradeJournalFileForTests(journalFile);
    try {
      const svc = scannerFor({
        UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainRows('UPP', 100) },
        DWN: { symbol: 'DWN', spot: 300, expiration: '2024-07-19', rows: chainRows('DWN', 300) },
      });
      const engine = new SignalEngine(undefined, undefined, svc);
      seedTrend(engine, 'UPP', sawUp(480));
      seedTrend(engine, 'DWN', sawDown(480));

      await run(engine, ['UPP', 'DWN']);
      await engine.flushOptionTradeJournal();

      const rows = await listOptionTradeJournal();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      // TRA-2245 — directional fills stamp `single_leg_directional`, NOT `single_leg_rv`.
      expect(rows.every(r => r.structure === 'single_leg_directional')).toBe(true);
      expect(rows.every(r => r.structure === 'single_leg_rv')).toBe(false);
      expect(rows.every(r => r.outcome === 'OPEN')).toBe(true);
      expect(rows.every(r => r.ivRank === null)).toBe(true); // honest-unknown, no per-tick chain fetch
      const upRow = rows.find(r => r.symbol === 'UPP');
      const downRow = rows.find(r => r.symbol === 'DWN');
      expect(upRow!.trend).toBe('up'); // call ⇒ uptrend confluence
      expect(downRow!.trend).toBe('down'); // put ⇒ downtrend confluence
      // TRA-2245 — the structure label NOW disambiguates the sleeve; `entryArchetype`
      // still corroborates it (both axes agree this is the directional sleeve).
      expect(rows.every(r => r.entryArchetype === 'directional')).toBe(true);
    } finally {
      delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
      setOptionTradeJournalFileForTests(null);
      rmSync(journalFile, { force: true });
    }
  });

  // TRA-1682 / TRA-2245 — THE acceptance test. `openOptionFromRvCandidate` USED to
  // stamp `structure: 'single_leg_rv'` unconditionally, so all three of its callers
  // landed in ONE journal bucket. Two of them (the selector-gated + greeks-gated RV
  // long, and the ungated demo DIRECTIONAL opener) also wrote NO `entryArchetype`,
  // which made them indistinguishable — 416 of 1058 live `single_leg_rv` rows carried
  // |Δ| < 0.45, a value `selectRvLongCandidate` cannot emit, i.e. directional fills
  // wearing an RV label. Every RV-structure grade taken off that bucket was
  // unattributable.
  //
  // The failure this pins down is worse than mislabeling: TRA-1680's algebraically
  // impossible greeks gate would have driven the true RV long to ZERO fills while the
  // `single_leg_rv` fill count DID NOT MOVE, because directional kept feeding the same
  // counter. A dead sleeve was invisible to the exact metric we would have used to
  // detect it.
  //
  // TRA-2245 fixed the root of it: the directional caller now stamps
  // `single_leg_directional`, so the STRUCTURE axis ALONE separates the RV long from
  // the directional churner — and the archetype corroborates. Assert both axes agree.
  //
  // Caller 3 (`routeIvRvBuyPremium` → `iv-rv-buy-premium`) is a directional sleeve too
  // (`single_leg_directional`), pinned distinct by its own test ("routing ON + journal
  // ON — open is tagged entryArchetype iv-rv-buy-premium"); its archetype is asserted
  // distinct from these two here.
  it('RV-scan caller keeps single_leg_rv; directional caller stamps single_leg_directional, with DISTINCT archetypes (TRA-1682/TRA-2245)', async () => {
    process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    const journalFile = join(tmpdir(), `tra1682-journal-${process.pid}.jsonl`);
    setOptionTradeJournalFileForTests(journalFile);
    try {
      // One scanner serving BOTH callers: a `scan` RV candidate (AAPL, |Δ| in the
      // 0.55–0.65 selector band) and a directional chain (UPP).
      const svc: RelativeValueScannerService = {
        scan: vi.fn(async (sym: string) => (sym === 'AAPL'
          ? { symbol: 'AAPL', spot: 195, expiration: '2024-07-05', candidates: [makeCandidate()], reason: 'ok' as const }
          : { symbol: sym, spot: null, expiration: null, candidates: [], reason: 'ok' as const })),
        scanOtm: vi.fn(async () => ({ symbol: '', spot: null, expiration: null, candidates: [], reason: 'unavailable' as const })),
        getSelectorChain: vi.fn(async (sym: string) => (sym === 'UPP'
          ? { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainRows('UPP', 100) }
          : null)),
        getOptionMark: vi.fn(async () => null),
        diagnostics: vi.fn(() => ({ configured: true, breakerOpen: false, breakerOpenedAtMs: null, cacheSize: 0, expirationsCacheSize: 0, chainCacheMaxEntries: 64, expirationsCacheMaxEntries: 64 })),
      };
      const engine = new SignalEngine(undefined, undefined, svc);

      // Caller 1 — the bare RV long (no ema-pullback reason ⇒ archetype `rv-long`).
      seedRvTrend(engine, 'AAPL');
      await (engine as unknown as { runRelativeValueScan: (s: string[]) => Promise<void> }).runRelativeValueScan(['AAPL']);
      // Caller 2 — the demo directional opener (archetype `directional`).
      seedTrend(engine, 'UPP', sawUp(480));
      await run(engine, ['UPP']);
      await engine.flushOptionTradeJournal();

      const rows = await listOptionTradeJournal();
      const rvRow = rows.find(r => r.symbol === 'AAPL');
      const dirRow = rows.find(r => r.symbol === 'UPP');
      expect(rvRow).toBeDefined();
      expect(dirRow).toBeDefined();

      // TRA-2245 — the STRUCTURE label now tells them apart: RV keeps the reserved
      // `single_leg_rv`, directional stamps `single_leg_directional`. This is the
      // disambiguation the board asked for (they are no longer one shared bucket).
      expect(rvRow!.structure).toBe('single_leg_rv');
      expect(dirRow!.structure).toBe('single_leg_directional');
      expect(rvRow!.structure).not.toBe(dirRow!.structure);

      // …and the archetype corroborates. No row folds into `unspecified`.
      expect(rvRow!.entryArchetype).toBe('rv-long');
      expect(dirRow!.entryArchetype).toBe('directional');

      // Pairwise distinct across all three callers (the third is `iv-rv-buy-premium`).
      const archetypes = [rvRow!.entryArchetype, dirRow!.entryArchetype, 'iv-rv-buy-premium'];
      expect(new Set(archetypes).size).toBe(3);
      expect(archetypes).not.toContain(undefined);
    } finally {
      delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
      setOptionTradeJournalFileForTests(null);
      rmSync(journalFile, { force: true });
    }
  });

  // TRA-1153 — the directional path already holds the chain, so when the
  // trailing-year IV store is WARM (>= MIN_IV_SAMPLES) the journal row must carry
  // a real, non-null IV-rank that buckets into a learnable band instead of the
  // single `unknown` bucket that made the TRA-992 OOS cohort split degenerate.
  // Proves acceptance #1: new demo rows carry a non-null ivRank.
  it('flag ON + journal ON + WARM IV store — directional open journals a non-null banded ivRank', async () => {
    process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    const journalFile = join(tmpdir(), `tra1153-journal-${process.pid}.jsonl`);
    const ivStoreFile = join(tmpdir(), `tra1153-iv-${process.pid}.json`);
    setOptionTradeJournalFileForTests(journalFile);
    setIvStoreFileForTests(ivStoreFile);
    try {
      // Warm the store with > MIN_IV_SAMPLES (20) distinct prior-day ATM-IV
      // samples spanning 0.22..0.66 so the chain's 0.45 ranks mid-window (a real
      // percentile, max != min). Seeded BEFORE the run so the synchronous
      // ivRankSync inside the directional path observes a warm store.
      for (let n = 1; n <= 22; n++) {
        await recordDailyIv('UPP', 0.20 + n * 0.02, TRADING_TIME - n * 86_400_000);
      }
      expect(ivRankSync('UPP', 0.45, TRADING_TIME)).not.toBeNull(); // store is warm

      const svc = scannerFor({
        UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainRows('UPP', 100, 0.45) },
      });
      const engine = new SignalEngine(undefined, undefined, svc);
      seedTrend(engine, 'UPP', sawUp(480));

      await run(engine, ['UPP']);
      await engine.flushOptionTradeJournal();

      const rows = await listOptionTradeJournal();
      const upRow = rows.find(r => r.symbol === 'UPP');
      expect(upRow).toBeDefined();
      expect(upRow!.structure).toBe('single_leg_directional'); // TRA-2245 — directional sleeve
      // The journaled IV-rank is a real percentile, NOT the legacy hardcoded null.
      expect(upRow!.ivRank).not.toBeNull();
      expect(Number.isFinite(upRow!.ivRank!)).toBe(true);
      expect(upRow!.ivRank!).toBeGreaterThanOrEqual(0);
      expect(upRow!.ivRank!).toBeLessThanOrEqual(100);
    } finally {
      delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
      setOptionTradeJournalFileForTests(null);
      setIvStoreFileForTests(null);
      rmSync(journalFile, { force: true });
      rmSync(ivStoreFile, { force: true });
    }
  });

  // ─── TRA-1490 — DARK live directional (call/put) order path ────────────────
  // Phase 1 dark build of the live options directional path. The SAME pass that
  // opens demo calls/puts (TRA-1114) is the live order path; it runs in live ONLY
  // when ENABLE_OPTION_LIVE_DIRECTIONAL is armed, and mirrors the paper open to a
  // real Tradier buy_to_open via the shared broker seam. These lock the two
  // safety-critical properties: (1) flag OFF in live is byte-for-byte inert — no
  // live open, no broker call; (2) when armed, the path genuinely places a real
  // order (proving it is a built path, not a stub).
  interface DirLiveStub {
    getAccountBalance: ReturnType<typeof vi.fn>;
    getOptionQuote: ReturnType<typeof vi.fn>;
    buyContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }
  function liveDirEngine(svc: RelativeValueScannerService, stub?: DirLiveStub): SignalEngine {
    const engine = new SignalEngine(undefined, undefined, svc);
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    if (stub) (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    (engine as unknown as { liveTradierBalance: unknown }).liveTradierBalance = {
      totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000, dayTradeBuyingPower: 25_000,
    };
    return engine;
  }

  it('live + flag OFF — opens nothing and never calls the broker (DARK, zero capital)', async () => {
    const stub: DirLiveStub = {
      getAccountBalance: vi.fn(),
      getOptionQuote: vi.fn(),
      buyContractsLimit: vi.fn(),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(),
    };
    const svc = scannerFor({ UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainRows('UPP', 100) } });
    const engine = liveDirEngine(svc, stub);
    seedTrend(engine, 'UPP', sawUp(480));

    await run(engine, ['UPP']);

    // No live position and — critically — no order ever reached Tradier.
    expect(engine.getState().options.openOptions).toHaveLength(0);
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    expect(stub.waitForOrderTerminalStatus).not.toHaveBeenCalled();
  });

  it('live + flag ON (armed) — opens a live directional long AND mirrors a real buy_to_open', async () => {
    process.env[OPTION_LIVE_DIRECTIONAL_FLAG] = '1';
    // TRA-4288 — the arm is flag AND OPTION_LIVE_TEST_UNTIL window; open it.
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = FAR_FUTURE_TEST_UNTIL;
    const stub: DirLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({ totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000 }),
      // Tight quote around the ATM call mark (~0.9 — see chainRows/TRA-3872) so
      // the smart-open walk fills inside the <=$100 canary ceiling.
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'UPPC100', bid: 0.86, ask: 0.94 }),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 55, status: 'ok' }),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 55, status: 'filled', exec_quantity: 1, avg_fill_price: 0.91 })),
    };
    const svc = scannerFor({ UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainRows('UPP', 100, 0.45, 0.9) } });
    const engine = liveDirEngine(svc, stub);
    seedTrend(engine, 'UPP', sawUp(480));

    await run(engine, ['UPP']);

    // The built live path both opened a live-book position and placed a REAL order.
    const open = engine.getState().options.openOptions;
    expect(open).toHaveLength(1);
    expect(open[0].optionType).toBe('call');
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
  });

  it('live + flag ON but broker rejects — voids the open and surfaces a live skip-reason (no phantom fill)', async () => {
    process.env[OPTION_LIVE_DIRECTIONAL_FLAG] = '1';
    // TRA-4288 — the arm is flag AND OPTION_LIVE_TEST_UNTIL window; open it.
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = FAR_FUTURE_TEST_UNTIL;
    const stub: DirLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({ totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000 }),
      // ~0.9 ATM (TRA-3872) — the order must clear the canary ceiling so the
      // broker REJECT below is what this test exercises, not the ceiling.
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'UPPC100', bid: 0.86, ask: 0.94 }),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 56, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 56, status: 'canceled', reason_description: 'insufficient buying power' })),
    };
    const svc = scannerFor({ UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainRows('UPP', 100, 0.45, 0.9) } });
    const engine = liveDirEngine(svc, stub);
    seedTrend(engine, 'UPP', sawUp(480));

    await run(engine, ['UPP']);

    const state = engine.getState();
    // The mirror submitted, Tradier canceled → the paper open is rolled back.
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.options.dailyOptionsCount).toBe(0);
    // The suppressed signal is surfaced with a live skip reason, not silently dropped.
    const surfaced = state.signals.find(s => s.liveSkipReason);
    expect(surfaced).toBeDefined();
    expect(surfaced!.mode).toBe('live');
    expect(surfaced!.liveSkipReason).toMatch(/rejected|insufficient/i);
  });

  it('live + flag ON but OPTION_LIVE_TEST_UNTIL unset — the arm stays closed at the ORDER SITE (TRA-4288): no open, no broker call', async () => {
    // The unit controls on isOptionLiveDirectionalArmed prove flag-alone refuses;
    // this locks the same fact where it spends money. Without it, the arm's
    // window conjunct is invisible in this suite — which is exactly how the two
    // armed tests above went red for five days before anyone attributed it
    // (TRA-4394).
    process.env[OPTION_LIVE_DIRECTIONAL_FLAG] = '1';
    // OPTION_LIVE_TEST_UNTIL deliberately absent (beforeEach cleared it).
    const stub: DirLiveStub = {
      getAccountBalance: vi.fn().mockResolvedValue({ totalEquity: 25_000, totalCash: 25_000, optionBuyingPower: 25_000 }),
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'UPPC100', bid: 0.86, ask: 0.94 }),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 57, status: 'ok' }),
      cancelOrder: vi.fn(),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 57, status: 'filled', exec_quantity: 1, avg_fill_price: 0.91 })),
    };
    const svc = scannerFor({ UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainRows('UPP', 100, 0.45, 0.9) } });
    const engine = liveDirEngine(svc, stub);
    seedTrend(engine, 'UPP', sawUp(480));

    await run(engine, ['UPP']);

    expect(engine.getState().options.openOptions).toHaveLength(0);
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
  });

  // ── TRA-2295 (parent TRA-2291) — the spread ceiling, enforced at the ENTRY ────
  //
  // THE BUG: this sleeve's 0.10 `maxSpreadPct` lives at `relative-value.ts:396`,
  // inside the RV scanner's `prepareChain` — reachable only from `scan()`. The
  // directional path reads `getSelectorChain`, which returns RAW chain rows. So the
  // ceiling was inherited from code that never ran, and 59 of 83 live desk entries
  // crossed it (worst 1.933 = 19×, on a book quoted bid 0.01 / ask 0.59).
  //
  // These tests are built around the thing that made the bug survive 83 fills: a
  // gate that never runs and a gate with nothing to reject produce the SAME reading.
  // So every assertion below is paired with its opposite state — a wide chain that
  // must be refused AND a tight chain that must fill, the counter in each case — and
  // the kill-switch test is the mutation control proving the wide fixture is refused
  // BY THIS GATE and not by some unrelated guard upstream.
  describe('spread ceiling on the directional entry path (TRA-2295)', () => {
    beforeEach(() => {
      clearCostAwareGateLedger();
      delete process.env['OPTION_SPREAD_CEILING_ENFORCE'];
      delete process.env['OPTION_SPREAD_CEILING_MIN_BID_USD'];
    });
    afterEach(() => {
      clearCostAwareGateLedger();
      delete process.env['OPTION_SPREAD_CEILING_ENFORCE'];
      delete process.env['OPTION_SPREAD_CEILING_MIN_BID_USD'];
    });

    /**
     * A chain whose rows carry an EXPLICIT bid/ask, so the spread is the variable
     * under test. `halfWidthPct` is each side's offset from the mid, i.e. the row's
     * `spreadPct` is `2 * halfWidthPct`.
     */
    function chainWithSpread(sym: string, spot: number, halfWidthPct: number, midFloor = 2.0) {
      const rows = [];
      for (let k = spot - 5; k <= spot + 5; k += 1) {
        const putMid = Math.max(k - spot, 0) + midFloor;
        const callMid = Math.max(spot - k, 0) + midFloor;
        rows.push({ optionSymbol: `${sym}P${k}`, underlying: sym, optionType: 'put' as const, strike: k, expiration: '2024-07-19', bid: putMid * (1 - halfWidthPct), ask: putMid * (1 + halfWidthPct), openInterest: 1000, smvVol: 0.45 });
        rows.push({ optionSymbol: `${sym}C${k}`, underlying: sym, optionType: 'call' as const, strike: k, expiration: '2024-07-19', bid: callMid * (1 - halfWidthPct), ask: callMid * (1 + halfWidthPct), openInterest: 1000, smvVol: 0.45 });
      }
      return rows;
    }

    function directionalRow() {
      return summarizeCostAwareGate(etDateString(new Date()))
        .byStructure.find(s => s.structure === 'single_leg_directional');
    }

    // The regression itself: the exact shape of the worst live fill (SOXS at
    // spreadPct 1.933) must not reach the book.
    it('REFUSES a contract above the 0.10 ceiling — the 83-fill leak', async () => {
      process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
      // halfWidth 0.40 ⇒ spreadPct 0.80, 8× the ceiling. Comfortably inside the
      // 1.933 the live journal actually admitted.
      const svc = scannerFor({ UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainWithSpread('UPP', 100, 0.40) } });
      const engine = new SignalEngine(undefined, undefined, svc);
      seedTrend(engine, 'UPP', sawUp(480));

      await run(engine, ['UPP']);

      expect(engine.getState().options.openOptions).toHaveLength(0);
      const row = directionalRow();
      // NOT just `rejected > 0` — `evaluated` is the field that says the gate RAN.
      expect(row!.spreadCeilingEvaluated).toBe(1);
      expect(row!.spreadCeilingRejected).toBe(1);
      expect(row!.spreadCeilingRejectsByCode).toEqual({ max_spread_pct: 1 });
      // Nothing was admitted, so there is no admitted maximum to report. `null`,
      // not 0 — a 0 here would read as "admitted something with no spread".
      expect(row!.maxAdmittedSpreadPct).toBeNull();
    });

    // The POSITIVE CONTROL. Without this, "no opens" could just as well mean the
    // fixture never produced a candidate — which is how an inert gate passes for
    // an enforcing one.
    it('ADMITS a contract inside the ceiling, and reports the max it let through', async () => {
      process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
      // halfWidth 0.02 ⇒ spreadPct 0.04, inside 0.10.
      const svc = scannerFor({ UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainWithSpread('UPP', 100, 0.02) } });
      const engine = new SignalEngine(undefined, undefined, svc);
      seedTrend(engine, 'UPP', sawUp(480));

      await run(engine, ['UPP']);

      expect(engine.getState().options.openOptions).toHaveLength(1);
      const row = directionalRow();
      expect(row!.spreadCeilingEvaluated).toBe(1);
      expect(row!.spreadCeilingRejected).toBe(0);
      // THE INVARIANT the ticket's verification step asks for, readable off the
      // health route instead of re-derived from the journal.
      expect(row!.maxAdmittedSpreadPct).toBeLessThanOrEqual(0.10);
      expect(row!.maxAdmittedSpreadPct).toBeCloseTo(0.04, 6);
      // "Ran and rejected nothing" is a RATE of 0; "never ran" is not a rate at all.
      expect(row!.spreadCeilingRejectRate).toBe(0);
    });

    // MUTATION CONTROL — disarm only the gate and the same fixture fills. This is
    // what proves the refusal above is attributable to the spread ceiling rather
    // than to the quality gate, the churn brake, sizing, or the trading window.
    it('kill switch OFF — the SAME over-ceiling chain fills, and nothing is counted', async () => {
      process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
      process.env['OPTION_SPREAD_CEILING_ENFORCE'] = '0';
      const svc = scannerFor({ UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainWithSpread('UPP', 100, 0.40) } });
      const engine = new SignalEngine(undefined, undefined, svc);
      seedTrend(engine, 'UPP', sawUp(480));

      await run(engine, ['UPP']);

      expect(engine.getState().options.openOptions).toHaveLength(1);
      // And the telemetry reports the disarmed state HONESTLY: no structure row at
      // all, so `spreadCeilingEvaluated` is absent rather than a reassuring 0
      // sitting next to a book full of over-ceiling fills. That absence IS the
      // pre-TRA-2295 production reading.
      expect(directionalRow()).toBeUndefined();
    });

    // Requirement 2: the ceiling alone is not enough. This quote's spreadPct is
    // 0.0952 — INSIDE 0.10 — on a book quoted 5¢ bid. `bid 0.05 / ask 2.75` was a
    // real admitted contract (QTTB); a ratio test is the wrong instrument for it.
    it('REFUSES a sub-dime bid that passes the ratio test — an absent market, not a wide one', async () => {
      process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
      const svc = scannerFor({ UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainWithSpread('UPP', 100, 0.0476, 0.0525) } });
      const engine = new SignalEngine(undefined, undefined, svc);
      seedTrend(engine, 'UPP', sawUp(480));

      await run(engine, ['UPP']);

      expect(engine.getState().options.openOptions).toHaveLength(0);
      const row = directionalRow();
      expect(row!.spreadCeilingRejected).toBe(1);
      // Attributed to the LEVEL, not the ratio — the ratio would have passed it.
      expect(row!.spreadCeilingRejectsByCode).toEqual({ min_bid: 1 });
      expect(row!.avgRejectedSpreadPct!).toBeLessThan(0.10);
    });

    // The journal-side check the ticket's verification step runs against live rows,
    // executed here against a mixed chain: the sleeve must fill the tight name and
    // refuse the wide one in the SAME pass, so a zero-open outcome cannot be
    // mistaken for a dead scan.
    it('mixed pass — fills the quotable name, refuses the wide one, 0 rows over ceiling', async () => {
      process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
      const svc = scannerFor({
        UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainWithSpread('UPP', 100, 0.02) },
        DWN: { symbol: 'DWN', spot: 300, expiration: '2024-07-19', rows: chainWithSpread('DWN', 300, 0.45) },
      });
      const engine = new SignalEngine(undefined, undefined, svc);
      seedTrend(engine, 'UPP', sawUp(480));
      seedTrend(engine, 'DWN', sawDown(480));

      await run(engine, ['UPP', 'DWN']);

      const open = engine.getState().options.openOptions;
      expect(open).toHaveLength(1);
      expect(open[0]!.symbol).toBe('UPP');
      const row = directionalRow();
      expect(row!.spreadCeilingEvaluated).toBe(2);
      expect(row!.spreadCeilingRejected).toBe(1);
      expect(row!.maxAdmittedSpreadPct).toBeLessThanOrEqual(0.10);
    });

    // ── TRA-2338 — the row on the surface TRA-2306 ACTUALLY GRADES ────────────
    //
    // Every assertion above reads the DAY view (`byStructure`). TRA-2306's verdict
    // rule reads `retained.byStructure` — the multi-day roll — and after five armed
    // RTH sessions prod had never shown a `single_leg_directional` row there at all
    // (only `directional` and `single_leg_otm`), which is indistinguishable from
    // "this key can never appear". It can: the roll folds through the same
    // `foldStructures`, and the gate call site and the journal stamp both key off
    // the ONE `DIRECTIONAL_STRUCTURE_LABEL` constant. Pinned here so the graded
    // field is covered directly rather than by inference from the day view.
    it('the RETAINED roll — the field TRA-2306 grades — carries the single_leg_directional row', async () => {
      // Negative control FIRST: absent before the path runs, so the assertion
      // below has a failing state and is not green by construction.
      const before = summarizeCostAwareGate(etDateString(new Date()))
        .retained.byStructure.find(s => s.structure === 'single_leg_directional');
      expect(before).toBeUndefined();

      process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
      const svc = scannerFor({ UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainWithSpread('UPP', 100, 0.02) } });
      const engine = new SignalEngine(undefined, undefined, svc);
      seedTrend(engine, 'UPP', sawUp(480));

      await run(engine, ['UPP']);

      const retained = summarizeCostAwareGate(etDateString(new Date())).retained;
      const row = retained.byStructure.find(s => s.structure === 'single_leg_directional');
      expect(row).toBeDefined();
      expect(row!.spreadCeilingEvaluated).toBeGreaterThanOrEqual(1);
      expect(retained.spreadCeilingEvaluatedTotal).toBeGreaterThanOrEqual(1);
      expect(row!.maxAdmittedSpreadPct).toBeLessThanOrEqual(0.10);
    });

    // TRA-2338 — the ORDERING invariant that makes the two rows cross-checkable.
    //
    // The spread gate runs at `evaluateDemoDirectional` BEFORE the cost bar's
    // `recordCostAwareGateDecision('directional', …)`, with no `continue` between
    // them other than the spread gate's own refusal. So a `directional` row cannot
    // accrue a decision that the spread gate did not rule on first: on any armed
    // day `single_leg_directional.spreadCeilingEvaluated >= directional.decisions`.
    // A live read where the `directional` row moves and `single_leg_directional`
    // does NOT is therefore not a quiet day — it is a broken gate.
    it('the spread gate is UPSTREAM of the cost bar — directional decisions can never outrun spreadCeilingEvaluated', async () => {
      process.env[OPTION_DEMO_DIRECTIONAL_FLAG] = 'true';
      process.env['ENABLE_OPTION_COST_AWARE_GATE'] = '1'; // the `directional` row's only writer
      try {
        const svc = scannerFor({
          UPP: { symbol: 'UPP', spot: 100, expiration: '2024-07-19', rows: chainWithSpread('UPP', 100, 0.02) },
          DWN: { symbol: 'DWN', spot: 300, expiration: '2024-07-19', rows: chainWithSpread('DWN', 300, 0.02) },
        });
        const engine = new SignalEngine(undefined, undefined, svc);
        seedTrend(engine, 'UPP', sawUp(480));
        seedTrend(engine, 'DWN', sawDown(480));

        await run(engine, ['UPP', 'DWN']);

        const retained = summarizeCostAwareGate(etDateString(new Date())).retained;
        const dir = retained.byStructure.find(s => s.structure === 'directional');
        const spread = retained.byStructure.find(s => s.structure === 'single_leg_directional');
        // Both keys are populated by the SAME loop iteration — the split is naming,
        // not routing. (This is the pair prod showed as `directional` present /
        // `single_leg_directional` absent, on decisions recorded before the gate existed.)
        expect(dir).toBeDefined();
        expect(spread).toBeDefined();
        expect(dir!.admitted + dir!.rejected).toBeGreaterThanOrEqual(1);
        expect(spread!.spreadCeilingEvaluated).toBeGreaterThanOrEqual(dir!.admitted + dir!.rejected);
        // And the cost bar's own counters stay OFF the spread axis (four disjoint axes).
        expect(dir!.spreadCeilingEvaluated).toBe(0);
      } finally {
        delete process.env['ENABLE_OPTION_COST_AWARE_GATE'];
      }
    });
  });
});

// TRA-327 — regression-lock the demo↔live daily-trade-limit isolation contract.
// The reporter's symptom was that editing the Demo "Stock/Options Daily Trades
// Limit" dragged the Live caps along, because the engine read the single
// un-suffixed field in both modes. The fix split each cap into a `*Live`
// counterpart and routes the engine through `activeEquityDailyLimit` /
// `activeOptionsDailyLimit`, which select by `settings.mode` and fall back to
// the legacy demo field ONLY when the live value was never saved (back-compat).
//
// These tests fail if the selector is ever rewired to read the demo field in
// live mode, or to stop falling back for pre-TRA-327 saved settings.
describe('activeEquityDailyLimit / activeOptionsDailyLimit mode isolation (TRA-327)', () => {
  it('demo mode reads the un-suffixed demo caps and ignores the live caps entirely', () => {
    const s: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      dailyTradesLimit: 5,
      optionsDailyTradesLimit: 3,
      dailyTradesLimitLive: 99,
      optionsDailyTradesLimitLive: 88,
    };
    expect(activeEquityDailyLimit(s)).toBe(5);
    expect(activeOptionsDailyLimit(s)).toBe(3);
  });

  it('live mode reads the *Live caps and ignores the demo caps entirely', () => {
    const s: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      dailyTradesLimit: 5,
      optionsDailyTradesLimit: 3,
      dailyTradesLimitLive: 12,
      optionsDailyTradesLimitLive: 7,
    };
    expect(activeEquityDailyLimit(s)).toBe(12);
    expect(activeOptionsDailyLimit(s)).toBe(7);
  });

  it('editing the demo caps does not change what live mode resolves (the reporter symptom)', () => {
    // Same saved live caps; only the demo caps differ between the two snapshots.
    // The live-resolved value must be identical — proving a Demo edit can never
    // drag the Live cap along.
    const base: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      dailyTradesLimitLive: 20,
      optionsDailyTradesLimitLive: 9,
    };
    const beforeDemoEdit: AccountSettings = { ...base, dailyTradesLimit: 10, optionsDailyTradesLimit: 10 };
    const afterDemoEdit: AccountSettings = { ...base, dailyTradesLimit: 1, optionsDailyTradesLimit: 2 };
    expect(activeEquityDailyLimit(afterDemoEdit)).toBe(activeEquityDailyLimit(beforeDemoEdit));
    expect(activeOptionsDailyLimit(afterDemoEdit)).toBe(activeOptionsDailyLimit(beforeDemoEdit));
    expect(activeEquityDailyLimit(afterDemoEdit)).toBe(20);
    expect(activeOptionsDailyLimit(afterDemoEdit)).toBe(9);
  });

  it('live mode falls back to the demo cap for settings saved before TRA-327 (no *Live value)', () => {
    // A pre-TRA-327 file only carried the un-suffixed fields. Stripping the
    // `*Live` keys must surface the legacy demo cap instead of undefined, so an
    // existing live user keeps a sane limit rather than losing their cap.
    const legacy = { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live', dailyTradesLimit: 15, optionsDailyTradesLimit: 6 } as AccountSettings;
    delete (legacy as Partial<AccountSettings>).dailyTradesLimitLive;
    delete (legacy as Partial<AccountSettings>).optionsDailyTradesLimitLive;
    expect(activeEquityDailyLimit(legacy)).toBe(15);
    expect(activeOptionsDailyLimit(legacy)).toBe(6);
  });

  it('options selector returns undefined and equity selector defaults to 10 when no settings exist', () => {
    // Defensive: the engine constructs accounts before settings load on cold
    // boot. The options cap is optional (undefined ⇒ PaperOptionsAccount uses
    // its own default); the equity cap must never be undefined.
    expect(activeOptionsDailyLimit(undefined)).toBeUndefined();
    expect(activeEquityDailyLimit(undefined)).toBe(10);
  });
});

// TRA-1203 — board: "try mispriced options for the rest of the week instead of
// relative value". The TRA-1156 IV-vs-realised-vol scan was observe-only; this
// proves the new routing sub-flag turns the strongest BUY_PREMIUM (IV cheap vs
// realised → premium underpriced) candidate into a REAL demo paper open,
// journal-tagged `iv-rv-buy-premium` so it attributes separately from bare
// `single_leg_rv`, and stays wholly observe-only (no fills) when routing is off.
describe('SignalEngine — IV-RV mispriced routing (TRA-1203)', () => {
  // A liquid chain whose contracts carry a DELIBERATELY LOW implied vol (smvVol),
  // so against a high realised vol they price as BUY_PREMIUM (cheap premium).
  function cheapVolChain(sym: string, spot: number, iv = 0.18) {
    const rows = [];
    const extrinsic = (kStrike: number) => Math.max(0.3, 2.0 - 0.08 * Math.abs(kStrike - spot));
    for (let kStrike = spot - 5; kStrike <= spot + 5; kStrike += 1) {
      const callMid = Math.max(spot - kStrike, 0) + extrinsic(kStrike);
      const putMid = Math.max(kStrike - spot, 0) + extrinsic(kStrike);
      rows.push({ optionSymbol: `${sym}C${kStrike}`, underlying: sym, optionType: 'call' as const, strike: kStrike, expiration: '2024-07-19', bid: callMid * 0.99, ask: callMid * 1.01, openInterest: 5000, volume: 800, smvVol: iv });
      rows.push({ optionSymbol: `${sym}P${kStrike}`, underlying: sym, optionType: 'put' as const, strike: kStrike, expiration: '2024-07-19', bid: putMid * 0.99, ask: putMid * 1.01, openInterest: 5000, volume: 800, smvVol: iv });
    }
    return rows;
  }
  // Daily closes alternating ±5% → high realised vol (~0.79 annualised), so the
  // 0.18 contract IV is well under realised → BUY_PREMIUM with a deep negative
  // mispricingPct (mark far below the realised-vol BS fair value).
  function highRvCloses(n = 40): number[] {
    const closes: number[] = [];
    for (let i = 0; i < n; i++) closes.push(i % 2 === 0 ? 100 : 105);
    return closes;
  }
  function scannerFor(snaps: Record<string, SelectorChainSnapshot>): RelativeValueScannerService {
    return {
      scan: vi.fn(async () => ({ symbol: '', spot: null, expiration: null, candidates: [], reason: 'ok' as const })),
      scanOtm: vi.fn(async () => ({ symbol: '', spot: null, expiration: null, candidates: [], reason: 'unavailable' as const })),
      getSelectorChain: vi.fn(async (sym: string) => snaps[sym] ?? null),
      getOptionMark: vi.fn(async () => null),
      diagnostics: vi.fn(() => ({ configured: true, breakerOpen: false, breakerOpenedAtMs: null, cacheSize: 0, expirationsCacheSize: 0, chainCacheMaxEntries: 64, expirationsCacheMaxEntries: 64 })),
    };
  }
  function runScan(engine: SignalEngine, syms: string[]): Promise<void> {
    return (engine as unknown as { evaluateIvRvScan: (s: string[]) => Promise<void> }).evaluateIvRvScan(syms);
  }
  function seedCloses(engine: SignalEngine, sym: string, closes: number[]): void {
    (engine as unknown as { dailyCloseCache: Map<string, number[]> }).dailyCloseCache.set(sym, closes);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME);
    delete process.env[OPTION_IV_RV_SCANNER_FLAG];
    delete process.env[OPTION_IV_RV_ROUTING_FLAG];
  });
  afterEach(() => {
    delete process.env[OPTION_IV_RV_SCANNER_FLAG];
    delete process.env[OPTION_IV_RV_ROUTING_FLAG];
    vi.useRealTimers();
  });

  it('scanner ON, routing OFF — observe-only, opens nothing', async () => {
    process.env[OPTION_IV_RV_SCANNER_FLAG] = '1';
    const svc = scannerFor({ AAA: { symbol: 'AAA', spot: 100, expiration: '2024-07-19', rows: cheapVolChain('AAA', 100) } });
    const engine = new SignalEngine(undefined, undefined, svc);
    seedCloses(engine, 'AAA', highRvCloses());
    await runScan(engine, ['AAA']);
    expect(engine.getState().options.openOptions).toHaveLength(0);
  });

  it('scanner + routing ON — opens the BUY_PREMIUM contract on the demo book', async () => {
    process.env[OPTION_IV_RV_SCANNER_FLAG] = '1';
    process.env[OPTION_IV_RV_ROUTING_FLAG] = '1';
    const svc = scannerFor({ AAA: { symbol: 'AAA', spot: 100, expiration: '2024-07-19', rows: cheapVolChain('AAA', 100) } });
    const engine = new SignalEngine(undefined, undefined, svc);
    seedCloses(engine, 'AAA', highRvCloses());
    await runScan(engine, ['AAA']);
    const open = engine.getState().options.openOptions;
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open[0].symbol).toBe('AAA');
    // Surfaced in the signals feed (reflected in the probe's optionSignalCount).
    const sigs = engine.getState().signals.filter(s => s.type === 'relative_value');
    expect(sigs.length).toBeGreaterThanOrEqual(1);
    expect((sigs[0] as { reason?: string }).reason).toContain('iv-rv mispriced');
  });

  it('routing ON + journal ON — open is tagged entryArchetype iv-rv-buy-premium', async () => {
    process.env[OPTION_IV_RV_SCANNER_FLAG] = '1';
    process.env[OPTION_IV_RV_ROUTING_FLAG] = '1';
    process.env[OPTION_TRADE_JOURNAL_FLAG] = '1';
    const journalFile = join(tmpdir(), `tra1203-journal-${process.pid}.jsonl`);
    setOptionTradeJournalFileForTests(journalFile);
    try {
      const svc = scannerFor({ AAA: { symbol: 'AAA', spot: 100, expiration: '2024-07-19', rows: cheapVolChain('AAA', 100) } });
      const engine = new SignalEngine(undefined, undefined, svc);
      seedCloses(engine, 'AAA', highRvCloses());
      await runScan(engine, ['AAA']);
      await engine.flushOptionTradeJournal();
      const rows = await listOptionTradeJournal();
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every(r => r.entryArchetype === 'iv-rv-buy-premium')).toBe(true);
      // TRA-2245 — a directional mispriced-value buy journals `single_leg_directional`.
      expect(rows.every(r => r.structure === 'single_leg_directional')).toBe(true);
      expect(rows.every(r => r.outcome === 'OPEN')).toBe(true);
    } finally {
      delete process.env[OPTION_TRADE_JOURNAL_FLAG];
      setOptionTradeJournalFileForTests(null);
      rmSync(journalFile, { force: true });
    }
  });

  it('routing ON but realised vol uncomputable (no closes + cold feed) — stands down, opens nothing', async () => {
    process.env[OPTION_IV_RV_SCANNER_FLAG] = '1';
    process.env[OPTION_IV_RV_ROUTING_FLAG] = '1';
    const svc = scannerFor({ AAA: { symbol: 'AAA', spot: 100, expiration: '2024-07-19', rows: cheapVolChain('AAA', 100) } });
    const engine = new SignalEngine(undefined, undefined, svc);
    // No daily closes seeded AND the backfill feed is cold (mock → []) ⇒
    // realizedVol null ⇒ no candidates ⇒ no route.
    vi.mocked(fetchDailyCandles).mockResolvedValueOnce([]);
    await runScan(engine, ['AAA']);
    expect(engine.getState().options.openOptions).toHaveLength(0);
  });

  // TRA-1226 — the fix under test: when dailyCloseCache is cold for an iv-rv scan
  // symbol (the common case — the 128-symbol option universe is not the set the
  // technical-snapshot pass warms), the scan backfills daily closes directly from
  // the equity feed so realizedVol is non-null and candidates can flow. Without
  // this the whole book short-circuits at `no_realized_vol` and 0 candidates.
  it('cold cache — backfills daily closes from the feed so RV is non-null and it routes', async () => {
    process.env[OPTION_IV_RV_SCANNER_FLAG] = '1';
    process.env[OPTION_IV_RV_ROUTING_FLAG] = '1';
    const svc = scannerFor({ AAA: { symbol: 'AAA', spot: 100, expiration: '2024-07-19', rows: cheapVolChain('AAA', 100) } });
    const engine = new SignalEngine(undefined, undefined, svc);
    // Cache intentionally NOT seeded. The feed returns a high-RV close series so
    // the 0.18 contract IV prices as BUY_PREMIUM.
    const bars: Candle[] = highRvCloses().map((c, i) => ({
      symbol: 'AAA', timestamp: i * 86_400_000, open: c, high: c, low: c, close: c, volume: 0,
    }));
    vi.mocked(fetchDailyCandles).mockResolvedValueOnce(bars);
    await runScan(engine, ['AAA']);
    expect(fetchDailyCandles).toHaveBeenCalledWith('AAA', expect.any(Number));
    const open = engine.getState().options.openOptions;
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open[0].symbol).toBe('AAA');
    // And the backfilled series is now cached so the next pass rides it (no re-fetch).
    vi.mocked(fetchDailyCandles).mockClear();
    await runScan(engine, ['AAA']);
    expect(fetchDailyCandles).not.toHaveBeenCalled();
  });

  // TRA-1230 — on Render, Yahoo's per-IP feed 429s ~permanently so `fetchDailyCandles`
  // returns [] every pass and the backfill never fills. The scan must fall back to
  // Tradier daily history (the reliable Render source) so RV is still non-null and
  // candidates flow. Without the fallback the whole book stays at no_realized_vol.
  it('Yahoo cold — falls back to Tradier daily history so RV is non-null and it routes', async () => {
    process.env[OPTION_IV_RV_SCANNER_FLAG] = '1';
    process.env[OPTION_IV_RV_ROUTING_FLAG] = '1';
    const svc = scannerFor({ AAA: { symbol: 'AAA', spot: 100, expiration: '2024-07-19', rows: cheapVolChain('AAA', 100) } });
    const engine = new SignalEngine(undefined, undefined, svc);
    const bars: Candle[] = highRvCloses().map((c, i) => ({
      symbol: 'AAA', timestamp: i * 86_400_000, open: c, high: c, low: c, close: c, volume: 0,
    }));
    // Yahoo returns nothing (breaker open); Tradier serves the series.
    vi.mocked(fetchDailyCandles).mockResolvedValueOnce([]);
    vi.mocked(fetchTradierDailyCandles).mockResolvedValueOnce(bars);
    await runScan(engine, ['AAA']);
    expect(fetchDailyCandles).toHaveBeenCalledWith('AAA', expect.any(Number));
    expect(fetchTradierDailyCandles).toHaveBeenCalledWith('AAA', expect.any(Number));
    const open = engine.getState().options.openOptions;
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open[0].symbol).toBe('AAA');
    // Cached now → next pass hits neither feed.
    vi.mocked(fetchDailyCandles).mockClear();
    vi.mocked(fetchTradierDailyCandles).mockClear();
    await runScan(engine, ['AAA']);
    expect(fetchDailyCandles).not.toHaveBeenCalled();
    expect(fetchTradierDailyCandles).not.toHaveBeenCalled();
  });
});

// TRA-1408 (parent TRA-1406) — the per-name churn + same-day-loss brake. The
// open-cap counter, the same-day-loss test, and the per-name ET-day realized
// roll-up are private, so drive them via the same private-accessor cast the rest
// of this suite uses. The wiring (open chokepoints / DCA add loops) is DEMO-scoped
// and DARK unless ENABLE_CHURN_LOSS_BRAKE, which the 217 baseline tests confirm.
describe('SignalEngine — churn + same-day-loss brake (TRA-1408)', () => {
  type ChurnInternals = {
    mode: 'demo' | 'live';
    churnOpenCapVerdict: (symbol: string, now?: number) => { blocked: boolean; count: number; cap: number };
    recordChurnOpen: (symbol: string, sleeve?: 'directional' | 'other', now?: number) => void;
    isSameDayLoser: (realizedToday: number, unrealized: number) => boolean;
    realizedEquityPnlToday: (symbol: string, etDay: string) => number;
    allClosedPositions: Array<{ symbol: string; pnl?: number; closedAt?: number; mode?: 'demo' | 'live' }>;
  };
  const etDayNow = (): string =>
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['ENABLE_CHURN_LOSS_BRAKE', 'CHURN_SAME_SESSION_OPEN_CAP', 'DATA_DIR']) {
      savedEnv[k] = process.env[k];
    }
    // Route flag resolution straight through process.env (no demo-flags.json file).
    delete process.env.DATA_DIR;
    // TRA-1486 — the per-name cap now reads the module-global DURABLE open ledger
    // (max of in-memory + persisted) so it survives reboots. That store is process-
    // global, so reset it between cases to keep the per-name counts hermetic.
    clearDirectionalOpenLedger();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('is a no-op when the flag is off (never blocks a new open)', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const inner = engine as unknown as ChurnInternals;
    delete process.env.ENABLE_CHURN_LOSS_BRAKE;
    // Even after many opens the cap never binds while dark.
    for (let i = 0; i < 10; i++) inner.recordChurnOpen('GIS');
    expect(inner.churnOpenCapVerdict('GIS').blocked).toBe(false);
  });

  it('blocks a NEW open once a name hits the cap (default N=3); other names are independent', () => {
    process.env.ENABLE_CHURN_LOSS_BRAKE = '1';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const inner = engine as unknown as ChurnInternals;

    // 0,1,2 opens all admitted; the 3rd puts the name at the cap and the next is blocked.
    expect(inner.churnOpenCapVerdict('GIS')).toMatchObject({ blocked: false, count: 0, cap: 3 });
    inner.recordChurnOpen('GIS');
    inner.recordChurnOpen('GIS');
    expect(inner.churnOpenCapVerdict('GIS')).toMatchObject({ blocked: false, count: 2 });
    inner.recordChurnOpen('GIS'); // count → 3 == cap
    expect(inner.churnOpenCapVerdict('GIS')).toMatchObject({ blocked: true, count: 3, cap: 3 });
    // A different underlier is unaffected by GIS's churn.
    expect(inner.churnOpenCapVerdict('AAPL').blocked).toBe(false);
  });

  it('honours the CHURN_SAME_SESSION_OPEN_CAP override', () => {
    process.env.ENABLE_CHURN_LOSS_BRAKE = 'true';
    process.env.CHURN_SAME_SESSION_OPEN_CAP = '1';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const inner = engine as unknown as ChurnInternals;
    expect(inner.churnOpenCapVerdict('GIS').cap).toBe(1);
    inner.recordChurnOpen('GIS');
    expect(inner.churnOpenCapVerdict('GIS').blocked).toBe(true);
  });

  it('never binds on the LIVE path (demo-scoped by construction)', () => {
    process.env.ENABLE_CHURN_LOSS_BRAKE = '1';
    process.env.CHURN_SAME_SESSION_OPEN_CAP = '1';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'live' });
    const inner = engine as unknown as ChurnInternals;
    inner.recordChurnOpen('GIS'); // no-op on live
    inner.recordChurnOpen('GIS');
    expect(inner.churnOpenCapVerdict('GIS').blocked).toBe(false);
  });

  it('same-day-loss test: net-negative (realized + unrealized) halts, non-negative allows', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const inner = engine as unknown as ChurnInternals;
    expect(inner.isSameDayLoser(-100, -50)).toBe(true);   // both negative → loser
    expect(inner.isSameDayLoser(-100, 40)).toBe(true);    // still net negative
    expect(inner.isSameDayLoser(-100, 100)).toBe(false);  // clawed back to flat → allow
    expect(inner.isSameDayLoser(200, -50)).toBe(false);   // net positive → allow
  });

  it('rolls up per-name ET-day realized from demo closes only, scoped to today', () => {
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' });
    const inner = engine as unknown as ChurnInternals;
    const today = Date.now();
    const yesterday = today - 24 * 3600 * 1000;
    inner.allClosedPositions.push(
      { symbol: 'GIS', pnl: -800, closedAt: today, mode: 'demo' },
      { symbol: 'GIS', pnl: -1436, closedAt: today, mode: 'demo' },  // GIS bleed today
      { symbol: 'GIS', pnl: 500, closedAt: yesterday, mode: 'demo' }, // prior day — excluded
      { symbol: 'GIS', pnl: 999, closedAt: today, mode: 'live' },     // live — excluded
      { symbol: 'AAPL', pnl: 300, closedAt: today, mode: 'demo' },    // other name
    );
    const etDay = etDayNow();
    expect(inner.realizedEquityPnlToday('GIS', etDay)).toBe(-2236); // matches the issue's proof case
    expect(inner.realizedEquityPnlToday('AAPL', etDay)).toBe(300);
    expect(inner.realizedEquityPnlToday('MSFT', etDay)).toBe(0);
  });
});

// ─── TRA-1929 — live OTM bounded-test buy-to-open mirror + guardrails ──────────
// The board (TRA-1916) authorized a bounded 2-day real-money OTM test. These
// integration tests pin the CODE guardrails (not config trust): fail-closed when
// the flag is off OR the self-expiring window is closed; the entry limit is the
// ASK (never a market cross); a 1-contract notional over min(cash,$268.58) is
// skipped; and an armed fill writes exactly one calibration ledger row.
describe('SignalEngine — TRA-1929 live OTM bounded-test buy-to-open mirror', () => {
  const OTM_ENV = [OPTION_LIVE_OTM_FLAG, OPTION_LIVE_TEST_UNTIL_VAR] as const;
  const savedOtmEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of OTM_ENV) savedOtmEnv[k] = process.env[k];
    clearLiveOptionsFeeSlippageLedger();
  });
  afterEach(() => {
    for (const k of OTM_ENV) {
      if (savedOtmEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedOtmEnv[k];
    }
    clearLiveOptionsFeeSlippageLedger();
  });

  interface OtmLiveStub {
    getOptionQuote: ReturnType<typeof vi.fn>;
    buyContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }

  const RICH_BALANCE = {
    totalEquity: 268.58, totalCash: 268.58, optionBuyingPower: 268.58, dayTradeBuyingPower: 268.58,
  };

  function fillStub(): OtmLiveStub {
    return {
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'AAPL240705C00210000', bid: 0.78, ask: 0.82 }),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 42, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 42, status: 'filled', avg_fill_price: 0.82 })),
    };
  }

  function otmScanner(candidate = makeOtmCandidate()): StubScanner {
    const scanner = new StubScanner();
    scanner.scanOtm.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05', candidates: [candidate], reason: 'ok',
    });
    return scanner;
  }

  function setupLiveOtmEngine(stub: OtmLiveStub, scanner: StubScanner): SignalEngine {
    const engine = new SignalEngine(undefined, undefined, scanner);
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    (engine as unknown as { liveTradierBalance: unknown }).liveTradierBalance = RICH_BALANCE;
    return engine;
  }

  const runOtm = (engine: SignalEngine, syms: string[]) =>
    (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(syms);

  it('dark default (flag OFF) places NO broker order and surfaces a skip-reason signal', async () => {
    delete process.env[OPTION_LIVE_OTM_FLAG];
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = FAR_FUTURE_TEST_UNTIL;
    const stub = fillStub();
    const engine = setupLiveOtmEngine(stub, otmScanner());
    await runOtm(engine, ['AAPL']);
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.signals[0]!.liveSkipReason).toMatch(/dark/);
    expect(summarizeLiveOptionsFeeSlippage().n).toBe(0);
  });

  it('window EXPIRED (flag ON, OPTION_LIVE_TEST_UNTIL in the past) places NO order (fail-closed)', async () => {
    process.env[OPTION_LIVE_OTM_FLAG] = '1';
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = '1'; // epoch 1ms — long past
    const stub = fillStub();
    const engine = setupLiveOtmEngine(stub, otmScanner());
    await runOtm(engine, ['AAPL']);
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    expect(engine.getState().options.openOptions).toHaveLength(0);
  });

  it('window UNSET (flag ON, OPTION_LIVE_TEST_UNTIL absent) places NO order (fail-closed)', async () => {
    process.env[OPTION_LIVE_OTM_FLAG] = '1';
    delete process.env[OPTION_LIVE_TEST_UNTIL_VAR];
    const stub = fillStub();
    const engine = setupLiveOtmEngine(stub, otmScanner());
    await runOtm(engine, ['AAPL']);
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
  });

  it('oversize 1-contract ask notional over min(cash, $268.58) is skipped, no order', async () => {
    process.env[OPTION_LIVE_OTM_FLAG] = '1';
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = FAR_FUTURE_TEST_UNTIL;
    const stub = fillStub();
    // ask 3.00 → 1-contract notional $300 > $268.58 test cap → skip.
    const engine = setupLiveOtmEngine(
      stub,
      otmScanner(makeOtmCandidate({ mark: 2.95, bid: 2.98, ask: 3.00 })),
    );
    await runOtm(engine, ['AAPL']);
    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    expect(engine.getState().options.openOptions).toHaveLength(0);
    expect(engine.getState().signals[0]!.liveSkipReason).toMatch(/exceeds the test cap/);
  });

  it('ARMED — opens exactly 1 contract, submits the LIMIT at the ASK, writes one ledger row', async () => {
    process.env[OPTION_LIVE_OTM_FLAG] = '1';
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = FAR_FUTURE_TEST_UNTIL;
    const stub = fillStub();
    const engine = setupLiveOtmEngine(stub, otmScanner());
    await runOtm(engine, ['AAPL']);

    // ASK-only ladder: a single LIMIT at the ask (0.82) for exactly 1 contract —
    // never a market order.
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(stub.buyContractsLimit).toHaveBeenCalledWith('AAPL240705C00210000', 1, 0.82);

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0]!.contracts).toBe(1);

    const led = summarizeLiveOptionsFeeSlippage();
    expect(led.n).toBe(1);
    expect(led.opens).toBe(1);
    const rec = led.records[0]!;
    expect(rec.sleeve).toBe('single_leg_otm');
    expect(rec.side).toBe('buy_to_open');
    expect(rec.mode).toBe('live');
    expect(rec.contracts).toBe(1);
    expect(rec.filledPrice).toBe(0.82);
    expect(rec.askAtSubmit).toBe(0.82);
    expect(rec.slippageVsAsk).toBeCloseTo(0, 6); // filled exactly at the ask
    expect(rec.fees).toBeNull();                 // unmeasured at fill time (never 0)
  });
});

// ─── TRA-2763 (parent TRA-2760) — LIVE arm of the OTM entry delta floor ────────
// The TRA-1407 floor is demo-scoped (`otmScanOpts` reads the demo-flags env only),
// so real money ran with NO delta floor and filled at |delta| 0.03-0.07. These
// tests pin the live containment: OFF by default the live path is byte-for-byte
// unchanged (the flag-OFF test opens the SAME |delta| 0.12 candidate the blocked
// test rejects); armed, a below-floor live candidate places NO broker order and an
// above-floor one DOES; BOTH armed verdicts land on the `otm_delta_floor` ledger
// axis (a counter wired only to rejects cannot tell armed-and-biting from
// armed-and-never-evaluated); and the demo book never consults the live flag.
describe('SignalEngine — TRA-2763 live OTM entry delta floor', () => {
  const FLOOR_ENV = [
    OPTION_LIVE_OTM_FLAG,
    OPTION_LIVE_TEST_UNTIL_VAR,
    OPTION_OTM_DELTA_FLOOR_LIVE_FLAG,
    OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR,
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of FLOOR_ENV) savedEnv[k] = process.env[k];
    clearLiveOptionsFeeSlippageLedger();
    clearLiveEnforceGateLedger();
  });
  afterEach(() => {
    for (const k of FLOOR_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    clearLiveOptionsFeeSlippageLedger();
    clearLiveEnforceGateLedger();
  });

  interface FloorLiveStub {
    getOptionQuote: ReturnType<typeof vi.fn>;
    buyContractsLimit: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    waitForOrderTerminalStatus: ReturnType<typeof vi.fn>;
  }

  function fillStub(): FloorLiveStub {
    return {
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'AAPL240705C00210000', bid: 0.78, ask: 0.82 }),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 42, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 42, status: 'filled', avg_fill_price: 0.82 })),
    };
  }

  function otmScanner(candidate = makeOtmCandidate()): StubScanner {
    const scanner = new StubScanner();
    scanner.scanOtm.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05', candidates: [candidate], reason: 'ok',
    });
    return scanner;
  }

  function setupLiveEngine(stub: FloorLiveStub, scanner: StubScanner): SignalEngine {
    const engine = new SignalEngine(undefined, undefined, scanner);
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    (engine as unknown as { mode: 'demo' | 'live' }).mode = 'live';
    (engine as unknown as { liveTradierBalance: unknown }).liveTradierBalance = {
      totalEquity: 268.58, totalCash: 268.58, optionBuyingPower: 268.58, dayTradeBuyingPower: 268.58,
    };
    return engine;
  }

  const runOtm = (engine: SignalEngine, syms: string[]) =>
    (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(syms);

  /** The `otm_delta_floor` fold across every retained ET day (avoids re-deriving the fake-timer etDay). */
  function otmFloorGate() {
    return summarizeLiveEnforceGate('1970-01-01').retained.byGate.find((g) => g.gate === 'otm_delta_floor')!;
  }

  function armLiveOtmWindow(): void {
    process.env[OPTION_LIVE_OTM_FLAG] = '1';
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = FAR_FUTURE_TEST_UNTIL;
  }

  it('flag OFF: the armed live path is unchanged — the |delta| 0.12 candidate still opens and the floor axis records NOTHING', async () => {
    armLiveOtmWindow();
    delete process.env[OPTION_OTM_DELTA_FLOOR_LIVE_FLAG];
    const stub = fillStub();
    const engine = setupLiveEngine(stub, otmScanner()); // fixture delta 0.12 — below any plausible floor
    await runOtm(engine, ['AAPL']);

    // Same open the TRA-1929 ARMED test proves: one ask-limit contract.
    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(engine.getState().options.openOptions).toHaveLength(1);
    // Disarmed ⇒ the gate never evaluates: 0 rows, not "evaluated and passed".
    expect(otmFloorGate()).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });
    // TRA-3216 — this used to assert the ledger-wide `decisionsRecorded` was 0.
    // It is a GLOBAL counter across every gate, and the live universe allowlist
    // now records an ADMIT for AAPL on this same pass, so the ledger-wide zero is
    // no longer the right expression of "the FLOOR recorded nothing". Assert the
    // floor's own axes are empty, and pin the one row that is legitimately there.
    const retained = summarizeLiveEnforceGate('1970-01-01').retained.byGate;
    expect(retained.find((g) => g.gate === 'otm_delta_floor')!.byReason).toEqual([]);
    expect(retained.find((g) => g.gate === 'cost_bar')).toMatchObject({ evaluated: 0, blocked: 0 });
    expect(retained.find((g) => g.gate === 'universe')).toMatchObject({ evaluated: 1, blocked: 0 });
    // TRA-3445 — and a SECOND legitimate row for the same reason: the aggregate
    // cap records its ADMIT on this pass too (an empty book, $82 entry). Pin it
    // by name rather than loosening the total, so the next gate to start
    // recording here is caught the same way these two were.
    expect(retained.find((g) => g.gate === 'aggregate_cap')).toMatchObject({ evaluated: 1, blocked: 0 });
    // TRA-3836 — and a THIRD: the <=$100 canary ceiling grades every live open
    // at the broker seam and records BOTH verdicts (an $82 entry on an empty
    // book is an ADMIT). Same discipline: named row, exact total.
    expect(retained.find((g) => g.gate === 'canary_ceiling')).toMatchObject({ evaluated: 1, blocked: 0 });
    // TRA-3911 — and a FOURTH: the REACHABLE fleet bound records BOTH verdicts
    // too. Its admits are not optional bookkeeping — `admissibleBoundBy:
    // 'fleet_unreadable'` is an ADMIT, and it is the one state in which the
    // fleet term is NOT in force, so a day on which the bound was never actually
    // enforced is otherwise indistinguishable after the fact from a day on which
    // it simply never bit. Same discipline: named row, exact total.
    expect(retained.find((g) => g.gate === 'fleet_reachable_bound')).toMatchObject({ evaluated: 1, blocked: 0 });
    // TRA-3942 — and a FIFTH: the ENTRY-TIME window records both verdicts, and
    // `TRADING_TIME` (10:20 ET) is inside the morning window, so this pass is an
    // ADMIT. It is the FIRST gate on the funnel, which is what makes its
    // `evaluated` the whole nominee population rather than the ~0.7% that
    // survives the cost bar. Same discipline: named row, exact total.
    expect(retained.find((g) => g.gate === 'entry_window')).toMatchObject({ evaluated: 1, blocked: 0 });
    // TRA-3944 — and a SIXTH: the CONTRACT FLOOR records its CHAIN verdict on
    // every sweep (one row per chain surveyed), and it sits ABOVE the window —
    // it is a property of the chain, not of a nominee, so there is nothing yet
    // for a clock verdict to stamp. The fixture ($0.82 ask, 31 DTE, band
    // widened for this file) is an ADMIT. Same discipline: named row, exact total.
    expect(retained.find((g) => g.gate === 'contract_floor')).toMatchObject({ evaluated: 1, blocked: 0 });
    // TRA-4144 — and a SEVENTH: the UNDERLYING ASSET CLASS gate classifies and
    // records every live candidate even while its refusal flag is OFF (the
    // census must be answerable BEFORE the board arms it). AAPL classifies
    // `equity` off the static list ⇒ an ADMIT. Same discipline: named row,
    // exact total.
    expect(retained.find((g) => g.gate === 'underlying_asset_class')).toMatchObject({ evaluated: 1, blocked: 0 });
    // TRA-4276 — and an EIGHTH: entry admission consults EXIT actionability and
    // records its verdict on every live candidate (a book that cannot CLOSE a
    // row does not OPEN one). The fixture book's exit path is healthy ⇒ an
    // ADMIT. Same discipline: named row, exact total.
    expect(retained.find((g) => g.gate === 'exit_actionability')).toMatchObject({ evaluated: 1, blocked: 0 });
    // TRA-4422 — and a NINTH: the SETUP TAXONOMY scores every nominee and
    // records the verdict in OBSERVE, where it cannot refuse. An ADMIT, and
    // `blocked: 0` here is a property of the mode rather than of the taxonomy —
    // the registry is empty, so nothing was scored. The row exists anyway,
    // because a gate that only appears once it blocks cannot be graded on a
    // quiet day. Same discipline: named row, exact total.
    expect(retained.find((g) => g.gate === 'setup_confirmation')).toMatchObject({ evaluated: 1, blocked: 0 });
    expect(summarizeLiveEnforceGate('1970-01-01').decisionsRecorded).toBe(9);
  });

  // ─── TRA-3942 — the ORDERING claim, graded BEHAVIOURALLY ────────────────────
  // QuantTrader accepted AC1/AC2/AC4 off the wire and then declined to grade one
  // sentence of the filing: that `entry_window.evaluated` is the WHOLE nominee
  // population rather than the ~0.7% surviving the cost bar. On a shut market
  // every roster gate reads `evaluated: 0`, and a zero there is indistinguishable
  // from never having been wired in — the `fleet_reachable_bound` trap (TRA-3926).
  // That refusal is right, and the wire grade stays QuantTrader's on Monday.
  //
  // What the two source-order assertions (`tra3953…test.ts`) prove is that one
  // string appears before another in a file. That is a LITERAL at one depth: it
  // survives the call being moved into a branch that never runs, or the gate
  // below being hoisted into the nominator. So grade the claim the only other way
  // it can be graded before Monday — RUN the scan on both sides of the window
  // boundary and read the DENOMINATORS out of the ledger.
  //
  // The clock is the ONLY difference between the two halves: same stub, same
  // candidate, same arm, same book. That is what makes the second half a positive
  // control at the right LEVEL rather than a different experiment (TRA-3442).
  it('TRA-3942 ORDERING — a refused clock leaves EVERY gate below the window with an empty denominator, and the SAME pass inside the window fills them', async () => {
    armLiveOtmWindow();
    delete process.env[OPTION_OTM_DELTA_FLOOR_LIVE_FLAG];
    const BELOW_THE_WINDOW = [
      'universe', 'otm_delta_floor', 'cost_bar',
      'aggregate_cap', 'canary_ceiling', 'fleet_reachable_bound',
    ] as const;

    // SUBJECT — 13:45Z = 09:45 ET, dead centre of the F1 band (15 of 17 live
    // entries filled 13:35–13:51Z). Outside both windows ⇒ refused.
    vi.setSystemTime(Date.parse('2024-06-04T13:45:00Z'));
    const refusedStub = fillStub();
    await runOtm(setupLiveEngine(refusedStub, otmScanner()), ['AAPL']);

    const refused = summarizeLiveEnforceGate('1970-01-01').retained.byGate;
    // The window itself EVALUATED the nominee and BLOCKED it.
    expect(refused.find((g) => g.gate === 'entry_window')).toMatchObject({ evaluated: 1, blocked: 1 });
    // …and nothing downstream ever saw the candidate. This is the ordering claim
    // stated as a measurement: the denominator the window folded is strictly
    // larger than every denominator below it, on the same pass.
    for (const gate of BELOW_THE_WINDOW) {
      expect(refused.find((g) => g.gate === gate)).toMatchObject({ evaluated: 0, blocked: 0 });
    }
    // TRA-3944 — the ONE gate that legitimately records above the window: the
    // contract floor's CHAIN verdict (a chain is surveyed before any nominee
    // exists). It is an ADMIT here and it is NOT in `BELOW_THE_WINDOW`, which
    // is the point — the window still starves everything beneath it.
    expect(refused.find((g) => g.gate === 'contract_floor')).toMatchObject({ evaluated: 1, blocked: 0 });
    // TRA-4422 — the SECOND gate that legitimately records above the window, and
    // for this one the position is the whole deliverable rather than an accident
    // of what it measures. ⛔ THIS ASSERTION IS THE BEHAVIOURAL PROOF OF THE
    // PLACEMENT: the clock is refusing 100% of nominees under the TRA-4217 hold
    // (03:00–03:01 ET, which cannot intersect RTH — 607/607 on 09-02, 671/671 on
    // 09-03), so a setup gate ordered BELOW the window would read `evaluated: 0`
    // here, forever, and be indistinguishable from never having been wired in.
    // It reads 1. It is an ADMIT because observe cannot refuse, which is also
    // what makes it safe up here: it eats none of `entry_window`'s denominator.
    // ⚠️ That safety expires at the enforce flip — see `otmSetupTaxonomyDecision`.
    expect(refused.find((g) => g.gate === 'setup_confirmation')).toMatchObject({ evaluated: 1, blocked: 0 });
    // Three decisions on the whole pass (chain admit + taxonomy admit + window
    // block), and no broker order.
    expect(summarizeLiveEnforceGate('1970-01-01').decisionsRecorded).toBe(3);
    expect(refusedStub.buyContractsLimit).not.toHaveBeenCalled();

    // POSITIVE CONTROL — move ONLY the clock, into the morning window (10:20 ET).
    // A fresh engine, because the TRA-3953 churn brake is per-engine state and
    // this control is about the gate, not about the brake.
    clearLiveEnforceGateLedger();
    vi.setSystemTime(TRADING_TIME);
    const admittedStub = fillStub();
    await runOtm(setupLiveEngine(admittedStub, otmScanner()), ['AAPL']);

    const admitted = summarizeLiveEnforceGate('1970-01-01').retained.byGate;
    expect(admitted.find((g) => g.gate === 'entry_window')).toMatchObject({ evaluated: 1, blocked: 0 });
    // The gates that read 0 above are reachable — they were starved by the
    // window, not absent. (`otm_delta_floor` and `cost_bar` stay at 0 here for a
    // DIFFERENT and already-pinned reason: both are flag-disarmed on this path,
    // which is exactly the flag-OFF test above. Naming them separately keeps this
    // control from claiming a reachability it does not demonstrate.)
    for (const gate of ['universe', 'aggregate_cap', 'canary_ceiling', 'fleet_reachable_bound'] as const) {
      expect(admitted.find((g) => g.gate === gate)).toMatchObject({ evaluated: 1 });
    }
    expect(admittedStub.buyContractsLimit).toHaveBeenCalledTimes(1);
  });

  it('flag ON + below-floor live candidate: NO broker order, reason surfaced, ledger counts the REJECT', async () => {
    armLiveOtmWindow();
    process.env[OPTION_OTM_DELTA_FLOOR_LIVE_FLAG] = '1';
    process.env[OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR] = '0.25';
    const stub = fillStub();
    const engine = setupLiveEngine(stub, otmScanner(makeOtmCandidate({ delta: 0.12 })));
    await runOtm(engine, ['AAPL']);

    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(0);
    expect(state.signals[0]!.liveSkipReason).toMatch(/entry delta floor/);
    expect(otmFloorGate()).toMatchObject({ evaluated: 1, blocked: 1, blockRate: 1 });
  });

  it('flag ON + above-floor live candidate: the order DOES open and the ledger counts the ADMIT side too', async () => {
    armLiveOtmWindow();
    process.env[OPTION_OTM_DELTA_FLOOR_LIVE_FLAG] = '1';
    process.env[OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR] = '0.25';
    const stub = fillStub();
    const engine = setupLiveEngine(stub, otmScanner(makeOtmCandidate({ delta: 0.30 })));
    await runOtm(engine, ['AAPL']);

    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(engine.getState().options.openOptions).toHaveLength(1);
    // The admit is RECORDED — evaluated ticks with blocked 0, so an armed gate
    // that saw candidates and passed them cannot read as armed-but-inert.
    expect(otmFloorGate()).toMatchObject({ evaluated: 1, blocked: 0, blockRate: 0 });
  });

  it('flag ON + a candidate with no usable delta (NaN) fails CLOSED when armed — no order', async () => {
    armLiveOtmWindow();
    process.env[OPTION_OTM_DELTA_FLOOR_LIVE_FLAG] = '1';
    process.env[OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR] = '0.25';
    const stub = fillStub();
    const engine = setupLiveEngine(stub, otmScanner(makeOtmCandidate({ delta: Number.NaN })));
    await runOtm(engine, ['AAPL']);

    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    expect(engine.getState().options.openOptions).toHaveLength(0);
    // TRA-3944 — the NaN now fails CLOSED one gate EARLIER: the contract floor
    // reads |Δ| on the whole chain before the selector and refuses an unreadable
    // delta under `contract_floor_delta`, so the TRA-2763 floor never sees the
    // candidate. Same disposition (no order), different — and correct —
    // attribution. A chain-level refusal has no OCC to surface on the feed, so
    // the verdict is read off the ledger rather than off `signals[0]`.
    const retained = summarizeLiveEnforceGate('1970-01-01').retained.byGate;
    expect(retained.find((g) => g.gate === 'contract_floor')).toMatchObject({ evaluated: 1, blocked: 1 });
    expect(retained.find((g) => g.gate === 'contract_floor')!.byReason).toEqual([
      expect.objectContaining({ reasonCode: 'contract_floor_delta', blocked: 1 }),
    ]);
    expect(otmFloorGate()).toMatchObject({ evaluated: 0, blocked: 0 });
  });

  it('demo book never consults the live flag: armed live floor + below-floor demo candidate still opens, 0 ledger rows', async () => {
    process.env[OPTION_OTM_DELTA_FLOOR_LIVE_FLAG] = '1';
    process.env[OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR] = '0.25';
    const scanner = otmScanner(makeOtmCandidate({ delta: 0.12 }));
    const engine = new SignalEngine(undefined, undefined, scanner); // default demo mode
    await runOtm(engine, ['AAPL']);

    const state = engine.getState();
    expect(state.options.openOptions).toHaveLength(1);
    expect(state.options.openOptions[0]!.signalType).toBe('otm_mispricing');
    expect(otmFloorGate()).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });
  });
});

// TRA-1977 — wheel paper routing. The TRA-1292 short-premium scan is observe-only
// by default; this proves the `ENABLE_OPTION_WHEEL_ROUTING` sub-flag turns the
// best in-universe put-credit-spread's short-put leg into a REAL cash-secured put
// on the demo book (single-leg, no live capital), and that the pass stays wholly
// observe-only when the sub-flag is off.
// ─── TRA-3216 (parent TRA-2760) — LIVE OTM UNDERLYING ALLOWLIST ───────────────
// `runOtmScan` is handed getActiveSymbols() — the full ~614-name watchlist — and
// nothing anywhere restricted which underlyings real money could open on. The
// three live opens after the cost bar was armed were KVYO, TROW and ABCL: not
// selected, merely not excluded. These tests pin (a) an off-allowlist name places
// NO broker order, (b) an on-allowlist name is unchanged, (c) both verdicts are
// RECORDED with the rejected NAME and the BOOK — a scanner-level filter whose
// rejects are invisible is indistinguishable from an inert one — and (d) demo is
// untouched.
describe('SignalEngine — TRA-3216 live OTM underlying allowlist', () => {
  const UNIVERSE_ENV = [
    OPTION_LIVE_OTM_FLAG,
    OPTION_LIVE_TEST_UNTIL_VAR,
    OPTION_LIVE_OTM_UNIVERSE_VAR,
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of UNIVERSE_ENV) savedEnv[k] = process.env[k];
    delete process.env[OPTION_LIVE_OTM_UNIVERSE_VAR]; // default = the board's five names
    process.env[OPTION_LIVE_OTM_FLAG] = '1';
    process.env[OPTION_LIVE_TEST_UNTIL_VAR] = FAR_FUTURE_TEST_UNTIL;
    clearLiveOptionsFeeSlippageLedger();
    clearLiveEnforceGateLedger();
  });
  afterEach(() => {
    for (const k of UNIVERSE_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    clearLiveOptionsFeeSlippageLedger();
    clearLiveEnforceGateLedger();
  });

  function liveStub() {
    return {
      getOptionQuote: vi.fn().mockResolvedValue({ symbol: 'AAPL240705C00210000', bid: 0.78, ask: 0.82 }),
      buyContractsLimit: vi.fn().mockResolvedValue({ id: 42, status: 'ok' }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 42, status: 'filled', avg_fill_price: 0.82 })),
    };
  }

  /** The scanner returns the SAME cheap candidate whatever symbol it is asked for. */
  function anySymbolScanner(): StubScanner {
    const scanner = new StubScanner();
    scanner.scanOtm.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05', candidates: [makeOtmCandidate()], reason: 'ok',
    });
    return scanner;
  }

  function engineFor(mode: 'demo' | 'live', stub: ReturnType<typeof liveStub>, book = 'admin'): SignalEngine {
    const engine = new SignalEngine(undefined, undefined, anySymbolScanner());
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = stub;
    (engine as unknown as { mode: 'demo' | 'live' }).mode = mode;
    (engine as unknown as { alertUsername: string }).alertUsername = book;
    (engine as unknown as { liveTradierBalance: unknown }).liveTradierBalance = {
      totalEquity: 268.58, totalCash: 268.58, optionBuyingPower: 268.58, dayTradeBuyingPower: 268.58,
    };
    return engine;
  }

  const runOtm = (engine: SignalEngine, syms: string[]) =>
    (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(syms);

  const gateOf = (g: string) =>
    summarizeLiveEnforceGate('1970-01-01').retained.byGate.find((x) => x.gate === g)!;

  it('blocks an off-allowlist live name: NO broker order, and the rejected NAME is on the record', async () => {
    const stub = liveStub();
    const engine = engineFor('live', stub);
    // KVYO is one of the three names real money actually opened on 08-06..10.
    await runOtm(engine, ['KVYO']);

    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    expect(engine.getState().options.openOptions).toHaveLength(0);

    const universe = gateOf('universe');
    expect(universe).toMatchObject({ evaluated: 1, blocked: 1, blockRate: 1 });
    // Keyed by SYMBOL — a bare count could not tell you WHICH name was stopped.
    expect(universe.byScope).toEqual([
      { scope: 'KVYO', evaluated: 1, blocked: 1, blockRate: 1 },
    ]);
    expect(universe.byReason).toEqual([{ reasonCode: 'not_in_universe', blocked: 1, share: 1 }]);
    // Stamped with the BOOK: this is what makes the fleet claim checkable rather
    // than inferred from a process-level env var.
    expect(universe.byBook).toEqual([{ book: 'admin', evaluated: 1, blocked: 1, blockRate: 1 }]);

    // The reject is visible on the feed, not only in the ledger.
    const sig = engine.getState().signals.find((s) => s.symbol === 'KVYO')!;
    expect(sig.liveSkipReason).toMatch(/not on the live underlying allowlist/);
  });

  it('cuts BEFORE the cost bar and the delta floor — they never see an off-allowlist name', async () => {
    await runOtm(engineFor('live', liveStub()), ['KVYO']);
    // Ordering is load-bearing: it is why cost_bar's block rate stops describing
    // a population we never trade (and why its denominator steps down on deploy).
    expect(gateOf('cost_bar')).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });
    expect(gateOf('otm_delta_floor')).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });
  });

  it('leaves an on-allowlist live name byte-for-byte unchanged, and records the ADMIT side', async () => {
    const stub = liveStub();
    const engine = engineFor('live', stub);
    await runOtm(engine, ['AAPL']);

    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(engine.getState().options.openOptions).toHaveLength(1);
    // evaluated>0 / blocked:0 — an admitted verdict is recorded too, so an inert
    // allowlist (evaluated 0) can never read like one that passed everything.
    expect(gateOf('universe')).toMatchObject({ evaluated: 1, blocked: 0, blockRate: 0 });
    expect(gateOf('universe').byReason).toEqual([]);
  });

  it('honours an operator override — a name off the DEFAULT list opens when explicitly allowed', async () => {
    process.env[OPTION_LIVE_OTM_UNIVERSE_VAR] = 'kvyo, IWM';
    const stub = liveStub();
    const engine = engineFor('live', stub);
    await runOtm(engine, ['KVYO']);

    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    expect(gateOf('universe')).toMatchObject({ evaluated: 1, blocked: 0 });
  });

  it('the `*` escape hatch opens any name, and RECORDS the admit with the ratified-set counterfactual (TRA-4269)', async () => {
    process.env[OPTION_LIVE_OTM_UNIVERSE_VAR] = '*';
    const stub = liveStub();
    await runOtm(engineFor('live', stub), ['KVYO']);

    expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
    // TRA-4269 — this read `evaluated: 0` until the unrestricted branch started
    // recording, which left the board ruling on the allowlist with no
    // entry-side tape. The admit is now on the record with what the ratified
    // set would have done: KVYO is off it, so restoring the allowlist would
    // have refused this entry.
    expect(gateOf('universe')).toMatchObject({
      evaluated: 1,
      blocked: 0,
      blockRate: 0,
      counterfactualEvaluated: 1,
      wouldBlockUnderRatifiedSet: 1,
    });
    expect(gateOf('universe').bySymbol).toEqual([{ symbol: 'KVYO', evaluated: 1, inRatifiedSet: false }]);
  });

  it('a malformed override does NOT re-open the universe — it falls back to the restriction', async () => {
    process.env[OPTION_LIVE_OTM_UNIVERSE_VAR] = ',,,';
    const stub = liveStub();
    await runOtm(engineFor('live', stub), ['KVYO']);

    expect(stub.buyContractsLimit).not.toHaveBeenCalled();
    expect(gateOf('universe')).toMatchObject({ evaluated: 1, blocked: 1 });
  });

  it('demo is untouched: an off-allowlist name still opens on the paper book, 0 ledger rows', async () => {
    const stub = liveStub();
    const engine = engineFor('demo', stub);
    await runOtm(engine, ['KVYO']);

    expect(engine.getState().options.openOptions).toHaveLength(1);
    expect(stub.buyContractsLimit).not.toHaveBeenCalled(); // demo never touches the broker
    expect(summarizeLiveEnforceGate('1970-01-01').decisionsRecorded).toBe(0);
  });

  // ─── TRA-3445 — the AGGREGATE cap, at the order site ────────────────────────
  // The board's TRA-3384 answer had THREE clauses; two were armable as env knobs
  // and the third ("max $750 total") had no code path at all. Every guard above
  // this one bounds a SINGLE entry, and the surviving argument for aggregate
  // safety was `min(available cash, cap)` — the CASH bound, not the board's.
  //
  // Note the balance these tests run against: $10,000, deliberately far above
  // the $1,035.94 the admin book actually held. If the cash bound were doing the
  // work, every one of these would open. The cap is what stops them.
  describe('aggregate cap (TRA-3445)', () => {
    const AGG_VAR = 'LIVE_OPTION_TEST_AGGREGATE_CAP_USD';
    let savedAgg: string | undefined;
    beforeEach(() => { savedAgg = process.env[AGG_VAR]; delete process.env[AGG_VAR]; });
    afterEach(() => {
      if (savedAgg === undefined) delete process.env[AGG_VAR];
      else process.env[AGG_VAR] = savedAgg;
    });

    /** A cash bound that can never be the thing doing the blocking. */
    function richEngine(stub: ReturnType<typeof liveStub>): SignalEngine {
      const engine = engineFor('live', stub);
      (engine as unknown as { liveTradierBalance: unknown }).liveTradierBalance = {
        totalEquity: 10_000, totalCash: 10_000, optionBuyingPower: 10_000, dayTradeBuyingPower: 10_000,
      };
      return engine;
    }

    /** Seed `usd` of ALREADY-OPEN live premium at risk on the engine's book. */
    function seedOpenLivePremium(engine: SignalEngine, usd: number): void {
      const acct = (engine as unknown as { optionsAccount: PaperOptionsAccount }).optionsAccount;
      acct.importSnapshot({
        // One row carrying the whole figure. OCC symbol deliberately DIFFERENT
        // from the candidate's, so the 1-hour same-contract dedupe cannot be
        // what blocks — the aggregate gate has to be.
        openOptions: [{
          id: 'seed-1', symbol: 'MSFT', optionSymbol: 'MSFT240705C00420000',
          optionType: 'call', strike: 420, expiration: '2024-07-05',
          contracts: 1, contractsRemaining: 1,
          premiumPaid: usd / 100, currentPremium: usd / 100,
          tp1Premium: (usd / 100) * 1.25, tp1Hit: false,
          stopLossPremium: (usd / 100) * 0.75, peakPremium: usd / 100,
          trailingActive: false, trailingStopPremium: (usd / 100) * 0.88,
          underlyingEntryPrice: 415, openedAt: TRADING_TIME,
          signalId: 'seed-sig', signalType: 'otm_mispricing', mode: 'live',
        }],
        closedOptions: [], optionsPnl: 0, dailyCount: 0,
        currentDayKey: '2026-08-12', cash: 10_000, equity: 10_000,
      });
    }

    // The candidate is ask $0.82 ⇒ ONE contract = $82 of premium.
    const ENTRY_USD = 82;

    it('SKIPS an entry that fits per-entry but breaches the aggregate — and RECORDS the skip', async () => {
      const stub = liveStub();
      const engine = richEngine(stub);
      seedOpenLivePremium(engine, 700); // 700 + 82 = 782 > 750
      await runOtm(engine, ['AAPL']);

      // No broker order, and no new row on the paper book either (the seeded one
      // is still there — hence 1, not 0).
      expect(stub.buyContractsLimit).not.toHaveBeenCalled();
      expect(engine.getState().options.openOptions).toHaveLength(1);

      const agg = gateOf('aggregate_cap');
      expect(agg).toMatchObject({ evaluated: 1, blocked: 1, blockRate: 1 });
      expect(agg.byReason).toEqual([{ reasonCode: 'over_aggregate_cap', blocked: 1, share: 1 }]);
      expect(agg.byBook).toEqual([{ book: 'admin', evaluated: 1, blocked: 1, blockRate: 1 }]);

      // Visible on the feed, not only in the ledger.
      const sig = engine.getState().signals.find((s) => s.symbol === 'AAPL')!;
      expect(sig.liveSkipReason).toMatch(/aggregate cap/);
      expect(sig.liveSkipReason).toMatch(/\$700\.00 already at risk/);
    });

    it('ADMITS an entry that lands EXACTLY on the cap — boundary inclusive', async () => {
      // TRA-3872 — the boundary used to be probed at the $750 default (668 + 82),
      // but an entry landing there is now refused DOWNSTREAM by the TRA-3836
      // <=$100 canary ceiling, so the broker call this test pins never fires.
      // Inclusivity is a property of the comparison, not of the number: probe it
      // at a lowered cap ($8 + $82 = $90 exactly) that fits inside the canary.
      // The $750 default itself stays pinned by the clamp test below and the
      // headroom test's `capUsd: 750`.
      process.env[AGG_VAR] = '90';
      const stub = liveStub();
      const engine = richEngine(stub);
      seedOpenLivePremium(engine, 90 - ENTRY_USD); // 8 + 82 = 90 exactly
      await runOtm(engine, ['AAPL']);

      expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
      // evaluated>0 / blocked:0 — the ADMIT is recorded too, so a cap that never
      // had to bite can never read like one that is not wired in.
      expect(gateOf('aggregate_cap')).toMatchObject({ evaluated: 1, blocked: 0, blockRate: 0 });
      expect(gateOf('aggregate_cap').byReason).toEqual([]);
    });

    it('one cent over the cap is BLOCKED — the boundary is a boundary, not a suggestion', async () => {
      const stub = liveStub();
      const engine = richEngine(stub);
      seedOpenLivePremium(engine, 750 - ENTRY_USD + 0.01);
      await runOtm(engine, ['AAPL']);

      expect(stub.buyContractsLimit).not.toHaveBeenCalled();
      expect(gateOf('aggregate_cap')).toMatchObject({ evaluated: 1, blocked: 1 });
    });

    it('an EMPTY live book opens normally — the cap does not block the first entry', async () => {
      const stub = liveStub();
      const engine = richEngine(stub);
      await runOtm(engine, ['AAPL']);

      expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
      expect(gateOf('aggregate_cap')).toMatchObject({ evaluated: 1, blocked: 0 });
    });

    it('an oversized env value cannot buy headroom — $5000 clamps to the board $750', async () => {
      process.env[AGG_VAR] = '5000';
      const stub = liveStub();
      const engine = richEngine(stub);
      seedOpenLivePremium(engine, 700);
      await runOtm(engine, ['AAPL']);

      // Under a naive env read this entry opens ($782 < $5000). It must not.
      expect(stub.buyContractsLimit).not.toHaveBeenCalled();
      expect(gateOf('aggregate_cap')).toMatchObject({ evaluated: 1, blocked: 1 });
    });

    it('a DEMO row does not consume live headroom', async () => {
      const stub = liveStub();
      const engine = richEngine(stub);
      seedOpenLivePremium(engine, 700);
      // Re-stamp the seeded row demo: same dollars, different book.
      const acct = (engine as unknown as { optionsAccount: PaperOptionsAccount }).optionsAccount;
      acct.getState().openOptions[0]!.mode = 'demo';
      await runOtm(engine, ['AAPL']);

      expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
      expect(gateOf('aggregate_cap')).toMatchObject({ evaluated: 1, blocked: 0 });
    });

    it('demo mode never reaches the gate at all — 0 rows on the live ledger', async () => {
      const stub = liveStub();
      const engine = engineFor('demo', stub);
      await runOtm(engine, ['AAPL']);

      expect(gateOf('aggregate_cap')).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });
    });

    it('publishes headroom per book, so "armed, $600 left" is not "armed, $0 left"', async () => {
      // $10,000 of balance ⇒ φ·E = $4,858, so `min(…, A)` binds and the budget
      // is the full $750. TRA-3674 is a TIGHTENING: on a rich book it changes
      // nothing, which is what makes the poor-book test below the discriminator.
      const engine = richEngine(liveStub());
      expect(engine.getLiveOtmAggregateExposure()).toEqual({
        book: 'admin', mode: 'live', liveEntryGateOpen: true, capUsd: 750,
        fleetCapUsd: 750, fleetRiskFraction: 0.4858, availableCashUsd: 10_000,
        // TRA-3964 — the cash half's PROVENANCE. This book is flat and nothing
        // is pending, so the correction is $0 and `availableCashUsd` is the
        // broker's own figure unchanged: the fix is a no-op on a quiet book, and
        // this exhaustive row is where that is pinned.
        // `balanceAsOfMs` is null because this harness injects the balance
        // without ever fetching one — which must read as "no as-of stamp", never
        // as `0` ("fetched at the epoch") or `0ms` ("fetched just now").
        balanceAgeMs: null, balanceAsOfMs: null, brokerCashUsd: 10_000,
        // TRA-3970 — the stub client carries no suppression counter, so the
        // row reads UNREADABLE (null), never a manufactured 0.
        balanceZeroArtifactSuppressions: null, balanceZeroArtifactLastAtMs: null,
        unsettledLivePremiumUsd: 0, unsettledLivePremiumFills: 0,
        unsettledLivePremiumBlindFills: 0,
        openPremiumAtRiskUsd: 0, openRows: 0, unpricedOpenRows: 0, headroomUsd: 750,
        // TRA-3897 — the book is FLAT, so the capital basis IS the cash and the
        // signed headroom IS the clamped one. Both unchanged here by design:
        // the basis change is a strict generalization, and this row is the
        // degenerate case that proves it on the ENGINE rather than the resolver.
        headroomSignedUsd: 750, sizingBasisUsd: 10_000,
        // TRA-3879 — the fleet read is UNWIRED in this unit (no `index.ts`), so
        // `Σ E_i` is this book alone: $10,000 ⇒ `φ_eff = A/ΣE = 0.075`, far
        // below φ, and `capUsd` is UNCHANGED at $750 because `min(…, A)` was
        // already binding. That is the whole shape of remedy (f) in one row —
        // it can only ever size DOWN, and here there was nothing to take.
        fleetRiskFractionEffective: 0.075,
        fleetCapitalUsd: 10_000,
        fleetCapitalBooks: 1,
        fleetSizingReason: 'phi_fleet_derived',
        // TRA-3911 — the fleet AT-RISK read is unwired here for the same reason
        // the capital read is (no `index.ts` in a unit), and the degrade is
        // PUBLISHED rather than silently absorbed: `admissibleEntryUsd` falls
        // back to `cap − atRisk` — the per-book bound in force before this
        // ticket — and `admissibleBoundBy` says exactly why.
        //
        // ⚠ `fleetAtRiskUsd: null`, NEVER 0. On this row the two would be
        // arithmetically identical (the book IS flat) and that is precisely why
        // it has to be asserted here: a `0` meaning "the fleet has spent
        // nothing" and a `0` meaning "we could not read the fleet" would be the
        // same bytes, and the second one hands out the full authorization.
        admissibleEntryUsd: 750,
        admissibleBoundBy: 'fleet_unreadable',
        bookHeadroomSignedUsd: 750,
        fleetHeadroomSignedUsd: null,
        fleetAtRiskUsd: null,
        fleetAtRiskBooks: 0,
        // TRA-3913 — the ADOPTED columns. This literal is an exhaustive
        // `toEqual`, so publishing a new key is a breaking change to it by
        // construction; that is the point of asserting the whole object and it
        // is why these are added rather than the assertion loosened.
        //
        // All three are 0 because the book is FLAT, and on a flat book they are
        // the only honest answer: there is no row to attribute, so there is no
        // desk premium and nothing the oracle was asked about. ⚠ Note this is
        // the one place a `0` in `adoptedAttributionBlindRows` is unambiguous —
        // elsewhere it carries the "we could answer" claim that TRA-3913 keeps
        // separate from the dollar figure.
        adoptedPremiumAtRiskUsd: 0,
        adoptedOpenRows: 0,
        adoptedAttributionBlindRows: 0,
        // TRA-3958 — the OPERATOR-PIN provenance overlay, added here for exactly
        // the reason the paragraph above gives: this literal is exhaustive, so a
        // new key breaks it by construction and the break is the notification.
        //
        // 0 on a flat book, and unambiguously so: no rows, so no pinned ones.
        // ⚠ Elsewhere a 0 here is a real claim — "none of the dollars under this
        // admission came from a human with a citation" — and it is the claim a
        // reader gating on `admissibleEntryUsd` is entitled to.
        operatorPinnedAtRiskUsd: 0,
        operatorPinnedOpenRows: 0,
        // TRA-3965 — the UNBOOKED-ENTRY-PREMIUM overlay, added here for the same
        // reason, and this row doubles as its flat-book control: the correction
        // must be a strict no-op wherever no live fill of ours is stamped.
        //
        // ⚠ The suppressed column is the one that has to be here. `0` in
        // `unbookedEntryPremiumUsd` is published by a book with nothing to
        // correct AND by a book whose operator pin refused a correction, and
        // only the second is a fact worth waking someone for.
        unbookedEntryPremiumUsd: 0,
        unbookedEntryPremiumRows: 0,
        unbookedEntryPremiumSuppressedUsd: 0,
      });

      seedOpenLivePremium(engine, 700);
      expect(engine.getLiveOtmAggregateExposure()).toMatchObject({
        // TRA-3897 — $49.99, one cent under the $50.00 this read before the
        // basis change, and the cent is CORRECT. `Σ E_i` is now $10,700, so
        // `φ_eff = 750/10,700` is not exactly representable and
        // `floor(10,700 × φ_eff)` lands on $749.99 rather than $750.00. That
        // floor is the documented TIGHTENING-ONLY absorber for exactly this
        // float error (see `resolveLiveOptionTestBookAggregateCapUsd`); it
        // simply never bit while `Σ E_i` happened to be a round $10,000.
        openPremiumAtRiskUsd: 700, openRows: 1, headroomUsd: 49.99,
        sizingBasisUsd: 10_700, headroomSignedUsd: 49.99,
      });
    });

    // ── TRA-3674 ────────────────────────────────────────────────────────────
    // The budget is CAPITAL-PROPORTIONAL: `B_i = min(φ · availableCash, A)`.
    // These run against the ENGINE, not the resolver, because the resolver
    // table cannot catch the failure that matters — a call site that ignores
    // the balance (or compiles φ in) passes every arithmetic test there is.
    /** An engine whose live book holds exactly `usd` of available cash. */
    function bookWithCash(stub: ReturnType<typeof liveStub>, usd: number): SignalEngine {
      const engine = engineFor('live', stub);
      (engine as unknown as { liveTradierBalance: unknown }).liveTradierBalance = {
        totalEquity: usd, totalCash: usd, optionBuyingPower: usd, dayTradeBuyingPower: usd,
      };
      return engine;
    }

    it('sizes the budget off THIS BOOK\'S cash — the two live books read distinct', () => {
      // The real balances, off `liveArmCensus` 2026-08-14T01:0xZ.
      expect(bookWithCash(liveStub(), 1143.96).getLiveOtmAggregateExposure())
        .toMatchObject({ capUsd: 555.73, availableCashUsd: 1143.96, headroomUsd: 555.73 });
      expect(bookWithCash(liveStub(), 400).getLiveOtmAggregateExposure())
        .toMatchObject({ capUsd: 194.32, availableCashUsd: 400, headroomUsd: 194.32 });
      // Under the flat cap BOTH of these read `capUsd: 750`, and the route was
      // structurally unable to tell the two books apart. That is the defect.
    });

    // ── TRA-3879 ────────────────────────────────────────────────────────────
    // `Σ B_i` was bounded by NOTHING: `min(…, A)` is a per-book clamp. Remedy
    // (f) re-derives φ from LIVE capital — `φ_eff = min(φ, A / Σ E_i)` — so the
    // sum is bounded structurally at any balances. These run against the ENGINE
    // because the resolver suite cannot catch the failure that matters: an
    // order site that never consults the fleet read passes every arithmetic
    // test there is (that is exactly how TRA-3674 shipped believed-safe).
    it('the fleet read SHRINKS this book\'s budget — Σ B_i fits A across the arm', () => {
      try {
        // The live 2026-08-14 arm plus a third book joining it. Under the
        // per-book bound alone these sum to $881.03 against A = $750.
        setLiveOtmFleetCapitalProvider(() => [
          // TRA-3897 — flat books (`openPremiumAtRiskUsd: 0`), so the capital
          // basis reduces to cash and every number below is unchanged.
          { book: 'admin', liveEntryGateOpen: true, availableCashUsd: 1143.96, openPremiumAtRiskUsd: 0 },
          { book: 'v0nni', liveEntryGateOpen: true, availableCashUsd: 400, openPremiumAtRiskUsd: 0 },
          { book: 'newcomer', liveEntryGateOpen: true, availableCashUsd: 5000, openPremiumAtRiskUsd: 0 },
        ]);
        const admin = bookWithCash(liveStub(), 1143.96).getLiveOtmAggregateExposure();
        expect(admin.fleetSizingReason).toBe('phi_fleet_derived');
        expect(admin.fleetCapitalUsd).toBeCloseTo(6543.96, 2);
        expect(admin.fleetCapitalBooks).toBe(3);
        // Strictly smaller than the $555.73 the same book got with no fleet read.
        expect(admin.capUsd).toBeLessThan(555.73);
        // …and the FLEET now fits: every book sized on the same φ_eff.
        const fleetSum = [1143.96, 400, 5000]
          .map(cash => bookWithCash(liveStub(), cash).getLiveOtmAggregateExposure().capUsd)
          .reduce((a, b) => a + b, 0);
        expect(fleetSum).toBeLessThanOrEqual(750);
      } finally {
        setLiveOtmFleetCapitalProvider(null);
      }
    });

    // THE discriminator for TRA-3879, and the one assertion that cannot pass on
    // a build where the order site ignores the fleet: the book, the balance, the
    // already-at-risk figure, the candidate and φ are all held FIXED — only the
    // other books' capital moves — and the admit decision at the ORDER SITE
    // flips with it. Both verdicts are asserted, so "blocks everything" cannot
    // pass as success.
    it('VACUITY CONTROL — another book\'s capital moves the ADMIT DECISION', async () => {
      const VAR = 'LIVE_OPTION_TEST_FLEET_RISK_FRACTION';
      const saved = process.env[VAR];
      try {
        // φ = 1 and a $100 book: budget $100, so $10 at risk + an $82 entry is
        // ADMITTED and reaches the broker. (The TRA-3674 control above, verbatim.)
        process.env[VAR] = '1';
        const looseStub = liveStub();
        const loose = bookWithCash(looseStub, 100);
        seedOpenLivePremium(loose, 10);
        await runOtm(loose, ['AAPL']);
        expect(looseStub.buyContractsLimit).toHaveBeenCalledTimes(1);
        const admitted = gateOf('aggregate_cap');

        // Now a SECOND book appears holding $10,000. Nothing about the first
        // book changed — not its cash, not its exposure, not φ, not the
        // candidate. But the fleet would now authorize $10,100 against a $750
        // board figure, so φ_eff = 750/10,100 = 0.0743 and the SAME entry is
        // REFUSED. This is the fail-open TRA-3723 could only detect.
        setLiveOtmFleetCapitalProvider(() => [
          // TRA-3897 — the declared rows carry the PREMIUM half of the basis
          // too. `admin` is the book under test and it is holding $10 of open
          // premium (seeded above), so its declared row says so: `E_admin` is
          // $110 of CAPITAL, not $100 of cash. Declaring 0 here would have the
          // fleet read contradict the book it is reading.
          { book: 'admin', liveEntryGateOpen: true, availableCashUsd: 100, openPremiumAtRiskUsd: 10 },
          { book: 'whale', liveEntryGateOpen: true, availableCashUsd: 10_000, openPremiumAtRiskUsd: 0 },
        ]);
        const tightStub = liveStub();
        const tight = bookWithCash(tightStub, 100);
        seedOpenLivePremium(tight, 10);
        await runOtm(tight, ['AAPL']);
        expect(tightStub.buyContractsLimit).not.toHaveBeenCalled();
        expect(gateOf('aggregate_cap')).toMatchObject({
          evaluated: admitted.evaluated + 1, blocked: admitted.blocked + 1,
        });
        // The refusal is ATTRIBUTABLE to the fleet, not to this book's balance.
        expect(tight.getLiveOtmAggregateExposure()).toMatchObject({
          fleetSizingReason: 'phi_fleet_derived', fleetCapitalBooks: 2,
        });
      } finally {
        setLiveOtmFleetCapitalProvider(null);
        if (saved === undefined) delete process.env[VAR];
        else process.env[VAR] = saved;
      }
    });

    // ─── TRA-3897 — the sizing basis at the ORDER SITE ─────────────────────
    //
    // The resolver suite (`option-live-otm-sizing-basis-tra3897.test.ts`)
    // proves the arithmetic. These two run against the ENGINE because that is
    // the only place the claim that matters can be false: an order site that
    // resolves its budget from cash while the health route publishes capital
    // would pass every arithmetic test there is, and would be invisible on the
    // route. That is precisely how TRA-3674 shipped believed-safe.
    //
    // ⚠ BOTH VERDICTS ARE ASSERTED. A basis change that simply blocked more
    // would pass a one-sided test and be a different, worse defect.
    it('TRA-3897 — the ADMIT DECISION moves with the CAPITAL basis, not the cash left', async () => {
      // ONE book, held fixed except for the conversion: capital $1,000, of
      // which $400 is already open premium and $600 is still cash. φ 0.4858 ⇒
      // the ratified allowance is $485.80 of at-risk, and $400 + this $82
      // candidate is $482 — INSIDE it.
      //
      // On the CASH basis the same book sized $291.48 (φ × the $600 that was
      // left) and refused, because it had spent 40% of its capital and 40% is
      // past the φ/(1+φ) = 32.7% tipping point. It broke no gate to get there.
      const stub = liveStub();
      const engine = bookWithCash(stub, 600);
      seedOpenLivePremium(engine, 400);

      const row = engine.getLiveOtmAggregateExposure();
      expect(row).toMatchObject({
        availableCashUsd: 600,
        openPremiumAtRiskUsd: 400,
        // ⭐ The basis is the CAPITAL, published so it is auditable directly.
        sizingBasisUsd: 1000,
        capUsd: 485.8,
      });
      // …and the cash basis would have put this book $108.52 OVER its own cap.
      expect(Math.floor(600 * 0.4858 * 100) / 100).toBe(291.48);
      expect(row.headroomSignedUsd).toBeCloseTo(85.8, 2);

      await runOtm(engine, ['AAPL']);
      expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
      expect(gateOf('aggregate_cap')).toMatchObject({ blocked: 0 });
    });

    it('TRA-3897 — and it still REFUSES a book genuinely past its capital allowance', async () => {
      // Same shape, $500 of capital: $100 cash + $400 open premium. The
      // allowance is φ × 500 = $242.90 and the book is ALREADY $157.10 past it,
      // so the $82 candidate must not reach the broker. The capital basis is a
      // correction, not a relaxation — it does not hand an over-exposed book a
      // bigger budget, it stops manufacturing over-exposure out of arithmetic.
      const stub = liveStub();
      const engine = bookWithCash(stub, 100);
      seedOpenLivePremium(engine, 400);

      const row = engine.getLiveOtmAggregateExposure();
      expect(row).toMatchObject({ sizingBasisUsd: 500, capUsd: 242.9, openPremiumAtRiskUsd: 400 });
      // ⭐ AC2 ON THE ROUTE. The clamped field says `0`, which reads
      // byte-identically to a book that spent its budget to the cent; the
      // signed sibling says the book is $157.10 UNDER WATER. `admin` served
      // exactly this pair (0 vs −$200.57) on 2026-08-20 and nothing could tell.
      expect(row.headroomUsd).toBe(0);
      expect(row.headroomSignedUsd).toBeCloseTo(-157.1, 2);

      const before = gateOf('aggregate_cap');
      await runOtm(engine, ['AAPL']);
      expect(stub.buyContractsLimit).not.toHaveBeenCalled();
      expect(gateOf('aggregate_cap')).toMatchObject({ blocked: before.blocked + 1 });
    });

    it('FAILS CLOSED with no balance snapshot — budget 0, cash null, not a silent $750', () => {
      // Explicitly dark, matching the `no_balance_snapshot` branch at the order
      // site (a failed/absent Tradier balance fetch leaves this null). The row
      // must NOT fall back to the fleet cap: an unreadable balance is not
      // evidence of headroom, and `availableCashUsd: null` is what tells this
      // apart from a genuinely empty $0 account.
      const engine = engineFor('live', liveStub());
      (engine as unknown as { liveTradierBalance: unknown }).liveTradierBalance = null;
      expect(engine.getLiveOtmAggregateExposure()).toMatchObject({
        capUsd: 0, availableCashUsd: null, headroomUsd: null,
      });
    });

    // THE discriminator for this ticket. Everything else here is satisfied by a
    // call site that ignores env and compiles φ in; only a test that MOVES φ and
    // watches the order site change its mind can tell the two apart. Both
    // verdicts are asserted, so "blocks everything" cannot pass as success.
    it('VACUITY CONTROL — moving φ moves the ADMIT DECISION at the order site', async () => {
      const VAR = 'LIVE_OPTION_TEST_FLEET_RISK_FRACTION';
      const saved = process.env[VAR];
      try {
        // TRA-3872 — rescaled from v0nni's real $400/$150 shape (loose-side
        // projection $232 is now refused downstream by the <=$100 canary
        // ceiling, so the admit this control turns on could never reach the
        // broker). The discriminating structure is unchanged: same book twice,
        // only φ moves, and the verdict at the order site flips with it.
        // A $100 book with $10 already at risk. At the default φ the budget is
        // $48.58, so a further $82 entry is BLOCKED — no broker order.
        const tightStub = liveStub();
        const tight = bookWithCash(tightStub, 100);
        seedOpenLivePremium(tight, 10);
        await runOtm(tight, ['AAPL']);
        expect(gateOf('aggregate_cap')).toMatchObject({ evaluated: 1, blocked: 1 });
        expect(tightStub.buyContractsLimit).not.toHaveBeenCalled();

        // Same book, same balance, same already-at-risk, same candidate — the
        // ONLY thing that changes is the env scalar. φ=1 ⇒ budget $100 ⇒ the
        // SAME entry ($10 + $82 = $92) is now ADMITTED and goes to the broker
        // (inside the canary ceiling too, so nothing downstream re-refuses it).
        process.env[VAR] = '1';
        const looseStub = liveStub();
        const loose = bookWithCash(looseStub, 100);
        seedOpenLivePremium(loose, 10);
        // TRA-3897 — read the row BEFORE the fill. `capUsd` is $110, not $100:
        // the basis is CAPITAL, and this book's capital is its $100 of cash
        // plus the $10 of premium it is already holding. (Read after the fill
        // it would be higher still, because this harness's stubbed balance does
        // not decrease when the order fills the way a real broker's does — so a
        // post-fill `capUsd` here is an artifact of the stub, not of the gate.)
        expect(loose.getLiveOtmAggregateExposure()).toMatchObject({
          capUsd: 110, sizingBasisUsd: 110, fleetRiskFraction: 1,
        });
        await runOtm(loose, ['AAPL']);
        // `evaluated` advances, `blocked` does NOT — the delta is the admit.
        expect(gateOf('aggregate_cap')).toMatchObject({ evaluated: 2, blocked: 1 });
        expect(looseStub.buyContractsLimit).toHaveBeenCalledTimes(1);
        expect(loose.getLiveOtmAggregateExposure()).toMatchObject({ fleetRiskFraction: 1 });
      } finally {
        if (saved === undefined) delete process.env[VAR];
        else process.env[VAR] = saved;
      }
    });

    // Measured on bqb1: THREE books read `mode: 'live'` and only TWO can place
    // a live options order. A fleet sum taken off `mode` reads $2,250 against a
    // true worst case of $1,500 — so the two fields must not be able to collapse
    // into each other.
    it('a live-MODE book with no options client is NOT counted as an armed one', () => {
      const engine = richEngine(liveStub());
      // Richard's shape: mode live, no live options client.
      (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = null;
      const row = engine.getLiveOtmAggregateExposure();
      expect(row.mode).toBe('live');       // the field a naive fleet sum uses…
      expect(row.liveEntryGateOpen).toBe(false); // …and the one that is correct
    });

    it('a DEMO book reports the gate CLOSED, not merely a demo mode', () => {
      const engine = engineFor('demo', liveStub());
      expect(engine.getLiveOtmAggregateExposure()).toMatchObject({
        mode: 'demo', liveEntryGateOpen: false,
      });
    });

    // ── TRA-3872 (parent TRA-3836) — the canary ceiling at the SAME seam,
    // engine-level. The pure grader has its own suite (canary-ceiling.test.ts);
    // these pin the one thing that suite cannot see and that shipped wrong:
    // what the CALL SITE feeds it. Every caller opens the paper row BEFORE
    // mirroring, so a bare fold already contained the order and the projection
    // double-counted it — an $82 open on a FLAT book graded as $164 and
    // refused itself (the ratified canary order included).
    //
    // The ceiling is PINNED to $100 via the env knob (which may only LOWER the
    // TRA-3870 compiled $300/$500 defaults — a value ops can legitimately set)
    // so the boundary arithmetic below stays exact whatever the board ratifies
    // next: these tests are about the SEAM, not the current number.
    describe('composes with the canary ceiling, pinned to $100 via env (TRA-3836/TRA-3872)', () => {
      beforeEach(() => { process.env.LIVE_OPTION_CANARY_CEILING_USD = '100'; });
      afterEach(() => { delete process.env.LIVE_OPTION_CANARY_CEILING_USD; });

      it('REFUSES on the true aggregate: $30 held + $82 entry = $112 > $100, with its own reasonCode', async () => {
        const stub = liveStub();
        const engine = richEngine(stub);
        seedOpenLivePremium(engine, 30);
        await runOtm(engine, ['AAPL']);

        // Refused at the broker seam — the sleeve cap upstream ADMITTED it
        // ($112 <= $750), so the block is attributable to the canary alone.
        expect(stub.buyContractsLimit).not.toHaveBeenCalled();
        expect(gateOf('aggregate_cap')).toMatchObject({ evaluated: 1, blocked: 0 });
        const canary = gateOf('canary_ceiling');
        expect(canary).toMatchObject({ evaluated: 1, blocked: 1, blockRate: 1 });
        expect(canary.byReason).toEqual([
          { reasonCode: 'canary_ceiling_aggregate', blocked: 1, share: 1 },
        ]);
        // The paper open is VOIDED (only the seed remains) and the reason
        // discloses the true held figure — $30, not a self-inclusive $112.
        expect(engine.getState().options.openOptions).toHaveLength(1);
        const sig = engine.getState().signals.find((s) => s.symbol === 'AAPL')!;
        expect(sig.liveSkipReason).toContain('canary ceiling REFUSED');
        expect(sig.liveSkipReason).toContain('$30 already at risk');
      });

      it('ADMITS exactly at the ceiling — $18 held + $82 entry = $100 (the graded order is not double-counted)', async () => {
        // THE TRA-3872 regression: pre-fix the fold already contained the $82
        // paper open, so this graded as $18 + $82 + $82 = $182 and refused.
        const stub = liveStub();
        const engine = richEngine(stub);
        seedOpenLivePremium(engine, 18);
        await runOtm(engine, ['AAPL']);

        expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
        expect(gateOf('canary_ceiling')).toMatchObject({ evaluated: 1, blocked: 0, blockRate: 0 });
        expect(engine.getState().options.openOptions).toHaveLength(2);
      });

      it('REFUSES while any OTHER open live row is unpriced — an understated aggregate cannot be graded', async () => {
        const stub = liveStub();
        const engine = richEngine(stub);
        seedOpenLivePremium(engine, 30);
        // Strip the seed's cost basis: the shape imported/desk rows arrive in
        // (TRA-3829). It now counts $0 toward the fold, so the fold UNDERSTATES.
        const acct = (engine as unknown as { optionsAccount: PaperOptionsAccount }).optionsAccount;
        acct.getState().openOptions[0]!.premiumPaid = 0;
        await runOtm(engine, ['AAPL']);

        expect(stub.buyContractsLimit).not.toHaveBeenCalled();
        const canary = gateOf('canary_ceiling');
        expect(canary).toMatchObject({ evaluated: 1, blocked: 1 });
        expect(canary.byReason).toEqual([
          { reasonCode: 'canary_ceiling_unpriced_rows', blocked: 1, share: 1 },
        ]);
      });
    });

    // ── TRA-3964 ────────────────────────────────────────────────────────────
    // `E_i = cash + atRisk` is invariant under taking risk ONLY IF BOTH HALVES
    // MOVE TOGETHER. `openPremiumAtRiskUsd` is synchronous (a fold over the
    // in-memory book); `availableCashUsd` is a broker snapshot refreshed at most
    // every 120s, and `mirrorLiveOptionOpen` forced a refresh on `rejected` and
    // `walk_exhausted` — where NO cash moved — but not on `filled`. So for four
    // scanner ticks after every live fill the basis DOUBLE-COUNTS the premium
    // just spent, in the ADMITTING direction, by `φ_eff · x`.
    //
    // ⭐ THESE RUN AGAINST THE ENGINE THROUGH A REAL FILL, deliberately. The
    // resolver suite cannot catch this: `resolveLiveOtmSizingBasisUsd(500, 82)`
    // is arithmetically perfect and always was. The defect is entirely in WHEN
    // its two operands were sampled, and only the order path can express that.
    //
    // ⚠ Every assertion below is written against the PUBLIC row, using no
    // symbol this fix introduced, so it is runnable — and RED — on `355ca553`.
    describe('unsettled premium (TRA-3964)', () => {
      /** The book the grader runs on: poor enough that `φ_eff · E` binds, not `A`. */
      const CASH_USD = 500;
      /**
       * The cash the broker actually took: `avgFillPrice 0.82 × 1 × 100`.
       *
       * ⚠ NOT the same as what the engine BOOKS. The stub's ask is $0.82 and its
       * mid $0.80, and the row lands with `premiumPaid 0.80` — so $82 leaves the
       * account against $80 of recorded at-risk. The correction deducts the
       * BROKER's figure, deliberately: it corrects the CASH half, and the cash
       * half moved by $82. (The $2 is entry slippage. It is a real reduction in
       * this book's capital and shows up identically on a settled book, so it is
       * not something this fix introduces — see `settledReference` below.)
       */
      const FILL_CASH_USD = 82;
      /**
       * What the engine BOOKS as at-risk for that same fill.
       *
       * ⚠ TRA-3965 MOVED THIS, 80 → 82, and the move is the successor ticket's
       * whole point. `premiumPaid` is still the scanner's mark ($0.80) — no stop
       * on the row moved — but the fold now ADDS the premium the broker actually
       * took and did not book (`brokerEntryFill 0.82`), so the figure the order
       * path gates on is the $82 that left the account rather than the $80 our
       * mid recorded. The two constants are equal from here on, and that
       * equality IS the fix: at-risk can no longer read below the cash spent.
       *
       * ⛔ THIS DOES NOT WEAKEN THE GRADER BELOW. TRA-3964's discriminator is
       * the CASH half: on `355ca553` the served row carried the pre-fill $500 of
       * cash against an already-debited book, so `E_i` read $580 and `capUsd`
       * $281.76 — still nowhere near the $242.90 both sides agree on now. What
       * changed is which lot the reference book holds, not what is being
       * compared.
       */
      const BOOK_AT_RISK_USD = FILL_CASH_USD;
      /**
       * `E_i` once the dust settles: $418 cash + $82 at risk.
       *
       * ⭐ It is $500 — the book's whole pre-trade capital — and post-TRA-3965
       * that is the CORRECT reading, not a coincidence. `openPremiumAtRiskUsd`
       * is an ENTRY-BASIS fold by construction (TRA-3445: the board bounded what
       * may be SPENT), so a book that spent $82 on a lot holds $82 of basis and
       * `E_i` does not move at all across the fill. It used to land on $498
       * because the fold booked $80 for an $82 spend — i.e. the $2 shortfall
       * showed up as capital that had evaporated, which is exactly the
       * mis-statement TRA-3965 was filed on.
       */
      const SETTLED_BASIS_USD = CASH_USD - FILL_CASH_USD + BOOK_AT_RISK_USD;
      /** `φ · E` at `E = $500`, floored to the cent — the SETTLED cap. */
      const SETTLED_CAP_USD = 242.90;

      /**
       * The reference: the same book AFTER the broker has debited the fill —
       * $418 of cash and $80 already at risk.
       *
       * ⭐ THIS IS THE POINT. Settled and skewed are the SAME BOOK holding the
       * same contract with the same money gone; they differ only in whether the
       * cash snapshot has caught up. A basis that is invariant under taking risk
       * must publish identical numbers for the two, and that equality is what
       * makes this a grader rather than a restatement of the implementation.
       */
      function settledReference(): SignalEngine {
        const engine = bookWithCash(liveStub(), CASH_USD - FILL_CASH_USD);
        seedOpenLivePremium(engine, BOOK_AT_RISK_USD);
        return engine;
      }

      it('AC1 — a live fill against a pre-fill balance snapshot must not inflate the cap', async () => {
        const stub = liveStub();
        const engine = bookWithCash(stub, CASH_USD);
        await runOtm(engine, ['AAPL']);

        // The fill is real: broker called, row on the live book, $80 at risk.
        expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
        expect(engine.getState().options.openOptions).toHaveLength(1);

        const served = engine.getLiveOtmAggregateExposure();
        expect(served.openPremiumAtRiskUsd).toBe(BOOK_AT_RISK_USD);

        // ⭐ THE GRADER. On `355ca553` the cash half is still the pre-fill $500
        // while the premium half already carries the $80, so `E_i` reads $580
        // and every column below comes out `φ · $82 = $39.84` too high:
        //   capUsd 281.76 · headroomSignedUsd 201.76 · admissibleEntryUsd 201.76
        // against a settled book's 241.92 / 161.92 / 161.92.
        const settled = settledReference().getLiveOtmAggregateExposure();
        expect(served.capUsd).toBeLessThanOrEqual(settled.capUsd);
        expect(served.headroomSignedUsd!).toBeLessThanOrEqual(settled.headroomSignedUsd!);
        expect(served.admissibleEntryUsd).toBeLessThanOrEqual(settled.admissibleEntryUsd);

        // Pinned, not merely bounded: `≤` alone would pass a build that darkened
        // the book instead of correcting it, which is a different bug.
        expect(served.capUsd).toBe(SETTLED_CAP_USD);
        expect(served.sizingBasisUsd).toBe(SETTLED_BASIS_USD);
        expect(served.headroomSignedUsd).toBe(SETTLED_CAP_USD - BOOK_AT_RISK_USD);
        expect(settled.capUsd).toBe(SETTLED_CAP_USD);
      });

      it('AC4 (negative control) — the SAME grader is GREEN on a settled book', () => {
        // No fill has happened since the snapshot: the cash half already contains
        // the debit. Served and reference are the same object shape and must
        // agree exactly — so the grader above cannot be simply always-red.
        const served = settledReference().getLiveOtmAggregateExposure();
        const settled = settledReference().getLiveOtmAggregateExposure();
        expect(served.capUsd).toBe(settled.capUsd);
        expect(served.headroomSignedUsd).toBe(settled.headroomSignedUsd);
        expect(served.admissibleEntryUsd).toBe(settled.admissibleEntryUsd);
        expect(served.capUsd).toBe(SETTLED_CAP_USD);
      });

      it('AC4 (second control) — a FLAT book is untouched: the correction is $0, not a haircut', () => {
        // The whole fix must be a no-op whenever nothing is pending. A build that
        // deducted unconditionally would tighten every book on the fleet.
        const flat = bookWithCash(liveStub(), CASH_USD).getLiveOtmAggregateExposure();
        expect(flat.availableCashUsd).toBe(CASH_USD);
        expect(flat.brokerCashUsd).toBe(CASH_USD);
        expect(flat.unsettledLivePremiumUsd).toBe(0);
        expect(flat.capUsd).toBe(242.90); // φ · $500 — untouched by this ticket
        expect(flat.openPremiumAtRiskUsd).toBe(0);
      });

      it('AC2 — the snapshot\'s age and the pending premium are ON THE WIRE', async () => {
        const engine = bookWithCash(liveStub(), CASH_USD);
        await runOtm(engine, ['AAPL']);
        const row = engine.getLiveOtmAggregateExposure();

        // The three columns that make a skewed reading distinguishable from a
        // settled one. Before this ticket the payload carried NONE of them, so
        // the two were byte-identical and the skew healed itself in 120s.
        expect(row.unsettledLivePremiumUsd).toBe(FILL_CASH_USD);
        expect(row.unsettledLivePremiumFills).toBe(1);
        expect(row.unsettledLivePremiumBlindFills).toBe(0);
        // The broker's own figure is published beside the corrected one, so the
        // correction is auditable rather than folded away.
        expect(row.brokerCashUsd).toBe(CASH_USD);
        expect(row.availableCashUsd).toBe(CASH_USD - FILL_CASH_USD);
        expect(row.brokerCashUsd! - row.availableCashUsd!).toBe(row.unsettledLivePremiumUsd);
        // This harness injects the balance without ever fetching it, so there is
        // no as-of stamp — and `null` says exactly that. It must NOT read as 0ms
        // ("fetched just now"), which is the fail-open reading.
        expect(row.balanceAsOfMs).toBeNull();
        expect(row.balanceAgeMs).toBeNull();
      });

      it('the deduction CLEARS on a snapshot taken after the fill — it is not a permanent haircut', async () => {
        const engine = bookWithCash(liveStub(), CASH_USD);
        await runOtm(engine, ['AAPL']);
        expect(engine.getLiveOtmAggregateExposure().unsettledLivePremiumUsd).toBe(FILL_CASH_USD);

        // Back-date the fill so a refresh landing NOW is comfortably past the
        // settlement grace, then hand the engine the DEBITED balance — exactly
        // what the 120s `doTick` refresh does once Tradier has taken the money.
        const priv = engine as unknown as {
          unsettledLivePremiumFills: Array<{ filledAtMs: number }>;
          tradierLiveClient: { getAccountBalance: () => Promise<unknown> };
          refreshTradierBalance: () => Promise<void>;
        };
        priv.unsettledLivePremiumFills[0]!.filledAtMs = Date.now() - 60_000;
        const debited = CASH_USD - FILL_CASH_USD;
        priv.tradierLiveClient.getAccountBalance = async () => ({
          totalEquity: debited, totalCash: debited,
          optionBuyingPower: debited, dayTradeBuyingPower: debited,
        });
        await priv.refreshTradierBalance();

        const row = engine.getLiveOtmAggregateExposure();
        // The debit is now in the broker's own number, so deducting it AGAIN
        // would double-count in the OTHER direction and tighten the book by $82.
        expect(row.unsettledLivePremiumUsd).toBe(0);
        expect(row.unsettledLivePremiumFills).toBe(0);
        expect(row.brokerCashUsd).toBe(debited);
        expect(row.availableCashUsd).toBe(debited);
        // ⭐ The published row is IDENTICAL either side of the settlement
        // boundary. That invariance is the property TRA-3897's algebra claimed
        // and this ticket restores — and it is why the correction is a
        // correction rather than a haircut.
        expect(row.sizingBasisUsd).toBe(SETTLED_BASIS_USD);
        expect(row.capUsd).toBe(SETTLED_CAP_USD);
        expect(row.balanceAsOfMs).not.toBeNull();
        expect(row.balanceAgeMs).toBeGreaterThanOrEqual(0);
      });

      it('a FAILED refresh does not clear the deduction — the snapshot underneath is as old as ever', async () => {
        const engine = bookWithCash(liveStub(), CASH_USD);
        await runOtm(engine, ['AAPL']);
        const priv = engine as unknown as {
          lastTradierBalanceSuccessAt: number;
          tradierLiveClient: { getAccountBalance: () => Promise<unknown> };
          refreshTradierBalance: () => Promise<void>;
        };
        // A snapshot taken a minute ago — i.e. BEFORE the fill, and recent
        // enough that `TRADIER_BALANCE_STALE_MS` does not drop it on the failure.
        priv.lastTradierBalanceSuccessAt = Date.now() - 60_000;
        priv.tradierLiveClient.getAccountBalance = async () => { throw new Error('502'); };
        await priv.refreshTradierBalance();

        // `lastTradierBalanceFetchAt` moved (it is stamped in a `finally`); the
        // SNAPSHOT did not. Pruning off the attempt stamp would clear a fill the
        // cached cash figure still has not accounted for — the fail-open again,
        // one layer down.
        const row = engine.getLiveOtmAggregateExposure();
        expect(row.unsettledLivePremiumUsd).toBe(FILL_CASH_USD);
        expect(row.availableCashUsd).toBe(CASH_USD - FILL_CASH_USD);
        expect(row.capUsd).toBe(SETTLED_CAP_USD);
      });

      // ── AC3 ───────────────────────────────────────────────────────────────
      // `liveAvailableCashUsd()` is `min(optionBuyingPower, totalCash,
      // totalEquity)`. On an option BUY, OBP and totalCash fall by the premium
      // but `totalEquity` DOES NOT (cash becomes an asset). So if the `min`
      // resolved to `totalEquity` on this account, the cash half would never
      // fall on a buy at all and the double-count would be PERMANENT rather
      // than bounded by the refresh interval — a strictly worse variant.
      //
      // ⭐ MEASURED, NOT READ. `GET /api/state` on bqb1's `admin` book, live SHA
      // `355ca553b437ef9de7ea8759bbd1461ed4c0839b`, 2026-08-22T~17:40Z, live
      // mode: the payload's `account` block IS the Tradier balance in live mode
      // (`signal-engine.ts` `liveAccount`), so it carries all three components:
      //
      //     optionBuyingPower  $379.15   ← THE MINIMUM. This one binds.
      //     totalCash          $411.15
      //     totalEquity        $652.15
      //
      // ⇒ THE PERMANENT VARIANT IS RULED OUT BY MEASUREMENT. And the ordering is
      // stable in the direction that matters: a fill moves the two smaller
      // components DOWN and leaves `totalEquity` alone, so the `min` can only
      // stay where it is. The second assertion measures that rather than
      // asserting it.
      //
      // (`$652.15` is also the `E_i` TRA-3964 was filed on — `$379.15` cash +
      // `$273.00` at risk. It coincides with `totalEquity` on this account and
      // that is a coincidence, not an identity. Do not read one off the other.)
      it('AC3 — the `min` binds on optionBuyingPower, which DOES fall on a buy', () => {
        const engine = engineFor('live', liveStub());
        const setBalance = (obp: number, cash: number, equity: number) => {
          (engine as unknown as { liveTradierBalance: unknown }).liveTradierBalance = {
            totalEquity: equity, totalCash: cash, optionBuyingPower: obp,
          };
        };

        setBalance(379.15, 411.15, 652.15);            // bqb1 `admin`, as measured
        expect(engine.getLiveOtmAggregateExposure().brokerCashUsd).toBe(379.15);

        // A $100 buy: OBP and cash down $100, equity unchanged. If the min were
        // pinned to equity this would not move — that is the permanent variant.
        setBalance(279.15, 311.15, 652.15);
        expect(engine.getLiveOtmAggregateExposure().brokerCashUsd).toBe(279.15);
      });

      // ── TRA-3970 ────────────────────────────────────────────────────────────
      // The parse-site refusal of the broker's all-zeros maintenance envelope
      // lives in `TradierOptionsClient.getAccountBalance` (engine package,
      // covered there). What THIS row owes is the discriminator: the refusal
      // count on the wire, and `null` — never a manufactured 0 — when the
      // client cannot report it (ABSENT ≠ 0).
      it('TRA-3970 — the suppression counter is ON THE WIRE, and null when unreadable', () => {
        const engine = engineFor('live', liveStub());
        const priv = engine as unknown as { tradierLiveClient: unknown };
        // `liveStub()` predates the counter: the row must read UNREADABLE.
        let row = engine.getLiveOtmAggregateExposure();
        expect(row.balanceZeroArtifactSuppressions).toBeNull();
        expect(row.balanceZeroArtifactLastAtMs).toBeNull();
        // A client that refused two artifact envelopes publishes them verbatim.
        priv.tradierLiveClient = {
          ...liveStub(),
          getZeroBalancesArtifactSuppression: () => ({ count: 2, lastAtMs: 1_756_000_000_000 }),
        };
        row = engine.getLiveOtmAggregateExposure();
        expect(row.balanceZeroArtifactSuppressions).toBe(2);
        expect(row.balanceZeroArtifactLastAtMs).toBe(1_756_000_000_000);
      });
    });

    // ── TRA-3965 ────────────────────────────────────────────────────────────
    // The PREMIUM half of the same skew. TRA-3964 corrected the CASH half; this
    // is the other operand, and it fails the same way in the same direction:
    // `openPremiumAtRiskUsd` folds `premiumPaid`, an engine open books
    // `premiumPaid = signal.mark` (the scanner's pre-trade mid), and the broker
    // charges `avgFillPrice`. The stub's mid is $0.80 and its fill $0.82, so
    // the fold spends $80 for a lot that cost $82 — an understatement, which
    // OVERSTATES `admissibleEntryUsd` and understates `Σ atRisk_j` against `A`.
    //
    // ⚠ MEASURED FIRST, AND THE FILING'S PREMISE DID NOT SURVIVE IT.
    // `restateEngineOpenedBasis` (TRA-2889/TRA-2873) DOES re-stamp an
    // engine-opened live row to the broker's `cost_basis / quantity / 100` on
    // the reconcile sweep, rescaling the stop schedule with it. Read off bqb1's
    // durable log on 2026-08-22 (`GET /api/options/basis-restatements`):
    //
    //     SOFI260925C00019000  1.205 -> 1.23  broker_reconcile  fill +23.1 s
    //     BAC260925C00063000   1.51  -> 1.65  broker_reconcile  fill +72.3 s
    //
    // …and the live gap across all three open lots was $0.00 at grading time.
    // So this is a WINDOW (fill ack → next matching reconcile), not the
    // permanent life-of-position defect the ticket describes — except on the
    // rows where that sweep is skipped by design and never runs at all
    // (`quantity_mismatch` — a desk add on the same OCC — plus `multi_leg`,
    // `covered_write`, and every state where the broker read fails).
    //
    // ⭐ THE FIX IS A SEPARATE COLUMN, NEVER A WRITE TO `premiumPaid`. That
    // field is READ by the stop engine and SPENT by the fold, and TRA-3958 is
    // the measured proof that moving it moves both. So the realized fill is
    // stamped as `brokerEntryFill` and the fold ADDS the shortfall.
    describe('unbooked entry premium (TRA-3965)', () => {
      /** `avgFillPrice 0.82 × 1 × 100` — the cash the broker actually took. */
      const FILL_CASH_USD = 82;
      /** `premiumPaid 0.80 × 1 × 100` — what the row books at open. */
      const MARK_AT_RISK_USD = 80;

      /** The `liveStub`, with the broker filling at `price` instead of the ask. */
      function stubFilledAt(price: number) {
        const stub = liveStub();
        stub.waitForOrderTerminalStatus = vi.fn(async () => ({
          id: 42, status: 'filled', avg_fill_price: price,
        })) as unknown as typeof stub.waitForOrderTerminalStatus;
        return stub;
      }

      const openRowOf = (engine: SignalEngine) =>
        engine.getState().options.openOptions.find((o) => o.optionSymbol !== 'MSFT240705C00420000')!;

      it('AC2 — a fill ABOVE the mark must not publish an at-risk BELOW the cash the broker took', async () => {
        const stub = liveStub();
        const engine = bookWithCash(stub, 500);
        await runOtm(engine, ['AAPL']);

        // The fill is real, and it is the skewed one: booked $80, charged $82.
        expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
        const row = openRowOf(engine);
        expect(row.premiumPaid).toBe(0.80);
        expect(row.brokerEntryFill).toMatchObject({ premiumPaid: 0.82, contracts: 1 });

        // ⭐ THE GRADER. RED on `8c96ed6d`, which publishes exactly $80.00 here
        // — a lot the broker was paid $82.00 for. Written as an inequality
        // against the broker's own figure so it states the PROPERTY, not this
        // implementation's arithmetic.
        const served = engine.getLiveOtmAggregateExposure();
        expect(served.openPremiumAtRiskUsd).toBeGreaterThanOrEqual(FILL_CASH_USD);
        // Pinned too: `≥` alone would pass a build that inflated at-risk
        // wholesale, which tightens the book for a reason nobody asked for.
        expect(served.openPremiumAtRiskUsd).toBe(FILL_CASH_USD);

        // The correction is READABLE, not folded away — same discipline as
        // `unpricedOpenRows` and `operatorPinnedAtRiskUsd`.
        expect(served.unbookedEntryPremiumUsd).toBe(FILL_CASH_USD - MARK_AT_RISK_USD);
        expect(served.unbookedEntryPremiumRows).toBe(1);
        expect(served.unbookedEntryPremiumSuppressedUsd).toBe(0);

        // ⛔ AC3 (stop half) — the stop engine's inputs are BYTE-IDENTICAL to
        // the pre-fix build. `premiumPaid` still holds the mark, and every level
        // is still the mark's multiple: an at-risk correction that moved a stop
        // on a real-money row is the TRA-3958 defect, and it is what the
        // separate column exists to make impossible.
        expect(row.premiumPaid).toBe(0.80);
        expect(row.stopLossPremium).toBe(0.80 * 0.8);
        expect(row.tp1Premium).toBe(0.80 * 1.5);
      });

      it('AC4 (negative control) — the SAME grader is GREEN on a lot filled AT the mark', async () => {
        // Price improvement to the mid: the broker took exactly what the row
        // books. The correction must be $0 — a build that added unconditionally
        // would tighten every book on the fleet, and this grader would be
        // simply always-red rather than a discriminator.
        const stub = stubFilledAt(0.80);
        const engine = bookWithCash(stub, 500);
        await runOtm(engine, ['AAPL']);

        expect(stub.buyContractsLimit).toHaveBeenCalledTimes(1);
        expect(openRowOf(engine).brokerEntryFill).toMatchObject({ premiumPaid: 0.80 });

        const served = engine.getLiveOtmAggregateExposure();
        expect(served.openPremiumAtRiskUsd).toBeGreaterThanOrEqual(MARK_AT_RISK_USD);
        expect(served.openPremiumAtRiskUsd).toBe(MARK_AT_RISK_USD);
        expect(served.unbookedEntryPremiumUsd).toBe(0);
        expect(served.unbookedEntryPremiumRows).toBe(0);
      });

      it('AC4 (second control) — a fill BELOW the mark does NOT lower at-risk', async () => {
        // ⛔ THE TIGHTENING CLAMP. Booking a better-than-mark fill here would
        // LOWER `atRisk` and buy entry admission — a fresh fail-open shipped
        // inside the fix for the old one. Correcting the basis downward is the
        // reconcile's job (it carries the stops across when it does); this
        // column may only ever ADD.
        const engine = bookWithCash(stubFilledAt(0.70), 500);
        await runOtm(engine, ['AAPL']);

        const served = engine.getLiveOtmAggregateExposure();
        expect(openRowOf(engine).brokerEntryFill).toMatchObject({ premiumPaid: 0.70 });
        expect(served.openPremiumAtRiskUsd).toBe(MARK_AT_RISK_USD);
        expect(served.unbookedEntryPremiumUsd).toBe(0);
      });

      it('the correction CLEARS once the reconcile re-stamps the basis — the two fixes compose', async () => {
        const engine = bookWithCash(liveStub(), 500);
        await runOtm(engine, ['AAPL']);
        expect(engine.getLiveOtmAggregateExposure().unbookedEntryPremiumUsd).toBe(2);

        // What `restateEngineOpenedBasis` does 23 s later on the live host:
        // move `premiumPaid` to broker truth and rescale the schedule.
        const row = openRowOf(engine);
        row.premiumPaid = 0.82;
        row.stopLossPremium = 0.82 * 0.8;
        row.tp1Premium = 0.82 * 1.5;

        // The uplift is now $0 — the row books what the broker charged — and
        // `openPremiumAtRiskUsd` is UNCHANGED at $82. Both paths land on the
        // same number, which is why they can ship together without one
        // double-counting the other.
        const served = engine.getLiveOtmAggregateExposure();
        expect(served.unbookedEntryPremiumUsd).toBe(0);
        expect(served.openPremiumAtRiskUsd).toBe(FILL_CASH_USD);
      });
    });
  });
});

describe('SignalEngine — wheel paper routing (TRA-1977)', () => {
  const EXP = '2024-07-19'; // ~45 DTE from TRADING_TIME → clears the 21 DTE C3 gate
  const SPOT = 100;
  const T = dteForWheel(EXP, TRADING_TIME) / 365;
  // Near-flat closes → tiny realised vol, so the 0.45-IV chain is strongly
  // VRP-positive and put-credit-spreads assemble.
  const CALM_CLOSES = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? 0.1 : -0.1));

  function wheelRow(underlying: string, strike: number, optionType: 'call' | 'put', iv = 0.45) {
    const mark = bsPriceForWheel({ spot: SPOT, strike, timeToExpiryYears: T, riskFreeRate: 0.045, volatility: iv, optionType });
    const half = Math.max(mark * 0.02, 0.01);
    return {
      optionSymbol: `${underlying}${strike}${optionType[0]!.toUpperCase()}`,
      underlying, optionType, strike, expiration: EXP,
      bid: mark - half, ask: mark + half, last: mark,
      volume: 500, openInterest: 2000, smvVol: iv, midIv: iv,
    };
  }
  function wheelChain(underlying: string) {
    const strikes = [82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 118];
    return strikes.flatMap((k) => [wheelRow(underlying, k, 'put'), wheelRow(underlying, k, 'call')]);
  }
  function scannerFor(snaps: Record<string, SelectorChainSnapshot>): RelativeValueScannerService {
    return {
      scan: vi.fn(async () => ({ symbol: '', spot: null, expiration: null, candidates: [], reason: 'ok' as const })),
      scanOtm: vi.fn(async () => ({ symbol: '', spot: null, expiration: null, candidates: [], reason: 'unavailable' as const })),
      getSelectorChain: vi.fn(async (sym: string) => snaps[sym] ?? null),
      getOptionMark: vi.fn(async () => null),
      diagnostics: vi.fn(() => ({ configured: true, breakerOpen: false, breakerOpenedAtMs: null, cacheSize: 0, expirationsCacheSize: 0, chainCacheMaxEntries: 64, expirationsCacheMaxEntries: 64 })),
    };
  }
  function runShortPremium(engine: SignalEngine, syms: string[]): Promise<void> {
    return (engine as unknown as { evaluateShortPremiumScan: (s: string[]) => Promise<void> }).evaluateShortPremiumScan(syms);
  }
  function seedCloses(engine: SignalEngine, sym: string, closes: number[]): void {
    (engine as unknown as { dailyCloseCache: Map<string, number[]> }).dailyCloseCache.set(sym, closes);
  }
  function demoCoveredWrites(engine: SignalEngine, sym: string) {
    const acct = (engine as unknown as { optionsAccount: { getStateForMode: (m: 'demo' | 'live') => { openOptions: Array<{ symbol: string; coveredWrite?: string; optionType?: string; strike?: number }> } } }).optionsAccount;
    return acct.getStateForMode('demo').openOptions.filter((o) => o.coveredWrite && o.symbol === sym);
  }

  let ivFile: string;
  let m = 0;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME);
    ivFile = join(tmpdir(), `wheel-iv-${process.pid}-${m++}.json`);
    setIvStoreFileForTests(ivFile);
    await initIvRankStore();
    // Warm the trailing-year IV store so AAPL's ~0.45 ATM IV ranks well above the
    // 50 elevated-IV floor (the full-pass routing gate). 30 ascending samples.
    for (let i = 1; i <= 30; i++) {
      await recordDailyIv('AAPL', 0.05 + (0.40 * (30 - i)) / 29, TRADING_TIME - i * 86_400_000);
    }
    delete process.env[OPTION_SHORT_PREMIUM_SCANNER_FLAG];
    delete process.env[OPTION_WHEEL_ROUTING_FLAG];
  });
  afterEach(() => {
    setIvStoreFileForTests(null);
    delete process.env[OPTION_SHORT_PREMIUM_SCANNER_FLAG];
    delete process.env[OPTION_WHEEL_ROUTING_FLAG];
    try { rmSync(ivFile); } catch { /* ignore */ }
    vi.useRealTimers();
  });

  it('both flags on — opens a cash-secured put on the demo book for an in-universe name', async () => {
    process.env[OPTION_SHORT_PREMIUM_SCANNER_FLAG] = '1';
    process.env[OPTION_WHEEL_ROUTING_FLAG] = '1';
    const svc = scannerFor({ AAPL: { symbol: 'AAPL', spot: SPOT, expiration: EXP, rows: wheelChain('AAPL') } });
    const engine = new SignalEngine(undefined, undefined, svc);
    seedCloses(engine, 'AAPL', CALM_CLOSES);

    await runShortPremium(engine, ['AAPL']);

    const writes = demoCoveredWrites(engine, 'AAPL');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.coveredWrite).toBe('cash_secured_put');
    expect(writes[0]!.optionType).toBe('put');
    expect(writes[0]!.strike).toBeLessThan(SPOT); // OTM short put
  });

  it('scanner on but wheel sub-flag off — stays observe-only, routes nothing', async () => {
    process.env[OPTION_SHORT_PREMIUM_SCANNER_FLAG] = '1';
    // wheel routing flag left OFF
    const svc = scannerFor({ AAPL: { symbol: 'AAPL', spot: SPOT, expiration: EXP, rows: wheelChain('AAPL') } });
    const engine = new SignalEngine(undefined, undefined, svc);
    seedCloses(engine, 'AAPL', CALM_CLOSES);

    await runShortPremium(engine, ['AAPL']);

    expect(demoCoveredWrites(engine, 'AAPL')).toHaveLength(0);
  });

  it('does not route an off-universe name even with both flags on', async () => {
    process.env[OPTION_SHORT_PREMIUM_SCANNER_FLAG] = '1';
    process.env[OPTION_WHEEL_ROUTING_FLAG] = '1';
    const svc = scannerFor({ GME: { symbol: 'GME', spot: SPOT, expiration: EXP, rows: wheelChain('GME') } });
    const engine = new SignalEngine(undefined, undefined, svc);
    seedCloses(engine, 'GME', CALM_CLOSES);
    await recordDailyIv('GME', 0.45, TRADING_TIME - 86_400_000);

    await runShortPremium(engine, ['GME']);

    expect(demoCoveredWrites(engine, 'GME')).toHaveLength(0);
  });
});

// TRA-1980 — the SHADOW-first record call-sites: the live-equity and live-option
// mirror paths now feed `recordLiquidityGateDecision`. These exercise the two
// private record helpers directly (the same seam the mirror paths call), asserting
// (a) the candidate shape/id/orderQty per engine, and (b) that the kill switch keeps
// flag-off a total no-op — no ledger row and, for options, not even a broker quote.
describe('TRA-1980 — pre-trade liquidity record call-sites (SHADOW-first)', () => {
  const tmpFile = join(
    tmpdir(),
    `pre-trade-liquidity-callsite-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`,
  );

  beforeEach(() => {
    setPreTradeLiquidityLedgerFileForTests(tmpFile);
    try { rmSync(tmpFile); } catch { /* fresh run */ }
    delete process.env[PRE_TRADE_LIQUIDITY_FLAG];
  });
  afterEach(() => {
    delete process.env[PRE_TRADE_LIQUIDITY_FLAG];
    setPreTradeLiquidityLedgerFileForTests(null);
    try { rmSync(tmpFile); } catch { /* best-effort cleanup */ }
  });

  const equitySignal = {
    symbol: 'AAPL', side: 'buy', timestamp: 1_720_000_000_000,
  } as unknown as TradeSignal;
  const equityPos = { quantity: 100 } as unknown as Position;

  function engineWithEquityBook(book: Record<string, unknown> = {}): SignalEngine {
    const engine = new SignalEngine(undefined, undefined, undefined);
    (engine as unknown as { symbolState: Map<string, unknown> }).symbolState.set('AAPL', {
      symbol: 'AAPL', price: 100, volume: 1, change: 0, changePct: 0,
      lastUpdated: Date.now(), quoteStatus: 'ok',
      bid: 99.9, ask: 100.1, bidSize: 10, askSize: 12, ...book,
    });
    return engine;
  }

  const callEquity = (engine: SignalEngine): Promise<void> =>
    (engine as unknown as {
      recordEquityLiquidityShadow: (s: TradeSignal, p: Position) => Promise<void>;
    }).recordEquityLiquidityShadow(equitySignal, equityPos);

  it('equity: records an engine:equity decision off the symbol L1 book when the flag is on', async () => {
    process.env[PRE_TRADE_LIQUIDITY_FLAG] = 'true';
    await callEquity(engineWithEquityBook());
    const rows = await listLiquidityGateDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'equity:AAPL:buy:1720000000000',
      engine: 'equity', side: 'buy',
      bid: 99.9, ask: 100.1, bidSize: 10, askSize: 12,
      orderQty: 100, // shares
      impactMeasured: true,
    });
  });

  it('equity: flag OFF is a total no-op (nothing written)', async () => {
    await callEquity(engineWithEquityBook());
    expect(await listLiquidityGateDecisions()).toHaveLength(0);
  });

  it('equity: skips a symbol with no L1 book (fallback feed) rather than recording a bogus row', async () => {
    process.env[PRE_TRADE_LIQUIDITY_FLAG] = 'true';
    // Book fields cleared → a Yahoo/Stooq-sourced quote with no bid/ask.
    await callEquity(engineWithEquityBook({ bid: undefined, ask: undefined, bidSize: undefined, askSize: undefined }));
    expect(await listLiquidityGateDecisions()).toHaveLength(0);
  });

  const callOption = (engine: SignalEngine, opened: unknown): Promise<void> =>
    (engine as unknown as {
      recordOptionLiquidityShadow: (o: unknown) => Promise<void>;
    }).recordOptionLiquidityShadow(opened);

  it('options: records an engine:options buy decision with orderQty=contracts*100 from the option quote', async () => {
    process.env[PRE_TRADE_LIQUIDITY_FLAG] = 'true';
    const engine = new SignalEngine(undefined, undefined, undefined);
    const getOptionQuote = vi.fn(async () => ({ symbol: 'AAPL240920C00190000', bid: 1.00, ask: 1.20 }));
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = { getOptionQuote };

    await callOption(engine, {
      symbol: 'AAPL', optionSymbol: 'AAPL240920C00190000', contracts: 2, openedAt: 999,
    });

    expect(getOptionQuote).toHaveBeenCalledWith('AAPL240920C00190000');
    const rows = await listLiquidityGateDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'options:AAPL:buy:999', engine: 'options', side: 'buy',
      bid: 1.00, ask: 1.20, orderQty: 200,
    });
    // The Tradier option quote carries no displayed sizes ⇒ spread-only (unmeasured impact).
    expect(rows[0]!.impactMeasured).toBe(false);
  });

  it('options: flag OFF makes no broker quote call and writes nothing', async () => {
    const engine = new SignalEngine(undefined, undefined, undefined);
    const getOptionQuote = vi.fn(async () => ({ symbol: 'X', bid: 1, ask: 2 }));
    (engine as unknown as { tradierLiveClient: unknown }).tradierLiveClient = { getOptionQuote };

    await callOption(engine, {
      symbol: 'AAPL', optionSymbol: 'AAPL240920C00190000', contracts: 2, openedAt: 1,
    });

    expect(getOptionQuote).not.toHaveBeenCalled();
    expect(await listLiquidityGateDecisions()).toHaveLength(0);
  });
});

describe('TRA-1996 — decoupled quote-refresh gate (shouldRunDecoupledQuoteRefresh)', () => {
  const base = { running: false, marketOpen: true, now: 1_000_000, lastQuoteStampAt: 0 };

  it('runs when the market is open, idle, and no recent stamp', () => {
    expect(shouldRunDecoupledQuoteRefresh(base)).toBe(true);
  });

  it('never runs while a quote refresh is already in flight (no self-overlap)', () => {
    expect(shouldRunDecoupledQuoteRefresh({ ...base, running: true })).toBe(false);
  });

  it('never runs off-hours — the 250s-tick starvation it covers only happens during RTH', () => {
    expect(shouldRunDecoupledQuoteRefresh({ ...base, marketOpen: false })).toBe(false);
  });

  it('dedups against a doTick (or prior) stamp inside the min gap, then re-arms past it', () => {
    // A stamp 5s ago (< 20s gap) suppresses the refresh...
    expect(
      shouldRunDecoupledQuoteRefresh({ ...base, now: 100_000, lastQuoteStampAt: 95_000 }),
    ).toBe(false);
    // ...but once the gap has elapsed it fires again, so a stuck 250s tick never
    // lets quotes age past the freshness gate.
    expect(
      shouldRunDecoupledQuoteRefresh({ ...base, now: 100_000, lastQuoteStampAt: 79_000 }),
    ).toBe(true);
  });

  it('honours an explicit minGapMs override', () => {
    // gap = now - lastQuoteStampAt = 45_000ms.
    // A tighter 40s gap has elapsed -> runs.
    expect(
      shouldRunDecoupledQuoteRefresh({ ...base, now: 100_000, lastQuoteStampAt: 55_000, minGapMs: 40_000 }),
    ).toBe(true);
    // A wider 50s gap has not -> suppressed.
    expect(
      shouldRunDecoupledQuoteRefresh({ ...base, now: 100_000, lastQuoteStampAt: 55_000, minGapMs: 50_000 }),
    ).toBe(false);
  });
});

describe('TRA-2200 — decoupled exit-evaluation gate (shouldRunDecoupledExitPass)', () => {
  const base = {
    enabled: true,
    running: false,
    tickExitRegionActive: false,
    marketOpen: true,
    now: 1_000_000,
    lastExitPassAt: 0,
  };

  it('runs when armed, idle, in-hours, outside doTick\'s exit region, past the gap', () => {
    expect(shouldRunDecoupledExitPass(base)).toBe(true);
  });

  it('is inert until the flag is armed — default OFF means no second exit path', () => {
    expect(shouldRunDecoupledExitPass({ ...base, enabled: false })).toBe(false);
  });

  it('never runs while a decoupled pass is already in flight (no self-overlap)', () => {
    expect(shouldRunDecoupledExitPass({ ...base, running: true })).toBe(false);
  });

  it('THE SAFETY INTERLOCK: never runs while doTick is inside its own exit region', () => {
    // This is the one that prevents a double `sell_to_close`. Two concurrent
    // passes over the same `pendingExit` intents would each stage and submit.
    expect(shouldRunDecoupledExitPass({ ...base, tickExitRegionActive: true })).toBe(false);
  });

  it('DOES run while a tick is in flight but PAST its exit region — the whole point', () => {
    // The interlock is keyed on the exit region, NOT on `tickRunning`. Gating on
    // the whole tick would re-serialise exits behind the same 853s tail this
    // exists to escape, i.e. it would ship the bug it is fixing. There is
    // deliberately no `tickRunning` field on this gate to key on.
    expect(shouldRunDecoupledExitPass({ ...base, tickExitRegionActive: false })).toBe(true);
  });

  it('never runs off-hours', () => {
    expect(shouldRunDecoupledExitPass({ ...base, marketOpen: false })).toBe(false);
  });

  it('dedups against a recent exit pass from EITHER cadence, then re-arms past the gap', () => {
    // doTick stamped 3s ago (< 8s gap) -> suppressed, so the two cadences do not
    // double-evaluate when they phase together.
    expect(
      shouldRunDecoupledExitPass({ ...base, now: 100_000, lastExitPassAt: 97_000 }),
    ).toBe(false);
    // 9s ago -> the gap has elapsed, so a tick stuck in its cold-bar tail can
    // never stall exit evaluation.
    expect(
      shouldRunDecoupledExitPass({ ...base, now: 100_000, lastExitPassAt: 91_000 }),
    ).toBe(true);
  });

  it('honours an explicit minGapMs override', () => {
    // gap = 15_000ms.
    expect(
      shouldRunDecoupledExitPass({ ...base, now: 100_000, lastExitPassAt: 85_000, minGapMs: 10_000 }),
    ).toBe(true);
    expect(
      shouldRunDecoupledExitPass({ ...base, now: 100_000, lastExitPassAt: 85_000, minGapMs: 20_000 }),
    ).toBe(false);
  });
});

describe('TRA-2257 — the gate NAMES the branch it refused on (decoupledExitPassDecision)', () => {
  const base = {
    enabled: true,
    running: false,
    tickExitRegionActive: false,
    marketOpen: true,
    now: 1_000_000,
    lastExitPassAt: 0,
  };

  it('returns a null skipReason exactly when the boolean gate says run', () => {
    expect(decoupledExitPassDecision(base).skipReason).toBeNull();
    expect(shouldRunDecoupledExitPass(base)).toBe(true);
  });

  it('names every refusal branch, so none of them is dark from outside', () => {
    expect(decoupledExitPassDecision({ ...base, enabled: false }).skipReason).toBe('disarmed');
    expect(decoupledExitPassDecision({ ...base, running: true }).skipReason).toBe('selfOverlap');
    expect(decoupledExitPassDecision({ ...base, tickExitRegionActive: true }).skipReason)
      .toBe('tickExitRegion');
    expect(decoupledExitPassDecision({ ...base, marketOpen: false }).skipReason)
      .toBe('marketClosed');
    expect(
      decoupledExitPassDecision({ ...base, now: 100_000, lastExitPassAt: 97_000 }).skipReason,
    ).toBe('minGap');
  });

  it('THE 2026-07-24 REGRESSION: a post-close window refuses on `marketClosed`, not on '
    + 'the stale-price branch that WAS counted', () => {
    // The grading session that filed this ticket read `decoupledExitSkippedStalePrices: 0`
    // on all 10 engines and reasoned about the hoist from that zero. The zero was
    // real and told you nothing: the gate refused two branches EARLIER, at
    // `marketClosed`, and never reached the counter. The whole 20:16-20:18Z window
    // sat after the 16:00 ET close.
    //
    // 2026-07-24T20:17:00Z == 16:17 ET, i.e. 17 minutes past the close.
    const postClose = Date.UTC(2026, 6, 24, 20, 17, 0);
    expect(isStockMarketOpen(postClose)).toBe(false);
    const decision = decoupledExitPassDecision({
      ...base,
      marketOpen: isStockMarketOpen(postClose),
      now: postClose,
      lastExitPassAt: postClose - 60_000, // well past minGap: not the gap's doing
    });
    expect(decision.skipReason).toBe('marketClosed');
    // ...and it is emphatically NOT `stalePrices`, which is scored after the gate.
    expect(decision.skipReason).not.toBe('stalePrices');
  });

  it('the skip-reason set covers every refusal the gate can emit (no unlabelled branch)', () => {
    // Positive control on the enumeration itself: if someone adds a gate clause
    // with a new reason and forgets the counter, this catches it, because
    // `emptyDecoupledExitSkips()` is keyed off the same list the roll-up sums.
    expect(Object.keys(emptyDecoupledExitSkips()).sort())
      .toEqual([...DECOUPLED_EXIT_SKIP_REASONS].sort());
    for (const r of DECOUPLED_EXIT_SKIP_REASONS) {
      expect(emptyDecoupledExitSkips()[r]).toBe(0);
    }
  });

  it('the interlock outranks the market gate, so an in-region fire is never mislabelled', () => {
    // Ordering matters for attribution, not just for correctness: during RTH the
    // ONLY branch that can suppress the timer is `tickExitRegion`, and that is the
    // reading TRA-2213's grade turns on.
    expect(
      decoupledExitPassDecision({ ...base, tickExitRegionActive: true, marketOpen: false })
        .skipReason,
    ).toBe('tickExitRegion');
  });
});

describe('TRA-2200 — exit-interval histogram (bucketExitInterval)', () => {
  it('puts the 30s invalidation bar on a BUCKET EDGE so p99 needs no interpolation', () => {
    // 29_999ms is the last value that counts as "under the bar"; 30_000 is the
    // first that counts as over it. A bucket straddling 30s would force the grade
    // to interpolate, and the whole point of the edge is that
    // `atOrAbove30s / samples < 0.01` IS "p99 < 30s".
    expect(bucketExitInterval(29_999)).toBe('lt30s');
    expect(bucketExitInterval(30_000)).toBe('lt60s');
  });

  it('classifies each bucket at its lower edge', () => {
    expect(bucketExitInterval(0)).toBe('lt5s');
    expect(bucketExitInterval(5_000)).toBe('lt10s');
    expect(bucketExitInterval(10_000)).toBe('lt15s');
    expect(bucketExitInterval(15_000)).toBe('lt30s');
    expect(bucketExitInterval(60_000)).toBe('lt120s');
    expect(bucketExitInterval(120_000)).toBe('lt300s');
    expect(bucketExitInterval(300_000)).toBe('gte300s');
  });

  it('keeps the 2026-07-23 pre-fix headline in the top bucket (853s max, 296s p99)', () => {
    // Directly comparable to the pre-fix numbers rather than a rescaled axis: if
    // the hoist did nothing, the post-fix read lands in the same buckets.
    expect(bucketExitInterval(853_400)).toBe('gte300s');
    expect(bucketExitInterval(296_400)).toBe('lt300s');
    expect(bucketExitInterval(70_000)).toBe('lt120s');
  });

  it('emptyExitIntervalHistogram zeroes exactly the declared buckets', () => {
    const h = emptyExitIntervalHistogram();
    expect(Object.keys(h).sort()).toEqual([...EXIT_INTERVAL_BUCKETS].sort());
    expect(Object.values(h).every((n) => n === 0)).toBe(true);
  });
});

describe('TRA-2269 — an interval belongs to the window BOTH its endpoints sat in (classifyExitInterval)', () => {
  it('grades an interval only when BOTH endpoints were inside RTH', () => {
    expect(classifyExitInterval(true, true)).toBe('rth');
  });

  it('EXCLUDES the pure closed-market interval — this is the contamination itself', () => {
    // The measured 2026-07-24 post-close state: doTick keeps stamping at ~30s
    // while the decoupled timer refuses on `marketClosed`, and 57% of those
    // intervals land AT OR ABOVE the 30s bar. ~21.7 min of them was enough to
    // force `p99Under30s` FALSE over a perfect 6.5h RTH.
    expect(classifyExitInterval(false, false)).toBe('closed');
  });

  it('EXCLUDES both boundary straddles — half of such an interval lived in a window the timer may not run in', () => {
    expect(classifyExitInterval(false, true)).toBe('boundary');  // the 09:30 open
    expect(classifyExitInterval(true, false)).toBe('boundary');  // the 16:00 close
  });

  it('the three bins PARTITION: every (prev, now) pair lands in exactly one, so nothing is dropped in silence', () => {
    const pairs: Array<[boolean | null, boolean]> = [
      [true, true], [true, false], [false, true], [false, false], [null, true], [null, false],
    ];
    const seen = pairs.map(([p, n]) => classifyExitInterval(p, n));
    expect(seen).toHaveLength(pairs.length);
    expect(seen.every((c) => c === 'rth' || c === 'boundary' || c === 'closed')).toBe(true);
    // Exactly one qualifying case out of the six. A filter that admitted more
    // than this would be readmitting the contamination it was written to remove.
    expect(seen.filter((c) => c === 'rth')).toHaveLength(1);
  });
});

describe('TRA-2269 — the WIRING: stampExitPass routes each interval to the right histogram', () => {
  // `classifyExitInterval` being correct proves nothing on its own — the number
  // the route publishes comes from which accumulator `stampExitPass` actually
  // increments. Drive the real method on a real engine over a real clock so the
  // predicate under test is the shipped `isStockMarketOpen`, not a stub of it.
  //
  // 2026-07-27 is a Monday. EDT = UTC-4, so 13:30Z-20:00Z is the RTH session.
  const RTH_A = Date.parse('2026-07-27T15:00:00Z');
  const CLOSED_A = Date.parse('2026-07-27T21:00:00Z');

  afterEach(() => { vi.useRealTimers(); });

  /** Stamp a pass at each instant, in order, and return the resulting readout. */
  function stampAt(instants: Array<{ at: number; source: 'tick' | 'decoupled' }>) {
    vi.useFakeTimers();
    const engine = new SignalEngine();
    const stamp = (engine as unknown as {
      stampExitPass: (s: 'tick' | 'decoupled') => void;
    }).stampExitPass.bind(engine);
    for (const s of instants) {
      vi.setSystemTime(new Date(s.at));
      stamp(s.source);
    }
    return engine.getExitCadenceHealth();
  }

  const total = (h: Record<string, number>) => Object.values(h).reduce((n, v) => n + v, 0);

  it('an interval between two RTH passes lands in the RTH histogram AND in the lifetime one', () => {
    const h = stampAt([
      { at: RTH_A, source: 'decoupled' },
      { at: RTH_A + 10_000, source: 'decoupled' },
    ]);
    expect(total(h.intervalHistogram)).toBe(1);
    expect(total(h.rth.intervalHistogram)).toBe(1);
    expect(h.rth.intervalHistogram.lt15s).toBe(1);
    expect(h.rth.decoupledPassCount).toBe(1);
    expect(h.rth.tickPassCount).toBe(0);
    expect(h.rth.boundaryIntervals).toBe(0);
    expect(h.rth.closedIntervals).toBe(0);
  });

  it('THE CONTAMINATION: an interval between two CLOSED-market passes reaches the lifetime histogram and NOT the graded one', () => {
    // This is the whole defect. Pre-TRA-2269 this 30s interval — doTick's
    // closed-market cadence, sitting dead on the bar — was counted in the
    // numerator of a ratio that is supposed to grade a 10s timer.
    const h = stampAt([
      { at: CLOSED_A, source: 'tick' },
      { at: CLOSED_A + 30_000, source: 'tick' },
    ]);
    expect(total(h.intervalHistogram)).toBe(1);
    expect(h.intervalHistogram.lt60s).toBe(1);          // AT the 30s bar
    expect(total(h.rth.intervalHistogram)).toBe(0);     // ...and graded by nothing
    expect(h.rth.closedIntervals).toBe(1);
    expect(h.rth.decoupledPassCount).toBe(0);
    expect(h.rth.tickPassCount).toBe(0);
  });

  it('an interval straddling the close is scored as a BOUNDARY, not silently dropped', () => {
    const h = stampAt([
      { at: Date.parse('2026-07-27T19:59:50Z'), source: 'decoupled' },  // inside RTH
      { at: Date.parse('2026-07-27T20:00:10Z'), source: 'tick' },       // after the close
    ]);
    expect(total(h.intervalHistogram)).toBe(1);
    expect(total(h.rth.intervalHistogram)).toBe(0);
    expect(h.rth.boundaryIntervals).toBe(1);
    expect(h.rth.closedIntervals).toBe(0);
  });

  it('a tick pass that closes an RTH interval is scored to rth.tickPassCount — that is what the purity gate reads', () => {
    const h = stampAt([
      { at: RTH_A, source: 'decoupled' },
      { at: RTH_A + 12_000, source: 'tick' },
    ]);
    expect(h.rth.tickPassCount).toBe(1);
    expect(h.rth.decoupledPassCount).toBe(0);
  });

  it('THE PUBLISHED INVARIANT HOLDS over a mixed session: lifetime === rth + boundary + closed', () => {
    // A full arc: closed pre-open -> the open boundary -> RTH -> the close
    // boundary -> closed. Seven passes, six intervals, and every one of them
    // must land in exactly one bin or the route\'s `partitionHolds` is a lie.
    const h = stampAt([
      { at: Date.parse('2026-07-27T13:00:00Z'), source: 'tick' },
      { at: Date.parse('2026-07-27T13:00:30Z'), source: 'tick' },       // closed
      { at: Date.parse('2026-07-27T13:30:05Z'), source: 'decoupled' },  // boundary (open)
      { at: Date.parse('2026-07-27T13:30:15Z'), source: 'decoupled' },  // rth
      { at: Date.parse('2026-07-27T13:30:25Z'), source: 'decoupled' },  // rth
      { at: Date.parse('2026-07-27T20:00:05Z'), source: 'tick' },       // boundary (close)
      { at: Date.parse('2026-07-27T20:00:35Z'), source: 'tick' },       // closed
    ]);
    const lifetime = total(h.intervalHistogram);
    expect(lifetime).toBe(6);
    expect(total(h.rth.intervalHistogram)).toBe(2);
    expect(h.rth.boundaryIntervals).toBe(2);
    expect(h.rth.closedIntervals).toBe(2);
    expect(lifetime).toBe(
      total(h.rth.intervalHistogram) + h.rth.boundaryIntervals + h.rth.closedIntervals,
    );
    // And the graded population excludes both 30s closed-market intervals that
    // the lifetime histogram is carrying.
    expect(h.intervalHistogram.lt60s).toBe(2);
    expect(h.rth.intervalHistogram.lt60s).toBe(0);
  });

  it('the FIRST pass creates no interval — there is no predecessor to measure against', () => {
    const h = stampAt([{ at: RTH_A, source: 'decoupled' }]);
    expect(total(h.intervalHistogram)).toBe(0);
    expect(total(h.rth.intervalHistogram)).toBe(0);
    expect(h.rth.boundaryIntervals).toBe(0);
    expect(h.rth.closedIntervals).toBe(0);
  });
});

/**
 * TRA-3800 — the TAPE inherited no window predicate when TRA-2269 partitioned the
 * histogram, so it kept warning on all three bins.
 *
 * Out of hours the decoupled hoist refuses on `marketClosed` BY DESIGN, leaving
 * doTick's ~30s cadence as the only thing stamping exits. Every one of those
 * intervals lands dead on 30s and clears a 20s threshold that was written as a
 * statement about a 10s timer — so the emitter fires on literally every pass, on
 * every engine, for every hour the market is shut.
 *
 * Measured on bqb1 2026-08-16 (a Sunday, market shut all day), commit `a6c3212`:
 *
 *   GET /api/health/exit-cadence  ->  67 engines, 28,291 intervals since boot
 *                                     rth.closedIntervals   28,291  (100.0%)
 *                                     rth.intervalHistogram      0
 *                                     rth.boundaryIntervals      0
 *   Render tape census, 10 min    ->  1,829 lines total, 134.0/min from THIS call
 *                                     site alone = 73.3% of the whole service tape
 *                                     (~193k lines/day), zero of them about RTH.
 *
 * Asserted against `process.stderr.write` rather than a logger mock on purpose:
 * the defect is BYTES ON THE PIPE. Node writes stderr synchronously to a pipe on
 * Linux — which is how Render captures container output — so when the collector
 * stalls, the 64 KiB buffer fills and the next write blocks the whole process
 * (TRA-3660). Spying one layer above the write would not measure the thing that
 * costs.
 */
describe('TRA-3800 — the exit-cadence tape carries the RTH population, not all three bins', () => {
  const RTH = Date.parse('2026-07-27T15:00:00Z');      // Monday, mid-session
  const CLOSED = Date.parse('2026-07-27T21:00:00Z');   // after the 16:00 ET close
  const OVER = 30_000;    // the observed closed-market cadence: clears the 20s bar
  const UNDER = 10_000;   // what the hoist produces in RTH: under the bar

  let written: string[];
  // Structural, not `ReturnType<typeof vi.spyOn>`: `process.stderr.write` is an
  // overloaded signature and vitest's spy generic will not accept the key. All
  // this block needs off the handle is the restore.
  let spy: { mockRestore(): void };

  beforeEach(() => {
    written = [];
    spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });
  afterEach(() => { spy.mockRestore(); vi.useRealTimers(); });

  /** Lines this call site actually put on the pipe. */
  const tapeLines = () =>
    written.filter((l) => l.includes('exit evaluation interval exceeded the log threshold'));

  const total = (h: Record<string, number>) => Object.values(h).reduce((n, v) => n + v, 0);

  function stampAt(instants: Array<{ at: number; source: 'tick' | 'decoupled' }>) {
    vi.useFakeTimers();
    const engine = new SignalEngine();
    const stamp = (engine as unknown as {
      stampExitPass: (s: 'tick' | 'decoupled') => void;
    }).stampExitPass.bind(engine);
    for (const s of instants) {
      vi.setSystemTime(new Date(s.at));
      stamp(s.source);
    }
    return engine.getExitCadenceHealth();
  }

  it('POSITIVE CONTROL — an over-threshold RTH interval still reaches the tape', () => {
    // Without this the suppression tests below are unfalsifiable: a spy that
    // captures nothing would pass every one of them.
    const h = stampAt([
      { at: RTH, source: 'tick' },
      { at: RTH + OVER, source: 'tick' },
    ]);
    expect(tapeLines()).toHaveLength(1);
    expect(tapeLines()[0]).toContain('"component":"exit-cadence"');
    expect(tapeLines()[0]).toContain('"intervalMs":30000');
    expect(h.exitIntervalLogSuppressed).toBe(0);
    expect(total(h.rth.intervalHistogram)).toBe(1);
  });

  it('THE FIX — an over-threshold CLOSED-market interval is COUNTED and not written', () => {
    // Remove the `region === \'rth\'` conjunct and this is the line that comes back.
    const h = stampAt([
      { at: CLOSED, source: 'tick' },
      { at: CLOSED + OVER, source: 'tick' },
    ]);
    expect(tapeLines()).toHaveLength(0);
    expect(h.exitIntervalLogSuppressed).toBe(1);
    expect(h.rth.closedIntervals).toBe(1);
  });

  it('a BOUNDARY straddle is suppressed too — half of it lived in a window the timer may not run in', () => {
    const h = stampAt([
      { at: Date.parse('2026-07-27T19:59:50Z'), source: 'decoupled' },  // inside RTH
      { at: Date.parse('2026-07-27T20:00:35Z'), source: 'tick' },       // after the close
    ]);
    expect(tapeLines()).toHaveLength(0);
    expect(h.exitIntervalLogSuppressed).toBe(1);
    expect(h.rth.boundaryIntervals).toBe(1);
  });

  it('the counter counts suppression BY WINDOW, not by threshold — an under-bar RTH interval increments neither', () => {
    // Otherwise `exitIntervalLogSuppressed` would climb through a healthy RTH
    // session and stop being readable as "closed-market intervals withheld".
    const h = stampAt([
      { at: RTH, source: 'decoupled' },
      { at: RTH + UNDER, source: 'decoupled' },
    ]);
    expect(tapeLines()).toHaveLength(0);
    expect(h.exitIntervalLogSuppressed).toBe(0);
    expect(total(h.rth.intervalHistogram)).toBe(1);
  });

  it('THE INCIDENT, TO SCALE: an hour of closed-market ticks writes NOTHING and accounts for all 120', () => {
    // 120 x 30s = the exact shape one engine produced on the 2026-08-16 tape.
    // Pre-fix this was 120 lines from one engine; bqb1 runs 67 of them.
    const passes = Array.from({ length: 121 }, (_, i) => ({
      at: CLOSED + i * OVER, source: 'tick' as const,
    }));
    const h = stampAt(passes);
    expect(tapeLines()).toHaveLength(0);
    expect(h.rth.closedIntervals).toBe(120);
    // Every withheld interval is accounted for. A gate whose refusals are
    // anonymous is a gate you cannot grade from outside the box — and after this
    // ships, silence on the tape is ALSO what "exit stamping died" looks like.
    expect(h.exitIntervalLogSuppressed).toBe(120);
  });

  it('a session that opens keeps reporting: closed pre-open is withheld, RTH is written, and the two reconcile', () => {
    const h = stampAt([
      { at: Date.parse('2026-07-27T13:00:00Z'), source: 'tick' },       // -
      { at: Date.parse('2026-07-27T13:00:30Z'), source: 'tick' },       // closed, over
      { at: Date.parse('2026-07-27T13:01:00Z'), source: 'tick' },       // closed, over
      { at: Date.parse('2026-07-27T13:30:05Z'), source: 'decoupled' },  // boundary, over
      { at: Date.parse('2026-07-27T13:30:40Z'), source: 'tick' },       // RTH, over  <- written
      { at: Date.parse('2026-07-27T13:30:50Z'), source: 'decoupled' },  // RTH, under
    ]);
    expect(tapeLines()).toHaveLength(1);
    expect(tapeLines()[0]).toContain('"source":"tick"');
    expect(h.exitIntervalLogSuppressed).toBe(3);   // 2 closed + 1 boundary
    expect(h.rth.closedIntervals).toBe(2);
    expect(h.rth.boundaryIntervals).toBe(1);
    expect(total(h.rth.intervalHistogram)).toBe(2);
  });
});

/**
 * TRA-2610 — the PRODUCER half of the fix, tested where the erasure happened.
 *
 * `applyQuotes` has two loops. The first stamps quoted symbols; the second stamps
 * `'unavailable'` on every symbol that failed to quote, CARRYING THE PREVIOUS TICK'S
 * price / change / changePct FORWARD. While plausibility and freshness shared one
 * `quoteStatus` field, that second loop destroyed the `'suspect'` verdict while
 * republishing the fabricated numbers that earned it — so the guard was least
 * reliable on exactly the thin, sporadically-quoted names it existed to catch.
 *
 * FGMC on the live 2026-07-29 tape: `price 8.30`, `changePct +110.66`
 * (`implausible_move_ratio`, ratio 2.107 vs a threshold of 2), last successful fetch
 * 6,241 s earlier. Flagged on the tick it printed, demoted on the next, and #1 in the
 * shipped EOD report.
 */
describe('SignalEngine — a suspect move survives a failed fetch (TRA-2610)', () => {
  type QuoteRow = { price: number; volume: number; change: number; changePct: number };
  const quotes = (rows: Record<string, QuoteRow>) => new Map(Object.entries(rows));
  // `applyQuotes` is private; this is a deliberate white-box call, because the defect
  // IS the interaction between its two loops and nothing public exposes that seam.
  const applyQuotes = (engine: SignalEngine, q: Map<string, QuoteRow>, active: string[]) =>
    (engine as unknown as { applyQuotes(qq: unknown, a: string[]): Map<string, number> })
      .applyQuotes(q, active);
  const rowFor = (engine: SignalEngine, symbol: string) =>
    engine.getState().symbols.find(s => s.symbol === symbol);

  // `change` derived from the published price/changePct (implied prev close 3.94)
  // so the fixture reproduces the live ratio of 2.107, not a nearby invented one.
  const FGMC_QUOTE = { price: 8.30, volume: 12_000, change: 4.36, changePct: 110.66 };
  const AAPL_QUOTE = { price: 338.11, volume: 40_000_000, change: 5.71, changePct: 1.72 };

  it('stamps the verdict on moveSuspect, NOT on quoteStatus', () => {
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ FGMC: FGMC_QUOTE }), ['FGMC']);
    const row = rowFor(engine, 'FGMC');
    expect(row?.moveSuspect).toBe(true);
    // Freshness is a separate fact and this quote SUCCEEDED, so it is 'ok'. The old
    // code wrote 'suspect' here, which is what made the two facts collide.
    expect(row?.quoteStatus).toBe('ok');
  });

  it('KEEPS moveSuspect when the next fetch fails and re-stamps unavailable', () => {
    // The regression. Tick 1 quotes FGMC; tick 2 fails to and carries its numbers
    // forward. Pre-fix, the row came out of tick 2 as `quoteStatus:'unavailable'`
    // with no surviving trace of the verdict.
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ FGMC: FGMC_QUOTE }), ['FGMC']);
    applyQuotes(engine, quotes({}), ['FGMC']);

    const row = rowFor(engine, 'FGMC');
    expect(row?.quoteStatus).toBe('unavailable');
    expect(row?.moveSuspect).toBe(true);
    // …and it is still republishing the fabricated numbers, which is why the verdict
    // has to survive rather than the row being quietly dropped (flag, never clamp).
    expect(row?.changePct).toBe(110.66);
    expect(row?.price).toBe(8.30);
  });

  it('KNOWN-GOOD control: a believable row that goes unavailable is NOT flagged', () => {
    // Without this, "moveSuspect is true after a failed fetch" would also pass if the
    // second loop stamped every stale row suspect — which would exclude 42% of the
    // universe from the movers table on the tape this ticket was found on.
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ AAPL: AAPL_QUOTE }), ['AAPL']);
    expect(rowFor(engine, 'AAPL')?.moveSuspect).toBe(false);
    applyQuotes(engine, quotes({}), ['AAPL']);
    const row = rowFor(engine, 'AAPL');
    expect(row?.quoteStatus).toBe('unavailable');
    expect(row?.moveSuspect).toBe(false);
  });

  it('clears the flag when a later quote is believable again', () => {
    // A corporate-action artefact resolves once the provider adjusts its prev close.
    // The verdict must not latch, or the row is condemned for the rest of the session.
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ FGMC: FGMC_QUOTE }), ['FGMC']);
    applyQuotes(engine, quotes({ FGMC: { price: 8.30, volume: 12_000, change: 0.12, changePct: 1.47 } }), ['FGMC']);
    const row = rowFor(engine, 'FGMC');
    expect(row?.moveSuspect).toBe(false);
    expect(row?.quoteStatus).toBe('ok');
  });

  it('flags a never-quoted symbol as neither suspect nor believable-by-omission', () => {
    // A symbol with no prior state carries zeros; `price <= 0` is not the
    // plausibility rule's jurisdiction (the no-quote statuses own it).
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({}), ['NEVR']);
    const row = rowFor(engine, 'NEVR');
    expect(row?.quoteStatus).toBe('unavailable');
    expect(row?.moveSuspect).toBe(false);
    expect(row?.lastUpdated).toBe(0);
  });
});

// ─── TRA-4424 — THE DAILY-BAR SOURCE, GRADED BEHAVIOURALLY ───────────────────
// Parent TRA-4421, filed off TRA-4422 Finding 1.
//
// ⛔ WHY THIS IS A BEHAVIOURAL SUITE AND NOT A SOURCE CENSUS. The defect it
// closes is a WRONG-TIMEFRAME series that RUNS: 480 five-minute bars clear every
// `length >= N` guard in `evaluateSetupTaxonomy`, produce confident verdicts and
// populate the reason-code histogram TRA-4422 shipped, while measuring an
// intraday range and reporting it as swing structure. A source grep asserting
// "the seam mentions the daily reader" survives a seam that reads BOTH caches
// and scores the wrong one — so the load-bearing case below seeds a DEEP
// 5-minute cache, leaves the daily cache cold, and demands `series_unreadable`.
// Under the TRA-4422 wiring that case scores `no_setup_matched` off 480 bars.
describe('TRA-4424 — the OTM setup seam reads a DAILY series, off the order path', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const FIVE_MIN_MS = 5 * 60 * 1000;

  /** `n` bars spaced `stepMs` apart, ending at `TRADING_TIME`. */
  function bars(n: number, stepMs: number, symbol = 'AAPL'): Candle[] {
    return Array.from({ length: n }, (_, i) => ({
      symbol,
      timestamp: TRADING_TIME - (n - 1 - i) * stepMs,
      open: 100, high: 101, low: 99, close: 100.5, volume: 1_000,
    }));
  }

  const runOtm = (engine: SignalEngine, syms: string[]) =>
    (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(syms);
  const refreshDaily = (engine: SignalEngine, syms: string[]) =>
    (engine as unknown as { refreshOtmDailySeries: (s: string[]) => Promise<SweepPass> })
      .refreshOtmDailySeries(syms);

  function otmEngine(): SignalEngine {
    const scanner = new StubScanner();
    scanner.scanOtm.mockResolvedValue({
      symbol: 'AAPL', spot: 195, expiration: '2024-07-05',
      candidates: [makeOtmCandidate()], reason: 'ok',
    });
    return new SignalEngine(undefined, undefined, scanner);
  }

  /** The verdict the seam actually recorded, newest last. */
  function lastVerdict() {
    const recent = otmDailySeriesHealth().verdicts.recent;
    return recent[recent.length - 1] ?? null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME);
    __resetOtmDailySeriesForTests(TRADING_TIME);
    resetSweepCursors();
    vi.mocked(fetchDailyCandles).mockReset();
    vi.mocked(fetchDailyCandles).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetOtmDailySeriesForTests();
  });

  // ⛔ THE LOAD-BEARING CASE. A deep 5-minute cache is present and the daily
  // cache is cold. Under TRA-4422's wiring the seam read the 5-minute cache and
  // this scored `no_setup_matched` off 480 bars spanning ~1.7 days — the sleeve
  // would then soak a "directional gate" that was answering an intraday
  // question confidently. It must read `series_unreadable`, with NO span.
  it('a DEEP 5-minute cache does NOT satisfy the seam — the daily cache is cold, so the verdict is `series_unreadable`', async () => {
    const engine = otmEngine();
    // 480 five-minute bars = the exact depth `SUPERTREND_SHADOW_MINUTE_BARS`
    // (2400 one-minute bars, ~6.15 trading days) resamples to.
    (engine as unknown as { shadowCandleCache: Map<string, Candle[]> })
      .shadowCandleCache.set('AAPL', bars(480, FIVE_MIN_MS));

    await runOtm(engine, ['AAPL']);

    const v = lastVerdict();
    expect(v).not.toBeNull();
    expect(v!.symbol).toBe('AAPL');
    expect(v!.readState).toBe('absent');
    expect(v!.reasonCode).toBe('series_unreadable');
    expect(v!.bars).toBe(0);
    // ⛔ SPAN ABSENT, not merely small. TRA-4424's acceptance names this: a cold
    // daily source must land in the runtime-defect bucket carrying no span at
    // all, never a confident negative carrying an intraday one.
    expect(v!.seriesSpanMs).toBeNull();
    // …and the read is COUNTED as absent, distinctly from stale.
    const c = otmDailySeriesHealth().counters;
    expect(c.readsAbsent).toBe(1);
    expect(c.readsStale).toBe(0);
    expect(c.readsFresh).toBe(0);
  });

  // POSITIVE CONTROL at the same level: change ONLY the daily cache. Same engine
  // shape, same candidate, same clock.
  it('with the daily cache warm the SAME scan publishes a MULTI-DAY span', async () => {
    vi.mocked(fetchDailyCandles).mockResolvedValue(bars(120, DAY_MS));
    const engine = otmEngine();
    const pass = await refreshDaily(engine, ['AAPL']);
    expect(pass.complete).toBe(true);
    expect(vi.mocked(fetchDailyCandles)).toHaveBeenCalledWith('AAPL', 120);

    await runOtm(engine, ['AAPL']);

    const v = lastVerdict()!;
    expect(v.readState).toBe('fresh');
    expect(v.bars).toBe(120);
    // ⛔ THE ACCEPTANCE CRITERION. 60 five-minute bars and 60 daily bars are the
    // same bar COUNT and a different question, so "the seam reads daily bars" is
    // only checkable as a measured SPAN. 119 steps × 1 day.
    expect(v.seriesSpanMs).toBe(119 * DAY_MS);
    expect(v.seriesSpanMs!).toBeGreaterThan(20 * DAY_MS);
    // The registry is still EMPTY (arming is board card `70e36987`), so the
    // verdict is `no_setup_matched` at `setupsScored: 0` — UNMEASURED per row,
    // never "the taxonomy looked and found nothing".
    expect(v.reasonCode).toBe('no_setup_matched');
    expect(v.confirmed).toBe(false);
    // ⛔ Graded at the SWING-HORIZON bar (30 days), not a one-day one: the
    // 5-minute series this replaced spans ~8.6 calendar days and would clear
    // "multi-day" on the broken build too.
    const hv = otmDailySeriesHealth().verdicts;
    expect(hv.allReadableSpansSwingHorizon).toBe(true);
    expect(hv.readable).toBe(1);
    expect(hv.unreadable).toBe(0);
  });

  // ⛔ NEGATIVE CONTROL #2 — STALE, a different fact from ABSENT that must not
  // pool with it. A series the refresh fetched and then stopped maintaining is
  // exactly what a dead feed leaves behind.
  it('a STALE daily cache is `series_unreadable` with the span ABSENT, and counts separately from absent', async () => {
    vi.mocked(fetchDailyCandles).mockResolvedValue(bars(120, DAY_MS));
    const engine = otmEngine();
    await refreshDaily(engine, ['AAPL']);

    // Past the 4h bound. Nothing else changes — the bars are still there.
    vi.setSystemTime(TRADING_TIME + OTM_DAILY_SERIES_MAX_AGE_MS + 60_000);
    await runOtm(engine, ['AAPL']);

    const v = lastVerdict()!;
    expect(v.readState).toBe('stale');
    expect(v.reasonCode).toBe('series_unreadable');
    expect(v.bars).toBe(0);
    expect(v.seriesSpanMs).toBeNull();
    const c = otmDailySeriesHealth().counters;
    expect(c.readsStale).toBe(1);
    expect(c.readsAbsent).toBe(0);
  });

  // ⛔ THE FAILURE MUST BE COUNTABLE. A daily fetch that starts failing degrades
  // into "every nominee is unreadable", which is indistinguishable from a quiet
  // market on every other number this sleeve publishes.
  it('a failing daily fetch is COUNTED, and `status` separates it from a quiet market', async () => {
    vi.mocked(fetchDailyCandles).mockRejectedValue(new Error('yahoo 502'));
    const engine = otmEngine();
    const pass = await refreshDaily(engine, ['AAPL', 'MSFT']);
    // The tick survives — a cold feed cannot take the sweep down…
    expect(pass.complete).toBe(true);

    // …and it is not silent about it.
    const h = otmDailySeriesHealth();
    expect(h.counters.fetchFailed).toBe(2);
    expect(h.counters.fetchOk).toBe(0);
    expect(h.counters.consecutiveFetchFailures).toBe(2);
    expect(h.counters.lastFailureReason).toContain('yahoo 502');
    expect(h.status).toBe('failing');
    expect(h.note).toContain('FAILING');

    // The scan still runs; the nominee is unreadable, and now the operator can
    // tell WHY without going to the log tape.
    await runOtm(engine, ['AAPL']);
    expect(lastVerdict()!.reasonCode).toBe('series_unreadable');
  });

  // ⛔ AND THE COUNTER MUST NOT ITSELF READ AS HEALTHY WHEN IT NEVER RAN. Every
  // total is zero on a box where the refresh was never wired in, byte-identical
  // to one where it ran and nothing failed.
  it('a refresh that never ran reads `unmeasured`, NOT `ok`', () => {
    expect(otmDailySeriesHealth().status).toBe('unmeasured');
    expect(otmDailySeriesHealth().note).toContain('UNMEASURED');
    // …and an empty verdict window is null, never a measured `false`.
    expect(otmDailySeriesHealth().verdicts.allReadableSpansSwingHorizon).toBeNull();
  });

  // The refresh is a separate pass from the scan. If the SEAM ever fetched, a
  // feed stall would become an entry stall on a live order path.
  //
  // ⚠️ MEASURED, NOT ASSUMED: `runOtmScan` DOES reach `fetchDailyCandles` — once
  // per OPEN, at `OTM_DAILY_ATR_BARS = 40`, from `stampOtmAtrInvalidation`
  // (TRA-3943). That call is POST-FILL and pre-dates this item; it is not the
  // seam. So the assertion is not "the scan never fetches" (false, and a test
  // written to that belief would have been a lie the first time it ran) but
  // "no fetch happens BEFORE the taxonomy scores" — which is the property that
  // actually keeps latency off the nomination path.
  it('the SEAM never fetches — the nominee is scored before any daily call the scan makes', async () => {
    vi.mocked(fetchDailyCandles).mockResolvedValue(bars(40, DAY_MS));
    const engine = otmEngine();
    // No nomination has been scored yet, so any fetch counted here would be one
    // the seam itself made.
    await runOtm(engine, ['AAPL']);

    const calls = vi.mocked(fetchDailyCandles).mock.calls;
    // The only daily call on this path is TRA-3943's post-fill ATR pull, at its
    // own depth — never `OTM_DAILY_SERIES_BARS`.
    expect(calls.every(([, n]) => n === 40)).toBe(true);
    // ⛔ AND THE VERDICT WAS COMPUTED OFF THE COLD CACHE. If the seam had
    // fetched, this would read the 40 bars it just pulled instead.
    expect(lastVerdict()!.readState).toBe('absent');
    expect(lastVerdict()!.reasonCode).toBe('series_unreadable');
    expect(lastVerdict()!.bars).toBe(0);
  });

  // ⛔ THE FEED BREAKER IS ITS OWN BUCKET. `fetchDailyCandles` short-circuits to
  // `[]` while Yahoo is rate-limited, so a tripped breaker would otherwise land
  // in `fetchEmpty` and leave `status: 'ok'` while every nominee scored
  // `series_unreadable`.
  it('a tripped feed breaker is SKIPPED and counted, not laundered into `fetchEmpty`', async () => {
    vi.mocked(isYahooBreakerOpen).mockReturnValue(true);
    try {
      const engine = otmEngine();
      const pass = await refreshDaily(engine, ['AAPL', 'MSFT']);
      expect(vi.mocked(fetchDailyCandles)).not.toHaveBeenCalled();
      const h = otmDailySeriesHealth();
      expect(h.counters.skippedFeedBreaker).toBe(2);
      expect(h.counters.fetchEmpty).toBe(0);
      expect(h.counters.fetchFailed).toBe(0);
      expect(h.status).not.toBe('ok');
      // ⛔ AND THE ROTATION DID NOT COMPLETE. Live tape 2026-09-10: a rotation
      // that began under an open breaker "completed" in 0 ms having fetched
      // nothing, and spent its 30-minute slot — no daily fetch landed for an hour.
      expect(pass.complete).toBe(false);
      expect(pass.stopped).toBe(true);
    } finally {
      vi.mocked(isYahooBreakerOpen).mockReturnValue(false);
    }
  });

  it('⛔ the breaker closing RESUMES the rotation on the next pass — it is not deferred a cadence slot', async () => {
    vi.mocked(fetchDailyCandles).mockResolvedValue(bars(120, DAY_MS));
    vi.mocked(isYahooBreakerOpen).mockReturnValue(true);
    const engine = otmEngine();
    try {
      await refreshDaily(engine, ['AAPL', 'MSFT']);
    } finally {
      vi.mocked(isYahooBreakerOpen).mockReturnValue(false);
    }
    const pass = await refreshDaily(engine, ['AAPL', 'MSFT']);
    expect(pass.complete).toBe(true);
    expect(vi.mocked(fetchDailyCandles)).toHaveBeenCalledTimes(2);
    await runOtm(engine, ['AAPL']);
    expect(lastVerdict()!.readState).toBe('fresh');
  });

  // ⛔ THE 09-10 THRASH. One engine per USER shares this cache; the first cut
  // pruned it to the calling engine's universe at the end of every rotation, so
  // each book evicted every other book's symbols (`evicted` 218,
  // `cachedSymbols` 25, 49 of the last 50 seam reads `absent`).
  it('⛔ one book\'s completed rotation does NOT evict another book\'s symbols', async () => {
    vi.mocked(fetchDailyCandles).mockImplementation(async (sym: string) => bars(120, DAY_MS, sym));
    const alice = otmEngine();
    alice.setAlertUsername('alice');
    const bob = otmEngine();
    bob.setAlertUsername('bob');
    expect((await refreshDaily(alice, ['AAPL'])).complete).toBe(true);
    expect((await refreshDaily(bob, ['MSFT'])).complete).toBe(true);

    await runOtm(alice, ['AAPL']);
    expect(lastVerdict()!.symbol).toBe('AAPL');
    expect(lastVerdict()!.readState).toBe('fresh');
    expect(otmDailySeriesHealth().counters.evicted).toBe(0);
  });

  it('the rotation cursor is keyed per BOOK, not per mode', async () => {
    vi.mocked(isYahooBreakerOpen).mockReturnValue(true);
    try {
      const engine = otmEngine();
      engine.setAlertUsername('alice');
      await refreshDaily(engine, ['AAPL', 'MSFT']); // parks the cursor
      const keys = Object.keys(sweepCursorSnapshot()).filter((k) => k.endsWith('otm-daily-series'));
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/:alice:otm-daily-series$/);
    } finally {
      vi.mocked(isYahooBreakerOpen).mockReturnValue(false);
    }
  });
});

// ── TRA-4649 — trade-opportunity-card wiring at the feed sink ────────────────
//
// The builder's own behavior (all 8 fields, fail-closed inputs, shipped cost /
// sizing arithmetic) is covered in trade-opportunity-card.test.ts. These tests
// cover the WIRING: every TradeSignal published through the engine's one feed
// sink produces a card readable (with the acceptance fold) off
// `getRecentCards`, SMA-200 display rows do not, and a broken/unregistered
// signal surfaces as a loud fold row — never a missing card, never a throw out
// of the sink.
describe('TRA-4649 — trade opportunity cards ride the signal feed sink', () => {
  function pushInto(engine: SignalEngine, signal: unknown): void {
    (engine as unknown as { pushRecentSignal: (s: unknown) => void }).pushRecentSignal(signal);
  }

  function freshEquitySignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
    return {
      id: 'tra4649-eq-1',
      symbol: 'MSFT',
      type: 'momentum',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 115,
      riskRewardRatio: 3,
      timestamp: Date.now() - 60_000,
      mode: 'demo',
      ...overrides,
    } as TradeSignal;
  }

  it('an OTM scan publish also builds a card: linked by signalId, proposal-only, confidence null', async () => {
    const scanner = new StubScanner();
    scanner.scanOtm.mockResolvedValue({
      symbol: 'AAPL',
      spot: 195,
      expiration: '2024-07-05',
      candidates: [makeOtmCandidate()],
      reason: 'ok',
    });
    const engine = new SignalEngine(undefined, undefined, scanner);
    await (engine as unknown as { runOtmScan: (s: string[]) => Promise<void> }).runOtmScan(['AAPL']);

    const signals = engine.getState().signals;
    expect(signals).toHaveLength(1);
    const { cards, summary, buildFailures } = engine.getRecentCards();
    expect(buildFailures).toBe(0);
    expect(cards).toHaveLength(1);
    expect(summary.total).toBe(1);
    expect(cards[0].signalId).toBe(signals[0].id);
    expect(cards[0].disposition).toBe('proposal_only');
    // otm_mispricing is a registered setup, and the candidate carries a
    // two-sided option quote — both halves survive the trip through the sink.
    expect(cards[0].fields.setup.status).toBe('verified');
    expect(cards[0].fields.contract.status).toBe('verified');
    // No calibration index is wired at the sink (the TRA-4652 ≥30 floor is
    // unfillable on today's data by design) — null, never an invented number.
    expect(cards[0].confidence).toBeNull();
  });

  it('an equity signal cards COMPLETE off engine-owned context (account sizing + seeded L1 quote)', () => {
    const engine = new SignalEngine();
    (engine as unknown as { symbolState: Map<string, unknown> }).symbolState.set('MSFT', {
      symbol: 'MSFT',
      price: 100,
      volume: 1_000,
      change: 0,
      changePct: 0,
      lastUpdated: Date.now(),
      bid: 99.98,
      ask: 100.02,
    });
    pushInto(engine, freshEquitySignal());

    const { cards, summary, buildFailures } = engine.getRecentCards();
    expect(buildFailures).toBe(0);
    expect(cards).toHaveLength(1);
    expect(cards[0].complete).toBe(true);
    expect(cards[0].incompleteFields).toEqual([]);
    expect(summary).toEqual({ total: 1, complete: 1, incomplete: 0, missingByField: {} });
    // The sizing basis is the account's own numbers, not literals: the card's
    // share count must equal what the account itself would size for this stop.
    const acct = (engine as unknown as { account: PaperAccount }).account;
    expect(cards[0].fields.sizing.data?.quantity).toBe(acct.sizeFromStop(100, 95));
  });

  it('without an L1 book the contract/costs fields fail closed — a missing feed is not a wide book', () => {
    const engine = new SignalEngine();
    pushInto(engine, freshEquitySignal({ id: 'tra4649-eq-noquote' }));

    const { cards, summary } = engine.getRecentCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].complete).toBe(false);
    expect(cards[0].fields.contract.status).toBe('incomplete');
    expect(cards[0].fields.costs.status).toBe('incomplete');
    expect(summary.missingByField['contract']).toBe(1);
    expect(summary.missingByField['costs']).toBe(1);
  });

  it('SMA-200 display rows are published but never carded — the fold denominator is TradeSignals only', () => {
    const engine = new SignalEngine();
    pushInto(engine, {
      id: 'tra4649-sma-1',
      symbol: 'AAPL',
      type: 'sma200_pullback',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: null,
      riskRewardRatio: null,
      timestamp: Date.now(),
      mode: 'demo',
    });

    expect(engine.getState().signals).toHaveLength(1);
    const { cards, summary, buildFailures } = engine.getRecentCards();
    expect(buildFailures).toBe(0);
    expect(cards).toHaveLength(0);
    expect(summary.total).toBe(0);
  });

  it('an unregistered signal type still cards, loud in the fold — never a missing card, never a sink throw', () => {
    const engine = new SignalEngine();
    pushInto(engine, freshEquitySignal({ id: 'tra4649-unreg', type: 'never_heard_of_it' as TradeSignal['type'] }));

    expect(engine.getState().signals).toHaveLength(1); // the publish itself survived
    const { cards, summary, buildFailures } = engine.getRecentCards();
    expect(buildFailures).toBe(0); // fail-closed is a field verdict, not a throw
    expect(cards).toHaveLength(1);
    expect(cards[0].complete).toBe(false);
    expect(summary.missingByField['setup']).toBe(1);
  });

  it('clearSignals clears the card ring with the feed — no stale proposals outlive a cleared feed', () => {
    const engine = new SignalEngine();
    pushInto(engine, freshEquitySignal());
    expect(engine.getRecentCards().summary.total).toBe(1);
    engine.clearSignals();
    expect(engine.getRecentCards().summary.total).toBe(0);
    expect(engine.getState().signals).toHaveLength(0);
  });
});
