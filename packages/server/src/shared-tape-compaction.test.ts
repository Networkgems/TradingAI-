// TRA-5038 — the shared periodic-compaction hook.
//
// The thing under test here is a function that DELETES BYTES from a tape on a live
// money box, on a timer, four times a day. Every assertion below exists because the
// corresponding mistake would be invisible on the health route:
//
//   • a cut offset off by a few bytes produces a tape that still parses, still reads
//     healthy, and has one corrupted row at its head;
//   • a multi-byte character split across a read chunk changes a decoded string's
//     byte length, which MOVES the cut — the defect this suite's `é` fixture exists
//     to pin;
//   • a buffered append dropped on a failed rewrite reads identically to a row that
//     was never written (TRA-1681);
//   • and `hookState` is the one field that distinguishes a working hook from a
//     retention constant with no hook at all, which is the whole reason TRA-4904's
//     counter had to be replaced.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  registerSharedTape,
  clearSharedTapeCompaction,
  compactSharedTapeNow,
  measureSharedTapeSpan,
  runSharedTapeCompactionPass,
  noteSharedTapeCompactionArmed,
  sharedTapeCompactionState,
  sharedTapeRewriteInFlight,
  bufferSharedTapeAppend,
  extractLineTs,
  SHARED_TAPE_COMPACTION_INTERVAL_MS,
} from './shared-tape-compaction.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

let dir: string;
let path: string;
/** Lines the owner's own append path received during a flush. */
let flushed: string[];

function registerAge(retainMs: number, tape = 'fixture'): void {
  registerSharedTape({
    tape,
    resolvePath: () => path,
    predicate: () => ({ kind: 'age', retainMs }),
    flushLine: (line) => {
      flushed.push(line);
    },
    note: 'test fixture',
  });
}

function registerBytes(maxBytes: number, tape = 'fixture'): void {
  registerSharedTape({
    tape,
    resolvePath: () => path,
    predicate: () => ({ kind: 'bytes', maxBytes }),
    flushLine: (line) => {
      flushed.push(line);
    },
    note: 'test fixture',
  });
}

/** One JSONL row with `ts` first, exactly as every registered tape writes them. */
function row(ts: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, ...extra });
}

function write(lines: string[]): void {
  writeFileSync(path, lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra5038-'));
  path = join(dir, 'fixture.jsonl');
  flushed = [];
  clearSharedTapeCompaction();
});

afterEach(() => {
  clearSharedTapeCompaction();
  rmSync(dir, { recursive: true, force: true });
});

describe('extractLineTs', () => {
  it('reads ts without parsing the line', () => {
    expect(extractLineTs('{"ts":1759400000000,"symbol":"AAPL"}')).toBe(1759400000000);
    expect(extractLineTs('{"id":"x","ts": 42,"a":1}')).toBe(42);
  });

  it('returns null rather than guessing when ts is absent or unreadable', () => {
    expect(extractLineTs('{"symbol":"AAPL"}')).toBeNull();
    expect(extractLineTs('{"ts":"not-a-number"}')).toBeNull();
    expect(extractLineTs('not json at all')).toBeNull();
    // Beyond the inspected head ⇒ undatable, which is the SAFE answer (the line is
    // kept, never deleted). See TS_HEAD_BYTES.
    expect(extractLineTs(`{"pad":"${'x'.repeat(200)}","ts":1}`)).toBeNull();
  });
});

