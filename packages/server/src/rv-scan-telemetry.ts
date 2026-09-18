// TRA-2193 — per-scan telemetry for the option single-leg entry paths, so "the
// scanner ran and found nothing" stops reading identically to "the scanner never
// ran". TRA-2245 — these paths no longer share ONE journal label: the `directional`
// and `iv_rv_buy_premium` paths journal `single_leg_directional`; only `rv_scan`
// (compile-time OFF, TRA-1207) journals `single_leg_rv`. Each path carries its own
// `structureLabel` below so the readout names the right bucket per path.
//
// The failure this exists to kill: on 2026-07-22 and 07-23 the book produced
// ZERO directional opens after five sessions of 18–38, and no surface in the
// process could say which of those two states we were in. The cause turned out
// to be a wiped `ENABLE_OPTION_DEMO_DIRECTIONAL` (TRA-2136's bulk env PUT), i.e.
// the loop never executed a single iteration — but a drought would have produced
// the exact same observable: nothing.
//
// Three design rules, each of which is a bug this repo has already shipped once:
//
//  1. `null` is "not measured"; `0` is a measurement. `lastScanAt` is null until
//     a scan finishes, never 0 (TRA-1707). A path we have NOT instrumented
//     reports `lastScan: null` + `scanCountSinceBoot: null` rather than zeros —
//     publishing 0 for an unwatched path is the same lie one layer out.
//
//  2. Count the INPUT, not the output. `candidatesEvaluated` is incremented by
//     {@link RvScanRun.enterSymbol} at the TOP of the loop body, before any
//     `continue` can fire. Deriving it from a results array means an all-`continue`
//     scan reports `candidatesEvaluated: 0` — which is bit-identical to a scan
//     that never ran, re-creating the false zero one layer down (TRA-1729).
//
//  3. The buckets must SUM. `rejectionsByGate` has to account for every symbol
//     that entered and did not pass: overshoot means double-counting, undershoot
//     means a silent drop (TRA-2089). {@link RvScanRun.finish} enforces this in
//     BOTH directions rather than trusting call-site discipline:
//       • undershoot → the residual is published as an explicit `unattributed`
//         bucket. An untagged `continue` therefore shows up as a named number
//         instead of quietly unbalancing the set.
//       • overshoot  → NOT clamped. `bucketsBalance` goes false and the raw
//         counts ship as-is, because a clamp would hide the double-count that
//         the invariant exists to catch.
//     `bucketsBalance` is the assertion, in the payload, on every response.
//
//     TRA-4357 — and it must say WHICH denominator it balances against. The
//     record ships two plausible ones and only `candidatesEvaluated` is covered
//     by the gates; on the budgeted `otm` path the other (`universeSize`) is
//     routinely larger, so a reader who picks it manufactures a shortfall out of
//     a balanced ledger. That misread was filed as a second defect on TRA-4357
//     and it is the reason {@link RvScanReconciliation} exists.
//
// TRA-3557 — a FOURTH path, `otm`, and the one that needed this most: it is the
// sleeve under live-money acceptance, and it was the only option entry path with
// no scan run at all. Its `continue` on an empty/failed chain sits UPSTREAM of the
// nominator, of `recordLiveEnforceDecision` and of the universe gate, so a starve
// there left no gate row, no reason code and no log line — `cost_bar.evaluated: 0`
// was produced identically by "pre-open", "scanned, found nothing" and "never
// scanned". It is also the only instrumented path behind `runBudgetedSweep`, which
// is why {@link RvScanSweepSlice} exists: see it before reading its counters.
//
// Process-global + in-memory by design, matching `/api/health/iv-rv`: these are
// liveness facts about THIS process, and `scanCountSinceBoot` is only meaningful
// since boot. A lifetime counter that survives a reboot cannot prove the scanner
// ran today, which is the entire question being asked.

/** An option single-leg entry path instrumented for scan liveness (TRA-1682/TRA-2193). */
export type RvScanPathId = 'rv_scan' | 'directional' | 'iv_rv_buy_premium' | 'otm';

export const RV_SCAN_PATH_IDS: readonly RvScanPathId[] = [
  'rv_scan',
  'directional',
  'iv_rv_buy_premium',
  'otm',
] as const;

/**
 * TRA-2245 — the journal `structure` label each path stamps. Only `rv_scan` (the
 * compile-time-OFF True RV engine) journals `single_leg_rv`; the two directional
 * producers journal `single_leg_directional`. Published per path so the health
 * readout stops implying every path feeds one shared `single_leg_rv` bucket.
 */
