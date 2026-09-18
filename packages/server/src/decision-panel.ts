/**
 * TRA-4654 — "Why This Trade?" Decision Panel: the trader-facing assembly that
 * answers, beside every alert: What is the trade? Why is it valid? What breaks
 * it? How much can I lose?
 *
 * This module is the DATA PRODUCT half of the panel — a pure, fail-closed
 * assembler in the exact mold of `buildTradeOpportunityCard` (TRA-4649). It
 * folds one already-built TradeOpportunityCard plus engine-owned context
 * (regime, open positions, closed-trade history) into a single payload the UI
 * renders synchronously. The <100ms acceptance budget is met by construction:
 * everything is precomputed here on the server, so the client render is one
 * pass over a static object — no fetch waterfall, no client-side folds.
 *
 * Discipline carried over from the card builder, binding here too:
 *   - Every section carries `verified | incomplete` plus NAMED missing inputs.
 *     An unpopulatable section fails closed — never silently defaulted.
 *   - The panel proposes; it never executes. Action entries are INTENTS for
 *     the TRA-4651 lifecycle (the sole advance path); `autoExecute` is
 *     structurally disabled in this surface — there is no order path here and
 *     none may be added (board directive on TRA-4645, 2026-09-17).
 *   - `confidence` is passed through from the card untouched: calibrated
 *     (TRA-4652) or absent. This module never invents a probability.
 */

import type {
  TradeOpportunityCard,
  EntryCriterion,
  ContractSelection,
  SetupFamily,
} from './trade-opportunity-card.js';
import type { SetupConfidence } from './setup-calibration.js';

// (Route: GET /api/cards/:signalId/panel in index.ts; engine assembly in
// SignalEngine.getDecisionPanel.)

// ── Section plumbing (mirrors CardField, kept nominal for panel telemetry) ──

export type PanelSectionStatus = 'verified' | 'incomplete';

export interface PanelSection<T> {
  status: PanelSectionStatus;
  /** Populated content; null only when the section could not be built at all. */
  data: T | null;
  /** Named missing/failed inputs — the fail-closed audit trail. */
  missing: string[];
}

function verified<T>(data: T): PanelSection<T> {
  return { status: 'verified', data, missing: [] };
}
function incomplete<T>(data: T | null, missing: string[]): PanelSection<T> {
  return { status: 'incomplete', data, missing };
}

// ── Context inputs (engine-owned; the assembler never reaches for globals) ──

/** One open position, normalized across the equity and options books. */
export interface PanelPositionInput {
  symbol: string;
  kind: 'equity' | 'option';
  /** Setup attribution when the book carries one; null for imported rows. */
  signalType: string | null;
  quantity: number;
  /** Current notional in USD; null when the book has no honest mark for it. */
  notionalUsd: number | null;
  /**
   * Signed share-equivalent delta (underlying shares for equity, delta × 100 ×
   * contracts for options). Null when the position's delta is unknown — an
   * unknown is COUNTED, never treated as zero.
   */
  deltaShares: number | null;
}

/** One closed trade, normalized across the equity and options books. */
export interface PanelHistoryInput {
  symbol: string;
  /** Setup attribution; rows without one cannot be matched and are counted out. */
  signalType: string | null;
  closedAt: number | null;
  /** Realized P&L in USD; null when the close never booked a number. */
  pnlUsd: number | null;
  source: 'equity_book' | 'options_book';
}

export interface DecisionPanelContext {
  /** Wall clock of the assembly — freshness is measured, never assumed. */
  now: number;
  /**
   * Market-review regime context (TRA-389). `enabled: false` ⇒ the regime
   * banner shows "no review" honestly instead of a stale label.
   */
  regime?: { enabled: boolean; label: string | null; asOf: string | null };
  /** Managed equity in USD — the denominator for concentration percentages. */
  totalEquityUsd?: number;
  /** Open positions across the books. Absent ⇒ portfolio section fails closed. */
  positions?: readonly PanelPositionInput[];
  /** Closed-trade history. Absent ⇒ history section fails closed. */
  history?: readonly PanelHistoryInput[];
  /** ms epoch of the underlying quote the card's liquidity was read from. */
  quoteAsOf?: number | null;
}

// ── Section payload types ───────────────────────────────────────────────────

