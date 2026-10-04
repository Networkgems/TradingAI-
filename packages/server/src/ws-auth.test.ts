// TRA-4488 — the WS upgrade handshake, driven over a REAL socket.
//
// ── What is under test, and what is not ──────────────────────────────────────
//
// `index.ts` binds a port at import, so it cannot be imported into a test
// process. This file therefore stands up its own `http.Server` +
// `WebSocketServer` — but the upgrade handler it installs calls the SHIPPED
// `authenticateUpgrade` against the SHIPPED ticket store. Nothing about the
// decision is re-implemented here; the harness is transport only, and it is
// copied from `index.ts`'s handler line for line (401-and-destroy, then
// `handleUpgrade`). `ws-auth.wiring.test.ts` is the other half: it asserts
// `index.ts` still routes through this function and no longer reads a token out
// of the query string itself. Neither file is sufficient alone.
//
// ── Why the REPLAY case is the centre of this file ──────────────────────────
//
// Every other assertion here — valid connects, expired refused, garbage refused
// — passes against a store that only checks a TTL. A merely short-lived ticket
// is not what the issue asked for and not what bounds the leak: a ticket
// scraped out of an access log inside its 30s window would still work. The
// replay assertion is the ONLY one that separates single-use from short-lived,
// so `refuses a ticket that has already been redeemed` is the load-bearing case
// and `CONTROL` below is what proves it can fail.
//
// Clock discipline: real timers throughout, and `issueWsTicket` /
// `consumeWsTicket` take an explicit `now` so expiry is exercised by arithmetic
// rather than by sleeping or by `vi.setSystemTime` (which, absent
// `useFakeTimers`, freezes `Date.now()` and hangs any deadline loop — see
// `vi-setsystemtime-without-fake-timers`).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

import {
  authenticateUpgrade,
  clearWsTickets,
  consumeWsTicket,
  issueWsTicket,
  resetWsAuthCountersForTest,
  revokeWsTicketsFor,
  wsAuthCounters,
  wsTicketsOutstanding,
  WS_TICKET_MAX_PER_USER,
  WS_TICKET_TTL_MS,
} from './ws-auth.js';
import { createToken } from './auth.js';

const USER = 'alice';
const OTHER = 'bob';

/** The accounts this harness considers to exist — `index.ts` passes `getUser`. */
let existingUsers = new Set<string>([USER, OTHER]);

interface Harness {
  url: string;
  close: () => Promise<void>;
  /** Usernames the server stamped onto accepted sockets, in accept order. */
  accepted: string[];
}

async function startHarness(): Promise<Harness> {
  const accepted: string[] = [];
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const decision = authenticateUpgrade(req.url, {
      userExists: (u) => existingUsers.has(u),
    });
    if (!decision.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as WebSocket & { username?: string }).username = decision.username;
      accepted.push(decision.username);
      // Echo the authenticated identity so the client can assert the socket was
      // bound to the right account, not merely that a socket opened.
      ws.send(JSON.stringify({ type: 'hello', username: decision.username }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    accepted,
    close: () => closeServer(server, wss),
  };
}

function closeServer(server: Server, wss: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve) => {
    for (const c of wss.clients) c.terminate();
    wss.close(() => server.close(() => resolve()));
  });
}

type ConnectOutcome =
  | { ok: true; username: string }
  | { ok: false; error: string };

/**
 * Open a socket and resolve once it has either delivered the server's `hello` or
 * failed. Resolves rather than rejects on refusal so both arms assert the same
 * way; a refused upgrade surfaces in `ws` as an `error`, not a `close`.
 */
function connect(url: string): Promise<ConnectOutcome> {
  return new Promise<ConnectOutcome>((resolve) => {
    const ws = new WebSocket(url);
    const done = (out: ConnectOutcome) => { try { ws.close(); } catch { /* ignore */ } resolve(out); };
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { type: string; username: string };
      if (msg.type === 'hello') done({ ok: true, username: msg.username });
    });
    ws.on('error', (err) => resolve({ ok: false, error: err.message }));
    ws.on('close', () => resolve({ ok: false, error: 'closed before hello' }));
  });
}

let harness: Harness;

beforeEach(() => {
  existingUsers = new Set([USER, OTHER]);
  clearWsTickets();
  resetWsAuthCountersForTest();
});

afterEach(async () => {
  await harness?.close();
});

