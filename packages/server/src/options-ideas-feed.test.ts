import { describe, it, expect } from 'vitest';
import type { OptionChainRow } from '@trading-app/engine';
import type {
  OptionsResearchResult,
  OptionsResearchInput,
  OptionsResearchSymbol,
  OptionsScannerCandidate,
} from '@trading-app/agents';
import { DAY_TRADING_GUARDRAIL } from '@trading-app/shared';
import {
  buildOptionsIdeasFeed,
  buildEventsForSymbol,
  modelStructure,
  STRATEGY_DISPLAY,
} from './options-ideas-feed.js';

const EXP = '2026-07-17';

function candidate(part: Partial<OptionsScannerCandidate>): OptionsScannerCandidate {
  return {
    optionSymbol: 'MSFT260717P00420000',
    optionType: 'put',
    strike: 420,
    expiration: EXP,
    daysToExpiration: 35,
    mark: 4.2,
    ivUsed: 0.3,
    delta: -0.3,
    classification: 'cheap',
    mispricingPct: -0.2,
    source: 'relative_value',
    ...part,
  };
}

function callRow(strike: number, bid: number, ask: number): OptionChainRow {
  return { optionSymbol: `C${strike}`, underlying: 'MSFT', optionType: 'call', strike, expiration: EXP, bid, ask };
}
function putRow(strike: number, bid: number, ask: number): OptionChainRow {
  return { optionSymbol: `P${strike}`, underlying: 'MSFT', optionType: 'put', strike, expiration: EXP, bid, ask };
}

describe('buildEventsForSymbol', () => {
  it('builds earnings/FOMC/macro badges sorted soonest-first', () => {
    const sym: OptionsResearchSymbol = {
      symbol: 'MSFT',
      spot: 430,
      ivRank: 60,
      nextEarningsInDays: 3,
      daysToFOMC: 1,
      macroEventsNearby: ['CPI in 2d'],
      newsSentiment: null,
      candidates: [],
    };
    const events = buildEventsForSymbol(sym);
    expect(events.map((e) => e.kind)).toEqual(['fomc', 'cpi', 'earnings']);
    expect(events[0]).toEqual({ kind: 'fomc', label: 'FOMC', daysAway: 1 });
  });
});

describe('modelStructure', () => {
  const rows: OptionChainRow[] = [
    putRow(415, 2.9, 3.1), // mid 3.0
    putRow(420, 4.1, 4.3), // mid 4.2
    callRow(435, 4.9, 5.1), // mid 5.0
    callRow(440, 2.9, 3.1), // mid 3.0
  ];

  it('prices a bull put spread (credit) with defined max loss + breakeven', () => {
    const s = modelStructure('bull_put_spread', candidate({ strike: 420, optionType: 'put' }), 430, rows, 999);
    expect(s.legs).toEqual([
      { action: 'sell', optionType: 'put', strike: 420, expiration: EXP },
      { action: 'buy', optionType: 'put', strike: 415, expiration: EXP },
    ]);
    // credit = 4.2 - 3.0 = 1.2 → net +120, maxProfit 120
    expect(s.netUsd).toBeCloseTo(120, 4);
    expect(s.maxProfitUsd).toBeCloseTo(120, 4);
    // width 5 - credit 1.2 = 3.8 → maxLoss 380
    expect(s.maxLossUsd).toBeCloseTo(380, 4);
    // breakeven = 420 - 1.2 = 418.8
    expect(s.breakevens).toEqual([418.8]);
  });

  it('prices a bull call spread (debit) with defined max profit', () => {
    const s = modelStructure('bull_call_spread', candidate({ strike: 435, optionType: 'call' }), 430, rows, 999);
    // debit = c(435) 5.0 - c(440) 3.0 = 2.0 → net -200, maxLoss 200
    expect(s.netUsd).toBeCloseTo(-200, 4);
    expect(s.maxLossUsd).toBeCloseTo(200, 4);
    // width 5 - debit 2 = 3 → maxProfit 300
    expect(s.maxProfitUsd).toBeCloseTo(300, 4);
    expect(s.breakevens).toEqual([437]); // 435 + 2
  });

  it('falls back to the engine maxLoss when legs cannot be priced', () => {
    const s = modelStructure('bull_put_spread', candidate({ strike: 420 }), 430, [], 250);
    expect(s.maxLossUsd).toBe(250);
    expect(s.maxProfitUsd).toBe(250); // 1:1 placeholder
    expect(s.netUsd).toBe(250); // credit class → positive
  });

  it('caps long-call max profit as a sketch and floors max loss at the debit', () => {
    const s = modelStructure('long_call', candidate({ strike: 435, optionType: 'call' }), 430, rows, 999);
    expect(s.maxLossUsd).toBeCloseTo(500, 4); // 5.0 debit * 100
    expect(s.maxProfitUsd).toBeCloseTo(1000, 4); // 2x sketch cap
    expect(s.breakevens).toEqual([440]); // 435 + 5
    expect(s.netUsd).toBeCloseTo(-500, 4);
  });
});

