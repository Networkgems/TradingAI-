import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  DEFAULT_STRATEGY_PRESET_ID,
  STRATEGY_PRESETS,
  resolveStrategyPreset,
  presetAllowsStrategySymbol,
} from '@trading-app/shared';
import type { AccountSettings } from '@trading-app/shared';
import type {
  CoinbaseAccountBalance,
  CoinbaseFuturesPosition,
  CoinbaseListedProduct,
  CoinbaseOrderClient,
  CoinbaseOrderDetails,
  CoinbaseOrderSuccessResponse,
  CoinbaseProductBook,
  CoinbaseProductInfo,
} from '@trading-app/engine';
import type { TradeSignal } from '@trading-app/shared';

import { CryptoSignalEngine, resolveLiveSingleSymbolShortCap, mergeCandles } from './crypto-engine.js';
import type { Candle } from '@trading-app/shared';
import { CryptoLiveAccount } from './crypto-live-account.js';
import {
  CryptoPaperAccount,
  CRYPTO_FEE_BPS,
  CRYPTO_SLIPPAGE_BPS,
} from './crypto-account.js';
import type { PositionQuoteSource, StrategyPreset } from '@trading-app/shared';

// TRA-320 — exercise the CryptoSignalEngine.manualClosePosition wiring against
// a live account backed by a stubbed Coinbase client. This is the path the
// /api/crypto/positions/:id/close route drives end-to-end (route → engine →
// liveAccount → Coinbase). Pre-fix the engine fired-and-forgot the broker
// close and immediately returned an optimistic snapshot; on a Coinbase reject
// the dashboard would show the position vanish and reappear with no signal
// that anything failed. The tests below assert (a) the success path records
// the close into liveClosedPositions, (b) the rejection path propagates the
// error so the route can surface a 502 + reason instead of returning ok:true.

class FakeCoinbaseClient {
  listAccounts = vi.fn<() => Promise<CoinbaseAccountBalance[]>>();
  placeMarketOrder = vi.fn<() => Promise<CoinbaseOrderSuccessResponse>>();
  closeFuturesPosition = vi.fn<() => Promise<CoinbaseOrderSuccessResponse>>();
  getOrder = vi.fn<(orderId: string) => Promise<CoinbaseOrderDetails>>();
  getProductPrices = vi.fn<(productIds: string[]) => Promise<Map<string, number>>>(
    async () => new Map(),
  );
  getProducts = vi.fn<(productIds: string[]) => Promise<Map<string, CoinbaseProductInfo>>>(
    async () => new Map(),
  );
  listProducts = vi.fn<(productType: 'SPOT' | 'FUTURE') => Promise<CoinbaseListedProduct[]>>(
    async () => [],
  );
  listPortfolios = vi.fn<() => Promise<Array<{ uuid: string; type?: string }>>>(
    async () => [],
  );
  listFuturesPositions = vi.fn<(uuid: string) => Promise<CoinbaseFuturesPosition[]>>(
    async () => [],
  );
  getProductBook = vi.fn<(productId: string) => Promise<CoinbaseProductBook>>(
    async () => ({}),
  );
}

function asClient(fake: FakeCoinbaseClient): CoinbaseOrderClient {
  return fake as unknown as CoinbaseOrderClient;
}

function buildSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'sig-1',
    symbol: 'BTC-USD',
    type: 'reversal',
    side: 'buy',
    entryPrice: 60_000,
    stopLoss: 59_400,
    takeProfit: 61_800,
    riskRewardRatio: 3,
    timestamp: Date.now(),
    ...overrides,
  };
}

function orderSuccess(orderId: string, side: 'BUY' | 'SELL' = 'BUY'): CoinbaseOrderSuccessResponse {
  return { order_id: orderId, product_id: 'BTC-USD', side, client_order_id: 'cli' };
}

function orderDetails(overrides: Partial<CoinbaseOrderDetails>): CoinbaseOrderDetails {
  return {
    order_id: 'o1',
    product_id: 'BTC-USD',
    side: 'BUY',
    status: 'FILLED',
    average_filled_price: '0',
    filled_size: '0',
    ...overrides,
  };
}

async function liveAccountWithOpenSpot(): Promise<{
  account: CryptoLiveAccount;
  coinbase: FakeCoinbaseClient;
  positionId: string;
}> {
  const coinbase = new FakeCoinbaseClient();
  coinbase.listAccounts.mockResolvedValue([
    {
      uuid: 'usd',
      name: 'USD',
      currency: 'USD',
      available_balance: { value: '100000', currency: 'USD' },
      hold: { value: '0', currency: 'USD' },
    },
  ]);
  const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });
  await account.refreshBalance();

  coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-buy', 'BUY'));
  coinbase.getOrder.mockResolvedValueOnce(
    orderDetails({ order_id: 'o-buy', side: 'BUY', status: 'FILLED', average_filled_price: '60000', filled_size: '0.5' }),
  );
  const opened = await account.openPosition(buildSignal(), 60_000);
  if (!opened) throw new Error('test setup: openPosition returned null');
  return { account, coinbase, positionId: opened.id };
}

