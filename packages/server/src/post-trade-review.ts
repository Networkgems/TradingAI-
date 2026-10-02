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

/**
 * TRA-5011 — why a closed row's cost could not be CHARGED to the calibration
 * fold. `setup-calibration.ts` already refuses to treat an uncharged row as a
 * zero-cost one; this names which of the two cost arms fell over and where, so
 * `charged: 0` is a diagnosis instead of an opaque zero.
 *   • `entry_leg_basis_modelled`  — the entry leg exists but its basis is the
 *     book's own modelled fill, which is identically $0.00 on demo. Charging it
 *     books the entry cross at zero. The single largest bucket.
 *   • `entry_leg_basis_unknown`   — a bare `entrySlippageUsd` from before the
 *     TRA-5011 basis stamp: unrecoverable, never assumed measured.
 *   • `entry_leg_not_measured` / `exit_leg_not_measured` — no leg at all.
 *   • `fees_not_measured`         — demo books no commission, so an absent
 *     `feesUsd` is "not modelled", not "$0 of fees".
 *   • `crossed_unpriced:<reason>` — the modelled arm's own refusal, carried
 *     through verbatim from `priceCrossedRow` rather than flattened.
 *   • `realized_pnl_missing` / `at_risk_unusable` — the divisor/dividend.
 */
export type CostUnchargedReason = string;

/**
 * TRA-5011 — did the trade's OWN rule close this position, or did something
 * outside it? An operational flatten is not a strategy exit and must not enter
 * a setup's expectancy: on live bqb1 2026-10-01, 1,085 of 1,966 closed demo
 * rows (55.2%) exited `book_halt_flat` or `manual`, and those exits carry
 * +$13,762 against a +$7,232 whole-book sum — restricting to rule-driven exits
 * flips `single_leg_otm` from +$4.89 to −$19.28 per trade on n=404.
 */
export type ExitClass = 'strategy' | 'operational';

/**
 * Exits the trade's own rule did NOT decide. ⛔ When a new reason is genuinely
 * ambiguous it belongs HERE, not in the strategy set: a strategy exit misfiled
 * as operational only shrinks n, while an operational exit misfiled as strategy
 * contaminates the expectancy with the halt switch — which is the whole defect.
 */
export const OPERATIONAL_EXIT_REASONS: ReadonlySet<string> = new Set([
  'book_halt_flat',
  'manual',
  'broker_reconcile',
  'partial_drain',
  'max_window_liquidation',
  'reconstructed-TRA-3472',
]);

/**
 * Exits a trade rule (or the contract's own settlement) decided. The TRA-2940
 * `exitReason` vocabulary, enumerated rather than defaulted — see
 * `OptionPosition.exitReason` in `@trading-app/shared` for the source list.
 */
export const STRATEGY_EXIT_REASONS: ReadonlySet<string> = new Set([
  'sl', 'sl_credit', 'sl_debit', 'sl_daily_close', 'sl_otm_premium_pct',
  'stock_stop', 'trail', 'tp1', 'tp_capture', 'take_profit_early',
  'profit_lock', 'chandelier', 'chandelier_daily_close', 'chandelier_restarted',
  'chandelier_spot_seeded', 'supertrend_flip', 'ma20_close_through',
  'time_stop', 'dte_time_stop', 'expiry_settle', 'expired', 'bought_back',
  'assigned', 'called_away',
]);

/**
 * `null` = the reason is in NEITHER table (or absent). Deliberately not folded
 * to `strategy`: an unrecognised reason is counted by name and excluded, so a
 * new operational exit cannot enter expectancy by being new.
 */
export function classifyExitReason(reason: string | null): ExitClass | null {
  if (reason === null) return null;
  if (OPERATIONAL_EXIT_REASONS.has(reason)) return 'operational';
  if (STRATEGY_EXIT_REASONS.has(reason)) return 'strategy';
  return null;
}

