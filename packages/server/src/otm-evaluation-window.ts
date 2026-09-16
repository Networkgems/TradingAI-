// TRA-3945 (parent TRA-3927, board card `a29b2db8`; record signed off by
// QuantTrader on TRA-3945 comment `ce0ca28a`, 2026-08-22T21:46Z) — the
// PRE-REGISTERED 30-close evaluation window for the `single_leg_otm` JOINT arm
// (TRA-3941 trail exit + TRA-3942 entry windows + TRA-3953 refusal dedupe +
// TRA-3943 day-one stop + TRA-3944 contract floor), graded by the TRA-375
// expectancy rule.
//
// ── Why a record and not a feel ─────────────────────────────────────────────
//
// n=17 live OTM closes cannot separate skill from noise (desk OTM seR 0.064 on
// n=63; the live book is a quarter of that). The next change to this sleeve
// is graded by a rule written down BEFORE the closes land, against a baseline
// FROZEN at arm time, with the verdict owned by a person (`verdictOwner`) and
// never pronounced by the code. The record publishes a readout; it does not
// act on it. There is no automatic action on FAIL anywhere in this module.
//
// ── The three rulings that shape it ─────────────────────────────────────────
//
//   1. The window opens on a LIVENESS PREDICATE over the full rule set, read
//      off THIS process (`/api/health/options-live` fields), never off a deploy
//      order — a deploy order's commit is a lower bound on content, not a
//      reading. `startedAt` + `startBuild` are stamped at the first tick the
//      predicate is all-true and NEVER re-stamped. The predicate is re-evaluated
//      on every tick: a clause flipping false PAUSES the window (span logged in
//      `buildDrift[]`), and a close whose ENTRY fell inside a paused span is
//      refused under `excludedCloses.reasons.rulesetPaused`.
//   2. Eligibility is ENTRY-side: a close counts iff its entry `openTs >=
//      startedAt`. A row open at `startedAt` never contributes, however it
//      exits. `contractFloor.bandIntersectsSelector === true` is IN the
//      predicate (ruling 5): a band change is a rule change inside the arm and
//      must land before the pin. Until card `cc2c36fe` on TRA-3944 resolves,
//      the record reads `status: "armed"`, `n: 0` — never `counting`.
//   3. Dedupe key = `brokerOrderId ?? `${optionSymbol}|${closeTs}`` (the
//      export double-listed XLF/BAC under two strategy labels). R is CONSUMED
//      from the journal's `realizedR` (= realizedPnlUsd / atRiskUsd, the
//      TRA-375 basis — option-trade-journal.ts:364-366), never recomputed.
//      seR = sample sd (n−1) / √n. `brokerOrderId == null` is its own counter
//      under `excludedCloses.reasons` so a fallback-keyed close is VISIBLE —
//      it is still COUNTED (an expiry settle / broker-reconcile close carries
//      no order id and is disproportionately a LOSS; refusing it would bias the
//      sample permissive). `excludedCloses.n` sums the true exclusions only.
//   3b. TRA-3945 cross-book ruling (CEO comment `a9f429a9`, 2026-08-24, taken
//      while `n` was still 0 — this is PRE-registration, not a re-cut). The
//      dedupe key in (3) collapses a double-REPORT of ONE fill. It is blind to
//      TWO REAL fills of the SAME contract driven by ONE price path: on
//      2026-08-24 books `v0nni` (14:25:07Z) and `admin` (14:44:33Z) each bought
//      `NVTS261002C00012500` from the same generator, with DIFFERENT broker
//      order ids. `seR = sd/√n` treats those as independent draws; near-equal
//      Rs add to `n` while adding ~0 to the sum of squares, so seR falls twice
//      over and the 0.10 precision bar clears EARLIER than the evidence
//      supports. That is the PERMISSIVE direction on the estimator the
//      invalidation clause itself calls "a bigger finding than the sleeve".
//
//      RULING: (a), generalized. A second CLUSTER layer runs after (3) and
//      after every eligibility filter, keyed on the ENTRY:
//
//          cluster key = `${optionSymbol}|${etDay(openTs)}`
//
//      One representative per cluster (earliest `openTs`; ties broken on the
//      dedupe key, so the choice is deterministic and replayable). The rest are
//      refused under `excludedCloses.reasons.sameContractSameSessionCluster`.
//
//      Three properties make this the defensible cut, and each is pinned by a
//      test in `tra3945-otm-evaluation-window.test.ts`:
//        • BOOK-AGNOSTIC. The correlation is one underlying on one session, not
//          a book boundary — two entries of one contract in ONE book on one day
//          are exactly as correlated as two across books. Keying on `account`
//          would answer a narrower question than the one that was asked, and it
//          would depend on `account` being stamped on live rows (it is
//          documented for the DEMO fold). This key needs no book dimension.
//        • ENTRY-DERIVED, never exit-derived. The arm under test IS an exit
//          ruleset (trail exit + day-one stop). A cluster keyed on `closeTs`
//          would let the thing being graded choose its own sample size —
//          two correlated entries that exit on different days would silently
//          de-cluster. The cluster is fixed the moment the entries are booked.
//        • MONOTONE CONSERVATIVE. The layer only ever REMOVES rows the old rule
//          admitted; it can never admit one it excluded. So `n` is a lower
//          bound on the old `n`, seR a upper bound, and the change can only
//          make the bar HARDER — never a verdict flipped permissive by a rule
//          edit. This is what makes it safe to land mid-window at n=0.
//
//      The same comment names the OPPOSITE failure on (3)'s fallback leg: two
//      books closing one `optionSymbol` at one `closeTs` with a null
//      `brokerOrderId` would COLLAPSE two real observations. That leg's job is
//      to collapse a double-report of one fill, which is by construction within
//      one book, so `account` now scopes it — a strict improvement (a genuine
//      double-listing shares `account` and still collides).
//
// Extension is a ONE-SHOT state transition (`extension.used` flips once); at
// 45 deduped closes with seR still ≥ 0.10 the record goes `inconclusive_terminal`
// and stays there. `verdict_pass` / `verdict_fail` exist in the enum and are
// written ONLY by a hand-run carrying QuantTrader's ticket reference in the
// note (`scripts/tra3945-otm-window-verdict.mjs`).
//
// ⚠️ SCOPE: one sleeve. This touches NOTHING about the arm (`otmArmed`), the
// ~$250 row size, the 2-row cap, or any other sleeve. It reads; it never
// routes.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { logger } from './observability/index.js';
import { resolveDataDir } from './data-dir.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import { OTM_SLEEVE_MANDATE_STRUCTURE } from './otm-sleeve-mandate.js';
import {
  formatOtmEntryWindows,
  resolveOtmEntryWindows,
  type OtmEntryWindowResolution,
  type OtmEntryWindowSource,
} from './otm-entry-window.js';
// TRA-3974 — the two reads the pre-registration assumed were free.
import {
  armOtmWindowCostAccumulator,
  buildOtmWindowCostAccumulatorRecord,
  ensureOtmWindowCostSubscription,
  flushOtmWindowCostAccumulator,
  loadOtmWindowCostAccumulator,
  peekOtmWindowCostAccumulatorState,
  type OtmWindowCostAccumulatorRecord,
} from './otm-window-cost-accumulator.js';
import {
  buildOtmEntryQuoteRecord,
  buildOtmEntryQuoteRow,
  selectLiveOtmRows,
  type OtmEntryQuoteInputRow,
  type OtmEntryQuoteRecord,
} from './otm-window-entry-quote.js';

const log = logger.child({ module: 'otm-evaluation-window' });

export const OTM_EVALUATION_WINDOW_ID = 'otm-joint-arm-w1';

/**
 * TRA-3945 successor windows. `w1` is the first registration; a SUCCESSOR
 * (`w2`, `w3`, …) re-registers the same pre-registration over a fresh sample
 * after its predecessor is terminal. The id is the only thing that tells two
 * windows' filings apart, so the loader accepts the whole family, never just w1.
 */
const OTM_EVALUATION_WINDOW_ID_RE = /^otm-joint-arm-w(\d+)$/;

export function isOtmEvaluationWindowId(id: unknown): id is string {
  return typeof id === 'string' && OTM_EVALUATION_WINDOW_ID_RE.test(id);
}

export function nextOtmEvaluationWindowId(id: string): string {
  const m = OTM_EVALUATION_WINDOW_ID_RE.exec(id);
  if (!m) throw new Error(`TRA-3945: not an evaluation window id: ${id}`);
  return `otm-joint-arm-w${Number(m[1]) + 1}`;
}

export const OTM_EVALUATION_RULE_REF = 'TRA-375';
export const OTM_EVALUATION_TARGET_CLOSES = 30;
export const OTM_EVALUATION_EXTENSION_CLOSES = 15;
export const OTM_EVALUATION_SE_R_MAX = 0.1;
export const OTM_EVALUATION_VERDICT_OWNER = 'QuantTrader';
export const OTM_EVALUATION_REQUIRED_LIVE = [
  'TRA-3941', 'TRA-3942', 'TRA-3943', 'TRA-3944', 'TRA-3953',
] as const;
/** Bound on the persisted pause-span log — the count is kept separately. */
export const OTM_EVALUATION_DRIFT_SPANS_MAX = 50;

/**
 * The hand-written terminals. `verdict_insufficient_population` is the one the
 * `populationRuling` (QuantTrader 88ccac56) always named and the writer never
 * accepted: the population was STARVED, not graded — it is accepted only while
 * `n < targetCloses`, because a full sample is graded pass/fail, never retired.
 * (QuantTrader fd917f86, 2026-08-26: $6.74 of fleet admission against a $50
 * contract floor under the $500 cap ⇒ zero new rows ⇒ the window cannot
 * converge; the ruling on WHICH lever moves is the board's, not the code's.)
 */
export const OTM_EVALUATION_VERDICT_STATUSES = [
  'verdict_pass', 'verdict_fail', 'verdict_insufficient_population',
] as const;
export type OtmEvaluationVerdictStatus = (typeof OTM_EVALUATION_VERDICT_STATUSES)[number];

/** Bound on the persisted re-cut log. */
export const OTM_EVALUATION_RECUT_HISTORY_MAX = 20;

/**
 * A re-cut RULED by the verdict owner but not necessarily executed.
 *
 * The record could always be re-cut in prose and never in state: the only
 * writers were the tick's one-shot stamp and a shell script on the host's data
 * dir, so a ruling that moved the cut had nowhere to land — the same shape as
 * the `verdict_insufficient_population` terminal (fd917f86) that the record
 * named for four days before anything could write it. These declarations carry
 * the ruling onto the wire with `satisfied` COMPUTED off the persisted cut, so
 * an unexecuted ruling cannot read as a done one.
 */
export interface OtmEvaluationRuledRecut {
  /** The window the ruling was made about. A ruling never follows the sample into a successor. */
  windowId: string;
  /** The ruling's own reference — comment id + author + instant. */
  rulingRef: string;
  ruledAt: string;
  /** Why the population splits here (the TRA-2677 hazard being avoided). */
  reason: string;
  /** ms epoch the sample must restart at. */
  candidateStartedAt: number;
  candidateBuild: OtmEvaluationBuildPin;
  /** Where the pin above was reported (a deploy order's commit is a lower bound; this is the wire read). */
  pinSource: string;
}

/**
 * QuantTrader comment `a9753fda` on TRA-3945 (2026-08-25T20:39:31Z): TRA-4006
 * lowered `PROFIT_LOCK_ARM_R` 1.0 → 0.75 and `PROFIT_LOCK_GIVEBACK_R` 1.0 →
 * 0.40, which ALTERS REALISED OUTCOMES ⇒ closes generated before it are a
 * different population (TRA-2677). "Until then the window is not counting. No
 * close entered before that timestamp is admissible."
 *
 * The pin was reported the same night under TRA-4006 AC6 (LeadDev comment
 * `eb048f86`, read off `/api/health/options-live` at 04:34:33Z and again at
 * 04:35Z). The re-cut itself was never executed — measured 2026-09-09, the
 * record still held `startedAt 2026-08-23T01:40:43.225Z` / `startBuild
 * f041ebf3`, so 5 of the counted 9 closes entered BEFORE the fix.
 */
