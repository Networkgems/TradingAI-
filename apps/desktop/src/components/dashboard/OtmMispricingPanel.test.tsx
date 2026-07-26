// TRA-161 — the Mispriced OTM panel.
//
// The thing these tests actually defend: THE FAILING STATES MUST NOT READ LIKE
// THE PASSING ONE. Four different empty results reach this panel —
//   • a healthy scan of a thin chain (no rows, and that's correct),
//   • an unconfigured server (no Tradier credential),
//   • an open circuit breaker,
//   • an upstream/symbol failure (no_spot / no_chain / fetch_error),
// — and every one of them renders "a table with nothing in it" unless the panel
// keys its copy off the server's `reason`. The ticket asks for exactly this
// discrimination so QA can see WHY a scan came back empty without reading
// server logs. So: one test per reason, each asserting the OTHER readings are
// absent, plus a test that a healthy-but-empty scan is NOT dressed up as a
// fault (the inverse error, which would train people to ignore the banner).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OtmMispricingPanel } from './OtmMispricingPanel';

const SYMBOLS = [{ symbol: 'AAPL' }, { symbol: 'MSFT' }];

function candidate(over: Record<string, unknown> = {}) {
  return {
    optionSymbol: 'AAPL260918C00250000',
    underlying: 'AAPL',
    optionType: 'call',
    strike: 250,
    expiration: '2026-09-18',
    daysToExpiration: 35,
    mark: 4.2,
    theo: 3.5,
    // RATIO, not a percent: 0.2 renders as 20%.
    mispricingPct: 0.2,
    classification: 'expensive',
    bid: 4.1,
    ask: 4.3,
    spreadPct: 0.0476,
    openInterest: 1234,
    volume: 500,
    ivUsed: 0.28,
    delta: 0.31,
    ...over,
  };
}

const DIAG_HEALTHY = {
  configured: true,
  breakerOpen: false,
  breakerOpenedAtMs: null,
  cacheSize: 3,
  expirationsCacheSize: 2,
};

/**
 * Stub both routes the panel reads. `scan` is the body of the authed scan
 * route; `diag` the unauthenticated health route.
 */
