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

/**
 * Which gate produced the record. `cost_bar` is the TRA-1602 modeled-gross-R bar
 * (the original and only kind — records written before TRA-1670 have no `gate`
 * field and hydrate as `cost_bar`). `delta_ceiling` is the TRA-1670 entry-delta
 * ceiling, tallied SEPARATELY: it is a structural band edge, not a modeled-R
 * verdict, so folding it into admitted/rejected would corrupt the cost bar's
 * admit rate and its gross-R means.
 */
// `delta_ceiling_observed` (TRA-1689) is a breach the ceiling COUNTED and then ADMITTED
// — an observe-only structure. It is a separate kind, not a flag on `delta_ceiling`,
// because the two must never be summed: one is a trade that did not happen, the other is
// a trade that DID. Conflating them would report a sleeve as cut while it was still
// trading the tail (the TRA-1682 lesson, one gate over).
type CostGateKind = 'cost_bar' | 'delta_ceiling' | 'delta_ceiling_observed';

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
  /** Absent on pre-TRA-1670 records — hydrates as `cost_bar`. */
  gate?: CostGateKind;
  /** `delta_ceiling` records only: the |delta| that breached the ceiling. */
  absDelta?: number;
}

interface StructureTally {
  admitted: number;
  rejected: number;
  admittedGrossRSum: number;
  rejectedGrossRSum: number;
  /**
   * Most recent effective bar seen for this structure (the config is env-tunable).
   * `null` until a COST-BAR decision lands: a ceiling record carries `barR: 0` and has no
   * bar to report, so seeding from it would publish a live bar as 0.00 (TRA-1707).
   */
  lastBarR: number | null;
  /** TRA-1670 — candidates the entry-delta CEILING refused (disjoint from `rejected`). */
  deltaCeilingRejected: number;
  /** Sum of the |delta|s the ceiling refused, for the mean in the health view. */
  deltaCeilingAbsDeltaSum: number;
  /** TRA-1689 — breaches COUNTED and ADMITTED on an observe-only structure. These TRADED. */
  deltaCeilingObserved: number;
  /** Sum of the |delta|s of the observed (admitted) breaches. */
  deltaCeilingObservedAbsDeltaSum: number;
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
    tally = {
      admitted: 0,
      rejected: 0,
      admittedGrossRSum: 0,
      rejectedGrossRSum: 0,
      // NOT `rec.barR` — the record that CREATES this tally may be a ceiling record, which
      // carries `barR: 0` and never writes the field again on its own branch. Seeding from it
      // published `barR: 0.00` on a structure whose bar is live, and an absent bar and a live
      // bar then read identically (TRA-1707). Only the cost-bar branches below may set it.
      lastBarR: null,
      deltaCeilingRejected: 0,
      deltaCeilingAbsDeltaSum: 0,
      deltaCeilingObserved: 0,
      deltaCeilingObservedAbsDeltaSum: 0,
    };
    day.set(rec.structure, tally);
  }
  if (rec.gate === 'delta_ceiling') {
    // A ceiling breach carries no modeled R and no bar — tallied on its own axis so
    // the cost bar's admit rate / gross-R means stay exactly what they were.
    tally.deltaCeilingRejected += 1;
    tally.deltaCeilingAbsDeltaSum += Number.isFinite(rec.absDelta) ? (rec.absDelta as number) : 0;
  } else if (rec.gate === 'delta_ceiling_observed') {
    // TRA-1689 — the ceiling SAW this one and let it through. Its own axis: it must
    // never inflate `deltaCeilingRejected` (nothing was rejected) and it must never
    // touch the cost bar's admitted/rejected (that gate did not rule on it here).
    tally.deltaCeilingObserved += 1;
    tally.deltaCeilingObservedAbsDeltaSum += Number.isFinite(rec.absDelta) ? (rec.absDelta as number) : 0;
  } else if (rec.admit) {
    tally.admitted += 1;
    tally.admittedGrossRSum += rec.grossR;
    tally.lastBarR = rec.barR;
  } else {
    tally.rejected += 1;
    tally.rejectedGrossRSum += rec.grossR;
    tally.lastBarR = rec.barR;
  }
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
    gate: 'cost_bar',
  };
  applyAndAppend(rec);
}

