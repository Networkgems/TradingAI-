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
 * server-side job. It pulls four index-level series from Yahoo:
 *
 *   - `^GSPC` — S&P 500, with its trend moving average (the trend filter —
 *     TRA-472: a 50-day SMA with a ±1% hysteresis band).
 *   - `^NDX`  — Nasdaq 100, the second leg of the trend filter (TRA-2197). The
 *     gate takes the WEAKER of the two indices: the engine's equity universe is
 *     mega-cap-tech dominated, so grading `^GSPC` alone let a 2026-07-23 tape
 *     with ^NDX 3.67% under its 50-DMA still enable ORB longs.
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
  MarketReviewTrendComponent,
} from '@trading-app/shared';
import { fetchDailyCandles, fetchQuote, fetchTradierDailyCandles } from './yahoo-feed.js';
import { saveResearchReport } from './research-store.js';
import { isNewsCatalystEnabled } from './news-catalyst-ledger.js';
import {
  buildSessionLeanInputs,
  assembleNameLeans,
  strongestLeaders,
  type NameLean,
} from './news-catalyst-lean.js';
import { recordCatalystLean } from './news-catalyst-lean-ledger.js';
import { readAnalystPlan } from './analyst-agent.js';
import { simpleMa } from './ma-utils.js';
import {
  renderWatchlistLevelsSection,
  renderSentimentTapeSection,
  renderCallPutLeanSection,
  loadLatestSentimentSnapshot,
} from './market-review-enrichment.js';
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
/**
 * TRA-2197 — second leg of the trend gate. The engine's equity universe is
 * mega-cap-tech / semi dominated, so its real benchmark behaves like the
 * Nasdaq 100, not the S&P 500. Grading `^GSPC` alone let a tape where ^NDX
 * closed 3.67% under its own 50-DMA (2026-07-23) still print `trendState: up`
 * and enable ORB longs. The composite gates on the WEAKER of the two.
 */
const NDX_SYMBOL = '^NDX';
/** ETF proxy for `^NDX`, same role `SPY` plays for `^GSPC` (TRA-469 pattern). */
const NDX_FALLBACK_SYMBOL = 'QQQ';
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
  /**
   * TRA-2197 — latest Nasdaq 100 close, or `null`. Optional so every existing
   * caller/test that only supplies the S&P leg keeps its exact behaviour: with
   * `ndx` absent the composite folds to the single readable leg.
   */
  ndx?: number | null;
  /** TRA-2197 — Nasdaq 100 trend MA ({@link MA_PERIOD}-day SMA), or `null`. */
  ndxTrendMa?: number | null;
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
  /**
   * TRA-2197 — signed distance of price from the MA as a FRACTION
   * (`-0.0085` ↔ 0.85% below). `null` when the feed was dark. This is the
   * number the note must quote: the old note asserted "Above 50-DMA" off
   * `trendUp` alone, which is true of the STATE and false of the PRICE
   * whenever the band is doing the holding.
   */
  distancePct: number | null;
  /**
   * TRA-2197 — true ↔ price sits INSIDE the ±band, so the returned state is
   * carried by tolerance rather than confirmed by price.
   */
  heldByTolerance: boolean;
  /**
   * TRA-2197 — true ↔ price cleared the upper band but the dwell lock refused
   * the flip because a `→ down` transition already committed this session.
   */
  upFlipSuppressed: boolean;
}

/**
 * TRA-2197 — the dwell lock for one trend leg. A `→ up` (permissive) flip is
 * refused while `downFlipDate` equals `sessionDate`; a `→ down` (restrictive)
 * flip is NEVER blocked. The asymmetry is deliberate: the property the desk
 * asked for is "the state cannot flip twice in one session", and where a
 * second flip is unavoidable it must land on the safe side.
 */
export interface TrendDwell {
  /** ET date of this leg's most recent committed `up → down` transition. */
  downFlipDate?: string | null;
  /** Current ET session date. Omit to disable the lock entirely. */
  sessionDate?: string | null;
}

