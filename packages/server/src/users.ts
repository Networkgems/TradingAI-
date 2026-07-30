import { scrypt, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { hashSecretValue, verifySecretHash } from './auth.js';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';

const log = logger.child({ module: 'users' });

const scryptAsync = promisify(scrypt);
const DATA_DIR = resolveDataDir();
const USERS_FILE = join(DATA_DIR, 'users.json');
// Tracks which ADMIN_PASSWORD value has already been applied so restarts don't
// overwrite a password the admin deliberately changed via the UI.
const ADMIN_RESET_MARKER = join(DATA_DIR, 'admin-reset-applied.json');

export interface User {
  username: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'user';
  createdAt: string;
  // TRA-217 — admins can lock an account; locked users cannot log in until unlocked.
  // Older users.json files predate this field, so it's optional and defaults to false.
  locked?: boolean;
  // TRA-1505 — opt-in email two-factor login. `enabled` gates the OTP challenge;
  // `backupCodeHashes` are single-use recovery codes (HMAC hashes only, never
  // plaintext) so a user whose email is unavailable can't get permanently locked
  // out. Older users.json files predate this field, so it's optional.
  twoFactor?: {
    enabled: boolean;
    backupCodeHashes?: string[];
  };
}

// TRA-1505 — the client-facing shape never carries the password hash nor the
// 2FA backup-code hashes; it exposes only whether 2FA is enabled.
export type SafeUser = Omit<User, 'passwordHash' | 'twoFactor'> & {
  twoFactor?: { enabled: boolean };
};

/** Strip all secret material from a user record for client responses. */
export function toSafeUser(user: User): SafeUser {
  const { passwordHash: _ph, twoFactor, ...rest } = user;
  return {
    ...rest,
    locked: rest.locked ?? false,
    ...(twoFactor ? { twoFactor: { enabled: twoFactor.enabled } } : {}),
  };
}

let users: User[] = [];

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  try {
    const hash = (await scryptAsync(password, salt, 64)) as Buffer;
    const stored64 = Buffer.from(hashHex, 'hex');
    if (hash.length !== stored64.length) return false;
    return timingSafeEqual(hash, stored64);
  } catch {
    return false;
  }
}

async function persistUsers(): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  await writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

export async function loadUsers(): Promise<void> {
  if (!existsSync(USERS_FILE)) {
    const envPassword = process.env.ADMIN_PASSWORD;
    const initialPassword = envPassword ?? randomBytes(16).toString('hex');
    const defaultUser: User = {
      username: 'admin',
      email: '',
      passwordHash: await hashPassword(initialPassword),
      role: 'admin',
      createdAt: new Date().toISOString(),
    };
    users = [defaultUser];
    await persistUsers();
    if (!envPassword) {
      // Intentional: console, not the structured logger. The generated admin
      // password is a secret and must not land in the on-disk `app.jsonl`
      // sink — this first-run banner prints it once to the operator's stdout.
      console.log(
        `[users] First-run admin account created — username: admin, password: ${initialPassword}`,
      );
      console.log('[users] Change this password immediately after logging in.');
    }
    return;
  }
  try {
    const raw = await readFile(USERS_FILE, 'utf-8');
    users = JSON.parse(raw) as User[];
  } catch {
    users = [];
  }

  // If ADMIN_PASSWORD env var is set, force-update the admin account password —
  // but only once per unique value. A marker file records a fingerprint of the
  // last-applied value so that server restarts don't overwrite a password the
  // admin has since changed via the UI.
  const forcePassword = process.env.ADMIN_PASSWORD;
  if (forcePassword) {
    const adminIdx = users.findIndex(u => u.username === 'admin');
    if (adminIdx !== -1) {
      const fingerprint = ((await scryptAsync(forcePassword, 'admin-reset-marker', 32)) as Buffer).toString('hex');
      let lastApplied: string | null = null;
      try {
        if (existsSync(ADMIN_RESET_MARKER)) {
          const raw = await readFile(ADMIN_RESET_MARKER, 'utf-8');
          lastApplied = (JSON.parse(raw) as { fingerprint: string }).fingerprint ?? null;
        }
      } catch { /* treat as not applied */ }

      if (lastApplied !== fingerprint) {
        users[adminIdx].passwordHash = await hashPassword(forcePassword);
        await persistUsers();
        await writeFile(ADMIN_RESET_MARKER, JSON.stringify({ fingerprint }), 'utf-8');
        log.info('Admin password updated from ADMIN_PASSWORD env var.');
      }
    }
  }
}

export function getUser(username: string): User | undefined {
  return users.find(u => u.username === username);
}

export function getUserByEmail(email: string): User | undefined {
  return users.find(u => u.email.toLowerCase() === email.toLowerCase());
}

export function getAllUsers(): SafeUser[] {
  return users.map(toSafeUser);
}

export function isUserLocked(username: string): boolean {
  const user = getUser(username);
  return !!user?.locked;
}

