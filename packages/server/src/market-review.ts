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
 *   - `^GSPC` — S&P 500, with its 20-day moving average (the trend filter).
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
import { fetchDailyCandles, fetchQuote } from './yahoo-feed.js';
import { saveResearchReport } from './research-store.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'market-review' });

// ── Index symbols + regime thresholds (TRA-385 gates) ────────────────────────

const SPX_SYMBOL = '^GSPC';
/**
 * TRA-469 — fallback for the S&P 500 trend filter. Yahoo's `^GSPC` index
 * endpoint is flakier than its equity endpoints (and trips its own breaker),
 * which left the trend filter dark and forced a YELLOW "feed unavailable"
 * regime. `SPY` is the S&P 500 ETF: it tracks the index ~1:10, and the trend
 * gate only compares the latest close against its *own* 20-DMA — a scale-free
 * test — so the proxy yields an identical up/down read.
 */
const SPX_FALLBACK_SYMBOL = 'SPY';
const VIX_SYMBOL = '^VIX';
const TNX_SYMBOL = '^TNX';

/** Bars of S&P 500 history averaged for the trend filter. */
const MA_PERIOD = 20;

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
  /** S&P 500 20-day moving average, or `null`. */
  spxMa20: number | null;
  /** Latest VIX value, or `null`. */
  vix: number | null;
  /** 10-year Treasury yield as a percent (e.g. `4.31`), or `null`. */
  tnx: number | null;
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
 *   - RED    — S&P 500 below its 20-DMA (downtrend) **or** VIX > 22 (high vol).
 *   - YELLOW — VIX in the 16–22 band **or** 10Y yield > 4.50% (rate pressure),
 *              or the feeds were too cold to confirm a GREEN tape.
 *   - GREEN  — S&P 500 above its 20-DMA, VIX < 16, 10Y ≤ 4.50%.
 */
export function classifyMarketRegime(inputs: RegimeInputs): {
  regime: MarketRegimeLabel;
  rationale: string;
} {
  const { spx, spxMa20, vix, tnx } = inputs;
  const trendKnown = spx != null && spxMa20 != null;
  const trendDown = trendKnown && spx! < spxMa20!;
  const trendUp = trendKnown && spx! >= spxMa20!;
  const highVix = vix != null && vix > VIX_NO_BREAKOUT;
  const elevatedVix = vix != null && vix >= VIX_TREND_FOLLOW && vix <= VIX_NO_BREAKOUT;
  const highRates = tnx != null && tnx > TNX_HIGH;

  const reasons: string[] = [];

  if (trendDown || highVix) {
    if (trendDown) reasons.push('S&P 500 is below its 20-day average (downtrend)');
    if (highVix) reasons.push(`VIX ${vix!.toFixed(1)} > ${VIX_NO_BREAKOUT} (high volatility)`);
    return { regime: 'red', rationale: reasons.join('; ') + '.' };
  }

  if (elevatedVix || highRates || !trendKnown) {
    if (elevatedVix) reasons.push(`VIX ${vix!.toFixed(1)} in the ${VIX_TREND_FOLLOW}–${VIX_NO_BREAKOUT} mean-reversion band`);
    if (highRates) reasons.push(`10Y yield ${tnx!.toFixed(2)}% > ${TNX_HIGH}% (rate pressure)`);
    if (!trendKnown) reasons.push('S&P 500 trend feed unavailable — defaulting to cautious');
    return { regime: 'yellow', rationale: reasons.join('; ') + '.' };
  }

  if (trendUp) reasons.push('S&P 500 above its 20-day average');
  if (vix != null) reasons.push(`VIX ${vix.toFixed(1)} < ${VIX_TREND_FOLLOW} (trend-follow)`);
  if (tnx != null) reasons.push(`10Y yield ${tnx.toFixed(2)}% ≤ ${TNX_HIGH}%`);
  return { regime: 'green', rationale: reasons.join('; ') + '.' };
}

