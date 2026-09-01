// TRA-3937 — snapshot/hydrate imports for durable census.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
 *
 * ## TRA-4223 — the census had ONE leg. Closes are the other one.
 *
 * Everything above describes the ENTRY leg, and until this ticket that was the
 * whole module: {@link recordBrokerSubmit} / {@link recordBrokerReject} had
 * exactly two call sites, both inside `mirrorLiveOptionOpen`. The close path
 * was never observed at all.
 *
 * Measured on real money 2026-08-31: the production `admin` book (Tradier
 * ***0154) staged exits on 3 live rows, all 3 submits threw on a Tradier HTTP
 * 500, and all 3 tripped the TRA-450 close-reject breaker — leaving three
 * unprotected real-money rows with breached stops. The census cell for that
 * book read `observed:false, submitted:0, brokerRejects:0, verdict:"idle"`. It
 * was not miscounting; it was structurally blind. **A book that attempted three
 * exits and failed all three was byte-identical to a book that did nothing** —
 * the same silent-clean shape the entry leg was built to kill, one seam over.
 *
 * The close leg is counted in its OWN fields ({@link BookDayCell.closeSubmitted}
 * and friends), never folded into `submitted`/`filled`. Two reasons, both
 * load-bearing:
 *
 *   • `submitted` vs `filled` is the TRA-3905 discriminator for *account
 *     permission*, and it means "the broker saw an OPEN and did not fill it".
 *     Adding closes to that numerator would silently redefine the one pair this
 *     module exists to publish.
 *   • The two legs fail for different reasons and take different operator
 *     actions. An entry that never submits costs an opportunity; a close that
 *     never submits leaves live capital unprotected. A reader has to be able to
 *     tell them apart on the row, without arithmetic.
 *
 * `verdict` therefore grades BOTH legs and reports the worse of the two (see
 * {@link BrokerSubmitCensusRow.verdict}) — a book whose entries all filled must
 * not read `green` while its exits are all failing, and a book with no entries
 * and N failed exits must not read `idle`. That last sentence is the ticket.
 *
 * ### What the close leg covers, stated so a zero cannot be mistaken for coverage
 *
 * INSTRUMENTED (all in `signal-engine.ts`): `submitStagedOptionExits` — the
 * engine's staged SL/TP/trail exits, which is the 2026-08-31 path;
 * `escalateCappedExit` — the TRA-3418 re-submit; `resolvePendingOptionExits` —
 * the async terminal outcome of an order submitted on an earlier tick; and
 * `submitManualOptionClose` — the operator's Close button on an engine-opened
 * row, which on 08-31 failed on the same Tradier 500.
 *
 * ## TRA-4260 — the `pendingCloseOrderId` machinery, the second close shape
 *
 * The four seams above all key off `pendingExit`. There is a SECOND close shape
 * in the codebase — a row carrying `pendingCloseOrderId` — reached by the
 * IMPORTED-position branch of `POST /api/options/:id/close` (`index.ts`) and
 * resolved by the engine's per-tick `reconcilePendingCloses`. It was not
 * instrumented, so a book whose only close activity went through it read
 * `closeAttempts: 0, closeVerdict: "idle"` — the same absent-reads-clean shape
 * TRA-4223 was filed against, one route over. It is now instrumented end to end:
 *
 *   • `index.ts` imported branch → {@link SignalEngine.recordBrokerCloseCensusEvent}
 *     fed by {@link smartSellCloseCensusEvents}, so the route needs no clock, no
 *     book key and no taxonomy of its own — it lands on the SAME census row as
 *     the four engine seams;
 *   • `reconcilePendingCloses` — the terminal outcome (`filled` / `partial_fill`
 *     / `rejected`) of an order those routes left `pending`, the fill-chaser's
 *     reprice re-submits, and the partial-fill remainder re-submit.
 *
 * The terminal leg is not optional bonus coverage: recording `submitted` at the
 * route and nothing at the sweep would leave a book that closed cleanly 30s
 * later reading `closeAttempts: 1, closeFilled: 0` ⇒ `degraded`, forever. A
 * false `degraded` desensitises the instrument exactly as a false `idle` blinds
 * it.
 *
 * `submitSmartSellToClose` RETURNS its failures rather than throwing them, so
 * the TRA-4223 reached-Tradier-vs-threw split cannot be read off `status`
 * alone — its `rejected` covers BOTH a broker refusal and a submit that threw.
 * The helper therefore publishes the split itself (`failure`, and
 * `submittedOrders` for the multi-attempt walk); see `tradier-smart-close.ts`.
 *
 * ⛔ NOT INSTRUMENTED, and deliberately: PAPER closes. The demo / no-creds
 * sub-path of the same route (and `manualClosePosition` on the equity book)
 * never contacts a broker, so it has nothing to say about broker outcomes and
 * counting it would inflate the denominator this fold publishes. Named here
 * rather than left silent, because "an absent cell must not read like a clean
 * one" is the property this whole module is built around and it applies to its
 * own coverage first.
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
  /**
   * TRA-4226 — the BROKER'S OWN INFRASTRUCTURE failed: an HTTP 5xx, a gateway
   * error, or a transport-level fault. **Nothing was refused.** The contract was
   * never evaluated, no account state was consulted, and the correct operator
   * response is "retry when the broker is back" — NOT "investigate the account".
   *
   * Distinct from its two neighbours in both directions:
   *   • `throw` — OUR client raised (network/auth/parse) and no broker verdict
   *     of any kind came back. `transport` is the broker ANSWERING that it is
   *     broken.
   *   • `other` — the broker returned a refusal we cannot read. That is a
   *     genuine unknown and may well be terminal; a 5xx is known and is not.
   * Sharing one bucket made a broker outage and an unexplained reject the same
   * reading — see {@link classifyBrokerRejectText}.
   */
  | 'transport'
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
  'transport',
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

