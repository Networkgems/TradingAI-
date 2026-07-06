import { describe, it, expect } from 'vitest';
import type { OptionChainRow } from '@trading-app/engine';
import { evaluateMultiLegPreTrade } from '@trading-app/engine';
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

  it('caps long-put max profit at the lesser of the 2x sketch and the true (strike - debit) max', () => {
    // A low-strike put: true max (strike - debit) is SMALLER than the 2x sketch,
    // so the bound must win (a put is not "unbounded").
    const putRows: OptionChainRow[] = [putRow(5, 1.9, 2.1), putRow(6, 2.9, 3.1)]; // mids 2.0, 3.0
    const s = modelStructure('long_put', candidate({ strike: 6, optionType: 'put' }), 10, putRows, 999);
    expect(s.maxLossUsd).toBeCloseTo(300, 4); // 3.0 debit * 100
    // min(2*3.0, 6-3.0)=min(6,3)=3.0 → 300, NOT the 600 the old sketch would show
    expect(s.maxProfitUsd).toBeCloseTo(300, 4);
    expect(s.breakevens).toEqual([3]); // 6 - 3
    expect(s.netUsd).toBeCloseTo(-300, 4);
  });

  it('prices an iron condor by snapping long wings to the chain when the increment != median step', () => {
    // Put increments tighten in (5) but the long wing falls on an unlisted
    // arithmetic strike (425 - 5 = 420 not listed); call increments are uneven.
    // Pre-fix this dropped the whole condor to the 1:1 fallback; snapping fixes it.
    const condorRows: OptionChainRow[] = [
      putRow(410, 1.0, 1.2),
      putRow(415, 1.9, 2.1), // long wing, mid 2.0
      putRow(425, 3.9, 4.1), // short, mid 4.0
      putRow(430, 5.0, 5.2),
      callRow(430, 5.0, 5.2),
      callRow(435, 3.9, 4.1), // short, mid 4.0
      callRow(442, 1.4, 1.6), // long wing, mid 1.5
      callRow(450, 0.5, 0.7),
    ];
    // optionType 'put' → step derives from putStrikes median gap = 5.
    const s = modelStructure('iron_condor', candidate({ strike: 425, optionType: 'put' }), 430, condorRows, 999);
    expect(s.priced).toBe(true); // priced off real marks, not the fallback sketch
    expect(s.legs).toEqual([
      { action: 'sell', optionType: 'put', strike: 425, expiration: EXP },
      { action: 'buy', optionType: 'put', strike: 415, expiration: EXP }, // snapped from 420
      { action: 'sell', optionType: 'call', strike: 435, expiration: EXP },
      { action: 'buy', optionType: 'call', strike: 442, expiration: EXP }, // snapped from 440
    ]);
    // credit = ps - pl + cs - cl = 4.0 - 2.0 + 4.0 - 1.5 = 4.5 → maxProfit 450
    expect(s.maxProfitUsd).toBeCloseTo(450, 4);
    expect(s.netUsd).toBeCloseTo(450, 4);
    // width = max(442 - 435, 425 - 415) = 10 → maxLoss (10 - 4.5)*100 = 550
    expect(s.maxLossUsd).toBeCloseTo(550, 4);
    expect(s.breakevens).toEqual([420.5, 439.5]); // [425 - 4.5, 435 + 4.5]
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
        catalystHorizon: 'medium',
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

  // TRA-1121 (TRA-1118 "Flag" policy) / TRA-1348 governor — the modeled bull put
  // spread above has a single-lot max loss of $380. On a $6k book the 5% clamp
  // caps the ceiling at $300 (< $380) so it busts; on a $25k+ book the default
  // 2% cap / $500 floor governor admits it.
  describe('enterability gate (TRA-1121 / TRA-1348)', () => {
    it('flags an idea whose single-lot max loss busts the governor ceiling: enterable:false + reason + intent guarded', () => {
      const { feed, intents } = buildOptionsIdeasFeed({
        research,
        input,
        rowsBySymbol,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd: 6_000, // 5% clamp -> $300 ceiling < $380 max loss
      });
      const idea = feed.ideas[0]!;
      expect(idea.maxLossUsd).toBeCloseTo(380, 4);
      expect(idea.enterable).toBe(false);
      expect(idea.entryBlockedReason).toBeTruthy();
      // No enabled-button path: the intent is omitted so a direct POST is a 404,
      // not a reach into the open path that the gate would 409.
      expect(intents.has(idea.id)).toBe(false);
    });

    it('leaves an idea within the cap enterable:true with its intent intact', () => {
      const { feed, intents } = buildOptionsIdeasFeed({
        research,
        input,
        rowsBySymbol,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd: 100_000, // 2% cap = $2000 > $380 max loss
      });
      const idea = feed.ideas[0]!;
      expect(idea.enterable).toBe(true);
      expect(idea.entryBlockedReason).toBeUndefined();
      expect(intents.has(idea.id)).toBe(true);
    });

    it('omits enterable for back-compat when no account equity is threaded', () => {
      const { feed, intents } = buildOptionsIdeasFeed({
        research,
        input,
        rowsBySymbol,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
      });
      const idea = feed.ideas[0]!;
      expect(idea.enterable).toBeUndefined();
      expect(idea.entryBlockedReason).toBeUndefined();
      expect(intents.has(idea.id)).toBe(true);
    });

    it('feed enterability equals the gate result (one source of truth, no re-derived threshold)', () => {
      const accountEquityUsd = 6_000; // 5% clamp -> $300 ceiling < $380 -> blocked
      const { feed } = buildOptionsIdeasFeed({
        research,
        input,
        rowsBySymbol,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd,
      });
      const idea = feed.ideas[0]!;
      // Independently run the SAME gate the open path uses; the feed flag and the
      // reason must match it verbatim — never an independently-derived inequality.
      const verdict = evaluateMultiLegPreTrade({
        accountEquity: accountEquityUsd,
        optionBuyingPower: null,
        maxLossPerLot: idea.maxLossUsd,
        contracts: 1,
      });
      expect(verdict.allowed).toBe(false);
      expect(idea.enterable).toBe(false);
      if (!verdict.allowed) expect(idea.entryBlockedReason).toBe(verdict.reason);
    });

    it('the $500 absolute floor admits a standard lot on a mid-size book (TRA-1348)', () => {
      // $15k book: 2% cap = $300 < $380 max loss, but the $500 absolute floor
      // (min($500, 5%×$15k=$750) = $500) lifts the ceiling → enterable.
      const { feed } = buildOptionsIdeasFeed({
        research,
        input,
        rowsBySymbol,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd: 15_000,
      });
      expect(feed.ideas[0]!.enterable).toBe(true);
    });

    it('honors a custom maxLossPctCap above the default', () => {
      // $100k book, $380 lot. A tight 0.001 cap = $100; but the $500 floor still
      // admits it. Raising the cap to 5% ($5000) keeps it enterable regardless.
      const { feed } = buildOptionsIdeasFeed({
        research,
        input,
        rowsBySymbol,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd: 100_000,
        maxLossPctCap: 0.05,
      });
      expect(feed.ideas[0]!.enterable).toBe(true);
    });
  });
});