export const OTM_EVALUATION_RULED_RECUTS: readonly OtmEvaluationRuledRecut[] = [
  {
    windowId: 'otm-joint-arm-w1',
    rulingRef: 'TRA-3945 comment a9753fda (QuantTrader, verdictOwner, 2026-08-25T20:39:31.423Z)',
    ruledAt: '2026-08-25T20:39:31.423Z',
    reason:
      'TRA-4006 changed the profit-lock exit floor (PROFIT_LOCK_ARM_R 1.0->0.75, PROFIT_LOCK_GIVEBACK_R 1.0->0.40). The arm under test IS an exit ruleset, so closes generated under the old constants are a different population (TRA-2677). Ruled: the window restarts at TRA-4006\'s deploy commit and its startedAt; no close whose ENTRY predates that instant is admissible.',
    candidateStartedAt: Date.UTC(2026, 7, 26, 4, 33, 57, 910),
    candidateBuild: {
      commit: '85c788e5cdc91ef75345c943bbcdccb8e809db14',
      commitShort: '85c788e5cdc9',
      pid: 75,
      startedAt: '2026-08-26T04:33:57.910Z',
    },
    pinSource: 'TRA-4006 AC6 (LeadDev comment eb048f86) - /api/health/options-live read 2026-08-26T04:34:33Z, re-read 04:35Z',
  },
];

/**
 * The ruled re-cuts that bind THIS window. A ruling is about the sample it was
 * made on; applied to a successor, the w1 ruling's 08-26 candidate would read
 * as a BACKWARD cut and its preview would re-admit w1's closes into w2.
 */
export function ruledRecutsFor(windowId: string): readonly OtmEvaluationRuledRecut[] {
  return OTM_EVALUATION_RULED_RECUTS.filter((r) => r.windowId === windowId);
}

export type OtmEvaluationWindowStatus =
  | 'armed'
  | 'counting'
  | 'paused'
  | 'extended'
  | 'inconclusive_terminal'
  | OtmEvaluationVerdictStatus;

/** The process identity the predicate was evaluated on. */
export interface OtmEvaluationBuildPin {
  commit: string | null;
  commitShort: string | null;
  pid: number;
  startedAt: string;
}

/**
 * The SUBSET of `/api/health/options-live` the predicate reads — the wire
 * names, exactly as QuantTrader corrected them, so the predicate can be
 * evaluated against a captured health body in a test.
 */
export interface OtmEvaluationLivenessInputs {
  liveOtmArmed?: boolean | null;
  liveOtmRouting?: boolean | null;
  otmSleeveExitRule?: { rule?: string | null; chandelierRetired?: boolean | null } | null;
  otmEntryWindows?: {
    refusalDedupe?: { windowRefusalExpiresAtNextOpen?: boolean | null } | null;
  } | null;
  liveDayOneStopPosture?: {
    otmDayOneStop?: { armed?: boolean | null; release?: { released?: boolean | null } | null } | null;
  } | null;
  otmContractFloor?: {
    invalidKeys?: readonly string[] | null;
    bandIntersectsSelector?: boolean | null;
    /** The TRA-3944 floor's |delta| band (inclusive edges). */
    deltaBand?: readonly [number, number] | null;
    /** The armed selector's |delta| band ([min, max)). */
    selectorBand?: readonly [number, number] | null;
  } | null;
}

// ── Population cell (QuantTrader scope note, TRA-3945 comment `88ccac56`) ──
//
// The window measures ONE |entryDelta| cell — the cell that SURVIVES card
// `cc2c36fe` on TRA-3944 (floor band ∩ armed selector band) — and never a
// blend. A blended mean of a +1.47R cell and a −0.2R cell grades neither
// (TRA-2677). The cell is frozen at the stamp from the wire's own two bands;
// before the stamp it is published as a PREVIEW (`frozen: false`) so the
// pre-registration is readable on the wire today. A close whose entry delta
// falls outside the cell is refused under `excludedCloses.reasons.outsideDeltaCell`;
// an entry with no finite delta is refused under `entryDeltaUnknown` (fails
// CLOSED — an unknown delta is not a member of any cell).

/** Symmetric edge tolerance for float rounding on |entryDelta| (0.495 ∈ [0.50,0.55)). */
export const OTM_EVALUATION_DELTA_CELL_TOLERANCE = 0.005;

export interface OtmEvaluationPopulationCell {
  /** Half-open [deltaAbsMin, deltaAbsMax) BEFORE tolerance. */
  deltaAbsMin: number;
  deltaAbsMax: number;
  tolerance: number;
  floorBand: [number, number];
  selectorBand: [number, number];
  frozen: boolean;
  frozenAt: number | null;
  pooledCellsForbidden: true;
}

/** `null` when the two bands do not intersect (card `cc2c36fe` unresolved). */
export function resolveOtmEvaluationPopulationCell(
  floor: OtmEvaluationLivenessInputs['otmContractFloor'],
): Omit<OtmEvaluationPopulationCell, 'frozen' | 'frozenAt'> | null {
  const fb = floor?.deltaBand;
  const sb = floor?.selectorBand;
  if (!fb || !sb || !fb.every(Number.isFinite) || !sb.every(Number.isFinite)) return null;
  const lo = Math.max(fb[0], sb[0]);
  const hi = Math.min(fb[1], sb[1]);
  if (!(hi > lo)) return null;
  return {
    deltaAbsMin: round6(lo),
    deltaAbsMax: round6(hi),
    tolerance: OTM_EVALUATION_DELTA_CELL_TOLERANCE,
    floorBand: [fb[0], fb[1]],
    selectorBand: [sb[0], sb[1]],
    pooledCellsForbidden: true,
  };
}

export function entryDeltaInCell(
  entryDelta: unknown,
  cell: Pick<OtmEvaluationPopulationCell, 'deltaAbsMin' | 'deltaAbsMax' | 'tolerance'>,
): 'in' | 'out' | 'unknown' {
  if (typeof entryDelta !== 'number' || !Number.isFinite(entryDelta)) return 'unknown';
  const d = Math.abs(entryDelta);
  return d >= cell.deltaAbsMin - cell.tolerance && d < cell.deltaAbsMax + cell.tolerance ? 'in' : 'out';
}

export interface OtmEvaluationLiveness {
  routing: boolean;
  trailExit: boolean;
  entryWindow: boolean;
  dayOneStop: boolean;
  contractFloor: boolean;
  allTrue: boolean;
  /** The clause names that read false — the `buildDrift[]` span reason. */
  falseClauses: string[];
}

/** Every clause `=== true`; an absent/null field is FALSE, never "unknown-so-fine". */
export function evaluateOtmEvaluationLiveness(h: OtmEvaluationLivenessInputs): OtmEvaluationLiveness {
  const routing = h.liveOtmArmed === true && h.liveOtmRouting === true;
  const trailExit =
    h.otmSleeveExitRule?.rule === 'trail' && h.otmSleeveExitRule?.chandelierRetired === true;
  const entryWindow = h.otmEntryWindows?.refusalDedupe?.windowRefusalExpiresAtNextOpen === true;
  const dayOneStop =
    h.liveDayOneStopPosture?.otmDayOneStop?.armed === true
    && h.liveDayOneStopPosture?.otmDayOneStop?.release?.released === true;
  const floor = h.otmContractFloor;
  const contractFloor =
    floor != null
    && Array.isArray(floor.invalidKeys)
    && floor.invalidKeys.length === 0
    && floor.bandIntersectsSelector === true;
  const clauses = { routing, trailExit, entryWindow, dayOneStop, contractFloor };
  const falseClauses = (Object.keys(clauses) as Array<keyof typeof clauses>).filter((k) => !clauses[k]);
  return { ...clauses, allTrue: falseClauses.length === 0, falseClauses };
}

export interface OtmEvaluationPauseSpan {
  /** ms epoch the predicate went false. */
  from: number;
  /** ms epoch it came back all-true; `null` while still paused. */
  to: number | null;
  /** The process that read it false. */
  build: OtmEvaluationBuildPin;
  falseClauses: string[];
}

export interface OtmEvaluationBaseline {
  n: number;
  avgR: number | null;
  seR: number | null;
  winRate: number | null;
  netUsd: number;
  /** `true` once stamped at `startedAt`; `false` = live preview while armed. */
  frozen: boolean;
  frozenAt: number | null;
  population: string;
}

export interface OtmEvaluationVerdict {
  status: OtmEvaluationVerdictStatus;
  /** Must carry the grader's ticket reference. */
  note: string;
  at: number;
  by: string;
  /** The counted `n` the verdict was written at; `null` on a legacy record. */
  atN?: number | null;
  /**
   * Set ONLY when the verdict was filed over an unexecuted ruled re-cut. A
   * verdict is once-only and a graded window can never be re-cut, so filing
   * one first makes the ruling permanently unexecutable — the grader may still
   * do it, but the record then says, forever, which population the terminal
   * was written over and which ruling it overrode.
   */
  acknowledgedUnexecutedRecuts?: ReadonlyArray<{
    rulingRef: string;
    candidateStartedAt: string;
    /** The cut the verdict was actually written over. */
    cutAtVerdict: string;
  }> | null;
}

/**
 * One executed re-cut. The PRIOR cut is kept so the wire can still show which
 * population every earlier filing was computed over — a re-cut that silently
 * overwrote `startedAt` would make every prior comment unreproducible.
 */
export interface OtmEvaluationRecutEntry {
  at: number;
  by: string;
  /** Must carry the ruling's ticket reference. */
  note: string;
  priorStartedAt: number;
  priorStartBuild: OtmEvaluationBuildPin | null;
  /** Counted n immediately BEFORE the re-cut, read off the fold in the same beat. */
  priorN: number | null;
  startedAt: number;
  startBuild: OtmEvaluationBuildPin | null;
}

/**
 * A retired window, kept verbatim inside its successor's state so every filing
 * made against it stays reproducible after the successor takes the wire.
 */
export interface OtmEvaluationPredecessor {
  windowId: string;
  startedAt: number | null;
  startBuild: OtmEvaluationBuildPin | null;
  recutHistory: OtmEvaluationRecutEntry[];
  buildDriftTotal: number;
  extension: OtmEvaluationWindowState['extension'];
  baseline: OtmEvaluationBaseline | null;
  populationCell: OtmEvaluationPopulationCell | null;
  terminalAt: number | null;
  verdict: OtmEvaluationVerdict | null;
  /**
   * The fold over the predecessor's own cut, read in the SAME beat as the
   * successor write. The fold does not stop at a verdict, so this can exceed
   * `verdict.atN` by the closes that landed between the verdict and the
   * successor — both are kept so the difference stays visible.
   */
  finalReadout: {
    n: number;
    avgR: number | null;
    seR: number | null;
    winRate: number | null;
    netUsd: number;
    criteria: OtmEvaluationReadout['criteria'];
    lastCloseAt: number | null;
  };
  retiredAt: number;
  retiredBy: string;
  /** Must carry the registering ticket reference. */
  retiredNote: string;
}

/** Bound on the persisted predecessor chain. */
export const OTM_EVALUATION_PREDECESSORS_MAX = 10;

/** The persisted part. Everything else is derived on read. */
export interface OtmEvaluationWindowState {
  version: 1;
  windowId: string;
  startedAt: number | null;
  startBuild: OtmEvaluationBuildPin | null;
  /** TRA-3945 re-cut log; `[]` on a record that has never been re-cut. */
  recutHistory?: OtmEvaluationRecutEntry[];
  /** TRA-3945 retired windows, oldest first; absent/`[]` on the first registration. */
  predecessors?: OtmEvaluationPredecessor[];
  buildDrift: OtmEvaluationPauseSpan[];
  buildDriftTotal: number;
  extension: { allowed: 1; closes: number; used: boolean; usedAt: number | null };
  baseline: OtmEvaluationBaseline | null;
  /** Frozen at the stamp; preview (`frozen: false`) or `null` while armed. */
  populationCell: OtmEvaluationPopulationCell | null;
  terminalAt: number | null;
  verdict: OtmEvaluationVerdict | null;
  lastTickAt: number | null;
  lastTickBuild: OtmEvaluationBuildPin | null;
}

export function emptyOtmEvaluationWindowState(): OtmEvaluationWindowState {
  return {
    version: 1,
    windowId: OTM_EVALUATION_WINDOW_ID,
    startedAt: null,
    startBuild: null,
    recutHistory: [],
    buildDrift: [],
    buildDriftTotal: 0,
    extension: { allowed: 1, closes: OTM_EVALUATION_EXTENSION_CLOSES, used: false, usedAt: null },
    baseline: null,
    populationCell: null,
    terminalAt: null,
    verdict: null,
    lastTickAt: null,
    lastTickBuild: null,
  };
}

// ── Dedupe + fold ───────────────────────────────────────────────────────────

/** The close row as the fold sees it; `brokerOrderId` is the TRA-3945 stamp. */
type CloseRow = OptionTradeJournalRecord & { brokerOrderId?: string | number | null };