export interface PanelHeader {
  symbol: string;
  signalType: string;
  setupLabel: string | null;
  setupFamily: SetupFamily | null;
  instrument: 'option' | 'underlying' | null;
  /** Current market regime label; null with `regimeEnabled: false` = no review. */
  regime: string | null;
  regimeEnabled: boolean;
  regimeAsOf: string | null;
  disposition: 'proposal_only';
}

export interface PanelChecklist {
  side: string;
  orderType: string;
  limitPrice: number;
  criteria: EntryCriterion[];
  allPass: boolean;
}

export interface PanelFreshness {
  firedAt: number;
  /** Age at ASSEMBLY time (ctx.now − firedAt) — not the card's build-time age. */
  ageMs: number;
  freshnessCeilingMs: number;
  /** ageMs ≤ ceiling. A stale proposal renders, flagged — never silently. */
  fresh: boolean;
  quoteAsOf: number | null;
}

export interface PanelRisk {
  entry: number;
  stop: number;
  takeProfit: number | null;
  exitRule: string | null;
  rewardRisk: number | null;
  quantity: number;
  unit: 'contracts' | 'shares';
  /** Loss at the protective stop — the "how much can I lose" headline. */
  maxLossAtStopUsd: number;
  /** Options: full-premium loss if the position gaps through the stop. */
  maxLossHardUsd: number | null;
  costR: number | null;
  holdingPeriod: { minDays: number; maxDays: number | null };
}

/**
 * Display-only liquidity read. The grade is a screen heuristic for a human —
 * it gates NOTHING (the cost bar and admission gates upstream already ruled).
 * Thresholds are named constants below so the label is auditable.
 */
export interface PanelLiquidity {
  grade: 'good' | 'thin' | 'unknown';
  reasons: string[];
  spreadFrac: number | null;
  edgeToSpread: number | null;
  openInterest: number | null;
  volume: number | null;
}

export interface PanelContract {
  selection: ContractSelection;
  liquidity: PanelLiquidity;
}

/** Grade thresholds — display heuristics, not gates. */
export const LIQUIDITY_GOOD_MAX_SPREAD_FRAC = 0.1;
export const LIQUIDITY_GOOD_MIN_OPEN_INTEREST = 100;

export interface PanelPortfolioImpact {
  openPositionCount: number;
  /** Existing exposure in this symbol, before the proposed trade. */
  sameSymbolCount: number;
  sameSymbolNotionalUsd: number | null;
  sameSymbolPctOfEquity: number | null;
  /** Open positions attributed to the same setup (signalType). */
  sameSetupCount: number;
  /** Net signed share-equivalent delta already held in this symbol. */
  netDeltaSharesSameSymbol: number | null;
  /** Positions in this symbol whose delta is unknown — counted, never zeroed. */
  deltaUnknownCount: number;
  /** The proposed trade's own notional and equity share, from the card. */
  proposedNotionalUsd: number | null;
  proposedPctOfEquity: number | null;
  /**
   * Return-series correlation is NOT computed — no correlation source is
   * wired. Stated as a named limitation rather than a fabricated number; the
   * concentration proxies above are the measured substitute.
   */
  correlation: { status: 'not_computed'; reason: string };
}

export interface PanelSimilarTradeRow {
  symbol: string;
  closedAt: number | null;
  pnlUsd: number | null;
  source: 'equity_book' | 'options_book';
}

export interface PanelSimilarTrades {
  /** How the cohort was matched — same setup+symbol preferred, setup-wide else. */
  matchedBy: 'setup_and_symbol' | 'setup';
  n: number;
  wins: number;
  losses: number;
  /** Closes that never booked a P&L number — counted, never scored as zero. */
  unknownOutcome: number;
  totalPnlUsd: number | null;
  /** Most recent matches, newest first. */
  recent: PanelSimilarTradeRow[];
  /** History rows with no setup attribution — excluded and counted. */
  excludedNoSetup: number;
}

export const SIMILAR_TRADES_RECENT_MAX = 5;

export interface PanelActionEntry {
  enabled: boolean;
  /** Why disabled, when disabled — one line, named. */
  reason: string | null;
}

/**
 * Action INTENTS for the UI. None of these executes anything here: the
 * TRA-4651 lifecycle is the only consumer that can advance a proposal, and
 * live execution sits behind the TRA-4655 operating controls.
 */
export interface PanelActions {
  paperTrade: PanelActionEntry;
  requireApproval: PanelActionEntry;
  autoExecute: PanelActionEntry;
}

