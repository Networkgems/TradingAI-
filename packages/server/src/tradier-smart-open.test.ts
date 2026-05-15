import { describe, it, expect, vi } from 'vitest';
import { derivePricingPath, submitSmartBuyToOpen, SMART_BUY_WALK_FRACTIONS } from './tradier-smart-open.js';
import type {
  TradierOptionQuote,
  TradierOptionsClient,
  TradierOrderDetail,
  TradierOrderResponse,
} from '@trading-app/engine';

/**
 * TRA-374 — covers the entry-side limit walk (mid + 1¢ → 0.25 → 0.5 → 0.75 →
 * ask) and quote-fallback behaviour. Helper takes a minimal client surface
 * (4 methods) so the tests build fake clients instead of mocking out the
 * whole TradierOptionsClient.
 */

type SmartOpenClient = Pick<
  TradierOptionsClient,
  'getOptionQuote' | 'buyContractsLimit' | 'cancelOrder' | 'waitForOrderTerminalStatus'
>;

function buildClient(overrides: Partial<SmartOpenClient> = {}): SmartOpenClient {
  return {
    getOptionQuote: vi.fn(async () => null),
    buyContractsLimit: vi.fn(async () => ({ id: 1, status: 'ok' } as TradierOrderResponse)),
    cancelOrder: vi.fn(async () => undefined),
    waitForOrderTerminalStatus: vi.fn(async () => null),
    ...overrides,
  };
}

describe('derivePricingPath (open)', () => {
  it('chooses the midpoint when both sides are positive', () => {
    expect(derivePricingPath({ symbol: 'X', bid: 1.00, ask: 1.20 })).toEqual({
      kind: 'mid',
      bid: 1.00,
      ask: 1.20,
    });
  });

  it('falls back to ask-only when bid is missing but ask is present', () => {
    expect(derivePricingPath({ symbol: 'X', ask: 1.25 })).toEqual({ kind: 'ask_only', ask: 1.25 });
  });

  it('returns none when nothing usable is available', () => {
    expect(derivePricingPath({ symbol: 'X' })).toEqual({ kind: 'none' });
    expect(derivePricingPath({ symbol: 'X', bid: 0, ask: 0 })).toEqual({ kind: 'none' });
    expect(derivePricingPath(null)).toEqual({ kind: 'none' });
  });

  it('refuses inverted quotes (bid > ask) by falling back to ask-only', () => {
    expect(derivePricingPath({ symbol: 'X', bid: 1.30, ask: 1.20 })).toEqual({
      kind: 'ask_only',
      ask: 1.20,
    });
  });
});

