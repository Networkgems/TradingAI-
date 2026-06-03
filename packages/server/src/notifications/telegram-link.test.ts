import { describe, it, expect, beforeEach } from 'vitest';
import {
  issueLinkToken,
  consumeLinkToken,
  parseStartCommand,
  pendingLinkTokenCount,
  __resetLinkTokensForTest,
  LINK_TOKEN_TTL_MS,
} from './telegram-link.js';

beforeEach(() => __resetLinkTokensForTest());

describe('telegram link tokens', () => {
  it('issues a token that resolves back to the username once', () => {
    const t = issueLinkToken('alice');
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(10);
    expect(consumeLinkToken(t)).toBe('alice');
    // single-use
    expect(consumeLinkToken(t)).toBeNull();
  });

  it('returns null for an unknown token', () => {
    expect(consumeLinkToken('nope')).toBeNull();
  });

  it('expires tokens after the TTL', () => {
    const now = 1_000_000;
    const t = issueLinkToken('bob', now);
    expect(consumeLinkToken(t, now + LINK_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it('prunes expired tokens from the pending count', () => {
    const now = 5_000;
    issueLinkToken('a', now);
    issueLinkToken('b', now);
    expect(pendingLinkTokenCount(now)).toBe(2);
    expect(pendingLinkTokenCount(now + LINK_TOKEN_TTL_MS + 1)).toBe(0);
  });

  it('mints distinct tokens', () => {
    expect(issueLinkToken('a')).not.toBe(issueLinkToken('a'));
  });
});

describe('parseStartCommand', () => {
  it('extracts the token from /start <token>', () => {
    expect(parseStartCommand('/start abc123')).toBe('abc123');
    expect(parseStartCommand('/start@MyBot abc123')).toBe('abc123');
    expect(parseStartCommand('  /start  tok  ')).toBe('tok');
  });

  it('returns null for non-start or bare /start', () => {
    expect(parseStartCommand('/start')).toBeNull();
    expect(parseStartCommand('hello')).toBeNull();
    expect(parseStartCommand(undefined)).toBeNull();
    expect(parseStartCommand('')).toBeNull();
  });
});
