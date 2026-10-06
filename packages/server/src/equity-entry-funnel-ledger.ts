// TRA-4998 defect A (filed off the TRA-4971 daily journal review) — the DURABLE
// per-ET-day twin of the equity entry funnel.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
// `equity-entry-funnel.ts` already instruments the whole open path: 4 pass gates,
// 3 symbol-skip reasons, 3 candidate sources and 20 reject reasons, written from
// the two real entry chokepoints. The stage breakdown this ticket asks for has
// existed since TRA-1768. It is simply **unreadable**, because every counter in it
// is IN-MEMORY SINCE BOOT and bqb1 restarts ~6x/day.
//
// Measured on prod `6375852193807851` at 2026-10-01T21:41Z — the box had booted at
// 21:28Z, 13 minutes earlier, post-close:
//
//   demo-1  funnelStatus=gated  passes=27 gated=27 iterated=0
//           cumulative.candidatesEvaluated=null  rejectedByReason=null
//
// Every stage counter reads `null`. That is the instrument behaving exactly as
// designed — and it is why QuantTrader had to report the 2026-09-30 cell
// (60,592 presented at the churn brake, 0 rejected, 0 admitted, in BOTH sleeves)
// as **unexplained**: the only surface carrying a per-stage breakdown cannot speak
// about any ET day it did not personally boot into.
//
// ── WHAT THIS MODULE ADDS ────────────────────────────────────────────────────
// A per-(ET day, mode, engine) aggregate of the SAME stage counters, persisted to
// `DATA_DIR/equity-entry-funnel.jsonl` and rebuilt on boot — the pattern
// `churn-brake-guard.jsonl` (TRA-4335) and `conviction-dca-guard.jsonl` (TRA-2598)
// already use. It also publishes the thing a pile of counters does not give you:
// a NAMED verdict, {@link EquityFunnelZeroStage}, saying which stage took the day
// to zero and how many candidates it ate. That is TRA-4998's acceptance test.
//
// ── SNAPSHOT + LAST-WINS, NOT ONE LINE PER EVENT ─────────────────────────────
// Deliberate, and the one real design choice here. `churn-brake-guard.jsonl` writes
// one line per candidate and holds 636,975 lines over 19 days. The pass layer is far
// chattier than the candidate layer — every engine evaluates the gate on EVERY tick,
// so a per-event scheme would write ~4 lines/tick/fleet forever, the overwhelming
// majority of them identical `market_closed` rows carrying no information.
//
// So a line here is a **snapshot of one day's running aggregate**, and hydration
// takes LAST WINS per `(etDay, mode, engineId)`. Compaction then collapses the file
// to exactly one line per key per retained day — bounded by
// `days x modes x engines`, not by traffic. Flushes are debounced to
// {@link FLUSH_INTERVAL_MS} and forced across an ET-day roll.
//
// The cost of that choice, stated plainly: a hard kill loses up to
// FLUSH_INTERVAL_MS of the current day's increments. For a funnel census that is
// noise — and it is the right trade against a file that would otherwise grow
// without bound to re-state "the market is closed" a million times.
//
// ── HARD INVARIANT (inherited from equity-entry-funnel.ts) ───────────────────
// STRICTLY OBSERVE-ONLY. This module places no order, mutates no account and gates
// nothing; deleting it must not change a single entry decision. All IO is
// best-effort and swallowed — accounting must never break a trade pass — and every
// swallowed failure is COUNTED in `durability.appendErrors`, so a lost write can
// never read identically to a written one.
//
// ── NEVER POOLED ────────────────────────────────────────────────────────────
// Demo and live are separate rows, as in the since-boot funnel: a live sleeve that
// admits nothing holds no risk, and summing it into a busy demo book hides that.
// Engines are separate rows too, for the TRA-1834 reason (the fleet runs >1 demo
// engine). The per-mode `byEtDay` fold a reader grades is the POOLED-ACROSS-ENGINES
// row, which is safe for the question this ticket asks — `admitted: 0` pooled means
// every engine admitted 0 — and `byEngine` is published beside it so a SINGLE dead
// engine on a day that did admit is still visible.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import type {
  EquityEntryMode,
  EquityEntryPassGateReason,
  EquityEntryPassGateDetail,
  EquityEntryRejectReason,
  EquityEntrySource,
  EquitySymbolSkipReason,
  EquityDailyTradesGateDetail,
} from './equity-entry-funnel.js';

