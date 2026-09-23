import { prioritizeQuoteUniverse, type QuotePriorityInput } from './quote-priority.js';

/**
 * TRA-4830 — bound the REST polling universe to what the Tradier account
 * entitlement can actually serve.
 *
 * ## Why this module exists
 *
 * On 2026-09-23 the tracked universe stood at **782 symbols** — a 25-name
 * curated base (`WATCHLIST`) plus an unbounded `dynamicSymbols` discovery tail —
 * and drove a measured **714.6 req/min mean (peak 1,309)** of per-symbol REST
 * demand against the account's **120 req/fixed-minute** budget (Tradier's own
 * X-Ratelimit headers, `quotes` and `history` buckets agreeing). ~6.0x over.
 * The causal chain that followed is the TRA-4826 incident: Tradier breaker
 * cycling on quota → the whole remainder fanning out to Yahoo → Yahoo crumb
 * 429s → Yahoo breaker open → the SMA-200 sweep starving under
 * `isYahooBreakerOpen()` (21,794/21,794 skipped, `evaluated: 0`) → zero
 * signals, zero cards. No instrument fix changes that arithmetic; the polling
 * path has to fit its entitlement.
 *
 * The per-symbol bar/timesales pulls are what scale with the universe (679 of
 * the 715 req/min); the batched quote path has a structural floor of only
 * ~3 req/min. So the bound is applied where the universe is derived —
 * `SignalEngine.getActiveSymbols()` — and every per-symbol consumer downstream
 * (cold-bar scan, SMA-200 entry sweep, MTF, supertrend shadow, news fan-out)
 * inherits it.
 *
 * ## This is the same sizing decision as the stream cap
 *
 * TRA-4656 bounded the WEBSOCKET subscription at `DEFAULT_STREAM_SYMBOL_LIMIT`
 * (25). This module bounds the REST side, and the two are one decision, not
 * two: the stream set is selected out of the fleet union of *bounded* scan
 * universes, so subscription ⊆ polled universe holds by construction, and the
 * stream default must stay ≤ the scan default (asserted in the test file).
 */
export const TRADIER_SCAN_SYMBOL_LIMIT_ENV = 'TRADIER_SCAN_SYMBOL_LIMIT';

/**
 * TRA-4830 — the default polling-universe bound, and the arithmetic behind it.
 *
 * Observed per-symbol demand at the 782-symbol universe was ~0.91 req/min/symbol
 * (714.6 / 782, all per-symbol paths included). Against the 120 req/min account
 * budget the zero-headroom ceiling is ~130 symbols — a default AT the ceiling
 * would sit permanently on the breaker edge this bound exists to leave, with
 * nothing spare for the batched quote path, balance/history reads, or peak
 * minutes (observed peak/mean ratio ~1.8x). 100 symbols ⇒ ~91 req/min mean,
 * ~76% of budget, ~29 req/min headroom.
 *
 * Deliberately NOT recovered by arming TRA-3104's budget gate instead: its own
 * payload read `ceilingUnsatisfiable: true` at the 782-symbol demand — the
 * quote reservation alone exceeded the whole budget, so the derived bar ceiling
 * clamped to 1 req/min and the sweep would have starved on deferral instead of
 * breaker. A right-sized universe is what makes that gate armable at all.
 */
export const DEFAULT_SCAN_SYMBOL_LIMIT = 100;

/** The documented opt-out: `TRADIER_SCAN_SYMBOL_LIMIT=none` polls the full universe. */
export const SCAN_SYMBOL_LIMIT_OPT_OUT = 'none';

export interface ScanSymbolLimit {
  /** The cap actually applied, or `null` for "no cap" — the full universe. */
  limit: number | null;
  /** Exactly what the env var held, `null` when unset — the limit's provenance is never ambiguous. */
  raw: string | null;
  /**
   * Why a present value was not honoured. A garbage value must NOT read the
   * same as an unset one: both fall back to the default cap, and only this
   * field tells them apart.
   */
  error: string | null;
}

/**
 * Parse {@link TRADIER_SCAN_SYMBOL_LIMIT_ENV}.
 * Unset ⇒ {@link DEFAULT_SCAN_SYMBOL_LIMIT}; `none` ⇒ explicitly uncapped;
 * unparseable ⇒ the default cap **plus an error** — after TRA-4826 named the
 * unbounded universe as the all-breakers-open branch, garbage must fail closed
 * into a bounded scan, never open into the known-bad one. Same contract as
 * `resolveStreamSymbolLimit` (TRA-4656), on purpose.
 */
