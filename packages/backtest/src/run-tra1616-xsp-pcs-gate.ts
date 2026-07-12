/**
 * TRA-1616 — OOS backtest of the TRA-1613 "$100 New Options Strategy" (XSP 1-wide
 * ATM put-credit-spread + 20-day-SMA regime filter) through the TRA-532 promotion
 * gate (Stage-1).
 *
 * Parent TRA-1613 tore down the SMB / optionsclass.com "$100 options" video and
 * rendered a marketing verdict of NO-TRADE-as-is (negative 0.55:1 skew, a weak
 * close-based stop, no fees). This harness converts that qualitative teardown into
 * a QUANTITATIVE, gate-ingestible verdict: it models the exact rules the video
 * sells per the machine-testable TRA-1615 spec, prices them on real SPX daily bars
 * (÷10 → XSP terms, since XSP cash-settles to SPX/10) spanning every regime
 * 2015-2025 (incl. Q4-2018, Mar-2020, all-2022, Aug-2024, Apr-2025), and runs the
 * result through the TRA-540 six-guard overfitting battery so the Stage-1 PASS/FAIL
 * is the gate's own, never a hand-entered claim (TRA-527 §3).
 *
 * It deliberately mirrors the QQQ-track harness `run-tra1617-qqq-pcs-gate.ts` so
 * the two credit-spread verdicts are apples-to-apples (same IV/vol engine, same
 * per-leg commission, same widening bid/ask fills, same guard battery).
 *
 * Modeled rules (verbatim from the TRA-1615 spec):
 *   • Regime filter (§2): 20-day SMA state machine, one position at a time. ENTRY
 *     on the up-cross (close > SMA20 AND prior close ≤ SMA20). EXIT on the first of
 *     (E1) a clean close back below SMA20, or (E2) the DTE expiry (cash-settle).
 *   • Structure (§3): 1-wide ATM put credit spread — sell the first listed strike
 *     ≤ spot, buy one strike ($1) lower. Width = 1.0 index point = $100 max
 *     structural risk. DTE = 14 calendar (≈ 10 trading) days.
 *   • Credit must be > 0 or the signal is skipped; a new entry while in-market is
 *     ignored (one position at a time).
 *
 * Realism (spec §1/§4 must-haves):
 *   • Black-Scholes marks (engine `blackScholesPrice`/`blackScholesDelta`) on a
 *     realized-vol IV model (VRP 1.05, floor 0.10 — identical to TRA-1617). Real
 *     ≥12-mo XSP option chains do not exist; BS-on-real-bars is the board-ratified
 *     stand-in (TRA-731 basis).
 *   • Per-leg commissions ($0.65/contract) on every open AND close → a full
 *     round-trip of the 2-leg spread = 4 × $0.65 = $2.60. A worthless expiry pays
 *     no exit commission (nothing to close).
 *   • Bid/ask fills with a spread that WIDENS for cheap options, with a 1-tick
 *     ($0.05) floor on every leg — the near-worthless long wing is bought rich /
 *     sold cheap, the leg the video's mid-price math hand-waves.
 *   • Every fill is next-marketable; no mid-price fantasy.
 *
 * The unit of the gate is one spread; expectancy is per-spread R = pnl / riskDollars.
 *
 * Emits `reports/tra1616-xsp-pcs-gate.json` with the full metrics + regime split
 * + the 9-trial grid + the six-guard verdict, and the ready-to-POST registration
 * body for
 *   POST /api/promotion/optimization  { strategyId, reportId, verdict }
 * (admin-only). Registering does NOT flip any live flag — Stage-2 (≥50 paper) +
 * Stage-3 board sign-off still gate any live transition (TRA-532).
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra1616-xsp-pcs-gate.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { blackScholesPrice } from '@trading-app/engine';
import { evaluateBacktestGate, type BacktestGateVerdict } from '@trading-app/shared';
import { deflatedSharpeRatio, probabilityOfBacktestOverfitting } from './overfitting-stats.js';
import type { OptimizationVerdict, BacktestVerdictMetrics } from './run-optimization.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const REPORT_DIR = resolve(HERE, '..', 'reports');

// ── Model constants (TRA-1615 spec §1/§3/§4/§6) ───────────────────────────────
const R_FREE = 0.045; // risk-free rate for the pricer
const XSP_DIVISOR = 10; // XSP cash-settles to SPX/10; ÷10 the SPX bars at load
const WIDTH = 1.0; // 1-wide spread — the 1-point wing = $100 max structural risk
const DTE_CAL = 14; // primary DTE (calendar days); §3
const COMM = 0.65; // $/contract commission, charged on every leg open AND close
const RV_WINDOW = 20; // realized-vol lookback (bars) for the IV model
const SMA_WINDOW = 20; // 20-day SMA regime filter (§2)
const VRP = 1.05; // vol-risk-premium: IV trades slightly rich to realized
const IV_FLOOR = 0.10; // annualized IV floor
const TICK = 0.05; // 1 XSP tick = $0.05 (the slippage floor, §4)
const MULT = 100; // index-point contract multiplier
const WORKING_BASE = 300; // §6 working base for the $-drawdown curve (video's stated base)
const TRADING_DAYS_YEAR = 252;
const ANALYSIS_START = '2015-01-01'; // §1 span start; the cache carries a ~1mo Dec-2014 SMA warmup lead

/** Calendar DTE → modeled trading-day expiry offset (14→10, 7→5, 21→15). */
function tradingDte(calendarDte: number): number {
  return Math.max(1, Math.round((calendarDte * 5) / 7));
}

