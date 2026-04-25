import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const scryptAsync = promisify(scrypt);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');

export interface User {
  username: string;
  email: string;
  passwordHash: string;
  role: 'admin' | 'user';
  createdAt: string;
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
    // Seed default admin user
    const defaultUser: User = {
      username: 'admin',
      email: '',
      passwordHash: await hashPassword('1234'),
      role: 'admin',
      createdAt: new Date().toISOString(),
    };
    users = [defaultUser];
    await persistUsers();
    return;
  }
  try {
    const raw = await readFile(USERS_FILE, 'utf-8');
    users = JSON.parse(raw) as User[];
  } catch {
    users = [];
  }
}

export function getUser(username: string): User | undefined {
  return users.find(u => u.username === username);
}

export function getUserByEmail(email: string): User | undefined {
  return users.find(u => u.email.toLowerCase() === email.toLowerCase());
}

export function getAllUsers(): SafeUser[] {
  return users.map(({ passwordHash: _ph, ...safe }) => safe);
}

export async function validateUserCredentials(username: string, password: string): Promise<boolean> {
  const user = getUser(username);
  if (!user) return false;
  return verifyPassword(password, user.passwordHash);
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
