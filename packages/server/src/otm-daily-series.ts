import type { Candle } from '@trading-app/shared';
import type { SetupTaxonomyReasonCode } from '@trading-app/engine';

/**
 * TRA-4424 (parent TRA-4421, filed off TRA-4422 Finding 1) — A DAILY-BAR SOURCE
 * FOR THE OTM NOMINATION SEAM.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE DEFECT THIS CLOSES. The only price series reachable at the OTM
 *  nomination seam was `shadowCandleCache`: 2400 one-minute bars resampled to
 *  5m. 2400 / 390 minutes per RTH session ≈ 6.15 TRADING DAYS. Every setup in
 *  the TRA-4421 taxonomy (A–E) is a MULTI-DAY thesis — "established uptrend",
 *  "higher high / higher low", "breakout from consolidation", "moving-average
 *  reclaim" — against a 3–20 day hold. None of those can be established from
 *  six sessions of intraday bars.
 *
 *  ⛔ AND IT WOULD HAVE RUN. A 480-bar 5-minute series clears every
 *  `length >= N` guard in `evaluateSetupTaxonomy`, produces confident verdicts
 *  and populates the reason-code histogram TRA-4422 shipped. Its Donchian
 *  channel would be measuring an INTRADAY RANGE and reporting it as swing
 *  structure. Because a directional gate is a RESTRICTION, the resulting soak
 *  reads identically to a working one — `opensPlaced` falls either way. The
 *  wrong-timeframe version is not a weaker signal, it is a DIFFERENT QUESTION
 *  ANSWERED CONFIDENTLY, arriving through the one door TRA-4422's instrument
 *  cannot close.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS MODULE IS, AND WHAT IT IS NOT. It is a session-scoped cache, its
 * read policy, and its counters. It performs NO IO: `signal-engine.ts` owns the
 * fetch (it already imports `fetchDailyCandles`) and hands the bars here, which
 * keeps this a leaf — importable by the health route without dragging the feed
 * in behind it, and unit-testable against literal candles with no network seam.
 *
 * ⛔ THE OTM SWEEP IS A LIVE ORDER PATH. A per-symbol network fetch at the seam
 * is not an option: that is latency on an order path, and a feed stall becomes
 * an ENTRY STALL. The cache is therefore filled by a budgeted refresh pass in
 * `doTick` — mirroring `refreshSupertrendShadowSeries` — and the seam only ever
 * does a Map lookup.
 *
 * ⛔ NO BEHAVIOUR CHANGE TO THE OTM SLEEVE. This is a data source. The taxonomy
 * registry stays empty and `OTM_SETUP_TAXONOMY_MODE` stays `observe`; arming is
 * board card `70e36987`, not here.
 */

/**
 * How many daily bars to hold per symbol.
 *
 * Sized off the deepest lookback the taxonomy will need rather than off a round
 * number: setup E's Donchian channel is 20 periods, setups A–D speak of a
 * moving-average reclaim (50 sessions is the deepest MA in the TRA-4421 §5
 * prose), and {@link SETUP_TAXONOMY_MIN_BARS} demands 60 readable bars on top
 * so "consolidating INSIDE the channel" is distinguishable from "inside it on
 * the last bar". 120 leaves 60 bars of headroom over the deepest of those.
 *
 * ⚠️ MEMORY IS A REAL CONSTRAINT ON THIS BOX (TRA-937 was an OOM crash-loop on
 * the 512MB starter plan). 120 candles × ~100 bytes ≈ 12KB/symbol; over a ~570
 * symbol watchlist that is ~7MB. That is affordable and it is why this is 120
 * rather than "a year of history".
 */
export const OTM_DAILY_SERIES_BARS = 120;

/**
 * Wall clock one daily-refresh pass may spend inside a single `doTick`.
 *
 * Deliberately SMALLER than `SWEEP_BUDGET_MS` (30s). Daily bars change once a
 * day; the urgency of this sink is a small fraction of the intraday sinks that
 * budget was sized for, and `signal.doTick` duration is still the live exit
 * evaluation interval (TRA-2200's hoist is deferred on the real-money book), so
 * every millisecond added here is exit latency on live capital.
 */
