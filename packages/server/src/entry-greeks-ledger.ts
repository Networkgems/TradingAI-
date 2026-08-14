// TRA-1682 (parent TRA-1680 → TRA-1677) — DURABLE per-ET-day admit/reject telemetry
// for the PoP/delta entry-greeks gate (TRA-1293).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `/api/health/entry-greeks-gate` reported `enabled` + the thresholds and NOTHING
// about what the gate actually did. TRA-1677 then found the gate had been handed the
// SHORT-premium delta band ([0.30,0.40]) while `selectRvLongCandidate` can only ever
// emit |Δ| ≥ 0.45 — an empty intersection, so the gate rejected 100% of RV longs
// ALGEBRAICALLY. It was armed and impossible for a week and nobody saw it, because a
// gate rejecting everything and a sleeve finding nothing produce the SAME observable:
// no fills. The distinguishing number — the admit rate — was never counted.
//
// So: count it. A gate that admits 0/N over a full session is now loud, not silent
// (`admitRate: 0` with a non-zero `evaluated` is the tell; see {@link summarizeEntryGreeksGate}).
// This also unblocks TRA-1293's own stated purpose — forward-sampling gate 2's
// (Δ/Θ ratio floor) rejection rate before any live promotion. That sample was not
// takeable while nothing counted.
//
// ── DURABILITY ───────────────────────────────────────────────────────────────
// JSONL under DATA_DIR, ET-day-keyed, rebuilt on boot — the same shape TRA-1564 B1
// gave the directional quality gate (see `directional-open-ledger.ts`). In-memory
// since-boot counters were NOT enough there and are not enough here: bqb1 reboots at
// the daily close, so a post-close grading fire would read `{}` for a session that in
// fact evaluated hundreds of candidates. The file is compacted to {@link RETAIN_MS}
// on boot so it stays small.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-only accounting. NEVER places an order, mutates an account, or influences
// the gate's verdict — the engine records AFTER `entryGreeksGateDecision` has ruled.
// The engine consults the gate only on the `mode === 'demo'` RV-long branch, so every
// counter here describes the DEMO book by construction. No balances/PII — just the
// ET day, the verdict, and the sleeve.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'entry-greeks-ledger' });

export const ENTRY_GREEKS_LOG_FILENAME = 'entry-greeks-gate.jsonl';

/**
 * Retain this many ms of records on disk (compacted on boot). The health view only
 * ever reports the CURRENT ET day; a 3-day window covers a same-day reboot (and a
 * Monday read of Friday's session) while bounding the file.
 */
const RETAIN_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Reject reasons we count — the exact `EntryGreeksGateDecision.reason` union from
 * `@trading-app/engine` (minus `null`, which is the admitted case). Kept as a local
 * literal union rather than imported so a future engine-side reason addition fails
 * LOUDLY here (unknown reasons are dropped by {@link isRejectReason} on hydrate and
 * bucketed under `unknown` on record) instead of silently vanishing from the tally.
 */
export type EntryGreeksRejectReason =
  | 'delta_out_of_band'
  | 'delta_theta_ratio_too_low'
  | 'non_finite_greeks'
  | 'unknown';

const REJECT_REASONS: readonly EntryGreeksRejectReason[] = [
  'delta_out_of_band',
  'delta_theta_ratio_too_low',
  'non_finite_greeks',
  'unknown',
];

function isRejectReason(v: unknown): v is EntryGreeksRejectReason {
  return typeof v === 'string' && (REJECT_REASONS as readonly string[]).includes(v);
}

/**
 * Which entry sleeve the gate ruled on. Today the engine consults the greeks gate
 * only on the RV long (`rv-long`); the tag is carried so that if the gate is ever
 * extended to another sleeve the tally does not silently blend them — the exact
 * failure TRA-1682's parent found in the `single_leg_rv` JOURNAL bucket, which
 * blended the gated RV long with the ungated demo directional opener and made every
 * RV grade unattributable. Do not repeat that here.
 */
export type EntryGreeksSleeve = 'rv-long' | 'other';

/** One durable gate-verdict record. `reason` is absent iff the candidate was admitted. */
interface EntryGreeksRecord {
  /** Verdict time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the health view rolls on. */
  etDay: string;
  /** True ⇒ the candidate cleared both gates. */
  admitted: boolean;
  /** Failing reason; absent when `admitted`. */
  reason?: EntryGreeksRejectReason;
  /** Sleeve the gate ruled on (absent ⇒ `other`). */
  sleeve?: EntryGreeksSleeve;
}

