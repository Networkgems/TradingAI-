import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordCatalystRun,
  summarizeCatalystRuns,
  listCatalystRuns,
  setNewsCatalystRunLedgerFileForTests,
} from './news-catalyst-run-ledger.js';

// TRA-2064 — the run ledger exists to separate "the writer ran and found
// nothing" from "the writer never ran". These tests pin that separation.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nc-runs-'));
  setNewsCatalystRunLedgerFileForTests(join(dir, 'news-catalyst-runs.jsonl'));
});

afterEach(() => {
  setNewsCatalystRunLedgerFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('news-catalyst run ledger — never-ran vs ran-empty', () => {
  it('reports lastRunAt null when the writer has never run', async () => {
    const s = await summarizeCatalystRuns();
    expect(s.lastRunAt).toBeNull();
    expect(s.lastRunOutcome).toBeNull();
    expect(s.runCount).toBe(0);
  });

  it('distinguishes a ran-but-empty session from a never-ran one', async () => {
    await recordCatalystRun({
      at: Date.UTC(2026, 6, 20, 13, 0),
      outcome: 'no_mapped_candidates',
      headlineCount: 30,
      candidateCount: 0,
      chosenCount: 0,
    });
    const s = await summarizeCatalystRuns();
    // The distinguishing observation: a run EXISTS, and it measured 30
    // headlines. On the old probe this state and "never ran" both read
    // `count: 0` and nothing else.
    expect(s.lastRunAt).not.toBeNull();
    expect(s.lastRunOutcome).toBe('no_mapped_candidates');
    expect(s.lastRunHeadlineCount).toBe(30);
    expect(s.runCount).toBe(1);
  });
});

describe('news-catalyst run ledger — false-zero discipline', () => {
  it('records headlineCount as null (not 0) when the feed threw', async () => {
    await recordCatalystRun({
      at: Date.UTC(2026, 6, 20, 13, 0),
      outcome: 'fetch_failed',
      headlineCount: null,
      candidateCount: null,
      chosenCount: null,
      reason: 'ETIMEDOUT',
    });
    const s = await summarizeCatalystRuns();
    // NOT 0 — a 0 here would be indistinguishable from a feed that legitimately
    // returned an empty list, which is a different diagnosis.
    expect(s.lastRunHeadlineCount).toBeNull();
    expect(s.lastRunOutcome).toBe('fetch_failed');
    expect(s.lastRunReason).toBe('ETIMEDOUT');
  });
});

describe('news-catalyst run ledger — durability across a restart', () => {
  it('rehydrates runCount from disk while runCountSinceBoot resets', async () => {
    const path = join(dir, 'news-catalyst-runs.jsonl');
    await recordCatalystRun({
      at: Date.UTC(2026, 6, 17, 13, 0),
      outcome: 'picks_built',
      headlineCount: 30,
      candidateCount: 7,
      chosenCount: 3,
    });

    // Simulate a process restart: drop the in-memory cache, keep the file. The
    // crash-restarts are the suspected root cause, so the durable count MUST
    // survive them — otherwise a post-restart read of 0 is again ambiguous.
    setNewsCatalystRunLedgerFileForTests(path);

    const s = await summarizeCatalystRuns();
    expect(s.runCount).toBe(1);
    expect(s.runCountSinceBoot).toBe(0);
    expect(s.lastRunOutcome).toBe('picks_built');
    expect(s.lastRunChosenCount).toBe(3);
  });

  it('counts distinct sessions, not raw invocations', async () => {
    await recordCatalystRun({
      at: Date.UTC(2026, 6, 17, 13, 0),
      outcome: 'picks_built',
      headlineCount: 30,
      candidateCount: 5,
      chosenCount: 2,
    });
    await recordCatalystRun({
      at: Date.UTC(2026, 6, 17, 13, 5),
      outcome: 'picks_built',
      headlineCount: 31,
      candidateCount: 6,
      chosenCount: 2,
    });
    const s = await summarizeCatalystRuns();
    expect(s.runCount).toBe(2);
    expect(s.sessionsWithRun).toBe(1);
  });

  it('never throws out of the premarket path when the disk is unwritable', async () => {
    // Point at a path whose parent is a FILE, so mkdir/append must fail.
    const bogus = join(dir, 'news-catalyst-runs.jsonl', 'nested', 'runs.jsonl');
    setNewsCatalystRunLedgerFileForTests(bogus);
    await expect(
      recordCatalystRun({
        at: Date.UTC(2026, 6, 20, 13, 0),
        outcome: 'picks_built',
        headlineCount: 1,
        candidateCount: 1,
        chosenCount: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('skips a corrupt line rather than losing the history', async () => {
    const path = join(dir, 'mixed.jsonl');
    setNewsCatalystRunLedgerFileForTests(path);
    await recordCatalystRun({
      at: Date.UTC(2026, 6, 17, 13, 0),
      outcome: 'picks_built',
      headlineCount: 30,
      candidateCount: 5,
      chosenCount: 2,
    });
    const { appendFileSync } = await import('fs');
    appendFileSync(path, '{not json\n', 'utf-8');
    setNewsCatalystRunLedgerFileForTests(path);
    const rows = await listCatalystRuns();
    expect(rows).toHaveLength(1);
  });
});
