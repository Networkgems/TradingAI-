import {
  evaluateShortSqueeze,
  smaSeries,
  type ShortSqueezeResult,
  type ShortSqueezeThresholds,
  type ShortSqueezeFundamentals,
  type ShortSqueezePriceStats,
  type EvaluateShortSqueezeOptions,
} from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';
import type { ShortInterestFundamentals } from './yahoo-feed.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'short-squeeze-scanner' });

// Short-interest is exchange-reported roughly twice a month, so a 15-minute
// fundamentals cache is generous and keeps the Yahoo quoteSummary call rate
// trivial even across a full-watchlist scan.
const DEFAULT_FUNDAMENTALS_CACHE_TTL_MS = 15 * 60_000;
// Prior-session window for the RVOL denominator + the average-daily-volume
// filter. 20 sessions ~= one trading month.
const RVOL_LOOKBACK_DAYS = 20;
const SMA_PERIOD = 50;
// Enough daily bars to seed a 50-day SMA with a session of slack.
export const SHORT_SQUEEZE_MIN_DAILY_BARS = SMA_PERIOD + 1;
// Bars to request so the SMA + RVOL windows are always fully populated.
const DAILY_BARS_TO_FETCH = SMA_PERIOD + RVOL_LOOKBACK_DAYS + 10;
// Concurrency cap for a universe scan so we never burst the Yahoo breaker.
const UNIVERSE_SCAN_CONCURRENCY = 4;

export interface ShortSqueezeScanResult {
  symbol: string;
  evaluation: ShortSqueezeResult | null;
  /** Raw inputs, surfaced so the API/UI can show the underlying numbers. */
  fundamentals: ShortInterestFundamentals | null;
  priceStats: ShortSqueezePriceStats | null;
  reason: 'ok' | 'no_data' | 'fetch_error';
  errorMessage?: string;
}

export interface ShortSqueezeScannerDiagnostics {
  configured: boolean;
  cacheSize: number;
  cacheTtlMs: number;
  lastScan: { at: number; scanned: number; qualifiers: number } | null;
}

export interface ShortSqueezeScannerConfig {
  /** Fundamentals source — server wires this to Yahoo `fetchShortInterestFundamentals`. */
  fetchFundamentals: (symbol: string) => Promise<ShortInterestFundamentals | null>;
  /** Daily-bar source — server wires this to `fetchDailyCandles` (Yahoo → Tradier). */
  fetchDailyBars: (symbol: string, count: number) => Promise<Candle[]>;
  /** Threshold overrides (board/QuantTrader tuning); absent → spec defaults. */
  thresholds?: Partial<ShortSqueezeThresholds>;
  /** Score band overrides for strong/moderate classification. */
  scoreOptions?: Pick<EvaluateShortSqueezeOptions, 'strongScore' | 'moderateScore'>;
  /** Test seam for time. */
  now?: () => number;
  /** Override the fundamentals cache TTL. */
  cacheTtlMs?: number;
}

interface CacheEntry {
  value: ShortInterestFundamentals | null;
  at: number;
}

/**
 * TRA-1207 — server wrapper around the pure {@link evaluateShortSqueeze}
 * screener. Assembles the two data sources the pure function needs — Yahoo
 * quoteSummary fundamentals (short interest / float / market cap) and daily
 * bars (avg volume, RVOL, 50-day SMA) — caches the (slow-moving) fundamentals,
 * and ranks a symbol universe. Read-only: it screens and scores, it never
 * places an order.
 */
export class ShortSqueezeScannerService {
  private readonly fetchFundamentals: (symbol: string) => Promise<ShortInterestFundamentals | null>;
  private readonly fetchDailyBars: (symbol: string, count: number) => Promise<Candle[]>;
  private readonly thresholds?: Partial<ShortSqueezeThresholds>;
  private readonly scoreOptions?: Pick<EvaluateShortSqueezeOptions, 'strongScore' | 'moderateScore'>;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly fundamentalsCache = new Map<string, CacheEntry>();
  private lastScan: { at: number; scanned: number; qualifiers: number } | null = null;

  constructor(config: ShortSqueezeScannerConfig) {
    this.fetchFundamentals = config.fetchFundamentals;
    this.fetchDailyBars = config.fetchDailyBars;
    this.thresholds = config.thresholds;
    this.scoreOptions = config.scoreOptions;
    this.now = config.now ?? Date.now;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_FUNDAMENTALS_CACHE_TTL_MS;
  }

  diagnostics(): ShortSqueezeScannerDiagnostics {
    return {
      configured: true,
      cacheSize: this.fundamentalsCache.size,
      cacheTtlMs: this.cacheTtlMs,
      lastScan: this.lastScan,
    };
  }

