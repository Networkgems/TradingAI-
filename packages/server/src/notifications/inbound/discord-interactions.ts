// TRA-852 — Discord Interactions transport for inbound conversational control.
//
// Follow-up to TRA-848, which shipped the channel-agnostic command core
// (command-parser + command-router) and wired it to the Telegram webhook. The
// grammar/engine path is already channel-neutral, so this module is purely the
// Discord-specific transport + auth:
//
//   1. Ed25519 request-signature verification. Discord signs every interaction
//      with the application's key and sends the signature/timestamp in the
//      `X-Signature-Ed25519` / `X-Signature-Timestamp` headers; the endpoint
//      MUST reject anything that fails verification against `DISCORD_PUBLIC_KEY`
//      (Discord itself probes this during URL setup and on a schedule).
//   2. The PING→PONG handshake Discord uses to validate the endpoint URL.
//   3. Flattening a slash-command / message-component interaction into the same
//      plain-text command string `parseCommand` already understands, plus the
//      Discord user id used to resolve the linked app user.
//
// Kept pure + dependency-injected (no Express, no engine) so the verifier and
// the interaction→text mapping are unit-testable with zero wiring.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/** Discord interaction `type` values (subset we handle). */
export const DISCORD_INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

/** Discord interaction-response `type` values (subset we emit). */
export const DISCORD_RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
} as const;

/** Message-flag bit that makes a reply ephemeral (only the invoker sees it). */
export const DISCORD_EPHEMERAL_FLAG = 64;

/**
 * DER SPKI prefix for an Ed25519 public key. Discord exposes the application
 * public key as 32 raw hex bytes; Node's `createPublicKey` wants SPKI, so we
 * prepend this fixed 12-byte header (algorithm = id-Ed25519, 1.3.101.112).
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Build a Node KeyObject from Discord's 32-byte hex public key. Throws on a
 * malformed key so a misconfigured `DISCORD_PUBLIC_KEY` fails loudly at wire
 * time rather than silently accepting every request.
 */
export function ed25519PublicKeyFromHex(hex: string) {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) {
    throw new Error(`DISCORD_PUBLIC_KEY must be 32 hex-encoded bytes, got ${raw.length}`);
  }
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export interface DiscordVerifyInput {
  /** Hex public key from `DISCORD_PUBLIC_KEY`. */
  publicKey: string | undefined;
  /** `X-Signature-Ed25519` header (hex). */
  signature: string | undefined;
  /** `X-Signature-Timestamp` header. */
  timestamp: string | undefined;
  /** The EXACT raw request body bytes (not the re-serialized parsed object). */
  rawBody: Buffer | string | undefined;
}

/**
 * Verify a Discord interaction request signature. Discord signs the
 * concatenation `timestamp + rawBody` with Ed25519. Returns false (never
 * throws) on any missing field, malformed key/signature, or verification
 * failure, so the caller can answer a clean 401 for everything that is not a
 * provably-authentic Discord request.
 */
export function verifyDiscordRequest(input: DiscordVerifyInput): boolean {
  const { publicKey, signature, timestamp, rawBody } = input;
  if (!publicKey || !signature || !timestamp || rawBody == null) return false;
  try {
    const key = ed25519PublicKeyFromHex(publicKey);
    const message = Buffer.concat([
      Buffer.from(timestamp, 'utf8'),
      typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody,
    ]);
    const sig = Buffer.from(signature, 'hex');
    // Ed25519 takes a null algorithm in Node's one-shot verify.
    return cryptoVerify(null, message, key, sig);
  } catch {
    return false;
  }
}

/** Minimal shape of the interaction payload fields we read. */
export interface DiscordInteraction {
  type?: number;
  data?: {
    name?: string;
    /** Slash-command options (`/approve id:AAPL` → [{ name:'id', value:'AAPL' }]). */
    options?: Array<{ name?: string; value?: unknown }>;
    /** Message-component identifier (carries the command text for buttons). */
    custom_id?: string;
  };
  /** Present for guild interactions: the invoking member. */
  member?: { user?: { id?: string } };
  /** Present for DM interactions: the invoking user directly. */
  user?: { id?: string };
}

export interface ExtractedInteraction {
  /** Flattened plain-text command, ready for `parseCommand`. */
  text: string;
  /** Resolved Discord user id (the link-token auth subject), or undefined. */
  userId: string | undefined;
}

/**
 * Flatten an APPLICATION_COMMAND / MESSAGE_COMPONENT interaction into the same
 * plain-text command string the channel-neutral parser consumes:
 *
 *   • slash command  → `name` + each option value, space-joined
 *       `/status`            → "status"
 *       `/approve id:AAPL`   → "approve AAPL"
 *       `/link token:ABC123` → "link ABC123"
 *   • message component → its `custom_id` verbatim
 *
 * Returns null when there is nothing actionable (e.g. a PING, or a payload with
 * no command name / custom_id).
 */
export function extractInteraction(interaction: DiscordInteraction): ExtractedInteraction | null {
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  const data = interaction.data;
  if (!data) return null;

  if (typeof data.name === 'string' && data.name.length > 0) {
    const args = (data.options ?? [])
      .map(o => (o.value == null ? '' : String(o.value)))
      .filter(v => v.length > 0);
    return { text: [data.name, ...args].join(' '), userId };
  }
  if (typeof data.custom_id === 'string' && data.custom_id.length > 0) {
    return { text: data.custom_id, userId };
  }
  return null;
}

/**
 * Parse a `link <token>` / `start <token>` command (leading slash tolerated)
 * into its token, mirroring Telegram's `/start <token>` linking flow for the
 * Discord transport. Returns null when the text is not a link command.
 */
export function parseDiscordLinkToken(text: string | undefined): string | null {
  if (!text) return null;
  const m = /^\/?(?:link|start)\s+(\S+)\s*$/i.exec(text.trim());
  return m ? m[1]! : null;
}