export const RV_SCAN_PATH_STRUCTURE_LABEL: Readonly<Record<RvScanPathId, string>> = {
  rv_scan: 'single_leg_rv',
  directional: 'single_leg_directional',
  iv_rv_buy_premium: 'single_leg_directional',
  // TRA-3557 — the OTM sleeve journals its own label and always has; it is the
  // one instrumented path that never shared a bucket with another producer.
  otm: 'single_leg_otm',
};

/**
 * TRA-4255 — the cost-aware-ledger structure key each path's COST-BAR decisions
 * are recorded under. **This is deliberately NOT {@link RV_SCAN_PATH_STRUCTURE_LABEL}.**
 *
 * The directional sleeve is split across TWO keys in that ledger and reading the
 * wrong one is silent:
 *   • `single_leg_directional` — what the sleeve JOURNALS, and what the SPREAD
 *     ceiling records against (`DIRECTIONAL_STRUCTURE_LABEL`). Its cost-bar
 *     columns are permanently `admitted: 0 / rejected: 0`.
 *   • `directional` — the literal the engine passes to `costAwareGateReject`
 *     (`signal-engine.ts`, the `dirCostReject` call). This is where the bar's own
 *     verdicts land.
 *
 * Keying the admissibility fold off `structureLabel` therefore folds 0/0 and
 * classifies a provably-dead sleeve as `not_reached` — the exact false-quiet this
 * whole module exists to kill, re-created one layer in. Measured live 2026-09-01:
 * `single_leg_directional` = 0 admitted / 0 rejected, `directional` = 0 admitted /
 * **17,727** rejected.
 *
 * `null` = this path has no `costAwareGateReject` call site, so the bar can say
 * nothing about it. Null, never a string that happens to fold to zero.
 */
export const RV_SCAN_PATH_COST_BAR_KEY: Readonly<Record<RvScanPathId, string | null>> = {
  rv_scan: 'single_leg_rv',
  directional: 'directional',
  // No cost-bar call site of its own; it is not instrumented on this route either.
  iv_rv_buy_premium: null,
  otm: 'single_leg_otm',
};

/**
 * TRA-4255 — can this path's candidates reach an OPEN at all?
 *
 * `scanning` answers "is the loop turning", which is upstream of every admission
 * gate, so an armed path walking its full universe and admitting nothing reads
 * byte-identically to a healthy one. That is the state the directional sleeve sat
 * in for 19 days (last open 2026-08-12T19:51Z) while publishing
 * `verdict: "scanning"`, `enabled: true` and a full 229-symbol sweep every tick.
 *
 *  • `admitting`        — the bar cleared ≥ 1 candidate in the retained window.
 *  • `admitting_nothing`— the bar RULED on candidates and cleared **zero**. The
 *                         admissible set is empty BY MEASUREMENT, not inferred
 *                         from an absence of opens (the TRA-1718 method).
 *  • `not_reached`      — the bar ruled on nothing. Says nothing about
 *                         admissibility; the starve is upstream of the bar.
 *  • `unmeasured`       — no usable ledger read. Distinct from every above state
 *                         on purpose: "we could not look" must never render as
 *                         "we looked and it is fine".
 */
export type RvScanAdmissibilityStatus =
  | 'admitting'
  | 'admitting_nothing'
  | 'not_reached'
  | 'unmeasured';

/** The subset of the cost-aware ledger the admissibility fold needs. */
export interface RvScanAdmissibilityLedgerRead {
  /** Every ET day retained by the ledger, ascending. The RETENTION window — not a sample span. */
  etDays: readonly string[];
  byStructure: ReadonlyArray<RvScanAdmissibilityLedgerRow>;
}

/**
 * One cost-aware ledger row. The TRA-4439 fields are OPTIONAL so an older ledger
 * shape still type-checks — and every one of them fails CLOSED when absent: a row
 * that cannot say how many of its admits were a bypass cannot serve as a control.
 */
export interface RvScanAdmissibilityLedgerRow {
  structure: string;
  admitted: number;
  rejected: number;
  /** TRA-4439 D1 — admits a named bypass granted (TRA-4378 allowance), not the bar. */
  admittedByBypass?: number;
  /** TRA-4439 D1 — mean gross R of the NON-bypass admits. A bar clearance sits ≥ `barR`. */
  avgAdmittedOnMeritGrossR?: number | null;
  barR?: number | null;
  /** TRA-4439 D3 — ET days on which this structure's cost bar ruled on ≥ 1 candidate. */
  costBarDecisionEtDays?: readonly string[];
}

