import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'auth' });

/**
 * Resolve the HMAC signing secret (TRA-404).
 *
 * On Render, `render.yaml` injects `AUTH_SECRET` via `generateValue: true`,
 * which Render generates once and persists across deploys — so the env var is
 * always present in production. The old `?? randomBytes(32)` fallback silently
 * span up an *ephemeral* secret whenever the env var was missing, which on a
 * non-Render production host means every restart invalidates all sessions and
 * old `?? randomBytes(32)` fallback silently spun up an *ephemeral* secret
 * whenever the env var was missing, which on a non-Render production host
 * means every restart invalidates all sessions and the operator never finds
 * out. Fail loud there instead; keep the ephemeral fallback (with a loud
 * warning) only for local dev / tests.
 */
function resolveAuthSecret(): string {
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const onRender = !!process.env.RENDER;
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && !onRender) {
    throw new Error(
      'AUTH_SECRET is not set. Refusing to start in production with an ephemeral ' +
        'signing key — every restart would silently invalidate all sessions. Set ' +
        'AUTH_SECRET in the environment (Render injects it automatically via ' +
        'render.yaml `generateValue: true`).',
    );
  }
  log.warn(
    'AUTH_SECRET is not set — using an ephemeral random secret. All ' +
      'sessions will be invalidated when the process restarts. Set AUTH_SECRET ' +
      'for stable sessions.',
  );
  return randomBytes(32).toString('hex');
}

const SECRET = resolveAuthSecret();

/**
 * Max session-token lifetime in ms (TRA-404 / C1). Configurable via
 * `AUTH_TOKEN_TTL_HOURS`; defaults to 24h. Invalid / non-positive values fall
 * back to the default so a typo can never disable expiry.
 */
export function resolveTtlMs(raw: string | undefined): number {
  const DEFAULT_HOURS = 24;
  const hours = raw === undefined || raw.trim() === '' ? DEFAULT_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_HOURS * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

export const TOKEN_TTL_MS = resolveTtlMs(process.env.AUTH_TOKEN_TTL_HOURS);

function sign(encoded: string): string {
  return createHmac('sha256', SECRET).update(encoded).digest('base64url');
}

/**
 * TRA-1505 — keyed hash for short-lived secrets we must store but never keep in
 * plaintext (email OTP codes, 2FA backup codes). Reuses the same server-side
 * `SECRET` so a leaked on-disk store can't be reversed without it, and hands
 * callers a constant-time comparator. Never log the plaintext input.
 */
export function hashSecretValue(value: string): string {
  return createHmac('sha256', SECRET).update(value).digest('base64url');
}

/** Constant-time compare of a plaintext value against a `hashSecretValue` hash. */
export function verifySecretHash(value: string, hash: string): boolean {
  try {
    const a = Buffer.from(hashSecretValue(value));
    const b = Buffer.from(hash);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * TRA-1505 — pending-auth token TTL. After a correct password an enrolled user
 * gets a *pending* token (not a full session) that only lets them complete the
 * second factor; it expires fast so a stolen pending token is near-useless.
 * Configurable via `AUTH_PENDING_TTL_MIN`; defaults to 10 minutes.
 */
export function resolvePendingTtlMs(raw: string | undefined): number {
  const DEFAULT_MIN = 10;
  const min = raw === undefined || raw.trim() === '' ? DEFAULT_MIN : Number(raw);
  if (!Number.isFinite(min) || min <= 0) return DEFAULT_MIN * 60 * 1000;
  return min * 60 * 1000;
}

export const PENDING_TOKEN_TTL_MS = resolvePendingTtlMs(process.env.AUTH_PENDING_TTL_MIN);

/**
 * Verify a token's signature and return its decoded payload, or null if the
 * signature does not match. Shared by the session- and pending-token verifiers.
 */
function verifySignedPayload(token: string): Record<string, unknown> | null {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Issue a signed session token. `issuedAt` defaults to now; an explicit value
 * exists for tests that need to simulate an aged token.
 */
export function createToken(username: string, issuedAt: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ sub: username, iat: issuedAt })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): string | null {
  const data = verifySignedPayload(token);
  if (!data) return null;
  if (typeof data['sub'] !== 'string') return null;
  // TRA-1505: a pending-auth token (issued after password but before the second
  // factor) must NEVER be accepted as a full session — reject it here so the
  // client can't skip 2FA by presenting its pending token to a protected route.
  if (data['typ'] === 'pending2fa') return null;
  const iat = data['iat'];
  // C1 (TRA-404): enforce a max token lifetime. `createToken` always stamps a
  // numeric `iat`, so a token missing/!finite `iat` is malformed or forged →
  // reject. Tokens older than TOKEN_TTL_MS are expired → reject.
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (Date.now() - iat > TOKEN_TTL_MS) return null;
  return data['sub'] as string;
}

/**
 * TRA-1505 — issue a short-lived pending-auth token after a correct password
 * when the account requires a second factor. It carries `typ: 'pending2fa'` so
 * `verifyToken` refuses it as a session; only `/api/auth/2fa/verify` accepts it,
 * and only to complete the OTP step.
 */
export function createPendingToken(username: string, issuedAt: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: username, iat: issuedAt, typ: 'pending2fa' }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyPendingToken(token: string): string | null {
  const data = verifySignedPayload(token);
  if (!data) return null;
  if (typeof data['sub'] !== 'string') return null;
  if (data['typ'] !== 'pending2fa') return null;
  const iat = data['iat'];
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (Date.now() - iat > PENDING_TOKEN_TTL_MS) return null;
  return data['sub'] as string;
}

// ── Password reset tokens ─────────────────────────────────────────────────────

interface ResetEntry {
  username: string;
  expiresAt: number;
}

const resetTokens = new Map<string, ResetEntry>();
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
let resetTokensFile: string | null = null;

export function initResetTokenStore(dataDir: string): void {
  resetTokensFile = join(dataDir, 'reset-tokens.json');
  if (!existsSync(resetTokensFile)) return;
  try {
    const raw = readFileSync(resetTokensFile, 'utf-8');
    const data = JSON.parse(raw) as Record<string, ResetEntry>;
    const now = Date.now();
    for (const [code, entry] of Object.entries(data)) {
      if (entry.expiresAt > now) resetTokens.set(code, entry);
    }
  } catch { /* ignore corrupt file */ }
}

function persistResetTokens(): void {
  if (!resetTokensFile) return;
  const data: Record<string, ResetEntry> = {};
  for (const [code, entry] of resetTokens) data[code] = entry;
  try { writeFileSync(resetTokensFile, JSON.stringify(data), 'utf-8'); } catch { /* best-effort */ }
}

export function generateResetToken(username: string): string {
  // 8-digit numeric code
  const code = String(Math.floor(10_000_000 + Math.random() * 90_000_000));
  resetTokens.set(code, { username, expiresAt: Date.now() + RESET_TTL_MS });
  persistResetTokens();
  return code;
}

export function validateResetToken(code: string): string | null {
  const entry = resetTokens.get(code);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resetTokens.delete(code);
    persistResetTokens();
    return null;
  }
  return entry.username;
}

export function consumeResetToken(code: string): string | null {
  const username = validateResetToken(code);
  if (username) {
    resetTokens.delete(code);
    persistResetTokens();
  }
  return username;
}
