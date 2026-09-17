// TRA-4649 — Trade Opportunity Card builder.
//
// The controls here are the point: a card system whose failure mode is "field
// silently defaulted" reads identically in pass and fail, so every negative
// test asserts the SPECIFIC missing-input string, and the cost/sizing
// expectations are derived by CALLING the shipped symbols (netEdgeCostBreakdown,
// sizeFromStopViaRiskManager) on the same inputs — never by re-typing their
// arithmetic as literals a drifted copy would still match.

import { describe, it, expect } from 'vitest';
import type { OtmMispricingSignal, SignalType, TradeSignal } from '@trading-app/shared';
import {
  buildTradeOpportunityCard,
  buildCards,
  registeredCardTypes,
  type CardBuildContext,
} from './trade-opportunity-card.js';
import { netEdgeCostBreakdown, DEFAULT_NET_EDGE_BAR_CONFIG } from './option-net-edge-bar.js';
import { sizeFromStopViaRiskManager } from './account-sizing.js';

const NOW = Date.parse('2026-09-17T15:00:00Z');

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

const FULL_CTX: CardBuildContext = {
  now: NOW,
  sizing: { managedEquity: 50_000, riskPerTrade: 0.01 },
  underlyingQuote: { bid: 99.98, ask: 100.02 },
  optionLiquidity: { openInterest: 500, volume: 120, marketPhase: 'rth' },
};

describe('buildTradeOpportunityCard — complete cards', () => {
  it('a fully-specified OTM option signal verifies all 8 fields', () => {
    const card = buildTradeOpportunityCard(otmSignal(), FULL_CTX);
    expect(card.incompleteFields).toEqual([]);
    expect(card.complete).toBe(true);
    for (const field of Object.values(card.fields)) {
      expect(field.status).toBe('verified');
      expect(field.missing).toEqual([]);
      expect(field.data).not.toBeNull();
    }
    expect(card.fields.setup.data).toMatchObject({
      signalType: 'otm_mispricing',
      family: 'options_mispricing',
      instrument: 'option',
    });
    // Holding period is DTE-bounded, not the nominal map.
    expect(card.fields.targets.data!.holdingPeriod).toMatchObject({ maxDays: 35, basis: 'to_expiration' });
    expect(card.fields.targets.data!.rewardRiskRecomputed).toBeCloseTo(2.5, 10);
  });

  it('option cost field equals the SHIPPED netEdgeCostBreakdown on the same inputs', () => {
    const sig = otmSignal();
    const card = buildTradeOpportunityCard(sig, FULL_CTX);
    const shipped = netEdgeCostBreakdown(
      { mark: sig.mark, bid: sig.bid, ask: sig.ask, riskPerShare: sig.entryPrice - sig.stopLoss },
      DEFAULT_NET_EDGE_BAR_CONFIG.feesPerContractRoundTrip,
    );
    expect(shipped).not.toBeNull();
    expect(card.fields.costs.data).toMatchObject({
      spreadPerShare: shipped!.spreadPerShare,
      feesPerShare: shipped!.feesPerShare,
      costPerShare: shipped!.costPerShare,
      riskPerShare: shipped!.riskPerShare,
      costR: shipped!.costR,
      costFracOfPremium: shipped!.costFracOfPremium,
    });
    expect(card.fields.costs.data!.exceedsAbsCeiling).toBe(
      shipped!.costFracOfPremium > DEFAULT_NET_EDGE_BAR_CONFIG.absCostFracCeiling,
    );
  });

  it('option sizing floors the risk budget by per-contract stop risk and states the hard premium loss', () => {
    const card = buildTradeOpportunityCard(otmSignal(), FULL_CTX);
    // budget 500 / (0.20 × 100 per contract) = 25 contracts
    expect(card.fields.sizing.data).toMatchObject({
      unit: 'contracts',
      quantity: 25,
      riskBudget: 500,
      maxLossAtStop: 500,
      maxLossHard: 25 * 0.5 * 100,
    });
  });

  it('a fully-specified equity signal verifies all 8 fields and sizes via the shipped RiskManager path', () => {
    const card = buildTradeOpportunityCard(equitySignal(), FULL_CTX);
    expect(card.incompleteFields).toEqual([]);
    const shippedQty = sizeFromStopViaRiskManager(100, 95, {
      managedEquity: 50_000,
      riskPerTrade: 0.01,
      fractionalQuantity: false,
    });
    expect(shippedQty).toBeGreaterThan(0);
    expect(card.fields.sizing.data).toMatchObject({ unit: 'shares', quantity: shippedQty });
    expect(card.fields.contract.data).toMatchObject({ kind: 'underlying', symbol: 'AAPL' });
    expect(card.fields.costs.data!.costFracOfPremium).toBeNull();
  });

  it('liquidity analysis carries the edge/spread discriminator for modeled-fair-value signals', () => {
    const card = buildTradeOpportunityCard(otmSignal(), FULL_CTX);
    const liq = card.fields.contract.data!.liquidity;
    expect(liq.edgePerShare).toBeCloseTo(0.15, 10); // theo 0.65 − mark 0.50
    expect(liq.edgeToSpread).toBeCloseTo(0.15 / (0.52 - 0.48), 10);
    expect(liq.openInterest).toBe(500);
  });

  it('every card is a proposal: disposition fixed, confidence null (reserved for TRA-4652)', () => {
    for (const sig of [equitySignal(), otmSignal()]) {
      const card = buildTradeOpportunityCard(sig, FULL_CTX);
      expect(card.disposition).toBe('proposal_only');
      expect(card.confidence).toBeNull();
      expect('execute' in card).toBe(false);
    }
  });
});

