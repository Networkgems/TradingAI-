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

// TRA-165 — pre-split installs stored a single set of credentials in
// `liveApiKey` / `liveApiSecret` / `liveAccountId`. After the per-market split
// the form reads `scoped ?? legacy`, which leaks (e.g.) Coinbase keys into the
// Webull form on the Stocks tab. Route the legacy values to the correct
// per-market field based on `liveBrokerageType`, then clear them so the leak
// is impossible.
export function migrateLegacyLiveCredentials(input: AccountSettings): {
  settings: AccountSettings;
  migrated: boolean;
} {
  const hasLegacy =
    (input.liveApiKey ?? '') !== '' ||
    (input.liveApiSecret ?? '') !== '' ||
    (input.liveAccountId ?? '') !== '';
  if (!hasLegacy) return { settings: input, migrated: false };

  const next: AccountSettings = { ...input };
  // `liveBrokerageType` defaults to 'webull' in DEFAULT_ACCOUNT_SETTINGS, which
  // matches what the original single-market form would have shown when the
  // field was unset, so an undefined value routes to stocks.
  const brokerage = input.liveBrokerageType ?? 'webull';
  if (brokerage === 'coinbase') {
    if (!next.liveApiKeyCrypto) next.liveApiKeyCrypto = input.liveApiKey ?? '';
    if (!next.liveApiSecretCrypto) next.liveApiSecretCrypto = input.liveApiSecret ?? '';
  } else {
    if (!next.liveApiKeyStocks) next.liveApiKeyStocks = input.liveApiKey ?? '';
    if (!next.liveAccountIdStocks) next.liveAccountIdStocks = input.liveAccountId ?? '';
  }

  next.liveApiKey = '';
  next.liveApiSecret = '';
  next.liveAccountId = '';
  return { settings: next, migrated: true };
}

async function persistMigrated(username: string, settings: AccountSettings): Promise<void> {
  const dir = dirname(userSettingsFile(username));
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(userSettingsFile(username), JSON.stringify(settings, null, 2), 'utf-8');
}

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
    const { settings, migrated } = migrateLegacyLiveCredentials(merged);
    if (migrated) {
      try {
        await persistMigrated(username, settings);
        console.log(`[migration TRA-165] cleared legacy live creds for ${username}`);
      } catch (err: unknown) {
        console.warn(
          `[migration TRA-165] failed to persist migrated settings for ${username}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    cache.set(username, settings);
    return settings;
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
