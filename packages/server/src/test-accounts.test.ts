import { describe, it, expect } from 'vitest';
import {
  isTestAccount,
  isTestEmail,
  excludeTestAccountRows,
  unrecognisedDeskBooks,
  KNOWN_DESK_BOOKS,
  TEST_ACCOUNT_PREFIX_ENV,
  testAccountClassifierIdentity, // TRA-2948
} from './test-accounts.js';

// TRA-1475 — the QA/test-account classifier drives the firm-wide DESK de-noise.

describe('isTestAccount — built-in patterns', () => {
  it('flags qa*, ctoverify*, monitor_qa, qtverify* (case-insensitive)', () => {
    for (const name of ['qa', 'qa1', 'qaVerify', 'QA_bot', 'ctoverify', 'ctoverify_2', 'monitor_qa', 'MONITOR_QA', 'qtverify', 'QtVerify_2']) {
      expect(isTestAccount(name), name).toBe(true);
    }
  });

  // TRA-2488 — one case per KNOWN fixture-name family, each a real prod name.
  // When a loop invents a new prefix, add its family here; a fixture book whose
  // name matches no family silently enters the firm-wide DESK number (that is
  // exactly how `qtverify_*` slipped in — `qt`, not `qa`, and signed up on
  // `@example.com` so the TRA-1949 email rule missed it too).
  it('covers every known fixture-name family', () => {
    const families: Record<string, string> = {
      qa_reg: 'qa_reg_1751234567',
      qa_tra: 'qa_tra1475_1783821169',
      qa_mirror: 'qa_mirror_1578_38096',
      ctoverify: 'ctoverify_qa_tra2406b',
      monitor_qa: 'monitor_qa',
      qtverify: 'qtverify_1785048357', // TRA-2488 — QuantTrader verification fleet
      // TRA-2524 — the three that were MEASURED inside the board-facing fold on
      // live `9e1b1123` (6 books visible, 3 of them fixtures). Real prod names.
      tra_ticket: 'tra2339v66f17374', // TRA-2339 verification book
      ceo_ticket: 'ceo2251v130001', // TRA-2251 CEO verification book
      qtprobe: 'qtprobe3', // QuantTrader probe — `qtprobe`, not `qtverify`
    };
    for (const [family, name] of Object.entries(families)) {
      expect(isTestAccount(name), `${family} → ${name}`).toBe(true);
      // and the email must NOT be what saves it — classify on the username alone
      expect(isTestAccount(name, {}, `${name}@example.com`), `${family} on @example.com`).toBe(true);
    }
  });

  it('keeps real books that merely CONTAIN a pattern substring', () => {
    // anchored at the start, so these are NOT test accounts
    // `qtrader` — `^qtverify` must not swallow every `qt*` book (TRA-2488)
    for (const name of ['aqua', 'monitorly', 'richard', 'enock', 'my_qa_notes', 'acme', 'qtrader', 'my_qtverify']) {
      expect(isTestAccount(name), name).toBe(false);
    }
  });

  // TRA-2524 — the new patterns all require a DIGIT after the role/ticket slug
  // precisely so they cannot swallow a real book. This is the blast-radius pin:
  // widening `^ceo\d` to `^ceo` would move any book named for a person's role
  // out of the firm-wide desk number, which is a P&L-visible change.
  it('the TRA-2524 role/ticket patterns need a digit — bare slugs stay real books', () => {
    for (const name of ['ceo', 'cto', 'cfo', 'qt', 'tra', 'leaddev', 'traderjoe', 'ctotrader', 'cfo_richard', 'qtprobst']) {
      expect(isTestAccount(name), name).toBe(false);
    }
  });

  it('treats empty / blank / non-string as not-a-test-account', () => {
    expect(isTestAccount('')).toBe(false);
    expect(isTestAccount('   ')).toBe(false);
    // defensive: callers may hand us a stray non-string
    expect(isTestAccount(undefined as unknown as string)).toBe(false);
  });
});

