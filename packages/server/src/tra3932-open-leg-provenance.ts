/**
 * TRA-3932 — WHO OPENED THE CONTRACT? The open-leg provenance resolver.
 *
 * ## The question, and why nothing already deployed can answer it
 *
 * TRA-3926's detector splits every engine `sell_to_close` into three buckets:
 * FINDINGS (the engine sold more than its own recorded opens covered), JUDGED-
 * CLEAN, and BLIND. On 2026-08-21 the blind bucket was BIGGER than the finding
 * bucket — 4 closes / 9 contracts, every one `import_only`: an engine close
 * (`origin:'fill'`, a real broker order id) against an open leg whose only
 * evidence is a `history_import` row.
 *
 * That shape has two causes and OUR BYTES CANNOT SEPARATE THEM:
 *
 *   1. the desk opened it and the ENGINE sold it — TRA-3926's defect, one level
 *      worse, because the engine transacted a position it held no row for; or
 *   2. the engine opened it and our own fill chokepoint missed the fill, so the
 *      TRA-2959 importer recovered it from broker history — measured, not
 *      hypothetical: 7 of 11 filled orders never reached the ledger.
 *
 * The filing said the discriminator was one fetch away: *"A Tradier order record
 * for the opening order either exists under our API credentials or it does not."*
 *
 * ## That premise is FALSE, and this module is where it is refuted with evidence
 *
 * Three independent facts, each measured rather than assumed:
 *
 * **(a) `/accounts/{id}/history` carries no order id on this account.** The
 * reconcile already fetches it hourly and the parser already lifts
 * `trade.order_id`. Measured 2026-08-21 on the live production book: `orderId` is
 * `null` on 4/4 broker option rows in the reconcile's own `lastHistorySample` and
 * on 13/13 `history_import` ledger rows, against 38/38 present on fill-time rows.
 * A clean partition on origin — the broker simply does not send it here. The
 * docblock on `TradierTradeHistoryFill.orderId` promised otherwise and is now
 * corrected; TRA-3932 was filed on the strength of that promise.
 *
 * **(b) The one surface that DOES carry order records has an unmeasured reach.**
 * `/accounts/{id}/orders` ({@link TradierOptionsClient.listOrders}, added by this
 * ticket) is the only Tradier reader that returns orders. Tradier documents no
 * date range on it and `scripts/tra3299-sandbox-attribution.mjs` already records
 * "its /orders covers the CURRENT trading day only" for sandbox. This module
 * therefore MEASURES the reach from the returned rows' own `create_date` and
 * refuses to grade any subject the list does not reach — see
 * {@link BrokerOrderReach}.
 *
 * **(c) Even a reachable order record would not, by itself, discriminate.** An
 * order the desk typed into Tradier's web dashboard and an order this engine
 * POSTed are the SAME SHAPE, and no submit path of ours sets a `tag`. Provenance
 * is a JOIN against our own side — and the set we would join against does not
 * exist. Measured across every durable writer in `packages/server/src`: the
 * broker order id reaches disk in exactly ONE place, `live-options-fee-slippage.jsonl`,
 * and only at **FILL** time. An order that was placed and whose fill our chokepoint
 * missed — the exact population in question — leaves NO durable id anywhere. The
 * in-memory submit census (`broker-submit-census.ts`) is process-lifetime by
 * design, and the paper snapshot holds only currently-working CLOSE ids.
 *
 * ⇒ **The absence of an order id in our records cannot distinguish "the desk
 * placed it" from "we placed it and did not record the fill", because that is
 * the same absence the defect is made of.** Membership is a POSITIVE witness in
 * one direction only, and this module encodes exactly that asymmetry:
 * {@link engineFilledOrderIds} can only ever CONFIRM `engine_placed`, never refute
 * it, and `desk_placed` requires a separate, currently-nonexistent
 * {@link OpenLegProvenanceInput.engineSubmittedOrderIds} witness.
 *
 * ## The property this is built around: a blind must never become an accusation
 *
 * Every failure mode of the broker read — unreadable, short window, empty list —
 * lands in the BLIND bucket with its own reason, never in `desk_placed`. This is
 * not defensive coding: TRA-3926's detector shipped a first version that called
 * four of these very contracts findings, which would have been four false
 * accusations against the desk off exactly this ambiguity. An endpoint that
 * serves the current day only would, read as a closed world, accuse the desk of
 * every contract older than this morning.
 *
 * ## Durability, and why it is load-bearing rather than tidy
 *
 * AC1 asks for the answer to be published somewhere durable, "a blind that gets
 * re-derived every beat is the same instrument as no answer". The stronger reason
 * is that **the evidence has a shelf life**: if `/orders` really does serve the
 * current trading day only, then the order record for a contract opened today is
 * readable today and gone tomorrow. A verdict reached on it must be written down
 * in the beat it is reached, because it is not re-derivable. Terminal verdicts are
 * therefore append-once and immutable; blind attempts are ALSO recorded, because
 * "we asked the broker on these N days and it could not reach back" is the
 * evidence that turns a permanent blind into a finding rather than an omission.
 *
 * ## Not in scope
 *
 * No restatement, no force-close, no remediation of the money — same posture as
 * TRA-3926 and TRA-3913. This establishes WHAT HAPPENED.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { TradierAccountOrder } from '@trading-app/engine';
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type { OversoldCloseCensus } from './tra3926-oversold-close-detector.js';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'tra3932-open-leg-provenance' });

export const OPEN_LEG_PROVENANCE_LOG_FILENAME = 'tra3932-open-leg-provenance.jsonl';

/**
 * Deliberately NOT retention-compacted, unlike every sibling ledger.
 *
 * The other ledgers hold measurements that a later run can retake. This one holds
 * verdicts about specific historical contracts reached from evidence that expires,
 * so ageing a line out destroys an answer nothing can reproduce. It grows by a
 * handful of lines per resolve run over a fixed 11-contract subject set.
 */