/**
 * TRA-4439 D1 — how many admits on this row the BAR itself cleared, or `null` when
 * that cannot be established. The positive control used to be `admitted > 0`, and
 * the TRA-4378 exploration allowance writes its force-admits into that same counter:
 * on 2026-09-18 `directional` "cleared 12 on the SAME read" with a mean admitted
 * gross R of −0.6157 against a 0.385 bar — every one a bypass. Two discriminators,
 * BOTH required, because each covers the other's blind spot:
 *   • `admitted - admittedByBypass` — the tag. Blind to bypass admits recorded before
 *     the tag existed (they count as merit), so on its own it is a lower bound.
 *   • `avgAdmittedOnMeritGrossR >= barR` — arithmetic. Every bar clearance has
 *     `grossR >= barR`, so a merit mean below the bar proves an untagged bypass is in
 *     the population. (It can also fail a genuine control if the bar moved inside the
 *     window — the safe direction: that reads `unmeasured`, never a false accusation.)
 */
export function admittedOnMerit(row: RvScanAdmissibilityLedgerRow): number | null {
  if (typeof row.admittedByBypass !== 'number') return null;
  const merit = row.admitted - row.admittedByBypass;
  if (merit <= 0) return merit === 0 ? 0 : null;
  const avg = row.avgAdmittedOnMeritGrossR;
  if (typeof avg !== 'number' || typeof row.barR !== 'number') return null;
  return avg >= row.barR ? merit : null;
}

export interface RvScanAdmissibility {
  status: RvScanAdmissibilityStatus;
  /** The ledger key actually folded. Published so the two-key trap above is auditable. */
  costBarStructure: string | null;
  /** Null — never 0 — when there was no reading. Absence is not a zero. */
  admitted: number | null;
  rejected: number | null;
  /** `null` when the bar ruled on nothing; a 0 here is the ALARM, not the quiet state. */
  admitRate: number | null;
  windowEtDays: readonly string[] | null;
  /**
   * A SIBLING structure in the SAME ledger read that IS admitting.
   *
   * This is what turns our zero into a measurement rather than a dead instrument:
   * same route, same fold, same window, non-zero. Without one, a wiped ledger and
   * a dead sleeve are the same observation — so its absence DOWNGRADES the verdict
   * to `unmeasured` rather than being reported as a stronger claim than we hold.
   */
  positiveControl: { structure: string; admitted: number; rejected: number } | null;
  /**
   * TRA-4439 D3 — the ET days on which THIS structure's cost bar actually ruled,
   * `null` when unmeasured or when the ledger cannot say. `windowEtDays` is the
   * retention window; this is the sample span, and it is what `reason` quotes.
   */
  decisionEtDays: readonly string[] | null;
  /** TRA-4439 D1 — of `admitted`, those granted by a bypass (null when the ledger cannot say). */
  admittedByBypass: number | null;
  /** Why this status, in words, so the payload does not need the source to read. */
  reason: string;
}

/**
 * Classify one path's admissibility off a cost-aware ledger read. Pure.
 *
 * Fails toward `unmeasured` in every ambiguous direction. A false `admitting_nothing`
 * accuses a healthy sleeve of being dead and would send someone bisecting deploys for
 * a defect that is not there — the expensive direction here is the false positive.
 */
