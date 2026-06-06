// TRA-602 — StockTwits social-sentiment aggregate.
//
// StockTwits exposes a per-symbol message stream where individual posts may
// carry a self-reported `Bullish`/`Bearish` tag. This module reduces a batch of
// those (normalized) messages into a single per-symbol {@link SocialSentiment}
// read: a recency-weighted net bull/bear score plus a raw message-volume "buzz"
// count, with the same tilt-gating shape as the news aggregate (TRA-534).
//
// `aggregateStockTwitsSentiment` is PURE: same (messages + clock) ⇒ same output,
// so it is unit-tested with golden fixtures and carries no network/IO. The live
// fetch + circuit-breaker live in the server-side `stocktwits-feed.ts` adapter,
// keeping the scoring math testable in isolation. `source: 'stocktwits'` tags
// the provider so a second social feed (Reddit/X) can be folded in later without
// a schema change.

import type { SocialSentiment, StockTwitsMessage } from './index.js';

/** Recency half-life (hours) — matches the news aggregate (TRA-534 §B). */
const HALF_LIFE_HOURS = 6;
/** Net-score magnitude at/above which the tilt becomes directional. */
const TILT_THRESHOLD = 0.25;
/** Newest tagged message older than this ⇒ tilt forced neutral. */
const STALE_MINUTES = 720;
/** Minimum bull+bear-tagged messages required for a non-neutral tilt. */
const MIN_TAGGED_FOR_TILT = 5;
/**
 * TRA-603 — recency-weight multiplier applied to curated (followed-account)
 * messages so a high-signal analyst/official-feed call moves `netScore` more
 * than an anonymous crowd post of the same age.
 */
const CURATED_WEIGHT_MULTIPLIER = 3;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(v: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function recencyWeight(ageMinutes: number): number {
  const ageHours = Math.max(0, ageMinutes) / 60;
  return Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
}

export interface AggregateSocialOptions {
  symbol: string;
  messages: readonly StockTwitsMessage[];
  /** Wall clock in epoch ms — pass `Date.now()` at the call site (keeps this pure). */
  now: number;
}

/**
 * Reduce a batch of StockTwits messages into the per-symbol social aggregate.
 *
 * `netScore` is the recency-weighted mean of per-message polarity (+1 bullish,
 * −1 bearish; untagged messages contribute to `messageCount` buzz but not to the
 * score). `tilt` is the gated directional read: bullish ≥ +0.25 / bearish ≤
 * −0.25, forced `neutral` when fewer than {@link MIN_TAGGED_FOR_TILT} tagged
 * messages or the newest tagged message is staler than {@link STALE_MINUTES}.
 * Pure given `now`; never throws (malformed timestamps are dropped).
 */
export function aggregateStockTwitsSentiment(opts: AggregateSocialOptions): SocialSentiment {
  const { symbol, messages, now } = opts;
  const asOf = new Date(now).toISOString();
  const sym = symbol.toUpperCase();

  let weighted = 0;
  let weightSum = 0;
  let bullishCount = 0;
  let bearishCount = 0;
  let messageCount = 0;
  let newestTaggedAgeMin = Number.POSITIVE_INFINITY;

  for (const m of messages) {
    const t = Date.parse(m.createdAt);
    if (Number.isNaN(t)) continue;
    messageCount += 1;
    if (m.sentiment !== 'Bullish' && m.sentiment !== 'Bearish') continue;

    const ageMinutes = Math.max(0, (now - t) / 60000);
    const polarity = m.sentiment === 'Bullish' ? 1 : -1;
    const weight = recencyWeight(ageMinutes) * (m.curated ? CURATED_WEIGHT_MULTIPLIER : 1);
    weighted += polarity * weight;
    weightSum += weight;
    if (polarity > 0) bullishCount += 1;
    else bearishCount += 1;
    if (ageMinutes < newestTaggedAgeMin) newestTaggedAgeMin = ageMinutes;
  }

  const taggedCount = bullishCount + bearishCount;
  const netScore = weightSum > 0 ? round(clamp(weighted / weightSum, -1, 1)) : 0;
  const freshnessMinutes = Number.isFinite(newestTaggedAgeMin)
    ? Math.round(newestTaggedAgeMin)
    : 0;

  let tilt: SocialSentiment['tilt'] =
    netScore >= TILT_THRESHOLD ? 'bullish' : netScore <= -TILT_THRESHOLD ? 'bearish' : 'neutral';
  if (taggedCount < MIN_TAGGED_FOR_TILT || freshnessMinutes > STALE_MINUTES) {
    tilt = 'neutral';
  }

  return {
    symbol: sym,
    asOf,
    window: '24h',
    source: 'stocktwits',
    netScore,
    bullishCount,
    bearishCount,
    taggedCount,
    messageCount,
    freshnessMinutes,
    tilt,
  };
}

/**
 * TRA-603 — dedupe a batch of StockTwits messages by message id, preferring the
 * curated copy on a collision. A curated account's post about a symbol can also
 * surface in that symbol's anonymous crowd stream; keeping the curated copy
 * ensures the higher weight survives the merge. Order is otherwise preserved
 * (first occurrence wins for non-curated collisions). Pure; never throws.
 */
export function dedupeStockTwitsMessages(
  messages: readonly StockTwitsMessage[],
): StockTwitsMessage[] {
  const byId = new Map<number, StockTwitsMessage>();
  for (const m of messages) {
    const existing = byId.get(m.id);
    if (!existing) {
      byId.set(m.id, m);
    } else if (m.curated && !existing.curated) {
      byId.set(m.id, m); // upgrade an anonymous copy to its curated twin
    }
  }
  return [...byId.values()];
}

/**
 * TRA-603 — fan a batch of curated messages out into a per-symbol map keyed by
 * uppercased ticker, using each message's `symbols` entity. A message that
 * mentions N symbols is emitted under all N. Messages without symbols are
 * skipped (they cannot be attributed to a per-symbol cache). The returned arrays
 * are deduped by message id. Pure; never throws.
 */
export function mapCuratedMessagesBySymbol(
  messages: readonly StockTwitsMessage[],
): Map<string, StockTwitsMessage[]> {
  const bySymbol = new Map<string, StockTwitsMessage[]>();
  for (const m of messages) {
    if (!Array.isArray(m.symbols)) continue;
    for (const raw of m.symbols) {
      const sym = raw.toUpperCase();
      if (!sym) continue;
      const bucket = bySymbol.get(sym);
      if (bucket) bucket.push(m);
      else bySymbol.set(sym, [m]);
    }
  }
  for (const [sym, bucket] of bySymbol) {
    bySymbol.set(sym, dedupeStockTwitsMessages(bucket));
  }
  return bySymbol;
}
