import { describe, it, expect, vi } from 'vitest';
import { derivePricingPath, submitSmartSellToClose } from './tradier-smart-close.js';
import type { TradierOptionQuote, TradierOptionsClient, TradierOrderDetail, TradierOrderResponse } from '@trading-app/engine';

/**
 * TRA-352 — covers the close-side limit walk and quote-fallback behaviour.
 * The helper takes a minimal client surface (4 methods) so the tests build
 * fake clients instead of mocking out the whole TradierOptionsClient.
 */

type SmartCloseClient = Pick<
  TradierOptionsClient,
  'getOptionQuote' | 'sellContractsLimit' | 'cancelOrder' | 'waitForOrderTerminalStatus'
>;

function buildClient(overrides: Partial<SmartCloseClient> = {}): SmartCloseClient {
  return {
    getOptionQuote: vi.fn(async () => null),
    sellContractsLimit: vi.fn(async () => ({ id: 1, status: 'ok' } as TradierOrderResponse)),
    cancelOrder: vi.fn(async () => undefined),
    waitForOrderTerminalStatus: vi.fn(async () => null),
    ...overrides,
  };
}

describe('derivePricingPath', () => {
  it('chooses the midpoint when both sides are positive', () => {
    expect(derivePricingPath({ symbol: 'X', bid: 0.05, ask: 0.17, last: 0.11 })).toEqual({
      kind: 'mid',
      bid: 0.05,
      ask: 0.17,
    });
  });

  it('falls back to last when bid is missing but last is present', () => {
    expect(derivePricingPath({ symbol: 'X', ask: 0.25, last: 0.20 })).toEqual({
      kind: 'last',
      last: 0.20,
    });
  });

  it('falls back to ask-only when neither bid nor last is usable', () => {
    expect(derivePricingPath({ symbol: 'X', ask: 0.25 })).toEqual({ kind: 'last', last: 0.25 });
  });

  it('returns none when nothing usable is available', () => {
    expect(derivePricingPath({ symbol: 'X' })).toEqual({ kind: 'none' });
    expect(derivePricingPath({ symbol: 'X', bid: 0, ask: 0, last: 0 })).toEqual({ kind: 'none' });
    expect(derivePricingPath(null)).toEqual({ kind: 'none' });
  });
});

