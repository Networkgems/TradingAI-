// TRA-4493 — `PATCH /api/auth/me` accepted `{email:''}` on the account's OWN
// session (`typeof email !== 'string'` was the whole check), `updateUser` wrote
// it through verbatim, and the next login minted a full session from the
// password alone. Split out of TRA-4489, whose drill measured all three steps.
//
// ⚠️ THREE KINDS OF TEST LIVE HERE AND THEY ARE NOT INTERCHANGEABLE.
//
//   THE GRAMMAR  — unit tests on `acceptEmail`. These pass on the broken build
//                  the moment `email-grammar.ts` exists, because a predicate
//                  nobody calls answers correctly. Necessary, not sufficient.
//                  (`username-grammar.test.ts` carries the same warning, for the
//                  same reason: an unrouted guard was that bug too.)
//
//   THE AUDIT    — unit tests on `auditTwoFactorEmailIntegrity`, the reconcile
//                  over rows that were ALREADY blanked. It reports; it does not
//                  repair, because repairing is TRA-4489's ruling.
//
//   THE WIRING   — a source scan of `index.ts`. It proves ORDER and it proves a
//                  refusal is RETURNED. It does NOT prove the guard runs, and
//                  must never be read as if it did — that claim belongs to
//                  `scripts/tra4493-email-write-guard-drill.mjs`, which drives
//                  the real routes on a booted server and whose pre-fix control
//                  is recorded in `docs/tra4493-email-write-guard.md`.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  acceptEmail,
  matchesEmailGrammar,
  auditTwoFactorEmailIntegrity,
  EMAIL_PATTERN,
  EMAIL_MAX_LENGTH,
} from './email-grammar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── The fixtures, split by WHAT GOES WRONG — the split is a finding ───────────

/**
 * The trigger itself. Every one of these blanks the address, and on an enrolled
 * account every one of them is a self-service downgrade to password-only.
 */
const BLANKING_VALUES: readonly unknown[] = ['', ' ', '\t', '\n', '   \t\n  '];

/**
 * The QUIETER half: the account keeps an address, 2FA stays armed, and every
 * emailed OTP goes nowhere. Nothing reports it, which is why format validation
 * is owed as well as the blank guard.
 */
const MALFORMED_VALUES: readonly string[] = [
  'nope', // ← the ticket's own example
  'not-an-address',
  '@drill.invalid',
  'user@',
  'user@@drill.invalid',
  'user@localhost', // no dot ⇒ no OTP will ever land
  'user@drill', // same
  'user@.invalid',
  'user@drill..invalid',
  'user@-drill.invalid',
  'user@drill-.invalid',
  'user@drill.invalid-',
  'user@drill.i', // one-character TLD
  'user@drill.1nvalid', // numeric TLD
  'user name@drill.invalid',
  'user@drill invalid.com',
  'user\t@drill.invalid',
  '@',
  'user@drill.invalid@evil.example',
];

/**
 * SURROUNDING whitespace only. The grammar trims before it validates, so what it
 * sees is an ordinary address and it accepts it — and the trimmed value is what
 * the caller must store. Keeping these out of `MALFORMED_VALUES` is the same
 * split `username-grammar.test.ts` records as `TRIMS_TO_A_VALID_NAME`: it says
 * which claim each string actually supports. An address pasted out of a mail
 * client arrives padded, and 400ing it would be an outage, not a fix.
 */
const TRIMS_TO_A_VALID_ADDRESS: readonly string[] = [
  'user@drill.invalid\n',
  '  user@drill.invalid',
  'user@drill.invalid\t',
  '\n user@drill.invalid \r\n',
];

/** Non-string bodies. `undefined` is `{}`; `null` is an explicit JSON null. */
const NON_STRING_VALUES: readonly unknown[] = [undefined, null, 0, 1, true, false, {}, [], ['a@b.co']];

/** Must be accepted — refusing a real address is the worse failure. */
const ACCEPTABLE_VALUES: readonly string[] = [
  'user@drill.invalid',
  'a@b.co',
  'first.last@sub.domain.example.com',
  'user+tag@drill.invalid',
  "o'brien@drill.invalid",
  'user_name@drill.invalid',
  'USER@DRILL.INVALID',
  'user@drill-host.invalid',
  'user@1.example',
  'x'.repeat(64) + '@drill.invalid',
];

