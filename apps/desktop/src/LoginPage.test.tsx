// TRA-2293 — sign-in screen: password reveal, emailed sign-in code, two-factor
// opt-in, and the add-an-email step for accounts with no address on file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from './LoginPage';

type Json = Record<string, unknown>;

/**
 * Route fetches by URL suffix. Anything unrouted throws rather than resolving to
 * a default — an unnoticed extra call would otherwise pass silently.
 */
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

function renderLogin(onLogin = vi.fn()) {
  render(
    <LoginPage
      onLogin={onLogin}
      onForgotPassword={vi.fn()}
      onSignUp={vi.fn()}
      onFeatures={vi.fn()}
    />,
  );
  return onLogin;
}

/**
 * The password box. Selected by class rather than by its toggle's label, because
 * that label flips to "Hide password" the moment a test clicks it.
 */
function passwordBox(): HTMLInputElement {
  const input = document.querySelector('.login-input--with-toggle');
  if (!input) throw new Error('password input not found');
  return input as HTMLInputElement;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('password reveal', () => {
  it('starts masked and toggles to plain text and back', async () => {
    const user = userEvent.setup();
    renderLogin();

    expect(passwordBox().type).toBe('password');

    await user.click(screen.getByLabelText('Show password'));
    expect(passwordBox().type).toBe('text');
    // The control announces its own state, not just its icon.
    expect(screen.getByLabelText('Hide password')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByLabelText('Hide password'));
    expect(passwordBox().type).toBe('password');
  });

  it('does not submit the form when the eye is clicked', async () => {
    const user = userEvent.setup();
    const fetchMock = mockRoutes({ '/api/auth/login': { body: { token: 't' } } });
    renderLogin();

    await user.type(screen.getByLabelText(/username/i), 'alice');
    await user.type(passwordBox(), 'hunter22');
    await user.click(screen.getByLabelText('Show password'));

    // A bare <button> inside a <form> defaults to type=submit; this is the
    // regression that guards against it.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('two-factor opt-in', () => {
  it('sends the opt-in with the login and lands on the code step', async () => {
    const user = userEvent.setup();
    const fetchMock = mockRoutes({
      '/api/auth/login': { body: { twoFactorRequired: true, pendingToken: 'pend-1', twoFactorEnrolled: true } },
    });
    const onLogin = renderLogin();

    await user.type(screen.getByLabelText(/username/i), 'alice');
    await user.type(passwordBox(), 'hunter22');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ username: 'alice', enrollTwoFactor: true });

    expect(await screen.findByLabelText(/verification code/i)).toBeInTheDocument();
    // No session yet — the second factor has not been cleared.
    expect(onLogin).not.toHaveBeenCalled();
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('shows backup codes once before completing a login that enrolled', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/api/auth/login': { body: { twoFactorRequired: true, pendingToken: 'pend-1' } },
      '/api/auth/2fa/verify': { body: { token: 'sess-1', backupCodes: ['AAAA-1111', 'BBBB-2222'] } },
    });
    const onLogin = renderLogin();

    await user.type(screen.getByLabelText(/username/i), 'alice');
    await user.type(passwordBox(), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await user.type(await screen.findByLabelText(/verification code/i), '123456');
    await user.click(screen.getByRole('button', { name: /verify & sign in/i }));

    expect(await screen.findByText(/AAAA-1111/)).toBeInTheDocument();
    // The codes are a gate, not a toast: the session is withheld until dismissed.
    expect(onLogin).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /saved them/i }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('sess-1'));
  });

  it('completes an ordinary 2FA login with no backup-code step', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/api/auth/login': { body: { twoFactorRequired: true, pendingToken: 'pend-1' } },
      '/api/auth/2fa/verify': { body: { token: 'sess-2' } },
    });
    const onLogin = renderLogin();

    await user.type(screen.getByLabelText(/username/i), 'alice');
    await user.type(passwordBox(), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));
    await user.type(await screen.findByLabelText(/verification code/i), '123456');
    await user.click(screen.getByRole('button', { name: /verify & sign in/i }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('sess-2'));
    expect(localStorage.getItem('auth_token')).toBe('sess-2');
  });
});

describe('emailed sign-in code', () => {
  it('requests a code by username and verifies it into a session', async () => {
    const user = userEvent.setup();
    const fetchMock = mockRoutes({
      '/api/auth/login-code': { body: { ok: true, pendingToken: 'pend-9', message: 'on its way' } },
      '/api/auth/2fa/verify': { body: { token: 'sess-3' } },
    });
    const onLogin = renderLogin();

    await user.click(screen.getByRole('button', { name: /email me a sign-in code/i }));
    await user.type(await screen.findByLabelText(/username/i), 'alice');
    await user.click(screen.getByRole('button', { name: /email me a code/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ username: 'alice' });
    // No password is collected or sent on this path.
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain('password');

    await user.type(await screen.findByLabelText(/verification code/i), '654321');
    await user.click(screen.getByRole('button', { name: /verify & sign in/i }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('sess-3'));
  });
});

describe('account with no email on file', () => {
  it('collects an address before handing over the dashboard', async () => {
    const user = userEvent.setup();
    const fetchMock = mockRoutes({
      '/api/auth/login': { body: { token: 'sess-4', emailRequired: true } },
      '/api/auth/account/email': { body: { ok: true, email: 'a@b.com' } },
    });
    const onLogin = renderLogin();

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(passwordBox(), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    // Token is held back until the address is saved.
    expect(await screen.findByLabelText(/email address/i)).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
    expect(localStorage.getItem('auth_token')).toBeNull();

    await user.type(screen.getByLabelText(/email address/i), 'a@b.com');
    await user.click(screen.getByRole('button', { name: /save & continue/i }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('sess-4'));
    // The save is authenticated with the session just minted.
    const emailCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/auth/account/email'));
    expect((emailCall?.[1] as RequestInit & { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer sess-4');
  });

  it('finishes the deferred two-factor opt-in once the address is saved', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/api/auth/login': { body: { token: 'sess-5', emailRequired: true, twoFactorPending: true } },
      '/api/auth/account/email': { body: { ok: true } },
      '/api/auth/2fa/enable': { body: { ok: true, backupCodes: ['CCCC-3333'] } },
    });
    const onLogin = renderLogin();

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(passwordBox(), 'hunter22');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await user.type(await screen.findByLabelText(/email address/i), 'a@b.com');
    await user.click(screen.getByRole('button', { name: /save & continue/i }));

    expect(await screen.findByText(/CCCC-3333/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /saved them/i }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('sess-5'));
  });

  it('still signs in, with a warning, when the deferred enrolment fails', async () => {
    const user = userEvent.setup();
    mockRoutes({
      '/api/auth/login': { body: { token: 'sess-6', emailRequired: true, twoFactorPending: true } },
      '/api/auth/account/email': { body: { ok: true } },
      '/api/auth/2fa/enable': { ok: false, status: 401, body: { error: 'Current password is required.' } },
    });
    const onLogin = renderLogin();

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(passwordBox(), 'hunter22');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await user.type(await screen.findByLabelText(/email address/i), 'a@b.com');
    await user.click(screen.getByRole('button', { name: /save & continue/i }));

    // The email DID save — the user must not be told to re-enter it, and must
    // not be dropped into the dashboard believing 2FA is on.
    expect(await screen.findByText(/Your email was saved/)).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();
  });
});
