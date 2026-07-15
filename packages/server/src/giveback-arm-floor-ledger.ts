// TRA-1892 (parent TRA-1592 → TRA-1435) — DURABLE, recoverable per-session record of
// the book-level give-back / session-stop outcome, so the ≥5-session arm-floor
// forward-test can accrue even when the live 21:40Z grade fire is missed.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The give-back cap's minimum arm floor (TRA-1435) is armed on demo+live and being
// forward-validated (TRA-1592, ≥5 clean sessions). But the state it must be graded
// against — `DailyRiskGovernor.peakOpenGain` / `sessionHalted` — is IN-MEMORY ONLY
// and resets on the ET day roll AND is wiped by bqb1's ~04:30Z nightly reboot. The
// per-session grader (routine 10c87ecd) only fires if the local self-host is alive at
// 21:40Z; it missed Mon 2026-07-13 and Tue 2026-07-14, and a catch-up read the next
// morning reads a rebooted, wiped book (a FALSE-CLEAN). Net: a missed live fire =
// a permanently lost session, and the ≥5 gate can never reliably close.
//
// This module widens the grade window from the ~7h the book state lives in memory to
// "any time before the record ages out of the retention window", by writing each
// give-back/halt-latch state transition to an append-only JSONL under DATA_DIR and
// rebuilding it on boot. A missed 21:40Z fire is then RECOVERABLE by a catch-up read
// of `GET /api/health/giveback-arm-floor` — the session's outcome survives the reboot.
//
// ── THE DURABILITY CAVEAT THAT IS NOT OPTIONAL (TRA-1681 / TRA-1719) ──────────
// "A persisted file survives a reboot" is TRUE only if DATA_DIR points at a mounted
// persistent disk. With DATA_DIR unset, the caller falls back to a path INSIDE the
// build bundle (`index.ts`: `process.env.DATA_DIR ?? join(__dirname,'..','data')`) —
// a real, writable directory. `mkdirSync` succeeds, `appendFileSync` succeeds, the
// boot hydrate reads it back — and every byte still evaporates on the next redeploy.
// There is NO error to catch. On such a box this ledger is wiped at the SAME reboot
// that wipes the in-memory state it was built to outlast, so it buys nothing.
//
// The ONLY discriminator is the PATH, so `durability.ephemeral` (a property of the
// path, decisive on the very first boot before a single row exists) is published in
// the read payload and must be read FIRST. `ephemeral: true` ⇒ the recoverability
// guarantee is VOID and this ledger is no better than memory — the fix is
// `DATA_DIR=/data` on bqb1 (TRA-1719), not code.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only telemetry. NEVER places an order, mutates an account, or changes the
// governor. It is a write-through of the give-back decision the governor ALREADY made
// each tick. Keyed per (mode, engineId, sessionDate) — SPLIT per book, never pooled
// (TRA-1834: a ledger shared by two demo engines is not one; one book's tick would
// otherwise clobber the other's). No PII/balances — book-level P&L, floor, flags,
// mode, engine id, and ET day, the same data the public halt-reason string already
// exposes.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'giveback-arm-floor-ledger' });

export const GIVEBACK_ARM_FLOOR_LOG_FILENAME = 'giveback-arm-floor.jsonl';

/**
 * Retain this many ms of session records on disk (compacted on boot). The ≥5-session
 * arm-floor gate spans at least a trading week and can slip to two; 30 days covers a
 * comfortably long accrual window while bounding a file that takes a handful of lines
 * per book per session (give-back state transitions are rare).
 */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/** The give-back halt reason CODE (mirrors the engine's `BookHaltReason`). */
export type GiveBackHaltReason = 'giveback_cap' | 'session_net_negative';

/**
 * A snapshot of the book-level give-back state at one tick, built by the governor's
 * `markBook` and handed to {@link recordGiveBackState}. Everything the per-session
 * outcome is folded from; carries the machine-readable halt REASON code (not the long
 * human string) so a grader can classify without parsing prose.
 */
