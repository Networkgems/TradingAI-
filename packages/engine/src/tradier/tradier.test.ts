import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradierOrderClient, tradierBaseUrl, parseTradierEquityPositions, parseTradierOrderLegs } from './order-client.js';
import { __resetUnknownIntentBreakerForTest, setOrderIntentJournal } from './order-intent.js';
import {
  TradierOptionsClient,
  isBrokerMaintenanceZeroBalances,
  underlyingFromOcc,
  parseOccSymbol,
  parseTradierPositions,
  parseTradierHistory,
  parseTradierCashEvents,
  parseTradierCorporateActions,
  parseTradierGainLoss,
} from './options-client.js';

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
  // TRA-4476 — the unknown-intent breaker is a process-wide singleton (see its
  // docblock for why it has to be). Without this reset a test that drives a 5xx
  // latches the shape and the NEXT test submitting the same symbol/side/qty is
  // correctly halted — which is the state machine working, arriving as a
  // mystery failure three tests later.
  __resetUnknownIntentBreakerForTest();
  setOrderIntentJournal(null);
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
    // OTOCO is multileg: symbol + duration are per-leg, there is NO top-level
    // `symbol`, and equity legs carry no `option_symbol` (TRA-553).
    expect(params.get('symbol')).toBeNull();
    expect(params.get('option_symbol[0]')).toBeNull();
    // Leg 0 — entry
    expect(params.get('symbol[0]')).toBe('AAPL');
    expect(params.get('side[0]')).toBe('buy');
    expect(params.get('quantity[0]')).toBe('10');
    expect(params.get('type[0]')).toBe('limit');
    expect(params.get('duration[0]')).toBe('day');
    expect(params.get('price[0]')).toBe('150.50');
    // Leg 1 — take profit (OCO with leg 2)
    expect(params.get('symbol[1]')).toBe('AAPL');
    expect(params.get('side[1]')).toBe('sell');
    expect(params.get('quantity[1]')).toBe('10');
    expect(params.get('type[1]')).toBe('limit');
    expect(params.get('duration[1]')).toBe('gtc');
    expect(params.get('price[1]')).toBe('155.00');
    // Leg 2 — stop loss (OCO with leg 1)
    expect(params.get('symbol[2]')).toBe('AAPL');
    expect(params.get('side[2]')).toBe('sell');
    expect(params.get('quantity[2]')).toBe('10');
    expect(params.get('type[2]')).toBe('stop');
    expect(params.get('duration[2]')).toBe('gtc');
    expect(params.get('stop[2]')).toBe('148.00');
  });

  it('targets production base URL when env=production', async () => {
    // TRA-4602 — Production refuses to POST unless the pre-submit intent was
    // recorded DURABLY, and the default in-memory journal never claims
    // durability. This arm is about URL routing, so install a journal that does.
    // (The real server installs FileOrderIntentJournal at boot via
    // installOrderIntentJournal(DATA_DIR).)
    setOrderIntentJournal({
      record: () => {},
      recordDurable: () => true,
      update: () => {},
      openUnknowns: () => [],
    });
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

  // TRA-2126 — plain equity order (smoke-order path).
  it('submitEquityOrder posts a market equity order with class=equity', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 7, status: 'ok' } }));
    const client = new TradierOrderClient('tok', 'A1');
    const order = await client.submitEquityOrder({ symbol: 'AAPL', side: 'buy', qty: 1 });
    expect(order).toEqual({ id: 7, status: 'ok' });
    expect(callUrl(0)).toBe('https://sandbox.tradier.com/v1/accounts/A1/orders');
    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('class')).toBe('equity');
    expect(params.get('symbol')).toBe('AAPL');
    expect(params.get('side')).toBe('buy');
    expect(params.get('quantity')).toBe('1');
    expect(params.get('type')).toBe('market');
    expect(params.get('duration')).toBe('day');
    // A market order carries no price.
    expect(params.get('price')).toBeNull();
  });

  it('submitEquityOrder includes a formatted price for a limit order', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 8, status: 'ok' } }));
    const client = new TradierOrderClient('tok', 'A1');
    await client.submitEquityOrder({ symbol: 'MSFT', side: 'sell', qty: 3, type: 'limit', limitPrice: 421.5 });
    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('type')).toBe('limit');
    expect(params.get('price')).toBe('421.50');
  });

  it('submitEquityOrder rejects a limit order without a positive limitPrice', async () => {
    const client = new TradierOrderClient('tok', 'A1');
    await expect(
      client.submitEquityOrder({ symbol: 'MSFT', side: 'buy', qty: 1, type: 'limit' }),
    ).rejects.toThrow(/requires a positive limitPrice/);
    // No network call was made — the guard fires before postOrder.
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(balance).toEqual({
      totalEquity: 12345.67,
      totalCash: 5000,
      optionBuyingPower: null,
      stockBuyingPower: null,
      longMarketValue: null,
      dayTradeBuyingPower: null,
      // TRA-724 — no account_type and no sub-envelope ⇒ indeterminate.
      accountType: null,
      // TRA-725 — none of the account-panel fields present ⇒ all null.
      settledFunds: null,
      stockLongValue: null,
      optionLongValue: null,
      optionShortValue: null,
      // TRA-3954 added `openPl` to the parse without updating this fixture.
      openPl: null,
    });
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

  // ─── TRA-3970 — the broker's weekend/maintenance ALL-ZEROS artifact ────────
  // Measured 2026-08-23 (Sunday) on production ***0154: `/balances` served
  // `total_cash: 0, total_equity: 0, market_value: 0` while `/positions`
  // served 3 open rows in the same minute on the same credentials. Parsing it
  // as a real $0 collapsed `capUsd` to φ·atRisk and fired the TRA-3897
  // over-cap tripwire (`headroomSignedUsd: −140.38`) on a book not over cap.

  // VACUITY CONTROL — the measured artifact envelope, hardcoded, must land on
  // the UNREADABLE → null path AND be counted. A suppression that cannot be
  // counted is itself the next unreadable instrument (ABSENT ≠ 0).
  it('TRA-3970 — refuses the all-zeros maintenance envelope and counts the suppression', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        balances: {
          account_number: 'A1',
          account_type: 'margin',
          total_equity: 0,
          total_cash: 0,
          market_value: 0,
          margin: { option_buying_power: 0, stock_buying_power: 0 },
        },
      }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    expect(client.getZeroBalancesArtifactSuppression()).toEqual({ count: 0, lastAtMs: null });
    expect(await client.getAccountBalance()).toBeNull();
    const suppression = client.getZeroBalancesArtifactSuppression();
    expect(suppression.count).toBe(1);
    expect(suppression.lastAtMs).toBeGreaterThan(0);
  });

  // POSITIVE CONTROL — a real nonzero envelope still parses and is NOT
  // counted, so the refusal above cannot be simply always-on.
  it('TRA-3970 (positive control) — a real nonzero envelope parses and is not counted', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        // bqb1 `admin` as measured 2026-08-22 — the last artifact-free read.
        balances: { total_equity: 652.15, total_cash: 411.15, market_value: 241 },
      }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    const balance = await client.getAccountBalance();
    expect(balance?.totalCash).toBe(411.15);
    expect(balance?.totalEquity).toBe(652.15);
    expect(client.getZeroBalancesArtifactSuppression()).toEqual({ count: 0, lastAtMs: null });
  });

  // DISCRIMINATING CONTROL — $0 cash beside nonzero equity/market value is a
  // REAL account state (all cash deployed into positions) and must keep
  // parsing. The predicate is the TRIPLE zero, not "cash is zero".
  it('TRA-3970 — zero cash with nonzero equity is account truth, not the artifact', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        balances: { total_equity: 297, total_cash: 0, market_value: 297 },
      }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    const balance = await client.getAccountBalance();
    expect(balance?.totalCash).toBe(0);
    expect(balance?.totalEquity).toBe(297);
    expect(client.getZeroBalancesArtifactSuppression().count).toBe(0);
  });

  // The predicate is STRICT: an envelope missing `market_value` is not the
  // measured artifact shape (the TRA-226 fixtures above omit it and must keep
  // parsing), and a missing payload is refused upstream, not here.
  it('TRA-3970 — the artifact predicate requires all three literal zeros', () => {
    expect(isBrokerMaintenanceZeroBalances({ total_cash: 0, total_equity: 0, market_value: 0 })).toBe(true);
    expect(isBrokerMaintenanceZeroBalances({ total_cash: 0, total_equity: 0 })).toBe(false);
    expect(isBrokerMaintenanceZeroBalances({ total_cash: 0, total_equity: 297, market_value: 297 })).toBe(false);
    expect(isBrokerMaintenanceZeroBalances(null)).toBe(false);
    expect(isBrokerMaintenanceZeroBalances(undefined)).toBe(false);
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
      stockBuyingPower: 600,
      longMarketValue: null,
      dayTradeBuyingPower: null,
      accountType: 'margin',
      settledFunds: null,
      stockLongValue: null,
      optionLongValue: null,
      optionShortValue: null,
      // TRA-3954 added `openPl` to the parse without updating this fixture.
      openPl: null,
    });
  });

  // TRA-725 — mirror Tradier's account panel: settled funds (= total_cash −
  // unsettled_funds) and the per-asset-class market values.
  it('parses settled funds and per-asset-class market values (TRA-725)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        balances: {
          total_equity: 816.35,
          total_cash: 225.35,
          account_type: 'cash',
          stock_long_value: 1,
          option_long_value: 590,
          option_short_value: 0,
          cash: { cash_available: 0.06, unsettled_funds: 25.29 },
        },
      }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    const balance = await client.getAccountBalance();
    // settled = 225.35 − 25.29 = 200.06 (mirrors Tradier's $200.06 Settled Funds).
    expect(balance?.settledFunds).toBeCloseTo(200.06, 2);
    expect(balance?.stockLongValue).toBe(1);
    expect(balance?.optionLongValue).toBe(590);
    expect(balance?.optionShortValue).toBe(0);
  });

  it('leaves settled funds and market values null when Tradier omits them (TRA-725)', async () => {
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
    const balance = await client.getAccountBalance();
    expect(balance?.settledFunds).toBeNull();
    expect(balance?.stockLongValue).toBeNull();
    expect(balance?.optionLongValue).toBeNull();
    expect(balance?.optionShortValue).toBeNull();
  });

  // TRA-724 — surface the account classification so the live engine can gate
  // shorts on cash (non-marginable) accounts.
  it('classifies the account from account_type (cash) and infers it from the sub-envelope when absent', async () => {
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
    let client = new TradierOptionsClient('tok', 'A1');
    expect((await client.getAccountBalance())?.accountType).toBe('cash');

    // No explicit account_type, but only a `cash` sub-envelope present ⇒ cash.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        balances: { total_equity: 500, total_cash: 500, cash: { cash_available: 480 } },
      }),
    );
    client = new TradierOptionsClient('tok', 'A1');
    expect((await client.getAccountBalance())?.accountType).toBe('cash');

    // No explicit account_type, but a `margin` sub-envelope present ⇒ margin.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        balances: { total_equity: 1000, total_cash: 300, margin: { stock_buying_power: 600 } },
      }),
    );
    client = new TradierOptionsClient('tok', 'A1');
    expect((await client.getAccountBalance())?.accountType).toBe('margin');
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

  // TRA-483 — day_trade_buying_power is the PDT day-trading limit. Tradier
  // surfaces it on margin / PDT accounts; the engine reads it so it can
  // refuse same-day round-trip opens when DTBP=$0 even with positive
  // optionBuyingPower (the exact failure mode the issue captured).
  it('extracts day_trade_buying_power from a margin balance', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        balances: {
          total_equity: 2500,
          total_cash: 1000,
          account_type: 'margin',
          margin: {
            option_buying_power: 1500,
            stock_buying_power: 3000,
            day_trade_buying_power: 0,
          },
        },
      }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    expect((await client.getAccountBalance())?.dayTradeBuyingPower).toBe(0);
  });

  it('extracts day_trade_buying_power from a pdt balance', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        balances: {
          total_equity: 30_000,
          total_cash: 5000,
          account_type: 'pdt',
          pdt: {
            option_buying_power: 10_000,
            stock_buying_power: 20_000,
            day_trade_buying_power: 7500,
          },
        },
      }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    expect((await client.getAccountBalance())?.dayTradeBuyingPower).toBe(7500);
  });

  it('returns dayTradeBuyingPower=null for cash accounts (no DTBP bucket)', async () => {
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
    expect((await client.getAccountBalance())?.dayTradeBuyingPower).toBeNull();
  });
});

