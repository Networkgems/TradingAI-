// TRA-4475 — external audit C1: an anonymous `POST /api/auth/signup` with
// `{username:'../users/richard'}` reached `retireOrphanedBook`, which resolved the
// name to `DATA_DIR/users/richard` — the LIVE book — and renamed it away (with a
// `cp -r` + `rm -rf` fallback across a device boundary).
//
// ⚠️ FOUR KINDS OF TEST LIVE HERE AND THEY ARE NOT INTERCHANGEABLE.
//
//   THE GRAMMAR    — unit tests on `acceptUsername`. These would pass on the
//                    broken build the day `username-grammar.ts` was added, because
//                    a predicate nobody calls answers correctly. Necessary, not
//                    sufficient. (The same warning `identity-write-guard.test.ts`
//                    carries, for the same reason: an unrouted guard was that bug
//                    too.)
//
//   THE BACKSTOP   — unit tests on `assertContainedUserDir`, the check wired into
//                    the path BUILDERS.
//
//   THE ADVERSARY  — the only block that reproduces the incident. It runs the REAL
//                    `retireOrphanedBook` against a real temporary DATA_DIR with a
//                    real victim book planted in it, and asserts the victim is
//                    still there afterwards, byte-for-byte, and that nothing
//                    outside the temporary users root was touched. This is the
//                    block that fails on the pre-fix source; the mutation control
//                    that proves it is recorded in the comment on that describe.
//
//   THE WIRING     — a source scan of `index.ts`. It proves ORDER — that the
//                    grammar's index precedes `retireOrphanedBook`'s — and order
//                    is exactly what a source index comparison CAN prove. It does
//                    NOT prove the guard runs, and must never be read as if it
//                    did; that claim belongs to THE ADVERSARY above.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, sep } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  acceptUsername,
  normalizeUsername,
  matchesUsernameGrammar,
  isPathSafeUsername,
  assertContainedUserDir,
  UnsafeUsernamePathError,
  USERNAME_PATTERN,
} from './username-grammar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── The fixtures, split by CHANNEL — the split is a finding, not tidiness ─────
//
// Writing these as one undifferentiated "hostile" list is what the first draft
// did, and it was wrong in a way that mattered: it asserted the narrow backstop
// must throw on `..%2fusers%2frichard`, which as a literal directory name
// traverses NOWHERE. Overreaching there would have pushed the backstop toward
// being a second copy of the grammar — and the whole reason it is narrower is so
// it can run on the READ path against legacy names without locking anyone out.
// The split records which claim each string actually supports.

/**
 * Path-HAZARDOUS: must never become a path segment. The backstop throws, and
 * `retireOrphanedBook` fails closed.
 *
 * separators · dot segments · absolute + UNC + drive-relative · NUL.
 */
const TRAVERSAL_USERNAMES: readonly string[] = [
  '../users/richard', // ← the audit's exact string
  '../users/richard/',
  '..',
  '.',
  '../../etc/passwd',
  'a/../../b',
  'users/richard',
  'users\\richard',
  '..\\users\\richard',
  '....//users//richard',
  '..;/users/richard',
  ' richard/..',
  // Half-encoded: the dots are `%2E`, the SEPARATOR is a real `/`. It belongs
  // here and not with the inert forms — which is a distinction the first draft of
  // this file got wrong, and the test above is what said so.
  '%2E%2E/users/richard',
  '/etc/passwd',
  '/users/richard',
  'C:\\Windows\\Temp\\x',
  'C:users',
  '\\\\server\\share\\x',
  'rich\0ard',
];

/**
 * Refused by the write-path GRAMMAR, but structurally INERT as a path segment —
 * each one is a single (ugly) directory name that resolves inside the users root
 * and, on this host, matches nothing. The backstop deliberately does NOT throw on
 * these; the grammar is what keeps them off the write path.
 *
 * Encoded forms live here because a JSON body value is never URL-decoded — the
 * `%2e%2e` spelling reaches the handler literal. (Express DOES decode
 * `req.params`, so the PATCH route's `:username` arrives already collapsed to
 * `../…` — which is why that param is a lookup key and never a written name.)
 */
