import { describe, it, expect, vi } from 'vitest';
import { derivePricingPath, submitSmartBuyToOpen, SMART_BUY_WALK_FRACTIONS, buildWalkLimits } from './tradier-smart-open.js';
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

describe('submitSmartBuyToOpen — no-day-trading backstop (TRA-598 C3)', () => {
  it('rejects a 0DTE OCC buy_to_open before any quote/order call', async () => {
    const client = buildClient();
    const outcome = await submitSmartBuyToOpen(client, 'AAPL240604C00200000', 1, {
      now: Date.parse('2024-06-04T14:00:00Z'), // same day as the OCC expiration → 0DTE
    });
    expect(outcome.status).toBe('rejected');
    expect(outcome).toMatchObject({ reason: expect.stringMatching(/no day trading/i) });
    expect((client.getOptionQuote as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((client.buyContractsLimit as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('lets a far-dated OCC entry through to the quote path', async () => {
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'AAPL', bid: 1.0, ask: 1.2 } as TradierOptionQuote)),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 1, status: 'filled', avg_fill_price: 1.11 } as TradierOrderDetail)),
    });
    const outcome = await submitSmartBuyToOpen(client, 'AAPL240705C00200000', 1, {
      now: Date.parse('2024-06-04T14:00:00Z'), // 31 DTE → clears the floor
    });
    expect(outcome.status).toBe('filled');
    expect((client.getOptionQuote as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('skips the backstop for a non-OCC symbol (no expiration to parse)', async () => {
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 1.0, ask: 1.2 } as TradierOptionQuote)),
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 1, status: 'filled', avg_fill_price: 1.11 } as TradierOrderDetail)),
    });
    const outcome = await submitSmartBuyToOpen(client, 'X', 1);
    expect(outcome.status).toBe('filled');
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

// TRA-1601 (A) — the configurable chase ladder: buildWalkLimits geometry and
// the new bounded cross-tick tail past the ask.
describe('buildWalkLimits (TRA-1601 configurable ladder)', () => {
  it('reproduces the TRA-374 schedule byte-for-byte on the default config', () => {
    const limits = buildWalkLimits(
      { kind: 'mid', bid: 1.0, ask: 1.2 },
      { fractions: [0, 0.25, 0.5, 0.75, 1.0], stepWaitMs: 30_000, maxCrossTicks: 0, tickSize: 0.01 },
    );
    // mid 1.10: [mid+0.01, mid+0.25*0.1, mid+0.5*0.1, mid+0.75*0.1, ask]
    expect(limits.map((x) => Number(x.toFixed(4)))).toEqual([1.11, 1.125, 1.15, 1.175, 1.2]);
  });

  it('appends bounded cross-tick steps past the ask when maxCrossTicks > 0', () => {
    const limits = buildWalkLimits(
      { kind: 'mid', bid: 1.0, ask: 1.2 },
      { fractions: [0, 1.0], stepWaitMs: 1, maxCrossTicks: 2, tickSize: 0.01 },
    );
    // [mid+0.01, ask, ask+0.01, ask+0.02]
    expect(limits.map((x) => Number(x.toFixed(4)))).toEqual([1.11, 1.2, 1.21, 1.22]);
  });

  it('ask-only path: N ask attempts then the cross-tick tail', () => {
    const limits = buildWalkLimits(
      { kind: 'ask_only', ask: 0.75 },
      { fractions: [0, 0.5, 1], stepWaitMs: 1, maxCrossTicks: 1, tickSize: 0.01 },
    );
    expect(limits.map((x) => Number(x.toFixed(4)))).toEqual([0.75, 0.75, 0.75, 0.76]);
  });
});

describe('submitSmartBuyToOpen — cross-tick config end to end', () => {
  it('crosses one tick past the ask on the final attempt when configured', async () => {
    // bid 1.00 / ask 1.20, maxCrossTicks 1 → after the ask attempt (1.20) the
    // walk submits one more at 1.21 which fills.
    const prices: number[] = [];
    const buySpy = vi.fn(async (_s: string, _q: number, price: number) => {
      prices.push(price);
      return { id: 500 + prices.length, status: 'ok' } as TradierOrderResponse;
    });
    const waitSpy = vi.fn(async () =>
      // fill only on the cross-tick attempt (the 6th submit)
      prices.length >= 6
        ? ({ id: 1, status: 'filled', avg_fill_price: 1.21 } as TradierOrderDetail)
        : ({ id: 1, status: 'open' } as TradierOrderDetail),
    );
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 1.0, ask: 1.2 } as TradierOptionQuote)),
      buyContractsLimit: buySpy,
      waitForOrderTerminalStatus: waitSpy,
      cancelOrder: vi.fn(async () => undefined),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 1, {
      timeoutMs: 1,
      sleep: async () => {},
      walk: { fractions: [0, 0.25, 0.5, 0.75, 1.0], stepWaitMs: 1, maxCrossTicks: 1, tickSize: 0.01 },
    });

    expect(outcome.status).toBe('filled');
    expect((outcome as { walk: number }).walk).toBe(5); // one past the last fraction index (4)
    expect(prices[prices.length - 1]).toBeCloseTo(1.21, 2);
  });

  it('defaults (no walk option) still stop AT the ask — never crosses it', async () => {
    const prices: number[] = [];
    const buySpy = vi.fn(async (_s: string, _q: number, price: number) => {
      prices.push(price);
      return { id: 1, status: 'ok' } as TradierOrderResponse;
    });
    const client = buildClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 1.0, ask: 1.2 } as TradierOptionQuote)),
      buyContractsLimit: buySpy,
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 1, status: 'open' } as TradierOrderDetail)),
      cancelOrder: vi.fn(async () => undefined),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 1, { timeoutMs: 1, sleep: async () => {} });

    expect(outcome.status).toBe('walk_exhausted');
    // No price ever exceeds the ask.
    expect(Math.max(...prices)).toBeCloseTo(1.2, 2);
  });
});