// TRA-352 — getOptionQuote preserves bid/ask/last separately so the smart
// sell-to-close path can compute a midpoint and fall back gracefully when
// only one side of the quote is populated.
describe('TradierOptionsClient.getOptionQuote', () => {
  it('returns bid, ask, last when all three are present', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ quotes: { quote: { symbol: 'X', bid: 0.05, ask: 0.17, last: 0.11 } } }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    const q = await client.getOptionQuote('X');
    expect(q).toEqual({ symbol: 'X', bid: 0.05, ask: 0.17, last: 0.11 });
  });

  it('omits missing fields so callers can branch on undefined', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ quotes: { quote: { symbol: 'X', ask: 0.25 } } }),
    );
    const client = new TradierOptionsClient('tok', 'A1');
    const q = await client.getOptionQuote('X');
    expect(q).toEqual({ symbol: 'X', ask: 0.25 });
  });

  it('returns null when the quotes envelope is empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ quotes: null }));
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.getOptionQuote('X')).toBeNull();
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

  // TRA-352 — sellContractsLimit submits a limit `sell_to_close` so the
  // close path can land on the midpoint instead of the bid. The market
  // variant is kept around for non-close call sites (none today; legacy).
  it('posts a sell_to_close LIMIT order with rounded cent price', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 11, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'A1');
    await client.sellContractsLimit('AAPL260515P00150000', 4, 0.1149);
    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('class')).toBe('option');
    expect(params.get('side')).toBe('sell_to_close');
    expect(params.get('option_symbol')).toBe('AAPL260515P00150000');
    expect(params.get('quantity')).toBe('4');
    expect(params.get('type')).toBe('limit');
    // 0.1149 → 0.11 (round to nearest cent).
    expect(params.get('price')).toBe('0.11');
    expect(params.get('duration')).toBe('day');
  });

  // TRA-354 — engine-fired exits also use sellContractsLimit. Verifies the
  // body carries the derived underlying symbol alongside the rounded limit
  // price so the wait-and-hold poll path can match the broker order id back
  // to the staged pendingExit on the position.
  it('posts a sell_to_close LIMIT order with the derived underlying symbol', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 11, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'A1');
    const r = await client.sellContractsLimit('AAPL260515C00150000', 2, 1.234);
    expect(r.id).toBe(11);
    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('symbol')).toBe('AAPL');
    expect(params.get('option_symbol')).toBe('AAPL260515C00150000');
    expect(params.get('side')).toBe('sell_to_close');
    expect(params.get('quantity')).toBe('2');
    expect(params.get('type')).toBe('limit');
    // 1.234 → 1.23 (roundToCent matches Tradier's cent granularity).
    expect(params.get('price')).toBe('1.23');
  });
});