export function otmEvaluationDedupeKey(r: CloseRow): string {
  const id = r.brokerOrderId;
  if (id !== undefined && id !== null && String(id).trim() !== '') return `order:${String(id).trim()}`;
  // TRA-3945 §3b — `account` scopes the fallback leg. Its ONLY job is to collapse
  // a double-REPORT of one fill, which is by construction inside one book (the
  // XLF/BAC double-listing carried the same `account` under two strategy labels,
  // so it still collides). Without the book, two DIFFERENT books closing the same
  // contract at the same instant with no order id merge into one observation —
  // the under-count twin of the over-count the cluster layer below refuses.
  return `fallback:${r.account ?? '-'}|${r.optionSymbol ?? r.symbol}|${r.closeTs}`;
}

/**
 * TRA-3945 §3b — the CLUSTER key: one contract, one ET session, ANY book.
 *
 * Derived from the ENTRY only. See §3b: an exit-derived key would hand the arm
 * under test control of its own sample size.
 */
export function otmEvaluationClusterKey(r: CloseRow): string {
  return `${r.optionSymbol ?? r.symbol}|${etDay(r.openTs)}`;
}

export interface OtmEvaluationStats {
  n: number;
  avgR: number | null;
  /** sample sd (n−1) / √n; `null` below n=2. */
  seR: number | null;
  winRate: number | null;
  netUsd: number;
}

/** TRA-375 basis: mean of the journal's `realizedR`; sample sd with n−1. */
export function otmEvaluationStats(rs: ReadonlyArray<{ realizedR: number; realizedPnlUsd: number }>): OtmEvaluationStats {
  const n = rs.length;
  if (n === 0) return { n: 0, avgR: null, seR: null, winRate: null, netUsd: 0 };
  const sumR = rs.reduce((a, r) => a + r.realizedR, 0);
  const avgR = sumR / n;
  let seR: number | null = null;
  if (n >= 2) {
    const ss = rs.reduce((a, r) => a + (r.realizedR - avgR) ** 2, 0);
    seR = Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
  }
  const wins = rs.filter((r) => r.realizedPnlUsd > 0).length;
  const netUsd = Math.round(rs.reduce((a, r) => a + r.realizedPnlUsd, 0) * 100) / 100;
  return { n, avgR: round6(avgR), seR: seR === null ? null : round6(seR), winRate: round6(wins / n), netUsd };
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Two-sided 95% Student-t critical values, df 1..30, then the normal limit.
 *
 * The pre-registered `lowerCi95` is a NORMAL interval (z = 1.96) and stays one —
 * it is the number the `cutToZeroNominationsIf` rule was written against and
 * re-cutting a bar mid-window is exactly what this record exists to prevent.
 * But at the n this window actually reached, z and t are not interchangeable:
 * at n=9 the multiplier is 2.306 (+18%), at n=4 it is 3.182 (+62%). Publishing
 * the t interval BESIDE it, explicitly labelled as not the rule's number, is
 * what stops a reader concluding "the whole interval is below zero" from a
 * multiplier that assumes a sample size we do not have.
 */
const T_CRIT_95_TWO_SIDED: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/** `null` below n=2, where there is no df to speak of. */
export function tCritical95(n: number): number | null {
  if (!Number.isFinite(n) || n < 2) return null;
  const df = Math.floor(n) - 1;
  return df <= T_CRIT_95_TWO_SIDED.length ? (T_CRIT_95_TWO_SIDED[df - 1] as number) : 1.96;
}

export interface OtmEvaluationExcluded {
  /** Σ of the TRUE exclusions below (NOT `brokerOrderIdNull`, which is counted). */
  n: number;
  reasons: {
    entryPredatesStart: number;
    rulesetPaused: number;
    dedupeDuplicate: number;
    notLive: number;
    notOtm: number;
    /** |entryDelta| outside the frozen population cell (ONE cell, never pooled). */
    outsideDeltaCell: number;
    /** No finite entryDelta on the row — fails CLOSED. */
    entryDeltaUnknown: number;
    /** VISIBILITY counter — these closes ARE counted under the fallback key. */
    brokerOrderIdNull: number;
    /**
     * TRA-3945 §3b — an ELIGIBLE close refused because another eligible close
     * of the same contract entered in the same ET session already represents
     * the cluster. One price path, one draw. Book-agnostic.
     */
    sameContractSameSessionCluster: number;
  };
  brokerOrderIdNullCounted: true;
}

interface DedupedClose {
  rec: CloseRow;
  key: string;
  duplicates: number;
}

/**
 * Group every CLOSED row by the dedupe key; one representative per group,
 * preferring the `single_leg_otm`-labelled row (the double-listing put the same
 * fill under two labels — the OTM label is the one the sleeve owns).
 */
function dedupeClosedRows(records: ReadonlyArray<CloseRow>): DedupedClose[] {
  const groups = new Map<string, CloseRow[]>();
  for (const r of records) {
    if (r.outcome === 'OPEN' || !Number.isFinite(r.closeTs) || !Number.isFinite(r.realizedR)) continue;
    const key = otmEvaluationDedupeKey(r);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out: DedupedClose[] = [];
  for (const [key, rows] of groups) {
    const rep = rows.find((r) => r.structure === OTM_SLEEVE_MANDATE_STRUCTURE) ?? rows[0]!;
    out.push({ rec: rep, key, duplicates: rows.length - 1 });
  }
  return out.sort((a, b) => (a.rec.closeTs ?? 0) - (b.rec.closeTs ?? 0));
}

function isOtmLiveClose(r: CloseRow): { otm: boolean; live: boolean } {
  return { otm: r.structure === OTM_SLEEVE_MANDATE_STRUCTURE, live: r.mode === 'live' };
}

function insidePausedSpan(ts: number, spans: ReadonlyArray<OtmEvaluationPauseSpan>, now: number): boolean {
  return spans.some((s) => ts >= s.from && ts < (s.to ?? now + 1));
}

/** Baseline population: live OTM closes (deduped) whose ENTRY predates the pin. */
export function computeOtmEvaluationBaseline(
  records: ReadonlyArray<CloseRow>,
  cutoffMs: number,
): Omit<OtmEvaluationBaseline, 'frozen' | 'frozenAt'> {
  const rows = dedupeClosedRows(records)
    .map((d) => d.rec)
    .filter((r) => {
      const c = isOtmLiveClose(r);
      return c.otm && c.live && r.openTs < cutoffMs;
    })
    .map((r) => ({ realizedR: r.realizedR as number, realizedPnlUsd: r.realizedPnlUsd ?? 0 }));
  const s = otmEvaluationStats(rows);
  return {
    ...s,
    population: 'live single_leg_otm closes, deduped, entry openTs < startedAt (historical chandelier exit + open-entry)',
  };
}

// TRA-4440 — was `interface ... extends OtmEvaluationStats {}`, which declares no
// members and is therefore exactly its supertype (`no-empty-object-type`). The alias
// is the same type, and keeps the named cell for the readout below.
export type OtmEvaluationSecondaryCell = OtmEvaluationStats;

export interface OtmEvaluationReadout extends OtmEvaluationStats {
  closesRemaining: number;
  lastCloseAt: number | null;
  excludedCloses: OtmEvaluationExcluded;
  /** What the pre-registered thresholds say about the CURRENT readout. NOT a verdict. */
  criteria: 'pass_criteria_met' | 'fail_criteria_met' | 'inconclusive' | 'below_target';
  secondary: {
    caveat: string;
    byExitReason: Record<string, OtmEvaluationSecondaryCell>;
    byEntryWindow: { morning: OtmEvaluationSecondaryCell; afternoon: OtmEvaluationSecondaryCell };
  };
}

const ET_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', hour12: false,
});
function etHour(ms: number): number {
  const h = Number(ET_HOUR_FMT.format(new Date(ms)));
  return Number.isFinite(h) ? h % 24 : 0;
}

/** TRA-3945 §3b — the ET calendar day an entry was booked on ("2026-08-24"). */
const ET_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
function etDay(ms: number): string {
  return Number.isFinite(ms) ? ET_DAY_FMT.format(new Date(ms)) : 'unknown';
}

function targetFor(state: OtmEvaluationWindowState): number {
  return OTM_EVALUATION_TARGET_CLOSES + (state.extension.used ? state.extension.closes : 0);
}

const ET_WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const HALF_DAY_MS = 43_200_000;

// ── TRA-4345 — can the population still be PRODUCED? ────────────────────────
//
// The cadence's `closesPerSession` is a HISTORICAL average. When the entry
// gate is structurally shut — no configured entry window intersects the
// 09:30–16:00 ET options session — the forward rate is 0 regardless of what
// the average says, and a projection divided off the average is a phantom ETA.
// This read is taken from live `OTM_ENTRY_WINDOWS_ET` resolution at record
// build time (a health read is also a tick), never stored.

/** Options RTH as minutes past ET midnight: 09:30 and 16:00. */
const RTH_START_ET_MIN = 9 * 60 + 30;
const RTH_END_ET_MIN = 16 * 60;

export interface OtmEntryAccrual {
  /** FALSE ⇒ the entry gate cannot open inside the session ⇒ forward close rate is structurally 0. */
  canAccrue: boolean;
  /** Machine-greppable cause, `null` when `canAccrue` is true. */
  cannotAccrueReason: string | null;
  /** The effective windows, ET (`10:15-11:30,15:00-15:45` shape), for the reader. */
  entryWindowsEt: string;
  entryWindowsSource: OtmEntryWindowSource;
}

/**
 * TRA-4345 AC3 — derived from the effective entry-window resolution, at read
 * time. A window `[startMin, endMin)` intersects RTH iff it starts before the
 * 16:00 ET close and ends after the 09:30 ET open (both half-open, so a
 * `09:00-09:30` window does NOT intersect). An empty/invalid env string never
 * reaches here as an empty list — {@link resolveOtmEntryWindows} resolves it
 * to the board's defaults with `source: 'env_invalid'`.
 */
export function assessOtmEntryAccrual(
  resolution: OtmEntryWindowResolution = resolveOtmEntryWindows(),
): OtmEntryAccrual {
  const intersectsRth = resolution.windows.some(
    (w) => w.startMin < RTH_END_ET_MIN && w.endMin > RTH_START_ET_MIN,
  );
  return {
    canAccrue: intersectsRth,
    cannotAccrueReason: intersectsRth ? null : 'entry_window_never_intersects_rth',
    entryWindowsEt: formatOtmEntryWindows(resolution.windows),
    entryWindowsSource: resolution.source,
  };
}

/**
 * The read-time accrual, failing to `null` — "unreadable", never a verdict —
 * if the env resolution itself throws. `null` is spent differently by the two
 * consumers: the cadence fails CLOSED (no ETA is published off an unreadable
 * gate), the staleness check fails toward "check me" (`null`, never `false`).
 */
export function readOtmEntryAccrual(): OtmEntryAccrual | null {
  try {
    return assessOtmEntryAccrual(resolveOtmEntryWindows());
  } catch {
    return null;
  }
}

// ── TRA-4610 — can the population still be REACHED? ─────────────────────────
//
// The entry-gate clause above answers "can an order be placed inside the
// session". That is ONE case of the general predicate, not the predicate.
//
// A window is equally starved when the cell it is pinned to is no longer
// NOMINATED. `populationCell` is frozen at the stamp — floor band ∩ armed
// selector band AT THAT INSTANT — and both of those are live env knobs that
// have moved since. Measured on prod `f8f7b1855da0` 2026-09-16: the cell was
// frozen at [0.50, 0.55) on 2026-08-23 while the armed
// `ENABLE_OTM_ADMISSIBLE_STRIKE_SELECT` band read [0.25, 0.40) — disjoint by
// 0.095 — and of 640 candidates evaluated that etDay, `cost_bar.byCell` put
// 365 in 0.30–0.40 and 275 in 0.20–0.30 and **zero** in the window's own cell.
// Meanwhile `entry_window` had re-opened (blockRate 1.00 → 0.62), so the
// TRA-4345 clause released and the record advertised `canAccrue: true` with
// `projectedSessionsToTarget: 42` — a runway it cannot walk. An `n` that cannot
// arrive is the most expensive thing this record can tell a reader to wait for.
//
// Computed at read time off the LIVE armed band and never stored: the frozen
// cell is the window's pre-registration and must not move, but whether that
// cell is still reachable is a property of today's wire.

export interface OtmPopulationReach {
  /** TRUE ⇒ the frozen cell can still be nominated. FALSE ⇒ the bands are disjoint. `null` ⇒ unreadable. */
  reachable: boolean | null;
  /** The cell's EFFECTIVE half-open membership interval, tolerance included — the same one `entryDeltaInCell` admits on. */
  cellBand: [number, number] | null;
  /** The live armed nominator band ([min, max)); `null` when unreadable or before the cell is stamped. */
  armedSelectorBand: [number, number] | null;
  /** Machine-greppable cause, `null` when `reachable` is true. */
  reason: string | null;
  method: string;
}