export function resolveScanSymbolLimit(env: NodeJS.ProcessEnv = process.env): ScanSymbolLimit {
  const rawValue = env[TRADIER_SCAN_SYMBOL_LIMIT_ENV];
  if (rawValue == null || rawValue.trim() === '') {
    return { limit: DEFAULT_SCAN_SYMBOL_LIMIT, raw: rawValue ?? null, error: null };
  }
  const raw = rawValue.trim();
  if (raw.toLowerCase() === SCAN_SYMBOL_LIMIT_OPT_OUT) return { limit: null, raw, error: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return {
      limit: DEFAULT_SCAN_SYMBOL_LIMIT,
      raw,
      error: `${TRADIER_SCAN_SYMBOL_LIMIT_ENV}=${JSON.stringify(raw)} is not an integer >= 1 or "${SCAN_SYMBOL_LIMIT_OPT_OUT}" — default cap ${DEFAULT_SCAN_SYMBOL_LIMIT} applied`,
    };
  }
  return { limit: n, raw, error: null };
}

export interface ScanUniverseBound {
  /** The bounded universe, in the INPUT's original order (see below). */
  selected: string[];
  /** Deduped input size — the universe before the bound. */
  before: number;
  /** `selected.length`. */
  after: number;
  /**
   * Held/signalled rows kept PAST the numeric cap. Non-zero only when tier-0/1
   * membership alone exceeds `limit` — the bound widens rather than cut risk.
   */
  forcedBeyondLimit: number;
}

/** The counts + provenance shape the health route publishes per engine. */
export interface ScanUniverseBoundState extends ScanSymbolLimit {
  before: number;
  after: number;
  forcedBeyondLimit: number;
}

/**
 * Select the bounded polling universe.
 *
 * **Membership** comes from {@link prioritizeQuoteUniverse}'s tiers — held →
 * signalled → risk inputs → base watchlist → discovery tail — truncated at
 * `limit`, so what gets cut is the unbounded discovery tail, never the rows
 * that carry money. **Order** of the result is the input's original order:
 * `getActiveSymbols()`' historical order is the dashboard watchlist render
 * order (TRA-2643), and bounding must not also reorder it.
 *
 * Two hard guarantees:
 *   • `held`/`signalled` symbols present in `universe` are NEVER cut, even
 *     when that pushes the result past `limit` — an open position's risk must
 *     stay priced regardless of any quota bound (TRA-931), so the bound
 *     widens instead ({@link ScanUniverseBound.forcedBeyondLimit}).
 *   • `limit: null` (the explicit `none` opt-out) is the identity on the
 *     deduped input — not even a reorder.
 *
 * ⚠️ This function FILTERS — the exact thing `getQuoteFetchOrder` is forbidden
 * to do (TRA-2627: symbols silently stopping being quoted, no log line). That
 * is why the caller must surface the result loudly: the `/api/health/quotes`
 * `scanUniverseBound` block exists so a bounded universe can never read as an
 * unexplained absence.
 */
export function boundScanUniverse(
  input: QuotePriorityInput,
  limit: ScanSymbolLimit,
): ScanUniverseBound {
  // Dedupe preserving first-seen order — the same normalisation
  // prioritizeQuoteUniverse applies, done here so `before`/`selected` are
  // counts over the same multiset it ranks.
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const sym of input.universe) {
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    ordered.push(sym);
  }

  if (limit.limit == null || ordered.length <= limit.limit) {
    return { selected: ordered, before: ordered.length, after: ordered.length, forcedBeyondLimit: 0 };
  }

  const ranked = prioritizeQuoteUniverse({ ...input, universe: ordered });
  const keep = new Set(ranked.slice(0, limit.limit));
  // Never cut tier-0/1: membership is re-asserted rather than assumed from the
  // slice, so the guarantee survives any future change to the tier ordering.
  for (const sym of input.held ?? []) if (seen.has(sym)) keep.add(sym);
  for (const sym of input.signalled ?? []) if (seen.has(sym)) keep.add(sym);

  const selected = ordered.filter((sym) => keep.has(sym));
  return {
    selected,
    before: ordered.length,
    after: selected.length,
    forcedBeyondLimit: Math.max(0, selected.length - limit.limit),
  };
}
