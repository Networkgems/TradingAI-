// TRA-1001 (parent TRA-995) — the risk-autopilot throttle is CONSUMED by
// per-trade sizing.
//
// What these tests have to pin, in order of how badly each one bit before:
//   1. the pure clamp is tighten-only — it can never return > 1, for ANY input;
//   2. a 0.5 throttle actually halves the sized quantity on each surface that
//      opens a ticket (live equity, demo equity, single-leg options, OTM
//      options) and a throttle of 1 is byte-for-byte a no-op;
//   3. the engine composes governor → multiplier, and only when ARMED. The
//      dark path is the one that reads identically to a broken wiring, so it
//      gets an explicit control: unarmed with a real 0.5 throttle latched must
//      still size at full risk, and the counters must say so.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OtmMispricingSignal, RelativeValueSignal, TradeSignal } from '@trading-app/shared';
import type { TradierAccountBalance } from '@trading-app/engine';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import {
  RISK_THROTTLE_SIZING_FLAG,
  RISK_THROTTLE_LIVE_PATHS,
  riskThrottleSizingScope,
  isRiskThrottleSizingArmedForPath,
  riskThrottleSizeMultiplier,
  recordRiskThrottleSizing,
  snapshotRiskThrottleSizing,
  resetRiskThrottleSizingForTests,
  type RiskThrottleSizingPath,
} from './risk-throttle-sizing.js';
import { MIN_RISK_THROTTLE } from './risk-autopilot.js';
import { SignalEngine, DailyRiskGovernor, sizeLiveEquityFromStop } from './signal-engine.js';
import { PaperAccount } from './paper-account.js';
import { PaperOptionsAccount } from './options-account.js';

// 2024-06-04 10:00 ET (Tuesday) — inside a valid ET window so the options open
// paths' trading-window guard passes.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function otmSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'otm-1', symbol: 'AAPL', type: 'otm_mispricing', side: 'buy',
    entryPrice: 1.0, stopLoss: 0.75, takeProfit: 1.5, riskRewardRatio: 2,
    timestamp: TRADING_TIME, optionSymbol: 'AAPL240705C00200000', optionType: 'call',
    strike: 200, expiration: '2024-07-05', mark: 1.0, theo: 1.3, mispricingPct: -0.23,
    delta: 0.18, ...overrides,
  };
}

function rvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
  return {
    id: 'rv-1', symbol: 'AAPL', type: 'relative_value', side: 'buy',
    entryPrice: 1.0, stopLoss: 0.75, takeProfit: 1.5, riskRewardRatio: 2,
    timestamp: TRADING_TIME, optionSymbol: 'AAPL240705C00200000', optionType: 'call',
    strike: 200, expiration: '2024-07-05', mark: 1.0, fairPrice: 1.3, mispricingPct: -0.23,
    zScore: -2.1, ivFitted: 0.32, ivUsed: 0.28, delta: 0.18, reason: 'cheap-vs-curve',
    ...overrides,
  };
}

function equitySignal(): TradeSignal {
  return {
    id: 'eq-1', symbol: 'AAPL', type: 'orb_breakout', side: 'buy',
    entryPrice: 100, stopLoss: 95, takeProfit: 110, riskRewardRatio: 2,
    timestamp: TRADING_TIME,
  } as TradeSignal;
}

const BALANCE: TradierAccountBalance = {
  totalEquity: 25_000,
  totalCash: 10_000,
  optionBuyingPower: 10_000,
  stockBuyingPower: 20_000,
  longMarketValue: 15_000,
  dayTradeBuyingPower: null,
};

beforeEach(() => {
  resetRiskThrottleSizingForTests();
  delete process.env[RISK_THROTTLE_SIZING_FLAG];
});

afterEach(() => {
  delete process.env[RISK_THROTTLE_SIZING_FLAG];
  vi.useRealTimers();
});