const log = logger.child({ module: 'equity-entry-funnel-ledger' });

export const EQUITY_FUNNEL_LOG_FILENAME = 'equity-entry-funnel.jsonl';

/**
 * The ET calendar day for a timestamp.
 *
 * Derived HERE rather than threaded in from the caller, deliberately. The funnel's
 * eight hooks are called from ~40 sites in `signal-engine.ts`; adding an `etDay`
 * parameter to each would be ~40 chances to pass the wrong one (or a UTC day, the
 * TRA-594 bug), for no gain — a census day is a pure function of the event's clock.
 * `en-CA` yields `YYYY-MM-DD`, the same format and zone `etDateString` and the
 * churn-brake guard key on, so the two ledgers' day keys are directly comparable.
 */
// Memoized per WHOLE MINUTE. `toLocaleDateString` with a `timeZone` builds an Intl
// formatter and is comparatively expensive, and these hooks are genuinely hot — the
// symbol-skip hook alone fires ~134 times per pass per engine (the off-universe cut),
// on every tick. An ET day can only ever change on a minute boundary, so a per-minute
// cache is exact, not an approximation: two timestamps in the same UTC minute are
// always in the same ET day. One entry, because calls arrive in time order.
let etDayCacheMinute = -1;
let etDayCacheValue = '';

function etDayOf(ts: number): string {
  const minute = Math.floor(ts / 60_000);
  if (minute !== etDayCacheMinute) {
    etDayCacheMinute = minute;
    etDayCacheValue = new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }
  return etDayCacheValue;
}

/**
 * Retain this many days. Matches `churn-brake-guard.jsonl`'s window on purpose:
 * the whole point of this ledger is to be chainable with that one, and a funnel
 * that forgets a day the brake still remembers cannot explain that day.
 */
const RETENTION_DAYS = 30;
const RETAIN_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Debounce window for snapshot flushes. See the module header. */
const FLUSH_INTERVAL_MS = 30_000;

type Tally<K extends string> = Partial<Record<K, number>>;

/**
 * One persisted snapshot line: the running aggregate for one
 * `(etDay, mode, engineId)` at the instant it was flushed.
 *
 * Counts are CUMULATIVE-FOR-THE-DAY, never deltas. That is what makes last-wins
 * hydration correct: a later line for the same key fully supersedes an earlier
 * one, so a torn or missed flush costs resolution, never consistency. A
 * delta-encoded scheme would double-count on every re-read.
 */
export interface EquityFunnelDayRecord {
  /** Flush time, ms epoch. Also the last-wins tiebreak and the retention key. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD). */
  etDay: string;
  mode: EquityEntryMode;
  /** Stable per-instance engine id (`SignalEngine.feedContextKey`). */
  engineId: string;

  /** Stage 1 — the deterministic pass. */
  passesFired: number;
  passesGated: number;
  passesIterated: number;
  gatedByReason: Tally<EquityEntryPassGateReason>;
  /** TRA-4335 sub-cause of `strategies_inactive_on_tick`; see the funnel module. */
  gatedByDetail: Tally<EquityEntryPassGateDetail>;

  /** Stage 2 — symbols inside an iterating pass. */
  symbolsConsidered: number;
  symbolsEvaluated: number;
  symbolsSkippedByReason: Tally<EquitySymbolSkipReason>;

  /** Stage 3 — candidates that reached an entry chokepoint. */
  candidates: number;
  candidatesBySource: Tally<EquityEntrySource>;

  /** Stage 4 — the 20 guardrails. */
  rejectedByReason: Tally<EquityEntryRejectReason>;

  /** Stage 5 — reached a book. */
  admitted: number;

  /**
   * TRA-5202 — what the TRA-554 daily gate saw at its LAST trip this day, or
   * null/absent when it never tripped. `rejectedByReason.daily_trades_limit`
   * carries the trip COUNT; this carries the cap and the per-sleeve split, so a
   * post-hoc review can tell "budget spent by the equity sleeve" from "budget
   * consumed by a sibling sleeve's rows" without reading source. Optional so
   * pre-TRA-5202 lines hydrate as null, never as a fabricated zero.
   */
  dailyTradesGate?: (EquityDailyTradesGateDetail & { at: number }) | null;

  firstAt: number;
  lastAt: number;
}