export const OTM_DAILY_SERIES_BUDGET_MS = 8_000;

/**
 * Minimum gap between the START of one full rotation and the next. Not a
 * per-pass gate: an UNFINISHED rotation re-enters on the next tick (the
 * TRA-2477 property), so this bounds how often the universe is re-walked, not
 * how often the sink runs.
 */
export const OTM_DAILY_SERIES_REFRESH_MS = 30 * 60_000;

/**
 * How old a cached series may be before a read reports it UNREADABLE.
 *
 * ⛔ THIS IS A BACKSTOP, NOT THE FEED-FAILURE DETECTOR. The detector is
 * {@link OtmDailySeriesCounters.fetchFailed} / `consecutiveFetchFailures`,
 * which move on the FIRST failed fetch. Staleness is what stops a series the
 * refresh has stopped maintaining from being scored as though it were current.
 *
 * Sized against the worst-case healthy refresh interval rather than picked. A
 * rotation starts at most every 30 min ({@link OTM_DAILY_SERIES_REFRESH_MS})
 * and, at the slowest per-symbol cost this repo has ever measured on a
 * yahoo-backed sink (1.646 s/symbol — `mtf-refresh`, TRA-2262's table), an
 * 8s-budgeted rotation over ~570 symbols spans ~57 min of ticks. Worst-case
 * healthy age is therefore ~87 min. 4h clears that with headroom AND still
 * bites inside a single 6.5h RTH session, so a feed that dies at the open is
 * caught before the close.
 *
 * ⚠️ It also makes the FIRST read after a weekend or a boot report `stale` /
 * `absent` until the first rotation lands. That is the correct reading — the
 * series genuinely is not current — and it is COUNTED
 * ({@link OtmDailySeriesCounters.readsStale}) rather than silent.
 */
export const OTM_DAILY_SERIES_MAX_AGE_MS = 4 * 60 * 60_000;

/**
 * How old an entry may get before a completed rotation DROPS it.
 *
 * ⛔ EVICTION IS BY AGE, NEVER BY "LEFT THE UNIVERSE". There is no single
 * universe: `initAllUserContexts` builds ONE `SignalEngine` PER USER, every one
 * of them runs this refresh over its OWN `getActiveSymbols()` (hidden symbols,
 * dynamic symbols and open-option underlyings all differ per book), and they
 * all share this module's one cache. The first cut pruned against the calling
 * engine's universe, so each engine's completed rotation deleted every symbol
 * the OTHER books were holding — measured on live tape 2026-09-10: `evicted`
 * 218, `cachedSymbols` 25, and 49 of the last 50 seam reads `absent`.
 *
 * 24h is past the longest gap a symbol can legitimately go unrefreshed inside a
 * trading week (the ~17.5h close-to-open overnight), so a symbol some book still
 * trades is always refreshed before it could be dropped; a symbol no book holds
 * any more ages out within a day. Between `MAX_AGE` and this, an entry reads
 * `stale` — which is the informative state, and eviction would erase it into
 * `absent`.
 */
export const OTM_DAILY_SERIES_EVICT_AGE_MS = 24 * 60 * 60_000;

/**
 * The state of one read at the seam.
 *
 * ⛔ THREE VALUES, NOT A BOOLEAN. `absent` (the refresh has never landed this
 * symbol) and `stale` (it did, and has stopped) are different facts about the
 * world with different remedies, and pooling them re-creates one layer down the
 * exact ambiguity `series_unreadable` exists to split out of
 * `no_setup_matched`.
 */
export type OtmDailySeriesReadState = 'fresh' | 'stale' | 'absent';

export interface OtmDailySeriesRead {
  /** The bars to score. EMPTY on `stale` and `absent` — never a partial read. */
  readonly bars: readonly Candle[];
  readonly state: OtmDailySeriesReadState;
  /** Age of the cached entry in ms, or null when there is no entry. */
  readonly ageMs: number | null;
}

interface DailySeriesEntry {
  bars: Candle[];
  fetchedAt: number;
}

/**
 * Module-shared, exactly like `sharedShadowCandleCache`. Daily bars are pure
 * market data, identical across books, so one fleet-wide copy is both correct
 * and an N-fold memory saving over a per-engine Map.
 */
