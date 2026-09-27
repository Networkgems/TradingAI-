import type { Candle } from '@trading-app/shared';

/**
 * TRA-4158 — ONE process-global store for symbol-keyed DAILY market data.
 *
 * ## Why this exists — the measurement, not a hunch
 *
 * The heap census (`heap-retainer-census.ts`) named the retainers on a full RTH
 * session, and then a matched-quiescent A/B priced them. Both reads are
 * zero-activity, so the only variable is whether the session caches are empty or
 * full:
 *
 * | quiescent read | mean `heapUsed` |
 * |---|---|
 * | caches EMPTY (2026-09-24 pre-open, n=125 over 10.4h) | 271.3 MB |
 * | caches FULL (2026-09-26/27 weekend, n=288 over 23.92h) | 802.3 MB |
 *
 * `+531.0 MB` retained at matched zero activity, corroborated by the 09-24
 * in-session series (573.9 MB over the same 6.50 RTH-h, on a different boot AND
 * a different commit). And nothing gives it back: across that 23.92h quiescent
 * span, **52 of 53** tracked containers held `min == max` — not one entry evicted
 * 50 hours after the close — with the OLS slope at `-0.13 MB/h`, i.e. a FIXED
 * retained working set rather than a creeping leak.
 *
 * ## Why the fix is a hoist and NOT a bound or a TTL
 *
 * The named containers **plateau**: they are universe-bounded (~100 entries per
 * engine, and the fleet total stops moving mid-session). A cap or an eviction on
 * a container that already self-limits buys almost nothing. What is actually
 * paying for the 531 MB is the **multiplier**: one `SignalEngine` is constructed
 * PER USER (`user-context.ts` `createUserContext`, and the registry never
 * evicts), so on bqb1 there are **68 owners**, each holding its own private copy
 * of data that is **user-independent by definition** — AAPL's daily OHLCV is the
 * same series for every user on the box.
 *
 * Measured 2026-09-27, live, deep census (`?deep=1`):
 *
 * | container | owners | entries | nested |
 * |---|---|---|---|
 * | `signalEngine.dailyCloseCache` | 68 | 6793 | 1,726,055 `number` |
 * | `signalEngine.otmDailyBarCache` | 68 | 6789 | 1,726,051 `Candle` |
 *
 * ~100 symbols per engine against a watchlist union of ~614 distinct names, so
 * collapsing 68 copies to one is a **~11x cut on entries** and removes ~1.7M
 * `Candle` objects — the heavier of the two by roughly 20x in bytes, since
 * `dailyCloseCache` stores `dailyBars.map(b => b.close)` (a packed double array)
 * beside the full `Candle[]` taken off the *same* pull.
 *
 * ## What this module deliberately does NOT change
 *
 * It is a HOIST. Per-key semantics are preserved, because a memory fix must not
 * quietly move a number the desk publishes:
 *
 * - **Closes are LAST-WRITER-WINS**, exactly as the per-engine map was. All three
 *   writers pull at the same depth (`MTF_DAILY_BARS`), and for a trailing
 *   realised-vol series freshness beats length: a shorter FRESH pull must be
 *   allowed to replace a longer stale one.
 * - **Bars are DEEPEST-OR-EQUAL-WINS.** This is the one place the rule is
 *   written down rather than inherited, and it needs its reason on the record.
 *   There are two writers at two different depths — the technical-snapshot pass
 *   stores `MTF_DAILY_BARS` (260) and `otmDailyAtr`'s cold path stores
 *   `OTM_DAILY_ATR_BARS` (40) — and `atr()` is Wilder-smoothed over **every**
 *   candle it is handed, so those two series yield DIFFERENT ATRs for the same
 *   symbol on the same day. Under the per-engine map that made the published
 *   `otmAtrInvalidationLevel` depend on write order. Equal depth still wins, so
 *   the snapshot pass keeps refreshing normally at 260; only a strictly
 *   shallower series loses. The live box already converges on the 260-bar read
 *   (the snapshot pass runs continuously), so this pins the value the fleet
 *   already reports instead of introducing a new one.
 *
 *   ⚠️ Whether 260 is the depth the OTM sleeve's ATR *should* use is a separate,
 *   live-money question — `OTM_DAILY_ATR_BARS = 40` states an intent the warm
 *   path has never honoured — and it is NOT settled here. Changing a published
 *   ATR inside a heap fix is exactly the shape this codebase keeps getting
 *   burned by. It is filed on its own.
 *
 * ## Sharing is safe by CONTENT, and that is the load-bearing claim
 *
 * Both containers hold public daily OHLCV keyed by ticker: there is no per-user
 * field in either value, so one process-global copy cannot leak anything between
 * tenants. The values are also treated as immutable by every consumer — the
 * closes array is typed `readonly number[]` at `scanIvRvFromSnapshot` and
 * `atr()` only reads — and writers REPLACE the array wholesale rather than
 * appending to it. That is what makes handing the same array to 68 engines
 * sound; `dailyBarsDepth` is published so a future in-place mutation is at least
 * visible as a depth that stopped matching its writer.
 */

