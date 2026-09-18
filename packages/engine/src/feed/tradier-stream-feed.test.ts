import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { TradierStreamFeed, quoteFreshness, type StreamConnectionState, type StreamQuote } from './tradier-stream-feed.js';

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.CLOSED;
  sent: string[] = [];
  pings = 0;
  terminated = false;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void { this.sent.push(data); }
  ping(): void { this.pings++; }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1000, Buffer.from(''));
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1006, Buffer.from(''));
  }
  pushOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }
  pushText(text: string): void { this.emit('message', Buffer.from(text)); }
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1006, Buffer.from('abnormal'));
  }
}

let clock = 0;
let sessionCalls = 0;

function okSession(): typeof fetch {
  return (async () => {
    sessionCalls++;
    return new Response(
      JSON.stringify({ stream: { url: 'wss://ws.test/v1/markets/events', sessionid: `sid-${sessionCalls}` } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function makeFeed(extra: Partial<ConstructorParameters<typeof TradierStreamFeed>[0]> = {}) {
  const feed = new TradierStreamFeed({
    apiToken: 't',
    symbols: ['SPY', 'QQQ'],
    websocketImpl: FakeWebSocket as unknown as typeof import('ws').default,
    fetchImpl: okSession(),
    now: () => clock,
    ...extra,
  });
  feed.on('error', () => {});
  return feed;
}

/** Let the session fetch resolve and the WS be constructed. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  sessionCalls = 0;
  clock = 1_700_000_000_000;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TradierStreamFeed', () => {
  it('mints a session, opens the returned WS url, and subscribes with that sessionid', async () => {
    const feed = makeFeed();
    const states: StreamConnectionState[] = [];
    feed.on('state', (s) => states.push(s));
    feed.start();
    await settle();

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('wss://ws.test/v1/markets/events');
    ws.pushOpen();

    const sub = JSON.parse(ws.sent[0]) as { symbols: string[]; sessionid: string; filter: string[] };
    expect(sub).toMatchObject({ symbols: ['SPY', 'QQQ'], sessionid: 'sid-1', filter: ['quote', 'trade'] });
    expect(states).toEqual(['connecting', 'connected']);
    expect(feed.getState()).toBe('connected');
    feed.stop();
    expect(feed.getState()).toBe('disconnected');
  });

  it('stamps every quote with exchange event time, receive time and latency', async () => {
    const feed = makeFeed();
    const quotes: StreamQuote[] = [];
    feed.on('quote', (q) => quotes.push(q));
    feed.start();
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();

    const exch = clock - 120;
    // Two frames in one message (linebreak-delimited), string-typed numerics as Tradier sends them.
    ws.pushText(
      `{"type":"quote","symbol":"SPY","bid":500.1,"bidsz":3,"biddate":"${exch - 50}","ask":500.12,"asksz":4,"askdate":"${exch}"}\n` +
        `{"type":"quote","symbol":"QQQ","bid":"400","ask":"400.02"}\n`,
    );

    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toMatchObject({
      symbol: 'SPY', bidPrice: 500.1, askPrice: 500.12, bidSize: 3, askSize: 4,
      eventTime: exch, timestamp: exch, receivedAt: clock, latencyMs: 120,
    });
    // No exchange stamp ⇒ event time is the receive time, never a missing/zero value.
    expect(quotes[1].eventTime).toBe(clock);
    expect(quotes.every((q) => Number.isFinite(q.eventTime) && q.eventTime > 0)).toBe(true);
    feed.stop();
  });

  it('counts quotes over the 500ms latency budget', async () => {
    const feed = makeFeed();
    feed.start();
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();
    ws.pushText(`{"type":"quote","symbol":"SPY","bid":1,"ask":2,"askdate":"${clock - 100}"}`);
    ws.pushText(`{"type":"quote","symbol":"SPY","bid":1,"ask":2,"askdate":"${clock - 900}"}`);
    const s = feed.getStatus();
    expect(s.quotesReceived).toBe(2);
    expect(s.quotesOverLatencyBudget).toBe(1);
    expect(s.maxLatencyMs).toBe(900);
    feed.stop();
  });

  it('flags a quote stale once it is more than 2s old', async () => {
    const feed = makeFeed();
    feed.start();
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();
    ws.pushText(`{"type":"quote","symbol":"SPY","bid":1,"ask":2,"askdate":"${clock}"}`);

    clock += 2000;
    expect(feed.getStatus().symbols[0]).toMatchObject({ symbol: 'SPY', ageMs: 2000, stale: false });
    clock += 1;
    expect(feed.getStatus().symbols[0]).toMatchObject({ ageMs: 2001, stale: true });
    feed.stop();
  });

  it('auto-reconnects within 5s of a drop, with a fresh session, and never exceeds the 5s ceiling', async () => {
    const feed = makeFeed();
    const states: StreamConnectionState[] = [];
    feed.on('state', (s) => states.push(s));
    feed.start();
    await settle();
    FakeWebSocket.instances[0].pushOpen();

    // Drop repeatedly without ever re-opening, so the backoff climbs to its ceiling.
    for (let i = 0; i < 8; i++) {
      const current = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      current.drop();
      expect(feed.getState()).toBe('reconnecting');
      const before = FakeWebSocket.instances.length;
      await vi.advanceTimersByTimeAsync(4999);
      expect(FakeWebSocket.instances.length).toBe(before + 1);
    }
    expect(sessionCalls).toBe(9);
    expect(feed.getStatus().reconnects).toBe(8);

    // A successful open resets the backoff and state.
    FakeWebSocket.instances[FakeWebSocket.instances.length - 1].pushOpen();
    expect(feed.getState()).toBe('connected');
    const sent = FakeWebSocket.instances[FakeWebSocket.instances.length - 1].sent[0];
    expect(JSON.parse(sent).sessionid).toBe('sid-9');
    expect(states[0]).toBe('connecting');
    expect(states).toContain('reconnecting');
    feed.stop();
  });

  it('retries when the session call itself fails', async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) return new Response('nope', { status: 503 });
      return new Response(JSON.stringify({ stream: { url: 'wss://x', sessionid: 's' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const feed = makeFeed({ fetchImpl: flaky });
    feed.start();
    await settle();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(feed.getState()).toBe('reconnecting');
    expect(feed.getStatus().lastError).toMatch(/503/);
    await vi.advanceTimersByTimeAsync(600);
    expect(FakeWebSocket.instances).toHaveLength(1);
    feed.stop();
  });

  it('pings while healthy and tears down a silent connection', async () => {
    const feed = makeFeed({ heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 3000 });
    feed.start();
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();

    clock += 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.pings).toBe(1);
    ws.emit('pong');

    // Pong kept it alive; now go silent past the timeout.
    for (let i = 0; i < 4; i++) {
      clock += 1000;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(ws.terminated).toBe(true);
    expect(feed.getState()).toBe('reconnecting');
    feed.stop();
  });

  it('stop() cancels a pending reconnect and ignores late frames from the old socket', async () => {
    const feed = makeFeed();
    const quotes: StreamQuote[] = [];
    feed.on('quote', (q) => quotes.push(q));
    feed.start();
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();
    ws.drop();
    feed.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    ws.pushText(`{"type":"quote","symbol":"SPY","bid":1,"ask":2}`);
    expect(quotes).toHaveLength(0);
    expect(feed.getState()).toBe('disconnected');
  });

  it('emits trades with the exchange trade date', async () => {
    const feed = makeFeed();
    const trades: Array<{ price: number; timestamp: number; size: number }> = [];
    feed.on('trade', (t) => trades.push(t));
    feed.start();
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();
    ws.pushText(`{"type":"trade","symbol":"SPY","exch":"Q","price":"500.11","size":"100","date":"${clock - 30}"}`);
    expect(trades[0]).toMatchObject({ price: 500.11, size: 100, timestamp: clock - 30 });
    feed.stop();
  });
});

describe('quoteFreshness', () => {
  it('uses a strict >2s boundary', () => {
    const q = { symbol: 'X', eventTime: 1000, receivedAt: 1100, latencyMs: 100 };
    expect(quoteFreshness(q, 3000).stale).toBe(false);
    expect(quoteFreshness(q, 3001).stale).toBe(true);
  });
});
