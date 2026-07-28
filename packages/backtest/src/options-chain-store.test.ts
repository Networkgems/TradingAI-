// TRA-2476 — `loadChainDays` `lastN`: the 3:55 PM ET alert push only diffs
// today vs yesterday, and residenting every recorded partition was part of the
// close-adjacent RSS spike that killed bqb1. `lastN` must return exactly what a
// full load's `days.slice(-N)` returns — including when the newest directory on
// disk is empty (a real shape: 2026-06-02 is an empty partition on bqb1).
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadChainDays } from './options-chain-store.js';

const snap = (symbol: string) =>
  JSON.stringify({ symbol, spot: 100, recordedAt: 1, expirations: ['2026-08-21'], rows: [{}] });

describe('loadChainDays lastN', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chains-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeDay = async (date: string, symbols: string[]) => {
    await mkdir(join(dir, date));
    for (const s of symbols) await writeFile(join(dir, date, `${s}.json`), snap(s), 'utf-8');
  };

  it('returns the newest N non-empty partitions, ascending, matching a full load', async () => {
    await writeDay('2026-07-24', ['AAPL']);
    await writeDay('2026-07-27', ['AAPL', 'SPY']);
    await writeDay('2026-07-28', ['AAPL']);

    const limited = await loadChainDays(dir, { lastN: 2 });
    const full = await loadChainDays(dir);
    expect(limited.map((d) => d.date)).toEqual(['2026-07-27', '2026-07-28']);
    expect(limited.map((d) => d.date)).toEqual(full.slice(-2).map((d) => d.date));
    expect([...limited[0].bySymbol.keys()].sort()).toEqual(['AAPL', 'SPY']);
  });

  it('does not count an empty partition toward N', async () => {
    await writeDay('2026-07-24', ['AAPL']);
    await writeDay('2026-07-27', ['AAPL']);
    await mkdir(join(dir, '2026-07-28')); // empty — like bqb1's 2026-06-02
    await writeFile(join(dir, '.chain-hook-last-run'), '2026-07-28', 'utf-8');

    const limited = await loadChainDays(dir, { lastN: 2 });
    expect(limited.map((d) => d.date)).toEqual(['2026-07-24', '2026-07-27']);
  });

  it('returns everything when lastN exceeds the partition count, and [] on a missing dir', async () => {
    await writeDay('2026-07-28', ['AAPL']);
    expect((await loadChainDays(dir, { lastN: 5 })).map((d) => d.date)).toEqual(['2026-07-28']);
    expect(await loadChainDays(join(dir, 'nope'), { lastN: 2 })).toEqual([]);
  });
});
