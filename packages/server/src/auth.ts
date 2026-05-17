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
 * Issue a signed session token. `issuedAt` defaults to now; an explicit value
 * exists for tests that need to simulate an aged token.
 */
export function createToken(username: string, issuedAt: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ sub: username, iat: issuedAt })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): string | null {
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
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof data.sub !== 'string') return null;
    // C1 (TRA-404): enforce a max token lifetime. `createToken` always stamps a
    // numeric `iat`, so a token missing/!finite `iat` is malformed or forged →
    // reject. Tokens older than TOKEN_TTL_MS are expired → reject.
    if (typeof data.iat !== 'number' || !Number.isFinite(data.iat)) return null;
    if (Date.now() - data.iat > TOKEN_TTL_MS) return null;
    return data.sub;
  } catch {
    return null;
  }
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
