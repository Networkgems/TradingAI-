// TRA-5269 (residual of TRA-2984) — a DURABLE, append-only record of every expired
// exit order. One JSONL line per event, never a gauge.
//
// TRA-2984's retry + MARKET-escalation shipped, but the evidence of HOW OFTEN exits
// expire was left on surfaces that forget: `expiredExits` is a since-boot counter
// (bqb1 boots ~6x a night) and `liveExitErrors` is derived from OPEN rows, so the
// moment the row closes — by a fill, a human on the broker, a reconstruction — every
// trace that an exit ever failed goes with it. An order that never fills appends no
// fee/slippage ledger row either. This file is the record that outlives the row.
//
// ── WHAT A BROKEN INSTANCE READS LIKE ────────────────────────────────────────
// An empty ledger is byte-identical whether nothing expired or the store cannot
// write. So every boot appends a `boot` marker line FIRST and the summary publishes
// `state`, which separates the cases by what was *measured*, not by emptiness:
//   • `unwritable`   — no DATA_DIR resolved, or an append threw. Nothing is recorded.
//   • `ephemeral`    — writes land, but on a path the next redeploy erases.
//   • `unproven`     — writable and persistent-looking, but no marker from an earlier
//                      boot survived to be read back yet (first boot on this disk).
//   • `durable`      — a marker written by a PREVIOUS process was read back from disk.
// Only `durable` makes `events: []` mean "nothing expired". `absent != 0`.
//
// ── WHEN THE POSITION CLOSES ─────────────────────────────────────────────────
// Nothing happens to the record. It is keyed by event, carries the option symbol and
// id for forensics, and is never read back into (or deleted with) the position row.

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'expired-exit-ledger' });

export const EXPIRED_EXIT_LEDGER_FILENAME = 'expired-exits.jsonl';

/** What the engine will do on the next attempt for this row. */
export type ExpiredExitNextAttempt = 'market_escalation' | 'staging_stopped';

export interface ExpiredExitEvent {
  type: 'expired_exit';
  ts: number;
  /** `live` | `demo` — the position's mode. */
  mode: 'live' | 'demo';
  /** Tradier environment of the owning account (`production` | `sandbox`), null if unset. */
  tradierEnv: string | null;
  optionId: string;
  optionSymbol: string;
  /** Exit intent kind: `tp1` / `sl` / `trail` / … — the pending intent that lapsed. */
  kind: string;
  qty: number;
  /** The limit price that failed to fill (null when the intent carried none). */
  limitPrice: number | null;
  /** `limit` | `market` — how the lapsed order was priced. */
  pricing: string | null;
  /** Broker order id of the lapsed order ('' when it never got one). */
  orderId: string;
  /** Consecutive-expiry count on the row AT this event (1-based). */
  consecutiveExpiries: number;
  /** `market_escalation` ⇒ the next stage goes at MARKET; `staging_stopped` ⇒ breaker latched. */
  nextAttempt: ExpiredExitNextAttempt;
}

interface BootMarker {
  type: 'boot';
  ts: number;
  pid: number;
}

/** In-memory tail cap; the file itself is never truncated. */
const MAX_RETAINED_EVENTS = 2000;
/** Events returned by default on the operator route. */
export const DEFAULT_READ_LIMIT = 200;

let dataDir: string | null = null;
let events: ExpiredExitEvent[] = [];
let totalEvents = 0;
let hydratedEvents = 0;
let hydratedBootMarkers = 0;
let writesThisBoot = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;
let bootMarkerWritten = false;
let bootAt: number | null = null;

export function expiredExitLedgerPath(dir: string): string {
  return join(dir, EXPIRED_EXIT_LEDGER_FILENAME);
}

/** Test seam. */
export function clearExpiredExitLedger(): void {
  dataDir = null;
  events = [];
  totalEvents = 0;
  hydratedEvents = 0;
  hydratedBootMarkers = 0;
  writesThisBoot = 0;
  appendErrors = 0;
  lastAppendError = null;
  bootMarkerWritten = false;
  bootAt = null;
}

function appendLine(obj: ExpiredExitEvent | BootMarker): boolean {
  if (dataDir == null) return false;
  const path = expiredExitLedgerPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(obj) + '\n', 'utf8');
    writesThisBoot += 1;
    return true;
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('expired-exit ledger append failed', { reason: lastAppendError });
    return false;
  }
}

function isEvent(v: unknown): v is ExpiredExitEvent {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.type === 'expired_exit'
    && typeof o.ts === 'number'
    && typeof o.optionSymbol === 'string'
    && typeof o.kind === 'string';
}

/**
 * Remember `dir`, rebuild the in-memory tail from disk and append this boot's marker.
 * Idempotent. Never compacts or deletes. A missing file / torn trailing line is an
 * empty or shorter hydration, not an error.
 */
