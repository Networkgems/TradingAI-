/*
 * DORMANT / ARCHIVED — TRA-816 (TRA-814 workstream B cleanup).
 * OOS-failed roster: 0 of 10 keeper-gate pools passed after costs (TRA-306, TRA-523).
 * NOT wired into any live or demo router — no selectable strategy preset
 * enables it (packages/shared STRATEGY_PRESETS is DCA-only; live = no_trade).
 * Kept here for research history; still reachable via the @trading-app/engine
 * public API only for the backtest harnesses. Do NOT re-wire into a live/demo
 * path until it clears the TRA-814 §4-C OOS keeper gate. See /TRA/issues/TRA-816.
 */

import type { Candle, TradeSignal } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { atr } from '../../indicators/atr.js';
import { classifyRegime, type Regime, type RegimeDetectorOptions } from '../../regime.js';

export interface BreakoutVolOptions {
  /** Bars of consolidation inspected for the channel + volume baseline. Spec §4 default: 20. */
  consolidationBars?: number;
  /**
   * Maximum consolidation range as a fraction of latest close. The spec §4
   * starting value is 6%; flagged TBD pending walk-forward. A tighter range
   * means a cleaner coil, so the breakout is more likely to be a real
   * volatility expansion rather than mid-trend noise.
   */
  maxRangeFraction?: number;
  /**
   * Entry-bar volume multiplier vs. the consolidation-window SMA. Spec §4
   * default: 2.0. The volume confirmation is the load-bearing filter — a
   * breakout-without-volume tends to be a false break that snaps back.
   */
  volumeMultiplier?: number;
  /** ATR lookback for stop/target sizing. Spec §4 default: 14. */
  atrPeriod?: number;
  /** Hard-stop distance = `atrStopMultiplier × ATR`. Spec §4 default: 2.0. */
  atrStopMultiplier?: number;
  /** Take-profit distance = `atrTpMultiplier × ATR`. Spec §4 default: 4.0 → 2:1 R:R. */
  atrTpMultiplier?: number;
  /**
   * Optional override for the internal `classifyRegime` call. Only used when
   * the caller does not pass a `regime` to `evaluate()` (i.e. self-contained
   * usage / unit tests). Router-driven flow with a stateful `RegimeDetector`
   * supplies the active label and ignores this.
   */
  regimeOptions?: RegimeDetectorOptions;
  /**
   * TRA-261 — per-side parameter overrides. Long-side fields stay byte-
   * identical to the TRA-207 spec values; short-side fields layer on top of
   * the resolved options ONLY when emitting a short. Used by the
   * perp shorts spec (TRA-255 §4) so short entries pull a tighter stop ATR
   * multiplier and a volume-confirmation bump without conditional drift in
   * the long path. Omit either field to keep that direction's values at the
   * long-side baseline.
   */
  paramsByDirection?: {
    long?: Partial<Omit<BreakoutVolOptions, 'paramsByDirection'>>;
    short?: Partial<Omit<BreakoutVolOptions, 'paramsByDirection'>>;
  };
}

/**
 * Breakout / volatility-expansion strategy (TRA-207, B8 in TRA-197 spec §4).
 *
 * Entry premise: price has been coiling in a tight range (consolidation) and
 * just printed a breakout candle with abnormally high volume. The
 * volume-confirmation filter is what separates a real expansion from the
 * "Donchian fakeout" that mean-reverts within a couple of bars.
 *
 * Regime gate (per spec §4):
 *   - `high_vol` is the canonical home for this strategy.
 *   - `flat` is also allowed: the spec specifically wants to catch the
 *     `flat → high_vol` transition bar where the expansion fires *as* the
 *     regime detector is still hysteresis-confirming. The runner is responsible
 *     for closing-at-market if `high_vol` is not confirmed within 2 bars
 *     (spec §4 lifecycle); the strategy's job is just to fire on the edge.
 *   - `trend_up`, `trend_down`, `range` → bail. Those are momentum / mean-rev
 *     territory; firing breakout there pollutes the strategy's edge with
 *     setups that already have a better-fit owner.
 *
 * Trigger:
 *   - Long  — close strictly above the consolidation high (max(high) over the
 *     prior `consolidationBars`, current bar excluded) AND current-bar volume
 *     ≥ `volumeMultiplier × SMA(volume, consolidationBars)` over the same
 *     window AND consolidation range / close < `maxRangeFraction`.
 *   - Short — mirror image on the consolidation low.
 *
 * Risk:
 *   - Hard stop = `atrStopMultiplier × ATR(atrPeriod)`.
 *   - Take-profit = `atrTpMultiplier × ATR(atrPeriod)`.
 *   - Trailing (BE after +2·ATR, then 2·ATR trail) and the 15-bar time stop
 *     from spec §4 are runner / position-manager responsibilities — see the
 *     same split-of-concerns used by `MomentumStrategy`.
 *     `evaluate()` only emits the entry.
 */
