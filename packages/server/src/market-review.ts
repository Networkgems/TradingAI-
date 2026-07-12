/**
 * TRA-386 — automated pre-/post-market review.
 *
 * Background
 * ----------
 * TRA-385 ("Pre-market and Post-market review") was a Paperclip *routine*: it
 * woke the QuantTrader agent twice a day to hand-write a regime read and post
 * it to the Stocks News tab. That has two failure modes — it needs an agent
 * run every single market day, and the News-tab POST kept silently skipping
 * because the routine harness was missing `TRADING_API_BASE` / admin creds.
 *
 * This module replaces the *deterministic* core of that routine with a
 * server-side job. It pulls three index-level series from Yahoo:
 *
 *   - `^GSPC` — S&P 500, with its trend moving average (the trend filter —
 *     TRA-472: a 50-day SMA with a ±1% hysteresis band).
 *   - `^VIX`  — volatility index (breakout / mean-reversion gate).
 *   - `^TNX`  — 10-year Treasury yield (rate-pressure / sizing gate).
 *
 * …classifies a GREEN / YELLOW / RED regime per the gates QuantTrader used in
 * TRA-385, derives a set of strategy gates, and then:
 *
 *   1. Persists the structured {@link MarketReview} to `data/market-review.json`.
 *   2. Publishes a human-readable `ResearchReport` to the research store so it
 *      still shows up on the Stocks News tab — no admin creds, no HTTP hop.
 *
 * The signal engine and watchlist builder can pull the latest review via
 * {@link getLatestMarketReview} or `GET /api/market-review/latest` instead of
 * waiting on an agent.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type {
  Candle,
  MarketRegimeLabel,
  MarketReview,
  MarketReviewGates,
  MarketReviewIndexReading,
} from '@trading-app/shared';
import { fetchDailyCandles, fetchQuote, fetchTradierDailyCandles } from './yahoo-feed.js';
import { saveResearchReport } from './research-store.js';
import { isNewsCatalystEnabled } from './news-catalyst-ledger.js';
import {
  buildSessionLeanInputs,
  assembleNameLeans,
  strongestLeaders,
  renderLeanMarkdown,
} from './news-catalyst-lean.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'market-review' });

// ── Index symbols + regime thresholds (TRA-385 gates) ────────────────────────

const SPX_SYMBOL = '^GSPC';
/**
 * TRA-469 — fallback for the S&P 500 trend filter. Yahoo's `^GSPC` index
 * endpoint is flakier than its equity endpoints (and trips its own breaker),
 * which left the trend filter dark and forced a YELLOW "feed unavailable"
 * regime. `SPY` is the S&P 500 ETF: it tracks the index ~1:10, and the trend
 * gate only compares the latest close against its *own* trend MA — a
 * scale-free test — so the proxy yields an identical up/down read.
 */
const SPX_FALLBACK_SYMBOL = 'SPY';
const VIX_SYMBOL = '^VIX';
/**
 * TRA-586 — Tradier quotes the CBOE Volatility Index under the bare `VIX`
 * ticker, not Yahoo's `^VIX` index symbol. Used as the VIX proxy when the Yahoo
 * `^VIX` quote path is dark (breaker open).
 */
const VIX_TRADIER_SYMBOL = 'VIX';
const TNX_SYMBOL = '^TNX';

/**
 * Bars of S&P 500 history averaged for the trend filter.
 *
 * TRA-472 — bumped 20 → 50 per the board-approved TRA-470 recommendation
 * (approval `fd37318c`). The 20-DMA flipped the ORB regime gate too often on
 * shallow noise; the 50-day SMA + the {@link TREND_HYSTERESIS} band below cut
 * the whipsaw. Exported so the test suite stays period-agnostic.
 */
export const MA_PERIOD = 50;

/**
 * TRA-472 — ±1% hysteresis band around the trend MA. The trend read only
 * flips once price clears the band (`spx > MA·1.01` → up, `spx < MA·0.99` →
 * down); inside the band it holds the prior review's trend state. This is the
 * whipsaw damper the TRA-470 report quantified.
 */
export const TREND_HYSTERESIS = 0.01;

/**
 * Floor on the trend-history depth. The trend filter must always be
 * computable, so {@link readSpxTrend} fetches `max(MA_PERIOD, MIN_TREND_BARS)`
 * bars (+ a small margin). With `MA_PERIOD` at 50 this floor is slack, but a
 * future period bump (e.g. 200) then scales the fetch depth automatically
 * instead of silently starving the MA — the data-depth defect TRA-470 flagged.
 */
