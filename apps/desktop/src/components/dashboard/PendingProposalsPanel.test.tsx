// TRA-945 — coverage for the two UX-spec polish nits on the pending-proposals
// panel: (1) empty-state-B carries a working "Turn on agent trading" CTA wired to
// the Trading Agents master switch, and (2) a proposal nearing the store TTL greys
// out with a disabled Approve + "stale — re-request" hint instead of silently
// vanishing at the TTL. fetch is stubbed so the 5s poll never hits the network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TradeProposal } from '@trading-app/shared';
import { ToastProvider } from '../../lib/toast.tsx';
import { PendingProposalsPanel } from './PendingProposalsPanel';

interface ProposalsResponse {
  proposals: TradeProposal[];
  caps: {
    live: { orders: number; ordersCap: number; notionalUsd: number; notionalCap: number; perOrderCap: number };
    demo: { orders: number; softCap: number };
  };
  killSwitchEngaged: boolean;
  tradingAgentsEnabled: boolean;
  proposalTtlMs?: number;
}

const CAPS = {
  live: { orders: 0, ordersCap: 5, notionalUsd: 0, notionalCap: 1000, perOrderCap: 500 },
  demo: { orders: 0, softCap: 50 },
};

const proposal = (over: Partial<TradeProposal> = {}): TradeProposal => ({
  id: 'prop-1',
  recommendationId: 'agent-NVDA-1',
  symbol: 'NVDA',
  side: 'buy',
  size: 10,
  notional: 1000,
  mode: 'demo',
  conviction: 0.8,
  verdict: 'APPROVE',
  note: 'momentum continuation',
  createdAt: Date.now(),
  status: 'pending',
  ...over,
});

// Stub fetch: GET /api/proposals returns `response`; everything else (the CTA
// POST) succeeds. Returns the POST spy so tests can assert on the toggle call.
function stubFetch(response: ProposalsResponse) {
  const fetchMock = vi.fn(async (url: string, _opts?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.endsWith('/api/proposals')) {
      return { ok: true, json: async () => response } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function renderPanel() {
  return render(
    <ToastProvider>
      <PendingProposalsPanel token="t" accountMode="demo" />
    </ToastProvider>,
  );
}

describe('PendingProposalsPanel — TRA-945 nits', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('empty-state B shows a working "Turn on agent trading" CTA wired to the agents toggle', async () => {
    const fetchMock = stubFetch({
      proposals: [], caps: CAPS, killSwitchEngaged: false, tradingAgentsEnabled: false,
    });
    renderPanel();

    const cta = await screen.findByRole('button', { name: 'Turn on agent trading' });
    await userEvent.click(cta);

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        ([u, o]) => String(u).endsWith('/api/trading/trading-agents') && o?.method === 'POST',
      );
      expect(posted).toBeTruthy();
      expect(JSON.parse(String(posted?.[1]?.body))).toEqual({ enabled: true });
    });
  });

  it('greys out a near-TTL proposal: disabled Approve + "stale — re-request" hint', async () => {
    // TTL 15m → warn window opens 2m before expiry (at 13m). A 14m-old proposal
    // is inside the window and must render the stale treatment.
    const ttl = 15 * 60_000;
    stubFetch({
      proposals: [proposal({ createdAt: Date.now() - 14 * 60_000 })],
      caps: CAPS, killSwitchEngaged: false, tradingAgentsEnabled: true, proposalTtlMs: ttl,
    });
    renderPanel();

    expect(await screen.findByText(/stale — re-request/i)).toBeInTheDocument();
    expect(screen.getByText('STALE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('keeps a fresh proposal actionable when the TTL is reported', async () => {
    const ttl = 15 * 60_000;
    stubFetch({
      proposals: [proposal({ createdAt: Date.now() - 60_000 })],
      caps: CAPS, killSwitchEngaged: false, tradingAgentsEnabled: true, proposalTtlMs: ttl,
    });
    renderPanel();

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.queryByText('STALE')).not.toBeInTheDocument();
  });
});
