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
   * TRA-261 / TRA-255 §4.1 — slope-of-slow-EMA gate. When set, the slow EMA
   * must move in the trade's favour over the last `slowMaSlopeBars` bars
   * (negative for shorts, positive for longs); otherwise the candidate is
   * suppressed even if every other gate passes. Defaults to `undefined` so
   * the long path is byte-identical to pre-TRA-261; the short override sets
   * `10` for the spec's "EMA200 slope negative over last 10 bars" rule. The
   * slope is computed as a raw level delta, not a percentage — for the
   * spec rule we only care about the sign.
   */
  slowMaSlopeBars?: number;
  /**
   * TRA-261 / TRA-255 §4.1 — breakout-bar volume confirmation. When set,
   * current-bar volume must be ≥ `volumeMultiplier × SMA(volume, volumeSmaPeriod)`.
   * Defaults to `undefined` so the long path stays byte-identical; the short
   * override sets `1.25` to mirror the spec's "≥ 1.25 × SMA(volume, 20)".
   */
  volumeMultiplier?: number;
  /**
   * Window for the volume SMA used by the volume-confirmation gate. Default
   * `20` so a short override that only sets `volumeMultiplier` picks up the
   * spec's "SMA(volume, 20)" baseline without restating it.
   */
  volumeSmaPeriod?: number;
  /**
   * Lot-size for ATR-based sizing. Forwarded to `RiskManager.sizeFromAtr`;
   * crypto callers typically use 1e-6 (Coinbase BTC) so a $500 risk budget
   * over a $1k stop sizes to 0.5 BTC instead of being floored to 0.
   */
  lotSize?: number;
  /**
   * TRA-261 — per-side parameter overrides. Long-side fields stay byte-
   * identical to the TRA-200 spec values; short-side fields layer on top of
   * the resolved options ONLY when emitting a short. Used by the crypto
   * perp shorts spec (TRA-255 §4) so short entries pull tighter stops, a
   * faster trailing cadence, and a volume-confirmation bump without
   * conditional drift in the long path. Omit either field to keep that
   * direction's values at the long-side baseline.
   *
   * TRA-275 / TRA-255 §4.4 r6 — `short.byTimeframe['4h']` activates the
   * cascade-leg trigger (Layer 3 structural rewrite) when the strategy is
   * evaluated against 4H bars and would emit a short. The cascade trigger
   * replaces the §4.1 EMA-cross / slope / Donchian / volume stack with a
   * bespoke drop-bar + volume + recent-high-anchor + softened-regime gate
   * stack designed for the cascade flush. Long-side and non-4H short paths
   * remain byte-identical to pre-r6.
   */
  paramsByDirection?: {
    long?: Partial<Omit<MomentumOptions, 'paramsByDirection'>>;
    short?: Partial<Omit<MomentumOptions, 'paramsByDirection' | 'byTimeframe'>> & {
      byTimeframe?: MomentumByTimeframeOverrides;
    };
  };
}

/**
 * TRA-255 §4.4 r6 — per-timeframe short overrides. Today only the 4H entry
 * exists (Phase-1.1 Layer 3); the type is keyed on the interval string so a
 * future 1H or 30m extension drops in without a structural change.
 */
export interface MomentumByTimeframeOverrides {
  '4h'?: MomentumCascadeLegOverride;
}

