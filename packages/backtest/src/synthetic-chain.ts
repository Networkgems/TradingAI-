/**
 * TRA-731 (Phase 2, Track B) — synthetic option-chain generator + IV model.
 *
 * Real >=12mo equity option-chain history does not exist (the recorder is
 * forward-only; see TRA-382), so the board ratified a synthetic-chain replay as
 * the near-term go/no-go basis: Black-Scholes priced from >=12mo equity bars
 * plus a realized-vol / term-structure IV model. This module is that generator.
 *
 * For a given equity bar (spot + the trailing close history up to that bar) it
 * emits a synthetic option chain in the EXACT `OptionChainSnapshotFile` schema
 * the recorded-chain replay reads (`./data/option-chains/<date>/<symbol>.json`),
 * so the existing harness (`run-options-replay --synthetic`) and the OTM / RV
 * scanners consume it UNCHANGED.
 *
 * IV model (parameterized so QuantTrader can sweep the IV-rank cutoff):
 *   - realized vol: trailing-window annualized stdev of log returns (default 20d).
 *   - term structure: short-dated IV carries a vol-risk-premium multiplier and a
 *     mild slope by sqrt(dte) so IV varies by expiry (a simple VIX-proxy stand-in).
 *   - IV-rank: range-position of today's realized vol in its trailing window
 *     (default 252 bars) → 0..100, the value the IV gate (`selectStructureByIv`)
 *     and the sweep cutoff consume.
 *
 * Strikes cover |delta| ~0.50–0.80 (slightly ITM, where the SupertrendConfluence
 * delta target 0.60–0.70 lives) and expiries 1–6 weeks so the sweep
 * (expiry 2–4wk, delta ~0.60–0.70) has coverage. Pure & deterministic: pricing
 * is a function of the supplied bars only — no network, no Date.now in pricing.
 */

import { blackScholesPrice, blackScholesDelta } from '@trading-app/engine';
import type { OptionChainRow } from '@trading-app/engine';
import type { Candle, OptionType } from '@trading-app/shared';

/** Marker stamped on every synthetic chain file's symbol-level meta and report. */
export const SYNTHETIC_TAG = 'synthetic';

/** Trading days per year used to annualize realized vol. */
const TRADING_DAYS_PER_YEAR = 252;

export interface IvModelParams {
  /** Trailing window (bars) for the realized-vol estimate. Default 20. */
  realizedVolWindow: number;
  /** Trailing window (bars) for the IV-rank range. Default 252 (~1y of daily bars). */
  ivRankWindow: number;
  /**
   * Vol-risk-premium multiplier applied to realized vol to get the at-the-money
   * IV level (IV typically trades a little rich to realized). Default 1.10.
   */
  volRiskPremium: number;
  /**
   * Term-structure slope: IV is adjusted by `termSlope × (sqrt(dte/30) − 1)`, so
   * sub-month expiries sit slightly below and longer expiries slightly above the
   * 1-month anchor (a simple upward-sloping VIX-proxy term structure). Default 0.03.
   */
  termSlope: number;
  /** Hard IV floor (annualized). Default 0.08. */
  minIv: number;
  /** Hard IV ceiling (annualized). Default 2.50. */
  maxIv: number;
}

export const DEFAULT_IV_MODEL: IvModelParams = {
  realizedVolWindow: 20,
  ivRankWindow: 252,
  volRiskPremium: 1.1,
  termSlope: 0.03,
  minIv: 0.08,
  maxIv: 2.5,
};

/**
 * Annualized realized volatility from the trailing `window` log returns ending
 * at the last close. Returns `null` when there are fewer than `window+1` closes.
 */
export function realizedVolatility(closes: readonly number[], window: number): number | null {
  if (window < 2 || closes.length < window + 1) return null;
  const slice = closes.slice(closes.length - (window + 1));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1];
    const cur = slice[i];
    if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Series of trailing realized vols, one per bar (null during the warm-up). Used
 * to derive the IV-rank range. Index `i` is the realized vol computed over
 * `closes[i-window .. i]`.
 */
export function realizedVolSeries(closes: readonly number[], window: number): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  for (let i = window; i < closes.length; i += 1) {
    out[i] = realizedVolatility(closes.slice(0, i + 1), window);
  }
  return out;
}

/**
 * IV-rank (0..100): where `current` sits in the [min,max] range of the trailing
 * `history` (the realized-vol series). Returns `null` when the range is empty or
 * degenerate so callers (and the IV gate) treat the rank as unknown rather than
 * fabricating one.
 */
