import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CoinbaseFundingRate } from '@trading-app/engine';
import type { Position } from '@trading-app/shared';

import { FundingRateTracker, type FundingAccountLike } from './funding-rate-tracker.js';

// Single signature alias so each test's `vi.fn` carries the args type and
// `mock.calls[0]` stays a real tuple instead of inferring `[]`.
type GetFundingRatesFn = (productIds: string[]) => Promise<Map<string, CoinbaseFundingRate>>;

/**
 * TRA-249-D — coverage for the hourly funding-rate accrual hook.
 *
 * The tracker is intentionally a thin compose-step over the
 * {@link CryptoLiveAccount} — it owns the multiply-by-notional math and
 * the sign convention, the account owns the bookkeeping. These tests pin
 * both edges with a hand-rolled `FundingAccountLike` stub so we don't
 * conflate tracker bugs with live-account bugs.
 *
 * Coverage matches the spec's "Tests" block on TRA-258:
 *   - hourly tick computes correct charge given mocked rate + notional,
 *   - multiple open positions accrue independently,
 *   - tracker no-ops with zero perp positions open,
 *   - failure on rate fetch is silent (caller logs continue).
 *
 * The "dailyPnl includes funding charges" + "mid-hour close settles with
 * accumulated funding" assertions live in `crypto-live-account.test.ts`
 * because they require a real CryptoLiveAccount (the bookkeeping invariants
 * live there, not in the tracker).
 */

interface FakePerpPosition {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  quantity: number;
  productType: 'perp';
  productId: string;
}

