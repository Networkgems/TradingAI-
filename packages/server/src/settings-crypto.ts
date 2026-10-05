// TRA-5125 (TRA-3925 ruling, CEO condition a) — broker credentials at rest.
//
// `account_settings.settings_json` stored per-user Tradier production creds
// (`liveApiKeyOptionsProduction` / `liveAccountIdOptionsProduction`) in
// PLAINTEXT. One copy of `state.db` — or any backup of it — hands over every
// linked user's broker key. This module makes the persisted value an
// AES-256-GCM ciphertext; the plaintext exists only in process memory.
//
// Design constraints that shaped this file:
//
//   • The risk class is DB/BACKUP LEAK, not env-var wipe (TRA-2136 does not
//     apply — these are SQLite rows). So the key lives in the environment,
//     OUTSIDE the DB file, and a leaked `state.db` alone is useless.
//
//   • Key sourcing must work on bqb1 TODAY without a new Render env write:
//     a dedicated `SETTINGS_ENCRYPTION_KEY` wins when set; otherwise the key
//     is derived (scrypt) from `ADMIN_PASSWORD`, which every deployment
//     already carries and which is pinned never-rotate by standing ruling.
//     A deployment with NEITHER gets passthrough-plus-loud-warning rather
//     than a boot failure — that is dev/test only; both prod services set
//     ADMIN_PASSWORD.
//
//   • DECRYPT FAILURE FAILS CLOSED TO "NO CREDS", NEVER OPEN. A field that
//     cannot be decrypted is served BLANK, so the account-verb resolution
//     (tradier-client-scope.ts) answers its loud 403/409 refusal — it must
//     never fall through to a borrowed operator client, and `enc:v1:` bytes
//     must never be sent to Tradier as if they were a token.
//
//   • Key rotation story: `SETTINGS_ENCRYPTION_KEY_PREVIOUS` is accepted for
//     DECRYPT ONLY. Writes always use the primary. To rotate: set the old key
//     as _PREVIOUS, the new one as the primary, redeploy; rows re-encrypt on
//     their next save (and the boot migration re-wraps any row the primary
//     cannot read but the previous can). Then drop _PREVIOUS.
//
// No function in this file ever logs, throws, or returns a credential value
// inside an error path — names and reasons only.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/** Versioned marker so a future algorithm change can coexist with old rows. */
export const SETTINGS_ENC_PREFIX = 'enc:v1:gcm:';

const KEY_BYTES = 32;
const IV_BYTES = 12;
// Fixed, versioned scrypt salt for the ADMIN_PASSWORD derivation. A random
// salt would need storing next to the data it protects; the password itself
// is the secret here, the salt only has to domain-separate this derivation
// from any other use of the same password.
const DERIVE_SALT = 'tradingai:settings-crypto:v1';

export interface SettingsCryptoKeys {
  primary: Buffer;
  /** Decrypt-only. Never used for a write. */
  previous: Buffer | null;
  source: 'env' | 'derived-admin-password';
}

function parseKeyMaterial(raw: string): Buffer | null {
  const v = raw.trim();
  if (v === '') return null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  try {
    const b = Buffer.from(v, 'base64');
    if (b.length === KEY_BYTES) return b;
  } catch {
    /* fall through */
  }
  return null;
}

// scrypt is deliberately slow; cache derivations keyed by the material so the
// per-save / per-load cost is a Map hit, not a KDF run.
const keyCache = new Map<string, SettingsCryptoKeys | null>();

/**
 * Resolve the at-rest keys from the environment, or null when no key material
 * exists (passthrough mode — dev/test only; the caller owns the loud warning).
 */
export function resolveSettingsCryptoKeys(procEnv: NodeJS.ProcessEnv = process.env): SettingsCryptoKeys | null {
  const cacheKey = `${procEnv['SETTINGS_ENCRYPTION_KEY'] ?? ''}\u0000${procEnv['SETTINGS_ENCRYPTION_KEY_PREVIOUS'] ?? ''}\u0000${procEnv['ADMIN_PASSWORD'] ?? ''}`;
  const hit = keyCache.get(cacheKey);
  if (hit !== undefined) return hit;

  let resolved: SettingsCryptoKeys | null = null;
  const envKey = parseKeyMaterial(procEnv['SETTINGS_ENCRYPTION_KEY'] ?? '');
  const prevRaw = (procEnv['SETTINGS_ENCRYPTION_KEY_PREVIOUS'] ?? '').trim();
  const previous = prevRaw !== '' ? (parseKeyMaterial(prevRaw) ?? scryptSync(prevRaw, DERIVE_SALT, KEY_BYTES)) : null;
  if (envKey) {
    resolved = { primary: envKey, previous, source: 'env' };
  } else {
    const adminPw = (procEnv['ADMIN_PASSWORD'] ?? '').trim();
    if (adminPw !== '') {
      resolved = { primary: scryptSync(adminPw, DERIVE_SALT, KEY_BYTES), previous, source: 'derived-admin-password' };
    }
  }
  keyCache.set(cacheKey, resolved);
  return resolved;
}