export interface PostTradeSlippage {
  /** Card estimate: round-trip cost in the trade's own R units (TRA-3483 arithmetic). */
  expectedCostR: number | null;
  /** Measured mark-vs-fill legs off the journal row; null = never measured, NOT 0. */
  realizedEntryUsd: number | null;
  realizedExitUsd: number | null;
  /**
   * TRA-5011 — the PROVENANCE of each leg, published beside the number because
   * the number alone cannot be read: a `modelled_fill` entry leg is identically
   * $0.00 on the demo book (0 of 1,341 nonzero, live bqb1 2026-10-01), so it is
   * numerically indistinguishable from a trade that crossed no spread.
   * `null` ⇒ the leg carries no basis stamp at all — never assumed measured.
   */
  entryLegBasis: 'broker_fill' | 'modelled_fill' | null;
  exitLegBasis: 'quote_cross' | 'broker_fill' | null;
  /**
   * TRA-5011 — true iff BOTH legs are real measurements (`broker_fill`, or the
   * TRA-4997 `quote_cross` half-spread). The round-trip number below exists
   * whenever both legs are present; this says whether it may be CHARGED.
   */
  roundTripFullyMeasured: boolean;
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
  /**
   * Setup identity for the TRA-4779 fold — audit fill `strategy`, else card,
   * else (TRA-5011) the row's own `structure`, VERBATIM.
   *
   * ⛔ The three sources are three different vocabularies and this field does
   * NOT reconcile them: the journal says `single_leg_rv` where a card says
   * `relative_value`, and asserting that equivalence here would be an inference
   * dressed as a measurement. `setupKeySource` is on the wire so a consumer can
   * see which vocabulary a key came from and fold accordingly. Resolving the
   * mapping is a quant ruling, not a plumbing decision, and is deliberately
   * left open.
   */
  setupKey: string | null;
  setupKeySource: 'audit' | 'card' | 'structure' | null;
  status: 'open' | 'closed';
  openTs: number;
  closeTs: number | null;
  holdMs: number | null;
  exitReason: string | null;
  /** TRA-5011 — `null` on an open row AND on a closed row whose reason is in neither table. */
  exitClass: ExitClass | null;
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
  // TRA-5011 — bases ride beside the legs. An absent stamp is `null`, never the
  // optimistic guess: a pre-stamp row's basis is genuinely unrecoverable.
  const entryLegBasis = row.entrySlippageBasis ?? null;
  const exitLegBasis = row.exitSlippageBasis ?? null;
  const roundTripFullyMeasured =
    entryLeg !== null && exitLeg !== null
    && entryLegBasis === 'broker_fill'
    && (exitLegBasis === 'quote_cross' || exitLegBasis === 'broker_fill');
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
    entryLegBasis,
    exitLegBasis,
    roundTripFullyMeasured,
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

  // — setup identity, three sources, highest precedence first —
  //
  // TRA-5011 adds the third. The first two both need an audit `fill_booked`
  // event keyed to this row, and the audit log's oldest day on disk is
  // 2026-09-21 while the journal spans 2026-07-07 → 2026-10-01: measured on
  // live bqb1, {keyed} ∩ {closed} was EMPTY, so the fold had never been handed
  // a single row. `structure` is non-null on 1,998 / 1,998 closed rows and is
  // written at open by the row's own writer, so it cannot age out of a ring or
  // a retention window — that durability is the whole point of the arm.
  //
  // It is taken VERBATIM. No mapping, no default bucket: see `setupKey`.
  const setupFromAudit = fillEvent ? str(fillEvent.strategy) : null;
  const setupFromCard = card ? str(card.signalType) : null;
  const setupFromStructure = str(row.structure);
  const setupKey = setupFromAudit ?? setupFromCard ?? setupFromStructure;
  const setupKeySource: PostTradeReview['setupKeySource'] =
    setupFromAudit !== null ? 'audit'
      : setupFromCard !== null ? 'card'
        : setupFromStructure !== null ? 'structure'
          : null;

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
    exitClass: closed ? classifyExitReason(str(row.exitReason)) : null,
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
  /**
   * TRA-5011 — the raw `exitReason` when (and only when) `excludedReason` is
   * `exit_class_unknown`, so a new exit vocabulary is counted BY NAME rather
   * than disappearing into one rolled-up bucket.
   */
  unclassifiedExitReason: string | null;
  /**
   * TRA-5011 — set on an EMITTED record whose `costSource` is null: which cost
   * arm fell over, and where. The record is still emitted (the estimator owns
   * the uncharged-row refusal and counts it); this is what turns its
   * `unchargedCost` tally into something actionable.
   */
  costUnchargedReason: CostUnchargedReason | null;
}

/**
 * Adapt one review into the calibration fold's input row. Cost provenance:
 * `sampled` = both slippage legs AND fees were measured off real fills;
 * `modelled` = the TRA-4674 crossed re-pricing (booked − crossed spread drag);
 * null = uncharged — setup-calibration excludes AND counts those itself.
 */
