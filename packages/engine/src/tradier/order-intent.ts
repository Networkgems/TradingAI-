/**
 * TRA-4476 — THE UNKNOWN-OUTCOME STATE MACHINE for a broker submit.
 *
 * ## The defect this exists for
 *
 * Before this module, `postOrder` had exactly two outcomes: it returned an order,
 * or it threw. The throw was classified `transport | refused | malformed`
 * (TRA-4218), and the `transport` docblock asserted the broker "never reached a
 * decision". **That assertion is not sound.** A socket can reset, and a 500 can be
 * returned, *after* Tradier has accepted the order. TRA-4218's classification was
 * built to answer a different question — should this failure consume the TRA-450
 * rejection budget — and it answers that one correctly. It was then read as an
 * answer to "does an order now exist at the broker", which it never was.
 *
 * Those are two different questions and this module keeps them apart by name:
 *
 *  - **`kind`** (on {@link TradierOrderError}, unchanged) — the BUDGET question.
 *    "Did the broker look at this order and say no?" Drives the breaker counter.
 *  - **`outcome`** (added here) — the EXPOSURE question. "Might an order exist at
 *    the broker right now?" Drives whether we are allowed to submit again.
 *
 * A failure can be `kind: 'transport'` (do not consume the refusal budget — the
 * broker's backend fell over) and `outcome: 'unknown'` (do NOT resubmit — that
 * same backend may be holding a live order) at the same time. Under the old
 * single axis those two collapsed into one another, and the collapse resolved in
 * the direction that resubmits.
 *
 * ## The three outcomes, and why `malformed` moved
 *
 *  - `acknowledged` — the broker returned an order id. An order exists.
 *  - `refused` — a 4xx, or a 2xx envelope carrying `errors.error`. The broker
 *    read the order and declined it. **Provably no order exists.** This is the
 *    only branch entitled to that claim, because it is the only one where the
 *    broker itself told us.
 *  - `unknown` — everything else: 5xx, 429, 408, a network throw, an abort/
 *    timeout, an unreadable body, or **a 2xx with no `order` payload**.
 *
 * That last one is the moved case. TRA-4218 called a 2xx-without-payload
 * `malformed` and left it beside the refusals. But a 2xx is the broker saying it
 * succeeded; a response we could not parse is our blindness, not its refusal. It
 * belongs in `unknown`.
 *
 * ## Why the reconcile cannot be "just fetch the orders and look"
 *
 * `/accounts/{id}/orders` returns `[]` for BOTH "this account placed no orders"
 * and "the read failed" — the client's own docblock says so, and TRA-3932
 * measured that on production the endpoint's reach is **the current trading day
 * only**. So an empty list is the single most dangerous input this module can
 * receive: read as "no order exists" it licenses an immediate resubmit, which is
 * the duplicate-exposure event the whole ticket is about.
 *
 * The reach test is therefore POSITIVE, never an absence:
 *
 *   > the order list demonstrates it covers our submit instant iff it contains at
 *   > least one row created AT OR AFTER that instant.
 *
 * A row newer than our submit proves the endpoint is serving orders at least as
 * new as ours, so our order's absence from the same list is real evidence. With
 * no such row — including an empty list — the window is UNPROVEN and the verdict
 * is `unresolved`, never `not_placed`. This costs us false halts on a quiet
 * account and it is the correct side to be wrong on: the issue's own framing is
 * "fill rate may drop and latency may rise; that is the correct trade against
 * duplicate exposure."
 *
 * ## What the shape match is and is NOT
 *
 * The match is `account` (implied by the endpoint) × `bounded time window` ×
 * `class/side/symbol/optionSymbol/quantity`. It is deliberately NOT a price
 * match: `parseTradierOrders` does not surface the resting limit price, and a
 * maker walk resubmits the same shape at a different price by design — keying on
 * price would make every walk step look like a fresh intent, which is exactly the
 * duplication this prevents.
 *
 * The consequence, stated rather than implied: a genuinely identical order placed
 * by a human on Tradier's dashboard inside our window is indistinguishable from
 * ours. That case resolves to `unresolved: 'multiple_matches'` when it coexists
 * with ours, and would resolve to `placed` if ours were absent and theirs
 * present. Both halt. Neither resubmits. There is no `tag` on any submit path we
 * own (TRA-3932 measured `tag: null` on every historical row) — sending one is a
 * broker-semantics change that needs sandbox confirmation before it touches a
 * money path, so this module is built to be correct WITHOUT it and to get
 * strictly sharper if one ever lands.
 */