describe('age predicate', () => {
  it('drops the aged prefix and keeps the young suffix BYTE-FOR-BYTE', async () => {
    const aged = [row(NOW - 40 * DAY, { a: 1 }), row(NOW - 35 * DAY, { a: 2 })];
    const young = [row(NOW - 10 * DAY, { a: 3 }), row(NOW - 1 * DAY, { a: 4 })];
    write([...aged, ...young]);
    registerAge(30 * DAY);

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.rewrote).toBe(true);
    expect(out.linesDropped).toBe(2);
    expect(out.skipped).toBeUndefined();
    expect(out.error).toBeUndefined();
    // Verbatim: the retained bytes are echoed, so no field can be erased by the
    // rewrite (TRA-1703). Anything other than an exact match means the pass
    // re-serialized what it kept.
    expect(readFileSync(path, 'utf8')).toBe(young.join('\n') + '\n');
    expect(out.bytesAfter).toBe(statSync(path).size);
    expect(out.bytesDropped).toBe(out.bytesBefore - out.bytesAfter);
  });

  it('does not rewrite when nothing aged out', async () => {
    const young = [row(NOW - 2 * DAY), row(NOW - 1 * DAY)];
    write(young);
    registerAge(30 * DAY);
    const before = statSync(path).mtimeMs;

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.rewrote).toBe(false);
    expect(out.linesDropped).toBe(0);
    expect(out.bytesBefore).toBe(out.bytesAfter);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('stops at a line whose ts cannot be read and KEEPS it', async () => {
    // Fail-safe direction: a line we cannot date is not a line we may delete.
    write([row(NOW - 40 * DAY), '{"no_ts":true}', row(NOW - 1 * DAY)]);
    registerAge(30 * DAY);

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.stoppedOnUnreadableTs).toBe(true);
    expect(out.linesDropped).toBe(1);
    const kept = readFileSync(path, 'utf8');
    expect(kept).toContain('"no_ts":true');
    expect(kept.startsWith('{"no_ts":true}')).toBe(true);
  });

  it('empties a tape that has been silent longer than its retention', async () => {
    write([row(NOW - 90 * DAY), row(NOW - 80 * DAY)]);
    registerAge(30 * DAY);

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.rewrote).toBe(true);
    expect(out.linesDropped).toBe(2);
    expect(readFileSync(path, 'utf8')).toBe('');
    expect(out.span.fill).toBe('unknown');
  });

  it('keeps the cut byte-exact when a multi-byte character straddles a read chunk', async () => {
    // THE REGRESSION. Chunks are 256 KiB; decoding a chunk as utf8 splits the `é` at
    // the boundary into replacement characters, which changes the decoded string's
    // byte length and therefore moves every offset derived from it. Offsets here are
    // computed on Buffers, so this must come out exact.
    const lines: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      lines.push(row(NOW - 40 * DAY, { i, pad: 'é'.repeat(60) }));
    }
    const young: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      young.push(row(NOW - 1 * DAY, { i, pad: 'é'.repeat(60) }));
    }
    write([...lines, ...young]);
    expect(statSync(path).size).toBeGreaterThan(512 * 1024); // spans several chunks
    registerAge(30 * DAY);

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.linesDropped).toBe(4000);
    expect(readFileSync(path, 'utf8')).toBe(young.join('\n') + '\n');
  });
});

describe('byte predicate (otm-admission-tape shape)', () => {
  it('drops oldest whole lines until the file is at or under the cap', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i += 1) lines.push(row(NOW - (200 - i) * 60_000, { i }));
    write(lines);
    const size = statSync(path).size;
    const cap = Math.floor(size / 2);
    registerBytes(cap);

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.rewrote).toBe(true);
    expect(out.bytesAfter).toBeLessThanOrEqual(cap);
    // Line-aligned: the retained file must still be whole JSONL rows.
    const kept = readFileSync(path, 'utf8');
    expect(kept.endsWith('\n')).toBe(true);
    for (const l of kept.split('\n').filter((x) => x !== '')) {
      expect(() => JSON.parse(l) as unknown).not.toThrow();
    }
    // It is the OLDEST that went: the newest row must survive.
    expect(kept).toContain('"i":199');
    expect(kept).not.toContain('"i":0,');
  });

  it('does nothing while under the cap, and reports the span not a cutoff', async () => {
    write([row(NOW - 5 * DAY), row(NOW - 1 * DAY)]);
    registerBytes(64 * 1024 * 1024);

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.rewrote).toBe(false);
    // A byte cap has NO time horizon — AC2's point about taking the predicate per tape.
    expect(out.span.cutoff).toBeNull();
    expect(out.span.cutoffHeadroomDays).toBeNull();
    expect(out.span.fill).toBe('still_filling');
    expect(out.span.fillBasis).toContain('UNDER CAP');
    expect(out.span.spanDays).toBeCloseTo(4, 3);
  });
});

