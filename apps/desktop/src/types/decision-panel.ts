// TRA-4654 — wire shape of GET /api/cards/:signalId/panel (schemaVersion 1).
//
// The server assembles EVERYTHING (packages/server/src/decision-panel.ts);
// this file mirrors the payload so the desktop renders it in one synchronous
// pass — the panel does no client-side folding, which is how the <100ms
// render acceptance is met. Local by the same convention as types/app.ts:
// the desktop types its wire payloads next to the code that renders them.

export type PanelSectionStatus = 'verified' | 'incomplete';

export interface PanelSection<T> {
  status: PanelSectionStatus;
  data: T | null;
  /** Named missing inputs — rendered verbatim, never papered over. */
  missing: string[];
}

export interface PanelHeader {
  symbol: string;
  signalType: string;
  setupLabel: string | null;
  setupFamily: string | null;
  instrument: 'option' | 'underlying' | null;
  regime: string | null;
  regimeEnabled: boolean;
  regimeAsOf: string | null;
  disposition: 'proposal_only';
}

export interface PanelChecklistItem {
  name: string;
  description: string;
  pass: boolean;
}

export interface PanelChecklist {
  side: string;
  orderType: string;
  limitPrice: number;
  criteria: PanelChecklistItem[];
  allPass: boolean;
}

export interface PanelFreshness {
  firedAt: number;
  ageMs: number;
  freshnessCeilingMs: number;
  fresh: boolean;
  quoteAsOf: number | null;
}

export interface PanelRiskGap {
  field: 'entryTrigger' | 'invalidation' | 'targets' | 'sizing';
  /** `unbuildable` = input absent; `refused` = built, and it says do-not-enter. */
  kind: 'unbuildable' | 'refused';
  reasons: string[];
}

/** Cells populate independently — see the server's PanelRisk note (TRA-4654). */
export interface PanelRisk {
  entry: number | null;
  stop: number | null;
  takeProfit: number | null;
  exitRule: string | null;
  rewardRisk: number | null;
  quantity: number | null;
  unit: 'contracts' | 'shares' | null;
  maxLossAtStopUsd: number | null;
  maxLossHardUsd: number | null;
  costR: number | null;
  holdingPeriod: { minDays: number; maxDays: number | null } | null;
  /** Optional on the wire so a pre-TRA-4654-partial server still parses. */
  gaps?: PanelRiskGap[];
}

export interface PanelLiquidity {
  grade: 'good' | 'thin' | 'unknown';
  reasons: string[];
  spreadFrac: number | null;
  edgeToSpread: number | null;
  openInterest: number | null;
  volume: number | null;
}

export interface PanelContract {
  selection: {
    kind: 'option' | 'underlying';
    symbol: string;
    optionSymbol: string | null;
    optionType: string | null;
    strike: number | null;
    expiration: string | null;
    delta: number | null;
  };
  liquidity: PanelLiquidity;
}

export interface PanelPortfolioImpact {
  openPositionCount: number;
  sameSymbolCount: number;
  sameSymbolNotionalUsd: number | null;
  sameSymbolPctOfEquity: number | null;
  sameSetupCount: number;
  netDeltaSharesSameSymbol: number | null;
  deltaUnknownCount: number;
  proposedNotionalUsd: number | null;
  proposedPctOfEquity: number | null;
  correlation: { status: 'not_computed'; reason: string };
}

export interface PanelSimilarTradeRow {
  symbol: string;
  closedAt: number | null;
  pnlUsd: number | null;
  source: 'equity_book' | 'options_book';
}

export interface PanelSimilarTrades {
  matchedBy: 'setup_and_symbol' | 'setup';
  n: number;
  wins: number;
  losses: number;
  unknownOutcome: number;
  totalPnlUsd: number | null;
  recent: PanelSimilarTradeRow[];
  excludedNoSetup: number;
}

export interface PanelActionEntry {
  enabled: boolean;
  reason: string | null;
}

export interface PanelActions {
  paperTrade: PanelActionEntry;
  requireApproval: PanelActionEntry;
  autoExecute: PanelActionEntry;
}

/** TRA-4779 calibrated verdict — present only when validated; never invented. */
export interface PanelConfidence {
  displayWinRatePct: number;
  n: number;
  basis: 'regime' | 'pooled';
  regime: string | null;
  expectancyNetR: number;
}

/**
 * TRA-4719 — "reasons NOT to enter", display only. `not_evaluated` is NOT
 * clear: render its `detail` verbatim, never collapse an unmeasured row away.
 */
export interface ReasonSourceRow {
  source: 'iv_crush' | 'ema_pullback' | 'volume_breakout' | 'promotion_divergence' | 'gap_ranked';
  state: 'clear' | 'flagged' | 'not_evaluated';
  codes: string[];
  notEvaluatedBecause:
    | 'section_flag_off'
    | 'source_flag_off'
    | 'input_missing'
    | 'not_applicable'
    | 'no_detector'
    | null;
  detail: string;
}

export interface PanelReasonsNotToEnter {
  enabled: boolean;
  sources: ReasonSourceRow[];
  counts: { clear: number; flagged: number; notEvaluated: number };
  note: string;
}

export interface DecisionPanelPayload {
  schemaVersion: 1;
  signalId: string;
  assembledAt: number;
  assemblyMs: number;
  header: PanelHeader;
  checklist: PanelSection<PanelChecklist>;
  freshness: PanelSection<PanelFreshness>;
  risk: PanelSection<PanelRisk>;
  contract: PanelSection<PanelContract>;
  portfolio: PanelSection<PanelPortfolioImpact>;
  similarTrades: PanelSection<PanelSimilarTrades>;
  /** Optional on the wire so a pre-TRA-4719 server still parses. */
  reasonsNotToEnter?: PanelReasonsNotToEnter;
  confidence: PanelConfidence | null;
  /**
   * TRA-4788 — WHY `confidence` is what it is. 'not_run' = calibration has
   * never run on this build (no index in the build context) — a different
   * claim from 'below_floor', where rows were folded and the floor was tested
   * and missed. Absent ⇒ the server build predates the stamp: say "unknown",
   * never assert a branch.
   */
  calibrationStatus?: 'not_run' | 'no_instances' | 'below_floor' | 'oos_failed' | 'calibrated';
  calibrationReasons?: string[];
  actions: PanelActions;
  complete: boolean;
  incompleteSections: string[];
  cardComplete: boolean;
  cardIncompleteFields: string[];
}