export function toSetupOutcomeRecord(review: PostTradeReview): CalibrationFeedResult {
  const no = (excludedReason: string, unclassifiedExitReason: string | null = null)
    : CalibrationFeedResult =>
    ({ record: null, excludedReason, unclassifiedExitReason, costUnchargedReason: null });

  if (review.status !== 'closed') return no('open_row');
  if (review.setupKey === null) return no('setup_unknown');
  if (review.closeTs === null) return no('close_ts_missing');
  // TRA-5011 — the exit-reason partition. Both arms exclude, for opposite
  // reasons: `operational` is a measured not-a-strategy-exit, `unknown` is a
  // reason in neither table and is refused rather than guessed.
  if (review.exitClass === null) return no('exit_class_unknown', review.exitReason);
  if (review.exitClass === 'operational') return no('operational_exit');

  let costR: number | null = null;
  let costSource: SetupOutcomeRecord['costSource'] = null;
  let costUnchargedReason: CostUnchargedReason | null = null;
  const fees = review.pnl.feesUsd;
  const slip = review.slippage;
  if (
    slip.realizedRoundTripUsd !== null
    && slip.roundTripFullyMeasured
    && fees !== null
    && review.atRiskUsd > 0
  ) {
    costR = round4((slip.realizedRoundTripUsd + fees) / review.atRiskUsd);
    costSource = 'sampled';
  } else if (
    review.pnl.crossedUsd !== null
    && review.pnl.realizedUsd !== null
    && review.atRiskUsd > 0
  ) {
    // Spread drag the mark-booked P&L never paid: booked − crossed.
    costR = round4((review.pnl.realizedUsd - review.pnl.crossedUsd) / review.atRiskUsd);
    costSource = 'modelled';
  } else {
    // Neither arm. Name the FIRST thing that is actually missing, walking the
    // sampled arm's own order, then fall through to the modelled arm's refusal
    // — a bare null here is one `?? 0` away from charging the row at zero.
    costUnchargedReason =
      review.atRiskUsd > 0
        ? slip.realizedEntryUsd === null ? 'entry_leg_not_measured'
          : slip.entryLegBasis === null ? 'entry_leg_basis_unknown'
            : slip.entryLegBasis === 'modelled_fill' ? 'entry_leg_basis_modelled'
              : slip.realizedExitUsd === null ? 'exit_leg_not_measured'
                : slip.exitLegBasis === null ? 'exit_leg_basis_unknown'
                  : fees === null ? 'fees_not_measured'
                    : review.pnl.crossedUnpriced !== null
                      ? `crossed_unpriced:${review.pnl.crossedUnpriced}`
                      : review.pnl.realizedUsd === null ? 'realized_pnl_missing'
                        : 'no_cost_arm_resolved'
        : 'at_risk_unusable';
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
    unclassifiedExitReason: null,
    costUnchargedReason,
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
  calibrationFeed: {
    emitted: number;
    charged: number;
    excludedByReason: Record<string, number>;
    /**
     * TRA-5011 — `Σ excludedByReason + emitted` over CLOSED rows, and the
     * `closed` it must equal. Published rather than only asserted in a test so
     * a future reason that forgets to count itself is visible on the wire.
     * `exhaustive: false` means rows vanished between the two.
     */
    partition: { accountedFor: number; closedRows: number; exhaustive: boolean };
    /** TRA-5011 — the exit-reason split over every closed row. */
    byExitClass: { strategy: number; operational: number; unclassified: number };
    /** TRA-5011 — unrecognised `exitReason` values BY NAME, never rolled up. */
    unclassifiedExitReasons: Record<string, number>;
    /** TRA-5011 — of the emitted rows, why each uncharged one is uncharged. */
    unchargedByReason: Record<string, number>;
    /** TRA-5011 — of the charged rows, which arm paid. */
    chargedBySource: Record<string, number>;
  };
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
    calibrationFeed: {
      emitted: 0,
      charged: 0,
      excludedByReason: {},
      partition: { accountedFor: 0, closedRows: 0, exhaustive: true },
      byExitClass: { strategy: 0, operational: 0, unclassified: 0 },
      unclassifiedExitReasons: {},
      unchargedByReason: {},
      chargedBySource: {},
    },
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
    if (r.status === 'closed') {
      const cls = r.exitClass;
      if (cls === 'strategy') summary.calibrationFeed.byExitClass.strategy += 1;
      else if (cls === 'operational') summary.calibrationFeed.byExitClass.operational += 1;
      else summary.calibrationFeed.byExitClass.unclassified += 1;
    }
    const feed = toSetupOutcomeRecord(r);
    if (feed.record !== null) {
      summary.calibrationFeed.emitted += 1;
      if (feed.record.costSource !== null) {
        summary.calibrationFeed.charged += 1;
        bump(summary.calibrationFeed.chargedBySource, feed.record.costSource);
      } else {
        // `?? ` would be a lie here — an emitted uncharged row ALWAYS carries a
        // reason, so an absent one is a bug and must read as one by name.
        bump(
          summary.calibrationFeed.unchargedByReason,
          feed.costUnchargedReason ?? 'uncharged_reason_not_set',
        );
      }
    } else if (feed.excludedReason !== null) {
      bump(summary.calibrationFeed.excludedByReason, feed.excludedReason);
      if (feed.unclassifiedExitReason !== null) {
        bump(summary.calibrationFeed.unclassifiedExitReasons, feed.unclassifiedExitReason);
      }
    }
  }
  // TRA-5011 — the exhaustive-partition identity. `open_row` is the one
  // excluded reason that lands on an OPEN row, so it comes out of both sides.
  const openRows = summary.calibrationFeed.excludedByReason['open_row'] ?? 0;
  const excludedTotal = Object.values(summary.calibrationFeed.excludedByReason)
    .reduce((a, b) => a + b, 0);
  summary.calibrationFeed.partition = {
    accountedFor: summary.calibrationFeed.emitted + excludedTotal - openRows,
    closedRows: summary.closed,
    exhaustive:
      summary.calibrationFeed.emitted + excludedTotal - openRows === summary.closed,
  };
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