describe('bytes_whole_day predicate (the otm-admission-tape bound)', () => {
  function registerWholeDay(maxBytes: number, tape = 'fixture'): void {
    registerSharedTape({
      tape,
      resolvePath: () => path,
      predicate: () => ({ kind: 'bytes_whole_day', maxBytes }),
      flushLine: (line) => {
        flushed.push(line);
      },
      note: 'test fixture',
    });
  }

  /** `rows` rows on each of `days`, in day order, as the append-only tape writes them. */
  function writeDays(days: string[], rows: number): void {
    const lines: string[] = [];
    days.forEach((etDay, d) => {
      for (let i = 0; i < rows; i += 1) {
        lines.push(JSON.stringify({ ts: NOW - (days.length - d) * DAY + i, etDay, i }));
      }
    });
    write(lines);
  }

  it('cuts on a DAY boundary, never mid-day', async () => {
    // Why: consumers of this tape divide by SESSIONS. A partial day biases its own
    // within-day sample toward the afternoon, and a biased day is worse than an
    // absent one — so the cut must land where a day starts.
    writeDays(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'], 40);
    const size = statSync(path).size;
    registerWholeDay(Math.floor(size * 0.55)); // forces at least one day out

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.rewrote).toBe(true);
    const kept = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
    const days = [...new Set(kept.map((l) => (JSON.parse(l) as { etDay: string }).etDay))];
    // Every retained day must be WHOLE: 40 rows each, no truncated head.
    for (const d of days) {
      expect(kept.filter((l) => (JSON.parse(l) as { etDay: string }).etDay === d)).toHaveLength(40);
    }
    // And it is the OLDEST days that went.
    expect(days).toContain('2026-10-01');
    expect(days).not.toContain('2026-09-28');
    expect(out.bytesAfter).toBeLessThanOrEqual(Math.floor(size * 0.55));
    expect(out.linesDropped % 40).toBe(0);
  });

  it('keeps the NEWEST day even when that one day alone exceeds the cap', async () => {
    // Same `days.length > 1` guard the boot prune has always applied: an over-cap-by-
    // one-day overshoot is bounded, an empty evidence archive is not recoverable.
    writeDays(['2026-09-30', '2026-10-01'], 50);
    registerWholeDay(10); // absurdly small

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    const kept = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
    expect(kept).toHaveLength(50);
    const days = [...new Set(kept.map((l) => (JSON.parse(l) as { etDay: string }).etDay))];
    expect(days).toEqual(['2026-10-01']);
    expect(out.bytesAfter).toBeGreaterThan(10); // the overshoot is REPORTED, not hidden
  });

  it('refuses to empty a single-day tape that is over cap', async () => {
    writeDays(['2026-10-01'], 50);
    registerWholeDay(10);

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.rewrote).toBe(false);
    expect(out.linesDropped).toBe(0);
    expect(readFileSync(path, 'utf8').split('\n').filter((l) => l !== '')).toHaveLength(50);
  });

  it('does nothing while under the cap', async () => {
    writeDays(['2026-09-30', '2026-10-01'], 20);
    registerWholeDay(64 * 1024 * 1024);

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.rewrote).toBe(false);
    expect(out.span.cutoff).toBeNull();
    expect(out.span.fill).toBe('still_filling');
    expect(out.span.fillBasis).toContain('UNDER CAP');
  });

  it('calls onRewrite so an owner byte counter cannot survive the rewrite stale', async () => {
    // otm-admission-tape counts `fileBytes` on the way in. Without this it would
    // overstate the file by exactly the bytes a compaction just reclaimed — a field
    // that keeps reading plausible while being wrong.
    writeDays(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'], 40);
    const size = statSync(path).size;
    let owned = size;
    registerSharedTape({
      tape: 'counted',
      resolvePath: () => path,
      predicate: () => ({ kind: 'bytes_whole_day', maxBytes: Math.floor(size * 0.55) }),
      flushLine: () => {},
      onRewrite: (bytesAfter) => {
        owned = bytesAfter;
      },
      note: 'counted fixture',
    });

    const out = await compactSharedTapeNow('counted', NOW, 'timer');

    expect(out.rewrote).toBe(true);
    expect(owned).toBe(statSync(path).size);
    expect(owned).toBeLessThan(size);
  });

  it('does not treat an undatable row as a day boundary', async () => {
    // A row with no readable etDay rides along inside the day that precedes it, so it
    // can never become a cut point of its own.
    const lines = [
      JSON.stringify({ ts: NOW - 3 * DAY, etDay: '2026-09-29', i: 0 }),
      JSON.stringify({ ts: NOW - 3 * DAY, i: 1 }), // no etDay
      JSON.stringify({ ts: NOW - 1 * DAY, etDay: '2026-10-01', i: 2 }),
    ];
    write(lines);
    const size = statSync(path).size;
    registerWholeDay(size - Buffer.byteLength(lines[0] as string, 'utf8'));

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    const kept = readFileSync(path, 'utf8');
    // The cut landed at the 2026-10-01 boundary, so BOTH 09-29 rows went together.
    expect(kept).not.toContain('"i":1');
    expect(kept).toContain('"i":2');
    expect(out.linesDropped).toBe(2);
  });
});

