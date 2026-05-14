import type { OptionType } from '@trading-app/shared';
import type { OptionChainRow } from '../options/otm-mispricing.js';
import { TradierOrderClient, type TradierEnv, type TradierOrderResponse } from './order-client.js';

export interface TradierOptionsContract {
  /** OCC symbol (e.g. AAPL230818C00150000). Tradier returns this as `symbol`. */
  symbol: string;
  /** Same as `symbol` — exposed under both names so call-sites can reach for either. */
  optionSymbol: string;
  underlying: string;
  description: string;
  option_type: 'call' | 'put';
  strike: number;
  expiration_date: string; // YYYY-MM-DD
  expiration_type?: string;
}

export interface TradierOptionQuote {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
}

interface TradierExpirationsEnvelope {
  expirations?: { date?: string | string[] } | string | null;
}

interface TradierChainEnvelope {
  options?: { option?: TradierRawOption | TradierRawOption[] } | string | null;
}

interface TradierQuotesEnvelope {
  quotes?: { quote?: TradierRawQuote | TradierRawQuote[] } | string | null;
}

interface TradierRawOption {
  symbol: string;
  underlying: string;
  description: string;
  option_type: 'call' | 'put';
  strike: number;
  expiration_date: string;
  expiration_type?: string;
  bid?: number;
  ask?: number;
  last?: number;
  volume?: number;
  open_interest?: number;
  greeks?: TradierRawGreeks | null;
}

interface TradierRawGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  bid_iv?: number;
  mid_iv?: number;
  ask_iv?: number;
  smv_vol?: number;
}

interface TradierRawQuote {
  symbol: string;
  bid?: number;
  ask?: number;
  last?: number;
}

/**
 * TRA-323 — Tradier `/accounts/{id}/positions` envelope. Tradier returns
 * `positions: 'null'` (the literal string) when the account has no open
 * positions, a single `position` object when there's one, or an array when
 * there are several. We normalize all three via {@link asArray}.
 */
interface TradierPositionsEnvelope {
  positions?: { position?: TradierRawPosition | TradierRawPosition[] } | string | null;
}

/**
 * TRA-323 — raw shape of a single Tradier position. `symbol` is the OCC
 * option symbol (e.g. `SPY240315P00500000`) for option contracts and the
 * underlying ticker for equities. `quantity` is in contracts for options
 * and shares for equities; Tradier surfaces it as a positive number for
 * long positions and negative for shorts. `cost_basis` is the total cost
 * of the position (per-share × qty × 100 for options) — we divide by the
 * contract multiplier to recover the per-share premium paid.
 */
interface TradierRawPosition {
  symbol: string;
  quantity: number;
  cost_basis: number;
  date_acquired: string;
  id?: number;
}

/**
 * TRA-323 — open option position imported from Tradier. Holds the
 * minimum information the local store needs to display the position and
 * later submit a `sell_to_close` order. Equity positions are skipped at
 * the parser layer because the engine only supports closing options
 * through this code path.
 */
export interface TradierOpenOptionPosition {
  /** OCC option symbol — `[A-Z]{1-6}YYMMDD[CP]\d{8}`. */
  optionSymbol: string;
  /** Underlying ticker parsed from the OCC symbol. */
  underlying: string;
  optionType: 'call' | 'put';
  strike: number;
  /** ISO `YYYY-MM-DD` expiration date parsed from the OCC symbol. */
  expiration: string;
  /** Number of contracts open. Always positive — short legs are skipped. */
  contracts: number;
  /** Per-share premium paid (cost basis ÷ contracts ÷ 100). */
  premiumPaid: number;
  /** When Tradier acquired the position (ms epoch); falls back to `Date.now()`. */
  acquiredAt: number;
  /** Tradier's numeric position id, when the API surfaces one. */
  tradierPositionId?: number;
}

