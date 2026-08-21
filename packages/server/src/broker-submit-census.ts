/**
 * TRA-3905 — the PER-BOOK BROKER SUBMIT/FILL CENSUS and the permission breaker.
 *
 * ## The defect this exists for
 *
 * On 2026-08-20 the `v0nni` book submitted **25 real `buy_to_open` orders**
 * between 14:45Z and 19:22Z. Tradier rejected all 25 with
 * `Account is restricted for option trading.` The account is not approved for
 * options; no retry could ever have filled. And a book structurally incapable of
 * filling an order read **byte-identical to a healthy one** on every arm
 * instrument the box owns:
 *
 *   • `liveArmCensus` — `liveEntryGateOpen:true`, `clientPresent:true`,
 *     `prodKeySaved:true`, `prodAccountSaved:true`, `realMoneyArmed:true`,
 *     `accountIdSource:'saved'`. Every cell matched `admin`'s, which FILLED.
 *   • `/api/health/live-enforce-gates` — `canary_ceiling` 25 evaluated / 0
 *     blocked. The gate ledger's story is "25 orders admitted", which is true
 *     and useless: it grades OUR gates, and ours all passed.
 *   • `rollup.realMoneyArmedCount: 2` — counted her as armed.
 *
 * The only trace of 25 refused real-money orders was a free-text `reason` on
 * `voids.recent[]`, which carried no book attribution at all: the 25 had to be
 * attributed by cross-referencing a `canary_ceiling` count against the OTHER
 * book's Tradier order history, by hand, off-platform.
 *
 * ## Why an arm census cannot answer this and this can
 *
 * Every field on the arm census is a fact about **our** side of the seam —
 * creds, client, mode, routing. All of them were true. The broker's approval
 * state is not on our side and is not knowable from any of them; the ONLY
 * server-side evidence is what came back after we asked. So the discriminator
 * has to be an OUTCOME fold, and the pair that discriminates is
 * `submitted` vs `filled` per book:
 *
 *     admin  2 submitted / 2 filled / 0 rejects   → GREEN
 *     v0nni 25 submitted / 0 filled / 25 permission rejects → RED
 *
 * No route anywhere printed that pair. This module is that pair.
 *
 * ## Absence must not read as clean (the property this is built around)
 *
 * {@link summarizeBrokerSubmitCensus} takes the roster of books to grade and
 * emits a row for every one of them, zero-filled, with `observed:false` saying
 * the ledger held no cell. A book missing from the output would be the same
 * silent-clean failure the ticket was filed against — the `.some()`-pinned-true
 * shape that `live-arm-census.ts` already documents at length. Every reject
 * CLASS is likewise emitted at 0 rather than omitted, so a reader never has to
 * know that `permission` is a key that could have existed.
 *
 * ## The breaker refuses; it does not skip
 *
 * After {@link PERMISSION_BREAKER_THRESHOLD} consecutive permission-class
 * rejects on a book the submit path stops asking the broker. That refusal is
 * NAMED — it voids with an explicit reason, sets `brokerPermissionBlocked` on
 * the census, counts itself in `submissionsRefusedByBreaker`, and alerts once.
 * A silent skip would reproduce the original defect one layer down.
 *
 * Process-lifetime + per-ET-day state, deliberately not durable: it is a
 * SESSION circuit breaker, and a restart re-asking the broker once is the
 * correct behaviour (an approval can land between sessions). The census fold it
 * shares is retained {@link RETAIN_DAYS} ET days so the evidence outlives the
 * bounded `voids.recent[]` witness that could not hold it.
 */

/**
 * Why an order never became a fill. The split that matters is TERMINAL vs
 * transient: a broker PERMISSION refusal is never fixable by retrying, and was
 * stored identically to `walk_exhausted` (fixable next tick) before this.
 */
export type BrokerRejectClass =
  /** Broker says the ACCOUNT may not do this — approval/level/restriction. Terminal. */
  | 'permission'
  /** Insufficient option or day-trade buying power (ours or the broker's). */
  | 'buying_power'
  /** No usable quote to price against. */
  | 'no_quote'
  /** The TRA-374 smart-open ladder ran out of attempts without a fill. */
  | 'walk_exhausted'
  /** The TRA-2048 liquidity/spread veto refused the book. */
  | 'spread_veto'
  /** One of OUR policy refusals (canary ceiling, contract count, missing OCC). */
  | 'policy'
  /** No live order client — the TRA-2693 mode-flip window. */
  | 'client_unavailable'
  /** The broker call threw (network/auth/parse). */
  | 'throw'
  /** The breaker refused to submit; nothing reached the broker. */
  | 'permission_blocked'
  /** Broker refused for a reason this module does not recognise. */
  | 'other';

