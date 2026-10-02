import type { Candle } from '@trading-app/shared';

/**
 * TRA-4986 — ONE process-global store for the per-symbol MINUTE-bar series that
 * backs the live equity strategies. The third subject of TRA-4158's hoist, and
 * by nested-object count the largest of the three.
 *
 * ## The measurement that filed it
 *
 * `GET /api/health/heap-census?deep=true`, bqb1, pid 76, `faae938837bf`,
 * re-read `2026-10-01T19:06:41Z` at uptime 89.73 h:
 *
 * | row | owners | entries | maxEntries | deep nested |
 * |---|---|---|---|---|
 * | `signalEngine.candleCache` | **68** | 6,608 | 99 | **527,371** |
 * | *(ref)* `marketData.dailyCloses` | 1 | 449 | 449 | 112,841 |
 * | *(ref)* `marketData.dailyBars` | 1 | 447 | 447 | 112,840 |
 *
 * 527,371 nested `Candle`s is **2.34x** the two maps TRA-4158 hoisted combined
 * (225,681), and those two returned a measured −330.7 MB of matched-quiescent
 * heap. The row is **already bounded and already plateaued** — 99 entries on the
 * worst owner, ring delta 0 across a 23.9 h tape — so a cap or a TTL buys
 * nothing here and would be a regression dressed as a fix. What pays for it is
 * the same **multiplier** TRA-4158 named: one `SignalEngine` per user,
 * 68 owners, each holding a private copy of data with no user dimension in it.
 *
 * ## AC1 — why the content is user-independent, by construction and not by claim
 *
 * `candleCache` had exactly **one writer in the whole server** —
 * `SignalEngine.refreshCandles`, `candleCache.set(symbol, bars)` — against ten
 * `get()` readers, and that writer's only source is
 *
 *     fetchMinuteBarsWithSource(symbol, 80)
 *
 * whose signature carries **no user, no account and no engine**. Behind it sits
 * `yahoo-feed.ts`'s `minuteBarCache` — itself already a single process-global
 * map, keyed by ticker, with a TRA-739 singleflight in front so 68 concurrent
 * callers for the same symbol collapse to ONE upstream request.
 *
 * So the 68 copies were never 68 independent pulls. They are 68 **`.slice()`
 * copies of one shared cache entry**: `fetchMinuteBarsWithSource` returns
 * `entry.bars.slice(-count)`, which mints a fresh 80-element array per call.
 * That one line is the entire origin of the duplication — the identity differs
 * because of a slice, the content does not differ at all.
 *
 * Note what that makes the falsifiable claim. "Two engines caching symbol S hold
 * byte-identical candle arrays" is **not** true at an arbitrary instant, and the
 * honest reason is *staleness, not tenancy*: the cold-bar scan is per-engine and
 * sharded (TRA-739/TRA-3441), so engine A may last have refreshed S three ticks
 * before engine B. The two copies are each a slice of the same shared entry *at
 * the time that engine's pass ran*. The question that actually decides whether
 * sharing is sound is therefore narrower and sharper:
 *
 *   **does any write ever disagree with the held series at the SAME newest-bar
 *   instant?**
 *
 * A disagreement there would mean two callers genuinely saw different data for
 * one symbol at one time — the only shape under which one shared copy could be
 * wrong for somebody. {@link candleShareStats} counts exactly that, on every
 * write, for the whole boot, and publishes a witness when it happens. It is the
 * comparison rather than an assertion, which is what AC1 asked for.
 *
 * ## Why this is LAST-WRITER-WINS with no ordering rule, unlike `setDailyBars`
 *
 * TRA-4158 had to invent `DEEPEST-OR-EQUAL-WINS` for `dailyBars` because that
 * container had **two writers at two different depths** (260 vs 40 bars) and
 * `atr()` is Wilder-smoothed over every candle handed in, so the per-engine map
 * made a published number depend on write order. None of that holds here:
 *
 *  - **one** writer, so there is no second convention to reconcile;
 *  - **one** depth — `count = 80`, a literal at the single call site;
 *  - **one** upstream, already deduped by `minuteBarInflight`.
 *
 * Keeping it last-writer-wins therefore makes this hoist a **zero-change** on
 * per-key semantics, which is the bar a memory fix has to clear: it must not
 * quietly move a number the desk publishes. A monotone "never go backwards"
 * guard was considered and deliberately NOT shipped — it would be new behaviour
 * introduced on a live-money path on the strength of a hazard nobody has
 * measured. Instead the hazard is instrumented: {@link CandleShareStats.olderSeries}
 * counts writes whose newest bar goes backwards, so if the race is real it
 * arrives as a number with a witness attached rather than as a guess, and the
 * guard can then be argued from evidence.
 *
 * What the hoist *does* change, and it is an improvement rather than a drift, is
 * **freshness**: one key refreshed by 68 sharded writers is on average newer
 * than any single engine's own last write of it, and every reader already gates
 * on bar age (`MAX_CANDLE_AGE_MS` = 720 s) rather than trusting the cache blind.
 *
 * ## Why the shared store needs no cap of its own
 *
 * Its key set is the UNION of the engines' scan universes, and each of those is
 * capped at `resolveScanSymbolLimit()` = 100 (TRA-4830). So the union is bounded
 * above by `68 x 100 = 6,800` — i.e. by **today's fleet total of 6,608**, which
 * is the worst case and therefore not a regression even if the universes turn
 * out to be disjoint. The saving is `6,608 - |union|` entries, and `|union|` is
 * not assumed: after the hoist it is simply the `entries` on the
 * `marketData.minuteCandles` census row, published in the same read as the
 * now-absent per-engine row.
 *
 * `dynamicSymbols` being unbounded (the other half of TRA-4986) does **not**
 * leak in here: only the 100 symbols that survive `boundActiveSymbols()` ever
 * reach the cold-bar scan, so an engine with 782 tracked names still writes at
 * most 100 keys.
 *
 * ## Sharing is safe by CONTENT
 *
 * A `Candle` holds `{symbol, timestamp, open, high, low, close, volume}` and
 * nothing else — public exchange OHLCV keyed by ticker, no per-user field, so
 * one process-global copy cannot leak anything between tenants. Every one of the
 * ten readers does a keyed `get()` for a symbol it already decided to look at:
 * nothing iterates the map, nothing reads `.size`, and nothing clears or deletes
 * (verified exhaustively over the server sources before the hoist). So a reader
 * cannot be surprised by the extra keys a neighbour's universe contributes, and
 * no per-user reset has to be ported across.
 *
 * Writers REPLACE the array wholesale rather than appending, which is what makes
 * handing one array to 68 engines sound.
 */

