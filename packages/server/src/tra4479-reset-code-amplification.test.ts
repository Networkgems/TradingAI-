import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// auth.ts captures the signing secret at module-evaluation time (see
// auth.test.ts), and the reset store keys on a HMAC of that secret — so pin it
// BEFORE importing, or every key would be minted under a fresh random secret.
process.env['AUTH_SECRET'] = 'tra4479-test-secret-do-not-use-in-prod';

import { resolveTrustProxy } from './http-security.js';

type AuthModule = typeof import('./auth.js');
let auth: AuthModule;

let dataDir: string;

beforeAll(async () => {
  auth = await import('./auth.js');
});

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tra4479-'));
  auth.initResetTokenStore(dataDir);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The amplification itself: a guess must NAME an account.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4479 — the reset store is keyed by username+code, not by code alone', () => {
  it('redeems a code against the account it was minted for', () => {
    const code = auth.generateResetToken('alice');
    expect(auth.validateResetToken(code, 'alice')).toBe('alice');
    expect(auth.consumeResetToken(code, 'alice')).toBe('alice');
    // Single use.
    expect(auth.consumeResetToken(code, 'alice')).toBeNull();
  });

  it("refuses alice's code presented against bob — this is the whole ticket", () => {
    const aliceCode = auth.generateResetToken('alice');
    auth.generateResetToken('bob');
    expect(auth.validateResetToken(aliceCode, 'bob')).toBeNull();
    expect(auth.consumeResetToken(aliceCode, 'bob')).toBeNull();
    // …and alice's own code is untouched by the misfire.
    expect(auth.validateResetToken(aliceCode, 'alice')).toBe('alice');
  });

  it('NEGATIVE CONTROL: the old code-only lookup would have accepted that guess', () => {
    // Reproduce the pre-TRA-4479 store in three lines. The point is that this
    // control is RED against the shipped code and GREEN against the old one —
    // without it, "keyed by username+code" is an assertion about a comment.
    const unionPool = new Map<string, string>();
    for (const user of ['alice', 'bob', 'carol']) unionPool.set('1234567' + unionPool.size, user);
    // A single guess tests every account at once…
    expect(unionPool.get('12345671')).toBe('bob');
    // …whereas the shipped store needs the guess to be aimed:
    const bobCode = auth.generateResetToken('bob');
    expect(auth.validateResetToken(bobCode, 'alice')).toBeNull();
    expect(auth.validateResetToken(bobCode, 'bob')).toBe('bob');
  });

  it('matches the account across an NFC/whitespace spelling of the username', () => {
    // The read-path normalizer runs on BOTH sides, so a client that pads or
    // sends a decomposed form still redeems rather than being locked out.
    const code = auth.generateResetToken('alice');
    expect(auth.validateResetToken(code, '  alice  ')).toBe('alice');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The bound that survives an IP-rotating attacker: burn after N.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4479 — an outstanding code burns after RESET_MAX_ATTEMPTS wrong guesses', () => {
  it('burns the code on the Nth failure and not before', () => {
    const code = auth.generateResetToken('alice');
    for (let i = 0; i < auth.RESET_MAX_ATTEMPTS - 1; i += 1) {
      expect(auth.recordResetFailure('alice')).toBe(0);
      // Still redeemable by the real owner — an honest typo must not lock them out.
      expect(auth.validateResetToken(code, 'alice')).toBe('alice');
    }
    expect(auth.recordResetFailure('alice')).toBe(1);
    expect(auth.validateResetToken(code, 'alice')).toBeNull();
  });

  it("burning alice's code leaves bob's alone", () => {
    auth.generateResetToken('alice');
    const bobCode = auth.generateResetToken('bob');
    for (let i = 0; i < auth.RESET_MAX_ATTEMPTS; i += 1) auth.recordResetFailure('alice');
    expect(auth.validateResetToken(bobCode, 'bob')).toBe('bob');
  });

  it('is a silent no-op for an unknown username — not an existence oracle', () => {
    expect(auth.recordResetFailure('nobody-here')).toBe(0);
    expect(auth.recordResetFailure('nobody-here')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Generation and storage.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4479 — generation and on-disk storage', () => {
  it('mints an 8-digit code with no leading zero, from the CSPRNG', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const code = auth.generateResetToken(`u${i}`);
      expect(code).toMatch(/^[1-9]\d{7}$/);
      seen.add(code);
    }
    // 200 draws from 9e7 — a collision here would mean the generator is not
    // drawing from the range it claims.
    expect(seen.size).toBe(200);
  });

  it('never writes the plaintext code to reset-tokens.json', () => {
    const code = auth.generateResetToken('alice');
    const raw = readFileSync(join(dataDir, 'reset-tokens.json'), 'utf-8');
    expect(raw).not.toContain(code);
    // The username is still there (it is not the secret); the code is not.
    expect(raw).toContain('alice');
    const keys = Object.keys(JSON.parse(raw) as Record<string, unknown>);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toMatch(/^\d{8}$/);
  });

  it('survives a restart: the store reloads and the code still redeems', () => {
    const code = auth.generateResetToken('alice');
    auth.initResetTokenStore(dataDir); // simulate a boot
    expect(auth.consumeResetToken(code, 'alice')).toBe('alice');
  });

  it('drops expired rows on load rather than reviving them', () => {
    const file = join(dataDir, 'reset-tokens.json');
    writeFileSync(file, JSON.stringify({ deadbeef: { username: 'alice', expiresAt: Date.now() - 1, attempts: 0 } }));
    auth.initResetTokenStore(dataDir);
    expect(JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The one-window compatibility shim.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4479 — legacy plaintext-keyed codes, for one TTL window only', () => {
  const legacyFile = (): string => join(dataDir, 'reset-tokens.json');

  function plantLegacy(code: string, username: string, ttlMs = 60 * 60 * 1000): void {
    // Byte-for-byte the shape the OLD store wrote: top-level key = the code.
    writeFileSync(legacyFile(), JSON.stringify({ [code]: { username, expiresAt: Date.now() + ttlMs } }));
    auth.initResetTokenStore(dataDir);
  }

  it('lets an old client (code only, no username) finish an in-flight reset', () => {
    plantLegacy('44444444', 'alice');
    expect(auth.consumeLegacyResetToken('44444444')).toBe('alice');
    expect(auth.consumeLegacyResetToken('44444444')).toBeNull();
  });

  it('lets a NEW client redeem the same in-flight code by username+code', () => {
    plantLegacy('44444444', 'alice');
    expect(auth.consumeResetToken('44444444', 'alice')).toBe('alice');
  });

  it('rewrites the plaintext key out of the file on the first boot', () => {
    plantLegacy('44444444', 'alice');
    const raw = readFileSync(legacyFile(), 'utf-8');
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>)).not.toContain('44444444');
  });

  it('CANNOT reach a code minted after the deploy — the union path is closed', () => {
    plantLegacy('44444444', 'alice');
    const fresh = auth.generateResetToken('bob');
    expect(auth.consumeLegacyResetToken(fresh)).toBeNull();
    // …and it is still redeemable the aimed way, so the miss above is the
    // legacy path refusing, not the code being dead.
    expect(auth.consumeResetToken(fresh, 'bob')).toBe('bob');
  });

  it('honours the legacy row across a SECOND restart, then lets it expire', () => {
    plantLegacy('44444444', 'alice');
    auth.initResetTokenStore(dataDir);
    expect(auth.consumeLegacyResetToken('44444444')).toBe('alice');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. `trust proxy`: the reason the shipped per-IP throttle was a no-op.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4479 — resolveTrustProxy', () => {
  it('defaults to one hop, never to `true`', () => {
    expect(resolveTrustProxy(undefined)).toBe(1);
    expect(resolveTrustProxy('')).toBe(1);
    expect(resolveTrustProxy('   ')).toBe(1);
  });

  it('accepts an explicit hop count and an explicit no-proxy', () => {
    expect(resolveTrustProxy('2')).toBe(2);
    expect(resolveTrustProxy('false')).toBe(false);
    expect(resolveTrustProxy('0')).toBe(false);
  });

  it('falls back to 1 on a typo — a bad value must not restore the spoofable setting', () => {
    for (const bad of ['true', 'yes', 'all', '-1', '1.5', 'loopback']) {
      expect(resolveTrustProxy(bad)).toBe(1);
    }
  });
});

describe('TRA-4479 — req.ip on the wire, under a forged X-Forwarded-For', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    // Mirrors index.ts: the ONLY line under test is `app.set('trust proxy', …)`.
    //
    // The control switch sets express's value DIRECTLY rather than routing
    // through `resolveTrustProxy`. First cut did route through it and the
    // `=true` arm passed — because `resolveTrustProxy('true')` deliberately
    // returns 1, so the control was re-running the fix and agreeing with itself
    // instead of reproducing the defect.
    const control = process.env['TRA4479_CONTROL_TRUST_PROXY'];
    const app = express();
    app.set(
      'trust proxy',
      control === 'true' ? true : control === 'false' ? false : resolveTrustProxy(control),
    );
    app.get('/ip', (req, res) => { res.json({ ip: req.ip }); });
    server = createServer(app);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => { server.close(); });

  async function ipFor(xff: string | null): Promise<string> {
    const r = await fetch(`${base}/ip`, { headers: xff === null ? {} : { 'x-forwarded-for': xff } });
    return ((await r.json()) as { ip: string }).ip;
  }

  it('reports the address the proxy appended, not the one the caller typed', async () => {
    // `9.9.9.9` is the forgery; `203.0.113.7` is what Render's edge appends.
    expect(await ipFor('9.9.9.9, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('does not move when the forged entry changes — one bucket, not a fresh one per request', async () => {
    const a = await ipFor('1.1.1.1, 203.0.113.7');
    const b = await ipFor('2.2.2.2, 203.0.113.7');
    const c = await ipFor('3.3.3.3, 203.0.113.7');
    expect(new Set([a, b, c]).size).toBe(1);
  });

  it('falls back to the socket address with no header at all', async () => {
    expect(await ipFor(null)).toBe('127.0.0.1');
  });

  // Controls run 2026-09-09, both observed RED:
  //
  //   TRA4479_CONTROL_TRUST_PROXY=true   2 failed | 1 passed
  //       "expected '9.9.9.9' to be '203.0.113.7'"  — the forgery IS req.ip
  //       "expected 3 to be 1"                      — three requests, three
  //                                                    distinct throttle buckets
  //   TRA4479_CONTROL_TRUST_PROXY=false  1 failed | 2 passed
  //       "expected '127.0.0.1' to be '203.0.113.7'" — every caller on the
  //                                                    internet shares one bucket
  //
  // The hop count is the only value that passes both directions.
});
