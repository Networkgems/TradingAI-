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
// TRA-229 — pre-split installs stored a single auto-trading flag per market
// (`stocksAutoTradingEnabled`, `cryptoAutoTradingEnabled`) that applied to both
// demo and live. After the per-mode split each market has independent demo/live
// flags. Copy the legacy value into BOTH new fields once so users keep their
// previous on/off state, then clear the legacy field.
export function migrateLegacyAutoTradingFlags(input: AccountSettings): {
  settings: AccountSettings;
  migrated: boolean;
} {
  const hasLegacyStocks = typeof input.stocksAutoTradingEnabled === 'boolean';
  const hasLegacyCrypto = typeof input.cryptoAutoTradingEnabled === 'boolean';
  if (!hasLegacyStocks && !hasLegacyCrypto) return { settings: input, migrated: false };

  const next: AccountSettings = { ...input };
  if (hasLegacyStocks) {
    const v = input.stocksAutoTradingEnabled ?? true;
    if (typeof next.stocksAutoTradingEnabledDemo !== 'boolean') next.stocksAutoTradingEnabledDemo = v;
    if (typeof next.stocksAutoTradingEnabledLive !== 'boolean') next.stocksAutoTradingEnabledLive = v;
    delete next.stocksAutoTradingEnabled;
  }
  if (hasLegacyCrypto) {
    const v = input.cryptoAutoTradingEnabled ?? true;
    if (typeof next.cryptoAutoTradingEnabledDemo !== 'boolean') next.cryptoAutoTradingEnabledDemo = v;
    if (typeof next.cryptoAutoTradingEnabledLive !== 'boolean') next.cryptoAutoTradingEnabledLive = v;
    delete next.cryptoAutoTradingEnabled;
  }
  return { settings: next, migrated: true };
}

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
    const credsResult = migrateLegacyLiveCredentials(merged);
    const flagsResult = migrateLegacyAutoTradingFlags(credsResult.settings);
    const settings = flagsResult.settings;
    const migrated = credsResult.migrated || flagsResult.migrated;
    if (migrated) {
      try {
        await persistMigrated(username, settings);
        if (credsResult.migrated) console.log(`[migration TRA-165] cleared legacy live creds for ${username}`);
        if (flagsResult.migrated) console.log(`[migration TRA-229] split auto-trading flags by mode for ${username}`);
      } catch (err: unknown) {
        console.warn(
          `[migration] failed to persist migrated settings for ${username}: ${
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

/**
 * TRA-346 — clamp the Managed Account Ratio for one of the four scoped
 * (mode × dashboard) buckets. The route handler invokes this once per bucket
 * with the request body's value and the saved snapshot's value.
 *
 * `undefined` is preserved (instead of being coerced to a default) so the
 * resolver's legacy-fallback chain — `scoped ?? s.managedAccountRatio` —
 * keeps working for users who saved before the four-bucket split. Pinning an
 * untouched bucket to `0.5` the moment any other setting is saved would
 * silently disable the fallback and "split" sizing for users who never edited
 * the per-mode knob.
 */
export function clampScopedRatio(incoming?: number, saved?: number): number | undefined {
  const raw = incoming ?? saved;
  if (raw === undefined || raw === null || Number.isNaN(Number(raw))) return saved;
  return Math.max(0.01, Math.min(1, Number(raw)));
}

/**
 * TRA-346 — paired clamp for Risk Per Trade. See {@link clampScopedRatio} for
 * the `undefined` preservation rationale. Bounds match the spec
 * (`risk ∈ [0.001, 0.5]`) and mirror the legacy `riskPerTrade` route clamp.
 */
export function clampScopedRisk(incoming?: number, saved?: number): number | undefined {
  const raw = incoming ?? saved;
  if (raw === undefined || raw === null || Number.isNaN(Number(raw))) return saved;
  return Math.max(0.001, Math.min(0.5, Number(raw)));
}

/**
 * TRA-346 — return a partial AccountSettings holding only the eight scoped
 * Managed Account Ratio + Risk Per Trade fields, each clamped against the
 * matching bucket from `body` (request) falling back to `current` (saved).
 *
 * Extracted so the unit tests can lock in the four-bucket isolation contract
 * without spinning up the full Express route. Each bucket is clamped
 * independently — touching `managedAccountRatioDemoCrypto` must NOT pin the
 * other seven scoped fields to anything, otherwise the resolver's legacy
 * fallback breaks for users who saved before TRA-346.
 */
export function mergeScopedRiskSettings(
  current: AccountSettings,
  body: Partial<AccountSettings>,
): Pick<
  AccountSettings,
  | 'managedAccountRatioDemoStocks'
  | 'managedAccountRatioLiveStocks'
  | 'managedAccountRatioDemoCrypto'
  | 'managedAccountRatioLiveCrypto'
  | 'riskPerTradeDemoStocks'
  | 'riskPerTradeLiveStocks'
  | 'riskPerTradeDemoCrypto'
  | 'riskPerTradeLiveCrypto'
> {
  return {
    managedAccountRatioDemoStocks: clampScopedRatio(body.managedAccountRatioDemoStocks, current.managedAccountRatioDemoStocks),
    managedAccountRatioLiveStocks: clampScopedRatio(body.managedAccountRatioLiveStocks, current.managedAccountRatioLiveStocks),
    managedAccountRatioDemoCrypto: clampScopedRatio(body.managedAccountRatioDemoCrypto, current.managedAccountRatioDemoCrypto),
    managedAccountRatioLiveCrypto: clampScopedRatio(body.managedAccountRatioLiveCrypto, current.managedAccountRatioLiveCrypto),
    riskPerTradeDemoStocks: clampScopedRisk(body.riskPerTradeDemoStocks, current.riskPerTradeDemoStocks),
    riskPerTradeLiveStocks: clampScopedRisk(body.riskPerTradeLiveStocks, current.riskPerTradeLiveStocks),
    riskPerTradeDemoCrypto: clampScopedRisk(body.riskPerTradeDemoCrypto, current.riskPerTradeDemoCrypto),
    riskPerTradeLiveCrypto: clampScopedRisk(body.riskPerTradeLiveCrypto, current.riskPerTradeLiveCrypto),
  };
}
