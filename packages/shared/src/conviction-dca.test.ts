// TRA-954 — proves the risk-capped conviction DCA core: the exact R cap (never
// breached, never via a wider stop), the equity pullback ladder + gates, and the
// options defined-risk / DTE / thesis gates. Maps 1:1 to acceptance criteria 1–5.
import { describe, it, expect } from 'vitest';
import {
  CONVICTION_DCA,
  blendedAverage,
  totalQty,
  positionRiskDollars,
  maxAddQtyWithinRisk,
  evaluateEquityDcaAdd,
  evaluateOptionDcaAdd,
  type ConvictionDcaConfig,
  type EquityAddContext,
  type OptionAddContext,
} from './conviction-dca.js';

// An ENABLED config for the evaluators (shipped default is opt-IN / disabled).
const ON: ConvictionDcaConfig = { ...CONVICTION_DCA, enabled: true };

// A clean, eligible long-equity context: entry 100, stop 90, R=$100, ATR=5.
// One entry tranche of 5 shares → existing risk (100−90)·5 = $50, half of R.
function baseEquity(over: Partial<EquityAddContext> = {}): EquityAddContext {
  return {
    side: 'long',
    tranches: [{ qty: 5, price: 100 }],
    stop: 90,
    riskBudget: 100,
    addPrice: 94, // −1.2 ATR pullback from entry (eligible: > 1.0 ATR ladder, > 0.75 spacing)
    atr: 5,
    trendRef: 92, // SMA-50 below add price → trend intact
    signalStillValid: true,
    barsSinceLastFill: 3,
    minutesToSessionClose: 120,
    grossExposureBreached: false,
    dailyLossLimitBreached: false,
    tradingDaysToEarnings: null, // no earnings scheduled → blackout inert
    addsToday: 0,
    ...over,
  };
}

function baseOption(over: Partial<OptionAddContext> = {}): OptionAddContext {
  return {
    definedRisk: true,
    tranches: [{ qty: 1, price: 200 }], // 1 contract, $200 premium at risk
    riskBudget: 500,
    addDebitPerContract: 200,
    dte: 40,
    addDelta: 0.5, // comfortably above the 0.35 conviction floor
    underlyingThesisConfirmed: true,
    spreadWidthPct: 0.05,
    atMaxContracts: false,
    dailyLossLimitBreached: false,
    grossExposureBreached: false,
    tradingDaysToEarnings: null,
    addsToday: 0,
    ...over,
  };
}

describe('CONVICTION_DCA defaults', () => {
  it('ships the documented config surface, disabled by default (opt-in, sign-off gated)', () => {
    expect(CONVICTION_DCA.enabled).toBe(false);
    expect(CONVICTION_DCA.maxAdds).toBe(2);
    expect(CONVICTION_DCA.trancheSplit).toEqual([0.5, 0.3, 0.2]);
    expect(CONVICTION_DCA.equityAddSpacingATR).toBe(1.0);
    expect(CONVICTION_DCA.minSpacingBars).toBe(1);
    expect(CONVICTION_DCA.minSpacingATR).toBe(0.75);
    expect(CONVICTION_DCA.optionMinDTE).toBe(21);
    expect(CONVICTION_DCA.respectDailyLossLimit).toBe(true);
    expect(CONVICTION_DCA.noAddLastMinutes).toBe(30);
    // TRA-958 live-flip gates A/B/C
    expect(CONVICTION_DCA.optionMinAddDelta).toBe(0.35);
    expect(CONVICTION_DCA.earningsBlackoutTradingDays).toBe(2);
    expect(CONVICTION_DCA.maxAddsPerNamePerDay).toBe(1);
  });
});

