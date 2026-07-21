import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradierOptionsClient } from '@trading-app/engine';
import {
  validateOptionsSmokeRequest,
  selectSmokeExpiry,
  selectAtmContract,
  buildDecisionQuote,
  referencePrice,
  computeLegMetrics,
  modeledRoundTripCommissionUsd,
  runContractRoundTrip,
  OPTIONS_SMOKE_UNDERLYINGS,
  SMOKE_MIN_DTE,
  SMOKE_MAX_DTE,
  type DecisionQuote,
  type LegTimeline,
} from './tradier-sandbox-options-smoke.js';
import type { TradierOptionsContract } from '@trading-app/engine';

// ── validateOptionsSmokeRequest (the route guards) ──────────────────────────

describe('validateOptionsSmokeRequest', () => {
  it('rejects a missing/wrong confirm token (400)', () => {
    expect(validateOptionsSmokeRequest({})).toMatchObject({ ok: false, status: 400 });
    expect(validateOptionsSmokeRequest({ confirm: 'sandbox', underlying: 'SPY' })).toMatchObject({
      ok: false,
      status: 400,
    });
    const r = validateOptionsSmokeRequest({ underlying: 'SPY' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/confirm must equal "SANDBOX"/);
  });

  it('rejects an off-allow-list underlying (400)', () => {
    const r = validateOptionsSmokeRequest({ confirm: 'SANDBOX', underlying: 'TSLA' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/not on the allow-list/);
    }
  });

  it('rejects qty > 1 and any non-1 qty (400)', () => {
    for (const qty of [2, 0, -1, 1.5, 10]) {
      const r = validateOptionsSmokeRequest({ confirm: 'SANDBOX', underlying: 'SPY', qty });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.error).toMatch(/hard-capped to 1/);
      }
    }
  });

  it('accepts SPY / AAPL (case-insensitive) with default qty 1', () => {
    for (const u of OPTIONS_SMOKE_UNDERLYINGS) {
      const r = validateOptionsSmokeRequest({ confirm: 'SANDBOX', underlying: u.toLowerCase() });
      expect(r).toEqual({ ok: true, underlying: u, qty: 1 });
    }
    // Explicit qty:1 is also allowed.
    expect(validateOptionsSmokeRequest({ confirm: 'SANDBOX', underlying: 'SPY', qty: 1 })).toEqual({
      ok: true,
      underlying: 'SPY',
      qty: 1,
    });
  });
});

// ── selectSmokeExpiry ───────────────────────────────────────────────────────

describe('selectSmokeExpiry', () => {
  const now = Date.parse('2026-07-21T00:00:00Z');
  it('picks the nearest expiry inside the DTE window', () => {
    // +1 (too soon), +4 (in window), +8 (in window), +20 (too far)
    const exps = ['2026-07-22', '2026-07-25', '2026-07-29', '2026-08-10'];
    expect(selectSmokeExpiry(exps, now)).toBe('2026-07-25');
  });
  it('returns null when only sub-min or over-max DTE expirations exist', () => {
    expect(selectSmokeExpiry(['2026-07-22', '2026-09-01'], now)).toBeNull();
  });
  it('honours the exact [MIN, MAX] boundaries', () => {
    const min = new Date(now + SMOKE_MIN_DTE * 86_400_000).toISOString().slice(0, 10);
    const max = new Date(now + SMOKE_MAX_DTE * 86_400_000).toISOString().slice(0, 10);
    expect(selectSmokeExpiry([max, min], now)).toBe(min); // nearest of the two
  });
});

// ── selectAtmContract ───────────────────────────────────────────────────────

function contract(strike: number, type: 'call' | 'put'): TradierOptionsContract {
  return {
    symbol: `SPY26X${strike}${type === 'call' ? 'C' : 'P'}`,
    optionSymbol: `SPY26X${strike}${type === 'call' ? 'C' : 'P'}`,
    underlying: 'SPY',
    description: '',
    option_type: type,
    strike,
    expiration_date: '2026-07-25',
  };
}

describe('selectAtmContract', () => {
  const chain = [contract(495, 'call'), contract(500, 'call'), contract(505, 'call'), contract(500, 'put')];
  it('picks the call closest to the underlying price', () => {
    expect(selectAtmContract(chain, 501, 'call')?.strike).toBe(500);
    expect(selectAtmContract(chain, 504, 'call')?.strike).toBe(505);
  });
  it('filters by option_type', () => {
    expect(selectAtmContract(chain, 500, 'put')?.strike).toBe(500);
    expect(selectAtmContract(chain, 500, 'put')?.option_type).toBe('put');
  });
  it('returns null when no contract of the type exists', () => {
    expect(selectAtmContract([contract(500, 'call')], 500, 'put')).toBeNull();
  });
});

