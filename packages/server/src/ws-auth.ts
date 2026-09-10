/**
 * TRA-4488 — WebSocket upgrade authentication.
 *
 * ## The defect this replaces
 *
 * The upgrade handler used to read a **full 24h session token out of the query
 * string** (`wss://host/?token=<session>`), and both desktop clients put it
 * there. TLS protects the bytes on the wire and nothing else: the request line
 * is what a reverse proxy writes to its access log, so the token landed in
 * Render's access log, in every intermediary's log, in browser history, and in
 * a `Referer` if the URL were ever navigated. Anything that can read one of
 * those holds the account for the token's remaining TTL — it is not a scoped
 * credential, it is *the* credential.
 *
 * ## Why a ticket and not `Sec-WebSocket-Protocol`
 *
 * The audit offered the subprotocol header as the cheaper alternative, and it
 * is cheaper — no endpoint, no store. It was costed and rejected:
 *
 *   - it moves **the same full-TTL session token** to a different header. The
 *     leak surface shrinks; the blast radius of a leak does not change at all.
 *     A ticket is 30s and single-use, so a ticket recovered from any log is
 *     worthless by the time it is read. That difference is the whole ticket.
 *   - the browser/Tauri `WebSocket` constructor requires the server to echo a
 *     *selected* subprotocol back in the 101, and a mismatch closes the socket
 *     rather than erroring usefully. The failure mode of getting it subtly
 *     wrong is "dashboard is dead for everyone at once", which is the exact
 *     risk this issue's own description flags.
 *   - a token smuggled as a subprotocol value is constrained to the
 *     `Sec-WebSocket-Protocol` token grammar, so it needs its own encoding
 *     rules. The query-string version was only safe because base64url happens
 *     to be URL-safe — safe by coincidence. Trading one coincidence for
 *     another is not the fix.
 *
 * ## Shape of the store
 *
 * Tickets are 32 bytes of `randomBytes`, and **only `hashSecretValue(ticket)`
 * is ever retained** — the same keyed-hash discipline TRA-4479 applied to reset
 * codes, one step stronger: the map is in-process and never persisted, so no
 * plaintext and no hash ever touches disk. A restart drops outstanding tickets,
 * which is correct and free: a restart also drops every socket, and the clients
 * re-fetch on reconnect by construction (TRA-4488 work item 3).
 *
 * Keying by the ticket **alone** is deliberate and does not repeat the TRA-4479
 * mistake. That store was keyed by an 8-digit code, so one guess was tested
 * against the union of every outstanding code at once and the effective space
 * was 10^8/k. Here the space is 2^256 and k is irrelevant; there is also no
 * username on an upgrade to name, so username-keying is not even available.
 */

import { randomBytes } from 'node:crypto';
import { hashSecretValue, verifyToken } from './auth.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'ws-auth' });

/**
 * Ticket lifetime. Long enough for the client's own `fetch` → `new WebSocket`
 * round trip on a bad connection, short enough that a ticket scraped out of an
 * access log has already expired before anyone reads the log.
 */
export const WS_TICKET_TTL_MS = 30_000;

/**
 * Outstanding tickets kept per account. A legitimate client needs one, or two
 * if a reconnect races an in-flight fetch. The cap is what stops an
 * authenticated client from growing the map without bound by looping the
 * endpoint; the oldest is evicted, so the newest ticket always works.
 */
export const WS_TICKET_MAX_PER_USER = 8;

interface TicketEntry {
  username: string;
  expiresAt: number;
  /** Mint order, used only to pick the eviction victim under the per-user cap. */
  seq: number;
}

/** Keyed by `hashSecretValue(ticket)`. The plaintext ticket is never a key. */
const tickets = new Map<string, TicketEntry>();
let seqCounter = 0;

/** Since-boot counters. See `wsAuthCounters` for why these are not the tape. */
const counters = {
  ticketsIssued: 0,
  ticketsRedeemed: 0,
  ticketsRefused: 0,
  legacyTokenUpgrades: 0,
  legacyTokenRefused: 0,
};

function pruneExpired(now: number): number {
  let dropped = 0;
  for (const [key, entry] of tickets) {
    if (entry.expiresAt <= now) { tickets.delete(key); dropped += 1; }
  }
  return dropped;
}

