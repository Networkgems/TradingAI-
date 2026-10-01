/**
 * TRA-4987 — don't spend a Tradier request to learn what the symbol already says.
 *
 * ## The measurement this exists to kill
 *
 * Live on bqb1, 2026-10-01T19:59:05Z (RTH), `/api/health/quotes`:
 *
 * ```
 * tradierQuotaBudget.upstream.refusalByClass.timesales
 *   lastRefusalStatus  400
 *   lastRefusalReason  "Invalid parameter, ^TNX: symbol not found."
 *   refusalsSinceBoot  29084          ← 25363 @16:35Z → 29084 @19:59Z = 18.3/min
 * ```
 *
 * against `meteredMeanUsedReqPerMin 64.7` of an `accountBudgetReqPerMin 120` whose
 * `meteredPeakUsedReqPerMin` is pinned at **120** — the entitlement ceiling. So
 * ~28% of metered Tradier spend was requests that **cannot** succeed. The
 * `refusalByClass` fold that produced that number is TRA-4919's; before it the
 * vendor reason was dropped at the transport boundary and this storm was
 * invisible. ⛔ It is NOT quota: the `quotes` class carries a genuine
 * `Quota Violation` **89** times since the same boot, against 29,084 bad-symbol
 * `400`s on `timesales`. Quota is the 0.3% term.
 *
 * Every offender is a **Yahoo-universe symbol sent to Tradier**. The 20-row
 * refusal ring at 19:59:05Z, by class:
 *
 * | class                     | ring rows | examples                        |
 * |---------------------------|-----------|---------------------------------|
 * | `^`-prefixed index        | 9 / 20    | `^TNX` ×6, `^VIX` ×3            |
 * | `.`-suffixed foreign      | 6 / 20    | `EVO.ST`, `ARX.TO` ×3, `VDY.TO` |
 * | delisted / unknown US     | 5 / 20    | `BBBY`, `APGE`, `SBLX`          |
 *
 * ⚠️ **The per-symbol split is a SAMPLE, not a rate.** The ring caps at 20 rows
 * and an 18/min storm refills it in about a minute, so "`^TNX` is 68% of the
 * ring" (the issue's earlier read) and "`^TNX` is 30% of the ring" (this one) are
 * the same storm sampled twice. Grade a remedy on `refusalsSinceBoot` growth —
 * the monotonic figure — never on the ring's composition.
 *
 * ## Two layers, and why it is two
 *
 * 1. **Structural reject** ({@link tradierStructuralReason}) — pure, free, and
 *    decided from the symbol's SHAPE. Tradier has no `^`-prefixed index symbols
 *    and no `.`-suffixed foreign listings; those requests are guaranteed `400`
 *    before they are sent. Covers 15 of the 20 ring rows.
 * 2. **Negative cache** ({@link noteTradierSymbolNotFound}) — a per-symbol
 *    `400 symbol not found` is a DURABLE fact about the vendor's universe, not a
 *    transient. One request per {@link TRADIER_NOT_FOUND_TTL_MS} instead of one
 *    per sweep. This is the layer that catches the remaining 5 rows, and it is
 *    the general mechanism: `APGE` is a live US listing that Tradier's
 *    `timesales` route still refuses, so no shape rule would ever have found it.
 *
 * The structural layer is deliberately the CONSERVATIVE one. A filter that
 * suppresses too much satisfies the acceptance bar perfectly and silently un-
 * prices live rows — the failure mode the ticket names. So a single-letter dot
 * suffix is **admitted**: `BRK.B` (US class share) and `AZN.L` (London) are
 * indistinguishable by shape, and the negative cache learns the London one at a
 * cost of one request per TTL. Zero false rejects on the structural layer is the
 * property that matters; completeness is layer 2's job.
 *
 * ## Scope: the BAR paths, not the quote path
 *
 * Wired into `fetchTradierMinuteBars` (`timesales`) and
 * `fetchTradierDailyCandles` (`history`) in `yahoo-feed.ts`, and nowhere else.
 *
 *  - 100% of the measured storm is `timesales`. The `history` class has **4**
 *    refusals since the same boot, all one gateway timeout.
 *  - The quote path costs **one** request for the whole batch and Tradier answers
 *    it `200` with an `unmatched_symbols` list, so there is no spend to reclaim
 *    there — and it already has `unservable-symbols.ts` plus
 *    `TRADIER_SYMBOL_ALIASES` (`^VIX`→`VIX`, `^IXIC`→`COMP:GIDS`) making
 *    `^`-prefixed quotes actually work. A structural `^` reject on that path
 *    would BREAK a working read. The alias map is request-scoped to
 *    `getQuotes`/`getQuotesDetailed` and is not applied by `getMinuteBars`, which
 *    is precisely why the bar path refuses `^VIX` while the quote path serves it.
 *
 * ## This is not `unservable-symbols.ts`, and must not become it
 *
 * That module marks "**no** quote source served it" and skips the symbol's
 * ENTIRE cascade. Its own header warns that Tradier's verdict alone is not
 * sufficient grounds, because `ARX.TO` / `2330.TW` are unmatched by Tradier on
 * every tick and priced perfectly well by Yahoo. This module records the
 * narrower, provider-scoped fact — "**Tradier** cannot serve this symbol" — and
 * suppresses only the TRADIER LEG. The Yahoo and Twelve-Data legs below it still
 * run, so no symbol loses coverage by being in here; it loses a guaranteed `400`.
 * That is also why there is no active-interest veto: re-asking Tradier for a
 * symbol it does not know cannot help a held position, and the fallback that
 * actually prices it is untouched.
 *
 * ## A suppression ships a counter
 *
 * {@link getTradierSymbolAdmissibilityState} is **always** emitted on
 * `/api/health/quotes` under `results.tradierQuotaBudget.admissibility`, and it
 * carries `evaluations` — how many times the gate was CONSULTED. "Nothing is
 * suppressed because nothing is bad" reads `evaluations > 0, suppressed 0`; "the
 * gate never ran" reads `evaluations 0`. ⛔ A reader must assert the block's
 * PRESENCE and never `?? 0` it: absent means the deploy predates this change,
 * which is a different fact from zero.
 */

