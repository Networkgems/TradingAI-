import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { CoinbaseFeed } from './coinbase-feed.js';
import type { MarketBar, MarketQuote, MarketTrade } from '@trading-app/shared';

/**
 * Tiny fake `ws` implementation. We only model the subset CoinbaseFeed touches:
 * the `open`/`message`/`close`/`error` events, `send`, `close`, and the
 * static `OPEN` constant. Tests drive it by calling `pushOpen()` and
 * `pushMessage(json)` to simulate server-pushed frames.
 */
class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.CLOSED;
  sent: string[] = [];

  constructor(_url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1000, Buffer.from(''));
  }

  pushOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  pushMessage(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe('CoinbaseFeed', () => {
  it('subscribes to all market-data channels on connect (public mode)', async () => {
    FakeWebSocket.instances = [];
    const feed = new CoinbaseFeed({
      symbols: ['BTC-USD', 'ETH-USD'],
      websocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
    });

    let connected = false;
    feed.on('connected', () => { connected = true; });

    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();
    await flushMicrotasks();

    expect(connected).toBe(true);
    expect(feed.isAuthenticated()).toBe(false);

    const channels = ws.sent
      .map((s) => JSON.parse(s) as { type: string; channel: string; product_ids: string[]; jwt?: string })
      .filter((m) => m.type === 'subscribe');

    expect(channels.map((c) => c.channel).sort()).toEqual(
      ['candles', 'heartbeats', 'market_trades', 'ticker'].sort(),
    );
    expect(channels[0].product_ids).toEqual(['BTC-USD', 'ETH-USD']);
    expect(channels.every((c) => c.jwt === undefined)).toBe(true);

    feed.stop();
  });

  it('emits subscribed when the server acks subscriptions', async () => {
    FakeWebSocket.instances = [];
    const feed = new CoinbaseFeed({
      symbols: ['BTC-USD'],
      websocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
    });

    let subscribedTo: string[] | null = null;
    feed.on('subscribed', (s) => { subscribedTo = s; });

    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();
    ws.pushMessage({
      channel: 'subscriptions',
      events: [{ subscriptions: { ticker: ['BTC-USD'], market_trades: ['BTC-USD'], candles: ['BTC-USD'] } }],
    });

    expect(subscribedTo).toEqual(['BTC-USD']);
    expect(feed.getSubscribedSymbols()).toEqual(['BTC-USD']);

    feed.stop();
  });

  it('emits a quote from a ticker frame and dedupes identical updates', async () => {
    FakeWebSocket.instances = [];
    const feed = new CoinbaseFeed({
      symbols: ['BTC-USD'],
      websocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
    });

    const quotes: MarketQuote[] = [];
    feed.on('quote', (q) => quotes.push(q));

    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();

    const tickerFrame = {
      channel: 'ticker',
      events: [{
        type: 'update',
        tickers: [{
          type: 'ticker',
          product_id: 'BTC-USD',
          price: '60000.00',
          best_bid: '59999.50',
          best_bid_quantity: '0.5',
          best_ask: '60000.50',
          best_ask_quantity: '0.4',
          volume_24_h: '1234.56',
        }],
      }],
    };
    ws.pushMessage(tickerFrame);
    ws.pushMessage(tickerFrame); // identical → should be deduped

    expect(quotes.length).toBe(1);
    expect(quotes[0]).toMatchObject({
      symbol: 'BTC-USD',
      bidPrice: 59999.5,
      bidSize: 0.5,
      askPrice: 60000.5,
      askSize: 0.4,
    });

    // A new bid/ask gets through.
    ws.pushMessage({
      channel: 'ticker',
      events: [{
        type: 'update',
        tickers: [{
          type: 'ticker',
          product_id: 'BTC-USD',
          price: '60001.00',
          best_bid: '60000.50',
          best_bid_quantity: '0.6',
          best_ask: '60001.50',
          best_ask_quantity: '0.7',
        }],
      }],
    });
    expect(quotes.length).toBe(2);

    feed.stop();
  });

  it('emits a trade from a market_trades frame', async () => {
    FakeWebSocket.instances = [];
    const feed = new CoinbaseFeed({
      symbols: ['BTC-USD'],
      websocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
    });

    const trades: MarketTrade[] = [];
    feed.on('trade', (t) => trades.push(t));

    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();
    ws.pushMessage({
      channel: 'market_trades',
      events: [{
        type: 'update',
        trades: [{
          trade_id: '12345',
          product_id: 'BTC-USD',
          price: '60010.25',
          size: '0.001',
          side: 'BUY',
          time: '2024-04-30T12:00:00.000Z',
        }],
      }],
    });

    expect(trades.length).toBe(1);
    expect(trades[0]).toMatchObject({
      symbol: 'BTC-USD',
      price: 60010.25,
      size: 0.001,
      conditions: ['BUY'],
      exchange: 'COINBASE',
      timestamp: Date.parse('2024-04-30T12:00:00.000Z'),
    });

    feed.stop();
  });

  it('emits a bar from a candles frame and dedupes identical candles', async () => {
    FakeWebSocket.instances = [];
    const feed = new CoinbaseFeed({
      symbols: ['BTC-USD'],
      websocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
    });

    const bars: MarketBar[] = [];
    feed.on('bar', (b) => bars.push(b));

    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();

    const candleFrame = {
      channel: 'candles',
      events: [{
        type: 'update',
        candles: [{
          start: '1714478400', // 2024-04-30T12:00:00Z
          open: '60000',
          high: '60100',
          low: '59950',
          close: '60050',
          volume: '12.5',
          product_id: 'BTC-USD',
        }],
      }],
    };
    ws.pushMessage(candleFrame);
    ws.pushMessage(candleFrame); // identical → deduped

    expect(bars.length).toBe(1);
    expect(bars[0]).toMatchObject({
      symbol: 'BTC-USD',
      open: 60000,
      high: 60100,
      low: 59950,
      close: 60050,
      volume: 12.5,
      timeframe: '1Min',
      timestamp: 1714478400 * 1000,
    });

    // Same start time, updated close/volume → fresh emission.
    ws.pushMessage({
      channel: 'candles',
      events: [{
        type: 'update',
        candles: [{
          start: '1714478400',
          open: '60000',
          high: '60150',
          low: '59950',
          close: '60125',
          volume: '14.2',
          product_id: 'BTC-USD',
        }],
      }],
    });
    expect(bars.length).toBe(2);

    feed.stop();
  });

  it('routes server-side error frames to the error event', async () => {
    FakeWebSocket.instances = [];
    const feed = new CoinbaseFeed({
      symbols: ['BTC-USD'],
      websocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
    });

    const errors: Error[] = [];
    feed.on('error', (e) => errors.push(e));

    feed.start();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();
    ws.pushMessage({ type: 'error', message: 'invalid product' });

    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/invalid product/);

    feed.stop();
  });
});
