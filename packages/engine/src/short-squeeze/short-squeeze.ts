/**
 * TRA-1207 — Short-squeeze screener (pure, deterministic scoring).
 *
 * Encodes the board's short-squeeze filter spec (issue TRA-1207) as a pure
 * function over a fundamentals snapshot + a price/volume/technical snapshot. No
 * I/O: the server-side {@link ShortSqueezeScannerService} assembles the inputs
 * from the Yahoo quoteSummary fundamentals feed + the daily-bar feed and calls
 * this to classify each symbol. Every threshold is overridable so the board /
 * QuantTrader can retune without a code change.
 *
 * The spec's criteria (with default thresholds):
 *   1. Short float                > 20%              (shortPercentOfFloat)
 *   2. Short interest             > 5,000,000 shares (sharesShort)  ── OR ──
 *      Days to cover              > 5                (shortRatio)
 *   3. Short borrow fee rate      "high"             (borrowFeeRate, optional)
 *   4. Float size                 < 100,000,000      (floatShares)
 *   5. Market cap                 < $10,000,000,000  (marketCap)
 *   6. Average daily volume       > 500,000          (avgDailyVolume)
 *   7. Relative volume (RVOL)     > 1.0              (rvol)
 *   8. Price momentum             above 50-day SMA   (price > sma50)
 *
 * A criterion whose input datum is missing is marked `applicable: false` and
 * excluded from both the pass count and the score denominator — an honest
 * "unknown", never a silent pass. Borrow fee is optional because no free feed
 * (Yahoo included) carries it; it only participates when a caller supplies it
 * from a paid provider (Ortex / IBKR / Fintel).
 */

/** Fundamentals snapshot — the short-interest / float / size data. */
export interface ShortSqueezeFundamentals {
  /** Fraction of float sold short (0.24 = 24%). Null when the feed omits it. */
  shortPercentOfFloat: number | null;
  /** Shares sold short (absolute count). */
  sharesShort: number | null;
  /** Days-to-cover (short interest ratio = sharesShort / avgDailyVolume). */
  daysToCover: number | null;
  /** Free-float share count. */
  floatShares: number | null;
  /** Total shares outstanding (context; not itself a filter). */
  sharesOutstanding: number | null;
  /** Market capitalization in dollars. */
  marketCap: number | null;
  /**
   * Annualized cost-to-borrow rate as a fraction (0.35 = 35%/yr). Optional —
   * no free feed carries it, so it is `null`/absent unless a paid provider is
   * wired in. When absent the borrow-fee criterion is skipped, not failed.
   */
  borrowFeeRate?: number | null;
}

/** Price / volume / technical snapshot derived from daily bars + live quote. */
export interface ShortSqueezePriceStats {
  /** Latest price (live quote or latest daily close). */
  price: number | null;
  /** Average daily share volume over the lookback window. */
  avgDailyVolume: number | null;
  /** Relative volume = today's volume / avgDailyVolume. */
  rvol: number | null;
  /** 50-day simple moving average of daily closes. */
  sma50: number | null;
}

/** Tunable thresholds — defaults match the TRA-1207 spec. */
export interface ShortSqueezeThresholds {
  /** Criterion 1: short float must exceed this fraction (default 0.20 = 20%). */
  minShortPercentOfFloat: number;
  /** Criterion 2a: shares short must exceed this (default 5,000,000). */
  minSharesShort: number;
  /** Criterion 2b: days-to-cover must exceed this (default 5). */
  minDaysToCover: number;
  /** Criterion 3: borrow fee rate must exceed this fraction (default 0.10 = 10%/yr). */
  minBorrowFeeRate: number;
  /** Criterion 4: float must be below this (default 100,000,000). */
  maxFloatShares: number;
  /** Criterion 5: market cap must be below this (default $10B). */
  maxMarketCap: number;
  /** Criterion 6: average daily volume must exceed this (default 500,000). */
  minAvgDailyVolume: number;
  /** Criterion 7: RVOL must exceed this (default 1.0). */
  minRvol: number;
  /** Criterion 8: require price above the 50-day SMA (default true). */
  requireAboveSma50: boolean;
}

