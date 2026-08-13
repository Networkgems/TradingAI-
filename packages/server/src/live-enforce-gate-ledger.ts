// TRA-2048 (parent TRA-2044) — DURABLE enforcement telemetry for the two LIVE
// pre-trade gates promoted from shadow to ENFORCING (the cost-vs-edge bar and the
// liquidity / spread veto).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The CTO's assignment was explicit: "Do not silently enforce with no counter."
// A working admission gate's evidence is the trades that DIDN'T happen, so a live
// flip that rejects real orders is invisible from the fill tape alone — the exact
// trap that cost two demo sessions on the TRA-1476 quality gate (armed-but-inert,
// TRA-1486) and that the sibling cost-aware-gate ledger already guards for demo.
// This module makes the LIVE enforcement deterministic in one read:
//   • how many ARMED live evaluations each gate saw (allowed AND blocked), so an
//     armed-but-inert flip (`evaluated:0`) never reads the same as an armed gate
//     that saw candidates and passed them all (`evaluated>0, blocked:0`) or one
//     that is biting (`blocked>0`);
//   • split by gate (`cost_bar` / `spread`) and by scope (structure / symbol);
//   • whether any of it is actually ON DISK (the TRA-1681 durability caveat).
//
// The cost-aware-gate ledger is DELIBERATELY not reused: its header contract is
// that it is "structurally incapable of describing a live open," and graders read
// `/api/health/cost-aware-gate` as demo-only. Live enforcement records land here,
// on a separate axis and a separate `/api/health/live-enforce-gates` route.
//
// ── DURABILITY (TRA-1681 / TRA-1719) ─────────────────────────────────────────
// JSONL-appended under DATA_DIR, keyed by ET calendar day, rebuilt on boot. "A
// persisted file survives a reboot" is TRUE only if DATA_DIR points at a mounted
// persistent disk; with DATA_DIR unset the fallback path is inside the build
// bundle and evaporates on redeploy with NO error to catch. `durability.ephemeral`
// (a property of the PATH, decisive on the first boot before a row exists) is
// published and MUST be read first.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Observe-through accounting. NEVER places an order or mutates an account — it is
// a write-through of an enforcement decision the engine already made. Records are
// written ONLY from the engine's LIVE enforcing branches, which themselves bail
// unless the corresponding `ENABLE_OPTION_*_LIVE_ENFORCE` flag is armed — so every
// row reflects an ARMED LIVE evaluation. No balances / PII — gate, scope, ET day,
// and whether the order was blocked.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import {
  DEFAULT_NET_EDGE_BAR_CONFIG,
  NET_EDGE_SHADOW_K_SWEEP,
  netEdgeShadowAdmits,
  type NetEdgeShadowSample,
} from './option-net-edge-bar.js';
import type { AdmissibleSelection } from './otm-admissible-strike.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'live-enforce-gate-ledger' });

export const LIVE_ENFORCE_GATE_LOG_FILENAME = 'live-enforce-gate.jsonl';

/**
 * Retain this many ms of decisions on disk (compacted on boot). A month covers
 * reading enforcement back well after a bounded live window closes while bounding
 * a file that takes one line per armed live evaluation.
 */
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Which live gate produced the record. `cost_bar` is the TRA-1602 modeled-gross-R
 * admission bar promoted to live enforcement; `spread` is the TRA-1967 liquidity /
 * spread veto (`SPREAD_TOO_WIDE` / thin-book / unusable-quote) enforced at the
 * live-options broker seam; `otm_delta_floor` is the TRA-2763 live arm of the
 * TRA-1407 OTM entry |delta| floor (the demo-only guard that left real money
 * running unfiltered at |delta| 0.03-0.07); `universe` is the TRA-3216 live OTM
 * underlying allowlist (the scan universe was the full ~614-name watchlist, so
 * real money opened on KVYO / TROW / ABCL because nothing restricted it).
 *
 * TRA-3394 adds the two CEILING axes. `entry_delta_ceiling` is the live arm of
 * the TRA-3392 upper band edge — the cut the cost bar is algebraically incapable
 * of making, since it is a floor. `entry_delta_ceiling_shadow` is the SAME
 * verdict recorded while the gate is dark: `blocked` there means WOULD HAVE
 * BLOCKED, and no live open was stopped. They are separate gates rather than one
 * gate with a mode field because a counter must report what the engine actually
 * did, not what the config intended (TRA-1682) — folding a shadow "block" into
 * the enforcing gate's `blocked` would claim a trade was prevented when it fired.
 *
 * TRA-3445 adds `aggregate_cap` — the board's "max $750 TOTAL" bound on the live
 * bounded-test sleeve, which until now had no enforcement path at all (every
 * other guard bounds a SINGLE entry). It is its own gate rather than a reason
 * code on an existing one for the usual reason: only a gate carries an
 * `evaluated` denominator, and "the cap never had to bite" (`evaluated > 0,
 * blocked: 0`) must not read the same as "the cap is inert" (`evaluated: 0`).
 */
export type LiveEnforceGate =
  | 'cost_bar'
  | 'spread'
  | 'otm_delta_floor'
  | 'universe'
  | 'entry_delta_ceiling'
  | 'entry_delta_ceiling_shadow'
  | 'aggregate_cap';

