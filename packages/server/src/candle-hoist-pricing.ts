import type { Candle } from '@trading-app/shared';
import type { RetainerRow } from './heap-retainer-census.js';
import { marketDataCandleCacheEntries } from './market-data-candle-cache.js';

/**
 * TRA-4986 (AC4) — PRICE the candle hoist instead of folding heap across it.
 *
 * ## Why AC4 could not be graded as written, and why this replaces it
 *
 * AC4 asked for a matched-quiescent `heapUsed` fold, BEFORE vs AFTER, off the
 * census tape. That instrument is dead for this ticket, for two independent
 * reasons measured on 2026-10-01/02:
 *
 *  1. **The arms are cross-population.** TRA-4902 took bqb1 from 68 user
 *     contexts to 4 at `2026-10-01T19:53Z` with no restart. The BEFORE arm is a
 *     68-engine process and any AFTER arm is a 4-engine one, so the difference
 *     is dominated by 64 destroyed contexts. Run unguarded it printed
 *     `-274.3 MB heapUsed`, then `-593.3 MB rss`, then `-78.0 MB` on a fresh
 *     boot — three "results" from the same two arms. The grader now refuses it.
 *  2. **It is underpowered even if the rosters matched.** The hoist eliminates
 *     `(N-1)` copies, so the absolute saving scales as `N-1`: at 68 that is 67
 *     copies, at 4 it is 3, i.e. **4.5 %** of the filed lever. The BEFORE arm's
 *     own within-arm spread is **184.1 MB** (min 416.8 / max 600.9, n=210), so
 *     4.5 % of the effect is inside the noise of one arm. Even the unfolded
 *     274.3 MB against that spread is only ~1.5:1.
 *
 * The roster cannot be restored to settle it. The `tape/` pool on bqb1 is at
 * **15.959 / 16 MiB (99.7 %), 41 KB of headroom against a ~49 KB mean file**, so
 * re-registering 68 writers would push 6.4-9.6 MiB through it across the
 * weekend's boundaries and permanently evict ~130 files — the two active
 * non-dead books would come out holding only what they wrote during the window.
 * That is a permanent data loss bought to produce a number that would still sit
 * inside its own instrument's noise (CTO, TRA-4986 comment `96d82cdd`,
 * 2026-10-02T02:21Z; the reservation fix is filed separately).
 *
 * ## So this is a POINT ESTIMATE UNDER A STATED MODEL, and the model is here
 *
 *     saving_bytes = bytesPerEntry x (duplicate entries eliminated)
 *
 * Both factors are measured, neither is assumed, and each has its own refusal:
 *
 *  - **`bytesPerEntry`** — measured ON the subject process by allocating a
 *    faithful deep copy of a real sample of the live store and reading the
 *    `heapUsed` delta. Not a structural model with hand-written V8 constants
 *    (those go wrong silently across a Node version), and not
 *    `v8.serialize().length` (that measures wire bytes, not retained heap).
 *  - **`duplicateEntries`** — `Σ per-engine entries - |union|`. `|union|` is the
 *    `marketData.minuteCandles` row's own `entries`, measured. The per-engine Σ
 *    no longer exists to be measured (the hoist deleted the property — that is
 *    AC2's success condition), so it comes from the `technicalSnapshots` proxy
 *    with its calibration published: see {@link PROXY_CALIBRATION}.
 *
 * ## What is measured and what is projected — kept apart on purpose
 *
 * The estimate at the CURRENT population is fully measured. The estimate at the
 * filed 68-context roster is a **projection**, and it carries exactly one
 * unmeasured input: `|union|` at 68 engines, which no pre-hoist build ever
 * published. It is projected through the measured sharing efficiency
 * {@link CandleHoistPricing.sharingEfficiency} rather than assumed to be perfect.
 * The two are separate fields with separate names and the projection says what
 * it is. Quoting the projection as a measurement is the error this split exists
 * to make impossible.
 */

/** A `Candle` is `{symbol, timestamp, open, high, low, close, volume, synthetic?}`. */
function copyEntry(bars: readonly Candle[]): Candle[] {
  // Spread per bar so the copy carries the same own-property set (including an
  // optional `synthetic`), hence the same hidden class and the same retained
  // shape. `structuredClone` would also deep-copy the `symbol` STRING, which the
  // original shares with its own map key — that would overstate every entry.
  return bars.map((b) => ({ ...b }));
}

