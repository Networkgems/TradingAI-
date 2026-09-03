// TRA-1481 (parent TRA-1408) — deterministic, in-memory telemetry for the
// per-name churn + same-day-loss brake.
//
// QuantTrader's post-close forward-validation (bqb1 build aabcfc8a) could only
// INFER the brake state from desk churn — two full demo sessions before the
// finding could be called ("armed-but-inert"). This module is the deterministic
// surface `GET /api/health/churn-brake` folds so the brake's behaviour is
// observable in one read instead of reconstructed from `/api/reports/desk`:
//
//   • per-symbol NEW-open counters for the current ET session (mirrors the
//     signal-engine's `churnOpensToday`, written from the SAME `recordChurnOpen`
//     chokepoint so the two never diverge);
//   • the count of opens the same-session cap actually REJECTED (the Nth+1 open
//     that was refused) — the direct evidence the cap is enforcing;
//   • the count of conviction-DCA adds the same-day-loss rule HALTED, split by
//     equity vs option leg.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only accounting. It NEVER places an order or mutates an account; the
// engine calls in ONLY on the demo chokepoints (the record/reject/halt helpers
// are no-ops on the live path), so every counter here reflects the DEMO book.
//
// In-memory + monotonic-since-boot for the ORIGINAL counters: the per-symbol open
// counts are per-ET-session by construction (they roll at the ET-day boundary,
// exactly like the engine counter they mirror), and the reject/halt totals are
// since-boot — the same reset-on-reboot contract as `/api/health/live-equity`.
// The premise "a validation run reads them within a session" did not survive
// contact with the reboot schedule: on 2026-09-03 the daily journal review fired
// 1.3h after a post-close boot and read `opensRejected: 0` — byte-identical
// whether the brake was enforcing perfectly or completely dark (TRA-4335 defect 1).
// The since-boot counters stay byte-compatible; the DURABLE guard section below
// (`churn-brake-guard.jsonl` + boot hydrate, the conviction-dca-guard/TRA-2598
// pattern) is what a multi-session read grades instead.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'churn-brake-ledger' });

/** Which conviction-DCA leg the same-day-loss rule halted. */
export type ChurnDcaLeg = 'equity' | 'option';

/** A per-symbol NEW-open counter scoped to one ET session. */
interface EtDayCount {
  etDay: string;
  count: number;
}

/** One reject/halt event for the rolling debug tail. */
export interface ChurnBrakeEvent {
  ts: number;
  kind: 'open_rejected' | 'dca_halted';
  symbol: string;
  /** For open_rejected: `${count}/${cap}` at the reject. For dca_halted: the ET-day net. */
  detail: string;
  /** DCA leg, only on dca_halted events. */
  leg?: ChurnDcaLeg;
}

/** Rolling recent-events retention for the health tail (counts stay complete). */
const MAX_RECENT_EVENTS = 50;
/** Top-N symbols surfaced in the per-symbol open/reject views (counts stay complete internally). */
const TOP_SYMBOLS = 25;

// ── Module-global store (backs GET /api/health/churn-brake) ──────────────────
let opensRejectedTotal = 0;
let dcaHaltedEquity = 0;
let dcaHaltedOption = 0;
let lastOpenRejectAt: number | null = null;
let lastDcaHaltAt: number | null = null;
const opensBySymbol = new Map<string, EtDayCount>();
const rejectsBySymbol = new Map<string, number>();
const haltsBySymbol = new Map<string, number>();
const recentEvents: ChurnBrakeEvent[] = [];

/** Test seam — drop every counter and event (the durable guard section included). */
export function clearChurnBrakeLedger(): void {
  opensRejectedTotal = 0;
  dcaHaltedEquity = 0;
  dcaHaltedOption = 0;
  lastOpenRejectAt = null;
  lastDcaHaltAt = null;
  opensBySymbol.clear();
  rejectsBySymbol.clear();
  haltsBySymbol.clear();
  recentEvents.length = 0;
  clearChurnBrakeGuardLedger();
}

function normSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function pushEvent(ev: ChurnBrakeEvent): void {
  recentEvents.push(ev);
  while (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
}

/**
 * Mirror one recorded DEMO NEW-open against the per-name session counter. Called
 * from the SAME `recordChurnOpen` chokepoint the engine's own `churnOpensToday`
 * feeds, so this surface and the enforcement counter can never drift. Resets a
 * symbol's count at the ET-day roll (same-session semantics).
 */
export function recordChurnBrakeOpen(symbol: string, etDay: string): void {
  const sym = normSymbol(symbol);
  const rec = opensBySymbol.get(sym);
  const count = rec && rec.etDay === etDay ? rec.count : 0;
  opensBySymbol.set(sym, { etDay, count: count + 1 });
}

/**
 * Record one NEW open REJECTED by the same-session cap (the Nth+1 open refused).
 * `count`/`cap` are the verdict values at the reject. Monotonic since boot.
 */
export function recordChurnBrakeOpenRejected(
  symbol: string,
  count: number,
  cap: number,
  now: number = Date.now(),
): void {
  const sym = normSymbol(symbol);
  opensRejectedTotal += 1;
  rejectsBySymbol.set(sym, (rejectsBySymbol.get(sym) ?? 0) + 1);
  lastOpenRejectAt = now;
  pushEvent({ ts: now, kind: 'open_rejected', symbol: sym, detail: `${count}/${cap}` });
}

/**
 * Record one conviction-DCA add HALTED by the same-day-loss rule. `leg` splits
 * equity vs option; `netEtDay` is the name's realized+unrealized net at the halt.
 * Monotonic since boot.
 */
export function recordChurnBrakeDcaHalt(
  symbol: string,
  leg: ChurnDcaLeg,
  netEtDay: number,
  now: number = Date.now(),
): void {
  const sym = normSymbol(symbol);
  if (leg === 'equity') dcaHaltedEquity += 1;
  else dcaHaltedOption += 1;
  haltsBySymbol.set(sym, (haltsBySymbol.get(sym) ?? 0) + 1);
  lastDcaHaltAt = now;
  pushEvent({ ts: now, kind: 'dca_halted', symbol: sym, detail: netEtDay.toFixed(2), leg });
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface ChurnBrakeSymbolOpens {
  symbol: string;
  etDay: string;
  count: number;
}

export interface ChurnBrakeSymbolCount {
  symbol: string;
  count: number;
}

export interface ChurnBrakeSummary {
  /** Total opens the same-session cap rejected (since boot). */
  opensRejected: number;
  /** Per-symbol rejections, most-rejected first (top N). */
  opensRejectedBySymbol: ChurnBrakeSymbolCount[];
  /** Total conviction-DCA adds the same-day-loss rule halted (since boot). */
  dcaAddsHalted: number;
  /** Halt split by leg. */
  dcaAddsHaltedByLeg: { equity: number; option: number };
  /** Distinct symbols currently tracked with ≥1 recorded open. */
  trackedSymbols: number;
  /** Per-symbol current-session open counters, busiest first (top N). */
  openCountsBySymbol: ChurnBrakeSymbolOpens[];
  /** ms epoch of the last reject / halt (null if none yet). */
  lastOpenRejectAt: number | null;
  lastDcaHaltAt: number | null;
  /** Most-recent reject/halt events, oldest→newest (capped tail). */
  recent: ChurnBrakeEvent[];
}

/** Fold the store into the read-only health diagnostics. Pure — no IO. */
export function summarizeChurnBrake(): ChurnBrakeSummary {
  const openCounts = [...opensBySymbol.entries()]
    .map(([symbol, rec]) => ({ symbol, etDay: rec.etDay, count: rec.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_SYMBOLS);
  const rejects = [...rejectsBySymbol.entries()]
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_SYMBOLS);
  return {
    opensRejected: opensRejectedTotal,
    opensRejectedBySymbol: rejects,
    dcaAddsHalted: dcaHaltedEquity + dcaHaltedOption,
    dcaAddsHaltedByLeg: { equity: dcaHaltedEquity, option: dcaHaltedOption },
    trackedSymbols: opensBySymbol.size,
    openCountsBySymbol: openCounts,
    lastOpenRejectAt,
    lastDcaHaltAt,
    recent: recentEvents.slice(-MAX_RECENT_EVENTS),
  };
}

// ── TRA-4335 defect 1: the DURABLE open-cap guard ledger ─────────────────────
//
// The since-boot counters above evaporate on every deploy/reboot, so the fire
// that reads them post-boot sees `opensRejected: 0` whether the cap is enforcing
// or dark — the reviewer had to INFER enforcement from the shape of the journal's
// open distribution instead of reading it. This section is the same fix the DCA
// half already got (TRA-2598, `conviction-dca-guard.jsonl`), in the retained
// per-ET-day shape `cost-aware-gate` publishes (TRA-1602/TRA-1703):
//
//   • ONE guard event per {@link recordChurnBrakeGuardEvent} call — written at
//     the single `churnOpenCapVerdict` chokepoint on EVERY branch (dark, passed,
//     rejected), so the counts are a true denominator, not a record of hits:
//
//       presented 0                            → no demo open candidate reached the cap
//       presented N, evaluated 0               → the brake is DARK (flag off)
//       presented N, evaluated N, rejected 0   → the cap RAN N times, nothing tripped
//       rejected > 0                           → the cap is actively refusing opens
//
//   • JSONL-appended under DATA_DIR, rebuilt on boot, compacted to the retention
//     window — a restart must NOT zero these counters (the whole point).
//   • Memory holds per-ET-day AGGREGATES only, never the raw event list, so a
//     busy window cannot grow the process; the file is bounded by compaction.
//
// STRICTLY OBSERVE-ONLY: recording an event never changes the cap's verdict.

export const CHURN_BRAKE_GUARD_LOG_FILENAME = 'churn-brake-guard.jsonl';

/**
 * Retain this many ms of guard events on disk (compacted on boot). 30 days covers
 * the multi-session enforcement grades the daily journal review runs (the 29-session
 * truncation-at-cap read that had to be re-derived by hand on TRA-4332), and the
 * event volume — one line per demo open attempt that reaches a chokepoint — is well
 * under the cost-aware-gate ledger's per-candidate volume at its 7-day window.
 */
const GUARD_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
const GUARD_RETENTION_DAYS = 30;

/**
 * One demo NEW-open candidate as seen by the TRA-1408 per-name same-session cap.
 * Written on EVERY branch of `churnOpenCapVerdict` (never on the live path, which
 * is a structural no-op there).
 */
export interface ChurnBrakeGuardEvent {
  /** Evaluation time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the fold rolls on. */
  etDay: string;
  symbol: string;
  /**
   * Was `ENABLE_CHURN_LOSS_BRAKE` on for this candidate? `false` ⇒ the cap did NOT
   * run: the candidate counts toward `opensPresented` but not `opensEvaluated`.
   * This is the field that turns "0 rejects" from ambiguous into diagnosable.
   */
  guardEnabled: boolean;
  /** Did the cap refuse the open? Only ever true when `guardEnabled`. */
  blocked: boolean;
  /** The count/cap at the verdict; absent when dark (never computed). */
  count?: number;
  cap?: number;
}

/** Per-ET-day aggregate. `opensRejected ≤ opensEvaluated ≤ opensPresented` always. */
interface GuardDayTally {
  presented: number;
  evaluated: number;
  rejected: number;
  rejectsBySymbol: Map<string, number>;
  firstAt: number | null;
  lastAt: number | null;
}

/**
 * The named verdict a bare zero could not express. Derived, never stored — so it
 * can never disagree with the counters beside it. Same union as the DCA guard's.
 */
export type ChurnBrakeGuardState =
  /** No demo open candidate has reached the cap in the retained window. */
  | 'no_candidates'
  /** Candidates presented but the flag was off for all of them: the brake is DARK. */
  | 'dark'
  /** The cap ran on every candidate and refused none. */
  | 'live_clean'
  /** The cap refused at least one open. */
  | 'live_firing'
  /** Some candidates were evaluated and some were not (the flag flipped mid-window). */
  | 'mixed';

// ── Guard store (per-day aggregates + durability provenance) ─────────────────
let guardDataDir: string | null = null;
/** etDay → aggregate. */
const guardByDay = new Map<string, GuardDayTally>();
/** TRA-1681-style durability provenance — see {@link ChurnBrakeGuardDurability}. */
let guardHydratedRecords = 0;
let guardHydratedDays = 0;
let guardAppendErrors = 0;
let guardLastAppendError: string | null = null;

export function churnBrakeGuardLogPath(dir: string): string {
  return join(dir, CHURN_BRAKE_GUARD_LOG_FILENAME);
}

/** Test seam — drop the guard counters and the configured dir. */
export function clearChurnBrakeGuardLedger(): void {
  guardDataDir = null;
  guardByDay.clear();
  guardHydratedRecords = 0;
  guardHydratedDays = 0;
  guardAppendErrors = 0;
  guardLastAppendError = null;
}

function guardDayTally(etDay: string): GuardDayTally {
  let t = guardByDay.get(etDay);
  if (!t) {
    t = { presented: 0, evaluated: 0, rejected: 0, rejectsBySymbol: new Map(), firstAt: null, lastAt: null };
    guardByDay.set(etDay, t);
  }
  return t;
}

/** Apply one guard event to the per-day aggregates (shared by record + hydrate). */
function applyGuardEvent(ev: ChurnBrakeGuardEvent): void {
  const t = guardDayTally(ev.etDay);
  t.presented += 1;
  if (ev.guardEnabled) t.evaluated += 1;
  // A halt is only meaningful as a subset of the evaluated population (the
  // TRA-2598 rule): a malformed line claiming `blocked` while dark must not be
  // able to break `rejected ≤ evaluated`.
  if (ev.guardEnabled && ev.blocked) {
    t.rejected += 1;
    const sym = normSymbol(ev.symbol);
    t.rejectsBySymbol.set(sym, (t.rejectsBySymbol.get(sym) ?? 0) + 1);
  }
  if (t.firstAt === null || ev.ts < t.firstAt) t.firstAt = ev.ts;
  if (t.lastAt === null || ev.ts > t.lastAt) t.lastAt = ev.ts;
}

/**
 * Record one open-cap guard event and append one JSONL line under the configured
 * DATA_DIR. Best-effort on IO — a write failure logs, is swallowed (accounting must
 * never break a trade pass) and is COUNTED in `durability.appendErrors`, so a lost
 * row cannot read identically to a written one. When no dataDir is configured
 * (unit tests / CLI without boot) the in-memory aggregates still update.
 */
export function recordChurnBrakeGuardEvent(ev: ChurnBrakeGuardEvent): void {
  applyGuardEvent(ev);
  if (guardDataDir == null) return;
  const path = churnBrakeGuardLogPath(guardDataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(ev) + '\n', 'utf8');
  } catch (err) {
    guardAppendErrors += 1;
    guardLastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('churn-brake guard append failed', { reason: guardLastAppendError });
  }
}

/** What {@link hydrateChurnBrakeGuardFromDisk} recovered (for the boot log line). */
export interface ChurnBrakeGuardHydration {
  days: number;
  records: number;
}

/**
 * Rebuild the per-day guard aggregates from disk on boot and remember `dir` for
 * subsequent appends. Idempotent (clears first). Only records within
 * {@link GUARD_RETAIN_MS} of `now` are kept, and the file is COMPACTED to exactly
 * those lines. Best-effort: a missing/corrupt file yields an empty hydration; a
 * torn trailing line is skipped rather than throwing.
 */
export function hydrateChurnBrakeGuardFromDisk(
  dir: string,
  now: number = Date.now(),
): ChurnBrakeGuardHydration {
  clearChurnBrakeGuardLedger();
  guardDataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(churnBrakeGuardLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - GUARD_RETAIN_MS;
  const kept: string[] = [];
  let records = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: ChurnBrakeGuardEvent;
    try {
      rec = JSON.parse(trimmed) as ChurnBrakeGuardEvent;
    } catch {
      continue; // skip a torn/partial line rather than abort the hydrate
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (typeof rec.symbol !== 'string' || rec.symbol === '') continue;
    if (typeof rec.guardEnabled !== 'boolean') continue;
    const clean: ChurnBrakeGuardEvent = {
      ts: rec.ts,
      etDay: rec.etDay,
      symbol: rec.symbol,
      guardEnabled: rec.guardEnabled,
      blocked: rec.blocked === true,
      ...(Number.isFinite(rec.count) ? { count: rec.count as number } : {}),
      ...(Number.isFinite(rec.cap) ? { cap: rec.cap as number } : {}),
    };
    applyGuardEvent(clean);
    kept.push(JSON.stringify(clean));
    records += 1;
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped
  // when nothing was dropped, to avoid a needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = churnBrakeGuardLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('churn-brake guard compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  guardHydratedRecords = records;
  guardHydratedDays = guardByDay.size;
  return { days: guardByDay.size, records };
}

// ── Guard health summary ─────────────────────────────────────────────────────

export interface ChurnBrakeGuardDaySummary {
  etDay: string;
  opensPresented: number;
  opensEvaluated: number;
  opensRejected: number;
  /** Per-symbol rejects for this day, most-rejected first (top N). */
  rejectsBySymbol: ChurnBrakeSymbolCount[];
}

/**
 * TRA-1681-style durability provenance. `retained` non-empty is NOT proof anything
 * reached disk: this uptime's own in-memory events populate it identically. Read
 * `ephemeral === false` first, then `appendErrors === 0`.
 */
export interface ChurnBrakeGuardDurability {
  /** Resolved append target. `null` = memory-only: no boot hydrate ran, NOTHING is durable. */
  dataDir: string | null;
  /** TRUE ⇒ every retained count dies on the next redeploy. */
  ephemeral: boolean;
  /** Records recovered FROM DISK at boot — a real floor vs this-uptime-only. */
  hydratedRecords: number;
  hydratedDays: number;
  /** Appends that threw and were swallowed. > 0 ⇒ the counters overstate the disk. */
  appendErrors: number;
  lastAppendError: string | null;
}

export interface ChurnBrakeGuardSummary {
  /** The named verdict — see {@link ChurnBrakeGuardState}. */
  state: ChurnBrakeGuardState;
  /** Candidates that reached the cap chokepoint across the retained window. */
  opensPresented: number;
  /** Candidates the cap actually ran on (flag armed). */
  opensEvaluated: number;
  /** Candidates the cap refused. */
  opensRejected: number;
  /** Every ET day still retained, ascending. */
  etDays: string[];
  /** How many days back the ledger retains — a read gap wider than this can miss a reject. */
  retentionDays: number;
  /** Per-day fold, ascending by ET day. */
  byEtDay: ChurnBrakeGuardDaySummary[];
  /** ms epoch of the newest retained guard event / reject (null when none). */
  lastEvaluatedAt: number | null;
  lastRejectedAt: number | null;
  durability: ChurnBrakeGuardDurability;
  note: string;
}

/** Fold the guard store into the read-only health diagnostics. Pure — no IO. */
export function summarizeChurnBrakeGuard(): ChurnBrakeGuardSummary {
  let presented = 0;
  let evaluated = 0;
  let rejected = 0;
  let lastEvaluatedAt: number | null = null;
  let lastRejectedAt: number | null = null;
  const etDays = [...guardByDay.keys()].sort();
  const byEtDay: ChurnBrakeGuardDaySummary[] = [];
  for (const etDay of etDays) {
    const t = guardByDay.get(etDay)!;
    presented += t.presented;
    evaluated += t.evaluated;
    rejected += t.rejected;
    if (t.lastAt !== null && (lastEvaluatedAt === null || t.lastAt > lastEvaluatedAt)) {
      lastEvaluatedAt = t.lastAt;
    }
    if (t.rejected > 0 && t.lastAt !== null && (lastRejectedAt === null || t.lastAt > lastRejectedAt)) {
      // Day-granular: the aggregate does not keep a per-event reject stamp, and a
      // day-resolution "when did it last bite" is what the daily review reads.
      lastRejectedAt = t.lastAt;
    }
    byEtDay.push({
      etDay,
      opensPresented: t.presented,
      opensEvaluated: t.evaluated,
      opensRejected: t.rejected,
      rejectsBySymbol: [...t.rejectsBySymbol.entries()]
        .map(([symbol, count]) => ({ symbol, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_SYMBOLS),
    });
  }
  const state: ChurnBrakeGuardState =
    presented === 0
      ? 'no_candidates'
      : evaluated === 0
        ? 'dark'
        : rejected > 0
          ? 'live_firing'
          : evaluated < presented
            ? 'mixed'
            : 'live_clean';
  return {
    state,
    opensPresented: presented,
    opensEvaluated: evaluated,
    opensRejected: rejected,
    etDays,
    retentionDays: GUARD_RETENTION_DAYS,
    byEtDay,
    lastEvaluatedAt,
    lastRejectedAt,
    durability: {
      dataDir: guardDataDir,
      ephemeral: guardDataDir === null ? true : isEphemeralDataDir(guardDataDir),
      hydratedRecords: guardHydratedRecords,
      hydratedDays: guardHydratedDays,
      appendErrors: guardAppendErrors,
      lastAppendError: guardLastAppendError,
    },
    note:
      'TRA-4335 — durable per-ET-day open-cap guard counters (restart-safe, unlike the '
      + 'since-boot fields beside this block). state=dark means candidates arrived while '
      + 'ENABLE_CHURN_LOSS_BRAKE was off; live_clean means the cap ran and refused nothing.',
  };
}
