import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { CryptoSignalEngine } from './crypto-engine.js';
import { CryptoLiveAccount } from './crypto-live-account.js';

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
