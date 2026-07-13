import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, writeFile, appendFile } from 'fs/promises';
import {
  recordOptionTradeOpen,
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  getOptionTradeJournalIntegrity,
  type OptionTradeJournalOpen,
} from './option-trade-journal.js';

// TRA-1681 — the load's corrupt-line skip was SILENT. A journal that dropped rows
// and one that dropped none read identically, which is the exact instrument gap
// TRA-1690's negative control ("this counter did not grow" == no leak) sits on.

let tmpFile: string;
let counter = 0;

beforeEach(() => {
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra1681-integrity-${process.pid}-${counter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

function baseOpen(over: Partial<OptionTradeJournalOpen> = {}): OptionTradeJournalOpen {
  return {
    id: 'pos-1',
    openTs: 1,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    mode: 'demo',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 40,
    atRiskUsd: 100,
    entrySlippageUsd: 0,
    ...over,
  };
}

describe('option journal load integrity (TRA-1681)', () => {
  it('reports corruptLines: null before any load — not measured is not zero', () => {
    // `0` would claim a clean file we have never actually read. See TRA-1707.
    expect(getOptionTradeJournalIntegrity()).toEqual({ corruptLines: null, readError: null });
  });

  it('reports zero corrupt lines on a clean journal', async () => {
    await recordOptionTradeOpen(baseOpen());
    setOptionTradeJournalFileForTests(tmpFile); // force a fresh fold from disk
    await listOptionTradeJournal();

    expect(getOptionTradeJournalIntegrity()).toEqual({ corruptLines: 0, readError: null });
  });

  it('counts a torn tail line that swallowed the NEXT appended record', async () => {
    // The real failure: a crash mid-appendFile leaves a truncated line, and the
    // next append concatenates onto that fragment. Nothing ever DECREASES — the
    // file stays monotone — the swallowed row simply never arrives. Without a
    // count, that reads as a clean load and the missing row certifies as absent.
    const good = { kind: 'open', rec: baseOpen({ id: 'kept' }) };
    await writeFile(tmpFile, `${JSON.stringify(good)}\n`, 'utf-8');
    await appendFile(tmpFile, '{"kind":"open","rec":{"id":"tor', 'utf-8'); // crash here
    const swallowed = { kind: 'open', rec: baseOpen({ id: 'swallowed' }) };
    await appendFile(tmpFile, `${JSON.stringify(swallowed)}\n`, 'utf-8');

    setOptionTradeJournalFileForTests(tmpFile);
    const rows = await listOptionTradeJournal();

    // The torn fragment ate the row that followed it: only 'kept' survives.
    expect(rows.map((r) => r.id)).toEqual(['kept']);
    // And that loss is now VISIBLE rather than indistinguishable from a clean load.
    expect(getOptionTradeJournalIntegrity().corruptLines).toBe(1);
  });

  it('surfaces the read-error fallback instead of silently serving an empty book', async () => {
    // A directory where the journal file should be: readFile throws (EISDIR), the
    // loader falls back to an empty map. An empty book and a failed mount must not
    // read the same. (The fail-open itself is what TRA-1681 closes; this is the
    // instrument that makes it detectable.)
    const dirAsFile = join(tmpdir(), `tra1681-dir-${process.pid}-${counter++}`);
    await rm(dirAsFile, { force: true, recursive: true });
    const { mkdir } = await import('fs/promises');
    await mkdir(dirAsFile, { recursive: true });

    setOptionTradeJournalFileForTests(dirAsFile);
    const rows = await listOptionTradeJournal();

    expect(rows).toEqual([]);
    expect(getOptionTradeJournalIntegrity().readError).not.toBeNull();

    await rm(dirAsFile, { force: true, recursive: true });
  });

  it('does not CACHE the empty book after a read error — the next read recovers', async () => {
    // The fail-open, not the instrument. The empty map used to be memoised, so ONE
    // failed read (a disk flap, a mount that came up late) pinned the journal to zero
    // rows for the whole process lifetime. The error was transient; the empty book was
    // forever — and it read exactly like a desk that had never traded.
    //
    // Note what this test does NOT do: it never re-calls setOptionTradeJournalFileForTests
    // between the two reads. That seam clears the cache, and clearing the cache is
    // precisely the thing the old code could only do by being restarted.
    const flapping = join(tmpdir(), `tra1681-flap-${process.pid}-${counter++}.jsonl`);
    await rm(flapping, { force: true, recursive: true });
    const { mkdir } = await import('fs/promises');
    await mkdir(flapping, { recursive: true }); // a directory ⇒ readFile throws EISDIR

    setOptionTradeJournalFileForTests(flapping);
    expect(await listOptionTradeJournal()).toEqual([]);
    expect(getOptionTradeJournalIntegrity().readError).not.toBeNull();

    // The disk comes back: same path, now a real journal with a real row.
    await rm(flapping, { force: true, recursive: true });
    await writeFile(flapping, `${JSON.stringify({ kind: 'open', rec: baseOpen({ id: 'recovered' }) })}\n`, 'utf-8');

    const rows = await listOptionTradeJournal();

    expect(rows.map((r) => r.id)).toEqual(['recovered']);
    expect(getOptionTradeJournalIntegrity()).toEqual({ corruptLines: 0, readError: null });

    await rm(flapping, { force: true, recursive: true });
  });
});
