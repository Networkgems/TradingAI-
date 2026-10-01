// TRA-4950 — `peakPremium` is not a maximum favourable excursion.
//
// THE INVARIANT. For a long single-leg option the realized exit can never exceed
// the true peak, so `realizedR <= peakR + eps` — equivalently, in the premium
// space this file grades in, `entryBasisPremium + realizedPnlUsd/(100·contracts)
// <= peakPremium + eps`.
//
// Measured on bqb1 `faae9388` 2026-10-01 (`GET /api/health/option-journal?rows=
// all`, 3542 rows): 101 of the 312 rows carrying all four operands VIOLATE it,
// every one on a winner, split
//   take_profit_early 8/8 · profit_lock 7/15 · book_halt_flat 85/201 ·
//   chandelier 1/17 · sl 0/59 · every other adverse-side exit 0/19.
// The side-asymmetry is the test's POWER, not a second defect: a stop books far
// below any peak and satisfies the inequality however badly the stamp
// under-records, so the adverse-side 0% must never be cited as a control.
//
// ── THE NEGATIVE CONTROL ────────────────────────────────────────────────────
//
// The engine-level cases in the first describe() FAIL against the pre-fix code:
// `peakPremium` was advanced on TICK paths only (`checkExits`' ratchet and
// `refreshImportedMarks`), while every CLOSE path resolved its own exit price —
// `closeOption` off `opt.currentPremium`, `resolvePendingExit`/`bookPartialFill`
// off the broker's avg fill — and booked P&L against it without offering that
// price to the ratchet. To re-arm the control, comment out the
// `ratchetPeakPremiumAtClose` call in `closeOption` and watch
// `closes the gap the book-halt flatten used to leave` go red with
// `peakPremium` still sitting on the mint seed.
//
// The grader cases use the REAL violating rows off that tape as literal
// fixtures, so the instrument is pinned against the measurement that opened the
// ticket rather than against a hand-built straw row.
//
// ⛔ Stamps are forward-only. Nothing in this ticket repairs the 3542 rows
// already on the tape; see `PEAK_MFE_TRUSTWORTHY_FROM_ISO`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount, ratchetPeakPremiumAtClose } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';
import {
  gradePeakMfe,
  notePeakMfeClose,
  getOptionPeakMfeHealth,
  resetPeakMfeAccrualForTests,
  PEAK_MFE_TRUSTWORTHY_FROM_ISO,
  type PeakMfeRowInput,
} from './option-peak-mfe.js';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z'); // Tue 10:00 ET (EDT)

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-4950',
    symbol: 'IONQ',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'IONQ261009C00039000',
    optionType: 'call',
    strike: 39,
    expiration: '2026-10-09',
    mark: 1.0,
    theo: 1.3,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

function openCall(): { acct: PaperOptionsAccount; id: string } {
  const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
  const pos = acct.openOptionFromCandidate(buildSignal(), 'demo', undefined, 200);
  expect(pos).not.toBeNull();
  return { acct, id: pos!.id };
}