// ── buildDecisionQuote / referencePrice ─────────────────────────────────────

describe('buildDecisionQuote', () => {
  it('computes mid / spread / spreadBps for a two-sided quote', () => {
    const q = buildDecisionQuote({ bid: 2.0, ask: 2.1, quoteTimeMs: 123 }, 1000);
    expect(q.mid).toBeCloseTo(2.05, 6);
    expect(q.spread).toBeCloseTo(0.1, 6);
    expect(q.spreadBps).toBeCloseTo((0.1 / 2.05) * 10_000, 3);
    expect(q.quoteTimeMs).toBe(123);
    expect(q.tSignal).toBe(1000);
  });
  it('does NOT fabricate a mid from a one-sided quote', () => {
    const q = buildDecisionQuote({ bid: 2.0, last: 2.05 }, 1000);
    expect(q.mid).toBeNull();
    expect(q.spread).toBeNull();
    expect(q.spreadBps).toBeNull();
  });
});

describe('referencePrice', () => {
  it('prefers the mid when two-sided', () => {
    expect(referencePrice({ bid: 100, ask: 102, last: 90 })).toBe(101);
  });
  it('falls back to last when one-sided', () => {
    expect(referencePrice({ bid: 0, ask: 0, last: 90 })).toBe(90);
  });
  it('returns null when nothing usable', () => {
    expect(referencePrice({})).toBeNull();
  });
});

// ── computeLegMetrics ───────────────────────────────────────────────────────

describe('computeLegMetrics', () => {
  const quote: DecisionQuote = {
    bid: 2.0,
    ask: 2.1,
    mid: 2.05,
    spread: 0.1,
    spreadBps: 487.8,
    quoteTimeMs: 1,
    tSignal: 1000,
  };
  const timeline: LegTimeline = { tSignal: 1000, tSubmit: 1120, tAck: 1200, tFill: 1900 };

  it('uses the ASK as the far touch for a buy', () => {
    const m = computeLegMetrics('buy', quote, timeline, 2.08);
    expect(m.latencyMs.signalToSubmit).toBe(120);
    expect(m.latencyMs.submitToAck).toBe(80);
    expect(m.latencyMs.ackToFill).toBe(700);
    expect(m.slippage.fillMinusMid).toBeCloseTo(0.03, 6);
    expect(m.slippage.fillMinusFarTouch).toBeCloseTo(2.08 - 2.1, 6); // vs ask
    expect(m.withinSpread).toBe(true);
  });

  it('uses the BID as the far touch for a sell', () => {
    const m = computeLegMetrics('sell', quote, timeline, 2.02);
    expect(m.slippage.fillMinusFarTouch).toBeCloseTo(2.02 - 2.0, 6); // vs bid
    expect(m.withinSpread).toBe(true);
  });

  it('flags a fill outside the spread', () => {
    expect(computeLegMetrics('buy', quote, timeline, 2.20).withinSpread).toBe(false);
  });

  it('yields null slippage / ackToFill when the fill or terminal ts is missing', () => {
    const noFill = computeLegMetrics('buy', quote, { ...timeline, tFill: null }, null);
    expect(noFill.slippage.fillMinusMid).toBeNull();
    expect(noFill.slippage.fillMinusFarTouch).toBeNull();
    expect(noFill.withinSpread).toBeNull();
    expect(noFill.latencyMs.ackToFill).toBeNull();
  });
});

describe('modeledRoundTripCommissionUsd', () => {
  it('charges commission on both sides (entry + exit), no half-spread', () => {
    // DEFAULT_COST_MODEL.commissionPerContract = 0.65 → 0.65 * 2 * 1 = 1.30
    expect(modeledRoundTripCommissionUsd(1)).toBeCloseTo(1.3, 6);
  });
});

// ── runContractRoundTrip — fetch-mock happy path ────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({}));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * URL-dispatching Tradier sandbox mock. Two POSTed orders get ids 111 (the buy)
 * and 222 (the sell); their status polls report `filled` with distinct fill
 * prices so the realized round-trip is computable.
 */