export const OPEN_LEG_PROVENANCE_RETENTION = 'none — verdicts are not re-derivable';

/**
 * Sides that OPEN a long option position. The subject population is long/debit
 * only — the production Tradier account is `cash` (memory: long/debit options
 * only), so `sell_to_open` cannot appear on it. It is matched anyway: an opening
 * order we failed to recognise would read as `blind_no_order_record`, which is
 * the false-negative direction, and a blind is cheap while a missed record is a
 * silently wrong reach measurement.
 */
const OPENING_SIDES = new Set(['buy_to_open', 'sell_to_open']);

/** Tradier statuses under which contracts actually reached the account. */
const EXECUTED_STATUSES = new Set(['filled', 'partially_filled']);

/**
 * Did this order put ANY contract in the account? Status first; `execQuantity`
 * second so a cancelled-after-partial row (status `canceled`, exec > 0) still
 * counts — it DID open something, and that something needs a provenance.
 */
export function orderExecuted(o: TradierAccountOrder): boolean {
  if (EXECUTED_STATUSES.has(String(o.status ?? '').toLowerCase())) return true;
  return typeof o.execQuantity === 'number' && Number.isFinite(o.execQuantity) && o.execQuantity > 0;
}

/** One verdict about ONE OCC's opening leg. */
export type OpenLegProvenanceVerdict =
  /**
   * An opening ORDER record for this OCC exists at the broker AND its id is one
   * our own fill ledger recorded as ours. Positive, terminal, and the only
   * direction our records can settle unaided.
   */
  | 'engine_placed'
  /**
   * An opening order record exists, its id is NOT in our set of issued ids, AND a
   * durable submit-time issuer witness was available to make that absence mean
   * something. ⇒ a NEW instance of TRA-3926's defect, predating the bound (AC3).
   */
  | 'desk_placed'
  /** The broker order read failed or was not attempted. Nothing was concluded. */
  | 'blind_broker_unreadable'
  /**
   * The order list's own oldest `create_date` is AFTER the day the leg opened, so
   * the endpoint provably does not reach the subject. **This is AC5.**
   */
  | 'blind_broker_window'
  /**
   * The list reaches the open's ET day and holds no opening order for this OCC.
   * Still not an accusation: the reach test is over the LIST, and a broker that
   * pages or filters could reach the day without holding the row.
   */
  | 'blind_no_order_record'
  /**
   * An opening order record exists and is not in our fill-time id set — and that
   * absence CANNOT be read as "not ours", because no durable submit-time id set
   * exists (see the module docblock, point (c)). The one verdict that is a
   * statement about OUR instrumentation rather than about the broker.
   */
  | 'blind_no_issuer_witness';