export function hydrateExpiredExitLedgerFromDisk(
  dir: string,
  now: number = Date.now(),
): { events: number; bootMarkers: number } {
  clearExpiredExitLedger();
  dataDir = dir;
  bootAt = now;

  let raw = '';
  try {
    raw = readFileSync(expiredExitLedgerPath(dir), 'utf8');
  } catch {
    raw = '';
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t) as unknown;
      if (isEvent(v)) {
        totalEvents += 1;
        hydratedEvents += 1;
        events.push(v);
        if (events.length > MAX_RETAINED_EVENTS) events.shift();
      } else if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'boot') {
        hydratedBootMarkers += 1;
      }
    } catch {
      // torn / corrupt line — skip
    }
  }
  // Marker AFTER the read, so `hydratedBootMarkers` counts only PREVIOUS processes.
  bootMarkerWritten = appendLine({ type: 'boot', ts: now, pid: process.pid });
  return { events: hydratedEvents, bootMarkers: hydratedBootMarkers };
}

/** Append one expired-exit event. Best-effort on IO; failures are COUNTED, never thrown. */
export function recordExpiredExit(ev: Omit<ExpiredExitEvent, 'type'>): void {
  const full: ExpiredExitEvent = { type: 'expired_exit', ...ev };
  totalEvents += 1;
  events.push(full);
  if (events.length > MAX_RETAINED_EVENTS) events.shift();
  appendLine(full);
}

export type ExpiredExitLedgerState = 'unwritable' | 'ephemeral' | 'unproven' | 'durable';

export interface ExpiredExitLedgerDurability {
  state: ExpiredExitLedgerState;
  dataDir: string | null;
  ephemeral: boolean;
  /** This process's boot marker reached disk. */
  bootMarkerWritten: boolean;
  /** Boot markers written by EARLIER processes and read back now — the in-band durability proof. */
  priorBootMarkers: number;
  /** Expired-exit events recovered from disk at boot (written by earlier processes). */
  hydratedEvents: number;
  writesThisBoot: number;
  appendErrors: number;
  lastAppendError: string | null;
  bootAt: number | null;
}

function durability(): ExpiredExitLedgerDurability {
  const ephemeral = dataDir === null ? true : isEphemeralDataDir(dataDir);
  const state: ExpiredExitLedgerState =
    dataDir === null || !bootMarkerWritten || appendErrors > 0
      ? 'unwritable'
      : ephemeral
        ? 'ephemeral'
        : hydratedBootMarkers > 0
          ? 'durable'
          : 'unproven';
  return {
    state,
    dataDir,
    ephemeral,
    bootMarkerWritten,
    priorBootMarkers: hydratedBootMarkers,
    hydratedEvents,
    writesThisBoot,
    appendErrors,
    lastAppendError,
    bootAt,
  };
}

export interface ExpiredExitCounts {
  /** Events in the durable record (all boots, retained tail aside). */
  total: number;
  live: number;
  escalatedNext: number;
  stagingStopped: number;
  lastAt: number | null;
  /** Read this FIRST — `total: 0` only means "nothing expired" when this is `durable`. */
  state: ExpiredExitLedgerState;
}

/** Counts only — safe for the no-auth route (no OCC symbols, no reason text; TRA-2163). */
export function summarizeExpiredExitCounts(): ExpiredExitCounts {
  let live = 0;
  let escalatedNext = 0;
  let stagingStopped = 0;
  let lastAt: number | null = null;
  for (const e of events) {
    if (e.mode === 'live') live += 1;
    if (e.nextAttempt === 'market_escalation') escalatedNext += 1;
    else stagingStopped += 1;
    if (lastAt === null || e.ts > lastAt) lastAt = e.ts;
  }
  return { total: totalEvents, live, escalatedNext, stagingStopped, lastAt, state: durability().state };
}

export interface ExpiredExitLedgerView {
  counts: ExpiredExitCounts;
  durability: ExpiredExitLedgerDurability;
  /** Newest first. */
  events: ExpiredExitEvent[];
  retainedInMemory: number;
  note: string;
}

/** Operator view (authenticated route only — carries OCC symbols). */
export function readExpiredExitLedger(limit: number = DEFAULT_READ_LIMIT): ExpiredExitLedgerView {
  const n = Math.max(1, Math.min(MAX_RETAINED_EVENTS, Math.floor(limit)));
  return {
    counts: summarizeExpiredExitCounts(),
    durability: durability(),
    events: events.slice(-n).reverse(),
    retainedInMemory: events.length,
    note:
      'TRA-5269 — append-only, one row per expired exit, survives restarts AND the position closing. '
      + '`events: []` means "nothing expired" ONLY when durability.state === "durable"; '
      + 'unwritable/ephemeral/unproven all read as an empty list too.',
  };
}
