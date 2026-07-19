/**
 * TRA-2045 — order-time quote-freshness + max-slippage guard.
 *
 * Parent: TRA-2044 (CTO slippage assessment). Two pure decision helpers plus a
 * small counted-reason registry, shared by BOTH order paths:
 *
 *  1. {@link computeMarketableLimit} — turn a signal price + a fresh L1 touch
 *     into a marketable limit bounded by a max-slippage budget. The equity
 *     submit path used to send a bracket limit at the last polled engine tick
 *     with NO slippage offset and NO at-submit re-quote; this brings it up to
 *     the standard the options smart-open walk already meets (walk a
 *     midpoint-start limit toward the ask) by pricing a single marketable limit
 *     that never pays past the max-slippage cap.
 *  2. {@link evaluateQuoteFreshness} — reject/skip an order whose quote is older
 *     than `maxQuoteAgeMs`, measured from the quote's OWN broker timestamp
 *     (Tradier `trade_date`), not the feed's local receive time.
 *
 * ## Governance — flag-guarded, default-OFF, SHADOW-first
 * The whole guard is gated on `ENABLE_ORDER_QUOTE_GUARD` (default off). With the
 * flag off there is ZERO behavior change and no extra Tradier call: the order
 * path prices its limit exactly as before. Turning the flag on enters SHADOW
 * mode — the guard re-quotes, records the counted reason + the limit it WOULD
 * have priced, but still submits at the caller's original price. Only when
 * `ORDER_QUOTE_GUARD_ENFORCE` is ALSO truthy does the guard actually apply the
 * marketable limit and skip stale-quote orders. "Land measuring before
 * enforcing" (TRA-2045 §4), same shape as the pre-trade liquidity gate.
 *
 * Live equity auto-trading is on HOLD (TRA-1897), so even enforce mode lands
 * without a live-arming decision; the guard hardens the path for the eventual
 * arm.
 *
 * Both decision functions are PURE (no clock, no I/O — `nowMs` is injected) so
 * the limit-price math and the age gate are unit-testable deterministically.
 */

export const ORDER_QUOTE_GUARD_FLAG = 'ENABLE_ORDER_QUOTE_GUARD';
export const ORDER_QUOTE_GUARD_ENFORCE_FLAG = 'ORDER_QUOTE_GUARD_ENFORCE';
export const ORDER_MAX_SLIPPAGE_FLAG = 'ORDER_MAX_SLIPPAGE';
export const ORDER_MAX_QUOTE_AGE_MS_FLAG = 'ORDER_MAX_QUOTE_AGE_MS';

/**
 * Default max-slippage budget for a marketable entry limit: 50 bps. A buy limit
 * is priced no higher than `signalPrice × (1 + 0.005)`; a sell no lower than
 * `signalPrice × (1 - 0.005)`. Deliberately conservative — the point is to cap
 * the worst fill, not to guarantee one; a quote that has run past the budget
 * produces a non-marketable limit (and, in enforce mode, may simply not fill).
 */
export const DEFAULT_ORDER_MAX_SLIPPAGE = 0.005;

/**
 * Default max quote age at submit: 5 s. The order-time gate re-quotes right
 * before submitting, so a 5 s ceiling means the limit is priced off a touch
 * that is at most a few seconds stale. Distinct from the feed-level
 * `MAX_QUOTE_AGE_MS` (5 min, feed-freshness.ts) which gates STRATEGY eval off
 * the cached tick — this is the tighter AT-SUBMIT check.
 */
export const DEFAULT_ORDER_MAX_QUOTE_AGE_MS = 5_000;

export type OrderQuoteGuardMode = 'off' | 'shadow' | 'enforce';

export interface OrderQuoteGuardConfig {
  mode: OrderQuoteGuardMode;
  maxSlippage: number;
  maxQuoteAgeMs: number;
}