/** `production` vs `sandbox`. Structurally identical to `TradierEnv`; declared
 *  here so this module has no import edge back into `order-client.ts`. */
export type OrderIntentEnv = 'sandbox' | 'production';

/**
 * The identifying features of an order, read off the submitted body BEFORE it is
 * sent. This is what the reconcile matches broker rows against, and it is what
 * the breaker is keyed on.
 */
export interface OrderIntentShape {
  /** `equity` / `option` / `otoco` / `multileg` / … */
  orderClass: string | null;
  /** Entry side. For a multileg body this is leg 0 — the entry leg. */
  side: string | null;
  symbol: string | null;
  optionSymbol: string | null;
  quantity: number | null;
  /**
   * Recorded for the audit trail only. **Never a match key** — see the module
   * docblock; `parseTradierOrders` does not surface a resting limit price and a
   * maker walk changes it on purpose.
   */
  limitPrice: number | null;
}

export type OrderIntentStatus =
  | 'submitting'
  | 'acknowledged'
  | 'refused'
  | 'not_placed'
  | 'unknown';

/** A durable pre-submit record. Written BEFORE the POST leaves the process. */
export interface OrderIntent {
  intentId: string;
  accountId: string;
  env: OrderIntentEnv;
  /**
   * ms epoch stamped immediately before the POST. The LOWER bound of the window
   * a broker row must fall in to be ours. Stamped pre-submit on purpose: a
   * timestamp taken after the failure would exclude the order we are hunting.
   */
  submitStartedAt: number;
  shape: OrderIntentShape;
  status: OrderIntentStatus;
  /** Set once the outcome is known (or recovered by reconcile). */
  orderId?: number;
  /** Why the intent is `unknown`, when it is. */
  unknownReason?: UnknownSubmitReason;
  /** Free-text detail for the operator — the underlying error message. */
  detail?: string;
  /** ms epoch of the last status write. */
  updatedAt: number;
}

/**
 * The stage at which we lost sight of the submit. Every member means "an order
 * may exist"; they differ only in what the operator should go look at.
 */
export type UnknownSubmitReason =
  /** `fetch` itself threw — DNS, TLS, socket reset. */
  | 'network_throw'
  /** Our own `AbortSignal` fired. The request may still have been served. */
  | 'timeout'
  /** 5xx / 429 / 408 — the broker's edge answered, its backend may not have. */
  | 'broker_transport_status'
  /** 2xx whose body could not be read or parsed. */
  | 'unreadable_response'
  /** 2xx, parsed, no `order` payload and no `errors` payload. */
  | 'missing_order_payload';

// ─── ids ────────────────────────────────────────────────────────────────────

let intentSeq = 0;

/**
 * A process-local intent id. Uniqueness only has to hold within one journal
 * file, and the journal is per-process-tree; the boot-time random prefix keeps
 * two processes sharing a data dir from colliding.
 */
const INTENT_PREFIX = Math.random().toString(36).slice(2, 8);

export function newIntentId(now: number = Date.now()): string {
  intentSeq += 1;
  return `oi_${now.toString(36)}_${INTENT_PREFIX}_${intentSeq.toString(36)}`;
}

// ─── shape ──────────────────────────────────────────────────────────────────

