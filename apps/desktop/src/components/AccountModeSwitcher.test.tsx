// TRA-3809 — the account-mode toggle must report the mode the SERVER ended up
// in, never the one it asked for.
//
// Why this file exists: on bqb1 2026-08-16T18:42:20.569Z the TRA-2649
// write-path arm fired in anger for the first time (`bootArmWriteRepairs`
// 0 -> 1) with `repaired:["mode"]` and `bodyFields:["mode"]` — the exact
// payload shape THIS component sends. The server re-converged the write and
// persisted `mode:"live"` 2ms later, and answered 200. The client then told
// the operator "Switched to Demo account" while the account stayed live and
// kept placing real orders. The lie was transient (a reload re-reads `live`)
// but it was a lie about a real-money arm at the exact moment someone was
// trying to stand it down.
//
// The clamp case below is the regression detector; the honest-success case is
// its control, so a green run cannot come from the component simply refusing
// to ever report success.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountModeSwitcher } from './AccountModeSwitcher';
import { ToastProvider, ToastViewport } from '../lib/toast.tsx';

/**
 * Stub `PUT /api/account/settings`. `serverMode` is what the response body
 * reports as the POST-repair persisted mode — pass `undefined` to model a 200
 * that does not report a mode at all.
 */
function mockPut(serverMode: 'demo' | 'live' | undefined) {
  const fn = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          serverMode === undefined
            ? { ok: true, missingLiveCredentials: [] }
            : { ok: true, settings: { mode: serverMode }, missingLiveCredentials: [] },
        ),
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Render the switcher inside a real toast provider so we assert the words an operator sees. */
function renderSwitcher(mode: 'demo' | 'live', onChange = vi.fn()) {
  render(
    <ToastProvider>
      <AccountModeSwitcher mode={mode} onChange={onChange} market="stocks" token="tok" />
      <ToastViewport />
    </ToastProvider>,
  );
  return { onChange };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('AccountModeSwitcher', () => {
  it('sends a bare {mode} body — the payload shape the bqb1 repair line recorded', async () => {
    const fetchMock = mockPut('demo');
    renderSwitcher('live');

    await userEvent.click(screen.getByRole('button', { name: 'Demo' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/account\/settings$/);
    expect(init?.method).toBe('PUT');
    // `bodyFields:["mode"]` in the 18:42:20Z warn line is this exact object.
    expect(Object.keys(JSON.parse(String(init?.body)))).toEqual(['mode']);
  });

  it('reports the SERVER mode and names the real lever when the switch is clamped', async () => {
    // The pinned operator clicks Demo; the write-path arm re-converges to live
    // and the server answers 200 with the post-repair object.
    mockPut('live');
    const { onChange } = renderSwitcher('live');

    await userEvent.click(screen.getByRole('button', { name: 'Demo' }));

    // 1. The parent is told the SERVER's mode, not the requested one. Before
    //    this fix the component called onChange('demo') here.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('live'));
    expect(onChange).not.toHaveBeenCalledWith('demo');

    // 2. The operator is NOT told the de-escalation happened.
    expect(screen.queryByText(/Switched to Demo account/i)).not.toBeInTheDocument();

    // 3. They are told the account is still live, as an alert, and pointed at
    //    the lever that actually works.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Account is STILL LIVE/);
    expect(alert).toHaveTextContent(/was not applied/);
    expect(alert).toHaveTextContent(/LIVE_EQUITY_BOOT_USER/);

    // 4. The refused side is annotated and still clickable (never disabled —
    //    the pin can be cleared at any time and this is the escape control).
    const demoBtn = screen.getByRole('button', { name: 'Demo' });
    expect(demoBtn).toHaveAttribute('data-clamped', 'true');
    expect(demoBtn).not.toBeDisabled();
    expect(demoBtn.getAttribute('title')).toMatch(/server refused this switch/);
    // The side that DID hold is not annotated.
    expect(screen.getByRole('button', { name: 'Live' })).not.toHaveAttribute('data-clamped');
  });

  it('CONTROL — still reports plain success when the server actually applied the switch', async () => {
    mockPut('demo');
    const { onChange } = renderSwitcher('live');

    await userEvent.click(screen.getByRole('button', { name: 'Demo' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('demo'));
    expect(await screen.findByText('Switched to Demo account')).toBeInTheDocument();
    // No clamp happened, so nothing is annotated and nothing is an alert.
    expect(screen.getByRole('button', { name: 'Demo' })).not.toHaveAttribute('data-clamped');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats a 200 that does not report a mode as UNVERIFIED, not as success', async () => {
    // "We could not observe the outcome" must not collapse into either verdict.
    mockPut(undefined);
    const { onChange } = renderSwitcher('live');

    await userEvent.click(screen.getByRole('button', { name: 'Demo' }));

    expect(await screen.findByText(/did not report the resulting mode/i)).toBeInTheDocument();
    expect(screen.queryByText(/Switched to Demo account/i)).not.toBeInTheDocument();
    // Do not move the parent to a value we never saw confirmed.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('TRA-4641 — the pinned view-only path names the supported de-escalation lever', async () => {
    // TRA-3910 reroutes the pinned press to `PUT /api/account/view-mode`, which
    // also rerouted it away from the clamp toast — previously the only place
    // the way out of the live arm was named. The operator this control exists
    // for (one trying to stand a live arm down) must still be told the lever.
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ bookView: 'demo', mode: 'live' }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onChange = vi.fn();
    render(
      <ToastProvider>
        <AccountModeSwitcher
          mode="live"
          liveBrokerArmPinned={true}
          onChange={onChange}
          market="stocks"
          token="tok"
        />
        <ToastViewport />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Demo' }));

    // The pinned press must never touch the settings write path — that is the
    // nine-event ledger class this retires.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/account\/view-mode$/);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('demo'));
    // Honest about what did NOT happen, and names the lever that works.
    const toastText = await screen.findByText(/nothing was disarmed/i);
    expect(toastText).toHaveTextContent(/LIVE_EQUITY_BOOT_USER/);
    expect(toastText).toHaveTextContent(/cannot stand the pinned arm down/i);
    // The at-rest title carries the lever too, before any click outcome.
    expect(screen.getByRole('button', { name: 'Demo' }).getAttribute('title'))
      .toMatch(/LIVE_EQUITY_BOOT_USER/);
  });

  it('still surfaces the promotion gate reason on a 422 (TRA-575 unchanged)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 422,
          json: () =>
            Promise.resolve({ code: 'promotion_gate_blocked', error: 'strategy-x — paper=fail' }),
        }),
      ),
    );
    const { onChange } = renderSwitcher('demo');
    localStorage.setItem('liveModeAcknowledged_stocks', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Live' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/strategy-x — paper=fail/);
    expect(alert).toHaveTextContent(/promote the strategy in Settings/);
    expect(onChange).not.toHaveBeenCalled();
  });
});