export const DEFAULT_SHORT_SQUEEZE_THRESHOLDS: ShortSqueezeThresholds = {
  minShortPercentOfFloat: 0.2,
  minSharesShort: 5_000_000,
  minDaysToCover: 5,
  minBorrowFeeRate: 0.1,
  maxFloatShares: 100_000_000,
  maxMarketCap: 10_000_000_000,
  minAvgDailyVolume: 500_000,
  minRvol: 1.0,
  requireAboveSma50: true,
};

/** Stable identifiers for each screener criterion. */
export type ShortSqueezeFilterKey =
  | 'short_float'
  | 'short_interest'
  | 'days_to_cover'
  | 'borrow_fee'
  | 'float_size'
  | 'market_cap'
  | 'avg_daily_volume'
  | 'rvol'
  | 'above_sma50';

/** Per-criterion evaluation. `applicable` is false when the input was missing. */
export interface ShortSqueezeFilterResult {
  key: ShortSqueezeFilterKey;
  label: string;
  /** Whether the criterion passed (false when not applicable). */
  pass: boolean;
  /** True when the input datum was present and the criterion could be judged. */
  applicable: boolean;
  /** The observed value (null when missing). */
  value: number | null;
  /** The threshold compared against. */
  threshold: number;
  /** Relative weight in the composite score. */
  weight: number;
}

export type ShortSqueezeClassification = 'strong' | 'moderate' | 'weak' | 'none';

export interface ShortSqueezeResult {
  symbol: string;
  /** 0–100 composite: weighted share of APPLICABLE criteria that passed. */
  score: number;
  classification: ShortSqueezeClassification;
  /**
   * True when the "core" squeeze setup holds: heavy short float AND crowded
   * (shares short OR days-to-cover) AND a supply constraint (small float) AND
   * momentum (RVOL + above 50-day SMA). Size/liquidity filters refine the
   * ranking but the core gate is what makes a name a squeeze candidate.
   */
  qualifies: boolean;
  filters: ShortSqueezeFilterResult[];
  /** Count of applicable criteria that passed. */
  passedCount: number;
  /** Count of criteria that could be judged (input present). */
  applicableCount: number;
  /** Human-readable one-liners for the criteria that passed. */
  reasons: string[];
  /** Criteria that could not be judged because their input was missing. */
  missingInputs: ShortSqueezeFilterKey[];
}

export interface EvaluateShortSqueezeOptions {
  thresholds?: Partial<ShortSqueezeThresholds>;
  /** Score (0–100) at/above which a qualifying name is `strong` (default 75). */
  strongScore?: number;
  /** Score (0–100) at/above which a qualifying name is `moderate` (default 50). */
  moderateScore?: number;
}

// Per-criterion weights in the composite score. The short-interest crowding
// signals and the supply constraint carry the most weight (they are what
// actually forces a squeeze); size/liquidity/momentum refine the ranking.
const WEIGHTS: Record<ShortSqueezeFilterKey, number> = {
  short_float: 3,
  short_interest: 2,
  days_to_cover: 2,
  borrow_fee: 1,
  float_size: 2,
  market_cap: 1,
  avg_daily_volume: 1,
  rvol: 2,
  above_sma50: 1,
};

function num(x: number | null | undefined): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/**
 * Evaluate a symbol against the short-squeeze filter set. Pure and deterministic:
 * same inputs → same result. Missing inputs degrade to `applicable: false`
 * rather than passing or throwing.
 */
