// TRA-4654 — "Why This Trade?" Decision Panel assembler.
//
// Same control discipline as the card suite (TRA-4649): every fail-closed
// branch asserts the SPECIFIC named missing input, portfolio arithmetic is
// checked against hand-derivable fixtures, and an unknown never reads as a
// zero (delta, P&L, attribution). The <100ms acceptance budget is asserted
// against a deliberately oversized context so the server half of the panel
// has measured headroom, not hoped-for headroom.

import { describe, it, expect } from 'vitest';
import type { OtmMispricingSignal, TradeSignal } from '@trading-app/shared';
import { buildTradeOpportunityCard, type CardBuildContext } from './trade-opportunity-card.js';
import {
  buildDecisionPanel,
  LIQUIDITY_GOOD_MAX_SPREAD_FRAC,
  LIQUIDITY_GOOD_MIN_OPEN_INTEREST,
  SIMILAR_TRADES_RECENT_MAX,
  type DecisionPanelContext,
  type PanelHistoryInput,
  type PanelPositionInput,
} from './decision-panel.js';

const NOW = Date.parse('2026-09-18T15:00:00Z');

function isoDatePlusDays(days: number): string {
  return new Date(NOW + days * 86_400_000).toISOString().slice(0, 10);
}

function equitySignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'sig-eq-1',
    symbol: 'AAPL',
    type: 'momentum',
    side: 'buy',
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 115,
    riskRewardRatio: 3,
    timestamp: NOW - 60_000,
    mode: 'demo',
    ...overrides,
  };
}

function otmSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-otm-1',
    symbol: 'SPY',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 0.5,
    stopLoss: 0.3,
    takeProfit: 1.0,
    riskRewardRatio: 2.5,
    timestamp: NOW - 5 * 60_000,
    mode: 'demo',
    optionSymbol: 'SPY261023C00700000',
    optionType: 'call',
    strike: 700,
    expiration: isoDatePlusDays(35),
    mark: 0.5,
    theo: 0.65,
    mispricingPct: -0.2308,
    delta: 0.1,
    bid: 0.48,
    ask: 0.52,
    ...overrides,
  };
}

const CARD_CTX: CardBuildContext = {
  now: NOW,
  sizing: { managedEquity: 50_000, riskPerTrade: 0.01 },
  underlyingQuote: { bid: 99.98, ask: 100.02 },
  optionLiquidity: { openInterest: 500, volume: 120, marketPhase: 'rth' },
};

function positions(): PanelPositionInput[] {
  return [
    { symbol: 'SPY', kind: 'option', signalType: 'otm_mispricing', quantity: 2, notionalUsd: 120, deltaShares: 20 },
    { symbol: 'SPY', kind: 'equity', signalType: 'momentum', quantity: 10, notionalUsd: 6_000, deltaShares: 10 },
    { symbol: 'MSFT', kind: 'equity', signalType: 'momentum', quantity: 5, notionalUsd: 2_000, deltaShares: 5 },
  ];
}

function history(): PanelHistoryInput[] {
  return [
    { symbol: 'SPY', signalType: 'otm_mispricing', closedAt: NOW - 3 * 86_400_000, pnlUsd: 120, source: 'options_book' },
    { symbol: 'SPY', signalType: 'otm_mispricing', closedAt: NOW - 1 * 86_400_000, pnlUsd: -60, source: 'options_book' },
    { symbol: 'QQQ', signalType: 'otm_mispricing', closedAt: NOW - 2 * 86_400_000, pnlUsd: 40, source: 'options_book' },
    { symbol: 'AAPL', signalType: 'momentum', closedAt: NOW - 4 * 86_400_000, pnlUsd: 200, source: 'equity_book' },
    { symbol: 'IMPORTED', signalType: null, closedAt: NOW - 9 * 86_400_000, pnlUsd: 10, source: 'equity_book' },
  ];
}

const FULL_PANEL_CTX: DecisionPanelContext = {
  now: NOW,
  regime: { enabled: true, label: 'risk_on', asOf: '2026-09-18' },
  totalEquityUsd: 50_000,
  positions: positions(),
  history: history(),
  quoteAsOf: NOW - 2_000,
};

