import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import { DailyRiskGovernor } from './signal-engine.js';
import {
  BOOK_GIVEBACK_ARM_ABS_FLOOR_USD,
  BOOK_GIVEBACK_ARM_FLOOR_R,
  BOOK_GIVEBACK_CAP_PCT,
  BOOK_SESSION_STOP_ARM_ABS_FLOOR_USD,
  BOOK_SESSION_STOP_R,
  DEFAULT_RISK_PER_TRADE,
} from '@trading-app/shared';
import { DEFAULT_MARKETABLE_HALF_SPREAD_FRAC } from './marketable-open-mtm.js';
import type { OtmMispricingSignal } from '@trading-app/shared';
import type { BookHaltReason } from '@trading-app/engine';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3469 (parent TRA-2710 → TRA-2131) — positive/negative CONTROLS joining the
// marketable(bid) give-back BASIS to the book give-back cap's ARM DECISION.
//
// TRA-2233 shipped the basis switch dark and proved the P&L *number* changes
// under the flag (`options-account-marketable.test.ts`). Nothing proved the
// CAP'S DECISION changes — which is the claim TRA-2131 was authorized on and
// the evidence the board asked for at the arming gate. These are that evidence.
//
// TESTS ONLY. No production file is touched; `ENABLE_MARKETABLE_OPEN_MTM` stays
// unset (the fixtures arm the basis via the account's own constructor config,
// which is the same switch the env flag resolves into — never the env itself).
//
// ── The failure being reproduced (TRA-2129) ──────────────────────────────────
// The paper book marks OPEN options at the chain MID. A long exits at the BID.
// On a session whose peak is OPTION-MTM-DOMINATED, the give-back high-water mark
// is therefore inflated by ~the half-spread — a gain the book was never going to
// capture. The book then "gives back" that phantom gain and latches a
// session-ending halt for surrendering money it never had.
//
// ── What is NOT hand-rolled (AC3) ────────────────────────────────────────────
// Every tick below runs the REAL objects:
//   • the real basis switch — `PaperOptionsAccount.basisUnrealizedPnlForMode`,
//     reached through the shipped public read `getStateForMode(mode).dailyOptionsPnl`
//     (`options-account.ts:2556` / `:2608`), the exact field `computeBookMark`
//     consumes (`signal-engine.ts:10392`);
//   • the real peak update + the real decision —
//     `DailyRiskGovernor.markBook` (`signal-engine.ts:2144`), whose
//     `peakOpenGain = Math.max(peak, realizedPlusOpen, 0)` and pure
//     `bookGiveBackDecision` (`exit-rules.ts:279`) are called unmodified.
// Neither is re-implemented here. The only thing this file computes is the
// caller-side `giveBackArmFloor` input, mirroring `signal-engine.ts:5360-5365`
// verbatim from the shared constants.
//
// ── Guard rails honoured (from the ticket) ───────────────────────────────────
//   • Arming formula: the SHIPPED plain sum (`realizedDelta + basisUnrealized`),
//     NOT TRA-2710's `max(realized, realized + marketableOpen)` card text —
//     QuantTrader ratified the plain sum on TRA-2131 (2026-08-06).
//   • DEMO-only: the basis switch is `mode === 'demo'` by construction; the
//     fixtures run the demo path.
//   • Arm floor is TRA-3218's `max(1R of book equity, +$100)`, NOT the $25 the
//     TRA-2129 narrative cites — a fixture sized against $25 would false-PASS by
//     never arming at all.
// ─────────────────────────────────────────────────────────────────────────────

// Tuesday 10:00 ET — inside an ET trading window so the open predicate passes.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