export function classifyRvScanAdmissibility(
  path: RvScanPathId,
  ledger: RvScanAdmissibilityLedgerRead | null,
): RvScanAdmissibility {
  const costBarStructure = RV_SCAN_PATH_COST_BAR_KEY[path];
  const base = {
    costBarStructure,
    admitted: null,
    rejected: null,
    admitRate: null,
    windowEtDays: null,
    positiveControl: null,
    decisionEtDays: null,
    admittedByBypass: null,
  } as const;

  if (costBarStructure === null) {
    return {
      ...base,
      status: 'unmeasured',
      reason: `path \`${path}\` has no cost-aware bar call site, so the bar can say nothing about its admissibility`,
    };
  }
  if (!ledger) {
    return {
      ...base,
      status: 'unmeasured',
      reason: 'cost-aware gate ledger is not readable from this process',
    };
  }

  const row = ledger.byStructure.find((s) => s.structure === costBarStructure) ?? null;
  if (!row) {
    // ABSENT ≠ 0. A missing row means the ledger has never keyed this structure,
    // which is a different fact from "keyed it and cleared nothing".
    return {
      ...base,
      status: 'unmeasured',
      reason: `no cost-aware ledger row keyed \`${costBarStructure}\` — absent, which is not the same reading as zero`,
    };
  }

  const ruledOn = row.admitted + row.rejected;
  const window = ledger.etDays;
  // TRA-4439 D3 — the sample span is the days THIS structure decided on, not the
  // retention window. On 2026-09-09 "across 5 retained ET day(s)" described a
  // `single_leg_rv` sample that was one session. When the ledger cannot say, the
  // reason names the window AS a window rather than implying it is the span.
  const decisionEtDays = Array.isArray(row.costBarDecisionEtDays) ? row.costBarDecisionEtDays : null;
  const span = decisionEtDays !== null
    ? `on ${decisionEtDays.length} ET day(s) with decisions (of ${window.length} retained)`
    : `within a ${window.length}-ET-day retention window (days with decisions not reported)`;
  const bypass = typeof row.admittedByBypass === 'number' ? row.admittedByBypass : null;
  const measured = {
    costBarStructure,
    admitted: row.admitted,
    rejected: row.rejected,
    admitRate: ruledOn > 0 ? row.admitted / ruledOn : null,
    windowEtDays: window,
    decisionEtDays,
    admittedByBypass: bypass,
  };

  if (row.admitted > 0) {
    // Candidates DO reach an open, so `admitting` stands either way — but the words
    // must not credit the bar with admits a bypass granted (TRA-4439 D1).
    const merit = admittedOnMerit(row);
    const how = merit === null
      ? 'cleared or bypass-admitted (the ledger cannot separate them on this read)'
      : bypass !== null && bypass > 0
        ? `admitted (${merit} cleared the bar, ${bypass} via the exploration-allowance bypass)`
        : 'cleared';
    return {
      ...measured,
      status: 'admitting',
      positiveControl: null,
      reason: `bar ${how} ${row.admitted} of ${ruledOn} candidates ${span}`,
    };
  }
  if (ruledOn === 0) {
    return {
      ...measured,
      status: 'not_reached',
      positiveControl: null,
      reason: `cost-aware bar ruled on 0 candidates for \`${costBarStructure}\` within a ${window.length}-ET-day retention window — the starve is UPSTREAM of the bar; this says nothing about admissibility`,
    };
  }

  // admitted === 0 && rejected > 0. Only claim it with a live control on the same
  // read — and (TRA-4439 D1) a control the BAR admitted, not a bypass. A row whose
  // merit count cannot be established is not a control.
  const control = ledger.byStructure
    .filter((s) => s.structure !== costBarStructure)
    .map((s) => ({ s, merit: admittedOnMerit(s) }))
    .filter((c): c is { s: RvScanAdmissibilityLedgerRow; merit: number } => c.merit !== null && c.merit > 0)
    .sort((a, b) => b.merit - a.merit)[0] ?? null;
  if (!control) {
    return {
      ...measured,
      status: 'unmeasured',
      positiveControl: null,
      reason: `\`${costBarStructure}\` cleared 0 of ${ruledOn} ${span}, but NO sibling structure in this ledger read shows an admit the BAR cleared (bypass admits and rows that cannot separate the two do not count) — a wiped/stalled ledger or a bar nothing can clear cannot be excluded, so this is not yet a measurement`,
    };
  }
  return {
    ...measured,
    status: 'admitting_nothing',
    positiveControl: { structure: control.s.structure, admitted: control.merit, rejected: control.s.rejected },
    reason: `cost-aware bar cleared 0 of ${ruledOn} \`${costBarStructure}\` candidates ${span}, while the bar cleared ${control.merit} \`${control.s.structure}\` candidate(s) on MERIT on the SAME read (bypass admits excluded) — the admissible set is empty by measurement, not by absence of candidates`,
  };
}

/**
 * The bucket name used for symbols that entered the loop, did not pass, and were
 * not tagged with a gate. Non-zero means an untagged `continue` exists upstream —
 * a real finding, not noise.
 */
export const UNATTRIBUTED_GATE = 'unattributed';