describe('buildDecisionPanel — complete panel', () => {
  it('a complete card plus full context verifies all six sections', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    expect(card.complete).toBe(true);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.incompleteSections).toEqual([]);
    expect(panel.complete).toBe(true);
    for (const name of ['checklist', 'freshness', 'risk', 'contract', 'portfolio', 'similarTrades'] as const) {
      expect(panel[name].status).toBe('verified');
      expect(panel[name].data).not.toBeNull();
      expect(panel[name].missing).toEqual([]);
    }
    expect(panel.header).toMatchObject({
      symbol: 'SPY',
      signalType: 'otm_mispricing',
      setupFamily: 'options_mispricing',
      instrument: 'option',
      regime: 'risk_on',
      regimeEnabled: true,
      disposition: 'proposal_only',
    });
    expect(panel.signalId).toBe('sig-otm-1');
  });

  it('risk numbers are the card levels, never re-derived: entry/stop/target/R:R/max-loss', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.risk.data).toMatchObject({
      entry: 0.5,
      stop: 0.3,
      takeProfit: 1.0,
      unit: 'contracts',
      maxLossAtStopUsd: card.fields.sizing.data!.maxLossAtStop,
      maxLossHardUsd: card.fields.sizing.data!.maxLossHard,
      costR: card.fields.costs.data!.costR,
    });
    expect(panel.risk.data!.rewardRisk).toBeCloseTo(2.5, 10);
  });

  it('freshness is recomputed at assembly time, and a stale proposal renders flagged, never hidden', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const lateNow = NOW + 6 * 3_600_000;
    const panel = buildDecisionPanel(card, { ...FULL_PANEL_CTX, now: lateNow });
    expect(panel.freshness.status).toBe('verified');
    expect(panel.freshness.data!.ageMs).toBe(lateNow - otmSignal().timestamp);
    expect(panel.freshness.data!.fresh).toBe(false);
  });

  it('confidence is the card verdict passed through untouched (null here — no calibration wired)', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.confidence).toBeNull();
  });
});

describe('buildDecisionPanel — portfolio impact', () => {
  it('concentration math: same-symbol notional, pct of equity, same-setup count, net delta', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.portfolio.data).toMatchObject({
      openPositionCount: 3,
      sameSymbolCount: 2,
      sameSymbolNotionalUsd: 6_120,
      sameSetupCount: 1,
      netDeltaSharesSameSymbol: 30,
      deltaUnknownCount: 0,
    });
    expect(panel.portfolio.data!.sameSymbolPctOfEquity).toBeCloseTo(6_120 / 50_000, 10);
    // 25 contracts × $0.50 × 100/share = $1,250 proposed notional.
    expect(panel.portfolio.data!.proposedNotionalUsd).toBeCloseTo(1_250, 10);
    expect(panel.portfolio.data!.correlation.status).toBe('not_computed');
  });

  it('an unknown position delta is COUNTED, never zeroed: net delta goes null, not smaller', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const withUnknown = positions();
    withUnknown[0] = { ...withUnknown[0], deltaShares: null };
    const panel = buildDecisionPanel(card, { ...FULL_PANEL_CTX, positions: withUnknown });
    expect(panel.portfolio.data!.netDeltaSharesSameSymbol).toBeNull();
    expect(panel.portfolio.data!.deltaUnknownCount).toBe(1);
  });

  it('absent positions or equity fail the section closed with the input named', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const noPositions = buildDecisionPanel(card, { ...FULL_PANEL_CTX, positions: undefined });
    expect(noPositions.portfolio.status).toBe('incomplete');
    expect(noPositions.portfolio.missing).toContain('positions');
    const noEquity = buildDecisionPanel(card, { ...FULL_PANEL_CTX, totalEquityUsd: undefined });
    expect(noEquity.portfolio.status).toBe('incomplete');
    expect(noEquity.portfolio.missing).toContain('totalEquityUsd');
    expect(noEquity.complete).toBe(false);
    expect(noEquity.incompleteSections).toContain('portfolio');
  });
});

