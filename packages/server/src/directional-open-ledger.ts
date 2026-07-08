// TRA-1486 (parent TRA-1476 → TRA-1471) — DURABLE per-name/ET-day open ledger +
// gate-reject telemetry for the demo directional "ignition" entry path.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The TRA-1476 quality gate armed on bqb1 (render.yaml
// ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE=1, price=10, $vol=300000, cap=2) and STILL
// leaked: 78 of 87 post-arm opens on 2026-07-08 landed on cap-violating names
// (RIVN 17, AMPG 13, ZETA 11, QQQ 10 …). Root cause of the per-name-cap miss (D2 on
// TRA-1486): the shared TRA-1408 per-name counter (`churnOpensToday`) is an IN-MEMORY
// Map that RESETS on every process reboot. bqb1 rebooted several times that session,
// so the count started from 0 each boot and never accumulated to the cap within a
// boot window — the cap check ran, but always saw count < 2.
//
// This module is the durable source of truth for the per-name/ET-day open count.
// Mirrors the TRA-1278 conviction-DCA + TRA-1300 scale-out JSONL/hydrate pattern:
//   • one JSONL line per recorded DEMO open under DATA_DIR, keyed by ET calendar day;
//   • counts rebuilt from disk on boot (survive restart — the cap sees the real
//     same-ET-day total after a mid-session reboot, not a reset 0);
//   • the file is COMPACTED on boot to a short retention window (the cap only ever
//     consults the CURRENT ET day, so a couple of days is enough) — unlike the
//     conviction-DCA ledger (which is promotion evidence and never rotates), demo
//     directional opens are frequent (~dozens/name/day), so an unbounded file would
//     grow without benefit.
//
// It also holds the since-boot gate-reject counters (by verdict code) that back
// `GET /api/health/directional-quality-gate`, so a future grade reads the gate's
// enforcement directly instead of inferring it from `/api/reports/desk`.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only accounting. NEVER places an order or mutates an account. The engine
// records here ONLY on the demo directional chokepoint (`recordDirectionalOpen` is
// called after a demo paper open; the live path never reaches it), so every counter
// reflects the DEMO book. No balances/PII — just symbol, ET day, and reject codes.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'directional-open-ledger' });

export const DIRECTIONAL_OPEN_LOG_FILENAME = 'directional-opens.jsonl';

/**
 * Retain this many ms of open records on disk (compacted on boot). The per-name cap
 * only ever consults the CURRENT ET day, so a 3-day window comfortably covers a
 * same-ET-day reboot (the AC's "≥1 mid-session reboot") while bounding the file.
 */
const RETAIN_MS = 3 * 24 * 60 * 60 * 1000;

/** One durable directional open record — a write-through of the open the engine just booked. */
interface DirectionalOpenRecord {
  /** Open time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the per-name cap rolls on. */
  etDay: string;
  /** Normalized underlier symbol. */
  symbol: string;
}

/** Reject verdict codes we count (mirrors {@link DirectionalQualityVerdict.code} minus `ok`). */
export type DirectionalRejectCode =
  | 'min_price'
  | 'min_dollar_volume'
  | 'insufficient_liquidity_samples'
  | 'per_name_cap';

// ── In-memory store (backs the durable count + the health endpoint) ──────────
//
// Module-global + observe-only. `dataDir` is set once at boot by
// hydrateDirectionalOpensFromDisk so the deep engine chokepoint can append without
// threading a path through the SignalEngine. Counts are keyed by ET day so a stale
// day is naturally ignored by a current-day read.

let dataDir: string | null = null;
/** etDay -> (symbol -> open count). */
const countsByDay = new Map<string, Map<string, number>>();
/** Since-boot reject counts by verdict code. */
const rejectsByCode = new Map<DirectionalRejectCode, number>();
let opensRecordedTotal = 0;
let lastOpenAt: number | null = null;
let lastRejectAt: number | null = null;

export function directionalOpenLogPath(dir: string): string {
  return join(dir, DIRECTIONAL_OPEN_LOG_FILENAME);
}

/** Test seam — drop every counter and the configured dir. */
export function clearDirectionalOpenLedger(): void {
  dataDir = null;
  countsByDay.clear();
  rejectsByCode.clear();
  opensRecordedTotal = 0;
  lastOpenAt = null;
  lastRejectAt = null;
}

function normSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function bump(etDay: string, symbol: string): void {
  let day = countsByDay.get(etDay);
  if (!day) {
    day = new Map();
    countsByDay.set(etDay, day);
  }
  day.set(symbol, (day.get(symbol) ?? 0) + 1);
}

/**
 * Durable per-name open count for `symbol` on `etDay` (0 when none). This is the
 * reboot-durable value the per-name cap consults — it reflects the real same-ET-day
 * total even after a mid-session restart.
 */