export interface BookGiveBackSnapshot {
  /** Intraday peak of (realized + open) book P&L this session, floored at 0. */
  peakPnl: number;
  /** Current (realized + open) book P&L at this tick. */
  currentPnl: number;
  /** Dollar floor the give-back cap trips below: `peakPnl × (1 − cap)`. */
  retainedFloor: number;
  /** TRA-1435 minimum arm floor in force (0 ⇒ legacy arm-at-any-peak). */
  giveBackArmFloor: number;
  /** The give-back cap fraction (e.g. 0.40). */
  giveBackCapPct: number;
  /** True once the day's peak reached the arm floor (`peakPnl > 0 && peakPnl ≥ armFloor`). */
  armFloorCleared: boolean;
  /** True once the book give-back / session-stop halt is latched for the session. */
  haltLatched: boolean;
  /** Why it latched (null until/unless it does). */
  haltReason: GiveBackHaltReason | null;
}

/** One durable JSONL line — a snapshot tagged with time, book, and ET session date. */
interface GiveBackRecord {
  /** Snapshot time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the session date the outcome keys on. */
  etDay: string;
  /** Book mode. */
  mode: 'demo' | 'live';
  /** Stable per-engine id (SignalEngine.feedContextKey) — SPLIT per book (TRA-1834). */
  engineId: string;
  peakPnl: number;
  currentPnl: number;
  retainedFloor: number;
  giveBackArmFloor: number;
  giveBackCapPct: number;
  armFloorCleared: boolean;
  haltLatched: boolean;
  haltReason: GiveBackHaltReason | null;
}

/** One book's folded outcome for one ET session. */
interface SessionOutcome {
  sessionDate: string;
  mode: 'demo' | 'live';
  engineId: string;
  /** Max (realized + open) peak seen this session. */
  peakPnl: number;
  /** Latest (realized + open) P&L seen (by ts). */
  lastPnl: number;
  /** Arm floor last in force this session. */
  giveBackArmFloor: number;
  /** Give-back cap fraction last in force. */
  giveBackCapPct: number;
  /** True if the day's peak cleared the arm floor at any point. */
  armFloorCleared: boolean;
  /** True if a give-back / session-stop halt latched at any point. */
  haltLatched: boolean;
  /** The reason it latched (from the halt transition), null when clean. */
  haltReason: GiveBackHaltReason | null;
  /** (realized+open) P&L captured at the halt transition (null when clean). */
  pnlAtHalt: number | null;
  firstTs: number;
  lastTs: number;
  records: number;
}

// ── In-memory store (backs the durable outcomes + the health endpoint) ────────
//
// Module-global + observe-only. `dataDir` is set once at boot by
// hydrateGiveBackArmFloorFromDisk so the engine chokepoint can append without
// threading a path through the SignalEngine.

let dataDir: string | null = null;
/** etDay -> (`${mode}::${engineId}` -> outcome). SPLIT per book (TRA-1834). */
const byDay = new Map<string, Map<string, SessionOutcome>>();
let lastRecordAt: number | null = null;
/**
 * Throttle: the last DURABLY-WRITTEN signature per book-session. A snapshot that does
 * not change the dollar-floored peak, the armFloorCleared flag, or the halt state is
 * folded into memory but NOT re-appended — bounding writes on the tick hot path to a
 * handful per book per session while keeping the disk copy accurate to the dollar.
 */
const lastWrittenSig = new Map<string, string>();
// TRA-1681 — durability provenance. `byDay` is fed by BOTH the boot hydrate and the
// live pass, and once folded the two are indistinguishable. These say which.
/** Records/days recovered FROM DISK at boot (0 after a reboot on an ephemeral mount). */
let hydratedRecords = 0;
let hydratedDays = 0;
/** Appends that threw and were swallowed. > 0 ⇒ outcomes shown are NOT all on disk. */
let appendErrors = 0;
let lastAppendError: string | null = null;

export function giveBackArmFloorLogPath(dir: string): string {
  return join(dir, GIVEBACK_ARM_FLOOR_LOG_FILENAME);
}

function bookKey(mode: string, engineId: string): string {
  return `${mode}::${engineId}`;
}

