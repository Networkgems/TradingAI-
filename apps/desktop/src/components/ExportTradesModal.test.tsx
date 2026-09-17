// TRA-568 — trade-history export modal behaviour.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExportTradesModal } from './ExportTradesModal';

type FetchMock = ReturnType<typeof vi.fn>;

/** Stub a successful export response with the given filename + content. */
function mockExportOk(filename = 'trades-export-2026-06-06.csv'): FetchMock {
  const fn = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-disposition' ? `attachment; filename="${filename}"` : null) },
      blob: () => Promise.resolve(new Blob(['symbol,market\n'], { type: 'text/csv' })),
      json: () => Promise.resolve({}),
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn as unknown as FetchMock;
}

function stubDownloadPlumbing() {
  // jsdom has no object-URL / anchor-click machinery — stub just enough so the
  // download path runs without throwing.
  const createObjectURL = vi.fn(() => 'blob:mock');
  const revokeObjectURL = vi.fn((_u: string) => undefined);
  vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);
  return { createObjectURL, revokeObjectURL, clickSpy };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ExportTradesModal', () => {
  it('renders range, account, market and format controls with defaults', () => {
    render(<ExportTradesModal token="tok" httpUrl="http://x" onClose={() => undefined} />);
    expect(screen.getByTestId('export-trades-modal')).toBeInTheDocument();

    // range — All time selected by default
    expect(screen.getByLabelText('All time')).toBeChecked();
    // account — both modes checked
    expect(screen.getByLabelText('Demo')).toBeChecked();
    expect(screen.getByLabelText('Live')).toBeChecked();
    // market — both checked
    expect(screen.getByLabelText('Stocks')).toBeChecked();
    expect(screen.getByLabelText('Options')).toBeChecked();
    // format — CSV default
    expect(screen.getByLabelText('CSV')).toBeChecked();
    expect(screen.getByLabelText('JSON')).not.toBeChecked();
  });

  it('builds the export request from the selected filters and downloads the file', async () => {
    const user = userEvent.setup();
    const fetchFn = mockExportOk();
    const { createObjectURL, clickSpy } = stubDownloadPlumbing();
    render(<ExportTradesModal token="tok" httpUrl="http://x" onClose={() => undefined} />);

    // Narrow to: This year · Live only · stocks only · JSON.
    await user.click(screen.getByLabelText('This year'));
    await user.click(screen.getByLabelText('Demo')); // uncheck demo
    await user.click(screen.getByLabelText('Options')); // uncheck options
    await user.click(screen.getByLabelText('JSON'));

    await user.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const url = String(fetchFn.mock.calls[0]![0]);
    expect(url).toContain('/api/trades/export?');
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('format')).toBe('json');
    expect(qs.get('modes')).toBe('live');
    expect(qs.get('markets')).toBe('stocks');
    const y = new Date().getFullYear();
    expect(qs.get('from')).toBe(`${y}-01-01`);
    expect(qs.get('to')).toBe(`${y}-12-31`);

    // Auth header attached (endpoint is requireAuth).
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');

    // download triggered + success surfaced.
    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    await screen.findByText('Download started.');
  });

  it('disables Download until at least one mode and one market are selected', async () => {
    const user = userEvent.setup();
    mockExportOk();
    render(<ExportTradesModal token="tok" httpUrl="http://x" onClose={() => undefined} />);

    const btn = screen.getByRole('button', { name: 'Download' });
    expect(btn).toBeEnabled();

    await user.click(screen.getByLabelText('Demo'));
    await user.click(screen.getByLabelText('Live'));
    expect(btn).toBeDisabled(); // no account selected

    await user.click(screen.getByLabelText('Demo')); // re-enable an account
    expect(btn).toBeEnabled();
  });

  it('shows the server error message when the export request fails', async () => {
    const user = userEvent.setup();
    const fn = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: () => Promise.resolve({ error: "format must be 'csv' or 'json'" }),
        blob: () => Promise.resolve(new Blob()),
      }),
    );
    vi.stubGlobal('fetch', fn);
    stubDownloadPlumbing();
    render(<ExportTradesModal token="tok" httpUrl="http://x" onClose={() => undefined} />);

    await user.click(screen.getByRole('button', { name: 'Download' }));
    await screen.findByText("format must be 'csv' or 'json'");
  });

  it('calls onClose from the close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ExportTradesModal token="tok" httpUrl="http://x" onClose={onClose} />);
    await user.click(screen.getByLabelText('Close export dialog'));
    expect(onClose).toHaveBeenCalled();
  });
});
