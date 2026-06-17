/**
 * TRA-918 (TRA-908 Phase D) — Phase-A signal-driven option backtest +
 * paper-accrual harness.
 *
 * This is the `--source=phaseA` entry path for the chain-replay engine. Instead
 * of the TRA-376 OTM/RV scanner, it drives entries off the TRA-911 Phase-A
 * selector (`selectShadowOptionSignal`): per replay day per symbol it builds a
 * `StrategySelectorInput` from that day's chain + the chain-derived trend / ATR /
 * S-R / IV-rank features, asks the selector for a structure, and on
 * `decision === 'signal'` enters the *exact* signalled structure through
 * `OptionsReplayAccount.openSpread`. `stand_down` / `no_structure` enter nothing.
 *
 * The five Phase-D gaps (issue G1–G5) live here and in the two files this
 * composes:
 *   • G1 — this module (signal → selector → openSpread).
 *   • G2 — `modelSignalStructure` (options-replay-structures.ts): the four
 *          Phase-A structures' payoff math.
 *   • G3 — `OptionsReplayAccount.markAndManageSpreads`: 50%-profit take, credit
 *          / debit stop, 21-DTE time stop.
 *   • G4 — `portfolioGreeksForDay` + `summarizeGreeks` below: daily net
 *          theta/vega time series.
 *   • G5 — `computeBacktestGateMetrics` + `buildPhaseAGateReport` below: the
 *          promotion-gate-consumable JSON block (BacktestGateMetrics +
 *          PaperGateMetrics shapes), tagged `mode`.
 *
 * Necessary-not-sufficient: this is the BACKTEST leg only. Forward paper accrual
 * on live chains stays gated on TRA-382; the `paperAccrual` block is populated
 * from forward paper data when it exists, else emitted empty with
 * `mode: "synthetic"`. Pure / deterministic / seedless — feature derivation and
 * DTE math key off the replay day's UTC-midnight instant only.
 */

import {
  blackScholesDelta,
  blackScholesGreeks,
  blackScholesPrice,
  selectShadowOptionSignal,
  type ContractQuote,
  type OptionTrend,
  type StrategySelectorInput,
  type StrategySelectorParams,
  type ShadowOptionSignal,
} from '@trading-app/engine';
import type { OptionLeg } from '@trading-app/shared';
import {
  computePaperGateMetrics,
  OTM_RISK_PARAMS,
  RV_RISK_PARAMS,
  PROFIT_FACTOR_CAP,
  type BacktestGateMetrics,
  type PaperGateMetrics,
  type PromotionTradeSample,
} from '@trading-app/shared';
import {
  OptionsReplayAccount,
  DEFAULT_SPREAD_MANAGEMENT,
  type EquitySample,
  type ReplayPosition,
  type ReplaySpreadStrategy,
  type SpreadManagementParams,
  type SpreadRiskParams,
} from './options-replay-account.js';
import {
  modelSignalStructure,
  DEFAULT_SIGNAL_FILL,
  type SignalFillParams,
} from './options-replay-structures.js';
import { estimateSpotFromChain, type ChainDay, type OptionChainSnapshotFile } from './options-chain-store.js';

const CONTRACT = 100;
const DAY_MS = 86_400_000;
const r2 = (v: number): number => Math.round(v * 100) / 100;

// ───────────────────────────────────────────────────────────────────────────
// Feature derivation from the chain-day spot series
//
// The chain replay only carries a daily underlying spot (no intraday OHLC), so
// the TRA-734 confluence trend label, ATR, and S/R the live selector consumes
// are derived here from the trailing spot series as point-in-time proxies. This
// is the chain-replay stand-in for the bar-driven confluence stack; it is
// documented as a proxy so QuantTrader can swap in the real confluence label if
// the harness is ever fed full OHLC bars.
// ───────────────────────────────────────────────────────────────────────────

/** Trend / feature-window knobs (sweepable). */
export interface PhaseAFeatureParams {
  /** Fast SMA window for the trend label (default 5). */
  trendFastWindow: number;
  /** Slow SMA window for the trend label (default 20). */
  trendSlowWindow: number;
  /** Neutral band around the slow SMA, as a fraction of it (default 0.005 = 0.5%). */
  trendNeutralBand: number;
  /** Trailing window for the ATR proxy (mean |Δspot|) (default 14). */
  atrWindow: number;
  /** Trailing window for the support/resistance levels (default 20). */
  srWindow: number;
  /** Breakout trigger: close beyond the prior-window extreme by this fraction (default 0.001). */
  breakoutMargin: number;
  /** Annualized risk-free rate used to delta/greek the chain (default 0.045). */
  riskFreeRate: number;
}

export const DEFAULT_PHASEA_FEATURES: PhaseAFeatureParams = {
  trendFastWindow: 5,
  trendSlowWindow: 20,
  trendNeutralBand: 0.005,
  atrWindow: 14,
  srWindow: 20,
  breakoutMargin: 0.001,
  riskFreeRate: 0.045,
};

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Trailing SMA of the last `window` values (mean of all when fewer exist). */
function trailingSma(spots: readonly number[], window: number): number {
  return mean(spots.slice(Math.max(0, spots.length - window)));
}

