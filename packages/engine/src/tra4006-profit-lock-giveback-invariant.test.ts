// TRA-4006 — OTM sleeve: profit-lock gave back 100% of the gain that armed it.
//
// `PROFIT_LOCK_ARM_R` and `PROFIT_LOCK_GIVEBACK_R` were BOTH 1.0, so the rule's
// exit floor in its first armed state was `peakR − 1.0 ≈ 0`: a winner that
// peaked just over the arm was released at breakeven. Live instance 2026-08-25
// (bqb1 `877d8f3a`, `/api/trades/export?markets=options`):
//
//   NVTS261002C00012500  live / otm_mispricing
//   entry 1.51 → exit 1.52, exit_reason profit_lock, net +$1.00,
//   pnl_r_stop_basis 0.033, hold 23h
//   stopLossPremium = 1.51 × 0.80 = 1.208 ⇒ R = 0.302
//   currentR at exit = (1.52 − 1.51) / 0.302 = 0.0331 (matches the published column)
//   shouldExit ⇒ peakR ≥ currentR + 1.0 = 1.0331 ⇒ peakPremium ≥ 1.822
//   ⇒ peak open gain ≥ $31.20, realised $1.00, ≥ 96.8% given back.
//
// PROVENANCE OF THE ANCHOR (do not "correct" `entry 1.51` to the export's
// later `1.395`). The figures above were read off the BOOK-sourced export row
// (`export.ts` `rowFromOption`: `entry_price ← opt.premiumPaid`, plus the
// book-only columns `exit_price` and `pnl_r_stop_basis`, which is how we know
// which path served it) between the 13:45Z close and the 21:00 ET archive.
// After `archiveClosedOptions()` the same close is served from the JOURNAL
// (row `63a5bc3a`, order `143196771`), and `export-history.ts`
// `rowFromJournalRecord` publishes `entry_price ← entryMarkUsd` on an
// unrestated row — the scanner's PRE-TRADE MID stamped at open
// (`options-account.ts` open write: `entryMarkUsd: quote.mark`), NOT the
// broker-reconciled basis `restateEngineOpenedBasis()` installs into
// `premiumPaid` and that `profitLockDecision` consumes. So the export's
// 1.395 and this fixture's 1.51 are two different quantities, and only 1.51 is
// the `entry` the exit rule saw. The journal row carries neither `premiumPaid`
// nor `stopLossPremium` (and `peakPremium` only since TRA-4020, forward-only),
// so this anchor is not re-readable from outside the box after the archive.
//
// The ruling (QuantTrader, on the ticket) decouples the arm from the allowance:
// arm 0.75R, give-back 0.40R, tighten at 2.0R to 0.25R. The specific numbers are
// a calibration; the INEQUALITIES are the defect, and they are what this file
// asserts (AC2). A test that only pins the four literals would pass a future
// edit that sets them equal again.
import { describe, it, expect } from 'vitest';
import {
  PROFIT_LOCK_ARM_R,
  PROFIT_LOCK_GIVEBACK_R,
  PROFIT_LOCK_TIGHTEN_PEAK_R,
  PROFIT_LOCK_TIGHTEN_GIVEBACK_R,
} from '@trading-app/shared';
import { profitLockDecision } from './exit-rules.js';

// The schedule that shipped until 2026-08-26, passed through the (unchanged)
// per-call overrides so the defect can be reproduced side by side with the fix.
const PRE_TRA4006 = { armR: 1.0, giveBackR: 1.0, tightenPeakR: 2.0, tightenGiveBackR: 0.5 } as const;

// The live NVTS row, in price terms. `initialStop` is the OTM day-one stop at
// −20% of premium that the row carried (OTM_SL_PCT 0.20).
const NVTS = { side: 'buy', entry: 1.51, initialStop: 1.208, peakPrice: 1.822 } as const;
const NVTS_R = 1.51 - 1.208; // 0.302

