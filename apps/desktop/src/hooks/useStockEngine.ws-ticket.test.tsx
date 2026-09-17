// TRA-4488 — THE RECONNECT PATH IS THE UNIT UNDER TEST.
//
// The issue names this the case nobody tests, and it is the case where the fix
// can be worse than the defect: a single-use ticket that a retry loop replays
// does not degrade the dashboard, it kills it permanently for everyone holding
// that page. A test on `fetchWsTicket` alone cannot see it — the helper is
// correct in the broken version too. The question is whether the HOOK calls it
// again on reconnect, so the hook is what is rendered here.
//
// Clock discipline: real timers advanced by `vi.advanceTimersByTime` under
// `useFakeTimers`, never `vi.setSystemTime` without it (that freezes
// `Date.now()` and hangs any deadline loop, reporting passes for tests that
// never ran).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useStockEngine } from './useStockEngine';

/** Every socket the hook has constructed, in order, with the URL it used. */
interface FakeSocket {
  url: string;
  onopen: (() => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  closed: boolean;
  close: () => void;
}

let sockets: FakeSocket[] = [];
let ticketSerial = 0;
/** Ticket responses the stub will serve, in order; `null` = respond 401. */
let ticketPlan: Array<'ok' | 'fail' | 'unauthorized' | 'absent'> = [];
let logoutCalls = 0;

function installFakeWebSocket(): void {
  class Fake implements FakeSocket {
    url: string;
    onopen: (() => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    closed = false;
    constructor(url: string) { this.url = url; sockets.push(this); }
    close(): void { this.closed = true; }
    send(): void { /* unused */ }
  }
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = Fake;
}

function installFetchStub(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: { method?: string }) => {
    const url = String(input);
    if (url.endsWith('/api/auth/ws-ticket')) {
      expect(init?.method, 'the ticket must be minted with POST').toBe('POST');
      const plan = ticketPlan.shift() ?? 'ok';
      if (plan === 'unauthorized') return new Response('{}', { status: 401 });
      if (plan === 'absent') return new Response('{}', { status: 404 });
      if (plan === 'fail') return new Response('{}', { status: 503 });
      ticketSerial += 1;
      return new Response(JSON.stringify({ ticket: `ticket-${ticketSerial}`, ttlMs: 30000 }), { status: 200 });
    }
    // Everything else the hook polls for: answer 200 with an inert body. A
    // fresh Response per call on purpose — one shared Response object has a
    // body that can only be read once, which silently starves later callers.
    return new Response('{}', { status: 200 });
  }));
}

function ticketFetches(): number {
  const f = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return f.mock.calls.filter((c) => String(c[0]).endsWith('/api/auth/ws-ticket')).length;
}

