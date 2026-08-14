// TRA-528 — health route registrar + stale-state monitor tests.
//
// Exercises the HTTP surface with a fake express app and fake user contexts so
// the wiring is verified without booting the real server.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import {
  makeHypothesis,
  runHypothesis,
  setHypothesisQueueFileForTests,
} from '../hypothesis-pipeline.js';
import {
  registerLiveHealthRoutes,
  runStaleStateCheck,
  aggregateLiveEquityAcceptance,
  summarizeDemoBook,
  summarizeDemoBooks,
  summarizeDemoBooksPublic,
  summarizeSma200ForwardTestFills,
  summarizeOptionsPipeline,
  buildOptionJournalReport,
  // TRA-3380 — the cohort-param parser + the epoch-ms floor that separates a
  // millisecond instant from an epoch-SECONDS value that used to select the pool.
  parseCohortTsParam,
  rollUpExitCadence,
  RTH_DECOUPLED_SHARE_FLOOR,
  durabilityNote, // TRA-3011
  type HealthUserContext,
  type ExitCadenceRollup,
} from './health-routes.js';
import { TEST_ACCOUNT_PREFIX_ENV } from '../test-accounts.js'; // TRA-2478
// TRA-3216 — the live OTM underlying allowlist + the enforcement-gate ledger it publishes through.
import { OPTION_LIVE_OTM_UNIVERSE_VAR } from '../otm-live-universe-flag.js';
import { clearLiveEnforceGateLedger, recordLiveEnforceDecision } from '../live-enforce-gate-ledger.js';
import type { OptionTradeJournalRecord, OptionTradeJournalOpen } from '../option-trade-journal.js';
import {
  OPTION_TRADE_JOURNAL_FLAG,
  recordOptionTradeOpen,
  setOptionTradeJournalFileForTests,
} from '../option-trade-journal.js';
import {
  clearChurnBrakeLedger,
  recordChurnBrakeOpen,
  recordChurnBrakeOpenRejected,
  recordChurnBrakeDcaHalt,
} from '../churn-brake-ledger.js';
import { clearCostAwareGateLedger, recordCostAwareGateDecision } from '../cost-aware-gate-ledger.js';
import { SCALEOUT_LADDER_FLAG } from '../scaleout-ladder-flag.js';
import {
  clearScaleoutLadderLedger,
  runScaleoutLadderObservePass,
} from '../scaleout-ladder-ledger.js';
import { clearEntryGreeksLedger, recordEntryGreeksVerdict } from '../entry-greeks-ledger.js';
import {
  clearGiveBackArmFloorLedger,
  recordGiveBackState,
} from '../giveback-arm-floor-ledger.js'; // TRA-2220
import {
  beginEquityEntryPass,
  recordEquityEntryPassGated,
  recordEquityCandidate,
  recordEquityEntryRejected,
  recordEquitySymbolEvaluated,
  recordEquitySymbolSkipped,
  __resetEquityEntryFunnelForTests,
  type EquityEntryFunnelBlock,
} from '../equity-entry-funnel.js';
import { beginRvScan, __resetRvScanTelemetry } from '../rv-scan-telemetry.js'; // TRA-2193
import { recordDirectionalArm, clearDirectionalOpenLedger } from '../directional-open-ledger.js'; // TRA-3080
import { etDateString } from '../scheduler.js';
import { checkStaleState } from './alerts.js';
import { // TRA-3394
  OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG,
  OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG,
  OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR,
} from '../option-entry-delta-ceiling-live.js';
import { getRecentAlerts, __resetAlertsForTest } from './alerts.js';
import type { EngineState, ExitCadenceHealth, ExitIntervalBucket, LiveEquityAcceptance } from '../signal-engine.js';
import { categorizeLiveSkipReason, emptyLiveSkipBreakdown, emptyDecoupledExitSkips, emptyExitIntervalHistogram } from '../signal-engine.js';
import type { AccountSettings } from '@trading-app/shared';

const NOW = 2_000_000_000;
const FRESH = NOW - 30_000;
const STALE = NOW - 10 * 60_000;

/** Minimal EngineState for the bits health code reads. */
function engineState(over: Partial<EngineState> = {}): EngineState {
  return {
    symbols: [{ symbol: 'AAPL', price: 1, volume: 1, change: 0, changePct: 0, lastUpdated: FRESH }],
    signals: [],
    lastTick: FRESH,
    tradingHalted: false,
    haltReason: null,
    autoTradingEnabled: true,
    marketOpen: true,
    ...over,
  } as unknown as EngineState;
}

function ctx(username: string, state: EngineState): HealthUserContext {
  return { username, engine: { getState: () => state } };
}

function settings(over: Partial<AccountSettings> = {}): AccountSettings {
  return { mode: 'demo', liveTradierEnvOptions: 'sandbox', ...over } as unknown as AccountSettings;
}

type FakeHandler = (req: unknown, res: unknown, next?: () => void) => unknown;

/** Capture routes registered on a fake express app. */
function fakeApp() {
  const routes = new Map<string, FakeHandler[]>();
  const postRoutes = new Map<string, FakeHandler[]>();
  const app = {
    get(path: string, ...handlers: FakeHandler[]) {
      routes.set(path, handlers);
    },
    post(path: string, ...handlers: FakeHandler[]) {
      postRoutes.set(path, handlers);
    },
  };
  return { app: app as never, routes, postRoutes };
}

function fakeRes() {
  const res: {
    statusCode: number;
    body: unknown;
    headersSent: boolean;
    json: (b: unknown) => void;
    status: (code: number) => typeof res;
  } = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    json(b: unknown) {
      this.body = b;
      this.headersSent = true;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return res;
}

/** Like fakeRes but with a `locals` bag, as express provides to handlers. */
function resWithLocals() {
  const res = fakeRes() as ReturnType<typeof fakeRes> & { locals: Record<string, unknown> };
  res.locals = {};
  return res;
}

describe('registerLiveHealthRoutes', () => {
  it('serves build info on GET /api/health/version (no auth handler)', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/version')!;
    expect(handlers).toHaveLength(1); // version is unauthenticated
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as { commitSource: string; uptimeSec: number };
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('commitSource');
    expect(typeof body.uptimeSec).toBe('number');
  });

  // TRA-2209 — the env-drift route must be mounted UNCONDITIONALLY and UNGATED.
  // bqb1's admin auth is dead (401), so an auth-gated drift check would be exactly
  // as unreachable as the wipe it exists to catch, and an optionally-mounted one
  // would 404 on precisely the box that needs it. Both are asserted here.
  it('serves env drift on GET /api/health/env-drift (no auth handler, always mounted)', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never, // would BLOCK if the route were gated
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
      // no `effectiveEnv` dep — the route must still mount and fall back
    });

    const handlers = routes.get('/api/health/env-drift')!;
    expect(handlers).toBeDefined();
    expect(handlers).toHaveLength(1); // unauthenticated

    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      parserOk: boolean;
      declaredKeysParsed: number;
      declaredValuesParsed: number;
      driftCount: number;
      blueprintFound: boolean;
    };

    // It must actually read the committed render.yaml from the running module
    // path — a route that reports `blueprintFound:false` in prod is a dead
    // instrument that still returns 200.
    expect(body.blueprintFound).toBe(true);
    expect(body.parserOk).toBe(true);
    expect(body.declaredKeysParsed).toBeGreaterThan(0);
    // The count that separates a broken parse from a clean box (TRA-2075) — the
    // original bug read 78 keys and 0 values and printed "all clear".
    expect(body.declaredValuesParsed).toBeGreaterThan(0);
    expect(typeof body.driftCount).toBe('number');
  });

  it('serves a live-health verdict (auth-gated) on GET /api/health/live', async () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never,
      userCtx: async () => ctx('admin', engineState({ marketOpen: false })),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/live')!;
    expect(handlers).toHaveLength(2); // requireAuth + handler
    const res = fakeRes();
    await handlers[1]!({}, res);
    const body = res.body as { status: string; build: unknown; feed: { trackedSymbols: number } };
    expect(body.status).toBe('green');
    expect(body.build).toBeDefined();
    expect(body.feed.trackedSymbols).toBe(1);
  });
});

describe('TRA-580 live-equity acceptance probe', () => {
  function snap(over: Partial<LiveEquityAcceptance> = {}): LiveEquityAcceptance {
    return {
      mode: 'live',
      tradierEnv: 'production',
      liveEquityClientConfigured: true,
      liveEquityTradingEnabled: true,
      liveSignalCount: 0,
      liveEquityPositionCount: 0,
      liveEquityBracketsWithBothLegs: 0,
      liveEquityMirrorsWithOrderId: 0,
      liveSkipReasonCount: 0,
      liveSkipReasonCategories: emptyLiveSkipBreakdown(),
      firstLiveEquityFillConfirmed: false,
      lastLiveEquityFillAt: null,
      ...over,
    };
  }

  it('aggregates fleet counts and confirms the first fill when a mirror has both legs + an order id', () => {
    const report = aggregateLiveEquityAcceptance(
      [
        snap({
          liveSignalCount: 2,
          liveEquityPositionCount: 1,
          liveEquityBracketsWithBothLegs: 1,
          liveEquityMirrorsWithOrderId: 1,
          firstLiveEquityFillConfirmed: true,
          lastLiveEquityFillAt: new Date(NOW - 60_000).toISOString(),
        }),
        snap({ mode: 'demo', tradierEnv: 'sandbox', liveSignalCount: 0, liveSkipReasonCount: 1 }),
      ],
      NOW,
    );
    expect(report.ok).toBe(true);
    expect(report.engineCount).toBe(2);
    expect(report.liveEngineCount).toBe(1);
    expect(report.productionEngineCount).toBe(1);
    expect(report.firstLiveEquityFillConfirmed).toBe(true);
    expect(report.totals).toMatchObject({
      liveSignals: 2,
      liveEquityPositions: 1,
      liveEquityBracketsWithBothLegs: 1,
      liveEquityMirrorsWithOrderId: 1,
      liveSkipReasons: 1,
    });
    expect(report.lastLiveEquityFillAt).toBe(new Date(NOW - 60_000).toISOString());
    expect(report.build).toBeDefined();
  });

  it('reports not-yet-confirmed for an armed-but-unfired fleet and never leaks trade specifics', () => {
    const report = aggregateLiveEquityAcceptance([snap()], NOW);
    expect(report.firstLiveEquityFillConfirmed).toBe(false);
    expect(report.lastLiveEquityFillAt).toBeNull();
    // Redaction guard: only the documented redacted keys are present.
    expect(Object.keys(report).sort()).toEqual(
      [
        'build',
        'engineCount',
        'firstLiveEquityFillConfirmed',
        'lastLiveEquityFillAt',
        'liveEngineCount',
        'liveEquityClientConfigured',
        'liveEquityTradingEnabled',
        'liveSkipReasonBreakdown',
        'ok',
        'productionEngineCount',
        'serviceEnv',
        'time',
        'totals',
      ].sort(),
    );
    // serviceEnv carries booleans only — never a credential value.
    expect(Object.values(report.serviceEnv).every(v => typeof v === 'boolean')).toBe(true);
  });

  it('TRA-1573 — maps raw skip reasons to a fixed, leak-free category vocabulary', () => {
    expect(
      categorizeLiveSkipReason(
        'display-only: sma200_pullback is not registered in the TRA-817 capital-gate manifest (no out-of-sample pass)',
      ),
    ).toBe('display_only_capital_gate');
    expect(categorizeLiveSkipReason('Tradier equity client not configured')).toBe('client_not_configured');
    expect(
      categorizeLiveSkipReason('agent gating: live routing disabled until board+CTO go-live gate is cleared'),
    ).toBe('live_routing_gated');
    expect(categorizeLiveSkipReason('daily equity limit reached (3/3)')).toBe('daily_limit_reached');
    expect(categorizeLiveSkipReason('OTM live broker mirror not wired (demo/paper only)')).toBe('otm_mirror_not_wired');
    expect(categorizeLiveSkipReason('AAPL not opened (no quote / dedup / risk gate)')).toBe('risk_or_quote_gate');
    expect(categorizeLiveSkipReason('Tradier rejected the bracket order')).toBe('broker_reject');
    expect(categorizeLiveSkipReason('some unrecognized future reason')).toBe('other');
  });

  it('TRA-1573 — fleet breakdown sums per-engine skip categories and stays redacted', () => {
    const report = aggregateLiveEquityAcceptance(
      [
        snap({
          liveSignalCount: 30,
          liveSkipReasonCount: 30,
          liveSkipReasonCategories: { ...emptyLiveSkipBreakdown(), display_only_capital_gate: 30 },
        }),
        snap({
          liveSignalCount: 9,
          liveSkipReasonCount: 9,
          liveSkipReasonCategories: {
            ...emptyLiveSkipBreakdown(),
            display_only_capital_gate: 8,
            risk_or_quote_gate: 1,
          },
        }),
      ],
      NOW,
    );
    // The by-design capital gate dominates — the 0-fills is NOT a wiring gap.
    expect(report.liveSkipReasonBreakdown.display_only_capital_gate).toBe(38);
    expect(report.liveSkipReasonBreakdown.risk_or_quote_gate).toBe(1);
    expect(report.liveSkipReasonBreakdown.client_not_configured).toBe(0);
    // Sum of the breakdown equals the flat skip count — no signals lost.
    const total = Object.values(report.liveSkipReasonBreakdown).reduce((a, b) => a + b, 0);
    expect(total).toBe(report.totals.liveSkipReasons);
    // Redaction: every key is a constant category label, every value a number.
    expect(Object.values(report.liveSkipReasonBreakdown).every(v => typeof v === 'number')).toBe(true);
  });

  it('TRA-715 — serviceEnv reflects injected env presence as booleans only', () => {
    const armed = aggregateLiveEquityAcceptance([snap()], NOW, {
      TRADIER_ENV: 'production',
      TRADIER_API_TOKEN: 'tok-redacted',
      TRADIER_ACCOUNT_ID: 'acct-redacted',
      LIVE_EQUITY_BOOT_USER: 'admin',
    });
    expect(armed.serviceEnv).toEqual({
      tradierEnvProduction: true,
      productionTradierTokenPresent: true,
      productionTradierAccountPresent: true,
      bootArmPinConfigured: true,
    });

    const bare = aggregateLiveEquityAcceptance([snap()], NOW, { TRADIER_ENV: 'sandbox' });
    expect(bare.serviceEnv).toEqual({
      tradierEnvProduction: false,
      productionTradierTokenPresent: false,
      productionTradierAccountPresent: false,
      bootArmPinConfigured: false,
    });
    // No credential VALUE ever surfaces in the redacted report.
    expect(JSON.stringify(armed)).not.toContain('tok-redacted');
    expect(JSON.stringify(armed)).not.toContain('acct-redacted');
  });

  it('mounts GET /api/health/live-equity (unauthenticated) only when the dep is provided', () => {
    const withDep = fakeApp();
    registerLiveHealthRoutes(withDep.app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      liveEquityAcceptance: () => [snap({ firstLiveEquityFillConfirmed: true })],
      now: () => NOW,
    });
    const handlers = withDep.routes.get('/api/health/live-equity')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like /version
    const res = fakeRes();
    handlers[0]!({}, res);
    expect((res.body as { firstLiveEquityFillConfirmed: boolean }).firstLiveEquityFillConfirmed).toBe(true);

    const without = fakeApp();
    registerLiveHealthRoutes(without.app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    expect(without.routes.get('/api/health/live-equity')).toBeUndefined();
  });
});

describe('TRA-1289 sma200 forward-test fill evidence', () => {
  function fleetState(
    open: Array<Record<string, unknown>>,
    closed: Array<Record<string, unknown>>,
  ): { state: EngineState; mode: string } {
    return {
      mode: 'demo',
      state: engineState({
        account: { totalEquity: 25_000, availableCash: 25_000, dailyPnl: 0, openPositions: open },
        closedPositions: closed,
      } as unknown as Partial<EngineState>),
    };
  }

  it('reports zero fills when no position carries the forwardTestOnly marker', () => {
    const report = summarizeSma200ForwardTestFills([
      fleetState([{ id: 'a', openedAt: NOW }], [{ pnl: 50, openedAt: NOW - 1000, closedAt: NOW }]),
    ]);
    expect(report.fillCount).toBe(0);
    expect(report.openPositions).toBe(0);
    expect(report.closedCount).toBe(0);
    expect(report.lastFillAt).toBeNull();
    expect(report.realizedPnl).toBe(0);
  });

  it('counts open + closed forwardTestOnly fills and folds realized P&L / last-fill time', () => {
    const report = summarizeSma200ForwardTestFills([
      fleetState(
        [
          { id: 'ft-open', openedAt: NOW - 5_000, forwardTestOnly: true },
          { id: 'normal-open', openedAt: NOW }, // not forward-test → ignored
        ],
        [
          { pnl: 120, openedAt: NOW - 20_000, closedAt: NOW - 1_000, forwardTestOnly: true },
          { pnl: -40, openedAt: NOW - 10_000, closedAt: NOW, forwardTestOnly: true },
          { pnl: 999, openedAt: NOW, closedAt: NOW }, // not forward-test → ignored
        ],
      ),
    ]);
    expect(report.openPositions).toBe(1);
    expect(report.closedCount).toBe(2);
    expect(report.fillCount).toBe(3); // >= 1 ⇒ monitor closes done
    expect(report.realizedPnl).toBe(80); // 120 - 40, excludes the non-FT 999
    // Most-recent forwardTestOnly open time (the open fill at NOW - 5_000).
    expect(report.lastFillAt).toBe(new Date(NOW - 5_000).toISOString());
  });

  it('aggregates forwardTestOnly fills across every demo engine in the fleet', () => {
    const report = summarizeSma200ForwardTestFills([
      fleetState([{ id: 'e1', openedAt: NOW, forwardTestOnly: true }], []),
      fleetState([], [{ pnl: 10, openedAt: NOW - 1, closedAt: NOW, forwardTestOnly: true }]),
    ]);
    expect(report.fillCount).toBe(2);
    expect(report.openPositions).toBe(1);
    expect(report.closedCount).toBe(1);
  });
});

