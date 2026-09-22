// TRA-4653 — Post-Trade Intelligence: the per-trade review record.
//
// Everything this module reports ALREADY EXISTS somewhere in the stack —
// the option trade journal holds the fills, the running MAE (TRA-3946) and
// the MFE peak (TRA-4020); the decision audit log (TRA-4658) holds the
// verdict trail with the positionId↔signalId link stamped on every booked
// fill; the trade opportunity card (TRA-4649) holds the thesis and the cost
// ESTIMATE the fill is graded against; the crossed re-pricing (TRA-4674)
// holds the honest exit. What did NOT exist is the JOIN: one record per
// trade that answers "what did we believe at entry, what happened on the
// path, what did it actually cost, and which rules bent" — keyed by
// position id / card id so it can feed the TRA-4779 calibration fold.
//
// Posture (house rules):
//   • Pure assembly. This module places no orders, mutates no ledger, and
//     never throws on a malformed row — a review is built for EVERY journal
//     row BY CONSTRUCTION, and every join that could not be made is a named
//     count in the summary, never a dropped row. That fold is the acceptance
//     instrument for "full automated journal for every paper and live trade":
//     the denominator is the journal, and a broken join reads as a nonzero
//     `missing` cell, not as a shorter list.
//   • Absent ≠ 0. An unknown slippage leg, an unstamped MFE instant, a card
//     that fell off the ring — all stay null with a reason beside them.
//   • The audit log started existing on 2026-09-18 (TRA-4658) and the card
//     ring is in-memory: rows older than either will legitimately miss those
//     joins. That is a property of the row's era, measured and counted — the
//     builder must not manufacture a thesis it never had.

import type { OptionTradeJournalRecord, OptionTradeJournalMae } from './option-trade-journal.js';
import type { DecisionAuditEvent } from './decision-audit-log.js';
import type { TradeOpportunityCard } from './trade-opportunity-card.js';
import {
  priceCrossedRow,
  CROSSED_LONG_PREMIUM_STRUCTURES,
  type CrossedUnpricedReason,
} from './option-crossed-pnl.js';
import type { SetupOutcomeRecord } from './setup-calibration.js';

// ── Small helpers ───────────────────────────────────────────────────────────

const fin = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;
const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;
const roundCents = (v: number): number => Math.round(v * 100) / 100;

// ── Record shape ────────────────────────────────────────────────────────────

export type ReviewViolationKind =
  /** An operator/agent hand touched this position (audit `intervention`). */
  | 'manual_intervention'
  /** A book-level halt/lockout/kill transition landed inside the hold. */
  | 'book_halt_during_hold'
  /** Exit filled >10% through the planned stop premium (long premium only). */
  | 'exit_below_planned_stop'
  /** A LIVE row opened with no hard-controls admission stamp while armed. */
  | 'unadmitted_live_open';

export interface PostTradeRuleViolation {
  kind: ReviewViolationKind;
  atMs: number | null;
  source: 'audit' | 'journal';
  /** Human-readable what/why, straight off the source record. */
  detail: string;
  /** Measured magnitude where one exists (e.g. stop-overrun fraction). */
  severity: number | null;
}

export interface PostTradeJoin {
  /** From the audit `fill_booked` event for this positionId; null + reason. */
  signalId: string | null;
  /** == signalId iff a card was actually found for it. */
  cardId: string | null;
  auditFillSeq: number | null;
  auditExitSeq: number | null;
  /** Named joins that could NOT be made — the summary folds these. */
  missing: string[];
}

export interface PostTradeSlippage {
  /** Card estimate: round-trip cost in the trade's own R units (TRA-3483 arithmetic). */
  expectedCostR: number | null;
  /** Measured mark-vs-fill legs off the journal row; null = never measured, NOT 0. */
  realizedEntryUsd: number | null;
  realizedExitUsd: number | null;
  /** Sum of the two legs — only when BOTH were measured. */
  realizedRoundTripUsd: number | null;
  /** realizedRoundTripUsd / atRiskUsd — same divisor as realizedR. */
  realizedCostR: number | null;
  /** realized − expected, only when both sides exist. Positive = worse than estimated. */
  deltaR: number | null;
  /** Why any side above is null. */
  reason: string | null;
}

