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

export type OtmEvaluationWindowStatus =
  | 'armed'
  | 'counting'
  | 'paused'
  | 'extended'
  | 'inconclusive_terminal'
  | 'verdict_pass'
  | 'verdict_fail';

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
  status: 'verdict_pass' | 'verdict_fail';
  /** Must carry the grader's ticket reference. */
  note: string;
  at: number;
  by: string;
}

/** The persisted part. Everything else is derived on read. */
export interface OtmEvaluationWindowState {
  version: 1;
  windowId: string;
  startedAt: number | null;
  startBuild: OtmEvaluationBuildPin | null;
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

export interface OtmEvaluationSecondaryCell extends OtmEvaluationStats {}

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

/** Hand-run only. Refuses a note without a ticket reference. */
export function applyOtmEvaluationVerdict(
  state: OtmEvaluationWindowState,
  verdict: { status: 'verdict_pass' | 'verdict_fail'; note: string; by: string },
  now: number,
): OtmEvaluationWindowState {
  if (!/TRA-\d+/.test(verdict.note)) {
    throw new Error('TRA-3945: a verdict note must carry the grader\'s ticket reference (TRA-nnnn)');
  }
  if (state.startedAt === null) throw new Error('TRA-3945: cannot write a verdict on a window that never opened');
  return { ...state, verdict: { ...verdict, at: now } };
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
) {
  const status = otmEvaluationWindowStatus(state);
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
      },
    },
    onFail: 'REPORT ONLY - drop the arm, do not re-tune; QuantTrader files the verdict to the board',
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
    if (parsed && parsed.version === 1 && parsed.windowId === OTM_EVALUATION_WINDOW_ID) {
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
  return buildOtmEvaluationWindowRecord(
    state, liveness, args.nominationBandIntersects, readout, postPin,
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
    if (state.startedAt !== null && cell && cell.frozen) {
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