interface TradierBalancesEnvelope {
  balances?: {
    account_number?: string;
    account_type?: string;
    total_equity?: number;
    total_cash?: number;
    open_pl?: number;
    /** TRA-335 — total long market value, used for live equity sizing. */
    long_market_value?: number;
    /** TRA-319 — margin accounts surface option buying power under `margin`. */
    margin?: {
      option_buying_power?: number;
      stock_buying_power?: number;
    } | null;
    /** TRA-319 — pattern-day-trader accounts surface it under `pdt`. */
    pdt?: {
      option_buying_power?: number;
      stock_buying_power?: number;
    } | null;
    /** TRA-319 — cash accounts only have `cash.cash_available`. */
    cash?: {
      cash_available?: number;
    } | null;
  } | null;
}

/** TRA-226 — read-only Tradier account balance snapshot. */
export interface TradierAccountBalance {
  totalEquity: number;
  totalCash: number;
  /**
   * TRA-319 — option buying power for the account. Margin accounts use
   * `balances.margin.option_buying_power`; PDT accounts use `balances.pdt.*`;
   * cash accounts only have `balances.cash.cash_available`. `null` when the
   * payload didn't include any of those — callers should fall back to
   * `totalCash` and accept that the pre-check might be permissive.
   */
  optionBuyingPower: number | null;
  /**
   * TRA-335 — stock (equity) buying power. Margin / PDT accounts surface
   * `stock_buying_power`; cash accounts only have `cash.cash_available` so
   * we fall back to that. `null` when the payload didn't include any of
   * those, in which case live equity sizing should fall back to `totalCash`.
   */
  stockBuyingPower: number | null;
  /**
   * TRA-335 — long market value (the dollar value of currently held longs).
   * The live equity engine sizes against `(totalCash + longMarketValue) ×
   * managedAccountRatio × riskPerTrade`, so this is needed alongside cash
   * for sizing. `null` when Tradier didn't return the field.
   */
  longMarketValue: number | null;
}

/** Tradier returns `T | T[]` depending on result count; sometimes `null`/empty string when none. */
function asArray<T>(value: T | T[] | undefined | null | string): T[] {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  return [value as T];
}

/**
 * TRA-348 — `/accounts/{id}/history` envelope. Tradier returns
 * `history: 'null'`/empty when the account has no events in the window,
 * a single `event` object when there's one, or an array. We only consume
 * `trade` events with their nested `trade` leg.
 *
 * Reference: https://documentation.tradier.com/brokerage-api/accounts/get-account-history
 */
interface TradierHistoryEnvelope {
  history?: { event?: TradierRawHistoryEvent | TradierRawHistoryEvent[] } | string | null;
}

interface TradierRawHistoryEvent {
  date?: string;
  amount?: number;
  type?: string;
  /** Tradier surfaces a per-event id we can use as a dedup key across runs. */
  id?: string | number;
  trade?: {
    commission?: number;
    description?: string;
    price?: number;
    quantity?: number;
    symbol?: string;
    /** `option`/`Option` for option legs, `equity`/`Equity` for stock legs. */
    trade_type?: string;
  };
}

/**
 * TRA-359 — non-trade Tradier history event (ACH / wire / journal /
 * deposit / withdrawal / dividend / interest / adjustment). Used by the
 * Live calendar reconcile pass to subtract real cash flow from the daily
 * balance delta so deposits aren't booked as trading P&L.
 */
export interface TradierCashEvent {
  /** `YYYY-MM-DD` event date as Tradier reports it (account TZ). */
  date: string;
  /** Lowercase event type (`ach`, `wire`, `journal`, `dividend`, etc.). */
  type: string;
  /**
   * Signed cash flow into the account. Positive for deposits / credits,
   * negative for withdrawals / debits. Tradier reports `amount` as the
   * net change to the account balance.
   */
  amount: number;
  /**
   * Stable dedup id (Tradier `id` when surfaced, else a synthetic
   * `date|type|amount` key). Used so a re-fetch over the same window
   * doesn't double-count a deposit.
   */
  transactionId: string;
}

