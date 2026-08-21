/**
 * TRA-3804 (measure 1 of TRA-3800) — a *re-checkable* skip list for equity
 * symbols that no quote source can serve.
 *
 * ## What it is for
 *
 * bqb1's live tape at 2026-08-16T18:11Z showed `SBLX` and `SELX` (both delisted)
 * taking the full Yahoo `withRetry` ladder on **every** tick:
 *
 *     attempt 1 → sleep 1000ms → attempt 2 → sleep 2000ms → attempt 3 → fail
 *
 * i.e. ~3s of wall-clock *sleep* per dead symbol per tick, and then a Stooq call
 * that 404s. Those ladders run inside `doTick`'s `quote-batch` phase — the same
 * phase the tape recorded at `durationMs 8184`. This module lets that work be
 * skipped, on the box that routes real money.
 *
 * ## The three things it must NOT be
 *
 * 1. **It must not be a permanent denylist.** A permanent denylist is how a live
 *    position ends up unpriced. Every mark carries an expiry
 *    ({@link UNSERVABLE_TTL_MS}); when it lapses the entry is *deleted*, so the
 *    symbol goes back through the ordinary cascade and has to re-earn its way
 *    onto the list. Recovery is the default, not a special case.
 *
 * 2. **It must not shrink the universe on a weaker signal than "nothing served
 *    it".** Tradier's `unmatched_symbols` alone is NOT sufficient: ~24 foreign
 *    tickers (`AZN.L`, `ARX.TO`, `2330.TW`, …) are unmatched by the *primary*
 *    every single tick and are priced perfectly well by the Yahoo secondary.
 *    Marking on the primary's verdict alone would silently un-price two dozen
 *    live rows. The caller must therefore only call
 *    {@link recordUnservableAttempt} when the **entire** cascade
 *    (tradier → yahoo quote → yahoo chart → stooq) ran to completion and
 *    produced nothing — see `fetchQuotes` in `yahoo-feed.ts` for the exact
 *    conditions, which also exclude every breaker/budget short-circuit (those
 *    are outages, not delistings).
 *
 * 3. **It must not read the same whether it is working or dead.** A suppression
 *    ships a counter (the standing rule). {@link getUnservableSymbolState} is
 *    always present on the health payload, and it carries `evaluations` — the
 *    number of times the gate was *consulted*. "Nothing is skipped because
 *    nothing is dead" reads `evaluations > 0, skippedCount 0`; "the skip path
 *    never ran" reads `evaluations 0`. Callers must assert the block's
 *    **presence**, never `?? 0` it.
 *
 * Prior art on the crypto side: `crypto-live-account.ts` carries a
 * delisted/renamed catalogue keyed off Coinbase's own product list. Equities had
 * no equivalent; this is it, with a TTL rather than a catalogue because there is
 * no equity-side product list to diff against.
 */

/**
 * How long a marked symbol stays skipped before it is re-probed.
 *
 * 6h: long enough that a permanently dead ticker costs ~4 cascades a day instead
 * of ~2,880 (one per 30s tick), short enough that a symbol which starts serving
 * again — a trading halt lifting, a re-listing, a provider outage that outlived
 * the breaker cooldown — is priced again the same session.
 */
export const UNSERVABLE_TTL_MS = 6 * 60 * 60_000;

/**
 * Consecutive definitive full-cascade failures before a symbol is skipped.
 *
 * >1 so that a single unlucky tick (every provider timing out at once) cannot
 * pin a live symbol for a whole TTL. The strike counter is what makes the
 * evidence "twice, recently", not "once, ever".
 */
export const UNSERVABLE_STRIKES = 2;

/**
 * Strikes older than this are stale evidence and are discarded. Without it a
 * failure in August and a failure in October would compound into a mark, which
 * is not what "consecutive" means.
 */
export const UNSERVABLE_STRIKE_WINDOW_MS = 60 * 60_000;

interface UnservableEntry {
  /** Definitive full-cascade failures observed inside the strike window. */
  strikes: number;
  /** When the symbol crossed {@link UNSERVABLE_STRIKES}; null while still accruing. */
  markedAt: number | null;
  /** When the most recent failure was recorded (drives strike-window decay). */
  lastFailureAt: number;
}

const registry = new Map<string, UnservableEntry>();

// ── Liveness counters (monotonic since boot) ─────────────────────────────────
// These exist so a zero `skippedCount` has a failing state. See the module
// header, point 3.
let evaluations = 0;
let skips = 0;
let marks = 0;
let recoveries = 0;
let expiries = 0;
let protectedDeclines = 0;

/** Drop an entry whose mark has aged past the TTL, or whose strikes went stale. */
function pruneEntry(symbol: string, entry: UnservableEntry, now: number): UnservableEntry | null {
  if (entry.markedAt !== null) {
    if (now - entry.markedAt < UNSERVABLE_TTL_MS) return entry;
    // TTL lapsed: forget it entirely rather than merely un-marking it, so the
    // symbol must re-earn UNSERVABLE_STRIKES failures before it is skipped
    // again. A half-remembered entry would re-mark on the first blip.
    registry.delete(symbol);
    expiries++;
    console.info(
      `[unservable-symbols] ${symbol}: skip window lapsed after ${Math.round(UNSERVABLE_TTL_MS / 60_000)}m — re-probing through the full quote cascade`,
    );
    return null;
  }
  if (now - entry.lastFailureAt > UNSERVABLE_STRIKE_WINDOW_MS) {
    registry.delete(symbol);
    return null;
  }
  return entry;
}

