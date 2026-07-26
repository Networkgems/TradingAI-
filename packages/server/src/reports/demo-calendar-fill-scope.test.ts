import { describe, it, expect } from 'vitest';
import {
  mayViewFirmWideDemoFold,
  shouldServeFirmWideDemoFold,
  isOperatorBookName,
  isReservedOperatorBookName,
  operatorBookNames,
  BUILTIN_OPERATOR_BOOKS,
  DEMO_CALENDAR_OPERATOR_BOOKS_ENV,
} from './demo-calendar-fill-scope.js';
import { classifySpreadCeilingAccount } from '../option-spread-cost.js';

// TRA-2407 — the per-account DEMO calendar (TRA-1572) served the firm-wide Desk
// fold to EVERY authenticated account whose personal book was hollow for the day.
// A brand-new account is hollow for every past day, so its whole P&L Calendar
// rendered the firm's data: on live bqb1 @408f06a5ef81 a freshly signed-up token
// was refused `/api/reports/desk` with 403 (TRA-1604) and served the desk numbers
// through `/api/reports/:date?mode=demo` — 2026-07-01 = $10,563.53 / 191 closes,
// including 191 individual trade rows belonging to other people's books.
//
// ⚠️ THE INSTRUMENT REQUIREMENT (TRA-2407 acceptance criterion 3). This file must
// assert BOTH directions. A test that only checks "a new user is denied" would
// ALSO pass if the fill were deleted outright — which would silently revert
// TRA-1572's board directive and put admin/Richard back to blank demo calendars.
// Every `false` expectation below is therefore paired with a `true` one.

const env = (extra?: string): NodeJS.ProcessEnv =>
  (extra === undefined ? {} : { [DEMO_CALENDAR_OPERATOR_BOOKS_ENV]: extra }) as NodeJS.ProcessEnv;

describe('mayViewFirmWideDemoFold — who may see the firm-wide demo fold (TRA-2407)', () => {
  it('FIRES for the operator books TRA-1572 was built for — the direction a deletion would break', () => {
    // admin, by role AND by name.
    expect(mayViewFirmWideDemoFold('admin', 'admin', env())).toBe(true);
    // Richard: the ticket's explicit warning. Only `admin` is ever seeded with
    // role 'admin' (users.ts:91) and createUser defaults signups to 'user'
    // (users.ts:204), so a plain `role === 'admin'` gate would blank his
    // calendar. He must pass as a PLAIN USER.
    expect(mayViewFirmWideDemoFold('Richard', 'user', env())).toBe(true);
    // …and still pass if he happens to hold the admin role.
    expect(mayViewFirmWideDemoFold('Richard', 'admin', env())).toBe(true);
  });

  it('DENIES an ordinary account — the reported leak', () => {
    expect(mayViewFirmWideDemoFold('bob', 'user', env())).toBe(false);
    expect(mayViewFirmWideDemoFold('newcomer_2026', 'user', env())).toBe(false);
    expect(mayViewFirmWideDemoFold('ctoverify_tra2406', 'user', env())).toBe(false);
  });

  it('DEFAULT DENY on every unidentifiable caller — a failed lookup must not open the gate', () => {
    // TRA-1604 already classified this data as not-for-ordinary-accounts, so an
    // unknown role costs one operator a blank cell, never a leak (cf. TRA-2331,
    // where a scoped control silently failed open).
    expect(mayViewFirmWideDemoFold('bob', undefined, env())).toBe(false);
    expect(mayViewFirmWideDemoFold('bob', null, env())).toBe(false);
    expect(mayViewFirmWideDemoFold(undefined, undefined, env())).toBe(false);
    expect(mayViewFirmWideDemoFold(null, 'admin', env())).toBe(false);
    expect(mayViewFirmWideDemoFold('', 'admin', env())).toBe(false);
    expect(mayViewFirmWideDemoFold('   ', 'admin', env())).toBe(false);
  });
});

// ⚠️ THE TRAP THIS TICKET SETS. TRA-2407 recommends reusing
// `classifySpreadCeilingAccount()` (TRA-2355) because it already separates
// "desk (admin/Richard)" from fixture books. It does NOT: it is
// `isTestAccount(x) ? 'fixture' : 'desk'`, so EVERY name that is not a known QA
// pattern falls through to 'desk'. Gating the fill on `=== 'desk'` would admit
// every ordinary username and fix nothing.
//
// What makes it dangerous rather than merely wrong is that it would still look
// fixed: the ticket's own reproduction account (`ctoverify_tra2406`) is
// QA-classified BY DESIGN (TRA-1949), i.e. drawn from the single class of
// account for which the wrong predicate returns the right answer. A regression
// test written against the reporter's repro username would go GREEN while the
// leak stayed open for the entire real audience.
describe('the rejected predicate — why classifySpreadCeilingAccount cannot gate this (TRA-2407)', () => {
  it('classifies ORDINARY usernames as `desk`, so it would have admitted them all', () => {
    for (const name of ['bob', 'newcomer_2026', 'aqua', 'monitorly']) {
      expect(classifySpreadCeilingAccount(name)).toBe('desk'); // ← would have passed the fill
      expect(mayViewFirmWideDemoFold(name, 'user', env())).toBe(false); // ← the correct answer
    }
  });

  it('agrees with the correct predicate ONLY on the QA fixture the bug was reported with', () => {
    // Both say "no fill" here — which is exactly why this account cannot be the
    // test case that proves the fix.
    expect(classifySpreadCeilingAccount('ctoverify_tra2406')).toBe('fixture');
    expect(mayViewFirmWideDemoFold('ctoverify_tra2406', 'user', env())).toBe(false);
  });
});

