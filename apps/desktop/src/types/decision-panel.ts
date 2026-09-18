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

export interface PanelRisk {
  entry: number;
  stop: number;
  takeProfit: number | null;
  exitRule: string | null;
  rewardRisk: number | null;
  quantity: number;
  unit: 'contracts' | 'shares';
  maxLossAtStopUsd: number;
  maxLossHardUsd: number | null;
  costR: number | null;
  holdingPeriod: { minDays: number; maxDays: number | null };
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

/** TRA-4652 calibrated verdict — present only when validated; never invented. */
export interface PanelConfidence {
  displayWinRatePct: number;
  n: number;
  basis: 'regime' | 'pooled';
  regime: string | null;
  expectancyNetR: number;
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
  confidence: PanelConfidence | null;
  actions: PanelActions;
  complete: boolean;
  incompleteSections: string[];
  cardComplete: boolean;
  cardIncompleteFields: string[];
}