/** One durable ARMED-LIVE enforcement decision — a write-through of the verdict. */
export interface LiveEnforceRecord {
  /** Decision time, ms epoch. */
  ts: number;
  /** ET calendar day (America/New_York, YYYY-MM-DD) — the key the health view rolls on. */
  etDay: string;
  /** Which gate ruled. */
  gate: LiveEnforceGate;
  /** For `cost_bar`, the structure (single_leg_rv / single_leg_otm / directional); for `spread` and `universe`, the underlying symbol. */
  scope: string;
  /** TRUE ⇒ the order was BLOCKED (rejected). FALSE ⇒ evaluated and allowed to proceed. */
  blocked: boolean;
  /** Human-readable rejection reason (present only when blocked). */
  reason?: string;
  /**
   * TRA-3216 — LOW-CARDINALITY classification of the block, present only when
   * blocked. `reason` above is per-candidate prose (it embeds the candidate's own
   * numbers), so folding on it yields one bucket per decision and answers
   * nothing. This is the tuneable axis: for `cost_bar` it says how far under the
   * bar the candidate fell, which is what turns "99.15% blocked" into "N of them
   * were within 0.10R of admission".
   */
  reasonCode?: string;
  /**
   * TRA-3216 — WHICH LIVE BOOK this verdict governed (the `alertUsername` the
   * options journal stamps as `account`, so this joins to the journal and to the
   * TRA-3117 per-book census without a translation table). A process-level flag
   * reads identically for a book it does not govern; this field is what makes the
   * fleet claim checkable. Absent ⇒ the call site could not attribute the book,
   * which folds to an explicit `unattributed` key rather than disappearing.
   */
  book?: string;
  /**
   * TRA-3391 — for `cost_bar`, WHICH tape cell (`structure::|delta| bucket`) the
   * verdict was decided under. The edge is no longer a per-candidate formula but
   * a lookup into a measured table, so "why did this block" is only answerable
   * with the cell identity: `insufficient_evidence` on `single_leg_otm::0.45-0.50`
   * and on `::0.00-0.10` are different facts about the book.
   *
   * Stamped on ADMITS too (unlike `reasonCode`) — the admitted cells are exactly
   * the ones a grader needs to check against the published table.
   *
   * Absent ⇒ the verdict predates this field or the gate does not use cells; that
   * folds to no `byCell` row at all rather than to a synthetic bucket, because
   * "never stamped" is not a cell.
   */
  cell?: string;
  /**
   * TRA-3483 — the NUMERATOR of the net-edge comparison, recorded on EVERY
   * `cost_bar` verdict including admits, whichever form actually decided.
   *
   * `k` is defined by `admit ⟺ costR ≤ k · modeledGrossR`, and every row inside a
   * cell shares the same `modeledGrossR` (the cell's lower CI bound), so `costR`
   * is the ONLY axis `k` can discriminate on. Until this field existed, `k` was
   * unidentifiable from any deployed instrument no matter how clean the tape.
   *
   * ABSENT ⇒ the quote was unusable at decision time (the net-edge form's
   * fail-closed case) or the row predates this field. Both are published as a
   * MISSING sample, never as a zero — see `costRQuantiles.rowsMissingCostR`.
   */
  cost?: {
    /** costPerShare / riskPerShare, in the same `R_gate` unit as `barR`. */
    costR: number;
    /** The spread-cross term alone (0.235 of the 0.285 modeled bar — 82%). */
    spreadR: number;
    /** The commission/fee term alone. `spreadR + feeR === costR`. */
    feeR: number;
    /** costPerShare / mark — what the k-INDEPENDENT absolute ceiling tests. */
    costFracOfPremium: number;
  };
  /**
   * TRA-3483 — the DENOMINATOR at decision time (`tapeEdgeR`: the cell's lower 95%
   * CI bound). Recorded per row rather than joined from the expectancy table after
   * the fact, because that table is re-folded continuously and a later read would
   * answer a different question than the one the verdict was made under.
   *
   * Absent ⇒ the edge was unknown (unfolded tape / underpowered cell / no bucket),
   * which fails closed at every `k`.
   */
  grossR?: number;
  /**
   * TRA-3510 — WHICH NOMINATOR BRANCH produced the candidate this verdict ruled
   * on (TRA-3401's `selectAdmissibleOtmCandidate`).
   *
   * This is the axis that makes a ZERO on the delta gates readable. The selector
   * runs UPSTREAM of every gate here, and on its `in_band` branch the nominee's
   * `|Δ|` is inside `[min, max)` BY CONSTRUCTION — so it cannot breach a ceiling
   * at the band's own `max`, nor a floor at or below its `min`. Without this
   * field, `entry_delta_ceiling_shadow.blocked === 0` has two byte-identical
   * causes:
   *
   *   • the selector clamped every row into the band (a vacuous zero), and
   *   • the far tail was nominated and genuinely did not breach (a real zero).
   *
   * `cheapConsidered` / `cheapInBand` are the CHAIN SHAPE behind the branch: a
   * `fallback_top_mispricing` row with `cheapInBand: 0` says the chain offered no
   * admissible strike, which is a different fact about the book than a chain that
   * offered one and lost it downstream.
   *
   * Absent ⇒ the verdict did not come from the OTM nominator (RV / directional
   * cost-bar rows) or predates this field. That folds to no `bySelection` row
   * rather than to a synthetic bucket — "never stamped" is not a branch.
   */
  nominator?: LiveEnforceNominator;
}

/** TRA-3510 — the nominator branch + chain shape carried on an OTM verdict. */
export interface LiveEnforceNominator {
  /** `in_band` | `fallback_top_mispricing` | `legacy` | `none`. */
  selection: AdmissibleSelection;
  /** How many `cheap` candidates the scanned chain offered. */
  cheapConsidered: number;
  /** How many of those landed inside the armed band (0 when the selector is dark). */
  cheapInBand: number;
  /**
   * TRA-3619 — every candidate the scanner offered the selector, BEFORE the
   * cheapness screen (post-liquidity; see `AdmissibleStrikeResult`).
   *
   * OPTIONAL, and it stays optional forever: rows written before this field
   * existed carry the nominator block without it, and demanding it in
   * {@link usableNominator} would silently drop every one of them from the
   * `bySelection` axis — turning a field addition into a retroactive data loss.
   * The pair below therefore folds on its OWN denominator (`rowsWithStrikeShape`).
   */
  strikesConsidered?: number;
  /**
   * TRA-3619 — of those, how many sat inside the armed band. This is the field
   * that separates "the band is empty in the chain" (0) from "the cheapness
   * screen emptied it" (≥1 while `cheapInBand` is 0). 0 on the dark `legacy`
   * branch, where the band is never consulted.
   */
  strikesInBand?: number;
}

/** The selection values a persisted row may carry. Anything else is dropped on hydrate. */
const SELECTIONS: readonly AdmissibleSelection[] = [
  'in_band',
  'fallback_top_mispricing',
  'legacy',
  'none',
];

/**
 * TRA-3483 — one recorded decision's ingredients for the counterfactual sweep.
 * Retained per gate-day alongside the counters; `cost_bar` is the only gate that
 * produces them.
 */
interface CostSample extends NetEdgeShadowSample {
  spreadR: number;
  feeR: number;
  /** What the DEPLOYED form actually did — the `flatFormAdmits` baseline. */
  blocked: boolean;
  /** The cell this verdict was decided under, for the per-cell quantile fold. */
  cell: string | null;
}

/**
 * Hard cap on retained samples per gate-day. The observed live rate is ~300
 * decisions/day, so this is a runaway backstop, not a working limit — but it is a
 * COUNTED cap: `costRQuantiles.samplesDropped > 0` says the quantiles are over a
 * truncated head and must not be read as the day's distribution.
 */
const MAX_COST_SAMPLES_PER_GATE_DAY = 20_000;

interface GateScopeTally {
  evaluated: number;
  blocked: number;
}

/**
 * TRA-3510 — the selection axis carries the plain evaluated/blocked tally PLUS
 * the chain-shape sums, because `cheapConsidered` / `cheapInBand` are per-row
 * measurements rather than keys. Sums (not means) are accumulated so the axis
 * merges across days by addition like every other axis; the mean is derived at
 * read time over `rowsWithChainShape`, which is its own denominator.
 */
interface GateSelectionTally extends GateScopeTally {
  cheapConsideredSum: number;
  cheapInBandSum: number;
  /** Rows that carried the chain-shape numbers at all. */
  rowsWithChainShape: number;
  /**
   * TRA-3619 — the pre-cheapness pair, on its OWN denominator. It is NOT folded
   * into `rowsWithChainShape` because the two fields were deployed on different
   * days: a fold spanning that boundary holds rows with the cheap counts and no
   * strike counts, and sharing a denominator would divide a partial numerator by
   * a complete denominator — deflating `meanStrikesInBand` toward zero, which is
   * precisely the value that decides State A vs State B.
   */
  strikesConsideredSum: number;
  strikesInBandSum: number;
  rowsWithStrikeShape: number;
}

