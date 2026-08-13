import type { OptionType, TradierOrderDuration } from '@trading-app/shared';
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
  /**
   * TRA-2045 — quote timestamp (ms epoch) parsed from Tradier `trade_date`,
   * when present. Feeds the order-time stale-quote gate on the smart-open path.
   * Optional: an option quote that omits the field can't be freshness-proven.
   */
  quoteTimeMs?: number;
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
  // TRA-2045 — quote timestamp (ms epoch) surfaced by Tradier `/markets/quotes`.
  trade_date?: number;
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
 * TRA-3067 — a positions read that kept its failure state. See
 * {@link TradierOptionsClient.readOpenOptionPositions}. `ok: false` is NOT an
 * empty book, and no consumer may treat it as one.
 */
export type TradierPositionsRead =
  | { ok: true; positions: TradierOpenOptionPosition[] }
  | { ok: false; reason: 'http_status' | 'transport' | 'malformed'; detail: string };

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
    /**
     * TRA-725 — Tradier's per-asset-class market values, surfaced top-level on
     * the balances payload (alongside `long_market_value`). The Stocks
     * dashboard account card mirrors these as "Long Stock Value", "Long Option
     * Value", and "Short Option Value" to match Tradier's own account panel.
     */
    stock_long_value?: number;
    option_long_value?: number;
    option_short_value?: number;
    /**
     * TRA-319 — margin accounts surface option buying power under `margin`.
     * TRA-483 — `day_trade_buying_power` is the PDT day-trading limit (rolling
     * 5-day window). Tradier returns this on margin accounts flagged PDT.
     */
    margin?: {
      option_buying_power?: number;
      stock_buying_power?: number;
      day_trade_buying_power?: number;
    } | null;
    /**
     * TRA-319 — pattern-day-trader accounts surface it under `pdt`.
     * TRA-483 — `day_trade_buying_power` is the actionable day-trade limit
     * for these accounts; once it hits $0 Tradier rejects every same-day
     * close even with positive `option_buying_power`.
     */
    pdt?: {
      option_buying_power?: number;
      stock_buying_power?: number;
      day_trade_buying_power?: number;
    } | null;
    /**
     * TRA-319 — cash accounts only have `cash.cash_available`.
     * TRA-725 — `unsettled_funds` is the portion of cash not yet settled;
     * settled funds = `total_cash − unsettled_funds`. Tradier nests this under
     * `cash` for cash accounts.
     */
    cash?: {
      cash_available?: number;
      unsettled_funds?: number;
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
  /**
   * TRA-483 — pattern-day-trader day-trading buying power. Tradier reports
   * this on margin / PDT accounts; cash accounts don't carry it. When it
   * drops to $0 the broker rejects same-day option round trips even though
   * `optionBuyingPower` may still be positive — which is the exact failure
   * mode the issue captured (option BP looked fine but trades stopped
   * opening). `null` when Tradier didn't surface the field; the live
   * pre-check skips the DTBP gate in that case and stays permissive.
   */
  dayTradeBuyingPower: number | null;
  /**
   * TRA-724 — broker account classification, used to gate live equity short
   * (sell-to-open) entries. Cash (non-marginable) accounts cannot sell short,
   * so a short equity bracket on one is guaranteed to be rejected. Tradier
   * surfaces this directly as `balances.account_type` ('cash' | 'margin' |
   * 'pdt'); when that field is absent we infer it from which sub-envelope is
   * present (`margin`/`pdt` ⇒ marginable, only `cash` ⇒ cash). `null` when
   * neither is determinable — callers stay permissive and let the broker be
   * the final word. Optional so existing balance literals/fixtures that
   * predate the field keep compiling.
   */
  accountType?: 'cash' | 'margin' | 'pdt' | null;
  /**
   * TRA-725 — settled funds = `total_cash − cash.unsettled_funds`. Tradier's
   * account panel shows this as both "Settled Funds" and "Settled Cash". Only
   * cash accounts carry `unsettled_funds`; `null` when Tradier didn't surface
   * it (margin/PDT accounts, or a payload that predates the field). Optional so
   * existing balance literals/fixtures keep compiling.
   */
  settledFunds?: number | null;
  /**
   * TRA-725 — Tradier `stock_long_value`: dollar value of long stock positions.
   * `null` when absent. Mirrors "Long Stock Value" on the dashboard card.
   */
  stockLongValue?: number | null;
  /**
   * TRA-725 — Tradier `option_long_value`: dollar value of long option
   * positions. `null` when absent. Mirrors "Long Option Value".
   */
  optionLongValue?: number | null;
  /**
   * TRA-725 — Tradier `option_short_value`: dollar value of short option
   * positions. `null` when absent. Mirrors "Short Option Value".
   */
  optionShortValue?: number | null;
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
    /** Tradier order id — present on production history fills; absent on sandbox. */
    order_id?: number;
  };
  /**
   * TRA-2876 — Tradier nests each event's leg under a key named after the event
   * `type` (`trade` → `trade`, `adjustment` → `adjustment`, `journal` →
   * `journal`, …), so the set of keys on this row is open-ended by design.
   * {@link parseTradierCorporateActions} reads those legs generically; the
   * declared members above stay authoritative for the ones we model by name.
   */
  [nestedLeg: string]: unknown;
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
  /**
   * Tradier order id from `trade.order_id`. Present on production fills;
   * absent (null) on sandbox or when Tradier omits it. Use as the
   * primary join key for commission back-fill when available (TRA-2810).
   */
  orderId: number | null;
}

