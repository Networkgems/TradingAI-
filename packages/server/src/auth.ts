import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from './observability/index.js';
import { normalizeUsername } from './username-grammar.js';

const log = logger.child({ module: 'auth' });

/**
 * Resolve the HMAC signing secret (TRA-404, hardened by TRA-2296).
 *
 * An ephemeral secret means every restart re-rolls the signing key, so every
 * previously issued token fails `verifyToken` and every logged-in user is
 * silently signed out. In production that is never acceptable, so refuse to
 * start instead; keep the ephemeral fallback (with a loud warning) only for
 * local dev / tests.
 *
 * TRA-2296: this guard used to read `isProd && !onRender`, exempting Render on
 * the reasoning that `render.yaml` injects AUTH_SECRET via `generateValue: true`
 * and so it is "always present in production". Both halves of that were wrong
 * for the one host that mattered:
 *
 *   1. bqb1 was created from the Render *dashboard*, and render.yaml env blocks
 *      are inert on dashboard-created services. Nothing injected anything.
 *   2. The var was present but set to the EMPTY STRING — so a presence check
 *      would have passed anyway. Presence is not the property we need.
 *
 * The result: prod ran on a random per-process key for months, ~8 boots/day,
 * and the one platform the guard exempted was the only one that was broken.
 * So: no platform exemption, and the test is on the VALUE, not on presence.
 * A whitespace-only value is treated as unset for the same reason.
 */
function resolveAuthSecret(): string {
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;

  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    throw new Error(
      `AUTH_SECRET is ${fromEnv === undefined ? 'not set' : 'set but empty'}. Refusing to ` +
        'start in production with an ephemeral signing key — every restart would ' +
        'silently invalidate all sessions. Set AUTH_SECRET to a 32-byte hex value ' +
        '(`openssl rand -hex 32`) in the environment. On Render this must be set on ' +
        'the service itself (dashboard or API): render.yaml env blocks are INERT on ' +
        'dashboard-created services, so do not assume `generateValue: true` applied.',
    );
  }
  log.warn(
    'AUTH_SECRET is not set — using an ephemeral random secret. All ' +
      'sessions will be invalidated when the process restarts. Set AUTH_SECRET ' +
      'for stable sessions.',
  );
  return randomBytes(32).toString('hex');
}

const SECRET = resolveAuthSecret();

/**
 * Max session-token lifetime in ms (TRA-404 / C1). Configurable via
 * `AUTH_TOKEN_TTL_HOURS`; defaults to 24h. Invalid / non-positive values fall
 * back to the default so a typo can never disable expiry.
 */
