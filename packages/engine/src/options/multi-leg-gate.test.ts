import { describe, it, expect } from 'vitest';
import { evaluateMultiLegPreTrade, DEFAULT_MAX_LOSS_PCT_CAP } from './multi-leg-gate.js';

describe('evaluateMultiLegPreTrade (TRA-912)', () => {
  it('exposes a 1% default max-loss cap', () => {
    expect(DEFAULT_MAX_LOSS_PCT_CAP).toBe(0.01);
  });

  it('allows a defined-risk lot inside the 1% cap with no buying-power info', () => {
    // $25k equity -> 1% cap = $250. One $200 max-loss spread fits.
    const v = evaluateMultiLegPreTrade({
      accountEquity: 25_000,
      optionBuyingPower: null,
      maxLossPerLot: 200,
      contracts: 1,
    });
    expect(v.allowed).toBe(true);
    if (v.allowed) {
      expect(v.totalMaxLoss).toBe(200);
      expect(v.maxLossPct).toBeCloseTo(0.008, 6);
    }
  });

  it('allows a max-loss exactly at the cap boundary', () => {
    const v = evaluateMultiLegPreTrade({
      accountEquity: 10_000,
      optionBuyingPower: null,
      maxLossPerLot: 100, // exactly 1% of 10k
      contracts: 1,
    });
    expect(v.allowed).toBe(true);
  });

  it('REJECTS an oversized single lot whose max loss exceeds 1% of equity', () => {
    // $10k equity -> $100 cap. A single $260 max-loss lot busts it.
    const v = evaluateMultiLegPreTrade({
      accountEquity: 10_000,
      optionBuyingPower: null,
      maxLossPerLot: 260,
      contracts: 1,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toMatch(/exceeds 1\.00% cap/);
      expect(v.reason).toMatch(/\$100\.00/);
    }
  });

  it('REJECTS when total max loss across lots exceeds the cap', () => {
    // $50k equity -> $500 cap. 3 lots x $200 = $600 busts it.
    const v = evaluateMultiLegPreTrade({
      accountEquity: 50_000,
      optionBuyingPower: null,
      maxLossPerLot: 200,
      contracts: 3,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toMatch(/\$600\.00/);
  });

  it('REJECTS when capital-at-risk exceeds reported option buying power', () => {
    const v = evaluateMultiLegPreTrade({
      accountEquity: 1_000_000, // cap is generous so BP is the binding check
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

  it('honors a custom max-loss cap', () => {
    // 2% cap on $10k = $200; a $150 lot now passes where 1% would reject.
    const v = evaluateMultiLegPreTrade({
      accountEquity: 10_000,
      optionBuyingPower: null,
      maxLossPerLot: 150,
      contracts: 1,
      maxLossPctCap: 0.02,
    });
    expect(v.allowed).toBe(true);
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
