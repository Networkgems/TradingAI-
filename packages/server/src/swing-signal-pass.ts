/**
 * TRA-4706 — one observe-only swing pass over a symbol list, with every input
 * injected so the WIRING (not just the scanners) is gradable.
 *
 * The engine supplies the deps: the warm selector chain, the shared DAILY
 * series (`otm-daily-series.ts`, filled off the order path with a Tradier
 * fallback — TRA-4424), the IV stores, and the earnings store's most recent
 * PAST date. Nothing here does IO or reads the clock.
 *
 * ⛔ Every way a symbol can fail to be scored is COUNTED into
 * {@link SwingScanSummary}, split by cause. The Swing tab was parked (TRA-4705)
 * because it read the same working or broken; an empty list must now carry the
 * reason it is empty.
 */

import type { Candle, SwingScanSummary, SwingSignalCandidate } from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import { atr } from '@trading-app/engine';
import { scanAndRankSwingSignals, type FusionEngineConfig } from './swing-signal-fusion.js';
import type { RecentEarningsRead } from './earnings-store.js';
import { OTM_DAILY_SERIES_MIN_THESIS_SPAN_MS } from './otm-daily-series.js';

/**
 * Minimum daily-series depth the pass will score. Momentum needs its 100-bar
 * prior window + the latest bar; the others need far less. A shorter series is
 * `dailySeriesUnreadable`, not "no setup".
 */
export const SWING_MIN_DAILY_BARS = 101;

/** Top-N kept on `EngineState.swingSignals` per pass. */
export const SWING_MAX_CANDIDATES = 20;

export interface SwingPassDeps {
  getChain(symbol: string): Promise<{ spot: number; rows: OptionChainRow[] } | null>;
  /** Readable DAILY bars, or `[]` when the cache is absent/stale. */
  readDailyBars(symbol: string): readonly Candle[];
  atmIv(rows: readonly OptionChainRow[], spot: number): number | null;
  ivRank(symbol: string, atmIv: number): number | null;
  ivPercentile(symbol: string, atmIv: number): number | null;
  recentEarnings(symbol: string): RecentEarningsRead;
  asOf: number;
  fusion?: FusionEngineConfig;
  /** Per-symbol failure hook (logging); a throw never aborts the pass. */
  onSymbolError?(symbol: string, err: unknown): void;
}

export interface SwingPassResult {
  candidates: SwingSignalCandidate[];
  summary: SwingScanSummary;
}

/**
 * ⛔ The span guard is the backstop for defect 2 (TRA-4706): the first cut fed
 * the 5m `candleCache` to scanners reading multi-day structure. 480 five-minute
 * bars clear any bar-COUNT floor, and span ~8.6 calendar days. The 30-day bar
 * is the one TRA-4424 derived from that exact population — >3x the defect,
 * far under the ~168-day span of 120 daily bars.
 */
function isDailyShaped(bars: readonly Candle[]): boolean {
  if (bars.length < SWING_MIN_DAILY_BARS) return false;
  const spanMs = bars[bars.length - 1].timestamp - bars[0].timestamp;
  return spanMs >= OTM_DAILY_SERIES_MIN_THESIS_SPAN_MS;
}

export async function runSwingSignalPass(
  symbols: readonly string[],
  deps: SwingPassDeps,
): Promise<SwingPassResult> {
  const summary: SwingScanSummary = {
    at: deps.asOf,
    symbolsConsidered: symbols.length,
    dailySeriesUnreadable: 0,
    chainUnreadable: 0,
    ivUnreadable: 0,
    symbolsScored: 0,
    earnings: { recent: 0, none: 0, unreadable: 0 },
    emittedByType: { post_earnings_iv_crush: 0, momentum_breakout_iv_lag: 0, panic_reversal: 0 },
    ranked: 0,
  };
  const candidates: SwingSignalCandidate[] = [];

  for (const sym of symbols) {
    try {
      // Daily series first: it is a Map lookup, the chain is a network read.
      const bars = deps.readDailyBars(sym);
      if (!isDailyShaped(bars)) { summary.dailySeriesUnreadable += 1; continue; }

      const snap = await deps.getChain(sym);
      if (!snap || !(snap.spot > 0) || snap.rows.length === 0) { summary.chainUnreadable += 1; continue; }

      const iv = deps.atmIv(snap.rows, snap.spot);
      const ivPercentile = iv != null ? deps.ivPercentile(sym, iv) : null;
      const ivRank = iv != null ? deps.ivRank(sym, iv) : null;
      if (ivPercentile === null) { summary.ivUnreadable += 1; continue; }

      const earnings = deps.recentEarnings(sym);
      summary.earnings[earnings.state] += 1;

      const series = bars as Candle[];
      // Average DAILY volume over the 20 sessions BEFORE the latest bar, so the
      // breakout bar's own volume is not in its own denominator.
      const priorVol = series.slice(-21, -1);
      const avgVolume = priorVol.reduce((s, c) => s + c.volume, 0) / priorVol.length;
      const atrValue = atr(series, 14);

      const { emitted, ranked } = scanAndRankSwingSignals({
        symbol: sym,
        candles: series,
        optionChain: snap.rows,
        ivPercentile,
        currentPrice: snap.spot,
        avgVolume,
        asOf: deps.asOf,
        ...(ivRank !== null ? { ivRank } : {}),
        ...(atrValue !== null ? { atr: atrValue } : {}),
        ...(earnings.state === 'recent' ? { earningsDate: earnings.date } : {}),
      }, deps.fusion);
      summary.symbolsScored += 1;
      for (const s of emitted) summary.emittedByType[s.type] += 1;
      summary.ranked += ranked.length;
      candidates.push(...ranked);
    } catch (err: unknown) {
      deps.onSymbolError?.(sym, err);
    }
  }

  return {
    candidates: candidates.sort((a, b) => b.score - a.score).slice(0, SWING_MAX_CANDIDATES),
    summary,
  };
}