export function resolveTtlMs(raw: string | undefined): number {
  const DEFAULT_HOURS = 24;
  const hours = raw === undefined || raw.trim() === '' ? DEFAULT_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_HOURS * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

export const TOKEN_TTL_MS = resolveTtlMs(process.env.AUTH_TOKEN_TTL_HOURS);

/**
 * TRA-4479 / audit H4 item 4 — minimum password length, one constant for every
 * write path (register, reset, self-change, admin set). It was 6, restated as a
 * literal in five places in `index.ts` and four more in the desktop app, so
 * "raise the floor" was a nine-site edit nobody was going to get right twice.
 *
 * 8 is the NIST SP 800-63B floor. It is enforced only on WRITE: an existing
 * 6-character password still logs in, because failing it at `login` would lock
 * the desk out of its own accounts with no path back in.
 */
export const MIN_PASSWORD_LENGTH = 8;

function sign(encoded: string): string {
  return createHmac('sha256', SECRET).update(encoded).digest('base64url');
}

/**
 * TRA-1505 — keyed hash for short-lived secrets we must store but never keep in
 * plaintext (email OTP codes, 2FA backup codes). Reuses the same server-side
 * `SECRET` so a leaked on-disk store can't be reversed without it, and hands
 * callers a constant-time comparator. Never log the plaintext input.
 */
export function hashSecretValue(value: string): string {
  return createHmac('sha256', SECRET).update(value).digest('base64url');
}

/** Constant-time compare of a plaintext value against a `hashSecretValue` hash. */
export function verifySecretHash(value: string, hash: string): boolean {
  try {
    const a = Buffer.from(hashSecretValue(value));
    const b = Buffer.from(hash);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * TRA-1505 — pending-auth token TTL. After a correct password an enrolled user
 * gets a *pending* token (not a full session) that only lets them complete the
 * second factor; it expires fast so a stolen pending token is near-useless.
 * Configurable via `AUTH_PENDING_TTL_MIN`; defaults to 10 minutes.
 */
export function resolvePendingTtlMs(raw: string | undefined): number {
  const DEFAULT_MIN = 10;
  const min = raw === undefined || raw.trim() === '' ? DEFAULT_MIN : Number(raw);
  if (!Number.isFinite(min) || min <= 0) return DEFAULT_MIN * 60 * 1000;
  return min * 60 * 1000;
}

export const PENDING_TOKEN_TTL_MS = resolvePendingTtlMs(process.env.AUTH_PENDING_TTL_MIN);

/**
 * Verify a token's signature and return its decoded payload, or null if the
 * signature does not match. Shared by the session- and pending-token verifiers.
 */
function verifySignedPayload(token: string): Record<string, unknown> | null {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Issue a signed session token. `issuedAt` defaults to now; an explicit value
 * exists for tests that need to simulate an aged token.
 */
export function createToken(username: string, issuedAt: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ sub: username, iat: issuedAt })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): string | null {
  const data = verifySignedPayload(token);
  if (!data) return null;
  if (typeof data['sub'] !== 'string') return null;
  // TRA-1505: a pending-auth token (issued after password but before the second
  // factor) must NEVER be accepted as a full session — reject it here so the
  // client can't skip 2FA by presenting its pending token to a protected route.
  if (data['typ'] === 'pending2fa') return null;
  const iat = data['iat'];
  // C1 (TRA-404): enforce a max token lifetime. `createToken` always stamps a
  // numeric `iat`, so a token missing/!finite `iat` is malformed or forged →
  // reject. Tokens older than TOKEN_TTL_MS are expired → reject.
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (Date.now() - iat > TOKEN_TTL_MS) return null;
  return data['sub'] as string;
}

/**
 * TRA-1505 — issue a short-lived pending-auth token after a correct password
 * when the account requires a second factor. It carries `typ: 'pending2fa'` so
 * `verifyToken` refuses it as a session; only `/api/auth/2fa/verify` accepts it,
 * and only to complete the OTP step.
 */
export function createPendingToken(username: string, issuedAt: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: username, iat: issuedAt, typ: 'pending2fa' }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyPendingToken(token: string): string | null {
  const data = verifySignedPayload(token);
  if (!data) return null;
  if (typeof data['sub'] !== 'string') return null;
  if (data['typ'] !== 'pending2fa') return null;
  const iat = data['iat'];
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (Date.now() - iat > PENDING_TOKEN_TTL_MS) return null;
  return data['sub'] as string;
}

// ── Password reset tokens ─────────────────────────────────────────────────────

/**
 * TRA-4479 — the reset store, re-keyed by USERNAME+CODE and given an attempt cap.
 *
 * What this store used to be, and why it was worse than an 8-digit code looks:
 *
 *   - the map was keyed by the CODE ALONE (`resetTokens.get(code)`), so a single
 *     guess was tested against the UNION of every outstanding code across every
 *     account at once. With k accounts mid-reset the effective search space is
 *     10^8 / k, not 10^8 — the attacker does not have to pick a victim, and
 *     firing `forgot-password` at many usernames actively shrinks the space;
 *   - the code came from `Math.random()`, which is not a CSPRNG. V8's xorshift128+
 *     state is recoverable from a handful of outputs, and this endpoint hands the
 *     caller an output on demand;
 *   - the code was persisted to `reset-tokens.json` in PLAINTEXT, so a read of
 *     that one file is an immediate takeover of every account mid-reset;
 *   - nothing counted failed redemptions, so a code stayed guessable for its full
 *     hour no matter how many wrong guesses had been aimed at it.
 *
 * The per-IP throttle that TRA-404/C2 put in front of the route did not bound
 * any of that: `app.set('trust proxy', true)` made `req.ip` the LEFTMOST
 * `X-Forwarded-For` entry, i.e. a value the caller writes (measured, see
 * `resolveTrustProxy` in `http-security.ts`). One header per request bought a
 * fresh bucket, so the limiter read armed and admitted unlimited attempts.
 *
 * So this store now holds the invariant on its own, without depending on any
 * network-layer identity being honest:
 *
 *   1. the key is `hashSecretValue(username \0 code)` — a redemption must NAME
 *      the account it is aimed at, which deletes the union entirely;
 *   2. the code is `crypto.randomInt`;
 *   3. only the keyed hash is ever written to disk — the plaintext code exists
 *      in the email and nowhere else;
 *   4. `recordResetFailure(username)` burns that account's outstanding codes
 *      after RESET_MAX_ATTEMPTS wrong guesses, which caps an attacker at N tries
 *      per account per code REGARDLESS of how many IPs they command.
 *
 * (4) is the one that survives an IP-rotating botnet, which is why it is here
 * and not in the throttle module.
 */

/** Failed redemptions aimed at an account before its outstanding codes burn. */
export const RESET_MAX_ATTEMPTS = 5;

interface ResetEntry {
  username: string;
  expiresAt: number;
  /** Failed redemptions aimed at this entry's account since it was minted. */
  attempts: number;
  /**
   * TRA-4479 compatibility shim, set ONLY on entries that were minted by the
   * old code-only store and read back at boot. A client that predates this
   * change sends `{ code }` with no username and can still redeem exactly these
   * — see `consumeLegacyResetToken`. Nothing ever sets it on a new entry, so the
   * shim empties itself within one RESET_TTL_MS window and cannot be used
   * against any code minted after the deploy.
   */
  legacyCode?: string;
}

/** Keyed by `resetKey(username, code)`. The plaintext code is never a key. */
const resetTokens = new Map<string, ResetEntry>();
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Shape of a pre-TRA-4479 top-level key: the plaintext 8-digit code itself. */
const LEGACY_CODE_KEY = /^\d{8}$/;
let resetTokensFile: string | null = null;

/**
 * The store key. Reuses the server-side `SECRET`, so `reset-tokens.json` on its
 * own reveals neither the code nor a way to test a guess offline.
 *
 * The username is normalized with the READ-path normalizer (`normalizeUsername`,
 * TRA-4475) on both the mint and the redeem side, so the two sides cannot
 * disagree about a spelling — an NFC/whitespace difference here would silently
 * make every code un-redeemable, which is the failure direction that locks real
 * users out.
 */
function resetKey(username: string, code: string): string {
  return hashSecretValue(`${normalizeUsername(username) ?? username}\u0000${code}`);
}

export function initResetTokenStore(dataDir: string): void {
  resetTokensFile = join(dataDir, 'reset-tokens.json');
  resetTokens.clear();
  if (!existsSync(resetTokensFile)) return;
  try {
    const raw = readFileSync(resetTokensFile, 'utf-8');
    const data = JSON.parse(raw) as Record<string, Partial<ResetEntry>>;
    const now = Date.now();
    for (const [key, entry] of Object.entries(data)) {
      if (typeof entry?.username !== 'string' || typeof entry?.expiresAt !== 'number') continue;
      if (entry.expiresAt <= now) continue;
      const legacyCode = LEGACY_CODE_KEY.test(key)
        ? key
        : typeof entry.legacyCode === 'string' ? entry.legacyCode : undefined;
      const normalized: ResetEntry = {
        username: entry.username,
        expiresAt: entry.expiresAt,
        attempts: typeof entry.attempts === 'number' ? entry.attempts : 0,
        ...(legacyCode ? { legacyCode } : {}),
      };
      // A legacy row is re-indexed under the NEW key as well, so a client that
      // does send the username can redeem an in-flight old code too. Both maps
      // being the same object means an attempt counted once counts everywhere.
      resetTokens.set(legacyCode ? resetKey(normalized.username, legacyCode) : key, normalized);
    }
    // Rewrite immediately so the plaintext 8-digit keys leave the file on the
    // first boot after this change, even if no reset happens today.
    persistResetTokens();
  } catch { /* ignore corrupt file */ }
}

function persistResetTokens(): void {
  if (!resetTokensFile) return;
  const data: Record<string, ResetEntry> = {};
  for (const [key, entry] of resetTokens) data[key] = entry;
  try { writeFileSync(resetTokensFile, JSON.stringify(data), 'utf-8'); } catch { /* best-effort */ }
}

export function generateResetToken(username: string): string {
  // 8-digit numeric code, CSPRNG. `randomInt` is max-exclusive, so this is
  // uniform over 10000000..99999999 and always exactly 8 digits.
  const code = String(randomInt(10_000_000, 100_000_000));
  resetTokens.set(resetKey(username, code), {
    username,
    expiresAt: Date.now() + RESET_TTL_MS,
    attempts: 0,
  });
  persistResetTokens();
  return code;
}

/** Look up (without consuming) the account a `username`+`code` pair unlocks. */
export function validateResetToken(code: string, username: string): string | null {
  const key = resetKey(username, code);
  const entry = resetTokens.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resetTokens.delete(key);
    persistResetTokens();
    return null;
  }
  return entry.username;
}

export function consumeResetToken(code: string, username: string): string | null {
  const redeemed = validateResetToken(code, username);
  if (redeemed) {
    resetTokens.delete(resetKey(username, code));
    persistResetTokens();
  }
  return redeemed;
}

/**
 * TRA-4479 — redeem a code minted BEFORE this change, where the caller has no
 * username to give. Scans only rows carrying `legacyCode`; a code minted after
 * the deploy is unreachable from here, so this cannot be used to attack the
 * union pool. The set drains to empty within one RESET_TTL_MS of the deploy.
 */
export function consumeLegacyResetToken(code: string): string | null {
  const now = Date.now();
  for (const [key, entry] of resetTokens) {
    if (entry.legacyCode !== code) continue;
    resetTokens.delete(key);
    persistResetTokens();
    return now > entry.expiresAt ? null : entry.username;
  }
  return null;
}

/**
 * Record a failed redemption aimed at `username` and burn that account's
 * outstanding codes once they reach `RESET_MAX_ATTEMPTS`. Returns how many were
 * burned.
 *
 * Counting on the ACCOUNT rather than on the submitted code is deliberate: a
 * wrong guess matches no entry, so a per-code counter would never see the
 * attack it exists to stop. An unknown username is a silent no-op — this must
 * not become an account-existence oracle.
 *
 * Residual, accepted: an attacker who knows a username can burn that account's
 * outstanding code and force the owner to request another. That is a nuisance,
 * not a takeover, and `forgot-password` stays available.
 */
export function recordResetFailure(username: string): number {
  const target = normalizeUsername(username) ?? username;
  let burned = 0;
  for (const [key, entry] of resetTokens) {
    if ((normalizeUsername(entry.username) ?? entry.username) !== target) continue;
    entry.attempts += 1;
    if (entry.attempts >= RESET_MAX_ATTEMPTS) {
      resetTokens.delete(key);
      burned += 1;
    }
  }
  persistResetTokens();
  return burned;
}

/**
 * TRA-2421 — drop every outstanding reset code for `username`. Returns how many
 * were revoked.
 *
 * `reset-tokens.json` lives at the DATA_DIR ROOT, not under
 * `users/<username>/`, so an account wipe that only removes the per-user
 * directory leaves it untouched. Usernames are recycled here (they are the only
 * primary key), so a code minted for the deleted account would otherwise stay
 * redeemable for up to an hour against whoever next registers that name — a
 * password-reset path onto someone else's book.
 */
export function revokeResetTokensFor(username: string): number {
  const target = normalizeUsername(username) ?? username;
  let revoked = 0;
  for (const [key, entry] of resetTokens) {
    if ((normalizeUsername(entry.username) ?? entry.username) !== target) continue;
    resetTokens.delete(key);
    revoked += 1;
  }
  if (revoked > 0) persistResetTokens();
  return revoked;
}
