// TRA-2407 — WHO may receive the firm-wide demo fold in their PERSONAL calendar.
//
// TRA-1572 folded the firm-wide demo Option-Trade Journal into the per-account
// DEMO calendar so the OPERATOR books (admin, Richard) — which execute no demo
// option trades of their own and therefore rendered blank / "$0.00" cells —
// would show the firm's realized demo P&L. Its scope was never narrowed to those
// books, so the fill applied to EVERY authenticated account.
//
// TRA-1604 then ruled fleet-wide realized option P&L "firm-internal and must not
// be visible to ordinary user accounts" and gated `/api/reports/desk*` behind
// `requireAuth + requireAdmin` — but the fill served the SAME BYTES through the
// ungated `/api/reports/:date?mode=demo`. A freshly signed-up account, whose own
// book is hollow for every past day, rendered the firm's entire calendar: the
// same token was refused `/api/reports/desk` (403) and served the desk numbers.
//
// This module is the predicate that closes that side door. It is the design (a)
// from TRA-2407: SCOPE the fill to the operator books rather than delete it, so
// TRA-1572's board directive survives literally and no board-visible surface is
// renegotiated as part of a bug fix.
//
// Pure string/role predicate. Reads no secret, routes no order, touches no I/O.

/**
 * ⚠️ DO NOT reuse `classifySpreadCeilingAccount()` (TRA-2355) for this gate,
 * however strongly its `'desk'` label suggests it.
 *
 * That predicate is `isTestAccount(account) ? 'fixture' : 'desk'` — it answers
 * "is this a QA fixture book?", and every name that is NOT a known fixture
 * pattern falls through to `'desk'`. Its own tests pin this: `'aqua'` and
 * `'monitorly'` are `'desk'` (`option-spread-cost.test.ts:708-709`). Gating the
 * fill on `=== 'desk'` would therefore admit EVERY ordinary username and fix
 * nothing.
 *
 * The trap is that it would still look fixed. TRA-2407's reproduction account
 * (`ctoverify_tra2406`) is QA-classified BY DESIGN (TRA-1949, so board-facing
 * numbers exclude it) — i.e. it is drawn from the one class of account for which
 * the wrong predicate happens to return the right answer. A regression test
 * written against the reporter's own repro username would go GREEN while the
 * leak stayed open for the entire real audience. That is this repo's recurring
 * failure shape: an instrument that reads identically in the pass and fail state.
 *
 * The question here is not "is this a fixture?" but "is this an OPERATOR book?",
 * which needs an explicit allowlist — a default-deny rule, not a default-desk one.
 */
export const DEMO_CALENDAR_OPERATOR_BOOKS_ENV = 'DEMO_CALENDAR_OPERATOR_BOOKS';

/**
 * The operator books TRA-1572 was raised for, matched case-insensitively.
 *
 * `admin` is here as well as being covered by the role branch below: the role
 * branch depends on a successful user lookup, and a gate that silently opens or
 * closes on a failed lookup is the scoped-control mistake TRA-2331 records.
 *
 * ⚠️ `Richard` is an explicit NAME, not a role test. Only `admin` is ever seeded
 * with `role: 'admin'` (`users.ts:91`) and `createUser` defaults every signup to
 * `role: 'user'` (`users.ts:204`) — so unless Richard was created through
 * `POST /api/admin/users` with an explicit role, a plain `role === 'admin'` gate
 * would silently blank one of the two books this fill exists to serve. The
 * allowlist is harmless if he IS an admin (the role branch just matches first).
 */
export const BUILTIN_OPERATOR_BOOKS: readonly string[] = ['admin', 'Richard'];

/**
 * Extra operator books from the env, comma-separated. STRICTLY ADDITIVE to
 * {@link BUILTIN_OPERATOR_BOOKS}: this host has lost its whole env twice
 * (TRA-2136, TRA-2193/2195), and a wipe must not be able to blank the two books
 * the board actually looks at. It can widen the allowlist; it can never empty it.
 */
function envOperatorBooks(env: NodeJS.ProcessEnv): string[] {
  const raw = env[DEMO_CALENDAR_OPERATOR_BOOKS_ENV];
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** The full operator-book set, lowercased for comparison. */
export function operatorBookNames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set([
    ...BUILTIN_OPERATOR_BOOKS.map((s) => s.toLowerCase()),
    ...envOperatorBooks(env),
  ]);
}

