/**
 * TRA-1617 — OOS backtest of the TRA-1614 "small-account options income" strategy
 * (weekly QQQ 25-wide put-credit-spread + call-side rescue) through the TRA-532
 * promotion gate (Stage-1).
 *
 * Parent TRA-1614 tore down the SMB "$500/wk small account" video and rendered a
 * marketing verdict of NO-TRADE-as-marketed (capital misrepresented ~5×, a ~41:1
 * tail, a single bull sample, a martingale-style rescue). This harness converts
 * that qualitative teardown into a QUANTITATIVE, gate-ingestible verdict: it
 * models the exact rules the video sells, prices them on real QQQ daily bars
 * spanning every regime 2015-2025 (incl. Q4-2018, Mar-2020, all-2022, Aug-2024),
 * and runs the result through the TRA-540 six-guard overfitting battery so the
 * Stage-1 PASS/FAIL is the gate's own, never a hand-entered claim (TRA-527 §3).
 *
 * Modeled rules (verbatim from the TRA-1617 spec / TRA-1614 teardown):
 *   • Every Friday: sell a 25-wide QQQ put credit spread, short put ~10-15Δ
 *     (~$0.60 marketed credit), 7DTE (expires the next Friday).
 *   • Manage: close when the short put goes ITM (breach) OR the managed-close
 *     cost > 1.5× the credit; never carry an ITM spread into expiry.
 *   • Rescue leg: on breach, buy a far-dated (~180d) slightly-ITM long call and
 *     sell weekly ATM calls (a PMCC/diagonal) until price reclaims the breach
 *     strike, then unwind. Abandon the rescue after > 3 weeks or the long leg −25%.
 *
 * Realism (spec must-haves):
 *   • Black-Scholes marks (engine `blackScholesPrice`/`blackScholesDelta`) on a
 *     realized-vol IV model (TRA-731 synthetic-chain basis — real ≥12mo equity
 *     option history does not exist; BS-on-real-bars is the board-ratified stand-in).
 *   • Per-leg commissions ($0.65/contract, Tradier) on every open and close.
 *   • Bid/ask fills with a spread that WIDENS for cheap options, so the deep-OTM
 *     long wing is bought rich and sold cheap (the leg the video hand-waves).
 *   • Every fill is next-marketable; no mid-price fantasy.
 *
 * The rescue campaign's P&L is folded into the P&L of the WEEK it rescues, so the
 * per-week trade series carries the full strategy's tail (the martingale add-on
 * lands on top of the loss it is chasing). The unit of the gate is the weekly
 * trade; expectancy is per-week R.
 *
 * Emits `reports/tra1617-qqq-pcs-gate.json` with the full metrics + regime split
 * + the six-guard verdict, and the ready-to-POST registration body for
 *   POST /api/promotion/optimization  { strategyId, reportId, verdict }
 * (admin-only). Registering does NOT flip any live flag — Stage-3 board sign-off
 * still gates the live transition (TRA-532).
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra1617-qqq-pcs-gate.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { blackScholesPrice, blackScholesDelta } from '@trading-app/engine';
import { evaluateBacktestGate, type BacktestGateVerdict } from '@trading-app/shared';
import { deflatedSharpeRatio, probabilityOfBacktestOverfitting } from './overfitting-stats.js';
import type { OptimizationVerdict, BacktestVerdictMetrics } from './run-optimization.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const REPORT_DIR = resolve(HERE, '..', 'reports');

// ── Model constants ───────────────────────────────────────────────────────────
const R_FREE = 0.045; // risk-free rate for the pricer
const WIDTH = 25; // 25-wide spread, as marketed (a fixed-DOLLAR width — its %-width shrinks as QQQ rose 100→500)
const DTE_DAYS = 7; // 7DTE weekly (expires the next Friday)
const COMM = 0.65; // $/contract commission (Tradier), charged on every leg open AND close
const RV_WINDOW = 20; // realized-vol lookback (bars) for the IV model
const VRP = 1.05; // vol-risk-premium: IV trades slightly rich to realized
const IV_FLOOR = 0.10; // annualized IV floor
const RESCUE_LONG_CALL_DTE = 180; // far-dated long call
const RESCUE_LONG_CALL_DELTA = 0.58; // slightly ITM
const RESCUE_MAX_WEEKS = 3; // abandon after > 3 weeks
const RESCUE_LONG_STOP = 0.75; // abandon if the long call marks ≤ 75% of cost (−25%)
const ACCOUNT_CAPITAL = 10_000; // a realistic small account able to margin the defined-risk spread + a rescue diagonal (DD is also reported in $ and R)

// ── Cache loader (deterministic, no network) ──────────────────────────────────
interface CacheEntry { symbol: string; start: number; end: number; candles: Candle[] }

function loadCachedCandles(symbol: string): Candle[] {
  const path = resolve(DATA_DIR, `${symbol.toLowerCase()}.json`);
  if (!existsSync(path)) throw new Error(`No daily cache for ${symbol} at ${path} — run the Yahoo fetch first`);
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
  return raw.candles.slice().sort((a, b) => a.timestamp - b.timestamp);
}

// ── Black-Scholes adapters + IV model ─────────────────────────────────────────
function bs(spot: number, K: number, dteDays: number, sigma: number, type: 'call' | 'put'): number {
  return blackScholesPrice({ spot, strike: K, timeToExpiryYears: Math.max(dteDays, 0) / 365, riskFreeRate: R_FREE, volatility: sigma, optionType: type });
}
function bsDelta(spot: number, K: number, dteDays: number, sigma: number, type: 'call' | 'put'): number {
  return blackScholesDelta({ spot, strike: K, timeToExpiryYears: Math.max(dteDays, 0) / 365, riskFreeRate: R_FREE, volatility: sigma, optionType: type });
}

/** Annualized realized volatility over the trailing RV_WINDOW closes ending at index i. */
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
  return Math.sqrt(v * 252);
}

