import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordCatalystRun,
  summarizeCatalystRuns,
  listCatalystRuns,
  isCatalystRunDegraded,
  catalystQuoteCoverage,
  CATALYST_MIN_QUOTE_COVERAGE,
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

  it('DOES flag a partial quote outage below the coverage floor (TRA-4598)', () => {
    // This assertion is INVERTED from TRA-4585, deliberately. The old
    // all-or-nothing arm (`quotesOk === 0`) let the canonical incident's own
    // shape through: 2026-08-31 wrote 19 rows, 14 unpriced and 5 priced, so
    // `quotesOk === 0` was FALSE and the day was flagged only because the news
    // sweep separately died. A 74% quote outage under a HEALTHY news sweep
    // entered the forward-test cohort as a legitimate low-catalyst session.
    expect(isCatalystRunDegraded({ ...base, quotesAttempted: 19, quotesOk: 5 })).toBe(true);
    expect(isCatalystRunDegraded({ ...base, quotesOk: 1 })).toBe(true);
  });

  it('does NOT flag a shallow partial — a few names missing is not an outage', () => {
    // The floor has to cut BOTH ways: a rule that flags everything shrinks the
    // forward-test window instead of correcting it. Banked history's worst
    // clean session is 17/19 = 0.895 (2026-09-11) and there is no observation
    // anywhere between that and 0.263, so this side of the gap must stay
    // eligible.
    expect(isCatalystRunDegraded({ ...base, quotesOk: 11 })).toBe(false); // 0.917
    expect(isCatalystRunDegraded({ ...base, quotesAttempted: 19, quotesOk: 17 })).toBe(false);
  });

  it('treats the floor as strict — exactly at the floor is NOT degraded', () => {
    // Pins the comparison direction. `< floor`, not `<= floor`: the boundary
    // belongs to the eligible side, so a rule change is never silently smuggled
    // in by an equality.
    expect(isCatalystRunDegraded({ ...base, quotesAttempted: 12, quotesOk: 6 })).toBe(false);
    expect(isCatalystRunDegraded({ ...base, quotesAttempted: 12, quotesOk: 5 })).toBe(true);
  });

  it('exposes coverage as null — never 0/0 — for both NOT MEASURED cases', () => {
    // The two invariants TRA-4598 must not regress. A ratio that manufactured a
    // verdict here would either retro-contaminate banked history (first case)
    // or reclassify every quiet news day as an outage (second).
    expect(catalystQuoteCoverage({ quotesAttempted: null, quotesOk: null })).toBeNull();
    expect(catalystQuoteCoverage({ quotesAttempted: 0, quotesOk: 0 })).toBeNull();
    expect(catalystQuoteCoverage({ quotesAttempted: 19, quotesOk: 5 })).toBeCloseTo(0.2632, 4);
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
    expect(s.lastRunQuoteCoverage).toBeCloseTo(0.25, 4);
    // TRA-4598 — was `false` ("partial, not dead") under TRA-4585's
    // all-or-nothing arm. 3/12 = 0.25 is below the floor and this is now the
    // whole point of the predicate.
    expect(s.lastRunDegraded).toBe(true);

    await run(25, 13, { quotesAttempted: null, quotesOk: null });
    s = await summarizeCatalystRuns();
    expect(s.lastRunQuotesAttempted).toBeNull();
    expect(s.lastRunQuotesOk).toBeNull();
    expect(s.lastRunQuoteCoverage).toBeNull();
  });
});

