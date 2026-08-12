import { describe, it, expect, vi } from 'vitest';
import {
  computeRepriceLimit,
  derivePricingPath,
  liveSellLimit,
  liveSellLimitDetailed,
  PENDING_CLOSE_MAX_REPRICE_STEPS,
  reconcilePendingCloseOrder,
  repricePendingCloseOrder,
  submitSmartSellToClose,
} from './tradier-smart-close.js';
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

describe('liveSellLimit (TRA-450)', () => {
  it('prices a stop exit on the bid (immediately marketable) when the book is sane', () => {
    // mid 0.12, floor 0.6 × 0.12 = 0.072 — a bid at 0.10 clears it untouched.
    expect(liveSellLimit({ symbol: 'X', bid: 0.10, ask: 0.14 }, 'bid')).toBe(0.10);
  });

  it('prices a profit / manual exit at the midpoint', () => {
    expect(liveSellLimit({ symbol: 'X', bid: 0.05, ask: 0.17 }, 'mid')).toBe(0.11);
  });

  it('falls back to last on a single-sided quote for either level', () => {
    expect(liveSellLimit({ symbol: 'X', ask: 0.30, last: 0.25 }, 'bid')).toBe(0.25);
    expect(liveSellLimit({ symbol: 'X', ask: 0.30, last: 0.25 }, 'mid')).toBe(0.25);
  });

  it('returns null when the quote yields no usable price', () => {
    expect(liveSellLimit({ symbol: 'X' }, 'bid')).toBeNull();
    expect(liveSellLimit({ symbol: 'X', bid: 0, ask: 0, last: 0 }, 'mid')).toBeNull();
    expect(liveSellLimit(null, 'mid')).toBeNull();
  });

  it('rounds the midpoint to the nearest cent', () => {
    // (0.05 + 0.18) / 2 = 0.115 → 0.12 (round half up via roundToCent).
    expect(liveSellLimit({ symbol: 'X', bid: 0.05, ask: 0.18 }, 'mid')).toBe(0.12);
  });
});

describe('liveSellLimitDetailed floor (TRA-2811)', () => {
  it('floors the exact 2026-08-03 production defect: bid 0.17 / ask 2.49 (mid 1.33)', () => {
    // The live SL exit submitted the raw bid — $0.17 against a $1.33 mid, −87%
    // vs mid, filled at $0.89 (−33% vs mid). Floor = 0.6 × 1.33 = 0.798 → 0.80.
    // TRA-3418 — the cap then lifts that 0.80 again, to 1.33 − max(0.05, 0.0665)
    // = 1.2635 → 1.26, and hands 0.80 back as the escalation price.
    expect(liveSellLimitDetailed({ symbol: 'X', bid: 0.17, ask: 2.49 }, 'bid')).toEqual({
      limit: 1.26,
      raw: 0.17,
      mid: 1.33,
      floored: true,
      capped: true,
      escalateTo: 0.8,
    });
  });

  it('leaves a sane bid untouched and reports floored: false', () => {
    expect(liveSellLimitDetailed({ symbol: 'X', bid: 0.16, ask: 0.21 }, 'bid')).toEqual({
      limit: 0.16,
      raw: 0.16,
      mid: 0.19,
      floored: false,
      capped: false,
      escalateTo: null,
    });
  });

  it('never floors the mid level — mid is above the floor by construction', () => {
    expect(liveSellLimitDetailed({ symbol: 'X', bid: 0.17, ask: 2.49 }, 'mid')).toEqual({
      limit: 1.33,
      raw: 1.33,
      mid: 1.33,
      floored: false,
      capped: false,
      escalateTo: null,
    });
  });

  it('cannot floor a single-sided (last-path) quote — no mid to floor against', () => {
    expect(liveSellLimitDetailed({ symbol: 'X', ask: 0.30, last: 0.25 }, 'bid')).toEqual({
      limit: 0.25,
      raw: 0.25,
      mid: null,
      floored: false,
      capped: false,
      escalateTo: null,
    });
  });

  it('returns null when the quote yields no usable price', () => {
    expect(liveSellLimitDetailed(null, 'bid')).toBeNull();
    expect(liveSellLimitDetailed({ symbol: 'X', bid: 0, ask: 0, last: 0 }, 'bid')).toBeNull();
  });
});