/**
 * TRA-348 — normalised Tradier history trade event. Combines the top-level
 * event metadata with the nested `trade` leg into one row the EOD
 * reconcile pass can consume. Includes both opens (Buy to Open) and
 * closes (Sell to Close); the reconcile pass filters by `description`.
 */
export interface TradierTradeHistoryFill {
  /** `YYYY-MM-DD` event date as Tradier reports it (account TZ). */
  date: string;
  /** Underlying ticker for equities; OCC option symbol for option legs. */
  symbol: string;
  tradeType: 'option' | 'equity';
  /** Raw `description` field — `"Sell to Close 2 SPY..."` etc. */
  description: string;
  /** Per-share / per-contract fill price. */
  price: number;
  /** Contracts (options) or shares (equities). Always positive. */
  quantity: number;
  /**
   * Net cash impact of the fill (Tradier convention: negative for buys /
   * opens, positive for sells / closes). Already includes commissions;
   * we expose `commission` separately so callers can recompute gross.
   */
  amount: number;
  commission: number;
  /**
   * Stable id Tradier emits per event. Used as the dedup key across
   * runs so a re-fetch over the same window doesn't double-count.
   * Falls back to a synthetic key (date+symbol+qty+price) when Tradier
   * doesn't surface an id for the event type.
   */
  transactionId: string;
}

export class TradierOptionsClient extends TradierOrderClient {
  constructor(apiToken: string, accountId: string, env: TradierEnv = 'sandbox') {
    super(apiToken, accountId, env);
  }