// TRA-1966 — premium-selling (write) primitive: sell_to_open / buy_to_close.
// Verifies the covered-write order bodies carry the right side so the broker
// holds buying power for a cash-secured put / covered call.
describe('TradierOptionsClient covered-write primitive (TRA-1966)', () => {
  it('posts a sell_to_open MARKET order for a short write', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 21, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'A1');
    const r = await client.sellToOpenContracts('AAPL260515P00150000', 2);
    expect(r.id).toBe(21);
    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('class')).toBe('option');
    expect(params.get('symbol')).toBe('AAPL');
    expect(params.get('option_symbol')).toBe('AAPL260515P00150000');
    expect(params.get('side')).toBe('sell_to_open');
    expect(params.get('quantity')).toBe('2');
    expect(params.get('type')).toBe('market');
  });

  it('posts a sell_to_open LIMIT order with rounded cent price', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 22, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'A1');
    await client.sellToOpenContractsLimit('AAPL260515C00160000', 3, 1.257);
    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('side')).toBe('sell_to_open');
    expect(params.get('option_symbol')).toBe('AAPL260515C00160000');
    expect(params.get('quantity')).toBe('3');
    expect(params.get('type')).toBe('limit');
    // 1.257 → 1.26 (round to nearest cent).
    expect(params.get('price')).toBe('1.26');
    expect(params.get('duration')).toBe('day');
  });

  it('posts a buy_to_close MARKET order to close a short write', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 23, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'A1');
    await client.buyToCloseContracts('AAPL260515P00150000', 2);
    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('side')).toBe('buy_to_close');
    expect(params.get('option_symbol')).toBe('AAPL260515P00150000');
    expect(params.get('quantity')).toBe('2');
  });

  it('posts a buy_to_close LIMIT order (roll / take-profit) with rounded cent price', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 24, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'A1');
    await client.buyToCloseContractsLimit('AAPL260515C00160000', 1, 0.043);
    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('side')).toBe('buy_to_close');
    expect(params.get('type')).toBe('limit');
    // 0.043 → 0.04.
    expect(params.get('price')).toBe('0.04');
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

  // TRA-416 — Tradier surfaces the cumulative filled quantity as
  // `exec_quantity` on `/orders/{id}`, but other order shapes name it
  // `last_fill_quantity` / `fill_quantity`. `getOrderStatus` coalesces them
  // so a partial-fill detector downstream always sees a value.
  it('coalesces last_fill_quantity into exec_quantity when exec_quantity is absent', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        order: { id: 50, status: 'expired', last_fill_quantity: 4, avg_fill_price: 0.85 },
      }),
    );
    const client = new TradierOrderClient('tok', 'A1');
    const detail = await client.getOrderStatus(50);
    expect(detail?.exec_quantity).toBe(4);
    expect(detail?.avg_fill_price).toBe(0.85);
  });

  it('prefers exec_quantity over the fallback fill-quantity field names', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        order: { id: 51, status: 'canceled', exec_quantity: 7, fill_quantity: 99 },
      }),
    );
    const client = new TradierOrderClient('tok', 'A1');
    const detail = await client.getOrderStatus(51);
    expect(detail?.exec_quantity).toBe(7);
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

// ─── TRA-323: position imports ──────────────────────────────────────────────

describe('parseOccSymbol', () => {
  it('decodes a 2026 SPY call', () => {
    expect(parseOccSymbol('SPY260515C00450000')).toEqual({
      underlying: 'SPY',
      optionType: 'call',
      strike: 450,
      expiration: '2026-05-15',
    });
  });

  it('decodes a 2026 AAPL put with cents in the strike', () => {
    expect(parseOccSymbol('AAPL260920P00187500')).toEqual({
      underlying: 'AAPL',
      optionType: 'put',
      strike: 187.5,
      expiration: '2026-09-20',
    });
  });

  it('returns null for an equity ticker (no OCC suffix)', () => {
    expect(parseOccSymbol('AAPL')).toBeNull();
    expect(parseOccSymbol('SPY')).toBeNull();
  });

  it('pivots the 2-digit year correctly: 70+ → 1900s, <70 → 2000s', () => {
    expect(parseOccSymbol('AAPL690101C00100000')?.expiration).toBe('2069-01-01');
    expect(parseOccSymbol('AAPL700101C00100000')?.expiration).toBe('1970-01-01');
  });
});

