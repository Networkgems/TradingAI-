import { Candle, TradeSignal, Side } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { emaSeries } from '../indicators/ma.js';
import { donchian } from '../indicators/donchian.js';
import { atr } from '../indicators/atr.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';
import type { RegimeDetector, Regime } from '../regime.js';

export interface MomentumOptions {
  /** Fast EMA period for the trend filter (default: 50). */
  fastMaPeriod?: number;
  /** Slow EMA period for the trend filter (default: 200). */
  slowMaPeriod?: number;
  /** Donchian lookback for breakout confirmation (default: 20 bars). */
  donchianPeriod?: number;
  /** ATR period for stop sizing (default: 14). */
  atrPeriod?: number;
  /** Stop distance = `atrStopMultiplier × ATR` (default: 2). */
  atrStopMultiplier?: number;
  /**
   * Take-profit distance = `atrTpMultiplier × ATR`. Default 4 → ~2:1 R:R when
   * paired with the default 2× ATR stop. The fixed-multiple TP is a deliberate
   * compromise: trend trades benefit from runner targets, but a deterministic
   * TP keeps backtest comparisons against `MacdTrendStrategy` and the rest of
   * the strategy roster apples-to-apples.
   */
  atrTpMultiplier?: number;
  /**
   * Bars to wait after a fire before re-arming the breakout trigger. In a
   * sustained trend the Donchian channel keeps printing new highs every bar;
   * without this cooldown the strategy would emit one signal per bar. The
   * runner's `alreadyOpen` guard handles in-flight position dedup, but the
   * cooldown also protects the signal-edge metric from being flooded by
   * effectively-identical setups. Default: 1× the Donchian lookback.
   */
  rearmBars?: number;
  /**
   * Lot-size for ATR-based sizing. Forwarded to `RiskManager.sizeFromAtr`;
   * crypto callers typically use 1e-6 (Coinbase BTC) so a $500 risk budget
   * over a $1k stop sizes to 0.5 BTC instead of being floored to 0.
   */
  lotSize?: number;
}

interface ResolvedOptions {
  fastMaPeriod: number;
  slowMaPeriod: number;
  donchianPeriod: number;
  atrPeriod: number;
  atrStopMultiplier: number;
  atrTpMultiplier: number;
  rearmBars: number;
  lotSize: number | undefined;
}

const DEFAULTS: Omit<ResolvedOptions, 'rearmBars'> = {
  fastMaPeriod: 50,
  slowMaPeriod: 200,
  donchianPeriod: 20,
  atrPeriod: 14,
  atrStopMultiplier: 2,
  atrTpMultiplier: 4,
  lotSize: undefined,
};

/**
 * Momentum / trend-following strategy (TRA-205, B6 in TRA-197 spec §4).
 *
 * Direction filter:
 *   - Long  iff RegimeDetector says `trend_up`   AND fast EMA > slow EMA.
 *   - Short iff RegimeDetector says `trend_down` AND fast EMA < slow EMA.
 *   - Any other regime (`range`, `high_vol`, `flat`) silently bails — those
 *     are owned by other strategies in the roster.
 *
 * Trigger:
 *   - Long: latest close strictly above the prior `donchianPeriod`-bar high.
 *   - Short: mirror image on the lower channel.
 *   A bar-count cooldown (`rearmBars`, default = `donchianPeriod`) suppresses
 *   re-fires inside the same trend leg — a smooth uptrend prints fresh
 *   Donchian highs on every bar, and without the cooldown the signal stream
 *   would be a flood of effectively-identical setups. The cooldown re-arms
 *   automatically, so a long persistent trend still gets multiple entries
 *   spaced ~1 Donchian window apart.
 *
 * Risk:
 *   - Stop distance = `atrStopMultiplier × ATR` (default 2× ATR), so the
 *     stop widens automatically in volatile tape and tightens in calm tape.
 *   - Take-profit = `atrTpMultiplier × ATR` (default 4× ATR → 2:1 R:R).
 *
 * Sizing:
 *   - `evaluateAndOrder` uses `RiskManager.sizeFromAtr` (TRA-202) which holds
 *     achieved $-risk-per-trade constant across volatility regimes.
 */
export class MomentumStrategy {
  private readonly opt: ResolvedOptions;
  private readonly regime: RegimeDetector;
  /**
   * Bar timestamp of the most recent fire. The strategy stays in cooldown
   * until `latest.timestamp - lastFireTs >= rearmBars × barInterval`. Using
   * timestamps (not a bar counter) keeps the cooldown honest under the
   * runner's expanding-window evaluation, where missed evaluations would
   * desync a counter.
   */
  private lastFireTs: number | null = null;

