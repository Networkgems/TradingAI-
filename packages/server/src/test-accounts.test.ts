import { describe, it, expect } from 'vitest';
import {
  isTestAccount,
  isTestEmail,
  excludeTestAccountRows,
  TEST_ACCOUNT_PREFIX_ENV,
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
