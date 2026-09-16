import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NewsItem } from '@trading-app/shared';
import { buildNewsCatalystPicks, type CatalystMetrics } from './news-catalyst-source.js';
import {
  summarizeCatalystRuns,
  setNewsCatalystRunLedgerFileForTests,
} from './news-catalyst-run-ledger.js';
import {
  listNewsCatalystSignals,
  setNewsCatalystLedgerFileForTests,
} from './news-catalyst-ledger.js';

// TRA-2064 — the defect that cost 6 sessions was NOT the empty result; it was
// that two different causes wrote the identical row.
//
// `fetchMarketNews` never throws: on total feed failure it resolves to an empty
// list, exactly like a genuinely quiet news day. Both landed on
// `no_mapped_candidates / headlineCount: 0`, so the real cause (every query
// resolving to nothing) was unfalsifiable from the health probe.
//
// These tests hold the two apart. They are the regression that makes a future
// feed outage legible instead of silent.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nc-feed-'));
  setNewsCatalystRunLedgerFileForTests(join(dir, 'runs.jsonl'));
  setNewsCatalystLedgerFileForTests(join(dir, 'signals.jsonl'));
});

afterEach(() => {
  setNewsCatalystRunLedgerFileForTests(null);
  setNewsCatalystLedgerFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 6, 20, 13, 0);

const deps = (feed: {
  items: never[];
  queriesAttempted: number;
  queriesSucceeded: number;
}) => ({
  fetchNews: async () => feed,
  fetchMetrics: async () => ({ price: null, avgDollarVol: null, rvolZ: 0, gapPct: 0 }),
  earningsInDays: () => null,
  now: NOW,
});

describe('news-catalyst feed health — outage vs quiet day', () => {
  it('files a total query failure as fetch_degraded, NOT as an empty news day', async () => {
    const picks = await buildNewsCatalystPicks(
      deps({ items: [], queriesAttempted: 25, queriesSucceeded: 0 }),
    );
    expect(picks).toEqual([]);

    const s = await summarizeCatalystRuns();
    expect(s.lastRunOutcome).toBe('fetch_degraded');
    // NOT 0 — nothing was measured, because no query answered. A `0` here is
    // precisely the false zero that hid this bug.
    expect(s.lastRunHeadlineCount).toBeNull();
    expect(s.lastRunQueriesAttempted).toBe(25);
    expect(s.lastRunQueriesSucceeded).toBe(0);
  });

  it('files a genuinely quiet day as no_mapped_candidates with a MEASURED zero', async () => {
    const picks = await buildNewsCatalystPicks(
      deps({ items: [], queriesAttempted: 25, queriesSucceeded: 25 }),
    );
    expect(picks).toEqual([]);

    const s = await summarizeCatalystRuns();
    expect(s.lastRunOutcome).toBe('no_mapped_candidates');
    expect(s.lastRunHeadlineCount).toBe(0); // measured, and trustworthy
    expect(s.lastRunQueriesSucceeded).toBe(25);
  });

  it('gives the two cases DIFFERENT outcomes from the same empty item list', async () => {
    // The whole point, stated as one assertion: identical `items: []`, and the
    // probe must still tell an operator which of the two happened.
    await buildNewsCatalystPicks(deps({ items: [], queriesAttempted: 25, queriesSucceeded: 0 }));
    const outage = (await summarizeCatalystRuns()).lastRunOutcome;

    await buildNewsCatalystPicks(deps({ items: [], queriesAttempted: 25, queriesSucceeded: 25 }));
    const quiet = (await summarizeCatalystRuns()).lastRunOutcome;

    expect(outage).not.toBe(quiet);
  });

  it('does not mistake a partial sweep for an outage', async () => {
    // Wall-clock cut: fewer queries attempted than the universe, but the ones
    // issued did answer. That is degraded COVERAGE, not a dead feed.
    await buildNewsCatalystPicks(deps({ items: [], queriesAttempted: 9, queriesSucceeded: 9 }));
    const s = await summarizeCatalystRuns();
    expect(s.lastRunOutcome).toBe('no_mapped_candidates');
    expect(s.lastRunQueriesAttempted).toBe(9);
  });
});

// ── TRA-4585 (parent TRA-4222) ──────────────────────────────────────────────
//
// TRA-2064 (above) separated a dead NEWS feed from a quiet news day. This is the
// same defect one layer down, on the OTHER feed: news answers 25/25, candidates
// map, and then the price feed returns nothing. `fetchCatalystMetrics` swallows
// its own failures into `price: null`, so that run terminates `picks_built /
// chosenCount: 0` — which reads exactly like a day on which nothing scored well
// enough. On 2026-08-31 it entered the forward-test cohort as a legitimate zero.
//
// Acceptance, quoted from the ticket: a degraded session must be identifiable
// FROM THE HEALTH PAYLOAD ALONE — without inspecting per-row drop reasons, and
// without the reader having to know that SPY is not a penny stock.

describe('news-catalyst degraded-run stamp + eligible denominator', () => {
  const FLAG = 'ENABLE_NEWS_CATALYST_WATCHLIST';
  let priorFlag: string | undefined;

  beforeEach(() => {
    // The shadow ledger is flag-gated; without this it writes nothing and every
    // assertion below would pass vacuously against an empty file.
    priorFlag = process.env[FLAG];
    process.env[FLAG] = '1';
  });
  afterEach(() => {
    if (priorFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = priorFlag;
  });

  const headline = (title: string): NewsItem => ({
    title,
    url: `https://example.invalid/${encodeURIComponent(title)}`,
    source: 'Wire',
    publishedAt: new Date(NOW - 20 * 60_000).toISOString(),
  });

  /** Healthy news sweep; the PRICE feed is what the caller varies. */
  const liveDeps = (metrics: CatalystMetrics, at: number = NOW) => ({
    fetchNews: async () => ({
      items: [
        headline('NVDA surges on record datacenter demand'),
        headline('AAPL climbs after strong quarterly guidance'),
      ],
      queriesAttempted: 25,
      queriesSucceeded: 25,
    }),
    fetchMetrics: async () => metrics,
    earningsInDays: () => null,
    now: at,
  });

  const HEALTHY: CatalystMetrics = { price: 100, avgDollarVol: 5_000_000, rvolZ: 2, gapPct: 4 };
  const NO_QUOTE: CatalystMetrics = { price: null, avgDollarVol: null, rvolZ: 0, gapPct: 0 };

  it('stamps degradedRun TRUE on every row a dead-quote-feed run writes', async () => {
    const picks = await buildNewsCatalystPicks(liveDeps(NO_QUOTE));
    expect(picks).toEqual([]);

    const rows = await listNewsCatalystSignals();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.degradedRun === true)).toBe(true);
    // …and the drop reason is the absence of a measurement, not a price screen.
    expect(rows.every((r) => r.dropReason === 'no_quote')).toBe(true);
    expect(rows.some((r) => r.dropReason === 'below_min_price')).toBe(false);
  });

  it('stamps degradedRun FALSE — explicitly — on a healthy run', async () => {
    await buildNewsCatalystPicks(liveDeps(HEALTHY));

    const rows = await listNewsCatalystSignals();
    expect(rows.length).toBeGreaterThan(0);
    // The key must be PRESENT and false. If a healthy run simply omitted it,
    // "clean row" and "row written before this field existed" would be the same
    // observation — the identical false-equivalence this ticket exists to kill.
    for (const r of rows) {
      expect(Object.hasOwn(r, 'degradedRun')).toBe(true);
      expect(r.degradedRun).toBe(false);
    }
  });

  it('a run terminating picks_built can still be degraded — the whole point', async () => {
    await buildNewsCatalystPicks(liveDeps(NO_QUOTE));
    const s = await summarizeCatalystRuns();

    // `outcome` alone says the writer completed normally. It is not the signal.
    expect(s.lastRunOutcome).toBe('picks_built');
    expect(s.lastRunChosenCount).toBe(0);
    // The news feed was healthy, so neither TRA-2064 field can see this at all.
    expect(s.lastRunQueriesSucceeded).toBe(25);
    // These are what make it legible, straight off the payload.
    expect(s.lastRunDegraded).toBe(true);
    expect(s.lastRunQuotesAttempted).toBeGreaterThan(0);
    expect(s.lastRunQuotesOk).toBe(0);
  });

  it('partitions the sessions so an outage day leaves the eligible denominator', async () => {
    const DAY2 = NOW + 24 * 3600_000;
    await buildNewsCatalystPicks(liveDeps(HEALTHY, NOW));
    await buildNewsCatalystPicks(liveDeps(NO_QUOTE, DAY2));

    const s = await summarizeCatalystRuns();
    expect(s.sessionsTotal).toBe(2);
    expect(s.sessionsDegraded).toBe(1);
    expect(s.sessionsEligible).toBe(1);
    expect(s.sessionsDegraded + s.sessionsEligible).toBe(s.sessionsTotal);
    expect(s.degradedSessions).toHaveLength(1);
  });

  it('does not degrade a healthy session — the fix must not eat the denominator', async () => {
    // The expensive failure in the other direction: a rule that flags everything
    // would shrink the forward-test window instead of correcting it.
    await buildNewsCatalystPicks(liveDeps(HEALTHY));
    const s = await summarizeCatalystRuns();
    expect(s.sessionsDegraded).toBe(0);
    expect(s.sessionsEligible).toBe(1);
    expect(s.degradedSessions).toEqual([]);
    expect(s.lastRunDegraded).toBe(false);
  });
});
