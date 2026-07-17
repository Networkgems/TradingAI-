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
  reconcileThesis,
  dteFromExpiration,
  sizeSpreadContractsToCap,
  STRATEGY_DISPLAY,
} from './options-ideas-feed.js';

const EXP = '2026-07-17';
// TRA-1368 — a realistic generation instant 35 calendar days before EXP, so a
// leg-derived DTE lands on 35 (the feed now keys `dte` to the executed legs, not
// the model's intended `dteDays`, so tests must generate near the leg's date).
const GEN = Date.parse('2026-06-12T14:00:00Z');

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

  // TRA-1363 — the same anchor mis-map hits DEBIT verticals: a deep-ITM anchor
  // snaps a bull call spread onto both-ITM legs (live NVDA buy 90C/sell 95C at
  // spot 196.9), a degenerate structure that pays ~full width for ~zero reward.
  // The long leg must be clamped to the not-ITM side of spot so the vertical is a
  // genuine at/OTM directional bet coherent with its POP/thesis.
  it('places a debit bull-call long leg at/OTM even when the scanner anchor is deep ITM', () => {
    const debitCalls: OptionChainRow[] = [
      callRow(90, 107.0, 107.2), // deep-ITM anchor strike (spot 196.9)
      callRow(192, 8.9, 9.1), // uniform 5-wide chain around the money → step = 5
      callRow(197, 5.9, 6.1), // mid 6.0 — first strike at/above spot
      callRow(202, 3.9, 4.1), // mid 4.0
      callRow(207, 2.4, 2.6),
    ];
    const s = modelStructure('bull_call_spread', candidate({ strike: 90, optionType: 'call' }), 196.9, debitCalls, 999);
    expect(s.legs).toEqual([
      { action: 'buy', optionType: 'call', strike: 197, expiration: EXP }, // clamped, not 90
      { action: 'sell', optionType: 'call', strike: 202, expiration: EXP },
    ]);
    // Both legs sit at/above spot — a coherent OTM debit spread with sane R:R.
    expect(s.legs[0]!.strike).toBeGreaterThanOrEqual(196.9);
    // debit = 6.0 - 4.0 = 2.0 → net -200, maxLoss 200; width 5 → maxProfit 300.
    expect(s.netUsd).toBeCloseTo(-200, 4);
    expect(s.maxLossUsd).toBeCloseTo(200, 4);
    expect(s.maxProfitUsd).toBeCloseTo(300, 4);
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

  // TRA-1363 — the guard now also covers DEBIT verticals. A debit spread with a
  // long leg + a step-away short leg; both ITM is the degenerate deep-ITM
  // structure (pay ~full width for ~zero reward).
  const debitFor = (long: { optionType: 'call' | 'put'; strike: number }) => ({
    legs: [
      { action: 'buy' as const, ...long, expiration: EXP },
      {
        action: 'sell' as const,
        optionType: long.optionType,
        strike: long.optionType === 'call' ? long.strike + 5 : long.strike - 5,
        expiration: EXP,
      },
    ],
    breakevens: [long.strike],
    maxLossUsd: 495,
    maxProfitUsd: 5,
    netUsd: -495,
    priced: true,
  });

  it('rejects a deep-ITM bull-call debit spread with both legs ITM (the live NVDA defect)', () => {
    // buy 90C / sell 95C at spot 196.9 → both ITM; POP 0.62 on a pay-495-make-5 structure.
    expect(ideaPopPlacementCoherent('bull_call_spread', debitFor({ optionType: 'call', strike: 90 }), 196.9, 0.62)).toBe(false);
  });

  it('rejects a deep-ITM bear-put debit spread with both legs ITM', () => {
    // buy 300P / sell 295P at spot 196.9 → both ITM for a put.
    expect(ideaPopPlacementCoherent('bear_put_spread', debitFor({ optionType: 'put', strike: 300 }), 196.9, 0.62)).toBe(false);
  });

  it('accepts an at/OTM debit vertical (a genuine directional spread)', () => {
    // buy 197C / sell 202C at spot 196.9 → both OTM; a real bullish debit bet.
    expect(ideaPopPlacementCoherent('bull_call_spread', debitFor({ optionType: 'call', strike: 197 }), 196.9, 0.45)).toBe(true);
  });

  it('accepts a conservative ITM-long / OTM-short debit vertical (not ALL legs ITM)', () => {
    // buy 195C / sell 200C at spot 196.9 → long ITM, short OTM; a legitimate higher-POP spread.
    expect(ideaPopPlacementCoherent('bull_call_spread', debitFor({ optionType: 'call', strike: 195 }), 196.9, 0.55)).toBe(true);
  });

  // TRA-1366 — the mirror-image defect: a DEEP-OTM debit vertical. The long leg
  // sits far OTM (a mispricing anchor the TRA-1363 clamp doesn't bound), so the
  // spread is near-worthless: a few dollars of debit for ~full-width "profit". A
  // reported POP > 0.5 contradicts that ~zero-probability payoff, and the TRA-1356
  // sizing amplifies it into a hundreds-of-lots six-figure card.
  const deepOtmDebit = (long: { optionType: 'call' | 'put'; strike: number }) => ({
    legs: [
      { action: 'buy' as const, ...long, expiration: EXP },
      {
        action: 'sell' as const,
        optionType: long.optionType,
        strike: long.optionType === 'call' ? long.strike + 5 : long.strike - 5,
        expiration: EXP,
      },
    ],
    breakevens: [long.strike],
    maxLossUsd: 2, // ~$2/lot debit on a $5-wide spread → cost ratio 0.004
    maxProfitUsd: 498,
    netUsd: -2,
    priced: true,
  });

  it('rejects a deep-OTM debit vertical carrying a > 0.5 POP (the live bear-put defect)', () => {
    // buy 175P / sell 170P at spot 416 → deep OTM; $2 loss vs $498 profit is a
    // ~zero-POP lottery, so POP 0.75 is incoherent.
    expect(ideaPopPlacementCoherent('bear_put_spread', deepOtmDebit({ optionType: 'put', strike: 175 }), 416, 0.75)).toBe(false);
    expect(ideaPopPlacementCoherent('bull_call_spread', deepOtmDebit({ optionType: 'call', strike: 650 }), 416, 0.7)).toBe(false);
  });

  it('accepts a deep-OTM debit vertical when its POP is honestly low (<= 0.5)', () => {
    // A far-OTM lottery is coherent iff the card reports a low POP to match.
    expect(ideaPopPlacementCoherent('bear_put_spread', deepOtmDebit({ optionType: 'put', strike: 175 }), 416, 0.1)).toBe(true);
  });
});