/**
 * Canonical order. Every one of these is emitted on every row, at 0 when
 * unseen — an absent key would read like a clean one.
 */
export const BROKER_REJECT_CLASSES: readonly BrokerRejectClass[] = [
  'permission',
  'buying_power',
  'no_quote',
  'walk_exhausted',
  'spread_veto',
  'policy',
  'client_unavailable',
  'throw',
  'permission_blocked',
  'other',
] as const;

/**
 * Did the order reach the broker before it died?
 *
 * `pre_submit` aborts are OURS (arm guards, canary ceiling, BP pre-checks,
 * spread veto, and the breaker itself). They must not enter `submitted`, or the
 * `submitted` vs `filled` pair — the whole point of this fold — stops meaning
 * "the broker saw it and did not fill it".
 */
export type BrokerRejectStage = 'pre_submit' | 'broker';

/** Which classes can only ever be produced before the order is sent. */
const PRE_SUBMIT_CLASSES: ReadonlySet<BrokerRejectClass> = new Set<BrokerRejectClass>([
  'policy',
  'client_unavailable',
  'spread_veto',
  'permission_blocked',
]);

/**
 * Consecutive permission-class rejects on one book before the submit path
 * refuses. The ticket's N=3 is already generous — for THIS reason code the
 * FIRST reject is dispositive, since an account either carries options approval
 * or does not. 3 buys tolerance against a mis-classified message (see
 * {@link classifyBrokerRejectText}), at a cost of at most two further refused
 * orders on a genuinely restricted book.
 */
export const PERMISSION_BREAKER_THRESHOLD = 3;

/** ET days retained. Bounds the heap; well past any same-week investigation. */
const RETAIN_DAYS = 30;

/**
 * Attribution fallback when the engine carries no username. It is a real key,
 * not a hole: an unattributed reject must still be COUNTED. The breaker
 * deliberately does not arm on it — see {@link recordBrokerReject}.
 */
export const UNATTRIBUTED_BOOK = '(unattributed)';

interface BookDayCell {
  /** Orders handed to the broker. Never incremented by a pre-submit abort. */
  submitted: number;
  /** …of those, the ones that came back filled. */
  filled: number;
  rejects: Map<BrokerRejectClass, number>;
  /** Rejects that reached the broker (`stage: 'broker'`). */
  brokerRejects: number;
  /** Rejects we produced ourselves (`stage: 'pre_submit'`). */
  preSubmitAborts: number;
  /** Runs of permission rejects, reset by any fill. Drives the breaker. */
  consecutivePermission: number;
  /** Epoch ms the breaker tripped; `null` while it has not. */
  blockedSince: number | null;
  /** The broker's own text for the reject that tripped it. */
  blockedReason: string | null;
  /** Submissions the breaker refused. Nothing reached the broker for these. */
  refusedByBreaker: number;
  /** Has the trip already alerted? Keeps a 4.5-hour scan loop to one page. */
  alerted: boolean;
}

/** etDay -> book -> cell. */
const store = new Map<string, Map<string, BookDayCell>>();

function emptyCell(): BookDayCell {
  return {
    submitted: 0,
    filled: 0,
    rejects: new Map(),
    brokerRejects: 0,
    preSubmitAborts: 0,
    consecutivePermission: 0,
    blockedSince: null,
    blockedReason: null,
    refusedByBreaker: 0,
    alerted: false,
  };
}

function cellFor(etDay: string, book: string): BookDayCell {
  let day = store.get(etDay);
  if (!day) {
    day = new Map();
    store.set(etDay, day);
    // Evict oldest ET days by key order — `YYYY-MM-DD` sorts chronologically.
    if (store.size > RETAIN_DAYS) {
      const keys = [...store.keys()].sort();
      for (const k of keys.slice(0, keys.length - RETAIN_DAYS)) store.delete(k);
    }
  }
  let cell = day.get(book);
  if (!cell) {
    cell = emptyCell();
    day.set(book, cell);
  }
  return cell;
}

/**
 * Classify the broker's own free-text refusal.
 *
 * ⚠️ The default is `'other'`, NOT `'permission'`, and that asymmetry is
 * deliberate. A false `permission` trips a breaker that stops a HEALTHY book
 * from trading; a false `other` costs one more refused order on a book that was
 * never going to fill anyway. So the patterns below are narrow and anchored on
 * wording Tradier actually returns, and anything unrecognised stays transient.
 *
 * The 2026-08-20 string, verbatim:
 *   `Account is restricted for option trading. Please contact 980-272-3880 …`
 */