// ── In-memory store (backs the durable counts + the health endpoint) ─────────
//
// Module-global + observe-only, mirroring `directional-open-ledger`. `dataDir` is set
// once at boot by {@link hydrateEntryGreeksGateFromDisk} so the deep engine gate site
// can append without threading a path through the SignalEngine.

let dataDir: string | null = null;
/** etDay -> admitted count. */
const admittedByDay = new Map<string, number>();
/** etDay -> (reject reason -> count). */
const rejectsByDay = new Map<string, Map<EntryGreeksRejectReason, number>>();
let lastAdmitAt: number | null = null;
let lastRejectAt: number | null = null;

export function entryGreeksLogPath(dir: string): string {
  return join(dir, ENTRY_GREEKS_LOG_FILENAME);
}

/** Test seam — drop every counter and the configured dir. */
export function clearEntryGreeksLedger(): void {
  dataDir = null;
  admittedByDay.clear();
  rejectsByDay.clear();
  lastAdmitAt = null;
  lastRejectAt = null;
}

/** Apply one verdict to the in-memory counts (shared by record + hydrate). */
function apply(etDay: string, admitted: boolean, reason: EntryGreeksRejectReason | undefined, now: number): void {
  if (admitted) {
    admittedByDay.set(etDay, (admittedByDay.get(etDay) ?? 0) + 1);
    lastAdmitAt = now;
    return;
  }
  const code = reason ?? 'unknown';
  let day = rejectsByDay.get(etDay);
  if (!day) {
    day = new Map();
    rejectsByDay.set(etDay, day);
  }
  day.set(code, (day.get(code) ?? 0) + 1);
  lastRejectAt = now;
}

/**
 * Record one entry-greeks-gate verdict against the durable per-ET-day tally AND append
 * one JSONL line under the configured DATA_DIR. `reason` MUST be the decision's own
 * `reason` on a reject (an unrecognized/absent one buckets under `unknown` rather than
 * being dropped — an uncounted reject is exactly the blindness this ledger exists to
 * end). Best-effort on IO: a write failure logs and is swallowed so this accounting can
 * never break the trade pass. With no dataDir configured (unit tests / CLI without boot)
 * the in-memory counts still update; only the file write is skipped.
 */