/** IV used for pricing on a given bar: realized vol × VRP, floored. */
function ivAt(closes: readonly number[], i: number): number | null {
  const rv = realizedVol(closes, i);
  if (rv == null) return null;
  return Math.max(IV_FLOOR, rv * VRP);
}

// ── Bid/ask fills — relative spread WIDENS for cheap options ───────────────────
/**
 * Half bid/ask spread as a $ amount for a given mid. Deep-OTM contracts (the long
 * wing, the far ATM calls) carry the worst relative spreads — modeled explicitly
 * because they are exactly what the video's mid-price math ignores.
 */
function halfSpread(mid: number, slipMult = 1): number {
  const rel = mid < 0.2 ? 0.25 : mid < 1 ? 0.08 : 0.04;
  return Math.max(0.02, mid * rel) * slipMult;
}
/** Price you SELL at (you cross to the bid). */
function sellFill(mid: number, slipMult = 1): number {
  return Math.max(0.01, mid - halfSpread(mid, slipMult));
}
/** Price you BUY at (you cross to the ask). */
function buyFill(mid: number, slipMult = 1): number {
  return mid + halfSpread(mid, slipMult);
}

// ── Strike selection by target delta (QQQ weeklies list $1 strikes) ────────────
function selectShortPutStrike(spot: number, dte: number, sigma: number, targetDelta: number): number | null {
  let best: number | null = null;
  let bestErr = Infinity;
  for (let K = Math.round(spot); K > spot * 0.5; K -= 1) {
    const d = Math.abs(bsDelta(spot, K, dte, sigma, 'put'));
    const e = Math.abs(d - targetDelta);
    if (e < bestErr) { bestErr = e; best = K; }
    if (d < targetDelta * 0.4) break; // walked past the target; stop
  }
  return best;
}
function selectCallStrikeByDelta(spot: number, dte: number, sigma: number, targetDelta: number): number {
  let best = Math.round(spot);
  let bestErr = Infinity;
  for (let K = Math.round(spot * 0.7); K <= spot * 1.3; K += 1) {
    const d = Math.abs(bsDelta(spot, K, dte, sigma, 'call'));
    const e = Math.abs(d - targetDelta);
    if (e < bestErr) { bestErr = e; best = K; }
  }
  return best;
}

