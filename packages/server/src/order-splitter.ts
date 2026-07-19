/**
 * TRA-2050 (parent TRA-2044 "how to actually reduce slippage") —
 * TWAP / participation-rate ORDER SPLITTING for larger equity orders.
 *
 * Split a would-be single stock order into scheduled child slices so a large
 * order doesn't cross the book in one clip and eat the whole spread + impact.
 * Board-funded over the CTO's defer recommendation (splitting is "NOT warranted
 * at current order size" — single-contract options / small equity), so the
 * whole feature is built to be INERT until we actually scale:
 *
 *  1. Flag-guarded, default-OFF (`ENABLE_ORDER_SPLITTING`). Off ⇒ zero behavior
 *     change, no plan computed, the order submits exactly as before.
 *  2. Notional-threshold gated (`ORDER_SPLIT_MIN_NOTIONAL`, default deliberately
 *     high). Even with the flag ON, an order whose notional is below the
 *     threshold is a single slice — a no-op at today's tiny sizes.
 *  3. Options stay SINGLE-CLIP by design (a single option contract can't be
 *     meaningfully sliced and the options path never calls this planner).
 *
 * ## What this module IS
 * The pure PLANNER + config + a small counted-reason registry. Given a total
 * share quantity and a reference price it decides whether to split and, if so,
 * produces the full child-slice SCHEDULE (qty + scheduled time offset per
 * slice) for either a TWAP (even qty over even time) or a participation-rate
 * (qty per interval capped at a fraction of interval volume) strategy. The
 * planner is fully pure/deterministic (no clock, no I/O) so the slice geometry
 * is unit-testable.
 *
 * ## What this module is NOT (yet)
 * It does NOT execute the schedule. Live equity auto-trading is on HOLD
 * (TRA-1897) and the equity sandbox carries no market data (TRA-1937), so a
 * multi-tick child-order dispatcher can't be exercised or verified today —
 * shipping an unverified live scheduler would violate "prove the instrument
 * fires". So this lands SHADOW-first: with the flag on, the equity submit path
 * computes the plan and RECORDS what it WOULD have done (counted reasons +
 * slice count), but still submits the single aggregate order unchanged. The
 * multi-tick dispatcher that reuses the TRA-2045 fresh-quote-at-submit +
 * marketable-limit walk per child order (no market-order path) is a named,
 * gated follow-up, blocked on the HOLD lift.
 *
 * The `/api/health/order-splitting` route reads the config + since-boot counters
 * so the program can see WHEN order sizes start to cross the split threshold —
 * that telemetry is the trigger to build/arm the executor.
 */

export const ORDER_SPLITTING_FLAG = 'ENABLE_ORDER_SPLITTING';
export const ORDER_SPLIT_STRATEGY_FLAG = 'ORDER_SPLIT_STRATEGY';
export const ORDER_SPLIT_MIN_NOTIONAL_FLAG = 'ORDER_SPLIT_MIN_NOTIONAL';
export const ORDER_SPLIT_CHILD_COUNT_FLAG = 'ORDER_SPLIT_CHILD_COUNT';
export const ORDER_SPLIT_INTERVAL_MS_FLAG = 'ORDER_SPLIT_INTERVAL_MS';
export const ORDER_SPLIT_MAX_PARTICIPATION_FLAG = 'ORDER_SPLIT_MAX_PARTICIPATION';

/**
 * Default notional (USD) at/above which an order is eligible to split. Set high
 * on purpose: today's live sizes are single-contract options / a few hundred
 * dollars of equity, so this keeps the feature a no-op until we scale to sizes
 * that actually move the book (the CTO's exact condition for revisiting).
 */
export const DEFAULT_ORDER_SPLIT_MIN_NOTIONAL = 50_000;

/** Default number of even child slices for the TWAP strategy. */
export const DEFAULT_ORDER_SPLIT_CHILD_COUNT = 4;

/** Default spacing between child slices (5 min). */
export const DEFAULT_ORDER_SPLIT_INTERVAL_MS = 5 * 60_000;

/**
 * Default participation cap: a child slice is at most 10% of the interval's
 * expected volume. Only used by the participation strategy and only when an
 * interval-volume estimate is supplied; otherwise the planner falls back to the
 * TWAP even split.
 */
export const DEFAULT_ORDER_SPLIT_MAX_PARTICIPATION = 0.10;

/**
 * Hard ceiling on the number of child slices any plan can produce — a runaway
 * guard so a pathological (tiny participation cap, huge order) input can't emit
 * thousands of slices. Well above any sane real schedule.
 */
export const ORDER_SPLIT_MAX_SLICES = 50;

export type OrderSplitStrategy = 'twap' | 'participation';

