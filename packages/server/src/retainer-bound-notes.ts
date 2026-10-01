import type { RetainerBoundNote } from './heap-retainer-census.js';

/**
 * TRA-4986 (AC3) — the published disposition of the retainers the heap census
 * has been asked about: what bounds each one, or why it is correct for it not to
 * be bounded.
 *
 * Deliberately a separate module from `heap-retainer-census.ts`. That module's
 * premise is a reflective walk, so that no container can hide from it; a list of
 * container names inside it would be the hand-written suspect list it argues
 * against. These annotations decide nothing about what is measured — they label
 * rows the walk already found, and a row with no entry here reads `note: null`,
 * which is a gap in the record and not a claim that the container is unbounded.
 *
 * Keep an entry honest or delete it. A stale "bounded at N" on a container whose
 * cap has since been removed is worse than no note at all.
 */
export const RETAINER_BOUND_NOTES: Readonly<Record<string, RetainerBoundNote>> = {
  /**
   * TRA-4986 row B. **The one materially unbounded row in the 53-row census**,
   * and the answer is that capping it here would fix the reading and not the
   * thing. Measured on bqb1 at `faae938837bf`:
   *
   *   boot-relative 20,953 -> 22,625 over 87 h (ratio 1.08), still +433 over the
   *   most recent 23.9 h ring (ratio 1.02) while 22 of the 24 non-empty rows sat
   *   at delta 0 / ratio 1.00.
   *
   * It is **not a cache**. It is the in-memory mirror of each user's PERSISTED
   * watchlist — `DATA_DIR/users/<u>/watchlist.json`, key `stocks.added` — which
   * `createUserContext` replays verbatim into `engine.addSymbol()` at every
   * boot. Evicting an entry in memory would therefore (a) be undone by the next
   * restart, and (b) make `/api/watchlist/stocks` report symbols the engine is
   * no longer tracking, with no log line — the silent-absence shape TRA-2627
   * spent an incident diagnosing.
   *
   * The growth is real and it is in the STORE. `addStocksSymbol` appends and
   * nothing prunes, while two automated passes add market-wide names to EVERY
   * user every day: `generateSmartWatchlist` (premarket, up to `MAX_NEW_SYMBOLS`)
   * and `runMiddayNewsRefreshForAllUsers`. The measurement pins that attribution
   * rather than inferring it: the whole +433 of the 23.9 h ring landed INSIDE the
   * overnight market-shut window (22,192 at 2026-09-30T20:00Z -> 22,625 at
   * 2026-10-01T13:30Z, i.e. ~6.4 per user), which is the premarket build's slot
   * and cannot be live-session discovery. Only `reviewSourced` names (TRA-950)
   * have an expiry; the premarket and news adds have none.
   *
   * ⭐ The demand-side bound that actually matters already exists and is
   * elsewhere: `boundActiveSymbols()` caps the POLLED universe at
   * `resolveScanSymbolLimit()` = 100 by priority tier (TRA-4830, filed off the
   * TRA-4826 all-breakers-open incident), published on `/api/health/quotes` as
   * `scanUniverseBound`. So unbounded MEMBERSHIP here costs short-string memory
   * only — ~22.6k strings, ~1.8 % of heap per month by linear extrapolation —
   * and **zero** request demand. It is also why the TRA-4986 candle hoist is
   * safe: at most 100 of a user's 782 names ever reach the cold-bar scan.
   *
   * Store-level pruning (provenance-tagged auto-adds with a TTL, the shape
   * `reviewSourced` already proves) is the real fix and is a product decision,
   * not a memory fix: it makes symbols disappear from a user's visible
   * watchlist. **TRA-5009**, rather than smuggled in here.
   *
   * ⚠️ When TRA-5009 lands, this entry becomes a lie. Update it in the same
   * change — a stale `bound: null` carrying a reason that no longer holds is
   * worse than no note at all.
   */
  'signalEngine.dynamicSymbols': {
    bound: null,
    reason:
      'Deliberately uncapped: not a cache but the in-memory mirror of the user\'s persisted '
      + 'watchlist (users/<u>/watchlist.json stocks.added), replayed verbatim at every boot by '
      + 'createUserContext. In-memory eviction would be undone by the next restart AND would make '
      + '/api/watchlist/stocks report symbols the engine no longer tracks (TRA-2627 silent-absence '
      + 'shape). The growth is in the STORE: addStocksSymbol appends and nothing prunes, while the '
      + 'premarket smart-watchlist build and the midday news-catalyst refresh add market-wide names '
      + 'to every user daily — measured, the whole +433/23.9h landed inside the overnight '
      + 'market-shut window (~6.4/user), which is the premarket slot. Costs string memory only '
      + '(~1.8%/month of heap) and zero request demand. Store-level TTL pruning with add-provenance '
      + 'is the real fix and is a product decision (it removes symbols from a visible watchlist), '
      + 'filed as TRA-5009.',
    boundedBy:
      'the CONSUMER side, not this container: boundActiveSymbols() caps the polled universe at '
      + 'resolveScanSymbolLimit() = 100 per engine by priority tier (TRA-4830), published on '
      + '/api/health/quotes as scanUniverseBound.',
  },

  /**
   * TRA-4986 row A's replacement row. Bounded by construction rather than by a
   * cap, and the arithmetic is the reason no cap is needed — see
   * `market-data-candle-cache.ts`.
   */
  'marketData.minuteCandles': {
    bound: 6800,
    reason:
      'Bounded by CONSTRUCTION, not by an eviction. Keys are the union of the engines\' scan '
      + 'universes, each capped at resolveScanSymbolLimit() = 100 (TRA-4830), so the union is bounded '
      + 'above by 68 owners x 100 = 6,800 — which is the pre-hoist fleet total (6,608), i.e. the worst '
      + 'case is parity and not a regression. The expected value is |union|, which is this row\'s own '
      + 'entries count and is therefore measured rather than assumed. dynamicSymbols being unbounded '
      + 'does not leak in: at most 100 of a user\'s names survive boundActiveSymbols().',
    boundedBy: 'resolveScanSymbolLimit() = 100 per engine (TRA-4830), union over owners.',
  },

  /**
   * TRA-4986 row C — measured, named, and left alone on purpose. 6,800 = exactly
   * 100 x 68, sitting AT the per-engine bound with ring delta 0. Unlike the
   * candles these are not obviously user-independent (`symbolState` is per-user
   * position/signal state, `technicalSnapshots` is derived per engine), so the
   * note records the bound without claiming they are hoistable.
   */
  'signalEngine.symbolState': {
    bound: 100,
    reason:
      'Seeded from getActiveSymbols(), so bounded at resolveScanSymbolLimit() = 100 per engine and '
      + 'measured sitting at it (6,800 = 100 x 68, ring delta 0). NOT a hoist candidate: this is '
      + 'per-user position/signal state, not market data.',
    boundedBy: 'resolveScanSymbolLimit() = 100 per engine (TRA-4830).',
  },
  'signalEngine.technicalSnapshots': {
    bound: 100,
    reason:
      'Bounded at resolveScanSymbolLimit() = 100 per engine and measured sitting at it (6,800 = '
      + '100 x 68, ring delta 0). Derived from the candle series, so hoistability follows from '
      + 'whether the derivation is user-independent — not yet measured, so not claimed.',
    boundedBy: 'resolveScanSymbolLimit() = 100 per engine (TRA-4830).',
  },
};
