import { Candle, TradeSignal, Side, ADX_TRENDING_THRESHOLD, isValidTradingWindow } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { rsi, rsiDivergence } from '../indicators/rsi.js';
import { detectPattern, isBullishPattern, isBearishPattern } from '../indicators/patterns.js';
import { macdCross } from '../indicators/macd.js';
import { adx } from '../indicators/adx.js';
import { atr } from '../indicators/atr.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

export interface ReversalOptions {
  rsiPeriod?: number;
  /** RSI overbought threshold (default: 70). */
  rsiOverbought?: number;
  /** RSI oversold threshold (default: 30). */
  rsiOversold?: number;
  lookback?: number;
  /** Set false for 24/7 markets like crypto (default: true). */
  enforceTimeFilter?: boolean;
  /** ATR lookback period (default: 14). */
  atrPeriod?: number;
  /**
   * If set, stop distance is `atrStopMultiplier × ATR` instead of the
   * structural window high/low. Default undefined → keep structural stops.
   */
  atrStopMultiplier?: number;
  /**
   * If set, take-profit distance is `atrTpMultiplier × ATR`. Defaults to
   * undefined → fall back to the strategy's 3× R:R.
   */
  atrTpMultiplier?: number;
  /**
   * Dead-tape filter: skip signals when ATR / price is below this fraction.
   * Default 0.003 (0.3%). Set 0 to disable.
   */
  volatilityFloorPct?: number;
  /**
   * Volume-climax multiplier vs. the trailing average over `lookback` bars.
   * Default 1.3 (matches the post-TRA-170 hardcode). Exposed so walk-forward
   * (TRA-172/177) can sweep it as a knob.
   */
  volumeMultiplier?: number;
  /**
   * TRA-179: when true (default) the first bar that satisfies all entry
   * conditions arms a "pending" signal whose entry only fires once a later
   * bar pulls back to the midpoint between the original entry and stop. The
   * retest bar's low/high becomes the new structural stop, which is typically
   * tighter than the original signal-bar window extreme. Set false to fall
   * back to immediate entry on the signal bar (legacy behavior).
   */
  retestEntry?: boolean;
  /**
   * TRA-179: maximum bars to wait for a retest before discarding a pending
   * signal. Default 16 — tuned on the round-2 crypto sample to give the
   * pullback enough time to print without dragging the entry into a regime
   * change.
   */
  retestExpiryBars?: number;
  /**
   * TRA-179: take-profit multiple applied to the *retest* stop distance, i.e.
   * `tp = retestEntry + retestRewardMultiple × |retestEntry − retestStop|`
   * (sign-flipped for shorts). Default 3 keeps the strategy's longstanding
   * 3:1 R:R, but expressed against the *new* tighter stop instead of the
   * legacy signal-bar window stop — that mismatch was what produced the
   * catastrophic per-trade RR in the round-2 backtest.
   */
  retestRewardMultiple?: number;
  /**
   * TRA-181: tolerance band around the midpoint retest level, expressed as a
   * fraction of `|originalEntry − originalStop|`. 0 (default) = strict midpoint
   * touch (legacy TRA-179 behaviour). 0.10 = the retest fires anywhere within
   * ±10% of the entry/stop distance around the midpoint, i.e. shallower
   * pullbacks count as a touch.
   */
  retestTolerancePct?: number;
  /**
   * TRA-181: structural-stop buffer applied to the retest bar's low/high,
   * expressed as a fraction of the bar's structural distance. Default 0.25
   * matches the original TRA-179 hardcode. Smaller values tighten the stop
   * (better R:R but more whipsaw); larger values give more slack.
   */
  retestStopBufferFrac?: number;
  /**
   * TRA-181: when true, the retest only fires if the retest bar's volume is
   * at least the signal bar's volume. Default false. Acts as a confirmation
   * filter — a retest accompanied by participation rather than fade.
   */
  retestRequireVolumeIncrease?: boolean;
}

interface PendingRetest {
  side: Side;
  /** Bar count (`candles.length`) at the moment the pending was armed. */
  armedAtBars: number;
  /** Discard once `candles.length` exceeds this. */
  expiresAtBars: number;
  /** Original signal-bar entry price (used for retest level + sanity). */
  originalEntry: number;
  /** Midpoint(originalEntry, originalStop). Retest fires when price touches this level. */
  retestLevel: number;
  /** Original signal-bar stop — used as a hard invalidation: if price runs past it, scrap the pending. */
  originalStop: number;
  /** Signal-bar volume captured at arm time so the optional retest-volume gate has something to compare to. */
  signalBarVolume: number;
}

