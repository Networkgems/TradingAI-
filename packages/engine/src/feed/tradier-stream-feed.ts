import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { MarketTrade, MarketQuote } from '@trading-app/shared';
import { tradierBaseUrl, type TradierEnv } from '../tradier/order-client.js';

/**
 * TRA-4656 — Phase-2 Tradier market-data stream (`/markets/events`).
 *
 * Flow per connection: `POST /markets/events/session` → `{ stream: { url, sessionid } }`,
 * open the WS, send one `{ symbols, sessionid, filter }` frame. A session id is single-use
 * and expires ~5 min after issue, so every (re)connect mints a fresh one.
 *
 * Tradier streams market data from the **production** API only — the sandbox has no
 * `/markets/events` endpoint — so `env` defaults to `production`. This is a read-only
 * market-data feed; it places nothing.
 */

export type StreamConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/** A quote stamped with the exchange event time AND the local receive time. */
export interface StreamQuote extends MarketQuote {
  /** Exchange event time, ms epoch — max(biddate, askdate). Same value as `timestamp`. */
  eventTime: number;
  /** Local wall-clock ms at which the frame was received. */
  receivedAt: number;
  /** receivedAt − eventTime. Negative values mean local clock skew, not negative latency. */
  latencyMs: number;
}

export interface SymbolFreshness {
  symbol: string;
  eventTime: number;
  receivedAt: number;
  /** now − eventTime at the moment the snapshot was taken. */
  ageMs: number;
  stale: boolean;
  latencyMs: number;
}

export interface TradierStreamStatus {
  state: StreamConnectionState;
  /** Monotone count of reconnect attempts since start(). */
  reconnects: number;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  /** Wall-clock ms of the last frame of any kind, or null if none yet on this connection. */
  lastMessageAt: number | null;
  lastError: string | null;
  staleAfterMs: number;
  /** Quotes whose latency exceeded `latencyBudgetMs`, of `quotesReceived`. */
  quotesReceived: number;
  quotesOverLatencyBudget: number;
  latencyBudgetMs: number;
  maxLatencyMs: number | null;
  symbols: SymbolFreshness[];
}

