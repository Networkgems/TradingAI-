// TRA-567 — Settings → Notifications UI behaviour.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationsSettings } from './NotificationsSettings';

type FetchMock = ReturnType<typeof vi.fn>;

/** Stub fetch: GET settings returns `settings`; everything else returns `ok`. */
function mockFetch(settings: Record<string, unknown> = {}): FetchMock {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/api/account/settings')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(settings) });
    }
    if (url.endsWith('/api/account/notifications')) {
      const body = JSON.parse((init?.body as string) ?? '{}');
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, alertPreferences: body }) });
    }
    if (url.endsWith('/api/notifications/test')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, channel: 'email' }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });
  vi.stubGlobal('fetch', fn);
  return fn as unknown as FetchMock;
}

function renderPanel() {
  render(<NotificationsSettings token="tok" httpUrl="http://x" />);
}

afterEach(() => vi.unstubAllGlobals());

describe('NotificationsSettings', () => {
  it('renders the three channels and the four-event matrix, with risk-halt on for every channel', async () => {
    mockFetch();
    renderPanel();
    await screen.findByTestId('notifications-settings');

    // channel master toggles
    expect(screen.getByLabelText('Enable Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Enable Telegram')).toBeInTheDocument();
    expect(screen.getByLabelText('Enable Discord')).toBeInTheDocument();

    // every risk-halt cell defaults checked (§1.3 — safety critical)
    for (const ch of ['Email', 'Telegram', 'Discord']) {
      expect(screen.getByLabelText(`Risk halt via ${ch}`)).toBeChecked();
    }
    // new-signal defaults: Discord only
    expect(screen.getByLabelText('New signal via Discord')).toBeChecked();
    expect(screen.getByLabelText('New signal via Email')).not.toBeChecked();
  });

  it('persists matrix edits via PUT /api/account/notifications', async () => {
    const user = userEvent.setup();
    const fetchFn = mockFetch();
    renderPanel();
    await screen.findByTestId('notifications-settings');

    await user.click(screen.getByLabelText('New signal via Email')); // flip on
    await user.click(screen.getByRole('button', { name: 'Save Notifications' }));

    await screen.findByText('Saved.');
    const putCall = fetchFn.mock.calls.find(c => String(c[0]).endsWith('/api/account/notifications'));
    expect(putCall).toBeTruthy();
    const sent = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(sent.events.signal.email).toBe(true);
  });

  it('fires a test send for a channel and reports success', async () => {
    const user = userEvent.setup();
    const fetchFn = mockFetch();
    renderPanel();
    await screen.findByTestId('notifications-settings');

    const emailCard = screen.getByLabelText('Enable Email').closest('.notif-channel-card')!;
    await user.click(within(emailCard as HTMLElement).getByRole('button', { name: 'Send test' }));

    await screen.findByText('Test sent — check the channel.');
    expect(
      fetchFn.mock.calls.some(c => String(c[0]).endsWith('/api/notifications/test')),
    ).toBe(true);
  });

  it('surfaces a load error with a retry affordance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network'))),
    );
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText('Could not load notification preferences.')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