function sigKey(etDay: string, mode: string, engineId: string): string {
  return `${etDay}::${mode}::${engineId}`;
}

/** Test seam — drop every counter and the configured dir. */
export function clearGiveBackArmFloorLedger(): void {
  dataDir = null;
  byDay.clear();
  lastRecordAt = null;
  lastWrittenSig.clear();
  hydratedRecords = 0;
  hydratedDays = 0;
  appendErrors = 0;
  lastAppendError = null;
}

/** Apply one record to the in-memory per-book/session outcome (shared by record + hydrate). */
function apply(rec: GiveBackRecord): void {
  let day = byDay.get(rec.etDay);
  if (!day) {
    day = new Map();
    byDay.set(rec.etDay, day);
  }
  const key = bookKey(rec.mode, rec.engineId);
  let o = day.get(key);
  if (!o) {
    o = {
      sessionDate: rec.etDay,
      mode: rec.mode,
      engineId: rec.engineId,
      peakPnl: rec.peakPnl,
      lastPnl: rec.currentPnl,
      giveBackArmFloor: rec.giveBackArmFloor,
      giveBackCapPct: rec.giveBackCapPct,
      armFloorCleared: false,
      haltLatched: false,
      haltReason: null,
      pnlAtHalt: null,
      firstTs: rec.ts,
      lastTs: rec.ts,
      records: 0,
    };
    day.set(key, o);
  }
  o.records += 1;
  if (rec.peakPnl > o.peakPnl) o.peakPnl = rec.peakPnl;
  o.giveBackArmFloor = rec.giveBackArmFloor;
  o.giveBackCapPct = rec.giveBackCapPct;
  o.armFloorCleared = o.armFloorCleared || rec.armFloorCleared;
  o.firstTs = Math.min(o.firstTs, rec.ts);
  if (rec.ts >= o.lastTs) {
    o.lastTs = rec.ts;
    o.lastPnl = rec.currentPnl;
  }
  // Capture the halt details on the FIRST record that shows the latch (the transition).
  // The halt is sticky for the session, so later ticks carry haltLatched:true too — but
  // only the first one is the money event, and its floor/pnl are the give-back at halt.
  if (rec.haltLatched && !o.haltLatched) {
    o.haltLatched = true;
    o.haltReason = rec.haltReason;
    o.pnlAtHalt = rec.currentPnl;
  }
  lastRecordAt = rec.ts;
}

/**
 * Record one book give-back SNAPSHOT (built by the governor each tick) against the
 * durable per-book/session outcome, and — when the outcome MATERIALLY changed — append
 * one JSONL line under the configured DATA_DIR.
 *
 * A flat/red book that never went green and never halted has no give-back outcome to
 * grade, so it is skipped entirely (`peakPnl ≤ 0 && !haltLatched`). Otherwise the
 * in-memory fold ALWAYS updates; the disk append is throttled to genuine transitions
 * (a new dollar-floored peak, the arm floor clearing, or the halt latching) so the
 * tick hot path writes a handful of lines per book per session, not one per tick.
 *
 * Best-effort on IO — a write failure logs, is COUNTED (so the swallow is never
 * silent), and is swallowed so this accounting can never break the trade pass. When no
 * dataDir is configured (unit tests / CLI without boot) the fold still updates; only
 * the file write is skipped.
 */