const cache = new Map<string, DailySeriesEntry>();

/** Everything that has to be true for a green read to MEAN anything. */
export interface OtmDailySeriesCounters {
  /**
   * Budgeted passes started. ⛔ ZERO IS `unmeasured`, NEVER "healthy": every
   * other counter here is zero on a box where the refresh was never wired in,
   * which is byte-identical to a box where it ran perfectly and nothing failed.
   */
  readonly refreshPasses: number;
  /** Passes that reached the end of the universe. */
  readonly refreshRotations: number;
  readonly symbolsAttempted: number;
  readonly fetchOk: number;
  /** Fetch returned, with nothing in it. A quiet feed, not a broken one. */
  readonly fetchEmpty: number;
  /** Fetch threw. THE failure signal. */
  readonly fetchFailed: number;
  /**
   * Symbols skipped because the upstream feed breaker was OPEN.
   *
   * ⛔ ITS OWN BUCKET, and the reason is a trap this counter set would otherwise
   * walk into. `fetchDailyCandles` runs through `withRetry`, which SHORT-CIRCUITS
   * to `null` when Yahoo is rate-limited — so a tripped breaker arrives here as
   * an EMPTY RESULT, not a throw. Pooled into `fetchEmpty`, a mid-session
   * breaker trip after a healthy morning would leave `status: 'ok'` while every
   * nominee scored `series_unreadable`: the exact "a dead feed reads like a
   * quiet market" failure this whole block exists to prevent, reintroduced one
   * layer down. So the breaker is asked BEFORE the call and counted here.
   *
   * ⚠️ A PRESSURE GAUGE, NOT A DISTINCT-SYMBOL COUNT. An open breaker STOPS the
   * rotation on the refused batch (it does not skip past it), and the same batch
   * is re-offered — and re-counted — on every tick until the breaker closes.
   */
  readonly skippedFeedBreaker: number;
  /**
   * Symbols a rotation did NOT fetch because the cache already held them inside
   * {@link OTM_DAILY_SERIES_REFRESH_MS}, or another engine's fetch for them was
   * in flight. This is what keeps N per-user engines at ONE fetch per symbol per
   * refresh interval process-wide rather than N — without it, every book's
   * rotation re-pulled the same universe off one shared Yahoo client.
   */
  readonly skippedFresh: number;
  /**
   * TRA-4424 (09-18) — of {@link fetchOk}, the fetches served by the FALLBACK feed
   * (Tradier `/markets/history`) because the Yahoo breaker was open. A SUBSET of
   * `fetchOk`, not an addend.
   *
   * ⛔ WHY IT EXISTS. Graded live 2026-09-18 14:34Z (bqb1 `0dc2baea`): the span leg
   * held (172 d) and the 09-10 fixes were serving (`evicted` 0, `skippedFresh`
   * 503), yet `readsFresh` 3 against `readsAbsent` 142 — `skippedFeedBreaker`
   * 30,172 against `fetchOk` 41 since the 21:31Z boot. Yahoo 429s ~permanently on
   * Render's shared egress (TRA-1230), so a Yahoo-only daily source is a source
   * that serves ~2% of the seam. The counters said so honestly; the cache was
   * still empty. Every other daily-bar consumer on this box already falls back to
   * Tradier for exactly this reason (`dailyCloseCache`, market-review).
   */
  readonly fetchOkFallback: number;
  /**
   * Fallback fetches that came back EMPTY. `fetchTradierDailyCandles` swallows
   * every error to `[]` (it trips its own breaker on 429/5xx, and only warns on
   * anything else — a 401 included), so an empty here is NOT a quiet answer the
   * way a Yahoo empty is. Counted apart and graded `degraded`, so a dead fallback
   * cannot hide inside `fetchEmpty`.
   */
  readonly fetchEmptyFallback: number;
  /** Reset by any success — the discriminator between a blip and an outage. */
  readonly consecutiveFetchFailures: number;
  readonly lastOkAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastFailureReason: string | null;
  /** Reads at the seam, split by state. Their sum is the read denominator. */
  readonly readsFresh: number;
  readonly readsStale: number;
  readonly readsAbsent: number;
  readonly cachedSymbols: number;
  /** Entries dropped for age ({@link OTM_DAILY_SERIES_EVICT_AGE_MS}). */
  readonly evicted: number;
  /** Wall clock this process started counting. Every total above is SINCE-BOOT. */
  readonly since: number;
}

