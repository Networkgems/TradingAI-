// TRA-4719 (parent TRA-4413 item 3) — "reasons NOT to enter" on the card.
//
// What these lock down:
//   1. a flagged case per source, carrying the SOURCE'S OWN code (consulted,
//      not re-derived: expected codes come from calling the shipped evaluators
//      on the same inputs, never from literals a drifted copy would match);
//   2. a not-evaluated case per source, with the cause named;
//   3. the NEGATIVE CONTROL: with every source off the section reads all
//      `not_evaluated` — never `clear`;
//   4. display only: the section never moves `complete`, `incompleteFields`,
//      `confidence`, or the panel's completeness/actions;
//   5. the published counter is dense over source × state.

import { describe, it, expect } from 'vitest';
import type { Candle, OtmMispricingSignal, TradeSignal } from '@trading-app/shared';
import {
  buildReasonsNotToEnter,
  summarizeReasonsNotToEnter,
  isCardReasonsNotToEnterEnabled,
  CARD_REASONS_NOT_TO_ENTER_FLAG,
  REASON_SOURCES,
  REASON_STATES,
  type ReasonsCardFacts,
  type ReasonsNotToEnter,
  type ReasonsNotToEnterInputs,
  type ReasonSource,
} from './card-reasons-not-to-enter.js';
import { evaluateOtmUnderlyingConfirm } from './otm-underlying-confirm.js';
import { CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS } from '@trading-app/shared';
import type { PromotionDivergencePassRow } from './promotion-divergence-monitor.js';
import { buildTradeOpportunityCard, type CardBuildContext } from './trade-opportunity-card.js';
import { buildDecisionPanel } from './decision-panel.js';

const NOW = Date.parse('2026-09-17T15:00:00Z');

const OTM_FACTS: ReasonsCardFacts = {
  symbol: 'SPY',
  signalType: 'otm_mispricing',
  instrument: 'option',
  family: 'options_mispricing',
  optionType: 'call',
};
const EQUITY_FACTS: ReasonsCardFacts = {
  symbol: 'AAPL',
  signalType: 'momentum',
  instrument: 'underlying',
  family: 'trend',
  optionType: null,
};

function candle(close: number, i: number, volume = 1000, open = close): Candle {
  return {
    symbol: 'SPY',
    timestamp: i,
    open,
    high: Math.max(open, close) + 0.2,
    low: Math.min(open, close) - 0.6,
    close,
    volume,
  };
}
/** Flat tape: no trend, no channel break — both archetypes refuse. */
function flatSeries(n = 40): Candle[] {
  return Array.from({ length: n }, (_, i) => candle(100, i, 1000, 100));
}
/** Uptrend + pullback + bullish engulfing — the TRA-4639 confirming EMA shape. */
function confirmingCallSeries(): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i < 30; i++) bars.push(candle(100 + i, i, 1000, 100 + i - 0.5));
  const top = bars[bars.length - 1]!.close;
  bars.push({ ...candle(top - 2, 30, 1000, top), high: top, low: top - 4 });
  const prev = bars[bars.length - 1]!;
  bars.push({ ...candle(prev.open + 1, 31, 1000, prev.close - 0.5), high: prev.open + 1.5, low: prev.close - 1 });
  return bars;
}

function promoRow(strategyId: string, reasonCodes: PromotionDivergencePassRow['reasonCodes']): PromotionDivergencePassRow {
  return {
    strategyId,
    decisionId: 'dec-1',
    decidedAt: '2026-08-01T00:00:00Z',
    reasonCodes,
    minPopulation: 50,
    forward: null,
    arms: {
      expectancy: { state: 'clean', forward: null, basis: null, floor: null },
      slippage: { state: 'clean', ratio: null, cap: 1.5, sampleSize: 0 },
    },
    byMode: {},
    undated: 0,
  };
}

const ALL_ON: ReasonsNotToEnterInputs = {
  enabled: true,
  ivCrush: { enabled: true, calendar: { state: 'covered', days: 30, coveredSymbols: 10 } },
  underlying: { enabled: true, series: confirmingCallSeries(), readable: true },
  promotion: { enabled: true, rows: [promoRow('otm_mispricing', ['no_divergence'])] },
};

function row(sec: ReasonsNotToEnter, source: ReasonSource) {
  const r = sec.sources.find((s) => s.source === source);
  if (!r) throw new Error(`missing row ${source}`);
  return r;
}