/** The shared per-symbol minute-bar series. One copy, process-wide. */
const minuteCandles = new Map<string, Candle[]>();

/**
 * One recorded disagreement between an incoming write and the held series.
 * Symbol + timestamps + the field that differed; never the whole series, so the
 * witness cannot itself become a retainer.
 */
export interface CandleDivergence {
  symbol: string;
  /** Newest bar timestamp, shared by both series (that is what makes it a divergence). */
  newestMs: number;
  heldLength: number;
  incomingLength: number;
  /** Index into the compared tail where the two first disagreed. */
  atIndex: number;
  /** `open` | `high` | `low` | `close` | `volume` | `timestamp`. */
  field: string;
  heldValue: number;
  incomingValue: number;
}

/**
 * The AC1 comparison, accumulated over every write since boot.
 *
 * Read `divergentSameInstant` first: it is the only counter that can falsify
 * sharing. Everything else is colour that explains the shape of the traffic.
 */
export interface CandleShareStats {
  /** `setCandles` calls that stored a series (empty pulls never reach here). */
  writes: number;
  /** Distinct symbols currently held — i.e. `|union|`, the hoist's own payoff. */
  symbols: number;
  /** Writes that found a series already held for that symbol. */
  rewrites: number;
  /** Rewrites whose incoming array was literally the SAME OBJECT as the held one. */
  sameReference: number;
  /** Rewrites equal on length and on every field of every bar. */
  equalByValue: number;
  /**
   * Rewrites that differ and whose newest bar is strictly NEWER. The expected
   * shape of an ordinary refresh, and — under the per-engine map — the entire
   * reason 68 copies could ever disagree: each engine refreshed on its own
   * sharded cadence, not because it was a different user.
   */
  newerSeries: number;
  /**
   * Rewrites whose newest bar goes BACKWARDS. Zero is the expected reading. A
   * non-zero count is the measured case for a monotone write guard, which this
   * module deliberately does not ship unmeasured (see the module note).
   */
  olderSeries: number;
  /**
   * ⭐ THE FALSIFIER. Rewrites that report the SAME newest-bar timestamp as the
   * held series and still disagree on some field. Under one shared copy, one of
   * the two callers would be reading a series it did not itself fetch — so this
   * must stay 0 for the hoist to be sound, and it is published rather than
   * asserted.
   */
  divergentSameInstant: number;
  /** Bounded witness ring for {@link divergentSameInstant}. */
  divergentWitness: CandleDivergence[];
  /** Full element-wise comparisons performed (the instrument's own cost basis). */
  comparisons: number;
}