// ── Regime tagging ─────────────────────────────────────────────────────────────
interface Regime { key: string; from: string; to: string }
const REGIMES: Regime[] = [
  { key: '2015-2017 grind-up', from: '2015-01-01', to: '2018-09-30' },
  { key: 'Q4-2018 selloff', from: '2018-10-01', to: '2018-12-31' },
  { key: '2019 recovery', from: '2019-01-01', to: '2020-02-19' },
  { key: 'Mar-2020 COVID crash', from: '2020-02-20', to: '2020-04-30' },
  { key: '2020-2021 melt-up', from: '2020-05-01', to: '2021-12-31' },
  { key: '2022 bear', from: '2022-01-01', to: '2022-12-31' },
  { key: '2023-2024 bull', from: '2023-01-01', to: '2024-07-31' },
  { key: 'Aug-2024 vol spike', from: '2024-08-01', to: '2024-08-31' },
  { key: '2024H2-2025', from: '2024-09-01', to: '2025-12-31' },
];
function regimeOf(ts: number): string {
  const iso = new Date(ts).toISOString().slice(0, 10);
  for (const r of REGIMES) if (iso >= r.from && iso <= r.to) return r.key;
  return 'other';
}

// ── Strategy state machine ─────────────────────────────────────────────────────
export interface StrategyParams {
  shortPutDelta: number; // ~0.10–0.15
  managedCloseMult: number; // close when cost ≥ this × credit (spec: 1.5)
  rescueEnabled: boolean;
  slipMult: number; // 1 = base; >1 = cost/slippage stress (G6)
}

export const PRIMARY_PARAMS: StrategyParams = {
  shortPutDelta: 0.125, // centre of the 10–15Δ band
  managedCloseMult: 1.5,
  rescueEnabled: true,
  slipMult: 1,
};

export interface WeekTrade {
  fridayIdx: number;
  date: string;
  regime: string;
  shortK: number;
  longK: number;
  credit: number; // per-share net credit received (after bid/ask)
  pcsPnl: number; // $ P&L of the spread leg alone (net comm/slippage)
  rescuePnl: number; // $ P&L of the rescue campaign folded into this week (0 if none)
  pnl: number; // total $ P&L of the week (pcs + rescue)
  riskDollars: number; // defined max loss of the spread = (WIDTH − credit) × 100
  R: number; // pnl / riskDollars
  outcome: 'expired_otm' | 'managed_close' | 'breach_settle';
  breached: boolean;
  rescued: boolean; // rescue campaign reclaimed the breach strike
}

/** Find the daily-bar index that is `n` trading days after `i` (clamped to the series). */
function tradingDayIdx(len: number, i: number, n: number): number {
  return Math.min(len - 1, i + n);
}

/**
 * Run the rescue campaign starting the trading day after a breach. Returns the
 * campaign's net $ P&L (long call round-trip + weekly short-call nets − comm),
 * and whether it reclaimed the breach strike. Faithful PMCC/diagonal accounting.
 */