/**
 * Book equity the session-stop / give-back ARMS are sized against. $10,000 →
 * 1R = DEFAULT_RISK_PER_TRADE (1%) = $100, so BOTH arms land on a round $100:
 *   give-back arm floor  = max($100, 1.0R × $100) = $100   (TRA-1435 / TRA-3218)
 *   session-stop arm     = max(1.0R × $100, $100) = $100   (TRA-3218)
 * This is the EQUITY book's managed equity (`account.managedEquity()`), which is
 * independent of the options sleeve's paper equity below — exactly as in
 * `computeBookMark`, which sources the two from different accounts.
 */
const BOOK_EQUITY = 10_000;

/** Mirrors `signal-engine.ts:5360-5365` — the caller-side arm-floor input. */
const ARM_FLOOR_ON = Math.max(
  BOOK_GIVEBACK_ARM_ABS_FLOOR_USD,
  BOOK_GIVEBACK_ARM_FLOOR_R * Math.max(0, BOOK_EQUITY) * DEFAULT_RISK_PER_TRADE,
);
/** `BOOK_GIVEBACK_ARM_FLOOR_ENABLED` OFF ⇒ the caller passes 0 (legacy: arm at any peak). */
const ARM_FLOOR_OFF = 0;

/** The session-stop arm `markBook` derives internally, restated for the assertions. */
const SESSION_STOP_ARM = Math.max(
  BOOK_SESSION_STOP_R * BOOK_EQUITY * DEFAULT_RISK_PER_TRADE,
  BOOK_SESSION_STOP_ARM_ABS_FLOOR_USD,
);

/**
 * Options sleeve equity. $160,000 × managedAccountRatio 0.5 × OTM budgetRatio
 * 0.025 = a $2,000 per-ticket budget ⇒ exactly 20 contracts at a $1.00 mark
 * ($100/contract). 20 contracts = 2,000 shares is the leverage that lets an
 * option-MTM-dominated session clear the $100 arm on the MID while its
 * realizable value is still at-or-below scratch — the TRA-2129 shape. Risk
 * params are left at the shipped OTM defaults (SL 0.80, TP1 1.50, trail
 * activate 1.30); every mark tape below stays strictly inside that band so no
 * exit ever fires and the ONLY thing that differs between the two arms of each
 * control is the BASIS.
 */
const SLEEVE_EQUITY = 160_000;
const EXPECTED_CONTRACTS = 20;
const SHARES = EXPECTED_CONTRACTS * 100;
const PREMIUM_PAID = 1.0;

function buildSignal(): OtmMispricingSignal {
  return {
    id: 'tra3469-sig',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: PREMIUM_PAID,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    mark: PREMIUM_PAID,
    theo: 1.3,
    mispricingPct: -0.23,
    delta: 0.18,
  };
}

interface SessionOutcome {
  /** The basis figure fed to `markBook` on each tick (= `dailyOptionsPnl`). */
  basisTape: number[];
  /** The governor's own `peakOpenGain` after the tape. */
  peakOpenGain: number;
  /** The last tick's book P&L on this basis. */
  finalPnl: number;
  halted: boolean;
  reasonCode: BookHaltReason | null;
  retainedFloor: number;
  /** TRA-1892 snapshot bit: did the peak clear the give-back arm floor? */
  armFloorCleared: boolean;
}

/**
 * Replay one demo session on ONE basis and return what the book give-back
 * governor decided.
 *
 * Opens a single demo OTM long, then walks `markTape` through the real
 * `checkExits` mark path. After each tick it reads the REAL basis
 * (`getStateForMode('demo').dailyOptionsPnl`) and feeds it to the REAL
 * `markBook`, composing the book mark exactly as `computeBookMark` does
 * (`realizedEquity + openEquity + optionsDaily`) — with both equity legs at 0,
 * which is what "the peak is option-MTM-dominated" means.
 *
 * Asserts the position stays open and marked at each step, so a stray TP1 /
 * SL / trailing fire can never silently change the shape of a fixture.
 */
