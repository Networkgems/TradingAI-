// TRA-4707 — Tradier stream panel: connection state + per-symbol quote age that
// turns stale strictly above 2s. The body is pure (payload + two clocks), so the
// boundary and the between-poll ageing are asserted without timers; the
// container is exercised with a stubbed fetch for its honesty states.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  TradierStreamBody,
  TradierStreamPanel,
  gradeStreamRows,
  isStreamPayload,
  formatLatencyCell,
  type StreamPayload,
} from './TradierStreamPanel';

const T = 1_758_200_000_000;

function connected(over: Partial<Extract<StreamPayload, { enabled: true }>> = {}): StreamPayload {
  return {
    enabled: true,
    state: 'connected',
    flag: 'ENABLE_TRADIER_STREAM',
    flagOn: true,
    reconnects: 0,
    lastConnectedAt: T - 60_000,
    lastDisconnectedAt: null,
    lastMessageAt: T,
    lastError: null,
    staleAfterMs: 2000,
    quotesReceived: 42,
    quotesOverLatencyBudget: 0,
    latencyBudgetMs: 500,
    maxLatencyMs: 120,
    subscribedSymbols: 3,
    quotedSymbols: 2,
    staleSymbols: 1,
    generatedAt: T,
    symbols: [
      { symbol: 'AAPL', ageMs: null, stale: true, neverQuoted: true, eventTime: null, receivedAt: null, latencyMs: null },
      { symbol: 'QQQ', ageMs: 1500, stale: false, neverQuoted: false, eventTime: T - 1500, receivedAt: T - 1400, latencyMs: 100 },
      { symbol: 'SPY', ageMs: 200, stale: false, neverQuoted: false, eventTime: T - 200, receivedAt: T - 150, latencyMs: 50 },
    ],
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gradeStreamRows', () => {
  it('uses the strict >2000ms boundary: exactly 2000ms is fresh, 2001ms is stale', () => {
    const p = connected();
    // Local fetch at 10_000; QQQ is 1500ms old at the server's generatedAt.
    const at = (localNow: number) => Object.fromEntries(gradeStreamRows(p, 10_000, localNow).map((r) => [r.symbol, r]));
    expect(at(10_500)['QQQ']).toMatchObject({ ageMs: 2000, stale: false });
    expect(at(10_501)['QQQ']).toMatchObject({ ageMs: 2001, stale: true });
  });

  it('ages quotes between polls — a server that stops answering turns every row stale', () => {
    const p = connected();
    const rows = gradeStreamRows(p, 10_000, 10_000 + 60_000);
    expect(rows.every((r) => r.stale)).toBe(true);
  });

  it('never-quoted symbols read stale with no age', () => {
    const rows = gradeStreamRows(connected(), 0, 0);
    expect(rows.find((r) => r.symbol === 'AAPL')).toEqual({ symbol: 'AAPL', ageMs: null, stale: true, neverQuoted: true });
  });

  it('is immune to local clock skew: ages are graded on the server clock', () => {
    const p = connected();
    // Local clock 5 minutes behind the server — only the elapsed time since the fetch counts.
    const rows = gradeStreamRows(p, T - 300_000, T - 300_000);
    expect(rows.find((r) => r.symbol === 'SPY')).toMatchObject({ ageMs: 200, stale: false });
  });
});