describe('buildTradeOpportunityCard — fail-closed negative controls', () => {
  it('missing option quote fails contract, costs AND the entry trigger — never a defaulted number', () => {
    const card = buildTradeOpportunityCard(otmSignal({ bid: undefined, ask: undefined }), FULL_CTX);
    expect(card.complete).toBe(false);
    expect(card.incompleteFields).toContain('contract');
    expect(card.incompleteFields).toContain('costs');
    expect(card.incompleteFields).toContain('entryTrigger');
    expect(card.fields.costs.data).toBeNull();
    expect(card.fields.costs.missing[0]).toMatch(/quote unusable/);
    expect(card.fields.contract.missing[0]).toMatch(/two-sided option quote/);
  });

  it('a mark outside its own quote fails the entry trigger (stale mark)', () => {
    const card = buildTradeOpportunityCard(otmSignal({ mark: 0.6, entryPrice: 0.6 }), FULL_CTX);
    expect(card.fields.entryTrigger.status).toBe('incomplete');
    expect(card.fields.entryTrigger.missing).toContain('entry criterion failed: mark_within_quote');
  });

  it('absent sizing context fails ONLY the sizing field', () => {
    const { sizing: _omitted, ...rest } = FULL_CTX;
    const card = buildTradeOpportunityCard(otmSignal(), rest);
    expect(card.incompleteFields).toEqual(['sizing']);
    expect(card.fields.sizing.missing[0]).toMatch(/sizing basis missing/);
  });

  it('a risk budget below one contract fails closed instead of rounding up to 1', () => {
    const card = buildTradeOpportunityCard(otmSignal(), {
      ...FULL_CTX,
      sizing: { managedEquity: 1_000, riskPerTrade: 0.01 }, // $10 budget vs $20/contract risk
    });
    expect(card.fields.sizing.status).toBe('incomplete');
    expect(card.fields.sizing.missing[0]).toMatch(/buys 0 contracts/);
  });

  it('a stale signal fails whyNow with the measured age, not a silent pass', () => {
    const card = buildTradeOpportunityCard(
      otmSignal({ timestamp: NOW - 3 * 3_600_000 }), // 3h old vs 60m options ceiling
      FULL_CTX,
    );
    expect(card.fields.whyNow.status).toBe('incomplete');
    expect(card.fields.whyNow.missing[0]).toMatch(/signal stale: age 180m exceeds the 60m ceiling/);
    // The context itself is still populated for display — only the verify fails.
    expect(card.fields.whyNow.data!.evidence.join(' ')).toMatch(/mispricingPct/);
  });

  it('a stop on the wrong side of entry fails invalidation and the trigger criterion', () => {
    const card = buildTradeOpportunityCard(equitySignal({ stopLoss: 105 }), FULL_CTX);
    expect(card.fields.invalidation.status).toBe('incomplete');
    expect(card.fields.invalidation.missing[0]).toMatch(/wrong side of entry/);
    expect(card.fields.entryTrigger.missing).toContain(
      'entry criterion failed: protective_stop_on_thesis_side',
    );
  });

  it('a stated riskRewardRatio inconsistent with the card levels fails targets', () => {
    const card = buildTradeOpportunityCard(equitySignal({ riskRewardRatio: 5 }), FULL_CTX);
    expect(card.fields.targets.status).toBe('incomplete');
    expect(card.fields.targets.missing[0]).toMatch(/inconsistent with recomputed 3\.000/);
  });

  it('an expired contract fails targets', () => {
    const card = buildTradeOpportunityCard(otmSignal({ expiration: '2026-09-01' }), FULL_CTX);
    expect(card.fields.targets.status).toBe('incomplete');
    expect(card.fields.targets.missing[0]).toMatch(/in the past/);
  });

  it('a suppressed signal can never yield a complete, actionable card', () => {
    const card = buildTradeOpportunityCard(
      equitySignal({ signalSkipReason: 'MR shorts off-strategy' }),
      FULL_CTX,
    );
    expect(card.complete).toBe(false);
    expect(card.fields.entryTrigger.missing).toContain('entry criterion failed: not_suppressed');
  });

  it('missing underlying quote fails contract and costs for equity signals', () => {
    const { underlyingQuote: _omitted, ...rest } = FULL_CTX;
    const card = buildTradeOpportunityCard(equitySignal(), rest);
    expect(card.incompleteFields).toContain('contract');
    expect(card.incompleteFields).toContain('costs');
  });
});