describe('submitSmartBuyToOpen', () => {
  it('submits a limit at mid + 1¢ and returns the broker fill on first attempt', async () => {
    // bid 1.00 / ask 1.20 → mid 1.10 → attempt 0 = mid + 0.01 = 1.11.
    const buySpy = vi.fn(async () => ({ id: 100, status: 'ok' } as TradierOrderResponse));
    const waitSpy = vi.fn(async () => ({
      id: 100,
      status: 'filled',
      avg_fill_price: 1.11,
    } as TradierOrderDetail));
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 1.00, ask: 1.20 } as TradierOptionQuote)),
      buyContractsLimit: buySpy,
      waitForOrderTerminalStatus: waitSpy,
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 2);

    expect(outcome.status).toBe('filled');
    expect(outcome).toMatchObject({
      orderId: 100,
      avgFillPrice: 1.11,
      limitPrice: 1.11,
      walk: 0,
      mid: 1.10,
      ask: 1.20,
    });
    expect(buySpy).toHaveBeenCalledWith('X', 2, 1.11);
    expect((client.cancelOrder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('walks toward the ask in 0.25 increments when the first attempt does not fill', async () => {
    // bid 1.00 / ask 1.20 → mid 1.10. Walk:
    //   attempt 0: mid + 0.01 = 1.11
    //   attempt 1: mid + 0.25 × (ask − mid) = 1.10 + 0.025 = 1.13 (rounded to cent)
    let askCallCount = 0;
    const buySpy = vi.fn(async () => {
      askCallCount += 1;
      return { id: 200 + askCallCount, status: 'ok' } as TradierOrderResponse;
    });
    const waitSpy = vi.fn(async () => {
      // First attempt pending, second attempt fills at 1.13.
      return askCallCount === 1
        ? ({ id: 201, status: 'open' } as TradierOrderDetail)
        : ({ id: 202, status: 'filled', avg_fill_price: 1.13 } as TradierOrderDetail);
    });
    const cancelSpy = vi.fn(async () => undefined);
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 1.00, ask: 1.20 } as TradierOptionQuote)),
      buyContractsLimit: buySpy,
      waitForOrderTerminalStatus: waitSpy,
      cancelOrder: cancelSpy,
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 3, { timeoutMs: 1, sleep: async () => {} });

    expect(outcome.status).toBe('filled');
    expect((outcome as { walk: number }).walk).toBe(1);
    expect((outcome as { avgFillPrice: number }).avgFillPrice).toBeCloseTo(1.13, 2);
    expect(buySpy).toHaveBeenNthCalledWith(1, 'X', 3, 1.11);
    expect(buySpy).toHaveBeenNthCalledWith(2, 'X', 3, 1.13);
    expect(cancelSpy).toHaveBeenCalledWith(201);
  });

  it('returns walk_exhausted after the final ask attempt without filling', async () => {
    // Always pending → walk should burn all 5 attempts then cancel and return.
    const buySpy = vi.fn(async () => ({ id: 999, status: 'ok' } as TradierOrderResponse));
    const waitSpy = vi.fn(async () => ({ id: 999, status: 'open' } as TradierOrderDetail));
    const cancelSpy = vi.fn(async () => undefined);
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 1.00, ask: 1.20 } as TradierOptionQuote)),
      buyContractsLimit: buySpy,
      waitForOrderTerminalStatus: waitSpy,
      cancelOrder: cancelSpy,
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 1, { timeoutMs: 1, sleep: async () => {} });

    expect(outcome.status).toBe('walk_exhausted');
    expect((outcome as { reason: string }).reason).toContain('walk to ask exhausted');
    // 5 attempts (mid+1¢ + 4 walk fractions). Last attempt = ask = 1.20.
    expect(buySpy).toHaveBeenCalledTimes(SMART_BUY_WALK_FRACTIONS.length);
    expect((outcome as { lastLimitPrice: number }).lastLimitPrice).toBeCloseTo(1.20, 2);
    // Every pending attempt should be cancelled before re-submitting (and the
    // last one cancelled before the walk-exhausted return).
    expect(cancelSpy).toHaveBeenCalledTimes(SMART_BUY_WALK_FRACTIONS.length);
  });

  it('returns no_quote and never submits when Tradier has no usable quote', async () => {
    const buySpy = vi.fn(async () => ({ id: 1, status: 'ok' } as TradierOrderResponse));
    const client = buildClient({
      getOptionQuote: vi.fn(async () => null),
      buyContractsLimit: buySpy,
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 1);

    expect(outcome.status).toBe('no_quote');
    expect(buySpy).not.toHaveBeenCalled();
  });

  it('returns rejected with the Tradier reason when the broker terminates the order', async () => {
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 0.40, ask: 0.50 } as TradierOptionQuote)),
      buyContractsLimit: vi.fn(async () => ({ id: 300, status: 'ok' } as TradierOrderResponse)),
      waitForOrderTerminalStatus: vi.fn(async () => ({
        id: 300,
        status: 'rejected',
        reason_description: 'insufficient buying power',
      } as TradierOrderDetail)),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 1, { timeoutMs: 1, sleep: async () => {} });

    expect(outcome.status).toBe('rejected');
    expect((outcome as { reason: string }).reason).toBe('insufficient buying power');
  });

  it('on an ask-only quote, every attempt is the ask and walk_exhausted reflects that', async () => {
    // No bid → ask-only path. Attempts collapse to a one-shot ask, but the
    // walk still steps through the configured attempts (every one at the ask)
    // before giving up.
    let askCallCount = 0;
    const buySpy = vi.fn(
      async (_sym: string, _qty: number, _price: number) => {
        askCallCount += 1;
        return { id: 400 + askCallCount, status: 'ok' } as TradierOrderResponse;
      },
    );
    const waitSpy = vi.fn(async () => ({ id: 1, status: 'open' } as TradierOrderDetail));
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', ask: 0.75 } as TradierOptionQuote)),
      buyContractsLimit: buySpy,
      waitForOrderTerminalStatus: waitSpy,
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 1, { timeoutMs: 1, sleep: async () => {} });

    expect(outcome.status).toBe('walk_exhausted');
    expect((outcome as { lastLimitPrice: number }).lastLimitPrice).toBeCloseTo(0.75, 2);
    // Every attempt should have been at the ask.
    for (const call of buySpy.mock.calls) {
      expect(call[2]).toBeCloseTo(0.75, 2);
    }
  });
});