const INERT_REFUSALS: readonly string[] = [
  '..%2fusers%2frichard', // fully-encoded separator ⇒ one literal directory name
  '%2e%2e%2fusers%2frichard',
  '...',
  'rich ard',
  'rich\tard',
  'rich\nard',
  'ric#hard',
  'ric%hard',
  'ric*hard',
  'ric?hard',
  'ric"hard',
  'ric<hard',
  'ric|hard',
  'ric$hard',
  'ric;hard',
  "ric'hard",
  '.hidden',
  '-leading',
  '_leading',
  'ab', // one under the floor
  'a'.repeat(33), // one over the ceiling
  'ríchard', // non-ASCII, NFC
  'ri\u0301chard', // the same word in NFD — normalizes to non-ASCII, still refused
  'ｒｉｃｈａｒｄ', // fullwidth: NFKC would fold this to ASCII; NFC must not
  'rich\u200Bard', // zero-width space
  'rich\u00A0ard', // non-breaking space
];

/**
 * Unsafe as a RAW segment, but the grammar trims before it validates, so what it
 * sees is an ordinary name and it accepts it. Win32 silently strips a trailing
 * space or dot from a filename, which makes `richard ` and `richard` the SAME
 * directory — a collision channel, not a traversal. The trim closes it at the
 * route; the backstop closes it for any caller that skips the route.
 */
const TRIMS_TO_A_VALID_NAME: readonly string[] = ['richard ', ' richard', 'richard\t', '\nrichard'];

/** Everything a route must refuse to WRITE. */
const GRAMMAR_REFUSALS: readonly string[] = [...TRAVERSAL_USERNAMES, ...INERT_REFUSALS];

/** Everything `retireOrphanedBook` is fed in the adversarial sweep. */
const HOSTILE_USERNAMES: readonly string[] = [
  ...TRAVERSAL_USERNAMES,
  ...INERT_REFUSALS,
  ...TRIMS_TO_A_VALID_NAME,
];

// ── THE GRAMMAR ───────────────────────────────────────────────────────────────

describe('TRA-4475 — acceptUsername, the negative cases (written first, per the ticket)', () => {
  for (const hostile of GRAMMAR_REFUSALS) {
    it(`refuses ${JSON.stringify(hostile)}`, () => {
      const decision = acceptUsername({ name: hostile, audience: 'public' });
      expect(decision.ok, `should have been refused: ${JSON.stringify(hostile)}`).toBe(false);
      if (decision.ok) return;
      expect(decision.refusal.status).toBe(400);
      expect(decision.refusal.code).toMatch(/^username_(missing|bad_shape)$/);
    });
  }

  it('a surrounding-whitespace spelling is TRIMMED, not refused — and is then safe', () => {
    // `richard ` and `richard` are the same directory on Win32 (a trailing space
    // is stripped by the filesystem), so this must not become a second account.
    // The trim collapses it before validation, which is why the grammar accepts
    // it and returns the collapsed form — and why the raw form can never reach a
    // path builder from a route.
    for (const padded of TRIMS_TO_A_VALID_NAME) {
      const decision = acceptUsername({ name: padded, audience: 'public' });
      expect(decision.ok, JSON.stringify(padded)).toBe(true);
      if (decision.ok) expect(decision.username).toBe('richard');
      // …and the backstop still refuses the UNTRIMMED string, for any caller that
      // reaches a path builder without going through a route.
      expect(isPathSafeUsername(padded), JSON.stringify(padded)).toBe(false);
    }
  });

  it('refuses a non-string body value without throwing', () => {
    for (const bad of [undefined, null, 42, {}, [], true, { toString: () => 'richard' }]) {
      const decision = acceptUsername({ name: bad, audience: 'public' });
      expect(decision.ok, String(bad)).toBe(false);
      if (!decision.ok) expect(decision.refusal.code).toBe('username_missing');
    }
  });

  it('the refusal message is a RULE, never an echo of the input', () => {
    // An attacker-controlled string reflected into a JSON error body is a habit
    // worth not having, and the message must not become an enumeration oracle.
    const decision = acceptUsername({ name: '../users/richard', audience: 'public' });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.refusal.message).not.toContain('../users/richard');
    expect(decision.refusal.message).not.toContain('richard');
    // …while the LOG line does carry it, because that is where it is useful.
    expect(decision.refusal.detail).toContain('../users/richard');
  });
});