function isTruthyEnv(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function positiveNumberEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the guard config from env. `ENABLE_ORDER_QUOTE_GUARD` off → mode
 * `off` (no-op). On → `shadow`, unless `ORDER_QUOTE_GUARD_ENFORCE` is also
 * truthy, then `enforce`. Slippage / age ceilings fall back to the shipped
 * defaults when unset or non-positive.
 */
export function resolveOrderQuoteGuardConfig(
  env: NodeJS.ProcessEnv = process.env,
): OrderQuoteGuardConfig {
  const enabled = isTruthyEnv(env[ORDER_QUOTE_GUARD_FLAG]);
  const mode: OrderQuoteGuardMode = !enabled
    ? 'off'
    : isTruthyEnv(env[ORDER_QUOTE_GUARD_ENFORCE_FLAG])
      ? 'enforce'
      : 'shadow';
  return {
    mode,
    maxSlippage: positiveNumberEnv(env[ORDER_MAX_SLIPPAGE_FLAG], DEFAULT_ORDER_MAX_SLIPPAGE),
    maxQuoteAgeMs: positiveNumberEnv(env[ORDER_MAX_QUOTE_AGE_MS_FLAG], DEFAULT_ORDER_MAX_QUOTE_AGE_MS),
  };
}

export interface MarketableLimitInput {
  side: 'buy' | 'sell';
  /** The engine's signal / reference price the caller would otherwise limit at. */
  signalPrice: number;
  /** Fresh L1 ask, when available (used for the buy-side touch clamp). */
  ask?: number;
  /** Fresh L1 bid, when available (used for the sell-side touch clamp). */
  bid?: number;
  /** Fractional slippage budget (e.g. 0.005 = 50 bps). Negative is treated as 0. */
  maxSlippage: number;
}

export interface MarketableLimitResult {
  /** The priced limit. Buys never exceed the cap; sells never fall below it. */
  limitPrice: number;
  /** The max-slippage bound: `signalPrice × (1 ± maxSlippage)`. */
  slippageCapPrice: number;
  /** The fresh touch used to clamp (ask for buys / bid for sells), or `null`. */
  touchPrice: number | null;
  /**
   * True when the priced limit is expected to CROSS and fill immediately: the
   * touch was reachable within the slippage budget. False when the quote has
   * run past the budget (limit sits at the cap and may not fill) or no touch
   * was available to confirm marketability.
   */
  marketable: boolean;
  /** True when the limit was pinned to the fresh touch (not the slippage cap). */
  clampedToTouch: boolean;
}

/**
 * Price a marketable entry limit bounded by a max-slippage budget.
 *
 * Buy: `cap = signalPrice × (1 + maxSlippage)`. When a fresh ask is available
 * the limit is `min(ask, cap)` — pay the ask (crosses, fills) as long as it's
 * within budget, otherwise sit at the cap. Never bid above the ask (no point)
 * and never above the cap. Sell mirrors: `cap = signalPrice × (1 - maxSlippage)`
 * and the limit is `max(bid, cap)`.
 *
 * When the relevant touch is missing/invalid the limit falls back to the
 * slippage cap and `marketable` is false (we can't confirm the limit crosses).
 * Pure: no rounding here — the caller rounds to the instrument's tick.
 */
export function computeMarketableLimit(input: MarketableLimitInput): MarketableLimitResult {
  const slip = Number.isFinite(input.maxSlippage) && input.maxSlippage > 0 ? input.maxSlippage : 0;
  const signalPrice = input.signalPrice;

  if (input.side === 'buy') {
    const cap = signalPrice * (1 + slip);
    const ask = typeof input.ask === 'number' && Number.isFinite(input.ask) && input.ask > 0 ? input.ask : null;
    if (ask === null) {
      return { limitPrice: cap, slippageCapPrice: cap, touchPrice: null, marketable: false, clampedToTouch: false };
    }
    // min(ask, cap): reach the ask when it's within budget, else stop at the cap.
    const limitPrice = Math.min(ask, cap);
    return {
      limitPrice,
      slippageCapPrice: cap,
      touchPrice: ask,
      marketable: ask <= cap,
      clampedToTouch: limitPrice === ask,
    };
  }

  // sell
  const cap = signalPrice * (1 - slip);
  const bid = typeof input.bid === 'number' && Number.isFinite(input.bid) && input.bid > 0 ? input.bid : null;
  if (bid === null) {
    return { limitPrice: cap, slippageCapPrice: cap, touchPrice: null, marketable: false, clampedToTouch: false };
  }
  // max(bid, cap): hit the bid when it clears the floor, else stop at the cap.
  const limitPrice = Math.max(bid, cap);
  return {
    limitPrice,
    slippageCapPrice: cap,
    touchPrice: bid,
    marketable: bid >= cap,
    clampedToTouch: limitPrice === bid,
  };
}

export interface QuoteFreshnessInput {
  /** The quote's own broker timestamp (ms epoch), or `undefined` when absent. */
  quoteTimeMs?: number;
  /** Evaluation clock (ms epoch) — injected so the gate is deterministic. */
  nowMs: number;
  /** Max acceptable quote age (ms). */
  maxQuoteAgeMs: number;
}

/** Reason a freshness check failed — a counted reason for the telemetry rollup. */
export type QuoteFreshnessReason = 'stale_quote' | 'missing_quote_timestamp';

export interface QuoteFreshnessVerdict {
  fresh: boolean;
  /** Age in ms (`nowMs - quoteTimeMs`), or `null` when no timestamp was present. */
  ageMs: number | null;
  /** Present only when `fresh` is false. */
  reason?: QuoteFreshnessReason;
}

/**
 * Decide whether a quote is fresh enough to price/submit an order against.
 *
 * A missing/invalid timestamp is NOT fresh (`missing_quote_timestamp`): we can't
 * prove the quote is recent, and refusing an unprovable quote is the
 * conservative default the gate is there to enforce. A negative age (broker
 * clock slightly ahead of ours) is treated as fresh — clock skew is not
 * staleness. Otherwise fresh iff `age ≤ maxQuoteAgeMs`.
 */
export function evaluateQuoteFreshness(input: QuoteFreshnessInput): QuoteFreshnessVerdict {
  const ts = input.quoteTimeMs;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
    return { fresh: false, ageMs: null, reason: 'missing_quote_timestamp' };
  }
  const ageMs = input.nowMs - ts;
  if (ageMs < 0) return { fresh: true, ageMs };
  if (ageMs > input.maxQuoteAgeMs) return { fresh: false, ageMs, reason: 'stale_quote' };
  return { fresh: true, ageMs };
}

