// TRA-2513 — `DELETE /api/account` left the saved BROKER CREDENTIALS behind.
//
// ⚠️ THE POINT OF THIS FILE is the first test in it. `account-deletion.test.ts` is
// thorough about the primary tree, every backup generation, the tombstone and the
// delete ORDER — and every assertion in it PASSES against the code this file
// exists to fix, because `account_settings` is a SQLite row (TRA-1052) and a
// directory delete cannot reach a database row. The route returned `ok: true`,
// the files really were gone, and `liveApiKeyStocks` was still servable.
//
// This is the DESTROY half of the defect TRA-2520 fixed on the ADOPTION half
// (`orphaned-books.ts`). Neither covers the other and the difference is not
// cosmetic:
//
//  • `retireOrphanedBook` only ever fires at SIGNUP, so it cannot help a user who
//    deletes their account and whose name is never reused — which is most of them.
//  • It ARCHIVES the row before dropping it (TRA-142 restore intent). Here the user
//    ASKED for destruction, so there must be NO archive anywhere. `AC2` below is
//    the test that would catch someone "fixing" this by copy-pasting the retirement.
//
// Three rules this file is built around, all inherited from
// `orphaned-books-settings-row.test.ts` because they were learned the hard way:
//
//  • A TEST OF AN ABSENCE NEEDS A VERIFIED POSITIVE MARK FIRST. "no credentials
//    after the wipe" is vacuous if they never persisted, and a working delete and a
//    DELETED one then emit identical output. Every test here first asserts the
//    dirty predecessor reads back through the same `loadSettings` the route uses,
//    with the cache dropped so the read genuinely hits the store.
//  • THE HARNESS MUST FAIL, NOT SKIP. `better-sqlite3` is fail-soft by design
//    (TRA-1681): a missing native module makes `getStateDb()` return null and every
//    assertion below trivially true. `beforeAll` asserts the db OPENED.
//  • THE IN-MEMORY MAP IS A THIRD COPY. `getSettings` serves `cache` directly
//    without touching the store, so a wipe that drops the row and leaves the map
//    still hands the blob to the next reader in the same process.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AccountSettings } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

type AccountSettingsModule = typeof import('./account-settings.js');
type AccountDeletion = typeof import('./account-deletion.js');
type DeletedAccounts = typeof import('./deleted-accounts.js');
type Sqlite = typeof import('./sqlite.js');

let DATA_DIR: string;
let settingsMod: AccountSettingsModule;
let accountDeletion: AccountDeletion;
let deletedAccounts: DeletedAccounts;
let sqlite: Sqlite;

/** Obviously-fake values, the same shape the live probes used. Never real secrets. */
const SENTINEL_KEY = 'FAKE-KEY-tra2513-do-not-use';
const SENTINEL_SECRET = 'FAKE-SECRET-tra2513-do-not-use';
const SENTINEL_ACCT = 'FAKE-ACCT-tra2513';

const T0 = Date.parse('2026-07-29T10:00:00.000Z');

const userDir = (u: string) => join(DATA_DIR, 'users', u);

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), 'tra2513-'));
  process.env['DATA_DIR'] = DATA_DIR;
  sqlite = await import('./sqlite.js');
  settingsMod = await import('./account-settings.js');
  accountDeletion = await import('./account-deletion.js');
  deletedAccounts = await import('./deleted-accounts.js');
  // `wipeAccountData` also revokes reset tokens and 2FA state; an uninitialised
  // store would land in `receipt.errors` and turn every `ok: true` assertion below
  // into a red about the wrong thing.
  (await import('./auth.js')).initResetTokenStore(DATA_DIR);
  (await import('./two-factor.js')).initTwoFactorStore(DATA_DIR);

  // HARNESS FAULT, NEVER A GREEN — see the header.
  const db = sqlite.__setStateDbForTests(DATA_DIR);
  expect(
    db,
    'better-sqlite3 did not open — every settings assertion in this file would be vacuous',
  ).not.toBeNull();
  expect(sqlite.getStateDbStatus().available).toBe(true);
});