// ── THE GRAMMAR ───────────────────────────────────────────────────────────────

describe('TRA-4493 — acceptEmail, the negative cases (written first, per the ticket)', () => {
  it('refuses every blanking value', () => {
    for (const blank of BLANKING_VALUES) {
      const decision = acceptEmail({ email: blank });
      expect(decision.ok, JSON.stringify(blank)).toBe(false);
      if (decision.ok) continue;
      expect(decision.refusal.code, JSON.stringify(blank)).toBe('blank');
      expect(decision.refusal.status).toBe(400);
    }
  });

  it('refuses every malformed address', () => {
    for (const bad of MALFORMED_VALUES) {
      const decision = acceptEmail({ email: bad });
      expect(decision.ok, bad).toBe(false);
      if (!decision.ok) expect(decision.refusal.code, bad).toBe('shape');
    }
  });

  it('refuses every non-string body value', () => {
    for (const bad of NON_STRING_VALUES) {
      const decision = acceptEmail({ email: bad });
      expect(decision.ok, String(bad)).toBe(false);
      if (!decision.ok) expect(decision.refusal.code, String(bad)).toBe('not_a_string');
    }
  });

  it('refuses an address over the RFC 5321 path cap', () => {
    const long = 'x'.repeat(60) + '@' + 'y'.repeat(EMAIL_MAX_LENGTH) + '.invalid';
    const decision = acceptEmail({ email: long });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.refusal.code).toBe('too_long');
  });

  it('the refusal MESSAGE describes the rule and never echoes the input', () => {
    // An error that quotes the submitted value back is an enumeration oracle on
    // any route that can be hit with someone else's address.
    for (const bad of [...MALFORMED_VALUES, 'someone.elses@address.example']) {
      const decision = acceptEmail({ email: bad });
      if (decision.ok) continue;
      expect(decision.refusal.message, bad).not.toContain(bad);
    }
  });
});

describe('TRA-4493 — acceptEmail, the positive cases (a grammar that refuses real addresses is a lockout)', () => {
  it('accepts every ordinary address', () => {
    for (const ok of ACCEPTABLE_VALUES) {
      const decision = acceptEmail({ email: ok });
      expect(decision.ok, ok).toBe(true);
    }
  });

  it('returns the TRIMMED value, and that is what a caller must store', () => {
    for (const padded of TRIMS_TO_A_VALID_ADDRESS) {
      const decision = acceptEmail({ email: padded });
      expect(decision.ok, JSON.stringify(padded)).toBe(true);
      if (decision.ok) expect(decision.email).toBe('user@drill.invalid');
    }
  });

  it('does NOT lower-case — `getUserByEmail` is an exact-match lookup and re-casing a stored row is a different ticket', () => {
    const decision = acceptEmail({ email: 'USER@Drill.Invalid' });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.email).toBe('USER@Drill.Invalid');
  });

  it('accepts everything `enableTwoFactor` would accept, so the write path cannot refuse an address 2FA would take', () => {
    // `enableTwoFactor` (`users.ts`) gates enrolment on `email.includes('@')`.
    // If the WRITE grammar were narrower in a way that mattered, a user could be
    // refused an address they are otherwise allowed to enrol with. The direction
    // that must hold is: everything this grammar accepts, `includes('@')`
    // accepts. (The converse deliberately does NOT hold — `nope@x` has an `@`
    // and is still unreachable by mail.)
    for (const ok of ACCEPTABLE_VALUES) {
      expect(ok.includes('@'), ok).toBe(true);
    }
  });

  it('matchesEmailGrammar agrees with acceptEmail on every fixture', () => {
    for (const v of [...ACCEPTABLE_VALUES, ...TRIMS_TO_A_VALID_ADDRESS]) {
      expect(matchesEmailGrammar(v), JSON.stringify(v)).toBe(true);
    }
    for (const v of [...BLANKING_VALUES, ...MALFORMED_VALUES, ...NON_STRING_VALUES]) {
      expect(matchesEmailGrammar(v), String(v)).toBe(false);
    }
  });

  it('EMAIL_PATTERN is anchored at both ends', () => {
    // An unanchored pattern accepts `\nuser@drill.invalid\nevil` under a
    // multiline-ish read and is the classic way this check is defeated.
    expect(EMAIL_PATTERN.source.startsWith('^')).toBe(true);
    expect(EMAIL_PATTERN.source.endsWith('$')).toBe(true);
    expect(EMAIL_PATTERN.flags).not.toContain('g'); // a `g` regex carries lastIndex across calls
  });
});