import type { TradierEndpointClass } from '@trading-app/engine';

/**
 * How long a `symbol not found` verdict suppresses that symbol's Tradier leg
 * before it is re-probed.
 *
 * 6h, matching `UNSERVABLE_TTL_MS`: long enough that a delisted `BBBY` costs ~4
 * requests a day instead of ~2,880 (one per 30s tick per call site per engine),
 * short enough that a re-listing, a new Tradier coverage add, or a vendor-side
 * data glitch is picked back up the same session. Hours, not minutes — the
 * ticket's words — because the fact is durable.
 */
export const TRADIER_NOT_FOUND_TTL_MS = 6 * 60 * 60_000;

/**
 * Hard cap on negative-cache membership, so a discovery path that injects
 * thousands of junk tickers cannot grow this map without bound.
 *
 * Eviction prefers already-expired entries and only then the entry closest to
 * expiry (the TTL is constant, so that is the oldest insert). `evictions` is
 * published: an eviction means a hot entry may have been dropped early and the
 * suppression is no longer complete, which must be visible rather than inferred.
 */
export const TRADIER_NEGATIVE_CACHE_CAP = 512;

/** Why a symbol's Tradier leg was suppressed. */
export type TradierInadmissibleReason =
  /** Shape: `^`/`$`-prefixed index spelling. Tradier has no such symbols. */
  | 'index_prefix'
  /** Shape: `.`-suffixed foreign listing (`2330.TW`, `EVO.ST`, `ARX.TO`). */
  | 'foreign_suffix'
  /** Learned: Tradier itself answered `400 … symbol not found` within the TTL. */
  | 'symbol_not_found';

/**
 * US class-share suffixes that must NOT be read as a foreign listing.
 *
 * Single letters only, and deliberately not exhaustive in the other direction:
 * `.L` (London) and `.T` (Tokyo) are single-letter FOREIGN suffixes and are
 * admitted by this list. That is the intended trade — see the module header on
 * why the structural layer errs toward admitting.
 */