afterAll(() => {
  sqlite.__setStateDbForTests(null);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  deletedAccounts.clearTombstoneCache();
});

/**
 * The departing user's settings: three credential PAIRS across all three markets
 * plus two plain-state fields, so a fix that only covered the stocks pair
 * (the one TRA-2511 happened to measure) still fails.
 */
function departingSettings(): AccountSettings {
  return {
    ...DEFAULT_ACCOUNT_SETTINGS,
    demoEquity: 31337,
    demoEquityStocks: 31337,
    dailyTradesLimit: 7,
    liveApiKeyStocks: SENTINEL_KEY,
    liveAccountIdStocks: SENTINEL_ACCT,
    liveApiKeyCrypto: SENTINEL_KEY,
    liveApiSecretCrypto: SENTINEL_SECRET,
    liveApiKeyOptionsSandbox: SENTINEL_KEY,
    liveAccountIdOptionsSandbox: SENTINEL_ACCT,
  };
}

/**
 * Persist the row AND assert it is servable — the positive mark. Reads through
 * `loadSettings` with the cache dropped, so the value provably came from the store
 * rather than from the map `saveSettings` just populated.
 */
async function seedDeparting(username: string): Promise<void> {
  await settingsMod.saveSettings(username, departingSettings());
  settingsMod.clearSettingsCache(username);
  const readBack = await settingsMod.loadSettings(username);
  expect(readBack.liveApiKeyStocks, 'FINGERPRINT DID NOT APPLY — row not servable').toBe(SENTINEL_KEY);
  expect(readBack.liveApiSecretCrypto).toBe(SENTINEL_SECRET);
  expect(readBack.demoEquity).toBe(31337);
  settingsMod.clearSettingsCache(username);
}

/** A book on disk, so the tree channel is exercised alongside the row. */
function plantBook(username: string): void {
  mkdirSync(userDir(username), { recursive: true });
  writeFileSync(join(userDir(username), 'trades-stocks.json'), JSON.stringify({ version: 1 }), 'utf-8');
  writeFileSync(join(userDir(username), 'watchlist.json'), JSON.stringify({ symbols: ['ZVZZT'] }), 'utf-8');
}

