import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordCatalystRun,
  summarizeCatalystRuns,
  listCatalystRuns,
  isCatalystRunDegraded,
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
      queriesAttempted: 25,
      queriesSucceeded: 25,
      quotesAttempted: 0,
      quotesOk: 0,
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
      queriesAttempted: null,
      queriesSucceeded: null,
      quotesAttempted: null,
      quotesOk: null,
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
      queriesAttempted: 25,
      queriesSucceeded: 25,
      quotesAttempted: 7,
      quotesOk: 7,
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
      queriesAttempted: 25,
      queriesSucceeded: 25,
      quotesAttempted: 5,
      quotesOk: 5,
    });
    await recordCatalystRun({
      at: Date.UTC(2026, 6, 17, 13, 5),
      outcome: 'picks_built',
      headlineCount: 31,
      candidateCount: 6,
      chosenCount: 2,
      queriesAttempted: 25,
      queriesSucceeded: 25,
      quotesAttempted: 6,
      quotesOk: 6,
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
        queriesAttempted: 25,
        queriesSucceeded: 25,
        quotesAttempted: 1,
        quotesOk: 1,
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
      queriesAttempted: 25,
      queriesSucceeded: 25,
      quotesAttempted: 5,
      quotesOk: 5,
    });
    const { appendFileSync } = await import('fs');
    appendFileSync(path, '{not json\n', 'utf-8');
    setNewsCatalystRunLedgerFileForTests(path);
    const rows = await listCatalystRuns();
    expect(rows).toHaveLength(1);
  });
});

// ── TRA-4585 (parent TRA-4222) — the eligible-session denominator ────────────
//
// The parent defect: a degraded session enters the forward-test denominator as
// an ordinary 0-catalyst day, biasing the promotion grade downward. These pin
// the partition that makes such a day countable, and — just as important — pin
// the three ways a CLEAN day must NOT be swept into it.

describe('news-catalyst run ledger — isCatalystRunDegraded', () => {
  const base = {
    outcome: 'picks_built' as const,
    queriesAttempted: 25,
    queriesSucceeded: 25,
    quotesAttempted: 12,
    quotesOk: 12,
  };

  it('is false for a fully healthy run', () => {
    expect(isCatalystRunDegraded(base)).toBe(false);
  });

  it('flags a dead NEWS sweep (queries issued, none answered)', () => {
    expect(isCatalystRunDegraded({ ...base, queriesSucceeded: 0 })).toBe(true);
  });

  it('flags a dead QUOTE feed under perfectly healthy news', async () => {
    // The 2026-08-31 shape generalised, and the arm `fetch_degraded` cannot
    // reach: the news sweep answered 25/25, candidates mapped, and then every
    // single one came back unpriced. Terminal outcome is `picks_built`.
    expect(isCatalystRunDegraded({ ...base, quotesOk: 0 })).toBe(true);
  });

  it('flags every outcome that measured nothing by construction', () => {
    for (const outcome of ['fetch_degraded', 'fetch_failed', 'source_failed'] as const) {
      expect(isCatalystRunDegraded({ ...base, outcome })).toBe(true);
    }
  });

  it('does NOT flag a quiet news day — zero candidates means zero quotes to get', () => {
    // `quotesAttempted: 0` is a measured zero, not an outage: nothing mapped, so
    // nothing was priced. If the `> 0` guard were dropped, every genuinely quiet
    // session would be reclassified as contaminated and the denominator this
    // ticket exists to widen would collapse instead.
    expect(
      isCatalystRunDegraded({
        ...base,
        outcome: 'no_mapped_candidates',
        quotesAttempted: 0,
        quotesOk: 0,
      }),
    ).toBe(false);
  });

  it('does NOT flag a PARTIAL quote outage', () => {
    // Degraded coverage is not a dead feed — same distinction TRA-2064 drew for
    // `queriesAttempted < universe`. One usable quote means the screen ran.
    expect(isCatalystRunDegraded({ ...base, quotesOk: 1 })).toBe(false);
  });

  it('does NOT flag a legacy row whose counters were never written', () => {
    // A pre-TRA-4585 row has no `quotes*` key at all, which reads as `null` =
    // NOT MEASURED. Treating that as a positive finding would retroactively
    // contaminate the 25 clean sessions QuantTrader has already banked.
    expect(
      isCatalystRunDegraded({ ...base, quotesAttempted: null, quotesOk: null }),
    ).toBe(false);
    expect(
      isCatalystRunDegraded({
        ...base,
        queriesAttempted: null,
        queriesSucceeded: null,
        quotesAttempted: null,
        quotesOk: null,
      }),
    ).toBe(false);
  });
});