describe('news-catalyst run ledger — per-session quote coverage (TRA-4598)', () => {
  const run = (
    day: number,
    hour: number,
    over: Partial<Parameters<typeof recordCatalystRun>[0]> = {},
  ) =>
    recordCatalystRun({
      at: Date.UTC(2026, 7, day, hour, 0),
      outcome: 'picks_built',
      headlineCount: 40,
      candidateCount: 12,
      chosenCount: 3,
      queriesAttempted: 25,
      queriesSucceeded: 25,
      quotesAttempted: 12,
      quotesOk: 12,
      ...over,
    });

  it('publishes the floor alongside the ratios so the payload grades itself', async () => {
    await run(24, 13);
    const s = await summarizeCatalystRuns();
    expect(s.quoteCoverageFloor).toBe(CATALYST_MIN_QUOTE_COVERAGE);
  });

  it('makes the PARTIAL outage legible without reading per-row drop reasons', async () => {
    // TRA-4222's acceptance sentence. The 2026-08-31 shape: 19 candidates, 5
    // priced. Every other field on this payload reads as an ordinary
    // low-catalyst session.
    await run(31, 13, { quotesAttempted: 19, quotesOk: 5, chosenCount: 0 });
    const s = await summarizeCatalystRuns();
    const day = s.quoteCoverageBySession.find((c) => c.session === '2026-08-31');
    expect(day?.quoteCoverage).toBeCloseTo(0.2632, 4);
    expect(day?.belowFloor).toBe(true);
    expect(s.degradedSessions).toEqual(['2026-08-31']);
  });

  it('reports the WORST run in a session, not a sum across it', async () => {
    // Summing dilutes exactly the case worth catching, and the dilution is not
    // hypothetical: the shadow ledger dedupes one row per symbol per session,
    // first write wins, so the dead 13:00 run below OWNS the day's rows and the
    // five healthy ones cannot overwrite them. Summed this is 95/114 = 0.83 and
    // reads clean.
    await run(24, 13, { quotesAttempted: 19, quotesOk: 0 });
    for (const hour of [14, 15, 16, 17, 18]) await run(24, hour, { quotesAttempted: 19, quotesOk: 19 });

    const s = await summarizeCatalystRuns();
    const day = s.quoteCoverageBySession.find((c) => c.session === '2026-08-24');
    expect(day?.quotesAttempted).toBe(19);
    expect(day?.quotesOk).toBe(0);
    expect(day?.quoteCoverage).toBe(0);
    expect(day?.belowFloor).toBe(true);
    // Consistent with the partition, which flags a session if ANY run degraded.
    expect(s.sessionsDegraded).toBe(1);
  });

  it('reads an unmeasured session as null, never as a 0/0 verdict', async () => {
    // The banked-history invariant. A pre-TRA-4585 row has no `quotes*` key, so
    // the session has no coverage — and `belowFloor: null` keeps "clean" and
    // "never looked" as different observations.
    await run(24, 13, { quotesAttempted: null, quotesOk: null });
    const s = await summarizeCatalystRuns();
    const day = s.quoteCoverageBySession.find((c) => c.session === '2026-08-24');
    expect(day?.quoteCoverage).toBeNull();
    expect(day?.belowFloor).toBeNull();
    expect(day?.quotesAttempted).toBeNull();
    expect(s.sessionsDegraded).toBe(0);
    expect(s.sessionsQuoteMeasured).toBe(0);
  });

  it('counts a quiet news day as MEASURED even though it has no ratio', async () => {
    // `quotesAttempted: 0` — nothing mapped, nothing to price. The writer DID
    // look, so it belongs in `sessionsQuoteMeasured`; there is simply no ratio
    // to divide. Keying that count off the coverage map instead would
    // under-report the telemetry and make a quiet day look like a legacy row.
    await run(24, 13, { outcome: 'no_mapped_candidates', quotesAttempted: 0, quotesOk: 0 });
    const s = await summarizeCatalystRuns();
    expect(s.sessionsQuoteMeasured).toBe(1);
    const day = s.quoteCoverageBySession.find((c) => c.session === '2026-08-24');
    expect(day?.quoteCoverage).toBeNull();
    expect(day?.belowFloor).toBeNull();
    expect(s.sessionsDegraded).toBe(0);
    expect(s.sessionsEligible).toBe(1);
  });

  it('covers every session in the partition, one entry each', async () => {
    await run(24, 13);
    await run(24, 14);
    await run(25, 13, { quotesAttempted: 19, quotesOk: 5 });
    const s = await summarizeCatalystRuns();
    expect(s.quoteCoverageBySession.map((c) => c.session)).toEqual(['2026-08-24', '2026-08-25']);
    expect(s.quoteCoverageBySession).toHaveLength(s.sessionsTotal);
  });
});