/**
 * TRA-472 / TRA-2197 — resolve one index's trend direction with a ±1%
 * hysteresis band plus a same-session dwell lock.
 *
 *   - flip to **down** whenever `px < trendMa·(1 - {@link TREND_HYSTERESIS})`
 *     — always immediate, never blocked (restrictive direction);
 *   - flip to **up** when `px > trendMa·(1 + TREND_HYSTERESIS)`, *unless* the
 *     dwell lock is engaged (a `→ down` flip already committed this session),
 *     in which case the leg holds `down` and reports `upFlipSuppressed`;
 *   - inside the band: **hold** `prevTrendUp` (the prior review's state);
 *   - cold store (`prevTrendUp` null/undefined) inside the band: seed from the
 *     plain `px >= trendMa` comparison.
 *
 * Note what the band already guarantees on its own, and what it does not. The
 * band is a genuine dead-zone in both directions — a price oscillating around
 * the −1% floor cannot toggle `up → down → up`, because re-entry to `up`
 * requires clearing `+1%`, a ~2% move. What it does NOT stop is a leg that
 * flips down early in a session and back up after a violent intraday reversal;
 * the dwell lock closes that, and it is also the property the regression test
 * pins.
 *
 * Pure so {@link classifyMarketRegime}, {@link deriveGates} and the rendered
 * note all resolve an identical trend, and the band is unit-testable alone.
 */
export function resolveTrend(
  px: number | null,
  trendMa: number | null,
  prevTrendUp?: boolean | null,
  dwell?: TrendDwell | null,
): TrendRead {
  if (px == null || trendMa == null || !Number.isFinite(px) || !Number.isFinite(trendMa) || trendMa === 0) {
    return {
      trendUp: false,
      trendDown: false,
      trendKnown: false,
      distancePct: null,
      heldByTolerance: false,
      upFlipSuppressed: false,
    };
  }
  const upperBand = trendMa * (1 + TREND_HYSTERESIS);
  const lowerBand = trendMa * (1 - TREND_HYSTERESIS);
  const distancePct = px / trendMa - 1;
  // The dwell lock is engaged only when a `→ down` flip committed in THIS ET
  // session. A stale `downFlipDate` from an earlier session never matches, so
  // the lock releases on its own at the session boundary — no expiry sweep.
  const dwellLocked =
    dwell?.sessionDate != null && dwell.downFlipDate != null && dwell.downFlipDate === dwell.sessionDate;

  let up: boolean;
  let heldByTolerance = false;
  let upFlipSuppressed = false;
  if (px < lowerBand) {
    up = false; // restrictive — always immediate
  } else if (px > upperBand) {
    if (dwellLocked && prevTrendUp === false) {
      up = false;
      upFlipSuppressed = true;
    } else {
      up = true;
    }
  } else if (prevTrendUp != null) {
    up = prevTrendUp; // inside the band — hold the prior review's state
    heldByTolerance = true;
  } else {
    up = px >= trendMa; // cold store — seed from the plain comparison
    heldByTolerance = true;
  }
  return { trendUp: up, trendDown: !up, trendKnown: true, distancePct, heldByTolerance, upFlipSuppressed };
}

// ── TRA-2197 — composite (multi-index) trend gate ────────────────────────────

/**
 * Prior trend state threaded from the last persisted review, keyed on the
 * CANONICAL index symbol (`^GSPC` / `^NDX`) — never the ETF proxy, so a day
 * served by `SPY`/`QQQ` does not lose the leg's state.
 */
export interface TrendMemory {
  states?: Record<string, 'up' | 'down' | 'unknown'>;
  /** ET date of each leg's most recent committed `up → down` transition. */
  downFlipDates?: Record<string, string | null>;
  /** Current ET session date — the dwell window. Omit to disable the lock. */
  sessionDate?: string | null;
}

/**
 * Back-compat shim. Callers (and the pre-TRA-2197 test suite) may pass a bare
 * `prevTrendUp` boolean meaning "the prior S&P leg's state, no NDX memory, no
 * dwell lock". Normalise both shapes into a {@link TrendMemory}.
 */
export type TrendMemoryInput = boolean | null | undefined | TrendMemory;

function toTrendMemory(input: TrendMemoryInput): TrendMemory {
  if (input == null) return {};
  if (typeof input === 'boolean') return { states: { [SPX_SYMBOL]: input ? 'up' : 'down' } };
  return input;
}

/** The trend legs the composite gate folds, in display order. */
const TREND_LEGS: ReadonlyArray<{ symbol: string; label: string }> = [
  { symbol: SPX_SYMBOL, label: 'S&P 500' },
  { symbol: NDX_SYMBOL, label: 'Nasdaq 100' },
];

/** Resolved composite trend — output of {@link resolveCompositeTrend}. */
export interface CompositeTrendRead {
  /** True ↔ EVERY readable leg is up. */
  trendUp: boolean;
  /** True ↔ at least one readable leg is down. */
  trendDown: boolean;
  /** False ↔ every leg's feed was dark. */
  trendKnown: boolean;
  /** Per-leg detail, including the dwell bookkeeping the next review threads back in. */
  components: MarketReviewTrendComponent[];
  /** Canonical symbol of the weakest readable leg (the one that binds the gate), or `null`. */
  bindingSymbol: string | null;
  /** Per-leg reads, keyed by canonical symbol — used to render the notes. */
  reads: Record<string, TrendRead>;
}