export const US_CLASS_SHARE_SUFFIXES: ReadonlySet<string> = new Set(['A', 'B', 'C', 'U', 'V', 'W']);

/**
 * The shape test. Pure, total, and the only place the shape rules live.
 *
 * Returns the reason this symbol can never be served by Tradier, or `null` when
 * the shape says nothing — which is the answer for every ordinary US ticker and
 * is NOT a claim that Tradier will serve it (that is what layer 2 learns).
 */
export function tradierStructuralReason(
  symbol: string,
): Exclude<TradierInadmissibleReason, 'symbol_not_found'> | null {
  const s = (symbol ?? '').trim().toUpperCase();
  if (s === '') return null;
  if (s.startsWith('^') || s.startsWith('$')) return 'index_prefix';
  const dot = s.lastIndexOf('.');
  if (dot > 0 && dot < s.length - 1) {
    // A 2+ character alphabetic suffix is an exchange code (`TW`, `ST`, `NS`,
    // `TO`, `BA`, `PA`, `DE`, `HK`, `AX`, …) and is rejected. A SINGLE letter is
    // admitted: every member of {@link US_CLASS_SHARE_SUFFIXES} is a US class
    // share Tradier does serve, and the single-letter foreign codes that share
    // the shape (`.L` London, `.T` Tokyo) are left to the negative cache rather
    // than risk un-pricing `BRK.B`. See the module header.
    if (/^[A-Z]{2,4}$/.test(s.slice(dot + 1))) return 'foreign_suffix';
  }
  return null;
}

/**
 * Does this error message carry Tradier's own `symbol not found` verdict?
 *
 * Keyed on the vendor's phrasing as measured live — `Tradier timesales(^TNX)
 * HTTP 400: {"errors":{"error":"Invalid parameter, ^TNX: symbol not found."}}`
 * — via the message `observeAndAssertOk` builds in `stocks-client.ts`. Matching
 * on the phrase and not on the bare `400` is load-bearing: a `400` is also how
 * Tradier reports a `Quota Violation`, and those two have opposite remedies.
 * That is the ambiguity TRA-4919 existed to remove; do not re-introduce it here.
 */
export function isTradierSymbolNotFound(msg: string): boolean {
  return /symbol not found/i.test(msg ?? '');
}

interface NegativeEntry {
  reason: 'symbol_not_found';
  /** ms epoch the suppression lapses. */
  expiresAtMs: number;
  /** Which Tradier class produced the verdict (diagnostic only — the fact is per symbol). */
  learnedFrom: TradierEndpointClass;
  /** Requests this entry has suppressed since it was (re)inserted. */
  suppressedHits: number;
}

const negativeCache = new Map<string, NegativeEntry>();

// ── Liveness counters, monotonic since boot ──────────────────────────────────
// A zero must have a failing state. See the module header, last section.
let evaluations = 0;
let structuralSkips = 0;
let structuralSkipsByReason: Record<'index_prefix' | 'foreign_suffix', number> = {
  index_prefix: 0,
  foreign_suffix: 0,
};
let negativeCacheSkips = 0;
let notFoundObserved = 0;
let negativeCacheInserts = 0;
let negativeCacheRefreshes = 0;
let negativeCacheExpiries = 0;
let negativeCacheRecoveries = 0;
let negativeCacheEvictions = 0;
let lastSuppressed: { symbol: string; reason: TradierInadmissibleReason; endpointClass: TradierEndpointClass; atMs: number } | null = null;

function normalize(symbol: string): string {
  return (symbol ?? '').trim().toUpperCase();
}

/** Drop a lapsed entry so a re-probe goes through the ordinary path. */
function pruneEntry(key: string, entry: NegativeEntry, now: number): NegativeEntry | null {
  if (now < entry.expiresAtMs) return entry;
  negativeCache.delete(key);
  negativeCacheExpiries++;
  console.info(
    `[tradier-admissibility] ${key}: ${Math.round(TRADIER_NOT_FOUND_TTL_MS / 60_000)}m not-found window lapsed after suppressing ${entry.suppressedHits} request(s) — re-probing Tradier`,
  );
  return null;
}