function liveEngineWith(account: CryptoLiveAccount): CryptoSignalEngine {
  // Build a default demo engine, then forcibly attach the prepared live
  // account + flip mode. The engine's constructor heavy-init path is bound
  // to env credentials we don't want a unit test to depend on; the field
  // shape is private so we reach in via cast. This is the same wiring path
  // the route uses once `tryInitLiveBroker` has resolved in production.
  const engine = new CryptoSignalEngine();
  const internal = engine as unknown as { mode: 'demo' | 'live'; liveAccount: CryptoLiveAccount };
  internal.mode = 'live';
  internal.liveAccount = account;
  return engine;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('CryptoSignalEngine.manualClosePosition — live mode wiring (TRA-320)', () => {
  it('routes the close through Coinbase and records the live closed position on success', async () => {
    const { account, coinbase, positionId } = await liveAccountWithOpenSpot();
    const engine = liveEngineWith(account);

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-sell', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-sell', side: 'SELL', status: 'FILLED', average_filled_price: '60500', filled_size: '0.5' }),
    );

    const closed = await engine.manualClosePosition(positionId, 60_500);

    expect(closed).not.toBeNull();
    expect(closed!.mode).toBe('live');
    expect(coinbase.placeMarketOrder).toHaveBeenLastCalledWith({
      productId: 'BTC-USD',
      side: 'sell',
      baseSize: 0.5,
    });
    // Position is gone from the broker mirror — the dashboard's next state
    // build will reflect the close from the source of truth (broker), not
    // an optimistic snapshot.
    expect(account.getState().openPositions.find(p => p.id === positionId)).toBeUndefined();
    // Closed-position list under live scope picked up the entry so the Live
    // history panel shows it on the next broadcast.
    const reportSnap = engine.getReportSnapshot('live');
    expect(reportSnap.allClosedPositions).toHaveLength(1);
    expect(reportSnap.allClosedPositions[0]!.id).toBe(positionId);
  });

  it('propagates the Coinbase rejection so the route can surface 502 + reason', async () => {
    const { account, coinbase, positionId } = await liveAccountWithOpenSpot();
    const engine = liveEngineWith(account);

    // Coinbase rejects the SELL — pre-fix this was swallowed by the
    // fire-and-forget; the route returned ok:true and the dashboard saw the
    // position vanish only to reappear on the next state broadcast with no
    // explanation.
    coinbase.placeMarketOrder.mockRejectedValueOnce(new Error('INSUFFICIENT_FUND'));

    await expect(engine.manualClosePosition(positionId, 60_500)).rejects.toThrow('INSUFFICIENT_FUND');

    // Position MUST stay open in the broker mirror — the dashboard's next
    // state build keeps surfacing it instead of optimistically removing it.
    expect(account.getState().openPositions.find(p => p.id === positionId)).toBeDefined();
    // No live closed-position record was added on failure.
    const reportSnap = engine.getReportSnapshot('live');
    expect(reportSnap.allClosedPositions).toHaveLength(0);
  });

  it('routes imported wallet-holding closes through Coinbase by id', async () => {
    // TRA-318 holdings reconciled from the Coinbase wallet show up in the
    // dashboard's openPositions list with id `imported-spot-{CCY}-USD`. The
    // route's id-based lookup resolves to the engine's manualClosePosition,
    // which must hand the imported id straight to liveAccount.closePosition
    // (which dispatches to the importedSpot branch).
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      {
        uuid: 'usd', name: 'USD', currency: 'USD',
        available_balance: { value: '500', currency: 'USD' },
        hold: { value: '0', currency: 'USD' },
      },
      {
        uuid: 'btc', name: 'BTC', currency: 'BTC',
        available_balance: { value: '0.25', currency: 'BTC' },
        hold: { value: '0', currency: 'BTC' },
      },
    ]);
    coinbase.getProductPrices.mockResolvedValue(new Map([['BTC-USD', 60_000]]));
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });
    await account.refreshBalance();
    const engine = liveEngineWith(account);

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-imp-sell', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-imp-sell', side: 'SELL', status: 'FILLED', average_filled_price: '60500', filled_size: '0.25' }),
    );

    const closed = await engine.manualClosePosition('imported-spot-BTC-USD', 60_000);

    expect(closed).not.toBeNull();
    expect(closed!.mode).toBe('live');
    expect(coinbase.placeMarketOrder).toHaveBeenCalledWith({
      productId: 'BTC-USD',
      side: 'sell',
      baseSize: 0.25,
    });
    expect(
      account.getState().openPositions.find(p => p.id.startsWith('imported-spot-')),
    ).toBeUndefined();
  });
});