/** In-memory day aggregate. Same fields as the record, minus the identity keys. */
interface DayAgg {
  etDay: string;
  mode: EquityEntryMode;
  engineId: string;
  passesFired: number;
  passesGated: number;
  passesIterated: number;
  gatedByReason: Tally<EquityEntryPassGateReason>;
  gatedByDetail: Tally<EquityEntryPassGateDetail>;
  symbolsConsidered: number;
  symbolsEvaluated: number;
  symbolsSkippedByReason: Tally<EquitySymbolSkipReason>;
  candidates: number;
  candidatesBySource: Tally<EquityEntrySource>;
  rejectedByReason: Tally<EquityEntryRejectReason>;
  admitted: number;
  /** TRA-5202 — last daily-gate trip this day; null when it never tripped. */
  dailyTradesGate: (EquityDailyTradesGateDetail & { at: number }) | null;
  firstAt: number;
  lastAt: number;
  /** Dirty/flush bookkeeping — never persisted. */
  dirty: boolean;
  lastFlushAt: number;
}

// ── Store ────────────────────────────────────────────────────────────────────
let dataDir: string | null = null;
/** `${etDay}\u0000${mode}\u0000${engineId}` → aggregate. */
const byKey = new Map<string, DayAgg>();
let hydratedRecords = 0;
let hydratedDays = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;

export function equityFunnelLogPath(dir: string): string {
  return join(dir, EQUITY_FUNNEL_LOG_FILENAME);
}

/**
 * NUL separator, not a space: `engineId` is a `feedContextKey` and this module does
 * not get to assume it is space-free. A separator that can appear inside a
 * component is how two engines silently share a row (the TRA-1834 disease).
 */
function aggKey(etDay: string, mode: EquityEntryMode, engineId: string): string {
  return `${etDay}\u0000${mode}\u0000${engineId}`;
}

/** Test seam — drop every counter and the configured dir. */
export function clearEquityEntryFunnelLedger(): void {
  dataDir = null;
  byKey.clear();
  hydratedRecords = 0;
  hydratedDays = 0;
  appendErrors = 0;
  lastAppendError = null;
  // Drop the ET-day memo too, so a test that rewinds the clock is deterministic.
  etDayCacheMinute = -1;
  etDayCacheValue = '';
}

function emptyAgg(etDay: string, mode: EquityEntryMode, engineId: string, now: number): DayAgg {
  return {
    etDay,
    mode,
    engineId,
    passesFired: 0,
    passesGated: 0,
    passesIterated: 0,
    gatedByReason: {},
    gatedByDetail: {},
    symbolsConsidered: 0,
    symbolsEvaluated: 0,
    symbolsSkippedByReason: {},
    candidates: 0,
    candidatesBySource: {},
    rejectedByReason: {},
    admitted: 0,
    dailyTradesGate: null,
    firstAt: now,
    lastAt: now,
    dirty: false,
    lastFlushAt: 0,
  };
}

function bump<K extends string>(t: Tally<K>, k: K): void {
  t[k] = (t[k] ?? 0) + 1;
}

/**
 * The aggregate for one key, created on first touch.
 *
 * Also the ET-day roll point: when a key for a NEW day is created, any aggregate
 * this (mode, engine) still holds for an EARLIER day is force-flushed before we
 * move on. Without that, the final increments of a session would sit unflushed in
 * memory until the debounce happened to fire again — and after the close it never
 * does, so the last slice of every trading day would be systematically lost. The
 * end of the day is exactly the part a post-close review reads.
 */
function aggFor(etDay: string, mode: EquityEntryMode, engineId: string, now: number): DayAgg {
  const key = aggKey(etDay, mode, engineId);
  let agg = byKey.get(key);
  if (agg === undefined) {
    for (const other of byKey.values()) {
      if (other.mode === mode && other.engineId === engineId && other.etDay !== etDay && other.dirty) {
        flush(other, now, true);
      }
    }
    agg = emptyAgg(etDay, mode, engineId, now);
    byKey.set(key, agg);
  }
  return agg;
}

function touch(agg: DayAgg, now: number): void {
  if (now < agg.firstAt) agg.firstAt = now;
  if (now > agg.lastAt) agg.lastAt = now;
  agg.dirty = true;
}

