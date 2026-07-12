// TRA-1602 (TRA-1600C, parent TRA-1599) — DURABLE admit/reject telemetry for the
// per-candidate COST-AWARE options fire bar.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The board armed `ENABLE_OPTION_COST_AWARE_GATE` on the demo book (interaction
// `427b57ee`) so QuantTrader can forward-validate the bar. But the gate is a pure
// admission predicate: when it works, the evidence is trades that DIDN'T happen.
// Without a readout a grader can only INFER enforcement from desk churn — the exact
// trap that cost two demo sessions on the TRA-1476 quality gate before the
// "armed-but-inert" finding could be called (TRA-1486). This module makes the
// enforcement deterministic in one read:
//   • is the flag actually LIVE on the running process (not merely merged to
//     render.yaml — the TRA-1289 blueprint-env-sync gap);
//   • how many candidates the bar ADMITTED vs REJECTED, split by structure;
//   • the modeled-gross-R distribution either side of the bar, so QuantTrader can
//     see whether the bar is biting in the right place (rejecting scratch-tier) or
//     starving the book.
//
// DURABLE by design (the TRA-1564 B1 lesson): bqb1 reboots at/after the close, so
// in-memory since-boot counters read `{}` by the time a post-close grade fires.
// Records are JSONL-appended under DATA_DIR, keyed by ET calendar day, and rebuilt
// on boot — a post-close read returns the full RTH session.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only accounting. NEVER places an order or mutates an account. The engine
// records here ONLY from `costAwareGateReject`, which itself bails on
// `mode !== 'demo'` and on the flag being off — so every counter reflects an ARMED
// DEMO book and this file is structurally incapable of describing a live open. No
// balances/PII — just structure, ET day, modeled R, and the bar.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'cost-aware-gate-ledger' });

export const COST_AWARE_GATE_LOG_FILENAME = 'cost-aware-gate.jsonl';

/**
 * Retain this many ms of decisions on disk (compacted on boot). QuantTrader's
 * forward validation grades a rolling multi-session window, so a week comfortably
 * covers a weekly grade while bounding a file that takes one line per candidate.
 */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

/** One durable decision — a write-through of the verdict the gate just returned. */
interface CostGateDecisionRecord {
  /** Decision time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the health view rolls on. */
  etDay: string;
  /** Structure the candidate was admitted/rejected on (`single_leg_rv` / `single_leg_otm` / `directional`). */
  structure: string;
  /** True when the candidate cleared the bar and the open proceeded. */
  admit: boolean;
  /** The candidate's modeled GROSS R (the estimator output the bar was applied to). */
  grossR: number;
  /** The bar it had to clear (costModel + safety margin, floored). */
  barR: number;
}

interface StructureTally {
  admitted: number;
  rejected: number;
  admittedGrossRSum: number;
  rejectedGrossRSum: number;
  /** Most recent effective bar seen for this structure (the config is env-tunable). */
  lastBarR: number;
}

// ── In-memory store (backs the durable counts + the health endpoint) ─────────
//
// Module-global + observe-only. `dataDir` is set once at boot by
// hydrateCostAwareGateFromDisk so the deep engine chokepoint can append without
// threading a path through the SignalEngine.

let dataDir: string | null = null;
/** etDay -> (structure -> tally). */
const byDay = new Map<string, Map<string, StructureTally>>();
/** Total decisions seen (live + hydrated) across retained days. */
let decisionsTotal = 0;
let lastDecisionAt: number | null = null;

export function costAwareGateLogPath(dir: string): string {
  return join(dir, COST_AWARE_GATE_LOG_FILENAME);
}

/** Test seam — drop every counter and the configured dir. */
export function clearCostAwareGateLedger(): void {
  dataDir = null;
  byDay.clear();
  decisionsTotal = 0;
  lastDecisionAt = null;
}

/** Apply one decision to the in-memory tallies (shared by record + hydrate). */
function apply(rec: CostGateDecisionRecord): void {
  let day = byDay.get(rec.etDay);
  if (!day) {
    day = new Map();
    byDay.set(rec.etDay, day);
  }
  let tally = day.get(rec.structure);
  if (!tally) {
    tally = { admitted: 0, rejected: 0, admittedGrossRSum: 0, rejectedGrossRSum: 0, lastBarR: rec.barR };
    day.set(rec.structure, tally);
  }
  if (rec.admit) {
    tally.admitted += 1;
    tally.admittedGrossRSum += rec.grossR;
  } else {
    tally.rejected += 1;
    tally.rejectedGrossRSum += rec.grossR;
  }
  tally.lastBarR = rec.barR;
  decisionsTotal += 1;
  lastDecisionAt = rec.ts;
}

/**
 * Record one ARMED-DEMO cost-gate verdict and append one JSONL line under the
 * configured DATA_DIR. Best-effort on IO — a write failure logs and is swallowed so
 * this accounting can never break the trade pass. When no dataDir is configured
 * (unit tests / CLI without boot) the in-memory counts still update; only the file
 * write is skipped. A non-finite `grossR` (unusable estimator inputs) is recorded as
 * a reject with grossR 0 so the sums stay finite — the gate rejects it anyway.
 */