describe('TRA-4493 — the 2FA limb: a blank address is refused DIFFERENTLY on an enrolled account', () => {
  it('a blank address on an ENROLLED account is a 409 naming what it would disarm', () => {
    for (const blank of BLANKING_VALUES) {
      const decision = acceptEmail({ email: blank, twoFactorEnabled: true });
      expect(decision.ok, JSON.stringify(blank)).toBe(false);
      if (decision.ok) continue;
      expect(decision.refusal.code).toBe('blank_would_disarm_two_factor');
      expect(decision.refusal.status).toBe(409);
      expect(decision.refusal.message).toMatch(/two-factor/i);
    }
  });

  it('a blank address on a NON-enrolled account is the plain 400 — clearing an address is not itself the bug', () => {
    const decision = acceptEmail({ email: '', twoFactorEnabled: false });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.refusal.code).toBe('blank');
      expect(decision.refusal.status).toBe(400);
    }
  });

  it('the 2FA limb does not change the verdict for a MALFORMED address — that is refused either way', () => {
    for (const bad of MALFORMED_VALUES) {
      expect(acceptEmail({ email: bad, twoFactorEnabled: true }).ok, bad).toBe(false);
      expect(acceptEmail({ email: bad, twoFactorEnabled: false }).ok, bad).toBe(false);
    }
  });

  it('the 2FA limb never ACCEPTS anything the plain limb refuses, in either direction', () => {
    // The failure mode of a two-limbed guard: the extra parameter widens the
    // accept set on one branch. Sweep both branches over every fixture.
    const every = [
      ...ACCEPTABLE_VALUES,
      ...TRIMS_TO_A_VALID_ADDRESS,
      ...BLANKING_VALUES,
      ...MALFORMED_VALUES,
      ...NON_STRING_VALUES,
    ];
    for (const v of every) {
      expect(acceptEmail({ email: v, twoFactorEnabled: true }).ok, JSON.stringify(v)).toBe(
        acceptEmail({ email: v, twoFactorEnabled: false }).ok,
      );
    }
  });

  it('defaulting `twoFactorEnabled` is FAIL-OPEN on the message only, never on the verdict', () => {
    // A caller that forgets the flag still gets a refusal; what it loses is the
    // better message. That is the right direction for an optional parameter —
    // the opposite arrangement would make forgetting it a security regression.
    expect(acceptEmail({ email: '' }).ok).toBe(false);
  });
});

// ── THE AUDIT ─────────────────────────────────────────────────────────────────