describe('parseTradierPositions', () => {
  it('parses a single long option position into the imported shape', () => {
    const out = parseTradierPositions({
      positions: {
        position: {
          symbol: 'SPY260515C00450000',
          quantity: 2,
          cost_basis: 320,
          date_acquired: '2026-05-01T15:30:00.000Z',
          id: 12345,
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      optionSymbol: 'SPY260515C00450000',
      underlying: 'SPY',
      optionType: 'call',
      strike: 450,
      expiration: '2026-05-15',
      contracts: 2,
      premiumPaid: 1.6, // 320 / 2 / 100
      tradierPositionId: 12345,
    });
  });

  it('handles array of positions and drops equities + short legs', () => {
    const out = parseTradierPositions({
      positions: {
        position: [
          { symbol: 'AAPL', quantity: 100, cost_basis: 15000, date_acquired: '2026-04-01' }, // equity
          { symbol: 'SPY260515C00450000', quantity: 1, cost_basis: 200, date_acquired: '2026-05-01' },
          { symbol: 'AAPL260515P00187500', quantity: -1, cost_basis: 300, date_acquired: '2026-05-01' }, // short leg
          { symbol: 'AAPL260515P00187500', quantity: 0, cost_basis: 0, date_acquired: '2026-05-01' },   // closed row
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].optionSymbol).toBe('SPY260515C00450000');
  });

  it('returns [] when Tradier reports no open positions', () => {
    expect(parseTradierPositions({ positions: 'null' })).toEqual([]);
    expect(parseTradierPositions({ positions: null })).toEqual([]);
    expect(parseTradierPositions(null)).toEqual([]);
  });

  it('drops rows with missing or non-finite cost basis', () => {
    const out = parseTradierPositions({
      positions: {
        position: [
          { symbol: 'SPY260515C00450000', quantity: 1, cost_basis: 0, date_acquired: '2026-05-01' },
          { symbol: 'AAPL260920P00187500', quantity: 1, cost_basis: 250, date_acquired: '2026-05-01' },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].underlying).toBe('AAPL');
  });
});

describe('TradierOptionsClient.listOpenOptionPositions', () => {
  it('hits /accounts/{id}/positions and returns the parsed list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        positions: {
          position: {
            symbol: 'SPY260515C00450000',
            quantity: 2,
            cost_basis: 320,
            date_acquired: '2026-05-01T15:30:00.000Z',
          },
        },
      }),
    );
    const client = new TradierOptionsClient('tok', 'ACCT9', 'sandbox');
    const positions = await client.listOpenOptionPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].optionSymbol).toBe('SPY260515C00450000');
    expect(callUrl(0)).toBe('https://sandbox.tradier.com/v1/accounts/ACCT9/positions');
    const headers = callInit(0).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('targets the production base URL when env=production', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ positions: 'null' }));
    const client = new TradierOptionsClient('tok', 'ACCT9', 'production');
    expect(await client.listOpenOptionPositions()).toEqual([]);
    expect(callUrl(0).startsWith('https://api.tradier.com/v1')).toBe(true);
  });

  it('returns [] on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('boom', 500));
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.listOpenOptionPositions()).toEqual([]);
  });
});

// ─── TRA-3067: readOpenOptionPositions keeps the failure state ──────────────
//
// The method above is the reason this one exists: its `[]` is the SAME VALUE
// for "the account holds nothing" and "the request failed", so an instrument
// fed from it reads a 401 as "the broker is flat on every position we hold".
// These tests are the proof that the checked variant does not collapse the two
// — each pairs a failure with the real empty book and asserts they differ.
describe('TradierOptionsClient.readOpenOptionPositions (TRA-3067)', () => {
  it('a real EMPTY book is ok:true with no positions', async () => {
    // Tradier answers 2xx with the literal string `"null"` for an account
    // holding nothing. This is the only 2xx shape that may become an empty
    // success.
    fetchMock.mockResolvedValueOnce(jsonResponse({ positions: 'null' }));
    const client = new TradierOptionsClient('tok', 'A1');
    const read = await client.readOpenOptionPositions();
    expect(read).toEqual({ ok: true, positions: [] });
  });

  it('a non-2xx is ok:false — NOT an empty book', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('unauthorized', 401));
    const client = new TradierOptionsClient('tok', 'A1');
    const read = await client.readOpenOptionPositions();
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toBe('http_status');
    expect(read.detail).toContain('401');
  });

  it('a transport throw is ok:false', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const client = new TradierOptionsClient('tok', 'A1');
    const read = await client.readOpenOptionPositions();
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toBe('transport');
  });

  it('a non-JSON 200 body is ok:false, not an empty book', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('<html>maintenance</html>', 200));
    const client = new TradierOptionsClient('tok', 'A1');
    const read = await client.readOpenOptionPositions();
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toBe('transport');
  });

  it('a 2xx envelope with NO positions key is malformed, not empty', async () => {
    // `{}` and `{"positions":"null"}` are different statements: the second says
    // "I hold nothing", the first says nothing at all.
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = new TradierOptionsClient('tok', 'A1');
    const read = await client.readOpenOptionPositions();
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.reason).toBe('malformed');
  });

  it('parses a populated book the same way the unchecked read does', async () => {
    const body = {
      positions: {
        position: {
          symbol: 'SPY260515C00450000',
          quantity: 2,
          cost_basis: 320,
          date_acquired: '2026-05-01T15:30:00.000Z',
        },
      },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    const client = new TradierOptionsClient('tok', 'ACCT9', 'sandbox');
    const read = await client.readOpenOptionPositions();
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(read.positions).toEqual(await client.listOpenOptionPositions());
    expect(callUrl(0)).toBe('https://sandbox.tradier.com/v1/accounts/ACCT9/positions');
  });

  it('THE DISCRIMINATOR: a 500 and an empty book do not read alike', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('boom', 500));
    fetchMock.mockResolvedValueOnce(jsonResponse({ positions: 'null' }));
    const client = new TradierOptionsClient('tok', 'A1');
    const failed = await client.readOpenOptionPositions();
    const empty = await client.readOpenOptionPositions();
    expect(failed.ok).not.toBe(empty.ok);
    // …whereas the unchecked read cannot tell them apart at all, which is the
    // whole reason the checked one exists.
    fetchMock.mockResolvedValueOnce(textResponse('boom', 500));
    fetchMock.mockResolvedValueOnce(jsonResponse({ positions: 'null' }));
    expect(await client.listOpenOptionPositions()).toEqual(await client.listOpenOptionPositions());
  });
});

// ─── TRA-415: parseTradierEquityPositions + listOpenEquityPositions ─────────

