import { describe, it, expect } from 'vitest';
import type { MacroEvent } from '@trading-app/engine';
import {
  evaluateCatalystGate,
  resolveCatalystGateConfig,
  isCatalystGateTarget,
  DEFAULT_SWING_MAX_DAYS,
  DEFAULT_INTRADAY_MAX_DAYS,
  type CatalystGateConfig,
  type CatalystGateReaders,
} from './catalyst-gate.js';

// A fixed point-in-time anchor so every assertion is deterministic; the gate is
// evaluated with an explicit `asOf` and injected readers, so no store warm-up
// and no wall-clock dependency.
const ASOF = Date.UTC(2026, 6, 16, 14, 30); // 2026-07-16T14:30Z

const OBSERVE: CatalystGateConfig = {
  enforce: false,
  macroMeanRev: false,
  swingMaxDays: DEFAULT_SWING_MAX_DAYS,
  intradayMaxDays: DEFAULT_INTRADAY_MAX_DAYS,
};

/** Build readers with per-symbol earnings + optional macro state. */
function readers(opts: {
  earnings?: Record<string, number | null>;
  daysToFomc?: number | null;
  nearEvents?: MacroEvent[];
} = {}): Partial<CatalystGateReaders> {
  return {
    earningsInDays: (sym: string) => opts.earnings?.[sym] ?? null,
    daysToNextFOMC: () => opts.daysToFomc ?? null,
    eventsNearDate: () => opts.nearEvents ?? [],
  };
}

const highEvent: MacroEvent = {
  type: 'CPI', date: '2026-07-16', importance: 'high', title: 'CPI', source: 'fred',
};
const lowEvent: MacroEvent = { ...highEvent, importance: 'low' };

describe('evaluateCatalystGate — earnings proximity (primary rule)', () => {
  it('gates a swing sma200_pullback with earnings inside the 10d window', () => {
    const d = evaluateCatalystGate({
      symbol: 'AAPL', strategy: 'sma200_pullback', asOf: ASOF, config: OBSERVE,
      readers: readers({ earnings: { AAPL: 7 } }),
    });
    expect(d.gated).toBe(true);
    expect(d.rule).toBe('earnings_swing');
    expect(d.thresholdDays).toBe(DEFAULT_SWING_MAX_DAYS);
    expect(d.reason).toMatch(/earnings in 7d/);
  });

  it('is clear for a swing entry with earnings beyond the window', () => {
    const d = evaluateCatalystGate({
      symbol: 'AAPL', strategy: 'sma200_pullback', asOf: ASOF, config: OBSERVE,
      readers: readers({ earnings: { AAPL: 11 } }),
    });
    expect(d.gated).toBe(false);
    expect(d.rule).toBeNull();
    expect(d.reason).toBeNull();
  });

  it('gates exactly at the boundary (earnings == threshold)', () => {
    const d = evaluateCatalystGate({
      symbol: 'AAPL', strategy: 'sma200_pullback', asOf: ASOF, config: OBSERVE,
      readers: readers({ earnings: { AAPL: DEFAULT_SWING_MAX_DAYS } }),
    });
    expect(d.gated).toBe(true);
  });

  it('applies the tight 1d threshold to intraday routers (ORB/BB-fade/Ichimoku)', () => {
    for (const strategy of ['orb_breakout', 'bb_fade', 'ichimoku'] as const) {
      const gatedNext = evaluateCatalystGate({
        symbol: 'MSFT', strategy, asOf: ASOF, config: OBSERVE,
        readers: readers({ earnings: { MSFT: 1 } }),
      });
      expect(gatedNext.gated).toBe(true);
      expect(gatedNext.rule).toBe('earnings_intraday');
      expect(gatedNext.thresholdDays).toBe(DEFAULT_INTRADAY_MAX_DAYS);

      const clearAt2 = evaluateCatalystGate({
        symbol: 'MSFT', strategy, asOf: ASOF, config: OBSERVE,
        readers: readers({ earnings: { MSFT: 2 } }),
      });
      expect(clearAt2.gated).toBe(false);
    }
  });

  it('is clear when the symbol is uncovered (earnings === null)', () => {
    const d = evaluateCatalystGate({
      symbol: 'NOCOV', strategy: 'sma200_pullback', asOf: ASOF, config: OBSERVE,
      readers: readers({ earnings: {} }),
    });
    expect(d.gated).toBe(false);
    expect(d.earningsInDays).toBeNull();
  });

  it('point-in-time: the same symbol gates before earnings and clears after (asOf sweep)', () => {
    // Reader models a real earnings date: days-to-earnings shrinks as asOf moves
    // toward it, then goes null (past) after it. Two asOf reads, one predicate.
    const earningsAt = Date.UTC(2026, 6, 20); // 2026-07-20
    const dayReader: Partial<CatalystGateReaders> = {
      earningsInDays: (_sym, asOf) => {
        const days = Math.floor((earningsAt - asOf) / 86_400_000);
        return days >= 0 ? days : null;
      },
    };
    const before = evaluateCatalystGate({
      symbol: 'AAPL', strategy: 'sma200_pullback', asOf: Date.UTC(2026, 6, 16), config: OBSERVE,
      readers: dayReader,
    });
    const after = evaluateCatalystGate({
      symbol: 'AAPL', strategy: 'sma200_pullback', asOf: Date.UTC(2026, 6, 21), config: OBSERVE,
      readers: dayReader,
    });
    expect(before.gated).toBe(true);
    expect(before.earningsInDays).toBe(4);
    expect(after.gated).toBe(false);
    expect(after.earningsInDays).toBeNull();
  });
});