describe('Strategy presets — TRA-325', () => {
  // The preset library is the load-bearing contract for the Settings UI and
  // the live $180 board test. These tests pin the resolver behavior + the
  // shape of each preset so a future refactor can't silently shift the
  // deployed configuration.

  it('resolves an undefined / null id to the default legacy_5 preset', () => {
    expect(resolveStrategyPreset(undefined).id).toBe(DEFAULT_STRATEGY_PRESET_ID);
    expect(resolveStrategyPreset(null).id).toBe('legacy_5');
  });

  it('resolves a known id to the matching preset', () => {
    expect(resolveStrategyPreset('legacy_5').id).toBe('legacy_5');
    expect(resolveStrategyPreset('bb_fade_sol_doge').id).toBe('bb_fade_sol_doge');
  });

  it('falls back to legacy_5 on an unknown id (defensive against junk in stored settings)', () => {
    expect(resolveStrategyPreset('not_a_real_preset').id).toBe('legacy_5');
    expect(resolveStrategyPreset('').id).toBe('legacy_5');
  });

  it('maps the legacy TRA-324 env value bb_fade_sol_doge_only → bb_fade_sol_doge', () => {
    // render.yaml shipped this value with TRA-324; until ops pushes the new
    // preset id this fallback keeps the live test config pinned.
    expect(resolveStrategyPreset('bb_fade_sol_doge_only').id).toBe('bb_fade_sol_doge');
  });

  it('legacy_5 enables every crypto strategy with no symbol filter', () => {
    const p = STRATEGY_PRESETS.legacy_5;
    expect(p.symbolFilter).toBeNull();
    expect([...p.enabledStrategies].sort()).toEqual(
      ['bb_fade', 'breakout_vol', 'mean_reversion', 'momentum', 'swing_trade'],
    );
  });

  it('bb_fade_sol_doge enables only bb_fade and scopes to SOL+DOGE', () => {
    const p = STRATEGY_PRESETS.bb_fade_sol_doge;
    expect(p.enabledStrategies).toEqual(['bb_fade']);
    expect(p.symbolFilter).toEqual(['SOL-USD', 'DOGE-USD']);
  });

  // TRA-421 — the TRA-405 §8 validated roster.
  it('tra405_validated enables only bb_fade and gates it to BTC+SOL via strategyUniverse', () => {
    const p = STRATEGY_PRESETS.tra405_validated;
    expect(p.enabledStrategies).toEqual(['bb_fade']);
    // No preset-wide filter — the per-strategy universe carries the gate so
    // the macd_bollinger/bb_fade edge is restricted to its validated symbols.
    expect(p.symbolFilter).toBeNull();
    expect(p.strategyUniverse?.bb_fade).toEqual(['BTC-USD', 'SOL-USD']);
    // momentum / breakout_vol are NO-GO: disabled by absence from the roster.
    expect(p.enabledStrategies).not.toContain('momentum');
    expect(p.enabledStrategies).not.toContain('breakout_vol');
  });

  it('resolves the tra405_validated id (the live LIVE_STRATEGY_PRESET pin)', () => {
    expect(resolveStrategyPreset('tra405_validated').id).toBe('tra405_validated');
  });

  // TRA-421 — presetAllowsStrategySymbol: the symbolFilter + strategyUniverse gate.
  it('presetAllowsStrategySymbol gates bb_fade to BTC+SOL under tra405_validated', () => {
    const p = STRATEGY_PRESETS.tra405_validated;
    expect(presetAllowsStrategySymbol(p, 'bb_fade', 'BTC-USD')).toBe(true);
    expect(presetAllowsStrategySymbol(p, 'bb_fade', 'SOL-USD')).toBe(true);
    expect(presetAllowsStrategySymbol(p, 'bb_fade', 'DOGE-USD')).toBe(false);
    expect(presetAllowsStrategySymbol(p, 'bb_fade', 'ETH-USD')).toBe(false);
  });

  it('presetAllowsStrategySymbol leaves an unmapped strategy gated by symbolFilter only', () => {
    // legacy_5: no symbolFilter, no strategyUniverse → every strategy/symbol allowed.
    const legacy = STRATEGY_PRESETS.legacy_5;
    expect(presetAllowsStrategySymbol(legacy, 'momentum', 'ANY-USD')).toBe(true);
    // tra405_validated: swing_trade is not in strategyUniverse and there is no
    // preset-wide filter, so it is unrestricted (it is separately disabled by
    // not being in enabledStrategies — a gate this helper deliberately ignores).
    const validated = STRATEGY_PRESETS.tra405_validated;
    expect(presetAllowsStrategySymbol(validated, 'swing_trade', 'XRP-USD')).toBe(true);
  });

  it('presetAllowsStrategySymbol — preset-wide symbolFilter still applies', () => {
    const p = STRATEGY_PRESETS.bb_fade_sol_doge;
    expect(presetAllowsStrategySymbol(p, 'bb_fade', 'SOL-USD')).toBe(true);
    expect(presetAllowsStrategySymbol(p, 'bb_fade', 'BTC-USD')).toBe(false);
  });

  it('TRA-434 — no_trade resolves and enables zero strategies on zero symbols', () => {
    // Risk stand-down preset pinned via LIVE_STRATEGY_PRESET after the
    // TRA-432 NO-GO (which superseded TRA-405's dirty-cache "go"). With no
    // enabled strategies, every per-tick strategyEnabled() check returns
    // false, so the engine opens no new entries; the empty symbolFilter is
    // belt-and-suspenders. Exit logic is not preset-gated, so open positions
    // still close on their own rules.
    const p = resolveStrategyPreset('no_trade');
    expect(p.id).toBe('no_trade');
    expect(p.enabledStrategies).toEqual([]);
    expect(p.symbolFilter).toEqual([]);
    expect(STRATEGY_PRESETS.no_trade).toBe(p);
    // Empty symbolFilter also fails the presetAllowsStrategySymbol gate, so
    // even a strategy that somehow stayed enabled could not fire on any leg.
    expect(presetAllowsStrategySymbol(p, 'bb_fade', 'SOL-USD')).toBe(false);
    expect(presetAllowsStrategySymbol(p, 'bb_fade', 'DOGE-USD')).toBe(false);
    expect(presetAllowsStrategySymbol(p, 'bb_fade', 'BTC-USD')).toBe(false);
  });

  it('TRA-345 / TRA-456 / TRA-521 / TRA-696 / TRA-698 — getState().activePreset surfaces the resolved preset for API verification', () => {
    // The default engine is a DEMO engine. Since TRA-696 the demo engine runs
    // DEMO_STRATEGY_PRESET (default `crypto_core`, the TRA-693 rebuild roster)
    // deterministically — it is no longer frozen by the live `no_trade`
    // stand-down and no longer falls through to per-user `activeStrategyPreset`.
    // TRA-698 narrowed crypto_core to DCA-only on {BTC-USD, SOL-USD} after the
    // TRA-695 NO-GO on swing (all 6 symbols) and ETH/ADA/DOGE/LINK.
    // The activePreset block lets /api/crypto/state confirm the active config
    // without Render dashboard / server-log access.
    const engine = new CryptoSignalEngine();
    const ap = engine.getState().activePreset;
    expect(ap.id).toBe('crypto_core');
    // envValue surfaces the LIVE_STRATEGY_PRESET var; unset under test.
    expect(ap.envValue).toBe('');
    expect([...ap.enabledStrategies]).toEqual(['dca']);
    expect(ap.symbolFilter).toBeNull();
    expect(ap.strategyUniverse).toEqual({
      dca: ['BTC-USD', 'SOL-USD'],
    });
  });

  it('TRA-456 / TRA-521 / TRA-696 — demo runs the demo-default preset deterministically; live honours per-user preset', async () => {
    // TRA-456 CTO decision: the `LIVE_STRATEGY_PRESET` stand-down is a
    // capital-allocation control scoped to the LIVE engine. The demo engine
    // trades paper money with zero real-capital exposure, so it runs the
    // DEMO_STRATEGY_PRESET default (`crypto_core` since TRA-696) deterministically
    // and must NOT fall through to per-user `activeStrategyPreset` — the board
    // needs one consistent roster on the demo dashboard.
    const engine = new CryptoSignalEngine();

    // Demo: even with the per-user preset explicitly set to no_trade, the demo
    // engine ignores it and resolves its own default (crypto_core).
    await engine.applySettings(fourBucketCryptoSettings({
      mode: 'demo',
      activeStrategyPreset: 'no_trade',
    }));
    expect(engine.getState().activePreset.id).toBe('crypto_core');

    // Live: with no LIVE_STRATEGY_PRESET env set under test, the live engine
    // falls through to the user's saved activeStrategyPreset (no env override).
    await engine.applySettings(fourBucketCryptoSettings({
      mode: 'live',
      activeStrategyPreset: 'bb_fade_sol_doge',
    }));
    expect(engine.getState().activePreset.id).toBe('bb_fade_sol_doge');
  });
});

