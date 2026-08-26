// TRA-4020 (parent TRA-4010) — R1: the ratcheting profit floor in
// `profitLockDecision`, and the properties the ticket asks to have ASSERTED
// rather than argued:
//
//   AC1  ladder absent ⇒ byte-identical to the pre-change rule, on the peakR
//        grid 0.5 / 1.0 / 1.5 / 2.0 / 3.0 (the pre-change rule is re-derived
//        inline from the four `PROFIT_LOCK_*` constants — comparing the
//        function with itself would prove nothing);
//   AC2  ladder present ⇒ peakR 1.0 exits no lower than +0.25R, 1.6 no lower
//        than +1.0R, 2.6 no lower than +2.0R; the exit level is non-decreasing
//        in peakR;
//   the docblock's safety claim ⇒ the shipped ladder is NO LOOSER than the
//        shipped flag-off rule at every peakR — it arms where the lock arms and
//        its exit level is never below the lock's — so it can only exit earlier
//        with more locked, never open a loss path the shipped rule lacked.
//
// The live NVTS row (entry 1.51, stop 1.208, peak ≥ 1.822) is kept as the
// regression case: under the ladder the FLOOR leg is through at the 1.52 fill.
import { describe, it, expect } from 'vitest';
import {
  PROFIT_FLOOR_LADDER,
  PROFIT_FLOOR_ARM_R,
  PROFIT_FLOOR_RUNG1_FLOOR_R,
  PROFIT_FLOOR_RUNG2_PEAK_R,
  PROFIT_FLOOR_RUNG2_FLOOR_R,
  PROFIT_FLOOR_RUNG3_PEAK_R,
  PROFIT_FLOOR_RUNG3_FLOOR_R,
  PROFIT_LOCK_ARM_R,
  PROFIT_LOCK_GIVEBACK_R,
  PROFIT_LOCK_TIGHTEN_PEAK_R,
  PROFIT_LOCK_TIGHTEN_GIVEBACK_R,
  type ProfitFloorLadderStep,
} from '@trading-app/shared';
import { profitLockDecision, type ProfitLockDecision } from './exit-rules.js';

// R = 1 so peakR / currentR are the price offsets themselves.
const ENTRY = 100;
const STOP = 99;

function decide(peakR: number, currentR: number, ladder?: readonly ProfitFloorLadderStep[]): ProfitLockDecision {
  return profitLockDecision({
    side: 'buy',
    entry: ENTRY,
    initialStop: STOP,
    peakPrice: ENTRY + peakR,
    currentPrice: ENTRY + currentR,
    ...(ladder === undefined ? {} : { floorLadder: ladder }),
  });
}

/**
 * The rule as it shipped BEFORE this ticket, re-derived from the constants. If
 * someone edits `profitLockDecision`'s flag-off branch, AC1 below fails against
 * THIS, not against the edited function.
 */
function shippedRule(peakR: number, currentR: number): { armed: boolean; giveBackR: number; shouldExit: boolean } {
  const armed = peakR >= PROFIT_LOCK_ARM_R;
  const giveBackR = peakR >= PROFIT_LOCK_TIGHTEN_PEAK_R ? PROFIT_LOCK_TIGHTEN_GIVEBACK_R : PROFIT_LOCK_GIVEBACK_R;
  return { armed, giveBackR, shouldExit: armed && currentR <= peakR - giveBackR };
}

const sweep = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v = Math.round((v + step) * 1e6) / 1e6) out.push(v);
  return out;
};

describe('TRA-4020 AC1 — ladder ABSENT is the pre-change rule, byte for byte', () => {
  it('matches the re-derived shipped rule on the 0.5 / 1.0 / 1.5 / 2.0 / 3.0 peakR grid, over a currentR sweep', () => {
    for (const peakR of [0.5, 1.0, 1.5, 2.0, 3.0]) {
      for (const currentR of sweep(-1.0, peakR, 0.05)) {
        const d = decide(peakR, currentR);
        const expected = shippedRule(d.peakR, d.currentR);
        // The exact key set — no `floor` leaks out when no ladder went in.
        expect(Object.keys(d).sort()).toEqual(['R', 'armed', 'currentR', 'giveBackR', 'peakR', 'shouldExit']);
        expect(d.floor).toBeUndefined();
        expect(d.armed).toBe(expected.armed);
        expect(d.giveBackR).toBe(expected.giveBackR);
        expect(d.shouldExit).toBe(expected.shouldExit);
      }
    }
  });

  it('an EMPTY ladder is treated as absent (nothing to arm on ⇒ the shipped rule)', () => {
    const d = decide(1.0, 0.5, []);
    expect(d.floor).toBeUndefined();
    expect(d.shouldExit).toBe(shippedRule(1.0, 0.5).shouldExit);
  });
});