/**
 * The gate. Call it immediately before a per-symbol Tradier bar request, and do
 * not bump any spend counter when it refuses — an unsent request must not appear
 * in the local meter.
 *
 * `admitted: false` means "route this symbol to the fallback chain"; it never
 * means "drop the symbol".
 */
export function admitTradierSymbol(
  symbol: string,
  endpointClass: TradierEndpointClass,
  now: number = Date.now(),
): { admitted: boolean; reason: TradierInadmissibleReason | null; expiresAtMs: number | null } {
  evaluations++;
  const key = normalize(symbol);
  const structural = tradierStructuralReason(key);
  if (structural !== null) {
    structuralSkips++;
    structuralSkipsByReason[structural]++;
    lastSuppressed = { symbol: key, reason: structural, endpointClass, atMs: now };
    // Structural rejects never expire — the shape does not change.
    return { admitted: false, reason: structural, expiresAtMs: null };
  }
  const existing = negativeCache.get(key);
  if (existing === undefined) return { admitted: true, reason: null, expiresAtMs: null };
  const live = pruneEntry(key, existing, now);
  if (live === null) return { admitted: true, reason: null, expiresAtMs: null };
  live.suppressedHits++;
  negativeCacheSkips++;
  lastSuppressed = { symbol: key, reason: 'symbol_not_found', endpointClass, atMs: now };
  return { admitted: false, reason: 'symbol_not_found', expiresAtMs: live.expiresAtMs };
}

/**
 * Record Tradier's own `symbol not found` verdict for `symbol`.
 *
 * Idempotent per TTL: a repeat verdict (the TTL re-probe confirming the symbol is
 * still unknown) REFRESHES the window rather than stacking, so a permanently
 * dead ticker settles at one request per TTL rather than drifting back toward one
 * per sweep.
 */
export function noteTradierSymbolNotFound(
  symbol: string,
  endpointClass: TradierEndpointClass,
  now: number = Date.now(),
): void {
  const key = normalize(symbol);
  if (key === '') return;
  notFoundObserved++;
  const existing = negativeCache.get(key);
  if (existing !== undefined) {
    existing.expiresAtMs = now + TRADIER_NOT_FOUND_TTL_MS;
    existing.learnedFrom = endpointClass;
    negativeCacheRefreshes++;
    return;
  }
  negativeCache.set(key, {
    reason: 'symbol_not_found',
    expiresAtMs: now + TRADIER_NOT_FOUND_TTL_MS,
    learnedFrom: endpointClass,
    suppressedHits: 0,
  });
  negativeCacheInserts++;
  console.warn(
    `[tradier-admissibility] ${key}: Tradier ${endpointClass} answered "symbol not found" — suppressing its Tradier leg for ${Math.round(TRADIER_NOT_FOUND_TTL_MS / 60_000)}m (fallback chain unaffected)`,
  );
  enforceCap(now);
}

/**
 * Record that Tradier DID serve `symbol`. Clears any suppression — one good
 * response is proof, whatever the history says. Recovery is unconditional and is
 * the default, not a special case.
 */
export function noteTradierSymbolServed(symbol: string): void {
  const key = normalize(symbol);
  if (!negativeCache.delete(key)) return;
  negativeCacheRecoveries++;
  console.info(`[tradier-admissibility] ${key}: Tradier served it again — suppression cleared`);
}

/** Bound membership. Expired entries go first; then the entry closest to expiry. */
function enforceCap(now: number): void {
  if (negativeCache.size <= TRADIER_NEGATIVE_CACHE_CAP) return;
  for (const [key, entry] of negativeCache) {
    if (negativeCache.size <= TRADIER_NEGATIVE_CACHE_CAP) return;
    if (now >= entry.expiresAtMs) {
      negativeCache.delete(key);
      negativeCacheExpiries++;
    }
  }
  while (negativeCache.size > TRADIER_NEGATIVE_CACHE_CAP) {
    let victim: string | null = null;
    let soonest = Infinity;
    for (const [key, entry] of negativeCache) {
      if (entry.expiresAtMs < soonest) {
        soonest = entry.expiresAtMs;
        victim = key;
      }
    }
    if (victim === null) return;
    negativeCache.delete(victim);
    negativeCacheEvictions++;
    console.warn(
      `[tradier-admissibility] negative cache at cap ${TRADIER_NEGATIVE_CACHE_CAP} — evicted ${victim}; its Tradier leg will be re-probed and may refuse again`,
    );
  }
}

