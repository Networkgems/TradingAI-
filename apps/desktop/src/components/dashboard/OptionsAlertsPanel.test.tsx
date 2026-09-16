// TRA-4599 (residual of TRA-4593 AC3) — the book label the route already
// publishes, on the screen.
//
// TRA-4501 pointed `/api/options/alerts` at `dashboardBookViewFor`, the same
// call `/api/state` resolves the open-options table through, and put the
// resulting `bookView` in the response body. TRA-4593 ruled that behaviour
// correct. But the panel rendered zero occurrences of `bookView`, so the
// cheapest operator-visible proof that the panel and the table beside it agree
// was on the wire and not on the screen.
//
// These tests pin the contract, and in particular the `undefined` decision:
// `bookView` is populated ONLY while a view override is in force, so `undefined`
// is "view follows routing", NOT "demo". The panel has no second source for
// routing, so `undefined` renders nothing rather than a guess.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OptionsAlertsPanel } from './OptionsAlertsPanel';

const BASE = {
  issue: 'TRA-845',
  chainDates: ['2026-09-15', '2026-09-16'],
  symbolsDiffed: ['RIG'],
  counts: { new_expiry: 0, new_strike: 0, iv_move: 0, target_hit: 0, stop_hit: 1 },
  alerts: [
    {
      kind: 'stop_hit',
      severity: 'action',
      symbol: 'RIG',
      message: 'RIG 3.5C past its stop',
      dedupKey: 'stop:RIG:3.5C',
    },
  ],
};

function stubAlerts(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response);
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('OptionsAlertsPanel — TRA-4599 bookView label', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('renders the LIVE book label off the route’s own bookView', async () => {
    stubAlerts({ ...BASE, bookView: 'live' });
    render(<OptionsAlertsPanel token="t" />);

    const chip = await screen.findByTestId('options-alerts-book-view');
    expect(chip).toHaveTextContent('target/stop on the LIVE book');
  });

  it('renders the DEMO book label the same way', async () => {
    stubAlerts({ ...BASE, bookView: 'demo' });
    render(<OptionsAlertsPanel token="t" />);

    const chip = await screen.findByTestId('options-alerts-book-view');
    expect(chip).toHaveTextContent('target/stop on the DEMO book');
  });

  // Acceptance 2. `undefined` means the view follows routing; the panel cannot
  // know routing without a second source, so it must not print one. Rendering
  // "live" here would be a guess, and a label that is sometimes a guess gives an
  // operator no way to tell which frames to trust.
  it('renders NO book label when bookView is absent (view follows routing)', async () => {
    stubAlerts(BASE);
    render(<OptionsAlertsPanel token="t" />);

    // The panel itself did load — this is a missing label, not a missing panel.
    expect(await screen.findByText('Options Alerts')).toBeInTheDocument();
    expect(screen.queryByTestId('options-alerts-book-view')).not.toBeInTheDocument();
    expect(screen.queryByText(/on the LIVE book/)).not.toBeInTheDocument();
    expect(screen.queryByText(/on the DEMO book/)).not.toBeInTheDocument();
  });

  // An unexpected value off the wire is the same case as absent: render nothing,
  // never print it raw.
  it('renders NO book label for a value that is neither demo nor live', async () => {
    stubAlerts({ ...BASE, bookView: 'paper' });
    render(<OptionsAlertsPanel token="t" />);

    expect(await screen.findByText('Options Alerts')).toBeInTheDocument();
    expect(screen.queryByTestId('options-alerts-book-view')).not.toBeInTheDocument();
    expect(screen.queryByText(/paper/i)).not.toBeInTheDocument();
  });

  // The label must survive the collapsed default — it lives in the header, which
  // is the surface an operator sees without expanding the noisy alert table.
  it('shows the label while the alert table is collapsed (the default)', async () => {
    stubAlerts({ ...BASE, bookView: 'live' });
    render(<OptionsAlertsPanel token="t" />);

    expect(await screen.findByTestId('options-alerts-book-view')).toBeInTheDocument();
    // Collapsed: the table is not rendered, but the label is.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  // The whole point is echoing the SERVER's label: one fetch, no client-side
  // re-derivation of the book from settings.
  it('reads the label off the existing alerts fetch — no second call', async () => {
    const fetchMock = stubAlerts({ ...BASE, bookView: 'live' });
    render(<OptionsAlertsPanel token="t" />);

    await screen.findByTestId('options-alerts-book-view');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/options/alerts');
  });
});
