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
// TRA-4904 — the PERIODIC compaction is async on purpose; see
// {@link compactCostAwareGateLedgerNow}. The boot path stays sync (it must finish
// before the first live append).
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import {
  DIRECTIONAL_STRUCTURE_LABEL, // TRA-2345 — interpolated, never re-typed as a literal.
  SPREAD_CEILING_ACCOUNT_CLASSES,
  type SpreadCeilingAccountClass,
} from './option-spread-cost.js';
import {
  testAccountClassifierIdentity, // TRA-2948 — stamped at decision time, compared at read time.
  type TestAccountClassifierIdentity,
} from './test-accounts.js';

const log = logger.child({ module: 'cost-aware-gate-ledger' });

export const COST_AWARE_GATE_LOG_FILENAME = 'cost-aware-gate.jsonl';

/**
 * Retain this many ms of decisions on disk (compacted on boot AND on the
 * {@link COST_AWARE_GATE_COMPACTION_INTERVAL_MS} timer). QuantTrader's forward
 * validation grades a rolling multi-session window, so a week comfortably covers a
 * weekly grade while bounding a file that takes one line per candidate.
 */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

/** Published beside the compaction outcome so `/data` can be audited without grepping here. */
export const COST_AWARE_GATE_RETENTION_DAYS = RETAIN_MS / (24 * 60 * 60 * 1000);

/**
 * TRA-4904 — how often the retention cutoff is re-applied TO DISK while the process
 * stays up.
 *
 * ── WHY A TIMER AT ALL ───────────────────────────────────────────────────────
 * A boot-only compaction leaves the file carrying up to one BOOT INTERVAL of rows
 * that have aged past {@link RETAIN_MS} and never been dropped, so the steady-state
 * size is `rate × (retain + bootGap)`, not `rate × retain`. The premium is
 * `bootGap / retain`, and this tape is the box's worst case on BOTH factors: the
 * highest write rate in `/data` (9.98 MiB/day, measured on bqb1 2026-09-25) against
 * the SHORTEST retention (7d, where every sibling holds 30d). Premium **+70.4%**,
 * worst case 119.1 MiB against a ~73 MiB steady state — 45.9 MiB of pure overshoot,
 * most of one whole close-ledger budget (TRA-4899 AC4,
 * `docs/tra4899-data-tape-budget.md`).
 *
 * Nothing is breached today only because the box is UNSTABLE: the observed maximum
 * uptime over 100 Render deploys is 4.93 d against ~13.5 d of `/data` headroom, and
 * every restart compacts. Fixing the instability (TRA-4158's watchdog restarts,
 * TRA-4820's env-write deploys) SHORTENS that margin — a box that stays up three
 * weeks trips `minFreePct` on this path with no code change anywhere. So the timer
 * is the fix for a reliability win becoming a disk incident.
 *
 * ── WHY 6 HOURS ──────────────────────────────────────────────────────────────
 * The premium above is `interval / retain`, so the AC1 bar — beat the 30-day tapes'
 * +16.4% — is `interval ≤ 0.164 × 7 d = 1.15 d`. 6 h gives **+3.6%** (≈2.6 MiB),
 * four fires a day, comfortably inside the bar with room for a fire to be skipped.
 * It is deliberately NOT tied to the ET day: this file's cutoff is a TIMESTAMP
 * cutoff (see {@link hydrateCostAwareGateFromDisk}), a daily-at-a-fixed-instant
 * schedule is its own single point of failure on a process restarted several times
 * an hour (the TRA-2840 lesson), and a wall-clock-derived interval needs no
 * catch-up logic.
 */
export const COST_AWARE_GATE_COMPACTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
// `spread_ceiling` / `spread_ceiling_admitted` (TRA-2295) are the SPREAD gate's two
// outcomes, and BOTH are recorded on purpose. A reject counter alone reproduces the
// exact defect that ticket exists to fix: an unenforced gate and a gate with nothing
// to reject both read `0`. Only `evaluated = admitted + rejected` separates them —
// `evaluated === 0` is "this gate did not run", `evaluated > 0, rejected === 0` is
// "it ran and everything was inside the ceiling".
type CostGateKind =
  | 'cost_bar'
  | 'delta_ceiling'
  | 'delta_ceiling_observed'
  | 'spread_ceiling'
  | 'spread_ceiling_admitted';

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
  /** TRA-2295 `spread_ceiling*` records only: the measured `(ask − bid) / mark`. */
  spreadPct?: number;
  /** TRA-2295 `spread_ceiling` rejects only: which threshold bit (`max_spread_pct` / `min_bid` / `no_quote`). */
  code?: string;
  /**
   * TRA-2355 — WHICH BOOK the decision belongs to, as a class. `spread_ceiling*`
   * records only; absent on every other kind and on every line written before this
   * ticket (those hydrate as `unattributed`, never `desk`).
   *
   * The CLASS is stored, not the username. Two reasons, both load-bearing:
   *   • This file's standing invariant is "no balances/PII" (see the header). A
   *     username is the one identifying string the ledger would otherwise carry.
   *   • Classification is frozen at DECISION time. `isTestAccount` reads
   *     `TEST_ACCOUNT_PREFIXES` from the env, so classifying at READ time would let
   *     an env edit retroactively reclassify a week of history — a partition that
   *     silently changes under a grader is worse than no partition.
   */
  accountClass?: SpreadCeilingAccountClass;
  /**
   * TRA-2948 — the {@link testAccountClassifierIdentity} hash of the classifier
   * `accountClass` was computed UNDER, stamped at decision time beside the class
   * it explains. `spread_ceiling*` records only; absent on every line written
   * before this ticket (those tally as UNSTAMPED, never as current).
   *
   * This is the field that makes the two ceiling cross-checks separable. The
   * class above is frozen at decision time while `/api/health/option-spread-cost`
   * recomputes class at read time, so across any pattern-set edit the two
   * surfaces disagree BY CONSTRUCTION — and without this stamp that disagreement
   * is indistinguishable from a real enforcement failure. A retained window whose
   * stamps all match the current classifier rules the classifier OUT; any stamp
   * that differs names it as a cause and bounds the blast radius to a count.
   */
  classifierHash?: string;
  /**
   * TRA-4439 D1 — `cost_bar` ADMITS only: set when the admit was GRANTED BY A BYPASS
   * (today only the TRA-4378 exploration allowance) rather than earned by clearing the
   * bar. Absent ⇒ an ordinary bar verdict — and on every line written before TRA-4439,
   * where a bypass admit is therefore indistinguishable from a merit one (see
   * {@link CostAwareGateStructureSummary.admittedByBypass}).
   */
  bypass?: CostBarBypass;
  /**
   * TRA-4439 D2 — `cost_bar` records only: the estimator had no usable output
   * (`tapeEdgeR` is NaN whenever the cell is `insufficient_evidence`), so `grossR`
   * on this line is a 0 FILL, not a score. Absent on pre-TRA-4439 lines, whose fills
   * cannot be told from genuine zeros.
   */
  grossRUnmeasurable?: true;
}

/** TRA-4439 D1 — the named bypasses that can write a cost-bar ADMIT without the bar clearing it. */
export type CostBarBypass = 'exploration_allowance';

/**
 * TRA-4439 D5 — the COST-BAR counters for ONE account class within a structure.
 * Same partition rule as the spread-ceiling split below it (TRA-2355): the pooled
 * cost-bar fields mix ~64 QA fixture books with the desk — on the RV row 93% fixture
 * over 09-11..09-18 — so a pooled mean is not a desk measurement.
 */
interface CostBarClassTally {
  admitted: number;
  admittedByBypass: number;
  rejected: number;
  grossRUnmeasurable: number;
  /** Rejects that carried a real score (fills excluded), their sum and the largest. */
  rejectedMeasured: number;
  rejectedMeasuredGrossRSum: number;
  maxRejectedGrossR: number | null;
}

function newCostBarClassTally(): CostBarClassTally {
  return {
    admitted: 0,
    admittedByBypass: 0,
    rejected: 0,
    grossRUnmeasurable: 0,
    rejectedMeasured: 0,
    rejectedMeasuredGrossRSum: 0,
    maxRejectedGrossR: null,
  };
}

/** Fold one cost-bar record into a (pooled or per-class) cost-bar tally. */
function applyCostBar(c: CostBarClassTally, rec: CostGateDecisionRecord): void {
  const fill = rec.grossRUnmeasurable === true;
  if (fill) c.grossRUnmeasurable += 1;
  if (rec.admit) {
    c.admitted += 1;
    if (rec.bypass) c.admittedByBypass += 1;
    return;
  }
  c.rejected += 1;
  if (fill) return;
  c.rejectedMeasured += 1;
  c.rejectedMeasuredGrossRSum += rec.grossR;
  c.maxRejectedGrossR = c.maxRejectedGrossR === null ? rec.grossR : Math.max(c.maxRejectedGrossR, rec.grossR);
}

/** Sum one cost-bar tally into another (N days fold like one; max is a null-safe MAX). */
function mergeCostBar(into: CostBarClassTally, t: CostBarClassTally): void {
  into.admitted += t.admitted;
  into.admittedByBypass += t.admittedByBypass;
  into.rejected += t.rejected;
  into.grossRUnmeasurable += t.grossRUnmeasurable;
  into.rejectedMeasured += t.rejectedMeasured;
  into.rejectedMeasuredGrossRSum += t.rejectedMeasuredGrossRSum;
  if (t.maxRejectedGrossR !== null) {
    into.maxRejectedGrossR =
      into.maxRejectedGrossR === null ? t.maxRejectedGrossR : Math.max(into.maxRejectedGrossR, t.maxRejectedGrossR);
  }
}

/**
 * TRA-2355 — the spread-ceiling counters for ONE account class within a
 * (etDay × structure) cell. Only the spread-gate axis is partitioned: the cost bar
 * and the delta ceiling are not what this ticket found pooled, and widening the
 * split to them would add three empty sub-objects per structure for no reader.
 */
interface SpreadCeilingClassTally {
  admitted: number;
  rejected: number;
  rejectedSpreadPctSum: number;
  maxAdmittedSpreadPct: number | null;
  rejectsByCode: Map<string, number>;
}