describe('parseTradierEquityPositions', () => {
  it('keeps equity rows and drops option legs from a mixed payload', () => {
    const out = parseTradierEquityPositions({
      positions: {
        position: [
          { symbol: 'AAPL', quantity: 10, cost_basis: 1850, date_acquired: '2026-05-01T15:30:00.000Z', id: 7 },
          { symbol: 'SPY260515C00450000', quantity: 2, cost_basis: 320, date_acquired: '2026-05-01T15:30:00.000Z' },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      symbol: 'AAPL',
      quantity: 10,
      side: 'buy',
      costBasis: 185,
      tradierPositionId: 7,
    });
  });

  it('surfaces a negative-quantity row as a short with positive quantity', () => {
    const out = parseTradierEquityPositions({
      positions: {
        position: { symbol: 'TSLA', quantity: -3, cost_basis: -750, date_acquired: '2026-05-01' },
      },
    });
    expect(out).toEqual([
      { symbol: 'TSLA', quantity: 3, side: 'sell', costBasis: 250, acquiredAt: Date.parse('2026-05-01') },
    ]);
  });

  it('drops zero-quantity, non-finite, and non-positive cost-basis rows', () => {
    const out = parseTradierEquityPositions({
      positions: {
        position: [
          { symbol: 'A', quantity: 0, cost_basis: 100, date_acquired: '2026-05-01' },
          { symbol: 'B', quantity: 5, cost_basis: 0, date_acquired: '2026-05-01' },
          { symbol: '', quantity: 5, cost_basis: 100, date_acquired: '2026-05-01' },
        ],
      },
    });
    expect(out).toEqual([]);
  });

  it('returns [] for an empty / string-null envelope', () => {
    expect(parseTradierEquityPositions({ positions: 'null' })).toEqual([]);
    expect(parseTradierEquityPositions(null)).toEqual([]);
  });
});

describe('TradierOrderClient.listOpenEquityPositions', () => {
  it('hits /accounts/{id}/positions and returns the parsed equity list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        positions: {
          position: { symbol: 'MSFT', quantity: 4, cost_basis: 1680, date_acquired: '2026-05-01' },
        },
      }),
    );
    const client = new TradierOrderClient('tok', 'ACCT9', 'sandbox');
    const positions = await client.listOpenEquityPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe('MSFT');
    expect(callUrl(0)).toBe('https://sandbox.tradier.com/v1/accounts/ACCT9/positions');
  });

  it('returns [] on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('boom', 500));
    const client = new TradierOrderClient('tok', 'A1');
    expect(await client.listOpenEquityPositions()).toEqual([]);
  });
});

// ─── TRA-348: parseTradierHistory + listAccountHistory ──────────────────────

