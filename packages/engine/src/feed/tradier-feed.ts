import { EventEmitter } from 'events';
import type { MarketTrade, MarketQuote } from '@trading-app/shared';
import { tradierBaseUrl, type TradierEnv } from '../tradier/order-client.js';

export interface TradierFeedEvents {
  trade: [trade: MarketTrade];
  quote: [quote: MarketQuote];
  connected: [];
  subscribed: [symbols: string[]];
  disconnected: [];
  error: [err: Error];
}

// Intentional class/interface merge: this interface narrows EventEmitter's
// `on`/`emit` to the typed `TradierFeedEvents` map. The merge is safe because
// the interface only refines (never overrides) inherited signatures.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface TradierFeed {
  on<K extends keyof TradierFeedEvents>(event: K, listener: (...args: TradierFeedEvents[K]) => void): this;
  emit<K extends keyof TradierFeedEvents>(event: K, ...args: TradierFeedEvents[K]): boolean;
}

interface TradierFeedOptions {
  apiToken: string;
  symbols: readonly string[];
  env?: TradierEnv;
  /** Poll interval in ms. Default 1500. */
  pollIntervalMs?: number;
}

interface TradierRawQuote {
  symbol: string;
  bid?: number;
  bidsize?: number;
  ask?: number;
  asksize?: number;
  last?: number;
  last_volume?: number;
  trade_date?: number;
  exch?: string;
}

interface TradierQuotesEnvelope {
  quotes?: { quote?: TradierRawQuote | TradierRawQuote[] } | string | null;
}

const DEFAULT_POLL_MS = 1500;

/**
 * Phase-1 polling feed. Mirrors AlpacaFeed's event shape so a strategy can swap
 * data sources without changing handlers. We hit `GET /markets/quotes` on an
 * interval and emit `quote` whenever bid/ask changes, plus `trade` on a new
 * `trade_date`. Streaming via `/markets/events` is Phase-2 work.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class TradierFeed extends EventEmitter {
  private readonly opts: Required<TradierFeedOptions>;
  private readonly baseUrl: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lastQuoteKey = new Map<string, string>();
  private readonly lastTradeTs = new Map<string, number>();

  constructor(opts: TradierFeedOptions) {
    super();
    this.opts = {
      env: 'sandbox',
      pollIntervalMs: DEFAULT_POLL_MS,
      ...opts,
    };
    this.baseUrl = tradierBaseUrl(this.opts.env);
  }

  start(): void {
    if (this.timer) return;
    this.emit('connected');
    this.emit('subscribed', [...this.opts.symbols]);
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.emit('disconnected');
    }
  }

  getSubscribedSymbols(): string[] {
    return [...this.opts.symbols];
  }

  private async poll(): Promise<void> {
    if (this.opts.symbols.length === 0) return;
    try {
      const url = `${this.baseUrl}/markets/quotes?symbols=${encodeURIComponent(this.opts.symbols.join(','))}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.opts.apiToken}`, Accept: 'application/json' },
      });
      if (!resp.ok) {
        this.emit('error', new Error(`Tradier quotes poll failed (${resp.status})`));
        return;
      }
      const data = (await resp.json()) as TradierQuotesEnvelope;
      const quotes = normalizeQuotes(data);
      for (const q of quotes) this.handleQuote(q);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleQuote(q: TradierRawQuote): void {
    const ts = typeof q.trade_date === 'number' ? q.trade_date : Date.now();

    if (typeof q.bid === 'number' && typeof q.ask === 'number') {
      const key = `${q.bid}|${q.ask}|${q.bidsize ?? 0}|${q.asksize ?? 0}`;
      if (this.lastQuoteKey.get(q.symbol) !== key) {
        this.lastQuoteKey.set(q.symbol, key);
        this.emit('quote', {
          symbol: q.symbol,
          timestamp: ts,
          bidPrice: q.bid,
          bidSize: q.bidsize ?? 0,
          askPrice: q.ask,
          askSize: q.asksize ?? 0,
        } satisfies MarketQuote);
      }
    }

    if (typeof q.last === 'number' && typeof q.trade_date === 'number') {
      if (this.lastTradeTs.get(q.symbol) !== q.trade_date) {
        this.lastTradeTs.set(q.symbol, q.trade_date);
        this.emit('trade', {
          symbol: q.symbol,
          timestamp: q.trade_date,
          price: q.last,
          size: q.last_volume ?? 0,
          conditions: [],
          exchange: q.exch ?? '',
        } satisfies MarketTrade);
      }
    }
  }
}

function normalizeQuotes(data: TradierQuotesEnvelope): TradierRawQuote[] {
  if (!data.quotes || typeof data.quotes !== 'object') return [];
  const quote = data.quotes.quote;
  if (quote == null) return [];
  return Array.isArray(quote) ? quote : [quote];
}