const MIN_TREND_BARS = 50;

/** Trend candles to request — scales with the period so the MA never starves. */
const TREND_FETCH_BARS = Math.max(MA_PERIOD, MIN_TREND_BARS) + 5;

/** VIX < this → trend-follow regime; at/above → mean-reversion tilt. */
const VIX_TREND_FOLLOW = 16;
/** VIX > this → high-vol: breakouts disabled, reversal-at-VWAP only. */
const VIX_NO_BREAKOUT = 22;

/** 10Y yield > this → cut tech-long sizing (rate pressure). */
const TNX_HIGH = 4.5;

const MAX_REVIEWS = 60;

// ── Store file ───────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultStoreFile(): string {
  const root = process.env.DATA_DIR ?? join(__dirname, '..', 'data');
  return join(root, 'market-review.json');
}

let storeFileOverride: string | null = null;
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

interface StoreFile {
  version: 1;
  reviews: MarketReview[];
}

let cache: MarketReview[] | null = null;

async function ensureLoaded(): Promise<MarketReview[]> {
  if (cache) return cache;
  const path = storeFile();
  if (!existsSync(path)) {
    cache = [];
    return cache;
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<StoreFile>;
    cache = Array.isArray(parsed.reviews) ? parsed.reviews : [];
  } catch (err) {
    log.error('failed to read store, starting empty', {
      reason: err instanceof Error ? err.message : String(err),
    });
    cache = [];
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const payload: StoreFile = { version: 1, reviews: cache };
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
}

// ── Pure regime logic (exported for unit tests) ──────────────────────────────

export interface RegimeInputs {
  /** Latest S&P 500 close, or `null` when the feed could not be reached. */
  spx: number | null;
  /** S&P 500 trend moving average ({@link MA_PERIOD}-day SMA), or `null`. */
  spxTrendMa: number | null;
  /** Latest VIX value, or `null`. */
  vix: number | null;
  /** 10-year Treasury yield as a percent (e.g. `4.31`), or `null`. */
  tnx: number | null;
}

/** Resolved trend read — output of {@link resolveTrend}. */
export interface TrendRead {
  /** True ↔ confirmed uptrend (price above the hysteresis band, or held up). */
  trendUp: boolean;
  /** True ↔ confirmed downtrend (price below the band, or held down). */
  trendDown: boolean;
  /** False ↔ the trend feed was dark (`spx` or the trend MA was `null`). */
  trendKnown: boolean;
}

/**
 * TRA-472 — resolve the S&P 500 trend direction with a ±1% hysteresis band.
 *
 *   - flip to **up** only when `spx > trendMa·(1 + {@link TREND_HYSTERESIS})`;
 *   - flip to **down** only when `spx < trendMa·(1 - TREND_HYSTERESIS)`;
 *   - inside the band: **hold** `prevTrendUp` (the prior review's trend state);
 *   - cold store (`prevTrendUp` null/undefined) inside the band: seed from the
 *     plain `spx >= trendMa` comparison.
 *
 * Pure so both {@link classifyMarketRegime} and {@link deriveGates} resolve an
 * identical trend, and the band is unit-testable in isolation.
 */
export function resolveTrend(
  spx: number | null,
  trendMa: number | null,
  prevTrendUp?: boolean | null,
): TrendRead {
  if (spx == null || trendMa == null) {
    return { trendUp: false, trendDown: false, trendKnown: false };
  }
  const upperBand = trendMa * (1 + TREND_HYSTERESIS);
  const lowerBand = trendMa * (1 - TREND_HYSTERESIS);
  let up: boolean;
  if (spx > upperBand) {
    up = true;
  } else if (spx < lowerBand) {
    up = false;
  } else if (prevTrendUp != null) {
    up = prevTrendUp; // inside the band — hold the prior review's state
  } else {
    up = spx >= trendMa; // cold store — seed from the plain comparison
  }
  return { trendUp: up, trendDown: !up, trendKnown: true };
}

/**
 * Yahoo's `^TNX` series has historically been quoted as the yield × 10 (a
 * "42.5" print for a 4.25% yield). Modern responses usually return the yield
 * directly. Normalise either form to a plain percent: anything above 20 is
 * assumed to be the ×10 convention.
 */
export function normalizeTnx(raw: number | null): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  return raw > 20 ? raw / 10 : raw;
}

/** Simple moving average of the last `period` closes; `null` if too short. */
export function simpleMa(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const tail = candles.slice(-period);
  return tail.reduce((sum, c) => sum + c.close, 0) / period;
}