describe('news-catalyst run ledger — session partition', () => {
  const run = (
    day: number,
    hour: number,
    over: Partial<Parameters<typeof recordCatalystRun>[0]> = {},
  ) =>
    recordCatalystRun({
      at: Date.UTC(2026, 7, day, hour, 0),
      outcome: 'picks_built',
      headlineCount: 30,
      candidateCount: 12,
      chosenCount: 4,
      queriesAttempted: 25,
      queriesSucceeded: 25,
      quotesAttempted: 12,
      quotesOk: 12,
      ...over,
    });

  it('partitions sessions exactly: degraded + eligible === total', async () => {
    await run(24, 13);
    await run(25, 13, { quotesOk: 0 }); // price feed dead
    await run(26, 13);
    await run(27, 13, { outcome: 'fetch_degraded', queriesSucceeded: 0 });
    await run(28, 13);

    const s = await summarizeCatalystRuns();
    expect(s.sessionsTotal).toBe(5);
    expect(s.sessionsDegraded).toBe(2);
    expect(s.sessionsEligible).toBe(3);
    // The identity, asserted rather than assumed — the reader must not have to
    // trust that both buckets came off the same set.
    expect(s.sessionsDegraded + s.sessionsEligible).toBe(s.sessionsTotal);
  });

  it('keeps sessionsTotal identical to sessionsWithRun', async () => {
    // Same set, two names. If these ever diverge the partition is being folded
    // over a different denominator than the one the rest of the probe reports.
    await run(24, 13);
    await run(24, 14);
    await run(25, 13, { quotesOk: 0 });
    const s = await summarizeCatalystRuns();
    expect(s.sessionsTotal).toBe(s.sessionsWithRun);
    expect(s.runCount).toBe(3);
  });

  it('degrades a session if ANY run in it was degraded', async () => {
    // Load-bearing, not merely conservative: the shadow ledger keeps ONE row per
    // symbol per session, first write wins. The 13:00 run below owns the day's
    // rows outright; the healthy 14:00 run cannot overwrite them, so the day on
    // disk really is contaminated.
    await run(24, 13, { quotesOk: 0 });
    await run(24, 14);

    const s = await summarizeCatalystRuns();
    expect(s.sessionsTotal).toBe(1);
    expect(s.sessionsDegraded).toBe(1);
    expect(s.sessionsEligible).toBe(0);
  });

  it('names the degraded sessions so a hand-kept exclusion list can be reconciled', async () => {
    await run(24, 13);
    await run(31, 13, { outcome: 'fetch_degraded', queriesSucceeded: 0 });

    const s = await summarizeCatalystRuns();
    // QuantTrader banked `26 total | 1 contaminated | 25 eligible`, excluding
    // 2026-08-31 by hand. The probe must be able to say that name out loud.
    expect(s.degradedSessions).toEqual(['2026-08-31']);
  });

  it('reads an empty ledger as a 0/0/0 partition, not as an eligible session', async () => {
    const s = await summarizeCatalystRuns();
    expect(s.sessionsTotal).toBe(0);
    expect(s.sessionsDegraded).toBe(0);
    expect(s.sessionsEligible).toBe(0);
    expect(s.degradedSessions).toEqual([]);
    // Third state: there is no last run at all, which is not a healthy one.
    expect(s.lastRunDegraded).toBeNull();
  });

  it('surfaces the last run quote counters with null-means-unmeasured', async () => {
    await run(24, 13, { quotesAttempted: 12, quotesOk: 3 });
    let s = await summarizeCatalystRuns();
    expect(s.lastRunQuotesAttempted).toBe(12);
    expect(s.lastRunQuotesOk).toBe(3);
    expect(s.lastRunDegraded).toBe(false); // partial, not dead

    await run(25, 13, { quotesAttempted: null, quotesOk: null });
    s = await summarizeCatalystRuns();
    expect(s.lastRunQuotesAttempted).toBeNull();
    expect(s.lastRunQuotesOk).toBeNull();
  });
});
