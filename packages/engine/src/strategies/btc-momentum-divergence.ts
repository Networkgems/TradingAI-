import { Candle, TradeSignal } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { atr } from '../indicators/atr.js';
import { rsi } from '../indicators/rsi.js';
import { emaSeries } from '../indicators/ma.js';

/**
 * TRA-1325 / TRA-255 §4.4 v3 — BTC bearish momentum-divergence short trigger.
 *
 * Spec source of truth: the `v3-spec` document on TRA-288 ("v3 Spec Spike -
 * BTC momentum-divergence trigger family"), board-signed-off via the TRA-288
 * request_confirmation (interaction 9b3ca2fb, accepted by local-board).
 * Implemented byte-for-byte to that doc.
 *
 * Activated by `MomentumStrategy` when the short side resolves on 4H bars AND
 * the symbol is listed in `paramsByDirection.short.momentumDivergenceSymbols`
 * (BTC-USD by default, per spec §4.4 v3). Replaces BOTH the cascade-leg (§4.4
 * r7) and the RSI-extreme bracket (§4.4 v2) triggers for those symbols with a
 * fractal-swing-high bearish-divergence detector. The v3 family exists because
 * both prior families fire 0/9 walk-forward windows on BTC — the recent-high
 * anchor and the daily-regime gate they both read are binding on BTC across
 * the entire sample. v3 releases BOTH gates by design: a divergence at a swing
 * high needs no recent-high anchor (the swing high IS the anchor) and no
 * daily-regime gate (a divergence-driven short is explicitly counter-trend, so
 * the divergence itself carries the regime signal).
 *
 * Zero new feed: RSI(14) and MACD(12,26,9) are OHLCV-only at the 4H bar
 * already loaded via `loadOrFetch4hBars` (TRA-267).
 *
 * Routing is exclusive on `symbol` (see the fall-through order in
 * `MomentumStrategy.evaluate`): a symbol matched by `momentumDivergenceSymbols`
 * evaluates v3; a symbol matched by `lowCascadeDensitySymbols` evaluates v2;
 * anything else evaluates the cascade-leg r7 trigger. The config-time overlap
 * validation in the strategy constructor guarantees the two BTC-specific lists
 * are disjoint, so no bar can route to two trigger families. Long-side and
 * non-4H short paths are byte-unchanged.
 *
 * Risk knobs (`atrStopMultiplier 2.0`, `atrTpMultiplier 4.0`, `rearmBars 8`,
 * `atrPeriod 14`) are inherited byte-unchanged from the §4.1 r7 cascade-leg
 * stack and passed in by the caller — v3 is an entry-rule addition, not a
 * risk-control rewrite. Trailing `Donchian_high(10)` and the 20-bar time stop
 * are lifecycle/runner concerns, identical to the cascade-leg and bracket
 * triggers, and are not encoded on the emitted signal.
 */
export interface BtcMomentumDivergenceOverride {
  /**
   * Fractal swing-high half-window `n` — default 3 per spec §4.4 v3. A
   * confirmed swing high at bar `k` requires `high[k] > max(high[k-n..k-1])`
   * AND `high[k] > max(high[k+1..k+n])` (a `2n+1`-bar pattern). n=3 is the
   * standard TA middle ground on the 4H horizon; a future numeric retune can
   * revisit `n` if density misses (spec §4.4 v3 "Why 3-bar fractal").
   */
  swingLookback?: number;
  /**
   * Minimum pair-window separation in 4H bars between the current swing high
   * `i` and the prior swing high `s` — default 6 (= 24h) per spec §4.4 v3.
   * Keeps the divergence comparison out of micro-pivot territory.
   */
  pairWindowMinBars?: number;
  /**
   * Maximum pair-window separation in 4H bars — default 30 (= 5 days) per
   * spec §4.4 v3. Keeps the divergence structurally relevant on the 4H
   * horizon.
   */
  pairWindowMaxBars?: number;
  /** RSI period — default 14 per spec §4.4 v3. */
  rsiPeriod?: number;
  /** MACD fast EMA period — default 12 per spec §4.4 v3 (`MACD_line = EMA(12) - EMA(26)`). */
  macdFastPeriod?: number;
  /** MACD slow EMA period — default 26 per spec §4.4 v3. */
  macdSlowPeriod?: number;
}

