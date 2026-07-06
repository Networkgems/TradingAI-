import { Candle, TradeSignal } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { atr } from '../indicators/atr.js';
import { rsi } from '../indicators/rsi.js';
import type { Regime } from '../regime.js';

/**
 * TRA-284 / TRA-255 §4.4 v2 — BTC RSI-extreme bracket short trigger.
 *
 * Activated by `MomentumStrategy` when the short side resolves on 4H bars
 * AND the symbol is listed in `paramsByDirection.short.lowCascadeDensitySymbols`
 * (BTC-USD by default, per spec §4.4 v2). Replaces the cascade-leg trigger
 * for those symbols with a smoother grind-into-overbought + bearish-rejection
 * bracket: BTC's 4H Coinbase distribution is structurally distinct from the
 * cascade-flush profile that fits the alts (ETH / SOL / XRP / DOGE), so the
 * cascade-leg trigger fires 0/9 windows on BTC across r6 and r7 retunes
 * (TRA-261 sweep evidence). The bracket is the v2 baseline because the
 * inputs (RSI + bar shape) are already in the OHLCV path — no new data feed
 * required, no liquidations stream blocker.
 *
 * Routing is exclusive on `symbol`: a symbol matched by
 * `lowCascadeDensitySymbols` evaluates the bracket; any other symbol on the
 * same router still evaluates the cascade-leg trigger. Both can never fire
 * on the same bar. Long-side and non-4H short paths are byte-unchanged.
 *
 * Risk knobs (`atrStopMultiplier`, `atrTpMultiplier`, `rearmBars`,
 * `atrPeriod`) are resolved by the caller from the §4.1 short stack and
 * passed in unchanged — the bracket is an entry-rule rewrite, not a
 * risk-control rewrite.
 */
export interface BtcRsiBracketOverride {
  /** RSI period — default 14 per spec §4.4 v2. */
  rsiPeriod?: number;
  /** RSI overbought threshold — default 70 per spec §4.4 v2. */
  rsiOverboughtThreshold?: number;
  /**
   * Recent-high anchor lookback — default 20 per spec. The bracket bar's own
   * high is excluded from the anchor max so a strong-grind bar that prints a
   * fresh local peak doesn't reflexively satisfy the gate against itself.
   */
  recentHighLookback?: number;
  /** Recent-high anchor ratio — default 0.98 per spec §4.4 v2. */
  recentHighAnchorRatio?: number;
  /**
   * Bearish-rejection close-in-lower-range fraction — default 0.50 per spec
   * §4.4 v2. The §4.4 r6/r7 cascade-leg trigger uses 0.33 (lower-third) for
   * the cascade flush; the bracket softens to lower-half because BTC's
   * mean-reversion bars don't print the same flush close compression.
   */
  bearishRejectionRangeRatio?: number;
}

/** Resolved (defaults filled) version of {@link BtcRsiBracketOverride}. */
export interface ResolvedBtcRsiBracket {
  rsiPeriod: number;
  rsiOverboughtThreshold: number;
  recentHighLookback: number;
  recentHighAnchorRatio: number;
  bearishRejectionRangeRatio: number;
}

/** TRA-255 §4.4 v2 baseline numeric primitives. */
export const BTC_RSI_BRACKET_DEFAULTS: ResolvedBtcRsiBracket = {
  rsiPeriod: 14,
  rsiOverboughtThreshold: 70,
  recentHighLookback: 20,
  recentHighAnchorRatio: 0.98,
  bearishRejectionRangeRatio: 0.50,
};

/** Fold an override partial onto the spec defaults. */
export function resolveBtcRsiBracket(
  raw: BtcRsiBracketOverride | undefined,
): ResolvedBtcRsiBracket {
  if (!raw) return { ...BTC_RSI_BRACKET_DEFAULTS };
  return {
    rsiPeriod: raw.rsiPeriod ?? BTC_RSI_BRACKET_DEFAULTS.rsiPeriod,
    rsiOverboughtThreshold:
      raw.rsiOverboughtThreshold ?? BTC_RSI_BRACKET_DEFAULTS.rsiOverboughtThreshold,
    recentHighLookback:
      raw.recentHighLookback ?? BTC_RSI_BRACKET_DEFAULTS.recentHighLookback,
    recentHighAnchorRatio:
      raw.recentHighAnchorRatio ?? BTC_RSI_BRACKET_DEFAULTS.recentHighAnchorRatio,
    bearishRejectionRangeRatio:
      raw.bearishRejectionRangeRatio
      ?? BTC_RSI_BRACKET_DEFAULTS.bearishRejectionRangeRatio,
  };
}

/**
 * Inputs required to evaluate the bracket on the latest bar. The caller
 * (MomentumStrategy) supplies the regime label, resolved bracket params, the
 * §4.1 risk knobs, and its own `lastFireTs` for the rearm-cooldown bookkeeping.
 */
export interface BtcRsiBracketEvalArgs {
  symbol: string;
  candles: Candle[];
  regime: Regime;
  bracket: ResolvedBtcRsiBracket;
  atrPeriod: number;
  atrStopMultiplier: number;
  atrTpMultiplier: number;
  rearmBars: number;
  /**
   * Most recent fire timestamp from the caller's strategy state, used to
   * suppress repeat fires inside the §4.1 short rearm window. `null` when
   * the caller has not fired yet.
   */
  lastFireTs: number | null;
}