describe('CryptoPaperAccount fee + slippage modeling — TRA-342', () => {
  // Demo paper account previously exited at the exact TP/SL trigger with no
  // fee or slip, which made bb_fade in particular look ~3–8× more profitable
  // than what live can capture (its risk distance is 10–25 bps and a
  // round-trip fee alone is ~80 bps). These tests pin the fee/slip math so
  // a future refactor can't silently restore the optimistic exit pricing.

  const FEE_RATE = CRYPTO_FEE_BPS / 10_000;
  const SLIPPAGE_RATE = CRYPTO_SLIPPAGE_BPS / 10_000;

  function buildBuySignal(): TradeSignal {
    return {
      id: 'sig-fee-1',
      symbol: 'SOL-USD',
      type: 'reversal',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 99,
      takeProfit: 102,
      riskRewardRatio: 2,
      timestamp: Date.now(),
    };
  }

  it('exposes the fee + slippage constants used by the sweep harness', () => {
    // Ground truth: these match packages/backtest/src/run-tra306-sweep.ts so
    // demo, live and the sweep all share a single cost model. Don't drop the
    // values without coordinating with that file.
    expect(CRYPTO_FEE_BPS).toBe(40);
    expect(CRYPTO_SLIPPAGE_BPS).toBe(5);
  });

  it('debits cash by entry notional × (1 + fee) when opening', () => {
    const account = new CryptoPaperAccount(25_000, 25_000);
    const before = account.getState();
    const opened = account.openPosition(buildBuySignal(), 100);
    expect(opened).not.toBeNull();
    const after = account.getState();
    const qty = opened!.quantity;
    const expectedCost = 100 * qty * (1 + FEE_RATE);
    expect(before.availableCash - after.availableCash).toBeCloseTo(expectedCost, 6);
  });

  it('books a long TP exit at trigger × (1 − slip) net of round-trip fees', () => {
    const account = new CryptoPaperAccount(25_000, 25_000);
    const opened = account.openPosition(buildBuySignal(), 100);
    expect(opened).not.toBeNull();
    const qty = opened!.quantity;

    // Price gaps through TP — checkExits should fill at tp × (1 − slip).
    const closed = account.checkExits(new Map([['SOL-USD', 102.5]]));
    expect(closed).toHaveLength(1);
    const exit = closed[0]!;

    const expectedExitPrice = 102 * (1 - SLIPPAGE_RATE);
    expect(exit.exitPrice).toBeCloseTo(expectedExitPrice, 6);

    const grossPnl = (expectedExitPrice - 100) * qty;
    const fee = (100 + expectedExitPrice) * qty * FEE_RATE;
    const expectedPnl = grossPnl - fee;
    expect(exit.pnl).toBeCloseTo(expectedPnl, 6);

    // The realized P&L must be strictly less than the naive (tp − entry) × qty
    // by the modeled fee + slip — this is the regression guard.
    const naivePnl = (102 - 100) * qty;
    expect(exit.pnl!).toBeLessThan(naivePnl);
    expect(naivePnl - exit.pnl!).toBeCloseTo(naivePnl - expectedPnl, 6);
  });

  it('books a long SL exit at trigger × (1 − slip) — slip widens the loss', () => {
    // Long stop-loss: the trigger is below entry. Slip pushes the fill *lower*
    // (worse for the long), so the realized loss is larger than (entry − sl) × qty.
    const account = new CryptoPaperAccount(25_000, 25_000);
    const opened = account.openPosition(buildBuySignal(), 100);
    expect(opened).not.toBeNull();
    const qty = opened!.quantity;

    const closed = account.checkExits(new Map([['SOL-USD', 98.5]]));
    expect(closed).toHaveLength(1);
    const exit = closed[0]!;

    const expectedExitPrice = 99 * (1 - SLIPPAGE_RATE);
    expect(exit.exitPrice).toBeCloseTo(expectedExitPrice, 6);

    const naiveLoss = (99 - 100) * qty; // negative
    expect(exit.pnl!).toBeLessThan(naiveLoss); // larger loss than the naive
  });

  it('manual closePosition keeps the quote price but still charges round-trip fees', () => {
    const account = new CryptoPaperAccount(25_000, 25_000);
    const opened = account.openPosition(buildBuySignal(), 100);
    expect(opened).not.toBeNull();
    const qty = opened!.quantity;

    const closed = account.closePosition(opened!.id, 101);
    expect(closed).not.toBeNull();

    // No slippage on a manual close — the user clicked at this exact price.
    expect(closed!.exitPrice).toBe(101);

    const grossPnl = (101 - 100) * qty;
    const fee = (100 + 101) * qty * FEE_RATE;
    expect(closed!.pnl).toBeCloseTo(grossPnl - fee, 6);

    // But the round-trip fee still bites — naive P&L overstates the realized.
    expect(closed!.pnl!).toBeLessThan(grossPnl);
  });
});