/**
 * TRA-2197 — resolve the gating trend across `^GSPC` and `^NDX` and fold to the
 * WEAKER of the two.
 *
 * The failure this closes: on 2026-07-23 `^GSPC` closed 0.85% under its 50-DMA
 * — inside the ±1% band, so the gate held `up` — while `^NDX`, the index the
 * engine's ~191-name mega-cap-tech universe actually tracks, closed 3.67%
 * under its own 50-DMA, unambiguously outside any band. A single-`^GSPC` gate
 * cannot see that split, and it enabled ORB longs for a book whose real
 * benchmark was 3.7% under water.
 *
 * Fold rule (fail-safe): `up` only when every READABLE leg is up. A dark leg is
 * skipped rather than forcing `unknown` — losing one feed should not blank the
 * regime, and the surviving leg is still evidence. Every leg dark ⇒ `unknown`,
 * exactly as before.
 */
export function resolveCompositeTrend(
  inputs: RegimeInputs,
  memory?: TrendMemoryInput,
): CompositeTrendRead {
  const mem = toTrendMemory(memory);
  const sessionDate = mem.sessionDate ?? null;
  const values: Record<string, { value: number | null; ma: number | null }> = {
    [SPX_SYMBOL]: { value: inputs.spx, ma: inputs.spxTrendMa },
    [NDX_SYMBOL]: { value: inputs.ndx ?? null, ma: inputs.ndxTrendMa ?? null },
  };

  const components: MarketReviewTrendComponent[] = [];
  const reads: Record<string, TrendRead> = {};

  for (const leg of TREND_LEGS) {
    const { value, ma } = values[leg.symbol];
    const priorState = mem.states?.[leg.symbol];
    const prevUp = priorState === 'up' ? true : priorState === 'down' ? false : null;
    const priorDownFlip = mem.downFlipDates?.[leg.symbol] ?? null;
    const read = resolveTrend(value, ma, prevUp, { downFlipDate: priorDownFlip, sessionDate });
    reads[leg.symbol] = read;

    const state: 'up' | 'down' | 'unknown' = !read.trendKnown ? 'unknown' : read.trendUp ? 'up' : 'down';
    // A `→ down` transition COMMITS the dwell lock for the rest of the session.
    // Only a real transition counts: a leg that was already down (or seeded
    // down from a cold store) must not re-stamp the date every review, or the
    // lock would never release.
    const flippedDown = read.trendKnown && !read.trendUp && prevUp === true;
    components.push({
      symbol: leg.symbol,
      label: leg.label,
      value,
      trendMa: ma,
      state,
      distancePct: read.distancePct,
      heldByTolerance: read.heldByTolerance,
      downFlipDate: flippedDown && sessionDate != null ? sessionDate : priorDownFlip,
    });
  }

  const readable = components.filter(c => c.state !== 'unknown');
  if (readable.length === 0) {
    return { trendUp: false, trendDown: false, trendKnown: false, components, bindingSymbol: null, reads };
  }
  const trendUp = readable.every(c => c.state === 'up');
  // The binding leg is the weakest readable one by signed distance — in BOTH
  // directions, so a green tape still names the leg with the thinnest cushion.
  const binding = readable.reduce((weakest, c) =>
    (c.distancePct ?? 0) < (weakest.distancePct ?? 0) ? c : weakest,
  );
  return {
    trendUp,
    trendDown: !trendUp,
    trendKnown: true,
    components,
    bindingSymbol: binding.symbol,
    reads,
  };
}

/**
 * TRA-2197 — rebuild the {@link TrendMemory} the next review threads in from a
 * persisted review's gates. Falls back to the legacy single-leg
 * `gates.trendState` when `trendComponents` is absent, so reviews written
 * before TRA-2197 still seed the `^GSPC` leg instead of reading as a cold
 * store (which would re-seed from the plain `px >= MA` comparison and drop the
 * hysteresis the band exists to provide).
 */
