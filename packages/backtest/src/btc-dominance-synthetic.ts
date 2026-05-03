/**
 * Synthetic BTC-dominance daily series — extracted from
 * `run-tra296-meanrev-long-regime-sweep.ts` (originally introduced for
 * TRA-296 / TRA-297) so subsequent regime-gated harnesses can reuse the
 * same source without duplicating the loader.
 *
 * Source: BTC market cap divided by Σ(BTC + ETH + SOL + DOGE + XRP)
 * market caps, computed from the existing daily Coinbase caches in
 * `packages/backtest/data/<symbol>.json` weighted by approximate
 * mid-period 2024 circulating-supply constants.
 *
 * Why synthetic and not real CRYPTOCAP:BTC.D: TradingView dominance is
 * not directly fetchable through the existing data-loader path
 * (Yahoo / Coinbase). CoinGecko free public API caps historical per-coin
 * `market_chart` at 365 days and the global market-cap-chart endpoint is
 * Pro-only; Coinpaprika free is the same 1-year cap. We need ≥ 1000
 * daily bars (warm-up + 9 walk-forward test windows). Binance pair flows
 * would require new fetcher infra. The 5-coin synthetic from existing
 * caches needs no network and is deterministic.
 *
 * Documented proxy nature: the synthetic basket overstates BTC's
 * absolute dominance (excludes USDT/USDC/BNB/etc.) but tracks the
 * *trend* of real CRYPTOCAP:BTC.D — what the regime gate cares about.
 * ETH/SOL/DOGE/XRP are precisely the alts that move in alt-favorable
 * regimes, so the basket is appropriate for the alt-favorable vs
 * BTC-favorable regime classification.
 *
 * Constant supplies (mid-period 2024 approximations) drift < 1% per
 * 50d window, so the rolling-SMA-vs-current-level signal is unaffected.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { loadOrFetchDailyBars } from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const DOMINANCE_CACHE = resolve(DATA_DIR, 'btc-dominance-synthetic.json');

/** Mid-period 2024 circulating-supply constants for the 5-coin basket. */
export const BTC_DOMINANCE_BASKET = [
  { symbol: 'BTC-USD',  supply: 19_500_000        },
  { symbol: 'ETH-USD',  supply: 120_000_000       },
  { symbol: 'SOL-USD',  supply: 400_000_000       },
  { symbol: 'DOGE-USD', supply: 144_000_000_000   },
  { symbol: 'XRP-USD',  supply: 55_000_000_000    },
] as const;

export interface DominancePoint {
  /** Start-of-day timestamp (daily-bar timestamp). */
  ts: number;
  /** BTC mcap / Σ basket mcaps on this day. */
  dominance: number;
  /** Trailing SMA of `dominance` over the configured period; null until
   *  enough warm-up samples are available. */
  sma: number | null;
}

export interface DominanceSeries {
  points: DominancePoint[];
  smaPeriod: number;
  /** Returns the most-recent-completed daily dominance bar at 4H ts `t`,
   *  or null if no daily bar has fully completed before `t`. The bar may
   *  still have `sma === null` if warm-up is not yet satisfied. */
  lookup: (ts4h: number) => DominancePoint | null;
}

function basketSignature(smaPeriod: number): string {
  return BTC_DOMINANCE_BASKET.map((c) => `${c.symbol}=${c.supply}`).join('|') + `;sma=${smaPeriod}`;
}

/**
 * Load the synthetic BTC-dominance daily series with a configurable
 * trailing SMA period. The cached on-disk series stores the raw
 * dominance points and the SMA for the last requested period; if the
 * caller requests a different period, the SMA is recomputed from the
 * cached raw points without re-fetching.
 */
export async function loadSyntheticBtcDominanceDaily(
  fromMs: number,
  toMs: number,
  smaPeriod: number,
): Promise<DominanceSeries> {
  let raw: { ts: number; dominance: number }[] | null = null;

  if (existsSync(DOMINANCE_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(DOMINANCE_CACHE, 'utf-8'));
      const basketStable =
        Array.isArray(cached?.basket) &&
        cached.basket.length === BTC_DOMINANCE_BASKET.length &&
        cached.basket.every((c: { symbol: string; supply: number }, i: number) =>
          c.symbol === BTC_DOMINANCE_BASKET[i].symbol && c.supply === BTC_DOMINANCE_BASKET[i].supply,
        );
      const points: Array<DominancePoint & { dominance: number; ts: number }> = cached?.points ?? [];
      const startOk = points.length > 0 && points[0].ts <= fromMs;
      const endOk = points.length > 0 && points[points.length - 1].ts >= toMs - 24 * 60 * 60 * 1000;
      if (basketStable && startOk && endOk) {
        raw = points.map((p) => ({ ts: p.ts, dominance: p.dominance }));
      }
    } catch { /* fall through to recompute */ }
  }

  if (!raw) {
    const series = new Map<string, Candle[]>();
    for (const c of BTC_DOMINANCE_BASKET) {
      series.set(c.symbol, await loadOrFetchDailyBars(c.symbol, fromMs, toMs));
    }
    const all = BTC_DOMINANCE_BASKET.map((c) => series.get(c.symbol)!);
    const tsSets = all.map((arr) => new Set(arr.map((b) => b.timestamp)));
    const baseTs = all[0].map((b) => b.timestamp).filter((ts) => tsSets.every((s) => s.has(ts)));

    const closeMaps = new Map<string, Map<number, number>>();
    for (const c of BTC_DOMINANCE_BASKET) {
      const m = new Map<number, number>();
      for (const b of series.get(c.symbol)!) m.set(b.timestamp, b.close);
      closeMaps.set(c.symbol, m);
    }

    raw = [];
    for (const ts of baseTs) {
      let total = 0;
      let btc = 0;
      for (const c of BTC_DOMINANCE_BASKET) {
        const close = closeMaps.get(c.symbol)!.get(ts)!;
        const mcap = close * c.supply;
        total += mcap;
        if (c.symbol === 'BTC-USD') btc = mcap;
      }
      if (total > 0) raw.push({ ts, dominance: btc / total });
    }

    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  }

  const points: DominancePoint[] = raw.map((p, i) => {
    if (i + 1 < smaPeriod) return { ts: p.ts, dominance: p.dominance, sma: null };
    let sum = 0;
    for (let k = i + 1 - smaPeriod; k <= i; k++) sum += raw![k].dominance;
    return { ts: p.ts, dominance: p.dominance, sma: sum / smaPeriod };
  });

  // Persist the raw series; SMA is derived per-call so callers with
  // different periods don't invalidate each other's cache.
  writeFileSync(DOMINANCE_CACHE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    basketSig: basketSignature(smaPeriod),
    basket: BTC_DOMINANCE_BASKET,
    smaPeriodLastWritten: smaPeriod,
    points: raw,
  }, null, 2));

  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const lookup = (ts4h: number): DominancePoint | null => {
    // Most-recent-completed daily means: a daily bar whose close happened
    // strictly before bar i's open. A daily bar at timestamp `D_ts`
    // covers [D_ts, D_ts + 24h] and closes at D_ts + 24h. So we want the
    // largest `D_ts` with `D_ts + 24h ≤ ts4h`.
    const cutoff = ts4h - 24 * 60 * 60 * 1000;
    let lo = 0;
    let hi = sorted.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].ts <= cutoff) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found >= 0 ? sorted[found] : null;
  };

  return { points: sorted, smaPeriod, lookup };
}
