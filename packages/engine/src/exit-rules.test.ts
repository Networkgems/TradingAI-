import { describe, it, expect } from 'vitest';
import {
  chandelierMultiplier,
  chandelierStop,
  chandelierExitTriggered,
  stopModifyDecision,
  profitLockDecision,
  bookGiveBackDecision,
  takeProfitEarlyDecision,
  correlatedExposureDecision,
  buildExposureBuckets,
  entryGreeksGateDecision,
} from './exit-rules.js';
import type { ExposurePositionRisk } from './exit-rules.js';

// TRA-1250 — exit-side loss-control rules (board-approved TRA-1249 params).

describe('Rule 1 — ATR chandelier trailing stop', () => {
  it('picks the high-beta multiplier only above the ATR/price threshold', () => {
    expect(chandelierMultiplier(0.03)).toBe(3.0);
    expect(chandelierMultiplier(0.05)).toBe(3.0); // boundary is strict (>)
    expect(chandelierMultiplier(0.06)).toBe(3.5);
    expect(chandelierMultiplier(undefined)).toBe(3.0);
  });

  it('long: trails 3.0×ATR below the highest high, floored at the initial stop', () => {
    // extreme 120, ATR 2 → raw 120 − 6 = 114; above initial stop 95.
    expect(chandelierStop({ side: 'buy', initialStop: 95, extremeSinceEntry: 120, atr: 2 })).toBe(114);
    // Early on, raw would be below the initial stop → floor at 95.
    expect(chandelierStop({ side: 'buy', initialStop: 95, extremeSinceEntry: 100, atr: 2 })).toBe(95);
  });

  it('long: ratchets up only — a rising ATR never loosens the stop', () => {
    // prev stop 114; ATR spikes to 5 so raw 120 − 15 = 105 < 114 → keep 114.
    expect(
      chandelierStop({ side: 'buy', initialStop: 95, extremeSinceEntry: 120, atr: 5, prevTrailStop: 114 }),
    ).toBe(114);
    // New higher extreme 130, ATR back to 2 → raw 124 > 114 → ratchet up.
    expect(
      chandelierStop({ side: 'buy', initialStop: 95, extremeSinceEntry: 130, atr: 2, prevTrailStop: 114 }),
    ).toBe(124);
  });

  it('short: trails 3.0×ATR above the lowest low, capped and ratcheting down', () => {
    // extreme 80, ATR 2 → raw 80 + 6 = 86; below initial stop 105.
    expect(chandelierStop({ side: 'sell', initialStop: 105, extremeSinceEntry: 80, atr: 2 })).toBe(86);
    expect(
      chandelierStop({ side: 'sell', initialStop: 105, extremeSinceEntry: 80, atr: 5, prevTrailStop: 86 }),
    ).toBe(86); // ATR spike must not loosen (raise) a short's stop
  });

  it('high-beta names use the 3.5× width', () => {
    // atrPct 0.08 → mult 3.5; extreme 120, ATR 2 → 120 − 7 = 113.
    expect(
      chandelierStop({ side: 'buy', initialStop: 95, extremeSinceEntry: 120, atr: 2, atrPct: 0.08 }),
    ).toBe(113);
  });

  it('exit triggers when price crosses the trail', () => {
    expect(chandelierExitTriggered('buy', 113, 114)).toBe(true);
    expect(chandelierExitTriggered('buy', 115, 114)).toBe(false);
    expect(chandelierExitTriggered('sell', 87, 86)).toBe(true);
    expect(chandelierExitTriggered('sell', 85, 86)).toBe(false);
  });
});