function newClassTally(): SpreadCeilingClassTally {
  return {
    admitted: 0,
    rejected: 0,
    rejectedSpreadPctSum: 0,
    maxAdmittedSpreadPct: null,
    rejectsByCode: new Map(),
  };
}

interface StructureTally {
  admitted: number;
  rejected: number;
  admittedGrossRSum: number;
  rejectedGrossRSum: number;
  /**
   * TRA-4439 — the bypass / fill / measured-reject counters for the POOLED cost bar,
   * in the same shape as a class slice. Its `admitted`/`rejected` duplicate the two
   * fields above by construction (both written in {@link apply}'s cost-bar branch).
   */
  costBar: CostBarClassTally;
  /** TRA-4439 D1 — gross-R sum of the MERIT admits only (bypass admits excluded). */
  admittedOnMeritGrossRSum: number;
  /** TRA-4439 D5 — the cost-bar counters partitioned by owning account class. */
  costBarByAccountClass: Map<SpreadCeilingAccountClass, CostBarClassTally>;
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
  /** TRA-2295 — candidates the SPREAD ceiling admitted (it ran and they were inside it). */
  spreadCeilingAdmitted: number;
  /** TRA-2295 — candidates the SPREAD ceiling refused. Disjoint from every counter above. */
  spreadCeilingRejected: number;
  /** Sum of the refused `spreadPct`s, for the mean in the health view. */
  spreadCeilingRejectedSpreadPctSum: number;
  /**
   * TRA-2295 — the LARGEST `spreadPct` the gate let through, `null` when it has admitted
   * nothing. THE invariant field: an enforcing gate can never publish a value above its
   * own ceiling, so this is the live-telemetry twin of the journal check in the ticket's
   * verification step, readable without re-deriving anything from the journal.
   */
  spreadCeilingMaxAdmittedSpreadPct: number | null;
  /** TRA-2295 — refusals split by which threshold bit. */
  spreadCeilingRejectsByCode: Map<string, number>;
  /**
   * TRA-2355 — the SAME spread-ceiling counters, partitioned by owning account class.
   *
   * Every field above this one is POOLED across every book in the process, and that is
   * the defect: `SignalEngine` is constructed per username (`user-context.ts`), the
   * tally is module-global, and ~51 QA fixture books scan into it alongside the desk.
   * So `spreadCeilingEvaluated > 0` never meant "the desk sleeve ran" — only that SOME
   * book did, and the fixture fleet is a live producer of this exact cohort (64 of 151
   * pre-fix directional rows). On a session where the desk fires zero directional
   * entries — a 2-in-5 event — the fixture fleet alone yields `evaluated > 0` plus a
   * fixture `maxAdmittedSpreadPct` inside the ceiling, which reads exactly like a
   * desk PASS. Read `byAccountClass.desk` before believing any of the pooled fields.
   */
  spreadCeilingByAccountClass: Map<SpreadCeilingAccountClass, SpreadCeilingClassTally>;
}

/** Fetch-or-create one class sub-tally. */
function classTally(t: StructureTally, klass: SpreadCeilingAccountClass): SpreadCeilingClassTally {
  let c = t.spreadCeilingByAccountClass.get(klass);
  if (!c) {
    c = newClassTally();
    t.spreadCeilingByAccountClass.set(klass, c);
  }
  return c;
}

/**
 * One zeroed tally. Factored out because the shape is built in three places (live
 * apply, retained fold, and any future roll) and a field added to one but not the
 * others reads as a silent zero on whichever view missed it.
 *
 * `lastBarR` is NOT seeded from the creating record: see the TRA-1707 note in
 * {@link apply}. `spreadCeilingMaxAdmittedSpreadPct` starts `null` for the same
 * reason — 0 is a spread a reader would act on, "never measured" is not.
 */