describe('pure math', () => {
  it('blends average + totals quantity', () => {
    const t = [{ qty: 5, price: 100 }, { qty: 5, price: 90 }];
    expect(totalQty(t)).toBe(10);
    expect(blendedAverage(t)).toBe(95);
  });

  it('positionRiskDollars is (avg−stop)·qty long, (stop−avg)·qty short', () => {
    expect(positionRiskDollars(100, 90, 5, 'long')).toBe(50);
    expect(positionRiskDollars(100, 110, 5, 'short')).toBe(50);
  });

  it('maxAddQtyWithinRisk solves the exact linear cap (long)', () => {
    // existing risk = (100−90)·5 = 50; headroom = 100−50 = 50; per-unit = 94−90 = 4
    // → max add = 50/4 = 12.5
    const t = [{ qty: 5, price: 100 }];
    expect(maxAddQtyWithinRisk(t, 94, 90, 'long', 100)).toBeCloseTo(12.5);
  });

  it('the linear identity matches the literal (avg−stop)·qty after the add', () => {
    const t = [{ qty: 5, price: 100 }];
    const addQty = maxAddQtyWithinRisk(t, 94, 90, 'long', 100); // sits exactly at R
    const merged = [...t, { qty: addQty, price: 94 }];
    const literalRisk = positionRiskDollars(blendedAverage(merged), 90, totalQty(merged), 'long');
    expect(literalRisk).toBeCloseTo(100); // == R, the cap is exact
  });

  it('returns 0 headroom when the existing position already consumes R', () => {
    const t = [{ qty: 10, price: 100 }]; // risk (100−90)·10 = 100 = R
    expect(maxAddQtyWithinRisk(t, 94, 90, 'long', 100)).toBe(0);
  });

  it('refuses to size an add that sits at/through the stop (no negative-risk gaming)', () => {
    const t = [{ qty: 5, price: 100 }];
    expect(maxAddQtyWithinRisk(t, 90, 90, 'long', 100)).toBe(0); // add_price == stop
    expect(maxAddQtyWithinRisk(t, 89, 90, 'long', 100)).toBe(0); // add_price < stop
  });
});

// ── Acceptance #1: held position pulls back, thesis intact → up to 2 adds, R held ──
describe('acceptance #1 — eligible pullback receives adds within R', () => {
  it('adds on an eligible pullback and keeps (avg−stop)·qty <= R', () => {
    const v = evaluateEquityDcaAdd(baseEquity(), ON);
    expect(v.action).not.toBe('skip');
    expect(v.qty).toBeGreaterThan(0);
    expect(v.projectedRisk!).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('caps at maxAdds (2 adds → no third)', () => {
    // 3 tranches already = entry + 2 adds → addsUsed = 2 = maxAdds.
    const ctx = baseEquity({
      tranches: [{ qty: 5, price: 100 }, { qty: 3, price: 95 }, { qty: 2, price: 90.5 }],
    });
    const v = evaluateEquityDcaAdd(ctx, ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/max adds/);
  });
});

// ── Acceptance #2: an add that would breach R is shrunk or skipped ──
describe('acceptance #2 — breach of R is shrunk or skipped', () => {
  it('shrinks the add when the split target would breach R', () => {
    // Tight headroom: existing risk 90 of R=100 → only $10 headroom, per-unit 4 → max 2 sh.
    const ctx = baseEquity({ tranches: [{ qty: 9, price: 100 }] });
    const v = evaluateEquityDcaAdd(ctx, ON);
    expect(v.action).toBe('shrink');
    expect(v.qty).toBeLessThanOrEqual(2);
    expect(v.projectedRisk!).toBeLessThanOrEqual(100 + 1e-9);
  });

  it('skips entirely when not even one share fits', () => {
    const ctx = baseEquity({ tranches: [{ qty: 10, price: 100 }] }); // already at R
    const v = evaluateEquityDcaAdd(ctx, ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/cannot fit risk budget/);
  });

  it('never widens the stop — the stop in/out is identical', () => {
    const ctx = baseEquity();
    const v = evaluateEquityDcaAdd(ctx, ON);
    // The verdict carries no stop field and the projected risk is measured against
    // the SAME ctx.stop; the only thing solved for is qty.
    const reMeasured = positionRiskDollars(v.blendedAvg!, ctx.stop, v.totalQty!, 'long');
    expect(reMeasured).toBeCloseTo(v.projectedRisk!);
  });
});

// ── Acceptance #3: a trend break (close < SMA-50) triggers exit, not an add ──
describe('acceptance #3 — trend break / thesis flip blocks the add', () => {
  it('blocks the add when price is below the trend reference (long)', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ addPrice: 91, trendRef: 92 }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/trend break is an exit/);
  });

  it('blocks the add when the entry signal has flipped to exit', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ signalStillValid: false }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/thesis broken/);
  });

  it('short side: an add ABOVE the trend reference is the trend break', () => {
    const ctx = baseEquity({
      side: 'short',
      tranches: [{ qty: 5, price: 100 }],
      stop: 110,
      addPrice: 106,
      trendRef: 104, // short add above SMA → trend break
    });
    const v = evaluateEquityDcaAdd(ctx, ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/trend break/);
  });
});

