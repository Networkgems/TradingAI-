import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CoinbaseAccountBalance,
  CoinbaseOrderClient,
  CoinbaseOrderDetails,
  CoinbaseOrderSuccessResponse,
} from '@trading-app/engine';
import type { TradeSignal } from '@trading-app/shared';

import { CryptoLiveAccount } from './crypto-live-account.js';

// We exercise CryptoLiveAccount through a hand-rolled stand-in for
// CoinbaseOrderClient — only the methods this account actually invokes are
// implemented. Cast through `unknown` to satisfy the constructor's nominal
// type without dragging in HMAC/JWT plumbing the test doesn't care about.
class FakeCoinbaseClient {
  listAccounts = vi.fn<() => Promise<CoinbaseAccountBalance[]>>();
  placeMarketOrder = vi.fn<() => Promise<CoinbaseOrderSuccessResponse>>();
  getOrder = vi.fn<(orderId: string) => Promise<CoinbaseOrderDetails>>();
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