describe('TRA-4488 WS upgrade over a real socket — ticket path', () => {
  it('accepts a freshly minted ticket and binds the socket to its account', async () => {
    harness = await startHarness();
    const ticket = issueWsTicket(USER);

    const out = await connect(`${harness.url}/?ticket=${encodeURIComponent(ticket)}`);

    expect(out).toEqual({ ok: true, username: USER });
    expect(harness.accepted).toEqual([USER]);
  });

  it('refuses a ticket that has already been redeemed (REPLAY — the single-use property)', async () => {
    harness = await startHarness();
    const ticket = issueWsTicket(USER);
    const url = `${harness.url}/?ticket=${encodeURIComponent(ticket)}`;

    const first = await connect(url);
    const replay = await connect(url);

    // Precondition: without a successful first use there is nothing to replay,
    // and `replay.ok === false` would be a tautology (TRA-2331 discipline).
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error).toMatch(/401/);
    // Exactly one socket was ever bound, so the refusal happened at the
    // upgrade, not after a connection was established and then dropped.
    expect(harness.accepted).toEqual([USER]);
  });

  it('CONTROL: a short-lived-but-reusable store passes every other case and FAILS the replay', async () => {
    // Without this, a store that checked only the TTL would satisfy the whole
    // rest of this file. The reusable store is reconstructed here, the harness
    // is pointed at it, and the replay is asserted to SUCCEED — i.e. the
    // instrument above is shown to be able to move.
    const reusable = new Map<string, { username: string; expiresAt: number }>();
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true });
    const accepted: string[] = [];
    server.on('upgrade', (req, socket, head) => {
      const t = new URL(req.url ?? '/', 'http://ws.invalid').searchParams.get('ticket') ?? '';
      const entry = reusable.get(t); // NOT deleted — this is the defect being modelled
      if (!entry || entry.expiresAt <= Date.now()) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        accepted.push(entry.username);
        ws.send(JSON.stringify({ type: 'hello', username: entry.username }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    reusable.set('reusable-ticket', { username: USER, expiresAt: Date.now() + WS_TICKET_TTL_MS });

    const url = `ws://127.0.0.1:${port}/?ticket=reusable-ticket`;
    const first = await connect(url);
    const replay = await connect(url);
    await closeServer(server, wss);

    expect(first.ok).toBe(true);
    // THE CONTROL. The reusable store lets the replay through; the shipped one
    // does not. The two tests differ in nothing else.
    expect(replay.ok).toBe(true);
    expect(accepted).toEqual([USER, USER]);

    harness = await startHarness(); // so afterEach has something to close
  });

  it('refuses an expired ticket, and the expired ticket is burnt rather than left pending', async () => {
    harness = await startHarness();
    const mintedAt = Date.now();
    const ticket = issueWsTicket(USER, mintedAt);

    // Valid at the last millisecond before expiry...
    expect(consumeWsTicket(ticket, mintedAt + WS_TICKET_TTL_MS - 1)).toBe(USER);

    // ...and a second ticket aged past the TTL is refused over the wire.
    const stale = issueWsTicket(USER, mintedAt - WS_TICKET_TTL_MS - 1);
    const out = await connect(`${harness.url}/?ticket=${encodeURIComponent(stale)}`);

    expect(out.ok).toBe(false);
    // Burnt on presentation even though it was already invalid: an expired
    // ticket must not linger as a row a clock skew could later honour.
    expect(wsTicketsOutstanding()).toBe(0);
  });

  it('refuses a forged ticket, an empty ticket and no credential at all', async () => {
    harness = await startHarness();

    for (const q of ['?ticket=not-a-real-ticket', '?ticket=', '', '?ticket=&token=']) {
      const out = await connect(`${harness.url}/${q}`);
      expect(out.ok, `query ${JSON.stringify(q)} must be refused`).toBe(false);
    }
    expect(harness.accepted).toEqual([]);
  });

  it('refuses a VALID ticket whose account has since been deleted (TRA-2421 applies to both credentials)', async () => {
    harness = await startHarness();
    const ticket = issueWsTicket(USER);
    existingUsers.delete(USER);

    const out = await connect(`${harness.url}/?ticket=${encodeURIComponent(ticket)}`);

    expect(out.ok).toBe(false);
    expect(harness.accepted).toEqual([]);
  });

  it('binds the socket to the ticket OWNER, never to another account', async () => {
    harness = await startHarness();
    const bobTicket = issueWsTicket(OTHER);

    const out = await connect(`${harness.url}/?ticket=${encodeURIComponent(bobTicket)}`);

    expect(out).toEqual({ ok: true, username: OTHER });
  });
});

describe('TRA-4492 the legacy ?token= door is GONE', () => {
  // The discriminator in every case below is that the token is REAL —
  // `createToken(USER)` mints exactly what `requireAuth` would accept on the
  // header. So a refusal is the URL SHAPE being rejected, not an invalid
  // credential. A test that fed garbage here would pass identically against the
  // old accepting branch and prove nothing about the deletion.
  it('refuses a VALID session token presented as ?token=', async () => {
    harness = await startHarness();
    const token = createToken(USER);

    const out = await connect(`${harness.url}/?token=${encodeURIComponent(token)}`);

    expect(out.ok).toBe(false);
    expect(harness.accepted).toEqual([]);
  });

  it('reports a ?token= upgrade as no_credential, the reason that absorbed the legacy arm', () => {
    const token = createToken(USER);

    // Asserted on the function rather than through the socket because the
    // refusal reason never reaches the wire (the handler writes a bare 401).
    // `bad_token` and `legacy_disabled` are gone from the enum, so a tokenless
    // and a token-bearing upgrade are now the same case.
    expect(authenticateUpgrade(`/?token=${encodeURIComponent(token)}`, {
      userExists: () => true,
    })).toEqual({ ok: false, reason: 'no_credential' });

    expect(authenticateUpgrade('/', { userExists: () => true }))
      .toEqual({ ok: false, reason: 'no_credential' });
  });

  it('does not fall back to a valid token when the ticket is bad', async () => {
    harness = await startHarness();
    const token = createToken(USER);

    const out = await connect(`${harness.url}/?ticket=forged&token=${encodeURIComponent(token)}`);

    // A fallback here would make every ticket refusal bypassable by appending a
    // session token — i.e. it would reinstate the exact defect TRA-4488 fixed
    // while every ticket test stayed green.
    expect(out.ok).toBe(false);
    expect(harness.accepted).toEqual([]);
  });

  it('publishes no legacy counter and no door-state flag', () => {
    const keys = Object.keys(wsAuthCounters());

    // The counters were never the clearance (they are since-boot), but leaving
    // a `legacyAccepted: false` on the route would invite exactly that reading
    // on the next removal.
    expect(keys).not.toContain('legacyTokenUpgrades');
    expect(keys).not.toContain('legacyTokenRefused');
    expect(keys).not.toContain('legacyAccepted');
  });

  it('ignores WS_LEGACY_TOKEN_QUERY entirely — the kill switch is gone, not defaulted', async () => {
    const prev = process.env['WS_LEGACY_TOKEN_QUERY'];
    process.env['WS_LEGACY_TOKEN_QUERY'] = 'on';
    try {
      harness = await startHarness();
      const token = createToken(USER);

      // The switch's documented fail-open value. If any resolver survived the
      // deletion this is the setting that would re-open the door.
      const out = await connect(`${harness.url}/?token=${encodeURIComponent(token)}`);

      expect(out.ok).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['WS_LEGACY_TOKEN_QUERY'];
      else process.env['WS_LEGACY_TOKEN_QUERY'] = prev;
    }
  });
});

describe('TRA-4488 ticket store properties', () => {
  it('mints a distinct high-entropy ticket every call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(issueWsTicket(USER));
    expect(seen.size).toBe(200);
    for (const t of seen) expect(t.length).toBeGreaterThanOrEqual(40);
  });

  it('keeps no plaintext ticket in the store', () => {
    const ticket = issueWsTicket(USER);
    // The store is module-private, so this is asserted the only way a caller
    // can: the plaintext is not a usable key for anything but one redemption,
    // and nothing is persisted. `wsAuthCounters` is the whole readable surface.
    expect(JSON.stringify(wsAuthCounters())).not.toContain(ticket);
  });

  it('caps outstanding tickets per user and evicts the OLDEST, so the newest always works', () => {
    const minted: string[] = [];
    for (let i = 0; i < WS_TICKET_MAX_PER_USER + 3; i += 1) minted.push(issueWsTicket(USER));

    expect(wsTicketsOutstanding()).toBe(WS_TICKET_MAX_PER_USER);
    // The newest survives — the direction that matters, since a client that just
    // asked for a ticket is about to use it.
    expect(consumeWsTicket(minted[minted.length - 1]!)).toBe(USER);
    // The oldest was evicted.
    expect(consumeWsTicket(minted[0]!)).toBeNull();
  });

  it('does not let one account evict another account s tickets', () => {
    const bob = issueWsTicket(OTHER);
    for (let i = 0; i < WS_TICKET_MAX_PER_USER + 3; i += 1) issueWsTicket(USER);
    expect(consumeWsTicket(bob)).toBe(OTHER);
  });

  it('prunes expired tickets on mint so an unredeemed backlog cannot grow', () => {
    const past = Date.now() - WS_TICKET_TTL_MS - 1;
    for (let i = 0; i < 5; i += 1) issueWsTicket(OTHER, past);
    expect(wsTicketsOutstanding()).toBe(5);
    issueWsTicket(USER);
    expect(wsTicketsOutstanding()).toBe(1);
  });

  it('revokeWsTicketsFor closes the window in front of a deleted account', () => {
    const a = issueWsTicket(USER);
    const b = issueWsTicket(OTHER);
    expect(revokeWsTicketsFor(USER)).toBe(1);
    expect(consumeWsTicket(a)).toBeNull();
    // Scoped: the other account's ticket survives.
    expect(consumeWsTicket(b)).toBe(OTHER);
  });
});

// `resolveLegacyTokenAccepted` and its suite were deleted with the door it
// gated (TRA-4492). The behaviour that replaced it is asserted above, in
// "TRA-4492 the legacy ?token= door is GONE".