describe('TRA-898 demo-book summary', () => {
  function demoState(over: Partial<EngineState> = {}): EngineState {
    return engineState({
      account: { totalEquity: 25_500, availableCash: 18_000, dailyPnl: 500, openPositions: [{}, {}] },
      closedPositions: [
        { pnl: 300, closedAt: NOW - 60_000 },
        { pnl: -120, closedAt: NOW - 2 * 24 * 60 * 60 * 1000 }, // older than 24h
      ],
      agentRecommendations: [
        { action: 'BUY', proposedSignal: {} },
        { action: 'HOLD', proposedSignal: null },
        { action: 'SELL', proposedSignal: {} },
      ],
      tradingAgentsEnabled: true,
      tradingAgentsGatingEnabled: true,
      tradingAgentsLiveGatingEnabled: false,
      autoTradingEnabled: false,
      tradingHalted: false,
      haltReason: null,
      ...over,
    } as unknown as EngineState);
  }

  it('summarizes equity, open/closed P&L, and agent decision activity for the caller', () => {
    const report = summarizeDemoBook(demoState(), 'demo', NOW);
    expect(report.mode).toBe('demo');
    expect(report.equity).toEqual({ totalEquity: 25_500, availableCash: 18_000, dailyPnl: 500 });
    expect(report.openPositionCount).toBe(2);
    expect(report.closed.recentCount).toBe(2);
    expect(report.closed.recentRealizedPnl).toBe(180);
    expect(report.closed.recentCapped).toBe(false);
    // Only the close within 24h counts toward the day window.
    expect(report.closed.last24hCount).toBe(1);
    expect(report.closed.last24hRealizedPnl).toBe(300);
    expect(report.agentActivity).toEqual({
      recommendationCount: 3,
      byAction: { BUY: 1, SELL: 1, HOLD: 1 },
      routableCount: 2,
    });
    expect(report.agents).toMatchObject({
      tradingAgentsEnabled: true,
      gatingEnabled: true,
      liveGatingEnabled: false,
    });
  });

  // TRA-2671 — regression control for the joined-operand family. Built to the
  // 602c276 template: a REPAIR-SLAVED book and an INDEPENDENT book carrying
  // BYTE-IDENTICAL equity/cash/position numbers must grade DIFFERENTLY. If a
  // future edit collapses `cashInvariant.ok` back to a plain
  // `Math.abs(gap) < 0.01`, both arms below produce `true` and the first
  // assertion fails — which is the whole point of the control.
  describe('TRA-2671 cashInvariant is not self-confirming', () => {
    // 0 open positions ⇒ committedCapital 0 ⇒ expectedCash === totalEquity.
    // Cash is set EQUAL to equity, i.e. exactly what `repairDriftedCash()`
    // assigns. Both arms therefore compute gap === 0; the ONLY difference
    // between them is the provenance record.
    const joinedNumbers = {
      account: { totalEquity: 2_276.18, availableCash: 2_276.18, dailyPnl: 0, openPositions: [] },
    };

    it('grades a repair-slaved book NOT MEASURED and an independent book GREEN on identical numbers', () => {
      const slaved = summarizeDemoBook(
        demoState({
          account: {
            ...joinedNumbers.account,
            cashRepair: { appliedAt: NOW - 1_000, delta: 3_243.54, from: 207.14, to: 3_450.67 },
          },
        } as never),
        'demo',
        NOW,
      );
      const independent = summarizeDemoBook(demoState(joinedNumbers as never), 'demo', NOW);

      // Identical arithmetic on both arms — the comparison itself cannot tell
      // them apart, which is precisely why the verdict must not rest on it.
      expect(slaved.cashInvariant.gap).toBe(independent.cashInvariant.gap);
      expect(slaved.cashInvariant.expectedCash).toBe(independent.cashInvariant.expectedCash);

      // ...and yet they grade differently.
      expect(slaved.cashInvariant.ok).toBeNull(); // NOT MEASURED, never `true`
      expect(slaved.cashInvariant.repairSlaved).toBe(true);
      expect(independent.cashInvariant.ok).toBe(true); // genuinely falsifiable
      expect(independent.cashInvariant.repairSlaved).toBe(false);
    });

    it('RED outranks NOT MEASURED: drift re-opened AFTER the repair is never masked', () => {
      // The `null` branch must not become a place for live defects to hide.
      // Same repair record, but cash has since drifted off equity again — that
      // means the underlying writer is still wrong and must read RED.
      const report = summarizeDemoBook(
        demoState({
          account: {
            totalEquity: 2_276.18,
            availableCash: 2_100.0,
            dailyPnl: 0,
            openPositions: [],
            cashRepair: { appliedAt: NOW - 1_000, delta: 3_243.54, from: 207.14, to: 3_450.67 },
          },
        } as never),
        'demo',
        NOW,
      );
      expect(report.cashInvariant.repairSlaved).toBe(true);
      expect(report.cashInvariant.ok).toBe(false);
    });

    it('a green is reserved for books no writer has touched', () => {
      // Guards the other direction: `repairSlaved` must key on the RECORD, not
      // on the gap being non-zero, or a zero-delta repair would still score a
      // pass off operands the writer had already joined.
      const report = summarizeDemoBook(
        demoState({
          account: {
            ...joinedNumbers.account,
            cashRepair: { appliedAt: NOW - 1_000, delta: 0.5, from: 2_275.68, to: 2_276.18 },
          },
        } as never),
        'demo',
        NOW,
      );
      expect(report.cashInvariant.ok).not.toBe(true);
    });
  });

  it('flags the closed buffer as capped at the 20-row getState() ceiling', () => {
    const twenty = Array.from({ length: 20 }, () => ({ pnl: 10, closedAt: NOW }));
    const report = summarizeDemoBook(demoState({ closedPositions: twenty as never }), 'demo', NOW);
    expect(report.closed.recentCapped).toBe(true);
    expect(report.closed.last24hCount).toBe(20);
  });

  it('mounts GET /api/health/demo-book auth-gated (requireAuth + handler)', async () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never,
      userCtx: async () => ctx('admin', demoState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/demo-book')!;
    expect(handlers).toHaveLength(2); // gate + handler
    const res = resWithLocals();
    await handlers[1]!({}, res);
    const body = res.body as { ok: boolean; equity: { totalEquity: number }; build: unknown };
    expect(body.ok).toBe(true);
    expect(body.equity.totalEquity).toBe(25_500);
    expect(body.build).toBeDefined();
  });

  it('TRA-901 summarizeDemoBooks keys each demo engine book by user', () => {
    const report = summarizeDemoBooks(
      [{ username: 'demo-trader', state: demoState(), mode: 'demo' }],
      NOW,
    );
    expect(report.ok).toBe(true);
    expect(report.demoEngineCount).toBe(1);
    expect(report.books).toHaveLength(1);
    expect(report.books[0]!.username).toBe('demo-trader');
    expect(report.books[0]!.book.equity.totalEquity).toBe(25_500);
    expect(report.books[0]!.book.openPositionCount).toBe(2);
    expect(report.build).toBeDefined();
  });

  it('TRA-901 internal token unlocks demo-book without a user JWT and returns the fleet books', async () => {
    const { app, routes } = fakeApp();
    let requireAuthCalled = false;
    registerLiveHealthRoutes(app, {
      requireAuth: (() => {
        requireAuthCalled = true;
      }) as never,
      userCtx: async () => {
        throw new Error('userCtx must not run on the internal path');
      },
      getSettings: () => settings(),
      internalToken: () => 'watch-secret',
      fleetBooks: () => [{ username: 'demo-trader', state: demoState(), mode: 'demo' }],
      now: () => NOW,
    });
    const [gate, handler] = routes.get('/api/health/demo-book')!;
    // Valid token → gate sets res.locals and calls next(); requireAuth is skipped.
    const res = resWithLocals();
    let nexted = false;
    gate({ headers: { 'x-internal-token': 'watch-secret' } }, res, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(requireAuthCalled).toBe(false);
    expect(res.locals['internalDemoAccess']).toBe(true);
    await handler!({ headers: { 'x-internal-token': 'watch-secret' } }, res);
    const body = res.body as { demoEngineCount: number; books: Array<{ username: string }> };
    expect(body.demoEngineCount).toBe(1);
    expect(body.books[0]!.username).toBe('demo-trader');
  });

  it('TRA-901 a wrong/absent internal token falls through to requireAuth', () => {
    const { app, routes } = fakeApp();
    let requireAuthCalls = 0;
    registerLiveHealthRoutes(app, {
      requireAuth: (() => {
        requireAuthCalls += 1;
      }) as never,
      userCtx: async () => ctx('admin', demoState()),
      getSettings: () => settings(),
      internalToken: () => 'watch-secret',
      fleetBooks: () => [],
      now: () => NOW,
    });
    const [gate] = routes.get('/api/health/demo-book')!;
    const res = resWithLocals();
    gate({ headers: { 'x-internal-token': 'WRONG' } }, res, () => undefined); // wrong token
    gate({ headers: {} }, res, () => undefined); // no token
    expect(requireAuthCalls).toBe(2);
    expect(res.locals['internalDemoAccess']).toBeUndefined();
  });

  it('TRA-901 internal access stays disabled when no token is configured', () => {
    const { app, routes } = fakeApp();
    let requireAuthCalls = 0;
    registerLiveHealthRoutes(app, {
      requireAuth: (() => {
        requireAuthCalls += 1;
      }) as never,
      userCtx: async () => ctx('admin', demoState()),
      getSettings: () => settings(),
      internalToken: () => undefined, // disabled
      fleetBooks: () => [{ username: 'demo-trader', state: demoState(), mode: 'demo' }],
      now: () => NOW,
    });
    const [gate] = routes.get('/api/health/demo-book')!;
    const res = resWithLocals();
    // Even a header present → ignored, falls through to requireAuth.
    gate({ headers: { 'x-internal-token': 'anything' } }, res, () => undefined);
    expect(requireAuthCalls).toBe(1);
    expect(res.locals['internalDemoAccess']).toBeUndefined();
  });

  it('TRA-901 summarizeDemoBooksPublic anonymizes usernames to demo-N labels', () => {
    const report = summarizeDemoBooksPublic(
      [
        { username: 'demo-trader', state: demoState(), mode: 'demo' },
        { username: 'second-trader', state: demoState(), mode: 'demo' },
      ],
      NOW,
    );
    expect(report.ok).toBe(true);
    expect(report.demoEngineCount).toBe(2);
    expect(report.books.map(b => b.label)).toEqual(['demo-1', 'demo-2']);
    // No username field leaks onto the public surface.
    expect(report.books.every(b => !('username' in b))).toBe(true);
    // Paper P&L / activity is preserved for the watch.
    expect(report.books[0]!.book.equity.totalEquity).toBe(25_500);
    expect(report.books[0]!.book.openPositionCount).toBe(2);
  });

  it('TRA-901 mounts GET /api/health/demo-book-public NO-AUTH (single handler)', async () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => {
        throw new Error('requireAuth must not run on the public path');
      }) as never,
      userCtx: async () => {
        throw new Error('userCtx must not run on the public path');
      },
      getSettings: () => settings(),
      fleetBooks: () => [{ username: 'demo-trader', state: demoState(), mode: 'demo' }],
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/demo-book-public')!;
    expect(handlers).toHaveLength(1); // no gate — public
    const res = resWithLocals();
    await handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      demoEngineCount: number;
      hiddenTestBookCount: number;
      testBookNote: string | null;
      books: Array<{ label: string; role: string; book: { equity: { totalEquity: number } } }>;
    };
    expect(body.ok).toBe(true);
    expect(body.demoEngineCount).toBe(1);
    expect(body.books[0]!.label).toBe('demo-1');
    expect(body.books[0]!.role).toBe('demo');
    expect(body.books[0]!.book.equity.totalEquity).toBe(25_500);
    // TRA-1949 — no test books here, so nothing hidden and no note.
    expect(body.hiddenTestBookCount).toBe(0);
    expect(body.testBookNote).toBeNull();
  });

  it('TRA-1949 hides QA/test books by default with a note; ?includeTest=1 restores them', async () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never,
      userCtx: async () => {
        throw new Error('userCtx must not run on the public path');
      },
      getSettings: () => settings(),
      fleetBooks: () => [
        { username: 'richard', state: demoState(), mode: 'demo' },
        { username: 'qa_reg_1', state: demoState(), mode: 'demo' },
        { username: 'qa_mirror_2', state: demoState(), mode: 'demo' },
      ],
      now: () => NOW,
    });
    const handler = routes.get('/api/health/demo-book-public')![0]!;

    // Default — the two QA books are hidden, Richard remains.
    const resDefault = resWithLocals();
    await handler({ query: {} }, resDefault);
    const bodyDefault = resDefault.body as {
      demoEngineCount: number;
      hiddenTestBookCount: number;
      testBookNote: string | null;
      books: Array<{ label: string; role: string }>;
    };
    expect(bodyDefault.demoEngineCount).toBe(1);
    expect(bodyDefault.hiddenTestBookCount).toBe(2);
    expect(bodyDefault.testBookNote).toContain('2 QA/test books hidden');
    expect(bodyDefault.books.map(b => b.role)).toEqual(['demo']);

    // ?includeTest=1 — every book returns, QA books tagged role 'test'.
    const resAll = resWithLocals();
    await handler({ query: { includeTest: '1' } }, resAll);
    const bodyAll = resAll.body as {
      demoEngineCount: number;
      hiddenTestBookCount: number;
      testBookNote: string | null;
      books: Array<{ label: string; role: string }>;
    };
    expect(bodyAll.demoEngineCount).toBe(3);
    expect(bodyAll.hiddenTestBookCount).toBe(0);
    expect(bodyAll.testBookNote).toBeNull();
    expect(bodyAll.books.filter(b => b.role === 'test')).toHaveLength(2);
  });

  // TRA-2524 — the fold instrument, pinned AT THE ROUTE. The unit test in
  // `test-accounts.test.ts` proves the predicate; this proves the board-facing
  // payload actually carries it, so re-inlining a local count here goes red.
  it('TRA-2524 counts books in the DESK fold that are neither test nor vouched for', async () => {
    const { app, routes } = fakeApp();
    const prev = process.env['LIVE_EQUITY_BOOT_USER'];
    process.env['LIVE_EQUITY_BOOT_USER'] = 'admin';
    try {
      registerLiveHealthRoutes(app, {
        requireAuth: (() => undefined) as never,
        userCtx: async () => {
          throw new Error('userCtx must not run on the public path');
        },
        getSettings: () => settings(),
        // The live 2026-07-29 fold on `9e1b1123` — 3 real books + the 3 fixtures
        // this ticket found — plus one book using a scheme nobody has seen.
        fleetBooks: () => [
          { username: 'admin', state: demoState(), mode: 'live' },
          { username: 'Richard', state: demoState(), mode: 'demo' },
          { username: 'enock', state: demoState(), mode: 'demo' },
          { username: 'ceo2251v130001', state: demoState(), mode: 'demo' },
          { username: 'qtprobe3', state: demoState(), mode: 'demo' },
          { username: 'tra2339v66f17374', state: demoState(), mode: 'demo' },
          { username: 'someNewFixtureScheme_42', state: demoState(), mode: 'demo' },
        ],
        now: () => NOW,
      });
      const handler = routes.get('/api/health/demo-book-public')![0]!;

      const res = resWithLocals();
      await handler({ query: {} }, res);
      const body = res.body as {
        demoEngineCount: number;
        hiddenTestBookCount: number;
        unrecognisedDeskBookCount: number;
        deskRosterNote: string | null;
        operator: { pinConfigured: boolean; engineCount: number; modes: string[]; inBooks: boolean };
      };
      // THE POSITIVE MARK — a non-zero reading, asserted before any zero below
      // is allowed to mean anything. The 3 fixtures are now CLASSIFIED (hidden),
      // so the only book left unvouched is the unknown scheme.
      expect(body.hiddenTestBookCount).toBe(3);
      // TRA-2650 — `admin` is `mode:'live'` here, so it is NOT in books[]: this
      // route is NO-AUTH and a book entry carries real equity. It was never in
      // books[] in production either — the provider dropped it upstream — this
      // assertion just used to claim otherwise off a fixture production could
      // not produce. Its survival is reported in `operator` instead.
      expect(body.demoEngineCount).toBe(3); // Richard + enock + unknown scheme
      expect(body.operator).toMatchObject({
        pinConfigured: true,
        engineCount: 1,
        modes: ['live'],
        inBooks: false,
      });
      expect(body.unrecognisedDeskBookCount).toBe(1);
      expect(body.deskRosterNote).toContain('1 book');
      expect(body.deskRosterNote).toContain('TRA-2524');

      // ?includeTest=1 is a DEBUGGING view; it must not be able to change the
      // answer to "which books are in the desk fold?".
      const resAll = resWithLocals();
      await handler({ query: { includeTest: '1' } }, resAll);
      expect((resAll.body as { unrecognisedDeskBookCount: number }).unrecognisedDeskBookCount).toBe(1);

      // Names never reach this NO-AUTH surface — the count is the alarm.
      expect(JSON.stringify(res.body)).not.toContain('someNewFixtureScheme_42');
    } finally {
      if (prev === undefined) delete process.env['LIVE_EQUITY_BOOT_USER'];
      else process.env['LIVE_EQUITY_BOOT_USER'] = prev;
    }
  });

  it('TRA-2524 reads 0 on the live fold once the three fixtures are classified', async () => {
    const { app, routes } = fakeApp();
    const prev = process.env['LIVE_EQUITY_BOOT_USER'];
    process.env['LIVE_EQUITY_BOOT_USER'] = 'admin';
    try {
      registerLiveHealthRoutes(app, {
        requireAuth: (() => undefined) as never,
        userCtx: async () => {
          throw new Error('userCtx must not run on the public path');
        },
        getSettings: () => settings(),
        fleetBooks: () => [
          { username: 'admin', state: demoState(), mode: 'live' },
          { username: 'Richard', state: demoState(), mode: 'demo' },
          { username: 'enock', state: demoState(), mode: 'demo' },
          { username: 'ceo2251v130001', state: demoState(), mode: 'demo' },
          { username: 'qtprobe3', state: demoState(), mode: 'demo' },
          { username: 'tra2339v66f17374', state: demoState(), mode: 'demo' },
        ],
        now: () => NOW,
      });
      const res = resWithLocals();
      await routes.get('/api/health/demo-book-public')![0]!({ query: {} }, res);
      const body = res.body as {
        demoEngineCount: number;
        hiddenTestBookCount: number;
        unrecognisedDeskBookCount: number;
        deskRosterNote: string | null;
        operator: { pinConfigured: boolean; engineCount: number; modes: string[]; inBooks: boolean };
      };
      // The whole point of the ticket: 5 DEMO books in, 3 of them fixtures.
      // (`admin` is the 6th, `mode:'live'` — see the TRA-2650 note above; it is
      // reported in `operator`, not counted in the demo fold.)
      expect(body.hiddenTestBookCount).toBe(3);
      expect(body.demoEngineCount).toBe(2); // Richard + enock
      expect(body.operator).toMatchObject({ pinConfigured: true, engineCount: 1, inBooks: false });
      expect(body.unrecognisedDeskBookCount).toBe(0);
      expect(body.deskRosterNote).toBeNull();
    } finally {
      if (prev === undefined) delete process.env['LIVE_EQUITY_BOOT_USER'];
      else process.env['LIVE_EQUITY_BOOT_USER'] = prev;
    }
  });

  // ── TRA-2660 — the desk-roster observer over the JOURNAL-ACCOUNT domain ─────
  //
  // The defect these pin: `unrecognisedDeskBookCount` is computed over the
  // RESIDENT engine map (wiped every boot, then narrowed to `mode:'demo'`), not
  // over the durable journal-row `account` domain the desk fold partitions. A
  // throwaway book whose engine is gone scores 0 there. Every test below keeps
  // the resident fleet CLEAN so the old field's 0 is real — if both fields move
  // together the fixture is not exercising the defect.
  describe('TRA-2660 journal-account desk roster', () => {
    /** Resident fleet with nothing unvouched in it: the old field must read 0. */
    const CLEAN_RESIDENT_FLEET = () => [
      { username: 'Richard', state: demoState(), mode: 'demo' },
      { username: 'enock', state: demoState(), mode: 'demo' },
    ];

    function journalRow(account: string, over: Partial<{ openTs: number; mode: string }> = {}) {
      return { account, openTs: NOW - 86_400_000, mode: 'demo', ...over };
    }

    function register(
      opts: {
        journalAccountRows?: () => Promise<
          ReadonlyArray<{ account?: string; openTs?: number; mode?: string }>
        >;
        requireAdmin?: FakeHandler;
      } = {},
    ) {
      const { app, routes } = fakeApp();
      registerLiveHealthRoutes(app, {
        requireAuth: ((_q: unknown, _s: unknown, n?: () => void) => n?.()) as never,
        userCtx: async () => {
          throw new Error('userCtx must not run on these paths');
        },
        getSettings: () => settings(),
        fleetBooks: CLEAN_RESIDENT_FLEET,
        now: () => NOW,
        ...opts,
      } as never);
      return routes;
    }

    /** Serialize exactly as express would, so `undefined` keys disappear. */
    function onWire(body: unknown): Record<string, unknown> {
      return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    }

    // ACCEPTANCE 1 — the negative control. One read, two populations, and they
    // MUST disagree: the journal carries a book the resident map never saw.
    it('counts an unrecognised JOURNAL account the resident-engine field cannot see', async () => {
      const routes = register({
        journalAccountRows: async () => [
          journalRow('Richard'),
          journalRow('mysterybook7'),
          journalRow('mysterybook7', { openTs: NOW - 3 * 86_400_000 }),
        ],
      });
      const res = resWithLocals();
      await routes.get('/api/health/demo-book-public')![0]!({ query: {} }, res);
      const body = onWire(res.body);

      // THE DISCRIMINATOR. Same read, same instant.
      expect(body['unrecognisedDeskAccountCount']).toBe(1);
      expect(body['unrecognisedDeskBookCount']).toBe(0);
      expect(body['journalAccountCount']).toBe(2);
      expect(body['deskAccountRosterNote']).toContain('TRA-2660');
      expect(body['deskAccountRosterNote']).toContain('/api/admin/desk-roster');
      // Still NO-AUTH: the count is the alarm, the name never crosses here.
      expect(JSON.stringify(res.body)).not.toContain('mysterybook7');
    });

    // ACCEPTANCE 2 — a test-classified account is not a finding.
    it('does not count a test-classified journal account (`tra9999vfake` → /^tra\\d/i)', async () => {
      const routes = register({
        journalAccountRows: async () => [journalRow('Richard'), journalRow('tra9999vfake')],
      });
      const res = resWithLocals();
      await routes.get('/api/health/demo-book-public')![0]!({ query: {} }, res);
      const body = onWire(res.body);
      expect(body['unrecognisedDeskAccountCount']).toBe(0);
      expect(body['unrecognisedDeskBookCount']).toBe(0);
      // A genuine zero carries no note; only a finding or an unread does.
      expect(body['deskAccountRosterNote']).toBeNull();
      expect(body['journalAccountCount']).toBe(2);
    });

    // ACCEPTANCE 3 — assert on the WIRE. `0` must SURVIVE serialization as `0`,
    // and the key must be present unconditionally: an `optional?` field left
    // `undefined` is dropped by `JSON.stringify`, which reads a fully-patched
    // route as unpatched (TRA-2598).
    it('projects the new keys unconditionally — a clean read serializes 0, not a missing key', async () => {
      const routes = register({ journalAccountRows: async () => [journalRow('Richard')] });
      const res = resWithLocals();
      await routes.get('/api/health/demo-book-public')![0]!({ query: {} }, res);
      const body = onWire(res.body);
      expect('unrecognisedDeskAccountCount' in body).toBe(true);
      expect('journalAccountCount' in body).toBe(true);
      expect('deskAccountRosterNote' in body).toBe(true);
      expect(body['unrecognisedDeskAccountCount']).toBe(0);
      expect(body['unrecognisedDeskAccountCount']).not.toBeNull();
    });

    // ACCEPTANCE 3 (second half) — "could not read the journal" is a SENTINEL,
    // never another 0. This is the whole reason the ticket exists: a zero that
    // means "nothing to see" and a zero that means "I measured nothing" must not
    // be the same bytes.
    it('reports null — not 0 — when the journal read throws', async () => {
      const routes = register({
        journalAccountRows: async () => {
          throw new Error('journal file unreadable');
        },
      });
      const res = resWithLocals();
      await routes.get('/api/health/demo-book-public')![0]!({ query: {} }, res);
      const body = onWire(res.body);
      expect(body['unrecognisedDeskAccountCount']).toBeNull();
      expect(body['journalAccountCount']).toBeNull();
      expect(body['deskAccountRosterNote']).toContain('UNREAD');
      expect(body['deskAccountRosterNote']).toContain('journal file unreadable');
      // The key still has to be THERE — a dropped key reads as an old build.
      expect('unrecognisedDeskAccountCount' in body).toBe(true);
    });

    it('reports null when no journal provider is wired at all', async () => {
      const routes = register();
      const res = resWithLocals();
      await routes.get('/api/health/demo-book-public')![0]!({ query: {} }, res);
      const body = onWire(res.body);
      expect(body['unrecognisedDeskAccountCount']).toBeNull();
      expect(body['deskAccountRosterNote']).toContain('no journal-account provider');
    });

    // ACCEPTANCE 5 — independence from `?includeTest`. A debugging query string
    // must not change the answer to "which accounts are in the fold?".
    it('gives the same account answer with and without ?includeTest=1', async () => {
      const rows = async () => [
        journalRow('Richard'),
        journalRow('mysterybook7'),
        journalRow('qa_throwaway'),
      ];
      const routes = register({ journalAccountRows: rows });
      const handler = routes.get('/api/health/demo-book-public')![0]!;
      const resDefault = resWithLocals();
      await handler({ query: {} }, resDefault);
      const resAll = resWithLocals();
      await handler({ query: { includeTest: '1' } }, resAll);
      expect(onWire(resDefault.body)['unrecognisedDeskAccountCount']).toBe(1);
      expect(onWire(resAll.body)['unrecognisedDeskAccountCount']).toBe(1);
      expect(onWire(resAll.body)['journalAccountCount']).toBe(3);
    });

    // The journal domain is MODE-BLIND on purpose — it is the superset of every
    // fold above it. A `live`-mode row owned by an unvouched account is exactly
    // the case the resident `mode:'demo'` narrowing dropped.
    it('sees a live-mode journal account the demo-only resident read would drop', async () => {
      const routes = register({
        journalAccountRows: async () => [journalRow('mysterybook7', { mode: 'live' })],
      });
      const res = resWithLocals();
      await routes.get('/api/health/demo-book-public')![0]!({ query: {} }, res);
      expect(onWire(res.body)['unrecognisedDeskAccountCount']).toBe(1);
      expect(onWire(res.body)['unrecognisedDeskBookCount']).toBe(0);
    });

    // Rows with no `account` (pre-TRA-1475 opens) are unclassifiable, not
    // findings — counting them would manufacture a permanent false alarm.
    it('does not count blank/absent account rows as unrecognised', async () => {
      const routes = register({
        journalAccountRows: async () => [
          { openTs: NOW, mode: 'demo' },
          journalRow('   '),
          journalRow('Richard'),
        ],
      });
      const res = resWithLocals();
      await routes.get('/api/health/demo-book-public')![0]!({ query: {} }, res);
      const body = onWire(res.body);
      expect(body['unrecognisedDeskAccountCount']).toBe(0);
      expect(body['journalAccountCount']).toBe(1);
    });

    // The live domain is 87% unclassifiable (2192 of 2510 rows carry no
    // `account` at all). A 0 over that domain is a statement about the OTHER
    // 13%, and publishing it bare would re-create this ticket's own defect one
    // layer up — a clean-looking count whose population is not the population it
    // appears to describe.
    it('says so when a 0 sits on a domain whose rows are mostly unclassifiable', async () => {
      const routes = register({
        journalAccountRows: async () => [
          journalRow('Richard'),
          { openTs: NOW, mode: 'demo' },
          { openTs: NOW, mode: 'demo' },
          { openTs: NOW, mode: 'demo' },
        ],
      });
      const res = resWithLocals();
      await routes.get('/api/health/demo-book-public')![0]!({ query: {} }, res);
      const body = onWire(res.body);
      expect(body['unrecognisedDeskAccountCount']).toBe(0);
      expect(body['journalRowsScanned']).toBe(4);
      expect(body['journalRowsWithoutAccount']).toBe(3);
      // The coverage must be READABLE next to the count, not inferable.
      expect(body['deskAccountRosterNote']).toContain('UNCLASSIFIABLE');
      expect(body['deskAccountRosterNote']).toContain('NOT evidence');
      expect('journalRowsWithoutAccount' in body).toBe(true);
    });

    // ── The admin NAMES surface ──────────────────────────────────────────────
    it('names the unrecognised accounts (with row counts and first/last open) behind admin auth', async () => {
      const routes = register({
        journalAccountRows: async () => [
          journalRow('Richard'),
          journalRow('mysterybook7', { openTs: 1_000 }),
          journalRow('mysterybook7', { openTs: 9_000 }),
          journalRow('mysterybook7', { openTs: 5_000, mode: 'live' }),
          journalRow('otherbook', { openTs: 4_000 }),
          journalRow('qa_throwaway'),
        ],
        requireAdmin: ((_q: unknown, _s: unknown, n?: () => void) => n?.()) as never,
      });
      const handlers = routes.get('/api/admin/desk-roster')!;
      // GET only, and gated: auth + admin both sit in front of the handler.
      expect(handlers).toHaveLength(3);
      const res = resWithLocals();
      await handlers[2]!({ query: {} }, res);
      const body = onWire(res.body) as {
        unrecognisedDeskAccountCount: number;
        journalAccountCount: number;
        rowsScanned: number;
        knownDeskBooks: string[];
        unrecognisedDeskAccounts: Array<{
          account: string;
          rowCount: number;
          firstOpen: string | null;
          lastOpen: string | null;
          modes: string[];
        }>;
      };
      expect(body.unrecognisedDeskAccountCount).toBe(2);
      expect(body.journalAccountCount).toBe(4);
      expect(body.rowsScanned).toBe(6);
      expect(body.knownDeskBooks).toContain('admin');
      // Sorted by row count, so the busiest unvouched book leads.
      expect(body.unrecognisedDeskAccounts.map(a => a.account)).toEqual([
        'mysterybook7',
        'otherbook',
      ]);
      const mystery = body.unrecognisedDeskAccounts[0]!;
      expect(mystery.rowCount).toBe(3);
      expect(mystery.firstOpen).toBe(new Date(1_000).toISOString());
      expect(mystery.lastOpen).toBe(new Date(9_000).toISOString());
      expect(mystery.modes).toEqual(['demo', 'live']);
      // The test book is never named — it is noise, and naming it would bury
      // the two accounts that actually want a decision.
      expect(JSON.stringify(res.body)).not.toContain('qa_throwaway');
    });

    // The three classes must PARTITION the domain. `unrecognised: []` on its own
    // cannot tell "the roster is complete" from "the census lost an account" —
    // and a roster that names books which never traded is not a roster either.
    it('names the VOUCHED half too, and the three classes partition the domain', async () => {
      const routes = register({
        journalAccountRows: async () => [
          journalRow('Richard', { openTs: 7_000 }),
          journalRow('Richard', { openTs: 8_000 }),
          journalRow('mysterybook7'),
          journalRow('qa_throwaway'),
          journalRow('ctoverify_9'),
        ],
        requireAdmin: ((_q: unknown, _s: unknown, n?: () => void) => n?.()) as never,
      });
      const res = resWithLocals();
      await routes.get('/api/admin/desk-roster')![2]!({ query: {} }, res);
      const body = onWire(res.body) as {
        journalAccountCount: number;
        testAccountCount: number;
        partitions: boolean;
        rosterDeskAccounts: Array<{ account: string; rowCount: number; lastOpen: string | null }>;
        unrecognisedDeskAccounts: Array<{ account: string }>;
      };
      expect(body.journalAccountCount).toBe(4);
      expect(body.rosterDeskAccounts.map(a => a.account)).toEqual(['Richard']);
      expect(body.rosterDeskAccounts[0]!.rowCount).toBe(2);
      expect(body.rosterDeskAccounts[0]!.lastOpen).toBe(new Date(8_000).toISOString());
      expect(body.unrecognisedDeskAccounts.map(a => a.account)).toEqual(['mysterybook7']);
      expect(body.testAccountCount).toBe(2);
      expect(body.partitions).toBe(true);
      // `enock` is on KNOWN_DESK_BOOKS but never traded — the roster list is
      // what it OBSERVED, not an echo of the allowlist.
      expect(JSON.stringify(res.body)).not.toContain('"account":"enock"');
    });

    it('serves 503 — never an empty clean 200 — when the admin read cannot see the journal', async () => {
      const routes = register({
        journalAccountRows: async () => {
          throw new Error('journal file unreadable');
        },
        requireAdmin: ((_q: unknown, _s: unknown, n?: () => void) => n?.()) as never,
      });
      const res = resWithLocals();
      await routes.get('/api/admin/desk-roster')![2]!({ query: {} }, res);
      expect(res.statusCode).toBe(503);
      expect((onWire(res.body) as { ok: boolean }).ok).toBe(false);
      expect(JSON.stringify(res.body)).toContain('journal file unreadable');
    });

    it('does not mount the names route at all when no admin gate is supplied', () => {
      const routes = register({ journalAccountRows: async () => [journalRow('mysterybook7')] });
      expect(routes.has('/api/admin/desk-roster')).toBe(false);
    });
  });

  it('TRA-1949 labels the LIVE_EQUITY_BOOT_USER operator book distinctly and never hides it', async () => {
    const { app, routes } = fakeApp();
    const prev = process.env['LIVE_EQUITY_BOOT_USER'];
    process.env['LIVE_EQUITY_BOOT_USER'] = 'admin';
    try {
      registerLiveHealthRoutes(app, {
        requireAuth: (() => undefined) as never,
        userCtx: async () => {
          throw new Error('userCtx must not run on the public path');
        },
        getSettings: () => settings(),
        fleetBooks: () => [
          { username: 'admin', state: demoState(), mode: 'demo' },
          { username: 'richard', state: demoState(), mode: 'demo' },
          { username: 'qa_reg_1', state: demoState(), mode: 'demo' },
        ],
        now: () => NOW,
      });
      const handler = routes.get('/api/health/demo-book-public')![0]!;
      const res = resWithLocals();
      await handler({ query: {} }, res);
      const body = res.body as {
        demoEngineCount: number;
        hiddenTestBookCount: number;
        books: Array<{ label: string; role: string }>;
      };
      // admin → operator (kept, labelled), richard → demo, qa_reg_1 → hidden.
      expect(body.demoEngineCount).toBe(2);
      expect(body.hiddenTestBookCount).toBe(1);
      const operator = body.books.find(b => b.role === 'operator');
      expect(operator?.label).toBe('operator (live)');
      expect(body.books.map(b => b.role).sort()).toEqual(['demo', 'operator']);
    } finally {
      if (prev === undefined) delete process.env['LIVE_EQUITY_BOOT_USER'];
      else process.env['LIVE_EQUITY_BOOT_USER'] = prev;
    }
  });
});

describe('TRA-895 options-pipeline probe', () => {
  function pipeState(over: Partial<EngineState> = {}): EngineState {
    return engineState({
      symbols: [
        { symbol: 'AAPL', price: 1, volume: 1, change: 0, changePct: 0, lastUpdated: FRESH },
        { symbol: 'MSFT', price: 1, volume: 1, change: 0, changePct: 0, lastUpdated: FRESH },
      ],
      signals: [
        { type: 'relative_value', mode: 'demo' },
        { type: 'sma200_pullback', mode: 'demo' },
        { type: 'relative_value', mode: 'demo' },
      ],
      options: { openOptions: [{}, {}, {}] },
      autoTradingEnabled: true,
      tradingAgentsEnabled: true,
      tradingAgentsGatingEnabled: true,
      tradingHalted: false,
      haltReason: null,
      marketOpen: true,
      ...over,
    } as unknown as EngineState);
  }

  it('counts option signals + watchlist and reports the scan as armed when every gate passes', () => {
    const report = summarizeOptionsPipeline(
      { rvScannerConfigured: true, rvBreakerOpen: false, engines: [{ state: pipeState(), mode: 'demo' }] },
      NOW,
    );
    expect(report.ok).toBe(true);
    expect(report.rvScannerConfigured).toBe(true);
    expect(report.demoEngineCount).toBe(1);
    const e = report.engines[0]!;
    expect(e.optionSignalCount).toBe(2);
    expect(e.totalSignalCount).toBe(3);
    expect(e.watchlistSymbolCount).toBe(2);
    expect(e.openOptionsCount).toBe(3);
    // TRA-1405 — the bare open-option fixtures carry no `legs` and no closed
    // buffer / realized field, so the discriminators default cleanly.
    expect(e.openOptionsComboCount).toBe(0);
    expect(e.closedOptionsRecentCount).toBe(0);
    expect(e.dailyRealizedOptionsPnl).toBeNull();
    expect(e.rvScanArmed).toBe(true);
    expect(e.blockedBy).toBeNull();
    expect(report.build).toBeDefined();
    // TRA-895 — AI Options Ideas generator is un-gated (seeds near-ATM anchors
    // on calm days) so the demo watcher can confirm the ungated build is live.
    expect(report.aiIdeasGeneratorUngated).toBe(true);
    // TRA-1032 — exec-selector gate (+ TRA-1028 sub-flags) is surfaced so the
    // forward-validation flip is verifiable from the probe. Off by default in the
    // unit env, mirroring prod until the flag is set on the demo deploy.
    expect(report.optionExecSelectorEnabled).toBe(false);
    expect(report.optionExecEmaPullbackEnabled).toBe(false);
    expect(report.optionExecVolumeBreakoutEnabled).toBe(false);
    // TRA-1114 — demo-only directional-entry gate is surfaced so the board can
    // verify the flip drives real demo fills from the probe. Off by default.
    expect(report.optionDemoDirectionalEnabled).toBe(false);
  });

  it('TRA-1405 — surfaces per-engine option-book composition (combos vs closed vs realized) so a $0-Calendar book is diagnosable without a login', () => {
    // A book holding two multi-leg combos (never realize) + one single-leg, with
    // a non-empty recent-closed buffer and a today-realized figure — the exact
    // shape needed to tell "empty book" from "stuck-open combos" from "realizing
    // normally" for e.g. admin vs Richard, joinable by index to /autonomous-demo.
    const report = summarizeOptionsPipeline(
      {
        rvScannerConfigured: true,
        rvBreakerOpen: false,
        engines: [{
          state: pipeState({
            options: {
              openOptions: [
                { legs: [{}, {}] },      // iron condor / vertical → combo
                { legs: [{}, {}, {}, {}] }, // 4-leg combo
                { optionType: 'call' },  // single-leg (no legs)
              ],
              closedOptions: [{ pnl: 12 }, { pnl: -5 }],
              dailyRealizedOptionsPnl: 7,
            },
          } as unknown as Partial<EngineState>),
          mode: 'demo',
        }],
      },
      NOW,
    );
    const e = report.engines[0]!;
    expect(e.openOptionsCount).toBe(3);
    expect(e.openOptionsComboCount).toBe(2);
    expect(e.closedOptionsRecentCount).toBe(2);
    expect(e.dailyRealizedOptionsPnl).toBe(7);
  });

  it('names the first failing gate so "no option signals" is diagnosable', () => {
    // Auto-trade off → the RV options scan can never fire even with agents on.
    const offAuto = summarizeOptionsPipeline(
      { rvScannerConfigured: true, rvBreakerOpen: false, engines: [{ state: pipeState({ autoTradingEnabled: false }), mode: 'demo' }] },
      NOW,
    );
    expect(offAuto.engines[0]!.rvScanArmed).toBe(false);
    expect(offAuto.engines[0]!.blockedBy).toBe('auto_trading_off');

    // Scanner not configured (no Tradier creds) dominates.
    const noScanner = summarizeOptionsPipeline(
      { rvScannerConfigured: false, rvBreakerOpen: false, engines: [{ state: pipeState(), mode: 'demo' }] },
      NOW,
    );
    expect(noScanner.engines[0]!.blockedBy).toBe('rv_scanner_not_configured');

    // Market closed when everything else is green.
    const closed = summarizeOptionsPipeline(
      { rvScannerConfigured: true, rvBreakerOpen: false, engines: [{ state: pipeState({ marketOpen: false }), mode: 'demo' }] },
      NOW,
    );
    expect(closed.engines[0]!.blockedBy).toBe('market_closed');
  });

  it('mounts GET /api/health/options-pipeline unauthenticated when wired', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', pipeState()),
      getSettings: () => settings(),
      optionsPipeline: () => ({
        rvScannerConfigured: true,
        rvBreakerOpen: false,
        engines: [{ state: pipeState(), mode: 'demo' }],
      }),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/options-pipeline')!;
    expect(handlers).toHaveLength(1); // unauthenticated — handler only, no gate
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as { ok: boolean; engines: Array<{ optionSignalCount: number }> };
    expect(body.ok).toBe(true);
    expect(body.engines[0]!.optionSignalCount).toBe(2);
  });

  it('is not mounted when the dep is absent (surface stays unchanged)', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', pipeState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    expect(routes.get('/api/health/options-pipeline')).toBeUndefined();
  });
});

// ─── TRA-3218 (parent TRA-2760) — /api/health/options-halt ────────────────────
//
// The probe that makes a halted day distinguishable from a quiet day. One mount
// test + one fold test; the underlying states are pinned in the engine/breaker
// suites, so this only asserts the route surfaces them and the fleet counts.
describe('GET /api/health/options-halt (TRA-3218)', () => {
  const engineState = (over: Record<string, unknown> = {}) => ({
    engineId: 'engine-1',
    mode: 'live' as const,
    scope: { scope: 'book' as const, source: 'default' as const },
    exitRiskRulesEnabled: true,
    optionExecEnabled: true,
    entriesHalted: true,
    book: {
      halted: true,
      reason: 'Book session stop — net-negative after being up ≥ 0.50% of book equity; no new entries for the day',
      reasonCode: 'session_net_negative' as const,
      haltAt: NOW - 60 * 60 * 1000,
      peakOpenGain: 2.34,
      retainedFloor: 1.4,
    },
    sleeve: {
      halted: false,
      reason: null,
      cumulativeR: -0.83,
      dailyPnl: -79,
      closes: 1,
      day: '2026-08-11',
      haltAt: null,
      haltsToday: 0,
      releasesToday: 0,
      cooldown: { minutes: 0, reArmStepR: 1, reTripFloorR: null, reTripFloorPnl: null },
    },
    bookHaltGate: { day: '2026-08-11', blocked: 7, bypassed: 0 },
    ...over,
  });

  it('mounts unauthenticated when wired and reports the fleet + per-engine halt state', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState() as unknown as EngineState),
      getSettings: () => settings(),
      optionsHalt: () => [
        engineState(),
        engineState({ engineId: 'engine-2', mode: 'demo', entriesHalted: false }),
      ],
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/options-halt')!;
    expect(handlers).toHaveLength(1); // unauthenticated — handler only, no gate
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      engineCount: number;
      liveEngineCount: number;
      entriesHaltedCount: number;
      processScope: { scope: string };
      engines: Array<{ book: { haltAt: number | null }; bookHaltGate: { blocked: number } }>;
      ledger: { durability: { ephemeral: boolean } };
    };
    expect(body.ok).toBe(true);
    expect(body.engineCount).toBe(2);
    expect(body.liveEngineCount).toBe(1);
    expect(body.entriesHaltedCount).toBe(1);
    // The board's complaint, now countable from outside: the latch TIME and the
    // number of scans the book-wide halt swallowed.
    expect(body.engines[0]!.book.haltAt).toBe(NOW - 60 * 60 * 1000);
    expect(body.engines[0]!.bookHaltGate.blocked).toBe(7);
    // The scope var's process resolution rides along (unset here ⇒ book/default).
    expect(body.processScope.scope).toBe('book');
    // The durable ledger block is present so a reader can check ephemeral FIRST.
    expect(typeof body.ledger.durability.ephemeral).toBe('boolean');
  });

  it('is not mounted when the dep is absent (surface stays unchanged)', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState() as unknown as EngineState),
      getSettings: () => settings(),
      now: () => NOW,
    });
    expect(routes.get('/api/health/options-halt')).toBeUndefined();
  });
});

describe('TRA-998 hypothesis ratification routes', () => {
  const tmpFile = join(tmpdir(), `health-ratify-${process.pid}.jsonl`);

  function register(internalToken?: string) {
    const fa = fakeApp();
    registerLiveHealthRoutes(fa.app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
      ...(internalToken ? { internalToken: () => internalToken } : {}),
    });
    return fa;
  }

  beforeEach(() => setHypothesisQueueFileForTests(tmpFile));
  afterEach(async () => {
    setHypothesisQueueFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  async function seedPending(): Promise<string> {
    const h = makeHypothesis({
      target: { kind: 'gate', path: 'RV_GATE.minTrendConfluence' },
      proposedDelta: { op: 'set', value: 0.6 },
      rationale: 'reflect routine flagged weak trend confluence',
      source: 'reflection',
      createdAt: 1_700_000_000_000,
    });
    await runHypothesis(
      h,
      {
        baseConfig: { RV_GATE: { minTrendConfluence: 0.55 } },
        runBacktest: async () => ({
          sharpe: 1.4,
          expectancy: 0.22,
          profitFactor: 1.6,
          maxDrawdown: 0.12,
          tradeCount: 180,
        }),
      },
      1_700_000_100_000,
    );
    return h.id;
  }

  it('GET /api/health/hypothesis-queue lists the live queue (unauthenticated)', async () => {
    const id = await seedPending();
    const { routes } = register();
    const handlers = routes.get('/api/health/hypothesis-queue')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other probes
    const res = fakeRes();
    await handlers[0]!({}, res);
    const body = res.body as { ok: boolean; counts: { pending: number }; pendingRatification: { id: string }[] };
    expect(body.ok).toBe(true);
    expect(body.counts.pending).toBe(1);
    expect(body.pendingRatification[0].id).toBe(id);
  });

  it('POST /api/hypothesis/:id/ratify (accept) lands a demo override behind a flag', async () => {
    const id = await seedPending();
    const { postRoutes } = register('sekret');
    const handlers = postRoutes.get('/api/hypothesis/:id/ratify')!;
    expect(handlers).toHaveLength(2); // internalOrAuth gate + handler
    const res = resWithLocals();
    res.locals['internalDemoAccess'] = true;
    await handlers[1]!({ params: { id }, body: { decision: 'accept' } }, res);
    const body = res.body as { ok: boolean; override: { flag: string; mode: string } | null };
    expect(body.ok).toBe(true);
    expect(body.override?.mode).toBe('demo');
    expect(body.override?.flag).toMatch(/^ENABLE_HYP_/);
  });

  it('POST ratify rejects a bad decision with 400', async () => {
    const id = await seedPending();
    const { postRoutes } = register('sekret');
    const handler = postRoutes.get('/api/hypothesis/:id/ratify')![1]!;
    const res = resWithLocals();
    await handler({ params: { id }, body: { decision: 'maybe' } }, res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { ok: boolean }).ok).toBe(false);
  });

  it('POST ratify returns 409 for an unknown / non-pending id', async () => {
    const { postRoutes } = register('sekret');
    const handler = postRoutes.get('/api/hypothesis/:id/ratify')![1]!;
    const res = resWithLocals();
    await handler({ params: { id: 'hyp-deadbeef' }, body: { decision: 'accept' } }, res);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/unknown hypothesis/);
  });
});

describe('TRA-1301 correlated-exposure cap health route', () => {
  it('serves GET /api/health/correlated-exposure-cap unauthenticated with config + counts', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/correlated-exposure-cap')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      flag: string;
      enabled: boolean;
      config: { capPct: number; minTradeRiskPct: number };
      bindingCount: number;
    };
    expect(body.ok).toBe(true);
    expect(body.flag).toBe('CORRELATED_EXPOSURE_CAP_ENABLED');
    // DARK by default (no env flags set in the test process).
    expect(body.enabled).toBe(false);
    expect(body.config.capPct).toBeCloseTo(0.07, 9);
    expect(body.config.minTradeRiskPct).toBeCloseTo(0.0025, 9);
    expect(typeof body.bindingCount).toBe('number');
  });

  it('serves GET /api/health/take-profit-early unauthenticated, DARK + demo-only by default (TRA-1294)', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/take-profit-early')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      flag: string;
      enabled: boolean;
      demoOnly: boolean;
      liveCapitalReachable: boolean;
      config: { captureFrac: number };
    };
    expect(body.ok).toBe(true);
    expect(body.flag).toBe('TAKE_PROFIT_EARLY_ENABLED');
    // DARK by default (no env flag set in the test process).
    expect(body.enabled).toBe(false);
    expect(body.demoOnly).toBe(true);
    expect(body.liveCapitalReachable).toBe(false);
    expect(body.config.captureFrac).toBeCloseTo(0.6, 9);
  });
});

describe('TRA-1481 churn-brake health route', () => {
  beforeEach(() => clearChurnBrakeLedger());

  it('serves GET /api/health/churn-brake unauthenticated, DARK + demo-only by default', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/churn-brake')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      flag: string;
      armed: boolean;
      cap: number;
      demoOnly: boolean;
      liveCapitalReachable: boolean;
      opensRejected: number;
      dcaAddsHalted: number;
      counterWindow: string;
      countersSince: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.flag).toBe('ENABLE_CHURN_LOSS_BRAKE');
    expect(body.armed).toBe(false); // no env flag set in the test process
    expect(body.cap).toBe(3); // default cap
    expect(body.demoOnly).toBe(true);
    expect(body.liveCapitalReachable).toBe(false);
    expect(body.opensRejected).toBe(0);
    expect(body.dcaAddsHalted).toBe(0);
    // TRA-2813 — the payload must state its own persistence contract: these counters
    // reset at boot, unlike the durable conviction-dca guard counters. A reader
    // cross-checking the two endpoints needs the window boundary ON the payload.
    expect(body.counterWindow).toBe('since_boot');
    expect(typeof body.countersSince).toBe('string');
  });

  it('reports armed + cap from env and folds the ledger counters', () => {
    process.env.ENABLE_CHURN_LOSS_BRAKE = '1';
    process.env.CHURN_SAME_SESSION_OPEN_CAP = '3';
    recordChurnBrakeOpen('AMPG', '2026-07-08');
    recordChurnBrakeOpenRejected('AMPG', 3, 3, NOW);
    recordChurnBrakeDcaHalt('RIVN', 'equity', -120, NOW);
    try {
      const { app, routes } = fakeApp();
      registerLiveHealthRoutes(app, {
        requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
        userCtx: async () => ctx('admin', engineState()),
        getSettings: () => settings(),
        now: () => NOW,
      });
      const res = fakeRes();
      routes.get('/api/health/churn-brake')![0]!({}, res);
      const body = res.body as {
        armed: boolean;
        cap: number;
        opensRejected: number;
        dcaAddsHalted: number;
        openCountsBySymbol: { symbol: string; count: number }[];
      };
      expect(body.armed).toBe(true);
      expect(body.cap).toBe(3);
      expect(body.opensRejected).toBe(1);
      expect(body.dcaAddsHalted).toBe(1);
      expect(body.openCountsBySymbol[0]).toMatchObject({ symbol: 'AMPG', count: 1 });
    } finally {
      delete process.env.ENABLE_CHURN_LOSS_BRAKE;
      delete process.env.CHURN_SAME_SESSION_OPEN_CAP;
    }
  });
});