interface ResolvedBreakoutOptions {
  consolidationBars: number;
  maxRangeFraction: number;
  volumeMultiplier: number;
  atrPeriod: number;
  atrStopMultiplier: number;
  atrTpMultiplier: number;
}

const BREAKOUT_DEFAULTS: ResolvedBreakoutOptions = {
  consolidationBars: 20,
  maxRangeFraction: 0.06,
  volumeMultiplier: 2.0,
  atrPeriod: 14,
  atrStopMultiplier: 2.0,
  atrTpMultiplier: 4.0,
};

export class BreakoutVolStrategy {
  private readonly opt: ResolvedBreakoutOptions;
  private readonly shortOverrides: Partial<ResolvedBreakoutOptions> | null;
  private readonly regimeOptions?: RegimeDetectorOptions;

  constructor(opts: BreakoutVolOptions = {}) {
    // TRA-261 — long overrides fold into the base resolved options so the
    // long-side numbers stay byte-identical to the TRA-207 spec. Short-side
    // overrides are stashed and applied lazily once a short fires; this keeps
    // the long path a straight read and rules out per-tick conditional drift
    // for callers reading `opt`.
    const longOverrides = opts.paramsByDirection?.long ?? {};
    const baseOpts = { ...opts, ...longOverrides };
    this.opt = {
      consolidationBars: baseOpts.consolidationBars ?? BREAKOUT_DEFAULTS.consolidationBars,
      maxRangeFraction: baseOpts.maxRangeFraction ?? BREAKOUT_DEFAULTS.maxRangeFraction,
      volumeMultiplier: baseOpts.volumeMultiplier ?? BREAKOUT_DEFAULTS.volumeMultiplier,
      atrPeriod: baseOpts.atrPeriod ?? BREAKOUT_DEFAULTS.atrPeriod,
      atrStopMultiplier: baseOpts.atrStopMultiplier ?? BREAKOUT_DEFAULTS.atrStopMultiplier,
      atrTpMultiplier: baseOpts.atrTpMultiplier ?? BREAKOUT_DEFAULTS.atrTpMultiplier,
    };
    const shortOverridesRaw = opts.paramsByDirection?.short;
    this.shortOverrides = shortOverridesRaw
      ? this.resolveDirectionalOverrides(shortOverridesRaw)
      : null;
    this.regimeOptions = opts.regimeOptions;
  }

  /**
   * Fold a per-side override partial into a `Partial<ResolvedBreakoutOptions>`
   * so the caller can splat it onto the base options at fire time.
   */
  private resolveDirectionalOverrides(
    raw: Partial<Omit<BreakoutVolOptions, 'paramsByDirection' | 'regimeOptions'>>,
  ): Partial<ResolvedBreakoutOptions> {
    const out: Partial<ResolvedBreakoutOptions> = {};
    if (raw.consolidationBars !== undefined) out.consolidationBars = raw.consolidationBars;
    if (raw.maxRangeFraction !== undefined) out.maxRangeFraction = raw.maxRangeFraction;
    if (raw.volumeMultiplier !== undefined) out.volumeMultiplier = raw.volumeMultiplier;
    if (raw.atrPeriod !== undefined) out.atrPeriod = raw.atrPeriod;
    if (raw.atrStopMultiplier !== undefined) out.atrStopMultiplier = raw.atrStopMultiplier;
    if (raw.atrTpMultiplier !== undefined) out.atrTpMultiplier = raw.atrTpMultiplier;
    return out;
  }

