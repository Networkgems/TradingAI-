import type { OptionChainRow } from './otm-mispricing.js';

/**
 * TRA-1609 — Put-Call Ratio (PCR) sentiment overlay, pure computation.
 *
 * The one sentiment gap surfaced in TRA-1605/1607: our 21EMA+RSI+Vol trio is
 * price/momentum only and carries no positioning read. PCR fills it from data
 * we already pull — the Tradier chain carries `optionType` + `volume` +
 * `openInterest` per contract, so aggregating Σ put / Σ call across the tracked
 * expiries yields a positioning sentiment signal at zero extra market-data cost.
 *
 * This module is DECISION-FREE and I/O-free: it folds a chain snapshot into the
 * ratio, its regime bucket, and the contrarian read. The durable append-only
 * capture, the trailing-20-session z-score, and the trio pairing live in the
 * server ledger (`pcr-shadow-ledger.ts`), which QuantTrader validates via the
 * TRA-532 promotion gate after a ≥200-signal shadow window. NOTHING here is
 * wired to live sizing or exits — shadow-first, $0 live.
 *
 * Article basis (Investopedia "Put-Call Ratio"): PCR-by-VOLUME is the primary
 * read (the *change* in flow matters more than the absolute level — hence the
 * z-score in the ledger); PCR-by-OI is the slower, secondary read. The raw
 * ratio is read contrarian at extremes (heavy put buying → contrarian bullish,
 * and vice-versa) while the regime bucket reports the face-value sentiment.
 */

/** Face-value sentiment bucket from PCR-by-volume. */
export type PcrRegime = 'bullish' | 'neutral' | 'bearish';

/** The contrarian interpretation at a regime extreme (flagged separately). */
export type PcrContrarian = 'bullish' | 'bearish';

export interface PutCallRatioOptions {
  /**
   * Minimum aggregate (put + call) contract volume across the tracked expiries.
   * Below this floor the chain is too illiquid for a trustworthy read, so the
   * ratio fields are nulled and `reason` is set. Default 500 (per QuantTrader's
   * output contract).
   */
  minAggregateVolume?: number;
  /** Upper bound (exclusive) of the bullish bucket on PCR-by-volume. Default 0.7. */
  bullishBelow?: number;
  /** Lower bound (exclusive) of the bearish bucket on PCR-by-volume. Default 1.0. */
  bearishAbove?: number;
  /**
   * Restrict aggregation to these expirations (YYYY-MM-DD). When omitted, every
   * row is aggregated — the caller is expected to have pre-filtered the snapshot
   * to the tracked window (near + next monthly).
   */
  expiries?: readonly string[];
}

export const PCR_DEFAULTS = {
  minAggregateVolume: 500,
  bullishBelow: 0.7,
  bearishAbove: 1.0,
} as const;

export interface PutCallRatio {
  /** Σ put volume / Σ call volume — the primary read. null when unusable (see `reason`). */
  pcrVolume: number | null;
  /** Σ put OI / Σ call OI — the slower secondary read. null when unusable. */
  pcrOi: number | null;
  putVolume: number;
  callVolume: number;
  putOpenInterest: number;
  callOpenInterest: number;
  /** put + call volume across the aggregated expiries — the liquidity basis. */
  aggregateVolume: number;
  /** Distinct expirations that contributed ≥1 contract row (ascending). */
  expiriesUsed: string[];
  /** Face-value sentiment bucket from `pcrVolume`; null when `pcrVolume` is null. */
  regime: PcrRegime | null;
  /**
   * Contrarian read, flagged SEPARATELY from `regime`: a bearish regime (heavy
   * put flow) is a contrarian *bullish* tell and vice-versa. null in the neutral
   * band or when `pcrVolume` is null.
   */
  contrarian: PcrContrarian | null;
  /** True when `aggregateVolume` is below the liquidity floor (ratio fields nulled). */
  insufficientLiquidity: boolean;
  /** Why the ratio is untrustworthy/null (e.g. no rows, below floor, zero denominator); null when clean. */
  reason: string | null;
}

/** Classify PCR-by-volume into a face-value sentiment bucket. */
export function pcrRegime(
  pcrVolume: number,
  bullishBelow: number = PCR_DEFAULTS.bullishBelow,
  bearishAbove: number = PCR_DEFAULTS.bearishAbove,
): PcrRegime {
  if (pcrVolume < bullishBelow) return 'bullish';
  if (pcrVolume > bearishAbove) return 'bearish';
  return 'neutral';
}

