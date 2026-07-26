// TRA-2315 — the ONE definition of "is this AUTH_SECRET value usable?", shared by
// every guard that grades the secret from outside the process.
//
// WHY THIS EXISTS AS A MODULE RATHER THAN AN INLINE `if`
//
// The server decides at boot, in `resolveAuthSecret()` (packages/server/src/auth.ts):
//
//     if (fromEnv && fromEnv.trim().length > 0) return fromEnv;   // usable
//     if (NODE_ENV === 'production') throw ...                    // refuse to boot
//     log.warn('ephemeral random secret'); return randomBytes(32) // dev fallback
//
// Any guard that answers the same question with a DIFFERENT expression is not a
// guard — it is a second opinion that can disagree with the only vote that counts.
// `tra2296-auth-secret-check.mjs` originally tested `(value ?? '').length === 0`,
// which is strictly weaker: `AUTH_SECRET=" "` has length 1, so the guard reported
// PASS on a value that makes production refuse to boot. The bug was invisible
// because both predicates agree on every value anyone types on purpose; they part
// company only on the accidental ones — a value cleared to a space in a dashboard
// field, a trailing newline from a shell heredoc — which is exactly the population
// a pre-deploy guard exists to catch.
//
// ⛔ IF `resolveAuthSecret` EVER CHANGES HOW IT NORMALISES THE VALUE, CHANGE THIS
// FILE IN THE SAME COMMIT. The test suite next door pins the two together; it will
// not notice the drift on its own, because it only knows what auth.ts said today.

/** Exactly `resolveAuthSecret`'s acceptance test, for a value read out-of-process. */
export function authSecretUsable(raw) {
  return typeof raw === 'string' && raw.trim().length > 0;
}

/**
 * Why a value is unusable, for an operator-facing message.
 *
 * Distinguishes ABSENT / EMPTY / WHITESPACE_ONLY rather than collapsing them,
 * because the three have different causes and different fixes, and the whole
 * point of TRA-2315 is that the third one used to be reported as healthy.
 *
 * @param raw the env var's value, or `null`/`undefined` when the key is absent
 * @returns {{usable: boolean, shape: 'ABSENT'|'EMPTY'|'WHITESPACE_ONLY'|'SET',
 *            rawLength: number, usableLength: number, detail: string}}
 */
export function classifyAuthSecret(raw) {
  if (raw === null || raw === undefined) {
    return {
      usable: false,
      shape: 'ABSENT',
      rawLength: -1,
      usableLength: -1,
      detail: 'absent',
    };
  }
  const rawLength = raw.length;
  const usableLength = raw.trim().length;
  if (rawLength === 0) {
    return { usable: false, shape: 'EMPTY', rawLength, usableLength, detail: 'present but EMPTY' };
  }
  if (usableLength === 0) {
    return {
      usable: false,
      shape: 'WHITESPACE_ONLY',
      rawLength,
      usableLength,
      detail: `present but WHITESPACE-ONLY (${rawLength} chars, all blank)`,
    };
  }
  return {
    usable: true,
    shape: 'SET',
    rawLength,
    usableLength,
    detail: `present, length ${rawLength}`,
  };
}

/**
 * The predicate this module REPLACES, kept only so the test suite can assert it
 * still gets the whitespace case wrong.
 *
 * A suite that passes against the fix and would also pass against the bug has
 * verified nothing. Do not call this from production code.
 */
export function legacyNonEmptyPredicate_DO_NOT_USE(raw) {
  if (raw === null || raw === undefined) return false;
  return (raw ?? '').length !== 0;
}