/**
 * TRA-4223 — what happened to one staged CLOSE.
 *
 * Its own taxonomy, deliberately NOT {@link BrokerRejectClass}. That enum is
 * the entry leg's, it is wired to the permission breaker, and its members
 * (`walk_exhausted`, `spread_veto`, `permission_blocked`) describe refusals only
 * the open path can produce. Reusing it would have forced a close outcome into
 * a bucket whose name lies, and would have coupled two circuits the ticket
 * explicitly says must stay independent.
 *
 * The split that matters here is **did the order reach Tradier**:
 *
 *   • `submitted` — the broker accepted it and handed back an order id. This is
 *     the close-leg analogue of `submitted` on the entry leg, and it carries the
 *     same meaning: from here on, any failure is the broker's verdict.
 *   • `transport_fault` / `submit_throw` — the submit THREW. Nothing reached a
 *     broker decision, so neither may be counted as `submitted`; the entry
 *     seam's docblock (`signal-engine.ts`) is explicit that `submitted` means
 *     "the broker saw it and did not fill it", and a throw did not clear that
 *     bar. They are split from each other on the TRA-4226 line: a Tradier 5xx /
 *     timeout is the BROKER'S infrastructure failing (`transport_fault`, retry
 *     when it is back) while anything else is OURS (`submit_throw`, investigate
 *     the client). Callers classify with `isTransportOrderFailure(err)` and must
 *     NOT string-match the message.
 *   • `filled` / `rejected` / `expired` — terminal outcomes of an order that DID
 *     reach the broker. `expired` is separate for the same reason TRA-2984 gave
 *     it its own counter on the position: the order reached the broker and
 *     lapsed unfilled, which is not the broker refusing anything.
 *
 * ## TRA-4260 — `no_quote_abort`, the close leg's PRE-SUBMIT abort
 *
 * `submitSmartSellToClose` refuses to place a `sell_to_close` it cannot price:
 * the quote lookup threw, the OCC returned nothing usable, or the walk's next
 * step rounded to ≤ 0. Nothing is handed to Tradier. That is a THIRD stage,
 * neither "reached the broker" nor "the submit threw", and the ticket that added
 * it required the choice be stated rather than silently dropped. It is:
 *
 *   • **counted**, in its own field ({@link BookDayCell.closeNoQuoteAborts}),
 *     never folded into `closeSubmitted` — the reached-vs-threw split above is
 *     the one TRA-4223 turns on and a pre-submit abort clears neither bar; and
 *   • **inside {@link BrokerSubmitCensusRow.closeAttempts}**, so it makes the
 *     book non-`idle`.
 *
 * The second half is the load-bearing one, and it is where this leg parts
 * company with the entry leg on purpose. On entries a pre-submit abort is
 * excluded from the `idle` denominator (`preSubmitAborts` is published but does
 * not grade), because an entry we refused to place costs an opportunity and
 * nothing else. **An exit we refused to place leaves live capital unprotected**
 * — the module docblock already names that asymmetry as the reason the two legs
 * are counted apart. An operator who pressed Close three times and got three
 * `no_quote` refusals has a book that tried to get flat and did not, and a
 * census that reads `idle` over that is the defect, not the fix. So the same
 * sentence TRA-4223 wrote about throws — "still an exit this book tried and
 * failed to place" — governs here, and yields `degraded`.
 */