function toRecord(agg: DayAgg, ts: number): EquityFunnelDayRecord {
  return {
    ts,
    etDay: agg.etDay,
    mode: agg.mode,
    engineId: agg.engineId,
    passesFired: agg.passesFired,
    passesGated: agg.passesGated,
    passesIterated: agg.passesIterated,
    gatedByReason: { ...agg.gatedByReason },
    gatedByDetail: { ...agg.gatedByDetail },
    symbolsConsidered: agg.symbolsConsidered,
    symbolsEvaluated: agg.symbolsEvaluated,
    symbolsSkippedByReason: { ...agg.symbolsSkippedByReason },
    candidates: agg.candidates,
    candidatesBySource: { ...agg.candidatesBySource },
    rejectedByReason: { ...agg.rejectedByReason },
    admitted: agg.admitted,
    dailyTradesGate: agg.dailyTradesGate === null ? null : { ...agg.dailyTradesGate },
    firstAt: agg.firstAt,
    lastAt: agg.lastAt,
  };
}

/**
 * Append one snapshot line for `agg`. Best-effort: a write failure is logged,
 * swallowed and COUNTED, and the aggregate stays `dirty` so the next flush retries
 * it. (Leaving it dirty is the point — a snapshot is cumulative, so a retry is
 * free and a dropped one silently truncates the day.)
 */
function flush(agg: DayAgg, now: number, force: boolean): void {
  if (!agg.dirty) return;
  if (!force && now - agg.lastFlushAt < FLUSH_INTERVAL_MS) return;
  agg.lastFlushAt = now;
  if (dataDir == null) {
    // Memory-only (unit tests / CLI without boot): the aggregates are still live and
    // readable, there is just nothing durable. Clear the flag so a later configured
    // dir does not see a backlog stamped with stale times.
    agg.dirty = false;
    return;
  }
  const path = equityFunnelLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces it
  }
  try {
    appendFileSync(path, JSON.stringify(toRecord(agg, now)) + '\n', 'utf8');
    agg.dirty = false;
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('equity funnel ledger append failed', { reason: lastAppendError });
  }
}

/**
 * Force every dirty aggregate to disk. Called from the EOD archive and available to
 * an operator before a deliberate restart; also the thing that makes a test
 * deterministic without waiting out the debounce.
 */
export function flushEquityEntryFunnelLedger(now: number = Date.now()): void {
  for (const agg of byKey.values()) flush(agg, now, true);
}

// ── Record hooks (called from equity-entry-funnel.ts's existing chokepoints) ──

/** The deterministic pass ITERATED. `symbolsConsidered` is the universe it swept. */
export function ledgerRecordPassIterated(
  mode: EquityEntryMode,
  engineId: string,
  symbolsConsidered: number,
  now: number = Date.now(),
): void {
  const agg = aggFor(etDayOf(now), mode, engineId, now);
  agg.passesFired += 1;
  agg.passesIterated += 1;
  agg.symbolsConsidered += symbolsConsidered;
  touch(agg, now);
  flush(agg, now, false);
}

/** The pass FIRED but was held at the four-way gate; the candidate loop never ran. */
export function ledgerRecordPassGated(
  mode: EquityEntryMode,
  engineId: string,
  reason: EquityEntryPassGateReason,
  detail: EquityEntryPassGateDetail | null,
  now: number = Date.now(),
): void {
  const agg = aggFor(etDayOf(now), mode, engineId, now);
  agg.passesFired += 1;
  agg.passesGated += 1;
  bump(agg.gatedByReason, reason);
  // Keyed to the reason it explains, exactly as the since-boot funnel does: a stray
  // detail on another reason is dropped rather than persisted, so the pair can never
  // disagree on the wire.
  if (reason === 'strategies_inactive_on_tick' && detail) bump(agg.gatedByDetail, detail);
  touch(agg, now);
  flush(agg, now, false);
}

/** A symbol inside an iterating pass reached strategy evaluation. */
export function ledgerRecordSymbolEvaluated(
  mode: EquityEntryMode,
  engineId: string,
  now: number = Date.now(),
): void {
  const agg = aggFor(etDayOf(now), mode, engineId, now);
  agg.symbolsEvaluated += 1;
  touch(agg, now);
  flush(agg, now, false);
}

/** A symbol was skipped before strategy evaluation. */
export function ledgerRecordSymbolSkipped(
  mode: EquityEntryMode,
  engineId: string,
  reason: EquitySymbolSkipReason,
  now: number = Date.now(),
): void {
  const agg = aggFor(etDayOf(now), mode, engineId, now);
  bump(agg.symbolsSkippedByReason, reason);
  touch(agg, now);
  flush(agg, now, false);
}