// ── Cache loader (deterministic, no network) — SPX ÷10 → XSP terms ────────────
interface CacheEntry { symbol: string; start: number; end: number; candles: Candle[] }

/** Load cached SPX daily bars and scale OHLC ÷10 into XSP terms (XSP = SPX/10). */
function loadXspBars(): Candle[] {
  const path = resolve(DATA_DIR, '^gspc.json');
  if (!existsSync(path)) {
    throw new Error(`No SPX daily cache at ${path} — run the ^GSPC Yahoo fetch first (loadOrFetchDailyBars).`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
  return raw.candles
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((c) => ({
      symbol: 'XSP',
      timestamp: c.timestamp,
      open: c.open / XSP_DIVISOR,
      high: c.high / XSP_DIVISOR,
      low: c.low / XSP_DIVISOR,
      close: c.close / XSP_DIVISOR,
      volume: c.volume,
    }));
}

// ── Black-Scholes put pricing + realized-vol IV model ─────────────────────────
function bsPut(spot: number, K: number, dteDays: number, sigma: number): number {
  return blackScholesPrice({
    spot, strike: K, timeToExpiryYears: Math.max(dteDays, 0) / 365,
    riskFreeRate: R_FREE, volatility: sigma, optionType: 'put',
  });
}

/** Annualized realized volatility over the trailing RV_WINDOW closes ending at i. */
function realizedVol(closes: readonly number[], i: number, window = RV_WINDOW): number | null {
  if (i < window) return null;
  const rr: number[] = [];
  for (let k = i - window + 1; k <= i; k++) {
    const prev = closes[k - 1]!;
    const cur = closes[k]!;
    if (prev > 0 && cur > 0) rr.push(Math.log(cur / prev));
  }
  if (rr.length < 2) return null;
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
  const v = rr.reduce((a, b) => a + (b - mean) ** 2, 0) / (rr.length - 1);
  return Math.sqrt(v * TRADING_DAYS_YEAR);
}

/** IV used for pricing on a given bar: realized vol × VRP, floored. */
function ivAt(closes: readonly number[], i: number): number | null {
  const rv = realizedVol(closes, i);
  if (rv == null) return null;
  return Math.max(IV_FLOOR, rv * VRP);
}

// ── Bid/ask fills — relative spread WIDENS for cheap options, 1-tick floor ─────
/** Half bid/ask spread ($) for a given mid, with the 1-XSP-tick floor (§4). */
function halfSpread(mid: number, slipMult = 1): number {
  const rel = mid < 0.2 ? 0.25 : mid < 1 ? 0.08 : 0.04;
  return Math.max(TICK, mid * rel) * slipMult;
}
/** Price you SELL at (you cross to the bid). */
function sellFill(mid: number, slipMult = 1): number {
  return Math.max(0.01, mid - halfSpread(mid, slipMult));
}
/** Price you BUY at (you cross to the ask). */
function buyFill(mid: number, slipMult = 1): number {
  return mid + halfSpread(mid, slipMult);
}

// ── 20-day SMA (§2) ────────────────────────────────────────────────────────────
function sma(closes: readonly number[], i: number, window = SMA_WINDOW): number | null {
  if (i < window - 1) return null;
  let s = 0;
  for (let k = i - window + 1; k <= i; k++) s += closes[k]!;
  return s / window;
}

// ── Regime tagging (§7 — crisis windows are first-class) ───────────────────────
interface Regime { key: string; from: string; to: string }
const REGIMES: Regime[] = [
  { key: '2015-2017 grind-up', from: '2015-01-01', to: '2018-09-30' },
  { key: 'Q4-2018 selloff', from: '2018-10-01', to: '2018-12-31' },
  { key: '2019 recovery', from: '2019-01-01', to: '2020-02-19' },
  { key: 'Mar-2020 COVID crash', from: '2020-02-20', to: '2020-04-30' },
  { key: '2020-2021 melt-up', from: '2020-05-01', to: '2021-12-31' },
  { key: '2022 bear', from: '2022-01-01', to: '2022-12-31' },
  { key: '2023-2024H1 bull', from: '2023-01-01', to: '2024-07-31' },
  { key: 'Aug-2024 VIX spike', from: '2024-08-01', to: '2024-08-31' },
  { key: '2024H2-2025Q1', from: '2024-09-01', to: '2025-03-31' },
  { key: 'Apr-2025 tariff crash', from: '2025-04-01', to: '2025-04-30' },
  { key: '2025 remainder', from: '2025-05-01', to: '2025-12-31' },
];
function regimeOf(ts: number): string {
  const iso = new Date(ts).toISOString().slice(0, 10);
  for (const r of REGIMES) if (iso >= r.from && iso <= r.to) return r.key;
  return 'other';
}
/** Crisis windows for the G5 holdout guard (the regimes a PCS bleeds). */
const CRISIS_REGIMES = new Set(['2022 bear', 'Aug-2024 VIX spike', 'Apr-2025 tariff crash']);

// ── Strategy state machine ─────────────────────────────────────────────────────
export interface StrategyParams {
  dteCal: number; // calendar DTE (primary 14; trials 7/21)
  strikeOffset: number; // 0 = ATM (first strike ≤ spot); 1 = ATM−1; 2 = ATM−2
  slipMult: number; // 1 = base; >1 = cost/slippage stress (G6)
}

export const PRIMARY_PARAMS: StrategyParams = { dteCal: DTE_CAL, strikeOffset: 0, slipMult: 1 };

export interface SpreadTrade {
  entryIdx: number;
  date: string;
  regime: string;
  shortK: number;
  longK: number;
  credit: number; // per-share net credit received (after §4 entry fills)
  pnl: number; // total $ P&L of the spread (net comm/slippage)
  riskDollars: number; // defined max loss = (WIDTH − credit) × 100
  R: number; // pnl / riskDollars
  holdDays: number; // trading bars held
  outcome: 'expired_otm' | 'expired_itm' | 'regime_exit';
}

/** First listed $1 strike ≤ spot, shifted down by `offset` strikes. */
function atmShortStrike(spot: number, offset: number): number {
  return Math.floor(spot) - offset;
}

/**
 * Run the XSP 1-wide ATM PCS + 20-SMA state machine over the daily bars.
 * One position at a time; entries fire only on a clean up-cross while flat.
 */
export function runStrategy(bars: Candle[], params: StrategyParams): SpreadTrade[] {
  const closes = bars.map((b) => b.close);
  const n = bars.length;
  const trades: SpreadTrade[] = [];
  const dteBars = tradingDte(params.dteCal);

  let inMarket = false;
  let holdUntil = -1; // set while a position is open so we skip re-entry (one at a time)

  for (let i = SMA_WINDOW; i < n; i++) {
    if (inMarket) {
      // Position management is done inline at open (below); the outer loop only
      // needs to know when the position closed so it can look for the next entry.
      if (i < holdUntil) continue;
      inMarket = false; // the open() call already advanced past the close bar
    }

    const smaNow = sma(closes, i);
    const smaPrev = sma(closes, i - 1);
    if (smaNow == null || smaPrev == null) continue;

    // ENTRY (§2): clean up-cross — this bar closes above, prior bar closed at/below.
    const upCross = closes[i]! > smaNow && closes[i - 1]! <= smaPrev;
    if (!upCross) continue;

    const sigma = ivAt(closes, i);
    if (sigma == null) continue;
    const spot = bars[i]!.close;

    const shortK = atmShortStrike(spot, params.strikeOffset);
    const longK = shortK - WIDTH;
    if (longK <= 0) continue;

    // Entry fills: sell the short put (to the bid), buy the long put (at the ask).
    const credit =
      sellFill(bsPut(spot, shortK, dteBars, sigma), params.slipMult) -
      buyFill(bsPut(spot, longK, dteBars, sigma), params.slipMult);
    if (!(credit > 0)) continue; // no net credit → the rule never takes it
    const entryComm = 2 * COMM;
    const expiryIdx = Math.min(n - 1, i + dteBars);

    let outcome: SpreadTrade['outcome'] = 'expired_otm';
    let pnl = 0;
    let closeIdx = expiryIdx;

    // Walk the position day by day. E1 (regime exit) can fire before expiry; at
    // the expiry bar the spread cash-settles (E2), whichever comes first.
    for (let j = i + 1; j <= expiryIdx; j++) {
      const smaJ = sma(closes, j);
      const dteRem = Math.max(expiryIdx - j, 0) + 0.5; // half-day so the expiry bar keeps some theta
      const sigJ = ivAt(closes, j) ?? sigma;

      if (j < expiryIdx && smaJ != null && bars[j]!.close < smaJ) {
        // (E1) Regime exit — close the spread at this bar's marks. Cost-to-close is
        // capped at the width: a defined-risk vertical's remaining max loss is the
        // width, so a rational operator holds to expiry rather than paying MORE than
        // that to close (per-leg proportional slippage on deep-ITM legs would
        // otherwise imply losing >1R on a $100-risk spread, which is uncloseable in
        // practice). The cap keeps E1 losses bounded at ~−1R, consistent with the E2
        // intrinsic settlement, while still charging the exit commissions.
        const rawCostToClose =
          buyFill(bsPut(bars[j]!.close, shortK, dteRem, sigJ), params.slipMult) -
          sellFill(bsPut(bars[j]!.close, longK, dteRem, sigJ), params.slipMult);
        const costToClose = Math.min(Math.max(0, rawCostToClose), WIDTH);
        pnl = (credit - costToClose) * MULT - entryComm - 2 * COMM;
        outcome = 'regime_exit';
        closeIdx = j;
        break;
      }

      if (j === expiryIdx) {
        // (E2) Expiry — cash-settle at intrinsic on the settlement close.
        const settle = bars[j]!.close;
        if (settle >= shortK) {
          pnl = credit * MULT - entryComm; // worthless — keep full credit, no exit comm
          outcome = 'expired_otm';
        } else {
          const intrinsic = Math.min(WIDTH, shortK - settle);
          pnl = (credit - intrinsic) * MULT - entryComm - 2 * COMM;
          outcome = 'expired_itm';
        }
        closeIdx = j;
      }
    }

    const riskDollars = (WIDTH - credit) * MULT;
    trades.push({
      entryIdx: i,
      date: new Date(bars[i]!.timestamp).toISOString().slice(0, 10),
      regime: regimeOf(bars[i]!.timestamp),
      shortK, longK, credit,
      pnl, riskDollars, R: pnl / riskDollars,
      holdDays: closeIdx - i,
      outcome,
    });

    inMarket = true;
    holdUntil = closeIdx; // ignore any up-cross signals until the position closes
  }
  return trades;
}

// ── Metrics ────────────────────────────────────────────────────────────────────
export interface StrategyMetrics {
  tradeCount: number;
  winRate: number;
  avgCredit: number;
  expectancyR: number; // avg R per spread
  avgPnl: number; // avg $ per spread
  totalPnl: number;
  sharpe: number; // annualized (per-trade × √tradesPerYear)
  sortino: number;
  profitFactor: number;
  maxDrawdownPct: number; // on the $ equity curve vs WORKING_BASE
  maxDrawdownDollars: number;
  tailLoss: { worstR: number; p01R: number; p05R: number; worst5AvgR: number; tailRatio: number };
  avgHoldDays: number;
  itmExpiryRate: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx]!;
}

/** Trades per year implied by the span of the trade series (event-driven cadence). */
function tradesPerYear(trades: SpreadTrade[], bars: Candle[]): number {
  if (trades.length < 2) return trades.length;
  const first = bars[trades[0]!.entryIdx]!.timestamp;
  const last = bars[trades[trades.length - 1]!.entryIdx]!.timestamp;
  const years = (last - first) / (365.25 * 24 * 60 * 60 * 1000);
  return years > 0 ? trades.length / years : trades.length;
}

export function computeMetrics(trades: SpreadTrade[], bars: Candle[]): StrategyMetrics {
  const n = trades.length;
  const Rs = trades.map((t) => t.R);
  const pnls = trades.map((t) => t.pnl);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const mean = Rs.reduce((a, b) => a + b, 0) / (n || 1);
  const sd = Math.sqrt(Rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const downside = Rs.filter((r) => r < 0);
  const dd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / Math.max(1, n - 1));
  const tpy = tradesPerYear(trades, bars);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(tpy) : 0;
  const sortino = dd > 0 ? (mean / dd) * Math.sqrt(tpy) : 0;

  const grossWin = wins.reduce((a, b) => a + b.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // $ equity curve vs the fixed working base (§6).
  let eq = WORKING_BASE, peak = WORKING_BASE, maxDdDollars = 0, maxDdPct = 0;
  for (const t of trades) {
    eq += t.pnl;
    peak = Math.max(peak, eq);
    const ddD = peak - eq;
    if (ddD > maxDdDollars) maxDdDollars = ddD;
    if (peak > 0 && ddD / peak > maxDdPct) maxDdPct = ddD / peak;
  }

  const sortedR = Rs.slice().sort((a, b) => a - b);
  const worstR = sortedR[0] ?? 0;
  const worst5 = sortedR.slice(0, Math.max(1, Math.round(n * 0.05)));
  const worst5AvgR = worst5.reduce((a, b) => a + b, 0) / (worst5.length || 1);
  const avgWinR = wins.length ? wins.reduce((a, b) => a + b.R, 0) / wins.length : 0;
  const tailRatio = avgWinR !== 0 ? Math.abs(worstR / avgWinR) : Infinity;

  return {
    tradeCount: n,
    winRate: wins.length / (n || 1),
    avgCredit: trades.reduce((a, b) => a + b.credit, 0) / (n || 1),
    expectancyR: mean,
    avgPnl: pnls.reduce((a, b) => a + b, 0) / (n || 1),
    totalPnl: pnls.reduce((a, b) => a + b, 0),
    sharpe, sortino, profitFactor,
    maxDrawdownPct: maxDdPct,
    maxDrawdownDollars: maxDdDollars,
    tailLoss: { worstR, p01R: quantile(sortedR, 0.01), p05R: quantile(sortedR, 0.05), worst5AvgR, tailRatio },
    avgHoldDays: trades.reduce((a, b) => a + b.holdDays, 0) / (n || 1),
    itmExpiryRate: trades.filter((t) => t.outcome === 'expired_itm').length / (n || 1),
  };
}

// ── Trial grid (§8): DTE ∈ {7,14,21} × strikeOffset ∈ {ATM, ATM−1, ATM−2} = 9 ──
const DTE_TRIALS = [7, 14, 21];
const OFFSET_TRIALS = [0, 1, 2];

function perTradeSharpe(Rs: number[]): number {
  if (Rs.length < 2) return 0;
  const m = Rs.reduce((a, b) => a + b, 0) / Rs.length;
  const sd = Math.sqrt(Rs.reduce((a, b) => a + (b - m) ** 2, 0) / (Rs.length - 1));
  return sd > 0 ? m / sd : 0;
}

interface Trial { label: string; params: StrategyParams; trades: SpreadTrade[]; byEntry: Map<number, number> }

function runTrials(bars: Candle[]): Trial[] {
  const trials: Trial[] = [];
  for (const dte of DTE_TRIALS) {
    for (const off of OFFSET_TRIALS) {
      const params: StrategyParams = { dteCal: dte, strikeOffset: off, slipMult: 1 };
      const trades = runStrategy(bars, params).filter((t) => t.date >= ANALYSIS_START);
      trials.push({
        label: `${dte}DTE/ATM-${off}`, params, trades,
        byEntry: new Map(trades.map((t) => [t.entryIdx, t.R])),
      });
    }
  }
  return trials;
}

/** Deterministic stationary bootstrap CI lower bound of mean R (G4). */
function bootstrapMeanLowerBound(Rs: number[], iters = 2000, alpha = 0.05): number {
  if (Rs.length < 10) return -Infinity;
  const means: number[] = [];
  let seed = 1234567; // fixed LCG so the harness is reproducible (no Math.random)
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let k = 0; k < Rs.length; k++) s += Rs[Math.floor(rand() * Rs.length)]!;
    means.push(s / Rs.length);
  }
  means.sort((a, b) => a - b);
  return means[Math.floor(alpha * means.length)]!;
}

