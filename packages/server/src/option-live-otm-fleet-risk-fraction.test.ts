// TRA-3674 — the CONTROLS on the capital-proportional aggregate budget.
//
// `option-exec-flag.test.ts` pins the resolver's fail-safe table and the
// arithmetic. This file exists for the two things a fail-safe table CANNOT
// catch, both of which are how this change would ship broken and green:
//
//   1. VACUITY — a suite that passes against a HARD-CODED φ. Every assertion in
//      an arithmetic table still passes if the call site ignores env entirely
//      and compiles 0.4858 in; the table only ever exercises the resolver, and
//      the resolver is not the thing at risk. So the discriminator here MOVES φ
//      and asserts the ADMIT DECISION moves with it. A φ that is read and a φ
//      that is hard-coded are byte-identical at every fixed value.
//
//   2. "BLOCKS EVERYTHING" PASSING AS SUCCESS. A budget that mis-resolves to 0
//      blocks every entry, and a test that only asserts blocks is satisfied by
//      it. Every scenario below therefore carries BOTH verdicts on BOTH live
//      books — an admit and a block each — so an inert bound cannot be green.
//
// The two balances are the real ones, verified 2026-08-14T01:0xZ off
// `GET /api/health/options-live` → `liveArmCensus.books[]`: `admin` (***0154)
// $1,143.96 and `v0nni` (***9652) $400.00, both `liveEntryGateOpen`.
import { describe, it, expect } from 'vitest';
import {
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION,
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR,
  resolveLiveOptionTestFleetRiskFraction,
  resolveLiveOptionTestAggregateCapUsd,
  resolveLiveOptionTestBookAggregateCapUsd,
  fitsLiveOptionTestAggregateCap,
} from './option-exec-flag.js';

/** The two production books that hold `liveEntryGateOpen` today. */
const ADMIN_CASH = 1143.96;
const V0NNI_CASH = 400.00;

/**
 * The order site's aggregate decision, reassembled from the same three calls in
 * the same order: resolve the fleet cap, resolve φ, derive this book's budget,
 * then test the entry against the already-open premium at risk.
 *
 * `env` is threaded rather than mutated onto `process.env`, so nothing here can
 * leak into a sibling file — and, more to the point, so the φ a decision was
 * made under is an INPUT to the assertion instead of ambient state.
 */
function admits(
  env: NodeJS.ProcessEnv,
  availableCashUsd: number | null,
  openAtRiskUsd: number,
  entryUsd: number,
): boolean {
  const fleetCapUsd = resolveLiveOptionTestAggregateCapUsd(env);
  const phi = resolveLiveOptionTestFleetRiskFraction(env);
  const budget = resolveLiveOptionTestBookAggregateCapUsd(availableCashUsd, 0, fleetCapUsd, phi, null);
  return fitsLiveOptionTestAggregateCap(openAtRiskUsd, entryUsd, budget);
}

function budgetOf(env: NodeJS.ProcessEnv, availableCashUsd: number | null): number {
  return resolveLiveOptionTestBookAggregateCapUsd(
    availableCashUsd,
    // TRA-3897 — 0, i.e. a FLAT book, which pins the capital basis to cash and
    // keeps every TRA-3674 claim in this file EXACTLY as it was measured. The
    // basis change is graded on a physically coherent book (cash goes DOWN by
    // what at-risk goes UP) in `option-live-otm-sizing-basis-tra3897.test.ts` —
    // NOT here, by re-basing an existing control's expected numbers.
    0,
    resolveLiveOptionTestAggregateCapUsd(env),
    resolveLiveOptionTestFleetRiskFraction(env),
    null, // TRA-3879 — PER BOOK only: no fleet basis
  );
}

