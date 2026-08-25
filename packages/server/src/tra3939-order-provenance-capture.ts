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
 */

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { TradierAccountOrder, TradierOrderSubmitEvent } from '@trading-app/engine';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

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
let submitAppendErrors = 0;
let lastSubmitAppendError: string | null = null;
let captureAppendErrors = 0;

/** Book attribution for the next submits, set by the engine seam that knows it. */
let currentBook: string | null = null;

export function setOrderProvenanceCaptureDataDir(dir: string | null): void {
  dataDir = dir;
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
    appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
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
}

export interface CaptureBrokerOrderDayResult {
  written: boolean;
  /** Why nothing was written: a successful capture for this day already exists. */
  skippedAlreadyCaptured: boolean;
  appendError: string | null;
  line: BrokerOrderCaptureLine | null;
}

/**
 * Capture ONE ET day's broker order list.
 *
 * Idempotent on SUCCESS only: a day already holding a `read:true` line is skipped,
 * so a scheduler that fires hourly after the close writes once. A day holding only
 * BLIND lines is retried — the whole point of the retry window is that a failed
 * read at 16:00 ET can still succeed at 17:00 ET, while the broker's one-day window
 * is open.
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
  };
  if (dataDir == null) {
    return { written: false, skippedAlreadyCaptured: false, appendError: null, line };
  }
  const already = readBrokerOrderCaptures().some(l => l.etDay === input.etDay && l.read);
  if (already) {
    return { written: false, skippedAlreadyCaptured: true, appendError: null, line: null };
  }
  if (!appendLine(brokerOrderCaptureLogPath(dataDir), line)) {
    captureAppendErrors += 1;
    log.warn('tra3939 broker order capture append failed', {
      etDay: input.etDay,
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
}

export interface BrokerOrderCaptureSummary {
  dataDir: string | null;
  ephemeral: boolean;
  retention: string;
  lines: number;
  days: BrokerOrderCaptureDayRow[];
  /** Days with a successful, FULL-session capture. The witness authority. */
  attestedEtDays: string[];
  /** Days captured but not attestable. Named, so `full` is never inferred. */
  unattestedEtDays: string[];
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

export function summarizeBrokerOrderCaptures(): BrokerOrderCaptureSummary {
  const lines = readBrokerOrderCaptures();
  const byDay = new Map<string, BrokerOrderCaptureLine[]>();
  for (const l of lines) {
    const g = byDay.get(l.etDay);
    if (g) g.push(l);
    else byDay.set(l.etDay, [l]);
  }
  const days: BrokerOrderCaptureDayRow[] = [];
  const attested: string[] = [];
  const unattested: string[] = [];
  for (const [etDay, group] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // The successful line is the authority; a later blind retry cannot un-capture a day.
    const good = group.find(l => l.read) ?? null;
    const chosen = good ?? group[group.length - 1]!;
    days.push({
      etDay,
      captured: good !== null,
      attempts: group.length,
      orders: chosen.orders.length,
      optionOrders: chosen.orders.filter(o => typeof o.optionSymbol === 'string' && o.optionSymbol !== '')
        .length,
      attestation: chosen.attestation,
      lastError: group[group.length - 1]!.error,
      capturedAt: good?.capturedAt ?? null,
    });
    if (good !== null && good.attestation === 'full') attested.push(etDay);
    else unattested.push(etDay);
  }
  const known = days.map(d => d.etDay);
  const gapEtDays =
    known.length === 0
      ? []
      : etWeekdaysBetween(known[0]!, known[known.length - 1]!).filter(d => !byDay.has(d));
  return {
    dataDir,
    ephemeral: isEphemeralDataDir(dataDir),
    retention: ORDER_PROVENANCE_RETENTION,
    lines: lines.length,
    days,
    attestedEtDays: attested,
    unattestedEtDays: unattested,
    gapEtDays,
  };
}

/**
 * Every order row we have ever captured, newest capture per day.
 *
 * This is what turns the broker's one-day window into a growing archive: the
 * resolver joins against THIS, not against a live fetch, so a contract opened on a
 * day we captured stays answerable forever.
 */
export function capturedBrokerOrders(): TradierAccountOrder[] {
  const out: TradierAccountOrder[] = [];
  const seenDay = new Set<string>();
  for (const l of readBrokerOrderCaptures()) {
    if (!l.read) continue;
    if (seenDay.has(l.etDay)) continue;
    seenDay.add(l.etDay);
    out.push(...l.orders);
  }
  return out;
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
}

export interface CapturedOrderCensusDay {
  etDay: string;
  attested: boolean;
  orders: number;
  engine_placed: number;
  desk_placed: number;
  blind_no_issuer_witness: number;
}

export interface CapturedOrderCensus {
  /** Option orders only — the submit ledger hooks the OPTIONS client, so an equity order's absence from it is not evidence. */
  orders: CapturedOrderCensusRow[];
  skippedNonOption: number;
  byIssuer: Record<CapturedOrderIssuer, number>;
  byDay: CapturedOrderCensusDay[];
  /** engine_placed + desk_placed — the count of terminal verdicts reached on real rows. */
  terminalOrders: number;
}

export interface CapturedOrderCensusInput {
  orders: readonly TradierAccountOrder[];
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
  const seen = new Set<number>();
  let skippedNonOption = 0;
  for (const o of input.orders) {
    if (typeof o.id !== 'number' || !Number.isFinite(o.id) || seen.has(o.id)) continue;
    seen.add(o.id);
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
    });
  }
  rows.sort((a, b) => (a.createDate ?? '').localeCompare(b.createDate ?? '') || a.id - b.id);
  const byIssuer: Record<CapturedOrderIssuer, number> = {
    engine_placed: 0,
    desk_placed: 0,
    blind_no_issuer_witness: 0,
  };
  const dayMap = new Map<string, CapturedOrderCensusDay>();
  for (const r of rows) {
    byIssuer[r.issuer] += 1;
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
    terminalOrders: byIssuer.engine_placed + byIssuer.desk_placed,
  };
}
