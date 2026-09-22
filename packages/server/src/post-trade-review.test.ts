// TRA-4653 — Post-Trade Intelligence: the per-trade review record.
//
// The module under test is a pure JOIN over surfaces other issues shipped
// (journal MAE/MFE, audit fill/exit events, the opportunity card, crossed
// re-pricing). These tests therefore grade the join and its fail-closed
// bookkeeping, not the underlying instruments — each of which has its own
// suite. Every "absent" case asserts null-plus-reason, never zero.

import { describe, expect, it } from 'vitest';
import {
  buildPostTradeReview,
  buildPostTradeReviews,
  summarizePostTradeReviews,
  toSetupOutcomeRecord,
  STOP_OVERRUN_VIOLATION_FRAC,
  type PostTradeReviewContext,
} from './post-trade-review.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import type { DecisionAuditEvent } from './decision-audit-log.js';
import type { TradeOpportunityCard } from './trade-opportunity-card.js';
import type { SignalType } from '@trading-app/shared';

// ── Fixtures ────────────────────────────────────────────────────────────────

const T0 = Date.parse('2026-09-15T14:00:00Z');
const T_CLOSE = T0 + 3 * 60 * 60 * 1_000;

function makeRow(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: 'pos-1',
    openTs: T0,
    symbol: 'PGY',
    structure: 'single_leg_rv',
    mode: 'demo',
    ivRank: 40,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.45,
    entryDte: 21,
    atRiskUsd: 50,
    outcome: 'LOSS',
    closeTs: T_CLOSE,
    realizedPnlUsd: -20,
    realizedR: -0.4,
    exitReason: 'stop',
    contracts: 1,
    optionSymbol: 'PGY261016C00030000',
    entryBidAtOpen: 1.0,
    entryAskAtOpen: 1.2,
    entrySpreadPct: 18.2,
    ...over,
  } as OptionTradeJournalRecord;
}

let seq = 0;
function makeEvent(over: Partial<DecisionAuditEvent>): DecisionAuditEvent {
  seq += 1;
  return {
    v: 1,
    seq,
    atMs: T0,
    at: new Date(T0).toISOString(),
    etDay: '2026-09-15',
    category: 'order',
    action: 'fill_booked',
    outcome: 'filled',
    mode: 'demo',
    strategy: 'options_rv',
    symbol: 'PGY',
    positionId: 'pos-1',
    signalId: 'sig-1',
    actor: null,
    reason: null,
    qty: 1,
    price: 1.2,
    proposedPrice: null,
    notionalUsd: 120,
    feesUsd: null,
    pnlUsd: null,
    holdMs: null,
    quote: null,
    detail: { instrument: 'option', plannedStopPremium: 0.8 },
    ...over,
  };
}

function makeCard(over: Partial<TradeOpportunityCard> = {}): TradeOpportunityCard {
  const field = <T,>(data: T) => ({ status: 'verified' as const, data, missing: [] });
  return {
    schemaVersion: 1,
    signalId: 'sig-1',
    symbol: 'PGY',
    signalType: 'options_rv' as SignalType,
    mode: 'demo',
    generatedAt: T0 - 5_000,
    disposition: 'proposal_only',
    confidence: null,
    complete: true,
    incompleteFields: [],
    fields: {
      setup: field({}),
      entryTrigger: field({}),
      invalidation: field({}),
      targets: field({ rewardRiskRecomputed: 2.5 }),
      contract: field({}),
      costs: field({ costR: 0.2 }),
      sizing: field({}),
      whyNow: field({}),
    },
    ...over,
  } as TradeOpportunityCard;
}

function ctxWith(over: Partial<PostTradeReviewContext> = {}): PostTradeReviewContext {
  const card = makeCard();
  return {
    auditEvents: [makeEvent({})],
    cardForSignal: id => (id === card.signalId ? card : null),
    nowMs: T_CLOSE + 60_000,
    ...over,
  };
}

// ── The join ────────────────────────────────────────────────────────────────

