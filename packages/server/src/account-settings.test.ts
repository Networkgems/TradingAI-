import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AccountSettings } from '@trading-app/shared';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  validateLiveCredentials,
  validateProductionTradierKeys,
} from '@trading-app/shared';

// account-settings.ts captures DATA_DIR at module-evaluation time, so set
// process.env.DATA_DIR BEFORE importing it (same pattern as trade-store.test.ts).
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'account-settings-test-'));
process.env.DATA_DIR = TMP_ROOT;

type AccountSettingsModule = typeof import('./account-settings.js');
let loadSettings: AccountSettingsModule['loadSettings'];
let saveSettings: AccountSettingsModule['saveSettings'];
let clearSettingsCache: AccountSettingsModule['clearSettingsCache'];
let migrateLegacyLiveCredentials: AccountSettingsModule['migrateLegacyLiveCredentials'];
// TRA-349 — also bound through the same dynamic import so the helpers we test
// belong to the same module instance whose DATA_DIR was captured against
// TMP_ROOT. A static `import { ... } from './account-settings.js'` at the top
// would force the module to load BEFORE `process.env.DATA_DIR = TMP_ROOT`,
// and then loadSettings/saveSettings would silently target the real
// `packages/server/data` directory.
let clampScopedRatio: AccountSettingsModule['clampScopedRatio'];
let clampScopedRisk: AccountSettingsModule['clampScopedRisk'];
let mergeScopedRiskSettings: AccountSettingsModule['mergeScopedRiskSettings'];