/** The per-gate accumulator: the same tally shape folded on four independent keys. */
interface GateTallies {
  /** structure (cost_bar) or underlying symbol (spread / universe). */
  byScope: Map<string, GateScopeTally>;
  /** normalized block classification — BLOCKED rows only (an admit has no reason). */
  byReason: Map<string, GateScopeTally>;
  /** live book (`alertUsername`), or `unattributed`. */
  byBook: Map<string, GateScopeTally>;
  /** TRA-3391 tape cell (`structure::bucket`) — rows that carry one, admits included. */
  byCell: Map<string, GateScopeTally>;
  /**
   * TRA-3510 — TRA-3401 nominator branch, admits included. Rows that carry no
   * nominator contribute no key: this axis answers "which branch nominated the
   * candidate this gate ruled on", and a row from a non-OTM path was not
   * nominated by it at all.
   */
  bySelection: Map<string, GateSelectionTally>;
  /**
   * TRA-3483 — per-decision cost/edge samples (`cost_bar` only). This is a LIST,
   * not a tally, because quantiles and a median-of-admitted are not foldable into
   * counters: the sweep's `medianNetR_admitted` is over a k-DEPENDENT subset that
   * is only known at read time.
   */
  costSamples: CostSample[];
  /** Rows of this gate/day that carried NO usable cost (unusable quote / pre-field). */
  costRowsMissing: number;
  /** Samples discarded by {@link MAX_COST_SAMPLES_PER_GATE_DAY}. */
  costSamplesDropped: number;
  /** TRA-3483 (D2) — BLOCKED rows carrying no `reasonCode`, so `byReason`'s denominator is visible. */
  blockedUnclassified: number;
}

const UNATTRIBUTED_BOOK = 'unattributed';

function emptyTallies(): GateTallies {
  return {
    byScope: new Map(),
    byReason: new Map(),
    byBook: new Map(),
    byCell: new Map(),
    bySelection: new Map(),
    costSamples: [],
    costRowsMissing: 0,
    costSamplesDropped: 0,
    blockedUnclassified: 0,
  };
}

function bump(map: Map<string, GateScopeTally>, key: string, blocked: boolean): void {
  let tally = map.get(key);
  if (!tally) {
    tally = { evaluated: 0, blocked: 0 };
    map.set(key, tally);
  }
  tally.evaluated += 1;
  if (blocked) tally.blocked += 1;
}

/** TRA-3510 — `bump` plus the chain-shape sums. Non-finite chain numbers are counted
 *  as evaluated but contribute NO sample, so a malformed row cannot move a mean. */
function bumpSelection(
  map: Map<string, GateSelectionTally>,
  nom: LiveEnforceNominator,
  blocked: boolean,
): void {
  let tally = map.get(nom.selection);
  if (!tally) {
    tally = emptySelectionTally();
    map.set(nom.selection, tally);
  }
  tally.evaluated += 1;
  if (blocked) tally.blocked += 1;
  if (Number.isFinite(nom.cheapConsidered) && Number.isFinite(nom.cheapInBand)) {
    tally.cheapConsideredSum += nom.cheapConsidered;
    tally.cheapInBandSum += nom.cheapInBand;
    tally.rowsWithChainShape += 1;
  }
  // TRA-3619 — same discipline, separate denominator: a row carrying only the
  // cheap pair contributes to `rowsWithChainShape` and NOT to this one.
  if (isStrikeCount(nom.strikesConsidered) && isStrikeCount(nom.strikesInBand)) {
    tally.strikesConsideredSum += nom.strikesConsidered;
    tally.strikesInBandSum += nom.strikesInBand;
    tally.rowsWithStrikeShape += 1;
  }
}

function emptySelectionTally(): GateSelectionTally {
  return {
    evaluated: 0,
    blocked: 0,
    cheapConsideredSum: 0,
    cheapInBandSum: 0,
    rowsWithChainShape: 0,
    strikesConsideredSum: 0,
    strikesInBandSum: 0,
    rowsWithStrikeShape: 0,
  };
}

// ── In-memory store (backs the durable counts + the health endpoint) ─────────
//
// Module-global + observe-through. `dataDir` is set once at boot by
// hydrateLiveEnforceGateFromDisk so the engine chokepoints can append without
// threading a path through the SignalEngine.

let dataDir: string | null = null;
/** etDay -> (gate -> per-axis tallies). */
const byDay = new Map<string, Map<LiveEnforceGate, GateTallies>>();
let decisionsTotal = 0;
let lastDecisionAt: number | null = null;
// TRA-1681 — durability provenance: `byDay` is fed by BOTH the boot hydrate and the
// live pass, and once folded the two are indistinguishable. These say which.
let hydratedRecords = 0;
let hydratedDays = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;

export function liveEnforceGateLogPath(dir: string): string {
  return join(dir, LIVE_ENFORCE_GATE_LOG_FILENAME);
}

/** Test seam — drop every counter and the configured dir. */
export function clearLiveEnforceGateLedger(): void {
  dataDir = null;
  byDay.clear();
  decisionsTotal = 0;
  lastDecisionAt = null;
  hydratedRecords = 0;
  hydratedDays = 0;
  appendErrors = 0;
  lastAppendError = null;
}

const GATES: LiveEnforceGate[] = [
  'cost_bar',
  'spread',
  'otm_delta_floor',
  'universe',
  // TRA-3394 — both ceiling axes are listed so each publishes a row at
  // `evaluated: 0` before it has ever fired. A gate that is absent from the
  // payload and a gate that is present-and-silent are the same JSON to a grader
  // otherwise, and this gate's expected healthy read is precisely
  // `evaluated > 0, blocked = 0` (n=20 above 0.55 on the whole tape).
  'entry_delta_ceiling',
  'entry_delta_ceiling_shadow',
  // TRA-3445 — same reasoning: publish a zero row so an aggregate cap that has
  // never been reached is distinguishable from one that is not wired in.
  'aggregate_cap',
];

/** Apply one decision to the in-memory tallies (shared by record + hydrate). */
function apply(rec: LiveEnforceRecord): void {
  let day = byDay.get(rec.etDay);
  if (!day) {
    day = new Map();
    byDay.set(rec.etDay, day);
  }
  let tallies = day.get(rec.gate);
  if (!tallies) {
    tallies = emptyTallies();
    day.set(rec.gate, tallies);
  }
  bump(tallies.byScope, rec.scope, rec.blocked);
  bump(tallies.byBook, rec.book ?? UNATTRIBUTED_BOOK, rec.blocked);
  // Blocked rows ONLY: an admitted candidate has no rejection classification, and
  // folding admits into this axis under a synthetic "admitted" key would make the
  // dominant bucket of every gate the one that explains nothing.
  if (rec.blocked && typeof rec.reasonCode === 'string' && rec.reasonCode !== '') {
    bump(tallies.byReason, rec.reasonCode, true);
  } else if (rec.blocked) {
    // TRA-3483 (D2) — a block with no classification is NOT absent from the
    // ledger, it is absent from `byReason`. On the retained 6-day fold 1759 of
    // 1929 cost_bar blocks predate reason stamping, so `gross_negative`'s
    // published `share` of 0.0881 reads as a RATE when it is a COVERAGE artifact.
    // Counting them here puts the missing denominator on the payload.
    tallies.blockedUnclassified += 1;
  }
  // TRA-3391 — cell axis, admits INCLUDED (`bump` counts evaluated and, when
  // blocked, blocked). Only rows that actually carry a cell contribute: a missing
  // cell is "never stamped", not a bucket.
  if (typeof rec.cell === 'string' && rec.cell !== '') {
    bump(tallies.byCell, rec.cell, rec.blocked);
  }
  // TRA-3510 — nominator branch, admits INCLUDED. A gate whose whole `blocked`
  // count sits on `in_band` is reporting a bound the SELECTOR imposed, not one it
  // measured; that is only visible if admits are on the same axis as blocks.
  if (rec.nominator && SELECTIONS.includes(rec.nominator.selection)) {
    bumpSelection(tallies.bySelection, rec.nominator, rec.blocked);
  }
  // TRA-3483 — the cost/edge sample. A row with no usable cost is COUNTED as
  // missing rather than skipped: the sweep's denominator has to be visible, and a
  // silently shorter sample list is exactly how a coverage gap reads as a rate.
  if (rec.cost && Number.isFinite(rec.cost.costR) && Number.isFinite(rec.cost.costFracOfPremium)) {
    if (tallies.costSamples.length < MAX_COST_SAMPLES_PER_GATE_DAY) {
      tallies.costSamples.push({
        costR: rec.cost.costR,
        spreadR: rec.cost.spreadR,
        feeR: rec.cost.feeR,
        costFracOfPremium: rec.cost.costFracOfPremium,
        grossR: typeof rec.grossR === 'number' && Number.isFinite(rec.grossR) ? rec.grossR : null,
        blocked: rec.blocked,
        cell: typeof rec.cell === 'string' && rec.cell !== '' ? rec.cell : null,
      });
    } else {
      tallies.costSamplesDropped += 1;
    }
  } else if (rec.gate === 'cost_bar') {
    // Scoped to `cost_bar`: the other gates never carry a cost at all, and
    // counting them here would publish `rowsMissingCostR === evaluated` on a gate
    // that was never instrumented — a fake coverage hole.
    tallies.costRowsMissing += 1;
  }
  decisionsTotal += 1;
  lastDecisionAt = rec.ts;
}

