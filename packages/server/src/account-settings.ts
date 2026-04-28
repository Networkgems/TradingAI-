import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AccountSettings } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(__dirname, '..', 'data');

// TRA-142 — settings, watchlist, equity, and trades are now per-user. Each
// user gets a directory under DATA_DIR/users/<username>/ and an in-memory
// cache keyed by username. The legacy DATA_DIR/account-settings.json is
// migrated into the admin namespace by `runFirstBootMigration` in user-context.

function userSettingsFile(username: string): string {
  return join(DATA_DIR, 'users', username, 'account-settings.json');
}

const cache: Map<string, AccountSettings> = new Map();

export async function loadSettings(username: string): Promise<AccountSettings> {
  const cached = cache.get(username);
  if (cached) return cached;
  const file = userSettingsFile(username);
  if (!existsSync(file)) {
    const fresh = { ...DEFAULT_ACCOUNT_SETTINGS };
    cache.set(username, fresh);
    return fresh;
  }
  try {
    const raw = await readFile(file, 'utf-8');
    const merged = { ...DEFAULT_ACCOUNT_SETTINGS, ...JSON.parse(raw) } as AccountSettings;
    cache.set(username, merged);
    return merged;
  } catch {
    const fresh = { ...DEFAULT_ACCOUNT_SETTINGS };
    cache.set(username, fresh);
    return fresh;
  }
}

export function getSettings(username: string): AccountSettings {
  return cache.get(username) ?? { ...DEFAULT_ACCOUNT_SETTINGS };
}

export async function saveSettings(username: string, settings: AccountSettings): Promise<void> {
  const dir = dirname(userSettingsFile(username));
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  cache.set(username, { ...settings });
  await writeFile(userSettingsFile(username), JSON.stringify(settings, null, 2), 'utf-8');
}

export function clearSettingsCache(username: string): void {
  cache.delete(username);
}