export interface Tra1616GateResult {
  primary: StrategyMetrics;
  perRegime: Array<{ regime: string; metrics: StrategyMetrics }>;
  guards: OptimizationVerdict['guards'];
  backtestMetrics: BacktestVerdictMetrics;
  verdict: OptimizationVerdict;
  gate: ReturnType<typeof evaluateBacktestGate>;
  oos: { isExpectancy: number; oosExpectancy: number; oosTradeCount: number; oosSharpe: number };
  trials: Array<{ label: string; expectancyR: number; sharpe: number; tradeCount: number }>;
}

export function computeTra1616Gate(bars: Candle[]): Tra1616GateResult {
  // Bars carry a ~1mo Dec-2014 warmup lead so SMA20/RV are defined on the first
  // 2015 bar; the analysis window is entries dated ≥ ANALYSIS_START.
  const inWindow = (t: SpreadTrade): boolean => t.date >= ANALYSIS_START;
  const primaryTrades = runStrategy(bars, PRIMARY_PARAMS).filter(inWindow);
  const primary = computeMetrics(primaryTrades, bars);

  const perRegime = REGIMES.map((r) => {
    const t = primaryTrades.filter((x) => x.regime === r.key);
    return { regime: r.key, metrics: computeMetrics(t, bars) };
  }).filter((x) => x.metrics.tradeCount > 0);

  const trials = runTrials(bars);
  const primaryR = primaryTrades.map((t) => t.R);

  // G1 — OOS holdout efficiency: IS (< 2022-01-01) vs OOS (≥ 2022-01-01) expectancy.
  const isTrades = primaryTrades.filter((t) => t.date < '2022-01-01');
  const oosTrades = primaryTrades.filter((t) => t.date >= '2022-01-01');
  const isExp = isTrades.length ? isTrades.reduce((a, b) => a + b.R, 0) / isTrades.length : 0;
  const oosExp = oosTrades.length ? oosTrades.reduce((a, b) => a + b.R, 0) / oosTrades.length : 0;
  const oosSharpe = perTradeSharpe(oosTrades.map((t) => t.R));
  const efficiency = isExp > 0 ? oosExp / isExp : oosExp > 0 ? 1 : 0;
  const g1Pass = efficiency >= 0.5 && oosExp > 0;

  // G2 — Deflated Sharpe Ratio (multiple-testing penalty across the 9 trials).
  const dsr = deflatedSharpeRatio({
    returns: primaryR,
    trialSharpes: trials.map((t) => perTradeSharpe(t.trades.map((x) => x.R))),
    trialCount: trials.length,
    threshold: 0.95,
  });

  // G3 — Probability of Backtest Overfitting (CSCV over the shared entry grid).
  const entries = Array.from(new Set(trials.flatMap((t) => t.trades.map((x) => x.entryIdx)))).sort((a, b) => a - b);
  const matrix = trials.map((t) => entries.map((e) => t.byEntry.get(e) ?? 0));
  const pbo = probabilityOfBacktestOverfitting({ matrix, partitions: 16, threshold: 0.5 });

  // G4 — bootstrap OOS floor: 5% CI lower bound of mean OOS R must be > 0.
  const g4Floor = bootstrapMeanLowerBound(oosTrades.map((t) => t.R));
  const g4Pass = g4Floor > 0;

  // G5 — crisis holdout: OOS Sharpe > 0 across the crisis regimes (2022 / Aug-24 / Apr-25).
  const crisisTrades = primaryTrades.filter((t) => CRISIS_REGIMES.has(t.regime));
  const crisisSharpe = perTradeSharpe(crisisTrades.map((t) => t.R));
  const g5Pass = crisisSharpe > 0;

  // G6 — cost/slippage stress: re-run with 1.5× spreads/comms; expectancy stays > 0.
  const stressed = computeMetrics(runStrategy(bars, { ...PRIMARY_PARAMS, slipMult: 1.5 }).filter(inWindow), bars);
  const g6Pass = stressed.expectancyR > 0;

  const guards: OptimizationVerdict['guards'] = {
    G1: { pass: g1Pass, value: Number(efficiency.toFixed(4)) },
    G2: { pass: dsr.pass, value: Number(dsr.psr.toFixed(4)) },
    G3: { pass: pbo.pass, value: Number(pbo.pbo.toFixed(4)) },
    G4: { pass: g4Pass, value: Number((Number.isFinite(g4Floor) ? g4Floor : -99).toFixed(4)) },
    G5: { pass: g5Pass, value: Number(crisisSharpe.toFixed(4)) },
    G6: { pass: g6Pass, value: Number(stressed.expectancyR.toFixed(4)) },
  };
  const verdictPass = Object.values(guards).every((g) => g.pass);

  const backtestMetrics: BacktestVerdictMetrics = {
    sharpe: Number(primary.sharpe.toFixed(4)),
    expectancy: Number(primary.expectancyR.toFixed(4)),
    profitFactor: Number((Number.isFinite(primary.profitFactor) ? primary.profitFactor : 99).toFixed(4)),
    maxDrawdown: Number(primary.maxDrawdownPct.toFixed(4)),
    tradeCount: primary.tradeCount,
  };

  const verdict: OptimizationVerdict = {
    pass: verdictPass,
    guards,
    blessedParams: { strategy: 'xsp_atm_pcs_sma20', ...PRIMARY_PARAMS },
    backtestMetrics,
  };

  const gate = evaluateBacktestGate(
    { sharpe: backtestMetrics.sharpe, expectancy: backtestMetrics.expectancy, profitFactor: backtestMetrics.profitFactor, maxDrawdown: backtestMetrics.maxDrawdown, tradeCount: backtestMetrics.tradeCount },
    undefined,
    { pass: verdict.pass, guards: verdict.guards } as BacktestGateVerdict,
  );

  return {
    primary, perRegime, guards, backtestMetrics, verdict, gate,
    oos: { isExpectancy: Number(isExp.toFixed(4)), oosExpectancy: Number(oosExp.toFixed(4)), oosTradeCount: oosTrades.length, oosSharpe: Number(oosSharpe.toFixed(4)) },
    trials: trials.map((t) => {
      const m = computeMetrics(t.trades, bars);
      return { label: t.label, expectancyR: Number(m.expectancyR.toFixed(4)), sharpe: Number(m.sharpe.toFixed(3)), tradeCount: m.tradeCount };
    }),
  };
}