/**
 * TRA-255 §4.4 r6 — Layer 3 cascade-leg short trigger config. When enabled
 * and the bars passed to {@link MomentumStrategy.evaluate} are 4H, the §4.1
 * entry trigger (EMA cross + EMA200 slope + Donchian breakdown + 1.10×
 * volume) is replaced by the cascade-leg trigger:
 *
 *   1. Drop-bar:        (open − close) ≥ {@link dropBarAtrMultiplier} × ATR(14)
 *                       (default 1.25 under §4.4 r7 — was 1.5 under r6)
 *                       AND close ≤ low + {@link dropBarRangeRatio} × (high − low)
 *   2. Volume:          volume ≥ {@link cascadeVolumeMultiplier} × SMA(volume, 20)
 *                       (default 1.75 under §4.4 r7 — was 1.5 under r6)
 *   3. Recent-high:     high ≥ {@link recentHighAnchorRatio}
 *                       × max(high) over the prior {@link recentHighLookback} bars
 *                       (default 0.97 under §4.4 r7 — was 0.95 under r6)
 *                       (current bar included so a clean cascade off the local
 *                       high still anchors).
 *   4. Daily-regime:    regime label `!== 'trend_up'`. Softer than the §4.1
 *                       `=== 'trend_down'` bar — explicitly accepts `range`,
 *                       `high_vol`, `flat`, `trend_down` so the cascade trigger
 *                       fires inside choppier regimes that historically host
 *                       liquidation cascades. The router supplies whatever
 *                       regime label the caller computed for these bars; for
 *                       the macro-overlay split (4H entries gated by the daily
 *                       regime) the harness/engine is responsible for feeding
 *                       in the daily label rather than the 4H one.
 *
 * Stop / TP / trail / time-stop / re-arm: all §4.1 short values (resolved on
 * the same `ResolvedOptions` object) are unchanged — `atrStopMultiplier 2.0`,
 * `atrTpMultiplier 4.0`, time stop 20 bars (= 80h on 4H), trail
 * `Donchian_high(10)`, `rearmBars 8`. The cascade trigger is an *entry-rule*
 * rewrite, not a risk-control rewrite.
 */
export interface MomentumCascadeLegOverride {
  /** Drop-bar ATR multiplier (default 1.25 per §4.4 r7 — was 1.5 in r6). */
  dropBarAtrMultiplier?: number;
  /** Drop-bar close-in-lower-range fraction (default 0.33 per spec). */
  dropBarRangeRatio?: number;
  /** Volume multiplier vs SMA(volume, 20) (default 1.75 per §4.4 r7 — was 1.5 in r6). */
  cascadeVolumeMultiplier?: number;
  /** Recent-high lookback in bars (default 20 per spec). */
  recentHighLookback?: number;
  /** Recent-high anchor ratio (default 0.97 per §4.4 r7 — was 0.95 in r6). */
  recentHighAnchorRatio?: number;
}

interface ResolvedOptions {
  fastMaPeriod: number;
  slowMaPeriod: number;
  donchianPeriod: number;
  atrPeriod: number;
  atrStopMultiplier: number;
  atrTpMultiplier: number;
  rearmBars: number;
  /**
   * Slope-of-slow-MA gate window. `undefined` = gate disabled (long-side
   * default); positive integer = require the slow EMA to move in the trade's
   * favour over that many bars. Resolved per-side so a short override of
   * `10` doesn't reach into the long path.
   */
  slowMaSlopeBars: number | undefined;
  /**
   * Volume-confirmation multiplier on the breakout bar. `undefined` = gate
   * disabled (long-side default).
   */
  volumeMultiplier: number | undefined;
  /** Window for the SMA(volume) used by the volume gate. */
  volumeSmaPeriod: number;
  lotSize: number | undefined;
  /**
   * TRA-275 / TRA-255 §4.4 r6 — resolved cascade-leg config for 4H short.
   * `undefined` = cascade trigger disabled (the §4.1 EMA-cross / Donchian
   * stack is authoritative). Defined ⇒ when this side resolves to short AND
   * the bar interval is detected as 4H, the §4.1 trigger is replaced by the
   * cascade-leg trigger described on {@link MomentumCascadeLegOverride}.
   */
  cascadeLeg4h: ResolvedCascadeLeg | undefined;
}

interface ResolvedCascadeLeg {
  dropBarAtrMultiplier: number;
  dropBarRangeRatio: number;
  cascadeVolumeMultiplier: number;
  recentHighLookback: number;
  recentHighAnchorRatio: number;
}

// TRA-278 / TRA-255 §4.4 r7 — three-knob retune of the §4.4 r6 branch menu.
// Drop-bar 1.5 → 1.25× ATR (r6 BTC fired 0/9 windows; relaxing the magnitude
// gate is the only density-additive knob in the r6 branch menu). Recent-high
// anchor 0.95 → 0.97 (tighten so the magnitude relaxation doesn't drag
// late-trend long-tail down-grind bars in alongside genuine cascade flushes).
// Volume 1.5 → 1.75 (compensate the relaxed magnitude bar by requiring a
// heavier confirmation pulse). Drop-bar close-in-lower-33% gate, lookback,
// and §4.1 stop / TP / trail / time-stop / re-arm stay byte-unchanged from r6.
const CASCADE_LEG_DEFAULTS: ResolvedCascadeLeg = {
  dropBarAtrMultiplier: 1.25,
  dropBarRangeRatio: 0.33,
  cascadeVolumeMultiplier: 1.75,
  recentHighLookback: 20,
  recentHighAnchorRatio: 0.97,
};