// TRA-1682 (parent TRA-1680 → TRA-1677) — the entry-greeks gate readout used to report
// `enabled` + thresholds and NOTHING about what the gate did, which is how an
// ALGEBRAICALLY IMPOSSIBLE gate (a [0.30,0.40] short-premium band applied to a sleeve
// whose selector cannot emit |Δ| < 0.45 ⇒ 100% reject) stayed invisible for a week: a
// gate rejecting everything and a tape offering nothing look identical when nothing
// counts. These tests pin the counts, and the `starving` alarm that names the difference.
describe('TRA-1682 entry-greeks-gate health route — admit/reject counts', () => {
  const etDay = etDateString(new Date(NOW));
  beforeEach(() => clearEntryGreeksLedger());
  afterEach(() => clearEntryGreeksLedger());

  function serve() {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/entry-greeks-gate')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    return res.body as {
      ok: boolean;
      flag: string;
      enabled: boolean;
      demoOnly: boolean;
      liveCapitalReachable: boolean;
      etDay: string;
      config: { deltaBand: [number, number]; deltaThetaRatioFloor: number };
      admitted: number;
      rejectedByReason: Record<string, number>;
      rejectedTotal: number;
      evaluated: number;
      admitRate: number | null;
      starving: boolean;
      warning?: string;
    };
  }

  it('reports the EFFECTIVE delta band (the 0.45 selector floor), not the short-premium default', () => {
    // The band the engine actually passes since `07ea3b1` is [RV_LONG_DELTA_FLOOR, 1].
    // This surface used to advertise the library default [0.30,0.40] — an observability
    // endpoint reporting a band the engine does not apply is how the bug hid.
    const body = serve();
    expect(body.ok).toBe(true);
    expect(body.flag).toBe('ENTRY_GREEKS_GATE_ENABLED');
    expect(body.demoOnly).toBe(true);
    expect(body.liveCapitalReachable).toBe(false);
    expect(body.etDay).toBe(etDay);
    expect(body.config.deltaBand).toEqual([0.45, 1]);
  });

  it('an un-run gate reports evaluated 0 with admitRate NULL (not 0) and no warning', () => {
    // "Nothing reached the gate" must never read the same as "the gate refused
    // everything" — that ambiguity IS the TRA-1677 defect.
    const body = serve();
    expect(body.evaluated).toBe(0);
    expect(body.admitted).toBe(0);
    expect(body.admitRate).toBeNull();
    expect(body.starving).toBe(false);
    expect(body.warning).toBeUndefined();
  });

  it('folds the durable per-reason reject counts + the admit count for the ET day', () => {
    recordEntryGreeksVerdict(true, null, etDay, 'rv-long', NOW);
    recordEntryGreeksVerdict(true, null, etDay, 'rv-long', NOW);
    recordEntryGreeksVerdict(true, null, etDay, 'rv-long', NOW);
    recordEntryGreeksVerdict(false, 'delta_out_of_band', etDay, 'rv-long', NOW);
    recordEntryGreeksVerdict(false, 'delta_theta_ratio_too_low', etDay, 'rv-long', NOW);
    recordEntryGreeksVerdict(false, 'non_finite_greeks', etDay, 'rv-long', NOW);

    const body = serve();
    expect(body.admitted).toBe(3);
    expect(body.rejectedByReason).toEqual({
      delta_out_of_band: 1,
      delta_theta_ratio_too_low: 1,
      non_finite_greeks: 1,
    });
    expect(body.rejectedTotal).toBe(3);
    expect(body.evaluated).toBe(6);
    expect(body.admitRate).toBe(0.5);
    expect(body.starving).toBe(false);
    expect(body.warning).toBeUndefined();
  });

  it('an ALL-REJECT session is LOUD — starving + a warning naming the gate as suspect', () => {
    // The exact TRA-1677 shape. This is the read that would have caught it on day one.
    for (let i = 0; i < 25; i++) recordEntryGreeksVerdict(false, 'delta_out_of_band', etDay, 'rv-long', NOW);

    const body = serve();
    expect(body.evaluated).toBe(25);
    expect(body.admitted).toBe(0);
    expect(body.admitRate).toBe(0);
    expect(body.starving).toBe(true);
    expect(body.warning).toContain('admitted 0 of 25');
    expect(body.warning).toContain('suspect the GATE');
  });
});

describe('TRA-1602 cost-aware fire-bar health route', () => {
  beforeEach(() => clearCostAwareGateLedger());
  afterEach(() => clearCostAwareGateLedger());

  it('serves GET /api/health/cost-aware-gate unauthenticated, DARK + demo-only by default', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/cost-aware-gate')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as {
      ok: boolean;
      flag: string;
      armed: boolean;
      demoOnly: boolean;
      liveCapitalReachable: boolean;
      bars: Record<string, number>;
      admittedTotal: number;
      rejectedTotal: number;
    };
    expect(body.ok).toBe(true);
    expect(body.flag).toBe('ENABLE_OPTION_COST_AWARE_GATE');
    expect(body.armed).toBe(false); // no env flag set in the test process
    expect(body.demoOnly).toBe(true);
    expect(body.liveCapitalReachable).toBe(false);
    // TRA-1661 — the options bar off the MEASURED spread cross: commission 0.05 +
    // spread 0.235 (TRA-1656) + margin 0.20 = 0.485R, clear of the 0.30 floor.
    // Was 1.25R against the refuted 1.00R modeled cross.
    expect(body.bars['single_leg_rv']).toBeCloseTo(0.485, 3);
    expect(body.bars['single_leg_otm']).toBeCloseTo(0.485, 3);
    expect(body.admittedTotal).toBe(0);
    expect(body.rejectedTotal).toBe(0);
  });

  it('reports armed from env and folds the durable admit/reject tallies', () => {
    process.env.ENABLE_OPTION_COST_AWARE_GATE = '1';
    const etDay = etDateString(new Date(NOW));
    recordCostAwareGateDecision('single_leg_rv', true, 1.9, 1.25, etDay, NOW);
    recordCostAwareGateDecision('single_leg_rv', false, 0.2, 1.25, etDay, NOW);
    try {
      const { app, routes } = fakeApp();
      registerLiveHealthRoutes(app, {
        requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
        userCtx: async () => ctx('admin', engineState()),
        getSettings: () => settings(),
        now: () => NOW,
      });
      const res = fakeRes();
      routes.get('/api/health/cost-aware-gate')![0]!({}, res);
      const body = res.body as {
        armed: boolean;
        admittedTotal: number;
        rejectedTotal: number;
        byStructure: { structure: string; admitted: number; rejected: number; avgRejectedGrossR: number | null }[];
      };
      expect(body.armed).toBe(true);
      expect(body.admittedTotal).toBe(1);
      expect(body.rejectedTotal).toBe(1); // the direct evidence the bar is biting
      expect(body.byStructure[0]).toMatchObject({
        structure: 'single_leg_rv',
        admitted: 1,
        rejected: 1,
        avgRejectedGrossR: 0.2,
      });
    } finally {
      delete process.env.ENABLE_OPTION_COST_AWARE_GATE;
    }
  });
});