describe('isTestAccount — TRA-1949 @qa.test email rule', () => {
  it('flags a book whose email ends @qa.test even with a non-test username', () => {
    expect(isTestAccount('richard', process.env, 'richard@qa.test')).toBe(true);
    expect(isTestAccount('richard', process.env, 'RICHARD@QA.TEST')).toBe(true);
    // real email → not a test book
    expect(isTestAccount('richard', process.env, 'richard@example.com')).toBe(false);
    // no email → falls back to username classification only
    expect(isTestAccount('richard')).toBe(false);
  });

  it('isTestEmail matches only the @qa.test suffix', () => {
    expect(isTestEmail('a@qa.test')).toBe(true);
    expect(isTestEmail('a@qa.test.evil.com')).toBe(false);
    // ⚠ TRA-2485 pin — this stays FALSE on purpose. Mail suppression widened
    // to all reserved domains via a SEPARATE predicate (`isUndeliverableEmail`,
    // undeliverable-email.ts). Widening THIS one instead would silently move
    // every `@example.com` book into the test population and out of the
    // firm-wide desk fold (TRA-1949/TRA-1475) — a P&L-visible change. If this
    // assertion is in your way, you are editing the wrong predicate.
    expect(isTestEmail('a@example.com')).toBe(false);
    expect(isTestEmail(undefined)).toBe(false);
  });
});

describe('isTestAccount — env-configurable prefixes', () => {
  it('flags extra prefixes from TEST_ACCOUNT_PREFIXES (case-insensitive, comma-split)', () => {
    const env = { [TEST_ACCOUNT_PREFIX_ENV]: 'loadtest, Demo_bot ,,  ' };
    expect(isTestAccount('loadtest7', env)).toBe(true);
    expect(isTestAccount('demo_bot_3', env)).toBe(true);
    expect(isTestAccount('richard', env)).toBe(false);
    // blank list entries are ignored (do not match everything)
    expect(isTestAccount('anything', { [TEST_ACCOUNT_PREFIX_ENV]: '  ,  ' })).toBe(false);
  });
});

// ─── TRA-2524 — the instrument, not the patch ────────────────────────────────
//
// Adding patterns fixes the three fixtures that were MEASURED in the fold. It
// does nothing about the fourth naming convention nobody has invented yet — the
// denylist is reactive by construction (TRA-1475 → TRA-1949 → TRA-2488 → here),
// and the failure is silent: a fixture book's P&L reads as ordinary desk P&L.
// `unrecognisedDeskBooks` is the part that makes the NEXT one surface on its own.
describe('unrecognisedDeskBooks — TRA-2524 desk-fold roster instrument', () => {
  const LIVE_FOLD_9E1B1123 = ['admin', 'Richard', 'enock', 'ceo2251v130001', 'qtprobe3', 'tra2339v66f17374'];

  // THE POSITIVE MARK. Run FIRST and asserted on the exact bytes, because every
  // "expect([])" below is vacuous unless a broken/deleted instrument can be seen
  // to differ from a healthy one. Against the PRE-fix pattern set the three
  // fixtures were unrecognised — that is the state this ticket found.
  it('reports the books that are neither test-classified nor vouched for', () => {
    const invented = [...LIVE_FOLD_9E1B1123, 'cfo9999v1', 'someNewFixtureScheme_42'];
    // `cfo9999v1` IS caught by the new role pattern; the invented scheme is not.
    expect(unrecognisedDeskBooks(invented)).toEqual(['someNewFixtureScheme_42']);
    expect(unrecognisedDeskBooks(invented)).toHaveLength(1);
  });

  it('reads clean on the live 2026-07-29 fold ONLY because the patterns now reach the fixtures', () => {
    expect(unrecognisedDeskBooks(LIVE_FOLD_9E1B1123)).toEqual([]);
    // …and the three fixtures are the reason: they are classified, not vouched.
    for (const fixture of ['ceo2251v130001', 'qtprobe3', 'tra2339v66f17374']) {
      expect(isTestAccount(fixture), fixture).toBe(true);
      expect(KNOWN_DESK_BOOKS).not.toContain(fixture);
    }
  });

  it('matches the roster case-insensitively and ignores blanks', () => {
    expect(unrecognisedDeskBooks(['ADMIN', '  Enock  ', '', '   '])).toEqual([]);
  });

  // ⚠ USERNAME-ONLY, on purpose. Every board-facing call site passes username
  // alone, so a book the TRA-1949 email arm would catch is STILL in the desk
  // number. The instrument must report it rather than quietly agreeing.
  it('does NOT let an @qa.test email excuse a book the P&L fold still counts', () => {
    expect(unrecognisedDeskBooks(['mysteryBook'])).toEqual(['mysteryBook']);
    expect(isTestAccount('mysteryBook', process.env, 'mysteryBook@qa.test')).toBe(true);
  });

  it('honours TEST_ACCOUNT_PREFIXES so an env-classified book is not double-reported', () => {
    const env = { [TEST_ACCOUNT_PREFIX_ENV]: 'loadtest' } as unknown as NodeJS.ProcessEnv;
    expect(unrecognisedDeskBooks(['loadtest7'], env)).toEqual([]);
    expect(unrecognisedDeskBooks(['loadtest7'], {} as NodeJS.ProcessEnv)).toEqual(['loadtest7']);
  });
});

