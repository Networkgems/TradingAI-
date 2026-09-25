/**
 * TRA-3939 — THE TWO CAPTURES THAT MAKE AN OPEN-LEG PROVENANCE QUESTION ANSWERABLE.
 *
 * ## The two measurements this exists for (TRA-3932, both on the live production book)
 *
 * **(1) The broker's order surface is a ONE-DAY window.** Measured 2026-08-21T22:06Z
 * via `listOrders()`: 5 orders, `etDaysCovered ["2026-08-21"]`, oldest `create_date`
 * that same morning. `/accounts/{id}/history` reaches back 45 days but serves
 * `order_id: null` on every option row here (4/4 broker rows, 13/13 imported ledger
 * rows) — so the ONLY surface carrying order records has the SHORTEST reach of the
 * three. The XLF finding's open (2026-08-20) missed the window by ONE DAY.
 *
 * **(2) We hold no durable record of order ids we SUBMITTED.** The broker order id
 * reaches disk in exactly one place, `live-options-fee-slippage.jsonl`, and only at
 * FILL time. The submit census is process-lifetime by design. So an order we placed
 * whose fill the chokepoint missed — and TRA-2959 measured 7 of 11 filled orders
 * never reaching the ledger — leaves NO id anywhere.
 *
 * ## Why BOTH, and why neither alone
 *
 * A submit-time id ledger alone answers *"did we place THIS order id"* — but with
 * no captured order list there is no id to ask about. A daily order capture alone
 * answers *"what orders did the account hold"* — but a desk order typed into
 * Tradier's dashboard and an engine order are the SAME SHAPE and no submit path of
 * ours sets a `tag`. Existence is not provenance. Together they are decisive.
 *
 * ## THE TRAP THIS MODULE IS BUILT AROUND: an EMPTY witness is not an ABSENT one
 *
 * The naive wiring of half (2) is to hand `resolveOpenLegProvenance` the set of ids
 * we have recorded and let its `desk_placed` branch fire. That is **wrong on the
 * first day and wrong in the expensive direction**: the ledger starts empty, so
 * every order the engine placed BEFORE it was armed is "absent from our records" —
 * and the resolver, handed a non-null set, would read that absence as *the desk
 * placed it* and charge a real person with a trade the engine made. The blind the
 * whole chain exists to preserve would become an accusation on day one.
 *
 * So a witness is not a set of ids. It is a set of ids **plus the ET days it is
 * entitled to speak about**, and this module publishes both. An open on a day the
 * recorder is not attested for reads `blind_no_issuer_witness`, exactly as it does
 * with no ledger at all — see {@link summarizeEngineSubmitWitness}.
 *
 * ## What attests a day, and the limit of that attestation, stated
 *
 * A day is witness-covered iff BOTH:
 *   • the broker-order capture for that ET day SUCCEEDED — a real post-close read
 *     from this process, which is a witness that the submit recorder was resident
 *     at that day's close; and
 *   • the process serving that capture BOOTED BEFORE the session opened, so it was
 *     resident for the whole window in which an order could have been placed.
 *
 * The second clause is the one that makes the first mean something. A box that
 * crashed at 14:00Z and came back at 21:00Z would otherwise attest a day through
 * which it recorded nothing. That day is captured (the orders are saved — that is
 * half (1) and it still works) but it is NOT witness-covered, and it is named
 * `partial` rather than silently folded either way.
 *
 * This is deliberately weaker than "the recorder ran continuously". It is what can
 * actually be measured from one process's own bytes, and naming its limit is the
 * difference between an instrument and a claim.
 *
 * ## Retention (AC5) — what is compacted and what is NOT
 *
 * **Neither store is compacted. Both are append-only and retained without bound.**
 * Every sibling ledger on this box ages rows out (`live-options-fee-slippage.jsonl`
 * retains 30 days; the submit census retains 30 ET days in memory) because they hold
 * MEASUREMENTS — a number a later run can retake. These two hold EVIDENCE:
 *
 *   • The broker order capture is the only copy that will ever exist of a day's
 *     order records. The source expires at the next ET rollover. Ageing a line out
 *     destroys the answer to a question nobody has asked yet, which is the exact
 *     failure this ticket was filed on.
 *   • The submit-id ledger's whole value is REACH BACKWARD. A 30-day window would
 *     make it answer for contracts opened this month and go blind on the ones that
 *     have been open longest — the population most likely to be in question.
 *
 * The cost is bounded and small: one line per acknowledged order (a handful per
 * trading day, five at worst per entry attempt) and one line per ET day for the
 * capture. At the observed rate this is single-digit MB per year. If a bound ever
 * becomes necessary it must be an ARCHIVE, never a delete — and it is not necessary
 * now, so no code pretends to make that decision.
 *
 * ⚠ Durability is a property of the PATH, not of a successful write (TRA-1681):
 * with `DATA_DIR` unset these files land inside the build bundle and evaporate on
 * the next redeploy with no error to catch. `ephemeral` is published on both
 * summaries and MUST be read first.
 *
 * ## TRA-4009 — A CAPTURED DAY IS A CLAIM ABOUT **ONE ACCOUNT** UNTIL THE LINE SAYS WHICH
 *
 * `listOrders()` is per Tradier account. The first cut of half (2) resolved ONE
 * production client (`resolveLiveBrokerOperator()`'s — the admin's) and wrote one
 * line per ET day with no account on it, while the fleet trades TWO live books.
 * Measured 2026-08-25: the fill ledger held two NVTS `buy_to_open` fills on 08-24
 * (`143021643` @1.54, `143032832` @1.51) and two `sell_to_close` on 08-25
 * (`143196771`, `143197015`); the captures held ONE of each, and the admin
 * account's own broker history agreed with the capture to the row. The other
 * account's orders were never archived at all — so a provenance question on a
 * `v0nni` contract lands `blind_broker_window` / `blind_no_order_record` FOREVER,
 * on a day the surface reported as captured. That is the defect TRA-3939 was
 * filed to end, surviving intact on the sibling book.
 *
 * The submit half never had this problem: it records `accountId` on every line and
 * `engineSubmittedProductionOrderIds()` unions both books. So the ID SET was
 * fleet-wide while the ORDER ARCHIVE was one-account — the worst possible pairing,
 * because the fleet-wide half makes the one-account half look complete.
 *
 * Every capture line therefore carries `account` (the operator/book it was read AS)
 * and `accountId` (the Tradier account number the rows came from), and the archive
 * is keyed on `(etDay, account)`. A day captured for one account and not another is
 * a NAMED GAP on the one that is missing.
 *
 * ### The two folds this module publishes, and why they are NOT the same fold
 *
 * Conflating them is the whole trap, so they are named separately:
 *
 *   • **`attestedEtDays` — a PROCESS property.** "The submit recorder was resident
 *     for the whole window in which an order could have been placed on this day."
 *     It is what a `desk_placed` verdict stands on, and the submit ledger it
 *     licenses is fleet-wide. One account's successful, full-session capture already
 *     proves the process was up and armed, so this folds by **union** across
 *     accounts. Intersecting would silently retract residency we actually proved.
 *   • **`fleetCapturedEtDays` — a REACH property.** "We hold the order rows for
 *     EVERY known production account on this day." It is what an *archive* claim
 *     stands on, and it folds by **intersection**: an account we did not capture is
 *     an account whose contracts are unanswerable, whatever the sibling read. The
 *     per-day `missingAccounts` names exactly who is missing.
 *
 * A day can be attested (the recorder was up) and NOT fleet-captured (we did not
 * archive v0nni's orders). Both statements are true at once and both are published.
 *
 * ### One account's read failing must never fold into the other's verdict (AC5)
 *
 * Each account gets its OWN capture line, with its own `read`/`error`/`attestation`.
 * A failed read for `v0nni` and a clean read for `admin` on the same day produce two
 * independent lines and two independent per-account rows — never one merged verdict
 * whose `read:true` came from whichever account happened to answer. The fleet row for
 * that day reads `fleetCaptured:false` and names `v0nni` in `missingAccounts`.
 */

