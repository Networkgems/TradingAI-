// TRA-3595 (step 3 of TRA-2906) — the HOST EXECUTION PATH for the one-time
// `tradier-cash-flow.<env>.json` v1→v2 rebuild.
//
// ── Why this module exists at all ────────────────────────────────────────────
//
// TRA-2906's code has been live since 2026-08-14 and its correction has NEVER
// taken effect, because `resolveCashFlowNetByDate` returns a v1 record's stored
// totals unchanged and nothing has ever migrated those records. The migration
// logic itself was written (`scripts/tra2906-rebuild-cash-flow.mjs`) and is
// correct; what did not exist was any way to RUN it on bqb1. It needs
// `DATA_DIR` plus the production Tradier credentials, i.e. the host's own
// process. Measured 2026-09-16 against live bqb1 (`f3ce18b6`, pid 77):
// `/api/health/pnl-reconciliation` publishes `stockLegProbeBrokerFeeUsd: null`
// on 0-of-2117 rows across all 68 engines. That operand is built only from a
// v2-typed record, and a v2 record reads `0` on a quiet day rather than `null`,
// so every book on the host is still v1.
//
// The three candidate paths and why two of them are not paths:
//
//   • A Render SHELL — no agent holds one on bqb1, and requesting one is a
//     standing interactive credential on the money host.
//   • A Render ONE-OFF JOB — runs on a separate instance WITHOUT the service's
//     persistent disk, so it cannot reach `DATA_DIR/users/*/` at all. It would
//     "succeed" against an empty directory, and this script's own fail-closed
//     BLIND on zero records is the only thing that would stop it reporting a
//     completed migration having touched nothing.
//   • BOOT, armed by a deliberate env write — the only in-process path. That
//     is what this module is.
//
// ── Why an env-armed boot one-shot is not the thing TRA-3595 refused ─────────
//
// TRA-3595's description refuses to wire this into boot or the EOD pass,
// because that hands the live host a STANDING automated write to financial
// state — the same posture `autoDeploy=no` and the no-unattended-deploy-train
// rule exist to prevent. The distinction this module preserves: the env value
// IS the arming act, a human writes it, and it is removed afterwards. With the
// var unset (the state on every boot before and after) this code reads one
// directory and writes nothing. There is no schedule, no retry, and no branch
// that arms itself.
//
// ── The two stages, and why the write is not agent-armable ───────────────────
//
//   1. `TRA2906_CASH_FLOW_REBUILD=dry-run` — read-only for every book. Runs the
//      full reproduction control and publishes the measured per-date shift on
//      `/api/health/tra2906-cash-flow-rebuild`. Writes nothing, ever.
//   2. `TRA2906_CASH_FLOW_REBUILD=apply:admin,v0nni` — writes the v2 record for
//      the NAMED books only, after taking a timestamped v1 backup.
//
// A bare `apply` with no book list is INVALID and does nothing. This is the
// TRA-4420 lesson applied before it can cost anything: `scripts/render-redeploy.mjs`
// matched its flags positively, so an unrecognised argument fell through to a
// real deploy of the branch tip and `--help` shipped a build to the money host.
// Here the analogous fall-through would be a WRITE to the only surviving record
// of months of deposits. So the parse matches positively, an unrecognised value
// is `invalid` and is published as such, and `invalid` never degrades to `off`
// (which would read as "not armed" — a lie) nor to `apply`.
//
// ── The safety property is inherited, not re-invented ────────────────────────
//
// Before writing anything this re-derives the legacy totals from the FETCHED
// events under the OLD rule and asserts they reproduce the stored `netByDate`
// date-for-date. That is a positive control on the fetch: a short, truncated or
// unauthorised fetch does not reproduce the stored totals and the book REFUSES.
// Without it the failure mode is writing a record missing months of deposits —
// and a deleted deposit does not look like an error, it looks like a great
// trading day. `netByDate` is the only surviving record of those deposits.
//
// The NEW-rule side is NOT re-implemented here: the "after" numbers come from
// `deriveNetByDateFromEvents`, which is the exact function the Live calendar
// will read through once the record is v2. So the dry run measures the shipped
// behaviour rather than a local model of it, and there is no second copy of the
// classification rule to drift. (The `.mjs` script duplicates the rule because
// it must run standalone; it keeps a self-test pinning the two in agreement.)
//
// ── Fetch failure must read BLIND, not REFUSED ───────────────────────────────
//
// `TradierOptionsClient.listAccountCashEvents` is deliberately NOT used for the
// fetch. It routes through `getJson`, which collapses every non-2xx — 401, 429,
// 5xx — into `null`, and `parseTradierCashEvents(null)` returns `[]`. An empty
// array would then fail the reproduction control and be reported as REFUSED,
// i.e. "the broker's history disagrees with our record", when the truth is "we
// never reached the broker". Those are different findings and must not share an
// outcome. So the HTTP call here is status-preserving and a non-2xx reads BLIND
// — but the rows it does get are handed to the SHIPPED `parseTradierCashEvents`,
// so the parser is not forked either.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from 'fs';
import type { Dirent } from 'fs';
import { join } from 'path';