describe('submitSmartSellToClose', () => {
  it('submits a limit at the midpoint and returns the broker fill on success', async () => {
    const sellSpy = vi.fn(async () => ({ id: 100, status: 'ok' } as TradierOrderResponse));
    const waitSpy = vi.fn(async () => ({
      id: 100,
      status: 'filled',
      avg_fill_price: 0.11,
    } as TradierOrderDetail));
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 0.05, ask: 0.17 } as TradierOptionQuote)),
      sellContractsLimit: sellSpy,
      waitForOrderTerminalStatus: waitSpy,
    });

    const outcome = await submitSmartSellToClose(client, 'X', 2);

    expect(outcome).toEqual({ status: 'filled', orderId: 100, avgFillPrice: 0.11, limitPrice: 0.11 });
    // Midpoint of (0.05 + 0.17) / 2 = 0.11, rounded to a cent.
    expect(sellSpy).toHaveBeenCalledWith('X', 2, 0.11);
    // No cancellation on a clean fill.
    expect((client.cancelOrder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('walks a quarter-step toward the bid when the first attempt does not fill', async () => {
    // bid 0.05 / ask 0.17 → mid 0.11. Quarter-step toward bid:
    //   bid + (ask - bid) * 0.25 = 0.05 + 0.12 * 0.25 = 0.08 → rounded to 0.08.
    const sellSpy = vi.fn(async (_sym: string, _qty: number, _price: number) =>
      ({ id: 200, status: 'ok' } as TradierOrderResponse),
    );
    let call = 0;
    const waitSpy = vi.fn(async () => {
      call += 1;
      return call === 1
        ? ({ id: 200, status: 'open' } as TradierOrderDetail) // first attempt pending
        : ({ id: 201, status: 'filled', avg_fill_price: 0.08 } as TradierOrderDetail);
    });
    sellSpy.mockResolvedValueOnce({ id: 200, status: 'ok' } as TradierOrderResponse);
    sellSpy.mockResolvedValueOnce({ id: 201, status: 'ok' } as TradierOrderResponse);
    const cancelSpy = vi.fn(async () => undefined);
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 0.05, ask: 0.17 } as TradierOptionQuote)),
      sellContractsLimit: sellSpy,
      waitForOrderTerminalStatus: waitSpy,
      cancelOrder: cancelSpy,
    });

    const outcome = await submitSmartSellToClose(client, 'X', 3, { maxAttempts: 2 });

    expect(outcome.status).toBe('filled');
    expect((outcome as { avgFillPrice: number }).avgFillPrice).toBeCloseTo(0.08, 2);
    expect(sellSpy).toHaveBeenNthCalledWith(1, 'X', 3, 0.11);
    expect(sellSpy).toHaveBeenNthCalledWith(2, 'X', 3, 0.08);
    // First pending order must be cancelled before the walk submits the next limit.
    expect(cancelSpy).toHaveBeenCalledWith(200);
  });

  it('returns rejected with the Tradier reason when the broker terminates the order', async () => {
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 0.10, ask: 0.20 } as TradierOptionQuote)),
      sellContractsLimit: vi.fn(async () => ({ id: 300, status: 'ok' } as TradierOrderResponse)),
      waitForOrderTerminalStatus: vi.fn(async () => ({
        id: 300,
        status: 'rejected',
        reason_description: 'insufficient buying power',
      } as TradierOrderDetail)),
    });

    const outcome = await submitSmartSellToClose(client, 'X', 1);

    expect(outcome).toEqual({
      status: 'rejected',
      orderId: 300,
      reason: 'insufficient buying power',
    });
  });

  it('returns rejected when sellContractsLimit throws (network / 4xx)', async () => {
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 0.10, ask: 0.20 } as TradierOptionQuote)),
      sellContractsLimit: vi.fn(async () => {
        throw new Error('Tradier order failed (401): bad token');
      }),
    });

    const outcome = await submitSmartSellToClose(client, 'X', 1);
    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: string }).reason).toContain('401');
  });

  // Verification step 3 in the TRA-352 spec — deep-OTM dead option:
  // bid 0.05 / ask 0.17 must close at ~0.11 (midpoint), not 0.05 (bid).
  it('TRA-352 spec scenario: 0.05/0.17 OCC closes at midpoint, not bid', async () => {
    const sellSpy = vi.fn(async () => ({ id: 400, status: 'ok' } as TradierOrderResponse));
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 0.05, ask: 0.17 } as TradierOptionQuote)),
      sellContractsLimit: sellSpy,
      waitForOrderTerminalStatus: vi.fn(async () => ({
        id: 400,
        status: 'filled',
        avg_fill_price: 0.11,
      } as TradierOrderDetail)),
    });

    const outcome = await submitSmartSellToClose(client, 'X', 1);

    expect(outcome.status).toBe('filled');
    expect((outcome as { avgFillPrice: number }).avgFillPrice).toBeCloseTo(0.11, 2);
    expect(sellSpy).toHaveBeenCalledWith('X', 1, 0.11);
  });

  it('refuses when no usable quote is available (both bid and last absent)', async () => {
    const sellSpy = vi.fn(async () => ({ id: 500, status: 'ok' } as TradierOrderResponse));
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 0, ask: 0, last: 0 } as TradierOptionQuote)),
      sellContractsLimit: sellSpy,
    });

    const outcome = await submitSmartSellToClose(client, 'X', 1);

    expect(outcome.status).toBe('no_quote');
    // Critically — we never submit an order against a quote we can't price.
    expect(sellSpy).not.toHaveBeenCalled();
  });

  it('returns pending with the last attempted order id when the walk exhausts attempts', async () => {
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 0.10, ask: 0.30 } as TradierOptionQuote)),
      sellContractsLimit: vi.fn(async (_sym, _qty, _price) =>
        ({ id: Date.now(), status: 'ok' } as TradierOrderResponse),
      ),
      // Every poll returns pending — the walk never finds a terminal state.
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 600, status: 'open' } as TradierOrderDetail)),
    });

    const outcome = await submitSmartSellToClose(client, 'X', 1, { maxAttempts: 2 });

    expect(outcome.status).toBe('pending');
    expect((outcome as { orderId: number }).orderId).toBeGreaterThan(0);
  });

  it('falls back to last when bid is missing but last is available', async () => {
    const sellSpy = vi.fn(async () => ({ id: 700, status: 'ok' } as TradierOrderResponse));
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', ask: 0.30, last: 0.25 } as TradierOptionQuote)),
      sellContractsLimit: sellSpy,
      waitForOrderTerminalStatus: vi.fn(async () => ({
        id: 700,
        status: 'filled',
        avg_fill_price: 0.25,
      } as TradierOrderDetail)),
    });

    const outcome = await submitSmartSellToClose(client, 'X', 1);

    expect(outcome.status).toBe('filled');
    expect(sellSpy).toHaveBeenCalledWith('X', 1, 0.25);
  });
});
