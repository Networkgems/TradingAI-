import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseFinnhubEarnings,
  daysUntil,
  nextEarningsDate,
  EarningsCalendarClient,
  type EarningsEvent,
} from './earnings-client.js';

// A fixed anchor so the days-until math is deterministic: 2026-06-06T12:00Z.
const ASOF = Date.parse('2026-06-06T12:00:00Z');

describe('daysUntil', () => {
  it('returns 0 for an event dated today (any time-of-day in asOf)', () => {
    expect(daysUntil('2026-06-06', ASOF)).toBe(0);
  });

  it('counts whole calendar days forward at UTC-midnight granularity', () => {
    expect(daysUntil('2026-06-07', ASOF)).toBe(1);
    expect(daysUntil('2026-06-16', ASOF)).toBe(10);
  });

  it('returns a negative count for a past event', () => {
    expect(daysUntil('2026-06-01', ASOF)).toBe(-5);
  });

  it('returns null for an unparseable / wrong-format date', () => {
    expect(daysUntil('not-a-date', ASOF)).toBeNull();
    expect(daysUntil('2026-13-40', ASOF)).toBeNull();
    expect(daysUntil('2026/06/07', ASOF)).toBeNull();
  });
});

describe('nextEarningsDate', () => {
  const events: EarningsEvent[] = [
    { symbol: 'AAPL', date: '2026-06-01' }, // past
    { symbol: 'AAPL', date: '2026-06-20' }, // future
    { symbol: 'AAPL', date: '2026-09-15' }, // further future
  ];

  it('picks the soonest not-yet-past event', () => {
    expect(nextEarningsDate(events, ASOF)).toBe('2026-06-20');
  });

  it('counts an event dated today as upcoming', () => {
    expect(nextEarningsDate([{ symbol: 'X', date: '2026-06-06' }], ASOF)).toBe('2026-06-06');
  });

  it('returns null when every event is in the past', () => {
    expect(nextEarningsDate([{ symbol: 'X', date: '2026-01-01' }], ASOF)).toBeNull();
    expect(nextEarningsDate([], ASOF)).toBeNull();
  });
});

describe('parseFinnhubEarnings', () => {
  it('normalises rows, upper-cases symbols, and keeps eps/hour', () => {
    const parsed = parseFinnhubEarnings({
      earningsCalendar: [
        { symbol: 'aapl', date: '2026-06-20', epsEstimate: 1.42, hour: 'amc' },
        { symbol: 'MSFT', date: '2026-07-22', epsEstimate: null, hour: 'bmo' },
      ],
    });
    expect(parsed).toEqual([
      { symbol: 'AAPL', date: '2026-06-20', epsEstimate: 1.42, hour: 'amc' },
      { symbol: 'MSFT', date: '2026-07-22', epsEstimate: null, hour: 'bmo' },
    ]);
  });

  it('drops rows missing a symbol or a YYYY-MM-DD date', () => {
    const parsed = parseFinnhubEarnings({
      earningsCalendar: [
        { symbol: '', date: '2026-06-20' },
        { symbol: 'AAPL', date: '06/20/2026' },
        { date: '2026-06-20' },
        { symbol: 'NVDA', date: '2026-08-27' },
      ],
    });
    expect(parsed).toEqual([{ symbol: 'NVDA', date: '2026-08-27', epsEstimate: null, hour: '' }]);
  });

  it('returns [] for a non-object / empty / malformed payload', () => {
    expect(parseFinnhubEarnings(null)).toEqual([]);
    expect(parseFinnhubEarnings({})).toEqual([]);
    expect(parseFinnhubEarnings({ earningsCalendar: null })).toEqual([]);
    expect(parseFinnhubEarnings('nope')).toEqual([]);
  });
});

describe('EarningsCalendarClient.getUpcomingEarnings', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches one window and maps each requested symbol to its soonest event', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        earningsCalendar: [
          { symbol: 'AAPL', date: '2026-06-01' }, // past — ignored
          { symbol: 'AAPL', date: '2026-06-20' }, // soonest upcoming
          { symbol: 'AAPL', date: '2026-09-15' },
          { symbol: 'MSFT', date: '2026-07-22' },
          { symbol: 'TSLA', date: '2026-07-19' }, // not in the requested universe
        ],
      }),
    );
    const client = new EarningsCalendarClient('test-token');
    const map = await client.getUpcomingEarnings(['AAPL', 'MSFT', 'NFLX'], { asOf: ASOF });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/calendar/earnings');
    expect(url).toContain('token=test-token');
    expect(url).toContain('from=2026-06-06');

    expect(map.get('AAPL')).toBe('2026-06-20');
    expect(map.get('MSFT')).toBe('2026-07-22');
    expect(map.has('NFLX')).toBe(false); // no event in the window
    expect(map.has('TSLA')).toBe(false); // not requested
  });

  it('returns an empty map without calling the API for an empty universe', async () => {
    const client = new EarningsCalendarClient('test-token');
    const map = await client.getUpcomingEarnings([], { asOf: ASOF });
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response so the caller can fall through', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429));
    const client = new EarningsCalendarClient('test-token');
    await expect(client.getUpcomingEarnings(['AAPL'], { asOf: ASOF })).rejects.toThrow(/HTTP 429/);
  });
});