import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { TradierAccountOrder, TradierOrderSubmitEvent } from '@trading-app/engine';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import { appendBoundedTapeLineSync } from './data-tape-bounds.js';

const log = logger.child({ module: 'tra3939-order-provenance-capture' });

export const ENGINE_SUBMIT_LOG_FILENAME = 'tra3939-engine-submitted-orders.jsonl';
export const BROKER_ORDER_CAPTURE_LOG_FILENAME = 'tra3939-broker-order-capture.jsonl';

/** Stated on both payloads so a reader never has to infer it from a file size. */
export const ORDER_PROVENANCE_RETENTION =
  'none — append-only, never compacted. Both stores hold evidence that expires at '
  + 'the source (the broker serves ONE trading day of orders), not measurements a '
  + 'later run can retake. See the module docblock.';

/**
 * ET calendar day of a ms-epoch instant. Duplicated from the resolver rather than
 * imported: this module is a LEAF (data-dir + observability only) so a durable
 * writer never sits inside the barrel cycle that fused 59 modules (TRA-1684).
 */
export function etDayOf(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/**
 * TRA-4009 — how a Tradier account number appears on a PUBLIC surface.
 *
 * `/api/health/order-provenance-capture` is unauthenticated by design and publishes
 * counts, coverage and gaps — never a token, a price, or an account number. But AC2
 * asks every census row to say which account it was read from, and "which account"
 * has to be legible to a reader who is looking at two books.
 *
 * So the two identities are split: `account` (the operator/book NAME — `admin`,
 * `v0nni`, already public via `crossBookEpisodes.books`) is the key a reader joins
 * on, and the raw `accountId` stays on disk where the evidence lives. What reaches
 * the wire is this mask, which is enough to tell two accounts apart and to match a
 * brokerage statement, and not enough to be an account number.
 */
export function maskAccountId(accountId: string | null | undefined): string | null {
  if (typeof accountId !== 'string') return null;
  const trimmed = accountId.trim();
  if (trimmed === '') return null;
  return trimmed.length <= 4 ? '***' : `***${trimmed.slice(-4)}`;
}

/**
 * The account key a capture line written BEFORE TRA-4009 belongs to.
 *
 * Those lines carry no `account` field because the writer only ever had one client.
 * Which client that was is not a guess — the pre-TRA-4009 `runBrokerOrderDayCapture`
 * built `buildTradierAccountClientForEnv(settings, 'production', resolveLiveBrokerOperator())`
 * and nothing else. But this module is a LEAF (data-dir + observability only) and must
 * not import the operator resolver, so the attribution is supplied BY THE CALLER, which
 * has it. A caller that does not supply one gets this sentinel rather than a guessed
 * `'admin'`: an unattributed line must not silently become somebody's evidence.
 */
export const UNATTRIBUTED_ACCOUNT = 'unattributed_pre_tra4009';

// ── half (1): the submit-time id ledger ──────────────────────────────────────

/** One acknowledged order, recorded at SUBMIT. */
export interface EngineSubmittedOrderLine {
  kind: 'engine_submit';
  orderId: number;
  ackStatus: string;
  env: string;
  accountId: string;
  orderClass: string | null;
  side: string | null;
  symbol: string | null;
  optionSymbol: string | null;
  quantity: number | null;
  limitPrice: number | null;
  submittedAt: number;
  etDay: string;
  /** Which book/operator the engine was acting for, when the caller set one. */
  book: string | null;
}

/**
 * One boot of the recorder. Written once per process, at arm time.
 *
 * This is what lets a reader tell "the ledger held no order that day" from "the
 * ledger did not exist yet". Without it the first day would be indistinguishable
 * from a quiet one, and a quiet day is the only day on which absence means
 * anything at all.
 */
export interface EngineSubmitArmLine {
  kind: 'recorder_armed';
  armedAt: number;
  etDay: string;
  /** Process boot instant — the attestation clause the capture reads back. */
  bootedAt: number;
  pid: number;
  commit: string | null;
}

type SubmitLine = EngineSubmittedOrderLine | EngineSubmitArmLine;

let dataDir: string | null = null;
let bootedAt: number | null = null;
/** TRA-4009 — who unstamped (pre-TRA-4009) capture lines belong to. Set at boot. */
let legacyAccount: string | null = null;
let submitAppendErrors = 0;
let lastSubmitAppendError: string | null = null;
let captureAppendErrors = 0;

/** Book attribution for the next submits, set by the engine seam that knows it. */
let currentBook: string | null = null;

export function setOrderProvenanceCaptureDataDir(dir: string | null): void {
  dataDir = dir;
}

/**
 * TRA-4009 — declare which account the UNSTAMPED capture lines on this disk belong to.
 *
 * Set once at boot from `resolveLiveBrokerOperator()`, which is provably the client
 * the pre-TRA-4009 writer used (it built no other). This is an ATTRIBUTION, supplied
 * by the layer that has the fact, not an inference made by this leaf module. Left
 * unset, unstamped lines read as {@link UNATTRIBUTED_ACCOUNT} — visible, joined to
 * nobody, and never silently folded into a real book's coverage.
 */
export function setOrderProvenanceLegacyAccount(account: string | null): void {
  legacyAccount = account && account.length > 0 ? account : null;
}

/** The account key a capture line answers to, legacy lines included. */
function accountOf(line: BrokerOrderCaptureLine): string {
  const stamped = line.account;
  if (typeof stamped === 'string' && stamped.length > 0) return stamped;
  return legacyAccount ?? UNATTRIBUTED_ACCOUNT;
}

export function engineSubmitLogPath(dir: string): string {
  return join(dir, ENGINE_SUBMIT_LOG_FILENAME);
}

export function brokerOrderCaptureLogPath(dir: string): string {
  return join(dir, BROKER_ORDER_CAPTURE_LOG_FILENAME);
}

/** Test seam — forget the dir, the boot and the error counters. */
export function __resetOrderProvenanceCaptureForTest(): void {
  dataDir = null;
  bootedAt = null;
  submitAppendErrors = 0;
  lastSubmitAppendError = null;
  captureAppendErrors = 0;
  currentBook = null;
  legacyAccount = null;
}

/**
 * Attribute subsequent submits to `book`. Best-effort context, never a gate: an
 * unattributed submit is still RECORDED (the id is the evidence; the book is
 * legibility), because a submit we declined to record for want of a label would
 * reproduce this ticket one layer down.
 *
 * ⚠ **Deliberately not wired to the engine seam yet, and the reason is not
 * tidiness.** A module-level "current book" is only correct while one book is
 * inside the submit path at a time, and `mirrorLiveOptionOpen` awaits the broker
 * mid-walk — two armed books can interleave there and the label would follow the
 * wrong one. A mislabelled book on a provenance record is worse than an honest
 * `null`, and the ORDER ID is the evidence this ticket is about; the book is
 * legibility. Wiring it correctly means threading the label through `postOrder`,
 * which is its own change. The seam exists so that change has somewhere to land.
 */
export function setOrderProvenanceBook(book: string | null): void {
  currentBook = book && book.length > 0 ? book : null;
}

function appendLine(path: string, line: unknown): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces it
  }
  try {
    appendBoundedTapeLineSync(path, JSON.stringify(line) + '\n');
    return true;
  } catch (err) {
    lastSubmitAppendError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/**
 * Arm the recorder for this process and stamp the boot instant.
 *
 * Idempotent per process. The arm line is written even when the box has never
 * submitted an order: a ledger whose first line only appears on the first trade
 * cannot distinguish "armed and quiet" from "never armed", and that distinction is
 * the entire safety property of half (2).
 */
export function armEngineSubmitRecorder(opts: { bootedAt: number; commit?: string | null }): void {
  bootedAt = opts.bootedAt;
  if (dataDir == null) return;
  const line: EngineSubmitArmLine = {
    kind: 'recorder_armed',
    armedAt: Date.now(),
    etDay: etDayOf(Date.now()),
    bootedAt: opts.bootedAt,
    pid: process.pid,
    commit: opts.commit ?? null,
  };
  if (!appendLine(engineSubmitLogPath(dataDir), line)) {
    submitAppendErrors += 1;
    log.warn('tra3939 submit-recorder arm line append failed', { reason: lastSubmitAppendError });
  }
}

/** This process's boot instant, or `null` when the recorder was never armed. */
export function engineSubmitRecorderBootedAt(): number | null {
  return bootedAt;
}

/**
 * Record ONE acknowledged order id at submit time.
 *
 * Called from the engine's `postOrder` observer, so it sees every id the broker
 * acknowledged — the fill, the four walk steps we cancel on the way there, and the
 * order that reaches a terminal `rejected` after the ack. Sandbox submits are
 * recorded too, with their `env` on the line: the provenance question is only ever
 * asked about production, and a reader that filters on `env` is strictly better off
 * than one whose ledger silently dropped a class of rows it might later need.
 *
 * Best-effort on IO and COUNTED. It must never throw: the caller has a LIVE order
 * working at the broker and an exception here would void a real position.
 */
export function recordEngineOrderSubmit(event: TradierOrderSubmitEvent): void {
  const line: EngineSubmittedOrderLine = {
    kind: 'engine_submit',
    orderId: event.orderId,
    ackStatus: event.ackStatus,
    env: event.env,
    accountId: event.accountId,
    orderClass: event.orderClass,
    side: event.side,
    symbol: event.symbol,
    optionSymbol: event.optionSymbol,
    quantity: event.quantity,
    limitPrice: event.limitPrice,
    submittedAt: event.submittedAt,
    etDay: etDayOf(event.submittedAt),
    book: currentBook,
  };
  if (dataDir == null) return;
  if (!appendLine(engineSubmitLogPath(dataDir), line)) {
    submitAppendErrors += 1;
    log.warn('tra3939 engine submit append failed', {
      orderId: event.orderId,
      reason: lastSubmitAppendError,
    });
  }
}

/** Every line on disk. Corrupt lines are COUNTED, never dropped into a clean answer. */
function readSubmitLines(): { lines: SubmitLine[]; corrupt: number } {
  if (dataDir == null) return { lines: [], corrupt: 0 };
  let raw: string;
  try {
    raw = readFileSync(engineSubmitLogPath(dataDir), 'utf8');
  } catch {
    return { lines: [], corrupt: 0 };
  }
  const lines: SubmitLine[] = [];
  let corrupt = 0;
  for (const text of raw.split('\n')) {
    if (text.trim() === '') continue;
    try {
      const parsed = JSON.parse(text) as SubmitLine;
      if (parsed && (parsed.kind === 'engine_submit' || parsed.kind === 'recorder_armed')) {
        lines.push(parsed);
      } else corrupt += 1;
    } catch {
      corrupt += 1;
    }
  }
  return { lines, corrupt };
}

/**
 * The submit-time witness: the ids, AND the ET days it is entitled to speak about.
 *
 * `coveredEtDays` is the load-bearing field, not `ids`. See the module docblock —
 * a non-empty id set with an over-broad coverage claim is how this instrument turns
 * into a false accusation.
 */
export interface EngineSubmitWitnessSummary {
  dataDir: string | null;
  ephemeral: boolean;
  retention: string;
  /** Has the recorder ever been armed on this disk? `false` ⇒ no witness at all. */
  armed: boolean;
  /** First ET day any line was written. Nothing before it can ever be covered. */
  firstEtDay: string | null;
  lastEtDay: string | null;
  /** Distinct order ids recorded, all envs. */
  orderIds: number;
  /** …of those, the PRODUCTION ones — the only ones a real-money question joins on. */
  productionOrderIds: number;
  lines: number;
  corruptLines: number;
  armLines: number;
  appendErrors: number;
  lastAppendError: string | null;
  /** ET days attested by a full-session capture. THE authority for a `desk_placed`. */
  coveredEtDays: string[];
  /** Days captured but NOT attestable (late boot / failed capture), named not hidden. */
  uncoveredCapturedEtDays: string[];
}

/**
 * Production order ids we can prove we submitted. The set handed to the resolver.
 *
 * Production only, deliberately: a sandbox id colliding with a production id would
 * manufacture an `engine_placed` on a contract this account never touched, and
 * Tradier's two environments mint ids from separate spaces with no guarantee of
 * disjointness.
 */
export function engineSubmittedProductionOrderIds(): Set<number> {
  const ids = new Set<number>();
  for (const l of readSubmitLines().lines) {
    if (l.kind !== 'engine_submit') continue;
    if (l.env !== 'production') continue;
    if (typeof l.orderId === 'number' && Number.isFinite(l.orderId)) ids.add(l.orderId);
  }
  return ids;
}

export function summarizeEngineSubmitWitness(): EngineSubmitWitnessSummary {
  const { lines, corrupt } = readSubmitLines();
  const ids = new Set<number>();
  const prodIds = new Set<number>();
  let armLines = 0;
  let firstEtDay: string | null = null;
  let lastEtDay: string | null = null;
  for (const l of lines) {
    if (firstEtDay === null || l.etDay < firstEtDay) firstEtDay = l.etDay;
    if (lastEtDay === null || l.etDay > lastEtDay) lastEtDay = l.etDay;
    if (l.kind === 'recorder_armed') {
      armLines += 1;
      continue;
    }
    ids.add(l.orderId);
    if (l.env === 'production') prodIds.add(l.orderId);
  }
  const captures = summarizeBrokerOrderCaptures();
  return {
    dataDir,
    ephemeral: isEphemeralDataDir(dataDir),
    retention: ORDER_PROVENANCE_RETENTION,
    armed: armLines > 0,
    firstEtDay,
    lastEtDay,
    orderIds: ids.size,
    productionOrderIds: prodIds.size,
    lines: lines.length,
    corruptLines: corrupt,
    armLines,
    appendErrors: submitAppendErrors,
    lastAppendError: lastSubmitAppendError,
    coveredEtDays: captures.attestedEtDays,
    uncoveredCapturedEtDays: captures.unattestedEtDays,
  };
}

// ── half (2): the daily broker order capture ─────────────────────────────────

/**
 * One ET day's capture attempt. A FAILED attempt writes a line too: "we asked the
 * broker on this day and could not read" is evidence, and its absence would be
 * indistinguishable from a day nobody asked about.
 */
export interface BrokerOrderCaptureLine {
  kind: 'broker_order_capture';
  /** The ET day the capture is ABOUT (and, being same-day by construction, ran on). */
  etDay: string;
  capturedAt: number;
  /** Did the fetch complete? `false` ⇒ `orders` is empty because we could not look. */
  read: boolean;
  error: string | null;
  /** Every row the broker served, verbatim-normalised. THE evidence. */
  orders: TradierAccountOrder[];
  /** The list's OWN reach, from its rows' `create_date` — recorded, never assumed. */
  etDaysCovered: string[];
  oldestCreateDate: string | null;
  newestCreateDate: string | null;
  /**
   * `full`   — this process booted before the session opened, so the submit
   *            recorder was resident for every instant an order could be placed.
   * `partial`— it booted mid-session (or later); the orders are captured, but the
   *            submit ledger cannot speak for this day.
   * `blind`  — the capture itself failed.
   */
  attestation: 'full' | 'partial' | 'blind';
  /** Process boot instant behind the attestation. Published so it can be re-derived. */
  recorderBootedAt: number | null;
  /** Submit-ledger lines on disk at capture time — the co-witness, not a guess. */
  submitLedgerLines: number;
  accountEnv: string;
  /**
   * TRA-4009 — the operator/book this day was read AS. `listOrders()` is per
   * account, so without this the line is a claim about SOME account, and the
   * reader cannot tell which. Absent on lines written before TRA-4009; readers
   * resolve those through {@link UNATTRIBUTED_ACCOUNT} or the caller's
   * `legacyAccount`.
   */
  account?: string;
  /** TRA-4009 — the Tradier account number the rows came from. Masked on the wire. */
  accountId?: string | null;
}

/**
 * The ET instant the regular session opens, as ms since ET midnight. 09:30 ET.
 * A boot at or before this is resident for the whole order window.
 */
const SESSION_OPEN_ET_MINUTES = 9 * 60 + 30;

/** Minutes past ET midnight for a ms instant. */
export function etMinutesOfDay(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? NaN);
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? NaN);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return NaN;
  return hour * 60 + minute;
}