/**
 * RSI reversal strategy.
 *
 * TRA-170: filters were too tight on real market data — 0 fires across 90d×1h
 * BTC/ETH/SOL. Loosened so a confirmed RSI extreme + (pattern OR divergence)
 * + volume spike can produce a signal even when MACD is flat. The MACD cross
 * direction is now a *tiebreaker* (it can veto the opposite-direction cross,
 * but a missing/neutral cross no longer blocks the entry).
 *
 * TRA-179: retest entry. The post-TRA-170 backtest showed an 88% 1R hit rate
 * on raw signals but a -3.47R per-trade outcome — stops were getting hit
 * before the take-profit because the signal bar itself is a high-volatility
 * inflection point. Now the strategy arms a pending signal on the first
 * match and only enters on a subsequent pullback to the midpoint between
 * the original entry and stop. The retest bar's low/high becomes the
 * structural stop (tighter than the original window extreme), which collapses
 * the per-trade R:R asymmetry in the backtest.
 */
export class ReversalStrategy {
  private readonly rsiPeriod: number;
  private readonly rsiOverbought: number;
  private readonly rsiOversold: number;
  private readonly lookback: number;
  private readonly enforceTimeFilter: boolean;
  private readonly atrPeriod: number;
  private readonly atrStopMultiplier: number | null;
  private readonly atrTpMultiplier: number | null;
  private readonly volatilityFloorPct: number;
  private readonly volumeMultiplier: number;
  private readonly retestEntry: boolean;
  private readonly retestExpiryBars: number;
  private readonly retestRewardMultiple: number;
  private readonly retestTolerancePct: number;
  private readonly retestStopBufferFrac: number;
  private readonly retestRequireVolumeIncrease: boolean;

  /** Pending retest state, keyed by symbol so live multi-symbol callers stay isolated. */
  private readonly pending: Map<string, PendingRetest> = new Map();

  constructor(opts: ReversalOptions = {}) {
    this.rsiPeriod = opts.rsiPeriod ?? 14;
    this.rsiOverbought = opts.rsiOverbought ?? 70;
    this.rsiOversold = opts.rsiOversold ?? 30;
    this.lookback = opts.lookback ?? 5;
    this.enforceTimeFilter = opts.enforceTimeFilter ?? true;
    this.atrPeriod = opts.atrPeriod ?? 14;
    this.atrStopMultiplier = opts.atrStopMultiplier ?? null;
    this.atrTpMultiplier = opts.atrTpMultiplier ?? null;
    this.volatilityFloorPct = opts.volatilityFloorPct ?? 0.003;
    this.volumeMultiplier = opts.volumeMultiplier ?? 1.3;
    this.retestEntry = opts.retestEntry ?? true;
    this.retestExpiryBars = opts.retestExpiryBars ?? 16;
    this.retestRewardMultiple = opts.retestRewardMultiple ?? 3;
    this.retestTolerancePct = opts.retestTolerancePct ?? 0;
    this.retestStopBufferFrac = opts.retestStopBufferFrac ?? 0.25;
    this.retestRequireVolumeIncrease = opts.retestRequireVolumeIncrease ?? false;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < this.rsiPeriod + this.lookback + 1) return null;

    const latest = candles[candles.length - 1];

    // Time filter: avoid midday chop and after-hours noise (equity only; disabled for crypto)
    if (this.enforceTimeFilter && !isValidTradingWindow(latest.timestamp)) return null;

    // First, see whether an already-armed pending retest fires on this bar.
    // We do this before the ADX/RSI gates so a transient regime hiccup on the
    // retest bar doesn't kill an otherwise-valid setup; the per-bar
    // "still-confirming" check below is the safeguard.
    if (this.retestEntry) {
      const retestSignal = this.tryFireRetest(symbol, candles);
      if (retestSignal) return retestSignal;
    }

    // ADX regime filter: reversals only work in ranging markets
    // Skip if ADX > 25 (strong trend makes mean reversion risky)
    const adxResult = adx(candles);
    if (adxResult && adxResult.adx > ADX_TRENDING_THRESHOLD) return null;