  private async getFundamentals(symbol: string): Promise<ShortInterestFundamentals | null> {
    const cached = this.fundamentalsCache.get(symbol);
    if (cached && this.now() - cached.at < this.cacheTtlMs) return cached.value;
    const value = await this.fetchFundamentals(symbol);
    // Cache successes only; a null (cold feed) should be retried next scan
    // rather than pinned for the whole TTL.
    if (value) this.fundamentalsCache.set(symbol, { value, at: this.now() });
    return value;
  }

  /** Derive price/volume/technical stats from a chronologically-ascending daily series. */
  private computePriceStats(bars: Candle[]): ShortSqueezePriceStats {
    if (bars.length === 0) return { price: null, avgDailyVolume: null, rvol: null, sma50: null };
    const closes = bars.map((b) => b.close);
    const vols = bars.map((b) => b.volume);
    const t = bars.length - 1;
    const price = closes[t] ?? null;
    const todayVol = vols[t] ?? 0;
    // Average of the PRIOR N sessions (exclude today) so RVOL is today vs. its
    // own recent baseline, not a window that includes the reading itself.
    const priorVols = vols.slice(Math.max(0, t - RVOL_LOOKBACK_DAYS), t);
    const avgDailyVolume =
      priorVols.length > 0 ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length : null;
    const rvol = avgDailyVolume && avgDailyVolume > 0 ? todayVol / avgDailyVolume : null;
    const sma = smaSeries(closes, SMA_PERIOD)[t];
    const sma50 = typeof sma === 'number' && Number.isFinite(sma) ? sma : null;
    return { price, avgDailyVolume, rvol, sma50 };
  }

  /** Screen a single symbol. Never throws — failures map to a typed `reason`. */
  async scan(symbol: string): Promise<ShortSqueezeScanResult> {
    const upper = symbol.trim().toUpperCase();
    let fundamentals: ShortInterestFundamentals | null;
    let bars: Candle[];
    try {
      [fundamentals, bars] = await Promise.all([
        this.getFundamentals(upper),
        this.fetchDailyBars(upper, DAILY_BARS_TO_FETCH),
      ]);
    } catch (err) {
      return {
        symbol: upper,
        evaluation: null,
        fundamentals: null,
        priceStats: null,
        reason: 'fetch_error',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    if (!fundamentals && bars.length === 0) {
      return { symbol: upper, evaluation: null, fundamentals: null, priceStats: null, reason: 'no_data' };
    }

    const priceStats = this.computePriceStats(bars);
    const engineFundamentals: ShortSqueezeFundamentals = {
      shortPercentOfFloat: fundamentals?.shortPercentOfFloat ?? null,
      sharesShort: fundamentals?.sharesShort ?? null,
      daysToCover: fundamentals?.daysToCover ?? null,
      floatShares: fundamentals?.floatShares ?? null,
      sharesOutstanding: fundamentals?.sharesOutstanding ?? null,
      marketCap: fundamentals?.marketCap ?? null,
      // Borrow fee is not carried by Yahoo — leave undefined so the screener
      // marks that criterion not-applicable rather than failing it.
    };
    const evaluation = evaluateShortSqueeze(upper, engineFundamentals, priceStats, {
      thresholds: this.thresholds,
      ...this.scoreOptions,
    });
    return { symbol: upper, evaluation, fundamentals, priceStats, reason: 'ok' };
  }

  /**
   * Screen a universe and return every result, ranked: qualifying candidates
   * first (highest score first), then the rest by score. Runs with a bounded
   * concurrency so a full-watchlist scan never bursts the Yahoo breaker.
   */
  async scanUniverse(symbols: readonly string[]): Promise<ShortSqueezeScanResult[]> {
    const unique = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean);
    const results: ShortSqueezeScanResult[] = [];
    for (let i = 0; i < unique.length; i += UNIVERSE_SCAN_CONCURRENCY) {
      const batch = unique.slice(i, i + UNIVERSE_SCAN_CONCURRENCY);
      results.push(...(await Promise.all(batch.map((s) => this.scan(s)))));
    }
    results.sort((a, b) => rank(b) - rank(a));
    const qualifiers = results.filter((r) => r.evaluation?.qualifies).length;
    this.lastScan = { at: this.now(), scanned: results.length, qualifiers };
    log.info('short-squeeze universe scan', { scanned: results.length, qualifiers });
    return results;
  }
}

/**
 * Ranking key: qualifiers sort strictly above non-qualifiers, then by score.
 * Keeps `scanUniverse` output board-ready (best squeeze setups on top).
 */
function rank(r: ShortSqueezeScanResult): number {
  const score = r.evaluation?.score ?? -1;
  const qualifyBonus = r.evaluation?.qualifies ? 1000 : 0;
  return qualifyBonus + score;
}
