// TRA-1349 — the AI Ideas tab was stuck on "Loading AI options ideas…"
// indefinitely. Root cause: the panel's fetch had no timeout and every failure
// silently fell back to the illustrative PREVIEW feed, so a real backend error
// or a stalled request left the spinner up (or masked the failure as a fake
// preview) with no way out. These tests pin the fixed contract:
//   1. a live feed renders its ranked ideas (spinner clears),
//   2. a non-404 API error shows a retryable ERROR state — never an endless
//      spinner and never a silent preview,
//   3. a network failure also shows the error state,
//   4. a genuine 404 (endpoint not deployed) still softens to the preview.
// fetch is stubbed so the 60s poll never touches the network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiOptionsIdeasPanel } from './AiOptionsIdeasPanel';

interface Idea {
  id: string;
  rank: number;
  ticker: string;
  underlyingPrice: number;
  strategy: string;
  thesis: string;
  pop: number;
  maxLossUsd: number;
  maxProfitUsd: number;
  netUsd: number;
  breakevens: number[];
  ivRank: number;
  dte: number;
  events: unknown[];
  legs: { action: string; optionType: string; strike: number; expiration: string }[];
  enterable: boolean;
}

function idea(over: Partial<Idea> = {}): Idea {
  return {
    id: 'live-msft-bps-1',
    rank: 1,
    ticker: 'MSFT',
    underlyingPrice: 390.75,
    strategy: 'Bull Put Spread',
    thesis: 'High IV-rank; sell premium below support for defined-risk income.',
    pop: 0.7,
    maxLossUsd: 320,
    maxProfitUsd: 180,
    netUsd: 180,
    breakevens: [418.2],
    ivRank: 64,
    dte: 35,
    events: [],
    legs: [
      { action: 'sell', optionType: 'put', strike: 420, expiration: '2026-07-31' },
      { action: 'buy', optionType: 'put', strike: 415, expiration: '2026-07-31' },
    ],
    enterable: true,
    ...over,
  };
}

const LIVE_FEED = {
  source: 'live',
  generatedAt: 1,
  noDayTrading: { enforced: true, minHoldDays: 2, note: 'No day trading enforced.' },
  ideas: [idea(), idea({ id: 'live-nvda-2', rank: 2, ticker: 'NVDA' })],
};

// Stub fetch: GET /api/options/ideas resolves to `ideasResponse`; the panel's
// AnthropicKeySetup status probe (/api/options/anthropic-key) always succeeds.
type StubResponse = Partial<Response> & { json?: () => Promise<unknown> };
function stubFetch(ideasResponse: StubResponse | (() => Promise<never>)) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith('/api/options/ideas')) {
      return typeof ideasResponse === 'function'
        ? ideasResponse()
        : (ideasResponse as Response);
    }
    if (u.endsWith('/api/options/anthropic-key')) {
      return { ok: true, json: async () => ({ present: false, prefix: '' }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('AiOptionsIdeasPanel — TRA-1349 loading/error handling', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('renders the live ranked ideas and clears the spinner', async () => {
    stubFetch({ ok: true, status: 200, json: async () => LIVE_FEED });
    render(<AiOptionsIdeasPanel token="t" />);

    expect(await screen.findByText('Ranked Ideas (2)')).toBeInTheDocument();
    expect(screen.getByText('MSFT')).toBeInTheDocument();
    expect(screen.getByText('NVDA')).toBeInTheDocument();
    expect(screen.queryByText(/Loading AI options ideas/i)).not.toBeInTheDocument();
    // A live feed is NOT the preview surface.
    expect(screen.queryByText(/Preview — illustrative ideas only/i)).not.toBeInTheDocument();
  });

  it('shows a retryable error state (not a spinner, not a preview) on a 500', async () => {
    const fetchMock = stubFetch({ ok: false, status: 500, json: async () => ({}) });
    render(<AiOptionsIdeasPanel token="t" />);

    expect(await screen.findByText(/Couldn’t load AI options ideas/i)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    expect(screen.queryByText(/Loading AI options ideas/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Preview — illustrative ideas only/i)).not.toBeInTheDocument();

    // Retry re-issues the fetch; make the second attempt succeed and assert recovery.
    (fetchMock as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(
      async (url: string) => {
        const u = String(url);
        if (u.endsWith('/api/options/ideas')) {
          return { ok: true, status: 200, json: async () => LIVE_FEED } as Response;
        }
        return { ok: true, json: async () => ({ present: false, prefix: '' }) } as Response;
      },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Ranked Ideas (2)')).toBeInTheDocument();
  });

  it('shows the error state on a network failure', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<AiOptionsIdeasPanel token="t" />);

    expect(await screen.findByText(/Couldn’t load AI options ideas/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/Loading AI options ideas/i)).not.toBeInTheDocument();
  });

  it('still falls back to the preview surface on a genuine 404 (endpoint absent)', async () => {
    stubFetch({ ok: false, status: 404, json: async () => ({}) });
    render(<AiOptionsIdeasPanel token="t" />);

    expect(await screen.findByText(/Preview — illustrative ideas only/i)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn’t load AI options ideas/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading AI options ideas/i)).not.toBeInTheDocument();
  });
});
