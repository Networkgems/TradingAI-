// TRA-5125 — broker credentials encrypted at rest in account_settings.settings_json.
//
// AC1  at-rest: a saved known token appears NOWHERE in the DB bytes (db + WAL).
// AC2  round-trip: the saved per-user cred still resolves for the ACCOUNT
//      endpoint class exactly as TRA-3112 ruled (saved creds work; the env
//      fallback stays operator-pinned).
// AC3  rotation/revoke: revoke clears the stored pair; the next account-verb
//      resolution is the loud refusal, never a borrowed operator client.
// AC4  migration: plaintext rows are enumerated and wrapped; idempotent;
//      previous-key ciphertexts are re-wrapped under the primary.
// Plus: an undecryptable ciphertext is served BLANK (fail closed), never raw.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AccountSettings } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'tra5125-at-rest-'));
process.env.DATA_DIR = TMP_ROOT;
// 64-hex = a direct 32-byte key: no scrypt in the hot test path.
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
process.env.SETTINGS_ENCRYPTION_KEY = KEY_A;
delete process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS;

type AccountSettingsModule = typeof import('./account-settings.js');
type SettingsCryptoModule = typeof import('./settings-crypto.js');
type SqliteModule = typeof import('./sqlite.js');
type ScopeModule = typeof import('./tradier-client-scope.js');

let acct: AccountSettingsModule;
let sc: SettingsCryptoModule;
let sqlite: SqliteModule;
let scope: ScopeModule;
let db: NonNullable<ReturnType<SqliteModule['getStateDb']>>;

const USER = 'tra5125-user';
const TOKEN = 'TRA5125-KNOWN-TEST-TOKEN-9f3e2d1c';
const ACCT_ID = 'VA5125TESTACCT';

function allDbBytes(): Buffer {
  // WAL mode: plaintext could sit in state.db, -wal or -shm. Grep them all.
  const parts: Buffer[] = [];
  for (const name of readdirSync(TMP_ROOT)) {
    if (name.startsWith('state.db')) parts.push(readFileSync(join(TMP_ROOT, name)));
  }
  expect(parts.length).toBeGreaterThan(0);
  return Buffer.concat(parts);
}

function rawRow(username: string): string {
  const row = db.prepare('SELECT settings_json FROM account_settings WHERE username = ?').get(username) as
    | { settings_json: string }
    | undefined;
  expect(row).toBeDefined();
  return (row as { settings_json: string }).settings_json;
}

beforeAll(async () => {
  acct = await import('./account-settings.js');
  sc = await import('./settings-crypto.js');
  sqlite = await import('./sqlite.js');
  scope = await import('./tradier-client-scope.js');
});

beforeEach(() => {
  process.env.SETTINGS_ENCRYPTION_KEY = KEY_A;
  delete process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS;
  sc.__resetSettingsCryptoCacheForTests();
  const handle = sqlite.__setStateDbForTests(TMP_ROOT);
  expect(handle).not.toBeNull();
  db = handle as typeof db;
  // The db FILE persists across tests (same TMP_ROOT): start each test with an
  // empty table and a cold cache so row counts enumerate only this test's rows.
  db.exec('CREATE TABLE IF NOT EXISTS account_settings (username TEXT PRIMARY KEY, settings_json TEXT NOT NULL)');
  db.exec('DELETE FROM account_settings');
  for (const u of [USER, 'bootstrap-user', 'plain-1', 'plain-2']) acct.clearSettingsCache(u);
  rmSync(join(TMP_ROOT, 'users'), { recursive: true, force: true });
});