  private async getJson<T>(path: string): Promise<T | null> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: this.headers.Authorization, Accept: 'application/json' },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  }

  /** List option expirations for a symbol (YYYY-MM-DD strings, ascending). */
  async getExpirations(underlyingSymbol: string): Promise<string[]> {
    const data = await this.getJson<TradierExpirationsEnvelope>(
      `/markets/options/expirations?symbol=${encodeURIComponent(underlyingSymbol)}`,
    );
    if (!data || typeof data.expirations !== 'object' || data.expirations == null) return [];
    return asArray(data.expirations.date).filter((d): d is string => typeof d === 'string');
  }

  /** Fetch the full options chain for an expiration. */
  async getChain(
    underlyingSymbol: string,
    expiration: string,
    greeks = false,
  ): Promise<TradierOptionsContract[]> {
    const params = new URLSearchParams({
      symbol: underlyingSymbol,
      expiration,
      greeks: greeks ? 'true' : 'false',
    });
    const data = await this.getJson<TradierChainEnvelope>(`/markets/options/chains?${params}`);
    if (!data || typeof data.options !== 'object' || data.options == null) return [];
    return asArray(data.options.option).map((o) => ({
      symbol: o.symbol,
      optionSymbol: o.symbol,
      underlying: o.underlying,
      description: o.description,
      option_type: o.option_type,
      strike: o.strike,
      expiration_date: o.expiration_date,
      expiration_type: o.expiration_type,
    }));
  }

  /**
   * Fetch the chain with greeks/quotes and project it into the shape the OTM
   * mispricing scanner expects (TRA-158). Forces `greeks=true` so `mid_iv`
   * and `smv_vol` are populated when available.
   */
  async getChainSnapshot(
    underlyingSymbol: string,
    expiration: string,
  ): Promise<OptionChainRow[]> {
    const params = new URLSearchParams({
      symbol: underlyingSymbol,
      expiration,
      greeks: 'true',
    });
    const data = await this.getJson<TradierChainEnvelope>(`/markets/options/chains?${params}`);
    if (!data || typeof data.options !== 'object' || data.options == null) return [];
    return asArray(data.options.option).map((o) => ({
      optionSymbol: o.symbol,
      underlying: o.underlying,
      optionType: o.option_type,
      strike: o.strike,
      expiration: o.expiration_date,
      bid: typeof o.bid === 'number' ? o.bid : undefined,
      ask: typeof o.ask === 'number' ? o.ask : undefined,
      last: typeof o.last === 'number' ? o.last : undefined,
      volume: typeof o.volume === 'number' ? o.volume : undefined,
      openInterest: typeof o.open_interest === 'number' ? o.open_interest : undefined,
      midIv: o.greeks?.mid_iv && o.greeks.mid_iv > 0 ? o.greeks.mid_iv : undefined,
      smvVol: o.greeks?.smv_vol && o.greeks.smv_vol > 0 ? o.greeks.smv_vol : undefined,
    }));
  }

  /** Find the nearest ATM contract expiring 2-5 weeks out (matches Alpaca client window). */
  async findATMContract(
    underlyingSymbol: string,
    optionType: OptionType,
    currentPrice: number,
  ): Promise<TradierOptionsContract | null> {
    const today = new Date();
    const minExpMs = today.getTime() + 14 * 24 * 60 * 60 * 1000;
    const maxExpMs = today.getTime() + 35 * 24 * 60 * 60 * 1000;

    const expirations = await this.getExpirations(underlyingSymbol);
    const inWindow = expirations.filter((d) => {
      const t = Date.parse(`${d}T00:00:00Z`);
      return Number.isFinite(t) && t >= minExpMs && t <= maxExpMs;
    });
    if (inWindow.length === 0) return null;

    // Closest expiration to the start of the window — same bias as Alpaca's lower bound.
    inWindow.sort((a, b) => Date.parse(a) - Date.parse(b));
    const expiration = inWindow[0];

    const chain = await this.getChain(underlyingSymbol, expiration);
    const matching = chain.filter((c) => c.option_type === optionType);
    if (matching.length === 0) return null;

    return matching.reduce((best, c) => {
      const bestDiff = Math.abs(best.strike - currentPrice);
      const cDiff = Math.abs(c.strike - currentPrice);
      return cDiff < bestDiff ? c : best;
    });
  }

  /** Get current mid price for an option contract via /markets/quotes. */
  async getOptionMid(optionSymbol: string): Promise<number | null> {
    const data = await this.getJson<TradierQuotesEnvelope>(
      `/markets/quotes?symbols=${encodeURIComponent(optionSymbol)}`,
    );
    if (!data || typeof data.quotes !== 'object' || data.quotes == null) return null;
    const [quote] = asArray(data.quotes.quote);
    if (!quote) return null;

    if (typeof quote.bid === 'number' && typeof quote.ask === 'number' && quote.bid > 0 && quote.ask > 0) {
      return (quote.bid + quote.ask) / 2;
    }
    return typeof quote.last === 'number' && quote.last > 0 ? quote.last : null;
  }

  /**
   * TRA-352 — single-symbol quote with bid / ask / last preserved separately
   * so callers can decide how to react when only one side is populated (e.g.
   * dead OCC contracts with a stale `last` but no live bid). Distinct from
   * {@link getOptionMid} (which collapses everything to a single price) so the
   * smart sell-to-close path can compute a midpoint with a graceful fallback
   * to `last` and a hard refusal when nothing usable is available.
   */
  async getOptionQuote(optionSymbol: string): Promise<TradierOptionQuote | null> {
    const data = await this.getJson<TradierQuotesEnvelope>(
      `/markets/quotes?symbols=${encodeURIComponent(optionSymbol)}`,
    );
    if (!data || typeof data.quotes !== 'object' || data.quotes == null) return null;
    const [quote] = asArray(data.quotes.quote);
    if (!quote) return null;
    const result: TradierOptionQuote = { symbol: quote.symbol };
    if (typeof quote.bid === 'number' && Number.isFinite(quote.bid)) result.bid = quote.bid;
    if (typeof quote.ask === 'number' && Number.isFinite(quote.ask)) result.ask = quote.ask;
    if (typeof quote.last === 'number' && Number.isFinite(quote.last)) result.last = quote.last;
    return result;
  }

  /**
   * TRA-226 — Read-only account balance for the configured Tradier account.
   * Used to reflect the user's Tradier equity/cash in the dashboard while in
   * live mode. Returns `null` when Tradier doesn't return a balances payload
   * (auth failure, network error, etc.) — the caller should keep the previous
   * snapshot rather than zeroing the display.
   */
  async getAccountBalance(): Promise<TradierAccountBalance | null> {
    const data = await this.getJson<TradierBalancesEnvelope>(
      `/accounts/${encodeURIComponent(this.accountId)}/balances`,
    );
    const b = data?.balances;
    if (!b) return null;
    const totalEquity = typeof b.total_equity === 'number' ? b.total_equity : NaN;
    const totalCash = typeof b.total_cash === 'number' ? b.total_cash : NaN;
    if (!Number.isFinite(totalEquity) || !Number.isFinite(totalCash)) return null;
    // TRA-319 — read option buying power from whichever sub-envelope the
    // account type uses. Margin / PDT accounts expose it directly; cash
    // accounts only have `cash.cash_available`. We prefer the explicit
    // option_buying_power when present, fall back to cash_available, and
    // signal `null` when nothing is available so the caller knows to skip
    // the pre-check rather than gate on a stale value.
    const obpRaw =
      b.margin?.option_buying_power
      ?? b.pdt?.option_buying_power
      ?? b.cash?.cash_available;
    const optionBuyingPower = typeof obpRaw === 'number' && Number.isFinite(obpRaw) ? obpRaw : null;
    // TRA-335 — same precedence for stock buying power so live equity sizing
    // can cap against the broker's actual buying power instead of assuming
    // cash-only accounts. Cash accounts share `cash_available` between
    // option and stock buying power.
    const sbpRaw =
      b.margin?.stock_buying_power
      ?? b.pdt?.stock_buying_power
      ?? b.cash?.cash_available;
    const stockBuyingPower = typeof sbpRaw === 'number' && Number.isFinite(sbpRaw) ? sbpRaw : null;
    const lmvRaw = b.long_market_value;
    const longMarketValue = typeof lmvRaw === 'number' && Number.isFinite(lmvRaw) ? lmvRaw : null;
    return { totalEquity, totalCash, optionBuyingPower, stockBuyingPower, longMarketValue };
  }

  /**
   * TRA-323 — list open option positions held in the configured Tradier
   * account. Used by the server-side reconcile path to import positions
   * that were opened directly on Tradier (e.g. on the broker's web UI in
   * Sandbox) into the local TradeAI options store so the user can close
   * them from TradeAI's own Open Options view. Returns `[]` when Tradier
   * has no positions or when the request fails — we'd rather show "no
   * synced positions" than poison the local store with a stale list.
   *
   * Equity positions held in the same account are dropped at the parser
   * because the existing close path only routes options orders through
   * `sell_to_close`. A future ticket can extend this to equities if the
   * Sandbox account ever holds stocks.
   */
  async listOpenOptionPositions(): Promise<TradierOpenOptionPosition[]> {
    const data = await this.getJson<TradierPositionsEnvelope>(
      `/accounts/${encodeURIComponent(this.accountId)}/positions`,
    );
    return parseTradierPositions(data);
  }

  /**
   * TRA-348 — list trade history events for the configured account between
   * `start` and `end` (`YYYY-MM-DD`, inclusive). Returns the normalized
   * trade-leg fills only — non-trade events (journal, dividend, ACH,
   * adjustment) are dropped at the parser. The EOD reconcile pass uses
   * this to merge real Tradier-side closes into `reports/live/<date>.json`
   * even when the engine never processed the close (manual close on
   * Tradier's web UI, or a `sell_to_close` that resolved after the
   * 5-second wait window).
   *
   * Tradier's `/accounts/{id}/history` is paginated via `?limit` /
   * `?page`, but the daily reconcile window is small enough (one calendar
   * day per call) that the default page size is enough; callers asking
   * for a wider window pass an explicit `limit`. Returns `[]` on auth /
   * network failures so the caller can fall back to engine-only P&L
   * rather than poison the daily report with a half-merged total.
   */
  async listAccountHistory(
    options: { start: string; end: string; limit?: number; type?: string } = {
      start: '',
      end: '',
    },
  ): Promise<TradierTradeHistoryFill[]> {
    const params = new URLSearchParams();
    if (options.start) params.set('start', options.start);
    if (options.end) params.set('end', options.end);
    if (options.type) params.set('type', options.type);
    params.set('limit', String(options.limit ?? 250));
    const data = await this.getJson<TradierHistoryEnvelope>(
      `/accounts/${encodeURIComponent(this.accountId)}/history?${params}`,
    );
    return parseTradierHistory(data);
  }

  /**
   * TRA-359 — list non-trade Tradier history events between `start` and
   * `end` (inclusive). Returns deposits / withdrawals / journals /
   * dividends / interest / adjustments — anything that moves the account
   * balance independently of trading. Used by the Live calendar
   * reconcile pass so today's net deposit isn't booked as P&L.
   *
   * Tradier's history endpoint does not accept multiple `type` filters
   * in a single call, so we fetch the whole window (no `type` filter)
   * and route trade vs. non-trade events through their respective
   * parsers. Returns `[]` on auth / network failures rather than poison
   * the calendar with a half-merged cash flow.
   */
  async listAccountCashEvents(
    options: { start: string; end: string; limit?: number } = { start: '', end: '' },
  ): Promise<TradierCashEvent[]> {
    const params = new URLSearchParams();
    if (options.start) params.set('start', options.start);
    if (options.end) params.set('end', options.end);
    params.set('limit', String(options.limit ?? 250));
    const data = await this.getJson<TradierHistoryEnvelope>(
      `/accounts/${encodeURIComponent(this.accountId)}/history?${params}`,
    );
    return parseTradierCashEvents(data);
  }

  /** Submit a market order to buy option contracts (open). */
  async buyContracts(optionSymbol: string, qty: number): Promise<TradierOrderResponse> {
    return this.postOrder(this.optionOrderBody(optionSymbol, qty, 'buy_to_open'));
  }

  /** Submit a market order to sell (close) option contracts. */
  async sellContracts(optionSymbol: string, qty: number): Promise<TradierOrderResponse> {
    return this.postOrder(this.optionOrderBody(optionSymbol, qty, 'sell_to_close'));
  }

  /**
   * TRA-352 — submit a limit `sell_to_close` order. Used by the smart-close
   * path that pulls a fresh bid/ask, computes a midpoint, and walks the price
   * toward the bid if the first attempt doesn't fill. `limitPrice` is rounded
   * to the nearest cent before submission because Tradier rejects sub-cent
   * limit prices on equity options.
   *
   * TRA-354 — also used by the engine-fired exit mirror (TP1 partial / SL /
   * trailing) to submit a wait-and-hold LIMIT at the trigger price; the
   * paper book stays open until the resulting order id reaches `filled` on
   * a subsequent tick.
   */
  async sellContractsLimit(
    optionSymbol: string,
    qty: number,
    limitPrice: number,
  ): Promise<TradierOrderResponse> {
    return this.postOrder(
      this.optionOrderBody(optionSymbol, qty, 'sell_to_close', { type: 'limit', price: limitPrice }),
    );
  }

  private optionOrderBody(
    optionSymbol: string,
    qty: number,
    side: 'buy_to_open' | 'sell_to_close',
    /**
     * TRA-352 — when omitted, defaults to a `market` order (legacy behaviour
     * for the buy_to_open mirror). When provided, submits a `limit` order
     * with the rounded price. We keep market as the default so existing
     * call-sites that don't care about smart pricing don't have to thread an
     * extra parameter.
     */
    pricing?: { type: 'limit'; price: number },
  ): URLSearchParams {
    const params: Record<string, string> = {
      class: 'option',
      symbol: underlyingFromOcc(optionSymbol),
      option_symbol: optionSymbol,
      side,
      quantity: String(qty),
      duration: 'day',
    };
    if (pricing?.type === 'limit') {
      params['type'] = 'limit';
      params['price'] = roundToCent(pricing.price).toFixed(2);
    } else {
      params['type'] = 'market';
    }
    return new URLSearchParams(params);
  }
}