/** Terminal verdicts: written once, never re-derived, never overwritten. */
export const TERMINAL_PROVENANCE_VERDICTS: ReadonlySet<OpenLegProvenanceVerdict> = new Set<
  OpenLegProvenanceVerdict
>(['engine_placed', 'desk_placed']);

export function isTerminalProvenanceVerdict(v: OpenLegProvenanceVerdict): boolean {
  return TERMINAL_PROVENANCE_VERDICTS.has(v);
}

/**
 * What the broker's order list actually covered, derived from the rows themselves.
 *
 * `read: false` and `orders: 0` are DIFFERENT states and are kept apart on purpose:
 * `listOrders` returns `[]` on an auth/network failure exactly as it does on an
 * empty account, so the caller's own knowledge of whether the fetch threw is the
 * only thing that separates them. Folding them would let a failed fetch present as
 * "the broker holds no orders", which is the closed-world reading this module
 * exists to refuse.
 */
export interface BrokerOrderReach {
  /** Did a fetch actually complete? `false` ⇒ every verdict is `blind_broker_unreadable`. */
  read: boolean;
  /** Rows returned (all classes). */
  orders: number;
  /** Of those, rows carrying an OCC option symbol. */
  optionOrders: number;
  /** Oldest `create_date` seen, ISO. `null` ⇒ the list carried no usable timestamp. */
  oldestCreateDate: string | null;
  newestCreateDate: string | null;
  /** ET days the list's own timestamps span, ascending. The reach axis, published. */
  etDaysCovered: string[];
  /**
   * Rows whose `create_date` would not parse. A list of 40 rows with 40 unparseable
   * dates has NO measured reach and must not read as reaching anything.
   */
  rowsMissingCreateDate: number;
}

/** One subject contract group — an OCC whose opening leg TRA-3926 could not attribute. */
export interface OpenLegSubject {
  optionSymbol: string;
  /** `finding` = TRA-3926 charged an excess here; `blind` = it refused to judge. */
  kind: 'finding' | 'blind';
  /** Contracts in question: the excess for a finding, the import-only open for a blind. */
  contracts: number;
  /** ET day the opening leg is recorded against — the day the reach test asks about. */
  openEtDay: string;
  /** ET day the engine's close landed, for legibility on the published row. */
  closeEtDay: string;
  /** Broker order id of OUR close. Present by construction on an engine close. */
  closeOrderId: number | null;
}

/** One resolved row. */
export interface OpenLegProvenanceRow extends OpenLegSubject {
  verdict: OpenLegProvenanceVerdict;
  /**
   * EXECUTED opening order ids the broker's list held for this OCC (may be empty).
   * Only an order that put a contract in the account can be that contract's
   * provenance — see `brokerUnfilledOpeningOrderIds` for the ones that did not.
   */
  brokerOpeningOrderIds: number[];
  /** Of those, the ones our own fill ledger records as ours. */
  matchedEngineOrderIds: number[];
  /**
   * Opening orders for this OCC that NEVER executed (cancelled walk steps,
   * rejects, expiries). Listed so a reader can see them, and EXCLUDED from every
   * join above: joining on these is wrong in BOTH directions — a cancelled engine
   * walk step would read `engine_placed` for a contract the desk bought, and a
   * cancelled desk attempt would read `desk_placed` for one the engine filled.
   * Measured on real bytes 2026-08-25 (BAC260925C00063000: archived opening order
   * 142843026 of 08-21 with no matching buy in the broker's own history).
   * Optional on the type only because rows persisted before it existed lack it.
   */
  brokerUnfilledOpeningOrderIds?: number[];
  /** Prose naming the evidence that produced the verdict. Computed, never templated from the hypothesis. */
  detail: string;
  /** ms epoch the resolution ran. */
  resolvedAt: number;
}