/**
 * Did a process that booted at `bootMs` cover the whole of `etDay`'s order window?
 *
 * PURE and exported so the attestation rule is testable in isolation rather than
 * only through a live capture. Fails CLOSED on an unknown boot (`null`) and on an
 * unparseable clock — an attestation we cannot compute must never read as one we
 * computed and passed.
 */
export function bootCoversSession(bootMs: number | null, etDay: string): boolean {
  if (bootMs === null || !Number.isFinite(bootMs)) return false;
  const bootDay = etDayOf(bootMs);
  if (bootDay < etDay) return true;
  if (bootDay > etDay) return false;
  const minutes = etMinutesOfDay(bootMs);
  if (!Number.isFinite(minutes)) return false;
  return minutes <= SESSION_OPEN_ET_MINUTES;
}

export interface CaptureBrokerOrderDayInput {
  etDay: string;
  /** The broker's rows, or `null` when the fetch did not complete. */
  orders: readonly TradierAccountOrder[] | null;
  error?: string | null;
  capturedAt: number;
  accountEnv: string;
  /**
   * TRA-4009 — the operator/book whose client served (or failed to serve) these
   * rows. REQUIRED: `listOrders()` is per account, so an unlabelled capture is a
   * claim about an account the reader cannot name — which is the whole defect.
   */
  account: string;
  /** The Tradier account number behind the read, when the caller resolved one. */
  accountId?: string | null;
}

