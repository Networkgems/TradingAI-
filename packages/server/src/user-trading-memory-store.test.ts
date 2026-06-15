import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import {
  __resetUserMemoryStoreForTests,
  loadUserMemoryStore,
  getUserMemory,
  getUserMemorySync,
  setUserMemory,
  recordInteractionOutcome,
  getInteractionStats,
} from './user-trading-memory-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'user-mem-'));
  __resetUserMemoryStoreForTests(join(dir, 'user-trading-memory.json'));
});

afterEach(() => {
  __resetUserMemoryStoreForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('setUserMemory — explicit preferences', () => {
  it('stores + sanitizes a preference patch and round-trips from disk', async () => {
    await setUserMemory('alice', {
      riskTolerance: 'conservative',
      sizingMultiplier: 1.5, // clamped to 1
      watchlistRationale: { aapl: '  earnings momentum  ' },
      notes: 'swing only',
    });
    // Reset cache → forces a read from disk.
    __resetUserMemoryStoreForTests(join(dir, 'user-trading-memory.json'));
    const m = await getUserMemory('alice');
    expect(m.riskTolerance).toBe('conservative');
    expect(m.sizingMultiplier).toBe(1);
    expect(m.watchlistRationale).toEqual({ AAPL: 'earnings momentum' });
    expect(m.notes).toBe('swing only');
  });

  it('merges watchlist rationale by symbol and honours explicit clears', async () => {
    await setUserMemory('bob', { watchlistRationale: { AAPL: 'why a', MSFT: 'why m' } });
    await setUserMemory('bob', { watchlistRationale: { AAPL: '', NVDA: 'why n' } });
    const m = await getUserMemory('bob');
    expect(m.watchlistRationale).toEqual({ MSFT: 'why m', NVDA: 'why n' });
  });

  it('drops invalid risk tolerance values', async () => {
    await setUserMemory('carol', { riskTolerance: 'reckless' as never });
    expect((await getUserMemory('carol')).riskTolerance).toBeUndefined();
  });
});

describe('recordInteractionOutcome — learned preferences', () => {
  it('folds a repeatedly-approved strategy into preferredStrategies', async () => {
    await recordInteractionOutcome('dave', { strategyType: 'momentum', accepted: true });
    let m = await recordInteractionOutcome('dave', { strategyType: 'momentum', accepted: true });
    expect(m.preferredStrategies).toContain('momentum');
    expect(m.avoidedStrategies).toEqual([]);

    // Two rejects flip it back out / into avoided once rejects dominate.
    await recordInteractionOutcome('dave', { strategyType: 'momentum', accepted: false });
    await recordInteractionOutcome('dave', { strategyType: 'momentum', accepted: false });
    m = await recordInteractionOutcome('dave', { strategyType: 'momentum', accepted: false });
    expect(m.preferredStrategies).not.toContain('momentum');
    expect(m.avoidedStrategies).toContain('momentum');
  });

  it('a single interaction does not derive a preference (counts gate it)', async () => {
    const m = await recordInteractionOutcome('erin', { strategyType: 'orb', accepted: true });
    expect(m.preferredStrategies).toEqual([]);
    expect((await getInteractionStats('erin')).orb).toEqual({ approved: 1, rejected: 0 });
  });

  it('blank strategy type is a no-op derivation', async () => {
    const m = await recordInteractionOutcome('frank', { strategyType: '   ', accepted: true });
    expect(m.preferredStrategies ?? []).toEqual([]);
  });
});

describe('getUserMemorySync — hot-tick read', () => {
  it('returns {} before load and the cached memory after', async () => {
    await setUserMemory('grace', { riskTolerance: 'aggressive' });
    __resetUserMemoryStoreForTests(join(dir, 'user-trading-memory.json'));
    // Not loaded yet → empty.
    expect(getUserMemorySync('grace')).toEqual({});
    await loadUserMemoryStore();
    expect(getUserMemorySync('grace').riskTolerance).toBe('aggressive');
    // Unknown user → empty object, never throws.
    expect(getUserMemorySync('nobody')).toEqual({});
    expect(getUserMemorySync(undefined)).toEqual({});
  });
});