describe('flag', () => {
  it('defaults OFF', () => {
    expect(isCardReasonsNotToEnterEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCardReasonsNotToEnterEnabled({ [CARD_REASONS_NOT_TO_ENTER_FLAG]: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('NEGATIVE CONTROL — every source off reads all not_evaluated, never clear', () => {
  it('section flag off: all rows not_evaluated / section_flag_off, even with clean inputs present', () => {
    for (const inputs of [undefined, { ...ALL_ON, enabled: false }]) {
      const sec = buildReasonsNotToEnter(OTM_FACTS, inputs);
      expect(sec.enabled).toBe(false);
      expect(sec.sources.map((r) => r.source)).toEqual([...REASON_SOURCES]);
      for (const r of sec.sources) {
        expect(r.state).toBe('not_evaluated');
        expect(r.notEvaluatedBecause).toBe('section_flag_off');
      }
      expect(sec.counts).toEqual({ clear: 0, flagged: 0, notEvaluated: REASON_SOURCES.length });
    }
  });

  it('section on, every source flag off: no row reads clear', () => {
    const sec = buildReasonsNotToEnter(OTM_FACTS, {
      enabled: true,
      ivCrush: { enabled: false, calendar: null },
      underlying: { enabled: false, series: [], readable: false },
      promotion: { enabled: false, rows: null },
    });
    expect(sec.counts.clear).toBe(0);
    expect(sec.counts.flagged).toBe(0);
    for (const r of sec.sources) expect(r.state).toBe('not_evaluated');
    expect(row(sec, 'iv_crush').notEvaluatedBecause).toBe('source_flag_off');
    expect(row(sec, 'ema_pullback').notEvaluatedBecause).toBe('source_flag_off');
    expect(row(sec, 'volume_breakout').notEvaluatedBecause).toBe('source_flag_off');
    expect(row(sec, 'promotion_divergence').notEvaluatedBecause).toBe('source_flag_off');
    expect(row(sec, 'gap_ranked').notEvaluatedBecause).toBe('no_detector');
  });
});

describe('iv_crush (evaluateOtmIvCrushDemoter)', () => {
  it('flagged: earnings inside the demote window', () => {
    const sec = buildReasonsNotToEnter(OTM_FACTS, {
      ...ALL_ON,
      ivCrush: { enabled: true, calendar: { state: 'covered', days: CATALYST_EARNINGS_DEMOTE_WITHIN_SESSIONS, coveredSymbols: 10 } },
    });
    expect(row(sec, 'iv_crush')).toMatchObject({ state: 'flagged', codes: ['ivcrush_demoted'] });
  });
  it('clear: covered outside the window, and uncovered (no earnings scheduled)', () => {
    expect(row(buildReasonsNotToEnter(OTM_FACTS, ALL_ON), 'iv_crush')).toMatchObject({ state: 'clear', codes: ['ivcrush_clear'] });
    const sec = buildReasonsNotToEnter(OTM_FACTS, {
      ...ALL_ON,
      ivCrush: { enabled: true, calendar: { state: 'uncovered', days: null, coveredSymbols: 10 } },
    });
    expect(row(sec, 'iv_crush')).toMatchObject({ state: 'clear', codes: ['ivcrush_no_earnings_scheduled'] });
  });
  it('not_evaluated: an unreadable calendar is the feed, never a clean pass', () => {
    for (const state of ['unloaded', 'unpopulated'] as const) {
      const sec = buildReasonsNotToEnter(OTM_FACTS, {
        ...ALL_ON,
        ivCrush: { enabled: true, calendar: { state, days: null, coveredSymbols: 0 } },
      });
      expect(row(sec, 'iv_crush')).toMatchObject({
        state: 'not_evaluated',
        notEvaluatedBecause: 'input_missing',
        codes: ['ivcrush_calendar_unreadable'],
      });
    }
  });
  it('not_evaluated: not applicable to an underlying card', () => {
    expect(row(buildReasonsNotToEnter(EQUITY_FACTS, ALL_ON), 'iv_crush').notEvaluatedBecause).toBe('not_applicable');
  });
});

describe('ema_pullback / volume_breakout (evaluateOtmUnderlyingConfirm)', () => {
  it('flagged: an unconfirmed underlying carries the archetype\'s own refusal code', () => {
    const series = flatSeries();
    const oracle = evaluateOtmUnderlyingConfirm('SPY', 'call', series, true);
    expect(oracle.ema.confirmed).toBe(false);
    expect(oracle.volume.confirmed).toBe(false);
    const sec = buildReasonsNotToEnter(OTM_FACTS, { ...ALL_ON, underlying: { enabled: true, series, readable: true } });
    expect(row(sec, 'ema_pullback')).toMatchObject({ state: 'flagged', codes: [oracle.ema.code] });
    expect(row(sec, 'volume_breakout')).toMatchObject({ state: 'flagged', codes: [oracle.volume.code] });
  });
  it('clear: the confirming EMA shape reads clear with ema_confirmed', () => {
    const oracle = evaluateOtmUnderlyingConfirm('SPY', 'call', confirmingCallSeries(), true);
    expect(oracle.ema.code).toBe('ema_confirmed');
    expect(row(buildReasonsNotToEnter(OTM_FACTS, ALL_ON), 'ema_pullback')).toMatchObject({ state: 'clear', codes: ['ema_confirmed'] });
  });
  it('not_evaluated: a cold/stale daily cache is input_missing, never flagged or clear', () => {
    const sec = buildReasonsNotToEnter(OTM_FACTS, { ...ALL_ON, underlying: { enabled: true, series: [], readable: false } });
    expect(row(sec, 'ema_pullback')).toMatchObject({ state: 'not_evaluated', notEvaluatedBecause: 'input_missing', codes: ['ema_series_unreadable'] });
    expect(row(sec, 'volume_breakout')).toMatchObject({ state: 'not_evaluated', notEvaluatedBecause: 'input_missing', codes: ['vb_series_unreadable'] });
  });
  it('not_evaluated: a too-short series is input_missing too', () => {
    const sec = buildReasonsNotToEnter(OTM_FACTS, { ...ALL_ON, underlying: { enabled: true, series: flatSeries(3), readable: true } });
    expect(row(sec, 'ema_pullback')).toMatchObject({ state: 'not_evaluated', codes: ['ema_insufficient_series'] });
  });
  it('not_evaluated: not applicable to an underlying card', () => {
    const sec = buildReasonsNotToEnter(EQUITY_FACTS, ALL_ON);
    expect(row(sec, 'ema_pullback').notEvaluatedBecause).toBe('not_applicable');
    expect(row(sec, 'volume_breakout').notEvaluatedBecause).toBe('not_applicable');
  });
});

describe('promotion_divergence (last TRA-4661 pass)', () => {
  it('flagged: the setup\'s strategy diverged', () => {
    const sec = buildReasonsNotToEnter(OTM_FACTS, {
      ...ALL_ON,
      promotion: { enabled: true, rows: [promoRow('otm_mispricing', ['expectancy_divergence', 'slippage_divergence'])] },
    });
    expect(row(sec, 'promotion_divergence')).toMatchObject({
      state: 'flagged',
      codes: ['expectancy_divergence', 'slippage_divergence'],
    });
  });
  it('clear only on no_divergence', () => {
    expect(row(buildReasonsNotToEnter(OTM_FACTS, ALL_ON), 'promotion_divergence')).toMatchObject({ state: 'clear', codes: ['no_divergence'] });
  });
  it('not_evaluated: insufficient population is NOT no_divergence', () => {
    const sec = buildReasonsNotToEnter(OTM_FACTS, {
      ...ALL_ON,
      promotion: { enabled: true, rows: [promoRow('otm_mispricing', ['insufficient_population'])] },
    });
    expect(row(sec, 'promotion_divergence')).toMatchObject({ state: 'not_evaluated', notEvaluatedBecause: 'input_missing', codes: ['insufficient_population'] });
  });
  it('not_evaluated: no pass yet, and no promotion record for the setup', () => {
    const noPass = buildReasonsNotToEnter(OTM_FACTS, { ...ALL_ON, promotion: { enabled: true, rows: null } });
    expect(row(noPass, 'promotion_divergence').notEvaluatedBecause).toBe('input_missing');
    const noRecord = buildReasonsNotToEnter(OTM_FACTS, {
      ...ALL_ON,
      promotion: { enabled: true, rows: [promoRow('bb_fade', ['expectancy_divergence'])] },
    });
    expect(row(noRecord, 'promotion_divergence')).toMatchObject({ state: 'not_evaluated', notEvaluatedBecause: 'not_applicable' });
  });
});

describe('gap_ranked — named missing, no detector built', () => {
  it('OTM family: no_detector; other families: not_applicable; never clear or flagged', () => {
    expect(row(buildReasonsNotToEnter(OTM_FACTS, ALL_ON), 'gap_ranked').notEvaluatedBecause).toBe('no_detector');
    expect(row(buildReasonsNotToEnter(EQUITY_FACTS, ALL_ON), 'gap_ranked').notEvaluatedBecause).toBe('not_applicable');
  });
});

// ── Card + panel integration: display only ──────────────────────────────────

function otmSignal(): OtmMispricingSignal {
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
    expiration: new Date(NOW + 35 * 86_400_000).toISOString().slice(0, 10),
    mark: 0.5,
    theo: 0.65,
    mispricingPct: -0.2308,
    delta: 0.1,
    bid: 0.48,
    ask: 0.52,
  };
}
const CTX: CardBuildContext = {
  now: NOW,
  sizing: { managedEquity: 50_000, riskPerTrade: 0.01 },
  optionLiquidity: { openInterest: 500, volume: 120, marketPhase: 'rth' },
};

describe('card + panel — the section is display only', () => {
  const flaggedInputs: ReasonsNotToEnterInputs = {
    ...ALL_ON,
    ivCrush: { enabled: true, calendar: { state: 'covered', days: 0, coveredSymbols: 10 } },
    promotion: { enabled: true, rows: [promoRow('otm_mispricing', ['expectancy_divergence'])] },
  };

  it('flags never move complete / incompleteFields / confidence', () => {
    const base = buildTradeOpportunityCard(otmSignal() as TradeSignal, CTX);
    const flaggedCard = buildTradeOpportunityCard(otmSignal() as TradeSignal, { ...CTX, reasonsNotToEnter: flaggedInputs });
    expect(flaggedCard.reasonsNotToEnter!.counts.flagged).toBeGreaterThanOrEqual(2);
    expect(flaggedCard.complete).toBe(base.complete);
    expect(flaggedCard.complete).toBe(true);
    expect(flaggedCard.incompleteFields).toEqual(base.incompleteFields);
    expect(flaggedCard.confidence).toBe(base.confidence);
    expect(flaggedCard.fields).toEqual(base.fields);
  });

  it('a card built with no inputs carries the section, all not_evaluated', () => {
    const card = buildTradeOpportunityCard(otmSignal() as TradeSignal, CTX);
    expect(card.reasonsNotToEnter!.counts.notEvaluated).toBe(REASON_SOURCES.length);
  });

  it('the panel surfaces it and its completeness/actions ignore it', () => {
    const base = buildTradeOpportunityCard(otmSignal() as TradeSignal, CTX);
    const flaggedCard = buildTradeOpportunityCard(otmSignal() as TradeSignal, { ...CTX, reasonsNotToEnter: flaggedInputs });
    const pctx = { now: NOW, positions: [], history: [], totalEquityUsd: 50_000 };
    const p0 = buildDecisionPanel(base, pctx);
    const p1 = buildDecisionPanel(flaggedCard, pctx);
    expect(p1.reasonsNotToEnter).toEqual(flaggedCard.reasonsNotToEnter);
    expect(p1.complete).toBe(p0.complete);
    expect(p1.incompleteSections).toEqual(p0.incompleteSections);
    expect(p1.actions).toEqual(p0.actions);
  });

  it('a hand-built card with no section reads all not_evaluated on the panel, never clear', () => {
    const card = buildTradeOpportunityCard(otmSignal() as TradeSignal, CTX);
    delete card.reasonsNotToEnter;
    const panel = buildDecisionPanel(card, { now: NOW });
    expect(panel.reasonsNotToEnter.counts.clear).toBe(0);
    expect(panel.reasonsNotToEnter.counts.notEvaluated).toBe(REASON_SOURCES.length);
  });
});

describe('published counter — cards by source × state', () => {
  it('is dense, folds each card once per source, and counts a missing section as not_evaluated', () => {
    const flagged = buildReasonsNotToEnter(OTM_FACTS, {
      ...ALL_ON,
      ivCrush: { enabled: true, calendar: { state: 'covered', days: 0, coveredSymbols: 10 } },
    });
    const clean = buildReasonsNotToEnter(OTM_FACTS, ALL_ON);
    const tally = summarizeReasonsNotToEnter([flagged, clean, undefined]);
    expect(tally.cards).toBe(3);
    for (const s of REASON_SOURCES) {
      for (const st of REASON_STATES) expect(typeof tally.bySource[s][st]).toBe('number');
      const total = REASON_STATES.reduce((a, st) => a + tally.bySource[s][st], 0);
      expect(total).toBe(3);
    }
    expect(tally.bySource.iv_crush).toEqual({ clear: 1, flagged: 1, not_evaluated: 1 });
    expect(tally.notEvaluatedBecause.iv_crush.section_flag_off).toBe(1);
    expect(tally.bySource.gap_ranked).toEqual({ clear: 0, flagged: 0, not_evaluated: 3 });
    expect(tally.notEvaluatedBecause.gap_ranked.no_detector).toBe(2);
  });
});