describe('excludeTestAccountRows — DESK fold filter', () => {
  const rows = [
    { id: '1', account: 'qa17' },
    { id: '2', account: 'richard' },
    { id: '3', account: 'ctoverify_2' },
    { id: '4' }, // legacy / un-owned — kept
    { id: '5', account: 'monitor_qa' },
  ];

  it('drops QA/test-owned rows, keeps real + un-owned rows', () => {
    const kept = excludeTestAccountRows(rows).map((r) => r.id);
    expect(kept).toEqual(['2', '4']);
  });

  it('includeTest keeps every row', () => {
    expect(excludeTestAccountRows(rows, { includeTest: true }).map((r) => r.id)).toEqual([
      '1', '2', '3', '4', '5',
    ]);
  });

  it('honours the env prefix list', () => {
    const env = { [TEST_ACCOUNT_PREFIX_ENV]: 'richard' } as NodeJS.ProcessEnv;
    const kept = excludeTestAccountRows(rows, { env }).map((r) => r.id);
    // richard is now a test prefix too → only the un-owned row survives
    expect(kept).toEqual(['4']);
  });
});

// TRA-2948 — the classifier IDENTITY. A pattern-set edit silently restates every
// previously published desk number (class is recomputed at read time from the frozen
// account string), so every class-partitioned figure now carries the hash of the
// classifier it was computed under. These tests pin the identity's contract: it moves
// exactly when the effective classifier moves, and only then.
describe('testAccountClassifierIdentity (TRA-2948)', () => {
  it('is stable across calls under one env', () => {
    const env = { [TEST_ACCOUNT_PREFIX_ENV]: 'loadtest,demo_bot' };
    expect(testAccountClassifierIdentity(env)).toEqual(testAccountClassifierIdentity(env));
  });

  it('MOVES when a prefix is added — the same edit that flips a classification', () => {
    const before = testAccountClassifierIdentity({});
    const after = testAccountClassifierIdentity({ [TEST_ACCOUNT_PREFIX_ENV]: 'widget' });
    // the classification flips…
    expect(isTestAccount('widget_book7', {})).toBe(false);
    expect(isTestAccount('widget_book7', { [TEST_ACCOUNT_PREFIX_ENV]: 'widget' })).toBe(true);
    // …and the identity flips WITH it, so the restatement is nameable
    expect(after.hash).not.toBe(before.hash);
    expect(after.extraPrefixes).toEqual(['widget']);
    expect(before.extraPrefixes).toEqual([]);
  });

  it('does NOT move on a reorder/duplicate of a comma list that classifies identically', () => {
    const a = testAccountClassifierIdentity({ [TEST_ACCOUNT_PREFIX_ENV]: 'loadtest,demo_bot' });
    const b = testAccountClassifierIdentity({ [TEST_ACCOUNT_PREFIX_ENV]: ' demo_bot , loadtest ,demo_bot' });
    expect(b.hash).toBe(a.hash);
  });

  it('publishes the effective inputs, not just the hash', () => {
    const id = testAccountClassifierIdentity({});
    expect(id.builtinPatterns).toContain('/^qa/i');
    expect(id.builtinPatterns.length).toBeGreaterThanOrEqual(7);
    expect(id.emailSuffix).toBe('@qa.test');
    // the hash is the 8-hex-char FNV-1a form — a shape a consumer can assert
    expect(id.hash).toMatch(/^[0-9a-f]{8}$/);
  });
});