describe('buildOptionsIdeasFeed', () => {
  const sym: OptionsResearchSymbol = {
    symbol: 'MSFT',
    spot: 430,
    ivRank: 64,
    nextEarningsInDays: null,
    daysToFOMC: 4,
    macroEventsNearby: [],
    newsSentiment: 0.1,
    candidates: [candidate({ strike: 420, optionType: 'put', mispricingPct: -0.25 })],
  };
  const input: OptionsResearchInput = { asOf: Date.parse('2026-06-06T15:00:00Z'), symbols: [sym] };
  const research: OptionsResearchResult = {
    ideas: [
      {
        ticker: 'MSFT',
        strategy: 'bull_put_spread',
        thesis: 'Elevated IV-rank into a quiet window; sell defined-risk premium below support.',
        pop: 0.72,
        maxLossUsd: 380,
        dteDays: 35,
        eventContext: ['Fed in 4d'],
        rank: 1,
      },
    ],
    costUsd: 0.01,
    attempts: 1,
    rejected: [],
    cached: false,
  };
  const rowsBySymbol = new Map<string, OptionChainRow[]>([
    ['MSFT', [putRow(415, 2.9, 3.1), putRow(420, 4.1, 4.3)]],
  ]);

  it('maps engine ideas to the panel feed shape with a live source + intent', () => {
    const { feed, intents } = buildOptionsIdeasFeed({
      research,
      input,
      rowsBySymbol,
      guardrail: DAY_TRADING_GUARDRAIL,
      generatedAt: 123,
    });
    expect(feed.source).toBe('live');
    expect(feed.generatedAt).toBe(123);
    expect(feed.noDayTrading.enforced).toBe(true);
    expect(feed.ideas).toHaveLength(1);
    const idea = feed.ideas[0]!;
    expect(idea.ticker).toBe('MSFT');
    expect(idea.strategy).toBe(STRATEGY_DISPLAY.bull_put_spread);
    expect(idea.underlyingPrice).toBe(430);
    expect(idea.ivRank).toBe(64);
    expect(idea.dte).toBe(35);
    expect(idea.pop).toBe(0.72);
    expect(idea.legs.length).toBe(2);
    expect(idea.events.map((e) => e.kind)).toEqual(['fomc']);
    // entry intent points at the anchor contract
    const intent = intents.get(idea.id)!;
    expect(intent.optionSymbol).toBe('MSFT260717P00420000');
    expect(intent.spot).toBe(430);
    // TRA-613 — the intent also carries the FULL modeled structure so
    // paper-enter can open the multi-leg defined-risk spread (not just the
    // anchor leg). The intent legs/payoff mirror the modeled idea exactly.
    expect(intent.strategy).toBe('bull_put_spread');
    expect(intent.legs).toEqual(idea.legs);
    expect(intent.legs.length).toBe(2);
    expect(intent.netUsd).toBe(idea.netUsd);
    expect(intent.maxLossUsd).toBe(idea.maxLossUsd);
    expect(intent.maxProfitUsd).toBe(idea.maxProfitUsd);
    expect(intent.breakevens).toEqual(idea.breakevens);
  });

  it('drops ideas whose symbol has no anchor candidate', () => {
    const noCand: OptionsResearchInput = { asOf: input.asOf, symbols: [{ ...sym, candidates: [] }] };
    const { feed } = buildOptionsIdeasFeed({
      research,
      input: noCand,
      rowsBySymbol,
      guardrail: DAY_TRADING_GUARDRAIL,
      generatedAt: 1,
    });
    expect(feed.ideas).toHaveLength(0);
  });
});