/**
 * Record one *definitive* full-cascade failure for `symbol`.
 *
 * ⚠ The caller owns the word "definitive". Do not call this for a breaker
 * short-circuit, a fan-out budget truncation, or a symbol the primary simply
 * did not return — see the module header, point 2.
 *
 * Returns the resulting strike count and whether THIS call crossed the
 * threshold, so the caller can log the transition once instead of per tick.
 */
export function recordUnservableAttempt(
  symbol: string,
  now: number = Date.now(),
): { strikes: number; marked: boolean; alreadyMarked: boolean } {
  const existing = registry.get(symbol);
  const live = existing ? pruneEntry(symbol, existing, now) : null;
  if (live !== null && live.markedAt !== null) {
    // Already skipped; a failure here means a TTL re-probe confirmed it is still
    // dead. Refresh the mark so the next re-probe is a full TTL away.
    live.markedAt = now;
    live.lastFailureAt = now;
    return { strikes: live.strikes, marked: false, alreadyMarked: true };
  }
  const entry: UnservableEntry = live ?? { strikes: 0, markedAt: null, lastFailureAt: now };
  entry.strikes += 1;
  entry.lastFailureAt = now;
  const marked = entry.strikes >= UNSERVABLE_STRIKES;
  if (marked) {
    entry.markedAt = now;
    marks++;
    console.warn(
      `[unservable-symbols] ${symbol}: no quote source served it on ${entry.strikes} consecutive attempts — skipping its fetch cascade for ${Math.round(UNSERVABLE_TTL_MS / 60_000)}m (re-probed after that)`,
    );
  }
  registry.set(symbol, entry);
  return { strikes: entry.strikes, marked, alreadyMarked: false };
}

/**
 * Record that `symbol` was served a real quote. Clears any strikes and any mark
 * — this is the recovery path, and it is unconditional: one good print is proof
 * the symbol is servable, whatever the history says.
 */
export function recordServableSymbol(symbol: string): void {
  const entry = registry.get(symbol);
  if (!entry) return;
  registry.delete(symbol);
  if (entry.markedAt !== null) {
    recoveries++;
    console.info(`[unservable-symbols] ${symbol}: served a quote again — removed from the skip list`);
  }
}

/**
 * The gate. `true` means "do not spend a fetch cascade on this symbol now".
 *
 * `isProtected` is the caller's veto and is checked AFTER the mark is resolved,
 * so a protected symbol still shows up in `skippedSymbols` while never actually
 * being skipped — `protectedDeclines` counts those. `yahoo-feed` passes its
 * active-interest predicate here, which is the set the signal engine asserts
 * each tick for symbols with **open positions or recent signals**: the skip can
 * therefore never reach a symbol a position depends on, structurally and on
 * every tick, rather than by a one-time audit.
 */
export function shouldSkipUnservable(
  symbol: string,
  isProtected: boolean,
  now: number = Date.now(),
): boolean {
  evaluations++;
  const existing = registry.get(symbol);
  if (!existing) return false;
  const live = pruneEntry(symbol, existing, now);
  if (live === null || live.markedAt === null) return false;
  if (isProtected) {
    protectedDeclines++;
    return false;
  }
  skips++;
  return true;
}

/** The symbols currently marked un-servable (sorted, full membership). */
export function unservableSymbols(now: number = Date.now()): string[] {
  const out: string[] = [];
  for (const [symbol, entry] of registry) {
    if (entry.markedAt !== null && now - entry.markedAt < UNSERVABLE_TTL_MS) out.push(symbol);
  }
  return out.sort();
}

/**
 * The health-route block. **Always emitted**; readers must assert its presence
 * rather than defaulting it — an absent block means the deploy predates this
 * change, which is a different fact from "nothing is being skipped".
 */
export function getUnservableSymbolState(now: number = Date.now()): {
  /** Symbols currently on the skip list. */
  skippedCount: number;
  skippedSymbols: string[];
  /** Symbols accruing strikes but not yet skipped — the detector working. */
  trackedCount: number;
  ttlMs: number;
  strikesToMark: number;
  /** Times the gate was consulted. `0` ⇒ the skip path never ran. */
  evaluations: number;
  /** Times the gate actually suppressed a fetch cascade. */
  skips: number;
  marks: number;
  recoveries: number;
  expiries: number;
  /** Times a mark was overridden because the symbol was active-interest. */
  protectedDeclines: number;
  oldestMarkAgeMs: number | null;
} {
  let trackedCount = 0;
  let oldestMarkedAt: number | null = null;
  const skippedSymbols: string[] = [];
  for (const [symbol, entry] of registry) {
    if (entry.markedAt !== null) {
      if (now - entry.markedAt >= UNSERVABLE_TTL_MS) continue; // lapsed, awaiting prune
      skippedSymbols.push(symbol);
      if (oldestMarkedAt === null || entry.markedAt < oldestMarkedAt) oldestMarkedAt = entry.markedAt;
    } else if (now - entry.lastFailureAt <= UNSERVABLE_STRIKE_WINDOW_MS) {
      trackedCount++;
    }
  }
  skippedSymbols.sort();
  return {
    skippedCount: skippedSymbols.length,
    skippedSymbols,
    trackedCount,
    ttlMs: UNSERVABLE_TTL_MS,
    strikesToMark: UNSERVABLE_STRIKES,
    evaluations,
    skips,
    marks,
    recoveries,
    expiries,
    protectedDeclines,
    oldestMarkAgeMs: oldestMarkedAt === null ? null : now - oldestMarkedAt,
  };
}

/** Test seam — forget every entry and zero every counter. */
export function __resetUnservableSymbolsForTests(): void {
  registry.clear();
  evaluations = 0;
  skips = 0;
  marks = 0;
  recoveries = 0;
  expiries = 0;
  protectedDeclines = 0;
}
