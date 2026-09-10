// TRA-4493 — the ONE canonical grammar in front of every account-EMAIL write.
//
// Split out of TRA-4489, which is deciding what an enrolled account with no
// email on file should be admitted as. This module is the TRIGGER for that
// state, and it is a plain defect: it is wrong under REFUSE, RESTRICT and ADMIT
// alike, so it does not wait on the ruling.
//
// ── The defect ────────────────────────────────────────────────────────────────
//
//   PATCH /api/auth/me  { email: "" }        →  200, `requireAuth`, no admin
//
// The only check was `typeof email !== 'string'`. `""` passed. `"not-an-address"`
// passed. `updateUser` (`users.ts:190-192`) writes the value through verbatim.
// Measured end-to-end by `scripts/tra4489-2fa-lockout-drill.mjs` steps 05-07:
//
//   1. a 2FA-enrolled user blanks its OWN address — 200, its own session;
//   2. 2FA stays `enabled: true` with 10 backup codes. Nothing re-checks the
//      address the second factor depends on, and nothing disables 2FA when it
//      goes away;
//   3. the next login mints a FULL session from the password alone.
//
// The risk is PERSISTENCE: an attacker holding one session strips the second
// factor for every FUTURE login, outliving the compromise 2FA existed to
// contain. The quieter half is a malformed-but-non-empty address (`"nope"`) —
// 2FA stays on, the account keeps an address, and every emailed OTP goes
// nowhere, which nothing anywhere reports.
//
// ── Why a module, and not a third inline `if` ─────────────────────────────────
//
// The codebase already knew the rule. `POST /api/auth/account/email` validated
// `!email.includes('@') || !email.trim()`; `POST /api/auth/signup` validated
// `!email.includes('@')` and then stored `email.trim()`; `enableTwoFactor`
// hard-requires `email.includes('@')` before it will enrol anyone. Three
// spellings of one rule, and the two routes that had NO spelling of it are the
// two this ticket is about. That is the same shape as TRA-4475 — the fix is to
// decide once, in front of every writer, rather than to add a fourth copy.
//
// ── WRITE PATH ONLY. This is the same split `username-grammar.ts` documents ───
//
// `acceptEmail` runs on WRITES: signup, admin create, `POST /account/email`,
// `PATCH /api/auth/me`, `PATCH /api/admin/users/:username`. It is deliberately
// NOT on the login path, NOT on `getUserByEmail`, and NOT inside
// `enableTwoFactor`'s check of an ALREADY-STORED address — a legacy row that
// fails a newly-tightened grammar must stay able to log in and stay able to
// enrol. Tightening a read is how a grammar becomes a lockout.
//
// ⚠️ That split is also why `auditTwoFactorEmailIntegrity` below only REPORTS.
// Validation on the write does not repair a row that was already blanked, and
// what to DO about such a row at login time is TRA-4489's ruling, not this
// ticket's. Detecting them is what this ticket can honestly own.

/**
 * The canonical account-email grammar.
 *
 * Local part: 1..64 chars, no whitespace and no `@`. Deliberately permissive —
 * RFC 5321 allows a great deal in there and refusing a real address is a worse
 * failure than accepting an ugly one.
 *
 * Domain: at least one dot-separated label plus an alphabetic TLD of 2..63.
 * Labels are alphanumeric with interior hyphens only. This is the half that
 * actually does the work: it is what refuses `nope`, `admin@localhost` and
 * `a@b` — addresses that no OTP will ever reach.
 */
