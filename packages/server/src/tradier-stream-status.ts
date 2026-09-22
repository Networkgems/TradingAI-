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

/** TRA-4782 — opt-in cap on the subscribe frame. Unset = today's behaviour (the full fleet union). */
export const TRADIER_STREAM_SYMBOL_LIMIT_ENV = 'TRADIER_STREAM_SYMBOL_LIMIT';

/** Equity tickers only: `/markets/events` here is fed the stock/option underlyings. */
const EQUITY_SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

/**
 * TRA-4782 — the liquidity ladder the symbol cap selects down.
 *
 * This is a **curated static ordering**, not a measured one: the server has no
 * ADV table at boot, and the experiment does not need a precise ranking. What it
 * needs is a cohort that quotes *continuously*, so that a p50 measured over it
 * cannot be explained by trade sparsity — which is exactly the confound TRA-4782
 * already ruled out by hand on SPY/TSLA/QQQ/NVDA/MSFT. Those five are in the top
 * ten here, so the N=25 arm of the experiment contains the very rows whose 35.6s
 * p50 is the thing being explained.
 *
 * Nothing downstream may treat this as a claim about relative liquidity. Its
 * only contract is "these names quote all session", and the discriminator the
 * experiment turns on is the p50 under the cap — not which 25 names were picked.
 */
export const STREAM_LIQUIDITY_LADDER: readonly string[] = [
  'SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL', 'AMZN', 'MSFT', 'META', 'AMD', 'GOOGL',
  'IWM', 'PLTR', 'INTC', 'F', 'SOFI', 'BAC', 'AVGO', 'MU', 'COIN', 'NFLX',
  'DIA', 'XLF', 'T', 'PFE', 'CSCO', 'GOOG', 'SMCI', 'WMT', 'DELL', 'JPM',
  'UBER', 'BABA', 'C', 'VZ', 'KO', 'XOM', 'GM', 'GLD', 'TLT', 'XLE',
] as const;

const LADDER_RANK = new Map(STREAM_LIQUIDITY_LADDER.map((s, i) => [s, i]));

export interface StreamSymbolLimit {
  /** The cap actually applied, or `null` for "no cap" — the full fleet union. */
  limit: number | null;
  /** Exactly what the env var held, `null` when unset. Present so `null` limit is never ambiguous. */
  raw: string | null;
  /**
   * Why a present value was not honoured. A garbage value must NOT read the same
   * as an unset one: both leave `limit: null`, and only this field tells them apart.
   */
  error: string | null;
}

/** Parse {@link TRADIER_STREAM_SYMBOL_LIMIT_ENV}. Unset ⇒ no cap; unparseable ⇒ no cap **plus an error**. */
export function resolveStreamSymbolLimit(env: NodeJS.ProcessEnv = process.env): StreamSymbolLimit {
  const rawValue = env[TRADIER_STREAM_SYMBOL_LIMIT_ENV];
  if (rawValue == null || rawValue.trim() === '') return { limit: null, raw: rawValue ?? null, error: null };
  const raw = rawValue.trim();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { limit: null, raw, error: `${TRADIER_STREAM_SYMBOL_LIMIT_ENV}=${JSON.stringify(raw)} is not an integer >= 1 — NO cap applied` };
  }
  return { limit: n, raw, error: null };
}

export interface StreamSymbolSelection {
  selected: string[];
  /** Length of the input — the fleet union before any cap. */
  before: number;
  /** Of `selected`, how many came off {@link STREAM_LIQUIDITY_LADDER} … */
  ranked: number;
  /** … and how many were back-filled from the un-ranked tail because the ladder ran out. */
  unranked: number;
}

/**
 * Apply the cap, ladder-first. A stable partition, not a sort: ladder members in
 * ladder order, then everything else in the caller's order, truncated to `limit`.
 *
 * `limit == null` or `limit >= symbols.length` is the identity — the caller's
 * order survives untouched, so an uncapped run subscribes exactly what it always did.
 */