/**
 * TRA-3557 — the slice a BUDGETED sweep actually walked. Null on the paths that
 * consume their whole universe in one pass.
 *
 * `runOtmScan` is the only instrumented path sitting behind `runBudgetedSweep`
 * (TRA-2262): it is handed the entire ~614-name watchlist and walks as much of it
 * as a 30s wall-clock budget buys, resuming next pass at a persisted cursor. So on
 * that path `candidatesEvaluated < universeSize` is the NORMAL case and carries no
 * information by itself — which is the same ambiguity this module exists to kill,
 * one level down. Without these fields a pass that covered symbols 80..160 of 614
 * and a pass that died at symbol 80 publish byte-identical records.
 */
export interface RvScanSweepSlice {
  /** Index into the universe this pass STARTED at (0 on a fresh sweep). */
  startIndex: number;
  /** Symbols the sweep handed to the worker. Diverges from `candidatesEvaluated` only on a bug. */
  processed: number;
  /** True iff the pass reached the END of the universe. */
  complete: boolean;
  /** True iff the wall-clock budget — rather than the universe — ended the pass. */
  budgetExhausted: boolean;
  /** True iff a caller-side gate stopped the pass before the budget did. */
  stopped: boolean;
  /** Symbol the next pass resumes at; null once the sweep is complete. */
  resumeAt: string | null;
}

/**
 * TRA-4357 AC3 — the reconciliation identity, stated IN the payload rather than
 * left for the reader to reconstruct.
 *
 * `bucketsBalance` was already correct and has never been observed false (40/40
 * distinct live cycles on 2026-09-08, both instrumented paths). The defect this
 * exists to kill is one layer out: the record ships TWO plausible denominators —
 * `universeSize` and `candidatesEvaluated` — and only the second one is the one
 * the gates cover. On the three unbudgeted paths they are always equal, so the
 * distinction is invisible; on `otm`, the one path behind `runBudgetedSweep`, a
 * truncated or resumed pass makes them differ by design (see {@link RvScanSweepSlice}).
 *
 * A reader who picks `universeSize` therefore computes a shortfall out of a
 * perfectly balanced ledger and reports a silent drop that is not there. That is
 * not hypothetical: TRA-4357 was filed with exactly that finding — "343 evaluated,
 * rejections sum to 276, sixty-seven candidates neither passed nor appear under
 * any gate". 343 was the universe, 276 was the slice actually walked, the missing
 * 67 were never handed to a gate because the sweep budget ended the pass first,
 * and `bucketsBalance` was `true` throughout. Re-measured live on 2026-09-08 the
 * same shape reproduced twice in four minutes: 238→157 (`sweep_budget_exhausted`)
 * and 269→91 (`sweep_resumed_tail`), both balanced.
 *
 * The remedy is not another invariant — it is naming the remainder. A reader who
 * sees `universeNotWalked: 67` alongside `notWalkedReason: "sweep_budget_exhausted"`
 * cannot mistake a budget boundary for a lost candidate, and a reader who sees
 * `universeNotWalked: 0` needs no denominator judgement at all.
 */
export interface RvScanReconciliation {
  /**
   * The ONLY denominator `rejectionsByGate` covers: `candidatesEvaluated`.
   * Deliberately not `universeSize` — symbols the sweep never handed to the loop
   * cannot have been rejected by a gate, so charging them to one would be a
   * fabricated attribution.
   */
  denominator: number;
  /** `sum(rejectionsByGate) + candidatesPassed`. */
  accountedFor: number;
  /**
   * `accountedFor === denominator`. Same assertion as {@link RvScanRecord.bucketsBalance},
   * restated against the explicit denominator so the two cannot be read apart.
   */
  balances: boolean;
  /**
   * `universeSize - candidatesEvaluated` — symbols HANDED to the scanner that the
   * pass never walked. Normal and non-zero on a budgeted sweep; a genuine finding
   * on any other path. Named, never left as a subtraction the reader has to know
   * to perform.
   */
  universeNotWalked: number;
  /**
   * Why those symbols went unwalked ({@link RvScanRecord.stoppedEarlyReason}), or
   * null when none did. Non-null with `universeNotWalked: 0`, or null with a
   * non-zero one, is itself the bug signal — an unexplained gap.
   */
  notWalkedReason: string | null;
}

