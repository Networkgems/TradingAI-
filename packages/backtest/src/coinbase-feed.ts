/**
 * Public Coinbase Exchange candles fetch.
 *
 * TRA-267 introduced this for the Phase-1 perp shorts 4H backfill. TRA-300
 * generalised it to also serve 1D and 1m crypto bars — same venue alignment
 * as TRA-300's quote fix, so signal price ↔ execution price stay matched and
 * Yahoo's per-IP rate-limiter is no longer a single point of failure.
 *
 * Granularity note: the Exchange public-candles endpoint rejects anything
 * outside `{60, 300, 900, 3600, 21600, 86400}`. The TRA-267 spec wanted
 * `granularity=14400` (4H) which Coinbase doesn't support — we fetch 1H bars
 * and aggregate to 4H locally on UTC `00/04/08/12/16/20` boundaries. 1m
 * (60) and 1D (86400) are native and don't need aggregation.
 */

import type { Candle } from '@trading-app/shared';

const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const GRANULARITY_1M = 60;
const GRANULARITY_1H = 3600;
const GRANULARITY_1D = 86_400;
const MAX_CANDLES_PER_REQUEST = 300;
const REQUEST_GAP_MS = 150;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CoinbaseCandleRow = [number, number, number, number, number, number];

/**
 * TRA-300 / TRA-329 — host-keyed rate limiter + circuit breaker for Coinbase
 * public-data requests.
 *
 * Coinbase enforces a per-IP request budget on each host independently
 * (`api.exchange.coinbase.com` and the keyless `api.coinbase.com` Advanced
 * Trade host are separate buckets), so a single global pacer either over-paces
 * the cheaper host or blows the budget on the more sensitive one. The factory
 * below produces an isolated pacer per host: each has its own Promise chain
 * (so a hung fetch on one host can't poison the other), its own failure
 * counter, and its own cooldown window. {@link paceCoinbaseFetch} is the
 * Exchange-host instance (~120 ms gap ≈ 8.3 req/s, comfortably under the
 * documented 10 req/s/IP cap). TRA-484 added
 * {@link paceCoinbaseAdvancedTradeFetch} for `api.coinbase.com` with a
 * slightly larger 150 ms gap (~6.6 req/s) — the Advanced Trade public surface
 * is the keyless Exchange-breaker-open fallback path, so a more conservative
 * gap leaves headroom for the cascade when ~45 watchlist symbols fan out at
 * once.
 *
 * TRA-300 background — the live engine's tick fans out ~50 stats + 50 minute
 * + 50 daily + 5 4H requests within a few seconds; without pacing, the
 * Exchange host bulk-429'd every call and the cascade collapsed back to
 * Yahoo. TRA-329 added the per-fetch `AbortController` after observing that
 * one slow Coinbase response could hold the chain link open and stall every
 * subsequent enqueue (each in turn timing out at the outer 8 s wrapper). The
 * breaker fast-fails subsequent calls so we stop burning the outer budget
 * once we know the host is unhealthy.
 */
const COINBASE_EXCHANGE_MIN_GAP_MS = 120;
const COINBASE_ADVANCED_TRADE_MIN_GAP_MS = 150;
const COINBASE_FETCH_TIMEOUT_MS = 7_000;
const COINBASE_BREAKER_FAILURE_THRESHOLD = 5;
const COINBASE_BREAKER_COOLDOWN_MS = 60_000;

interface HostPacer {
  pace: (
    url: string,
    init?: { headers?: Record<string, string> },
    options?: { timeoutMs?: number },
  ) => Promise<Response>;
  isBreakerOpen: () => boolean;
  /**
   * TRA-1059 — rolling count of upstream fetches this pacer actually dispatched
   * within the trailing {@link COINBASE_RATE_WINDOW_MS}. Counts only requests that
   * cleared the breaker and were sent (breaker-skipped calls are not load), so it
   * is the candle/quote req/min headroom gauge against Coinbase's per-IP ceiling.
   */
  requestsLastMin: (now: number) => number;
  reset: () => void;
}