afterAll(() => {
  sqlite.__setStateDbForTests(null);
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function withCreds(): AccountSettings {
  return {
    ...DEFAULT_ACCOUNT_SETTINGS,
    liveApiKeyOptionsProduction: TOKEN,
    liveAccountIdOptionsProduction: ACCT_ID,
  };
}

describe('AC1 — no plaintext token at rest', () => {
  it('a saved production token never appears in the DB bytes; the row holds enc:v1:gcm:', async () => {
    await acct.saveSettings(USER, withCreds());
    const bytes = allDbBytes();
    expect(bytes.includes(TOKEN)).toBe(false);
    expect(bytes.includes(ACCT_ID)).toBe(false);
    const stored = JSON.parse(rawRow(USER)) as Record<string, string>;
    expect(stored['liveApiKeyOptionsProduction']).toMatch(/^enc:v1:gcm:/);
    expect(stored['liveAccountIdOptionsProduction']).toMatch(/^enc:v1:gcm:/);
  });
});

describe('AC2 — round-trip preserves the TRA-3112 account-class contract', () => {
  it('a cache-cold load returns the plaintext, and the saved pair resolves for account verbs', async () => {
    await acct.saveSettings(USER, withCreds());
    acct.clearSettingsCache(USER);
    const loaded = await acct.loadSettings(USER);
    expect(loaded.liveApiKeyOptionsProduction).toBe(TOKEN);
    expect(loaded.liveAccountIdOptionsProduction).toBe(ACCT_ID);

    const resolved = scope.resolveTradierAccountCreds(loaded, 'production', false, {});
    expect(resolved).toEqual({ ok: true, creds: { apiToken: TOKEN, accountId: ACCT_ID } });
  });

  it('the env fallback stays operator-pinned for a non-operator with blank saved creds', async () => {
    await acct.saveSettings(USER, { ...DEFAULT_ACCOUNT_SETTINGS });
    acct.clearSettingsCache(USER);
    const loaded = await acct.loadSettings(USER);
    const resolved = scope.resolveTradierAccountCreds(loaded, 'production', false, {
      TRADIER_API_TOKEN: 'operator-token',
      TRADIER_ACCOUNT_ID: 'operator-acct',
    });
    expect(resolved).toEqual({ ok: false, reason: 'operator_pinned' });
  });
});

describe('AC3 — rotation/revoke', () => {
  it('revoke clears the stored pair; the next account-verb resolution refuses loud, never borrows', async () => {
    await acct.saveSettings(USER, withCreds());
    const { cleared } = await acct.revokeTradierCredentials(USER, 'production');
    expect(cleared.sort()).toEqual(['liveAccountIdOptionsProduction', 'liveApiKeyOptionsProduction']);

    // Token gone from the DB bytes too, not just the API view.
    expect(allDbBytes().includes(TOKEN)).toBe(false);

    acct.clearSettingsCache(USER);
    const loaded = await acct.loadSettings(USER);
    expect(loaded.liveApiKeyOptionsProduction).toBe('');

    // With shared env creds present, a non-operator gets the REFUSAL, not a client.
    const withFallback = scope.resolveTradierAccountCreds(loaded, 'production', false, {
      TRADIER_API_TOKEN: 'operator-token',
      TRADIER_ACCOUNT_ID: 'operator-acct',
    });
    expect(withFallback).toEqual({ ok: false, reason: 'operator_pinned' });
    expect(scope.decideTradierAccountRefusalResponse('operator_pinned', 'production', 'test').status).toBe(403);
    // Without anything to borrow: genuinely unconfigured, 409.
    const bare = scope.resolveTradierAccountCreds(loaded, 'production', false, {});
    expect(bare).toEqual({ ok: false, reason: 'no_creds' });
    expect(scope.decideTradierAccountRefusalResponse('no_creds', 'production', 'test').status).toBe(409);
  });

  it('sandbox revoke also clears the legacy un-suffixed pair the resolver falls back to', async () => {
    await acct.saveSettings(USER, {
      ...DEFAULT_ACCOUNT_SETTINGS,
      liveApiKeyOptionsSandbox: 'sb-token',
      liveAccountIdOptionsSandbox: 'sb-acct',
      liveApiKeyOptions: 'legacy-token',
      liveAccountIdOptions: 'legacy-acct',
    });
    const { cleared } = await acct.revokeTradierCredentials(USER, 'sandbox');
    expect(cleared.sort()).toEqual([
      'liveAccountIdOptions',
      'liveAccountIdOptionsSandbox',
      'liveApiKeyOptions',
      'liveApiKeyOptionsSandbox',
    ]);
    acct.clearSettingsCache(USER);
    const loaded = await acct.loadSettings(USER);
    expect(scope.resolveTradierAccountCreds(loaded, 'sandbox', false, {})).toEqual({ ok: false, reason: 'no_creds' });
  });
});

describe('AC4 — migration of existing plaintext rows', () => {
  function insertPlaintextRow(username: string, extra: Partial<AccountSettings> = {}): void {
    db.prepare('INSERT OR REPLACE INTO account_settings (username, settings_json) VALUES (?, ?)').run(
      username,
      JSON.stringify({ ...DEFAULT_ACCOUNT_SETTINGS, liveApiKeyOptionsProduction: TOKEN, liveAccountIdOptionsProduction: ACCT_ID, ...extra }),
    );
  }

  it('enumerates and wraps every plaintext row; second pass is a no-op', async () => {
    // Force the table to exist without touching the rows (settingsDb side effect).
    await acct.saveSettings('bootstrap-user', { ...DEFAULT_ACCOUNT_SETTINGS });
    insertPlaintextRow('plain-1');
    insertPlaintextRow('plain-2', { liveApiKeyStocks: 'stocks-token-xyz' });

    const report = acct.migrateSettingsRowsAtRest(db);
    expect(report.totalRows).toBe(3);
    expect(report.rowsMigrated).toBe(2);
    expect(report.fieldsEncrypted).toBe(5);
    expect(report.rowsFailed).toBe(0);
    expect(report.noKey).toBe(false);

    expect(allDbBytes().includes(TOKEN)).toBe(false);
    expect(allDbBytes().includes('stocks-token-xyz')).toBe(false);
    expect(JSON.parse(rawRow('plain-1'))['liveApiKeyOptionsProduction']).toMatch(/^enc:v1:gcm:/);

    // Loads still round-trip to plaintext.
    acct.clearSettingsCache('plain-2');
    const loaded = await acct.loadSettings('plain-2');
    expect(loaded.liveApiKeyOptionsProduction).toBe(TOKEN);
    expect(loaded.liveApiKeyStocks).toBe('stocks-token-xyz');

    const second = acct.migrateSettingsRowsAtRest(db);
    expect(second.rowsMigrated).toBe(0);
    expect(acct.getAtRestMigrationReport()).toEqual(second);
  });

  it('re-wraps rows readable only via SETTINGS_ENCRYPTION_KEY_PREVIOUS under the primary', async () => {
    await acct.saveSettings(USER, withCreds()); // encrypted under KEY_A

    process.env.SETTINGS_ENCRYPTION_KEY = KEY_B;
    process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS = KEY_A;
    sc.__resetSettingsCryptoCacheForTests();

    const report = acct.migrateSettingsRowsAtRest(db);
    expect(report.rowsRewrapped).toBe(1);

    // Now readable with KEY_B alone.
    process.env.SETTINGS_ENCRYPTION_KEY = KEY_B;
    delete process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS;
    sc.__resetSettingsCryptoCacheForTests();
    acct.clearSettingsCache(USER);
    const loaded = await acct.loadSettings(USER);
    expect(loaded.liveApiKeyOptionsProduction).toBe(TOKEN);
  });
});

describe('fail-closed on undecryptable ciphertext', () => {
  it('serves BLANK (never raw enc bytes, never a throw) when the key is wrong', async () => {
    await acct.saveSettings(USER, withCreds()); // under KEY_A
    process.env.SETTINGS_ENCRYPTION_KEY = KEY_B; // wrong key, no previous
    sc.__resetSettingsCryptoCacheForTests();
    acct.clearSettingsCache(USER);
    const loaded = await acct.loadSettings(USER);
    expect(loaded.liveApiKeyOptionsProduction).toBe('');
    // Downstream: loud refusal, not a borrowed client, not ciphertext-as-token.
    expect(scope.resolveTradierAccountCreds(loaded, 'production', false, {})).toEqual({
      ok: false,
      reason: 'no_creds',
    });
  });

  it('a ciphertext moved to a DIFFERENT credential field fails auth (AAD binding) and reads blank', async () => {
    await acct.saveSettings(USER, withCreds());
    const stored = JSON.parse(rawRow(USER)) as Record<string, unknown>;
    stored['liveApiKeyStocks'] = stored['liveApiKeyOptionsProduction']; // cross-field splice
    db.prepare('UPDATE account_settings SET settings_json = ? WHERE username = ?').run(JSON.stringify(stored), USER);
    acct.clearSettingsCache(USER);
    const loaded = await acct.loadSettings(USER);
    expect(loaded.liveApiKeyStocks).toBe('');
    expect(loaded.liveApiKeyOptionsProduction).toBe(TOKEN); // untouched field still fine
  });
});

describe('key sourcing', () => {
  it('derives a key from ADMIN_PASSWORD when SETTINGS_ENCRYPTION_KEY is unset', () => {
    const keys = sc.resolveSettingsCryptoKeys({ ADMIN_PASSWORD: 'hunter2' } as NodeJS.ProcessEnv);
    expect(keys).not.toBeNull();
    expect(keys?.source).toBe('derived-admin-password');
    const roundTrip = sc.decryptCredentialValue(
      sc.encryptCredentialValue('tok', (keys as NonNullable<typeof keys>).primary, 'f'),
      keys,
      'f',
    );
    expect(roundTrip).toEqual({ ok: true, value: 'tok', usedPreviousKey: false });
  });

  it('resolves null (passthrough) only when neither source exists', () => {
    expect(sc.resolveSettingsCryptoKeys({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