function runSession(opts: {
  enabled: boolean;
  halfSpreadFrac: number;
  markTape: readonly number[];
  giveBackArmFloor: number;
}): SessionOutcome {
  const acct = new PaperOptionsAccount({
    initialEquity: SLEEVE_EQUITY,
    managedAccountRatio: 0.5,
    marketableOpenMtm: { enabled: opts.enabled, halfSpreadFrac: opts.halfSpreadFrac },
  });
  const pos = acct.openOptionFromCandidate(buildSignal(), 'demo', undefined, 200);
  expect(pos).not.toBeNull();
  expect(pos!.contracts).toBe(EXPECTED_CONTRACTS);
  expect(pos!.premiumPaid).toBeCloseTo(PREMIUM_PAID, 10);

  const gov = new DailyRiskGovernor(() => new Date(TRADING_TIME));

  const basisTape: number[] = [];
  let last = { retainedFloor: 0, armFloorCleared: false };
  for (const mark of opts.markTape) {
    acct.checkExits(new Map(), new Map([[pos!.optionSymbol!, mark]]), 'demo');
    // No exit may fire — the fixture's whole meaning depends on the book staying
    // open across the tape (an exit would book realized P&L at a fill price the
    // FLAG itself selects, confounding the basis comparison).
    const open = acct.getStateForMode('demo').openOptions;
    expect(open).toHaveLength(1);
    expect(open[0].currentPremium).toBeCloseTo(mark, 10);
    expect(acct.getStateForMode('demo').dailyRealizedOptionsPnl).toBe(0);

    // The real basis switch. Nothing is recomputed here.
    const optionsDaily = acct.getStateForMode('demo').dailyOptionsPnl ?? 0;
    basisTape.push(optionsDaily);

    // The real peak update + the real decision.
    const { snapshot } = gov.markBook(optionsDaily, BOOK_EQUITY, opts.giveBackArmFloor);
    last = { retainedFloor: snapshot.retainedFloor, armFloorCleared: snapshot.armFloorCleared };
  }

  const state = gov.getBookHaltState();
  return {
    basisTape,
    peakOpenGain: state.peakOpenGain,
    finalPnl: basisTape[basisTape.length - 1],
    halted: state.halted,
    reasonCode: state.reasonCode,
    retainedFloor: last.retainedFloor,
    armFloorCleared: last.armFloorCleared,
  };
}

/** MID (legacy) arm of a control — the basis flag OFF. */
function runMid(markTape: readonly number[], giveBackArmFloor: number, halfSpreadFrac: number): SessionOutcome {
  return runSession({ enabled: false, halfSpreadFrac, markTape, giveBackArmFloor });
}