// TRA-1269 — broker stop-leg modify gate (live-equity chandelier path).
describe('Rule 1 (live path) — stopModifyDecision', () => {
  it('long: modifies only when the stop tightens (rises) by ≥ minTick', () => {
    // Rises 2.0 ≥ minTick 0.5 → modify to the higher stop.
    expect(stopModifyDecision({ side: 'buy', brokerStop: 100, desiredStop: 102, minTick: 0.5 }))
      .toEqual({ shouldModify: true, nextStop: 102 });
    // Rises only 0.3 < minTick 0.5 → hold; keep the resting stop.
    expect(stopModifyDecision({ side: 'buy', brokerStop: 100, desiredStop: 100.3, minTick: 0.5 }))
      .toEqual({ shouldModify: false, nextStop: 100 });
    // Desired is LOWER (would loosen) → never modify a long's stop down.
    expect(stopModifyDecision({ side: 'buy', brokerStop: 100, desiredStop: 98, minTick: 0.5 }))
      .toEqual({ shouldModify: false, nextStop: 100 });
    // Equal → no-op.
    expect(stopModifyDecision({ side: 'buy', brokerStop: 100, desiredStop: 100, minTick: 0.5 }).shouldModify)
      .toBe(false);
  });

  it('short: modifies only when the stop tightens (falls) by ≥ minTick', () => {
    // Falls 2.0 ≥ minTick 0.5 → modify to the lower stop.
    expect(stopModifyDecision({ side: 'sell', brokerStop: 100, desiredStop: 98, minTick: 0.5 }))
      .toEqual({ shouldModify: true, nextStop: 98 });
    // Falls only 0.3 < minTick → hold.
    expect(stopModifyDecision({ side: 'sell', brokerStop: 100, desiredStop: 99.7, minTick: 0.5 }))
      .toEqual({ shouldModify: false, nextStop: 100 });
    // Desired is HIGHER (would loosen) → never modify a short's stop up.
    expect(stopModifyDecision({ side: 'sell', brokerStop: 100, desiredStop: 102, minTick: 0.5 }))
      .toEqual({ shouldModify: false, nextStop: 100 });
  });

  it('fails safe on a degenerate minTick (never loosens/churns)', () => {
    expect(stopModifyDecision({ side: 'buy', brokerStop: 100, desiredStop: 105, minTick: 0 }).shouldModify)
      .toBe(false);
    expect(stopModifyDecision({ side: 'buy', brokerStop: 100, desiredStop: 105, minTick: NaN }).shouldModify)
      .toBe(false);
  });
});

// TRA-4006 re-pinned the Rule 2 schedule: arm 1.0R → 0.75R, give-back 1.0R →
// 0.40R, tightened give-back 0.5R → 0.25R (tighten peak 2.0R unchanged). The
// pre-change pins are kept in the comments so the intent of each case survives.
describe('Rule 2 — trade-level profit-lock', () => {
  it('disarmed until peak favorable excursion reaches 0.75R', () => {
    // entry 100, stop 95 → R = 5. Peak 103 → peakR 0.6 (not armed).
    // (Pre-TRA-4006 this case used peak 104 = 0.8R against a 1.0R arm; 0.8R now
    // arms, so the disarmed case has to sit below 0.75R.)
    const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 103, currentPrice: 101 });
    expect(d.R).toBe(5);
    expect(d.armed).toBe(false);
    expect(d.shouldExit).toBe(false);
  });

  it('armed at +0.75R: exits on a 0.40R give-back from peak', () => {
    // R = 5. Peak 106 → peakR 1.2. Current 100 → currentR 0 ≤ 1.2 − 0.4 = 0.8 → exit.
    const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 106, currentPrice: 100 });
    expect(d.armed).toBe(true);
    expect(d.giveBackR).toBe(0.40); // was 1.0 before TRA-4006
    expect(d.shouldExit).toBe(true);
  });

  it('armed but still holding when give-back is within 0.40R', () => {
    // Peak 106 (1.2R), current 105 (1.0R). 1.0 ≤ 1.2 − 0.4 = 0.8 ? no → hold.
    // (Pre-TRA-4006: current 104 = 0.8R held against a 1.0R allowance; under the
    // 0.40R allowance 0.8R IS the release level for a 1.2R peak — pinned below.)
    const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 106, currentPrice: 105 });
    expect(d.shouldExit).toBe(false);
    // One tick under the release level (peakR − giveBackR = 0.8R) → exit, and
    // the row is released with ~+0.8R still on it, not at breakeven. (Exactly
    // 104 is a float tie — 0.8 vs 1.2 − 0.4 = 0.7999… — so the pin sits a tick
    // inside.)
    const atLevel = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 106, currentPrice: 103.99 });
    expect(atLevel.currentR).toBeCloseTo(0.8, 2);
    expect(atLevel.shouldExit).toBe(true);
  });

  it('tightens to a 0.25R give-back once peakR ≥ 2.0', () => {
    // Peak 111 → peakR 2.2 → allowance 0.25R. Current 109.5 → currentR 1.9.
    // 1.9 ≤ 2.2 − 0.25 = 1.95 → exit (would still be holding under the 0.40R
    // rule: 1.9 ≤ 1.8 is false).
    // (Pre-TRA-4006: allowance 0.5R, current 108 = 1.6R ≤ 1.7 → exit.)
    const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 111, currentPrice: 109.5 });
    expect(d.giveBackR).toBe(0.25); // was 0.5 before TRA-4006
    expect(d.shouldExit).toBe(true);
    const underBase = profitLockDecision({
      side: 'buy', entry: 100, initialStop: 95, peakPrice: 111, currentPrice: 109.5, tightenPeakR: Infinity,
    });
    expect(underBase.giveBackR).toBe(0.40);
    expect(underBase.shouldExit).toBe(false);
  });

  it('short side mirrors long', () => {
    // entry 100, stop 105 → R 5. Peak (low) 94 → peakR 1.2. Current 100 → currentR 0 → exit.
    const d = profitLockDecision({ side: 'sell', entry: 100, initialStop: 105, peakPrice: 94, currentPrice: 100 });
    expect(d.armed).toBe(true);
    expect(d.shouldExit).toBe(true);
  });

  it('degenerate R (entry == stop) stays disarmed', () => {
    const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 100, peakPrice: 120, currentPrice: 90 });
    expect(d.R).toBe(0);
    expect(d.armed).toBe(false);
    expect(d.shouldExit).toBe(false);
  });
});