describe('equity spacing + session guards', () => {
  it('blocks when fewer than minSpacingBars since last fill', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ barsSinceLastFill: 0 }), ON);
    expect(v.reason).toMatch(/spacing: only 0 bar/);
  });

  it('blocks when the pullback is < 0.75 ATR (too close to last fill)', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ addPrice: 98 }), ON); // 0.4 ATR pullback
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/ATR pullback/);
  });

  it('blocks when not yet at the ladder add-level (>=0.75 but <1.0 ATR)', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ addPrice: 96 }), ON); // 0.8 ATR
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/not at add level/);
  });

  it('blocks inside the last 30 minutes of session', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ minutesToSessionClose: 20 }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/last 30m/);
  });
});

// ── Acceptance #4: options adds blocked when DTE < 21 or thesis broken ──
describe('acceptance #4 — options DTE + thesis gates', () => {
  it('adds to a defined-risk long within the premium budget', () => {
    const v = evaluateOptionDcaAdd(baseOption(), ON);
    expect(v.action).not.toBe('skip');
    expect(v.qty).toBeGreaterThanOrEqual(1);
    expect(v.projectedRisk!).toBeLessThanOrEqual(500 + 1e-9);
  });

  it('blocks when DTE < optionMinDTE (theta-dominated)', () => {
    const v = evaluateOptionDcaAdd(baseOption({ dte: 14 }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/DTE 14 < 21/);
  });

  it('blocks when the underlying no longer confirms (no averaging into IV crush)', () => {
    const v = evaluateOptionDcaAdd(baseOption({ underlyingThesisConfirmed: false }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/IV crush/);
  });

  it('refuses short premium outright', () => {
    const v = evaluateOptionDcaAdd(baseOption({ definedRisk: false }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/short premium/);
  });

  it('blocks on the liquidity guard (spread too wide)', () => {
    const v = evaluateOptionDcaAdd(baseOption({ spreadWidthPct: 0.2 }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/spread width/);
  });

  it('blocks at max contracts for the name', () => {
    const v = evaluateOptionDcaAdd(baseOption({ atMaxContracts: true }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/max contracts/);
  });

  it('shrinks the option add when the premium budget is nearly full', () => {
    // premium so far 1 contract @ $450; R=500 → only $50 headroom, < one $200 contract.
    const v = evaluateOptionDcaAdd(
      baseOption({ tranches: [{ qty: 1, price: 450 }], addDebitPerContract: 200 }),
      ON,
    );
    expect(v.action).toBe('skip'); // can't fit even one
    expect(v.reason).toMatch(/cannot fit premium budget/);
  });

  it('caps total premium at R across tranches', () => {
    const v = evaluateOptionDcaAdd(baseOption(), ON);
    const premiumSoFar = 200;
    expect(v.projectedRisk!).toBe(premiumSoFar + v.qty * 200);
    expect(v.projectedRisk!).toBeLessThanOrEqual(500);
  });
});

// ── Acceptance #5: daily-loss / gross-exposure breaches block all adds ──
describe('acceptance #5 — portfolio hard gates block all adds', () => {
  it('equity: daily-loss limit tripped blocks the add', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ dailyLossLimitBreached: true }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/daily-loss limit/);
  });

  it('equity: gross-exposure breach blocks the add', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ grossExposureBreached: true }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/gross-exposure/);
  });

  it('option: daily-loss + gross-exposure breaches block the add', () => {
    expect(evaluateOptionDcaAdd(baseOption({ dailyLossLimitBreached: true }), ON).action).toBe('skip');
    expect(evaluateOptionDcaAdd(baseOption({ grossExposureBreached: true }), ON).action).toBe('skip');
  });

  it('respectDailyLossLimit=false lets the daily-loss breach pass (config-gated)', () => {
    const cfg: ConvictionDcaConfig = { ...ON, respectDailyLossLimit: false };
    const v = evaluateEquityDcaAdd(baseEquity({ dailyLossLimitBreached: true }), cfg);
    expect(v.action).not.toBe('skip');
  });
});