/**
 * TRA-3418 — the concession cap, graded against the three live `single_leg_otm`
 * exits that produced it. Each row is a real production submission; `limit` is
 * what the fixed code asks for FIRST and `escalateTo` is what it falls back to,
 * which is byte-for-byte the price the un-fixed code submitted.
 */
describe('liveSellLimitDetailed concession cap (TRA-3418)', () => {
  it('caps the 2026-08-07 TROW loss: mid 3.60 / bid 3.00 filled AT the 3.00 limit', () => {
    // `TROW260918C00115000`, live production. Concession allowed =
    // max(0.05, 3.60 × 0.05) = 0.18 → cap 3.42. The bid conceded 0.60.
    expect(liveSellLimitDetailed({ symbol: 'TROW260918C00115000', bid: 3.0, ask: 4.2 }, 'bid')).toEqual({
      limit: 3.42,
      raw: 3.0,
      mid: 3.6,
      floored: false,
      capped: true,
      escalateTo: 3.0,
    });
  });

  it('caps KVYO to within a cent of the price the book actually cleared at', () => {
    // `KVYO260918C00017500`: submitted 1.20 (the bid, −15.8% vs mid) and the
    // broker's routing filled it at 1.3533 — mid − 5.03%. That fill is the
    // empirical anchor for the 5% fraction: the cap lands at 1.35, i.e. we now
    // ASK for the price the market was already willing to pay.
    expect(liveSellLimitDetailed({ symbol: 'KVYO260918C00017500', bid: 1.2, ask: 1.65 }, 'bid')).toEqual({
      limit: 1.35,
      raw: 1.2,
      // 1.425 → 1.42: `roundToCent` is Math.round on a binary float and
      // 1.425 × 100 is 142.49999999999997. Reported mid only, never the limit.
      mid: 1.42,
      floored: false,
      capped: true,
      escalateTo: 1.2,
    });
  });

  it('leaves the penny-option regime alone — TSLA 0.22/0.27 stays on the bid', () => {
    // `TSLA260911C00555000`: −10.2% vs mid reads alarming, but it is $0.025 per
    // share. The absolute leg (max(0.05, …)) is what keeps the cap out of this
    // regime — holding a STOP above the bid to chase 2.5 cents is a bad trade.
    expect(liveSellLimitDetailed({ symbol: 'TSLA260911C00555000', bid: 0.22, ask: 0.27 }, 'bid')).toEqual({
      limit: 0.22,
      raw: 0.22,
      mid: 0.25,
      floored: false,
      capped: false,
      escalateTo: null,
    });
  });

  it('never prices ABOVE the mid — the cap is a floor on the concession, not a markup', () => {
    for (const [bid, ask] of [[3.0, 4.2], [1.2, 1.65], [0.17, 2.49], [0.1, 0.14], [0.02, 9.0]]) {
      const r = liveSellLimitDetailed({ symbol: 'X', bid, ask }, 'bid');
      expect(r).not.toBeNull();
      expect(r!.limit).toBeLessThanOrEqual(r!.mid!);
      // …and never worse than the price the un-fixed code would have submitted.
      expect(r!.limit).toBeGreaterThanOrEqual(r!.escalateTo ?? r!.limit);
    }
  });

  it('stands down on a contract cheaper than the absolute concession leg', () => {
    // mid 0.03 − max(0.05, 0.0015) is negative; there is no sane cap price, and
    // a sub-nickel contract can only be sold by crossing. Leave it on the bid.
    expect(liveSellLimitDetailed({ symbol: 'X', bid: 0.02, ask: 0.04 }, 'bid')).toEqual({
      limit: 0.02,
      raw: 0.02,
      mid: 0.03,
      floored: false,
      capped: false,
      escalateTo: null,
    });
  });

  it('escalateTo is exactly the pre-TRA-3418 price, so escalation can only restore old behaviour', () => {
    const r = liveSellLimitDetailed({ symbol: 'X', bid: 3.0, ask: 4.2 }, 'bid')!;
    expect(r.escalateTo).toBe(r.raw); // sane book: the un-capped price IS the bid
    const degenerate = liveSellLimitDetailed({ symbol: 'X', bid: 0.17, ask: 2.49 }, 'bid')!;
    expect(degenerate.escalateTo).toBe(0.8); // wide book: the TRA-2811 donation floor still binds
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

    // TRA-1601 — the filled outcome now carries the mid for close-side slippage
    // telemetry: (0.05 + 0.17) / 2 = 0.11.
    expect(outcome).toEqual({
      status: 'filled',
      orderId: 100,
      avgFillPrice: 0.11,
      limitPrice: 0.11,
      mid: (0.05 + 0.17) / 2,
    });
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

/**
 * TRA-352 follow-up — board flagged that "Pending #N" rows in TradeAI never
 * sync with Tradier's actual terminal state. The reconciler closes that
 * gap by polling each `pendingCloseOrderId` per tick. These tests cover
 * every outcome the engine's tick handler branches on.
 */
describe('reconcilePendingCloseOrder', () => {
  type ReconcileClient = Pick<TradierOptionsClient, 'getOrderStatus'>;
  function buildStatusClient(detail: TradierOrderDetail | null): ReconcileClient {
    return { getOrderStatus: vi.fn(async () => detail) };
  }

  it('reports filled with avg_fill_price when Tradier filled the order', async () => {
    const client = buildStatusClient({
      id: 42,
      status: 'filled',
      avg_fill_price: 0.09,
    } as TradierOrderDetail);

    const outcome = await reconcilePendingCloseOrder(client, 42);

    expect(outcome).toEqual({ status: 'filled', orderId: 42, avgFillPrice: 0.09 });
  });

  it('reports rejected with the broker reason on canceled / rejected / expired / error', async () => {
    for (const status of ['canceled', 'rejected', 'expired', 'error']) {
      const client = buildStatusClient({
        id: 1,
        status,
        reason_description: 'whatever Tradier said',
      } as TradierOrderDetail);
      const outcome = await reconcilePendingCloseOrder(client, 1);
      expect(outcome.status).toBe('rejected');
      expect((outcome as { reason: string }).reason).toBe('whatever Tradier said');
    }
  });

  it('falls back to the raw status string when Tradier omits reason_description', async () => {
    const client = buildStatusClient({ id: 2, status: 'expired' } as TradierOrderDetail);
    const outcome = await reconcilePendingCloseOrder(client, 2);
    expect(outcome).toEqual({ status: 'rejected', orderId: 2, reason: 'expired' });
  });

  it('reports pending when Tradier still shows the order as open / pending', async () => {
    for (const status of ['open', 'pending', 'partially_filled']) {
      const client = buildStatusClient({ id: 3, status } as TradierOrderDetail);
      const outcome = await reconcilePendingCloseOrder(client, 3);
      expect(outcome.status).toBe('pending');
    }
  });

  it('reports unknown when getOrderStatus throws (so the caller retries next tick)', async () => {
    const client: ReconcileClient = {
      getOrderStatus: vi.fn(async () => {
        throw new Error('socket reset');
      }),
    };
    const outcome = await reconcilePendingCloseOrder(client, 4);
    expect(outcome.status).toBe('unknown');
    expect((outcome as { reason: string }).reason).toContain('socket reset');
  });

  it('reports unknown when getOrderStatus returns null (broker dropped the order envelope)', async () => {
    const client = buildStatusClient(null);
    const outcome = await reconcilePendingCloseOrder(client, 5);
    expect(outcome.status).toBe('unknown');
  });

  it('treats filled-without-avg_fill_price as unknown so we retry instead of closing at $0', async () => {
    const client = buildStatusClient({ id: 6, status: 'filled' } as TradierOrderDetail);
    const outcome = await reconcilePendingCloseOrder(client, 6);
    expect(outcome.status).toBe('unknown');
  });

  // TRA-416 — a terminal "rejected"-family status can still carry a non-zero
  // `exec_quantity`: the order filled PART of its size before the broker
  // expired / cancelled it. That must surface as `partial_fill`, not
  // `rejected`, so the caller books the slice instead of leaking it.
  it('reports partial_fill when a terminal order filled part of its size', async () => {
    for (const status of ['canceled', 'expired', 'rejected', 'error']) {
      const client = buildStatusClient({
        id: 10,
        status,
        exec_quantity: 6,
        avg_fill_price: 1.20,
        reason_description: 'EOD expiration',
      } as TradierOrderDetail);
      const outcome = await reconcilePendingCloseOrder(client, 10);
      expect(outcome).toEqual({
        status: 'partial_fill',
        orderId: 10,
        avgFillPrice: 1.20,
        filledQty: 6,
      });
    }
  });

  it('falls back to plain rejected when a terminal order filled nothing', async () => {
    const client = buildStatusClient({
      id: 12,
      status: 'canceled',
      exec_quantity: 0,
      reason_description: 'user cancelled',
    } as TradierOrderDetail);
    const outcome = await reconcilePendingCloseOrder(client, 12);
    expect(outcome.status).toBe('rejected');
  });

  it('treats a partial fill with no usable avg_fill_price as rejected (no $0 booking)', async () => {
    // exec_quantity present but no price — booking the slice at $0 would
    // corrupt P&L, so we surface `rejected` and let the portfolio reconcile
    // pick up the contract drift instead.
    const client = buildStatusClient({
      id: 13,
      status: 'expired',
      exec_quantity: 3,
    } as TradierOrderDetail);
    const outcome = await reconcilePendingCloseOrder(client, 13);
    expect(outcome.status).toBe('rejected');
  });
});

/**
 * TRA-392 — fill-chaser. A `pending` `sell_to_close` that stalls at its
 * original limit must be cancelled and resubmitted one step lower toward the
 * bid until it fills, instead of sitting pending forever. These tests cover
 * the price-walk math and the cancel/reprice primitive.
 */
describe('computeRepriceLimit', () => {
  const MAX = PENDING_CLOSE_MAX_REPRICE_STEPS; // 4

  it('walks the limit monotonically down toward the bid, landing on the bid', () => {
    // bid 16 / ask 18 → spread 2. Step 1 sits at bid + 0.2·spread, the final
    // step lands exactly on the bid.
    const quote: TradierOptionQuote = { symbol: 'X', bid: 16, ask: 18 };
    const limits = [1, 2, 3, 4].map((s) => computeRepriceLimit(quote, s, MAX));
    expect(limits).toEqual([16.4, 16.27, 16.13, 16]);
    // Strictly descending.
    for (let i = 1; i < limits.length; i += 1) {
      expect(limits[i]!).toBeLessThan(limits[i - 1]!);
    }
  });

  it('clamps steps beyond max to the bid (most-aggressive marketable price)', () => {
    const quote: TradierOptionQuote = { symbol: 'X', bid: 16, ask: 18 };
    expect(computeRepriceLimit(quote, 99, MAX)).toBe(16);
  });

  it('walks a single-sided (last-only) quote down toward — never to — zero', () => {
    const quote: TradierOptionQuote = { symbol: 'X', ask: 0.3, last: 0.25 };
    const limits = [1, 2, 3, 4].map((s) => computeRepriceLimit(quote, s, MAX));
    // last × (steps−k+1)/(steps+1): 0.25·4/5, 3/5, 2/5, 1/5.
    expect(limits).toEqual([0.2, 0.15, 0.1, 0.05]);
    expect(limits.every((l) => l! > 0)).toBe(true);
  });

  it('returns null when no usable quote is available (price floor — no $0 order)', () => {
    expect(computeRepriceLimit({ symbol: 'X', bid: 0, ask: 0, last: 0 }, 1, MAX)).toBeNull();
    expect(computeRepriceLimit(null, 1, MAX)).toBeNull();
  });
});

describe('repricePendingCloseOrder', () => {
  type RepriceClient = Pick<TradierOptionsClient, 'getOptionQuote' | 'sellContractsLimit' | 'cancelOrder'>;
  function buildRepriceClient(overrides: Partial<RepriceClient> = {}): RepriceClient {
    return {
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 16, ask: 18 } as TradierOptionQuote)),
      sellContractsLimit: vi.fn(async () => ({ id: 900, status: 'ok' } as TradierOrderResponse)),
      cancelOrder: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it('cancels the stale order and resubmits one step lower toward the bid', async () => {
    const cancelSpy = vi.fn(async () => undefined);
    const sellSpy = vi.fn(async () => ({ id: 901, status: 'ok' } as TradierOrderResponse));
    const client = buildRepriceClient({ cancelOrder: cancelSpy, sellContractsLimit: sellSpy });

    const outcome = await repricePendingCloseOrder(client, 'X', 3, 800, 1, PENDING_CLOSE_MAX_REPRICE_STEPS);

    expect(outcome).toEqual({ status: 'repriced', orderId: 901, limitPrice: 16.4, step: 1 });
    // Stale order cancelled BEFORE the resubmit so the close size isn't doubled.
    expect(cancelSpy).toHaveBeenCalledWith(800);
    expect(sellSpy).toHaveBeenCalledWith('X', 3, 16.4);
  });

  it('pulls a fresh quote on every reprice so the limit tracks the live bid/ask', async () => {
    let call = 0;
    const quoteSpy = vi.fn(async () => {
      call += 1;
      // Bid drifts up between steps — the limit must follow the live quote.
      return call === 1
        ? ({ symbol: 'X', bid: 16, ask: 18 } as TradierOptionQuote)
        : ({ symbol: 'X', bid: 17, ask: 18 } as TradierOptionQuote);
    });
    const sellSpy = vi.fn(async () => ({ id: 1, status: 'ok' } as TradierOrderResponse));
    const client = buildRepriceClient({ getOptionQuote: quoteSpy, sellContractsLimit: sellSpy });

    const first = await repricePendingCloseOrder(client, 'X', 1, 10, 1, PENDING_CLOSE_MAX_REPRICE_STEPS);
    const second = await repricePendingCloseOrder(client, 'X', 1, 11, 2, PENDING_CLOSE_MAX_REPRICE_STEPS);

    expect(quoteSpy).toHaveBeenCalledTimes(2);
    // Step 1 off the 16/18 quote: 16 + 2·0.2 = 16.40.
    expect((first as { limitPrice: number }).limitPrice).toBe(16.4);
    // Step 2 off the *fresh* 17/18 quote: 17 + 1·(0.2·2/3) = 17.13.
    expect((second as { limitPrice: number }).limitPrice).toBe(17.13);
  });

  it('holds (no cancel, no resubmit) when the floor is reached — never a $0 order', async () => {
    const cancelSpy = vi.fn(async () => undefined);
    const sellSpy = vi.fn(async () => ({ id: 1, status: 'ok' } as TradierOrderResponse));
    const client = buildRepriceClient({
      getOptionQuote: vi.fn(async () => ({ symbol: 'X', bid: 0, ask: 0, last: 0 } as TradierOptionQuote)),
      cancelOrder: cancelSpy,
      sellContractsLimit: sellSpy,
    });

    const outcome = await repricePendingCloseOrder(client, 'X', 1, 800, 1, PENDING_CLOSE_MAX_REPRICE_STEPS);

    expect(outcome.status).toBe('held');
    // Critically — the original order is left LIVE; we don't cancel into a
    // no-order limbo and we never submit a $0 order.
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(sellSpy).not.toHaveBeenCalled();
  });

  it('holds when the quote lookup throws (transient broker error)', async () => {
    const cancelSpy = vi.fn(async () => undefined);
    const client = buildRepriceClient({
      getOptionQuote: vi.fn(async () => {
        throw new Error('socket reset');
      }),
      cancelOrder: cancelSpy,
    });

    const outcome = await repricePendingCloseOrder(client, 'X', 1, 800, 1, PENDING_CLOSE_MAX_REPRICE_STEPS);

    expect(outcome.status).toBe('held');
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('reports error when the resubmit fails after the cancel went through', async () => {
    const client = buildRepriceClient({
      sellContractsLimit: vi.fn(async () => {
        throw new Error('Tradier order failed (401)');
      }),
    });

    const outcome = await repricePendingCloseOrder(client, 'X', 1, 800, 1, PENDING_CLOSE_MAX_REPRICE_STEPS);

    expect(outcome.status).toBe('error');
    expect((outcome as { reason: string }).reason).toContain('401');
  });
});