export interface PostTradeExcursion {
  /** TRA-3946 verbatim: min mark vs ORIGINAL basis while open. */
  mae: OptionTradeJournalMae | null;
  /** TRA-4020: the peak mark and (when observed) its instant. */
  mfePeakPremium: number | null;
  mfePeakAt: number | null;
  mfePeakStamp: string | null;
  /** peak / basis − 1, when a basis is resolvable. */
  mfeFracOfBasis: number | null;
  /** Which premium the MFE fraction was taken against. */
  mfeBasisSource: 'mae_basis' | 'entry_basis' | 'entry_fill' | null;
  /**
   * (peak − exitFill) / (peak − basis): how much of the open profit the exit
   * rule gave back. Only when the row closed, peak > basis, and the exit fill
   * is known — otherwise null, never 0.
   */
  giveBackFrac: number | null;
}

export interface PostTradeReview {
  schemaVersion: 1;
  /** THE key — the journal row id (== audit positionId on the fill event). */
  positionId: string;
  brokerOrderId: string | number | null;
  mode: 'demo' | 'live';
  symbol: string;
  optionSymbol: string | null;
  structure: string;
  entryArchetype: string | null;
  /** Setup identity for the TRA-4779 fold — audit fill `strategy`, else card. */
  setupKey: string | null;
  setupKeySource: 'audit' | 'card' | null;
  status: 'open' | 'closed';
  openTs: number;
  closeTs: number | null;
  holdMs: number | null;
  exitReason: string | null;
  contracts: number | null;
  atRiskUsd: number;
  entry: {
    fillPremium: number | null;
    bid: number | null;
    ask: number | null;
    spreadPct: number | null;
  };
  exit: { fillPremium: number | null };
  pnl: {
    realizedUsd: number | null;
    realizedR: number | null;
    /** TRA-4674 re-pricing at the cross; null + reason, never 0. */
    crossedUsd: number | null;
    crossedR: number | null;
    crossedUnpriced: CrossedUnpricedReason | null;
    feesUsd: number | null;
  };
  excursion: PostTradeExcursion;
  slippage: PostTradeSlippage;
  /** The thesis AT ENTRY — the TRA-4649 card, verbatim, when still reachable. */
  thesis: TradeOpportunityCard | null;
  thesisUnavailableReason: string | null;
  join: PostTradeJoin;
  ruleViolations: PostTradeRuleViolation[];
  /** Checks that could not run at all (vs. ran and found nothing). */
  violationChecksNotEvaluable: string[];
}

// ── Build context ───────────────────────────────────────────────────────────

export interface PostTradeReviewContext {
  /**
   * Pre-queried audit window (queryDecisionAudit). Absent ⇒ every audit join
   * is recorded missing with reason `no_audit_events_supplied` — distinct
   * from "queried and no fill event matched".
   */
  auditEvents?: readonly DecisionAuditEvent[];
  /** Card lookup (the live ring). Absent ⇒ thesis join not attempted. */
  cardForSignal?: (signalId: string) => TradeOpportunityCard | null | undefined;
  /**
   * When the hard-controls choke point has been LIVE since (ms epoch) — the
   * `unadmitted_live_open` check only runs for live rows opened after this.
   * Null/absent ⇒ the check is recorded not-evaluable, never guessed.
   */
  hardControlsLiveSinceMs?: number | null;
  nowMs?: number;
}

/** Exit fills >10% through the planned stop are flagged; at/above is discipline. */
export const STOP_OVERRUN_VIOLATION_FRAC = 0.10;

// ── Per-row assembly ────────────────────────────────────────────────────────