describe('reconcileThesis (TRA-1363)', () => {
  it('drops a strike/expiration-only leg recital to a deterministic structure rationale', () => {
    // The live COIN bear call: thesis names 170C/185C 8/21, executed legs differ.
    expect(reconcileThesis('Sell 170C 8/21, buy 185C 8/21', 'bear_call_spread')).toBe(
      'Bearish defined-risk credit spread — collects net premium and profits while the underlying stays below the short call through expiry.',
    );
    expect(reconcileThesis('Buy 85C, sell 100C 8/21', 'bull_call_spread')).toBe(
      'Bullish defined-risk debit spread — profits as the underlying rises toward the short call by expiry, loss capped at the net debit.',
    );
    // ISO-dated recital falls back too.
    expect(reconcileThesis('Sell 220P 2026-08-07, buy 205P 2026-08-07', 'bull_put_spread')).toBe(
      'Bullish defined-risk credit spread — collects net premium and profits while the underlying holds above the short put through expiry.',
    );
  });

  it('keeps qualitative rationale, stripping only the conflicting strike/date specifics', () => {
    expect(
      reconcileThesis('Constructive trend with moderate IV; buy the 200C / sell 205C for 7/24 to ride the move.', 'bull_call_spread'),
    ).toBe('Constructive trend with moderate IV; to ride the move.');
  });

  it('leaves a strike-free thesis untouched (nothing to reconcile)', () => {
    const t = 'Elevated IV-rank into a quiet window; sell defined-risk premium below support.';
    expect(reconcileThesis(t, 'bull_put_spread')).toBe(t);
  });

  it('does not mistake price levels or ratios for strikes/dates', () => {
    // "420" (no C/P) is a support level; "50/50" is a ratio, not a date — both kept.
    const t = 'Range-bound near 420 support; a 50/50 pin keeps theta working.';
    expect(reconcileThesis(t, 'iron_condor')).toBe(t);
  });

  it('falls back for an empty thesis', () => {
    expect(reconcileThesis('', 'long_call')).toBe(
      'Directional defined-risk long call — upside exposure with loss capped at the debit paid.',
    );
  });

  // TRA-1368 — strip the DTE / option-tenor figure the model keyed to its INTENDED
  // expiration so a stale "46-DTE" can't contradict a 25-DTE executed leg. The
  // qualitative rationale survives; the card shows the derived `dte` authoritatively.
  it('strips a stale DTE / option-tenor figure, keeping the rationale (TRA-1368)', () => {
    // The live NVDA defect: "46-DTE" prose on a spread that actually expires in 25 days.
    expect(reconcileThesis('NVDA 46-DTE OTM calls show 3% mispricing into strength.', 'long_call')).toBe(
      'NVDA OTM calls show 3% mispricing into strength.',
    );
    // "<N> DTE", "<N>DTE", and the hyphenated "<N>-day(s)" tenor idiom all go.
    expect(reconcileThesis('Elevated IV-rank; a 46 DTE swing rides the trend.', 'long_call')).toBe(
      'Elevated IV-rank; a swing rides the trend.',
    );
    expect(reconcileThesis('Buy a 30-day debit vertical while IV is cheap.', 'bull_call_spread')).toBe(
      'Buy a debit vertical while IV is cheap.',
    );
  });

  it('does NOT strip a bare spaced "in N days" catalyst reference (TRA-1368)', () => {
    // No hyphen, no "DTE" marker → a real catalyst-timing phrase, kept intact.
    const t = 'Earnings in 3 days should lift IV; hold the defined-risk premium into the print.';
    expect(reconcileThesis(t, 'bull_put_spread')).toBe(t);
  });
});