export function applyStreamSymbolLimit(symbols: readonly string[], limit: number | null): StreamSymbolSelection {
  const before = symbols.length;
  if (limit == null || limit >= before) {
    const ranked = symbols.filter((s) => LADDER_RANK.has(s)).length;
    // ranked + unranked === selected.length, in BOTH branches — so a reader can
    // never mistake "the cap did not bind" for "the ladder covered everything".
    return { selected: [...symbols], before, ranked, unranked: before - ranked };
  }
  const ranked = symbols.filter((s) => LADDER_RANK.has(s)).sort((a, b) => LADDER_RANK.get(a)! - LADDER_RANK.get(b)!);
  const rest = symbols.filter((s) => !LADDER_RANK.has(s));
  const selected = [...ranked, ...rest].slice(0, limit);
  const rankedCount = Math.min(ranked.length, limit);
  return { selected, before, ranked: rankedCount, unranked: selected.length - rankedCount };
}

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
  /**
   * TRA-4782 — `latencyMs` beyond the feed's sanity bound: a halted/delisted book,
   * not a late feed. The row keeps its true `latencyMs`; this flag is what stops a
   * reader from folding 125 days of staleness into a latency verdict.
   */
  staleEventTime: boolean;
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
      /** TRA-4782 — echoed even while disabled, so "did my env write land?" is answerable. */
      symbolLimitEnv: typeof TRADIER_STREAM_SYMBOL_LIMIT_ENV;
      symbolLimit: number | null;
      symbolLimitRaw: string | null;
      symbolLimitError: string | null;
    }
  | ({
      enabled: true;
      state: StreamConnectionState;
      flag: typeof TRADIER_STREAM_FLAG;
      flagOn: true;
      /** Rows actually in the subscribe frame — i.e. after any cap. */
      subscribedSymbols: number;
      quotedSymbols: number;
      staleSymbols: number;
      /** TRA-4782 — the fleet union BEFORE the cap. Equal to `subscribedSymbols` when uncapped. */
      symbolsBeforeLimit: number;
      symbolLimitEnv: typeof TRADIER_STREAM_SYMBOL_LIMIT_ENV;
      /** `null` = no cap. Read `symbolLimitError` before concluding the operator meant that. */
      symbolLimit: number | null;
      symbolLimitRaw: string | null;
      symbolLimitError: string | null;
      /** Of the subscribed set: off the curated ladder vs back-filled from the tail. */
      symbolsFromLadder: number;
      symbolsOffLadder: number;
      generatedAt: number;
      symbols: TradierStreamSymbolRow[];
    } & Omit<TradierStreamStatus, 'state' | 'symbols'>);

/** Fold the engine snapshot over the subscribed list so no subscribed symbol can go missing. */
export function buildTradierStreamPayload(
  status: TradierStreamStatus,
  subscribed: readonly string[],
  nowMs: number,
  selection: StreamSymbolSelection,
  limit: StreamSymbolLimit,
): TradierStreamPayload {
  const bySymbol = new Map(status.symbols.map((s) => [s.symbol, s]));
  const rows: TradierStreamSymbolRow[] = subscribed.map((symbol) => {
    const f = bySymbol.get(symbol);
    if (!f) {
      return {
        symbol, ageMs: null, stale: true, neverQuoted: true,
        eventTime: null, receivedAt: null, latencyMs: null, staleEventTime: false,
      };
    }
    return {
      symbol,
      ageMs: f.ageMs,
      stale: f.stale,
      neverQuoted: false,
      eventTime: f.eventTime,
      receivedAt: f.receivedAt,
      latencyMs: f.latencyMs,
      staleEventTime: f.latencyMs > status.latencySanityBoundMs,
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
    symbolsBeforeLimit: selection.before,
    symbolLimitEnv: TRADIER_STREAM_SYMBOL_LIMIT_ENV,
    symbolLimit: limit.limit,
    symbolLimitRaw: limit.raw,
    symbolLimitError: limit.error,
    symbolsFromLadder: selection.ranked,
    symbolsOffLadder: selection.unranked,
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
  const symbolLimit = resolveStreamSymbolLimit(env);
  let selection: StreamSymbolSelection = { selected: [], before: 0, ranked: 0, unranked: 0 };
  if (symbolLimit.error) log.warn(symbolLimit.error);

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
      // TRA-4782 — the experiment's lever. Unset cap ⇒ identity, so an unset env
      // subscribes byte-identically to what it subscribed before this ticket.
      selection = applyStreamSymbolLimit(symbols, symbolLimit.limit);
      subscribed = selection.selected;
      feed = createFeed({ apiToken, symbols: subscribed, env: 'production' });
      // Without a listener the feed only records lastError; log transitions so an
      // operator reading the box's logs sees the same thing the route does.
      feed.on('error', (err) => log.warn('tradier stream error', { error: err.message }));
      feed.on('state', (next, prev) => log.info('tradier stream state', { from: prev, to: next }));
      feed.start();
      log.info('tradier stream started', {
        symbols: subscribed.length,
        symbolsBeforeLimit: selection.before,
        symbolLimit: symbolLimit.limit,
      });
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
          symbolLimitEnv: TRADIER_STREAM_SYMBOL_LIMIT_ENV,
          symbolLimit: symbolLimit.limit,
          symbolLimitRaw: symbolLimit.raw,
          symbolLimitError: symbolLimit.error,
        };
      }
      return buildTradierStreamPayload(feed.getStatus(), subscribed, t, selection, symbolLimit);
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
