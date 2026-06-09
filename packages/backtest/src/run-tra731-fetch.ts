/**
 * TRA-731 (Phase 2, component 1) — equity-bar fetch for the SupertrendConfluence
 * watchlist.
 *
 * Pulls >=12mo of daily OHLC for AMD, PLTR, NVDA, AAPL, MSFT, SPY, QQQ and caches
 * them under `packages/backtest/data/<symbol>.json` in the SAME shape the existing
 * runners expect (reuses {@link loadOrFetchDailyBars}, the TRA-266 / TRA-423 cache
 * path). This is the ONLY step that touches the network; once the cache is warm
 * every downstream TRA-731 runner is offline-reproducible.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest build
 *   node packages/backtest/dist/run-tra731-fetch.js              # ~18mo default
 *   node packages/backtest/dist/run-tra731-fetch.js --months 24  # wider window
 */

import { loadOrFetchDailyBars } from './fetch-tra266-data.js';
import type { Candle } from '@trading-app/shared';

/** The TRA-727 / TRA-729 watchlist for the Phase-2 gate. */
export const TRA731_UNIVERSE = ['AMD', 'PLTR', 'NVDA', 'AAPL', 'MSFT', 'SPY', 'QQQ'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Window bounds for an N-month lookback ending now. Exposed for the runner. */
export function lookbackWindow(months: number, nowMs = Date.now()): { fromMs: number; toMs: number } {
  const fromMs = nowMs - Math.round(months * 30.44 * DAY_MS);
  return { fromMs, toMs: nowMs };
}

/** Fetch (or load from cache) daily bars for the whole universe. */
export async function fetchUniverse(months: number): Promise<Map<string, Candle[]>> {
  const { fromMs, toMs } = lookbackWindow(months);
  const out = new Map<string, Candle[]>();
  for (const symbol of TRA731_UNIVERSE) {
    const bars = await loadOrFetchDailyBars(symbol, fromMs, toMs);
    out.set(symbol, bars);
  }
  return out;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const monthsArg = parseArg('months');
  const months = monthsArg ? Number(monthsArg) : 18;
  console.log(`[TRA-731 fetch] universe: ${TRA731_UNIVERSE.join(', ')} — ${months}mo daily bars`);

  for (const symbol of TRA731_UNIVERSE) {
    const { fromMs, toMs } = lookbackWindow(months);
    try {
      const bars = await loadOrFetchDailyBars(symbol, fromMs, toMs);
      const years = bars.length > 1 ? (bars[bars.length - 1].timestamp - bars[0].timestamp) / (365.25 * DAY_MS) : 0;
      const status = years >= 1 ? 'OK' : 'SHORT';
      console.log(
        `  ${symbol}: ${bars.length} bars, ${years.toFixed(2)}y ` +
          `(${new Date(bars[0]?.timestamp ?? 0).toISOString().slice(0, 10)} → ` +
          `${new Date(bars[bars.length - 1]?.timestamp ?? 0).toISOString().slice(0, 10)}) [${status}]`,
      );
    } catch (err: unknown) {
      console.error(`  ${symbol}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log('[TRA-731 fetch] done. Bars cached under packages/backtest/data/.');
}

const invoked = process.argv[1] && /[\\/]run-tra731-fetch\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
