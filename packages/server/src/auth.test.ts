import { describe, it, expect, beforeAll } from 'vitest';

// auth.ts captures the signing secret at module-evaluation time, so pin a
// stable AUTH_SECRET BEFORE importing it — otherwise the module would warn and
// mint an ephemeral random secret (same dynamic-import pattern as
// account-settings.test.ts).
process.env.AUTH_SECRET = 'tra404-test-secret-do-not-use-in-prod';

type AuthModule = typeof import('./auth.js');
let createToken: AuthModule['createToken'];
let verifyToken: AuthModule['verifyToken'];
let resolveTtlMs: AuthModule['resolveTtlMs'];
let TOKEN_TTL_MS: AuthModule['TOKEN_TTL_MS'];

const HOUR_MS = 60 * 60 * 1000;

beforeAll(async () => {
  const mod = await import('./auth.js');
  createToken = mod.createToken;
  verifyToken = mod.verifyToken;
  resolveTtlMs = mod.resolveTtlMs;
  TOKEN_TTL_MS = mod.TOKEN_TTL_MS;
});

describe('createToken / verifyToken — basic round-trip', () => {
  it('verifies a freshly issued token and returns the subject', () => {
    expect(verifyToken(createToken('alice'))).toBe('alice');
  });

  it('preserves the exact username, including unusual characters', () => {
    const name = 'user.name+tag@weird';
    expect(verifyToken(createToken(name))).toBe(name);
  });
});

describe('verifyToken — signature rejection (TRA-404)', () => {
  it('rejects a token with no payload/signature separator', () => {
    expect(verifyToken('not-a-real-token')).toBeNull();
  });

  it('rejects a token whose signature has been tampered with', () => {
    const token = createToken('alice');
    const dot = token.lastIndexOf('.');
    const tampered = `${token.slice(0, dot)}.${token.slice(dot + 1)}AAAA`;
    expect(verifyToken(tampered)).toBeNull();
  });

  it('rejects a token whose payload has been swapped (signature no longer matches)', () => {
    const real = createToken('alice');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'attacker', iat: Date.now() }),
    ).toString('base64url');
    const forged = `${forgedPayload}.${real.slice(real.lastIndexOf('.') + 1)}`;
    expect(verifyToken(forged)).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(verifyToken('')).toBeNull();
  });
});

describe('verifyToken — token expiry (TRA-404 / C1)', () => {
  it('accepts a token issued well within the max lifetime', () => {
    const token = createToken('alice', Date.now() - 1 * HOUR_MS);
    expect(verifyToken(token)).toBe('alice');
  });

  it('accepts a token issued just under the 24h limit', () => {
    const token = createToken('alice', Date.now() - (TOKEN_TTL_MS - 60_000));
    expect(verifyToken(token)).toBe('alice');
  });

  it('rejects a token issued past the 24h max lifetime', () => {
    const token = createToken('alice', Date.now() - 25 * HOUR_MS);
    expect(verifyToken(token)).toBeNull();
  });

  it('rejects a token issued just over the 24h limit', () => {
    const token = createToken('alice', Date.now() - (TOKEN_TTL_MS + 60_000));
    expect(verifyToken(token)).toBeNull();
  });
});

describe('resolveTtlMs — AUTH_TOKEN_TTL_HOURS parsing', () => {
  it('defaults to 24h when unset', () => {
    expect(resolveTtlMs(undefined)).toBe(24 * HOUR_MS);
    expect(resolveTtlMs('')).toBe(24 * HOUR_MS);
    expect(resolveTtlMs('   ')).toBe(24 * HOUR_MS);
  });

  it('honours a valid positive override', () => {
    expect(resolveTtlMs('1')).toBe(HOUR_MS);
    expect(resolveTtlMs('48')).toBe(48 * HOUR_MS);
    expect(resolveTtlMs('0.5')).toBe(0.5 * HOUR_MS);
  });

  it('falls back to the default for non-positive or non-numeric values', () => {
    expect(resolveTtlMs('0')).toBe(24 * HOUR_MS);
    expect(resolveTtlMs('-5')).toBe(24 * HOUR_MS);
    expect(resolveTtlMs('abc')).toBe(24 * HOUR_MS);
    expect(resolveTtlMs('NaN')).toBe(24 * HOUR_MS);
  });

  it('exposes a 24h default through TOKEN_TTL_MS', () => {
    expect(TOKEN_TTL_MS).toBe(24 * HOUR_MS);
  });
});