// TRA-2311 (parent TRA-2295) — the spread ceiling's ARM BIT.
//
// `spreadCeilingEvaluated: 0` has two causes — ARMED-but-no-entry-reached-the-gate
// (verdict VOID) and DISARMED (verdict MEANINGLESS) — and before this block they
// were indistinguishable on the wire. A field that reads `true` in both states is
// not a fix, so every case below MUTATES the switch and asserts the bit MOVES.
describe('TRA-2311 spreadCeiling arm bit on /api/health/cost-aware-gate', () => {
  interface SpreadCeilingBlock {
    flag: string;
    armed: boolean;
    defaultOn: boolean;
    flagValue: string | null;
    overlayCapable: boolean;
    minBidUsdOverride: number | null;
    structures: string[];
    perStructure: { structure: string; maxSpreadPct: number; minBidUsd: number }[];
    note: string;
  }

  const serveCostGate = (): { spreadCeiling: SpreadCeilingBlock; armed: boolean } => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const res = fakeRes();
    routes.get('/api/health/cost-aware-gate')![0]!({}, res);
    return res.body as { spreadCeiling: SpreadCeilingBlock; armed: boolean };
  };

  const FLAG = 'OPTION_SPREAD_CEILING_ENFORCE';
  const MIN_BID = 'OPTION_SPREAD_CEILING_MIN_BID_USD';
  let tmp: string | null = null;

  beforeEach(() => {
    clearCostAwareGateLedger();
    delete process.env[FLAG];
    delete process.env[MIN_BID];
  });
  afterEach(() => {
    clearCostAwareGateLedger();
    delete process.env[FLAG];
    delete process.env[MIN_BID];
    delete process.env.DATA_DIR;
    delete process.env.ENABLE_OPTION_COST_AWARE_GATE;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('ABSENT flag ⇒ armed TRUE — the opt-OUT default, opposite polarity to deltaCeiling', () => {
    const { spreadCeiling } = serveCostGate();
    expect(spreadCeiling.flag).toBe(FLAG);
    expect(spreadCeiling.armed).toBe(true); // AC3: the default-ON half
    expect(spreadCeiling.defaultOn).toBe(true);
    expect(spreadCeiling.flagValue).toBeNull();
    expect(spreadCeiling.structures).toContain('single_leg_directional');
    // AC4 — the polarity has to be stated, not merely implemented: a reader who
    // pattern-matches this block onto deltaCeiling's opt-IN wording concludes the
    // exact opposite of the truth.
    expect(spreadCeiling.note).toContain('opt-OUT');
    expect(spreadCeiling.note).toMatch(/ABSENT .* is ARMED/);
    expect(spreadCeiling.note).toContain('ARMED');
  });

  // TRA-2319 — the ARMED note used to end "armed + evaluated>0 with
  // maxAdmittedSpreadPct ≤ the sleeve ceiling is the actual pass", and a reader who
  // followed it verbatim read PASS on a gate that ADMITTED NOTHING: the field is
  // `number | null` and `null <= 0.10` is true in JS. The note had already earned a
  // VOID branch for `evaluated == 0` (no entry reached the gate); the third state —
  // the gate RAN and rejected everything — was missing, and it is the one the naive
  // comparison silently converts into a pass. The instruction is what ships to the
  // grader, so the instruction is what has to carry the warning.
  it('the ARMED note states the maxAdmittedSpreadPct NULL branch, not just the evaluated=0 one', () => {
    const { spreadCeiling } = serveCostGate();
    expect(spreadCeiling.armed).toBe(true);
    const note = spreadCeiling.note;
    // Both VOID branches present and distinguishable.
    expect(note).toContain('evaluated=0');
    expect(note).toContain('maxAdmittedSpreadPct null');
    expect(note).toContain('ADMITTED NOTHING');
    // The mechanism, not just the conclusion — a bare "don't do that" rots into
    // folklore, the coercion rule does not.
    expect(note).toContain('null <= 0.10');
    expect(note).toContain('maxAdmittedSpreadPct !== null');
    expect(note).toContain('TRA-2319');

    // And the hazard itself, asserted rather than assumed: this is the comparison the
    // old sentence sanctioned, on the value the gate emits when it admits nothing.
    const maxAdmittedWhenNothingAdmitted: number | null = null;
    expect(maxAdmittedWhenNothingAdmitted! <= 0.1).toBe(true); // ← the false PASS
    expect(
      maxAdmittedWhenNothingAdmitted !== null && maxAdmittedWhenNothingAdmitted <= 0.1,
    ).toBe(false); // ← the predicate the note now prescribes
  });

  it('OPTION_SPREAD_CEILING_ENFORCE=0 ⇒ armed FALSE — the bit MOVES (prove-it-fires)', () => {
    process.env[FLAG] = '0';
    const { spreadCeiling } = serveCostGate();
    expect(spreadCeiling.armed).toBe(false); // AC3: the disarmed half
    expect(spreadCeiling.flagValue).toBe('0');
    // The note must tell the Monday grader the verdict is void, not a pass.
    expect(spreadCeiling.note).toContain('DISARMED');
    expect(spreadCeiling.note).toContain('MEANINGLESS');
  });

  it.each(['false', 'no', 'off', 'OFF'])('an explicit %s also disarms', (value) => {
    process.env[FLAG] = value;
    expect(serveCostGate().spreadCeiling.armed).toBe(false);
  });

  it('a TYPO does NOT silently disarm — only an explicit off value does', () => {
    process.env[FLAG] = 'flase';
    expect(serveCostGate().spreadCeiling.armed).toBe(true);
  });

  it('resolves through resolveDemoFlagEnv (the engine path), NOT process.env directly', () => {
    // Positive control FIRST: without it, a `spreadCeiling.armed` that ignores the
    // overlay is indistinguishable from a route that never opened the file at all.
    // ENABLE_OPTION_COST_AWARE_GATE *is* allowlisted, so if the top-level `armed`
    // flips from the file, the route demonstrably read the overlay on this call.
    tmp = mkdtempSync(join(tmpdir(), 'tra2311-'));
    writeFileSync(
      join(tmp, 'demo-flags.json'),
      JSON.stringify({ ENABLE_OPTION_COST_AWARE_GATE: '1', [FLAG]: '0' }),
      'utf8',
    );
    process.env.DATA_DIR = tmp;

    const { armed, spreadCeiling } = serveCostGate();
    expect(armed).toBe(true); // control: the overlay WAS read on this request

    // ...and now the finding this test exists to pin. The kill switch documented as
    // "demo-flags file in demo" is NOT on DEMO_FLAG_ALLOWLIST, so `loadDemoFlagFile`
    // drops it and the overlay resolves it straight through to process.env. The
    // route reports that rather than implying a file channel that does not exist —
    // an operator who "disarmed" via the file would otherwise be reading a lie.
    expect(spreadCeiling.overlayCapable).toBe(false);
    expect(spreadCeiling.armed).toBe(true);
    expect(spreadCeiling.note).toContain('NOT on DEMO_FLAG_ALLOWLIST');
    expect(spreadCeiling.note).toContain('PROCESS env');

    // The process env IS the live channel — same request shape, flag moved there.
    process.env[FLAG] = '0';
    expect(serveCostGate().spreadCeiling.armed).toBe(false);
  });

  it('reports the effective min-bid floor the engine applies, including the ""⇒0 edge', () => {
    expect(serveCostGate().spreadCeiling.minBidUsdOverride).toBeNull();
    const base = serveCostGate().spreadCeiling.perStructure.find(
      (s) => s.structure === 'single_leg_directional',
    )!;
    expect(base.minBidUsd).toBeCloseTo(0.1, 6);

    process.env[MIN_BID] = '0.25';
    const tuned = serveCostGate().spreadCeiling;
    expect(tuned.minBidUsdOverride).toBeCloseTo(0.25, 6);
    expect(
      tuned.perStructure.find((s) => s.structure === 'single_leg_directional')!.minBidUsd,
    ).toBeCloseTo(0.25, 6);

    // `Number('')` is 0 — finite and >= 0 — so an EMPTY value removes the floor in
    // the engine. Mirrored here on purpose: telemetry that hid it would report a
    // floor the entry path is not applying.
    process.env[MIN_BID] = '';
    expect(serveCostGate().spreadCeiling.minBidUsdOverride).toBe(0);
  });
});

describe('checkStaleState', () => {
  beforeEach(() => __resetAlertsForTest());

  it('fires a critical alert when market open and no fresh quotes', () => {
    const fired = checkStaleState({ marketOpen: true, trackedSymbols: 5, freshSymbols: 0 });
    expect(fired).toBe(true);
    const alerts = getRecentAlerts();
    expect(alerts.at(-1)?.key).toBe('stale-state');
    expect(alerts.at(-1)?.severity).toBe('critical');
  });

  it('does not fire when the market is closed', () => {
    expect(checkStaleState({ marketOpen: false, trackedSymbols: 5, freshSymbols: 0 })).toBe(false);
  });

  it('does not fire when at least one quote is fresh', () => {
    expect(checkStaleState({ marketOpen: true, trackedSymbols: 5, freshSymbols: 1 })).toBe(false);
  });

  it('does not fire when no symbols are tracked', () => {
    expect(checkStaleState({ marketOpen: true, trackedSymbols: 0, freshSymbols: 0 })).toBe(false);
  });

  it('throttles repeat alerts on the same key', () => {
    expect(checkStaleState({ marketOpen: true, trackedSymbols: 3, freshSymbols: 0 })).toBe(true);
    expect(checkStaleState({ marketOpen: true, trackedSymbols: 3, freshSymbols: 0 })).toBe(false);
  });
});

describe('runStaleStateCheck', () => {
  beforeEach(() => __resetAlertsForTest());

  it('raises one alert when a live engine has a stale feed', () => {
    const contexts = [
      ctx('admin', engineState({ symbols: [{ symbol: 'AAPL', price: 1, volume: 0, change: 0, changePct: 0, lastUpdated: STALE }] as never })),
    ];
    const fired = runStaleStateCheck(contexts, () => settings({ mode: 'live' }), NOW);
    expect(fired).toBe(true);
    expect(getRecentAlerts().at(-1)?.key).toBe('stale-state');
  });

  it('stays quiet when every engine has fresh quotes', () => {
    const contexts = [ctx('admin', engineState())];
    expect(runStaleStateCheck(contexts, () => settings({ mode: 'live' }), NOW)).toBe(false);
    expect(getRecentAlerts()).toHaveLength(0);
  });
});

// TRA-991 — option-trade journal readout builder.
describe('buildOptionJournalReport', () => {
  const closedRow: OptionTradeJournalRecord = {
    id: 'p1',
    openTs: NOW - 86_400_000,
    symbol: 'AAPL',
    structure: 'bull_put',
    mode: 'demo',
    ivRank: 60,
    trend: 'up',
    sentiment: 0.2,
    entryDelta: 0.2,
    entryDte: 35,
    atRiskUsd: 320,
    agentConviction: 0.7,
    outcome: 'WIN',
    closeTs: NOW,
    realizedPnlUsd: 320,
    realizedR: 1,
    exitReason: 'manual',
    holdDays: 1,
  };

  it('folds rows into the summary + learned weights and reflects the flag', () => {
    const report = buildOptionJournalReport([closedRow], NOW, true);
    expect(report.ok).toBe(true);
    expect(report.enabled).toBe(true);
    expect(report.summary.total).toBe(1);
    expect(report.summary.closed).toBe(1);
    expect(report.summary.win).toBe(1);
    expect(report.summary.realizedPnlUsd).toBe(320);
    expect(report.summary.byStructure[0]?.structure).toBe('bull_put');
    // Learned weights present (neutral until min-sample, but the digest exists).
    expect(report.weights.generatedFrom.rows).toBe(1);
    expect(report.weights.generatedFrom.resolved).toBe(1);
  });

  it('serves an empty (disabled) readout without rows', () => {
    const report = buildOptionJournalReport([], NOW, false);
    expect(report.enabled).toBe(false);
    expect(report.summary.total).toBe(0);
    expect(report.summary.byStructure).toHaveLength(0);
  });

  // TRA-1661 (TRA-1647A) — the byDelta rollup must reach the WIRE, per structure and
  // in both R bases. Without it QuantTrader cannot set the win-probability knob and
  // the cost-aware gate cannot be validated at all, so this is the load-bearing
  // contract of the ticket, not a nice-to-have.
  it('serves a per-structure byDelta block with dispersion and both R bases', () => {
    const rv = (id: string, delta: number, r: number): OptionTradeJournalRecord => ({
      ...closedRow,
      id,
      structure: 'single_leg_rv',
      entryDelta: delta,
      realizedR: r,
      realizedPnlUsd: r * 320,
    });
    const report = buildOptionJournalReport(
      [rv('a', 0.32, 0.1), rv('b', 0.34, 0.2), { ...closedRow, id: 'c' }],
      NOW,
      true,
    );

    // Sleeves are split, never pooled — they are the confound.
    const sleeves = report.summary.byDelta.map((s) => s.structure).sort();
    expect(sleeves).toEqual(['bull_put', 'single_leg_rv']);

    const rvSleeve = report.summary.byDelta.find((s) => s.structure === 'single_leg_rv')!;
    expect(rvSleeve.gateBasisValid).toBe(true);
    const band = rvSleeve.buckets.find((b) => b.bucket === '0.30-0.35')!;
    expect(band.closed).toBe(2);
    expect(band.avgRealizedR_premiumBasis).toBeCloseTo(0.15, 10);
    expect(band.avgRealizedR_gateBasis).toBeCloseTo(0.6, 10); // gate R = 4 x premium R
    expect(band.sdRealizedR_premiumBasis).not.toBeNull(); // the CI input — not optional
    expect(band.seRealizedR_premiumBasis).not.toBeNull();

    // A credit spread has no valid premium->gate conversion; it must say so rather
    // than publish a number scaled by a factor that does not apply to it.
    const spread = report.summary.byDelta.find((s) => s.structure === 'bull_put')!;
    expect(spread.gateBasisValid).toBe(false);
    expect(spread.buckets[0]!.avgRealizedR_gateBasis).toBeNull();
  });

  // TRA-1691 — the byDelta rows must reach the wire keyed on the SLEEVE
  // (`structure × entryArchetype`), not just the structure. This is the contract
  // TRA-1690's |Δ| > 0.65 ceiling verdict is graded off: on the live book that tail is
  // n=94, of which 37 are `iv-rv-buy-premium` wearing the `single_leg_rv` label. Without
  // the archetype axis on the wire, the RV long's verdict silently eats another
  // scanner's rows and QuantTrader cannot tell.
  it('serves byDelta keyed on structure x entryArchetype, scopable by sinceTs', () => {
    const tagTs = NOW - 3_600_000; // the tagging deploy boundary
    const row = (
      id: string,
      openTs: number,
      archetype: string | undefined,
      r: number,
    ): OptionTradeJournalRecord => ({
      ...closedRow,
      id,
      openTs,
      structure: 'single_leg_rv',
      entryDelta: 0.66,
      realizedR: r,
      realizedPnlUsd: r * 320,
      ...(archetype ? { entryArchetype: archetype } : {}),
    });
    const rows = [
      row('legacy', tagTs - 1000, undefined, -0.5), // pre-tagging blend
      row('rv1', tagTs + 1000, 'rv-long', -0.2),
      row('rv2', tagTs + 2000, 'rv-long', -0.4),
      row('ivrv', tagTs + 3000, 'iv-rv-buy-premium', 0.9), // a DIFFERENT sleeve, same structure
    ];

    const cumulative = buildOptionJournalReport(rows, NOW, true);
    expect(cumulative.summary.byDelta.map((c) => c.cohort).sort()).toEqual([
      'single_leg_rv::iv-rv-buy-premium',
      'single_leg_rv::rv-long',
      'single_leg_rv::unspecified',
    ]);

    // Scoped to the post-tagging cohort, `unspecified` is GONE — that is the check that
    // tagging actually took effect on the running box, and the precondition for grading
    // the tail at all (a growing `unspecified` post-deploy means tagging is broken).
    const scoped = buildOptionJournalReport(rows, NOW, true, undefined, tagTs);
    expect(scoped.sinceTs).toBe(tagTs);
    expect(scoped.summary.byDelta.map((c) => c.cohort).sort()).toEqual([
      'single_leg_rv::iv-rv-buy-premium',
      'single_leg_rv::rv-long',
    ]);

    // And the RV long's tail is ITS OWN: −0.30R premium / −1.20R gate basis. Pooled with
    // the premium buyer the same band reads +0.10R — the ceiling verdict flips sign.
    const rvLong = scoped.summary.byDelta.find((c) => c.entryArchetype === 'rv-long')!;
    const tail = rvLong.buckets.find((b) => b.bucket === '0.65-0.70')!;
    expect(tail.closed).toBe(2);
    expect(tail.avgRealizedR_premiumBasis).toBeCloseTo(-0.3, 10);
    expect(tail.avgRealizedR_gateBasis).toBeCloseTo(-1.2, 10);
  });

  // TRA-1591 — post-arm cohort filter for grading the OTM entry delta floor.
  describe('sinceTs cohort filter', () => {
    const armTs = NOW - 3_600_000; // arm boundary 1h ago
    // pre-arm low-delta bleed loser (entryDelta 0.2, well before the floor)
    const preArm: OptionTradeJournalRecord = {
      ...closedRow,
      id: 'pre',
      structure: 'single_leg_otm',
      openTs: armTs - 86_400_000,
      entryDelta: 0.2,
      outcome: 'LOSS',
      realizedPnlUsd: -100,
      realizedR: -1,
    };
    // post-arm floored winner (entryDelta 0.45 >= 0.40 by construction)
    const postArm: OptionTradeJournalRecord = {
      ...closedRow,
      id: 'post',
      structure: 'single_leg_otm',
      openTs: armTs + 60_000,
      entryDelta: 0.45,
      outcome: 'WIN',
      realizedPnlUsd: 200,
      realizedR: 1,
    };

    it('absent sinceTs → cumulative pool (regression-safe)', () => {
      const cumulative = buildOptionJournalReport([preArm, postArm], NOW, true);
      const otm = cumulative.summary.byStructure.find((s) => s.structure === 'single_leg_otm');
      expect(otm?.closed).toBe(2);
      expect(otm?.realizedPnlUsd).toBe(100); // -100 + 200
      expect(cumulative.sinceTs).toBeUndefined();
    });

    it('scopes summary.byStructure to entry openTs >= sinceTs', () => {
      const cohort = buildOptionJournalReport([preArm, postArm], NOW, true, undefined, armTs);
      const otm = cohort.summary.byStructure.find((s) => s.structure === 'single_leg_otm');
      expect(otm?.closed).toBe(1); // only the post-arm floored fill
      expect(otm?.avgR).toBe(1);
      expect(otm?.winRate).toBe(1);
      expect(otm?.realizedPnlUsd).toBe(200);
      expect(cohort.sinceTs).toBe(armTs);
      // Learned weights stay over the FULL row set — cohort filter must not perturb them.
      expect(cohort.weights.generatedFrom.rows).toBe(2);
    });
  });

  // ── TRA-3380 (TRA-2665) ───────────────────────────────────────────────────
  //
  // TWO fail-opens on the same param, both measured live on `eb1dcf0c` 2026-08-12.
  //
  //   sent                          appliedSinceTs   summary.total   deskRowCount
  //   (none)                        null             2689            158
  //   2026-07-24T12:39:00Z (ISO)    null             2689            158   <-- dropped
  //   not-a-timestamp (garbage)     null             2689            158   <-- dropped
  //   1784896740000 (epoch ms)      1784896740000     330             61   <-- works
  //   1784896740   (epoch SECONDS)  1784896740       2689            158   <-- WORST
  //
  // Every unparseable value returned 200 with a payload byte-identical in
  // POPULATION to the unfiltered one. The epoch-seconds row is the dangerous
  // one: the echo comes back NON-NULL, so the obvious "was my filter applied?"
  // assertion PASSES while the filter resolves to 1970 and selects everything.
  describe('cohort param parsing fails CLOSED (TRA-3380)', () => {
    // The probe table above, as a test table. Each row is a value that used to
    // return 200 + the full pool.
    const rejected: Array<[label: string, sent: unknown, expectedError: string]> = [
      ['ISO-8601 with Z', '2026-07-24T12:39:00Z', 'sinceTs_not_epoch_ms'],
      ['ISO-8601 with ms', '2026-07-24T12:39:00.000Z', 'sinceTs_not_epoch_ms'],
      ['ISO-8601 local (no Z)', '2026-07-24T12:39:00', 'sinceTs_not_epoch_ms'],
      ['date only', '2026-07-24', 'sinceTs_not_epoch_ms'],
      ['garbage', 'not-a-timestamp', 'sinceTs_not_epoch_ms'],
      ['epoch SECONDS', '1784896740', 'sinceTs_below_min'],
      ['zero (a real epoch, but not a cohort)', '0', 'sinceTs_below_min'],
      ['negative', '-1784896740000', 'sinceTs_not_epoch_ms'],
      ['float', '1784896740000.5', 'sinceTs_not_epoch_ms'],
      ['empty value', '', 'sinceTs_empty'],
      ['whitespace only', '   ', 'sinceTs_empty'],
      ['far future (not ms)', '99999999999999999', 'sinceTs_not_epoch_ms'],
      ['repeated param', ['1784896740000', '1784896750000'], 'sinceTs_repeated'],
    ];

    it.each(rejected)('rejects %s', (_label, sent, expectedError) => {
      const parsed = parseCohortTsParam(sent, 'sinceTs');
      expect(parsed.ok).toBe(false);
      expect((parsed as { error: string }).error).toBe(expectedError);
    });

    // BOTH directions. A parser that rejects everything would pass every test
    // above and be just as useless as one that accepts everything — the epoch-ms
    // value from the live probe table must still be ACCEPTED, unchanged.
    it('accepts the epoch-ms value that the live probe proved discriminating', () => {
      expect(parseCohortTsParam('1784896740000', 'sinceTs')).toEqual({
        ok: true,
        value: 1784896740000,
      });
      // and surrounding whitespace is not a reason to fail closed
      expect(parseCohortTsParam(' 1784896740000 ', 'sinceTs')).toEqual({
        ok: true,
        value: 1784896740000,
      });
      // absent stays absent — this is the cumulative-pool path, unchanged
      expect(parseCohortTsParam(undefined, 'sinceTs')).toEqual({ ok: true, value: undefined });
    });

    // The epoch-seconds rejection must NAME the corrected value. That row is the
    // one a caller cannot self-diagnose: it looked like it worked.
    it('the epoch-seconds error states the corrected ms value and what it used to select', () => {
      const parsed = parseCohortTsParam('1784896740', 'sinceTs') as { detail: string };
      expect(parsed.detail).toContain('1784896740000');
      expect(parsed.detail).toContain('epoch SECONDS');
      expect(parsed.detail).toContain('ENTIRE pool');
    });

    it('the ISO error hands back the epoch-ms conversion instead of just refusing', () => {
      const parsed = parseCohortTsParam('2026-07-24T12:39:00Z', 'sinceTs') as { detail: string };
      expect(parsed.detail).toContain(String(Date.parse('2026-07-24T12:39:00Z')));
    });

    // The route leg: a rejected filter must serve NO body. The whole defect is
    // that a 200 carrying the full pool is indistinguishable from a filter that
    // selected everything, so returning the payload alongside an error field
    // would not fix it.
    it('the route answers 400 with no journal payload, for both axes', async () => {
      for (const [param, value] of [
        ['sinceTs', '2026-07-24T12:39:00Z'],
        ['sinceTs', '1784896740'],
        ['closedSinceTs', 'not-a-timestamp'],
        ['closeTs', '2026-07-24'],
      ] as const) {
        const { app, routes } = fakeApp();
        registerLiveHealthRoutes(app, {
          requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
          userCtx: async () => ctx('admin', engineState()),
          getSettings: () => settings(),
          now: () => NOW,
        });
        const res = fakeRes();
        await routes.get('/api/health/option-journal')![0]!({ query: { [param]: value } }, res);

        expect(res.statusCode).toBe(400);
        const body = res.body as Record<string, unknown>;
        expect(body['ok']).toBe(false);
        expect(body['filterApplied']).toBe(false);
        // None of the population fields a grader reads may be present.
        for (const leaked of ['summary', 'deskRowCount', 'appliedSinceTs', 'rows']) {
          expect(body).not.toHaveProperty(leaked);
        }
      }
    });

    it('rejects both axes at once so filterAxis is never ambiguous', async () => {
      const { app, routes } = fakeApp();
      registerLiveHealthRoutes(app, {
        requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
        userCtx: async () => ctx('admin', engineState()),
        getSettings: () => settings(),
        now: () => NOW,
      });
      const res = fakeRes();
      await routes.get('/api/health/option-journal')![0]!(
        { query: { sinceTs: '1784896740000', closedSinceTs: '1784896740000' } },
        res,
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe('cohort_axis_conflict');
    });

    // The other direction at the ROUTE level: a valid param must still be served
    // 200. Without this, "the route 400s" would pass on a route that 400s always.
    it('still serves 200 for a valid epoch-ms sinceTs and for no param at all', async () => {
      const { app, routes } = fakeApp();
      registerLiveHealthRoutes(app, {
        requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
        userCtx: async () => ctx('admin', engineState()),
        getSettings: () => settings(),
        now: () => NOW,
      });
      for (const query of [{}, { sinceTs: '1784896740000' }]) {
        const res = fakeRes();
        await routes.get('/api/health/option-journal')![0]!({ query }, res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('summary');
      }
    });
  });

  // TRA-3380 defect 2 — an ENTRY-axis filter cannot scope an EXIT-scoped
  // criterion, and on the live book it empties the criterion's own cell.
  //
  // TRA-2213 leg 2 grades `single_leg_otm × sl` closes that ran under the
  // TRA-2200 checkExits hoist (armed 2026-07-24T12:39Z). All four of those
  // closes were OPENED pre-arm and CLOSED post-arm, so:
  //   - at `sinceTs=<arm>` (entry axis) the cell is ABSENT — n=0, ungradable
  //   - unfiltered, the cell mixes PRE-hoist exits into a POST-hoist criterion,
  //     manufacturing a FAIL and attributing it to the hoist
  // Both readings are wrong, in opposite directions. The fixture below is
  // asserted to straddle the boundary so it cannot pass in the broken state.
  describe('closeTs cohort axis (TRA-3380)', () => {
    const armTs = NOW - 3_600_000;
    const otm = (
      id: string,
      openTs: number,
      closeTs: number | undefined,
      r: number,
    ): OptionTradeJournalRecord => {
      const row: OptionTradeJournalRecord = {
        ...closedRow,
        id,
        // `closedRow` carries no `account`, which classes as `unattributed`, not
        // `desk` — and the criterion this axis exists for reads the DESK cell.
        account: 'admin',
        structure: 'single_leg_otm',
        exitReason: 'sl',
        openTs,
        closeTs,
        outcome: closeTs === undefined ? 'OPEN' : 'LOSS',
        realizedR: r,
        realizedPnlUsd: r * 100,
      };
      // An OPEN row has no close economics at all. Spreading `closedRow` leaves
      // its `closeTs` behind, and a row that is `outcome: OPEN` *and* carries a
      // `closeTs` would pass the exit-axis filter — the fixture would then prove
      // the opposite of what it claims.
      if (closeTs === undefined) delete row.closeTs;
      return row;
    };

    // The TRA-2213 shape: opened pre-arm, closed post-arm.
    const straddler = otm('opened-pre-closed-post', armTs - 86_400_000, armTs + 60_000, -0.44);
    // A genuinely pre-hoist close — the row the unfiltered read wrongly includes.
    const preHoist = otm('closed-pre', armTs - 172_800_000, armTs - 86_400_000, -1.2);
    // A post-arm entry AND close — selectable on either axis.
    const postBoth = otm('both-post', armTs + 30_000, armTs + 90_000, -0.6);
    // Still open — carries no closeTs at all.
    const open = otm('still-open', armTs + 40_000, undefined, 0);
    const rows = [straddler, preHoist, postBoth, open];

    it('the fixture straddles the boundary on BOTH axes (control)', () => {
      // Without this the test below could pass in the broken state.
      expect(rows.filter((r) => r.openTs >= armTs)).toHaveLength(2);
      expect(rows.filter((r) => (r.closeTs ?? -1) >= armTs)).toHaveLength(2);
      // and the two axes must select DIFFERENT sets, or the axis is untestable
      expect(rows.filter((r) => r.openTs >= armTs).map((r) => r.id)).not.toEqual(
        rows.filter((r) => (r.closeTs ?? -1) >= armTs).map((r) => r.id),
      );
    });

    it('the entry axis DROPS the straddler — the defect, pinned', () => {
      const entry = buildOptionJournalReport(rows, NOW, true, undefined, armTs);
      expect(entry.filterAxis).toBe('openTs');
      expect(entry.summary.closed).toBe(1); // only postBoth; the straddler is gone
    });

    it('the exit axis SELECTS the straddler and excludes the pre-hoist close', () => {
      const exit = buildOptionJournalReport(rows, NOW, true, undefined, undefined, false, armTs);
      expect(exit.filterAxis).toBe('closeTs');
      expect(exit.closedSinceTs).toBe(armTs);
      expect(exit.appliedClosedSinceTs).toBe(armTs);
      expect(exit.closeAxisExcludesOpenRows).toBe(true);
      // straddler + postBoth; NOT preHoist (closed before the arm), NOT open.
      expect(exit.summary.closed).toBe(2);
      const cell = exit.summary.byAccountClass.desk.byStructureExit.cells.find(
        (c) => c.structure === 'single_leg_otm' && c.exitReason === 'sl',
      );
      expect(cell?.closed).toBe(2);
    });

    it('an OPEN row can never satisfy the exit axis', () => {
      const exit = buildOptionJournalReport([open], NOW, true, undefined, undefined, false, armTs);
      expect(exit.summary.total).toBe(0);
    });

    // Both directions, at the fold: the axis must be able to reduce to EMPTY and
    // to select EVERYTHING. A filter that only ever reduces to the same set is
    // indistinguishable from one that is not applied at all — which is the
    // defect this ticket exists to fix.
    it('the exit axis discriminates in both directions', () => {
      const future = buildOptionJournalReport(rows, NOW, true, undefined, undefined, false, NOW + 1);
      expect(future.summary.total).toBe(0);

      // `1`, not the real epoch-ms floor: these fixtures use the file's synthetic
      // NOW (2e9), which predates it. The floor is enforced by the PARSER, which
      // is graded separately above; this leg grades the FOLD.
      const ancient = buildOptionJournalReport(rows, NOW, true, undefined, undefined, false, 1);
      // every CLOSED row, and only those (the open row has no closeTs)
      expect(ancient.summary.total).toBe(3);
    });
  });

  // TRA-3380 acceptance 2, the half the CFO called "the half that matters":
  // `openTs` behaviour is BYTE-UNCHANGED for existing consumers. The new keys
  // must be ABSENT — not null, not false — unless the exit axis was requested.
  describe('openTs behaviour is byte-unchanged (TRA-3380)', () => {
    const NEW_KEYS = ['closedSinceTs', 'appliedClosedSinceTs', 'closeAxisExcludesOpenRows'];

    it('the cumulative payload gains no key and keeps filterAxis openTs', () => {
      const report = buildOptionJournalReport([closedRow], NOW, true);
      expect(report.filterAxis).toBe('openTs');
      expect(report.appliedSinceTs).toBeNull();
      for (const k of NEW_KEYS) expect(report).not.toHaveProperty(k);
      // asserted on the SERIALISED body, because "absent" and "present and
      // undefined" are the same under toHaveProperty but differ on the wire.
      const wire = JSON.stringify(report);
      for (const k of NEW_KEYS) expect(wire).not.toContain(k);
    });

    it('the sinceTs payload gains no key either', () => {
      const report = buildOptionJournalReport([closedRow], NOW, true, undefined, NOW - 1000);
      expect(report.filterAxis).toBe('openTs');
      for (const k of NEW_KEYS) expect(report).not.toHaveProperty(k);
      expect(JSON.stringify(report)).not.toContain('closeAxisExcludesOpenRows');
    });

    // The strongest available statement of "unchanged": passing the new 7th
    // argument as `undefined` — which is all any pre-existing caller can do —
    // must produce output IDENTICAL to omitting it.
    it('passing the new param as undefined is identical to omitting it', () => {
      const rows = [closedRow];
      for (const since of [undefined, NOW - 1000]) {
        const omitted = buildOptionJournalReport(rows, NOW, true, undefined, since, 'all');
        const explicit = buildOptionJournalReport(rows, NOW, true, undefined, since, 'all', undefined);
        expect(JSON.stringify(explicit)).toBe(JSON.stringify(omitted));
      }
    });
  });

  // TRA-2082 — `sinceTs` scoped `summary` but NOT the `?rows=demo` dump, so one 200
  // carried two populations with nothing on the wire marking the difference. That is
  // the false-PASS shape: a TRA-1585 delta-floor grade counting `rows` under a
  // `sinceTs` reads n=1035/+0.0173R (PASS, auto-unblocks TRA-1407) where the truthful
  // cohort is n=10.
  //
  // Per TRA-2076 the assertion is on the COVERAGE COUNTS, not the verdict: a fixture
  // with zero rows outside the boundary passes a naive version of this test in BOTH
  // the fixed and broken states, so the fixture below is asserted to straddle it.
  describe('sinceTs applies to the rows dump, not just the summary (TRA-2082)', () => {
    const armTs = NOW - 3_600_000;
    const otm = (id: string, openTs: number, r: number): OptionTradeJournalRecord => ({
      ...closedRow,
      id,
      openTs,
      structure: 'single_leg_otm',
      outcome: r > 0 ? 'WIN' : 'LOSS',
      realizedR: r,
      realizedPnlUsd: r * 320,
    });
    // 3 pre-arm, 2 post-arm. The pre-arm side is deliberately the LARGER and the
    // opposite-signed one, so the broken (unfiltered-rows) build reads a different
    // count AND a different avgR — the two states cannot look alike.
    const rows = [
      otm('pre1', armTs - 86_400_000, -1),
      otm('pre2', armTs - 72_000_000, -1),
      otm('pre3', armTs - 60_000_000, -1),
      otm('post1', armTs + 60_000, 1),
      otm('post2', armTs + 120_000, 1),
    ];
    // An OPEN row and a live-mode row: the dump's own filters must survive the change.
    const excluded = [
      { ...otm('open', armTs + 90_000, 0), outcome: 'OPEN' as const },
      { ...otm('live', armTs + 95_000, 1), mode: 'live' as const },
    ];

    it('fixture straddles the boundary (guards the test itself)', () => {
      expect(rows.filter((r) => r.openTs < armTs)).toHaveLength(3);
      expect(rows.filter((r) => r.openTs >= armTs)).toHaveLength(2);
    });

    it('rows and summary.closed describe the SAME population under sinceTs', () => {
      const report = buildOptionJournalReport(rows, NOW, true, undefined, armTs, true);
      const otmSummary = report.summary.byStructure.find(
        (s) => s.structure === 'single_leg_otm',
      );

      // The load-bearing assertion: the two halves agree on n.
      expect(report.rows).toHaveLength(2);
      expect(otmSummary?.closed).toBe(2);
      expect(report.rows).toHaveLength(otmSummary!.closed);

      // ...and on the number a gate would actually read. Broken build: n=5, avgR −0.2.
      expect(otmSummary?.avgR).toBe(1);
      expect(report.rows!.map((r) => r.id).sort()).toEqual(['post1', 'post2']);

      // The applied filter is on the wire, so a consumer asserts instead of assuming.
      expect(report.appliedSinceTs).toBe(armTs);
      expect(report.filterAxis).toBe('openTs');
      expect(report.rowsFiltered).toBe(true);
      expect(report.rowsMode).toBe('demo');
    });

    it('without sinceTs the dump is the cumulative pool and says so', () => {
      const report = buildOptionJournalReport(rows, NOW, true, undefined, undefined, true);
      const otmSummary = report.summary.byStructure.find(
        (s) => s.structure === 'single_leg_otm',
      );
      expect(report.rows).toHaveLength(5);
      expect(report.rows).toHaveLength(otmSummary!.closed);
      // `null`, not `0` — `0` is a real epoch and would read as a filter that applied.
      expect(report.appliedSinceTs).toBeNull();
      expect(report.rowsFiltered).toBe(false);
    });

    // The SECOND population axis, found while writing the test above. `rows` is
    // demo-and-resolved; `summary` folds BOTH modes. So the two halves agree on the
    // sinceTs cohort but NOT on mode, and `rows.length === summary.closed` is a
    // coincidence of an all-demo book, not a contract. `rowsMode` says so on the wire
    // rather than leaving the next consumer to rediscover it the hard way.
    it('rows stays demo-and-resolved while summary spans both modes — stated, not hidden', () => {
      const report = buildOptionJournalReport(
        [...rows, ...excluded],
        NOW,
        true,
        undefined,
        armTs,
        true,
      );
      const otmSummary = report.summary.byStructure.find(
        (s) => s.structure === 'single_leg_otm',
      );

      // Both post-arm exclusions are inside the sinceTs cohort, so this gap is the
      // MODE/OPEN axis alone — not a filter leak.
      expect(report.rows!.map((r) => r.id).sort()).toEqual(['post1', 'post2']);
      expect(report.rows!.every((r) => r.mode === 'demo' && r.outcome !== 'OPEN')).toBe(true);
      // summary counts the live close too: 2 demo + 1 live = 3, vs 2 rows.
      expect(otmSummary?.closed).toBe(3);
      expect(report.rows).toHaveLength(2);
      expect(report.rowsMode).toBe('demo');
    });

    it('omits rows entirely when the dump was not requested', () => {
      const report = buildOptionJournalReport(rows, NOW, true, undefined, armTs);
      expect(report.rows).toBeUndefined();
      // `rowsFiltered` is absent WITH `rows` — the pair can never be read apart.
      expect(report.rowsFiltered).toBeUndefined();
      expect(report.appliedSinceTs).toBe(armTs);
    });
  });
});

// TRA-1656 (TRA-1602B) — the MEASURED option spread cross probe. Drives the real
// registered route against a real (temp-file) journal so the whole path is
// exercised: quote retention -> per-structure rollup -> retention statement.
describe('GET /api/health/option-spread-cost (TRA-1656)', () => {
  const JOURNAL = join(tmpdir(), `tra1656-spread-${Date.now()}.jsonl`);

  beforeEach(() => {
    process.env[OPTION_TRADE_JOURNAL_FLAG] = '1';
    setOptionTradeJournalFileForTests(JOURNAL);
  });
  afterEach(async () => {
    delete process.env[OPTION_TRADE_JOURNAL_FLAG];
    setOptionTradeJournalFileForTests(null);
    await rm(JOURNAL, { force: true });
  });

  function probe() {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    return routes.get('/api/health/option-spread-cost')!;
  }

  const openRow = (
    id: string,
    structure: string,
    quote: { entryBid: number; entryAsk: number; entryMarkUsd: number } | null,
  ): OptionTradeJournalOpen => ({
    id,
    openTs: NOW,
    symbol: 'AAPL',
    structure,
    mode: 'demo',
    ivRank: 50,
    trend: 'up',
    sentiment: null,
    sentimentIcBand: null,
    entryDelta: 0.4,
    entryDte: 30,
    atRiskUsd: 200,
    contracts: 1,
    optionSymbol: 'AAPL260529C00200000',
    ...(quote ?? {}),
  });

  it('is unauthenticated (secrets-free probe, one handler)', () => {
    expect(probe()).toHaveLength(1);
  });

  it('states the RETENTION GAP explicitly when no row carries a fill-time quote', async () => {
    // Pre-TRA-1656 rows: mark only, no bid/ask. This is the 2,153-trade history.
    await recordOptionTradeOpen(openRow('legacy-1', 'single_leg_rv', null));
    await recordOptionTradeOpen(openRow('legacy-2', 'single_leg_otm', null));

    const res = fakeRes();
    await probe()[0]!({}, res);
    const body = res.body as {
      n: number;
      byStructure: unknown[];
      retention: { rowsTotal: number; rowsWithFillTimeQuote: number; statement: string };
    };

    // The acceptance bar's escape hatch: say so, rather than report a fake number.
    expect(body.n).toBe(0);
    expect(body.byStructure).toEqual([]);
    expect(body.retention.rowsTotal).toBe(2);
    expect(body.retention.rowsWithFillTimeQuote).toBe(0);
    expect(body.retention.statement).toContain('NOT RETAINED');
  });

  it('MEASURES avgSpreadCrossR per structure once rows retain a fill-time quote', async () => {
    // RV: $2.00 mark, $0.12 spread => spreadPct 6% => crossR = 4 × 0.06 = 0.24R.
    await recordOptionTradeOpen(
      openRow('rv-1', 'single_leg_rv', { entryBid: 1.94, entryAsk: 2.06, entryMarkUsd: 2.0 }),
    );
    // OTM: $1.00 mark, $0.10 spread => spreadPct 10% => crossR = 0.40R.
    await recordOptionTradeOpen(
      openRow('otm-1', 'single_leg_otm', { entryBid: 0.95, entryAsk: 1.05, entryMarkUsd: 1.0 }),
    );
    // A legacy row with no quote must DROP OUT, not dilute the mean toward zero.
    await recordOptionTradeOpen(openRow('legacy-3', 'single_leg_rv', null));

    const res = fakeRes();
    await probe()[0]!({}, res);
    const body = res.body as {
      n: number;
      byStructure: Array<{
        structure: string;
        n: number;
        avgSpreadCrossR: number;
        avgCommissionR: number | null;
        impliedBarR: number;
      }>;
      modeledInput: { makerAdjustedSpreadCrossR: number; barR: number };
      retention: { rowsTotal: number; rowsWithFillTimeQuote: number };
    };

    expect(body.n).toBe(2);
    expect(body.retention.rowsTotal).toBe(3); // the legacy row is counted but not measured
    expect(body.retention.rowsWithFillTimeQuote).toBe(2);

    const rv = body.byStructure.find((s) => s.structure === 'single_leg_rv')!;
    const otm = body.byStructure.find((s) => s.structure === 'single_leg_otm')!;
    expect(rv.n).toBe(1); // NOT 2 — the quote-less row dropped out
    expect(rv.avgSpreadCrossR).toBeCloseTo(0.24, 6);
    expect(otm.avgSpreadCrossR).toBeCloseTo(0.4, 6);

    // TRA-1661 — the gate now ships the MEASURED cross (0.235R, TRA-1656) rather
    // than the refuted 1.00R model, so the probe's headline comparison is no longer
    // "measurement vs phantom" but "measurement vs the input it produced". Pinning
    // the shipped input here is what makes a silent revert to 1.00R fail a test.
    expect(body.modeledInput.makerAdjustedSpreadCrossR).toBe(0.235);
    expect(body.modeledInput.barR).toBeCloseTo(0.485, 3);
    // impliedBarR is re-derived from the MEASUREMENT (measured commission + measured
    // cross + margin), not from the config's cost inputs — that independence is the
    // whole point of the probe, and is what lets it re-falsify the gate if the two
    // ever drift apart.
    expect(rv.impliedBarR).toBeCloseTo((rv.avgCommissionR ?? 0.05) + rv.avgSpreadCrossR + 0.2, 6);
  });

  it('publishes the selection-independent ceilings, and the shipped input now sits under them', async () => {
    const res = fakeRes();
    await probe()[0]!({}, res);
    const body = res.body as {
      modeledInput: { makerAdjustedSpreadCrossR: number };
      ceilings: Record<string, { maxSpreadCrossR?: number }>;
    };
    // The bound holds with no fills at all — it is what refuted the old 1.00R input
    // at n=0. TRA-1661's replacement (0.235R) sits under BOTH ceilings, i.e. it is
    // feasible: it never charges more than the worst contract the scanner can pick.
    expect(body.ceilings['single_leg_otm']!.maxSpreadCrossR).toBe(0.8);
    expect(body.ceilings['single_leg_rv']!.maxSpreadCrossR).toBe(0.4);
    expect(body.modeledInput.makerAdjustedSpreadCrossR).toBeLessThan(0.4);
  });
});

// TRA-2316 — the DESK-PARTITIONED per-row spread read (TRA-2306 read #2).
//
// Drives the real registered route against a real temp-file journal, because the
// account classification (`isTestAccount` -> desk / fixture / unattributed) lives in
// the ROUTE, not in the pure fold. `option-spread-cost.test.ts` pins the fold's
// arithmetic; only reading the served body settles whether the desk partition
// actually excludes the qa_* mirror.
describe('GET /api/health/option-spread-cost — TRA-2316 ceilingCompliance', () => {
  const JOURNAL = join(tmpdir(), `tra2316-ceiling-${Date.now()}.jsonl`);
  const ARM_TS = NOW - 60_000;

  beforeEach(() => {
    process.env[OPTION_TRADE_JOURNAL_FLAG] = '1';
    setOptionTradeJournalFileForTests(JOURNAL);
  });
  afterEach(async () => {
    delete process.env[OPTION_TRADE_JOURNAL_FLAG];
    setOptionTradeJournalFileForTests(null);
    await rm(JOURNAL, { force: true });
  });

  const row = (
    id: string,
    account: string | undefined,
    quote: { entryBid: number; entryAsk: number; entryMarkUsd: number } | null,
    openTs = NOW,
  ): OptionTradeJournalOpen => ({
    id,
    openTs,
    symbol: 'AAPL',
    structure: 'single_leg_directional',
    mode: 'demo',
    ivRank: 50,
    trend: 'up',
    sentiment: null,
    sentimentIcBand: null,
    entryDelta: 0.4,
    entryDte: 30,
    atRiskUsd: 200,
    contracts: 1,
    optionSymbol: 'AAPL260529C00200000',
    ...(account === undefined ? {} : { account }),
    ...(quote ?? {}),
  });

  type Cell = {
    structure: string;
    accountClass: string;
    n: number;
    rowsDroppedNoQuote: number;
    maxSpreadPct: number | null;
    countAboveCeiling: number | null;
    minEntryBidUsd: number | null;
    countBelowMinBid: number | null;
  };
  type Body = {
    appliedSinceTs: number | null;
    filterAxis: string;
    ceilingCompliance: { byAccountClass: Record<string, Cell[]> };
  };

  async function body(query?: Record<string, string>): Promise<Body> {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const res = fakeRes();
    await routes.get('/api/health/option-spread-cost')![0]!(
      query === undefined ? {} : { query },
      res,
    );
    return res.body as Body;
  }

  const cell = (b: Body, klass: string): Cell =>
    b.ceilingCompliance.byAccountClass[klass]!.find(
      (c) => c.structure === 'single_leg_directional',
    )!;

  it('answers the TRA-2306 question in ONE request: desk n / maxSpreadPct / countAboveCeiling / countBelowMinBid', async () => {
    // One clean desk fill: 0.10 spread on a 2.00 mark = 5%, inside the 0.10 ceiling.
    await recordOptionTradeOpen(
      row('desk-clean', 'admin', { entryBid: 1.95, entryAsk: 2.05, entryMarkUsd: 2.0 }),
    );
    const desk = cell(await body(), 'desk');
    expect(desk.n).toBe(1);
    expect(desk.maxSpreadPct).toBeCloseTo(0.05, 10);
    expect(desk.countAboveCeiling).toBe(0);
    expect(desk.countBelowMinBid).toBe(0);
  });

  it('FIRES on a desk breach — the failing state the old read did not have', async () => {
    // bid 0.01 / ask 0.59 on a 0.30 mark = spreadPct 1.933, the worst contract
    // TRA-2295 found admitted. Under the previous route this row was invisible:
    // the projection with the `account` axis carried no quotes, so the check
    // computed NaN and reported "0 above the ceiling" for it.
    await recordOptionTradeOpen(
      row('desk-breach', 'Richard', { entryBid: 0.01, entryAsk: 0.59, entryMarkUsd: 0.3 }),
    );
    const desk = cell(await body(), 'desk');
    expect(desk.n).toBe(1);
    expect(desk.countAboveCeiling).toBe(1);
    expect(desk.maxSpreadPct).toBeGreaterThan(0.1);
    expect(desk.countBelowMinBid).toBe(1); // the ADMITTED side, not just a reject counter
  });

  it('EXCLUDES qa_*/ctoverify* fixture books from the desk partition (TRA-2100 mirror trap)', async () => {
    await recordOptionTradeOpen(
      row('desk-clean', 'admin', { entryBid: 1.95, entryAsk: 2.05, entryMarkUsd: 2.0 }),
    );
    // The same economic trade mirrored into two fixture books at a breaching
    // spread. Bit-identical but id-DISTINCT, so id-dedupe finds nothing; `account`
    // is the only axis that separates them.
    await recordOptionTradeOpen(
      row('qa-mirror-1', 'qa_mirror_2316', { entryBid: 0.01, entryAsk: 0.59, entryMarkUsd: 0.3 }),
    );
    await recordOptionTradeOpen(
      row('cto-mirror-1', 'ctoverify_2316', { entryBid: 0.01, entryAsk: 0.59, entryMarkUsd: 0.3 }),
    );
    // Pre-TRA-1475: no `account` at all. NOT desk.
    await recordOptionTradeOpen(
      row('legacy-1', undefined, { entryBid: 0.5, entryAsk: 0.9, entryMarkUsd: 0.7 }),
    );

    const b = await body();
    const desk = cell(b, 'desk');
    const fixture = cell(b, 'fixture');
    const unattributed = cell(b, 'unattributed');

    // Pooled, this book reads 4 rows and a 1.933 max and falsely falsifies the gate.
    expect(desk.n).toBe(1);
    expect(desk.countAboveCeiling).toBe(0);
    expect(fixture.n).toBe(2);
    expect(fixture.countAboveCeiling).toBe(2);
    expect(unattributed.n).toBe(1);
    expect(unattributed.countAboveCeiling).toBe(1);
  });

  it('an empty desk partition reads n:0 / null — NOT countAboveCeiling 0', async () => {
    // Only a fixture row exists. The desk cell must still be PRESENT (an absent
    // cell reads exactly like a passing one) and must say it has no reading.
    await recordOptionTradeOpen(
      row('qa-only', 'qa_reg_2316', { entryBid: 1.95, entryAsk: 2.05, entryMarkUsd: 2.0 }),
    );
    const desk = cell(await body(), 'desk');
    expect(desk).toBeDefined();
    expect(desk.n).toBe(0);
    expect(desk.maxSpreadPct).toBeNull();
    expect(desk.countAboveCeiling).toBeNull();
    expect(desk.countBelowMinBid).toBeNull();
  });

  // TRA-2319 — THE FALSE PASS THE `toBeNull()` ASSERT ABOVE DOES NOT CATCH.
  //
  // The test above pins the VALUE (`null`). It does not pin what a consumer DOES with
  // it, and the obvious thing to do with a spread max is compare it to the ceiling —
  // at which point JavaScript coerces `null` to 0 under relational comparison and
  // `null <= 0.10` is **true**. So the empty-partition sentinel is swallowed by the
  // one predicate every reader reaches for, and a desk book that opened NOTHING reads
  // as a clean pass. (`undefined <= 0.10` is false, so the two absent-ish values do
  // NOT behave alike — which is exactly why "it's nullish, the comparison will fail"
  // is wrong here.) Same false-zero class as TRA-2295 and TRA-2302.
  //
  // This test asserts the hazard EXISTS rather than assuming it away, so that anyone
  // who later "simplifies" a grader to a bare `<=` has a red test explaining why not,
  // and it pins the safe predicate — gate on `n`, compare `countAboveCeiling` with
  // `===` — as the contract.
  it('the empty-partition null is SWALLOWED by `<= ceiling` — grade on n, not on the max', async () => {
    await recordOptionTradeOpen(
      row('qa-only', 'qa_reg_2319', { entryBid: 1.95, entryAsk: 2.05, entryMarkUsd: 2.0 }),
    );
    const desk = cell(await body(), 'desk');
    expect(desk.n).toBe(0);

    // THE HAZARD, stated as an assertion. Both nullable fields read "compliant" under
    // the naive comparison, on a cell that measured nothing at all.
    expect(desk.maxSpreadPct! <= 0.1).toBe(true); // ← the false PASS
    expect(desk.countAboveCeiling! <= 0).toBe(true); // ← and so does the breach count
    // Not a general nullish quirk — `undefined` would have failed the same compare,
    // so a reader cannot reason "absent values don't pass comparisons".
    expect((undefined as unknown as number) <= 0.1).toBe(false);

    // THE SAFE PREDICATE, which the route note instructs and the grader uses.
    const passes = desk.n > 0 && desk.countAboveCeiling === 0;
    expect(passes).toBe(false);

    // And with real rows the same predicate still has both states, so it is a gate
    // and not a constant `false`.
    await recordOptionTradeOpen(
      row('desk-clean', 'admin', { entryBid: 1.95, entryAsk: 2.05, entryMarkUsd: 2.0 }),
    );
    const withRows = cell(await body(), 'desk');
    expect(withRows.n > 0 && withRows.countAboveCeiling === 0).toBe(true);
  });

  it('the payload NOTE warns about the `<=` swallow — a rule that lives only in a ticket is not in the reader path', async () => {
    const b = (await body()) as unknown as { ceilingCompliance: { note: string } };
    const note = String(b.ceilingCompliance.note);
    expect(note).toContain('null <= 0.10');
    expect(note).toContain('gated.n > 0');
    expect(note).toContain('TRA-2319');
  });

  // TRA-2306 — the SIBLING string, one line below the note TRA-2319 just swept.
  //
  // `comparisonBasis` is the instruction the TRA-2306 grader executes at the Monday
  // 20:20Z read, and it carried three defects that all pushed the same way:
  //
  //   1. it named a BARE `byStructure[]`, and the cost-aware-gate payload has two
  //      objects by that name — the top-level one is the current ET day only and is
  //      `[]` on a quiet day, so the cross-check silently ran against nothing;
  //   2. it asserted the two sides "should track" each other. TRA-2350 fixed the
  //      ARCHETYPE half of that claim and left the ACCOUNT half: the gate tally is one
  //      module-level counter per PROCESS with no account axis, so it pools the whole
  //      demo fleet, while `desk[...].gated` is desk-only. Pooled vs desk-only cannot
  //      track, and the pooled side is strictly the larger;
  //   3. it pre-attributed any disagreement to "a lost counter rather than a lost
  //      fill" on the premise that the gate counters are in-memory and one-day. That
  //      premise is false here — `ephemeral` is false and the hydrate re-applies every
  //      record inside the retention window with no exclude-today filter — and a LOST
  //      FILL is precisely the falsification TRA-2306 exists to catch. A note that
  //      talks the grader out of the failing reading is worse than a silent one.
  it('comparisonBasis QUALIFIES byStructure, and does not claim pooled/desk-only track', async () => {
    const b = (await body()) as unknown as { ceilingCompliance: { comparisonBasis: string } };
    const basis = String(b.ceilingCompliance.comparisonBasis);

    // (1) the qualifier is present, and the ambiguous bare form is gone.
    expect(basis).toContain('retained.byStructure');
    expect(basis).toContain('TWO objects named `byStructure`');
    expect(basis).not.toMatch(/(?<!retained\.)\bbyStructure\[\]\.maxAdmittedSpreadPct/);

    // (2) the account-axis mismatch is stated, with the direction of the inequality —
    // a grader who knows only "they differ" still cannot tell benign from breach.
    expect(basis).toContain('NO account axis');
    expect(basis).toContain('maxAdmittedSpreadPct >= desk gated max');
    expect(basis).toContain('TRA-2355');

    // (3) the dead premise is GONE, not merely contradicted further down. Leaving it
    // in and appending a correction is how the old rationale keeps getting cited.
    expect(basis).not.toContain('more likely a lost counter than a lost fill');
    expect(basis).not.toMatch(/counters are one-day and in-memory/);
    expect(basis).toContain('A lost FILL is the falsification');
    expect(basis).toContain('TRA-2306');
  });

  // The hazard behind (2), asserted rather than assumed — pooled >= desk-only holds by
  // construction, so a grader treating "pooled max exceeds the desk max" as evidence of
  // a breach is reading a guarantee as a defect.
  it('the pooled gate counter cannot be compared like-for-like with a desk-only max', async () => {
    // A desk row inside the ceiling, and a fixture row outside it. The gate tally sees
    // both (no account axis); `desk[...].gated` sees only the first.
    await recordOptionTradeOpen(
      row('desk-inside', 'admin', { entryBid: 1.95, entryAsk: 2.05, entryMarkUsd: 2.0 }),
    );
    await recordOptionTradeOpen(
      row('fixture-wide', 'qa_mirror_1', { entryBid: 0.2, entryAsk: 0.8, entryMarkUsd: 0.5 }),
    );
    const desk = cell(await body(), 'desk');
    const fixture = cell(await body(), 'fixture');

    // The desk side is clean...
    expect(desk.n).toBeGreaterThan(0);
    expect(desk.countAboveCeiling).toBe(0);
    // ...while the population the POOLED gate counter tallies contains a breach that
    // is not the desk's. Same structure key, different books.
    expect(fixture.maxSpreadPct!).toBeGreaterThan(desk.maxSpreadPct!);
  });

  it('counts a quote-less desk row as DROPPED, never as a zero-spread fill', async () => {
    await recordOptionTradeOpen(row('desk-noquote', 'admin', null));
    const desk = cell(await body(), 'desk');
    expect(desk.n).toBe(0);
    expect(desk.rowsDroppedNoQuote).toBe(1);
    expect(desk.maxSpreadPct).toBeNull(); // NOT 0 — that is the whole point
  });

  it('?sinceTs= scopes the read to forward rows and ECHOES the filter it applied', async () => {
    // The cumulative pool still holds the 59 pre-TRA-2295 breaches and will never
    // read 0; the grade has to be scoped to entries opened after the deploy.
    await recordOptionTradeOpen(
      row('pre-fix', 'admin', { entryBid: 0.01, entryAsk: 0.59, entryMarkUsd: 0.3 }, ARM_TS - 1),
    );
    await recordOptionTradeOpen(
      row('post-fix', 'admin', { entryBid: 1.95, entryAsk: 2.05, entryMarkUsd: 2.0 }, ARM_TS + 1),
    );

    const unfiltered = await body();
    expect(unfiltered.appliedSinceTs).toBeNull(); // null, never 0 — 0 is a real epoch
    expect(cell(unfiltered, 'desk').countAboveCeiling).toBe(1);

    const scoped = await body({ sinceTs: String(ARM_TS) });
    expect(scoped.appliedSinceTs).toBe(ARM_TS);
    expect(scoped.filterAxis).toBe('openTs'); // ENTRY time, not close time
    const desk = cell(scoped, 'desk');
    expect(desk.n).toBe(1);
    expect(desk.countAboveCeiling).toBe(0);
  });
});

// TRA-1729 — GET /api/health/scaleout-ladder must SERVE the observe-pass fields.
//
// This drives the real registrar and reads the response body, deliberately: the new
// keys reach the payload through a `...summarizeScaleoutLadder()` SPREAD, so grepping
// the route file for `observedPositionCount` finds nothing and would "prove" the key is
// absent on a build that serves it perfectly. Only reading the served body settles it.
describe('GET /api/health/scaleout-ladder — TRA-1729 observe-pass readout', () => {
  const prior = process.env[SCALEOUT_LADDER_FLAG];

  beforeEach(() => {
    process.env[SCALEOUT_LADDER_FLAG] = '1'; // armed
    clearScaleoutLadderLedger();
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[SCALEOUT_LADDER_FLAG];
    else process.env[SCALEOUT_LADDER_FLAG] = prior;
    clearScaleoutLadderLedger();
  });

  function ladderBody() {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/scaleout-ladder')!;
    const res = fakeRes();
    handlers[0]!({}, res);
    return res.body as {
      enabled: boolean;
      trimCount: number;
      observedPositionCount: number | null;
      openPositionCount: number | null;
      maxGainPctObserved: number | null;
      maxGainPctLastPass: number | null;
      lastObservePassAt: number | null;
      observePassCount: number;
      observeStatus: string;
      firstRungUp: number;
      blind: boolean;
    };
  }

  it('ARMED + EMPTY BOOK serves the ALARM, not a byte-identical "still accruing"', () => {
    runScaleoutLadderObservePass([], new Map(), 1_700_000_000_000);
    const body = ladderBody();

    expect(body.enabled).toBe(true);
    expect(body.trimCount).toBe(0); // …exactly what a healthy patient ladder shows
    expect(body.observedPositionCount).toBe(0); // …and THIS is what says it is blind
    expect(body.observeStatus).toBe('blind');
    expect(body.blind).toBe(true);
    expect(body.lastObservePassAt).toBe(1_700_000_000_000);
    expect(body.observePassCount).toBe(1);
    expect(body.maxGainPctObserved).toBeNull(); // null = never measured, NOT 0
  });

  it('ARMED + a long UNDER the first rung serves the close-but-not-firing state', () => {
    runScaleoutLadderObservePass(
      [{ id: 'p1', symbol: 'AAPL', side: 'buy', entryPrice: 100, quantity: 100 }],
      new Map([['AAPL', 124]]), // +24%, 1pp under the +25% rung
      1_700_000_000_000,
    );
    const body = ladderBody();

    expect(body.trimCount).toBe(0); // SAME trimCount as the blind case above…
    expect(body.observedPositionCount).toBe(1); // …but it is demonstrably WATCHING
    expect(body.openPositionCount).toBe(1);
    expect(body.observeStatus).toBe('observing');
    expect(body.blind).toBe(false);
    expect(body.maxGainPctObserved).toBeCloseTo(0.24, 10);
    expect(body.maxGainPctLastPass).toBeCloseTo(0.24, 10);
    expect(body.firstRungUp).toBe(0.25); // 0.24 vs 0.25 — how close it got
  });

  it('DISARMED reads never_ran and is not reported as blind', () => {
    process.env[SCALEOUT_LADDER_FLAG] = '0';
    const body = ladderBody();
    expect(body.enabled).toBe(false);
    expect(body.observeStatus).toBe('never_ran');
    expect(body.observedPositionCount).toBeNull(); // no reading ≠ read an empty book
    expect(body.blind).toBe(false); // a flag that is OFF is not an alarm
  });
});

// TRA-1768 — the equity entry funnel route.
//
// Acceptance #3 is explicit: read the SERVED RESPONSE BODY, not the route file. A
// literal-key grep over the source reads `0` even on a build that serves the key
// (keys can arrive via a spread), so the only assertion worth anything is one that
// invokes the registered handler and inspects what it actually emitted.
interface FunnelResponse {
  ok: boolean;
  // TRA-1834 — per-engine blocks, never a single pooled row. Empty list = fleet never_ran.
  demo: EquityEntryFunnelBlock[];
  live: EquityEntryFunnelBlock[];
  intradayChurnersDisabled: string[];
  symbolReadRule: string;
  bucketOrderNote: string; // TRA-1835
  symbolNamesNote: string; // TRA-1835
}

/** TRA-1834 — a stable engineId for these direct-call route tests (one engine per test). */
const FE = 'engine-route-test';

function funnelBody(): FunnelResponse {
  const { app, routes } = fakeApp();
  registerLiveHealthRoutes(app, {
    requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
    userCtx: async () => ctx('admin', engineState()),
    getSettings: () => settings(),
    now: () => NOW,
  });
  const handlers = routes.get('/api/health/equity-entry-funnel')!;
  const res = fakeRes();
  handlers[0]!({}, res);
  return res.body as FunnelResponse;
}

describe('GET /api/health/equity-entry-funnel (TRA-1768)', () => {
  beforeEach(() => {
    __resetEquityEntryFunnelForTests();
  });

  afterEach(() => {
    __resetEquityEntryFunnelForTests();
  });

  it('serves demo and live SEPARATELY, three-valued, with no pass since boot', () => {
    const body = funnelBody();

    expect(body.ok).toBe(true);
    // No reading ≠ a dry signal side. TRA-1834 — with no engine ticked, each list is EMPTY
    // (fleet-level never_ran): nothing to report, not a zero row.
    expect(body.demo).toEqual([]);
    expect(body.live).toEqual([]);
  });

  it('THE ALARM: a pass that ran and generated nothing serves candidatesEvaluated 0 / no_candidates', () => {
    beginEquityEntryPass('demo', FE, { symbolsConsidered: 21, at: NOW });
    const body = funnelBody();

    expect(body.demo[0].label).toBe('demo-1');
    expect(body.demo[0].lastPass.candidatesEvaluated).toBe(0);
    expect(body.demo[0].funnelStatus).toBe('no_candidates');
    expect(body.demo[0].passGateBlockedReason).toBeNull(); // it RAN — no gate to blame
    expect(body.demo[0].lastPassAt).not.toBeNull();
    // The live book is untouched and must NOT inherit demo's reading.
    expect(body.live).toEqual([]);
  });

  it('a gated pass serves the GATE, not a false zero', () => {
    recordEquityEntryPassGated('demo', FE, 'market_closed', NOW);
    const body = funnelBody();

    expect(body.demo[0].funnelStatus).toBe('gated');
    expect(body.demo[0].passGateBlockedReason).toBe('market_closed');
    expect(body.demo[0].cumulative.candidatesEvaluated).toBeNull(); // NOT 0
    expect(body.demo[0].passCount).toBe(1); // the tick fired; gated ≠ never_ran
  });

  it('a candidate eaten by a guardrail serves the EATER by name', () => {
    beginEquityEntryPass('demo', FE, { symbolsConsidered: 21, at: NOW });
    recordEquityCandidate('demo', FE, 'deterministic');
    recordEquityEntryRejected('demo', FE, 'churn_brake');
    const body = funnelBody();

    expect(body.demo[0].funnelStatus).toBe('all_rejected');
    expect(body.demo[0].cumulative.candidatesEvaluated).toBe(1);
    expect(body.demo[0].cumulative.admitted).toBe(0);
    expect(body.demo[0].cumulative.rejectedByReason).toEqual({ churn_brake: 1 });
    expect(body.demo[0].cumulative.candidatesBySource).toEqual({ deterministic: 1 });
  });

  it('surfaces that swing mode hard-nulls the intraday churners (context for a dry deterministic bucket)', () => {
    const prior = process.env.EQUITY_SWING_MODE;
    process.env.EQUITY_SWING_MODE = 'true';
    try {
      expect(funnelBody().intradayChurnersDisabled).toEqual(['orb', 'bbFade_1h']);
    } finally {
      if (prior === undefined) delete process.env.EQUITY_SWING_MODE;
      else process.env.EQUITY_SWING_MODE = prior;
    }
  });
});

// TRA-1793 — the SYMBOL layer, on the wire.
//
// The unit tests prove the counters are right in memory. These prove they SURVIVE THE
// ROUTE — because the whole point of this ticket is that `symbolsWithData` was correct
// in memory too, and reached nothing but a `log.warn`. A fact that does not reach the
// PAYLOAD does not exist downstream. So: invoke the handler, read the served body, and
// then round-trip it through JSON, because the reader on the other end is `curl`.
describe('GET /api/health/equity-entry-funnel — symbol layer (TRA-1793)', () => {
  beforeEach(() => {
    __resetEquityEntryFunnelForTests();
  });

  afterEach(() => {
    __resetEquityEntryFunnelForTests();
  });

  /** What QuantTrader actually reads: the body as it comes back off the wire. */
  const overTheWire = (): FunnelResponse => JSON.parse(JSON.stringify(funnelBody())) as FunnelResponse;

  it('serves symbolsConsidered / symbolsEvaluated / symbolsSkippedByReason — per-pass AND cumulative', () => {
    beginEquityEntryPass('demo', FE, { symbolsConsidered: 3, at: NOW });
    recordEquitySymbolSkipped('demo', FE, 'stale_feed');
    recordEquitySymbolSkipped('demo', FE, 'stale_feed');
    recordEquitySymbolEvaluated('demo', FE);

    const body = overTheWire();

    expect(body.demo[0].lastPass.symbolsConsidered).toBe(3);
    expect(body.demo[0].lastPass.symbolsEvaluated).toBe(1);
    expect(body.demo[0].lastPass.symbolsSkippedByReason).toEqual({ stale_feed: 2 });
    expect(body.demo[0].cumulative.symbolsConsidered).toBe(3);
    expect(body.demo[0].cumulative.symbolsEvaluated).toBe(1);
    expect(body.demo[0].cumulative.symbolsSkippedByReason).toEqual({ stale_feed: 2 });
    // …and the live book, which swept nothing, is NOT pooled with it.
    expect(body.live).toEqual([]);
  });

  it('THE ALARM on the wire: an iterated pass where every symbol was stale serves symbolsEvaluated 0 next to candidatesEvaluated 0', () => {
    beginEquityEntryPass('demo', FE, { symbolsConsidered: 21, at: NOW });
    for (let i = 0; i < 21; i++) recordEquitySymbolSkipped('demo', FE, 'stale_feed');

    const body = overTheWire();

    // Identical to a dry Ichimoku by TRA-1768's fields alone…
    expect(body.demo[0].funnelStatus).toBe('no_candidates');
    expect(body.demo[0].lastPass.candidatesEvaluated).toBe(0);
    // …and separated from it by exactly one number, which is now on the wire.
    expect(body.demo[0].lastPass.symbolsEvaluated).toBe(0);
    expect(body.demo[0].lastPass.symbolsSkippedByReason).toEqual({ stale_feed: 21 });
    // The rule that tells the reader which of the two it is ships WITH the reading —
    // a read rule that lives only in a ticket is not held by whoever curls the route.
    expect(body.symbolReadRule).toContain('Read symbolsEvaluated BEFORE candidatesEvaluated');
  });

  it('the nulls survive JSON serialization as PRESENT KEYS — an absent key is not a null, it is a void', () => {
    recordEquityEntryPassGated('demo', FE, 'market_closed', NOW);

    const raw = JSON.stringify(funnelBody());
    const body = JSON.parse(raw) as FunnelResponse;

    // `JSON.stringify` drops `undefined` silently. If any of these were ever produced as
    // `undefined` rather than `null`, the key would VANISH from the body and a reader
    // doing `body.demo[0].lastPass.symbolsEvaluated ?? 0` would book a false zero on a GATED
    // pass — the exact bug, re-minted in the field built to kill it. So assert PRESENCE
    // first, and value second.
    for (const key of ['symbolsConsidered', 'symbolsEvaluated', 'symbolsSkippedByReason'] as const) {
      expect(Object.hasOwn(body.demo[0].lastPass, key)).toBe(true);
      expect(Object.hasOwn(body.demo[0].cumulative, key)).toBe(true);
      expect(body.demo[0].lastPass[key]).toBeNull();
      expect(body.demo[0].cumulative[key]).toBeNull();
    }
    expect(body.demo[0].funnelStatus).toBe('gated'); // …and it is a GATE, not a verdict
    expect(raw).toContain('"symbolsEvaluated":null'); // literally, on the wire

    // TRA-1835 — the NAME fields obey the same three-valued discipline: null on a gate,
    // as PRESENT keys, never absent (an absent key reads as a void, not a null).
    expect(Object.hasOwn(body.demo[0].lastPass, 'symbolsSkippedSymbols')).toBe(true);
    expect(body.demo[0].lastPass.symbolsSkippedSymbols).toBeNull();
    expect(Object.hasOwn(body.demo[0].cumulative, 'symbolsSkippedByName')).toBe(true);
    expect(body.demo[0].cumulative.symbolsSkippedByName).toBeNull();
  });

  // TRA-1835 — the whole point of the ticket, served over the wire: a `stale_feed: N` that
  // does not NAME its N reads identically whether the dark names are the tail or the head.
  it('names the dark in-universe symbols on the wire, and flags truncation rather than cutting silently', () => {
    beginEquityEntryPass('demo', FE, { symbolsConsidered: 21, at: NOW });
    // Two curated names dark, one off-universe skip that must be COUNTED but never NAMED.
    recordEquitySymbolSkipped('demo', FE, 'stale_feed', { symbol: 'NVDA', inUniverse: true });
    recordEquitySymbolSkipped('demo', FE, 'stale_feed', { symbol: 'COIN', inUniverse: true });
    recordEquitySymbolSkipped('demo', FE, 'off_swing_universe', { symbol: 'ZZZZ', inUniverse: false });

    const body = overTheWire();

    // The count still closes; the NAMES ride alongside it. off_swing_universe is unnamed.
    expect(body.demo[0].lastPass.symbolsSkippedByReason).toEqual({ stale_feed: 2, off_swing_universe: 1 });
    expect(body.demo[0].lastPass.symbolsSkippedSymbols).toEqual({ stale_feed: ['NVDA', 'COIN'] });
    expect(body.demo[0].lastPass.symbolsSkippedSymbolsTruncated).toBe(false);
    expect(body.demo[0].cumulative.symbolsSkippedByName).toEqual({ stale_feed: { NVDA: 1, COIN: 1 } });
    // The read guidance the ticket asked for ships WITH the reading, not only in the ticket.
    expect(body.bucketOrderNote).toContain('first-match-wins');
    expect(body.symbolNamesNote).toContain('symbolsSkippedSymbols');
  });
});

// TRA-2193 — GET /api/health/rv-scan.
//
// The acceptance criterion is not "the route exists" but "the route can tell an
// outage from a drought", so these assert the SEPARATION, not the shape.
describe('TRA-2193 GET /api/health/rv-scan', () => {
  function mountRvScan(env: Record<string, string | undefined> = {}) {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/rv-scan')!;
    const res = fakeRes();
    handlers[0]!({}, res);
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    return { handlers, body: res.body as Record<string, never> };
  }

  beforeEach(() => {
    __resetRvScanTelemetry();
  });

  it('is unauthenticated, matching the rest of the public /api/health/* posture', () => {
    const { handlers } = mountRvScan();
    expect(handlers).toHaveLength(1);
  });

  it('reports the DISARMED state as its own verdict — silence is correct, not a fault', () => {
    // This is the 2026-07-22 state: the flag was wiped, so the loop never ran.
    // Before this route there was no name for it.
    const { body } = mountRvScan({ ENABLE_OPTION_DEMO_DIRECTIONAL: undefined });
    // TRA-3557 — asserted PER PATH, not on the roll-up. The top-level verdict is an
    // ANY/ALL fold and `otm` (no feature flag, armed whenever the chain scanner is
    // wired) now holds it off `disarmed` permanently, so a roll-up assertion here
    // would be pinned by construction rather than by the flag under test — the
    // vacuous-green shape this route exists to prevent.
    expect(body.verdict).toBe('armed_but_never_ran');
    expect(body.enabled).toBe(true);
    // NULL, not 0. A 0 here is a valid epoch and would survive a finite-check on
    // the consumer side while asserting a scan that never happened.
    expect(body.lastScanAt).toBeNull();
    const dir = (body.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'directional')!;
    expect(dir.enabled).toBe(false);
    expect(dir.verdict).toBe('disarmed');
    expect(dir.lastScan).toBeNull();
  });

  it('PROOF OF FIRE: after one real scan the route reports a non-null lastScanAt and non-zero candidatesEvaluated', () => {
    const run = beginRvScan('directional', 3, () => NOW);
    run.enterSymbol(); run.reject('no_trend_confluence');
    run.enterSymbol(); run.pass(); run.opened();
    run.enterSymbol(); run.reject('churn_brake');
    run.fetchOk();
    run.finish();

    const { body } = mountRvScan({ ENABLE_OPTION_DEMO_DIRECTIONAL: '1' });
    expect(body.verdict).toBe('scanning');
    expect(body.enabled).toBe(true);
    expect(body.lastScanAt).toBe(NOW);
    expect(body.scanCountSinceBoot).toBe(1);

    const dir = (body.paths as unknown as Array<Record<string, never>>)
      .find((p) => (p as Record<string, unknown>).path === 'directional')!;
    const last = dir.lastScan as unknown as Record<string, number>;
    expect(last.candidatesEvaluated).toBe(3);
    expect(last.opensPlaced).toBe(1);
    // The invariant, asserted on the wire and not only in the store.
    expect(
      Object.values(last.rejectionsByGate as unknown as Record<string, number>)
        .reduce((a, b) => a + b, 0),
    ).toBe(last.candidatesEvaluated - last.candidatesPassed);
    expect(dir.lastScan!['bucketsBalance']).toBe(true);
    expect((body.dataSource as unknown as Record<string, unknown>).lastFetchOkAt).toBe(NOW);
  });

  it('separates ARMED-BUT-NEVER-RAN from DISARMED — the two an operator must not confuse', () => {
    const armed = mountRvScan({ ENABLE_OPTION_DEMO_DIRECTIONAL: '1' }).body;
    const disarmed = mountRvScan({ ENABLE_OPTION_DEMO_DIRECTIONAL: undefined }).body;

    // Both have zero opens and a null lastScanAt. Only `verdict` tells them apart,
    // and they demand opposite remedies: restore a wiped env var vs. investigate a
    // scanner that is armed and not ticking.
    expect(armed.lastScanAt).toBeNull();
    expect(disarmed.lastScanAt).toBeNull();
    // TRA-3557 — on the PER-PATH axis. The roll-up reads `armed_but_never_ran` in
    // BOTH arms now (the always-armed `otm` path pins it), so the separation this
    // test is named for survives only here. That the two roll-ups agree while the
    // two paths disagree is the whole reason the per-path verdict exists.
    const dirOf = (b: Record<string, never>) => (b.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'directional')!;
    expect(dirOf(armed).verdict).toBe('armed_but_never_ran');
    expect(dirOf(disarmed).verdict).toBe('disarmed');
    expect(armed.verdict).toBe(disarmed.verdict);
  });

  it('reports the UN-INSTRUMENTED iv-rv path with null counters, never zeros', () => {
    const { body } = mountRvScan();
    const ivrv = (body.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'iv_rv_buy_premium')!;
    expect(ivrv.instrumented).toBe(false);
    // 0 would claim a measurement this iteration does not take.
    expect(ivrv.scanCountSinceBoot).toBeNull();
    expect(ivrv.lastScanAt).toBeNull();
  });

  it('carries the structure-vs-sleeve warning in the PAYLOAD, not only in the ticket', () => {
    const { body } = mountRvScan();
    // TRA-2245 — per-path structure labels: only rv_scan keeps `single_leg_rv`; the
    // directional producers journal `single_leg_directional`. A reader who does not
    // know that grades the wrong population, and a fact that only reaches a ticket
    // does not exist downstream.
    expect(body.structureLabels).toEqual({
      rv_scan: 'single_leg_rv',
      directional: 'single_leg_directional',
      iv_rv_buy_premium: 'single_leg_directional',
      // TRA-3557 — the OTM sleeve journals its own label and never shared a bucket.
      otm: 'single_leg_otm',
    });
    // Each path also carries its own structureLabel inline.
    const paths = body.paths as unknown as Array<Record<string, unknown>>;
    expect(paths.find((p) => p.path === 'directional')!.structureLabel).toBe('single_leg_directional');
    expect(paths.find((p) => p.path === 'rv_scan')!.structureLabel).toBe('single_leg_rv');
    expect(paths.find((p) => p.path === 'otm')!.structureLabel).toBe('single_leg_otm');
    expect(String(body.note)).toContain('entryArchetype');
    expect(String(body.note)).toContain('not a sleeve');
    // All four producer paths are enumerated, so none can go quiet unnoticed.
    expect(paths.length).toBe(4);
  });

  // TRA-3557 — the OTM sleeve is the path under live-money acceptance and was the
  // only option entry path with NO scan run. Its starve was invisible on every axis
  // the server published, because the `continue` it fires on sits upstream of the
  // nominator, of `recordLiveEnforceDecision` and of the universe gate.
  it('publishes an INSTRUMENTED otm path, so the sleeve under live acceptance is no longer silent', () => {
    const { body } = mountRvScan();
    const otm = (body.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'otm')!;
    expect(otm.instrumented).toBe(true);
    // Never ran yet ⇒ null, not a zero-count scan that would read as "ran, found
    // nothing" — the distinction the whole ticket turns on.
    expect(otm.lastScanAt).toBeNull();
    expect(otm.lastScan).toBeNull();
    // 0 (not null) — an INSTRUMENTED path that has not scanned has a real
    // measurement of zero, unlike the un-instrumented iv-rv path above.
    expect(otm.scanCountSinceBoot).toBe(0);
    expect(otm.verdict).toBe('armed_but_never_ran');
  });

  it('separates the three zeroes the OTM starve used to collapse into one', () => {
    // (3) NEVER RAN — the defect. Nothing recorded at all.
    const never = (mountRvScan().body.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'otm')!;
    expect(never.lastScan).toBeNull();
    expect(never.scanCountSinceBoot).toBe(0);

    // (2) RAN, FOUND NOTHING — a REAL negative. Ten names considered, all rejected,
    // and the reasons SPLIT so a provider failure is not pooled with an empty chain.
    const run = beginRvScan('otm', 10, () => NOW);
    for (let i = 0; i < 8; i += 1) { run.enterSymbol(); run.reject('no_candidates'); }
    for (let i = 0; i < 2; i += 1) { run.enterSymbol(); run.reject('scan:chain_error'); }
    run.finish();
    const ran = (mountRvScan().body.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'otm')!;
    const last = ran.lastScan as Record<string, unknown>;
    expect(ran.scanCountSinceBoot).toBe(1);
    expect(ran.lastScanAt).toBe(NOW);
    // The counter that makes (2) legible: input-counted, so an all-`continue` pass
    // reports the symbols CONSIDERED rather than the zero that reads as (3).
    expect(last.candidatesEvaluated).toBe(10);
    expect(last.candidatesPassed).toBe(0);
    expect(last.rejectionsByGate).toEqual({ no_candidates: 8, 'scan:chain_error': 2 });
    expect(last.bucketsBalance).toBe(true);
    // Pooling those two would re-create this ticket's ambiguity one level down:
    // `no_candidates` is a negative to grade on, `scan:*` is an outage that voids it.
    expect(Object.keys(last.rejectionsByGate as object)).toHaveLength(2);
  });

  it('a budget-TRUNCATED otm pass cannot read as a completed sweep', () => {
    // 80 of 614 walked, cursor parked mid-universe. Without the sweep block this
    // publishes identically to a pass that died at symbol 80 — the same class of
    // bug this ticket is about, one level down.
    const run = beginRvScan('otm', 614, () => NOW);
    for (let i = 0; i < 80; i += 1) { run.enterSymbol(); run.reject('no_candidates'); }
    run.noteSweep({
      startIndex: 0, processed: 80, complete: false,
      budgetExhausted: true, stopped: false, resumeAt: 'NVDA',
    }, 'iv_rv_cap_headroom');
    run.finish();

    const otm = (mountRvScan().body.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'otm')!;
    const last = otm.lastScan as Record<string, unknown>;
    expect(last.universeSize).toBe(614);
    expect(last.candidatesEvaluated).toBe(80);
    // The gap is EXPLAINED, not left to be inferred.
    expect(last.stoppedEarlyReason).toBe('sweep_budget_exhausted');
    expect(last.sweep).toEqual({
      startIndex: 0, processed: 80, complete: false,
      budgetExhausted: true, stopped: false, resumeAt: 'NVDA',
    });
  });

  it('names a RESUMED tail too — reaching the end of the universe is not covering it', () => {
    // The case a `complete` flag alone gets wrong: the pass finished the sweep, but
    // started at the cursor, so it walked 34 of 614. With no reason recorded that
    // gap reads as a loop that died part-way through.
    const run = beginRvScan('otm', 614, () => NOW);
    for (let i = 0; i < 34; i += 1) { run.enterSymbol(); run.reject('no_candidates'); }
    run.noteSweep({
      startIndex: 580, processed: 34, complete: true,
      budgetExhausted: false, stopped: false, resumeAt: null,
    });
    run.finish();

    const otm = (mountRvScan().body.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'otm')!;
    const last = otm.lastScan as Record<string, unknown>;
    expect(last.stoppedEarlyReason).toBe('sweep_resumed_tail');
    expect((last.sweep as Record<string, unknown>).startIndex).toBe(580);
  });

  it('a FULL otm sweep records no early-stop reason — the fail state of the two above', () => {
    // The positive control. If `stoppedEarlyReason` were set unconditionally the two
    // assertions above would pass against an instrument that says "truncated" always.
    const run = beginRvScan('otm', 3, () => NOW);
    for (let i = 0; i < 3; i += 1) { run.enterSymbol(); run.reject('no_candidates'); }
    run.noteSweep({
      startIndex: 0, processed: 3, complete: true,
      budgetExhausted: false, stopped: false, resumeAt: null,
    });
    run.finish();

    const otm = (mountRvScan().body.paths as unknown as Array<Record<string, unknown>>)
      .find((p) => p.path === 'otm')!;
    const last = otm.lastScan as Record<string, unknown>;
    expect(last.stoppedEarlyReason).toBeNull();
    expect(last.candidatesEvaluated).toBe(3);
    expect(last.universeSize).toBe(3);
  });

  // TRA-3080 — the failure this route had left: `enabled` is a PROCESS-WIDE flag
  // read, so it reported `true` all through the desk's 2026-07-30 → 08-05
  // directional drought while the `admin` book, moved to `settings.mode: 'live'`
  // for the live-OTM window, could not reach the pass at all. The two readings
  // must be able to DISAGREE on the same response — if they cannot, the route is
  // back to the state that made TRA-3080 unanswerable.
  it('publishes a retained per-ET-day arm view that can contradict the fleet-blind `enabled`', () => {
    clearDirectionalOpenLedger();
    recordDirectionalArm(
      {
        etDay: '2026-07-31',
        account: 'admin',
        accountClass: 'desk',
        mode: 'live',
        disposition: 'live_arm_off',
      },
      NOW,
    );
    recordDirectionalArm(
      {
        etDay: '2026-07-31',
        account: 'qa_reg_0710202220',
        accountClass: 'fixture',
        mode: 'demo',
        disposition: 'armed_demo',
      },
      NOW,
    );

    const { body } = mountRvScan({ ENABLE_OPTION_DEMO_DIRECTIONAL: 'true' });
    // The flag says armed…
    expect(body.enabled as unknown as boolean).toBe(true);

    // …and the retained axis says the desk could not reach the pass that day.
    const days = body.armByEtDay as unknown as Array<{
      etDay: string;
      cells: Array<{ accountClass: string; reachable: boolean; disposition: string }>;
    }>;
    const day = days.find((d) => d.etDay === '2026-07-31')!;
    const desk = day.cells.find((c) => c.accountClass === 'desk')!;
    const fixture = day.cells.find((c) => c.accountClass === 'fixture')!;

    expect(desk.reachable).toBe(false);
    expect(desk.disposition).toBe('live_arm_off');
    expect(fixture.reachable).toBe(true);
    // The contradiction is the point: a fleet-blind `true` over an unreachable desk.
    expect(body.enabled as unknown as boolean).not.toBe(desk.reachable);
    expect(String(body.armNote)).toContain('FLEET-BLIND');
    expect(body.armRetentionDays as unknown as number).toBe(30);

    clearDirectionalOpenLedger();
  });
});

// TRA-2193 item 3 — fixture-vs-desk partition on the option-journal summary.
//
// Reproduces the 2026-07-22 session exactly: one real desk trade plus the SAME
// SMCI trail exit mirrored into three QA fixture books. The mirrored rows carry
// DISTINCT ids, so id-dedupe finds nothing and the pooled number reads as clean.
describe('TRA-2193 option-journal fixture-vs-desk partition', () => {
  function row(
    id: string,
    account: string | undefined,
    pnl: number,
    r: number,
  ): OptionTradeJournalRecord {
    return {
      id,
      openTs: NOW - 3_600_000,
      symbol: 'SMCI',
      structure: 'single_leg_otm',
      mode: 'demo',
      ivRank: null,
      trend: 'up',
      sentiment: null,
      entryDelta: 0.5,
      entryDte: 20,
      atRiskUsd: 181.9999999999999,
      agentConviction: null,
      outcome: 'WIN',
      closeTs: NOW,
      realizedPnlUsd: pnl,
      realizedR: r,
      exitReason: 'trail',
      holdDays: 1,
      ...(account === undefined ? {} : { account }),
    } as OptionTradeJournalRecord;
  }

  // Bit-identical economics, three different fixture books, three different ids.
  const mirrored = [
    row('m1', 'qa_mirror_1578_38096', 1600, 8.791),
    row('m2', 'qa_tra1475_1783821169', 1600, 8.791),
    row('m3', 'qa_reg_0710202220', 1600, 8.791),
  ];
  const desk = row('d1', 'admin', 119.5, 0.1079);
  const legacy = row('old1', undefined, 50, 0.25); // pre-TRA-1475, no `account`

  it('separates the 41x fixture inflation the pooled summary hides', () => {
    const report = buildOptionJournalReport([...mirrored, desk], NOW, true);

    // The pooled number — unchanged, still wrong to grade on, and still published
    // so no existing consumer's number moves under it (TRA-2079).
    expect(report.summary.realizedPnlUsd).toBe(4919.5);

    // The number that is actually true of the desk.
    expect(report.summary.byAccountClass.desk.realizedPnlUsd).toBe(119.5);
    expect(report.summary.byAccountClass.desk.closed).toBe(1);
    expect(report.summary.byAccountClass.fixture.realizedPnlUsd).toBe(4800);
    expect(report.summary.byAccountClass.fixture.closed).toBe(3);

    // ~41x on realized $, which is the whole reason this partition exists.
    expect(
      report.summary.realizedPnlUsd / report.summary.byAccountClass.desk.realizedPnlUsd,
    ).toBeGreaterThan(40);

    expect(report.fixtureRowCount).toBe(3);
    expect(report.deskRowCount).toBe(1);
  });

  it('id-dedupe CANNOT find these — the ids are distinct; only `account` separates them', () => {
    // Stated as a test because it is the trap: a consumer that de-duplicates on
    // `id` gets 0 duplicates back and concludes the pool is clean.
    const ids = new Set(mirrored.map((m) => m.id));
    expect(ids.size).toBe(3);
    const economics = new Set(mirrored.map((m) => `${m.realizedPnlUsd}:${m.realizedR}`));
    expect(economics.size).toBe(1);
  });

  it('rows with NO account are `unattributed`, never folded into desk', () => {
    const report = buildOptionJournalReport([desk, legacy], NOW, true);

    // Folding pre-TRA-1475 rows into `desk` would re-commit the pooling bug for
    // exactly the historical rows a long-window grade leans on hardest.
    expect(report.unattributedRowCount).toBe(1);
    expect(report.deskRowCount).toBe(1);
    expect(report.summary.byAccountClass.desk.realizedPnlUsd).toBe(119.5);
    expect(report.summary.byAccountClass.unattributed.realizedPnlUsd).toBe(50);
  });

  it('the three classes SUM to the row count — a partition that is not a partition is a new bug', () => {
    const rows = [...mirrored, desk, legacy];
    const report = buildOptionJournalReport(rows, NOW, true);

    expect(report.fixtureRowCount + report.deskRowCount + report.unattributedRowCount)
      .toBe(rows.length);
    expect(report.summary.accountClassCountsSumToRows).toBe(true);
  });

  it('respects the sinceTs cohort filter — the partition folds the SAME rows as the summary', () => {
    const old = { ...desk, id: 'old-desk', openTs: NOW - 90_000_000 };
    const report = buildOptionJournalReport(
      [old, desk, ...mirrored],
      NOW,
      true,
      undefined,
      NOW - 7_200_000,
    );
    // `old` is outside the cohort, so it must be absent from BOTH folds. Summary
    // and partition describing different populations in one 200 is the TRA-2082
    // false-PASS shape.
    expect(report.deskRowCount).toBe(1);
    expect(report.summary.closed).toBe(4);
    expect(report.summary.accountClassCountsSumToRows).toBe(true);
  });

  it('names the desk field to grade on, in the payload rather than only in the ticket', () => {
    const report = buildOptionJournalReport([desk], NOW, true);
    expect(report.summary.accountClassNote).toContain('byAccountClass.desk');
    expect(report.summary.accountClassNote).toContain('id-dedupe');
  });

  // ── TRA-2478 ──────────────────────────────────────────────────────────────
  //
  // The partition classed verification books by a matcher that covered only
  // {`qa_*`, `ctoverify*`}, so `qtverify_1785048357` — a QuantTrader verification
  // book — was folded into `byAccountClass.desk`, the gate basis for the TRA-1585
  // OTM delta-floor forward grade. TRA-2488 fixed the SHARED predicate
  // (`^qtverify` in `BUILTIN_TEST_PATTERNS`); these tests pin the fix AT THE
  // PARTITION, which is a different claim and the one that was actually wrong.
  //
  // Why here and not only in `test-accounts.test.ts`: the unit tests on
  // `isTestAccount` stay green if someone re-inlines a local prefix list into
  // `partitionRowsByAccountClass`. That re-inlining IS the defect class — TRA-2355
  // had already removed one such copy — and only a partition-level assertion can
  // see it. The `routes through the shared predicate` test below is the tooth.
  describe('TRA-2478 verification books never enter the desk fold', () => {
    // The live contamination, reproduced to the digit from the 2026-07-28 wire
    // read on `408f06a5` (post-arm OTM window, `openTs >= 1784089818067`):
    //   36 genuine desk rows   avgR +0.149618   $789.69
    // + 1  qtverify_1785048357 R    +0.0502     $12.54
    // = 37 rows reported as desk, avgR +0.14693, $802.23.
    const DESK_N = 36;
    const DESK_R = 0.149618;
    const DESK_USD = 789.69;
    const QTVERIFY_R = 0.0502;
    const QTVERIFY_USD = 12.54;
    const CONTAMINATED_R = (DESK_N * DESK_R + QTVERIFY_R) / (DESK_N + 1);

    // Three real desk books, round-robined — `Richard` capitalised as it is in
    // prod, since the patterns are case-INsensitive and a careless widening
    // (e.g. a bare `/verify/i`) has to be shown not to swallow them.
    const deskBooks = ['admin', 'Richard', 'enock'];
    const deskRows = Array.from({ length: DESK_N }, (_, i) =>
      row(`desk-${i}`, deskBooks[i % deskBooks.length], DESK_USD / DESK_N, DESK_R),
    );
    const qtverifyRow = row('qtv1', 'qtverify_1785048357', QTVERIFY_USD, QTVERIFY_R);

    it('keeps qtverify_* OUT of desk — the exact +$12.54 / avgR drift from the wire', () => {
      const report = buildOptionJournalReport([...deskRows, qtverifyRow], NOW, true);

      expect(report.deskRowCount).toBe(DESK_N);
      expect(report.fixtureRowCount).toBe(1);
      expect(report.summary.byAccountClass.desk.closed).toBe(DESK_N);
      expect(report.summary.byAccountClass.desk.avgR).toBeCloseTo(DESK_R, 6);
      expect(report.summary.byAccountClass.desk.realizedPnlUsd).toBeCloseTo(DESK_USD, 6);

      // The fixture row is not dropped — it moves, and it must be findable.
      expect(report.summary.byAccountClass.fixture.realizedPnlUsd).toBeCloseTo(QTVERIFY_USD, 6);

      // …and the specific wrong numbers the route used to publish are now absent
      // from desk. Asserting the negative directly: a future matcher regression
      // reproduces exactly these, so naming them is what makes this test fail loud.
      expect(report.summary.byAccountClass.desk.avgR).not.toBeCloseTo(CONTAMINATED_R, 6);
      expect(report.summary.byAccountClass.desk.realizedPnlUsd)
        .not.toBeCloseTo(DESK_USD + QTVERIFY_USD, 6);
      expect(CONTAMINATED_R).toBeCloseTo(0.14693, 5); // the published desk avgR, for the record
    });

    // One case per KNOWN verification family, at the partition. Mirrors the
    // family registry in `test-accounts.test.ts` deliberately: when a loop invents
    // a new prefix, BOTH lists have to grow, and a fixture book whose name matches
    // no family silently re-enters the desk number. There have now been three
    // families (`qa_*`, `ctoverify_*`, `qtverify_*`) and they are already
    // compounding — `ctoverify_qa_tra2406b` carries two of them.
    it('classes every known verification family as fixture, real books as desk', () => {
      const fixtures = [
        row('f1', 'qa_reg_0710202220', 5, 0.02),
        row('f2', 'qa_tra1475_1783821169', 5, 0.02),
        row('f3', 'qa_mirror_1578_38096', 5, 0.02),
        row('f4', 'ctoverify_qa_tra2406b', 5, 0.02),
        row('f5', 'monitor_qa', 5, 0.02),
        row('f6', 'qtverify_1785048357', 5, 0.02),
      ];
      const desks = deskBooks.map((b, i) => row(`r${i}`, b, 100, 0.5));
      const report = buildOptionJournalReport([...fixtures, ...desks], NOW, true);

      expect(report.fixtureRowCount).toBe(fixtures.length);
      expect(report.deskRowCount).toBe(desks.length);
      expect(report.summary.byAccountClass.desk.realizedPnlUsd).toBe(300);
      expect(report.summary.accountClassCountsSumToRows).toBe(true);
    });

    // The anti-widening guard. The ticket floated a bare `/verify/i` substring as
    // one option; it is the wrong shape, because it silently SHRINKS the desk
    // number the moment a real book's name happens to contain "verify" — a
    // false-negative desk row is far worse than the +$12.54 it would fix, and it
    // reads identically to a quiet desk. The shipped rule stays ANCHORED.
    it('does NOT swallow real books whose name merely contains a family substring', () => {
      const realBooks = ['qtrader', 'my_qtverify', 'aqua', 'monitorly', 'my_qa_notes'];
      const rows = realBooks.map((b, i) => row(`ok${i}`, b, 10, 0.1));
      const report = buildOptionJournalReport(rows, NOW, true);

      expect(report.deskRowCount).toBe(realBooks.length);
      expect(report.fixtureRowCount).toBe(0);
    });

    // THE TOOTH. Proves the partition calls the shared classifier rather than a
    // local copy of its pattern list: an env-configured prefix is known ONLY to
    // `test-accounts.ts`, so a re-inlined regex list in this module cannot honour
    // it and this test goes red. Without this, every other assertion here would
    // still pass against a freshly-drifted second matcher.
    it('routes through the SHARED predicate — an env-configured prefix reclassifies', () => {
      const before = process.env[TEST_ACCOUNT_PREFIX_ENV];
      try {
        // Baseline: unknown to every built-in family, so it is desk.
        expect(
          buildOptionJournalReport([row('lt1', 'loadtest_9', 42, 0.3)], NOW, true).deskRowCount,
        ).toBe(1);

        process.env[TEST_ACCOUNT_PREFIX_ENV] = 'loadtest';
        const report = buildOptionJournalReport([row('lt1', 'loadtest_9', 42, 0.3)], NOW, true);
        expect(report.fixtureRowCount).toBe(1);
        expect(report.deskRowCount).toBe(0);
        expect(report.summary.byAccountClass.desk.realizedPnlUsd).toBe(0);
      } finally {
        if (before === undefined) delete process.env[TEST_ACCOUNT_PREFIX_ENV];
        else process.env[TEST_ACCOUNT_PREFIX_ENV] = before;
      }
    });
  });
});

// TRA-2193 item 4 — enumerate open positions.
//
// `summary.open` reported a count (37 on bqb1) that no `rows` mode could expand,
// so unrealized MTM was unobservable and the mid-vs-bid mark parity work on
// TRA-2174 / TRA-2131 had nothing to reconcile against.
describe('TRA-2193 option-journal rows=open / rows=all', () => {
  const base = {
    openTs: NOW - 3_600_000,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 20,
    atRiskUsd: 100,
    agentConviction: null,
  };
  const openDemo = { ...base, id: 'o1', mode: 'demo', outcome: 'OPEN' } as OptionTradeJournalRecord;
  const openLive = { ...base, id: 'o2', mode: 'live', outcome: 'OPEN' } as OptionTradeJournalRecord;
  const closedDemo = {
    ...base, id: 'c1', mode: 'demo', outcome: 'WIN',
    closeTs: NOW, realizedPnlUsd: 10, realizedR: 0.5, exitReason: 'trail', holdDays: 1,
  } as OptionTradeJournalRecord;
  const all = [openDemo, openLive, closedDemo];

  it('rows=open enumerates exactly what summary.open counts', () => {
    const report = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'open');
    expect(report.rowsMode).toBe('open');
    // The count and the enumeration must agree, or one of them is lying.
    expect(report.rows).toHaveLength(report.summary.open);
    expect(report.rows?.map((r) => r.id).sort()).toEqual(['o1', 'o2']);
  });

  it('rows=all returns both modes and both outcomes', () => {
    const report = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'all');
    expect(report.rowsMode).toBe('all');
    expect(report.rows).toHaveLength(3);
  });

  it('rows=demo is byte-for-byte unchanged — demo AND resolved only', () => {
    const viaString = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'demo');
    const viaLegacyBool = buildOptionJournalReport(all, NOW, true, undefined, undefined, true);
    expect(viaString.rows?.map((r) => r.id)).toEqual(['c1']);
    // The old boolean call signature still means `demo`, so no existing caller moves.
    expect(viaLegacyBool.rows).toEqual(viaString.rows);
    expect(viaLegacyBool.rowsMode).toBe('demo');
  });

  it('an UNKNOWN rows value yields an empty dump and a NULL mode, not a silent demo fallback', () => {
    const report = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'unknown');
    // Serving a different population than the one asked for, under a 200, is the
    // exact failure shape TRA-2082 closed. `rowsMode: null` says "I did not
    // recognise that" instead of quietly answering a different question.
    expect(report.rowsMode).toBeNull();
    expect(report.rows).toEqual([]);
  });

  it('states that journal rows carry NO marks, so a missing P&L is not a zero', () => {
    const report = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'open');
    // Enumeration answers WHICH contracts are open; it cannot price them. Unrealized
    // MTM still needs a mark source (TRA-2174 / TRA-2131).
    expect(report.rowsCarryMarks).toBe(false);
  });

  it('omits the rows fields entirely when no dump was requested', () => {
    const report = buildOptionJournalReport(all, NOW, true);
    expect(report.rows).toBeUndefined();
    expect(report.rowsMode).toBeUndefined();
  });

  it('rows=open still honours the sinceTs cohort filter', () => {
    const stale = { ...openDemo, id: 'o0', openTs: NOW - 90_000_000 };
    const report = buildOptionJournalReport(
      [stale, ...all], NOW, true, undefined, NOW - 7_200_000, 'open',
    );
    expect(report.rows?.map((r) => r.id).sort()).toEqual(['o1', 'o2']);
    expect(report.rowsFiltered).toBe(true);
  });
});