/**
 * Classify the GREEN / YELLOW / RED regime from the index readings, applying
 * the TRA-385 gate order:
 *
 *   - RED    — S&P 500 in a downtrend **or** VIX > 22 (high vol).
 *   - YELLOW — VIX in the 16–22 band **or** 10Y yield > 4.50% (rate pressure),
 *              or the feeds were too cold to confirm a GREEN tape.
 *   - GREEN  — S&P 500 in an uptrend, VIX < 16, 10Y ≤ 4.50%.
 *
 * The trend read is resolved via {@link resolveTrend} (TRA-472: a
 * {@link MA_PERIOD}-day SMA with a ±1% hysteresis band). `prevTrendUp` carries
 * the prior review's trend state so a price inside the band holds rather than
 * flips; pass `null`/omit on a cold store.
 */
export function classifyMarketRegime(
  inputs: RegimeInputs,
  prevTrendUp?: boolean | null,
): {
  regime: MarketRegimeLabel;
  rationale: string;
} {
  const { spx, spxTrendMa, vix, tnx } = inputs;
  const { trendKnown, trendUp, trendDown } = resolveTrend(spx, spxTrendMa, prevTrendUp);
  const highVix = vix != null && vix > VIX_NO_BREAKOUT;
  const elevatedVix = vix != null && vix >= VIX_TREND_FOLLOW && vix <= VIX_NO_BREAKOUT;
  const highRates = tnx != null && tnx > TNX_HIGH;

  const reasons: string[] = [];

  if (trendDown || highVix) {
    if (trendDown) reasons.push(`S&P 500 is below its ${MA_PERIOD}-day average (downtrend)`);
    if (highVix) reasons.push(`VIX ${vix!.toFixed(1)} > ${VIX_NO_BREAKOUT} (high volatility)`);
    return { regime: 'red', rationale: reasons.join('; ') + '.' };
  }

  if (elevatedVix || highRates || !trendKnown) {
    if (elevatedVix) reasons.push(`VIX ${vix!.toFixed(1)} in the ${VIX_TREND_FOLLOW}–${VIX_NO_BREAKOUT} mean-reversion band`);
    if (highRates) reasons.push(`10Y yield ${tnx!.toFixed(2)}% > ${TNX_HIGH}% (rate pressure)`);
    if (!trendKnown) reasons.push('S&P 500 trend feed unavailable — defaulting to cautious');
    return { regime: 'yellow', rationale: reasons.join('; ') + '.' };
  }

  if (trendUp) reasons.push(`S&P 500 above its ${MA_PERIOD}-day average`);
  if (vix != null) reasons.push(`VIX ${vix.toFixed(1)} < ${VIX_TREND_FOLLOW} (trend-follow)`);
  if (tnx != null) reasons.push(`10Y yield ${tnx.toFixed(2)}% ≤ ${TNX_HIGH}%`);
  return { regime: 'green', rationale: reasons.join('; ') + '.' };
}

/**
 * Derive the deterministic strategy gates from the regime + raw readings.
 * `prevTrendUp` threads the prior review's trend state into {@link resolveTrend}
 * so the ±1% hysteresis band holds consistently with {@link classifyMarketRegime}.
 */
export function deriveGates(
  regime: MarketRegimeLabel,
  inputs: RegimeInputs,
  prevTrendUp?: boolean | null,
): MarketReviewGates {
  const { spx, spxTrendMa, vix, tnx } = inputs;
  const { trendKnown, trendUp, trendDown } = resolveTrend(spx, spxTrendMa, prevTrendUp);
  const highVix = vix != null && vix > VIX_NO_BREAKOUT;
  const elevatedVix = vix != null && vix >= VIX_TREND_FOLLOW && vix <= VIX_NO_BREAKOUT;
  const highRates = tnx != null && tnx > TNX_HIGH;

  let sizingMultiplier = regime === 'red' ? 0.5 : regime === 'yellow' ? 0.75 : 1.0;
  // 10Y above 4.50% cuts tech-long sizing by half on top of the regime scalar.
  if (highRates) sizingMultiplier = Math.min(sizingMultiplier, 0.5);

  // TRA-469 — record *why* the trend gates resolved, so the signal engine can
  // tell a real downtrend apart from a dark feed instead of always blaming a
  // downtrend when `orbLongs` is off.
  const trendState: 'up' | 'down' | 'unknown' = !trendKnown
    ? 'unknown'
    : trendUp
      ? 'up'
      : 'down';

  return {
    orbLongs: trendUp && !highVix,
    orbShorts: trendDown,
    meanReversionTilt: elevatedVix,
    breakoutsEnabled: !highVix,
    sizingMultiplier,
    trendState,
  };
}