// ── Counted-reason telemetry ────────────────────────────────────────────────
// A small in-memory registry so the guard can emit a COUNTED reason per order
// path (TRA-2045 §3, feeds the telemetry child). Since-boot counters; the health
// route reads the snapshot. Kept intentionally tiny — the calibration cut that
// justifies flipping enforce lives in the fee/slippage ledgers, not here.

export type OrderGuardEngine = 'equity' | 'options';

/**
 * Outcome recorded per evaluated order. `passed` = fresh quote + a marketable
 * limit priced within budget. The rest are the counted failure/degradation
 * reasons; `no_fresh_quote` covers the re-quote itself failing (network / no
 * client / empty book).
 */
export type OrderGuardOutcome =
  | 'passed'
  | 'stale_quote'
  | 'missing_quote_timestamp'
  | 'no_fresh_quote'
  | 'slippage_capped';

const counters = new Map<string, number>();

function counterKey(engine: OrderGuardEngine, outcome: OrderGuardOutcome, mode: OrderQuoteGuardMode): string {
  return `${engine}:${mode}:${outcome}`;
}

/** Record one guard outcome for the since-boot rollup. */
export function recordOrderGuardOutcome(
  engine: OrderGuardEngine,
  outcome: OrderGuardOutcome,
  mode: OrderQuoteGuardMode,
): void {
  const key = counterKey(engine, outcome, mode);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export interface OrderGuardMetricsSnapshot {
  /** Flat `engine:mode:outcome → count` map of every non-zero counter. */
  counts: Record<string, number>;
  /** Total outcomes recorded since boot. */
  total: number;
}

/** Snapshot the since-boot counters for the health route. */
export function snapshotOrderGuardMetrics(): OrderGuardMetricsSnapshot {
  const out: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of counters) {
    out[k] = v;
    total += v;
  }
  return { counts: out, total };
}

/** Test seam — reset the since-boot counters. */
export function resetOrderGuardMetricsForTests(): void {
  counters.clear();
}
