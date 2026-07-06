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
  ideaPopPlacementCoherent,
  sizeSpreadContractsToCap,
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

  // TRA-1360 — the reported live defect: the scanner anchor is picked by
  // |mispricing| across ALL of a symbol's candidates, so a bear call spread
  // could snap its short call onto a deep-ITM anchor strike (270) far below spot
  // (386), pricing an ITM spread as if it were the OTM one the thesis intended.
  // The short leg must be pulled to the OTM side of spot so strikes/credit/
  // breakeven are coherent with the reported (OTM, > 0.5 POP) idea.
  it('places a credit bear-call short leg OTM even when the scanner anchor is deep ITM', () => {
    const otmCalls: OptionChainRow[] = [
      callRow(390, 5.9, 6.1), // mid 6.0 — first OTM above spot 386
      callRow(395, 3.9, 4.1), // mid 4.0
      callRow(400, 1.9, 2.1), // mid 2.0
    ];
    // Anchor is a deep-ITM call at 270 (spot 386) — the exact live mis-map.
    const s = modelStructure('bear_call_spread', candidate({ strike: 270, optionType: 'call' }), 386, otmCalls, 999);
    expect(s.legs).toEqual([
      { action: 'sell', optionType: 'call', strike: 390, expiration: EXP }, // OTM, not 270
      { action: 'buy', optionType: 'call', strike: 395, expiration: EXP },
    ]);
    // Short strike is strictly above spot — a coherent OTM credit spread.
    expect(s.legs[0]!.strike).toBeGreaterThan(386);
    // credit = 6.0 - 4.0 = 2.0 → net +200, maxProfit 200; width 5 → maxLoss 300.
    expect(s.netUsd).toBeCloseTo(200, 4);
    expect(s.maxLossUsd).toBeCloseTo(300, 4);
    expect(s.breakevens).toEqual([392]); // 390 + 2
    expect(s.priced).toBe(true);
  });

  it('honors an already-OTM bull-put anchor unchanged (short put stays below spot)', () => {
    const s = modelStructure('bull_put_spread', candidate({ strike: 420, optionType: 'put' }), 430, rows, 999);
    expect(s.legs[0]).toEqual({ action: 'sell', optionType: 'put', strike: 420, expiration: EXP });
    expect(s.legs[0]!.strike).toBeLessThan(430);
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

describe('ideaPopPlacementCoherent (TRA-1360)', () => {
  const structFor = (short: { optionType: 'call' | 'put'; strike: number }) => ({
    legs: [
      { action: 'sell' as const, ...short, expiration: EXP },
      { action: 'buy' as const, optionType: short.optionType, strike: short.strike + 5, expiration: EXP },
    ],
    breakevens: [short.strike],
    maxLossUsd: 300,
    maxProfitUsd: 200,
    netUsd: 200,
    priced: true,
  });

  it('rejects a deep-ITM bear-call credit spread carrying a > 0.5 POP (the live defect)', () => {
    // sell 270C with spot 386 is ~116 pts ITM → ~certain max loss; POP 0.72 is incoherent.
    expect(ideaPopPlacementCoherent('bear_call_spread', structFor({ optionType: 'call', strike: 270 }), 386, 0.72)).toBe(false);
  });

  it('rejects an ITM bull-put credit spread carrying a > 0.5 POP', () => {
    // sell 420P with spot 386 is ITM for a put → ~certain max loss.
    expect(ideaPopPlacementCoherent('bull_put_spread', structFor({ optionType: 'put', strike: 420 }), 386, 0.72)).toBe(false);
  });

  it('accepts an OTM credit spread with a > 0.5 POP (coherent)', () => {
    expect(ideaPopPlacementCoherent('bear_call_spread', structFor({ optionType: 'call', strike: 400 }), 386, 0.72)).toBe(true);
    expect(ideaPopPlacementCoherent('bull_put_spread', structFor({ optionType: 'put', strike: 370 }), 386, 0.72)).toBe(true);
  });

  it('accepts an ITM-short credit spread when its POP is honestly low (<= 0.5)', () => {
    expect(ideaPopPlacementCoherent('bear_call_spread', structFor({ optionType: 'call', strike: 270 }), 386, 0.2)).toBe(true);
  });

  it('does not gate debit verticals (not the reported defect)', () => {
    expect(ideaPopPlacementCoherent('bull_call_spread', structFor({ optionType: 'call', strike: 270 }), 386, 0.9)).toBe(true);
  });
});

describe('sizeSpreadContractsToCap (TRA-1356)', () => {
  it('fills the largest whole-lot count that still fits under the cap', () => {
    expect(sizeSpreadContractsToCap(18, 500)).toBe(27); // floor(500/18)
    expect(sizeSpreadContractsToCap(232, 500)).toBe(2); // floor(500/232)
    expect(sizeSpreadContractsToCap(498, 500)).toBe(1); // floor(500/498)
  });

  it('never returns below 1, even when a single lot already busts the cap', () => {
    expect(sizeSpreadContractsToCap(568, 500)).toBe(1); // 1 lot > cap → gate flags it
  });

  it('every enterable fill lands above 50% of the cap', () => {
    // For any per-lot loss <= cap, floor(cap/perLot)*perLot > cap/2.
    for (const perLot of [10, 49, 130, 251, 300, 460, 499]) {
      const lots = sizeSpreadContractsToCap(perLot, 500);
      expect(lots * perLot).toBeGreaterThan(250);
    }
  });

  it('guards non-finite / non-positive inputs to a single lot', () => {
    expect(sizeSpreadContractsToCap(0, 500)).toBe(1);
    expect(sizeSpreadContractsToCap(-5, 500)).toBe(1);
    expect(sizeSpreadContractsToCap(NaN, 500)).toBe(1);
    expect(sizeSpreadContractsToCap(100, 0)).toBe(1);
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

  // TRA-1360 — end-to-end coherence guard. When the chain can only place the
  // credit short leg ITM (no OTM strikes listed), the modeled deep-ITM bear call
  // is incoherent with the LLM's POP 0.72, so the feed drops it entirely rather
  // than rendering the live 270/275-vs-386 card. No idea, no intent.
  it('drops an incoherent deep-ITM credit spread (POP contradicts strike placement)', () => {
    const bearSym: OptionsResearchSymbol = {
      ...sym,
      spot: 386,
      candidates: [candidate({ optionSymbol: 'MSFT260717C00270000', strike: 270, optionType: 'call', mispricingPct: 0.4 })],
    };
    const bearInput: OptionsResearchInput = { asOf: input.asOf, symbols: [bearSym] };
    const bearResearch: OptionsResearchResult = {
      ...research,
      ideas: [{ ...research.ideas[0]!, strategy: 'bear_call_spread', pop: 0.72 }],
    };
    // Only deep-ITM call strikes are listed — no OTM strike to pull the short to.
    const itmOnly = new Map<string, OptionChainRow[]>([
      ['MSFT', [callRow(270, 116.9, 117.1), callRow(275, 111.9, 112.1)]],
    ]);
    const { feed, intents } = buildOptionsIdeasFeed({
      research: bearResearch,
      input: bearInput,
      rowsBySymbol: itmOnly,
      guardrail: DAY_TRADING_GUARDRAIL,
      generatedAt: 1,
    });
    expect(feed.ideas).toHaveLength(0);
    expect(intents.size).toBe(0);
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

    // TRA-1356 — the spread is sized toward the per-trade cap so its displayed
    // max loss targets a consistent fraction of the risk budget instead of a
    // single trivially-thin lot. $380/lot vs a $2000 cap (2% of $100k) → 5 lots
    // ($1900), the largest count that still fits under the governor ceiling.
    it('sizes a defined-risk spread toward the per-trade cap (contracts + sized totals)', () => {
      const { feed, intents } = buildOptionsIdeasFeed({
        research,
        input,
        rowsBySymbol,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd: 100_000, // cap = max(2%*100k, min(500, 5%*100k)) = $2000
      });
      const idea = feed.ideas[0]!;
      expect(idea.contracts).toBe(5); // floor(2000 / 380)
      // Displayed dollar figures are the SIZED totals (per-lot × contracts).
      expect(idea.maxLossUsd).toBeCloseTo(1900, 4); // 380 * 5
      expect(idea.maxProfitUsd).toBeCloseTo(600, 4); // 120 * 5
      expect(idea.netUsd).toBeCloseTo(600, 4); // +120 credit * 5
      expect(idea.enterable).toBe(true);
      // The sized position stays under the cap (5*380=1900 <= 2000).
      expect(idea.maxLossUsd).toBeLessThanOrEqual(2000);
      // The intent keeps PER-LOT payoff (the open path multiplies by contracts)
      // and carries the sized lot count so entry matches the card.
      const intent = intents.get(idea.id)!;
      expect(intent.maxLossUsd).toBeCloseTo(380, 4);
      expect(intent.contracts).toBe(5);
    });

    // TRA-1356 acceptance (b): a thin per-lot spread that would otherwise risk a
    // rounding error is scaled so its sized max loss clears 50% of the cap.
    it('scales a thin per-lot spread above 50% of the cap', () => {
      // Thin 1-wide credit spread (~$82/lot max loss); cap $500 on a $25k book →
      // floor(500/82)=6 lots → ~$492 (98% of cap), well above the 50% floor a
      // single trivially-thin lot would miss. The median strike step is 1 here so
      // the modeled width stays thin.
      const thinRows = new Map<string, OptionChainRow[]>([
        ['MSFT', [putRow(419, 4.02, 4.04), putRow(420, 4.2, 4.22)]],
      ]);
      const thinSym: OptionsResearchSymbol = { ...sym, spot: 420 };
      const thinInput: OptionsResearchInput = { asOf: input.asOf, symbols: [thinSym] };
      const { feed } = buildOptionsIdeasFeed({
        research,
        input: thinInput,
        rowsBySymbol: thinRows,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd: 25_000, // cap = max(500, min(500,1250)) = $500
      });
      const idea = feed.ideas[0]!;
      expect(idea.enterable).toBe(true);
      // Sized max loss must clear 50% of the $500 cap and never exceed it.
      expect(idea.maxLossUsd).toBeGreaterThanOrEqual(250);
      expect(idea.maxLossUsd).toBeLessThanOrEqual(500);
      expect(idea.contracts).toBeGreaterThan(1);
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

  // TRA-1361 — minimum-notional display floor for single-leg long-option (debit)
  // ideas. sizeSpreadContractsToCap() only scales multi-leg spreads, so a
  // single-leg long is deliberately never upsized (scaling low-POP/high-theta
  // long premium toward the cap just multiplies expected decay). The failure mode
  // is the opposite — a trivially-thin long debit clutters the feed without moving
  // P&L — so any long below 15% of the per-trade cap is suppressed, not resized.
  describe('single-leg long min-notional floor (TRA-1361)', () => {
    const longResearch: OptionsResearchResult = {
      ...research,
      ideas: [{ ...research.ideas[0]!, strategy: 'long_put', pop: 0.4, maxLossUsd: 65 }],
    };

    it('suppresses a sub-floor long debit (max loss below 15% of the cap)', () => {
      // $0.65 debit → $65 max loss = 13% of the $500 cap (25k book) < the $75 floor.
      const thinRows = new Map<string, OptionChainRow[]>([
        ['MSFT', [putRow(420, 0.64, 0.66)]], // mid 0.65 → $65 debit
      ]);
      const { feed, intents } = buildOptionsIdeasFeed({
        research: longResearch,
        input,
        rowsBySymbol: thinRows,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd: 25_000, // cap = $500 → floor = $75
      });
      // No idea, no intent — a sub-floor card never renders and can't be entered.
      expect(feed.ideas).toHaveLength(0);
      expect(intents.size).toBe(0);
    });

    it('keeps a long debit at or above the floor and never resizes it upward', () => {
      // $1.50 debit → $150 max loss = 30% of the $500 cap ≥ the $75 floor.
      const okRows = new Map<string, OptionChainRow[]>([
        ['MSFT', [putRow(420, 1.49, 1.51)]], // mid 1.50 → $150 debit
      ]);
      const { feed, intents } = buildOptionsIdeasFeed({
        research: longResearch,
        input,
        rowsBySymbol: okRows,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd: 25_000,
      });
      expect(feed.ideas).toHaveLength(1);
      const idea = feed.ideas[0]!;
      expect(idea.strategy).toBe(STRATEGY_DISPLAY.long_put);
      expect(idea.maxLossUsd).toBeCloseTo(150, 4); // NOT upsized toward the cap
      expect(idea.contracts).toBeUndefined(); // single-leg longs are never sized
      expect(intents.has(idea.id)).toBe(true);
    });

    it('never suppresses a single-leg long in a preview build (no account equity → no cap)', () => {
      const thinRows = new Map<string, OptionChainRow[]>([
        ['MSFT', [putRow(420, 0.64, 0.66)]], // $65 debit — sub-floor if gated
      ]);
      const { feed } = buildOptionsIdeasFeed({
        research: longResearch,
        input,
        rowsBySymbol: thinRows,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        // no accountEquityUsd → nothing to measure the floor against
      });
      expect(feed.ideas).toHaveLength(1);
    });

    it('does not apply the long floor to a defined-risk spread (multi-leg exempt)', () => {
      // The multi-leg bull put spread is governed by TRA-1356 sizing, never the
      // long floor: it surfaces and carries a sized lot count even on a small book.
      const { feed } = buildOptionsIdeasFeed({
        research,
        input,
        rowsBySymbol,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd: 25_000, // cap $500; per-lot $380 → 1 lot, still surfaced
      });
      expect(feed.ideas).toHaveLength(1);
      expect(feed.ideas[0]!.contracts).toBe(1); // sized path ran; floor never applied
    });
  });
});
