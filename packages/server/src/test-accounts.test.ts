import { describe, it, expect } from 'vitest';
import { isTestAccount, excludeTestAccountRows, TEST_ACCOUNT_PREFIX_ENV } from './test-accounts.js';

// TRA-1475 — the QA/test-account classifier drives the firm-wide DESK de-noise.

describe('isTestAccount — built-in patterns', () => {
  it('flags qa*, ctoverify*, monitor_qa (case-insensitive)', () => {
    for (const name of ['qa', 'qa1', 'qaVerify', 'QA_bot', 'ctoverify', 'ctoverify_2', 'monitor_qa', 'MONITOR_QA']) {
      expect(isTestAccount(name), name).toBe(true);
    }
  });

  it('keeps real books that merely CONTAIN a pattern substring', () => {
    // anchored at the start, so these are NOT test accounts
    for (const name of ['aqua', 'monitorly', 'richard', 'enock', 'my_qa_notes', 'acme']) {
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