describe('parseTradierHistory', () => {
  it('parses a Sell-to-Close option trade event', () => {
    const out = parseTradierHistory({
      history: {
        event: {
          date: '2026-05-08T16:30:00.000Z',
          amount: 370,
          type: 'trade',
          id: 'tx-42',
          trade: {
            commission: 0,
            description: 'Sell to Close 2 SPY May 15 2026 $450 Call',
            price: 1.85,
            quantity: 2,
            symbol: 'SPY260515C00450000',
            trade_type: 'option',
          },
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      date: '2026-05-08',
      symbol: 'SPY260515C00450000',
      tradeType: 'option',
      description: 'Sell to Close 2 SPY May 15 2026 $450 Call',
      price: 1.85,
      quantity: 2,
      amount: 370,
      transactionId: 'tx-42',
    });
  });

  it('handles array of events and case-insensitive trade_type', () => {
    const out = parseTradierHistory({
      history: {
        event: [
          {
            date: '2026-05-08',
            amount: -300,
            type: 'trade',
            trade: {
              description: 'Buy to Open 2 SPY ...',
              price: 1.5,
              quantity: 2,
              symbol: 'SPY260515C00450000',
              trade_type: 'Option',
            },
          },
          {
            date: '2026-05-08',
            amount: 19000,
            type: 'trade',
            trade: {
              description: 'Sell 100 AAPL',
              price: 190,
              quantity: 100,
              symbol: 'AAPL',
              trade_type: 'EQUITY',
            },
          },
        ],
      },
    });
    expect(out).toHaveLength(2);
    expect(out[0].tradeType).toBe('option');
    expect(out[1].tradeType).toBe('equity');
  });

  it('synthesizes a transactionId when Tradier omits id', () => {
    const out = parseTradierHistory({
      history: {
        event: {
          date: '2026-05-08',
          type: 'trade',
          trade: {
            description: 'Sell to Close 2 SPY ...',
            price: 1.85,
            quantity: 2,
            symbol: 'SPY260515C00450000',
            trade_type: 'option',
          },
        },
      },
    });
    expect(out[0].transactionId).toContain('2026-05-08');
    expect(out[0].transactionId).toContain('SPY260515C00450000');
  });

  it('drops non-trade events (journal, dividend) and rows with bad fields', () => {
    const out = parseTradierHistory({
      history: {
        event: [
          { date: '2026-05-08', type: 'journal', amount: 100 },
          {
            date: '2026-05-08',
            type: 'trade',
            trade: { description: 'foo', price: 1, quantity: 0, symbol: 'X', trade_type: 'option' },
          },
          { date: '2026-05-08', type: 'trade' },
        ],
      },
    });
    expect(out).toEqual([]);
  });

  it('returns [] when history is null/empty', () => {
    expect(parseTradierHistory({ history: 'null' })).toEqual([]);
    expect(parseTradierHistory({ history: null })).toEqual([]);
    expect(parseTradierHistory(null)).toEqual([]);
  });

  it('extracts order_id from the trade object into orderId (TRA-2810)', () => {
    const out = parseTradierHistory({
      history: {
        event: {
          date: '2026-07-30',
          type: 'trade',
          trade: {
            commission: 1.4,
            description: 'Buy to Open 4 AAPL260904P00280000',
            price: 1.04,
            quantity: 4,
            symbol: 'AAPL260904P00280000',
            trade_type: 'option',
            order_id: 139283844,
          },
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.orderId).toBe(139283844);
  });

  it('sets orderId to null when order_id is absent (sandbox fills)', () => {
    const out = parseTradierHistory({
      history: {
        event: {
          date: '2026-05-08',
          type: 'trade',
          trade: {
            description: 'Sell to Close 2 SPY ...',
            price: 1.85,
            quantity: 2,
            symbol: 'SPY260515C00450000',
            trade_type: 'option',
          },
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.orderId).toBeNull();
  });
});

describe('TradierOptionsClient.listAccountHistory', () => {
  it('hits /accounts/{id}/history with start, end, type, limit', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        history: {
          event: {
            date: '2026-05-08',
            amount: 370,
            type: 'trade',
            id: 'tx-1',
            trade: {
              description: 'Sell to Close 2 SPY ...',
              price: 1.85,
              quantity: 2,
              symbol: 'SPY260515C00450000',
              trade_type: 'option',
            },
          },
        },
      }),
    );
    const client = new TradierOptionsClient('tok', 'ACCT9', 'production');
    const fills = await client.listAccountHistory({
      start: '2026-05-01',
      end: '2026-05-08',
      type: 'trade',
      limit: 100,
    });
    expect(fills).toHaveLength(1);
    expect(fills[0].symbol).toBe('SPY260515C00450000');
    const url = callUrl(0);
    expect(url).toContain('https://api.tradier.com/v1/accounts/ACCT9/history');
    expect(url).toContain('start=2026-05-01');
    expect(url).toContain('end=2026-05-08');
    expect(url).toContain('type=trade');
    expect(url).toContain('limit=100');
  });

  it('returns [] on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('boom', 500));
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.listAccountHistory({ start: '2026-05-01', end: '2026-05-08' })).toEqual([]);
  });
});

// ─── TRA-359: parseTradierCashEvents + listAccountCashEvents ────────────────

describe('parseTradierCashEvents (TRA-359)', () => {
  it('parses an ACH deposit event', () => {
    const out = parseTradierCashEvents({
      history: {
        event: {
          date: '2026-05-07T13:30:00.000Z',
          amount: 500,
          type: 'ach',
          id: 'ach-42',
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      date: '2026-05-07',
      type: 'ach',
      amount: 500,
      transactionId: 'ach-42',
    });
  });

  it('handles an array of mixed cash event types', () => {
    const out = parseTradierCashEvents({
      history: {
        event: [
          { date: '2026-05-01', type: 'ach', amount: 300, id: 'dep-1' },
          { date: '2026-05-07', type: 'WIRE', amount: 500, id: 'wire-1' },
          { date: '2026-05-10', type: 'dividend', amount: 1.23, id: 'div-1' },
          { date: '2026-05-11', type: 'fee', amount: -2.5, id: 'fee-1' },
          { date: '2026-05-12', type: 'withdrawal', amount: -100, id: 'wd-1' },
        ],
      },
    });
    expect(out).toHaveLength(5);
    expect(out.map(e => e.type)).toEqual(['ach', 'wire', 'dividend', 'fee', 'withdrawal']);
    expect(out[3].amount).toBe(-2.5);
  });

  it('drops trade events — those flow through parseTradierHistory', () => {
    const out = parseTradierCashEvents({
      history: {
        event: [
          {
            date: '2026-05-08',
            type: 'trade',
            amount: 370,
            trade: {
              description: 'Sell to Close 2 SPY ...',
              price: 1.85,
              quantity: 2,
              symbol: 'SPY260515C00450000',
              trade_type: 'option',
            },
          },
          { date: '2026-05-07', type: 'ach', amount: 500, id: 'dep-1' },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('ach');
  });

  it('synthesizes a transactionId when Tradier omits id', () => {
    const out = parseTradierCashEvents({
      history: {
        event: {
          date: '2026-05-07',
          type: 'ach',
          amount: 500,
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].transactionId).toContain('2026-05-07');
    expect(out[0].transactionId).toContain('ach');
    expect(out[0].transactionId).toContain('500');
  });

  it('drops events with non-finite amount', () => {
    const out = parseTradierCashEvents({
      history: {
        event: [
          { date: '2026-05-07', type: 'ach', amount: 'oops' as unknown as number, id: 'bad-1' },
          { date: '2026-05-07', type: 'ach', amount: Number.NaN, id: 'bad-2' },
          { date: '2026-05-07', type: 'ach', amount: 100, id: 'good' },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].transactionId).toBe('good');
  });

  it('returns [] when history is null / empty', () => {
    expect(parseTradierCashEvents({ history: 'null' })).toEqual([]);
    expect(parseTradierCashEvents({ history: null })).toEqual([]);
    expect(parseTradierCashEvents(null)).toEqual([]);
  });
});

describe('TradierOptionsClient.listAccountCashEvents (TRA-359)', () => {
  it('hits /accounts/{id}/history without a type filter so all event kinds come through', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        history: {
          event: [
            { date: '2026-05-07', type: 'ach', amount: 500, id: 'dep-1' },
            {
              date: '2026-05-08',
              type: 'trade',
              amount: 370,
              trade: {
                description: 'Sell to Close 2 SPY ...',
                price: 1.85,
                quantity: 2,
                symbol: 'SPY260515C00450000',
                trade_type: 'option',
              },
            },
          ],
        },
      }),
    );
    const client = new TradierOptionsClient('tok', 'ACCT9', 'production');
    const events = await client.listAccountCashEvents({
      start: '2026-05-01',
      end: '2026-05-14',
      limit: 500,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      date: '2026-05-07',
      type: 'ach',
      amount: 500,
      transactionId: 'dep-1',
    });
    const url = callUrl(0);
    expect(url).toContain('https://api.tradier.com/v1/accounts/ACCT9/history');
    expect(url).toContain('start=2026-05-01');
    expect(url).toContain('end=2026-05-14');
    expect(url).toContain('limit=500');
    expect(url).not.toContain('type=');
  });

  it('returns [] on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('boom', 500));
    const client = new TradierOptionsClient('tok', 'A1');
    expect(await client.listAccountCashEvents({ start: '2026-05-01', end: '2026-05-08' })).toEqual([]);
  });
});

// ─── TradierOptionsClient.submitMultilegOrder (TRA-912) ─────────────────────

describe('TradierOptionsClient.submitMultilegOrder', () => {
  // A bull put spread: sell the higher-strike put (short), buy the lower-strike
  // put (long protection) — a net-credit, defined-risk two-legger.
  const SHORT_PUT = 'AAPL260918P00190000';
  const LONG_PUT = 'AAPL260918P00185000';

  it('builds a class=multileg CREDIT order with per-leg sides (sell_to_open + buy_to_open)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 77, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'ACCT1');

    const order = await client.submitMultilegOrder(
      'AAPL',
      [
        { optionSymbol: SHORT_PUT, side: 'sell_to_open', quantity: 1 },
        { optionSymbol: LONG_PUT, side: 'buy_to_open', quantity: 1 },
      ],
      { type: 'credit', price: 1.234 },
    );

    expect(order).toEqual({ id: 77, status: 'ok' });
    expect(callUrl(0)).toBe('https://sandbox.tradier.com/v1/accounts/ACCT1/orders');
    expect(callInit(0).method).toBe('POST');

    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('class')).toBe('multileg');
    // Net price + type are TOP-level on multileg (contrast OTOCO's per-leg price).
    expect(params.get('symbol')).toBe('AAPL');
    expect(params.get('type')).toBe('credit');
    expect(params.get('duration')).toBe('day');
    expect(params.get('price')).toBe('1.23'); // rounded to the cent
    // Leg 0 — short put
    expect(params.get('option_symbol[0]')).toBe(SHORT_PUT);
    expect(params.get('side[0]')).toBe('sell_to_open');
    expect(params.get('quantity[0]')).toBe('1');
    // Leg 1 — long put
    expect(params.get('option_symbol[1]')).toBe(LONG_PUT);
    expect(params.get('side[1]')).toBe('buy_to_open');
    expect(params.get('quantity[1]')).toBe('1');
  });

  it('builds a CLOSE order with *_to_close sides and a DEBIT net', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 78, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'ACCT1');

    await client.submitMultilegOrder(
      'AAPL',
      [
        { optionSymbol: SHORT_PUT, side: 'buy_to_close', quantity: 2 },
        { optionSymbol: LONG_PUT, side: 'sell_to_close', quantity: 2 },
      ],
      { type: 'debit', price: 0.4 },
    );

    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('type')).toBe('debit');
    expect(params.get('price')).toBe('0.40');
    expect(params.get('side[0]')).toBe('buy_to_close');
    expect(params.get('side[1]')).toBe('sell_to_close');
    expect(params.get('quantity[0]')).toBe('2');
  });

  it('omits price for an EVEN (scratch) net', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 79, status: 'ok' } }));
    const client = new TradierOptionsClient('tok', 'ACCT1');
    await client.submitMultilegOrder(
      'AAPL',
      [
        { optionSymbol: SHORT_PUT, side: 'sell_to_open', quantity: 1 },
        { optionSymbol: LONG_PUT, side: 'buy_to_open', quantity: 1 },
      ],
      { type: 'even' },
    );
    const params = new URLSearchParams(callInit(0).body as string);
    expect(params.get('type')).toBe('even');
    expect(params.get('price')).toBeNull();
  });

  it('rejects a structurally invalid order (fewer than two legs) BEFORE any network call', async () => {
    const client = new TradierOptionsClient('tok', 'ACCT1');
    await expect(
      client.submitMultilegOrder('AAPL', [{ optionSymbol: SHORT_PUT, side: 'sell_to_open', quantity: 1 }], {
        type: 'credit',
        price: 1,
      }),
    ).rejects.toThrow(/at least two legs/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a debit/credit order with a non-positive net BEFORE any network call', async () => {
    const client = new TradierOptionsClient('tok', 'ACCT1');
    await expect(
      client.submitMultilegOrder(
        'AAPL',
        [
          { optionSymbol: SHORT_PUT, side: 'sell_to_open', quantity: 1 },
          { optionSymbol: LONG_PUT, side: 'buy_to_open', quantity: 1 },
        ],
        { type: 'credit', price: 0 },
      ),
    ).rejects.toThrow(/positive net price/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a broker reject envelope (insufficient buying power)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ errors: { error: 'insufficient buying power' } }),
    );
    const client = new TradierOptionsClient('tok', 'ACCT1');
    await expect(
      client.submitMultilegOrder(
        'AAPL',
        [
          { optionSymbol: SHORT_PUT, side: 'sell_to_open', quantity: 1 },
          { optionSymbol: LONG_PUT, side: 'buy_to_open', quantity: 1 },
        ],
        { type: 'credit', price: 1 },
      ),
    ).rejects.toThrow(/insufficient buying power/);
  });
});