// ── Feed reads ───────────────────────────────────────────────────────────────

/** Which upstream provider served the S&P 500 trend candles. */
export type SpxTrendProvider = 'yahoo' | 'tradier';

/** Result of resolving the S&P 500 trend series across the primary + fallback feeds. */
export interface SpxTrendSource {
  candles: Candle[];
  /** Symbol the candles actually came from (`^GSPC` or the `SPY` fallback). */
  symbol: string;
  /** True when the `^GSPC` feed was dark and `SPY` was used as a proxy. */
  viaFallback: boolean;
  /**
   * TRA-586 — provider that actually served the candles. `tradier` means both
   * Yahoo paths were dark and the non-Yahoo daily-history feed supplied the MA.
   */
  provider: SpxTrendProvider;
}

/**
 * Pick the S&P 500 trend series across the three sources, in precedence order:
 *
 *   1. `^GSPC` via Yahoo   (primary index feed)
 *   2. `SPY`  via Yahoo    (TRA-469 — ETF proxy when `^GSPC` is short)
 *   3. `SPY`  via Tradier  (TRA-586 — non-Yahoo fallback when Yahoo is dark)
 *
 * The first source with at least {@link MA_PERIOD} bars wins. When none has
 * enough history the longest series is returned so `simpleMa` still degrades to
 * `null` cleanly and the regime goes YELLOW. Pure (no I/O) so the precedence is
 * unit-testable.
 */
export function pickSpxTrendCandles(
  primary: Candle[],
  yahooFallback: Candle[],
  tradierFallback: Candle[] = [],
): SpxTrendSource {
  if (primary.length >= MA_PERIOD) {
    return { candles: primary, symbol: SPX_SYMBOL, viaFallback: false, provider: 'yahoo' };
  }
  if (yahooFallback.length >= MA_PERIOD) {
    return { candles: yahooFallback, symbol: SPX_FALLBACK_SYMBOL, viaFallback: true, provider: 'yahoo' };
  }
  if (tradierFallback.length >= MA_PERIOD) {
    return { candles: tradierFallback, symbol: SPX_FALLBACK_SYMBOL, viaFallback: true, provider: 'tradier' };
  }
  // No source has enough history — keep whichever has the most bars (preserving
  // the precedence order on ties) so `simpleMa` degrades to `null` cleanly.
  const candidates: SpxTrendSource[] = [
    { candles: primary, symbol: SPX_SYMBOL, viaFallback: false, provider: 'yahoo' },
    { candles: yahooFallback, symbol: SPX_FALLBACK_SYMBOL, viaFallback: true, provider: 'yahoo' },
    { candles: tradierFallback, symbol: SPX_FALLBACK_SYMBOL, viaFallback: true, provider: 'tradier' },
  ];
  return candidates.reduce((best, c) => (c.candles.length > best.candles.length ? c : best));
}

/**
 * Resolve the S&P 500 trend candles, cascading `^GSPC` (Yahoo) → `SPY` (Yahoo)
 * → `SPY` (Tradier). Each fallback request is only issued when the prior source
 * comes up short, so a healthy `^GSPC` read costs nothing extra and the Tradier
 * call only fires when both Yahoo paths are dark (TRA-586).
 */
async function readSpxTrend(): Promise<SpxTrendSource> {
  const primary = await fetchDailyCandles(SPX_SYMBOL, TREND_FETCH_BARS).catch(() => [] as Candle[]);
  if (primary.length >= MA_PERIOD) {
    return { candles: primary, symbol: SPX_SYMBOL, viaFallback: false, provider: 'yahoo' };
  }
  const yahooFallback = await fetchDailyCandles(SPX_FALLBACK_SYMBOL, TREND_FETCH_BARS).catch(
    () => [] as Candle[],
  );
  if (yahooFallback.length >= MA_PERIOD) {
    return { candles: yahooFallback, symbol: SPX_FALLBACK_SYMBOL, viaFallback: true, provider: 'yahoo' };
  }
  // TRA-586 — both Yahoo daily paths are dark (breaker open). Reach for the
  // Tradier `/markets/history` feed that already powers /api/health/quotes.
  const tradierFallback = await fetchTradierDailyCandles(SPX_FALLBACK_SYMBOL, TREND_FETCH_BARS).catch(
    () => [] as Candle[],
  );
  const picked = pickSpxTrendCandles(primary, yahooFallback, tradierFallback);
  if (picked.viaFallback) {
    log.warn('^GSPC trend feed dark — using SPY proxy', {
      provider: picked.provider,
      primaryBars: primary.length,
      yahooFallbackBars: yahooFallback.length,
      tradierFallbackBars: tradierFallback.length,
    });
  }
  return picked;
}