describe('Rule 3 — book-level daily give-back cap', () => {
  it('the headline case: +$1,599 peak, halts once below ~+$960 (40% give-back)', () => {
    const floorHold = bookGiveBackDecision({ peakOpenGain: 1599, currentTotalPnl: 1000, sessionStopArmGain: 100 });
    expect(floorHold.retainedFloor).toBeCloseTo(959.4, 1);
    expect(floorHold.shouldFlattenAndHalt).toBe(false); // 1000 > 959.4 → still holding

    const tripped = bookGiveBackDecision({ peakOpenGain: 1599, currentTotalPnl: 483, sessionStopArmGain: 100 });
    expect(tripped.shouldFlattenAndHalt).toBe(true);
    expect(tripped.reason).toBe('giveback_cap');
  });

  it('does not halt when the book never had a positive peak', () => {
    const d = bookGiveBackDecision({ peakOpenGain: 0, currentTotalPnl: -50, sessionStopArmGain: 100 });
    expect(d.shouldFlattenAndHalt).toBe(false);
  });

  it('session stop: net-negative after being up > 0.5R book equity latches', () => {
    // armGain 500 (0.5R of book), peak 700 ≥ 500, now −20 → session stop.
    const d = bookGiveBackDecision({ peakOpenGain: 700, currentTotalPnl: -20, sessionStopArmGain: 500 });
    expect(d.shouldFlattenAndHalt).toBe(true);
    expect(d.reason).toBe('session_net_negative');
  });

  it('session stop does not arm if the book never reached the arm gain', () => {
    // peak 300 < armGain 500, now −20 → give-back cap math (floor 180) also
    // trips because −20 < 180, but the reason is the give-back cap, not the stop.
    const d = bookGiveBackDecision({ peakOpenGain: 300, currentTotalPnl: -20, sessionStopArmGain: 500 });
    expect(d.reason).toBe('giveback_cap');
  });

  it('custom give-back cap pct is honored', () => {
    // 25% cap on a +$1,000 peak → floor $750.
    const d = bookGiveBackDecision({ peakOpenGain: 1000, currentTotalPnl: 800, sessionStopArmGain: 100, giveBackCapPct: 0.25 });
    expect(d.retainedFloor).toBe(750);
    expect(d.shouldFlattenAndHalt).toBe(false);
  });

  // TRA-1435 — minimum ARM floor: a trivial peak day can never latch a halt.
  // Book = $2,241 → 1R = 1% = $22.41, 0.5R = $11.20, arm floor = max($25, $11.20)
  // = $25 (the same shape the wiring computes).
  describe('minimum arm floor (TRA-1435)', () => {
    const ARM_FLOOR = 25; // max($25, 0.5R of a $2.2k book)

    it('(a) does NOT halt on a tiny-peak day below the arm floor (the observed bug)', () => {
      // The Richard book today: peaked +$7, gave back to +$1.87 (well past the
      // 40% cap: floor would be $4.20) — but the +$7 peak never reached the $25
      // arm floor, so the give-back cap must NOT arm.
      const d = bookGiveBackDecision({
        peakOpenGain: 7,
        currentTotalPnl: 1.87,
        sessionStopArmGain: 11.2, // 0.5R of the $2.2k book
        giveBackArmFloor: ARM_FLOOR,
      });
      expect(d.giveBackArmFloor).toBe(25);
      expect(d.shouldFlattenAndHalt).toBe(false);
      expect(d.reason).toBeNull();
    });

    it('(a-legacy) WOULD halt on the same tiny peak with no arm floor (flag-off behavior)', () => {
      // Proves the change is behavior-preserving when the arm floor is 0: the
      // caller passes 0 (flag off) and the legacy arm-at-any-peak halt fires.
      const d = bookGiveBackDecision({ peakOpenGain: 7, currentTotalPnl: 1.87, sessionStopArmGain: 11.2 });
      expect(d.giveBackArmFloor).toBe(0);
      expect(d.shouldFlattenAndHalt).toBe(true);
      expect(d.reason).toBe('giveback_cap');
    });

    it('(b) DOES halt once the peak clears the arm floor and gives back >40%', () => {
      // Peak +$50 (≥ $25 floor), floor = $30; drop to +$25 (<$30) → halt as today.
      const d = bookGiveBackDecision({
        peakOpenGain: 50,
        currentTotalPnl: 25,
        sessionStopArmGain: 11.2,
        giveBackArmFloor: ARM_FLOOR,
      });
      expect(d.retainedFloor).toBe(30);
      expect(d.shouldFlattenAndHalt).toBe(true);
      expect(d.reason).toBe('giveback_cap');
    });

    it('(c) the +$1,599 headline case is unchanged with an arm floor set', () => {
      // A $25 arm floor is far below a +$1,599 peak, so the real give-back halt
      // still fires exactly as before.
      const d = bookGiveBackDecision({
        peakOpenGain: 1599,
        currentTotalPnl: 483,
        sessionStopArmGain: 100,
        giveBackArmFloor: ARM_FLOOR,
      });
      expect(d.shouldFlattenAndHalt).toBe(true);
      expect(d.reason).toBe('giveback_cap');
    });

    it('the session stop is NOT gated by the give-back arm floor', () => {
      // Peak +$15 is below the $25 give-back arm floor but at/above the $11.20
      // session-stop arm; a flip net-negative must still latch the session stop.
      const d = bookGiveBackDecision({
        peakOpenGain: 15,
        currentTotalPnl: -3,
        sessionStopArmGain: 11.2,
        giveBackArmFloor: ARM_FLOOR,
      });
      expect(d.shouldFlattenAndHalt).toBe(true);
      expect(d.reason).toBe('session_net_negative');
    });

    it('a negative/NaN arm floor is clamped to 0 (cannot re-enable at any peak by accident)', () => {
      const d = bookGiveBackDecision({ peakOpenGain: 7, currentTotalPnl: 1.87, sessionStopArmGain: 11.2, giveBackArmFloor: -100 });
      expect(d.giveBackArmFloor).toBe(0);
      expect(d.shouldFlattenAndHalt).toBe(true); // clamped to legacy arm-at-any-peak
    });
  });
});