export function ivRank(current: number, history: ReadonlyArray<number | null>): number | null {
  const vals = history.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (vals.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) return null;
  const rank = ((current - lo) / (hi - lo)) * 100;
  return Math.max(0, Math.min(100, rank));
}

/**
 * Model IV for a contract `dteDays` out, given the underlying's annualized
 * realized vol. Applies the vol-risk-premium level shift and the term-structure
 * slope, clamped to [minIv, maxIv].
 */
export function syntheticIv(realizedVolAnnual: number, dteDays: number, params: IvModelParams = DEFAULT_IV_MODEL): number {
  const atm = realizedVolAnnual * params.volRiskPremium;
  const term = params.termSlope * (Math.sqrt(Math.max(dteDays, 1) / 30) - 1);
  return Math.max(params.minIv, Math.min(params.maxIv, atm + term));
}

/** Shape of a per-symbol synthetic snapshot — structurally identical to the recorder's output. */
export interface SyntheticChainFile {
  symbol: string;
  spot: number;
  recordedAt: number;
  expirations: string[];
  rows: OptionChainRow[];
  /** Marks the file as synthetic so it can never be mistaken for a recorded chain. */
  source: typeof SYNTHETIC_TAG;
  /** IV-rank of the underlying on this date (0..100), null when undefined. */
  ivRank: number | null;
}

export interface ChainGenParams {
  /** Expiries to emit, in calendar days from the bar date. Default weekly 7..42 (1–6 weeks). */
  expiryDays: number[];
  /** Strike grid as fractional offsets from spot. Default 0.80..1.20 in 2.5% steps. */
  strikeOffsets: number[];
  /** Annualized risk-free rate for the pricer. Default 0.045. */
  riskFreeRate: number;
  /** Continuous dividend yield. Default 0. */
  dividendYield: number;
  /** Synthetic relative bid/ask half-spread as a fraction of mid. Default 0.0075 (1.5% wide). */
  halfSpreadPct: number;
  /** Synthetic open interest / volume stamped on every row (passes scanner floors). Default 1000 / 500. */
  openInterest: number;
  volume: number;
  iv: IvModelParams;
  /**
   * TRA-926 — a FIXED absolute strike ladder (e.g. from {@link buildFixedStrikeGrid}).
   * When supplied, the generator emits the grid strikes that fall within
   * `strikeBand × spot` instead of the day-relative `strikeOffsets`, so a strike
   * opened on day T is still present (and priceable) in every later day's
   * snapshot. This is the faithful fix for the mark-to-market gap: the prior
   * spot-relative ladder drifted day over day, so an opened leg vanished from
   * later chains and the replay's time-stop booked `-maxLoss` as a fallback.
   */
  strikeGrid?: number[];
  /**
   * TRA-926 — a FIXED expiration calendar (ISO `YYYY-MM-DD`, e.g. from
   * {@link buildWeeklyExpirationCalendar}). When supplied, the generator emits
   * the calendar expirations whose DTE from the bar falls in `emitDteRange`
   * instead of the day-relative `expiryDays`, so an opened expiration stays on
   * the grid (its DTE just shrinks) until it passes.
   */
  expirationCalendar?: string[];
  /** TRA-926 — [lo, hi] spot multiples bounding which fixed-grid strikes are emitted. Default [0.6, 1.4]. */
  strikeBand: [number, number];
  /** TRA-926 — [lo, hi] DTE window for which fixed-calendar expirations are emitted. Default [10, 56]. */
  emitDteRange: [number, number];
}

function defaultStrikeOffsets(): number[] {
  const out: number[] = [];
  for (let off = 0.8; off <= 1.2001; off += 0.025) out.push(Math.round(off * 1000) / 1000);
  return out;
}

/** TRA-926 — default [lo, hi] spot multiples for which fixed-grid strikes are emitted. */
export const DEFAULT_STRIKE_BAND: [number, number] = [0.6, 1.4];
/**
 * TRA-926 — default [lo, hi] DTE window for fixed-calendar expirations. The wide
 * lower bound (10d) keeps an opened expiration emitted well past the selector's
 * 21-DTE time stop / `minShortDte`, so the replay always has a real mark to book
 * against rather than the `-maxLoss` fallback; the upper bound (56d) sits above
 * the selector's 30–45 DTE entry window so entries always have coverage.
 */
