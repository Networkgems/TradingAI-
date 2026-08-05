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
 * TRA-1949 — the throwaway QA books are also all provisioned with an
 * `@qa.test` signup email, so a book is a test book if EITHER its username
 * matches a test pattern OR its email carries this suffix. Matched
 * case-insensitively as `endsWith`. The username prefix already catches the
 * current fleet (`qa_reg_*`, `qa_tra1475_*`, `qa_mirror_*` → `^qa`); the email
 * rule keeps the classifier complete for any caller that has the email but a
 * non-`qa`-prefixed username.
 */
export const TEST_ACCOUNT_EMAIL_SUFFIX = '@qa.test';

/**
 * Built-in QA/test-account name patterns. Anchored at the start so a real book
 * whose name merely CONTAINS one of these substrings (e.g. `aqua`, `monitorly`)
 * is not misclassified.
 */
const BUILTIN_TEST_PATTERNS: readonly RegExp[] = [
  /^qa/i, // qa, qa1, qaverify, …
  /^ctoverify/i, // ctoverify, ctoverify_2, …
  /^monitor_qa/i, // the autonomous-loop monitor book
  // TRA-2488 — the QuantTrader verification fleet (`qtverify_<epoch>`, signed up
  // on `@example.com` so neither `^qa` nor the TRA-1949 email rule catches it).
  /^qtverify/i,
  // TRA-2524 — three more fixture books were measured INSIDE the board-facing
  // desk fold (6 books visible, 3 of them throwaway verification accounts). Each
  // named itself after the thing it was verifying rather than after a QA prefix,
  // so nothing above reached it. Anchored, and each requires a DIGIT so a real
  // book called `ceo`, `qt`, or `tra` is untouched.
  /^tra\d/i, // ticket-numbered verification book — `tra2339v66f17374`
  /^(ceo|cto|cfo|qt|leaddev)\d/i, // agent-role + ticket number — `ceo2251v130001`
  /^qtprobe/i, // the QuantTrader probe fleet — `qtprobe3` (`qtprobe`, not `qtverify`)
];

/**
 * TRA-2524 — the ALLOWLIST half, and the reason this module now has one.
 *
 * {@link BUILTIN_TEST_PATTERNS} is a denylist of naming conventions, extended
 * reactively one ticket at a time (TRA-1475 → TRA-1949 → TRA-2488 → TRA-2524).
 * Every verification-book naming scheme nobody has seen yet is in the firm-wide
 * DESK number BY DEFAULT, and the failure is silent: a fixture book contributes
 * P&L that reads as ordinary desk P&L. Adding patterns fixes the instance; it
 * does not make the NEXT one visible.
 *
 * These are the operator/live books on bqb1 — a short, stable, known set
 * (measured 2026-07-29 against live `9e1b1123`, which reported exactly 6 books
 * in the fold: these three plus the three fixtures the patterns above now
 * catch). Compared trimmed + lowercased.
 *
 * This list does NOT gate the fold — widening the desk filter to an allowlist is
 * a separate, larger change (TRA-2524 option 2, explicitly NOT taken here). It
 * feeds {@link unrecognisedDeskBooks}, which only OBSERVES.
 */
export const KNOWN_DESK_BOOKS: readonly string[] = ['admin', 'richard', 'enock'];

/**
 * TRA-2524 — the missing instrument. Returns the usernames sitting in the
 * board-facing DESK fold that are neither classified test books nor on
 * {@link KNOWN_DESK_BOOKS}: i.e. books whose P&L is being counted as desk P&L
 * and which NOBODY has vouched for. Empty is the healthy state; non-empty means
 * a book joined the fold and wants classifying, one way or the other.
 *
 * ⚠ Classifies on USERNAME ONLY — deliberately, and not as an oversight. The
 * TRA-1949 email arm participates in NO P&L path: every board-facing call site
 * (`excludeTestAccountRows` here, `option-spread-cost.ts` fixture/desk
 * partition, `health-routes.ts:2346`) passes username alone, and `email` is
 * optional. A book the email arm would catch is therefore STILL in the desk
 * number, so this instrument must report it. Classifying it here on the email
 * would hide exactly the case the instrument exists to surface.
 */
export function unrecognisedDeskBooks(
  usernames: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const known = new Set(KNOWN_DESK_BOOKS.map((n) => n.trim().toLowerCase()));
  return usernames
    .filter((u) => typeof u === 'string' && u.trim().length > 0)
    .filter((u) => !isTestAccount(u, env))
    .filter((u) => !known.has(u.trim().toLowerCase()));
}