/**
 * TRA-2850 — `/accounts/{id}/gainloss` envelope. Same normalisation quirks as
 * history/positions: `gainloss: 'null'`/empty when the account has no closed
 * lots in the window, a single `closed_position` object when there's one, or
 * an array.
 */
interface TradierGainLossEnvelope {
  gainloss?: { closed_position?: TradierRawClosedPosition | TradierRawClosedPosition[] } | string | null;
}

interface TradierRawClosedPosition {
  symbol?: string;
  quantity?: number;
  cost?: number;
  proceeds?: number;
  gain_loss?: number;
  open_date?: string;
  close_date?: string;
  term?: number;
}

/**
 * TRA-2850 — one settled closed lot from Tradier's gain/loss report. This is
 * the ONLY payload where Tradier's real per-trade fees are observable:
 * account-history rows carry `commission: 0` on every production fill (the
 * exchange/regulatory fees are baked into cost/proceeds, not itemised), so
 * `cost − grossOpen` and `grossClose − proceeds` are the fees themselves.
 * `cost` and `proceeds` are lot totals in USD (fees included); `quantity` is
 * contracts for options, shares for equities, always positive.
 */
export interface TradierGainLossLot {
  /** OCC option symbol for option lots; underlying ticker for equities. */
  symbol: string;
  /** Contracts (options) or shares (equities). Always positive. */
  quantity: number;
  /** Total cost basis of the lot, USD, INCLUDING open-side fees. */
  cost: number;
  /** Total net proceeds of the lot, USD, NET of close-side fees. */
  proceeds: number;
  /** `proceeds − cost` as Tradier reports it. */
  gainLoss: number;
  /** `YYYY-MM-DD` the lot was opened. */
  openDate: string;
  /** `YYYY-MM-DD` the lot was closed. */
  closeDate: string;
}

/**
 * TRA-2850 — normalise the Tradier `/accounts/{id}/gainloss` envelope into a
 * list of settled closed lots. Exported so the fee back-fill reconcile can be
 * unit-tested without mocking `fetch`. Rows missing a coercible symbol /
 * quantity / cost / proceeds / dates are dropped — we'd rather omit a lot
 * than derive a garbage fee from it.
 */
