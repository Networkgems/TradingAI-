// TRA-4475 — the ONE canonical grammar in front of every account-name write.
//
// External audit C1. Reachable from an anonymous `POST /api/auth/signup` on the
// build live on bqb1 when the audit was written:
//
//   POST /api/auth/signup {username:'../users/richard', email:…, password:…}
//
//   1. `index.ts` accepted any non-blank string. No grammar, no separator
//      rejection, no dot-segment rejection.
//   2. `refuseReservedIdentityWrite` (TRA-2508) resolves through
//      `isReservedOperatorBookName` -> `isOperatorBookName`, which is EXACT SET
//      MEMBERSHIP on the lower-cased name. `richard` is refused; the traversal
//      SPELLING of the same book is not — it walks straight past the guard that
//      exists to protect that exact book.
//   3. `getUser('../users/richard')` misses (the registry is exact-match), so the
//      name reads FREE — which is the branch that arms step 4.
//   4. `retireOrphanedBook('../users/richard')` -> `userDirIn` =
//      `join(DATA_DIR,'users','../users/richard')` = `DATA_DIR/users/richard`,
//      the LIVE book. `primaryDirExisted` is true, so `orphanFound` is true.
//   5. The retirement `rename()`s that directory away, with a `cp -r` + `rm -rf`
//      fallback across a device boundary.
//
// No session, no credential, no trading flag. The books survive under another
// name, so this displaces rather than deletes — but the engine is left holding
// in-memory state whose files vanished, and broker positions whose local lots,
// journal and basis are detached. On the real-money box that is an availability
// AND an evidence-integrity event.
//
// ── Why a grammar, and not another guard in the chain ─────────────────────────
//
// The area is already WELL defended: TRA-2407 / 2410 / 2508 / 2511 / 2513 / 2520
// / 2535 hardened the recycled-name channel across four separate stores. Every
// one of those guards is keyed on the name as a STRING and is correct for the
// names it was written against. What was missing is that nothing ever decided
// which strings are names at all, so each guard independently had to be right
// about a string it had no reason to expect. This module makes that decision
// once, ahead of all of them.
//
// ⚠️ ORDER IS THE WHOLE FIX. A grammar behind `retireOrphanedBook` is useless:
// the destructive step has already run by the time the 400 is written. See the
// ordering assertions in `username-grammar.test.ts`.
//
// ── Two predicates, deliberately different widths ─────────────────────────────
//
// `acceptUsername` — the full grammar. Enforced on WRITES ONLY (signup, admin
//   create, admin rename). It is NOT on the login path and must never be: a
//   legacy name that fails a newly-tightened grammar would lock a real user out
//   of a real book. (Measured against bqb1 on 2026-09-09 before enforcing: all
//   67 live usernames pass, 0 case collisions, 0 non-NFC. So today the set of
//   locked-out legacy names is empty — but the split is what keeps it empty the
//   next time the grammar tightens.)
//
// `assertContainedUserDir` — the narrow structural backstop, wired into the path
//   BUILDERS themselves (`orphaned-books.ts:userDirIn`,
//   `user-context.ts:userDataDir`). It refuses only path-hazardous strings, so
//   it is safe to run against a legacy name that would fail the grammar. This is
//   the layer that makes step 4 above structurally impossible rather than merely
//   unreached: it resolves the join and refuses anything that lands outside the
//   users root, which is a claim about the RESULT and therefore cannot be spelled
//   around (`..`, `%2e%2e` once Express has decoded it, `....//`, a UNC prefix, a
//   drive letter, a symlink-free absolute path — all of them resolve out and all
//   of them are caught by the same check).

import { isAbsolute, join, resolve, sep } from 'path';

/**
 * The canonical account-name grammar.
 *
 * Leading character is alphanumeric — a name may not START with `.`, `-` or `_`,
 * which is what keeps `.`/`..`/`.hidden` out by construction as well as by the
 * dot-segment rule below. Length is 3..32 inclusive (1 + {2,31}).
 */
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/**
 * Stated to the caller on a shape refusal. Deliberately describes the RULE and
 * not the input: it is not an enumeration oracle (it says nothing about which
 * names exist), and echoing an attacker-controlled string back into a JSON error
 * body is a habit worth not having.
 */