describe('TRA-4475 — acceptUsername, the positive cases', () => {
  it('accepts ordinary names and returns the CANONICAL string', () => {
    for (const ok of ['bob', 'richard', 'Richard', 'admin_2', 'plain_xxx', 'v0nni', 'a.b-c_d', 'qa_tra2511_v2']) {
      const decision = acceptUsername({ name: ok, audience: 'public' });
      expect(decision.ok, ok).toBe(true);
      if (decision.ok) expect(decision.username).toBe(ok);
    }
  });

  it('trims, and the trimmed value is what comes back', () => {
    const decision = acceptUsername({ name: '  richard  ', audience: 'public' });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.username).toBe('richard');
  });

  it('holds at both length boundaries', () => {
    expect(acceptUsername({ name: 'abc', audience: 'public' }).ok).toBe(true);
    expect(acceptUsername({ name: 'a'.repeat(32), audience: 'public' }).ok).toBe(true);
    expect(acceptUsername({ name: 'ab', audience: 'public' }).ok).toBe(false);
    expect(acceptUsername({ name: 'a'.repeat(33), audience: 'public' }).ok).toBe(false);
  });

  it('NFC, not NFKC — the fullwidth solidus must never become a separator', () => {
    // U+FF0F FULLWIDTH SOLIDUS folds to a real `/` under NFKC. If any caller ever
    // normalizes with NFKC AFTER validating, an approved name grows a separator.
    // NFC leaves it alone, and the alphabet then refuses it.
    const fullwidth = '..\uFF0Fusers\uFF0Frichard';
    expect(fullwidth.normalize('NFKC')).toContain('/');
    expect(fullwidth.normalize('NFC')).not.toContain('/');
    expect(acceptUsername({ name: fullwidth, audience: 'public' }).ok).toBe(false);
  });

  it('every accepted name is NFC-stable, so validated == stored == joined', () => {
    for (const ok of ['bob', 'Richard', 'a.b-c_d', 'A1', 'z'.repeat(32)].filter(matchesUsernameGrammar)) {
      const decision = acceptUsername({ name: ok, audience: 'public' });
      expect(decision.ok).toBe(true);
      if (decision.ok) expect(decision.username.normalize('NFC')).toBe(decision.username);
    }
  });

  it('normalizeUsername is null on exactly the unusable inputs', () => {
    expect(normalizeUsername('')).toBeNull();
    expect(normalizeUsername('   ')).toBeNull();
    expect(normalizeUsername(undefined)).toBeNull();
    expect(normalizeUsername(null)).toBeNull();
    expect(normalizeUsername(7)).toBeNull();
    expect(normalizeUsername(' bob ')).toBe('bob');
  });
});

describe('TRA-4475 — the case-collision rule', () => {
  // `users.ts` enforces uniqueness with a case-SENSITIVE `===` (`getUser` is a
  // `u.username === username` find), so without this `Enock` and `enock` are two
  // credential rows, two directories, and one folded identity to every reader
  // that lower-cases. TRA-2407 had to special-case exactly this for the operator
  // books; this generalises it.
  const roster = ['admin', 'Richard', 'enock', 'plain_xxx'];

  it('refuses a case variant of an existing account with a 409', () => {
    for (const squat of ['ENOCK', 'Enock', 'eNoCk', 'richard', 'RICHARD', 'ADMIN']) {
      const decision = acceptUsername({ name: squat, audience: 'public', existingUsernames: roster });
      expect(decision.ok, squat).toBe(false);
      if (!decision.ok) {
        expect(decision.refusal.code).toBe('username_case_collision');
        expect(decision.refusal.status).toBe(409);
      }
    }
  });

  it('does not leak WHICH account collided to an anonymous caller', () => {
    const pub = acceptUsername({ name: 'ENOCK', audience: 'public', existingUsernames: roster });
    expect(pub.ok).toBe(false);
    // The wording TRA-2407 shipped at signup, unchanged.
    if (!pub.ok) expect(pub.refusal.message).toBe('Username is not available');
    const adm = acceptUsername({ name: 'ENOCK', audience: 'admin', existingUsernames: roster });
    if (!adm.ok) expect(adm.refusal.message).toContain('enock');
  });

  it('leaves the substring near-miss alone', () => {
    for (const ok of ['enock2', 'richardson', 'admin_2', 'enoc']) {
      expect(acceptUsername({ name: ok, audience: 'admin', existingUsernames: roster }).ok, ok).toBe(true);
    }
  });

  it('a rename does not collide with the account being renamed', () => {
    // Without `renamingFrom`, `PATCH /api/admin/users/enock {newUsername:'Enock'}`
    // would refuse against the very row it is editing.
    expect(
      acceptUsername({ name: 'Enock', audience: 'admin', existingUsernames: roster, renamingFrom: 'enock' }).ok,
    ).toBe(true);
    // …but it still collides with a DIFFERENT account.
    expect(
      acceptUsername({ name: 'ADMIN', audience: 'admin', existingUsernames: roster, renamingFrom: 'enock' }).ok,
    ).toBe(false);
  });

  it('is not applied when the caller supplies no roster', () => {
    expect(acceptUsername({ name: 'ENOCK', audience: 'public' }).ok).toBe(true);
  });
});