/**
 * TRA-586 — resolve the VIX level. Tries the Yahoo `^VIX` quote first; when that
 * is dark, falls back to the Tradier `VIX` quote (Tradier tickers the index
 * without the `^` prefix). Returns `null` only when every provider is cold.
 */
async function readVix(): Promise<number | null> {
  const primary = await fetchQuote(VIX_SYMBOL).catch(() => null);
  if (primary?.price != null) return primary.price;
  const tradier = await fetchQuote(VIX_TRADIER_SYMBOL).catch(() => null);
  return tradier?.price ?? null;
}

/**
 * Pull the three index readings. Each leg degrades to `null` independently.
 * `prevTrendUp` carries the prior review's trend state so the S&P 500 note
 * reflects the same ±1% hysteresis-banded read the gates use.
 */
async function readIndexes(prevTrendUp?: boolean | null): Promise<{
  inputs: RegimeInputs;
  readings: MarketReviewIndexReading[];
  /** TRA-586 — the resolved S&P 500 trend source (provider / fallback flags). */
  spxTrend: SpxTrendSource;
}> {
  const [spxTrend, vix, tnxQuote] = await Promise.all([
    readSpxTrend(),
    readVix(),
    fetchQuote(TNX_SYMBOL).catch(() => null),
  ]);

  const spxCandles = spxTrend.candles;
  const spx = spxCandles.length > 0 ? spxCandles[spxCandles.length - 1].close : null;
  const spxTrendMa = simpleMa(spxCandles, MA_PERIOD);
  const tnx = normalizeTnx(tnxQuote?.price ?? null);

  const inputs: RegimeInputs = { spx, spxTrendMa, vix, tnx };

  const spxProxyNote = spxTrend.viaFallback
    ? spxTrend.provider === 'tradier'
      ? ' (via SPY/Tradier proxy — Yahoo ^GSPC + SPY feed down)'
      : ' (via SPY proxy — ^GSPC feed down)'
    : '';
  const trend = resolveTrend(spx, spxTrendMa, prevTrendUp);
  const maLabel = `${MA_PERIOD}-DMA`;
  const spxNote = !trend.trendKnown
    ? 'Feed unavailable — trend filter cannot be confirmed (^GSPC, SPY/Yahoo and SPY/Tradier all unreachable).'
    : trend.trendUp
      ? `Above ${maLabel} (${spxTrendMa!.toFixed(2)}, ±1% band) — uptrend, ORB longs enabled.${spxProxyNote}`
      : `Below ${maLabel} (${spxTrendMa!.toFixed(2)}, ±1% band) — downtrend, ORB longs OFF.${spxProxyNote}`;
  const vixNote =
    vix == null
      ? 'Feed unavailable.'
      : vix < VIX_TREND_FOLLOW
        ? `< ${VIX_TREND_FOLLOW} — trend-follow regime.`
        : vix <= VIX_NO_BREAKOUT
          ? `${VIX_TREND_FOLLOW}–${VIX_NO_BREAKOUT} — mean-reversion tilt.`
          : `> ${VIX_NO_BREAKOUT} — breakouts disabled, reversal-at-VWAP only.`;
  const tnxNote =
    tnx == null
      ? 'Feed unavailable.'
      : tnx > TNX_HIGH
        ? `> ${TNX_HIGH}% — cut tech-long sizing 50%.`
        : `≤ ${TNX_HIGH}% — no rate-driven sizing cut.`;

  const readings: MarketReviewIndexReading[] = [
    { symbol: spxTrend.symbol, label: 'S&P 500', value: spx, trendMa: spxTrendMa, note: spxNote },
    { symbol: VIX_SYMBOL, label: 'VIX', value: vix, trendMa: null, note: vixNote },
    { symbol: TNX_SYMBOL, label: '10Y Yield', value: tnx, trendMa: null, note: tnxNote },
  ];

  return { inputs, readings, spxTrend };
}

// ── Markdown rendering ───────────────────────────────────────────────────────

function fmt(v: number | null, digits = 2): string {
  return v == null ? '—' : v.toFixed(digits);
}

const REGIME_HEADLINE: Record<MarketRegimeLabel, string> = {
  green: '🟢 GREEN — trend-follow tape, full sizing',
  yellow: '🟡 YELLOW — mixed tape, trimmed sizing',
  red: '🔴 RED — defensive: downtrend and/or high volatility',
};

