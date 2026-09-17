import { MIN_IV_SAMPLES } from './iv-rank-store.js';

/**
 * TRA-4644 (parent TRA-4413, item 2) — availability accounting for the
 * `ivPercentile` field published on the OTM/RV nomination read surface.
 *
 * The umbrella's bar: a field that is silently null most of the time is the
 * failure mode, so "how often is the percentile actually available on this
 * surface" must be answerable without a code read. These counters split every
 * nomination-context stamp (`contextFor` in `options-ideas-service.ts` — the
 * exact site that stamps `SymbolEventContext.ivRank`/`ivPercentile`, so the
 * denominator IS the nominated population, no second one minted) into WHY the
 * percentile was or was not a number:
 *
 *   `covered`              — `ivPercentileSync` returned a number.
 *   `insufficient_history` — the store knows the symbol but its trailing
 *                            window holds < MIN_IV_SAMPLES usable samples.
 *                            Self-heals as the store warms; NOT a defect.
 *   `uncovered`            — the store is unloaded or has never recorded the
 *                            symbol. Structural; will not heal on its own.
 *   `no_atm_iv`            — the chain in hand had no usable mid ATM IV this
 *                            pass, so NEITHER rank nor percentile was even
 *                            attempted. Kept DISTINCT from the store states
 *                            (TRA-4424 pattern): pooling a chain-quality
 *                            failure into `uncovered` would launder a feed
 *                            defect into a store-coverage story.
 *
 * NOT a gate and carries NO flag: this row only publishes a read field and
 * nothing keys behaviour on it (ranking/gating on IV percentile is a separate
 * pre-registered decision, TRA-3392 §6). Counters are SINCE-BOOT and count
 * research-fusion passes, not panel polls — the feed cache (FEED_TTL_MS)
 * short-circuits `contextFor` on a hit, which is the same dedup rationale as
 * TRA-2199's `!research.cached` guard.
 */

export const IV_PERCENTILE_COVERAGE_CODES = [
  'covered',
  'insufficient_history',
  'uncovered',
  'no_atm_iv',
] as const;
export type IvPercentileCoverageCode = (typeof IV_PERCENTILE_COVERAGE_CODES)[number];

/**
 * Classify one stamp. PURE. `sampleDepth` is `ivSampleDepthSync`'s read — the
 * TRA-2206 diagnostic that separates "cold, will self-heal" from "never will".
 *
 * Edge worth naming: a window can hold >= MIN_IV_SAMPLES rows of which some are
 * non-finite/<= 0; `computeIvPercentile` filters those before its floor check, so
 * `ivPercentile` can be null at depth >= MIN_IV_SAMPLES. That is still an
 * insufficient USABLE window — classified `insufficient_history`, not a fifth code.
 */
export function classifyIvPercentileCoverage(
  atmIv: number | null,
  ivPercentile: number | null,
  sampleDepth: number,
): IvPercentileCoverageCode {
  if (atmIv == null) return 'no_atm_iv';
  if (ivPercentile != null) return 'covered';
  return sampleDepth > 0 ? 'insufficient_history' : 'uncovered';
}

interface CoverageCounters {
  evaluated: number;
  byCode: Record<IvPercentileCoverageCode, number>;
  /**
   * Rank/percentile disagreement, the one direction it can happen: a FLAT
   * trailing window (max === min) nulls the rank while the percentile is still
   * well-defined. Non-zero here is the two-fields-not-one argument measured live.
   */
  flatWindowRankNull: number;
  lastEvaluatedAt: number | null;
  lastSymbol: string | null;
  lastCoveredSymbol: string | null;
}

function emptyCounters(): CoverageCounters {
  const byCode = Object.fromEntries(IV_PERCENTILE_COVERAGE_CODES.map((c) => [c, 0])) as Record<
    IvPercentileCoverageCode,
    number
  >;
  return {
    evaluated: 0,
    byCode,
    flatWindowRankNull: 0,
    lastEvaluatedAt: null,
    lastSymbol: null,
    lastCoveredSymbol: null,
  };
}

let counters = emptyCounters();
let sinceMs = Date.now();

/** Test seam. */
export function resetIvPercentileCoverageForTest(): void {
  counters = emptyCounters();
  sinceMs = Date.now();
}

/** Fold one stamp into the since-boot counters. */
export function recordIvPercentileCoverage(
  symbol: string,
  code: IvPercentileCoverageCode,
  opts: { ivRank: number | null; ivPercentile: number | null; nowMs?: number } = {
    ivRank: null,
    ivPercentile: null,
  },
): void {
  const nowMs = opts.nowMs ?? Date.now();
  counters.evaluated += 1;
  counters.byCode[code] += 1;
  counters.lastEvaluatedAt = nowMs;
  counters.lastSymbol = symbol;
  if (code === 'covered') counters.lastCoveredSymbol = symbol;
  if (opts.ivPercentile != null && opts.ivRank == null) counters.flatWindowRankNull += 1;
}

export interface IvPercentileCoverageHealth {
  readonly issue: 'TRA-4644';
  readonly minIvSamples: number;
  /** ⚠️ SINCE-BOOT. A restart zeroes every count below. */
  readonly sinceMs: number;
  readonly evaluated: number;
  /** Dense over the code vocabulary — absent is not zero (TRA-4154 trap). */
  readonly byCode: { code: IvPercentileCoverageCode; count: number; share: number | null }[];
  readonly flatWindowRankNull: number;
  readonly lastEvaluatedAt: string | null;
  readonly lastSymbol: string | null;
  readonly lastCoveredSymbol: string | null;
  readonly note: string;
}

/** The block `/api/health/options-ideas-decomposition` publishes. */
export function ivPercentileCoverageHealth(): IvPercentileCoverageHealth {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    issue: 'TRA-4644',
    minIvSamples: MIN_IV_SAMPLES,
    sinceMs,
    evaluated: counters.evaluated,
    byCode: IV_PERCENTILE_COVERAGE_CODES.map((code) => ({
      code,
      count: counters.byCode[code],
      share: counters.evaluated > 0 ? counters.byCode[code] / counters.evaluated : null,
    })),
    flatWindowRankNull: counters.flatWindowRankNull,
    lastEvaluatedAt: iso(counters.lastEvaluatedAt),
    lastSymbol: counters.lastSymbol,
    lastCoveredSymbol: counters.lastCoveredSymbol,
    note:
      'READ FIELD ONLY (no flag): `ivPercentile` is published beside `ivRank` on the '
      + 'OTM/RV nomination surface (`/api/options/ideas` idea cards + the fused research '
      + 'context) and NOTHING gates on it (a gate is TRA-3392 §6 pre-registration). '
      + 'Counters are SINCE-BOOT and count research-fusion stamps (the feed cache '
      + 'short-circuits panel polls). Below MIN_IV_SAMPLES the field is an honest null, '
      + 'never 0, never backfilled.',
  };
}