const counters = {
  refreshPasses: 0,
  refreshRotations: 0,
  symbolsAttempted: 0,
  fetchOk: 0,
  fetchEmpty: 0,
  fetchFailed: 0,
  skippedFeedBreaker: 0,
  skippedFresh: 0,
  fetchOkFallback: 0,
  fetchEmptyFallback: 0,
  consecutiveFetchFailures: 0,
  lastOkAt: null as number | null,
  lastFailureAt: null as number | null,
  lastFailureReason: null as string | null,
  readsFresh: 0,
  readsStale: 0,
  readsAbsent: 0,
  evicted: 0,
  since: Date.now(),
};

/**
 * One scored nominee, as the TAXONOMY saw it.
 *
 * ⛔ `seriesSpanMs` HERE IS THE VERDICT'S OWN FIELD, copied from
 * `SetupTaxonomyVerdict`, never re-derived from the cache by this module. TRA-4424's
 * acceptance is that the published span MOVES to a multi-day value on live
 * tape; a span this module computed itself would be a local copy graded against
 * a local literal, which agrees with itself no matter what the seam actually
 * scored.
 */
export interface OtmDailySeriesVerdictSample {
  readonly symbol: string;
  readonly at: number;
  readonly readState: OtmDailySeriesReadState;
  readonly bars: number;
  readonly seriesSpanMs: number | null;
  readonly reasonCode: SetupTaxonomyReasonCode | null;
  readonly confirmed: boolean;
}

/** Bounded so a busy session cannot grow this without limit (TRA-937). */
export const OTM_DAILY_SERIES_SAMPLE_CAP = 50;
const samples: OtmDailySeriesVerdictSample[] = [];
let verdictsRecorded = 0;

/**
 * Read the cached daily series for one symbol.
 *
 * ⛔ AN UNREADABLE CACHE RETURNS AN EMPTY SERIES, NOT A SHORT ONE. The pure
 * taxonomy checks readability first and reports `series_unreadable` with
 * `seriesSpanMs: null` for an empty input, which is exactly the bucket a cold
 * or stalled cache belongs in. Handing it a stale-but-long series instead would
 * launder a dead feed into a confident `no_setup_matched` — the one outcome
 * TRA-4422's split was built to make impossible.
 */
export function readOtmDailySeries(symbol: string, nowMs: number = Date.now()): OtmDailySeriesRead {
  const read = peekOtmDailySeries(symbol, nowMs);
  if (read.state === 'absent') counters.readsAbsent += 1;
  else if (read.state === 'stale') counters.readsStale += 1;
  else counters.readsFresh += 1;
  return read;
}

/**
 * TRA-4706 — the same read, same readability policy, WITHOUT moving the seam's
 * `reads*` counters. For consumers other than the OTM taxonomy seam (the
 * observe-only swing scanner): those counters are the denominator of the
 * TRA-4424 coverage grade, and a second reader folding into them would grade
 * the swing pass's universe as the sleeve's. Such a consumer counts its own
 * unreadable reads.
 */
export function peekOtmDailySeries(symbol: string, nowMs: number = Date.now()): OtmDailySeriesRead {
  const entry = cache.get(symbol);
  if (!entry) return { bars: [], state: 'absent', ageMs: null };
  const ageMs = nowMs - entry.fetchedAt;
  if (ageMs > OTM_DAILY_SERIES_MAX_AGE_MS) return { bars: [], state: 'stale', ageMs };
  return { bars: entry.bars, state: 'fresh', ageMs };
}

/** Store one symbol's bars. Called by the refresh, never by the order path. */
export function storeOtmDailySeries(
  symbol: string,
  bars: readonly Candle[],
  nowMs: number = Date.now(),
): void {
  counters.symbolsAttempted += 1;
  if (bars.length === 0) {
    // A feed that answered with nothing. NOT a failure — it does not reset the
    // consecutive-failure run, and it does not evict the last good series: a
    // symbol that has genuinely stopped printing should age out through
    // staleness, not vanish on one empty answer.
    counters.fetchEmpty += 1;
    return;
  }
  counters.fetchOk += 1;
  counters.consecutiveFetchFailures = 0;
  counters.lastOkAt = nowMs;
  cache.set(symbol, { bars: bars.slice(-OTM_DAILY_SERIES_BARS), fetchedAt: nowMs });
}

