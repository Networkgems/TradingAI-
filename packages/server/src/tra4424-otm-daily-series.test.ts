import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { evaluateSetupTaxonomy } from '@trading-app/engine';
import {
  readOtmDailySeries,
  storeOtmDailySeries,
  noteOtmDailySeriesFailure,
  noteOtmDailySeriesBreakerSkip,
  noteOtmDailySeriesPass,
  noteOtmDailySeriesVerdict,
  pruneOtmDailySeries,
  otmDailySeriesHealth,
  __resetOtmDailySeriesForTests,
  OTM_DAILY_SERIES_BARS,
  OTM_DAILY_SERIES_BUDGET_MS,
  OTM_DAILY_SERIES_MAX_AGE_MS,
  OTM_DAILY_SERIES_SAMPLE_CAP,
} from './otm-daily-series.js';

/**
 * TRA-4424 (parent TRA-4421, off TRA-4422 Finding 1) — the daily-bar source for
 * the OTM nomination seam.
 *
 * This file grades the MODULE (read policy, counters, status) and the
 * PLACEMENT (the refresh is off the order path). The end-to-end claim — that
 * the seam scores the daily series and publishes a multi-day `seriesSpanMs` —
 * is graded BEHAVIOURALLY through the real `runOtmScan` in
 * `signal-engine.test.ts`, because a wrong-timeframe series RUNS and a source
 * grep cannot tell a scored series from a mentioned one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;
const T0 = Date.parse('2026-09-09T14:20:00Z');

function bars(n: number, stepMs: number, symbol = 'AAPL'): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol,
    timestamp: T0 - (n - 1 - i) * stepMs,
    open: 100, high: 101, low: 99, close: 100.5, volume: 1_000,
  }));
}

beforeEach(() => {
  __resetOtmDailySeriesForTests(T0);
});

// ─── THE READ POLICY ─────────────────────────────────────────────────────────
describe('read policy — an unreadable cache returns an EMPTY series, never a short one', () => {
  it('absent: no entry ⇒ empty bars, state `absent`, no age', () => {
    const r = readOtmDailySeries('AAPL', T0);
    expect(r.bars).toEqual([]);
    expect(r.state).toBe('absent');
    expect(r.ageMs).toBeNull();
  });

  it('fresh: a stored entry inside the age bound comes back whole', () => {
    storeOtmDailySeries('AAPL', bars(120, DAY_MS), T0);
    const r = readOtmDailySeries('AAPL', T0 + 60_000);
    expect(r.state).toBe('fresh');
    expect(r.bars).toHaveLength(120);
    expect(r.ageMs).toBe(60_000);
  });

  // ⛔ THE LAUNDERING CASE. Handing the taxonomy a stale-but-LONG series would
  // score it as a confident `no_setup_matched` — a dead feed rendered as a real
  // negative, which is exactly the split `series_unreadable` exists to make.
  it('stale: past the age bound the bars are WITHHELD, not returned with a warning', () => {
    storeOtmDailySeries('AAPL', bars(120, DAY_MS), T0);
    const r = readOtmDailySeries('AAPL', T0 + OTM_DAILY_SERIES_MAX_AGE_MS + 1);
    expect(r.state).toBe('stale');
    expect(r.bars).toEqual([]);
    expect(r.ageMs).toBeGreaterThan(OTM_DAILY_SERIES_MAX_AGE_MS);
  });

  it('the bound is inclusive at the edge — exactly at max age is still fresh', () => {
    storeOtmDailySeries('AAPL', bars(120, DAY_MS), T0);
    expect(readOtmDailySeries('AAPL', T0 + OTM_DAILY_SERIES_MAX_AGE_MS).state).toBe('fresh');
  });

  // `absent` and `stale` have different remedies (never fetched vs stopped
  // being fetched). Pooling them re-creates one layer down the ambiguity this
  // whole instrument exists to split.
  it('absent and stale are COUNTED separately', () => {
    readOtmDailySeries('NOPE', T0);
    storeOtmDailySeries('AAPL', bars(120, DAY_MS), T0);
    readOtmDailySeries('AAPL', T0 + OTM_DAILY_SERIES_MAX_AGE_MS + 1);
    readOtmDailySeries('AAPL', T0);
    const c = otmDailySeriesHealth(T0).counters;
    expect(c.readsAbsent).toBe(1);
    expect(c.readsStale).toBe(1);
    expect(c.readsFresh).toBe(1);
  });

  it('stores at most `OTM_DAILY_SERIES_BARS`, keeping the NEWEST', () => {
    const deep = bars(400, DAY_MS);
    storeOtmDailySeries('AAPL', deep, T0);
    const r = readOtmDailySeries('AAPL', T0);
    expect(r.bars).toHaveLength(OTM_DAILY_SERIES_BARS);
    expect(r.bars[r.bars.length - 1]!.timestamp).toBe(deep[deep.length - 1]!.timestamp);
  });
});

// ─── THE COMPOSITION WITH THE PURE TAXONOMY ──────────────────────────────────
// ⛔ THE POINT OF TRA-4424 IN ONE ASSERTION: the same bar COUNT, two timeframes,
// two different questions. Both series below are 120 bars; only one of them can
// carry a multi-day thesis, and `bars` alone cannot tell them apart.
describe('the span, not the bar count, is what distinguishes the two series', () => {
  it('120 DAILY bars span months; 120 FIVE-MINUTE bars span hours — same count', () => {
    const daily = evaluateSetupTaxonomy({ symbol: 'AAPL', series: bars(120, DAY_MS), nomineeSide: 'call' });
    const intraday = evaluateSetupTaxonomy({ symbol: 'AAPL', series: bars(120, FIVE_MIN_MS), nomineeSide: 'call' });

    expect(daily.bars).toBe(intraday.bars);
    expect(daily.reasonCode).toBe(intraday.reasonCode); // both readable, both no-match
    // …and the ONLY field that separates them is the span.
    expect(daily.seriesSpanMs).toBe(119 * DAY_MS);
    expect(intraday.seriesSpanMs).toBe(119 * FIVE_MIN_MS);
    expect(daily.seriesSpanMs!).toBeGreaterThan(20 * DAY_MS);
    expect(intraday.seriesSpanMs!).toBeLessThan(DAY_MS);
  });

  // The 6.15-trading-day depth named in the filing, scored end to end: it is
  // READABLE and it is the wrong timeframe. That is the whole hazard.
  it('the shadow cache depth (480 five-minute bars) is READABLE and still sub-2-day', () => {
    const v = evaluateSetupTaxonomy({ symbol: 'AAPL', series: bars(480, FIVE_MIN_MS), nomineeSide: 'call' });
    expect(v.reasonCode).toBe('no_setup_matched'); // NOT `series_unreadable`
    expect(v.seriesSpanMs!).toBeLessThan(2 * DAY_MS);
  });

  it('an empty read produces `series_unreadable` with NO span', () => {
    const r = readOtmDailySeries('AAPL', T0);
    const v = evaluateSetupTaxonomy({ symbol: 'AAPL', series: r.bars, nomineeSide: 'call' });
    expect(v.reasonCode).toBe('series_unreadable');
    expect(v.seriesSpanMs).toBeNull();
    expect(v.bars).toBe(0);
  });
});

// ─── THE COUNTERS ────────────────────────────────────────────────────────────
describe('refresh counters — a dead feed must not read like a quiet market', () => {
  it('⛔ a refresh that never ran is `unmeasured`, NOT `ok`', () => {
    const h = otmDailySeriesHealth(T0);
    expect(h.status).toBe('unmeasured');
    expect(h.counters.refreshPasses).toBe(0);
    expect(h.note).toContain('UNMEASURED');
  });

  it('⛔ and `unmeasured` outranks every other branch — an all-zero record cannot render healthy', () => {
    // The mutation this guards: reordering the status ladder so `ok` is reached
    // first. Every non-`unmeasured` branch is satisfied by an all-zero record,
    // which is precisely what a never-wired refresh produces.
    expect(otmDailySeriesHealth(T0).status).not.toBe('ok');
  });

  it('all-fail: passes ran and nothing succeeded ⇒ `failing`, with the reason', () => {
    noteOtmDailySeriesFailure('AAPL', 'yahoo 502', T0);
    noteOtmDailySeriesFailure('MSFT', 'yahoo 502', T0);
    noteOtmDailySeriesPass(true);
    const h = otmDailySeriesHealth(T0);
    expect(h.status).toBe('failing');
    expect(h.counters.fetchFailed).toBe(2);
    expect(h.counters.consecutiveFetchFailures).toBe(2);
    expect(h.counters.lastFailureReason).toBe('MSFT: yahoo 502');
    expect(h.counters.symbolsAttempted).toBe(2);
    expect(h.note).toContain('FAILING');
  });

  it('partial: some succeed, some fail ⇒ `degraded`, never `ok`', () => {
    storeOtmDailySeries('AAPL', bars(120, DAY_MS), T0);
    noteOtmDailySeriesFailure('MSFT', 'timeout', T0);
    noteOtmDailySeriesPass(true);
    expect(otmDailySeriesHealth(T0).status).toBe('degraded');
  });

  it('a success RESETS the consecutive run but not the lifetime total', () => {
    noteOtmDailySeriesFailure('AAPL', 'timeout', T0);
    noteOtmDailySeriesFailure('AAPL', 'timeout', T0);
    storeOtmDailySeries('AAPL', bars(120, DAY_MS), T0);
    noteOtmDailySeriesPass(true);
    const c = otmDailySeriesHealth(T0).counters;
    expect(c.consecutiveFetchFailures).toBe(0);
    expect(c.fetchFailed).toBe(2); // the outage still happened
    expect(c.lastOkAt).toBe(T0);
  });

  // An empty answer is a quiet feed, not a broken one — and it must not evict
  // the last good series, or one empty response would blank a symbol that is
  // otherwise perfectly cached.
  it('an EMPTY fetch is its own bucket: not a failure, and it does not evict', () => {
    storeOtmDailySeries('AAPL', bars(120, DAY_MS), T0);
    storeOtmDailySeries('AAPL', [], T0 + 1000);
    noteOtmDailySeriesPass(true);
    const c = otmDailySeriesHealth(T0).counters;
    expect(c.fetchEmpty).toBe(1);
    expect(c.fetchFailed).toBe(0);
    expect(c.consecutiveFetchFailures).toBe(0);
    expect(readOtmDailySeries('AAPL', T0 + 1000).bars).toHaveLength(120);
    expect(otmDailySeriesHealth(T0).status).toBe('ok');
  });

  // ⛔ THE BREAKER TRAP. `fetchDailyCandles` short-circuits to `[]` while Yahoo
  // is rate-limited, so a tripped breaker pooled into `fetchEmpty` would read
  // `ok` — a dead feed publishing the same status as a quiet market, which is
  // the defect this counter set exists to make impossible.
  it('a breaker skip is NOT an empty fetch, and it drops the status off `ok`', () => {
    storeOtmDailySeries('AAPL', bars(120, DAY_MS), T0); // a healthy morning…
    noteOtmDailySeriesBreakerSkip(400); // …then the breaker trips
    noteOtmDailySeriesPass(true);
    const h = otmDailySeriesHealth(T0);
    expect(h.counters.skippedFeedBreaker).toBe(400);
    expect(h.counters.fetchEmpty).toBe(0);
    expect(h.counters.fetchFailed).toBe(0);
    expect(h.status).toBe('degraded');
    expect(h.note).toContain('breaker open');
  });

  it('counters are labelled SINCE-BOOT — a restart zeroes them and the note says so', () => {
    storeOtmDailySeries('AAPL', bars(120, DAY_MS), T0);
    noteOtmDailySeriesPass(true);
    const h = otmDailySeriesHealth(T0);
    expect(h.counters.since).toBe(T0);
    expect(h.note).toContain('SINCE-BOOT');
  });

  it('pruning drops only symbols that left the universe, and counts the evictions', () => {
    storeOtmDailySeries('AAPL', bars(120, DAY_MS), T0);
    storeOtmDailySeries('GONE', bars(120, DAY_MS, 'GONE'), T0);
    pruneOtmDailySeries(['AAPL']);
    expect(readOtmDailySeries('AAPL', T0).state).toBe('fresh');
    expect(readOtmDailySeries('GONE', T0).state).toBe('absent');
    expect(otmDailySeriesHealth(T0).counters.evicted).toBe(1);
    expect(otmDailySeriesHealth(T0).counters.cachedSymbols).toBe(1);
  });
});

// ─── THE VERDICT WINDOW ──────────────────────────────────────────────────────
describe('verdict samples — the published span is the TAXONOMY\'s, and the window is bounded', () => {
  const sample = (spanMs: number | null) => ({
    symbol: 'AAPL', at: T0, readState: 'fresh' as const, bars: 120,
    seriesSpanMs: spanMs, reasonCode: null, confirmed: true,
  });

  it('⛔ an EMPTY window is null, never a measured `false`', () => {
    const v = otmDailySeriesHealth(T0).verdicts;
    expect(v.window).toBe(0);
    expect(v.allSpansMultiDay).toBeNull();
    expect(v.spanMsMin).toBeNull();
  });

  it('a sub-day span in the window flips `allSpansMultiDay` to false', () => {
    noteOtmDailySeriesVerdict(sample(119 * DAY_MS));
    expect(otmDailySeriesHealth(T0).verdicts.allSpansMultiDay).toBe(true);
    noteOtmDailySeriesVerdict(sample(119 * FIVE_MIN_MS));
    const v = otmDailySeriesHealth(T0).verdicts;
    expect(v.allSpansMultiDay).toBe(false);
    expect(v.spanMsMin).toBe(119 * FIVE_MIN_MS);
    expect(v.spanMsMax).toBe(119 * DAY_MS);
  });

  // A null span (an unreadable row) is NOT multi-day. Treating it as one would
  // let a wholly dead source publish `allSpansMultiDay: true`.
  it('a null span is not multi-day', () => {
    noteOtmDailySeriesVerdict(sample(null));
    expect(otmDailySeriesHealth(T0).verdicts.allSpansMultiDay).toBe(false);
  });

  it('the ring is bounded, and the lifetime total is NOT', () => {
    for (let i = 0; i < OTM_DAILY_SERIES_SAMPLE_CAP + 10; i++) noteOtmDailySeriesVerdict(sample(119 * DAY_MS));
    const v = otmDailySeriesHealth(T0).verdicts;
    expect(v.window).toBe(OTM_DAILY_SERIES_SAMPLE_CAP);
    expect(v.recorded).toBe(OTM_DAILY_SERIES_SAMPLE_CAP + 10);
    expect(v.recent).toHaveLength(5);
  });
});

// ─── THE PLACEMENT, source-level ─────────────────────────────────────────────
// The tra2331/tra3218/tra3942 house pattern. This one grades a claim the
// behavioural suite cannot: that the fetch is not merely absent from the scan
// TODAY, but structurally outside it.
describe('TRA-4424 — the refresh is wired OFF the order path', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  // Normalised to LF: the checkout is CRLF on Windows, and a source matcher
  // that depends on the line ending is green on one box and red on another.
  const SRC = readFileSync(join(HERE, 'signal-engine.ts'), 'utf8').replace(/\r\n/g, '\n');

  it('the refresh exists, is budgeted, and is the only caller of `fetchDailyCandles` on this path', () => {
    expect(SRC).toContain('private async refreshOtmDailySeries(');
    const at = SRC.indexOf('private async refreshOtmDailySeries(');
    const body = SRC.slice(at, SRC.indexOf('\n  }\n', at));
    expect(body).toMatch(/runBudgetedSweep\(\{/);
    expect(body).toMatch(/budgetMs: OTM_DAILY_SERIES_BUDGET_MS,/);
    expect(body).toMatch(/fetchDailyCandles\(sym, OTM_DAILY_SERIES_BARS\)/);
    // ⛔ A per-symbol failure is CAUGHT AND COUNTED. Swallowing it is what makes
    // a dead daily feed read as a quiet market.
    expect(body).toMatch(/noteOtmDailySeriesFailure\(/);
    expect(body).toMatch(/noteOtmDailySeriesPass\(pass\.complete\)/);
    // ⛔ THE BREAKER IS ASKED BEFORE THE CALL. `withRetry` short-circuits to
    // `null` while Yahoo is rate-limited, so an un-asked breaker turns an
    // outage into `fetchEmpty` and leaves the status green.
    expect(body).toMatch(/if \(isYahooBreakerOpen\(\)\) \{/);
    expect(body).toMatch(/noteOtmDailySeriesBreakerSkip\(batch\.length\)/);
  });

  // ⛔ THE ORDER-PATH CLAIM, stated as a source invariant. `runOtmScan` is a
  // live order path: a per-symbol network fetch on the NOMINATION leg is
  // latency on that path, and a feed stall becomes an ENTRY STALL.
  //
  // ⚠️ The claim is scoped, because the unscoped version is FALSE and was
  // measured to be: `runOtmScan` reaches `fetchDailyCandles` once per OPEN via
  // `stampOtmAtrInvalidation` (TRA-3943, `OTM_DAILY_ATR_BARS = 40`). That call
  // is POST-FILL and pre-dates this item. What must stay true is that the
  // SETUP SEAM adds no fetch and does not trigger the refresh.
  it('the seam adds NO fetch to `runOtmScan`, and the scan never calls the refresh', () => {
    const at = SRC.indexOf('private async runOtmScan(');
    expect(at).toBeGreaterThan(-1);
    // The scan runs to the next same-indent private member.
    const rest = SRC.slice(at);
    const end = rest.indexOf('\n  private ', 1);
    const body = rest.slice(0, end > 0 ? end : rest.length);
    expect(body).toContain('this.otmSetupTaxonomyDecision(');
    expect(body).not.toMatch(/refreshOtmDailySeries\(/);
    expect(body).not.toMatch(/OTM_DAILY_SERIES_BARS/);
  });

  // …and the seam METHOD itself is a pure lookup. This is the assertion that
  // actually pins "no IO on the nomination leg": the body above is thousands of
  // lines and a fetch could hide anywhere in it.
  it('`otmSetupTaxonomyDecision` does a Map read and no IO at all', () => {
    const at = SRC.indexOf('private otmSetupTaxonomyDecision(');
    const body = SRC.slice(at, SRC.indexOf('\n  }\n', at));
    expect(body).toMatch(/const daily = readOtmDailySeries\(sym\);/);
    expect(body).not.toMatch(/\bawait\b/);
    expect(body).not.toMatch(/fetch[A-Z]/);
  });

  // The refresh must run BEFORE the scan in the tick, or the cache it fills is
  // always one rotation behind the seam that reads it.
  it('the tick calls the refresh ABOVE the scan, inside the same arm gate', () => {
    const refresh = SRC.indexOf("'signal.doTick.otm-daily-series'");
    const scan = SRC.indexOf("'signal.doTick.otm-scan'");
    const gate = SRC.indexOf('if (shouldRunOtmScan({');
    expect(refresh).toBeGreaterThan(gate);
    expect(scan).toBeGreaterThan(refresh);
  });

  // TRA-2477's property: an unfinished rotation re-enters on the NEXT tick,
  // ahead of the cadence gate. Without it the small budget would divide the
  // sink's symbols-per-minute instead of bounding its per-tick contribution.
  it('an unfinished rotation re-enters ahead of the cadence gate', () => {
    const at = SRC.indexOf('const resumingDaily =');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 600);
    expect(body).toMatch(/resumingDaily\s*\n?\s*\|\|\s*Date\.now\(\) - this\.lastOtmDailyRefreshAt >= OTM_DAILY_SERIES_REFRESH_MS/);
    expect(body).toMatch(/if \(!resumingDaily\) this\.lastOtmDailyRefreshAt = Date\.now\(\)/);
  });

  it('the budget is SMALLER than the shared sweep budget — this sink is not urgent', () => {
    expect(OTM_DAILY_SERIES_BUDGET_MS).toBeLessThan(30_000);
  });
});