/** One candidate reached an entry chokepoint. */
export function ledgerRecordCandidate(
  mode: EquityEntryMode,
  engineId: string,
  source: EquityEntrySource,
  now: number = Date.now(),
): void {
  const agg = aggFor(etDayOf(now), mode, engineId, now);
  agg.candidates += 1;
  bump(agg.candidatesBySource, source);
  touch(agg, now);
  flush(agg, now, false);
}

/** One candidate was rejected by a guardrail. */
export function ledgerRecordRejected(
  mode: EquityEntryMode,
  engineId: string,
  reason: EquityEntryRejectReason,
  now: number = Date.now(),
): void {
  const agg = aggFor(etDayOf(now), mode, engineId, now);
  bump(agg.rejectedByReason, reason);
  touch(agg, now);
  flush(agg, now, false);
}

/**
 * TRA-5202 — the TRA-554 daily gate tripped; persist what it saw (last-wins for
 * the day; the trip COUNT lives in `rejectedByReason.daily_trades_limit`).
 */
export function ledgerRecordDailyTradesGate(
  mode: EquityEntryMode,
  engineId: string,
  detail: EquityDailyTradesGateDetail,
  now: number = Date.now(),
): void {
  const agg = aggFor(etDayOf(now), mode, engineId, now);
  agg.dailyTradesGate = { ...detail, at: now };
  touch(agg, now);
  flush(agg, now, false);
}

/** One candidate reached a book. Forced to disk: admits are rare and load-bearing. */
export function ledgerRecordAdmitted(
  mode: EquityEntryMode,
  engineId: string,
  now: number = Date.now(),
): void {
  const agg = aggFor(etDayOf(now), mode, engineId, now);
  agg.admitted += 1;
  touch(agg, now);
  // `force` on purpose. An admit is the single most consequential transition in this
  // funnel and there are ~12 of them a day; losing one to the debounce would flip a
  // day's verdict from `admitting` to a named zero stage, which is the exact false
  // reading this ticket exists to remove.
  flush(agg, now, true);
}

// ── Hydrate ──────────────────────────────────────────────────────────────────

export interface EquityFunnelHydration {
  days: number;
  records: number;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Coerce a persisted tally. Unknown keys are KEPT, deliberately: a forward-written
 * reason this build does not know about must not vanish from the day's totals, or a
 * rolled-back binary would silently restate history as cleaner than it was. Values
 * are coerced to finite non-negative numbers.
 */
function tally<K extends string>(v: unknown): Tally<K> {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = num(raw);
    if (n > 0) out[k] = n;
  }
  return out as Tally<K>;
}

/**
 * TRA-5202 — coerce a persisted daily-gate trip. Any missing/non-finite member
 * yields `null` (no trip recorded), never a fabricated zero: a `limit: 0` that
 * was never measured would read as "cap set to zero", which is a verdict.
 */
function coerceDailyTradesGate(v: unknown): (EquityDailyTradesGateDetail & { at: number }) | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const limit = o.limit;
  const equityCount = o.equityCount;
  const optionSleeveCount = o.optionSleeveCount;
  const at = o.at;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return null;
  if (typeof equityCount !== 'number' || !Number.isFinite(equityCount)) return null;
  if (typeof optionSleeveCount !== 'number' || !Number.isFinite(optionSleeveCount)) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { limit, equityCount, optionSleeveCount, at };
}

/**
 * Rebuild the per-day aggregates from disk and remember `dir` for appends.
 * Idempotent (clears first). LAST WINS per `(etDay, mode, engineId)` — see the
 * module header. Records outside {@link RETAIN_MS} are dropped and the file is
 * COMPACTED to one surviving line per key.
 *
 * Best-effort: a missing/corrupt file yields an empty hydration and a torn trailing
 * line is skipped rather than throwing.
 */