function runRescue(
  bars: Candle[], closes: number[], startIdx: number, breachStrike: number, params: StrategyParams,
): { pnl: number; reclaimed: boolean } {
  const sigma0 = ivAt(closes, startIdx);
  if (sigma0 == null || startIdx >= bars.length - 1) return { pnl: 0, reclaimed: false };
  const spot0 = bars[startIdx]!.close;
  const longK = selectCallStrikeByDelta(spot0, RESCUE_LONG_CALL_DTE, sigma0, RESCUE_LONG_CALL_DELTA);
  const longEntryMid = bs(spot0, longK, RESCUE_LONG_CALL_DTE, sigma0, 'call');
  const longEntry = buyFill(longEntryMid, params.slipMult); // buy the long call (cross the ask)
  let pnl = -longEntry * 100 - COMM; // long-call entry premium + $0.65 commission (single contract)

  let weekStart = startIdx;
  for (let week = 1; week <= RESCUE_MAX_WEEKS; week++) {
    const weekEnd = tradingDayIdx(bars.length, weekStart, 5);
    const sigma = ivAt(closes, weekStart) ?? sigma0;
    // Sell one weekly ATM call against the long (collect premium up front).
    const atmK = selectCallStrikeByDelta(bars[weekStart]!.close, DTE_DAYS, sigma, 0.5);
    const shortMid = bs(bars[weekStart]!.close, atmK, DTE_DAYS, sigma, 'call');
    const shortCredit = sellFill(shortMid, params.slipMult);
    pnl += shortCredit * 100 - COMM; // collect short-call premium, pay comm

    // Walk the week; unwind early if price reclaims the breach strike.
    for (let j = weekStart + 1; j <= weekEnd; j++) {
      const spot = bars[j]!.close;
      const dteLong = RESCUE_LONG_CALL_DTE - (j - startIdx);
      const sig = ivAt(closes, j) ?? sigma0;
      const longMark = sellFill(bs(spot, longK, dteLong, sig, 'call'), params.slipMult);
      // Long-leg stop: abandon at −25% of entry.
      if (longMark <= RESCUE_LONG_STOP * longEntry) {
        // Buy back the still-open short call (deep OTM/near 0 in a downtrend), sell the long.
        const shortBuyback = buyFill(bs(spot, atmK, Math.max(weekEnd - j, 0), sig, 'call'), params.slipMult);
        pnl += -(shortBuyback * 100) - COMM + longMark * 100 - COMM;
        return { pnl, reclaimed: false };
      }
      if (spot >= breachStrike) {
        // Reclaimed — unwind: sell the long call, buy back the short.
        const shortBuyback = buyFill(bs(spot, atmK, Math.max(weekEnd - j, 0), sig, 'call'), params.slipMult);
        pnl += longMark * 100 - COMM - shortBuyback * 100 - COMM;
        return { pnl, reclaimed: true };
      }
    }
    // Week ended without reclaim/stop: settle the short call at its expiry.
    const spotExp = bars[weekEnd]!.close;
    if (spotExp > atmK) pnl += -(spotExp - atmK) * 100; // short call assigned (capped by the long above it)
    weekStart = weekEnd;
    if (weekStart >= bars.length - 1) break;
  }
  // Abandoned after the max window: liquidate the long call at market.
  const endIdx = Math.min(bars.length - 1, weekStart);
  const sigEnd = ivAt(closes, endIdx) ?? sigma0;
  const dteLongEnd = RESCUE_LONG_CALL_DTE - (endIdx - startIdx);
  const longExit = sellFill(bs(bars[endIdx]!.close, longK, dteLongEnd, sigEnd, 'call'), params.slipMult);
  pnl += longExit * 100 - COMM;
  return { pnl, reclaimed: false };
}