/**
 * Record a symbol the refresh declined to fetch because the upstream feed
 * breaker was open. NOT a failure and NOT an empty — see
 * {@link OtmDailySeriesCounters.skippedFeedBreaker}.
 */
export function noteOtmDailySeriesBreakerSkip(count = 1): void {
  counters.symbolsAttempted += count;
  counters.skippedFeedBreaker += count;
}

/** Record a fetch that threw. The primary feed-failure signal. */
export function noteOtmDailySeriesFailure(
  symbol: string,
  reason: string,
  nowMs: number = Date.now(),
): void {
  counters.symbolsAttempted += 1;
  counters.fetchFailed += 1;
  counters.consecutiveFetchFailures += 1;
  counters.lastFailureAt = nowMs;
  // Symbol-tagged so an outage on ONE ticker is distinguishable from a dead
  // provider without going to the log tape.
  counters.lastFailureReason = `${symbol}: ${reason}`;
}

/** Record that a budgeted pass ran. `complete` ⇒ the universe was walked. */
export function noteOtmDailySeriesPass(complete: boolean): void {
  counters.refreshPasses += 1;
  if (complete) counters.refreshRotations += 1;
}

/**
 * Drop cached entries older than {@link OTM_DAILY_SERIES_EVICT_AGE_MS}. Called at
 * the end of a COMPLETE rotation. ⛔ Never takes a universe — see the constant
 * for why a per-engine universe prune on a fleet-shared cache is the defect.
 */
export function pruneOtmDailySeries(nowMs: number = Date.now()): void {
  for (const [sym, entry] of [...cache.entries()]) {
    if (nowMs - entry.fetchedAt > OTM_DAILY_SERIES_EVICT_AGE_MS) {
      cache.delete(sym);
      counters.evicted += 1;
    }
  }
}

/** Symbols some engine is fetching right now. Module-shared, like the cache. */
const inFlight = new Set<string>();

function needsFetch(symbol: string, nowMs: number): boolean {
  if (inFlight.has(symbol)) return false;
  const entry = cache.get(symbol);
  return entry == null || nowMs - entry.fetchedAt >= OTM_DAILY_SERIES_REFRESH_MS;
}

/** The feed, injected so this module stays a leaf with no IO of its own. */
export interface OtmDailySeriesBatchDeps {
  readonly fetch: (symbol: string) => Promise<readonly Candle[]>;
  /** Asked BEFORE any fetch — see {@link OtmDailySeriesCounters.skippedFeedBreaker}. */
  readonly breakerOpen: () => boolean;
  /**
   * TRA-4424 (09-18) — the feed used while the primary's breaker is open. Its
   * `available` is asked BEFORE the call for the same reason `breakerOpen` is: a
   * blocked or unconfigured fallback answers `[]`, never a throw. See
   * {@link OtmDailySeriesCounters.fetchOkFallback}.
   */
  readonly fallback?: {
    readonly fetch: (symbol: string) => Promise<readonly Candle[]>;
    readonly available: () => boolean;
  };
  readonly now?: () => number;
}

/**
 * The refresh's per-batch worker — `runBudgetedSweep`'s `run` in
 * `refreshOtmDailySeries`. Lives here, with the feed injected, so its two
 * failure modes are graded BEHAVIOURALLY rather than by a source regex.
 *
 * ⛔ AN OPEN BREAKER RETURNS `false` (STOP, cursor left ON this batch). The first
 * cut returned `undefined`, which `runBudgetedSweep` reads as "batch done": a
 * rotation that began under an open breaker walked the whole universe in 0 ms,
 * fetched nothing, reported COMPLETE, and spent its 30-minute cadence slot.
 * Measured on live tape 2026-09-10: the Yahoo breaker was open in 37 of the
 * first 68 minutes of RTH (3,900 trips, 3,529 of them from the quote fan-out,
 * 124 from this sink), `skippedFeedBreaker` 74,991 against `fetchOk` 1,177,
 * and no daily fetch landed between 14:00:41Z and 15:01:31Z. Stopping instead
 * makes the rotation resume on the first tick the breaker is closed.
 *
 * ⛔ FRESH AND IN-FLIGHT SYMBOLS ARE NOT RE-FETCHED. With one engine per user
 * sharing this cache, the stop above would otherwise turn N engines' rotations
 * into N full fetches of the same universe every refresh interval — a feed-quota
 * regression (TRA-1996) that the open breaker was masking. The skip is what
 * makes the stop safe to ship.
 */