export function directionalOpensFor(symbol: string, etDay: string): number {
  return countsByDay.get(etDay)?.get(normSymbol(symbol)) ?? 0;
}

/**
 * Record one DEMO directional open against the durable per-name/ET-day count AND
 * append one JSONL line under the configured DATA_DIR. Best-effort on IO — a write
 * failure logs and is swallowed so this accounting can never break the trade pass.
 * When no dataDir is configured (unit tests / CLI without boot) the in-memory count
 * still updates; only the file write is skipped.
 */
export function recordDirectionalOpen(symbol: string, etDay: string, now: number = Date.now()): void {
  const sym = normSymbol(symbol);
  bump(etDay, sym);
  opensRecordedTotal += 1;
  lastOpenAt = now;
  if (dataDir == null) return;
  const path = directionalOpenLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    const rec: DirectionalOpenRecord = { ts: now, etDay, symbol: sym };
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('directional-open append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record one directional open REJECTED by the quality gate, by verdict code. Since
 * boot (resets on reboot — this is a within-session enforcement readout, not
 * promotion evidence). No file write; the durable artifact is the open ledger above.
 */
export function recordDirectionalGateReject(code: DirectionalRejectCode, now: number = Date.now()): void {
  rejectsByCode.set(code, (rejectsByCode.get(code) ?? 0) + 1);
  lastRejectAt = now;
}

/** What {@link hydrateDirectionalOpensFromDisk} recovered (for the boot log line). */
export interface DirectionalOpenHydration {
  /** Distinct ET days retained after compaction. */
  days: number;
  /** Total open records retained. */
  records: number;
}

/**
 * Rebuild the in-memory per-day counts from disk on boot and remember `dir` for
 * subsequent appends. Idempotent: CLEARS first, so it is safe to call exactly once at
 * startup before any live pass. Only records within {@link RETAIN_MS} of `now` are
 * kept, and the file is COMPACTED to exactly those lines (bounding growth). Best-
 * effort: a missing/corrupt file yields an empty hydration; a torn trailing line is
 * skipped rather than throwing.
 */
export function hydrateDirectionalOpensFromDisk(dir: string, now: number = Date.now()): DirectionalOpenHydration {
  clearDirectionalOpenLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(directionalOpenLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  let records = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const rec = JSON.parse(trimmed) as DirectionalOpenRecord;
      if (
        typeof rec.ts === 'number'
        && Number.isFinite(rec.ts)
        && rec.ts >= cutoff
        && typeof rec.etDay === 'string'
        && typeof rec.symbol === 'string'
        && rec.symbol.trim() !== ''
      ) {
        bump(rec.etDay, normSymbol(rec.symbol));
        kept.push(JSON.stringify({ ts: rec.ts, etDay: rec.etDay, symbol: normSymbol(rec.symbol) }));
        records += 1;
      }
    } catch {
      // skip a torn/partial line rather than abort the hydrate
    }
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped when
  // there is nothing to drop (kept count matches the non-empty lines) to avoid a
  // needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = directionalOpenLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('directional-open compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { days: countsByDay.size, records };
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface DirectionalOpenSymbolCount {
  symbol: string;
  count: number;
}

export interface DirectionalGateSummary {
  /** Total DEMO directional opens recorded since boot (across all retained days). */
  opensRecorded: number;
  /** Per-name open counts for the requested ET day, busiest first. */
  openCountsBySymbol: DirectionalOpenSymbolCount[];
  /** Since-boot rejects keyed by verdict code (only non-zero codes present). */
  opensRejectedByCode: Record<string, number>;
  /** Total rejects across all codes (since boot). */
  opensRejectedTotal: number;
  /** Distinct names with ≥1 recorded open on the requested ET day. */
  trackedSymbols: number;
  /** ms epoch of the last recorded open / reject (null if none yet). */
  lastOpenAt: number | null;
  lastRejectAt: number | null;
}

/** Top-N symbols surfaced in the per-name view (counts stay complete internally). */
const TOP_SYMBOLS = 25;

/**
 * Fold the store into the read-only health diagnostics for `etDay` (the current ET
 * day at the caller). Pure — no IO.
 */
export function summarizeDirectionalGate(etDay: string): DirectionalGateSummary {
  const day = countsByDay.get(etDay);
  const openCounts = day
    ? [...day.entries()]
        .map(([symbol, count]) => ({ symbol, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_SYMBOLS)
    : [];
  const byCode: Record<string, number> = {};
  let rejectTotal = 0;
  for (const [code, count] of rejectsByCode.entries()) {
    byCode[code] = count;
    rejectTotal += count;
  }
  return {
    opensRecorded: opensRecordedTotal,
    openCountsBySymbol: openCounts,
    opensRejectedByCode: byCode,
    opensRejectedTotal: rejectTotal,
    trackedSymbols: day ? day.size : 0,
    lastOpenAt,
    lastRejectAt,
  };
}