export interface DecisionPanelView {
  schemaVersion: 1;
  signalId: string;
  assembledAt: number;
  /** Measured assembly wall time — the server half of the <100ms budget. */
  assemblyMs: number;
  header: PanelHeader;
  checklist: PanelSection<PanelChecklist>;
  freshness: PanelSection<PanelFreshness>;
  risk: PanelSection<PanelRisk>;
  contract: PanelSection<PanelContract>;
  portfolio: PanelSection<PanelPortfolioImpact>;
  similarTrades: PanelSection<PanelSimilarTrades>;
  /** TRA-4652 verdict, passed through from the card. Calibrated or absent. */
  confidence: SetupConfidence | null;
  actions: PanelActions;
  /** All six sections verified AND the underlying card is complete. */
  complete: boolean;
  incompleteSections: string[];
  /** Provenance: the card's own completeness verdict, carried for the UI. */
  cardComplete: boolean;
  cardIncompleteFields: string[];
}

// ── Section builders ────────────────────────────────────────────────────────

function buildHeader(card: TradeOpportunityCard, ctx: DecisionPanelContext): PanelHeader {
  const setup = card.fields.setup.data;
  return {
    symbol: card.symbol,
    signalType: card.signalType,
    setupLabel: setup?.label ?? null,
    setupFamily: setup?.family ?? null,
    instrument: setup?.instrument ?? null,
    regime: ctx.regime?.enabled ? ctx.regime.label : null,
    regimeEnabled: ctx.regime?.enabled ?? false,
    regimeAsOf: ctx.regime?.enabled ? ctx.regime.asOf : null,
    disposition: 'proposal_only',
  };
}

function buildChecklist(card: TradeOpportunityCard): PanelSection<PanelChecklist> {
  const field = card.fields.entryTrigger;
  if (!field.data) return incomplete<PanelChecklist>(null, field.missing);
  const data: PanelChecklist = {
    side: field.data.side,
    orderType: field.data.orderType,
    limitPrice: field.data.limitPrice,
    criteria: [...field.data.criteria],
    allPass: field.data.criteria.every(c => c.pass),
  };
  return field.status === 'verified' ? verified(data) : incomplete(data, field.missing);
}

function buildFreshness(
  card: TradeOpportunityCard,
  ctx: DecisionPanelContext,
): PanelSection<PanelFreshness> {
  const field = card.fields.whyNow;
  if (!field.data) return incomplete<PanelFreshness>(null, field.missing);
  const ageMs = Math.max(0, ctx.now - field.data.firedAt);
  const data: PanelFreshness = {
    firedAt: field.data.firedAt,
    ageMs,
    freshnessCeilingMs: field.data.freshnessCeilingMs,
    fresh: ageMs <= field.data.freshnessCeilingMs,
    quoteAsOf: ctx.quoteAsOf ?? null,
  };
  return field.status === 'verified' ? verified(data) : incomplete(data, field.missing);
}

function buildRisk(card: TradeOpportunityCard): PanelSection<PanelRisk> {
  const trigger = card.fields.entryTrigger;
  const invalidation = card.fields.invalidation;
  const targets = card.fields.targets;
  const sizing = card.fields.sizing;
  const costs = card.fields.costs;
  const missing: string[] = [];
  if (!trigger.data) missing.push('entryTrigger');
  if (!invalidation.data) missing.push('invalidation');
  if (!targets.data) missing.push('targets');
  if (!sizing.data) missing.push('sizing');
  if (missing.length > 0) return incomplete<PanelRisk>(null, missing);
  const data: PanelRisk = {
    entry: trigger.data!.limitPrice,
    stop: invalidation.data!.hardStop,
    takeProfit: targets.data!.takeProfit,
    exitRule: targets.data!.exitRule,
    rewardRisk: targets.data!.rewardRiskRecomputed,
    quantity: sizing.data!.quantity,
    unit: sizing.data!.unit,
    maxLossAtStopUsd: sizing.data!.maxLossAtStop,
    maxLossHardUsd: sizing.data!.maxLossHard,
    costR: costs.data?.costR ?? null,
    holdingPeriod: {
      minDays: targets.data!.holdingPeriod.minDays,
      maxDays: targets.data!.holdingPeriod.maxDays,
    },
  };
  const upstreamIncomplete = [trigger, invalidation, targets, sizing]
    .filter(f => f.status === 'incomplete')
    .flatMap(f => f.missing);
  return upstreamIncomplete.length === 0 ? verified(data) : incomplete(data, upstreamIncomplete);
}