// TRA-3381 (parent TRA-2946) — the byMode partition. The board-ratified live
// swing-exit policy (TRA-2949) carries a pre-registered 30-close grade whose
// cohort is mode:live closed rows, and the summary pooled them invisibly: on
// 2026-08-12 bqb1 held 19 live rows (6 closed) inside a ~2700-row demo pool
// with no open-endpoint read of their realized R or exit attribution.
describe('TRA-3381 option-journal byMode partition', () => {
  const base = {
    openTs: NOW - 3_600_000,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 20,
    atRiskUsd: 100,
    agentConviction: null,
  };
  function closedRow(
    id: string,
    mode: 'demo' | 'live',
    outcome: 'WIN' | 'LOSS' | 'SCRATCH',
    pnl: number,
    r: number,
    exitReason: string,
  ): OptionTradeJournalRecord {
    return {
      ...base, id, mode, outcome,
      closeTs: NOW, realizedPnlUsd: pnl, realizedR: r, exitReason, holdDays: 1,
    } as OptionTradeJournalRecord;
  }
  const openLive = { ...base, id: 'lo1', mode: 'live', outcome: 'OPEN' } as OptionTradeJournalRecord;
  const openDemo = { ...base, id: 'do1', mode: 'demo', outcome: 'OPEN' } as OptionTradeJournalRecord;
  const liveWin = closedRow('lc1', 'live', 'WIN', 714, 1.79, 'trail');
  const liveLoss = closedRow('lc2', 'live', 'LOSS', -79, -0.22, 'chandelier');
  const demoWin = closedRow('dc1', 'demo', 'WIN', 50, 0.5, 'tp1');
  const all = [openLive, openDemo, liveWin, liveLoss, demoWin];

  it('separates live economics from the demo pool the summary hides them in', () => {
    const report = buildOptionJournalReport(all, NOW, true);
    const live = report.summary.byMode.live;
    expect(live.total).toBe(3);
    expect(live.open).toBe(1);
    expect(live.closed).toBe(2);
    expect(live.win).toBe(1);
    expect(live.loss).toBe(1);
    expect(live.scratch).toBe(0);
    expect(live.realizedPnlUsd).toBe(635);
    expect(live.avgR).toBeCloseTo((1.79 - 0.22) / 2, 10);
    expect(live.winRate).toBe(0.5);

    const demo = report.summary.byMode.demo;
    expect(demo.total).toBe(2);
    expect(demo.closed).toBe(1);
    expect(demo.realizedPnlUsd).toBe(50);
  });

  it('carries a per-mode byExitReason rollup — the exit that fired is what the policy is graded on', () => {
    const report = buildOptionJournalReport(all, NOW, true);
    const reasons = report.summary.byMode.live.byExitReason;
    const trail = reasons.find((s) => s.exitReason === 'trail');
    const chandelier = reasons.find((s) => s.exitReason === 'chandelier');
    expect(trail?.closed).toBe(1);
    expect(trail?.win).toBe(1);
    expect(chandelier?.closed).toBe(1);
    expect(chandelier?.loss).toBe(1);
    // The demo close must not bleed into the live attribution.
    expect(reasons.find((s) => s.exitReason === 'tp1')).toBeUndefined();
  });

  it('the two modes SUM to the row count', () => {
    const report = buildOptionJournalReport(all, NOW, true);
    expect(report.summary.byMode.live.total + report.summary.byMode.demo.total)
      .toBe(report.summary.total);
    expect(report.summary.modeCountsSumToRows).toBe(true);
  });

  it('keeps the pooled top-level summary UNCHANGED (back-compat, same contract as accountClassNote)', () => {
    const report = buildOptionJournalReport(all, NOW, true);
    // Pooled = both modes folded together, exactly as before the partition.
    expect(report.summary.total).toBe(5);
    expect(report.summary.closed).toBe(3);
    expect(report.summary.realizedPnlUsd).toBe(685);
    expect(report.summary.modeNote).toContain('byMode.live');
    expect(report.summary.modeNote).toContain('POOLED');
  });

  it('folds the SAME sinceTs cohort as the summary — not the unfiltered pool', () => {
    const staleLive = { ...liveWin, id: 'lc0', openTs: NOW - 90_000_000 };
    const report = buildOptionJournalReport(
      [staleLive, ...all], NOW, true, undefined, NOW - 7_200_000,
    );
    expect(report.summary.byMode.live.closed).toBe(2);
    expect(report.summary.modeCountsSumToRows).toBe(true);
  });

  it('closed live rows in the rows=all dump carry closeTs + realizedR + exitReason (acceptance b)', () => {
    // The dump serves full journal records, so the close fields ride along once
    // the close line folds. Pinned here because the TRA-2946 grade reads
    // per-trade R off exactly these fields on exactly this dump.
    const report = buildOptionJournalReport(all, NOW, true, undefined, undefined, 'all');
    const dumped = report.rows?.filter((r) => r.mode === 'live' && r.outcome !== 'OPEN') ?? [];
    expect(dumped).toHaveLength(2);
    for (const r of dumped) {
      expect(r.closeTs).toBe(NOW);
      expect(typeof r.realizedR).toBe('number');
      expect(typeof r.realizedPnlUsd).toBe('number');
      expect(r.exitReason).toBeTruthy();
    }
  });
});

