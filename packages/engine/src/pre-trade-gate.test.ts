import { describe, it, expect } from 'vitest';
import {
  evaluatePreTradeGate,
  DEFAULT_PRE_TRADE_GATE_CONFIG,
  type PreTradeGateInput,
} from './pre-trade-gate.js';

// A candidate that clears ALL four rules, used as the base each rejection test
// perturbs ONE field of. Long entry 100, ATR 1 → stop distance k*ATR = 1.5 →
// stop 98.5; target 102 → reward 2.0 → R:R 2.0/1.5 = 1.33... wait, tune below.
//
// We want R:R >= 1.5 with atrStopK 1.5 (stop distance 1.5): reward must be >= 2.25.
// Target 103 → reward 3.0 → R:R 2.0. mtfTrend +1 (up) aligns with long. rvol 1.5.
function fullPass(): PreTradeGateInput {
  return { entry: 100, direction: 'long', atr: 1, mtfTrend: 1, rvol: 1.5, target: 103 };
}

describe('evaluatePreTradeGate — full pass', () => {
  it('passes when every rule is satisfied and reports derived stop/R:R', () => {
    const r = evaluatePreTradeGate(fullPass());
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.stopDistance).toBeCloseTo(1.5, 10); // k(1.5) * ATR(1)
    expect(r.stopPrice).toBeCloseTo(98.5, 10); // long: entry - stopDistance
    expect(r.rewardRisk).toBeCloseTo(2.0, 10); // (103-100)/1.5
    expect(r.config).toEqual(DEFAULT_PRE_TRADE_GATE_CONFIG);
  });

  it('passes a symmetric short candidate', () => {
    const r = evaluatePreTradeGate({
      entry: 100,
      direction: 'short',
      atr: 1,
      mtfTrend: -1, // down trend aligns with short
      rvol: 1.5,
      target: 97, // reward (100-97)=3 → R:R 2.0
    });
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.stopPrice).toBeCloseTo(101.5, 10); // short: entry + stopDistance
    expect(r.rewardRisk).toBeCloseTo(2.0, 10);
  });

  it('passes exactly at the R:R boundary (1.5)', () => {
    // stop distance 1.5, need reward exactly 2.25 → target 102.25
    const r = evaluatePreTradeGate({ ...fullPass(), target: 102.25 });
    expect(r.rewardRisk).toBeCloseTo(1.5, 10);
    expect(r.pass).toBe(true);
  });
});

describe('evaluatePreTradeGate — MTF_MISALIGNED', () => {
  it('rejects a long against a down higher-TF trend', () => {
    const r = evaluatePreTradeGate({ ...fullPass(), mtfTrend: -1 });
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('MTF_MISALIGNED');
  });

  it('rejects a short against an up higher-TF trend', () => {
    const r = evaluatePreTradeGate({
      entry: 100,
      direction: 'short',
      atr: 1,
      mtfTrend: 1,
      rvol: 1.5,
      target: 97,
    });
    expect(r.reasons).toContain('MTF_MISALIGNED');
  });

  it('rejects a neutral (0) higher-TF trend for both directions', () => {
    expect(evaluatePreTradeGate({ ...fullPass(), mtfTrend: 0 }).reasons).toContain(
      'MTF_MISALIGNED',
    );
  });
});

describe('evaluatePreTradeGate — RVOL_BELOW_THRESHOLD', () => {
  it('rejects rvol below the default 1.0 floor', () => {
    const r = evaluatePreTradeGate({ ...fullPass(), rvol: 0.9 });
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('RVOL_BELOW_THRESHOLD');
  });

  it('passes rvol exactly at the floor', () => {
    const r = evaluatePreTradeGate({ ...fullPass(), rvol: 1.0 });
    expect(r.reasons).not.toContain('RVOL_BELOW_THRESHOLD');
  });

  it('honours a raised rvol cut (QuantTrader 1.5 promotion cut)', () => {
    const cfg = { ...DEFAULT_PRE_TRADE_GATE_CONFIG, minRvol: 1.5 };
    expect(evaluatePreTradeGate({ ...fullPass(), rvol: 1.4 }, cfg).reasons).toContain(
      'RVOL_BELOW_THRESHOLD',
    );
    expect(evaluatePreTradeGate({ ...fullPass(), rvol: 1.5 }, cfg).reasons).not.toContain(
      'RVOL_BELOW_THRESHOLD',
    );
  });
});

