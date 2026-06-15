import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  verifyDiscordRequest,
  extractInteraction,
  parseDiscordLinkToken,
  ed25519PublicKeyFromHex,
  DISCORD_INTERACTION_TYPE,
} from './discord-interactions.js';

// Build a deterministic Ed25519 keypair and expose the public key as the raw
// 32-byte hex string Discord publishes (DISCORD_PUBLIC_KEY).
function makeKeypair(): { publicHex: string; sign: (msg: Buffer) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  // Strip the 12-byte SPKI header to recover the 32 raw key bytes.
  const publicHex = der.subarray(der.length - 32).toString('hex');
  return {
    publicHex,
    sign: (msg: Buffer) => cryptoSign(null, msg, privateKey).toString('hex'),
  };
}

describe('ed25519PublicKeyFromHex', () => {
  it('rejects a key that is not 32 bytes', () => {
    expect(() => ed25519PublicKeyFromHex('abcd')).toThrow(/32/);
  });
  it('accepts a valid 32-byte hex key', () => {
    const { publicHex } = makeKeypair();
    expect(() => ed25519PublicKeyFromHex(publicHex)).not.toThrow();
  });
});

describe('verifyDiscordRequest', () => {
  it('accepts a correctly signed request', () => {
    const { publicHex, sign } = makeKeypair();
    const timestamp = '1700000000';
    const rawBody = JSON.stringify({ type: 1 });
    const signature = sign(Buffer.from(timestamp + rawBody));
    expect(
      verifyDiscordRequest({ publicKey: publicHex, signature, timestamp, rawBody }),
    ).toBe(true);
  });

  it('accepts a Buffer rawBody (the Express path)', () => {
    const { publicHex, sign } = makeKeypair();
    const timestamp = '1700000001';
    const rawBody = Buffer.from(JSON.stringify({ type: 2, data: { name: 'status' } }));
    const signature = sign(Buffer.concat([Buffer.from(timestamp), rawBody]));
    expect(
      verifyDiscordRequest({ publicKey: publicHex, signature, timestamp, rawBody }),
    ).toBe(true);
  });

  it('rejects a tampered body', () => {
    const { publicHex, sign } = makeKeypair();
    const timestamp = '1700000000';
    const signature = sign(Buffer.from(timestamp + JSON.stringify({ type: 1 })));
    expect(
      verifyDiscordRequest({
        publicKey: publicHex,
        signature,
        timestamp,
        rawBody: JSON.stringify({ type: 2 }), // different from what was signed
      }),
    ).toBe(false);
  });

  it('rejects a signature made with a different key', () => {
    const a = makeKeypair();
    const b = makeKeypair();
    const timestamp = '1700000000';
    const rawBody = JSON.stringify({ type: 1 });
    const signature = b.sign(Buffer.from(timestamp + rawBody));
    expect(
      verifyDiscordRequest({ publicKey: a.publicHex, signature, timestamp, rawBody }),
    ).toBe(false);
  });

  it('returns false (never throws) on missing fields', () => {
    expect(verifyDiscordRequest({ publicKey: undefined, signature: 'x', timestamp: 't', rawBody: 'b' })).toBe(false);
    expect(verifyDiscordRequest({ publicKey: 'aa', signature: undefined, timestamp: 't', rawBody: 'b' })).toBe(false);
    expect(verifyDiscordRequest({ publicKey: 'aa', signature: 'x', timestamp: undefined, rawBody: 'b' })).toBe(false);
    expect(verifyDiscordRequest({ publicKey: 'aa', signature: 'x', timestamp: 't', rawBody: undefined })).toBe(false);
  });

  it('returns false on a malformed (non-hex / wrong-length) public key', () => {
    expect(verifyDiscordRequest({ publicKey: 'zz', signature: 'aa', timestamp: 't', rawBody: 'b' })).toBe(false);
  });
});

describe('extractInteraction', () => {
  it('flattens a bare slash command to its name', () => {
    const out = extractInteraction({
      type: DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND,
      data: { name: 'status' },
      member: { user: { id: 'U1' } },
    });
    expect(out).toEqual({ text: 'status', userId: 'U1' });
  });

  it('appends option values in order (approve id:AAPL)', () => {
    const out = extractInteraction({
      type: 2,
      data: { name: 'approve', options: [{ name: 'id', value: 'AAPL' }] },
      member: { user: { id: 'U1' } },
    });
    expect(out).toEqual({ text: 'approve AAPL', userId: 'U1' });
  });

  it('reads the user id from a DM interaction (no member)', () => {
    const out = extractInteraction({
      type: 2,
      data: { name: 'scan' },
      user: { id: 'DM-USER' },
    });
    expect(out).toEqual({ text: 'scan', userId: 'DM-USER' });
  });

  it('uses a message-component custom_id verbatim', () => {
    const out = extractInteraction({
      type: 3,
      data: { custom_id: 'approve AAPL' },
      member: { user: { id: 'U1' } },
    });
    expect(out).toEqual({ text: 'approve AAPL', userId: 'U1' });
  });

  it('returns null when there is no data', () => {
    expect(extractInteraction({ type: 1 })).toBeNull();
  });

  it('drops empty option values rather than emitting blanks', () => {
    const out = extractInteraction({
      type: 2,
      data: { name: 'approve', options: [{ name: 'id', value: '' }, { name: 'x', value: 'AAPL' }] },
      member: { user: { id: 'U1' } },
    });
    expect(out).toEqual({ text: 'approve AAPL', userId: 'U1' });
  });
});

describe('parseDiscordLinkToken', () => {
  it('parses /link <token>', () => {
    expect(parseDiscordLinkToken('/link ABC123')).toBe('ABC123');
  });
  it('parses link <token> without a leading slash (slash-command flattening)', () => {
    expect(parseDiscordLinkToken('link ABC123')).toBe('ABC123');
  });
  it('parses start <token> as an alias', () => {
    expect(parseDiscordLinkToken('start ABC123')).toBe('ABC123');
  });
  it('is case-insensitive on the verb', () => {
    expect(parseDiscordLinkToken('LINK ABC123')).toBe('ABC123');
  });
  it('returns null for non-link text and bare verbs', () => {
    expect(parseDiscordLinkToken('status')).toBeNull();
    expect(parseDiscordLinkToken('link')).toBeNull();
    expect(parseDiscordLinkToken(undefined)).toBeNull();
    expect(parseDiscordLinkToken('')).toBeNull();
  });
});
