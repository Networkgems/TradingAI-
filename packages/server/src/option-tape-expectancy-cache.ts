// TRA-3391 (TRA-3388 Ruling 2) — the rolling fold behind the tape-calibrated
// expectancy gate, and the ONLY production builder of the cell table.
//
// The admission decision happens inside `SignalEngine.costAwareGateReject`, which
// is a SYNCHRONOUS per-candidate call on the trade pass. The tape it now decides
// on is a journal read. This module is the seam: it holds the folded table in
// memory, refolds it on the same cadence the learned-weights cache uses (a trade
// close invalidates it; a short TTL caps the cost), and exposes a SYNC `peek()`
// the engine can call per candidate without turning three scan loops async.
//
// ── FAIL-CLOSED, deliberately ────────────────────────────────────────────────
// `peek()` returns `null` until the first fold lands (and kicks that fold off in
// the background). A null table declines every candidate with
// `insufficient_evidence`, which is the honest reading — at that instant we have
// literally not measured anything — and it is tightening-only, so a cold cache
// can never admit a trade the tape does not support. `initTapeExpectancyCache()`
// warms it at boot so the window is a few hundred ms, not a session.
//
// ── BASIS (Ruling 2.1) ───────────────────────────────────────────────────────
// Model-facing: desk + unattributed, QA fixtures excluded via `test-accounts.ts`.
// This is NOT decoration. 110 of the 116 fixture OTM rows sit in the 0.45–0.55
// band — exactly the band the gate admits — so a fixture-inclusive fold would
// manufacture the admission it is supposed to test.
//
// ⚠ It deliberately does NOT use `loadModelFacingJournalRows()`, which pins
// `mode: 'demo'`. QuantTrader's ruling measured n=1073 = 1067 demo + 6 LIVE rows,
// and the live rows are the only universe-matched evidence that exists. Excluding
// them would drop the most relevant six rows on the board. So this loads every
// mode and applies the basis predicate itself, then publishes the per-mode census
// so "which modes are in this number" is read, never assumed.