describe('buildDecisionPanel — similar historical trades', () => {
  it('prefers the setup+symbol cohort and scores outcomes without zeroing unknowns', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.similarTrades.data).toMatchObject({
      matchedBy: 'setup_and_symbol',
      n: 2,
      wins: 1,
      losses: 1,
      unknownOutcome: 0,
      totalPnlUsd: 60,
      excludedNoSetup: 1,
    });
    // Newest first.
    expect(panel.similarTrades.data!.recent.map(r => r.pnlUsd)).toEqual([-60, 120]);
  });

  it('falls back to the setup-wide cohort when the symbol has no history', () => {
    const card = buildTradeOpportunityCard(otmSignal({ symbol: 'IWM', optionSymbol: 'IWM261023C00250000' }), CARD_CTX);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.similarTrades.data!.matchedBy).toBe('setup');
    expect(panel.similarTrades.data!.n).toBe(3);
  });

  it('a close that never booked a P&L counts as unknownOutcome and poisons the total to null', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const rows = history();
    rows[1] = { ...rows[1], pnlUsd: null };
    const panel = buildDecisionPanel(card, { ...FULL_PANEL_CTX, history: rows });
    expect(panel.similarTrades.data).toMatchObject({ n: 2, wins: 1, losses: 0, unknownOutcome: 1, totalPnlUsd: null });
  });

  it('caps the recent list and fails closed with "history" named when no source is wired', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const many: PanelHistoryInput[] = Array.from({ length: 20 }, (_, i) => ({
      symbol: 'SPY',
      signalType: 'otm_mispricing',
      closedAt: NOW - i * 3_600_000,
      pnlUsd: i % 2 === 0 ? 10 : -10,
      source: 'options_book',
    }));
    const capped = buildDecisionPanel(card, { ...FULL_PANEL_CTX, history: many });
    expect(capped.similarTrades.data!.recent).toHaveLength(SIMILAR_TRADES_RECENT_MAX);
    const noHistory = buildDecisionPanel(card, { ...FULL_PANEL_CTX, history: undefined });
    expect(noHistory.similarTrades.status).toBe('incomplete');
    expect(noHistory.similarTrades.missing).toEqual(['history']);
  });
});

describe('buildDecisionPanel — contract liquidity grade (display heuristic, gates nothing)', () => {
  it('tight spread + real OI grades good with no reasons', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.contract.data!.liquidity).toMatchObject({ grade: 'good', reasons: [] });
    expect(panel.contract.data!.liquidity.spreadFrac).toBeCloseTo(0.08, 10);
  });

  it('a wide spread grades thin and names the threshold it failed', () => {
    const card = buildTradeOpportunityCard(otmSignal({ bid: 0.4, ask: 0.6 }), CARD_CTX);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    const liq = panel.contract.data!.liquidity;
    expect(liq.grade).toBe('thin');
    expect(liq.reasons.join(' ')).toContain(`${(LIQUIDITY_GOOD_MAX_SPREAD_FRAC * 100).toFixed(0)}%`);
  });

  it('an option with unmeasured open interest cannot grade good', () => {
    const card = buildTradeOpportunityCard(otmSignal(), { ...CARD_CTX, optionLiquidity: undefined });
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.contract.data!.liquidity.grade).toBe('thin');
    expect(panel.contract.data!.liquidity.reasons.join(' ')).toContain('open interest unmeasured');
  });

  it('low open interest grades thin naming the floor', () => {
    const card = buildTradeOpportunityCard(otmSignal(), {
      ...CARD_CTX,
      optionLiquidity: { openInterest: 3, volume: 1, marketPhase: 'rth' },
    });
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    const liq = panel.contract.data!.liquidity;
    expect(liq.grade).toBe('thin');
    expect(liq.reasons.join(' ')).toContain(`3 < ${LIQUIDITY_GOOD_MIN_OPEN_INTEREST}`);
  });
});

