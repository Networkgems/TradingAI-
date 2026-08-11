// TRA-3218 (parent TRA-2760) — DURABLE per-session record of the options-sleeve
// breaker's state, so the sleeve halt survives a process restart in BOTH
// directions.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `OptionsRiskBreaker` is in-memory. bqb1 reboots nightly (~04:30Z) and
// mid-session on deploys/crashes/watchdog restarts. Without a durable copy:
//   • a LATCHED sleeve halt is silently CLEARED by the reboot — exactly the
//     "accidental halt-clearing mechanism" TRA-3218 forbids the cooldown re-arm
//     from becoming, already live today via pm2 restart;
//   • the tallies (`cumulativeR`, `dailyPnl`) are ZEROED, so a sleeve that bled
//     −1.9R reboots as a calm one and can bleed another full −2R before its own
//     breaker ever trips.
// The equity governor closed the same hole with `seedBookPeak` off the
// give-back ledger (TRA-2110); this ledger is the sleeve-breaker counterpart,
// persisting the FULL daily state (not just a peak) because the breaker's trip
// is cumulative rather than peak-relative.
//
// ── THE DURABILITY CAVEAT (TRA-1681 / TRA-1719) ──────────────────────────────
// Durable ONLY when DATA_DIR is a mounted persistent disk. On an ephemeral path
// every byte dies at the same reboot that wipes the memory it was meant to
// outlast — no error is raised. `durability.ephemeral` (a property of the PATH,
// decisive before any row exists) is published in the summary and the boot seed
// is GATED on it being false: never re-latch (or fail to re-latch) a
// real-capital halt off a ledger that is no better than memory.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-and-restore only. NEVER places an order or changes a decision the
// breaker didn't already make. Keyed per (mode, engineId, etDay) — SPLIT per
// book (TRA-1834). No PII/balances: sleeve-level P&L, R tallies, and halt
// metadata, the same data the halt-reason string already carries.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { OptionsBreakerPersistedState } from '@trading-app/engine';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'options-breaker-ledger' });

export const OPTIONS_BREAKER_LOG_FILENAME = 'options-breaker.jsonl';

/** Retention window — parity with the give-back ledger's 30 days. */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/** One durable JSONL line — the breaker's full daily state tagged with book + time. */
interface BreakerRecord extends OptionsBreakerPersistedState {
  /** Snapshot time, ms epoch. */
  ts: number;
  mode: 'demo' | 'live';
  /** Stable per-engine id (SignalEngine.feedContextKey) — SPLIT per book (TRA-1834). */
  engineId: string;
}

let dataDir: string | null = null;
/** `${day}::${mode}::${engineId}` -> latest record for that book-session. */
const latestByKey = new Map<string, BreakerRecord>();
let lastRecordAt: number | null = null;
/** Throttle: last durably-written signature per book-session (bounds hot-path writes). */
const lastWrittenSig = new Map<string, string>();
let hydratedRecords = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;

export function optionsBreakerLogPath(dir: string): string {
  return join(dir, OPTIONS_BREAKER_LOG_FILENAME);
}

function key(day: string, mode: string, engineId: string): string {
  return `${day}::${mode}::${engineId}`;
}

/** The write throttle's materiality signature: a close, a latch, or a release. */
function sig(rec: BreakerRecord): string {
  return `${rec.closes}|${rec.halted ? 1 : 0}|${rec.haltsToday}|${rec.releasesToday}`;
}

/** Test seam — drop every counter and the configured dir. */
export function clearOptionsBreakerLedger(): void {
  dataDir = null;
  latestByKey.clear();
  lastWrittenSig.clear();
  lastRecordAt = null;
  hydratedRecords = 0;
  appendErrors = 0;
  lastAppendError = null;
}

function fold(rec: BreakerRecord): void {
  const k = key(rec.day, rec.mode, rec.engineId);
  const prev = latestByKey.get(k);
  if (!prev || rec.ts >= prev.ts) latestByKey.set(k, rec);
  if (lastRecordAt === null || rec.ts > lastRecordAt) lastRecordAt = rec.ts;
}

/**
 * Record the breaker's exported state after a close / latch / release. The
 * in-memory fold always updates; the disk append is throttled to material
 * transitions (a new close, a latch, a release). Best-effort on IO — a failure
 * is logged, COUNTED, and swallowed so accounting can never break a trade pass.
 */
