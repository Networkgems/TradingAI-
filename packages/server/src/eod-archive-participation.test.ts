// TRA-2930 (from the TRA-2928 ruling, D1) — durable per-book EOD archive-participation.
//
// The two constraints from the ruling ARE the test plan:
//   1. it must survive process restart and deploy  -> the restart/hydrate block;
//   2. it must discriminate candidate (a) from (b) -> the discrimination block.
// Everything else guards the ways this kind of record has previously lied: a verdict
// that reads clean on an empty cohort, a rate that reads 1.0 on zero observations, and
// a per-day file scheme that dies in the exact outage it exists to witness.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  openEodArchiveParticipationRun,
  recordEodParticipation,
  hydrateEodArchiveParticipationFromDisk,
  summarizeEodArchiveParticipation,
  clearEodArchiveParticipation,
  eodArchiveParticipationLogPath,
  EOD_ARCHIVE_PARTICIPATION_FILENAME,
} from './eod-archive-participation.js';

const DAY = '2026-06-15'; // onset of the TRA-2903 enock gap
const T0 = Date.parse('2026-06-16T01:00:00Z'); // 21:00 ET on DAY

function book(summary: ReturnType<typeof summarizeEodArchiveParticipation>, username: string) {
  return summary.byBook.find((b) => b.username === username);
}

