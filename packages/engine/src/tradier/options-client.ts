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
    return { totalEquity, totalCash, optionBuyingPower };
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