// TRA-1059 — window for the per-host rolling request-rate meter (mirrors the
// Tradier bar-pull meter in `yahoo-feed.ts`).
const COINBASE_RATE_WINDOW_MS = 60_000;

interface HostPacerOptions {
  /** Label inserted into log lines (e.g. "exchange" / "advanced-trade"). */
  logLabel: string;
  /** Minimum gap between fetches on this host. */
  minGapMs: number;
  /** Error message thrown when the breaker is open. Substring-matched by callers in `crypto-feed.ts`. */
  breakerOpenMessage: string;
  /** Error-message prefix for the per-fetch abort timeout. */
  timeoutMessagePrefix: string;
}

function createHostPacer(opts: HostPacerOptions): HostPacer {
  let chain: Promise<unknown> = Promise.resolve();
  let lastRequestAt = 0;
  // TRA-804 — count *consecutive* transport failures, not failures within a
  // sliding time window. The earlier window-based counter (30s window, 5
  // failures) was silently defeated by the dominant prod failure mode: when a
  // Coinbase host hangs, each fetch aborts only at the ~7s per-fetch timeout,
  // so 5 serialized failures span ~35s — and the oldest aged out of the 30s
  // window before the 5th landed, so the breaker never tripped. The host then
  // got hammered every tick (per-user crypto ticks spent minutes on dead
  // Advanced Trade calls), starving the event loop and dropping sessions. A
  // success resets the counter, so this is still robust against sporadic blips
  // — it only trips on a genuine run of back-to-back failures.
  let consecutiveFailures = 0;
  let breakerOpenUntil = 0;

  // TRA-1059 — timestamps (epoch-ms) of upstream fetches this pacer dispatched,
  // pruned to the trailing window. Restart-resilient by construction (in-memory,
  // resets with the process) and mirrors the Tradier bar-pull meter.
  const reqTimestamps: number[] = [];
  const recordRequest = (now: number): void => {
    reqTimestamps.push(now);
    const cutoff = now - COINBASE_RATE_WINDOW_MS;
    let drop = 0;
    while (drop < reqTimestamps.length && reqTimestamps[drop] <= cutoff) drop += 1;
    if (drop > 0) reqTimestamps.splice(0, drop);
  };
  const requestsLastMin = (now: number): number => {
    const cutoff = now - COINBASE_RATE_WINDOW_MS;
    let count = 0;
    for (let i = reqTimestamps.length - 1; i >= 0; i -= 1) {
      if (reqTimestamps[i] > cutoff) count += 1;
      else break;
    }
    return count;
  };

  const isBreakerOpen = (): boolean => Date.now() < breakerOpenUntil;

  const recordFailure = (): void => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= COINBASE_BREAKER_FAILURE_THRESHOLD) {
      breakerOpenUntil = Date.now() + COINBASE_BREAKER_COOLDOWN_MS;
      consecutiveFailures = 0;
      console.warn(
        `[coinbase-feed] ${opts.logLabel} circuit breaker tripped — skipping for ${COINBASE_BREAKER_COOLDOWN_MS / 1000}s after ${COINBASE_BREAKER_FAILURE_THRESHOLD} consecutive transport failures`,
      );
    }
  };

  const recordSuccess = (): void => {
    consecutiveFailures = 0;
  };

  const pace = async (
    url: string,
    init?: { headers?: Record<string, string> },
    options: { timeoutMs?: number } = {},
  ): Promise<Response> => {
    if (isBreakerOpen()) {
      throw new Error(opts.breakerOpenMessage);
    }
    const timeoutMs = options.timeoutMs ?? COINBASE_FETCH_TIMEOUT_MS;
    const next = chain.then(async () => {
      // Skip the wait when the gap is already exceeded *or* when `Date.now()`
      // appears to go backwards (vitest's fake timers reset the clock between
      // `it()`s, which would otherwise compute a huge positive wait against a
      // never-advancing fake clock and deadlock the suite).
      const elapsed = Date.now() - lastRequestAt;
      if (elapsed >= 0 && elapsed < opts.minGapMs) {
        await sleep(opts.minGapMs - elapsed);
      }
      lastRequestAt = Date.now();
      // TRA-1059 — meter the actual dispatched upstream request (post-pacing,
      // pre-fetch). Records every call that cleared the breaker, regardless of
      // whether the fetch later succeeds, since the upstream load is incurred
      // the moment the request goes out.
      recordRequest(lastRequestAt);

      // TRA-329 — the AbortController is the load-bearing piece. Without it,
      // a slow fetch would leave the chain link open even after the outer
      // `withTimeout` rejected, blocking every subsequent enqueue.
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { ...init, signal: controller.signal });
        recordSuccess();
        return resp;
      } catch (err) {
        recordFailure();
        if (controller.signal.aborted) {
          throw new Error(`${opts.timeoutMessagePrefix} timed out after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(abortTimer);
      }
    });
    // Keep the chain alive even if a call rejects, so a single failed request
    // doesn't poison every subsequent enqueue.
    chain = next.catch(() => undefined);
    return next as Promise<Response>;
  };

  const reset = (): void => {
    consecutiveFailures = 0;
    breakerOpenUntil = 0;
    chain = Promise.resolve();
    lastRequestAt = 0;
    reqTimestamps.length = 0;
  };

  return { pace, isBreakerOpen, requestsLastMin, reset };
}

const exchangePacer = createHostPacer({
  logLabel: 'exchange',
  minGapMs: COINBASE_EXCHANGE_MIN_GAP_MS,
  // Substring-matched by warn-suppression filters in `crypto-feed.ts` — do not rename.
  breakerOpenMessage: 'Coinbase breaker open',
  timeoutMessagePrefix: 'Coinbase fetch',
});
const advancedTradePacer = createHostPacer({
  logLabel: 'advanced-trade',
  minGapMs: COINBASE_ADVANCED_TRADE_MIN_GAP_MS,
  breakerOpenMessage: 'Coinbase advanced-trade breaker open',
  timeoutMessagePrefix: 'Coinbase Advanced Trade fetch',
});

export function isCoinbaseBreakerOpen(): boolean {
  return exchangePacer.isBreakerOpen();
}

/**
 * TRA-484 — `true` while the Advanced Trade pacer is in its cooldown window.
 * Exposed for parity with {@link isCoinbaseBreakerOpen} and for health probes
 * that want to surface both keyless paths independently.
 */
export function isCoinbaseAdvancedTradeBreakerOpen(): boolean {
  return advancedTradePacer.isBreakerOpen();
}

/**
 * TRA-1059 — rolling per-host Coinbase request-rate meter for `/api/health/quotes`.
 * Mirrors `getTradierBarPullRateState` in `yahoo-feed.ts`. The crypto candle
 * cascade (daily warmer + tick loop) hits the Exchange host first
 * (`api.exchange.coinbase.com`) and falls back to the keyless Advanced Trade host
 * (`api.coinbase.com`), so the candle load spans BOTH pacers — this surfaces each
 * separately plus the combined total, the number that must stay under the
 * ~200/min per-IP ceiling. Counts only requests that cleared the breaker and were
 * dispatched; breaker-skipped calls are not load and are not counted.
 */
export function getCoinbaseBarPullRateState(now: number = Date.now()): {
  requestsLastMin: number;
  windowSec: number;
  exchange: number;
  advancedTrade: number;
} {
  const exchange = exchangePacer.requestsLastMin(now);
  const advancedTrade = advancedTradePacer.requestsLastMin(now);
  return {
    requestsLastMin: exchange + advancedTrade,
    windowSec: COINBASE_RATE_WINDOW_MS / 1000,
    exchange,
    advancedTrade,
  };
}

/** Test seam — reset Exchange-pacer breaker / chain state between unit tests. */
export function _resetCoinbaseBreakerForTests(): void {
  exchangePacer.reset();
}

/** Test seam — reset Advanced Trade pacer breaker / chain state. */
export function _resetCoinbaseAdvancedTradeBreakerForTests(): void {
  advancedTradePacer.reset();
}

export function paceCoinbaseFetch(
  url: string,
  init?: { headers?: Record<string, string> },
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  return exchangePacer.pace(url, init, options);
}

/**
 * TRA-484 — sibling of {@link paceCoinbaseFetch} for the keyless Advanced
 * Trade host (`api.coinbase.com`). Same chain / breaker semantics, separate
 * state. Route every `api.coinbase.com/api/v3/brokerage/market/...` call
 * through this so the keyless fallback path stays inside Coinbase's per-IP
 * budget when the Exchange breaker is open and the cascade fans out the full
 * watchlist against it.
 */
export function paceCoinbaseAdvancedTradeFetch(
  url: string,
  init?: { headers?: Record<string, string> },
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  return advancedTradePacer.pace(url, init, options);
}

/**
 * Generic Coinbase candles fetch. Paginates `[fromMs, toMs)` in 300-bar
 * windows whose width scales with `granularitySeconds` (≈5h for 1m, ≈12.5d
 * for 1H, ≈300d for 1D). Returns ascending-by-timestamp, deduped on the
 * bar's open second.
 */
async function fetchCoinbaseCandles(
  symbol: string,
  granularitySeconds: number,
  fromMs: number,
  toMs: number,
  label: string,
  // TRA-1447 — optional per-fetch abort budget threaded to the host pacer.
  // When set (by the crypto-feed fan-out hardening flag), the pacer's internal
  // AbortController fires at this budget instead of its 7s default, so a hung
  // Coinbase host frees the paced dispatch chain and records a breaker failure
  // at the SAME instant the caller's outer `withTimeout` gives up — no ~4s of
  // chain occupancy past the caller's abandon point, and ~2.3× faster breaker
  // trips. Defaults to the pacer's own budget when unset (byte-identical).
  options: { timeoutMs?: number } = {},
): Promise<Candle[]> {
  if (toMs <= fromMs) return [];
  const stepMs = MAX_CANDLES_PER_REQUEST * granularitySeconds * 1000;
  const all: Candle[] = [];

  let cursor = fromMs;
  while (cursor < toMs) {
    const winEnd = Math.min(cursor + stepMs, toMs);
    const url = new URL(`${COINBASE_BASE}/products/${symbol}/candles`);
    url.searchParams.set('granularity', String(granularitySeconds));
    url.searchParams.set('start', new Date(cursor).toISOString());
    url.searchParams.set('end', new Date(winEnd).toISOString());

    const res = await paceCoinbaseFetch(url.toString(), { headers: { 'User-Agent': 'TRA-267/1.0' } }, options);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Coinbase ${res.status} for ${symbol} ${label} candles: ${body}`);
    }
    const rows = (await res.json()) as ReadonlyArray<CoinbaseCandleRow>;
    for (const [time, low, high, open, close, volume] of rows) {
      all.push({ symbol, timestamp: time * 1000, open, high, low, close, volume });
    }
    cursor = winEnd;
    if (cursor < toMs) await sleep(REQUEST_GAP_MS);
  }

  all.sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set<number>();
  return all.filter((c) => (seen.has(c.timestamp) ? false : (seen.add(c.timestamp), true)));
}