describe('operator-book naming — case rules and the squat they force (TRA-2407)', () => {
  it('matches case-insensitively, because the codebase spells the book both ways', () => {
    // 'Richard' in options-daily-pnl-source.test.ts:335 and health-routes.test.ts:2056;
    // 'richard' in desk-calendar.test.ts:92. A case-sensitive allowlist would blank
    // the real book while every test still passed.
    for (const spelling of ['Richard', 'richard', 'RICHARD', '  Richard  ']) {
      expect(isOperatorBookName(spelling, env())).toBe(true);
    }
    expect(isOperatorBookName('admin', env())).toBe(true);
    expect(isOperatorBookName('ADMIN', env())).toBe(true);
  });

  it('is anchored, not a substring match — a real book merely containing the name stays ordinary', () => {
    for (const name of ['richardson', 'not_richard', 'admin_2', 'subadmin', 'richar']) {
      expect(isOperatorBookName(name, env())).toBe(false);
      expect(mayViewFirmWideDemoFold(name, 'user', env())).toBe(false);
    }
  });

  it('RESERVES those names at signup — the escalation this fix would otherwise introduce', () => {
    // users.ts:141 finds users with a case-SENSITIVE `===`, so 'RICHARD' would
    // register as a distinct account. Before this ticket that bought nothing (the
    // fold was served to everyone); now it would inherit an operator privilege.
    // The case-insensitive allowlist and this reservation are a PAIR.
    for (const squat of ['RICHARD', 'richard', 'Richard', 'Admin', 'ADMIN']) {
      expect(isReservedOperatorBookName(squat, env())).toBe(true);
    }
    expect(isReservedOperatorBookName('bob', env())).toBe(false);
    expect(isReservedOperatorBookName('richardson', env())).toBe(false);
  });

  it('env widens the allowlist but can NEVER empty it — this host has lost its env twice', () => {
    // TRA-2136 / TRA-2193+2195: an env wipe must not blank the two books the
    // board looks at, so the builtins are unconditional and the env is additive.
    expect(operatorBookNames(env('ops_book'))).toContain('ops_book');
    expect(mayViewFirmWideDemoFold('ops_book', 'user', env('ops_book'))).toBe(true);
    expect(mayViewFirmWideDemoFold('ops_book', 'user', env())).toBe(false);

    for (const wiped of [undefined, '', '  ', ',,,']) {
      const names = operatorBookNames(env(wiped));
      for (const builtin of BUILTIN_OPERATOR_BOOKS) {
        expect(names).toContain(builtin.toLowerCase());
      }
      expect(mayViewFirmWideDemoFold('Richard', 'user', env(wiped))).toBe(true);
    }
  });
});

describe('shouldServeFirmWideDemoFold — the whole per-date decision (TRA-2407)', () => {
  const HOLLOW = true;
  const TRADED = false;

  it('AC2 — a desk book with a hollow day still gets the fill (TRA-1572 intact)', () => {
    expect(shouldServeFirmWideDemoFold('demo', HOLLOW, 'admin', 'admin', env())).toBe(true);
    expect(shouldServeFirmWideDemoFold('demo', HOLLOW, 'Richard', 'user', env())).toBe(true);
  });

  it('AC1 — a plain user with a hollow day gets NO fill, so pre-account days 404', () => {
    expect(shouldServeFirmWideDemoFold('demo', HOLLOW, 'bob', 'user', env())).toBe(false);
    expect(shouldServeFirmWideDemoFold('demo', HOLLOW, 'ctoverify_tra2406', 'user', env())).toBe(false);
  });

  it('AC4 NEGATIVE CONTROL — a plain user who DID trade still gets their own cell', () => {
    // The fix must be a scope change, not a blanking of the calendar. `false`
    // here means "do not overwrite with the firm fold"; the route then serves
    // the personal report unchanged.
    expect(shouldServeFirmWideDemoFold('demo', TRADED, 'bob', 'user', env())).toBe(false);
    // …and the day the personal book traded is authoritative for operators too —
    // TRA-1572's original rule, which this ticket does not touch.
    expect(shouldServeFirmWideDemoFold('demo', TRADED, 'admin', 'admin', env())).toBe(false);
  });

  it('stays DEMO-only — live/sandbox keep their Tradier balance-truth path', () => {
    for (const mode of ['live', 'sandbox', '']) {
      expect(shouldServeFirmWideDemoFold(mode, HOLLOW, 'admin', 'admin', env())).toBe(false);
    }
  });
});