function installSandboxMock(): void {
  let orderSeq = 0;
  fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/markets/options/expirations')) {
      return jsonResponse({ expirations: { date: ['2026-07-25', '2026-08-20'] } });
    }
    if (u.includes('/markets/options/chains')) {
      return jsonResponse({
        options: {
          option: [
            { symbol: 'SPY260725C00495000', underlying: 'SPY', description: '', option_type: 'call', strike: 495, expiration_date: '2026-07-25' },
            { symbol: 'SPY260725C00500000', underlying: 'SPY', description: '', option_type: 'call', strike: 500, expiration_date: '2026-07-25' },
            { symbol: 'SPY260725P00500000', underlying: 'SPY', description: '', option_type: 'put', strike: 500, expiration_date: '2026-07-25' },
          ],
        },
      });
    }
    if (u.includes('/markets/quotes')) {
      // Underlying SPY quote (mid 500) or the option quote (mid 2.05).
      if (u.includes('symbols=SPY&') || /symbols=SPY$/.test(u)) {
        return jsonResponse({ quotes: { quote: { symbol: 'SPY', bid: 499, ask: 501, last: 500 } } });
      }
      return jsonResponse({ quotes: { quote: { symbol: 'OPT', bid: 2.0, ask: 2.1, last: 2.05, trade_date: 42 } } });
    }
    if (u.includes('/orders') && method === 'POST') {
      orderSeq += 1;
      const id = orderSeq === 1 ? 111 : 222;
      return jsonResponse({ order: { id, status: 'ok' } });
    }
    if (/\/orders\/\d+$/.test(u) && method === 'GET') {
      const id = Number(/\/orders\/(\d+)$/.exec(u)?.[1]);
      const avg = id === 111 ? 2.08 : 2.02;
      return jsonResponse({ order: { id, status: 'filled', avg_fill_price: avg, exec_quantity: 1 } });
    }
    return jsonResponse({});
  });
}

describe('runContractRoundTrip (fetch-mock happy path)', () => {
  it('round-trips a call: buy_to_open → filled → sell_to_close → filled, with metrics', async () => {
    installSandboxMock();
    const client = new TradierOptionsClient('tok', 'VA20296703', 'sandbox');
    // Monotonic injected clock (+10ms per read) anchored near "now" so the
    // 2026-07-25 expiry lands in the [3,10] DTE window; no-op sleep = instant poll.
    let t = Date.parse('2026-07-21T00:00:00Z');
    const deps = {
      clock: () => (t += 10),
      sleep: async () => {},
      waitOptions: { timeoutMs: 5000, intervalMs: 10 },
    };

    const result = await runContractRoundTrip(client, 'SPY', 'call', 1, deps);

    expect(result.ok).toBe(true);
    expect(result.optionType).toBe('call');
    expect(result.contract?.strike).toBe(500); // ATM to SPY mid 500
    expect(result.contract?.optionSymbol).toBe('SPY260725C00500000');
    expect(result.entry?.status).toBe('filled');
    expect(result.exit?.status).toBe('filled');
    expect(result.entry?.avgFillPrice).toBe(2.08);
    expect(result.exit?.avgFillPrice).toBe(2.02);
    // (2.02 − 2.08) * 100 * 1 − 1.30 = −7.30
    expect(result.realizedRoundTripUsd).toBeCloseTo(-7.3, 6);
    expect(result.modeledCommissionUsd).toBeCloseTo(1.3, 6);
    // signalToSubmit is our code path — must be finite & non-negative.
    expect(result.entry?.metrics.latencyMs.signalToSubmit).toBeGreaterThanOrEqual(0);
    expect(result.entry?.metrics.withinSpread).toBe(true);

    // The buy leg posted a class=option buy_to_open on the ATM contract.
    const postCalls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    const entryBody = new URLSearchParams((postCalls[0][1] as RequestInit).body as string);
    expect(entryBody.get('class')).toBe('option');
    expect(entryBody.get('side')).toBe('buy_to_open');
    expect(entryBody.get('option_symbol')).toBe('SPY260725C00500000');
    expect(entryBody.get('quantity')).toBe('1');
    const exitBody = new URLSearchParams((postCalls[1][1] as RequestInit).body as string);
    expect(exitBody.get('side')).toBe('sell_to_close');
  });

  it('returns { ok:false, error } (no throw) when no expiry falls in the DTE window', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).includes('/markets/options/expirations')) {
        return jsonResponse({ expirations: { date: ['2026-12-31'] } }); // far LEAPS only
      }
      return jsonResponse({});
    });
    const client = new TradierOptionsClient('tok', 'VA20296703', 'sandbox');
    const deps = { clock: () => Date.parse('2026-07-21T00:00:00Z'), sleep: async () => {} };
    const result = await runContractRoundTrip(client, 'SPY', 'put', 1, deps);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(new RegExp(`\\[${SMOKE_MIN_DTE}, ${SMOKE_MAX_DTE}\\] DTE`));
  });
});