/**
 * The proxy for the per-engine Σ, and the single joint instant that calibrates
 * it.
 *
 * `signalEngine.candleCache` and `signalEngine.technicalSnapshots` were both
 * measurable in one read on 2026-10-01 at a 68-context roster (build
 * `faae938837bf`): **6,608** and **6,800** fleet entries respectively. One
 * `technicalSnapshot` exists per (engine, scanned symbol) pair and the candle
 * series is its input, so the snapshot count is an upper bound on the candle
 * count, short by the symbols whose pull failed — hence `6608/6800 = 0.9718`.
 *
 * ⚠️ This is a RATIO OF TWO FLEET TOTALS AT ONE ROSTER, which is why it is
 * allowed to be a constant here when the absolute `6,608` is not. Both totals
 * scale with the population, so the ratio divides it out. The lesson of this
 * ticket's own `bound: 6800` defect is that a constant may not encode a
 * population — and this one does not.
 */
export const PROXY_CALIBRATION = {
  row: 'signalEngine.technicalSnapshots',
  factor: 6608 / 6800,
  measuredAt: '2026-10-01',
  build: 'faae938837bf',
  candleCacheEntries: 6608,
  proxyEntries: 6800,
  population: 68,
} as const;

/** The roster the ticket was filed at, for the projection arm. */
export const FILED_ROSTER = {
  population: 68,
  candleCacheEntries: 6608,
  nestedCandles: 525_249,
  measuredAt: '2026-10-01T16:24:47.495Z',
  build: 'faae938837bf',
} as const;

/** Entries sampled from the live store per arm. Caps the probe's own cost. */
const DEFAULT_SAMPLE_ENTRIES = 250;
/** Below this the per-entry mean is one outlier wide. Refuse instead. */
const MIN_SAMPLE_ENTRIES = 8;
/**
 * Candle copies to hold per arm. ~150k objects is ~10-15 MB — large enough that
 * a live box's concurrent request traffic cannot dominate the `heapUsed` delta,
 * small enough to be irrelevant against a 1,536 MB heap cap. Transient: dropped
 * before the arm returns.
 */
const TARGET_CANDLE_COPIES = 150_000;
const MAX_REPLICAS = 64;
/** Independent arms. Three so a disagreement is visible rather than averaged. */
const DEFAULT_ARMS = 3;
/** Refuse when the loosest arm is more than this multiple of the tightest. */
const ARM_AGREEMENT_MAX = 2;

/** One independent allocation measurement. */
export interface PricingArm {
  /** `heapUsed` delta in bytes across the arm's allocation. */
  bytes: number;
  /** Entries copied = `sampleEntries x replicas`. */
  entriesCopied: number;
  /** Candle objects copied. The denominator for `bytesPerCandle`. */
  candlesCopied: number;
  elapsedMs: number;
}

export type PricingRefusal =
  | 'store_row_absent'
  | 'store_cold'
  | 'sample_too_small'
  | 'proxy_row_absent'
  | 'population_unreadable'
  | 'arm_non_positive'
  | 'arms_disagree'
  | 'proxy_below_union';