describe('riskThrottleSizeMultiplier — the tighten-only clamp', () => {
  it('is 1 when the consumer is not armed, whatever the throttle says', () => {
    expect(riskThrottleSizeMultiplier(0.5, false)).toBe(1);
    expect(riskThrottleSizeMultiplier(0.1, false)).toBe(1);
  });

  it('passes a real throttle through when armed', () => {
    expect(riskThrottleSizeMultiplier(0.5, true)).toBe(0.5);
    expect(riskThrottleSizeMultiplier(0.25, true)).toBe(0.25);
  });

  it('a throttle of 1 is a no-op', () => {
    expect(riskThrottleSizeMultiplier(1, true)).toBe(1);
  });

  it('NEVER raises size — a > 1 "throttle" is clamped to 1', () => {
    // Invariant 4 (TRA-995): the autopilot may tighten autonomously, never
    // loosen. A multiplier > 1 would be a silent autonomous limit RAISE.
    expect(riskThrottleSizeMultiplier(1.5, true)).toBe(1);
    expect(riskThrottleSizeMultiplier(Number.POSITIVE_INFINITY, true)).toBe(1);
  });

  it('treats a non-finite throttle as no information ⇒ no trim', () => {
    expect(riskThrottleSizeMultiplier(Number.NaN, true)).toBe(1);
    expect(riskThrottleSizeMultiplier(undefined, true)).toBe(1);
    expect(riskThrottleSizeMultiplier(null, true)).toBe(1);
  });

  it('floors a corrupted 0/negative throttle at MIN_RISK_THROTTLE, never 0', () => {
    // A throttle is a DE-RISK, not a second halt. Sizing every ticket to zero
    // would be an unsurfaced trading stop wearing a sizing multiplier's name.
    expect(riskThrottleSizeMultiplier(0, true)).toBe(MIN_RISK_THROTTLE);
    expect(riskThrottleSizeMultiplier(-3, true)).toBe(MIN_RISK_THROTTLE);
  });

  it('property: over a sweep of inputs the multiplier is always in (0, 1]', () => {
    const sweep = [-1, 0, 0.01, 0.1, 0.33, 0.5, 0.999, 1, 1.0001, 42, Number.NaN, Number.MAX_VALUE];
    for (const t of sweep) {
      const m = riskThrottleSizeMultiplier(t, true);
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThanOrEqual(1);
    }
  });
});

describe('riskThrottleSizingScope — the tri-state gate (TRA-2333)', () => {
  const scope = (raw: string) => riskThrottleSizingScope({ [RISK_THROTTLE_SIZING_FLAG]: raw });

  it('is OFF by default (this ships dark)', () => {
    expect(riskThrottleSizingScope({})).toBe('off');
  });

  it('reads the two explicit scopes, case/whitespace-insensitively', () => {
    for (const raw of ['demo', 'DEMO', ' demo ']) expect(scope(raw)).toBe('demo');
    for (const raw of ['all', 'ALL', ' all ']) expect(scope(raw)).toBe('all');
  });

  it('maps LEGACY truthy to demo, never to all — an old value can only narrow', () => {
    // The stated rule (TRA-2333 Gap A): if a stale `=1` ever turns up in a
    // runbook, a restored Render env row (TRA-2136), or a copied .env, it must
    // not be able to widen scope onto the live broker path. Arming live is a
    // deliberate, un-abbreviated `=all`.
    for (const raw of ['1', 'true', 'YES', ' on ']) expect(scope(raw)).toBe('demo');
  });

  it('treats falsy and unrecognised values as off', () => {
    for (const raw of ['0', 'false', '', 'off', 'enabled', 'live', 'demo,all']) {
      expect(scope(raw)).toBe('off');
    }
  });
});

describe('isRiskThrottleSizingArmedForPath — the structural scope', () => {
  const ALL_PATHS: RiskThrottleSizingPath[] = [
    'equity_live', 'equity_live_mirror', 'equity_demo',
    'options_single_leg', 'options_otm', 'equity_cap_estimate', 'proposal_estimate',
  ];
  const NON_LIVE = ALL_PATHS.filter((p) => !(RISK_THROTTLE_LIVE_PATHS as readonly string[]).includes(p));

  it('off arms nothing', () => {
    for (const p of ALL_PATHS) expect(isRiskThrottleSizingArmedForPath(p, 'off')).toBe(false);
  });

  it('demo arms every non-live path and NO live path', () => {
    for (const p of NON_LIVE) expect(isRiskThrottleSizingArmedForPath(p, 'demo')).toBe(true);
    for (const p of RISK_THROTTLE_LIVE_PATHS) {
      expect(isRiskThrottleSizingArmedForPath(p, 'demo')).toBe(false);
    }
  });

  it('all arms every path', () => {
    for (const p of ALL_PATHS) expect(isRiskThrottleSizingArmedForPath(p, 'all')).toBe(true);
  });

  it('the live set is exactly the two broker-ticket chokepoints', () => {
    // Pinned so a new path added to the union can never quietly join the live
    // set — or, worse, a live one quietly leave it.
    expect([...RISK_THROTTLE_LIVE_PATHS]).toEqual(['equity_live', 'equity_live_mirror']);
  });
});

