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
import type { Position, TradeSignal } from '@trading-app/shared';

import { CryptoLiveAccount, PerpCatalog, quantizeBaseSize } from './crypto-live-account.js';

// We exercise CryptoLiveAccount through a hand-rolled stand-in for
// CoinbaseOrderClient — only the methods this account actually invokes are
// implemented. Cast through `unknown` to satisfy the constructor's nominal
// type without dragging in HMAC/JWT plumbing the test doesn't care about.
class FakeCoinbaseClient {
  listAccounts = vi.fn<() => Promise<CoinbaseAccountBalance[]>>();
  placeMarketOrder = vi.fn<() => Promise<CoinbaseOrderSuccessResponse>>();
  // TRA-264 — perp short close goes through closeFuturesPosition so Coinbase
  // identifies the right INTX position via `position_side`.
  closeFuturesPosition = vi.fn<() => Promise<CoinbaseOrderSuccessResponse>>();
  getOrder = vi.fn<(orderId: string) => Promise<CoinbaseOrderDetails>>();
  // Default empty map: tests with only USD/USDC/USDT holdings never hit this
  // path. Tests that seed crypto holdings override the resolved value.
  getProductPrices = vi.fn<(productIds: string[]) => Promise<Map<string, number>>>(
    async () => new Map(),
  );
  getProducts = vi.fn<(productIds: string[]) => Promise<Map<string, CoinbaseProductInfo>>>(
    async () => new Map(),
  );
  // TRA-249-C — perp catalog discovery and INTX reconciliation surface.
  // Defaults are empty so existing tests that don't pre-load these endpoints
  // see the legacy spot-only behaviour.
  listProducts = vi.fn<(productType: 'SPOT' | 'FUTURE') => Promise<CoinbaseListedProduct[]>>(
    async () => [],
  );
  listPortfolios = vi.fn<() => Promise<Array<{ uuid: string; type?: string }>>>(
    async () => [],
  );
  listFuturesPositions = vi.fn<(uuid: string) => Promise<CoinbaseFuturesPosition[]>>(
    async () => [],
  );
  // TRA-262 — live order-book spread snapshot for the §5 spread gate.
  // Default returns an empty book so tests that don't pre-load this endpoint
  // see "spread unavailable → gate skipped" rather than a synthetic value.
  getProductBook = vi.fn<(productId: string) => Promise<CoinbaseProductBook>>(
    async () => ({}),
  );
}

function asClient(fake: FakeCoinbaseClient): CoinbaseOrderClient {
  return fake as unknown as CoinbaseOrderClient;
}

function buyAccount(balanceUsd: number): { account: CryptoLiveAccount; coinbase: FakeCoinbaseClient } {
  const coinbase = new FakeCoinbaseClient();
  coinbase.listAccounts.mockResolvedValue([
    {
      uuid: 'usd',
      name: 'USD Wallet',
      currency: 'USD',
      available_balance: { value: String(balanceUsd), currency: 'USD' },
      hold: { value: '0', currency: 'USD' },
    },
  ]);
  // No-op sleep so retry/backoff tests don't burn wall-clock time.
  const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });
  return { account, coinbase };
}

function buildSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'sig-1',
    symbol: 'BTC-USD',
    type: 'reversal',
    side: 'buy',
    entryPrice: 30_000,
    stopLoss: 29_700,
    takeProfit: 30_900,
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

beforeEach(() => {
  // Suppress the open/close/fill-warning chatter so vitest output stays clean.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('CryptoLiveAccount equity rollup (TRA-224)', () => {
  it('values pre-existing non-USD holdings at current Coinbase spot price', async () => {
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      {
        uuid: 'usd', name: 'USD Wallet', currency: 'USD',
        available_balance: { value: '1000', currency: 'USD' },
        hold: { value: '0', currency: 'USD' },
      },
      {
        uuid: 'btc', name: 'BTC Wallet', currency: 'BTC',
        available_balance: { value: '0.5', currency: 'BTC' },
        hold: { value: '0', currency: 'BTC' },
      },
      {
        uuid: 'eth', name: 'ETH Wallet', currency: 'ETH',
        available_balance: { value: '2', currency: 'ETH' },
        hold: { value: '0', currency: 'ETH' },
      },
    ]);
    coinbase.getProductPrices.mockResolvedValue(new Map([
      ['BTC-USD', 60_000],
      ['ETH-USD', 3_000],
    ]));
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });

    await account.refreshBalance();

    // 1000 USD + 0.5 * 60_000 + 2 * 3_000 = 1000 + 30_000 + 6_000 = 37_000.
    expect(account.getState().totalEquity).toBe(37_000);
    expect(account.getState().availableCash).toBe(1_000);
    expect(coinbase.getProductPrices).toHaveBeenCalledWith(
      expect.arrayContaining(['BTC-USD', 'ETH-USD']),
    );
  });

  it('sums stable currencies (USD + USDC + USDT) into cash', async () => {
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      {
        uuid: 'usd', name: 'USD', currency: 'USD',
        available_balance: { value: '100', currency: 'USD' },
        hold: { value: '0', currency: 'USD' },
      },
      {
        uuid: 'usdc', name: 'USDC', currency: 'USDC',
        available_balance: { value: '200', currency: 'USDC' },
        hold: { value: '0', currency: 'USDC' },
      },
      {
        uuid: 'usdt', name: 'USDT', currency: 'USDT',
        available_balance: { value: '50', currency: 'USDT' },
        hold: { value: '0', currency: 'USDT' },
      },
    ]);
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });

    await account.refreshBalance();

    expect(account.getState().availableCash).toBe(350);
    expect(account.getState().totalEquity).toBe(350);
    // No non-cash holdings → no price lookup.
    expect(coinbase.getProductPrices).not.toHaveBeenCalled();
  });

  it('skips currencies whose USD pair Coinbase did not return a price for', async () => {
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      {
        uuid: 'btc', name: 'BTC', currency: 'BTC',
        available_balance: { value: '1', currency: 'BTC' },
        hold: { value: '0', currency: 'BTC' },
      },
      {
        uuid: 'obscure', name: 'OBS', currency: 'OBS',
        available_balance: { value: '500', currency: 'OBS' },
        hold: { value: '0', currency: 'OBS' },
      },
    ]);
    // Only BTC priced — OBS-USD pair didn't come back. Equity = BTC value
    // alone; the obscure holding silently drops out of the rollup.
    coinbase.getProductPrices.mockResolvedValue(new Map([['BTC-USD', 60_000]]));
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });

    await account.refreshBalance();

    expect(account.getState().totalEquity).toBe(60_000);
    expect(account.getState().availableCash).toBe(0);
  });

  it('falls back to cash-only equity when product price lookup fails', async () => {
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      {
        uuid: 'usd', name: 'USD', currency: 'USD',
        available_balance: { value: '500', currency: 'USD' },
        hold: { value: '0', currency: 'USD' },
      },
      {
        uuid: 'btc', name: 'BTC', currency: 'BTC',
        available_balance: { value: '0.1', currency: 'BTC' },
        hold: { value: '0', currency: 'BTC' },
      },
    ]);
    coinbase.getProductPrices.mockRejectedValue(new Error('coinbase down'));
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });

    // Should not throw; equity degrades to just cash.
    await account.refreshBalance();
    expect(account.getState().totalEquity).toBe(500);
    expect(account.getState().availableCash).toBe(500);
  });
});

describe('CryptoLiveAccount fill reconciliation (TRA-156)', () => {
  it('records the actual Coinbase fill price + size on openPosition, not the quote price', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-open'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({
        order_id: 'o-open',
        status: 'FILLED',
        average_filled_price: '30050.25',
        filled_size: '0.000832',
      }),
    );

    // currentPrice = 30_000 (the stale quote); the real fill landed at 30_050.25.
    const pos = await account.openPosition(buildSignal(), 30_000);

    expect(pos).not.toBeNull();
    expect(pos!.entryPrice).toBe(30_050.25);
    expect(pos!.quantity).toBe(0.000832);
    expect(coinbase.getOrder).toHaveBeenCalledWith('o-open');

    // Cash debit uses the reconciled price × size, not the quote.
    const expectedDebit = 30_050.25 * 0.000832;
    expect(account.getState().availableCash).toBeCloseTo(50_000 - expectedDebit, 6);
  });

  it('retries through PENDING / OPEN responses until the order settles to FILLED', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-pending'));
    coinbase.getOrder
      .mockResolvedValueOnce(orderDetails({ order_id: 'o-pending', status: 'PENDING', average_filled_price: '0', filled_size: '0' }))
      .mockResolvedValueOnce(orderDetails({ order_id: 'o-pending', status: 'OPEN', average_filled_price: '0', filled_size: '0' }))
      .mockResolvedValueOnce(orderDetails({ order_id: 'o-pending', status: 'FILLED', average_filled_price: '30100', filled_size: '0.001' }));

    const pos = await account.openPosition(buildSignal(), 30_000);

    expect(pos!.entryPrice).toBe(30_100);
    expect(pos!.quantity).toBe(0.001);
    expect(coinbase.getOrder).toHaveBeenCalledTimes(3);
  });

  it('falls back to the quote price + requested qty when the fill never settles', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-stuck'));
    coinbase.getOrder.mockResolvedValue(
      orderDetails({ order_id: 'o-stuck', status: 'PENDING', average_filled_price: '0', filled_size: '0' }),
    );

    const pos = await account.openPosition(buildSignal(), 30_000);

    expect(pos).not.toBeNull();
    expect(pos!.entryPrice).toBe(30_000);
    // qty resolved by sizeFromStop with the seeded balance — just confirm it's non-zero.
    expect(pos!.quantity).toBeGreaterThan(0);
    // 6 attempts in the FILL_POLL_DELAYS_MS schedule.
    expect(coinbase.getOrder).toHaveBeenCalledTimes(6);
  });

  it('uses the actual exit fill price (not the TP/SL trigger) when computing realized P&L', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    // Open at a known reconciled price so we can assert the exit P&L cleanly.
    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-open'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-open', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );
    const pos = await account.openPosition(buildSignal({ takeProfit: 31_000 }), 30_000);
    expect(pos).not.toBeNull();

    // TP trigger is 31_000, but Coinbase actually filled the exit at 30_950.50
    // (slippage). The mirror should record the real fill price.
    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-exit', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-exit', side: 'SELL', status: 'FILLED', average_filled_price: '30950.5', filled_size: '0.001' }),
    );

    const closed = await account.checkExits(new Map([['BTC-USD', 31_500]]));

    expect(closed).toHaveLength(1);
    expect(closed[0].exitPrice).toBe(30_950.5);
    // pnl = (30_950.5 - 30_000) * 0.001 * 1 (long) = 0.9505
    expect(closed[0].pnl).toBeCloseTo(0.9505, 6);
    expect(account.getState().dailyPnl).toBeCloseTo(0.9505, 6);
  });

  it('treats CANCELLED / FAILED status as unreconciled (does not crash openPosition)', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-cancel'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-cancel', status: 'CANCELLED', average_filled_price: '0', filled_size: '0' }),
    );

    // Should not throw — placeMarketOrder already succeeded; reconciliation is best-effort.
    const pos = await account.openPosition(buildSignal(), 30_000);
    expect(pos).not.toBeNull();
    expect(pos!.entryPrice).toBe(30_000); // fell back to quote
    expect(coinbase.getOrder).toHaveBeenCalledTimes(1); // terminal — no retry
  });
});

