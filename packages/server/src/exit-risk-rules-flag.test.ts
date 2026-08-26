import { describe, it, expect } from 'vitest';
import { isExitRiskRulesEnabled, isLiveEquityStopModifyEnabled, isProfitFloorTrailEnabled, isTakeProfitEarlyEnabled, isCorrelatedExposureCapEnabled, isOtmDeltaFloorEnabled, resolveOtmDeltaFloor, OTM_DELTA_FLOOR_DEFAULT, isEntryDeltaCeilingEnabled, resolveEntryDeltaCeiling, resolveEntryDeltaCeilingStructures, resolveEntryDeltaCeilingMap, resolveEntryDeltaCeilingObserveStructures, entryDeltaCeilingReject, entryDeltaCeilingVerdict, OPTION_ENTRY_DELTA_CEILING_DEFAULT, isRvExitRetuneEnabled, resolveRvExitConfirmBars, RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT, resolveRvExitFlipMinLossPct, isBookGiveBackArmFloorEnabled, isRvExitRetuneLiveEnabled, isTakeProfitEarlyLiveEnabled, resolveSwingTimeStopTradingDays, OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT } from './exit-risk-rules-flag.js';

// TRA-1250 / TRA-1269 / TRA-1294 / TRA-1295 — master switch + the isolated sub-flags.

describe('isExitRiskRulesEnabled', () => {
  it('is off by default and accepts 1/true/yes/on (case/space-insensitive)', () => {
    expect(isExitRiskRulesEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ', 'True']) {
      expect(isExitRiskRulesEnabled({ EXIT_RISK_RULES_ENABLED: v })).toBe(true);
    }
    expect(isExitRiskRulesEnabled({ EXIT_RISK_RULES_ENABLED: 'off' })).toBe(false);
  });
});

