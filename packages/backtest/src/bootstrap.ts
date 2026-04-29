/**
 * Bootstrap / Monte Carlo for closed-trade lists (TRA-172).
 *
 * Resampling with replacement from the realised trade distribution gives a
 * cheap, distribution-free estimate of how dependent the headline P&L number
 * is on trade ordering and on the small sample of trades we actually saw. It
 * does not invent new edges — it just shuffles the ones we already have — so
 * the resulting confidence band is a *floor* on uncertainty, not a ceiling.
 */

import type { Position } from '@trading-app/shared';
import type { ConfidenceBands } from './types.js';

export interface BootstrapOptions {
  iterations?: number;
  /** Optional seed for reproducibility (defaults to Math.random). */
  seed?: number;
}

// Mulberry32 — same generator the synthetic-candle module uses, kept inline
// to avoid a circular dependency between modules that both want determinism.
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor((p / 100) * sortedAsc.length)),
  );
  return sortedAsc[idx];
}

/**
 * Builds a confidence band over final equity by resampling the closed trades.
 *
 * Each iteration draws `trades.length` PnLs with replacement, replays them in
 * draw order to compute a synthetic equity curve, and records both the final
 * equity and the worst peak-to-trough drawdown observed along the way.
 */
export function bootstrapEquityCurves(
  trades: ReadonlyArray<Position>,
  initialEquity: number,
  opts: BootstrapOptions = {},
): ConfidenceBands {
  const iterations = opts.iterations ?? 1000;
  const rand = opts.seed !== undefined ? mulberry32(opts.seed) : Math.random;
  const pnls = trades.map(t => t.pnl ?? 0);

  if (pnls.length === 0) {
    return {
      p5: initialEquity,
      p50: initialEquity,
      p95: initialEquity,
      worstDrawdown: 0,
      iterations,
    };
  }

  const finals: number[] = [];
  let worstDrawdown = 0;

  for (let it = 0; it < iterations; it++) {
    let equity = initialEquity;
    let peak = initialEquity;
    let dd = 0;

    for (let n = 0; n < pnls.length; n++) {
      const pick = pnls[Math.floor(rand() * pnls.length)];
      equity += pick;
      peak = Math.max(peak, equity);
      const drawdown = peak > 0 ? (peak - equity) / peak : 0;
      if (drawdown > dd) dd = drawdown;
    }

    finals.push(equity);
    if (dd > worstDrawdown) worstDrawdown = dd;
  }

  finals.sort((a, b) => a - b);

  return {
    p5: percentile(finals, 5),
    p50: percentile(finals, 50),
    p95: percentile(finals, 95),
    worstDrawdown,
    iterations,
  };
}