const OTM_POPULATION_REACH_METHOD =
  'the cell\'s OWN membership interval [deltaAbsMin - tolerance, deltaAbsMax + tolerance) against the LIVE armed selector band [min, max); two half-open intervals intersect iff lo < selectorMax AND selectorMin < hi. Read at record-build time off the live band - the FROZEN cell never moves. NOT the same predicate as `nominationBandIntersects`, which compares the LIVE floor band to the LIVE selector band and says nothing about the frozen cell. Non-binding before a cell is stamped (there is no cell to starve); an unreadable band reads `null` and the cadence fails CLOSED on it, never open.';

/**
 * TRA-4610 — is the FROZEN population cell still inside the LIVE armed
 * nominator band? Pure, so the test can build either side.
 *
 * Uses the tolerance-widened interval deliberately: a close is COUNTED iff
 * {@link entryDeltaInCell} admits it, so reachability has to be asked on the
 * same interval the fold admits on, or the two disagree at the edge.
 */
export function assessOtmPopulationReach(
  cell: Pick<OtmEvaluationPopulationCell, 'deltaAbsMin' | 'deltaAbsMax' | 'tolerance'> | null,
  armedSelectorBand: readonly [number, number] | null | undefined,
): OtmPopulationReach {
  const method = OTM_POPULATION_REACH_METHOD;
  // No cell stamped yet ⇒ this clause cannot bind. A fresh successor window
  // must never read `canAccrue: false` for want of a cell it has not cut.
  if (cell === null) {
    return { reachable: true, cellBand: null, armedSelectorBand: null, reason: null, method };
  }
  const lo = cell.deltaAbsMin - cell.tolerance;
  const hi = cell.deltaAbsMax + cell.tolerance;
  const cellBand: [number, number] = [round6(lo), round6(hi)];
  const sb = armedSelectorBand;
  if (!sb || !Number.isFinite(sb[0]) || !Number.isFinite(sb[1])) {
    return { reachable: null, cellBand, armedSelectorBand: null, reason: 'armed_selector_band_unreadable', method };
  }
  const reachable = lo < sb[1] && sb[0] < hi;
  return {
    reachable,
    cellBand,
    armedSelectorBand: [sb[0], sb[1]],
    reason: reachable ? null : 'population_cell_outside_armed_selector_band',
    method,
  };
}

export interface OtmEvaluationCadence {
  asOf: string;
  /** ET weekdays whose 16:00 ET close is at or before `asOf`, since the stamp. */
  rthSessionsElapsed: number;
  closesPerSession: number | null;
  /**
   * FALSE ⇒ the forward close rate is structurally 0, whatever `closesPerSession` says.
   *
   * TRA-4345 introduced this on the entry-gate clause alone. TRA-4610 made it
   * the CONJUNCTION of every accrual clause: the entry gate opening is
   * necessary, not sufficient — the cell also has to be reachable by the armed
   * nominator. See {@link blockers}.
   */
  canAccrue: boolean;
  /** The FIRST blocking clause, entry gate first. `null` when `canAccrue` is true. */
  cannotAccrueReason: string | null;
  /**
   * TRA-4610 — EVERY blocking clause, so one starving gate can never hide
   * behind another (TRA-3926: two gates on one row must agree, and a single
   * reason string cannot say that they do not). Empty ⇒ accruing.
   */
  blockers: string[];
  /** `null` when the rate is zero OR when `canAccrue` is false — at that pace the window NEVER reaches target; never `0`. */
  projectedSessionsToTarget: number | null;
  method: string;
}

/**
 * TRA-3945 (QuantTrader fd917f86, 2026-08-26) — the window's own PACE, on the
 * record, so `counting` can never be read as "still gathering evidence" once
 * the entry population is starved. Exchange holidays are NOT subtracted: they
 * read as a session with 0 closes, which biases `closesPerSession` LOW and the
 * projection HIGH — the conservative direction for a reader deciding whether
 * the window can converge.
 */
export function otmEvaluationCadence(
  state: OtmEvaluationWindowState,
  n: number,
  asOf: number,
  /** TRA-4345 — read-time entry-gate accrual; `null` = unreadable ⇒ fail closed (no ETA). */
  accrual: OtmEntryAccrual | null = readOtmEntryAccrual(),
  /**
   * TRA-4610 — read-time cell reachability. `null` = clause NOT EVALUATED this
   * beat (non-binding, back-compat for callers predating TRA-4610), which is a
   * different thing from `reach.reachable === null` = evaluated and UNREADABLE,
   * which fails CLOSED.
   */
  reach: OtmPopulationReach | null = null,
): OtmEvaluationCadence | null {
  if (state.startedAt === null || !Number.isFinite(asOf) || asOf < state.startedAt) return null;
  const startDay = etDay(state.startedAt);
  const startBeforeClose = etHour(state.startedAt) < 16;
  const asOfDay = etDay(asOf);
  const asOfAfterClose = etHour(asOf) >= 16;
  const seen = new Set<string>();
  let sessions = 0;
  // 12h steps so a 23h spring-forward ET day cannot be stepped over; dedupe by ET day.
  for (let t = state.startedAt; t <= asOf; t += HALF_DAY_MS) {
    const day = etDay(t);
    if (seen.has(day)) continue;
    seen.add(day);
    const wd = ET_WEEKDAY_FMT.format(new Date(t));
    if (wd === 'Sat' || wd === 'Sun') continue;
    if (day === startDay && !startBeforeClose) continue;
    if (day > asOfDay || (day === asOfDay && !asOfAfterClose)) continue;
    sessions += 1;
  }
  const target = targetFor(state);
  const rate = sessions > 0 ? n / sessions : null;
  const remaining = Math.max(0, target - n);
  // TRA-4345 AC3 — a historical average hides a zero FORWARD rate. When the
  // entry gate cannot open inside the session the remaining closes cannot be
  // produced, so the projection is `null` ("never at this pace"), not a number.
  // A reached target (`remaining === 0`) still reads 0 — nothing left to accrue.
  // TRA-4610 — the CONJUNCTION of every accrual clause. Precedence in
  // `cannotAccrueReason` keeps the entry gate first so TRA-4345's reason string
  // is unchanged where that clause is the one biting; `blockers` carries the
  // rest, because a reader deciding whether to wait needs to know that fixing
  // the named gate would not start the population moving.
  const entryBlocker = accrual === null
    ? 'entry_window_state_unreadable'
    : accrual.canAccrue ? null : (accrual.cannotAccrueReason ?? 'entry_window_never_intersects_rth');
  // `reach === null` = not evaluated ⇒ non-binding. `reachable !== true`
  // (false OR unreadable) ⇒ blocking: an unreadable nominator band must never
  // buy the record a runway it cannot demonstrate.
  const reachBlocker = reach === null || reach.reachable === true
    ? null
    : (reach.reason ?? 'population_cell_outside_armed_selector_band');
  const blockers = [entryBlocker, reachBlocker].filter((b): b is string => b !== null);
  const canAccrue = blockers.length === 0;
  return {
    asOf: new Date(asOf).toISOString(),
    rthSessionsElapsed: sessions,
    closesPerSession: rate === null ? null : round6(rate),
    canAccrue,
    cannotAccrueReason: blockers[0] ?? null,
    blockers,
    projectedSessionsToTarget:
      remaining === 0 ? 0
        : !canAccrue ? null
          : rate !== null && rate > 0 ? Math.ceil(remaining / rate) : null,
    method: 'an ET weekday counts once its 16:00 ET close is at or before asOf; the stamp day only if the window opened before that close; holidays NOT subtracted (biases the projection HIGH, the conservative direction); projectedSessionsToTarget = ceil((target - n) / closesPerSession), null on a zero rate AND null when canAccrue is false. canAccrue is the CONJUNCTION of every accrual clause (TRA-4610), not the entry gate alone: (1) TRA-4345 - a configured entry window must intersect the 09:30-16:00 ET session, and (2) TRA-4610 - the frozen populationCell must still intersect the LIVE armed nominator band, or no candidate is ever nominated into the cell the window counts. Clause 1 opening does NOT imply accrual; see `blockers` for every clause that is shut and `populationReach` for clause 2\'s two bands.',
  };
}

/**
 * The window's COUNTED closes and the refusal tally, split out of
 * {@link foldOtmEvaluationWindow} (TRA-3974) so a second reader — the
 * fill-quote median split — runs over the record's own population by
 * construction and can never fold a differently-selected one under the same
 * `n`. Behaviourally identical to the block it replaced.
 */
export function selectOtmEvaluationCountedCloses(
  records: ReadonlyArray<CloseRow>,
  state: OtmEvaluationWindowState,
  now: number,
): { counted: CloseRow[]; reasons: OtmEvaluationExcluded['reasons'] } {
  const reasons = {
    entryPredatesStart: 0, rulesetPaused: 0, dedupeDuplicate: 0, notLive: 0, notOtm: 0,
    outsideDeltaCell: 0, entryDeltaUnknown: 0, brokerOrderIdNull: 0,
    sameContractSameSessionCluster: 0,
  };
  const eligible: Array<{ rec: CloseRow; key: string; fallbackKeyed: boolean }> = [];
  const counted: CloseRow[] = [];
  if (state.startedAt !== null) {
    const cell = state.populationCell;
    for (const d of dedupeClosedRows(records)) {
      const r = d.rec;
      const c = isOtmLiveClose(r);
      // Only rows that at least close after the pin are the record's business;
      // a pre-pin duplicate is the baseline's, not ours.
      if ((r.closeTs ?? 0) < state.startedAt) continue;
      if (!c.otm) { reasons.notOtm += 1; continue; }
      if (!c.live) { reasons.notLive += 1; continue; }
      if (r.openTs < state.startedAt) { reasons.entryPredatesStart += 1; continue; }
      if (insidePausedSpan(r.openTs, state.buildDrift, now)) { reasons.rulesetPaused += 1; continue; }
      if (cell) {
        const m = entryDeltaInCell(r.entryDelta, cell);
        if (m === 'out') { reasons.outsideDeltaCell += 1; continue; }
        if (m === 'unknown') { reasons.entryDeltaUnknown += 1; continue; }
      }
      reasons.dedupeDuplicate += d.duplicates;
      eligible.push({ rec: r, key: d.key, fallbackKeyed: d.key.startsWith('fallback:') });
    }
    // TRA-3945 §3b — CLUSTER layer. Runs LAST, over the ELIGIBLE set only: an
    // out-of-cell or pre-pin row must never displace an eligible one as the
    // representative of its session. Representative = earliest `openTs`, ties
    // on the dedupe key, so the choice is deterministic and replay-stable.
    const clusters = new Map<string, Array<{ rec: CloseRow; key: string; fallbackKeyed: boolean }>>();
    for (const e of eligible) {
      const ck = otmEvaluationClusterKey(e.rec);
      const g = clusters.get(ck);
      if (g) g.push(e);
      else clusters.set(ck, [e]);
    }
    for (const g of clusters.values()) {
      g.sort((a, b) => (a.rec.openTs - b.rec.openTs) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const rep = g[0]!;
      reasons.sameContractSameSessionCluster += g.length - 1;
      if (rep.fallbackKeyed) reasons.brokerOrderIdNull += 1;
      counted.push(rep.rec);
    }
    counted.sort((a, b) => (a.closeTs ?? 0) - (b.closeTs ?? 0));
  }
  return { counted, reasons };
}

export function foldOtmEvaluationWindow(
  records: ReadonlyArray<CloseRow>,
  state: OtmEvaluationWindowState,
  now: number,
): OtmEvaluationReadout {
  const { counted, reasons } = selectOtmEvaluationCountedCloses(records, state, now);
  const rows = counted.map((r) => ({
    realizedR: r.realizedR as number,
    realizedPnlUsd: r.realizedPnlUsd ?? 0,
    exitReason: r.exitReason ?? 'unknown',
    openTs: r.openTs,
    closeTs: r.closeTs as number,
  }));
  const stats = otmEvaluationStats(rows);
  const target = targetFor(state);
  const excludedN =
    reasons.entryPredatesStart + reasons.rulesetPaused + reasons.dedupeDuplicate + reasons.notLive + reasons.notOtm
    + reasons.outsideDeltaCell + reasons.entryDeltaUnknown + reasons.sameContractSameSessionCluster;

  let criteria: OtmEvaluationReadout['criteria'] = 'below_target';
  if (stats.n >= target && stats.avgR !== null && stats.seR !== null) {
    if (stats.seR < OTM_EVALUATION_SE_R_MAX) {
      criteria = stats.avgR > 0 ? 'pass_criteria_met' : 'fail_criteria_met';
    } else {
      criteria = 'inconclusive';
    }
  }

  const byExitReason: Record<string, OtmEvaluationSecondaryCell> = {};
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const g = groups.get(r.exitReason);
    if (g) g.push(r);
    else groups.set(r.exitReason, [r]);
  }
  for (const [k, g] of groups) byExitReason[k] = otmEvaluationStats(g);

  return {
    ...stats,
    closesRemaining: Math.max(0, target - stats.n),
    lastCloseAt: rows.length ? Math.max(...rows.map((r) => r.closeTs)) : null,
    excludedCloses: { n: excludedN, reasons, brokerOrderIdNullCounted: true },
    criteria,
    secondary: {
      caveat: 'UNDERPOWERED - descriptive only, no verdict may cite these',
      byExitReason,
      byEntryWindow: {
        morning: otmEvaluationStats(rows.filter((r) => etHour(r.openTs) < 12)),
        afternoon: otmEvaluationStats(rows.filter((r) => etHour(r.openTs) >= 12)),
      },
    },
  };
}