/** Test seam — drop the derivation cache so a suite can flip env vars. */
export function __resetSettingsCryptoCacheForTests(): void {
  keyCache.clear();
}

export function isEncryptedCredentialValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SETTINGS_ENC_PREFIX);
}

/**
 * Encrypt one credential value. `field` is bound in as GCM AAD, so a
 * ciphertext pasted into a DIFFERENT credential field fails authentication
 * instead of quietly decrypting into the wrong slot.
 */
export function encryptCredentialValue(plain: string, key: Buffer, field: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(field, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SETTINGS_ENC_PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export type CredentialDecryptResult =
  | { ok: true; value: string; usedPreviousKey: boolean }
  | { ok: false; reason: 'malformed' | 'auth_failed' | 'no_key' };

function tryDecryptWithKey(ivB64: string, tagB64: string, ctB64: string, key: Buffer, field: string): string | null {
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(field, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Decrypt one `enc:v1:gcm:` value, trying the primary key then the previous. */
export function decryptCredentialValue(
  stored: string,
  keys: SettingsCryptoKeys | null,
  field: string,
): CredentialDecryptResult {
  if (!stored.startsWith(SETTINGS_ENC_PREFIX)) {
    // Not ours to decode — caller treats it as legacy plaintext.
    return { ok: true, value: stored, usedPreviousKey: false };
  }
  if (!keys) return { ok: false, reason: 'no_key' };
  const parts = stored.slice(SETTINGS_ENC_PREFIX.length).split(':');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const viaPrimary = tryDecryptWithKey(ivB64, tagB64, ctB64, keys.primary, field);
  if (viaPrimary !== null) return { ok: true, value: viaPrimary, usedPreviousKey: false };
  if (keys.previous) {
    const viaPrevious = tryDecryptWithKey(ivB64, tagB64, ctB64, keys.previous, field);
    if (viaPrevious !== null) return { ok: true, value: viaPrevious, usedPreviousKey: true };
  }
  return { ok: false, reason: 'auth_failed' };
}

export interface EncryptFieldsOutcome<T> {
  settings: T;
  /** Field names encrypted in this pass. Never the values. */
  encrypted: string[];
  /** Non-blank credential fields left in plaintext because no key resolved. */
  plaintextRetained: string[];
}

/**
 * Return a copy of `input` with every non-blank string field in `fields`
 * encrypted under the primary key. Already-encrypted values pass through
 * untouched (idempotent — safe for the boot migration to re-run).
 */
export function encryptCredentialFields<T extends Record<string, unknown>>(
  input: T,
  fields: ReadonlyArray<string>,
  keys: SettingsCryptoKeys | null,
): EncryptFieldsOutcome<T> {
  const settings: Record<string, unknown> = { ...input };
  const encrypted: string[] = [];
  const plaintextRetained: string[] = [];
  for (const field of fields) {
    const raw = settings[field];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    if (isEncryptedCredentialValue(raw)) continue;
    if (!keys) {
      plaintextRetained.push(field);
      continue;
    }
    settings[field] = encryptCredentialValue(raw, keys.primary, field);
    encrypted.push(field);
  }
  return { settings: settings as T, encrypted, plaintextRetained };
}

export interface DecryptFieldsOutcome<T> {
  settings: T;
  /** Fields successfully decrypted (incl. via the previous key). */
  decrypted: string[];
  /** Fields decrypted only by `SETTINGS_ENCRYPTION_KEY_PREVIOUS` — due a re-wrap on next save. */
  usedPreviousKey: string[];
  /** Fields that held `enc:v1:` bytes we could NOT open — served BLANK (fail closed). */
  failed: string[];
}

/**
 * Return a copy of `input` with every `enc:v1:gcm:` field in `fields`
 * decrypted. A field that fails to decrypt is BLANKED, never served raw:
 * downstream credential resolution then answers its loud no-creds refusal
 * instead of either leaking ciphertext to the broker or borrowing the
 * operator's client.
 */
export function decryptCredentialFields<T extends Record<string, unknown>>(
  input: T,
  fields: ReadonlyArray<string>,
  keys: SettingsCryptoKeys | null,
): DecryptFieldsOutcome<T> {
  const settings: Record<string, unknown> = { ...input };
  const decrypted: string[] = [];
  const usedPreviousKey: string[] = [];
  const failed: string[] = [];
  for (const field of fields) {
    const raw = settings[field];
    if (!isEncryptedCredentialValue(raw)) continue;
    const result = decryptCredentialValue(raw, keys, field);
    if (result.ok) {
      settings[field] = result.value;
      decrypted.push(field);
      if (result.usedPreviousKey) usedPreviousKey.push(field);
    } else {
      settings[field] = '';
      failed.push(field);
    }
  }
  return { settings: settings as T, decrypted, usedPreviousKey, failed };
}