function newTally(): StructureTally {
  return {
    admitted: 0,
    rejected: 0,
    admittedGrossRSum: 0,
    rejectedGrossRSum: 0,
    costBar: newCostBarClassTally(),
    admittedOnMeritGrossRSum: 0,
    costBarByAccountClass: new Map(),
    lastBarR: null,
    deltaCeilingRejected: 0,
    deltaCeilingAbsDeltaSum: 0,
    deltaCeilingObserved: 0,
    deltaCeilingObservedAbsDeltaSum: 0,
    spreadCeilingAdmitted: 0,
    spreadCeilingRejected: 0,
    spreadCeilingRejectedSpreadPctSum: 0,
    spreadCeilingMaxAdmittedSpreadPct: null,
    spreadCeilingRejectsByCode: new Map(),
    spreadCeilingByAccountClass: new Map(),
  };
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
// TRA-1681 — durability provenance. `byDay` is fed by BOTH the boot hydrate and the
// live pass, and once folded the two are indistinguishable. These say which.
/** Records/days recovered FROM DISK at boot (0 after a reboot on an ephemeral mount). */
let hydratedRecords = 0;
let hydratedDays = 0;
/** Appends that threw and were swallowed. > 0 ⇒ rows the counters show are NOT on disk. */
let appendErrors = 0;
let lastAppendError: string | null = null;
// TRA-2948 — census of retained spread-ceiling decisions by the classifier hash each
// one was STAMPED under. Module-global like `byDay` (fed identically by hydrate and
// live pass), covering exactly the retained window, because the question it answers —
// "can a classifier change explain a split between the two ceiling surfaces?" — is a
// window property, not a day property.
const spreadDecisionsByClassifier = new Map<string, number>();
/** Retained spread decisions written before TRA-2948 (no stamp). Indeterminate, never "current". */
let spreadDecisionsUnstamped = 0;

// ── TRA-4904 — compaction outcome + the append interlock ─────────────────────
//
// `lastCompaction` is the OUTCOME of the most recent compaction (boot or timer).
// A `RETAIN_MS` that ships without a working hook reads identically to one that
// works — the reversal-shadow ledger's AC5 lesson, copied verbatim — so the outcome
// is published, never the constant alone.
let lastCompaction: CostAwareGateCompaction | null = null;
/** Timer fires that completed (any outcome). 0 with an armed timer ⇒ the hook is not running. */
let timerCompactions = 0;
/** True while an async rewrite is between its read and its write. */
let compactionInFlight = false;
/**
 * Lines a live decision produced WHILE a rewrite was in flight.
 *
 * THIS IS THE INTERLOCK, and it is why the periodic compaction is safe to run
 * mid-session at all. The boot compaction cannot lose an append because it completes
 * before the engine ticks; a timer rewrite has no such ordering, so an
 * `appendFileSync` landing between the async read and the async write would be
 * silently erased by the write — a lost row that reads identically to a row that was
 * never recorded, on the one counter family whose whole purpose is that a missing
 * write must be visible (TRA-1681). Buffering instead of writing is exact rather
 * than probabilistic: appends are synchronous and this process is single-threaded,
 * so nothing can reach the file while the flag is up, and the buffer is flushed in a
 * `finally` — a FAILED rewrite still gets its rows appended to the un-rewritten file.
 */
const pendingAppends: string[] = [];

export function costAwareGateLogPath(dir: string): string {
  return join(dir, COST_AWARE_GATE_LOG_FILENAME);
}

/** Test seam — drop every counter and the configured dir. */
export function clearCostAwareGateLedger(): void {
  dataDir = null;
  byDay.clear();
  decisionsTotal = 0;
  lastDecisionAt = null;
  hydratedRecords = 0;
  hydratedDays = 0;
  appendErrors = 0;
  lastAppendError = null;
  spreadDecisionsByClassifier.clear();
  spreadDecisionsUnstamped = 0;
  lastCompaction = null;
  timerCompactions = 0;
  compactionInFlight = false;
  pendingAppends.length = 0;
}

/**
 * TRA-2355 — a record's account class, fail-closed. An absent or unrecognised value
 * is `unattributed`, NEVER `desk`: every pre-TRA-2355 JSONL line lacks the field, and
 * hydrating those into `desk` would fabricate desk evidence from records whose owner
 * is genuinely unknown. `unattributed` is a third answer, not a softer `desk`.
 */
function recAccountClass(rec: CostGateDecisionRecord): SpreadCeilingAccountClass {
  return SPREAD_CEILING_ACCOUNT_CLASSES.includes(rec.accountClass as SpreadCeilingAccountClass)
    ? (rec.accountClass as SpreadCeilingAccountClass)
    : 'unattributed';
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
    // NOT seeded from `rec` — the record that CREATES this tally may be a ceiling record,
    // which carries `barR: 0` and never writes the field again on its own branch. Seeding
    // from it published `barR: 0.00` on a structure whose bar is live, and an absent bar
    // and a live bar then read identically (TRA-1707). Only the cost-bar branches below
    // may set it.
    tally = newTally();
    day.set(rec.structure, tally);
  }
  if (rec.gate === 'spread_ceiling' || rec.gate === 'spread_ceiling_admitted') {
    // TRA-2948 — census the stamp in the SAME pass that tallies the decision, so the
    // provenance counts and the class counts can never describe different populations.
    if (typeof rec.classifierHash === 'string' && rec.classifierHash !== '') {
      spreadDecisionsByClassifier.set(
        rec.classifierHash,
        (spreadDecisionsByClassifier.get(rec.classifierHash) ?? 0) + 1,
      );
    } else {
      spreadDecisionsUnstamped += 1;
    }
  }
  if (rec.gate === 'spread_ceiling') {
    // TRA-2295 — the spread gate REFUSED this candidate. Its own axis: it is neither a
    // modeled-R verdict nor a delta breach, and folding it into `rejected` would move the
    // cost bar's admit rate for a reason that has nothing to do with the cost bar.
    //
    // TRA-2355 — the pooled field and the account-class field are written in the SAME
    // branch, off the SAME record, deliberately. A partition maintained in a separate
    // pass can fall out of step with the total it partitions, and a class breakdown that
    // silently under-counts is worse than none: it reads as a quiet desk.
    const code = typeof rec.code === 'string' && rec.code !== '' ? rec.code : 'unknown';
    const spreadPct = Number.isFinite(rec.spreadPct) ? (rec.spreadPct as number) : 0;
    tally.spreadCeilingRejected += 1;
    tally.spreadCeilingRejectedSpreadPctSum += spreadPct;
    tally.spreadCeilingRejectsByCode.set(code, (tally.spreadCeilingRejectsByCode.get(code) ?? 0) + 1);
    const c = classTally(tally, recAccountClass(rec));
    c.rejected += 1;
    c.rejectedSpreadPctSum += spreadPct;
    c.rejectsByCode.set(code, (c.rejectsByCode.get(code) ?? 0) + 1);
  } else if (rec.gate === 'spread_ceiling_admitted') {
    // TRA-2295 — the spread gate RAN and let this one through. Recorded because the
    // absence of this counter is what made the unenforced ceiling invisible for 83 fills:
    // without it, `spreadCeilingRejected: 0` cannot be told from a gate that never ran.
    tally.spreadCeilingAdmitted += 1;
    const c = classTally(tally, recAccountClass(rec));
    c.admitted += 1;
    if (Number.isFinite(rec.spreadPct)) {
      const p = rec.spreadPct as number;
      const prev = tally.spreadCeilingMaxAdmittedSpreadPct;
      tally.spreadCeilingMaxAdmittedSpreadPct = prev === null ? p : Math.max(prev, p);
      c.maxAdmittedSpreadPct = c.maxAdmittedSpreadPct === null ? p : Math.max(c.maxAdmittedSpreadPct, p);
    }
  } else if (rec.gate === 'delta_ceiling') {
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
  } else {
    // A cost-bar verdict. TRA-4439 — the pooled fields and the class partition are
    // written in the SAME branch off the SAME record (the TRA-2355 rule), so the
    // partition cannot fall out of step with the total it partitions.
    const klass = recAccountClass(rec);
    let c = tally.costBarByAccountClass.get(klass);
    if (!c) {
      c = newCostBarClassTally();
      tally.costBarByAccountClass.set(klass, c);
    }
    applyCostBar(tally.costBar, rec);
    applyCostBar(c, rec);
    if (rec.admit) {
      tally.admitted += 1;
      tally.admittedGrossRSum += rec.grossR;
      if (!rec.bypass) tally.admittedOnMeritGrossRSum += rec.grossR;
    } else {
      tally.rejected += 1;
      tally.rejectedGrossRSum += rec.grossR;
    }
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
 *
 * TRA-4439 — that 0 FILL is now MARKED (`grossRUnmeasurable`), counted, and kept out
 * of the measured mean/max: `tapeEdgeR` is NaN on every `insufficient_evidence` cell,
 * so an uncounted fill silently blended "no score" into the rejected-gross-R mean.
 * `opts` carries the owning book's CLASS (D5 — frozen at decision time like the
 * spread records; absent ⇒ `unattributed`, never `desk`) and the BYPASS that
 * granted an admit the bar did not (D1).
 */
export function recordCostAwareGateDecision(
  structure: string,
  admit: boolean,
  grossR: number,
  barR: number,
  etDay: string,
  now: number = Date.now(),
  opts: { accountClass?: SpreadCeilingAccountClass; bypass?: CostBarBypass } = {},
): void {
  const rec: CostGateDecisionRecord = {
    ts: now,
    etDay,
    structure,
    admit,
    grossR: Number.isFinite(grossR) ? grossR : 0,
    barR: Number.isFinite(barR) ? barR : 0,
    gate: 'cost_bar',
    ...(Number.isFinite(grossR) ? {} : { grossRUnmeasurable: true as const }),
    ...(opts.accountClass ? { accountClass: opts.accountClass } : {}),
    ...(admit && opts.bypass ? { bypass: opts.bypass } : {}),
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

/**
 * TRA-2295 — record ONE spread-ceiling verdict, admitted or rejected.
 *
 * BOTH outcomes are written, and that is the point of the ticket. The directional
 * sleeve opened 83 positions against a 0.10 ceiling it never evaluated — 59 of them
 * over it, worst 19× — and no counter anywhere moved, because the only thing anyone
 * would have thought to count was rejections, and an unenforced gate rejects exactly
 * as many candidates as a gate with nothing to reject. `spreadCeilingEvaluated` is
 * the separator: it is 0 if and only if the gate did not run.
 *
 * `admit: rec.admit` mirrors what the engine ACTUALLY DID (the TRA-1689 rule), so a
 * replay of the JSONL never invents a trade that did not happen. Same durability and
 * best-effort IO as every other recorder here.
 *
 * ── TRA-2355 — `accountClass` IS REQUIRED, AND SECOND ────────────────────────
 * It sits beside `structure` because the two together are the cohort key: a count is
 * only evidence about a book once you know WHICH book produced it. It has no default
 * for the same reason the parameter exists at all — a defaulted class would let a new
 * call site compile into the pooled counter and reproduce this ticket in silence,
 * whereas a required one makes the compiler name every site that has to decide.
 *
 * ── TRA-2948 — the record also stamps `classifierHash` ───────────────────────
 * The hash of the classifier in effect at THIS moment, from the same `env` the
 * caller classified under (callers classify with the process env; the optional
 * `env` parameter exists so a test can freeze both halves on one input). The class
 * answers "which book"; the hash answers "under which rules that answer was
 * computed", which is what a reader needs when this frozen class later disagrees
 * with a read-time reclassification of the same account string.
 */
export function recordSpreadCeilingDecision(
  structure: string,
  accountClass: SpreadCeilingAccountClass,
  admit: boolean,
  spreadPct: number | null,
  code: string,
  etDay: string,
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  applyAndAppend({
    ts: now,
    etDay,
    structure,
    admit,
    grossR: 0,
    barR: 0,
    gate: admit ? 'spread_ceiling_admitted' : 'spread_ceiling',
    ...(spreadPct !== null && Number.isFinite(spreadPct) ? { spreadPct } : {}),
    code,
    accountClass,
    classifierHash: testAccountClassifierIdentity(env).hash,
  });
}

function applyAndAppend(rec: CostGateDecisionRecord): void {
  // NOTE the ordering, and that it is deliberate: the in-memory tally updates FIRST and
  // UNCONDITIONALLY, then the disk write is attempted best-effort. That keeps accounting
  // from ever breaking a trade pass — but it also means the counters this module publishes
  // are NOT evidence that anything reached disk. A memory-only ledger (`dataDir == null`)
  // and an append that threw both leave every count looking exactly as healthy as a clean
  // durable write. `durability` below is the field that tells them apart (TRA-1681).
  apply(rec);
  if (dataDir == null) return;
  const line = JSON.stringify(rec) + '\n';
  // TRA-4904 — a rewrite is between its read and its write; writing now would be
  // erased by it. Buffer and let the rewrite's `finally` flush. See
  // {@link pendingAppends}.
  if (compactionInFlight) {
    pendingAppends.push(line);
    return;
  }
  appendRawLine(dataDir, line);
}

/**
 * Append one already-serialized JSONL line, best-effort. Factored out of
 * {@link applyAndAppend} (TRA-4904) so the compaction's buffer flush writes through
 * the SAME error accounting — a flush that swallowed silently would put the lost-row
 * shape back one layer down.
 */
function appendRawLine(dir: string, line: string): void {
  const path = costAwareGateLogPath(dir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, line, 'utf8');
  } catch (err) {
    // Swallowed so the trade pass survives — but COUNTED, so the swallow is not silent.
    // An uncounted swallow is how a lost row reads identically to a written one.
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('cost-aware-gate append failed', { reason: lastAppendError });
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
    const KNOWN_KINDS: readonly CostGateKind[] = [
      'delta_ceiling',
      'delta_ceiling_observed',
      'spread_ceiling',
      'spread_ceiling_admitted',
    ];
    const gate: CostGateKind = KNOWN_KINDS.includes(rec.gate as CostGateKind)
      ? (rec.gate as CostGateKind)
      : 'cost_bar';
    const isSpread = gate === 'spread_ceiling' || gate === 'spread_ceiling_admitted';
    const isDelta = gate === 'delta_ceiling' || gate === 'delta_ceiling_observed';
    const isCostBar = gate === 'cost_bar';
    const clean: CostGateDecisionRecord = {
      ts: rec.ts,
      etDay: rec.etDay,
      structure: rec.structure,
      admit: rec.admit,
      grossR: Number.isFinite(rec.grossR) ? rec.grossR : 0,
      barR: Number.isFinite(rec.barR) ? rec.barR : 0,
      // Pre-TRA-1670 lines carry no `gate` — they are cost-bar verdicts by construction.
      gate,
      ...(isDelta ? { absDelta: Number.isFinite(rec.absDelta) ? (rec.absDelta as number) : 0 } : {}),
      // TRA-2295 — `spreadPct` is OMITTED, not zero-filled, when unmeasurable. A
      // `no_quote` reject has no spread by definition, and writing 0 would drag
      // `avgRejectedSpreadPct` toward zero and, worse, let a compacted rewrite publish
      // `maxAdmittedSpreadPct: 0` on a gate that admitted something wide.
      ...(isSpread && Number.isFinite(rec.spreadPct) ? { spreadPct: rec.spreadPct as number } : {}),
      ...(isSpread ? { code: typeof rec.code === 'string' && rec.code !== '' ? rec.code : 'unknown' } : {}),
      // TRA-2355 — the account class must SURVIVE the rewrite below, for exactly the
      // TRA-1703 reason one field over: compaction rewrites the file to these sanitized
      // lines, so a field dropped here is not merely missing from this boot's counters —
      // it is ERASED FROM DISK. Dropping it would silently re-pool every retained day
      // into `unattributed` on the first reboot, and the desk partition would read `0`
      // for a week of sessions the desk actually traded.
      ...(isSpread ? { accountClass: recAccountClass(rec) } : {}),
      // TRA-4439 — the cost-bar class, bypass tag and fill marker survive the rewrite
      // for the TRA-1703 reason: a field dropped here is ERASED FROM DISK. A class is
      // kept only when present (absent hydrates as `unattributed` and is never
      // back-filled); a pre-TRA-4439 line never gains a bypass tag.
      ...(isCostBar && rec.accountClass !== undefined ? { accountClass: recAccountClass(rec) } : {}),
      ...(isCostBar && rec.admit && rec.bypass === 'exploration_allowance' ? { bypass: rec.bypass } : {}),
      ...(isCostBar && (rec.grossRUnmeasurable === true || !Number.isFinite(rec.grossR))
        ? { grossRUnmeasurable: true as const }
        : {}),
      // TRA-2948 — the classifier stamp must ALSO survive the rewrite, for the same
      // reason: compaction erased fields stay erased. Dropping it would re-mark every
      // retained decision UNSTAMPED on the first reboot, and the provenance read would
      // permanently answer "indeterminate" on a window that was fully stamped. An
      // absent/blank stamp on a pre-TRA-2948 line is preserved as absent — it must
      // never be back-filled with the CURRENT hash, which would fabricate exactly the
      // "computed under today's rules" evidence the stamp exists to withhold.
      ...(isSpread && typeof rec.classifierHash === 'string' && rec.classifierHash !== ''
        ? { classifierHash: rec.classifierHash }
        : {}),
    };
    apply(clean);
    kept.push(JSON.stringify(clean));
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped when
  // there is nothing to drop, to avoid a needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  const bytesBefore = Buffer.byteLength(raw, 'utf8');
  let bytesAfter = bytesBefore;
  let rewrote = false;
  let error: string | undefined;
  if (kept.length < nonEmptyLines) {
    const path = costAwareGateLogPath(dir);
    const next = kept.length > 0 ? kept.join('\n') + '\n' : '';
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next, 'utf8');
      rewrote = true;
      bytesAfter = Buffer.byteLength(next, 'utf8');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.warn('cost-aware-gate compaction failed', { reason: error });
    }
  }
  // TRA-4904 — PUBLISH the boot outcome, not just the constant. Before this the boot
  // compaction was completely unobservable: a `RETAIN_MS` whose rewrite silently threw
  // every boot read exactly like one that worked, which is the same shape as the
  // "armed-but-inert" trap this whole module exists to remove.
  lastCompaction = {
    trigger: 'boot',
    ranAt: new Date(now).toISOString(),
    cutoff: new Date(cutoff).toISOString(),
    retentionDays: COST_AWARE_GATE_RETENTION_DAYS,
    linesBefore: nonEmptyLines,
    linesAfter: kept.length,
    linesDropped: nonEmptyLines - kept.length,
    bytesBefore,
    bytesAfter,
    rewrote,
    rewriteBasis: 'sanitized',
    bufferedAppendsFlushed: 0,
    ...(error ? { error } : {}),
  };

  // TRA-1681 — freeze what came OFF DISK, before the live pass starts folding its own
  // decisions into the same `byDay`. After the first live record the two are one map and
  // no consumer can tell "recovered a week of history" from "this uptime, nothing under me".
  hydratedRecords = kept.length;
  hydratedDays = byDay.size;
  return { days: byDay.size, records: kept.length };
}

// ── TRA-4904 — the PERIODIC compaction ───────────────────────────────────────

/**
 * What a compaction actually DID — boot or timer. Modelled on
 * `ReversalShadowCompaction` (`reversal-shadow-ledger.ts`), which exists for the same
 * reason and states it best: *a `RETAIN_MS` that ships without a working hook reads
 * identically to one that works*. Published on `/api/health/cost-aware-gate`.
 */
export interface CostAwareGateCompaction {
  /**
   * WHICH hook produced this outcome. `timer` is the TRA-4904 addition and it is the
   * field that answers "is the periodic hook running at all" — a build where the
   * interval was never armed publishes `boot` forever, which is exactly the state
   * this ticket found.
   */
  trigger: 'boot' | 'timer';
  /** ISO time the compaction ran. */
  ranAt: string;
  /** Cutoff applied (ISO): rows with `ts` below this are dropped. */
  cutoff: string;
  /** {@link RETAIN_MS} in days, so the cutoff can be checked against the horizon. */
  retentionDays: number;
  /** Non-empty JSONL lines on disk before / after. */
  linesBefore: number;
  linesAfter: number;
  linesDropped: number;
  /** File size before / after, bytes. Equal when nothing was dropped. */
  bytesBefore: number;
  bytesAfter: number;
  /** False when nothing aged out — no needless rewrite of a ~70 MiB file. */
  rewrote: boolean;
  /**
   * HOW the retained lines were written back.
   *
   * `sanitized` (boot) re-serializes every line through the hydrate's field
   * whitelist, which is why this module has twice had to fix a field the rewrite
   * ERASED FROM DISK (TRA-1703, TRA-2355). `verbatim-suffix` (timer) copies the
   * retained bytes through untouched, so a field added after this code ships survives
   * a compaction that predates it — the discipline `reversal-shadow-ledger.ts` adopted
   * after watching those two tickets. The boot path keeps its sanitizing rewrite
   * because it is also the hydrate, and changing both at once would mix a size fix
   * with a durability change.
   */
  rewriteBasis: 'sanitized' | 'verbatim-suffix';
  /** Live appends buffered during the rewrite and appended after it (the interlock worked). */
  bufferedAppendsFlushed: number;
  /**
   * Timer only: the prefix scan hit a line whose `ts` it could not read and STOPPED
   * there rather than guess. Nothing young was dropped; the boot compaction (which
   * parses every line) clears whatever this stalled on.
   */
  stoppedOnUnreadableTs?: true;
  /** Set when the rewrite itself failed. The retention horizon is unchanged; disk is not compacted. */
  error?: string;
  /** Set when no work was attempted, naming why. Never silently reported as a clean pass. */
  skipped?: 'no_data_dir' | 'already_in_flight' | 'no_file';
}

/** The compaction hook's configuration AND its last outcome — see {@link costAwareGateCompaction}. */
export interface CostAwareGateCompactionState {
  retentionDays: number;
  /** {@link COST_AWARE_GATE_COMPACTION_INTERVAL_MS}. The overshoot premium is `interval / retain`. */
  intervalMs: number;
  /**
   * Timer fires completed this uptime. **This is the liveness field.** 0 on a process
   * that has been up longer than `intervalMs` means the interval is NOT armed, however
   * healthy `last` looks — the boot compaction alone would leave `last.trigger: 'boot'`
   * and every byte field looking perfectly ordinary.
   */
  timerCompactions: number;
  /** The most recent outcome (boot or timer). `null` before the ledger has been hydrated. */
  last: CostAwareGateCompaction | null;
  note: string;
}

/**
 * The compaction hook's state for `/api/health/cost-aware-gate` (TRA-4904 AC2).
 * Read `timerCompactions` before `last`: a working constant and a dead timer publish
 * the same `last`.
 */
export function costAwareGateCompaction(): CostAwareGateCompactionState {
  return {
    retentionDays: COST_AWARE_GATE_RETENTION_DAYS,
    intervalMs: COST_AWARE_GATE_COMPACTION_INTERVAL_MS,
    timerCompactions,
    last: lastCompaction,
    note:
      'TRA-4904. This tape pairs the highest write rate in /data (9.98 MiB/day) with the SHORTEST '
      + 'retention (7d vs 30d on every sibling), so a boot-only compaction carried up to one boot '
      + 'interval of aged rows: premium bootGap/retain = +70.4% (119.1 MiB worst case against a ~73 MiB '
      + 'steady state, 45.9 MiB of overshoot). The cutoff is now re-applied on a '
      + `${COST_AWARE_GATE_COMPACTION_INTERVAL_MS / (60 * 60 * 1000)}h timer as well as at boot, which caps the premium at `
      + `${(100 * COST_AWARE_GATE_COMPACTION_INTERVAL_MS / RETAIN_MS).toFixed(1)}% — under the 30-day tapes' 16.4%. `
      + 'READ `timerCompactions` FIRST: it is 0 if and only if the periodic hook is not running, and a '
      + 'dead hook is indistinguishable from a live one by any other field here. The three 30-day tapes '
      + '(live-enforce-gate, reversal-shadow-signals, churn-brake-guard) are deliberately NOT on this '
      + 'timer — see docs/tra4899-data-tape-budget.md AC4 for the uptime that would change that.',
  };
}

/** Lines scanned between event-loop yields — see {@link compactCostAwareGateLedgerNow}. */
const COMPACTION_SCAN_CHUNK_LINES = 25_000;

function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Read `ts` off a raw JSONL line WITHOUT parsing it. Every line this module writes is
 * `JSON.stringify` of an object whose FIRST key is `ts`, so the number is in the first
 * few dozen bytes. `null` means "could not read it", never a guess.
 *
 * A full `JSON.parse` per line is what makes the boot hydrate affordable only once: at
 * the worst-case ~1.7M lines it is seconds of BLOCKED EVENT LOOP, and this hook runs
 * four times a day on a live money box — straight into the TRA-2111 yield-preempt
 * tripwire (which already fired at 1080 ms on a sync `doTick` segment). The periodic
 * path therefore never parses a line it keeps.
 */
function extractLineTs(line: string): number | null {
  const m = /"ts":\s*(-?\d+(?:\.\d+)?)/.exec(line.slice(0, 64));
  if (!m) return null;
  const ts = Number(m[1]);
  return Number.isFinite(ts) ? ts : null;
}

/** Count JSONL lines natively — one O(len) newline walk, no per-line allocation. */
function countJsonlLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n += 1;
  if (!s.endsWith('\n')) n += 1; // a torn/unterminated trailing line is still a line
  return n;
}