function gradeLiquidity(selection: ContractSelection): PanelLiquidity {
  const liq = selection.liquidity;
  const reasons: string[] = [];
  const spreadFrac = Number.isFinite(liq.spreadFrac) ? liq.spreadFrac : null;
  const oi = liq.openInterest;
  if (spreadFrac === null) {
    return {
      grade: 'unknown',
      reasons: ['no measured spread'],
      spreadFrac: null,
      edgeToSpread: liq.edgeToSpread,
      openInterest: oi,
      volume: liq.volume,
    };
  }
  let grade: 'good' | 'thin' = 'good';
  if (spreadFrac > LIQUIDITY_GOOD_MAX_SPREAD_FRAC) {
    grade = 'thin';
    reasons.push(
      `spread ${(spreadFrac * 100).toFixed(1)}% > ${(LIQUIDITY_GOOD_MAX_SPREAD_FRAC * 100).toFixed(0)}%`,
    );
  }
  // OI applies to options only; the underlying book has no OI concept.
  if (selection.kind === 'option') {
    if (oi === null) {
      reasons.push('open interest unmeasured');
      if (grade === 'good') grade = 'thin';
    } else if (oi < LIQUIDITY_GOOD_MIN_OPEN_INTEREST) {
      grade = 'thin';
      reasons.push(`open interest ${oi} < ${LIQUIDITY_GOOD_MIN_OPEN_INTEREST}`);
    }
  }
  return {
    grade,
    reasons,
    spreadFrac,
    edgeToSpread: liq.edgeToSpread,
    openInterest: oi,
    volume: liq.volume,
  };
}

function buildContract(card: TradeOpportunityCard): PanelSection<PanelContract> {
  const field = card.fields.contract;
  if (!field.data) return incomplete<PanelContract>(null, field.missing);
  const data: PanelContract = {
    selection: field.data,
    liquidity: gradeLiquidity(field.data),
  };
  return field.status === 'verified' ? verified(data) : incomplete(data, field.missing);
}

const CORRELATION_NOT_COMPUTED = {
  status: 'not_computed' as const,
  reason:
    'no return-series correlation source wired; same-symbol / same-setup concentration is the measured substitute',
};

function buildPortfolio(
  card: TradeOpportunityCard,
  ctx: DecisionPanelContext,
): PanelSection<PanelPortfolioImpact> {
  const missing: string[] = [];
  if (!ctx.positions) missing.push('positions');
  if (ctx.totalEquityUsd === undefined || !(ctx.totalEquityUsd > 0)) missing.push('totalEquityUsd');
  const positions = ctx.positions ?? [];
  const equity = ctx.totalEquityUsd !== undefined && ctx.totalEquityUsd > 0 ? ctx.totalEquityUsd : null;

  const same = positions.filter(p => p.symbol === card.symbol);
  const sameNotionals = same.map(p => p.notionalUsd).filter((v): v is number => v !== null);
  const sameSymbolNotionalUsd =
    same.length === 0 ? 0 : sameNotionals.length > 0 ? sameNotionals.reduce((a, b) => a + b, 0) : null;
  const knownDeltas = same.map(p => p.deltaShares).filter((v): v is number => v !== null);
  const deltaUnknownCount = same.length - knownDeltas.length;
  const netDelta =
    same.length === 0 ? 0 : deltaUnknownCount === 0 ? knownDeltas.reduce((a, b) => a + b, 0) : null;

  const sizing = card.fields.sizing.data;
  const costs = card.fields.costs.data;
  const trigger = card.fields.entryTrigger.data;
  // Proposed notional: entry price × quantity (× 100/share multiplier for contracts).
  const proposedNotionalUsd =
    sizing && trigger
      ? trigger.limitPrice * sizing.quantity * (sizing.unit === 'contracts' ? 100 : 1)
      : null;
  void costs;

  const data: PanelPortfolioImpact = {
    openPositionCount: positions.length,
    sameSymbolCount: same.length,
    sameSymbolNotionalUsd,
    sameSymbolPctOfEquity:
      sameSymbolNotionalUsd !== null && equity !== null ? sameSymbolNotionalUsd / equity : null,
    sameSetupCount: positions.filter(p => p.signalType === card.signalType).length,
    netDeltaSharesSameSymbol: netDelta,
    deltaUnknownCount,
    proposedNotionalUsd,
    proposedPctOfEquity:
      proposedNotionalUsd !== null && equity !== null ? proposedNotionalUsd / equity : null,
    correlation: CORRELATION_NOT_COMPUTED,
  };
  return missing.length === 0 ? verified(data) : incomplete(data, missing);
}

