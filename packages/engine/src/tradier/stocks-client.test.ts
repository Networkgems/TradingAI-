import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradierStocksClient } from './stocks-client.js';

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({}));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TradierStocksClient.getQuotes', () => {
  it('returns an empty map when given no symbols (no HTTP call)', async () => {
    const client = new TradierStocksClient('tok');
    const out = await client.getQuotes([]);
    expect(out.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a multi-symbol Tradier quotes envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: {
        quote: [
          { symbol: 'AAPL', last: 195.25, change: 1.10, change_percentage: 0.57, volume: 50_123_456 },
          { symbol: 'MSFT', last: 422.80, change: -3.20, change_percentage: -0.75, volume: 22_345_678 },
        ],
      },
    }));
    const client = new TradierStocksClient('tok');
    const out = await client.getQuotes(['AAPL', 'MSFT']);
    expect(out.size).toBe(2);
    expect(out.get('AAPL')).toMatchObject({ price: 195.25, change: 1.10, changePct: 0.57, volume: 50_123_456 });
    expect(out.get('MSFT')).toMatchObject({ price: 422.80, change: -3.20, changePct: -0.75 });
    // Single round-trip with comma-separated symbols.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('symbols=AAPL%2CMSFT');
  });

  it('handles single-symbol response (Tradier collapses array to object)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: { quote: { symbol: 'AAPL', last: 195.25, change: 0, change_percentage: 0, volume: 1 } },
    }));
    const client = new TradierStocksClient('tok');
    const out = await client.getQuotes(['AAPL']);
    expect(out.size).toBe(1);
    expect(out.get('AAPL')!.price).toBe(195.25);
  });

  it('skips rows without a positive `last` price', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: {
        quote: [
          { symbol: 'AAPL', last: 0 },
          { symbol: 'MSFT', last: 422 },
        ],
      },
    }));
    const client = new TradierStocksClient('tok');
    const out = await client.getQuotes(['AAPL', 'MSFT']);
    expect(out.has('AAPL')).toBe(false);
    expect(out.has('MSFT')).toBe(true);
  });

  it('throws on non-2xx responses so the caller can fall back to a backup feed', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('rate limit', 429));
    const client = new TradierStocksClient('tok');
    await expect(client.getQuotes(['AAPL'])).rejects.toThrow(/HTTP 429/);
  });

  it('routes through the production base when env=production', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ quotes: { quote: [] } }));
    const client = new TradierStocksClient('tok', 'production');
    await client.getQuotes(['AAPL']);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/api\.tradier\.com\/v1\/markets\/quotes/);
  });

  // TRA-1980 — the L1 book (bid/ask + sizes) is now plumbed through for the
  // pre-trade liquidity gate. It must be carried when Tradier reports it and
  // stay absent (never a bogus 0) when it doesn't, so the gate can degrade.
  it('surfaces the L1 book (bid/ask + sizes) when the Tradier quote carries it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: {
        quote: {
          symbol: 'AAPL', last: 195.25, change: 0, change_percentage: 0, volume: 1,
          bid: 195.20, ask: 195.30, bidsize: 4, asksize: 7,
        },
      },
    }));
    const client = new TradierStocksClient('tok');
    const out = await client.getQuotes(['AAPL']);
    expect(out.get('AAPL')).toMatchObject({
      price: 195.25, bid: 195.20, ask: 195.30, bidSize: 4, askSize: 7,
    });
  });

  it('leaves L1 book fields absent when the Tradier quote omits them', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: { quote: { symbol: 'MSFT', last: 422.80, change: 0, change_percentage: 0, volume: 1 } },
    }));
    const client = new TradierStocksClient('tok');
    const q = (await client.getQuotes(['MSFT'])).get('MSFT')!;
    expect(q.bid).toBeUndefined();
    expect(q.ask).toBeUndefined();
    expect(q.bidSize).toBeUndefined();
    expect(q.askSize).toBeUndefined();
  });

  // TRA-3385 — Tradier serves the CBOE volatility index as bare `VIX`; the app's
  // universe uses Yahoo's `^VIX`. The alias must be REQUEST-SCOPED: `^VIX` goes
  // out on the wire as `VIX` and the row keys back under the spelling the caller
  // asked for — while a caller asking for bare `VIX` (readVix()'s TRA-586
  // fallback) still resolves under `VIX`. A blanket rewrite in either direction
  // breaks one of the two.
  it('aliases ^VIX to VIX on the wire and keys the row back under ^VIX', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: { quote: { symbol: 'VIX', last: 14.80, change: 0.20, change_percentage: 1.37, volume: 0 } },
    }));
    const client = new TradierStocksClient('tok');
    const out = await client.getQuotes(['^VIX']);
    expect(out.get('^VIX')).toMatchObject({ symbol: '^VIX', price: 14.80 });
    expect(out.has('VIX')).toBe(false); // request-scoped: only the asked-for spelling
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('symbols=VIX');
    expect(url).not.toContain(encodeURIComponent('^VIX'));
  });

  it('still resolves a bare VIX request under VIX (TRA-586 readVix fallback pinned)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: { quote: { symbol: 'VIX', last: 14.80, change: 0, change_percentage: 0, volume: 0 } },
    }));
    const client = new TradierStocksClient('tok');
    const out = await client.getQuotes(['VIX']);
    expect(out.get('VIX')).toMatchObject({ symbol: 'VIX', price: 14.80 });
    expect(out.has('^VIX')).toBe(false);
  });

  it('answers BOTH spellings from one wire symbol when both are requested', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: { quote: { symbol: 'VIX', last: 14.80, change: 0, change_percentage: 0, volume: 0 } },
    }));
    const client = new TradierStocksClient('tok');
    const out = await client.getQuotes(['^VIX', 'VIX', 'AAPL']);
    expect(out.get('^VIX')?.price).toBe(14.80);
    expect(out.get('VIX')?.price).toBe(14.80);
    // The wire request dedupes to a single VIX plus AAPL.
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`symbols=${encodeURIComponent('VIX,AAPL')}`);
  });

  // TRA-3412 — same defect as ^VIX, second subject. Tradier declares `^IXIC`
  // unknown under every Yahoo-ish spelling; its identifier for the Nasdaq
  // Composite is `COMP:GIDS` (measured on the production host, type:'index',
  // desc "NASDAQ Composite", 26588.488 vs NDX 29683.27 the same second).
  it('aliases ^IXIC to COMP:GIDS on the wire and keys the row back under ^IXIC', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: { quote: { symbol: 'COMP:GIDS', last: 26588.488, change: 143.04, change_percentage: 0.55, volume: 0 } },
    }));
    const client = new TradierStocksClient('tok');
    const out = await client.getQuotes(['^IXIC']);
    expect(out.get('^IXIC')).toMatchObject({ symbol: '^IXIC', price: 26588.488 });
    expect(out.has('COMP:GIDS')).toBe(false); // request-scoped, as for ^VIX
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`symbols=${encodeURIComponent('COMP:GIDS')}`);
    expect(url).not.toContain(encodeURIComponent('^IXIC'));
  });

  // The trap this alias had to dodge, pinned as a test. Bare `COMP` DOES
  // resolve on Tradier — to Compass Inc, a ~$12 stock. `^IXIC` must never be
  // routed there, and a caller asking for the real `COMP` equity must keep
  // getting the equity: the two are distinct wire symbols, so unlike ^VIX/VIX
  // they must NOT collapse onto one row.
  it('does not collide ^IXIC with the real COMP equity (Compass Inc)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: {
        quote: [
          { symbol: 'COMP:GIDS', last: 26588.488, change: 0, change_percentage: 0, volume: 0 },
          { symbol: 'COMP', last: 12.73, change: 0, change_percentage: 0, volume: 100 },
        ],
      },
    }));
    const client = new TradierStocksClient('tok');
    const out = await client.getQuotes(['^IXIC', 'COMP']);
    expect(out.get('^IXIC')?.price).toBe(26588.488);
    expect(out.get('COMP')?.price).toBe(12.73);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`symbols=${encodeURIComponent('COMP:GIDS,COMP')}`);
  });
});

