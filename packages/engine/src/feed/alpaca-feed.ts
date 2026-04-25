import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { MarketBar, MarketTrade, MarketQuote } from '@trading-app/shared';

export interface AlpacaFeedEvents {
  bar: [bar: MarketBar];
  trade: [trade: MarketTrade];
  quote: [quote: MarketQuote];
  connected: [];
  authenticated: [];
  subscribed: [symbols: string[]];
  disconnected: [code: number, reason: string];
  error: [err: Error];
}

export declare interface AlpacaFeed {
  on<K extends keyof AlpacaFeedEvents>(event: K, listener: (...args: AlpacaFeedEvents[K]) => void): this;
  emit<K extends keyof AlpacaFeedEvents>(event: K, ...args: AlpacaFeedEvents[K]): boolean;
}

interface AlpacaFeedOptions {
  apiKey: string;
  apiSecret: string;
  symbols: readonly string[];
  /** Timeframes to subscribe to. Default: ['1Min', '5Min'] */
  barTimeframes?: Array<'1Min' | '5Min'>;
  paper?: boolean;
}

const BASE_URL_LIVE = 'wss://stream.data.alpaca.markets/v2/stocks';
const BASE_URL_PAPER = 'wss://stream.paper.alpaca.markets/v2/stocks';
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class AlpacaFeed extends EventEmitter {
  private readonly opts: Required<AlpacaFeedOptions>;
  private ws: WebSocket | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private subscribedSymbols: string[] = [];

  constructor(opts: AlpacaFeedOptions) {
    super();
    this.opts = {
      barTimeframes: ['1Min', '5Min'],
      paper: true,
      ...opts,
    };
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

  private connect(): void {
    const url = this.opts.paper ? BASE_URL_PAPER : BASE_URL_LIVE;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.emit('connected');
      this.authenticate();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const messages = JSON.parse(data.toString()) as AlpacaWireMessage[];
        for (const msg of messages) this.handleMessage(msg);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason.toString();
      this.emit('disconnected', code, reasonStr);
      if (!this.stopped) this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  private authenticate(): void {
    this.send({ action: 'auth', key: this.opts.apiKey, secret: this.opts.apiSecret });
  }

  private subscribe(): void {
    const symbols = this.opts.symbols as string[];
    this.send({
      action: 'subscribe',
      bars: symbols,
      trades: symbols,
      quotes: symbols,
    });
  }

  private handleMessage(msg: AlpacaWireMessage): void {
    switch (msg.T) {
      case 'success':
        if (msg.msg === 'authenticated') {
          this.backoffMs = INITIAL_BACKOFF_MS;
          this.emit('authenticated');
          this.subscribe();
        }
        break;

      case 'subscription':
        this.subscribedSymbols = msg.bars ?? [];
        this.emit('subscribed', this.subscribedSymbols);
        break;

      case 'b':
        this.emit('bar', {
          symbol: msg.S,
          timestamp: new Date(msg.t).getTime(),
          open: msg.o,
          high: msg.h,
          low: msg.l,
          close: msg.c,
          volume: msg.v,
          tradeCount: msg.n ?? 0,
          vwap: msg.vw ?? 0,
          timeframe: '1Min',
        } satisfies MarketBar);
        break;

      case 't':
        this.emit('trade', {
          symbol: msg.S,
          timestamp: new Date(msg.t).getTime(),
          price: msg.p,
          size: msg.s,
          conditions: msg.c ?? [],
          exchange: msg.x ?? '',
        } satisfies MarketTrade);
        break;

      case 'q':
        this.emit('quote', {
          symbol: msg.S,
          timestamp: new Date(msg.t).getTime(),
          bidPrice: msg.bp,
          bidSize: msg.bs,
          askPrice: msg.ap,
          askSize: msg.as,
        } satisfies MarketQuote);
        break;

      case 'error':
        this.emit('error', new Error(`Alpaca error ${msg.code}: ${msg.msg}`));
        break;
    }
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
}

// Alpaca wire message types (subset we care about)
type AlpacaWireMessage =
  | { T: 'success'; msg: string }
  | { T: 'error'; code: number; msg: string }
  | { T: 'subscription'; bars?: string[]; trades?: string[]; quotes?: string[] }
  | { T: 'b'; S: string; t: string; o: number; h: number; l: number; c: number; v: number; n?: number; vw?: number }
  | { T: 't'; S: string; t: string; p: number; s: number; c?: string[]; x?: string }
  | { T: 'q'; S: string; t: string; bp: number; bs: number; ap: number; as: number };