function resolveMfe(
  row: OptionTradeJournalRecord,
  exitFill: number | null,
): PostTradeExcursion {
  const peak = fin(row.peakPremium);
  const basisFromMae = fin(row.mae?.basisPremium);
  const basisFromClose = fin(row.entryBasisPremium);
  const basisFromFill = fin(row.entryFillPremium);
  const basis = basisFromMae ?? basisFromClose ?? basisFromFill;
  const basisSource: PostTradeExcursion['mfeBasisSource'] =
    basisFromMae !== null ? 'mae_basis'
      : basisFromClose !== null ? 'entry_basis'
        : basisFromFill !== null ? 'entry_fill'
          : null;
  const mfeFrac =
    peak !== null && basis !== null && basis > 0 ? round4(peak / basis - 1) : null;
  // Give-back is only meaningful when there WAS open profit and the exit fill
  // is a real number: (peak − exit) / (peak − basis).
  const giveBack =
    peak !== null && basis !== null && exitFill !== null && peak > basis
      ? round4((peak - exitFill) / (peak - basis))
      : null;
  return {
    mae: row.mae ?? null,
    mfePeakPremium: peak,
    mfePeakAt: fin(row.peakPremiumAt),
    mfePeakStamp: str(row.peakPremiumStamp),
    mfeFracOfBasis: mfeFrac,
    mfeBasisSource: peak !== null ? basisSource : null,
    giveBackFrac: giveBack,
  };
}

function resolveSlippage(
  row: OptionTradeJournalRecord,
  card: TradeOpportunityCard | null,
): PostTradeSlippage {
  const expected = card ? fin(card.fields.costs.data?.costR) : null;
  const entryLeg = fin(row.entrySlippageUsd);
  const exitLeg = fin(row.exitSlippageUsd);
  const roundTrip =
    entryLeg !== null && exitLeg !== null ? roundCents(entryLeg + exitLeg) : null;
  const atRisk = fin(row.atRiskUsd);
  const realizedR =
    roundTrip !== null && atRisk !== null && atRisk > 0
      ? round4(roundTrip / atRisk)
      : null;
  const delta =
    realizedR !== null && expected !== null ? round4(realizedR - expected) : null;
  let reason: string | null = null;
  if (delta === null) {
    if (expected === null && realizedR === null) reason = 'neither_side_measurable';
    else if (expected === null) reason = card === null ? 'no_card_for_estimate' : 'card_costs_incomplete';
    else if (roundTrip === null) {
      reason = entryLeg === null && exitLeg === null ? 'no_slippage_legs_measured'
        : entryLeg === null ? 'entry_leg_not_measured' : 'exit_leg_not_measured';
    } else reason = 'at_risk_unusable';
  }
  return {
    expectedCostR: expected,
    realizedEntryUsd: entryLeg,
    realizedExitUsd: exitLeg,
    realizedRoundTripUsd: roundTrip,
    realizedCostR: realizedR,
    deltaR: delta,
    reason,
  };
}