import { parseTradierCashEvents } from '@trading-app/engine';
import type { TradierCashEvent, TradierEnv } from '@trading-app/engine';

import { deriveNetByDateFromEvents } from './reports/tradier-reconcile.js';

/** The env var that arms this. Unset on every ordinary boot. */
export const TRA2906_REBUILD_ENV_VAR = 'TRA2906_CASH_FLOW_REBUILD';

/**
 * The RECORDING set — every non-trade type the server persists. This is also
 * the set the ORIGINAL (pre-TRA-2906) code treated as cash flow, which is why
 * it doubles as the old classification rule: the defect was precisely that
 * recording and classification were the same set.
 *
 * Duplicated from the engine's private `TRADIER_CASH_EVENT_TYPES` on purpose —
 * that constant is not exported, and more importantly this copy must NOT track
 * it. It is a frozen historical fact: the rule that produced the numbers stored
 * on disk. If someone widens the engine's recording set tomorrow, the stored
 * v1 totals still came from THIS list, and a control derived from the wider one
 * would fail for a reason that has nothing to do with the broker.
 */
const OLD_CASH_FLOW_TYPES: ReadonlySet<string> = new Set([
  'ach', 'wire', 'check', 'journal', 'dividend',
  'interest', 'adjustment', 'fee', 'deposit', 'withdrawal',
]);

/** The rule that produced the STORED v1 totals: bare membership of the set. */
export function isCashFlowUnderOldRule(type: string): boolean {
  return OLD_CASH_FLOW_TYPES.has(String(type).toLowerCase());
}

// ── The arming intent ────────────────────────────────────────────────────────

export type RebuildIntent =
  | { mode: 'off'; raw: string | null }
  | { mode: 'dry-run'; raw: string }
  | { mode: 'apply'; raw: string; books: string[] }
  | { mode: 'invalid'; raw: string; reason: string };

/**
 * Parse `TRA2906_CASH_FLOW_REBUILD` into an intent, matching POSITIVELY.
 *
 * Accepted, and nothing else:
 *   • unset / '' / 'off'      → off
 *   • 'dry-run'               → dry run, every book
 *   • 'apply:<book>[,<book>]' → apply, those books only
 *
 * Everything else is `invalid`. In particular a bare `apply` is invalid: the
 * book list is the target, a write with no named target is the TRA-4420 shape,
 * and "every book" must be said out loud when the verb writes. (`dry-run` takes
 * no list because it cannot write and its whole value is the full inventory.)
 */
