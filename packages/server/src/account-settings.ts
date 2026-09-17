import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import type { AccountSettings } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import { logger } from './observability/index.js';
import { getStateDb, type StateDb } from './sqlite.js';
import { resolveDataDir } from './data-dir.js';

const log = logger.child({ module: 'account-settings' });

const DATA_DIR = resolveDataDir();

// ─── TRA-1052 (TRA-1045 R1) durable settings store ──────────────────────────
// Per-user settings persist as a single JSON blob row keyed by username, so the
// write is a transactional, crash-durable single-row upsert (WAL) instead of a
// full-file JSON rewrite that can tear on a crash. Storing the blob (rather than
// a column-per-field schema) keeps zero schema-migration coupling as
// AccountSettings evolves. The legacy per-user JSON file is read ONCE as a
// first-boot importer and never written again while the db is available.
// Fail-soft: when the db is unavailable every path falls back to the prior JSON
// file behaviour unchanged.
const settingsTableReady = new WeakSet<object>();
function settingsDb(): StateDb | null {
  const db = getStateDb();
  if (!db) return null;
  if (!settingsTableReady.has(db)) {
    db.exec('CREATE TABLE IF NOT EXISTS account_settings (username TEXT PRIMARY KEY, settings_json TEXT NOT NULL)');
    settingsTableReady.add(db);
  }
  return db;
}

