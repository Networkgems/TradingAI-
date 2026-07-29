// TRA-2508 — the ONE precondition every route that writes an account NAME runs.
//
// TRA-2407 reserved the operator book names at signup, because the demo-calendar
// fill scope matches them case-INSENSITIVELY while `users.ts` uniqueness is
// case-SENSITIVE (`users.ts:141`, a `===` find). Without a reserve guard,
// `RICHARD` registers as a book distinct from `admin`/`Richard` and inherits the
// firm-wide demo fold — the exact side door TRA-2407 was raised to close.
// `demo-calendar-fill-scope.ts` says it in the imperative: "The two rules are a
// pair; do not relax one alone."
//
// The guard was called from `POST /api/auth/signup` and nowhere else. The two
// admin identity-writes skipped it, so both of these still worked on `4df4e41`:
//
//   POST  /api/admin/users        {username:'RICHARD'}        -> 201, then the
//         firm fold on `GET /api/reports/<date>?mode=demo` while
//         `GET /api/reports/desk` 403s the same token.
//   PATCH /api/admin/users/plain  {newUsername:'Richard'}     -> 200, and a book
//         that 404'd on a seeded firm day serves the firm's numbers on a RENAME
//         ALONE. Its role never changed.
//
// Hence a module rather than a third inline `if`. `packages/server` has no
// route-level test harness (see the note in `reports/demo-calendar-fill-scope.ts`),
// so a rule left inline in `index.ts` is asserted by nothing — which is how two
// of the three sites came to miss it in the first place. `identity-write-guard.test.ts`
// pins the DECISION here and pins the WIRING by scanning `index.ts`, so the next
// identity-write route (TRA-2421's self-serve delete already made a fourth) fails
// a test instead of silently opening the door again.

import { isReservedOperatorBookName } from './reports/demo-calendar-fill-scope.js';

/** Why an identity write was refused, or `null` when it may proceed. */
export interface IdentityWriteRefusal {
  code: 'reserved_operator_book';
  status: 409;
  message: string;
}

export interface IdentityWriteGuardArgs {
  /** The name being written: a signup username, or a `newUsername` on a rename. */
  name: string | null | undefined;
  /**
   * WHO is asking. `'public'` is the anonymous signup route; `'admin'` is behind
   * `requireAuth + requireAdmin`.
   *
   * This is not decoration. It is what makes {@link IdentityWriteGuardArgs.provisionOperatorBook}
   * unreachable from an anonymous request body — see below.
   */
  audience: 'public' | 'admin';
  /**
   * The deliberate carve-out: an admin restoring or provisioning an operator book
   * on purpose (TRA-142 leaves a deleted user's files on disk precisely so the
   * name can be re-created).
   *
   * ⚠️ HONOURED ONLY FOR `audience: 'admin'`. Signup's body is attacker-controlled,
   * so if this were audience-blind, `POST /api/auth/signup {username:'RICHARD',
   * provisionOperatorBook:true}` would re-open the escalation the moment anyone
   * spread `req.body` into this call. The check costs one `&&`; the failure it
   * prevents is total.
   *
   * ⚠️ It is NOT `role: 'admin'`, which TRA-2508 suggested as an example. Only
   * `admin` is ever seeded with `role: 'admin'` (`users.ts:91`) and `createUser`
   * defaults to `role: 'user'` (`users.ts:204`) — `Richard` is an operator book by
   * NAME, not by role (`demo-calendar-fill-scope.ts:BUILTIN_OPERATOR_BOOKS`).
   * Requiring `role: 'admin'` to restore him would grant real admin to a book that
   * never had it, quietly widening `/api/reports/desk` and every other
   * `requireAdmin` route to buy back one calendar.
   */
  provisionOperatorBook?: boolean;
  /** Injected in tests; the operator allowlist is env-extensible. */
  env?: NodeJS.ProcessEnv;
}

/**
 * TRA-2508 — may this route write this account name?
 *
 * Returns `null` for a name it has no opinion about — including a missing or
 * blank one. Shape validation is the ROUTE's 400 and stays there; a guard that
 * also policed shape would have two callers disagreeing about which status a
 * blank username earns.
 */
export function refuseReservedIdentityWrite(
  args: IdentityWriteGuardArgs,
): IdentityWriteRefusal | null {
  if (typeof args.name !== 'string') return null;
  const name = args.name.trim();
  if (name.length === 0) return null;
  if (!isReservedOperatorBookName(name, args.env ?? process.env)) return null;
  // The carve-out, and the reason `audience` exists.
  if (args.audience === 'admin' && args.provisionOperatorBook === true) return null;
  return {
    code: 'reserved_operator_book',
    status: 409,
    message:
      args.audience === 'admin'
        ? `"${name}" is reserved for an operator book (TRA-2407). Pass provisionOperatorBook: true to provision it deliberately.`
        : // Unchanged from the signup wording TRA-2407 shipped: an anonymous
          // caller learns only that the name is taken, not that a privileged
          // class of names exists to enumerate.
          'Username is not available',
  };
}
