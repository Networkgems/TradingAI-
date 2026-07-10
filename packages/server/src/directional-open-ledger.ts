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
// It also holds the gate-reject counters (by verdict code, per ET day) that back
// `GET /api/health/directional-quality-gate`, so a grade reads the gate's
// enforcement directly instead of inferring it from `/api/reports/desk`.
//
// ── SLEEVE SCOPING (TRA-1564) ─────────────────────────────────────────────────
// Two different consumers read this ledger and they need DIFFERENT scopes:
//   • the TRA-1408 churn brake is CROSS-SLEEVE by design ("don't re-churn a name on
//     ANY sleeve") — it wants the all-sleeve per-name count;
//   • the TRA-1476 directional quality-gate cap is DIRECTIONAL-ONLY ("≤ N *directional*
//     opens/name/ET-day") — it must not count equity-swing / RV / OTM opens.
// The write chokepoint (`recordChurnOpen` in signal-engine) fires from five open
// sleeves, so each recorded open is TAGGED with its sleeve and we rebuild two counts:
//   • {@link anySleeveOpensFor} — all-sleeve (churn brake, still reboot-durable);
//   • {@link directionalOpensFor} — directional-only (the quality gate + the health
//     `openCountsBySymbol` view).
// Before TRA-1564 the durable write lived in the shared chokepoint untagged, so BOTH
// the directional cap read AND the health view conflated all five sleeves — a
// `count:3` on a multi-sleeve name (equity-swing + directional) looked like a
// directional cap breach when the 3rd open came from a non-directional sleeve, and
// the grader could not certify the directional cap through the telemetry.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only accounting. NEVER places an order or mutates an account. The engine
// records here ONLY on the DEMO open chokepoints (no-op on the live path), so every
// counter reflects the DEMO book. No balances/PII — just symbol, ET day, sleeve tag,
// and reject codes.

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

/**
 * Which open sleeve a durable record came from. Only `directional` opens count
 * toward the directional quality-gate cap; every sleeve counts toward the
 * cross-sleeve churn brake. Legacy (pre-TRA-1564) records carry no tag and are
 * treated as `other` on hydrate — conservative: they never inflate the directional
 * cap read (they age out of the 3-day retain window within a session or two).
 */
export type OpenSleeve = 'directional' | 'other';

/** Reject verdict codes we count (mirrors {@link DirectionalQualityVerdict.code} minus `ok`). */
export type DirectionalRejectCode =
  | 'min_price'
  | 'min_dollar_volume'
  | 'insufficient_liquidity_samples'
  | 'per_name_cap';

/** One durable OPEN record — a write-through of the open the engine just booked. */
interface DirectionalOpenRecord {
  kind?: 'open';
  /** Open time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the per-name cap rolls on. */
  etDay: string;
  /** Normalized underlier symbol. */
  symbol: string;
  /** Sleeve the open fired on (absent on legacy pre-TRA-1564 lines ⇒ treated as `other`). */
  sleeve?: OpenSleeve;
}

/** One durable REJECT record — the quality gate refused a directional open (TRA-1564 B1). */
interface DirectionalRejectRecord {
  kind: 'reject';
  /** Reject time, ms epoch. */
  ts: number;
  /** ET calendar day the reject fired on (the key the health view rolls on). */
  etDay: string;
  /** Failing verdict code. */
  code: DirectionalRejectCode;
}

type DirectionalLedgerRecord = DirectionalOpenRecord | DirectionalRejectRecord;

const REJECT_CODES: readonly DirectionalRejectCode[] = [
  'min_price',
  'min_dollar_volume',
  'insufficient_liquidity_samples',
  'per_name_cap',
];

function isRejectCode(v: unknown): v is DirectionalRejectCode {
  return typeof v === 'string' && (REJECT_CODES as readonly string[]).includes(v);
}

// ── In-memory store (backs the durable counts + the health endpoint) ─────────
//
// Module-global + observe-only. `dataDir` is set once at boot by
// hydrateDirectionalOpensFromDisk so the deep engine chokepoint can append without
// threading a path through the SignalEngine. Counts are keyed by ET day so a stale
// day is naturally ignored by a current-day read.

let dataDir: string | null = null;
/** etDay -> (symbol -> open count) across ALL sleeves (cross-sleeve churn brake). */
const anySleeveByDay = new Map<string, Map<string, number>>();
/** etDay -> (symbol -> open count) for the DIRECTIONAL sleeve only (quality-gate cap + health). */
const directionalByDay = new Map<string, Map<string, number>>();
/** etDay -> (reject code -> count) — durable so a post-close fire reads RTH rejects (TRA-1564 B1). */
const rejectsByDay = new Map<string, Map<DirectionalRejectCode, number>>();
/** Total DIRECTIONAL opens seen (live + hydrated) across retained days. */
let directionalOpensTotal = 0;
let lastOpenAt: number | null = null;
let lastRejectAt: number | null = null;