describe('Rule 4 (TRA-1294) — take-profit-early', () => {
  it('long: holds below the capture threshold and banks once it is reached', () => {
    // Entry 1.00, target 2.00 ⇒ available profit 1.00. Default capture = 0.60.
    const below = takeProfitEarlyDecision({ side: 'buy', entry: 1, currentPrice: 1.5, maxProfitPrice: 2 });
    expect(below.capturedFrac).toBeCloseTo(0.5, 6);
    expect(below.shouldExit).toBe(false);

    const above = takeProfitEarlyDecision({ side: 'buy', entry: 1, currentPrice: 1.7, maxProfitPrice: 2 });
    expect(above.capturedFrac).toBeCloseTo(0.7, 6);
    expect(above.shouldExit).toBe(true);
  });

  it('short: banks 50–70% of the credit as price falls toward zero', () => {
    // Sold a spread for 1.00 credit; max profit at price 0. Buy back at 0.30 ⇒
    // captured 70% of the credit (past the 60% default).
    const d = takeProfitEarlyDecision({ side: 'sell', entry: 1, currentPrice: 0.3, maxProfitPrice: 0 });
    expect(d.availableProfit).toBeCloseTo(1, 6);
    expect(d.currentProfit).toBeCloseTo(0.7, 6);
    expect(d.capturedFrac).toBeCloseTo(0.7, 6);
    expect(d.shouldExit).toBe(true);
  });

  it('honors a custom capture fraction (board 50–70% range)', () => {
    const loose = takeProfitEarlyDecision({ side: 'buy', entry: 1, currentPrice: 1.5, maxProfitPrice: 2, captureFrac: 0.5 });
    expect(loose.shouldExit).toBe(true);
    const tight = takeProfitEarlyDecision({ side: 'buy', entry: 1, currentPrice: 1.65, maxProfitPrice: 2, captureFrac: 0.7 });
    expect(tight.shouldExit).toBe(false);
  });

  it('defers (no-op) on a non-finite target — e.g. an un-set TP1 of +∞', () => {
    const d = takeProfitEarlyDecision({ side: 'buy', entry: 1, currentPrice: 5, maxProfitPrice: Number.POSITIVE_INFINITY });
    expect(d.availableProfit).toBe(0);
    expect(d.shouldExit).toBe(false);
  });

  it('defers on a degenerate / inverted runway (target ≤ entry for a long)', () => {
    const d = takeProfitEarlyDecision({ side: 'buy', entry: 2, currentPrice: 2.5, maxProfitPrice: 2 });
    expect(d.shouldExit).toBe(false);
  });

  it('a losing open position never banks (captured fraction floored at 0)', () => {
    const d = takeProfitEarlyDecision({ side: 'buy', entry: 1, currentPrice: 0.7, maxProfitPrice: 2 });
    expect(d.capturedFrac).toBe(0);
    expect(d.shouldExit).toBe(false);
  });
});