// TRA-2220 (parent TRA-2195 → TRA-2193) — the give-back arm-floor route could not report
// its OWN blindness. `recordGiveBackState` is called from inside the
// `EXIT_RISK_RULES_ENABLED` master gate, so the master going down does not zero the
// counters — it FREEZES them, and a frozen `giveback_halt_sub_floor: 0` is byte-identical
// to "22 sessions observed, none breached the floor". bqb1 served exactly that, with
// `ok: true`, across 2026-07-22 and 07-23 while TRA-1592's recorded reopen tripwire
// ("giveback_halt_sub_floor > 0") sat structurally unable to fire.
//
// These pin the HTTP surface, not just the fold: what a grader actually curls.
describe('TRA-2220 giveback-arm-floor route — darkness is a first-class verdict', () => {
  // 2026-07-24T00:55Z = Thu 2026-07-23 20:55 ET, after the cash close. The exact wall
  // clock of the live observation in the ticket.
  const GB_NOW = Date.UTC(2026, 6, 24, 0, 55);

  /** Serve the route with the clock pinned to the observation, and return the body. */
  function readRoute(): Record<string, unknown> {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => GB_NOW,
    });
    const handlers = routes.get('/api/health/giveback-arm-floor')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other rule probes
    const res = fakeRes();
    handlers[0]!({}, res);
    return res.body as Record<string, unknown>;
  }

  /** The live bqb1 shape: a clean run through Tue 07-21, then two empty trading days. */
  beforeEach(() => {
    clearGiveBackArmFloorLedger();
    delete process.env.EXIT_RISK_RULES_ENABLED;
    const s = {
      peakPnl: 100,
      currentPnl: 90,
      retainedFloor: 60,
      giveBackArmFloor: 25,
      giveBackCapPct: 0.4,
      armFloorCleared: true,
      haltLatched: false,
      haltReason: null,
    } as const;
    recordGiveBackState('demo', 'engine-1', '2026-07-20', s, 1_001);
    recordGiveBackState('demo', 'engine-1', '2026-07-21', s, 1_002);
  });

  afterEach(() => {
    clearGiveBackArmFloorLedger();
    delete process.env.EXIT_RISK_RULES_ENABLED;
  });

  it('reports ok:FALSE and a null tripwire while the recorder is dark', () => {
    const body = readRoute(); // no EXIT_RISK_RULES_ENABLED in the env ⇒ the writer is gated off
    expect(body.ok).toBe(false); // was unconditionally `true` — the bug
    const rec = body.recorder as Record<string, unknown>;
    expect(rec.state).toBe('dark');
    expect(rec.armed).toBe(false);
    expect(rec.lastRecordedSessionDate).toBe('2026-07-21');
    expect(rec.missingTradingDays).toEqual(['2026-07-22', '2026-07-23']);

    // `0` is never "not measured" (TRA-1707). The raw count survives alongside it, so
    // the nulling costs no information — only the authority to read it as a measurement.
    expect(body.invalidations).toBeNull();
    expect((body.verdictCounts as Record<string, unknown>).giveback_halt_sub_floor).toBeNull();
    expect(body.invalidationsRecorded).toBe(0);
    expect(body.verdictCountsTotal).toBe(2);
    expect(String(body.note)).toContain('DARK');
  });

  it('THE DISCRIMINATOR — dark and armed readouts of the SAME rows differ', () => {
    const dark = readRoute();
    process.env.EXIT_RISK_RULES_ENABLED = '1';
    const armed = readRoute();

    // Identical underlying fold...
    expect(armed.sessionsObserved).toBe(dark.sessionsObserved);
    expect(armed.sessions).toEqual(dark.sessions);
    // ...and yet a grader can tell them apart. If these ever serialize the same, the
    // route is blind again and this test is the thing that says so.
    expect(JSON.stringify(armed)).not.toBe(JSON.stringify(dark));
    expect((armed.recorder as Record<string, unknown>).state).toBe('armed_but_stale');
    expect(armed.invalidations).toBe(0); // a real measurement now, not a frozen artifact
    expect(dark.invalidations).toBeNull();
  });

  it('stays ok:FALSE when armed but frozen — a ceiling-only check would pass here', () => {
    process.env.EXIT_RISK_RULES_ENABLED = '1';
    const body = readRoute();
    // `invalidations <= 0` holds, every bucket looks healthy, n is unchanged... and the
    // recorder has written nothing for two completed trading days. THAT is the signal.
    expect(body.invalidations).toBe(0);
    expect(body.ok).toBe(false);
    expect((body.recorder as Record<string, unknown>).staleTradingDays).toBe(2);
    expect(String(body.note)).toContain('STALE');
  });
});