export function classifyBrokerRejectText(text: string | null | undefined): BrokerRejectClass {
  const t = (text ?? '').toLowerCase();
  if (t.length === 0) return 'other';
  if (
    /restricted for option/.test(t) ||
    /account is restricted/.test(t) ||
    /not approved (?:for|to)/.test(t) ||
    /not authorized (?:for|to)/.test(t) ||
    /option(?:s)? (?:trading )?level/.test(t) ||
    /trading is not permitted/.test(t)
  ) {
    return 'permission';
  }
  if (/buying power|insufficient funds|insufficient buying/.test(t)) return 'buying_power';
  return 'other';
}

/** One order handed to the broker. */
export function recordBrokerSubmit(book: string, etDay: string): void {
  cellFor(etDay, book).submitted += 1;
}

/**
 * One broker FILL. Also clears the permission run: a fill is positive proof the
 * account can trade options, so a later reject starts a fresh run rather than
 * accumulating across a healthy session.
 */
export function recordBrokerFill(book: string, etDay: string): void {
  const cell = cellFor(etDay, book);
  cell.filled += 1;
  cell.consecutivePermission = 0;
}

export interface BrokerRejectOutcome {
  /** The breaker tripped on THIS reject (false when already tripped). */
  tripped: boolean;
  /** Consecutive permission rejects after this one. */
  consecutivePermission: number;
}

/**
 * One order that did not fill, with its class and how far it got.
 *
 * The breaker arms only for a NAMED book: `permission` state is per-account, and
 * accumulating {@link UNATTRIBUTED_BOOK} rejects would let two different books'
 * refusals collapse into one trip that halts neither correctly. The reject is
 * still counted — it is the halt that is withheld.
 */
export function recordBrokerReject(
  book: string,
  etDay: string,
  cls: BrokerRejectClass,
  reason: string | null = null,
  ts: number = Date.now(),
): BrokerRejectOutcome {
  const cell = cellFor(etDay, book);
  cell.rejects.set(cls, (cell.rejects.get(cls) ?? 0) + 1);
  const stage: BrokerRejectStage = PRE_SUBMIT_CLASSES.has(cls) ? 'pre_submit' : 'broker';
  if (stage === 'broker') cell.brokerRejects += 1;
  else cell.preSubmitAborts += 1;
  if (cls === 'permission_blocked') cell.refusedByBreaker += 1;
  if (cls !== 'permission') {
    // A transient reject does NOT reset the run. The 08-20 book interleaved
    // permission rejects with nothing else, but a book that alternates
    // permission / no_quote is just as terminally restricted, and a reset on
    // the transient one would hold the counter under threshold forever.
    return { tripped: false, consecutivePermission: cell.consecutivePermission };
  }
  cell.consecutivePermission += 1;
  const attributed = book !== UNATTRIBUTED_BOOK && book.length > 0;
  const shouldTrip =
    attributed && cell.blockedSince === null && cell.consecutivePermission >= PERMISSION_BREAKER_THRESHOLD;
  if (shouldTrip) {
    cell.blockedSince = ts;
    cell.blockedReason = reason;
  }
  return { tripped: shouldTrip, consecutivePermission: cell.consecutivePermission };
}

export interface BrokerPermissionBlockState {
  blocked: boolean;
  since: number | null;
  reason: string | null;
  consecutivePermission: number;
}

/** Read-only — never creates a cell, so a probe cannot manufacture a row. */
export function getBrokerPermissionBlock(book: string, etDay: string): BrokerPermissionBlockState {
  const cell = store.get(etDay)?.get(book);
  if (!cell) return { blocked: false, since: null, reason: null, consecutivePermission: 0 };
  return {
    blocked: cell.blockedSince !== null,
    since: cell.blockedSince,
    reason: cell.blockedReason,
    consecutivePermission: cell.consecutivePermission,
  };
}

/**
 * Has this trip already alerted? Flips the latch as a side effect, so the
 * caller alerts exactly once per book per ET day rather than on every scan of a
 * 4.5-hour session.
 */
export function claimPermissionBlockAlert(book: string, etDay: string): boolean {
  const cell = store.get(etDay)?.get(book);
  if (!cell || cell.blockedSince === null || cell.alerted) return false;
  cell.alerted = true;
  return true;
}

/** `green` needs a fill; `red` needs a human. See {@link BrokerSubmitCensusRow.verdict}. */
export type BrokerSubmitVerdict = 'green' | 'idle' | 'degraded' | 'red';

