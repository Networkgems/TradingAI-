// TRA-4623 (QuantTrader ruling on TRA-4621) — the −35% OTM day-one stop is a
// TRIGGER, and the wire now carries what the trigger can REALIZE:
//
//   • `concessionBindingLeg` — which leg of the first-attempt exit pricing set
//     the concession. The field the ruling turns on: a fire where the bid was
//     the price (cap inert, cost = half the spread) and one where the flat
//     $0.05 was the price (cap engaged on a widened book) are two different
//     worlds, and a fire COUNT cannot tell them apart. The ruling's own
//     invalidation trigger reads this split (`abs` on > 60% of fires).
//   • `firstAttemptPct` — the ruling's formula
//     `premiumStopPct + min(halfSpread, max($0.05, 5%·mid)) / premiumBasis`,
//     evaluated on the quote the firing pass served.
//   • `escalationBoundPct` — `1 − markFloorRatio × (1 − 0.4)` = 0.61 at the
//     defaults: the donation-floor worst case, derived from constants that
//     already exist.
//
// Observability only — nothing here changes a parameter, an admission, or an
// exit price. `atRiskUsd` stays full premium (the R2 carve-out lives at
// `rowOpenPremiumAtRisk` and `option-tape-expectancy.ts`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PaperOptionsAccount,
  summarizeDayOneStopPosture,
  mergeDayOneStopPosture,
} from './options-account.js';
import {
  resolveOtmDayOneStopRule,
  resolveOtmDayOneStopRelease,
} from './otm-day-one-stop.js';
import {
  liveSellFirstAttemptConcession,
  otmStopEscalationBoundPct,
  liveSellLimitDetailed,
} from './tradier-smart-close.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

const D1_OPEN = Date.parse('2024-06-05T13:30:00.000Z'); // 09:30 ET, Wednesday
const MIDDAY = D1_OPEN + 90 * 60_000;                   // 11:00 ET

const DAILY_CLOSE = { policy: 'daily_close' as const, closeWindowMin: 30, catastrophicLossPct: 0.5 };
const RULE = resolveOtmDayOneStopRule({});
const CASH_RELEASE = resolveOtmDayOneStopRelease({ accountType: 'cash', dayTradeBuyingPower: null });
const ARMED = { rule: RULE, release: CASH_RELEASE };
const BAG = { liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15, otmDayOneStop: ARMED };

const SPOT_AT_ENTRY = 200;
const ENTRY_DELTA = 0.18;
const BACKSTOP_SPOT = 197.9;

function buildOtmSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-otm-4623',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: MIDDAY,
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    mark: 1.0,
    theo: 1.30,
    mispricingPct: -0.23,
    delta: ENTRY_DELTA,
    ...overrides,
  };
}

/** A live, day-one OTM call — same population as the TRA-4055 fixtures. */
function liveOtmRow() {
  const acct = new PaperOptionsAccount({
    initialEquity: 50_000,
    managedAccountRatio: 0.5,
    holdLiveOptionsOvernightForPdt: true,
  });
  const pos = acct.openOptionFromCandidate(buildOtmSignal(), 'live', 50_000, SPOT_AT_ENTRY);
  expect(pos).not.toBeNull();
  const sym = pos!.optionSymbol!;
  const tick = (marks: Map<string, number> | null, underlying: number) => acct.checkExits(
    new Map([[pos!.symbol, underlying]]),
    marks ?? new Map<string, number>(),
    'live',
    BAG,
  );
  return { acct, sym, tick };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MIDDAY);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 1. the pure derivation, against the pricing walk it must agree with ─────