/**
 * TRA-2407 — is `username` an operator book by NAME (ignoring role)?
 *
 * Case-INSENSITIVE, which is deliberate and load-bearing in both directions:
 *
 *  - Matching case-sensitively risks the regression this ticket warns about. The
 *    codebase spells the book both ways (`'Richard'` in
 *    `options-daily-pnl-source.test.ts:335`, `'richard'` in
 *    `desk-calendar.test.ts:92`), and a case mismatch against the real stored
 *    username would blank his calendar while every test still passed.
 *  - But username uniqueness IS case-sensitive (`users.ts:141`, a `===` find), so
 *    a case-insensitive allowlist alone would let someone register `RICHARD` and
 *    inherit the fill. That squat is closed at the signup gate by
 *    {@link isReservedOperatorBookName}; the two must stay paired.
 */
export function isOperatorBookName(
  username: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof username !== 'string') return false;
  const name = username.trim().toLowerCase();
  if (name.length === 0) return false;
  return operatorBookNames(env).has(name);
}

/**
 * TRA-2407 — signup guard paired with {@link isOperatorBookName}.
 *
 * Before this ticket, squatting an operator name bought nothing: the fill served
 * the firm-wide fold to everyone anyway. Scoping the fill turns that name into a
 * privilege, so the case variants that `users.ts`'s case-SENSITIVE uniqueness
 * check would happily accept (`RICHARD`, `richard` alongside `Richard`) have to
 * be refused here — otherwise this fix would introduce the very escalation it is
 * closing.
 */
export function isReservedOperatorBookName(
  username: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isOperatorBookName(username, env);
}

/**
 * TRA-2407 — MAY this account be served the firm-wide demo fold in its personal
 * DEMO calendar?
 *
 * DEFAULT DENY. Every branch that cannot positively identify an operator book —
 * absent username, absent user record, unknown role — returns `false`, so the
 * firm-internal fold is withheld. TRA-1604 already classified this data as not
 * for ordinary accounts; the cost of a false negative is a blank calendar cell
 * for one operator, and the cost of a false positive is the leak this ticket
 * exists to close.
 *
 * @param username the AUTHENTICATED account (`ctx.username`), never a journal row's `account`.
 * @param role     that user's stored role, or `undefined` when the lookup failed.
 */
export function mayViewFirmWideDemoFold(
  username: string | null | undefined,
  role: 'admin' | 'user' | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof username !== 'string' || username.trim().length === 0) return false;
  // TRA-1604 parity: anyone who would pass `requireAdmin` on `/api/reports/desk`
  // may see the same bytes here. Keeping the two tied to the same notion of
  // "admin" is what stops the front door and the side door from drifting apart
  // again — that drift is the whole of this bug.
  if (role === 'admin') return true;
  // TRA-1572's second book, by name (see BUILTIN_OPERATOR_BOOKS).
  return isOperatorBookName(username, env);
}

/**
 * TRA-2407 — the WHOLE per-date fill decision, in one testable place:
 * demo mode AND the personal book has nothing to say AND the caller is an
 * operator book.
 *
 * Composed here rather than left inline at the route because of TRA-2407's
 * acceptance criterion 3. There is no route-level test harness in this package,
 * so a predicate-only test could assert that a plain user is denied and STILL
 * pass if someone deleted the fill outright — silently reverting TRA-1572's
 * board directive. Both directions of this function are asserted in
 * `demo-calendar-fill-scope.test.ts`, so the fill FIRING for a desk book is
 * pinned by the same instrument that pins it NOT firing for everyone else. A
 * test that can only fail one way does not separate the fix from the regression.
 *
 * @param personalIsHollow result of `isHollowReportCell(personal)` at the route.
 */
export function shouldServeFirmWideDemoFold(
  mode: string,
  personalIsHollow: boolean,
  username: string | null | undefined,
  role: 'admin' | 'user' | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (mode !== 'demo') return false;
  // A day the personal book actually traded is authoritative — TRA-1572's
  // original rule, preserved verbatim. This is also TRA-2407's negative control:
  // a plain user who DID trade still gets their own cell, so the fix is a scope
  // change and not a blanking of the calendar.
  if (!personalIsHollow) return false;
  return mayViewFirmWideDemoFold(username, role, env);
}