    const closes = candles.map(c => c.close);
    const currentRsi = rsi(closes, this.rsiPeriod);
    if (isNaN(currentRsi)) return null;

    const divergence = rsiDivergence(closes, this.rsiPeriod, this.lookback);
    const pattern = detectPattern(candles.slice(-2));

    // Volume climax: current volume > volumeMultiplier × average of lookback
    // window. TRA-170 lowered the default from 1.5× → 1.3× because the previous
    // threshold blocked most genuine reversals on 1h crypto bars (where volume
    // spikes are smaller than on equity 1-min bars). The multiplier is exposed
    // (TRA-177) so walk-forward can sweep it.
    const window = candles.slice(-this.lookback - 1, -1);
    const avgVolume = window.reduce((s, c) => s + c.volume, 0) / window.length;
    const volumeClimax = latest.volume > avgVolume * this.volumeMultiplier;

    // MACD direction is a *tiebreaker* (TRA-170): a contradictory cross vetoes
    // the entry, but a missing or neutral cross no longer blocks it.
    const cross = macdCross(closes);

    let side: Side | null = null;

    // Sell reversal: RSI overbought + (pattern OR divergence) + volume spike,
    // with no contradictory MACD bullish cross.
    if (
      currentRsi > this.rsiOverbought &&
      (isBearishPattern(pattern) || divergence === 'bearish') &&
      volumeClimax &&
      cross !== 'bullish'
    ) {
      side = 'sell';
    }

    // Buy reversal: RSI oversold + (pattern OR divergence) + volume spike,
    // with no contradictory MACD bearish cross.
    if (
      currentRsi < this.rsiOversold &&
      (isBullishPattern(pattern) || divergence === 'bullish') &&
      volumeClimax &&
      cross !== 'bearish'
    ) {
      side = 'buy';
    }

    if (!side) return null;

    const entryPrice = latest.close;

    // Volatility regime gate: skip dead tape where stops barely cover spread.
    const atrValue = atr(candles, this.atrPeriod);
    if (atrValue !== null && this.volatilityFloorPct > 0) {
      const atrFraction = entryPrice > 0 ? atrValue / entryPrice : 0;
      if (atrFraction < this.volatilityFloorPct) return null;
    }

    // Stop: ATR-based when the multiplier is set and ATR computes,
    // otherwise the structural window high/low (the original behavior).
    const useAtrStop = atrValue !== null && this.atrStopMultiplier !== null && this.atrStopMultiplier > 0;
    let stopDistance: number;
    if (useAtrStop) {
      stopDistance = (this.atrStopMultiplier as number) * atrValue;
    } else {
      const windowHigh = Math.max(...window.map(c => c.high));
      const windowLow = Math.min(...window.map(c => c.low));
      const structuralStop = side === 'buy' ? windowLow : windowHigh;
      stopDistance = Math.abs(entryPrice - structuralStop);
    }
    if (stopDistance <= 0) return null;

    const tpDistance = useAtrStop && this.atrTpMultiplier !== null
      ? this.atrTpMultiplier * (atrValue as number)
      : stopDistance * 3;

    const stopLoss = side === 'buy' ? entryPrice - stopDistance : entryPrice + stopDistance;
    const takeProfit = side === 'buy' ? entryPrice + tpDistance : entryPrice - tpDistance;

    if (this.retestEntry) {
      // Arm a pending retest instead of firing immediately. Retest level is
      // the midpoint between entry and stop; that's deep enough into the
      // signal bar's body to reset the structural stop to a level that has
      // already been respected, but shallow enough that most genuine
      // reversals revisit it within a handful of bars.
      this.pending.set(symbol, {
        side,
        armedAtBars: candles.length,
        expiresAtBars: candles.length + this.retestExpiryBars,
        originalEntry: entryPrice,
        retestLevel: (entryPrice + stopLoss) / 2,
        originalStop: stopLoss,
        signalBarVolume: latest.volume,
      });
      return null;
    }