describe('span — the AC1 answer', () => {
  it('reads still_filling when the tape begins well inside its own cutoff', async () => {
    // 20 days of content against a 30-day retention: `size / 30` understates the rate.
    write([row(NOW - 20 * DAY), row(NOW - 1 * DAY)]);
    registerAge(30 * DAY);

    const out = await measureSharedTapeSpan('fixture', NOW);

    expect(out.span.fill).toBe('still_filling');
    expect(out.span.cutoffHeadroomDays).toBeCloseTo(10, 2);
    expect(out.span.spanDays).toBeCloseTo(19, 2);
    expect(out.span.observedBytesPerDay).not.toBeNull();
    expect(out.span.fillBasis).toContain('UNDERSTATES');
  });

  it('reads at_steady_state when the oldest row sits at the cutoff', async () => {
    write([row(NOW - 30 * DAY + 60_000), row(NOW - 1 * DAY)]);
    registerAge(30 * DAY);

    const out = await measureSharedTapeSpan('fixture', NOW);

    expect(out.span.fill).toBe('at_steady_state');
    expect(out.span.fillBasis).toContain('horizon is FULL');
  });

  it('tolerates a weekend hole at the head of a steady-state tape', async () => {
    // These tapes only write on sessions, so a tape genuinely at steady state can
    // begin up to a session gap inside its cutoff. A tighter tolerance would read
    // every Monday boot as "still filling".
    write([row(NOW - 30 * DAY + 0.8 * DAY), row(NOW)]);
    registerAge(30 * DAY);

    expect((await measureSharedTapeSpan('fixture', NOW)).span.fill).toBe('at_steady_state');
  });

  it('is at_steady_state whenever the pass actually dropped rows', async () => {
    write([row(NOW - 40 * DAY), row(NOW - 3 * DAY)]);
    registerAge(30 * DAY);

    const out = await compactSharedTapeNow('fixture', NOW, 'timer');

    expect(out.linesDropped).toBe(1);
    expect(out.span.fill).toBe('at_steady_state');
    expect(out.span.fillBasis).toContain('fell below the cutoff');
  });

  it('never guesses a span it cannot read', async () => {
    write([]);
    registerAge(30 * DAY);

    const out = await measureSharedTapeSpan('fixture', NOW);

    expect(out.span.fill).toBe('unknown');
    expect(out.span.oldestRetainedTs).toBeNull();
    expect(out.span.observedBytesPerDay).toBeNull();
  });

  it('a boot measure populates the span and rewrites NOTHING', async () => {
    // Why this matters: bqb1's uptime is routinely under one interval, so if the span
    // only appeared inside a timer outcome, AC1 would be unreadable on the one host
    // that matters.
    const lines = [row(NOW - 40 * DAY), row(NOW - 1 * DAY)];
    write(lines);
    registerAge(30 * DAY);
    const sizeBefore = statSync(path).size;

    const out = await measureSharedTapeSpan('fixture', NOW);

    expect(out.trigger).toBe('boot_measure');
    expect(out.rewrote).toBe(false);
    expect(out.skipped).toBe('measure_only');
    expect(statSync(path).size).toBe(sizeBefore);
    expect(readFileSync(path, 'utf8')).toBe(lines.join('\n') + '\n');
    expect(sharedTapeCompactionState('fixture', NOW).span).not.toBeNull();
  });
});