describe('buildDecisionPanel — actions derive from the lifecycle machine (TRA-4813)', () => {
  it('a complete card at `proposed` enables Paper Trade; approval waits for a paper fill; Auto-Execute stays disabled with the gates named', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const panel = buildDecisionPanel(card, {
      ...FULL_PANEL_CTX,
      lifecycle: { state: 'proposed', terminal: false },
    });
    expect(panel.actions.paperTrade).toEqual({ enabled: true, reason: null });
    // The pre-4813 surface enabled this unconditionally with nothing behind
    // it. Approval is legal only from `paper` — the machine has no skips.
    expect(panel.actions.requireApproval.enabled).toBe(false);
    expect(panel.actions.requireApproval.reason).toContain("legal only from 'paper'");
    expect(panel.actions.autoExecute.enabled).toBe(false);
    expect(panel.actions.autoExecute.reason).toContain('no calibrated confidence');
    expect(panel.actions.autoExecute.reason).toContain('TRA-4651');
    expect(panel.actions.autoExecute.reason).toContain('TRA-4750');
    expect(panel.header.lifecycleState).toBe('proposed');
  });

  it('at `paper` the approval action enables and paper routing disables, each naming the machine position', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const panel = buildDecisionPanel(card, {
      ...FULL_PANEL_CTX,
      lifecycle: { state: 'paper', terminal: false },
    });
    expect(panel.actions.requireApproval).toEqual({ enabled: true, reason: null });
    expect(panel.actions.paperTrade.enabled).toBe(false);
    expect(panel.actions.paperTrade.reason).toContain("lifecycle at 'paper'");
  });

  it('no lifecycle machine ⇒ every advance action is disabled WITH the reason named — never an enabled no-op', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX); // no `lifecycle` key at all
    expect(panel.actions.paperTrade.enabled).toBe(false);
    expect(panel.actions.paperTrade.reason).toContain('no lifecycle machine');
    expect(panel.actions.requireApproval.enabled).toBe(false);
    expect(panel.actions.requireApproval.reason).toContain('no lifecycle machine');
    expect(panel.header.lifecycleState).toBeNull();
  });

  it('a terminal machine disables both advance actions naming the abort', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const panel = buildDecisionPanel(card, {
      ...FULL_PANEL_CTX,
      lifecycle: { state: 'confirmed', terminal: true },
    });
    expect(panel.actions.paperTrade.enabled).toBe(false);
    expect(panel.actions.paperTrade.reason).toContain('terminal');
    expect(panel.actions.requireApproval.enabled).toBe(false);
    expect(panel.actions.requireApproval.reason).toContain('terminal');
  });

  it('TRA-4788 — a not_run card never claims a floor was tested; status + reasons ride the panel', () => {
    // No calibration in the context — the live state (TRA-4779): nothing was
    // folded, so the old fixed string "floor not cleared" asserted a
    // measurement that never happened.
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    expect(card.calibrationStatus).toBe('not_run');
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.actions.autoExecute.reason).toContain('calibration has never run');
    expect(panel.actions.autoExecute.reason).not.toContain('floor');
    expect(panel.calibrationStatus).toBe('not_run');
    expect(panel.calibrationReasons).toEqual(card.calibrationReasons);
  });

  it('an incomplete card disables Paper Trade and names the unverified fields', () => {
    // No sizing context ⇒ the card's sizing field fails closed.
    const card = buildTradeOpportunityCard(equitySignal(), { now: NOW, underlyingQuote: { bid: 99.98, ask: 100.02 } });
    expect(card.complete).toBe(false);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.actions.paperTrade.enabled).toBe(false);
    expect(panel.actions.paperTrade.reason).toContain('sizing');
    expect(panel.complete).toBe(false);
    // Risk section names the card field it could not read.
    expect(panel.risk.status).toBe('incomplete');
    expect(panel.risk.missing).toContain('sizing');
  });
});