export function recordOptionsBreakerState(
  mode: 'demo' | 'live',
  engineId: string,
  state: OptionsBreakerPersistedState,
  now: number = Date.now(),
): void {
  // A pristine day (no closes, no halt) has nothing to restore — skip entirely
  // so idle engines don't write a line per boot.
  if (state.closes <= 0 && !state.halted && state.haltsToday <= 0) return;

  const rec: BreakerRecord = { ...state, ts: now, mode, engineId };
  fold(rec);
  if (dataDir == null) return;

  const k = key(rec.day, mode, engineId);
  const s = sig(rec);
  if (lastWrittenSig.get(k) === s) return;
  lastWrittenSig.set(k, s);

  const path = optionsBreakerLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('options-breaker ledger append failed', { reason: lastAppendError });
  }
}

/**
 * Rebuild the in-memory fold from disk on boot and pin `dir` for subsequent
 * appends. Idempotent (clears first). Records older than the retention window
 * are dropped and the file compacted. A torn/corrupt line is skipped rather
 * than aborting the hydrate.
 */
export function hydrateOptionsBreakerLedgerFromDisk(
  dir: string,
  now: number = Date.now(),
): { records: number; sessions: number } {
  clearOptionsBreakerLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(optionsBreakerLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: BreakerRecord;
    try {
      rec = JSON.parse(trimmed) as BreakerRecord;
    } catch {
      continue;
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.day !== 'string' || rec.day === '') continue;
    if (rec.mode !== 'demo' && rec.mode !== 'live') continue;
    if (typeof rec.engineId !== 'string' || rec.engineId === '') continue;
    fold(rec);
    kept.push(JSON.stringify(rec));
    lastWrittenSig.set(key(rec.day, rec.mode, rec.engineId), sig(rec));
  }

  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = optionsBreakerLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('options-breaker ledger compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hydratedRecords = kept.length;
  return { records: kept.length, sessions: latestByKey.size };
}

/**
 * The persisted breaker state for one book's ET session, or null when none is
 * on record. The boot seed hands this straight to
 * `OptionsRiskBreaker.restoreState`, which itself refuses a stale day or a
 * post-activity restore — this read does not need to re-check either.
 */
export function getOptionsBreakerRestoreState(
  mode: 'demo' | 'live',
  engineId: string,
  etDay: string,
): OptionsBreakerPersistedState | null {
  const rec = latestByKey.get(key(etDay, mode, engineId));
  if (!rec) return null;
  const { ts: _ts, mode: _mode, engineId: _engineId, ...state } = rec;
  return state;
}

/** One book-session row for the health readout. */
export interface OptionsBreakerSessionSummary {
  sessionDate: string;
  mode: 'demo' | 'live';
  engineId: string;
  closes: number;
  cumulativeR: number;
  dailyPnl: number;
  halted: boolean;
  haltReason: string | null;
  haltAt: number | null;
  haltsToday: number;
  releasesToday: number;
  lastTs: number;
}

export interface OptionsBreakerLedgerSummary {
  /** Every retained book-session, most recent first. */
  sessions: OptionsBreakerSessionSummary[];
  sessionsObserved: number;
  /** Sessions that latched a sleeve halt at least once — the "count halted sessions" ask. */
  haltedSessions: number;
  /** Cooldown releases across the retained window (0 until the board arms the cooldown). */
  releasesTotal: number;
  /** TRA-1681 — whether ANY of the above survives a reboot. Read BEFORE trusting a count. */
  durability: {
    dataDir: string | null;
    ephemeral: boolean;
    hydratedRecords: number;
    appendErrors: number;
    lastAppendError: string | null;
  };
  lastRecordAt: number | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fold the store into the read-only health summary. Pure. */
export function summarizeOptionsBreakerLedger(): OptionsBreakerLedgerSummary {
  const sessions: OptionsBreakerSessionSummary[] = [];
  let haltedSessions = 0;
  let releasesTotal = 0;
  for (const rec of latestByKey.values()) {
    if (rec.haltsToday > 0 || rec.halted) haltedSessions += 1;
    releasesTotal += rec.releasesToday;
    sessions.push({
      sessionDate: rec.day,
      mode: rec.mode,
      engineId: rec.engineId,
      closes: rec.closes,
      cumulativeR: round2(rec.cumulativeR),
      dailyPnl: round2(rec.dailyPnl),
      halted: rec.halted,
      haltReason: rec.haltReason,
      haltAt: rec.haltAt,
      haltsToday: rec.haltsToday,
      releasesToday: rec.releasesToday,
      lastTs: rec.ts,
    });
  }
  sessions.sort((a, b) => b.lastTs - a.lastTs);
  return {
    sessions,
    sessionsObserved: sessions.length,
    haltedSessions,
    releasesTotal,
    durability: {
      dataDir,
      ephemeral: isEphemeralDataDir(dataDir),
      hydratedRecords,
      appendErrors,
      lastAppendError,
    },
    lastRecordAt,
  };
}