// ── THE LEGACY INVENTORY ──────────────────────────────────────────────────────

describe('TRA-4475 — the legacy inventory that authorized enforcing this', () => {
  // The ticket's precondition: "Inventory the existing bqb1 usernames BEFORE
  // enforcing — ~67 books exist and a rejected legacy name locks a real user out."
  //
  // Measured 2026-09-09 against the live host, `GET /api/admin/users` with an
  // admin bearer: 67 rows, 0 failing the grammar, 0 case collisions, 0 non-NFC.
  // So the set of legacy names this grammar would refuse is EMPTY, and there is
  // no legacy decision owed. Pinned here so the next person who tightens the
  // grammar is told exactly which live accounts they would lock out, instead of
  // finding out from a support ticket.
  //
  // ⚠️ This is a snapshot of a REMOTE population, not a local invariant. It cannot
  // see accounts created after the measurement. It is the floor, not the census —
  // which is why the grammar is enforced on WRITES ONLY and is deliberately absent
  // from the login path, so even an unmeasured legacy name cannot be locked out.
  const BQB1_ROSTER_20260909: readonly string[] = [
    'admin', 'Richard', 'qa_reg_0710202220', 'qa_tra1475_1783821169', 'qa_mirror_1578_38096',
    'ctoverify_tra2211', 'ctoverify_2218_230da93', 'ctoverify_2225_1784856407',
    'ctoverify_2225b_1784856491', 'ctoverify_tra2227', 'qa_tra2251_7b0483ee', 'qa_tra2282_5beed8b8',
    'ceo2251v130001', 'ctoverify_tra2331', 'ctoverify_tra2333', 'ctoverify_qt2331b',
    'ctoverify_tra2329', 'qtprobe3', 'tra2339v66f17374', 'ctoverify_tra2341', 'ctoverify_tra2284',
    'ctoverify_tra2331b', 'qtverify_1785048357', 'ctoverify_tra2354', 'ctoverify_tra2388',
    'ctoverify_tra2388s', 'ctoverify_tra2406', 'ctoverify_qa_tra2406b', 'enock', 'ctoverify_tra2331d',
    'ctoverify_tra2449', 'ctoverify_tra2356v', 'qa_tra2407_ms5ajurt', 'ctoverify_qa2407v1785284396',
    'qa_tra2485_ex_1785284987', 'qa_tra2485_inv_1785284987', 'qa_tra2490_neg_1785285303',
    'qa_tra2490_ex_1785285303', 'qa_tra2490_inv_1785285303', 'qa_tra2492_ex_1785285374',
    'qa_tra2492_inv_1785285374', 'qa_tra2492_ctl_1785285374', 'qa_tra2492_del_1785285374',
    'qa_tra2491_ex_1785285868', 'qa_tra2491_inv_1785285868', 'qa_tra2491_neg_1785285984',
    'qtverify_tra2331_0729a', 'qa_tra2511_114524', 'qa_tra2511_v2', 'qa_tra2407_ms6342f6',
    'qa_tra2407_ms6395jy', 'qa2395_1785337210', 'ctoverify_tra2388w', 'ctoverify_tra2388w195221',
    'ctoverify_tra2388w195302', 'ctoverify_tra2416', 'qtverify_1785371176', 'qtverify_1785371190',
    'ctoverify_tra2439a', 'ctoverify_tra2331_scope_probe', 'qa2716t0730a', 'v0nni', 'qa3120t0806a',
    'qa581t0811a', 'qa2711ret', 'cfo3475222507', 'qa3599_1401',
  ];

  it('has the 67 rows that were measured', () => {
    expect(BQB1_ROSTER_20260909).toHaveLength(67);
  });

  it('every live bqb1 username passes the grammar — nobody is locked out', () => {
    const refused = BQB1_ROSTER_20260909.filter((n) => !USERNAME_PATTERN.test(n));
    expect(refused, `these LIVE accounts would be refused by the grammar: ${refused.join(', ')}`).toEqual([]);
  });

  it('every live bqb1 username is a safe path segment — no legacy name trips the backstop', () => {
    // Stronger than the line above where it matters: the backstop runs on the
    // READ path too (`userDataDir` is called for every context), so a legacy name
    // that failed it would break an existing user's book, not just their signup.
    const unsafe = BQB1_ROSTER_20260909.filter((n) => !isPathSafeUsername(n));
    expect(unsafe, `these LIVE accounts would break at the path builder: ${unsafe.join(', ')}`).toEqual([]);
  });

  it('the live roster carries no case collision, so the new rule refuses nobody retroactively', () => {
    const folded = BQB1_ROSTER_20260909.map((n) => n.toLowerCase());
    expect([...new Set(folded.filter((v, i) => folded.indexOf(v) !== i))]).toEqual([]);
  });
});