export function buildTrendMemory(
  gates: MarketReviewGates | null | undefined,
  sessionDate: string,
): TrendMemory {
  const states: Record<string, 'up' | 'down' | 'unknown'> = {};
  const downFlipDates: Record<string, string | null> = {};
  const components = gates?.trendComponents;
  if (components && components.length > 0) {
    for (const c of components) {
      states[c.symbol] = c.state;
      downFlipDates[c.symbol] = c.downFlipDate ?? null;
    }
  } else if (gates?.trendState != null) {
    states[SPX_SYMBOL] = gates.trendState;
  }
  return { states, downFlipDates, sessionDate };
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

// `simpleMa` now lives in `./ma-utils.js` (TRA-2032) to break the import cycle
// with `analyst-agent.ts`. Imported above for local use and re-exported here so
// existing importers/tests that pull it from `market-review` keep working.
export { simpleMa };

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
  memory?: TrendMemoryInput,
): {
  regime: MarketRegimeLabel;
  rationale: string;
} {
  const { vix, tnx } = inputs;
  const composite = resolveCompositeTrend(inputs, memory);
  const { trendKnown, trendUp, trendDown } = composite;
  const highVix = vix != null && vix > VIX_NO_BREAKOUT;
  const elevatedVix = vix != null && vix >= VIX_TREND_FOLLOW && vix <= VIX_NO_BREAKOUT;
  const highRates = tnx != null && tnx > TNX_HIGH;

  const reasons: string[] = [];

  if (trendDown || highVix) {
    if (trendDown) reasons.push(`${describeBindingLeg(composite)} (downtrend)`);
    if (highVix) reasons.push(`VIX ${vix!.toFixed(1)} > ${VIX_NO_BREAKOUT} (high volatility)`);
    return { regime: 'red', rationale: reasons.join('; ') + '.' };
  }

  if (elevatedVix || highRates || !trendKnown) {
    if (elevatedVix) reasons.push(`VIX ${vix!.toFixed(1)} in the ${VIX_TREND_FOLLOW}–${VIX_NO_BREAKOUT} mean-reversion band`);
    if (highRates) reasons.push(`10Y yield ${tnx!.toFixed(2)}% > ${TNX_HIGH}% (rate pressure)`);
    if (!trendKnown) reasons.push('index trend feeds unavailable — defaulting to cautious');
    return { regime: 'yellow', rationale: reasons.join('; ') + '.' };
  }

  if (trendUp) reasons.push(describeBindingLeg(composite));
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
  memory?: TrendMemoryInput,
): MarketReviewGates {
  const { vix, tnx } = inputs;
  const composite = resolveCompositeTrend(inputs, memory);
  const { trendKnown, trendUp, trendDown } = composite;
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
    // TRA-2197 — the per-leg detail behind the composite. Load-bearing: the
    // next review reads `downFlipDate` back out of here to re-arm the dwell
    // lock, so this is persisted state, not decoration.
    trendComponents: composite.components,
    trendBindingSymbol: composite.bindingSymbol,
  };
}

// ── TRA-2197 — truthful trend prose ──────────────────────────────────────────

/** Signed percent with an explicit sign, e.g. `-0.85%` / `+1.42%`. */
export function fmtSignedPct(fraction: number | null): string {
  if (fraction == null || !Number.isFinite(fraction)) return 'n/a';
  const pct = fraction * 100;
  return `${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(2)}%`;
}

const BAND_LABEL = `${(TREND_HYSTERESIS * 100).toFixed(0)}%`;

/**
 * TRA-2197 — describe the leg that BINDS the composite gate, quoting its real
 * signed distance. Replaces the old flat `S&P 500 is below its 50-day average`
 * rationale, which named the wrong index whenever `^NDX` was the weaker leg
 * and asserted an above/below relation the numbers did not support whenever
 * the tolerance band was doing the holding.
 */
function describeBindingLeg(composite: CompositeTrendRead): string {
  const leg =
    composite.components.find(c => c.symbol === composite.bindingSymbol) ?? composite.components[0];
  if (!leg || leg.state === 'unknown') return 'index trend feeds unavailable';
  const held = leg.heldByTolerance
    ? `, inside the ±${BAND_LABEL} band so the state is HELD by tolerance, not confirmed by price`
    : '';
  const others = composite.components.filter(c => c.symbol !== leg.symbol && c.state !== 'unknown');
  const contrast =
    others.length > 0
      ? ` [weakest of ${composite.components.map(c => c.symbol).join('/')}; ` +
        `${others.map(c => `${c.symbol} ${fmtSignedPct(c.distancePct)}`).join(', ')}]`
      : '';
  return `${leg.label} (${leg.symbol}) ${fmtSignedPct(leg.distancePct)} vs its ${MA_PERIOD}-day average${held}${contrast}`;
}