describe('TRA-2513 — the account_settings row survives a self-delete', () => {
  it('MUTATION CONTROL: a file-only wipe reports a clean delete and keeps the broker keys', async () => {
    // This is the code as it shipped in TRA-2421, and the state the live Arm 1 probe
    // measured on bqb1. Every assertion in `account-deletion.test.ts` passes here —
    // which is exactly why this reached production.
    const user = 'tra2513-naive';
    await seedDeparting(user);
    plantBook(user);

    rmSync(userDir(user), { recursive: true, force: true });
    expect(existsSync(userDir(user))).toBe(false); // ← reads EXACTLY like a clean wipe

    // ...and the credentials are still there, in cleartext, on the next read.
    const after = await settingsMod.loadSettings(user);
    expect(after.liveApiKeyStocks).toBe(SENTINEL_KEY);
    expect(after.liveApiSecretCrypto).toBe(SENTINEL_SECRET);
    expect(after.liveApiKeyOptionsSandbox).toBe(SENTINEL_KEY);
    expect(after.demoEquity).toBe(31337);
    settingsMod.clearSettingsCache(user);
  });

  it('AC1: the wipe drops the row — a later read of the same name gets DEFAULTS', async () => {
    const user = 'tra2513-wiped';
    await seedDeparting(user);
    plantBook(user);

    const receipt = await accountDeletion.wipeAccountData(user, { now: T0, via: 'self' });

    expect(receipt.settingsRowExisted).toBe(true);
    expect(receipt.settingsRowRemoved).toBe(true);
    // Six credential fields held a value; the COUNT is what reaches the wire.
    expect(receipt.settingsCredentialFieldsCleared).toBe(6);
    expect(receipt.errors).toEqual([]);
    expect(receipt.ok).toBe(true);

    // TWO CHANNELS, because they can disagree: a fix that blanked the credential
    // fields but left the row would pass the credential checks and fail the state ones.
    const after = await settingsMod.loadSettings(user);
    expect(after.liveApiKeyStocks ?? '').toBe('');
    expect(after.liveAccountIdStocks ?? '').toBe('');
    expect(after.liveApiKeyCrypto ?? '').toBe('');
    expect(after.liveApiSecretCrypto ?? '').toBe('');
    expect(after.liveApiKeyOptionsSandbox ?? '').toBe('');
    expect(after.liveAccountIdOptionsSandbox ?? '').toBe('');
    expect(after.demoEquity).toBe(DEFAULT_ACCOUNT_SETTINGS.demoEquity);
    expect(after.dailyTradesLimit).toBe(DEFAULT_ACCOUNT_SETTINGS.dailyTradesLimit);
    settingsMod.clearSettingsCache(user);
  });

  it('AC2: DESTROYS the row — no archive copy is written anywhere under DATA_DIR', async () => {
    // The failure mode this pins is a well-meaning copy-paste of TRA-2520's
    // `retireOrphanedBook`, which archives the blob into `orphaned-books/` before
    // dropping it. That is right for a RETIREMENT and wrong here: the user asked
    // for destruction, and an archive re-creates the leak somewhere the wipe does
    // not look. Note AC1 would still be GREEN against that mistake.
    const user = 'tra2513-no-archive';
    await seedDeparting(user);
    plantBook(user);

    await accountDeletion.wipeAccountData(user, { now: T0, via: 'self' });

    expect(existsSync(join(DATA_DIR, 'orphaned-books', `${user}@${new Date(T0).toISOString().replace(/[:.]/g, '-')}`))).toBe(false);
    // Broader than the one path we happened to think of: nothing named for this
    // user may exist under DATA_DIR at all, at any of the roots a copy could land in.
    for (const root of ['orphaned-books', 'users', 'backups']) {
      const dir = join(DATA_DIR, root);
      if (!existsSync(dir)) continue;
      expect(readdirSync(dir).filter((n) => n.startsWith(user))).toEqual([]);
    }
    settingsMod.clearSettingsCache(user);
  });

  it('drops the IN-MEMORY copy too — `getSettings` cannot serve it back', async () => {
    // `getSettings` reads the `cache` map directly and never touches the store, so a
    // wipe that only ran the DELETE leaves the whole blob live for the rest of the
    // process. AC1 reads through `loadSettings`, which repopulates from the store,
    // and would not see this.
    const user = 'tra2513-cache';
    await seedDeparting(user);
    // Warm the map the way a real session does, and prove it is warm.
    await settingsMod.loadSettings(user);
    expect(settingsMod.getSettings(user).liveApiKeyStocks).toBe(SENTINEL_KEY);

    await accountDeletion.wipeAccountData(user, { now: T0, via: 'self' });

    expect(settingsMod.getSettings(user).liveApiKeyStocks ?? '').toBe('');
    expect(settingsMod.getSettings(user).demoEquity).toBe(DEFAULT_ACCOUNT_SETTINGS.demoEquity);
  });

  it('NEGATIVE CONTROL: a bystander keeps their own row', async () => {
    // A delete that reached across usernames — a `DELETE FROM account_settings`
    // with a bad predicate, say — would pass every assertion above it.
    const user = 'tra2513-victim';
    const bystander = 'tra2513-bystander';
    await seedDeparting(user);
    await seedDeparting(bystander);

    await accountDeletion.wipeAccountData(user, { now: T0, via: 'self' });

    const other = await settingsMod.loadSettings(bystander);
    expect(other.liveApiKeyStocks).toBe(SENTINEL_KEY);
    expect(other.liveApiSecretCrypto).toBe(SENTINEL_SECRET);
    expect(other.demoEquity).toBe(31337);
    settingsMod.clearSettingsCache(bystander);
  });

  it('a never-used name wipes cleanly and reports the row as absent', async () => {
    // `settingsRowExisted: false` with `ok: true` is the honest shape for an
    // account that never saved settings. It must NOT read as a failure — this is
    // the common case, and a wipe that 500s on it is worse than the leak.
    const receipt = await accountDeletion.wipeAccountData('tra2513-never-saved', { now: T0, via: 'self' });
    expect(receipt.settingsRowExisted).toBe(false);
    expect(receipt.settingsCredentialFieldsCleared).toBe(0);
    expect(receipt.settingsRowRemoved).toBe(true);
    expect(receipt.errors).toEqual([]);
    expect(receipt.ok).toBe(true);
  });

  it('is idempotent — a second wipe of the same name is a clean no-op', async () => {
    const user = 'tra2513-twice';
    await seedDeparting(user);
    plantBook(user);

    const first = await accountDeletion.wipeAccountData(user, { now: T0, via: 'self' });
    expect(first.settingsRowExisted).toBe(true);
    expect(first.ok).toBe(true);

    const second = await accountDeletion.wipeAccountData(user, { now: T0 + 60_000, via: 'self' });
    expect(second.settingsRowExisted).toBe(false);
    expect(second.settingsRowRemoved).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("a NEW holder of the name can save and read their own settings afterwards", async () => {
    // Without this, "the row is gone" could be delivered by a store that stopped
    // accepting writes for that username at all — a fix that breaks the account it
    // was meant to protect while passing every assertion above.
    const user = 'tra2513-recycled';
    await seedDeparting(user);
    await accountDeletion.wipeAccountData(user, { now: T0, via: 'self' });

    await settingsMod.saveSettings(user, { ...DEFAULT_ACCOUNT_SETTINGS, demoEquity: 12345 });
    settingsMod.clearSettingsCache(user);
    const fresh = await settingsMod.loadSettings(user);
    expect(fresh.demoEquity).toBe(12345);
    expect(fresh.liveApiKeyStocks ?? '').toBe('');
    settingsMod.clearSettingsCache(user);
  });

  // ⚠️ LAST IN THE FILE ON PURPOSE — it breaks the shared table and repairs it in
  // `finally`. Anything ordered after it would run against a half-poisoned store.
  it('FAILS CLOSED: an unreadable store makes the wipe residue, not a green', async () => {
    // The asymmetry against `retireOrphanedBook` (TRA-2520), which fail-SOFTs the
    // same probe. There, a db fault must not 503 an innocent signup. Here the user
    // asked for their broker credentials to be destroyed, and "I could not check"
    // must not come back as "removed". If `ok` ignored this channel, the route
    // would answer 200 while the row sat untouched — the original bug with a new
    // field nobody gates on.
    const user = 'tra2513-db-down';
    await seedDeparting(user);
    plantBook(user);

    const db = sqlite.getStateDb();
    expect(db, 'no db handle — this test would assert nothing').not.toBeNull();
    try {
      // `settingsDb()` caches "table ready" in a WeakSet, so it will NOT re-create
      // this and every settings statement now throws `no such table`.
      db!.exec('DROP TABLE account_settings');

      const receipt = await accountDeletion.wipeAccountData(user, { now: T0, via: 'self' });

      expect(receipt.primaryDirRemoved).toBe(true); // the file half still worked...
      expect(receipt.settingsRowRemoved).toBe(false); // ...and the row half is unproven
      expect(receipt.ok).toBe(false); // ⇒ the route reports residue
      expect(receipt.errors.some((e) => e.startsWith('settings-'))).toBe(true);
    } finally {
      db!.exec(
        'CREATE TABLE IF NOT EXISTS account_settings (username TEXT PRIMARY KEY, settings_json TEXT NOT NULL)',
      );
    }
  });
});