export async function runOtmDailySeriesBatch(
  batch: readonly string[],
  deps: OtmDailySeriesBatchDeps,
): Promise<boolean | void> {
  const now = deps.now ?? Date.now;
  const due = batch.filter((sym) => needsFetch(sym, now()));
  let viaFallback = false;
  if (due.length > 0 && deps.breakerOpen()) {
    // ⛔ A SKIP ONLY WHEN NO FEED CAN SERVE. With the primary's breaker open the
    // fallback carries the batch; only when it is ALSO blocked/unconfigured does
    // the rotation park — same `false`, same reason as below.
    if (!deps.fallback || !deps.fallback.available()) {
      noteOtmDailySeriesBreakerSkip(due.length);
      return false;
    }
    viaFallback = true;
  }
  const fetchOne = viaFallback && deps.fallback ? deps.fallback.fetch : deps.fetch;
  counters.skippedFresh += batch.length - due.length;
  // Claimed synchronously, before the first await, so a second engine's batch
  // interleaving on the event loop sees these as in flight.
  for (const sym of due) inFlight.add(sym);
  await Promise.all(due.map(async (sym) => {
    try {
      // An EMPTY answer is not a failure and does not evict the last good
      // series: a symbol that has genuinely stopped printing should age out
      // through staleness rather than vanish on one empty response.
      const got = await fetchOne(sym);
      if (viaFallback) {
        if (got.length > 0) counters.fetchOkFallback += 1;
        else counters.fetchEmptyFallback += 1;
      }
      storeOtmDailySeries(sym, got, now());
    } catch (err: unknown) {
      noteOtmDailySeriesFailure(sym, err instanceof Error ? err.message : String(err), now());
    } finally {
      inFlight.delete(sym);
    }
  }));
}

/**
 * Record what the taxonomy actually returned for one nominee.
 *
 * This is the load-bearing half of the instrument: {@link OtmDailySeriesCounters}
 * says the refresh is alive, and THIS says the series that reached the seam was
 * the multi-day one. Without it, "the daily source is wired" and "the daily
 * source is wired and the seam still reads the 5-minute cache" publish the same
 * JSON.
 */
export function noteOtmDailySeriesVerdict(sample: OtmDailySeriesVerdictSample): void {
  verdictsRecorded += 1;
  samples.push(sample);
  if (samples.length > OTM_DAILY_SERIES_SAMPLE_CAP) samples.shift();
}

export type OtmDailySeriesStatus = 'unmeasured' | 'failing' | 'degraded' | 'ok';

export interface OtmDailySeriesHealth {
  readonly status: OtmDailySeriesStatus;
  readonly counters: OtmDailySeriesCounters;
  readonly config: {
    readonly bars: number;
    readonly budgetMs: number;
    readonly refreshMs: number;
    readonly maxAgeMs: number;
  };
  readonly verdicts: {
    /** SINCE-BOOT total. Independent of the bounded sample window below. */
    readonly recorded: number;
    /** How many of the most recent verdicts the spans below are computed over. */
    readonly window: number;
    /**
     * The window split into the two things a single boolean used to conflate:
     * rows that carried a span (the seam read SOMETHING) and rows that did not
     * (`series_unreadable` — a cold, stale or dead cache). A warm-up session and
     * a wrong-timeframe series are different defects with different owners, and
     * pooling them is how one hides behind the other.
     */
    readonly readable: number;
    readonly unreadable: number;
    readonly spanMsMin: number | null;
    readonly spanMsMax: number | null;
    /** The bar `allReadableSpansSwingHorizon` is graded against, published so the reader need not know it. */
    readonly minThesisSpanMs: number;
    /**
     * Whether every READABLE span in the window clears
     * {@link OTM_DAILY_SERIES_MIN_THESIS_SPAN_MS} — i.e. whether the series
     * reaching the seam is the daily one rather than an intraday one.
     *
     * ⛔ NULL when NO row in the window is readable — that is UNMEASURED, and a
     * `false` there would read as a measured wrong-timeframe failure when the
     * cache is merely cold. The unreadable rows are counted above; they are not
     * silently forgiven.
     */
    readonly allReadableSpansSwingHorizon: boolean | null;
    readonly recent: readonly OtmDailySeriesVerdictSample[];
  };
  readonly note: string;
}