/** Assemble the review for ONE journal row. Never throws; joins fail to counted nulls. */
export function buildPostTradeReview(
  row: OptionTradeJournalRecord,
  ctx: PostTradeReviewContext = {},
): PostTradeReview {
  const nowMs = ctx.nowMs ?? Date.now();
  const closed = row.outcome !== 'OPEN';
  const closeTs = closed ? fin(row.closeTs) : null;
  const missing: string[] = [];
  const notEvaluable: string[] = [];

  // — audit join: the fill event is the positionId → signalId bridge —
  let fillEvent: DecisionAuditEvent | null = null;
  let exitEvent: DecisionAuditEvent | null = null;
  if (ctx.auditEvents === undefined) {
    missing.push('no_audit_events_supplied');
  } else {
    fillEvent = ctx.auditEvents.find(
      e => e.category === 'order' && e.action === 'fill_booked' && e.positionId === row.id,
    ) ?? null;
    exitEvent = ctx.auditEvents.find(
      e => e.category === 'exit' && e.positionId === row.id,
    ) ?? null;
    if (fillEvent === null) missing.push('no_audit_fill_event');
  }
  const signalId = fillEvent ? str(fillEvent.signalId) : null;
  if (fillEvent && signalId === null) missing.push('fill_event_missing_signal_id');

  // — thesis join: the card, when the ring still holds it —
  let card: TradeOpportunityCard | null = null;
  let thesisUnavailableReason: string | null = null;
  if (signalId === null) {
    thesisUnavailableReason = ctx.auditEvents === undefined
      ? 'no_audit_events_supplied'
      : 'no_signal_id_join';
  } else if (ctx.cardForSignal === undefined) {
    thesisUnavailableReason = 'no_card_lookup_supplied';
    missing.push('no_card_lookup_supplied');
  } else {
    card = ctx.cardForSignal(signalId) ?? null;
    if (card === null) {
      thesisUnavailableReason = 'card_evicted_or_never_carded';
      missing.push('card_evicted_or_never_carded');
    }
  }

  const setupFromAudit = fillEvent ? str(fillEvent.strategy) : null;
  const setupKey = setupFromAudit ?? (card ? str(card.signalType) : null);
  const setupKeySource: PostTradeReview['setupKeySource'] =
    setupFromAudit !== null ? 'audit' : setupKey !== null ? 'card' : null;

  const exitFill = fin(row.exitFillPremium);
  const crossed = priceCrossedRow(row);

  // — rule violations —
  const violations: PostTradeRuleViolation[] = [];
  const holdEndMs = closeTs ?? nowMs;
  if (ctx.auditEvents === undefined) {
    notEvaluable.push('manual_intervention', 'book_halt_during_hold');
  } else {
    for (const e of ctx.auditEvents) {
      if (e.category === 'intervention'
        && (e.positionId === row.id
          || (e.symbol === row.symbol && e.atMs >= row.openTs && e.atMs <= holdEndMs))) {
        violations.push({
          kind: 'manual_intervention',
          atMs: e.atMs,
          source: 'audit',
          detail: `${e.action}/${e.outcome}${e.actor ? ` by ${e.actor}` : ''}${e.reason ? `: ${e.reason}` : ''}`,
          severity: null,
        });
      } else if (e.category === 'state_change'
        && e.atMs >= row.openTs && e.atMs <= holdEndMs) {
        violations.push({
          kind: 'book_halt_during_hold',
          atMs: e.atMs,
          source: 'audit',
          detail: `${e.action}/${e.outcome}${e.reason ? `: ${e.reason}` : ''}`,
          severity: null,
        });
      }
    }
  }
  // Stop discipline: only where "down through the stop" has one sign (long
  // premium), and only off a real planned stop and a real exit fill.
  const plannedStop = fillEvent
    ? fin((fillEvent.detail as Record<string, unknown> | null)?.['plannedStopPremium'])
    : null;
  if (!closed || !CROSSED_LONG_PREMIUM_STRUCTURES.has(row.structure)) {
    // No exit yet, or a structure where the check's sign convention is wrong.
  } else if (plannedStop === null || exitFill === null) {
    notEvaluable.push('exit_below_planned_stop');
  } else if (plannedStop > 0 && exitFill < plannedStop) {
    const overrun = round4((plannedStop - exitFill) / plannedStop);
    if (overrun > STOP_OVERRUN_VIOLATION_FRAC) {
      violations.push({
        kind: 'exit_below_planned_stop',
        atMs: closeTs,
        source: 'journal',
        detail: `exit fill ${exitFill} vs planned stop ${plannedStop} (${Math.round(overrun * 100)}% through)`,
        severity: overrun,
      });
    }
  }
  // Admission discipline: a LIVE open after the choke point went live must
  // carry the TRA-4655 admission stamp.
  const armedSince = ctx.hardControlsLiveSinceMs;
  if (armedSince === null || armedSince === undefined) {
    notEvaluable.push('unadmitted_live_open');
  } else if (row.mode === 'live' && row.openTs >= armedSince && row.admission === undefined) {
    violations.push({
      kind: 'unadmitted_live_open',
      atMs: row.openTs,
      source: 'journal',
      detail: 'live row opened with no hard-controls admission stamp while the choke point was live',
      severity: null,
    });
  }

  return {
    schemaVersion: 1,
    positionId: row.id,
    brokerOrderId: row.brokerOrderId ?? null,
    mode: row.mode,
    symbol: row.symbol,
    optionSymbol: str(row.optionSymbol),
    structure: row.structure,
    entryArchetype: str(row.entryArchetype),
    setupKey,
    setupKeySource,
    status: closed ? 'closed' : 'open',
    openTs: row.openTs,
    closeTs,
    holdMs: closeTs !== null ? closeTs - row.openTs : null,
    exitReason: closed ? str(row.exitReason) : null,
    contracts: fin(row.contractsAtClose) ?? fin(row.contracts),
    atRiskUsd: row.atRiskUsd,
    entry: {
      fillPremium: fin(row.entryFillPremium),
      bid: fin(row.entryBidAtOpen) ?? fin(row.entryBid),
      ask: fin(row.entryAskAtOpen) ?? fin(row.entryAsk),
      spreadPct: fin(row.entrySpreadPct),
    },
    exit: { fillPremium: exitFill },
    pnl: {
      realizedUsd: closed ? fin(row.realizedPnlUsd) : null,
      realizedR: closed ? fin(row.realizedR) : null,
      crossedUsd: crossed.crossedPnlUsd,
      crossedR: crossed.crossedR,
      crossedUnpriced: crossed.crossedUnpriced,
      feesUsd: fin(row.feesUsd),
    },
    excursion: resolveMfe(row, exitFill),
    slippage: resolveSlippage(row, card),
    thesis: card,
    thesisUnavailableReason,
    join: {
      signalId,
      cardId: card ? card.signalId : null,
      auditFillSeq: fillEvent ? fillEvent.seq : null,
      auditExitSeq: exitEvent ? exitEvent.seq : null,
      missing,
    },
    ruleViolations: violations,
    violationChecksNotEvaluable: notEvaluable,
  };
}

