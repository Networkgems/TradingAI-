/**
 * TRA-731 (Phase 2, Track B) — synthetic-chain options replay for the
 * SupertrendConfluence signal.
 *
 * Walks each symbol's >=12mo equity bars point-in-time. On every bar:
 *   1. Mark + exit any open position (Supertrend flip / MA20 close-through /
 *      premium stop / take-profit / time stop — the `evaluateExit` rule set),
 *      force-closing at intrinsic on expiry.
 *   2. If flat, evaluate `evaluateSupertrendConfluence`. On a signal, build a
 *      synthetic chain for the bar, route the IV-rank through the IV gate
 *      (`selectStructureByIv`) — single-leg only in this Phase-2 universe, so a
 *      vertical-routed (high-IV-rank) regime suppresses the entry — pick the
 *      expiry (`selectExpiry`) and delta-target strike (`selectStrikeByDelta`),
 *      and open a single long contract priced off the synthetic chain.
 *   3. Snapshot the cumulative-pnl equity curve.
 *
 * Premium is sized at one contract per trade so the reported PF / win-rate /
 * Sharpe / Sortino reflect the pure signal + structure edge, independent of
 * account sizing (sizing is a separate live concern, `sizeOptionContracts`).
 * Per-trade R = pnl / (entryPremium × |premiumStopPct| × multiplier).
 *
 * Pure & deterministic apart from the signal `id` (unused here): pricing is a
 * function of the equity bars + IV model only — NO network, NO recorded chains.
 * Everything is tagged synthetic by the caller.
 */

import {
  evaluateSupertrendConfluence,
  supertrendLatest,
  selectStructureByIv,
  selectExpiry,
  selectStrikeByDelta,
  optionTypeForSide,
  evaluateExit,
  isThirdFriday,
  blackScholesPrice,
  blackScholesDelta,
  DEFAULT_IV_GATE,
  DEFAULT_EXPIRY_PARAMS,
  DEFAULT_DELTA_PARAMS,
  DEFAULT_EXIT_PARAMS,
  type SupertrendConfluenceParams,
  type IvGateParams,
  type ExpiryParams,
  type DeltaTargetParams,
  type ExitParams,
  type ExitReason,
  type OptionsStructure,
} from '@trading-app/engine';
import type { Candle, OptionType, Side } from '@trading-app/shared';
import {
  realizedVolSeries,
  ivRank,
  syntheticIv,
  DEFAULT_IV_MODEL,
  type IvModelParams,
} from './synthetic-chain.js';
import { summarizeTrades, type TradeMetrics } from './tra731-metrics.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SupertrendReplayParams {
  /** SupertrendConfluence entry params (Supertrend 7/3 vs 10/3, RSI band, …). */
  confluence: SupertrendConfluenceParams;
  /** IV gate (single-leg vs vertical cutoff). High IV-rank → vertical → suppressed. */
  ivGate: IvGateParams;
  /** Expiry window (2–4wk center). `excludeWeeklies` defaults false for synthetic weekly grids. */
  expiry: ExpiryParams;
  /** Delta-target strike selection (~0.60–0.70). */
  delta: DeltaTargetParams;
  /** Exit rule set. */
  exit: ExitParams;
  /** IV model (realized vol / term structure). */
  ivModel: IvModelParams;
  riskFreeRate: number;
  dividendYield: number;
  contractMultiplier: number;
  /** Higher-timeframe Supertrend confirm. Off for daily bars (no intraday MTF). Default false. */
  requireConfirmTrend: boolean;
  /** Candidate expiries to price, in calendar days from each bar. Default 7..42. */
  expiryDays: number[];
}

