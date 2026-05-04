import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradierOrderClient, tradierBaseUrl } from './order-client.js';
import { TradierOptionsClient, underlyingFromOcc } from './options-client.js';

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function callUrl(idx: number): string {
  return String(fetchMock.mock.calls[idx][0]);
}

function callInit(idx: number): RequestInit {
  return fetchMock.mock.calls[idx][1] as RequestInit;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({}));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── tradierBaseUrl / underlyingFromOcc ─────────────────────────────────────

describe('tradierBaseUrl', () => {
  it('defaults to sandbox', () => {
    expect(tradierBaseUrl('sandbox')).toBe('https://sandbox.tradier.com/v1');
  });
  it('returns production base when env=production', () => {
    expect(tradierBaseUrl('production')).toBe('https://api.tradier.com/v1');
  });
});

describe('underlyingFromOcc', () => {
  it('extracts AAPL from a standard OCC symbol', () => {
    expect(underlyingFromOcc('AAPL230818C00150000')).toBe('AAPL');
  });
  it('extracts SPY from a put OCC symbol', () => {
    expect(underlyingFromOcc('SPY240315P00500000')).toBe('SPY');
  });
  it('falls back to the input if it cannot parse', () => {
    expect(underlyingFromOcc('123')).toBe('123');
  });
});

// ─── TradierOrderClient ─────────────────────────────────────────────────────

describe('TradierOrderClient', () => {
  it('builds an OTOCO bracket order against the sandbox base URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 42, status: 'ok' } }));
    const client = new TradierOrderClient('tok', 'ACCT123');

    const order = await client.submitBracketOrder({
      symbol: 'AAPL',
      qty: 10,
      side: 'buy',
      limitPrice: 150.5,
      takeProfitPrice: 155,
      stopLossPrice: 148,
    });

    expect(order).toEqual({ id: 42, status: 'ok' });
    expect(callUrl(0)).toBe('https://sandbox.tradier.com/v1/accounts/ACCT123/orders');
    expect(callInit(0).method).toBe('POST');

    const headers = callInit(0).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('class')).toBe('otoco');
    expect(params.get('symbol')).toBe('AAPL');
    expect(params.get('side[0]')).toBe('buy');
    expect(params.get('quantity[0]')).toBe('10');
    expect(params.get('type[0]')).toBe('limit');
    expect(params.get('price[0]')).toBe('150.50');
    expect(params.get('side[1]')).toBe('sell');
    expect(params.get('price[1]')).toBe('155.00');
    expect(params.get('side[2]')).toBe('sell');
    expect(params.get('type[2]')).toBe('stop');
    expect(params.get('stop[2]')).toBe('148.00');
  });

  it('targets production base URL when env=production', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 1, status: 'ok' } }));
    const client = new TradierOrderClient('tok', 'A1', 'production');
    await client.submitBracketOrder({
      symbol: 'AAPL', qty: 1, side: 'buy', limitPrice: 1, takeProfitPrice: 2, stopLossPrice: 0.5,
    });
    expect(callUrl(0).startsWith('https://api.tradier.com/v1')).toBe(true);
  });

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('boom', 500));
    const client = new TradierOrderClient('tok', 'A1');
    await expect(
      client.submitBracketOrder({
        symbol: 'AAPL', qty: 1, side: 'buy', limitPrice: 1, takeProfitPrice: 2, stopLossPrice: 0.5,
      }),
    ).rejects.toThrow(/Tradier order failed \(500\)/);
  });

  it('throws on errors envelope even with 200 status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: { error: 'insufficient buying power' } }));
    const client = new TradierOrderClient('tok', 'A1');
    await expect(
      client.submitBracketOrder({
        symbol: 'AAPL', qty: 1, side: 'buy', limitPrice: 1, takeProfitPrice: 2, stopLossPrice: 0.5,
      }),
    ).rejects.toThrow(/insufficient buying power/);
  });

  it('cancelOrder issues a DELETE and tolerates 404', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('not found', 404));
    const client = new TradierOrderClient('tok', 'A1');
    await client.cancelOrder(99);
    expect(callUrl(0)).toBe('https://sandbox.tradier.com/v1/accounts/A1/orders/99');
    expect(callInit(0).method).toBe('DELETE');
  });
});

