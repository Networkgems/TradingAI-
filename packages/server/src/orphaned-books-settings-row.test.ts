// TRA-2520 — `account_settings` is the FOURTH channel a recycled username inherits.
//
// ⚠️ THE POINT OF THIS FILE is the first test in it. `orphaned-books.test.ts` is
// thorough about the tree, the backup generations and the shared journal, and every
// assertion in it PASSES against the code this file exists to fix — because a
// settings row is invisible to a directory check. TRA-2511 arm 2 was the first run
// to exercise the guard against a real orphan on bqb1, and it found the successor
// reading the predecessor's saved BROKER KEYS in cleartext out of
// `GET /api/account/settings`.
//
// Two rules this file is built around, both learned the hard way:
//
//  • A TEST OF AN ABSENCE NEEDS A VERIFIED POSITIVE MARK FIRST. "the successor sees
//    no credentials" is vacuous if the predecessor's credentials never persisted, and
//    a working guard and a DELETED one then emit identical output. So every test
//    that asserts a clean successor first asserts the DIRTY predecessor reads back —
//    through the same `loadSettings` the route uses, with the cache dropped so the
//    read genuinely hits the store.
//  • THE HARNESS MUST FAIL, NOT SKIP. `better-sqlite3` is fail-soft by design
//    (TRA-1681): a missing native module makes `getStateDb()` return null and every
//    settings assertion below trivially true. `beforeAll` therefore asserts the db
//    OPENED. A red here is a broken environment, and it must look like one.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import type { AccountSettings } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

const HERE = dirname(fileURLToPath(import.meta.url));

type AccountSettingsModule = typeof import('./account-settings.js');
type OrphanedBooks = typeof import('./orphaned-books.js');
type DeletedAccounts = typeof import('./deleted-accounts.js');
type Sqlite = typeof import('./sqlite.js');

let DATA_DIR: string;
let settingsMod: AccountSettingsModule;
let orphanedBooks: OrphanedBooks;
let deletedAccounts: DeletedAccounts;
let sqlite: Sqlite;

/** An obviously-fake key, the same shape the live probe used. Never a real secret. */
const SENTINEL_KEY = 'FAKE-KEY-tra2520-do-not-use';
const SENTINEL_ACCT = 'FAKE-ACCT-tra2520';

const T0 = Date.parse('2026-07-29T09:00:00.000Z');

const userDir = (u: string) => join(DATA_DIR, 'users', u);

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), 'tra2520-'));
  process.env['DATA_DIR'] = DATA_DIR;
  sqlite = await import('./sqlite.js');
  settingsMod = await import('./account-settings.js');
  orphanedBooks = await import('./orphaned-books.js');
  deletedAccounts = await import('./deleted-accounts.js');
  // `retireOrphanedBook` also touches the reset-token and 2FA stores; an
  // uninitialised store would land in `receipt.errors` and turn every `ok: true`
  // assertion below into a red about the wrong thing.
  (await import('./auth.js')).initResetTokenStore(DATA_DIR);
  (await import('./two-factor.js')).initTwoFactorStore(DATA_DIR);

  // HARNESS FAULT, NEVER A GREEN — see the header. A null handle would make the
  // whole file assert nothing at all.
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

/** The predecessor's settings: two credential PAIRS plus two plain-state fields. */
function predecessorSettings(): AccountSettings {
  return {
    ...DEFAULT_ACCOUNT_SETTINGS,
    demoEquity: 31337,
    demoEquityStocks: 31337,
    dailyTradesLimit: 7,
    liveApiKeyStocks: SENTINEL_KEY,
    liveAccountIdStocks: SENTINEL_ACCT,
    liveApiKeyOptionsSandbox: SENTINEL_KEY,
    liveAccountIdOptionsSandbox: SENTINEL_ACCT,
  };
}

/**
 * Persist the predecessor's row AND assert it is servable — the positive mark.
 * Reads through `loadSettings` with the cache dropped, so the value provably came
 * from the store rather than from the map `saveSettings` just populated.
 */
async function seedPredecessor(username: string): Promise<void> {
  await settingsMod.saveSettings(username, predecessorSettings());
  settingsMod.clearSettingsCache(username);
  const readBack = await settingsMod.loadSettings(username);
  expect(readBack.liveApiKeyStocks, 'FINGERPRINT DID NOT APPLY — row not servable').toBe(SENTINEL_KEY);
  expect(readBack.demoEquity).toBe(31337);
  settingsMod.clearSettingsCache(username);
}

/** A book on disk, so the tree channel is exercised alongside the row. */
function plantBook(username: string): void {
  mkdirSync(userDir(username), { recursive: true });
  writeFileSync(join(userDir(username), 'trades-stocks.json'), JSON.stringify({ version: 1 }), 'utf-8');
  // The LEGACY per-user settings file. It is a DIFFERENT artefact from the row and
  // it moves with the tree; the archive must not land on top of it.
  writeFileSync(
    join(userDir(username), 'account-settings.json'),
    JSON.stringify({ mode: 'demo', legacyFileMarker: true }),
    'utf-8',
  );
}