/** Run the full weekly PCS + rescue strategy over the daily bars. */
export function runStrategy(bars: Candle[], params: StrategyParams): WeekTrade[] {
  const closes = bars.map((b) => b.close);
  const trades: WeekTrade[] = [];
  const n = bars.length;

  for (let i = RV_WINDOW + 1; i < n - DTE_DAYS; i++) {
    const bar = bars[i]!;
    if (new Date(bar.timestamp).getUTCDay() !== 5) continue; // Fridays only
    const sigma = ivAt(closes, i);
    if (sigma == null) continue;
    const spot = bar.close;

    const shortK = selectShortPutStrike(spot, DTE_DAYS, sigma, params.shortPutDelta);
    if (shortK == null) continue;
    const longK = shortK - WIDTH;
    if (longK <= 0) continue;

    // Entry fills: sell the short put (to the bid), buy the long put (at the ask).
    const shortEntryMid = bs(spot, shortK, DTE_DAYS, sigma, 'put');
    const longEntryMid = bs(spot, longK, DTE_DAYS, sigma, 'put');
    const credit = sellFill(shortEntryMid, params.slipMult) - buyFill(longEntryMid, params.slipMult);
    if (!(credit > 0)) continue; // no net credit → the rule wouldn't take it
    const entryComm = 2 * COMM;

    const expiryIdx = tradingDayIdx(n, i, DTE_DAYS === 7 ? 5 : DTE_DAYS); // next Friday ≈ 5 trading days
    let outcome: WeekTrade['outcome'] = 'expired_otm';
    let breached = false;
    let pcsPnl = 0;
    let closeIdx = expiryIdx;

    // Manage day by day until expiry.
    for (let j = i + 1; j <= expiryIdx; j++) {
      const d = bars[j]!;
      const dteRem = Math.max(expiryIdx - j, 0) + 0.5; // half-day so expiry-day still has some theta
      const sig = ivAt(closes, j) ?? sigma;
      const shortMark = buyFill(bs(d.close, shortK, dteRem, sig, 'put'), params.slipMult);
      const longMark = sellFill(bs(d.close, longK, dteRem, sig, 'put'), params.slipMult);
      const costToClose = shortMark - longMark;
      const breachTouch = d.low <= shortK; // intraday breach of the short strike
      if (breachTouch || costToClose >= params.managedCloseMult * credit) {
        pcsPnl = (credit - Math.max(0, costToClose)) * 100 - entryComm - 2 * COMM;
        outcome = 'managed_close';
        breached = breachTouch;
        closeIdx = j;
        break;
      }
      if (j === expiryIdx) {
        const spotExp = d.close;
        if (spotExp >= shortK) {
          pcsPnl = credit * 100 - entryComm; // expired worthless, keep full credit (no exit comm)
        } else {
          const intrinsic = Math.min(WIDTH, shortK - spotExp);
          pcsPnl = (credit - intrinsic) * 100 - entryComm - 2 * COMM;
          outcome = 'breach_settle';
          breached = true;
        }
      }
    }

    // Rescue campaign folds into THIS week's P&L (the martingale add-on rides on
    // the loss it is chasing). Triggered only on a breach that left a loss.
    let rescuePnl = 0;
    let rescued = false;
    if (params.rescueEnabled && breached && pcsPnl < 0) {
      const r = runRescue(bars, closes, Math.min(n - 1, closeIdx + 1), shortK, params);
      rescuePnl = r.pnl;
      rescued = r.reclaimed;
    }

    const riskDollars = (WIDTH - credit) * 100;
    const pnl = pcsPnl + rescuePnl;
    trades.push({
      fridayIdx: i,
      date: new Date(bar.timestamp).toISOString().slice(0, 10),
      regime: regimeOf(bar.timestamp),
      shortK, longK, credit,
      pcsPnl, rescuePnl, pnl,
      riskDollars, R: pnl / riskDollars,
      outcome, breached, rescued,
    });
  }
  return trades;
}

// ── Metrics ────────────────────────────────────────────────────────────────────
export interface StrategyMetrics {
  tradeCount: number;
  winRate: number;
  avgCredit: number;
  expectancyR: number; // avg R per week
  avgPnl: number; // avg $ per week
  totalPnl: number;
  sharpe: number; // annualized (per-week × √52)
  sortino: number; // annualized downside
  profitFactor: number;
  maxDrawdownPct: number; // on the $ equity curve vs ACCOUNT_CAPITAL
  maxDrawdownDollars: number;
  tailLoss: { worstR: number; p01R: number; p05R: number; worst5AvgR: number; tailRatio: number };
  breachRate: number;
  rescueSuccessRate: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx]!;
}

