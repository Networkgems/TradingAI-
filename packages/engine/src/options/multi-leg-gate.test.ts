import { describe, it, expect } from 'vitest';
import {
  evaluateMultiLegPreTrade,
  maxLossCapUsd,
  DEFAULT_MAX_LOSS_PCT_CAP,
  DEFAULT_MAX_LOSS_ABS_FLOOR,
  DEFAULT_MAX_LOSS_FLOOR_EQUITY_FRAC,
} from './multi-leg-gate.js';

describe('evaluateMultiLegPreTrade (TRA-912 / TRA-1348 governor)', () => {
  it('exposes the 2% default cap + $500 floor + 5% clamp governor constants', () => {
    expect(DEFAULT_MAX_LOSS_PCT_CAP).toBe(0.02);
    expect(DEFAULT_MAX_LOSS_ABS_FLOOR).toBe(500);
    expect(DEFAULT_MAX_LOSS_FLOOR_EQUITY_FRAC).toBe(0.05);
  });

  it('maxLossCapUsd applies max(equity x cap, min(absFloor, equity x floorFrac))', () => {
    // >= $25k: 2% binds ($25k -> $500, $50k -> $1000).
    expect(maxLossCapUsd(25_000)).toBe(500);
    expect(maxLossCapUsd(50_000)).toBe(1_000);
    // $10k..$25k: the $500 absolute floor binds ($15k -> $500).
    expect(maxLossCapUsd(15_000)).toBe(500);
    // < $10k: the 5% clamp on the floor binds ($6k -> $300).
    expect(maxLossCapUsd(6_000)).toBe(300);
  });

  it('ACCEPTANCE: a $25k demo book admits a single $5-wide vertical (max loss <= $500)', () => {
    // 2% of $25k = $500; a standard ~$450 max-loss $5-wide vertical fits.
    const v = evaluateMultiLegPreTrade({
      accountEquity: 25_000,
      optionBuyingPower: null,
      maxLossPerLot: 450,
      contracts: 1,
    });
    expect(v.allowed).toBe(true);
    if (v.allowed) expect(v.maxLossPct).toBeCloseTo(0.018, 6);
  });

  it('ACCEPTANCE: a $25k demo book still blocks a $10-wide spread (max loss > $500)', () => {
    // A $10-wide vertical (~$620 max loss) busts the $500 governor ceiling.
    const v = evaluateMultiLegPreTrade({
      accountEquity: 25_000,
      optionBuyingPower: null,
      maxLossPerLot: 620,
      contracts: 1,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toMatch(/exceeds per-trade cap/);
      expect(v.reason).toMatch(/\$500\.00/);
    }
  });

  it('the $500 absolute floor admits a standard lot when 2% of equity would not', () => {
    // $15k book: 2% = $300 < $450 max loss, but the floor min($500, 5%x$15k=$750)
    // = $500 lifts the ceiling so a single standard lot still enters.
    const v = evaluateMultiLegPreTrade({
      accountEquity: 15_000,
      optionBuyingPower: null,
      maxLossPerLot: 450,
      contracts: 1,
    });
    expect(v.allowed).toBe(true);
  });

  it('clamps the $500 floor to 5% of equity so a tiny live book is protected', () => {
    // $6k book: 2% = $120, floor clamped to min($500, 5%x$6k=$300) = $300.
    // A $450 lot (7.5% of equity) is correctly rejected, NOT lifted to $500.
    const v = evaluateMultiLegPreTrade({
      accountEquity: 6_000,
      optionBuyingPower: null,
      maxLossPerLot: 450,
      contracts: 1,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/\$300\.00/);
    // A $300 lot (exactly the clamped ceiling) is admitted.
    const at = evaluateMultiLegPreTrade({
      accountEquity: 6_000,
      optionBuyingPower: null,
      maxLossPerLot: 300,
      contracts: 1,
    });
    expect(at.allowed).toBe(true);
  });

  it('allows a max-loss exactly at the governor ceiling', () => {
    const v = evaluateMultiLegPreTrade({
      accountEquity: 10_000,
      optionBuyingPower: null,
      maxLossPerLot: 500, // ceiling = max($200, min($500, $500)) = $500
      contracts: 1,
    });
    expect(v.allowed).toBe(true);
  });

  it('REJECTS when total max loss across lots exceeds the ceiling', () => {
    // $50k equity -> $1000 ceiling. 3 lots x $400 = $1200 busts it.
    const v = evaluateMultiLegPreTrade({
      accountEquity: 50_000,
      optionBuyingPower: null,
      maxLossPerLot: 400,
      contracts: 3,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/\$1200\.00/);
  });

  it('REJECTS when capital-at-risk exceeds reported option buying power', () => {
    const v = evaluateMultiLegPreTrade({
      accountEquity: 1_000_000, // ceiling is generous so BP is the binding check
      optionBuyingPower: 150,
      maxLossPerLot: 200,
      contracts: 1,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toMatch(/option buying power \$150\.00/);
      expect(v.reason).toMatch(/required \$200\.00/);
    }
  });

  it('allows when buying power exactly covers the risk', () => {
    const v = evaluateMultiLegPreTrade({
      accountEquity: 1_000_000,
      optionBuyingPower: 200,
      maxLossPerLot: 200,
      contracts: 1,
    });
    expect(v.allowed).toBe(true);
  });

  it('honors a custom max-loss cap above the default', () => {
    // 3% cap on $100k = $3000; a $2500 lot passes where the 2% default ($2000)
    // would reject (equity high enough that the $500 floor never binds).
    const relaxed = evaluateMultiLegPreTrade({
      accountEquity: 100_000,
      optionBuyingPower: null,
      maxLossPerLot: 2_500,
      contracts: 1,
      maxLossPctCap: 0.03,
    });
    expect(relaxed.allowed).toBe(true);
    const strict = evaluateMultiLegPreTrade({
      accountEquity: 100_000,
      optionBuyingPower: null,
      maxLossPerLot: 2_500,
      contracts: 1,
    });
    expect(strict.allowed).toBe(false);
  });

  it('honors a custom absolute floor (0 disables it -> pure percentage cap)', () => {
    // $15k book, floor disabled: 2% = $300 ceiling; a $450 lot is rejected.
    const v = evaluateMultiLegPreTrade({
      accountEquity: 15_000,
      optionBuyingPower: null,
      maxLossPerLot: 450,
      contracts: 1,
      maxLossAbsFloor: 0,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/\$300\.00/);
  });

  it.each([
    ['non-positive equity', { accountEquity: 0, optionBuyingPower: null, maxLossPerLot: 100, contracts: 1 }],
    ['non-positive max loss', { accountEquity: 10_000, optionBuyingPower: null, maxLossPerLot: 0, contracts: 1 }],
    ['zero contracts', { accountEquity: 10_000, optionBuyingPower: null, maxLossPerLot: 100, contracts: 0 }],
    ['fractional contracts', { accountEquity: 10_000, optionBuyingPower: null, maxLossPerLot: 100, contracts: 1.5 }],
  ])('rejects malformed input: %s', (_label, input) => {
    const v = evaluateMultiLegPreTrade(input);
    expect(v.allowed).toBe(false);
  });
});