function buildFakeAccount(positions: FakePerpPosition[]): {
  account: FundingAccountLike;
  applied: Array<{ positionId: string; amountUsd: number }>;
} {
  const applied: Array<{ positionId: string; amountUsd: number }> = [];
  const byId = new Map(positions.map((p) => [p.id, p] as const));
  return {
    applied,
    account: {
      getOpenPerpPositions(): Position[] {
        return positions.map((p) => ({
          id: p.id,
          symbol: p.symbol,
          side: p.side,
          signalType: 'reversal',
          entryPrice: p.entryPrice,
          quantity: p.quantity,
          stopLoss: 0,
          takeProfit: 0,
          openedAt: 0,
          productType: p.productType,
        }));
      },
      getPerpProductId(positionId: string): string | null {
        return byId.get(positionId)?.productId ?? null;
      },
      applyFundingAccrual(positionId: string, amountUsd: number): void {
        applied.push({ positionId, amountUsd });
      },
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('FundingRateTracker (TRA-249-D)', () => {
  it('hourly tick charges fundingRate × notional × side multiplier on a single short', async () => {
    // 0.001 BTC short opened at $30,000 → $30 notional. Funding 0.01%/hr →
    // a SHORT receives +$0.003 per hour at this rate.
    const { account, applied } = buildFakeAccount([
      {
        id: 'p-short',
        symbol: 'BTC-USD',
        side: 'sell',
        entryPrice: 30_000,
        quantity: 0.001,
        productType: 'perp',
        productId: 'BTC-PERP-INTX',
      },
    ]);
    const getFundingRates = vi.fn<GetFundingRatesFn>(async () => new Map([['BTC-PERP-INTX', { rate: 0.0001 }]]));

    const tracker = new FundingRateTracker(account, { getFundingRates });
    await tracker.tick();

    expect(getFundingRates).toHaveBeenCalledTimes(1);
    expect(getFundingRates).toHaveBeenCalledWith(['BTC-PERP-INTX']);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.positionId).toBe('p-short');
    // 30_000 * 0.001 * 0.0001 = 0.003. Short receives positive rate → +0.003.
    expect(applied[0]!.amountUsd).toBeCloseTo(0.003, 9);
  });

  it('charges a long the inverse sign of the published rate (long pays positive funding)', async () => {
    const { account, applied } = buildFakeAccount([
      {
        id: 'p-long',
        symbol: 'ETH-USD',
        side: 'buy',
        entryPrice: 3_000,
        quantity: 0.5,
        productType: 'perp',
        productId: 'ETH-PERP-INTX',
      },
    ]);
    const getFundingRates = vi.fn<GetFundingRatesFn>(async () =>
      new Map<string, CoinbaseFundingRate>([['ETH-PERP-INTX', { rate: 0.0002 }]]),
    );

    const tracker = new FundingRateTracker(account, { getFundingRates });
    await tracker.tick();

    // 3_000 * 0.5 * 0.0002 = 0.30. Long pays positive rate → -0.30.
    expect(applied).toHaveLength(1);
    expect(applied[0]!.amountUsd).toBeCloseTo(-0.3, 9);
  });

  it('accrues multiple open positions independently in one batched fetch', async () => {
    const { account, applied } = buildFakeAccount([
      {
        id: 'p-btc',
        symbol: 'BTC-USD',
        side: 'sell',
        entryPrice: 30_000,
        quantity: 0.002,
        productType: 'perp',
        productId: 'BTC-PERP-INTX',
      },
      {
        id: 'p-eth',
        symbol: 'ETH-USD',
        side: 'sell',
        entryPrice: 3_000,
        quantity: 0.5,
        productType: 'perp',
        productId: 'ETH-PERP-INTX',
      },
    ]);
    const getFundingRates = vi.fn<GetFundingRatesFn>(async () =>
      new Map<string, CoinbaseFundingRate>([
        ['BTC-PERP-INTX', { rate: 0.0001 }],
        ['ETH-PERP-INTX', { rate: 0.0003 }],
      ]),
    );

    const tracker = new FundingRateTracker(account, { getFundingRates });
    await tracker.tick();

    // One batched round-trip across both products.
    expect(getFundingRates).toHaveBeenCalledTimes(1);
    const productIds = getFundingRates.mock.calls[0]![0];
    expect(productIds).toEqual(expect.arrayContaining(['BTC-PERP-INTX', 'ETH-PERP-INTX']));
    expect(productIds).toHaveLength(2);

    expect(applied).toHaveLength(2);
    const byId = new Map(applied.map((a) => [a.positionId, a.amountUsd] as const));
    // BTC short: 30_000 * 0.002 * 0.0001 = 0.006.
    expect(byId.get('p-btc')).toBeCloseTo(0.006, 9);
    // ETH short: 3_000 * 0.5 * 0.0003 = 0.45.
    expect(byId.get('p-eth')).toBeCloseTo(0.45, 9);
  });

  it('no-ops with zero open perp positions (does not call Coinbase)', async () => {
    const { account, applied } = buildFakeAccount([]);
    const getFundingRates = vi.fn();

    const tracker = new FundingRateTracker(account, { getFundingRates });
    await tracker.tick();

    expect(getFundingRates).not.toHaveBeenCalled();
    expect(applied).toHaveLength(0);
  });

  it('skips a position whose perp product_id mapping is missing (defensive: legacy reconciles)', async () => {
    const positions: FakePerpPosition[] = [
      {
        id: 'p-mapped',
        symbol: 'BTC-USD',
        side: 'sell',
        entryPrice: 30_000,
        quantity: 0.001,
        productType: 'perp',
        productId: 'BTC-PERP-INTX',
      },
    ];
    const applied: Array<{ positionId: string; amountUsd: number }> = [];
    const account: FundingAccountLike = {
      getOpenPerpPositions(): Position[] {
        return [
          ...positions.map((p) => ({
            id: p.id,
            symbol: p.symbol,
            side: p.side,
            signalType: 'reversal' as const,
            entryPrice: p.entryPrice,
            quantity: p.quantity,
            stopLoss: 0,
            takeProfit: 0,
            openedAt: 0,
            productType: p.productType,
          })),
          // Phantom position with no perp product_id mapping — must not
          // produce an accrual entry.
          {
            id: 'p-orphan',
            symbol: 'XRP-USD',
            side: 'sell' as const,
            signalType: 'reversal' as const,
            entryPrice: 1,
            quantity: 100,
            stopLoss: 0,
            takeProfit: 0,
            openedAt: 0,
            productType: 'perp' as const,
          },
        ];
      },
      getPerpProductId(positionId: string): string | null {
        return positions.find((p) => p.id === positionId)?.productId ?? null;
      },
      applyFundingAccrual(positionId: string, amountUsd: number): void {
        applied.push({ positionId, amountUsd });
      },
    };
    const getFundingRates = vi.fn<GetFundingRatesFn>(async () =>
      new Map<string, CoinbaseFundingRate>([['BTC-PERP-INTX', { rate: 0.0001 }]]),
    );

    const tracker = new FundingRateTracker(account, { getFundingRates });
    await tracker.tick();

    // Only the mapped position accrues.
    expect(applied).toHaveLength(1);
    expect(applied[0]!.positionId).toBe('p-mapped');
    // Orphan was excluded from the product-id batch entirely.
    expect(getFundingRates).toHaveBeenCalledWith(['BTC-PERP-INTX']);
  });

  it('skips a position whose product is missing from the rate map (Coinbase silently dropped it)', async () => {
    const { account, applied } = buildFakeAccount([
      {
        id: 'p-btc',
        symbol: 'BTC-USD',
        side: 'sell',
        entryPrice: 30_000,
        quantity: 0.001,
        productType: 'perp',
        productId: 'BTC-PERP-INTX',
      },
      {
        id: 'p-eth',
        symbol: 'ETH-USD',
        side: 'sell',
        entryPrice: 3_000,
        quantity: 0.5,
        productType: 'perp',
        productId: 'ETH-PERP-INTX',
      },
    ]);
    const getFundingRates = vi.fn<GetFundingRatesFn>(async () =>
      // Only BTC priced — ETH dropped server-side. Tracker must not
      // hallucinate a 0 charge for ETH.
      new Map<string, CoinbaseFundingRate>([['BTC-PERP-INTX', { rate: 0.0001 }]]),
    );

    const tracker = new FundingRateTracker(account, { getFundingRates });
    await tracker.tick();

    expect(applied).toHaveLength(1);
    expect(applied[0]!.positionId).toBe('p-btc');
  });

  it('swallows getFundingRates failures without applying any accrual', async () => {
    const { account, applied } = buildFakeAccount([
      {
        id: 'p-btc',
        symbol: 'BTC-USD',
        side: 'sell',
        entryPrice: 30_000,
        quantity: 0.001,
        productType: 'perp',
        productId: 'BTC-PERP-INTX',
      },
    ]);
    const getFundingRates = vi.fn<GetFundingRatesFn>(async () => {
      throw new Error('coinbase 503');
    });

    const tracker = new FundingRateTracker(account, { getFundingRates });
    await expect(tracker.tick()).resolves.toBeUndefined();
    expect(applied).toHaveLength(0);
  });

  it('drops rate entries with non-finite numbers (Coinbase parse drift)', async () => {
    const { account, applied } = buildFakeAccount([
      {
        id: 'p-btc',
        symbol: 'BTC-USD',
        side: 'sell',
        entryPrice: 30_000,
        quantity: 0.001,
        productType: 'perp',
        productId: 'BTC-PERP-INTX',
      },
    ]);
    const getFundingRates = vi.fn<GetFundingRatesFn>(async () =>
      new Map<string, CoinbaseFundingRate>([['BTC-PERP-INTX', { rate: Number.NaN }]]),
    );

    const tracker = new FundingRateTracker(account, { getFundingRates });
    await tracker.tick();

    expect(applied).toHaveLength(0);
  });

  it('deduplicates the product_id batch when two positions share the same INTX product', async () => {
    // Two perp positions on the same product_id (e.g. opened by two
    // different strategies). We should only ask Coinbase for the rate
    // once per product, but BOTH positions should accrue against it.
    const { account, applied } = buildFakeAccount([
      {
        id: 'p-1',
        symbol: 'BTC-USD',
        side: 'sell',
        entryPrice: 30_000,
        quantity: 0.001,
        productType: 'perp',
        productId: 'BTC-PERP-INTX',
      },
      {
        id: 'p-2',
        symbol: 'BTC-USD',
        side: 'sell',
        entryPrice: 30_500,
        quantity: 0.002,
        productType: 'perp',
        productId: 'BTC-PERP-INTX',
      },
    ]);
    const getFundingRates = vi.fn<GetFundingRatesFn>(async () =>
      new Map<string, CoinbaseFundingRate>([['BTC-PERP-INTX', { rate: 0.0001 }]]),
    );

    const tracker = new FundingRateTracker(account, { getFundingRates });
    await tracker.tick();

    expect(getFundingRates).toHaveBeenCalledTimes(1);
    expect(getFundingRates.mock.calls[0]![0]).toEqual(['BTC-PERP-INTX']);
    expect(applied).toHaveLength(2);
    const byId = new Map(applied.map((a) => [a.positionId, a.amountUsd] as const));
    expect(byId.get('p-1')).toBeCloseTo(30_000 * 0.001 * 0.0001, 9);
    expect(byId.get('p-2')).toBeCloseTo(30_500 * 0.002 * 0.0001, 9);
  });
});