describe('TRA-4006 AC2 — the give-back allowance is a STRICT fraction of the gain that arms it', () => {
  it('PROFIT_LOCK_GIVEBACK_R < PROFIT_LOCK_ARM_R', () => {
    // The defect: these were equal (1.0 == 1.0), so the first armed exit floor
    // was zero profit. The inequality — not the literal — is what must hold.
    expect(PROFIT_LOCK_GIVEBACK_R).toBeLessThan(PROFIT_LOCK_ARM_R);
  });

  it('PROFIT_LOCK_TIGHTEN_GIVEBACK_R < PROFIT_LOCK_GIVEBACK_R', () => {
    // "Tighten" has to mean tighter: a big winner keeps MORE of its gain, never
    // less, once the tightened allowance takes over.
    expect(PROFIT_LOCK_TIGHTEN_GIVEBACK_R).toBeLessThan(PROFIT_LOCK_GIVEBACK_R);
  });

  it('the tightened regime starts strictly above the arm, and every constant is a finite positive R', () => {
    expect(PROFIT_LOCK_TIGHTEN_PEAK_R).toBeGreaterThan(PROFIT_LOCK_ARM_R);
    for (const v of [PROFIT_LOCK_ARM_R, PROFIT_LOCK_GIVEBACK_R, PROFIT_LOCK_TIGHTEN_PEAK_R, PROFIT_LOCK_TIGHTEN_GIVEBACK_R]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it('the ruled calibration is what ships (informational pin — the inequalities above are the contract)', () => {
    expect(PROFIT_LOCK_ARM_R).toBe(0.75);
    expect(PROFIT_LOCK_GIVEBACK_R).toBe(0.40);
    expect(PROFIT_LOCK_TIGHTEN_PEAK_R).toBe(2.0);
    expect(PROFIT_LOCK_TIGHTEN_GIVEBACK_R).toBe(0.25);
  });

  it('the exit floor (peakR − allowance) is strictly positive and non-decreasing across every armed state', () => {
    // Under the old schedule the floor at peakR == armR was exactly 0. Under any
    // schedule satisfying the inequalities it is armR − giveBackR > 0 at the arm
    // and only rises from there (with an upward step at the tighten peak).
    let prevFloor = -Infinity;
    for (let peakR = PROFIT_LOCK_ARM_R; peakR <= 6; peakR = Math.round((peakR + 0.01) * 1000) / 1000) {
      const R = 1;
      const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 100 - R, peakPrice: 100 + peakR * R, currentPrice: 100 });
      expect(d.armed).toBe(true);
      const floor = d.peakR - d.giveBackR;
      expect(floor).toBeGreaterThan(0);
      expect(floor).toBeGreaterThanOrEqual(prevFloor - 1e-9);
      prevFloor = floor;
    }
    // At the arm itself the floor is armR − giveBackR.
    const atArm = profitLockDecision({ side: 'buy', entry: 100, initialStop: 99, peakPrice: 100 + PROFIT_LOCK_ARM_R, currentPrice: 100 });
    expect(atArm.armed).toBe(true);
    expect(atArm.peakR - atArm.giveBackR).toBeCloseTo(PROFIT_LOCK_ARM_R - PROFIT_LOCK_GIVEBACK_R, 9);
    // POSITIVE CONTROL — the pre-TRA-4006 schedule puts that same floor at 0.
    const oldAtArm = profitLockDecision({ side: 'buy', entry: 100, initialStop: 99, peakPrice: 101, currentPrice: 100, ...PRE_TRA4006 });
    expect(oldAtArm.armed).toBe(true);
    expect(oldAtArm.peakR - oldAtArm.giveBackR).toBeCloseTo(0, 9);
  });
});

describe('TRA-4006 AC3 — the live NVTS row is a regression case', () => {
  it('reconciles to the published tape: the row exited through this rule at +0.033R under the old schedule', () => {
    // pnl_r_stop_basis 0.033 on the export row; the old schedule releases at
    // `peakR − 1.0`, which for a 1.0331R peak is +0.0331R — i.e. 1.52. The
    // ticket's 1.822 is the LOWER BOUND on the peak (the exact algebraic
    // boundary of the old rule, where float rounding lands a hair on the hold
    // side), so the reconciliation uses a peak one tick above it; the real peak
    // was ≥ 1.822 and every value above it exits here.
    const d = profitLockDecision({ ...NVTS, peakPrice: 1.823, currentPrice: 1.52, ...PRE_TRA4006 });
    expect(d.R).toBeCloseTo(NVTS_R, 12);
    expect(d.peakR).toBeCloseTo(1.0364, 4);
    expect(d.currentR).toBeCloseTo(0.033, 3);
    expect(d.armed).toBe(true);
    expect(d.giveBackR).toBe(1.0);
    expect(d.shouldExit).toBe(true);
    // At the published lower bound itself the old rule is on the boundary.
    const bound = profitLockDecision({ ...NVTS, currentPrice: 1.52, ...PRE_TRA4006 });
    expect(bound.peakR).toBeCloseTo(1.0331, 4);
    expect(bound.peakR - bound.giveBackR).toBeCloseTo(bound.currentR, 9);
    // …and the old schedule was still HOLDING at 1.60 (+0.30R), i.e. it let the
    // row ride all the way down from ≥1.822 to 1.52 before releasing it.
    expect(profitLockDecision({ ...NVTS, peakPrice: 1.823, currentPrice: 1.60, ...PRE_TRA4006 }).shouldExit).toBe(false);
  });

  it('under the new schedule the row is released at +0.63R (≈1.70), not +0.03R (1.52)', () => {
    // Release level = entry + (peakR − 0.40) × R = 1.51 + 0.6331 × 0.302 = 1.7012.
    const releaseLevel = NVTS.entry + (1.0331 - PROFIT_LOCK_GIVEBACK_R) * NVTS_R;
    expect(releaseLevel).toBeCloseTo(1.7012, 3);

    // One cent ABOVE the level: still holding, with +0.66R on the row.
    const above = profitLockDecision({ ...NVTS, currentPrice: 1.71 });
    expect(above.armed).toBe(true);
    expect(above.giveBackR).toBe(PROFIT_LOCK_GIVEBACK_R);
    expect(above.currentR).toBeGreaterThan(above.peakR - above.giveBackR);
    expect(above.shouldExit).toBe(false);

    // At/below the level: released — and the release carries +0.63R, which is
    // the whole point of the ticket. Under the OLD schedule this same mark held.
    const at = profitLockDecision({ ...NVTS, currentPrice: 1.70 });
    expect(at.shouldExit).toBe(true);
    expect(at.currentR).toBeCloseTo(0.629, 3);
    expect(profitLockDecision({ ...NVTS, currentPrice: 1.70, ...PRE_TRA4006 }).shouldExit).toBe(false);
  });

  it('the literal AC3 input (currentPrice 1.52) is a mark the row can no longer reach while open', () => {
    // AC3 as written asks for `shouldExit: false` at currentPrice 1.52 under the
    // new constants. That is arithmetically unreachable for ANY give-back rule
    // whose allowance is below 1.0R: at 1.52 the row has retraced 1.0R from its
    // 1.0331R peak, which exceeds a 0.40R allowance just as it exceeded the old
    // 1.0R one. What the AC MEANS — and what the two cases above pin — is that
    // the rule releases the row at ~1.70 (+0.63R), so it never sees 1.52 open.
    // Pinned here so nobody "fixes" the constants until this reads `false`:
    // making it read `false` would require the allowance to be ≥ 1.0R again,
    // which is the defect.
    const d = profitLockDecision({ ...NVTS, currentPrice: 1.52 });
    expect(d.armed).toBe(true);
    expect(d.currentR).toBeCloseTo(0.033, 3);
    expect(d.peakR - d.giveBackR).toBeGreaterThan(d.currentR);
    expect(d.shouldExit).toBe(true);
  });
});

describe('TRA-4006 AC4 — no behaviour change below the arm, and the degenerate-R branch is untouched', () => {
  it('a row that never reached peakR ≥ 0.75 is disarmed and never exits here, however far it has fallen', () => {
    // R = 5; peak 103.7 → 0.74R (one tick under the arm). Current 97 → −0.6R:
    // deep under water, and STILL not this rule's call (the hard stop owns it).
    const d = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 103.7, currentPrice: 97 });
    expect(d.peakR).toBeCloseTo(0.74, 9);
    expect(d.armed).toBe(false);
    expect(d.shouldExit).toBe(false);
    // Short side mirrors.
    const s = profitLockDecision({ side: 'sell', entry: 100, initialStop: 105, peakPrice: 96.3, currentPrice: 103 });
    expect(s.armed).toBe(false);
    expect(s.shouldExit).toBe(false);
    // And one tick AT the arm is armed (boundary is ≥).
    const arm = profitLockDecision({ side: 'buy', entry: 100, initialStop: 95, peakPrice: 103.75, currentPrice: 103.75 });
    expect(arm.armed).toBe(true);
    expect(arm.shouldExit).toBe(false); // no give-back yet
  });

  it('degenerate R (`!(R > 0)`) stays disarmed with shouldExit false: zero, negative-free (abs), NaN, and a NaN stop', () => {
    const zero = profitLockDecision({ side: 'buy', entry: 100, initialStop: 100, peakPrice: 120, currentPrice: 90 });
    expect(zero).toEqual({ R: 0, peakR: 0, currentR: 0, armed: false, giveBackR: PROFIT_LOCK_GIVEBACK_R, shouldExit: false });

    const nanStop = profitLockDecision({ side: 'buy', entry: 1.51, initialStop: NaN, peakPrice: 1.822, currentPrice: 1.52 });
    expect(nanStop.R).toBe(0);
    expect(nanStop.armed).toBe(false);
    expect(nanStop.shouldExit).toBe(false);

    const nanEntry = profitLockDecision({ side: 'buy', entry: NaN, initialStop: 1.208, peakPrice: 1.822, currentPrice: 1.52 });
    expect(nanEntry.shouldExit).toBe(false);
  });
});