// ── State machine ───────────────────────────────────────────────────────────

export function otmEvaluationWindowStatus(state: OtmEvaluationWindowState): OtmEvaluationWindowStatus {
  if (state.verdict) return state.verdict.status;
  if (state.startedAt === null) return 'armed';
  if (state.terminalAt !== null) return 'inconclusive_terminal';
  if (state.buildDrift.some((s) => s.to === null)) return 'paused';
  if (state.extension.used) return 'extended';
  return 'counting';
}

/**
 * One tick. Pure on its inputs; returns `{ state, changed }` so the caller
 * persists only on a real transition. `records` is the full journal (the
 * baseline and the one-shot extension both read it).
 */
export function stepOtmEvaluationWindow(
  prev: OtmEvaluationWindowState,
  liveness: OtmEvaluationLiveness,
  pin: OtmEvaluationBuildPin,
  records: ReadonlyArray<CloseRow>,
  now: number,
  floor?: OtmEvaluationLivenessInputs['otmContractFloor'],
): { state: OtmEvaluationWindowState; changed: boolean } {
  const state: OtmEvaluationWindowState = {
    ...prev,
    buildDrift: prev.buildDrift.map((s) => ({ ...s })),
    extension: { ...prev.extension },
  };
  let changed = false;
  const mark = (): void => { changed = true; };

  state.lastTickAt = now;
  state.lastTickBuild = pin;

  if (state.verdict) return { state, changed: false };

  if (state.startedAt === null) {
    const cell = resolveOtmEvaluationPopulationCell(floor);
    // The cell is PART of the opening predicate: `bandIntersectsSelector` is
    // already in `liveness`, and the cell is the same intersection read as
    // numbers. Both bands on the wire, non-empty intersection, or no stamp.
    if (liveness.allTrue && cell) {
      // The stamp. Once. Never re-stamped.
      state.startedAt = now;
      state.startBuild = pin;
      state.baseline = { ...computeOtmEvaluationBaseline(records, now), frozen: true, frozenAt: now };
      state.populationCell = { ...cell, frozen: true, frozenAt: now };
      log.info('TRA-3945 OTM evaluation window OPENED', {
        windowId: state.windowId, startedAt: new Date(now).toISOString(), build: pin,
        baseline: state.baseline, populationCell: state.populationCell,
      });
      mark();
    } else {
      const cellPreview = cell ? { ...cell, frozen: false as const, frozenAt: null } : null;
      if (JSON.stringify(cellPreview) !== JSON.stringify(state.populationCell)) {
        state.populationCell = cellPreview;
        mark();
      }
      // Armed: keep the baseline PREVIEW current so the numbers are on the
      // wire now (ruling: "state the deduped n and its avg R / se(R) as
      // NUMBERS in the record at arm time"); it freezes at the stamp.
      const preview = { ...computeOtmEvaluationBaseline(records, now), frozen: false as const, frozenAt: null };
      const before = state.baseline;
      if (!before || before.n !== preview.n || before.netUsd !== preview.netUsd || before.frozen) {
        state.baseline = preview;
        mark();
      }
    }
    return { state, changed };
  }

  // Counting. Re-evaluate the predicate; a false clause opens a pause span.
  const open = state.buildDrift.find((s) => s.to === null);
  if (!liveness.allTrue && !open) {
    state.buildDrift.push({ from: now, to: null, build: pin, falseClauses: liveness.falseClauses });
    state.buildDriftTotal += 1;
    if (state.buildDrift.length > OTM_EVALUATION_DRIFT_SPANS_MAX) {
      state.buildDrift.splice(0, state.buildDrift.length - OTM_EVALUATION_DRIFT_SPANS_MAX);
    }
    log.warn('TRA-3945 OTM evaluation window PAUSED: liveness clause false', {
      windowId: state.windowId, falseClauses: liveness.falseClauses, build: pin,
    });
    mark();
  } else if (liveness.allTrue && open) {
    open.to = now;
    log.info('TRA-3945 OTM evaluation window RESUMED', { windowId: state.windowId, pausedMs: now - open.from });
    mark();
  }

  if (state.terminalAt === null) {
    const readout = foldOtmEvaluationWindow(records, state, now);
    if (readout.criteria === 'inconclusive') {
      if (!state.extension.used) {
        state.extension.used = true;
        state.extension.usedAt = now;
        log.warn('TRA-3945 OTM evaluation window EXTENDED once', { windowId: state.windowId, n: readout.n, seR: readout.seR });
        mark();
      } else {
        state.terminalAt = now;
        log.warn('TRA-3945 OTM evaluation window INCONCLUSIVE_TERMINAL', { windowId: state.windowId, n: readout.n, seR: readout.seR });
        mark();
      }
    }
  }
  return { state, changed };
}

/**
 * The ruled re-cuts this record has NOT executed — every declaration whose
 * `candidateStartedAt` is still later than the persisted cut.
 *
 * This is the same predicate `recut.ruled[].satisfied` publishes, lifted out so
 * the WRITER can key on it instead of the operator's memory of a thread.
 */
export function unexecutedRuledRecuts(
  state: OtmEvaluationWindowState,
  ruled: readonly OtmEvaluationRuledRecut[] = ruledRecutsFor(state.windowId),
): readonly OtmEvaluationRuledRecut[] {
  if (state.startedAt === null) return [];
  return ruled.filter((r) => r.candidateStartedAt > (state.startedAt as number));
}

/**
 * Hand-run only (the verdict route or the offline script — never the tick).
 * Refuses a note without a ticket reference, a window that never opened, a
 * second verdict, and a starved-population terminal on a FULL sample.
 *
 * ── The ORDERING interlock (TRA-3945, 2026-09-10) ────────────────────────────
 *
 * A verdict is `onceOnly` and `applyOtmEvaluationRecut` refuses a graded window.
 * Those two rules compose into an ordering the record never stated: **filing the
 * terminal first makes every ruled re-cut permanently unexecutable**, and the
 * terminal is then frozen over a population the verdict owner's own ruling
 * declared inadmissible. Nothing here can un-freeze it afterwards.
 *
 * So the writer refuses while a ruled re-cut is unexecuted, and names both doors:
 * execute the re-cut first, or re-post with `acknowledgeUnexecutedRecuts` and
 * have the override recorded IN the verdict. The grader keeps the decision — the
 * writer only makes it impossible to make it by accident, which is the same
 * asymmetry the FORWARD-only rule encodes for the re-cut itself.
 */
export function applyOtmEvaluationVerdict(
  state: OtmEvaluationWindowState,
  verdict: {
    status: OtmEvaluationVerdictStatus;
    note: string;
    by: string;
    atN?: number | null;
    /** Explicit override: file the terminal over an unexecuted ruled re-cut. */
    acknowledgeUnexecutedRecuts?: boolean;
  },
  now: number,
): OtmEvaluationWindowState {
  if (!OTM_EVALUATION_VERDICT_STATUSES.includes(verdict.status)) {
    throw new Error(`TRA-3945: verdict status must be one of ${OTM_EVALUATION_VERDICT_STATUSES.join('|')}, got ${String(verdict.status)}`);
  }
  if (!/TRA-\d+/.test(verdict.note)) {
    throw new Error('TRA-3945: a verdict note must carry the grader\'s ticket reference (TRA-nnnn)');
  }
  if (state.startedAt === null) throw new Error('TRA-3945: cannot write a verdict on a window that never opened');
  if (state.verdict) {
    throw new Error(`TRA-3945: a verdict is already written (${state.verdict.status} by ${state.verdict.by} at ${new Date(state.verdict.at).toISOString()})`);
  }
  const atN = typeof verdict.atN === 'number' && Number.isFinite(verdict.atN) ? verdict.atN : null;
  if (verdict.status === 'verdict_insufficient_population') {
    if (atN === null) {
      throw new Error('TRA-3945: verdict_insufficient_population needs the counted n it is written at (atN)');
    }
    const target = targetFor(state);
    if (atN >= target) {
      throw new Error(`TRA-3945: verdict_insufficient_population refused at n=${atN} >= target ${target}: a full sample is graded pass/fail, never retired as starved`);
    }
  }
  const unexecuted = unexecutedRuledRecuts(state);
  const cutAtVerdict = new Date(state.startedAt).toISOString();
  if (unexecuted.length > 0 && verdict.acknowledgeUnexecutedRecuts !== true) {
    const which = unexecuted
      .map((r) => `${r.rulingRef} -> cut ${new Date(r.candidateStartedAt).toISOString()}`)
      .join('; ');
    throw new Error(
      `TRA-3945: verdict REFUSED - ${unexecuted.length} ruled re-cut(s) unexecuted [${which}] while the record still holds the ${cutAtVerdict} cut. ` +
      'A verdict is once-only AND a graded window can never be re-cut, so writing this terminal now freezes it over a population the ruling says is inadmissible, permanently. ' +
      'Either execute the re-cut first (POST /api/health/otm-evaluation-window/recut), or re-post with acknowledgeUnexecutedRecuts=true to override - the override is RECORDED in the verdict.',
    );
  }
  return {
    ...state,
    verdict: {
      status: verdict.status,
      note: verdict.note,
      by: verdict.by,
      atN,
      at: now,
      acknowledgedUnexecutedRecuts: unexecuted.length === 0
        ? null
        : unexecuted.map((r) => ({
          rulingRef: r.rulingRef,
          candidateStartedAt: new Date(r.candidateStartedAt).toISOString(),
          cutAtVerdict,
        })),
    },
  };
}

// ── Re-cut (a ruled restart of the sample) ──────────────────────────────────

export interface OtmEvaluationRecutPreview extends OtmEvaluationStats {
  candidateStartedAt: string;
  /** Counted n under the cut CURRENTLY persisted, read in the same beat. */
  currentN: number;
  /** currentN − n. Never negative: a forward cut can only remove rows. */
  droppedByRecut: number;
  /** Of the rows the current cut counts, how many entered before the candidate. */
  countedEntriesPredatingCandidate: number;
}

/**
 * What the sample WOULD read under a candidate cut — computed, never stored.
 *
 * The verdict owner cannot answer "does the interim direction survive the
 * correct population?" from outside the box: no route publishes per-row
 * `realizedR` for live rows (they are redacted on `/api/health/option-journal`
 * and `/api/trades/export` is book-scoped to the caller), so the question can
 * only be answered by the process that holds the journal. Publishing the
 * preview is what makes the ruling gradeable before it is executed.
 */
export function previewOtmEvaluationRecut(
  records: ReadonlyArray<CloseRow>,
  state: OtmEvaluationWindowState,
  candidateStartedAt: number,
  now: number,
): OtmEvaluationRecutPreview {
  const current = selectOtmEvaluationCountedCloses(records, state, now).counted;
  const probe: OtmEvaluationWindowState = { ...state, startedAt: candidateStartedAt };
  const counted = selectOtmEvaluationCountedCloses(records, probe, now).counted;
  const stats = otmEvaluationStats(counted.map((r) => ({
    realizedR: r.realizedR as number,
    realizedPnlUsd: r.realizedPnlUsd ?? 0,
  })));
  return {
    candidateStartedAt: new Date(candidateStartedAt).toISOString(),
    ...stats,
    currentN: current.length,
    droppedByRecut: Math.max(0, current.length - stats.n),
    countedEntriesPredatingCandidate: current.filter((r) => r.openTs < candidateStartedAt).length,
  };
}

