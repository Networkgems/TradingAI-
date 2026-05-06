import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OtmMispricingSignal, RelativeValueSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// Inside an ET trading window: 10:00 AM ET = 14:00 UTC during EDT (UTC-4).
// Pin to a Tuesday so the weekday/window predicate passes.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-1',
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
    theo: 1.30,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PaperOptionsAccount.openOptionFromCandidate', () => {
  it('opens a position sized off mark*100 using the OTM budget ratio (TRA-160)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const sig = buildSignal({ mark: 1.0 });
    // OTM budget = 50_000 * 0.5 * 0.025 = $625 → 6 contracts at $100 each.
    const pos = acct.openOptionFromCandidate(sig);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(6);
    expect(pos!.premiumPaid).toBe(1.0);
    expect(pos!.signalType).toBe('otm_mispricing');
    expect(pos!.optionSymbol).toBe('AAPL240705C00200000');
    expect(pos!.strike).toBe(200);
    expect(pos!.expiration).toBe('2024-07-05');
    // SL/TP must follow the OTM overrides, not the ATM defaults.
    expect(pos!.stopLossPremium).toBeCloseTo(0.80, 5);    // 1 − 0.20 SL
    expect(pos!.tp1Premium).toBeCloseTo(1.50, 5);          // 1 + 0.50 TP1
  });

  it('returns null when contracts size to zero (mark too rich for the OTM budget)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 1_000, managedAccountRatio: 0.5 });
    // OTM budget = 1_000 * 0.5 * 0.025 = $12.50; one contract at mark=$1 costs $100 → 0 contracts.
    const sig = buildSignal({ mark: 1.0 });
    expect(acct.openOptionFromCandidate(sig)).toBeNull();
    // Cash untouched.
    expect(acct.getState().optionsCash).toBe(1_000);
    expect(acct.getState().dailyOptionsCount).toBe(0);
  });

  it('caps OTM entries against the user-configurable optionsDailyTradesLimit (TRA-195)', () => {
    // Unified cap = 2 → third OTM candidate must be refused regardless of which scanner
    // path it came from. Pre-TRA-195 this was a per-source OTM cap; the wake comment on
    // TRA-195 confirmed users want one knob that governs the total daily options count.
    const acct = new PaperOptionsAccount({
      initialEquity: 200_000,
      managedAccountRatio: 0.5,
      optionsDailyTradesLimit: 2,
    });
    const a = acct.openOptionFromCandidate(buildSignal({ optionSymbol: 'AAA', strike: 200 }));
    const b = acct.openOptionFromCandidate(buildSignal({ id: 's2', optionSymbol: 'BBB', strike: 210 }));
    const c = acct.openOptionFromCandidate(buildSignal({ id: 's3', optionSymbol: 'CCC', strike: 220 }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).toBeNull();
    expect(acct.getState().openOptions).toHaveLength(2);
  });

  it('dedups by OCC symbol — second call with same optionSymbol is a no-op', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const sig = buildSignal();
    const first = acct.openOptionFromCandidate(sig);
    expect(first).not.toBeNull();
    const second = acct.openOptionFromCandidate({ ...sig, id: 'sig-2' });
    expect(second).toBeNull();
    expect(acct.getState().openOptions).toHaveLength(1);
  });

  it('allows another OTM contract on the same underlying with a different OCC', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const a = acct.openOptionFromCandidate(buildSignal({ optionSymbol: 'AAPL240705C00200000' }));
    const b = acct.openOptionFromCandidate(buildSignal({ id: 'sig-2', optionSymbol: 'AAPL240705C00210000', strike: 210 }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(acct.getState().openOptions).toHaveLength(2);
  });

  it('refuses to open outside ET trading windows', () => {
    // 02:00 UTC on a weekday — well outside the 9:35–11:30 / 13:30–15:30 ET windows.
    vi.setSystemTime(Date.parse('2024-06-04T02:00:00Z'));
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(acct.openOptionFromCandidate(buildSignal())).toBeNull();
  });
});

