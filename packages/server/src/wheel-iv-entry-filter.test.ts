import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateWheelIvEntry,
  resolveWheelIvFilterConfig,
  recordWheelIvDecision,
  clearWheelIvDecisions,
  summarizeWheelIvEntries,
  DEFAULT_WHEEL_IV_FILTER_CONFIG,
  type WheelIvEntryInput,
} from './wheel-iv-entry-filter.js';

function input(over: Partial<WheelIvEntryInput> = {}): WheelIvEntryInput {
  return {
    symbol: 'SPY',
    ivRank: 55,
    ivPercentile: 60,
    markKind: 'mid',
    hasBinaryEventInLife: null,
    ...over,
  };
}

describe('evaluateWheelIvEntry — band logic', () => {
  it('BLOCKS below the floor (IVP < 30)', () => {
    const d = evaluateWheelIvEntry(input({ ivPercentile: 20 }));
    expect(d.action).toBe('skip');
    expect(d.band).toBe('block');
    expect(d.sizeMultiplier).toBe(0);
    expect(d.reason).toBe('ivp_below_floor');
  });

  it('sizes down in the MARGINAL band (30 ≤ IVP < 50)', () => {
    const d = evaluateWheelIvEntry(input({ ivPercentile: 40 }));
    expect(d.action).toBe('enter_marginal');
    expect(d.band).toBe('marginal');
    expect(d.sizeMultiplier).toBe(DEFAULT_WHEEL_IV_FILTER_CONFIG.marginalSizeMultiplier);
  });

  it('enters full size in the PREFERRED band (50 ≤ IVP ≤ 90)', () => {
    const d = evaluateWheelIvEntry(input({ ivPercentile: 70 }));
    expect(d.action).toBe('enter');
    expect(d.band).toBe('preferred');
    expect(d.sizeMultiplier).toBe(1);
  });

  it('the block/preferred boundaries are inclusive of preferred, exclusive of block', () => {
    expect(evaluateWheelIvEntry(input({ ivPercentile: 30 })).band).toBe('marginal'); // 30 is NOT blocked
    expect(evaluateWheelIvEntry(input({ ivPercentile: 29.99 })).band).toBe('block');
    expect(evaluateWheelIvEntry(input({ ivPercentile: 50 })).band).toBe('preferred');
    expect(evaluateWheelIvEntry(input({ ivPercentile: 49.99 })).band).toBe('marginal');
  });
});

describe('evaluateWheelIvEntry — EXTREME band (IVP > 90) catalyst check', () => {
  it('BLOCKS an extreme-IVP sell when an unhedged binary event sits inside the option life', () => {
    const d = evaluateWheelIvEntry(input({ ivPercentile: 95, hasBinaryEventInLife: true }));
    expect(d.action).toBe('skip');
    expect(d.band).toBe('extreme');
    expect(d.requiresCatalystCheck).toBe(true);
    expect(d.catalystClear).toBe(false);
    expect(d.reason).toBe('ivp_extreme_binary_event_block');
  });

  it('ALLOWS an extreme-IVP sell when the catalyst check is clear', () => {
    const d = evaluateWheelIvEntry(input({ ivPercentile: 95, hasBinaryEventInLife: false }));
    expect(d.action).toBe('enter');
    expect(d.requiresCatalystCheck).toBe(true);
    expect(d.catalystClear).toBe(true);
  });

  it('conservatively BLOCKS an extreme-IVP sell when the catalyst check is unavailable', () => {
    const d = evaluateWheelIvEntry(input({ ivPercentile: 95, hasBinaryEventInLife: null }));
    expect(d.action).toBe('skip');
    expect(d.requiresCatalystCheck).toBe(true);
    expect(d.catalystClear).toBeNull();
    expect(d.reason).toBe('ivp_extreme_catalyst_unknown');
  });
});

describe('evaluateWheelIvEntry — fail-loud on a bad mark', () => {
  it('SKIPS with markStale on a last-trade mark', () => {
    const d = evaluateWheelIvEntry(input({ markKind: 'last_trade', ivPercentile: 70 }));
    expect(d.action).toBe('skip');
    expect(d.markStale).toBe(true);
    expect(d.reason).toBe('stale_or_last_trade_mark');
  });

  it('SKIPS with markStale on a stale mark even with a "good" percentile', () => {
    const d = evaluateWheelIvEntry(input({ markKind: 'stale', ivPercentile: 80 }));
    expect(d.action).toBe('skip');
    expect(d.markStale).toBe(true);
  });

  it('SKIPS on a thin store (null percentile) as an honest unknown', () => {
    const d = evaluateWheelIvEntry(input({ ivPercentile: null }));
    expect(d.action).toBe('skip');
    expect(d.band).toBe('unknown');
    expect(d.reason).toBe('insufficient_iv_history');
    expect(d.markStale).toBe(false);
  });
});

