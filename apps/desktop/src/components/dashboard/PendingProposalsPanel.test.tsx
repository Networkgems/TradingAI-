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
  // TRA-3514 - default to an LLM-backed read, which is what every agent-sourced
  // proposal production mints actually carries (adviseSymbol stamps both arms).
  llmUsed: true,
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
  // -- TRA-3514 (TRA-3460 (c) section 2) -- the backing badge, BOTH directions ----
  //
  // The requirement is that "a conviction number produced by the zero-cost graph must
  // not render identically to a real one". These two cases are identical except for
  // `llmUsed`, so any difference they show is attributable to the backing alone.
  it('badges a FALLBACK read and de-emphasises its conviction', async () => {
    stubFetch({
      proposals: [proposal({ llmUsed: false, conviction: 0.95 })],
      caps: CAPS, killSwitchEngaged: false, tradingAgentsEnabled: true,
    });
    renderPanel();

    // findAll, not find: the badge string also appears inside the explanatory
    // paragraph's ancestor chain, and a strict single-match assertion would fail on a
    // component that is rendering CORRECTLY.
    expect((await screen.findAllByText(/FALLBACK/i)).length).toBeGreaterThan(0);
    // The conviction label itself changes, so the number cannot be read as researched.
    expect(screen.getByText(/Conviction \(deterministic\)/i)).toBeInTheDocument();
    expect(screen.getByText(/No model call backed this recommendation/i)).toBeInTheDocument();
  });

  it('badges an LLM-BACKED read and leaves its conviction plain', async () => {
    stubFetch({
      proposals: [proposal({ llmUsed: true, conviction: 0.95 })],
      caps: CAPS, killSwitchEngaged: false, tradingAgentsEnabled: true,
    });
    renderPanel();

    expect(await screen.findByText('LLM-backed')).toBeInTheDocument();
    expect(screen.queryAllByText(/FALLBACK/i)).toHaveLength(0);
    expect(screen.queryByText(/Conviction \(deterministic\)/i)).not.toBeInTheDocument();
    expect(screen.getByText('Conviction')).toBeInTheDocument();
  });

  // The EXEMPTION. An options-feed proposal has no advisory graph behind it, so an
  // unstamped options card is correct and must NOT be badged as a fallback - a false
  // alarm on a healthy rail teaches operators to ignore the badge entirely.
  it('does NOT badge an options-feed proposal that legitimately carries no backing', async () => {
    stubFetch({
      proposals: [proposal({ kind: 'options', llmUsed: undefined })],
      caps: CAPS, killSwitchEngaged: false, tradingAgentsEnabled: true,
    });
    renderPanel();

    await screen.findByText('NVDA');
    expect(screen.queryAllByText(/FALLBACK/i)).toHaveLength(0);
    expect(screen.queryByText('LLM-backed')).not.toBeInTheDocument();
  });

  // Fail-closed: an AGENT (equity) proposal with the stamp MISSING is not evidence of
  // an LLM read, and the panel must not be more optimistic than the server gate that
  // already refused it.
  it('treats a MISSING stamp on an equity proposal as a fallback read', async () => {
    stubFetch({
      proposals: [proposal({ llmUsed: undefined })],
      caps: CAPS, killSwitchEngaged: false, tradingAgentsEnabled: true,
    });
    renderPanel();

    expect((await screen.findAllByText(/FALLBACK/i)).length).toBeGreaterThan(0);
  });
});