/**
 * TRA-352 — round to the nearest cent for Tradier limit-order prices. Tradier
 * rejects sub-cent prices on equity options. Exported so the smart-close
 * helper can match the on-wire price when reporting back to callers.
 */
export function roundToCent(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Tradier's `/accounts/{id}/orders` endpoint requires both the underlying `symbol` and the
 * `option_symbol`. OCC symbols are `[A-Z]{1-6}YYMMDD[CP]\d{8}`, so the underlying is the
 * leading run of letters.
 */
export function underlyingFromOcc(occ: string): string {
  const match = /^([A-Z]+)/.exec(occ);
  return match ? match[1] : occ;
}

/**
 * TRA-323 — decode an OCC option symbol into its components, or return
 * `null` when the symbol isn't an OCC option (i.e. an equity ticker on
 * the same Tradier account, which we drop at the parser).
 */
export function parseOccSymbol(occ: string): {
  underlying: string;
  optionType: 'call' | 'put';
  strike: number;
  expiration: string;
} | null {
  // OCC: ROOT (1-6 chars) + YYMMDD + C/P + 8 digit strike (in thousandths of $).
  const match = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ);
  if (!match) return null;
  const [, underlying, yy, mm, dd, cp, strikeRaw] = match;
  const yearNum = Number(yy);
  if (!Number.isFinite(yearNum)) return null;
  // OCC year is 2-digit. Tradier symbols generated post-2000 — pivoting on
  // 1970 keeps it future-proof for ~50 years.
  const year = yearNum >= 70 ? 1900 + yearNum : 2000 + yearNum;
  const expiration = `${year.toString().padStart(4, '0')}-${mm}-${dd}`;
  const strike = Number(strikeRaw) / 1000;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    underlying,
    optionType: cp === 'C' ? 'call' : 'put',
    strike,
    expiration,
  };
}