describe('TRA-4623 — liveSellFirstAttemptConcession derives the leg from the SAME walk the exit runs', () => {
  it('tight book ⇒ `bid`: the cap is inert and the cost is the half-spread', () => {
    const c = liveSellFirstAttemptConcession({ symbol: 'X', bid: 0.60, ask: 0.64 })!;
    expect(c.concessionBindingLeg).toBe('bid');
    expect(c.concessionUsd).toBeCloseTo(0.02, 9); // = halfSpread
    expect(c.halfSpreadUsd).toBeCloseTo(0.02, 9);
    expect(c.midUsd).toBeCloseTo(0.62, 9);
  });

  it('widened cheap book ⇒ `abs`: the flat $0.05 is the price (mid ≤ $1)', () => {
    // The 08-24 shape's cousin: spread past ~2.3× the admission ceiling.
    const c = liveSellFirstAttemptConcession({ symbol: 'X', bid: 0.30, ask: 0.60 })!;
    expect(c.concessionBindingLeg).toBe('abs');
    expect(c.concessionUsd).toBeCloseTo(0.05, 9);
    expect(c.halfSpreadUsd).toBeCloseTo(0.15, 9);
  });

  it('widened expensive book ⇒ `frac`: 5%·mid wins the max (mid > $1)', () => {
    const c = liveSellFirstAttemptConcession({ symbol: 'X', bid: 2.00, ask: 3.00 })!;
    expect(c.concessionBindingLeg).toBe('frac');
    expect(c.concessionUsd).toBeCloseTo(0.12, 9); // 2.50 − roundToCent(2.375)
  });

  it('the RIG book (bid 0.12 / ask 0.20) ⇒ `bid` — the cap does not engage inside its own tolerance', () => {
    const c = liveSellFirstAttemptConcession({ symbol: 'X', bid: 0.12, ask: 0.20 })!;
    expect(c.concessionBindingLeg).toBe('bid');
    expect(c.concessionUsd).toBeCloseTo(0.04, 9);
  });

  it('sub-nickel mid ⇒ `bid`: a cap at or below zero is not a price (the walk leaves the bid alone)', () => {
    const c = liveSellFirstAttemptConcession({ symbol: 'X', bid: 0.02, ask: 0.04 })!;
    expect(c.concessionBindingLeg).toBe('bid');
  });

  it('null / single-sided quote ⇒ null, never an invented leg', () => {
    expect(liveSellFirstAttemptConcession(null)).toBeNull();
    expect(liveSellFirstAttemptConcession({ symbol: 'X', ask: 0.30, last: 0.25 })).toBeNull();
  });

  it('AGREEMENT: concession + limit reconstruct the walk on every two-sided book', () => {
    // The derivation must never disagree with the order path — same walk, so
    // `mid − concession === limit` bit-for-bit across a grid of books.
    for (const [bid, ask] of [[0.60, 0.64], [0.30, 0.60], [2.0, 3.0], [0.12, 0.20], [0.17, 2.49], [1.2, 1.65]] as const) {
      const q = { symbol: 'X', bid, ask };
      const c = liveSellFirstAttemptConcession(q)!;
      const d = liveSellLimitDetailed(q, 'bid')!;
      expect(c.midUsd - c.concessionUsd).toBeCloseTo(d.limit, 9);
    }
  });

  it('escalationBoundPct is 0.61 at the default rule, and moves with the floor ratio', () => {
    expect(otmStopEscalationBoundPct(RULE.markFloorRatio)).toBeCloseTo(0.61, 9);
    expect(otmStopEscalationBoundPct(0.8)).toBeCloseTo(0.52, 9); // −20% stop
  });
});

// ── 2. the fire books the leg and latches the band ──────────────────────────
describe('TRA-4623 — a fire is binned by concession leg and latches lastFire', () => {
  it('a quote-served fire on a tight book ⇒ `bid`, firstAttemptPct = 0.35 + halfSpread/premium', () => {
    const { acct, sym, tick } = liveOtmRow();
    acct.refreshOptionQuotes(new Map([[sym, { bid: 0.60, ask: 0.64 }]]));
    acct.refreshOptionMarkSources(new Map([[sym, 'quote']]));

    const closed = tick(new Map([[sym, 0.62]]), SPOT_AT_ENTRY);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('sl_otm_premium_pct');

    const counters = acct.getOtmDayOneStopCounters();
    expect(counters.byConcessionBindingLeg).toEqual({ bid: 1, abs: 0, frac: 0, unquoted: 0 });
    expect(counters.lastFire).toEqual({
      concessionBindingLeg: 'bid',
      // 0.35 + 0.02 / 1.00 — the ruling's formula on this book and basis.
      firstAttemptPct: 0.37,
      trigger: 'premium_pct',
      at: new Date(MIDDAY).toISOString(),
    });
  });

  it('a widened cheap book ⇒ `abs`, the world the invalidation trigger watches', () => {
    const { acct, sym, tick } = liveOtmRow();
    acct.refreshOptionQuotes(new Map([[sym, { bid: 0.30, ask: 0.60 }]]));
    acct.refreshOptionMarkSources(new Map([[sym, 'quote']]));

    expect(tick(new Map([[sym, 0.45]]), SPOT_AT_ENTRY)).toHaveLength(1);
    const counters = acct.getOtmDayOneStopCounters();
    expect(counters.byConcessionBindingLeg).toEqual({ bid: 0, abs: 1, frac: 0, unquoted: 0 });
    expect(counters.lastFire!.firstAttemptPct).toBeCloseTo(0.40, 9); // 0.35 + 0.05/1.00
  });

  it('a dark-book backstop fire ⇒ `unquoted`, never a silent drop — the split sums to the leg totals', () => {
    const { acct, tick } = liveOtmRow();
    tick(null, BACKSTOP_SPOT);
    tick(null, BACKSTOP_SPOT);
    expect(tick(null, BACKSTOP_SPOT)).toHaveLength(1); // delta_backstop fire

    const counters = acct.getOtmDayOneStopCounters();
    expect(counters.byConcessionBindingLeg).toEqual({ bid: 0, abs: 0, frac: 0, unquoted: 1 });
    expect(counters.lastFire).toMatchObject({ concessionBindingLeg: 'unquoted', firstAttemptPct: null });
    const bucketed = Object.values(counters.byConcessionBindingLeg).reduce((a, b) => a + b, 0);
    expect(bucketed).toBe(counters.premiumPct + counters.atrInvalidation);
  });
});