export interface CandleHoistPricing {
  /**
   * Set when NO number is published, with the reason. A refusal is the point:
   * every input here has a state in which it reads plausible and means nothing
   * (a cold store prices at ~0 bytes; a GC inside an arm prices negative).
   */
  refusal: PricingRefusal | null;
  /** Prose for {@link refusal}, so a reader need not look the code up. */
  refusalDetail: string | null;
  /** The arms, always published — including when they caused the refusal. */
  arms: PricingArm[];
  /** Median arm bytes / entries copied. `null` when refused. */
  bytesPerEntry: number | null;
  /** Median arm bytes / candles copied. `null` when refused. */
  bytesPerCandle: number | null;
  /** Mean candles per entry in the sample (expected ~80, the single call site's literal). */
  candlesPerEntry: number | null;
  /** `marketData.minuteCandles.entries` — the measured union. */
  unionEntries: number | null;
  /** The proxy row's raw fleet entries. */
  proxyEntries: number | null;
  /** Proxy entries x {@link PROXY_CALIBRATION}.factor — the per-engine Σ estimate. */
  counterfactualEntries: number | null;
  /** `counterfactualEntries - unionEntries`. What the hoist actually removed. */
  duplicateEntries: number | null;
  /** The population this measurement belongs to. */
  population: number | null;
  /** MEASURED saving at {@link population}. */
  savingBytes: number | null;
  savingMB: number | null;
  /**
   * `duplicateEntries / (counterfactual x (1 - 1/N))` — how close the sharing
   * came to the perfect-duplication ceiling, where every engine held the same
   * keys. 1.0 means every per-engine copy beyond the first was redundant.
   *
   * This is the quantity that transfers across rosters, which is the whole
   * reason the projection goes through it rather than through `(N-1)`.
   */
  sharingEfficiency: number | null;
  /**
   * The filed-roster arm. **A PROJECTION, NOT A MEASUREMENT** — see the module
   * note. Its one unmeasured input is `|union|` at 68 engines; it is carried
   * through {@link sharingEfficiency} measured at the current population.
   */
  projection: {
    label: 'PROJECTION — not a measurement';
    atPopulation: number;
    perEngineEntries: number;
    /** `sharingEfficiency x perEngineEntries x (1 - 1/68)`. */
    duplicateEntries: number | null;
    bytes: number | null;
    mb: number | null;
    unmeasuredInput: string;
  } | null;
  /** The probe's own cost, so the instrument is gradeable too. */
  cost: { sampleEntries: number; replicas: number; arms: number; elapsedMs: number };
}

export interface PriceCandleHoistOptions {
  /** The census rows from the SAME read, so the two can never describe different instants. */
  rows: readonly RetainerRow[];
  /** The population from the same read. `null` is refused, never treated as 1. */
  population: number | null;
  sampleEntries?: number;
  arms?: number;
  /** Injectable for tests. Defaults to the live store. */
  entries?: () => IterableIterator<[string, Candle[]]> | Iterable<[string, Candle[]]>;
  /** Injectable for tests. Defaults to `process.memoryUsage().heapUsed`. */
  heapUsed?: () => number;
}

