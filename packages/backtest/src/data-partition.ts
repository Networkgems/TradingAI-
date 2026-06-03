/**
 * 3-way chronological data partition for the TRA-531 optimization harness
 * (TRA-540, spec §3).
 *
 * Time series are split **by calendar, never shuffled** — shuffling leaks the
 * future. Three contiguous segments over the full history:
 *
 *   [ optimization (~70%) ][ purge + embargo gap ][ locked holdout (~30%) ]
 *
 * The purge/embargo gap drops bars straddling the boundary so indicator state
 * and overlapping open trades cannot leak across (López de Prado purging).
 *
 * The holdout is a *vault*: its bars are only reachable through `openHoldout()`,
 * which may be called exactly once — the single final `evaluateHoldout()` step.
 * Any second call throws, and `holdoutAccessCount` lets a test prove the
 * optimization phase never touched it.
 */

import type { Candle } from '@trading-app/shared';

export interface PartitionOptions {
  /** Fraction of history reserved for optimization. Defaults to 0.70. */
  optimizationFraction?: number;
  /**
   * Warmup bars purged at the start of the gap so the holdout's leading
   * indicators are not warmed by optimization bars. Defaults to 250 (matches
   * the harness `WARMUP_BARS`).
   */
  warmupBars?: number;
  /** Extra embargo bars dropped after the warmup purge. Defaults to 5. */
  embargoBars?: number;
}

export interface PartitionBoundaries {
  optStartTs: number;
  optEndTs: number;
  holdoutStartTs: number;
  holdoutEndTs: number;
  warmupBars: number;
  embargoBars: number;
  /** Bar counts per segment, for the report. */
  optBars: number;
  gapBars: number;
  holdoutBars: number;
  totalBars: number;
}

export class DataPartition {
  /** Bars available to ALL sweeping / walk-forward — the holdout is excluded. */
  readonly optimization: Candle[];
  readonly boundaries: PartitionBoundaries;

  // The locked holdout, sealed behind a one-shot release.
  #holdout: Candle[];
  #accessCount = 0;

  constructor(optimization: Candle[], holdout: Candle[], boundaries: PartitionBoundaries) {
    this.optimization = optimization;
    this.#holdout = holdout;
    this.boundaries = boundaries;
  }

  /** Times the locked holdout has been released. 0 until the final evaluation. */
  get holdoutAccessCount(): number {
    return this.#accessCount;
  }

  /**
   * Release the locked holdout bars — exactly once. Re-running the optimizer
   * after a look invalidates the holdout (spec §3 hard rule), so a second call
   * is a programming error and throws rather than silently leaking.
   */
  openHoldout(): Candle[] {
    if (this.#accessCount > 0) {
      throw new Error(
        'Holdout already consumed: the locked OOS segment may be read exactly once ' +
          '(the single evaluateHoldout call). Re-tuning after a look invalidates it.',
      );
    }
    this.#accessCount += 1;
    return this.#holdout;
  }
}

/**
 * Carve `candles` into optimization / purge+embargo gap / locked holdout. The
 * gap width is `warmupBars + embargoBars`; the optimization segment is the
 * leading `optimizationFraction`, the holdout is everything after the gap.
 */
export function partitionData(candles: Candle[], opts: PartitionOptions = {}): DataPartition {
  const optimizationFraction = opts.optimizationFraction ?? 0.7;
  const warmupBars = Math.max(0, opts.warmupBars ?? 250);
  const embargoBars = Math.max(0, opts.embargoBars ?? 5);
  const gapBars = warmupBars + embargoBars;
  const total = candles.length;

  const optEnd = Math.floor(total * optimizationFraction); // exclusive
  const holdoutStart = optEnd + gapBars;                   // inclusive

  if (optEnd <= 0 || holdoutStart >= total) {
    throw new Error(
      `Not enough bars (${total}) to partition: optimization=${optEnd}, ` +
        `gap=${gapBars}, holdout would start at ${holdoutStart}. Need a longer series.`,
    );
  }

  const optimization = candles.slice(0, optEnd);
  const holdout = candles.slice(holdoutStart);

  const boundaries: PartitionBoundaries = {
    optStartTs: candles[0].timestamp,
    optEndTs: candles[optEnd - 1].timestamp,
    holdoutStartTs: candles[holdoutStart].timestamp,
    holdoutEndTs: candles[total - 1].timestamp,
    warmupBars,
    embargoBars,
    optBars: optimization.length,
    gapBars,
    holdoutBars: holdout.length,
    totalBars: total,
  };

  return new DataPartition(optimization, holdout, boundaries);
}