export interface CaptureBrokerOrderDayResult {
  written: boolean;
  /** Why nothing was written: a successful capture for this day already exists. */
  skippedAlreadyCaptured: boolean;
  appendError: string | null;
  line: BrokerOrderCaptureLine | null;
}

/**
 * Capture ONE ET day's broker order list, FOR ONE ACCOUNT.
 *
 * Idempotent on SUCCESS only, and the idempotence key is `(etDay, account)` — not
 * `etDay` (TRA-4009). Keying on the day alone is exactly how the second book went
 * un-archived for a fortnight: the admin capture landed first, the day then read as
 * "already captured", and v0nni's read was skipped without ever being attempted.
 * A day holding only BLIND lines for this account is retried — the whole point of
 * the retry window is that a failed read at 16:00 ET can still succeed at 17:00 ET,
 * while the broker's one-day window is open.
 *
 * Never throws: the caller is a scheduler tick shared with unrelated work.
 */
export function captureBrokerOrderDay(input: CaptureBrokerOrderDayInput): CaptureBrokerOrderDayResult {
  const read = input.orders !== null;
  const rows = [...(input.orders ?? [])];
  const days = new Set<string>();
  let oldest: { iso: string; ms: number } | null = null;
  let newest: { iso: string; ms: number } | null = null;
  for (const o of rows) {
    const ms = o.createDate === null ? NaN : Date.parse(o.createDate);
    if (!Number.isFinite(ms)) continue;
    const iso = o.createDate as string;
    if (oldest === null || ms < oldest.ms) oldest = { iso, ms };
    if (newest === null || ms > newest.ms) newest = { iso, ms };
    days.add(etDayOf(ms));
  }
  const line: BrokerOrderCaptureLine = {
    kind: 'broker_order_capture',
    etDay: input.etDay,
    capturedAt: input.capturedAt,
    read,
    error: input.error ?? null,
    orders: rows,
    etDaysCovered: [...days].sort(),
    oldestCreateDate: oldest?.iso ?? null,
    newestCreateDate: newest?.iso ?? null,
    attestation: !read ? 'blind' : bootCoversSession(bootedAt, input.etDay) ? 'full' : 'partial',
    recorderBootedAt: bootedAt,
    submitLedgerLines: readSubmitLines().lines.length,
    accountEnv: input.accountEnv,
    account: input.account,
    accountId: input.accountId ?? null,
  };
  if (dataDir == null) {
    return { written: false, skippedAlreadyCaptured: false, appendError: null, line };
  }
  // TRA-4009 — `(etDay, account)`, never `etDay`. See the docblock: the day-only
  // key made the first account to answer suppress every sibling read.
  //
  // ⚠ And only a SEALED (post-16:00 ET) read closes the key. A forced mid-session
  // capture is a real read of a PREFIX of the day; letting it satisfy idempotence
  // would refuse the post-close line and lose every order placed after it, on a
  // broker window that never reopens. The pre-close line is kept — it is evidence,
  // and superseding it is the reader's job (`foldCaptureGroup` takes the last
  // successful read) — but it does not end the day. Two sealed reads still collapse
  // to one, so the hourly scheduler is unchanged.
  const already = readBrokerOrderCaptures().some(
    l => l.etDay === input.etDay && accountOf(l) === input.account && isSealedCapture(l),
  );
  if (already) {
    return { written: false, skippedAlreadyCaptured: true, appendError: null, line: null };
  }
  if (!appendLine(brokerOrderCaptureLogPath(dataDir), line)) {
    captureAppendErrors += 1;
    log.warn('tra3939 broker order capture append failed', {
      etDay: input.etDay,
      account: input.account,
      reason: lastSubmitAppendError,
    });
    return { written: false, skippedAlreadyCaptured: false, appendError: lastSubmitAppendError, line };
  }
  return { written: true, skippedAlreadyCaptured: false, appendError: null, line };
}

