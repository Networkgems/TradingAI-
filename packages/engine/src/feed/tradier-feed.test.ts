import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradierFeed } from './tradier-feed.js';
import type { MarketQuote, MarketTrade } from '@trading-app/shared';

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Wait until `cond` returns true, draining microtasks/macrotasks each tick. Bounded so tests fail fast. */
async function flushUntil(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('flushUntil: condition not met before timeout');
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TradierFeed', () => {
  it('emits connected + subscribed on start, then quote+trade from a poll', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        quotes: {
          quote: {
            symbol: 'AAPL', bid: 150, ask: 150.1, bidsize: 5, asksize: 7,
            last: 150.05, last_volume: 100, trade_date: 1714312800000, exch: 'Q',
          },
        },
      }),
    );

    const feed = new TradierFeed({ apiToken: 'tok', symbols: ['AAPL'], pollIntervalMs: 60_000 });
    const quotes: MarketQuote[] = [];
    const trades: MarketTrade[] = [];
    let connected = false;
    let subscribedTo: string[] | null = null;
    feed.on('connected', () => { connected = true; });
    feed.on('subscribed', (s) => { subscribedTo = s; });
    feed.on('quote', (q) => quotes.push(q));
    feed.on('trade', (t) => trades.push(t));

    feed.start();
    expect(connected).toBe(true);
    expect(subscribedTo).toEqual(['AAPL']);

    await flushUntil(() => quotes.length === 1 && trades.length === 1);

    expect(quotes[0]).toMatchObject({ symbol: 'AAPL', bidPrice: 150, askPrice: 150.1, bidSize: 5, askSize: 7 });
    expect(trades[0]).toMatchObject({ symbol: 'AAPL', price: 150.05, size: 100, exchange: 'Q' });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe('https://sandbox.tradier.com/v1/markets/quotes?symbols=AAPL');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');

    feed.stop();
  });

  it('does not re-emit identical quotes/trades', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        quotes: { quote: { symbol: 'AAPL', bid: 1, ask: 2, bidsize: 1, asksize: 1, last: 1.5, trade_date: 1000 } },
      }),
    );

    const feed = new TradierFeed({ apiToken: 'tok', symbols: ['AAPL'], pollIntervalMs: 5 });
    const quotes: MarketQuote[] = [];
    const trades: MarketTrade[] = [];
    feed.on('quote', (q) => quotes.push(q));
    feed.on('trade', (t) => trades.push(t));

    feed.start();
    await flushUntil(() => fetchMock.mock.calls.length >= 3);
    feed.stop();

    expect(quotes.length).toBe(1);
    expect(trades.length).toBe(1);
  });

  it('emits error on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    const feed = new TradierFeed({ apiToken: 'tok', symbols: ['AAPL'], pollIntervalMs: 60_000 });
    const errors: Error[] = [];
    feed.on('error', (e) => errors.push(e));

    feed.start();
    await flushUntil(() => errors.length === 1);
    expect(errors[0].message).toMatch(/500/);
    feed.stop();
  });

  it('hits production base URL when env=production', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ quotes: null }));
    const feed = new TradierFeed({ apiToken: 'tok', symbols: ['AAPL'], env: 'production', pollIntervalMs: 60_000 });
    feed.start();
    await flushUntil(() => fetchMock.mock.calls.length >= 1);
    expect(String(fetchMock.mock.calls[0][0]).startsWith('https://api.tradier.com/v1')).toBe(true);
    feed.stop();
  });
});
