// TRA-1046 (TRA-1041c L1) — intraday learned-weights refresh.
//
// Before this, the option learned-weights fold (`computeOptionLearnedWeights`)
// was materialised ONLY in the EOD snapshot path (index.ts), so a mid-session
// close did not move the live selection weights until the next day / restart.
// This module closes that latency: it holds the folded weights in memory and
// recomputes them when a trade closes (event-driven freshness) OR when a short
// TTL lapses (a cost cap, so a hot per-tick selection read never refolds the
// whole journal). It is the single source future selection wiring reads through,
// and the freshness it exposes is what makes "weights changed intraday after a
// close" observable on the health endpoint.
//
// Honesty rules carried over from the learners themselves:
//   * No capital path. This caches a SCORING fold; it never sizes or gates a
//     trade. Live promotion stays gated on TRA-382.
//   * Pure compute. The fold (`computeOptionLearnedWeights`) is deterministic;
//     the only impurity here is the clock (TTL) and the journal read (I/O), both
//     injectable for tests.
//   * Fail-safe. A failed refresh keeps serving the last good fold rather than
//     throwing into a read path; the generation/age make staleness visible.

import {
  listOptionTradeJournal,
  onOptionTradeClose,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import {
  computeOptionLearnedWeights,
  type OptionLearnedWeights,
} from './learned-option-weights.js';
import { DEFAULT_LEARNED_PARAMS, type LearnedWeightsParams } from './learned-signal-weights.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'learned-weights-cache' });

/** Default TTL: refold at most ~once a minute absent a close event. */
export const DEFAULT_WEIGHTS_TTL_MS = 60_000;

/** Observable freshness of a cached fold — surfaced on the health readout. */
export interface WeightsFreshness {
  /** ms-epoch the currently-served fold was computed. 0 before the first fold. */
  computedAt: number;
  /** Monotonic counter; bumps once per recompute. Lets a probe see a refold. */
  generation: number;
  /** now - computedAt at read time. */
  ageMs: number;
  /** The TTL cap in force. */
  ttlMs: number;
  /** True when a close has invalidated the fold but no read has refolded yet. */
  dirty: boolean;
}

export interface CachedOptionWeights {
  weights: OptionLearnedWeights;
  freshness: WeightsFreshness;
}

export interface OptionWeightsCacheOpts {
  ttlMs?: number;
  now?: () => number;
  /** Load the journal rows to fold. Defaults to the full demo-only journal. */
  load?: () => Promise<OptionTradeJournalRecord[]>;
  params?: LearnedWeightsParams;
}

/**
 * In-memory, TTL-capped, close-invalidated cache for the option learned-weights
 * fold. A read recomputes when the fold is missing, marked dirty by a close, or
 * older than the TTL; otherwise it returns the memoised fold untouched.
 */
export class OptionWeightsCache {
  private weights: OptionLearnedWeights | null = null;
  private computedAt = 0;
  private generation = 0;
  private dirty = true;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly load: () => Promise<OptionTradeJournalRecord[]>;
  private readonly params: LearnedWeightsParams;

  constructor(opts: OptionWeightsCacheOpts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_WEIGHTS_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.load = opts.load ?? (() => listOptionTradeJournal());
    this.params = opts.params ?? DEFAULT_LEARNED_PARAMS;
  }

  /** Mark the fold stale so the next read recomputes. Called on a trade close. */
  invalidate(): void {
    this.dirty = true;
  }

  private needsRefresh(t: number): boolean {
    return this.weights === null || this.dirty || t - this.computedAt >= this.ttlMs;
  }

  /**
   * Return the current fold + its freshness, recomputing first if stale. A failed
   * refold keeps the previous fold (if any) and leaves `dirty` set so the next
   * read retries; only a never-yet-computed cache surfaces an empty fold.
   */
  async get(): Promise<CachedOptionWeights> {
    const t = this.now();
    if (this.needsRefresh(t)) {
      try {
        const rows = await this.load();
        this.weights = computeOptionLearnedWeights(rows, this.params);
        this.computedAt = t;
        this.generation += 1;
        this.dirty = false;
      } catch (err) {
        log.warn('learned-weights refold failed, serving last good fold', {
          reason: err instanceof Error ? err.message : String(err),
        });
        if (this.weights === null) {
          // Never folded yet — serve a deterministic empty fold rather than throw.
          this.weights = computeOptionLearnedWeights([], this.params);
          this.computedAt = t;
          this.generation += 1;
        }
      }
    }
    return {
      // Non-null after the block above: either the refold set it, or a prior
      // fold is still in hand, or the catch seeded an empty fold.
      weights: this.weights!,
      freshness: {
        computedAt: this.computedAt,
        generation: this.generation,
        ageMs: this.now() - this.computedAt,
        ttlMs: this.ttlMs,
        dirty: this.dirty,
      },
    };
  }
}

// ── Process-global singleton wired to the journal's close event ──────────────

let singleton: OptionWeightsCache | null = null;
let subscribed = false;

/**
 * The process-wide cache, lazily constructed with production defaults. The first
 * construction also subscribes to the journal's close event, so intraday
 * invalidation is wired the moment anything touches the cache — no explicit boot
 * call required (the journal itself inits lazily the same way). A close that lands
 * before the first read is harmless: the cache starts `dirty`, so the first read
 * recomputes regardless, and the subscription is live for every close after.
 */
export function optionWeightsCache(): OptionWeightsCache {
  if (!singleton) {
    singleton = new OptionWeightsCache();
    if (!subscribed) {
      onOptionTradeClose(() => singleton?.invalidate());
      subscribed = true;
    }
  }
  return singleton;
}

/** Optional warmer — fold once at boot so the first read is hot. */
export async function initLearnedWeightsCache(): Promise<void> {
  await optionWeightsCache().get();
}

/** Test seam — drop the singleton + subscription flag between test files. */
export function resetLearnedWeightsCacheForTests(): void {
  singleton = null;
  subscribed = false;
}
