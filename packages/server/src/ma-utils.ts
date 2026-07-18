/**
 * Small, dependency-free moving-average helpers.
 *
 * TRA-2032 — extracted out of `market-review.ts` to break the import cycle
 * `analyst-agent.ts -> market-review.ts -> analyst-agent.ts`. `analyst-agent`
 * only needed `simpleMa` (a leaf util), while `market-review` needs
 * `readAnalystPlan` from `analyst-agent`. Keeping the SMA in a route/job module
 * closed a 2-module cycle that the `check:cycles` gate (TRA-1684) rejects and
 * that can throw a TDZ error in prod from whichever entry point re-enters the
 * loop mid-evaluation. This module imports nothing runtime, so it cannot be part
 * of any cycle.
 */

import type { Candle } from '@trading-app/shared';

/**
 * Simple moving average of the last `period` candle closes, or `null` when
 * there is not enough history. TRA-472: the trend filter is a 50-period SMA.
 */
export function simpleMa(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const tail = candles.slice(-period);
  return tail.reduce((sum, c) => sum + c.close, 0) / period;
}