/**
 * TRA-4904 — re-apply {@link RETAIN_MS} TO DISK without a reboot. The timer body; also
 * callable directly (tests, and a one-off from a route if one is ever wanted).
 *
 * ── WHAT IT DROPS, AND WHY ONLY A PREFIX ─────────────────────────────────────
 * It drops the maximal CONTIGUOUS PREFIX of lines whose `ts` is below the cutoff and
 * keeps the remaining bytes verbatim. Records are appended in decision order, so that
 * prefix IS the aged window in every normal file — and the rule is safe in the one
 * case it is not: an out-of-order old row hiding behind a young one is simply kept
 * until the next boot compaction (which sorts nothing but validates every line
 * individually). The failure direction matters here — dropping a row that is still
 * inside the window would delete live evidence from the tape a ceiling tripwire reads,
 * while keeping one row too long costs bytes. This scan cannot do the former.
 *
 * Consequences, both deliberate:
 *   • Work is O(dropped), not O(file). In steady state the prefix is one interval of
 *     rows (~2.6 MiB) and the retained ~70 MiB is never scanned or re-serialized.
 *   • The retained bytes are echoed, so no field can be erased by this rewrite
 *     (see {@link CostAwareGateCompaction.rewriteBasis}).
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
 * It does not touch the IN-MEMORY fold. `byDay` is fed by both the hydrate and the
 * live pass and its provenance counters (`hydratedRecords`, the TRA-2948 classifier
 * census) are window-scoped rather than day-keyed, so pruning it here would need those
 * counters re-keyed by ET day first. The consequence is that on an uptime longer than
 * the retention, `retained.etDays` spans more days than `retained.retentionDays`
 * claims — a pre-existing reporting gap, unchanged by this ticket and tracked
 * separately. No byte of `/data` depends on it.
 *
 * The rewrite is tmp-file + rename because it now runs 4x/day on the money box rather
 * than once per boot: a crash midway through an in-place `writeFile` of a 70 MiB tape
 * truncates it, and multiplying that exposure by every deploy-free day is not a trade
 * worth making for one fewer syscall.
 */