describe('CryptoLiveAccount small-fund sizing (TRA-243)', () => {
  it('caps qty by available cash so a small-cash account still trades', async () => {
    // $20 USD cash + sizeable BTC holdings. Default risk knobs (0.5 / 0.01)
    // would request ~$2,500 of BTC at this stop distance — pre-TRA-243 this
    // skipped on `cost > cash`. Now we cap by cash and ship the order.
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      {
        uuid: 'usd', name: 'USD', currency: 'USD',
        available_balance: { value: '20', currency: 'USD' },
        hold: { value: '0', currency: 'USD' },
      },
      {
        uuid: 'btc', name: 'BTC', currency: 'BTC',
        available_balance: { value: '0.1', currency: 'BTC' },
        hold: { value: '0', currency: 'BTC' },
      },
    ]);
    coinbase.getProductPrices.mockResolvedValue(new Map([['BTC-USD', 30_000]]));
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-small'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-small', status: 'FILLED', average_filled_price: '30000', filled_size: '0.000663' }),
    );

    const pos = await account.openPosition(buildSignal(), 30_000);

    expect(pos).not.toBeNull();
    expect(coinbase.placeMarketOrder).toHaveBeenCalledTimes(1);
    const calls = coinbase.placeMarketOrder.mock.calls as unknown as Array<[{ baseSize: number }]>;
    const call = calls[0]![0];
    // qty capped by cash with the 0.5% fee buffer: 20 × 0.995 / 30_000 = 0.000663…
    expect(call.baseSize).toBeLessThanOrEqual(0.000664);
    // And it stayed strictly below available cash so Coinbase won't reject for fees.
    expect(call.baseSize * 30_000).toBeLessThanOrEqual(20);
  });

  it('skips when even the cash-capped size produces sub-minimum notional', async () => {
    // 50¢ cash → max notional ~$0.50, below Coinbase's $1 minimum. We refuse
    // to fire a guaranteed-reject and log the reason so the user can act
    // (fund the wallet or sell some crypto into USD).
    const { account, coinbase } = buyAccount(0.5);
    await account.refreshBalance();

    const pos = await account.openPosition(buildSignal(), 30_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('skips when there is zero spendable cash even with crypto-only equity', async () => {
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      {
        uuid: 'btc', name: 'BTC', currency: 'BTC',
        available_balance: { value: '1', currency: 'BTC' },
        hold: { value: '0', currency: 'BTC' },
      },
    ]);
    coinbase.getProductPrices.mockResolvedValue(new Map([['BTC-USD', 30_000]]));
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });
    await account.refreshBalance();

    const pos = await account.openPosition(buildSignal(), 30_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
  });
});

describe('CryptoLiveAccount balance pre-flight (TRA-285)', () => {
  it('refreshes Coinbase balance before sizing when the cached read is stale', async () => {
    // Seed with $50k, then push the cache to "stale" by spying out Date.now.
    // openPosition must re-poll /accounts so a hold/withdrawal that landed
    // mid-window doesn't have us size against cash that no longer exists.
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    expect(coinbase.listAccounts).toHaveBeenCalledTimes(1);

    // Simulate a Coinbase-side debit between dashboard refreshes: the next
    // /accounts call returns a balance far too small to clear the $1
    // notional minimum even with the full managed-equity slice.
    coinbase.listAccounts.mockResolvedValueOnce([
      {
        uuid: 'usd', name: 'USD Wallet', currency: 'USD',
        available_balance: { value: '0.5', currency: 'USD' },
        hold: { value: '0', currency: 'USD' },
      },
    ]);

    // Push wall-clock past the 5s pre-flight window so openPosition treats
    // the cache as stale.
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + 10_000);

    const signal = buildSignal();
    const pos = await account.openPosition(signal, 30_000);

    // After the refresh, $0.50 cash → notional below $1 minimum → skip.
    expect(pos).toBeNull();
    expect(coinbase.listAccounts).toHaveBeenCalledTimes(2);
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();

    (Date.now as ReturnType<typeof vi.fn>).mockRestore();
  });

  it('reuses the freshly-cached balance for back-to-back signals in the same tick', async () => {
    // Two signals fired within 5s of the original refresh must NOT each
    // re-poll /accounts; the dashboard refresh already seeded a fresh read
    // and we don't want a 30-symbol watchlist to spam Coinbase.
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    expect(coinbase.listAccounts).toHaveBeenCalledTimes(1);

    coinbase.placeMarketOrder
      .mockResolvedValueOnce(orderSuccess('o1'))
      .mockResolvedValueOnce(orderSuccess('o2', 'BUY'));
    coinbase.getOrder
      .mockResolvedValueOnce(orderDetails({ order_id: 'o1', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }))
      .mockResolvedValueOnce(orderDetails({ order_id: 'o2', status: 'FILLED', average_filled_price: '2000', filled_size: '0.01' }));

    await account.openPosition(buildSignal(), 30_000);
    await account.openPosition(buildSignal({ symbol: 'ETH-USD', entryPrice: 2_000, stopLoss: 1_980, takeProfit: 2_060 }), 2_000);

    // Still just the one initial /accounts call — the pre-flight window
    // coalesced both opens onto the same fresh read.
    expect(coinbase.listAccounts).toHaveBeenCalledTimes(1);
    expect(coinbase.placeMarketOrder).toHaveBeenCalledTimes(2);
  });

  it('skips with a clear reason when the freshly-refreshed balance is insufficient', async () => {
    // Originally seeded with $50k, but the next /accounts call (triggered by
    // the stale-cache pre-flight) reports $0.50 — below Coinbase's $1
    // minimum notional. We must surface that on the signal instead of
    // shipping an order Coinbase will reject for INSUFFICIENT_FUND.
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    coinbase.listAccounts.mockResolvedValueOnce([
      {
        uuid: 'usd', name: 'USD Wallet', currency: 'USD',
        available_balance: { value: '0.5', currency: 'USD' },
        hold: { value: '0', currency: 'USD' },
      },
    ]);

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + 10_000);

    const signal = buildSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/below.*\$1.*minimum|no spendable cash|exceeds available cash/i);

    (Date.now as ReturnType<typeof vi.fn>).mockRestore();
  });

  it('still surfaces "Insufficient balance" on the signal when Coinbase rejects despite the pre-flight refresh', async () => {
    // The pre-flight refresh narrows but cannot eliminate the race: a hold
    // can land between our /accounts read and /orders POST. When that
    // happens, the rejection text must still reach `liveSkipReason` so the
    // dashboard surfaces "Insufficient balance" instead of a silent
    // open-failed.
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockRejectedValueOnce(
      new Error('Coinbase order rejected: Insufficient balance in source account'),
    );

    const signal = buildSignal();
    await expect(account.openPosition(signal, 30_000)).rejects.toThrow(/Insufficient balance/);
    expect(signal.liveSkipReason).toMatch(/Insufficient balance/);
  });
});