// ── THE BACKSTOP ──────────────────────────────────────────────────────────────

describe('TRA-4475 — assertContainedUserDir, the check wired into the path builders', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tra4475-contain-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('throws on every path-hazardous spelling', () => {
    for (const hostile of [...TRAVERSAL_USERNAMES, ...TRIMS_TO_A_VALID_NAME]) {
      expect(
        () => assertContainedUserDir(root, hostile),
        `should have thrown: ${JSON.stringify(hostile)}`,
      ).toThrow(UnsafeUsernamePathError);
    }
  });

  it('does NOT throw on a merely ugly name — it is narrower than the grammar on purpose', () => {
    // `..%2fusers%2frichard` is one literal directory name; it traverses nowhere.
    // If the backstop refused it, the backstop would be drifting toward a second
    // copy of the grammar — and it runs on the READ path, where that drift is an
    // outage for whichever legacy name it caught up with next.
    for (const inert of INERT_REFUSALS) {
      const dir = assertContainedUserDir(root, inert);
      expect(dir.startsWith(join(root, 'users') + sep), JSON.stringify(inert)).toBe(true);
      // The grammar is what keeps it off the write path.
      expect(acceptUsername({ name: inert, audience: 'public' }).ok, JSON.stringify(inert)).toBe(false);
    }
  });

  it('returns a path strictly inside the users root for an ordinary name', () => {
    const dir = assertContainedUserDir(root, 'richard');
    expect(dir).toBe(join(root, 'users', 'richard'));
    expect(dir.startsWith(join(root, 'users') + sep)).toBe(true);
  });

  it('accepts a LEGACY name the write-path grammar would refuse', () => {
    // The two predicates have deliberately different widths. The backstop runs on
    // the read path, so it must not be the grammar: a name that predates the
    // grammar has to keep resolving to its own directory. If these ever converge,
    // tightening the grammar becomes an outage for existing users.
    for (const legacy of ['ab', 'x', '.hidden', '-leading', 'a'.repeat(64), 'rich ard', 'ríchard']) {
      expect(acceptUsername({ name: legacy, audience: 'public' }).ok, legacy).toBe(false);
      expect(() => assertContainedUserDir(root, legacy), legacy).not.toThrow();
    }
  });

  it('the error names the offender for the log and does not silently return a path', () => {
    try {
      assertContainedUserDir(root, '../users/richard');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeUsernamePathError);
      expect((err as UnsafeUsernamePathError).username).toBe('../users/richard');
      expect((err as Error).message).toContain('TRA-4475');
    }
  });
});

// ── THE ADVERSARY ─────────────────────────────────────────────────────────────