// ─── TRA-1269 — live-equity chandelier stop-modify plumbing ─────────────────

describe('parseTradierOrderLegs (TRA-1269)', () => {
  it('parses a multi-leg OTOCO envelope and lowercases type/status', () => {
    const legs = parseTradierOrderLegs({
      order: {
        id: 100,
        leg: [
          { id: 101, type: 'LIMIT', side: 'sell', status: 'Open' },
          { id: 102, type: 'STOP', side: 'sell', status: 'open', stop_price: 94.5 },
        ],
      },
    });
    expect(legs).toHaveLength(2);
    const stop = legs.find(l => l.type === 'stop');
    expect(stop).toMatchObject({ id: 102, type: 'stop', status: 'open', stopPrice: 94.5 });
  });

  it('accepts a single-object leg (Tradier one-leg shape) and drops id-less rows', () => {
    expect(parseTradierOrderLegs({ order: { leg: { id: 7, type: 'stop', status: 'open' } } }))
      .toEqual([{ id: 7, type: 'stop', side: undefined, status: 'open', stopPrice: undefined }]);
    expect(parseTradierOrderLegs({ order: { leg: [{ type: 'stop', status: 'open' }] } })).toEqual([]);
    expect(parseTradierOrderLegs(null)).toEqual([]);
    expect(parseTradierOrderLegs({ order: {} })).toEqual([]);
  });
});

describe('TradierOrderClient.getOrderLegs (TRA-1269)', () => {
  it('GETs the order and returns its parsed legs', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ order: { id: 5, leg: [{ id: 6, type: 'stop', status: 'open', stop_price: 90 }] } }),
    );
    const client = new TradierOrderClient('tok', 'A1', 'production');
    const legs = await client.getOrderLegs(5);
    expect(callUrl(0)).toBe('https://api.tradier.com/v1/accounts/A1/orders/5');
    expect(callInit(0).method).toBe('GET');
    expect(legs).toEqual([{ id: 6, type: 'stop', side: undefined, status: 'open', stopPrice: 90 }]);
  });

  it('returns [] on a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('nope', 500));
    const client = new TradierOrderClient('tok', 'A1');
    expect(await client.getOrderLegs(5)).toEqual([]);
  });
});

describe('TradierOrderClient.changeStopPrice (TRA-1269)', () => {
  it('PUTs type=stop with the new stop price and default gtc duration', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 102, status: 'ok' } }));
    const client = new TradierOrderClient('tok', 'A1', 'production');
    const resp = await client.changeStopPrice(102, 96.128);
    expect(callUrl(0)).toBe('https://api.tradier.com/v1/accounts/A1/orders/102');
    const init = callInit(0);
    expect(init.method).toBe('PUT');
    const body = String(init.body);
    expect(body).toContain('type=stop');
    expect(body).toContain('duration=gtc');
    expect(body).toContain('stop=96.13'); // rounded to cents
    expect(resp).toEqual({ id: 102, status: 'ok' });
  });

  it('throws on a Tradier errors payload (never advances the stop on reject)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: { error: 'order not modifiable' } }));
    const client = new TradierOrderClient('tok', 'A1');
    await expect(client.changeStopPrice(102, 96)).rejects.toThrow(/order not modifiable/);
  });

  it('throws on a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('boom', 400));
    const client = new TradierOrderClient('tok', 'A1');
    await expect(client.changeStopPrice(102, 96)).rejects.toThrow(/stop-modify failed \(400\)/);
  });
});


// ─── parseTradierGainLoss / listGainLoss (TRA-2850) ─────────────────────────
//
// The gain/loss report is where real per-trade fees live: production history
// rows carry `commission: 0` on every fill, while a settled lot's `cost` is
// fees-INCLUDED and `proceeds` fees-NET. Same envelope quirks as history:
// 'null' string / single object / array.