// TRA-341 — env-var fallback for the §6 single-symbol short cap. The per-user
// `liveSingleSymbolShortCap` knob still wins; this just gives ops a process-
// wide knob (Render env) so the cap can move without per-user saves.
describe('resolveLiveSingleSymbolShortCap (TRA-341)', () => {
  it('returns the per-user value when both knobs are set (user wins over env)', () => {
    expect(resolveLiveSingleSymbolShortCap(0.4, '0.8')).toBe(0.4);
  });

  it('falls through to the env value when the per-user knob is unset', () => {
    expect(resolveLiveSingleSymbolShortCap(undefined, '0.5')).toBe(0.5);
  });

  it('returns null (engine default) when neither knob is set', () => {
    expect(resolveLiveSingleSymbolShortCap(undefined, undefined)).toBeNull();
  });

  it('rejects non-finite / non-positive user values and falls through to env', () => {
    expect(resolveLiveSingleSymbolShortCap(0, '0.5')).toBe(0.5);
    expect(resolveLiveSingleSymbolShortCap(-0.2, '0.5')).toBe(0.5);
    expect(resolveLiveSingleSymbolShortCap(Number.NaN, '0.5')).toBe(0.5);
    expect(resolveLiveSingleSymbolShortCap(Number.POSITIVE_INFINITY, '0.5')).toBe(0.5);
  });

  it('rejects non-numeric / non-positive env values and returns null when user is unset', () => {
    expect(resolveLiveSingleSymbolShortCap(undefined, '')).toBeNull();
    expect(resolveLiveSingleSymbolShortCap(undefined, 'oops')).toBeNull();
    expect(resolveLiveSingleSymbolShortCap(undefined, '0')).toBeNull();
    expect(resolveLiveSingleSymbolShortCap(undefined, '-0.3')).toBeNull();
    expect(resolveLiveSingleSymbolShortCap(undefined, 'NaN')).toBeNull();
  });

  it('passes the raw user value through without clamping (engine resolver clamps downstream)', () => {
    // Engine-side resolveSingleSymbolShortCap clamps to (0, 1] — the env-aware
    // helper must not pre-clamp because tests on the engine resolver exercise
    // that path independently. A 2.0 input arriving here should pass through;
    // the engine then clamps to PERP_SHORT_SINGLE_SYMBOL_CAP_MAX = 1.0.
    expect(resolveLiveSingleSymbolShortCap(2.0, undefined)).toBe(2.0);
    expect(resolveLiveSingleSymbolShortCap(undefined, '2.0')).toBe(2.0);
  });
});

// TRA-349 — regression-lock the (mode × dashboard) sub-account wiring shipped
// in TRA-346 for the crypto side. The CryptoSignalEngine owns two sub-accounts
// that translate user equity into actual order sizes:
//
//   * `account` (CryptoPaperAccount, demo paper) → (demo, crypto)
//   * `liveAccount` (CryptoLiveAccount, Coinbase live broker) → (live, crypto)
//
// These tests fail if either wire is rewired to read from the legacy
// un-suffixed `managedAccountRatio` / `riskPerTrade` field, the wrong
// dashboard, or the wrong mode. Distinct values across all four buckets +
// sentinel values on the legacy fields catch silent swaps.