/** First present value among `keys`, trimmed, else `null`. */
function bodyString(body: URLSearchParams, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = body.get(k);
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function bodyNumber(body: URLSearchParams, ...keys: string[]): number | null {
  const s = bodyString(body, ...keys);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the intent shape off an order body. Reads leg 0 for multileg/OTOCO
 * bodies, which is the ENTRY leg — the protective legs of an OTOCO cannot exist
 * without it, so matching the entry is sufficient to decide whether the order
 * reached the broker.
 */
export function shapeFromOrderBody(body: URLSearchParams): OrderIntentShape {
  return {
    orderClass: bodyString(body, 'class'),
    side: bodyString(body, 'side', 'side[0]'),
    symbol: bodyString(body, 'symbol', 'symbol[0]'),
    optionSymbol: bodyString(body, 'option_symbol', 'option_symbol[0]'),
    quantity: bodyNumber(body, 'quantity', 'quantity[0]'),
    limitPrice: bodyNumber(body, 'price', 'price[0]'),
  };
}

function norm(v: string | null): string | null {
  return v === null ? null : v.trim().toLowerCase();
}

/**
 * The breaker key. Two submits collide iff they would produce economically the
 * same order at the same account. Price is excluded — see {@link OrderIntentShape}.
 */
export function intentBreakerKey(accountId: string, shape: OrderIntentShape): string {
  return [
    accountId,
    norm(shape.orderClass) ?? '-',
    norm(shape.side) ?? '-',
    norm(shape.symbol) ?? '-',
    norm(shape.optionSymbol) ?? '-',
    shape.quantity === null ? '-' : String(shape.quantity),
  ].join('|');
}

// ─── the broker rows we reconcile against ───────────────────────────────────

/**
 * The subset of `TradierAccountOrder` the reconcile reads. Declared structurally
 * so this module carries no import edge to `options-client.ts` (which extends
 * the client that calls this — the cycle would be real, not just a type one).
 */
export interface ReconcilableOrderRow {
  id: number;
  status: string;
  orderClass: string;
  side: string | null;
  symbol: string | null;
  optionSymbol: string | null;
  quantity: number | null;
  execQuantity: number | null;
  /** ISO timestamp Tradier stamped at order CREATE. The reach axis. */
  createDate: string | null;
}

/**
 * A read of `/accounts/{id}/orders` that can say it FAILED.
 *
 * The existing `listOrders()` returns `[]` on auth/network failure and its own
 * docblock names that ambiguity. A reconciler handed that `[]` cannot tell
 * "the account is empty" from "I am blind", and one of those two licenses a
 * resubmit. So the reconcile refuses to consume `TradierAccountOrder[]` and
 * consumes this instead.
 */
export type OrderListRead =
  | { ok: true; orders: ReconcilableOrderRow[] }
  | { ok: false; reason: string };

export type IntentReconcileVerdict =
  | {
      kind: 'placed';
      orderId: number;
      /** Every flattened row sharing that order id. */
      rows: ReconcilableOrderRow[];
      /** Contracts/shares the broker reports executed. `null` when unreported. */
      filledQty: number | null;
      /** True when the broker row is in a terminal state. */
      terminal: boolean;
    }
  | { kind: 'not_placed' }
  | { kind: 'unresolved'; reason: UnresolvedReason };

export type UnresolvedReason =
  /** The orders endpoint could not be read at all. */
  | 'orders_read_failed'
  /**
   * The read succeeded but contains no row created at or after our submit
   * instant, so it does not demonstrate coverage of that instant. An empty list
   * always lands here.
   */
  | 'orders_window_unproven'
  /** A shape-matching row carries a `createDate` we cannot parse. */
  | 'ambiguous_row_timestamp'
  /** More than one distinct order id matches. We must not pick one. */
  | 'multiple_matches';

/** TRA-319's terminal set, duplicated here to keep this module import-free. */
const TERMINAL = new Set(['filled', 'canceled', 'rejected', 'expired', 'error']);

export interface ReconcileOptions {
  /**
   * Tolerance for broker-vs-local clock skew on the LOWER bound, ms. A broker
   * row stamped slightly before our `submitStartedAt` is still plausibly ours.
   */
  clockSkewMs?: number;
  /** Reconcile instant; the window's upper bound (plus skew). Defaults to now. */
  now?: number;
}

/** True when `row` could be the order `intent` tried to place. */
export function orderRowMatchesIntentShape(
  shape: OrderIntentShape,
  row: ReconcilableOrderRow,
): boolean {
  if (norm(shape.orderClass) !== null && norm(row.orderClass) !== norm(shape.orderClass)) {
    return false;
  }
  if (norm(shape.side) !== null && norm(row.side) !== norm(shape.side)) return false;
  if (norm(shape.symbol) !== null && norm(row.symbol) !== norm(shape.symbol)) return false;
  // An option intent must match the OCC. An equity intent has none, and a broker
  // row that carries one is an option order — never ours.
  if (norm(shape.optionSymbol) !== norm(row.optionSymbol)) return false;
  if (shape.quantity !== null && row.quantity !== shape.quantity) return false;
  return true;
}

/**
 * Decide what happened to an intent whose submit outcome was `unknown`.
 *
 * Pure — the caller does the fetch and hands the result in, so every branch is
 * exercisable from a fixture with no network. See the module docblock for why
 * `not_placed` requires a POSITIVE reach proof rather than an empty list.
 */
export function reconcileIntent(
  intent: OrderIntent,
  read: OrderListRead,
  options: ReconcileOptions = {},
): IntentReconcileVerdict {
  if (!read.ok) return { kind: 'unresolved', reason: 'orders_read_failed' };

  const skew = options.clockSkewMs ?? 60_000;
  const now = options.now ?? Date.now();
  const lower = intent.submitStartedAt - skew;
  const upper = now + skew;

  // The reach proof: at least one row the endpoint served was created at or
  // after our submit instant. Rows with an unparseable date cannot prove reach.
  let windowProven = false;
  const byId = new Map<number, ReconcilableOrderRow[]>();
  let ambiguousTimestamp = false;

  for (const row of read.orders) {
    const created = row.createDate === null ? Number.NaN : Date.parse(row.createDate);
    if (Number.isFinite(created) && created >= intent.submitStartedAt) windowProven = true;
    if (!orderRowMatchesIntentShape(intent.shape, row)) continue;
    if (!Number.isFinite(created)) {
      // A shape match we cannot place in time is neither ours nor provably not
      // ours. Calling it a match hands the caller someone else's order id;
      // calling it a non-match licenses a resubmit. Refuse to do either.
      ambiguousTimestamp = true;
      continue;
    }
    if (created < lower || created > upper) continue;
    const existing = byId.get(row.id);
    if (existing) existing.push(row);
    else byId.set(row.id, [row]);
  }

  if (byId.size > 1) return { kind: 'unresolved', reason: 'multiple_matches' };
  if (ambiguousTimestamp) return { kind: 'unresolved', reason: 'ambiguous_row_timestamp' };

  if (byId.size === 1) {
    const [orderId, rows] = [...byId.entries()][0];
    // TRA-1707 — an omitted `exec_quantity` is UNMEASURED, never a false zero.
    // Fold to `null` unless at least one row reported a finite number.
    let filledQty: number | null = null;
    for (const r of rows) {
      if (typeof r.execQuantity === 'number' && Number.isFinite(r.execQuantity)) {
        filledQty = Math.max(filledQty ?? 0, r.execQuantity);
      }
    }
    const terminal = rows.every((r) => TERMINAL.has(r.status.trim().toLowerCase()));
    return { kind: 'placed', orderId, rows, filledQty, terminal };
  }

  if (!windowProven) return { kind: 'unresolved', reason: 'orders_window_unproven' };
  return { kind: 'not_placed' };
}

// ─── the journal ────────────────────────────────────────────────────────────

/**
 * Durable pre-submit record. The engine package is filesystem-free by
 * convention, so this is an interface with an in-memory default; `packages/
 * server` installs a JSONL-backed implementation at boot.
 *
 * The install is a module-level singleton for the same reason
 * `setTradierOrderSubmitObserver` is (see its docblock): clients are constructed
 * ad hoc in a dozen places, and a per-client opt-in would silently miss whichever
 * construction site nobody remembered — which is precisely the class of gap this
 * exists to close.
 *
 * ⚠ Every method must be SYNCHRONOUS and must never throw. It sits on the submit
 * hot path, and a journal that throws would turn a healthy order into a failure.
 */
export interface OrderIntentJournal {
  /** Called BEFORE the POST leaves. */
  record(intent: OrderIntent): void;
  /** Called once the outcome is known, including a later reconcile. */
  update(intent: OrderIntent): void;
  /** Intents left `unknown` — the set a restart must re-latch from. */
  openUnknowns(): OrderIntent[];
}

export class InMemoryOrderIntentJournal implements OrderIntentJournal {
  private readonly intents = new Map<string, OrderIntent>();

  record(intent: OrderIntent): void {
    this.intents.set(intent.intentId, { ...intent });
  }

  update(intent: OrderIntent): void {
    this.intents.set(intent.intentId, { ...intent });
  }

  openUnknowns(): OrderIntent[] {
    return [...this.intents.values()].filter((i) => i.status === 'unknown' || i.status === 'submitting');
  }

  /** Test/inspection seam. */
  all(): OrderIntent[] {
    return [...this.intents.values()];
  }
}

let journal: OrderIntentJournal = new InMemoryOrderIntentJournal();

export function setOrderIntentJournal(next: OrderIntentJournal | null): void {
  journal = next ?? new InMemoryOrderIntentJournal();
}

export function getOrderIntentJournal(): OrderIntentJournal {
  return journal;
}

// ─── the breaker ────────────────────────────────────────────────────────────

/**
 * Why the halt is in force. `order_working` and `rehydrated_from_journal` are
 * not {@link UnresolvedReason}s — the first is a RESOLVED reconcile that found a
 * live order, the second is a restart re-latching an intent it never got to
 * reconcile at all. Kept distinct so an operator reading the health surface can
 * tell "I am blind" from "I can see it and it is still working".
 */
export type LatchReason = UnresolvedReason | 'order_working' | 'rehydrated_from_journal';

export interface LatchedIntent {
  intent: OrderIntent;
  reason: LatchReason;
  latchedAt: number;
}

/**
 * THE HALT. While a key is latched, no submit of that shape may leave this
 * process — that is the "one economic order per intent" guarantee.
 *
 * Two things latch:
 *  - an `unknown` submit whose reconcile came back `unresolved`; and
 *  - an `unknown` submit whose reconcile found the order ALIVE and non-terminal.
 *    The issue's invariant is explicit that a replacement requires a terminal
 *    `canceled|rejected|filled` first, and a working order is not one.
 *
 * A latch is NOT taken on the happy path. An acknowledged submit returns exactly
 * as it did before this ticket, so the maker walk's ordinary
 * submit → wait → cancel → resubmit cycle is unchanged. The halt engages only
 * once we have actually lost sight of an order.
 */
export class UnknownIntentBreaker {
  private readonly latched = new Map<string, LatchedIntent>();

  /** Monotonic counters. A halt nobody can count is a silent stop. */
  private counters = { latched: 0, resolved: 0, halts: 0, manualReleases: 0 };

  latch(key: string, entry: LatchedIntent): void {
    // Keep the FIRST latch: it names the submit we actually lost, and the
    // operator needs that one, not the most recent attempt to squeeze past it.
    if (this.latched.has(key)) return;
    this.latched.set(key, entry);
    this.counters.latched += 1;
  }

  get(key: string): LatchedIntent | undefined {
    return this.latched.get(key);
  }

  /** A submit was refused because this key is latched. Counted separately from
   *  the latch itself: one lost order can halt many attempts. */
  countHalt(): void {
    this.counters.halts += 1;
  }

  /** Released because a reconcile RESOLVED it. The normal exit. */
  clear(key: string): void {
    if (this.latched.delete(key)) this.counters.resolved += 1;
  }

  /**
   * THE OPERATOR ESCAPE HATCH.
   *
   * A halt that only a successful reconcile can lift is a trading stop with no
   * manual exit: if the orders endpoint is unreadable for this account, the
   * first 5xx latches the shape and nothing ever clears it. That is a worse
   * failure than the one this breaker prevents, because it is silent and
   * open-ended.
   *
   * Counted apart from {@link clear} on purpose. A manual release is an operator
   * asserting, from outside this process, that they have checked the broker and
   * the order is not live. It is NOT evidence of anything and must never be
   * summed together with reconcile-resolved releases into one "cleared" number.
   */
  releaseManually(key: string, operatorNote: string): LatchedIntent | null {
    const entry = this.latched.get(key);
    if (!entry) return null;
    this.latched.delete(key);
    this.counters.manualReleases += 1;
    this.released.push({ ...entry, releasedAt: Date.now(), operatorNote });
    return entry;
  }

  private readonly released: (LatchedIntent & { releasedAt: number; operatorNote: string })[] = [];

  manualReleaseLog(): readonly (LatchedIntent & { releasedAt: number; operatorNote: string })[] {
    return this.released;
  }

  entries(): LatchedIntent[] {
    return [...this.latched.values()];
  }

  keys(): string[] {
    return [...this.latched.keys()];
  }

  snapshotCounters(): { latched: number; resolved: number; halts: number; manualReleases: number } {
    return { ...this.counters };
  }

  get size(): number {
    return this.latched.size;
  }
}

/**
 * What a health route publishes. `armed` is stated rather than assumed: a reader
 * must be able to tell "no shape is halted" from "nothing is watching".
 */
export interface UnknownIntentSummary {
  armed: true;
  latchedCount: number;
  latched: {
    key: string;
    intentId: string;
    env: OrderIntentEnv;
    reason: LatchReason;
    latchedAt: number;
    shape: OrderIntentShape;
    orderId?: number;
  }[];
  counters: { latched: number; resolved: number; halts: number; manualReleases: number };
}

export function summarizeUnknownIntents(): UnknownIntentSummary {
  const brk = getUnknownIntentBreaker();
  const keys = brk.keys();
  return {
    armed: true,
    latchedCount: brk.size,
    latched: keys.map((key) => {
      const e = brk.get(key) as LatchedIntent;
      return {
        key,
        intentId: e.intent.intentId,
        env: e.intent.env,
        reason: e.reason,
        latchedAt: e.latchedAt,
        shape: e.intent.shape,
        ...(e.intent.orderId !== undefined ? { orderId: e.intent.orderId } : {}),
      };
    }),
    counters: brk.snapshotCounters(),
  };
}

let breaker = new UnknownIntentBreaker();

export function getUnknownIntentBreaker(): UnknownIntentBreaker {
  return breaker;
}

/** Test seam — and the boot-time rehydrate target. */
export function __resetUnknownIntentBreakerForTest(): void {
  breaker = new UnknownIntentBreaker();
}

/**
 * Re-latch from a journal after a process restart.
 *
 * The "process restart mid-intent" case is the one a purely in-memory breaker
 * gets wrong in the expensive direction: the box comes back with an empty
 * breaker, the ladder resubmits, and the order we lost is still working at the
 * broker. Rehydrating turns a restart into a halt rather than a duplicate.
 *
 * `submitting` intents — written pre-POST, never updated — are the worst case:
 * the process died between the journal write and the response, so the order may
 * exist and we never even saw a status code. They latch too.
 */
export function rehydrateBreakerFromJournal(
  source: OrderIntentJournal = journal,
  now: number = Date.now(),
): number {
  let n = 0;
  for (const intent of source.openUnknowns()) {
    breaker.latch(intentBreakerKey(intent.accountId, intent.shape), {
      intent,
      reason: 'rehydrated_from_journal',
      latchedAt: now,
    });
    n += 1;
  }
  return n;
}