describe('evaluateCatalystGate — macro mean-reversion suppression (optional rule)', () => {
  const withMacro: CatalystGateConfig = { ...OBSERVE, macroMeanRev: true };

  it('is inert when the macro flag is off, even with FOMC tomorrow', () => {
    const d = evaluateCatalystGate({
      symbol: 'SPY', strategy: 'bb_fade', asOf: ASOF, config: OBSERVE,
      readers: readers({ daysToFomc: 1 }),
    });
    expect(d.gated).toBe(false);
  });

  it('suppresses a bb_fade mean-reversion entry when FOMC is <= 1 day out', () => {
    const d = evaluateCatalystGate({
      symbol: 'SPY', strategy: 'bb_fade', asOf: ASOF, config: withMacro,
      readers: readers({ daysToFomc: 1 }),
    });
    expect(d.gated).toBe(true);
    expect(d.rule).toBe('macro_meanrev');
    expect(d.reason).toMatch(/FOMC/);
  });

  it('suppresses a mean-reversion entry near a high-importance event', () => {
    const d = evaluateCatalystGate({
      symbol: 'SPY', strategy: 'sma200_pullback', asOf: ASOF, config: withMacro,
      readers: readers({ earnings: { SPY: 30 }, nearEvents: [highEvent] }),
    });
    expect(d.gated).toBe(true);
    expect(d.rule).toBe('macro_meanrev');
  });

  it('ignores low-importance macro events', () => {
    const d = evaluateCatalystGate({
      symbol: 'SPY', strategy: 'bb_fade', asOf: ASOF, config: withMacro,
      readers: readers({ nearEvents: [lowEvent] }),
    });
    expect(d.gated).toBe(false);
  });

  it('does NOT apply the macro rule to trend/breakout entries (ORB, Ichimoku)', () => {
    for (const strategy of ['orb_breakout', 'ichimoku'] as const) {
      const d = evaluateCatalystGate({
        symbol: 'SPY', strategy, asOf: ASOF, config: withMacro,
        readers: readers({ earnings: { SPY: 30 }, daysToFomc: 0, nearEvents: [highEvent] }),
      });
      expect(d.gated).toBe(false);
    }
  });

  it('earnings rule takes precedence over the macro rule when both fire', () => {
    const d = evaluateCatalystGate({
      symbol: 'SPY', strategy: 'sma200_pullback', asOf: ASOF, config: withMacro,
      readers: readers({ earnings: { SPY: 3 }, daysToFomc: 0, nearEvents: [highEvent] }),
    });
    expect(d.gated).toBe(true);
    expect(d.rule).toBe('earnings_swing');
  });
});

describe('resolveCatalystGateConfig + targeting', () => {
  it('defaults to observe/off with the plan thresholds', () => {
    const c = resolveCatalystGateConfig({});
    expect(c).toEqual({
      enforce: false,
      macroMeanRev: false,
      swingMaxDays: DEFAULT_SWING_MAX_DAYS,
      intradayMaxDays: DEFAULT_INTRADAY_MAX_DAYS,
    });
  });

  it('reads flags + threshold overrides from the environment', () => {
    const c = resolveCatalystGateConfig({
      ENABLE_CATALYST_EARNINGS_GATE: '1',
      ENABLE_CATALYST_MACRO_MEANREV_SUPPRESS: 'true',
      CATALYST_EARNINGS_SWING_MAX_DAYS: '14',
      CATALYST_EARNINGS_INTRADAY_MAX_DAYS: '2',
    });
    expect(c).toEqual({ enforce: true, macroMeanRev: true, swingMaxDays: 14, intradayMaxDays: 2 });
  });

  it('falls back to defaults on a non-numeric / negative threshold override', () => {
    const c = resolveCatalystGateConfig({
      CATALYST_EARNINGS_SWING_MAX_DAYS: 'abc',
      CATALYST_EARNINGS_INTRADAY_MAX_DAYS: '-3',
    });
    expect(c.swingMaxDays).toBe(DEFAULT_SWING_MAX_DAYS);
    expect(c.intradayMaxDays).toBe(DEFAULT_INTRADAY_MAX_DAYS);
  });

  it('targets only the four equity entry strategies', () => {
    expect(isCatalystGateTarget('sma200_pullback')).toBe(true);
    expect(isCatalystGateTarget('orb_breakout')).toBe(true);
    expect(isCatalystGateTarget('bb_fade')).toBe(true);
    expect(isCatalystGateTarget('ichimoku')).toBe(true);
    expect(isCatalystGateTarget('otm_mispricing')).toBe(false);
    expect(isCatalystGateTarget('dca')).toBe(false);
  });

  it('carries enforce through to the decision without acting on it (D1 shadow)', () => {
    const d = evaluateCatalystGate({
      symbol: 'AAPL', strategy: 'sma200_pullback', asOf: ASOF,
      config: { ...OBSERVE, enforce: true },
      readers: readers({ earnings: { AAPL: 3 } }),
    });
    expect(d.enforce).toBe(true);
    expect(d.gated).toBe(true);
  });
});