describe('TRA-4950 — the peak is ratcheted by the CLOSE, not only by the tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ⛔ THE NEGATIVE CONTROL. Pre-fix this closes at 2.50 against a peak still on
  // the 1.00 mint seed — the `book_halt_flat` shape, 85/201 on the live tape.
  it('closes the gap the book-halt flatten used to leave', () => {
    const { acct, id } = openCall();
    const before = acct.getState().openOptions[0];
    expect(before.peakPremium).toBeCloseTo(before.premiumPaid, 10); // never ratcheted
    const closed = acct.closeOption(id, 2.5, 'book_halt_flat');
    expect(closed).not.toBeNull();
    expect(closed!.peakPremium).toBeGreaterThanOrEqual(2.5);
    // And the excursion is DATED: a close is a price the market served, so the
    // stamp is `observed` and `peakPremiumAt` is not null (TRA-4160's rule that
    // the stamp is a property of the ratchet, not of one call site).
    expect(closed!.peakPremiumStamp).toBe('observed');
    expect(closed!.peakPremiumAt).toBe(TRADING_TIME);
  });

  it('holds the invariant on the manual close path too (same choke point)', () => {
    const { acct, id } = openCall();
    const closed = acct.closeOption(id, 3.75);
    expect(closed!.exitReason).toBe('manual');
    expect(closed!.peakPremium).toBeGreaterThanOrEqual(3.75);
  });

  it('never LOWERS a peak the hold already earned', () => {
    const { acct, id } = openCall();
    acct.getState().openOptions[0].peakPremium = 4.0;
    const closed = acct.closeOption(id, 1.1, 'book_halt_flat');
    expect(closed!.peakPremium).toBe(4.0);
  });

  // AC5 — instrumentation only. The `book_halt_flat` → `profit_lock` relabel
  // (TRA-4335 defect 2) reproduces what the exit cascade would have decided, so
  // it must keep reading the peak that cascade would have read. The ratchet is
  // therefore placed AFTER it, and both of TRA-4335's pinned outcomes stand.
  it('leaves the TRA-4335 exit-reason relabel byte-identical', () => {
    const lockEligible = openCall();
    lockEligible.acct.getState().openOptions[0].peakPremium = 2.0;
    expect(lockEligible.acct.closeOption(lockEligible.id, 1.1, 'book_halt_flat')!.exitReason)
      .toBe('profit_lock');

    const haltAlone = openCall();
    expect(haltAlone.acct.closeOption(haltAlone.id, 0.95, 'book_halt_flat')!.exitReason)
      .toBe('book_halt_flat');
  });

  it('is a no-op on the prices that are not excursions', () => {
    const { acct } = openCall();
    const opt = acct.getState().openOptions[0];
    opt.peakPremium = 2.0;
    expect(ratchetPeakPremiumAtClose(opt, Number.NaN, 'observed', TRADING_TIME)).toBe(false);
    expect(ratchetPeakPremiumAtClose(opt, 0, 'observed', TRADING_TIME)).toBe(false);
    expect(ratchetPeakPremiumAtClose(opt, -1, 'observed', TRADING_TIME)).toBe(false);
    expect(ratchetPeakPremiumAtClose(opt, 1.5, 'observed', TRADING_TIME)).toBe(false);
    expect(opt.peakPremium).toBe(2.0);
    // A covered write is SHORT the premium: the favourable excursion runs DOWN,
    // so a buy-back debit must never be read as a new high-water mark.
    const short = acct.getState().openOptions[0];
    short.coveredWrite = 'covered_call';
    expect(ratchetPeakPremiumAtClose(short, 99, 'observed', TRADING_TIME)).toBe(false);
    expect(short.peakPremium).toBe(2.0);
  });

  it('labels a synthesised close price `bookkeeping`, never `observed`', () => {
    const { acct } = openCall();
    const opt = acct.getState().openOptions[0];
    expect(ratchetPeakPremiumAtClose(opt, 2.4, 'bookkeeping', TRADING_TIME)).toBe(true);
    expect(opt.peakPremium).toBe(2.4);
    // `peakPremiumAt` is CLEARED rather than moved: a stamp here would assert an
    // excursion at an instant nothing printed, which is the fabricated column
    // `extremeAdvancedThisSession` fails closed to avoid.
    expect(opt.peakPremiumAt).toBeUndefined();
    expect(opt.peakPremiumStamp).toBe('bookkeeping');
  });
});

// ── The grader, pinned on the rows that opened the ticket ────────────────────
//
// Every fixture below is a VERBATIM projection of a row served by
// `GET /api/health/option-journal?rows=all` on bqb1 `faae9388`, 2026-10-01.

/** `take_profit_early`, GME261002C00018000, demo/fixture book. 100% cohort. */
const TP_EARLY_GME: PeakMfeRowInput = {
  id: '87cf01ae-9ac5-4ef0-a482-37a08e88e4a6',
  optionSymbol: 'GME261002C00018000',
  structure: 'single_leg_otm',
  mode: 'demo',
  exitReason: 'take_profit_early',
  outcome: 'WIN',
  contracts: 2,
  entryBasisPremium: 1.12,
  peakPremium: 1.525,
  atRiskUsd: 224.00000000000003,
  realizedPnlUsd: 445.49999999999983,
  realizedR: 1.9888392857142847,
};

/** `take_profit_early`, EYPT261016C00005000 — the worst row on the tape (4.7x). */
const TP_EARLY_EYPT: PeakMfeRowInput = {
  id: '93f85616-0556-4347-b9ec-28a897c9ea6c',
  optionSymbol: 'EYPT261016C00005000',
  structure: 'single_leg_otm',
  mode: 'demo',
  exitReason: 'take_profit_early',
  outcome: 'WIN',
  contracts: 2,
  entryBasisPremium: 0.8980769230769231,
  peakPremium: 1.3,
  atRiskUsd: 175,
  realizedPnlUsd: 1045,
  realizedR: 5.9714285714285715,
};

