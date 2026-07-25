import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

// two-factor.ts hashes codes with auth.ts's signing secret, captured at module
// eval — pin AUTH_SECRET before either module loads (same pattern as
// auth.test.ts).
process.env.AUTH_SECRET = 'tra1505-test-secret-do-not-use-in-prod';
process.env.OTP_MAX_ATTEMPTS = '5';
process.env.OTP_MAX_SENDS = '3';

type TF = typeof import('./two-factor.js');
let issueChallenge: TF['issueChallenge'];
let resendChallenge: TF['resendChallenge'];
let verifyChallenge: TF['verifyChallenge'];
let resetTwoFactorStore: TF['resetTwoFactorStore'];
let stashEnrollmentBackupCodes: TF['stashEnrollmentBackupCodes'];
let takeEnrollmentBackupCodes: TF['takeEnrollmentBackupCodes'];

beforeAll(async () => {
  const mod = await import('./two-factor.js');
  issueChallenge = mod.issueChallenge;
  resendChallenge = mod.resendChallenge;
  verifyChallenge = mod.verifyChallenge;
  resetTwoFactorStore = mod.resetTwoFactorStore;
  stashEnrollmentBackupCodes = mod.stashEnrollmentBackupCodes;
  takeEnrollmentBackupCodes = mod.takeEnrollmentBackupCodes;
});

beforeEach(() => resetTwoFactorStore());

describe('issueChallenge / verifyChallenge', () => {
  it('issues a 6-digit numeric code', () => {
    const { code } = issueChallenge('alice');
    expect(code).toMatch(/^\d{6}$/);
  });

  it('verifies the correct code once, then treats it as consumed', () => {
    const { code } = issueChallenge('alice');
    expect(verifyChallenge('alice', code)).toBe('ok');
    // single-use: the same code no longer works
    expect(verifyChallenge('alice', code)).toBe('no_challenge');
  });

  it('rejects a wrong code as invalid', () => {
    const { code } = issueChallenge('alice');
    const wrong = code === '000000' ? '111111' : '000000';
    expect(verifyChallenge('alice', wrong)).toBe('invalid');
  });

  it('returns no_challenge for a user with no challenge', () => {
    expect(verifyChallenge('nobody', '123456')).toBe('no_challenge');
  });
});

describe('attempt limiting', () => {
  it('burns the challenge after too many wrong codes', () => {
    const { code } = issueChallenge('alice');
    const wrong = code === '000000' ? '111111' : '000000';
    // OTP_MAX_ATTEMPTS = 5 → the 5th wrong submission burns it
    for (let i = 0; i < 4; i++) expect(verifyChallenge('alice', wrong)).toBe('invalid');
    expect(verifyChallenge('alice', wrong)).toBe('too_many_attempts');
    // even the correct code is now dead
    expect(verifyChallenge('alice', code)).toBe('no_challenge');
  });
});

describe('resend', () => {
  it('returns no_challenge when there is nothing to resend', () => {
    expect(resendChallenge('alice')).toEqual({ ok: false, reason: 'no_challenge' });
  });

  it('issues a fresh working code and invalidates the old one', () => {
    const first = issueChallenge('alice');
    const second = resendChallenge('alice');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // old code no longer valid, new one is
    if (first.code !== second.code) {
      expect(verifyChallenge('alice', first.code)).toBe('invalid');
    }
    expect(verifyChallenge('alice', second.code)).toBe('ok');
  });

  it('caps the number of sends per challenge', () => {
    issueChallenge('alice'); // sends = 1
    expect(resendChallenge('alice').ok).toBe(true); // 2
    expect(resendChallenge('alice').ok).toBe(true); // 3 (OTP_MAX_SENDS)
    expect(resendChallenge('alice')).toEqual({ ok: false, reason: 'too_many_sends' });
  });
});

// TRA-2293 — backup codes minted by a login-screen 2FA opt-in wait here between
// the password step and the second factor.
describe('enrollment backup-code stash', () => {
  it('hands the codes back exactly once', () => {
    stashEnrollmentBackupCodes('alice', ['AAAA-1111', 'BBBB-2222']);
    expect(takeEnrollmentBackupCodes('alice')).toEqual(['AAAA-1111', 'BBBB-2222']);
    // A second /2fa/verify must not re-issue permanent bypass codes.
    expect(takeEnrollmentBackupCodes('alice')).toBeNull();
  });

  it('returns null for the ordinary sign-in that enrolled nothing', () => {
    expect(takeEnrollmentBackupCodes('nobody')).toBeNull();
  });

  it('keeps stashes separate per user', () => {
    stashEnrollmentBackupCodes('alice', ['AAAA-1111']);
    stashEnrollmentBackupCodes('bob', ['BBBB-2222']);
    expect(takeEnrollmentBackupCodes('bob')).toEqual(['BBBB-2222']);
    expect(takeEnrollmentBackupCodes('alice')).toEqual(['AAAA-1111']);
  });

  it('is cleared by a store reset', () => {
    stashEnrollmentBackupCodes('alice', ['AAAA-1111']);
    resetTwoFactorStore();
    expect(takeEnrollmentBackupCodes('alice')).toBeNull();
  });
});