export async function compactCostAwareGateLedgerNow(
  now: number = Date.now(),
): Promise<CostAwareGateCompaction> {
  const cutoff = now - RETAIN_MS;
  const base = {
    trigger: 'timer' as const,
    ranAt: new Date(now).toISOString(),
    cutoff: new Date(cutoff).toISOString(),
    retentionDays: COST_AWARE_GATE_RETENTION_DAYS,
    rewriteBasis: 'verbatim-suffix' as const,
    bufferedAppendsFlushed: 0,
    linesBefore: 0,
    linesAfter: 0,
    linesDropped: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    rewrote: false,
  };

  // No boot hydrate ran (unit tests / CLI): nothing is durable, so there is nothing to
  // compact. Named, never reported as a clean pass.
  if (dataDir == null) {
    const out: CostAwareGateCompaction = { ...base, skipped: 'no_data_dir' };
    lastCompaction = out;
    timerCompactions += 1;
    return out;
  }
  // An overlapping fire would read the file the in-flight one is about to replace. Not
  // counted as a fire and it does NOT overwrite the last real outcome.
  if (compactionInFlight) {
    return { ...base, skipped: 'already_in_flight' };
  }

  const dir = dataDir;
  const path = costAwareGateLogPath(dir);

  /**
   * The pass itself. Separated from the interlock below because the flush has to be
   * OUTSIDE it: a `finally` that mutates the result cannot change what an inner
   * `return` already captured, so publishing from a `finally` would have shipped a
   * payload whose `bufferedAppendsFlushed` was always 0 while the real flush happened
   * invisibly — a field that reads identically whether or not the interlock works,
   * which is the exact defect class this ticket is fixing one level up.
   */
  const runPass = async (): Promise<CostAwareGateCompaction> => {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      // Missing (nothing written yet) or unreadable — the append path surfaces write
      // failures; there is nothing for a compaction to do either way.
      return { ...base, skipped: 'no_file' };
    }

    let start = 0;
    let scanned = 0;
    let stoppedOnUnreadableTs = false;
    while (start < raw.length) {
      const nl = raw.indexOf('\n', start);
      const end = nl === -1 ? raw.length : nl;
      const line = raw.slice(start, end);
      if (line.trim() !== '') {
        const ts = extractLineTs(line);
        if (ts === null) {
          stoppedOnUnreadableTs = true;
          break;
        }
        if (ts >= cutoff) break; // first retained line — everything from here is kept
      }
      start = nl === -1 ? raw.length : end + 1;
      if ((scanned += 1) % COMPACTION_SCAN_CHUNK_LINES === 0) await yieldToLoop();
    }

    const bytesBefore = Buffer.byteLength(raw, 'utf8');
    const linesBefore = countJsonlLines(raw);
    if (start === 0) {
      // Nothing aged out. Do NOT rewrite: at ~70 MiB a needless rewrite four times a
      // day is the cost this ticket is trying to remove, not add.
      return {
        ...base,
        linesBefore,
        linesAfter: linesBefore,
        bytesBefore,
        bytesAfter: bytesBefore,
        ...(stoppedOnUnreadableTs ? { stoppedOnUnreadableTs: true as const } : {}),
      };
    }

    const next = raw.slice(start);
    const linesAfter = countJsonlLines(next);
    let bytesAfter = Buffer.byteLength(next, 'utf8');
    let rewrote = false;
    let error: string | undefined;
    const tmp = `${path}.compact-${process.pid}-${now}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, next, 'utf8');
      await rename(tmp, path);
      rewrote = true;
      bytesAfter = await stat(path).then((s) => s.size).catch(() => bytesAfter);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      await rm(tmp, { force: true }).catch(() => {});
      bytesAfter = bytesBefore; // the file is untouched
      log.warn('cost-aware-gate periodic compaction failed', { reason: error });
    }
    return {
      ...base,
      linesBefore,
      linesAfter: rewrote ? linesAfter : linesBefore,
      linesDropped: rewrote ? linesBefore - linesAfter : 0,
      bytesBefore,
      bytesAfter,
      rewrote,
      ...(stoppedOnUnreadableTs ? { stoppedOnUnreadableTs: true as const } : {}),
      ...(error ? { error } : {}),
    };
  };

  let out: CostAwareGateCompaction;
  compactionInFlight = true;
  try {
    out = await runPass();
  } catch (err) {
    // Defensive: an unexpected throw must still release the interlock and flush, or the
    // buffer keeps growing and every subsequent append goes to memory only.
    out = { ...base, error: err instanceof Error ? err.message : String(err) };
    log.warn('cost-aware-gate periodic compaction threw', { reason: out.error });
  } finally {
    // Drop the flag BEFORE the flush so the flush writes through instead of
    // re-buffering itself.
    compactionInFlight = false;
  }
  // A failed rewrite still flushes — those rows are already in the in-memory tally, and
  // a buffered row that never reaches disk is the lost-write shape `durability` exists
  // to make visible (TRA-1681).
  const buffered = pendingAppends.splice(0, pendingAppends.length);
  for (const line of buffered) appendRawLine(dir, line);
  out = { ...out, bufferedAppendsFlushed: buffered.length };
  lastCompaction = out;
  timerCompactions += 1;
  if (out.rewrote || out.error !== undefined || out.skipped !== undefined) {
    log.info('cost-aware-gate ledger compacted (TRA-4904)', out as unknown as Record<string, unknown>);
  }
  return out;
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
  /**
   * Mean modeled gross R of the candidates the bar REFUSED (null when none).
   * ⚠️ INCLUDES the `grossRUnmeasurable` 0 FILLS (kept byte-compatible, TRA-2079) —
   * grade `avgRejectedGrossRMeasured` instead.
   */
  avgRejectedGrossR: number | null;
  /**
   * TRA-4439 D1 — of `admitted`, how many a named BYPASS granted (the TRA-4378
   * exploration allowance) rather than the bar. ⚠️ A LOWER bound on a window reaching
   * before TRA-4439: older bypass admits carry no tag and count as merit — which is why
   * `avgAdmittedOnMeritGrossR` ships beside it as the cross-check.
   */
  admittedByBypass: number;
  /** TRA-4439 D1 — `admitted - admittedByBypass`: what the bar itself cleared. */
  admittedOnMerit: number;
  /** TRA-4439 D1 — mean gross R of the merit admits (null when none). A real bar admit sits ≥ `barR`. */
  avgAdmittedOnMeritGrossR: number | null;
  /**
   * TRA-4439 D2 — cost-bar decisions whose `grossR` is a 0 FILL for an unusable
   * estimator output (every `insufficient_evidence` cell). Emitted at 0. Pre-TRA-4439
   * lines are marked on hydrate only if their raw `grossR` was non-finite, so on a
   * window reaching before the fix this is a LOWER bound.
   */
  grossRUnmeasurable: number;
  /** TRA-4439 D2 — mean gross R of the rejects that HAD a score (fills excluded; null when none). */
  avgRejectedGrossRMeasured: number | null;
  /** TRA-4439 D2 — the LARGEST measured rejected gross R (null when none): the right-tail field. */
  maxRejectedGrossR: number | null;
  /**
   * TRA-4439 D3 — the ET days on which this structure's COST BAR ruled on ≥ 1
   * candidate. `retained.etDays` is the RETENTION window, not the sample span: a
   * structure that decided on one session inside a six-day window has ONE day here.
   */
  costBarDecisionEtDays: string[];
  /**
   * TRA-4439 D5 — the cost-bar counters split by owning book. ALL THREE classes are
   * emitted even at zero (an absent cell reads like a passing one). `unattributed` is
   * every line written before TRA-4439; it is NOT desk. Read `desk` before believing
   * any pooled cost-bar field.
   */
  costBarByAccountClass: Record<SpreadCeilingAccountClass, CostAwareGateCostBarClassSummary>;
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

  // ── TRA-2295 — the SPREAD ceiling. Read `spreadCeilingEvaluated` FIRST. ─────
  /**
   * Candidates the spread gate RULED ON (admitted + rejected). **This is the field that
   * separates the two zero states**, and it exists because their conflation is the whole
   * bug: for 83 fills the directional sleeve's `spreadCeilingRejected` would have read 0
   * because the gate never ran, which is indistinguishable from 0 because every contract
   * was inside the ceiling.
   *
   *   `evaluated === 0`               ⇒ THE GATE DID NOT RUN on this structure/day.
   *   `evaluated > 0, rejected === 0` ⇒ it ran; nothing was outside the ceiling.
   *   `rejected > 0`                  ⇒ it ran and it is BITING.
   */
  spreadCeilingEvaluated: number;
  /** Candidates the spread gate REFUSED. Disjoint from `rejected` and the delta counters. */
  spreadCeilingRejected: number;
  /** rejected / evaluated — `null` when the gate ruled on nothing (never 0; see above). */
  spreadCeilingRejectRate: number | null;
  /** Mean `spreadPct` of the refused candidates (null when none / all unmeasurable). */
  avgRejectedSpreadPct: number | null;
  /**
   * THE INVARIANT: the widest `spreadPct` the gate ADMITTED, `null` when it admitted
   * nothing. An enforcing gate cannot publish a value above its sleeve's `maxSpreadPct`
   * — so this one number falsifies enforcement without touching the trade journal.
   */
  maxAdmittedSpreadPct: number | null;
  /** Refusals split by threshold (`max_spread_pct` / `min_bid` / `no_quote`). */
  spreadCeilingRejectsByCode: Record<string, number>;
  /**
   * TRA-2355 — THE SAME SPREAD COUNTERS, SPLIT BY OWNING BOOK. **Read `desk` before
   * you believe any pooled field above.**
   *
   * Every spread field above this one pools ~51 QA fixture books with the desk, because
   * the tally is module-global while `SignalEngine` is per-username. That makes
   * `spreadCeilingEvaluated > 0` mean "SOME book's gate ran", never "the desk's did" —
   * and the fixture fleet is a CURRENTLY-FIRING writer of this cohort, not a dormant
   * one. A session where the desk opens zero directional entries still publishes a
   * non-zero pooled `evaluated` and a fixture `maxAdmittedSpreadPct` inside the
   * ceiling: an instrument that reads IDENTICALLY in the pass state and the never-ran
   * state, which is the whole failure this partition removes.
   *
   * ALL THREE CLASSES ARE ALWAYS EMITTED, even at zero — an absent cell reads exactly
   * like a passing one (the TRA-2350 rule). `unattributed` is pre-TRA-2355 records
   * carrying no class; it is NOT desk.
   *
   *   `desk.spreadCeilingEvaluated === 0`  ⇒ NO DESK READING. Not a pass.
   *   `> 0` with `desk.spreadCeilingRejected === 0` ⇒ the desk's gate ran, nothing wide.
   *   `desk.maxAdmittedSpreadPct > ceiling` ⇒ falsification, on the desk book.
   */
  spreadCeilingByAccountClass: Record<SpreadCeilingAccountClass, CostAwareGateAccountClassSummary>;
}

/** TRA-4439 D5 — one account class's slice of a structure's COST-BAR counters. */
export interface CostAwareGateCostBarClassSummary {
  accountClass: SpreadCeilingAccountClass;
  admitted: number;
  admittedByBypass: number;
  rejected: number;
  /** 0 fills among this class's decisions — excluded from the mean and max below. */
  grossRUnmeasurable: number;
  /** Mean gross R of this class's MEASURED rejects (null when none). */
  avgRejectedGrossR: number | null;
  maxRejectedGrossR: number | null;
}

/**
 * TRA-2355 — one account class's slice of a structure's spread-ceiling counters.
 *
 * Deliberately carries the same null discipline as the pooled row it sits under:
 * `spreadCeilingRejectRate` and `maxAdmittedSpreadPct` are `null` — never 0 — when
 * this class's gate ruled on nothing, so "this book was quiet" cannot be misread as
 * "this book was clean".
 */
export interface CostAwareGateAccountClassSummary {
  accountClass: SpreadCeilingAccountClass;
  /** admitted + rejected FOR THIS CLASS. 0 ⇒ this book's gate did not run. */
  spreadCeilingEvaluated: number;
  spreadCeilingRejected: number;
  /** rejected / evaluated — `null` when this class ruled on nothing. */
  spreadCeilingRejectRate: number | null;
  /** Mean `spreadPct` of this class's refusals (null when none / all unmeasurable). */
  avgRejectedSpreadPct: number | null;
  /** The widest `spreadPct` THIS CLASS admitted. `null` when it admitted nothing. */
  maxAdmittedSpreadPct: number | null;
  spreadCeilingRejectsByCode: Record<string, number>;
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
  /**
   * TRA-2295 — spread-gate verdicts across the window. `spreadCeilingEvaluatedTotal === 0`
   * over a window in which the sleeve OPENED positions is the alarm: it means every one of
   * those opens bypassed the ceiling, which is the state this ticket found in production.
   */
  spreadCeilingEvaluatedTotal: number;
  spreadCeilingRejectedTotal: number;
}

/**
 * TRA-1681 — is anything this module reports actually ON DISK?
 *
 * Every other field in this payload is folded out of `byDay`, which is fed by the boot
 * hydrate AND by the live pass, and the fold cannot tell them apart. So on a box whose
 * DATA_DIR is ephemeral, the ledger still hydrates (from a file it wrote this uptime),
 * still appends (successfully — the in-bundle fallback path is perfectly writable), and
 * still publishes a full `retained.etDays[]`. **It reads exactly like a healthy durable
 * ledger, right up until the redeploy that erases it.** No IO error is ever raised, so
 * there is nothing for a try/catch to catch.
 *
 * That matters because `retained.etDays[]` non-empty is being used as a DATA_DIR proof
 * (TRA-1690 assertion 6). It is not one: it is non-empty from this uptime's own in-memory
 * decisions whether or not a durable byte was ever written. These fields are the proof.
 *
 * Read `ephemeral === false` FIRST. It is a property of the PATH, so it is true on the
 * very first boot, before any row exists — unlike `hydratedRecords`, which cannot
 * distinguish a fresh persistent disk from a wiped ephemeral one.
 */
export interface CostAwareGateDurability {
  /** Resolved append target. `null` = memory-only: no boot hydrate ran, NOTHING is durable. */
  dataDir: string | null;
  /**
   * TRUE ⇒ every count in this payload dies on the next redeploy. A hard VOID for any
   * multi-session window: there is no durable floor under the numbers.
   */
  ephemeral: boolean;
  /** Records recovered FROM DISK at boot. Distinguishes a real floor from this-uptime-only. */
  hydratedRecords: number;
  /** Distinct ET days recovered FROM DISK at boot. */
  hydratedDays: number;
  /**
   * Appends that threw and were SWALLOWED (the write is best-effort so accounting can
   * never break a trade pass). > 0 ⇒ the counters above overstate what is on disk.
   */
  appendErrors: number;
  /** Message from the most recent swallowed append (null when none). */
  lastAppendError: string | null;
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
  /** TRA-2295 — spread-gate verdicts on the requested ET day. 0 ⇒ the gate did not run. */
  spreadCeilingEvaluatedTotal: number;
  /** TRA-2295 — spread-gate refusals on the requested ET day. */
  spreadCeilingRejectedTotal: number;
  /**
   * TRA-1703 — the multi-day roll. Every count above is scoped to ONE ET day; a ceiling
   * tripwire read off a one-day counter self-clears at midnight. Read THIS for the
   * ceiling, the day view for the cost bar.
   */
  retained: CostAwareGateRetainedSummary;
  /**
   * TRA-1681 — whether ANY of the above survives a reboot. Check this BEFORE reading a
   * count off a multi-session window; see {@link CostAwareGateDurability}.
   */
  durability: CostAwareGateDurability;
  /**
   * TRA-4904 — the retention hook's configuration AND the outcome of its last run.
   * `durability` above says whether a row reached disk; this says whether the rows that
   * aged out ever LEAVE it. Read `compaction.timerCompactions` first — see
   * {@link CostAwareGateCompactionState}.
   */
  compaction: CostAwareGateCompactionState;
  /**
   * TRA-2295 — WHICH `byStructure` KEY CARRIES THE SPREAD GATE. Read this before
   * concluding a sleeve is ungated.
   *
   * The demo directional sleeve appears under TWO keys, because its gates were built
   * at different times against different naming conventions: the cost bar and the
   * delta ceiling record it as `directional` (the engine's internal sleeve name),
   * while the spread gate records it as `single_leg_directional` (the TRA-2245
   * JOURNAL label — it has to, since that is the key `SLEEVE_SPREAD_CEILINGS` holds
   * the ceiling under and the key the verification query groups journal rows by).
   *
   * So `byStructure['directional'].spreadCeilingEvaluated` is 0 *by construction*,
   * on a sleeve whose spread gate is running perfectly — a false negative of exactly
   * the shape this ticket exists to eliminate. This field names the right key rather
   * than leaving a reader to discover the split.
   */
  spreadCeilingStructureKeys: Record<string, string>;
  /**
   * TRA-2355 — states IN THE PAYLOAD that the pooled spread counters are not a desk
   * verdict, so a consumer asserts the partition rule instead of assuming it (the
   * wording TRA-2350 established on `/api/health/option-spread-cost`).
   *
   * A note is here rather than a redefinition of the pooled fields on purpose: moving
   * a published number under every existing consumer mid-flight makes a grader read
   * the CORRECTION as a new defect (TRA-2079). The pooled fields stay byte-compatible;
   * the partition sits beside them and this sentence says which one to grade.
   */
  spreadCeilingAccountClassNote: string;
  /**
   * TRA-4439 D4 — why this ledger's cost-bar `rejected` is SMALLER than the
   * `/api/health/rv-scan` census's `rejectionsByGate.cost_aware_bar` for the same
   * path and window, stated in the payload so the gap is not re-filed as a lost write.
   */
  costBarCensusReconciliationNote: string;
  /**
   * TRA-2948 — WHICH CLASSIFIER each retained spread decision froze its class under,
   * versus the one in effect now. THE separator for the standing trap this ledger and
   * `/api/health/option-spread-cost` share: they are published as independent
   * cross-checks of the same ceiling, but this side stamps class at DECISION time
   * while that side recomputes it at READ time, so any pattern-set edit makes them
   * disagree by construction — in a way that previously read identically to a real
   * enforcement failure. Read `divergenceDiscriminator` BEFORE interpreting any
   * desk-cell mismatch between the two routes.
   */
  classifierProvenance: CostAwareGateClassifierProvenance;
  /** ms epoch of the last recorded decision (null if none yet). */
  lastDecisionAt: number | null;
}

/**
 * TRA-2948 — see {@link CostAwareGateSummary.classifierProvenance}.
 *
 * Four states, not a boolean, and the order below is the precedence:
 *   `no-spread-decisions-in-window`   — the census has NOTHING under it. Not a
 *                                       consistency verdict; an empty window must not
 *                                       read as the healthy state (the TRA-2295 rule).
 *   `classifier-change-in-window`     — ≥1 retained decision froze its class under a
 *                                       DIFFERENT classifier than the current one. A
 *                                       split between the two ceiling surfaces is
 *                                       attributable to the classifier change, and
 *                                       `underOtherClassifiers` bounds how many
 *                                       decisions can be involved.
 *   `indeterminate-unstamped-records` — no foreign stamp, but pre-TRA-2948 records
 *                                       carry none at all; for those the question is
 *                                       unanswerable in either direction.
 *   `classifier-consistent`           — every retained decision is stamped with the
 *                                       current hash. The classifier is RULED OUT: a
 *                                       split between the surfaces in this state is
 *                                       an enforcement failure (or a lost fill), not
 *                                       a regex edit.
 */
export interface CostAwareGateClassifierProvenance {
  /** The classifier in effect on THIS read — the one read-time surfaces are using now. */
  current: TestAccountClassifierIdentity;
  /** This ledger's basis, stated so the two surfaces' bases can be compared on the wire. */
  decisionBasis: 'class-frozen-at-decision-time';
  /** Retained `spread_ceiling*` decisions (the only stamped kind). The census total. */
  spreadDecisionsTotal: number;
  /** Of those, stamped with `current.hash`. */
  underCurrentClassifier: number;
  /** Of those, stamped under a DIFFERENT classifier: hash → count. Non-empty names the change. */
  underOtherClassifiers: Record<string, number>;
  /** Of those, written before TRA-2948 (no stamp). Indeterminate — never counted as current. */
  unstamped: number;
  divergenceDiscriminator:
    | 'no-spread-decisions-in-window'
    | 'classifier-change-in-window'
    | 'indeterminate-unstamped-records'
    | 'classifier-consistent';
  note: string;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** TRA-2948 — fold the stamp census against the CURRENT classifier. Pure beyond env. */
function summarizeClassifierProvenance(env: NodeJS.ProcessEnv): CostAwareGateClassifierProvenance {
  const current = testAccountClassifierIdentity(env);
  let underCurrentClassifier = 0;
  const underOtherClassifiers: Record<string, number> = {};
  for (const [hash, n] of spreadDecisionsByClassifier.entries()) {
    if (hash === current.hash) underCurrentClassifier += n;
    else underOtherClassifiers[hash] = n;
  }
  const spreadDecisionsTotal =
    underCurrentClassifier
    + Object.values(underOtherClassifiers).reduce((a, n) => a + n, 0)
    + spreadDecisionsUnstamped;
  const divergenceDiscriminator: CostAwareGateClassifierProvenance['divergenceDiscriminator'] =
    spreadDecisionsTotal === 0
      ? 'no-spread-decisions-in-window'
      : Object.keys(underOtherClassifiers).length > 0
        ? 'classifier-change-in-window'
        : spreadDecisionsUnstamped > 0
          ? 'indeterminate-unstamped-records'
          : 'classifier-consistent';
  return {
    current,
    decisionBasis: 'class-frozen-at-decision-time',
    spreadDecisionsTotal,
    underCurrentClassifier,
    underOtherClassifiers,
    unstamped: spreadDecisionsUnstamped,
    divergenceDiscriminator,
    note:
      'TRA-2948. This ledger freezes accountClass at DECISION time; /api/health/option-spread-cost '
      + 'and /api/health/option-journal recompute class at READ time from the row\'s frozen `account` '
      + 'string. Editing BUILTIN_TEST_PATTERNS or TEST_ACCOUNT_PREFIXES therefore restates the '
      + 'read-time surfaces RETROACTIVELY while this side keeps what the gate saw — the two '
      + '"independent" ceiling cross-checks then disagree by construction. Each spread decision is '
      + 'stamped with the hash of the classifier it was classified under; `current` is the classifier '
      + 'in effect on this read (the same identity those routes now publish). Read '
      + '`divergenceDiscriminator` BEFORE interpreting a desk-cell mismatch between the routes: '
      + '`classifier-change-in-window` attributes the split to a pattern-set edit and '
      + '`underOtherClassifiers` bounds how many decisions it can involve; `classifier-consistent` '
      + 'RULES THE CLASSIFIER OUT, leaving enforcement failure (or a lost fill) as the remaining '
      + 'explanations; `indeterminate-unstamped-records` means pre-TRA-2948 lines carry no stamp and '
      + 'cannot testify either way; `no-spread-decisions-in-window` is NO READING, not consistency. '
      + 'An unstamped line is never counted as current — back-filling the current hash would '
      + 'fabricate the exact evidence the stamp exists to withhold.',
  };
}

/** Merge one day's tally for a structure into an accumulator (so N days fold like one). */
function mergeTally(into: StructureTally, t: StructureTally): void {
  into.admitted += t.admitted;
  into.rejected += t.rejected;
  into.admittedGrossRSum += t.admittedGrossRSum;
  into.rejectedGrossRSum += t.rejectedGrossRSum;
  mergeCostBar(into.costBar, t.costBar);
  into.admittedOnMeritGrossRSum += t.admittedOnMeritGrossRSum;
  for (const [klass, ct] of t.costBarByAccountClass.entries()) {
    let acc = into.costBarByAccountClass.get(klass);
    if (!acc) {
      acc = newCostBarClassTally();
      into.costBarByAccountClass.set(klass, acc);
    }
    mergeCostBar(acc, ct);
  }
  into.deltaCeilingRejected += t.deltaCeilingRejected;
  into.deltaCeilingAbsDeltaSum += t.deltaCeilingAbsDeltaSum;
  into.deltaCeilingObserved += t.deltaCeilingObserved;
  into.deltaCeilingObservedAbsDeltaSum += t.deltaCeilingObservedAbsDeltaSum;
  into.spreadCeilingAdmitted += t.spreadCeilingAdmitted;
  into.spreadCeilingRejected += t.spreadCeilingRejected;
  into.spreadCeilingRejectedSpreadPctSum += t.spreadCeilingRejectedSpreadPctSum;
  // A MAX, not a sum — and `null`-safe on both sides, so a day that admitted nothing
  // cannot pull a real maximum down to 0 (the TRA-1707 shape, one field over).
  if (t.spreadCeilingMaxAdmittedSpreadPct !== null) {
    into.spreadCeilingMaxAdmittedSpreadPct =
      into.spreadCeilingMaxAdmittedSpreadPct === null
        ? t.spreadCeilingMaxAdmittedSpreadPct
        : Math.max(into.spreadCeilingMaxAdmittedSpreadPct, t.spreadCeilingMaxAdmittedSpreadPct);
  }
  for (const [code, n] of t.spreadCeilingRejectsByCode.entries()) {
    into.spreadCeilingRejectsByCode.set(code, (into.spreadCeilingRejectsByCode.get(code) ?? 0) + n);
  }
  // TRA-2355 — roll the class partition across days on the SAME rules as the pooled
  // fields above: sums add, `maxAdmittedSpreadPct` is a null-safe MAX. A retained
  // (multi-day) view that folded only the pooled totals would leave the ceiling
  // tripwire account-blind over exactly the window TRA-1703 built it to cover.
  for (const [klass, ct] of t.spreadCeilingByAccountClass.entries()) {
    const acc = classTally(into, klass);
    acc.admitted += ct.admitted;
    acc.rejected += ct.rejected;
    acc.rejectedSpreadPctSum += ct.rejectedSpreadPctSum;
    if (ct.maxAdmittedSpreadPct !== null) {
      acc.maxAdmittedSpreadPct =
        acc.maxAdmittedSpreadPct === null
          ? ct.maxAdmittedSpreadPct
          : Math.max(acc.maxAdmittedSpreadPct, ct.maxAdmittedSpreadPct);
    }
    for (const [code, n] of ct.rejectsByCode.entries()) {
      acc.rejectsByCode.set(code, (acc.rejectsByCode.get(code) ?? 0) + n);
    }
  }
  // `lastBarR` is a LAST, not a sum — a day with no cost-bar decision has no bar to
  // contribute and must not overwrite a real one. The sentinel is `null`, not 0: a day
  // whose only records were ceiling breaches now carries `null` (TRA-1707), so a genuine
  // bar of 0 is no longer indistinguishable from "never measured".
  if (t.lastBarR !== null) into.lastBarR = t.lastBarR;
}

/**
 * TRA-2355 — emit the FULL three-class grid for one structure, zeros included.
 *
 * Never sparse. A class omitted because it recorded nothing would be read as a class
 * that recorded nothing WRONG — the absent-cell-reads-as-passing shape TRA-2350 had to
 * fix on the journal side of this same ceiling. `desk` present and explicitly zero is
 * the reading that stops a grade; `desk` missing is one a consumer skips past.
 */
function foldAccountClasses(
  t: StructureTally,
): Record<SpreadCeilingAccountClass, CostAwareGateAccountClassSummary> {
  const out = {} as Record<SpreadCeilingAccountClass, CostAwareGateAccountClassSummary>;
  for (const accountClass of SPREAD_CEILING_ACCOUNT_CLASSES) {
    const c = t.spreadCeilingByAccountClass.get(accountClass) ?? newClassTally();
    const evaluated = c.admitted + c.rejected;
    out[accountClass] = {
      accountClass,
      spreadCeilingEvaluated: evaluated,
      spreadCeilingRejected: c.rejected,
      spreadCeilingRejectRate: evaluated > 0 ? round(c.rejected / evaluated) : null,
      avgRejectedSpreadPct: c.rejected > 0 ? round(c.rejectedSpreadPctSum / c.rejected) : null,
      maxAdmittedSpreadPct: c.maxAdmittedSpreadPct === null ? null : round(c.maxAdmittedSpreadPct),
      spreadCeilingRejectsByCode: Object.fromEntries(c.rejectsByCode),
    };
  }
  return out;
}

/** TRA-4439 D5 — the full three-class cost-bar grid, zeros included (never sparse). */
function foldCostBarAccountClasses(
  t: StructureTally,
): Record<SpreadCeilingAccountClass, CostAwareGateCostBarClassSummary> {
  const out = {} as Record<SpreadCeilingAccountClass, CostAwareGateCostBarClassSummary>;
  for (const accountClass of SPREAD_CEILING_ACCOUNT_CLASSES) {
    const c = t.costBarByAccountClass.get(accountClass) ?? newCostBarClassTally();
    out[accountClass] = {
      accountClass,
      admitted: c.admitted,
      admittedByBypass: c.admittedByBypass,
      rejected: c.rejected,
      grossRUnmeasurable: c.grossRUnmeasurable,
      avgRejectedGrossR: c.rejectedMeasured > 0 ? round(c.rejectedMeasuredGrossRSum / c.rejectedMeasured) : null,
      maxRejectedGrossR: c.maxRejectedGrossR === null ? null : round(c.maxRejectedGrossR),
    };
  }
  return out;
}

/**
 * Fold a structure->tally map into the per-structure health rows, busiest first.
 * `decisionDays` (TRA-4439 D3) names, per structure, the ET days its cost bar ruled
 * on anything; the one-day view passes its own day for every structure that decided.
 */
function foldStructures(
  acc: Map<string, StructureTally>,
  decisionDays: (structure: string, t: StructureTally) => string[],
): {
  byStructure: CostAwareGateStructureSummary[];
  admittedTotal: number;
  rejectedTotal: number;
  deltaCeilingRejectedTotal: number;
  deltaCeilingObservedTotal: number;
  spreadCeilingEvaluatedTotal: number;
  spreadCeilingRejectedTotal: number;
} {
  const byStructure: CostAwareGateStructureSummary[] = [];
  let admittedTotal = 0;
  let rejectedTotal = 0;
  let deltaCeilingRejectedTotal = 0;
  let deltaCeilingObservedTotal = 0;
  let spreadCeilingEvaluatedTotal = 0;
  let spreadCeilingRejectedTotal = 0;
  for (const [structure, t] of acc.entries()) {
    const decisions = t.admitted + t.rejected;
    const spreadEvaluated = t.spreadCeilingAdmitted + t.spreadCeilingRejected;
    admittedTotal += t.admitted;
    rejectedTotal += t.rejected;
    deltaCeilingRejectedTotal += t.deltaCeilingRejected;
    deltaCeilingObservedTotal += t.deltaCeilingObserved;
    spreadCeilingEvaluatedTotal += spreadEvaluated;
    spreadCeilingRejectedTotal += t.spreadCeilingRejected;
    byStructure.push({
      structure,
      admitted: t.admitted,
      rejected: t.rejected,
      admitRate: decisions > 0 ? round(t.admitted / decisions) : null,
      avgAdmittedGrossR: t.admitted > 0 ? round(t.admittedGrossRSum / t.admitted) : null,
      avgRejectedGrossR: t.rejected > 0 ? round(t.rejectedGrossRSum / t.rejected) : null,
      admittedByBypass: t.costBar.admittedByBypass,
      admittedOnMerit: t.admitted - t.costBar.admittedByBypass,
      avgAdmittedOnMeritGrossR:
        t.admitted - t.costBar.admittedByBypass > 0
          ? round(t.admittedOnMeritGrossRSum / (t.admitted - t.costBar.admittedByBypass))
          : null,
      grossRUnmeasurable: t.costBar.grossRUnmeasurable,
      avgRejectedGrossRMeasured:
        t.costBar.rejectedMeasured > 0
          ? round(t.costBar.rejectedMeasuredGrossRSum / t.costBar.rejectedMeasured)
          : null,
      maxRejectedGrossR: t.costBar.maxRejectedGrossR === null ? null : round(t.costBar.maxRejectedGrossR),
      costBarDecisionEtDays: decisionDays(structure, t),
      costBarByAccountClass: foldCostBarAccountClasses(t),
      barR: t.lastBarR === null ? null : round(t.lastBarR),
      deltaCeilingRejected: t.deltaCeilingRejected,
      avgDeltaCeilingAbsDelta:
        t.deltaCeilingRejected > 0 ? round(t.deltaCeilingAbsDeltaSum / t.deltaCeilingRejected) : null,
      deltaCeilingObserved: t.deltaCeilingObserved,
      avgDeltaCeilingObservedAbsDelta:
        t.deltaCeilingObserved > 0
          ? round(t.deltaCeilingObservedAbsDeltaSum / t.deltaCeilingObserved)
          : null,
      spreadCeilingEvaluated: spreadEvaluated,
      spreadCeilingRejected: t.spreadCeilingRejected,
      // `null`, not 0, when the gate ruled on nothing — same rule as `admitRate`. A 0%
      // reject rate is a real reading ("ran, nothing was wide"); "did not run" is not a
      // rate at all, and rendering both as 0 is precisely the conflation TRA-2295 fixes.
      spreadCeilingRejectRate: spreadEvaluated > 0 ? round(t.spreadCeilingRejected / spreadEvaluated) : null,
      avgRejectedSpreadPct:
        t.spreadCeilingRejected > 0
          ? round(t.spreadCeilingRejectedSpreadPctSum / t.spreadCeilingRejected)
          : null,
      maxAdmittedSpreadPct:
        t.spreadCeilingMaxAdmittedSpreadPct === null ? null : round(t.spreadCeilingMaxAdmittedSpreadPct),
      spreadCeilingRejectsByCode: Object.fromEntries(t.spreadCeilingRejectsByCode),
      spreadCeilingByAccountClass: foldAccountClasses(t),
    });
  }
  byStructure.sort(
    (a, b) =>
      b.admitted + b.rejected + b.deltaCeilingRejected + b.deltaCeilingObserved + b.spreadCeilingEvaluated
      - (a.admitted + a.rejected + a.deltaCeilingRejected + a.deltaCeilingObserved + a.spreadCeilingEvaluated),
  );
  return {
    byStructure,
    admittedTotal,
    rejectedTotal,
    deltaCeilingRejectedTotal,
    deltaCeilingObservedTotal,
    spreadCeilingEvaluatedTotal,
    spreadCeilingRejectedTotal,
  };
}

/** TRA-1703 — fold EVERY retained ET day. See {@link CostAwareGateRetainedSummary}. */
function summarizeRetained(): CostAwareGateRetainedSummary {
  const acc = new Map<string, StructureTally>();
  const days = new Map<string, string[]>();
  for (const [etDay, day] of [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const [structure, t] of day.entries()) {
      if (t.admitted + t.rejected > 0) days.set(structure, [...(days.get(structure) ?? []), etDay]);
      let into = acc.get(structure);
      if (!into) {
        into = newTally();
        acc.set(structure, into);
      }
      mergeTally(into, t);
    }
  }
  return {
    etDays: [...byDay.keys()].sort(),
    retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
    ...foldStructures(acc, (structure) => days.get(structure) ?? []),
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
export function summarizeCostAwareGate(
  etDay: string,
  env: NodeJS.ProcessEnv = process.env,
): CostAwareGateSummary {
  const day = byDay.get(etDay);
  return {
    decisionsRecorded: decisionsTotal,
    ...foldStructures(day ?? new Map(), (_s, t) => (t.admitted + t.rejected > 0 ? [etDay] : [])),
    retained: summarizeRetained(),
    classifierProvenance: summarizeClassifierProvenance(env),
    spreadCeilingStructureKeys: {
      // TRA-2345 — INTERPOLATED from the constant the recorder keys off, not a
      // second copy of the string. A hardcoded literal here reads identically
      // whether or not it still matches the recorder, and the divergence it hides
      // costs a grader a misattributed VOID rather than a visible error.
      demo_directional: `${DIRECTIONAL_STRUCTURE_LABEL} — NOT the \`directional\` row, which carries only the cost bar and the delta ceiling and will always show spreadCeilingEvaluated 0 (TRA-2295).`,
      otm: 'single_leg_otm — gated in the OTM scanner chain filter, not by this counter; spreadCeilingEvaluated 0 there is expected.',
    },
    costBarCensusReconciliationNote:
      'TRA-4439 D4. This ledger records DEMO cost-bar verdicts only (the demo branch of costAwareGateReject). '
      + 'LIVE-mode verdicts of the same bar go to /api/health/live-enforce-gates instead, while the '
      + '/api/health/rv-scan census counts `cost_aware_bar` rejects in BOTH modes (its cells carry `mode`). '
      + 'Reconcile against census cells with mode === "demo" only, over the same ET days. Measured on bqb1 '
      + '0dc2baea, 2026-09-18, rv_scan over 09-11..09-18: census 3,502 = demo 3,302 + live 200; this ledger\'s '
      + 'single_leg_rv rejected = 3,304. The 198 gap is the live cells; the +2 residual (ledger > census) is the '
      + 'census\'s documented 5-minute flush lower bound. Two smaller skews: this ledger drops records older than '
      + '7x24h by TIMESTAMP at boot, so its OLDEST retained ET day can be partial while the 30-day census holds it '
      + 'whole; and the census under-counts any day on which a boot died before flushing.',
    spreadCeilingAccountClassNote:
      'TRA-2355. The pooled `spreadCeiling*` fields on each byStructure[] row are NOT A DESK VERDICT: this ledger is module-global while SignalEngine is constructed per username, so ~51 QA fixture books (qa*/ctoverify*/monitor_qa) tally into the same counters as the desk (admin/Richard). GRADE `byStructure[].spreadCeilingByAccountClass.desk` — a non-zero pooled `spreadCeilingEvaluated` can be 100% fixture, and the fixture fleet is a CURRENTLY-FIRING writer of the directional cohort (64 of 151 pre-fix rows), not an empirical zero that expires. `desk.spreadCeilingEvaluated === 0` is NO READING AT ALL, not a pass — the desk fires zero directional entries on roughly 2 sessions in 5. `unattributed` is records written before TRA-2355 (and any hydrated line carrying no class); it is NOT desk, and folding it into desk would re-pool exactly the retained history a multi-day grade leans on hardest. All three classes are emitted even at 0, because an absent cell reads like a passing one. Classification is frozen at DECISION time via classifySpreadCeilingAccount(), the same predicate /api/health/option-spread-cost applies to a row\'s stored `account`, so the two routes cannot drift on the partition RULE — but (TRA-2948) they CAN drift on the rule\'s INPUTS: that route re-applies the predicate at READ time, so a pattern-set edit restates its history while this side keeps what the gate saw. `classifierProvenance` is the separator — read its divergenceDiscriminator before interpreting a mismatch. Cross-check: this desk cell should track ceilingCompliance.byAccountClass.desk[single_leg_directional].gated on that route.',
    durability: {
      dataDir,
      ephemeral: isEphemeralDataDir(dataDir),
      hydratedRecords,
      hydratedDays,
      appendErrors,
      lastAppendError,
    },
    compaction: costAwareGateCompaction(),
    lastDecisionAt,
  };
}