/**
 * Record one ARMED-LIVE gate decision and append one JSONL line under the
 * configured DATA_DIR. Best-effort on IO — a write failure logs, is COUNTED
 * (`appendErrors`), and is swallowed so this accounting can never break a live
 * order path. When no dataDir is configured (unit tests / CLI without boot) the
 * in-memory counts still update; only the file write is skipped.
 */
export function recordLiveEnforceDecision(
  gate: LiveEnforceGate,
  scope: string,
  blocked: boolean,
  etDay: string,
  reason?: string,
  now: number = Date.now(),
  // TRA-3216 — trailing options bag so the three pre-existing call sites keep
  // their positional signature unchanged.
  opts?: {
    reasonCode?: string;
    book?: string | null;
    cell?: string | null;
    // TRA-3483 — the cost NUMERATOR and edge DENOMINATOR of the net-edge
    // comparison, on every cost_bar verdict, admits included. Both optional:
    // `cost: null` is the unusable-quote case, `grossR` non-finite is the
    // unknown-edge case, and each has to stay distinguishable from the other.
    cost?: LiveEnforceRecord['cost'] | null;
    grossR?: number | null;
    // TRA-3510 — which TRA-3401 branch nominated this candidate. Null/absent on
    // every non-OTM call site, which is the honest reading: those rows were not
    // produced by the OTM nominator at all.
    nominator?: LiveEnforceNominator | null;
  },
): void {
  const cost = opts?.cost;
  const costUsable =
    !!cost
    && Number.isFinite(cost.costR)
    && Number.isFinite(cost.spreadR)
    && Number.isFinite(cost.feeR)
    && Number.isFinite(cost.costFracOfPremium);
  const rec: LiveEnforceRecord = {
    ts: now,
    etDay,
    gate,
    scope,
    blocked,
    ...(blocked && reason ? { reason } : {}),
    ...(blocked && opts?.reasonCode ? { reasonCode: opts.reasonCode } : {}),
    ...(typeof opts?.book === 'string' && opts.book !== '' ? { book: opts.book } : {}),
    ...(typeof opts?.cell === 'string' && opts.cell !== '' ? { cell: opts.cell } : {}),
    ...(costUsable ? { cost: cost! } : {}),
    ...(typeof opts?.grossR === 'number' && Number.isFinite(opts.grossR) ? { grossR: opts.grossR } : {}),
    ...(usableNominator(opts?.nominator) ? { nominator: opts!.nominator! } : {}),
  };
  applyAndAppend(rec);
}

function applyAndAppend(rec: LiveEnforceRecord): void {
  // In-memory tally updates FIRST and UNCONDITIONALLY, then the disk write is
  // attempted best-effort — so accounting can never break a live order pass. But
  // that means the counters are NOT proof anything reached disk: `durability`
  // below is the field that tells a memory-only / failed-append ledger apart from a
  // clean durable write (TRA-1681).
  apply(rec);
  if (dataDir == null) return;
  const path = liveEnforceGateLogPath(dataDir);
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
    log.warn('live-enforce-gate append failed', { reason: lastAppendError });
  }
}

/**
 * TRA-3483 — is a persisted `cost` block usable? Every term must be a finite
 * number: a partially-written block would otherwise put a NaN into the quantile
 * sort, which silently corrupts the whole day's distribution rather than showing
 * up as one bad row.
 */
function hydratedCost(cost: LiveEnforceRecord['cost']): boolean {
  return (
    !!cost
    && typeof cost === 'object'
    && Number.isFinite(cost.costR)
    && Number.isFinite(cost.spreadR)
    && Number.isFinite(cost.feeR)
    && Number.isFinite(cost.costFracOfPremium)
  );
}

/**
 * TRA-3510 — is a nominator block usable? `selection` must be one of the four
 * KNOWN branches: this value becomes a map key, so accepting an arbitrary string
 * off a persisted line would let a corrupt row invent an unbounded axis. Both
 * chain counts must be finite non-negative integers for the same reason a NaN
 * `costR` is rejected — one bad row would otherwise poison a published mean.
 *
 * Shared by the write path and the hydrate path deliberately: a row this refuses
 * to record must also be a row it refuses to read back.
 *
 * TRA-3619's `strikesConsidered` / `strikesInBand` are deliberately NOT part of
 * this predicate. They post-date the field, so requiring them would reject every
 * previously-written nominator block on hydrate and vaporize the retained
 * `bySelection` axis. They are validated where they are USED
 * ({@link isStrikeCount}), which drops a bad pair without dropping the row.
 */
function usableNominator(nom: LiveEnforceNominator | null | undefined): boolean {
  return (
    !!nom
    && typeof nom === 'object'
    && SELECTIONS.includes(nom.selection)
    && Number.isInteger(nom.cheapConsidered) && nom.cheapConsidered >= 0
    && Number.isInteger(nom.cheapInBand) && nom.cheapInBand >= 0
  );
}

/**
 * TRA-3619 — a strike count is a non-negative integer or it is absent. Anything
 * else (NaN off a truncated line, a float, a negative) contributes NO sample
 * rather than a poisoned one, exactly as {@link bumpSelection} treats a
 * non-finite cheap count.
 */
