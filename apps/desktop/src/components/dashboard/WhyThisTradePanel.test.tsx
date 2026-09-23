// TRA-4654 — "Why This Trade?" decision panel component.
//
// The render-budget acceptance is asserted here where it bites: the PURE body
// component is timed over a fully-populated payload. The container's honesty
// states (loading / 404-evicted / error) are exercised with a stubbed fetch —
// a 404 must read as "the card aged out", never as an empty panel.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DecisionPanelBody, WhyThisTradePanel } from './WhyThisTradePanel';
import type { DecisionPanelPayload } from '../../types/decision-panel';

// TRA-4813 — the body REQUIRES a dispatch: an enabled button with no handler
// is the defect the wiring removed. Tests that only assert rendering pass a
// spy and (where the test is about the buttons) assert it fires.
const noop = () => {};

const NOW = Date.now();

function fullPayload(over: Partial<DecisionPanelPayload> = {}): DecisionPanelPayload {
  return {
    schemaVersion: 1,
    signalId: 'sig-1',
    assembledAt: NOW,
    assemblyMs: 2.1,
    header: {
      symbol: 'SPY',
      signalType: 'otm_mispricing',
      setupLabel: 'OTM mispricing (long premium)',
      setupFamily: 'options_mispricing',
      instrument: 'option',
      regime: 'risk_on',
      regimeEnabled: true,
      regimeAsOf: '2026-09-18',
      disposition: 'proposal_only',
    },
    checklist: {
      status: 'verified',
      data: {
        side: 'buy',
        orderType: 'limit',
        limitPrice: 0.5,
        criteria: [
          { name: 'mispricing', description: 'theo 0.65 vs mark 0.50', pass: true },
          { name: 'two_sided_quote', description: 'bid 0.48 / ask 0.52', pass: true },
        ],
        allPass: true,
      },
      missing: [],
    },
    freshness: {
      status: 'verified',
      data: { firedAt: NOW - 60_000, ageMs: 60_000, freshnessCeilingMs: 900_000, fresh: true, quoteAsOf: NOW - 2_000 },
      missing: [],
    },
    risk: {
      status: 'verified',
      data: {
        entry: 0.5,
        stop: 0.3,
        takeProfit: 1.0,
        exitRule: null,
        rewardRisk: 2.5,
        quantity: 25,
        unit: 'contracts',
        maxLossAtStopUsd: 500,
        maxLossHardUsd: 1_250,
        costR: 0.21,
        holdingPeriod: { minDays: 1, maxDays: 35 },
        gaps: [],
      },
      missing: [],
    },
    contract: {
      status: 'verified',
      data: {
        selection: {
          kind: 'option',
          symbol: 'SPY',
          optionSymbol: 'SPY261023C00700000',
          optionType: 'call',
          strike: 700,
          expiration: '2026-10-23',
          delta: 0.1,
        },
        liquidity: { grade: 'good', reasons: [], spreadFrac: 0.08, edgeToSpread: 3.75, openInterest: 500, volume: 120 },
      },
      missing: [],
    },
    portfolio: {
      status: 'verified',
      data: {
        openPositionCount: 3,
        sameSymbolCount: 2,
        sameSymbolNotionalUsd: 6_120,
        sameSymbolPctOfEquity: 0.1224,
        sameSetupCount: 1,
        netDeltaSharesSameSymbol: 30,
        deltaUnknownCount: 0,
        proposedNotionalUsd: 1_250,
        proposedPctOfEquity: 0.025,
        correlation: { status: 'not_computed', reason: 'no correlation source wired' },
      },
      missing: [],
    },
    similarTrades: {
      status: 'verified',
      data: {
        matchedBy: 'setup_and_symbol',
        n: 2,
        wins: 1,
        losses: 1,
        unknownOutcome: 0,
        totalPnlUsd: 60,
        recent: [
          { symbol: 'SPY', closedAt: NOW - 86_400_000, pnlUsd: -60, source: 'options_book' },
          { symbol: 'SPY', closedAt: NOW - 3 * 86_400_000, pnlUsd: 120, source: 'options_book' },
        ],
        excludedNoSetup: 1,
      },
      missing: [],
    },
    confidence: null,
    actions: {
      paperTrade: { enabled: true, reason: null },
      requireApproval: { enabled: true, reason: null },
      autoExecute: { enabled: false, reason: 'no calibrated confidence; no execution path from a panel' },
    },
    complete: true,
    incompleteSections: [],
    cardComplete: true,
    cardIncompleteFields: [],
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DecisionPanelBody — one synchronous pass over the server payload', () => {
  it('renders every section of a complete panel: setup, regime, checklist, risk, contract, portfolio, history, actions', () => {
    render(<DecisionPanelBody panel={fullPayload()} onAction={noop} />);
    expect(screen.getAllByText('SPY').length).toBeGreaterThan(0);
    expect(screen.getByText('Regime: risk_on')).toBeTruthy();
    expect(screen.getByText('confidence: not calibrated')).toBeTruthy();
    // Checklist with pass/fail evidence.
    expect(screen.getByText('mispricing')).toBeTruthy();
    expect(screen.getByText('theo 0.65 vs mark 0.50')).toBeTruthy();
    // Risk: max-dollar loss headline.
    expect(screen.getByText('Max loss at stop')).toBeTruthy();
    expect(screen.getByText('$500.00')).toBeTruthy();
    // Contract + liquidity grade.
    expect(screen.getByText('SPY261023C00700000')).toBeTruthy();
    expect(screen.getByText('good')).toBeTruthy();
    // Portfolio impact with the honest correlation posture.
    expect(screen.getByText('Symbol concentration')).toBeTruthy();
    expect(screen.getByText('correlation: not computed')).toBeTruthy();
    // History summary.
    expect(screen.getByText(/2 prior \(SPY \+ setup\): 1W \/ 1L/)).toBeTruthy();
    // Action intents: paper + approval live, auto-execute hard-disabled.
    expect((screen.getByText('Paper Trade') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText('Require Approval') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText('Auto-Execute') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an incomplete section names its missing inputs instead of rendering blanks', () => {
    const payload = fullPayload({
      portfolio: { status: 'incomplete', data: null, missing: ['positions', 'totalEquityUsd'] },
      complete: false,
      incompleteSections: ['portfolio'],
    });
    render(<DecisionPanelBody panel={payload} onAction={noop} />);
    expect(screen.getByText('Not assembled — missing positions, totalEquityUsd')).toBeTruthy();
  });

  it('a stale signal renders flagged, never hidden', () => {
    const payload = fullPayload({
      freshness: {
        status: 'verified',
        data: { firedAt: NOW - 7_200_000, ageMs: 7_200_000, freshnessCeilingMs: 900_000, fresh: false, quoteAsOf: null },
        missing: [],
      },
    });
    render(<DecisionPanelBody panel={payload} onAction={noop} />);
    expect(screen.getByText(/STALE — older than this setup's 15min ceiling/)).toBeTruthy();
    expect(screen.getByText('no quote timestamp')).toBeTruthy();
  });

  it('an unknown net delta is stated as unknown with the uncounted positions named — never zero', () => {
    const payload = fullPayload();
    payload.portfolio.data!.netDeltaSharesSameSymbol = null;
    payload.portfolio.data!.deltaUnknownCount = 2;
    render(<DecisionPanelBody panel={payload} onAction={noop} />);
    expect(screen.getByText('unknown (2 positions without delta)')).toBeTruthy();
  });

  // TRA-4654 (2026-09-22): the risk box used to render nothing at all when a
  // single upstream field was absent. The known numbers must survive, and each
  // blank must carry the server's reason for being blank.
  it('a refused sizing still shows entry/stop/target and explains the blank cells in the card\'s words', () => {
    const payload = fullPayload();
    payload.risk = {
      status: 'incomplete',
      data: {
        ...payload.risk.data!,
        quantity: 0,
        maxLossAtStopUsd: 0,
        maxLossHardUsd: null,
        gaps: [
          {
            field: 'sizing',
            kind: 'refused',
            reasons: ['risk budget $41.66 buys 0 contracts at $75.63 risk/contract'],
          },
        ],
      },
      missing: ['sizing refused: risk budget $41.66 buys 0 contracts at $75.63 risk/contract'],
    };
    render(<DecisionPanelBody panel={payload} onAction={noop} />);
    // The numbers that ARE known are still on screen.
    expect(screen.getByText('0.50')).toBeTruthy();
    expect(screen.getByText('0.30')).toBeTruthy();
    // And the blank is explained, not left as a dash.
    expect(screen.getByTestId('wtt-risk-gaps').textContent).toContain('buys 0 contracts');
    expect(screen.getByTestId('wtt-risk-gaps').textContent).toContain('refused');
  });

  it('an unbuildable cell reads "not built" — never a fabricated number, never an empty box', () => {
    const payload = fullPayload();
    payload.risk = {
      status: 'incomplete',
      data: {
        ...payload.risk.data!,
        stop: null,
        rewardRisk: null,
        quantity: null,
        unit: null,
        maxLossAtStopUsd: null,
        maxLossHardUsd: null,
        gaps: [{ field: 'invalidation', kind: 'unbuildable', reasons: ['stopLoss missing/non-finite'] }],
      },
      missing: ['invalidation'],
    };
    render(<DecisionPanelBody panel={payload} onAction={noop} />);
    expect(screen.getByText('0.50')).toBeTruthy(); // entry survives
    expect(screen.getAllByText('not built').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByTestId('wtt-risk-gaps').textContent).toContain('stopLoss missing/non-finite');
  });

  // TRA-4813 — the three board-requested buttons: two dispatch a real intent,
  // the third can never dispatch anything.
  it('Paper Trade and Require Approval DISPATCH their intents on click — no more enabled no-ops', () => {
    const onAction = vi.fn();
    render(<DecisionPanelBody panel={fullPayload()} onAction={onAction} />);
    fireEvent.click(screen.getByText('Paper Trade'));
    expect(onAction).toHaveBeenLastCalledWith('paper');
    fireEvent.click(screen.getByText('Require Approval'));
    expect(onAction).toHaveBeenLastCalledWith('require_approval');
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('Auto-Execute never dispatches — disabled, and clicking it calls nothing (AC4)', () => {
    const onAction = vi.fn();
    render(<DecisionPanelBody panel={fullPayload()} onAction={onAction} />);
    const btn = screen.getByText('Auto-Execute') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('a machine refusal is rendered verbatim under the buttons — a click leaves a visible trace', () => {
    render(
      <DecisionPanelBody
        panel={fullPayload()}
        onAction={noop}
        actionState={{
          busy: false,
          message: 'Machine refused the transition — no paper open recorded',
          reasons: ['paperFill.orderId is empty'],
          tone: 'refused',
        }}
      />,
    );
    const result = screen.getByTestId('wtt-action-result');
    expect(result.textContent).toContain('Machine refused');
    expect(result.textContent).toContain('paperFill.orderId is empty');
  });

  it('renders a fully-populated panel in <100ms (acceptance budget)', () => {
    const payload = fullPayload();
    const t0 = performance.now();
    render(<DecisionPanelBody panel={payload} onAction={noop} />);
    const elapsed = performance.now() - t0;
    expect(screen.getByTestId('wtt-panel')).toBeTruthy();
    expect(elapsed).toBeLessThan(100);
  });
});

describe('WhyThisTradePanel — container honesty states', () => {
  it('renders the fetched panel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fullPayload()), { status: 200 })));
    render(<WhyThisTradePanel token="t" signalId="sig-1" />);
    await waitFor(() => expect(screen.getByTestId('wtt-panel')).toBeTruthy());
    expect(screen.getByText('Regime: risk_on')).toBeTruthy();
  });

  it('a 404 reads as "aged out of the feed", not as an empty panel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no card' }), { status: 404 })));
    render(<WhyThisTradePanel token="t" signalId="gone" />);
    await waitFor(() =>
      expect(screen.getByText('No proposal card for this signal any more — it aged out of the feed.')).toBeTruthy(),
    );
  });

  it('a network failure reads as an error, never as loading forever', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
    render(<WhyThisTradePanel token="t" signalId="sig-1" />);
    await waitFor(() => expect(screen.getByText('Could not load panel — network error')).toBeTruthy());
  });

  // TRA-4813 — clicking Paper Trade POSTs the advance intent, renders the
  // machine's verdict, and re-fetches the panel so actions/disposition
  // re-derive from the machine's new state.
  it('Paper Trade posts the advance intent and renders the outcome + refreshed panel', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init !== undefined ? { init } : {}) });
        if (url.endsWith('/lifecycle/advance')) {
          return new Response(
            JSON.stringify({ ok: true, state: 'paper', disposition: 'paper', reasons: [], note: 'paper fill from ledger open pos-1' }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(fullPayload()), { status: 200 });
      }),
    );
    render(<WhyThisTradePanel token="t" signalId="sig-1" />);
    await waitFor(() => expect(screen.getByTestId('wtt-panel')).toBeTruthy());
    fireEvent.click(screen.getByText('Paper Trade'));
    await waitFor(() => expect(screen.getByTestId('wtt-action-result').textContent).toContain("advanced to 'paper'"));
    const advance = calls.find((c) => c.url.endsWith('/lifecycle/advance'));
    expect(advance).toBeDefined();
    expect(advance!.init?.method).toBe('POST');
    expect(JSON.parse(advance!.init?.body as string)).toEqual({ intent: 'paper' });
    // Panel re-fetched after the attempt (initial + post-advance).
    expect(calls.filter((c) => c.url.includes('/panel')).length).toBeGreaterThanOrEqual(2);
  });
});