/**
 * TRA-1670 — record one ARMED-DEMO entry-delta CEILING reject. Same durability and
 * containment as the cost-bar recorder above (the engine only reaches it on a
 * `mode === 'demo'` branch with the ceiling flag on), and the same best-effort IO.
 *
 * This exists because a ceiling that is shipped, believed armed, and silently doing
 * nothing is the exact failure the TRA-1486 quality gate and the TRA-1407 floor both
 * hit. `deltaCeilingRejected > 0` on `/api/health/cost-aware-gate` is the direct,
 * durable evidence the band's upper edge is BITING.
 */
export function recordEntryDeltaCeilingReject(
  structure: string,
  absDelta: number,
  etDay: string,
  now: number = Date.now(),
): void {
  applyAndAppend({
    ts: now,
    etDay,
    structure,
    admit: false,
    grossR: 0,
    barR: 0,
    gate: 'delta_ceiling',
    absDelta: Number.isFinite(absDelta) ? absDelta : 0,
  });
}

/**
 * TRA-1689 — record one OBSERVE-ONLY entry-delta ceiling breach: the |delta| was above
 * the structure's ceiling and the open proceeded anyway.
 *
 * `admit: true`, because it was admitted. That field is the durable record of what the
 * engine ACTUALLY DID, and an observed breach that wrote `admit: false` would replay out
 * of the JSONL as a trade that never happened.
 *
 * This is what makes a ceiling measurable before it is trusted: the tail accrues an n and
 * a realized R while the sleeve keeps trading it. Arming a ceiling to find out whether the
 * tail is a loser costs you every trade above it — and if you were wrong, you never learn,
 * because the evidence is exactly the trades you refused to take.
 */
export function recordEntryDeltaCeilingObserved(
  structure: string,
  absDelta: number,
  etDay: string,
  now: number = Date.now(),
): void {
  applyAndAppend({
    ts: now,
    etDay,
    structure,
    admit: true,
    grossR: 0,
    barR: 0,
    gate: 'delta_ceiling_observed',
    absDelta: Number.isFinite(absDelta) ? absDelta : 0,
  });
}