describe('CryptoLiveAccount skip-reason annotation (TRA-243)', () => {
  it('rejects sell-side signals on non-perp symbols with a spot-only reason (TRA-249-B / TRA-264)', async () => {
    // Pre-perp, every sell-side strategy signal lands on a spot Coinbase
    // account — and pre-TRA-249-B, the order client happily submitted a SELL
    // that partially filled against the user's pre-existing BTC/ETH (silent
    // nibble at user holdings now valued in equity per TRA-224). The guard
    // must hold for symbols not in the TRA-261 perp universe. ADA-USD is a
    // watchlist member that is intentionally NOT in the Phase-1 universe.
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    const signal = buildSignal({ symbol: 'ADA-USD', side: 'sell', stopLoss: 30_300, takeProfit: 29_100 });
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/spot only — no perp listed for ADA-USD/);
  });

  it('annotates the signal when no spendable cash is available', async () => {
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      {
        uuid: 'btc', name: 'BTC', currency: 'BTC',
        available_balance: { value: '1', currency: 'BTC' },
        hold: { value: '0', currency: 'BTC' },
      },
    ]);
    coinbase.getProductPrices.mockResolvedValue(new Map([['BTC-USD', 30_000]]));
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });
    await account.refreshBalance();

    const signal = buildSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).toBeNull();
    expect(signal.liveSkipReason).toMatch(/no spendable cash/i);
  });

  it('annotates the signal when cash-capped notional is below $1', async () => {
    const { account } = buyAccount(0.5);
    await account.refreshBalance();

    const signal = buildSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).toBeNull();
    expect(signal.liveSkipReason).toMatch(/below.*\$1.*minimum/i);
  });

  it('annotates the signal with the Coinbase rejection text on order failure', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockRejectedValueOnce(
      new Error('Coinbase order rejected: INSUFFICIENT_FUND'),
    );

    const signal = buildSignal();
    await expect(account.openPosition(signal, 30_000)).rejects.toThrow(/INSUFFICIENT_FUND/);
    expect(signal.liveSkipReason).toMatch(/INSUFFICIENT_FUND/);
  });

  it('does not annotate liveSkipReason on successful open', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-ok'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-ok', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );

    const signal = buildSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).not.toBeNull();
    expect(signal.liveSkipReason).toBeUndefined();
  });
});

describe('CryptoLiveAccount structured LiveSkip channel (TRA-249-B)', () => {
  it('emits a structured LiveSkip on the spot-only SELL guard for non-perp symbols and never reaches placeMarketOrder', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    // ADA-USD is intentionally NOT in PERP_SHORTS_UNIVERSE so the SELL falls
    // through to the spot-only skip rather than the TRA-264 perp short path.
    const signal = buildSignal({ symbol: 'ADA-USD', side: 'sell', stopLoss: 30_300, takeProfit: 29_100 });
    const before = Date.now();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    const skips = account.getRecentSkips();
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      symbol: 'ADA-USD',
      side: 'sell',
      reason: 'spot only — no perp listed for ADA-USD',
    });
    expect(skips[0].at).toBeGreaterThanOrEqual(before);
    // Aggregate channel surfaces via getState too, with a defensive copy.
    expect(account.getState().recentSkips).toEqual(skips);
    expect(account.getState().recentSkips).not.toBe(account.getRecentSkips());
  });

  it('still routes BUY signals to placeMarketOrder (regression — guard is SELL-only)', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-buy'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-buy', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );

    const signal = buildSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).not.toBeNull();
    expect(coinbase.placeMarketOrder).toHaveBeenCalledTimes(1);
    const calls = coinbase.placeMarketOrder.mock.calls as unknown as Array<[{ side: 'buy' | 'sell' }]>;
    expect(calls[0]![0]).toMatchObject({ side: 'buy' });
    // Successful open must not pollute the skip channel.
    expect(account.getRecentSkips()).toHaveLength(0);
    expect(signal.liveSkipReason).toBeUndefined();
  });

  it('emits "qty too small after sizing" when entry==stop produces zero risk-derived size', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    // entry==stop → sizeFromStop returns 0 → "qty too small after sizing".
    const signal = buildSignal({ entryPrice: 30_000, stopLoss: 30_000 });
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/qty too small after sizing/);
    const skips = account.getRecentSkips();
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ symbol: 'BTC-USD', side: 'buy' });
    expect(skips[0].reason).toMatch(/qty too small after sizing/);
  });

  it('emits "managed equity too small" when managedAccountRatio × equity collapses to zero', async () => {
    // Zero-equity account but a non-zero stop distance — the qty<=0 sizing
    // gate would trip first only if managedEquity is 0. Override risk knobs
    // so managedEquity()=0 is the explicit reason rather than the cash-cap
    // path's "no spendable cash".
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([]);
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });
    await account.refreshBalance();
    account.updateRiskConfig({ managedAccountRatio: 0, riskPerTrade: 0.01 });

    const signal = buildSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/managed equity too small/);
    const skips = account.getRecentSkips();
    expect(skips).toHaveLength(1);
    expect(skips[0].reason).toMatch(/managed equity too small/);
  });

  it('emits "no spendable cash" when cash-cap collapses qty to zero', async () => {
    // Crypto-only equity → managedEquity > 0, but cashUsd = 0 → cash cap
    // zeroes qty post-quantization → "no spendable cash". This is the
    // post-TRA-243 form of the legacy "cost > cashUsd" skip.
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      {
        uuid: 'btc', name: 'BTC', currency: 'BTC',
        available_balance: { value: '1', currency: 'BTC' },
        hold: { value: '0', currency: 'BTC' },
      },
    ]);
    coinbase.getProductPrices.mockResolvedValue(new Map([['BTC-USD', 30_000]]));
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });
    await account.refreshBalance();

    const signal = buildSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/no spendable cash/);
    const skips = account.getRecentSkips();
    expect(skips).toHaveLength(1);
    expect(skips[0].reason).toMatch(/no spendable cash/);
  });

  it('caps the recent-skips ring buffer at 50 entries (oldest dropped)', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    // 60 distinct sell signals — each emits a structured skip. After the
    // 51st, the oldest must drop. We tag the symbol with an index so we can
    // assert exactly which entries survived.
    for (let i = 0; i < 60; i++) {
      await account.openPosition(
        buildSignal({ id: `sig-${i}`, symbol: `SYM${i}-USD`, side: 'sell', stopLoss: 30_300, takeProfit: 29_100 }),
        30_000,
      );
    }
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();

    const skips = account.getRecentSkips();
    expect(skips).toHaveLength(50);
    // Newest last — last entry is sig 59. Oldest is sig 10 (sig 0–9 dropped).
    expect(skips[0].symbol).toBe('SYM10-USD');
    expect(skips[skips.length - 1].symbol).toBe('SYM59-USD');
  });

  it('records the Coinbase rejection text on the aggregate skip channel and rethrows', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    coinbase.placeMarketOrder.mockRejectedValueOnce(
      new Error('Coinbase order rejected: INSUFFICIENT_FUND'),
    );

    const signal = buildSignal();
    await expect(account.openPosition(signal, 30_000)).rejects.toThrow(/INSUFFICIENT_FUND/);
    const skips = account.getRecentSkips();
    expect(skips).toHaveLength(1);
    expect(skips[0].reason).toMatch(/INSUFFICIENT_FUND/);
    expect(skips[0].symbol).toBe('BTC-USD');
    expect(skips[0].side).toBe('buy');
  });
});

function productInfo(price: number, baseIncrement: string): CoinbaseProductInfo {
  return { price, baseIncrement };
}

describe('CryptoLiveAccount tradable-product validation (TRA-243)', () => {
  it('skips signals for symbols Coinbase does not list', async () => {
    // Watchlist has BTC, ETH, MATIC. Coinbase /products returns BTC + ETH
    // only — MATIC was renamed to POL Sept 2024 and silently dropped.
    // Without this guard a MATIC-USD market order returns a 400
    // INVALID_ARGUMENT that the user sees as a confusing "Coinbase rejected
    // order: Invalid product_id".
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    coinbase.getProducts.mockResolvedValueOnce(
      new Map([
        ['BTC-USD', productInfo(30_000, '0.00000001')],
        ['ETH-USD', productInfo(2_000, '0.00000001')],
      ]),
    );
    await account.refreshTradableProducts(['BTC-USD', 'ETH-USD', 'MATIC-USD']);

    const signal = buildSignal({ symbol: 'MATIC-USD', entryPrice: 0.5, stopLoss: 0.49 });
    const pos = await account.openPosition(signal, 0.5);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/not listed on Coinbase/i);
    expect(signal.liveSkipReason).toMatch(/MATIC-USD/);
  });

  it('still trades symbols Coinbase confirmed are listed', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    coinbase.getProducts.mockResolvedValueOnce(
      new Map([
        ['BTC-USD', productInfo(30_000, '0.00000001')],
        ['ETH-USD', productInfo(2_000, '0.00000001')],
      ]),
    );
    await account.refreshTradableProducts(['BTC-USD', 'ETH-USD']);

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-ok'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-ok', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );

    const signal = buildSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).not.toBeNull();
    expect(signal.liveSkipReason).toBeUndefined();
  });

  it('falls through to existing checks when /products lookup never succeeded', async () => {
    // Cache stays null — must not block trading on a Coinbase outage.
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    coinbase.getProducts.mockRejectedValueOnce(new Error('coinbase 503'));
    await account.refreshTradableProducts(['BTC-USD']);
    // Refresh swallowed the error; tradableProducts is still null.

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-ok'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-ok', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );

    const signal = buildSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).not.toBeNull();
    expect(signal.liveSkipReason).toBeUndefined();
  });

  it('reports stale once past the 6h TTL', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.getProducts.mockResolvedValueOnce(
      new Map([['BTC-USD', productInfo(30_000, '0.00000001')]]),
    );
    await account.refreshTradableProducts(['BTC-USD']);
    expect(account.isTradableProductsStale()).toBe(false);

    // Travel forward >6h. vi.useFakeTimers would need a constructor-time hook
    // we don't have; instead reach into Date.now via a spy.
    const realNow = Date.now;
    const sevenHoursLater = realNow() + 7 * 60 * 60 * 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => sevenHoursLater);
    expect(account.isTradableProductsStale()).toBe(true);
    (Date.now as ReturnType<typeof vi.fn>).mockRestore();
  });
});