// ─── TradierOptionsClient ───────────────────────────────────────────────────

describe('TradierOptionsClient.getExpirations', () => {
  it('parses an array response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ expirations: { date: ['2026-05-15', '2026-05-22'] } }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getExpirations('AAPL')).toEqual(['2026-05-15', '2026-05-22']);
  });

  it('parses a single-string response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ expirations: { date: '2026-05-15' } }));
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getExpirations('AAPL')).toEqual(['2026-05-15']);
  });

  it('returns [] when the API has no expirations', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ expirations: null }));
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getExpirations('AAPL')).toEqual([]);
  });
});

describe('TradierOptionsClient.getChain', () => {
  it('parses the chain envelope and exposes optionSymbol', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        options: {
          option: [
            { symbol: 'AAPL260515C00150000', underlying: 'AAPL', description: 'd', option_type: 'call', strike: 150, expiration_date: '2026-05-15' },
            { symbol: 'AAPL260515P00150000', underlying: 'AAPL', description: 'd', option_type: 'put',  strike: 150, expiration_date: '2026-05-15' },
          ],
        },
      }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    const chain = await client.getChain('AAPL', '2026-05-15', true);
    expect(chain).toHaveLength(2);
    expect(chain[0].optionSymbol).toBe('AAPL260515C00150000');
    expect(chain[0].symbol).toBe(chain[0].optionSymbol);
    expect(callUrl(0)).toContain('greeks=true');
    expect(callUrl(0)).toContain('expiration=2026-05-15');
  });
});

describe('TradierOptionsClient.findATMContract', () => {
  it('selects the strike closest to current price within the 14-35d window', async () => {
    const today = new Date('2026-04-28T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(today);
    try {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          expirations: {
            date: [
              '2026-04-29',
              '2026-05-15',
              '2026-05-22',
              '2026-07-01',
            ],
          },
        }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          options: {
            option: [
              { symbol: 'AAPL260515C00145000', underlying: 'AAPL', description: 'd', option_type: 'call', strike: 145, expiration_date: '2026-05-15' },
              { symbol: 'AAPL260515C00150000', underlying: 'AAPL', description: 'd', option_type: 'call', strike: 150, expiration_date: '2026-05-15' },
              { symbol: 'AAPL260515C00155000', underlying: 'AAPL', description: 'd', option_type: 'call', strike: 155, expiration_date: '2026-05-15' },
              { symbol: 'AAPL260515P00150000', underlying: 'AAPL', description: 'd', option_type: 'put',  strike: 150, expiration_date: '2026-05-15' },
            ],
          },
        }),
      );

      const client = new TradierOptionsClient('tok', 'A1');
      const atm = await client.findATMContract('AAPL', 'call', 151);
      expect(atm?.optionSymbol).toBe('AAPL260515C00150000');
      expect(callUrl(0)).toContain('/markets/options/expirations?symbol=AAPL');
      expect(callUrl(1)).toContain('expiration=2026-05-15');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when no expirations fall in the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T12:00:00Z'));
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ expirations: { date: '2026-04-30' } }));
      const client = new TradierOptionsClient('tok', 'A1');
      expect(await client.findATMContract('AAPL', 'call', 150)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TradierOptionsClient.getChainSnapshot', () => {
  it('forces greeks=true and projects rows into OptionChainRow shape', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        options: {
          option: [
            {
              symbol: 'AAPL260515C00150000',
              underlying: 'AAPL',
              description: 'd',
              option_type: 'call',
              strike: 150,
              expiration_date: '2026-05-15',
              bid: 1.20,
              ask: 1.30,
              last: 1.25,
              volume: 12,
              open_interest: 345,
              greeks: { mid_iv: 0.28, smv_vol: 0.27 },
            },
            {
              symbol: 'AAPL260515P00150000',
              underlying: 'AAPL',
              description: 'd',
              option_type: 'put',
              strike: 150,
              expiration_date: '2026-05-15',
              bid: 0,
              ask: 0,
              greeks: null,
            },
          ],
        },
      }),
    );

    const client = new TradierOptionsClient('tok', 'A1');
    const rows = await client.getChainSnapshot('AAPL', '2026-05-15');

    expect(callUrl(0)).toContain('greeks=true');
    expect(callUrl(0)).toContain('expiration=2026-05-15');
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      optionSymbol: 'AAPL260515C00150000',
      optionType: 'call',
      strike: 150,
      expiration: '2026-05-15',
      bid: 1.20,
      ask: 1.30,
      openInterest: 345,
      midIv: 0.28,
      smvVol: 0.27,
    });

    // Missing greeks → midIv/smvVol omitted, not zeroed.
    expect(rows[1].midIv).toBeUndefined();
    expect(rows[1].smvVol).toBeUndefined();
  });

  it('returns an empty array when chain payload is empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ options: null }));
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getChainSnapshot('AAPL', '2026-05-15')).toEqual([]);
  });
});