describe('TradierStreamBody', () => {
  it('renders the connection state and flags a stale row', () => {
    render(<TradierStreamBody payload={connected()} fetchedAtLocal={0} localNow={1000} />);
    expect(screen.getByTestId('stream-state')).toHaveTextContent('Connected');
    // QQQ: 1500 + 1000 = 2500ms → stale; SPY: 1200ms → fresh; AAPL never quoted → stale.
    expect(screen.getByTestId('stream-row-QQQ')).toHaveAttribute('data-stale', 'true');
    expect(screen.getByTestId('stream-row-QQQ')).toHaveTextContent('2.5s · stale');
    expect(screen.getByTestId('stream-row-SPY')).toHaveAttribute('data-stale', 'false');
    expect(screen.getByTestId('stream-row-SPY')).toHaveTextContent('1.2s');
    expect(screen.getByTestId('stream-row-AAPL')).toHaveTextContent('no quote · stale');
    expect(screen.getByTestId('stream-stale-count')).toHaveTextContent('2 / 3');
  });

  for (const [state, label] of [
    ['reconnecting', 'Reconnecting'],
    ['disconnected', 'Disconnected'],
    ['connecting', 'Connecting'],
  ] as const) {
    it(`renders ${state}`, () => {
      render(<TradierStreamBody payload={connected({ state, lastError: 'socket closed 1006' })} fetchedAtLocal={0} localNow={0} />);
      expect(screen.getByTestId('stream-state')).toHaveTextContent(label);
      expect(screen.getByText('socket closed 1006')).toBeInTheDocument();
    });
  }

  it('renders DISABLED with its reason and no symbol table', () => {
    const disabled: StreamPayload = {
      enabled: false, state: 'disabled', reason: 'flag_off', flag: 'ENABLE_TRADIER_STREAM',
      flagOn: false, staleAfterMs: 2000, generatedAt: T,
    };
    render(<TradierStreamBody payload={disabled} fetchedAtLocal={0} localNow={0} />);
    expect(screen.getByTestId('stream-state')).toHaveTextContent('Disabled');
    expect(screen.getByTestId('stream-disabled-reason')).toHaveTextContent(/ENABLE_TRADIER_STREAM is off/);
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('TradierStreamPanel (container)', () => {
  it('fetches the stream route with the bearer token and renders it', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(connected()), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    render(<TradierStreamPanel token="tok" />);
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/market-data\/stream$/);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('an unrecognised payload reads as an error, never as a blank Disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: 'green' }), { status: 200 }))));
    render(<TradierStreamPanel token="t" />);
    expect(await screen.findByText(/not recognised/)).toBeInTheDocument();
    expect(screen.queryByText('Disabled')).toBeNull();
  });

  it('surfaces an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 503 }))));
    render(<TradierStreamPanel token="t" />);
    expect(await screen.findByText(/Could not load stream status \(HTTP 503\)/)).toBeInTheDocument();
  });
});

// TRA-4782 — the panel must not let "the server never published it" and "the
// server measured nothing" share a cell, and must not let a broken stamp read as
// feed latency.
describe('TRA-4782 latency split + symbol cap in the panel', () => {
  it('formatLatencyCell keeps all three states apart — absent ≠ unmeasured ≠ 0ms', () => {
    expect(formatLatencyCell(undefined)).toBe('not published');
    expect(formatLatencyCell(null)).toBe('no sample');
    expect(formatLatencyCell(0)).toBe('0ms');
    expect(formatLatencyCell(40_000)).toBe('40000ms');
  });

  it('an OLD server (fields absent) reads "not published", never 0ms and never a clean bill of health', () => {
    render(<TradierStreamBody payload={connected()} fetchedAtLocal={0} localNow={0} />);
    expect(screen.getByTestId('stream-latency-percentiles')).toHaveTextContent('not published / not published');
    // Absent counters render no row at all rather than a zero that reads as "none excluded".
    expect(screen.queryByTestId('stream-stale-eventtime')).toBeNull();
    expect(screen.queryByTestId('stream-symbol-limit')).toBeNull();
    expect(screen.getByTestId('stream-row-SPY')).toHaveAttribute('data-stale-eventtime', 'unknown');
  });

  it('a current server publishes p50/p95, the excluded counts, and the cap', () => {
    render(
      <TradierStreamBody
        payload={connected({
          quotesReceived: 786,
          quotesLatencyGraded: 780,
          quotesWithStaleEventTime: 6,
          quotesWithFutureEventTime: 0,
          quotesOverLatencyBudget: 778,
          maxLatencyMs: 55_000,
          latencyP50Ms: 35_600,
          latencyP95Ms: 49_000,
          latencySampleSize: 5000,
          latencySanityBoundMs: 600_000,
          subscribedSymbols: 25,
          symbolsBeforeLimit: 822,
          symbolLimit: 25,
          symbolsFromLadder: 25,
          symbolsOffLadder: 0,
          symbols: [
            { symbol: 'SPY', ageMs: 35_600, stale: true, neverQuoted: false, eventTime: T - 35_600, receivedAt: T, latencyMs: 35_600, staleEventTime: false },
            { symbol: 'FLYYQ', ageMs: 1, stale: true, neverQuoted: false, eventTime: T - 10_800_000_000, receivedAt: T, latencyMs: 10_800_000_000, staleEventTime: true },
          ],
        })}
        fetchedAtLocal={0}
        localNow={0}
      />,
    );
    expect(screen.getByTestId('stream-latency-percentiles')).toHaveTextContent('35600ms / 49000ms (n=5000)');
    expect(screen.getByTestId('stream-stale-eventtime')).toHaveTextContent('6 stale · 0 future');
    expect(screen.getByTestId('stream-symbol-limit')).toHaveTextContent('25 / 822 (cap 25)');
    // The broken stamp is labelled as one — it is NOT the feed running 126 days late.
    expect(screen.getByTestId('stream-row-FLYYQ')).toHaveAttribute('data-stale-eventtime', 'true');
    expect(screen.getByTestId('stream-row-FLYYQ')).toHaveTextContent(/stale stamp/);
    expect(screen.getByTestId('stream-row-SPY')).not.toHaveTextContent(/stale stamp/);
  });

  it('an uncapped current server says so rather than leaving the cap unstated', () => {
    render(
      <TradierStreamBody
        payload={connected({ subscribedSymbols: 822, symbolsBeforeLimit: 822, symbolLimit: null })}
        fetchedAtLocal={0}
        localNow={0}
      />,
    );
    expect(screen.getByTestId('stream-symbol-limit')).toHaveTextContent('822 / 822 (no cap)');
    expect(screen.queryByTestId('stream-symbol-limit-error')).toBeNull();
  });

  it('a garbage cap is shown as an error — it must not read as a deliberate "no cap"', () => {
    render(
      <TradierStreamBody
        payload={connected({
          subscribedSymbols: 822, symbolsBeforeLimit: 822, symbolLimit: null,
          symbolLimitRaw: 'twenty-five',
          symbolLimitError: 'TRADIER_STREAM_SYMBOL_LIMIT="twenty-five" is not an integer >= 1 — NO cap applied',
        })}
        fetchedAtLocal={0}
        localNow={0}
      />,
    );
    expect(screen.getByTestId('stream-symbol-limit-error')).toHaveTextContent(/twenty-five/);
  });
});

describe('isStreamPayload', () => {
  it('accepts both arms and rejects foreign shapes', () => {
    expect(isStreamPayload(connected())).toBe(true);
    expect(isStreamPayload({ enabled: false, state: 'disabled', reason: 'token_missing' })).toBe(true);
    expect(isStreamPayload({ enabled: false, state: 'disabled', reason: 'bogus' })).toBe(false);
    expect(isStreamPayload({ enabled: true, state: 'green', generatedAt: 1, symbols: [] })).toBe(false);
    expect(isStreamPayload(null)).toBe(false);
  });
});
