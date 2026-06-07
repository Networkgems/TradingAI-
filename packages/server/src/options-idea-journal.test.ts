import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import type { DefinedRiskStrategy } from '@trading-app/agents';
import type { OptionsIdeaView } from './options-ideas-feed.js';
import {
  isoWeek,
  journalKey,
  recordSurfacedIdeas,
  listJournalEntries,
  setIdeaJournalFileForTests,
} from './options-idea-journal.js';

let dir: string | null = null;

function withTempJournal(): string {
  dir = mkdtempSync(join(tmpdir(), 'idea-journal-'));
  const file = join(dir, 'journal.json');
  setIdeaJournalFileForTests(file);
  return file;
}

afterEach(() => {
  setIdeaJournalFileForTests(null);
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function idea(over: Partial<OptionsIdeaView> = {}): OptionsIdeaView {
  return {
    id: 'live-aaa-long_call-1',
    rank: 1,
    ticker: 'AAA',
    underlyingPrice: 100,
    strategy: 'Long Call',
    thesis: 'cheap call',
    pop: 0.62,
    maxLossUsd: 300,
    maxProfitUsd: 600,
    netUsd: -300,
    breakevens: [103],
    ivRank: 40,
    dte: 30,
    events: [],
    legs: [{ action: 'buy', optionType: 'call', strike: 100, expiration: '2026-02-20' }],
    ...over,
  };
}

describe('isoWeek', () => {
  it('labels an ET date with its ISO week', () => {
    expect(isoWeek('2026-01-05')).toBe('2026-W02'); // Mon of W02
    expect(isoWeek('2026-06-06')).toBe('2026-W23');
  });
});

describe('recordSurfacedIdeas', () => {
  it('captures an idea with the engine strategy enum and full entry terms', async () => {
    withTempJournal();
    const strat = new Map<string, DefinedRiskStrategy>([['live-aaa-long_call-1', 'long_call']]);
    const added = await recordSurfacedIdeas([idea()], strat, Date.parse('2026-01-05T17:00:00Z'));
    expect(added).toBe(1);
    const entries = await listJournalEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ticker: 'AAA',
      strategy: 'long_call',
      entryNetUsd: -300,
      maxLossUsd: 300,
      expiration: '2026-02-20',
      surfacedDate: '2026-01-05',
    });
  });

  it('dedupes a re-surfaced idea on the same ET day (poll cannot inflate the sample)', async () => {
    withTempJournal();
    const strat = new Map<string, DefinedRiskStrategy>([['live-aaa-long_call-1', 'long_call']]);
    const t = Date.parse('2026-01-05T17:00:00Z');
    expect(await recordSurfacedIdeas([idea()], strat, t)).toBe(1);
    expect(await recordSurfacedIdeas([idea()], strat, t + 60_000)).toBe(0); // same day → no-op
    expect((await listJournalEntries())).toHaveLength(1);
  });

  it('skips ideas with no strategy mapping', async () => {
    withTempJournal();
    const added = await recordSurfacedIdeas([idea()], new Map(), Date.parse('2026-01-05T17:00:00Z'));
    expect(added).toBe(0);
  });

  it('keys distinct (date, ticker, strategy, expiration) tuples separately', () => {
    expect(journalKey('2026-01-05', 'aaa', 'long_call', '2026-02-20')).toBe(
      '2026-01-05:AAA:long_call:2026-02-20',
    );
    expect(journalKey('2026-01-05', 'AAA', 'bull_put_spread', '2026-02-20')).not.toBe(
      journalKey('2026-01-05', 'AAA', 'long_call', '2026-02-20'),
    );
  });
});