export function computeMetrics(trades: WeekTrade[]): StrategyMetrics {
  const n = trades.length;
  const Rs = trades.map((t) => t.R);
  const pnls = trades.map((t) => t.pnl);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const mean = Rs.reduce((a, b) => a + b, 0) / (n || 1);
  const sd = Math.sqrt(Rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const downside = Rs.filter((r) => r < 0);
  const dd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / Math.max(1, n - 1));
  const tradesPerYear = 52;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(tradesPerYear) : 0;
  const sortino = dd > 0 ? (mean / dd) * Math.sqrt(tradesPerYear) : 0;

  const grossWin = wins.reduce((a, b) => a + b.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // $ equity curve vs a fixed small-account capital.
  let eq = ACCOUNT_CAPITAL, peak = ACCOUNT_CAPITAL, maxDdDollars = 0, maxDdPct = 0;
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
    breachRate: trades.filter((t) => t.breached).length / (n || 1),
    rescueSuccessRate: (() => {
      const rescueWeeks = trades.filter((t) => t.rescuePnl !== 0);
      return rescueWeeks.length ? rescueWeeks.filter((t) => t.rescued).length / rescueWeeks.length : 0;
    })(),
  };
}

// ── Six-guard verdict (TRA-540 battery, computed from the real backtest) ───────
const DELTA_TRIALS = [0.10, 0.125, 0.15];
const STOP_TRIALS = [1.5, 2.0];

/** Per-trade Sharpe (non-annualized) of an R series. */
function perTradeSharpe(Rs: number[]): number {
  if (Rs.length < 2) return 0;
  const m = Rs.reduce((a, b) => a + b, 0) / Rs.length;
  const sd = Math.sqrt(Rs.reduce((a, b) => a + (b - m) ** 2, 0) / (Rs.length - 1));
  return sd > 0 ? m / sd : 0;
}

interface Trial { label: string; params: StrategyParams; trades: WeekTrade[]; byFriday: Map<number, number> }

function runTrials(bars: Candle[]): Trial[] {
  const trials: Trial[] = [];
  for (const d of DELTA_TRIALS) {
    for (const s of STOP_TRIALS) {
      const params: StrategyParams = { shortPutDelta: d, managedCloseMult: s, rescueEnabled: true, slipMult: 1 };
      const trades = runStrategy(bars, params);
      trials.push({
        label: `Δ${d}/stop${s}`, params, trades,
        byFriday: new Map(trades.map((t) => [t.fridayIdx, t.R])),
      });
    }
  }
  return trials;
}

/** Simple stationary bootstrap CI lower bound of mean R (G4). */
function bootstrapMeanLowerBound(Rs: number[], iters = 2000, alpha = 0.05): number {
  if (Rs.length < 10) return -Infinity;
  const means: number[] = [];
  // Deterministic LCG so the harness is reproducible (no Math.random).
  let seed = 1234567;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let k = 0; k < Rs.length; k++) s += Rs[Math.floor(rand() * Rs.length)]!;
    means.push(s / Rs.length);
  }
  means.sort((a, b) => a - b);
  return means[Math.floor(alpha * means.length)]!;
}

export interface Tra1617GateResult {
  primary: StrategyMetrics;
  perRegime: Array<{ regime: string; metrics: StrategyMetrics }>;
  guards: OptimizationVerdict['guards'];
  backtestMetrics: BacktestVerdictMetrics;
  verdict: OptimizationVerdict;
  gate: ReturnType<typeof evaluateBacktestGate>;
  trials: Array<{ label: string; expectancyR: number; sharpe: number; tradeCount: number }>;
}