describe('buildPostTradeReview — the join', () => {
  it('bridges positionId → signalId → card off the audit fill event', () => {
    const review = buildPostTradeReview(makeRow(), ctxWith());
    expect(review.join.signalId).toBe('sig-1');
    expect(review.join.cardId).toBe('sig-1');
    expect(review.thesis?.signalId).toBe('sig-1');
    expect(review.thesisUnavailableReason).toBeNull();
    expect(review.join.missing).toEqual([]);
    expect(review.setupKey).toBe('options_rv');
    expect(review.setupKeySource).toBe('audit');
  });

  it('records no-audit-supplied DISTINCT from queried-and-not-found', () => {
    const noAudit = buildPostTradeReview(makeRow(), { nowMs: T_CLOSE });
    expect(noAudit.join.signalId).toBeNull();
    expect(noAudit.join.missing).toContain('no_audit_events_supplied');
    expect(noAudit.thesisUnavailableReason).toBe('no_audit_events_supplied');

    const emptyAudit = buildPostTradeReview(makeRow(), ctxWith({ auditEvents: [] }));
    expect(emptyAudit.join.missing).toContain('no_audit_fill_event');
    expect(emptyAudit.thesisUnavailableReason).toBe('no_signal_id_join');
  });

  it('a card evicted from the ring is a counted reason, not a throw', () => {
    const review = buildPostTradeReview(makeRow(), ctxWith({ cardForSignal: () => null }));
    expect(review.thesis).toBeNull();
    expect(review.thesisUnavailableReason).toBe('card_evicted_or_never_carded');
    expect(review.join.signalId).toBe('sig-1'); // the audit half still joined
    expect(review.join.cardId).toBeNull();
  });

  it('every journal row produces a review — open rows included', () => {
    const open = makeRow({
      outcome: 'OPEN', closeTs: undefined, realizedPnlUsd: undefined,
      realizedR: undefined, exitReason: undefined,
    });
    const review = buildPostTradeReview(open, ctxWith());
    expect(review.status).toBe('open');
    expect(review.closeTs).toBeNull();
    expect(review.holdMs).toBeNull();
    expect(review.pnl.realizedUsd).toBeNull();
    expect(review.pnl.crossedUnpriced).toBe('open_row');
  });
});

// ── MAE / MFE passthrough ──────────────────────────────────────────────────

describe('excursion', () => {
  it('carries the journal MAE verbatim and derives MFE frac + give-back', () => {
    const row = makeRow({
      mae: { frac: -0.3, mark: 0.84, at: T0 + 1000, basisPremium: 1.2, basisSource: 'premium_paid' },
      peakPremium: 1.8,
      peakPremiumAt: T0 + 2000,
      peakPremiumStamp: 'observed',
      exitFillPremium: 1.05,
    } as Partial<OptionTradeJournalRecord>);
    const { excursion } = buildPostTradeReview(row, ctxWith());
    expect(excursion.mae?.frac).toBe(-0.3);
    expect(excursion.mfePeakPremium).toBe(1.8);
    expect(excursion.mfeBasisSource).toBe('mae_basis');
    expect(excursion.mfeFracOfBasis).toBeCloseTo(0.5, 4);       // 1.8/1.2 − 1
    expect(excursion.giveBackFrac).toBeCloseTo(1.25, 4);        // (1.8−1.05)/(1.8−1.2)
  });

  it('absent MAE/MFE stays null — never zero', () => {
    const { excursion } = buildPostTradeReview(makeRow(), ctxWith());
    expect(excursion.mae).toBeNull();
    expect(excursion.mfePeakPremium).toBeNull();
    expect(excursion.mfeFracOfBasis).toBeNull();
    expect(excursion.giveBackFrac).toBeNull();
  });

  it('no give-back is computed when the peak never cleared the basis', () => {
    const row = makeRow({ peakPremium: 1.1, entryFillPremium: 1.2, exitFillPremium: 0.9 });
    const { excursion } = buildPostTradeReview(row, ctxWith());
    expect(excursion.mfeFracOfBasis).toBeCloseTo(-0.0833, 3);
    expect(excursion.giveBackFrac).toBeNull();
  });
});

// ── Slippage: the card's estimate vs the fill ──────────────────────────────

describe('slippage', () => {
  it('compares realized legs against the card estimate in R units', () => {
    const row = makeRow({ entrySlippageUsd: 6, exitSlippageUsd: 9 });
    const { slippage } = buildPostTradeReview(row, ctxWith());
    expect(slippage.expectedCostR).toBe(0.2);
    expect(slippage.realizedRoundTripUsd).toBe(15);
    expect(slippage.realizedCostR).toBeCloseTo(0.3, 4);   // 15 / 50 at-risk
    expect(slippage.deltaR).toBeCloseTo(0.1, 4);          // worse than estimated
    expect(slippage.reason).toBeNull();
  });

  it('one unmeasured leg names itself and produces no round trip', () => {
    const row = makeRow({ entrySlippageUsd: 6 });
    const { slippage } = buildPostTradeReview(row, ctxWith());
    expect(slippage.realizedEntryUsd).toBe(6);
    expect(slippage.realizedExitUsd).toBeNull();
    expect(slippage.realizedRoundTripUsd).toBeNull();
    expect(slippage.deltaR).toBeNull();
    expect(slippage.reason).toBe('exit_leg_not_measured');
  });

  it('no card ⇒ expected side null with the no-card reason', () => {
    const row = makeRow({ entrySlippageUsd: 6, exitSlippageUsd: 9 });
    const { slippage } = buildPostTradeReview(row, ctxWith({ cardForSignal: () => null }));
    expect(slippage.realizedCostR).toBeCloseTo(0.3, 4);
    expect(slippage.expectedCostR).toBeNull();
    expect(slippage.deltaR).toBeNull();
    expect(slippage.reason).toBe('no_card_for_estimate');
  });
});