/**
 * Trend label from the trailing spot series: `up` when spot leads a rising
 * fast-over-slow SMA stack, `down` for the mirror, else `range`. Returns
 * `range` until the slow window has filled (honest "no trend yet").
 */
export function trendLabel(spots: readonly number[], p: PhaseAFeatureParams = DEFAULT_PHASEA_FEATURES): OptionTrend {
  if (spots.length < p.trendSlowWindow) return 'range';
  const spot = spots[spots.length - 1]!;
  const fast = trailingSma(spots, p.trendFastWindow);
  const slow = trailingSma(spots, p.trendSlowWindow);
  const band = p.trendNeutralBand * slow;
  if (spot > slow + band && fast > slow) return 'up';
  if (spot < slow - band && fast < slow) return 'down';
  return 'range';
}

/** ATR proxy: trailing mean absolute day-over-day spot change (no intraday H/L available). */
export function atrProxy(spots: readonly number[], window: number): number {
  if (spots.length < 2) return 0;
  const diffs: number[] = [];
  for (let i = 1; i < spots.length; i += 1) diffs.push(Math.abs(spots[i]! - spots[i - 1]!));
  return mean(diffs.slice(Math.max(0, diffs.length - window)));
}

/** Trailing extreme over the last `window` spots (support = min, resistance = max). */
function srLevel(spots: readonly number[], window: number, kind: 'support' | 'resistance'): number | null {
  if (spots.length === 0) return null;
  const slice = spots.slice(Math.max(0, spots.length - window));
  return kind === 'support' ? Math.min(...slice) : Math.max(...slice);
}

/**
 * High-conviction breakout: today's spot pushes beyond the PRIOR window's
 * extreme (excluding today) by `breakoutMargin`, in the direction of `trend`.
 */