/** Resolved (defaults filled) version of {@link BtcMomentumDivergenceOverride}. */
export interface ResolvedBtcMomentumDivergence {
  swingLookback: number;
  pairWindowMinBars: number;
  pairWindowMaxBars: number;
  rsiPeriod: number;
  macdFastPeriod: number;
  macdSlowPeriod: number;
}

/** TRA-255 §4.4 v3 baseline numeric primitives. */
export const BTC_MOMENTUM_DIVERGENCE_DEFAULTS: ResolvedBtcMomentumDivergence = {
  swingLookback: 3,
  pairWindowMinBars: 6,
  pairWindowMaxBars: 30,
  rsiPeriod: 14,
  macdFastPeriod: 12,
  macdSlowPeriod: 26,
};

/** Fold an override partial onto the spec defaults. */
export function resolveBtcMomentumDivergence(
  raw: BtcMomentumDivergenceOverride | undefined,
): ResolvedBtcMomentumDivergence {
  if (!raw) return { ...BTC_MOMENTUM_DIVERGENCE_DEFAULTS };
  return {
    swingLookback: raw.swingLookback ?? BTC_MOMENTUM_DIVERGENCE_DEFAULTS.swingLookback,
    pairWindowMinBars:
      raw.pairWindowMinBars ?? BTC_MOMENTUM_DIVERGENCE_DEFAULTS.pairWindowMinBars,
    pairWindowMaxBars:
      raw.pairWindowMaxBars ?? BTC_MOMENTUM_DIVERGENCE_DEFAULTS.pairWindowMaxBars,
    rsiPeriod: raw.rsiPeriod ?? BTC_MOMENTUM_DIVERGENCE_DEFAULTS.rsiPeriod,
    macdFastPeriod: raw.macdFastPeriod ?? BTC_MOMENTUM_DIVERGENCE_DEFAULTS.macdFastPeriod,
    macdSlowPeriod: raw.macdSlowPeriod ?? BTC_MOMENTUM_DIVERGENCE_DEFAULTS.macdSlowPeriod,
  };
}

/**
 * Inputs required to evaluate the v3 trigger on the latest bar. The caller
 * (`MomentumStrategy`) supplies the resolved v3 params, the §4.1 risk knobs,
 * and its own `lastFireTs` for the rearm-cooldown bookkeeping. The daily
 * regime label is deliberately NOT an input — v3 does not read it (spec §4.4
 * v3 rule 5, the structural release).
 */
