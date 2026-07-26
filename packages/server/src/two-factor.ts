// TRA-1505 — Email one-time-code (OTP) challenge store for two-factor login.
//
// Phase 1 second factor: after a correct password, an enrolled user is emailed a
// 6-digit code. This module owns the *challenge* side of that flow — issuing,
// resending (rate-limited), and verifying codes — while keeping only a HASH of
// the code on disk (never the plaintext, never in a log). Enrollment state and
// backup codes live on the user record (see users.ts).
//
// Modeled on the reset-token store in auth.ts (file-backed, expiring), but with
// the extra hardening the OTP spec requires: hashed codes, a per-challenge wrong
// -attempt counter that burns the challenge when exceeded, and a per-challenge
// send counter that caps resends.
//
// State is per-username (one active challenge at a time) and persisted so a
// server restart mid-login doesn't strand a user who already has a code in their
// inbox. Codes are short-lived, so a lost file is at worst a re-request.

import { randomInt } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { hashSecretValue, verifySecretHash } from './auth.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'two-factor' });

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Code length in digits (6-digit numeric per spec). */
const OTP_LENGTH = 6;
/** Code lifetime; defaults to 10 minutes. */
const OTP_TTL_MS = numEnv('OTP_TTL_MIN', 10) * 60 * 1000;
/** Wrong verifications allowed before the challenge is burned. */
const OTP_MAX_ATTEMPTS = numEnv('OTP_MAX_ATTEMPTS', 5);
/** Codes emailed per challenge (initial send + resends). */
const OTP_MAX_SENDS = numEnv('OTP_MAX_SENDS', 5);

interface OtpChallenge {
  username: string;
  codeHash: string;
  expiresAt: number;
  /** Wrong-code submissions so far. */
  attempts: number;
  /** Codes emailed within this challenge (starts at 1 for the initial send). */
  sends: number;
}

const challenges = new Map<string, OtpChallenge>();
let challengeFile: string | null = null;

export function initTwoFactorStore(dataDir: string): void {
  challengeFile = join(dataDir, 'otp-challenges.json');
  if (!existsSync(challengeFile)) return;
  try {
    const raw = readFileSync(challengeFile, 'utf-8');
    const data = JSON.parse(raw) as Record<string, OtpChallenge>;
    const now = Date.now();
    for (const [user, entry] of Object.entries(data)) {
      if (entry.expiresAt > now) challenges.set(user, entry);
    }
  } catch { /* ignore corrupt file */ }
}

function persist(): void {
  if (!challengeFile) return;
  const data: Record<string, OtpChallenge> = {};
  for (const [user, entry] of challenges) data[user] = entry;
  try { writeFileSync(challengeFile, JSON.stringify(data), 'utf-8'); } catch { /* best-effort */ }
}

/** Generate a zero-padded numeric code of `OTP_LENGTH` digits. */
function generateCode(): string {
  const max = 10 ** OTP_LENGTH;
  return String(randomInt(0, max)).padStart(OTP_LENGTH, '0');
}

/**
 * Start a fresh challenge for `username`, replacing any existing one. Returns the
 * plaintext code so the caller can email it — the code is NOT retained anywhere
 * else. Do not log the returned value.
 */
export function issueChallenge(username: string): { code: string } {
  const code = generateCode();
  challenges.set(username, {
    username,
    codeHash: hashSecretValue(code),
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
    sends: 1,
  });
  persist();
  return { code };
}

export type ResendResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'no_challenge' | 'too_many_sends' };

/**
 * Re-issue a code for an in-flight challenge (user clicked "resend"). Caps the
 * number of sends per challenge and resets the expiry + wrong-attempt counter so
 * the new code gets a full window. Returns the new plaintext code to email.
 */