/** Cap on the witness ring — an instrument must not become the leak it hunts. */
const MAX_DIVERGENCE_WITNESS = 20;

const stats = {
  writes: 0,
  rewrites: 0,
  sameReference: 0,
  equalByValue: 0,
  newerSeries: 0,
  olderSeries: 0,
  divergentSameInstant: 0,
  comparisons: 0,
};
const divergenceWitness: CandleDivergence[] = [];

/** Newest bar timestamp in a series, or `null` for an empty one. */
function newestMs(bars: readonly Candle[]): number | null {
  return bars.length > 0 ? (bars[bars.length - 1]?.timestamp ?? null) : null;
}

/**
 * First field-level disagreement between the common TAIL of two series, or
 * `null` when the overlapping tail agrees everywhere.
 *
 * Compared from the NEWEST end backwards over `min(len)` bars, because the two
 * may legitimately carry different amounts of history off the same feed and it
 * is the recent end every consumer actually reads. A length difference alone is
 * therefore not a divergence — `heldLength`/`incomingLength` on the witness
 * carry it instead.
 */
function firstDisagreement(held: readonly Candle[], incoming: readonly Candle[]): Omit<CandleDivergence, 'symbol' | 'newestMs'> | null {
  const overlap = Math.min(held.length, incoming.length);
  for (let i = 0; i < overlap; i += 1) {
    const h = held[held.length - 1 - i];
    const n = incoming[incoming.length - 1 - i];
    if (!h || !n) continue;
    const fields: readonly (keyof Candle & ('timestamp' | 'open' | 'high' | 'low' | 'close' | 'volume'))[] = [
      'timestamp', 'open', 'high', 'low', 'close', 'volume',
    ];
    for (const f of fields) {
      if (h[f] !== n[f]) {
        return {
          heldLength: held.length,
          incomingLength: incoming.length,
          atIndex: i,
          field: f,
          heldValue: h[f],
          incomingValue: n[f],
        };
      }
    }
  }
  return null;
}

/** The series for `symbol`, or `undefined` when never stored. */
export function getCandles(symbol: string): Candle[] | undefined {
  return minuteCandles.get(symbol);
}

/**
 * Store the minute-bar series for `symbol`. **LAST-WRITER-WINS**, byte-for-byte
 * the semantics of the per-engine `candleCache.set` it replaces — see the module
 * note for why this one needs no ordering rule where `setDailyBars` did.
 *
 * The classification above the store is the AC1 instrument: it is the only place
 * in the process that can see two callers' views of one symbol meet, which is
 * precisely the comparison the per-engine map made unobservable.
 */
