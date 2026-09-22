// TRA-4707 — the stream status route, graded over real HTTP. The flag-on arm
// drives the REAL `TradierStreamFeed` (engine) against a fake WebSocket + fake
// session fetch, so the payload asserted here is the one the shipped feed
// actually produces — not a hand-built status object.

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { TradierStreamFeed, type TradierStreamFeedOptions } from '@trading-app/engine';
import {
  createTradierStreamService,
  normalizeStreamSymbols,
  registerTradierStreamRoutes,
  isTradierStreamEnabled,
  resolveStreamSymbolLimit,
  applyStreamSymbolLimit,
  type TradierStreamPayload,
  type TradierStreamService,
} from './tradier-stream-status.js';

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void { this.sent.push(data); }
  ping(): void {}
  close(): void { this.emit('close', 1000, Buffer.from('')); }
  terminate(): void { this.emit('close', 1006, Buffer.from('')); }
  pushOpen(): void { this.emit('open'); }
  pushText(text: string): void { this.emit('message', Buffer.from(text)); }
  drop(): void { this.emit('close', 1006, Buffer.from('abnormal')); }
}

const passAuth: express.RequestHandler = (_req, _res, next) => next();

let server: Server | null = null;
let service: TradierStreamService | null = null;

afterEach(async () => {
  service?.stop();
  service = null;
  FakeWebSocket.instances = [];
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function serve(svc: TradierStreamService): Promise<string> {
  service = svc;
  const app = express();
  registerTradierStreamRoutes(app, { requireAuth: passAuth, service: svc });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function read(base: string): Promise<TradierStreamPayload> {
  const r = await fetch(`${base}/api/market-data/stream`);
  expect(r.status).toBe(200);
  return (await r.json()) as TradierStreamPayload;
}

/** Let the session fetch resolve and the WS get constructed. */
const settle = () => new Promise<void>((r) => setTimeout(r, 5));

const BOOK_SYMBOLS = ['SPY', 'qqq', 'SPY', 'AAPL', 'BTC/USD', ''];

describe('TRA-4707 stream status route — flag OFF', () => {
  for (const flag of [undefined, '', '0', 'false', 'off']) {
    it(`ENABLE_TRADIER_STREAM=${JSON.stringify(flag)} reads DISABLED and builds no feed`, async () => {
      let built = 0;
      const env: NodeJS.ProcessEnv = { TRADIER_API_TOKEN: 'prod-token' };
      if (flag !== undefined) env['ENABLE_TRADIER_STREAM'] = flag;
      const svc = createTradierStreamService({
        env,
        resolveSymbols: () => BOOK_SYMBOLS,
        createFeed: () => { built++; throw new Error('must not build a feed with the flag off'); },
      });
      svc.start();
      const body = await read(await serve(svc));
      expect(built).toBe(0);
      expect(body).toMatchObject({ enabled: false, state: 'disabled', reason: 'flag_off', flagOn: false });
      // Not an empty-but-healthy payload: no connection state, no symbol list at all.
      expect(body).not.toHaveProperty('symbols');
      expect(body).not.toHaveProperty('quotesReceived');
    });
  }

  it('flag ON but no PRODUCTION token reads disabled/token_missing — a sandbox token does not count', async () => {
    const svc = createTradierStreamService({
      env: { ENABLE_TRADIER_STREAM: 'true', TRADIER_SANDBOX_API_TOKEN: 'sbx' },
      resolveSymbols: () => BOOK_SYMBOLS,
      createFeed: () => { throw new Error('must not build'); },
    });
    svc.start();
    expect(await read(await serve(svc))).toMatchObject({
      enabled: false, state: 'disabled', reason: 'token_missing', flagOn: true,
    });
  });

  it('flag ON but the books watch no equity symbols reads disabled/no_symbols', async () => {
    const svc = createTradierStreamService({
      env: { ENABLE_TRADIER_STREAM: '1', TRADIER_API_TOKEN: 'prod-token' },
      resolveSymbols: () => ['BTC/USD', ''],
      createFeed: () => { throw new Error('must not build'); },
    });
    svc.start();
    expect(await read(await serve(svc))).toMatchObject({ state: 'disabled', reason: 'no_symbols' });
  });

  it('exposes no write verb', async () => {
    const svc = createTradierStreamService({ env: {}, resolveSymbols: () => [] });
    const base = await serve(svc);
    const r = await fetch(`${base}/api/market-data/stream`, { method: 'POST' });
    expect(r.status).toBe(404);
  });
});

describe('TRA-4707 stream status route — flag ON (real TradierStreamFeed, fake socket)', () => {
  function build(clock: { t: number }) {
    const seen: TradierStreamFeedOptions[] = [];
    const svc = createTradierStreamService({
      env: { ENABLE_TRADIER_STREAM: 'on', TRADIER_API_TOKEN: 'prod-token', TRADIER_SANDBOX_API_TOKEN: 'sbx' },
      resolveSymbols: () => BOOK_SYMBOLS,
      now: () => clock.t,
      createFeed: (opts) => {
        seen.push(opts);
        return new TradierStreamFeed({
          ...opts,
          websocketImpl: FakeWebSocket as unknown as NonNullable<TradierStreamFeedOptions['websocketImpl']>,
          fetchImpl: (async () =>
            new Response(JSON.stringify({ stream: { url: 'wss://ws.test/v1/markets/events', sessionid: 'sid-1' } }), {
              status: 200,
            })) as unknown as typeof fetch,
          now: () => clock.t,
          initialReconnectDelayMs: 60_000,
        });
      },
    });
    return { svc, seen };
  }

  it('subscribes the normalised book symbols with the production token', async () => {
    const clock = { t: 1_700_000_000_000 };
    const { svc, seen } = build(clock);
    svc.start();
    expect(seen).toHaveLength(1);
    expect(seen[0].apiToken).toBe('prod-token');
    expect(seen[0].env).toBe('production');
    expect(seen[0].symbols).toEqual(['AAPL', 'QQQ', 'SPY']);
    expect(normalizeStreamSymbols(BOOK_SYMBOLS)).toEqual(['AAPL', 'QQQ', 'SPY']);
  });

  it('before any quote: every subscribed symbol has a row, reading never-quoted and STALE', async () => {
    const clock = { t: 1_700_000_000_000 };
    const { svc } = build(clock);
    svc.start();
    const base = await serve(svc);
    await settle();
    const body = await read(base);
    expect(body.enabled).toBe(true);
    if (!body.enabled) return;
    expect(body.state).toBe('connecting');
    expect(body.subscribedSymbols).toBe(3);
    expect(body.quotedSymbols).toBe(0);
    expect(body.staleSymbols).toBe(3);
    expect(body.symbols.map((s) => [s.symbol, s.neverQuoted, s.stale, s.ageMs])).toEqual([
      ['AAPL', true, true, null],
      ['QQQ', true, true, null],
      ['SPY', true, true, null],
    ]);
  });

  it('connected: per-symbol ageMs with the strict >2000ms stale boundary, counters, then reconnecting on a drop', async () => {
    const clock = { t: 1_700_000_000_000 };
    const { svc } = build(clock);
    svc.start();
    const base = await serve(svc);
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();
    const T = clock.t;
    // SPY event at T (receive at T → latency 0); QQQ event at T-1 received at T (latency 1).
    ws.pushText(
      JSON.stringify({ type: 'quote', symbol: 'SPY', bid: 500, ask: 500.02, biddate: String(T), askdate: String(T) }) +
        '\n' +
        JSON.stringify({ type: 'quote', symbol: 'QQQ', bid: 400, ask: 400.01, biddate: String(T - 1), askdate: String(T - 1) }),
    );
    clock.t = T + 2000; // SPY age exactly 2000 → fresh; QQQ age 2001 → stale.

    const body = await read(base);
    expect(body.enabled).toBe(true);
    if (!body.enabled) return;
    expect(body.state).toBe('connected');
    expect(body.quotesReceived).toBe(2);
    expect(body.quotesLatencyGraded).toBe(2);
    expect(body.quotesOverLatencyBudget).toBe(0);
    expect(body.maxLatencyMs).toBe(1);
    expect(body.latencyP50Ms).toBe(0);
    expect(body.latencyP95Ms).toBe(1);
    expect(body.reconnects).toBe(0);
    expect(body.lastError).toBeNull();
    const rows = Object.fromEntries(body.symbols.map((s) => [s.symbol, s]));
    expect(rows['SPY']).toMatchObject({ ageMs: 2000, stale: false, neverQuoted: false, latencyMs: 0 });
    expect(rows['QQQ']).toMatchObject({ ageMs: 2001, stale: true, neverQuoted: false, latencyMs: 1 });
    expect(rows['AAPL']).toMatchObject({ ageMs: null, stale: true, neverQuoted: true });
    expect(body.quotedSymbols).toBe(2);
    expect(body.staleSymbols).toBe(2);

    ws.drop();
    const after = await read(base);
    expect(after.state).toBe('reconnecting');
  });

  it('stop() leaves the feed disconnected', async () => {
    const clock = { t: 1_700_000_000_000 };
    const { svc } = build(clock);
    svc.start();
    const base = await serve(svc);
    await settle();
    FakeWebSocket.instances[0].pushOpen();
    svc.stop();
    expect((await read(base)).state).toBe('disconnected');
  });
});

// TRA-4782 — the experiment's lever, and the instrument it is graded with.
describe('TRA-4782 TRADIER_STREAM_SYMBOL_LIMIT', () => {
  const FLEET = normalizeStreamSymbols([
    'ZZZZ', 'AAPL', 'FLYYQ', 'SPY', 'NVDA', 'QQQ', 'TSLA', 'MSFT', 'ANY', 'ATAI',
  ]);

  it('unset is the identity — the subscribe frame is byte-identical to the uncapped one', () => {
    expect(resolveStreamSymbolLimit({})).toEqual({ limit: null, raw: null, error: null });
    expect(resolveStreamSymbolLimit({ TRADIER_STREAM_SYMBOL_LIMIT: '  ' }).limit).toBeNull();
    const sel = applyStreamSymbolLimit(FLEET, null);
    expect(sel.selected).toEqual([...FLEET]);
    expect(sel.before).toBe(FLEET.length);
    expect(sel.ranked + sel.unranked).toBe(sel.selected.length);
  });

  it('a cap selects ladder-first, in ladder order, and back-fills only once the ladder runs out', () => {
    const five = applyStreamSymbolLimit(FLEET, 5);
    // SPY/QQQ/NVDA/TSLA/AAPL are ladder ranks 0-4 — the exact mega-caps whose 35.6s
    // p50 the ticket measured, so the N-capped arm contains the rows under test.
    expect(five.selected).toEqual(['SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL']);
    expect(five).toMatchObject({ before: FLEET.length, ranked: 5, unranked: 0 });

    // 6 ladder members present; ask for 8 ⇒ 2 come off the tail, and it SAYS so.
    const eight = applyStreamSymbolLimit(FLEET, 8);
    expect(eight.selected.slice(0, 6)).toEqual(['SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL', 'MSFT']);
    expect(eight).toMatchObject({ ranked: 6, unranked: 2 });
    expect(eight.selected).toHaveLength(8);

    // A cap at or above the fleet size never reorders anything.
    expect(applyStreamSymbolLimit(FLEET, FLEET.length).selected).toEqual([...FLEET]);
    expect(applyStreamSymbolLimit(FLEET, 999).selected).toEqual([...FLEET]);
  });

  it('a garbage cap does NOT read like an unset one — both leave limit null, only the error tells them apart', () => {
    for (const bad of ['0', '-3', 'twenty-five', '25.5', 'NaN']) {
      const r = resolveStreamSymbolLimit({ TRADIER_STREAM_SYMBOL_LIMIT: bad });
      expect(r.limit).toBeNull();
      expect(r.raw).toBe(bad);
      expect(r.error).toContain(bad);
    }
    expect(resolveStreamSymbolLimit({ TRADIER_STREAM_SYMBOL_LIMIT: '25' })).toEqual({ limit: 25, raw: '25', error: null });
  });

  it('the disabled payload still echoes the cap, so a landed env write is verifiable before arming', async () => {
    const svc = createTradierStreamService({
      env: { TRADIER_STREAM_SYMBOL_LIMIT: '25' },
      resolveSymbols: () => FLEET,
      createFeed: () => { throw new Error('must not build a feed with the flag off'); },
    });
    const body = await read(await serve(svc));
    expect(body.enabled).toBe(false);
    expect(body).toMatchObject({ state: 'disabled', reason: 'flag_off', symbolLimit: 25, symbolLimitRaw: '25', symbolLimitError: null });
  });

  it('end to end: the capped frame is what goes on the wire, and the payload names both sides of the cap', async () => {
    const clock = { t: 1_700_000_000_000 };
    const seen: TradierStreamFeedOptions[] = [];
    const svc = createTradierStreamService({
      env: { ENABLE_TRADIER_STREAM: 'on', TRADIER_API_TOKEN: 'prod-token', TRADIER_STREAM_SYMBOL_LIMIT: '3' },
      resolveSymbols: () => FLEET,
      now: () => clock.t,
      createFeed: (opts) => {
        seen.push(opts);
        return new TradierStreamFeed({
          ...opts,
          websocketImpl: FakeWebSocket as unknown as NonNullable<TradierStreamFeedOptions['websocketImpl']>,
          fetchImpl: (async () =>
            new Response(JSON.stringify({ stream: { url: 'wss://ws.test/v1/markets/events', sessionid: 'sid-1' } }), { status: 200 })) as unknown as typeof fetch,
          now: () => clock.t,
          initialReconnectDelayMs: 60_000,
        });
      },
    });
    svc.start();
    const base = await serve(svc);
    await settle();

    expect(seen[0].symbols).toEqual(['SPY', 'QQQ', 'NVDA']);
    FakeWebSocket.instances[0].pushOpen(); // the subscribe frame is sent on open
    const sub = JSON.parse(FakeWebSocket.instances[0].sent[0] ?? '{}') as { symbols?: string[] };
    // The cap is only real if it reaches the SUBSCRIBE FRAME. A payload-only cap
    // would leave the 822-symbol fan-out intact and the experiment would measure nothing.
    expect(sub.symbols).toEqual(['SPY', 'QQQ', 'NVDA']);

    const body = await read(base);
    expect(body.enabled).toBe(true);
    if (!body.enabled) return;
    expect(body).toMatchObject({
      subscribedSymbols: 3,
      symbolsBeforeLimit: FLEET.length,
      symbolLimit: 3,
      symbolLimitRaw: '3',
      symbolLimitError: null,
      symbolsFromLadder: 3,
      symbolsOffLadder: 0,
    });
    expect(body.symbols.map((s) => s.symbol)).toEqual(['SPY', 'QQQ', 'NVDA']);
  });

  it('a halted book is segregated on the route too — per-row truth kept, latency verdict clean', async () => {
    const clock = { t: 1_700_000_000_000 };
    const svc = createTradierStreamService({
      env: { ENABLE_TRADIER_STREAM: 'on', TRADIER_API_TOKEN: 'prod-token' },
      resolveSymbols: () => ['SPY', 'FLYYQ'],
      now: () => clock.t,
      createFeed: (opts) =>
        new TradierStreamFeed({
          ...opts,
          websocketImpl: FakeWebSocket as unknown as NonNullable<TradierStreamFeedOptions['websocketImpl']>,
          fetchImpl: (async () =>
            new Response(JSON.stringify({ stream: { url: 'wss://ws.test/v1/markets/events', sessionid: 'sid-1' } }), { status: 200 })) as unknown as typeof fetch,
          now: () => clock.t,
          initialReconnectDelayMs: 60_000,
        }),
    });
    svc.start();
    const base = await serve(svc);
    await settle();
    const ws = FakeWebSocket.instances[0];
    ws.pushOpen();
    const T = clock.t;
    ws.pushText(
      JSON.stringify({ type: 'quote', symbol: 'SPY', bid: 500, ask: 500.02, askdate: String(T - 40_000) }) + '\n' +
        JSON.stringify({ type: 'quote', symbol: 'FLYYQ', bid: 1, ask: 2, askdate: String(T - 125 * 86_400_000) }),
    );

    const body = await read(base);
    expect(body.enabled).toBe(true);
    if (!body.enabled) return;
    expect(body).toMatchObject({
      quotesReceived: 2,
      quotesLatencyGraded: 1,
      quotesWithStaleEventTime: 1,
      quotesWithFutureEventTime: 0,
      quotesOverLatencyBudget: 1,
      // The real backlog, un-poisoned by the halted book. Pre-fix this read 10800000000.
      maxLatencyMs: 40_000,
      latencyP50Ms: 40_000,
      latencySanityBoundMs: 600_000,
    });
    const rows = Object.fromEntries(body.symbols.map((s) => [s.symbol, s]));
    expect(rows['SPY']).toMatchObject({ latencyMs: 40_000, staleEventTime: false });
    // The excluded row keeps its true latency AND is labelled — segregated, not clamped.
    expect(rows['FLYYQ']).toMatchObject({ latencyMs: 125 * 86_400_000, staleEventTime: true });
  });
});

describe('isTradierStreamEnabled', () => {
  it('is default-off and only a truthy word arms it', () => {
    expect(isTradierStreamEnabled({})).toBe(false);
    expect(isTradierStreamEnabled({ ENABLE_TRADIER_STREAM: 'nope' })).toBe(false);
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(isTradierStreamEnabled({ ENABLE_TRADIER_STREAM: v })).toBe(true);
    }
  });
});