/**
 * TRA-2197 — the per-index note. The old string was built off `trendUp` alone
 * and therefore printed `Above 50-DMA (7471.79, ±1% band)` next to
 * `value: 7408.30` — the prose asserting the opposite of the numbers beside
 * it, on the exact line the desk display and the News-tab review quote.
 *
 * The replacement leads with the signed distance (an arithmetic fact), then
 * says what the state is and WHY it is that: confirmed by price, or held by
 * the tolerance band, or pinned by the same-session dwell lock.
 */
export function renderTrendNote(
  component: MarketReviewTrendComponent,
  read: TrendRead | undefined,
  darkNote: string,
  proxyNote = '',
): string {
  if (component.state === 'unknown' || component.trendMa == null) return darkNote;
  const maLabel = `${MA_PERIOD}-DMA`;
  const head = `${fmtSignedPct(component.distancePct)} vs ${maLabel} (${component.trendMa.toFixed(2)})`;
  let body: string;
  if (component.heldByTolerance) {
    body =
      `inside the ±${BAND_LABEL} tolerance band — trend HELD \`${component.state}\` by tolerance ` +
      `(not confirmed by price).`;
  } else if (component.state === 'up') {
    body = `clear of the +${BAND_LABEL} band — confirmed uptrend.`;
  } else {
    body = `clear of the -${BAND_LABEL} band — confirmed downtrend.`;
  }
  const dwell = read?.upFlipSuppressed
    ? ` Up-flip suppressed by the same-session dwell lock (a down transition already committed today).`
    : '';
  return `${head} — ${body}${dwell}${proxyNote}`;
}

/**
 * TRA-2197 — append the COMPOSITE verdict to the leading trend reading.
 *
 * Deliberately takes the already-derived `gates` object rather than
 * recomputing: a display computed from a different source than the verdict is
 * a second source of truth, and it is the one humans quote. `orbLongs` printed
 * here is byte-for-byte the gate the engine consumes.
 */
export function applyCompositeGateClause(
  readings: MarketReviewIndexReading[],
  gates: MarketReviewGates,
): MarketReviewIndexReading[] {
  const legSymbols = TREND_LEGS.map(l => l.symbol);
  const components = gates.trendComponents ?? [];
  const binding = components.find(c => c.symbol === gates.trendBindingSymbol);
  const bindingClause = binding
    ? `; ${binding.symbol} binds at ${fmtSignedPct(binding.distancePct)}`
    : '';
  const clause =
    ` Composite gate trend = \`${gates.trendState ?? 'unknown'}\` ` +
    `(weaker of ${legSymbols.join('/')}${bindingClause}) — ORB longs ${gates.orbLongs ? 'ENABLED' : 'OFF'}.`;
  let applied = false;
  return readings.map(r => {
    // Anchor on the leading trend leg. `symbol` may be the ETF proxy on a
    // fallback day, so match the component's canonical symbol via the reading
    // order instead of a string compare against `^GSPC`.
    if (applied || r.trendState == null) return r;
    applied = true;
    return { ...r, note: `${r.note}${clause}` };
  });
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
  return pickTrendCandles(SPX_SYMBOL, SPX_FALLBACK_SYMBOL, primary, yahooFallback, tradierFallback);
}

/**
 * TRA-2197 — symbol-parameterised form of {@link pickSpxTrendCandles}, so the
 * `^NDX` leg reuses the identical three-source precedence (index → ETF proxy
 * via Yahoo → ETF proxy via Tradier) rather than growing a second, subtly
 * different cascade.
 */
export function pickTrendCandles(
  indexSymbol: string,
  proxySymbol: string,
  primary: Candle[],
  yahooFallback: Candle[],
  tradierFallback: Candle[] = [],
): SpxTrendSource {
  if (primary.length >= MA_PERIOD) {
    return { candles: primary, symbol: indexSymbol, viaFallback: false, provider: 'yahoo' };
  }
  if (yahooFallback.length >= MA_PERIOD) {
    return { candles: yahooFallback, symbol: proxySymbol, viaFallback: true, provider: 'yahoo' };
  }
  if (tradierFallback.length >= MA_PERIOD) {
    return { candles: tradierFallback, symbol: proxySymbol, viaFallback: true, provider: 'tradier' };
  }
  // No source has enough history — keep whichever has the most bars (preserving
  // the precedence order on ties) so `simpleMa` degrades to `null` cleanly.
  const candidates: SpxTrendSource[] = [
    { candles: primary, symbol: indexSymbol, viaFallback: false, provider: 'yahoo' },
    { candles: yahooFallback, symbol: proxySymbol, viaFallback: true, provider: 'yahoo' },
    { candles: tradierFallback, symbol: proxySymbol, viaFallback: true, provider: 'tradier' },
  ];
  return candidates.reduce((best, c) => (c.candles.length > best.candles.length ? c : best));
}