// ─── POSITIVE CONTROL ─────────────────────────────────────────────────────────
// Both books, one test. "Blocks everything" cannot pass as success here: each
// book must ADMIT one entry and BLOCK another, and the two books must land on
// DIFFERENT budgets — which is the property the old flat cap could not express
// and the health route could not display.
describe('TRA-3674 positive control — both live books, admits AND blocks', () => {
  const env: NodeJS.ProcessEnv = {}; // φ and A both at their compiled defaults

  it('admin ($1,143.96): a $350 entry admits, a second ($700 cumulative) blocks', () => {
    expect(budgetOf(env, ADMIN_CASH)).toBe(555.73);
    // First entry at the per-entry cap (LIVE_OPTION_TEST_NOTIONAL_CAP_USD=350).
    expect(admits(env, ADMIN_CASH, 0, 350)).toBe(true);
    // Second: $350 already at risk + $350 = $700 > $555.73.
    expect(admits(env, ADMIN_CASH, 350, 350)).toBe(false);
    // And the budget is genuinely reachable in between — not a bound that only
    // ever admits the first entry by accident.
    expect(admits(env, ADMIN_CASH, 350, 205.73)).toBe(true);
    expect(admits(env, ADMIN_CASH, 350, 205.74)).toBe(false);
  });

  it('v0nni ($400.00): a $270 entry blocks, a $150 entry admits', () => {
    expect(budgetOf(env, V0NNI_CASH)).toBe(194.32);
    expect(admits(env, V0NNI_CASH, 0, 270)).toBe(false);
    expect(admits(env, V0NNI_CASH, 0, 150)).toBe(true);
    // Boundary is inclusive and cent-exact, same rule as the flat cap.
    expect(admits(env, V0NNI_CASH, 0, 194.32)).toBe(true);
    expect(admits(env, V0NNI_CASH, 0, 194.33)).toBe(false);
  });

  it('the two books get DISTINCT budgets — the read the health route is graded on', () => {
    expect(budgetOf(env, ADMIN_CASH)).not.toBe(budgetOf(env, V0NNI_CASH));
    // Under the bound this replaces, both books read the SAME number and the
    // route could not tell them apart. That is the defect, pinned.
    const flat = resolveLiveOptionTestAggregateCapUsd(env);
    expect(Math.min(flat, ADMIN_CASH)).toBe(750);
    expect(Math.min(flat, V0NNI_CASH)).toBe(400);
  });

  it('THE $350 ENTRY THAT WAS ADMITTED FOR v0nni UNDER THE FLAT CAP IS NOW BLOCKED', () => {
    // The concrete regression this ticket removes. Same entry, same book.
    const flatBudget = resolveLiveOptionTestAggregateCapUsd(env); // 750
    expect(fitsLiveOptionTestAggregateCap(0, 350, flatBudget)).toBe(true);   // before
    expect(admits(env, V0NNI_CASH, 0, 350)).toBe(false);                     // after
  });

  it('TIGHTENING ONLY — no book\'s budget RISES against the flat bound', () => {
    const flat = resolveLiveOptionTestAggregateCapUsd(env);
    for (const cash of [0, 50, V0NNI_CASH, 750, ADMIN_CASH, 1543.96, 10_000]) {
      expect(budgetOf(env, cash)).toBeLessThanOrEqual(Math.min(flat, cash));
    }
  });
});