export function directionalOpenLogPath(dir: string): string {
  return join(dir, DIRECTIONAL_OPEN_LOG_FILENAME);
}

/** Test seam — drop every counter and the configured dir. */
export function clearDirectionalOpenLedger(): void {
  dataDir = null;
  anySleeveByDay.clear();
  directionalByDay.clear();
  rejectsByDay.clear();
  directionalOpensTotal = 0;
  lastOpenAt = null;
  lastRejectAt = null;
}

function normSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function bump(store: Map<string, Map<string, number>>, etDay: string, symbol: string): void {
  let day = store.get(etDay);
  if (!day) {
    day = new Map();
    store.set(etDay, day);
  }
  day.set(symbol, (day.get(symbol) ?? 0) + 1);
}

/** Apply one open record to the in-memory counts (shared by record + hydrate). */
function applyOpen(symbol: string, etDay: string, sleeve: OpenSleeve, now: number): void {
  bump(anySleeveByDay, etDay, symbol);
  if (sleeve === 'directional') {
    bump(directionalByDay, etDay, symbol);
    directionalOpensTotal += 1;
    lastOpenAt = now;
  }
}

/** Apply one reject record to the in-memory counts (shared by record + hydrate). */
function applyReject(etDay: string, code: DirectionalRejectCode, now: number): void {
  let day = rejectsByDay.get(etDay);
  if (!day) {
    day = new Map();
    rejectsByDay.set(etDay, day);
  }
  day.set(code, (day.get(code) ?? 0) + 1);
  lastRejectAt = now;
}

/**
 * Durable CROSS-SLEEVE per-name open count for `symbol` on `etDay` (0 when none).
 * This is the reboot-durable value the TRA-1408 churn brake consults — it counts an
 * open on ANY sleeve, mirroring the brake's cross-sleeve intent, and reflects the
 * real same-ET-day total even after a mid-session restart.
 */
export function anySleeveOpensFor(symbol: string, etDay: string): number {
  return anySleeveByDay.get(etDay)?.get(normSymbol(symbol)) ?? 0;
}

/**
 * Durable DIRECTIONAL-ONLY per-name open count for `symbol` on `etDay` (0 when none).
 * This is the reboot-durable value the TRA-1476 directional quality-gate cap consults
 * — it counts ONLY opens tagged `directional`, so an equity-swing / RV / OTM open on
 * the same name never counts against the "≤ N directional opens/name" cap (TRA-1564 B2).
 */
export function directionalOpensFor(symbol: string, etDay: string): number {
  return directionalByDay.get(etDay)?.get(normSymbol(symbol)) ?? 0;
}

/**
 * Record one DEMO open against the durable per-name/ET-day counts AND append one JSONL
 * line under the configured DATA_DIR. `sleeve` scopes the record: `directional` opens
 * count toward BOTH the cross-sleeve churn brake and the directional quality-gate cap;
 * any other sleeve counts toward the churn brake only. Best-effort on IO — a write
 * failure logs and is swallowed so this accounting can never break the trade pass.
 * When no dataDir is configured (unit tests / CLI without boot) the in-memory counts
 * still update; only the file write is skipped.
 */