/**
 * TRA-348 — normalise the Tradier `/accounts/{id}/history` envelope into
 * a list of trade-leg fills. Exported so the EOD reconcile pass can be
 * unit-tested without mocking `fetch`. Drops non-trade events (journal,
 * dividend, ACH, adjustment) and rows whose required fields can't be
 * coerced — we'd rather omit a row than corrupt the calendar with garbage.
 */
export function parseTradierHistory(
  envelope: TradierHistoryEnvelope | null,
): TradierTradeHistoryFill[] {
  if (!envelope || typeof envelope.history !== 'object' || envelope.history == null) {
    return [];
  }
  const out: TradierTradeHistoryFill[] = [];
  for (const raw of asArray(envelope.history.event)) {
    if (typeof raw.type !== 'string' || raw.type.toLowerCase() !== 'trade') continue;
    const trade = raw.trade;
    if (!trade) continue;
    const tradeTypeRaw = typeof trade.trade_type === 'string' ? trade.trade_type.toLowerCase() : '';
    const tradeType: 'option' | 'equity' | null =
      tradeTypeRaw === 'option' ? 'option'
      : tradeTypeRaw === 'equity' ? 'equity'
      : null;
    if (!tradeType) continue;
    const date = typeof raw.date === 'string' ? raw.date.slice(0, 10) : '';
    const symbol = typeof trade.symbol === 'string' ? trade.symbol : '';
    if (!date || !symbol) continue;
    const price = typeof trade.price === 'number' && Number.isFinite(trade.price) ? trade.price : NaN;
    const quantity = typeof trade.quantity === 'number' && Number.isFinite(trade.quantity)
      ? Math.abs(trade.quantity)
      : NaN;
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) continue;
    const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) ? raw.amount : 0;
    const commission = typeof trade.commission === 'number' && Number.isFinite(trade.commission)
      ? trade.commission
      : 0;
    const description = typeof trade.description === 'string' ? trade.description : '';
    const transactionId =
      raw.id != null ? String(raw.id)
      : `${date}|${symbol}|${tradeType}|${quantity}|${price}|${description}`;
    out.push({
      date,
      symbol,
      tradeType,
      description,
      price,
      quantity,
      amount,
      commission,
      transactionId,
    });
  }
  return out;
}