// ── Reporting ──────────────────────────────────────────────────────────────────
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

function main(): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  // Full cache carries a ~1mo Dec-2014 warmup lead; computeTra1616Gate windows the
  // analysis to entries dated ≥ 2015-01-01.
  const bars = loadXspBars();
  const res = computeTra1616Gate(bars);
  const m = res.primary;

  console.log('\n=== TRA-1616 — XSP 1-wide ATM PCS + 20-SMA (2015-2025 OOS) ===');
  console.log(`  span                 ${ANALYSIS_START} → ${new Date(bars[bars.length - 1]!.timestamp).toISOString().slice(0, 10)}  (SPX ÷10 → XSP)`);
  console.log(`  spreads (trades)     ${m.tradeCount}`);
  console.log(`  win rate             ${pct(m.winRate)}`);
  console.log(`  avg credit           $${m.avgCredit.toFixed(2)}/share ($${(m.avgCredit * MULT).toFixed(0)}/spread)`);
  console.log(`  expectancy           ${m.expectancyR.toFixed(4)} R/spread  ($${m.avgPnl.toFixed(2)}/spread)`);
  console.log(`  total P&L            $${m.totalPnl.toFixed(0)}`);
  console.log(`  profit factor        ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}`);
  console.log(`  Sharpe (ann.)        ${m.sharpe.toFixed(2)}   Sortino ${m.sortino.toFixed(2)}`);
  console.log(`  max drawdown         ${pct(m.maxDrawdownPct)}  ($${m.maxDrawdownDollars.toFixed(0)} on $${WORKING_BASE} base)`);
  console.log(`  avg hold             ${m.avgHoldDays.toFixed(1)} bars   ITM-expiry ${pct(m.itmExpiryRate)}`);
  console.log(`  TAIL  worstR ${m.tailLoss.worstR.toFixed(2)}  p05R ${m.tailLoss.p05R.toFixed(2)}  worst-5% avg ${m.tailLoss.worst5AvgR.toFixed(2)}  tail:win ${Number.isFinite(m.tailLoss.tailRatio) ? m.tailLoss.tailRatio.toFixed(1) : '∞'}:1`);

  console.log('\n  ── regime split ──');
  for (const r of res.perRegime) {
    const rm = r.metrics;
    console.log(`  ${r.regime.padEnd(22)} n=${String(rm.tradeCount).padStart(3)}  win ${pct(rm.winRate).padStart(6)}  exp ${rm.expectancyR.toFixed(3)}R  worstR ${rm.tailLoss.worstR.toFixed(2)}  P&L $${rm.totalPnl.toFixed(0)}`);
  }

  console.log('\n  ── OOS split (IS < 2022 | OOS ≥ 2022) ──');
  console.log(`  IS exp ${res.oos.isExpectancy}R   OOS exp ${res.oos.oosExpectancy}R   OOS n=${res.oos.oosTradeCount}   OOS Sharpe ${res.oos.oosSharpe}`);

  console.log('\n  ── six-guard overfitting battery (TRA-540) ──');
  for (const [id, g] of Object.entries(res.guards)) console.log(`  ${id}  ${g.pass ? 'PASS' : 'FAIL'}  value=${g.value}`);
  console.log(`\n  VERDICT              ${res.verdict.pass ? 'PASS' : 'FAIL'}`);
  console.log(`  GATE (Stage-1)       ${res.gate.state.toUpperCase()}`);
  for (const c of res.gate.failedChecks) console.log(`     ✗ ${c}`);

  const reportId = 'TRA-1616-xsp-atm-pcs-2015-2025';
  const payload = {
    generatedAt: new Date().toISOString(),
    issue: 'TRA-1616',
    spec: 'TRA-1615',
    strategyId: 'xsp_atm_pcs_sma20',
    dataset: 'SPX (^GSPC) daily bars (Yahoo) ÷10 → XSP terms, 2015-01-01 → 2025-12-30, on-disk cache',
    model: 'Black-Scholes on realized-vol IV (VRP 1.05, floor 0.10); per-leg $0.65 comm; widening bid/ask fills, 1-tick ($0.05) floor',
    workingBase: WORKING_BASE,
    params: PRIMARY_PARAMS,
    metrics: m,
    perRegime: res.perRegime,
    oos: res.oos,
    trials: res.trials,
    guards: res.guards,
    backtestMetrics: res.backtestMetrics,
    verdict: res.verdict,
    gate: res.gate,
    // Ready-to-POST body for POST /api/promotion/optimization (admin). Registering
    // it does NOT flip any live flag — Stage-2 (≥50 paper) + Stage-3 sign-off still
    // gate any live transition (TRA-532).
    registrationBody: { strategyId: 'xsp_atm_pcs_sma20', reportId, verdict: res.verdict },
  };
  const out = resolve(REPORT_DIR, 'tra1616-xsp-pcs-gate.json');
  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${out}`);
}

const invoked = process.argv[1] && /run-tra1616-xsp-pcs-gate\.(ts|js)$/.test(process.argv[1]);
if (invoked) main();