  constructor(regime: RegimeDetector, opts: MomentumOptions = {}) {
    this.regime = regime;
    const donchianPeriod = opts.donchianPeriod ?? DEFAULTS.donchianPeriod;
    this.opt = {
      ...DEFAULTS,
      ...opts,
      // Default rearm = donchianPeriod so a steady trend produces ~one signal
      // per Donchian-window worth of bars, not one per bar.
      rearmBars: opts.rearmBars ?? donchianPeriod,
      donchianPeriod,
    };
  }

  /**
   * Evaluate the latest bar and return a momentum entry signal if rules fire.
   *
   * The router (TRA-208) drives a stateful `RegimeDetector` once per tick and
   * passes the active label as `regime` so multiple regime-gated strategies
   * can share a single hysteresis state. Without a passed-in label this falls
   * back to the standalone path: the constructor-supplied detector is updated
   * here and used for the gate — preserving the pre-router contract used by
   * tests, the backtest runner, and ad-hoc callers.
   */
  evaluate(symbol: string, candles: Candle[], regime?: Regime): TradeSignal | null {
    const minBars = Math.max(
      this.opt.slowMaPeriod + 1,
      this.opt.donchianPeriod + 2,
      this.opt.atrPeriod + 1,
    );
    if (candles.length < minBars) return null;

    // Regime gate is the first thing we check — momentum has no business
    // firing in range/high_vol/flat tape. When the router supplies the label
    // we skip the internal `regime.update` so a shared detector isn't double-
    // ticked; standalone callers still get the in-place hysteresis update.
    const effectiveRegime: Regime = regime ?? this.regime.update(candles);
    if (effectiveRegime !== 'trend_up' && effectiveRegime !== 'trend_down') return null;

    const closes = candles.map((c) => c.close);
    const fastSeries = emaSeries(closes, this.opt.fastMaPeriod);
    const slowSeries = emaSeries(closes, this.opt.slowMaPeriod);
    const fastNow = fastSeries[fastSeries.length - 1];
    const slowNow = slowSeries[slowSeries.length - 1];
    if (!Number.isFinite(fastNow) || !Number.isFinite(slowNow)) return null;

    let side: Side | null = null;
    if (effectiveRegime === 'trend_up' && fastNow > slowNow) side = 'buy';
    if (effectiveRegime === 'trend_down' && fastNow < slowNow) side = 'sell';
    if (side === null) return null;

    // Donchian breakout — channel is computed from the prior N bars (current
    // bar excluded) so a close *beyond* the channel is unambiguously a breakout.
    const ch = donchian(candles, this.opt.donchianPeriod, true);
    if (!ch) return null;

    const latest = candles[candles.length - 1];

    const breakoutLong = side === 'buy' && latest.close > ch.upper;
    const breakoutShort = side === 'sell' && latest.close < ch.lower;
    if (!breakoutLong && !breakoutShort) return null;

    // Cooldown: a sustained trend prints fresh Donchian highs every bar, so
    // without a re-arm window the strategy would emit one signal per bar.
    // Skipping when we last fired within `rearmBars` bars keeps the signal
    // stream sparse without losing the "trend persists" re-entry chance once
    // the cooldown elapses.
    if (this.lastFireTs !== null && candles.length >= 2) {
      const barInterval = latest.timestamp - candles[candles.length - 2].timestamp;
      if (barInterval > 0
        && latest.timestamp - this.lastFireTs < this.opt.rearmBars * barInterval) {
        return null;
      }
    }

    const atrValue = atr(candles, this.opt.atrPeriod);
    if (atrValue === null || atrValue <= 0) return null;

    const stopDistance = this.opt.atrStopMultiplier * atrValue;
    const tpDistance = this.opt.atrTpMultiplier * atrValue;
    if (stopDistance <= 0 || tpDistance <= 0) return null;

    const entryPrice = latest.close;
    const stopLoss = side === 'buy' ? entryPrice - stopDistance : entryPrice + stopDistance;
    const takeProfit = side === 'buy' ? entryPrice + tpDistance : entryPrice - tpDistance;

    this.lastFireTs = latest.timestamp;
    return {
      id: randomUUID(),
      symbol,
      type: 'momentum',
      side,
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

    const atrValue = atr(candles, this.opt.atrPeriod);
    if (atrValue === null) return null;

    const qty = riskManager.sizeFromAtr(
      signal.entryPrice,
      atrValue,
      this.opt.atrStopMultiplier,
      this.opt.lotSize,
    );
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