export function highConvictionBreakout(
  spots: readonly number[],
  trend: OptionTrend,
  p: PhaseAFeatureParams = DEFAULT_PHASEA_FEATURES,
): boolean {
  if (spots.length < p.srWindow + 1) return false;
  const today = spots[spots.length - 1]!;
  const prior = spots.slice(Math.max(0, spots.length - 1 - p.srWindow), spots.length - 1);
  if (prior.length === 0) return false;
  if (trend === 'up') return today > Math.max(...prior) * (1 + p.breakoutMargin);
  if (trend === 'down') return today < Math.min(...prior) * (1 - p.breakoutMargin);
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// Chain helpers
// ───────────────────────────────────────────────────────────────────────────

/** UTC-midnight ms for a `YYYY-MM-DD` replay day — the deterministic "now". */
function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Whole calendar days from a replay day to an expiration (both UTC midnight). */
function dteFor(expiration: string, nowMs: number): number {
  const expMs = Date.parse(`${expiration}T00:00:00Z`);
  if (!Number.isFinite(expMs)) return Number.NEGATIVE_INFINITY;
  return Math.floor((expMs - nowMs) / DAY_MS);
}

function rowMid(r: { bid?: number; ask?: number; last?: number }): number | null {
  if (typeof r.bid === 'number' && typeof r.ask === 'number' && r.bid > 0 && r.ask >= r.bid) {
    return (r.bid + r.ask) / 2;
  }
  if (typeof r.last === 'number' && r.last > 0) return r.last;
  return null;
}

/** Resolve the underlying spot — recorder-stamped value preferred, parity estimate otherwise. */
function resolveSpot(file: OptionChainSnapshotFile): number | null {
  if (typeof file.spot === 'number' && Number.isFinite(file.spot) && file.spot > 0) return file.spot;
  return estimateSpotFromChain(file.rows);
}

/** UPPER-CASE symbol → resolved spot for a day (drives combo settlement at expiry). */
function spotsForDay(day: ChainDay): Map<string, number> {
  const spots = new Map<string, number>();
  for (const [sym, file] of day.bySymbol) {
    const spot = resolveSpot(file);
    if (spot != null && Number.isFinite(spot) && spot > 0) spots.set(sym.toUpperCase(), spot);
  }
  return spots;
}

/** Leg lookup key — symbol + the three fields a combo leg carries. */
function legKey(symbol: string, leg: { optionType: string; strike: number; expiration: string }): string {
  return `${symbol.toUpperCase()}|${leg.optionType}|${leg.strike}|${leg.expiration}`;
}

/** Per-day (symbol,leg) → mid mark, used by mid-life management + half-spread fills. */
function buildLegMidIndex(day: ChainDay): Map<string, number> {
  const idx = new Map<string, number>();
  for (const [sym, file] of day.bySymbol) {
    for (const row of file.rows) {
      const mid = rowMid(row);
      if (mid != null) idx.set(legKey(sym, row), mid);
    }
  }
  return idx;
}

/** Per-day (symbol,leg) → half-spread (per share), used for the slippage haircut floor. */
function buildLegHalfSpreadIndex(day: ChainDay): Map<string, number> {
  const idx = new Map<string, number>();
  for (const [sym, file] of day.bySymbol) {
    for (const row of file.rows) {
      const bid = row.bid ?? 0;
      const ask = row.ask ?? 0;
      if (bid > 0 && ask >= bid) idx.set(legKey(sym, row), (ask - bid) / 2);
    }
  }
  return idx;
}

/** Per-day (symbol,leg) → model IV, used for the portfolio greeks rollup. */
function buildLegIvIndex(day: ChainDay): Map<string, number> {
  const idx = new Map<string, number>();
  for (const [sym, file] of day.bySymbol) {
    for (const row of file.rows) {
      const iv = row.smvVol ?? row.midIv;
      if (typeof iv === 'number' && iv > 0) idx.set(legKey(sym, row), iv);
    }
  }
  return idx;
}

/**
 * TRA-926 — a per-day leg mark resolver with a Black-Scholes reprice fallback.
 *
 * It first returns the exact (symbol, leg) chain mid when the day quotes it. When
 * the exact leg is NOT in the snapshot it reprices the leg from the day's spot +
 * a nearest-strike chain IV via `blackScholesPrice` instead of returning null. A
 * null mark would make {@link OptionsReplayAccount.markAndManageSpreads} treat
 * the spread as unpriceable and (at the time stop) book `-maxLoss` — the artifact
 * TRA-914 validation caught: a credit spread whose short strikes drifted deep OTM
 * (so far that the synthetic generator drops them as sub-penny rows) is actually
 * near MAX PROFIT, yet was being booked as a full max LOSS.
 *
 * Faithful: a deep-OTM leg reprices to ~0, so the spread marks near its true
 * (winning) value and the 50%-take / continuous-loss behaviour the acceptance
 * checks require both emerge. Returns null only when the symbol has neither a
 * spot nor any IV to model from — i.e. genuinely nothing to mark against.
 */
export function buildLegRepricer(
  day: ChainDay,
  spotBySymbol: ReadonlyMap<string, number>,
  riskFreeRate: number,
): (symbol: string, leg: OptionLeg) => number | null {
  const midIndex = buildLegMidIndex(day);
  // sym|optionType → all quoted {strike, expiration, iv} for nearest-strike IV.
  const ivRows = new Map<string, Array<{ strike: number; expiration: string; iv: number }>>();
  for (const [sym, file] of day.bySymbol) {
    for (const row of file.rows) {
      const iv = row.smvVol ?? row.midIv;
      if (typeof iv !== 'number' || !(iv > 0)) continue;
      const key = `${sym.toUpperCase()}|${row.optionType}`;
      const arr = ivRows.get(key) ?? [];
      arr.push({ strike: row.strike, expiration: row.expiration, iv });
      ivRows.set(key, arr);
    }
  }
  const nowMs = dayMs(day.date);

  return (symbol, leg) => {
    const exact = midIndex.get(legKey(symbol, leg));
    if (exact != null) return exact;

    const sym = symbol.toUpperCase();
    const spot = spotBySymbol.get(sym);
    if (typeof spot !== 'number' || !(spot > 0)) return null;

    const T = Math.max(0, dteFor(leg.expiration, nowMs)) / 365;
    // Past expiry: per-share intrinsic value (the spread settles at intrinsic).
    if (T <= 0) {
      return leg.optionType === 'call' ? Math.max(0, spot - leg.strike) : Math.max(0, leg.strike - spot);
    }

    // Nearest-strike IV, preferring the leg's own expiration, else any of its type.
    const rows = ivRows.get(`${sym}|${leg.optionType}`);
    let iv = 0.3;
    if (rows && rows.length > 0) {
      const sameExp = rows.filter((r) => r.expiration === leg.expiration);
      const pool = sameExp.length > 0 ? sameExp : rows;
      let best = pool[0]!;
      for (const r of pool) {
        if (Math.abs(r.strike - leg.strike) < Math.abs(best.strike - leg.strike)) best = r;
      }
      iv = best.iv;
    }

    const price = blackScholesPrice({
      spot,
      strike: leg.strike,
      timeToExpiryYears: T,
      riskFreeRate,
      volatility: iv,
      optionType: leg.optionType,
    });
    return Number.isFinite(price) ? Math.max(0, price) : null;
  };
}

/**
 * Pick the expiration whose DTE sits in `[dteMin, dteMax]` with the most listed
 * strikes (the deepest chain to model against); ties break toward the middle of
 * the window. Returns null when no expiration falls in the window.
 */
function pickExpirationInWindow(
  rows: readonly { expiration: string }[],
  nowMs: number,
  dteMin: number,
  dteMax: number,
): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const dte = dteFor(r.expiration, nowMs);
    if (dte < dteMin || dte > dteMax) continue;
    counts.set(r.expiration, (counts.get(r.expiration) ?? 0) + 1);
  }
  const mid = (dteMin + dteMax) / 2;
  let best: string | null = null;
  let bestN = -1;
  let bestDist = Infinity;
  for (const [exp, n] of counts) {
    const dist = Math.abs(dteFor(exp, nowMs) - mid);
    if (n > bestN || (n === bestN && dist < bestDist)) {
      bestN = n;
      bestDist = dist;
      best = exp;
    }
  }
  return best;
}