/** Every capture line on disk, oldest-appended first. */
export function readBrokerOrderCaptures(): BrokerOrderCaptureLine[] {
  if (dataDir == null) return [];
  let raw: string;
  try {
    raw = readFileSync(brokerOrderCaptureLogPath(dataDir), 'utf8');
  } catch {
    return [];
  }
  const out: BrokerOrderCaptureLine[] = [];
  for (const text of raw.split('\n')) {
    if (text.trim() === '') continue;
    try {
      const parsed = JSON.parse(text) as BrokerOrderCaptureLine;
      if (parsed && parsed.kind === 'broker_order_capture') out.push(parsed);
    } catch {
      // counted by the summary's corrupt tally
    }
  }
  return out;
}

export interface BrokerOrderCaptureDayRow {
  etDay: string;
  captured: boolean;
  attempts: number;
  orders: number;
  optionOrders: number;
  attestation: 'full' | 'partial' | 'blind';
  lastError: string | null;
  capturedAt: number | null;
  /**
   * TRA-4009 — accounts with a successful capture for this day, and the known
   * production accounts WITHOUT one. `captured` above is the OR across accounts
   * (some book's orders are archived); `fleetCaptured` is the AND (every known
   * book's are). A day captured for `admin` and missing `v0nni` reads
   * `captured:true, fleetCaptured:false, missingAccounts:['v0nni']` — never as a
   * clean day.
   */
  capturedAccounts: string[];
  missingAccounts: string[];
  fleetCaptured: boolean;
  /**
   * This account's (or, on a fleet row, ANY account's) only successful reads for
   * the day landed before the 16:00 ET close, so the archive holds a PREFIX of the
   * day rather than the day. On a per-account row this is that account's own
   * verdict; on a fleet row see {@link provisionalAccounts}.
   */
  provisional: boolean;
  /** Fleet row only — the captured accounts whose read is a pre-close prefix. */
  provisionalAccounts: string[];
  /**
   * Every known production account captured, and every one of those captures taken
   * after the close. This — NOT `fleetCaptured` — is the predicate a caller must
   * use to decide a day needs no further read: `fleetCaptured` is satisfied by a
   * mid-session prefix, and treating that as done seals the day against the
   * post-close capture that would have held the rest of it.
   */
  fleetSealed: boolean;
}

/** TRA-4009 — one production book's own coverage picture, folded by nobody. */
export interface BrokerOrderCaptureAccountSummary {
  account: string;
  /** Masked; the raw number stays on disk. `null` until a line records one. */
  accountIdMasked: string | null;
  lines: number;
  days: BrokerOrderCaptureDayRow[];
  capturedEtDays: string[];
  /** Captured days whose only successful read landed before the 16:00 ET close. */
  provisionalEtDays: string[];
  attestedEtDays: string[];
  unattestedEtDays: string[];
  /** Weekday gaps inside THIS account's own first..last capture span. */
  gapEtDays: string[];
  /**
   * Days some OTHER account captured that this one did not — including days
   * before this account was ever read. This is the field AC1 is about: without
   * it, an account that started being captured on day 14 reads as gap-free.
   */
  missingEtDays: string[];
  firstEtDay: string | null;
  lastEtDay: string | null;
}

export interface BrokerOrderCaptureSummary {
  dataDir: string | null;
  ephemeral: boolean;
  retention: string;
  lines: number;
  days: BrokerOrderCaptureDayRow[];
  /**
   * Days the SUBMIT RECORDER is attested for — a PROCESS property, folded by
   * UNION across accounts. One account's full-session capture already proves the
   * recorder was resident and armed for that whole day, and the submit ledger it
   * licenses is fleet-wide. This is the authority a `desk_placed` stands on.
   *
   * ⚠ It is NOT an archive-reach claim. See {@link fleetCapturedEtDays}.
   */
  attestedEtDays: string[];
  /** Days captured but not attestable. Named, so `full` is never inferred. */
  unattestedEtDays: string[];
  /**
   * TRA-4009 — days on which EVERY known production account was captured. A REACH
   * property, folded by INTERSECTION. This is the only field that entitles a reader
   * to say "we hold the fleet's orders for that day".
   */
  fleetCapturedEtDays: string[];
  /**
   * Days every known production account was captured AND every one of those reads
   * was taken after the 16:00 ET close. The subset of {@link fleetCapturedEtDays}
   * that is a claim about whole days. A day here and not there was archived from a
   * mid-session prefix — see `days[].provisionalAccounts`.
   */
  fleetSealedEtDays: string[];
  /** TRA-4009 — per book. `accounts.length > 1` is the property this ticket added. */
  accounts: BrokerOrderCaptureAccountSummary[];
  /** The account set the intersection was taken over, published so it is auditable. */
  knownAccounts: string[];
  /**
   * ET weekdays between the first capture and the newest one with NO line at all.
   *
   * A MISSED DAY MUST READ AS A NAMED GAP, NEVER AS AN EMPTY DAY (AC2). This is
   * the field that makes that true. Weekdays are used rather than a market
   * calendar: this module is a leaf and must not import one, and over-reporting a
   * holiday as a gap is the safe direction — a gap that is not real costs a glance,
   * a real gap read as clean costs a contract.
   */
  gapEtDays: string[];
  /**
   * TRA-4009 — `(etDay, account)` pairs a known account is missing on a day some
   * sibling captured. The per-account gap, made countable at the fleet level; a
   * fleet `gapEtDays` of `[]` says nothing about these.
   */
  accountGapEtDays: Array<{ account: string; etDays: string[] }>;
}

