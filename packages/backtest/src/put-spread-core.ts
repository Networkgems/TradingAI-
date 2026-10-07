/**
 * CORE — the SPY/QQQ put-credit-spread study (pure, no I/O).
 *
 * Why this strategy, and only this one
 * ─────────────────────────────────────
 * Every directional / mispricing trigger this repo has graded is flat or
 * negative (TRA-4386 Phase 1, the sweep-and-reclaim study, the cost-bar cells).
 * The one documented, persistent source of return available to a small options
 * account is the VOLATILITY RISK PREMIUM: index implied vol has, on average,
 * exceeded the vol that subsequently realised. Selling a defined-risk put spread
 * is the simplest way to be paid for it. It wins often and loses big
 * occasionally; the exit rules exist to keep the occasional loss bounded.
 *
 * What is modelled (and what is NOT — read before trusting a number)
 * ───────────────────────────────────────────────────────────────────
 *  - Option prices are Black-Scholes on the DAILY CLOSE. The SHORT leg is priced
 *    at VIX/100. Real 16-delta SPX/SPY puts usually trade a couple of vol points
 *    ABOVE VIX, so this UNDERSTATES the credit (conservative). The further-OTM
 *    LONG leg adds put skew on top: `wingSkewVolPtsPerPct` vol points per 1% of
 *    spot between the strikes, so the protection is priced dearer, not cheaper.
 *    No real option quotes are used. That is the main approximation; the
 *    paper/sandbox phase measures real fills against it.
 *  - Fills: credit received = model credit − `slippagePerSpread`; every exit
 *    debit = model debit + `slippagePerSpread` (min $0.01). A flat cents-per-
 *    spread haircut, not a percentage: SPY verticals fill a few cents from mid
 *    regardless of their price, so a % model under-charges cheap spreads and
 *    over-charges rich ones. Fees per contract per leg per side on top.
 *  - Marks are daily closes only. A stop that triggers intraday fills here at
 *    the CLOSE that breached it — on a crash day that is worse than a live stop,
 *    on a whipsaw day it is better. Gaps are therefore inside the model.
 *  - Expiry settles at intrinsic off the expiry-day close.
 *  - No early assignment, no dividends (SPY's ~1.3% is ignored), no margin
 *    interest. Strikes snap to $1.
 */

import type { Candle } from '@trading-app/shared';
import { blackScholesPrice, blackScholesDelta } from '@trading-app/engine';

export interface PutSpreadRules {
  /** Calendar days to expiry at entry. */
  targetDte: number;
  /** |delta| of the short put. */
  shortDelta: number;
  /** Spread width in underlying points (strikes $1 apart). */
  width: number;
  /** Close when the spread can be bought back for ≤ (1 − this) × credit. */
  takeProfitFrac: number;
  /** Close when the loss reaches this multiple of the credit received. */
  stopLossMultiple: number;
  /** Close when calendar DTE falls to this. */
  exitAtDte: number;
  /** Max simultaneously open spreads. */
  maxOpen: number;
  /** Entry cadence: open at most one new spread every N trading days. */
  entryEveryNDays: number;
  /** Skip new entries when VIX is below this (premium too thin). 0 = off. */
  minVix: number;
  /** Skip new entries when VIX is above this (crash regime). Infinity = off. */
  maxVix: number;
}

export const CORE_RULES: PutSpreadRules = Object.freeze({
  targetDte: 35,
  shortDelta: 0.16,
  width: 5,
  takeProfitFrac: 0.5,
  stopLossMultiple: 2,
  exitAtDte: 21,
  maxOpen: 2,
  entryEveryNDays: 5,
  minVix: 0,
  maxVix: Number.POSITIVE_INFINITY,
});

export interface CostModel {
  /** USD per share per spread, charged on entry AND on every non-expiry exit. */
  slippagePerSpread: number;
  /** USD per contract per leg per side (Tradier Pro ≈ regulatory residue). */
  feePerContractLeg: number;
  /** Put skew for the long leg: extra vol points per 1% of spot below the short strike. */
  wingSkewVolPtsPerPct: number;
  riskFreeRate: number;
}

export const CORE_COSTS: CostModel = Object.freeze({
  slippagePerSpread: 0.03,
  feePerContractLeg: 0.1,
  wingSkewVolPtsPerPct: 0.6,
  riskFreeRate: 0.03,
});