describe('PaperOptionsAccount.checkExits — chain-driven OTM marks', () => {
  it('uses the option mark from the chain map for OTM positions and exits on the tighter OTM SL', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }));
    expect(pos).not.toBeNull();

    // Mark drops 25% — past the OTM −20% stop-loss → full exit at the SL level.
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.75]]);
    const closed = acct.checkExits(new Map(), marks);

    expect(closed).toHaveLength(1);
    expect(closed[0].closedAt).toBeDefined();
    expect(closed[0].pnl).toBeLessThan(0);
    // Realized loss = (0.80 - 1.0) * 6 contracts * 100 = -$120
    expect(closed[0].pnl).toBeCloseTo(-120, 0);
  });

  it('skips OTM positions when no chain mark is supplied (waits for next tick)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }));
    expect(pos).not.toBeNull();
    const before = acct.getState().openOptions[0].currentPremium;

    // Underlying moves but no option mark — OTM position must NOT be re-priced
    // off the underlying because the mark-refresh path is the source of truth.
    const closed = acct.checkExits(new Map([['AAPL', 250]]), new Map());

    expect(closed).toHaveLength(0);
    expect(acct.getState().openOptions[0].currentPremium).toBe(before);
  });

  it('keeps the legacy delta-extrapolation path for ATM (non-OTM) positions', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // Open an ATM call via the existing openOption path.
    const pos = acct.openOption({
      id: 'sig-atm',
      symbol: 'AAPL',
      type: 'orb_breakout',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 98,
      takeProfit: 105,
      riskRewardRatio: 2,
      timestamp: TRADING_TIME,
    }, 100);
    expect(pos).not.toBeNull();
    const entryPremium = pos!.premiumPaid;

    // Underlying drops $2 → premium move = -2 * 0.5 = -$1.0 (50% of premium).
    // Premium ≈ 1.0; new mark ≈ entryPremium - 1.0 = 1.0 → already past SL.
    const closed = acct.checkExits(new Map([['AAPL', 98]]));
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeLessThan(0);
    expect(entryPremium).toBe(2.0);
  });
});

describe('PaperOptionsAccount.voidOpenOption (TRA-319)', () => {
  function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
    return {
      id: 'rv-1',
      symbol: 'AAPL',
      type: 'relative_value',
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
      fairPrice: 1.30,
      mispricingPct: -0.23,
      zScore: -2.1,
      ivFitted: 0.32,
      ivUsed: 0.28,
      delta: 0.18,
      reason: 'cheap-vs-curve',
      ...overrides,
    };
  }

  it('refunds cash and reverts the daily counter when an RV open is voided', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const startCash = acct.getState().optionsCash;
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();
    // RV budget = 50_000 * 0.5 * 0.05 = $1,250 → 12 contracts at $100 each.
    const cashAfterOpen = acct.getState().optionsCash;
    expect(cashAfterOpen).toBeLessThan(startCash);
    expect(acct.getState().dailyOptionsCount).toBe(1);

    expect(acct.voidOpenOption(pos!.id)).toBe(true);

    // Cash fully restored, position gone from open list, daily counter reverted.
    expect(acct.getState().optionsCash).toBeCloseTo(startCash, 5);
    expect(acct.getState().openOptions).toHaveLength(0);
    expect(acct.getState().dailyOptionsCount).toBe(0);
    // Voided opens leave NO trace in closed-options (vs. closeOption).
    expect(acct.getState().closedOptions).toHaveLength(0);
    // No realized P&L attributed.
    expect(acct.getState().optionsPnl).toBe(0);
  });

  it('returns false for an unknown id', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(acct.voidOpenOption('does-not-exist')).toBe(false);
  });

  it('frees the daily slot so a new RV open can take its place after a void', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      optionsDailyTradesLimit: 1,
    });
    const a = acct.openOptionFromRvCandidate(buildRvSignal({ optionSymbol: 'AAA' }), 'live');
    expect(a).not.toBeNull();
    expect(acct.voidOpenOption(a!.id)).toBe(true);
    // Slot must be reusable since the broker rejected the original — the user
    // shouldn't lose a daily entry to a trade that never happened.
    const b = acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-2', optionSymbol: 'BBB', strike: 210 }),
      'live',
    );
    expect(b).not.toBeNull();
  });
});