/** `profit_lock`, SOUN261009C00007000. The 7/15 cohort. */
const PROFIT_LOCK_SOUN: PeakMfeRowInput = {
  id: '427dbafa-bc0e-48a3-942f-01664931929e',
  optionSymbol: 'SOUN261009C00007000',
  structure: 'single_leg_otm',
  mode: 'demo',
  exitReason: 'profit_lock',
  outcome: 'WIN',
  contracts: 2,
  entryBasisPremium: 0.52,
  peakPremium: 0.63,
  atRiskUsd: 104,
  realizedPnlUsd: 241.99999999999972,
  realizedR: 2.326923076923074,
};

/** `profit_lock`, NFLX261009C00082000 — a small, un-dramatic violation. */
const PROFIT_LOCK_NFLX: PeakMfeRowInput = {
  id: '2f9bca57-0e33-4b88-8d46-05cbc8714844',
  optionSymbol: 'NFLX261009C00082000',
  structure: 'single_leg_otm',
  mode: 'demo',
  exitReason: 'profit_lock',
  outcome: 'WIN',
  contracts: 1,
  entryBasisPremium: 3.3,
  peakPremium: 4.075,
  atRiskUsd: 330,
  realizedPnlUsd: 225.00000000000009,
  realizedR: 0.6818181818181821,
};

/**
 * `chandelier`, SIRI261016C00029000 — the only violator in the whole 30-row
 * NON-fixture (`accountClass: 'desk'`) cohort, and therefore the one that proves
 * the defect is the engine's and not an artefact of the QA books. Its close's own
 * `markProvenance` reads `delta_backstop` / `staleMarkTicks: 5`, and its
 * `observed` peak is stamped 17.9 min before the close.
 */
const CHANDELIER_SIRI_DESK: PeakMfeRowInput = {
  id: '1af1c58c-9024-4991-ab94-9afbcd8591db',
  optionSymbol: 'SIRI261016C00029000',
  structure: 'single_leg_directional',
  mode: 'demo',
  exitReason: 'chandelier',
  outcome: 'WIN',
  contracts: 1,
  entryBasisPremium: 1.2460867924708987,
  peakPremium: 1.431790566358455,
  peakPremiumStamp: 'observed',
  atRiskUsd: 123.49999999999999,
  realizedPnlUsd: 24.390943435977608,
  realizedR: 0.19749751770022356,
};

/** `sl`, TTD261002C00013500 (desk) — a sound row, and the `ok` control. */
const STOP_TTD_DESK: PeakMfeRowInput = {
  id: 'e179f39e-6cd5-41d6-9b90-263e7f9697d3',
  optionSymbol: 'TTD261002C00013500',
  structure: 'single_leg_otm',
  mode: 'demo',
  exitReason: 'sl',
  outcome: 'LOSS',
  contracts: 1,
  entryBasisPremium: 0.8700000000000001,
  peakPremium: 0.9376593139997597,
  atRiskUsd: 86.5,
  realizedPnlUsd: -53.40000000000001,
  realizedR: -0.6173410404624279,
};