// ─── VACUITY CONTROL ──────────────────────────────────────────────────────────
// The failure mode this ticket names explicitly: "a passing suite against a
// hard-coded φ". Mutate the constant; the admit decision must MOVE. If any
// assertion below can be satisfied without reading env, the guard is inert.
describe('TRA-3674 vacuity control — φ is READ, not compiled in', () => {
  it('a TIGHTER φ flips an admit to a block on the SAME book and entry', () => {
    const entry = 350;
    // Default φ: admin's $555.73 budget admits it.
    expect(admits({}, ADMIN_CASH, 0, entry)).toBe(true);
    // φ = 0.2 ⇒ budget $228.79. Same book, same balance, same entry, and the
    // ONLY thing that changed is the env scalar.
    expect(admits({ [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '0.2' }, ADMIN_CASH, 0, entry))
      .toBe(false);
  });

  it('a LOOSER φ flips a block to an admit on the SAME book and entry', () => {
    // The other direction, so the test cannot pass by simply blocking harder as
    // φ moves at all. v0nni's $270 entry blocks at the default and admits at φ=1.
    expect(admits({}, V0NNI_CASH, 0, 270)).toBe(false);
    expect(admits({ [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '1' }, V0NNI_CASH, 0, 270))
      .toBe(true);
  });

  it('the resolved BUDGET tracks φ STRICTLY while φ binds', () => {
    // Range chosen to stay inside the region where φ is the binding term for
    // admin: `min(…, A)` takes over at φ ≥ 750/1143.96 = 0.6556, above which the
    // budget is FLAT by design (next test). Picking the range by hand rather
    // than sweeping to 1.0 is the point — a strict-monotonicity assertion that
    // straddles the clamp is testing the clamp, not the read.
    const budgets = ['0.05', '0.2', '0.4858', '0.6'].map((phi) =>
      budgetOf({ [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: phi }, ADMIN_CASH),
    );
    for (let i = 1; i < budgets.length; i += 1) {
      expect(budgets[i]).toBeGreaterThan(budgets[i - 1]);
    }
    // A hard-coded φ would make every element of this array identical. Assert
    // that directly, because "monotone" is vacuously true for a constant array
    // under `>=` and this is the assertion someone will later relax.
    expect(new Set(budgets).size).toBe(budgets.length);
  });

  it('and goes FLAT above the clamp — the authorization, not φ, is the ceiling', () => {
    // The complement of the test above, and the reason it had to pick its
    // range: for admin, φ stops mattering at 0.6556 because `min(…, A)` binds.
    // Both regions are correct behaviour and each is a different claim.
    const clamped = ['0.7', '0.9', '1'].map((phi) =>
      budgetOf({ [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: phi }, ADMIN_CASH),
    );
    expect(clamped).toEqual([750, 750, 750]);
    // v0nni never reaches the clamp — its own cash binds all the way to φ=1,
    // which is exactly the equity-blindness the flat cap could not express.
    expect(budgetOf({ [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '1' }, V0NNI_CASH)).toBe(400);
  });

  it('φ is clamped, so a mis-set env cannot WIDEN past the whole account', () => {
    // The mutation that must NOT move the decision: φ=5 is 500% of the book.
    expect(budgetOf({ [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '5' }, V0NNI_CASH))
      .toBe(budgetOf({ [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '1' }, V0NNI_CASH));
    // …and even at the ceiling, `min(…, A)` still holds the fleet cap.
    expect(budgetOf({ [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '5' }, 10_000)).toBe(750);
  });

  it('a MALFORMED φ falls back to the compiled default, not to 0 or to 1', () => {
    // Fail-safe direction matters: a fallback to 0 would dark the sleeve and
    // read identically to "the market offered nothing"; a fallback to 1 would
    // silently restore the 100%-of-account state this ticket removes.
    for (const bad of ['', 'abc', 'NaN', 'Infinity', '-1', '0']) {
      const b = budgetOf({ [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: bad }, ADMIN_CASH);
      expect(b).toBe(budgetOf({}, ADMIN_CASH));
      expect(b).toBeGreaterThan(0);
      expect(b).toBeLessThan(ADMIN_CASH);
    }
  });
});

// ─── FAIL-CLOSED ──────────────────────────────────────────────────────────────
describe('TRA-3674 fail-closed — an unreadable balance takes the book to zero', () => {
  it('no balance snapshot ⇒ budget 0 ⇒ every entry blocks, at any φ', () => {
    for (const phi of ['0.4858', '1', '5', 'abc']) {
      const env = { [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: phi };
      expect(budgetOf(env, null)).toBe(0);
      expect(admits(env, null, 0, 0.01)).toBe(false);
      expect(admits(env, null, 0, 350)).toBe(false);
    }
  });

  it('a genuinely EMPTY account is also zero — and is not confused with a full one', () => {
    expect(budgetOf({}, 0)).toBe(0);
    expect(admits({}, 0, 0, 0.01)).toBe(false);
    // The discriminator between the two is the published `availableCashUsd`
    // (`null` vs `0`) on the health row, not the budget, which is 0 for both.
  });

  it('the interim env tightening (A=375) composes with φ rather than fighting it', () => {
    // TRA-3664 shipped `LIVE_OPTION_TEST_AGGREGATE_CAP_USD=375` as the env-only
    // hold. Once φ lands, the pro-rata bound is the binding one for both books
    // and the interim is redundant — but it must not be VIOLATED while set.
    const env = { LIVE_OPTION_TEST_AGGREGATE_CAP_USD: '375' };
    expect(budgetOf(env, ADMIN_CASH)).toBe(375);   // clamped by A, not by φ
    expect(budgetOf(env, V0NNI_CASH)).toBe(194.32); // φ binds, well under A
    expect(budgetOf(env, ADMIN_CASH) + budgetOf(env, V0NNI_CASH)).toBeLessThan(750);
  });
});

describe('TRA-3674 — the compiled default is the board arithmetic, not a guess', () => {
  it('φ = A / Σ E over the two gate-open books, to 4 places', () => {
    const fleetCapital = ADMIN_CASH + V0NNI_CASH;
    expect(fleetCapital).toBe(1543.96);
    expect(750 / fleetCapital).toBeCloseTo(LIVE_OPTION_TEST_FLEET_RISK_FRACTION, 4);
  });
});