describe('PaperOptionsAccount — TRA-332 live equity override sizing', () => {
  function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
    return {
      id: 'rv-1',
      symbol: 'AAPL',
      type: 'relative_value',
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
      fairPrice: 1.30,
      mispricingPct: -0.23,
      zScore: -2.1,
      ivFitted: 0.32,
      ivUsed: 0.28,
      delta: 0.18,
      reason: 'cheap-vs-curve',
      ...overrides,
    };
  }

  it('sizes against equityOverride instead of paper equity in live mode', () => {
    // Paper account seeded at $50 K (matches the demo equity that survives
    // a live flip). Without the override, RV budget = $750 → 7 contracts at
    // $100 each. With override = $2,000 → budget = $30 → 0 contracts.
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const sig = buildRvSignal({ mark: 1.0 });

    const pos = acct.openOptionFromRvCandidate(sig, 'live', 2000);
    // 0 contracts → returns null. The fix is that this returns null on the
    // LIVE figure, not the paper figure — preventing the engine from sizing
    // a too-large position that TRA-319 would silently void downstream.
    expect(pos).toBeNull();
    expect(acct.getState().dailyOptionsCount).toBe(0);
  });

  it('opens positions sized off the override when the live equity supports it', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // Override = $20 K → RV budget = 20_000 * 0.5 * 0.03 = $300 → 3 contracts.
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live', 20_000);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(3);
    expect(pos!.mode).toBe('live');
  });

  it('skips the paper-cash check under an override (paper cash is bookkeeping in live mode)', () => {
    // initialEquity = $100 paper cash so the unconstrained sizing would
    // overflow the paper account. The override should bypass that check —
    // the real buying-power constraint is enforced upstream against
    // Tradier's optionBuyingPower, not paper cash.
    const acct = new PaperOptionsAccount({ initialEquity: 100, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live', 50_000);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBeGreaterThan(0);
  });

  it('getRvBudgetForEquity reflects the configured managedRatio and budget ratio', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // 300 * 0.5 * 0.03 = $4.50 (the original TRA-332 user's budget).
    expect(acct.getRvBudgetForEquity(300)).toBeCloseTo(4.5, 5);
    // Doubling managedRatio doubles the budget.
    acct.updateConfig({ managedAccountRatio: 1.0 });
    expect(acct.getRvBudgetForEquity(300)).toBeCloseTo(9, 5);
  });
});