export function recordGiveBackState(
  mode: 'demo' | 'live',
  engineId: string,
  etDay: string,
  snap: BookGiveBackSnapshot,
  now: number = Date.now(),
): void {
  // No give-back outcome to record: the book never went green and did not halt.
  if (!(snap.peakPnl > 0) && !snap.haltLatched) return;

  const rec: GiveBackRecord = {
    ts: now,
    etDay,
    mode,
    engineId,
    peakPnl: Number.isFinite(snap.peakPnl) ? snap.peakPnl : 0,
    currentPnl: Number.isFinite(snap.currentPnl) ? snap.currentPnl : 0,
    retainedFloor: Number.isFinite(snap.retainedFloor) ? snap.retainedFloor : 0,
    giveBackArmFloor: Number.isFinite(snap.giveBackArmFloor) ? snap.giveBackArmFloor : 0,
    giveBackCapPct: Number.isFinite(snap.giveBackCapPct) ? snap.giveBackCapPct : 0,
    armFloorCleared: snap.armFloorCleared,
    haltLatched: snap.haltLatched,
    haltReason: snap.haltReason,
  };

  // Fold FIRST and UNCONDITIONALLY — accounting must never break a trade pass — then
  // decide whether this transition is worth a durable line.
  apply(rec);
  if (dataDir == null) return;

  const key = sigKey(etDay, mode, engineId);
  const sig = `${Math.floor(rec.peakPnl)}|${rec.armFloorCleared ? 1 : 0}|${rec.haltLatched ? 1 : 0}|${rec.haltReason ?? ''}`;
  if (lastWrittenSig.get(key) === sig) return; // no material change since the last write
  lastWrittenSig.set(key, sig);

  const path = giveBackArmFloorLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    // Swallowed so the trade pass survives — but COUNTED, so the swallow is not silent.
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('giveback-arm-floor append failed', { reason: lastAppendError });
  }
}

/** What {@link hydrateGiveBackArmFloorFromDisk} recovered (for the boot log line). */
export interface GiveBackArmFloorHydration {
  /** Distinct ET days retained after compaction. */
  days: number;
  /** Total records retained. */
  records: number;
  /** Distinct book-sessions retained. */
  sessions: number;
}

/**
 * Rebuild the in-memory outcomes from disk on boot and remember `dir` for subsequent
 * appends. Idempotent: CLEARS first, so it is safe to call exactly once at startup
 * before any live pass. Only records within {@link RETAIN_MS} of `now` are kept, and
 * the file is COMPACTED to exactly those lines (bounding growth). Best-effort: a
 * missing/corrupt file yields an empty hydration; a torn trailing line is skipped
 * rather than throwing.
 */
