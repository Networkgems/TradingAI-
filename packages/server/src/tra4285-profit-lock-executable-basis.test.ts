// TRA-4285 (parent TRA-4249) — the profit-lock must be evaluated on the basis
// it will actually FILL at. Three prices flow through a `profit_lock` close:
// the MID the row is marked at, the mid HIGH-WATER MARK that used to arm the
// rule, and the BID the sell_to_close actually fills at (the submit seam prices
// `trail`-kind limits at the bid — TRA-450/TRA-3418 — and the demo marketable
// branch books the bid). Arming and releasing on the mid put both levels half
// a spread above any attainable fill, so on a sleeve whose median spread is
// ≈ 0.357R the 0.40R give-back allowance was consumed by the spread before the
// rule ever chose: the +0.35R design floor realized ≈ 0 (live/desk tape:
// 0 of 3 closes reached it; ETHA261002C00019000 exited 0.389R THROUGH it).
//
// These tests reproduce the ETHA shape — entry 1.28, stop 1.024 (R = 0.256),
// arm ≥ 1.472, first-armed release floor entry + 0.35R = 1.3696 — with a
// spread wide enough that mid-minus-spread crosses the release level, and
// assert on the EXIT PREMIUM the position actually books / stages, not on
// `profitLockDecision`'s own output. That function is correct on the numbers
// it is handed; the defect was in what it was handed (the mid) and in what the
// order did afterwards (expired mid-limit → MARKET at the bid). A test
// asserting the trigger level alone cannot see either.
//
// The pure-rule invariants live beside this in
// `packages/engine/src/tra4006-profit-lock-giveback-invariant.test.ts` and
// `tra4020-profit-floor-ladder.test.ts`; the account-level window/floor
// behaviour in `tra4020-profit-floor-trail.test.ts`, whose harness this file
// mirrors.
//
// TRADING_TIME is 14:00Z = 10:00 ET on Tue 2024-06-04 — 30 minutes after the
// open, so the 15-minute opening-range window is closed on every tick, and
// `holdLiveOptionsOvernightForPdt` is off so day-0 fires are not PDT-held.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount, type OptionExitRiskInput } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const MIN = 60_000;

// ETHA geometry, verbatim from the live close that measured the defect:
// broker-fill entry 1.28 → stopLossPremium 1.024 (−20% OTM stop) → R = 0.256.
const ENTRY = 1.28;
const R_UNIT = 0.256;
const ARM_LEVEL = ENTRY + 0.75 * R_UNIT; // 1.472 — peak that arms the lock
const DESIGN_FLOOR = ENTRY + 0.35 * R_UNIT; // 1.3696 — first-armed release floor

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-4285',
    symbol: 'ETHA',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: ENTRY,
    stopLoss: 0.96,
    takeProfit: 1.92,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'ETHA241002C00019000',
    optionType: 'call',
    strike: 19,
    expiration: '2024-10-02',
    mark: ENTRY,
    theo: 1.66,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

const JOURNAL_SETUP = {
  ivRank: 18,
  trend: 'up' as const,
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg' as const,
};

// No ATR ⇒ the chandelier is inert; no ladder ⇒ the scalar 0.75/0.40 rule —
// the constants the live tape closed under (TRA-4006, live since 85c788e5).
const RISK: OptionExitRiskInput = { underlyingAtrBySymbol: new Map(), openingRangeGuardMin: 15 };

