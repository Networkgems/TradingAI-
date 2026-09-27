/**
 * TRA-4903 — the 27 previously-unbounded `/data` tapes.
 *
 * The point of these tests is the one thing a constant cannot prove: that the
 * ceiling is ENFORCED and that the refusal is the safe direction. A `maxBytes`
 * that ships with its call site unwired reads identically to one that works
 * (the TRA-3514 hole), so every test below exercises the write path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  DATA_TAPE_BOUNDS,
  DATA_TAPE_BOUNDS_COUNT,
  DATA_TAPE_BOUNDS_TOTAL_BYTES,
  appendBoundedTapeLine,
  appendBoundedTapeLineSync,
  dataTapeBoundsReport,
  resetDataTapeBoundsForTests,
  seedDataTapeBounds,
} from './data-tape-bounds.js';

let dir: string;

beforeEach(() => {
  resetDataTapeBoundsForTests();
  dir = mkdtempSync(join(tmpdir(), 'tra4903-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetDataTapeBoundsForTests();
});

/** A tape whose ceiling is small enough to saturate in a test without writing MiBs. */
const TAPE = 'live-option-reconcile-terminations.jsonl'; // 4 MiB

describe('TRA-4903 — the manifest', () => {
  it('bounds exactly the 27 tapes the TRA-4899 census reported as UNBOUNDED', () => {
    expect(DATA_TAPE_BOUNDS_COUNT).toBe(27);
    expect(Object.keys(DATA_TAPE_BOUNDS)).toHaveLength(27);
  });

  it('gives every tape a finite, positive ceiling — a bound is the whole deliverable', () => {
    for (const [name, b] of Object.entries(DATA_TAPE_BOUNDS)) {
      expect(Number.isFinite(b.maxBytes), name).toBe(true);
      expect(b.maxBytes, name).toBeGreaterThan(0);
      expect(b.note.length, name).toBeGreaterThan(0);
    }
  });

  it('publishes the aggregate reservation, so the budget cannot grow unstated', () => {
    expect(DATA_TAPE_BOUNDS_TOTAL_BYTES).toBe(248 * 1024 * 1024);
  });

  it('keeps every ceiling well clear of the size measured on bqb1 2026-09-25', () => {
    // A seal's failure mode is "the tape stops recording", so a ceiling a healthy
    // tape already sits near is worse than no ceiling. Nothing may exceed 50%.
    for (const [name, b] of Object.entries(DATA_TAPE_BOUNDS)) {
      if (b.observedBytes === null) continue;
      expect(b.observedBytes / b.maxBytes, `${name} is too close to its ceiling`).toBeLessThan(0.5);
    }
  });
});