  /**
   * Resolve the active option set for `side`. Long-side returns the base
   * options unchanged (long path is byte-identical to pre-TRA-261). Short-side
   * overlays the configured short overrides.
   */
  private optFor(side: 'buy' | 'sell'): ResolvedBreakoutOptions {
    if (side === 'buy' || !this.shortOverrides) return this.opt;
    return { ...this.opt, ...this.shortOverrides };
  }

  evaluate(symbol: string, candles: Candle[], regime?: Regime): TradeSignal | null {
    const minBars = Math.max(
      // Need the consolidation window prior to the entry bar, plus the entry bar itself.
      this.opt.consolidationBars + 1,
      this.opt.atrPeriod + 1,
      // classifyRegime walks a 50-bar EMA, so the auto-classify path needs ≥50 bars.
      50,
    );
    if (candles.length < minBars) return null;

    const effectiveRegime = regime ?? classifyRegime(candles, this.regimeOptions ?? {});
    // Spec §4: high_vol is the canonical home; flat is allowed for the
    // flat → high_vol transition bar. trend_up/trend_down/range are owned by
    // momentum / mean-rev and would dilute this strategy's edge.
    if (effectiveRegime !== 'high_vol' && effectiveRegime !== 'flat') return null;

    const latest = candles[candles.length - 1];
    // Use the long-side window/range gates for the channel scan — the short
    // overrides only affect post-fire risk knobs (stop/TP/volume mult). We
    // detect the side first using the long-baseline channel, then resolve
    // the directional opt to apply ATR/volume/TP knobs.
    const windowStart = candles.length - 1 - this.opt.consolidationBars;
    const window = candles.slice(windowStart, candles.length - 1);

    let consolidationHigh = -Infinity;
    let consolidationLow = Infinity;
    let volumeSum = 0;
    for (const c of window) {
      if (c.high > consolidationHigh) consolidationHigh = c.high;
      if (c.low < consolidationLow) consolidationLow = c.low;
      volumeSum += c.volume;
    }
    if (!Number.isFinite(consolidationHigh) || !Number.isFinite(consolidationLow)) return null;

    const close = latest.close;
    if (close <= 0) return null;

    // Consolidation tightness gate. A wide "range" isn't actually a coil —
    // it's mid-trend noise, and the breakout edge degrades sharply.
    const rangeFraction = (consolidationHigh - consolidationLow) / close;
    if (!Number.isFinite(rangeFraction) || rangeFraction >= this.opt.maxRangeFraction) return null;

    const breakoutLong = close > consolidationHigh;
    const breakoutShort = close < consolidationLow;
    if (!breakoutLong && !breakoutShort) return null;

    const side: 'buy' | 'sell' = breakoutLong ? 'buy' : 'sell';
    // TRA-261 — once we know the side, resolve the directional option set
    // so short-side overrides (TRA-255 §4: tighter stop ATR mult, volume
    // confirmation bump) flow through the rest of the function.
    const opt = this.optFor(side);

    const volumeSma = volumeSum / window.length;
    // Zero-volume windows can come from sparse/missing data — refuse rather
    // than dividing through and emitting a phantom signal.
    if (!(volumeSma > 0)) return null;
    const volumeOk = latest.volume >= opt.volumeMultiplier * volumeSma;
    if (!volumeOk) return null;

    const atrValue = atr(candles, opt.atrPeriod);
    if (atrValue === null || atrValue <= 0) return null;

    const stopDistance = opt.atrStopMultiplier * atrValue;
    const tpDistance = opt.atrTpMultiplier * atrValue;
    if (stopDistance <= 0 || tpDistance <= 0) return null;
    const stopLoss = side === 'buy' ? close - stopDistance : close + stopDistance;
    const takeProfit = side === 'buy' ? close + tpDistance : close - tpDistance;

    return {
      id: randomUUID(),
      symbol,
      type: 'breakout_vol',
      side,
      entryPrice: close,
      stopLoss,
      takeProfit,
      riskRewardRatio: tpDistance / stopDistance,
      timestamp: latest.timestamp,
    };
  }
}