/** Derive the deterministic strategy gates from the regime + raw readings. */
export function deriveGates(regime: MarketRegimeLabel, inputs: RegimeInputs): MarketReviewGates {
  const { spx, spxMa20, vix, tnx } = inputs;
  const trendKnown = spx != null && spxMa20 != null;
  const trendUp = trendKnown && spx! >= spxMa20!;
  const trendDown = trendKnown && spx! < spxMa20!;
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

/** Result of resolving the S&P 500 trend series across the primary + fallback feeds. */
export interface SpxTrendSource {
  candles: Candle[];
  /** Symbol the candles actually came from (`^GSPC` or the `SPY` fallback). */
  symbol: string;
  /** True when the `^GSPC` feed was dark and `SPY` was used as a proxy. */
  viaFallback: boolean;
}

/**
 * TRA-469 — pick the S&P 500 trend series. Prefers the `^GSPC` primary feed;
 * uses the `SPY` proxy when `^GSPC` returns too few bars to compute the
 * 20-DMA. Pure (no I/O) so the fallback precedence is unit-testable.
 */
export function pickSpxTrendCandles(primary: Candle[], fallback: Candle[]): SpxTrendSource {
  if (primary.length >= MA_PERIOD) {
    return { candles: primary, symbol: SPX_SYMBOL, viaFallback: false };
  }
  if (fallback.length >= MA_PERIOD) {
    return { candles: fallback, symbol: SPX_FALLBACK_SYMBOL, viaFallback: true };
  }
  // Neither feed has enough history — keep whichever has more bars so
  // `simpleMa` still degrades to `null` cleanly and the regime goes YELLOW.
  return primary.length >= fallback.length
    ? { candles: primary, symbol: SPX_SYMBOL, viaFallback: false }
    : { candles: fallback, symbol: SPX_FALLBACK_SYMBOL, viaFallback: true };
}

/**
 * Resolve the S&P 500 trend candles, falling back from `^GSPC` to `SPY` when
 * the primary index feed is dark. The `SPY` request is only issued when the
 * primary comes up short, so a healthy `^GSPC` read costs nothing extra.
 */
async function readSpxTrend(): Promise<SpxTrendSource> {
  const primary = await fetchDailyCandles(SPX_SYMBOL, MA_PERIOD + 5).catch(() => [] as Candle[]);
  if (primary.length >= MA_PERIOD) {
    return { candles: primary, symbol: SPX_SYMBOL, viaFallback: false };
  }
  const fallback = await fetchDailyCandles(SPX_FALLBACK_SYMBOL, MA_PERIOD + 5).catch(
    () => [] as Candle[],
  );
  const picked = pickSpxTrendCandles(primary, fallback);
  if (picked.viaFallback) {
    log.warn('^GSPC trend feed dark — using SPY proxy', {
      primaryBars: primary.length,
      fallbackBars: fallback.length,
    });
  }
  return picked;
}

/** Pull the three index readings. Each leg degrades to `null` independently. */
async function readIndexes(): Promise<{
  inputs: RegimeInputs;
  readings: MarketReviewIndexReading[];
}> {
  const [spxTrend, vixQuote, tnxQuote] = await Promise.all([
    readSpxTrend(),
    fetchQuote(VIX_SYMBOL).catch(() => null),
    fetchQuote(TNX_SYMBOL).catch(() => null),
  ]);

  const spxCandles = spxTrend.candles;
  const spx = spxCandles.length > 0 ? spxCandles[spxCandles.length - 1].close : null;
  const spxMa20 = simpleMa(spxCandles, MA_PERIOD);
  const vix = vixQuote?.price ?? null;
  const tnx = normalizeTnx(tnxQuote?.price ?? null);

  const inputs: RegimeInputs = { spx, spxMa20, vix, tnx };

  const spxProxyNote = spxTrend.viaFallback ? ' (via SPY proxy — ^GSPC feed down)' : '';
  const spxNote =
    spx == null || spxMa20 == null
      ? 'Feed unavailable — trend filter cannot be confirmed (^GSPC and SPY both unreachable).'
      : spx >= spxMa20
        ? `Above 20-DMA (${spxMa20.toFixed(2)}) — uptrend, ORB longs enabled.${spxProxyNote}`
        : `Below 20-DMA (${spxMa20.toFixed(2)}) — downtrend, ORB longs OFF.${spxProxyNote}`;
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
    { symbol: spxTrend.symbol, label: 'S&P 500', value: spx, ma20: spxMa20, note: spxNote },
    { symbol: VIX_SYMBOL, label: 'VIX', value: vix, ma20: null, note: vixNote },
    { symbol: TNX_SYMBOL, label: '10Y Yield', value: tnx, ma20: null, note: tnxNote },
  ];

  return { inputs, readings };
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
  lines.push('| Index | Value | 20-DMA | Read |');
  lines.push('|---|---|---|---|');
  for (const r of indexes) {
    lines.push(`| ${r.label} | ${fmt(r.value)} | ${fmt(r.ma20)} | ${r.note} |`);
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

  let inputs: RegimeInputs = { spx: null, spxMa20: null, vix: null, tnx: null };
  let readings: MarketReviewIndexReading[] = [];
  try {
    const read = await readIndexes();
    inputs = read.inputs;
    readings = read.readings;
  } catch (err) {
    log.error('index feed read failed', {
      kind,
      date,
      reason: err instanceof Error ? err.message : String(err),
    });
    readings = [
      { symbol: SPX_SYMBOL, label: 'S&P 500', value: null, ma20: null, note: 'Feed unavailable.' },
      { symbol: VIX_SYMBOL, label: 'VIX', value: null, ma20: null, note: 'Feed unavailable.' },
      { symbol: TNX_SYMBOL, label: '10Y Yield', value: null, ma20: null, note: 'Feed unavailable.' },
    ];
  }

  const { regime, rationale } = classifyMarketRegime(inputs);
  const gates = deriveGates(regime, inputs);

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
  };

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
      bodyMarkdown: renderMarkdown(review),
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
    ma20: fmt(inputs.spxMa20),
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

/** Test-only: reset the in-memory cache and optionally override the store path. */
export function __resetMarketReviewStoreForTests(overridePath?: string | null): void {
  cache = null;
  storeFileOverride = overridePath ?? null;
}
