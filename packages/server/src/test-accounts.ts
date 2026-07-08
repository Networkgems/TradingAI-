// TRA-1475 — centralized QA/test-account classifier.
//
// ~50 of the ~51 prod demo books are throwaway QA/test accounts (`qa*`,
// `ctoverify*`, `monitor_qa`, …) spun up by the autonomous loop, so the
// firm-wide DESK number (`reports/desk-calendar.ts`, `GET /api/reports/desk`)
// summing every demo book's Option-Trade Journal is dominated by test churn.
// This module is the SINGLE source of truth for "is this a test book?" so the
// desk filter and any future admin UI can never drift on the pattern set.
//
// NOTHING here reads a secret or routes an order — it is a pure string
// predicate over a username plus an env-configured prefix list.

/**
 * Env var carrying extra comma-separated test-account prefixes beyond the
 * built-ins, e.g. `TEST_ACCOUNT_PREFIXES=loadtest,demo_bot`. Matched
 * case-insensitively as `startsWith`. Blank/whitespace entries are ignored.
 */
export const TEST_ACCOUNT_PREFIX_ENV = 'TEST_ACCOUNT_PREFIXES';

/**
 * Built-in QA/test-account name patterns. Anchored at the start so a real book
 * whose name merely CONTAINS one of these substrings (e.g. `aqua`, `monitorly`)
 * is not misclassified.
 */
const BUILTIN_TEST_PATTERNS: readonly RegExp[] = [
  /^qa/i, // qa, qa1, qaverify, …
  /^ctoverify/i, // ctoverify, ctoverify_2, …
  /^monitor_qa/i, // the autonomous-loop monitor book
];

/** Parse the env prefix list into a lowercased, de-blanked array. */
function extraPrefixes(env: NodeJS.ProcessEnv): string[] {
  const raw = env[TEST_ACCOUNT_PREFIX_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

/**
 * True iff `username` is a QA/test/throwaway book that should be excluded from
 * the firm-wide DESK number. Matches the built-in patterns plus any
 * {@link TEST_ACCOUNT_PREFIX_ENV} prefixes. Empty/blank names are NOT test
 * accounts (nothing to classify → keep). Case-insensitive.
 */
export function isTestAccount(
  username: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof username !== 'string') return false;
  const name = username.trim();
  if (name.length === 0) return false;
  if (BUILTIN_TEST_PATTERNS.some((re) => re.test(name))) return true;
  const lower = name.toLowerCase();
  return extraPrefixes(env).some((p) => lower.startsWith(p));
}

/**
 * TRA-1475 — drop journal rows owned by a QA/test account from the DESK fold.
 * Rows with NO `account` (pre-TRA-1475 / un-owned opens) are KEPT — they can't
 * be classified, so excluding them would silently shrink the historical desk
 * number. Pass `includeTest: true` (the route's `?includeTest=1`) to keep every
 * row for debugging. Generic over any `{ account? }`-shaped row so the fold
 * filter and its unit test share one implementation.
 */
export function excludeTestAccountRows<T extends { account?: string }>(
  rows: readonly T[],
  opts: { includeTest?: boolean; env?: NodeJS.ProcessEnv } = {},
): T[] {
  if (opts.includeTest) return [...rows];
  const env = opts.env ?? process.env;
  return rows.filter((r) => !(r.account && isTestAccount(r.account, env)));
}