describe('TRA-4950 — gradePeakMfe over the live tape rows', () => {
  it('flags both named `take_profit_early` fixtures', () => {
    for (const row of [TP_EARLY_GME, TP_EARLY_EYPT]) {
      const g = gradePeakMfe(row);
      expect(g.verdict).toBe('violated');
      expect(g.violated).toBe(true);
      expect(g.graded).toBe(true);
      expect(g.excessPremium).toBeGreaterThan(0);
      // The R-space form the ticket states the test in agrees with the premium
      // form on these rows, so the two readings cannot be played off each other.
      expect(g.excessR).toBeGreaterThan(0);
      expect(g.realizedR).toBeGreaterThan(g.peakR!);
    }
    // GME books 3.3475/share against a 1.525 peak.
    expect(gradePeakMfe(TP_EARLY_GME).impliedExitPremium).toBeCloseTo(3.3475, 6);
  });

  it('flags both named `profit_lock` fixtures', () => {
    for (const row of [PROFIT_LOCK_SOUN, PROFIT_LOCK_NFLX]) {
      expect(gradePeakMfe(row).verdict).toBe('violated');
    }
    // NFLX books 5.55/share against a 4.075 peak — a 1.475 excursion the stamp
    // never saw, on a row the give-back rule is calibrated against.
    expect(gradePeakMfe(PROFIT_LOCK_NFLX).impliedExitPremium).toBeCloseTo(5.55, 6);
  });

  it('flags the one violator in the non-fixture desk cohort', () => {
    const g = gradePeakMfe(CHANDELIER_SIRI_DESK);
    expect(g.verdict).toBe('violated');
    expect(g.excessPremium).toBeCloseTo(0.0582056604722198, 9);
    expect(g.excessR).toBeCloseTo(0.04713008945119019, 9);
  });

  it('passes a sound adverse-side row — and that pass is NOT a control', () => {
    const g = gradePeakMfe(STOP_TTD_DESK);
    expect(g.verdict).toBe('ok');
    expect(g.graded).toBe(true);
    expect(g.excessPremium).toBeLessThan(0);
  });

  it('names every absence instead of folding it as a zero excursion', () => {
    expect(gradePeakMfe({ ...TP_EARLY_GME, peakPremium: null }).verdict)
      .toBe('unmeasurable_no_peak');
    expect(gradePeakMfe({ ...TP_EARLY_GME, peakPremium: Number.NaN }).verdict)
      .toBe('unmeasurable_no_peak');
    expect(gradePeakMfe({ ...TP_EARLY_GME, entryBasisPremium: undefined }).verdict)
      .toBe('unmeasurable_no_basis');
    expect(gradePeakMfe({ ...TP_EARLY_GME, entryBasisPremium: 0 }).verdict)
      .toBe('unmeasurable_no_basis');
    expect(gradePeakMfe({ ...TP_EARLY_GME, realizedPnlUsd: undefined }).verdict)
      .toBe('unmeasurable_no_pnl');
    // Not one of them claims a comparison.
    for (const v of [
      gradePeakMfe({ ...TP_EARLY_GME, peakPremium: null }),
      gradePeakMfe({ ...TP_EARLY_GME, entryBasisPremium: 0 }),
      gradePeakMfe({ ...TP_EARLY_GME, realizedPnlUsd: undefined }),
    ]) {
      expect(v.graded).toBe(false);
      expect(v.violated).toBe(false);
      expect(v.excessPremium).toBeNull();
    }
  });

  it('refuses to grade a row whose size is ambiguous rather than accuse it', () => {
    // A TP1 trim banked dollars at one size; the close row's figure is
    // cumulative over both (TRA-2895), so no single implied exit exists.
    expect(gradePeakMfe({ ...TP_EARLY_GME, partials: [{ realizedPnlUsd: 10 }] }).verdict)
      .toBe('unmeasurable_size_ambiguous');
    // The TRA-4609 add shape: the close settled a size the entry column does not
    // describe.
    expect(gradePeakMfe({ ...TP_EARLY_GME, contractsAtClose: 4 }).verdict)
      .toBe('unmeasurable_size_ambiguous');
    // Same size stated twice is NOT ambiguous.
    expect(gradePeakMfe({ ...TP_EARLY_GME, contractsAtClose: 2 }).verdict).toBe('violated');
  });

  it('holds short and multi-leg rows outside the inequality\'s domain', () => {
    expect(gradePeakMfe({ ...TP_EARLY_GME, coveredWrite: 'covered_call' }).verdict)
      .toBe('not_applicable_not_long_single_leg');
    expect(gradePeakMfe({ ...TP_EARLY_GME, structure: 'vertical_spread' }).verdict)
      .toBe('not_applicable_not_long_single_leg');
    expect(gradePeakMfe({ ...TP_EARLY_GME, structure: null }).verdict)
      .toBe('not_applicable_not_long_single_leg');
  });

  it('tolerates float noise rather than calling it a violation', () => {
    // The live tape carries 1e-16 noise on both sides of a premium (ONDS
    // 0.695 -> 0.6950000000000001). An exit exactly AT the peak is `ok`.
    const atPeak: PeakMfeRowInput = {
      structure: 'single_leg_otm',
      contracts: 1,
      entryBasisPremium: 1.0,
      peakPremium: 2.0,
      atRiskUsd: 100,
      realizedPnlUsd: 100,
      realizedR: 1.0,
    };
    expect(gradePeakMfe(atPeak).verdict).toBe('ok');
    expect(gradePeakMfe({ ...atPeak, peakPremium: 2.0 - 1e-15 }).verdict).toBe('ok');
    // A cent over is not noise.
    expect(gradePeakMfe({ ...atPeak, peakPremium: 1.99 }).verdict).toBe('violated');
  });
});