/** One day of wall clock. */
const DAY_MS = 24 * 60 * 60_000;

/**
 * THE ACCEPTANCE BAR OF THIS TICKET, AND IT IS NOT "MULTI-DAY".
 *
 * ⛔ A ONE-DAY BAR CANNOT SEE THE DEFECT TRA-4424 EXISTS TO FIX. The series
 * this issue replaced was `shadowCandleCache`: 2400 one-minute bars resampled
 * to 5m, i.e. ~6.15 RTH sessions — a WALL-CLOCK SPAN of roughly 8.6 calendar
 * days. That is `>= DAY_MS`. So a `spanMs >= 1 day` predicate returns TRUE on
 * the broken build and TRUE on the fixed one: the published boolean would have
 * read identically in pass and fail, which is the exact failure this whole
 * instrument was written to make impossible.
 *
 * 30 days is chosen to sit >3x above that 8.6-day intraday span and far below
 * what {@link OTM_DAILY_SERIES_BARS} daily bars actually span (120 sessions ≈
 * 168 calendar days), so the two populations are separated by more than an
 * order of magnitude of slack in both directions. It is a DISCRIMINATOR, not a
 * sufficiency claim about any particular setup: the TRA-4421 theses run 3–20
 * day holds and each setup states its own `minBars`.
 */
export const OTM_DAILY_SERIES_MIN_THESIS_SPAN_MS = 30 * DAY_MS;

export function otmDailySeriesHealth(nowMs: number = Date.now()): OtmDailySeriesHealth {
  const snapshot: OtmDailySeriesCounters = {
    ...counters,
    cachedSymbols: cache.size,
  };
  // ⛔ ORDER IS LOAD-BEARING. `unmeasured` is tested FIRST because every other
  // branch below is satisfied by an all-zero record, and an all-zero record is
  // what a box that never ran this refresh produces. UNKNOWN IS NOT OK.
  const status: OtmDailySeriesStatus =
    snapshot.refreshPasses === 0
      ? 'unmeasured'
      : snapshot.fetchOk === 0
        ? 'failing'
        : snapshot.fetchFailed > 0 || snapshot.skippedFeedBreaker > 0
            || snapshot.fetchEmptyFallback > 0
          ? 'degraded'
          : 'ok';

  const window = samples.slice(-OTM_DAILY_SERIES_SAMPLE_CAP);
  const spans = window
    .map((s) => s.seriesSpanMs)
    .filter((s): s is number => typeof s === 'number');
  const spanMsMin = spans.length > 0 ? Math.min(...spans) : null;
  const spanMsMax = spans.length > 0 ? Math.max(...spans) : null;

  return {
    status,
    counters: snapshot,
    config: {
      bars: OTM_DAILY_SERIES_BARS,
      budgetMs: OTM_DAILY_SERIES_BUDGET_MS,
      refreshMs: OTM_DAILY_SERIES_REFRESH_MS,
      maxAgeMs: OTM_DAILY_SERIES_MAX_AGE_MS,
    },
    verdicts: {
      recorded: verdictsRecorded,
      window: window.length,
      readable: spans.length,
      unreadable: window.length - spans.length,
      spanMsMin,
      spanMsMax,
      minThesisSpanMs: OTM_DAILY_SERIES_MIN_THESIS_SPAN_MS,
      // Graded over the READABLE rows only, and null when there are none. An
      // unreadable row says nothing about the timeframe of the series — there
      // was no series — so folding it in here would report "wrong timeframe"
      // for a cold cache and hand the next reader the wrong owner.
      allReadableSpansSwingHorizon: spans.length === 0
        ? null
        : spans.every((s) => s >= OTM_DAILY_SERIES_MIN_THESIS_SPAN_MS),
      recent: window.slice(-5),
    },
    note: noteFor(status, snapshot, nowMs),
  };
}