/** Tolerance window (ms) around a 4H bar interval — covers Coinbase exchange
 * jitter (typically <1s) and the very rare clock-skew artifacts. Wider than
 * needed but still tight enough to reject 1H bars (3.6e6) and 1D bars (8.64e7).
 */
const FOUR_HOUR_INTERVAL_MIN_MS = 3.5 * 60 * 60 * 1000;
const FOUR_HOUR_INTERVAL_MAX_MS = 4.5 * 60 * 60 * 1000;

const DEFAULTS: Omit<ResolvedOptions, 'rearmBars'> = {
  fastMaPeriod: 50,
  slowMaPeriod: 200,
  donchianPeriod: 20,
  atrPeriod: 14,
  atrStopMultiplier: 2,
  atrTpMultiplier: 4,
  slowMaSlopeBars: undefined,
  volumeMultiplier: undefined,
  // 20-bar SMA(volume) baseline matches BreakoutVolStrategy and the TRA-255
  // §4.1 spec wording ("SMA(volume, 20)"). Only consulted when
  // `volumeMultiplier` is set.
  volumeSmaPeriod: 20,
  lotSize: undefined,
  cascadeLeg4h: undefined,
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
  private readonly shortOverrides: Partial<ResolvedOptions> | null;
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
    // TRA-261 — long overrides fold into the base resolved options so the
    // long-side numbers stay byte-identical to the TRA-200 spec. Short-side
    // overrides are stashed and applied lazily when a short fires; this
    // keeps the long path one fewer branch and rules out per-tick conditional
    // drift for downstream callers reading `opt`.
    const longOverrides = opts.paramsByDirection?.long ?? {};
    const baseOpts: Omit<MomentumOptions, 'paramsByDirection'> = { ...opts, ...longOverrides };
    delete (baseOpts as { paramsByDirection?: unknown }).paramsByDirection;
    const donchianPeriod = baseOpts.donchianPeriod ?? DEFAULTS.donchianPeriod;
    this.opt = {
      ...DEFAULTS,
      ...baseOpts,
      // Default rearm = donchianPeriod so a steady trend produces ~one signal
      // per Donchian-window worth of bars, not one per bar.
      rearmBars: baseOpts.rearmBars ?? donchianPeriod,
      donchianPeriod,
    };
    const shortOverridesRaw = opts.paramsByDirection?.short;
    this.shortOverrides = shortOverridesRaw
      ? this.resolveDirectionalOverrides(shortOverridesRaw)
      : null;
  }

  /**
   * Fold a per-side override partial onto the resolved base options so the
   * caller can read `optFor(side)` and get a fully-typed `ResolvedOptions`
   * without re-doing the `??` defaults dance. `rearmBars` falls back to the
   * override's `donchianPeriod` first (matching the constructor's behaviour)
   * so a short override of `{ donchianPeriod: 10 }` produces a 10-bar rearm,
   * not the long-side rearm.
   */
  private resolveDirectionalOverrides(
    raw: Partial<Omit<MomentumOptions, 'paramsByDirection'>> & {
      byTimeframe?: MomentumByTimeframeOverrides;
    },
  ): Partial<ResolvedOptions> {
    const { byTimeframe, ...flat } = raw;
    const out: Partial<ResolvedOptions> = { ...flat };
    if (raw.donchianPeriod !== undefined && raw.rearmBars === undefined) {
      out.rearmBars = raw.donchianPeriod;
    }
    const cascade4h = byTimeframe?.['4h'];
    if (cascade4h !== undefined) {
      out.cascadeLeg4h = {
        dropBarAtrMultiplier: cascade4h.dropBarAtrMultiplier ?? CASCADE_LEG_DEFAULTS.dropBarAtrMultiplier,
        dropBarRangeRatio: cascade4h.dropBarRangeRatio ?? CASCADE_LEG_DEFAULTS.dropBarRangeRatio,
        cascadeVolumeMultiplier: cascade4h.cascadeVolumeMultiplier ?? CASCADE_LEG_DEFAULTS.cascadeVolumeMultiplier,
        recentHighLookback: cascade4h.recentHighLookback ?? CASCADE_LEG_DEFAULTS.recentHighLookback,
        recentHighAnchorRatio: cascade4h.recentHighAnchorRatio ?? CASCADE_LEG_DEFAULTS.recentHighAnchorRatio,
      };
    }
    return out;
  }

  /**
   * Resolve the active option set for `side`. Long-side returns the base
   * options unchanged (long path is byte-identical to pre-TRA-261). Short-
   * side overlays the configured short overrides. Used internally during
   * `evaluate` once the side has been decided.
   */
  private optFor(side: Side): ResolvedOptions {
    if (side === 'buy' || !this.shortOverrides) return this.opt;
    return { ...this.opt, ...this.shortOverrides };
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

    // TRA-275 / TRA-255 §4.4 r6 — cascade-leg short trigger replaces §4.1 on 4H.
    // Resolved short overrides + 4H bar interval activates the cascade trigger
    // (which has its own softer regime gate); fired here BEFORE the strict
    // §4.1 regime gate so a `range` / `high_vol` / `flat` 4H tape can still
    // surface a cascade short. Long-side and non-4H short paths fall through
    // to the unchanged §4.1 stack below.
    const cascadeShortActive =
      this.shortOverrides !== null
      && (this.shortOverrides as Partial<ResolvedOptions>).cascadeLeg4h !== undefined
      && this.isFourHourBars(candles);
    if (cascadeShortActive) {
      const cascadeSig = this.tryCascadeShort(symbol, candles, effectiveRegime);
      if (cascadeSig) return cascadeSig;
      // Cascade didn't fire. Fall through so a 4H *long* signal can still
      // come from the §4.1 path; a 4H short from §4.1 is explicitly replaced
      // by the cascade trigger and is suppressed below.
    }

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

    // TRA-275 / TRA-255 §4.4 r6 — when the cascade trigger is the active 4H
    // short path, the §4.1 short stack is *replaced*, not stacked. A trend_down
    // 4H bar that would have fired §4.1 short here is suppressed; the only
    // 4H short path is the cascade trigger that ran above. Long-side path
    // proceeds unchanged.
    if (cascadeShortActive && side === 'sell') return null;

    // TRA-261 — once we know the side, resolve the active option set so
    // short-side overrides (TRA-255 §4) flow through the rest of the
    // function. Long-side reads identical to pre-TRA-261 because shortOverrides
    // is null in that branch.
    const opt = this.optFor(side);

    // TRA-261 / TRA-255 §4.1 — slow-MA slope gate. The spec requires the
    // EMA(200) to slope against the trend (negative for shorts) over the
    // last `slowMaSlopeBars` bars before we're willing to fire. Long-side
    // leaves `slowMaSlopeBars` undefined → gate is a no-op, preserving
    // byte-identical long behaviour. We compare the latest slow EMA to the
    // value `slowMaSlopeBars` bars ago using level deltas — the spec only
    // cares about the sign, so a percentage normalization would just add
    // numerical noise without changing decisions.
    if (opt.slowMaSlopeBars !== undefined && opt.slowMaSlopeBars > 0) {
      const idx = slowSeries.length - 1 - opt.slowMaSlopeBars;
      if (idx < 0) return null;
      const slowThen = slowSeries[idx];
      if (!Number.isFinite(slowThen)) return null;
      const slope = slowNow - slowThen;
      if (side === 'sell' && slope >= 0) return null;
      if (side === 'buy' && slope <= 0) return null;
    }

    // Donchian breakout — channel is computed from the prior N bars (current
    // bar excluded) so a close *beyond* the channel is unambiguously a breakout.
    const ch = donchian(candles, opt.donchianPeriod, true);
    if (!ch) return null;

    const latest = candles[candles.length - 1];

    const breakoutLong = side === 'buy' && latest.close > ch.upper;
    const breakoutShort = side === 'sell' && latest.close < ch.lower;
    if (!breakoutLong && !breakoutShort) return null;

    // TRA-261 / TRA-255 §4.1 — breakout-bar volume confirmation. Long-side
    // leaves `volumeMultiplier` undefined → gate is a no-op. Shorts require
    // the entry bar's volume to be ≥ `volumeMultiplier × SMA(volume, N)`.
    // Mirrors BreakoutVolStrategy's volume guard, with the gating constant
    // (1.25× by spec) tuned looser since Momentum already has the regime +
    // EMA-cross + breakout filters in front of it.
    if (opt.volumeMultiplier !== undefined && opt.volumeMultiplier > 0) {
      const window = opt.volumeSmaPeriod;
      if (candles.length < window + 1) return null;
      const baselineStart = candles.length - 1 - window;
      let volumeSum = 0;
      for (let i = baselineStart; i < candles.length - 1; i++) volumeSum += candles[i].volume;
      const volumeSma = volumeSum / window;
      if (!(volumeSma > 0)) return null;
      if (latest.volume < opt.volumeMultiplier * volumeSma) return null;
    }

    // Cooldown: a sustained trend prints fresh Donchian highs every bar, so
    // without a re-arm window the strategy would emit one signal per bar.
    // Skipping when we last fired within `rearmBars` bars keeps the signal
    // stream sparse without losing the "trend persists" re-entry chance once
    // the cooldown elapses.
    if (this.lastFireTs !== null && candles.length >= 2) {
      const barInterval = latest.timestamp - candles[candles.length - 2].timestamp;
      if (barInterval > 0
        && latest.timestamp - this.lastFireTs < opt.rearmBars * barInterval) {
        return null;
      }
    }

    const atrValue = atr(candles, opt.atrPeriod);
    if (atrValue === null || atrValue <= 0) return null;

    const stopDistance = opt.atrStopMultiplier * atrValue;
    const tpDistance = opt.atrTpMultiplier * atrValue;
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

  /**
   * TRA-275 / TRA-255 §4.4 r6 — cascade-leg short trigger entry path.
   *
   * Activation: caller has wired `paramsByDirection.short.byTimeframe['4h']`
   * AND `evaluate()` detected the bar interval as 4H AND a short would be
   * the candidate side. Replaces the §4.1 EMA-cross / Donchian / volume
   * stack with a structural cascade-leg detector tuned to 4H Phase-1 majors:
   * the cascade flush prints a single bar with a heavy ATR-relative drop,
   * close compressed against the lows, abnormal volume, anchored against a
   * recent local peak. Entry-rule rewrite only; post-fire risk knobs
   * (atrStopMultiplier, atrTpMultiplier, rearmBars, time stop, trail)
   * still come from `optFor('sell')`.
   */
  private tryCascadeShort(symbol: string, candles: Candle[], effectiveRegime: Regime): TradeSignal | null {
    const opt = this.optFor('sell');
    const cascade = opt.cascadeLeg4h;
    if (!cascade) return null;

    // Daily-regime gate (softened from §4.1's strict `=== 'trend_down'`).
    // The router/harness is responsible for feeding in the daily macro
    // overlay regime when the §3 split is active; in standalone use the
    // detector's own label on these bars is the best available proxy.
    if (effectiveRegime === 'trend_up') return null;

    const lookback = Math.max(
      opt.atrPeriod + 1,
      opt.volumeSmaPeriod + 1,
      cascade.recentHighLookback + 1,
    );
    if (candles.length < lookback) return null;

    const latest = candles[candles.length - 1];

    // 1) Drop-bar gate — heavy ATR-relative open-to-close drop with the close
    //    compressed against the lows. Both halves must hold; either alone
    //    catches false positives (a bar that closes mid-range despite a big
    //    drop tends to be a single-bar reversal candidate, not a cascade).
    const atrValue = atr(candles, opt.atrPeriod);
    if (atrValue === null || atrValue <= 0) return null;
    const dropMagnitude = latest.open - latest.close;
    if (dropMagnitude < cascade.dropBarAtrMultiplier * atrValue) return null;
    const range = latest.high - latest.low;
    if (range <= 0) return null;
    const closeFromLow = (latest.close - latest.low) / range;
    if (closeFromLow > cascade.dropBarRangeRatio) return null;

    // 2) Volume gate — current bar's volume vs the 20-bar SMA over the
    //    *prior* bars (current excluded, mirroring §4.1's volume gate
    //    semantics so the SMA isn't biased by the cascade bar's own spike).
    const volStart = candles.length - 1 - opt.volumeSmaPeriod;
    if (volStart < 0) return null;
    let volSum = 0;
    for (let i = volStart; i < candles.length - 1; i++) volSum += candles[i].volume;
    const volSma = volSum / opt.volumeSmaPeriod;
    if (!(volSma > 0)) return null;
    if (latest.volume < cascade.cascadeVolumeMultiplier * volSma) return null;

    // 3) Recent-high anchor — cascade's high must be within the anchor ratio
    //    of the highest high over the prior `recentHighLookback` bars
    //    (current excluded). Without this gate the trigger fires on
    //    long-tail down-grind bars that aren't actually flushing off a peak.
    const rhStart = candles.length - 1 - cascade.recentHighLookback;
    if (rhStart < 0) return null;
    let recentHigh = -Infinity;
    for (let i = rhStart; i < candles.length - 1; i++) {
      if (candles[i].high > recentHigh) recentHigh = candles[i].high;
    }
    if (!Number.isFinite(recentHigh) || recentHigh <= 0) return null;
    if (latest.high < cascade.recentHighAnchorRatio * recentHigh) return null;

    // 4) Cooldown — same `rearmBars` as §4.1 short (8 bars on 4H ≈ 32h).
    if (this.lastFireTs !== null && candles.length >= 2) {
      const barInterval = latest.timestamp - candles[candles.length - 2].timestamp;
      if (barInterval > 0
        && latest.timestamp - this.lastFireTs < opt.rearmBars * barInterval) {
        return null;
      }
    }

    // Risk: §4.1 short values unchanged (atrStopMultiplier 2.0, atrTpMultiplier 4.0).
    const stopDistance = opt.atrStopMultiplier * atrValue;
    const tpDistance = opt.atrTpMultiplier * atrValue;
    if (stopDistance <= 0 || tpDistance <= 0) return null;

    const entryPrice = latest.close;
    const stopLoss = entryPrice + stopDistance;
    const takeProfit = entryPrice - tpDistance;

    this.lastFireTs = latest.timestamp;
    return {
      id: randomUUID(),
      symbol,
      type: 'momentum',
      side: 'sell',
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: tpDistance / stopDistance,
      timestamp: latest.timestamp,
    };
  }

  /**
   * TRA-275 — detect whether the supplied candles look like 4H bars by
   * inspecting the median bar interval over the recent tail. Used to gate
   * the cascade-leg trigger so callers that wire `byTimeframe['4h']` on a
   * router shared across 1m / 1D feeds (e.g. the live engine's per-symbol
   * router that also serves spot 1m signals) only activate cascade on
   * actual 4H bars. Returns false on too-short bar arrays (no signal source
   * exists below the cascade lookback anyway).
   */
  private isFourHourBars(candles: Candle[]): boolean {
    if (candles.length < 3) return false;
    const tailLen = Math.min(5, candles.length - 1);
    const intervals: number[] = [];
    for (let i = candles.length - tailLen; i < candles.length; i++) {
      intervals.push(candles[i].timestamp - candles[i - 1].timestamp);
    }
    if (intervals.length === 0) return false;
    intervals.sort((a, b) => a - b);
    const med = intervals[Math.floor(intervals.length / 2)];
    return med >= FOUR_HOUR_INTERVAL_MIN_MS && med <= FOUR_HOUR_INTERVAL_MAX_MS;
  }

  async evaluateAndOrder(
    symbol: string,
    candles: Candle[],
    riskManager: RiskManager,
    orderClient: AlpacaOrderClient,
  ): Promise<TradeSignal | null> {
    const signal = this.evaluate(symbol, candles);
    if (!signal) return null;

    const opt = this.optFor(signal.side);
    const atrValue = atr(candles, opt.atrPeriod);
    if (atrValue === null) return null;

    const qty = riskManager.sizeFromAtr(
      signal.entryPrice,
      atrValue,
      opt.atrStopMultiplier,
      opt.lotSize,
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
