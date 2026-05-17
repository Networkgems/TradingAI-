import type { CoinbaseFundingRate, CoinbaseOrderClient } from '@trading-app/engine';
import type { Position } from '@trading-app/shared';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'funding-rate-tracker' });

/**
 * TRA-249-D — minimal surface FundingRateTracker needs from
 * {@link CryptoLiveAccount}. Pulled into an interface so unit tests can
 * stub the account without spinning up the full Coinbase mock plumbing.
 */
export interface FundingAccountLike {
  getOpenPerpPositions(): Position[];
  getPerpProductId(positionId: string): string | null;
  applyFundingAccrual(positionId: string, amountUsd: number): void;
}

/**
 * TRA-249-D — Coinbase HTTP surface FundingRateTracker depends on. Same
 * Pick-style narrowing as the existing live-account-side fakes so tests
 * don't need to reconstruct a full {@link CoinbaseOrderClient}.
 */
export type FundingCoinbaseClient = Pick<CoinbaseOrderClient, 'getFundingRates'>;

/**
 * Hourly funding-rate accrual for open Coinbase INTX perp positions
 * (TRA-249-D — subtask of [TRA-249](/TRA/issues/TRA-249)).
 *
 * Coinbase charges/credits funding on perpetual positions every hour. Even
 * at 1× leverage the cost is non-trivial: a 0.01% hourly rate on a $1k
 * notional short held for 24 hours nets $2.40 — enough to flip a marginal
 * trade negative. Without this tracker, the dashboard's `dailyPnl` would
 * silently drift from the Coinbase statement on any multi-hour open.
 *
 * Lifecycle:
 *
 * - Owner (CryptoSignalEngine) wires the tracker against its
 *   {@link CryptoLiveAccount} broker once the live account exists.
 * - The MarketScheduler's `onHourly` callback fans out to every user's
 *   tracker once per ET hour (idempotent — see scheduler dedupe key).
 * - Each tick: fetch the funding rate per open-perp product in one
 *   batched request, then apply `rate × notional × sideMultiplier` to
 *   each position via {@link FundingAccountLike.applyFundingAccrual}.
 *
 * Idle behaviour: when no perp positions are open the tracker returns
 * before issuing any Coinbase request, so a pure-spot operator pays zero
 * overhead for the hourly tick.
 *
 * Failure semantics: a failed `getFundingRates` call logs and returns;
 * the next hourly tick will retry. We deliberately do NOT zero-charge a
 * fallback rate — a phantom 0 funding entry would mask a real Coinbase
 * outage and bias `dailyPnl` against the statement.
 */
export class FundingRateTracker {
  constructor(
    private readonly account: FundingAccountLike,
    private readonly coinbase: FundingCoinbaseClient,
  ) {}

  /**
   * Run one hourly accrual pass. Caller is responsible for scheduling
   * (MarketScheduler `onHourly`); this method is a single round-trip.
   */
  async tick(): Promise<void> {
    const positions = this.account.getOpenPerpPositions();
    if (positions.length === 0) return;

    const productIds = new Set<string>();
    for (const pos of positions) {
      const productId = this.account.getPerpProductId(pos.id);
      if (productId) productIds.add(productId);
    }
    if (productIds.size === 0) return;

    let rates: Map<string, CoinbaseFundingRate>;
    try {
      rates = await this.coinbase.getFundingRates(Array.from(productIds));
    } catch (err: unknown) {
      log.warn('funding rate fetch failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const pos of positions) {
      const productId = this.account.getPerpProductId(pos.id);
      if (!productId) continue;
      const info = rates.get(productId);
      if (!info || !Number.isFinite(info.rate)) continue;
      // Coinbase publishes funding as an hourly fraction; the spec's
      // `fundingRate × notional × hours` reduces to `rate × notional` at
      // hours=1. Notional is taken at entry — TRA-249 epic accepts this
      // approximation for first-pass parity (matches the spec example
      // math: $1k notional × 0.01% hourly = $0.10/hour).
      const notional = pos.entryPrice * pos.quantity;
      // Sign convention: positive funding rate → longs pay shorts. Stamp
      // `+` on shorts (credit) and `-` on longs (charge). Funding tracker
      // only sees Coinbase perps so the spot-only `pos.side` of an open
      // long here is BUY at 1× leverage (TRA-249-C scope).
      const sideMultiplier = pos.side === 'sell' ? 1 : -1;
      const charge = sideMultiplier * info.rate * notional;
      this.account.applyFundingAccrual(pos.id, charge);
    }
  }
}