export function computeTra1617Gate(bars: Candle[]): Tra1617GateResult {
  const primaryTrades = runStrategy(bars, PRIMARY_PARAMS);
  const primary = computeMetrics(primaryTrades);

  const perRegime = REGIMES.map((r) => {
    const t = primaryTrades.filter((x) => x.regime === r.key);
    return { regime: r.key, metrics: computeMetrics(t) };
  }).filter((x) => x.metrics.tradeCount > 0);

  // Trials for the multiple-testing / overfitting guards.
  const trials = runTrials(bars);
  const primaryR = primaryTrades.map((t) => t.R);

  // G1 — OOS holdout efficiency: IS (2015–2021) vs OOS (2022–2025) expectancy.
  const isTrades = primaryTrades.filter((t) => t.date < '2022-01-01');
  const oosTrades = primaryTrades.filter((t) => t.date >= '2022-01-01');
  const isExp = isTrades.length ? isTrades.reduce((a, b) => a + b.R, 0) / isTrades.length : 0;
  const oosExp = oosTrades.length ? oosTrades.reduce((a, b) => a + b.R, 0) / oosTrades.length : 0;
  const oosSharpe = perTradeSharpe(oosTrades.map((t) => t.R));
  const efficiency = isExp > 0 ? oosExp / isExp : oosExp > 0 ? 1 : 0;
  const g1Pass = efficiency >= 0.5 && oosExp > 0;

  // G2 — Deflated Sharpe Ratio (multiple-testing penalty across the trials).
  const dsr = deflatedSharpeRatio({
    returns: primaryR,
    trialSharpes: trials.map((t) => perTradeSharpe(t.trades.map((x) => x.R))),
    trialCount: trials.length,
    threshold: 0.95,
  });

  // G3 — Probability of Backtest Overfitting (CSCV over the shared Friday grid).
  const fridays = Array.from(new Set(trials.flatMap((t) => t.trades.map((x) => x.fridayIdx)))).sort((a, b) => a - b);
  const matrix = trials.map((t) => fridays.map((f) => t.byFriday.get(f) ?? 0));
  const pbo = probabilityOfBacktestOverfitting({ matrix, partitions: 16, threshold: 0.5 });

  // G4 — bootstrap OOS floor: 5% CI lower bound of mean OOS R must be > 0.
  const g4Floor = bootstrapMeanLowerBound(oosTrades.map((t) => t.R));
  const g4Pass = g4Floor > 0;

  // G5 — holdout confirmation: OOS Sharpe > 0 across the crisis regimes.
  const g5Pass = oosSharpe > 0;

  // G6 — cost/slippage stress: re-run with 1.5× spreads/comms; expectancy stays > 0.
  const stressed = computeMetrics(runStrategy(bars, { ...PRIMARY_PARAMS, slipMult: 1.5 }));
  const g6Pass = stressed.expectancyR > 0;

  const guards: OptimizationVerdict['guards'] = {
    G1: { pass: g1Pass, value: Number(efficiency.toFixed(4)) },
    G2: { pass: dsr.pass, value: Number(dsr.psr.toFixed(4)) },
    G3: { pass: pbo.pass, value: Number(pbo.pbo.toFixed(4)) },
    G4: { pass: g4Pass, value: Number((Number.isFinite(g4Floor) ? g4Floor : -99).toFixed(4)) },
    G5: { pass: g5Pass, value: Number(oosSharpe.toFixed(4)) },
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
    blessedParams: { strategy: 'qqq_weekly_pcs_rescue', ...PRIMARY_PARAMS },
    backtestMetrics,
  };

  const gate = evaluateBacktestGate(
    { sharpe: backtestMetrics.sharpe, expectancy: backtestMetrics.expectancy, profitFactor: backtestMetrics.profitFactor, maxDrawdown: backtestMetrics.maxDrawdown, tradeCount: backtestMetrics.tradeCount },
    undefined,
    { pass: verdict.pass, guards: verdict.guards } as BacktestGateVerdict,
  );

  return {
    primary, perRegime, guards, backtestMetrics, verdict, gate,
    trials: trials.map((t) => {
      const m = computeMetrics(t.trades);
      return { label: t.label, expectancyR: Number(m.expectancyR.toFixed(4)), sharpe: Number(m.sharpe.toFixed(3)), tradeCount: m.tradeCount };
    }),
  };
}

// ── Reporting ──────────────────────────────────────────────────────────────────
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

