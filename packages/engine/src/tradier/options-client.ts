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

interface TradierBalancesEnvelope {
  balances?: {
    account_number?: string;
    account_type?: string;
    total_equity?: number;
    total_cash?: number;
    open_pl?: number;
  } | null;
}

/** TRA-226 — read-only Tradier account balance snapshot. */
export interface TradierAccountBalance {
  totalEquity: number;
  totalCash: number;
}

/** Tradier returns `T | T[]` depending on result count; sometimes `null`/empty string when none. */
function asArray<T>(value: T | T[] | undefined | null | string): T[] {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  return [value as T];
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
    return { totalEquity, totalCash };
  }

  /** Submit a market order to buy option contracts (open). */
  async buyContracts(optionSymbol: string, qty: number): Promise<TradierOrderResponse> {
    return this.postOrder(this.optionOrderBody(optionSymbol, qty, 'buy_to_open'));
  }

  /** Submit a market order to sell (close) option contracts. */
  async sellContracts(optionSymbol: string, qty: number): Promise<TradierOrderResponse> {
    return this.postOrder(this.optionOrderBody(optionSymbol, qty, 'sell_to_close'));
  }

  private optionOrderBody(
    optionSymbol: string,
    qty: number,
    side: 'buy_to_open' | 'sell_to_close',
  ): URLSearchParams {
    return new URLSearchParams({
      class: 'option',
      symbol: underlyingFromOcc(optionSymbol),
      option_symbol: optionSymbol,
      side,
      quantity: String(qty),
      type: 'market',
      duration: 'day',
    });
  }
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