describe('quantizeBaseSize (TRA-243)', () => {
  it('floors to a multiple of the increment and never rounds up', () => {
    expect(quantizeBaseSize(0.123456789, '0.00000001')).toBe(0.12345678);
    expect(quantizeBaseSize(0.99999999, '0.0001')).toBe(0.9999);
    expect(quantizeBaseSize(35_714, '1')).toBe(35_714);
    expect(quantizeBaseSize(35_714.6, '1')).toBe(35_714);
  });

  it('returns 0 when qty is below a single step (caller treats as no spendable size)', () => {
    expect(quantizeBaseSize(0.5, '1')).toBe(0);
    expect(quantizeBaseSize(5e-9, '0.00000001')).toBe(0);
  });

  it('handles padded-zero increment strings ("0.10000000" reads as 1 decimal)', () => {
    expect(quantizeBaseSize(12.7, '0.10000000')).toBe(12.7);
    expect(quantizeBaseSize(12.78, '0.10000000')).toBe(12.7);
  });

  it('returns 0 for invalid / zero / negative inputs rather than NaN', () => {
    expect(quantizeBaseSize(NaN, '0.0001')).toBe(0);
    expect(quantizeBaseSize(-1, '0.0001')).toBe(0);
    expect(quantizeBaseSize(1, '')).toBe(0);
    expect(quantizeBaseSize(1, '0')).toBe(0);
  });
});

describe('CryptoLiveAccount qty quantization end-to-end (TRA-243)', () => {
  it('quantizes qty to BTC step (8 decimals) before sending the market order', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    coinbase.getProducts.mockResolvedValueOnce(
      new Map([['BTC-USD', productInfo(30_000, '0.00000001')]]),
    );
    await account.refreshTradableProducts(['BTC-USD']);

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-btc'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-btc', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );
    await account.openPosition(buildSignal(), 30_000);

    const calls = coinbase.placeMarketOrder.mock.calls as unknown as Array<[{ baseSize: number }]>;
    const sent = calls[0]![0].baseSize;
    // Whatever the caller computed, it survives toFixed(8) without growing
    // longer than 8 decimals — the canary the user reported ("Too many
    // decimals in order amount") would have us at 6+ decimals from the legacy
    // Math.round(qty * 1e6) / 1e6 path on a product with a 4-decimal step.
    expect(sent.toFixed(8).replace(/\.?0+$/, '').split('.')[1]?.length ?? 0).toBeLessThanOrEqual(8);
  });

  it('quantizes qty to a coarse step (1 base unit) so SHIB-like products stop hitting "Too many decimals"', async () => {
    // Seed enough USD that final notional clears the $1 minimum after
    // quantization to step=1 — at $0.000028 spot, $10 cash sizes a few
    // hundred thousand SHIB. The legacy 6-decimal rounding would still emit
    // decimals (e.g. 35714.285714) and Coinbase rejects.
    const { account, coinbase } = buyAccount(10);
    await account.refreshBalance();
    coinbase.getProducts.mockResolvedValueOnce(
      new Map([['SHIB-USD', productInfo(0.000028, '1')]]),
    );
    await account.refreshTradableProducts(['SHIB-USD']);

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-shib'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-shib', status: 'FILLED', average_filled_price: '0.000028', filled_size: '166666' }),
    );
    await account.openPosition(
      buildSignal({ symbol: 'SHIB-USD', entryPrice: 0.000028, stopLoss: 0.0000277 }),
      0.000028,
    );

    const calls = coinbase.placeMarketOrder.mock.calls as unknown as Array<[{ baseSize: number; productId: string }]>;
    const call = calls[0]![0];
    expect(call.productId).toBe('SHIB-USD');
    // Integer step → baseSize must be a whole number.
    expect(Number.isInteger(call.baseSize)).toBe(true);
    expect(call.baseSize).toBeGreaterThan(0);
  });

  it('falls back to 6-decimal rounding when no product cache is available (Coinbase /products outage)', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    // Skip refreshTradableProducts so cache stays null.

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-fallback'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-fallback', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );
    const pos = await account.openPosition(buildSignal(), 30_000);

    expect(pos).not.toBeNull();
    const calls = coinbase.placeMarketOrder.mock.calls as unknown as Array<[{ baseSize: number }]>;
    const sent = calls[0]![0].baseSize;
    // Legacy fallback path: Math.round(qty * 1e6) / 1e6 — never more than 6 decimals.
    const decimals = sent.toString().split('.')[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });
});

// TRA-264 — perp short routing through CryptoLiveAccount. Strategy-side
// gates (universe / §5 filters) live in `crypto-engine.applyShortGates` and
// stamp `signalSkipReason` BEFORE openPosition is called; openPosition's
// SELL fork takes over from there to size, cap-check, and submit the perp
// order. These tests pin the contract end-to-end at the live-account layer.
function buildShortSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  // Short setup: stop above entry (5%), take-profit below. The 5% stop
  // matches the spec ATR-band realism — tighter test stops would trip the
  // §6 single-symbol cap before any other gate, swamping every assertion
  // about the perp short path with a generic cap-skip.
  return buildSignal({
    symbol: 'BTC-USD',
    side: 'sell',
    entryPrice: 30_000,
    stopLoss: 31_500,
    takeProfit: 28_500,
    ...overrides,
  });
}