export const DEFAULT_REPLAY_PARAMS: SupertrendReplayParams = {
  confluence: {},
  ivGate: DEFAULT_IV_GATE,
  // Synthetic chains are weekly-gridded — allow weeklies so the 2–4wk window has coverage.
  expiry: { ...DEFAULT_EXPIRY_PARAMS, excludeWeeklies: false },
  delta: DEFAULT_DELTA_PARAMS,
  exit: DEFAULT_EXIT_PARAMS,
  ivModel: DEFAULT_IV_MODEL,
  riskFreeRate: 0.045,
  dividendYield: 0,
  contractMultiplier: 100,
  requireConfirmTrend: false,
  expiryDays: [7, 14, 21, 28, 35, 42],
};

export interface ReplayTrade {
  symbol: string;
  side: Side;
  optionType: OptionType;
  strike: number;
  expiration: string;
  structure: OptionsStructure;
  ivRankAtEntry: number | null;
  entryDate: string;
  exitDate: string;
  entryPremium: number;
  exitPremium: number;
  barsHeld: number;
  exitReason: ExitReason | 'expiry' | 'window_end';
  /** P&L in dollars for one contract (× multiplier). */
  pnl: number;
  /** Per-trade R = pnl / dollars-risked-to-stop. */
  r: number;
}

export interface SymbolReplayResult {
  symbol: string;
  bars: number;
  /** Bars where a signal fired but was suppressed (vertical-routed / no contract). */
  suppressedSignals: number;
  trades: ReplayTrade[];
  metrics: TradeMetrics;
}

