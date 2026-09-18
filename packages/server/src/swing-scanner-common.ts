/**
 * TRA-4706 — pieces the three TRA-4570 swing scanners share.
 *
 * Pure: no IO, no clock reads (`asOf` is always passed in), so every scanner is
 * gradable on fixed fixtures.
 */

import type { Candle, OptionType } from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import { blackScholesDelta, daysToExpiration } from '@trading-app/engine';

/**
 * Reward ÷ risk in UNDERLYING dollars, measured from `underlyingPrice`.
 *
 * ⛔ Stop and target are underlying price levels; the option premium is a
 * different unit and never enters this ratio (the pre-TRA-4706 scanners mixed
 * them). Returns `null` when the levels do not bracket the spot on the side the
 * thesis needs — a stop on the wrong side of price is a malformed setup, not a
 * huge R:R.
 */
export function underlyingRiskReward(
  underlyingPrice: number,
  stopLoss: number,
  takeProfit: number,
  direction: 'bullish' | 'bearish',
): number | null {
  const reward = direction === 'bullish' ? takeProfit - underlyingPrice : underlyingPrice - takeProfit;
  const risk = direction === 'bullish' ? underlyingPrice - stopLoss : stopLoss - underlyingPrice;
  if (!(reward > 0) || !(risk > 0)) return null;
  return reward / risk;
}

export interface DeltaBandPick {
  row: OptionChainRow;
  mark: number;
  /** Unsigned delta. */
  delta: number;
  dte: number;
  iv: number;
}

/**
 * The OTM contract of `optionType` whose |delta| sits closest to the middle of
 * `[deltaMin, deltaMax]`, inside `[dteMin, dteMax]`, with a two-sided quote.
 * `rank` may override the ordering (higher first); ties keep chain order.
 */
export function pickDeltaBandOption(opts: {
  chain: readonly OptionChainRow[];
  optionType: OptionType;
  spot: number;
  deltaMin: number;
  deltaMax: number;
  dteMin: number;
  dteMax: number;
  asOf: number;
  riskFreeRate: number;
  /** σ used when a row carries no `midIv`. */
  fallbackIv: number;
  rank?: (p: DeltaBandPick & { deltaScore: number }) => number;
}): DeltaBandPick | null {
  const mid = (opts.deltaMin + opts.deltaMax) / 2;
  const scored: Array<DeltaBandPick & { deltaScore: number }> = [];
  for (const row of opts.chain) {
    if (row.optionType !== opts.optionType) continue;
    const otm = opts.optionType === 'call' ? row.strike > opts.spot : row.strike < opts.spot;
    if (!otm) continue;
    if (!(row.bid != null && row.bid > 0) || !(row.ask != null && row.ask >= row.bid)) continue;
    const dte = daysToExpiration(row.expiration, opts.asOf);
    if (dte < opts.dteMin || dte > opts.dteMax) continue;
    const iv = row.midIv ?? opts.fallbackIv;
    const delta = Math.abs(blackScholesDelta({
      spot: opts.spot,
      strike: row.strike,
      timeToExpiryYears: dte / 365,
      volatility: iv,
      riskFreeRate: opts.riskFreeRate,
      optionType: opts.optionType,
    }));
    if (delta < opts.deltaMin || delta > opts.deltaMax) continue;
    scored.push({
      row,
      mark: (row.bid + row.ask) / 2,
      delta,
      dte,
      iv,
      deltaScore: 1 - Math.abs(delta - mid) / mid,
    });
  }
  if (scored.length === 0) return null;
  const rank = opts.rank ?? ((p) => p.deltaScore);
  scored.sort((a, b) => rank(b) - rank(a));
  const { deltaScore: _ds, ...best } = scored[0];
  return best;
}

/** UTC calendar day (`YYYY-MM-DD`) of a daily bar. Both daily feeds stamp a time inside the session's own date. */
export function barDay(c: Candle): string {
  return new Date(c.timestamp).toISOString().slice(0, 10);
}
