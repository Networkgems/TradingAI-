import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { refuseReservedIdentityWrite } from './identity-write-guard.js';
import {
  mayViewFirmWideDemoFold,
  isOperatorBookName,
  DEMO_CALENDAR_OPERATOR_BOOKS_ENV,
} from './reports/demo-calendar-fill-scope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// TRA-2508 — TRA-2407's reserve guard was wired to `POST /api/auth/signup` and
// nowhere else. Reproduced over real HTTP on `4df4e41`, the commit live on bqb1
// when the ticket was filed:
//
//   P1  POST /api/admin/users {username:'RICHARD'}            -> 201
//       that book GET /api/reports/2026-07-01?mode=demo       -> 200  $75.25 / 2
//       that book GET /api/reports/desk                       -> 403
//
//   P2  plain_xxx GET /api/reports/2026-07-01?mode=demo       -> 404
//       PATCH /api/admin/users/plain_xxx {newUsername:'Richard'} -> 200
//       same book, same request, after the rename             -> 200  $75.25 / 2
//
// P2 is the sharper half: one book flips 404 -> the firm's numbers on a RENAME
// ALONE, role untouched, so `/api/reports/desk` keeps 403ing it. That is exactly
// the front-door-403 / side-door-200 asymmetry TRA-2407 was raised to close,
// still reachable through an admin route.
//
// ⚠️ Two kinds of test live here and they are NOT interchangeable. The DECISION
// block below would pass on the broken build the day `identity-write-guard.ts`
// was added, because a predicate nobody calls answers correctly. The WIRING block
// is the one that fails on `4df4e41` — it is the only part that can tell a routed
// guard from an unrouted one, and an unrouted guard was the entire bug.

describe('TRA-2508 — refuseReservedIdentityWrite (the decision)', () => {
  const env = (extra?: string): NodeJS.ProcessEnv =>
    extra === undefined ? {} : { [DEMO_CALENDAR_OPERATOR_BOOKS_ENV]: extra };

  it('refuses the case variants `users.ts` case-SENSITIVE uniqueness would accept', () => {
    // The whole reason the pair exists: the fill scope matches case-insensitively,
    // uniqueness compares with `===`, so every one of these is a distinct row in
    // the credential store that lands inside the fold.
    for (const squat of ['RICHARD', 'richard', 'RiChArD', 'ADMIN', 'Admin', ' Richard ']) {
      expect(refuseReservedIdentityWrite({ name: squat, audience: 'admin', env: env() }), squat)
        .toMatchObject({ code: 'reserved_operator_book', status: 409 });
    }
  });

  it('P1 — POST /api/admin/users {username:"RICHARD"} is refused without an explicit carve-out', () => {
    expect(refuseReservedIdentityWrite({ name: 'RICHARD', audience: 'admin', env: env() }))
      .toMatchObject({ status: 409 });
  });

  it('P2 — PATCH {newUsername:"Richard"} is refused; a rename cannot buy the fold', () => {
    expect(refuseReservedIdentityWrite({ name: 'Richard', audience: 'admin', env: env() }))
      .toMatchObject({ status: 409 });
  });

  it('leaves ordinary names alone, including the substring near-miss', () => {
    for (const ok of ['bob', 'richardson', 'admin_2', 'plain_xxx', 'Richardson']) {
      expect(refuseReservedIdentityWrite({ name: ok, audience: 'admin', env: env() }), ok).toBeNull();
      expect(refuseReservedIdentityWrite({ name: ok, audience: 'public', env: env() }), ok).toBeNull();
    }
  });

  it('honours the admin carve-out (TRA-142 restore) only for the admin audience', () => {
    expect(
      refuseReservedIdentityWrite({
        name: 'Richard', audience: 'admin', provisionOperatorBook: true, env: env(),
      }),
    ).toBeNull();
  });

  it('⚠️ the carve-out is UNREACHABLE from the anonymous signup body', () => {
    // If `audience` were dropped, `POST /api/auth/signup {username:'RICHARD',
    // provisionOperatorBook:true}` re-opens the exact escalation TRA-2407 closed.
    // This is the assertion that keeps the flag from becoming a public bypass.
    expect(
      refuseReservedIdentityWrite({
        name: 'RICHARD', audience: 'public', provisionOperatorBook: true, env: env(),
      }),
    ).toMatchObject({ status: 409 });
  });

  it('does not leak the existence of a reserved class to an anonymous caller', () => {
    const pub = refuseReservedIdentityWrite({ name: 'RICHARD', audience: 'public', env: env() });
    // Unchanged from the wording TRA-2407 shipped at signup.
    expect(pub?.message).toBe('Username is not available');
    const adm = refuseReservedIdentityWrite({ name: 'RICHARD', audience: 'admin', env: env() });
    expect(adm?.message).toContain('provisionOperatorBook');
  });

  it('covers env-added operator books, so a widened allowlist widens the reserve too', () => {
    expect(refuseReservedIdentityWrite({ name: 'DESKOPS', audience: 'admin', env: env('deskops') }))
      .toMatchObject({ status: 409 });
    // …and the builtins survive an env that names neither of them (the host has
    // lost its whole env twice — TRA-2136, TRA-2193/2195).
    expect(refuseReservedIdentityWrite({ name: 'RICHARD', audience: 'admin', env: env('deskops') }))
      .toMatchObject({ status: 409 });
  });

  it('has no opinion on shape — a blank or missing name is the route`s 400, not a 409', () => {
    for (const bad of [undefined, null, '', '   ']) {
      expect(refuseReservedIdentityWrite({ name: bad, audience: 'admin', env: env() }), String(bad))
        .toBeNull();
    }
  });
});