function main(): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  const bars = loadCachedCandles('QQQ');
  const res = computeTra1617Gate(bars);
  const m = res.primary;

  console.log('\n=== TRA-1617 — QQQ weekly 25-wide PCS + call-rescue (2015-2025 OOS) ===');
  console.log(`  span                 ${bars[0]!.timestamp && new Date(bars[0]!.timestamp).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1]!.timestamp).toISOString().slice(0, 10)}`);
  console.log(`  weeks (trades)       ${m.tradeCount}`);
  console.log(`  win rate             ${pct(m.winRate)}`);
  console.log(`  avg credit           $${m.avgCredit.toFixed(2)}/share ($${(m.avgCredit * 100).toFixed(0)}/spread)`);
  console.log(`  expectancy           ${m.expectancyR.toFixed(4)} R/week  ($${m.avgPnl.toFixed(2)}/week)`);
  console.log(`  total P&L            $${m.totalPnl.toFixed(0)}`);
  console.log(`  profit factor        ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}`);
  console.log(`  Sharpe (ann.)        ${m.sharpe.toFixed(2)}   Sortino ${m.sortino.toFixed(2)}`);
  console.log(`  max drawdown         ${pct(m.maxDrawdownPct)}  ($${m.maxDrawdownDollars.toFixed(0)} on $${ACCOUNT_CAPITAL} acct)`);
  console.log(`  breach rate          ${pct(m.breachRate)}   rescue success ${pct(m.rescueSuccessRate)}`);
  console.log(`  TAIL  worstR ${m.tailLoss.worstR.toFixed(2)}  p01R ${m.tailLoss.p01R.toFixed(2)}  worst-5% avg ${m.tailLoss.worst5AvgR.toFixed(2)}  tail:win ${Number.isFinite(m.tailLoss.tailRatio) ? m.tailLoss.tailRatio.toFixed(1) : '∞'}:1`);

  console.log('\n  ── regime split ──');
  for (const r of res.perRegime) {
    const rm = r.metrics;
    console.log(`  ${r.regime.padEnd(22)} n=${String(rm.tradeCount).padStart(3)}  win ${pct(rm.winRate).padStart(6)}  exp ${rm.expectancyR.toFixed(3)}R  worstR ${rm.tailLoss.worstR.toFixed(1)}  P&L $${rm.totalPnl.toFixed(0)}`);
  }

  console.log('\n  ── six-guard overfitting battery (TRA-540) ──');
  for (const [id, g] of Object.entries(res.guards)) console.log(`  ${id}  ${g.pass ? 'PASS' : 'FAIL'}  value=${g.value}`);
  console.log(`\n  VERDICT              ${res.verdict.pass ? 'PASS' : 'FAIL'}`);
  console.log(`  GATE (Stage-1)       ${res.gate.state.toUpperCase()}`);
  for (const c of res.gate.failedChecks) console.log(`     ✗ ${c}`);

  const reportId = `TRA-1617-qqq-pcs-rescue-2015-2025`;
  const payload = {
    generatedAt: new Date().toISOString(),
    issue: 'TRA-1617',
    strategyId: 'qqq_weekly_pcs_rescue',
    dataset: 'QQQ daily bars (Yahoo), 2015-01-01 → 2025-12-30, on-disk cache',
    model: 'Black-Scholes on realized-vol IV (VRP 1.05); per-leg $0.65 comm; widening bid/ask fills',
    account: ACCOUNT_CAPITAL,
    params: PRIMARY_PARAMS,
    metrics: m,
    perRegime: res.perRegime,
    trials: res.trials,
    guards: res.guards,
    backtestMetrics: res.backtestMetrics,
    verdict: res.verdict,
    gate: res.gate,
    // Ready-to-POST body for POST /api/promotion/optimization (admin). Registering
    // it does NOT flip any live flag — Stage-3 board sign-off still gates go-live.
    registrationBody: { strategyId: 'qqq_weekly_pcs_rescue', reportId, verdict: res.verdict },
  };
  const out = resolve(REPORT_DIR, 'tra1617-qqq-pcs-gate.json');
  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${out}`);
}

const invoked = process.argv[1] && /run-tra1617-qqq-pcs-gate\.(ts|js)$/.test(process.argv[1]);
if (invoked) main();
