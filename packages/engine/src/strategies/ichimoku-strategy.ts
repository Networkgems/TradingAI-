import { Candle, TradeSignal, Side, isValidTradingWindow } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { ichimoku } from '../indicators/ichimoku.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

/**
 * Ichimoku Cloud strategy.
 *
 * TRA-183: stack the TRA-179 retest pattern on top of the kumo-breakout
 * entry. TRA-182 cleared the round-2 hit1R bar (17.6% → 50%) but the entry
 * fill was still too generous — price often ran +1R then reversed before the
 * 2R take-profit. The retest pattern arms a pending signal on the breakout
 * bar and waits for a pullback to the midpoint between the breakout close
 * and the kijun/cloud stop. Entry fills at the retest bar's close; the stop
 * stays at the *original* kijun/cloud level rather than the retest bar's
 * extreme that the TRA-179 reversal recipe used. This is a deliberate
 * deviation: bar-extreme stops on Ichimoku breakouts collapse to ~0.1% of
 * price, well below the 90 bps round-trip cost basis (40 bps commission +
 * 5 bps slippage on each leg), so 82–86% hit1R still produces avgRR ≈ −2.6 R
 * per trade. Keeping the kijun stop preserves the cost-vs-R economics while
 * the retest still delivers a better entry price.
 *
 * Universe constraint (TRA-183 acceptance): validated on liquid majors only —
 * BTC/ETH/SOL hourly under the TRA-169 cost model. Small-cap alts
 * (ADA/AVAX/LINK/MATIC) go negative on a flat 90 bps round-trip basis
 * because realized spread on alts exceeds the assumed cost. Do NOT enable
 * this strategy on small-caps without spread-aware costing — see TRA-185
 * for the structural fix. BTC produced 0 kumo-breakout signals on Yahoo's
 * hourly window (TRA-186 tracks that data-feed question separately).
 *
 * TRA-182: replaced entry trigger from "TK cross on cross-bar + price already
 * above/below cloud" to "kumo breakout + TK bias agrees". The previous trigger
 * was doubly restrictive (tight timing) yet late-stage (price had already
 * extended past the cloud), producing 17 signals / 4.8% winRate / 17.6% hit1R
 * across 90d×1h BTC/ETH/SOL. The breakout entry fires on the bar where price
 * actually closes through the cloud edge, with the TK line bias confirming the
 * direction. The chikou span and kumo-thickness gates are retained.
 *
 * TRA-170: dropped the ADX ≥ 25 gate — Ichimoku already encodes trend through
 * the kumo structure, so layering ADX on top was redundant and choked signal
 * frequency. The regime check is `(cloudTop − cloudBottom) / price ≥
 * kumoThicknessFloor`, i.e. the cloud must express a meaningful trend on its
 * own terms.
 *
 * Buy:  prev close ≤ prev cloudTop AND curr close > curr cloudTop (breakout)
 *       + tenkan > kijun (TK bias bullish) + chikou confirms + thick cloud
 * Sell: prev close ≥ prev cloudBottom AND curr close < curr cloudBottom
 *       + tenkan < kijun + chikou confirms + thick cloud
 *
 * Stop loss at kijun / opposite cloud edge; take-profit at 2:1 R:R.
 * Requires ≥ 79 candles (78 for ichimoku + 1 for the prev-bar comparison).
 */
const DEFAULT_KUMO_THICKNESS_PCT = 0.005;

export interface IchimokuOptions {
  /**
   * Minimum cloud thickness (cloudTop − cloudBottom) / price required to
   * accept a signal. Default 0.005 (0.5%). Exposed so walk-forward (TRA-177)
   * can sweep it.
   */
  kumoThicknessFloor?: number;
  /** Set false for 24/7 markets (default: true). */
  enforceTimeFilter?: boolean;
  /**
   * TRA-183: when true the breakout bar arms a pending retest instead of
   * firing immediately. The retest fires once price pulls back to the
   * midpoint between the breakout close and the kijun/cloud stop. Entry
   * fills at the retest bar's close (a better price than the breakout
   * close), while the *stop* stays at the original kijun/cloud level so
   * round-trip costs remain amortized over a meaningful price distance —
   * the TRA-179 reversal retest tightens the stop to the retest bar's
   * extreme, but on Ichimoku breakouts that collapses the stop to ~0.1%
   * which is below the 40 bps + 5 bps round-trip cost basis and produces
   * negative avgRR even at 80% hit1R. Default false to preserve the
   * TRA-182 immediate-entry behaviour for callers that haven't opted in.
   */
  retestEntry?: boolean;
  /**
   * TRA-183: bars to wait for the pullback before discarding the pending.
   * Default 16 — same anchor used by the reversal retest after the round-2
   * research sweep, on a similar 1h timeframe.
   */
  retestExpiryBars?: number;
  /**
   * TRA-183: take-profit multiple applied to the new (retest-entry → original
   * stop) distance. Default 2 preserves the strategy's original 2:1 R:R but
   * rebases the reward on the tighter post-retest stop distance — the win
   * line is closer in absolute terms because the entry has already moved
   * halfway toward the stop, so fewer trades need an outsized continuation
   * leg to clear TP.
   */
  retestRewardMultiple?: number;
  /**
   * TRA-183: tolerance band around the midpoint retest level, expressed as a
   * fraction of `|breakoutClose − originalStop|`. 0 (default) = strict
   * midpoint touch; 0.10 lets a shallower pullback fire the retest.
   */
  retestTolerancePct?: number;
}