/** MARKETABLE (new) arm of a control — the basis flag ON. */
function runMarketable(markTape: readonly number[], giveBackArmFloor: number, halfSpreadFrac: number): SessionOutcome {
  return runSession({ enabled: true, halfSpreadFrac, markTape, giveBackArmFloor });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — POSITIVE CONTROL: the mid basis ARMS, the marketable basis does NOT.
// ─────────────────────────────────────────────────────────────────────────────
//
// The tape (20 contracts, $1.00 paid, shipped h = 0.134):
//
//   mark 1.15 →  MID open MTM  (1.15 − 1.00) × 2,000            = +$300.00
//                BID open MTM  (1.15·0.866 − 1.00) × 2,000      =    −$8.20
//   mark 1.02 →  MID open MTM  (1.02 − 1.00) × 2,000            =  +$40.00
//                BID open MTM  (1.02·0.866 − 1.00) × 2,000      =  −$233.36
//
// On the MID the book was up +$300 (clears the $100 arm) and surrendered 87% of
// it → the give-back cap latches a session halt. On the BID the book was NEVER
// UP AT ALL: its realizable high-water mark is −$8.20, so `peakOpenGain` floors
// at 0 and NEITHER leg of `bookGiveBackDecision` can arm — `peak > 0` fails for
// the give-back cap and `peak >= sessionStopArmGain` fails for the session stop.
//
// That last point is why this shape and not a milder one: the divergence here
// holds with the give-back arm floor ON *and* OFF, so it does not smuggle in
// TRA-1435's `BOOK_GIVEBACK_ARM_FLOOR_ENABLED` sub-flag as a hidden premise.
describe('TRA-3469 AC1 — positive control: a mid-inflated peak arms the cap; the realizable peak does not', () => {
  const TAPE = [1.15, 1.02] as const;
  const H = DEFAULT_MARKETABLE_HALF_SPREAD_FRAC; // 0.134 — the shipped model

  it('OLD (mid) basis ARMS the give-back cap on a peak that was never realizable', () => {
    const mid = runMid(TAPE, ARM_FLOOR_ON, H);

    expect(mid.basisTape[0]).toBeCloseTo(300, 6);
    expect(mid.peakOpenGain).toBeCloseTo(300, 6);
    // Peak clears the $100 arm floor, so the cap is live.
    expect(ARM_FLOOR_ON).toBe(100);
    expect(mid.armFloorCleared).toBe(true);
    // Floor = peak × (1 − 40%) = $180; the book is at +$40.
    expect(mid.retainedFloor).toBeCloseTo(300 * (1 - BOOK_GIVEBACK_CAP_PCT), 6);
    expect(mid.finalPnl).toBeCloseTo(40, 6);

    expect(mid.halted).toBe(true);
    expect(mid.reasonCode).toBe('giveback_cap');
  });

  it('NEW (marketable) basis does NOT arm — the realizable high-water mark never went positive', () => {
    const mkt = runMarketable(TAPE, ARM_FLOOR_ON, H);

    // The "+$300 peak" is worth LESS THAN SCRATCH at the bid.
    expect(mkt.basisTape[0]).toBeCloseTo((1.15 * (1 - H) - PREMIUM_PAID) * SHARES, 6);
    expect(mkt.basisTape[0]).toBeLessThan(0);
    // …so the governor's monotonic peak floors at 0 and nothing can arm.
    expect(mkt.peakOpenGain).toBe(0);
    expect(mkt.armFloorCleared).toBe(false);
    expect(mkt.finalPnl).toBeCloseTo((1.02 * (1 - H) - PREMIUM_PAID) * SHARES, 6);

    expect(mkt.halted).toBe(false);
    expect(mkt.reasonCode).toBeNull();
  });

  it('the two bases DIVERGE — a fixture where they agree is not evidence', () => {
    const mid = runMid(TAPE, ARM_FLOOR_ON, H);
    const mkt = runMarketable(TAPE, ARM_FLOOR_ON, H);
    expect(mid.halted).toBe(true);
    expect(mkt.halted).toBe(false);
    expect(mid.halted).not.toBe(mkt.halted);
    // And the divergence is in the PEAK, which is what TRA-2131 set out to deflate.
    expect(mid.peakOpenGain).toBeGreaterThan(mkt.peakOpenGain);
  });

  it('holds with the TRA-1435 arm floor DISABLED too (the divergence is not a sub-flag artefact)', () => {
    // With `BOOK_GIVEBACK_ARM_FLOOR_ENABLED` off the caller passes 0, so the mid
    // basis arms at ANY positive peak — and still halts. The marketable basis
    // has no positive peak to arm on, so it still does not.
    const mid = runMid(TAPE, ARM_FLOOR_OFF, H);
    const mkt = runMarketable(TAPE, ARM_FLOOR_OFF, H);

    expect(mid.halted).toBe(true);
    expect(mid.reasonCode).toBe('giveback_cap');
    expect(mkt.halted).toBe(false);
    expect(mkt.peakOpenGain).toBe(0);
  });

  it('neither basis reaches the SESSION-STOP leg here (the divergence is the give-back cap)', () => {
    const mid = runMid(TAPE, ARM_FLOOR_ON, H);
    const mkt = runMarketable(TAPE, ARM_FLOOR_ON, H);
    // Mid: peak clears the $100 session-stop arm but the book never goes
    // net-negative (+$40), so the give-back branch is the one that fires.
    expect(mid.peakOpenGain).toBeGreaterThanOrEqual(SESSION_STOP_ARM);
    expect(mid.finalPnl).toBeGreaterThan(0);
    expect(mid.reasonCode).toBe('giveback_cap');
    // Marketable: the book IS net-negative (−$233) but the peak never armed the
    // session stop either, so it correctly stays silent rather than halting on
    // a drawdown from a gain that never existed.
    expect(mkt.finalPnl).toBeLessThan(0);
    expect(mkt.peakOpenGain).toBeLessThan(SESSION_STOP_ARM);
    expect(mkt.reasonCode).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — NEGATIVE CONTROL: when the peak IS genuinely realizable, the new basis
// STILL arms. This is TRA-2131 item 3, the board's headline ask: do not weaken
// the cap on realizable gains.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3469 AC2 — negative control: a genuinely realizable peak still arms the cap', () => {
  // (a) LIQUID book — a 2% modeled half-spread. The bid mark barely differs from
  //     the mid, so the peak is realizable almost in full, and a real give-back
  //     must still latch.
  //
  //     mark 1.28 → MID +$560.00 | BID (1.28·0.98 − 1) × 2,000 = +$508.80
  //     mark 1.10 → MID +$200.00 | BID (1.10·0.98 − 1) × 2,000 = +$156.00
  describe('(a) liquid book — h = 0.02, the peak is realizable almost in full', () => {
    const TAPE = [1.28, 1.10] as const;
    const H = 0.02;

    it('the NEW basis still arms and still halts on a real give-back', () => {
      const mkt = runMarketable(TAPE, ARM_FLOOR_ON, H);

      expect(mkt.peakOpenGain).toBeCloseTo((1.28 * (1 - H) - PREMIUM_PAID) * SHARES, 6);
      // Genuinely realizable: +$508.80 at the bid, far above the $100 arm.
      expect(mkt.peakOpenGain).toBeGreaterThan(ARM_FLOOR_ON);
      expect(mkt.armFloorCleared).toBe(true);
      expect(mkt.finalPnl).toBeCloseTo((1.10 * (1 - H) - PREMIUM_PAID) * SHARES, 6);
      expect(mkt.finalPnl).toBeLessThan(mkt.retainedFloor);

      expect(mkt.halted).toBe(true);
      expect(mkt.reasonCode).toBe('giveback_cap');
    });

    it('the OLD basis agrees — the cap is not weakened, both worlds halt', () => {
      const mid = runMid(TAPE, ARM_FLOOR_ON, H);
      const mkt = runMarketable(TAPE, ARM_FLOOR_ON, H);
      expect(mid.halted).toBe(true);
      expect(mid.reasonCode).toBe('giveback_cap');
      expect(mkt.halted).toBe(true);
      expect(mkt.reasonCode).toBe('giveback_cap');
    });
  });

  // (b) The SHIPPED half-spread (0.134) — so the control cannot be dismissed as
  //     "you only got agreement by shrinking h". The peak is still genuinely
  //     realizable (+$216.96 at the bid, > the $100 arm) and the cap still fires.
  //
  //     mark 1.28 → MID +$560.00 | BID (1.28·0.866 − 1) × 2,000 = +$216.96
  //     mark 1.16 → MID +$320.00 | BID (1.16·0.866 − 1) × 2,000 =   +$9.12
  //                 mid floor $336.00           bid floor $130.176
  describe('(b) shipped h = 0.134 — a smaller but still genuinely realizable peak', () => {
    const TAPE = [1.28, 1.16] as const;
    const H = DEFAULT_MARKETABLE_HALF_SPREAD_FRAC;

    it('the NEW basis still arms the give-back cap on the realizable peak', () => {
      const mkt = runMarketable(TAPE, ARM_FLOOR_ON, H);

      expect(mkt.peakOpenGain).toBeCloseTo((1.28 * (1 - H) - PREMIUM_PAID) * SHARES, 6);
      expect(mkt.peakOpenGain).toBeGreaterThan(ARM_FLOOR_ON);
      expect(mkt.armFloorCleared).toBe(true);
      // Still net-POSITIVE at the end, so this is the give-back branch and not
      // the session stop borrowing the credit for the halt.
      expect(mkt.finalPnl).toBeGreaterThan(0);
      expect(mkt.finalPnl).toBeLessThan(mkt.retainedFloor);

      expect(mkt.halted).toBe(true);
      expect(mkt.reasonCode).toBe('giveback_cap');
    });

    it('the OLD basis agrees — both bases halt on a real give-back', () => {
      const mid = runMid(TAPE, ARM_FLOOR_ON, H);
      expect(mid.halted).toBe(true);
      expect(mid.reasonCode).toBe('giveback_cap');
    });
  });

  // (c) The SESSION-STOP leg is not weakened either: a realizable peak that
  //     flips the book net-negative still latches, on the new basis, at the
  //     shipped half-spread.
  //
  //     mark 1.28 → BID +$216.96 (clears the $100 session-stop arm)
  //     mark 1.10 → BID  −$94.80 (net-negative) → session_net_negative
  describe('(c) session-stop leg — a realizable peak that flips net-negative still latches', () => {
    const TAPE = [1.28, 1.10] as const;
    const H = DEFAULT_MARKETABLE_HALF_SPREAD_FRAC;

    it('the NEW basis latches the session stop', () => {
      const mkt = runMarketable(TAPE, ARM_FLOOR_ON, H);
      expect(mkt.peakOpenGain).toBeGreaterThanOrEqual(SESSION_STOP_ARM);
      expect(mkt.finalPnl).toBeLessThan(0);
      expect(mkt.halted).toBe(true);
      expect(mkt.reasonCode).toBe('session_net_negative');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anti-vacuity: the harness itself must be able to FAIL. If the basis read or
// the governor wiring silently no-op'd, every assertion above would still pass
// by never halting anything. These pin the harness.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3469 — harness anti-vacuity', () => {
  it('the two bases produce genuinely different basis tapes on the same mark tape', () => {
    const TAPE = [1.15, 1.02] as const;
    const H = DEFAULT_MARKETABLE_HALF_SPREAD_FRAC;
    const mid = runMid(TAPE, ARM_FLOOR_ON, H);
    const mkt = runMarketable(TAPE, ARM_FLOOR_ON, H);
    expect(mid.basisTape).toHaveLength(2);
    expect(mkt.basisTape).toHaveLength(2);
    for (let i = 0; i < mid.basisTape.length; i++) {
      // The marketable basis is strictly the more conservative valuation.
      expect(mkt.basisTape[i]).toBeLessThan(mid.basisTape[i]);
    }
  });

  it('a zero modeled half-spread collapses the new basis onto the old (both halt identically)', () => {
    // h = 0 ⇒ marketable mark == mid mark, so the two arms MUST agree. If they
    // ever diverge here, the fixture is measuring something other than the basis.
    const TAPE = [1.15, 1.02] as const;
    const mid = runMid(TAPE, ARM_FLOOR_ON, 0);
    const mkt = runMarketable(TAPE, ARM_FLOOR_ON, 0);
    expect(mkt.basisTape).toEqual(mid.basisTape);
    expect(mkt.peakOpenGain).toBeCloseTo(mid.peakOpenGain, 10);
    expect(mkt.halted).toBe(mid.halted);
    expect(mkt.reasonCode).toBe(mid.reasonCode);
    expect(mid.halted).toBe(true); // …and it is a HALTING tape, not a quiet one.
  });
});