export function recordCostAwareGateDecision(
  structure: string,
  admit: boolean,
  grossR: number,
  barR: number,
  etDay: string,
  now: number = Date.now(),
): void {
  const rec: CostGateDecisionRecord = {
    ts: now,
    etDay,
    structure,
    admit,
    grossR: Number.isFinite(grossR) ? grossR : 0,
    barR: Number.isFinite(barR) ? barR : 0,
  };
  apply(rec);
  if (dataDir == null) return;
  const path = costAwareGateLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('cost-aware-gate append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** What {@link hydrateCostAwareGateFromDisk} recovered (for the boot log line). */
export interface CostAwareGateHydration {
  /** Distinct ET days retained after compaction. */
  days: number;
  /** Total decision records retained. */
  records: number;
}

/**
 * Rebuild the in-memory tallies from disk on boot and remember `dir` for subsequent
 * appends. Idempotent: CLEARS first, so it is safe to call exactly once at startup
 * before any live pass. Only records within {@link RETAIN_MS} of `now` are kept, and
 * the file is COMPACTED to exactly those lines (bounding growth). Best-effort: a
 * missing/corrupt file yields an empty hydration; a torn trailing line is skipped
 * rather than throwing.
 */
export function hydrateCostAwareGateFromDisk(dir: string, now: number = Date.now()): CostAwareGateHydration {
  clearCostAwareGateLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(costAwareGateLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: CostGateDecisionRecord;
    try {
      rec = JSON.parse(trimmed) as CostGateDecisionRecord;
    } catch {
      continue; // skip a torn/partial line rather than abort the hydrate
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (typeof rec.structure !== 'string' || rec.structure === '') continue;
    if (typeof rec.admit !== 'boolean') continue;
    const clean: CostGateDecisionRecord = {
      ts: rec.ts,
      etDay: rec.etDay,
      structure: rec.structure,
      admit: rec.admit,
      grossR: Number.isFinite(rec.grossR) ? rec.grossR : 0,
      barR: Number.isFinite(rec.barR) ? rec.barR : 0,
    };
    apply(clean);
    kept.push(JSON.stringify(clean));
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped when
  // there is nothing to drop, to avoid a needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = costAwareGateLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('cost-aware-gate compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { days: byDay.size, records: kept.length };
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface CostAwareGateStructureSummary {
  structure: string;
  admitted: number;
  rejected: number;
  /** admitted / (admitted + rejected), 0 when no decisions. */
  admitRate: number;
  /** Mean modeled gross R of the candidates that CLEARED the bar (null when none). */
  avgAdmittedGrossR: number | null;
  /** Mean modeled gross R of the candidates the bar REFUSED (null when none). */
  avgRejectedGrossR: number | null;
  /** Effective bar last applied to this structure. */
  barR: number;
}

export interface CostAwareGateSummary {
  /** Total decisions recorded (live + hydrated, across retained days). */
  decisionsRecorded: number;
  /** Per-structure admit/reject split for the requested ET day, busiest first. */
  byStructure: CostAwareGateStructureSummary[];
  /** Candidates admitted / refused across all structures on the requested ET day. */
  admittedTotal: number;
  rejectedTotal: number;
  /** ms epoch of the last recorded decision (null if none yet). */
  lastDecisionAt: number | null;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Fold the store into the read-only health diagnostics for `etDay` (the current ET
 * day at the caller). Pure — no IO. An all-zero read on an ARMED gate means the gate
 * saw no candidates (no scan fired), NOT that it is inert; `rejected > 0` is the
 * direct evidence the bar is biting.
 */
export function summarizeCostAwareGate(etDay: string): CostAwareGateSummary {
  const day = byDay.get(etDay);
  const byStructure: CostAwareGateStructureSummary[] = [];
  let admittedTotal = 0;
  let rejectedTotal = 0;
  if (day) {
    for (const [structure, t] of day.entries()) {
      const decisions = t.admitted + t.rejected;
      admittedTotal += t.admitted;
      rejectedTotal += t.rejected;
      byStructure.push({
        structure,
        admitted: t.admitted,
        rejected: t.rejected,
        admitRate: decisions > 0 ? round(t.admitted / decisions) : 0,
        avgAdmittedGrossR: t.admitted > 0 ? round(t.admittedGrossRSum / t.admitted) : null,
        avgRejectedGrossR: t.rejected > 0 ? round(t.rejectedGrossRSum / t.rejected) : null,
        barR: round(t.lastBarR),
      });
    }
    byStructure.sort((a, b) => b.admitted + b.rejected - (a.admitted + a.rejected));
  }
  return {
    decisionsRecorded: decisionsTotal,
    byStructure,
    admittedTotal,
    rejectedTotal,
    lastDecisionAt,
  };
}