function writeSettingsRow(db: StateDb, username: string, settings: AccountSettings): void {
  db.prepare(
    `INSERT INTO account_settings (username, settings_json) VALUES (?, ?)
     ON CONFLICT(username) DO UPDATE SET settings_json = excluded.settings_json`,
  ).run(username, JSON.stringify(settings));
}

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
// (`stocksAutoTradingEnabled`) that applied to both
// demo and live. After the per-mode split each market has independent demo/live
// flags. Copy the legacy value into BOTH new fields once so users keep their
// previous on/off state, then clear the legacy field.
export function migrateLegacyAutoTradingFlags(input: AccountSettings): {
  settings: AccountSettings;
  migrated: boolean;
} {
  const hasLegacyStocks = typeof input.stocksAutoTradingEnabled === 'boolean';
  if (!hasLegacyStocks) return { settings: input, migrated: false };

  const next: AccountSettings = { ...input };
  const v = input.stocksAutoTradingEnabled ?? true;
  if (typeof next.stocksAutoTradingEnabledDemo !== 'boolean') next.stocksAutoTradingEnabledDemo = v;
  if (typeof next.stocksAutoTradingEnabledLive !== 'boolean') next.stocksAutoTradingEnabledLive = v;
  delete next.stocksAutoTradingEnabled;
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
  // `liveBrokerageType` defaulted to 'webull' in DEFAULT_ACCOUNT_SETTINGS, which
  // matches what the original single-market form would have shown when the
  // field was unset, so legacy values route to stocks. (The coinbase arm was
  // removed with the crypto engine, TRA-4629.)
  if (!next.liveApiKeyStocks) next.liveApiKeyStocks = input.liveApiKey ?? '';
  if (!next.liveAccountIdStocks) next.liveAccountIdStocks = input.liveAccountId ?? '';

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

  // TRA-1052 — durable path: a SQLite row wins. On a miss, import the legacy JSON
  // file ONCE into the db (idempotent — the next load finds the row). Any db error
  // falls through to the legacy JSON read path below, so behaviour never regresses.
  const db = settingsDb();
  if (db) {
    try {
      const settings = await loadSettingsViaDb(db, username);
      cache.set(username, settings);
      return settings;
    } catch (err) {
      log.warn('loadSettings: SQLite path failed, falling back to JSON file', {
        username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return loadSettingsFromJsonFile(username);
}

/**
 * Read settings from SQLite, importing the legacy JSON file on a first-boot miss.
 * Throws on a genuine db error (the caller then falls back to the JSON path).
 */
async function loadSettingsViaDb(db: StateDb, username: string): Promise<AccountSettings> {
  const row = db.prepare('SELECT settings_json FROM account_settings WHERE username = ?').get(username) as
    | { settings_json: string }
    | undefined;
  if (row) {
    const parsed = JSON.parse(row.settings_json) as Partial<AccountSettings>;
    return { ...DEFAULT_ACCOUNT_SETTINGS, ...parsed } as AccountSettings;
  }
  // No row yet — ONE-TIME import from the legacy per-user JSON file, if present.
  const imported = await readMigratedJsonFile(username);
  if (imported) {
    writeSettingsRow(db, username, imported);
    log.info('TRA-1052 one-time import: migrated per-user settings JSON → SQLite', { username });
    return imported;
  }
  // Nothing persisted anywhere — return defaults without writing a row (a row is
  // created lazily on the first saveSettings).
  return { ...DEFAULT_ACCOUNT_SETTINGS };
}

/**
 * Read the legacy per-user JSON file and apply the in-place legacy migrations,
 * returning the migrated settings — or null when no file exists. Does NOT write
 * anything (the importer's job is to read once; the db write happens in
 * {@link loadSettingsViaDb}).
 */
async function readMigratedJsonFile(username: string): Promise<AccountSettings | null> {
  const file = userSettingsFile(username);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<AccountSettings>;
  const merged = { ...DEFAULT_ACCOUNT_SETTINGS, ...parsed } as AccountSettings;
  const credsResult = migrateLegacyLiveCredentials(merged);
  const flagsResult = migrateLegacyAutoTradingFlags(credsResult.settings);
  return flagsResult.settings;
}

/** Legacy JSON read path (used only when SQLite is unavailable). Unchanged behaviour. */
async function loadSettingsFromJsonFile(username: string): Promise<AccountSettings> {
  const file = userSettingsFile(username);
  if (!existsSync(file)) {
    const fresh = { ...DEFAULT_ACCOUNT_SETTINGS };
    cache.set(username, fresh);
    return fresh;
  }
  try {
    const raw = await readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AccountSettings>;
    const merged = { ...DEFAULT_ACCOUNT_SETTINGS, ...parsed } as AccountSettings;
    const credsResult = migrateLegacyLiveCredentials(merged);
    const flagsResult = migrateLegacyAutoTradingFlags(credsResult.settings);
    const settings = flagsResult.settings;
    const migrated = credsResult.migrated || flagsResult.migrated;
    if (migrated) {
      try {
        await persistMigrated(username, settings);
        if (credsResult.migrated) log.info('TRA-165 migration: cleared legacy live creds', { username });
        if (flagsResult.migrated) log.info('TRA-229 migration: split auto-trading flags by mode', { username });
      } catch (err: unknown) {
        log.warn('migration: failed to persist migrated settings', {
          username,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    cache.set(username, settings);
    return settings;
  } catch (err) {
    // TRA-485 — log the corrupt-settings path. Without this the user sees
    // their dashboard quietly populated with DEFAULT_ACCOUNT_SETTINGS and
    // there is no server-side breadcrumb explaining why their saved values
    // disappeared. We still return defaults so the user can keep operating
    // (rather than 500-ing the route), but operators now have something to
    // grep for when "all my settings reset" reports come in.
    log.warn('loadSettings: falling back to defaults after read/parse error', {
      username,
      file,
      reason: err instanceof Error ? err.message : String(err),
    });
    const fresh = { ...DEFAULT_ACCOUNT_SETTINGS };
    cache.set(username, fresh);
    return fresh;
  }
}

export function getSettings(username: string): AccountSettings {
  return cache.get(username) ?? { ...DEFAULT_ACCOUNT_SETTINGS };
}

// TRA-511 — credential field names we audit on every successful save so an
// operator can grep "saveSettings: persisted" lines to confirm which creds
// were actually present in the payload that hit disk (without ever logging
// the cleartext values themselves). Catches the "Test Connection passed but
// the on-disk file is empty" class of bug the parent ticket investigated.
const CREDENTIAL_FIELDS: ReadonlyArray<keyof AccountSettings> = [
  'liveApiKeyStocks',
  'liveAccountIdStocks',
  'liveApiKeyOptionsSandbox',
  'liveAccountIdOptionsSandbox',
  'liveApiKeyOptionsProduction',
  'liveAccountIdOptionsProduction',
];

function summarizeCredentialPresence(settings: AccountSettings): {
  filled: string[];
  blank: string[];
} {
  const filled: string[] = [];
  const blank: string[] = [];
  for (const field of CREDENTIAL_FIELDS) {
    const raw = settings[field];
    if (typeof raw === 'string' && raw.trim() !== '') {
      filled.push(String(field));
    } else {
      blank.push(String(field));
    }
  }
  return { filled, blank };
}

export async function saveSettings(username: string, settings: AccountSettings): Promise<void> {
  // TRA-1052 — durable path: a single transactional row upsert (WAL, crash-safe)
  // replaces the full-file JSON rewrite. Persist BEFORE mutating the cache so a
  // failed write leaves the in-memory state matching what's actually persisted
  // (the TRA-511 invariant). Fail-soft to the legacy JSON write below on db error.
  const db = settingsDb();
  if (db) {
    try {
      writeSettingsRow(db, username, settings);
      cache.set(username, { ...settings });
      logSavePersisted(username, settings);
      return;
    } catch (err) {
      log.warn('saveSettings: SQLite write failed, falling back to JSON file', {
        username,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const dir = dirname(userSettingsFile(username));
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  // TRA-511 — write to disk BEFORE mutating the cache so a failed `writeFile`
  // leaves the in-memory state matching what's actually persisted. Without
  // this, a partial disk write would race: the route handler reports success
  // (cache says new creds present), Test Connection passes against cache, but
  // the next GET /api/account/settings reload pulls the old (or empty) file.
  // Exactly the divergence the TRA-505 screenshot captured.
  const file = userSettingsFile(username);
  await writeFile(file, JSON.stringify(settings, null, 2), 'utf-8');
  cache.set(username, { ...settings });
  logSavePersisted(username, settings);
}

/** TRA-511 — audit which credential fields were present in the saved payload. */
function logSavePersisted(username: string, settings: AccountSettings): void {
  const presence = summarizeCredentialPresence(settings);
  log.info('saveSettings: persisted', {
    username,
    mode: settings.mode,
    liveTradierEnvOptions: settings.liveTradierEnvOptions,
    credentialsFilled: presence.filled,
    credentialsBlank: presence.blank,
  });
}

export function clearSettingsCache(username: string): void {
  cache.delete(username);
}

// ─── TRA-2520 — the settings row is a RECYCLABLE-KEY channel ────────────────
//
// `account_settings` is keyed by the RAW USERNAME (see the table DDL above), and
// a username is a recyclable primary key (TRA-2410). Everything else that account
// owns lives under `users/<username>/`, so `retireOrphanedBook` frees the name by
// MOVING that directory — but a directory move cannot touch a database row. The
// row therefore survives every path that frees a name, and the next holder of the
// name loads it: `GET /api/account/settings` returns `loadSettings(username)`
// UNREDACTED, so the successor reads the predecessor's saved broker keys in
// cleartext. Measured live on bqb1 (TRA-2511 arm 2).
//
// Two exports, deliberately split, because the ordering is load-bearing in the
// same way the tombstone's is: the caller ARCHIVES the row (redacted) into the
// quarantined tree FIRST and only then drops it. Fusing them into one
// "retireSettingsRow" would mean the destroy had already happened by the time the
// archive write could fail — and this module's contract is retain, not destroy.

/**
 * Every persisted field that carries a BROKER CREDENTIAL.
 *
 * ⚠️ NOT `LiveCredentialField` (`@trading-app/shared`). That type is the set of
 * creds the live-trading PREFLIGHT can report as *missing*, which excludes
 * `liveApiKeyStocks` / `liveAccountIdStocks` entirely — and those are two of the
 * four fields the TRA-2511 probe actually measured leaking. Redacting by that
 * type would have shipped a fix that reads as complete and still hands over the
 * stocks keys. This list is the PERSISTENCE view: anything a saved blob can hold.
 *
 * Includes the pre-split legacy fields (`liveApiKey` / `liveApiSecret` /
 * `liveAccountId`, TRA-165) and the pre-env-split options pair
 * (`liveApiKeyOptions` / `liveAccountIdOptions`) — a blob written before those
 * migrations still has values in them, and a retiring account is exactly the kind
 * of old blob that never got loaded (and so never got migrated) since.
 *
 * `account-settings.test.ts` pins this against the `AccountSettings` declaration
 * itself, so a new credential field added to the shared type fails the suite
 * rather than silently escaping retirement.
 */
export const PERSISTED_CREDENTIAL_FIELDS: ReadonlyArray<string> = [
  // legacy, pre-market-split (TRA-165)
  'liveApiKey',
  'liveApiSecret',
  'liveAccountId',
  // stocks — NOT in LiveCredentialField, and the pair that leaked
  'liveApiKeyStocks',
  'liveAccountIdStocks',
  // crypto — RETIRED fields (TRA-4629 removed the crypto engine; nothing reads
  // these anymore), kept here BY NAME because old persisted blobs still carry
  // plaintext Coinbase creds and a retiring account must still be scrubbed.
  'liveApiKeyCrypto',
  'liveApiSecretCrypto',
  // options, pre-env-split
  'liveApiKeyOptions',
  'liveAccountIdOptions',
  // options, per-env
  'liveApiKeyOptionsSandbox',
  'liveAccountIdOptionsSandbox',
  'liveApiKeyOptionsProduction',
  'liveAccountIdOptionsProduction',
];

/**
 * Blank every credential field, reporting which ones actually held something.
 *
 * Blank (`''`) rather than `delete`: the archived blob keeps its shape, so an
 * operator restoring it by hand gets a settings object the loader accepts, with
 * the credentials visibly emptied rather than mysteriously absent.
 *
 * Returns NAMES only. The values are the thing we are here to contain.
 */
export function redactPersistedCredentials(input: Partial<AccountSettings>): {
  settings: Partial<AccountSettings>;
  cleared: string[];
} {
  const settings: Partial<AccountSettings> = { ...input };
  const cleared: string[] = [];
  for (const field of PERSISTED_CREDENTIAL_FIELDS) {
    const raw = (settings as Record<string, unknown>)[field];
    if (typeof raw === 'string' && raw.trim() !== '') cleared.push(field);
    if (raw !== undefined) (settings as Record<string, unknown>)[field] = '';
  }
  return { settings, cleared };
}

export interface PersistedSettingsRow {
  /** A durable row exists under this exact username. */
  found: boolean;
  /**
   * `'unavailable'` means the durable store is off (TRA-1681 fail-soft), NOT that
   * the row is clean. In that mode settings live in
   * `users/<name>/account-settings.json`, which the tree move already carries —
   * so there is nothing extra to retire, and `found: false` is the honest answer.
   */
  storage: 'sqlite' | 'unavailable';
  /** The persisted blob EXACTLY as stored, credentials blanked. Null when absent. */
  redacted: Partial<AccountSettings> | null;
  /** Names of the credential fields that held a non-blank value. Never the values. */
  credentialFieldsCleared: string[];
}

/**
 * Read the durable settings row for retirement WITHOUT mutating anything.
 *
 * Deliberately does NOT merge `DEFAULT_ACCOUNT_SETTINGS` — the archive should be
 * what was actually persisted, not what the loader would have synthesised on top
 * of it. Merging would also make an empty row indistinguishable from a full one
 * in the archived file.
 *
 * Throws on a genuine db error so the caller can record it; a throw here is NOT a
 * leak in itself, because the same SELECT is what `loadSettingsViaDb` runs — a db
 * that cannot answer it cannot serve the row to the successor either, and
 * `loadSettings` falls through to the JSON file that moved with the tree.
 */
export function readSettingsRowForRetirement(username: string): PersistedSettingsRow {
  const db = settingsDb();
  if (!db) {
    return { found: false, storage: 'unavailable', redacted: null, credentialFieldsCleared: [] };
  }
  const row = db.prepare('SELECT settings_json FROM account_settings WHERE username = ?').get(username) as
    | { settings_json: string }
    | undefined;
  if (!row) {
    return { found: false, storage: 'sqlite', redacted: null, credentialFieldsCleared: [] };
  }
  const parsed = JSON.parse(row.settings_json) as Partial<AccountSettings>;
  const { settings, cleared } = redactPersistedCredentials(parsed);
  return { found: true, storage: 'sqlite', redacted: settings, credentialFieldsCleared: cleared };
}

/**
 * Drop the durable settings row and the in-memory copy of it.
 *
 * `verified` is read back with a fresh SELECT rather than trusting the DELETE's
 * own `changes` count, because the failure this closes is "the row is still
 * servable" — which is a question about the STORE, not about the statement we
 * just ran. The caller gates on `verified`.
 *
 * The cache drop is unconditional and happens even when the delete fails: the
 * in-memory map is a third copy of the same leak (`getSettings` serves it
 * directly), and dropping it can never destroy anything persisted.
 */
export function deleteSettingsRow(
  username: string,
  opts: { reason?: 'recycled' | 'deleted' } = {},
): { deleted: boolean; verified: boolean } {
  const db = settingsDb();
  if (!db) {
    clearSettingsCache(username);
    return { deleted: false, verified: true };
  }
  try {
    db.prepare('DELETE FROM account_settings WHERE username = ?').run(username);
    const still = db.prepare('SELECT 1 AS present FROM account_settings WHERE username = ?').get(username);
    const verified = still === undefined || still === null;
    // The two callers are different EVENTS and an operator reading the log needs to
    // tell them apart: `recycled` is TRA-2520's retirement at signup (the row was
    // archived first), `deleted` is TRA-2513's destroy at `DELETE /api/account`
    // (nothing was retained). Labelling both as a recycle — as this line did when
    // it had only one caller — would make a self-delete look like an adoption.
    if (verified) {
      log.info('account_settings row dropped', { username, reason: opts.reason ?? 'recycled' });
    }
    return { deleted: true, verified };
  } finally {
    clearSettingsCache(username);
  }
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
 * TRA-346 — return a partial AccountSettings holding only the scoped
 * Managed Account Ratio + Risk Per Trade fields, each clamped against the
 * matching bucket from `body` (request) falling back to `current` (saved).
 *
 * Extracted so the unit tests can lock in the per-bucket isolation contract
 * without spinning up the full Express route. Each bucket is clamped
 * independently, otherwise the resolver's legacy
 * fallback breaks for users who saved before TRA-346.
 */
export function mergeScopedRiskSettings(
  current: AccountSettings,
  body: Partial<AccountSettings>,
): Pick<
  AccountSettings,
  | 'managedAccountRatioDemoStocks'
  | 'managedAccountRatioLiveStocks'
  | 'riskPerTradeDemoStocks'
  | 'riskPerTradeLiveStocks'
> {
  return {
    managedAccountRatioDemoStocks: clampScopedRatio(body.managedAccountRatioDemoStocks, current.managedAccountRatioDemoStocks),
    managedAccountRatioLiveStocks: clampScopedRatio(body.managedAccountRatioLiveStocks, current.managedAccountRatioLiveStocks),
    riskPerTradeDemoStocks: clampScopedRisk(body.riskPerTradeDemoStocks, current.riskPerTradeDemoStocks),
    riskPerTradeLiveStocks: clampScopedRisk(body.riskPerTradeLiveStocks, current.riskPerTradeLiveStocks),
  };
}