export function parseRebuildIntent(raw: string | undefined | null): RebuildIntent {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'off') return { mode: 'off', raw: raw ?? null };
  const lower = value.toLowerCase();
  if (lower === 'dry-run') return { mode: 'dry-run', raw: value };
  if (lower === 'apply') {
    return {
      mode: 'invalid',
      raw: value,
      reason: 'bare `apply` names no book. Use `apply:<book>[,<book>]` — a write with no '
        + 'stated target is how TRA-4420 shipped an unintended deploy to the money host.',
    };
  }
  if (lower.startsWith('apply:')) {
    const books = value
      .slice('apply:'.length)
      .split(',')
      .map((b) => b.trim())
      .filter((b) => b !== '');
    if (books.length === 0) {
      return { mode: 'invalid', raw: value, reason: '`apply:` was given an empty book list.' };
    }
    return { mode: 'apply', raw: value, books };
  }
  return {
    mode: 'invalid',
    raw: value,
    reason: `unrecognised value ${JSON.stringify(value)}. Expected 'dry-run', `
      + "'apply:<book>[,<book>]', or 'off'.",
  };
}

// ── Inventory: which books carry which record shape ──────────────────────────

export type RecordSchema = 'v1-aggregate' | 'v2-typed' | 'unreadable' | 'absent';

export interface BookRecordInventory {
  username: string;
  path: string;
  schema: RecordSchema;
  /** v1 only — how many dates the aggregate holds, and its span. */
  storedDateCount: number | null;
  firstStoredDate: string | null;
  lastStoredDate: string | null;
  /** v2 only — how many typed events, and how many of them are `fee`. */
  eventCount: number | null;
  feeEventCount: number | null;
}

export interface CashFlowInventory {
  usersRoot: string;
  books: BookRecordInventory[];
  /**
   * The PRE-TRA-142 root-level `DATA_DIR/tradier-cash-flow.<env>.json`. Reported
   * because its existence is confusing, never migrated: the current server does
   * not read that path, so repairing it would report success for a correction
   * that never reached the calendar.
   */
  legacyRootPath: string | null;
}

function classifyRecordFile(path: string): {
  schema: RecordSchema;
  netByDate: Record<string, number>;
  events: TradierCashEvent[];
} {
  if (!existsSync(path)) return { schema: 'absent', netByDate: {}, events: [] };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return { schema: 'unreadable', netByDate: {}, events: [] };
  }
  // Same discriminator `loadTradierCashFlow` uses: the presence of an `events`
  // ARRAY, not a version string. A version field can be present-but-wrong on a
  // hand-edited file; the data either is there or it is not.
  if (Array.isArray(parsed['events'])) {
    const events: TradierCashEvent[] = [];
    for (const raw of parsed['events'] as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      const date = typeof e['date'] === 'string' ? e['date'].slice(0, 10) : '';
      const type = typeof e['type'] === 'string' ? e['type'].toLowerCase() : '';
      const amount = typeof e['amount'] === 'number' ? e['amount'] : NaN;
      const transactionId = typeof e['transactionId'] === 'string' ? e['transactionId'] : '';
      if (!date || !type || !transactionId || !Number.isFinite(amount)) continue;
      events.push({ date, type, amount, transactionId });
    }
    return { schema: 'v2-typed', netByDate: {}, events };
  }
  const netByDate: Record<string, number> = {};
  if (parsed['netByDate'] && typeof parsed['netByDate'] === 'object') {
    for (const [k, v] of Object.entries(parsed['netByDate'] as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) netByDate[k] = v;
    }
  }
  return { schema: 'v1-aggregate', netByDate, events: [] };
}

/**
 * Inventory every per-book cash-flow record under `DATA_DIR/users/`.
 *
 * Published UNCONDITIONALLY on the health route, armed or not. On 2026-09-10 the
 * only way to establish which schema the live records were in was to infer it
 * from `stockLegProbeBrokerFeeUsd` being null on every row — an operand two
 * subsystems downstream. A migration whose completion is not directly readable
 * cannot be graded, and this one gets exactly one chance to run.
 */