export interface TradierSymbolAdmissibilityState {
  /** Times the gate was CONSULTED. `0` ⇒ the gate never ran — not "nothing bad". */
  evaluations: number;
  /** Requests NOT sent to Tradier because of this gate. The reclaimed-spend figure. */
  suppressed: number;
  /** The `suppressed` split, so a moved number is attributable to a layer. */
  structuralSkips: number;
  structuralSkipsByReason: Record<'index_prefix' | 'foreign_suffix', number>;
  negativeCacheSkips: number;
  /** `400 … symbol not found` verdicts observed (inserts + refreshes). */
  notFoundObserved: number;
  negativeCacheInserts: number;
  negativeCacheRefreshes: number;
  negativeCacheExpiries: number;
  /** Symbols Tradier started serving again — the non-permanence of the mark. */
  negativeCacheRecoveries: number;
  /** >0 ⇒ the cap dropped entries and the suppression is no longer complete. */
  negativeCacheEvictions: number;
  negativeCacheSize: number;
  negativeCacheCap: number;
  ttlMs: number;
  /** Current membership, newest-expiring last. Bounded by the cap above. */
  negativeCacheSymbols: Array<{
    symbol: string;
    learnedFrom: TradierEndpointClass;
    expiresInMs: number;
    suppressedHits: number;
  }>;
  lastSuppressed: { symbol: string; reason: TradierInadmissibleReason; endpointClass: TradierEndpointClass; ageMs: number } | null;
  /** Names what this gate does and does not cover, so a reader cannot over-read it. */
  scope: 'tradier_bar_paths_only';
}

/**
 * The health block. **Always emitted** — readers assert presence, never `?? 0`.
 */
export function getTradierSymbolAdmissibilityState(
  now: number = Date.now(),
): TradierSymbolAdmissibilityState {
  const symbols: TradierSymbolAdmissibilityState['negativeCacheSymbols'] = [];
  for (const [symbol, entry] of negativeCache) {
    symbols.push({
      symbol,
      learnedFrom: entry.learnedFrom,
      expiresInMs: entry.expiresAtMs - now,
      suppressedHits: entry.suppressedHits,
    });
  }
  symbols.sort((a, b) => a.expiresInMs - b.expiresInMs || a.symbol.localeCompare(b.symbol));
  return {
    evaluations,
    suppressed: structuralSkips + negativeCacheSkips,
    structuralSkips,
    structuralSkipsByReason: { ...structuralSkipsByReason },
    negativeCacheSkips,
    notFoundObserved,
    negativeCacheInserts,
    negativeCacheRefreshes,
    negativeCacheExpiries,
    negativeCacheRecoveries,
    negativeCacheEvictions,
    negativeCacheSize: negativeCache.size,
    negativeCacheCap: TRADIER_NEGATIVE_CACHE_CAP,
    ttlMs: TRADIER_NOT_FOUND_TTL_MS,
    negativeCacheSymbols: symbols,
    lastSuppressed:
      lastSuppressed === null
        ? null
        : {
            symbol: lastSuppressed.symbol,
            reason: lastSuppressed.reason,
            endpointClass: lastSuppressed.endpointClass,
            ageMs: now - lastSuppressed.atMs,
          },
    scope: 'tradier_bar_paths_only',
  };
}

/** Test seam — forget every entry and zero every counter. */
export function __resetTradierSymbolAdmissibilityForTests(): void {
  negativeCache.clear();
  evaluations = 0;
  structuralSkips = 0;
  structuralSkipsByReason = { index_prefix: 0, foreign_suffix: 0 };
  negativeCacheSkips = 0;
  notFoundObserved = 0;
  negativeCacheInserts = 0;
  negativeCacheRefreshes = 0;
  negativeCacheExpiries = 0;
  negativeCacheRecoveries = 0;
  negativeCacheEvictions = 0;
  lastSuppressed = null;
}