export type BrokerCloseEvent =
  | 'submitted'
  | 'filled'
  | 'rejected'
  | 'expired'
  | 'transport_fault'
  | 'submit_throw'
  | 'no_quote_abort';

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
  // ── TRA-4223: the CLOSE leg. Never folded into the four fields above. ──
  /** `sell_to_close` orders Tradier ACCEPTED (an order id came back). */
  closeSubmitted: number;
  /** …of those, the ones that filled. */
  closeFilled: number;
  /** …of those, the ones the broker refused / cancelled / errored. */
  closeRejected: number;
  /** …of those, the ones that reached the broker and lapsed unfilled. */
  closeExpired: number;
  /** Close submits that threw on a BROKER infrastructure fault (5xx/timeout). */
  closeTransportFaults: number;
  /** Close submits that threw for a non-broker reason (network/auth/parse). */
  closeSubmitThrows: number;
  /** TRA-4260 — closes we refused to price. Nothing reached Tradier. */
  closeNoQuoteAborts: number;
}

/** etDay -> book -> cell. */
const store = new Map<string, Map<string, BookDayCell>>();

/**
 * TRA-3937 — ET days whose data was loaded from a snapshot file rather than
 * accumulated by this process. Used to set `fromSnapshot` on the report so
 * `check:broker-census` can distinguish a durable post-close read (CLEAN/FAIL)
 * from a mid-session restart (FORFEIT).
 */