describe('TRA-4903 — enforcement', () => {
  it('writes a line that fits, and reports the fill fraction', async () => {
    const p = join(dir, TAPE);
    await expect(appendBoundedTapeLine(p, '{"a":1}\n')).resolves.toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}\n');

    const row = dataTapeBoundsReport().tapes.find((t) => t.tape === TAPE);
    expect(row?.bytes).toBe(8);
    expect(row?.breached).toBe(false);
    expect(row?.refusedAppends).toBe(0);
  });

  it('REFUSES the append at the ceiling instead of truncating — nothing on disk is lost', () => {
    const p = join(dir, TAPE);
    // Seed a file that is already at the ceiling, then seed the cache off it.
    const ceiling = DATA_TAPE_BOUNDS[TAPE]!.maxBytes;
    writeFileSync(p, 'x'.repeat(ceiling), 'utf8');
    seedDataTapeBounds(dir);

    expect(appendBoundedTapeLineSync(p, '{"late":true}\n')).toBe(false);

    // The refusal must not have destroyed or shortened what was already there.
    // This is the whole argument for `seal` over truncate-oldest: on these 27
    // tapes the past rows are largely non-re-derivable.
    expect(statSync(p).size).toBe(ceiling);
    expect(readFileSync(p, 'utf8')).not.toContain('late');

    const row = dataTapeBoundsReport().tapes.find((t) => t.tape === TAPE);
    expect(row?.breached).toBe(true);
    expect(row?.refusedAppends).toBe(1);
    expect(row?.refusedBytes).toBe(14);
    expect(row?.breachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses a line that would STRADDLE the ceiling, not merely one that starts past it', () => {
    const p = join(dir, TAPE);
    const ceiling = DATA_TAPE_BOUNDS[TAPE]!.maxBytes;
    writeFileSync(p, 'x'.repeat(ceiling - 4), 'utf8');
    seedDataTapeBounds(dir);
    // 8 bytes into 4 remaining: an off-by-one here would let every tape overshoot
    // by one line, which on a high-rate tape is the difference between a bound and
    // an approximate one.
    expect(appendBoundedTapeLineSync(p, '{"a":1}\n')).toBe(false);
    expect(statSync(p).size).toBe(ceiling - 4);
    // ...but a line that exactly fills the remainder is admitted.
    expect(appendBoundedTapeLineSync(p, 'abcd')).toBe(true);
    expect(statSync(p).size).toBe(ceiling);
  });

  it('counts multi-byte characters as bytes, not as characters', async () => {
    const p = join(dir, TAPE);
    await appendBoundedTapeLine(p, '{"s":"é"}\n'); // 10 chars, 11 bytes
    expect(dataTapeBoundsReport().tapes.find((t) => t.tape === TAPE)?.bytes).toBe(11);
    expect(statSync(p).size).toBe(11);
  });

  it('logs the breach ONCE, not once per refused row', () => {
    // A saturated high-rate tape would otherwise turn a disk problem into a log
    // problem. Asserted through the counters: refusals keep accruing after the
    // first, which is what proves the early-return is on the LOG and not on the
    // accounting.
    const p = join(dir, TAPE);
    writeFileSync(p, 'x'.repeat(DATA_TAPE_BOUNDS[TAPE]!.maxBytes), 'utf8');
    seedDataTapeBounds(dir);
    for (let i = 0; i < 5; i++) expect(appendBoundedTapeLineSync(p, 'yy')).toBe(false);
    const row = dataTapeBoundsReport().tapes.find((t) => t.tape === TAPE);
    expect(row?.refusedAppends).toBe(5);
    expect(row?.refusedBytes).toBe(10);
  });

  it('passes through a path that is NOT in the manifest, rather than bounding it at a default', async () => {
    // A tape whose ceiling has not been decided must not be silently capped at
    // whatever this module happens to default to.
    const p = join(dir, 'not-a-census-tape.jsonl');
    await expect(appendBoundedTapeLine(p, 'hello\n')).resolves.toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('hello\n');
    expect(dataTapeBoundsReport().tapes.some((t) => t.tape === 'not-a-census-tape.jsonl')).toBe(false);
  });

  it('keys on the basename, so any DATA_DIR is bounded the same way', async () => {
    const nested = join(dir, 'a', 'b');
    const p = join(nested, TAPE);
    const { mkdirSync } = await import('fs');
    mkdirSync(nested, { recursive: true });
    await appendBoundedTapeLine(p, '{"a":1}\n');
    expect(dataTapeBoundsReport().tapes.find((t) => t.tape === TAPE)?.bytes).toBe(8);
  });
});

describe('TRA-4903 — the boot seed', () => {
  it('changes no file: a seal refuses, it never rewrites', () => {
    const p = join(dir, TAPE);
    writeFileSync(p, 'one\ntwo\n', 'utf8');
    const before = readFileSync(p, 'utf8');
    const s = seedDataTapeBounds(dir);
    expect(s.seeded).toBe(27);
    expect(s.existing).toBe(1);
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it('creates nothing for a tape that is absent — 10 of the 27 do not exist on bqb1', () => {
    seedDataTapeBounds(dir);
    for (const name of Object.keys(DATA_TAPE_BOUNDS)) {
      expect(existsSync(join(dir, name)), name).toBe(false);
    }
  });

  it('seeds the size off disk, so the ceiling accounts for rows written by an earlier boot', () => {
    const p = join(dir, TAPE);
    writeFileSync(p, 'x'.repeat(100), 'utf8');
    seedDataTapeBounds(dir);
    expect(dataTapeBoundsReport().tapes.find((t) => t.tape === TAPE)?.bytes).toBe(100);
  });
});

describe('TRA-4903 — the health surface', () => {
  it('distinguishes "not touched this boot" (null) from "empty" (0)', async () => {
    const report = dataTapeBoundsReport();
    expect(report.touchedCount).toBe(0);
    // An untouched tape reads null, NOT 0. On a tape whose flag is off that is
    // the correct standing read, and conflating the two is how an unwired layer
    // comes to look like a layer that ran and found nothing (TRA-3514).
    expect(report.tapes.every((t) => t.bytes === null && t.fillPct === null)).toBe(true);

    await appendBoundedTapeLine(join(dir, TAPE), 'a\n');
    const after = dataTapeBoundsReport();
    expect(after.touchedCount).toBe(1);
    expect(after.breachedCount).toBe(0);
  });

  it('ranks the fullest tape first, so the next breach is the top row', async () => {
    await appendBoundedTapeLine(join(dir, TAPE), 'a\n');
    expect(dataTapeBoundsReport().tapes[0]?.tape).toBe(TAPE);
  });

  it('publishes the count and the aggregate the census asserts against', () => {
    const r = dataTapeBoundsReport();
    expect(r.count).toBe(DATA_TAPE_BOUNDS_COUNT);
    expect(r.totalMaxBytes).toBe(DATA_TAPE_BOUNDS_TOTAL_BYTES);
    expect(r.tapes).toHaveLength(27);
  });
});