export function inventoryCashFlowRecords(dataDir: string, env: TradierEnv): CashFlowInventory {
  const file = `tradier-cash-flow.${env}.json`;
  const usersRoot = join(dataDir, 'users');
  const books: BookRecordInventory[] = [];
  if (existsSync(usersRoot)) {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(usersRoot, { withFileTypes: true, encoding: 'utf-8' });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(usersRoot, String(entry.name), file);
      if (!existsSync(path)) continue;
      const { schema, netByDate, events } = classifyRecordFile(path);
      const dates = Object.keys(netByDate).sort();
      books.push({
        username: String(entry.name),
        path,
        schema,
        storedDateCount: schema === 'v1-aggregate' ? dates.length : null,
        firstStoredDate: schema === 'v1-aggregate' ? (dates[0] ?? null) : null,
        lastStoredDate: schema === 'v1-aggregate' ? (dates[dates.length - 1] ?? null) : null,
        eventCount: schema === 'v2-typed' ? events.length : null,
        feeEventCount: schema === 'v2-typed' ? events.filter((e) => e.type === 'fee').length : null,
      });
    }
  }
  books.sort((a, b) => a.username.localeCompare(b.username));
  const legacyRootPath = join(dataDir, file);
  return {
    usersRoot,
    books,
    legacyRootPath: existsSync(legacyRootPath) ? legacyRootPath : null,
  };
}

// ── The reproduction control ─────────────────────────────────────────────────

/** Cent-level equality — these are money sums built by float addition. */
export function sameToTheCent(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

export function netByDateUnderOldRule(events: readonly TradierCashEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ev of events) {
    if (!isCashFlowUnderOldRule(ev.type)) continue;
    if (typeof ev.amount !== 'number' || !Number.isFinite(ev.amount)) continue;
    out[ev.date] = (out[ev.date] ?? 0) + ev.amount;
  }
  return out;
}

export interface ReproductionMismatch {
  date: string;
  stored: number;
  rebuilt: number;
  delta: number;
}

/**
 * Compare a reconstruction against the stored legacy totals. Fails on ANY date
 * that disagrees OR is missing from either side — the mismatch has to be
 * detected in BOTH directions. "Rebuilt is shorter" is the truncated-fetch case
 * (deposits would be deleted); "stored is shorter" means the broker is now
 * reporting history our record never saw, which is equally not a migration we
 * understand.
 */