// ── TRA-958 live-flip gates A/B/C (required before dca.enabled=true for live) ──
describe('TRA-958 gate A — option conviction delta floor (|delta| >= 0.35)', () => {
  it('blocks a far-OTM call add below the delta floor', () => {
    const v = evaluateOptionDcaAdd(baseOption({ addDelta: 0.2 }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/delta.*floor 0.35|too far OTM/);
  });

  it('blocks a far-OTM put add below the floor (sign-agnostic)', () => {
    const v = evaluateOptionDcaAdd(baseOption({ addDelta: -0.2 }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/too far OTM/);
  });

  it('allows a put add with delta at/below −0.35', () => {
    const v = evaluateOptionDcaAdd(baseOption({ addDelta: -0.45 }), ON);
    expect(v.action).not.toBe('skip');
  });

  it('no upper delta cap — deep-ITM (delta ~0.9) still allowed', () => {
    const v = evaluateOptionDcaAdd(baseOption({ addDelta: 0.9 }), ON);
    expect(v.action).not.toBe('skip');
  });
});

describe('TRA-958 gate B — earnings/event blackout (no add within 2 trading days)', () => {
  it('equity: blocks an add when earnings is inside the blackout window', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ tradingDaysToEarnings: 1 }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/blackout/);
  });

  it('equity: allows the add when earnings is outside the window', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ tradingDaysToEarnings: 3 }), ON);
    expect(v.action).not.toBe('skip');
  });

  it('equity: null (no earnings scheduled) leaves the blackout inert', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ tradingDaysToEarnings: null }), ON);
    expect(v.action).not.toBe('skip');
  });

  it('option: blocks an add the trading day before earnings (boundary = 2)', () => {
    const v = evaluateOptionDcaAdd(baseOption({ tradingDaysToEarnings: 2 }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/blackout/);
  });
});

describe('TRA-958 gate C — max 1 add per name per day', () => {
  it('equity: blocks a second add once one has fired today', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ addsToday: 1 }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/max 1\/name\/day/);
  });

  it('option: blocks a second add once one has fired today', () => {
    const v = evaluateOptionDcaAdd(baseOption({ addsToday: 1 }), ON);
    expect(v.action).toBe('skip');
    expect(v.reason).toMatch(/name\/day/);
  });

  it('equity: the first add of the day (addsToday=0) is allowed', () => {
    const v = evaluateEquityDcaAdd(baseEquity({ addsToday: 0 }), ON);
    expect(v.action).not.toBe('skip');
  });
});

describe('master switch', () => {
  it('disabled config skips every add (equity + option)', () => {
    expect(evaluateEquityDcaAdd(baseEquity(), CONVICTION_DCA).action).toBe('skip');
    expect(evaluateOptionDcaAdd(baseOption(), CONVICTION_DCA).action).toBe('skip');
  });
});