export function hydrateGiveBackArmFloorFromDisk(
  dir: string,
  now: number = Date.now(),
): GiveBackArmFloorHydration {
  clearGiveBackArmFloorLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(giveBackArmFloorLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: GiveBackRecord;
    try {
      rec = JSON.parse(trimmed) as GiveBackRecord;
    } catch {
      continue; // skip a torn/partial line rather than abort the hydrate
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (rec.mode !== 'demo' && rec.mode !== 'live') continue;
    if (typeof rec.engineId !== 'string' || rec.engineId === '') continue;
    const haltReason =
      rec.haltReason === 'giveback_cap' || rec.haltReason === 'session_net_negative'
        ? rec.haltReason
        : null;
    const clean: GiveBackRecord = {
      ts: rec.ts,
      etDay: rec.etDay,
      mode: rec.mode,
      engineId: rec.engineId,
      peakPnl: Number.isFinite(rec.peakPnl) ? rec.peakPnl : 0,
      currentPnl: Number.isFinite(rec.currentPnl) ? rec.currentPnl : 0,
      retainedFloor: Number.isFinite(rec.retainedFloor) ? rec.retainedFloor : 0,
      giveBackArmFloor: Number.isFinite(rec.giveBackArmFloor) ? rec.giveBackArmFloor : 0,
      giveBackCapPct: Number.isFinite(rec.giveBackCapPct) ? rec.giveBackCapPct : 0,
      armFloorCleared: rec.armFloorCleared === true,
      haltLatched: rec.haltLatched === true,
      haltReason,
    };
    apply(clean);
    kept.push(JSON.stringify(clean));
    // Re-seed the write throttle so the first post-boot tick with an identical state
    // does not rewrite a line already on disk.
    lastWrittenSig.set(
      sigKey(clean.etDay, clean.mode, clean.engineId),
      `${Math.floor(clean.peakPnl)}|${clean.armFloorCleared ? 1 : 0}|${clean.haltLatched ? 1 : 0}|${clean.haltReason ?? ''}`,
    );
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped when
  // there is nothing to drop, to avoid a needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = giveBackArmFloorLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('giveback-arm-floor compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // TRA-1681 — freeze what came OFF DISK before the live pass folds its own snapshots
  // into the same `byDay`. After the first live record the two are one map and no
  // consumer can tell "recovered a week of history" from "this uptime, nothing under me".
  hydratedRecords = kept.length;
  hydratedDays = byDay.size;
  let sessions = 0;
  for (const day of byDay.values()) sessions += day.size;
  return { days: byDay.size, records: kept.length, sessions };
}

// ── Health summary ───────────────────────────────────────────────────────────

/**
 * The per-session verdict a grader reads, derived purely from the folded flags.
 *
 * - `giveback_halt_sub_floor` — a give-back halt fired on a day whose peak NEVER
 *   cleared the arm floor. This is the TRA-1592 PRIMARY-AC INVALIDATION: the arm floor
 *   exists precisely to stop this. Its count is surfaced as `invalidations`.
 * - `giveback_halt_above_floor` — a give-back halt on an above-floor day (the
 *   non-regression case: the cap SHOULD still bite here).
 * - `session_stop` — the session stop latched (net-negative after a real up-move); NOT
 *   floor-gated, so it may fire on a sub-floor-peak day and that is CORRECT.
 * - `clean_sub_floor` — peak stayed below the floor and nothing halted (the tiny-peak
 *   day the arm floor protects: a PRIMARY-AC PASS datapoint).
 * - `clean_above_floor` — peak cleared the floor and the book never surrendered >cap.
 */
export type GiveBackSessionVerdict =
  | 'giveback_halt_sub_floor'
  | 'giveback_halt_above_floor'
  | 'session_stop'
  | 'clean_sub_floor'
  | 'clean_above_floor';

export interface GiveBackSessionSummary {
  sessionDate: string;
  mode: 'demo' | 'live';
  engineId: string;
  /** Max (realized + open) peak this session. */
  peakPnl: number;
  /** Latest (realized + open) P&L observed. */
  lastPnl: number;
  /** The arm floor in force. */
  giveBackArmFloor: number;
  /** The dollar floor the give-back cap trips below (`peak × (1 − cap)`). */
  retainedFloor: number;
  /** The give-back cap fraction (e.g. 0.4). */
  giveBackCapPct: number;
  /** Did the day's peak clear the arm floor? */
  armFloorCleared: boolean;
  /** Did a give-back / session-stop halt latch? */
  haltLatched: boolean;
  /** The halt reason code (null when clean). */
  haltReason: GiveBackHaltReason | null;
  /**
   * Fraction of the peak surrendered by the last observed P&L: `(peak − last) / peak`.
   * `null` when there was no positive peak (undefined, NOT 0 — a 0 here would read as
   * "gave back nothing", TRA-1707).
   */
  giveBackPct: number | null;
  /** The machine-readable classification (see {@link GiveBackSessionVerdict}). */
  verdict: GiveBackSessionVerdict;
  firstTs: number;
  lastTs: number;
  records: number;
}

/** TRA-1681 — is anything this module reports actually ON DISK? Read `ephemeral` FIRST. */
export interface GiveBackArmFloorDurability {
  /** Resolved append target. `null` = memory-only: no boot hydrate ran, NOTHING is durable. */
  dataDir: string | null;
  /**
   * TRUE ⇒ every outcome in this payload dies on the next redeploy — the recoverability
   * this ledger exists to provide is VOID and it is no better than the in-memory state.
   * A property of the PATH, so it is decisive on the very first boot before any row
   * exists (unlike `hydratedRecords`, which cannot tell a fresh persistent disk from a
   * wiped ephemeral one). The fix is `DATA_DIR=/data` on bqb1 (TRA-1719), not code.
   */
  ephemeral: boolean;
  /** Records recovered FROM DISK at boot. Distinguishes a real floor from this-uptime-only. */
  hydratedRecords: number;
  /** Distinct ET days recovered FROM DISK at boot. */
  hydratedDays: number;
  /** Appends that threw and were SWALLOWED. > 0 ⇒ the outcomes above overstate disk. */
  appendErrors: number;
  /** Message from the most recent swallowed append (null when none). */
  lastAppendError: string | null;
}

export interface GiveBackArmFloorSummary {
  /** Every retained book-session, most recent first. */
  sessions: GiveBackSessionSummary[];
  /** Distinct book-sessions with a recorded give-back outcome (feeds the ≥5 gate). */
  sessionsObserved: number;
  /**
   * The TRA-1592 PRIMARY-AC tripwire: sub-floor-peak days that give-back halted. > 0 is
   * an INVALIDATION — the arm floor let a tiny-peak day latch a whole-session halt.
   */
  invalidations: number;
  /** Per-verdict session counts. */
  verdictCounts: Record<GiveBackSessionVerdict, number>;
  /** How many days back the ledger retains. A read gap wider than this can miss a session. */
  retentionDays: number;
  /** TRA-1681 — whether ANY of the above survives a reboot. Check BEFORE trusting a count. */
  durability: GiveBackArmFloorDurability;
  /** ms epoch of the last recorded snapshot (null if none yet). */
  lastRecordAt: number | null;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function classify(o: SessionOutcome): GiveBackSessionVerdict {
  if (o.haltLatched && o.haltReason === 'giveback_cap') {
    return o.armFloorCleared ? 'giveback_halt_above_floor' : 'giveback_halt_sub_floor';
  }
  if (o.haltLatched && o.haltReason === 'session_net_negative') return 'session_stop';
  return o.armFloorCleared ? 'clean_above_floor' : 'clean_sub_floor';
}

function toSummary(o: SessionOutcome): GiveBackSessionSummary {
  const peak = Math.max(0, o.peakPnl);
  // For a halted session the give-back is measured at the halt transition; otherwise
  // it is the last observed drawdown from peak. `null` when there was no positive peak.
  const refPnl = o.haltLatched && o.pnlAtHalt !== null ? o.pnlAtHalt : o.lastPnl;
  const giveBackPct = peak > 0 ? round((peak - refPnl) / peak, 4) : null;
  return {
    sessionDate: o.sessionDate,
    mode: o.mode,
    engineId: o.engineId,
    peakPnl: round(o.peakPnl),
    lastPnl: round(o.lastPnl),
    giveBackArmFloor: round(o.giveBackArmFloor),
    retainedFloor: round(peak * (1 - o.giveBackCapPct)),
    giveBackCapPct: o.giveBackCapPct,
    armFloorCleared: o.armFloorCleared,
    haltLatched: o.haltLatched,
    haltReason: o.haltReason,
    giveBackPct,
    verdict: classify(o),
    firstTs: o.firstTs,
    lastTs: o.lastTs,
    records: o.records,
  };
}

/**
 * Fold the store into the read-only give-back forward-test diagnostics. Pure — no IO.
 * Sessions are returned most-recent first across ALL retained days so a catch-up read
 * after a missed live fire recovers the whole accrual window at once.
 *
 * Read `durability.ephemeral` FIRST: if true, every session below is wiped at the next
 * reboot and this ledger has not actually made the outcome recoverable (TRA-1719).
 */
export function summarizeGiveBackArmFloor(): GiveBackArmFloorSummary {
  const sessions: GiveBackSessionSummary[] = [];
  const verdictCounts: Record<GiveBackSessionVerdict, number> = {
    giveback_halt_sub_floor: 0,
    giveback_halt_above_floor: 0,
    session_stop: 0,
    clean_sub_floor: 0,
    clean_above_floor: 0,
  };
  for (const day of byDay.values()) {
    for (const o of day.values()) {
      const s = toSummary(o);
      sessions.push(s);
      verdictCounts[s.verdict] += 1;
    }
  }
  sessions.sort((a, b) => b.lastTs - a.lastTs);
  return {
    sessions,
    sessionsObserved: sessions.length,
    invalidations: verdictCounts.giveback_halt_sub_floor,
    verdictCounts,
    retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
    durability: {
      dataDir,
      ephemeral: isEphemeralDataDir(dataDir),
      hydratedRecords,
      hydratedDays,
      appendErrors,
      lastAppendError,
    },
    lastRecordAt,
  };
}