function sma(closes: readonly number[], period: number): number | null {
  if (closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) sum += closes[i];
  return sum / period;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar days from a bar instant to an ISO expiration's ~market close. */
function dteDays(expiration: string, nowMs: number): number {
  const expMs = Date.parse(`${expiration}T16:00:00-04:00`);
  if (!Number.isFinite(expMs)) return 0;
  return Math.max(0, (expMs - nowMs) / DAY_MS);
}

/** Price the held single-leg contract at a later bar via Black-Scholes (T shrinks as it ages). */
function repriceContract(
  spot: number,
  strike: number,
  optionType: OptionType,
  expiration: string,
  nowMs: number,
  rvAnnual: number,
  p: SupertrendReplayParams,
): number {
  const dte = dteDays(expiration, nowMs);
  const iv = syntheticIv(rvAnnual, dte, p.ivModel);
  return blackScholesPrice({
    spot,
    strike,
    timeToExpiryYears: dte / 365,
    riskFreeRate: p.riskFreeRate,
    volatility: iv,
    optionType,
    dividendYield: p.dividendYield,
  });
}

interface OpenState {
  side: Side;
  optionType: OptionType;
  strike: number;
  expiration: string;
  structure: OptionsStructure;
  ivRankAtEntry: number | null;
  entryDate: string;
  entryPremium: number;
  entryBarIndex: number;
  bestPremium: number;
}

/**
 * Replay one symbol's equity bars through the synthetic-chain options strategy.
 * Pure — no I/O. Returns the per-symbol trade ledger + summary metrics.
 */
export function replaySymbol(
  symbol: string,
  bars: readonly Candle[],
  params: SupertrendReplayParams = DEFAULT_REPLAY_PARAMS,
): SymbolReplayResult {
  const closes = bars.map((b) => b.close);
  const rvSeries = realizedVolSeries(closes, params.ivModel.realizedVolWindow);

  const trades: ReplayTrade[] = [];
  let open: OpenState | null = null;
  let suppressedSignals = 0;
  const rs: number[] = [];
  const pnls: number[] = [];

  const stRisk = (entryPremium: number) =>
    entryPremium * Math.abs(params.exit.premiumStopPct) * params.contractMultiplier;

  const closeTrade = (
    state: OpenState,
    exitPremium: number,
    exitBarIndex: number,
    reason: ReplayTrade['exitReason'],
  ): void => {
    const pnl = (exitPremium - state.entryPremium) * params.contractMultiplier;
    const risk = stRisk(state.entryPremium);
    const r = risk > 0 ? pnl / risk : 0;
    trades.push({
      symbol,
      side: state.side,
      optionType: state.optionType,
      strike: state.strike,
      expiration: state.expiration,
      structure: state.structure,
      ivRankAtEntry: state.ivRankAtEntry,
      entryDate: state.entryDate,
      exitDate: isoDate(bars[exitBarIndex].timestamp),
      entryPremium: state.entryPremium,
      exitPremium,
      barsHeld: exitBarIndex - state.entryBarIndex,
      exitReason: reason,
      pnl,
      r,
    });
    rs.push(r);
    pnls.push(pnl);
  };

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const prefix = bars.slice(0, i + 1);
    const rv = rvSeries[i];

    // 1. Mark + exit the open position.
    if (open && rv != null) {
      const current = repriceContract(
        bar.close,
        open.strike,
        open.optionType,
        open.expiration,
        bar.timestamp,
        rv,
        params,
      );
      open.bestPremium = Math.max(open.bestPremium, current);
      const remainingDte = dteDays(open.expiration, bar.timestamp);

      if (remainingDte <= 0) {
        // Force-close at intrinsic value on/after expiry.
        const intrinsic =
          open.optionType === 'call'
            ? Math.max(0, bar.close - open.strike)
            : Math.max(0, open.strike - bar.close);
        closeTrade(open, intrinsic, i, 'expiry');
        open = null;
      } else {
        const st = supertrendLatest(prefix, params.confluence.supertrend);
        const ma20 = sma(closes.slice(0, i + 1), 20);
        if (st && ma20 != null) {
          const reason = evaluateExit(
            {
              side: open.side,
              supertrendDirection: st.direction,
              underlyingClose: bar.close,
              ma20,
              entryPremium: open.entryPremium,
              currentPremium: current,
              barsHeld: i - open.entryBarIndex,
              hadFollowThrough: open.bestPremium > open.entryPremium,
            },
            params.exit,
          );
          if (reason) {
            closeTrade(open, current, i, reason);
            open = null;
          }
        }
      }
    }

    // 2. Look for a new entry only when flat.
    if (!open && rv != null) {
      const confirm = params.requireConfirmTrend ? prefix : null;
      const signal = evaluateSupertrendConfluence(symbol, prefix, confirm, {
        ...params.confluence,
        requireConfirmTrend: params.requireConfirmTrend,
      });
      if (signal) {
        const entry = tryOpen(symbol, prefix, i, signal.side, rv, rvSeries, params);
        if (entry) {
          open = entry;
        } else {
          suppressedSignals += 1;
        }
      }
    }
  }

  // Tail-close anything still open at the last bar's repriced mark.
  if (open) {
    const last = bars.length - 1;
    const rv = rvSeries[last];
    const exitPremium =
      rv != null
        ? repriceContract(bars[last].close, open.strike, open.optionType, open.expiration, bars[last].timestamp, rv, params)
        : open.entryPremium;
    closeTrade(open, exitPremium, last, 'window_end');
    open = null;
  }

  return {
    symbol,
    bars: bars.length,
    suppressedSignals,
    trades,
    metrics: summarizeTrades(rs, pnls),
  };
}

/**
 * Try to open a single-leg contract for a fired signal. Returns the open state,
 * or `null` when the entry is suppressed (IV gate routes to a vertical we don't
 * price in Phase 2, no qualifying expiry, or no strike in/near the delta band).
 */