interface CryptoPaperAccountInternals {
  managedAccountRatio: number;
  riskPerTrade: number;
}
interface CryptoLiveAccountInternals {
  managedAccountRatio: number;
  riskPerTrade: number;
}
interface CryptoSignalEngineInternals {
  account: CryptoPaperAccountInternals;
  liveAccount: CryptoLiveAccountInternals | null;
  buildLiveBroker: () => CryptoLiveAccountInternals | null;
  applySettings: (s: AccountSettings) => Promise<void>;
}

function fourBucketCryptoSettings(overrides: Partial<AccountSettings> = {}): AccountSettings {
  return {
    ...DEFAULT_ACCOUNT_SETTINGS,
    managedAccountRatioDemoStocks: 0.10,
    managedAccountRatioLiveStocks: 0.20,
    managedAccountRatioDemoCrypto: 0.30,
    managedAccountRatioLiveCrypto: 0.40,
    riskPerTradeDemoStocks: 0.001,
    riskPerTradeLiveStocks: 0.002,
    riskPerTradeDemoCrypto: 0.005,
    riskPerTradeLiveCrypto: 0.01,
    // Sentinel legacy values — if either sub-account reads from these the
    // assertion fails (no scoped bucket holds 0.99 / 0.49).
    managedAccountRatio: 0.99,
    riskPerTrade: 0.49,
    ...overrides,
  };
}

describe('CryptoSignalEngine — TRA-346 four-bucket sub-account wiring (TRA-349)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('applySettings always pins the demo paper account to (demo, crypto), regardless of settings.mode', async () => {
    // Headline TRA-346 invariant for crypto: Demo paper sizing must be
    // mode-locked to (demo, crypto) so a Live edit never bleeds into the
    // demo dashboard. Exercise both modes — the demo paper account ratio
    // must be 0.30 / 0.005 in both cases.
    const engine = new CryptoSignalEngine() as unknown as CryptoSignalEngineInternals;

    await engine.applySettings(fourBucketCryptoSettings({ mode: 'demo' }));
    expect(engine.account.managedAccountRatio).toBe(0.30);
    expect(engine.account.riskPerTrade).toBe(0.005);

    await engine.applySettings(fourBucketCryptoSettings({ mode: 'live' }));
    expect(engine.account.managedAccountRatio).toBe(0.30);
    expect(engine.account.riskPerTrade).toBe(0.005);
  });

  it('a Live-crypto edit does not bleed into the demo paper account', async () => {
    const engine = new CryptoSignalEngine() as unknown as CryptoSignalEngineInternals;
    await engine.applySettings(fourBucketCryptoSettings({ mode: 'demo' }));
    // User goes to Live tab and tightens risk on (live, crypto). The demo
    // paper account must keep its (demo, crypto) values untouched.
    await engine.applySettings(fourBucketCryptoSettings({
      mode: 'demo',
      managedAccountRatioLiveCrypto: 0.05,
      riskPerTradeLiveCrypto: 0.002,
    }));
    expect(engine.account.managedAccountRatio).toBe(0.30);
    expect(engine.account.riskPerTrade).toBe(0.005);
  });

  it('falls back to the legacy un-suffixed fields when (demo, crypto) is undefined', async () => {
    // Pre-TRA-346 saved snapshot — only managedAccountRatio / riskPerTrade
    // are set. The demo paper account must surface them via the resolver
    // fallback so existing users keep sizing the same way.
    const engine = new CryptoSignalEngine() as unknown as CryptoSignalEngineInternals;
    await engine.applySettings({
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      managedAccountRatio: 0.42,
      riskPerTrade: 0.013,
    });
    expect(engine.account.managedAccountRatio).toBe(0.42);
    expect(engine.account.riskPerTrade).toBe(0.013);
  });

  it('buildLiveBroker pins the Coinbase live account to (live, crypto), regardless of settings.mode', () => {
    // The live broker is by definition the live account; its sizing must
    // come from (live, crypto) even mid-save when settings.mode is still
    // 'demo'. Bypass tryInitLiveBroker (which fires HTTP) by calling
    // buildLiveBroker directly — same code path the live init runs through,
    // minus the network refresh.
    for (const mode of ['demo', 'live'] as const) {
      const engine = new CryptoSignalEngine(undefined, fourBucketCryptoSettings({
        mode,
        // HMAC-flavoured creds — the constructor accepts the raw strings as
        // an HMAC secret without making any network calls (no PEM parsing).
        liveApiKeyCrypto: 'test-key',
        liveApiSecretCrypto: 'test-secret',
      })) as unknown as CryptoSignalEngineInternals;
      const live = engine.buildLiveBroker();
      expect(live).not.toBeNull();
      expect(live!.managedAccountRatio).toBe(0.40);
      expect(live!.riskPerTrade).toBe(0.01);
    }
  });

  it('buildLiveBroker falls back to the legacy un-suffixed fields when (live, crypto) is undefined', () => {
    const engine = new CryptoSignalEngine(undefined, {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      managedAccountRatio: 0.33,
      riskPerTrade: 0.02,
      liveApiKeyCrypto: 'test-key',
      liveApiSecretCrypto: 'test-secret',
    }) as unknown as CryptoSignalEngineInternals;
    const live = engine.buildLiveBroker();
    expect(live).not.toBeNull();
    expect(live!.managedAccountRatio).toBe(0.33);
    expect(live!.riskPerTrade).toBe(0.02);
  });
});