// ── TRA-4779 feed: review → SetupOutcomeRecord ─────────────────────────────

export interface CalibrationFeedResult {
  record: SetupOutcomeRecord | null;
  /** Why no record was emitted; null iff `record` is non-null. */
  excludedReason: string | null;
}

/**
 * Adapt one review into the calibration fold's input row. Cost provenance:
 * `sampled` = both slippage legs AND fees were measured off real fills;
 * `modelled` = the TRA-4674 crossed re-pricing (booked − crossed spread drag);
 * null = uncharged — setup-calibration excludes AND counts those itself.
 */
export function toSetupOutcomeRecord(review: PostTradeReview): CalibrationFeedResult {
  if (review.status !== 'closed') return { record: null, excludedReason: 'open_row' };
  if (review.setupKey === null) return { record: null, excludedReason: 'setup_unknown' };
  if (review.closeTs === null) return { record: null, excludedReason: 'close_ts_missing' };

  let costR: number | null = null;
  let costSource: SetupOutcomeRecord['costSource'] = null;
  const fees = review.pnl.feesUsd;
  if (
    review.slippage.realizedRoundTripUsd !== null
    && fees !== null
    && review.atRiskUsd > 0
  ) {
    costR = round4((review.slippage.realizedRoundTripUsd + fees) / review.atRiskUsd);
    costSource = 'sampled';
  } else if (
    review.pnl.crossedUsd !== null
    && review.pnl.realizedUsd !== null
    && review.atRiskUsd > 0
  ) {
    // Spread drag the mark-booked P&L never paid: booked − crossed.
    costR = round4((review.pnl.realizedUsd - review.pnl.crossedUsd) / review.atRiskUsd);
    costSource = 'modelled';
  }

  const conf = review.thesis?.confidence ?? null;
  return {
    record: {
      setupKey: review.setupKey,
      closedAt: review.closeTs,
      grossR: review.pnl.realizedR,
      costR,
      costSource,
      predictedRR: review.thesis
        ? fin(review.thesis.fields.targets.data?.rewardRiskRecomputed)
        : null,
      predictedWinProb: conf ? round4(conf.displayWinRatePct / 100) : null,
      // Regime AT ENTRY is not reconstructable post hoc from what the row
      // carries — null until a regime stamp exists at open time.
      regime: null,
    },
    excludedReason: null,
  };
}

