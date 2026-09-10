// TRA-4488 — fetch a single-use WebSocket upgrade ticket.
//
// The session token goes in the `Authorization` header here, where TLS protects
// it and no proxy logs it. Only the ticket reaches the upgrade URL, and only
// once: the server burns it on first presentation, so a ticket recovered from an
// access log is already dead.
//
// ⚠ THE RECONNECT PATH IS THE ONE THAT BREAKS. A single-use ticket replayed by a
// retry loop is an outage, not a degradation — the socket opens, is refused, the
// loop retries the same dead ticket, and the dashboard never comes back for
// anyone. So `buildSocketUrl` is the ONLY way either dashboard forms a socket
// URL, and it takes the ticket as an argument rather than closing over one:
// there is no variable for a reconnect to re-read. Both call sites invoke
// `fetchWsTicket` inside the reconnecting `connect()`, not outside it.

import { HTTP_URL } from '../server-url';

export class WsTicketError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'WsTicketError';
    this.status = status;
  }
}

/**
 * Mint a ticket for the current session. Throws `WsTicketError` on a non-2xx so
 * the caller can distinguish a dead session (401 → sign out) from a transport
 * blip (anything else → back off and retry).
 */
export async function fetchWsTicket(token: string): Promise<string> {
  const r = await fetch(`${HTTP_URL}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new WsTicketError(r.status, `ws-ticket ${r.status}`);
  const body = await r.json() as { ticket?: unknown };
  if (typeof body.ticket !== 'string' || body.ticket === '') {
    throw new WsTicketError(r.status, 'ws-ticket response carried no ticket');
  }
  return body.ticket;
}

/**
 * Build the upgrade URL for a ticket.
 *
 * `encodeURIComponent` is not decoration. The pre-TRA-4488 call sites
 * interpolated the session token raw and were safe only because a base64url
 * payload plus a `.` happens to contain no URL-special character — safe by
 * coincidence, as the issue notes. A ticket is base64url too, so this is again
 * a no-op today; it is here so the next change of encoding cannot turn a
 * correct-looking interpolation into a silently truncated credential.
 */
export function buildSocketUrl(serverUrl: string, ticket: string): string {
  return `${serverUrl}?ticket=${encodeURIComponent(ticket)}`;
}
