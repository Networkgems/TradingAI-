// TRA-4707 (follow-up to TRA-4656) — wire the Tradier `/markets/events` stream
// into the server behind a DEFAULT-OFF flag and publish its status read-only.
//
// Data feed ONLY: this module constructs a `TradierStreamFeed`, which mints a
// stream session and reads quotes. It imports no order client and exposes no
// write verb — the route is a GET over `feed.getStatus()`.
//
// Two honesty rules the payload is shaped around:
//   1. Flag off (or flag on but not startable) reads `state: 'disabled'` with a
//      `reason` — never an empty-but-healthy `symbols: []`, which would be
//      indistinguishable from "connected, all quiet".
//   2. The engine snapshot lists only symbols that HAVE quoted. A subscribed
//      symbol that has never quoted would therefore simply be absent — a hole
//      that reads as nothing. Here every subscribed symbol gets a row, and a
//      never-quoted one reads `ageMs: null, stale: true, neverQuoted: true`.
//
// Token: production only (`TRADIER_MARKET_DATA_TOKEN`, else `TRADIER_API_TOKEN`
// — the same precedence yahoo-feed uses), because the sandbox has no
// `/markets/events`. `TRADIER_SANDBOX_API_TOKEN` is deliberately never read.

import type { Express, RequestHandler } from 'express';
import {
  TradierStreamFeed,
  type TradierStreamFeedOptions,
  type TradierStreamStatus,
  type StreamConnectionState,
} from '@trading-app/engine';
import { QUOTE_STALE_AFTER_MS } from '@trading-app/shared';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'tradier-stream' });

export const TRADIER_STREAM_FLAG = 'ENABLE_TRADIER_STREAM';

/** Equity tickers only: `/markets/events` here is fed the stock/option underlyings. */
const EQUITY_SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export function isTradierStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[TRADIER_STREAM_FLAG] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function resolveTradierStreamToken(env: NodeJS.ProcessEnv = process.env): string {
  return ((env['TRADIER_MARKET_DATA_TOKEN'] ?? '').trim() || (env['TRADIER_API_TOKEN'] ?? '').trim());
}

/** Dedupe + uppercase + drop anything that is not an equity ticker; sorted for a stable subscribe frame. */
export function normalizeStreamSymbols(raw: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of raw) {
    const sym = (s ?? '').trim().toUpperCase();
    if (EQUITY_SYMBOL_RE.test(sym)) out.add(sym);
  }
  return [...out].sort();
}

export type TradierStreamDisabledReason = 'flag_off' | 'token_missing' | 'no_symbols';

export interface TradierStreamSymbolRow {
  symbol: string;
  /** now − exchange event time; null when the symbol has never quoted. */
  ageMs: number | null;
  stale: boolean;
  neverQuoted: boolean;
  eventTime: number | null;
  receivedAt: number | null;
  latencyMs: number | null;
}

export type TradierStreamPayload =
  | {
      enabled: false;
      state: 'disabled';
      reason: TradierStreamDisabledReason;
      flag: typeof TRADIER_STREAM_FLAG;
      flagOn: boolean;
      staleAfterMs: number;
      generatedAt: number;
    }
  | ({
      enabled: true;
      state: StreamConnectionState;
      flag: typeof TRADIER_STREAM_FLAG;
      flagOn: true;
      subscribedSymbols: number;
      quotedSymbols: number;
      staleSymbols: number;
      generatedAt: number;
      symbols: TradierStreamSymbolRow[];
    } & Omit<TradierStreamStatus, 'state' | 'symbols'>);

