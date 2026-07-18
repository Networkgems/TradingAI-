import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectLeakedOptionsPnlCells,
  scrubStaleOptionsPnlCells,
  TRA594_STALE_CELL_CUTOFF,
} from './stale-cell-cleanup.js';

// TRA-1475 (Part 2) — pre-TRA-594 corrupted-cell detection + scrub.

describe('detectLeakedOptionsPnlCells', () => {
  it('flags a run of ≥2 consecutive identical non-zero pre-cutoff cells', () => {
    // mirrors the issue's example: 158.28 frozen across 06-03/04/05
    const cells = [
      { date: '2026-06-03', optionsPnl: 158.28 },
      { date: '2026-06-04', optionsPnl: 158.28 },
      { date: '2026-06-05', optionsPnl: 158.28 },
    ];
    expect(detectLeakedOptionsPnlCells(cells).sort()).toEqual([
      '2026-06-03', '2026-06-04', '2026-06-05',
    ]);
  });

  it('handles the -44.00 non-adjacent-calendar run (consecutive in file order)', () => {
    const cells = [
      { date: '2026-05-22', optionsPnl: -44 },
      { date: '2026-05-24', optionsPnl: -44 },
      { date: '2026-05-26', optionsPnl: -44 },
    ];
    expect(detectLeakedOptionsPnlCells(cells).length).toBe(3);
  });

  it('leaves an isolated single value untouched (genuine one-day close)', () => {
    const cells = [
      { date: '2026-06-01', optionsPnl: 5 },
      { date: '2026-06-02', optionsPnl: 8 },
      { date: '2026-06-03', optionsPnl: 8 },
      { date: '2026-06-04', optionsPnl: 8 },
    ];
    // only the 8-run is leaked; the isolated 5 stays
    expect(detectLeakedOptionsPnlCells(cells).sort()).toEqual([
      '2026-06-02', '2026-06-03', '2026-06-04',
    ]);
  });

  it('never flags a repeated ZERO value (a flat no-options day is clean)', () => {
    const cells = [
      { date: '2026-06-01', optionsPnl: 0 },
      { date: '2026-06-02', optionsPnl: 0 },
      { date: '2026-06-03', optionsPnl: 0 },
    ];
    expect(detectLeakedOptionsPnlCells(cells)).toEqual([]);
  });

  it('never touches post-cutoff cells, even a repeated run', () => {
    const cells = [
      { date: '2026-06-10', optionsPnl: 12 },
      { date: '2026-06-11', optionsPnl: 12 },
      { date: '2026-06-12', optionsPnl: 12 },
    ];
    expect(detectLeakedOptionsPnlCells(cells)).toEqual([]);
  });

  it('does not let a run straddle the cutoff', () => {
    const cells = [
      { date: '2026-06-08', optionsPnl: 30 }, // pre-cutoff, isolated pre-side
      { date: '2026-06-09', optionsPnl: 30 }, // cutoff day → excluded
      { date: '2026-06-10', optionsPnl: 30 },
    ];
    // the pre-cutoff side has only one cell → nothing removed
    expect(detectLeakedOptionsPnlCells(cells)).toEqual([]);
  });
});

describe('scrubStaleOptionsPnlCells', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tra1475-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeCell(date: string, optionsPnl: number, withMd = false): Promise<void> {
    await writeFile(join(dir, `${date}.json`), JSON.stringify({ date, optionsPnl, combinedPnl: optionsPnl }), 'utf-8');
    if (withMd) await writeFile(join(dir, `${date}.md`), `# ${date}`, 'utf-8');
  }

  it('deletes only the leaked pre-cutoff cells (json + sibling md), keeps clean + post-fix', async () => {
    await writeCell('2026-06-03', 158.28, true);
    await writeCell('2026-06-04', 158.28, true);
    await writeCell('2026-06-05', 158.28);
    await writeCell('2026-06-06', 12.5); // isolated pre-cutoff → kept
    await writeCell('2026-06-10', 158.28, true); // post-fix, same value → kept
    await writeFile(join(dir, 'latest.json'), '{}', 'utf-8'); // non-cell → ignored

    const removed = await scrubStaleOptionsPnlCells(dir);
    expect(removed.sort()).toEqual(['2026-06-03', '2026-06-04', '2026-06-05']);

    const left = (await readdir(dir)).sort();
    expect(left).toEqual([
      '2026-06-06.json',
      '2026-06-10.json',
      '2026-06-10.md',
      'latest.json',
    ]);
  });

  it('is idempotent — a second run removes nothing', async () => {
    await writeCell('2026-05-22', -44);
    await writeCell('2026-05-24', -44);
    expect((await scrubStaleOptionsPnlCells(dir)).length).toBe(2);
    expect(await scrubStaleOptionsPnlCells(dir)).toEqual([]);
  });

  it('no-ops on a missing directory', async () => {
    expect(await scrubStaleOptionsPnlCells(join(dir, 'nope'))).toEqual([]);
  });

  it('uses the documented TRA-594 cutoff', () => {
    expect(TRA594_STALE_CELL_CUTOFF).toBe('2026-06-09');
  });
});