describe('evaluatePreTradeGate — RR_BELOW_MIN', () => {
  it('rejects a target too close for reward:risk >= 1.5', () => {
    // stop distance 1.5, target 101 → reward 1.0 → R:R 0.67
    const r = evaluatePreTradeGate({ ...fullPass(), target: 101 });
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('RR_BELOW_MIN');
    expect(r.rewardRisk).toBeCloseTo(1 / 1.5, 10);
  });

  it('rejects (RR) a target on the wrong side of a long entry', () => {
    const r = evaluatePreTradeGate({ ...fullPass(), target: 99 });
    expect(r.reasons).toContain('RR_BELOW_MIN');
    expect(r.rewardRisk).toBeLessThan(0); // reward (99-100) is negative
  });
});

describe('evaluatePreTradeGate — ATR_STOP_MISSING', () => {
  it('rejects a zero ATR and reports RR uncomputable', () => {
    const r = evaluatePreTradeGate({ ...fullPass(), atr: 0 });
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('ATR_STOP_MISSING');
    // No stop basis → R:R also fails, and derived fields are null.
    expect(r.reasons).toContain('RR_BELOW_MIN');
    expect(r.stopDistance).toBeNull();
    expect(r.stopPrice).toBeNull();
    expect(r.rewardRisk).toBeNull();
  });

  it('rejects a non-finite / negative ATR', () => {
    expect(evaluatePreTradeGate({ ...fullPass(), atr: Number.NaN }).reasons).toContain(
      'ATR_STOP_MISSING',
    );
    expect(evaluatePreTradeGate({ ...fullPass(), atr: -1 }).reasons).toContain(
      'ATR_STOP_MISSING',
    );
  });
});

describe('evaluatePreTradeGate — multiple failures accumulate', () => {
  it('lists every broken rule, not just the first', () => {
    const r = evaluatePreTradeGate({
      entry: 100,
      direction: 'long',
      atr: 0, // ATR_STOP_MISSING (+ RR uncomputable)
      mtfTrend: -1, // MTF_MISALIGNED
      rvol: 0.5, // RVOL_BELOW_THRESHOLD
      target: 100.1,
    });
    expect(r.pass).toBe(false);
    expect(new Set(r.reasons)).toEqual(
      new Set(['ATR_STOP_MISSING', 'MTF_MISALIGNED', 'RVOL_BELOW_THRESHOLD', 'RR_BELOW_MIN']),
    );
  });

  it('honours a raised R:R cut via config', () => {
    const cfg = { ...DEFAULT_PRE_TRADE_GATE_CONFIG, minRewardRisk: 3.0 };
    // R:R 2.0 passes default but fails a 3.0 cut.
    expect(evaluatePreTradeGate(fullPass(), cfg).reasons).toContain('RR_BELOW_MIN');
  });

  it('honours a custom ATR-stop multiple k', () => {
    const cfg = { ...DEFAULT_PRE_TRADE_GATE_CONFIG, atrStopK: 3.0 };
    // stop distance now 3.0; reward (103-100)=3 → R:R 1.0 → fails.
    const r = evaluatePreTradeGate(fullPass(), cfg);
    expect(r.stopDistance).toBeCloseTo(3.0, 10);
    expect(r.rewardRisk).toBeCloseTo(1.0, 10);
    expect(r.reasons).toContain('RR_BELOW_MIN');
  });
});