describe('the append interlock (AC4)', () => {
  /** Wait until the rewrite has raised the flag, so the append lands INSIDE the window. */
  async function waitInFlight(tape: string): Promise<void> {
    for (let i = 0; i < 500; i += 1) {
      if (sharedTapeRewriteInFlight(tape)) return;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error('rewrite never went in flight');
  }

  it('buffers an append landing during the rewrite and flushes it through the OWNER', async () => {
    write([row(NOW - 40 * DAY), row(NOW - 1 * DAY)]);
    registerAge(30 * DAY);

    const p = compactSharedTapeNow('fixture', NOW, 'timer');
    await waitInFlight('fixture');
    const live = row(NOW, { live: true });
    expect(bufferSharedTapeAppend('fixture', live)).toBe(true);
    const out = await p;

    expect(out.rewrote).toBe(true);
    expect(out.bufferedAppendsFlushed).toBe(1);
    // Through the owner's own append, so the owner's appendErrors accounting stays
    // intact (TRA-1681).
    expect(flushed).toEqual([live]);
    expect(sharedTapeRewriteInFlight('fixture')).toBe(false);
  });

  it('flushes buffered appends even when the rewrite FAILED', async () => {
    // An erased row reads identically to a row never written, so the failure path
    // must not swallow the buffer. The tmp name is derived from `now`, which is
    // injected — so a directory parked at that exact path is a deterministic
    // EISDIR with no production test seam.
    write([row(NOW - 40 * DAY), row(NOW - 1 * DAY)]);
    registerAge(30 * DAY);
    mkdirSync(`${path}.compact-${process.pid}-${NOW}.tmp`, { recursive: true });

    const p = compactSharedTapeNow('fixture', NOW, 'timer');
    await waitInFlight('fixture');
    const live = row(NOW, { live: true });
    bufferSharedTapeAppend('fixture', live);
    const out = await p;

    expect(out.rewrote).toBe(false);
    expect(out.error).toBeDefined();
    expect(out.bufferedAppendsFlushed).toBe(1);
    expect(flushed).toEqual([live]);
    // The bound is unchanged and disk is NOT compacted — reported, not hidden.
    expect(out.bytesAfter).toBe(out.bytesBefore);
    expect(out.linesDropped).toBe(0);
  });

  it('refuses an overlapping pass without clobbering the last real outcome', async () => {
    write([row(NOW - 40 * DAY), row(NOW - 1 * DAY)]);
    registerAge(30 * DAY);

    const p = compactSharedTapeNow('fixture', NOW, 'timer');
    await waitInFlight('fixture');
    const second = await compactSharedTapeNow('fixture', NOW, 'timer');
    const first = await p;

    expect(second.skipped).toBe('already_in_flight');
    expect(second.rewrote).toBe(false);
    expect(first.rewrote).toBe(true);
    expect(sharedTapeCompactionState('fixture', NOW).last?.rewrote).toBe(true);
  });

  it('does not raise the interlock for a measure-only pass', async () => {
    // A read that cannot lose a row must not buffer live appends for its duration.
    write([row(NOW - 40 * DAY), row(NOW - 1 * DAY)]);
    registerAge(30 * DAY);
    const p = measureSharedTapeSpan('fixture', NOW);
    expect(sharedTapeRewriteInFlight('fixture')).toBe(false);
    await p;
    expect(sharedTapeRewriteInFlight('fixture')).toBe(false);
  });
});

describe('hookState — the gradeable field (AC3)', () => {
  beforeEach(() => {
    write([row(NOW - 1 * DAY)]);
    registerAge(30 * DAY);
  });

  it('reads timer_not_armed when nothing scheduled a pass — THE ALARM', () => {
    const s = sharedTapeCompactionState('fixture', NOW);
    expect(s.hookState).toBe('timer_not_armed');
    expect(s.timerArmedAt).toBeNull();
    expect(s.nextFireDueAt).toBeNull();
    // The shape this enum exists to catch: every other field still reads healthy.
    expect(s.predicate).toEqual({ kind: 'age', retainMs: 30 * DAY });
    expect(s.intervalMs).toBe(SHARED_TAPE_COMPACTION_INTERVAL_MS);
  });

  it('reads armed_not_yet_due with zero passes inside the first interval', () => {
    noteSharedTapeCompactionArmed(NOW);
    const s = sharedTapeCompactionState('fixture', NOW + 60_000);
    expect(s.hookState).toBe('armed_not_yet_due');
    expect(s.timerPasses).toBe(0);
    expect(s.nextFireDueAt).toBe(
      new Date(NOW + SHARED_TAPE_COMPACTION_INTERVAL_MS).toISOString(),
    );
  });

  it('reads overdue once past due with no pass — the dead interval', () => {
    noteSharedTapeCompactionArmed(NOW);
    const s = sharedTapeCompactionState(
      'fixture',
      NOW + SHARED_TAPE_COMPACTION_INTERVAL_MS + 10 * 60 * 1000,
    );
    expect(s.hookState).toBe('overdue');
  });

  it('reads firing after a pass, and advances the due instant', async () => {
    noteSharedTapeCompactionArmed(NOW);
    await runSharedTapeCompactionPass(NOW + SHARED_TAPE_COMPACTION_INTERVAL_MS);
    const s = sharedTapeCompactionState('fixture', NOW + SHARED_TAPE_COMPACTION_INTERVAL_MS + 1000);
    expect(s.hookState).toBe('firing');
    expect(s.timerPasses).toBe(1);
    expect(s.nextFireDueAt).toBe(
      new Date(NOW + 2 * SHARED_TAPE_COMPACTION_INTERVAL_MS).toISOString(),
    );
  });

  it('publishes the cadence premium, and clears AC2 on a 30-day tape', () => {
    const s = sharedTapeCompactionState('fixture', NOW);
    // AC2's ceiling is cost-aware-gate's +3.6% (6h / 7d). 6h / 30d is +0.83%.
    expect(s.cadencePremium).toBeCloseTo(6 / (30 * 24), 6);
    expect(s.cadencePremium as number).toBeLessThan(0.036);
  });

  it('reports no cadence premium for a byte cap — it has no retention to overshoot', () => {
    clearSharedTapeCompaction();
    registerBytes(144 * 1024 * 1024);
    expect(sharedTapeCompactionState('fixture', NOW).cadencePremium).toBeNull();
  });
});

describe('the shared pass covers every registered tape', () => {
  it('compacts all of them in ONE pass and counts the pass once', async () => {
    // AC2: one hook, not four bespoke timers.
    const paths: Record<string, string> = {};
    for (const tape of ['a', 'b', 'c']) {
      const p = join(dir, `${tape}.jsonl`);
      writeFileSync(p, [row(NOW - 40 * DAY), row(NOW - 1 * DAY)].join('\n') + '\n', 'utf8');
      paths[tape] = p;
      registerSharedTape({
        tape,
        resolvePath: () => p,
        predicate: () => ({ kind: 'age', retainMs: 30 * DAY }),
        flushLine: () => {},
        note: `tape ${tape}`,
      });
    }
    noteSharedTapeCompactionArmed(NOW);

    const outs = await runSharedTapeCompactionPass(NOW);

    expect(outs.map((o) => o.tape).sort()).toEqual(['a', 'b', 'c']);
    for (const o of outs) expect(o.linesDropped).toBe(1);
    for (const tape of ['a', 'b', 'c']) {
      expect(readFileSync(paths[tape] as string, 'utf8').split('\n').filter((l) => l !== '')).toHaveLength(1);
      // One shared hook ⇒ one pass count, visible identically from every tape.
      expect(sharedTapeCompactionState(tape, NOW).timerPasses).toBe(1);
      expect(sharedTapeCompactionState(tape, NOW).hookState).toBe('firing');
    }
  });

  it('names an unconfigured data dir instead of reporting a clean pass', async () => {
    registerSharedTape({
      tape: 'nodir',
      resolvePath: () => null,
      predicate: () => ({ kind: 'age', retainMs: 30 * DAY }),
      flushLine: () => {},
      note: 'no dir',
    });
    const out = await compactSharedTapeNow('nodir', NOW, 'timer');
    expect(out.skipped).toBe('no_path');
    expect(out.rewrote).toBe(false);
  });

  it('names a missing file instead of reporting a clean pass', async () => {
    registerAge(30 * DAY);
    rmSync(path, { force: true });
    const out = await compactSharedTapeNow('fixture', NOW, 'timer');
    expect(out.skipped).toBe('no_file');
  });
});