// TRA-480 — parallel demo + live ticking. Before the fix the engine ran one
// branch per tick: `tick()` checked `this.mode` and either ran the demo
// paper-account branch OR the live broker branch, never both. That kept the
// "Crypto Demo idle (0 signals / 0 positions / $0 P&L)" report under TRA-479
// alive — once the user flipped to live the demo state froze until they
// switched back, and the candidate-strategy showcase the board cares about
// under TRA-434's live stand-down went dark. The board's documented
// expectation (TRA-456, default broadened to `legacy_5` in TRA-521) is that the
// demo dashboard runs its DEMO_STRATEGY_PRESET default deterministically
// regardless of `settings.mode`, so the parallel-tick fix
// extracts the demo path into `runDemoTick` and runs it unconditionally; the
// live branch keeps its mode + broker gate. The tests below pin three
// invariants:
//
//   (1) `runDemoTick` runs the demo paper account's `checkExits` against the
//       passed prices even while `this.mode === 'live'`, so a TP-hit
//       paper-position closes and lands on the demo history list.
//   (2) `resolvePreset('demo')` resolves to `crypto_core` (the TRA-696 demo
//       default) and `resolvePreset('live')` to the live-side preset (per-user
//       fallback with no env var set), independent of `this.mode`.
//   (3) `applyShortGates(signal, 'demo' | 'live')` reads the
//       open-shorts / closed-shorts feed from the matching branch's book, so
//       a demo cooldown can't suppress live shorts and vice versa.

interface CryptoSignalEnginePrivateTickInternals {
  mode: 'demo' | 'live';
  liveAccount: CryptoLiveAccount | null;
  account: CryptoPaperAccount;
  runDemoTick: (
    prices: Map<string, number>,
    activeSymbols: string[],
    quoteSources: Map<string, PositionQuoteSource>,
    staleSymbols: Set<string>,
  ) => Promise<void>;
  resolvePreset: (mode?: 'demo' | 'live') => StrategyPreset;
  applyShortGates: (signal: TradeSignal, mode?: 'demo' | 'live') => void;
  countOpenShorts: (mode?: 'demo' | 'live') => number;
  isAutoTradingEnabled: (mode?: 'demo' | 'live') => boolean;
}

describe('CryptoSignalEngine — TRA-480 parallel demo + live ticking', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('runs the demo paper-account branch (checkExits) even while mode=live', async () => {
    const engine = new CryptoSignalEngine();
    const internal = engine as unknown as CryptoSignalEnginePrivateTickInternals;

    // Seed the demo paper account with an open long position whose TP sits at
    // 65k. We open at the entry price (60k) so the position fills cleanly.
    const opened = internal.account.openPosition({
      id: 'demo-bb-1',
      symbol: 'BTC-USD',
      type: 'bb_fade',
      side: 'buy',
      entryPrice: 60_000,
      stopLoss: 59_000,
      takeProfit: 65_000,
      riskRewardRatio: 5,
      timestamp: Date.now(),
    }, 60_000);
    expect(opened).not.toBeNull();

    // Flip the engine to live AFTER seeding the demo position (so the open
    // position predates the live switch — exactly the TRA-479 reproduction).
    internal.mode = 'live';

    // Run the demo branch directly with a TP-trigger price. Pre-TRA-480 this
    // branch was unreachable from `doTick` while mode='live'; the very fact
    // that the method exists and can be invoked is the structural fix. We
    // verify it actually does work by checking that the paper account's
    // exit pipeline ran.
    const prices = new Map<string, number>([['BTC-USD', 70_000]]);
    const quoteSources = new Map<string, PositionQuoteSource>([['BTC-USD', 'coinbase']]);
    await internal.runDemoTick(prices, ['BTC-USD'], quoteSources, new Set<string>());

    // checkExits should have closed the long position via TP. The exact
    // exit price is `tp × (1 − slip)` per the TRA-342 cost model — we just
    // assert the position is closed and the demo history list picked it up.
    expect(internal.account.getState().openPositions).toHaveLength(0);
    const report = engine.getReportSnapshot('demo');
    expect(report.allClosedPositions).toHaveLength(1);
    expect(report.allClosedPositions[0]!.mode).toBe('demo');
    expect(report.allClosedPositions[0]!.symbol).toBe('BTC-USD');

    // Live state is untouched: no live broker initialised in this test, so
    // the live history list stays empty. This is the (1)-vs-(3) split the
    // fix is buying — demo state moves forward, live state stays inert.
    const liveReport = engine.getReportSnapshot('live');
    expect(liveReport.allClosedPositions).toHaveLength(0);
  });

  it('resolvePreset(mode) ignores this.mode — demo → crypto_core (default), live → per-user', () => {
    const engine = new CryptoSignalEngine();
    const internal = engine as unknown as CryptoSignalEnginePrivateTickInternals;

    // Force the engine into live mode. The demo branch's preset MUST still
    // resolve deterministically to `crypto_core` (DEMO_PRESET_DEFAULT since
    // TRA-696) even though `this.mode === 'live'` — that's the TRA-456 contract.
    internal.mode = 'live';
    expect(internal.resolvePreset('demo').id).toBe('crypto_core');

    // With no LIVE_STRATEGY_PRESET env set (default under test) the live
    // branch falls through to the per-user `activeStrategyPreset`, which
    // defaults to `legacy_5` (DEFAULT_STRATEGY_PRESET_ID, unchanged so the live
    // no_trade guard is unaffected) when no settings are bound.
    expect(internal.resolvePreset('live').id).toBe('legacy_5');

    // Sanity: same answers when this.mode='demo'. The branch's preset is a
    // function of the argument, not of the engine's current mode.
    internal.mode = 'demo';
    expect(internal.resolvePreset('demo').id).toBe('crypto_core');
    expect(internal.resolvePreset('live').id).toBe('legacy_5');
  });

  it('isAutoTradingEnabled(mode) reads the per-branch flag, not this.mode', () => {
    const engine = new CryptoSignalEngine();
    const internal = engine as unknown as CryptoSignalEnginePrivateTickInternals & {
      autoTradingEnabledDemo: boolean;
      autoTradingEnabledLive: boolean;
    };
    internal.mode = 'live';
    internal.autoTradingEnabledDemo = true;
    internal.autoTradingEnabledLive = false;

    // The demo branch must still be allowed to trade even when the user has
    // paused live trading (TRA-318 Stop Trading is a live-only switch).
    expect(internal.isAutoTradingEnabled('demo')).toBe(true);
    expect(internal.isAutoTradingEnabled('live')).toBe(false);
    // No-arg overload still surfaces the active mode's flag for legacy
    // callers (`buildState`, the public getter on the engine).
    expect(internal.isAutoTradingEnabled()).toBe(false);
  });

  it('countOpenShorts(mode) routes to the matching branch book', async () => {
    // The live broker is built lazily and we want both books to be live
    // sources of truth, not fall-throughs. We attach a real CryptoLiveAccount
    // with one open short and seed a demo short on the paper account — the
    // helper must return each book's own count when called with that branch's
    // mode, not the active engine mode.
    const engine = new CryptoSignalEngine();
    const internal = engine as unknown as CryptoSignalEnginePrivateTickInternals;

    // Seed a demo short on the paper account.
    internal.account.openPosition({
      id: 'demo-short-1',
      symbol: 'BTC-USD',
      type: 'momentum',
      side: 'sell',
      entryPrice: 60_000,
      stopLoss: 61_200,
      takeProfit: 56_000,
      riskRewardRatio: 3.3,
      timestamp: Date.now(),
    }, 60_000);

    // Build a live broker mirror with no open positions so `countOpenShorts('live')`
    // returns the live book's true zero (not a demo-book fall-through).
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      {
        uuid: 'usd', name: 'USD', currency: 'USD',
        available_balance: { value: '100000', currency: 'USD' },
        hold: { value: '0', currency: 'USD' },
      },
    ]);
    const liveAccount = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });
    await liveAccount.refreshBalance();
    internal.liveAccount = liveAccount;

    // Demo book: 1 open short. Live book: 0.
    expect(internal.countOpenShorts('demo')).toBe(1);
    expect(internal.countOpenShorts('live')).toBe(0);
  });
});