export const USERNAME_RULE_MESSAGE =
  `Usernames must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters, start with a letter or digit, ` +
  'and use only letters, digits, dots, underscores and hyphens.';

export type UsernameRefusalCode =
  | 'username_missing'
  | 'username_bad_shape'
  | 'username_case_collision';

export interface UsernameRefusal {
  code: UsernameRefusalCode;
  status: 400 | 409;
  /** Safe to put on the wire. */
  message: string;
  /** For the server log only. May quote the input; never sent to the client. */
  detail: string;
}

export type UsernameDecision =
  | { ok: true; username: string }
  | { ok: false; refusal: UsernameRefusal };

export interface AcceptUsernameArgs {
  name: unknown;
  /**
   * WHO is asking, on the same terms as `refuseReservedIdentityWrite`. It
   * changes only the WORDING of a collision refusal — an anonymous caller is
   * told the name is unavailable, an admin is told why.
   */
  audience: 'public' | 'admin';
  /**
   * The existing credential-store names, for the case-collision rule. Optional:
   * a caller that has no registry to compare against (a rename validating shape
   * only) may omit it, and the collision rule is then simply not applied.
   */
  existingUsernames?: readonly string[];
  /**
   * When renaming, the name being renamed FROM. It is excluded from the
   * collision check so that a no-op or case-only self-rename is not refused
   * against itself.
   */
  renamingFrom?: string;
}

/**
 * NFC-normalize and trim, or `null` for anything that is not a usable string.
 *
 * ⚠️ NFC, NOT NFKC. NFKC maps compatibility characters onto ASCII — U+FF0F
 * FULLWIDTH SOLIDUS becomes a real `/` — so an NFKC pass applied AFTER
 * validation would manufacture a separator inside an already-approved name.
 * NFC never introduces `/`, `\` or `.`, and every caller here normalizes BEFORE
 * validating and then uses the normalized value downstream, so the string that
 * was checked is byte-identical to the string that is stored and joined.
 */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.normalize('NFC').trim();
  return normalized.length === 0 ? null : normalized;
}

/** Does this name satisfy the canonical grammar? Operates on a normalized name. */
export function matchesUsernameGrammar(normalized: string): boolean {
  return USERNAME_PATTERN.test(normalized);
}

/**
 * TRA-4475 — the write-path decision.
 *
 * Returns the CANONICAL name on success, and callers must use it: everything
 * downstream (the registry row, the tombstone, the SQLite keys, the directory
 * name) has to be keyed on the exact string that was validated, or a future
 * difference between "checked" and "stored" re-opens the gap this closes. That
 * is why this returns a union rather than a nullable refusal — there is no way
 * to consult it and then keep using the raw input by accident.
 */