describe('eod-archive-participation', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eod-participation-'));
    hydrateEodArchiveParticipationFromDisk(dir, T0);
  });

  afterEach(() => {
    clearEodArchiveParticipation();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Constraint 2: discriminate candidate (a) from candidate (b) ────────────

  describe('discrimination (ruling constraint 2)', () => {
    it('separates absent-from-context-map from report-threw from participated', () => {
      // `enock` is in users.json but NOT in the context map: an initUserContext throw
      // at boot dropped it. `carol`'s report throws inside the loop. `alice` is fine.
      const run = openEodArchiveParticipationRun({
        etDay: DAY,
        marketDay: true,
        roster: ['alice', 'carol', 'enock'],
        contextUsernames: ['alice', 'carol'],
        now: T0,
      });
      expect(run.absentFromContextMap).toEqual(['enock']);

      recordEodParticipation(run, 'alice', 'participated', undefined, T0 + 1);
      recordEodParticipation(run, 'carol', 'report_threw', 'ENOSPC: no space left', T0 + 2);

      const s = summarizeEodArchiveParticipation();
      expect(book(s, 'enock')?.absentFromContextMap).toBe(1);
      expect(book(s, 'enock')?.reportThrew).toBe(0);
      expect(book(s, 'carol')?.reportThrew).toBe(1);
      expect(book(s, 'carol')?.absentFromContextMap).toBe(0);
      expect(book(s, 'carol')?.lastReason).toBe('ENOSPC: no space left');
      expect(book(s, 'alice')?.participated).toBe(1);

      // The three are DIFFERENT readings — that is the deliverable. A record that
      // could only say "no row written" would collapse enock and carol together,
      // which is precisely the ambiguity TRA-2930 exists to remove.
      expect(book(s, 'enock')?.lastOutcome).toBe('absent_from_context_map');
      expect(book(s, 'carol')?.lastOutcome).toBe('report_threw');
      expect(book(s, 'alice')?.lastOutcome).toBe('participated');
    });

    it('records the absent book even though the archive loop never iterates it', () => {
      // The load-bearing property. The caller's loop runs over the CONTEXT MAP, so it
      // is structurally incapable of emitting a row for an absent book. The row exists
      // only because the roster is sourced independently (users.json).
      const run = openEodArchiveParticipationRun({
        etDay: DAY,
        marketDay: true,
        roster: ['alice', 'enock'],
        contextUsernames: ['alice'],
        now: T0,
      });
      // Simulate the real loop: it can only ever touch what is in the context map.
      for (const username of ['alice']) {
        recordEodParticipation(run, username, 'participated', undefined, T0 + 1);
      }

      const s = summarizeEodArchiveParticipation();
      expect(book(s, 'enock')?.absentFromContextMap).toBe(1);
      expect(s.anomalies.map((b) => b.username)).toEqual(['enock']);
    });

    it('writes the absent rows BEFORE the loop, so a mid-loop crash still leaves candidate (a)', () => {
      openEodArchiveParticipationRun({
        etDay: DAY,
        marketDay: true,
        roster: ['alice', 'enock'],
        contextUsernames: ['alice'],
        now: T0,
      });
      // No per-book record calls at all — the process "died" before the loop body.
      const raw = readFileSync(eodArchiveParticipationLogPath(dir), 'utf8');
      const rows = raw.trim().split('\n').map((l) => JSON.parse(l));
      expect(rows.filter((r) => r.kind === 'run')).toHaveLength(1);
      expect(rows.filter((r) => r.outcome === 'absent_from_context_map')).toHaveLength(1);
    });

    it('a run row separates "the hook never fired" from "the book was absent"', () => {
      // No run opened at all.
      expect(summarizeEodArchiveParticipation().runs).toBe(0);
      expect(summarizeEodArchiveParticipation().verdict).toBeNull();

      openEodArchiveParticipationRun({
        etDay: DAY,
        marketDay: true,
        roster: ['enock'],
        contextUsernames: [],
        now: T0,
      });
      const s = summarizeEodArchiveParticipation();
      // Now there IS a run, and the book is provably absent within it. Two different
      // defects with two different owners; per-book rows alone cannot tell them apart.
      expect(s.runs).toBe(1);
      expect(s.byDay[0]?.contextMapSize).toBe(0);
      expect(s.byDay[0]?.rosterSize).toBe(1);
      expect(s.verdict).toBe('misses');
    });
  });

  // ── Constraint 1: survives process restart and deploy ──────────────────────

  describe('durability (ruling constraint 1)', () => {
    it('rebuilds the full record from disk after a simulated restart', () => {
      const run = openEodArchiveParticipationRun({
        etDay: DAY,
        marketDay: true,
        roster: ['alice', 'enock'],
        contextUsernames: ['alice'],
        now: T0,
      });
      recordEodParticipation(run, 'alice', 'participated', undefined, T0 + 1);

      // Process dies. Everything in memory is gone; only the file survives.
      clearEodArchiveParticipation();
      expect(summarizeEodArchiveParticipation().runs).toBe(0);

      const h = hydrateEodArchiveParticipationFromDisk(dir, T0 + 60_000);
      expect(h.records).toBe(3); // run + absent(enock) + participated(alice)
      const s = summarizeEodArchiveParticipation();
      expect(book(s, 'enock')?.absentFromContextMap).toBe(1);
      expect(book(s, 'alice')?.participated).toBe(1);
      // `hydratedRecords` > 0 is what separates a real floor from this-uptime-only.
      expect(s.durability.hydratedRecords).toBe(3);
    });

    it('appends to ONE stable file and never creates a per-day partition', () => {
      // TRA-2817: /data hit INODE exhaustion with free bytes — appends survived while
      // file CREATES failed. A per-day partition scheme would have gone silent during
      // the exact outage this record exists to witness.
      for (const [i, day] of ['2026-06-15', '2026-06-16', '2026-06-17'].entries()) {
        const run = openEodArchiveParticipationRun({
          etDay: day,
          marketDay: true,
          roster: ['alice'],
          contextUsernames: ['alice'],
          now: T0 + i * 86_400_000,
        });
        recordEodParticipation(run, 'alice', 'participated', undefined, T0 + i * 86_400_000 + 1);
      }
      expect(existsSync(join(dir, EOD_ARCHIVE_PARTICIPATION_FILENAME))).toBe(true);
      expect(existsSync(join(dir, `${DAY}.jsonl`))).toBe(false);
      const lines = readFileSync(eodArchiveParticipationLogPath(dir), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(6); // 3 runs + 3 book rows, all appended to one file
    });

    it('skips a torn trailing line rather than losing the whole record', () => {
      const run = openEodArchiveParticipationRun({
        etDay: DAY,
        marketDay: true,
        roster: ['alice'],
        contextUsernames: ['alice'],
        now: T0,
      });
      recordEodParticipation(run, 'alice', 'participated', undefined, T0 + 1);
      // Simulate a hard kill mid-append.
      const path = eodArchiveParticipationLogPath(dir);
      const raw = readFileSync(path, 'utf8');
      writeFileSync(path, raw + '{"kind":"book","ts":175', 'utf8');

      const h = hydrateEodArchiveParticipationFromDisk(dir, T0 + 1000);
      expect(h.records).toBe(2);
      expect(book(summarizeEodArchiveParticipation(), 'alice')?.participated).toBe(1);
    });

    it('reports memory-only as ephemeral, not durable', () => {
      clearEodArchiveParticipation();
      const s = summarizeEodArchiveParticipation();
      expect(s.durability.dataDir).toBeNull();
      expect(s.durability.ephemeral).toBe(true);
    });
  });

  // ── The empty cohort. `every` is TRUE on nothing; a count reads clean on nothing ──

  describe('empty-cohort guards', () => {
    it('verdict is null (BLIND), never "clean", with no archive pass on record', () => {
      const s = summarizeEodArchiveParticipation();
      expect(s.verdict).toBeNull();
      expect(s.blindReason).toMatch(/BLIND/);
      expect(s.marketDayRuns).toBe(0);
    });

    it('verdict is null when passes exist but none on a market day', () => {
      const run = openEodArchiveParticipationRun({
        etDay: '2026-06-14', // Sunday
        marketDay: false,
        roster: ['alice'],
        contextUsernames: ['alice'],
        now: T0 - 86_400_000,
      });
      recordEodParticipation(run, 'alice', 'skipped_not_market_day', undefined, T0 - 86_400_000);
      const s = summarizeEodArchiveParticipation();
      expect(s.runs).toBe(1);
      expect(s.verdict).toBeNull(); // nothing was expected, so nothing can be graded
    });

    it('participationRate is null on zero observed market days, not 0 and not 1', () => {
      const run = openEodArchiveParticipationRun({
        etDay: '2026-06-14',
        marketDay: false,
        roster: ['alice'],
        contextUsernames: ['alice'],
        now: T0,
      });
      recordEodParticipation(run, 'alice', 'skipped_not_market_day', undefined, T0);
      expect(book(summarizeEodArchiveParticipation(), 'alice')?.participationRate).toBeNull();
    });

    it('verdict is "clean" only once a market-day pass has actually been graded', () => {
      const run = openEodArchiveParticipationRun({
        etDay: DAY,
        marketDay: true,
        roster: ['alice'],
        contextUsernames: ['alice'],
        now: T0,
      });
      recordEodParticipation(run, 'alice', 'participated', undefined, T0 + 1);
      const s = summarizeEodArchiveParticipation();
      expect(s.verdict).toBe('clean');
      expect(s.marketDayRuns).toBe(1);
      expect(book(s, 'alice')?.participationRate).toBe(1);
    });
  });

  // ── The TRA-2903 shape, replayed ───────────────────────────────────────────

  describe('the TRA-2903 shape', () => {
    it('counts a consecutive market-day miss streak and is not reset by a weekend', () => {
      const roster = ['alice', 'enock'];
      let t = T0;
      // 3 market days with enock absent, a non-market day, then 2 more market days.
      const schedule: Array<[string, boolean]> = [
        ['2026-06-15', true],
        ['2026-06-16', true],
        ['2026-06-17', true],
        ['2026-06-20', false], // Saturday — the hook still fires for crypto
        ['2026-06-22', true],
        ['2026-06-23', true],
      ];
      for (const [day, marketDay] of schedule) {
        const run = openEodArchiveParticipationRun({
          etDay: day,
          marketDay,
          roster,
          // enock never makes it into the context map — one boot throw, whole process.
          contextUsernames: marketDay ? ['alice'] : ['alice', 'enock'],
          now: t,
        });
        recordEodParticipation(
          run,
          'alice',
          marketDay ? 'participated' : 'skipped_not_market_day',
          undefined,
          t + 1,
        );
        if (!marketDay) {
          recordEodParticipation(run, 'enock', 'skipped_not_market_day', undefined, t + 2);
        }
        t += 86_400_000;
      }

      const s = summarizeEodArchiveParticipation();
      const enock = book(s, 'enock');
      expect(enock?.absentFromContextMap).toBe(5);
      // A weekend row must not clear a live streak — that is how a 28-session gap
      // would have read as "at most 4 in a row" and been dismissed.
      expect(enock?.consecutiveMisses).toBe(5);
      expect(enock?.lastParticipatedDay).toBeNull();
      expect(enock?.participationRate).toBe(0);
      expect(book(s, 'alice')?.consecutiveMisses).toBe(0);
      expect(s.anomalies.map((b) => b.username)).toEqual(['enock']);
      expect(s.verdict).toBe('misses');
    });

    it('a later participation ends the streak and stamps lastParticipatedDay', () => {
      const roster = ['enock'];
      let t = T0;
      for (const day of ['2026-06-15', '2026-06-16']) {
        openEodArchiveParticipationRun({
          etDay: day,
          marketDay: true,
          roster,
          contextUsernames: [],
          now: t,
        });
        t += 86_400_000;
      }
      // ensureUserContext healed it on the next authenticated request.
      const run = openEodArchiveParticipationRun({
        etDay: '2026-06-17',
        marketDay: true,
        roster,
        contextUsernames: ['enock'],
        now: t,
      });
      recordEodParticipation(run, 'enock', 'participated', undefined, t + 1);

      const s = summarizeEodArchiveParticipation();
      expect(book(s, 'enock')?.consecutiveMisses).toBe(0);
      expect(book(s, 'enock')?.lastParticipatedDay).toBe('2026-06-17');
      expect(book(s, 'enock')?.absentFromContextMap).toBe(2);
      // Still an anomaly — the window remembers the two misses even after the heal.
      // A self-repairing failure that erases its own evidence is the TRA-2903 trap.
      expect(s.anomalies).toHaveLength(1);
    });
  });

  // ── Day view ──────────────────────────────────────────────────────────────

  it('per-day rollup publishes roster vs context-map size and unrecorded books', () => {
    const run = openEodArchiveParticipationRun({
      etDay: DAY,
      marketDay: true,
      roster: ['alice', 'bob', 'enock'],
      contextUsernames: ['alice', 'bob'],
      now: T0,
    });
    recordEodParticipation(run, 'alice', 'participated', undefined, T0 + 1);
    // `bob` is deliberately never recorded — a recorder bug, distinct from a book fault.
    const day = summarizeEodArchiveParticipation().byDay[0];
    expect(day?.rosterSize).toBe(3);
    expect(day?.contextMapSize).toBe(2);
    expect(day?.participated).toBe(1);
    expect(day?.absentFromContextMap).toBe(1);
    expect(day?.unrecorded).toBe(1);
  });
});