// TRA-3385 (Remedy B) — Tradier answers the "which symbols can the primary
// never serve?" question on every batch call via `unmatched_symbols`; it was
// parsed and thrown away, making the un-servable class unmeasurable (TRA-2682).
describe('TradierStocksClient.getQuotesDetailed (unmatched_symbols surfaced)', () => {
  it('returns the unmatched set alongside the quote map (array shape)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: {
        quote: { symbol: 'AAPL', last: 195.25, change: 0, change_percentage: 0, volume: 1 },
        unmatched_symbols: { symbol: ['ARX.TO', 'BAYN.DE'] },
      },
    }));
    const client = new TradierStocksClient('tok');
    const { quotes, unmatchedSymbols } = await client.getQuotesDetailed(['AAPL', 'ARX.TO', 'BAYN.DE']);
    expect(quotes.get('AAPL')?.price).toBe(195.25);
    expect(unmatchedSymbols).toEqual(['ARX.TO', 'BAYN.DE']);
  });

  it('handles the collapsed single-string unmatched shape', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: {
        quote: { symbol: 'AAPL', last: 195.25, change: 0, change_percentage: 0, volume: 1 },
        unmatched_symbols: { symbol: 'ARX.TO' },
      },
    }));
    const client = new TradierStocksClient('tok');
    const { unmatchedSymbols } = await client.getQuotesDetailed(['AAPL', 'ARX.TO']);
    expect(unmatchedSymbols).toEqual(['ARX.TO']);
  });

  it('maps an unmatched wire spelling back to the requested spelling', async () => {
    // If Tradier ever fails to match the aliased wire symbol, the caller must
    // hear about it under the spelling THEY asked for, not the wire one.
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: { quote: [], unmatched_symbols: { symbol: 'VIX' } },
    }));
    const client = new TradierStocksClient('tok');
    const { unmatchedSymbols } = await client.getQuotesDetailed(['^VIX']);
    expect(unmatchedSymbols).toEqual(['^VIX']);
  });

  // TRA-3412 — same reverse mapping for the second alias. If Tradier ever
  // retires `COMP:GIDS`, the census must name `^IXIC` (what the universe holds),
  // not a wire spelling nobody can act on.
  it('maps an unmatched COMP:GIDS back to ^IXIC', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: { quote: [], unmatched_symbols: { symbol: 'COMP:GIDS' } },
    }));
    const client = new TradierStocksClient('tok');
    const { unmatchedSymbols } = await client.getQuotesDetailed(['^IXIC']);
    expect(unmatchedSymbols).toEqual(['^IXIC']);
  });

  it('returns an empty unmatched list when the field is absent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      quotes: { quote: { symbol: 'AAPL', last: 195.25, change: 0, change_percentage: 0, volume: 1 } },
    }));
    const client = new TradierStocksClient('tok');
    const { unmatchedSymbols } = await client.getQuotesDetailed(['AAPL']);
    expect(unmatchedSymbols).toEqual([]);
  });
});