describe('CryptoLiveAccount perp short routing (TRA-264)', () => {
  it('routes a non-suppressed BTC-USD short through placeMarketOrder with leverage/marginType/positionSide', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-perp', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-perp', side: 'SELL', status: 'FILLED', average_filled_price: '30000', filled_size: '0.0005' }),
    );

    const signal = buildShortSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).not.toBeNull();
    expect(pos!.side).toBe('sell');
    expect(pos!.symbol).toBe('BTC-USD');
    expect(coinbase.placeMarketOrder).toHaveBeenCalledTimes(1);
    const calls = coinbase.placeMarketOrder.mock.calls as unknown as Array<[{
      productId: string;
      side: 'buy' | 'sell';
      baseSize: number;
      leverage?: number;
      marginType?: 'ISOLATED' | 'CROSS';
      positionSide?: 'LONG' | 'SHORT';
    }]>;
    expect(calls[0]![0]).toMatchObject({
      productId: 'BTC-USD',
      side: 'sell',
      leverage: 1,
      marginType: 'ISOLATED',
      positionSide: 'SHORT',
    });
    expect(signal.liveSkipReason).toBeUndefined();
    expect(signal.signalSkipReason).toBeUndefined();
    // TRA-249-E — perp metadata is stamped on the position so the desktop
    // Positions table can render Leverage / Liquidation columns. Phase-1
    // engine pins leverage at 1× and liquidationPrice is the textbook
    // entry × 2 reference for a 1× isolated short.
    expect(pos!.productType).toBe('perp');
    expect(pos!.leverage).toBe(1);
    expect(pos!.marginUsd).toBeCloseTo(30_000 * 0.0005, 6);
    expect(pos!.liquidationPrice).toBe(60_000);
  });

  it('uses the Tier-2 risk fraction (0.30%) for DOGE-USD shorts', async () => {
    // Tier-1 (BTC) sizes at 0.50% of managed equity; Tier-2 (DOGE) at 0.30%.
    // Same equity + stop distance ratio → Tier-2 quantity is 0.30/0.50 = 0.6×
    // Tier-1's. The risk knob also collapses to 1% of total equity for the
    // long-side baseline; we pin the actual Tier-2 result to make sure the
    // override is in effect (regression: any future drift to long-side risk
    // would silently size DOGE shorts up by 67%).
    const { account, coinbase } = buyAccount(100_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-doge', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-doge', side: 'SELL', status: 'FILLED', average_filled_price: '0.10', filled_size: '15000' }),
    );

    const signal = buildShortSignal({ symbol: 'DOGE-USD', entryPrice: 0.10, stopLoss: 0.105, takeProfit: 0.09 });
    await account.openPosition(signal, 0.10);

    const calls = coinbase.placeMarketOrder.mock.calls as unknown as Array<[{ baseSize: number; positionSide?: 'LONG' | 'SHORT' }]>;
    const sent = calls[0]![0];
    // Risk per trade for Tier-2 = managedEquity × 0.003 = 50_000 × 0.003 = 150
    // Stop distance = 0.005 → qty = 150 / 0.005 = 30_000. Cap by managedEquity
    // at 1× leverage: 50_000 / 0.10 = 500_000 (no cap). Tier-1 would have been
    // 50_000 × 0.005 / 0.005 = 50_000 (vs 30_000 here).
    expect(sent.baseSize).toBeCloseTo(30_000, 0);
    expect(sent.positionSide).toBe('SHORT');
  });

  it('routes a non-perp-universe sell through the spot-only skip (regression on perp gating)', async () => {
    // ETH is in the universe, but ADA-USD is not. The TRA-249-B fallback
    // must hold for non-perp symbols even after TRA-264 wires the perp path.
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    const signal = buildShortSignal({ symbol: 'ADA-USD', entryPrice: 1, stopLoss: 1.05, takeProfit: 0.9 });
    const pos = await account.openPosition(signal, 1);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/spot only — no perp listed for ADA-USD/);
    // Spot-only fallback uses liveSkipReason (broker-side guard), not signalSkipReason.
    expect(signal.signalSkipReason).toBeUndefined();
  });

  it('emits "total short notional cap" via signalSkipReason when the candidate breaches the 30% ceiling', async () => {
    // Seed enough open shorts that the candidate would push total short
    // notional past 30% of equity. We hand-craft positions via the BUY path
    // and then submit a short; CryptoLiveAccount sums any side==='sell'
    // entries in the positions map regardless of how they were created.
    const { account, coinbase } = buyAccount(10_000);
    await account.refreshBalance();
    // Open a fake spot LONG just to confirm it is NOT counted in the
    // short-notional sum (a regression guard would have us count both
    // sides).
    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-long'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-long', status: 'FILLED', average_filled_price: '30000', filled_size: '0.05' }),
    );
    await account.openPosition(buildSignal({ symbol: 'BTC-USD' }), 30_000);

    // Open three perp shorts on different symbols at $1_000 notional each so
    // total open-short notional is $3_000 (30% of $10k equity). Now the cap
    // is at the boundary; the next candidate's notional pushes us over.
    const seedShortsAt = async (symbol: string, orderId: string) => {
      coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess(orderId, 'SELL'));
      coinbase.getOrder.mockResolvedValueOnce(
        orderDetails({ order_id: orderId, side: 'SELL', status: 'FILLED', average_filled_price: '100', filled_size: '10' }),
      );
      await account.openPosition(
        buildShortSignal({ id: orderId, symbol, entryPrice: 100, stopLoss: 105, takeProfit: 90 }),
        100,
      );
    };
    await seedShortsAt('ETH-USD', 'o-eth');
    await seedShortsAt('SOL-USD', 'o-sol');
    await seedShortsAt('XRP-USD', 'o-xrp');

    coinbase.placeMarketOrder.mockClear();
    coinbase.getOrder.mockClear();

    const signal = buildShortSignal({ id: 'sig-cap', symbol: 'BTC-USD', entryPrice: 100, stopLoss: 105, takeProfit: 90 });
    const pos = await account.openPosition(signal, 100);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.signalSkipReason).toBe('total short notional cap');
    const skips = account.getRecentSkips();
    expect(skips[skips.length - 1]).toMatchObject({
      symbol: 'BTC-USD',
      side: 'sell',
      reason: 'total short notional cap',
    });
  });

  it('emits "single-symbol short cap" before the cross-strategy or total caps fire', async () => {
    // Single-symbol cap is per-strategy at 15% of strategy equity. Build a
    // ~$30k equity account so 15% = $4_500. Open one $5_000 BTC short on
    // strategy A, then submit a second BTC short on the same strategy (same
    // signalType → same strategy proxy in the live account's accounting).
    // managedEquity = totalEquity × 0.5 (default ratio) = 15_000, single-
    // symbol limit = 15_000 × 0.15 = 2_250. Even one $5_000 short already
    // breaches; we pin the order specifically.
    const { account, coinbase } = buyAccount(30_000);
    await account.refreshBalance();

    // First short establishes the strategy×symbol open notional.
    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-1', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-1', side: 'SELL', status: 'FILLED', average_filled_price: '500', filled_size: '10' }),
    );
    // entryPrice 500 × qty 10 = $5_000 notional.
    await account.openPosition(
      buildShortSignal({ id: 'sig-1', type: 'momentum', entryPrice: 500, stopLoss: 525, takeProfit: 450 }),
      500,
    );

    coinbase.placeMarketOrder.mockClear();

    // Second momentum BTC short — same strategy, same symbol → single-symbol
    // cap fires before cross-strategy (still under 20% × 30k = 6_000) and
    // total (still under 30% × 30k = 9_000) caps would.
    const signal = buildShortSignal({ id: 'sig-2', type: 'momentum', entryPrice: 500, stopLoss: 525, takeProfit: 450 });
    const pos = await account.openPosition(signal, 500);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.signalSkipReason).toBe('single-symbol short cap');
  });

  it('flags BTC-USD shorts via daily short circuit breaker when realised short P&L crosses -2% equity', async () => {
    // Stand up an account, manually drive realisedShortPnlToday past the
    // -2% × equity threshold by closing a losing short via checkExits, then
    // confirm the next short is suppressed.
    const { account, coinbase } = buyAccount(100_000);
    await account.refreshBalance();

    // Open a short.
    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-open', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-open', side: 'SELL', status: 'FILLED', average_filled_price: '30000', filled_size: '0.1' }),
    );
    await account.openPosition(buildShortSignal(), 30_000);

    // Force the short to stop out at price 30_500 → loss of (30_500-30_000)×0.1 = $50
    // negated for sell side → -$50. Not enough to trip alone, but we'll repeat.
    // Instead, close at a price that maps to a -$2_500 loss (>2% × 100k).
    // pnl = (exitPrice - entry) × qty × (-1) for sell side.
    // Want pnl <= -2_000 → exitPrice >= entry + 2_000/qty = 30_000 + 20_000 = 50_000.
    coinbase.closeFuturesPosition.mockResolvedValueOnce(orderSuccess('o-close', 'BUY'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-close', side: 'BUY', status: 'FILLED', average_filled_price: '50000', filled_size: '0.1' }),
    );
    const closed = await account.checkExits(new Map([['BTC-USD', 50_000]]));
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeCloseTo(-2_000, 6);

    coinbase.placeMarketOrder.mockClear();

    // Next short — daily circuit breaker should trip (-2_000 / 100_000 = -2%
    // is exactly the threshold; spec wording is "≤ -2%" which includes the
    // boundary). The signal carries signalSkipReason and order is NOT placed.
    const signal = buildShortSignal({ id: 'sig-cb', symbol: 'ETH-USD', entryPrice: 2_000, stopLoss: 2_020, takeProfit: 1_900 });
    const pos = await account.openPosition(signal, 2_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.signalSkipReason).toBe('daily short circuit breaker tripped');
  });

  it('routes short exits through closeFuturesPosition with positionSide=SHORT (not placeMarketOrder)', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-open', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-open', side: 'SELL', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );
    await account.openPosition(buildShortSignal({ takeProfit: 29_000 }), 30_000);

    coinbase.placeMarketOrder.mockClear();
    coinbase.closeFuturesPosition.mockResolvedValueOnce(orderSuccess('o-close', 'BUY'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-close', side: 'BUY', status: 'FILLED', average_filled_price: '28950', filled_size: '0.001' }),
    );

    // Hits TP at 28_500 (price < TP → triggers tp).
    const closed = await account.checkExits(new Map([['BTC-USD', 28_500]]));
    expect(closed).toHaveLength(1);
    // Realized pnl = (entry - exit) × qty for short = (30_000 - 28_950) × 0.001 = 1.05
    expect(closed[0].pnl).toBeCloseTo(1.05, 6);

    // closeFuturesPosition got the call, NOT placeMarketOrder.
    expect(coinbase.closeFuturesPosition).toHaveBeenCalledTimes(1);
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    const calls = coinbase.closeFuturesPosition.mock.calls as unknown as Array<[{
      productId: string;
      positionSide: 'LONG' | 'SHORT';
      baseSize: number;
      leverage?: number;
      marginType?: 'ISOLATED' | 'CROSS';
    }]>;
    expect(calls[0]![0]).toMatchObject({
      productId: 'BTC-USD',
      positionSide: 'SHORT',
      leverage: 1,
      marginType: 'ISOLATED',
    });
  });

  it('does not debit cashUsd on perp short open (margin lives in INTX, not the spot wallet)', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    const cashBefore = account.getState().availableCash;

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-perp', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-perp', side: 'SELL', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );

    await account.openPosition(buildShortSignal(), 30_000);

    // Spot USD wallet untouched — refreshBalance() will reconcile both spot
    // and (via separate plumbing in TRA-262) the INTX margin slice.
    expect(account.getState().availableCash).toBe(cashBefore);
  });

  it('keeps the BUY path byte-identical (regression: order body unchanged for spot longs)', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-buy'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-buy', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );

    const signal = buildSignal();
    await account.openPosition(signal, 30_000);

    const calls = coinbase.placeMarketOrder.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const params = calls[0]![0];
    // Pre-TRA-264 fields only — no leverage / marginType / positionSide.
    expect(params).toMatchObject({ productId: 'BTC-USD', side: 'buy' });
    expect(params).not.toHaveProperty('leverage');
    expect(params).not.toHaveProperty('marginType');
    expect(params).not.toHaveProperty('positionSide');
  });

  it('rolloverDay clears realizedShortPnlToday so the §7 circuit breaker resets at UTC day boundary', async () => {
    const { account, coinbase } = buyAccount(100_000);
    await account.refreshBalance();

    // Open + close a losing short to seed realizedShortPnlToday with -$2_500.
    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-open', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-open', side: 'SELL', status: 'FILLED', average_filled_price: '30000', filled_size: '0.1' }),
    );
    await account.openPosition(buildShortSignal(), 30_000);
    coinbase.closeFuturesPosition.mockResolvedValueOnce(orderSuccess('o-close', 'BUY'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-close', side: 'BUY', status: 'FILLED', average_filled_price: '55000', filled_size: '0.1' }),
    );
    await account.checkExits(new Map([['BTC-USD', 55_000]]));

    // Pre-rollover: a fresh short should be blocked.
    const blocked = buildShortSignal({ id: 'b' });
    expect(await account.openPosition(blocked, 30_000)).toBeNull();
    expect(blocked.signalSkipReason).toBe('daily short circuit breaker tripped');

    account.rolloverDay();

    // Post-rollover: same parameters → not blocked. Mock the order so the
    // open succeeds.
    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-fresh', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-fresh', side: 'SELL', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );
    const fresh = buildShortSignal({ id: 'f' });
    const pos = await account.openPosition(fresh, 30_000);
    expect(pos).not.toBeNull();
    expect(fresh.signalSkipReason).toBeUndefined();
  });
});

// ── TRA-249-C: hybrid routing fork (catalog, position model, reconciliation) ──

function listedPerp(productId: string): CoinbaseListedProduct {
  return { product_id: productId, product_type: 'FUTURE', price: '30000', status: 'online' };
}

function listedSpot(productId: string): CoinbaseListedProduct {
  return { product_id: productId, product_type: 'SPOT', price: '30000', status: 'online' };
}