describe('mergeCandles — warm-cache eviction guard (TRA-593)', () => {
  const bar = (ts: number, close = 100): Candle => ({
    symbol: 'BTC-USD', timestamp: ts, open: close, high: close, low: close, close, volume: 1,
  });
  // Contiguous minute series ending at the given last-minute index.
  const series = (count: number, lastTs = count): Candle[] =>
    Array.from({ length: count }, (_, i) => bar(lastTs - (count - 1 - i)));

  it('returns the fresh series (capped) when there is no warm cache', () => {
    const fresh = series(100, 100);
    const out = mergeCandles(undefined, fresh, 80);
    expect(out).toHaveLength(80);
    expect(out[out.length - 1].timestamp).toBe(100);
  });

  it('a rate-limited partial fetch does NOT evict a warm cache below threshold', () => {
    // Warm: 80 contiguous bars [21..100]. Partial 429 fetch returns only the
    // last 17 bars [84..100]. Pre-fix this replaced the cache with 17 bars,
    // dropping below MIN_BARS_ROUTER(50)/MIN_BARS_BB_FADE(28) and silencing
    // the symbol. The merge must retain the warm history.
    const warm = series(80, 100);
    const partial = series(17, 100);
    const out = mergeCandles(warm, partial, 80);
    expect(out.length).toBeGreaterThanOrEqual(50); // still above the router floor
    expect(out).toHaveLength(80);
    expect(out[out.length - 1].timestamp).toBe(100);
  });

  it('advances the tail when the partial fetch carries newer bars', () => {
    const warm = series(80, 100);             // [21..100]
    const partial = [bar(101), bar(102)];     // two newer minutes
    const out = mergeCandles(warm, partial, 80);
    expect(out).toHaveLength(80);
    expect(out[out.length - 1].timestamp).toBe(102);
    expect(out[0].timestamp).toBe(23); // oldest two evicted to honour the cap
  });

  it('a healthy full fetch yields the same series as a plain replace (byte-identical path)', () => {
    const warm = series(80, 100);
    const full = series(80, 140); // fully newer, non-overlapping window
    const out = mergeCandles(warm, full, 80);
    expect(out).toEqual(full); // old history fully rolled off; identical to replace
  });

  it('fresh wins on an overlapping timestamp (finalised bar value)', () => {
    const warm = [bar(1, 100), bar(2, 100)];
    const fresh = [bar(2, 222), bar(3, 333)];
    const out = mergeCandles(warm, fresh, 80);
    expect(out.find(c => c.timestamp === 2)?.close).toBe(222);
    expect(out.map(c => c.timestamp)).toEqual([1, 2, 3]);
  });

  it('returns the cache unchanged when the fresh fetch is empty', () => {
    const warm = series(80, 100);
    expect(mergeCandles(warm, [], 80)).toBe(warm);
  });
});