export function hydrateEquityEntryFunnelFromDisk(
  dir: string,
  now: number = Date.now(),
): EquityFunnelHydration {
  clearEquityEntryFunnelLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(equityFunnelLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  let records = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: Partial<EquityFunnelDayRecord>;
    try {
      rec = JSON.parse(trimmed) as Partial<EquityFunnelDayRecord>;
    } catch {
      continue; // torn/partial line
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (rec.mode !== 'demo' && rec.mode !== 'live') continue;
    if (typeof rec.engineId !== 'string' || rec.engineId === '') continue;

    const key = aggKey(rec.etDay, rec.mode, rec.engineId);
    const prior = byKey.get(key);
    // Last wins BY `ts`, not by file order: a compaction that reordered lines, or an
    // append that raced a clock adjustment, must not let an older snapshot overwrite
    // a newer one. (File order is the normal case and agrees with ts.)
    if (prior !== undefined && prior.lastFlushAt > rec.ts) {
      records += 1;
      continue;
    }
    const agg = emptyAgg(rec.etDay, rec.mode, rec.engineId, rec.ts);
    agg.passesFired = num(rec.passesFired);
    agg.passesGated = num(rec.passesGated);
    agg.passesIterated = num(rec.passesIterated);
    agg.gatedByReason = tally(rec.gatedByReason);
    agg.gatedByDetail = tally(rec.gatedByDetail);
    agg.symbolsConsidered = num(rec.symbolsConsidered);
    agg.symbolsEvaluated = num(rec.symbolsEvaluated);
    agg.symbolsSkippedByReason = tally(rec.symbolsSkippedByReason);
    agg.candidates = num(rec.candidates);
    agg.candidatesBySource = tally(rec.candidatesBySource);
    agg.rejectedByReason = tally(rec.rejectedByReason);
    agg.admitted = num(rec.admitted);
    agg.dailyTradesGate = coerceDailyTradesGate(rec.dailyTradesGate); // TRA-5202 — absent on old lines ⇒ null
    agg.firstAt = num(rec.firstAt) || rec.ts;
    agg.lastAt = num(rec.lastAt) || rec.ts;
    agg.dirty = false;
    // Remember the snapshot's own stamp so a later line for this key is ordered
    // against it, and so the debounce does not immediately re-flush a hydrated day.
    agg.lastFlushAt = rec.ts;
    byKey.set(key, agg);
    records += 1;
  }

  // Compact to the surviving snapshots (one line per key). Skipped when nothing was
  // dropped, to avoid a needless rewrite on every clean boot.
  const nonEmpty = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (byKey.size < nonEmpty) {
    const path = equityFunnelLogPath(dir);
    const kept = [...byKey.values()].map((a) => JSON.stringify(toRecord(a, a.lastFlushAt)));
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('equity funnel ledger compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hydratedRecords = records;
  hydratedDays = new Set([...byKey.values()].map((a) => a.etDay)).size;
  return { days: hydratedDays, records };
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * WHICH STAGE took an ET day to `admitted: 0`. The named verdict TRA-4998 asks for
 * — derived, never stored, so it can never disagree with the counters beside it.
 *
 * Evaluated in funnel order, first blocking stage wins, because that is the only
 * stage a reader can act on: if the pass never iterated, the reject buckets being
 * empty says nothing about the guardrails.
 */
export type EquityFunnelZeroStage =
  /** The pass never fired at all this ET day. Says NOTHING about the book. */
  | 'no_passes'
  /** Every pass was held at the four-way gate; the candidate loop never iterated. */
  | 'all_passes_gated'
  /** Passes iterated but NO symbol reached strategy evaluation — a DATA problem. */
  | 'no_symbols_evaluated'
  /** Strategies ran on real symbols and produced no idea — a STRATEGY problem. */
  | 'no_candidates'
  /** Ideas were generated and every one was eaten — a CALIBRATION problem. */
  | 'all_candidates_rejected';

/** The dominant contributor to a stage's zero, named with its count. */
export interface EquityFunnelZeroDetail {
  /** The reason bucket that ate the most, e.g. `market_closed`, `swing_universe`. */
  reason: string;
  count: number;
}

export interface EquityFunnelDaySummary {
  etDay: string;
  mode: EquityEntryMode;
  passesFired: number;
  passesGated: number;
  passesIterated: number;
  gatedByReason: Tally<EquityEntryPassGateReason>;
  gatedByDetail: Tally<EquityEntryPassGateDetail>;
  symbolsConsidered: number;
  symbolsEvaluated: number;
  symbolsSkippedByReason: Tally<EquitySymbolSkipReason>;
  candidates: number;
  candidatesBySource: Tally<EquityEntrySource>;
  rejectedByReason: Tally<EquityEntryRejectReason>;
  admitted: number;
  /**
   * `null` when `admitted > 0` — the day is not zeroed, so no stage zeroed it.
   * Otherwise the first blocking stage in funnel order.
   */
  zeroedAtStage: EquityFunnelZeroStage | null;
  /**
   * How many candidates/symbols/passes that stage accounted for. The "count it
   * zeroed" half of TRA-4998's acceptance.
   */
  zeroedCount: number | null;
  /** The biggest named bucket inside that stage, or `null` when the stage has none. */
  zeroedDetail: EquityFunnelZeroDetail | null;
  /**
   * TRA-5202 — the newest daily-gate trip recorded for this (day, mode), with the
   * cap and the per-sleeve split of what the gate counted. `null` = the gate never
   * tripped (or the day predates TRA-5202 — absent is UNRECORDED, not zero). Read
   * beside `rejectedByReason.daily_trades_limit`, which carries the trip count.
   */
  dailyTradesGate: (EquityDailyTradesGateDetail & { at: number }) | null;
  /** Per-engine rows, so one dead engine on an admitting day is still visible. */
  byEngine: EquityFunnelEngineSummary[];
  firstAt: number;
  lastAt: number;
}

export interface EquityFunnelEngineSummary {
  engineId: string;
  passesFired: number;
  passesGated: number;
  passesIterated: number;
  symbolsEvaluated: number;
  candidates: number;
  admitted: number;
  zeroedAtStage: EquityFunnelZeroStage | null;
}

export interface EquityFunnelLedgerDurability {
  /** Resolved append target. `null` = memory-only: NOTHING here is durable. */
  dataDir: string | null;
  /** TRUE ⇒ every retained count dies on the next redeploy. */
  ephemeral: boolean;
  /** Snapshot lines read FROM DISK at boot — a real floor vs this-uptime-only. */
  hydratedRecords: number;
  hydratedDays: number;
  /** Appends that threw and were swallowed. > 0 ⇒ the counters understate the day. */
  appendErrors: number;
  lastAppendError: string | null;
  /** Worst-case unflushed increments on a hard kill. See the module header. */
  flushIntervalMs: number;
}

export interface EquityFunnelLedgerSummary {
  retentionDays: number;
  /** Every ET day retained, ascending. */
  etDays: string[];
  /** Per-(day, mode) fold, ascending by ET day then mode. */
  byEtDay: EquityFunnelDaySummary[];
  durability: EquityFunnelLedgerDurability;
  note: string;
}

function topOf<K extends string>(t: Tally<K>): EquityFunnelZeroDetail | null {
  let best: EquityFunnelZeroDetail | null = null;
  for (const [reason, count] of Object.entries(t) as [string, number][]) {
    if (count > 0 && (best === null || count > best.count)) best = { reason, count };
  }
  return best;
}

/**
 * Classify one day's zero. Funnel order, first blocking stage wins.
 *
 * `no_passes` is checked first and is NOT a strategy verdict — a day with no pass is
 * a day the engine never reached the equity path (a weekend, a holiday, a box that
 * was down). Collapsing it into `no_candidates` would indict the strategy for the
 * market being shut, which is the TRA-1768 false zero this whole family of
 * instruments exists to prevent.
 */
function classifyZero(
  a: Pick<
    EquityFunnelDaySummary,
    | 'passesFired' | 'passesIterated' | 'symbolsEvaluated' | 'candidates' | 'admitted'
  >,
): EquityFunnelZeroStage | null {
  if (a.admitted > 0) return null;
  if (a.passesFired === 0) return 'no_passes';
  if (a.passesIterated === 0) return 'all_passes_gated';
  if (a.symbolsEvaluated === 0) return 'no_symbols_evaluated';
  if (a.candidates === 0) return 'no_candidates';
  return 'all_candidates_rejected';
}

/** The count and dominant bucket for a classified stage. */
function zeroEvidence(
  stage: EquityFunnelZeroStage | null,
  d: EquityFunnelDaySummary,
): { count: number | null; detail: EquityFunnelZeroDetail | null } {
  switch (stage) {
    case null:
      return { count: null, detail: null };
    case 'no_passes':
      return { count: 0, detail: null };
    case 'all_passes_gated':
      return { count: d.passesGated, detail: topOf(d.gatedByReason) };
    case 'no_symbols_evaluated':
      return { count: d.symbolsConsidered, detail: topOf(d.symbolsSkippedByReason) };
    case 'no_candidates':
      return { count: d.symbolsEvaluated, detail: null };
    case 'all_candidates_rejected':
      return { count: d.candidates, detail: topOf(d.rejectedByReason) };
  }
}

function addTally<K extends string>(into: Tally<K>, from: Tally<K>): void {
  for (const [k, v] of Object.entries(from) as [K, number][]) {
    into[k] = (into[k] ?? 0) + v;
  }
}

/** Fold the store into the read-only health diagnostics. Pure — no IO. */
export function summarizeEquityEntryFunnelLedger(): EquityFunnelLedgerSummary {
  /** `${etDay}\u0000${mode}` → day row under construction. */
  const days = new Map<string, EquityFunnelDaySummary>();
  for (const a of byKey.values()) {
    const k = `${a.etDay}\u0000${a.mode}`;
    let d = days.get(k);
    if (d === undefined) {
      d = {
        etDay: a.etDay,
        mode: a.mode,
        passesFired: 0,
        passesGated: 0,
        passesIterated: 0,
        gatedByReason: {},
        gatedByDetail: {},
        symbolsConsidered: 0,
        symbolsEvaluated: 0,
        symbolsSkippedByReason: {},
        candidates: 0,
        candidatesBySource: {},
        rejectedByReason: {},
        admitted: 0,
        zeroedAtStage: null,
        zeroedCount: null,
        zeroedDetail: null,
        dailyTradesGate: null,
        byEngine: [],
        firstAt: a.firstAt,
        lastAt: a.lastAt,
      };
      days.set(k, d);
    }
    d.passesFired += a.passesFired;
    d.passesGated += a.passesGated;
    d.passesIterated += a.passesIterated;
    addTally(d.gatedByReason, a.gatedByReason);
    addTally(d.gatedByDetail, a.gatedByDetail);
    d.symbolsConsidered += a.symbolsConsidered;
    d.symbolsEvaluated += a.symbolsEvaluated;
    addTally(d.symbolsSkippedByReason, a.symbolsSkippedByReason);
    d.candidates += a.candidates;
    addTally(d.candidatesBySource, a.candidatesBySource);
    addTally(d.rejectedByReason, a.rejectedByReason);
    d.admitted += a.admitted;
    // TRA-5202 — newest trip wins across engines; a detail is a reading of ONE
    // gate evaluation, so summing per-sleeve counts across engines would
    // fabricate a population no gate ever saw.
    if (a.dailyTradesGate !== null
      && (d.dailyTradesGate === null || a.dailyTradesGate.at > d.dailyTradesGate.at)) {
      d.dailyTradesGate = { ...a.dailyTradesGate };
    }
    if (a.firstAt < d.firstAt) d.firstAt = a.firstAt;
    if (a.lastAt > d.lastAt) d.lastAt = a.lastAt;
    d.byEngine.push({
      engineId: a.engineId,
      passesFired: a.passesFired,
      passesGated: a.passesGated,
      passesIterated: a.passesIterated,
      symbolsEvaluated: a.symbolsEvaluated,
      candidates: a.candidates,
      admitted: a.admitted,
      zeroedAtStage: classifyZero(a),
    });
  }

  const byEtDay = [...days.values()].sort(
    (x, y) => (x.etDay === y.etDay ? x.mode.localeCompare(y.mode) : x.etDay.localeCompare(y.etDay)),
  );
  for (const d of byEtDay) {
    d.byEngine.sort((x, y) => x.engineId.localeCompare(y.engineId));
    d.zeroedAtStage = classifyZero(d);
    const ev = zeroEvidence(d.zeroedAtStage, d);
    d.zeroedCount = ev.count;
    d.zeroedDetail = ev.detail;
  }

  return {
    retentionDays: RETENTION_DAYS,
    etDays: [...new Set(byEtDay.map((d) => d.etDay))].sort(),
    byEtDay,
    durability: {
      dataDir,
      ephemeral: dataDir === null ? true : isEphemeralDataDir(dataDir),
      hydratedRecords,
      hydratedDays,
      appendErrors,
      lastAppendError,
      flushIntervalMs: FLUSH_INTERVAL_MS,
    },
    note:
      'TRA-4998 — DURABLE per-ET-day equity entry funnel (restart-safe, unlike the since-boot '
      + 'per-engine blocks beside this one, which read all-null on any box that booted after the '
      + 'session). `zeroedAtStage` names the first blocking stage on any day with admitted:0 and '
      + '`zeroedCount`/`zeroedDetail` quantify it. Rows are per (ET day, mode) pooled across '
      + 'engines, with `byEngine` beside them; demo and live are NEVER pooled. Retained days '
      + 'EARLIER than this ledger\'s first write carry no row at all rather than a row of zeroes '
      + '— an absent day is UNRECORDED, never "nothing happened".',
  };
}
