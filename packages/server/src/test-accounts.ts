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
 * TRA-2554 — this list NOW gates the fold, but only when
 * {@link DESK_FOLD_ALLOWLIST_ENV} is armed. Under the default `denylist` mode it
 * still only feeds {@link unrecognisedDeskBooks}, which OBSERVES.
 */
export const KNOWN_DESK_BOOKS: readonly string[] = ['admin', 'richard', 'enock'];

/**
 * TRA-2554 — true iff `account` is on {@link KNOWN_DESK_BOOKS}.
 *
 * ⚠ Compared TRIMMED + LOWERCASED, and that is load-bearing rather than tidy:
 * the live journal's second-largest desk account is stamped **`Richard`** with a
 * capital R (50 rows on `GET /api/admin/desk-roster`, 2026-08-06). A
 * case-sensitive `KNOWN_DESK_BOOKS.includes(r.account)` would drop all 50 the
 * moment the allowlist arms — a real book silently leaving the board number,
 * which is the sign-flipped failure this ticket exists to prevent.
 */
export function isRosterDeskBook(account: string): boolean {
  if (typeof account !== 'string') return false;
  const name = account.trim().toLowerCase();
  if (name.length === 0) return false;
  return KNOWN_DESK_BOOKS.some((n) => n.trim().toLowerCase() === name);
}

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
  /**
   * TRA-2554 — the fold actually in force ({@link resolveDeskFoldMode}).
   *
   * This field is ALWAYS reported but enters {@link hash} only when it is
   * `allowlist`, and that asymmetry is deliberate: under `denylist` the
   * partition is bit-for-bit TRA-1475's, so folding the field in would move
   * every hash and falsely claim a restatement of every figure published to
   * date. Under `allowlist` the partition genuinely moves, so the hash moves
   * with it.
   */
  deskFoldMode: DeskFoldMode;
  /**
   * TRA-2554 — {@link KNOWN_DESK_BOOKS} normalized (trimmed, lowercased,
   * sorted), reported always. It enters {@link hash} only under `allowlist`,
   * where — and only where — editing the roster moves rows between KEEP and
   * DROP. Under `denylist` it feeds the observer alone and restates nothing,
   * which is why TRA-2948 excluded it.
   */
  knownDeskBooks: string[];
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
  const deskFoldMode = resolveDeskFoldMode(env);
  const knownDeskBooks = [...new Set(KNOWN_DESK_BOOKS.map((n) => n.trim().toLowerCase()))].sort();
  // TRA-2554 — EMPTY under `denylist`, so the canonical string below stays
  // byte-identical to TRA-2948's and no hash published to date moves for a
  // partition that did not move. Under `allowlist` the roster DOES move rows
  // between KEEP and DROP, so it joins the identity. See
  // `TestAccountClassifierIdentity.deskFoldMode`.
  const deskFoldFields = deskFoldMode === 'allowlist'
    ? [deskFoldMode, knownDeskBooks.join(',')]
    : [];
  // NUL as the element separator, double-NUL between fields: neither can occur
  // in a regex source read from this file or in a trimmed env prefix, so no two
  // distinct input sets can serialize to one string.
  const canonical = [
    builtinPatterns.join('\u0000'),
    prefixes.join('\u0000'),
    TEST_ACCOUNT_EMAIL_SUFFIX,
    ...deskFoldFields,
  ].join('\u0000\u0000');
  return {
    hash: fnv1a32(canonical),
    builtinPatterns,
    extraPrefixes: prefixes,
    emailSuffix: TEST_ACCOUNT_EMAIL_SUFFIX,
    deskFoldMode,
    knownDeskBooks,
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
 * TRA-2554 — the four classes a journal row's `account` can fall into. Named,
 * exhaustive and exported because the whole class of bug this ticket closes is
 * a KEEP/DROP decision that nothing on the wire could name.
 */
export type DeskFoldClass =
  /** No `account` at all — pre-TRA-1475 rows. Unclassifiable by ANY roster. */
  | 'unattributed'
  /** {@link isTestAccount} — QA/fixture churn. */
  | 'test'
  /** On {@link KNOWN_DESK_BOOKS} — vouched for. */
  | 'roster'
  /** Has an account, is not a fixture, and NOBODY has vouched for it. */
  | 'unrecognised';

/** TRA-2554 — the two folds. `denylist` is TRA-1475's shipped behaviour. */
export type DeskFoldMode = 'denylist' | 'allowlist';

/**
 * TRA-2554 — env var arming the allowlist fold. Accepts `1` / `true` / `on` /
 * `yes` (case-insensitive, trimmed); ANY other value — including absent, blank
 * or an unparseable string — resolves to `denylist`.
 *
 * Fails CLOSED onto today's behaviour deliberately: this flag moves a
 * board-facing P&L number, so a typo must leave the published number where it
 * is rather than silently re-partition the journal.
 */
export const DESK_FOLD_ALLOWLIST_ENV = 'DESK_FOLD_ALLOWLIST';

/** TRA-2554 — resolve {@link DESK_FOLD_ALLOWLIST_ENV}. See its doc for the fail-closed rule. */
export function resolveDeskFoldMode(env: NodeJS.ProcessEnv = process.env): DeskFoldMode {
  const raw = env[DESK_FOLD_ALLOWLIST_ENV];
  if (typeof raw !== 'string') return 'denylist';
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes' ? 'allowlist' : 'denylist';
}

/**
 * TRA-2554 — THE decision table. Written as data, not as expression order in a
 * filter, because CTO item 1 on this ticket is explicit: the KEEP rule for
 * account-less rows must be *its own named rule with its own test*, not an
 * incidental consequence of `r.account && …` short-circuiting.
 *
 * ⚠ `unattributed: true` in BOTH rows is the 2,192-row rule. 2,192 of the 2,690
 * live journal rows (81%, and a CLOSED historical set — every row written since
 * the TRA-1475 schema change carries an `account`) have no `account` and are
 * unclassifiable by any roster. A naive inversion —
 * `KNOWN_DESK_BOOKS.includes(r.account)` — evaluates `false` for a blank account
 * and drops all 2,192 in one commit: 81% of the journal silently leaving the
 * board number. `unrecognisedDeskAccountCount` reads a clean `0` either way,
 * because a row with no account can never BE an unrecognised account, so the
 * instrument cannot catch it. This table is what catches it.
 *
 * ⚠ The two rows differ in EXACTLY ONE cell — `unrecognised`. That is the
 * equivalence theorem the pre-deploy acceptance rests on: the moved set is
 * exactly the unrecognised rows, so `delta == 0` on `GET /api/reports/desk`
 * holds iff the journal carries zero unrecognised rows at fold time.
 */
export const DESK_FOLD_DECISIONS: Readonly<
  Record<DeskFoldMode, Readonly<Record<DeskFoldClass, boolean>>>
> = {
  denylist: { unattributed: true, test: false, roster: true, unrecognised: true },
  allowlist: { unattributed: true, test: false, roster: true, unrecognised: false },
};

/** TRA-2554 — classify one row's `account`. Total over the four classes. */
export function classifyDeskFoldAccount(
  account: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DeskFoldClass {
  const name = typeof account === 'string' ? account.trim() : '';
  if (name.length === 0) return 'unattributed';
  if (isTestAccount(name, env)) return 'test';
  if (isRosterDeskBook(name)) return 'roster';
  return 'unrecognised';
}

/** TRA-2554 — the fold, plus the census that explains it. */
export interface DeskFoldResult<T> {
  /** The fold actually applied — echo this beside any number folded off it. */
  mode: DeskFoldMode;
  /** The kept rows, in input order. */
  kept: T[];
  /** Row counts per class. Sums to the input length, always. */
  census: Record<DeskFoldClass, number>;
  /**
   * Distinct unrecognised account names, first-seen case, de-duplicated
   * case-insensitively. NON-EMPTY under `allowlist` means real rows were
   * dropped that the denylist kept — the drop is enumerated, NEVER silent.
   * That is the failing state this class (TRA-1475 → 1949 → 2488 → 2524) has
   * never had.
   */
  unrecognisedAccounts: string[];
  /** Rows dropped SOLELY because of the inversion — 0 under `denylist`. */
  unrecognisedRowsDropped: number;
}

/**
 * TRA-2554 — apply the desk fold and census it. One implementation for both
 * modes, driven by {@link DESK_FOLD_DECISIONS}.
 *
 * `includeTest: true` (the routes' `?includeTest=1`) keeps EVERY row under both
 * modes — a debugging query string must not be able to change a class boundary.
 * The census is still computed, so the classes stay readable while debugging.
 */
export function foldDeskRows<T extends { account?: string }>(
  rows: readonly T[],
  opts: { includeTest?: boolean; env?: NodeJS.ProcessEnv; mode?: DeskFoldMode } = {},
): DeskFoldResult<T> {
  const env = opts.env ?? process.env;
  const mode = opts.mode ?? resolveDeskFoldMode(env);
  const decisions = DESK_FOLD_DECISIONS[mode];
  const census: Record<DeskFoldClass, number> = {
    unattributed: 0,
    test: 0,
    roster: 0,
    unrecognised: 0,
  };
  const unrecognisedByKey = new Map<string, string>();
  const kept: T[] = [];
  let unrecognisedRowsDropped = 0;
  for (const row of rows) {
    const cls = classifyDeskFoldAccount(row.account, env);
    census[cls] += 1;
    if (cls === 'unrecognised') {
      const raw = (row.account as string).trim();
      const key = raw.toLowerCase();
      if (!unrecognisedByKey.has(key)) unrecognisedByKey.set(key, raw);
    }
    if (opts.includeTest === true || decisions[cls]) {
      kept.push(row);
      continue;
    }
    if (cls === 'unrecognised') unrecognisedRowsDropped += 1;
  }
  return {
    mode,
    kept,
    census,
    unrecognisedAccounts: [...unrecognisedByKey.values()],
    unrecognisedRowsDropped,
  };
}

/**
 * TRA-1475 — drop journal rows owned by a QA/test account from the DESK fold.
 * Rows with NO `account` (pre-TRA-1475 / un-owned opens) are KEPT — they can't
 * be classified, so excluding them would silently shrink the historical desk
 * number. Pass `includeTest: true` (the route's `?includeTest=1`) to keep every
 * row for debugging. Generic over any `{ account? }`-shaped row so the fold
 * filter and its unit test share one implementation.
 *
 * TRA-2554 — now a thin projection of {@link foldDeskRows}, so the KEEP/DROP
 * decision has exactly one implementation and every existing call site
 * (`reports/desk-calendar.ts`, `model-facing-journal.ts`) inherits the armed
 * mode without having to remember the flag. Behaviour under the default
 * `denylist` mode is unchanged. Callers that need the census — or that must
 * ENUMERATE what the inversion dropped — should call `foldDeskRows` directly.
 */
export function excludeTestAccountRows<T extends { account?: string }>(
  rows: readonly T[],
  opts: { includeTest?: boolean; env?: NodeJS.ProcessEnv } = {},
): T[] {
  return foldDeskRows(rows, opts).kept;
}