describe('TRA-4475 — the incident: a signup username cannot move a live book', () => {
  // ⚠️ THIS IS THE ONLY BLOCK THAT FAILS ON THE PRE-FIX SOURCE.
  //
  // Mutation control, run 2026-09-09 before the fix was committed: reverting
  // `orphaned-books.ts:userDirIn` to its original body —
  //
  //     function userDirIn(root, username) { return join(root, 'users', username); }
  //
  // — and removing the `isPathSafeUsername` early return from `retireOrphanedBook`
  // makes the first two tests below fail with the victim directory GONE and a
  // copy of it sitting under `orphaned-books/`, which is the incident exactly.
  // A control that has not been mutated is a control that agrees with itself.

  let DATA_DIR: string;
  let outsideSentinel: string;
  let orphanedBooks: typeof import('./orphaned-books.js');

  const userDir = (u: string) => join(DATA_DIR, 'users', u);

  /** Every path under a root, relative and sorted — a snapshot to diff against. */
  const treeOf = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        out.push(rel);
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      }
    };
    if (existsSync(root)) walk(root, '');
    return out;
  };

  beforeAll(async () => {
    DATA_DIR = mkdtempSync(join(tmpdir(), 'tra4475-'));
    process.env['DATA_DIR'] = DATA_DIR;
    orphanedBooks = await import('./orphaned-books.js');

    // The victim: a live book with contents worth losing.
    mkdirSync(userDir('richard'), { recursive: true });
    writeFileSync(join(userDir('richard'), 'trades.json'), JSON.stringify({ positions: 6, options: 1 }), 'utf-8');
    mkdirSync(join(userDir('richard'), 'journal'), { recursive: true });
    writeFileSync(join(userDir('richard'), 'journal', 'lots.jsonl'), '{"lot":1}\n', 'utf-8');

    // A sentinel OUTSIDE the users root but inside DATA_DIR, and one outside
    // DATA_DIR entirely — the ticket's "no signup attempt can touch a path
    // outside a temporary users root".
    writeFileSync(join(DATA_DIR, 'do-not-touch.json'), '{"sentinel":true}', 'utf-8');
    outsideSentinel = join(dirname(DATA_DIR), `tra4475-outside-${process.pid}.json`);
    writeFileSync(outsideSentinel, '{"sentinel":"outside"}', 'utf-8');
  });

  afterAll(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(outsideSentinel, { force: true });
  });

  it("the audit's exact string does not move the live book", async () => {
    const before = readFileSync(join(userDir('richard'), 'trades.json'), 'utf-8');

    const receipt = await orphanedBooks.retireOrphanedBook('../users/richard', { dataDir: DATA_DIR });

    // Fails CLOSED: signup already treats `!ok` as "do not create the account".
    expect(receipt.ok).toBe(false);
    expect(receipt.errors.join(' ')).toContain('unsafe-username');
    // And it did not merely refuse to REPORT the book — it must not have found
    // one, because finding one is what arms the retirement.
    expect(receipt.orphanFound).toBe(false);
    expect(receipt.primaryDirExisted).toBe(false);
    expect(receipt.quarantinedTo).toBeNull();
    // A tombstone would scope the real Richard's own journal rows out of his own
    // calendar even with the directory untouched.
    expect(receipt.retiredAt).toBeNull();

    // The victim, byte-for-byte.
    expect(existsSync(userDir('richard'))).toBe(true);
    expect(readFileSync(join(userDir('richard'), 'trades.json'), 'utf-8')).toBe(before);
    expect(readFileSync(join(userDir('richard'), 'journal', 'lots.jsonl'), 'utf-8')).toBe('{"lot":1}\n');
    // Nothing was quarantined under another name — displacement is the incident.
    expect(existsSync(join(DATA_DIR, orphanedBooks.ORPHANED_BOOKS_DIRNAME))).toBe(false);
  });

  it('no hostile spelling touches ANY path, inside the users root or out', async () => {
    const before = treeOf(DATA_DIR);
    expect(before).toContain('users/richard/trades.json');

    for (const hostile of HOSTILE_USERNAMES) {
      const receipt = await orphanedBooks.retireOrphanedBook(hostile, { dataDir: DATA_DIR });
      // A path-hazardous name fails CLOSED. An INERT one is merely a name nobody
      // has ever used, and `retireOrphanedBook`'s standing contract for those is
      // `ok: true, orphanFound: false` having written nothing — asserting `false`
      // here would demand a refusal the module does not owe, and would pass
      // equally against a build that refused EVERY name.
      if (TRAVERSAL_USERNAMES.includes(hostile) || TRIMS_TO_A_VALID_NAME.includes(hostile)) {
        expect(receipt.ok, `should have failed closed: ${JSON.stringify(hostile)}`).toBe(false);
      }
      // The claim that holds for ALL of them, and the one that matters: no book
      // was found, so the retirement was never armed.
      expect(receipt.orphanFound, JSON.stringify(hostile)).toBe(false);
      expect(receipt.retiredAt, JSON.stringify(hostile)).toBeNull();
      expect(receipt.quarantinedTo, JSON.stringify(hostile)).toBeNull();
    }

    // The whole tree, not just the victim: a guard that saves `users/richard` and
    // writes a tombstone, a settings quarantine or an empty `orphaned-books/` on
    // its way to the refusal has still touched the box on an anonymous request.
    expect(treeOf(DATA_DIR)).toEqual(before);
    expect(readFileSync(join(DATA_DIR, 'do-not-touch.json'), 'utf-8')).toBe('{"sentinel":true}');
    expect(readFileSync(outsideSentinel, 'utf-8')).toBe('{"sentinel":"outside"}');
  });

  it('the POSITIVE control: a legitimate orphan is STILL retired', async () => {
    // Without this, every assertion above is satisfied by a `retireOrphanedBook`
    // that refuses everything — which passes the security tests and silently
    // re-opens TRA-2410, the recycled-book adoption this module exists for.
    mkdirSync(userDir('qa_tra4475_orphan'), { recursive: true });
    writeFileSync(join(userDir('qa_tra4475_orphan'), 'trades.json'), '{"positions":3}', 'utf-8');

    const receipt = await orphanedBooks.retireOrphanedBook('qa_tra4475_orphan', { dataDir: DATA_DIR });

    expect(receipt.ok).toBe(true);
    expect(receipt.orphanFound).toBe(true);
    expect(receipt.primaryDirExisted).toBe(true);
    expect(receipt.quarantinedTo).not.toBeNull();
    expect(existsSync(userDir('qa_tra4475_orphan'))).toBe(false);
    expect(existsSync(join(DATA_DIR, receipt.quarantinedTo as string))).toBe(true);
  });
});