// ── The fold (the acceptance instrument) ────────────────────────────────────

export interface PostTradeReviewSummary {
  total: number;
  open: number;
  closed: number;
  byMode: Record<string, number>;
  joins: {
    withAuditFill: number;
    withSignalId: number;
    withThesis: number;
    missingByReason: Record<string, number>;
  };
  excursion: { withMae: number; withMfe: number };
  slippage: {
    comparable: number;
    meanDeltaR: number | null;
    unresolvedByReason: Record<string, number>;
  };
  violations: { rowsWithAny: number; byKind: Record<string, number> };
  calibrationFeed: { emitted: number; charged: number; excludedByReason: Record<string, number> };
}

export function summarizePostTradeReviews(
  reviews: readonly PostTradeReview[],
): PostTradeReviewSummary {
  const bump = (rec: Record<string, number>, key: string): void => {
    rec[key] = (rec[key] ?? 0) + 1;
  };
  const summary: PostTradeReviewSummary = {
    total: reviews.length,
    open: 0,
    closed: 0,
    byMode: {},
    joins: { withAuditFill: 0, withSignalId: 0, withThesis: 0, missingByReason: {} },
    excursion: { withMae: 0, withMfe: 0 },
    slippage: { comparable: 0, meanDeltaR: null, unresolvedByReason: {} },
    violations: { rowsWithAny: 0, byKind: {} },
    calibrationFeed: { emitted: 0, charged: 0, excludedByReason: {} },
  };
  let deltaSum = 0;
  for (const r of reviews) {
    if (r.status === 'open') summary.open += 1; else summary.closed += 1;
    bump(summary.byMode, r.mode);
    if (r.join.auditFillSeq !== null) summary.joins.withAuditFill += 1;
    if (r.join.signalId !== null) summary.joins.withSignalId += 1;
    if (r.thesis !== null) summary.joins.withThesis += 1;
    for (const reason of r.join.missing) bump(summary.joins.missingByReason, reason);
    if (r.excursion.mae !== null) summary.excursion.withMae += 1;
    if (r.excursion.mfePeakPremium !== null) summary.excursion.withMfe += 1;
    if (r.slippage.deltaR !== null) {
      summary.slippage.comparable += 1;
      deltaSum += r.slippage.deltaR;
    } else if (r.slippage.reason !== null) {
      bump(summary.slippage.unresolvedByReason, r.slippage.reason);
    }
    if (r.ruleViolations.length > 0) summary.violations.rowsWithAny += 1;
    for (const v of r.ruleViolations) bump(summary.violations.byKind, v.kind);
    const feed = toSetupOutcomeRecord(r);
    if (feed.record !== null) {
      summary.calibrationFeed.emitted += 1;
      if (feed.record.costSource !== null) summary.calibrationFeed.charged += 1;
    } else if (feed.excludedReason !== null) {
      bump(summary.calibrationFeed.excludedByReason, feed.excludedReason);
    }
  }
  summary.slippage.meanDeltaR =
    summary.slippage.comparable > 0 ? round4(deltaSum / summary.slippage.comparable) : null;
  return summary;
}

export interface PostTradeReviewBatch {
  reviews: PostTradeReview[];
  summary: PostTradeReviewSummary;
  /** The closed-and-keyed rows, ready for `calibrateSetups` (TRA-4779). */
  calibrationRecords: SetupOutcomeRecord[];
}

/** Build reviews for a whole journal slice, newest-first, plus the fold. */
export function buildPostTradeReviews(
  rows: readonly OptionTradeJournalRecord[],
  ctx: PostTradeReviewContext = {},
): PostTradeReviewBatch {
  const reviews = rows.map(r => buildPostTradeReview(r, ctx));
  reviews.sort((a, b) => b.openTs - a.openTs);
  const calibrationRecords: SetupOutcomeRecord[] = [];
  for (const r of reviews) {
    const feed = toSetupOutcomeRecord(r);
    if (feed.record !== null) calibrationRecords.push(feed.record);
  }
  return { reviews, summary: summarizePostTradeReviews(reviews), calibrationRecords };
}