describe('TradierStocksClient.getMinuteBars', () => {
  it('parses a timesales series into Candle objects, dropping in-progress and zero-volume rows', async () => {
    const now = Date.now();
    const minute = (offsetMin: number): number => Math.floor((now - offsetMin * 60_000) / 1000);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      series: {
        data: [
          // Three valid past-minute bars.
          { timestamp: minute(3), open: 100, high: 101, low: 99.5, close: 100.5, volume: 1234 },
          { timestamp: minute(2), open: 100.5, high: 101.2, low: 100.4, close: 101.1, volume: 2345 },
          { timestamp: minute(1), open: 101.1, high: 101.5, low: 100.9, close: 101.3, volume: 3456 },
          // In-progress bar (current minute) — should be dropped.
          { timestamp: minute(0), open: 101.3, high: 101.4, low: 101.2, close: 101.35, volume: 100 },
          // Zero-volume bar — dropped.
          { timestamp: minute(4), open: 99, high: 99, low: 99, close: 99, volume: 0 },
          // Missing OHLC — dropped.
          { timestamp: minute(5), open: 98, high: 98, close: 98, volume: 1 },
        ],
      },
    }));
    const client = new TradierStocksClient('tok');
    const bars = await client.getMinuteBars('AAPL', 60);
    expect(bars.length).toBe(3);
    // Sorted ascending by timestamp.
    expect(bars[0].timestamp).toBeLessThan(bars[1].timestamp);
    expect(bars[1].timestamp).toBeLessThan(bars[2].timestamp);
    expect(bars[bars.length - 1].close).toBe(101.3);
    expect(bars.every((b) => b.symbol === 'AAPL' && b.volume > 0)).toBe(true);
  });

  it('returns an empty list when the series is empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ series: '' }));
    const client = new TradierStocksClient('tok');
    expect(await client.getMinuteBars('AAPL', 30)).toEqual([]);
  });

  it('takes only the trailing `count` bars when the response is larger', async () => {
    const now = Date.now();
    const rows = Array.from({ length: 50 }, (_, i) => ({
      timestamp: Math.floor((now - (i + 1) * 60_000) / 1000),
      open: 100 + i,
      high: 100 + i + 0.5,
      low: 100 + i - 0.5,
      close: 100 + i,
      volume: 100 + i,
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ series: { data: rows } }));
    const client = new TradierStocksClient('tok');
    const bars = await client.getMinuteBars('AAPL', 10);
    expect(bars.length).toBe(10);
  });

  it('throws on non-2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('not authorised', 401));
    const client = new TradierStocksClient('tok');
    await expect(client.getMinuteBars('AAPL', 30)).rejects.toThrow(/HTTP 401/);
  });

  it('hits /markets/timesales with interval=1min and session_filter=open', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ series: { data: [] } }));
    const client = new TradierStocksClient('tok');
    await client.getMinuteBars('AAPL', 30);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/markets/timesales');
    expect(url).toContain('symbol=AAPL');
    expect(url).toContain('interval=1min');
    expect(url).toContain('session_filter=open');
  });

  // TRA-934 — `session_filter=open` returns only ~390 RTH min/day, so a deep pull
  // needs a multi-day calendar window or the trailing `count` bars don't exist.
  // The old flat `count×2`-minute window gave a 2400-bar request only ~3.3 calendar
  // days (~930 RTH min), starving the 1h confirm to ~15 bars (< the 30-bar floor)
  // and leaving the SupertrendConfluence shadow ledger permanently empty.
  const spanCalendarDays = (url: string): number => {
    const q = new URL(url).searchParams;
    const day = (k: string): number => Date.parse(`${(q.get(k) ?? '').slice(0, 10)}T00:00:00Z`);
    return (day('end') - day('start')) / 86_400_000;
  };

  it('widens a deep (multi-day) pull to an RTH-aware calendar window', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ series: { data: [] } }));
    const client = new TradierStocksClient('tok');
    await client.getMinuteBars('AAPL', 2400); // ~6 RTH trading days requested
    const span = spanCalendarDays(String(fetchMock.mock.calls[0][0]));
    // Must cover well over a week of calendar days so ≥6 RTH sessions (≥2400 RTH
    // minutes → ≥30 hourly confirm bars) are actually in range.
    expect(span).toBeGreaterThanOrEqual(8);
  });

  it('leaves the shallow hot-scan pull on the original tight window', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ series: { data: [] } }));
    const client = new TradierStocksClient('tok');
    await client.getMinuteBars('AAPL', 80); // intraday hot scan
    const span = spanCalendarDays(String(fetchMock.mock.calls[0][0]));
    // 80×2 minutes ≈ 0.11 days — same ET date (or one boundary crossing at most).
    expect(span).toBeLessThanOrEqual(1);
  });
});