export interface TradierStreamFeedEvents {
  quote: [quote: StreamQuote];
  trade: [trade: MarketTrade];
  state: [state: StreamConnectionState, prev: StreamConnectionState];
  connected: [];
  subscribed: [symbols: string[]];
  disconnected: [code: number, reason: string];
  error: [err: Error];
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface TradierStreamFeed {
  on<K extends keyof TradierStreamFeedEvents>(event: K, listener: (...args: TradierStreamFeedEvents[K]) => void): this;
  emit<K extends keyof TradierStreamFeedEvents>(event: K, ...args: TradierStreamFeedEvents[K]): boolean;
}

export interface TradierStreamFeedOptions {
  apiToken: string;
  symbols: readonly string[];
  /** Default `production` — the sandbox does not stream. */
  env?: TradierEnv;
  /** Override the REST base used to mint the session (tests). */
  restBaseUrl?: string;
  /** Override the WS URL; by default the one returned by the session call is used. */
  wsUrl?: string;
  websocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  /** Wall clock in ms (tests). */
  now?: () => number;
  /** First reconnect delay. Default 500ms. */
  initialReconnectDelayMs?: number;
  /** Reconnect delay ceiling. Default 4000ms — keeps every retry inside the 5s AC. */
  maxReconnectDelayMs?: number;
  /** Ping interval for the liveness watchdog. Default 10s. */
  heartbeatIntervalMs?: number;
  /** A connection with no pong/frame for this long is torn down and reconnected. Default 25s. */
  heartbeatTimeoutMs?: number;
  /** A quote older than this reads stale. Default 2000ms. */
  staleAfterMs?: number;
  /** Latency above this is counted as over budget. Default 500ms. */
  latencyBudgetMs?: number;
}

interface RawQuoteFrame {
  type: 'quote';
  symbol: string;
  bid?: number | string;
  bidsz?: number | string;
  biddate?: number | string;
  ask?: number | string;
  asksz?: number | string;
  askdate?: number | string;
}

interface RawTradeFrame {
  type: 'trade';
  symbol: string;
  exch?: string;
  price?: number | string;
  size?: number | string;
  date?: number | string;
}

interface SessionEnvelope {
  stream?: { url?: string; sessionid?: string };
}

const DEFAULT_WS_URL = 'wss://ws.tradier.com/v1/markets/events';

/** Pure freshness read, shared by the feed snapshot and any UI that holds a quote. */
export function quoteFreshness(
  q: Pick<StreamQuote, 'symbol' | 'eventTime' | 'receivedAt' | 'latencyMs'>,
  nowMs: number,
  staleAfterMs = 2000,
): SymbolFreshness {
  const ageMs = nowMs - q.eventTime;
  return {
    symbol: q.symbol,
    eventTime: q.eventTime,
    receivedAt: q.receivedAt,
    ageMs,
    stale: ageMs > staleAfterMs,
    latencyMs: q.latencyMs,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class TradierStreamFeed extends EventEmitter {
  private readonly opts: TradierStreamFeedOptions;
  private readonly WSImpl: typeof WebSocket;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly latencyBudgetMs: number;

  private ws: WebSocket | null = null;
  private state: StreamConnectionState = 'disconnected';
  private stopped = true;
  /** Bumped on every connect attempt; stale async continuations compare against it. */
  private generation = 0;
  private delayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private reconnects = 0;
  private lastConnectedAt: number | null = null;
  private lastDisconnectedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private lastError: string | null = null;
  private quotesReceived = 0;
  private quotesOverBudget = 0;
  private maxLatencyMs: number | null = null;
  private readonly lastQuote = new Map<string, StreamQuote>();

  constructor(opts: TradierStreamFeedOptions) {
    super();
    this.opts = opts;
    this.WSImpl = opts.websocketImpl ?? WebSocket;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.initialDelay = opts.initialReconnectDelayMs ?? 500;
    this.maxDelay = opts.maxReconnectDelayMs ?? 4000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 10_000;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 25_000;
    this.staleAfterMs = opts.staleAfterMs ?? 2000;
    this.latencyBudgetMs = opts.latencyBudgetMs ?? 500;
    this.delayMs = this.initialDelay;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.setState('connecting');
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.close();
    this.setState('disconnected');
  }

  getState(): StreamConnectionState {
    return this.state;
  }

  getSubscribedSymbols(): string[] {
    return [...this.opts.symbols];
  }

  getLastQuote(symbol: string): StreamQuote | undefined {
    return this.lastQuote.get(symbol);
  }

  getStatus(): TradierStreamStatus {
    const now = this.now();
    return {
      state: this.state,
      reconnects: this.reconnects,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      staleAfterMs: this.staleAfterMs,
      quotesReceived: this.quotesReceived,
      quotesOverLatencyBudget: this.quotesOverBudget,
      latencyBudgetMs: this.latencyBudgetMs,
      maxLatencyMs: this.maxLatencyMs,
      symbols: [...this.lastQuote.values()].map((q) => quoteFreshness(q, now, this.staleAfterMs)),
    };
  }

  private async connect(): Promise<void> {
    const gen = ++this.generation;
    let session: { url: string; sessionid: string };
    try {
      session = await this.createSession();
    } catch (err) {
      if (gen !== this.generation || this.stopped) return;
      this.fail(err);
      this.scheduleReconnect();
      return;
    }
    if (gen !== this.generation || this.stopped) return;

    const ws = new this.WSImpl(this.opts.wsUrl ?? session.url);
    this.ws = ws;

    ws.on('open', () => {
      if (gen !== this.generation) return;
      this.delayMs = this.initialDelay;
      this.lastConnectedAt = this.now();
      this.lastMessageAt = this.lastConnectedAt;
      ws.send(
        JSON.stringify({
          symbols: [...this.opts.symbols],
          sessionid: session.sessionid,
          filter: ['quote', 'trade'],
          linebreak: true,
        }),
      );
      this.setState('connected');
      this.emit('connected');
      this.emit('subscribed', [...this.opts.symbols]);
      this.startHeartbeat(ws, gen);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      if (gen !== this.generation) return;
      this.lastMessageAt = this.now();
      this.handleData(data.toString());
    });

    ws.on('pong', () => {
      if (gen !== this.generation) return;
      this.lastMessageAt = this.now();
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (gen !== this.generation) return;
      this.ws = null;
      this.stopHeartbeat();
      this.lastDisconnectedAt = this.now();
      this.emit('disconnected', code, reason?.toString() ?? '');
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      if (gen !== this.generation) return;
      this.fail(err);
    });
  }

  private async createSession(): Promise<{ url: string; sessionid: string }> {
    const base = this.opts.restBaseUrl ?? tradierBaseUrl(this.opts.env ?? 'production');
    const resp = await this.fetchImpl(`${base}/markets/events/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiToken}`, Accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`Tradier stream session failed (${resp.status})`);
    const body = (await resp.json()) as SessionEnvelope;
    const sessionid = body.stream?.sessionid;
    if (!sessionid) throw new Error('Tradier stream session response carried no sessionid');
    return { url: body.stream?.url ?? DEFAULT_WS_URL, sessionid };
  }

  /** Frames arrive one JSON object per line (`linebreak: true`); tolerate batching. */
  private handleData(text: string): void {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: { type?: string };
      try {
        msg = JSON.parse(trimmed) as { type?: string };
      } catch (err) {
        this.fail(err);
        continue;
      }
      if (msg.type === 'quote') this.handleQuote(msg as RawQuoteFrame);
      else if (msg.type === 'trade') this.handleTrade(msg as RawTradeFrame);
      else if (msg.type === 'error') this.fail(new Error(`Tradier stream error: ${JSON.stringify(msg)}`));
    }
  }

  private handleQuote(f: RawQuoteFrame): void {
    const bid = num(f.bid);
    const ask = num(f.ask);
    if (bid == null || ask == null) return;
    const receivedAt = this.now();
    const bidDate = num(f.biddate);
    const askDate = num(f.askdate);
    const stamps = [bidDate, askDate].filter((n): n is number => n != null && n > 0);
    // A quote with no exchange stamp gets the receive time — never an older, borrowed one.
    const eventTime = stamps.length > 0 ? Math.max(...stamps) : receivedAt;
    const latencyMs = receivedAt - eventTime;
    const quote: StreamQuote = {
      symbol: f.symbol,
      timestamp: eventTime,
      bidPrice: bid,
      bidSize: num(f.bidsz) ?? 0,
      askPrice: ask,
      askSize: num(f.asksz) ?? 0,
      eventTime,
      receivedAt,
      latencyMs,
    };
    this.quotesReceived++;
    if (latencyMs > this.latencyBudgetMs) this.quotesOverBudget++;
    if (this.maxLatencyMs == null || latencyMs > this.maxLatencyMs) this.maxLatencyMs = latencyMs;
    this.lastQuote.set(f.symbol, quote);
    this.emit('quote', quote);
  }

  private handleTrade(f: RawTradeFrame): void {
    const price = num(f.price);
    if (price == null) return;
    this.emit('trade', {
      symbol: f.symbol,
      timestamp: num(f.date) ?? this.now(),
      price,
      size: num(f.size) ?? 0,
      conditions: [],
      exchange: f.exch ?? '',
    } satisfies MarketTrade);
  }

  private startHeartbeat(ws: WebSocket, gen: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (gen !== this.generation) return;
      const silentFor = this.now() - (this.lastMessageAt ?? 0);
      if (silentFor > this.heartbeatTimeoutMs) {
        this.fail(new Error(`Tradier stream silent ${silentFor}ms — forcing reconnect`));
        // terminate() skips the close handshake a dead peer will never answer; the
        // resulting 'close' event drives the reconnect.
        ws.terminate();
        return;
      }
      try {
        ws.ping();
      } catch (err) {
        this.fail(err);
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.setState('reconnecting');
    const delay = this.delayMs;
    this.delayMs = Math.min(this.delayMs * 2, this.maxDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.reconnects++;
      void this.connect();
    }, delay);
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(next: StreamConnectionState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.emit('state', next, prev);
  }

  private fail(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.lastError = e.message;
    // EventEmitter throws on an unhandled 'error' — only emit when someone listens.
    if (this.listenerCount('error') > 0) this.emit('error', e);
  }
}

function num(v: number | string | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