/** Cache of trailing daily CLOSES per symbol (TRA-1156's realised-vol input). */
const dailyCloses = new Map<string, number[]>();

/** Cache of full daily CANDLES per symbol (TRA-3943's OTM entry-ATR input). */
const dailyBars = new Map<string, Candle[]>();

/**
 * The census walks own enumerable DATA properties of whatever object it is
 * handed, so the two maps have to hang off a real object to stay visible. They
 * are exposed only for that instrument.
 *
 * Keeping them in the census is not cosmetic. A successful hoist DROPS
 * `signalEngine.dailyCloseCache` / `signalEngine.otmDailyBarCache` to zero
 * owners, which is byte-identical to the instrument going blind on them — so the
 * replacement rows have to appear under a new class in the same read, or the
 * AC2 proof cannot tell "moved" from "stopped looking".
 */
export const marketDataDailyCacheCensusTarget: { dailyCloses: Map<string, number[]>; dailyBars: Map<string, Candle[]> } = {
  dailyCloses,
  dailyBars,
};

/** Trailing daily closes for `symbol`, or `undefined` when never stored. */
export function getDailyCloses(symbol: string): number[] | undefined {
  return dailyCloses.get(symbol);
}

/**
 * Store trailing daily closes for `symbol`. LAST-WRITER-WINS — see the module
 * note: freshness outranks length for a realised-vol series.
 */
export function setDailyCloses(symbol: string, closes: number[]): void {
  dailyCloses.set(symbol, closes);
}

/** Full daily candles for `symbol`, or `undefined` when never stored. */
export function getDailyBars(symbol: string): Candle[] | undefined {
  return dailyBars.get(symbol);
}

/**
 * Store daily candles for `symbol`. DEEPEST-OR-EQUAL-WINS: a strictly shallower
 * series is refused so the 40-bar cold ATR pull cannot clobber the 260-bar series
 * the technical-snapshot pass maintains, which would move the published
 * `otmAtrInvalidationLevel`. Equal depth wins, so ordinary refreshes still land.
 *
 * Returns whether the write was taken, so a caller can tell "stored" from
 * "refused as shallower" without re-reading the map.
 */
export function setDailyBars(symbol: string, bars: Candle[]): boolean {
  const held = dailyBars.get(symbol);
  if (held && held.length > bars.length) return false;
  dailyBars.set(symbol, bars);
  return true;
}

/** Depth of the stored series, for the depth-provenance note above. */
export function dailyBarsDepth(symbol: string): number | null {
  return dailyBars.get(symbol)?.length ?? null;
}

/** Entry counts, for tests and for a cheap non-deep read. */
export function marketDataDailyCacheSizes(): { dailyCloses: number; dailyBars: number } {
  return { dailyCloses: dailyCloses.size, dailyBars: dailyBars.size };
}

/**
 * Test-only reset. A process-global store outlives a `beforeEach`, so without
 * this one suite's seeded closes silently satisfy another suite's cold-cache
 * assertion — the green-for-the-wrong-reason direction.
 */
export function __resetMarketDataDailyCacheForTest(): void {
  dailyCloses.clear();
  dailyBars.clear();
}