interface PendingRetest {
  side: Side;
  /** Bar count (`candles.length`) at the moment the pending was armed. */
  armedAtBars: number;
  /** Discard once `candles.length` exceeds this. */
  expiresAtBars: number;
  /** Original breakout-bar entry price (used for retest level + sanity). */
  originalEntry: number;
  /** Midpoint(originalEntry, originalStop). Retest fires when price touches this level. */
  retestLevel: number;
  /** Original kijun/cloud stop — hard invalidation if price runs past it. */
  originalStop: number;
}

export class IchimokuStrategy {
  private readonly kumoThicknessFloor: number;
  private readonly enforceTimeFilter: boolean;
  private readonly retestEntry: boolean;
  private readonly retestExpiryBars: number;
  private readonly retestRewardMultiple: number;
  private readonly retestTolerancePct: number;

  /** Pending retest state, keyed by symbol so live multi-symbol callers stay isolated. */
  private readonly pending: Map<string, PendingRetest> = new Map();

  constructor(opts: IchimokuOptions = {}) {
    this.kumoThicknessFloor = opts.kumoThicknessFloor ?? DEFAULT_KUMO_THICKNESS_PCT;
    this.enforceTimeFilter = opts.enforceTimeFilter ?? true;
    this.retestEntry = opts.retestEntry ?? false;
    this.retestExpiryBars = opts.retestExpiryBars ?? 16;
    this.retestRewardMultiple = opts.retestRewardMultiple ?? 2;
    this.retestTolerancePct = opts.retestTolerancePct ?? 0;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < 79) return null;

    const latest = candles[candles.length - 1];

    // Time filter: only trade during high-volume windows (equity only;
    // disabled for 24/7 datasets via enforceTimeFilter=false).
    if (this.enforceTimeFilter && !isValidTradingWindow(latest.timestamp)) return null;

    // First, see whether an already-armed pending retest fires on this bar.
    // We do this before the breakout gate so a bar that would otherwise be
    // disqualified (no fresh breakout) can still fire a pending retest.
    if (this.retestEntry) {
      const retestSignal = this.tryFireRetest(symbol, candles);
      if (retestSignal) return retestSignal;
    }

    const cloud = ichimoku(candles);
    const prevCloud = ichimoku(candles.slice(0, -1));
    if (!cloud || !prevCloud) return null;

    const price = latest.close;
    const prevClose = candles[candles.length - 2].close;

    // Kumo-thickness regime check (TRA-170): cloud must express a real trend.
    if (price <= 0) return null;
    const cloudThicknessPct = (cloud.cloudTop - cloud.cloudBottom) / price;
    if (cloudThicknessPct < this.kumoThicknessFloor) return null;

    let side: Side | null = null;

    // Bull kumo breakout: prev close at-or-below the cloud top, curr close
    // through it. TK bias must agree (tenkan > kijun) and chikou confirms.
    if (
      prevClose <= prevCloud.cloudTop &&
      price > cloud.cloudTop &&
      cloud.tenkan > cloud.kijun &&
      cloud.chikouAbove
    ) {
      side = 'buy';
    }

    // Bear kumo breakout: prev close at-or-above the cloud bottom, curr close
    // through it. TK bias must agree (tenkan < kijun) and chikou confirms.
    if (
      prevClose >= prevCloud.cloudBottom &&
      price < cloud.cloudBottom &&
      cloud.tenkan < cloud.kijun &&
      !cloud.chikouAbove
    ) {
      side = 'sell';
    }

    if (!side) return null;