// ── THE WIRING ────────────────────────────────────────────────────────────────

describe('TRA-4475 — the WIRING (order is the fix; a grammar behind the rename is decoration)', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

  /** Slice one route handler out of `index.ts`. Routes are declared at column 0. */
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
    it(`${route} runs the canonical grammar`, () => {
      const body = routeBody(route);
      expect(body).toContain('acceptUsername(');
      expect(body).toContain(audience);
    });

    it(`${route} RETURNS the refusal (a computed-and-ignored guard is the same bug)`, () => {
      const body = routeBody(route);
      expect(body).toContain('res.status(decision.refusal.status)');
      // Without the `return` the handler falls through and creates the account
      // after sending the 400 — which reads as fixed from the status line alone.
      expect(body).toMatch(/res\.status\(decision\.refusal\.status\)[\s\S]{0,160}?return;/);
    });
  }

  for (const route of ["app.post('/api/auth/signup'", "app.post('/api/admin/users'"]) {
    it(`${route} validates BEFORE it can retire anyone's book`, () => {
      const body = routeBody(route);
      const grammar = body.indexOf('acceptUsername(');
      const reserve = body.indexOf('refuseReservedIdentityWrite(');
      const retire = body.indexOf('retireOrphanedBook(');
      const create = body.indexOf('createUser(');
      expect(retire, 'retireOrphanedBook not found').toBeGreaterThan(-1);
      expect(create, 'createUser not found').toBeGreaterThan(-1);
      // THE fix. A 400 written after the rename is a destructive no-op with a
      // status line on it.
      expect(grammar).toBeLessThan(retire);
      expect(grammar).toBeLessThan(create);
      // …and ahead of the reserve too, so the traversal SPELLING of an operator
      // book never reaches a guard that is exact set membership on the name.
      expect(grammar).toBeLessThan(reserve);
    });
  }

  it('PATCH /api/admin/users/:username validates `newUsername`, never the path param', () => {
    const body = routeBody("app.patch('/api/admin/users/:username'");
    // The path param is the EXISTING name and a lookup key. Validating it turns a
    // tightened grammar into a lockout for every legacy account.
    expect(body).toMatch(/acceptUsername\(\{\s*name:\s*newUsername/);
    expect(body).not.toMatch(/acceptUsername\(\{\s*name:\s*username\b/);
    const grammar = body.indexOf('acceptUsername(');
    const update = body.indexOf('updateUser(');
    expect(update).toBeGreaterThan(-1);
    expect(grammar).toBeLessThan(update);
  });

  it('the validated name is the one that flows downstream — no CREATE route re-uses the raw body value', () => {
    // The half that is easy to lose in a later edit: consult the grammar, then
    // keep passing `username.trim()`. Everything after the guard has to be keyed
    // on the exact string that was checked, or "validated" and "stored" drift and
    // the gap re-opens without any guard being removed.
    //
    // Scoped to the two CREATE routes: on those, `username` IS the body value and
    // every use of it downstream is a defect. The PATCH route is different in
    // kind and is asserted separately below.
    for (const route of ["app.post('/api/auth/signup'", "app.post('/api/admin/users'"]) {
      const body = routeBody(route);
      const offenders = body
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => !line.startsWith('//'))
        .filter(({ line }) =>
          /\b(retireOrphanedBook|createUser|provisionUser|getUser|createToken|sendWelcomeEmail|refuseReservedIdentityWrite)\s*\(\s*\{?\s*(name:\s*)?username\b/.test(
            line,
          ),
        );
      expect(offenders.map((o) => `${route} L${o.n}: ${o.line}`)).toEqual([]);
    }
  });

  it('PATCH writes the VALIDATED new name, while still looking the account up by its raw path param', () => {
    const body = routeBody("app.patch('/api/admin/users/:username'");
    // Both halves in one line, and they are different in kind: arg 1 is the
    // lookup key (must stay raw — it is how a legacy account is found at all),
    // the `username:` field in arg 2 is the name being WRITTEN (must be the
    // validated one). Getting these backwards is a lockout in one direction and
    // this ticket's bug in the other.
    expect(body).toMatch(/updateUser\(username,\s*\{\s*email,\s*username:\s*cleanNewUsername\s*\}\)/);
  });

  it('the admin RENAME limb is disabled (audit H3), and the 409 is the LAST gate', () => {
    const body = routeBody("app.patch('/api/admin/users/:username'");
    const grammar = body.indexOf('acceptUsername(');
    const reserve = body.indexOf('refuseReservedIdentityWrite(');
    const disabled = body.indexOf("cleanNewUsername !== undefined && cleanNewUsername !== username");
    const update = body.indexOf('updateUser(');
    expect(disabled, 'the H3 rename-disabled gate is gone').toBeGreaterThan(-1);
    // Ordering is the point. If the 409 came FIRST, the grammar and the TRA-2508
    // reserve would be dead code on this route, and whoever re-enables the rename
    // by deleting one block would re-enable it onto an UNGUARDED path.
    expect(grammar).toBeLessThan(disabled);
    expect(reserve).toBeLessThan(disabled);
    expect(disabled).toBeLessThan(update);
  });

  it('the admin EMAIL limb is NOT disabled — the 409 is scoped to a name CHANGE', () => {
    // 409ing an ordinary email edit would be an outage, and this route's email
    // half is the half that actually works.
    const body = routeBody("app.patch('/api/admin/users/:username'");
    expect(body).toMatch(/if \(cleanNewUsername !== undefined && cleanNewUsername !== username\) \{/);
    expect(body).toMatch(/updateUser\(username,\s*\{\s*email,/);
  });

  it('no route re-implements the grammar inline', () => {
    // The failure this module exists to prevent: a fourth identity-write lands
    // with its own copy of the rule, the two spellings drift, and the drift is
    // invisible because both look correct in review.
    const inline = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => !line.startsWith('//'))
      .filter(({ line }) => /\[A-Za-z0-9\]\[A-Za-z0-9\._-\]/.test(line));
    expect(inline.map((b) => `L${b.n}: ${b.line}`)).toEqual([]);
  });

  it('the path BUILDERS go through the backstop, not through a bare join', () => {
    // The second layer. If either of these reverts to `join(root,'users',name)`
    // the ADVERSARY block above is the only thing left, and it only covers the
    // signup path.
    for (const file of ['orphaned-books.ts', 'user-context.ts']) {
      const body = readFileSync(join(__dirname, file), 'utf-8');
      expect(body, file).toContain('assertContainedUserDir(');
      expect(body, file).not.toMatch(/return join\((\w+), 'users', username\);/);
    }
  });
});