describe('TradierStocksClient.getDailyBars (TRA-586)', () => {
  it('parses a daily history envelope into Candle objects', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      history: {
        day: [
          { date: '2026-05-18', open: 500, high: 505, low: 498, close: 503, volume: 70_000_000 },
          { date: '2026-05-19', open: 503, high: 508, low: 502, close: 507, volume: 65_000_000 },
        ],
      },
    }));
    const client = new TradierStocksClient('tok');
    const bars = await client.getDailyBars('SPY', 60);
    expect(bars.length).toBe(2);
    expect(bars[0].timestamp).toBeLessThan(bars[1].timestamp); // ascending
    expect(bars[1]).toMatchObject({ symbol: 'SPY', open: 503, high: 508, low: 502, close: 507 });
  });

  it('preserves zero-volume rows (cash indices report no daily volume)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      history: { day: { date: '2026-05-19', open: 100, high: 101, low: 99, close: 100.5, volume: 0 } },
    }));
    const client = new TradierStocksClient('tok');
    const bars = await client.getDailyBars('SPY', 60);
    expect(bars.length).toBe(1);
    expect(bars[0].volume).toBe(0);
  });

  it('returns an empty list when the history series is empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ history: 'null' }));
    const client = new TradierStocksClient('tok');
    expect(await client.getDailyBars('SPY', 60)).toEqual([]);
  });

  it('drops rows with missing OHLC', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      history: {
        day: [
          { date: '2026-05-18', open: 500, high: 505, close: 503, volume: 1 }, // no low
          { date: '2026-05-19', open: 503, high: 508, low: 502, close: 507, volume: 1 },
        ],
      },
    }));
    const client = new TradierStocksClient('tok');
    const bars = await client.getDailyBars('SPY', 60);
    expect(bars.length).toBe(1);
    expect(bars[0].close).toBe(507);
  });

  it('takes only the trailing `count` bars', async () => {
    const day = (i: number): string => `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
    const rows = Array.from({ length: 60 }, (_, i) => ({
      date: day(i), open: 100 + i, high: 100 + i + 1, low: 100 + i - 1, close: 100 + i, volume: 1000 + i,
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ history: { day: rows } }));
    const client = new TradierStocksClient('tok');
    const bars = await client.getDailyBars('SPY', 10);
    expect(bars.length).toBe(10);
  });

  it('throws on non-2xx responses so the caller can fall back', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('rate limit', 429));
    const client = new TradierStocksClient('tok');
    await expect(client.getDailyBars('SPY', 60)).rejects.toThrow(/HTTP 429/);
  });

  it('hits /markets/history with interval=daily', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ history: { day: [] } }));
    const client = new TradierStocksClient('tok');
    await client.getDailyBars('SPY', 60);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/markets/history');
    expect(url).toContain('symbol=SPY');
    expect(url).toContain('interval=daily');
  });

  it('returns [] without an HTTP call for a non-positive count', async () => {
    const client = new TradierStocksClient('tok');
    expect(await client.getDailyBars('SPY', 0)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