describe('TradierOptionsClient.getOptionMid', () => {
  it('returns mid of bid and ask', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ quotes: { quote: { symbol: 'X', bid: 1.0, ask: 1.4, last: 9 } } }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getOptionMid('X')).toBeCloseTo(1.2);
  });

  it('falls back to last when no bid/ask', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ quotes: { quote: { symbol: 'X', last: 2.5 } } }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getOptionMid('X')).toBe(2.5);
  });

  it('returns null when the quote is empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ quotes: null }));
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getOptionMid('X')).toBeNull();
  });
});

describe('TradierOptionsClient.getAccountBalance (TRA-226)', () => {
  it('parses total_equity / total_cash from /accounts/{id}/balances', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ balances: { total_equity: 12345.67, total_cash: 5000, account_number: 'A1' } }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    const balance = await client.getAccountBalance();
    expect(balance).toEqual({ totalEquity: 12345.67, totalCash: 5000, optionBuyingPower: null });
    expect(callUrl(0)).toBe('https://sandbox.tradier.com/v1/accounts/A1/balances');
    const headers = callInit(0).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('hits the production base URL when env=production', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ balances: { total_equity: 1, total_cash: 1 } }),
    );
    const client = new TradierOptionsClient('tok', 'VA9', 'production');
    await client.getAccountBalance();
    expect(callUrl(0)).toBe('https://api.tradier.com/v1/accounts/VA9/balances');
  });

  it('returns null when the balances envelope is missing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ balances: null }));
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getAccountBalance()).toBeNull();
  });

  it('returns null when fields are not finite numbers', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ balances: { total_equity: 'oops', total_cash: 100 } }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getAccountBalance()).toBeNull();
  });

  // TRA-319 — option buying power surfaces from the per-account-type subobject
  // (`margin`, `pdt`, or `cash`) so the engine can pre-check before placing an
  // order Tradier would just cancel for insufficient funds.
  it('extracts option_buying_power from a margin balance', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        balances: {
          total_equity: 1000,
          total_cash: 300,
          account_type: 'margin',
          margin: { option_buying_power: 250, stock_buying_power: 600 },
        },
      }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getAccountBalance()).toEqual({
      totalEquity: 1000,
      totalCash: 300,
      optionBuyingPower: 250,
    });
  });

  it('falls back to cash.cash_available for cash accounts', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        balances: {
          total_equity: 500,
          total_cash: 500,
          account_type: 'cash',
          cash: { cash_available: 480 },
        },
      }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    expect((await client.getAccountBalance())?.optionBuyingPower).toBe(480);
  });

  it('returns optionBuyingPower=null when no buying-power subobject is present', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ balances: { total_equity: 1, total_cash: 1 } }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    expect((await client.getAccountBalance())?.optionBuyingPower).toBeNull();
  });
});