function applyAndAppend(rec: CostGateDecisionRecord): void {
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
    // TRA-1703 — preserve the KIND. This used to collapse everything that was not
    // `delta_ceiling` to `cost_bar`, which silently laundered every TRA-1689
    // `delta_ceiling_observed` line into a cost-bar ADMIT carrying grossR 0 / barR 0:
    // the observe counter reset to zero on every reboot, `admitted` gained a phantom,
    // `avgAdmittedGrossR` was dragged toward 0 and the reported bar was clobbered to
    // 0.00R. Worse, the compaction below rewrites the file to these sanitized lines, so
    // the first boot after a breach DESTROYED the evidence on disk. An unlisted kind
    // must fall back to `cost_bar` (that is how pre-TRA-1670 lines, which carry no
    // `gate` at all, still hydrate) — but a kind we DO know must survive verbatim.
    const gate: CostGateKind =
      rec.gate === 'delta_ceiling' || rec.gate === 'delta_ceiling_observed' ? rec.gate : 'cost_bar';
    const clean: CostGateDecisionRecord = {
      ts: rec.ts,
      etDay: rec.etDay,
      structure: rec.structure,
      admit: rec.admit,
      grossR: Number.isFinite(rec.grossR) ? rec.grossR : 0,
      barR: Number.isFinite(rec.barR) ? rec.barR : 0,
      // Pre-TRA-1670 lines carry no `gate` — they are cost-bar verdicts by construction.
      gate,
      ...(gate !== 'cost_bar'
        ? { absDelta: Number.isFinite(rec.absDelta) ? (rec.absDelta as number) : 0 }
        : {}),
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
  /**
   * admitted / (admitted + rejected), **`null` when the bar ruled on nothing**.
   *
   * NOT 0. A 0% admit rate is the alarm condition — it is what an algebraically impossible
   * gate looks like (TRA-1677, invisible for a week). If "no candidates" also rendered as 0,
   * the alarm state and the quiet state would be the same number. Same rule the sibling
   * entry-greeks ledger already follows (TRA-1682: `admitRate: null ≠ 0`).
   */
  admitRate: number | null;
  /** Mean modeled gross R of the candidates that CLEARED the bar (null when none). */
  avgAdmittedGrossR: number | null;
  /** Mean modeled gross R of the candidates the bar REFUSED (null when none). */
  avgRejectedGrossR: number | null;
  /**
   * Effective bar last applied to this structure — **`null` until a cost-bar decision lands**.
   *
   * A ceiling record carries `barR: 0`, so a day that opens with a ceiling breach used to
   * publish `barR: 0.00` on a structure whose bar was live: a live bar and an absent bar read
   * identically (TRA-1707). `null` is the honest value for "not measured"; 0 is a number a
   * reader will act on.
   */
  barR: number | null;
  /**
   * TRA-1670 — candidates the entry-delta CEILING refused on this structure. Disjoint
   * from `admitted`/`rejected` (which are the cost bar's): > 0 is the direct evidence
   * the band's upper edge is biting.
   */
  deltaCeilingRejected: number;
  /** Mean |delta| of the candidates the ceiling refused (null when none). */
  avgDeltaCeilingAbsDelta: number | null;
  /**
   * TRA-1689 — breaches the ceiling COUNTED and ADMITTED on this structure (observe-only).
   * These OPENED. `deltaCeilingObserved > 0` with `deltaCeilingRejected === 0` is a sleeve
   * whose tail is being MEASURED, not cut.
   */
  deltaCeilingObserved: number;
  /** Mean |delta| of the observed (admitted) breaches (null when none). */
  avgDeltaCeilingObservedAbsDelta: number | null;
}

/**
 * TRA-1703 — the SAME fold, rolled across every retained ET day instead of one.
 *
 * The day view above is the right instrument for the cost bar: an admit rate is a
 * property of a session. It is the WRONG instrument for a ceiling tripwire. TRA-1690's
 * abort condition is "`deltaCeilingRejected > 0` on `single_leg_rv` AT ANY POINT IN THE
 * WINDOW" — and an observe window long enough to reach n≥40 spans weeks. Read off the
 * day view, a reject on day 3 reads 0 from day 4 onward: the tripwire that exists to
 * catch "observe mode is not live and I am CUTTING the sleeve I meant to measure"
 * silently re-arms itself at every ET midnight, which is the same false-GREEN shape as
 * every other counter in this family (it reads identically in the pass and fail states).
 *
 * Horizon is `retentionDays` (7) — bounded by RETAIN_MS, not infinite. Stated in the
 * payload so a reader cannot mistake it for "ever": a gap longer than this between reads
 * voids the guarantee, and the honest place to say so is the field itself.
 */
export interface CostAwareGateRetainedSummary {
  /** Every ET day still in the ledger, ascending. */
  etDays: string[];
  /** How many days back the ledger retains. A read gap wider than this can miss a reject. */
  retentionDays: number;
  /** Per-structure fold across ALL retained days, busiest first. */
  byStructure: CostAwareGateStructureSummary[];
  admittedTotal: number;
  rejectedTotal: number;
  /** The tripwire: > 0 means an ENFORCING ceiling cut this structure somewhere in the window. */
  deltaCeilingRejectedTotal: number;
  /** The measurement: > 0 with `deltaCeilingRejectedTotal === 0` is a tail being observed, not cut. */
  deltaCeilingObservedTotal: number;
}

export interface CostAwareGateSummary {
  /** Total decisions recorded (live + hydrated, across retained days). */
  decisionsRecorded: number;
  /** Per-structure admit/reject split for the requested ET day, busiest first. */
  byStructure: CostAwareGateStructureSummary[];
  /** Candidates admitted / refused across all structures on the requested ET day. */
  admittedTotal: number;
  rejectedTotal: number;
  /** TRA-1670 — entry-delta ceiling rejects across all structures on the requested ET day. */
  deltaCeilingRejectedTotal: number;
  /** TRA-1689 — observe-only ceiling breaches (COUNTED, then ADMITTED) across all structures. */
  deltaCeilingObservedTotal: number;
  /**
   * TRA-1703 — the multi-day roll. Every count above is scoped to ONE ET day; a ceiling
   * tripwire read off a one-day counter self-clears at midnight. Read THIS for the
   * ceiling, the day view for the cost bar.
   */
  retained: CostAwareGateRetainedSummary;
  /** ms epoch of the last recorded decision (null if none yet). */
  lastDecisionAt: number | null;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Merge one day's tally for a structure into an accumulator (so N days fold like one). */
function mergeTally(into: StructureTally, t: StructureTally): void {
  into.admitted += t.admitted;
  into.rejected += t.rejected;
  into.admittedGrossRSum += t.admittedGrossRSum;
  into.rejectedGrossRSum += t.rejectedGrossRSum;
  into.deltaCeilingRejected += t.deltaCeilingRejected;
  into.deltaCeilingAbsDeltaSum += t.deltaCeilingAbsDeltaSum;
  into.deltaCeilingObserved += t.deltaCeilingObserved;
  into.deltaCeilingObservedAbsDeltaSum += t.deltaCeilingObservedAbsDeltaSum;
  // `lastBarR` is a LAST, not a sum — a day with no cost-bar decision has no bar to
  // contribute and must not overwrite a real one. The sentinel is `null`, not 0: a day
  // whose only records were ceiling breaches now carries `null` (TRA-1707), so a genuine
  // bar of 0 is no longer indistinguishable from "never measured".
  if (t.lastBarR !== null) into.lastBarR = t.lastBarR;
}

/** Fold a structure->tally map into the per-structure health rows, busiest first. */
function foldStructures(acc: Map<string, StructureTally>): {
  byStructure: CostAwareGateStructureSummary[];
  admittedTotal: number;
  rejectedTotal: number;
  deltaCeilingRejectedTotal: number;
  deltaCeilingObservedTotal: number;
} {
  const byStructure: CostAwareGateStructureSummary[] = [];
  let admittedTotal = 0;
  let rejectedTotal = 0;
  let deltaCeilingRejectedTotal = 0;
  let deltaCeilingObservedTotal = 0;
  for (const [structure, t] of acc.entries()) {
    const decisions = t.admitted + t.rejected;
    admittedTotal += t.admitted;
    rejectedTotal += t.rejected;
    deltaCeilingRejectedTotal += t.deltaCeilingRejected;
    deltaCeilingObservedTotal += t.deltaCeilingObserved;
    byStructure.push({
      structure,
      admitted: t.admitted,
      rejected: t.rejected,
      admitRate: decisions > 0 ? round(t.admitted / decisions) : null,
      avgAdmittedGrossR: t.admitted > 0 ? round(t.admittedGrossRSum / t.admitted) : null,
      avgRejectedGrossR: t.rejected > 0 ? round(t.rejectedGrossRSum / t.rejected) : null,
      barR: t.lastBarR === null ? null : round(t.lastBarR),
      deltaCeilingRejected: t.deltaCeilingRejected,
      avgDeltaCeilingAbsDelta:
        t.deltaCeilingRejected > 0 ? round(t.deltaCeilingAbsDeltaSum / t.deltaCeilingRejected) : null,
      deltaCeilingObserved: t.deltaCeilingObserved,
      avgDeltaCeilingObservedAbsDelta:
        t.deltaCeilingObserved > 0
          ? round(t.deltaCeilingObservedAbsDeltaSum / t.deltaCeilingObserved)
          : null,
    });
  }
  byStructure.sort(
    (a, b) =>
      b.admitted + b.rejected + b.deltaCeilingRejected + b.deltaCeilingObserved
      - (a.admitted + a.rejected + a.deltaCeilingRejected + a.deltaCeilingObserved),
  );
  return { byStructure, admittedTotal, rejectedTotal, deltaCeilingRejectedTotal, deltaCeilingObservedTotal };
}

/** TRA-1703 — fold EVERY retained ET day. See {@link CostAwareGateRetainedSummary}. */
function summarizeRetained(): CostAwareGateRetainedSummary {
  const acc = new Map<string, StructureTally>();
  for (const day of byDay.values()) {
    for (const [structure, t] of day.entries()) {
      let into = acc.get(structure);
      if (!into) {
        into = {
          admitted: 0,
          rejected: 0,
          admittedGrossRSum: 0,
          rejectedGrossRSum: 0,
          lastBarR: null,
          deltaCeilingRejected: 0,
          deltaCeilingAbsDeltaSum: 0,
          deltaCeilingObserved: 0,
          deltaCeilingObservedAbsDeltaSum: 0,
        };
        acc.set(structure, into);
      }
      mergeTally(into, t);
    }
  }
  return {
    etDays: [...byDay.keys()].sort(),
    retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
    ...foldStructures(acc),
  };
}

/**
 * Fold the store into the read-only health diagnostics for `etDay` (the current ET
 * day at the caller). Pure — no IO. An all-zero read on an ARMED gate means the gate
 * saw no candidates (no scan fired), NOT that it is inert; `rejected > 0` is the
 * direct evidence the bar is biting.
 *
 * Every count here is scoped to ONE ET day. For anything that must hold ACROSS a
 * window — above all the entry-delta ceiling tripwire — read `retained` instead
 * (TRA-1703): a one-day counter re-arms itself at midnight.
 */
export function summarizeCostAwareGate(etDay: string): CostAwareGateSummary {
  const day = byDay.get(etDay);
  return {
    decisionsRecorded: decisionsTotal,
    ...foldStructures(day ?? new Map()),
    retained: summarizeRetained(),
    lastDecisionAt,
  };
}