const hydratedDays = new Set<string>();

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
    closeSubmitted: 0,
    closeFilled: 0,
    closeRejected: 0,
    closeExpired: 0,
    closeTransportFaults: 0,
    closeSubmitThrows: 0,
    closeNoQuoteAborts: 0,
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
 *
 * ## TRA-4226 — `transport` is carved out of `other`, and ONLY out of `other`
 *
 * On 2026-08-31 the `v0nni` book went 4 submitted / 0 filled and the census
 * correctly read `degraded` — but all 4 rejects landed in `other`, so the
 * instrument could say the book was broken and could not say why. The retained
 * text, verbatim and identical on all four (`/api/health/option-journal`
 * `voids.recent[]`, 14:38:33Z · 14:39:31Z · 15:15:46Z · 19:07:56Z):
 *
 *   `Tradier order rejected: Tradier order failed (500): An error occurred
 *    while communicating with the backend.`
 *
 * — byte-identical to the `(500)` the production `admin` book's three refused
 * closes carry the same day. **One Tradier backend incident, two books.** That
 * is not an unexplained refusal: nothing was decided, and "retry when the broker
 * is back" is a different operator action from "investigate the account".
 *
 * The ordering below is load-bearing and is the whole safety argument. The 5xx
 * arm sits BELOW `permission` and `buying_power`, so it can only ever consume
 * text that previously fell through to `other`. Every input that classified as
 * `permission` (and so arms the breaker) or `buying_power` before this change
 * still does, by construction rather than by test coverage — the breaker's
 * behaviour cannot regress from a change that never runs on its inputs. The
 * asymmetry the paragraph above states therefore holds unchanged: the default is
 * still `other`, and `transport` inherits `other`'s transience, adding only the
 * reason.
 *
 * The 5xx patterns are deliberately anchored on FAILURE wording rather than on a
 * bare `(5\d\d)`: `Quantity (500) exceeds …` is a refusal, not an outage, and a
 * parenthesised number on its own is not a status code. The observed string
 * matches two of these arms independently.
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
  if (
    // Tradier's own 2026-08-31 wording — each half stands alone.
    /fail(?:ed|ure|s)?\s*\(5\d\d\)/.test(t) ||
    /error occurred while communicating with the backend/.test(t) ||
    // An explicitly labelled 5xx, however the wrapper spelled it.
    /\b(?:http|https|status)\s*(?:code\s*)?[:=]?\s*5\d\d\b/.test(t) ||
    // The standard gateway/5xx reason phrases, which arrive with no number.
    /internal server error|bad gateway|service unavailable|gateway time-?out/.test(t) ||
    // Transport faults that surfaced as a broker ANSWER rather than a throw.
    /econnreset|econnrefused|etimedout|enotfound|epipe|socket hang up/.test(t) ||
    /network error|fetch failed|upstream (?:error|timeout)/.test(t)
  ) {
    return 'transport';
  }
  return 'other';
}

/** One order handed to the broker. */
export function recordBrokerSubmit(book: string, etDay: string): void {
  cellFor(etDay, book).submitted += 1;
  persistCensusDayIfArmed(etDay);
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
  persistCensusDayIfArmed(etDay);
}

/**
 * TRA-4223 — one event on the CLOSE leg. See {@link BrokerCloseEvent}.
 *
 * ⛔ This function deliberately touches NEITHER `consecutivePermission`,
 * `blockedSince` NOR `refusedByBreaker`. The TRA-3905 permission breaker and the
 * TRA-450 `close_reject_breaker` are two independent circuits with two different
 * latches and two different remedies, and `submissionsRefusedByBreaker` is the
 * published count of the FORMER. Fusing them — the remedy the filing originally
 * proposed — would have made a broker outage on the exit path read as an account
 * permission halt, damaging TRA-3905's instrument to fix TRA-4223's. There is a
 * regression test pinned on exactly this (`tra4223-close-census.test.ts`).
 *
 * It also does not reset the permission run on a close FILL. A close filling is
 * not proof the account may OPEN options — the 2026-08-20 restricted book could
 * still have sold anything it held — and `recordBrokerFill`'s reset exists for
 * that proof specifically.
 */