export function evaluateShortSqueeze(
  symbol: string,
  fundamentals: ShortSqueezeFundamentals,
  priceStats: ShortSqueezePriceStats,
  options: EvaluateShortSqueezeOptions = {},
): ShortSqueezeResult {
  const t: ShortSqueezeThresholds = { ...DEFAULT_SHORT_SQUEEZE_THRESHOLDS, ...options.thresholds };
  const strongScore = options.strongScore ?? 75;
  const moderateScore = options.moderateScore ?? 50;

  const shortPct = num(fundamentals.shortPercentOfFloat);
  const sharesShort = num(fundamentals.sharesShort);
  const daysToCover = num(fundamentals.daysToCover);
  const borrowFee = num(fundamentals.borrowFeeRate);
  const floatShares = num(fundamentals.floatShares);
  const marketCap = num(fundamentals.marketCap);
  const avgVol = num(priceStats.avgDailyVolume);
  const rvol = num(priceStats.rvol);
  const price = num(priceStats.price);
  const sma50 = num(priceStats.sma50);

  const aboveSma50Value =
    price != null && sma50 != null && sma50 > 0 ? price / sma50 : null;

  const filters: ShortSqueezeFilterResult[] = [
    mk('short_float', 'Short float > threshold', shortPct, t.minShortPercentOfFloat, 'gt'),
    mk('short_interest', 'Shares short > threshold', sharesShort, t.minSharesShort, 'gt'),
    mk('days_to_cover', 'Days to cover > threshold', daysToCover, t.minDaysToCover, 'gt'),
    // Borrow fee only participates when a caller supplies it (paid feed).
    mk('borrow_fee', 'Borrow fee rate > threshold', borrowFee, t.minBorrowFeeRate, 'gt'),
    mk('float_size', 'Float < threshold', floatShares, t.maxFloatShares, 'lt'),
    mk('market_cap', 'Market cap < threshold', marketCap, t.maxMarketCap, 'lt'),
    mk('avg_daily_volume', 'Avg daily volume > threshold', avgVol, t.minAvgDailyVolume, 'gt'),
    mk('rvol', 'RVOL > threshold', rvol, t.minRvol, 'gt'),
    // Above-50d-SMA compares price/sma50 to 1.0; disabled → not applicable.
    t.requireAboveSma50
      ? mk('above_sma50', 'Price above 50-day SMA', aboveSma50Value, 1, 'gt')
      : { key: 'above_sma50', label: 'Price above 50-day SMA', pass: false, applicable: false, value: aboveSma50Value, threshold: 1, weight: WEIGHTS.above_sma50 },
  ];

  const applicable = filters.filter((f) => f.applicable);
  const passed = applicable.filter((f) => f.pass);
  const applicableWeight = applicable.reduce((s, f) => s + f.weight, 0);
  const passedWeight = passed.reduce((s, f) => s + f.weight, 0);
  const score = applicableWeight > 0 ? Math.round((passedWeight / applicableWeight) * 100) : 0;

  const byKey = new Map(filters.map((f) => [f.key, f]));
  const passes = (k: ShortSqueezeFilterKey): boolean => byKey.get(k)!.pass;
  // Core squeeze gate: heavy short float, crowded (SI OR DTC), supply-
  // constrained (small float), and confirming momentum (RVOL + above 50d SMA
  // when that criterion is enabled). Only demands criteria we could actually
  // judge — a name with unknown float isn't disqualified for missing data, but
  // it also can't satisfy that leg, so the gate stays conservative.
  const momentumOk = passes('rvol') && (!t.requireAboveSma50 || passes('above_sma50'));
  const qualifies =
    passes('short_float') &&
    (passes('short_interest') || passes('days_to_cover')) &&
    passes('float_size') &&
    momentumOk;

  let classification: ShortSqueezeClassification = 'none';
  if (qualifies) {
    classification = score >= strongScore ? 'strong' : score >= moderateScore ? 'moderate' : 'weak';
  }

  return {
    symbol,
    score,
    classification,
    qualifies,
    filters,
    passedCount: passed.length,
    applicableCount: applicable.length,
    reasons: passed.map((f) => `${f.label} (${fmt(f.key, f.value)})`),
    missingInputs: filters.filter((f) => !f.applicable).map((f) => f.key),
  };

  function mk(
    key: ShortSqueezeFilterKey,
    label: string,
    value: number | null,
    threshold: number,
    dir: 'gt' | 'lt',
  ): ShortSqueezeFilterResult {
    const applicable = value != null;
    const pass = applicable ? (dir === 'gt' ? value! > threshold : value! < threshold) : false;
    return { key, label, pass, applicable, value, threshold, weight: WEIGHTS[key] };
  }
}

function fmt(key: ShortSqueezeFilterKey, value: number | null): string {
  if (value == null) return 'n/a';
  switch (key) {
    case 'short_float':
    case 'borrow_fee':
      return `${(value * 100).toFixed(1)}%`;
    case 'above_sma50':
      return `${((value - 1) * 100).toFixed(1)}% vs SMA50`;
    case 'days_to_cover':
    case 'rvol':
      return value.toFixed(2);
    case 'market_cap':
      return `$${(value / 1e9).toFixed(2)}B`;
    default:
      return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
}
