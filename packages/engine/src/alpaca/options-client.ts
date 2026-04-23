import type { OptionType } from '@trading-app/shared';

export interface AlpacaOptionsContract {
  id: string;
  symbol: string;           // OCC symbol
  underlying_symbol: string;
  type: 'call' | 'put';
  strike_price: string;
  expiration_date: string;
  status: string;
}

export interface AlpacaOptionOrderResponse {
  id: string;
  client_order_id: string;
  status: string;
  symbol: string;
  qty: string;
  side: string;
  type: string;
  asset_class: string;
}

export interface AlpacaOptionSnapshot {
  latestQuote?: {
    ap: number; // ask price
    bp: number; // bid price
  };
  latestTrade?: {
    p: number; // price
  };
}

export class AlpacaOptionsClient {
  private readonly baseUrl: string;
  private readonly dataUrl: string;
  private readonly headers: Record<string, string>;

  constructor(apiKey: string, apiSecret: string, paper = true) {
    this.baseUrl = paper
      ? 'https://paper-api.alpaca.markets/v2'
      : 'https://api.alpaca.markets/v2';
    this.dataUrl = 'https://data.alpaca.markets/v1beta1';
    this.headers = {
      'APCA-API-KEY-ID': apiKey,
      'APCA-API-SECRET-KEY': apiSecret,
      'Content-Type': 'application/json',
    };
  }

  /** Find the nearest ATM contract expiring 2-4 weeks out. */
  async findATMContract(
    underlyingSymbol: string,
    optionType: OptionType,
    currentPrice: number,
  ): Promise<AlpacaOptionsContract | null> {
    const today = new Date();
    const minExp = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
    const maxExp = new Date(today.getTime() + 35 * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      underlying_symbols: underlyingSymbol,
      type: optionType,
      status: 'active',
      expiration_date_gte: minExp.toISOString().split('T')[0],
      expiration_date_lte: maxExp.toISOString().split('T')[0],
      strike_price_gte: String((currentPrice * 0.95).toFixed(2)),
      strike_price_lte: String((currentPrice * 1.05).toFixed(2)),
      limit: '10',
    });

    const resp = await fetch(`${this.baseUrl}/options/contracts?${params}`, {
      headers: this.headers,
    });

    if (!resp.ok) return null;

    const data = await resp.json() as { option_contracts?: AlpacaOptionsContract[] };
    const contracts = data.option_contracts ?? [];
    if (contracts.length === 0) return null;

    // Pick the contract whose strike is closest to current price
    return contracts.reduce((best, c) => {
      const bestDiff = Math.abs(parseFloat(best.strike_price) - currentPrice);
      const cDiff = Math.abs(parseFloat(c.strike_price) - currentPrice);
      return cDiff < bestDiff ? c : best;
    });
  }

  /** Get current mid price for an option contract. */
  async getOptionMid(optionSymbol: string): Promise<number | null> {
    const resp = await fetch(
      `${this.dataUrl}/options/snapshots/${encodeURIComponent(optionSymbol)}`,
      { headers: this.headers },
    );
    if (!resp.ok) return null;

    const data = await resp.json() as { snapshot?: AlpacaOptionSnapshot };
    const snap = data.snapshot;
    if (!snap) return null;

    if (snap.latestQuote?.ap && snap.latestQuote?.bp) {
      return (snap.latestQuote.ap + snap.latestQuote.bp) / 2;
    }
    return snap.latestTrade?.p ?? null;
  }

  /** Submit a market order to buy option contracts. */
  async buyContracts(
    optionSymbol: string,
    qty: number,
  ): Promise<AlpacaOptionOrderResponse> {
    const body = {
      symbol: optionSymbol,
      qty: String(qty),
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
    };

    const resp = await fetch(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Alpaca options order failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<AlpacaOptionOrderResponse>;
  }

  /** Submit a market order to sell (close) option contracts. */
  async sellContracts(
    optionSymbol: string,
    qty: number,
  ): Promise<AlpacaOptionOrderResponse> {
    const body = {
      symbol: optionSymbol,
      qty: String(qty),
      side: 'sell',
      type: 'market',
      time_in_force: 'day',
    };

    const resp = await fetch(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Alpaca options sell failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<AlpacaOptionOrderResponse>;
  }
}