export function resendChallenge(username: string): ResendResult {
  const existing = challenges.get(username);
  if (!existing || existing.expiresAt <= Date.now()) {
    return { ok: false, reason: 'no_challenge' };
  }
  if (existing.sends >= OTP_MAX_SENDS) {
    return { ok: false, reason: 'too_many_sends' };
  }
  const code = generateCode();
  existing.codeHash = hashSecretValue(code);
  existing.expiresAt = Date.now() + OTP_TTL_MS;
  existing.attempts = 0;
  existing.sends += 1;
  challenges.set(username, existing);
  persist();
  return { ok: true, code };
}

export type VerifyResult = 'ok' | 'invalid' | 'expired' | 'too_many_attempts' | 'no_challenge';

/**
 * Verify a submitted code for `username`. On success the challenge is consumed
 * (single-use). On a wrong code the attempt counter increments; once it exceeds
 * the max the challenge is burned and the user must restart the login. Never
 * logs the submitted code.
 */
export function verifyChallenge(username: string, code: string): VerifyResult {
  const entry = challenges.get(username);
  if (!entry) return 'no_challenge';
  if (Date.now() > entry.expiresAt) {
    challenges.delete(username);
    persist();
    return 'expired';
  }
  if (verifySecretHash(code, entry.codeHash)) {
    challenges.delete(username);
    persist();
    return 'ok';
  }
  entry.attempts += 1;
  if (entry.attempts >= OTP_MAX_ATTEMPTS) {
    challenges.delete(username);
    persist();
    log.warn('2fa: challenge burned after too many wrong codes', { username });
    return 'too_many_attempts';
  }
  challenges.set(username, entry);
  persist();
  return 'invalid';
}

/**
 * TRA-2421 — forget every 2FA artefact for `username` on account deletion.
 * Returns how many pieces of state were dropped (challenge + stashed enrollment
 * codes), so a wipe receipt can distinguish "cleared something" from "there was
 * nothing to clear".
 *
 * `otp-challenges.json` sits at the DATA_DIR root like `reset-tokens.json`, so a
 * per-user directory wipe does not reach it. Usernames are recycled, and an
 * in-flight challenge keyed on a name is redeemable by whoever holds that name
 * next.
 */
export function forgetTwoFactorState(username: string): number {
  let cleared = 0;
  if (challenges.delete(username)) {
    cleared += 1;
    persist();
  }
  if (enrollmentCodes.delete(username)) cleared += 1;
  return cleared;
}

/** Test-only: wipe all in-flight challenges. */
export function resetTwoFactorStore(): void {
  challenges.clear();
  persist();
  enrollmentCodes.clear();
}

// ── TRA-2293 — backup codes minted by an enrol-at-login opt-in ────────────────
//
// The login screen lets a user opt into 2FA at the moment they sign in. Enrolment
// happens right after the password check, but the backup codes can only be shown
// once the second factor is actually cleared — otherwise a caller who merely knows
// a password would walk away with ten permanent bypass codes. So the codes wait
// here between /api/auth/login and /api/auth/2fa/verify.
//
// Deliberately memory-only: these are show-once secrets, and a restart in that
// ~10-minute window should drop them rather than leave them on disk. A user who
// loses them re-mints from Settings, which is the same path as before.

interface EnrollmentCodes {
  codes: string[];
  expiresAt: number;
}

const enrollmentCodes = new Map<string, EnrollmentCodes>();
/** Matches the pending-auth token lifetime; a stale entry is unreachable anyway. */
const ENROLLMENT_TTL_MS = 10 * 60 * 1000;

export function stashEnrollmentBackupCodes(username: string, codes: string[]): void {
  enrollmentCodes.set(username, { codes, expiresAt: Date.now() + ENROLLMENT_TTL_MS });
}

/**
 * Hand back (and forget) the codes stashed for `username`. Returns null when the
 * login did not enrol — the common case — so callers can spread the result.
 */
export function takeEnrollmentBackupCodes(username: string): string[] | null {
  const entry = enrollmentCodes.get(username);
  if (!entry) return null;
  enrollmentCodes.delete(username);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.codes;
}