function noteFor(
  status: OtmDailySeriesStatus,
  c: OtmDailySeriesCounters,
  nowMs: number,
): string {
  switch (status) {
    case 'unmeasured':
      return 'UNMEASURED — the daily refresh has not run a single pass on this process. '
        + 'This is NOT a clean bill: every counter here is zero on a box where the sink was '
        + 'never wired in, which is byte-identical to one where it ran and nothing failed. '
        + 'Check `build` against the commit that shipped `otm-daily-series.ts`, then check that '
        + 'the OTM scan is armed at all — the refresh rides the same gate.';
    case 'failing':
      return 'FAILING — passes ran and NOT ONE daily fetch has succeeded '
        + `(${c.fetchFailed} threw, ${c.fetchEmpty} came back empty, `
        + `${c.consecutiveFetchFailures} consecutive failures; last: ${c.lastFailureReason ?? 'n/a'}). `
        + 'Every nominee at the seam is scoring `series_unreadable`, and THAT IS THE POINT OF THIS '
        + 'COUNTER: without it a dead daily feed and a quiet market publish the same histogram.';
    case 'degraded':
      return `DEGRADED — ${c.fetchOk} fetches succeeded, ${c.fetchFailed} failed `
        + `(${c.consecutiveFetchFailures} consecutive; last: ${c.lastFailureReason ?? 'n/a'}) and `
        + `${c.skippedFeedBreaker} were SKIPPED with the Yahoo breaker open AND no fallback available; `
        + `${c.fetchOkFallback} were served by the Tradier fallback and ${c.fetchEmptyFallback} of its `
        + 'answers came back empty (it swallows errors to `[]`, so an empty there is a suspected failure). '
        + 'Symbols whose fetch is failing age out through staleness at '
        + `${Math.round(OTM_DAILY_SERIES_MAX_AGE_MS / 60_000)} min and then read `
        + '`series_unreadable`, so a partial outage shows up as a rising `readsStale` rather '
        + 'than as a quiet taxonomy.';
    case 'ok':
    default:
      return 'OK — the refresh is running and every fetch has succeeded. ⚠️ Counters are '
        + `SINCE-BOOT (from ${new Date(c.since).toISOString()}, `
        + `${Math.round((nowMs - c.since) / 60_000)} min ago); a restart zeroes them, so a low `
        + 'total is not evidence of a quiet session. ⛔ `status: ok` says the SOURCE is healthy, '
        + 'never that the taxonomy confirmed anything — read '
        + '`verdicts.allReadableSpansSwingHorizon` (graded against '
        + `${Math.round(OTM_DAILY_SERIES_MIN_THESIS_SPAN_MS / DAY_MS)} days, NOT one day: the `
        + '5-minute series this ticket replaced spans ~8.6 calendar days and would clear a '
        + 'one-day bar) for whether the series reaching the seam is the daily one.';
  }
}

/** Test seam: drop the cache, the counters and the sample ring. */
export function __resetOtmDailySeriesForTests(nowMs: number = Date.now()): void {
  cache.clear();
  inFlight.clear();
  samples.length = 0;
  verdictsRecorded = 0;
  counters.refreshPasses = 0;
  counters.refreshRotations = 0;
  counters.symbolsAttempted = 0;
  counters.fetchOk = 0;
  counters.fetchEmpty = 0;
  counters.fetchFailed = 0;
  counters.skippedFeedBreaker = 0;
  counters.skippedFresh = 0;
  counters.fetchOkFallback = 0;
  counters.fetchEmptyFallback = 0;
  counters.consecutiveFetchFailures = 0;
  counters.lastOkAt = null;
  counters.lastFailureAt = null;
  counters.lastFailureReason = null;
  counters.readsFresh = 0;
  counters.readsStale = 0;
  counters.readsAbsent = 0;
  counters.evicted = 0;
  counters.since = nowMs;
}