function renderMarkdown(review: MarketReview): string {
  const { kind, date, regime, regimeRationale, indexes, gates } = review;
  const kindLabel = kind === 'premarket' ? 'Pre-Market' : 'Post-Market';
  const lines: string[] = [];

  lines.push(`# ${kindLabel} Review — ${date}`);
  lines.push('');
  lines.push(`> Auto-generated by the TRA-386 market-review job (replaces the`);
  lines.push(`> hand-written TRA-385 routine). Deterministic regime read from`);
  lines.push(`> \`^GSPC\` / \`^VIX\` / \`^TNX\`.`);
  lines.push('');
  lines.push(`## Regime: ${REGIME_HEADLINE[regime]}`);
  lines.push('');
  lines.push(regimeRationale);
  lines.push('');
  lines.push('## Index readings');
  lines.push('');
  lines.push(`| Index | Value | ${MA_PERIOD}-DMA | Read |`);
  lines.push('|---|---|---|---|');
  for (const r of indexes) {
    lines.push(`| ${r.label} | ${fmt(r.value)} | ${fmt(r.trendMa)} | ${r.note} |`);
  }
  lines.push('');
  lines.push('## Strategy gates');
  lines.push('');
  lines.push(`- **ORB longs:** ${gates.orbLongs ? 'enabled' : 'OFF'}`);
  lines.push(`- **ORB shorts:** ${gates.orbShorts ? 'enabled' : 'OFF'}`);
  lines.push(`- **Mean-reversion tilt:** ${gates.meanReversionTilt ? 'on' : 'off'}`);
  lines.push(`- **Breakouts:** ${gates.breakoutsEnabled ? 'enabled' : 'OFF (high vol)'}`);
  lines.push(`- **Position-size multiplier:** ${gates.sizingMultiplier.toFixed(2)}×`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    `_Generated ${review.generatedAt}. Pull the structured form from \`GET /api/market-review/latest\`._`,
  );
  return lines.join('\n');
}

// ── ET date helper ───────────────────────────────────────────────────────────

