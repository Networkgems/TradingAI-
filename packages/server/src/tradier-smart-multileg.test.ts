import { describe, it, expect, vi } from 'vitest';
import {
  submitSmartMultiLeg,
  legSideFor,
  pricingFor,
  type SmartMultiLegInputLeg,
} from './tradier-smart-multileg.js';
import type {
  TradierOptionQuote,
  TradierOptionsClient,
  TradierOrderDetail,
  TradierOrderResponse,
  TradierMultilegPricing,
} from '@trading-app/engine';

/**
 * TRA-912 (TRA-908 Phase B) — covers the multi-leg net-price limit walk. A fake
 * client (4 methods) stands in for TradierOptionsClient so the tests drive the
 * net pricing + walk without a live broker.
 */

type SmartMultiLegClient = Pick<
  TradierOptionsClient,
  'getOptionQuote' | 'submitMultilegOrder' | 'cancelOrder' | 'waitForOrderTerminalStatus'
>;

// A bull put spread: sell the higher-strike put, buy the lower-strike put.
const SHORT_PUT = 'AAPL260918P00190000';
const LONG_PUT = 'AAPL260918P00185000';

// short: bid 2.00 / ask 2.20 (mid 2.10); long: bid 1.00 / ask 1.10 (mid 1.05).
//  mid net  = (+1.05 buy) + (-2.10 sell) = -1.05  (net credit 1.05)
//  cross    = (+1.10 ask) + (-2.00 bid)  = -0.90  (least credit, fully marketable)
const QUOTES: Record<string, TradierOptionQuote> = {
  [SHORT_PUT]: { symbol: SHORT_PUT, bid: 2.0, ask: 2.2 },
  [LONG_PUT]: { symbol: LONG_PUT, bid: 1.0, ask: 1.1 },
};

const SPREAD_LEGS: SmartMultiLegInputLeg[] = [
  { action: 'sell', optionSymbol: SHORT_PUT },
  { action: 'buy', optionSymbol: LONG_PUT },
];

function buildClient(overrides: Partial<SmartMultiLegClient> = {}): SmartMultiLegClient {
  return {
    getOptionQuote: vi.fn(async (sym: string) => QUOTES[sym] ?? null),
    submitMultilegOrder: vi.fn(async () => ({ id: 1, status: 'ok' } as TradierOrderResponse)),
    cancelOrder: vi.fn(async () => undefined),
    waitForOrderTerminalStatus: vi.fn(async () => null),
    ...overrides,
  };
}

describe('legSideFor', () => {
  it('maps opening actions to *_to_open sides', () => {
    expect(legSideFor('buy', 'open')).toBe('buy_to_open');
    expect(legSideFor('sell', 'open')).toBe('sell_to_open');
  });
  it('maps closing to the flattening *_to_close sides', () => {
    expect(legSideFor('buy', 'close')).toBe('sell_to_close');
    expect(legSideFor('sell', 'close')).toBe('buy_to_close');
  });
});

describe('pricingFor', () => {
  it('a positive net is a debit', () => {
    expect(pricingFor(1.25)).toEqual<TradierMultilegPricing>({ type: 'debit', price: 1.25 });
  });
  it('a negative net is a credit (absolute price)', () => {
    expect(pricingFor(-1.04)).toEqual<TradierMultilegPricing>({ type: 'credit', price: 1.04 });
  });
  it('a ~zero net is even', () => {
    expect(pricingFor(0)).toEqual<TradierMultilegPricing>({ type: 'even' });
  });
});