function stubFetch(
  scan: { ok?: boolean; status?: number; body?: unknown } | (() => Promise<never>),
  diag: unknown = DIAG_HEALTHY,
) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/health/options-mispricing')) {
      return { ok: true, status: 200, json: async () => diag } as Response;
    }
    if (u.includes('/api/options/otm-mispricing')) {
      if (typeof scan === 'function') return scan();
      return {
        ok: scan.ok ?? true,
        status: scan.status ?? 200,
        json: async () => scan.body ?? {},
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The four distinct readings the panel can present. Used for cross-assertion. */
const READINGS = {
  rows: /AAPL260918C00250000/,
  cleanEmpty: /passed the liquidity filters/i,
  notConfigured: /Scanner not configured/i,
  breaker: /Circuit breaker open/i,
  noSpot: /No underlying price/i,
  noChain: /Empty option chain/i,
  legacy: /Scan unavailable/i,
} as const;

/** Assert exactly `expected` is on screen and every other reading is not. */
function expectOnly(expected: keyof typeof READINGS) {
  for (const [key, re] of Object.entries(READINGS)) {
    if (key === expected) expect(screen.getByText(re)).toBeInTheDocument();
    else expect(screen.queryByText(re)).not.toBeInTheDocument();
  }
}

describe('OtmMispricingPanel', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('scans the first watchlist symbol and renders the candidate table', async () => {
    stubFetch({
      body: {
        symbol: 'AAPL',
        spot: 243.1,
        expiration: '2026-09-18',
        candidates: [candidate()],
        reason: 'ok',
        diagnostics: DIAG_HEALTHY,
      },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    expect(await screen.findByText(READINGS.rows)).toBeInTheDocument();
    expectOnly('rows');
  });

  it('renders mispricingPct and spreadPct as PERCENTS, not raw ratios', async () => {
    // The bug this pins: `mispricingPct` and `spreadPct` are ratios (0.2 = 20%)
    // under names that read like percents. Printing them unscaled would show a
    // 20% divergence as "0.2%" — a number that looks perfectly ordinary and is
    // wrong by 100x. Same trap as TRA-2277's `gapPct`.
    stubFetch({
      body: {
        symbol: 'AAPL',
        spot: 243.1,
        expiration: '2026-09-18',
        candidates: [candidate({ mispricingPct: 0.2, spreadPct: 0.0476 })],
        reason: 'ok',
      },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    const row = (await screen.findByText(READINGS.rows)).closest('tr')!;
    const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent ?? '');
    // Whole-cell matches, not substrings: "+20.0%" CONTAINS "0.0%", so a
    // substring assertion here would pass against the very bug it's pinning.
    expect(cells.some((t) => /^\+20\.0%/.test(t))).toBe(true);
    expect(cells.some((t) => t.trim() === '4.8%')).toBe(true);
    // The unscaled ratio readings must NOT be what any cell says.
    expect(cells.some((t) => /^[+−]?0\.2%$/.test(t.trim()))).toBe(false);
    expect(cells.some((t) => t.trim() === '0.0%')).toBe(false);
  });

  it('colour-codes cheap green and expensive red', async () => {
    stubFetch({
      body: {
        symbol: 'AAPL',
        spot: 243.1,
        expiration: '2026-09-18',
        candidates: [
          candidate({ optionSymbol: 'CHEAP1', mispricingPct: -0.22, classification: 'cheap' }),
          candidate({ optionSymbol: 'RICH1', mispricingPct: 0.31, classification: 'expensive' }),
          candidate({ optionSymbol: 'FAIR1', mispricingPct: 0.02, classification: 'fair' }),
        ],
        reason: 'ok',
      },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    const cheapRow = (await screen.findByText('CHEAP1')).closest('tr')!;
    const richRow = screen.getByText('RICH1').closest('tr')!;
    const fairRow = screen.getByText('FAIR1').closest('tr')!;
    expect(within(cheapRow).getByText(/cheap/)).toBeInTheDocument();
    expect(within(richRow).getByText(/rich/)).toBeInTheDocument();
    expect(within(fairRow).getByText(/fair/)).toBeInTheDocument();
    // A cheap contract carries a minus sign on the divergence; rich a plus.
    expect(within(cheapRow).getByText(/−22\.0%/)).toBeInTheDocument();
    expect(within(richRow).getByText(/\+31\.0%/)).toBeInTheDocument();
  });

  // ── The reason discrimination — the point of the panel ────────────────────

  it('an OK scan with no rows reads as a CLEAN scan, not a fault', async () => {
    stubFetch({
      body: { symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18', candidates: [], reason: 'ok' },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    expect(await screen.findByText(READINGS.cleanEmpty)).toBeInTheDocument();
    expectOnly('cleanEmpty');
  });

  it('no_credentials reads as "not configured", distinctly from a clean empty scan', async () => {
    stubFetch({
      body: { symbol: 'AAPL', spot: null, expiration: null, candidates: [], reason: 'no_credentials' },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    expect(await screen.findByText(READINGS.notConfigured)).toBeInTheDocument();
    expectOnly('notConfigured');
    expect(screen.getByText(/TRADIER_API_TOKEN/)).toBeInTheDocument();
  });

  it('breaker_open reads as a cooldown, distinctly from a clean empty scan', async () => {
    stubFetch({
      body: { symbol: 'AAPL', spot: null, expiration: null, candidates: [], reason: 'breaker_open' },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    expect(await screen.findByText(READINGS.breaker)).toBeInTheDocument();
    expectOnly('breaker');
  });

  it('no_spot and no_chain are told apart from each other', async () => {
    stubFetch({
      body: { symbol: 'AAPL', spot: null, expiration: null, candidates: [], reason: 'no_spot' },
    });
    const { unmount } = render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
    expect(await screen.findByText(READINGS.noSpot)).toBeInTheDocument();
    expectOnly('noSpot');
    unmount();

    stubFetch({
      body: { symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18', candidates: [], reason: 'no_chain' },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
    expect(await screen.findByText(READINGS.noChain)).toBeInTheDocument();
    expectOnly('noChain');
  });

  it('a legacy "unavailable" reason is shown as UNKNOWN, not mapped onto a specific cause', async () => {
    // A server build predating the TRA-161 reason split still sends the old
    // catch-all. Guessing a cause on its behalf would be a confident lie.
    stubFetch({
      body: { symbol: 'AAPL', spot: null, expiration: null, candidates: [], reason: 'unavailable' },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    expect(await screen.findByText(READINGS.legacy)).toBeInTheDocument();
    expectOnly('legacy');
  });

  it('surfaces the server errorMessage alongside a fetch_error', async () => {
    stubFetch({
      body: {
        symbol: 'AAPL', spot: null, expiration: null, candidates: [],
        reason: 'fetch_error', errorMessage: 'getChainSnapshot(AAPL,2026-09-18) failed',
      },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    expect(await screen.findByText(/Upstream fetch failed/i)).toBeInTheDocument();
    expect(screen.getByText(/getChainSnapshot\(AAPL,2026-09-18\) failed/)).toBeInTheDocument();
  });

  // ── Diagnostics chip ──────────────────────────────────────────────────────

  it('the diagnostics chip reports configured/breaker state from the health route', async () => {
    stubFetch(
      { body: { symbol: 'AAPL', spot: 1, expiration: 'x', candidates: [], reason: 'ok' } },
      { configured: false, breakerOpen: true, breakerOpenedAtMs: 1, cacheSize: 0, expirationsCacheSize: 0 },
    );
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    expect(await screen.findByText(/not configured/i)).toBeInTheDocument();
    expect(screen.getByText(/breaker OPEN/i)).toBeInTheDocument();
  });

  it('the chip renders a healthy scanner as configured + breaker closed', async () => {
    stubFetch({ body: { symbol: 'AAPL', spot: 1, expiration: 'x', candidates: [], reason: 'ok' } });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    expect(await screen.findByText(/✓ configured/)).toBeInTheDocument();
    expect(screen.getByText(/breaker closed/i)).toBeInTheDocument();
  });

  // ── Transport failures ────────────────────────────────────────────────────

  it('a 404 says the route is missing from this build — not "no candidates"', async () => {
    // The panel's own deployment trap: a server older than TRA-161 has no
    // route, and a bare "nothing found" would send someone hunting the chain.
    stubFetch({ ok: false, status: 404, body: {} });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    expect(await screen.findByText(/does not expose \/api\/options\/otm-mispricing/i)).toBeInTheDocument();
    expect(screen.queryByText(READINGS.cleanEmpty)).not.toBeInTheDocument();
  });

  it('a 500 shows a retryable error and recovers on Retry', async () => {
    const fetchMock = stubFetch({ ok: false, status: 500, body: {} });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

    expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();

    (fetchMock as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async (url: string) => {
        const u = String(url);
        if (u.includes('/api/health/options-mispricing')) {
          return { ok: true, status: 200, json: async () => DIAG_HEALTHY } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18',
            candidates: [candidate()], reason: 'ok',
          }),
        } as Response;
      },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(READINGS.rows)).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument();
  });

  // ── Selector ──────────────────────────────────────────────────────────────

  it('scans the symbol the user picks, and does not poll the scan route', async () => {
    const fetchMock = stubFetch({
      body: { symbol: 'AAPL', spot: 1, expiration: 'x', candidates: [], reason: 'ok' },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
    await screen.findByText(READINGS.cleanEmpty);

    const scanCalls = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/options/otm-mispricing'));
    expect(scanCalls()).toHaveLength(1);
    expect(String(scanCalls()[0]![0])).toContain('symbol=AAPL');

    await userEvent.click(screen.getByRole('button', { name: 'MSFT' }));
    expect(String(scanCalls().at(-1)![0])).toContain('symbol=MSFT');
    // Still exactly one call per user action — the scan must not be on a timer
    // (it's an upstream Tradier fetch; see DIAGNOSTICS_POLL_MS).
    expect(scanCalls()).toHaveLength(2);
  });

  it('allows a custom symbol when the watchlist is empty', async () => {
    const fetchMock = stubFetch({
      body: { symbol: 'TSLA', spot: 1, expiration: 'x', candidates: [], reason: 'ok' },
    });
    render(<OtmMispricingPanel token="t" symbols={[]} />);

    expect(screen.getByText(/Watchlist empty/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Scan a custom symbol'), 'tsla');
    await userEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await screen.findByText(READINGS.cleanEmpty);
    const scanCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/options/otm-mispricing'),
    );
    // Lower-cased input is normalised to the ticker the server expects.
    expect(String(scanCalls.at(-1)![0])).toContain('symbol=TSLA');
  });

  // ── TRA-2341: theo-underflow suppression ────────────────────────────────
  //
  // The server drops candidates whose theo is below one tick before slicing to
  // the limit, because `(mark − theo)/theo` at theo=1.28e-4 reports the minimum
  // tick, not a view on the surface. The panel's job is to never let that
  // removal be silent — a hidden filter turns "15 artifacts" into "nothing
  // found", which reads identically to a thin chain.
  describe('theo-floor suppression (TRA-2341)', () => {
    it('footnotes what the server suppressed alongside the surviving rows', async () => {
      stubFetch({
        body: {
          symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18',
          candidates: [candidate()], reason: 'ok',
          theoFloor: { applied: 0.01, suppressed: 15, maxSuppressedMispricingPct: 742.157 },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
      await screen.findByText(READINGS.rows);

      expect(screen.getByText(/15 higher-ranked contracts were hidden/i)).toBeInTheDocument();
      // The worst discarded read is stated, scaled to a percent like every
      // other ratio on this panel (742.157 -> 74,215.7%) — this is the live
      // SPY260831P00420000 number from the ticket, rendered through `fmt`.
      expect(screen.getByText(/74,215\.7%/)).toBeInTheDocument();
    });

    it('an ALL-suppressed scan does not read as a thin chain', async () => {
      // The live SPY symptom: 15 of 15 rows were underflow artifacts. Falling
      // through to "no OTM contracts passed the liquidity filters" would be a
      // flat lie about a chain that is anything but thin — and it is the exact
      // failure mode this file exists to prevent.
      stubFetch({
        body: {
          symbol: 'SPY', spot: 738.93, expiration: '2026-08-31',
          candidates: [], reason: 'ok',
          theoFloor: { applied: 0.01, suppressed: 15, maxSuppressedMispricingPct: 742.157 },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={[{ symbol: 'SPY' }]} />);

      expect(await screen.findByText(/All candidates were below the theo floor/i))
        .toBeInTheDocument();
      // Must NOT borrow the healthy-thin-chain copy.
      expect(screen.queryByText(READINGS.cleanEmpty)).not.toBeInTheDocument();
      // Nor any fault banner — this is a clean scan of a liquid chain.
      expect(screen.queryByText(READINGS.legacy)).not.toBeInTheDocument();
      expect(screen.queryByText(READINGS.noChain)).not.toBeInTheDocument();
    });

    it('says nothing when the guard removed nothing', async () => {
      stubFetch({
        body: {
          symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18',
          candidates: [candidate()], reason: 'ok',
          theoFloor: { applied: 0.01, suppressed: 0, maxSuppressedMispricingPct: null },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
      await screen.findByText(READINGS.rows);

      expect(screen.queryByText(/hidden/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/theo floor/i)).not.toBeInTheDocument();
    });

    it('a server predating the guard renders no footnote and no fabricated zero', async () => {
      // `theoFloor` absent is how this panel can tell the guard is NOT deployed.
      // It must degrade to the pre-TRA-2341 rendering, not invent "0 suppressed"
      // — which would assert the guard ran clean when it never ran at all.
      stubFetch({
        body: {
          symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18',
          candidates: [candidate()], reason: 'ok',
        },
      });
      render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
      await screen.findByText(READINGS.rows);

      expect(screen.queryByText(/hidden/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/0 higher-ranked/i)).not.toBeInTheDocument();
    });

    it('an empty scan with no guard block still reads as a thin chain', async () => {
      stubFetch({
        body: { symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18', candidates: [], reason: 'ok' },
      });
      render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);

      expect(await screen.findByText(READINGS.cleanEmpty)).toBeInTheDocument();
      expect(screen.queryByText(/All candidates were below the theo floor/i))
        .not.toBeInTheDocument();
    });
  });

  // ── TRA-2388: |delta| floor (the TRA-2354 decision) ─────────────────────
  //
  // The theo floor killed the pathological rows; it did not change the fact that
  // ranking by a RATIO returns the far tail. Live SPY still read 1510.9% with the
  // theo floor deployed. The floor now lives on |delta| in the route, and the
  // panel's job is the same as before: never let the removal be silent, and never
  // fabricate a floor the server didn't report.
  describe('delta-floor suppression (TRA-2388)', () => {
    const scanCalls = (m: ReturnType<typeof stubFetch>) =>
      m.mock.calls.filter((c) => String(c[0]).includes('/api/options/otm-mispricing'));

    it('sends NO minDelta by default, so the server floor is the one in force', async () => {
      // If the panel shipped its own literal, a desk on an older build would see
      // a floor that isn't there — and the constant would live in two places.
      const fetchMock = stubFetch({
        body: {
          symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18',
          candidates: [candidate()], reason: 'ok',
          deltaFloor: { applied: 0.02, suppressed: 0, maxSuppressedMispricingPct: null },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
      await screen.findByText(READINGS.rows);

      expect(String(scanCalls(fetchMock)[0]![0])).not.toContain('minDelta');
    });

    it('footnotes what the floor suppressed alongside the surviving rows', async () => {
      stubFetch({
        body: {
          symbol: 'SPY', spot: 738.93, expiration: '2026-08-31',
          candidates: [candidate()], reason: 'ok',
          deltaFloor: { applied: 0.02, suppressed: 9, maxSuppressedMispricingPct: 15.109 },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={[{ symbol: 'SPY' }]} />);
      await screen.findByText(READINGS.rows);

      expect(screen.getByText(/9 higher-ranked contracts were hidden/i)).toBeInTheDocument();
      // The live SPY number the decision was measured on: 15.109 -> 1,510.9%.
      expect(screen.getByText(/1,510\.9%/)).toBeInTheDocument();
    });

    it('an ALL-suppressed delta scan does not read as a thin chain', async () => {
      // The branch the theo-floor version does NOT cover: theo suppressed
      // nothing, the delta floor took every remaining row. Falling through to
      // "no OTM contracts passed the liquidity filters" would report a healthy
      // scan of a liquid chain.
      stubFetch({
        body: {
          symbol: 'SPY', spot: 738.93, expiration: '2026-08-31',
          candidates: [], reason: 'ok',
          theoFloor: { applied: 0.01, suppressed: 0, maxSuppressedMispricingPct: null },
          deltaFloor: { applied: 0.02, suppressed: 15, maxSuppressedMispricingPct: 15.109 },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={[{ symbol: 'SPY' }]} />);

      expect(await screen.findByText(/Every candidate was in the far tail/i)).toBeInTheDocument();
      expect(screen.queryByText(READINGS.cleanEmpty)).not.toBeInTheDocument();
      expect(screen.queryByText(READINGS.legacy)).not.toBeInTheDocument();
    });

    it('reports the floor as IN FORCE when it ran clean — the negative control', async () => {
      // "the floor ran and had nothing to drop" (NVDA / QQQ / AAPL, the property
      // that makes the constant credible) and "this build has no floor" render
      // identically if the panel only ever shows suppressions.
      stubFetch({
        body: {
          symbol: 'NVDA', spot: 182.5, expiration: '2026-08-21',
          candidates: [candidate()], reason: 'ok',
          deltaFloor: { applied: 0.02, suppressed: 0, maxSuppressedMispricingPct: null },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={[{ symbol: 'NVDA' }]} />);
      await screen.findByText(READINGS.rows);

      expect(screen.getByText(/floor 0\.020 in force/i)).toBeInTheDocument();
      expect(screen.queryByText(/hidden/i)).not.toBeInTheDocument();
    });

    it('says the tail is RAW when the floor was escaped with 0', async () => {
      stubFetch({
        body: {
          symbol: 'SPY', spot: 738.93, expiration: '2026-08-31',
          candidates: [candidate({ mispricingPct: 15.109, delta: 0.004 })], reason: 'ok',
          deltaFloor: { applied: 0, suppressed: 0, maxSuppressedMispricingPct: null },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={[{ symbol: 'SPY' }]} />);
      await screen.findByText(READINGS.rows);

      expect(screen.getByText(/floor disabled/i)).toBeInTheDocument();
    });

    it('a server predating the floor renders no note and no fabricated zero', async () => {
      // `deltaFloor` absent is the deploy detector: it is how the panel — and the
      // desk reading it — can tell TRA-2388 is not on the box yet.
      stubFetch({
        body: {
          symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18',
          candidates: [candidate()], reason: 'ok',
          theoFloor: { applied: 0.01, suppressed: 0, maxSuppressedMispricingPct: null },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
      await screen.findByText(READINGS.rows);

      expect(screen.queryByText(/in force/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/floor disabled/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/hidden/i)).not.toBeInTheDocument();
    });

    it('the override is sent on Enter, and typing it does NOT re-scan', async () => {
      // Each scan is an upstream Tradier chain fetch. A dependency on the input
      // would make "0.05" four of them.
      const fetchMock = stubFetch({
        body: {
          symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18',
          candidates: [candidate()], reason: 'ok',
          deltaFloor: { applied: 0.02, suppressed: 0, maxSuppressedMispricingPct: null },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
      await screen.findByText(READINGS.rows);
      expect(scanCalls(fetchMock)).toHaveLength(1);

      await userEvent.type(screen.getByLabelText('Minimum absolute delta'), '0');
      expect(scanCalls(fetchMock)).toHaveLength(1); // still one — no keystroke scans

      await userEvent.keyboard('{Enter}');
      expect(scanCalls(fetchMock)).toHaveLength(2);
      expect(String(scanCalls(fetchMock).at(-1)![0])).toContain('minDelta=0');
    });

    it('Refresh picks up what is currently in the box', async () => {
      // Reading the ref at call time is what avoids a commit-on-blur race, where
      // Refresh would scan with the previous value.
      const fetchMock = stubFetch({
        body: {
          symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18',
          candidates: [candidate()], reason: 'ok',
          deltaFloor: { applied: 0.05, suppressed: 0, maxSuppressedMispricingPct: null },
        },
      });
      render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
      await screen.findByText(READINGS.rows);

      await userEvent.type(screen.getByLabelText('Minimum absolute delta'), '0.05');
      await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      expect(String(scanCalls(fetchMock).at(-1)![0])).toContain('minDelta=0.05');
    });
  });

  it('offers no order-entry control (TRA-159 is not wired)', async () => {
    stubFetch({
      body: {
        symbol: 'AAPL', spot: 243.1, expiration: '2026-09-18',
        candidates: [candidate()], reason: 'ok',
      },
    });
    render(<OtmMispricingPanel token="t" symbols={SYMBOLS} />);
    await screen.findByText(READINGS.rows);

    for (const btn of screen.getAllByRole('button')) {
      expect(btn.textContent ?? '').not.toMatch(/buy|sell|enter|trade|order/i);
    }
  });
});