/** Build delta-enriched `ContractQuote`s for one expiration (selector input). */
function contractsForExpiration(
  file: OptionChainSnapshotFile,
  expiration: string,
  spot: number,
  nowMs: number,
  riskFreeRate: number,
): ContractQuote[] {
  const T = Math.max(0, dteFor(expiration, nowMs)) / 365;
  const out: ContractQuote[] = [];
  for (const row of file.rows) {
    if (row.expiration !== expiration) continue;
    const bid = row.bid ?? 0;
    const ask = row.ask ?? 0;
    if (!(bid > 0 && ask > 0 && ask >= bid)) continue;
    const sigma = row.smvVol ?? row.midIv ?? 0.3;
    const delta = blackScholesDelta({
      spot,
      strike: row.strike,
      timeToExpiryYears: T,
      riskFreeRate,
      volatility: sigma,
      optionType: row.optionType,
    });
    out.push({
      optionSymbol: row.optionSymbol,
      optionType: row.optionType,
      strike: row.strike,
      delta,
      bid,
      ask,
      openInterest: row.openInterest ?? 0,
    });
  }
  return out;
}

/** Read IV-rank: prefer the synthetic file's stamped value, else null (unknown → stand down). */
function readIvRank(file: OptionChainSnapshotFile): number | null {
  const v = (file as { ivRank?: number | null }).ivRank;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Assemble a `StrategySelectorInput` for one symbol on one replay day, or null if unbuildable. */
export function buildSelectorInput(
  file: OptionChainSnapshotFile,
  spot: number,
  spotHistory: readonly number[],
  date: string,
  selectorParams: StrategySelectorParams,
  features: PhaseAFeatureParams,
): StrategySelectorInput | null {
  const nowMs = dayMs(date);
  if (!Number.isFinite(nowMs)) return null;
  const expiration = pickExpirationInWindow(file.rows, nowMs, selectorParams.dteMin, selectorParams.dteMax);
  if (!expiration) return null;
  const contracts = contractsForExpiration(file, expiration, spot, nowMs, features.riskFreeRate);
  if (contracts.length === 0) return null;
  const trend = trendLabel(spotHistory, features);
  return {
    symbol: file.symbol.toUpperCase(),
    spot,
    ivRank: readIvRank(file),
    trend,
    highConvictionBreakout: highConvictionBreakout(spotHistory, trend, features),
    atr: atrProxy(spotHistory, features.atrWindow),
    support: srLevel(spotHistory, features.srWindow, 'support'),
    resistance: srLevel(spotHistory, features.srWindow, 'resistance'),
    expiration,
    daysToExpiry: dteFor(expiration, nowMs),
    contracts,
    earningsBeforeExpiry: false, // synthetic chains carry no earnings calendar
    timestamp: nowMs,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// G4 — portfolio theta / vega over time
// ───────────────────────────────────────────────────────────────────────────

/** One replay-day snapshot of portfolio net Greeks across open managed spreads. */
export interface PortfolioGreeksSample {
  day: string;
  /** Net theta in $/day (short premium → positive). */
  netTheta: number;
  /** Net vega in $/vol-point (short premium → negative). */
  netVega: number;
  /** Open spreads contributing to the rollup this day. */
  openSpreads: number;
}

/**
 * Net portfolio theta/vega across the open defined-risk spreads on `day`. Signs
 * follow the short-premium convention: a SOLD leg flips the long-option greek,
 * so a short-premium structure rolls up to POSITIVE theta and NEGATIVE vega.
 * Greeks are converted to display units (theta per calendar day, vega per 1 vol
 * point) and scaled by `contracts × 100`.
 */
export function portfolioGreeksForDay(
  day: string,
  openPositions: readonly ReplayPosition[],
  spotBySymbol: ReadonlyMap<string, number>,
  ivByLeg: ReadonlyMap<string, number>,
  riskFreeRate: number,
): PortfolioGreeksSample {
  const nowMs = dayMs(day);
  let netTheta = 0;
  let netVega = 0;
  let openSpreads = 0;
  for (const opt of openPositions) {
    if (!opt.isCombo || !opt.legs) continue;
    const spot = spotBySymbol.get(opt.symbol.toUpperCase());
    if (typeof spot !== 'number' || !(spot > 0)) continue;
    const T = Math.max(0, dteFor(opt.expiration, nowMs)) / 365;
    openSpreads += 1;
    for (const leg of opt.legs) {
      const sigma = ivByLeg.get(legKey(opt.symbol, leg)) ?? 0.3;
      const g = blackScholesGreeks({
        spot,
        strike: leg.strike,
        timeToExpiryYears: T,
        riskFreeRate,
        volatility: sigma,
        optionType: leg.optionType,
      });
      const sign = leg.action === 'buy' ? 1 : -1;
      netTheta += sign * (g.theta / 365) * opt.contracts * CONTRACT;
      netVega += sign * (g.vega / 100) * opt.contracts * CONTRACT;
    }
  }
  return { day, netTheta: r2(netTheta), netVega: r2(netVega), openSpreads };
}

export interface GreeksSummary {
  meanTheta: number;
  minTheta: number;
  maxTheta: number;
  meanVega: number;
  minVega: number;
  maxVega: number;
  /** Greeks on the day of peak exposure (max |net vega|). */
  thetaAtPeak: number;
  vegaAtPeak: number;
  peakDay: string | null;
}

/** Summarize a portfolio-Greeks time series (mean/min/max + peak-exposure day). */
export function summarizeGreeks(series: readonly PortfolioGreeksSample[]): GreeksSummary {
  const active = series.filter((s) => s.openSpreads > 0);
  if (active.length === 0) {
    return {
      meanTheta: 0, minTheta: 0, maxTheta: 0,
      meanVega: 0, minVega: 0, maxVega: 0,
      thetaAtPeak: 0, vegaAtPeak: 0, peakDay: null,
    };
  }
  const thetas = active.map((s) => s.netTheta);
  const vegas = active.map((s) => s.netVega);
  let peak = active[0]!;
  for (const s of active) if (Math.abs(s.netVega) > Math.abs(peak.netVega)) peak = s;
  return {
    meanTheta: r2(mean(thetas)),
    minTheta: r2(Math.min(...thetas)),
    maxTheta: r2(Math.max(...thetas)),
    meanVega: r2(mean(vegas)),
    minVega: r2(Math.min(...vegas)),
    maxVega: r2(Math.max(...vegas)),
    thetaAtPeak: peak.netTheta,
    vegaAtPeak: peak.netVega,
    peakDay: peak.day,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// G5 — promotion-gate-consumable metrics
// ───────────────────────────────────────────────────────────────────────────

/** Per-trade Sharpe — mean / sample-stddev of the R series. 0 when undefined. */
function perTradeSharpe(rs: readonly number[]): number {
  const n = rs.length;
  if (n < 2) return 0;
  const m = mean(rs);
  const variance = rs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? m / sd : 0;
}

/**
 * Compute `BacktestGateMetrics` from closed defined-risk spreads. Per the gate
 * spec, `expectancy` is the **average R per trade**, where R = trade P&L ÷ that
 * trade's entry defined risk (`maxLossPerLot × contracts`) — NOT mean dollars.
 * `maxDrawdown` is a **fraction** of peak equity on the cumulative-P&L curve
 * (ordered by close day). Trades with no positive defined risk are excluded
 * from the R-based metrics but still count toward `tradeCount`.
 */
export function computeBacktestGateMetrics(
  closed: readonly ReplayPosition[],
  startingEquity: number,
): BacktestGateMetrics {
  const ordered = [...closed].sort((a, b) => (a.closedAtDay ?? '').localeCompare(b.closedAtDay ?? ''));
  const rs: number[] = [];
  let grossWin = 0;
  let grossLoss = 0;
  let cum = 0;
  let peak = startingEquity;
  let maxDdFrac = 0;
  for (const p of ordered) {
    const risk = (p.maxLossPerLot ?? 0) * p.contracts;
    if (risk > 0 && Number.isFinite(risk)) rs.push(p.pnl / risk);
    if (p.pnl >= 0) grossWin += p.pnl;
    else grossLoss += -p.pnl;
    cum += p.pnl;
    const equity = startingEquity + cum;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const ddFrac = (peak - equity) / peak;
      if (ddFrac > maxDdFrac) maxDdFrac = ddFrac;
    }
  }
  const profitFactor =
    grossLoss > 0 ? Math.min(grossWin / grossLoss, PROFIT_FACTOR_CAP) : grossWin > 0 ? PROFIT_FACTOR_CAP : 0;
  return {
    sharpe: r2(perTradeSharpe(rs)),
    expectancy: rs.length ? r2(mean(rs)) : 0,
    profitFactor: r2(profitFactor),
    maxDrawdown: Math.round(maxDdFrac * 10000) / 10000,
    tradeCount: closed.length,
  };
}

/** Empty Stage-2 metrics — the synthetic backtest carries no forward paper data. */
export function emptyPaperGateMetrics(): PaperGateMetrics {
  return { tradeCount: 0, expectancy: 0, sharpe: null, profitFactor: 0, slippageRatio: null, slippageSampleSize: 0 };
}

// ───────────────────────────────────────────────────────────────────────────
// Replay driver
// ───────────────────────────────────────────────────────────────────────────

export interface PhaseAReplayConfig {
  initialEquity: number;
  managedAccountRatio: number;
  optionsDailyTradesLimit: number;
  /** Per-structure sizing budget (fraction of managed equity reserved per lot). */
  spreadRiskParams: Record<ReplaySpreadStrategy, SpreadRiskParams>;
  selectorParams: StrategySelectorParams;
  management: SpreadManagementParams;
  fill: SignalFillParams;
  features: PhaseAFeatureParams;
}

export interface PhaseABucketResult {
  startingEquity: number;
  managedAccountRatio: number;
  closed: ReplayPosition[];
  equityCurve: EquitySample[];
  greeksSeries: PortfolioGreeksSample[];
  /** Total modeled slippage + commission charged across all entered spreads. */
  modeledSlippageTotal: number;
  /** Entries the selector emitted as a signal but that couldn't be priced into a structure. */
  unpriceableSignals: number;
  /** Selector calls that returned `signal` (entered or not). */
  signalCount: number;
  /** TRA-926 — total managed-spread closes (take_profit / stop_loss / time_stop). */
  managedExitsTotal: number;
  /**
   * TRA-926 — managed closes that booked the `-maxLoss` fallback for want of a
   * priced mark. A large share means the chains drifted and the P&L is an
   * artifact; the gate report surfaces it as `unpricedManagedExits` so it cannot
   * be silently published (the failure mode TRA-914 validation caught).
   */
  unpricedManagedExits: number;
}

/**
 * Replay one equity bucket through all chain days off the Phase-A selector.
 * Pure — no I/O. The daily flow:
 *   1. Mark + manage open spreads mid-life (TP / stop / time stop), then settle
 *      any that reached expiry.
 *   2. Snapshot portfolio net theta/vega.
 *   3. Per symbol: build the selector input, and on a `signal` decision enter
 *      the signalled structure (sized + risk-capped by the account).
 *   4. Snapshot the equity curve.
 * At the window tail, force-settle whatever remains.
 */
export function replayPhaseABucket(
  days: readonly ChainDay[],
  startingEquity: number,
  cfg: PhaseAReplayConfig,
): PhaseABucketResult {
  const account = new OptionsReplayAccount({
    initialEquity: startingEquity,
    managedAccountRatio: cfg.managedAccountRatio,
    optionsDailyTradesLimit: cfg.optionsDailyTradesLimit,
    // OTM/RV scanner params are unused on the Phase-A path (no single-leg
    // scanner entries are opened) — pass the live defaults to satisfy the type.
    otmRiskParams: OTM_RISK_PARAMS,
    rvRiskParams: RV_RISK_PARAMS,
    spreadRiskParams: cfg.spreadRiskParams,
  });

  const histBySym = new Map<string, number[]>();
  const greeksSeries: PortfolioGreeksSample[] = [];
  let unpriceableSignals = 0;
  let signalCount = 0;

  for (const day of days) {
    account.startDay(day.date);
    const halfSpreadIndex = buildLegHalfSpreadIndex(day);
    const ivIndex = buildLegIvIndex(day);
    const spotBySymbol = spotsForDay(day);
    const nowMs = dayMs(day.date);
    // TRA-926 — mark open spreads with the exact chain mid when quoted, else a
    // Black-Scholes reprice from spot + nearest-strike IV (no `-maxLoss` fallback
    // for a leg the snapshot simply doesn't carry).
    const legMid = buildLegRepricer(day, spotBySymbol, cfg.features.riskFreeRate);

    // 1. Mid-life management, then expiry settlement.
    account.markAndManageSpreads(day.date, nowMs, legMid, cfg.management);
    account.settleSpreads(day.date, spotBySymbol);

    // 2. Greeks snapshot of what is still open after management.
    greeksSeries.push(
      portfolioGreeksForDay(day.date, account.getOpenPositions(), spotBySymbol, ivIndex, cfg.features.riskFreeRate),
    );

    // 3. Phase-A entries.
    for (const file of day.bySymbol.values()) {
      const spot = resolveSpot(file);
      if (spot == null || !Number.isFinite(spot) || spot <= 0) continue;
      const sym = file.symbol.toUpperCase();
      const hist = histBySym.get(sym) ?? [];
      hist.push(spot);
      histBySym.set(sym, hist);

      const input = buildSelectorInput(file, spot, hist, day.date, cfg.selectorParams, cfg.features);
      if (!input) continue;
      const result = selectShadowOptionSignal(input, cfg.selectorParams);
      if (result.decision !== 'signal') continue;
      signalCount += 1;

      const halfSpreadOf = (leg: ShadowOptionSignal['legs'][number]): number | null =>
        halfSpreadIndex.get(legKey(sym, { optionType: leg.optionType, strike: leg.strike, expiration: input.expiration })) ?? null;
      const candidate = modelSignalStructure(result.signal, cfg.fill, halfSpreadOf);
      if (!candidate) {
        unpriceableSignals += 1;
        continue;
      }
      account.openSpread({ ...candidate, spot });
    }

    account.recordEquityForDay(day.date);
  }

  // Tail: force-settle any spread still open at the last day's spots.
  const lastDay = days[days.length - 1];
  if (lastDay) account.settleSpreads(lastDay.date, spotsForDay(lastDay), { force: true });

  const closed = [...account.getClosedPositions()];
  const modeledSlippageTotal = r2(closed.reduce((a, p) => a + (p.modeledSlippage ?? 0), 0));
  return {
    startingEquity,
    managedAccountRatio: cfg.managedAccountRatio,
    closed,
    equityCurve: [...account.getEquityCurve()],
    greeksSeries,
    modeledSlippageTotal,
    unpriceableSignals,
    signalCount,
    managedExitsTotal: account.getManagedExitsTotal(),
    unpricedManagedExits: account.getUnpricedManagedExits(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Gate report assembly (G5)
// ───────────────────────────────────────────────────────────────────────────

export type ReplayMode = 'synthetic' | 'recorded';

/** Per-strategy + pooled gate metrics, plus the parallel paper-accrual block. */
export interface PhaseAGateReport {
  mode: ReplayMode;
  startingEquity: number;
  tradeCount: number;
  /** Pooled BacktestGateMetrics across all strategies. */
  pooled: BacktestGateMetrics;
  /** Per-strategy BacktestGateMetrics, keyed by structure id. */
  byStrategy: Record<string, BacktestGateMetrics>;
  /** Parallel paper-accrual block in PaperGateMetrics shape (empty on synthetic). */
  paperAccrual: {
    mode: ReplayMode;
    pooled: PaperGateMetrics;
    byStrategy: Record<string, PaperGateMetrics>;
  };
  greeks: {
    series: PortfolioGreeksSample[];
    summary: GreeksSummary;
  };
  modeledSlippageTotal: number;
  /**
   * TRA-926 — mark-to-market health of the replay. `unpricedManagedExits` is the
   * count of managed-spread closes that fell back to `-maxLoss` for want of a
   * priced mark; `managedExitsTotal` is all managed closes. A non-trivial
   * `unpricedManagedExits / managedExitsTotal` share means the chains drifted off
   * the opened legs and the metrics above are an artifact — the gate must reject
   * such a report rather than trust it.
   */
  diagnostics: {
    unpricedManagedExits: number;
    managedExitsTotal: number;
  };
}

/**
 * Assemble the promotion-gate-consumable report for one bucket. Every closed
 * spread maps onto `BacktestGateMetrics` (R-multiple expectancy etc.); the
 * `paperAccrual` block is computed from `forwardPaperTrades` when supplied
 * (PaperGateMetrics shape) and otherwise emitted empty. `mode` tags the whole
 * report so the gate never mistakes a synthetic backtest for real paper accrual.
 */
export function buildPhaseAGateReport(
  bucket: PhaseABucketResult,
  mode: ReplayMode,
  forwardPaperTrades?: readonly PromotionTradeSample[],
): PhaseAGateReport {
  const byStrategyClosed = new Map<string, ReplayPosition[]>();
  for (const p of bucket.closed) {
    const key = p.spreadStrategy ?? p.signalType;
    const slot = byStrategyClosed.get(key) ?? [];
    slot.push(p);
    byStrategyClosed.set(key, slot);
  }

  const byStrategy: Record<string, BacktestGateMetrics> = {};
  for (const [strategy, positions] of byStrategyClosed) {
    byStrategy[strategy] = computeBacktestGateMetrics(positions, bucket.startingEquity);
  }

  const hasForward = !!forwardPaperTrades && forwardPaperTrades.length > 0;
  const paperPooled = hasForward ? computePaperGateMetrics(forwardPaperTrades!) : emptyPaperGateMetrics();
  const paperByStrategy: Record<string, PaperGateMetrics> = {};
  if (hasForward) paperByStrategy.pooled = paperPooled;

  return {
    mode,
    startingEquity: bucket.startingEquity,
    tradeCount: bucket.closed.length,
    pooled: computeBacktestGateMetrics(bucket.closed, bucket.startingEquity),
    byStrategy,
    paperAccrual: {
      mode: hasForward ? mode : 'synthetic',
      pooled: paperPooled,
      byStrategy: paperByStrategy,
    },
    greeks: {
      series: bucket.greeksSeries,
      summary: summarizeGreeks(bucket.greeksSeries),
    },
    modeledSlippageTotal: bucket.modeledSlippageTotal,
    diagnostics: {
      unpricedManagedExits: bucket.unpricedManagedExits,
      managedExitsTotal: bucket.managedExitsTotal,
    },
  };
}

const BACKTEST_METRIC_KEYS: readonly (keyof BacktestGateMetrics)[] = [
  'sharpe', 'expectancy', 'profitFactor', 'maxDrawdown', 'tradeCount',
];
const PAPER_METRIC_KEYS: readonly (keyof PaperGateMetrics)[] = [
  'tradeCount', 'expectancy', 'sharpe', 'profitFactor', 'slippageRatio', 'slippageSampleSize',
];

/** Structural validation that a report's metric blocks match the gate field shapes (G5 acceptance #2). */
export function validateGateReportShape(report: PhaseAGateReport): string[] {
  const errors: string[] = [];
  const checkBacktest = (label: string, m: BacktestGateMetrics): void => {
    for (const k of BACKTEST_METRIC_KEYS) {
      if (typeof m[k] !== 'number' || !Number.isFinite(m[k])) errors.push(`${label}.${k} not a finite number`);
    }
  };
  const checkPaper = (label: string, m: PaperGateMetrics): void => {
    if (typeof m.tradeCount !== 'number') errors.push(`${label}.tradeCount not a number`);
    if (typeof m.expectancy !== 'number') errors.push(`${label}.expectancy not a number`);
    if (!(m.sharpe === null || typeof m.sharpe === 'number')) errors.push(`${label}.sharpe not number|null`);
    if (typeof m.profitFactor !== 'number') errors.push(`${label}.profitFactor not a number`);
    if (!(m.slippageRatio === null || typeof m.slippageRatio === 'number')) errors.push(`${label}.slippageRatio not number|null`);
    if (typeof m.slippageSampleSize !== 'number') errors.push(`${label}.slippageSampleSize not a number`);
    // Exhaustiveness: no stray keys beyond the PaperGateMetrics contract.
    for (const k of Object.keys(m)) if (!(PAPER_METRIC_KEYS as readonly string[]).includes(k)) errors.push(`${label} has stray key ${k}`);
  };
  if (report.mode !== 'synthetic' && report.mode !== 'recorded') errors.push('mode not synthetic|recorded');
  checkBacktest('pooled', report.pooled);
  for (const [s, m] of Object.entries(report.byStrategy)) checkBacktest(`byStrategy.${s}`, m);
  checkPaper('paperAccrual.pooled', report.paperAccrual.pooled);
  for (const [s, m] of Object.entries(report.paperAccrual.byStrategy)) checkPaper(`paperAccrual.byStrategy.${s}`, m);
  return errors;
}

// ───────────────────────────────────────────────────────────────────────────
// Default config + top-level runner
// ───────────────────────────────────────────────────────────────────────────

export function defaultPhaseAConfig(
  selectorParams: StrategySelectorParams,
  spreadRiskParams: Record<ReplaySpreadStrategy, SpreadRiskParams>,
  initialEquity: number,
): PhaseAReplayConfig {
  return {
    initialEquity,
    managedAccountRatio: 0.5,
    optionsDailyTradesLimit: 10,
    spreadRiskParams,
    selectorParams,
    management: DEFAULT_SPREAD_MANAGEMENT,
    fill: DEFAULT_SIGNAL_FILL,
    features: DEFAULT_PHASEA_FEATURES,
  };
}

/** Markdown summary for the Phase-A backtest (human-readable companion to the JSON). */
export function buildPhaseAMarkdown(args: {
  report: PhaseAGateReport;
  daysReplayed: number;
  symbolsCount: number;
  generatedAt: number;
}): string {
  const { report, daysReplayed, symbolsCount, generatedAt } = args;
  const m = report.pooled;
  const g = report.greeks.summary;
  const md: string[] = [];
  md.push('# Phase-A option backtest — TRA-918 (TRA-908 Phase D)');
  md.push('');
  md.push(
    `Replayed **${daysReplayed} day(s)** of \`${report.mode}\` chains across ` +
      `**${symbolsCount} symbol(s)**, starting equity $${report.startingEquity}. ` +
      `Generated ${new Date(generatedAt).toISOString()}.`,
  );
  md.push('');
  md.push(
    'Entries are driven by the TRA-911 Phase-A selector (`selectShadowOptionSignal`); ' +
      'the signalled structure is entered verbatim and managed mid-life (50%-profit take, ' +
      'credit/debit stop, 21-DTE time stop). Fills are at mid net of a per-leg slippage ' +
      'haircut + commission.',
  );
  md.push('');
  md.push('## Pooled gate metrics (BacktestGateMetrics shape)');
  md.push('');
  md.push('| Metric | Value |');
  md.push('|---|---:|');
  md.push(`| Trades | ${m.tradeCount} |`);
  md.push(`| Expectancy (avg R) | ${m.expectancy} |`);
  md.push(`| Sharpe (per-trade) | ${m.sharpe} |`);
  md.push(`| Profit factor | ${m.profitFactor} |`);
  md.push(`| Max drawdown (frac) | ${m.maxDrawdown} |`);
  md.push(`| Modeled slippage ($) | ${report.modeledSlippageTotal} |`);
  const dx = report.diagnostics;
  const unpricedShare = dx.managedExitsTotal > 0 ? dx.unpricedManagedExits / dx.managedExitsTotal : 0;
  md.push(
    `| Unpriced managed exits | ${dx.unpricedManagedExits}/${dx.managedExitsTotal} ` +
      `(${(unpricedShare * 100).toFixed(1)}%) |`,
  );
  md.push('');
  if (unpricedShare > 0.05) {
    md.push(
      `> **WARNING (TRA-926):** ${(unpricedShare * 100).toFixed(1)}% of managed exits booked the ` +
        '`-maxLoss` fallback for want of a priced mark — the chains drifted off the opened legs and ' +
        'these metrics are an ARTIFACT. Do NOT feed this report to the promotion gate.',
    );
    md.push('');
  }
  md.push('## Per-strategy gate metrics');
  md.push('');
  const strategies = Object.keys(report.byStrategy);
  if (strategies.length === 0) {
    md.push('_No structures traded._');
  } else {
    md.push('| Strategy | Trades | Expectancy (R) | Sharpe | Profit factor | Max DD (frac) |');
    md.push('|---|---:|---:|---:|---:|---:|');
    for (const s of strategies) {
      const x = report.byStrategy[s]!;
      md.push(`| ${s} | ${x.tradeCount} | ${x.expectancy} | ${x.sharpe} | ${x.profitFactor} | ${x.maxDrawdown} |`);
    }
  }
  md.push('');
  md.push('## Theta / vega exposure over time');
  md.push('');
  md.push('| | Mean | Min | Max | At peak exposure |');
  md.push('|---|---:|---:|---:|---:|');
  md.push(`| Net theta ($/day) | ${g.meanTheta} | ${g.minTheta} | ${g.maxTheta} | ${g.thetaAtPeak} |`);
  md.push(`| Net vega ($/vol-pt) | ${g.meanVega} | ${g.minVega} | ${g.maxVega} | ${g.vegaAtPeak} |`);
  md.push(`Peak-exposure day: ${g.peakDay ?? 'n/a'}.`);
  md.push('');
  md.push(
    `Paper accrual: \`mode: ${report.paperAccrual.mode}\`, ` +
      `${report.paperAccrual.pooled.tradeCount} forward trade(s) ` +
      '(empty until TRA-382 real-chain forward paper data exists).',
  );
  md.push('');
  return md.join('\n') + '\n';
}