describe('TRA-2520 — the account_settings row survives a username recycle', () => {
  it('MUTATION CONTROL: moving users/<name>/ leaves the credentials fully readable', async () => {
    // This is the guard as it shipped in TRA-2410, and the state TRA-2511 arm 2
    // measured live. Every tree-based assertion in `orphaned-books.test.ts` passes
    // here — which is exactly why this bug reached production.
    const user = 'tra2520-naive';
    await seedPredecessor(user);
    plantBook(user);

    rmSync(userDir(user), { recursive: true, force: true });
    expect(existsSync(userDir(user))).toBe(false); // ← reads EXACTLY like a clean account

    // ...and the successor's very first settings read hands over the broker keys.
    const successor = await settingsMod.loadSettings(user);
    expect(successor.liveApiKeyStocks).toBe(SENTINEL_KEY);
    expect(successor.liveAccountIdStocks).toBe(SENTINEL_ACCT);
    expect(successor.liveApiKeyOptionsSandbox).toBe(SENTINEL_KEY);
    // Not just credentials — the user-visible equity number is the predecessor's too.
    expect(successor.demoEquity).toBe(31337);
    expect(successor.dailyTradesLimit).toBe(7);
    settingsMod.clearSettingsCache(user);
  });

  it('AC1: retirement drops the row — the successor loads DEFAULTS, on both channels', async () => {
    const user = 'tra2520-recycled';
    await seedPredecessor(user);
    plantBook(user);

    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });

    expect(receipt.settingsRowFound).toBe(true);
    expect(receipt.settingsRowRetired).toBe(true);
    // Four credential fields held a value; the count is what reaches the wire.
    expect(receipt.settingsCredentialFieldsCleared).toBe(4);
    expect(receipt.errors).toEqual([]);
    expect(receipt.ok).toBe(true);

    // TWO CHANNELS, because they can disagree: a fix that blanked the credential
    // fields but left the row would pass the first assertion and fail the second.
    const successor = await settingsMod.loadSettings(user);
    expect(successor.liveApiKeyStocks ?? '').toBe('');
    expect(successor.liveAccountIdStocks ?? '').toBe('');
    expect(successor.liveApiKeyOptionsSandbox ?? '').toBe('');
    expect(successor.liveAccountIdOptionsSandbox ?? '').toBe('');
    expect(successor.demoEquity).toBe(DEFAULT_ACCOUNT_SETTINGS.demoEquity);
    expect(successor.dailyTradesLimit).toBe(DEFAULT_ACCOUNT_SETTINGS.dailyTradesLimit);
    settingsMod.clearSettingsCache(user);
  });

  it('AC2: DESTROYS NOTHING — the row is archived, with the credentials blanked', async () => {
    const user = 'tra2520-retained';
    await seedPredecessor(user);
    plantBook(user);

    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    expect(receipt.settingsQuarantinedTo).not.toBeNull();

    const archiveFile = join(DATA_DIR, receipt.settingsQuarantinedTo as string);
    expect(existsSync(archiveFile)).toBe(true);
    const raw = readFileSync(archiveFile, 'utf-8');
    const archive = JSON.parse(raw) as {
      username: string;
      retiredAt: number;
      credentialFieldsCleared: string[];
      settings: Partial<AccountSettings>;
    };

    // Retained: the non-credential state is still recoverable by an operator.
    expect(archive.username).toBe(user);
    expect(archive.retiredAt).toBe(T0);
    expect(archive.settings.demoEquity).toBe(31337);
    expect(archive.settings.dailyTradesLimit).toBe(7);

    // Blanked: the credentials are NOT, in the archive either.
    expect(archive.settings.liveApiKeyStocks).toBe('');
    expect(archive.settings.liveAccountIdStocks).toBe('');
    expect(archive.credentialFieldsCleared).toEqual(
      expect.arrayContaining([
        'liveApiKeyStocks',
        'liveAccountIdStocks',
        'liveApiKeyOptionsSandbox',
        'liveAccountIdOptionsSandbox',
      ]),
    );
    // Assert on the BYTES, not on the fields we thought to name. A credential
    // sitting in a field `PERSISTED_CREDENTIAL_FIELDS` forgot would pass every
    // field-by-field check above and still be sitting in this file.
    expect(raw).not.toContain(SENTINEL_KEY);
    expect(raw).not.toContain(SENTINEL_ACCT);
    settingsMod.clearSettingsCache(user);
  });

  it('does not clobber the LEGACY per-user account-settings.json that moved with the tree', async () => {
    const user = 'tra2520-legacy-file';
    await seedPredecessor(user);
    plantBook(user);

    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    const bookDir = join(DATA_DIR, receipt.quarantinedTo as string);

    const legacy = JSON.parse(readFileSync(join(bookDir, 'account-settings.json'), 'utf-8')) as {
      legacyFileMarker?: boolean;
    };
    expect(legacy.legacyFileMarker).toBe(true);
    // ...and the archive is a distinct artefact beside it.
    expect(existsSync(join(bookDir, orphanedBooks.RETIRED_SETTINGS_FILENAME))).toBe(true);
    settingsMod.clearSettingsCache(user);
  });

  it('DETECTS the row-only orphan — no tree, no backup generation, credentials still live', async () => {
    // The case none of the first three channels can see: an operator `rm -rf`s the
    // book and the backups, so `orphanFound` used to be FALSE and the guard returned
    // early having never looked at the store. The row — and the keys in it — stayed.
    const user = 'tra2520-row-only';
    await seedPredecessor(user);
    rmSync(join(DATA_DIR, 'backups'), { recursive: true, force: true });
    expect(existsSync(userDir(user))).toBe(false);

    const receipt = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    expect(receipt.primaryDirExisted).toBe(false);
    expect(receipt.backupGenerationsWithData).toBe(0);
    expect(receipt.orphanFound).toBe(true); // ← off the ROW alone
    expect(receipt.settingsRowRetired).toBe(true);
    expect(receipt.ok).toBe(true);
    // No tree was quarantined, so that field stays honest — but the row was retained.
    expect(receipt.quarantinedTo).toBeNull();
    expect(existsSync(join(DATA_DIR, receipt.settingsQuarantinedTo as string))).toBe(true);

    expect((await settingsMod.loadSettings(user)).liveApiKeyStocks ?? '').toBe('');
    settingsMod.clearSettingsCache(user);
  });

  it('NEGATIVE CONTROL: a never-used name is untouched, and a bystander keeps their row', async () => {
    const fresh = 'tra2520-brand-new';
    const bystander = 'tra2520-bystander';
    await seedPredecessor(bystander);

    const receipt = await orphanedBooks.retireOrphanedBook(fresh, { dataDir: DATA_DIR, now: T0 });
    expect(receipt.orphanFound).toBe(false);
    expect(receipt.settingsRowFound).toBe(false);
    expect(receipt.settingsQuarantinedTo).toBeNull();
    expect(receipt.ok).toBe(true);
    expect(deletedAccounts.accountDeletedAt(fresh, DATA_DIR)).toBeNull();

    // The bystander's own credentials survive — a retirement that reached across
    // usernames would pass every assertion above it.
    const other = await settingsMod.loadSettings(bystander);
    expect(other.liveApiKeyStocks).toBe(SENTINEL_KEY);
    expect(other.demoEquity).toBe(31337);
    settingsMod.clearSettingsCache(bystander);
  });

  it('is idempotent — a second retirement finds no row and stays a clean no-op', async () => {
    const user = 'tra2520-twice';
    await seedPredecessor(user);
    plantBook(user);

    const first = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });
    expect(first.settingsRowFound).toBe(true);

    const second = await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 + 60_000 });
    expect(second.settingsRowFound).toBe(false);
    expect(second.orphanFound).toBe(false);
    expect(second.ok).toBe(true);
  });

  it("the NEW holder's own settings persist normally after the retirement", async () => {
    // Without this, "the row is gone" could be delivered by a store that stopped
    // accepting writes for that username at all — a fix that breaks the account it
    // was meant to protect, while passing every assertion above.
    const user = 'tra2520-new-holder';
    await seedPredecessor(user);
    await orphanedBooks.retireOrphanedBook(user, { dataDir: DATA_DIR, now: T0 });

    await settingsMod.saveSettings(user, { ...DEFAULT_ACCOUNT_SETTINGS, demoEquity: 12345 });
    settingsMod.clearSettingsCache(user);
    expect((await settingsMod.loadSettings(user)).demoEquity).toBe(12345);
    settingsMod.clearSettingsCache(user);
  });
});