/**
 * TRA-359 — set of Tradier event types that move the account balance
 * independently of trading. Used to discriminate cash flow from trade
 * P&L when reconciling the Live calendar against the broker balance.
 *
 * Sourced from Tradier's documented event types
 * (https://documentation.tradier.com/brokerage-api/accounts/get-account-history).
 * Keep lowercase — `parseTradierCashEvents` compares case-insensitively.
 */
const TRADIER_CASH_EVENT_TYPES = new Set<string>([
  'ach',
  'wire',
  'check',
  'journal',
  'dividend',
  'interest',
  'adjustment',
  'fee',
  'deposit',
  'withdrawal',
]);

/**
 * TRA-359 — normalise the Tradier `/accounts/{id}/history` envelope into
 * a list of cash flow events (deposits, withdrawals, journals, dividends,
 * interest, fees, adjustments). Drops `trade` rows (those go through
 * {@link parseTradierHistory}) and any row whose `amount` isn't a finite
 * number — we'd rather omit a row than corrupt the daily P&L override
 * with a NaN.
 */
export function parseTradierCashEvents(
  envelope: TradierHistoryEnvelope | null,
): TradierCashEvent[] {
  if (!envelope || typeof envelope.history !== 'object' || envelope.history == null) {
    return [];
  }
  const out: TradierCashEvent[] = [];
  for (const raw of asArray(envelope.history.event)) {
    if (typeof raw.type !== 'string') continue;
    const type = raw.type.toLowerCase();
    if (!TRADIER_CASH_EVENT_TYPES.has(type)) continue;
    const date = typeof raw.date === 'string' ? raw.date.slice(0, 10) : '';
    if (!date) continue;
    const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) ? raw.amount : NaN;
    if (!Number.isFinite(amount)) continue;
    const transactionId =
      raw.id != null ? String(raw.id)
      : `${date}|${type}|${amount}`;
    out.push({ date, type, amount, transactionId });
  }
  return out;
}