describe('isLiveEquityStopModifyEnabled (TRA-1269)', () => {
  it('requires BOTH the master switch AND the sub-flag', () => {
    // Sub-flag alone does nothing — the master must also be on.
    expect(isLiveEquityStopModifyEnabled({ LIVE_EQUITY_STOP_MODIFY_ENABLED: 'true' })).toBe(false);
    // Master alone does not enable the live stop-modify path.
    expect(isLiveEquityStopModifyEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    // Both on → enabled.
    expect(
      isLiveEquityStopModifyEnabled({ EXIT_RISK_RULES_ENABLED: 'true', LIVE_EQUITY_STOP_MODIFY_ENABLED: '1' }),
    ).toBe(true);
    // Master off wins even if the sub-flag is on.
    expect(
      isLiveEquityStopModifyEnabled({ EXIT_RISK_RULES_ENABLED: 'off', LIVE_EQUITY_STOP_MODIFY_ENABLED: 'yes' }),
    ).toBe(false);
  });
});

describe('isTakeProfitEarlyEnabled (TRA-1294)', () => {
  it('is STANDALONE — not gated under the exit-risk master (demo-only rollout)', () => {
    // Off by default; accepts the usual truthy spellings on its own.
    expect(isTakeProfitEarlyEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isTakeProfitEarlyEnabled({ TAKE_PROFIT_EARLY_ENABLED: v })).toBe(true);
    }
    // Deliberately decoupled from the master: the master alone does NOT enable it,
    // and it does NOT require the master (so arming it on demo never turns on the
    // loss-side rules on the live options path).
    expect(isTakeProfitEarlyEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    expect(
      isTakeProfitEarlyEnabled({ EXIT_RISK_RULES_ENABLED: 'off', TAKE_PROFIT_EARLY_ENABLED: '1' }),
    ).toBe(true);
  });
});

describe('isCorrelatedExposureCapEnabled (TRA-1295)', () => {
  it('requires BOTH the master switch AND the sub-flag', () => {
    // Sub-flag alone does nothing — the master must also be on.
    expect(isCorrelatedExposureCapEnabled({ CORRELATED_EXPOSURE_CAP_ENABLED: 'true' })).toBe(false);
    // Master alone does not arm the correlated-exposure admission gate.
    expect(isCorrelatedExposureCapEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    // Both on → enabled.
    expect(
      isCorrelatedExposureCapEnabled({ EXIT_RISK_RULES_ENABLED: 'true', CORRELATED_EXPOSURE_CAP_ENABLED: '1' }),
    ).toBe(true);
    // Master off wins even if the sub-flag is on.
    expect(
      isCorrelatedExposureCapEnabled({ EXIT_RISK_RULES_ENABLED: 'off', CORRELATED_EXPOSURE_CAP_ENABLED: 'yes' }),
    ).toBe(false);
  });
});

describe('isOtmDeltaFloorEnabled / resolveOtmDeltaFloor (TRA-1407)', () => {
  it('is STANDALONE — off by default, accepts truthy spellings, not gated by the master', () => {
    expect(isOtmDeltaFloorEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isOtmDeltaFloorEnabled({ OTM_DELTA_FLOOR_ENABLED: v })).toBe(true);
    }
    // Decoupled from the exit-risk master (demo-scoped by the caller instead).
    expect(isOtmDeltaFloorEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    expect(
      isOtmDeltaFloorEnabled({ EXIT_RISK_RULES_ENABLED: 'off', OTM_DELTA_FLOOR_ENABLED: '1' }),
    ).toBe(true);
  });

  it('resolves the floor to the default when unset or malformed, and honours a valid override', () => {
    expect(resolveOtmDeltaFloor({})).toBe(OTM_DELTA_FLOOR_DEFAULT);
    expect(resolveOtmDeltaFloor({ OTM_DELTA_FLOOR: '0.35' })).toBe(0.35);
    // Out-of-range / malformed → fall back to the default (never silently disable).
    for (const bad of ['', 'abc', '0', '-0.2', '1', '1.5']) {
      expect(resolveOtmDeltaFloor({ OTM_DELTA_FLOOR: bad })).toBe(OTM_DELTA_FLOOR_DEFAULT);
    }
  });
});

// TRA-1670 (TRA-1647B) — the CEILING half of the entry-delta band. QuantTrader's
// standing instruction on this ticket: "carry a test asserting the ceiling is
// REJECTING, not just present" — a knob that is shipped, believed armed and silently
// inert is the TRA-1486 / TRA-1407 failure mode twice over. These assert the verdict,
// not the plumbing. The end-to-end proof (a Δ=0.60 candidate the ENGINE refuses to
// open) lives in signal-engine.test.ts.
describe('entry delta ceiling (TRA-1670)', () => {
  const ARMED = { OPTION_ENTRY_DELTA_CEILING_ENABLED: '1' };

  it('is STANDALONE — off by default, accepts truthy spellings, not gated by the master', () => {
    expect(isEntryDeltaCeilingEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isEntryDeltaCeilingEnabled({ OPTION_ENTRY_DELTA_CEILING_ENABLED: v })).toBe(true);
    }
    expect(isEntryDeltaCeilingEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
  });

  it('REJECTS the measured OTM loss tail (|Δ| > 0.55) and ADMITS at/below the ceiling', () => {
    // The two cases the ticket names explicitly.
    expect(entryDeltaCeilingReject('single_leg_otm', 0.60, ARMED)).toBeTruthy();
    expect(entryDeltaCeilingReject('single_leg_otm', 0.50, ARMED)).toBeNull();
    // The boundary is inclusive-admit: 0.55 is the top of the KEEP band, not the tail.
    expect(entryDeltaCeilingReject('single_leg_otm', 0.55, ARMED)).toBeNull();
    expect(entryDeltaCeilingReject('single_leg_otm', 0.5501, ARMED)).toBeTruthy();
    // Puts carry a negative delta — the cut is on the MAGNITUDE.
    expect(entryDeltaCeilingReject('single_leg_otm', -0.60, ARMED)).toBeTruthy();
    expect(entryDeltaCeilingReject('single_leg_otm', -0.50, ARMED)).toBeNull();
  });

  it('is INERT while disarmed — the tail passes untouched', () => {
    expect(entryDeltaCeilingReject('single_leg_otm', 0.95, {})).toBeNull();
  });

  it('is SCOPED to single_leg_otm by default — RV / directional stay uncapped', () => {
    // The 0.55 is measured on OTM only; the other sleeves must not inherit it.
    expect(entryDeltaCeilingReject('single_leg_rv', 0.90, ARMED)).toBeNull();
    expect(entryDeltaCeilingReject('directional', 0.90, ARMED)).toBeNull();
    // ...but the board can widen the band via the structures override, no redeploy.
    expect(
      entryDeltaCeilingReject('single_leg_rv', 0.90, {
        ...ARMED,
        OPTION_ENTRY_DELTA_CEILING_STRUCTURES: 'single_leg_otm, single_leg_rv',
      }),
    ).toBeTruthy();
  });

  it('honours a valid numeric override and falls back to 0.55 on a malformed one', () => {
    expect(resolveEntryDeltaCeiling({})).toBe(OPTION_ENTRY_DELTA_CEILING_DEFAULT);
    expect(resolveEntryDeltaCeiling({ OPTION_ENTRY_DELTA_CEILING: '0.70' })).toBe(0.70);
    // TRA-1647's invalidation is a RETUNE (0.55 → 0.70), so the override must bite.
    expect(
      entryDeltaCeilingReject('single_leg_otm', 0.60, { ...ARMED, OPTION_ENTRY_DELTA_CEILING: '0.70' }),
    ).toBeNull();
    // Malformed / out-of-range → the default, NEVER a silent disable.
    for (const bad of ['', 'abc', '0', '-0.2', '1', '1.5']) {
      expect(resolveEntryDeltaCeiling({ OPTION_ENTRY_DELTA_CEILING: bad })).toBe(OPTION_ENTRY_DELTA_CEILING_DEFAULT);
    }
    // A blanked structures list falls back to the default rather than disarming the cut.
    expect(resolveEntryDeltaCeilingStructures({ OPTION_ENTRY_DELTA_CEILING_STRUCTURES: ' , ' }))
      .toEqual(['single_leg_otm']);
  });

  it('ADMITS a candidate with no usable delta (honest-unknown, not a silent starve)', () => {
    expect(entryDeltaCeilingReject('single_leg_otm', null, ARMED)).toBeNull();
    expect(entryDeltaCeilingReject('single_leg_otm', undefined, ARMED)).toBeNull();
    expect(entryDeltaCeilingReject('single_leg_otm', Number.NaN, ARMED)).toBeNull();
  });
});

describe('per-structure entry delta ceilings (TRA-1689)', () => {
  const ARMED = { OPTION_ENTRY_DELTA_CEILING_ENABLED: '1' };

  // THE BUG THIS SHIPPED FOR. The ceiling number used to be a single global scalar, so
  // the only way to arm RV at 0.65 was to set the global to 0.65 — which silently moved
  // OTM's MEASURED 0.55 ceiling to 0.65 too, re-admitting the exact n=14 / NET −1.813R
  // tail TRA-1670 exists to cut. A band measured on one sleeve must not be reachable
  // from another sleeve's knob.
  it('arming RV at 0.65 does NOT move OTM off its measured 0.55', () => {
    const env = {
      ...ARMED,
      OPTION_ENTRY_DELTA_CEILING_STRUCTURES: 'single_leg_otm,single_leg_rv:0.65',
    };
    // RV gets its own, looser number.
    expect(entryDeltaCeilingReject('single_leg_rv', 0.60, env)).toBeNull();
    expect(entryDeltaCeilingReject('single_leg_rv', 0.70, env)).toBeTruthy();
    // OTM is UNMOVED — 0.60 is still cut. This is the assertion that would have failed
    // under the old global-scalar config.
    expect(entryDeltaCeilingReject('single_leg_otm', 0.60, env)).toBeTruthy();
    expect(entryDeltaCeilingReject('single_leg_otm', 0.50, env)).toBeNull();

    expect(resolveEntryDeltaCeilingMap(env).get('single_leg_otm')).toBe(0.55);
    expect(resolveEntryDeltaCeilingMap(env).get('single_leg_rv')).toBe(0.65);
  });

  it('a bare structure inherits the global ceiling; name:value overrides it', () => {
    const env = {
      ...ARMED,
      OPTION_ENTRY_DELTA_CEILING: '0.50',
      OPTION_ENTRY_DELTA_CEILING_STRUCTURES: 'single_leg_otm,directional:0.80',
    };
    const map = resolveEntryDeltaCeilingMap(env);
    expect(map.get('single_leg_otm')).toBe(0.50);
    expect(map.get('directional')).toBe(0.80);
    expect(map.has('single_leg_rv')).toBe(false);
  });

  it('a malformed :value falls back to the global rather than UNCAPPING the sleeve', () => {
    for (const bad of ['abc', '', '0', '-0.2', '1', '1.5']) {
      const env = {
        ...ARMED,
        OPTION_ENTRY_DELTA_CEILING_STRUCTURES: `single_leg_rv:${bad}`,
      };
      expect(resolveEntryDeltaCeilingMap(env).get('single_leg_rv'))
        .toBe(OPTION_ENTRY_DELTA_CEILING_DEFAULT);
      // A typo in the number must not turn the cut OFF — it stays capped at the default.
      expect(entryDeltaCeilingReject('single_leg_rv', 0.90, env)).toBeTruthy();
    }
  });

  it('OBSERVE-ONLY: the breach is reported but does NOT reject the open', () => {
    const env = {
      ...ARMED,
      OPTION_ENTRY_DELTA_CEILING_STRUCTURES: 'single_leg_otm,single_leg_rv:0.65',
      OPTION_ENTRY_DELTA_CEILING_OBSERVE_STRUCTURES: 'single_leg_rv',
    };
    const verdict = entryDeltaCeilingVerdict('single_leg_rv', 0.80, env);
    expect(verdict.breached).toBe(true);
    expect(verdict.enforced).toBe(false);
    expect(verdict.ceiling).toBe(0.65);
    expect(verdict.reason).toContain('OBSERVE-ONLY');
    // The blocking verdict is NULL — the trade goes on. A caller that treated the
    // breach as a rejection would be lying about what the engine did.
    expect(entryDeltaCeilingReject('single_leg_rv', 0.80, env)).toBeNull();

    // ...and OTM, not listed as observe-only, still ENFORCES.
    expect(entryDeltaCeilingVerdict('single_leg_otm', 0.80, env).enforced).toBe(true);
    expect(entryDeltaCeilingReject('single_leg_otm', 0.80, env)).toBeTruthy();
  });

  it('observing a structure the ceiling does not cover arms nothing', () => {
    const env = {
      ...ARMED,
      OPTION_ENTRY_DELTA_CEILING_OBSERVE_STRUCTURES: 'single_leg_rv',
    };
    // RV is not in the (default OTM-only) ceiling map, so there is nothing to observe.
    expect(entryDeltaCeilingVerdict('single_leg_rv', 0.95, env).breached).toBe(false);
    expect(resolveEntryDeltaCeilingObserveStructures(env)).toEqual(['single_leg_rv']);
  });

  it('is inert while the flag is OFF, observe list or not', () => {
    const env = {
      OPTION_ENTRY_DELTA_CEILING_STRUCTURES: 'single_leg_otm,single_leg_rv:0.65',
      OPTION_ENTRY_DELTA_CEILING_OBSERVE_STRUCTURES: 'single_leg_rv',
    };
    expect(entryDeltaCeilingVerdict('single_leg_rv', 0.95, env).breached).toBe(false);
    expect(entryDeltaCeilingVerdict('single_leg_otm', 0.95, env).breached).toBe(false);
  });
});

describe('isRvExitRetuneEnabled / resolveRvExitConfirmBars (TRA-1409)', () => {
  it('is STANDALONE — off by default, accepts truthy spellings, not gated by the master', () => {
    expect(isRvExitRetuneEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isRvExitRetuneEnabled({ RV_EXIT_RETUNE_ENABLED: v })).toBe(true);
    }
    // Decoupled from the exit-risk master (demo-scoped by the caller instead).
    expect(isRvExitRetuneEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    expect(
      isRvExitRetuneEnabled({ EXIT_RISK_RULES_ENABLED: 'off', RV_EXIT_RETUNE_ENABLED: '1' }),
    ).toBe(true);
  });

  it('resolves confirm-bars to the default (2) when unset or malformed, honours a valid override', () => {
    expect(resolveRvExitConfirmBars({})).toBe(RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT);
    expect(RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT).toBe(2);
    expect(resolveRvExitConfirmBars({ RV_EXIT_RETUNE_CONFIRM_BARS: '3' })).toBe(3);
    expect(resolveRvExitConfirmBars({ RV_EXIT_RETUNE_CONFIRM_BARS: '1' })).toBe(1);
    // Malformed / out-of-range / non-integer → fall back to the default.
    for (const bad of ['', 'abc', '0', '-1', '2.5', '11']) {
      expect(resolveRvExitConfirmBars({ RV_EXIT_RETUNE_CONFIRM_BARS: bad })).toBe(
        RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT,
      );
    }
  });

  it('TRA-1480 v2 — resolves the flip winner-protect loss threshold, undefined when unset/malformed', () => {
    // Unset → undefined → v1 behaviour (flip fires at any P&L) preserved.
    expect(resolveRvExitFlipMinLossPct({})).toBeUndefined();
    // Valid loss fractions in (-1, 0] are honoured, incl. 0 (suppress on any gain).
    expect(resolveRvExitFlipMinLossPct({ RV_EXIT_FLIP_MIN_LOSS_PCT: '-0.2' })).toBe(-0.2);
    expect(resolveRvExitFlipMinLossPct({ RV_EXIT_FLIP_MIN_LOSS_PCT: '0' })).toBe(0);
    expect(resolveRvExitFlipMinLossPct({ RV_EXIT_FLIP_MIN_LOSS_PCT: '-0.999' })).toBe(-0.999);
    // Malformed / out-of-range (positive, ≤ -1, non-numeric, blank) → undefined.
    for (const bad of ['', ' ', 'abc', '0.1', '-1', '-1.5', 'NaN']) {
      expect(resolveRvExitFlipMinLossPct({ RV_EXIT_FLIP_MIN_LOSS_PCT: bad })).toBeUndefined();
    }
  });
});

describe('isBookGiveBackArmFloorEnabled (TRA-1435)', () => {
  it('requires BOTH the master switch AND the sub-flag', () => {
    // Sub-flag alone does nothing — the master must also be on (the give-back cap
    // itself only runs when EXIT_RISK_RULES_ENABLED is on).
    expect(isBookGiveBackArmFloorEnabled({ BOOK_GIVEBACK_ARM_FLOOR_ENABLED: 'true' })).toBe(false);
    // Master alone does not arm the give-back floor (legacy arm-at-any-peak stays).
    expect(isBookGiveBackArmFloorEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    // Both on → enabled; accepts the usual truthy spellings.
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(
        isBookGiveBackArmFloorEnabled({ EXIT_RISK_RULES_ENABLED: 'true', BOOK_GIVEBACK_ARM_FLOOR_ENABLED: v }),
      ).toBe(true);
    }
    // Master off wins even if the sub-flag is on.
    expect(
      isBookGiveBackArmFloorEnabled({ EXIT_RISK_RULES_ENABLED: 'off', BOOK_GIVEBACK_ARM_FLOOR_ENABLED: '1' }),
    ).toBe(false);
  });
});

describe('TRA-2949 live swing-exit flags', () => {
  it('RV_EXIT_RETUNE_LIVE_ENABLED defaults off and accepts truthy spellings', () => {
    expect(isRvExitRetuneLiveEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'yes', 'on']) {
      expect(isRvExitRetuneLiveEnabled({ RV_EXIT_RETUNE_LIVE_ENABLED: v })).toBe(true);
    }
    expect(isRvExitRetuneLiveEnabled({ RV_EXIT_RETUNE_LIVE_ENABLED: 'off' })).toBe(false);
  });
  it('the demo re-tune flag does NOT arm the live port (and vice versa)', () => {
    expect(isRvExitRetuneLiveEnabled({ RV_EXIT_RETUNE_ENABLED: '1' })).toBe(false);
    expect(isRvExitRetuneEnabled({ RV_EXIT_RETUNE_LIVE_ENABLED: '1' })).toBe(false);
  });
  // TRA-4020 — its own flag (revertible without disarming the loss-side rules)
  // that nonetheless REQUIRES the master, because the floor is a leg of the
  // profit-lock and there is no profit-lock to attach it to with the master off.
  it('PROFIT_FLOOR_TRAIL_ENABLED defaults off, needs the exit-risk master, and never rides another flag', () => {
    expect(isProfitFloorTrailEnabled({})).toBe(false);
    expect(isProfitFloorTrailEnabled({ PROFIT_FLOOR_TRAIL_ENABLED: '1' })).toBe(false);
    expect(isProfitFloorTrailEnabled({ EXIT_RISK_RULES_ENABLED: '1' })).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isProfitFloorTrailEnabled({ EXIT_RISK_RULES_ENABLED: '1', PROFIT_FLOOR_TRAIL_ENABLED: v })).toBe(true);
    }
    expect(isProfitFloorTrailEnabled({ EXIT_RISK_RULES_ENABLED: '1', PROFIT_FLOOR_TRAIL_ENABLED: 'off' })).toBe(false);
    expect(isProfitFloorTrailEnabled({ EXIT_RISK_RULES_ENABLED: '1', TAKE_PROFIT_EARLY_LIVE_ENABLED: '1' })).toBe(false);
    // And the master alone does not switch the floor on (the whole point of a separate flag).
    expect(isExitRiskRulesEnabled({ EXIT_RISK_RULES_ENABLED: '1' })).toBe(true);
  });
  it('TAKE_PROFIT_EARLY_LIVE_ENABLED defaults off, is standalone, and never rides the demo flag', () => {
    expect(isTakeProfitEarlyLiveEnabled({})).toBe(false);
    expect(isTakeProfitEarlyLiveEnabled({ TAKE_PROFIT_EARLY_LIVE_ENABLED: 'true' })).toBe(true);
    expect(isTakeProfitEarlyLiveEnabled({ TAKE_PROFIT_EARLY_ENABLED: '1' })).toBe(false);
    expect(isTakeProfitEarlyEnabled({ TAKE_PROFIT_EARLY_LIVE_ENABLED: '1' })).toBe(false);
  });
  it('resolveSwingTimeStopTradingDays defaults to 4 and honors a sane override', () => {
    expect(resolveSwingTimeStopTradingDays({})).toBe(OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT);
    expect(resolveSwingTimeStopTradingDays({ OPTION_SWING_TIME_STOP_TRADING_DAYS: '6' })).toBe(6);
    // 0 is a deliberate "disable the swing time stop" setting.
    expect(resolveSwingTimeStopTradingDays({ OPTION_SWING_TIME_STOP_TRADING_DAYS: '0' })).toBe(0);
  });
  it('resolveSwingTimeStopTradingDays falls back on malformed/out-of-range values', () => {
    for (const v of ['abc', '-1', '99', '2.5', '']) {
      expect(resolveSwingTimeStopTradingDays({ OPTION_SWING_TIME_STOP_TRADING_DAYS: v })).toBe(
        OPTION_SWING_TIME_STOP_TRADING_DAYS_DEFAULT,
      );
    }
  });
});