export function setCandles(symbol: string, bars: Candle[]): void {
  const held = minuteCandles.get(symbol);
  stats.writes += 1;
  if (held) {
    stats.rewrites += 1;
    if (held === bars) {
      stats.sameReference += 1;
    } else {
      const heldNewest = newestMs(held);
      const incomingNewest = newestMs(bars);
      stats.comparisons += 1;
      const diff = firstDisagreement(held, bars);
      if (diff === null && held.length === bars.length) {
        stats.equalByValue += 1;
      } else if (heldNewest !== null && incomingNewest !== null && incomingNewest > heldNewest) {
        stats.newerSeries += 1;
      } else if (heldNewest !== null && incomingNewest !== null && incomingNewest < heldNewest) {
        stats.olderSeries += 1;
      } else if (diff !== null) {
        // Same newest instant (or both empty-ended) and still disagreeing.
        stats.divergentSameInstant += 1;
        if (divergenceWitness.length < MAX_DIVERGENCE_WITNESS) {
          divergenceWitness.push({ symbol, newestMs: incomingNewest ?? -1, ...diff });
        }
      } else {
        // Same instant, tail agrees, lengths differ — one series simply carries
        // more history. Not a divergence; booked as the ordinary refresh it is.
        stats.equalByValue += 1;
      }
    }
  }
  minuteCandles.set(symbol, bars);
}

/** The published AC1 comparison. See {@link CandleShareStats}. */
export function candleShareStats(): CandleShareStats {
  return {
    writes: stats.writes,
    symbols: minuteCandles.size,
    rewrites: stats.rewrites,
    sameReference: stats.sameReference,
    equalByValue: stats.equalByValue,
    newerSeries: stats.newerSeries,
    olderSeries: stats.olderSeries,
    divergentSameInstant: stats.divergentSameInstant,
    divergentWitness: [...divergenceWitness],
    comparisons: stats.comparisons,
  };
}

/**
 * The census walks own enumerable DATA properties of whatever object it is
 * handed, so the map has to hang off a real object to stay visible. Exposed for
 * that instrument only.
 *
 * Keeping it in the census is the AC2 proof and is not cosmetic. A successful
 * hoist makes `signalEngine.candleCache` vanish from the census **entirely** —
 * it becomes a prototype accessor, which is neither an own property nor a data
 * property — and an absent row is byte-identical to the instrument having gone
 * blind. So the replacement row has to appear under `marketData.minuteCandles`
 * with `owners: 1` in the SAME read. Note the discriminator TRA-4158 had to
 * correct: the success condition is **absent**, never `owners: 0`.
 */
export const marketDataCandleCacheCensusTarget: { minuteCandles: Map<string, Candle[]> } = {
  minuteCandles,
};

/** Entry count, for tests and for a cheap non-deep read. */
export function marketDataCandleCacheSize(): number {
  return minuteCandles.size;
}

/**
 * TRA-4986 (AC4) — iterate the held series, for the retained-bytes measurement
 * in `candle-hoist-pricing.ts`.
 *
 * Returns the live iterator rather than a materialised array on purpose: the
 * caller samples a bounded prefix and stops, so nothing here is O(store). The
 * arrays it yields are the REAL ones — the pricing path must never mutate them,
 * and it does not: it only copies.
 */
export function marketDataCandleCacheEntries(): IterableIterator<[string, Candle[]]> {
  return minuteCandles.entries();
}

/**
 * Test-only reset. A process-global store outlives a `beforeEach`, so without
 * this one suite's seeded candles silently satisfy another suite's cold-cache
 * assertion — the green-for-the-wrong-reason direction TRA-4158 hit on
 * `seedCloses()`. The three suites that seed `candleCache` through a private
 * cast (`equity-entry-funnel`, `position-advisor`, `cold-bar-budget`) all call
 * this; `cold-bar-budget` additionally asserts on `.size`, which cross-test
 * residue would silently inflate.
 */
export function __resetMarketDataCandleCacheForTest(): void {
  minuteCandles.clear();
  stats.writes = 0;
  stats.rewrites = 0;
  stats.sameReference = 0;
  stats.equalByValue = 0;
  stats.newerSeries = 0;
  stats.olderSeries = 0;
  stats.divergentSameInstant = 0;
  stats.comparisons = 0;
  divergenceWitness.length = 0;
}