describe('registry coverage', () => {
  it('every current SignalType member is registered in the card system', () => {
    // The registry is string-keyed (not an exhaustive Record) so in-flight
    // SignalType widenings don't break someone else's push; THIS test is where
    // coverage of the current union is graded instead.
    const currentUnion: SignalType[] = [
      'orb_breakout', 'reversal', 'macd_cross', 'macd_trend', 'bb_fade',
      'momentum', 'mean_reversion', 'breakout_vol', 'ichimoku', 'scalping',
      'swing_trade', 'dca', 'otm_mispricing', 'relative_value',
      'sma200_pullback', 'sma200_reclaim', 'supertrend_confluence',
      'tsmom_majors', 'tradier_import',
    ];
    const registered = registeredCardTypes();
    for (const t of currentUnion) {
      expect(registered).toContain(t);
    }
  });

  it('an unregistered signal type STILL produces a card, failed closed on the registry fields', () => {
    const sig = equitySignal({ type: 'never_heard_of_it' as SignalType });
    const card = buildTradeOpportunityCard(sig, FULL_CTX);
    expect(card.complete).toBe(false);
    expect(card.fields.setup.status).toBe('incomplete');
    expect(card.fields.setup.missing[0]).toMatch(/not registered in the card system/);
    expect(card.fields.targets.status).toBe('incomplete');
    expect(card.fields.whyNow.status).toBe('incomplete');
    // Level-derived fields still verify — the hole is named, not contagious.
    expect(card.fields.entryTrigger.status).toBe('verified');
    expect(card.fields.costs.status).toBe('verified');
    expect(card.fields.sizing.status).toBe('verified');
  });
});

describe('rule-exit setups', () => {
  it('an sma200 signal (no takeProfit by type) verifies targets on the exit rule', () => {
    const sig = {
      ...equitySignal({ type: 'sma200_pullback' }),
      takeProfit: undefined,
      riskRewardRatio: undefined,
    } as unknown as TradeSignal;
    const card = buildTradeOpportunityCard(sig, FULL_CTX);
    expect(card.fields.targets.status).toBe('verified');
    expect(card.fields.targets.data).toMatchObject({ basis: 'rule_exit', takeProfit: null });
    expect(card.fields.targets.data!.exitRule).toMatch(/200SMA/);
  });
});

describe('buildCards batch + acceptance fold', () => {
  it('builds a card for EVERY signal and folds the missing-field tally', () => {
    const signals: TradeSignal[] = [
      equitySignal(),
      otmSignal(),
      otmSignal({ id: 'sig-otm-2', bid: undefined, ask: undefined }),
      equitySignal({ id: 'sig-eq-2', timestamp: NOW - 100 * 3_600_000 }),
    ];
    const { cards, summary } = buildCards(signals, FULL_CTX);
    expect(cards).toHaveLength(4);
    expect(summary.total).toBe(4);
    expect(summary.complete).toBe(2);
    expect(summary.incomplete).toBe(2);
    expect(summary.missingByField).toMatchObject({
      contract: 1,
      costs: 1,
      entryTrigger: 1,
      whyNow: 1,
    });
  });

  it('pre-market liquidity carries the volume-is-not-a-discriminator note', () => {
    const card = buildTradeOpportunityCard(otmSignal(), {
      ...FULL_CTX,
      optionLiquidity: { openInterest: 500, volume: 0, marketPhase: 'pre' },
    });
    expect(card.fields.contract.data!.liquidity.notes.join(' ')).toMatch(/not a liquidity discriminator/);
  });
});
