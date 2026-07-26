// TRA-2421 — the Settings danger zone for self-serve account deletion.
//
// The assertions that matter are the ones about what does NOT happen: the button
// must stay dead until BOTH confirmations are satisfied, and a refusal must leave
// the user signed in with the server's own reason on screen. A delete button that
// fires on a single click, or one that signs you out whatever the server said,
// reads exactly like a working one until the day it destroys the wrong book.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteAccountSection } from './SettingsPage';

type Json = Record<string, unknown>;

/** Routes by URL suffix; anything unrouted throws rather than resolving silently. */
function mockRoutes(routes: Record<string, { ok?: boolean; status?: number; body: Json }>) {
  const fn = vi.fn((url: string) => {
    const key = Object.keys(routes).find(k => String(url).endsWith(k));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    const r = routes[key];
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: () => Promise.resolve(r.body),
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const ME = { '/api/auth/me': { body: { username: 'enock', email: 'e@x.com', role: 'user' } } };

function renderSection(onLogout = vi.fn()) {
  render(<DeleteAccountSection token="tok" httpUrl="http://x" onLogout={onLogout} />);
  return onLogout;
}

const deleteButton = () => screen.getByRole('button', { name: /delete my account/i });
const confirmField = () => screen.getByLabelText(/type your username to confirm/i);

afterEach(() => { vi.unstubAllGlobals(); });

describe('TRA-2421 — Delete Account section', () => {
  it('states plainly that this is permanent and covers backups', async () => {
    mockRoutes(ME);
    renderSection();
    const warning = await screen.findByTestId('delete-account-warning');
    expect(warning.textContent).toMatch(/permanently deletes/i);
    expect(warning.textContent).toMatch(/backups/i);
    expect(warning.textContent).toMatch(/cannot be undone/i);
  });

  it('stays disabled until BOTH the password and the exact username are given', async () => {
    mockRoutes(ME);
    renderSection();
    await screen.findByText(/enock/);
    const user = userEvent.setup();

    expect(deleteButton()).toBeDisabled();

    // Password alone is not enough.
    await user.type(screen.getByLabelText(/current password/i), 'pw');
    expect(deleteButton()).toBeDisabled();

    // A near-miss on the username is still a miss — no case folding, no trimming.
    await user.type(confirmField(), 'Enock');
    expect(deleteButton()).toBeDisabled();

    await user.clear(confirmField());
    await user.type(confirmField(), 'enock');
    expect(deleteButton()).toBeEnabled();
  });

  it('sends the password and signs out only after the server confirms', async () => {
    const fetchMock = mockRoutes({
      ...ME,
      '/api/account': { body: { ok: true, receipt: { ok: true } } },
    });
    const onLogout = renderSection();
    await screen.findByText(/enock/);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/current password/i), 'hunter2');
    await user.type(confirmField(), 'enock');
    await user.click(deleteButton());

    await screen.findByTestId('delete-account-done');
    const call = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/account'));
    expect(call).toBeDefined();
    const init = call![1] as { method: string; body: string };
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ password: 'hunter2' });

    // Signing out is the user's click, so the confirmation is actually read.
    expect(onLogout).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /return to sign in/i }));
    expect(onLogout).toHaveBeenCalled();
  });

  it('a refused delete leaves the user signed in, with the server reason shown', async () => {
    // The operator-book and last-admin rules live only on the server. If the UI
    // swallowed the refusal, the account would appear deleted while it is intact.
    mockRoutes({
      ...ME,
      '/api/account': {
        ok: false,
        status: 403,
        body: { error: 'Operator accounts cannot be deleted from Settings. Contact an administrator.' },
      },
    });
    const onLogout = renderSection();
    await screen.findByText(/enock/);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/current password/i), 'pw');
    await user.type(confirmField(), 'enock');
    await user.click(deleteButton());

    await screen.findByText(/operator accounts cannot be deleted/i);
    expect(onLogout).not.toHaveBeenCalled();
    // Still usable — this is a refusal, not a destroyed session.
    expect(screen.queryByTestId('delete-account-done')).toBeNull();
    await waitFor(() => expect(deleteButton()).toBeEnabled());
  });

  it('a wrong password is reported and nothing is destroyed', async () => {
    mockRoutes({
      ...ME,
      '/api/account': { ok: false, status: 401, body: { error: 'Password is incorrect' } },
    });
    const onLogout = renderSection();
    await screen.findByText(/enock/);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/current password/i), 'wrong');
    await user.type(confirmField(), 'enock');
    await user.click(deleteButton());

    await screen.findByText(/password is incorrect/i);
    expect(onLogout).not.toHaveBeenCalled();
    expect(screen.queryByTestId('delete-account-done')).toBeNull();
  });

  it('a PARTIAL wipe is not presented as a retryable failure', async () => {
    // `receipt` in the body means the identity is gone even though residue
    // remains. Offering "try again" against a dead token would send the user in
    // circles collecting 401s.
    mockRoutes({
      ...ME,
      '/api/account': {
        ok: false,
        status: 500,
        body: {
          ok: false,
          error: 'Your account was deleted, but some stored data could not be removed.',
          receipt: { ok: false },
        },
      },
    });
    renderSection();
    await screen.findByText(/enock/);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/current password/i), 'pw');
    await user.type(confirmField(), 'enock');
    await user.click(deleteButton());

    const done = await screen.findByTestId('delete-account-done');
    expect(done.textContent).toMatch(/some stored data could not be removed/i);
    expect(screen.queryByRole('button', { name: /delete my account/i })).toBeNull();
    expect(screen.getByRole('button', { name: /return to sign in/i })).toBeEnabled();
  });
});