// ── Rule violations off the audit log ──────────────────────────────────────

describe('rule violations', () => {
  it('an intervention naming the position is flagged with its actor', () => {
    const events = [
      makeEvent({}),
      makeEvent({
        category: 'intervention', action: 'manual_close', outcome: 'closed',
        actor: 'operator@desk', atMs: T0 + 1000, reason: 'discretionary',
      }),
    ];
    const review = buildPostTradeReview(makeRow(), ctxWith({ auditEvents: events }));
    const hit = review.ruleViolations.find(v => v.kind === 'manual_intervention');
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain('operator@desk');
  });

  it('a halt transition inside the hold window is flagged; outside is not', () => {
    const inside = makeEvent({
      category: 'state_change', action: 'daily_halt', outcome: 'halted',
      positionId: null, atMs: T0 + 1000,
    });
    const outside = makeEvent({
      category: 'state_change', action: 'daily_halt', outcome: 'halted',
      positionId: null, atMs: T_CLOSE + 10 * 60_000,
    });
    const review = buildPostTradeReview(
      makeRow(),
      ctxWith({ auditEvents: [makeEvent({}), inside, outside] }),
    );
    const halts = review.ruleViolations.filter(v => v.kind === 'book_halt_during_hold');
    expect(halts).toHaveLength(1);
    expect(halts[0]?.atMs).toBe(T0 + 1000);
  });

  it('an exit through the planned stop fires only past the tolerance', () => {
    // Planned stop 0.8 (fill-event detail). 10% through = 0.72.
    const flagged = buildPostTradeReview(
      makeRow({ exitFillPremium: 0.6 }), ctxWith(),
    );
    const hit = flagged.ruleViolations.find(v => v.kind === 'exit_below_planned_stop');
    expect(hit?.severity).toBeCloseTo(0.25, 4);

    // Negative control: AT the stop is discipline, not a violation.
    const atStop = buildPostTradeReview(makeRow({ exitFillPremium: 0.8 }), ctxWith());
    expect(atStop.ruleViolations.find(v => v.kind === 'exit_below_planned_stop')).toBeUndefined();
    // Just inside the tolerance band is also clean.
    const inside = buildPostTradeReview(
      makeRow({ exitFillPremium: 0.8 * (1 - STOP_OVERRUN_VIOLATION_FRAC) }), ctxWith(),
    );
    expect(inside.ruleViolations.find(v => v.kind === 'exit_below_planned_stop')).toBeUndefined();
  });

  it('unadmitted live open: flagged when armed-since is known, not-evaluable when it is not', () => {
    const liveRow = makeRow({ mode: 'live' });
    const flagged = buildPostTradeReview(
      liveRow, ctxWith({ hardControlsLiveSinceMs: T0 - 1000 }),
    );
    expect(flagged.ruleViolations.some(v => v.kind === 'unadmitted_live_open')).toBe(true);

    const unknown = buildPostTradeReview(liveRow, ctxWith());
    expect(unknown.ruleViolations.some(v => v.kind === 'unadmitted_live_open')).toBe(false);
    expect(unknown.violationChecksNotEvaluable).toContain('unadmitted_live_open');
  });

  it('no audit events ⇒ audit-backed checks are named not-evaluable', () => {
    const review = buildPostTradeReview(makeRow(), { nowMs: T_CLOSE });
    expect(review.violationChecksNotEvaluable).toContain('manual_intervention');
    expect(review.violationChecksNotEvaluable).toContain('book_halt_during_hold');
  });
});

// ── The TRA-4779 feed ──────────────────────────────────────────────────────