export interface DailyBar {
  ts: number;
  close: number;
  vix: number;
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'time_exit' | 'expiry' | 'end_of_data';

export interface SpreadTrade {
  entryTs: number;
  exitTs: number;
  shortStrike: number;
  longStrike: number;
  entrySpot: number;
  entryVix: number;
  creditPerShare: number;
  exitDebitPerShare: number;
  /** Max loss per spread in USD = (width − credit) × 100 + fees. */
  maxRiskUsd: number;
  pnlUsd: number;
  /** pnl / maxRisk — return on the capital the spread ties up. */
  returnOnRisk: number;
  exitReason: ExitReason;
  daysHeld: number;
}

const DAY = 86_400_000;

/** Join SPY and VIX daily candles on calendar day. Days missing either side are dropped. */
export function joinSpyVix(spy: Candle[], vix: Candle[]): DailyBar[] {
  const key = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const v = new Map(vix.map((c) => [key(c.timestamp), c.close]));
  const out: DailyBar[] = [];
  for (const c of spy) {
    const x = v.get(key(c.timestamp));
    if (typeof x === 'number' && x > 0 && c.close > 0) out.push({ ts: c.timestamp, close: c.close, vix: x });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function putPrice(spot: number, strike: number, tYears: number, iv: number, r: number): number {
  if (tYears <= 0) return Math.max(0, strike - spot);
  return blackScholesPrice({ spot, strike, timeToExpiryYears: tYears, riskFreeRate: r, volatility: iv, optionType: 'put' });
}

/** Model mid of the spread (short − long put), per share, ≥ 0. */
export function spreadValue(
  spot: number,
  shortK: number,
  longK: number,
  tYears: number,
  vix: number,
  c: CostModel = CORE_COSTS,
): number {
  const iv = vix / 100;
  const wingIv = iv + (c.wingSkewVolPtsPerPct / 100) * ((shortK - longK) / spot) * 100;
  const v = putPrice(spot, shortK, tYears, iv, c.riskFreeRate) - putPrice(spot, longK, tYears, wingIv, c.riskFreeRate);
  return Math.max(0, v);
}

/** Highest $1 strike whose put |delta| ≤ target (i.e. at or further OTM than target). */
export function strikeForDelta(spot: number, tYears: number, vix: number, targetAbsDelta: number, r: number): number {
  const iv = vix / 100;
  let k = Math.floor(spot);
  for (let i = 0; i < 2000 && k > 1; i++, k--) {
    const d = Math.abs(blackScholesDelta({ spot, strike: k, timeToExpiryYears: tYears, riskFreeRate: r, volatility: iv, optionType: 'put' }));
    if (d <= targetAbsDelta) return k;
  }
  return Math.max(1, k);
}

interface OpenSpread {
  entryIdx: number;
  expiryTs: number;
  shortK: number;
  longK: number;
  credit: number;
  entrySpot: number;
  entryVix: number;
}

/** Run the rules over a joined SPY/VIX series. One contract per spread. */
export function simulatePutSpreads(
  bars: DailyBar[],
  rules: PutSpreadRules = CORE_RULES,
  costs: CostModel = CORE_COSTS,
): { trades: SpreadTrade[]; skippedNoCredit: number } {
  const trades: SpreadTrade[] = [];
  const open: OpenSpread[] = [];
  let skippedNoCredit = 0;
  let lastEntryIdx = -Infinity;
  const fees = (legsSides: number) => legsSides * costs.feePerContractLeg;

  const close = (o: OpenSpread, i: number, debit: number, reason: ExitReason) => {
    const b = bars[i];
    const exitDebit = reason === 'expiry' ? debit : Math.max(0.01, debit + costs.slippagePerSpread);
    const feeUsd = fees(2) + (reason === 'expiry' ? 0 : fees(2));
    const maxRiskUsd = (rules.width - o.credit) * 100 + fees(4);
    const pnlUsd = (o.credit - exitDebit) * 100 - feeUsd;
    trades.push({
      entryTs: bars[o.entryIdx].ts,
      exitTs: b.ts,
      shortStrike: o.shortK,
      longStrike: o.longK,
      entrySpot: o.entrySpot,
      entryVix: o.entryVix,
      creditPerShare: o.credit,
      exitDebitPerShare: exitDebit,
      maxRiskUsd,
      pnlUsd,
      returnOnRisk: pnlUsd / maxRiskUsd,
      exitReason: reason,
      daysHeld: Math.round((b.ts - bars[o.entryIdx].ts) / DAY),
    });
  };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // 1) manage open spreads on today's close
    for (let j = open.length - 1; j >= 0; j--) {
      const o = open[j];
      const dte = Math.round((o.expiryTs - b.ts) / DAY);
      let reason: ExitReason | null = null;
      let debit: number;
      if (dte <= 0) {
        debit = Math.min(rules.width, Math.max(0, o.shortK - b.close) - Math.max(0, o.longK - b.close));
        reason = 'expiry';
      } else {
        debit = spreadValue(b.close, o.shortK, o.longK, dte / 365, b.vix, costs);
        if (debit <= (1 - rules.takeProfitFrac) * o.credit) reason = 'take_profit';
        else if (debit - o.credit >= rules.stopLossMultiple * o.credit) reason = 'stop_loss';
        else if (dte <= rules.exitAtDte) reason = 'time_exit';
      }
      if (reason) {
        close(o, i, debit, reason);
        open.splice(j, 1);
      }
    }
    // 2) maybe open a new spread
    if (
      open.length < rules.maxOpen
      && i - lastEntryIdx >= rules.entryEveryNDays
      && b.vix >= rules.minVix
      && b.vix <= rules.maxVix
      && i < bars.length - 1
    ) {
      const t = rules.targetDte / 365;
      const shortK = strikeForDelta(b.close, t, b.vix, rules.shortDelta, costs.riskFreeRate);
      const longK = shortK - rules.width;
      const mid = spreadValue(b.close, shortK, longK, t, b.vix, costs);
      const credit = mid - costs.slippagePerSpread;
      if (longK > 0 && credit >= 0.05 && credit < rules.width) {
        open.push({ entryIdx: i, expiryTs: b.ts + rules.targetDte * DAY, shortK, longK, credit, entrySpot: b.close, entryVix: b.vix });
        lastEntryIdx = i;
      } else {
        skippedNoCredit += 1;
      }
    }
  }
  const last = bars.length - 1;
  for (const o of open) {
    const dte = Math.max(0, Math.round((o.expiryTs - bars[last].ts) / DAY));
    close(o, last, spreadValue(bars[last].close, o.shortK, o.longK, dte / 365, bars[last].vix, costs), 'end_of_data');
  }
  trades.sort((a, b) => a.exitTs - b.exitTs);
  return { trades, skippedNoCredit };
}

// ── reporting ────────────────────────────────────────────────────────────────

export interface CoreReport {
  n: number;
  winRate: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  totalPnlUsd: number;
  meanReturnOnRisk: number | null;
  worstTradeUsd: number | null;
  /** Capital = maxOpen × the largest single max-risk seen; P&L compounds on nothing (flat 1-lot). */
  capitalUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPctOfCapital: number | null;
  annualReturnOnCapital: number | null;
  exits: Record<string, number>;
  byYear: Array<{ year: number; n: number; pnlUsd: number; winRate: number }>;
}

export function summarize(trades: SpreadTrade[], rules: PutSpreadRules = CORE_RULES): CoreReport {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const total = trades.reduce((a, t) => a + t.pnlUsd, 0);
  const capitalUsd = rules.maxOpen * Math.max(0, ...trades.map((t) => t.maxRiskUsd));
  let peak = 0;
  let eq = 0;
  let mdd = 0;
  for (const t of trades) {
    eq += t.pnlUsd;
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, peak - eq);
  }
  const years = n > 1 ? (trades[n - 1].exitTs - trades[0].entryTs) / (365.25 * DAY) : 0;
  const exits: Record<string, number> = {};
  for (const t of trades) exits[t.exitReason] = (exits[t.exitReason] ?? 0) + 1;
  const yr = new Map<number, SpreadTrade[]>();
  for (const t of trades) {
    const y = new Date(t.exitTs).getUTCFullYear();
    (yr.get(y) ?? yr.set(y, []).get(y)!).push(t);
  }
  return {
    n,
    winRate: n ? wins.length / n : null,
    avgWinUsd: wins.length ? wins.reduce((a, t) => a + t.pnlUsd, 0) / wins.length : null,
    avgLossUsd: losses.length ? losses.reduce((a, t) => a + t.pnlUsd, 0) / losses.length : null,
    totalPnlUsd: total,
    meanReturnOnRisk: n ? trades.reduce((a, t) => a + t.returnOnRisk, 0) / n : null,
    worstTradeUsd: n ? Math.min(...trades.map((t) => t.pnlUsd)) : null,
    capitalUsd,
    maxDrawdownUsd: mdd,
    maxDrawdownPctOfCapital: capitalUsd > 0 ? mdd / capitalUsd : null,
    annualReturnOnCapital: capitalUsd > 0 && years > 0 ? total / capitalUsd / years : null,
    exits,
    byYear: [...yr.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, ts]) => ({
        year,
        n: ts.length,
        pnlUsd: ts.reduce((a, t) => a + t.pnlUsd, 0),
        winRate: ts.filter((t) => t.pnlUsd > 0).length / ts.length,
      })),
  };
}