describe('dteFromExpiration (TRA-1368)', () => {
  it('counts whole calendar days DATE-to-DATE, ignoring the intraday generation hour', () => {
    // The live defect window: 2026-07-31 is 25 days from a 2026-07-06 generation,
    // regardless of the 18:39Z hour it ran (the LLM/engine convention).
    expect(dteFromExpiration('2026-07-31', Date.parse('2026-07-06T18:39:19Z'))).toBe(25);
    expect(dteFromExpiration('2026-07-31', Date.parse('2026-07-06T00:00:00Z'))).toBe(25);
    expect(dteFromExpiration('2026-08-21', Date.parse('2026-07-06T18:39:19Z'))).toBe(46);
  });

  it('guards an unparseable expiration to 0 rather than NaN/negative', () => {
    expect(dteFromExpiration('not-a-date', Date.parse('2026-07-06T00:00:00Z'))).toBe(0);
    // A past expiration floors at 0, never negative.
    expect(dteFromExpiration('2026-07-01', Date.parse('2026-07-06T00:00:00Z'))).toBe(0);
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
      generatedAt: GEN,
    });
    expect(feed.source).toBe('live');
    expect(feed.generatedAt).toBe(GEN);
    expect(feed.noDayTrading.enforced).toBe(true);
    expect(feed.ideas).toHaveLength(1);
    const idea = feed.ideas[0]!;
    expect(idea.ticker).toBe('MSFT');
    expect(idea.strategy).toBe(STRATEGY_DISPLAY.bull_put_spread);
    expect(idea.underlyingPrice).toBe(430);
    expect(idea.ivRank).toBe(64);
    // TRA-1368 — dte is DERIVED from the executed leg expiration (EXP = 2026-07-17,
    // 35 days after GEN), not read off the model's idea.dteDays.
    expect(idea.dte).toBe(35);
    expect(idea.dte).toBe(dteFromExpiration(idea.legs[0]!.expiration, GEN));
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

  // TRA-1363 — end-to-end debit-vertical coherence. When the chain lists only
  // deep-ITM call strikes, a bull call spread can't be placed at/OTM and models
  // both-ITM (the live NVDA buy 90C/sell 95C-vs-196.9 shape). The guard drops it
  // rather than rendering a priced, enterable card that pays ~full width for ~zero
  // reward. No idea, no intent.
  it('drops an incoherent deep-ITM debit spread (both legs ITM)', () => {
    const nvdaSym: OptionsResearchSymbol = {
      ...sym,
      spot: 196.9,
      candidates: [candidate({ optionSymbol: 'NVDA260717C00090000', strike: 90, optionType: 'call', mispricingPct: 0.5 })],
    };
    const nvdaInput: OptionsResearchInput = { asOf: input.asOf, symbols: [nvdaSym] };
    const nvdaResearch: OptionsResearchResult = {
      ...research,
      ideas: [{ ...research.ideas[0]!, ticker: 'MSFT', strategy: 'bull_call_spread', pop: 0.62 }],
    };
    // Only deep-ITM call strikes are listed — no at/OTM strike to clamp the long to.
    const itmOnly = new Map<string, OptionChainRow[]>([
      ['MSFT', [callRow(90, 107.0, 107.2), callRow(95, 102.1, 102.3)]],
    ]);
    const { feed, intents } = buildOptionsIdeasFeed({
      research: nvdaResearch,
      input: nvdaInput,
      rowsBySymbol: itmOnly,
      guardrail: DAY_TRADING_GUARDRAIL,
      generatedAt: 1,
    });
    expect(feed.ideas).toHaveLength(0);
    expect(intents.size).toBe(0);
  });

  // TRA-1366 — end-to-end deep-OTM debit coherence. A mispricing anchor far OTM
  // (bear put long 175P vs spot 416, the live 2026-07-06T18:07Z shape) models a
  // near-worthless spread — ~$2/lot debit for ~full-width "profit" — which the
  // TRA-1356 cap-sizing would blow up into a hundreds-of-lots six-figure card.
  // The guard drops it on cost-ratio-vs-POP: no idea, no intent.
  it('drops an incoherent deep-OTM debit spread (cost ratio contradicts POP)', () => {
    const otmSym: OptionsResearchSymbol = {
      ...sym,
      spot: 416,
      candidates: [candidate({ optionSymbol: 'X260717P00175000', strike: 175, optionType: 'put', mispricingPct: 0.6 })],
    };
    const otmInput: OptionsResearchInput = { asOf: input.asOf, symbols: [otmSym] };
    const otmResearch: OptionsResearchResult = {
      ...research,
      ideas: [{ ...research.ideas[0]!, ticker: 'MSFT', strategy: 'bear_put_spread', pop: 0.75 }],
    };
    // Deep-OTM put strikes only (spot 416): the long 175P prices at pennies, so the
    // debit rounds to a few dollars vs a ~full-width $498 "profit" — cost ratio ~0.
    const otmPuts = new Map<string, OptionChainRow[]>([
      ['MSFT', [putRow(170, 0.01, 0.03), putRow(175, 0.03, 0.05)]],
    ]);
    const { feed, intents } = buildOptionsIdeasFeed({
      research: otmResearch,
      input: otmInput,
      rowsBySymbol: otmPuts,
      guardrail: DAY_TRADING_GUARDRAIL,
      generatedAt: 1,
      accountEquityUsd: 25_000,
    });
    expect(feed.ideas).toHaveLength(0);
    expect(intents.size).toBe(0);
  });

  // TRA-1363 — the displayed thesis is reconciled against the executed legs: the
  // LLM prose named no strikes here, so it survives; a strike-naming prose would
  // be stripped (covered in the reconcileThesis unit above).
  it('reconciles the idea thesis against the executed legs', () => {
    const strikeNaming: OptionsResearchResult = {
      ...research,
      ideas: [{ ...research.ideas[0]!, thesis: 'Sell 999P 1/1, buy 900P 1/1' }],
    };
    const { feed } = buildOptionsIdeasFeed({
      research: strikeNaming,
      input,
      rowsBySymbol,
      guardrail: DAY_TRADING_GUARDRAIL,
      generatedAt: 1,
    });
    // The bogus 999/900 strikes never reach the card; a deterministic rationale does.
    expect(feed.ideas[0]!.thesis).not.toMatch(/999|900/);
    expect(feed.ideas[0]!.thesis).toBe(
      'Bullish defined-risk credit spread — collects net premium and profits while the underlying holds above the short put through expiry.',
    );
  });

  // TRA-1368 — end-to-end DTE/horizon/thesis coherence on the expiration axis. The
  // live NVDA defect: the model keyed dte=46 / catalystHorizon='long' / a "46-DTE"
  // thesis to its INTENDED ~08-21 expiration, but the executed legs landed on the
  // 07-31 chain (25 days out). The feed now derives all three from the leg
  // expiration, so the card can never show a 46-DTE narrative on a 25-DTE spread.
  it('derives dte / horizon / thesis-DTE from the executed leg expiration, not the stale model DTE', () => {
    const GEN_NVDA = Date.parse('2026-07-06T18:39:19Z');
    const EXP_LEG = '2026-07-31'; // 25 days from GEN_NVDA — NOT the model's intended 46
    // No scheduled catalyst → the horizon falls back to the DTE, exposing the desync.
    const nvdaSym: OptionsResearchSymbol = {
      symbol: 'MSFT',
      spot: 200,
      ivRank: 55,
      nextEarningsInDays: null,
      daysToFOMC: null,
      macroEventsNearby: [],
      newsSentiment: 0.1,
      candidates: [
        candidate({ optionSymbol: 'MSFT260731C00200000', optionType: 'call', strike: 200, expiration: EXP_LEG, mispricingPct: 0.3 }),
      ],
    };
    const nvdaInput: OptionsResearchInput = { asOf: GEN_NVDA, symbols: [nvdaSym] };
    const nvdaResearch: OptionsResearchResult = {
      ...research,
      ideas: [
        {
          ...research.ideas[0]!,
          ticker: 'MSFT',
          strategy: 'long_call',
          thesis: 'Momentum OTM calls show 3% mispricing into strength on a 46-DTE swing.',
          pop: 0.45,
          maxLossUsd: 800,
          dteDays: 46, // stale — the model's intended expiration
          catalystHorizon: 'long', // stale — keyed to the 46-DTE intent
        },
      ],
    };
    const nvdaRows = new Map<string, OptionChainRow[]>([
      ['MSFT', [{ optionSymbol: 'C200', underlying: 'MSFT', optionType: 'call', strike: 200, expiration: EXP_LEG, bid: 7.9, ask: 8.1 }]],
    ]);
    const { feed } = buildOptionsIdeasFeed({
      research: nvdaResearch,
      input: nvdaInput,
      rowsBySymbol: nvdaRows,
      guardrail: DAY_TRADING_GUARDRAIL,
      generatedAt: GEN_NVDA,
    });
    expect(feed.ideas).toHaveLength(1);
    const idea = feed.ideas[0]!;
    // dte tracks the executed leg (25), not the model's stale 46.
    expect(idea.legs[0]!.expiration).toBe(EXP_LEG);
    expect(idea.dte).toBe(25);
    expect(idea.dte).toBe(dteFromExpiration(idea.legs[0]!.expiration, GEN_NVDA));
    // horizon re-bucketed against the 25-DTE leg: 'long' → 'medium' (25 ≤ 35 medium max).
    expect(idea.catalystHorizon).toBe('medium');
    // the "46-DTE" prose figure is scrubbed so it can't contradict the 25-DTE leg.
    expect(idea.thesis).not.toMatch(/46|DTE/);
    expect(idea.thesis).toBe('Momentum OTM calls show 3% mispricing into strength on a swing.');
  });

  // TRA-1368 — the coherence INVARIANT the fix guarantees: across a mixed slate,
  // every rendered idea's dte equals the whole-day count to its own leg expiration.
  it('holds dte == daysBetween(generatedAt, legs[0].expiration) for every rendered idea', () => {
    const GEN_MIX = Date.parse('2026-07-06T12:00:00Z');
    const mkSym = (symbol: string, exp: string): OptionsResearchSymbol => ({
      symbol,
      spot: 200,
      ivRank: 50,
      nextEarningsInDays: null,
      daysToFOMC: null,
      macroEventsNearby: [],
      newsSentiment: 0,
      candidates: [candidate({ optionSymbol: `${symbol}C200`, optionType: 'call', strike: 200, expiration: exp, mispricingPct: 0.3 })],
    });
    const symA = mkSym('AAA', '2026-07-31'); // 25 DTE
    const symB = mkSym('BBB', '2026-08-21'); // 46 DTE
    const mixInput: OptionsResearchInput = { asOf: GEN_MIX, symbols: [symA, symB] };
    const mixResearch: OptionsResearchResult = {
      ...research,
      ideas: [
        { ...research.ideas[0]!, ticker: 'AAA', strategy: 'long_call', pop: 0.45, dteDays: 999, catalystHorizon: 'long', rank: 1 },
        { ...research.ideas[0]!, ticker: 'BBB', strategy: 'long_call', pop: 0.45, dteDays: 1, catalystHorizon: 'near', rank: 2 },
      ],
    };
    const call200 = (underlying: string, exp: string): OptionChainRow => ({ optionSymbol: `${underlying}C200`, underlying, optionType: 'call', strike: 200, expiration: exp, bid: 7.9, ask: 8.1 });
    const mixRows = new Map<string, OptionChainRow[]>([
      ['AAA', [call200('AAA', '2026-07-31')]],
      ['BBB', [call200('BBB', '2026-08-21')]],
    ]);
    const { feed } = buildOptionsIdeasFeed({
      research: mixResearch,
      input: mixInput,
      rowsBySymbol: mixRows,
      guardrail: DAY_TRADING_GUARDRAIL,
      generatedAt: GEN_MIX,
    });
    expect(feed.ideas.length).toBeGreaterThan(0);
    for (const idea of feed.ideas) {
      expect(idea.dte).toBe(dteFromExpiration(idea.legs[0]!.expiration, GEN_MIX));
    }
    expect(feed.ideas.find((i) => i.ticker === 'AAA')!.dte).toBe(25);
    expect(feed.ideas.find((i) => i.ticker === 'BBB')!.dte).toBe(46);
  });

  // TRA-1991 — cost-efficiency gate. A penny-wide 1-wide credit spread (~$0.60
  // credit → ~$40 defined max-loss) carries a $10.60 round-trip cost = ~26% of its
  // risk denominator, so its live NET R is structurally negative regardless of a
  // marginally-positive gross edge. The surface-time filter drops it entirely — no
  // idea, no intent — so the penny-wide, high-credit structures that were dragging
  // the gate's net-R to −0.63 never reach the journal. A wide spread (below) is kept.
  it('drops a penny-wide spread whose modeled cost dwarfs its max-loss (TRA-1991)', () => {
    const pennySym: OptionsResearchSymbol = {
      ...sym,
      spot: 421, // short 420 put sits OTM (below spot) so the coherence guard passes
      candidates: [candidate({ strike: 420, optionType: 'put', mispricingPct: -0.25 })],
    };
    const pennyInput: OptionsResearchInput = { asOf: input.asOf, symbols: [pennySym] };
    // 1-wide put spread, ~$0.60 credit → ~$40 max loss; cost $10.60 ≈ 26% of risk.
    const pennyRows = new Map<string, OptionChainRow[]>([
      ['MSFT', [putRow(419, 3.58, 3.62), putRow(420, 4.18, 4.22)]],
    ]);
    const { feed, intents } = buildOptionsIdeasFeed({
      research,
      input: pennyInput,
      rowsBySymbol: pennyRows,
      guardrail: DAY_TRADING_GUARDRAIL,
      generatedAt: 1,
    });
    expect(feed.ideas).toHaveLength(0);
    expect(intents.size).toBe(0);
  });

  it('keeps a wide spread whose cost is a small fraction of its max-loss (TRA-1991)', () => {
    // The default 5-wide bull put spread models a $380 max loss → cost ratio 0.028.
    const { feed } = buildOptionsIdeasFeed({
      research,
      input,
      rowsBySymbol,
      guardrail: DAY_TRADING_GUARDRAIL,
      generatedAt: 1,
    });
    expect(feed.ideas).toHaveLength(1);
    expect(feed.ideas[0]!.maxLossUsd).toBeCloseTo(380, 4);
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

    // TRA-1367 — a priced:false structure is the thin-chain fallback (fabricated
    // 1:1 payoff basis). It must never be enterable: no real fill basis exists, so
    // entering would open a position on fabricated marks. Flagged non-enterable
    // with a reason and no entry intent, exactly like a cap-busting idea.
    it('flags a priced:false (thin-chain fallback) idea as non-enterable with no intent', () => {
      // No chain rows for MSFT → modelStructure can't price the legs → priced:false.
      const noRows = new Map<string, OptionChainRow[]>();
      const { feed, intents } = buildOptionsIdeasFeed({
        research,
        input,
        rowsBySymbol: noRows,
        guardrail: DAY_TRADING_GUARDRAIL,
        generatedAt: 1,
        accountEquityUsd: 100_000, // gate active; $380 fallback loss is within the cap
      });
      const idea = feed.ideas[0]!;
      expect(idea.priced).toBe(false);
      expect(idea.enterable).toBe(false);
      expect(idea.entryBlockedReason).toMatch(/could not be priced/i);
      expect(intents.has(idea.id)).toBe(false);
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