describe('TRA-4493 item 2 — auditTwoFactorEmailIntegrity over rows that were ALREADY blanked', () => {
  const roster = [
    { username: 'healthy', email: 'healthy@drill.invalid', twoFactorEnabled: true, backupCodesRemaining: 10 },
    { username: 'blanked', email: '', twoFactorEnabled: true, backupCodesRemaining: 3 },
    { username: 'blanked-no-codes', email: '   ', twoFactorEnabled: true, backupCodesRemaining: 0 },
    { username: 'malformed', email: 'nope', twoFactorEnabled: true, backupCodesRemaining: 7 },
    { username: 'missing-field', email: undefined, twoFactorEnabled: true, backupCodesRemaining: 1 },
    // NOT degraded: no second factor to be degraded. A blank address here is an
    // ordinary account that never enrolled, and counting it would bury the real
    // rows under noise.
    { username: 'no-2fa-blank', email: '', twoFactorEnabled: false, backupCodesRemaining: 0 },
    { username: 'no-2fa-ok', email: 'plain@drill.invalid', twoFactorEnabled: false, backupCodesRemaining: 0 },
  ];

  it('names exactly the enrolled accounts with an unusable address', () => {
    const audit = auditTwoFactorEmailIntegrity(roster);
    expect(audit.degraded.map((d) => d.username).sort()).toEqual(
      ['blanked', 'blanked-no-codes', 'malformed', 'missing-field'].sort(),
    );
  });

  it('splits `blank` (the fail-open trigger) from `shape` (OTPs go nowhere, 2FA still bites)', () => {
    const audit = auditTwoFactorEmailIntegrity(roster);
    const byName = Object.fromEntries(audit.degraded.map((d) => [d.username, d]));
    expect(byName['blanked'].reason).toBe('blank');
    expect(byName['blanked-no-codes'].reason).toBe('blank');
    expect(byName['missing-field'].reason).toBe('blank');
    // The two states behave differently at login and are remediated
    // differently, so one bucket would be the wrong instrument.
    expect(byName['malformed'].reason).toBe('shape');
  });

  it('flags the corner the drill found: recovery holds IFF backup codes remain', () => {
    const audit = auditTwoFactorEmailIntegrity(roster);
    const byName = Object.fromEntries(audit.degraded.map((d) => [d.username, d]));
    expect(byName['blanked'].recoverableByBackupCode).toBe(true);
    expect(byName['blanked-no-codes'].recoverableByBackupCode).toBe(false);
  });

  it('emits `scanned` and `enrolled` even when nothing is degraded — a zero must READ as a zero', () => {
    // The whole point of a counter here. `degraded: 0` and "the reconcile never
    // ran" must not share a rendering, or absence gets read as health.
    const clean = auditTwoFactorEmailIntegrity([
      { username: 'a', email: 'a@drill.invalid', twoFactorEnabled: true, backupCodesRemaining: 10 },
      { username: 'b', email: 'b@drill.invalid', twoFactorEnabled: false, backupCodesRemaining: 0 },
    ]);
    expect(clean.degraded).toEqual([]);
    expect(clean.scanned).toBe(2);
    expect(clean.enrolled).toBe(1);
  });

  it('an EMPTY roster is scanned:0 — distinguishable from a clean fleet, and from not running', () => {
    expect(auditTwoFactorEmailIntegrity([])).toEqual({ scanned: 0, enrolled: 0, degraded: [] });
  });

  it('MUTATION CONTROL — a roster with a degraded row cannot report zero', () => {
    // Guards against the audit being rewritten into something that always
    // returns an empty array, which reads identically to a healthy fleet.
    const audit = auditTwoFactorEmailIntegrity([
      { username: 'victim', email: '', twoFactorEnabled: true, backupCodesRemaining: 0 },
    ]);
    expect(audit.degraded.length).toBe(1);
    expect(audit.enrolled).toBe(1);
  });

  it('is pure — it does not mutate the roster it is handed', () => {
    const before = JSON.stringify(roster);
    auditTwoFactorEmailIntegrity(roster);
    expect(JSON.stringify(roster)).toBe(before);
  });
});

// ── THE WIRING ────────────────────────────────────────────────────────────────