function enforcePerUserCap(username: string): void {
  const mine: Array<[string, TicketEntry]> = [];
  for (const pair of tickets) if (pair[1].username === username) mine.push(pair);
  if (mine.length <= WS_TICKET_MAX_PER_USER) return;
  mine.sort((a, b) => a[1].seq - b[1].seq);
  for (const [key] of mine.slice(0, mine.length - WS_TICKET_MAX_PER_USER)) tickets.delete(key);
}

/**
 * Mint a single-use upgrade ticket for `username`. Returns the PLAINTEXT ticket,
 * which is the only copy that will ever exist — hand it straight to the caller
 * and never log it.
 */
export function issueWsTicket(username: string, now: number = Date.now()): string {
  const ticket = randomBytes(32).toString('base64url');
  pruneExpired(now);
  seqCounter += 1;
  tickets.set(hashSecretValue(ticket), { username, expiresAt: now + WS_TICKET_TTL_MS, seq: seqCounter });
  enforcePerUserCap(username);
  counters.ticketsIssued += 1;
  return ticket;
}

/**
 * Redeem a ticket, returning the account it was minted for, or null.
 *
 * **Burns the entry whether or not it was still valid.** Deleting before the
 * expiry test is the difference between single-use and merely short-lived: a
 * replay must fail on the second presentation even if the first presentation
 * was itself too late. This is the case the integration test isolates, because
 * a store that only checked the TTL would pass every other assertion.
 */
export function consumeWsTicket(ticket: string, now: number = Date.now()): string | null {
  if (!ticket) return null;
  const key = hashSecretValue(ticket);
  const entry = tickets.get(key);
  if (!entry) return null;
  tickets.delete(key);
  if (entry.expiresAt <= now) return null;
  return entry.username;
}

/** Outstanding (not-yet-redeemed, not-yet-pruned) ticket count. Tests + health. */
export function wsTicketsOutstanding(): number { return tickets.size; }

/** Drop every outstanding ticket. Used by tests and by account deletion. */
export function clearWsTickets(): number {
  const n = tickets.size;
  tickets.clear();
  return n;
}

/**
 * TRA-2421-shaped companion: drop every outstanding ticket for `username`, so a
 * deleted or signed-out account cannot have an upgrade land seconds later on a
 * ticket minted while it still existed. `closeUserSockets` hangs up the sockets
 * that are already open; this closes the 30s window in front of them.
 */
export function revokeWsTicketsFor(username: string): number {
  let revoked = 0;
  for (const [key, entry] of tickets) {
    if (entry.username !== username) continue;
    tickets.delete(key);
    revoked += 1;
  }
  return revoked;
}

// ── Legacy `?token=` compatibility window ────────────────────────────────────

/**
 * Whether the upgrade handler still accepts `?token=<session>`.
 *
 * This is the TRA-4479 `consumeLegacyResetToken` pattern: an in-flight client
 * that was shipped before this change holds a socket it will re-open on the
 * next reconnect, and cutting it off at the deploy is a dead dashboard for
 * whoever has the old build open. So the old door stays open for **one deploy
 * window** and then goes.
 *
 * It is resolved from the environment rather than hard-coded so the door can be
 * shut on bqb1 with an env write and a zero-byte redeploy (see CLAUDE.md
 * §"Merging does not deploy") the moment the tape says nothing is using it —
 * i.e. without waiting for a code release to be schedulable.
 *
 * Default is ACCEPT. An unparseable value is also ACCEPT: this switch's
 * fail-open direction is "an old client keeps working", and the alternative
 * (typo ⇒ every pre-upgrade client silently locked out) is the outage.
 */
export function resolveLegacyTokenAccepted(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false;
  return true;
}

export const LEGACY_TOKEN_ACCEPTED = resolveLegacyTokenAccepted(process.env.WS_LEGACY_TOKEN_QUERY);

// ── The upgrade decision ─────────────────────────────────────────────────────

export type UpgradeCredential = 'ticket' | 'legacy_token';

export type UpgradeAuthResult =
  | { ok: true; username: string; credential: UpgradeCredential }
  | { ok: false; reason: 'no_credential' | 'bad_ticket' | 'bad_token' | 'legacy_disabled' | 'no_such_user' };

