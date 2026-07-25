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
import { isEphemeralDataDir } from './data-dir.js';
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
  if (rec.gate === 'spread_ceiling') {
    // TRA-2295 — the spread gate REFUSED this candidate. Its own axis: it is neither a
    // modeled-R verdict nor a delta breach, and folding it into `rejected` would move the
    // cost bar's admit rate for a reason that has nothing to do with the cost bar.
    tally.spreadCeilingRejected += 1;
    tally.spreadCeilingRejectedSpreadPctSum += Number.isFinite(rec.spreadPct) ? (rec.spreadPct as number) : 0;
    const code = typeof rec.code === 'string' && rec.code !== '' ? rec.code : 'unknown';
    tally.spreadCeilingRejectsByCode.set(code, (tally.spreadCeilingRejectsByCode.get(code) ?? 0) + 1);
  } else if (rec.gate === 'spread_ceiling_admitted') {
    // TRA-2295 — the spread gate RAN and let this one through. Recorded because the
    // absence of this counter is what made the unenforced ceiling invisible for 83 fills:
    // without it, `spreadCeilingRejected: 0` cannot be told from a gate that never ran.
    tally.spreadCeilingAdmitted += 1;
    if (Number.isFinite(rec.spreadPct)) {
      const p = rec.spreadPct as number;
      const prev = tally.spreadCeilingMaxAdmittedSpreadPct;
      tally.spreadCeilingMaxAdmittedSpreadPct = prev === null ? p : Math.max(prev, p);
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
 */
export function recordSpreadCeilingDecision(
  structure: string,
  admit: boolean,
  spreadPct: number | null,
  code: string,
  etDay: string,
  now: number = Date.now(),
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
  const path = costAwareGateLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
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

  // TRA-1681 — freeze what came OFF DISK, before the live pass starts folding its own
  // decisions into the same `byDay`. After the first live record the two are one map and
  // no consumer can tell "recovered a week of history" from "this uptime, nothing under me".
  hydratedRecords = kept.length;
  hydratedDays = byDay.size;
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
  for (const day of byDay.values()) {
    for (const [structure, t] of day.entries()) {
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
    durability: {
      dataDir,
      ephemeral: isEphemeralDataDir(dataDir),
      hydratedRecords,
      hydratedDays,
      appendErrors,
      lastAppendError,
    },
    lastDecisionAt,
  };
}