/**
 * Hand-run only (the re-cut route or the offline script — never the tick).
 *
 * FORWARD ONLY, and that is the whole safety argument: a cut may only move
 * later, so the admitted set can only SHRINK — `n` is a lower bound on the old
 * `n` and `seR` an upper bound, so a re-cut can only make the pre-registered
 * bar HARDER to clear. A backward cut would ADMIT rows the record had already
 * published as refused, which is a re-cut in the permissive direction dressed
 * as a correction; it is refused rather than trusted to judgement.
 *
 * `baseline` and `populationCell` are deliberately NOT recomputed: the baseline
 * is frozen by the verdict owner's ruling ("baseline NEVER recomputed") and the
 * cell is the ruling's cell, not a function of the cut. `extension.used` and
 * the inconclusive terminal DO reset, because both are properties of a full
 * sample and the sample is what just restarted.
 */
export function applyOtmEvaluationRecut(
  state: OtmEvaluationWindowState,
  recut: { startedAt: number; build?: OtmEvaluationBuildPin | null; by: string; note: string; priorN?: number | null },
  now: number,
): OtmEvaluationWindowState {
  if (!/TRA-\d+/.test(recut.note)) {
    throw new Error('TRA-3945: a re-cut note must carry the ruling\'s ticket reference (TRA-nnnn)');
  }
  if (!Number.isFinite(recut.startedAt)) throw new Error('TRA-3945: re-cut startedAt must be a finite epoch ms');
  if (state.startedAt === null) {
    throw new Error('TRA-3945: cannot re-cut a window that never opened - it stamps itself on the liveness predicate');
  }
  if (state.verdict) {
    throw new Error(`TRA-3945: cannot re-cut a graded window (${state.verdict.status} by ${state.verdict.by} at ${new Date(state.verdict.at).toISOString()})`);
  }
  if (recut.startedAt <= state.startedAt) {
    throw new Error(`TRA-3945: a re-cut is FORWARD only - ${new Date(recut.startedAt).toISOString()} is not after the current cut ${new Date(state.startedAt).toISOString()}. A backward cut would ADMIT rows the record already published as refused.`);
  }
  if (recut.startedAt > now) {
    throw new Error(`TRA-3945: re-cut ${new Date(recut.startedAt).toISOString()} is in the future (now ${new Date(now).toISOString()})`);
  }
  const entry: OtmEvaluationRecutEntry = {
    at: now,
    by: recut.by,
    note: recut.note,
    priorStartedAt: state.startedAt,
    priorStartBuild: state.startBuild,
    priorN: typeof recut.priorN === 'number' && Number.isFinite(recut.priorN) ? recut.priorN : null,
    startedAt: recut.startedAt,
    startBuild: recut.build ?? null,
  };
  const history = [...(state.recutHistory ?? []), entry];
  if (history.length > OTM_EVALUATION_RECUT_HISTORY_MAX) history.splice(0, history.length - OTM_EVALUATION_RECUT_HISTORY_MAX);
  return {
    ...state,
    startedAt: recut.startedAt,
    startBuild: recut.build ?? state.startBuild,
    recutHistory: history,
    terminalAt: null,
    extension: { allowed: 1, closes: OTM_EVALUATION_EXTENSION_CLOSES, used: false, usedAt: null },
  };
}

// ── Successor (re-register the pre-registration over a fresh sample) ────────

/**
 * Hand-run only (the successor route — never the tick).
 *
 * The verdict owner's standing call (TRA-4342, 2026-09-04) is "RE-REGISTER a
 * fresh window at the un-hold — never resume n=9 across a regime gap", and the
 * CFO's sequence on TRA-4376 ends the same way. Nothing could write it: the
 * window id was a constant, the loader discarded any other id, a verdict
 * freezes the tick, and a graded window refuses a re-cut. So once w1 is
 * retired, every later OTM close would be graded by no pre-registered rule —
 * the exact failure this ticket exists to prevent.
 *
 * The precondition is the whole safety argument: a successor is refused
 * unless the current window is TERMINAL (a written verdict, or the code's
 * `inconclusive_terminal`). Otherwise re-registering would be an escape hatch
 * from a grade — a live window with a bad interim could be swapped for a
 * fresh one instead of being graded. Retiring stays the verdict owner's act
 * (the verdict route); this only opens the next window after it.
 *
 * The successor inherits the PRE-REGISTRATION only (target, bar, rule, the
 * liveness and cell predicates — all code constants). It is born `armed` with
 * `startedAt: null`, so the ordinary one-shot tick stamps it on its own first
 * all-true tick, freezing its own baseline and cell: no supplied instant, no
 * back-dating. The predecessor is kept verbatim, with its final fold read off
 * the journal in the same beat.
 */
export function applyOtmEvaluationSuccessor(
  state: OtmEvaluationWindowState,
  records: ReadonlyArray<CloseRow>,
  successor: { by: string; note: string },
  now: number,
): OtmEvaluationWindowState {
  if (!/TRA-\d+/.test(successor.note)) {
    throw new Error('TRA-3945: a successor note must carry the registering ticket reference (TRA-nnnn)');
  }
  if (state.startedAt === null) {
    throw new Error(`TRA-3945: ${state.windowId} never opened - there is nothing to succeed`);
  }
  if (!state.verdict && state.terminalAt === null) {
    throw new Error(
      `TRA-3945: successor REFUSED - ${state.windowId} is not terminal (status ${otmEvaluationWindowStatus(state)}). ` +
      'A successor can only follow a graded window; re-registering over a live one would replace a grade with a fresh sample. ' +
      'File the terminal first (POST /api/health/otm-evaluation-window/verdict), then register the successor.',
    );
  }
  const readout = foldOtmEvaluationWindow(records, state, now);
  const predecessor: OtmEvaluationPredecessor = {
    windowId: state.windowId,
    startedAt: state.startedAt,
    startBuild: state.startBuild,
    recutHistory: [...(state.recutHistory ?? [])],
    buildDriftTotal: state.buildDriftTotal,
    extension: { ...state.extension },
    baseline: state.baseline,
    populationCell: state.populationCell,
    terminalAt: state.terminalAt,
    verdict: state.verdict,
    finalReadout: {
      n: readout.n,
      avgR: readout.avgR,
      seR: readout.seR,
      winRate: readout.winRate,
      netUsd: readout.netUsd,
      criteria: readout.criteria,
      lastCloseAt: readout.lastCloseAt,
    },
    retiredAt: now,
    retiredBy: successor.by,
    retiredNote: successor.note,
  };
  const predecessors = [...(state.predecessors ?? []), predecessor];
  if (predecessors.length > OTM_EVALUATION_PREDECESSORS_MAX) {
    predecessors.splice(0, predecessors.length - OTM_EVALUATION_PREDECESSORS_MAX);
  }
  return {
    ...emptyOtmEvaluationWindowState(),
    windowId: nextOtmEvaluationWindowId(state.windowId),
    predecessors,
  };
}

// ── The published record ────────────────────────────────────────────────────