describe('a 0.5 throttle halves the sized quantity on every ticket surface', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME);
  });

  it('live equity — sizeLiveEquityFromStop', () => {
    const base = {
      balance: BALANCE, managedAccountRatio: 0.5, riskPerTrade: 0.01,
      entryPrice: 100, stopPrice: 95, currentPrice: 100,
    };
    const full = sizeLiveEquityFromStop({ ...base, sizeMultiplier: riskThrottleSizeMultiplier(1, true) });
    const halved = sizeLiveEquityFromStop({ ...base, sizeMultiplier: riskThrottleSizeMultiplier(0.5, true) });
    expect(full).toBe(25);
    expect(halved).toBe(12); // floor(25 × 0.5)
  });

  it('demo equity — PaperAccount.openPosition', () => {
    const acctFull = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
    const full = acctFull.openPosition(equitySignal(), 100, riskThrottleSizeMultiplier(1, true));
    const acctHalf = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
    const halved = acctHalf.openPosition(equitySignal(), 100, riskThrottleSizeMultiplier(0.5, true));
    expect(full!.quantity).toBeGreaterThan(0);
    expect(halved!.quantity).toBe(Math.floor(full!.quantity * 0.5));
  });

  it('single-leg options — openOptionFromRvCandidate', () => {
    const acctFull = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const full = acctFull.openOptionFromRvCandidate(rvSignal(), 'demo', undefined, undefined, undefined, 1);
    const acctHalf = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const halved = acctHalf.openOptionFromRvCandidate(rvSignal(), 'demo', undefined, undefined, undefined, 0.5);
    expect(full!.contracts).toBeGreaterThan(1);
    expect(halved!.contracts).toBe(Math.floor(full!.contracts * 0.5));
  });

  it('OTM options — openOptionFromCandidate (the param TRA-1001 added)', () => {
    const acctFull = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const full = acctFull.openOptionFromCandidate(otmSignal(), 'demo', undefined, undefined, undefined, undefined, 1);
    const acctHalf = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const halved = acctHalf.openOptionFromCandidate(otmSignal(), 'demo', undefined, undefined, undefined, undefined, 0.5);
    expect(full!.contracts).toBeGreaterThan(1);
    expect(halved!.contracts).toBe(Math.floor(full!.contracts * 0.5));
  });

  it('throttle = 1 is byte-for-byte the un-throttled quantity on every surface', () => {
    const base = {
      balance: BALANCE, managedAccountRatio: 0.5, riskPerTrade: 0.01,
      entryPrice: 100, stopPrice: 95, currentPrice: 100,
    };
    expect(sizeLiveEquityFromStop({ ...base, sizeMultiplier: riskThrottleSizeMultiplier(1, true) }))
      .toBe(sizeLiveEquityFromStop(base));

    const a = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
    const b = new PaperAccount({ initialEquity: 100_000, managedAccountRatio: 1, riskPerTrade: 0.01 });
    expect(a.openPosition(equitySignal(), 100)!.quantity)
      .toBe(b.openPosition(equitySignal(), 100, riskThrottleSizeMultiplier(1, true))!.quantity);

    const o1 = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const o2 = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(o1.openOptionFromRvCandidate(rvSignal(), 'demo')!.contracts)
      .toBe(o2.openOptionFromRvCandidate(rvSignal(), 'demo', undefined, undefined, undefined, riskThrottleSizeMultiplier(1, true))!.contracts);

    const t1 = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const t2 = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(t1.openOptionFromCandidate(otmSignal(), 'demo')!.contracts)
      .toBe(t2.openOptionFromCandidate(otmSignal(), 'demo', undefined, undefined, undefined, undefined, riskThrottleSizeMultiplier(1, true))!.contracts);
  });

  it('is monotone tighten-only: a smaller throttle never sizes LARGER', () => {
    const base = {
      balance: BALANCE, managedAccountRatio: 0.5, riskPerTrade: 0.01,
      entryPrice: 100, stopPrice: 95, currentPrice: 100,
    };
    const unthrottled = sizeLiveEquityFromStop(base);
    let prev = unthrottled;
    for (const t of [1, 0.9, 0.75, 0.5, 0.3, 0.1]) {
      const qty = sizeLiveEquityFromStop({ ...base, sizeMultiplier: riskThrottleSizeMultiplier(t, true) });
      expect(qty).toBeLessThanOrEqual(prev);
      expect(qty).toBeLessThanOrEqual(unthrottled);
      prev = qty;
    }
  });
});