export function parseTradierGainLoss(
  envelope: TradierGainLossEnvelope | null,
): TradierGainLossLot[] {
  if (!envelope || typeof envelope.gainloss !== 'object' || envelope.gainloss == null) {
    return [];
  }
  const out: TradierGainLossLot[] = [];
  for (const raw of asArray(envelope.gainloss.closed_position)) {
    const symbol = typeof raw.symbol === 'string' ? raw.symbol : '';
    const openDate = typeof raw.open_date === 'string' ? raw.open_date.slice(0, 10) : '';
    const closeDate = typeof raw.close_date === 'string' ? raw.close_date.slice(0, 10) : '';
    if (!symbol || !openDate || !closeDate) continue;
    const quantity = typeof raw.quantity === 'number' && Number.isFinite(raw.quantity)
      ? Math.abs(raw.quantity)
      : NaN;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    if (typeof raw.cost !== 'number' || !Number.isFinite(raw.cost)) continue;
    if (typeof raw.proceeds !== 'number' || !Number.isFinite(raw.proceeds)) continue;
    const gainLoss = typeof raw.gain_loss === 'number' && Number.isFinite(raw.gain_loss)
      ? raw.gain_loss
      : raw.proceeds - raw.cost;
    out.push({
      symbol,
      quantity,
      cost: raw.cost,
      proceeds: raw.proceeds,
      gainLoss,
      openDate,
      closeDate,
    });
  }
  return out;
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
    // TRA-2045 — carry the broker quote timestamp when present (finite, > 0).
    if (typeof quote.trade_date === 'number' && Number.isFinite(quote.trade_date) && quote.trade_date > 0) {
      result.quoteTimeMs = quote.trade_date;
    }
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
    // TRA-483 — surface day_trade_buying_power so the live engine can refuse
    // to open same-day round trips when the broker's DTBP is exhausted. Only
    // margin / PDT accounts carry it; cash accounts get `null`.
    const dtbpRaw =
      b.margin?.day_trade_buying_power
      ?? b.pdt?.day_trade_buying_power;
    const dayTradeBuyingPower =
      typeof dtbpRaw === 'number' && Number.isFinite(dtbpRaw) ? dtbpRaw : null;
    // TRA-724 — classify the account so the live engine can refuse shorts on
    // cash (non-marginable) accounts. Prefer Tradier's explicit `account_type`;
    // when it's missing, infer from which buying-power sub-envelope is present
    // (margin/pdt ⇒ marginable, only cash ⇒ cash). `null` when indeterminate.
    const rawType =
      typeof b.account_type === 'string' ? b.account_type.trim().toLowerCase() : null;
    let accountType: 'cash' | 'margin' | 'pdt' | null;
    if (rawType === 'cash' || rawType === 'margin' || rawType === 'pdt') {
      accountType = rawType;
    } else if (b.margin) {
      accountType = 'margin';
    } else if (b.pdt) {
      accountType = 'pdt';
    } else if (b.cash) {
      accountType = 'cash';
    } else {
      accountType = null;
    }
    // TRA-725 — mirror Tradier's account panel. Settled funds = total_cash −
    // unsettled_funds; only cash accounts carry `unsettled_funds`, so `null`
    // (not 0) when absent so the card can degrade gracefully instead of
    // implying everything is settled. The per-asset-class market values are
    // surfaced verbatim.
    const unsettledRaw = b.cash?.unsettled_funds;
    const settledFunds =
      typeof unsettledRaw === 'number' && Number.isFinite(unsettledRaw)
        ? totalCash - unsettledRaw
        : null;
    const num = (v: number | undefined): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    return {
      totalEquity,
      totalCash,
      optionBuyingPower,
      stockBuyingPower,
      longMarketValue,
      dayTradeBuyingPower,
      accountType,
      settledFunds,
      stockLongValue: num(b.stock_long_value),
      optionLongValue: num(b.option_long_value),
      optionShortValue: num(b.option_short_value),
    };
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
   * TRA-3067 — the same read, with its FAILURE STATE INTACT.
   *
   * {@link listOpenOptionPositions} returns `[]` for both "the account holds
   * nothing" and "the request failed": `getJson` maps every non-2xx to `null`
   * and `parseTradierPositions(null)` is `[]`. That is deliberate there — the
   * reconcile would rather show "no synced positions" than poison the local
   * store — but it means the value has **no absence state**, and an instrument
   * built on it reads a 401 as "the broker is flat on everything", which is the
   * maximally alarming reading of an unreadable broker.
   *
   * The out-of-band-close detector needs the distinction, so this variant keeps
   * it. It does NOT replace the method above and changes no existing caller.
   *
   * `ok: true` with `positions: []` is a REAL empty book — Tradier answers 2xx
   * with the literal string `positions: "null"` for an account holding nothing,
   * and that is the only 2xx shape mapped to an empty success. A 2xx envelope
   * with no `positions` key at all is `malformed`, because we cannot tell what
   * it was trying to say.
   */
  async readOpenOptionPositions(): Promise<TradierPositionsRead> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/positions`,
        { headers: { Authorization: this.headers.Authorization, Accept: 'application/json' } },
      );
    } catch (err: unknown) {
      return { ok: false, reason: 'transport', detail: err instanceof Error ? err.message : String(err) };
    }
    if (!resp.ok) {
      return { ok: false, reason: 'http_status', detail: `HTTP ${resp.status}` };
    }
    let data: unknown;
    try {
      data = await resp.json();
    } catch (err: unknown) {
      return { ok: false, reason: 'transport', detail: err instanceof Error ? err.message : String(err) };
    }
    if (data == null || typeof data !== 'object') {
      return { ok: false, reason: 'malformed', detail: 'body is not an object' };
    }
    if (!('positions' in (data as Record<string, unknown>))) {
      return { ok: false, reason: 'malformed', detail: 'no positions key' };
    }
    return { ok: true, positions: parseTradierPositions(data as TradierPositionsEnvelope) };
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

  /**
   * TRA-2876 — list the non-trade history events that CHANGE A SHARE COUNT
   * (splits and other quantity adjustments) between `start` and `end`.
   *
   * Same untyped fetch as {@link listAccountCashEvents} — Tradier's history
   * endpoint takes a single `type` filter and `adjustment` is not the only
   * shape a split can arrive as — routed through
   * {@link parseTradierCorporateActions} instead. The realized-P&L backfill
   * uses this to QUARANTINE an affected symbol rather than FIFO-match its sells
   * against a lot book the corporate action already invalidated.
   *
   * Throws on auth / network failure, deliberately — and note that this is the
   * ONE history reader here that does. `getJson` returns `null` on a non-2xx,
   * and every sibling turns that into `[]`, which is the right call when the
   * cost of a blind pass is a missing row. It is the WRONG call here: the
   * caller uses this to decide whether an equity lot book is trustworthy, so
   * "no corporate actions in the window" and "we could not look" must not be
   * the same value. Silently returning `[]` on a 401 would make every blind
   * pass read as a clean bill of health and un-quarantine a split.
   */
  async listAccountCorporateActions(
    options: { start: string; end: string; limit?: number } = { start: '', end: '' },
  ): Promise<TradierCorporateAction[]> {
    const params = new URLSearchParams();
    if (options.start) params.set('start', options.start);
    if (options.end) params.set('end', options.end);
    params.set('limit', String(options.limit ?? 250));
    const data = await this.getJson<TradierHistoryEnvelope>(
      `/accounts/${encodeURIComponent(this.accountId)}/history?${params}`,
    );
    if (data == null) {
      throw new Error(
        'tradier corporate-action read failed (non-2xx); refusing to report "none" for an unread window',
      );
    }
    return parseTradierCorporateActions(data);
  }

  /**
   * TRA-2850 — list SETTLED closed lots from `/accounts/{id}/gainloss`
   * between `start` and `end` (`YYYY-MM-DD`, inclusive; Tradier filters on
   * the close date). This report is where real per-trade fees live: history
   * fills report `commission: 0` on every production row, while a lot's
   * `cost`/`proceeds` are stated fees-INCLUDED — so the fee back-fill
   * derives `fee = cost − price×100×qty` (open leg) and
   * `fee = price×100×qty − proceeds` (close leg). Returns `[]` on auth /
   * network failures so a caller can treat it as "nothing settled" rather
   * than throw into a scheduler tick.
   */
  async listGainLoss(
    options: { start: string; end: string; limit?: number } = { start: '', end: '' },
  ): Promise<TradierGainLossLot[]> {
    const params = new URLSearchParams();
    if (options.start) params.set('start', options.start);
    if (options.end) params.set('end', options.end);
    params.set('limit', String(options.limit ?? 250));
    const data = await this.getJson<TradierGainLossEnvelope>(
      `/accounts/${encodeURIComponent(this.accountId)}/gainloss?${params}`,
    );
    return parseTradierGainLoss(data);
  }

  /** Submit a market order to buy option contracts (open). */
  async buyContracts(optionSymbol: string, qty: number): Promise<TradierOrderResponse> {
    return this.postOrder(this.optionOrderBody(optionSymbol, qty, 'buy_to_open'));
  }

  /**
   * TRA-374 — submit a limit `buy_to_open` order. Counterpart to
   * {@link sellContractsLimit} for the smart-open path that walks the entry
   * limit price from `mid` toward the `ask` until it fills. `limitPrice` is
   * rounded to the nearest cent before submission because Tradier rejects
   * sub-cent limit prices on equity options.
   */
  async buyContractsLimit(
    optionSymbol: string,
    qty: number,
    limitPrice: number,
    duration: TradierOrderDuration = 'day',
  ): Promise<TradierOrderResponse> {
    return this.postOrder(
      this.optionOrderBody(optionSymbol, qty, 'buy_to_open', { type: 'limit', price: limitPrice, duration }),
    );
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
   *
   * TRA-358 — `duration` lets the user-initiated close panel pick day/gtc/
   * pre/post to mirror Tradier's web close form. Defaults to `day` so
   * existing TRA-352 / TRA-354 call sites keep their old behaviour.
   */
  async sellContractsLimit(
    optionSymbol: string,
    qty: number,
    limitPrice: number,
    duration: TradierOrderDuration = 'day',
  ): Promise<TradierOrderResponse> {
    return this.postOrder(
      this.optionOrderBody(optionSymbol, qty, 'sell_to_close', { type: 'limit', price: limitPrice, duration }),
    );
  }

  /**
   * TRA-1966 — premium-selling ("write") primitive: open a SHORT option
   * position (`sell_to_open`). This is the broker leg of a cash-secured put
   * (short put, collateral = strike × 100 × qty held in cash) or a covered
   * call (short call, collateral = 100 × qty shares of the underlying held
   * long). Tradier holds the buying-power / margin against the account
   * automatically on submission; the CALLER is responsible for guaranteeing
   * the collateral is actually cash-secured / covered before routing here.
   *
   * Guardrail: this client deliberately exposes ONLY the covered/secured
   * write. There is no naked-short helper — a naked short call has undefined
   * risk and the strategy layer must never reach for one. Assignment (put →
   * long 100 shares at strike; call → deliver 100 shares) is booked by
   * Tradier into the equity account and reconciled by the position sync; the
   * short leg is closed by {@link buyToCloseContracts} (roll / take profit).
   */
  async sellToOpenContracts(optionSymbol: string, qty: number): Promise<TradierOrderResponse> {
    return this.postOrder(this.optionOrderBody(optionSymbol, qty, 'sell_to_open'));
  }

  /**
   * TRA-1966 — limit `sell_to_open`. The premium-selling counterpart to
   * {@link buyContractsLimit}: the smart-open walk for a short write starts at
   * the mid and walks DOWN toward the bid until it fills (we want to collect
   * as much credit as possible, so we never chase below our floor). `limitPrice`
   * is rounded to the nearest cent because Tradier rejects sub-cent option
   * limit prices.
   */
  async sellToOpenContractsLimit(
    optionSymbol: string,
    qty: number,
    limitPrice: number,
    duration: TradierOrderDuration = 'day',
  ): Promise<TradierOrderResponse> {
    return this.postOrder(
      this.optionOrderBody(optionSymbol, qty, 'sell_to_open', { type: 'limit', price: limitPrice, duration }),
    );
  }

  /**
   * TRA-1966 — close a SHORT option leg (`buy_to_close`). Used to buy back a
   * cash-secured put / covered call to take profit or to roll the position to
   * a later expiration before assignment. Counterpart to
   * {@link sellToOpenContracts}.
   */
  async buyToCloseContracts(optionSymbol: string, qty: number): Promise<TradierOrderResponse> {
    return this.postOrder(this.optionOrderBody(optionSymbol, qty, 'buy_to_close'));
  }

  /**
   * TRA-1966 — limit `buy_to_close`. Roll / take-profit on a short write at a
   * capped debit; walks the limit UP toward the ask until it fills. Cent-rounded.
   */
  async buyToCloseContractsLimit(
    optionSymbol: string,
    qty: number,
    limitPrice: number,
    duration: TradierOrderDuration = 'day',
  ): Promise<TradierOrderResponse> {
    return this.postOrder(
      this.optionOrderBody(optionSymbol, qty, 'buy_to_close', { type: 'limit', price: limitPrice, duration }),
    );
  }

  private optionOrderBody(
    optionSymbol: string,
    qty: number,
    // TRA-1966 — `sell_to_open` / `buy_to_close` added for the covered-write
    // (cash-secured put / covered call) primitive alongside the original
    // long-side `buy_to_open` / `sell_to_close`.
    side: 'buy_to_open' | 'sell_to_close' | 'sell_to_open' | 'buy_to_close',
    /**
     * TRA-352 — when omitted, defaults to a `market` order (legacy behaviour
     * for the buy_to_open mirror). When provided, submits a `limit` order
     * with the rounded price. We keep market as the default so existing
     * call-sites that don't care about smart pricing don't have to thread an
     * extra parameter.
     *
     * TRA-358 — `duration` overrides the default `day` time-in-force so the
     * UI close panel can submit GTC / pre / post per the user's selection.
     */
    pricing?: { type: 'limit'; price: number; duration?: TradierOrderDuration },
  ): URLSearchParams {
    const params: Record<string, string> = {
      class: 'option',
      symbol: underlyingFromOcc(optionSymbol),
      option_symbol: optionSymbol,
      side,
      quantity: String(qty),
      duration: pricing?.duration ?? 'day',
    };
    if (pricing?.type === 'limit') {
      params['type'] = 'limit';
      params['price'] = roundToCent(pricing.price).toFixed(2);
    } else {
      params['type'] = 'market';
    }
    return new URLSearchParams(params);
  }

  /**
   * TRA-912 (TRA-908 Phase B) — submit a defined-risk MULTI-LEG options order
   * (vertical spread, iron condor, …) as a single Tradier `class=multileg`
   * ticket. This is the broker-side counterpart to the paper account's
   * {@link PaperOptionsAccount.openDefinedRiskSpread}: the selector emits a
   * structure with two or four legs (each `buy_to_open` / `sell_to_open` at
   * entry, or `buy_to_close` / `sell_to_close` at exit) and the whole combo is
   * priced as one net debit / credit so the broker fills (or rejects) it
   * atomically rather than legging in one contract at a time.
   *
   * Pricing model — Tradier `multileg` carries the net at the TOP level, not
   * per leg: `type` is `debit` (you pay), `credit` (you receive), `even`
   * (scratch) or `market`, and `price` is the absolute net per share. Per-leg
   * fields are `option_symbol[n]` / `side[n]` / `quantity[n]` only — there is
   * no per-leg `price`/`type` (contrast the OTOCO bracket, where every field is
   * per-leg). A sub-cent `price` is rounded to the nearest cent because Tradier
   * rejects sub-cent limits on equity options.
   *
   * Paper-only by construction in Phase B: the only callers are the paper
   * smart-fill helper and tests. No live-capital path invokes this yet — the
   * advisory->capital bridge is Phase C and real-chain live is gated by
   * TRA-382. The method itself is env-agnostic (the client's base URL decides
   * sandbox vs. production), so wiring it to live later needs an explicit gate,
   * not a code change here.
   */
  async submitMultilegOrder(
    underlying: string,
    legs: readonly TradierMultilegLeg[],
    pricing: TradierMultilegPricing = { type: 'market' },
  ): Promise<TradierOrderResponse> {
    return this.postOrder(this.multilegOrderBody(underlying, legs, pricing));
  }

  /**
   * TRA-912 — build the `class=multileg` order body. Exposed as a private
   * helper (unit-tested through {@link submitMultilegOrder} + a fetch mock, the
   * same way the OTOCO bracket body is). Throws on a structurally invalid order
   * (fewer than two legs, or a debit/credit with a non-positive net) BEFORE any
   * network call so a malformed combo can never reach the broker.
   */
  private multilegOrderBody(
    underlying: string,
    legs: readonly TradierMultilegLeg[],
    pricing: TradierMultilegPricing,
  ): URLSearchParams {
    if (!Array.isArray(legs) || legs.length < 2) {
      throw new Error('multileg order requires at least two legs');
    }
    const params: Record<string, string> = {
      class: 'multileg',
      symbol: underlyingFromOcc(underlying.toUpperCase()),
      type: pricing.type,
      duration: pricing.duration ?? 'day',
    };
    if (pricing.type === 'debit' || pricing.type === 'credit') {
      if (!Number.isFinite(pricing.price as number) || (pricing.price as number) <= 0) {
        throw new Error(`multileg ${pricing.type} order requires a positive net price`);
      }
      params['price'] = roundToCent(pricing.price as number).toFixed(2);
    }
    legs.forEach((leg, i) => {
      if (!Number.isFinite(leg.quantity) || leg.quantity <= 0) {
        throw new Error(`multileg leg ${i} requires a positive quantity`);
      }
      params[`option_symbol[${i}]`] = leg.optionSymbol;
      params[`side[${i}]`] = leg.side;
      params[`quantity[${i}]`] = String(leg.quantity);
    });
    return new URLSearchParams(params);
  }
}

/**
 * TRA-912 — the four option-leg sides Tradier accepts on a `multileg` ticket.
 * Entry structures use the `*_to_open` pair (a defined-risk spread always pairs
 * a long and a short leg); exits use the `*_to_close` pair to flatten them.
 */
export type TradierMultilegSide =
  | 'buy_to_open'
  | 'sell_to_open'
  | 'buy_to_close'
  | 'sell_to_close';

export interface TradierMultilegLeg {
  /** OCC option symbol for this leg. */
  optionSymbol: string;
  side: TradierMultilegSide;
  /** Contracts for this leg (per combo lot — usually 1 for a 1-wide vertical). */
  quantity: number;
}

export interface TradierMultilegPricing {
  /**
   * `debit` = net amount paid (long premium dominates), `credit` = net amount
   * received (short premium dominates), `even` = scratch, `market` = no limit
   * (used only as a last-resort; the smart-fill helper always supplies a limit).
   */
  type: 'debit' | 'credit' | 'even' | 'market';
  /** Absolute net per share. Required (and must be > 0) for `debit` / `credit`. */
  price?: number;
  /** Time in force. Defaults to `day`. */
  duration?: TradierOrderDuration;
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
    const orderId = typeof trade.order_id === 'number' && Number.isFinite(trade.order_id)
      ? trade.order_id
      : null;
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
      orderId,
    });
  }
  return out;
}

/**
 * TRA-359 — set of Tradier event types that move the account balance
 * independently of trading.
 *
 * TRA-2906 — this is the **RECORDING** set, not the classification set. Its only
 * job is "is this a non-trade balance movement worth writing down". Whether a
 * recorded event should be *subtracted from P&L* is a separate, later decision
 * made by {@link isCapitalMovement}.
 *
 * The split exists because those two questions were previously the same set, so
 * `fee` sitting next to `ach` silently added broker fees back into reported P&L
 * — nobody decided that, it fell out of list membership. Adding a type here is
 * cheap and reversible (it only widens what we persist); changing whether it
 * counts as cash flow is a judgement, and now has to be stated as one.
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
 * TRA-2906 — is this event **capital the user moved into or out of the
 * account**, as opposed to a cost or a credit the account earned by operating?
 *
 * This is the predicate the Live-calendar reconcile subtracts on. The settled
 * cell is `pnl = todayBalance − prevBalance − netCashFlow`, so returning `true`
 * REMOVES the event from reported P&L and returning `false` LEAVES IT IN.
 *
 * The distinction that matters: the subtraction exists so performance is not
 * distorted by **funding**. A $500 ACH deposit is not a $500 trading win, so it
 * comes out. A $10 broker fee is not funding — it is a cost the account incurred
 * by operating, and it belongs in P&L exactly like a commission does.
 *
 * `fee` used to be excluded, which added every broker fee back into the reported
 * number and flattered every day one landed on. Nobody decided that; it fell out
 * of `fee` sitting in a list next to `ach`. It is decided now, and this function
 * is the place the decision lives.
 *
 * Every recorded type is listed explicitly and no type falls through to a
 * default: an unrecognised type returns `false` (stays in P&L) and is the
 * conservative choice, because wrongly excluding a movement silently deletes it
 * from performance, while wrongly including one leaves a visible number that can
 * be argued with.
 */
export function isCapitalMovement(type: string): boolean {
  switch (type.toLowerCase()) {
    // ── Funding: capital the user moved. Excluded from P&L. ──
    case 'ach':
    case 'wire':
    case 'check':
    case 'deposit':
    case 'withdrawal':
    // A journal moves cash between accounts under the same ownership. It is a
    // transfer, not something the book earned.
    case 'journal':
      return true;

    // ── Costs and credits the account incurred by operating. Kept IN P&L. ──
    // TRA-2906 — the ruling this ticket exists for. A broker fee is a cost of
    // doing business. This is also the direction TRA-2850 took deliberately in
    // the same subsystem: it derives per-trade fees from settled `/gainloss`
    // lots specifically so round-trip cost is MEASURED rather than assumed away.
    case 'fee':
      return false;

    // ── Unchanged by TRA-2906, and deliberately so. ──
    // `dividend` and `interest` are income the book earned, which by the same
    // argument as `fee` arguably belongs IN P&L. That is a finance
    // classification call with its own magnitude, NOT the call this ticket was
    // scoped to make, so the existing behaviour is preserved rather than flipped
    // in passing. See TRA-2906's follow-up: whoever changes these states why.
    case 'dividend':
    case 'interest':
      return true;

    // A broker-initiated correction to the balance. Retained as a movement
    // because it is not something the strategy did. Note TRA-2876: an
    // `adjustment` can also be a corporate action carrying quantity at
    // `amount: 0`, in which case this classification is a no-op either way.
    case 'adjustment':
      return true;

    default:
      return false;
  }
}

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
 * TRA-2876 — a NON-TRADE history event that moves a SHARE COUNT.
 *
 * A FIFO lot book reconstructed from the trade tape assumes quantity only ever
 * moves via trades. A corporate action breaks that assumption without leaving a
 * trade row: the board's live account carries a TDIC reverse split as an
 * `adjustment` of quantity **−7 at amount 0**. Nothing in the fills stream says
 * it happened, so a lot book built from fills alone silently keeps 7 shares the
 * account no longer holds — and the next sell is then matched against a basis
 * that no longer exists. The realized number that comes out is wrong and looks
 * completely ordinary.
 *
 * Detection here is deliberately SHAPE-driven, never string-driven: an event
 * qualifies when its nested leg reports a finite NON-ZERO `quantity`. A
 * description keyword test ("REVERSE SPLIT", "SPLIT", …) is the exact filter
 * that matched zero rows on this very feed in TRA-2864, and a filter that
 * matches nothing reads identically to "no corporate actions happened".
 * `quantity` is a number, so it cannot go vacuous the same way.
 *
 * The cash-only siblings of a split (the "REVERSE SPLIT FEE" `transfer` at
 * −$0.75, the cash-in-lieu `journal` at +$2.07) carry NO share-count change and
 * are correctly NOT returned here — they are cash flow, which
 * {@link parseTradierCashEvents} already owns. This parser answers exactly one
 * question: "did a share count move behind the tape's back?"
 */
export interface TradierCorporateAction {
  /** `YYYY-MM-DD` event date as Tradier reports it (account TZ). */
  date: string;
  /** Lowercase event type (`adjustment`, `transfer`, …). */
  type: string;
  /** Raw nested `description` — e.g. `"REVERSE SPLIT - TDIC"`. `''` when absent. */
  description: string;
  /** Signed share-count change. Always non-zero (that is the selection rule). */
  quantity: number;
  /** Signed cash impact. Typically 0 for a pure share-count adjustment. */
  amount: number;
  /** Stable dedup id (Tradier `id` when surfaced, else a synthetic key). */
  transactionId: string;
}

/**
 * TRA-2876 — normalise the Tradier `/accounts/{id}/history` envelope into the
 * subset of non-trade events that CHANGE A SHARE COUNT. See
 * {@link TradierCorporateAction} for why the selection rule is the presence of
 * a non-zero nested `quantity` and not a description keyword.
 *
 * Tradier nests each event's leg under a key named after the event `type`
 * (`trade` → `trade`, `adjustment` → `adjustment`). We look there first, then
 * fall back to scanning the row's other object-valued properties, so a nested
 * key that does not match its type name still gets read rather than silently
 * dropping the one event class this exists to catch.
 */
export function parseTradierCorporateActions(
  envelope: TradierHistoryEnvelope | null,
): TradierCorporateAction[] {
  if (!envelope || typeof envelope.history !== 'object' || envelope.history == null) {
    return [];
  }
  const out: TradierCorporateAction[] = [];
  for (const raw of asArray(envelope.history.event)) {
    if (typeof raw.type !== 'string') continue;
    const type = raw.type.toLowerCase();
    if (type === 'trade') continue;
    const row = raw as unknown as Record<string, unknown>;
    // Type-named key first, then any other nested object on the row.
    const candidates: unknown[] = [row[type]];
    for (const [key, value] of Object.entries(row)) {
      if (key === type) continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) candidates.push(value);
    }
    let leg: { quantity?: unknown; description?: unknown } | null = null;
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const q = (candidate as { quantity?: unknown }).quantity;
      if (typeof q === 'number' && Number.isFinite(q) && q !== 0) {
        leg = candidate as { quantity?: unknown; description?: unknown };
        break;
      }
    }
    if (!leg) continue;
    const date = typeof raw.date === 'string' ? raw.date.slice(0, 10) : '';
    if (!date) continue;
    const quantity = leg.quantity as number;
    const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) ? raw.amount : 0;
    const description = typeof leg.description === 'string' ? leg.description : '';
    const transactionId =
      raw.id != null ? String(raw.id) : `${date}|${type}|${quantity}|${description}`;
    out.push({ date, type, description, quantity, amount, transactionId });
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