export interface SummarizeBrokerOrderCapturesOptions {
  /**
   * Production accounts that OUGHT to be captured — the roster the intersection
   * and `missingAccounts` are taken over. Supplied by the caller because this leaf
   * cannot resolve settings. Accounts that appear on disk are unioned in, so a
   * caller that passes nothing still gets an honest per-account picture; what it
   * loses is the ability to name an account that has NEVER been captured, which is
   * exactly the v0nni case and exactly why the route passes the live roster.
   */
  knownAccounts?: readonly string[];
}

/** Every ET weekday in `[from, to]` inclusive. Bounded by construction. */
function etWeekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let ms = Date.parse(`${from}T17:00:00.000Z`); // ~noon ET, safely inside the day
  const end = Date.parse(`${to}T17:00:00.000Z`);
  if (!Number.isFinite(ms) || !Number.isFinite(end)) return out;
  let guard = 0;
  while (ms <= end && guard < 4000) {
    guard += 1;
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) out.push(etDayOf(ms));
    ms += 86_400_000;
  }
  return out;
}

/**
 * The ET instant the regular session closes, as ms since ET midnight. 16:00 ET.
 * A successful read taken at or after this covers the whole of the day's order
 * window; one taken before it covers only as much of the day as had happened.
 */
export const SESSION_CLOSE_ET_MINUTES = 16 * 60;

/**
 * Was this line's read taken after the session closed — i.e. is it a claim about
 * the WHOLE day rather than a prefix of it?
 *
 * Derived from the line's own `capturedAt`, so it is true of every line already on
 * disk; no new field and no backfill. A line that did not read is never sealed —
 * a blind is not a complete claim about anything.
 */
function isSealedCapture(line: BrokerOrderCaptureLine): boolean {
  if (!line.read) return false;
  const minutes = etMinutesOfDay(line.capturedAt);
  return Number.isFinite(minutes) && minutes >= SESSION_CLOSE_ET_MINUTES;
}

/**
 * Fold ONE group of capture lines (all same day, and — for the per-account rows —
 * all same account) into a day row's measurable part.
 *
 * The successful line is the authority; a later blind retry cannot un-capture a day.
 *
 * ⚠ Among SUCCESSFUL lines the authority is the LAST, not the first. The broker's
 * order list for a day only accumulates, so a later read is a strict superset of an
 * earlier one; taking the first would report a mid-session prefix forever and hide
 * every order placed after it. Attestation is exempt and folds by UNION — it is a
 * claim about the RECORDER's residency, which one full-session line already proves
 * and a later capture taken after a restart cannot retract.
 */
function foldCaptureGroup(group: readonly BrokerOrderCaptureLine[]): {
  captured: boolean;
  attempts: number;
  orders: number;
  optionOrders: number;
  attestation: 'full' | 'partial' | 'blind';
  lastError: string | null;
  capturedAt: number | null;
  provisional: boolean;
} {
  const reads = group.filter(l => l.read);
  const good = reads.length > 0 ? reads[reads.length - 1]! : null;
  const chosen = good ?? group[group.length - 1]!;
  return {
    captured: good !== null,
    attempts: group.length,
    orders: chosen.orders.length,
    optionOrders: chosen.orders.filter(o => typeof o.optionSymbol === 'string' && o.optionSymbol !== '').length,
    attestation: reads.some(l => l.attestation === 'full') ? 'full' : chosen.attestation,
    lastError: group[group.length - 1]!.error,
    capturedAt: good?.capturedAt ?? null,
    // Captured, but every successful read landed BEFORE the close ⇒ the day is
    // archived only up to that instant. Not a gap and not a clean day: a third thing.
    provisional: good !== null && !group.some(isSealedCapture),
  };
}