export function buildOtmEvaluationWindowRecord(
  state: OtmEvaluationWindowState,
  liveness: OtmEvaluationLiveness,
  nominationBandIntersects: boolean | null,
  readout: OtmEvaluationReadout,
  /** TRA-3974 — the two post-pin reads. Optional so every existing caller and
   * test keeps its signature; absent ⇒ the keys publish as `null`, which a
   * grader reads as "not deployed", never as "measured and empty". */
  postPin?: {
    costAccumulator: OtmWindowCostAccumulatorRecord;
    entryQuote: OtmEntryQuoteRecord;
  },
  /** TRA-4345 — read-time entry-gate accrual. Defaults to the live env read;
   * `null` = unreadable, which the staleness check publishes as `null`
   * ("check me"), never as `false`. */
  entryAccrual: OtmEntryAccrual | null = readOtmEntryAccrual(),
  /** The ruled-re-cut previews, computed off the journal by the caller. `null`
   * ⇒ not computed in this beat, never "computed and empty". */
  recutPreviews: ReadonlyArray<OtmEvaluationRecutPreview | null> | null = null,
  /**
   * TRA-4610 — the LIVE armed nominator band (`ENABLE_OTM_ADMISSIBLE_STRIKE_SELECT`).
   * `undefined` ⇒ the reach clause is not evaluated this beat (non-binding, so
   * every pre-TRA-4610 caller keeps its behaviour); `null` ⇒ evaluated and
   * UNREADABLE, which fails closed.
   */
  armedSelectorBand?: readonly [number, number] | null,
) {
  const status = otmEvaluationWindowStatus(state);
  // TRA-4610 — the SECOND accrual clause. Computed off the live band in this
  // beat against the frozen cell; never stored, never allowed to move the cell.
  const populationReach = armedSelectorBand === undefined
    ? null
    : assessOtmPopulationReach(state.populationCell, armedSelectorBand);
  // TRA-4345 AC2 — the accused gate is `entry_window`; "still blocking" is the
  // structural predicate (no configured window intersects RTH), computed off
  // live state in this beat, never stored.
  const observedGateStillBlocking: boolean | null =
    entryAccrual === null ? null : entryAccrual.canAccrue === false;
  // Hoisted (TRA-4610) so `insufficientPopulation` can name the clause that is
  // starving the window RIGHT NOW without recomputing the fold. Deliberately
  // NOT folded into `observedGateStillBlocking` above: that field is scoped to
  // the ACCUSED gate (`entry_window`), which has genuinely cleared, and
  // widening it would erase the honest "your diagnosis is stale" signal the
  // record is currently emitting correctly.
  const cadence = otmEvaluationCadence(
    state, readout.n, state.lastTickAt ?? state.startedAt ?? Number.NaN, entryAccrual, populationReach,
  );
  return {
    issue: 'TRA-3945',
    windowId: state.windowId,
    sleeve: OTM_SLEEVE_MANDATE_STRUCTURE,
    ruleRef: OTM_EVALUATION_RULE_REF,
    armUnderTest:
      'trail exit (TRA-3941) + entry windows (TRA-3942 + TRA-3953 dedupe fix) + day-one stop (TRA-3943) + contract floor (TRA-3944)',
    attribution: 'JOINT ONLY - per-item attribution is NOT a test (3941/3942 landed within 27 min on 2026-08-22)',
    status,
    verdictOwner: OTM_EVALUATION_VERDICT_OWNER,
    verdict: state.verdict,
    requiredLive: OTM_EVALUATION_REQUIRED_LIVE,
    livenessPredicate: {
      routing: liveness.routing,
      trailExit: liveness.trailExit,
      entryWindow: liveness.entryWindow,
      dayOneStop: liveness.dayOneStop,
      contractFloor: liveness.contractFloor,
      allTrue: liveness.allTrue,
      falseClauses: liveness.falseClauses,
      reEvaluatedEveryTick: true as const,
    },
    nominationBandIntersects,
    /**
     * TRA-4610 — say WHICH two bands that boolean compares, on the record.
     *
     * It is a LIVE-floor ∩ LIVE-selector read (`otmContractFloorBandIntersects`
     * over `resolveAdmissibleBand`), and both of those bands move. It has never
     * been a statement about the frozen `populationCell` sitting beside it, and
     * on 2026-09-16 it read `true` (live floor [0.25, 0.40] ∩ live selector
     * [0.25, 0.40]) while the frozen cell [0.50, 0.55) was unreachable — the
     * two are about different band PAIRS, both true, and the unlabelled field
     * invited exactly the wrong reading. `populationReach` is the one that
     * answers "can this window's cell still be nominated".
     */
    nominationBandIntersectsMethod:
      'LIVE floor band (TRA-3944 OTM_CONTRACT_FLOOR_DELTA_MIN/MAX) intersected with the LIVE armed selector band (TRA-3401 ENABLE_OTM_ADMISSIBLE_STRIKE_SELECT), both read THIS beat. NOT a statement about the frozen populationCell, whose own bands were captured at frozenAt and may be disjoint from today\'s - for that read populationReach.reachable.',
    /** TRA-4610 — is the FROZEN cell still inside the LIVE armed band? `null` ⇒ clause not evaluated this beat. */
    populationReach,
    startedAt: state.startedAt === null ? null : new Date(state.startedAt).toISOString(),
    startBuild: state.startBuild,
    buildDrift: state.buildDrift.map((s) => ({
      from: new Date(s.from).toISOString(),
      to: s.to === null ? null : new Date(s.to).toISOString(),
      build: s.build,
      falseClauses: s.falseClauses,
    })),
    buildDriftTotal: state.buildDriftTotal,
    lastTickAt: state.lastTickAt === null ? null : new Date(state.lastTickAt).toISOString(),
    lastTickBuild: state.lastTickBuild,
    eligibility:
      'close counts iff entry.openTs >= startedAt AND entry.openTs not inside a paused span AND structure == single_leg_otm AND mode == live AND |entryDelta| inside populationCell (one cell, never pooled)',
    populationCell: state.populationCell === null
      ? null
      : {
        ...state.populationCell,
        frozenAt: state.populationCell.frozenAt === null ? null : new Date(state.populationCell.frozenAt).toISOString(),
        membership: '|entryDelta| >= deltaAbsMin - tolerance AND |entryDelta| < deltaAbsMax + tolerance',
      },
    populationRuling:
      'QuantTrader scope note (TRA-3945 comment 88ccac56): the window measures the ONE |entryDelta| cell that survives card cc2c36fe on TRA-3944 (floor deltaBand ∩ armed selectorBand, frozen at the stamp). Option B => [0.50,0.55); option A => [0.25,0.40] and the window is expected to rest at n=0 (the cost bar refuses those cells on merit) - grade that as insufficient_population, NOT as a passing window. Never pool two cells into one 30-close sample (TRA-2677).',
    dedupe: 'key = brokerOrderId ?? `${account}|${optionSymbol}|${closeTs}`; one representative per key, OTM label preferred. The fallback leg is BOOK-SCOPED (TRA-3945 §3b): its job is to collapse a double-REPORT of one fill, which is always inside one book, so two books closing one contract at one instant with no order id can no longer merge into one observation.',
    clustering: {
      rule: 'AFTER dedupe AND after every eligibility filter: cluster key = `${optionSymbol}|${etDay(openTs)}`; one representative per cluster (earliest openTs, ties on dedupe key). Surplus rows counted under excludedCloses.reasons.sameContractSameSessionCluster.',
      bookAgnostic: true as const,
      derivedFrom: 'entry' as const,
      why: 'seR = sd/sqrt(n) treats closes as independent draws. Two REAL fills of one contract in one ET session are driven by ONE price path: near-equal Rs add to n while adding ~0 to the sum of squares, so seR falls twice over and the 0.10 bar clears earlier than the evidence supports - the PERMISSIVE direction. Observed live 2026-08-24: v0nni 14:25:07Z and admin 14:44:33Z both bought NVTS261002C00012500 from the same generator with DIFFERENT broker order ids, so the report-dedupe key could not see it.',
      entryDerivedBecause: 'The arm under test IS an exit ruleset (trail exit + day-one stop). A cluster keyed on closeTs would let the thing being graded choose its own sample size - two correlated entries exiting on different days would silently de-cluster.',
      bookAgnosticBecause: 'The correlation is one underlying on one session, not a book boundary; two entries of one contract in ONE book on one day are exactly as correlated as two across books. Keying on `account` would also depend on a field documented for the DEMO fold.',
      monotoneConservative: 'The layer only ever REMOVES rows the prior rule admitted - it can never admit one it excluded. n is a lower bound on the old n and seR an upper bound, so the edit can only make the bar HARDER. That asymmetry is what makes it safe to land mid-window.',
      preRegisteredAt: '2026-08-24 while n = 0 - PRE-registration, not a re-cut',
      ruling: 'CEO comment a9f429a9 option (a), generalized. Option (b) - declare cross-book same-contract closes independent - was REFUSED: they are manifestly not independent draws (same underlying, same strike, same expiry, same session, same generator).',
      relatedDefect: 'TRA-2677 (never pool two populations into one sample) arriving through the door TRA-3703 names: a per-book rule times N gate-open books breaks a fleet-level property. Here the fleet-level property is the sample\'s independence, and the fold reads listOptionTradeJournal() UNSCOPED - every gate-open book\'s rows are in the population.',
    },
    rBasis: 'journal realizedR = realizedPnlUsd / atRiskUsd (TRA-375); seR = sample sd (n-1) / sqrt(n)',
    targetCloses: OTM_EVALUATION_TARGET_CLOSES,
    extension: { ...state.extension, usedAt: state.extension.usedAt === null ? null : new Date(state.extension.usedAt).toISOString() },
    inconclusiveTerminalAt: state.terminalAt === null ? null : new Date(state.terminalAt).toISOString(),
    thresholds: {
      seRMax: OTM_EVALUATION_SE_R_MAX,
      passIf: 'avgR > 0 && seR < 0.10',
      failIf: 'avgR <= 0 && seR < 0.10',
      elseExtendOnce: true as const,
      terminalAt: OTM_EVALUATION_TARGET_CLOSES + OTM_EVALUATION_EXTENSION_CLOSES,
      invalidation: {
        cutToZeroNominationsIf: 'over the 30 closes the realized mean R has a lower CI95 below 0',
        estimatorInvalidatedIf:
          'realized mean R lands below barR 0.485 while the tape cell still advertises +1.470 - invalidates the ESTIMATOR, not just the band; a bigger finding than the sleeve',
        barR: 0.485,
        tapeCellAdvertisedR: 1.47,
        lowerCi95: readout.n >= 2 && readout.avgR !== null && readout.seR !== null
          ? round6(readout.avgR - 1.96 * readout.seR)
          : null,
        /** The multiplier the RULE keys on. Fixed at the pre-registration, never re-cut. */
        lowerCi95Method: 'normal, z=1.96 - the pre-registered number; the cutToZeroNominationsIf rule keys on THIS field',
        /**
         * NOT the rule's number. The honest small-sample interval, published
         * beside it so nobody reads a z-interval at single-digit n as if the
         * sample supported it.
         */
        studentT: readout.n >= 2 && readout.avgR !== null && readout.seR !== null
          ? {
            note: 'DESCRIPTIVE ONLY - the pre-registered rule keys on lowerCi95 (z=1.96), not on these. At single-digit n the t interval is materially wider and is the one a reader should quote when characterising the sample.',
            df: readout.n - 1,
            tCritical: tCritical95(readout.n),
            lower: round6(readout.avgR - (tCritical95(readout.n) as number) * readout.seR),
            upper: round6(readout.avgR + (tCritical95(readout.n) as number) * readout.seR),
          }
          : null,
      },
    },
    onFail: 'REPORT ONLY - drop the arm, do not re-tune; QuantTrader files the verdict to the board',
    // ── QuantTrader fd917f86 (2026-08-26) — the starved-population terminal ──
    //
    // The populationRuling above always said "grade that as
    // insufficient_population", and until this build nothing could WRITE it:
    // the verdict set was pass|fail and the only writer was a shell script
    // against the host's data dir, which the verdict owner (an agent) cannot
    // reach. `cadence` is the window's own pace, so the record itself says
    // whether `counting` means gathering evidence or waiting on a gate.
    //
    // TRA-4345 — the 08-26 diagnosis (capital starvation, sumAdmissibleEntryUsd
    // $6.74 vs the $50 floor) went stale while the string sat here: capital
    // cleared to $394.09 and the window stayed starved, by the ENTRY gate. The
    // note now names its gate and its instant, and `observedGateStillBlocking`
    // is recomputed off live state every read so the NEXT supersession declares
    // itself on the wire instead of waiting for a hand re-derivation.
    insufficientPopulation: {
      status: 'verdict_insufficient_population' as const,
      rule: 'hand-written by the verdict owner ONLY while n < targetCloses (a full sample is graded pass/fail, never retired); the note must name the gate that starved the population',
      observed: 'TRA-4342 2026-09-04T02:12Z: starved by the ENTRY GATE, not by capital. otmEntryWindows = 03:00-03:01 ET from env OTM_ENTRY_WINDOWS_ET, openNow false, reasonCode entry_window_closed, appliesTo [paper,live] - a 60s window that does not intersect the 09:30-16:00 ET session, so the forward close rate is structurally 0. entry_window blocked 607/607 (09-02) and 671/671 (09-03); last buy_to_open 09-01. This is the executed form of the board\'s holdyes answer on TRA-4217 card ec5ba87f (human, 2026-09-02T01:21:35Z), not a defect. Capital is NOT binding: sumAdmissibleEntryUsd $394.09 vs a $50 contract floor, fleet bound within, $0 overage. Neither the $500 authorization nor the 30-close bar is what stopped this window.',
      observedAt: '2026-09-04T02:12:00Z',
      observedGate: 'entry_window' as const,
      /** Recomputed at read time from the live entry-window resolution; `null` = unreadable ("check me"), never `false`. */
      observedGateStillBlocking,
      /** TRUE ⇒ the accused gate has CLEARED since `observedAt` — the `observed` diagnosis is superseded; re-diagnose before routing any decision off it. */
      stale: observedGateStillBlocking === null ? null : observedGateStillBlocking === false,
      /**
       * TRA-4610 — the clauses starving the population in THIS beat, whatever
       * the hand-written `observed` note above accuses. `rule` requires that
       * note to name the gate that starved the population; when `stale` is true
       * the accused gate is no longer it, and this is where the writer reads
       * what to name instead. Empty ⇒ nothing structural is blocking accrual
       * and a `verdict_insufficient_population` would need a different reason.
       */
      currentBlockers: cadence?.blockers ?? null,
    },
    // ── TRA-3945 re-cut ─────────────────────────────────────────────────────
    //
    // A ruling that RESTARTS the sample had no writer either. QuantTrader ruled
    // one on 2026-08-25 (`a9753fda`) and reported nothing could execute it: the
    // tick stamps `startedAt` ONCE and never re-stamps, and the only other
    // writer was a shell script on Render's data dir. `satisfied` is computed
    // off the persisted cut, so an unexecuted ruling reads as unexecuted rather
    // than as prose in a thread nobody re-reads. `preview` answers the only
    // question that matters before executing one — what the sample reads under
    // the ruled population — and it is computed at READ time, never frozen.
    recut: {
      currentCut: state.startedAt === null ? null : new Date(state.startedAt).toISOString(),
      monotone: 'FORWARD only: a cut may only move later, so the admitted set can only SHRINK (n a lower bound, seR an upper bound) and a re-cut can only make the pre-registered bar HARDER. A backward cut is refused.',
      preserved: 'baseline and populationCell are NEVER recomputed by a re-cut (the baseline is frozen by ruling; the cell is the ruling\'s cell). extension.used and the inconclusive terminal DO reset - both are properties of a full sample, and the sample is what restarted.',
      writer: 'POST /api/health/otm-evaluation-window/recut (admin) body {startedAt (ISO), build?, by, note with a TRA-nnnn ref}; dry-run by default, apply=true requires confirm=TRA-3945',
      // A re-cut moves THIS record's cut and nothing else. The TRA-3974 cost
      // accumulator's pin is write-once by design (a re-arm is refused and
      // logged; the held pin stands), because its rows come off a ledger whose
      // 30-day retention has already rolled past them and cannot be re-read. So
      // after a re-cut its sample is a strict SUPERSET of the window's — say so
      // on the wire rather than leaving a reader to notice two `startedAt`s.
      costAccumulatorPin: postPin?.costAccumulator?.startedAt ?? null,
      costAccumulatorPinFollowsRecut: false as const,
      costAccumulatorPinNote: 'TRA-3974 pin is write-once and does NOT follow a re-cut. If postPinCost.startedAt is earlier than currentCut, its spreadR/costR sample is a SUPERSET of the counted sample - never cite that p50 beside this avgR without saying the two windows differ.',
      history: (state.recutHistory ?? []).map((h) => ({
        at: new Date(h.at).toISOString(),
        by: h.by,
        note: h.note,
        priorStartedAt: new Date(h.priorStartedAt).toISOString(),
        priorStartBuild: h.priorStartBuild,
        priorN: h.priorN,
        startedAt: new Date(h.startedAt).toISOString(),
        startBuild: h.startBuild,
      })),
      ruled: ruledRecutsFor(state.windowId).map((r, i) => ({
        rulingRef: r.rulingRef,
        ruledAt: r.ruledAt,
        reason: r.reason,
        candidateStartedAt: new Date(r.candidateStartedAt).toISOString(),
        candidateBuild: r.candidateBuild,
        pinSource: r.pinSource,
        /** TRUE ⇒ the persisted cut is at or after the ruled one, i.e. the ruling is IN FORCE on the population. */
        satisfied: state.startedAt === null ? null : state.startedAt >= r.candidateStartedAt,
        preview: recutPreviews?.[i] ?? null,
      })),
    },
    cadence,
    /** TRA-4345 — the effective entry windows the two reads above were computed against, `null` = unreadable. */
    entryAccrual,
    verdictWriter: {
      route: 'POST /api/health/otm-evaluation-window/verdict (admin) body {status, by, note with a TRA-nnnn ref}; dry-run by default, apply=true requires confirm=TRA-3945; atN is read off the fold in the same beat, never supplied',
      statuses: OTM_EVALUATION_VERDICT_STATUSES,
      onceOnly: true as const,
      offlineFallback: 'scripts/tra3945-otm-window-verdict.mjs against the data-dir file (the running process caches the state - a restart is needed for the wire to reflect it)',
      // ── The ordering interlock (2026-09-10) ──────────────────────────────
      //
      // `onceOnly` above and `recut` below compose into a one-way door the
      // record never stated: a verdict can never be rewritten, and a graded
      // window can never be re-cut, so filing the terminal while a ruled
      // re-cut is unexecuted freezes it over the population the ruling calls
      // inadmissible - permanently, with no remedy on either side.
      ordering: 'A ruled re-cut must be EXECUTED (or explicitly overridden) BEFORE any verdict: applyOtmEvaluationRecut refuses a graded window and a verdict is once-only, so the verdict is a one-way door over whichever cut is current when it lands.',
      /** Non-empty ⇒ the writer refuses without `acknowledgeUnexecutedRecuts: true`. */
      blockedByUnexecutedRecut: unexecutedRuledRecuts(state).map((r) => ({
        rulingRef: r.rulingRef,
        candidateStartedAt: new Date(r.candidateStartedAt).toISOString(),
        currentCut: state.startedAt === null ? null : new Date(state.startedAt).toISOString(),
      })),
      override: 'body {acknowledgeUnexecutedRecuts: true} - the grader keeps the decision; the override is RECORDED in verdict.acknowledgedUnexecutedRecuts so the record says forever which population the terminal was written over',
    },
    // ── TRA-3945 successor (2026-09-10) ─────────────────────────────────────
    //
    // The verdict owner's standing call is to RE-REGISTER a fresh window at the
    // un-hold rather than resume a sample across the regime gap. There was no
    // writer for that either: a verdict froze the one window for good.
    successor: {
      writer: 'POST /api/health/otm-evaluation-window/successor (admin) body {by, note with a TRA-nnnn ref}; dry-run by default, apply=true requires confirm=TRA-3945',
      precondition: 'the current window must be TERMINAL (a written verdict, or inconclusive_terminal). A successor never retires a live window - that would replace a grade with a fresh sample.',
      ordering: 'retire THEN register: (1) any ruled re-cut, (2) the verdict, (3) the successor - all three before the next entry window opens, or closes that enter in between land in the retired window (its fold does not stop at the verdict).',
      /** TRUE ⇒ the writer would accept a successor now. */
      available: state.startedAt !== null && (state.verdict !== null || state.terminalAt !== null),
      nextWindowId: isOtmEvaluationWindowId(state.windowId) ? nextOtmEvaluationWindowId(state.windowId) : null,
      inherits: 'the pre-registration only: targetCloses, the seR bar, the TRA-375 rule, the liveness and population-cell predicates. NOT n, startedAt, baseline or the frozen cell - the successor stamps its own on its first all-true tick, exactly as w1 did. Ruled re-cuts stay with the window they were ruled on.',
      costAccumulatorFollowsSuccessor: false as const,
      costAccumulatorNote: 'The TRA-3974 cost accumulator is one write-once pin. A successor does not re-key it, so postPinCost.windowId names the window it was armed for; while that differs from windowId its sample is a SUPERSET of this window - never cite its p50 beside this avgR.',
      predecessors: (state.predecessors ?? []).map((p) => ({
        windowId: p.windowId,
        startedAt: p.startedAt === null ? null : new Date(p.startedAt).toISOString(),
        startBuild: p.startBuild,
        recutHistory: p.recutHistory.map((h) => ({
          at: new Date(h.at).toISOString(),
          by: h.by,
          note: h.note,
          priorStartedAt: new Date(h.priorStartedAt).toISOString(),
          priorN: h.priorN,
          startedAt: new Date(h.startedAt).toISOString(),
        })),
        buildDriftTotal: p.buildDriftTotal,
        baseline: p.baseline,
        populationCell: p.populationCell,
        terminalAt: p.terminalAt === null ? null : new Date(p.terminalAt).toISOString(),
        verdict: p.verdict,
        finalReadout: {
          ...p.finalReadout,
          lastCloseAt: p.finalReadout.lastCloseAt === null ? null : new Date(p.finalReadout.lastCloseAt).toISOString(),
        },
        retiredAt: new Date(p.retiredAt).toISOString(),
        retiredBy: p.retiredBy,
        retiredNote: p.retiredNote,
      })),
    },
    baseline: state.baseline,
    n: readout.n,
    avgR: readout.avgR,
    seR: readout.seR,
    winRate: readout.winRate,
    netUsd: readout.netUsd,
    closesRemaining: readout.closesRemaining,
    lastCloseAt: readout.lastCloseAt === null ? null : new Date(readout.lastCloseAt).toISOString(),
    criteria: readout.criteria,
    excludedCloses: readout.excludedCloses,
    secondary: readout.secondary,
    // ── TRA-3974 ────────────────────────────────────────────────────────────
    //
    // QuantTrader's comment `949f1e13` pre-registered two in-band
    // contract-quality reads on the note that "the recorder already accrues".
    // It accrues, but `/api/health/live-enforce-gates` cannot be RESTRICTED to
    // post-pin rows (no query params; one self-clearing ET day plus a 30-day
    // rolling fold), cannot be reconstructed by differencing daily snapshots
    // (counters subtract, QUANTILES DO NOT), and does not SURVIVE the window
    // (RETAIN_MS is 30 days against a ~9 calendar-week window, so its first
    // half ages out before its last close lands).
    //
    // These two blocks are the read paths that make the pre-registration
    // executable. Both are additive and read-only: they gate nothing, block no
    // order, and touch neither `otmArmed`, the row size, the 2-row cap, the
    // `populationCell`, nor the verdict rule above.
    postPinCost: postPin?.costAccumulator ?? null,
    entryQuote: postPin?.entryQuote ?? null,
    postPinReadsIssue: 'TRA-3974' as const,
    preRegisteredCaveat:
      'On our own tape the entry window has no supporting evidence - it would have admitted 1 of 15 live OTM closes, and the 14 it refuses carry +$758 / +0.137R while the 1 it admits carries -$79 / -0.223R (n=1, confounded with the retired chandelier exit, estimates nothing). The window is justified mechanically, not empirically. If the joint arm underperforms, the entry window is the FIRST component to re-examine.',
  };
}