export function recordBrokerCloseEvent(book: string, etDay: string, event: BrokerCloseEvent): void {
  const cell = cellFor(etDay, book);
  switch (event) {
    case 'submitted':
      cell.closeSubmitted += 1;
      break;
    case 'filled':
      cell.closeFilled += 1;
      break;
    case 'rejected':
      cell.closeRejected += 1;
      break;
    case 'expired':
      cell.closeExpired += 1;
      break;
    case 'transport_fault':
      cell.closeTransportFaults += 1;
      break;
    case 'submit_throw':
      cell.closeSubmitThrows += 1;
      break;
    case 'no_quote_abort':
      cell.closeNoQuoteAborts += 1;
      break;
  }
  persistCensusDayIfArmed(etDay);
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
    persistCensusDayIfArmed(etDay);
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
  persistCensusDayIfArmed(etDay);
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
  // ── TRA-4223: the CLOSE leg, counts only (TRA-2163) ───────────────────────
  /** `sell_to_close` orders Tradier ACCEPTED. Throws are NOT in here. */
  closeSubmitted: number;
  closeFilled: number;
  closeRejected: number;
  closeExpired: number;
  /**
   * Close submits that threw on the BROKER's own infrastructure (5xx/timeout).
   * The 2026-08-31 admin shape is `closeTransportFaults: 3` with everything else
   * on the leg at 0 — three staged exits, none of which reached a decision.
   */
  closeTransportFaults: number;
  /** Close submits that threw for a non-broker reason (network/auth/parse). */
  closeSubmitThrows: number;
  /**
   * TRA-4260 — closes the smart-close layer refused to price, so no order was
   * ever built. Published on its own because it is a THIRD stage: neither
   * reached-the-broker nor threw. See {@link BrokerCloseEvent}.
   */
  closeNoQuoteAborts: number;
  /**
   * Every close order this book TRIED to place: reached + threw + refused to
   * price (TRA-4260). This is the denominator that makes `idle` mean "did
   * nothing" again — it is non-zero for a book whose only broker activity was N
   * failed exits.
   */
  closeAttempts: number;
  /**
   * The two legs graded separately, so a reader can see WHICH one is broken
   * rather than inferring it from the counts. Same scale as {@link verdict};
   * `red` never appears here — the permission breaker is an entry-side circuit
   * and is reported on {@link verdict} alone.
   */
  entryVerdict: BrokerSubmitVerdict;
  closeVerdict: BrokerSubmitVerdict;
  /**
   * The one-glance read, so the negative control does not depend on a reader
   * doing the arithmetic:
   *   • `red`      — permission rejects seen, or the breaker is tripped. Human.
   *   • `degraded` — the broker saw orders and filled none, all transient.
   *   • `idle`     — nothing submitted. Says nothing about health either way.
   *   • `green`    — at least one fill and no permission reject.
   *
   * TRA-4223 — this is now the WORSE of {@link entryVerdict} and
   * {@link closeVerdict} (`red` > `degraded` > `green` > `idle`), because both
   * of the single-leg readings are false in the field:
   *   • entries-only made a book that failed 3 exits and opened nothing read
   *     `idle`, which is the defect this ticket was filed for;
   *   • grading the union of the two legs' counters would let 2 filled entries
   *     mask 3 failed exits, which is the same defect wearing a `green` label.
   *
   * ⚠️ A non-zero {@link closeTransportFaults} does NOT by itself force
   * `degraded` — a day that lost one close to a 5xx and then filled it on the
   * retry genuinely is green, and `degraded` is defined as "filled none". The
   * fault count is published on the row and rolled up fleet-wide instead
   * (TRA-4226's shape), so an outage is readable without overloading a verdict
   * that other gates already key on.
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
    /**
     * TRA-4226 — 5xx/transport rejects across every graded book. This is a
     * FLEET-level read on purpose: the 2026-08-31 incident hit `v0nni` and
     * `admin` with the identical `(500)`, and the question it answers ("is the
     * broker down, or is one account broken?") is not answerable from any one
     * row. Count only — the raw text is never folded up here (TRA-2163).
     */
    transportRejects: number;
    /** Books the breaker has halted. Non-zero is an incident. */
    permissionBlockedBookCount: number;
    redBookCount: number;
    degradedBookCount: number;
    // ── TRA-4223: the close leg, fleet-wide ───────────────────────────────
    /** Every close order the fleet tried to place today, reached or not. */
    closeAttempts: number;
    closeFilled: number;
    closeRejected: number;
    /**
     * Close submits that never reached a broker decision because Tradier's own
     * infrastructure failed. Fleet-level for the same reason `transportRejects`
     * is: "is the broker down, or is one book broken?" is not answerable from
     * one row, and on 2026-08-31 the identical `(500)` hit both books at once.
     */
    closeTransportFaults: number;
    /** Books with ≥1 close submit that threw on a broker fault. */
    closeTransportBookCount: number;
    /**
     * TRA-4260 — closes the fleet refused to price. Fleet-level for the same
     * reason its neighbours are: a dead-quote day is a market-wide condition
     * (a halted underlying, a stale feed), and one row cannot tell it apart
     * from one book holding one untradeable OCC. Count only (TRA-2163).
     */
    closeNoQuoteAborts: number;
    /** Books that tried to close and filled none. The unprotected-capital count. */
    closeDegradedBookCount: number;
  };
  /** ET days currently held, oldest first — the retention window, measured. */
  retainedEtDays: string[];
  /**
   * TRA-3937 — true when this day's data was loaded from a durable snapshot
   * rather than accumulated by the current process. `check:broker-census` uses
   * this to distinguish a durable post-close read (grade CLEAN/FAIL) from a
   * mid-session restart where the live fold is partial (grade FORFEIT).
   */
  fromSnapshot: boolean;
}