// TRA-4654 (2026-09-22) — the risk section used to be ALL-OR-NOTHING: one
// absent upstream card field nulled the whole `data`, so the live 09-22 bqb1
// panel rendered a BLANK "how much can I lose" box for a card whose entry,
// stop, target, R:R, cost and holding period were every one of them computed.
// The blanks now populate per cell, each gap named in the card's own words —
// without relaxing the section status, which is what the gate reads.
describe('buildDecisionPanel — risk section fills cell by cell', () => {
  /** The live 09-22 shape: budget too small for one contract ⇒ sizing REFUSED. */
  const tinyBudget: CardBuildContext = {
    ...CARD_CTX,
    sizing: { managedEquity: 1_000, riskPerTrade: 0.01 },
  };

  it('a refused sizing still publishes entry/stop/target/R:R — the known numbers are not withheld', () => {
    const card = buildTradeOpportunityCard(otmSignal(), tinyBudget);
    expect(card.fields.sizing.status).toBe('refused');
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.risk.data).not.toBeNull();
    expect(panel.risk.data).toMatchObject({
      entry: 0.5,
      stop: 0.3,
      takeProfit: 1.0,
      quantity: 0,
      unit: 'contracts',
      costR: card.fields.costs.data!.costR,
    });
    expect(panel.risk.data!.rewardRisk).toBeCloseTo(2.5, 10);
    expect(panel.risk.data!.holdingPeriod).not.toBeNull();
  });

  it('a refused sizing is NOT a verified read: the zeros are the refusal, and the section says so', () => {
    const card = buildTradeOpportunityCard(otmSignal(), tinyBudget);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    // quantity 0 / max loss $0 are arithmetically true and would otherwise
    // verify the section. They must not.
    expect(panel.risk.data!.maxLossAtStopUsd).toBe(0);
    expect(panel.risk.status).toBe('incomplete');
    expect(panel.incompleteSections).toContain('risk');
    expect(panel.risk.missing.join(' ')).toContain('sizing refused');
    expect(panel.risk.data!.gaps).toEqual([
      { field: 'sizing', kind: 'refused', reasons: card.fields.sizing.missing },
    ]);
    // The reason is the card's own sentence, not a paraphrase.
    expect(panel.risk.data!.gaps[0].reasons.join(' ')).toContain('buys 0 contracts');
    // Gate unmoved.
    expect(panel.complete).toBe(false);
    expect(panel.actions.paperTrade.enabled).toBe(false);
  });

  it('an unbuildable field blanks ONLY its own cells, and is labelled unbuildable, not refused', () => {
    // No stop ⇒ invalidation and sizing have no data at all; the entry does.
    const card = buildTradeOpportunityCard(otmSignal({ stopLoss: Number.NaN }), CARD_CTX);
    expect(card.fields.invalidation.data).toBeNull();
    expect(card.fields.sizing.data).toBeNull();
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.risk.data).not.toBeNull();
    expect(panel.risk.data!.entry).toBe(0.5);
    expect(panel.risk.data!.stop).toBeNull();
    expect(panel.risk.data!.quantity).toBeNull();
    expect(panel.risk.data!.unit).toBeNull();
    expect(panel.risk.data!.maxLossAtStopUsd).toBeNull();
    // Targets go too — R:R is not derivable without the stop — but the entry
    // survives, which is the whole point.
    expect(panel.risk.data!.gaps.map(g => [g.field, g.kind])).toEqual([
      ['invalidation', 'unbuildable'],
      ['targets', 'unbuildable'],
      ['sizing', 'unbuildable'],
    ]);
    // Data failures are named ahead of any policy refusal.
    expect(panel.risk.missing.slice(0, 3)).toEqual(['invalidation', 'targets', 'sizing']);
    expect(panel.risk.status).toBe('incomplete');
    expect(panel.complete).toBe(false);
  });

  it('control: a fully verified card reports NO gaps and no null cells', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const panel = buildDecisionPanel(card, FULL_PANEL_CTX);
    expect(panel.risk.status).toBe('verified');
    expect(panel.risk.data!.gaps).toEqual([]);
    for (const k of ['entry', 'stop', 'quantity', 'unit', 'maxLossAtStopUsd'] as const) {
      expect(panel.risk.data![k]).not.toBeNull();
    }
  });
});

describe('buildDecisionPanel — assembly budget', () => {
  it('assembles in <100ms against an oversized book (500 positions, 5000 history rows)', () => {
    const card = buildTradeOpportunityCard(otmSignal(), CARD_CTX);
    const bigPositions: PanelPositionInput[] = Array.from({ length: 500 }, (_, i) => ({
      symbol: i % 7 === 0 ? 'SPY' : `SYM${i}`,
      kind: i % 2 === 0 ? 'equity' : 'option',
      signalType: i % 3 === 0 ? 'otm_mispricing' : 'momentum',
      quantity: 1 + (i % 5),
      notionalUsd: 100 + i,
      deltaShares: i % 11 === 0 ? null : i,
    }));
    const bigHistory: PanelHistoryInput[] = Array.from({ length: 5_000 }, (_, i) => ({
      symbol: i % 13 === 0 ? 'SPY' : `SYM${i % 40}`,
      signalType: i % 4 === 0 ? 'otm_mispricing' : 'momentum',
      closedAt: NOW - i * 60_000,
      pnlUsd: i % 9 === 0 ? null : (i % 2 === 0 ? 25 : -20),
      source: i % 2 === 0 ? 'equity_book' : 'options_book',
    }));
    const panel = buildDecisionPanel(card, {
      ...FULL_PANEL_CTX,
      positions: bigPositions,
      history: bigHistory,
    });
    expect(panel.incompleteSections).toEqual([]);
    expect(panel.assemblyMs).toBeLessThan(100);
  });
});