export interface UpgradeAuthDeps {
  /** Same existence check `requireAuth` applies — see TRA-2421. */
  userExists: (username: string) => boolean;
  /** Defaults to `LEGACY_TOKEN_ACCEPTED`; the tests drive both arms. */
  allowLegacyToken?: boolean;
  now?: number;
}

/**
 * Authenticate a WebSocket upgrade from its request URL.
 *
 * Extracted out of `index.ts` so it can be graded: the production server is a
 * module that binds a port at import, so the integration test drives its own
 * `http.Server` + `WebSocketServer` — but it drives THIS function and THIS
 * store, not a local re-implementation of them. `ws-auth.wiring.test.ts`
 * asserts `index.ts`'s upgrade handler still routes through here and no longer
 * reads a token out of the query string itself.
 *
 * `rawUrl` is `req.url`, i.e. origin-form (`/?ticket=…`).
 */
export function authenticateUpgrade(
  rawUrl: string | undefined,
  deps: UpgradeAuthDeps,
): UpgradeAuthResult {
  const allowLegacy = deps.allowLegacyToken ?? LEGACY_TOKEN_ACCEPTED;
  const now = deps.now ?? Date.now();

  let params: URLSearchParams;
  try {
    params = new URL(rawUrl ?? '/', 'http://ws.invalid').searchParams;
  } catch {
    return { ok: false, reason: 'no_credential' };
  }

  const ticket = params.get('ticket') ?? '';
  if (ticket) {
    const username = consumeWsTicket(ticket, now);
    if (!username) { counters.ticketsRefused += 1; return { ok: false, reason: 'bad_ticket' }; }
    if (!deps.userExists(username)) { counters.ticketsRefused += 1; return { ok: false, reason: 'no_such_user' }; }
    counters.ticketsRedeemed += 1;
    return { ok: true, username, credential: 'ticket' };
  }

  const token = params.get('token') ?? '';
  if (!token) return { ok: false, reason: 'no_credential' };
  if (!allowLegacy) { counters.legacyTokenRefused += 1; return { ok: false, reason: 'legacy_disabled' }; }

  const username = verifyToken(token);
  if (!username) return { ok: false, reason: 'bad_token' };
  if (!deps.userExists(username)) return { ok: false, reason: 'no_such_user' };

  counters.legacyTokenUpgrades += 1;
  // THE REMOVAL DISCRIMINATOR, and it has to be on the log tape rather than in
  // the counter below. `legacyTokenUpgrades` is since-boot: bqb1's memory
  // watchdog restarts the process without writing a deploy record at all
  // (TRA-2203/TRA-2261), so reading 0 off a fresh process is indistinguishable
  // from "no client has used the old door since the deploy" — the former is
  // ignorance, the latter is the clearance to delete this branch. One line per
  // legacy upgrade, so the question is answered by grepping the Render log over
  // the window, which survives the restart. Carries no token and no ticket.
  log.warn('TRA-4488 WS upgrade authenticated by LEGACY ?token= query param — client predates the ticket handshake', {
    username,
    legacyUpgradesSinceBoot: counters.legacyTokenUpgrades,
  });
  return { ok: true, username, credential: 'legacy_token' };
}

/**
 * Since-boot counters for `/api/health/ws-auth`.
 *
 * ⚠ These are **since-boot** and bqb1 restarts without leaving a deploy record
 * (TRA-2203/TRA-2261), so `legacyTokenUpgrades: 0` here is NOT evidence the
 * compat branch is unused — it is equally consistent with a restart one second
 * ago. Grade the removal off the log tape (`TRA-4488 WS upgrade authenticated
 * by LEGACY`) over the whole window. `legacyAccepted` is printed so the door's
 * state is read, never assumed.
 */
export function wsAuthCounters(): Record<string, unknown> {
  return {
    ...counters,
    ticketsOutstanding: tickets.size,
    ticketTtlMs: WS_TICKET_TTL_MS,
    legacyAccepted: LEGACY_TOKEN_ACCEPTED,
  };
}

/** Test seam: reset counters alongside `clearWsTickets`. */
export function resetWsAuthCountersForTest(): void {
  counters.ticketsIssued = 0;
  counters.ticketsRedeemed = 0;
  counters.ticketsRefused = 0;
  counters.legacyTokenUpgrades = 0;
  counters.legacyTokenRefused = 0;
}