function zeroRejects(): Record<BrokerRejectClass, number> {
  const out = {} as Record<BrokerRejectClass, number>;
  for (const c of BROKER_REJECT_CLASSES) out[c] = 0;
  return out;
}

/**
 * TRA-4223 — grade one leg. `attempts` is every order the leg TRIED to place
 * (reached the broker or not); `fills` is what came back filled.
 */
function gradeLeg(attempts: number, fills: number): BrokerSubmitVerdict {
  if (attempts === 0) return 'idle';
  return fills === 0 ? 'degraded' : 'green';
}

/** Worse-of, on `red > degraded > green > idle`. See {@link BrokerSubmitCensusRow.verdict}. */
const VERDICT_SEVERITY: Record<BrokerSubmitVerdict, number> = {
  idle: 0,
  green: 1,
  degraded: 2,
  red: 3,
};

function gradeRow(book: string, etDay: string, cell: BookDayCell | undefined): BrokerSubmitCensusRow {
  const rejects = zeroRejects();
  if (cell) for (const [c, n] of cell.rejects) rejects[c] = n;
  const permissionRejects = rejects.permission;
  const blocked = (cell?.blockedSince ?? null) !== null;
  const submitted = cell?.submitted ?? 0;
  const filled = cell?.filled ?? 0;
  const closeSubmitted = cell?.closeSubmitted ?? 0;
  const closeTransportFaults = cell?.closeTransportFaults ?? 0;
  const closeSubmitThrows = cell?.closeSubmitThrows ?? 0;
  const closeNoQuoteAborts = cell?.closeNoQuoteAborts ?? 0;
  const closeFilled = cell?.closeFilled ?? 0;
  // TRA-4223 — the throws are IN the denominator on purpose: a submit that never
  // reached Tradier is still an exit this book tried and failed to place, and
  // leaving it out is precisely what let three failed closes read `idle`.
  // TRA-4260 — and so is a `no_quote` pre-submit abort, by the same sentence: an
  // exit we refused to price leaves the capital just as unprotected. This is the
  // one place the close leg deliberately parts company with the entry leg, whose
  // `preSubmitAborts` are published but do not grade. See {@link BrokerCloseEvent}.
  const closeAttempts = closeSubmitted + closeTransportFaults + closeSubmitThrows + closeNoQuoteAborts;
  const entryVerdict = gradeLeg(submitted, filled);
  const closeVerdict = gradeLeg(closeAttempts, closeFilled);
  const worseLeg =
    VERDICT_SEVERITY[closeVerdict] > VERDICT_SEVERITY[entryVerdict] ? closeVerdict : entryVerdict;
  const verdict: BrokerSubmitVerdict = blocked || permissionRejects > 0 ? 'red' : worseLeg;
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
    closeSubmitted,
    closeFilled,
    closeRejected: cell?.closeRejected ?? 0,
    closeExpired: cell?.closeExpired ?? 0,
    closeTransportFaults,
    closeSubmitThrows,
    closeNoQuoteAborts,
    closeAttempts,
    entryVerdict,
    closeVerdict,
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
      transportRejects: rows.reduce((a, r) => a + r.rejects.transport, 0),
      permissionBlockedBookCount: rows.filter(r => r.brokerPermissionBlocked).length,
      redBookCount: rows.filter(r => r.verdict === 'red').length,
      degradedBookCount: rows.filter(r => r.verdict === 'degraded').length,
      closeAttempts: rows.reduce((a, r) => a + r.closeAttempts, 0),
      closeFilled: rows.reduce((a, r) => a + r.closeFilled, 0),
      closeRejected: rows.reduce((a, r) => a + r.closeRejected, 0),
      closeTransportFaults: rows.reduce((a, r) => a + r.closeTransportFaults, 0),
      closeTransportBookCount: rows.filter(r => r.closeTransportFaults > 0).length,
      closeNoQuoteAborts: rows.reduce((a, r) => a + r.closeNoQuoteAborts, 0),
      closeDegradedBookCount: rows.filter(r => r.closeVerdict === 'degraded').length,
    },
    retainedEtDays: [...store.keys()].sort(),
    fromSnapshot: hydratedDays.has(etDay),
  };
}