/**
 * TRA-323 — normalise the Tradier `/accounts/{id}/positions` envelope into
 * a list of open option positions. Exported so unit tests can exercise the
 * parser without mocking `fetch`. Drops equity positions, short option
 * legs, and any row whose OCC symbol or quantity / cost basis can't be
 * parsed — we'd rather omit a row than display garbage in the UI.
 */
export function parseTradierPositions(
  envelope: TradierPositionsEnvelope | null,
): TradierOpenOptionPosition[] {
  if (!envelope || typeof envelope.positions !== 'object' || envelope.positions == null) {
    return [];
  }
  const out: TradierOpenOptionPosition[] = [];
  for (const raw of asArray(envelope.positions.position)) {
    if (typeof raw.symbol !== 'string') continue;
    if (typeof raw.quantity !== 'number' || !Number.isFinite(raw.quantity) || raw.quantity <= 0) {
      // Drop short legs (negative quantity) and zero rows. The existing
      // close path only supports `sell_to_close` for long options.
      continue;
    }
    const occ = parseOccSymbol(raw.symbol);
    if (!occ) continue;
    if (typeof raw.cost_basis !== 'number' || !Number.isFinite(raw.cost_basis) || raw.cost_basis <= 0) {
      continue;
    }
    const premiumPaid = raw.cost_basis / raw.quantity / 100;
    if (!Number.isFinite(premiumPaid) || premiumPaid <= 0) continue;
    const acquiredMs = Date.parse(`${raw.date_acquired}`);
    out.push({
      optionSymbol: raw.symbol,
      underlying: occ.underlying,
      optionType: occ.optionType,
      strike: occ.strike,
      expiration: occ.expiration,
      contracts: raw.quantity,
      premiumPaid,
      acquiredAt: Number.isFinite(acquiredMs) ? acquiredMs : Date.now(),
      ...(typeof raw.id === 'number' ? { tradierPositionId: raw.id } : {}),
    });
  }
  return out;
}
