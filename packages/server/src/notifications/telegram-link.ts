// TRA-566 (TRA-410 A2) — Telegram account-linking token store.
//
// The Settings → Notifications "Link…" button calls the link endpoint, which
// mints a short-lived opaque token and returns a `t.me/<bot>?start=<token>`
// deep link. When the user taps it, Telegram delivers `/start <token>` to the
// bot; the webhook handler consumes the token to learn which app user the chat
// belongs to and records the `chat_id` into their alert prefs.
//
// Tokens are single-use and expire quickly (the link is acted on within
// seconds in practice). In-memory is sufficient: a lost token on restart just
// means the user taps "Link…" again. No persistence, no external dependency.

import { randomBytes } from 'node:crypto';

/** Token lifetime — long enough to switch apps and tap, short enough to be safe. */
export const LINK_TOKEN_TTL_MS = 15 * 60_000;

interface LinkEntry {
  username: string;
  expiresAt: number;
}

const tokens = new Map<string, LinkEntry>();

/** Mint a single-use link token for `username`. */
export function issueLinkToken(username: string, now: number = Date.now()): string {
  pruneExpired(now);
  const token = randomBytes(24).toString('base64url');
  tokens.set(token, { username, expiresAt: now + LINK_TOKEN_TTL_MS });
  return token;
}

/**
 * Validate + consume a link token, returning the owning username (or null if
 * unknown/expired). Single-use: a valid token is removed on consumption.
 */
export function consumeLinkToken(token: string, now: number = Date.now()): string | null {
  pruneExpired(now);
  const entry = tokens.get(token);
  if (!entry) return null;
  tokens.delete(token);
  if (entry.expiresAt <= now) return null;
  return entry.username;
}

/** Test/inspection helper — number of live tokens. */
export function pendingLinkTokenCount(now: number = Date.now()): number {
  pruneExpired(now);
  return tokens.size;
}

/** Test seam — clear the store. */
export function __resetLinkTokensForTest(): void {
  tokens.clear();
}

function pruneExpired(now: number): void {
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(token);
  }
}

/**
 * Parse a Telegram update's message text for a `/start <token>` payload.
 * Returns the token, or null if the message isn't a start command.
 */
export function parseStartCommand(text: string | undefined): string | null {
  if (!text) return null;
  const m = /^\/start(?:@\w+)?\s+(\S+)\s*$/.exec(text.trim());
  return m ? m[1]! : null;
}