beforeEach(() => {
  sockets = [];
  ticketSerial = 0;
  ticketPlan = [];
  logoutCalls = 0;
  installFakeWebSocket();
  installFetchStub();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// `onLogout` is in the socket effect's dep list, so it MUST be referentially
// stable across renders or the effect tears down and reconnects on every
// `setState` the hook's REST fetches cause — which would manufacture extra
// sockets and extra ticket mints that have nothing to do with reconnect. The
// real caller passes a stable callback for exactly this reason (see the
// `exhaustive-deps` note in the hook).
const stableLogout = () => { logoutCalls += 1; };

function render() {
  return renderHook(() => useStockEngine('session-token', 'dashboard', stableLogout));
}

describe('TRA-4488 useStockEngine ticket handshake', () => {
  it('mints a ticket and puts THAT in the socket URL — never the session token', async () => {
    render();

    await waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0]!.url).toContain('ticket=ticket-1');
    // The defect, asserted absent. `session-token` is the bearer the hook was
    // handed; if it appears in a socket URL the fix has not landed.
    expect(sockets[0]!.url).not.toContain('session-token');
    expect(sockets[0]!.url).not.toContain('token=');
  });

  it('RE-FETCHES a fresh ticket on reconnect instead of replaying the first', async () => {
    render();
    await waitFor(() => expect(sockets.length).toBe(1));
    act(() => { sockets[0]!.onopen?.(); });

    // Drop the socket the way a server restart or a network blip does: a close
    // with a code that is NOT 1008 (1008 is the auth refusal that signs out).
    act(() => { sockets[0]!.onclose?.({ code: 1006 }); });
    // Let the backoff timer fire. Ceiling is 30s with jitter (lib/backoff).
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });

    await waitFor(() => expect(sockets.length).toBe(2));
    // THE ASSERTION THIS FILE EXISTS FOR. A second ticket was minted, and the
    // second socket carries it. `ticket-1` reappearing here is the outage: the
    // server burns a ticket on first use, so the reconnect would be refused,
    // close again, replay again, forever.
    expect(ticketFetches()).toBe(2);
    expect(sockets[1]!.url).toContain('ticket=ticket-2');
    expect(sockets[1]!.url).not.toContain('ticket=ticket-1');
  });

  it('CONTROL: the pre-fix shape — one credential captured outside connect — reuses it', async () => {
    // Without this, the assertion above passes for a hook that happens to
    // re-render for an unrelated reason. The broken arrangement is reconstructed
    // here at its essence: fetch once, close over the result, reconnect reads
    // the closure. It reuses the credential, which is what the shipped hook is
    // asserted NOT to do.
    const urls: string[] = [];
    let credential = '';
    let fetches = 0;
    async function brokenConnect(reconnecting: boolean) {
      if (!reconnecting) { fetches += 1; credential = `ticket-${fetches}`; }
      urls.push(`ws://x/?ticket=${credential}`);
    }
    await brokenConnect(false);
    await brokenConnect(true);

    expect(fetches).toBe(1);
    expect(urls[0]).toBe(urls[1]);
    expect(urls[1]).toContain('ticket-1');
  });

  it('retries with backoff when the ticket mint fails transiently, and does NOT sign the user out', async () => {
    ticketPlan = ['fail'];
    render();

    // No socket yet — the first mint failed, so there was nothing to connect with.
    await waitFor(() => expect(ticketFetches()).toBe(1));
    expect(sockets.length).toBe(0);
    expect(logoutCalls).toBe(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });

    await waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0]!.url).toContain('ticket=ticket-1');
  });

  it('signs the user out on a 401 from the mint rather than spinning on a dead session', async () => {
    ticketPlan = ['unauthorized'];
    render();

    await waitFor(() => expect(logoutCalls).toBe(1));
    expect(sockets.length).toBe(0);
    // And it STOPS. A 401 retried on backoff is an infinite loop against a
    // session that can never come back.
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(ticketFetches()).toBe(1);
  });

  it('falls back to ?token= when the SERVER predates the ticket endpoint (404)', async () => {
    // The deploy ordering here is fixed and runs the wrong way: Pages promotes
    // this client on CI green, bqb1 is deployed by hand later. Without this arm
    // every Pages user loses live push (and spins on a 404) until the server
    // catches up — see `buildLegacySocketUrl`.
    ticketPlan = ['absent'];
    render();

    await waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0]!.url).toContain('token=session-token');
    expect(sockets[0]!.url).not.toContain('ticket=');
    expect(logoutCalls).toBe(0);
  });

  it('returns to the TICKET path on the next reconnect once the server has caught up', async () => {
    // The fallback must not be sticky: one 404 must not pin the client to the
    // legacy URL for the life of the page. Nothing caches the decision, so this
    // holds by construction — asserted because "by construction" is how the
    // reconnect bug in this very file would also have been described.
    ticketPlan = ['absent', 'ok'];
    render();
    await waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0]!.url).toContain('token=session-token');

    act(() => { sockets[0]!.onclose?.({ code: 1006 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });

    await waitFor(() => expect(sockets.length).toBe(2));
    expect(sockets[1]!.url).toContain('ticket=ticket-1');
    expect(sockets[1]!.url).not.toContain('session-token');
  });

  it('does NOT fall back on a 503 — only a 404 proves the endpoint is absent', async () => {
    // A 5xx is a blip at an endpoint that exists. Falling back there would put
    // the session token in the URL on every transient server error, i.e. reopen
    // the defect on the most common failure in the set.
    ticketPlan = ['fail'];
    render();

    await waitFor(() => expect(ticketFetches()).toBe(1));
    expect(sockets.length).toBe(0);
  });

  it('does not open a socket when the component unmounts while the mint is in flight', async () => {
    const { unmount } = render();
    unmount();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    // An orphan socket here is owned by nobody: the cleanup has already run, so
    // it is never closed and never reconnected — a leak per mount/unmount cycle.
    expect(sockets.filter((s) => !s.closed).length).toBe(0);
  });
});