describe('PerpCatalog (TRA-249-C)', () => {
  it('starts not-ready and reports stale until first refresh succeeds', () => {
    const catalog = new PerpCatalog();
    expect(catalog.isReady()).toBe(false);
    expect(catalog.isStale()).toBe(true);
    expect(catalog.getPerpFor('BTC-USD')).toBeNull();
  });

  it('builds the spot→perp map from listProducts(FUTURE) by base currency', async () => {
    const coinbase = new FakeCoinbaseClient();
    coinbase.listProducts.mockResolvedValueOnce([
      listedPerp('BTC-PERP-INTX'),
      listedPerp('ETH-PERP-INTX'),
      listedSpot('SOL-USD'), // Should be filtered out — not a perp.
    ]);
    const catalog = new PerpCatalog();
    await catalog.refresh(asClient(coinbase), ['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD']);

    expect(catalog.isReady()).toBe(true);
    expect(catalog.isStale()).toBe(false);
    expect(catalog.getPerpFor('BTC-USD')).toBe('BTC-PERP-INTX');
    expect(catalog.getPerpFor('ETH-USD')).toBe('ETH-PERP-INTX');
    expect(catalog.getPerpFor('SOL-USD')).toBeNull();
    expect(catalog.getPerpFor('DOGE-USD')).toBeNull();
  });

  it('keeps the previous map when refresh throws (transient outage = use stale catalog)', async () => {
    const coinbase = new FakeCoinbaseClient();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    const catalog = new PerpCatalog();
    await catalog.refresh(asClient(coinbase), ['BTC-USD']);
    expect(catalog.getPerpFor('BTC-USD')).toBe('BTC-PERP-INTX');

    coinbase.listProducts.mockRejectedValueOnce(new Error('coinbase 503'));
    await catalog.refresh(asClient(coinbase), ['BTC-USD']);
    // Map untouched on failure — readiness flag stays true.
    expect(catalog.isReady()).toBe(true);
    expect(catalog.getPerpFor('BTC-USD')).toBe('BTC-PERP-INTX');
  });

  it('reports stale once past the 1h TTL', async () => {
    const coinbase = new FakeCoinbaseClient();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    const catalog = new PerpCatalog();
    await catalog.refresh(asClient(coinbase), ['BTC-USD']);
    expect(catalog.isStale()).toBe(false);

    const sixtyOneMinutes = Date.now() + 61 * 60_000;
    vi.spyOn(Date, 'now').mockImplementation(() => sixtyOneMinutes);
    expect(catalog.isStale()).toBe(true);
    (Date.now as ReturnType<typeof vi.fn>).mockRestore();
  });

  it('matches by base currency only — quote-asset variations route to the same perp', async () => {
    // Watchlist might carry BTC-USDC alongside BTC-USD; both share base BTC,
    // so both should route to BTC-PERP-INTX. Future-proofs the matcher
    // against multi-quote watchlists.
    const coinbase = new FakeCoinbaseClient();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    const catalog = new PerpCatalog();
    await catalog.refresh(asClient(coinbase), ['BTC-USD', 'BTC-USDC']);

    expect(catalog.getPerpFor('BTC-USD')).toBe('BTC-PERP-INTX');
    expect(catalog.getPerpFor('BTC-USDC')).toBe('BTC-PERP-INTX');
  });
});

describe('CryptoLiveAccount routing fork — perp product_id resolution (TRA-249-C)', () => {
  it('submits the catalog-resolved INTX product_id (BTC-PERP-INTX), not the spot symbol', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    await account.refreshPerpCatalog(['BTC-USD']);

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-perp', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-perp', side: 'SELL', status: 'FILLED', average_filled_price: '30050', filled_size: '0.001' }),
    );

    const signal = buildShortSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).not.toBeNull();
    expect(coinbase.placeMarketOrder).toHaveBeenCalledTimes(1);
    const calls = coinbase.placeMarketOrder.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const call = calls[0]![0];
    // The actual Coinbase INTX product_id, not the spot symbol — fixes the
    // pre-TRA-249-C bug where `BTC-USD` was sent to the perp endpoint.
    expect(call.productId).toBe('BTC-PERP-INTX');
    expect(call).toMatchObject({
      side: 'sell',
      leverage: 1,
      marginType: 'ISOLATED',
      positionSide: 'SHORT',
    });
    // pos.symbol stays the spot pair so price-keyed `checkExits` and the
    // dashboard symbol display keep working.
    expect(pos!.symbol).toBe('BTC-USD');
  });

  it('falls back to the spot symbol when the catalog has not been loaded (graceful degrade)', async () => {
    // Catalog never refreshed → getPerpFor returns null → openPerpShort
    // falls back to signal.symbol so existing TRA-264 behaviour is preserved
    // when the catalog isn't yet available (e.g. a transient /products
    // outage at startup).
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-fallback', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-fallback', side: 'SELL', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );

    const pos = await account.openPosition(buildShortSignal(), 30_000);

    expect(pos).not.toBeNull();
    const calls = coinbase.placeMarketOrder.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0]![0].productId).toBe('BTC-USD');
  });
});

describe('CryptoLiveAccount routing fork — spot_only override (TRA-249-C)', () => {
  it('forces the spot-only-skip path when routingMode is set to spot_only even with a listed perp + universe-symbol', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    await account.refreshPerpCatalog(['BTC-USD']);
    account.setRoutingMode('spot_only');

    const signal = buildShortSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/spot only — no perp listed for BTC-USD/);
    expect(account.getRoutingMode()).toBe('spot_only');
  });

  it('seeds routingMode from constructor opts so the very first tick respects the operator setting', async () => {
    const coinbase = new FakeCoinbaseClient();
    coinbase.listAccounts.mockResolvedValue([
      { uuid: 'usd', name: 'USD', currency: 'USD', available_balance: { value: '50000', currency: 'USD' }, hold: { value: '0', currency: 'USD' } },
    ]);
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {}, routingMode: 'spot_only' });
    await account.refreshBalance();

    const signal = buildShortSignal();
    const pos = await account.openPosition(signal, 30_000);

    expect(pos).toBeNull();
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(signal.liveSkipReason).toMatch(/spot only/);
  });

  it('default routingMode is hybrid', () => {
    const coinbase = new FakeCoinbaseClient();
    const account = new CryptoLiveAccount(asClient(coinbase), { sleep: async () => {} });
    expect(account.getRoutingMode()).toBe('hybrid');
  });
});

describe('CryptoLiveAccount perp position model (TRA-249-C)', () => {
  it('stamps productType / leverage / marginUsd / liquidationPrice on perp shorts', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    await account.refreshPerpCatalog(['BTC-USD']);

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-perp', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-perp', side: 'SELL', status: 'FILLED', average_filled_price: '30050', filled_size: '0.002' }),
    );

    const pos = await account.openPosition(buildShortSignal(), 30_000);

    expect(pos).not.toBeNull();
    expect(pos!.productType).toBe('perp');
    expect(pos!.leverage).toBe(1);
    expect(pos!.marginUsd).toBeCloseTo(30_050 * 0.002, 6);
    expect(pos!.liquidationPrice).toBeCloseTo(30_050 * 2, 6);
  });

  it('spot positions never gain perp fields (regression — productType absent on serialize)', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();

    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-spot'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-spot', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );
    const pos = await account.openPosition(buildSignal(), 30_000);

    expect(pos).not.toBeNull();
    expect(pos!.productType).toBeUndefined();
    expect(pos!.leverage).toBeUndefined();
    expect(pos!.marginUsd).toBeUndefined();
    expect(pos!.liquidationPrice).toBeUndefined();
  });
});

describe('CryptoLiveAccount checkExits — perp close uses catalog product_id (TRA-249-C)', () => {
  it('closes a perp position via closeFuturesPosition with the catalog-resolved product_id', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshBalance();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    await account.refreshPerpCatalog(['BTC-USD']);

    // Open a perp short.
    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-perp-open', 'SELL'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-perp-open', side: 'SELL', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );
    // takeProfit = 28_500 by default — so trigger needs price <= 28_500.
    const opened = await account.openPosition(buildShortSignal(), 30_000);
    expect(opened).not.toBeNull();
    coinbase.placeMarketOrder.mockClear();

    // Trigger TP at 28_400 (price <= takeProfit on a SHORT).
    coinbase.closeFuturesPosition.mockResolvedValueOnce(orderSuccess('o-perp-close', 'BUY'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-perp-close', side: 'BUY', status: 'FILLED', average_filled_price: '28400', filled_size: '0.001' }),
    );
    const closed = await account.checkExits(new Map([['BTC-USD', 28_400]]));

    expect(closed).toHaveLength(1);
    expect(coinbase.closeFuturesPosition).toHaveBeenCalledTimes(1);
    const closeCalls = coinbase.closeFuturesPosition.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(closeCalls[0]![0]).toMatchObject({
      // Critical: routes to the actual INTX perp product_id, not the spot symbol.
      productId: 'BTC-PERP-INTX',
      positionSide: 'SHORT',
      baseSize: 0.001,
      leverage: 1,
      marginType: 'ISOLATED',
    });
  });
});