describe('TRA-4950 — the health field reports the last REAL close', () => {
  beforeEach(() => {
    resetPeakMfeAccrualForTests(TRADING_TIME);
  });

  it('reads `never_attempted_this_boot` with a NULL rate before anything closes', () => {
    const h = getOptionPeakMfeHealth();
    // ⚠️ This is an ALARM, not a pass. The whole point of the CLAUDE.md rule.
    expect(h.state).toBe('never_attempted_this_boot');
    expect(h.lastAttempt).toBeNull();
    expect(h.sinceBoot.closesSeen).toBe(0);
    expect(h.sinceBoot.graded).toBe(0);
    // A rate over an empty denominator is NOT zero.
    expect(h.sinceBoot.violationRate).toBeNull();
    expect(h.worstViolation).toBeNull();
    expect(h.trustworthyFromIso).toBe(PEAK_MFE_TRUSTWORTHY_FROM_ISO);
  });

  it('publishes the outcome of the last close with its own timestamp', () => {
    notePeakMfeClose(STOP_TTD_DESK, TRADING_TIME + 1_000);
    notePeakMfeClose(TP_EARLY_GME, TRADING_TIME + 2_000);
    const h = getOptionPeakMfeHealth();
    expect(h.state).toBe('measured');
    expect(h.lastAttempt?.id).toBe(TP_EARLY_GME.id);
    expect(h.lastAttempt?.verdict).toBe('violated');
    expect(h.lastAttempt?.exitReason).toBe('take_profit_early');
    expect(h.lastAttempt?.at).toBe(TRADING_TIME + 2_000);
    expect(h.lastAttempt?.atIso).toBe(new Date(TRADING_TIME + 2_000).toISOString());
    expect(h.sinceBoot.graded).toBe(2);
    expect(h.sinceBoot.ok).toBe(1);
    expect(h.sinceBoot.violated).toBe(1);
    expect(h.sinceBoot.violationRate).toBe(0.5);
    expect(h.sinceBoot.firstGradedAt).toBe(TRADING_TIME + 1_000);
    expect(h.sinceBoot.lastGradedAt).toBe(TRADING_TIME + 2_000);
  });

  it('keeps an unmeasurable close out of the rate AND out of `ok`', () => {
    notePeakMfeClose({ ...STOP_TTD_DESK, peakPremium: null }, TRADING_TIME + 1_000);
    notePeakMfeClose({ ...TP_EARLY_GME, structure: 'iron_condor' }, TRADING_TIME + 2_000);
    const h = getOptionPeakMfeHealth();
    // Two closes SEEN, nothing graded ⇒ the rate stays null, not 0.
    expect(h.state).toBe('measured');
    expect(h.sinceBoot.closesSeen).toBe(2);
    expect(h.sinceBoot.graded).toBe(0);
    expect(h.sinceBoot.ok).toBe(0);
    expect(h.sinceBoot.violationRate).toBeNull();
    expect(h.sinceBoot.unmeasurable).toBe(1);
    expect(h.sinceBoot.notApplicable).toBe(1);
    expect(h.sinceBoot.byVerdict.unmeasurable_no_peak).toBe(1);
    expect(h.sinceBoot.lastGradedAt).toBeNull();
  });

  it('keeps the WORST violation, not merely the most recent one', () => {
    notePeakMfeClose(TP_EARLY_EYPT, TRADING_TIME + 1_000); // excess ~4.82/share
    notePeakMfeClose(CHANDELIER_SIRI_DESK, TRADING_TIME + 2_000); // excess ~0.058/share
    const h = getOptionPeakMfeHealth();
    expect(h.lastAttempt?.id).toBe(CHANDELIER_SIRI_DESK.id);
    expect(h.worstViolation?.id).toBe(TP_EARLY_EYPT.id);
    expect(h.sinceBoot.violationRate).toBe(1);
  });
});
