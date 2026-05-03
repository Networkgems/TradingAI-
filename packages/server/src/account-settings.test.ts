import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AccountSettings } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

// account-settings.ts captures DATA_DIR at module-evaluation time, so set
// process.env.DATA_DIR BEFORE importing it (same pattern as trade-store.test.ts).
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'account-settings-test-'));
process.env.DATA_DIR = TMP_ROOT;

type AccountSettingsModule = typeof import('./account-settings.js');
let loadSettings: AccountSettingsModule['loadSettings'];
let saveSettings: AccountSettingsModule['saveSettings'];
let clearSettingsCache: AccountSettingsModule['clearSettingsCache'];
let migrateLegacyLiveCredentials: AccountSettingsModule['migrateLegacyLiveCredentials'];

beforeAll(async () => {
  const mod = await import('./account-settings.js');
  loadSettings = mod.loadSettings;
  saveSettings = mod.saveSettings;
  clearSettingsCache = mod.clearSettingsCache;
  migrateLegacyLiveCredentials = mod.migrateLegacyLiveCredentials;
});

beforeEach(() => {
  rmSync(join(TMP_ROOT, 'users'), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const USER = 'reporter';

function writeUserSettingsFile(partial: Partial<AccountSettings>): string {
  const dir = join(TMP_ROOT, 'users', USER);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'account-settings.json');
  writeFileSync(file, JSON.stringify(partial, null, 2), 'utf-8');
  return file;
}

describe('migrateLegacyLiveCredentials (TRA-165)', () => {
  it('routes a Coinbase-flavored legacy install into the crypto-scoped fields', () => {
    const before: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveBrokerageType: 'coinbase',
      liveApiKey: 'coinbase-key',
      liveApiSecret: 'coinbase-secret',
      liveAccountId: '',
      liveApiKeyCrypto: '',
      liveApiSecretCrypto: '',
      liveApiKeyStocks: '',
      liveAccountIdStocks: '',
    };
    const { settings, migrated } = migrateLegacyLiveCredentials(before);
    expect(migrated).toBe(true);
    expect(settings.liveApiKeyCrypto).toBe('coinbase-key');
    expect(settings.liveApiSecretCrypto).toBe('coinbase-secret');
    // Legacy fields cleared so the form's `scoped ?? legacy` chain cannot leak
    // into the Stocks tab anymore.
    expect(settings.liveApiKey).toBe('');
    expect(settings.liveApiSecret).toBe('');
    expect(settings.liveAccountId).toBe('');
    expect(settings.liveApiKeyStocks ?? '').toBe('');
    expect(settings.liveAccountIdStocks ?? '').toBe('');
  });

  it('routes a Webull-flavored legacy install into the stocks-scoped fields', () => {
    const before: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveBrokerageType: 'webull',
      liveApiKey: 'webull-key',
      liveApiSecret: '',
      liveAccountId: 'WB-123',
      liveApiKeyCrypto: '',
      liveApiSecretCrypto: '',
      liveApiKeyStocks: '',
      liveAccountIdStocks: '',
    };
    const { settings, migrated } = migrateLegacyLiveCredentials(before);
    expect(migrated).toBe(true);
    expect(settings.liveApiKeyStocks).toBe('webull-key');
    expect(settings.liveAccountIdStocks).toBe('WB-123');
    expect(settings.liveApiKey).toBe('');
    expect(settings.liveAccountId).toBe('');
    expect(settings.liveApiKeyCrypto ?? '').toBe('');
  });

  it('does not overwrite a scoped value the user has already saved', () => {
    const before: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveBrokerageType: 'coinbase',
      liveApiKey: 'old-coinbase-key',
      liveApiSecret: 'old-coinbase-secret',
      liveApiKeyCrypto: 'new-coinbase-key',
      liveApiSecretCrypto: 'new-coinbase-secret',
    };
    const { settings, migrated } = migrateLegacyLiveCredentials(before);
    expect(migrated).toBe(true);
    expect(settings.liveApiKeyCrypto).toBe('new-coinbase-key');
    expect(settings.liveApiSecretCrypto).toBe('new-coinbase-secret');
    expect(settings.liveApiKey).toBe('');
    expect(settings.liveApiSecret).toBe('');
  });

  it('is a no-op when there are no legacy values', () => {
    const before: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveApiKey: '',
      liveApiSecret: '',
      liveAccountId: '',
      liveApiKeyCrypto: 'already-scoped',
    };
    const { settings, migrated } = migrateLegacyLiveCredentials(before);
    expect(migrated).toBe(false);
    expect(settings).toBe(before);
  });
});

describe('loadSettings persistence (TRA-165)', () => {
  it('persists the migration to disk so the next read is already clean', async () => {
    const file = writeUserSettingsFile({
      mode: 'live',
      liveBrokerageType: 'coinbase',
      liveApiKey: 'coinbase-key',
      liveApiSecret: 'coinbase-secret',
    });
    clearSettingsCache(USER);

    const first = await loadSettings(USER);
    expect(first.liveApiKeyCrypto).toBe('coinbase-key');
    expect(first.liveApiSecretCrypto).toBe('coinbase-secret');
    expect(first.liveApiKey).toBe('');
    // Stocks tab fallback chain `scoped ?? legacy` now resolves to '', not the
    // Coinbase key — this is the original TRA-165 reporter's symptom.
    expect((first.liveApiKeyStocks ?? '') || (first.liveApiKey ?? '')).toBe('');

    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as AccountSettings;
    expect(onDisk.liveApiKey).toBe('');
    expect(onDisk.liveApiSecret).toBe('');
    expect(onDisk.liveApiKeyCrypto).toBe('coinbase-key');

    clearSettingsCache(USER);
    const second = await loadSettings(USER);
    expect(second.liveApiKey).toBe('');
    expect(second.liveApiKeyCrypto).toBe('coinbase-key');
  });
});

describe('liveTradeRoutingCrypto / liveMaxLeverageCrypto round-trip (TRA-249-E)', () => {
  it('persists hybrid routing + leverage cap and re-reads them on next load', async () => {
    const stored: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveTradeRoutingCrypto: 'hybrid',
      liveMaxLeverageCrypto: 3,
    };
    await saveSettings(USER, stored);
    clearSettingsCache(USER);
    const reloaded = await loadSettings(USER);
    expect(reloaded.liveTradeRoutingCrypto).toBe('hybrid');
    expect(reloaded.liveMaxLeverageCrypto).toBe(3);
  });

  it('round-trips perp_only and spot_only without dropping the value', async () => {
    for (const routing of ['perp_only', 'spot_only'] as const) {
      const stored: AccountSettings = {
        ...DEFAULT_ACCOUNT_SETTINGS,
        liveTradeRoutingCrypto: routing,
        liveMaxLeverageCrypto: 1,
      };
      await saveSettings(USER, stored);
      clearSettingsCache(USER);
      const reloaded = await loadSettings(USER);
      expect(reloaded.liveTradeRoutingCrypto).toBe(routing);
    }
  });

  it('falls back to hybrid + 1× when the saved file pre-dates TRA-249-E', async () => {
    // Pre-E payload — neither field present on disk. The DEFAULT_ACCOUNT_SETTINGS
    // merge in `loadSettings` should inject the defaults so `useSettings` reads
    // sane values without forcing a server-side migration.
    writeUserSettingsFile({ mode: 'live' });
    clearSettingsCache(USER);
    const reloaded = await loadSettings(USER);
    expect(reloaded.liveTradeRoutingCrypto).toBe('hybrid');
    expect(reloaded.liveMaxLeverageCrypto).toBe(1);
  });
});