describe('TRA-2520 — the credential field list cannot silently fall behind the type', () => {
  it('PERSISTED_CREDENTIAL_FIELDS covers every credential-shaped AccountSettings field', () => {
    // A field-by-field redactor is only as good as its list, and the list is the
    // part that rots: `LiveCredentialField` in the shared package ALREADY omits
    // `liveApiKeyStocks`/`liveAccountIdStocks` — the exact pair TRA-2511 measured
    // leaking — because it means "creds the preflight can report as missing", not
    // "creds a saved blob can hold". So pin the list against the DECLARATION.
    const sharedSrc = readFileSync(join(HERE, '..', '..', 'shared', 'src', 'index.ts'), 'utf-8');
    const declared = new Set<string>();
    for (const line of sharedSrc.split('\n')) {
      const m = /^\s{2}(liveApiKey\w*|liveApiSecret\w*|liveAccountId\w*)\??:\s*string/.exec(line);
      if (m?.[1]) declared.add(m[1]);
    }

    // The scan itself must be able to FAIL. A regex that stops matching (the type
    // gets reformatted, the fields move behind a helper) would otherwise deliver an
    // empty set and a green.
    expect(declared.size, 'the AccountSettings scan matched nothing — the regex has rotted').
      toBeGreaterThanOrEqual(13);

    const covered = new Set(settingsMod.PERSISTED_CREDENTIAL_FIELDS.map(String));
    const missed = [...declared].filter((f) => !covered.has(f)).sort();
    expect(missed, 'credential fields that would survive a username recycle').toEqual([]);
  });
});