beforeAll(async () => {
  const mod = await import('./account-settings.js');
  loadSettings = mod.loadSettings;
  saveSettings = mod.saveSettings;
  clearSettingsCache = mod.clearSettingsCache;
  migrateLegacyLiveCredentials = mod.migrateLegacyLiveCredentials;
  clampScopedRatio = mod.clampScopedRatio;
  clampScopedRisk = mod.clampScopedRisk;
  mergeScopedRiskSettings = mod.mergeScopedRiskSettings;
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

// TRA-349 — regression-lock the four-bucket clamp + merge contract that
// PUT /api/account/settings runs (extracted into `mergeScopedRiskSettings`
// so the route handler stays a thin spread on top of the helper).
//
// These tests fail if the route is ever rewired to fall back to the legacy
// un-suffixed field, to clamp the wrong bucket, or to pin untouched buckets
// to a non-undefined default — any of which would silently re-introduce the
// Demo↔Live (or Stocks↔Crypto) sizing leak that TRA-346 fixed.
describe('clampScopedRatio / clampScopedRisk bounds (TRA-346 / TRA-349)', () => {
  it('clamps managedAccountRatio to [0.01, 1]', () => {
    expect(clampScopedRatio(0)).toBe(0.01);
    expect(clampScopedRatio(-2)).toBe(0.01);
    expect(clampScopedRatio(0.005)).toBe(0.01);
    expect(clampScopedRatio(0.5)).toBe(0.5);
    expect(clampScopedRatio(1)).toBe(1);
    expect(clampScopedRatio(2)).toBe(1);
    expect(clampScopedRatio(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('clamps riskPerTrade to [0.001, 0.5]', () => {
    expect(clampScopedRisk(0)).toBe(0.001);
    expect(clampScopedRisk(-1)).toBe(0.001);
    expect(clampScopedRisk(0.0005)).toBe(0.001);
    expect(clampScopedRisk(0.01)).toBe(0.01);
    expect(clampScopedRisk(0.5)).toBe(0.5);
    expect(clampScopedRisk(0.9)).toBe(0.5);
    expect(clampScopedRisk(Number.POSITIVE_INFINITY)).toBe(0.5);
  });

  it('preserves undefined when neither incoming nor saved holds a value', () => {
    // Headline TRA-346 invariant: an untouched bucket must stay `undefined`
    // so `resolveManagedAccountRatio` / `resolveRiskPerTrade` keep falling
    // back to the legacy un-suffixed field. Coercing to a default here would
    // silently break sizing for users who saved before the four-bucket split.
    expect(clampScopedRatio(undefined, undefined)).toBeUndefined();
    expect(clampScopedRisk(undefined, undefined)).toBeUndefined();
  });

  it('falls back to the saved value when incoming is undefined', () => {
    // The route passes the body's value first, the saved snapshot's value
    // second. A no-op save (body omits this bucket) must re-clamp the saved
    // value rather than dropping it back to undefined.
    expect(clampScopedRatio(undefined, 0.42)).toBe(0.42);
    expect(clampScopedRisk(undefined, 0.04)).toBe(0.04);
  });

  it('treats NaN as "no value" so a malformed save never poisons a saved bucket', () => {
    expect(clampScopedRatio(Number.NaN, 0.42)).toBe(0.42);
    expect(clampScopedRisk(Number.NaN, 0.04)).toBe(0.04);
    expect(clampScopedRatio(Number.NaN, undefined)).toBeUndefined();
  });
});

describe('mergeScopedRiskSettings — bucket isolation (TRA-346 / TRA-349)', () => {
  it('saving only managedAccountRatioDemoCrypto leaves the other 7 scoped fields undefined', () => {
    // Models a fresh user with no saved scoped buckets. The PUT body sets
    // exactly one bucket; the helper must not pin the other seven to a
    // default — that would silently disable the legacy fallback chain for
    // every other (mode × market) combo.
    const merged = mergeScopedRiskSettings(
      { ...DEFAULT_ACCOUNT_SETTINGS },
      { managedAccountRatioDemoCrypto: 0.7 },
    );
    expect(merged.managedAccountRatioDemoCrypto).toBe(0.7);
    expect(merged.managedAccountRatioDemoStocks).toBeUndefined();
    expect(merged.managedAccountRatioLiveStocks).toBeUndefined();
    expect(merged.managedAccountRatioLiveCrypto).toBeUndefined();
    expect(merged.riskPerTradeDemoStocks).toBeUndefined();
    expect(merged.riskPerTradeLiveStocks).toBeUndefined();
    expect(merged.riskPerTradeDemoCrypto).toBeUndefined();
    expect(merged.riskPerTradeLiveCrypto).toBeUndefined();
  });

  it('does not touch the legacy managedAccountRatio / riskPerTrade fields', () => {
    // The merge helper owns the eight scoped fields only. Routes still clamp
    // the legacy un-suffixed fields separately (so `Number.NaN` body input
    // doesn't poison the snapshot); this test guards that the helper doesn't
    // accidentally start emitting them.
    const merged = mergeScopedRiskSettings(
      { ...DEFAULT_ACCOUNT_SETTINGS, managedAccountRatio: 0.5, riskPerTrade: 0.01 },
      { managedAccountRatioDemoCrypto: 0.7 },
    );
    expect(merged).not.toHaveProperty('managedAccountRatio');
    expect(merged).not.toHaveProperty('riskPerTrade');
  });

  it('clamps each scoped bucket to its spec bounds independently', () => {
    // Out-of-range values for every scoped field at once: every ratio bucket
    // > 1 and every risk bucket > 0.5 must be clamped back to the spec max.
    const merged = mergeScopedRiskSettings(
      { ...DEFAULT_ACCOUNT_SETTINGS },
      {
        managedAccountRatioDemoStocks: 5,
        managedAccountRatioLiveStocks: 5,
        managedAccountRatioDemoCrypto: 5,
        managedAccountRatioLiveCrypto: 5,
        riskPerTradeDemoStocks: 5,
        riskPerTradeLiveStocks: 5,
        riskPerTradeDemoCrypto: 5,
        riskPerTradeLiveCrypto: 5,
      },
    );
    expect(merged.managedAccountRatioDemoStocks).toBe(1);
    expect(merged.managedAccountRatioLiveStocks).toBe(1);
    expect(merged.managedAccountRatioDemoCrypto).toBe(1);
    expect(merged.managedAccountRatioLiveCrypto).toBe(1);
    expect(merged.riskPerTradeDemoStocks).toBe(0.5);
    expect(merged.riskPerTradeLiveStocks).toBe(0.5);
    expect(merged.riskPerTradeDemoCrypto).toBe(0.5);
    expect(merged.riskPerTradeLiveCrypto).toBe(0.5);
  });

  it('preserves saved buckets that the body omits — partial saves are non-destructive', () => {
    // User has a previously saved live-crypto override; the next save touches
    // demo-stocks only. Live-crypto must still round-trip its saved value so
    // the legacy fallback chain keeps reporting the right size at order time.
    const merged = mergeScopedRiskSettings(
      {
        ...DEFAULT_ACCOUNT_SETTINGS,
        managedAccountRatioLiveCrypto: 0.9,
        riskPerTradeLiveCrypto: 0.04,
      },
      { managedAccountRatioDemoStocks: 0.2 },
    );
    expect(merged.managedAccountRatioDemoStocks).toBe(0.2);
    expect(merged.managedAccountRatioLiveCrypto).toBe(0.9);
    expect(merged.riskPerTradeLiveCrypto).toBe(0.04);
    // Buckets that have neither a body value nor a saved value stay undefined.
    expect(merged.managedAccountRatioLiveStocks).toBeUndefined();
    expect(merged.riskPerTradeDemoStocks).toBeUndefined();
  });

  it('round-trips a save that scopes all four crypto+stocks ratio buckets at once', () => {
    // End-to-end shape of a power user who's filled in every scoped field —
    // verifies each bucket lands on the bucket the resolver will read,
    // independently clamped.
    const merged = mergeScopedRiskSettings(
      { ...DEFAULT_ACCOUNT_SETTINGS },
      {
        managedAccountRatioDemoStocks: 0.10,
        managedAccountRatioLiveStocks: 0.20,
        managedAccountRatioDemoCrypto: 0.30,
        managedAccountRatioLiveCrypto: 0.40,
        riskPerTradeDemoStocks: 0.001,
        riskPerTradeLiveStocks: 0.002,
        riskPerTradeDemoCrypto: 0.005,
        riskPerTradeLiveCrypto: 0.01,
      },
    );
    expect(merged).toEqual({
      managedAccountRatioDemoStocks: 0.10,
      managedAccountRatioLiveStocks: 0.20,
      managedAccountRatioDemoCrypto: 0.30,
      managedAccountRatioLiveCrypto: 0.40,
      riskPerTradeDemoStocks: 0.001,
      riskPerTradeLiveStocks: 0.002,
      riskPerTradeDemoCrypto: 0.005,
      riskPerTradeLiveCrypto: 0.01,
    });
  });
});

// TRA-506 — guardrails so the user can't silently run "Live + Tradier
// production" with no creds. `validateLiveCredentials` gates the PUT
// /api/account/settings handler; `validateProductionTradierKeys` runs as
// an env-level invariant that fires even in demo mode. Each test pins one
// reject path so a regression breaks exactly one case rather than the
// whole bundle.
describe('validateLiveCredentials (TRA-506)', () => {
  // Build a settings snapshot that's fully credentialed for stocks +
  // options + crypto so each test can blank exactly one cred and verify
  // the reject path is wired to that one field.
  function liveFullCreds(): AccountSettings {
    return {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'live',
      liveTradierEnvOptions: 'production',
      liveApiKeyOptionsProduction: 'prod-token',
      liveAccountIdOptionsProduction: 'VA123',
      liveApiKeyCrypto: 'cb-key',
      liveApiSecretCrypto: 'cb-secret',
    };
  }

  it('happy path: live + every required cred filled returns ok=true with no missing fields', () => {
    const result = validateLiveCredentials(liveFullCreds());
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it('demo mode short-circuits even when every live cred is blank', () => {
    // The issue is "user silently runs LIVE with no creds." A demo user
    // tweaking unrelated settings (e.g. demoEquity) must not get blocked
    // because their saved-but-unused live broker fields are empty.
    const blank: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
      liveApiKeyCrypto: '',
      liveApiSecretCrypto: '',
    };
    expect(validateLiveCredentials(blank)).toEqual({ ok: true, missing: [] });
  });

  it('rejects when Tradier production API token is blank (mode=live, env=production)', () => {
    const s = { ...liveFullCreds(), liveApiKeyOptionsProduction: '' };
    const result = validateLiveCredentials(s);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('liveApiKeyOptionsProduction');
  });

  it('rejects when Tradier production Account ID is blank (mode=live, env=production)', () => {
    const s = { ...liveFullCreds(), liveAccountIdOptionsProduction: '' };
    const result = validateLiveCredentials(s);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('liveAccountIdOptionsProduction');
  });

  it('rejects when Tradier sandbox pair is blank (mode=live, env=sandbox)', () => {
    // Switching the env to sandbox flips which pair the guardrail reads. A
    // user with production creds saved but sandbox env selected and blank
    // sandbox creds still gets the same "no live broker wired up" reject.
    const s: AccountSettings = {
      ...liveFullCreds(),
      liveTradierEnvOptions: 'sandbox',
      liveApiKeyOptionsSandbox: '',
      liveAccountIdOptionsSandbox: '',
      liveApiKeyOptions: '',
      liveAccountIdOptions: '',
    };
    const result = validateLiveCredentials(s);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining(['liveApiKeyOptionsSandbox', 'liveAccountIdOptionsSandbox']),
    );
  });

  it('rejects when Coinbase API key is blank (mode=live, brokerage=coinbase)', () => {
    const s = { ...liveFullCreds(), liveApiKeyCrypto: '' };
    const result = validateLiveCredentials(s);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('liveApiKeyCrypto');
  });

  it('rejects when Coinbase API secret is blank (mode=live, brokerage=coinbase)', () => {
    const s = { ...liveFullCreds(), liveApiSecretCrypto: '' };
    const result = validateLiveCredentials(s);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('liveApiSecretCrypto');
  });

  it('whitespace-only credentials count as missing (defense against fat-finger saves)', () => {
    // A user who pastes a token with only spaces or a stray newline must
    // not slip past the guardrail — the server trims at use time, so a
    // whitespace-only save would surface as "auth failed" at order time
    // instead of upfront at save time.
    const s = {
      ...liveFullCreds(),
      liveApiKeyOptionsProduction: '   ',
      liveAccountIdOptionsProduction: '\n\t',
    };
    const result = validateLiveCredentials(s);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining(['liveApiKeyOptionsProduction', 'liveAccountIdOptionsProduction']),
    );
  });
});

describe('validateProductionTradierKeys (TRA-506)', () => {
  it('rejects production env with blank production creds even in demo mode', () => {
    // The "half-configured production" trap: user is in demo, flips env to
    // production, leaves creds empty, saves. Later flipping mode to live
    // would silently run with no broker — so the env-level guard rejects
    // the save up front, independent of mode.
    const s: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      mode: 'demo',
      liveTradierEnvOptions: 'production',
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
    };
    const result = validateProductionTradierKeys(s);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining(['liveApiKeyOptionsProduction', 'liveAccountIdOptionsProduction']),
    );
  });

  it('sandbox env short-circuits regardless of production cred state', () => {
    // Saving sandbox env must never be blocked by missing production
    // creds — that's the whole point of having two separate pairs.
    const s: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveTradierEnvOptions: 'sandbox',
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
    };
    expect(validateProductionTradierKeys(s)).toEqual({ ok: true, missing: [] });
  });

  it('production env with both production creds present returns ok=true', () => {
    const s: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveTradierEnvOptions: 'production',
      liveApiKeyOptionsProduction: 'prod-token',
      liveAccountIdOptionsProduction: 'VA123',
    };
    expect(validateProductionTradierKeys(s)).toEqual({ ok: true, missing: [] });
  });
});

// TRA-511 — pin the disk-write-before-cache-set ordering. If `writeFile`
// fails, the in-memory cache MUST NOT advance, because Test Connection reads
// from `getSettings` (the cache) and would otherwise validate against creds
// that were never persisted — the exact divergence the parent ticket
// (TRA-505) saw in the screenshot.
describe('saveSettings persistence contract (TRA-511)', () => {
  it('does not mutate the cache when the disk write fails', async () => {
    // Seed the user file + cache with a known baseline so we can detect
    // whether a subsequent failed save leaks the new payload into cache.
    const baseline: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveApiKeyOptionsProduction: 'baseline-prod-token',
      liveAccountIdOptionsProduction: 'baseline-account',
    };
    await saveSettings(USER, baseline);
    clearSettingsCache(USER);
    // Prime the cache via loadSettings so getSettings() returns the baseline.
    await loadSettings(USER);

    // Force writeFile to fail by replacing the user dir with a regular file
    // of the same name — `mkdir(..., { recursive: true })` succeeds (it
    // no-ops because the parent dir already exists from the baseline save),
    // and `writeFile` then errors with EISDIR/ENOTDIR because the target
    // path is shadowed. This mirrors the "disk write failed silently"
    // production scenario without requiring fs/promises mocking.
    const file = join(TMP_ROOT, 'users', USER, 'account-settings.json');
    rmSync(file, { force: true });
    mkdirSync(file); // turn the file path into a directory → writeFile fails

    const next: AccountSettings = {
      ...baseline,
      liveApiKeyOptionsProduction: 'new-but-doomed-token',
      liveAccountIdOptionsProduction: 'new-but-doomed-account',
    };
    await expect(saveSettings(USER, next)).rejects.toBeDefined();

    // Cache must still reflect the baseline — a Test Connection probe right
    // now must NOT see the "new-but-doomed-token" that never made it to disk.
    const cached = (await loadSettings(USER));
    expect(cached.liveApiKeyOptionsProduction).toBe('baseline-prod-token');
    expect(cached.liveAccountIdOptionsProduction).toBe('baseline-account');

    rmSync(file, { recursive: true, force: true });
  });

  it('updates BOTH cache + disk on a successful save', async () => {
    const stored: AccountSettings = {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveApiKeyOptionsProduction: 'persisted-prod-token',
      liveAccountIdOptionsProduction: 'persisted-account',
    };
    await saveSettings(USER, stored);
    // Cache: read via getSettings would go through loadSettings if cold; we
    // use loadSettings directly to assert what subsequent reads will see.
    const reloaded = await loadSettings(USER);
    expect(reloaded.liveApiKeyOptionsProduction).toBe('persisted-prod-token');
    expect(reloaded.liveAccountIdOptionsProduction).toBe('persisted-account');
    // Disk: the file on disk must match what the cache says.
    const file = join(TMP_ROOT, 'users', USER, 'account-settings.json');
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as AccountSettings;
    expect(onDisk.liveApiKeyOptionsProduction).toBe('persisted-prod-token');
    expect(onDisk.liveAccountIdOptionsProduction).toBe('persisted-account');
  });
});