// ── 3. the wire ─────────────────────────────────────────────────────────────
describe('TRA-4623 — the band on liveDayOneStopPosture.otmDayOneStop', () => {
  it('publishes escalationBoundPct beside markFloorRatio, and the zero vector before any fire', () => {
    const posture = summarizeDayOneStopPosture([], {
      holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED,
    });
    expect(posture.otmDayOneStop!.markFloorRatio).toBeCloseTo(0.65, 9);
    expect(posture.otmDayOneStop!.escalationBoundPct).toBeCloseTo(0.61, 9);
    expect(posture.otmDayOneStop!.fires.byConcessionBindingLeg).toEqual({
      bid: 0, abs: 0, frac: 0, unquoted: 0,
    });
    expect(posture.otmDayOneStop!.lastFire).toBeNull();
  });

  it('folds across books: counts add, the LATEST lastFire wins, an older-build summary adds zero', () => {
    const mk = (legs: { bid: number; abs: number; frac: number; unquoted: number }, at: string | null) =>
      summarizeDayOneStopPosture([], {
        holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED,
        otmDayOneStopCounters: {
          premiumPct: legs.bid + legs.abs + legs.frac + legs.unquoted, atrInvalidation: 0, pdtHeld: 0,
          byMarkSource: { quote: 0, last: 0, delta_backstop: 0, unknown: 0 },
          byConcessionBindingLeg: legs,
          lastFire: at === null ? null : {
            firstAttemptPct: 0.37, concessionBindingLeg: 'bid', trigger: 'premium_pct', at,
          },
        },
      });
    const a = mk({ bid: 1, abs: 0, frac: 0, unquoted: 0 }, '2026-09-10T14:00:00.000Z');
    const b = mk({ bid: 0, abs: 2, frac: 1, unquoted: 0 }, '2026-09-12T14:00:00.000Z');

    // A summary minted before this shipped: no leg split, no lastFire.
    const legacy = JSON.parse(JSON.stringify(a)) as typeof a;
    delete (legacy.otmDayOneStop!.fires as Record<string, unknown>)['byConcessionBindingLeg'];
    delete (legacy.otmDayOneStop as Record<string, unknown>)['lastFire'];
    delete (legacy.otmDayOneStop as Record<string, unknown>)['escalationBoundPct'];

    const merged = mergeDayOneStopPosture([a, b, legacy]);
    // The legacy book's fire lands in the leg totals and in NO bucket — the
    // honest older-build reading, same as byMarkSource (`books` is beside it).
    expect(merged.otmDayOneStop!.fires.byConcessionBindingLeg).toEqual({
      bid: 1, abs: 2, frac: 1, unquoted: 0,
    });
    expect(merged.otmDayOneStop!.lastFire!.at).toBe('2026-09-12T14:00:00.000Z');
    expect(merged.otmDayOneStop!.escalationBoundPct).toBeCloseTo(0.61, 9);
    expect(merged.books).toBe(3);
  });
});
