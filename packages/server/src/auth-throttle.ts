// TRA-404 / C2 — brute-force protection for the auth endpoints.
//
// An in-memory, per-key failed-attempt tracker. The first N failures are
// "free" (no penalty — covers honest typos); after that each further failure
// applies an exponentially growing backoff window, and once a hard threshold
// is crossed the key is locked out for a long fixed window.
//
// Deliberately in-process (a Map): the server is a single Render instance
// (see review-report §5), so a shared store would be over-engineering. State
// is lost on restart, which is acceptable — a restart is itself rate-limiting
// and the lockout windows are short relative to deploy cadence.
//
// `checkThrottle` / `recordFailure` take an explicit `now` for deterministic
// tests; production callers omit it and get `Date.now()`.

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Failures allowed with no penalty (honest typos). */
const FREE_ATTEMPTS = numEnv('AUTH_THROTTLE_FREE_ATTEMPTS', 5);
/** Backoff after the free attempts: BASE * 2^(n) capped at MAX. */
const BASE_BACKOFF_MS = numEnv('AUTH_THROTTLE_BASE_BACKOFF_SEC', 2) * 1000;
const MAX_BACKOFF_MS = numEnv('AUTH_THROTTLE_MAX_BACKOFF_SEC', 900) * 1000;
/** Failure count that trips the hard lockout. */
const LOCKOUT_AFTER = numEnv('AUTH_THROTTLE_LOCKOUT_AFTER', 12);
const LOCKOUT_MS = numEnv('AUTH_THROTTLE_LOCKOUT_MIN', 60) * 60 * 1000;
/** Idle buckets older than this are pruned so the Map can't grow unbounded. */
const IDLE_TTL_MS = 2 * 60 * 60 * 1000;

interface Bucket {
  fails: number;
  blockedUntil: number;
  lastSeen: number;
}

const buckets = new Map<string, Bucket>();

export interface ThrottleDecision {
  /** True when the caller should be rejected right now. */
  blocked: boolean;
  /** Seconds until the caller may retry (0 when not blocked). */
  retryAfterSec: number;
}

function prune(now: number): void {
  for (const [key, b] of buckets) {
    if (now - b.lastSeen > IDLE_TTL_MS && b.blockedUntil <= now) buckets.delete(key);
  }
}

/**
 * Is `key` currently throttled? Call this before doing the expensive auth work
 * (credential check, token lookup, email send).
 */
export function checkThrottle(key: string, now: number = Date.now()): ThrottleDecision {
  prune(now);
  const b = buckets.get(key);
  if (!b || b.blockedUntil <= now) return { blocked: false, retryAfterSec: 0 };
  return { blocked: true, retryAfterSec: Math.ceil((b.blockedUntil - now) / 1000) };
}

/**
 * Record a failed attempt for `key` and return the resulting decision (so the
 * caller can surface `Retry-After` immediately on the failure response).
 */
export function recordFailure(key: string, now: number = Date.now()): ThrottleDecision {
  const b = buckets.get(key) ?? { fails: 0, blockedUntil: 0, lastSeen: now };
  b.fails += 1;
  b.lastSeen = now;

  if (b.fails >= LOCKOUT_AFTER) {
    b.blockedUntil = now + LOCKOUT_MS;
  } else if (b.fails > FREE_ATTEMPTS) {
    const steps = b.fails - FREE_ATTEMPTS - 1; // 0 on the first penalised failure
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** steps, MAX_BACKOFF_MS);
    b.blockedUntil = now + backoff;
  }
  buckets.set(key, b);

  return b.blockedUntil > now
    ? { blocked: true, retryAfterSec: Math.ceil((b.blockedUntil - now) / 1000) }
    : { blocked: false, retryAfterSec: 0 };
}

/** Clear a key's failure history after a successful auth. */
export function recordSuccess(key: string): void {
  buckets.delete(key);
}

/** Test-only: wipe all throttle state. */
export function resetThrottle(): void {
  buckets.clear();
}