export interface OrderSplitConfig {
  /** `ENABLE_ORDER_SPLITTING` — off ⇒ the planner short-circuits to a single slice. */
  enabled: boolean;
  strategy: OrderSplitStrategy;
  /** Notional (USD) threshold; below this an order is never split. */
  minNotional: number;
  /** TWAP: number of even slices. */
  childCount: number;
  /** Milliseconds between consecutive child slices. */
  intervalMs: number;
  /** Participation: max fraction of interval volume per child (0–1). */
  maxParticipationRate: number;
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

/** Positive integer env (floored); non-positive / malformed ⇒ fallback. */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const n = positiveNumberEnv(raw, fallback);
  return Math.max(1, Math.floor(n));
}

/** Fraction in (0, 1]; malformed / out-of-range ⇒ fallback. */
function fractionEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

function resolveStrategy(raw: string | undefined): OrderSplitStrategy {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'participation'
    ? 'participation'
    : 'twap';
}

/** Resolve the splitter config from env. Flag off (default) ⇒ `enabled:false`. */
export function resolveOrderSplitConfig(
  env: NodeJS.ProcessEnv = process.env,
): OrderSplitConfig {
  return {
    enabled: isTruthyEnv(env[ORDER_SPLITTING_FLAG]),
    strategy: resolveStrategy(env[ORDER_SPLIT_STRATEGY_FLAG]),
    minNotional: positiveNumberEnv(env[ORDER_SPLIT_MIN_NOTIONAL_FLAG], DEFAULT_ORDER_SPLIT_MIN_NOTIONAL),
    childCount: positiveIntEnv(env[ORDER_SPLIT_CHILD_COUNT_FLAG], DEFAULT_ORDER_SPLIT_CHILD_COUNT),
    intervalMs: positiveNumberEnv(env[ORDER_SPLIT_INTERVAL_MS_FLAG], DEFAULT_ORDER_SPLIT_INTERVAL_MS),
    maxParticipationRate: fractionEnv(env[ORDER_SPLIT_MAX_PARTICIPATION_FLAG], DEFAULT_ORDER_SPLIT_MAX_PARTICIPATION),
  };
}

export interface OrderSliceInput {
  side: 'buy' | 'sell';
  /** Total shares the un-split order would submit. */
  totalQty: number;
  /** Reference price (per share) used to compute notional. */
  referencePrice: number;
  config: OrderSplitConfig;
  /**
   * Expected shares traded per {@link OrderSplitConfig.intervalMs} interval, if
   * known (used only by the participation strategy to cap child size). Absent /
   * non-positive ⇒ participation falls back to the TWAP even split.
   */
  intervalVolume?: number;
}

/** One scheduled child order. Offsets are relative to plan creation (ms). */
export interface OrderSlice {
  index: number;
  qty: number;
  /** Milliseconds after the parent decision at which this slice should submit. */
  scheduledOffsetMs: number;
}

/**
 * Why the planner produced the plan it did — a counted reason for telemetry.
 *  - `disabled` — flag off (single slice, no behavior change).
 *  - `invalid_qty` — non-positive / non-finite qty (single slice, defensive).
 *  - `below_threshold` — notional under `minNotional` (single slice).
 *  - `single_slice_config` — split eligible but the config resolves to one slice.
 *  - `split_twap` / `split_participation` — a genuine multi-slice schedule.
 *  - `participation_no_volume_twap_fallback` — participation requested but no
 *    interval-volume estimate, so the even TWAP split was used instead.
 */
export type OrderSplitReason =
  | 'disabled'
  | 'invalid_qty'
  | 'below_threshold'
  | 'single_slice_config'
  | 'split_twap'
  | 'split_participation'
  | 'participation_no_volume_twap_fallback';

export interface OrderSlicePlan {
  /** True iff the plan has more than one slice. */
  split: boolean;
  reason: OrderSplitReason;
  /** The strategy actually applied (after any participation→twap fallback). */
  strategy: OrderSplitStrategy;
  /** `totalQty × referencePrice`. */
  notional: number;
  /** The child slices. Always ≥1 and always sums to `totalQty`. */
  slices: OrderSlice[];
}

function singleSlice(totalQty: number, reason: OrderSplitReason, strategy: OrderSplitStrategy, notional: number): OrderSlicePlan {
  return {
    split: false,
    reason,
    strategy,
    notional,
    slices: [{ index: 0, qty: totalQty, scheduledOffsetMs: 0 }],
  };
}

/**
 * Distribute `totalQty` whole shares across `count` slices as evenly as
 * possible, loading the remainder onto the EARLIEST slices (get more of the
 * order in sooner). Returns integer-qty slices spaced `intervalMs` apart. Never
 * emits a zero-qty slice (if `count > totalQty` the extra empty slices are
 * dropped). Sum is always exactly `totalQty`.
 */
function evenSlices(totalQty: number, count: number, intervalMs: number): OrderSlice[] {
  const n = Math.max(1, Math.min(count, totalQty));
  const base = Math.floor(totalQty / n);
  let remainder = totalQty - base * n;
  const slices: OrderSlice[] = [];
  for (let i = 0; i < n; i++) {
    const qty = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    if (qty <= 0) continue;
    slices.push({ index: slices.length, qty, scheduledOffsetMs: slices.length * intervalMs });
  }
  return slices;
}

