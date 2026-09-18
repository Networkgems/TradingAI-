// TRA-4656 / TRA-4707 — the ONE staleness predicate for streamed quotes.
//
// Lives in `shared` (not beside `TradierStreamFeed` in `engine`) so the desktop
// can grade a quote's age with the same function the server's feed snapshot
// uses: `apps/desktop` cannot import `@trading-app/engine` (it pulls `ws`). A
// UI-side copy of the `>` boundary would be a second definition free to drift.

/** A quote older than this reads stale. The boundary is STRICT: exactly 2000ms is fresh. */
export const QUOTE_STALE_AFTER_MS = 2000;

export interface SymbolFreshness {
  symbol: string;
  eventTime: number;
  receivedAt: number;
  /** now − eventTime at the moment the snapshot was taken. */
  ageMs: number;
  stale: boolean;
  latencyMs: number;
}

/** Pure freshness read, shared by the feed snapshot and any UI that holds a quote. */
export function quoteFreshness(
  q: { symbol: string; eventTime: number; receivedAt: number; latencyMs: number },
  nowMs: number,
  staleAfterMs = QUOTE_STALE_AFTER_MS,
): SymbolFreshness {
  const ageMs = nowMs - q.eventTime;
  return {
    symbol: q.symbol,
    eventTime: q.eventTime,
    receivedAt: q.receivedAt,
    ageMs,
    stale: ageMs > staleAfterMs,
    latencyMs: q.latencyMs,
  };
}