describe('SignalEngine.activeRiskSizingMultiplier — the wiring', () => {
  /** Latch a real autopilot throttle on the engine's own governor. */
  function throttleEngine(engine: SignalEngine, throttle: number): void {
    const gov = (engine as unknown as { riskGovernor: DailyRiskGovernor }).riskGovernor;
    gov.applyAutopilotDecision({
      halt: false,
      haltReason: null,
      feedStale: false,
      feedStaleReason: null,
      riskThrottle: throttle,
      actions: [{
        kind: 'throttle',
        trigger: 'loss_streak',
        reason: 'test throttle',
        throttleMultiplier: throttle,
      }],
    });
  }

  const mult = (engine: SignalEngine, path: RiskThrottleSizingPath = 'equity_demo'): number =>
    (engine as unknown as { _riskSizingMultiplierForTests(p: RiskThrottleSizingPath): number })
      ._riskSizingMultiplierForTests(path);

  it('ARMED — a governor throttle of 0.5 reaches the sizing scalar', () => {
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    expect(mult(engine)).toBe(1); // no throttle latched yet
    throttleEngine(engine, 0.5);
    expect(engine.getRiskThrottle()).toBe(0.5);
    expect(mult(engine)).toBe(0.5);
  });

  it('DARK (flag off) — the SAME 0.5 throttle leaves sizing at full risk', () => {
    // The control for the failure mode that matters: an unwired consumer and a
    // dark one produce identical tickets. Only the counters tell them apart.
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    throttleEngine(engine, 0.5);
    expect(engine.getRiskThrottle()).toBe(0.5);
    expect(mult(engine)).toBe(1);

    const snap = snapshotRiskThrottleSizing({});
    expect(snap.armedScope).toBe('off');
    expect(snap.totalConsults).toBeGreaterThan(0);
    expect(snap.totalTrims).toBe(0);
  });

  // ── TRA-2333 acceptance #1 ────────────────────────────────────────────────
  // The DARK-control test above is the model: prove the live paths are UNTOUCHED
  // under `demo` against a real latched throttle, not merely that demo trims.
  it('DEMO scope — the demo/options paths trim and BOTH live paths stay at 1', () => {
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    throttleEngine(engine, 0.5);

    for (const p of ['equity_demo', 'options_single_leg', 'options_otm',
      'equity_cap_estimate', 'proposal_estimate'] as RiskThrottleSizingPath[]) {
      expect(mult(engine, p)).toBe(0.5);
    }
    // The real Tradier bracket-order quantity and its local mirror. A regression
    // here is the exact failure TRA-2333 exists to prevent: a flag armed "for
    // demo" silently sizing live tickets.
    expect(mult(engine, 'equity_live')).toBe(1);
    expect(mult(engine, 'equity_live_mirror')).toBe(1);
  });

  it('DEMO scope — the live paths are counted as CONSULTED but not armed', () => {
    // Acceptance #2: a reader must be able to see that `equity_live` was
    // consulted and was NOT armed while `equity_demo` was. `armedScope` alone
    // cannot say that; the per-path bit can.
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    throttleEngine(engine, 0.5);
    mult(engine, 'equity_demo');
    mult(engine, 'equity_live');

    const snap = snapshotRiskThrottleSizing();
    expect(snap.armedScope).toBe('demo');
    expect(snap.byPath.equity_demo).toMatchObject({ armed: true, consults: 1, trims: 1, minMultiplier: 0.5 });
    // Consulted, NOT armed, NOT trimmed — and `lastThrottle` still records the
    // 0.5 that WOULD have trimmed it, which is what makes the dark observation
    // on the live side keep working under a demo arm.
    expect(snap.byPath.equity_live).toMatchObject({ armed: false, consults: 1, trims: 0, minMultiplier: null, lastThrottle: 0.5 });
    expect(snap.totalConsults).toBe(2);
    expect(snap.totalTrims).toBe(1);
  });

  it('a legacy truthy value arms DEMO ONLY — it cannot widen onto the live path', () => {
    process.env[RISK_THROTTLE_SIZING_FLAG] = '1';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    throttleEngine(engine, 0.5);
    expect(mult(engine, 'equity_demo')).toBe(0.5);
    expect(mult(engine, 'equity_live')).toBe(1);
    expect(snapshotRiskThrottleSizing().armedScope).toBe('demo');
  });

  it('counts a real trim per chokepoint once armed for all', () => {
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'all';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    throttleEngine(engine, 0.25);
    mult(engine, 'equity_live');
    mult(engine, 'equity_live_mirror');
    mult(engine, 'options_single_leg');

    const snap = snapshotRiskThrottleSizing();
    expect(snap.armedScope).toBe('all');
    expect(snap.totalTrims).toBe(3);
    expect(snap.byPath.equity_live).toMatchObject({ armed: true, consults: 1, trims: 1, minMultiplier: 0.25, lastThrottle: 0.25 });
    expect(snap.byPath.options_single_leg?.trims).toBe(1);
    expect(snap.byPath.equity_demo).toBeUndefined(); // never consulted ⇒ absent, not 0
  });

  it('the live order and its local mirror get the SAME scalar under EVERY scope', () => {
    // They size independently off the same balance; a divergence here books a
    // mirror row that does not match the broker order. This is why the mirror
    // shares the live path's scope requirement instead of counting as "demo".
    for (const raw of ['off', 'demo', 'all']) {
      process.env[RISK_THROTTLE_SIZING_FLAG] = raw;
      const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
      throttleEngine(engine, 0.4);
      expect(mult(engine, 'equity_live')).toBe(mult(engine, 'equity_live_mirror'));
    }
  });

  it('the stamped throttle term matches the term the sizing call applied', () => {
    // The stamp is a separate, non-recording recompute (it must not double-count
    // consults). Pin that it agrees with the sizing path and does NOT add one.
    process.env[RISK_THROTTLE_SIZING_FLAG] = 'demo';
    const engine = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS });
    throttleEngine(engine, 0.5);
    const term = (p: RiskThrottleSizingPath): number =>
      (engine as unknown as { _riskThrottleTermForTests(p: RiskThrottleSizingPath): number })
        ._riskThrottleTermForTests(p);

    expect(term('options_single_leg')).toBe(0.5);
    expect(term('equity_live')).toBe(1);
    expect(snapshotRiskThrottleSizing().totalConsults).toBe(0); // stamping is not a consult
    expect(mult(engine, 'options_single_leg')).toBe(term('options_single_leg'));
    expect(snapshotRiskThrottleSizing().totalConsults).toBe(1);
  });
});