/** One completed scan pass over a symbol universe. */
export interface RvScanRecord {
  atMs: number;
  /** Symbols the scanner was HANDED (before any early break). */
  universeSize: number;
  /** Symbols that actually entered the loop body. Input-counted, never derived. */
  candidatesEvaluated: number;
  /** Symbols that cleared every gate and reached the open attempt. */
  candidatesPassed: number;
  /** Opens the account actually accepted (≤ candidatesPassed). */
  opensPlaced: number;
  rejectionsByGate: Record<string, number>;
  /** True iff `sum(rejectionsByGate) === candidatesEvaluated - candidatesPassed`. */
  bucketsBalance: boolean;
  /**
   * TRA-4357 AC3 — the same invariant with its denominator named, plus the
   * budgeted-sweep remainder. See {@link RvScanReconciliation}.
   */
  reconciliation: RvScanReconciliation;
  /** Why the loop stopped before consuming the universe, or null if it did not. */
  stoppedEarlyReason: string | null;
  /**
   * TRA-3557 — budgeted-sweep slice, or null on a path that walks its universe in
   * one pass. See {@link RvScanSweepSlice}.
   */
  sweep: RvScanSweepSlice | null;
}

interface PathState {
  scanCountSinceBoot: number;
  lastScanAt: number | null;
  lastScan: RvScanRecord | null;
  lastFetchOkAt: number | null;
  lastFetchError: string | null;
}

function emptyPathState(): PathState {
  return {
    scanCountSinceBoot: 0,
    lastScanAt: null,
    lastScan: null,
    lastFetchOkAt: null,
    lastFetchError: null,
  };
}

const store = new Map<RvScanPathId, PathState>();

function stateOf(path: RvScanPathId): PathState {
  let s = store.get(path);
  if (!s) {
    s = emptyPathState();
    store.set(path, s);
  }
  return s;
}

/**
 * Accumulator for a single scan pass. Handed out by {@link beginRvScan} and
 * committed by {@link RvScanRun.finish}; an abandoned run (thrown out of the
 * loop without finishing) records NOTHING, so a crashed scan cannot masquerade
 * as a completed empty one.
 */
export class RvScanRun {
  private evaluated = 0;
  private passed = 0;
  private opens = 0;
  private readonly gates = new Map<string, number>();
  private stoppedEarly: string | null = null;
  private sweep: RvScanSweepSlice | null = null;
  private done = false;

  constructor(
    private readonly path: RvScanPathId,
    private readonly universeSize: number,
    private readonly clock: () => number,
  ) {}

  /**
   * Call at the TOP of the per-symbol loop body, before any `continue`. This is
   * the input count — see rule 2 in the module header.
   */
  enterSymbol(): void {
    this.evaluated += 1;
  }

  /** Tag the gate that rejected the current symbol. One call per rejected symbol. */
  reject(gate: string): void {
    this.gates.set(gate, (this.gates.get(gate) ?? 0) + 1);
  }

  /** The current symbol cleared every gate and is about to be routed to the account. */
  pass(): void {
    this.passed += 1;
  }

  /** The account accepted the open. */
  opened(): void {
    this.opens += 1;
  }

  /** The loop broke before consuming the universe (e.g. daily-cap headroom). */
  stopEarly(reason: string): void {
    this.stoppedEarly = reason;
  }

  /**
   * TRA-3557 — close a BUDGETED pass honestly. Records the slice AND derives
   * `stoppedEarlyReason` from it in one call, so the two cannot disagree and a
   * caller cannot ship a truncated pass that reads as a completed sweep.
   *
   * A pass that merely RESUMED mid-universe is named too, not only a truncated
   * one: it does reach the end of the universe (`complete: true`) but walked only
   * the tail, so with no reason recorded its `universeSize - candidatesEvaluated`
   * gap is indistinguishable from the loop dying part-way through — the exact
   * misread `stoppedEarlyReason` exists to prevent (see the rv_scan path's
   * `iv_rv_cap_headroom`).
   *
   * `stoppedGate` names the caller-side gate behind a `stopped` pass; the budgeted
   * sweep itself does not know which one refused. Pass the SAME label the
   * unbudgeted paths use for that gate so the two read against each other.
   */
  noteSweep(slice: RvScanSweepSlice, stoppedGate?: string): void {
    this.sweep = slice;
    if (slice.budgetExhausted) this.stoppedEarly = 'sweep_budget_exhausted';
    else if (slice.stopped) this.stoppedEarly = stoppedGate ?? 'sweep_gate_stopped';
    else if (!slice.complete) this.stoppedEarly = 'sweep_incomplete';
    else if (slice.startIndex > 0) this.stoppedEarly = 'sweep_resumed_tail';
  }