// ─── TRA-3937: durable snapshot ──────────────────────────────────────────────

function censusSnapDir(dataDir: string): string {
  return join(dataDir, 'broker-census');
}
function censusSnapPath(dataDir: string, etDay: string): string {
  return join(censusSnapDir(dataDir), `${etDay}.json`);
}

/**
 * TRA-3917 — the directory write-through persistence is armed against, or `null`
 * when nothing has armed it (unit tests, CLI importers). Set by
 * {@link hydrateCensusFromDir}, which the server calls once at boot.
 *
 * ## Why write-through, and not the health-route write alone
 *
 * `6eac1bd` (TRA-3937) persisted the fold from ONE place: the
 * `/api/health/options-live` handler. That is sufficient only if something calls
 * that route while the accumulating process is still alive. On 2026-08-21 nothing
 * did: the 16:10 ET reader routine fired at 20:10:00Z, the post-close deploy burst
 * booted a new process at 20:12:29Z, and the agent's actual GET did not land until
 * 21:17:30Z — 65 minutes after the fold it was grading had already been freed. The
 * session forfeited WITH the snapshot code deployed, because the snapshot code
 * never ran. A durability fix whose trigger is the reader cannot survive a late
 * reader, and the reader is late exactly when the deploy burst makes it late.
 *
 * So the write moves to the only events that can ever change a cell. After this,
 * the on-disk snapshot is current as of the last broker event regardless of who
 * reads, when, or whether anyone reads at all.
 */
let snapshotDir: string | null = null;

/**
 * Last serialized payload written per ET day. Skips the `writeFileSync` when a
 * mutation did not change the bytes, so a long refused-by-breaker run does not
 * re-write an identical file hundreds of times. Purely an fs-churn bound — it is
 * never consulted for correctness.
 */
const lastWritten = new Map<string, string>();

/**
 * Write-through hook for the record* functions. A no-op until
 * {@link hydrateCensusFromDir} arms it, so importing this module never touches
 * the filesystem on its own.
 */
function persistCensusDayIfArmed(etDay: string): void {
  if (snapshotDir === null) return;
  persistCensusDaySync(etDay, snapshotDir);
}

function serializeDay(day: Map<string, BookDayCell>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [book, cell] of day) {
    out[book] = { ...cell, rejects: Object.fromEntries(cell.rejects) };
  }
  return out;
}