describe('the since-boot registry', () => {
  it('separates "never consulted" from "consulted, never trimmed"', () => {
    recordRiskThrottleSizing('equity_live', { armed: true, throttle: 1, multiplier: 1 });
    const snap = snapshotRiskThrottleSizing();
    expect(snap.byPath.equity_live).toMatchObject({ armed: true, consults: 1, trims: 0, minMultiplier: null });
    expect(snap.byPath.equity_demo).toBeUndefined();
    expect(snap.totalConsults).toBe(1);
    expect(snap.totalTrims).toBe(0);
  });

  it('keeps the SMALLEST multiplier applied, not the latest', () => {
    recordRiskThrottleSizing('equity_demo', { armed: true, throttle: 0.3, multiplier: 0.3 });
    recordRiskThrottleSizing('equity_demo', { armed: true, throttle: 0.8, multiplier: 0.8 });
    expect(snapshotRiskThrottleSizing().byPath.equity_demo).toMatchObject({
      consults: 2, trims: 2, minMultiplier: 0.3, lastThrottle: 0.8,
    });
  });

  it('names the arming flag so a health reader knows which key to check', () => {
    expect(snapshotRiskThrottleSizing({}).flag).toBe(RISK_THROTTLE_SIZING_FLAG);
  });

  it('the snapshot no longer carries a scope-blind `armed` boolean', () => {
    // TRA-2333 — the boolean was REMOVED, not kept alongside `armedScope`. A
    // demo arm and an all arm both reported `armed: true`, so a reader could not
    // tell a correctly-scoped arm from an accidental live one. Absent is loud;
    // a `true` that silently drops the distinction is not.
    const snap = snapshotRiskThrottleSizing({ [RISK_THROTTLE_SIZING_FLAG]: 'demo' });
    expect((snap as unknown as Record<string, unknown>).armed).toBeUndefined();
    expect(snap.armedScope).toBe('demo');
  });
});
