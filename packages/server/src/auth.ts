import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.AUTH_SECRET ?? randomBytes(32).toString('hex');

const CREDENTIALS: Record<string, string> = {
  admin: '1234',
};

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
  // Use timingSafeEqual to prevent timing attacks
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

export function validateCredentials(username: string, password: string): boolean {
  const stored = CREDENTIALS[username];
  if (!stored) return false;
  // Use timingSafeEqual to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(password), Buffer.from(stored));
  } catch {
    return false;
  }
}