describe('TradierOptionsClient.buyContracts / sellContracts', () => {
  it('posts a buy_to_open option order with derived underlying', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 7, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'A1');
    const r = await client.buyContracts('AAPL260515C00150000', 3);
    expect(r.id).toBe(7);

    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('class')).toBe('option');
    expect(params.get('symbol')).toBe('AAPL');
    expect(params.get('option_symbol')).toBe('AAPL260515C00150000');
    expect(params.get('side')).toBe('buy_to_open');
    expect(params.get('quantity')).toBe('3');
    expect(params.get('type')).toBe('market');
    expect(params.get('duration')).toBe('day');
  });

  it('posts a sell_to_close option order', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 8, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'A1');
    await client.sellContracts('AAPL260515P00150000', 2);
    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('side')).toBe('sell_to_close');
    expect(params.get('option_symbol')).toBe('AAPL260515P00150000');
    expect(params.get('quantity')).toBe('2');
  });

  it('throws on a non-2xx option order response', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('rate limit', 429));
    const client = new TradierOptionsClient('tok', 'A1');
    await expect(client.buyContracts('AAPL260515C00150000', 1)).rejects.toThrow(/429/);
  });
});

// ─── TRA-319 — order status reconciliation ──────────────────────────────────

describe('TradierOrderClient.getOrderStatus', () => {
  it('parses the order envelope and lowercases status', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        order: {
          id: 42,
          status: 'CANCELED',
          reason_description: 'insufficient buying power',
          exec_quantity: 0,
          remaining_quantity: 1,
        },
      }),
    );
    const client = new TradierOrderClient('tok', 'A1');
    const detail = await client.getOrderStatus(42);
    expect(detail).toEqual({
      id: 42,
      status: 'canceled',
      reason_description: 'insufficient buying power',
      exec_quantity: 0,
      remaining_quantity: 1,
      avg_fill_price: undefined,
    });
    expect(callUrl(0)).toBe('https://sandbox.tradier.com/v1/accounts/A1/orders/42');
    expect(callInit(0).method).toBe('GET');
  });

  it('returns null on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('nope', 404));
    const client = new TradierOrderClient('tok', 'A1');
    expect(await client.getOrderStatus(7)).toBeNull();
  });
});

describe('TradierOrderClient.waitForOrderTerminalStatus', () => {
  it('returns immediately when the first poll is already terminal', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ order: { id: 1, status: 'filled', exec_quantity: 1 } }),
    );
    const client = new TradierOrderClient('tok', 'A1');
    const sleep = vi.fn(async () => {});
    const detail = await client.waitForOrderTerminalStatus(1, { timeoutMs: 1000, sleep });
    expect(detail?.status).toBe('filled');
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polls until a terminal state is reached', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ order: { id: 2, status: 'pending' } }))
      .mockResolvedValueOnce(jsonResponse({ order: { id: 2, status: 'open' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          order: { id: 2, status: 'rejected', reason_description: 'insufficient buying power' },
        }),
      );
    const client = new TradierOrderClient('tok', 'A1');
    const sleep = vi.fn(async () => {});
    const detail = await client.waitForOrderTerminalStatus(2, {
      timeoutMs: 5000,
      intervalMs: 10,
      sleep,
    });
    expect(detail?.status).toBe('rejected');
    expect(detail?.reason_description).toBe('insufficient buying power');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('returns the latest non-terminal detail when the timeout elapses', async () => {
    // `mockResolvedValue` would reuse the same Response instance — Response.json()
    // can only be read once, so use a factory that builds a fresh body per call.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ order: { id: 3, status: 'pending' } }),
    );
    const client = new TradierOrderClient('tok', 'A1');
    let virtualNow = 0;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => virtualNow);
    const sleep = vi.fn(async (ms: number) => {
      virtualNow += ms;
    });
    try {
      const detail = await client.waitForOrderTerminalStatus(3, {
        timeoutMs: 100,
        intervalMs: 40,
        sleep,
      });
      expect(detail?.status).toBe('pending');
    } finally {
      dateSpy.mockRestore();
    }
  });
});
