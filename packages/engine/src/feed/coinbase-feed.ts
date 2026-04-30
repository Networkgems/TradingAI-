import { EventEmitter } from 'events';
import { createPrivateKey, createSign, randomBytes } from 'crypto';
import type { KeyObject } from 'crypto';
import WebSocket from 'ws';
import type { MarketBar, MarketTrade, MarketQuote } from '@trading-app/shared';

export interface CoinbaseFeedEvents {
  bar: [bar: MarketBar];
  trade: [trade: MarketTrade];
  quote: [quote: MarketQuote];
  connected: [];
  authenticated: [];
  subscribed: [symbols: string[]];
  disconnected: [code: number, reason: string];
  error: [err: Error];
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface CoinbaseFeed {
  on<K extends keyof CoinbaseFeedEvents>(event: K, listener: (...args: CoinbaseFeedEvents[K]) => void): this;
  emit<K extends keyof CoinbaseFeedEvents>(event: K, ...args: CoinbaseFeedEvents[K]): boolean;
}

export interface CoinbaseFeedOptions {
  /** product_ids to subscribe to, e.g. ['BTC-USD','ETH-USD']. */
  symbols: readonly string[];
  /**
   * Optional CDP key name (e.g. `organizations/.../apiKeys/...`). When absent the feed
   * runs in public/anonymous mode — market-data channels (`ticker`, `market_trades`,
   * `candles`, `heartbeats`) work without authentication.
   */
  apiKey?: string;
  /**
   * Optional CDP private key (PEM-encoded EC). Required only if `apiKey` is set.
   * HMAC legacy keys are NOT accepted on the Advanced Trade WS — use a CDP key
   * or omit credentials entirely (public mode).
   */
  apiSecret?: string;
  /** Override the WS endpoint (handy for tests). */
  url?: string;
  /** Inject a WebSocket implementation (handy for tests). Defaults to `ws`. */
  websocketImpl?: typeof WebSocket;
  /** Override the JWT clock (handy for tests). */
  now?: () => number;
  /** Override the JWT nonce (handy for tests). */
  nonce?: () => string;
}

const DEFAULT_WS_URL = 'wss://advanced-trade-ws.coinbase.com';
const CDP_JWT_TTL_SECONDS = 120;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

/** Channels we always subscribe to. `heartbeats` keeps the connection from idling out. */
const CHANNELS = ['ticker', 'market_trades', 'candles', 'heartbeats'] as const;

type CoinbaseChannel = (typeof CHANNELS)[number];

interface TickerPayload {
  type: 'ticker';
  product_id: string;
  price: string;
  volume_24_h?: string;
  best_bid?: string;
  best_bid_quantity?: string;
  best_ask?: string;
  best_ask_quantity?: string;
}

interface TradePayload {
  trade_id: string;
  product_id: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  time: string;
}

interface CandlePayload {
  /** Unix seconds, stringified. */
  start: string;
  high: string;
  low: string;
  open: string;
  close: string;
  volume: string;
  product_id: string;
}

type CoinbaseEvent =
  | { channel: 'ticker'; events: Array<{ type: 'snapshot' | 'update'; tickers: TickerPayload[] }> }
  | { channel: 'market_trades'; events: Array<{ type: 'snapshot' | 'update'; trades: TradePayload[] }> }
  | { channel: 'candles'; events: Array<{ type: 'snapshot' | 'update'; candles: CandlePayload[] }> }
  | { channel: 'subscriptions'; events: Array<{ subscriptions: Partial<Record<CoinbaseChannel, string[]>> }> }
  | { channel: 'heartbeats'; events: unknown[] }
  | { type: 'error'; message?: string };

/**
 * Coinbase Advanced Trade WebSocket feed.
 *
 * Mirrors {@link AlpacaFeed}'s public surface (`bar` / `trade` / `quote` events;
 * `start` / `stop` / `subscribe` methods) so a strategy can swap between
 * equities (Alpaca) and crypto (Coinbase) without changing handlers.
 *
 * The Advanced Trade WS endpoint allows public subscription to market-data
 * channels (`ticker`, `market_trades`, `candles`, `heartbeats`) with no
 * authentication, so the feed runs in **public mode** when `apiKey`/`apiSecret`
 * are absent. Supplying a CDP JWT key pair switches it into authenticated mode
 * — required only if a future iteration adds private channels (e.g. `user`).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class CoinbaseFeed extends EventEmitter {
  private readonly opts: CoinbaseFeedOptions;
  private readonly url: string;
  private readonly WSImpl: typeof WebSocket;
  private readonly cdpPrivateKey: KeyObject | null;
  private readonly now: () => number;
  private readonly nonce: () => string;

  private ws: WebSocket | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private subscribedSymbols: string[] = [];
  /** product_id → last (open|high|low|close|volume) candle key, so we only emit on change. */
  private readonly lastCandleKey = new Map<string, string>();
  /** product_id → last quote key, so we don't re-emit identical bid/ask snapshots. */
  private readonly lastQuoteKey = new Map<string, string>();