export interface BrokerSubmitCensusRow {
  book: string;
  etDay: string;
  /**
   * Did the ledger hold a cell for this book, or is this a zero row synthesized
   * for a book on the roster? `false` + `idle` is "armed and quiet"; it is NOT
   * evidence of health, and the field exists so the two cannot be confused.
   */
  observed: boolean;
  /** Orders the BROKER saw. Pre-submit aborts are excluded by construction. */
  submitted: number;
  filled: number;
  /** Rejects returned BY the broker. */
  brokerRejects: number;
  /** Orders we refused ourselves before submitting. */
  preSubmitAborts: number;
  /** Every class, always present, zero when unseen. */
  rejects: Record<BrokerRejectClass, number>;
  permissionRejects: number;
  consecutivePermissionRejects: number;
  /** THE CELL THE 08-20 CENSUS DID NOT HAVE. */
  brokerPermissionBlocked: boolean;
  brokerPermissionBlockedSince: number | null;
  brokerPermissionBlockedReason: string | null;
  submissionsRefusedByBreaker: number;
  /**
   * The one-glance read, so the negative control does not depend on a reader
   * doing the arithmetic:
   *   • `red`      — permission rejects seen, or the breaker is tripped. Human.
   *   • `degraded` — the broker saw orders and filled none, all transient.
   *   • `idle`     — nothing submitted. Says nothing about health either way.
   *   • `green`    — at least one fill and no permission reject.
   */
  verdict: BrokerSubmitVerdict;
}

export interface BrokerSubmitCensusReport {
  etDay: string;
  /** Books graded — the DENOMINATOR for the rows below. */
  booksGraded: number;
  /** One row per graded book. NEVER elided, zero-filled when unobserved. */
  books: BrokerSubmitCensusRow[];
  rollup: {
    submitted: number;
    filled: number;
    brokerRejects: number;
    permissionRejects: number;
    /** Books the breaker has halted. Non-zero is an incident. */
    permissionBlockedBookCount: number;
    redBookCount: number;
    degradedBookCount: number;
  };
  /** ET days currently held, oldest first — the retention window, measured. */
  retainedEtDays: string[];
}

function zeroRejects(): Record<BrokerRejectClass, number> {
  const out = {} as Record<BrokerRejectClass, number>;
  for (const c of BROKER_REJECT_CLASSES) out[c] = 0;
  return out;
}

function gradeRow(book: string, etDay: string, cell: BookDayCell | undefined): BrokerSubmitCensusRow {
  const rejects = zeroRejects();
  if (cell) for (const [c, n] of cell.rejects) rejects[c] = n;
  const permissionRejects = rejects.permission;
  const blocked = (cell?.blockedSince ?? null) !== null;
  const submitted = cell?.submitted ?? 0;
  const filled = cell?.filled ?? 0;
  const verdict: BrokerSubmitVerdict =
    blocked || permissionRejects > 0
      ? 'red'
      : submitted === 0
        ? 'idle'
        : filled === 0
          ? 'degraded'
          : 'green';
  return {
    book,
    etDay,
    observed: cell !== undefined,
    submitted,
    filled,
    brokerRejects: cell?.brokerRejects ?? 0,
    preSubmitAborts: cell?.preSubmitAborts ?? 0,
    rejects,
    permissionRejects,
    consecutivePermissionRejects: cell?.consecutivePermission ?? 0,
    brokerPermissionBlocked: blocked,
    brokerPermissionBlockedSince: cell?.blockedSince ?? null,
    brokerPermissionBlockedReason: cell?.blockedReason ?? null,
    submissionsRefusedByBreaker: cell?.refusedByBreaker ?? 0,
    verdict,
  };
}

/**
 * Fold the ledger for `etDay` over `roster` ∪ (books with activity that day).
 *
 * The union is load-bearing in BOTH directions. `roster` (the armed books) is
 * what makes an armed-but-silent book appear at all — the zero row is the
 * fix for "an absent cell must not read like a clean one". The activity side is
 * what stops a book that has since been disarmed, renamed, or dropped from the
 * context registry from erasing the evidence of what it did today.
 *
 * Pure — no IO, no clock.
 */
export function summarizeBrokerSubmitCensus(
  etDay: string,
  roster: readonly string[] = [],
): BrokerSubmitCensusReport {
  const day = store.get(etDay);
  const books = [...new Set([...roster, ...(day ? day.keys() : [])])].sort();
  const rows = books.map(b => gradeRow(b, etDay, day?.get(b)));
  return {
    etDay,
    booksGraded: rows.length,
    books: rows,
    rollup: {
      submitted: rows.reduce((a, r) => a + r.submitted, 0),
      filled: rows.reduce((a, r) => a + r.filled, 0),
      brokerRejects: rows.reduce((a, r) => a + r.brokerRejects, 0),
      permissionRejects: rows.reduce((a, r) => a + r.permissionRejects, 0),
      permissionBlockedBookCount: rows.filter(r => r.brokerPermissionBlocked).length,
      redBookCount: rows.filter(r => r.verdict === 'red').length,
      degradedBookCount: rows.filter(r => r.verdict === 'degraded').length,
    },
    retainedEtDays: [...store.keys()].sort(),
  };
}

/** Test seam only. */
export function __resetBrokerSubmitCensusForTest(): void {
  store.clear();
}
