import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const SECRET = process.env.AUTH_SECRET ?? randomBytes(32).toString('hex');

function sign(encoded: string): string {
  return createHmac('sha256', SECRET).update(encoded).digest('base64url');
}

export function createToken(username: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: username, iat: Date.now() })).toString('base64url');
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
    return typeof data.sub === 'string' ? data.sub : null;
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