function liveAccount() {
  vi.setSystemTime(TRADING_TIME);
  const acct = new PaperOptionsAccount({
    initialEquity: 50_000,
    managedAccountRatio: 0.5,
    holdLiveOptionsOvernightForPdt: false,
  });
  const pos = acct.openOptionFromCandidate(buildSignal(), 'live', 50_000, undefined, JOURNAL_SETUP);
  expect(pos).not.toBeNull();
  expect(pos!.mode).toBe('live');
  expect(pos!.premiumPaid).toBe(ENTRY);
  expect(pos!.stopLossPremium).toBeCloseTo(1.024, 9); // R = 0.256 — the ETHA unit
  const sym = pos!.optionSymbol!;
  // One tick = quote install + checkExits on the quote's own mid, exactly the
  // production sequencing (both derive from the same chain row per pass).
  const tick = (quote: { bid: number; ask: number } | null, waitAndHold = true) => {
    acct.refreshOptionQuotes(quote ? new Map([[sym, quote]]) : new Map());
    const mid = quote ? (quote.bid + quote.ask) / 2 : ENTRY;
    return acct.checkExits(
      new Map([['ETHA', 19]]),
      new Map([[sym, mid]]),
      'live',
      { waitAndHold },
      undefined,
      RISK,
    );
  };
  const row = () => acct.getState().openOptions[0];
  return { acct, tick, row, id: pos!.id };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-4285 — the arm test reads the executable bid, not the mid high-water mark', () => {
  it('a mid peak the book could never have sold at does NOT arm the lock, so the mid crossing the old release level fires nothing', () => {
    const { tick, row } = liveAccount();

    // The run-up: mid 1.50 ≥ 1.472 — the OLD basis arms here. The bid is 1.42:
    // no buyer ever offered the arming price, so the NEW basis must not arm.
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(tick({ bid: 1.42, ask: 1.58 })).toHaveLength(0);
    expect(row().peakPremium).toBe(1.5); // the mid ratchet still tracks the mid
    expect(row().peakPremiumExec).toBe(1.42); // the executable ratchet tracks the bid

    // The decay: mid 1.38 is through the OLD release level (1.50 − 0.1024 =
    // 1.3976), which is exactly the ETHA fire. Unarmed on the executable basis
    // ⇒ nothing fires, nothing stages, the row survives.
    vi.setSystemTime(TRADING_TIME + 2 * MIN);
    expect(tick({ bid: 1.3, ask: 1.46 })).toHaveLength(0);
    expect(row()).toBeDefined();
    expect(row().pendingExit).toBeUndefined();
    expect(row().peakPremiumExec).toBe(1.42); // a lower bid never ratchets
  });

  it('the executable peak arms only when the BID reaches the arm level, releases on the bid, stages a LIMIT at the bid, and the booked fill respects the +0.35R floor — with a prior expiry NOT escalating the profit leg to market', () => {
    const { acct, tick, row, id } = liveAccount();

    // Arm on the executable basis: bid 1.48 ≥ 1.472. (Mid 1.53 stays under the
    // +50% TP1 at 1.92 and the +30% trail activation at 1.664.)
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(tick({ bid: 1.48, ask: 1.58 })).toHaveLength(0);
    expect(row().peakPremiumExec).toBe(1.48);
    // Release level on the executable basis: 1.48 − 0.4R = 1.3776.

    // A prior sell_to_close lapsed unfilled. Under the old code this escalated
    // the next `trail`-bucket staging — profit_lock included — to MARKET.
    row().exitExpiredCount = 1;

    // Bid 1.39 sits above the release level 1.3776 ⇒ still no fire.
    vi.setSystemTime(TRADING_TIME + 2 * MIN);
    expect(tick({ bid: 1.39, ask: 1.49 })).toHaveLength(0);

    // Bid 1.37 ≤ 1.3776 ⇒ the give-back leg fires. The staged intent must be
    // a LIMIT at the BID — marketable on the first staging — and must NOT have
    // inherited the stop family's expiry escalation to market.
    vi.setSystemTime(TRADING_TIME + 3 * MIN);
    const staged = tick({ bid: 1.37, ask: 1.47 });
    expect(staged).toHaveLength(1);
    const intent = staged[0]!.pendingExit!;
    expect(intent.kind).toBe('trail'); // the broker order-pricing bucket, unchanged
    expect(intent.journalReason).toBe('profit_lock');
    expect(intent.pricing).toBe('limit'); // TRA-4285 — the carve-out under test
    expect(intent.limitPrice).toBe(1.37); // the bid, not the 1.42 mid

    // The floor arithmetic the whole ticket is about: a sell LIMIT at the bid
    // fills at or above it, and the bid at release is at/above the design
    // floor minus one tick of decay (here: 1.37 ≥ 1.3696).
    expect(intent.limitPrice).toBeGreaterThanOrEqual(DESIGN_FLOOR);

    // Book the fill at the staged limit — the EXIT PREMIUM the position
    // actually books — and grade it on the stop basis, the export's unit.
    const finalised = acct.finalizePendingExit(id, intent.limitPrice);
    expect(finalised).not.toBeNull();
    expect(finalised!.exitReason).toBe('profit_lock');
    const stopBasisR = (finalised!.currentPremium! - ENTRY) / R_UNIT;
    expect(stopBasisR).toBeGreaterThanOrEqual(0.35 - 1e-9);
  });

  it('an unquoted tick falls back to the pre-TRA-4285 mid basis rather than disarming the rule', () => {
    const { tick, row } = liveAccount();

    // Quoted run-up arms the executable peak…
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(tick({ bid: 1.48, ask: 1.58 })).toHaveLength(0);
    expect(row().peakPremiumExec).toBe(1.48);

    // …then the quote feed goes dark (wholesale replace with an empty map) and
    // the mid decays through the MID-basis release level (mid peak 1.53 −
    // 0.1024 = 1.4276; the row is marked at ENTRY=1.28 on the dark tick). The
    // lock must still fire — a dark book must not strand an armed winner — on
    // the legacy basis, staging at the mid trigger with no bid to improve to.
    vi.setSystemTime(TRADING_TIME + 2 * MIN);
    const staged = tick(null);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.pendingExit!.journalReason).toBe('profit_lock');
    expect(staged[0]!.pendingExit!.pricing).toBe('limit');
    expect(staged[0]!.pendingExit!.limitPrice).toBe(ENTRY); // the mid mark — the pre-change staging
  });

  it("POSITIVE CONTROL — the premium trail (a RISK leg) still escalates to MARKET after an expiry; the carve-out is profit_lock's alone", () => {
    const { tick, row } = liveAccount();

    // Engage the trail by hand (TP1 already trimmed on some earlier session)
    // and give it a lapsed order. `trailingStopPremium` is re-derived from
    // `peakPremium` every tick (peak × (1 − 0.20)), so the peak is what gets
    // set: 1.50 ⇒ trail at 1.20.
    row().trailingActive = true;
    row().peakPremium = 1.5;
    row().exitExpiredCount = 1;

    // Mid 1.15 (bid 1.10 / ask 1.20) is through the trail (1.20) but above the
    // hard stop (1.024), and the profit lock stays unarmed on the executable
    // basis (the exec peak seeds at this tick's 1.10 bid, under water) — so
    // the trail is the only rule that can fire.
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    const fired = tick({ bid: 1.1, ask: 1.2 });
    expect(fired).toHaveLength(1);
    expect(fired[0]!.pendingExit!.journalReason).toBe('trail');
    expect(fired[0]!.pendingExit!.pricing).toBe('market'); // TRA-2984, unchanged
  });
});
