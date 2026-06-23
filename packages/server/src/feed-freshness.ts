/**
 * TRA-418 — data-feed freshness gating + ordered failover.
 *
 * ## Problem (TRA-408 / TRA-402 review §5, item 5 of 5)
 * Candle/quote caches were used even when stale. When a feed went down the
 * engine kept the last successful candles and quote in its in-memory cache,
 * so a strategy could evaluate — and fire a brand-new entry signal — off a
 * quote that was minutes or hours old. A stale feed must never produce a new
 * entry signal.
 *
 * ## Freshness gating
 * Before strategy evaluation, the engine checks the age of the quote and the
 * candle series backing each symbol against a max-staleness threshold. A
 * symbol whose feed is stale beyond the threshold is excluded from signal
 * evaluation and marked stale (`quoteStatus: 'stale'` in the crypto path's
 * `symbolState`). {@link evaluateFeedFreshness} is the pure decision function
 * so the gate is unit-testable without a live feed.
 *
 * ## Ordered failover
 * When the primary feed is stale/down, the per-asset feed modules fail over
 * across providers in a fixed, documented order. The canonical orders live in
 * the `*_FAILOVER_ORDER` constants below; the cascade implementations in
 * `crypto-feed.ts` and `yahoo-feed.ts` follow them.
 */
import type { Candle } from '@trading-app/shared';

/**
 * Crypto quote/candle failover order. Coinbase Exchange is primary because the
 * live crypto broker routes to the same venue, so quote ↔ execution prices
 * stay aligned; Yahoo backstops symbols Coinbase does not list; CoinMarketCap
 * is the final fallback. Implemented by `crypto-feed.ts` `fetchCryptoQuotes`.
 */
export const CRYPTO_FEED_FAILOVER_ORDER = ['coinbase', 'yahoo', 'cmc'] as const;

/**
 * Equity quote failover order. Tradier is primary (same venue as the live
 * equity broker); the Yahoo quote endpoint is second; the Yahoo *chart*
 * endpoint is third (TRA-1035 — keyless, and survives when the quote endpoint
 * fails closed without a crumb while the chart endpoint still resolves); Stooq
 * (delayed, key-less CSV) is the last-resort backstop.
 * Implemented by `yahoo-feed.ts` `fetchQuote` / `fetchQuotes`.
 */
export const EQUITY_QUOTE_FAILOVER_ORDER = ['tradier', 'yahoo', 'yahooChart', 'stooq'] as const;

/**
 * Equity minute-bar (candle) failover order. Tradier timesales is primary,
 * Yahoo charts second, Twelve Data third. Stooq is intentionally NOT in this
 * chain — its CSV endpoint is a last-print quote with no intraday bar series.
 * Implemented by `yahoo-feed.ts` `fetchMinuteBarsWithSource`.
 */
export const EQUITY_CANDLE_FAILOVER_ORDER = ['tradier', 'yahoo', 'twelvedata'] as const;

/**
 * Max age of a live quote before the symbol's feed is considered stale.
 * Crypto ticks every ~60s; five missed refreshes is a clear feed outage.
 */
export const MAX_QUOTE_AGE_MS = 5 * 60_000;

/**
 * Max age of the latest completed candle before the candle feed is considered
 * stale. Completed minute bars are always ≥1 min old (the in-progress bar is
 * dropped), so we allow a generous ~12 missed bars before declaring the feed
 * down — this absorbs ordinary provider jitter without masking a real outage.
 */
export const MAX_CANDLE_AGE_MS = 12 * 60_000;

export interface FeedFreshnessInput {
  /**
   * Timestamp (ms epoch) of the last successful quote for the symbol — the
   * crypto path's `symbolState.lastUpdated`. `0` / `undefined` means the
   * symbol has never been quoted ("loading"), which is distinct from stale.
   */
  quoteLastUpdated?: number;
  /** Candle series backing the symbol's strategies (typically minute bars). */
  candles?: readonly Candle[];
}

export interface FeedFreshnessVerdict {
  /** True when the symbol's feed is stale beyond threshold — skip signal eval. */
  stale: boolean;
  /** Human-readable reason, present only when `stale` is true. */
  reason?: string;
}

export interface FeedFreshnessOptions {
  maxQuoteAgeMs?: number;
  maxCandleAgeMs?: number;
}

/** Timestamp (ms epoch) of the most recent candle, or `null` when empty. */
export function latestCandleTimestamp(candles?: readonly Candle[]): number | null {
  if (!candles || candles.length === 0) return null;
  let latest = 0;
  for (const c of candles) {
    if (Number.isFinite(c.timestamp) && c.timestamp > latest) latest = c.timestamp;
  }
  return latest > 0 ? latest : null;
}

/**
 * Decide whether a symbol's market-data feed is stale.
 *
 * A feed is stale when EITHER the last quote OR the latest candle is older
 * than its threshold. Both checks are pure functions of (timestamp, now,
 * threshold) so they can be unit-tested deterministically.
 *
 * Notes:
 *  - A missing quote (`quoteLastUpdated` 0/undefined) is "never quoted", not
 *    stale — the caller's existing `if (!price) continue` guard handles it.
 *  - An empty candle cache is "loading", not stale — the caller's existing
 *    minimum-bar-count guard handles it. Only a non-empty-but-old series is
 *    flagged stale here.
 */
export function evaluateFeedFreshness(
  input: FeedFreshnessInput,
  now: number,
  opts: FeedFreshnessOptions = {},
): FeedFreshnessVerdict {
  const maxQuoteAge = opts.maxQuoteAgeMs ?? MAX_QUOTE_AGE_MS;
  const maxCandleAge = opts.maxCandleAgeMs ?? MAX_CANDLE_AGE_MS;

  const lastUpdated = input.quoteLastUpdated;
  if (typeof lastUpdated === 'number' && lastUpdated > 0) {
    const age = now - lastUpdated;
    if (age > maxQuoteAge) {
      return {
        stale: true,
        reason: `quote ${Math.round(age / 1000)}s old (> ${Math.round(maxQuoteAge / 1000)}s threshold)`,
      };
    }
  }

  const latest = latestCandleTimestamp(input.candles);
  if (latest !== null) {
    const age = now - latest;
    if (age > maxCandleAge) {
      return {
        stale: true,
        reason: `latest candle ${Math.round(age / 1000)}s old (> ${Math.round(maxCandleAge / 1000)}s threshold)`,
      };
    }
  }

  return { stale: false };
}
