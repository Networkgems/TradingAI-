import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchStockTwitsStream,
  fetchStockTwitsUserStream,
  getCuratedStockTwitsAccounts,
  DEFAULT_CURATED_STOCKTWITS_ACCOUNTS,
  isStockTwitsBreakerOpen,
  resetStockTwitsBreaker,
} from './stocktwits-feed.js';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'application/json' },
  });
}

const STREAM_FIXTURE = {
  messages: [
    { id: 1, created_at: '2026-06-06T15:59:00Z', entities: { sentiment: { basic: 'Bullish' } } },
    { id: 2, created_at: '2026-06-06T15:58:00Z', entities: { sentiment: { basic: 'Bearish' } } },
    { id: 3, created_at: '2026-06-06T15:57:00Z', entities: { sentiment: null } },
    { id: 4, created_at: '2026-06-06T15:56:00Z' }, // no entities at all
    { created_at: '2026-06-06T15:55:00Z', entities: { sentiment: { basic: 'Bullish' } } }, // no id → dropped
  ],
};

describe('fetchStockTwitsStream', () => {
  beforeEach(() => resetStockTwitsBreaker());
  afterEach(() => { vi.unstubAllGlobals(); resetStockTwitsBreaker(); });

  it('normalizes the stream and maps the Bullish/Bearish tags', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(STREAM_FIXTURE)));
    const out = await fetchStockTwitsStream('aapl');
    expect(out).not.toBeNull();
    // The 5th raw message has no id → dropped; the other 4 survive.
    expect(out!).toHaveLength(4);
    expect(out![0]).toEqual({ id: 1, createdAt: '2026-06-06T15:59:00Z', sentiment: 'Bullish' });
    expect(out![1].sentiment).toBe('Bearish');
    expect(out![2].sentiment).toBeNull();
    expect(out![3].sentiment).toBeNull();
  });

  it('uppercases the symbol in the request URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    await fetchStockTwitsStream('nvda');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/symbol/NVDA.json'));
  });

  it('returns null and trips the breaker on a 429', async () => {
    const resetSec = Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000);
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({}, { status: 429, headers: { 'x-ratelimit-reset': String(resetSec) } })));
    const out = await fetchStockTwitsStream('AAPL');
    expect(out).toBeNull();
    expect(isStockTwitsBreakerOpen()).toBe(true);
  });

  it('skips the network call entirely while the breaker is open', async () => {
    const resetSec = Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000);
    const fetchMock = vi.fn(async () =>
      jsonResponse({}, { status: 429, headers: { 'x-ratelimit-reset': String(resetSec) } }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchStockTwitsStream('AAPL'); // trips breaker
    const callsAfterTrip = fetchMock.mock.calls.length;
    const out = await fetchStockTwitsStream('AAPL'); // should short-circuit
    expect(out).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsAfterTrip);
  });

  it('returns null (not throw) on a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })));
    expect(await fetchStockTwitsStream('AAPL')).toBeNull();
  });

  it('returns null (not throw) when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await fetchStockTwitsStream('AAPL')).toBeNull();
  });

  it('tolerates a body without a messages array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ symbol: { id: 1 } })));
    expect(await fetchStockTwitsStream('AAPL')).toEqual([]);
  });
});

const USER_STREAM_FIXTURE = {
  messages: [
    {
      id: 10,
      created_at: '2026-06-06T15:59:00Z',
      entities: { sentiment: { basic: 'Bullish' } },
      symbols: [{ symbol: 'AAPL' }, { symbol: 'tsla' }, { symbol: 'AAPL' }],
    },
    {
      id: 11,
      created_at: '2026-06-06T15:58:00Z',
      entities: { sentiment: null },
      symbols: [{ symbol: 'NVDA' }, { title: 'no symbol field' }, null],
    },
    {
      id: 12,
      created_at: '2026-06-06T15:57:00Z',
      // no symbols entity at all → empty list
    },
  ],
};

describe('fetchStockTwitsUserStream (TRA-603)', () => {
  beforeEach(() => resetStockTwitsBreaker());
  afterEach(() => { vi.unstubAllGlobals(); resetStockTwitsBreaker(); });

  it('normalizes curated messages, flags curated, and parses the symbols entity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(USER_STREAM_FIXTURE)));
    const out = await fetchStockTwitsUserStream('ivanhoff');
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(3);
    expect(out![0]).toEqual({
      id: 10,
      createdAt: '2026-06-06T15:59:00Z',
      sentiment: 'Bullish',
      curated: true,
      symbols: ['AAPL', 'TSLA'], // uppercased + deduped
    });
    expect(out![1].symbols).toEqual(['NVDA']); // drops the symbol-less / null entries
    expect(out![2].symbols).toEqual([]); // no symbols entity
    expect(out!.every(m => m.curated === true)).toBe(true);
  });

  it('hits the user endpoint and reuses the rate-limit breaker', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(USER_STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    await fetchStockTwitsUserStream('howardlindzon');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/user/howardlindzon.json'));
  });

  it('returns null and trips the shared breaker on a 429', async () => {
    const resetSec = Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000);
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({}, { status: 429, headers: { 'x-ratelimit-reset': String(resetSec) } })));
    expect(await fetchStockTwitsUserStream('Stocktwits')).toBeNull();
    expect(isStockTwitsBreakerOpen()).toBe(true);
    // breaker is shared with the symbol stream — the next symbol fetch short-circuits
    const fetchMock = vi.fn(async () => jsonResponse(STREAM_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchStockTwitsStream('AAPL')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null (not throw) when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await fetchStockTwitsUserStream('JFDI')).toBeNull();
  });
});

describe('getCuratedStockTwitsAccounts (TRA-603)', () => {
  it('defaults to the seeded curated list', () => {
    expect(getCuratedStockTwitsAccounts({})).toEqual([...DEFAULT_CURATED_STOCKTWITS_ACCOUNTS]);
  });

  it('parses a comma-separated env override, trimming blanks', () => {
    const env = { CURATED_STOCKTWITS_ACCOUNTS: ' alpha , beta ,, gamma ' } as NodeJS.ProcessEnv;
    expect(getCuratedStockTwitsAccounts(env)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('falls back to the default when the env is blank', () => {
    const env = { CURATED_STOCKTWITS_ACCOUNTS: '   ' } as NodeJS.ProcessEnv;
    expect(getCuratedStockTwitsAccounts(env)).toEqual([...DEFAULT_CURATED_STOCKTWITS_ACCOUNTS]);
  });
});