describe('TRA-2508 — the negative control TRA-2407 warns about', () => {
  // "admin and the real Richard must still receive the fold afterwards, or the
  // fix has re-broken TRA-1572 in the direction TRA-2407 deliberately avoided."
  //
  // Reserving a NAME must not narrow who may VIEW the fold. These two predicates
  // are the read side and this guard is the write side; if a future edit tries to
  // share one list between them, this is what notices.
  it('the fold predicate is untouched by the reserve guard', () => {
    expect(mayViewFirmWideDemoFold('admin', 'admin', {})).toBe(true);
    expect(mayViewFirmWideDemoFold('Richard', 'user', {})).toBe(true);
    expect(isOperatorBookName('Richard', {})).toBe(true);
    expect(isOperatorBookName('richard', {})).toBe(true);
    // …and still denies the ordinary account TRA-2407 scoped out.
    expect(mayViewFirmWideDemoFold('plain_xxx', 'user', {})).toBe(false);
  });
});

describe('TRA-2508 — the WIRING (this block fails on 4df4e41)', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

  /**
   * Slice one route handler out of `index.ts`.
   *
   * Routes are declared at column 0, so the next `\napp.` terminates the body.
   * The needle carries its closing quote, which is what keeps
   * `app.post('/api/admin/users'` from matching
   * `app.post('/api/admin/users/:username/password'`.
   */
  const routeBody = (needle: string): string => {
    const start = src.indexOf(needle);
    expect(start, `route not found in index.ts: ${needle}`).toBeGreaterThan(-1);
    const rest = src.slice(start + needle.length);
    const end = rest.indexOf('\napp.');
    return end === -1 ? rest : rest.slice(0, end);
  };

  const IDENTITY_WRITES = [
    { route: "app.post('/api/auth/signup'", audience: "audience: 'public'" },
    { route: "app.post('/api/admin/users'", audience: "audience: 'admin'" },
    { route: "app.patch('/api/admin/users/:username'", audience: "audience: 'admin'" },
  ];

  for (const { route, audience } of IDENTITY_WRITES) {
    it(`${route} runs the shared precondition`, () => {
      const body = routeBody(route);
      expect(body).toContain('refuseReservedIdentityWrite(');
      expect(body).toContain(audience);
    });

    it(`${route} actually RETURNS the refusal (a computed-and-ignored guard is the same bug)`, () => {
      const body = routeBody(route);
      expect(body).toContain('res.status(reserved.status)');
      // The refusal must short-circuit. Without the `return` the handler falls
      // through and creates the account after sending a 409 — which reads as
      // fixed from the status line alone.
      expect(body).toMatch(/res\.status\(reserved\.status\)[\s\S]{0,120}?return;/);
    });
  }

  it('POST /api/admin/users refuses BEFORE it retires anyone`s book', () => {
    const body = routeBody("app.post('/api/admin/users'");
    const guard = body.indexOf('refuseReservedIdentityWrite(');
    const retire = body.indexOf('retireOrphanedBook(');
    const create = body.indexOf('createUser(');
    expect(retire).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    // A refused create that has already moved a book to `orphaned-books/` is a
    // destructive no-op with a 409 on it.
    expect(guard).toBeLessThan(retire);
    expect(guard).toBeLessThan(create);
  });

  it('PATCH /api/admin/users/:username guards `newUsername`, not the path param', () => {
    const body = routeBody("app.patch('/api/admin/users/:username'");
    // The path param is the EXISTING name; guarding it would refuse every edit to
    // the real `Richard`'s email. The reserved thing is the name being WRITTEN.
    expect(body).toMatch(/refuseReservedIdentityWrite\(\{\s*name:\s*newUsername/);
    expect(body).not.toMatch(/refuseReservedIdentityWrite\(\{\s*name:\s*username/);
    const guard = body.indexOf('refuseReservedIdentityWrite(');
    const update = body.indexOf('updateUser(');
    expect(update).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(update);
  });

  it('the self-serve delete (TRA-2421) still shares the same predicate', () => {
    // The fourth identity-write path. It refuses through `refuseSelfDelete`, which
    // takes the predicate by injection — so what matters is WHICH predicate.
    const body = routeBody("app.delete('/api/account'");
    expect(body).toContain('refuseSelfDelete(');
    expect(body).toContain('isOperatorBook: isReservedOperatorBookName');
  });

  it('no identity-write route re-implements the reserve inline', () => {
    // The failure mode this whole module exists to prevent: a fifth route lands
    // with its own copy of the rule, the two lists drift, and the drift is
    // invisible because both spellings look correct in review.
    const inline = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\bisReservedOperatorBookName\s*\(/.test(line));
    // Only the injection site above may name it with a call; everywhere else it
    // must arrive through `refuseReservedIdentityWrite`.
    expect(inline.map(b => `L${b.n}: ${b.line}`)).toEqual([]);
  });
});