/**
 * Fold a chain snapshot into the put-call ratio and its sentiment read. Rows
 * with a non-finite / negative volume or OI contribute 0 to that leg (a missing
 * field never poisons the aggregate). Equity-options only is the caller's
 * responsibility — pass an equity underlying's chain.
 */
export function computePutCallRatio(
  rows: readonly OptionChainRow[],
  opts: PutCallRatioOptions = {},
): PutCallRatio {
  const floor = opts.minAggregateVolume ?? PCR_DEFAULTS.minAggregateVolume;
  const bullishBelow = opts.bullishBelow ?? PCR_DEFAULTS.bullishBelow;
  const bearishAbove = opts.bearishAbove ?? PCR_DEFAULTS.bearishAbove;
  const expiryFilter = opts.expiries ? new Set(opts.expiries) : null;

  let putVolume = 0;
  let callVolume = 0;
  let putOpenInterest = 0;
  let callOpenInterest = 0;
  const expiries = new Set<string>();

  const nonNeg = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

  for (const r of rows) {
    if (expiryFilter && !expiryFilter.has(r.expiration)) continue;
    const vol = nonNeg(r.volume);
    const oi = nonNeg(r.openInterest);
    if (vol > 0 || oi > 0) expiries.add(r.expiration);
    if (r.optionType === 'put') {
      putVolume += vol;
      putOpenInterest += oi;
    } else if (r.optionType === 'call') {
      callVolume += vol;
      callOpenInterest += oi;
    }
  }

  const aggregateVolume = putVolume + callVolume;
  const expiriesUsed = [...expiries].sort();

  const base = {
    putVolume,
    callVolume,
    putOpenInterest,
    callOpenInterest,
    aggregateVolume,
    expiriesUsed,
  } as const;

  if (expiriesUsed.length === 0) {
    return {
      ...base,
      pcrVolume: null,
      pcrOi: null,
      regime: null,
      contrarian: null,
      insufficientLiquidity: false,
      reason: 'no_option_rows',
    };
  }

  if (aggregateVolume < floor) {
    return {
      ...base,
      pcrVolume: null,
      pcrOi: null,
      regime: null,
      contrarian: null,
      insufficientLiquidity: true,
      reason: `insufficient_liquidity: aggregate volume ${aggregateVolume} < floor ${floor}`,
    };
  }

  const pcrVolume = callVolume > 0 ? putVolume / callVolume : null;
  const pcrOi = callOpenInterest > 0 ? putOpenInterest / callOpenInterest : null;

  if (pcrVolume === null) {
    return {
      ...base,
      pcrVolume: null,
      pcrOi,
      regime: null,
      contrarian: null,
      insufficientLiquidity: false,
      reason: 'zero_call_volume',
    };
  }

  const regime = pcrRegime(pcrVolume, bullishBelow, bearishAbove);
  const contrarian: PcrContrarian | null =
    regime === 'bearish' ? 'bullish' : regime === 'bullish' ? 'bearish' : null;

  return {
    ...base,
    pcrVolume,
    pcrOi,
    regime,
    contrarian,
    insufficientLiquidity: false,
    reason: null,
  };
}

/**
 * Z-score of `value` against a trailing `history` sample (population σ). Returns
 * null when the sample is too small (< `minSamples`, default 2) or degenerate
 * (σ = 0) — the caller records `pcr_z: null` rather than a spurious 0. The
 * article stresses the *change* in PCR over its own recent range, which this
 * captures: a fresh spike in put flow reads as a large positive z even when the
 * absolute ratio looks unremarkable.
 */
export function pcrZScore(value: number, history: readonly number[], minSamples = 2): number | null {
  const sample = history.filter((v) => Number.isFinite(v));
  if (sample.length < minSamples) return null;
  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  const variance = sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length;
  const sd = Math.sqrt(variance);
  // A σ this small is a constant sample up to floating-point noise (PCR ratios
  // are O(1)); treat it as degenerate rather than emitting a spurious huge z.
  if (!(sd > 1e-9)) return null;
  return (value - mean) / sd;
}