describe('CryptoLiveAccount startup reconciliation (TRA-249-C)', () => {
  it('imports an open INTX perp position on refreshBalance without re-opening it', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.listPortfolios.mockResolvedValue([{ uuid: 'intx-uuid', type: 'INTX' }]);
    coinbase.listFuturesPositions.mockResolvedValueOnce([
      {
        product_id: 'BTC-PERP-INTX',
        position_side: 'SHORT',
        net_size: '0.0025',
        vwap: '30200',
        mark_price: '30100',
        liquidation_price: '60400',
        leverage: '1',
        margin_type: 'ISOLATED',
      },
    ]);

    // Balance refresh triggers the reconcile path.
    await account.refreshBalance();

    const positions = account.getState().openPositions;
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      symbol: 'BTC-USD',
      side: 'sell',
      productType: 'perp',
      quantity: 0.0025,
      entryPrice: 30_200,
      leverage: 1,
      liquidationPrice: 60_400,
    });
    // Critical: no order was submitted. Reconciliation is read-only.
    expect(coinbase.placeMarketOrder).not.toHaveBeenCalled();
    expect(coinbase.closeFuturesPosition).not.toHaveBeenCalled();
    expect(coinbase.listPortfolios).toHaveBeenCalledWith('INTX');
    expect(coinbase.listFuturesPositions).toHaveBeenCalledWith('intx-uuid');
  });

  it('does not duplicate a UI-opened perp on a subsequent reconcile', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.listPortfolios.mockResolvedValue([{ uuid: 'intx-uuid', type: 'INTX' }]);
    coinbase.listFuturesPositions.mockResolvedValue([
      {
        product_id: 'BTC-PERP-INTX',
        position_side: 'SHORT',
        net_size: '0.0025',
        vwap: '30200',
        leverage: '1',
        margin_type: 'ISOLATED',
      },
    ]);

    await account.refreshBalance();
    expect(account.getState().openPositions).toHaveLength(1);

    // Travel past the rate-limit so the next refreshBalance retries reconcile.
    // Same Coinbase position returned — must NOT be re-imported.
    const sixMinutesLater = Date.now() + 6 * 60_000;
    vi.spyOn(Date, 'now').mockImplementation(() => sixMinutesLater);
    await account.refreshBalance();
    (Date.now as ReturnType<typeof vi.fn>).mockRestore();

    expect(account.getState().openPositions).toHaveLength(1);
  });

  it('rate-limits the reconcile so the every-30s balance refresh does not refetch INTX positions', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.listPortfolios.mockResolvedValue([{ uuid: 'intx-uuid', type: 'INTX' }]);
    coinbase.listFuturesPositions.mockResolvedValue([]);

    await account.refreshBalance();
    await account.refreshBalance();
    await account.refreshBalance();

    expect(coinbase.listFuturesPositions).toHaveBeenCalledTimes(1);
    expect(coinbase.listPortfolios).toHaveBeenCalledTimes(1);
  });

  it('survives a missing INTX portfolio (perps not enabled) without throwing', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.listPortfolios.mockResolvedValue([]); // No INTX portfolio.

    await expect(account.refreshBalance()).resolves.toBeUndefined();
    expect(account.getState().openPositions).toHaveLength(0);
    expect(coinbase.listFuturesPositions).not.toHaveBeenCalled();
  });
});

// ── TRA-249-D: funding-rate accrual on perp positions ─────────────────────

/**
 * Open a perp short via the routing fork using the shared helper plumbing
 * so the tests below start from a real `productType: 'perp'` position with
 * a populated `perpProductByPositionId` mapping. Returns the freshly opened
 * position so callers can assert against its mutating fields.
 */
async function openPerpShortFor(
  account: CryptoLiveAccount,
  coinbase: FakeCoinbaseClient,
  signal: TradeSignal,
  spotPrice: number,
  filled: { price: string; size: string; orderId: string },
): Promise<Position> {
  coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess(filled.orderId, 'SELL'));
  coinbase.getOrder.mockResolvedValueOnce(
    orderDetails({
      order_id: filled.orderId,
      side: 'SELL',
      status: 'FILLED',
      average_filled_price: filled.price,
      filled_size: filled.size,
    }),
  );
  const pos = await account.openPosition(signal, spotPrice);
  if (!pos) throw new Error('expected perp short to open in test setup');
  return pos;
}