export async function validateUserCredentials(username: string, password: string): Promise<boolean> {
  const user = getUser(username);
  if (!user) return false;
  return verifyPassword(password, user.passwordHash);
}

export async function setUserLocked(username: string, locked: boolean): Promise<boolean> {
  const idx = users.findIndex(u => u.username === username);
  if (idx === -1) return false;
  users[idx].locked = locked;
  await persistUsers();
  return true;
}

export async function changeUserPassword(username: string, newPassword: string): Promise<boolean> {
  const idx = users.findIndex(u => u.username === username);
  if (idx === -1) return false;
  users[idx].passwordHash = await hashPassword(newPassword);
  await persistUsers();
  return true;
}

export async function updateUser(
  username: string,
  updates: Partial<Pick<User, 'email' | 'username'>>,
): Promise<{ ok: boolean; error?: string }> {
  const idx = users.findIndex(u => u.username === username);
  if (idx === -1) return { ok: false, error: 'User not found' };

  if (updates.username !== undefined && updates.username !== username) {
    if (users.some(u => u.username === updates.username)) {
      return { ok: false, error: 'Username already taken' };
    }
    users[idx].username = updates.username;
  }
  if (updates.email !== undefined) {
    users[idx].email = updates.email;
  }
  await persistUsers();
  return { ok: true };
}

export async function createUser(
  username: string,
  email: string,
  password: string,
  role: 'admin' | 'user' = 'user',
): Promise<{ user?: SafeUser; error?: string }> {
  if (users.some(u => u.username === username)) {
    return { error: 'Username already taken' };
  }
  const user: User = {
    username,
    email,
    passwordHash: await hashPassword(password),
    role,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await persistUsers();
  const { passwordHash: _ph, ...safe } = user;
  return { user: safe };
}

export async function deleteUser(username: string): Promise<boolean> {
  const idx = users.findIndex(u => u.username === username);
  if (idx === -1) return false;
  users.splice(idx, 1);
  await persistUsers();
  return true;
}

// ── TRA-1505 — two-factor (email OTP) enrollment + backup codes ────────────────

/** Number of single-use recovery codes minted when a user enables 2FA. */
const BACKUP_CODE_COUNT = 10;

export function isTwoFactorEnabled(username: string): boolean {
  return !!getUser(username)?.twoFactor?.enabled;
}

export function getTwoFactorStatus(username: string): { enabled: boolean; backupCodesRemaining: number } {
  const tf = getUser(username)?.twoFactor;
  return {
    enabled: !!tf?.enabled,
    backupCodesRemaining: tf?.backupCodeHashes?.length ?? 0,
  };
}

/** Generate a single human-friendly backup code, e.g. "4F2K-9QH3". */
function generateBackupCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  const pick = (n: number) => Array.from({ length: n }, () => alphabet[randomInt(0, alphabet.length)]).join('');
  return `${pick(4)}-${pick(4)}`;
}

/**
 * Enable email 2FA for a user and mint a fresh set of single-use backup codes.
 * Returns the PLAINTEXT codes exactly once (for the caller to show the user);
 * only their hashes are persisted. Fails if the user has no email on file, since
 * email is the phase-1 delivery channel.
 */
export async function enableTwoFactor(
  username: string,
): Promise<{ ok: true; backupCodes: string[] } | { ok: false; error: string }> {
  const idx = users.findIndex(u => u.username === username);
  if (idx === -1) return { ok: false, error: 'User not found' };
  if (!users[idx].email || !users[idx].email.includes('@')) {
    return { ok: false, error: 'Add a valid email to your account before enabling two-factor.' };
  }
  const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
  users[idx].twoFactor = {
    enabled: true,
    backupCodeHashes: backupCodes.map(hashSecretValue),
  };
  await persistUsers();
  log.info('2fa: enabled', { username });
  return { ok: true, backupCodes };
}

/** Disable 2FA and discard any remaining backup codes. */
export async function disableTwoFactor(username: string): Promise<boolean> {
  const idx = users.findIndex(u => u.username === username);
  if (idx === -1) return false;
  users[idx].twoFactor = { enabled: false };
  await persistUsers();
  log.info('2fa: disabled', { username });
  return true;
}

/**
 * Consume a single-use backup code as a recovery second factor. Returns true and
 * removes the code on match; false otherwise. Never logs the submitted code.
 */
export async function consumeBackupCode(username: string, code: string): Promise<boolean> {
  const idx = users.findIndex(u => u.username === username);
  if (idx === -1) return false;
  const hashes = users[idx].twoFactor?.backupCodeHashes;
  if (!hashes || hashes.length === 0) return false;
  const normalized = code.trim().toUpperCase();
  const matchIdx = hashes.findIndex(h => verifySecretHash(normalized, h));
  if (matchIdx === -1) return false;
  hashes.splice(matchIdx, 1);
  await persistUsers();
  return true;
}