/** Fold the engine snapshot over the subscribed list so no subscribed symbol can go missing. */
export function buildTradierStreamPayload(
  status: TradierStreamStatus,
  subscribed: readonly string[],
  nowMs: number,
): TradierStreamPayload {
  const bySymbol = new Map(status.symbols.map((s) => [s.symbol, s]));
  const rows: TradierStreamSymbolRow[] = subscribed.map((symbol) => {
    const f = bySymbol.get(symbol);
    if (!f) {
      return { symbol, ageMs: null, stale: true, neverQuoted: true, eventTime: null, receivedAt: null, latencyMs: null };
    }
    return {
      symbol,
      ageMs: f.ageMs,
      stale: f.stale,
      neverQuoted: false,
      eventTime: f.eventTime,
      receivedAt: f.receivedAt,
      latencyMs: f.latencyMs,
    };
  });
  const { state, symbols: _omit, ...rest } = status;
  return {
    enabled: true,
    state,
    flag: TRADIER_STREAM_FLAG,
    flagOn: true,
    ...rest,
    subscribedSymbols: subscribed.length,
    quotedSymbols: rows.filter((r) => !r.neverQuoted).length,
    staleSymbols: rows.filter((r) => r.stale).length,
    generatedAt: nowMs,
    symbols: rows,
  };
}

export interface TradierStreamService {
  /** Starts the feed if the flag is on and it is startable; otherwise records why not. Idempotent. */
  start(): void;
  stop(): void;
  getPayload(): TradierStreamPayload;
}

export interface TradierStreamServiceDeps {
  env?: NodeJS.ProcessEnv;
  /** Symbols the stocks/options books watch — read once, at start(). */
  resolveSymbols: () => readonly string[];
  /** Test seam: build the feed. Defaults to a production `TradierStreamFeed`. */
  createFeed?: (opts: TradierStreamFeedOptions) => Pick<TradierStreamFeed, 'start' | 'stop' | 'getStatus' | 'on'>;
  now?: () => number;
}

export function createTradierStreamService(deps: TradierStreamServiceDeps): TradierStreamService {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const createFeed = deps.createFeed ?? ((opts) => new TradierStreamFeed(opts));
  let feed: ReturnType<NonNullable<TradierStreamServiceDeps['createFeed']>> | null = null;
  let subscribed: string[] = [];
  let disabledReason: TradierStreamDisabledReason = isTradierStreamEnabled(env) ? 'no_symbols' : 'flag_off';

  return {
    start() {
      if (feed) return;
      if (!isTradierStreamEnabled(env)) {
        disabledReason = 'flag_off';
        return;
      }
      const apiToken = resolveTradierStreamToken(env);
      if (!apiToken) {
        disabledReason = 'token_missing';
        log.warn(`${TRADIER_STREAM_FLAG} is on but no production Tradier token is set — stream NOT started`);
        return;
      }
      const symbols = normalizeStreamSymbols(deps.resolveSymbols());
      if (symbols.length === 0) {
        disabledReason = 'no_symbols';
        log.warn(`${TRADIER_STREAM_FLAG} is on but the books watch no equity symbols — stream NOT started`);
        return;
      }
      subscribed = symbols;
      feed = createFeed({ apiToken, symbols, env: 'production' });
      // Without a listener the feed only records lastError; log transitions so an
      // operator reading the box's logs sees the same thing the route does.
      feed.on('error', (err) => log.warn('tradier stream error', { error: err.message }));
      feed.on('state', (next, prev) => log.info('tradier stream state', { from: prev, to: next }));
      feed.start();
      log.info('tradier stream started', { symbols: symbols.length });
    },
    stop() {
      feed?.stop();
    },
    getPayload() {
      const t = now();
      if (!feed) {
        return {
          enabled: false,
          state: 'disabled',
          reason: disabledReason,
          flag: TRADIER_STREAM_FLAG,
          flagOn: isTradierStreamEnabled(env),
          staleAfterMs: QUOTE_STALE_AFTER_MS,
          generatedAt: t,
        };
      }
      return buildTradierStreamPayload(feed.getStatus(), subscribed, t);
    },
  };
}

export interface TradierStreamRouteDeps {
  requireAuth: RequestHandler;
  service: TradierStreamService;
}

/** Read-only. There is deliberately no POST: arming is an env write + redeploy, a human decision. */
export function registerTradierStreamRoutes(app: Express, deps: TradierStreamRouteDeps): void {
  app.get('/api/market-data/stream', deps.requireAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(deps.service.getPayload());
  });
}