  /** A market-data fetch this scan depends on succeeded. */
  fetchOk(): void {
    stateOf(this.path).lastFetchOkAt = this.clock();
  }

  /** A market-data fetch this scan depends on failed. Latest-wins. */
  fetchError(message: string): void {
    stateOf(this.path).lastFetchError = message;
  }

  /**
   * Commit the pass. Balances the rejection buckets (see rule 3) and bumps
   * `scanCountSinceBoot`. Idempotent — a double `finish()` cannot inflate the
   * scan count.
   */
  finish(): RvScanRecord {
    const s = stateOf(this.path);
    if (this.done && s.lastScan) return s.lastScan;
    this.done = true;

    const rejectionsByGate: Record<string, number> = {};
    let tagged = 0;
    for (const [gate, n] of this.gates) {
      rejectionsByGate[gate] = n;
      tagged += n;
    }

    const expected = this.evaluated - this.passed;
    // Undershoot → name the residual. Overshoot → leave the counts alone and let
    // `bucketsBalance` carry the failure; clamping would hide the double-count.
    if (tagged < expected) {
      rejectionsByGate[UNATTRIBUTED_GATE] = expected - tagged;
      tagged = expected;
    }

    // TRA-4357 AC3 — publish the identity with its denominator named. `tagged` is
    // post-residual, so `accountedFor` is what a reader summing the SHIPPED
    // `rejectionsByGate` gets, not an internal pre-attribution figure; on the
    // overshoot branch it therefore exceeds the denominator, which is the point.
    const universeNotWalked = Math.max(0, this.universeSize - this.evaluated);
    const reconciliation: RvScanReconciliation = {
      denominator: this.evaluated,
      accountedFor: tagged + this.passed,
      balances: tagged === expected,
      universeNotWalked,
      notWalkedReason: universeNotWalked > 0 ? this.stoppedEarly : null,
    };

    const record: RvScanRecord = {
      atMs: this.clock(),
      universeSize: this.universeSize,
      candidatesEvaluated: this.evaluated,
      candidatesPassed: this.passed,
      opensPlaced: this.opens,
      rejectionsByGate,
      bucketsBalance: tagged === expected,
      reconciliation,
      stoppedEarlyReason: this.stoppedEarly,
      sweep: this.sweep,
    };

    s.scanCountSinceBoot += 1;
    s.lastScanAt = record.atMs;
    s.lastScan = record;
    return record;
  }
}

/**
 * Open a scan pass. `universeSize` is what the scanner was HANDED — the gap
 * between it and `candidatesEvaluated` is itself diagnostic (an early break, or
 * an exception mid-loop), which is why both ship.
 */
export function beginRvScan(
  path: RvScanPathId,
  universeSize: number,
  clock: () => number = Date.now,
): RvScanRun {
  return new RvScanRun(path, universeSize, clock);
}

/**
 * TRA-3557 — the TRA-2193 three-way verdict, PER PATH.
 *
 * It was previously computed only as a roll-up across every instrumented path,
 * and that roll-up is lossy in a way that only bites once the paths disagree:
 * `disarmed` requires EVERY armed path to be off, so adding `otm` — which carries
 * no feature flag and is armed whenever the chain scanner is wired — makes the
 * aggregate `disarmed` unreachable on a live box. That is a true statement about
 * the fleet and a useless one about any single path, and it would have silently
 * retired the exact discriminator TRA-2193 was built to provide (the 2026-07-22
 * wiped-flag state). Stated per path, it survives: a disarmed `directional`
 * reports `disarmed` no matter what the OTM sleeve is doing.
 *
 * `unwatched` is the fourth state and is NOT a verdict about arming: it means
 * this module does not observe the path, so `disarmed`/`scanning` are both
 * unknowable — the same null discipline the counters follow.
 *
 * TRA-4255 — a FIFTH state, `armed_admitting_nothing`, ranked BELOW `scanning`
 * and reached only from it. `scanning` asserts the loop is turning; it is
 * upstream of every admission gate and therefore cannot distinguish a sleeve
 * that is trading from one whose admissible set is empty. The directional sleeve
 * held `scanning` for 19 days while clearing 0 of 17,727 candidates. A path that
 * provably cannot open must not wear the same word as one that can.
 */