export const EMAIL_PATTERN =
  /^[^\s@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

/** RFC 5321 §4.5.3.1.3 caps a path at 256 octets including the angle brackets. */
export const EMAIL_MAX_LENGTH = 254;

export type EmailRefusalCode =
  | 'not_a_string'
  | 'blank'
  | 'blank_would_disarm_two_factor'
  | 'too_long'
  | 'shape';

export interface EmailRefusal {
  status: number;
  code: EmailRefusalCode;
  /** Stated to the caller. Describes the RULE, never the input. */
  message: string;
  /** For the server log only. */
  detail: string;
}

export type EmailDecision =
  | { ok: true; email: string }
  | { ok: false; refusal: EmailRefusal };

const SHAPE_MESSAGE = 'A valid email address is required';

/**
 * Decide whether a string may be WRITTEN as an account's email address.
 *
 * `twoFactorEnabled` is the narrower, more targeted half of the fix (the
 * ticket's item 3): blanking an address on an account with no second factor is
 * an ordinary edit, and blanking it on an ENROLLED account is the reported bug.
 * Both are refused, but they are refused with different codes and different
 * statuses, because "your input is malformed" and "this would disarm your second
 * factor" are different facts and the second one is the one a user needs told.
 *
 * @returns the TRIMMED address on acceptance. Callers must store THIS value and
 *   not the raw body field — the string that was validated has to be the string
 *   that is stored, or the two drift and the gap re-opens with the guard still
 *   in place. (`username-grammar.ts` carries the same warning for the same
 *   reason; `email-grammar.test.ts` asserts it per route.)
 */
export function acceptEmail(input: { email: unknown; twoFactorEnabled?: boolean }): EmailDecision {
  const { email, twoFactorEnabled = false } = input;

  if (typeof email !== 'string') {
    return {
      ok: false,
      refusal: {
        status: 400,
        code: 'not_a_string',
        message: 'An email address is required',
        detail: `email was ${email === null ? 'null' : typeof email}`,
      },
    };
  }

  const trimmed = email.trim();

  // Ordered ahead of the generic blank refusal on purpose: a 2FA-enrolled user
  // clearing their address gets told what it would have DONE, not that their
  // empty string failed a format check.
  if (trimmed === '' && twoFactorEnabled) {
    return {
      ok: false,
      refusal: {
        status: 409,
        code: 'blank_would_disarm_two_factor',
        message:
          'This account uses email two-factor authentication, so its address cannot be removed. ' +
          'Change it to a working address, or turn off two-factor first.',
        detail: 'blank email refused: twoFactor.enabled',
      },
    };
  }

  if (trimmed === '') {
    return {
      ok: false,
      refusal: { status: 400, code: 'blank', message: SHAPE_MESSAGE, detail: 'email was blank after trim' },
    };
  }

  if (trimmed.length > EMAIL_MAX_LENGTH) {
    return {
      ok: false,
      refusal: {
        status: 400,
        code: 'too_long',
        message: `An email address may be at most ${EMAIL_MAX_LENGTH} characters`,
        detail: `email length ${trimmed.length}`,
      },
    };
  }

  if (!EMAIL_PATTERN.test(trimmed)) {
    return {
      ok: false,
      refusal: { status: 400, code: 'shape', message: SHAPE_MESSAGE, detail: 'email failed EMAIL_PATTERN' },
    };
  }

  return { ok: true, email: trimmed };
}

/** True iff `value` is storable as an account address. Convenience over `acceptEmail`. */
export function matchesEmailGrammar(value: unknown): boolean {
  return acceptEmail({ email: value }).ok;
}

// ── The already-blanked rows (the ticket's item 2) ────────────────────────────

/** The minimum a caller must supply per account for the integrity audit. */
export interface TwoFactorEmailRow {
  username: string;
  email: unknown;
  twoFactorEnabled: boolean;
  backupCodesRemaining: number;
}

export interface DegradedTwoFactorAccount {
  username: string;
  /** `blank` — the fail-open trigger. `shape` — OTPs go nowhere, 2FA still bites. */
  reason: 'blank' | 'shape';
  backupCodesRemaining: number;
  /**
   * The corner the drill found (`docs/tra4489-2fa-lockout-drill.md`): recovery
   * via `login-code` → `2fa/verify` + a backup code needs no address, so it
   * holds iff codes remain. `backupCodesRemaining === 0` is the row with no way
   * back in under REFUSE.
   */
  recoverableByBackupCode: boolean;
}

export interface TwoFactorEmailAudit {
  scanned: number;
  enrolled: number;
  degraded: DegradedTwoFactorAccount[];
}

/**
 * Report every account whose second factor depends on an address it cannot use.
 *
 * ⚠️ It REPORTS. It does not repair, it does not disable 2FA, and it does not
 * change what any login does — that is TRA-4489's ruling. Deliberately pure and
 * total: `scanned` and `enrolled` are emitted even when `degraded` is empty, so
 * a zero is READABLE as a zero. An absent count is a reconcile that did not run,
 * which is a different fact, and the two must never share a rendering.
 */
export function auditTwoFactorEmailIntegrity(roster: readonly TwoFactorEmailRow[]): TwoFactorEmailAudit {
  const degraded: DegradedTwoFactorAccount[] = [];
  let enrolled = 0;
  for (const row of roster) {
    if (!row.twoFactorEnabled) continue;
    enrolled += 1;
    // `twoFactorEnabled: false` here on purpose: this is a CLASSIFIER over
    // stored rows, not a write. Passing `true` would relabel every blank row
    // `blank_would_disarm_two_factor`, which is a claim about a write that is
    // not happening.
    const decision = acceptEmail({ email: row.email });
    if (decision.ok) continue;
    const blank = typeof row.email !== 'string' || row.email.trim() === '';
    degraded.push({
      username: row.username,
      reason: blank ? 'blank' : 'shape',
      backupCodesRemaining: row.backupCodesRemaining,
      recoverableByBackupCode: row.backupCodesRemaining > 0,
    });
  }
  return { scanned: roster.length, enrolled, degraded };
}