import {
  listOptionTradeJournal,
  onOptionTradeClose,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import { applyModelFacingBasis, MODEL_FACING_JOURNAL_BASIS } from './model-facing-journal.js';
import { resolveCostGateConfig } from './option-cost-gate.js';
import {
  buildTapeExpectancyTable,
  type TapeExpectancyTable,
} from './option-tape-expectancy.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'option-tape-expectancy-cache' });

/** Refold at most ~once a minute absent a close event (the weights-cache cadence). */
export const DEFAULT_TAPE_EXPECTANCY_TTL_MS = 60_000;

/**
 * The rolling window (Ruling 2.3). A year covers the entire journal today
 * (n=1073 OTM closes since inception), so it truncates nothing yet; it exists so
 * that a 2028 gate is not deciding on 2026 exit policy. Not env-overridable — see
 * the knob note in `option-tape-expectancy.ts`.
 */
export const TAPE_EXPECTANCY_WINDOW_DAYS = 365;

/** Observable freshness of the fold — published beside every number it produced. */
export interface TapeExpectancyFreshness {
  /** ms-epoch of the served fold. 0 before the first one. */
  computedAt: number;
  /** Monotonic counter; bumps once per refold, so a probe can see one happen. */
  generation: number;
  ageMs: number;
  ttlMs: number;
  /** True when a close has invalidated the fold but no refold has run yet. */
  dirty: boolean;
  /** Message from the last failed refold, else null (a failed refold serves stale). */
  lastError: string | null;
}

/** Which modes / account classes went into the fold. Basis, published not assumed. */
export interface TapeExpectancyBasisCensus {
  basis: typeof MODEL_FACING_JOURNAL_BASIS;
  desk: number;
  unattributed: number;
  /** Rows dropped by the `test-accounts.ts` fixture predicate. */
  fixtureExcluded: number;
  /** Kept rows by journal `mode`, e.g. `{ demo: 1067, live: 6 }`. */
  byMode: Record<string, number>;
}

export interface CachedTapeExpectancy {
  table: TapeExpectancyTable;
  census: TapeExpectancyBasisCensus;
  freshness: TapeExpectancyFreshness;
}

export interface TapeExpectancyCacheOpts {
  ttlMs?: number;
  now?: () => number;
  windowDays?: number | null;
  /** Load ALL journal rows (pre-basis). Injected in tests. */
  load?: () => Promise<OptionTradeJournalRecord[]>;
  env?: NodeJS.ProcessEnv;
}

/**
 * In-memory, TTL-capped, close-invalidated cache for the tape-expectancy table.
 * A failed refold keeps serving the last good fold (and says so via
 * `freshness.lastError`); a never-folded cache serves nothing, which declines.
 */
export class TapeExpectancyCache {
  private table: TapeExpectancyTable | null = null;
  private census: TapeExpectancyBasisCensus | null = null;
  private computedAt = 0;
  private generation = 0;
  private dirty = true;
  private lastError: string | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly windowDays: number | null;
  private readonly load: () => Promise<OptionTradeJournalRecord[]>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: TapeExpectancyCacheOpts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TAPE_EXPECTANCY_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.windowDays = opts.windowDays === undefined ? TAPE_EXPECTANCY_WINDOW_DAYS : opts.windowDays;
    // Every mode, then the model-facing basis — see the header for why this is
    // NOT `loadModelFacingJournalRows()`.
    this.load = opts.load ?? (() => listOptionTradeJournal({}));
    this.env = opts.env ?? process.env;
  }

  /** Mark the fold stale so the next read refolds. Wired to the journal close event. */
  invalidate(): void {
    this.dirty = true;
  }

  private stale(t: number): boolean {
    return this.table === null || this.dirty || t - this.computedAt >= this.ttlMs;
  }

  /**
   * SYNC read for the trade pass. Returns the last folded table (or `null` before
   * the first fold) and schedules a background refold when stale. Never awaits and
   * never throws — a candidate decision must not be able to block on a file read,
   * and the null case declines rather than admits.
   */
  peek(): TapeExpectancyTable | null {
    if (this.stale(this.now())) void this.refresh();
    return this.table;
  }

  /** Await the current fold, refolding first when stale. For health reads / boot. */
  async get(): Promise<CachedTapeExpectancy | null> {
    if (this.stale(this.now())) await this.refresh();
    if (this.table === null || this.census === null) return null;
    return { table: this.table, census: this.census, freshness: this.freshness() };
  }

  /** Freshness of whatever is currently served. Safe to read before any fold. */
  freshness(): TapeExpectancyFreshness {
    return {
      computedAt: this.computedAt,
      generation: this.generation,
      ageMs: this.now() - this.computedAt,
      ttlMs: this.ttlMs,
      dirty: this.dirty,
      lastError: this.lastError,
    };
  }

  /**
   * Refold. Coalesced: concurrent callers share one in-flight read, so a hot scan
   * loop peeking every candidate cannot stack journal reads.
   */
  private refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = (async () => {
      const t = this.now();
      try {
        const all = await this.load();
        const { rows, counts } = applyModelFacingBasis(all);
        const byMode: Record<string, number> = {};
        for (const r of rows) {
          byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
        }
        this.table = buildTapeExpectancyTable(rows, {
          windowDays: this.windowDays,
          nowMs: t,
          config: resolveCostGateConfig(this.env),
        });
        this.census = {
          basis: MODEL_FACING_JOURNAL_BASIS,
          desk: counts.desk,
          unattributed: counts.unattributed,
          fixtureExcluded: counts.fixtureExcluded,
          byMode,
        };
        this.computedAt = t;
        this.generation += 1;
        this.dirty = false;
        this.lastError = null;
      } catch (err) {
        // Serve the last good fold; leave `dirty` set so the next read retries.
        // A never-folded cache stays null, which DECLINES — never admits.
        this.lastError = err instanceof Error ? err.message : String(err);
        log.warn('tape-expectancy refold failed, serving last good fold', {
          reason: this.lastError,
        });
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = run;
    return run;
  }
}

// ── Process-global singleton, wired to the journal's close event ─────────────

let singleton: TapeExpectancyCache | null = null;
let subscribed = false;

/** The process-wide cache, lazily built and close-invalidated on first touch. */
export function tapeExpectancyCache(): TapeExpectancyCache {
  if (!singleton) {
    singleton = new TapeExpectancyCache();
    if (!subscribed) {
      onOptionTradeClose(() => singleton?.invalidate());
      subscribed = true;
    }
  }
  return singleton;
}

/**
 * The SYNC accessor the gate calls per candidate. `null` ⇒ nothing folded yet ⇒
 * `insufficient_evidence` ⇒ decline.
 */
export function peekTapeExpectancyTable(): TapeExpectancyTable | null {
  return tapeExpectancyCache().peek();
}

/** Warm the fold at boot so the fail-closed window is milliseconds, not a session. */
export async function initTapeExpectancyCache(): Promise<void> {
  await tapeExpectancyCache().get();
}

/** Test seam — drop the singleton + subscription flag between test files. */
export function resetTapeExpectancyCacheForTests(): void {
  singleton = null;
  subscribed = false;
}