// TRA-1295 — Rule 5, the "7%" leg of the 3-5-7 governor: the correlated-exposure
// cap. Aggregate open per-trade $risk in one correlated group (underlying /
// sector / asset-class) may not exceed 7% of managed equity; a candidate that
// would breach a group is scaled to headroom, or rejected below the min floor.
describe('Rule 5 — correlated-exposure cap (TRA-1295)', () => {
  const EQ = 100_000; // 7% cap ⇒ $7,000 per group; 0.25% floor ⇒ $250

  it('admits at full size when every group has room for the candidate', () => {
    const d = correlatedExposureDecision({
      candidateRisk: 1_000,
      managedEquity: EQ,
      buckets: [{ level: 'assetClass', key: 'equity', openRisk: 2_000 }], // 2k + 1k = 3k < 7k
    });
    expect(d.admitted).toBe(true);
    expect(d.scale).toBe(1);
    expect(d.bindingBucket).toBeNull();
    expect(d.headroom).toBe(Number.POSITIVE_INFINITY);
  });

  it('scales the candidate DOWN to the most-binding group headroom', () => {
    // asset-class already holds $6,500 → only $500 headroom for a $1,000 candidate.
    const d = correlatedExposureDecision({
      candidateRisk: 1_000,
      managedEquity: EQ,
      buckets: [
        { level: 'underlying', key: 'AAPL', openRisk: 0 },
        { level: 'assetClass', key: 'equity', openRisk: 6_500 },
      ],
    });
    expect(d.admitted).toBe(true);
    expect(d.scale).toBeCloseTo(0.5, 9); // 500 / 1000
    expect(d.headroom).toBeCloseTo(500, 6);
    expect(d.bindingBucket).toEqual({ level: 'assetClass', key: 'equity' });
  });

  it('takes the SMALLEST headroom across grains (underlying binds before asset-class)', () => {
    const d = correlatedExposureDecision({
      candidateRisk: 1_000,
      managedEquity: EQ,
      buckets: [
        { level: 'underlying', key: 'AAPL', openRisk: 6_600 }, // 400 room — tightest (still above the $250 floor)
        { level: 'sector', key: 'tech', openRisk: 5_000 }, // 2,000 room
        { level: 'assetClass', key: 'equity', openRisk: 3_000 }, // 4,000 room
      ],
    });
    expect(d.scale).toBeCloseTo(0.4, 9); // 400 / 1000
    expect(d.bindingBucket).toEqual({ level: 'underlying', key: 'AAPL' });
  });

  it('rejects when the binding headroom falls below the min-trade-risk floor', () => {
    // $6,900 already committed → $100 headroom < the $250 (0.25%) floor.
    const d = correlatedExposureDecision({
      candidateRisk: 1_000,
      managedEquity: EQ,
      buckets: [{ level: 'assetClass', key: 'options', openRisk: 6_900 }],
    });
    expect(d.admitted).toBe(false);
    expect(d.scale).toBe(0);
    expect(d.reason).toBe('below_min_trade_risk');
    expect(d.bindingBucket).toEqual({ level: 'assetClass', key: 'options' });
  });

  it('rejects when a group is already at/over the cap (no negative headroom)', () => {
    const d = correlatedExposureDecision({
      candidateRisk: 500,
      managedEquity: EQ,
      buckets: [{ level: 'sector', key: 'energy', openRisk: 7_500 }], // over the $7k cap
    });
    expect(d.admitted).toBe(false);
    expect(d.reason).toBe('below_min_trade_risk');
    expect(d.headroom).toBe(0); // clamped, never negative
  });

  it('rejects a candidate with no measurable risk instead of dividing by zero', () => {
    const d = correlatedExposureDecision({
      candidateRisk: 0,
      managedEquity: EQ,
      buckets: [{ level: 'assetClass', key: 'equity', openRisk: 0 }],
    });
    expect(d.admitted).toBe(false);
    expect(d.reason).toBe('non_positive_risk');
  });

  it('honors a per-bucket capPct override (tighten one grain below the 7% default)', () => {
    // underlying capped at 2% ($2,000); $1,500 open ⇒ $500 headroom binds.
    const d = correlatedExposureDecision({
      candidateRisk: 1_000,
      managedEquity: EQ,
      buckets: [{ level: 'underlying', key: 'TSLA', openRisk: 1_500, capPct: 0.02 }],
    });
    expect(d.scale).toBeCloseTo(0.5, 9);
    expect(d.bindingBucket).toEqual({ level: 'underlying', key: 'TSLA' });
  });

  it('admits full size on an exact fit (headroom === candidate risk)', () => {
    const d = correlatedExposureDecision({
      candidateRisk: 1_000,
      managedEquity: EQ,
      buckets: [{ level: 'assetClass', key: 'equity', openRisk: 6_000 }], // exactly $1,000 room
    });
    expect(d.admitted).toBe(true);
    expect(d.scale).toBe(1);
    expect(d.bindingBucket).toBeNull(); // an exact fit is not "bound"
  });

  describe('buildExposureBuckets', () => {
    const candidate: ExposurePositionRisk = { underlying: 'AAPL', sector: 'tech', assetClass: 'equity', risk: 1_000 };
    const open: ExposurePositionRisk[] = [
      { underlying: 'AAPL', sector: 'tech', assetClass: 'equity', risk: 400 }, // same underlying
      { underlying: 'MSFT', sector: 'tech', assetClass: 'equity', risk: 600 }, // same sector, diff underlying
      { underlying: 'XOM', sector: 'energy', assetClass: 'equity', risk: 800 }, // same asset-class only
      { underlying: 'GLD', sector: undefined, assetClass: 'commodity', risk: 999 }, // shares nothing
    ];

    it('sums OPEN risk per grain the candidate shares, excluding its own risk', () => {
      const buckets = buildExposureBuckets(candidate, open);
      const byLevel = Object.fromEntries(buckets.map((b) => [b.level, b]));
      expect(byLevel.underlying).toMatchObject({ key: 'AAPL', openRisk: 400 });
      expect(byLevel.sector).toMatchObject({ key: 'tech', openRisk: 1_000 }); // 400 + 600
      expect(byLevel.assetClass).toMatchObject({ key: 'equity', openRisk: 1_800 }); // 400 + 600 + 800
    });

    it('skips a grain the candidate has no key for (missing sector), never a catch-all', () => {
      const noSector: ExposurePositionRisk = { underlying: 'GLD', assetClass: 'commodity', risk: 500 };
      const buckets = buildExposureBuckets(noSector, open);
      expect(buckets.map((b) => b.level)).toEqual(['underlying', 'assetClass']);
    });

    it('feeds straight into the decision — a crowded sector scales the candidate down', () => {
      const buckets = buildExposureBuckets(candidate, open, { sector: 0.015 }); // sector cap 1.5% = $1,500
      const d = correlatedExposureDecision({ candidateRisk: 1_000, managedEquity: 100_000, buckets });
      // sector already holds $1,000 → $500 headroom under the tightened 1.5% cap.
      expect(d.scale).toBeCloseTo(0.5, 9);
      expect(d.bindingBucket).toEqual({ level: 'sector', key: 'tech' });
    });
  });
});