    const entryPrice = price;
    const stopLoss = side === 'buy'
      ? Math.min(cloud.kijun, cloud.cloudBottom)
      : Math.max(cloud.kijun, cloud.cloudTop);

    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance === 0) return null;

    const takeProfit = side === 'buy'
      ? entryPrice + stopDistance * 2
      : entryPrice - stopDistance * 2;

    if (this.retestEntry) {
      // Arm a pending retest instead of firing immediately. Retest level is
      // the midpoint between breakout close and kijun/cloud stop — deep
      // enough into the breakout bar's body to reset the structural stop to
      // a level price has already respected, but shallow enough that most
      // continuation moves revisit it within a handful of bars.
      this.pending.set(symbol, {
        side,
        armedAtBars: candles.length,
        expiresAtBars: candles.length + this.retestExpiryBars,
        originalEntry: entryPrice,
        retestLevel: (entryPrice + stopLoss) / 2,
        originalStop: stopLoss,
      });
      return null;
    }

    return {
      id: randomUUID(),
      symbol,
      type: 'ichimoku',
      side,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: 2,
      timestamp: latest.timestamp,
    };
  }

  /**
   * Returns a TradeSignal when the current bar touches the armed retest
   * level *and* still confirms the original direction (kumo bias intact).
   * Otherwise either leaves the pending in place (no touch yet) or clears it
   * (expiry, stop-breach during wait, or contradictory kumo bias).
   *
   * Entry fills at the retest bar's close. The *stop* stays at the original
   * kijun/cloud level — unlike TRA-179's reversal retest (which tightens to
   * the retest bar's extreme), Ichimoku's original stop is several percent
   * away while the retest bar's wick is typically <0.5% from its close. Re-
   * stopping at the wick on 40 bps + 5 bps cost basis collapses the stop
   * distance below the round-trip cost and produces deeply negative avgRR
   * even at 80% hit1R (verified empirically on the round-2 sample). Keeping
   * the kijun stop preserves cost economics while the better entry price
   * still delivers the retest pattern's edge.
   */
  private tryFireRetest(symbol: string, candles: Candle[]): TradeSignal | null {
    const pending = this.pending.get(symbol);
    if (!pending) return null;

    const latest = candles[candles.length - 1];

    // Hard invalidation: original kijun/cloud stop was breached at any point
    // during the wait. Blowing through it means the breakout failed; entering
    // here would be averaging into a regime change dressed up as a retest.
    const breached = pending.side === 'buy'
      ? latest.low <= pending.originalStop
      : latest.high >= pending.originalStop;
    if (breached) {
      this.pending.delete(symbol);
      return null;
    }

    if (candles.length > pending.expiresAtBars) {
      this.pending.delete(symbol);
      return null;
    }

    // Optional tolerance band — `retestTolerancePct` of the entry/stop
    // distance is added to the touch level so a shallow pullback counts as a
    // retest. Default 0 reproduces a strict midpoint touch.
    const tolDistance = this.retestTolerancePct > 0
      ? Math.abs(pending.originalEntry - pending.originalStop) * this.retestTolerancePct
      : 0;
    const buyTouchLevel = pending.retestLevel + tolDistance;
    const sellTouchLevel = pending.retestLevel - tolDistance;
    const touched = pending.side === 'buy'
      ? latest.low <= buyTouchLevel
      : latest.high >= sellTouchLevel;
    if (!touched) return null;

    // Confirmation guard: the kumo bias must still agree with the original
    // direction. A retest is only valid if the breakout structure is intact —
    // tenkan/kijun haven't crossed back, and chikou still confirms.
    const cloud = ichimoku(candles);
    if (!cloud) return null;
    if (pending.side === 'buy') {
      if (cloud.tenkan <= cloud.kijun) { this.pending.delete(symbol); return null; }
      if (!cloud.chikouAbove) { this.pending.delete(symbol); return null; }
    } else {
      if (cloud.tenkan >= cloud.kijun) { this.pending.delete(symbol); return null; }
      if (cloud.chikouAbove) { this.pending.delete(symbol); return null; }
    }

    // Entry at the retest bar's close — a tighter fill than the breakout
    // close because price has now pulled back toward the kijun/cloud level
    // that gates the structural stop. The stop itself stays at the original
    // kijun/cloud level (see method docstring for why this differs from the
    // reversal retest in TRA-179). Sanity-check that the retest entry hasn't
    // already moved through the original stop (would imply a same-bar wick
    // breach we missed above).
    const entryPrice = latest.close;
    const stopLoss = pending.originalStop;
    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance <= 0) {
      this.pending.delete(symbol);
      return null;
    }

    // Take-profit is `retestRewardMultiple × new_stopDistance` from the
    // retest entry. Because entry has moved closer to stop, the TP price
    // is closer than the original kijun-based 2R TP — a smaller absolute
    // continuation move clears the win, which is what the round-2 plan
    // called for.
    const tpDistance = stopDistance * this.retestRewardMultiple;
    const takeProfit = pending.side === 'buy'
      ? entryPrice + tpDistance
      : entryPrice - tpDistance;

    this.pending.delete(symbol);
    return {
      id: randomUUID(),
      symbol,
      type: 'ichimoku',
      side: pending.side,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: tpDistance / stopDistance,
      timestamp: latest.timestamp,
    };
  }

  async evaluateAndOrder(
    symbol: string,
    candles: Candle[],
    riskManager: RiskManager,
    orderClient: AlpacaOrderClient,
  ): Promise<TradeSignal | null> {
    const signal = this.evaluate(symbol, candles);
    if (!signal) return null;

    const qty = riskManager.sizeFromStop(signal.entryPrice, signal.stopLoss);
    if (qty <= 0) return null;

    await orderClient.submitBracketOrder({
      symbol: signal.symbol,
      qty,
      side: signal.side,
      limitPrice: signal.entryPrice,
      takeProfitPrice: signal.takeProfit,
      stopLossPrice: signal.stopLoss,
    });

    return signal;
  }
}