function rowEntries(rows: readonly RetainerRow[], name: string): number | null {
  const row = rows.find((r) => r.name === name);
  return row ? row.entries : null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function empty(
  refusal: PricingRefusal,
  refusalDetail: string,
  cost: CandleHoistPricing['cost'],
  arms: PricingArm[] = [],
  partial: Partial<CandleHoistPricing> = {},
): CandleHoistPricing {
  return {
    refusal,
    refusalDetail,
    arms,
    bytesPerEntry: null,
    bytesPerCandle: null,
    candlesPerEntry: null,
    unionEntries: null,
    proxyEntries: null,
    counterfactualEntries: null,
    duplicateEntries: null,
    population: null,
    savingBytes: null,
    savingMB: null,
    sharingEfficiency: null,
    projection: null,
    cost,
    ...partial,
  };
}

/**
 * Measure `bytesPerEntry` on this process and price the hoist against the census
 * rows from the same read.
 *
 * O(sampleEntries x replicas) allocations and nothing else — no iteration of the
 * full store, no serialisation, no heap snapshot. Opt-in per request
 * (`?sizing=true`), never on the sampled path: the sampler has to stay cheap
 * enough to run every 300 s during RTH on a money-adjacent host.
 */
export function priceCandleHoist(opts: PriceCandleHoistOptions): CandleHoistPricing {
  const startedAt = Date.now();
  const sampleCap = opts.sampleEntries ?? DEFAULT_SAMPLE_ENTRIES;
  const armCount = opts.arms ?? DEFAULT_ARMS;
  const heapUsed = opts.heapUsed ?? (() => process.memoryUsage().heapUsed);
  const iterate = opts.entries ?? marketDataCandleCacheEntries;
  const cost = (replicas: number, sampleEntries = 0): CandleHoistPricing['cost'] => ({
    sampleEntries,
    replicas,
    arms: armCount,
    elapsedMs: Date.now() - startedAt,
  });

  const unionEntries = rowEntries(opts.rows, 'marketData.minuteCandles');
  if (unionEntries === null) {
    return empty(
      'store_row_absent',
      'marketData.minuteCandles is not in this census read, so there is no hoisted store to '
      + 'price. Absent is also AC2\'s FAILURE condition for the replacement row — read AC2 first.',
      cost(0),
    );
  }
  const proxyEntries = rowEntries(opts.rows, PROXY_CALIBRATION.row);
  if (proxyEntries === null) {
    return empty(
      'proxy_row_absent',
      `${PROXY_CALIBRATION.row} is not in this census read, so the per-engine counterfactual Σ `
      + 'has no basis. The per-engine candleCache row cannot supply it — the hoist deleted it.',
      cost(0),
      [],
      { unionEntries },
    );
  }
  if (opts.population === null) {
    return empty(
      'population_unreadable',
      'No signalEngine.* row in this read, so the population is UNREADABLE. It is not 1: a '
      + 'saving per the sharing-efficiency model is undefined without N.',
      cost(0),
      [],
      { unionEntries, proxyEntries },
    );
  }

  // Sample the live store. Take entries in iteration order rather than at random
  // — a Map's order is insertion order, which here is first-pull order, and that
  // has no correlation with series length. Refusing on a thin sample is the
  // guard that matters, not sampling cleverness.
  const sample: Candle[][] = [];
  let sampledCandles = 0;
  for (const [, bars] of iterate()) {
    if (sample.length >= sampleCap) break;
    if (!Array.isArray(bars) || bars.length === 0) continue;
    sample.push(bars);
    sampledCandles += bars.length;
  }
  if (sample.length === 0) {
    return empty(
      'store_cold',
      `The store holds ${unionEntries} keys and no non-empty series, so there is nothing to `
      + 'measure. A cold store prices the hoist at ~0 bytes, which reads as "the fix bought '
      + 'nothing" and means "the cache has not been written since boot". refreshCandles needs an '
      + 'RTH cold-bar scan; re-read after 13:30Z.',
      cost(0),
      [],
      { unionEntries, proxyEntries, population: opts.population },
    );
  }
  if (sample.length < MIN_SAMPLE_ENTRIES) {
    return empty(
      'sample_too_small',
      `Only ${sample.length} non-empty series available (need ${MIN_SAMPLE_ENTRIES}); a per-entry `
      + 'mean over that is one outlier wide.',
      cost(0, sample.length),
      [],
      { unionEntries, proxyEntries, population: opts.population },
    );
  }

  const replicas = Math.max(
    1,
    Math.min(MAX_REPLICAS, Math.ceil(TARGET_CANDLE_COPIES / sampledCandles)),
  );
  const arms: PricingArm[] = [];
  for (let a = 0; a < armCount; a += 1) {
    // Let the previous arm's copies go before measuring the next one. `gc` is
    // only present under --expose-gc (it is not on bqb1); without it the arm
    // agreement check is what catches a GC landing mid-arm.
    (globalThis as { gc?: () => void }).gc?.();
    const armStart = Date.now();
    const before = heapUsed();
    let held: Candle[][] | null = [];
    for (let r = 0; r < replicas; r += 1) {
      for (const bars of sample) held.push(copyEntry(bars));
    }
    const after = heapUsed();
    const entriesCopied = held.length;
    held = null;
    arms.push({
      bytes: after - before,
      entriesCopied,
      candlesCopied: sampledCandles * replicas,
      elapsedMs: Date.now() - armStart,
    });
  }

  const nonPositive = arms.find((arm) => arm.bytes <= 0);
  if (nonPositive) {
    return empty(
      'arm_non_positive',
      `An arm measured ${nonPositive.bytes} bytes for ${nonPositive.entriesCopied} live copies, `
      + 'which is impossible: a GC ran inside the measurement window. Re-read. Publishing the '
      + 'other arms\' mean here would be reporting a number whose denominator we know is wrong.',
      cost(replicas, sample.length),
      arms,
      { unionEntries, proxyEntries, population: opts.population },
    );
  }
  const perEntry = arms.map((arm) => arm.bytes / arm.entriesCopied);
  const spread = Math.max(...perEntry) / Math.min(...perEntry);
  if (spread > ARM_AGREEMENT_MAX) {
    return empty(
      'arms_disagree',
      `Arms span ${round(spread, 2)}x on bytes/entry (max ${ARM_AGREEMENT_MAX}x): `
      + `${perEntry.map((v) => Math.round(v)).join(', ')}. The host was doing something else `
      + 'during the measurement. The median would still print, which is exactly why it must not.',
      cost(replicas, sample.length),
      arms,
      { unionEntries, proxyEntries, population: opts.population },
    );
  }

  const bytesPerEntry = median(perEntry);
  const candlesPerEntry = sampledCandles / sample.length;
  const counterfactualEntries = proxyEntries * PROXY_CALIBRATION.factor;
  if (counterfactualEntries < unionEntries) {
    return empty(
      'proxy_below_union',
      `The counterfactual per-engine Σ (${round(counterfactualEntries, 1)}, from `
      + `${PROXY_CALIBRATION.row} = ${proxyEntries}) is BELOW the measured union `
      + `(${unionEntries}). The proxy is invalid at this instant — the store holds keys no engine `
      + 'currently scans, which happens while the fleet is warming or after a roster shrink. A '
      + 'negative saving is not the finding; an inapplicable proxy is.',
      cost(replicas, sample.length),
      arms,
      {
        unionEntries,
        proxyEntries,
        counterfactualEntries: round(counterfactualEntries, 1),
        population: opts.population,
        bytesPerEntry: Math.round(bytesPerEntry),
        bytesPerCandle: round(bytesPerEntry / candlesPerEntry, 1),
        candlesPerEntry: round(candlesPerEntry, 1),
      },
    );
  }

  const duplicateEntries = counterfactualEntries - unionEntries;
  const savingBytes = duplicateEntries * bytesPerEntry;
  // The perfect-duplication ceiling: every engine holding an identical key set
  // leaves exactly one copy, i.e. Σ x (1 - 1/N) entries are redundant.
  const perfectCeiling = counterfactualEntries * (1 - 1 / opts.population);
  const sharingEfficiency = perfectCeiling > 0 ? duplicateEntries / perfectCeiling : null;
  const projectedDuplicates =
    sharingEfficiency === null
      ? null
      : sharingEfficiency
        * FILED_ROSTER.candleCacheEntries
        * (1 - 1 / FILED_ROSTER.population);

  return {
    refusal: null,
    refusalDetail: null,
    arms,
    bytesPerEntry: Math.round(bytesPerEntry),
    bytesPerCandle: round(bytesPerEntry / candlesPerEntry, 1),
    candlesPerEntry: round(candlesPerEntry, 1),
    unionEntries,
    proxyEntries,
    counterfactualEntries: round(counterfactualEntries, 1),
    duplicateEntries: round(duplicateEntries, 1),
    population: opts.population,
    savingBytes: Math.round(savingBytes),
    savingMB: round(savingBytes / 1048576, 1),
    sharingEfficiency: sharingEfficiency === null ? null : round(sharingEfficiency, 3),
    projection: {
      label: 'PROJECTION — not a measurement',
      atPopulation: FILED_ROSTER.population,
      perEngineEntries: FILED_ROSTER.candleCacheEntries,
      duplicateEntries: projectedDuplicates === null ? null : round(projectedDuplicates, 1),
      bytes: projectedDuplicates === null ? null : Math.round(projectedDuplicates * bytesPerEntry),
      mb:
        projectedDuplicates === null
          ? null
          : round((projectedDuplicates * bytesPerEntry) / 1048576, 1),
      unmeasuredInput:
        '|union| at 68 engines was never published by any pre-hoist build, so it is carried '
        + `through the sharingEfficiency measured at population ${opts.population} rather than `
        + 'assumed to be 1.0. bytesPerEntry and the 6,608 per-engine Σ are both measured '
        + `(${FILED_ROSTER.build}, ${FILED_ROSTER.measuredAt}).`,
    },
    cost: { sampleEntries: sample.length, replicas, arms: armCount, elapsedMs: Date.now() - startedAt },
  };
}