function buildSimilarTrades(
  card: TradeOpportunityCard,
  ctx: DecisionPanelContext,
): PanelSection<PanelSimilarTrades> {
  if (!ctx.history) return incomplete<PanelSimilarTrades>(null, ['history']);
  const attributed = ctx.history.filter(h => h.signalType !== null);
  const excludedNoSetup = ctx.history.length - attributed.length;
  const sameSetup = attributed.filter(h => h.signalType === card.signalType);
  const sameSetupAndSymbol = sameSetup.filter(h => h.symbol === card.symbol);
  const matchedBy: PanelSimilarTrades['matchedBy'] =
    sameSetupAndSymbol.length > 0 ? 'setup_and_symbol' : 'setup';
  const cohort = matchedBy === 'setup_and_symbol' ? sameSetupAndSymbol : sameSetup;

  const known = cohort.filter(h => h.pnlUsd !== null);
  const recent = [...cohort]
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, SIMILAR_TRADES_RECENT_MAX)
    .map(h => ({ symbol: h.symbol, closedAt: h.closedAt, pnlUsd: h.pnlUsd, source: h.source }));

  const data: PanelSimilarTrades = {
    matchedBy,
    n: cohort.length,
    wins: known.filter(h => (h.pnlUsd as number) > 0).length,
    losses: known.filter(h => (h.pnlUsd as number) <= 0).length,
    unknownOutcome: cohort.length - known.length,
    // A cohort containing even one unbooked close has NO honest total — summing
    // the known rows would score the unknown as zero. Poisoned to null; the
    // unknownOutcome count says why.
    totalPnlUsd:
      known.length === cohort.length ? known.reduce((a, h) => a + (h.pnlUsd as number), 0) : null,
    recent,
    excludedNoSetup,
  };
  return verified(data);
}

function buildActions(card: TradeOpportunityCard): PanelActions {
  const autoReasons: string[] = [];
  if (card.confidence === null) autoReasons.push('no calibrated confidence (TRA-4652 floor not cleared)');
  autoReasons.push(
    'no execution path from a panel — TRA-4651 lifecycle advances proposals, TRA-4655 controls gate execution',
  );
  return {
    paperTrade: card.complete
      ? { enabled: true, reason: null }
      : {
          enabled: false,
          reason: `card incomplete: ${card.incompleteFields.join(', ') || 'unknown fields'}`,
        },
    requireApproval: { enabled: true, reason: null },
    autoExecute: { enabled: false, reason: autoReasons.join('; ') },
  };
}

// ── The assembler ───────────────────────────────────────────────────────────

const SECTION_NAMES = [
  'checklist',
  'freshness',
  'risk',
  'contract',
  'portfolio',
  'similarTrades',
] as const;

export function buildDecisionPanel(
  card: TradeOpportunityCard,
  ctx: DecisionPanelContext,
): DecisionPanelView {
  const t0 = performance.now();
  const sections = {
    checklist: buildChecklist(card),
    freshness: buildFreshness(card, ctx),
    risk: buildRisk(card),
    contract: buildContract(card),
    portfolio: buildPortfolio(card, ctx),
    similarTrades: buildSimilarTrades(card, ctx),
  };
  const incompleteSections = SECTION_NAMES.filter(n => sections[n].status === 'incomplete');
  const view: DecisionPanelView = {
    schemaVersion: 1,
    signalId: card.signalId,
    assembledAt: ctx.now,
    assemblyMs: 0,
    header: buildHeader(card, ctx),
    ...sections,
    confidence: card.confidence,
    actions: buildActions(card),
    complete: incompleteSections.length === 0 && card.complete,
    incompleteSections: [...incompleteSections],
    cardComplete: card.complete,
    cardIncompleteFields: [...card.incompleteFields],
  };
  view.assemblyMs = performance.now() - t0;
  return view;
}