export function recordEntryGreeksVerdict(
  admitted: boolean,
  reason: string | null | undefined,
  etDay: string,
  sleeve: EntryGreeksSleeve = 'rv-long',
  now: number = Date.now(),
): void {
  const code: EntryGreeksRejectReason | undefined = admitted
    ? undefined
    : (isRejectReason(reason) ? reason : 'unknown');
  apply(etDay, admitted, code, now);
  if (dataDir == null) return;
  const path = entryGreeksLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    const rec: EntryGreeksRecord = {
      ts: now,
      etDay,
      admitted,
      ...(code ? { reason: code } : {}),
      sleeve,
    };
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    log.warn('entry-greeks verdict append failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** What {@link hydrateEntryGreeksGateFromDisk} recovered (for the boot log line). */
export interface EntryGreeksHydration {
  /** Distinct ET days retained. */
  days: number;
  /** Total admitted records retained. */
  admitted: number;
  /** Total reject records retained. */
  rejects: number;
}

/**
 * Rebuild the in-memory per-day tally from disk on boot and remember `dir` for
 * subsequent appends. Idempotent: CLEARS first, so it is safe to call exactly once at
 * startup before any trade pass. Only records within {@link RETAIN_MS} of `now` are
 * kept, and the file is COMPACTED to exactly those lines. Best-effort: a missing or
 * corrupt file yields an empty hydration; a torn trailing line is skipped rather than
 * throwing.
 */
export function hydrateEntryGreeksGateFromDisk(dir: string, now: number = Date.now()): EntryGreeksHydration {
  clearEntryGreeksLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(entryGreeksLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  let admitted = 0;
  let rejects = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: EntryGreeksRecord;
    try {
      rec = JSON.parse(trimmed) as EntryGreeksRecord;
    } catch {
      // skip a torn/partial line rather than abort the hydrate
      continue;
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (typeof rec.admitted !== 'boolean') continue;

    const code: EntryGreeksRejectReason | undefined = rec.admitted
      ? undefined
      : (isRejectReason(rec.reason) ? rec.reason : 'unknown');
    const sleeve: EntryGreeksSleeve = rec.sleeve === 'rv-long' ? 'rv-long' : 'other';
    apply(rec.etDay, rec.admitted, code, rec.ts);
    kept.push(JSON.stringify({
      ts: rec.ts,
      etDay: rec.etDay,
      admitted: rec.admitted,
      ...(code ? { reason: code } : {}),
      sleeve,
    }));
    if (rec.admitted) admitted += 1;
    else rejects += 1;
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped when
  // nothing was dropped, to avoid a needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = entryGreeksLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('entry-greeks ledger compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const days = new Set<string>([...admittedByDay.keys(), ...rejectsByDay.keys()]);
  return { days: days.size, admitted, rejects };
}

// ── Health summary ───────────────────────────────────────────────────────────

/**
 * TRA-3682 — the named verdict a bare `starving: false` could not express.
 *
 * `starving` is defined as `evaluated > 0 && admitted === 0`, which is correct but
 * NOT self-describing: it is also `false` when `evaluated === 0`, i.e. when nothing
 * ever reached the gate. So a completely dead upstream renders
 * `starving: false, admitRate: null` — which a reader scans as HEALTHY. That is the
 * reassurance half of the same TRA-1677 ambiguity this ledger exists to kill: the
 * gate stopped conflating "rejected everything" with "saw nothing" in its COUNTS,
 * but its FLAGS still did.
 *
 * On 2026-08-13 `single_leg_rv` reported exactly this shape while its upstream
 * producer had been compile-time OFF since 2026-06-30 (TRA-1207).
 *
 * Derived from the counters, never stored — so it can never disagree with them.
 * Mirrors `guardStateOf()` in `conviction-dca-ledger.ts`, which already got this
 * right; the two surfaces should read the same way.
 */
export type EntryGreeksGateState =
  /** No candidate reached the gate at all. The gate is silent because it is UNFED — say nothing about its thresholds; look UPSTREAM. */
  | 'no_candidates'
  /** Candidates arrived and the gate admitted NONE. The TRA-1677 signature: suspect the GATE. */
  | 'starving'
  /** The gate ran and admitted every candidate it saw. */
  | 'live_clean'
  /** The gate ran, admitted some and refused some — the ordinary working state. */
  | 'live_firing';

function gateStateOf(admitted: number, rejectedTotal: number): EntryGreeksGateState {
  if (admitted + rejectedTotal === 0) return 'no_candidates';
  if (admitted === 0) return 'starving';
  if (rejectedTotal === 0) return 'live_clean';
  return 'live_firing';
}

export interface EntryGreeksGateSummary {
  /** Candidates the gate ADMITTED on the requested ET day. */
  admitted: number;
  /** Candidates the gate REJECTED on the requested ET day, keyed by reason (non-zero only). */
  rejectedByReason: Record<string, number>;
  /** Total rejects across all reasons for the requested ET day. */
  rejectedTotal: number;
  /** admitted + rejectedTotal — the gate's throughput for the ET day. */
  evaluated: number;
  /**
   * admitted / evaluated, rounded to 4dp; `null` when the gate evaluated nothing
   * (an honest "no sample", NOT a 0 — a gate that never ran and a gate that rejected
   * everything must not read the same, which is the confusion that hid TRA-1677).
   */
  admitRate: number | null;
  /**
   * True when the gate evaluated ≥1 candidate and admitted NONE. This is the
   * TRA-1677 signature — an armed gate with an empty admissible set reads exactly
   * like a quiet tape unless something says so out loud. Graders should treat this
   * as "suspect the gate", not "suspect the market".
   */
  starving: boolean;
  /**
   * TRA-3682 — the disambiguated verdict. Prefer this over `starving` when
   * rendering: `starving: false` alone cannot distinguish "the gate is working"
   * from "nothing ever arrived". See {@link EntryGreeksGateState}.
   */
  state: EntryGreeksGateState;
  /** ms epoch of the last admit / reject (null if none yet). */
  lastAdmitAt: number | null;
  lastRejectAt: number | null;
}

/**
 * Fold the store into the read-only health diagnostics for `etDay` (the current ET day
 * at the caller). Pure — no IO.
 */
export function summarizeEntryGreeksGate(etDay: string): EntryGreeksGateSummary {
  const admitted = admittedByDay.get(etDay) ?? 0;
  const byReason: Record<string, number> = {};
  let rejectedTotal = 0;
  const rej = rejectsByDay.get(etDay);
  if (rej) {
    for (const [reason, count] of rej.entries()) {
      byReason[reason] = count;
      rejectedTotal += count;
    }
  }
  const evaluated = admitted + rejectedTotal;
  return {
    admitted,
    rejectedByReason: byReason,
    rejectedTotal,
    evaluated,
    admitRate: evaluated > 0 ? Math.round((admitted / evaluated) * 10000) / 10000 : null,
    starving: evaluated > 0 && admitted === 0,
    state: gateStateOf(admitted, rejectedTotal),
    lastAdmitAt,
    lastRejectAt,
  };
}