export function acceptUsername(args: AcceptUsernameArgs): UsernameDecision {
  const normalized = normalizeUsername(args.name);
  if (normalized === null) {
    return {
      ok: false,
      refusal: {
        code: 'username_missing',
        status: 400,
        message: 'Username is required',
        detail: `username missing or blank (typeof ${typeof args.name})`,
      },
    };
  }
  if (!matchesUsernameGrammar(normalized)) {
    return {
      ok: false,
      refusal: {
        code: 'username_bad_shape',
        status: 400,
        message: USERNAME_RULE_MESSAGE,
        detail: `username failed the grammar: ${JSON.stringify(normalized)}`,
      },
    };
  }
  // Paranoia, and cheap: the grammar is ASCII-only so NFC is a fixed point on
  // anything that got here. Asserting it means the "validated string == stored
  // string" invariant above is CHECKED rather than reasoned about.
  /* c8 ignore next 12 */
  if (normalized.normalize('NFC') !== normalized) {
    return {
      ok: false,
      refusal: {
        code: 'username_bad_shape',
        status: 400,
        message: USERNAME_RULE_MESSAGE,
        detail: 'username is not NFC-stable after validation',
      },
    };
  }

  // The case-collision rule. `users.ts` enforces uniqueness with a
  // case-SENSITIVE `===` (`getUser` is a `u.username === username` find), so
  // without this `Enock` and `enock` are two credential rows — two accounts, two
  // directories, and a per-user store keyed by the raw string that a
  // case-insensitive reader elsewhere folds back into one. TRA-2407 already had
  // to special-case exactly this for the operator books; this generalises it.
  if (args.existingUsernames) {
    const foldedFrom = args.renamingFrom?.normalize('NFC').toLowerCase();
    const folded = normalized.toLowerCase();
    const clash = args.existingUsernames.find((existing) => {
      const e = existing.normalize('NFC').toLowerCase();
      if (foldedFrom !== undefined && e === foldedFrom) return false;
      return e === folded;
    });
    if (clash !== undefined) {
      return {
        ok: false,
        refusal: {
          code: 'username_case_collision',
          status: 409,
          message:
            args.audience === 'admin'
              ? `"${normalized}" collides with the existing account "${clash}" (names are compared case-insensitively).`
              : // Same wording TRA-2407 shipped at signup: an anonymous caller
                // learns only that the name is unavailable.
                'Username is not available',
          detail: `case-insensitive collision: ${JSON.stringify(normalized)} vs ${JSON.stringify(clash)}`,
        },
      };
    }
  }

  return { ok: true, username: normalized };
}

// ── The structural backstop ───────────────────────────────────────────────────

export class UnsafeUsernamePathError extends Error {
  readonly username: string;
  readonly usersRoot: string;
  constructor(username: string, usersRoot: string, reason: string) {
    super(`TRA-4475 refusing an unsafe user path (${reason}): username=${JSON.stringify(username)}`);
    this.name = 'UnsafeUsernamePathError';
    this.username = username;
    this.usersRoot = usersRoot;
  }
}

/**
 * Is this name safe to use as ONE path segment?
 *
 * Narrower than the grammar on purpose — it says nothing about length, leading
 * characters or the allowed alphabet, so it is safe to run against a LEGACY name
 * that predates the grammar. It rejects exactly the things that stop a name from
 * being a single segment.
 */
export function isPathSafeUsername(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const n = name.normalize('NFC');
  if (n.length === 0 || n.trim().length !== n.length) return false;
  if (n === '.' || n === '..') return false;
  if (n.includes('/') || n.includes('\\')) return false;
  if (n.includes('\0')) return false;
  // A drive-relative or drive-absolute spelling on Windows (`C:`, `C:foo`), and
  // an alternate data stream while we are here.
  if (n.includes(':')) return false;
  if (isAbsolute(n)) return false;
  return true;
}

/**
 * TRA-4475 — the ONE place a username becomes a directory path.
 *
 * Wired into `orphaned-books.ts:userDirIn` and `user-context.ts:userDataDir`, so
 * the traversal is refused at the JOIN rather than at some caller that
 * remembered to check. Two layers, in this order:
 *
 *  1. the segment predicate above (cheap, and names the reason precisely), then
 *  2. resolve the join and require the result to be strictly INSIDE the users
 *     root. This is a claim about the RESULT, so it holds for spellings nobody
 *     enumerated — that is the point of checking it here and not in the router.
 *
 * Throws rather than returning a sentinel: every caller of these builders wants
 * a path, and a sentinel would be `join`ed by somebody. A throw on this path is
 * unreachable from a well-formed request (the routes refuse the shape first) and
 * fails the request closed if it ever is reached.
 */
export function assertContainedUserDir(root: string, username: string): string {
  const usersRoot = join(root, 'users');
  if (!isPathSafeUsername(username)) {
    throw new UnsafeUsernamePathError(username, usersRoot, 'not a single safe path segment');
  }
  const candidate = join(usersRoot, username.normalize('NFC'));
  const resolvedRoot = resolve(usersRoot);
  const resolvedCandidate = resolve(candidate);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (!resolvedCandidate.startsWith(prefix) || resolvedCandidate === resolvedRoot) {
    throw new UnsafeUsernamePathError(username, usersRoot, 'resolves outside the users root');
  }
  return candidate;
}