/** 1H bars — kept as an explicit export for the 4H aggregator. */
export async function fetchCoinbaseHourlyBars(
  symbol: string,
  fromMs: number,
  toMs: number,
  options: { timeoutMs?: number } = {},
): Promise<Candle[]> {
  return fetchCoinbaseCandles(symbol, GRANULARITY_1H, fromMs, toMs, '1h', options);
}

/**
 * TRA-300 — 1m bars. Coinbase returns the in-progress current minute, so
 * `crypto-feed.fetchCryptoMinuteBars` drops any bar whose timestamp ≥ the
 * current-minute boundary before passing into indicator math.
 */
export async function fetchCoinbaseMinuteBars(
  symbol: string,
  fromMs: number,
  toMs: number,
  options: { timeoutMs?: number } = {},
): Promise<Candle[]> {
  return fetchCoinbaseCandles(symbol, GRANULARITY_1M, fromMs, toMs, '1m', options);
}

/**
 * TRA-300 — 1D bars (UTC days). Coinbase returns the in-progress current
 * UTC day, so the live wrapper in `crypto-feed.fetchCryptoDailyBars` drops
 * any bar whose timestamp ≥ today's UTC midnight before returning.
 */
export async function fetchCoinbaseDailyBars(
  symbol: string,
  fromMs: number,
  toMs: number,
  options: { timeoutMs?: number } = {},
): Promise<Candle[]> {
  return fetchCoinbaseCandles(symbol, GRANULARITY_1D, fromMs, toMs, '1d', options);
}