export type RvScanPathVerdict =
  | 'unwatched'
  | 'disarmed'
  | 'armed_but_never_ran'
  | 'armed_admitting_nothing'
  | 'scanning';

/** Read-only view of one path, shaped for the health route. */
export interface RvScanPathView {
  path: RvScanPathId;
  /** TRA-2245 — the journal `structure` label this path stamps (rv vs directional). */
  structureLabel: string;
  /** Is this entry path armed right now (resolved by the caller from live flags). */
  enabled: boolean;
  /**
   * False when this module does not observe the path's loop. Un-instrumented
   * paths report NULL counters — never 0, which would assert a measurement we
   * did not take.
   */
  instrumented: boolean;
  /** TRA-3557 — this path's own per-path verdict. See {@link RvScanPathVerdict}. */
  verdict: RvScanPathVerdict;
  /**
   * TRA-4255 — can candidates on this path reach an open AT ALL, measured off the
   * DURABLE cost-aware ledger rather than inferred from an absence of opens.
   * Always present; `status: 'unmeasured'` when there was no usable read.
   */
  admissibility: RvScanAdmissibility;
  lastScanAt: number | null;
  scanCountSinceBoot: number | null;
  lastScan: RvScanRecord | null;
  lastFetchOkAt: number | null;
  lastFetchError: string | null;
}

/**
 * Snapshot one path. `enabled` and `instrumented` are supplied by the caller
 * (the route owns flag resolution; this module owns counters).
 */
export function summarizeRvScanPath(
  path: RvScanPathId,
  opts: {
    enabled: boolean;
    instrumented: boolean;
    /**
     * TRA-4255 — the durable cost-aware ledger read. OMITTED (or null) yields
     * `admissibility.status: 'unmeasured'` and leaves the verdict untouched: a
     * caller that cannot supply the ledger must not thereby manufacture a
     * healthy-looking `scanning`, nor a dead-looking accusation.
     */
    costAwareLedger?: RvScanAdmissibilityLedgerRead | null;
  },
): RvScanPathView {
  const s = store.get(path);
  const admissibility = classifyRvScanAdmissibility(path, opts.costAwareLedger ?? null);
  if (!opts.instrumented || !s) {
    return {
      path,
      structureLabel: RV_SCAN_PATH_STRUCTURE_LABEL[path],
      enabled: opts.enabled,
      instrumented: opts.instrumented,
      // No state object yet ⇒ zero scans, so the armed branch is always
      // `armed_but_never_ran` here. `unwatched` outranks arming: for a path we do
      // not observe, `disarmed` would assert a measurement we did not take.
      verdict: !opts.instrumented
        ? 'unwatched'
        : opts.enabled
          ? 'armed_but_never_ran'
          : 'disarmed',
      admissibility,
      // Never-ran and never-watched both report null. They are distinguished by
      // `instrumented`, not by a fabricated zero.
      lastScanAt: null,
      scanCountSinceBoot: opts.instrumented ? 0 : null,
      lastScan: null,
      lastFetchOkAt: null,
      lastFetchError: null,
    };
  }
  return {
    path,
    structureLabel: RV_SCAN_PATH_STRUCTURE_LABEL[path],
    enabled: opts.enabled,
    instrumented: true,
    // `scanning` is asserted off the SCAN COUNT, never off `lastScanAt` alone —
    // both move together today, but a count is the input-side fact and a
    // timestamp is derived from it (rule 2 in the module header).
    // TRA-4255 — `armed_admitting_nothing` is reached ONLY from what would
    // otherwise be `scanning`: the loop demonstrably turned, and the durable bar
    // ledger says none of what it produced can open. Ordering matters — a
    // disarmed or never-ran path must keep its own (more specific) verdict,
    // because a stale ledger window can outlive the arm that filled it.
    verdict: !opts.enabled
      ? 'disarmed'
      : s.scanCountSinceBoot > 0
        ? (admissibility.status === 'admitting_nothing' ? 'armed_admitting_nothing' : 'scanning')
        : 'armed_but_never_ran',
    admissibility,
    lastScanAt: s.lastScanAt,
    scanCountSinceBoot: s.scanCountSinceBoot,
    lastScan: s.lastScan,
    lastFetchOkAt: s.lastFetchOkAt,
    lastFetchError: s.lastFetchError,
  };
}

/** Test-only: drop all recorded state. */
export function __resetRvScanTelemetry(): void {
  store.clear();
}