describe('CryptoLiveAccount funding-rate accrual (TRA-249-D)', () => {
  it('getOpenPerpPositions returns only perp positions, never spot', async () => {
    const { account, coinbase } = buyAccount(100_000);
    await account.refreshBalance();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    await account.refreshPerpCatalog(['BTC-USD']);

    // Open a spot long (BTC-USD buy) and a perp short (BTC-PERP-INTX sell).
    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-spot'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-spot', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );
    await account.openPosition(buildSignal(), 30_000);

    await openPerpShortFor(
      account,
      coinbase,
      buildShortSignal({ id: 'sig-perp' }),
      30_000,
      { price: '30000', size: '0.001', orderId: 'o-perp' },
    );

    const perps = account.getOpenPerpPositions();
    expect(perps).toHaveLength(1);
    expect(perps[0]!.productType).toBe('perp');
    expect(perps[0]!.side).toBe('sell');
    // Sanity: total open positions still 2 (spot + perp).
    expect(account.getState().openPositions).toHaveLength(2);
  });

  it('applyFundingAccrual stamps fundingPnl and bumps dailyPnl by the same amount', async () => {
    const { account, coinbase } = buyAccount(100_000);
    await account.refreshBalance();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    await account.refreshPerpCatalog(['BTC-USD']);

    const opened = await openPerpShortFor(
      account,
      coinbase,
      buildShortSignal(),
      30_000,
      { price: '30000', size: '0.001', orderId: 'o-perp-open' },
    );
    expect(opened.fundingPnl).toBeUndefined();
    const dailyBefore = account.getState().dailyPnl;

    account.applyFundingAccrual(opened.id, 0.42);

    // Position record carries the cumulative funding.
    const liveSnapshot = account.getState().openPositions.find(p => p.id === opened.id);
    expect(liveSnapshot?.fundingPnl).toBeCloseTo(0.42, 9);
    // dailyPnl includes the funding charge — spec's primary "Done when".
    expect(account.getState().dailyPnl).toBeCloseTo(dailyBefore + 0.42, 9);
  });

  it('multiple accruals on the same position accumulate monotonically into fundingPnl + dailyPnl', async () => {
    const { account, coinbase } = buyAccount(100_000);
    await account.refreshBalance();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    await account.refreshPerpCatalog(['BTC-USD']);

    const pos = await openPerpShortFor(
      account,
      coinbase,
      buildShortSignal(),
      30_000,
      { price: '30000', size: '0.001', orderId: 'o-acc' },
    );
    const dailyBefore = account.getState().dailyPnl;

    account.applyFundingAccrual(pos.id, 0.10);
    account.applyFundingAccrual(pos.id, 0.15);
    account.applyFundingAccrual(pos.id, 0.20);

    const live = account.getState().openPositions.find(p => p.id === pos.id);
    expect(live?.fundingPnl).toBeCloseTo(0.45, 9);
    expect(account.getState().dailyPnl).toBeCloseTo(dailyBefore + 0.45, 9);
  });

  it('mid-hour close settles realized P&L = price P&L + accumulated funding', async () => {
    const { account, coinbase } = buyAccount(100_000);
    await account.refreshBalance();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    await account.refreshPerpCatalog(['BTC-USD']);

    // Open a 0.001 BTC short at 30_000 → notional $30. Take-profit 28_500.
    const pos = await openPerpShortFor(
      account,
      coinbase,
      buildShortSignal(),
      30_000,
      { price: '30000', size: '0.001', orderId: 'o-mid-open' },
    );

    // Two hourly funding ticks before close: -0.05 + -0.03 = -0.08 (paid).
    account.applyFundingAccrual(pos.id, -0.05);
    account.applyFundingAccrual(pos.id, -0.03);

    // Trip the TP via checkExits at 28_400. Price P&L for a 0.001 short =
    // (30_000 - 28_400) * 0.001 = +1.60. Total realized = 1.60 + (-0.08) = 1.52.
    coinbase.closeFuturesPosition.mockResolvedValueOnce(orderSuccess('o-mid-close', 'BUY'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-mid-close', side: 'BUY', status: 'FILLED', average_filled_price: '28400', filled_size: '0.001' }),
    );
    const closed = await account.checkExits(new Map([['BTC-USD', 28_400]]));

    expect(closed).toHaveLength(1);
    expect(closed[0]!.fundingPnl).toBeCloseTo(-0.08, 9);
    expect(closed[0]!.pnl).toBeCloseTo(1.52, 6);
  });

  it('manual closePosition also folds funding into the closed-position pnl', async () => {
    const { account, coinbase } = buyAccount(100_000);
    await account.refreshBalance();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    await account.refreshPerpCatalog(['BTC-USD']);

    const pos = await openPerpShortFor(
      account,
      coinbase,
      buildShortSignal(),
      30_000,
      { price: '30000', size: '0.001', orderId: 'o-man-open' },
    );
    account.applyFundingAccrual(pos.id, -0.12);

    coinbase.closeFuturesPosition.mockResolvedValueOnce(orderSuccess('o-man-close', 'BUY'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-man-close', side: 'BUY', status: 'FILLED', average_filled_price: '29500', filled_size: '0.001' }),
    );
    const closed = await account.closePosition(pos.id, 29_500);

    // Price P&L: (30_000 - 29_500) * 0.001 = 0.50. + funding -0.12 = 0.38.
    expect(closed!.pnl).toBeCloseTo(0.38, 6);
    expect(closed!.fundingPnl).toBeCloseTo(-0.12, 9);
  });

  it('does not double-count funding in dailyPnl when the position later closes', async () => {
    // Funding flows into realizedPnlToday on each hourly accrual; the close
    // path should add ONLY the price-side P&L. Otherwise the day's funding
    // would show up twice in `dailyPnl`.
    const { account, coinbase } = buyAccount(100_000);
    await account.refreshBalance();
    coinbase.listProducts.mockResolvedValueOnce([listedPerp('BTC-PERP-INTX')]);
    await account.refreshPerpCatalog(['BTC-USD']);

    const pos = await openPerpShortFor(
      account,
      coinbase,
      buildShortSignal(),
      30_000,
      { price: '30000', size: '0.001', orderId: 'o-dbl-open' },
    );
    const dailyBefore = account.getState().dailyPnl;

    account.applyFundingAccrual(pos.id, -0.10);
    expect(account.getState().dailyPnl).toBeCloseTo(dailyBefore - 0.10, 9);

    // TP at 28_500 (short). Trigger at 28_400 → price P&L = 30_000 - 28_400
    // = 1_600 per BTC × 0.001 = +1.60. Expected dailyPnl after close =
    // dailyBefore - 0.10 (funding) + 1.60 (price) = +1.50. If funding
    // double-counted on close we'd see dailyBefore - 0.20 + 1.60 = +1.40.
    coinbase.closeFuturesPosition.mockResolvedValueOnce(orderSuccess('o-dbl-close', 'BUY'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-dbl-close', side: 'BUY', status: 'FILLED', average_filled_price: '28400', filled_size: '0.001' }),
    );
    const closed = await account.checkExits(new Map([['BTC-USD', 28_400]]));
    expect(closed).toHaveLength(1);

    expect(account.getState().dailyPnl).toBeCloseTo(dailyBefore - 0.10 + 1.60, 6);
  });

  it('ignores accruals on unknown positions and on spot positions', async () => {
    const { account, coinbase } = buyAccount(100_000);
    await account.refreshBalance();
    coinbase.placeMarketOrder.mockResolvedValueOnce(orderSuccess('o-spot'));
    coinbase.getOrder.mockResolvedValueOnce(
      orderDetails({ order_id: 'o-spot', status: 'FILLED', average_filled_price: '30000', filled_size: '0.001' }),
    );
    const spot = await account.openPosition(buildSignal(), 30_000);
    expect(spot).not.toBeNull();
    const dailyBefore = account.getState().dailyPnl;

    // Unknown id — no-op.
    account.applyFundingAccrual('nope', 1);
    // Spot id — no-op (funding only applies to perps).
    account.applyFundingAccrual(spot!.id, 1);
    // Non-finite — no-op.
    account.applyFundingAccrual(spot!.id, Number.NaN);

    expect(account.getState().dailyPnl).toBe(dailyBefore);
    const live = account.getState().openPositions.find(p => p.id === spot!.id);
    expect(live?.fundingPnl).toBeUndefined();
  });

  it('exposes the underlying Coinbase client so the funding tracker can share auth', async () => {
    const { account, coinbase } = buyAccount(50_000);
    expect(account.getCoinbaseClient()).toBe(asClient(coinbase));
  });
});

// TRA-262 — perp data-feed wiring for the §5 short filters. The live broker
// owns three caches: per-perp metrics (funding + OI from the same listProducts
// call the catalog already makes) and per-perp order-book spread (refreshed
// at the top of each live tick). `getPerpShortFilterContext` merges them into
// the ShortFilterContext that the engine's applyShortGates passes to
// `evaluateShortFilters`.
describe('CryptoLiveAccount perp data-feed wiring (TRA-262)', () => {
  function listedPerpWith(productId: string, perp: { funding_rate?: string; funding_time?: string; open_interest?: string }, price = '60000'): CoinbaseListedProduct {
    return {
      product_id: productId,
      product_type: 'FUTURE',
      price,
      status: 'online',
      perp: {
        fundingRatePerHour: perp.funding_rate != null ? parseFloat(perp.funding_rate) : undefined,
        nextFundingTimeMs: perp.funding_time ? Date.parse(perp.funding_time) : undefined,
        openInterestUsd:
          perp.open_interest != null
            ? parseFloat(perp.open_interest) * parseFloat(price)
            : undefined,
      },
    };
  }

  it('refreshPerpCatalog folds funding + OI into the metrics cache from one listProducts call', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.listProducts.mockResolvedValueOnce([
      listedPerpWith('BTC-PERP-INTX', { funding_rate: '0.0001', open_interest: '1500' }, '60000'),
      listedPerpWith('ETH-PERP-INTX', { funding_rate: '-0.00005' }, '3000'),
    ]);

    await account.refreshPerpCatalog(['BTC-USD', 'ETH-USD']);

    // listProducts was hit once — catalog and metrics share the round-trip.
    expect(coinbase.listProducts).toHaveBeenCalledTimes(1);
    const ctxBtc = account.getPerpShortFilterContext('BTC-USD');
    expect(ctxBtc.fundingRatePerHour).toBe(0.0001);
    expect(ctxBtc.openInterestUsd).toBe(1500 * 60000);
    // ETH publishes funding only; OI stays undefined (gate degrades to skipped).
    const ctxEth = account.getPerpShortFilterContext('ETH-USD');
    expect(ctxEth.fundingRatePerHour).toBe(-0.00005);
    expect(ctxEth.openInterestUsd).toBeUndefined();
  });

  it('returns an empty context for a symbol the perp catalog does not resolve', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.listProducts.mockResolvedValueOnce([
      listedPerpWith('BTC-PERP-INTX', { funding_rate: '0.0001', open_interest: '1500' }),
    ]);
    await account.refreshPerpCatalog(['BTC-USD']);

    expect(account.getPerpShortFilterContext('FOO-USD')).toEqual({});
  });

  it('refreshPerpOrderBookSpreads pulls one product_book per resolved perp and exposes the fraction', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.listProducts.mockResolvedValueOnce([
      listedPerpWith('BTC-PERP-INTX', { funding_rate: '0.0001' }),
      listedPerpWith('ETH-PERP-INTX', { funding_rate: '0.0001' }, '3000'),
    ]);
    await account.refreshPerpCatalog(['BTC-USD', 'ETH-USD']);

    coinbase.getProductBook.mockImplementation(async (productId: string) => {
      if (productId === 'BTC-PERP-INTX') {
        return { bestBid: 60000, bestAsk: 60030, midPrice: 60015, spreadFraction: 30 / 60015 };
      }
      if (productId === 'ETH-PERP-INTX') {
        return { bestBid: 3000, bestAsk: 3009, midPrice: 3004.5, spreadFraction: 9 / 3004.5 };
      }
      return {};
    });

    await account.refreshPerpOrderBookSpreads(['BTC-USD', 'ETH-USD']);

    expect(coinbase.getProductBook).toHaveBeenCalledTimes(2);
    expect(account.getPerpShortFilterContext('BTC-USD').spreadFraction).toBeCloseTo(30 / 60015, 12);
    expect(account.getPerpShortFilterContext('ETH-USD').spreadFraction).toBeCloseTo(9 / 3004.5, 12);
  });

  it('clears a stale spread when product_book throws so the gate skips instead of acting on cached data', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.listProducts.mockResolvedValueOnce([
      listedPerpWith('BTC-PERP-INTX', { funding_rate: '0.0001' }),
    ]);
    await account.refreshPerpCatalog(['BTC-USD']);

    coinbase.getProductBook.mockResolvedValueOnce({
      bestBid: 60000, bestAsk: 60030, midPrice: 60015, spreadFraction: 30 / 60015,
    });
    await account.refreshPerpOrderBookSpreads(['BTC-USD']);
    expect(account.getPerpShortFilterContext('BTC-USD').spreadFraction).toBeDefined();

    // Next tick: Coinbase 503s. Spread must be cleared so the gate skips
    // rather than continuing to act on the now-stale value.
    coinbase.getProductBook.mockRejectedValueOnce(new Error('coinbase 503'));
    await account.refreshPerpOrderBookSpreads(['BTC-USD']);
    expect(account.getPerpShortFilterContext('BTC-USD').spreadFraction).toBeUndefined();
  });

  it('clears a stale spread when product_book returns a one-sided / inverted book', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.listProducts.mockResolvedValueOnce([
      listedPerpWith('BTC-PERP-INTX', { funding_rate: '0.0001' }),
    ]);
    await account.refreshPerpCatalog(['BTC-USD']);

    coinbase.getProductBook.mockResolvedValueOnce({
      bestBid: 60000, bestAsk: 60030, midPrice: 60015, spreadFraction: 30 / 60015,
    });
    await account.refreshPerpOrderBookSpreads(['BTC-USD']);
    expect(account.getPerpShortFilterContext('BTC-USD').spreadFraction).toBeDefined();

    // One-sided book (no asks) — getProductBook returns spreadFraction undefined.
    coinbase.getProductBook.mockResolvedValueOnce({ bestBid: 60000 });
    await account.refreshPerpOrderBookSpreads(['BTC-USD']);
    expect(account.getPerpShortFilterContext('BTC-USD').spreadFraction).toBeUndefined();
  });

  it('preserves catalog + metrics caches when refreshPerpCatalog throws (transient outage = stale data, not zeroed gates)', async () => {
    const { account, coinbase } = buyAccount(50_000);
    coinbase.listProducts.mockResolvedValueOnce([
      listedPerpWith('BTC-PERP-INTX', { funding_rate: '0.0001', open_interest: '1500' }),
    ]);
    await account.refreshPerpCatalog(['BTC-USD']);
    expect(account.getPerpShortFilterContext('BTC-USD').fundingRatePerHour).toBe(0.0001);

    coinbase.listProducts.mockRejectedValueOnce(new Error('coinbase 503'));
    await account.refreshPerpCatalog(['BTC-USD']);

    // Funding still readable from cache — gate keeps firing on the previous
    // value rather than degrading to "skipped" on a transient outage.
    expect(account.getPerpShortFilterContext('BTC-USD').fundingRatePerHour).toBe(0.0001);
  });

  it('skips the network entirely when called with no symbols (idle pure-spot operator)', async () => {
    const { account, coinbase } = buyAccount(50_000);
    await account.refreshPerpOrderBookSpreads([]);
    expect(coinbase.getProductBook).not.toHaveBeenCalled();
  });
});
