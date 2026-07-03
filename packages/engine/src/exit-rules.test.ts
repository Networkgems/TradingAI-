import { describe, it, expect } from 'vitest';
import {
  chandelierMultiplier,
  chandelierStop,
  chandelierExitTriggered,
  stopModifyDecision,
  profitLockDecision,
  bookGiveBackDecision,
} from './exit-rules.js';

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

describe('Rule 2 — trade-level profit-lock', () => {
  it('disarmed until peak favorable excursion reaches 1.0R', () => {
    // entry 100, stop 95 → R = 5. Peak 104 → peakR 0.8 (not armed).
    const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 104, currentPrice: 101 });
    expect(d.R).toBe(5);
    expect(d.armed).toBe(false);
    expect(d.shouldExit).toBe(false);
  });

  it('armed at +1R: exits on a 1.0R give-back from peak', () => {
    // R = 5. Peak 106 → peakR 1.2. Current 100 → currentR 0 ≤ 1.2 − 1.0 → exit.
    const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 106, currentPrice: 100 });
    expect(d.armed).toBe(true);
    expect(d.giveBackR).toBe(1.0);
    expect(d.shouldExit).toBe(true);
  });

  it('armed but still holding when give-back is within 1.0R', () => {
    // Peak 106 (1.2R), current 104 (0.8R). 0.8 ≤ 1.2 − 1.0 = 0.2 ? no → hold.
    const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 106, currentPrice: 104 });
    expect(d.shouldExit).toBe(false);
  });

  it('tightens to a 0.5R give-back once peakR ≥ 2.0', () => {
    // Peak 111 → peakR 2.2 → allowance 0.5R. Current 108 → currentR 1.6.
    // 1.6 ≤ 2.2 − 0.5 = 1.7 → exit (would still be holding under the 1.0R rule).
    const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 111, currentPrice: 108 });
    expect(d.giveBackR).toBe(0.5);
    expect(d.shouldExit).toBe(true);
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
});