function deserializeDay(raw: Record<string, unknown>): Map<string, BookDayCell> {
  const day = new Map<string, BookDayCell>();
  for (const [book, c] of Object.entries(raw)) {
    const cell = c as Record<string, unknown>;
    const rejectsRaw = (cell['rejects'] ?? {}) as Record<string, number>;
    day.set(book, {
      submitted: Number(cell['submitted'] ?? 0),
      filled: Number(cell['filled'] ?? 0),
      rejects: new Map(Object.entries(rejectsRaw).map(([k, v]) => [k as BrokerRejectClass, Number(v)])),
      brokerRejects: Number(cell['brokerRejects'] ?? 0),
      preSubmitAborts: Number(cell['preSubmitAborts'] ?? 0),
      consecutivePermission: Number(cell['consecutivePermission'] ?? 0),
      blockedSince: cell['blockedSince'] != null ? Number(cell['blockedSince']) : null,
      blockedReason: cell['blockedReason'] != null ? String(cell['blockedReason']) : null,
      refusedByBreaker: Number(cell['refusedByBreaker'] ?? 0),
      alerted: Boolean(cell['alerted']),
      // TRA-4223 — `?? 0` is the migration: a snapshot written before this
      // ticket carries no close leg at all, and reading it back must yield a
      // zeroed leg rather than `NaN`, which would poison every sum downstream
      // and render as `null` through JSON.
      closeSubmitted: Number(cell['closeSubmitted'] ?? 0),
      closeFilled: Number(cell['closeFilled'] ?? 0),
      closeRejected: Number(cell['closeRejected'] ?? 0),
      closeExpired: Number(cell['closeExpired'] ?? 0),
      closeTransportFaults: Number(cell['closeTransportFaults'] ?? 0),
      closeSubmitThrows: Number(cell['closeSubmitThrows'] ?? 0),
      // TRA-4260 — same `?? 0` migration as the TRA-4223 fields above: a
      // snapshot written before this ticket carries no `closeNoQuoteAborts`,
      // and reading it back as `NaN` would poison `closeAttempts` and every
      // sum downstream, rendering as `null` through JSON.
      closeNoQuoteAborts: Number(cell['closeNoQuoteAborts'] ?? 0),
    });
  }
  return day;
}

/**
 * TRA-3937 — write a snapshot of `etDay`'s cells to `dataDir/broker-census/YYYY-MM-DD.json`.
 * Called from the health route after reading the census, so the snapshot is written
 * while the process is still alive — before the post-close deploy burst kills it.
 * Idempotent and fail-soft: a write failure never throws to the caller.
 */
export function persistCensusDaySync(etDay: string, dataDir: string): void {
  const day = store.get(etDay);
  if (!day || day.size === 0) return;
  const payload = JSON.stringify(serializeDay(day));
  if (lastWritten.get(etDay) === payload) return;
  try {
    mkdirSync(censusSnapDir(dataDir), { recursive: true });
    writeFileSync(censusSnapPath(dataDir, etDay), payload);
    lastWritten.set(etDay, payload);
  } catch {
    // fail-soft: a write error must never break the health route or a broker
    // event. `lastWritten` is deliberately NOT set on failure, so the next
    // mutation retries rather than treating the failed write as done.
  }
}

/**
 * TRA-3937 — on boot, load all snapshot files from `dataDir/broker-census/` and
 * populate the in-memory store. Live-process data always wins: if a day is already
 * in the store (accumulated this session) the snapshot is skipped.
 */
export function hydrateCensusFromDir(dataDir: string): { days: number } {
  // TRA-3917 — arm write-through FIRST, before any early return. On the very
  // first boot the snapshot directory does not exist yet, `readdirSync` throws,
  // and arming below that `catch` would leave the box durable only from its
  // SECOND boot onward — i.e. undurable on exactly the day the directory is
  // created, which is the day this was shipped to fix.
  snapshotDir = dataDir;
  const snapDir = censusSnapDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(snapDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return { days: 0 };
  }
  let loaded = 0;
  for (const f of entries) {
    const etDay = f.slice(0, 10);
    if (store.has(etDay)) continue; // live-process data wins
    try {
      const raw = JSON.parse(readFileSync(join(snapDir, f), 'utf-8')) as Record<string, unknown>;
      store.set(etDay, deserializeDay(raw));
      hydratedDays.add(etDay);
      loaded += 1;
    } catch {
      // corrupt or unreadable snapshot: skip silently
    }
  }
  return { days: loaded };
}

// ─── end TRA-3937 ────────────────────────────────────────────────────────────

/** Test seam only. */
export function __resetBrokerSubmitCensusForTest(): void {
  store.clear();
  hydratedDays.clear();
  // TRA-3917 — disarm write-through too. A test that armed it against a temp dir
  // would otherwise leave every LATER test in the file writing to a directory it
  // never asked for (and, once that temp dir is removed, exercising the fail-soft
  // path instead of the one it means to test).
  snapshotDir = null;
  lastWritten.clear();
}
