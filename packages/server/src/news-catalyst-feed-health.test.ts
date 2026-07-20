import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildNewsCatalystPicks } from './news-catalyst-source.js';
import {
  summarizeCatalystRuns,
  setNewsCatalystRunLedgerFileForTests,
} from './news-catalyst-run-ledger.js';
import { setNewsCatalystLedgerFileForTests } from './news-catalyst-ledger.js';

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
