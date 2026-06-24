import type { AdxResult } from '../indicators/adx.js';

/**
 * TRA-1044 (F1) — per-symbol, per-tick indicator snapshot.
 *
 * The deterministic equity loop in the signal engine evaluates several
 * strategies (ORB, BbFade, …) against the *identical* candle array for a
 * symbol on each tick. Before this snapshot, each strategy recomputed the
 * same O(n) indicators independently — most notably ADX, which both ORB and
 * BbFade derive from the full series at the default period (14).
 *
 * Callers compute each shared indicator ONCE per symbol per tick and pass the
 * result here; strategies that receive a snapshot read the precomputed value
 * instead of recomputing it. Every field is computed with the SAME default
 * parameters the strategies use when they compute it themselves, so passing a
 * snapshot is behaviour-preserving — it only removes redundant work.
 *
 * A `null` field means the indicator was computed but the data was
 * insufficient (the same value the strategy's own call would have returned).
 * The presence of the snapshot object itself is the "use precomputed" signal,
 * so callers must populate every field (even as `null`) before passing it.
 */
export interface SharedTickIndicators {
  /** ADX over the full candle series at the default period (14); `null` when insufficient data. */
  adx: AdxResult | null;
}