export function summarizeBrokerOrderCaptures(
  opts: SummarizeBrokerOrderCapturesOptions = {},
): BrokerOrderCaptureSummary {
  const lines = readBrokerOrderCaptures();
  const byDay = new Map<string, BrokerOrderCaptureLine[]>();
  const byAccount = new Map<string, BrokerOrderCaptureLine[]>();
  const byDayAccount = new Map<string, BrokerOrderCaptureLine[]>();
  const push = (m: Map<string, BrokerOrderCaptureLine[]>, k: string, l: BrokerOrderCaptureLine): void => {
    const g = m.get(k);
    if (g) g.push(l);
    else m.set(k, [l]);
  };
  for (const l of lines) {
    const acct = accountOf(l);
    push(byDay, l.etDay, l);
    push(byAccount, acct, l);
    push(byDayAccount, `${l.etDay} ${acct}`, l);
  }

  // The roster the intersection is taken over: what the caller says OUGHT to be
  // captured, unioned with everything actually on disk. An account that appears on
  // disk but not in the roster (a book whose creds were removed) must not silently
  // vanish from its own history, and an account in the roster that was never
  // captured must not be invisible — which is the v0nni case.
  const knownAccounts = [...new Set([...(opts.knownAccounts ?? []), ...byAccount.keys()])].sort();

  const days: BrokerOrderCaptureDayRow[] = [];
  const attested: string[] = [];
  const unattested: string[] = [];
  const fleetCaptured: string[] = [];
  const fleetSealed: string[] = [];
  for (const [etDay, group] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const fold = foldCaptureGroup(group);
    const capturedAccounts = [
      ...new Set(group.filter(l => l.read).map(accountOf)),
    ].sort();
    const missingAccounts = knownAccounts.filter(a => !capturedAccounts.includes(a));
    // Per account, because sealing is per read: admin may have captured post-close
    // while v0nni holds only a forced mid-session prefix, and one folded flag would
    // report whichever answered last.
    const provisionalAccounts = capturedAccounts.filter(
      a => !group.some(l => accountOf(l) === a && isSealedCapture(l)),
    );
    const fleetCapturedDay = capturedAccounts.length > 0 && missingAccounts.length === 0;
    days.push({
      etDay,
      ...fold,
      capturedAccounts,
      missingAccounts,
      fleetCaptured: fleetCapturedDay,
      provisionalAccounts,
      fleetSealed: fleetCapturedDay && provisionalAccounts.length === 0,
    });
    if (fleetCapturedDay && provisionalAccounts.length === 0) fleetSealed.push(etDay);
    // ATTESTATION FOLDS BY UNION — it is a claim about the RECORDER's residency,
    // and any account's full-session capture proves it. See the module docblock.
    if (group.some(l => l.read && l.attestation === 'full')) attested.push(etDay);
    else unattested.push(etDay);
    // REACH FOLDS BY INTERSECTION — an account we did not archive is an account
    // whose contracts are unanswerable, whatever its sibling read.
    if (capturedAccounts.length > 0 && missingAccounts.length === 0) fleetCaptured.push(etDay);
  }

  const knownDays = days.map(d => d.etDay);
  const gapEtDays =
    knownDays.length === 0
      ? []
      : etWeekdaysBetween(knownDays[0]!, knownDays[knownDays.length - 1]!).filter(d => !byDay.has(d));

  const anyCapturedDay = new Set(days.filter(d => d.captured).map(d => d.etDay));
  const accounts: BrokerOrderCaptureAccountSummary[] = knownAccounts.map(account => {
    const own = byAccount.get(account) ?? [];
    const ownDayKeys = [...new Set(own.map(l => l.etDay))].sort();
    const ownDays: BrokerOrderCaptureDayRow[] = ownDayKeys.map(etDay => {
      const group = byDayAccount.get(`${etDay} ${account}`)!;
      const fold = foldCaptureGroup(group);
      return {
        etDay,
        ...fold,
        capturedAccounts: fold.captured ? [account] : [],
        missingAccounts: fold.captured ? [] : [account],
        fleetCaptured: false, // meaningless on a single-account row; the fleet row owns it
        provisionalAccounts: fold.provisional ? [account] : [],
        fleetSealed: false, // likewise — a book cannot speak for the fleet
      };
    });
    const capturedEtDays = ownDays.filter(d => d.captured).map(d => d.etDay);
    const capturedSet = new Set(capturedEtDays);
    return {
      account,
      accountIdMasked:
        maskAccountId([...own].reverse().find(l => typeof l.accountId === 'string' && l.accountId !== '')?.accountId ?? null),
      lines: own.length,
      days: ownDays,
      capturedEtDays,
      /** This book's captured days whose read is only a pre-close prefix. */
      provisionalEtDays: ownDays.filter(d => d.provisional).map(d => d.etDay),
      attestedEtDays: ownDays.filter(d => d.captured && d.attestation === 'full').map(d => d.etDay),
      unattestedEtDays: ownDays.filter(d => !d.captured || d.attestation !== 'full').map(d => d.etDay),
      gapEtDays:
        ownDayKeys.length === 0
          ? []
          : etWeekdaysBetween(ownDayKeys[0]!, ownDayKeys[ownDayKeys.length - 1]!).filter(d => !capturedSet.has(d)),
      // Every day SOMEBODY captured that this account did not. Spans days before
      // this account's own first line, which its `gapEtDays` cannot reach.
      missingEtDays: [...anyCapturedDay].filter(d => !capturedSet.has(d)).sort(),
      firstEtDay: ownDayKeys[0] ?? null,
      lastEtDay: ownDayKeys[ownDayKeys.length - 1] ?? null,
    };
  });

  return {
    dataDir,
    ephemeral: isEphemeralDataDir(dataDir),
    retention: ORDER_PROVENANCE_RETENTION,
    lines: lines.length,
    days,
    attestedEtDays: attested,
    unattestedEtDays: unattested,
    fleetCapturedEtDays: fleetCaptured,
    fleetSealedEtDays: fleetSealed,
    accounts,
    knownAccounts,
    gapEtDays,
    accountGapEtDays: accounts
      .filter(a => a.missingEtDays.length > 0)
      .map(a => ({ account: a.account, etDays: a.missingEtDays })),
  };
}

/** TRA-4009 — one archived order row, WITH the account it was read from (AC2). */
export interface CapturedBrokerOrderRow {
  order: TradierAccountOrder;
  /** The operator/book whose client served this row. */
  account: string;
  /** Masked account number, safe for the public surface. */
  accountIdMasked: string | null;
  /** The ET day of the CAPTURE the row came out of (not the order's create_date). */
  captureEtDay: string;
}

/**
 * Every order row we have ever captured, per `(etDay, account)`.
 *
 * This is what turns the broker's one-day window into a growing archive: the
 * resolver joins against THIS, not against a live fetch, so a contract opened on a
 * day we captured stays answerable forever.
 *
 * ⚠ TRA-4009 — the de-dup key is `(etDay, account)`. Keying on `etDay` alone (the
 * pre-TRA-4009 shape) discarded the sibling account's whole archive for every day
 * both were captured, which is the same one-account blindness one layer down.
 */
export function capturedBrokerOrderRows(): CapturedBrokerOrderRow[] {
  // Successful lines for one (day, account) are UNIONED on broker order id, with a
  // LATER read winning the row. Taking only the first — which is what this did —
  // published a forced mid-session capture's PREFIX and dropped every order placed
  // after it, even though the post-close line holding them was right there on disk.
  // Union rather than last-line-wins so a short read (broker paging, a partial page)
  // can only ever ADD reach; last-write-wins on the id so a row's status and fill
  // price are the freshest the archive holds, not the 11:00 ET `open` snapshot.
  const byKey = new Map<string, Map<number, CapturedBrokerOrderRow>>();
  const order: string[] = [];
  for (const l of readBrokerOrderCaptures()) {
    if (!l.read) continue;
    const account = accountOf(l);
    const key = `${l.etDay} ${account}`;
    let rows = byKey.get(key);
    if (rows === undefined) {
      rows = new Map();
      byKey.set(key, rows);
      order.push(key);
    }
    const accountIdMasked = maskAccountId(l.accountId ?? null);
    for (const o of l.orders) rows.set(o.id, { order: o, account, accountIdMasked, captureEtDay: l.etDay });
  }
  const out: CapturedBrokerOrderRow[] = [];
  for (const key of order) for (const row of byKey.get(key)!.values()) out.push(row);
  return out;
}

/**
 * The archive as a flat order list, de-duplicated on broker order id.
 *
 * Tradier order ids are broker-GLOBAL, so unioning the per-account archives cannot
 * collide two different orders onto one id — which is why AC2 leaves the resolver's
 * id join exactly as it was and only widens what feeds it.
 */
export function capturedBrokerOrders(): TradierAccountOrder[] {
  const byId = new Map<number, TradierAccountOrder>();
  for (const r of capturedBrokerOrderRows()) byId.set(r.order.id, r.order);
  return [...byId.values()];
}

export function orderProvenanceCaptureAppendErrors(): { submit: number; capture: number } {
  return { submit: submitAppendErrors, capture: captureAppendErrors };
}

// ── the per-order census: the join, exercised on EVERY captured order ────────

/**
 * Who issued ONE captured order. Same three names the resolver uses for a
 * subject contract, so a reader maps them without a legend:
 *   `engine_placed`           — the id is in our submit ledger (or our fill ledger)
 *   `desk_placed`             — absent from both, on a day the ledger is ATTESTED for
 *   `blind_no_issuer_witness` — absent from both, on a day it is not (or undated)
 */
export type CapturedOrderIssuer = 'engine_placed' | 'desk_placed' | 'blind_no_issuer_witness';

export interface CapturedOrderCensusRow {
  id: number;
  etDay: string | null;
  createDate: string | null;
  optionSymbol: string;
  side: string | null;
  status: string;
  quantity: number | null;
  execQuantity: number | null;
  issuer: CapturedOrderIssuer;
  /** The evidence the issuer verdict stands on. */
  witness: 'submit_ledger' | 'fill_ledger' | 'attested_absence' | 'unattested_day' | 'undated';
  /** TRA-4009 AC2 — the account this row was READ FROM. Never inferred. */
  account: string;
  accountIdMasked: string | null;
}