describe('PaperOptionsAccount.getStateForMode — per-mode P&L (TRA-246)', () => {
  it('attributes a live-mode auto-exit to the live bucket only (demo dashboard stays $0)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // Open as live so the position is mode-stamped 'live'.
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();

    // Mark drops past the OTM −20% SL → full exit at the SL level → realized loss.
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.75]]);
    const closed = acct.checkExits(new Map(), marks, 'live');
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeLessThan(0);

    const live = acct.getStateForMode('live');
    const demo = acct.getStateForMode('demo');
    // Live bucket holds the realized loss; demo bucket is untouched at $0
    // even though both views read from the same PaperOptionsAccount instance.
    expect(live.optionsPnl).toBeCloseTo(closed[0].pnl ?? 0, 5);
    expect(demo.optionsPnl).toBe(0);
    // Demo never opens options under TRA-220, so its visible cash is forced
    // to 0 to avoid surfacing the live-side cash on the Demo dashboard.
    expect(demo.optionsCash).toBe(0);
    // Live cash mirrors the underlying account cash (proceeds returned at exit).
    expect(live.optionsCash).toBeGreaterThan(0);
    // Bucket-wide getState() still exposes the cross-mode total for the EOD
    // report / PnlTracker consumers.
    expect(acct.getState().optionsPnl).toBeCloseTo(closed[0].pnl ?? 0, 5);
  });

  it('attributes a live manual closeOption to the live bucket only', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();

    // Bump the current premium so a manual close realizes a $+ P&L.
    const opened = acct.getState().openOptions[0];
    opened.currentPremium = 1.50;

    const closed = acct.closeOption(opened.id);
    expect(closed).not.toBeNull();
    expect(closed!.pnl).toBeGreaterThan(0);

    expect(acct.getStateForMode('demo').optionsPnl).toBe(0);
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(closed!.pnl ?? 0, 5);
  });

  it('legacy snapshot without optionsPnlByMode attributes the bucket-wide total to the live bucket', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // Pre-TRA-246 snapshot — only the bucket-wide optionsPnl is persisted.
    acct.importSnapshot({
      openOptions: [],
      closedOptions: [],
      optionsPnl: 524.50,
      dailyCount: 10,
      currentDayKey: '2026-04-28',
      cash: 25_000,
      equity: 25_524.50,
    });
    // TRA-220 forbids demo from opening options, so a legacy total can only
    // have come from live trades; route it to the live bucket on import.
    expect(acct.getStateForMode('live').optionsPnl).toBe(524.50);
    expect(acct.getStateForMode('demo').optionsPnl).toBe(0);
    // Total still equals the legacy field for back-compat consumers.
    expect(acct.getState().optionsPnl).toBe(524.50);
  });

  it('round-trips per-mode P&L via export/import', () => {
    const a = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = a.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();
    a.checkExits(new Map(), new Map([[pos!.optionSymbol!, 0.75]]), 'live');
    const livePnl = a.getStateForMode('live').optionsPnl;
    expect(livePnl).toBeLessThan(0);

    const snap = a.exportSnapshot();
    expect(snap.optionsPnlByMode).toBeDefined();
    expect(snap.optionsPnlByMode!.live).toBeCloseTo(livePnl, 5);
    expect(snap.optionsPnlByMode!.demo).toBe(0);

    const b = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    b.importSnapshot(snap);
    expect(b.getStateForMode('live').optionsPnl).toBeCloseTo(livePnl, 5);
    expect(b.getStateForMode('demo').optionsPnl).toBe(0);
  });
});

// ─── TRA-323: Tradier-positions sync ─────────────────────────────────────────

function buildTradierPosition(overrides: Partial<TradierOpenOptionPosition> = {}): TradierOpenOptionPosition {
  return {
    optionSymbol: 'SPY260515C00450000',
    underlying: 'SPY',
    optionType: 'call',
    strike: 450,
    expiration: '2026-05-15',
    contracts: 2,
    premiumPaid: 1.6,
    acquiredAt: TRADING_TIME,
    ...overrides,
  };
}