describe('parseTradierGainLoss (TRA-2850)', () => {
  const rawLot = {
    symbol: 'AAPL260904P00280000',
    quantity: 1,
    cost: 104.11,
    proceeds: 277.87,
    gain_loss: 173.76,
    gain_loss_percent: 166.9,
    open_date: '2026-07-31T00:00:00.000Z',
    close_date: '2026-08-03T00:00:00.000Z',
    term: 3,
  };

  it('normalises a single closed_position object and slices dates to YYYY-MM-DD', () => {
    const lots = parseTradierGainLoss({ gainloss: { closed_position: rawLot } });
    expect(lots).toHaveLength(1);
    expect(lots[0]).toEqual({
      symbol: 'AAPL260904P00280000',
      quantity: 1,
      cost: 104.11,
      proceeds: 277.87,
      gainLoss: 173.76,
      openDate: '2026-07-31',
      closeDate: '2026-08-03',
    });
  });

  it("returns [] on the 'null' string envelope, a null payload, and an empty object", () => {
    expect(parseTradierGainLoss({ gainloss: 'null' })).toEqual([]);
    expect(parseTradierGainLoss(null)).toEqual([]);
    expect(parseTradierGainLoss({})).toEqual([]);
  });

  it('drops rows missing a coercible cost/proceeds/date rather than deriving a garbage fee', () => {
    const lots = parseTradierGainLoss({
      gainloss: {
        closed_position: [
          rawLot,
          { ...rawLot, cost: undefined },
          { ...rawLot, proceeds: 'n/a' },
          { ...rawLot, open_date: undefined },
          { ...rawLot, quantity: 0 },
        ] as never,
      },
    });
    expect(lots).toHaveLength(1);
  });

  it('falls back to proceeds − cost when gain_loss is absent, and abs()es a negative quantity', () => {
    const lots = parseTradierGainLoss({
      gainloss: { closed_position: { ...rawLot, gain_loss: undefined, quantity: -3 } as never },
    });
    expect(lots[0]!.gainLoss).toBeCloseTo(173.76, 6);
    expect(lots[0]!.quantity).toBe(3);
  });
});

describe('TradierOptionsClient.listGainLoss (TRA-2850)', () => {
  it('hits /accounts/{id}/gainloss with the window params and parses the envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      gainloss: {
        closed_position: [{
          symbol: 'SPY260904C00816000', quantity: 3, cost: 24.31, proceeds: 100,
          gain_loss: 75.69, open_date: '2026-07-31T00:00:00.000Z', close_date: '2026-08-03T00:00:00.000Z',
        }],
      },
    }));
    const client = new TradierOptionsClient('tok', 'A1', 'production');
    const lots = await client.listGainLoss({ start: '2026-07-31', end: '2026-08-04' });
    expect(callUrl(0)).toContain('/accounts/A1/gainloss?');
    expect(callUrl(0)).toContain('start=2026-07-31');
    expect(callUrl(0)).toContain('end=2026-08-04');
    expect(lots).toHaveLength(1);
    expect(lots[0]!.cost).toBeCloseTo(24.31, 6);
  });

  it('returns [] on a non-OK response instead of throwing into a scheduler tick', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('nope', 401));
    const client = new TradierOptionsClient('tok', 'A1', 'production');
    expect(await client.listGainLoss({ start: '2026-07-31', end: '2026-08-04' })).toEqual([]);
  });
});

// ─── TRA-2876: parseTradierCorporateActions ─────────────────────────────────
//
// The one non-trade event class that can corrupt a FIFO lot book is a SHARE
// COUNT that moves without a trade row. The board's live account carries one: a
// TDIC reverse split booked as an `adjustment` of −7 shares at $0, alongside two
// cash-only siblings (a "REVERSE SPLIT FEE" transfer at −$0.75 and a cash-in-lieu
// journal at +$2.07) that move money but no shares.
//
// Selection is by SHAPE (a non-zero nested `quantity`), never by description
// keyword — a phrase filter is what matched zero of this feed's 38 real option
// closes in TRA-2864, and a filter that matches nothing reads exactly like
// "nothing happened".

describe('parseTradierCorporateActions (TRA-2876)', () => {
  const splitRow = {
    date: '2026-06-09T00:00:00.000Z',
    amount: 0,
    type: 'adjustment',
    id: 'adj-1',
    adjustment: { description: 'REVERSE SPLIT - TDIC', quantity: -7 },
  };

  it('returns a share-count adjustment booked at zero cash', () => {
    const out = parseTradierCorporateActions({ history: { event: splitRow } });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      date: '2026-06-09',
      type: 'adjustment',
      description: 'REVERSE SPLIT - TDIC',
      quantity: -7,
      amount: 0,
      transactionId: 'adj-1',
    });
  });

  it('does NOT return the cash-only siblings of the same split', () => {
    // These move the balance, not a share count. They are cash flow, which
    // `parseTradierCashEvents` owns; returning them here would quarantine an
    // equity symbol over a 75-cent fee.
    const out = parseTradierCorporateActions({
      history: {
        event: [
          { date: '2026-06-09', amount: -0.75, type: 'transfer', id: 't-1', transfer: { description: 'REVERSE SPLIT FEE - TDIC', quantity: 0 } },
          { date: '2026-06-09', amount: 2.07, type: 'journal', id: 'j-1', journal: { description: 'CASH IN LIEU - TDIC' } },
          { date: '2026-06-09', amount: 500, type: 'ach', id: 'ach-1' },
        ],
      },
    });
    expect(out).toEqual([]);
  });

  it('ignores trade events entirely', () => {
    // Trades are the one thing the lot book already sees.
    const out = parseTradierCorporateActions({
      history: {
        event: {
          date: '2026-06-09',
          amount: -1.98,
          type: 'trade',
          id: 'tx-054',
          trade: { description: 'TDIC', quantity: 5, price: 0.3947, symbol: 'TDIC', trade_type: 'equity' },
        },
      },
    });
    expect(out).toEqual([]);
  });

  it('finds the quantity when the nested key is not named after the type', () => {
    // Belt and braces: we look under the type-named key first, then any other
    // nested object. Dropping the one event class this exists to catch, because
    // Tradier named the key something else, is the failure mode with no symptom.
    const out = parseTradierCorporateActions({
      history: {
        event: {
          date: '2026-06-09',
          amount: 0,
          type: 'corporate_action',
          id: 'ca-1',
          event_detail: { description: 'FORWARD SPLIT - LASE', quantity: 4 },
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(4);
    expect(out[0].description).toBe('FORWARD SPLIT - LASE');
  });

  it('synthesises a dedup id when Tradier omits one, and survives the empty shapes', () => {
    const [action] = parseTradierCorporateActions({
      history: { event: { date: '2026-06-09', amount: 0, type: 'adjustment', adjustment: { description: 'REVERSE SPLIT - TDIC', quantity: -7 } } },
    });
    expect(action.transactionId).toBe('2026-06-09|adjustment|-7|REVERSE SPLIT - TDIC');
    expect(parseTradierCorporateActions({ history: 'null' })).toEqual([]);
    expect(parseTradierCorporateActions({ history: null })).toEqual([]);
    expect(parseTradierCorporateActions(null)).toEqual([]);
  });

  it('listAccountCorporateActions THROWS on a failed read rather than reporting none', () => {
    // "No corporate actions in the window" and "we could not look" must not be
    // the same value: the caller withholds equity realized in the second case,
    // and an empty array would make a blind pass read as a clean one.
    fetchMock.mockResolvedValueOnce(textResponse('nope', 401));
    const client = new TradierOptionsClient('tok', 'A1', 'production');
    return expect(
      client.listAccountCorporateActions({ start: '2026-06-01', end: '2026-06-30' }),
    ).rejects.toThrow();
  });
});