function isStrikeCount(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** What {@link hydrateLiveEnforceGateFromDisk} recovered (for the boot log line). */
export interface LiveEnforceGateHydration {
  days: number;
  records: number;
}

/**
 * Rebuild the in-memory tallies from disk on boot and remember `dir` for
 * subsequent appends. Idempotent: CLEARS first, so it is safe to call once at
 * startup before any live pass. Only records within {@link RETAIN_MS} of `now` are
 * kept, and the file is COMPACTED to exactly those lines. Best-effort: a
 * missing/corrupt file yields an empty hydration; a torn trailing line is skipped.
 */
export function hydrateLiveEnforceGateFromDisk(dir: string, now: number = Date.now()): LiveEnforceGateHydration {
  clearLiveEnforceGateLedger();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(liveEnforceGateLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let rec: LiveEnforceRecord;
    try {
      rec = JSON.parse(trimmed) as LiveEnforceRecord;
    } catch {
      continue; // skip a torn/partial line rather than abort the hydrate
    }
    if (typeof rec.ts !== 'number' || !Number.isFinite(rec.ts) || rec.ts < cutoff) continue;
    if (typeof rec.etDay !== 'string' || rec.etDay === '') continue;
    if (!GATES.includes(rec.gate)) continue;
    if (typeof rec.scope !== 'string' || rec.scope === '') continue;
    if (typeof rec.blocked !== 'boolean') continue;
    const clean: LiveEnforceRecord = {
      ts: rec.ts,
      etDay: rec.etDay,
      gate: rec.gate,
      scope: rec.scope,
      blocked: rec.blocked,
      ...(rec.blocked && typeof rec.reason === 'string' ? { reason: rec.reason } : {}),
      // TRA-3216 — rows written before these fields existed simply lack them; they
      // hydrate into the `unattributed` book and contribute no byReason row, which
      // is the honest reading (the classification was never recorded), not a zero.
      ...(rec.blocked && typeof rec.reasonCode === 'string' && rec.reasonCode !== ''
        ? { reasonCode: rec.reasonCode }
        : {}),
      ...(typeof rec.book === 'string' && rec.book !== '' ? { book: rec.book } : {}),
      ...(typeof rec.cell === 'string' && rec.cell !== '' ? { cell: rec.cell } : {}),
      // TRA-3483 — a row written before the cost fields existed simply lacks
      // them and hydrates as a MISSING sample (counted), never as a zero.
      ...(hydratedCost(rec.cost) ? { cost: rec.cost! } : {}),
      ...(typeof rec.grossR === 'number' && Number.isFinite(rec.grossR) ? { grossR: rec.grossR } : {}),
      // TRA-3510 — a row written before the nominator axis existed simply lacks
      // it and contributes no `bySelection` key. That is what makes the axis
      // honest across the deploy boundary: the retained fold's `bySelection`
      // denominator is the rows that were STAMPED, never the gate's `evaluated`.
      ...(usableNominator(rec.nominator)
        ? {
          nominator: {
            selection: rec.nominator!.selection,
            cheapConsidered: rec.nominator!.cheapConsidered,
            cheapInBand: rec.nominator!.cheapInBand,
            // TRA-3619 — carried only when the pair is BOTH present and sane.
            // A row from before the field, or one holding half of it, hydrates
            // with no strike shape and lands outside `rowsWithStrikeShape`,
            // which is what keeps `meanStrikesInBand` a mean over rows that
            // actually measured it.
            ...(isStrikeCount(rec.nominator!.strikesConsidered)
              && isStrikeCount(rec.nominator!.strikesInBand)
              ? {
                strikesConsidered: rec.nominator!.strikesConsidered,
                strikesInBand: rec.nominator!.strikesInBand,
              }
              : {}),
          },
        }
        : {}),
    };
    apply(clean);
    kept.push(JSON.stringify(clean));
  }

  // Compact: rewrite the file to the retained lines only (best-effort). Skipped
  // when there is nothing to drop, to avoid a needless rewrite on every clean boot.
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = liveEnforceGateLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('live-enforce-gate compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hydratedRecords = kept.length;
  hydratedDays = byDay.size;
  return { days: byDay.size, records: kept.length };
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface LiveEnforceScopeSummary {
  scope: string;
  evaluated: number;
  blocked: number;
  /** blocked / evaluated; **`null` when the gate ruled on nothing** (not 0 — TRA-1707/TRA-1682). */
  blockRate: number | null;
}

/**
 * TRA-3216 — the tuning axis. One row per normalized block classification,
 * heaviest first. **Blocks only** — `share` is of this gate's BLOCKED total, so
 * the rows sum to 1 and read directly as "which term dominated".
 */
export interface LiveEnforceReasonSummary {
  reasonCode: string;
  blocked: number;
  /** blocked / (this gate's blocked total); `null` when the gate blocked nothing. */
  share: number | null;
}

/**
 * TRA-3216 — the FLEET axis. One row per live book (`alertUsername`) the gate
 * actually ruled for, plus `unattributed` for verdicts whose call site could not
 * name a book. A process-level flag reads identically for a book it does not
 * govern; this is the split that tells the two apart.
 */
export interface LiveEnforceBookSummary {
  book: string;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
}

/**
 * TRA-3391 — the EVIDENCE axis. One row per tape cell (`structure::|delta|
 * bucket`) the gate decided under, busiest first. Unlike `byReason` this counts
 * ADMITS too: an admitted cell is exactly what a grader checks against the
 * published expectancy table, and a cell that only ever appears with
 * `evaluated === blocked` is one the live universe has never had evidence for.
 *
 * Empty on a gate that stamps no cell (`spread`, `universe`, `otm_delta_floor`)
 * and on rows written before the field existed — never a synthetic bucket.
 */
export interface LiveEnforceCellSummary {
  cell: string;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
  /**
   * TRA-3483 — the `costR` distribution WITHIN this cell, which is the only place
   * it can discriminate anything: every row in a cell shares the same
   * `modeledGrossR` (the cell lower bound), so the cell-level cost spread IS the
   * within-cell decision boundary a `k` would move. Null on cells with no sample.
   */
  costRQuantiles: CostRQuantiles | null;
}

/**
 * TRA-3510 — one nominator branch's contribution to a gate.
 *
 * ## How to read it
 *
 * `entry_delta_ceiling_shadow` at `blocked: 0` is only informative once this axis
 * is present:
 *
 *   • rows concentrated on `in_band` ⇒ the zero is BY CONSTRUCTION. The selector
 *     nominated inside `[min, max)` and the ceiling sits at `max`, so no row it
 *     saw was capable of breaching. Do not publish that zero as a tail estimate.
 *   • rows on `fallback_top_mispricing` / `legacy` ⇒ the far tail WAS nominated
 *     and did not breach. That zero is a measurement.
 *
 * The same reading, mirrored, applies to `otm_delta_floor`: an `in_band` row
 * cannot breach a floor at or below the band's `min` either.
 */
export interface LiveEnforceSelectionSummary {
  /** `in_band` | `fallback_top_mispricing` | `legacy` | `none`. */
  selection: string;
  evaluated: number;
  blocked: number;
  /** blocked / evaluated; `null` when this branch produced nothing. */
  blockRate: number | null;
  /**
   * Rows on this branch carrying the chain-shape numbers — the DENOMINATOR of
   * the two means below, published rather than implied so a partially-stamped
   * fold cannot read as a complete one.
   */
  rowsWithChainShape: number;
  /** Mean `cheap` candidates the chain offered, over `rowsWithChainShape`. */
  meanCheapConsidered: number | null;
  /**
   * Mean `cheap` candidates that landed INSIDE the armed band. On a
   * `fallback_top_mispricing` row this is 0 by definition (the fallback is taken
   * precisely because nothing was in band), so a nonzero value here on that
   * branch would be a wiring defect, not a finding.
   */
  meanCheapInBand: number | null;
  /**
   * TRA-3619 — rows on this branch carrying the PRE-CHEAPNESS strike counts.
   * Its own denominator, separate from `rowsWithChainShape`: rows written before
   * the field carry the cheap pair and not this one, and a fold across that
   * boundary must not divide a partial numerator by a complete denominator.
   * `0` here with `rowsWithChainShape > 0` means "this fold predates the
   * measurement", NOT "the chain had no strikes".
   */
  rowsWithStrikeShape: number;
  /**
   * TRA-3619 — mean candidates the scanner offered BEFORE the cheapness screen,
   * over `rowsWithStrikeShape`. Post-liquidity, not the raw chain.
   */
  meanStrikesConsidered: number | null;
  /**
   * TRA-3619 — **the separator.** Mean candidates whose |Δ| sat inside the band,
   * counted BEFORE `classification === 'cheap'` is applied.
   *
   * Read it against `meanCheapInBand` on the `fallback_top_mispricing` branch,
   * where `meanCheapInBand` is 0 by construction:
   *
   *   • `meanStrikesInBand ≈ 0` ⇒ the band is EMPTY IN THE CHAIN. Re-ordering the
   *     screens cannot manufacture a strike that is not there; the band edges are
   *     the open question (TRA-3401 / board).
   *   • `meanStrikesInBand ≥ 1` ⇒ the chain HELD in-band strikes and the cheapness
   *     screen discarded them upstream of the band filter. The screen ORDER is
   *     then the lever.
   *
   * `null` on the dark `legacy` branch's semantics is not how this reports: the
   * selector writes 0 there (the band is never consulted), and `legacy` is its
   * own axis key, so a dark 0 can never be pooled with an armed branch's zero.
   */
  meanStrikesInBand: number | null;
}

/**
 * TRA-3483 — a distribution, published as quantiles rather than a mean. The bar
 * is a THRESHOLD, so what decides how many candidates a given `k` admits is the
 * SHAPE of the cost distribution near it; a mean cannot answer that and a mean is
 * all the deployed surface could have offered.
 */
export interface QuantileBlock {
  /** Samples behind these quantiles. */
  n: number;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
}

/**
 * TRA-3483 — the per-decision `costR` distribution: the NUMERATOR of
 * `admit ⟺ costR ≤ k · modeledGrossR`, in the same `R_gate` unit as `barR`.
 *
 * The decomposition is published beside it because the two terms behave
 * completely differently under a retune: `feeR` is a constant per share
 * ($0.229/contract RT ÷ 100 ÷ risk), while `spreadR` is the candidate's OWN quote
 * and is ~82% of the modeled bar (0.235 of 0.285). A `k` chosen against the
 * aggregate without seeing which term moves is a `k` chosen against the fee floor.
 */
export interface CostRQuantiles extends QuantileBlock {
  /** The spread-cross term alone, same R unit. */
  spreadR: QuantileBlock;
  /** The commission/fee term alone, same R unit. */
  feeR: QuantileBlock;
  /** Median of `spreadR / costR` — how much of the cost the quote (not the fee) is. */
  medianSpreadShareOfCost: number | null;
  /**
   * Rows in this fold that carried NO usable `costR` (unusable quote at decision
   * time, or written before TRA-3483). `n + rowsMissingCostR` is the fold's row
   * count — publishing it is what stops a partial-coverage quantile from reading
   * as the day's distribution.
   */
  rowsMissingCostR: number;
  /** Samples dropped by the retention cap; > 0 ⇒ these quantiles are over a truncated head. */
  samplesDropped: number;
}

/** TRA-3483 — one counterfactual `k` on the recorded row set. Decides nothing. */
export interface NetEdgeShadowSweepRow {
  k: number;
  /** Rows the net-edge form at this `k` WOULD have admitted. */
  admits: number;
  /** admits / rowsEvaluated; null when the fold evaluated nothing. */
  admitRate: number | null;
  /**
   * median(`modeledGrossR − costR`) over the rows this `k` admits — the R2
   * acceptance statistic in TRA-3481, and the one thing that cannot be
   * reconstructed from counts. Null when this `k` admits nothing.
   */
  medianNetR_admitted: number | null;
}

/**
 * TRA-3483 — the counterfactual k-sweep. **A RECORDER, NOT A GATE.**
 * `ENABLE_OPTION_COST_BAR_NET_EDGE` is `false`; every number here describes what
 * a form that is NOT running would have done to rows a form that IS running
 * already decided. Nothing in this block feeds a verdict.
 */
export interface NetEdgeShadowSummary {
  /** The ET day folded, or null on the multi-day `retained` view. */
  etDay: string | null;
  /** ET days behind the fold (one entry on the day view). */
  etDays: string[];
  /** Every `cost_bar` verdict in the fold — the COVERAGE denominator. */
  rowsRecorded: number;
  /**
   * Rows the sweep could evaluate: those carrying a usable `costR`. Rows with an
   * unusable quote are EXCLUDED here and reported below, because under the real
   * net-edge form they are `net_edge_quote_unusable` blocks at every `k` — they
   * would depress every admit rate identically and tell a reader nothing.
   */
  rowsEvaluated: number;
  /** Rows with no usable cost (unusable quote / pre-instrumentation). */
  rowsMissingCostR: number;
  /**
   * Evaluated rows whose modeled edge was unknown. These fail closed at every
   * `k` and are counted IN `rowsEvaluated` — an unknown edge is a real block
   * under the net-edge form, not missing data about the cost side.
   */
  rowsMissingGrossR: number;
  /** Evaluated rows the k-INDEPENDENT absolute ceiling blocks; a floor under every sweep row. */
  rowsBlockedByAbsCeiling: number;
  /** The ceiling those rows were tested against (resolved config, not a literal). */
  absCostFracCeiling: number;
  /**
   * Admits under the CURRENTLY DEPLOYED form on the IDENTICAL row set
   * (`rowsEvaluated`) — the baseline every sweep row is read against. Without it
   * a sweep row is a number with no comparator.
   */
  flatFormAdmits: number;
  /** Admits under the deployed form over ALL recorded rows, incl. those with no cost sample. */
  flatFormAdmitsAllRows: number;
  sweep: NetEdgeShadowSweepRow[];
}

export interface LiveEnforceGateSummary {
  gate: LiveEnforceGate;
  evaluated: number;
  blocked: number;
  blockRate: number | null;
  /** Per-scope split, busiest first. */
  byScope: LiveEnforceScopeSummary[];
  /** Per-reason split of the BLOCKS, heaviest first (TRA-3216). */
  byReason: LiveEnforceReasonSummary[];
  /**
   * TRA-3483 (D2) — BLOCKED rows in this fold carrying NO `reasonCode`, i.e. rows
   * `byReason` cannot see. `share` on every `byReason` row is of `blocked`, which
   * INCLUDES these, so a nonzero value here says the rows do not sum to 1 by
   * design and the gap is coverage, not a residual bucket. On the retained fold
   * this is the 1759 pre-stamping blocks that made `gross_negative 0.0881` read
   * as a rate.
   */
  blockedUnclassified: number;
  /** Per-live-book split, busiest first (TRA-3216). */
  byBook: LiveEnforceBookSummary[];
  /** Per-tape-cell split, busiest first; admits included (TRA-3391). */
  byCell: LiveEnforceCellSummary[];
  /**
   * TRA-3510 — per-NOMINATOR-BRANCH split, busiest first; admits included. This
   * is the axis that makes a zero on a delta gate readable — see
   * {@link LiveEnforceRecord.nominator}. An EMPTY array on a gate with
   * `evaluated > 0` means those rows predate the axis or came from a non-OTM
   * path; it never means "one branch produced them all".
   */
  bySelection: LiveEnforceSelectionSummary[];
  /**
   * TRA-3483 — the `costR` distribution over this fold. Non-null on `cost_bar`
   * (even at `n: 0`, so "not instrumented" and "instrumented, no rows yet" stay
   * distinguishable); null on every gate that records no cost.
   */
  costRQuantiles: CostRQuantiles | null;
  /** TRA-3483 — the counterfactual k-sweep. Non-null on `cost_bar` only. */
  netEdgeShadow: NetEdgeShadowSummary | null;
}

export interface LiveEnforceDurability {
  /** Resolved append target. `null` = memory-only: no boot hydrate ran, NOTHING is durable. */
  dataDir: string | null;
  /** TRUE ⇒ every count in this payload dies on the next redeploy (fix = DATA_DIR=/data). */
  ephemeral: boolean;
  /** Records recovered FROM DISK at boot. Distinguishes a real floor from this-uptime-only. */
  hydratedRecords: number;
  hydratedDays: number;
  /** Appends that threw and were SWALLOWED. > 0 ⇒ the counters overstate what is on disk. */
  appendErrors: number;
  lastAppendError: string | null;
}

export interface LiveEnforceSummary {
  /** Total decisions recorded (live + hydrated, across retained days). */
  decisionsRecorded: number;
  /** Per-gate fold for the requested ET day. */
  byGate: LiveEnforceGateSummary[];
  /** Same fold across EVERY retained ET day (a one-day counter self-clears at midnight). */
  retained: {
    etDays: string[];
    retentionDays: number;
    byGate: LiveEnforceGateSummary[];
  };
  durability: LiveEnforceDurability;
  lastDecisionAt: number | null;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── TRA-3483 — quantiles and the counterfactual sweep ────────────────────────

/**
 * Nearest-rank quantile on an ALREADY-SORTED ascending array. Nearest-rank (not
 * linear interpolation) on purpose: every value returned is a value that actually
 * occurred, so `p50` names a real candidate's cost and can be traced back to a
 * decision rather than being a synthetic point between two of them.
 */
function quantileSorted(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/** Median of an arbitrary (unsorted) sample, or null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return quantileSorted([...values].sort((a, b) => a - b), 0.5);
}

function quantileBlock(values: number[]): QuantileBlock {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const q = (p: number): number | null => {
    const v = quantileSorted(sorted, p);
    return v === null ? null : round(v, 6);
  };
  return {
    n,
    p10: q(0.10),
    p25: q(0.25),
    p50: q(0.50),
    p75: q(0.75),
    p90: q(0.90),
    min: n > 0 ? round(sorted[0]!, 6) : null,
    max: n > 0 ? round(sorted[n - 1]!, 6) : null,
    mean: n > 0 ? round(sorted.reduce((a, b) => a + b, 0) / n, 6) : null,
  };
}

/** Fold a sample list into the published `costR` distribution + its decomposition. */
function costRQuantiles(samples: CostSample[], rowsMissingCostR: number, samplesDropped: number): CostRQuantiles {
  const shares = samples
    .filter((s) => s.costR !== 0 && Number.isFinite(s.spreadR / s.costR))
    .map((s) => s.spreadR / s.costR);
  const medianShare = median(shares);
  return {
    ...quantileBlock(samples.map((s) => s.costR)),
    spreadR: quantileBlock(samples.map((s) => s.spreadR)),
    feeR: quantileBlock(samples.map((s) => s.feeR)),
    medianSpreadShareOfCost: medianShare === null ? null : round(medianShare),
    rowsMissingCostR,
    samplesDropped,
  };
}

/** Options for the counterfactual sweep — resolved config, never literals. */
export interface NetEdgeShadowOptions {
  /** The `k` grid. Defaults to {@link NET_EDGE_SHADOW_K_SWEEP}. */
  ks?: readonly number[];
  /** The k-independent absolute ceiling the sweep replays. Defaults to the shipped config. */
  absCostFracCeiling?: number;
}

/**
 * TRA-3483 I2 — fold the recorded decisions into the counterfactual sweep.
 *
 * PURE and READ-ONLY. It replays {@link netEdgeShadowAdmits} — the same admit
 * order the real form uses — over rows that a DIFFERENT form already decided. The
 * `flatFormAdmits` baseline is taken from the same row set so the comparison is
 * paired, not two populations.
 */
function netEdgeShadow(
  tallies: GateTallies,
  etDay: string | null,
  etDays: string[],
  rowsRecorded: number,
  rowsBlocked: number,
  opts: NetEdgeShadowOptions,
): NetEdgeShadowSummary {
  const ks = opts.ks ?? NET_EDGE_SHADOW_K_SWEEP;
  const ceiling = opts.absCostFracCeiling ?? DEFAULT_NET_EDGE_BAR_CONFIG.absCostFracCeiling;
  const samples = tallies.costSamples;
  const sweep: NetEdgeShadowSweepRow[] = ks.map((k) => {
    const admitted = samples.filter((s) => netEdgeShadowAdmits(s, k, ceiling));
    const netR = admitted.map((s) => (s.grossR ?? Number.NaN) - s.costR).filter((v) => Number.isFinite(v));
    const med = median(netR);
    return {
      k,
      admits: admitted.length,
      admitRate: samples.length > 0 ? round(admitted.length / samples.length) : null,
      medianNetR_admitted: med === null ? null : round(med, 6),
    };
  });
  return {
    etDay,
    etDays,
    rowsRecorded,
    rowsEvaluated: samples.length,
    rowsMissingCostR: tallies.costRowsMissing,
    rowsMissingGrossR: samples.filter((s) => s.grossR === null).length,
    rowsBlockedByAbsCeiling: samples.filter((s) => s.costFracOfPremium > ceiling).length,
    absCostFracCeiling: ceiling,
    // The DEPLOYED form's verdict on the identical rows: `blocked === false`.
    flatFormAdmits: samples.filter((s) => !s.blocked).length,
    flatFormAdmitsAllRows: rowsRecorded - rowsBlocked,
    sweep,
  };
}

/** Fold a gate->tallies map for one or more days into the per-gate rows. */
function foldGates(
  acc: Map<LiveEnforceGate, GateTallies>,
  etDay: string | null,
  etDays: string[],
  shadowOpts: NetEdgeShadowOptions,
): LiveEnforceGateSummary[] {
  const out: LiveEnforceGateSummary[] = [];
  for (const gate of GATES) {
    const tallies = acc.get(gate) ?? emptyTallies();
    let evaluated = 0;
    let blocked = 0;
    const byScope: LiveEnforceScopeSummary[] = [];
    for (const [scope, t] of tallies.byScope.entries()) {
      evaluated += t.evaluated;
      blocked += t.blocked;
      byScope.push({
        scope,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
      });
    }
    byScope.sort((a, b) => b.evaluated - a.evaluated);

    const byBook: LiveEnforceBookSummary[] = [];
    for (const [book, t] of tallies.byBook.entries()) {
      byBook.push({
        book,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
      });
    }
    byBook.sort((a, b) => b.evaluated - a.evaluated);

    // `share` denominator is the gate's BLOCKED total (from byScope, which counts
    // every row) — NOT the sum of the byReason rows. Using the rows' own sum would
    // silently renormalize away any block that carried no classification, making
    // partial coverage read as complete.
    const byReason: LiveEnforceReasonSummary[] = [];
    for (const [reasonCode, t] of tallies.byReason.entries()) {
      byReason.push({
        reasonCode,
        blocked: t.blocked,
        share: blocked > 0 ? round(t.blocked / blocked) : null,
      });
    }
    byReason.sort((a, b) => b.blocked - a.blocked);

    // TRA-3483 — bucket the cost samples by cell ONCE rather than filtering the
    // full list per cell (that is O(cells × rows) on a 20k-row day).
    const samplesByCell = new Map<string, CostSample[]>();
    for (const s of tallies.costSamples) {
      if (s.cell === null) continue;
      const list = samplesByCell.get(s.cell);
      if (list) list.push(s);
      else samplesByCell.set(s.cell, [s]);
    }

    const byCell: LiveEnforceCellSummary[] = [];
    for (const [cell, t] of tallies.byCell.entries()) {
      const cellSamples = samplesByCell.get(cell) ?? [];
      byCell.push({
        cell,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
        // Missing = this cell's rows that produced no sample. Derived from the
        // cell's own `evaluated`, so a cell whose quotes were unusable shows the
        // hole instead of publishing quantiles over the surviving minority.
        costRQuantiles:
          cellSamples.length > 0
            ? costRQuantiles(cellSamples, Math.max(0, t.evaluated - cellSamples.length), 0)
            : null,
      });
    }
    byCell.sort((a, b) => b.evaluated - a.evaluated || a.cell.localeCompare(b.cell));

    // TRA-3510 — the nominator axis. Means are derived HERE from the retained
    // sums over `rowsWithChainShape`, never from `evaluated`: a fold that spans
    // the deploy boundary holds rows that carry no chain shape, and dividing by
    // `evaluated` would silently deflate both means toward zero.
    const bySelection: LiveEnforceSelectionSummary[] = [];
    for (const [selection, t] of tallies.bySelection.entries()) {
      bySelection.push({
        selection,
        evaluated: t.evaluated,
        blocked: t.blocked,
        blockRate: t.evaluated > 0 ? round(t.blocked / t.evaluated) : null,
        rowsWithChainShape: t.rowsWithChainShape,
        meanCheapConsidered:
          t.rowsWithChainShape > 0 ? round(t.cheapConsideredSum / t.rowsWithChainShape) : null,
        meanCheapInBand:
          t.rowsWithChainShape > 0 ? round(t.cheapInBandSum / t.rowsWithChainShape) : null,
        // TRA-3619 — the pre-cheapness pair, over its OWN denominator.
        rowsWithStrikeShape: t.rowsWithStrikeShape,
        meanStrikesConsidered:
          t.rowsWithStrikeShape > 0 ? round(t.strikesConsideredSum / t.rowsWithStrikeShape) : null,
        meanStrikesInBand:
          t.rowsWithStrikeShape > 0 ? round(t.strikesInBandSum / t.rowsWithStrikeShape) : null,
      });
    }
    bySelection.sort((a, b) => b.evaluated - a.evaluated || a.selection.localeCompare(b.selection));

    // TRA-3483 — cost instrumentation is `cost_bar`-only. Published as an object
    // at `n: 0` rather than omitted on that gate, so "the recorder is not
    // deployed" cannot read the same as "deployed, no live candidates yet" —
    // the same distinction the zero gate rows exist for.
    const instrumented = gate === 'cost_bar';

    out.push({
      gate,
      evaluated,
      blocked,
      blockRate: evaluated > 0 ? round(blocked / evaluated) : null,
      byScope,
      byReason,
      blockedUnclassified: tallies.blockedUnclassified,
      byBook,
      byCell,
      bySelection,
      costRQuantiles: instrumented
        ? costRQuantiles(tallies.costSamples, tallies.costRowsMissing, tallies.costSamplesDropped)
        : null,
      netEdgeShadow: instrumented
        ? netEdgeShadow(tallies, etDay, etDays, evaluated, blocked, shadowOpts)
        : null,
    });
  }
  return out;
}

/** Merge one axis map into an accumulator. */
function mergeAxis(into: Map<string, GateScopeTally>, from: Map<string, GateScopeTally>): void {
  for (const [key, t] of from.entries()) {
    const cur = into.get(key) ?? { evaluated: 0, blocked: 0 };
    cur.evaluated += t.evaluated;
    cur.blocked += t.blocked;
    into.set(key, cur);
  }
}

/**
 * TRA-3510 — merge the selection axis. Separate from {@link mergeAxis} because
 * the chain-shape SUMS and their own row denominator have to travel with the
 * counters; folding this axis with `mergeAxis` would drop them and publish
 * `meanCheapInBand: null` on every retained row.
 */
function mergeSelectionAxis(
  into: Map<string, GateSelectionTally>,
  from: Map<string, GateSelectionTally>,
): void {
  for (const [key, t] of from.entries()) {
    const cur = into.get(key) ?? emptySelectionTally();
    cur.evaluated += t.evaluated;
    cur.blocked += t.blocked;
    cur.cheapConsideredSum += t.cheapConsideredSum;
    cur.cheapInBandSum += t.cheapInBandSum;
    cur.rowsWithChainShape += t.rowsWithChainShape;
    // TRA-3619 — the strike pair travels with its own denominator, or the
    // retained view would publish `meanStrikesInBand: null` on every row.
    cur.strikesConsideredSum += t.strikesConsideredSum;
    cur.strikesInBandSum += t.strikesInBandSum;
    cur.rowsWithStrikeShape += t.rowsWithStrikeShape;
    into.set(key, cur);
  }
}

/** Merge every retained day into one gate->tallies accumulator. */
function accumulateAllDays(): Map<LiveEnforceGate, GateTallies> {
  const acc = new Map<LiveEnforceGate, GateTallies>();
  for (const day of byDay.values()) {
    for (const [gate, tallies] of day.entries()) {
      let into = acc.get(gate);
      if (!into) {
        into = emptyTallies();
        acc.set(gate, into);
      }
      mergeAxis(into.byScope, tallies.byScope);
      mergeAxis(into.byReason, tallies.byReason);
      mergeAxis(into.byBook, tallies.byBook);
      mergeAxis(into.byCell, tallies.byCell);
      mergeSelectionAxis(into.bySelection, tallies.bySelection);
      // TRA-3483 — samples concatenate (the retained sweep is over the union of
      // days), still under the same cap so a runaway day cannot unbound the fold.
      for (const s of tallies.costSamples) {
        if (into.costSamples.length < MAX_COST_SAMPLES_PER_GATE_DAY) into.costSamples.push(s);
        else into.costSamplesDropped += 1;
      }
      into.costRowsMissing += tallies.costRowsMissing;
      into.costSamplesDropped += tallies.costSamplesDropped;
      into.blockedUnclassified += tallies.blockedUnclassified;
    }
  }
  return acc;
}

/**
 * Fold the store into the read-only health diagnostics for `etDay`. Pure — no IO.
 * An all-zero read on an ARMED gate means it saw no live candidates this day, NOT
 * that it is inert; `blocked > 0` is the direct evidence it is biting, and
 * `evaluated > 0 with blocked === 0` is an armed gate that passed everything.
 */
export function summarizeLiveEnforceGate(
  etDay: string,
  // TRA-3483 — the sweep's ceiling comes from the caller's RESOLVED net-edge
  // config, not from a literal in here: a ceiling that drifts from the deployed
  // one would publish a counterfactual for a form nobody could arm.
  shadowOpts: NetEdgeShadowOptions = {},
): LiveEnforceSummary {
  const day = byDay.get(etDay) ?? new Map<LiveEnforceGate, GateTallies>();
  const retainedDays = [...byDay.keys()].sort();
  return {
    decisionsRecorded: decisionsTotal,
    byGate: foldGates(day, etDay, [etDay], shadowOpts),
    retained: {
      etDays: retainedDays,
      retentionDays: RETAIN_MS / (24 * 60 * 60 * 1000),
      byGate: foldGates(accumulateAllDays(), null, retainedDays, shadowOpts),
    },
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