/**
 * TRA-255 §4.4 v2 — try the BTC RSI-extreme bracket on the latest bar.
 * Returns a TradeSignal on a clean fire, `null` when any of the four §4.4 v2
 * rules fails. Caller is responsible for stamping `lastFireTs` from the
 * returned signal's timestamp.
 *
 * Rules:
 *
 *   1. RSI extreme: `RSI(period)[i] ≥ rsiOverboughtThreshold` (default
 *      14 / 70). Wilder's RSI on close prices, current bar's close included.
 *
 *   2. Recent-high proximity: `high[i] ≥ recentHighAnchorRatio × max(high)`
 *      over the prior `recentHighLookback` bars (current bar excluded).
 *      Default `0.98 × max(high, 20)` per spec.
 *
 *   3. Bearish-rejection candle: `close[i] < open[i]` AND `close[i] ≤
 *      low[i] + bearishRejectionRangeRatio × (high[i] - low[i])`. Default
 *      lower-half (`0.50`) per spec — softer than the cascade-leg lower-33%
 *      compression because BTC's mean-reversion bars don't print the same
 *      flush close.
 *
 *   4. Daily-regime gate: `regime !== 'trend_up'`. Byte-identical to the
 *      cascade-leg trigger's softened gate; explicitly accepts `range`,
 *      `high_vol`, `flat`, `trend_down`. Long-side regime gate unchanged.
 *
 * No volume requirement (BTC's smoother distribution is not gated by
 * relative-volume the way the alt cascade flush is). No EMA200 / slope. No
 * drop-bar magnitude — this is a mean-reversion bracket, not a cascade
 * detector.
 */
export function tryBtcRsiBracketShort(args: BtcRsiBracketEvalArgs): TradeSignal | null {
  const {
    symbol, candles, regime, bracket,
    atrPeriod, atrStopMultiplier, atrTpMultiplier, rearmBars, lastFireTs,
  } = args;

  // Rule 4 — softened daily-regime gate (matches cascade-leg trigger).
  if (regime === 'trend_up') return null;

  const minBars = Math.max(
    atrPeriod + 1,
    bracket.rsiPeriod + 1,
    bracket.recentHighLookback + 1,
  );
  if (candles.length < minBars) return null;

  const latest = candles[candles.length - 1];

  // Rule 1 — RSI extreme.
  const closes = candles.map((c) => c.close);
  const rsiValue = rsi(closes, bracket.rsiPeriod);
  if (!Number.isFinite(rsiValue)) return null;
  if (rsiValue < bracket.rsiOverboughtThreshold) return null;

  // Rule 2 — recent-high anchor (current bar excluded so the bracket bar's
  // own high doesn't bias the max).
  const rhStart = candles.length - 1 - bracket.recentHighLookback;
  if (rhStart < 0) return null;
  let recentHigh = -Infinity;
  for (let i = rhStart; i < candles.length - 1; i++) {
    if (candles[i].high > recentHigh) recentHigh = candles[i].high;
  }
  if (!Number.isFinite(recentHigh) || recentHigh <= 0) return null;
  if (latest.high < bracket.recentHighAnchorRatio * recentHigh) return null;

  // Rule 3 — bearish-rejection candle (close in lower half of the bar's range).
  if (latest.close >= latest.open) return null;
  const range = latest.high - latest.low;
  if (range <= 0) return null;
  const closeFromLow = (latest.close - latest.low) / range;
  if (closeFromLow > bracket.bearishRejectionRangeRatio) return null;

  // Rearm cooldown — same `rearmBars` value as the §4.1 short stack; the
  // bracket re-uses it so a single-bar bracket fire cannot retrigger on the
  // immediately-next 4H bar (= 32h spacing under default rearm of 8 bars).
  if (lastFireTs !== null && candles.length >= 2) {
    const barInterval = latest.timestamp - candles[candles.length - 2].timestamp;
    if (barInterval > 0 && latest.timestamp - lastFireTs < rearmBars * barInterval) {
      return null;
    }
  }

  // Risk: §4.1 short values byte-unchanged (atrStopMultiplier 2.0,
  // atrTpMultiplier 4.0). Bracket is an entry-rule rewrite only.
  const atrValue = atr(candles, atrPeriod);
  if (atrValue === null || atrValue <= 0) return null;
  const stopDistance = atrStopMultiplier * atrValue;
  const tpDistance = atrTpMultiplier * atrValue;
  if (stopDistance <= 0 || tpDistance <= 0) return null;

  const entryPrice = latest.close;
  return {
    id: randomUUID(),
    symbol,
    type: 'momentum',
    side: 'sell',
    entryPrice,
    stopLoss: entryPrice + stopDistance,
    takeProfit: entryPrice - tpDistance,
    riskRewardRatio: tpDistance / stopDistance,
    timestamp: latest.timestamp,
    // TRA-1325 — trigger-family diagnostic tag (§4.4 v2 RSI-extreme bracket).
    trigger: 'rsi-bracket',
  };
}
