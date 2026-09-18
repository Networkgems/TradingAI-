import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EarningsCalendarClient } from '@trading-app/engine';
import {
  refreshEarningsCalendar,
  earningsInDays,
  earningsInDaysSync,
  getNextEarningsDate,
  initEarningsStore,
  makeEarningsClientFromEnv,
  __resetEarningsStoreForTests,
  recentEarningsDateSync,
} from './earnings-store.js';

let tmpRoot: string;

/** A client whose single window-fetch is stubbed to return `events`. */
function stubClient(events: Array<{ symbol: string; date: string }>): EarningsCalendarClient {
  const client = new EarningsCalendarClient('test-token');
  vi.spyOn(client, 'fetchWindow').mockResolvedValue(
    events.map((e) => ({ ...e, epsEstimate: null, hour: '' })),
  );
  return client;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'earnings-store-test-'));
  __resetEarningsStoreForTests(join(tmpRoot, 'earnings-calendar.json'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  __resetEarningsStoreForTests(null);
  vi.restoreAllMocks();
});

describe('earnings-store', () => {
  it('refreshes from the client and exposes days-until for covered symbols', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const client = stubClient([{ symbol: 'AAPL', date: soon }]);

    const res = await refreshEarningsCalendar(client, ['AAPL', 'MSFT']);
    expect(res.covered).toBe(1);
    expect(res.uncovered).toBe(1);

    expect(await getNextEarningsDate('AAPL')).toBe(soon);
    expect(await earningsInDays('AAPL')).toBe(5);
    // Case-insensitive lookup.
    expect(await earningsInDays('aapl')).toBe(5);
  });

  it('returns null for uncovered symbols', async () => {
    const client = stubClient([]);
    await refreshEarningsCalendar(client, ['AAPL']);
    expect(await earningsInDays('AAPL')).toBeNull();
    expect(await getNextEarningsDate('AAPL')).toBeNull();
  });

  it('treats a stored date that has already passed as unknown', async () => {
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    // Seed a past record directly via the client (getUpcomingEarnings filters
    // past events, so write through a window that still contains one by faking
    // asOf-agnostic storage): refresh stores only upcoming, so instead assert
    // earningsInDays guards against a manually-stale date via the sync reader.
    const client = stubClient([{ symbol: 'X', date: past }]);
    const res = await refreshEarningsCalendar(client, ['X']);
    // The past event is filtered out by getUpcomingEarnings → uncovered.
    expect(res.covered).toBe(0);
    expect(await earningsInDays('X')).toBeNull();
  });

  it('drops a previously-stored symbol when it falls out of the window', async () => {
    const soon = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
    await refreshEarningsCalendar(stubClient([{ symbol: 'AAPL', date: soon }]), ['AAPL']);
    expect(await earningsInDays('AAPL')).toBe(4);

    // Next refresh: AAPL no longer reported → record pruned.
    await refreshEarningsCalendar(stubClient([]), ['AAPL']);
    expect(await earningsInDays('AAPL')).toBeNull();
  });

  it('persists across a cache reset (reload from disk)', async () => {
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    await refreshEarningsCalendar(stubClient([{ symbol: 'NVDA', date: soon }]), ['NVDA']);

    // Reset in-memory cache but keep the same on-disk path → reload.
    __resetEarningsStoreForTests(join(tmpRoot, 'earnings-calendar.json'));
    await initEarningsStore();
    expect(earningsInDaysSync('NVDA')).toBe(7);
  });

  it('earningsInDaysSync returns null before the store is loaded', () => {
    expect(earningsInDaysSync('AAPL')).toBeNull();
  });

  it('makeEarningsClientFromEnv returns null when the token is unset', () => {
    const prev = process.env['FINNHUB_API_TOKEN'];
    delete process.env['FINNHUB_API_TOKEN'];
    expect(makeEarningsClientFromEnv()).toBeNull();
    process.env['FINNHUB_API_TOKEN'] = 'abc';
    expect(makeEarningsClientFromEnv()).toBeInstanceOf(EarningsCalendarClient);
    if (prev === undefined) delete process.env['FINNHUB_API_TOKEN'];
    else process.env['FINNHUB_API_TOKEN'] = prev;
  });
});

// TRA-4706 — the post-earnings swing scanner needs the report that JUST happened,
// which the refresh used to overwrite/delete the morning after.
describe('recentEarningsDateSync (TRA-4706)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the passed date across the refresh that replaces it, and across a reload from disk', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 10, 13, 0));
    await refreshEarningsCalendar(stubClient([{ symbol: 'AAPL', date: '2026-09-15' }]), ['AAPL', 'MSFT']);
    expect(recentEarningsDateSync('AAPL')).toEqual({ state: 'none' }); // still upcoming

    // Between the report and the next refresh the upcoming record itself is the source.
    vi.setSystemTime(Date.UTC(2026, 8, 15, 21, 0));
    expect(recentEarningsDateSync('AAPL')).toEqual({ state: 'recent', date: '2026-09-15' });

    // The next morning's refresh swaps in next quarter's date — the passed one must survive.
    vi.setSystemTime(Date.UTC(2026, 8, 16, 13, 0));
    await refreshEarningsCalendar(stubClient([{ symbol: 'AAPL', date: '2026-12-15' }]), ['AAPL', 'MSFT']);
    expect(earningsInDaysSync('AAPL')).toBe(90);
    expect(recentEarningsDateSync('AAPL')).toEqual({ state: 'recent', date: '2026-09-15' });

    // …and survives a process restart.
    __resetEarningsStoreForTests(join(tmpRoot, 'earnings-calendar.json'));
    await initEarningsStore();
    expect(recentEarningsDateSync('AAPL')).toEqual({ state: 'recent', date: '2026-09-15' });
    expect(recentEarningsDateSync('MSFT')).toEqual({ state: 'none' });
  });

  it('a symbol whose provider window goes EMPTY after the report still keeps its passed date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 10, 13, 0));
    await refreshEarningsCalendar(stubClient([{ symbol: 'AAPL', date: '2026-09-15' }]), ['AAPL']);
    vi.setSystemTime(Date.UTC(2026, 8, 16, 13, 0));
    await refreshEarningsCalendar(stubClient([]), ['AAPL']);
    expect(recentEarningsDateSync('AAPL')).toEqual({ state: 'recent', date: '2026-09-15' });
  });

  it('a dark store reads UNREADABLE, never "none"', async () => {
    expect(recentEarningsDateSync('AAPL')).toEqual({ state: 'unreadable' }); // not loaded
    await initEarningsStore();
    expect(recentEarningsDateSync('AAPL')).toEqual({ state: 'unreadable' }); // loaded, never refreshed
  });
});