export interface BtcMomentumDivergenceEvalArgs {
  symbol: string;
  candles: Candle[];
  divergence: ResolvedBtcMomentumDivergence;
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
 * Confirmed 3-bar (default) fractal swing high at bar index `k`:
 * `high[k] > max(high[k-n..k-1])` AND `high[k] > max(high[k+1..k+n])`. Returns
 * false when the `2n+1`-bar window would run off either end of the array — a
 * swing high is only *confirmed* once the `n` trailing bars have printed, so
 * the caller never treats an unconfirmable index as a swing high.
 */
function isFractalSwingHigh(candles: Candle[], k: number, n: number): boolean {
  if (n <= 0) return false;
  if (k - n < 0 || k + n > candles.length - 1) return false;
  const hk = candles[k].high;
  for (let j = k - n; j < k; j++) {
    if (!(hk > candles[j].high)) return false;
  }
  for (let j = k + 1; j <= k + n; j++) {
    if (!(hk > candles[j].high)) return false;
  }
  return true;
}

/**
 * TRA-255 §4.4 v3 — try the BTC bearish momentum-divergence trigger on the
 * latest bar. Returns a `TradeSignal` (tagged `trigger: 'momentum-divergence'`
 * with the resolved `divergenceFamily`) on a clean fire, `null` otherwise.
 * Caller stamps `lastFireTs` from the returned signal's timestamp.
 *
 * A short fires on 4H bar `t` (the latest candle) when ALL hold (spec §4.4 v3):
 *
 *   1. Confirmed 3-bar fractal swing high at bar `i = t - 3`. The fire bar is
 *      `t = i + 3` (no look-ahead — the 3 trailing bars are what confirm the
 *      swing; a 12h confirmation lag on 4H).
 *   2. Prior confirmed 3-bar fractal swing high at bar `s`, the most recent
 *      strictly before `i`, with pair window `6 <= (i - s) <= 30` 4H bars.
 *   3. Price higher high: `high[i] > high[s]`.
 *   4. Bearish RSI divergence OR bearish MACD divergence (disjunction is the
 *      v3 baseline). RSI form: `RSI(14)[i] < RSI(14)[s]`. MACD form:
 *      `MACD_line[i] < MACD_line[s]` where `MACD_line = EMA(close,12) -
 *      EMA(close,26)`.
 *
 * Daily-regime gate NOT read. Recent-high anchor NOT read. No volume / EMA200
 * / drop-bar / RSI-threshold conditions (spec §4.4 v3 rules 5 / 6 and the
 * "No volume requirement…" paragraph). RSI and MACD are evaluated at the swing
 * bars `i` / `s`; ATR is evaluated at the fire bar `t` per the §4.1 r7 risk
 * inheritance ("ATR computed at the trade fire bar `t`, not at the swing-high
 * bar `i`").
 */
export function tryBtcMomentumDivergenceShort(
  args: BtcMomentumDivergenceEvalArgs,
): TradeSignal | null {
  const {
    symbol, candles, divergence,
    atrPeriod, atrStopMultiplier, atrTpMultiplier, rearmBars, lastFireTs,
  } = args;

  const n = divergence.swingLookback;
  const t = candles.length - 1;
  const i = t - n; // swing-high reference bar; fire bar is i + n = t.

  // Rule 1 — confirmed fractal swing high at bar i. `i + n == t` so the
  // trailing window ends exactly on the latest (fire) bar — no look-ahead.
  if (i < 0) return null;
  if (!isFractalSwingHigh(candles, i, n)) return null;

  // Rule 2 — most recent confirmed fractal swing high `s` strictly before `i`
  // inside the pair window `min <= (i - s) <= max`. Scan from the closest
  // candidate (s = i - min) back to the furthest (s = i - max); the first
  // fractal found is "most recent before i".
  let s = -1;
  const sHi = i - divergence.pairWindowMinBars;
  const sLo = i - divergence.pairWindowMaxBars;
  for (let cand = sHi; cand >= sLo; cand--) {
    if (cand < 0) break;
    if (isFractalSwingHigh(candles, cand, n)) {
      s = cand;
      break;
    }
  }
  if (s < 0) return null;

  // Rule 3 — price made a higher high at i vs the prior swing s.
  if (!(candles[i].high > candles[s].high)) return null;

  // Rule 4 — bearish RSI divergence OR bearish MACD divergence, evaluated at
  // the swing bars. RSI(period) is Wilder's on the close-price prefix ending
  // at each swing bar; MACD_line is EMA(12) - EMA(26) at each swing bar.
  const closes = candles.map((c) => c.close);

  const rsiAtI = rsi(closes.slice(0, i + 1), divergence.rsiPeriod);
  const rsiAtS = rsi(closes.slice(0, s + 1), divergence.rsiPeriod);
  const rsiHolds =
    Number.isFinite(rsiAtI) && Number.isFinite(rsiAtS) && rsiAtI < rsiAtS;

  const fast = emaSeries(closes, divergence.macdFastPeriod);
  const slow = emaSeries(closes, divergence.macdSlowPeriod);
  const macdAtI = fast[i] - slow[i];
  const macdAtS = fast[s] - slow[s];
  const macdHolds =
    Number.isFinite(macdAtI) && Number.isFinite(macdAtS) && macdAtI < macdAtS;

  if (!rsiHolds && !macdHolds) return null;
  const divergenceFamily: 'rsi' | 'macd' | 'both' =
    rsiHolds && macdHolds ? 'both' : rsiHolds ? 'rsi' : 'macd';

  const latest = candles[t];

  // Rearm cooldown — same `rearmBars` value as the §4.1 r7 short stack, so a
  // fire cannot retrigger inside the cooldown window (= 32h at rearm 8 on 4H).
  if (lastFireTs !== null && candles.length >= 2) {
    const barInterval = latest.timestamp - candles[t - 1].timestamp;
    if (barInterval > 0 && latest.timestamp - lastFireTs < rearmBars * barInterval) {
      return null;
    }
  }

  // Risk: §4.1 r7 values byte-unchanged, ATR evaluated at the fire bar t.
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
    trigger: 'momentum-divergence',
    divergenceFamily,
  };
}