describe('PoP / delta entry gate + Delta/Theta ratio floor (TRA-1293)', () => {
  // A comfortably-passing baseline: 0.35 |delta| in-band, plenty of delta per
  // dollar/day of decay (0.35 / 0.02 = 17.5 ≥ 6.0 floor).
  const base = { shortDelta: 0.35, delta: 0.35, thetaPerDay: -0.02 };

  it('admits a strike in the delta band with an ample delta/theta ratio', () => {
    const g = entryGreeksGateDecision(base);
    expect(g.admitted).toBe(true);
    expect(g.reason).toBeNull();
    expect(g.shortDelta).toBe(0.35);
    expect(g.deltaThetaRatio).toBeCloseTo(17.5, 6);
  });

  it('uses |·| so a short (negative-delta) leg is judged on magnitude', () => {
    const g = entryGreeksGateDecision({ shortDelta: -0.35, delta: -0.35, thetaPerDay: 0.02 });
    expect(g.admitted).toBe(true);
    expect(g.shortDelta).toBe(0.35);
  });

  it('rejects a strike below the delta band (far-OTM lottery ticket)', () => {
    const g = entryGreeksGateDecision({ ...base, shortDelta: 0.20, delta: 0.20 });
    expect(g.admitted).toBe(false);
    expect(g.reason).toBe('delta_out_of_band');
  });

  it('rejects a strike above the delta band (deep-ITM, too much premium at risk)', () => {
    const g = entryGreeksGateDecision({ ...base, shortDelta: 0.55, delta: 0.55 });
    expect(g.admitted).toBe(false);
    expect(g.reason).toBe('delta_out_of_band');
  });

  it('admits exactly at both band edges (inclusive bounds)', () => {
    expect(entryGreeksGateDecision({ ...base, shortDelta: 0.30, delta: 0.30 }).admitted).toBe(true);
    expect(entryGreeksGateDecision({ ...base, shortDelta: 0.40, delta: 0.40 }).admitted).toBe(true);
  });

  it('rejects when the delta/theta ratio is below the floor (decay bleeds the delta)', () => {
    // in-band delta but heavy decay: 0.35 / 0.10 = 3.5 < 6.0 floor.
    const g = entryGreeksGateDecision({ shortDelta: 0.35, delta: 0.35, thetaPerDay: -0.10 });
    expect(g.admitted).toBe(false);
    expect(g.reason).toBe('delta_theta_ratio_too_low');
    expect(g.deltaThetaRatio).toBeCloseTo(3.5, 6);
  });

  it('treats ~zero theta as no decay to fight (ratio = +∞, passes)', () => {
    const g = entryGreeksGateDecision({ shortDelta: 0.35, delta: 0.35, thetaPerDay: 0 });
    expect(g.admitted).toBe(true);
    expect(g.deltaThetaRatio).toBe(Number.POSITIVE_INFINITY);
  });

  it('honors caller overrides for the band and ratio floor', () => {
    const g = entryGreeksGateDecision({
      shortDelta: 0.50,
      delta: 0.50,
      thetaPerDay: -0.02,
      deltaBandMin: 0.45,
      deltaBandMax: 0.55,
      ratioFloor: 10,
    });
    expect(g.admitted).toBe(true);
    expect(g.deltaBandMin).toBe(0.45);
    expect(g.ratioFloor).toBe(10);
  });

  it('rejects non-finite Greeks rather than silently admitting', () => {
    const g = entryGreeksGateDecision({ shortDelta: NaN, delta: 0.35, thetaPerDay: -0.02 });
    expect(g.admitted).toBe(false);
    expect(g.reason).toBe('non_finite_greeks');
  });
});