/**
 * Plan the child-slice schedule for an equity order.
 *
 * Short-circuits to a SINGLE slice (no behavior change) when the flag is off,
 * the qty is invalid, or the notional is below the configured threshold — this
 * is the today path (flag off / tiny sizes). When eligible it splits per the
 * configured strategy:
 *  - TWAP: `childCount` even slices spaced `intervalMs` apart.
 *  - Participation: each slice capped at `maxParticipationRate × intervalVolume`
 *    shares, stepping `intervalMs` between slices, bounded by
 *    {@link ORDER_SPLIT_MAX_SLICES}. With no interval-volume estimate it falls
 *    back to the TWAP even split (there's nothing to rate-limit against).
 *
 * Pure & deterministic: no clock, no I/O. Offsets are relative to the caller's
 * decision time; the (future) executor stamps them onto a real clock.
 */
export function planOrderSlices(input: OrderSliceInput): OrderSlicePlan {
  const { config } = input;
  const totalQty = Math.floor(input.totalQty);
  const notional = Number.isFinite(input.referencePrice) && input.referencePrice > 0 && totalQty > 0
    ? totalQty * input.referencePrice
    : 0;

  if (!config.enabled) return singleSlice(Math.max(totalQty, 0), 'disabled', config.strategy, notional);
  if (!Number.isFinite(totalQty) || totalQty <= 0) return singleSlice(0, 'invalid_qty', config.strategy, notional);
  if (notional < config.minNotional) return singleSlice(totalQty, 'below_threshold', config.strategy, notional);

  if (config.strategy === 'participation') {
    const vol = input.intervalVolume;
    if (typeof vol === 'number' && Number.isFinite(vol) && vol > 0) {
      const capPerSlice = Math.max(1, Math.floor(vol * config.maxParticipationRate));
      const needed = Math.ceil(totalQty / capPerSlice);
      const sliceCount = Math.min(needed, ORDER_SPLIT_MAX_SLICES);
      // Re-even across the (possibly capped) slice count so the last slice isn't
      // a stub and the ceiling is respected even for very large orders.
      const slices = evenSlices(totalQty, sliceCount, config.intervalMs);
      return {
        split: slices.length > 1,
        reason: slices.length > 1 ? 'split_participation' : 'single_slice_config',
        strategy: 'participation',
        notional,
        slices,
      };
    }
    // No volume to rate-limit against — fall back to the TWAP even split.
    const slices = evenSlices(totalQty, Math.min(config.childCount, ORDER_SPLIT_MAX_SLICES), config.intervalMs);
    return {
      split: slices.length > 1,
      reason: slices.length > 1 ? 'participation_no_volume_twap_fallback' : 'single_slice_config',
      strategy: 'twap',
      notional,
      slices,
    };
  }

  // TWAP
  const slices = evenSlices(totalQty, Math.min(config.childCount, ORDER_SPLIT_MAX_SLICES), config.intervalMs);
  return {
    split: slices.length > 1,
    reason: slices.length > 1 ? 'split_twap' : 'single_slice_config',
    strategy: 'twap',
    notional,
    slices,
  };
}

// ── Counted-reason telemetry ────────────────────────────────────────────────
// Since-boot registry mirroring the TRA-2045 order-quote-guard shape. Keyed by
// `enabled:reason` so the health route can show how often orders cross (or fail
// to cross) the split threshold. Memory-only; the calibration that would justify
// building/arming the executor lives in the fee/slippage ledgers, not here.

const counters = new Map<string, number>();

function counterKey(enabled: boolean, reason: OrderSplitReason): string {
  return `${enabled ? 'enabled' : 'disabled'}:${reason}`;
}

/**
 * Record one planning outcome for the since-boot rollup. Also folds the total
 * child-slice count for split plans so the health route can show scheduled
 * volume without a separate ledger.
 */
export function recordOrderSplitOutcome(plan: OrderSlicePlan, enabled: boolean): void {
  const key = counterKey(enabled, plan.reason);
  counters.set(key, (counters.get(key) ?? 0) + 1);
  if (plan.split) {
    counters.set('slices_scheduled', (counters.get('slices_scheduled') ?? 0) + plan.slices.length);
  }
}

export interface OrderSplitMetricsSnapshot {
  /** Flat `enabled:reason → count` map of every non-zero counter. */
  counts: Record<string, number>;
  /** Total planning outcomes recorded since boot (excludes the slice tally). */
  total: number;
}

/** Snapshot the since-boot counters for the health route. */
export function snapshotOrderSplitMetrics(): OrderSplitMetricsSnapshot {
  const out: Record<string, number> = {};
  let total = 0;
  for (const [k, v] of counters) {
    out[k] = v;
    if (k !== 'slices_scheduled') total += v;
  }
  return { counts: out, total };
}

/** Test seam — reset the since-boot counters. */
export function resetOrderSplitMetricsForTests(): void {
  counters.clear();
}