/**
 * TRA-2948 — the IDENTITY of the effective classifier: exactly the inputs that
 * determine what {@link isTestAccount} answers, and nothing else.
 *
 * A journal row's `account` string is frozen at write time but its CLASS is
 * recomputed at read time, so editing {@link BUILTIN_TEST_PATTERNS} or
 * {@link TEST_ACCOUNT_PREFIX_ENV} silently restates every previously published
 * desk number (TRA-2553 measured the last such restatement at $0.00 — by luck,
 * not by design). Two figures computed under different classifiers are not
 * comparable, and before this identity existed nothing at the point of
 * comparison said so. Publish this beside any class-partitioned figure; stamp
 * `hash` on any record that freezes a class at decision time.
 *
 * {@link KNOWN_DESK_BOOKS} is deliberately EXCLUDED: it feeds the
 * `unrecognisedDeskBooks` observer only and moves no row between classes, so
 * folding it in would make the hash restate a change that restates nothing.
 */
export interface TestAccountClassifierIdentity {
  /**
   * FNV-1a 32-bit hex over the canonical serialization of the fields below.
   * Two payloads whose class partitions were computed under different pattern
   * sets carry different hashes — that is the entire contract. Not a security
   * hash; a version tag that nobody has to remember to bump.
   */
  hash: string;
  /** Source text of every builtin pattern, in match order (`/^qa/i`, …). */
  builtinPatterns: string[];
  /**
   * The {@link TEST_ACCOUNT_PREFIX_ENV} prefixes in effect, normalized the same
   * way the predicate consumes them (trimmed, lowercased, de-blanked), then
   * sorted + deduped: reordering a comma list that classifies identically is
   * NOT a classifier change and must not read as one.
   */
  extraPrefixes: string[];
  emailSuffix: string;
}

/** FNV-1a 32-bit, hex-padded. Pure — this module must stay import-free. */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** TRA-2948 — see {@link TestAccountClassifierIdentity}. */
export function testAccountClassifierIdentity(
  env: NodeJS.ProcessEnv = process.env,
): TestAccountClassifierIdentity {
  const builtinPatterns = BUILTIN_TEST_PATTERNS.map((re) => String(re));
  const prefixes = [...new Set(extraPrefixes(env))].sort();
  // NUL as the element separator, double-NUL between fields: neither can occur
  // in a regex source read from this file or in a trimmed env prefix, so no two
  // distinct input sets can serialize to one string.
  const canonical = [
    builtinPatterns.join('\u0000'),
    prefixes.join('\u0000'),
    TEST_ACCOUNT_EMAIL_SUFFIX,
  ].join('\u0000\u0000');
  return {
    hash: fnv1a32(canonical),
    builtinPatterns,
    extraPrefixes: prefixes,
    emailSuffix: TEST_ACCOUNT_EMAIL_SUFFIX,
  };
}

/** Parse the env prefix list into a lowercased, de-blanked array. */
function extraPrefixes(env: NodeJS.ProcessEnv): string[] {
  const raw = env[TEST_ACCOUNT_PREFIX_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

/** TRA-1949 — true iff `email` carries the {@link TEST_ACCOUNT_EMAIL_SUFFIX}. */
export function isTestEmail(email: string | undefined): boolean {
  if (typeof email !== 'string') return false;
  return email.trim().toLowerCase().endsWith(TEST_ACCOUNT_EMAIL_SUFFIX);
}

/**
 * True iff the book is a QA/test/throwaway book that should be excluded from
 * the firm-wide DESK number and the board-facing demo-book list. A book is a
 * test book if EITHER its `username` matches a built-in pattern / a
 * {@link TEST_ACCOUNT_PREFIX_ENV} prefix, OR (TRA-1949) its optional `email`
 * ends with {@link TEST_ACCOUNT_EMAIL_SUFFIX}. Empty/blank names with no
 * matching email are NOT test accounts (nothing to classify → keep).
 * Case-insensitive. `email` is optional so existing `(username, env)` callers
 * are unchanged.
 */
export function isTestAccount(
  username: string,
  env: NodeJS.ProcessEnv = process.env,
  email?: string,
): boolean {
  if (isTestEmail(email)) return true;
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