export type OtmEvaluationWindowRecord = ReturnType<typeof buildOtmEvaluationWindowRecord>;

// ── Persistence ─────────────────────────────────────────────────────────────

let storeFileOverride: string | null = null;
let cache: OtmEvaluationWindowState | null = null;

function storeFile(): string {
  return storeFileOverride ?? join(resolveDataDir(), 'otm-evaluation-window.json');
}

/** Test seam — point the state at a temp file. Pass `null` to restore default. */
export function setOtmEvaluationWindowFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}

export async function loadOtmEvaluationWindowState(): Promise<OtmEvaluationWindowState> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(storeFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<OtmEvaluationWindowState>;
    // Any id in the family: a successor's file must survive a restart. Discarding
    // it would start an EMPTY w1 that the next tick stamps and saves over it.
    if (parsed && parsed.version === 1 && isOtmEvaluationWindowId(parsed.windowId)) {
      cache = { ...emptyOtmEvaluationWindowState(), ...parsed };
      return cache;
    }
    log.warn('TRA-3945 window state file unrecognised; starting empty', { file: storeFile() });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      log.warn('TRA-3945 window state read failed; starting empty', {
        file: storeFile(), reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = emptyOtmEvaluationWindowState();
  return cache;
}

export async function saveOtmEvaluationWindowState(state: OtmEvaluationWindowState): Promise<void> {
  cache = state;
  const file = storeFile();
  const tmp = `${file}.tmp`;
  await fs.mkdir(join(file, '..'), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/**
 * The one entry point the server calls — from the 60s tick AND from the
 * health read, so a read is also a tick. Steps the state, persists on a
 * transition, and returns the published record.
 */
export async function tickOtmEvaluationWindow(args: {
  inputs: OtmEvaluationLivenessInputs;
  pin: OtmEvaluationBuildPin;
  records: ReadonlyArray<CloseRow>;
  nominationBandIntersects: boolean | null;
  now?: number;
}): Promise<OtmEvaluationWindowRecord> {
  const now = args.now ?? Date.now();
  const liveness = evaluateOtmEvaluationLiveness(args.inputs);
  const prev = await loadOtmEvaluationWindowState();
  const { state, changed } = stepOtmEvaluationWindow(
    prev, liveness, args.pin, args.records, now, args.inputs.otmContractFloor,
  );
  if (changed) {
    try {
      await saveOtmEvaluationWindowState(state);
    } catch (err) {
      log.error('TRA-3945 window state persist FAILED (in-memory state kept)', {
        reason: err instanceof Error ? err.message : String(err),
      });
      cache = state;
    }
  } else {
    cache = state;
  }
  const readout = foldOtmEvaluationWindow(args.records, state, now);
  const postPin = tickOtmWindowPostPinReads(state, args.records, now);
  // Wrapped: a preview is an instrument over the record, and an instrument may
  // never take its subject off the wire.
  let recutPreviews: Array<OtmEvaluationRecutPreview | null> | null = null;
  try {
    recutPreviews = ruledRecutsFor(state.windowId).map((r) =>
      state.startedAt === null ? null : previewOtmEvaluationRecut(args.records, state, r.candidateStartedAt, now));
  } catch (err) {
    log.warn('TRA-3945 re-cut preview failed; the record still publishes', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  // TRA-4610 — the live armed nominator band travels on the SAME inputs the
  // liveness predicate and the cell stamp already read, so the reach clause can
  // never be computed against a band the rest of the record did not see.
  // `null` (present but unreadable) fails closed; the key is always supplied so
  // the clause is always evaluated on this path.
  const sb = args.inputs.otmContractFloor?.selectorBand;
  const armedSelectorBand: readonly [number, number] | null =
    sb && Number.isFinite(sb[0]) && Number.isFinite(sb[1]) ? [sb[0], sb[1]] : null;
  return buildOtmEvaluationWindowRecord(
    state, liveness, args.nominationBandIntersects, readout, postPin, readOtmEntryAccrual(), recutPreviews,
    armedSelectorBand,
  );
}

/**
 * TRA-3974 — the post-pin reads, driven off the SAME tick as the window itself.
 *
 * Arming is idempotent and happens here rather than at the stamp so that a
 * build which ships the accumulator AFTER the window has already opened still
 * arms on its first tick — it just arms late, and `armLagMs` on the published
 * record says by how much. (The alternative — arming only inside the one-shot
 * stamp branch — would leave a window opened by an earlier build permanently
 * uninstrumented, silently.)
 *
 * Every step is wrapped: this is an instrument hanging off a record that a
 * live-money desk reads, and an instrument may never take its subject down.
 */
function tickOtmWindowPostPinReads(
  state: OtmEvaluationWindowState,
  records: ReadonlyArray<CloseRow>,
  now: number,
): { costAccumulator: OtmWindowCostAccumulatorRecord; entryQuote: OtmEntryQuoteRecord } | undefined {
  try {
    ensureOtmWindowCostSubscription();
    loadOtmWindowCostAccumulator(state.windowId);
    const cell = state.populationCell;
    // The pin is write-once. Once it is held for a different cut (a re-cut or a
    // successor), offering the new one is a known refusal already published on
    // the wire (`recut.costAccumulatorPin`, `postPinCost.windowId`) - do not
    // re-log it at error level on every 60s tick.
    const held = peekOtmWindowCostAccumulatorState();
    const heldElsewhere = held !== null && held.startedAt !== null && held.startedAt !== state.startedAt;
    if (state.startedAt !== null && cell && cell.frozen && !heldElsewhere) {
      armOtmWindowCostAccumulator({
        windowId: state.windowId,
        startedAt: state.startedAt,
        band: { deltaAbsMin: cell.deltaAbsMin, deltaAbsMax: cell.deltaAbsMax },
        now,
      });
    }
    flushOtmWindowCostAccumulator(now);
    const costAccumulator = buildOtmWindowCostAccumulatorRecord(peekOtmWindowCostAccumulatorState(), now);

    const journalRows = records as ReadonlyArray<OtmEntryQuoteInputRow>;
    const allLiveRows = selectLiveOtmRows(journalRows);
    const postPinRows =
      state.startedAt === null ? null : selectLiveOtmRows(journalRows, { sinceOpenTs: state.startedAt });
    // The split runs over the window's OWN counted closes — not over a
    // re-derived "post-pin live OTM" set, which would quietly include the rows
    // the record excludes (paused spans, wrong delta cell, duplicates).
    const counted = selectOtmEvaluationCountedCloses(records, state, now).counted;
    const entryQuote = buildOtmEntryQuoteRecord({
      allLiveRows,
      postPinRows,
      startedAt: state.startedAt,
      countedCloses: counted.map((r) => buildOtmEntryQuoteRow(r as OtmEntryQuoteInputRow)),
    });
    return { costAccumulator, entryQuote };
  } catch (err) {
    log.warn('TRA-3974 post-pin reads failed; the TRA-3945 record still publishes', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