function tryOpen(
  symbol: string,
  prefix: readonly Candle[],
  barIndex: number,
  side: Side,
  rv: number,
  rvSeries: ReadonlyArray<number | null>,
  params: SupertrendReplayParams,
): OpenState | null {
  const bar = prefix[prefix.length - 1];
  const spot = bar.close;
  const nowMs = bar.timestamp;
  const optionType = optionTypeForSide(side);

  const rank = ivRank(rv, rvSeries.slice(Math.max(0, barIndex + 1 - params.ivModel.ivRankWindow), barIndex + 1));
  const decision = selectStructureByIv(rank, params.ivGate);
  // Phase-2 synthetic universe prices single legs only; a vertical-routed
  // (high-IV-rank) regime suppresses the entry. Sweeping `verticalMinIvRank`
  // therefore sweeps the IV-rank cutoff for tradeability.
  if (decision.structure !== 'single_leg') return null;

  // Choose the expiry from the synthetic candidate set.
  const expiryCandidates = params.expiryDays.map((dte) => {
    const expIso = isoDate(nowMs + dte * DAY_MS);
    return { expiration: expIso, daysToExpiry: dte, isMonthly: isThirdFriday(expIso) };
  });
  const chosenExpiry = selectExpiry(expiryCandidates, params.expiry);
  if (!chosenExpiry) return null;

  const T = chosenExpiry.daysToExpiry / 365;
  const iv = syntheticIv(rv, chosenExpiry.daysToExpiry, params.ivModel);

  // Build delta-tagged strike candidates across the synthetic strike grid.
  const strikeCandidates: Array<{ strike: number; delta: number }> = [];
  const seen = new Set<number>();
  for (let off = 0.8; off <= 1.2001; off += 0.025) {
    const raw = spot * off;
    const step = raw < 25 ? 0.5 : raw < 100 ? 1 : raw < 250 ? 2.5 : 5;
    const strike = Math.round(raw / step) * step;
    if (strike <= 0 || seen.has(strike)) continue;
    seen.add(strike);
    const delta = blackScholesDelta({
      spot,
      strike,
      timeToExpiryYears: T,
      riskFreeRate: params.riskFreeRate,
      volatility: iv,
      optionType,
      dividendYield: params.dividendYield,
    });
    strikeCandidates.push({ strike, delta });
  }
  const chosenStrike = selectStrikeByDelta(strikeCandidates, params.delta);
  if (!chosenStrike) return null;

  const entryPremium = blackScholesPrice({
    spot,
    strike: chosenStrike.strike,
    timeToExpiryYears: T,
    riskFreeRate: params.riskFreeRate,
    volatility: iv,
    optionType,
    dividendYield: params.dividendYield,
  });
  if (!(entryPremium > 0.01)) return null;

  return {
    side,
    optionType,
    strike: chosenStrike.strike,
    expiration: chosenExpiry.expiration,
    structure: decision.structure,
    ivRankAtEntry: rank,
    entryDate: isoDate(nowMs),
    entryPremium,
    entryBarIndex: barIndex,
    bestPremium: entryPremium,
  };
}

export interface PortfolioReplayResult {
  perSymbol: SymbolReplayResult[];
  /** All trades across symbols, pooled. */
  metrics: TradeMetrics;
  totalTrades: number;
  totalSuppressed: number;
}

/** Replay every symbol and pool the trades into one portfolio-level metric set. */
export function replayPortfolio(
  barsBySymbol: ReadonlyMap<string, readonly Candle[]>,
  params: SupertrendReplayParams = DEFAULT_REPLAY_PARAMS,
): PortfolioReplayResult {
  const perSymbol: SymbolReplayResult[] = [];
  for (const [symbol, bars] of barsBySymbol) {
    perSymbol.push(replaySymbol(symbol, bars, params));
  }

  // Pool all trades in per-symbol concatenation order (drawdown is reported
  // per-symbol too; this is the pooled cumulative-R view).
  const rs: number[] = [];
  const pnls: number[] = [];
  for (const s of perSymbol) {
    for (const t of s.trades) {
      rs.push(t.r);
      pnls.push(t.pnl);
    }
  }

  return {
    perSymbol,
    metrics: summarizeTrades(rs, pnls),
    totalTrades: rs.length,
    totalSuppressed: perSymbol.reduce((a, s) => a + s.suppressedSignals, 0),
  };
}