describe('submitSmartMultiLeg (TRA-912)', () => {
  it('opens a credit spread, filling at the first (mid + 1¢) net attempt', async () => {
    const client = buildClient({
      waitForOrderTerminalStatus: vi.fn(
        async () => ({ id: 1, status: 'filled', avg_fill_price: 1.04 } as TradierOrderDetail),
      ),
    });

    const outcome = await submitSmartMultiLeg(client, SPREAD_LEGS, 'open');

    expect(outcome.status).toBe('filled');
    if (outcome.status === 'filled') {
      expect(outcome.walk).toBe(0);
      // mid -1.05 + 1¢ toward the cross = -1.04 (a credit of 1.04).
      expect(outcome.netLimit).toBeCloseTo(-1.04, 6);
      expect(outcome.avgNetPrice).toBeCloseTo(-1.04, 6); // signed credit
      expect(outcome.mid).toBeCloseTo(-1.05, 6);
    }

    // Verify the broker call: underlying AAPL, credit pricing, *_to_open sides.
    const submit = client.submitMultilegOrder as ReturnType<typeof vi.fn>;
    expect(submit).toHaveBeenCalledTimes(1);
    const [underlying, legs, pricing] = submit.mock.calls[0];
    expect(underlying).toBe('AAPL');
    expect(pricing).toEqual({ type: 'credit', price: 1.04 });
    expect(legs).toEqual([
      { optionSymbol: SHORT_PUT, side: 'sell_to_open', quantity: 1 },
      { optionSymbol: LONG_PUT, side: 'buy_to_open', quantity: 1 },
    ]);
  });

  it('walks toward the cross and cancels stale tickets between attempts', async () => {
    // Pending on attempts 0 and 1, filled on attempt 2.
    let n = 0;
    const client = buildClient({
      submitMultilegOrder: vi.fn(async () => ({ id: 10 + n, status: 'ok' } as TradierOrderResponse)),
      waitForOrderTerminalStatus: vi.fn(async () => {
        n += 1;
        if (n < 3) return { id: 9 + n, status: 'open' } as TradierOrderDetail; // pending
        return { id: 12, status: 'filled', avg_fill_price: 1.01 } as TradierOrderDetail;
      }),
      cancelOrder: vi.fn(async () => undefined),
    });

    const outcome = await submitSmartMultiLeg(client, SPREAD_LEGS, 'open', { sleep: async () => {} });

    expect(outcome.status).toBe('filled');
    if (outcome.status === 'filled') expect(outcome.walk).toBe(2);
    // One cancel per stale attempt (attempts 0 and 1).
    expect((client.cancelOrder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect((client.submitMultilegOrder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('multiplies leg quantity by the contracts count', async () => {
    const client = buildClient({
      waitForOrderTerminalStatus: vi.fn(
        async () => ({ id: 1, status: 'filled', avg_fill_price: 1.04 } as TradierOrderDetail),
      ),
    });
    await submitSmartMultiLeg(client, SPREAD_LEGS, 'open', { contracts: 3 });
    const [, legs] = (client.submitMultilegOrder as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(legs[0].quantity).toBe(3);
    expect(legs[1].quantity).toBe(3);
  });

  it('returns no_quote when a leg lacks a two-sided quote (never submits)', async () => {
    const client = buildClient({
      getOptionQuote: vi.fn(async (sym: string) =>
        sym === LONG_PUT ? ({ symbol: LONG_PUT, ask: 1.1 } as TradierOptionQuote) : QUOTES[sym],
      ),
    });
    const outcome = await submitSmartMultiLeg(client, SPREAD_LEGS, 'open');
    expect(outcome.status).toBe('no_quote');
    expect((client.submitMultilegOrder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('rejects a structure with fewer than two legs', async () => {
    const client = buildClient();
    const outcome = await submitSmartMultiLeg(client, [SPREAD_LEGS[0]!], 'open');
    expect(outcome.status).toBe('rejected');
    expect((client.getOptionQuote as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('surfaces a broker reject status with its reason', async () => {
    const client = buildClient({
      waitForOrderTerminalStatus: vi.fn(
        async () =>
          ({ id: 1, status: 'rejected', reason_description: 'insufficient buying power' } as TradierOrderDetail),
      ),
    });
    const outcome = await submitSmartMultiLeg(client, SPREAD_LEGS, 'open');
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.reason).toMatch(/insufficient buying power/);
  });

  it('returns walk_exhausted after crossing fully without a fill', async () => {
    const client = buildClient({
      waitForOrderTerminalStatus: vi.fn(async () => ({ id: 1, status: 'open' } as TradierOrderDetail)),
    });
    const outcome = await submitSmartMultiLeg(client, SPREAD_LEGS, 'open', { sleep: async () => {} });
    expect(outcome.status).toBe('walk_exhausted');
    if (outcome.status === 'walk_exhausted') {
      // Final attempt sits at the full cross net (-0.90 → credit 0.90).
      expect(outcome.lastNetLimit).toBeCloseTo(-0.9, 6);
    }
    // 5 walk steps attempted; the last pending ticket is cancelled too.
    expect((client.submitMultilegOrder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(5);
  });
});