export interface OpenLegProvenanceInput {
  census: OversoldCloseCensus;
  records: readonly LiveOptionFillRecord[];
  /**
   * The broker's order list, or `null` when the fetch did not complete. `null` and
   * `[]` mean different things here and the type says so.
   */
  brokerOrders: readonly TradierAccountOrder[] | null;
  /**
   * Broker order ids we can prove we SUBMITTED, independent of whether the fill was
   * recorded. `null` ⇒ no such durable set exists, which is the live state today
   * (see the module docblock, point (c)) and forces `blind_no_issuer_witness`
   * rather than an unearned `desk_placed`.
   *
   * Threaded as a parameter rather than read from a module global so the
   * `desk_placed` branch is REACHABLE in a test. A verdict whose only possible
   * value is blind, in a resolver whose blind output is identical either way,
   * would be indistinguishable from a resolver that cannot produce it at all —
   * TRA-3926's C8 lesson, one ticket over.
   */
  engineSubmittedOrderIds: ReadonlySet<number> | null;
  /**
   * TRA-3939 — the ET days {@link engineSubmittedOrderIds} is ENTITLED TO SPEAK
   * ABOUT, and the reason a non-null id set is not on its own a witness.
   *
   * The submit ledger starts empty. Hand the resolver its ids without a coverage
   * axis and every order the engine placed BEFORE the recorder was armed reads as
   * "absent from our records" — and step 6 turns that absence into `desk_placed`,
   * charging a real person with a trade this engine made. The blind this module
   * exists to preserve would become an accusation on the ledger's first day.
   *
   * So a day is only usable when something attests the recorder was resident for
   * the whole window in which the order could have been placed. `null` ⇒ no
   * coverage information at all, which is treated exactly as no witness.
   *
   * The asymmetry from {@link engineFilledOrderIds} still holds and is why this is
   * only needed on the refuting side: a fill-time id MATCH is a positive statement
   * and needs no coverage claim (step 4 sits above this). It is the INFERENCE FROM
   * ABSENCE that requires knowing the recorder was watching.
   */
  engineSubmitWitnessEtDays: ReadonlySet<string> | null;
  resolvedAt: number;
}

export interface OpenLegProvenanceResult {
  reach: BrokerOrderReach;
  rows: OpenLegProvenanceRow[];
  /** Contracts by verdict — the fold the ticket's AC3/AC4 counts are read off. */
  contractsByVerdict: Record<OpenLegProvenanceVerdict, number>;
  /** Subject contracts in total. `11` on the 2026-08-21 tape: 9 blind + 2 excess. */
  subjectContracts: number;
  /**
   * Contracts still unanswered. `subjectContracts` minus the terminal ones. The
   * number the ticket is actually about; it does NOT shrink because a run was
   * blind for a new reason.
   */
  unresolvedContracts: number;
}

/** ET calendar day (America/New_York) of an ISO timestamp, or `null` if unparseable. */
export function etDayOfIso(iso: string | null): string | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return etDayOfMs(ms);
}