export function recordDirectionalOpen(
  symbol: string,
  etDay: string,
  sleeve: OpenSleeve = 'directional',
  now: number = Date.now(),
): void {
  const sym = normSymbol(symbol);
  applyOpen(sym, etDay, sleeve, now);
  if (dataDir == null) return;
  const path = directionalOpenLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    const rec: DirectionalOpenRecord = { kind: 'open', ts: now, etDay, symbol: sym, sleeve };
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('directional-open append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record one directional open REJECTED by the quality gate, by verdict code, on
 * `etDay`. DURABLE (TRA-1564 B1): appends a JSONL line and rebuilds on boot, so the
 * post-close re-grade fire reads the full RTH session's rejects even though bqb1
 * reboots at/after the close (before the fix these counters were in-memory since-boot
 * and were already `{}` by post-market time). Best-effort on IO — a write failure
 * logs and is swallowed. When no dataDir is configured the in-memory count still
 * updates; only the file write is skipped.
 */
export function recordDirectionalGateReject(
  code: DirectionalRejectCode,
  etDay: string,
  now: number = Date.now(),
): void {
  applyReject(etDay, code, now);
  if (dataDir == null) return;
  const path = directionalOpenLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    const rec: DirectionalRejectRecord = { kind: 'reject', ts: now, etDay, code };
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('directional-reject append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** What {@link hydrateDirectionalOpensFromDisk} recovered (for the boot log line). */
export interface DirectionalOpenHydration {
  /** Distinct ET days retained after compaction (across opens + rejects). */
  days: number;
  /** Total open records retained. */
  records: number;
  /** Total reject records retained. */
  rejects: number;
}

/**
 * Rebuild the in-memory per-day counts (opens by sleeve + rejects by code) from disk
 * on boot and remember `dir` for subsequent appends. Idempotent: CLEARS first, so it
 * is safe to call exactly once at startup before any live pass. Only records within
 * {@link RETAIN_MS} of `now` are kept, and the file is COMPACTED to exactly those
 * lines (bounding growth). Best-effort: a missing/corrupt file yields an empty
 * hydration; a torn trailing line is skipped rather than throwing.
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
  let rejects = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: DirectionalLedgerRecord;
    try {
      rec = JSON.parse(trimmed) as DirectionalLedgerRecord;
    } catch {
      // skip a torn/partial line rather than abort the hydrate
      continue;
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;

    if (rec.kind === 'reject') {
      if (!isRejectCode(rec.code)) continue;
      applyReject(rec.etDay, rec.code, rec.ts);
      kept.push(JSON.stringify({ kind: 'reject', ts: rec.ts, etDay: rec.etDay, code: rec.code }));
      rejects += 1;
      continue;
    }

    // Default (kind 'open' or absent — legacy untagged line).
    if (typeof rec.symbol !== 'string' || rec.symbol.trim() === '') continue;
    const sym = normSymbol(rec.symbol);
    // Legacy lines carry no sleeve tag; treat as `other` so they never inflate the
    // directional cap read (they only affect the cross-sleeve churn count).
    const sleeve: OpenSleeve = rec.sleeve === 'directional' ? 'directional' : 'other';
    applyOpen(sym, rec.etDay, sleeve, rec.ts);
    kept.push(JSON.stringify({ kind: 'open', ts: rec.ts, etDay: rec.etDay, symbol: sym, sleeve }));
    records += 1;
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

  const days = new Set<string>([...directionalByDay.keys(), ...anySleeveByDay.keys(), ...rejectsByDay.keys()]);
  return { days: days.size, records, rejects };
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface DirectionalOpenSymbolCount {
  symbol: string;
  count: number;
}

export interface DirectionalGateSummary {
  /** Total DEMO DIRECTIONAL opens recorded (live + hydrated, across retained days). */
  opensRecorded: number;
  /** Per-name DIRECTIONAL-only open counts for the requested ET day, busiest first. */
  openCountsBySymbol: DirectionalOpenSymbolCount[];
  /** DURABLE rejects for the requested ET day keyed by verdict code (only non-zero present). */
  opensRejectedByCode: Record<string, number>;
  /** Total rejects across all codes for the requested ET day. */
  opensRejectedTotal: number;
  /** Distinct names with ≥1 recorded DIRECTIONAL open on the requested ET day. */
  trackedSymbols: number;
  /** ms epoch of the last recorded directional open / reject (null if none yet). */
  lastOpenAt: number | null;
  lastRejectAt: number | null;
}

/** Top-N symbols surfaced in the per-name view (counts stay complete internally). */
const TOP_SYMBOLS = 25;

/**
 * Fold the store into the read-only health diagnostics for `etDay` (the current ET
 * day at the caller). Pure — no IO. The per-name view is DIRECTIONAL-ONLY (TRA-1564
 * B2) so a `count` here is directly comparable to the directional cap; the rejects
 * are the DURABLE (TRA-1564 B1) count for that ET day so a post-close read is honest.
 */
export function summarizeDirectionalGate(etDay: string): DirectionalGateSummary {
  const day = directionalByDay.get(etDay);
  const openCounts = day
    ? [...day.entries()]
        .map(([symbol, count]) => ({ symbol, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_SYMBOLS)
    : [];
  const byCode: Record<string, number> = {};
  let rejectTotal = 0;
  const rej = rejectsByDay.get(etDay);
  if (rej) {
    for (const [code, count] of rej.entries()) {
      byCode[code] = count;
      rejectTotal += count;
    }
  }
  return {
    opensRecorded: directionalOpensTotal,
    openCountsBySymbol: openCounts,
    opensRejectedByCode: byCode,
    opensRejectedTotal: rejectTotal,
    trackedSymbols: day ? day.size : 0,
    lastOpenAt,
    lastRejectAt,
  };
}