export function reconcileAgainstStored(
  stored: Record<string, number>,
  rebuilt: Record<string, number>,
): { ok: boolean; mismatches: ReproductionMismatch[] } {
  const mismatches: ReproductionMismatch[] = [];
  for (const date of [...new Set([...Object.keys(stored), ...Object.keys(rebuilt)])].sort()) {
    const s = stored[date] ?? 0;
    const r = rebuilt[date] ?? 0;
    if (!sameToTheCent(s, r)) mismatches.push({ date, stored: s, rebuilt: r, delta: r - s });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Clamp a broker history to the inclusive date span a stored record actually
 * covers.
 *
 * Measured on live bqb1 2026-09-16 (TRA-3595): the admin record begins
 * `2026-05-07`, but the fetch window is `2025-01-01 → today`, and the broker
 * reports a +$300 deposit on `2026-05-01` — six days before the record starts.
 * `reconcileAgainstStored` compares the UNION of both date sets, so that event
 * scored as a mismatch and the book REFUSED.
 *
 * Refusing was necessary, not merely defensible. The apply path writes the
 * fetched events verbatim, so a lenient control would have written a v2 record
 * containing a deposit the v1 record never held — changing the book's cash
 * basis on top of the classification. TRA-2906 authorises the classification
 * change and nothing else, and **that invariant requires the event set to be
 * bounded by the record's own span.** Fetching wider than the record is the
 * defect; the union comparison is what caught it.
 *
 * This does NOT soften the guard. Inside the span both directions still bite: a
 * truncated fetch still reads `stored > 0, rebuilt 0` and still REFUSES. It only
 * stops the run from grading — and writing — history the record never claimed.
 */
export function clampEventsToStoredSpan(
  events: readonly TradierCashEvent[],
  span: { first: string; last: string },
): TradierCashEvent[] {
  return events.filter((e) => e.date >= span.first && e.date <= span.last);
}

// ── Per-book outcome ─────────────────────────────────────────────────────────

export type BookOutcome =
  | 'CLEAN'    // dry run completed, or the apply wrote and read back
  | 'REFUSED'  // the fetch did not reproduce the stored totals
  | 'USAGE'    // the fetch window cannot cover the stored record, or book unknown
  | 'BLIND'    // could not read the record or reach the broker
  | 'NOOP'     // already v2
  | 'SKIPPED'; // not named by an `apply:` list

/**
 * Worst-wins across books. REFUSED outranks everything: one book whose fetch
 * failed its control IS the finding, and must not be averaged away by books
 * that migrated cleanly.
 */
const OUTCOME_PRECEDENCE: readonly BookOutcome[] = [
  'REFUSED', 'BLIND', 'USAGE', 'NOOP', 'CLEAN', 'SKIPPED',
];

export function worstOutcome(outcomes: readonly BookOutcome[]): BookOutcome {
  for (const o of OUTCOME_PRECEDENCE) if (outcomes.includes(o)) return o;
  return 'CLEAN';
}

export interface MovedDate {
  date: string;
  /** `netCashFlow` as stored under the old rule. */
  before: number;
  /** `netCashFlow` as the shipped `deriveNetByDateFromEvents` will compute it. */
  after: number;
  /** `pnl = delta − netCashFlow`, so a RISE in netCashFlow LOWERS reported P&L. */
  pnlShift: number;
}

export interface BookResult {
  username: string;
  path: string;
  schemaBefore: RecordSchema;
  outcome: BookOutcome;
  detail: string;
  applied: boolean;
  backupPath: string | null;
  storedDateCount: number | null;
  fetchedEventCount: number | null;
  feeEvents: { date: string; amount: number }[] | null;
  reproductionOk: boolean | null;
  mismatches: ReproductionMismatch[] | null;
  movedDates: MovedDate[] | null;
  totalPnlShiftUsd: number | null;
  /**
   * The record's own inclusive date span, which bounds both the reconciliation
   * and the write (see `clampEventsToStoredSpan`). Published so the health route
   * shows WHICH history was graded — a run scoped to the wrong span and a run
   * scoped to the right one otherwise read identically.
   */
  storedSpan: { first: string; last: string } | null;
  /** How many of the fetched events survived the span clamp. */
  eventsInSpan: number | null;
}

export interface RebuildRunResult {
  armed: boolean;
  intentMode: RebuildIntent['mode'];
  /** Why the run is in the state it is in. Never blank — UNREAD is not OK. */
  reason: string;
  env: TradierEnv;
  dataDir: string;
  startedAt: string;
  finishedAt: string;
  window: { start: string; end: string } | null;
  inventory: CashFlowInventory;
  books: BookResult[];
  verdict: BookOutcome | 'NOT-ARMED' | 'INVALID';
}

export interface FetchCashEventsResult {
  ok: boolean;
  events: TradierCashEvent[];
  /** Populated when `ok` is false — the reason the run reads BLIND, not REFUSED. */
  detail: string;
}

export interface RebuildDeps {
  dataDir: string;
  env: TradierEnv;
  intent: RebuildIntent;
  /** `[start, end]` inclusive; the caller widens `start` to cover the record. */
  fetchCashEvents: (start: string, end: string) => Promise<FetchCashEventsResult>;
  now?: Date;
  /** Earliest date the fetch window may start at. Records older than this read USAGE. */
  windowStart?: string;
}

const FETCH_WINDOW_START = '2025-01-01';

/**
 * Run the rebuild for the arming intent. Pure with respect to the broker (the
 * fetch is injected); the only side effect is the record write, and only on
 * `apply`, and only after the control passes.
 */
export async function runCashFlowRebuild(deps: RebuildDeps): Promise<RebuildRunResult> {
  const now = deps.now ?? new Date();
  const startedAt = now.toISOString();
  const env = deps.env;
  const inventory = inventoryCashFlowRecords(deps.dataDir, env);
  const base = {
    intentMode: deps.intent.mode,
    env,
    dataDir: deps.dataDir,
    startedAt,
    inventory,
    books: [] as BookResult[],
  };

  if (deps.intent.mode === 'off') {
    return {
      ...base,
      armed: false,
      reason: `${TRA2906_REBUILD_ENV_VAR} is not set. The rebuild is a deliberate one-shot; `
        + 'this is the correct resting state.',
      finishedAt: new Date().toISOString(),
      window: null,
      verdict: 'NOT-ARMED',
    };
  }

  if (deps.intent.mode === 'invalid') {
    // NOT folded into `off`. "Armed with a value I could not read" and "not
    // armed" are different facts, and an operator who wrote the var and got
    // silence would reasonably conclude the deploy did not carry this code.
    return {
      ...base,
      armed: false,
      reason: `${TRA2906_REBUILD_ENV_VAR} is set to a value this build refuses: ${deps.intent.reason} `
        + 'Nothing was read and nothing was written.',
      finishedAt: new Date().toISOString(),
      window: null,
      verdict: 'INVALID',
    };
  }

  const apply = deps.intent.mode === 'apply';
  const requested = apply ? (deps.intent as { books: string[] }).books : null;
  const start = deps.windowStart ?? FETCH_WINDOW_START;
  const end = now.toISOString().slice(0, 10);

  // Fail CLOSED on zero records. "No records here" is indistinguishable from
  // "wrong DATA_DIR" or "the disk did not mount" from in here, and reporting a
  // clean run would let TRA-3595 close having touched nothing.
  if (inventory.books.length === 0) {
    return {
      ...base,
      armed: true,
      reason: `BLIND — no ${env} cash-flow record under ${inventory.usersRoot}. That is `
        + 'indistinguishable from a wrong or unmounted DATA_DIR, so it is not reported as a '
        + 'clean run.',
      finishedAt: new Date().toISOString(),
      window: { start, end },
      verdict: 'BLIND',
    };
  }

  // Fetch ONCE. One shared broker account backs every book (TRA-3081), so the
  // event history is identical per book; each record's own control then decides
  // whether that history reproduces ITS stored totals.
  let fetched: FetchCashEventsResult | null = null;
  const fetchOnce = async (): Promise<FetchCashEventsResult> => {
    if (!fetched) fetched = await deps.fetchCashEvents(start, end);
    return fetched;
  };

  const books: BookResult[] = [];
  for (const book of inventory.books) {
    books.push(await processBook(book, { apply, requested, end, fetchOnce }));
  }

  const graded = books.filter((b) => b.outcome !== 'SKIPPED').map((b) => b.outcome);
  const verdict = graded.length === 0 ? 'USAGE' : worstOutcome(graded);
  return {
    ...base,
    books,
    armed: true,
    reason: apply
      ? `APPLY armed for book(s): ${requested?.join(', ')}. Verdict ${verdict}.`
      : `DRY RUN over ${inventory.books.length} book(s). Nothing was written. Verdict ${verdict}.`,
    finishedAt: new Date().toISOString(),
    window: { start, end },
    verdict,
  };
}

async function processBook(
  book: BookRecordInventory,
  opts: {
    apply: boolean;
    requested: string[] | null;
    end: string;
    fetchOnce: () => Promise<FetchCashEventsResult>;
  },
): Promise<BookResult> {
  const blank = {
    username: book.username,
    path: book.path,
    schemaBefore: book.schema,
    applied: false,
    backupPath: null,
    storedDateCount: book.storedDateCount,
    fetchedEventCount: null,
    feeEvents: null,
    reproductionOk: null,
    mismatches: null,
    movedDates: null,
    totalPnlShiftUsd: null,
    storedSpan: null,
    eventsInSpan: null,
  } satisfies Omit<BookResult, 'outcome' | 'detail'>;

  // On an `apply` the book list is an allowlist, not a filter over a default.
  if (opts.apply && opts.requested && !opts.requested.includes(book.username)) {
    return { ...blank, outcome: 'SKIPPED', detail: 'not named in the apply list' };
  }

  if (book.schema === 'unreadable') {
    return { ...blank, outcome: 'BLIND', detail: 'the record exists but could not be parsed' };
  }
  if (book.schema === 'v2-typed') {
    return {
      ...blank,
      outcome: 'NOOP',
      detail: `already v2-typed (${book.eventCount} events). Classification is already a `
        + 'read-time decision; nothing to migrate.',
    };
  }

  const { netByDate: stored } = classifyRecordFile(book.path);
  const storedDates = Object.keys(stored).sort();

  // A v1 record carrying NO dates has no span, and therefore nothing that could
  // bound the clamp below. It must never reach it: an empty span filters every
  // event away, both sides of the control reconcile as `{}` vs `{}`, the guard
  // PASSES, and an `apply` writes an empty v2 record over the only copy. That is
  // the failure this whole module exists to prevent, arriving through the fix
  // for the previous one. USAGE, explicitly, before the clamp is ever built.
  if (storedDates.length === 0) {
    return {
      ...blank,
      outcome: 'USAGE',
      detail: 'the v1 record carries zero dates, so it has no span to bound the rebuild. '
        + 'An unbounded or empty-span run cannot be graded and must not write. Nothing read '
        + 'from the broker, nothing written.',
    };
  }
  const storedSpan = { first: storedDates[0]!, last: storedDates[storedDates.length - 1]! };

  const fetchResult = await opts.fetchOnce();
  if (!fetchResult.ok) {
    // BLIND, never REFUSED. "We could not reach the broker" must not be reported
    // as "the broker disagrees with our record".
    return { ...blank, storedSpan, outcome: 'BLIND', detail: `broker history fetch failed: ${fetchResult.detail}` };
  }
  // Bound the history to what this record actually claims. Everything downstream
  // — the control, the measured shift, and the bytes an `apply` writes — reads
  // this clamped set, so the classification stays the only variable.
  const events = clampEventsToStoredSpan(fetchResult.events, storedSpan);

  // ── THE GUARD ──────────────────────────────────────────────────────────────
  const rebuiltOld = netByDateUnderOldRule(events);
  const verdict = reconcileAgainstStored(stored, rebuiltOld);
  if (!verdict.ok) {
    return {
      ...blank,
      outcome: 'REFUSED',
      storedSpan,
      fetchedEventCount: fetchResult.events.length,
      eventsInSpan: events.length,
      reproductionOk: false,
      mismatches: verdict.mismatches,
      detail: `the fetched history does NOT reproduce the ${storedDates.length} stored totals `
        + `under the old rule (${verdict.mismatches.length} date(s) disagree). Nothing written — `
        + 'a truncated fetch here would delete deposits, and a deleted deposit reads as profit.',
    };
  }

  // ── The measured shift, computed by the SHIPPED read-time rule ─────────────
  const rebuiltNew = deriveNetByDateFromEvents(events);
  const movedDates: MovedDate[] = [];
  for (const date of [...new Set([...Object.keys(stored), ...Object.keys(rebuiltNew)])].sort()) {
    const before = stored[date] ?? 0;
    const after = rebuiltNew[date] ?? 0;
    if (!sameToTheCent(before, after)) movedDates.push({ date, before, after, pnlShift: -(after - before) });
  }
  const feeEvents = events
    .filter((e) => e.type === 'fee')
    .map((e) => ({ date: e.date, amount: e.amount }));
  const totalPnlShiftUsd = Number(movedDates.reduce((a, m) => a + m.pnlShift, 0).toFixed(2));

  const measured = {
    ...blank,
    storedSpan,
    fetchedEventCount: fetchResult.events.length,
    eventsInSpan: events.length,
    feeEvents,
    reproductionOk: true,
    mismatches: [],
    movedDates,
    totalPnlShiftUsd,
  };

  if (!opts.apply) {
    return {
      ...measured,
      outcome: 'CLEAN',
      detail: `DRY RUN — control passed on all ${storedDates.length} stored dates over `
        + `${storedSpan.first}..${storedSpan.last} (${events.length} of `
        + `${fetchResult.events.length} fetched events are in span); the classification change is `
        + `the only variable. ${movedDates.length} date(s) move, for a reported-P&L shift of `
        + `${totalPnlShiftUsd.toFixed(2)}. Nothing written.`,
    };
  }

  const backupPath = `${book.path}.v1-backup-${opts.end}`;
  try {
    copyFileSync(book.path, backupPath);
    const next = {
      events: [...events].sort(
        (a, b) => a.date.localeCompare(b.date) || a.transactionId.localeCompare(b.transactionId),
      ),
    };
    writeFileSync(book.path, JSON.stringify(next, null, 2), 'utf-8');
  } catch (err) {
    return {
      ...measured,
      outcome: 'BLIND',
      detail: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      backupPath,
    };
  }

  // Read back — a write that returns without throwing is not a write that stuck.
  const readback = classifyRecordFile(book.path);
  if (readback.schema !== 'v2-typed' || readback.events.length !== events.length) {
    return {
      ...measured,
      outcome: 'REFUSED',
      backupPath,
      detail: `read-back mismatch (wrote ${events.length}, read ${readback.events.length} as `
        + `${readback.schema}). The v1 backup is at ${backupPath}.`,
    };
  }

  return {
    ...measured,
    outcome: 'CLEAN',
    applied: true,
    backupPath,
    detail: `APPLIED — ${events.length} typed events written; read back and verified. `
      + `Reported-P&L shift ${totalPnlShiftUsd.toFixed(2)} across ${movedDates.length} date(s). `
      + `v1 backup at ${backupPath}.`,
  };
}

// ── The default host fetch ───────────────────────────────────────────────────

/**
 * Status-preserving history fetch against the PRODUCTION Tradier account, using
 * the deployment-level `TRADIER_API_TOKEN` / `TRADIER_ACCOUNT_ID`.
 *
 * Those are the same credentials `envFallbackCreds` resolves for `production`,
 * and the same pair `scripts/tra2906-rebuild-cash-flow.mjs` requires. Using the
 * deployment creds rather than a per-book saved pair is correct HERE and is not
 * the TRA-3112 leak: one shared broker account backs every book (TRA-3081), the
 * fetch is read-only, and nothing it returns is shown to a user — it is compared
 * against each book's own stored totals and then discarded or persisted as that
 * book's own record.
 *
 * `limit=10000` on a single window rather than the server's rolling 250/1000:
 * the reproduction control needs the COMPLETE history, and a page boundary is
 * exactly the truncation the control exists to catch.
 */
export function buildHostCashEventFetcher(
  procEnv: NodeJS.ProcessEnv = process.env,
): (start: string, end: string) => Promise<FetchCashEventsResult> {
  return async (start: string, end: string): Promise<FetchCashEventsResult> => {
    const token = (procEnv['TRADIER_API_TOKEN'] ?? '').trim();
    const accountId = (procEnv['TRADIER_ACCOUNT_ID'] ?? '').trim();
    if (!token || !accountId) {
      return {
        ok: false,
        events: [],
        detail: 'TRADIER_API_TOKEN and TRADIER_ACCOUNT_ID must both be set on the host.',
      };
    }
    const url = `https://api.tradier.com/v1/accounts/${encodeURIComponent(accountId)}/history`
      + `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=10000`;
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!resp.ok) {
        // The status is the whole point of not using `getJson` here.
        return { ok: false, events: [], detail: `Tradier history HTTP ${resp.status} ${resp.statusText}` };
      }
      const body = (await resp.json()) as Parameters<typeof parseTradierCashEvents>[0];
      return { ok: true, events: parseTradierCashEvents(body), detail: '' };
    } catch (err) {
      return {
        ok: false,
        events: [],
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

// ── The published surface ────────────────────────────────────────────────────

let lastRun: RebuildRunResult | null = null;

/** Record the boot run so the health route can publish it. */
export function setLastRebuildRun(result: RebuildRunResult): void {
  lastRun = result;
}

export function getLastRebuildRun(): RebuildRunResult | null {
  return lastRun;
}

/** Test seam — the module-level `lastRun` is process-global by design. */
export function _resetLastRebuildRunForTests(): void {
  lastRun = null;
}