describe('resolveWheelIvFilterConfig', () => {
  it('falls back to defaults on an unset env', () => {
    expect(resolveWheelIvFilterConfig({})).toEqual(DEFAULT_WHEEL_IV_FILTER_CONFIG);
  });

  it('applies valid overrides', () => {
    const c = resolveWheelIvFilterConfig({
      WHEEL_IV_FILTER_BLOCK_BELOW_PERCENTILE: '25',
      WHEEL_IV_FILTER_PREFERRED_PERCENTILE: '55',
      WHEEL_IV_FILTER_CATALYST_PERCENTILE: '85',
      WHEEL_IV_FILTER_MARGINAL_SIZE_MULT: '0.33',
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({
      blockBelowPercentile: 25,
      preferredPercentile: 55,
      catalystCheckAbovePercentile: 85,
      marginalSizeMultiplier: 0.33,
    });
  });

  it('reverts a crossed band triplet to defaults as a unit', () => {
    const c = resolveWheelIvFilterConfig({
      WHEEL_IV_FILTER_BLOCK_BELOW_PERCENTILE: '60', // block ≥ preferred → invalid
      WHEEL_IV_FILTER_PREFERRED_PERCENTILE: '50',
    } as NodeJS.ProcessEnv);
    expect(c.blockBelowPercentile).toBe(DEFAULT_WHEEL_IV_FILTER_CONFIG.blockBelowPercentile);
    expect(c.preferredPercentile).toBe(DEFAULT_WHEEL_IV_FILTER_CONFIG.preferredPercentile);
    expect(c.catalystCheckAbovePercentile).toBe(DEFAULT_WHEEL_IV_FILTER_CONFIG.catalystCheckAbovePercentile);
  });

  it('rejects out-of-range values (falls back per knob)', () => {
    const c = resolveWheelIvFilterConfig({
      WHEEL_IV_FILTER_MARGINAL_SIZE_MULT: '1.5', // > 1
      WHEEL_IV_FILTER_BLOCK_BELOW_PERCENTILE: '-5', // < 0
    } as NodeJS.ProcessEnv);
    expect(c.marginalSizeMultiplier).toBe(DEFAULT_WHEEL_IV_FILTER_CONFIG.marginalSizeMultiplier);
    expect(c.blockBelowPercentile).toBe(DEFAULT_WHEEL_IV_FILTER_CONFIG.blockBelowPercentile);
  });
});

describe('shadow ledger — entered-vs-skipped by IVP decile', () => {
  beforeEach(() => clearWheelIvDecisions());

  it('records every idea and buckets by decile', () => {
    const now = 1_000_000;
    recordWheelIvDecision('SPY', 'csp', evaluateWheelIvEntry(input({ ivPercentile: 15 })), now); // block, decile 1
    recordWheelIvDecision('QQQ', 'csp', evaluateWheelIvEntry(input({ ivPercentile: 40 })), now); // marginal, decile 4
    recordWheelIvDecision('AAPL', 'csp', evaluateWheelIvEntry(input({ ivPercentile: 70 })), now); // preferred, decile 7
    recordWheelIvDecision('MSFT', 'cc', evaluateWheelIvEntry(input({ ivPercentile: null })), now); // unknown

    const s = summarizeWheelIvEntries(false, now);
    expect(s.total).toBe(4);
    expect(s.entered).toBe(2); // marginal + preferred
    expect(s.marginal).toBe(1);
    expect(s.skipped).toBe(2); // block + unknown

    const d7 = s.byDecile.find((b) => b.decile === 7);
    expect(d7?.entered).toBe(1);
    const d1 = s.byDecile.find((b) => b.decile === 1);
    expect(d1?.skipped).toBe(1);
    const unknown = s.byDecile.find((b) => b.decile === -1);
    expect(unknown?.skipped).toBe(1);
  });

  it('counts stale-mark skips as a data-quality signal', () => {
    const now = 2_000_000;
    recordWheelIvDecision('SPY', 'csp', evaluateWheelIvEntry(input({ markKind: 'stale', ivPercentile: 70 })), now);
    const s = summarizeWheelIvEntries(true, now);
    expect(s.staleMarkSkips).toBe(1);
    expect(s.enabled).toBe(true);
  });

  it('sweeps entries past the TTL', () => {
    recordWheelIvDecision('SPY', 'csp', evaluateWheelIvEntry(input({ ivPercentile: 70 })), 0);
    const s = summarizeWheelIvEntries(false, 25 * 60 * 60_000); // > 24h later
    expect(s.total).toBe(0);
  });
});