export interface CapturedOrderCensusDay {
  etDay: string;
  attested: boolean;
  orders: number;
  engine_placed: number;
  desk_placed: number;
  blind_no_issuer_witness: number;
}

/** TRA-4009 — the same rollup, per production book. */
export interface CapturedOrderCensusAccount {
  account: string;
  accountIdMasked: string | null;
  orders: number;
  engine_placed: number;
  desk_placed: number;
  blind_no_issuer_witness: number;
  terminalOrders: number;
}

export interface CapturedOrderCensus {
  /** Option orders only — the submit ledger hooks the OPTIONS client, so an equity order's absence from it is not evidence. */
  orders: CapturedOrderCensusRow[];
  skippedNonOption: number;
  byIssuer: Record<CapturedOrderIssuer, number>;
  byDay: CapturedOrderCensusDay[];
  /** TRA-4009 AC2 — the census split by the account each row was read from. */
  byAccount: CapturedOrderCensusAccount[];
  /**
   * TRA-4009 — order ids served by MORE THAN ONE account's archive. Tradier ids are
   * broker-global, so this should be zero; a non-zero value means two books read the
   * same account (a cred mix-up) and the per-account split is not what it claims.
   * Counted rather than assumed away — an invariant nobody measures is a hope.
   */
  idsSeenOnMultipleAccounts: number;
  /** engine_placed + desk_placed — the count of terminal verdicts reached on real rows. */
  terminalOrders: number;
}

export interface CapturedOrderCensusInput {
  /**
   * TRA-4009 — account-stamped archive rows. Was a bare `TradierAccountOrder[]`,
   * which structurally could not answer AC2's "which account was this read from".
   */
  orders: readonly CapturedBrokerOrderRow[];
  /** Production ids the submit ledger holds. */
  submittedIds: ReadonlySet<number>;
  /** Ids our fill ledger holds, when the caller has them. A positive witness on any day. */
  filledIds?: ReadonlySet<number> | null;
  /** ET days the submit ledger is attested for — the ONLY days absence means "desk". */
  attestedEtDays: ReadonlySet<string>;
}

/**
 * TRA-3939 AC4 — run the resolver's issuer join (steps 4/6/7/8) over EVERY
 * captured option order, not only over over-sold subjects.
 *
 * The resolver can only reach a terminal verdict on a subject the over-sell
 * detector names, and every subject so far opened before the archive existed.
 * A resolver whose terminal branches have never fired on real bytes is the same
 * instrument as one that cannot reach them (TRA-3926 C8) — so the same join is
 * exercised here on the population that IS in reach: every order we captured.
 * PURE; the route feeds it the durable stores.
 *
 * Step 7 is preserved exactly: absence on an unattested day is a blind, never a
 * `desk_placed`. This census is a READER's instrument — nothing spends on it.
 */
export function censusCapturedOrders(input: CapturedOrderCensusInput): CapturedOrderCensus {
  const rows: CapturedOrderCensusRow[] = [];
  const seen = new Map<number, string>();
  let skippedNonOption = 0;
  let idsSeenOnMultipleAccounts = 0;
  for (const src of input.orders) {
    const o = src.order;
    if (typeof o.id !== 'number' || !Number.isFinite(o.id)) continue;
    const firstAccount = seen.get(o.id);
    if (firstAccount !== undefined) {
      // Broker-global ids: the same id under two accounts means two books resolved
      // the same brokerage account. Count it, keep the first, never merge silently.
      if (firstAccount !== src.account) idsSeenOnMultipleAccounts += 1;
      continue;
    }
    seen.set(o.id, src.account);
    if (typeof o.optionSymbol !== 'string' || o.optionSymbol === '') {
      skippedNonOption += 1;
      continue;
    }
    const ms = o.createDate === null ? NaN : Date.parse(o.createDate);
    const etDay = Number.isFinite(ms) ? etDayOf(ms) : null;
    let issuer: CapturedOrderIssuer;
    let witness: CapturedOrderCensusRow['witness'];
    if (input.submittedIds.has(o.id)) {
      issuer = 'engine_placed';
      witness = 'submit_ledger';
    } else if (input.filledIds?.has(o.id)) {
      issuer = 'engine_placed';
      witness = 'fill_ledger';
    } else if (etDay === null) {
      issuer = 'blind_no_issuer_witness';
      witness = 'undated';
    } else if (input.attestedEtDays.has(etDay)) {
      issuer = 'desk_placed';
      witness = 'attested_absence';
    } else {
      issuer = 'blind_no_issuer_witness';
      witness = 'unattested_day';
    }
    rows.push({
      id: o.id,
      etDay,
      createDate: o.createDate,
      optionSymbol: o.optionSymbol,
      side: o.side,
      status: o.status,
      quantity: o.quantity,
      execQuantity: o.execQuantity,
      issuer,
      witness,
      account: src.account,
      accountIdMasked: src.accountIdMasked,
    });
  }
  rows.sort((a, b) => (a.createDate ?? '').localeCompare(b.createDate ?? '') || a.id - b.id);
  const byIssuer: Record<CapturedOrderIssuer, number> = {
    engine_placed: 0,
    desk_placed: 0,
    blind_no_issuer_witness: 0,
  };
  const dayMap = new Map<string, CapturedOrderCensusDay>();
  const acctMap = new Map<string, CapturedOrderCensusAccount>();
  for (const r of rows) {
    byIssuer[r.issuer] += 1;
    let a = acctMap.get(r.account);
    if (!a) {
      a = {
        account: r.account,
        accountIdMasked: r.accountIdMasked,
        orders: 0,
        engine_placed: 0,
        desk_placed: 0,
        blind_no_issuer_witness: 0,
        terminalOrders: 0,
      };
      acctMap.set(r.account, a);
    }
    a.orders += 1;
    a[r.issuer] += 1;
    if (r.issuer !== 'blind_no_issuer_witness') a.terminalOrders += 1;
    const key = r.etDay ?? 'undated';
    let d = dayMap.get(key);
    if (!d) {
      d = {
        etDay: key,
        attested: r.etDay !== null && input.attestedEtDays.has(r.etDay),
        orders: 0,
        engine_placed: 0,
        desk_placed: 0,
        blind_no_issuer_witness: 0,
      };
      dayMap.set(key, d);
    }
    d.orders += 1;
    d[r.issuer] += 1;
  }
  const byDay = [...dayMap.values()].sort((a, b) => a.etDay.localeCompare(b.etDay));
  return {
    orders: rows,
    skippedNonOption,
    byIssuer,
    byDay,
    byAccount: [...acctMap.values()].sort((a, b) => a.account.localeCompare(b.account)),
    idsSeenOnMultipleAccounts,
    terminalOrders: byIssuer.engine_placed + byIssuer.desk_placed,
  };
}