describe('TRA-4020 AC2 — the ladder floors', () => {
  it('ships the ruled rungs: arm 0.75R → floor 0.25R; 1.5R → 1.0R; 2.5R → 2.0R', () => {
    expect(PROFIT_FLOOR_ARM_R).toBe(0.75);
    expect(PROFIT_FLOOR_RUNG1_FLOOR_R).toBe(0.25);
    expect(PROFIT_FLOOR_RUNG2_PEAK_R).toBe(1.5);
    expect(PROFIT_FLOOR_RUNG2_FLOOR_R).toBe(1.0);
    expect(PROFIT_FLOOR_RUNG3_PEAK_R).toBe(2.5);
    expect(PROFIT_FLOOR_RUNG3_FLOOR_R).toBe(2.0);
    // Rungs ascend in peakR and every value is a finite positive R.
    for (let i = 0; i < PROFIT_FLOOR_LADDER.length; i++) {
      const s = PROFIT_FLOOR_LADDER[i]!;
      for (const v of [s.peakR, s.giveBackR, s.floorR]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      if (i > 0) expect(s.peakR).toBeGreaterThan(PROFIT_FLOOR_LADDER[i - 1]!.peakR);
      // A floor above its own rung's peak would exit on the arming tick.
      expect(s.floorR).toBeLessThan(s.peakR);
    }
  });

  it('peakR 1.0 → exit no lower than +0.25R; 1.6 → no lower than +1.0R; 2.6 → no lower than +2.0R', () => {
    const cases: Array<[number, number]> = [[1.0, 0.25], [1.6, 1.0], [2.6, 2.0]];
    for (const [peakR, floorR] of cases) {
      const armed = decide(peakR, peakR, PROFIT_FLOOR_LADDER);
      expect(armed.armed).toBe(true);
      expect(armed.floor).toBeDefined();
      expect(armed.floor!.floorR).toBe(floorR);
      expect(armed.floor!.exitLevelR).toBeGreaterThanOrEqual(floorR);
      // Just under the floor: the exit fires and it is the FLOOR leg.
      const under = decide(peakR, floorR - 0.01, PROFIT_FLOOR_LADDER);
      expect(under.shouldExit).toBe(true);
      expect(under.floor!.floorLeg).toBe(true);
      // Nowhere in (floorR, ∞) can the rule be holding below the floor: any
      // currentR ≤ floorR exits.
      for (const currentR of sweep(-1, floorR, 0.05)) {
        expect(decide(peakR, currentR, PROFIT_FLOOR_LADDER).shouldExit).toBe(true);
      }
    }
  });

  it('below the arm the ladder is disarmed and never exits, however far the row has fallen', () => {
    for (const peakR of [0, 0.5, 0.74]) {
      const d = decide(peakR, -0.9, PROFIT_FLOOR_LADDER);
      expect(d.armed).toBe(false);
      expect(d.shouldExit).toBe(false);
      expect(d.floor).toBeUndefined();
    }
    // The boundary is inclusive, and arming alone (no give-back yet) holds.
    const atArm = decide(PROFIT_FLOOR_ARM_R, PROFIT_FLOOR_ARM_R, PROFIT_FLOOR_LADDER);
    expect(atArm.armed).toBe(true);
    expect(atArm.shouldExit).toBe(false);
    expect(atArm.floor!.floorR).toBe(PROFIT_FLOOR_RUNG1_FLOOR_R);
  });

  it('PROPERTY — the exit level and the floor are non-decreasing in peakR, so once armed the level never falls', () => {
    let prevLevel = -Infinity;
    let prevFloor = -Infinity;
    for (const peakR of sweep(PROFIT_FLOOR_ARM_R, 6, 0.01)) {
      const d = decide(peakR, 0, PROFIT_FLOOR_LADDER);
      expect(d.armed).toBe(true);
      expect(d.floor!.exitLevelR).toBeGreaterThanOrEqual(prevLevel - 1e-9);
      expect(d.floor!.floorR).toBeGreaterThanOrEqual(prevFloor - 1e-9);
      // The level is never below the floor, by construction of `max`.
      expect(d.floor!.exitLevelR).toBeGreaterThanOrEqual(d.floor!.floorR);
      prevLevel = d.floor!.exitLevelR;
      prevFloor = d.floor!.floorR;
    }
  });

  it('the two legs are distinguishable: floorLeg ⇒ shouldExit, and a give-back exit above the floor is NOT the floor leg', () => {
    // peakR 1.0: level = max(1.0 − 0.40, 0.25) = 0.60, floor 0.25.
    const giveBack = decide(1.0, 0.5, PROFIT_FLOOR_LADDER);
    expect(giveBack.shouldExit).toBe(true);
    expect(giveBack.floor!.floorLeg).toBe(false);
    const floor = decide(1.0, 0.2, PROFIT_FLOOR_LADDER);
    expect(floor.shouldExit).toBe(true);
    expect(floor.floor!.floorLeg).toBe(true);
    const hold = decide(1.0, 0.7, PROFIT_FLOOR_LADDER);
    expect(hold.shouldExit).toBe(false);
    expect(hold.floor!.floorLeg).toBe(false);
  });

  it('degenerate R (entry == stop / NaN) stays disarmed with the ladder too, and carries no floor', () => {
    const zero = profitLockDecision({ side: 'buy', entry: 100, initialStop: 100, peakPrice: 120, currentPrice: 90, floorLadder: PROFIT_FLOOR_LADDER });
    expect(zero.armed).toBe(false);
    expect(zero.shouldExit).toBe(false);
    expect(zero.floor).toBeUndefined();
    const nan = profitLockDecision({ side: 'buy', entry: 100, initialStop: NaN, peakPrice: 120, currentPrice: 90, floorLadder: PROFIT_FLOOR_LADDER });
    expect(nan.shouldExit).toBe(false);
    expect(nan.floor).toBeUndefined();
  });
});

describe('TRA-4020 — the shipped ladder is NO LOOSER than the shipped flag-off rule at every peakR', () => {
  // The docblock's claim, asserted: "it can only ever exit earlier with more
  // locked — it cannot create a loss path that did not exist". Two halves:
  // (1) it arms exactly where the lock arms (no NEW armed states that the
  // shipped rule would have left to the hard stop — and none missing);
  // (2) wherever armed, its exit level ≥ the shipped level, so every mark the
  // shipped rule exits on, the ladder exits on too, at the same mark or higher.
  it('arms where the lock arms, and the exit level is never below the lock’s', () => {
    for (const peakR of sweep(0, 6, 0.01)) {
      const ladder = decide(peakR, 0, PROFIT_FLOOR_LADDER);
      const shipped = shippedRule(ladder.peakR, 0);
      expect(ladder.armed).toBe(shipped.armed);
      if (!shipped.armed) continue;
      const shippedLevel = ladder.peakR - shipped.giveBackR;
      expect(ladder.floor!.exitLevelR).toBeGreaterThanOrEqual(shippedLevel - 1e-9);
    }
  });

  it('⇒ shippedRule.shouldExit implies ladder.shouldExit on a (peakR, currentR) grid', () => {
    for (const peakR of sweep(0, 4, 0.05)) {
      for (const currentR of sweep(-1, peakR, 0.05)) {
        const ladder = decide(peakR, currentR, PROFIT_FLOOR_LADDER);
        const shipped = shippedRule(ladder.peakR, ladder.currentR);
        if (shipped.shouldExit) expect(ladder.shouldExit).toBe(true);
      }
    }
  });

  it('NEGATIVE CONTROL — a ladder that loosens the give-back (the spec’s 0.50 column) fails the property, which is why it does not ship', () => {
    const loosened: ProfitFloorLadderStep[] = [
      { peakR: 0.75, giveBackR: 0.5, floorR: 0.25 },
      { peakR: 1.5, giveBackR: 0.5, floorR: 1.0 },
      { peakR: 2.5, giveBackR: 0.4, floorR: 2.0 },
    ];
    let violations = 0;
    for (const peakR of sweep(PROFIT_LOCK_ARM_R, 6, 0.01)) {
      const d = decide(peakR, 0, loosened);
      const shippedLevel = d.peakR - shippedRule(d.peakR, 0).giveBackR;
      if (d.floor!.exitLevelR < shippedLevel - 1e-9) violations += 1;
    }
    expect(violations).toBeGreaterThan(0);
  });
});

describe('TRA-4020 — the live NVTS row is the regression case', () => {
  // entry 1.51, OTM day-one stop 1.208 ⇒ R = 0.302; peak ≥ 1.822 ⇒ peakR ≥ 1.033.
  const NVTS = { side: 'buy', entry: 1.51, initialStop: 1.208, peakPrice: 1.823, floorLadder: PROFIT_FLOOR_LADDER } as const;

  it('at the 1.52 fill (+0.033R) the FLOOR leg is through — the leg that fires through the opening-range window', () => {
    const d = profitLockDecision({ ...NVTS, currentPrice: 1.52 });
    expect(d.armed).toBe(true);
    expect(d.floor!.floorR).toBe(0.25);
    expect(d.floor!.floorLeg).toBe(true);
    expect(d.shouldExit).toBe(true);
  });

  it('the row is released at ≈1.70 (+0.64R) by the give-back leg first, with the floor as the backstop at ≈1.585', () => {
    // peak 1.823 ⇒ peakR 1.0364 ⇒ level = 1.51 + (1.0364 − 0.40) × 0.302 = 1.7022.
    const level = NVTS.entry + profitLockDecision({ ...NVTS, currentPrice: 1.71 }).floor!.exitLevelR * (1.51 - 1.208);
    expect(level).toBeCloseTo(1.7022, 3);
    expect(profitLockDecision({ ...NVTS, currentPrice: 1.71 }).shouldExit).toBe(false);
    const released = profitLockDecision({ ...NVTS, currentPrice: 1.70 });
    expect(released.shouldExit).toBe(true);
    expect(released.floor!.floorLeg).toBe(false); // give-back leg: trail-family, window applies
    const floorPrice = NVTS.entry + 0.25 * (1.51 - 1.208);
    expect(floorPrice).toBeCloseTo(1.5855, 4);
    expect(profitLockDecision({ ...NVTS, currentPrice: 1.58 }).floor!.floorLeg).toBe(true);
  });
});