/**
 * Resolve the S&P 500 trend candles, cascading `^GSPC` (Yahoo) → `SPY` (Yahoo)
 * → `SPY` (Tradier). Each fallback request is only issued when the prior source
 * comes up short, so a healthy `^GSPC` read costs nothing extra and the Tradier
 * call only fires when both Yahoo paths are dark (TRA-586).
 */
async function readIndexTrend(indexSymbol: string, proxySymbol: string): Promise<SpxTrendSource> {
  const primary = await fetchDailyCandles(indexSymbol, TREND_FETCH_BARS).catch(() => [] as Candle[]);
  if (primary.length >= MA_PERIOD) {
    return { candles: primary, symbol: indexSymbol, viaFallback: false, provider: 'yahoo' };
  }
  const yahooFallback = await fetchDailyCandles(proxySymbol, TREND_FETCH_BARS).catch(
    () => [] as Candle[],
  );
  if (yahooFallback.length >= MA_PERIOD) {
    return { candles: yahooFallback, symbol: proxySymbol, viaFallback: true, provider: 'yahoo' };
  }
  // TRA-586 — both Yahoo daily paths are dark (breaker open). Reach for the
  // Tradier `/markets/history` feed that already powers /api/health/quotes.
  const tradierFallback = await fetchTradierDailyCandles(proxySymbol, TREND_FETCH_BARS).catch(
    () => [] as Candle[],
  );
  const picked = pickTrendCandles(indexSymbol, proxySymbol, primary, yahooFallback, tradierFallback);
  if (picked.viaFallback) {
    log.warn('index trend feed dark — using ETF proxy', {
      indexSymbol,
      proxySymbol,
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
async function readIndexes(memory?: TrendMemoryInput): Promise<{
  inputs: RegimeInputs;
  readings: MarketReviewIndexReading[];
  /** TRA-586 — the resolved S&P 500 trend source (provider / fallback flags). */
  spxTrend: SpxTrendSource;
  /** TRA-2197 — the resolved Nasdaq 100 trend source. */
  ndxTrend: SpxTrendSource;
}> {
  const [spxTrend, ndxTrend, vix, tnxQuote] = await Promise.all([
    readIndexTrend(SPX_SYMBOL, SPX_FALLBACK_SYMBOL),
    readIndexTrend(NDX_SYMBOL, NDX_FALLBACK_SYMBOL),
    readVix(),
    fetchQuote(TNX_SYMBOL).catch(() => null),
  ]);

  const spxCandles = spxTrend.candles;
  const spx = spxCandles.length > 0 ? spxCandles[spxCandles.length - 1].close : null;
  const spxTrendMa = simpleMa(spxCandles, MA_PERIOD);
  const ndxCandles = ndxTrend.candles;
  const ndx = ndxCandles.length > 0 ? ndxCandles[ndxCandles.length - 1].close : null;
  const ndxTrendMa = simpleMa(ndxCandles, MA_PERIOD);
  const tnx = normalizeTnx(tnxQuote?.price ?? null);

  const inputs: RegimeInputs = { spx, spxTrendMa, ndx, ndxTrendMa, vix, tnx };

  const proxyNote = (src: SpxTrendSource, indexSymbol: string, proxySymbol: string): string =>
    !src.viaFallback
      ? ''
      : src.provider === 'tradier'
        ? ` (via ${proxySymbol}/Tradier proxy — Yahoo ${indexSymbol} + ${proxySymbol} feed down)`
        : ` (via ${proxySymbol} proxy — ${indexSymbol} feed down)`;
  const darkNote = (indexSymbol: string, proxySymbol: string): string =>
    `Feed unavailable — trend filter cannot be confirmed (${indexSymbol}, ${proxySymbol}/Yahoo and ${proxySymbol}/Tradier all unreachable).`;

  // Resolve the composite here so each leg's note quotes the SAME read the
  // gates are derived from. The composite verdict + ORB clause is appended
  // later by `applyCompositeGateClause`, off the real gates object.
  const composite = resolveCompositeTrend(inputs, memory);
  const bySymbol = new Map(composite.components.map(c => [c.symbol, c]));
  const spxComponent = bySymbol.get(SPX_SYMBOL)!;
  const ndxComponent = bySymbol.get(NDX_SYMBOL)!;

  const spxNote = renderTrendNote(
    spxComponent,
    composite.reads[SPX_SYMBOL],
    darkNote(SPX_SYMBOL, SPX_FALLBACK_SYMBOL),
    proxyNote(spxTrend, SPX_SYMBOL, SPX_FALLBACK_SYMBOL),
  );
  const ndxNote = renderTrendNote(
    ndxComponent,
    composite.reads[NDX_SYMBOL],
    darkNote(NDX_SYMBOL, NDX_FALLBACK_SYMBOL),
    proxyNote(ndxTrend, NDX_SYMBOL, NDX_FALLBACK_SYMBOL),
  );
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
    {
      symbol: spxTrend.symbol,
      label: 'S&P 500',
      value: spx,
      trendMa: spxTrendMa,
      note: spxNote,
      trendState: spxComponent.state,
      distancePct: spxComponent.distancePct,
      heldByTolerance: spxComponent.heldByTolerance,
    },
    // TRA-2197 — the second gating leg, surfaced in its own right so the desk
    // can see a ^GSPC/^NDX divergence (2026-07-23: -0.85% vs -3.67%) instead of
    // only the index whose deficit was small enough to be papered over.
    {
      symbol: ndxTrend.symbol,
      label: 'Nasdaq 100',
      value: ndx,
      trendMa: ndxTrendMa,
      note: ndxNote,
      trendState: ndxComponent.state,
      distancePct: ndxComponent.distancePct,
      heldByTolerance: ndxComponent.heldByTolerance,
    },
    { symbol: VIX_SYMBOL, label: 'VIX', value: vix, trendMa: null, note: vixNote },
    { symbol: TNX_SYMBOL, label: '10Y Yield', value: tnx, trendMa: null, note: tnxNote },
  ];

  return { inputs, readings, spxTrend, ndxTrend };
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
  // TRA-2197 — the signed distance gets its own column. The defect this closes
  // was a note asserting "Above 50-DMA" beside a value that was below it; the
  // arithmetic now sits in the table where a reader cannot skip past it.
  lines.push(`| Index | Value | ${MA_PERIOD}-DMA | vs MA | Read |`);
  lines.push('|---|---|---|---|---|');
  for (const r of indexes) {
    const dist = r.trendMa == null ? '—' : fmtSignedPct(r.distancePct ?? null);
    lines.push(`| ${r.label} | ${fmt(r.value)} | ${fmt(r.trendMa)} | ${dist} | ${r.note} |`);
  }
  lines.push('');
  lines.push('## Strategy gates');
  lines.push('');
  // TRA-2197 — print the composite trend and the leg that binds it, so the
  // gate line and the index table can never tell different stories.
  const binding = (gates.trendComponents ?? []).find(c => c.symbol === gates.trendBindingSymbol);
  const bindingClause = binding ? ` — binding leg ${binding.symbol} at ${fmtSignedPct(binding.distancePct)}` : '';
  lines.push(
    `- **Trend (composite, weaker of ^GSPC/^NDX):** ${gates.trendState ?? 'unknown'}${bindingClause}`,
  );
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
 * TRA-472 / TRA-2197 — the most-recent persisted review's per-leg trend state,
 * plus the current ET session date, folded into the {@link TrendMemory} the
 * hysteresis band and the dwell lock consume. Read-only — used by both the
 * persisting {@link generateMarketReview} and the read-only
 * {@link peekMarketRegime}, so the two can never disagree about the prior
 * state they are holding from.
 */
async function latestTrendMemory(now: Date): Promise<TrendMemory> {
  const persisted = await ensureLoaded();
  const latestPrior =
    persisted.length > 0
      ? persisted.reduce((a, b) => (b.generatedAt > a.generatedAt ? b : a))
      : null;
  return buildTrendMemory(latestPrior?.gates, etDate(now));
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
export async function peekMarketRegime(now: Date = new Date()): Promise<MarketRegimePeek> {
  const memory = await latestTrendMemory(now);
  const { inputs, readings, spxTrend } = await readIndexes(memory);
  const { regime, rationale } = classifyMarketRegime(inputs, memory);
  const gates = deriveGates(regime, inputs, memory);
  return {
    generatedAt: now.toISOString(),
    regime,
    regimeRationale: rationale,
    indexes: applyCompositeGateClause(readings, gates),
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

  // TRA-472 / TRA-2197 — thread the most-recent persisted review's per-leg
  // trend state (and its dwell-lock dates) into the ±1% hysteresis band so a
  // price inside the band holds rather than flips, and a leg that already went
  // `down` today cannot flip back `up` in the same session. On a cold store the
  // states map is empty and `resolveTrend` seeds from `px ≥ MA`.
  const memory = await latestTrendMemory(now);

  let inputs: RegimeInputs = { spx: null, spxTrendMa: null, ndx: null, ndxTrendMa: null, vix: null, tnx: null };
  let readings: MarketReviewIndexReading[] = [];
  try {
    const read = await readIndexes(memory);
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
      { symbol: NDX_SYMBOL, label: 'Nasdaq 100', value: null, trendMa: null, note: 'Feed unavailable.' },
      { symbol: VIX_SYMBOL, label: 'VIX', value: null, trendMa: null, note: 'Feed unavailable.' },
      { symbol: TNX_SYMBOL, label: '10Y Yield', value: null, trendMa: null, note: 'Feed unavailable.' },
    ];
  }

  const { regime, rationale } = classifyMarketRegime(inputs, memory);
  const gates = deriveGates(regime, inputs, memory);
  readings = applyCompositeGateClause(readings, gates);

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

  // TRA-1629 (TRA-1623A) — D2 calls-vs-puts per-name lean. The live-compute +
  // persistence path stays flag-gated (default OFF): the discovery cohort and the
  // per-name-day lean ledger only exist when `ENABLE_NEWS_CATALYST_WATCHLIST` is
  // on. OBSERVE-ONLY — the lean seeds `reviewBlock.leaders` and annotates the
  // report; it routes no order, sizes nothing, touches no exit. Never throws: a
  // lean-build failure degrades to an empty cohort (→ a health line via TRA-1970).
  const discoveryEnabled = isNewsCatalystEnabled();
  let leans: NameLean[] = [];
  if (discoveryEnabled) {
    try {
      const leanInputs = await buildSessionLeanInputs(gates.trendState ?? 'unknown', now.getTime());
      leans = assembleNameLeans(leanInputs);
      if (leans.length > 0 && review.reviewBlock) {
        review.reviewBlock.leaders = strongestLeaders(leans);
      }
      // TRA-1632 — persist the resolved lean per name-day so QuantTrader can join
      // it against realized next-day/3-day underlying direction offline (TRA-1630).
      // PCR/OI are point-in-time and cannot be reconstructed retroactively, so the
      // lean MUST be captured at review time. One row per name per ET session
      // (first review wins). Still observe-only: this only records what the report
      // already annotated — it routes no order, sizes nothing, touches no exit.
      const inputBySym = new Map(leanInputs.map((i) => [i.symbol.toUpperCase(), i]));
      for (const l of leans) {
        const input = inputBySym.get(l.symbol);
        if (input) await recordCatalystLean(input, l.lean, now.getTime());
      }
    } catch (err) {
      log.error('news-catalyst lean enrichment failed', {
        reviewId: review.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      leans = [];
    }
  }

  // TRA-1970 — pre/post-market report enrichment (render-only). The engine
  // already computes a next-day watchlist + per-name S/R + a sentiment tape, but
  // only the regime slice above was ever printed. These three sections close that
  // render gap: ADDITIVE, READ-ONLY, from PERSISTED artifacts (no network, no
  // engine, no execution). Each degrades to a VISIBLE health flag when its source
  // is cold/blocked/absent (the TRA-1963 board ask). Never throws.
  let enrichmentMarkdown = '';
  try {
    const [plan, sentiment] = await Promise.all([
      readAnalystPlan(date).catch(() => null),
      loadLatestSentimentSnapshot(now.getTime()).catch(() => null),
    ]);
    enrichmentMarkdown =
      `\n\n${renderWatchlistLevelsSection(plan)}` +
      `\n\n${renderSentimentTapeSection(sentiment, date)}` +
      `\n\n${renderCallPutLeanSection(leans, { discoveryEnabled })}`;
  } catch (err) {
    log.error('report enrichment render failed', {
      reviewId: review.id,
      reason: err instanceof Error ? err.message : String(err),
    });
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
      bodyMarkdown: renderMarkdown(review) + enrichmentMarkdown,
      publishedAt: review.generatedAt,
      tickers: [SPX_SYMBOL, NDX_SYMBOL, VIX_SYMBOL, TNX_SYMBOL],
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
    ndx: fmt(inputs.ndx ?? null),
    ndxTrendMa: fmt(inputs.ndxTrendMa ?? null),
    vix: fmt(inputs.vix),
    tnx: fmt(inputs.tnx),
    trendState: gates.trendState,
    trendBindingSymbol: gates.trendBindingSymbol,
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