describe('toSetupOutcomeRecord', () => {
  it('a closed, fully-measured trade emits a SAMPLED-cost record', () => {
    const row = makeRow({ entrySlippageUsd: 6, exitSlippageUsd: 9, feesUsd: 1.3 });
    const review = buildPostTradeReview(row, ctxWith());
    const { record, excludedReason } = toSetupOutcomeRecord(review);
    expect(excludedReason).toBeNull();
    expect(record?.setupKey).toBe('options_rv');
    expect(record?.grossR).toBe(-0.4);
    expect(record?.costR).toBeCloseTo(16.3 / 50, 4);
    expect(record?.costSource).toBe('sampled');
    expect(record?.predictedRR).toBe(2.5);
  });

  it('a mark-booked demo close without measured legs falls back to the crossed drag (modelled)', () => {
    // No slippage legs, but the row is crossable: entry ask 1.2, exit bid 0.9,
    // 1 contract ⇒ crossed = −$30 vs booked −$20 ⇒ drag $10 ⇒ costR 0.2.
    const row = makeRow({
      markProvenance: { quoteAtFire: { bid: 0.9, ask: 1.0 } },
    } as Partial<OptionTradeJournalRecord>);
    const review = buildPostTradeReview(row, ctxWith());
    expect(review.pnl.crossedUsd).toBe(-30);
    const { record } = toSetupOutcomeRecord(review);
    expect(record?.costR).toBeCloseTo(0.2, 4);
    expect(record?.costSource).toBe('modelled');
  });

  it('uncrossable and unmeasured ⇒ UNCHARGED (null cost, null source), never zero', () => {
    const review = buildPostTradeReview(makeRow(), ctxWith());
    const { record } = toSetupOutcomeRecord(review);
    expect(record?.costR).toBeNull();
    expect(record?.costSource).toBeNull();
  });

  it('open rows and unkeyed rows are excluded with named reasons', () => {
    const open = buildPostTradeReview(
      makeRow({ outcome: 'OPEN', closeTs: undefined }), ctxWith(),
    );
    expect(toSetupOutcomeRecord(open).excludedReason).toBe('open_row');

    const unkeyed = buildPostTradeReview(makeRow(), { auditEvents: [], nowMs: T_CLOSE });
    expect(toSetupOutcomeRecord(unkeyed).excludedReason).toBe('setup_unknown');
  });
});

// ── The fold (the acceptance instrument) ───────────────────────────────────

describe('buildPostTradeReviews / summary', () => {
  it('reviews EVERY row and counts every missing join by name', () => {
    const rows = [
      makeRow({ id: 'pos-1' }),
      makeRow({ id: 'pos-2', outcome: 'OPEN', closeTs: undefined }),
      makeRow({ id: 'pos-3', mode: 'live' }),
    ];
    // Audit only knows pos-1; the ring only holds pos-1's card.
    const batch = buildPostTradeReviews(rows, ctxWith());
    expect(batch.reviews).toHaveLength(3);
    expect(batch.summary.total).toBe(3);
    expect(batch.summary.open).toBe(1);
    expect(batch.summary.closed).toBe(2);
    expect(batch.summary.byMode).toEqual({ demo: 2, live: 1 });
    expect(batch.summary.joins.withAuditFill).toBe(1);
    expect(batch.summary.joins.withThesis).toBe(1);
    expect(batch.summary.joins.missingByReason['no_audit_fill_event']).toBe(2);
    // Calibration feed: pos-1 keyed+closed ⇒ emitted; pos-2 open, pos-3 unkeyed.
    expect(batch.summary.calibrationFeed.emitted).toBe(1);
    expect(batch.summary.calibrationFeed.excludedByReason).toEqual({
      open_row: 1, setup_unknown: 1,
    });
    expect(batch.calibrationRecords).toHaveLength(1);
    // Newest first.
    expect(batch.reviews.map(r => r.positionId).sort()).toEqual(['pos-1', 'pos-2', 'pos-3']);
  });

  it('positive control: a planted violation and a comparable slippage pair are visible in the fold', () => {
    const rows = [
      makeRow({ id: 'pos-1', entrySlippageUsd: 6, exitSlippageUsd: 9, exitFillPremium: 0.5 }),
    ];
    const { summary } = buildPostTradeReviews(rows, ctxWith());
    expect(summary.violations.rowsWithAny).toBe(1);
    expect(summary.violations.byKind['exit_below_planned_stop']).toBe(1);
    expect(summary.slippage.comparable).toBe(1);
    expect(summary.slippage.meanDeltaR).toBeCloseTo(0.1, 4);
  });

  it('summarize of an empty set is a zero fold with a null mean, not NaN', () => {
    const summary = summarizePostTradeReviews([]);
    expect(summary.total).toBe(0);
    expect(summary.slippage.meanDeltaR).toBeNull();
  });
});