describe('TRA-2269 — the exit-cadence grade is scoped to its subject (rollUpExitCadence)', () => {
  /**
   * `bucketExitInterval(29_999) === 'lt30s'` and `bucketExitInterval(30_000) === 'lt60s'`
   * — the 30s bar sits on a bucket EDGE, so `lt60s` is the first bucket AT the bar.
   */
  function exitHistogram(under30s: number, atOrAbove30s: number): Record<ExitIntervalBucket, number> {
    const h = emptyExitIntervalHistogram();
    h.lt15s = under30s;
    h.lt60s = atOrAbove30s;
    return h;
  }

  /**
   * TRA-3464 — one engine's interlock-region terms, in BOTH scopes.
   *
   * The RTH bins are fully drivable so a test can emit a boundary region, a
   * closed region and a cold-boot region ON DEMAND, and can break
   * `partitionHolds` on purpose. The DEFAULT is the self-consistent case (every
   * lifetime region is an RTH region, nothing excluded), which is what the
   * pre-TRA-3464 fixtures were implicitly asserting when they read the region
   * terms as if they were RTH-scoped — the exact confusion this ticket removes,
   * made explicit here rather than left to position.
   */
  function regionTerms(o: {
    samples: number; sumMs: number; maxMs: number;
    work?: { samples: number; sumMs: number; maxMs: number } | null;
    rth?: Partial<ExitCadenceHealth['tickExitRegionMs']['rth']>;
  }): ExitCadenceHealth['tickExitRegionMs'] {
    const rth = o.rth ?? {};
    const rthSamples = rth.samples ?? o.samples;
    const boundaryRegions = rth.boundaryRegions ?? 0;
    const closedRegions = rth.closedRegions ?? 0;
    const bootRegionMs = rth.bootRegionMs ?? null;
    const bootRegionExcluded = rth.bootRegionExcluded ?? bootRegionMs != null;
    return {
      lastMs: o.samples > 0 ? o.maxMs : null,
      maxMs: o.samples > 0 ? o.maxMs : null,
      samples: o.samples,
      sumMs: o.sumMs,
      atOrAbove20s: 0,
      atOrAbove30s: 0,
      exitWorkMs: o.work ?? null,
      rth: {
        window: 'rth',
        samples: rthSamples,
        sumMs: rth.sumMs ?? o.sumMs,
        maxMs: rth.maxMs !== undefined ? rth.maxMs : (rthSamples > 0 ? o.maxMs : null),
        atOrAbove20s: rth.atOrAbove20s ?? 0,
        atOrAbove30s: rth.atOrAbove30s ?? 0,
        exitWorkMs: rth.exitWorkMs !== undefined ? rth.exitWorkMs : (o.work ?? null),
        boundaryRegions,
        closedRegions,
        bootRegionExcluded,
        bootRegionMs,
        // Computed, not asserted-in: a fixture that hand-set this could publish
        // `partitionHolds: true` over bins that do not add up, which is precisely
        // the thing the flag exists to catch.
        partitionHolds:
          rth.partitionHolds
          ?? (o.samples === rthSamples + boundaryRegions + closedRegions + (bootRegionExcluded ? 1 : 0)),
      },
    };
  }

  function exitEngine(o: {
    engine?: string;
    /** TRA-2645 — `unknown` so a control can drive the `mode: null` / absent-key shapes. */
    mode?: unknown;
    /** TRA-2645 — `unknown` so a control can drive the non-boolean `timerArmed` shape. */
    timerArmed?: unknown;
    lifetime: { under: number; over: number };
    rth: { under: number; over: number };
    rthDecoupled?: number;
    rthTick?: number;
    boundaryIntervals?: number;
    closedIntervals?: number;
    /** TRA-3444 — drive the interlock-region terms so the exit-work split can be controlled in both directions. */
    tickExitRegionMs?: ExitCadenceHealth['tickExitRegionMs'];
  }): ExitCadenceHealth {
    return {
      enabled: true,
      timerArmed: ('timerArmed' in o ? o.timerArmed : true) as boolean,
      intervalMs: 10_000,
      minGapMs: 3_000,
      mode: ('mode' in o ? o.mode : 'demo') as ExitCadenceHealth['mode'],
      engine: o.engine ?? 'admin',
      lastExitPassAt: NOW,
      exitPassCount: o.lifetime.under + o.lifetime.over + 1,
      lastExitIntervalMs: 10_000,
      maxExitIntervalMs: 30_001,
      intervalHistogram: exitHistogram(o.lifetime.under, o.lifetime.over),
      decoupledExitSkippedStalePrices: 0,
      decoupledPassCount: o.rthDecoupled ?? 1,
      tickPassCount: o.rthTick ?? 0,
      decoupledSkips: emptyDecoupledExitSkips(),
      decoupledFireCount: 0,
      tickExitRegionMs: o.tickExitRegionMs ?? regionTerms({ samples: 0, sumMs: 0, maxMs: 0 }),
      rth: {
        intervalHistogram: exitHistogram(o.rth.under, o.rth.over),
        decoupledPassCount: o.rthDecoupled ?? 1,
        tickPassCount: o.rthTick ?? 0,
        boundaryIntervals: o.boundaryIntervals ?? 0,
        closedIntervals: o.closedIntervals ?? 0,
      },
    };
  }

  // The exact scenario from the TRA-2269 filing, in the ticket's own numbers: a
  // PERFECT 6.5h RTH (6.5h / 10s x 10 engines = 23,400 intervals, NONE at or
  // above the bar) plus 22 minutes of closed-market uptime accruing at the
  // rates measured post-close on 2026-07-24 (0.3216 intervals/s, of which
  // 0.1833/s land at or above 30s) => 425 intervals, 242 of them over the bar.
  const PERFECT_RTH_INTERVALS = 23_400;
  const CONTAMINATION_SAMPLES = 425;
  const CONTAMINATION_OVER = 242;
  const contaminatedFleet = () => [exitEngine({
    lifetime: {
      under: PERFECT_RTH_INTERVALS + (CONTAMINATION_SAMPLES - CONTAMINATION_OVER),
      over: CONTAMINATION_OVER,
    },
    rth: { under: PERFECT_RTH_INTERVALS, over: 0 },
    rthDecoupled: 23_000,
    rthTick: 400,
    closedIntervals: CONTAMINATION_SAMPLES,
  })];

  /**
   * TRA-2645 — every fixture in this block is `mode: 'demo'`, so the graded
   * terms these tests are about now live on the DEMO book. There is no
   * top-level graded ratio any more, by construction.
   */
  const demoBook = (body: ExitCadenceRollup) => body.books.demo;

  it('REPRODUCES THE BUG, THEN KILLS IT: 22 min of closed-market uptime forces the LIFETIME ratio FALSE on a PERFECT RTH — and the graded ratio is TRUE', () => {
    const book = demoBook(rollUpExitCadence(contaminatedFleet()));

    // The old, lifetime-scoped number — the one this route used to publish
    // under the name `p99Under30s`. 242 / 23,825 = 1.016% >= 1% => a confident
    // RED on a session in which the hoist did not miss a single interval.
    expect(book.lifetime!.samples).toBe(23_825);
    expect(book.lifetime!.atOrAbove30s).toBe(CONTAMINATION_OVER);
    expect(book.lifetime!.p99Under30s).toBe(false);

    // The graded number, scoped to the window it is a statement about.
    expect(book.samples).toBe(PERFECT_RTH_INTERVALS);
    expect(book.atOrAbove30s).toBe(0);
    expect(book.p99Under30s).toBe(true);
    expect(book.verdict).toBe('bounded');
    expect(book.gradeable).toBe(true);
    expect(book.notGradeableReason).toBeNull();
  });

  it('PARTITIONS rather than filters — every lifetime interval is still accounted for', () => {
    const book = demoBook(rollUpExitCadence(contaminatedFleet()));
    expect(book.rthClosedIntervals).toBe(CONTAMINATION_SAMPLES);
    expect(book.rthBoundaryIntervals).toBe(0);
    expect(book.lifetime!.samples).toBe(
      book.samples! + book.rthBoundaryIntervals! + book.rthClosedIntervals!,
    );
    expect(book.partitionHolds).toBe(true);
  });

  it('POSITIVE CONTROL — it can still emit a RED. A genuinely bad RTH window grades over_bar, gradeable', () => {
    // Without this the fix would be a whitewash: an instrument that can only
    // ever say PASS is not an instrument. 300 / 23,400 = 1.28% >= 1%, and
    // every one of those intervals has BOTH endpoints inside RTH.
    const book = demoBook(rollUpExitCadence([exitEngine({
      lifetime: { under: PERFECT_RTH_INTERVALS - 300, over: 300 },
      rth: { under: PERFECT_RTH_INTERVALS - 300, over: 300 },
      rthDecoupled: 23_000,
      rthTick: 400,
    })]));
    expect(book.p99Under30s).toBe(false);
    expect(book.verdict).toBe('over_bar');
    expect(book.gradeable).toBe(true);
    expect(book.notGradeableReason).toBeNull();
  });

  it('REFUSES the pure post-close read — the live 2026-07-24 state — and names the lifetime count it declined to grade', () => {
    // 293 samples, 167 at or above the bar, ZERO with both endpoints in RTH.
    // The pre-TRA-2269 route published 57% over the bar as a graded ratio.
    const book = demoBook(rollUpExitCadence([exitEngine({
      lifetime: { under: 126, over: 167 },
      rth: { under: 0, over: 0 },
      rthDecoupled: 0,
      rthTick: 0,
      closedIntervals: 293,
    })]));
    expect(book.samples).toBe(0);
    expect(book.p99Under30s).toBeNull();
    expect(book.verdict).toBe('armed_but_no_rth_interval');
    expect(book.gradeable).toBe(false);
    expect(String(book.notGradeableReason)).toContain('293');
    // And the lifetime figure is still published — it is a real fact about the
    // exit path, just not a verdict on the hoist.
    expect(book.lifetime!.p99Under30s).toBe(false);
  });

  it('keeps armed_but_no_interval_measured for the genuinely empty case — "nothing measured" and "nothing IN WINDOW" are different facts', () => {
    const book = demoBook(rollUpExitCadence([exitEngine({
      lifetime: { under: 0, over: 0 },
      rth: { under: 0, over: 0 },
      rthDecoupled: 0,
    })]));
    expect(book.verdict).toBe('armed_but_no_interval_measured');
    expect(book.gradeable).toBe(false);
    expect(String(book.notGradeableReason)).toBe('no exit interval measured yet');
  });

  it('DENOMINATOR PURITY: RTH intervals that doTick closed do not grade the hoist', () => {
    // TRA-2257 gated on "did the subject run at all" — one decoupled pass
    // anywhere flipped `gradeable` true. Here the timer ran 100 times and
    // doTick closed 900 of the 1,000 graded intervals: nominally in-window,
    // but the cadence on show is doTick's.
    const book = demoBook(rollUpExitCadence([exitEngine({
      lifetime: { under: 1_000, over: 0 },
      rth: { under: 1_000, over: 0 },
      rthDecoupled: 100,
      rthTick: 900,
    })]));
    expect(book.rthDecoupledShare).toBeCloseTo(0.1, 10);
    expect(book.verdict).toBe('tick_dominated_window');
    expect(book.gradeable).toBe(false);
    expect(String(book.notGradeableReason)).toContain('100/1000');
    // ...and it does NOT trip on a healthy armed session, where the 10s timer
    // outruns doTick's 120-280s wall-clock by an order of magnitude.
    const healthy = demoBook(rollUpExitCadence(contaminatedFleet()));
    expect(healthy.rthDecoupledShare!).toBeGreaterThan(RTH_DECOUPLED_SHARE_FLOOR);
    expect(healthy.gradeable).toBe(true);
  });

  it('disarmed still outranks everything — a fleet with no timer grades nothing', () => {
    const book = demoBook(rollUpExitCadence([exitEngine({
      timerArmed: false,
      lifetime: { under: 1_000, over: 0 },
      rth: { under: 1_000, over: 0 },
      rthDecoupled: 900,
    })]));
    expect(book.verdict).toBe('disarmed');
    expect(book.gradeable).toBe(false);
    expect(book.enabled).toBe(false);
  });

  it('sums the RTH histogram across engines — one sick engine is not averaged away', () => {
    const book = demoBook(rollUpExitCadence([
      exitEngine({ engine: 'a', lifetime: { under: 500, over: 0 }, rth: { under: 500, over: 0 }, rthDecoupled: 500 }),
      exitEngine({ engine: 'b', lifetime: { under: 480, over: 20 }, rth: { under: 480, over: 20 }, rthDecoupled: 500 }),
    ]));
    expect(book.samples).toBe(1_000);
    expect(book.atOrAbove30s).toBe(20);
    // 20 / 1,000 = 2% — the healthy engine does not rescue the sick one.
    expect(book.p99Under30s).toBe(false);
    expect(book.verdict).toBe('over_bar');
  });

  it('publishes `window: "rth"` so a reader can FAIL CLOSED on a pre-TRA-2269 build', () => {
    // The route is unauthenticated and read by scripts that cannot see which
    // bytes answered them. Absence of this marker means the `p99Under30s` in
    // hand is the contaminated lifetime ratio.
    const body = rollUpExitCadence(contaminatedFleet());
    expect(body.window).toBe('rth');
    expect(String(body.note)).toContain('window');
  });

  it('the mounted route carries the graded fields and the marker through to the payload', () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: ((_q: unknown, _s: unknown, n: () => void) => n()) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
      exitCadence: () => contaminatedFleet(),
    });
    const handlers = routes.get('/api/health/exit-cadence')!;
    expect(handlers).toHaveLength(1);  // unauthenticated, like the rest of /api/health/*
    const res = fakeRes();
    handlers[0]!({}, res);
    const body = res.body as ExitCadenceRollup & { ok: boolean; engines: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.window).toBe('rth');
    expect(body.partitionedBy).toBe('mode');
    expect(body.books.demo.p99Under30s).toBe(true);
    expect(body.books.demo.lifetime!.p99Under30s).toBe(false);
    expect(body.engines.length).toBe(1);
  });

  // ── TRA-2645 ───────────────────────────────────────────────────────────────
  //
  // The instrument was scoped to the wrong POPULATION, which is the axis one out
  // from TRA-2269's window. `enabled: armed.length > 0` was an OR over a
  // mixed-mode fleet, so 57 armed demo engines published `enabled: true` over an
  // unhoisted live book; `disarmed` could not be emitted while any demo engine
  // was armed; and the graded ratio pooled two books that share no broker, no
  // capital and no flag source.
  //
  // CONTROLS IN BOTH DIRECTIONS, per the standing rule. The known-bad must fire
  // (a live book that disagrees is visible) AND the known-good must stay quiet
  // (a healthy live book grades clean) AND — the one that matters here — the
  // VACUOUS case must be BLIND rather than a free pass. The fixtures are the two
  // shapes from `tra1648_live_exit_arm_controls.mjs`: the verbatim 58-demo/0-live
  // payload TRA-2607 was filed on, and the 57-demo/1-live shape measured live on
  // bqb1 at 2026-07-30T04:19:56Z.
  describe('TRA-2645 — the readout is partitioned by book, and the aggregate refuses', () => {
    const demoFleet = (n: number, armed = true) =>
      Array.from({ length: n }, (_, i) => exitEngine({
        engine: `engine-${i + 2}`,
        timerArmed: armed,
        lifetime: { under: 1_000, over: 0 },
        rth: { under: 1_000, over: 0 },
        rthDecoupled: 990,
        rthTick: 10,
      }));

    const liveEngine = (o: {
      timerArmed?: unknown;
      mode?: unknown;
      lifetime?: { under: number; over: number };
      rth?: { under: number; over: number };
      rthDecoupled?: number;
      rthTick?: number;
      closedIntervals?: number;
    } = {}) => exitEngine({
      engine: 'engine-1',
      mode: 'mode' in o ? o.mode : 'live',
      timerArmed: 'timerArmed' in o ? o.timerArmed : false,
      lifetime: o.lifetime ?? { under: 0, over: 0 },
      rth: o.rth ?? { under: 0, over: 0 },
      rthDecoupled: o.rthDecoupled ?? 0,
      rthTick: o.rthTick ?? 0,
      closedIntervals: o.closedIntervals ?? 0,
    });

    /** The real 2026-07-30T04:19:56Z bqb1 shape: 1 live UNARMED + 57 demo ARMED. */
    const TODAY = () => [liveEngine(), ...demoFleet(57, true)];
    /** The payload TRA-2607 was filed on: 58 engines, ALL demo, all armed, ZERO live. */
    const FILED_ON = () => demoFleet(58, true);

    it('REPRODUCES THE BUG, THEN KILLS IT — the live book is a first-class line, not a member of a sum', () => {
      const body = rollUpExitCadence(TODAY());

      // What the OLD readout published on this exact fleet, and why it was a lie:
      // `enabled: armed.length > 0` = true, `armedEngineCount: 57`,
      // `engineCount: 58` — while the only engine carrying money was the ONE
      // unarmed engine in it. There is no unscoped `enabled` left to read.
      expect(body).not.toHaveProperty('enabled');
      expect(body).not.toHaveProperty('armedEngineCount');

      // The live book, scoped and named.
      expect(body.liveEnabled).toBe(false);
      expect(body.liveArmedEngineCount).toBe(0);
      expect(body.liveEngineCount).toBe(1);
      expect(body.books.live.blind).toBe(false);
      expect(body.books.live.enabled).toBe(false);

      // The demo book, scoped and named, and its 57 armed engines no longer
      // vote on the live book's answer.
      expect(body.demoEnabled).toBe(true);
      expect(body.demoArmedEngineCount).toBe(57);
      expect(body.demoEngineCount).toBe(57);
      expect(body.engineCount).toBe(58);
    });

    it('AC3 — `disarmed` is REACHABLE per book: an unarmed live engine beside 57 armed demo engines grades the live book disarmed', () => {
      // Structurally unreachable before: `armed.length === 0` could not hold
      // while any demo engine was armed, INCLUDING in the world where every
      // live engine is disarmed — which was the world we were actually in.
      const body = rollUpExitCadence(TODAY());
      expect(body.books.live.verdict).toBe('disarmed');
      expect(body.books.live.gradeable).toBe(false);
      expect(String(body.books.live.notGradeableReason)).toContain('mode=live');
      // ...and the demo book is untouched by that verdict, in the same payload.
      expect(body.books.demo.verdict).toBe('bounded');
      expect(body.books.demo.gradeable).toBe(true);
    });

    it('AC4 — an EMPTY live population is BLIND, never a free pass (the verbatim payload TRA-2607 was filed on)', () => {
      const body = rollUpExitCadence(FILED_ON());
      expect(body.liveEngineCount).toBe(0);
      expect(body.books.live.blind).toBe(true);
      expect(body.books.live.verdict).toBe('no_engine_in_book');
      expect(body.books.live.gradeable).toBe(false);
      // Every graded term NULL, not 0 — a zero reads like a measurement.
      expect(body.books.live.enabled).toBeNull();
      expect(body.books.live.armedEngineCount).toBeNull();
      expect(body.books.live.samples).toBeNull();
      expect(body.books.live.p99Under30s).toBeNull();
      expect(body.books.live.intervalHistogram).toBeNull();
      expect(body.liveEnabled).toBeNull();
      expect(String(body.books.live.blindReason)).toContain('FOR FREE');
      // The demo book still grades — a blind live book does not blind the fleet.
      expect(body.books.demo.blind).toBe(false);
      expect(body.books.demo.armedEngineCount).toBe(58);
    });

    it('AC4 — `mode: null` blinds BOTH books rather than being filed as demo (`\'mode\' in e` passes on an explicit null)', () => {
      const body = rollUpExitCadence([liveEngine(), { ...liveEngine(), engine: 'engine-x', mode: null as never }, ...demoFleet(3)]);
      expect(body.unknownModeEngineCount).toBe(1);
      expect(body.books.live.verdict).toBe('unreadable_partition');
      expect(body.books.demo.verdict).toBe('unreadable_partition');
      expect(body.books.live.blind).toBe(true);
      expect(body.books.demo.blind).toBe(true);
      expect(body.liveEnabled).toBeNull();
      expect(body.demoEnabled).toBeNull();
      // The engine of unknown book is NOT counted into either population.
      expect(body.liveEngineCount).toBe(1);
      expect(body.demoEngineCount).toBe(3);
      expect(body.engineCount).toBe(5);
    });

    it('AC4 — an ABSENT `mode` key blinds too, and a non-boolean `timerArmed` blinds only that book', () => {
      const noMode = rollUpExitCadence([liveEngine(), exitEngine({ engine: 'engine-x', mode: undefined, lifetime: { under: 0, over: 0 }, rth: { under: 0, over: 0 } })]);
      expect(noMode.unknownModeEngineCount).toBe(1);
      expect(noMode.books.live.verdict).toBe('unreadable_partition');

      // "I cannot see the arm state" must never be published as "the hoist is
      // disarmed" — right verdict, wrong cause, wrong human paged.
      const noArm = rollUpExitCadence([liveEngine({ timerArmed: null }), ...demoFleet(2)]);
      expect(noArm.books.live.verdict).toBe('unreadable_arm_state');
      expect(noArm.books.live.blind).toBe(true);
      expect(noArm.liveEnabled).toBeNull();
      expect(noArm.books.demo.blind).toBe(false);
      expect(noArm.books.demo.verdict).toBe('bounded');
    });

    it('KNOWN-GOOD, the other direction — a healthy ARMED live book grades clean and is NOT diluted by a sick demo fleet', () => {
      // The instrument must be able to say PASS about the live book, or it is
      // a rubber stamp with an alarm attached. 0 / 1,000 at or above the bar on
      // the live engine, 400 / 1,000 (40%, a hard RED) on the demo fleet.
      const body = rollUpExitCadence([
        liveEngine({
          timerArmed: true,
          lifetime: { under: 1_000, over: 0 },
          rth: { under: 1_000, over: 0 },
          rthDecoupled: 990,
          rthTick: 10,
        }),
        exitEngine({ engine: 'engine-2', lifetime: { under: 600, over: 400 }, rth: { under: 600, over: 400 }, rthDecoupled: 990, rthTick: 10 }),
      ]);
      expect(body.books.live.verdict).toBe('bounded');
      expect(body.books.live.p99Under30s).toBe(true);
      expect(body.books.live.gradeable).toBe(true);
      expect(body.books.live.samples).toBe(1_000);
      expect(body.books.live.atOrAbove30s).toBe(0);
      // ...and the demo book's 40% does NOT leak into it. Pooled, the fleet
      // would have read 400 / 2,000 = 20% and condemned the live book.
      expect(body.books.demo.verdict).toBe('over_bar');
      expect(body.books.demo.p99Under30s).toBe(false);
    });

    it('KNOWN-BAD, the other direction — a live book OVER the bar is visible even while the demo fleet is clean', () => {
      // The mirror of the case above, and the one the pooled ratio hid: a live
      // engine 1-in-58 cannot move a fleet-wide denominator.
      const body = rollUpExitCadence([
        liveEngine({
          timerArmed: true,
          lifetime: { under: 900, over: 100 },
          rth: { under: 900, over: 100 },
          rthDecoupled: 990,
          rthTick: 10,
        }),
        ...demoFleet(57, true),
      ]);
      expect(body.books.live.p99Under30s).toBe(false);
      expect(body.books.live.verdict).toBe('over_bar');
      expect(body.books.live.gradeable).toBe(true);
      expect(body.books.demo.verdict).toBe('bounded');
      // Pooled — the OLD behaviour — 100 at-or-above out of 58,000 samples is
      // 0.17%, comfortably UNDER the 1% bar. The defect, in one number.
      const pooledSamples = body.books.live.samples! + body.books.demo.samples!;
      const pooledOver = body.books.live.atOrAbove30s! + body.books.demo.atOrAbove30s!;
      expect(pooledOver / pooledSamples).toBeLessThan(0.01);
    });

    it('AC2 — the AGGREGATE REFUSES: no pooled graded term survives, and the refusal names where to read instead', () => {
      const body = rollUpExitCadence(TODAY());
      expect(body.verdict).toBe('partitioned_by_book');
      expect(body.gradeable).toBe(false);
      expect(body.notGradeableReason).toContain('books.live');
      expect(body.notGradeableReason).toContain('books.demo');
      for (const pooled of [
        'enabled', 'armedEngineCount', 'samples', 'atOrAbove30s', 'p99Under30s',
        'intervalHistogram', 'lifetime', 'rthDecoupledPassCount', 'rthTickPassCount',
        'rthDecoupledShare', 'rthBoundaryIntervals', 'rthClosedIntervals', 'partitionHolds',
      ]) {
        expect(body).not.toHaveProperty(pooled);
      }
    });

    it('publishes `partitionedBy: "mode"` so a reader can FAIL CLOSED on a pre-TRA-2645 build', () => {
      // Same contract as `window` (TRA-2269). The route is unauthenticated and
      // read by scripts that cannot see which bytes answered them; absence of
      // this marker means the payload in hand is the book-pooled one.
      const body = rollUpExitCadence(TODAY());
      expect(body.partitionedBy).toBe('mode');
      expect(body.note).toContain('partitionedBy');
      expect(body.note).toContain('no_engine_in_book');
    });

    it('leaves the fleet-summed `tickExitRegionMs` alone — TRA-2305/TRA-2268 grade that exact accumulator', () => {
      // Moving it per-book would silently change someone else's subject. It is
      // published fleet-scoped at the top level AND per book, additively.
      const body = rollUpExitCadence(TODAY());
      expect(body.tickExitRegionMs.samples).toBe(0);
      expect(body.books.live.tickExitRegionMs).not.toBeNull();
      expect(body.decoupledFireCount).toBe(0);
    });

    // ── TRA-3444 — the UNCENSORED exit-work split ───────────────────────────
    //
    // TRA-2268 has to decide whether narrowing `tickExitRegionActive` is safe,
    // and needs to know how much of the region is exit-critical work versus
    // prefix. The `signal.doTick` phase tape cannot tell it: `recordPhaseDuration`
    // is a no-op below PHASE_TIMING_SLOW_MS, so an ABSENT phase and a phase that
    // ran every tick at 999ms are byte-identical, and on the 2026-08-12 RTH tape
    // the split was bounded only to [16,262s, 253,213s] — a factor of 15.6.
    //
    // These are the two-directional controls on the replacement: the route must
    // be able to publish a real split AND to refuse when it has no measurement,
    // and the refusal must be `null`, not a zero that reads like a measurement.
    describe('TRA-3444 exit-work split', () => {
      // TRA-3464 — these fixtures put every region in the RTH bin, which is what
      // TRA-3444's split was always ABOUT ("the RTH-scoped PREFIX/exit-work
      // split", `exit-cadence-snapshot.ts`). Before this ticket the field these
      // tests read was the lifetime accumulator and the RTH scoping was
      // asserted only in prose; now the fixture states it.
      const region = regionTerms;

      it('publishes `exitWorkMs` under BOTH books and at the fleet level', () => {
        const body = rollUpExitCadence([
          exitEngine({
            engine: 'live-1', mode: 'live', lifetime: { under: 10, over: 0 }, rth: { under: 10, over: 0 },
            tickExitRegionMs: region({ samples: 900, sumMs: 6_300_000, maxMs: 15_876, work: { samples: 900, sumMs: 810_000, maxMs: 4_100 } }),
          }),
          exitEngine({
            engine: 'demo-1', mode: 'demo', lifetime: { under: 10, over: 0 }, rth: { under: 10, over: 0 },
            tickExitRegionMs: region({ samples: 400, sumMs: 2_800_000, maxMs: 27_796, work: { samples: 400, sumMs: 200_000, maxMs: 9_000 } }),
          }),
        ]);

        // Partitioned like its sibling — an unpartitioned figure is the defect
        // TRA-2645 removed and TRA-2677 re-litigated.
        expect(body.books.live.tickExitRegionMs!.exitWorkMs).toEqual({ samples: 900, sumMs: 810_000, maxMs: 4_100 });
        expect(body.books.demo.tickExitRegionMs!.exitWorkMs).toEqual({ samples: 400, sumMs: 200_000, maxMs: 9_000 });
        // Fleet roll-up sums the counters and takes the max of the maxes.
        expect(body.tickExitRegionMs.exitWorkMs).toEqual({ samples: 1_300, sumMs: 1_010_000, maxMs: 9_000 });

        // THE POINT OF THE TICKET: the split is now computable, exactly, with no
        // threshold anywhere in it. The live book's region was 12.9% exit-critical.
        const live = body.books.live.tickExitRegionMs!;
        expect(live.sumMs - live.exitWorkMs!.sumMs).toBe(5_490_000);
        expect(live.exitWorkMs!.sumMs / live.sumMs).toBeCloseTo(0.1286, 4);
      });

      it('CONTAINMENT: exit work never exceeds the region time that contains it', () => {
        const body = rollUpExitCadence([
          exitEngine({
            engine: 'live-1', mode: 'live', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 },
            tickExitRegionMs: region({ samples: 900, sumMs: 6_300_000, maxMs: 15_876, work: { samples: 900, sumMs: 810_000, maxMs: 4_100 } }),
          }),
          exitEngine({
            engine: 'demo-1', mode: 'demo', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 },
            tickExitRegionMs: region({ samples: 400, sumMs: 2_800_000, maxMs: 27_796, work: { samples: 400, sumMs: 200_000, maxMs: 9_000 } }),
          }),
        ]);
        for (const terms of [body.tickExitRegionMs, body.books.live.tickExitRegionMs!, body.books.demo.tickExitRegionMs!]) {
          expect(terms.exitWorkMs!.sumMs).toBeLessThanOrEqual(terms.sumMs);
          expect(terms.exitWorkMs!.maxMs).toBeLessThanOrEqual(terms.maxMs!);
          // One sample per closed region, so the split is over ONE population.
          expect(terms.exitWorkMs!.samples).toBe(terms.samples);
        }
      });

      it('refuses with NULL before the first sample — never 0-for-absent', () => {
        const body = rollUpExitCadence([
          exitEngine({ engine: 'live-1', mode: 'live', lifetime: { under: 1, over: 0 }, rth: { under: 1, over: 0 } }),
          exitEngine({ engine: 'demo-1', mode: 'demo', lifetime: { under: 1, over: 0 }, rth: { under: 1, over: 0 } }),
        ]);
        expect(body.books.live.tickExitRegionMs!.exitWorkMs).toBeNull();
        expect(body.books.demo.tickExitRegionMs!.exitWorkMs).toBeNull();
        expect(body.tickExitRegionMs.exitWorkMs).toBeNull();
        // A 0 here would be read as "the region does no exit-critical work",
        // which is the single most expensive wrong answer this route can give
        // TRA-2268: it would make narrowing the interlock look free.
        expect(body.books.live.tickExitRegionMs!.exitWorkMs).not.toEqual({ samples: 0, sumMs: 0, maxMs: 0 });
      });

      it('DROPS an engine that cannot answer rather than folding it in as a zero', () => {
        // One engine with 900 regions behind it, one that booted a second ago.
        // Counting the newcomer as 0 would halve the published exit-work share
        // of a fleet where 57 of 58 engines are freshly booted.
        const body = rollUpExitCadence([
          exitEngine({
            engine: 'demo-1', mode: 'demo', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 },
            tickExitRegionMs: region({ samples: 900, sumMs: 6_300_000, maxMs: 15_876, work: { samples: 900, sumMs: 810_000, maxMs: 4_100 } }),
          }),
          exitEngine({
            engine: 'demo-2', mode: 'demo', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 },
            tickExitRegionMs: region({ samples: 0, sumMs: 0, maxMs: 0, work: null }),
          }),
        ]);
        expect(body.books.demo.tickExitRegionMs!.exitWorkMs).toEqual({ samples: 900, sumMs: 810_000, maxMs: 4_100 });
      });
    });

    // TRA-3464 — `books.<book>.tickExitRegionMs` USED TO BE the fleet-summed
    // lifetime accumulator copied one level down and emitted as a sibling of the
    // RTH-only terms. A per-book copy of a fleet field is not a partition: it
    // mislabels the accumulator BY POSITION, and position is the only label most
    // readers ever read.
    //
    // The measured proof, bqb1 `10e68acf9c2e` 2026-08-13 — a book reporting ZERO
    // RTH intervals and refusing to grade published 6810 region samples one key
    // over, under a payload whose top level said `window: "rth"`:
    //
    //     books.demo.samples                  = 0
    //     books.demo.verdict                  = "armed_but_no_rth_interval"
    //     books.demo.tickExitRegionMs.samples = 6810
    describe('TRA-3464 — the region terms are RTH-scoped per book, and the lifetime ones are demoted', () => {
      it('reproduces the filing shape and shows it FIXED: 0 RTH intervals no longer publishes lifetime regions at the RTH level', () => {
        const body = rollUpExitCadence([
          exitEngine({
            engine: 'demo-1', mode: 'demo',
            lifetime: { under: 6_748, over: 0 }, rth: { under: 0, over: 0 },
            tickExitRegionMs: regionTerms({
              samples: 6_810, sumMs: 1_300_953, maxMs: 15_772,
              // Post-close boot: one cold-boot region, the rest closed-market.
              rth: { samples: 0, sumMs: 0, maxMs: null, closedRegions: 6_809, bootRegionMs: 4_200, exitWorkMs: null },
            }),
          }),
        ]);
        const demo = body.books.demo;
        expect(demo.verdict).toBe('armed_but_no_rth_interval');
        expect(demo.samples).toBe(0);
        // THE FIX. The RTH-level field now agrees with its RTH-level siblings.
        expect(demo.tickExitRegionMs!.window).toBe('rth');
        expect(demo.tickExitRegionMs!.samples).toBe(0);
        expect(demo.tickExitRegionMs!.maxMs).toBeNull();
        expect(demo.tickExitRegionMs!.exitWorkMs).toBeNull();
        // The numbers are NOT gone. They MOVED, unchanged.
        expect(demo.lifetime!.tickExitRegionMs.samples).toBe(6_810);
        expect(demo.lifetime!.tickExitRegionMs.maxMs).toBe(15_772);
        // And the excluded regions are visible rather than vanished.
        expect(demo.tickExitRegionMs!.closedRegions).toBe(6_809);
        expect(demo.tickExitRegionMs!.bootRegionExcluded).toBe(true);
        expect(demo.tickExitRegionMs!.bootRegionsExcluded).toBe(1);
        expect(demo.tickExitRegionMs!.bootRegionMaxMs).toBe(4_200);
        expect(demo.tickExitRegionMs!.partitionHolds).toBe(true);
      });

      it('does not let the DEMO book\'s regions reach the LIVE book\'s RTH terms', () => {
        // The other axis of the same defect. The published fleet `maxMs 14121`
        // on 2026-08-13 was the LIVE book's max wearing an unscoped name; the
        // reverse — a fat demo region setting a live max — is the direction that
        // would put a false RED on the money book.
        const body = rollUpExitCadence([
          exitEngine({
            engine: 'live-1', mode: 'live', lifetime: { under: 10, over: 0 }, rth: { under: 10, over: 0 },
            tickExitRegionMs: regionTerms({ samples: 334, sumMs: 900_000, maxMs: 5_000, rth: { samples: 333, bootRegionMs: 800, sumMs: 899_200, maxMs: 5_000 } }),
          }),
          exitEngine({
            engine: 'demo-1', mode: 'demo', lifetime: { under: 10, over: 0 }, rth: { under: 10, over: 0 },
            tickExitRegionMs: regionTerms({ samples: 6_810, sumMs: 1_300_953, maxMs: 14_121, rth: { samples: 6_809, bootRegionMs: 900, sumMs: 1_300_053, maxMs: 14_121 } }),
          }),
        ]);
        expect(body.books.live.tickExitRegionMs!.maxMs).toBe(5_000);
        expect(body.books.demo.tickExitRegionMs!.maxMs).toBe(14_121);
        // The deprecated top-level spelling still carries the unscoped max — it
        // is deleted in the next deploy generation, and this asserts WHY.
        expect(body.tickExitRegionMs.maxMs).toBe(14_121);
        expect(body.tickExitRegionMs.samples).toBe(334 + 6_810);
      });

      it('counts one boot exclusion PER ENGINE and closes the partition over the whole book', () => {
        // A book has up to 57 engines and each drops its own cold-boot region.
        // A boolean cannot be summed, so `bootRegionsExcluded` is the term the
        // partition needs; `bootRegionMaxMs` / `bootRegionSumMs` are named as
        // aggregates rather than as a bare `bootRegionMs`, because an unscoped
        // scalar over N engines is this ticket's own defect.
        const body = rollUpExitCadence([
          exitEngine({
            engine: 'demo-1', mode: 'demo', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 },
            tickExitRegionMs: regionTerms({ samples: 10, sumMs: 50_000, maxMs: 9_000, rth: { samples: 6, boundaryRegions: 2, closedRegions: 1, bootRegionMs: 9_000 } }),
          }),
          exitEngine({
            engine: 'demo-2', mode: 'demo', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 },
            tickExitRegionMs: regionTerms({ samples: 4, sumMs: 20_000, maxMs: 3_000, rth: { samples: 1, boundaryRegions: 1, closedRegions: 1, bootRegionMs: 2_500 } }),
          }),
        ]);
        const r = body.books.demo.tickExitRegionMs!;
        expect(r.bootRegionsExcluded).toBe(2);
        expect(r.bootRegionMaxMs).toBe(9_000);
        expect(r.bootRegionSumMs).toBe(11_500);
        // 14 === 7 + 3 + 2 + 2
        expect(body.books.demo.lifetime!.tickExitRegionMs.samples).toBe(14);
        expect(r.samples).toBe(7);
        expect(r.boundaryRegions).toBe(3);
        expect(r.closedRegions).toBe(2);
        expect(r.partitionHolds).toBe(true);
      });

      it('BREAKS `partitionHolds` when an engine loses a region — the flag is controllable in both directions', () => {
        // A flag observed only true has been shown to be quiet, not to work.
        const body = rollUpExitCadence([
          exitEngine({
            engine: 'demo-1', mode: 'demo', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 },
            // 10 lifetime regions, but the bins only account for 8 (6+1+0+boot).
            tickExitRegionMs: regionTerms({ samples: 10, sumMs: 50_000, maxMs: 9_000, rth: { samples: 6, boundaryRegions: 1, closedRegions: 0, bootRegionMs: 900 } }),
          }),
        ]);
        expect(body.books.demo.tickExitRegionMs!.partitionHolds).toBe(false);
      });

      it('REFUSES a book-level true that two cancelling engines would sum into', () => {
        // The summed identity alone is satisfiable by a population in which NO
        // member satisfies it: engine A over-counts by 2, engine B under-counts
        // by 2. An aggregate invariant a mixed population can pass while every
        // member fails is not an invariant, so `partitionHolds` requires BOTH
        // arms.
        const body = rollUpExitCadence([
          exitEngine({
            engine: 'demo-1', mode: 'demo', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 },
            tickExitRegionMs: regionTerms({ samples: 10, sumMs: 10, maxMs: 1, rth: { samples: 11, boundaryRegions: 0, closedRegions: 0, bootRegionMs: 1, partitionHolds: false } }),
          }),
          exitEngine({
            engine: 'demo-2', mode: 'demo', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 },
            tickExitRegionMs: regionTerms({ samples: 10, sumMs: 10, maxMs: 1, rth: { samples: 7, boundaryRegions: 0, closedRegions: 0, bootRegionMs: 1, partitionHolds: false } }),
          }),
        ]);
        const r = body.books.demo.tickExitRegionMs!;
        // The SUMMED identity passes: 20 === 18 + 0 + 0 + 2.
        expect(body.books.demo.lifetime!.tickExitRegionMs.samples).toBe(20);
        expect(r.samples + r.boundaryRegions + r.closedRegions + r.bootRegionsExcluded).toBe(20);
        // The published flag does NOT.
        expect(r.partitionHolds).toBe(false);
      });

      it('nulls every new term on a BLIND book — never a 0, which reads like a measurement', () => {
        const body = rollUpExitCadence([]);
        expect(body.books.live.blind).toBe(true);
        expect(body.books.live.tickExitRegionMs).toBeNull();
        expect(body.books.live.lifetime).toBeNull();
        expect(body.books.demo.tickExitRegionMs).toBeNull();
        expect(body.books.demo.lifetime).toBeNull();
      });

      it('publishes `window: "rth"` as a LITERAL so a reader can fail closed on a pre-TRA-3464 build', () => {
        // The marker is the whole reason the defect was catchable at all: a
        // payload whose `books.<book>.tickExitRegionMs` carries no `window` key
        // is the old build, where that field IS the lifetime accumulator.
        const body = rollUpExitCadence([
          exitEngine({ engine: 'live-1', mode: 'live', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 } }),
          exitEngine({ engine: 'demo-1', mode: 'demo', lifetime: { under: 5, over: 0 }, rth: { under: 5, over: 0 } }),
        ]);
        expect(body.books.live.tickExitRegionMs!.window).toBe('rth');
        expect(body.books.demo.tickExitRegionMs!.window).toBe('rth');
        // …and the lifetime block deliberately does NOT carry it: it is not RTH,
        // and a `window` key there would rebuild the ambiguity one level down.
        expect(body.books.live.lifetime!.tickExitRegionMs).not.toHaveProperty('window');
      });
    });
  });
});

// ── TRA-2590 — the (structure × exitReason) cross-tab + left-tail R histogram ──
//
// TRA-2213 leg 2 has to grade TRA-2202's invalidation criterion:
//
//   `single_leg_otm` `sl` exits show ZERO closes below -0.50R across >=117 stop exits.
//
// The deployed route published `byStructure` and `byExitReason` as SEPARATE
// marginals plus `avgR`, and NEITHER can answer that. These tests are the
// two-directional control on the new instrument: each one pins a book where the
// OLD readout gives a specific WRONG answer and asserts the new cell gives the
// right one — and, in the other direction, that a CLEAN book still reads clean.
describe('TRA-2590 option-journal structure x exitReason cross-tab', () => {
  function jrow(
    over: Partial<OptionTradeJournalRecord> & { id: string },
  ): OptionTradeJournalRecord {
    return {
      openTs: NOW - 3_600_000,
      symbol: 'JACK',
      structure: 'single_leg_otm',
      mode: 'demo',
      ivRank: null,
      trend: 'up',
      sentiment: null,
      entryDelta: 0.45,
      entryDte: 30,
      atRiskUsd: 200,
      agentConviction: null,
      outcome: 'LOSS',
      closeTs: NOW,
      realizedPnlUsd: -100,
      realizedR: -0.5,
      exitReason: 'sl',
      holdDays: 1,
      account: 'admin',
      ...over,
    } as OptionTradeJournalRecord;
  }

  function deskCell(rows: OptionTradeJournalRecord[], structure: string, exitReason: string) {
    const tab = buildOptionJournalReport(rows, NOW, true).summary.byAccountClass.desk
      .byStructureExit;
    return {
      tab,
      cell: tab.cells.find((c) => c.structure === structure && c.exitReason === exitReason),
    };
  }

  // ── Direction 1: the marginals give a WRONG number and the cell gives the right one ──

  it('the cell is NOT recoverable from the marginals — multiplying them gives 2, the truth is 4', () => {
    // 8 desk closes. The single_leg_otm x sl cell holds 4 of them, but the
    // marginals only say "4 otm rows" and "4 sl rows" out of 8, whose product
    // under an independence assumption is 4*4/8 = 2. The estimate is off by 2x
    // and nothing in the old payload says so. An estimate cannot certify.
    const rows = [
      jrow({ id: 'a1', structure: 'single_leg_otm', exitReason: 'sl' }),
      jrow({ id: 'a2', structure: 'single_leg_otm', exitReason: 'sl' }),
      jrow({ id: 'a3', structure: 'single_leg_otm', exitReason: 'sl' }),
      jrow({ id: 'a4', structure: 'single_leg_otm', exitReason: 'sl' }),
      jrow({ id: 'b1', structure: 'single_leg_rv', exitReason: 'time_stop' }),
      jrow({ id: 'b2', structure: 'single_leg_rv', exitReason: 'time_stop' }),
      jrow({ id: 'b3', structure: 'single_leg_rv', exitReason: 'time_stop' }),
      jrow({ id: 'b4', structure: 'single_leg_rv', exitReason: 'time_stop' }),
    ];
    const report = buildOptionJournalReport(rows, NOW, true);
    const desk = report.summary.byAccountClass.desk;

    const otmMarginal = desk.byStructure.find((s) => s.structure === 'single_leg_otm')!.closed;
    const slMarginal = desk.byExitReason.find((e) => e.exitReason === 'sl')!.closed;
    expect((otmMarginal * slMarginal) / desk.closed).toBe(2); // the ESTIMATE

    const { cell } = deskCell(rows, 'single_leg_otm', 'sl');
    expect(cell!.closed).toBe(4); // the MEASUREMENT
  });

  it('a MEAN cannot see the left tail — two books with the SAME avgR differ 0 vs 2 violations', () => {
    // This is the amber flag from the live desk read (avgR = -0.4991 over n=5):
    // exactly on the threshold, which is where a mean is least informative.
    const clean = [
      jrow({ id: 'c1', realizedR: -0.5 }),
      jrow({ id: 'c2', realizedR: -0.5 }),
      jrow({ id: 'c3', realizedR: -0.5 }),
      jrow({ id: 'c4', realizedR: -0.5 }),
    ];
    // Same mean (-0.5), same n, same cell — but half the closes blew through.
    const dirty = [
      jrow({ id: 'd1', realizedR: 0 }),
      jrow({ id: 'd2', realizedR: 0 }),
      jrow({ id: 'd3', realizedR: -1.0 }),
      jrow({ id: 'd4', realizedR: -1.0 }),
    ];

    const a = deskCell(clean, 'single_leg_otm', 'sl');
    const b = deskCell(dirty, 'single_leg_otm', 'sl');

    // The mean is IDENTICAL. This is the assertion that makes the histogram
    // necessary rather than merely nice: without it the two books are the same
    // number, and one of them invalidates TRA-2202 while the other confirms it.
    expect(a.cell!.avgR).toBe(-0.5);
    expect(b.cell!.avgR).toBe(-0.5);

    expect(a.cell!.closesBelowMinus050R).toBe(0);
    expect(b.cell!.closesBelowMinus050R).toBe(2);
    expect(a.cell!.minR).toBe(-0.5);
    expect(b.cell!.minR).toBe(-1.0);
  });

  // ── Direction 2: the clean book reads CLEAN (the control the other half needs) ──

  it('a clean book reads ZERO violations and minR settles it with no epsilon question', () => {
    const rows = [
      jrow({ id: 'e1', realizedR: -0.5 }),
      jrow({ id: 'e2', realizedR: -0.4999 }),
      jrow({ id: 'e3', realizedR: -0.25 }),
      jrow({ id: 'e4', realizedR: 0.8, outcome: 'WIN', realizedPnlUsd: 160 }),
    ];
    const { cell } = deskCell(rows, 'single_leg_otm', 'sl');
    expect(cell!.closesBelowMinus050R).toBe(0);
    expect(cell!.closesBelowMinus100R).toBe(0);
    expect(cell!.minR).toBe(-0.5);
    // minR >= -0.50 is the whole certification in one field.
    expect(cell!.minR!).toBeGreaterThanOrEqual(-0.5);
  });

  // ── The edges land ON the thresholds, and the comparison is STRICT ──

  it('a close exactly ON -0.50R is NOT below it; -0.5000001R is', () => {
    // TRA-2202 says "below -0.50R". A stop that fills exactly at its stop price
    // lands on the edge, and counting it as a violation would invalidate a
    // criterion the book actually satisfies.
    const onEdge = deskCell([jrow({ id: 'x1', realizedR: -0.5 })], 'single_leg_otm', 'sl');
    expect(onEdge.cell!.closesBelowMinus050R).toBe(0);
    expect(onEdge.cell!.rHistogram.find((b) => b.label === '[-0.50,0.00)')!.count).toBe(1);

    const past = deskCell([jrow({ id: 'x2', realizedR: -0.5000001 })], 'single_leg_otm', 'sl');
    expect(past.cell!.closesBelowMinus050R).toBe(1);
    expect(past.cell!.rHistogram.find((b) => b.label === '[-1.00,-0.50)')!.count).toBe(1);
  });

  it('a close exactly ON -1.0R is not an OVERSHOOT; -1.0000001R is (TRA-2202 s2 discriminator)', () => {
    // The -1.0R edge is what separates "batch tick sweep latency" from "a genuine
    // gap in a thin name". A clean full-stop close sits ON -1.0R and must not be
    // read as a gap; anything strictly past it is the population that belongs to
    // stop placement / spread guard, NOT to TRA-2200.
    const onEdge = deskCell([jrow({ id: 'y1', realizedR: -1.0 })], 'single_leg_otm', 'sl');
    expect(onEdge.cell!.closesBelowMinus100R).toBe(0);
    expect(onEdge.cell!.closesBelowMinus050R).toBe(1); // still below -0.50R
    expect(onEdge.cell!.rHistogram.find((b) => b.label === '[-1.00,-0.50)')!.count).toBe(1);

    const past = deskCell([jrow({ id: 'y2', realizedR: -1.0000001 })], 'single_leg_otm', 'sl');
    expect(past.cell!.closesBelowMinus100R).toBe(1);
    expect(past.cell!.rHistogram.find((b) => b.label === '(-inf,-1.00)')!.count).toBe(1);
  });

  // ── Count, do not drop (the TRA-2269 partitionHolds pattern) ──

  it('a close with NO realizedR is counted in rUnknown, never bucketed as a NON-violation', () => {
    // The surrounding avgR folds coerce a missing R with `?? 0`. Doing that here
    // would file an unmeasured close in [0.00,+inf) — i.e. silently as "fine" —
    // which is exactly the fail-open a left-tail count exists to close.
    const rows = [
      jrow({ id: 'u1', realizedR: undefined }),
      jrow({ id: 'u2', realizedR: -0.5 }),
    ];
    const { cell } = deskCell(rows, 'single_leg_otm', 'sl');
    expect(cell!.closed).toBe(2);
    expect(cell!.rUnknown).toBe(1);
    expect(cell!.rHistogram.find((b) => b.label === '[0.00,+inf)')!.count).toBe(0);
    expect(cell!.rHistogram.reduce((a, b) => a + b.count, 0)).toBe(1);
    expect(cell!.histogramSumsToClosed).toBe(true);
  });

  it('an unlabelled exitReason folds under `unknown` rather than vanishing from the cross-tab', () => {
    const rows = [jrow({ id: 'n1', exitReason: undefined }), jrow({ id: 'n2' })];
    const { tab } = deskCell(rows, 'single_leg_otm', 'sl');
    expect(tab.cells.map((c) => c.exitReason).sort()).toEqual(['sl', 'unknown']);
    expect(tab.cellsSumToClosed).toBe(true);
    expect(tab.residual).toBe(0);
  });

  it('cells sum to the group `closed`, and the residual is PUBLISHED not asserted away', () => {
    const rows = [
      jrow({ id: 's1', structure: 'single_leg_otm', exitReason: 'sl' }),
      jrow({ id: 's2', structure: 'single_leg_rv', exitReason: 'time_stop' }),
      jrow({ id: 's3', structure: 'single_leg_rv', exitReason: 'sl' }),
      jrow({ id: 's4', outcome: 'OPEN', closeTs: undefined, realizedR: undefined }),
    ];
    const { tab } = deskCell(rows, 'single_leg_otm', 'sl');
    expect(tab.closed).toBe(3); // the OPEN row is not a close
    expect(tab.cells.reduce((a, c) => a + c.closed, 0)).toBe(3);
    expect(tab.cellsSumToClosed).toBe(true);
    expect(tab.residual).toBe(0);
    expect(tab.histogramMismatchCells).toEqual([]);
  });

  // ── Scope: the cross-tab is per account class, folded off that class's own rows ──

  it('fixture rows do NOT leak into the desk cell — the criterion is desk-scoped', () => {
    const rows = [
      jrow({ id: 'k1', account: 'admin', realizedR: -0.5 }),
      jrow({ id: 'k2', account: 'qa_mirror_1578_38096', realizedR: -2.0 }),
      jrow({ id: 'k3', account: undefined, realizedR: -3.0 }), // pre-TRA-1475
    ];
    const report = buildOptionJournalReport(rows, NOW, true);
    const cellOf = (k: 'desk' | 'fixture' | 'unattributed') =>
      report.summary.byAccountClass[k].byStructureExit.cells.find(
        (c) => c.structure === 'single_leg_otm' && c.exitReason === 'sl',
      )!;

    // The fixture and unattributed violations are real rows and are published —
    // just not against the population TRA-2202 grades.
    expect(cellOf('desk').closed).toBe(1);
    expect(cellOf('desk').closesBelowMinus050R).toBe(0);
    expect(cellOf('fixture').closesBelowMinus100R).toBe(1);
    expect(cellOf('unattributed').closesBelowMinus100R).toBe(1);
  });

  it('is emitted per account class and says so, rather than leaving the pooled fold ambiguous', () => {
    const report = buildOptionJournalReport([jrow({ id: 'p1' })], NOW, true);
    expect(report.summary.structureExitNote).toContain('byAccountClass.desk.byStructureExit');
    expect(report.summary.structureExitNote).toContain('single_leg_otm');
    expect(report.summary.byAccountClass.desk.byStructureExit.rBasis).toBe('premium');
  });

  // ── The two R bases, stated on the wire ──

  it('labels the premium->gate R conversion where it is valid and NULLs it where it is not', () => {
    // The journal's R divides by the FULL PREMIUM; the cost-aware gate's R is the
    // stop distance = 0.25 x premium. Publishing one number unlabelled is how the
    // phantom 1.00R cost input happened (TRA-1656 finding #5). Credit structures
    // have no `mark*0.75` stop at all, so there is no factor to publish.
    const rows = [
      jrow({ id: 'g1', structure: 'single_leg_otm' }),
      jrow({ id: 'g2', structure: 'iron_condor' }),
    ];
    const { tab } = deskCell(rows, 'single_leg_otm', 'sl');
    expect(tab.cells.find((c) => c.structure === 'single_leg_otm')!.gateRPerPremiumR).toBe(4);
    expect(tab.cells.find((c) => c.structure === 'iron_condor')!.gateRPerPremiumR).toBeNull();
  });

  // ── leftTailR: the count is auditable from the payload, not merely asserted ──

  it('publishes the most-negative closes ascending, negatives only, capped', () => {
    const rows: OptionTradeJournalRecord[] = Array.from({ length: 20 }, (_, i) =>
      jrow({ id: `t${i}`, realizedR: -(i + 1) / 10 }),
    ).concat([jrow({ id: 'win', realizedR: 1.5, outcome: 'WIN', realizedPnlUsd: 300 })]);
    const { cell } = deskCell(rows, 'single_leg_otm', 'sl');
    expect(cell!.leftTailR.length).toBe(12);
    expect(cell!.leftTailR[0]).toBe(-2.0);
    expect([...cell!.leftTailR].sort((a, b) => a - b)).toEqual(cell!.leftTailR);
    expect(cell!.leftTailR.every((v) => v < 0)).toBe(true);
    // The cap is on the SAMPLE, never on the COUNT — the count stays exact.
    expect(cell!.closesBelowMinus050R).toBe(15); // -0.6 .. -2.0
  });

  it('a label containing the key separator cannot collapse two cells into one', () => {
    // The cell key carries its two parts structurally rather than being re-split
    // out of a joined string. A relabelled cell is the one error this whole
    // cross-tab exists to make impossible.
    const rows = [
      jrow({ id: 'z1', structure: 'single_leg_otm', exitReason: 'sl force' }),
      jrow({ id: 'z2', structure: 'single_leg_otm sl', exitReason: 'force' }),
    ];
    const { tab } = deskCell(rows, 'single_leg_otm', 'sl force');
    expect(tab.cells.length).toBe(2);
    expect(tab.cells.map((c) => `${c.structure}|${c.exitReason}`).sort()).toEqual([
      'single_leg_otm sl|force',
      'single_leg_otm|sl force',
    ]);
  });

  it('reconciles with the marginals it sits beside — a cell can never exceed either', () => {
    const rows = [
      jrow({ id: 'r1', structure: 'single_leg_otm', exitReason: 'sl' }),
      jrow({ id: 'r2', structure: 'single_leg_otm', exitReason: 'time_stop' }),
      jrow({ id: 'r3', structure: 'single_leg_rv', exitReason: 'sl' }),
    ];
    const desk = buildOptionJournalReport(rows, NOW, true).summary.byAccountClass.desk;
    for (const c of desk.byStructureExit.cells) {
      const s = desk.byStructure.find((x) => x.structure === c.structure)!;
      const e = desk.byExitReason.find((x) => x.exitReason === c.exitReason)!;
      expect(c.closed).toBeLessThanOrEqual(s.closed);
      expect(c.closed).toBeLessThanOrEqual(e.closed);
    }
    // And the cells partition each marginal exactly.
    for (const s of desk.byStructure) {
      const sum = desk.byStructureExit.cells
        .filter((c) => c.structure === s.structure)
        .reduce((a, c) => a + c.closed, 0);
      expect(sum).toBe(s.closed);
    }
  });
});