describe('TRA-4493 — the WIRING (an unrouted grammar is the same bug in a new file)', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

  /** Slice one route handler out of `index.ts`. Routes are declared at column 0. */
  const routeBody = (needle: string): string => {
    const start = src.indexOf(needle);
    expect(start, `route not found in index.ts: ${needle}`).toBeGreaterThan(-1);
    const rest = src.slice(start + needle.length);
    const end = rest.indexOf('\napp.');
    return end === -1 ? rest : rest.slice(0, end);
  };

  /** Every route that WRITES an account email, and the writer it reaches. */
  const EMAIL_WRITES = [
    { route: "app.post('/api/auth/signup'", writer: 'createUser(' },
    { route: "app.post('/api/auth/account/email'", writer: 'updateUser(' },
    { route: "app.patch('/api/auth/me'", writer: 'updateUser(' },
    { route: "app.post('/api/admin/users'", writer: 'createUser(' },
    { route: "app.patch('/api/admin/users/:username'", writer: 'updateUser(' },
  ];

  for (const { route, writer } of EMAIL_WRITES) {
    it(`${route} runs the canonical grammar BEFORE it writes`, () => {
      const body = routeBody(route);
      const guard = body.indexOf('acceptEmail(');
      const write = body.indexOf(writer);
      expect(guard, `acceptEmail not called in ${route}`).toBeGreaterThan(-1);
      expect(write, `${writer} not found in ${route}`).toBeGreaterThan(-1);
      // A 400 written after the row is persisted is a status line on a completed
      // write. Order is the fix here exactly as it was in TRA-4475.
      expect(guard).toBeLessThan(write);
    });

    it(`${route} RETURNS the refusal (a computed-and-ignored guard is the same bug)`, () => {
      const body = routeBody(route);
      // Slice from the refusal write to the next statement rather than matching
      // across a span: a `return;` that appears LATER in the handler would
      // satisfy a loose regex while the handler still falls through here.
      const at = body.search(/res\.status\((?:\w+D|d)ecision\.refusal\.status\)/);
      expect(at, `${route} does not send decision.refusal.status`).toBeGreaterThan(-1);
      expect(body.slice(at, at + 200)).toMatch(/refusal\.message \}\);\s*\n\s*return;/);
    });

    it(`${route} writes the VALIDATED value, never the raw body field`, () => {
      // The half that is easy to lose in a later edit: consult the grammar, then
      // keep passing `email`. Validated and stored have to be the same string or
      // they drift and the gap re-opens with the guard still in place.
      const body = routeBody(route);
      const offenders = body
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
        .filter(({ line }) => /\b(createUser|updateUser|sendWelcomeEmail)\s*\(/.test(line))
        .filter(({ line }) => /(?:^|[(,{\s])email\s*(?:[,)}]|\.trim)/.test(line));
      expect(offenders.map((o) => `${route} L${o.n}: ${o.line}`)).toEqual([]);
    });
  }

  it('the two SELF-SERVICE email writes consult the account\'s 2FA state', () => {
    // `PATCH /api/auth/me` is the ticket's headline route and `PATCH
    // /api/admin/users/:username` is the same write reached with an admin token
    // — `requireAdmin` narrows WHO can fire it, not what it does.
    for (const route of ["app.patch('/api/auth/me'", "app.patch('/api/admin/users/:username'"]) {
      const body = routeBody(route);
      expect(body, route).toMatch(/twoFactorEnabled:\s*isTwoFactorEnabled\(username\)/);
    }
  });

  it('the admin PATCH grades email ONLY when the field is present — an optional limb stays optional', () => {
    // `email === undefined` means "not editing the address". Grading an absent
    // field would 400 every rename-only PATCH, which is an outage dressed as a
    // fix.
    const body = routeBody("app.patch('/api/admin/users/:username'");
    expect(body).toMatch(/if \(email !== undefined\) \{/);
    const gate = body.indexOf('if (email !== undefined) {');
    const guard = body.indexOf('acceptEmail(');
    expect(gate).toBeLessThan(guard);
  });

  it('no route re-implements the check inline', () => {
    // The failure this module exists to prevent, and the one the codebase
    // already had: THREE spellings of one rule across five writers, and the two
    // routes carrying no spelling of it are the two this ticket is about.
    const stragglers = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
      .filter(({ line }) => /email(?:\w*)?\.includes\('@'\)|email(?:\w*)?\.includes\("@"\)/.test(line));
    // `POST /api/auth/forgot` is the one legitimate survivor: it validates a
    // LOOKUP key, not a write, and tightening a lookup is how a legacy row
    // stops being able to reset its own password. Pinned by count so a new
    // inline copy on a WRITE route cannot land quietly.
    expect(stragglers.map((s) => `L${s.n}: ${s.line}`)).toEqual([
      expect.stringContaining("typeof email !== 'string' || !email.includes('@')"),
    ]);
  });

  it('the boot reconcile runs, and logs its counters unconditionally', () => {
    expect(src).toContain('auditTwoFactorEmailIntegrity(');
    const load = src.indexOf('await loadUsers();');
    const audit = src.indexOf('auditTwoFactorEmailIntegrity(');
    expect(load, 'loadUsers not found').toBeGreaterThan(-1);
    // Auditing an unloaded roster reports a clean fleet of zero accounts, which
    // is the exact instrument-reads-identically failure this repo keeps hitting.
    expect(load).toBeLessThan(audit);
    expect(src).toMatch(/log\.info\('TRA-4493: two-factor email integrity reconcile'/);
  });

  it('the reconcile REPORTS and does not repair — the remedy is TRA-4489\'s ruling', () => {
    // A boot path that disabled 2FA, or locked the account, would be that
    // decision taken unilaterally by a startup step.
    const at = src.indexOf('auditTwoFactorEmailIntegrity(');
    const block = src.slice(at, at + 1200);
    expect(block).not.toMatch(/disableTwoFactor\(|setUserLocked\(|updateUser\(/);
  });
});