export const DEFAULT_EMIT_DTE_RANGE: [number, number] = [10, 56];

export const DEFAULT_CHAIN_GEN: ChainGenParams = {
  expiryDays: [7, 14, 21, 28, 35, 42],
  strikeOffsets: defaultStrikeOffsets(),
  riskFreeRate: 0.045,
  dividendYield: 0,
  halfSpreadPct: 0.0075,
  openInterest: 1000,
  volume: 500,
  iv: DEFAULT_IV_MODEL,
  strikeBand: DEFAULT_STRIKE_BAND,
  emitDteRange: DEFAULT_EMIT_DTE_RANGE,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO `YYYY-MM-DD` for an epoch-ms instant (UTC date component). */
export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Strike increment for a price level (0.5 / 1 / 2.5 / 5) — the exchange-style ladder. */
export function strikeStep(priceLevel: number): number {
  return priceLevel < 25 ? 0.5 : priceLevel < 100 ? 1 : priceLevel < 250 ? 2.5 : 5;
}

/** Round a strike to a sensible increment for the price level (0.5 / 1 / 2.5 / 5). */
export function roundStrike(raw: number): number {
  const step = strikeStep(raw);
  return Math.round(raw / step) * step;
}

/**
 * TRA-926 — a FIXED absolute strike ladder spanning the symbol's whole-window
 * price range (× the [bandLo, bandHi] cushion), at a single uniform increment
 * derived from the median close. Unlike the per-day spot-relative ladder, these
 * strikes do not move day over day, so a strike opened on any day stays on the
 * grid (and within `strikeBand` of spot) in every later snapshot. Returns `[]`
 * when there are no positive closes.
 */
export function buildFixedStrikeGrid(
  closes: readonly number[],
  bandLo = DEFAULT_STRIKE_BAND[0],
  bandHi = DEFAULT_STRIKE_BAND[1],
): number[] {
  const valid = closes.filter((c) => Number.isFinite(c) && c > 0);
  if (valid.length === 0) return [];
  const sorted = [...valid].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const step = strikeStep(median);
  const lo = Math.min(...valid) * bandLo;
  const hi = Math.max(...valid) * bandHi;
  const start = Math.max(step, Math.floor(lo / step) * step);
  const grid: number[] = [];
  for (let k = start; k <= hi + step / 2; k += step) {
    grid.push(Math.round(k * 1000) / 1000);
  }
  return grid;
}

/**
 * TRA-926 — a FIXED weekly expiration calendar (every `weekday`, default Friday)
 * spanning `[fromMs, toMs]` as ISO `YYYY-MM-DD` dates. An opened expiration is a
 * fixed calendar date, so it remains a valid (DTE-shrinking) expiration in every
 * later snapshot until it passes — the faithful counterpart to the fixed strike
 * grid. `weekday` is 0=Sun..6=Sat (UTC).
 */
export function buildWeeklyExpirationCalendar(fromMs: number, toMs: number, weekday = 5): string[] {
  if (!(toMs >= fromMs)) return [];
  // Advance to the first `weekday` on/after fromMs.
  let cur = fromMs;
  const dow = new Date(cur).getUTCDay();
  const delta = (weekday - dow + 7) % 7;
  cur += delta * DAY_MS;
  const out: string[] = [];
  for (; cur <= toMs; cur += 7 * DAY_MS) out.push(isoDate(cur));
  return out;
}

/** Build the OCC-style option symbol the recorder/replay uses for dedup/marks. */
function occSymbol(underlying: string, expirationIso: string, type: OptionType, strike: number): string {
  const yymmdd = expirationIso.replace(/-/g, '').slice(2); // YYMMDD
  const cp = type === 'call' ? 'C' : 'P';
  const strikeThousandths = Math.round(strike * 1000)
    .toString()
    .padStart(8, '0');
  return `${underlying}${yymmdd}${cp}${strikeThousandths}`;
}

/**
 * Generate one synthetic chain file for `symbol` on the bar at `bars[bars.length-1]`.
 * `bars` must be the trailing close history INCLUDING the evaluation bar (so the
 * realized-vol and IV-rank windows are point-in-time correct). Returns `null`
 * when there is not enough history for a realized-vol estimate.
 */
export function buildSyntheticChain(
  symbol: string,
  bars: readonly Candle[],
  params: ChainGenParams = DEFAULT_CHAIN_GEN,
): SyntheticChainFile | null {
  if (bars.length === 0) return null;
  const bar = bars[bars.length - 1];
  const spot = bar.close;
  if (!(spot > 0)) return null;

  const closes = bars.map((b) => b.close);
  const rv = realizedVolatility(closes, params.iv.realizedVolWindow);
  if (rv == null) return null;

  const rvSeries = realizedVolSeries(closes, params.iv.realizedVolWindow);
  const rank = ivRank(rv, rvSeries.slice(Math.max(0, rvSeries.length - params.iv.ivRankWindow)));

  const recordedAt = bar.timestamp;
  const expirations: string[] = [];
  const rows: OptionChainRow[] = [];

  // TRA-926 — expirations: a FIXED calendar (faithful, persists day over day)
  // when supplied, else the legacy day-relative offsets. Each entry carries its
  // own DTE so pricing/IV reflect the real time to expiry on this bar.
  const expEntries: Array<{ expiration: string; dteDays: number }> = [];
  if (params.expirationCalendar && params.expirationCalendar.length > 0) {
    const [dteLo, dteHi] = params.emitDteRange;
    for (const expiration of params.expirationCalendar) {
      const expMs = Date.parse(`${expiration}T00:00:00Z`);
      if (!Number.isFinite(expMs)) continue;
      const dteDays = Math.round((expMs - recordedAt) / DAY_MS);
      if (dteDays < dteLo || dteDays > dteHi) continue;
      expEntries.push({ expiration, dteDays });
    }
  } else {
    for (const dte of params.expiryDays) {
      expEntries.push({ expiration: isoDate(recordedAt + dte * DAY_MS), dteDays: dte });
    }
  }

  // TRA-926 — strikes: a FIXED absolute grid (within `strikeBand × spot`) when
  // supplied, else the legacy spot-relative offsets.
  const strikeList: number[] = [];
  if (params.strikeGrid && params.strikeGrid.length > 0) {
    const [bandLo, bandHi] = params.strikeBand;
    const lo = spot * bandLo;
    const hi = spot * bandHi;
    for (const k of params.strikeGrid) if (k > 0 && k >= lo && k <= hi) strikeList.push(k);
  } else {
    const seenStrikes = new Set<number>();
    for (const off of params.strikeOffsets) {
      const strike = roundStrike(spot * off);
      if (strike <= 0 || seenStrikes.has(strike)) continue;
      seenStrikes.add(strike);
      strikeList.push(strike);
    }
  }

  for (const { expiration, dteDays } of expEntries) {
    expirations.push(expiration);
    const T = Math.max(dteDays, 0) / 365;
    const iv = syntheticIv(rv, dteDays, params.iv);

    for (const strike of strikeList) {
      for (const type of ['call', 'put'] as const) {
        const priceCtx = {
          spot,
          strike,
          timeToExpiryYears: T,
          riskFreeRate: params.riskFreeRate,
          volatility: iv,
          optionType: type,
          dividendYield: params.dividendYield,
        };
        const mid = blackScholesPrice(priceCtx);
        if (!(mid > 0.01)) continue; // drop sub-penny rows the scanners would reject anyway
        const half = Math.max(0.01, mid * params.halfSpreadPct);
        const bid = Math.max(0.01, mid - half);
        const ask = mid + half;

        rows.push({
          optionSymbol: occSymbol(symbol, expiration, type, strike),
          underlying: symbol,
          optionType: type,
          strike,
          expiration,
          bid: Math.round(bid * 100) / 100,
          ask: Math.round(ask * 100) / 100,
          last: Math.round(mid * 100) / 100,
          volume: params.volume,
          openInterest: params.openInterest,
          midIv: iv,
          smvVol: iv,
        });
      }
    }
  }

  return {
    symbol,
    spot,
    recordedAt,
    expirations,
    rows,
    source: SYNTHETIC_TAG,
    ivRank: rank,
  };
}

/** Black-Scholes delta of a synthetic-chain row (test/selection convenience). */
export function rowDelta(
  row: OptionChainRow,
  spot: number,
  nowMs: number,
  riskFreeRate = DEFAULT_CHAIN_GEN.riskFreeRate,
): number {
  const expMs = Date.parse(`${row.expiration}T16:00:00-04:00`);
  const T = Math.max(0, (expMs - nowMs) / (365 * DAY_MS));
  return blackScholesDelta({
    spot,
    strike: row.strike,
    timeToExpiryYears: T,
    riskFreeRate,
    volatility: row.smvVol ?? row.midIv ?? 0.3,
    optionType: row.optionType,
  });
}