// ---------------------------------------------------------------------------
// TRA-3011 — the durability note's third state.
//
// From 2026-07-30T23:40Z to 2026-08-04T~21:20Z every write to /data on bqb1
// returned ENOSPC. `/api/health/durability` served, verbatim, "Durable state is
// intact … Counts on this box survive a redeploy" for all six days: every
// guarantee it graded was genuinely satisfied, because it graded WHERE the bytes
// go and never WHETHER THEY GO. Once the TRA-2817 prune freed the inodes, the
// recovered box became byte-identical to one that was never full.
// ---------------------------------------------------------------------------

describe('durabilityNote (TRA-3011)', () => {
  const base = {
    ok: true,
    policy: 'observe' as const,
    dataDir: '/data',
    ephemeral: false,
    stateDb: { available: true, reason: null, initialized: true },
    journal: { corruptLines: 0, readError: null },
    ledger: { appendErrors: 0 },
    violations: [],
    unmeasured: [],
  };
  const cleanDisk = {
    belowThreshold: false,
    exhausted: null,
    ageSec: 30,
    belowThresholdSeen: false,
    exhaustedSeen: null,
    readings: 40,
    firstBelowAt: null,
    lastBelowAt: null,
    bootedAt: '2026-08-06T00:55:44.111Z',
  };

  it('serves the unqualified all-clear ONLY when nothing was below since boot', () => {
    const note = durabilityNote({ ...base, disk: cleanDisk });
    expect(note).toMatch(/Durable state is intact/);
    expect(note).toMatch(/stayed above the free-space threshold/);
  });

  it('★ a RECOVERED box does not get the all-clear', () => {
    const note = durabilityNote({
      ...base,
      disk: {
        ...cleanDisk,
        belowThresholdSeen: true,
        exhaustedSeen: 'inodes',
        firstBelowAt: '2026-07-30T23:40:19.000Z',
        lastBelowAt: '2026-08-04T21:20:35.000Z',
      },
    });
    // The exact sentence the route published through the outage must be absent.
    expect(note).not.toMatch(/Durable state is intact/);
    expect(note).toMatch(/WENT BELOW THE FREE-SPACE THRESHOLD SINCE THIS BOOT/);
    expect(note).toMatch(/inodes/);
    expect(note).toMatch(/2026-07-30T23:40:19\.000Z/);
    // …and it says what the operator actually needs: artifacts dated inside the
    // window are suspect even though every count now reads clean.
    expect(note).toMatch(/SUSPECT/);
  });

  it('a full disk RIGHT NOW reads as NOT DURABLE and names the violation', () => {
    const note = durabilityNote({
      ...base,
      ok: false,
      violations: ['data_dir_no_space'],
      disk: { ...cleanDisk, belowThreshold: true, exhausted: 'inodes', belowThresholdSeen: true },
    });
    expect(note).toMatch(/^NOT DURABLE/);
    expect(note).toMatch(/data_dir_no_space/);
  });

  it('an unmeasured disk voids the grade rather than passing it', () => {
    const note = durabilityNote({
      ...base,
      ok: false,
      unmeasured: ['disk_headroom'],
      disk: { ...cleanDisk, belowThreshold: null, ageSec: null, readings: 0 },
    });
    expect(note).toMatch(/^NOT DURABLE/);
    expect(note).toMatch(/disk_headroom/);
    expect(note).not.toMatch(/Durable state is intact/);
  });
});

// ─── TRA-3216 (parent TRA-2760) — /api/health/live-enforce-gates ──────────────
// Deliverable 2 of the ticket is "publish the allowlist and COUNT ITS REJECTS".
// A scanner-level filter whose rejects are invisible is indistinguishable from an
// inert one, so the publishing IS the deliverable and it needs its own instrument.
describe('GET /api/health/live-enforce-gates (TRA-3216)', () => {
  const UNIVERSE_VAR = OPTION_LIVE_OTM_UNIVERSE_VAR;
  let savedUniverse: string | undefined;

  beforeEach(() => {
    savedUniverse = process.env[UNIVERSE_VAR];
    delete process.env[UNIVERSE_VAR];
    clearLiveEnforceGateLedger();
  });
  afterEach(() => {
    if (savedUniverse === undefined) delete process.env[UNIVERSE_VAR];
    else process.env[UNIVERSE_VAR] = savedUniverse;
    clearLiveEnforceGateLedger();
  });

  function serve() {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never, // would BLOCK if the route were gated
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/live-enforce-gates')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other probes
    const res = fakeRes();
    handlers[0]!({}, res);
    return res.body as {
      arm: {
        universe: { var: string; restricted: boolean; symbols: string[]; source: string; raw: string | null };
        costBar: { bar: { barR: number; barPinnedByFloor: boolean; dominantTerm: string } };
      };
      byGate: Array<{
        gate: string;
        evaluated: number;
        blocked: number;
        byScope: Array<{ scope: string }>;
        byReason: Array<{ reasonCode: string; blocked: number; share: number | null }>;
        byBook: Array<{ book: string; evaluated: number; blocked: number }>;
      }>;
      note: string;
    };
  }

  it('publishes the RESOLVED allowlist, not the raw env var', () => {
    const body = serve();
    expect(body.arm.universe).toMatchObject({
      var: 'OPTION_LIVE_OTM_UNIVERSE',
      restricted: true,
      source: 'default',
      raw: null,
    });
    expect(body.arm.universe.symbols).toEqual(['AAPL', 'SPY', 'QQQ', 'PLTR', 'TSLA']);
    expect(body.note).toMatch(/universe=RESTRICTED to \[AAPL,SPY,QQQ,PLTR,TSLA\]/);
  });

  it('makes a typo\'d override visible as env_invalid rather than passing as the default', () => {
    process.env[UNIVERSE_VAR] = ',,,';
    const body = serve();
    // Same five symbols as the default — `source` and `raw` are the ONLY things
    // that tell an operator their value did not take.
    expect(body.arm.universe).toMatchObject({ restricted: true, source: 'env_invalid', raw: ',,,' });
  });

  it('does NOT claim the live path is unchanged while the allowlist is restricting', () => {
    // Every enforcement FLAG is off here, which used to print "all live
    // enforcement flags OFF — the live options path is byte-for-byte ... (no
    // rejection)". The allowlist is on by default, so that sentence would now be
    // false while reading exactly as it always did.
    const body = serve();
    expect(body.note).not.toMatch(/SHADOW-ONLY/);
    expect(body.note).toMatch(/^ENFORCING \(live\)/);
  });

  it('says SHADOW-ONLY only when the universe is ALSO unrestricted, and names the exposure', () => {
    process.env[UNIVERSE_VAR] = '*';
    const body = serve();
    expect(body.arm.universe).toMatchObject({ restricted: false, source: 'env_unrestricted' });
    expect(body.note).toMatch(/SHADOW-ONLY/);
    expect(body.note).toMatch(/~614 watchlist names/);
  });

  // ─── TRA-3401 — the NOMINATOR's arm state ───────────────────────────────────
  // The selector records no live-enforce verdict, so it can never appear in
  // `byGate`. Without an arm surface, "armed and nothing landed in band" reads
  // EXACTLY like "never armed" — and it was armed on real money.
  describe('arm.admissibleStrike (TRA-3401)', () => {
    const FLAG = 'ENABLE_OTM_ADMISSIBLE_STRIKE_SELECT';
    const MIN_VAR = 'OTM_ADMISSIBLE_DELTA_MIN';
    const MAX_VAR = 'OTM_ADMISSIBLE_DELTA_MAX';
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of [FLAG, MIN_VAR, MAX_VAR]) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    });
    afterEach(() => {
      for (const k of [FLAG, MIN_VAR, MAX_VAR]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k]!;
      }
    });

    type ArmBody = { arm: { admissibleStrike: Record<string, unknown> }; note: string };

    it('reports DISARMED by default, and says the legacy nominee is delta-blind', () => {
      const body = serve() as unknown as ArmBody;
      expect(body.arm.admissibleStrike).toMatchObject({
        issue: 'TRA-3401',
        flag: FLAG,
        armed: false,
        minValueRaw: null,
        maxValueRaw: null,
      });
      expect(body.note).toMatch(/otm_nominator=off \(legacy top-\|mispricingPct\| nominee, delta-blind\)/);
    });

    it('publishes the RESOLVED band and the raw env, so an armed selector is readable', () => {
      process.env[FLAG] = 'true';
      process.env[MIN_VAR] = '0.50';
      process.env[MAX_VAR] = '0.55';
      const body = serve() as unknown as ArmBody;
      expect(body.arm.admissibleStrike).toMatchObject({
        armed: true,
        band: { min: 0.5, max: 0.55 },
        minValueRaw: '0.50',
        maxValueRaw: '0.55',
      });
      expect(body.note).toMatch(/otm_nominator=ARMED into \|delta\| \[0\.5, 0\.55\)/);
    });

    it('shows a MALFORMED knob as raw, so a silent fallback is not read as the value that was set', () => {
      process.env[FLAG] = '1';
      process.env[MIN_VAR] = 'zero point five';
      const body = serve() as unknown as ArmBody;
      // The band falls back to the ratified default; `minValueRaw` is the ONLY
      // thing that tells an operator their value never took.
      expect(body.arm.admissibleStrike).toMatchObject({
        armed: true,
        band: { min: 0.495, max: 0.55 },
        minValueRaw: 'zero point five',
      });
    });

    it('withdraws the SHADOW-ONLY "byte-for-byte unchanged" claim when the nominator is armed', () => {
      // Every GATE is off and the universe is unrestricted — the one state that
      // still prints SHADOW-ONLY. An armed selector changes WHICH contract is
      // nominated, so that sentence is false even though it adds no rejection.
      process.env[UNIVERSE_VAR] = '*';
      expect((serve() as unknown as ArmBody).note).toMatch(/SHADOW-ONLY/); // positive control

      process.env[FLAG] = 'true';
      const body = serve() as unknown as ArmBody;
      expect(body.arm.admissibleStrike).toMatchObject({ armed: true });
      expect(body.note).not.toMatch(/SHADOW-ONLY/);
      expect(body.note).toMatch(/otm_nominator=ARMED/);
    });
  });

  it('publishes the bar composition, so a floor-pinned bar is not re-derived by hand', () => {
    const body = serve();
    expect(body.arm.costBar.bar).toMatchObject({ barPinnedByFloor: false, dominantTerm: 'spread_cross' });
    expect(body.arm.costBar.bar.barR).toBeCloseTo(0.485, 10);
  });

  it('surfaces the universe rejects with the NAME, the reason split and the BOOK', () => {
    recordLiveEnforceDecision('universe', 'KVYO', true, etDateString(new Date(NOW)), 'no', NOW, {
      reasonCode: 'not_in_universe',
      book: 'admin',
    });
    recordLiveEnforceDecision('universe', 'AAPL', false, etDateString(new Date(NOW)), undefined, NOW, {
      book: 'admin',
    });

    const u = serve().byGate.find((g) => g.gate === 'universe')!;
    expect(u).toMatchObject({ evaluated: 2, blocked: 1 });
    expect(u.byScope.map((s) => s.scope).sort()).toEqual(['AAPL', 'KVYO']);
    expect(u.byReason).toEqual([{ reasonCode: 'not_in_universe', blocked: 1, share: 1 }]);
    expect(u.byBook).toEqual([{ book: 'admin', evaluated: 2, blocked: 1, blockRate: 0.5 }]);
  });

  it('turns the cost bar block rate into a tuneable shortfall distribution', () => {
    const day = etDateString(new Date(NOW));
    for (const code of ['shortfall_gte_0.50', 'shortfall_gte_0.50', 'shortfall_lt_0.10']) {
      recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, day, 'over bar', NOW, { reasonCode: code });
    }
    const c = serve().byGate.find((g) => g.gate === 'cost_bar')!;
    // byScope could only ever answer `single_leg_otm` — that is the whole reason
    // a 99.15% block rate was undiagnosable.
    expect(c.byScope).toEqual([expect.objectContaining({ scope: 'single_leg_otm' })]);
    expect(c.byReason).toEqual([
      { reasonCode: 'shortfall_gte_0.50', blocked: 2, share: 0.6667 },
      { reasonCode: 'shortfall_lt_0.10', blocked: 1, share: 0.3333 },
    ]);
  });
});

// ─── TRA-3394 (authorization TRA-3392) — /api/health/otm-sleeve-mandate ───────
// The ticket names this read as the verification: "(a) the band table with
// n/SE/lo95 per cell, (b) the three distinct decline reason codes, and (c) the
// ceiling gate's own evaluated/blocked counters." The payload IS a deliverable,
// so these assert it is all three at once rather than a promise that it will be.
describe('GET /api/health/otm-sleeve-mandate (TRA-3394)', () => {
  const VARS = [
    OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG,
    OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG,
    OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR,
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
    clearLiveEnforceGateLedger();
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v]!;
    }
    clearLiveEnforceGateLedger();
  });

  function serve() {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never, // would BLOCK if the route were gated
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
    });
    const handlers = routes.get('/api/health/otm-sleeve-mandate')!;
    expect(handlers).toHaveLength(1); // unauthenticated, like the other gate probes
    const res = fakeRes();
    handlers[0]!({}, res);
    return res.body as {
      sleeve: { label: string; structureKey: string; authorizedBand: { from: number; to: number } };
      bands: Array<{
        label: string;
        authorization: string;
        evidence: { n: number; seR_gate: number | null; lowerCI95: number | null };
        cells?: Array<{ label: string; n: number; seR_gate: number | null; lowerCI95: number | null }>;
      }>;
      declineReasonCodes: Array<{ code: string; meaning: string; response: string }>;
      ceiling: {
        mode: string;
        inForce: number | null;
        mandateCeiling: number | null;
        rawOverride: string | null;
        overrideRejectedReason: string | null;
        counters: {
          enforcing: { gate: string; today: { evaluated: number; blocked: number } | null };
          shadow: { gate: string; today: { evaluated: number; blocked: number } | null };
        };
      };
      note: string;
    };
  }

  // (a) the band table
  it('publishes the band table with n / SE / lo95 per measured cell', () => {
    const body = serve();
    const deauth = body.bands.find((b) => b.authorization === 'de_authorized')!;
    expect(deauth.label).toBe('[0.00,0.20)');
    expect(deauth.evidence.n).toBe(691);
    // The doc publishes no SE for the AGGREGATE band, so the CELLS are where
    // n/SE/lo95 actually live — a reader gets the measured numbers, not an SE
    // invented for the roll-up.
    expect(deauth.cells).toHaveLength(2);
    for (const c of deauth.cells!) {
      expect(c.seR_gate).toBeTypeOf('number');
      expect(c.lowerCI95).toBeTypeOf('number');
    }
    const authorized = body.bands.filter((b) => b.authorization === 'authorized');
    expect(authorized).toHaveLength(1);
    expect(authorized[0]!.evidence).toMatchObject({ n: 100, seR_gate: 0.422, lowerCI95: 0.799 });
  });

  it('states the authorized band as BOUNDED, and keeps the journal key frozen', () => {
    const body = serve();
    expect(body.sleeve.authorizedBand).toMatchObject({ from: 0.495, to: 0.55 });
    expect(body.sleeve.label).toBe('Near-ATM Single-Leg (long)');
    // TRA-3392 §7 — the label is new; the KEY is the join column and must not move.
    expect(body.sleeve.structureKey).toBe('single_leg_otm');
  });

  // (b) the three decline reason codes
  it('publishes THREE distinct decline reason codes, each with its own response', () => {
    const body = serve();
    expect(body.declineReasonCodes.map((r) => r.code)).toEqual([
      'band_deauthorized', 'insufficient_evidence', 'gross_negative',
    ]);
    expect(new Set(body.declineReasonCodes.map((r) => r.response)).size).toBe(3);
    // "we measured a loser" vs "we never measured" vs "the mandate forbids it" is
    // the distinction the board could not previously make.
    expect(body.declineReasonCodes[0]!.meaning).toMatch(/MANDATE FORBIDS/);
    expect(body.declineReasonCodes[1]!.meaning).toMatch(/NEVER MEASURED/);
    expect(body.declineReasonCodes[2]!.meaning).toMatch(/MEASURED A LOSER/);
  });

  // (c) the ceiling gate's own counters
  it('publishes the ceiling counters even while the gate is DARK, and says so', () => {
    const body = serve();
    expect(body.ceiling.mode).toBe('off');
    expect(body.ceiling.mandateCeiling).toBe(0.55);
    // Both counters exist at zero. An absent row and a silent row are the same
    // JSON otherwise, and a silent row is this gate's EXPECTED healthy state.
    expect(body.ceiling.counters.enforcing.gate).toBe('entry_delta_ceiling');
    expect(body.ceiling.counters.shadow.gate).toBe('entry_delta_ceiling_shadow');
    expect(body.ceiling.counters.enforcing.today).toMatchObject({ evaluated: 0, blocked: 0 });
    // ...and the note must not let a STRUCTURAL zero read as a clean bill.
    expect(body.note).toMatch(/CEILING DARK/);
    expect(body.note).toMatch(/not a clean bill/);
  });

  it('counts an ENFORCED block on its own gate, separately from the shadow gate', () => {
    process.env[OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG] = '1';
    recordLiveEnforceDecision(
      'entry_delta_ceiling', 'single_leg_otm', true, etDateString(new Date(NOW)),
      'above ceiling', NOW, { reasonCode: 'above_mandate_ceiling', cell: 'single_leg_otm::[0.55,inf)' },
    );
    const body = serve();
    expect(body.ceiling.mode).toBe('enforce');
    expect(body.ceiling.inForce).toBe(0.55);
    expect(body.ceiling.counters.enforcing.today).toMatchObject({ evaluated: 1, blocked: 1 });
    expect(body.ceiling.counters.shadow.today).toMatchObject({ evaluated: 0, blocked: 0 });
    expect(body.note).toMatch(/CEILING ENFORCE/);
    expect(body.note).toMatch(/evaluated > 0, blocked = 0/); // the expected healthy read
  });

  it('keeps a SHADOW would-block off the enforcing gate entirely', () => {
    process.env[OPTION_ENTRY_DELTA_CEILING_LIVE_OBSERVE_FLAG] = '1';
    recordLiveEnforceDecision(
      'entry_delta_ceiling_shadow', 'single_leg_otm', true, etDateString(new Date(NOW)),
      'would have blocked', NOW, { reasonCode: 'above_mandate_ceiling' },
    );
    const body = serve();
    expect(body.ceiling.mode).toBe('observe');
    // The enforcing gate stays at a TRUE zero: no live open was stopped by it.
    expect(body.ceiling.counters.enforcing.today).toMatchObject({ evaluated: 0, blocked: 0 });
    expect(body.ceiling.counters.shadow.today).toMatchObject({ evaluated: 1, blocked: 1 });
  });

  it('makes a REFUSED widening override visible instead of silently ignoring it', () => {
    process.env[OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG] = '1';
    process.env[OPTION_ENTRY_DELTA_CEILING_LIVE_VALUE_VAR] = '0.80';
    const body = serve();
    expect(body.ceiling.inForce).toBe(0.55); // the mandate stands
    expect(body.ceiling.rawOverride).toBe('0.80');
    expect(body.ceiling.overrideRejectedReason).toMatch(/ABOVE/);
  });
});

// ─── TRA-3445 — the AGGREGATE live-OTM cap, on the read side ──────────────────
// The board authorized "1 contract/name, max $150/entry, max $750 TOTAL". The
// first two clauses were already published here; the third was neither enforced
// nor readable. Publishing the CAP alone would not have been an instrument: a
// cap value reads identically at headroom $600 and headroom $0, and those two
// states are the whole reason the block exists.
describe('GET /api/health/live-options-fee-slippage — aggregate cap (TRA-3445)', () => {
  const AGG_VAR = 'LIVE_OPTION_TEST_AGGREGATE_CAP_USD';
  let savedAgg: string | undefined;

  beforeEach(() => { savedAgg = process.env[AGG_VAR]; delete process.env[AGG_VAR]; });
  afterEach(() => {
    if (savedAgg === undefined) delete process.env[AGG_VAR];
    else process.env[AGG_VAR] = savedAgg;
  });

  function serveFeeSlippage(
    liveOtmAggregateExposure?: () => Array<{
      book: string | null; mode: 'demo' | 'live'; liveEntryGateOpen: boolean; capUsd: number;
      // TRA-3674 — `capUsd` is now the PER-BOOK budget; these three are the
      // terms it was resolved from, without which a small budget cannot be
      // attributed to a small balance vs a mis-set φ.
      fleetCapUsd: number; fleetRiskFraction: number; availableCashUsd: number | null;
      openPremiumAtRiskUsd: number; openRows: number; unpricedOpenRows: number;
      headroomUsd: number | null;
    }>,
  ) {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => undefined) as never,
      userCtx: async () => ctx('admin', engineState()),
      getSettings: () => settings(),
      now: () => NOW,
      ...(liveOtmAggregateExposure ? { liveOtmAggregateExposure } : {}),
    });
    const res = fakeRes();
    routes.get('/api/health/live-options-fee-slippage')![0]!({}, res);
    return res.body as {
      aggregateCapUsd: number;
      aggregateCapDefaultUsd: number;
      aggregateCapCeilingUsd: number;
      aggregateCapVar: string;
      aggregateExposure: unknown;
    };
  }

  it('publishes the RESOLVED cap plus its default / ceiling / var name', () => {
    const body = serveFeeSlippage();
    expect(body.aggregateCapUsd).toBe(750);
    expect(body.aggregateCapDefaultUsd).toBe(750);
    expect(body.aggregateCapCeilingUsd).toBe(750);
    expect(body.aggregateCapVar).toBe(AGG_VAR);
  });

  it('reports the RESOLVED value, not the constant — a clamped env is visible as clamped', () => {
    process.env[AGG_VAR] = '5000';
    expect(serveFeeSlippage().aggregateCapUsd).toBe(750); // clamped DOWN
    process.env[AGG_VAR] = '300';
    expect(serveFeeSlippage().aggregateCapUsd).toBe(300); // a tightening is honoured
  });

  it('separates "armed, $600 headroom" from "armed, $0 headroom" per book', () => {
    // Three live-MODE rows, TWO armed — the shape bqb1 actually serves, with
    // the real balances (admin $1,143.96 / v0nni $400.00) and the TRA-3674
    // per-book budgets they resolve to. Sum on `liveEntryGateOpen`, not `mode`.
    const rows = [
      { book: 'admin', mode: 'live' as const, liveEntryGateOpen: true, capUsd: 555.73, fleetCapUsd: 750, fleetRiskFraction: 0.4858, availableCashUsd: 1143.96, openPremiumAtRiskUsd: 150, openRows: 1, unpricedOpenRows: 0, headroomUsd: 405.73 },
      { book: 'Richard', mode: 'live' as const, liveEntryGateOpen: false, capUsd: 0, fleetCapUsd: 750, fleetRiskFraction: 0.4858, availableCashUsd: null, openPremiumAtRiskUsd: 0, openRows: 0, unpricedOpenRows: 0, headroomUsd: null },
      { book: 'v0nni', mode: 'live' as const, liveEntryGateOpen: true, capUsd: 194.32, fleetCapUsd: 750, fleetRiskFraction: 0.4858, availableCashUsd: 400, openPremiumAtRiskUsd: 194.32, openRows: 2, unpricedOpenRows: 0, headroomUsd: 0 },
    ];
    const body = serveFeeSlippage(() => rows);
    expect(body.aggregateExposure).toEqual(rows);
    const armed = rows.filter((r) => r.liveEntryGateOpen);
    expect(armed).toHaveLength(2);
    expect(rows.filter((r) => r.mode === 'live')).toHaveLength(3); // the WRONG denominator
    // TRA-3674 — the fleet bound is now the SUM OF THE ROWS' OWN BUDGETS, and it
    // honours the board's $750 to within the disclosed 5c of φ rounding. Under
    // the flat cap this same sum read $1,500 here and $1,150 in the real admit
    // loop, neither of which was the authorization.
    expect(armed.reduce((s, r) => s + r.capUsd, 0)).toBeCloseTo(750.05, 2);
  });

  // TRA-3674 — acceptance item 4. Before this the route reported a uniform
  // `capUsd: 750` on all 67 rows and was STRUCTURALLY unable to tell the two
  // armed books apart, which is the read the ticket is graded on.
  it('gives the two live books DISTINCT, readable budgets', () => {
    const rows = [
      { book: 'admin', mode: 'live' as const, liveEntryGateOpen: true, capUsd: 555.73, fleetCapUsd: 750, fleetRiskFraction: 0.4858, availableCashUsd: 1143.96, openPremiumAtRiskUsd: 0, openRows: 0, unpricedOpenRows: 0, headroomUsd: 555.73 },
      { book: 'v0nni', mode: 'live' as const, liveEntryGateOpen: true, capUsd: 194.32, fleetCapUsd: 750, fleetRiskFraction: 0.4858, availableCashUsd: 400, openPremiumAtRiskUsd: 0, openRows: 0, unpricedOpenRows: 0, headroomUsd: 194.32 },
    ];
    const served = serveFeeSlippage(() => rows).aggregateExposure as typeof rows;
    expect(served[0]!.capUsd).not.toBe(served[1]!.capUsd);
    // Each budget is attributable to its own balance — the three terms travel
    // together, so a small budget can be told apart from a mis-resolved φ.
    for (const r of served) {
      expect(r.capUsd).toBeCloseTo(
        Math.min(r.fleetRiskFraction * (r.availableCashUsd ?? 0), r.fleetCapUsd), 1,
      );
    }
    // …and both books land on the SAME fraction of themselves, which the flat
    // cap could not do (admin 65.6%, v0nni 100%).
    const conc = served.map((r) => r.capUsd / (r.availableCashUsd ?? 1));
    expect(conc[0]).toBeCloseTo(conc[1]!, 4);
  });

  it('publishes the RESOLVED φ beside its default / ceiling / var name', () => {
    const body = serveFeeSlippage() as unknown as {
      fleetRiskFraction: number; fleetRiskFractionDefault: number;
      fleetRiskFractionCeiling: number; fleetRiskFractionVar: string;
    };
    expect(body.fleetRiskFraction).toBe(0.4858);
    expect(body.fleetRiskFractionDefault).toBe(0.4858);
    expect(body.fleetRiskFractionCeiling).toBe(1.0);
    expect(body.fleetRiskFractionVar).toBe('LIVE_OPTION_TEST_FLEET_RISK_FRACTION');
  });

  it('reports the RESOLVED φ, not the constant — a clamped env is visible as clamped', () => {
    // The same publication contract the cap above is held to, and for the same
    // reason: a compiled constant reads identically on a box running a
    // different φ, which would make the per-book budgets unverifiable.
    const VAR = 'LIVE_OPTION_TEST_FLEET_RISK_FRACTION';
    const saved = process.env[VAR];
    try {
      process.env[VAR] = '0.25';
      expect((serveFeeSlippage() as unknown as { fleetRiskFraction: number }).fleetRiskFraction)
        .toBe(0.25);
      process.env[VAR] = '5';
      expect((serveFeeSlippage() as unknown as { fleetRiskFraction: number }).fleetRiskFraction)
        .toBe(1.0); // clamped DOWN
      process.env[VAR] = 'abc';
      expect((serveFeeSlippage() as unknown as { fleetRiskFraction: number }).fleetRiskFraction)
        .toBe(0.4858); // fail-safe to the compiled default
    } finally {
      if (saved === undefined) delete process.env[VAR];
      else process.env[VAR] = saved;
    }
  });

  it('serves NULL when the provider is unwired — never [], which would claim "no books"', () => {
    // The two states must not collide: a build that serves the cap without a
    // utilization read is not a fleet with nothing open.
    expect(serveFeeSlippage().aggregateExposure).toBeNull();
    expect(serveFeeSlippage(() => []).aggregateExposure).toEqual([]);
  });
});