    return {
      id: randomUUID(),
      symbol,
      type: 'reversal',
      side,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: tpDistance / stopDistance,
      timestamp: latest.timestamp,
    };
  }

  /**
   * Returns a TradeSignal when the current bar touches the armed retest
   * level *and* still confirms the original direction. Otherwise either
   * leaves the pending in place (no touch yet) or clears it (expiry,
   * stop-breach during wait, or contradictory momentum on the retest bar).
   *
   * Same-bar entry uses the bar's close as the fill price and a structural
   * stop slightly below the bar's low (long) / above the bar's high (short).
   * The 25% buffer keeps the runner's `bar.low <= stop` comparator from
   * trivially firing on the entry bar — without it, the retest bar's own
   * low/high is *exactly* the stop and the position gets closed instantly.
   */
  private tryFireRetest(symbol: string, candles: Candle[]): TradeSignal | null {
    const pending = this.pending.get(symbol);
    if (!pending) return null;

    const latest = candles[candles.length - 1];

    // Hard invalidation: original signal-bar stop was breached at any point
    // during the wait. The pullback toward midpoint is fine, but blowing
    // through the original structural stop means the regime broke; entering
    // here would be averaging into a continuation move dressed up as a retest.
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

    // TRA-181: optional tolerance band — `retestTolerancePct` of the
    // entry/stop distance is added to the touch level so a shallow pullback
    // counts as a retest. Default 0 reproduces the strict TRA-179 midpoint.
    const tolDistance = this.retestTolerancePct > 0
      ? Math.abs(pending.originalEntry - pending.originalStop) * this.retestTolerancePct
      : 0;
    const buyTouchLevel = pending.retestLevel + tolDistance;
    const sellTouchLevel = pending.retestLevel - tolDistance;
    const touched = pending.side === 'buy'
      ? latest.low <= buyTouchLevel
      : latest.high >= sellTouchLevel;
    if (!touched) return null;

    // TRA-181: optional volume confirmation — the retest bar must clear the
    // signal bar's volume. Filters out fade pullbacks where price drifts back
    // to the level on no participation.
    if (this.retestRequireVolumeIncrease && latest.volume < pending.signalBarVolume) {
      return null;
    }

    // Confirmation guard: a contradictory MACD cross during the wait
    // (momentum flipped) or a fully-reversed RSI extreme (price has
    // already mean-reverted past neutral) invalidates the setup.
    const closes = candles.map(c => c.close);
    const currentRsi = rsi(closes, this.rsiPeriod);
    if (isNaN(currentRsi)) return null;
    const cross = macdCross(closes);

    if (pending.side === 'buy') {
      if (cross === 'bearish') { this.pending.delete(symbol); return null; }
      if (currentRsi >= this.rsiOverbought) { this.pending.delete(symbol); return null; }
    } else {
      if (cross === 'bullish') { this.pending.delete(symbol); return null; }
      if (currentRsi <= this.rsiOversold) { this.pending.delete(symbol); return null; }
    }

    // Entry at the retest bar's close (a stronger fill than the retest level
    // itself when the bar pulled in and rejected). Stop is the bar's
    // low/high *with a configurable buffer* (TRA-181, was a hardcoded 25% in
    // TRA-179) so the runner's `bar.low <= stop` check doesn't trivially fire
    // on the entry bar — the buffer guarantees the stop sits strictly below
    // the bar's structural low and only fires on a genuine break.
    const entryPrice = latest.close;
    const structuralLevel = pending.side === 'buy' ? latest.low : latest.high;
    const rawStopDistance = Math.abs(entryPrice - structuralLevel);
    if (rawStopDistance <= 0) {
      this.pending.delete(symbol);
      return null;
    }
    const stopDistance = rawStopDistance * (1 + this.retestStopBufferFrac);
    const stopLoss = pending.side === 'buy'
      ? entryPrice - stopDistance
      : entryPrice + stopDistance;

    // Take-profit is `retestRewardMultiple × new_stopDistance` from the
    // retest entry. Carrying the legacy 3R reward (built off the much-wider
    // signal-bar stop) translated into TPs that almost never hit once the
    // retest stop tightened — the round-2 backtest's 100% 1R hit-rate at
    // -2.84 avgRR was the smoking gun.
    const tpDistance = stopDistance * this.retestRewardMultiple;
    const takeProfit = pending.side === 'buy'
      ? entryPrice + tpDistance
      : entryPrice - tpDistance;

    this.pending.delete(symbol);
    return {
      id: randomUUID(),
      symbol,
      type: 'reversal',
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