function etDate(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * TRA-472 — map a persisted review's `trendState` gate into the `prevTrendUp`
 * the hysteresis band consumes: `'up'` → true, `'down'` → false, and
 * `'unknown'`/absent → `null` (cold-store seed via the plain comparison).
 */
function trendStateToPrev(
  state: 'up' | 'down' | 'unknown' | undefined,
): boolean | null {
  return state === 'up' ? true : state === 'down' ? false : null;
}

/**
 * The most-recent persisted review's trend state, mapped to the `prevTrendUp`
 * the ±1% hysteresis band consumes. Read-only — used by both the persisting
 * {@link generateMarketReview} and the read-only {@link peekMarketRegime}.
 */
async function latestPrevTrendUp(): Promise<boolean | null> {
  const persisted = await ensureLoaded();
  const latestPrior =
    persisted.length > 0
      ? persisted.reduce((a, b) => (b.generatedAt > a.generatedAt ? b : a))
      : null;
  return trendStateToPrev(latestPrior?.gates.trendState);
}

/**
 * TRA-586 — redacted, read-only snapshot of the *current* regime computed from
 * the live feeds, without persisting or publishing anything. Backs the
 * unauthenticated `GET /api/health/market-review` acceptance probe so the
 * Tradier trend fallback can be verified against the live tape without admin
 * creds (parity with the TRA-580 `/api/health/live-equity` probe). All fields
 * are public market data — index levels, the regime label, and which provider
 * served the S&P 500 trend MA.
 */
export interface MarketRegimePeek {
  generatedAt: string;
  regime: MarketRegimeLabel;
  regimeRationale: string;
  indexes: MarketReviewIndexReading[];
  gates: MarketReviewGates;
  /** Provider that served the S&P 500 trend MA, or `null` when every feed was dark. */
  spxTrendProvider: SpxTrendProvider | null;
  /** True when a `SPY` proxy stood in for a dark `^GSPC` feed. */
  spxTrendViaFallback: boolean;
}

/**
 * Compute the current regime from the live index feeds without touching the
 * store. Reads the persisted latest review only to thread `prevTrendUp` into the
 * hysteresis band. Never persists, never publishes.
 */
export async function peekMarketRegime(): Promise<MarketRegimePeek> {
  const prevTrendUp = await latestPrevTrendUp();
  const { inputs, readings, spxTrend } = await readIndexes(prevTrendUp);
  const { regime, rationale } = classifyMarketRegime(inputs, prevTrendUp);
  const gates = deriveGates(regime, inputs, prevTrendUp);
  return {
    generatedAt: new Date().toISOString(),
    regime,
    regimeRationale: rationale,
    indexes: readings,
    gates,
    spxTrendProvider: inputs.spx == null ? null : spxTrend.provider,
    spxTrendViaFallback: spxTrend.viaFallback,
  };
}

/**
 * Generate a market review for `kind`, persist it, and publish a matching
 * `ResearchReport` to the Stocks News tab. Idempotent per ET date + kind:
 * a same-day re-run upserts both the review and the research report in place.
 *
 * Never throws — feed failures degrade to a YELLOW "feeds unavailable" review
 * so the scheduler hook can't crash the process.
 */
export async function generateMarketReview(
  kind: 'premarket' | 'postmarket',
): Promise<MarketReview> {
  const now = new Date();
  const date = etDate(now);

  // TRA-472 — thread the most-recent persisted review's trend state into the
  // ±1% hysteresis band so a price inside the band holds rather than flips.
  // On a cold store this is `null` and `resolveTrend` seeds from `spx ≥ MA`.
  const prevTrendUp = await latestPrevTrendUp();

  let inputs: RegimeInputs = { spx: null, spxTrendMa: null, vix: null, tnx: null };
  let readings: MarketReviewIndexReading[] = [];
  try {
    const read = await readIndexes(prevTrendUp);
    inputs = read.inputs;
    readings = read.readings;
  } catch (err) {
    log.error('index feed read failed', {
      kind,
      date,
      reason: err instanceof Error ? err.message : String(err),
    });
    readings = [
      { symbol: SPX_SYMBOL, label: 'S&P 500', value: null, trendMa: null, note: 'Feed unavailable.' },
      { symbol: VIX_SYMBOL, label: 'VIX', value: null, trendMa: null, note: 'Feed unavailable.' },
      { symbol: TNX_SYMBOL, label: '10Y Yield', value: null, trendMa: null, note: 'Feed unavailable.' },
    ];
  }

  const { regime, rationale } = classifyMarketRegime(inputs, prevTrendUp);
  const gates = deriveGates(regime, inputs, prevTrendUp);

  const review: MarketReview = {
    id: `${kind}-${date}`,
    kind,
    date,
    generatedAt: now.toISOString(),
    regime,
    regimeRationale: rationale,
    indexes: readings,
    gates,
    source: 'auto',
    // TRA-950 — structured block alongside the regime. The auto review reuses
    // the existing classification for `regimeLabel` (never recomputed) and
    // derives a deterministic weekend gap flag; the leader list / invalidation
    // levels stay empty (those come from a QuantTrader review, not the feed).
    reviewBlock: {
      leaders: [],
      invalidationLevels: {},
      gapRisk: computeWeekendGapRisk(now),
      regimeLabel: regime,
    },
  };

  // TRA-1629 (TRA-1623A) — D2 calls-vs-puts per-name lean. Flag-gated (default
  // OFF): when off this whole block is skipped and the review is byte-identical
  // to the pre-TRA-1629 index-only output. OBSERVE-ONLY — the lean annotates the
  // report body + seeds `reviewBlock.leaders`; it routes no order, sizes nothing,
  // touches no exit. Never throws: a lean-build failure degrades to no section.
  let leanMarkdown = '';
  if (isNewsCatalystEnabled()) {
    try {
      const leanInputs = await buildSessionLeanInputs(gates.trendState ?? 'unknown', now.getTime());
      const leans = assembleNameLeans(leanInputs);
      if (leans.length > 0 && review.reviewBlock) {
        review.reviewBlock.leaders = strongestLeaders(leans);
        leanMarkdown = `\n\n${renderLeanMarkdown(leans)}`;
      }
    } catch (err) {
      log.error('news-catalyst lean enrichment failed', {
        reviewId: review.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Persist the structured review (upsert by id).
  const all = await ensureLoaded();
  const idx = all.findIndex(r => r.id === review.id);
  if (idx >= 0) all[idx] = review;
  else all.push(review);
  all.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  if (all.length > MAX_REVIEWS) all.length = MAX_REVIEWS;
  cache = all;
  await persist();

  // Publish the human-readable form to the News-tab research store. This is a
  // direct in-process call — no admin token / HTTP hop, which is exactly the
  // creds gap that kept the old TRA-385 routine from posting.
  const kindLabel = kind === 'premarket' ? 'Pre-Market' : 'Post-Market';
  try {
    await saveResearchReport({
      id: `${kind}-${date}`,
      kind,
      title: `${kindLabel} Review — ${date} (auto)`,
      bodyMarkdown: renderMarkdown(review) + leanMarkdown,
      publishedAt: review.generatedAt,
      tickers: [SPX_SYMBOL, VIX_SYMBOL, TNX_SYMBOL],
    });
  } catch (err) {
    log.error('failed to publish research report', {
      reviewId: review.id,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('market review generated', {
    kind,
    date,
    regime,
    spx: fmt(inputs.spx),
    trendMa: fmt(inputs.spxTrendMa),
    vix: fmt(inputs.vix),
    tnx: fmt(inputs.tnx),
    sizingMultiplier: gates.sizingMultiplier,
  });

  return review;
}

/** All persisted reviews, newest-first. */
export async function listMarketReviews(): Promise<MarketReview[]> {
  const all = await ensureLoaded();
  return [...all].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

/**
 * Latest persisted review. Pass `kind` to scope to pre- or post-market;
 * omit it for the most recent review of either kind. Returns `null` before
 * the first scheduler fire of the process's lifetime.
 */
export async function getLatestMarketReview(
  kind?: 'premarket' | 'postmarket',
): Promise<MarketReview | null> {
  const all = await listMarketReviews();
  const match = kind ? all.find(r => r.kind === kind) : all[0];
  return match ?? null;
}

/**
 * TRA-589 — pick the review kind to (re)generate for an off-schedule run. The
 * scheduled jobs fire pre-market (9 AM ET) and post-market (9 PM ET); an
 * on-boot or stale-recompute run picks the kind that matches the current ET
 * session — pre-market through the trading day, post-market once the cash
 * session has closed (≥ 16:00 ET).
 */
export function defaultReviewKind(now: Date = new Date()): 'premarket' | 'postmarket' {
  const hour = Number(
    now.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    }),
  );
  // `hour` is 0–24 (some runtimes print "24" at midnight); treat the cash-close
  // boundary (16:00 ET) onward as post-market.
  return Number.isFinite(hour) && hour >= 16 && hour < 24 ? 'postmarket' : 'premarket';
}

/**
 * TRA-950 — deterministic weekend-gap proxy for the auto review's structured
 * block. The auto path has no holiday calendar, so it flags the one gap it can
 * derive without one: a Friday review faces a closed Sat/Sun before the next
 * cash session. A QuantTrader review that knows about a holiday / scheduled
 * event can publish a richer `gapRisk` via `/api/research/reports`.
 */
export function computeWeekendGapRisk(now: Date = new Date()): boolean {
  const weekday = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return weekday === 'Fri';
}

/**
 * TRA-589 — a persisted review is *stale* when it can no longer be trusted to
 * describe the current tape:
 *
 *   - there is no review yet (cold store), or
 *   - it predates the current ET trading session (`date` ≠ today ET), or
 *   - it was produced from a dark trend feed (`trendState` unknown/absent).
 *
 * The last case is the TRA-589 bug: a deploy can repair the feed (the Tradier
 * fallback now resolves a real regime) while the banner keeps rendering the last
 * persisted YELLOW "feed unavailable" review until the next scheduled job. A
 * stale review is recomputed live before it is served.
 */
export function isReviewStale(
  review: MarketReview | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!review) return true;
  if (review.date !== etDate(now)) return true;
  const trendState = review.gates.trendState;
  return trendState == null || trendState === 'unknown';
}

/**
 * TRA-589 — the review the dashboard banner reads. Returns the latest persisted
 * review when it is current, otherwise recomputes it live (and persists +
 * republishes it) before serving, so a deploy that repairs a dark feed reflects
 * immediately instead of waiting for the next scheduled review job. Reuses the
 * live-compute path of {@link generateMarketReview} rather than duplicating the
 * regime logic; on a recompute failure it falls back to the stale review (or
 * `null`) rather than erroring.
 */
export async function getFreshMarketReview(
  kind?: 'premarket' | 'postmarket',
  now: Date = new Date(),
): Promise<MarketReview | null> {
  const persisted = await getLatestMarketReview(kind);
  if (!isReviewStale(persisted, now)) return persisted;
  const refreshKind = kind ?? persisted?.kind ?? defaultReviewKind(now);
  try {
    return await generateMarketReview(refreshKind);
  } catch (err) {
    log.error('stale market-review live recompute failed', {
      refreshKind,
      reason: err instanceof Error ? err.message : String(err),
    });
    return persisted ?? null;
  }
}

/** Test-only: reset the in-memory cache and optionally override the store path. */
export function __resetMarketReviewStoreForTests(overridePath?: string | null): void {
  cache = null;
  storeFileOverride = overridePath ?? null;
}