/**
 * Aggregate 1H bars to 4H on UTC `00/04/08/12/16/20` boundaries. A 4H bar is
 * emitted only when all four 1H constituents are present and contiguous —
 * gaps in the 1H feed (Coinbase outages, Exchange rate-limit drops) drop the
 * partial 4H bar so downstream consumers don't see a half-built candle. Sum
 * of volumes; high/low across constituents; open from first, close from last.
 */
export function aggregate1hTo4h(hourly: ReadonlyArray<Candle>): Candle[] {
  if (hourly.length === 0) return [];
  const sorted = [...hourly].sort((a, b) => a.timestamp - b.timestamp);
  const buckets = new Map<number, Candle[]>();
  for (const bar of sorted) {
    const bucketStart = Math.floor(bar.timestamp / FOUR_HOURS_MS) * FOUR_HOURS_MS;
    const list = buckets.get(bucketStart) ?? [];
    list.push(bar);
    buckets.set(bucketStart, list);
  }

  const out: Candle[] = [];
  for (const [bucketStart, bars] of buckets) {
    if (bars.length !== 4) continue;
    bars.sort((a, b) => a.timestamp - b.timestamp);
    const expectedTimestamps = [0, 1, 2, 3].map((i) => bucketStart + i * ONE_HOUR_MS);
    const contiguous = bars.every((b, i) => b.timestamp === expectedTimestamps[i]);
    if (!contiguous) continue;
    const first = bars[0];
    const last = bars[bars.length - 1];
    out.push({
      symbol: first.symbol,
      timestamp: bucketStart,
      open: first.open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: last.close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * TRA-427 — a contiguous run of synthetic 4H bars inserted to bridge a
 * genuine Coinbase exchange data gap. `fromTimestamp`/`toTimestamp` are the
 * first and last *missing* 4H slots (inclusive); `filledBars` is the count
 * of synthetic bars used to bridge them.
 */
export interface GridGap {
  fromTimestamp: number;
  toTimestamp: number;
  filledBars: number;
}

/**
 * TRA-427 — make the 4H grid contiguous and deterministic.
 *
 * `aggregate1hTo4h` only emits a 4H bar when all four 1H constituents are
 * present and contiguous. When Coinbase itself has no 1H data for an interval
 * — verified exchange-side gaps, e.g. BTC-USD 2025-10-25 16:00–20:00 UTC and
 * 2026-05-08 00:00–04:00 UTC, where the public-candles endpoint returns no
 * rows — the affected 4H buckets are simply absent, leaving holes in the grid.
 *
 * A hole is not benign: it shifts every downstream MACD / Bollinger window by
 * one or more bars, and because the exact set of holes depends on which fetch
 * snapshot Coinbase served, two cache regenerations of the *same* history can
 * disagree. On a thin 24–35-trade OOS sample that non-determinism is enough to
 * flip the macd_bollinger edge sign (the TRA-423 §8 regression).
 *
 * This function walks the 4H grid from the first to the last real bar and
 * fills every missing slot with a synthetic **flat** bar — O=H=L=C carry the
 * prior bar's close, volume 0 — the neutral "no information" choice during an
 * exchange outage. Synthetic bars are flagged `synthetic: true` so the cache
 * audit (`verify-4h-cache.ts`) and any downstream consumer can see them. The
 * result is a gap-free, snapshot-independent grid: a regeneration tomorrow
 * produces byte-identical history for any window that ends in the past.
 *
 * Note this is forward-fill of *genuine exchange gaps only*. Transport-level
 * fetch failures (429s, timeouts) are handled separately by the breaker /
 * retry path and never reach here as gaps — a failed window aborts the fetch.
 */
export function fillGrid4h(bars: ReadonlyArray<Candle>): Candle[] {
  if (bars.length === 0) return [];
  const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp);
  const out: Candle[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    let expected = out[out.length - 1].timestamp + FOUR_HOURS_MS;
    // Bridge any missing slots between the previous real bar and `cur`.
    while (expected < cur.timestamp) {
      const last = out[out.length - 1];
      out.push({
        symbol: last.symbol,
        timestamp: expected,
        open: last.close,
        high: last.close,
        low: last.close,
        close: last.close,
        volume: 0,
        synthetic: true,
      });
      expected += FOUR_HOURS_MS;
    }
    out.push(cur);
  }
  return out;
}

/**
 * TRA-427 — collapse the synthetic bars in a gap-filled 4H series into the
 * contiguous {@link GridGap} runs they bridge. Used for fetch-time logging and
 * for the `gaps` audit field persisted into the on-disk cache entry.
 */
export function summarize4hGaps(candles: ReadonlyArray<Candle>): GridGap[] {
  const gaps: GridGap[] = [];
  let run: GridGap | null = null;
  for (const c of candles) {
    if (c.synthetic) {
      if (run && run.toTimestamp + FOUR_HOURS_MS === c.timestamp) {
        run.toTimestamp = c.timestamp;
        run.filledBars += 1;
      } else {
        if (run) gaps.push(run);
        run = { fromTimestamp: c.timestamp, toTimestamp: c.timestamp, filledBars: 1 };
      }
    }
  }
  if (run) gaps.push(run);
  return gaps;
}

/**
 * Fetch 4H OHLCV bars for `symbol` over `[fromMs, toMs)`. Internally pulls
 * 1H bars from Coinbase Exchange, aggregates to 4H — see file-header note on
 * why we don't request `granularity=14400` directly — and TRA-427 gap-fills
 * the 4H grid so the result is contiguous and snapshot-deterministic. Returns
 * the same `Candle[]` shape as the existing minute / daily helpers in
 * `crypto-feed.ts`; any bar with `synthetic: true` bridges an exchange gap.
 */
export async function fetchCoinbase4hBars(
  symbol: string,
  fromMs: number,
  toMs: number,
  options: { timeoutMs?: number } = {},
): Promise<Candle[]> {
  const hourly = await fetchCoinbaseHourlyBars(symbol, fromMs, toMs, options);
  const filled = fillGrid4h(aggregate1hTo4h(hourly));
  const gaps = summarize4hGaps(filled);
  if (gaps.length > 0) {
    const total = gaps.reduce((s, g) => s + g.filledBars, 0);
    console.warn(
      `[coinbase-feed] ${symbol} 4H: bridged ${gaps.length} exchange gap(s) with ${total} synthetic bar(s):`,
    );
    for (const g of gaps) {
      console.warn(
        `  ${new Date(g.fromTimestamp).toISOString()} … ${new Date(g.toTimestamp).toISOString()} (${g.filledBars} bar(s))`,
      );
    }
  }
  return filled;
}