  constructor(opts: CoinbaseFeedOptions) {
    super();
    this.opts = opts;
    this.url = opts.url ?? DEFAULT_WS_URL;
    this.WSImpl = opts.websocketImpl ?? WebSocket;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.nonce = opts.nonce ?? (() => randomBytes(16).toString('hex'));

    if (opts.apiKey && opts.apiSecret) {
      try {
        this.cdpPrivateKey = createPrivateKey({ key: opts.apiSecret, format: 'pem' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`CoinbaseFeed: failed to parse CDP private key: ${msg}`);
      }
    } else {
      this.cdpPrivateKey = null;
    }
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  getSubscribedSymbols(): string[] {
    return [...this.subscribedSymbols];
  }

  /** True when running with authenticated CDP credentials. Exposed for diagnostics. */
  isAuthenticated(): boolean {
    return this.cdpPrivateKey !== null;
  }

  private connect(): void {
    const ws = new this.WSImpl(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.emit('connected');
      // Auth on Advanced Trade WS is per-subscription, not session-level — so we
      // don't have a separate `authenticated` step. We emit it once on first
      // open when creds are present so listeners can mirror AlpacaFeed's flow.
      if (this.cdpPrivateKey) this.emit('authenticated');
      for (const channel of CHANNELS) this.subscribe(channel);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as CoinbaseEvent;
        this.handleMessage(msg);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason.toString();
      this.emit('disconnected', code, reasonStr);
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  private subscribe(channel: CoinbaseChannel): void {
    const payload: Record<string, unknown> = {
      type: 'subscribe',
      product_ids: [...this.opts.symbols],
      channel,
    };
    if (this.cdpPrivateKey) {
      payload.jwt = this.buildJwt();
    }
    this.send(payload);
  }

  private handleMessage(msg: CoinbaseEvent): void {
    if ('type' in msg && msg.type === 'error') {
      this.emit('error', new Error(`Coinbase WS error: ${msg.message ?? 'unknown'}`));
      return;
    }
    if (!('channel' in msg)) return;

    switch (msg.channel) {
      case 'subscriptions': {
        // Reset backoff on first successful ack — we know the connection is live.
        this.backoffMs = INITIAL_BACKOFF_MS;
        const tickerSubs = msg.events?.[0]?.subscriptions?.ticker ?? [];
        this.subscribedSymbols = tickerSubs;
        this.emit('subscribed', this.subscribedSymbols);
        break;
      }
      case 'ticker': {
        for (const evt of msg.events ?? []) {
          for (const t of evt.tickers ?? []) this.emitQuoteFromTicker(t);
        }
        break;
      }
      case 'market_trades': {
        for (const evt of msg.events ?? []) {
          for (const t of evt.trades ?? []) this.emitTrade(t);
        }
        break;
      }
      case 'candles': {
        for (const evt of msg.events ?? []) {
          for (const c of evt.candles ?? []) this.emitBar(c);
        }
        break;
      }
      case 'heartbeats':
        // No-op — heartbeats keep the WS warm; server enforces idle timeout.
        break;
    }
  }

  private emitQuoteFromTicker(t: TickerPayload): void {
    const bid = numOrNull(t.best_bid);
    const ask = numOrNull(t.best_ask);
    if (bid == null || ask == null) return;
    const bidSize = numOrNull(t.best_bid_quantity) ?? 0;
    const askSize = numOrNull(t.best_ask_quantity) ?? 0;
    const key = `${bid}|${ask}|${bidSize}|${askSize}`;
    if (this.lastQuoteKey.get(t.product_id) === key) return;
    this.lastQuoteKey.set(t.product_id, key);
    this.emit('quote', {
      symbol: t.product_id,
      timestamp: Date.now(),
      bidPrice: bid,
      bidSize,
      askPrice: ask,
      askSize,
    } satisfies MarketQuote);
  }

  private emitTrade(t: TradePayload): void {
    const price = numOrNull(t.price);
    const size = numOrNull(t.size);
    if (price == null || size == null) return;
    this.emit('trade', {
      symbol: t.product_id,
      timestamp: new Date(t.time).getTime(),
      price,
      size,
      conditions: [t.side],
      exchange: 'COINBASE',
    } satisfies MarketTrade);
  }

  private emitBar(c: CandlePayload): void {
    const open = numOrNull(c.open);
    const high = numOrNull(c.high);
    const low = numOrNull(c.low);
    const close = numOrNull(c.close);
    const volume = numOrNull(c.volume);
    if (open == null || high == null || low == null || close == null || volume == null) return;

    // Coinbase streams the in-progress candle on every update — dedupe so
    // listeners only see a bar when something actually changed (matches the
    // AlpacaFeed semantics where bar events fire on close).
    const key = `${c.start}|${open}|${high}|${low}|${close}|${volume}`;
    if (this.lastCandleKey.get(c.product_id) === key) return;
    this.lastCandleKey.set(c.product_id, key);

    this.emit('bar', {
      symbol: c.product_id,
      timestamp: Number(c.start) * 1000,
      open,
      high,
      low,
      close,
      volume,
      tradeCount: 0,
      vwap: 0,
      timeframe: '1Min',
    } satisfies MarketBar);
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private buildJwt(): string {
    if (!this.cdpPrivateKey || !this.opts.apiKey) {
      throw new Error('buildJwt called without CDP credentials');
    }
    const nowSec = this.now();
    const header = {
      alg: 'ES256',
      kid: this.opts.apiKey,
      typ: 'JWT',
      nonce: this.nonce(),
    };
    // Advanced Trade WS only requires `sub`/`iss`/`nbf`/`exp` — no `uri` claim
    // since the JWT scopes the WS connection, not a specific HTTP request.
    const payload = {
      sub: this.opts.apiKey,
      iss: 'cdp',
      nbf: nowSec,
      exp: nowSec + CDP_JWT_TTL_SECONDS,
    };
    const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
    const signingInput = `${headerB64}.${payloadB64}`;
    const sig = createSign('SHA256')
      .update(signingInput)
      .sign({ key: this.cdpPrivateKey, dsaEncoding: 'ieee-p1363' });
    return `${signingInput}.${base64UrlEncode(sig)}`;
  }
}

function numOrNull(s: string | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