/** ET calendar day of a ms-epoch instant. */
export function etDayOfMs(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/**
 * Measure what the broker's order list covered. PURE over the rows, so the reach a
 * verdict was reached under is reproducible from the same capture.
 */
export function measureBrokerOrderReach(
  brokerOrders: readonly TradierAccountOrder[] | null,
): BrokerOrderReach {
  if (brokerOrders === null) {
    return {
      read: false,
      orders: 0,
      optionOrders: 0,
      oldestCreateDate: null,
      newestCreateDate: null,
      etDaysCovered: [],
      rowsMissingCreateDate: 0,
    };
  }
  let optionOrders = 0;
  let rowsMissingCreateDate = 0;
  let oldest: { iso: string; ms: number } | null = null;
  let newest: { iso: string; ms: number } | null = null;
  const days = new Set<string>();
  for (const o of brokerOrders) {
    if (typeof o.optionSymbol === 'string' && o.optionSymbol !== '') optionOrders += 1;
    const ms = o.createDate === null ? NaN : Date.parse(o.createDate);
    if (!Number.isFinite(ms)) {
      rowsMissingCreateDate += 1;
      continue;
    }
    const iso = o.createDate as string;
    if (oldest === null || ms < oldest.ms) oldest = { iso, ms };
    if (newest === null || ms > newest.ms) newest = { iso, ms };
    days.add(etDayOfMs(ms));
  }
  return {
    read: true,
    orders: brokerOrders.length,
    optionOrders,
    oldestCreateDate: oldest?.iso ?? null,
    newestCreateDate: newest?.iso ?? null,
    etDaysCovered: [...days].sort(),
    rowsMissingCreateDate,
  };
}

/**
 * Does the measured list reach `etDay`?
 *
 * TRUE requires a measured oldest timestamp at or before the day. An unread list,
 * an empty list, and a list of rows with no parseable date all answer FALSE — the
 * three ways a reader could otherwise conclude "no order existed" from having seen
 * nothing.
 */
export function reachCovers(reach: BrokerOrderReach, etDay: string): boolean {
  if (!reach.read) return false;
  const oldest = etDayOfIso(reach.oldestCreateDate);
  if (oldest === null) return false;
  return oldest <= etDay;
}

/**
 * Derive the subject set from TRA-3926's census plus the ledger.
 *
 * The census names the CLOSE; the open's ET day has to come from the ledger rows
 * the close consumed, because the reach test asks about the day the ORDER was
 * placed, not the day it was sold. Where several import rows back one close, the
 * OLDEST is used: the reach test must clear the hardest day, not the easiest one.
 */
export function deriveOpenLegSubjects(
  census: OversoldCloseCensus,
  records: readonly LiveOptionFillRecord[],
): OpenLegSubject[] {
  const subjects: OpenLegSubject[] = [];
  const oldestImportedOpenEtDay = (occ: string): string | null => {
    let day: string | null = null;
    for (const r of records) {
      if (r.optionSymbol !== occ) continue;
      if (r.side !== 'buy_to_open') continue;
      if (r.origin !== 'history_import') continue;
      if (day === null || r.etDay < day) day = r.etDay;
    }
    return day;
  };
  for (const f of census.findings) {
    if (!(f.excessContracts > 0)) continue;
    subjects.push({
      optionSymbol: f.optionSymbol,
      kind: 'finding',
      contracts: f.excessContracts,
      // The excess was taken out of the desk's outstanding contracts, so the leg
      // whose provenance is in question is the IMPORTED one, not the engine's.
      openEtDay: oldestImportedOpenEtDay(f.optionSymbol) ?? f.etDay,
      closeEtDay: f.etDay,
      closeOrderId: f.orderId,
    });
  }
  for (const b of census.blindCloses) {
    if (b.reason !== 'import_only') continue;
    if (!(b.importedOpenContracts > 0)) continue;
    const closeEtDay = etDayOfMs(b.ts);
    subjects.push({
      optionSymbol: b.optionSymbol,
      kind: 'blind',
      contracts: b.importedOpenContracts,
      openEtDay: oldestImportedOpenEtDay(b.optionSymbol) ?? closeEtDay,
      closeEtDay,
      // The census does not publish a blind close's order id; the ledger holds it.
      closeOrderId: closeOrderIdFor(records, b.optionSymbol, b.ts),
    });
  }
  return subjects;
}

function closeOrderIdFor(
  records: readonly LiveOptionFillRecord[],
  occ: string,
  ts: number,
): number | null {
  for (const r of records) {
    if (r.optionSymbol === occ && r.ts === ts && r.side === 'sell_to_close') return r.orderId ?? null;
  }
  return null;
}

/** Order ids our own fill ledger recorded as ours (`origin !== 'history_import'`). */
export function engineFilledOrderIds(records: readonly LiveOptionFillRecord[]): Set<number> {
  const ids = new Set<number>();
  for (const r of records) {
    if (r.origin === 'history_import') continue;
    if (typeof r.orderId === 'number' && Number.isFinite(r.orderId)) ids.add(r.orderId);
  }
  return ids;
}

const EMPTY_BY_VERDICT = (): Record<OpenLegProvenanceVerdict, number> => ({
  engine_placed: 0,
  desk_placed: 0,
  blind_broker_unreadable: 0,
  blind_broker_window: 0,
  blind_no_order_record: 0,
  blind_no_issuer_witness: 0,
});

/**
 * Resolve every subject contract's opening leg. PURE — the same inputs grade a
 * hand-built fixture exactly as they grade the live book.
 *
 * The decision order is the fail-closed order, and each step is a refusal that
 * fires BEFORE the step that could accuse:
 *
 *   1. no read              → `blind_broker_unreadable`
 *   2. list misses the day  → `blind_broker_window`      (AC5)
 *   3. no EXECUTED opening  → `blind_no_order_record`    (unfilled ones are named, never joined)
 *   4. id in our FILL set   → `engine_placed`            (positive, terminal)
 *   5. no submit ledger     → `blind_no_issuer_witness`
 *   6. id in our SUBMIT set → `engine_placed`            (positive, terminal)
 *   7. day not attested     → `blind_no_issuer_witness`  (TRA-3939)
 *   8. id is not ours       → `desk_placed`              (positive, terminal, AC3)
 *
 * Steps 4 and 6 sit ABOVE the blinds deliberately: an id MATCH is a positive
 * statement and needs no coverage claim to mean something. Steps 5 and 7 sit above
 * step 8 because the reverse — reading "absent from our records" as "the desk
 * placed it" — is precisely the inference this ticket exists to refuse, and step 7
 * is the specific form of it TRA-3939 had to add: an id set that EXISTS but was
 * not recording on the day in question is silent, not exculpatory.
 */
export function resolveOpenLegProvenance(input: OpenLegProvenanceInput): OpenLegProvenanceResult {
  const reach = measureBrokerOrderReach(input.brokerOrders);
  const subjects = deriveOpenLegSubjects(input.census, input.records);
  const oursByFill = engineFilledOrderIds(input.records);
  const rows: OpenLegProvenanceRow[] = [];
  const contractsByVerdict = EMPTY_BY_VERDICT();
  let subjectContracts = 0;
  let unresolvedContracts = 0;

  for (const s of subjects) {
    subjectContracts += s.contracts;
    const openingOrders = (input.brokerOrders ?? []).filter(
      (o) =>
        o.optionSymbol === s.optionSymbol &&
        typeof o.side === 'string' &&
        OPENING_SIDES.has(o.side.toLowerCase()),
    );
    // Only an order that EXECUTED can be the provenance of a contract in the
    // account. The unfilled ones are real broker rows with real ids — the engine's
    // limit walk mints up to five per open (TRA-3939 AC1) — and every one of them
    // is in our submit ledger, so joining on them would turn a cancelled engine
    // attempt into an `engine_placed` for a contract the DESK filled.
    const executed = openingOrders.filter(orderExecuted);
    const unfilled = openingOrders.filter((o) => !orderExecuted(o));
    const brokerOpeningOrderIds = executed.map((o) => o.id);
    const brokerUnfilledOpeningOrderIds = unfilled.map((o) => o.id);
    const matchedEngineOrderIds = brokerOpeningOrderIds.filter((id) => oursByFill.has(id));

    let verdict: OpenLegProvenanceVerdict;
    let detail: string;
    if (!reach.read) {
      verdict = 'blind_broker_unreadable';
      detail = 'the broker order list was not read this run; nothing was concluded';
    } else if (!reachCovers(reach, s.openEtDay)) {
      verdict = 'blind_broker_window';
      detail =
        `the order list's oldest create_date is ${reach.oldestCreateDate ?? 'unmeasured'} ` +
        `(${reach.orders} row(s), ${reach.rowsMissingCreateDate} without a parseable date), ` +
        `which does not reach the ${s.openEtDay} open — the endpoint provably cannot answer for this contract`;
    } else if (brokerOpeningOrderIds.length === 0) {
      verdict = 'blind_no_order_record';
      detail =
        `the order list reaches ${s.openEtDay} (oldest ${reach.oldestCreateDate}) and holds no EXECUTED ` +
        `opening order for ${s.optionSymbol}` +
        (unfilled.length > 0
          ? ` — ${unfilled.length} opening order(s) exist but never filled (${unfilled
              .map((o) => `${o.id}:${o.status}`)
              .join(', ')}), and an order that put no contract in the account cannot be the provenance of one`
          : '') +
        `; absence in a list that may page or filter is not a positive refutation`;
    } else if (matchedEngineOrderIds.length > 0) {
      verdict = 'engine_placed';
      detail =
        `opening order ${matchedEngineOrderIds.join(', ')} is in our own fill ledger — a POSITIVE witness ` +
        `that this engine placed it; the missing open row is a TRA-2959 recording gap, not an over-sell`;
    } else if (input.engineSubmittedOrderIds === null) {
      verdict = 'blind_no_issuer_witness';
      detail =
        `opening order ${brokerOpeningOrderIds.join(', ')} exists at the broker and is absent from our ` +
        `fill-time id set — and that absence cannot be read as "not ours", because no durable submit-time ` +
        `order-id record exists (the id reaches disk only on a FILL). This is a gap in OUR instrumentation`;
    } else if (brokerOpeningOrderIds.some((id) => input.engineSubmittedOrderIds!.has(id))) {
      // Positive membership needs no coverage claim: an id IN our submit ledger was
      // put there by our own submit path. Coverage only ever gates the INFERENCE
      // FROM ABSENCE below, so this sits above the coverage test on purpose.
      verdict = 'engine_placed';
      detail =
        `opening order ${brokerOpeningOrderIds.join(', ')} is in the durable submit-time id set — this ` +
        `engine issued it and the fill was never recorded (TRA-2959)`;
    } else if (input.engineSubmitWitnessEtDays === null || !input.engineSubmitWitnessEtDays.has(s.openEtDay)) {
      // TRA-3939 — THE STEP THAT KEEPS AN EMPTY LEDGER FROM BECOMING AN ACCUSATION.
      // The id set exists but was not recording on the day this leg opened, so its
      // silence is not testimony. Same verdict as having no ledger at all, because
      // for THIS contract that is exactly what we have.
      verdict = 'blind_no_issuer_witness';
      detail =
        `opening order ${brokerOpeningOrderIds.join(', ')} exists at the broker and is absent from both ` +
        `our fill-time and our submit-time id sets — but the submit recorder is NOT attested for the ` +
        `${s.openEtDay} open (${
          input.engineSubmitWitnessEtDays === null
            ? 'no coverage record'
            : `attested days: ${[...input.engineSubmitWitnessEtDays].sort().join(', ') || 'none'}`
        }), so its silence about this day is not evidence. The absence is OURS, not the desk's`;
    } else {
      verdict = 'desk_placed';
      detail =
        `opening order ${brokerOpeningOrderIds.join(', ')} exists at the broker and is in NEITHER our ` +
        `fill-time nor our submit-time id set, and the submit recorder IS attested for the ` +
        `${s.openEtDay} open — so no path of ours issued it. The engine transacted a ` +
        `contract the desk opened: a NEW instance of TRA-3926's defect, predating the bound`;
    }

    contractsByVerdict[verdict] += s.contracts;
    if (!isTerminalProvenanceVerdict(verdict)) unresolvedContracts += s.contracts;
    rows.push({
      ...s,
      verdict,
      brokerOpeningOrderIds,
      matchedEngineOrderIds,
      brokerUnfilledOpeningOrderIds,
      detail,
      resolvedAt: input.resolvedAt,
    });
  }

  return { reach, rows, contractsByVerdict, subjectContracts, unresolvedContracts };
}

// ── Durable store ────────────────────────────────────────────────────────────

/** One appended line. `kind` is declared so a future line shape cannot silently fold in. */
interface ProvenanceLine {
  kind: 'resolution';
  row: OpenLegProvenanceRow;
  reach: BrokerOrderReach;
}

let dataDir: string | null = null;

export function setOpenLegProvenanceDataDir(dir: string | null): void {
  dataDir = dir;
}

export function openLegProvenanceLogPath(dir: string): string {
  return join(dir, OPEN_LEG_PROVENANCE_LOG_FILENAME);
}

/**
 * Append this run's rows. Terminal verdicts already on disk are NOT re-written and
 * NOT re-graded: they were reached from evidence that may no longer exist, so a
 * later blind run must never be able to overwrite an answer with a shrug.
 *
 * Best-effort on IO and COUNTED, matching the sibling ledgers — a swallowed write
 * that nothing counts is the silent-clean failure this codebase keeps paying for.
 */
export function persistOpenLegProvenance(result: OpenLegProvenanceResult): {
  appended: number;
  skippedAlreadyTerminal: number;
  appendErrors: number;
} {
  const stored = readOpenLegProvenance();
  const terminal = new Set(
    stored.filter((l) => isTerminalProvenanceVerdict(l.row.verdict)).map((l) => subjectKey(l.row)),
  );
  let appended = 0;
  let skippedAlreadyTerminal = 0;
  let appendErrors = 0;
  if (dataDir == null) {
    return { appended: 0, skippedAlreadyTerminal: 0, appendErrors: 0 };
  }
  const path = openLegProvenanceLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces it
  }
  for (const row of result.rows) {
    if (terminal.has(subjectKey(row))) {
      skippedAlreadyTerminal += 1;
      continue;
    }
    const line: ProvenanceLine = { kind: 'resolution', row, reach: result.reach };
    try {
      appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
      appended += 1;
    } catch (err) {
      appendErrors += 1;
      log.warn('tra3932 open-leg provenance append failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { appended, skippedAlreadyTerminal, appendErrors };
}

/** A subject's identity: the contract and the day its opening leg is recorded against. */
export function subjectKey(s: OpenLegSubject): string {
  return `${s.optionSymbol}|${s.openEtDay}`;
}

/** Read every stored line. Corrupt lines are COUNTED by {@link summarizeStoredProvenance}, never dropped silently. */
export function readOpenLegProvenance(): ProvenanceLine[] {
  if (dataDir == null) return [];
  let raw: string;
  try {
    raw = readFileSync(openLegProvenanceLogPath(dataDir), 'utf8');
  } catch {
    return [];
  }
  const out: ProvenanceLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as ProvenanceLine;
      if (parsed && parsed.kind === 'resolution' && parsed.row) out.push(parsed);
    } catch {
      // counted by the summary's own read, not swallowed into a clean answer
    }
  }
  return out;
}

/** What the durable store says about each subject, folded newest-terminal-first. */
export interface StoredProvenanceSummary {
  dataDir: string | null;
  ephemeral: boolean;
  /** Lines on disk. */
  lines: number;
  /** Distinct subjects the store has ever been asked about. */
  subjects: number;
  /** Subjects holding a terminal verdict — the ANSWERED ones. */
  answered: number;
  /** Per subject: the terminal verdict if one exists, else the latest blind and how many times we asked. */
  rows: Array<{
    key: string;
    optionSymbol: string;
    openEtDay: string;
    contracts: number;
    verdict: OpenLegProvenanceVerdict;
    terminal: boolean;
    attempts: number;
    firstAskedAt: number;
    lastAskedAt: number;
    detail: string;
  }>;
}

export function summarizeStoredProvenance(): StoredProvenanceSummary {
  const lines = readOpenLegProvenance();
  const byKey = new Map<string, ProvenanceLine[]>();
  for (const l of lines) {
    const k = subjectKey(l.row);
    const g = byKey.get(k);
    if (g) g.push(l);
    else byKey.set(k, [l]);
  }
  const rows: StoredProvenanceSummary['rows'] = [];
  let answered = 0;
  for (const [key, group] of byKey) {
    const ordered = [...group].sort((a, b) => a.row.resolvedAt - b.row.resolvedAt);
    const terminalLine = ordered.find((l) => isTerminalProvenanceVerdict(l.row.verdict));
    const chosen = terminalLine ?? ordered[ordered.length - 1]!;
    if (terminalLine) answered += 1;
    rows.push({
      key,
      optionSymbol: chosen.row.optionSymbol,
      openEtDay: chosen.row.openEtDay,
      contracts: chosen.row.contracts,
      verdict: chosen.row.verdict,
      terminal: isTerminalProvenanceVerdict(chosen.row.verdict),
      attempts: ordered.length,
      firstAskedAt: ordered[0]!.row.resolvedAt,
      lastAskedAt: ordered[ordered.length - 1]!.row.resolvedAt,
      detail: chosen.row.detail,
    });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    dataDir,
    ephemeral: isEphemeralDataDir(dataDir),
    lines: lines.length,
    subjects: byKey.size,
    answered,
    rows,
  };
}