describe('PaperOptionsAccount.reconcileTradierPositions', () => {
  it('imports unknown Tradier positions without touching cash or daily counters', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    const before = acct.getState();

    const summary = acct.reconcileTradierPositions([buildTradierPosition()]);

    expect(summary).toEqual({ added: 1, updated: 0, removed: 0, total: 1 });
    const state = acct.getState();
    expect(state.openOptions).toHaveLength(1);
    const imported = state.openOptions[0];
    expect(imported.importedFromTradier).toBe(true);
    expect(imported.signalType).toBe('tradier_import');
    expect(imported.symbol).toBe('SPY');
    expect(imported.optionSymbol).toBe('SPY260515C00450000');
    expect(imported.tradierEnv).toBe('sandbox');
    // Imported positions never touch cash or the daily counter — they live
    // on Tradier's books, not the local paper bucket.
    expect(state.optionsCash).toBe(before.optionsCash);
    expect(state.dailyOptionsCount).toBe(0);
  });

  it('updates an existing imported row when contracts or premium change', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition({ contracts: 2, premiumPaid: 1.6 })]);
    const summary = acct.reconcileTradierPositions([
      buildTradierPosition({ contracts: 3, premiumPaid: 1.7 }),
    ]);
    expect(summary).toEqual({ added: 0, updated: 1, removed: 0, total: 1 });
    const opt = acct.getState().openOptions[0];
    expect(opt.contracts).toBe(3);
    expect(opt.contractsRemaining).toBe(3);
    expect(opt.premiumPaid).toBeCloseTo(1.7, 5);
  });

  it('drops imported rows that disappear from Tradier (closed elsewhere)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([
      buildTradierPosition({ optionSymbol: 'SPY260515C00450000' }),
      buildTradierPosition({
        optionSymbol: 'AAPL260920P00187500',
        underlying: 'AAPL',
        optionType: 'put',
        strike: 187.5,
        expiration: '2026-09-20',
      }),
    ]);
    expect(acct.getState().openOptions).toHaveLength(2);

    const summary = acct.reconcileTradierPositions([
      buildTradierPosition({ optionSymbol: 'SPY260515C00450000' }),
    ]);
    expect(summary).toEqual({ added: 0, updated: 0, removed: 1, total: 1 });
    const open = acct.getState().openOptions;
    expect(open).toHaveLength(1);
    expect(open[0].optionSymbol).toBe('SPY260515C00450000');
  });

  it('leaves engine-opened positions untouched even when Tradier reports the same OCC', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      tradierEnv: 'sandbox',
    });
    const sig = buildSignal({ optionSymbol: 'AAPL240705C00200000' });
    const opened = acct.openOptionFromCandidate(sig, 'live');
    expect(opened).not.toBeNull();
    const beforeContracts = opened!.contracts;
    const beforePremium = opened!.premiumPaid;

    const summary = acct.reconcileTradierPositions([
      buildTradierPosition({
        optionSymbol: 'AAPL240705C00200000',
        underlying: 'AAPL',
        optionType: 'call',
        strike: 200,
        expiration: '2024-07-05',
        contracts: 99,
        premiumPaid: 9.99,
      }),
    ]);
    // Engine-opened row covers this OCC; reconcile leaves it alone.
    expect(summary).toEqual({ added: 0, updated: 0, removed: 0, total: 1 });
    const survivor = acct.getState().openOptions.find(o => o.optionSymbol === 'AAPL240705C00200000');
    expect(survivor?.importedFromTradier).toBeFalsy();
    expect(survivor?.contracts).toBe(beforeContracts);
    expect(survivor?.premiumPaid).toBe(beforePremium);
  });

  it('checkExits skips imported positions so they are never auto-closed', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 1.6 })]);
    const open = acct.getState().openOptions[0];

    // Even with a mark that would normally trigger SL, imported rows must
    // be left alone — the user closes them manually via Tradier.
    const closed = acct.checkExits(new Map(), new Map([[open.optionSymbol!, 0.01]]), 'live');
    expect(closed).toEqual([]);
    expect(acct.getState().openOptions).toHaveLength(1);
  });

  it('closeOption refuses imported positions; dropImportedPosition removes them cleanly', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition()]);
    const id = acct.getState().openOptions[0].id;
    const cashBefore = acct.getState().optionsCash;

    expect(acct.closeOption(id)).toBeNull(); // refuses — would double-count
    expect(acct.getState().openOptions).toHaveLength(1);

    const dropped = acct.dropImportedPosition(id);
    expect(dropped?.id).toBe(id);
    expect(acct.getState().openOptions).toHaveLength(0);
    // Cash untouched — imported positions never lived on the paper bucket.
    expect(acct.getState().optionsCash).toBe(cashBefore);
  });
});
