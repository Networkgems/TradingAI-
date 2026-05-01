import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const scryptAsync = promisify(scrypt);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');
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
}

export type SafeUser = Omit<User, 'passwordHash'>;

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
      console.log('\n[TradingAI] First-run admin account created.');
      console.log('[TradingAI] Username: admin');
      console.log(`[TradingAI] Password: ${initialPassword}`);
      console.log('[TradingAI] Change this password immediately after logging in.\n');
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
        console.log('[TradingAI] Admin password updated from ADMIN_PASSWORD env var.');
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
  return users.map(({ passwordHash: _ph, ...safe }) => ({ ...safe, locked: safe.locked ?? false }));
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
