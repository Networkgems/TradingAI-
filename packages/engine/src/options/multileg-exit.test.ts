import { describe, it, expect } from 'vitest';
import {
  evaluateMultiLegExit,
  buildOccSymbol,
  DEFAULT_MULTILEG_EXIT_PARAMS,
  type MultiLegExitInput,
} from './multileg-exit.js';

// TRA-1418 (TRA-1417 build — QuantTrader spec comment d481a38d). The exit policy
// classifies by netUsd sign, takes profit at 50% of max profit, cuts credits at
// 2× credit (clamped to max loss) and debits at 50% of debit, and time-stops at
// 21 DTE (floor 1 for weeklies). openPnl = markNetNow + netUsd.

const base: MultiLegExitInput = {
  netUsd: 180,
  maxProfitUsd: 180,
  maxLossUsd: 320,
  markNetNow: -180, // baseline = -netUsd → openPnl 0
  dte: 30,
  entryDte: 45,
  barsHeld: 5,
};

describe('DEFAULT_MULTILEG_EXIT_PARAMS matches the QuantTrader spec block', () => {
  it('exposes the tastytrade-adapted v1 defaults', () => {
    expect(DEFAULT_MULTILEG_EXIT_PARAMS).toEqual({
      tpCapture: 0.5,
      slCreditMult: 2.0,
      slDebitFrac: 0.5,
      dteStop: 21,
      dteStopFloor: 1,
      minHoldBars: 1,
    });
  });
});

describe('evaluateMultiLegExit — CREDIT structures (netUsd > 0)', () => {
  it('worked example: bull put credit decays to +53% of credit → take-profit WIN', () => {
    // Spec worked check: sell 2.20 / buy 0.40 → netUsd +180; decays to 1.00/0.15.
    // markNet(now) = (-1.00 + 0.15) * 100 = -85; openPnl = -85 + 180 = +95 = 53%.
    // 52.8% capture ≥ 0.50 → WIN clamped to max profit.
    const markNetNow = (-1.0 + 0.15) * 100;
    const d = evaluateMultiLegExit({ ...base, markNetNow });
    expect(d.openPnlUsd).toBeCloseTo(95, 6);
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe('tp_capture');
    expect(d.realizedPnlUsd).toBeCloseTo(95, 6);
  });

  it('credit just below the 50% capture line → HOLD', () => {
    // openPnl = +80 on 180 max profit = 44% < 0.50 → HOLD.
    const d = evaluateMultiLegExit({ ...base, markNetNow: -100 });
    expect(d.openPnlUsd).toBeCloseTo(80, 6);
    expect(d.shouldExit).toBe(false);
  });

  it('credit stop at 2× credit loss → LOSS clamped to maxLoss', () => {
    // openPnl <= -2 * 180 = -360, but clamp to -maxLoss (-320).
    // markNetNow such that openPnl = -400 → markNetNow = -580.
    const d = evaluateMultiLegExit({ ...base, markNetNow: -580 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe('sl_credit');
    expect(d.realizedPnlUsd).toBe(-320); // clamped to defined risk
  });

  it('credit just above the 2× stop and below TP → HOLD', () => {
    // openPnl = -300 (> -360 stop, < +90 TP) → no rule fires.
    const d = evaluateMultiLegExit({ ...base, markNetNow: -480 });
    expect(d.shouldExit).toBe(false);
    expect(d.reason).toBe(null);
  });
});

describe('evaluateMultiLegExit — DEBIT structures (netUsd < 0)', () => {
  const debit: MultiLegExitInput = {
    netUsd: -200, // paid 200 debit
    maxProfitUsd: 300,
    maxLossUsd: 200,
    markNetNow: 200, // baseline = -netUsd → openPnl 0
    dte: 30,
    entryDte: 45,
    barsHeld: 5,
  };

  it('debit take-profit at ≥50% capture → WIN', () => {
    // openPnl = +150 on 300 max profit = 50% → WIN.
    const d = evaluateMultiLegExit({ ...debit, markNetNow: 350 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe('tp_capture');
    expect(d.realizedPnlUsd).toBeCloseTo(150, 6);
  });

  it('debit stop at 50% of debit paid → LOSS', () => {
    // openPnl <= -0.5 * 200 = -100 → LOSS. markNetNow = 90 → openPnl = -110.
    const d = evaluateMultiLegExit({ ...debit, markNetNow: 90 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe('sl_debit');
    expect(d.realizedPnlUsd).toBeCloseTo(-110, 6);
  });

  it('debit loss beyond max loss clamps to -maxLoss', () => {
    const d = evaluateMultiLegExit({ ...debit, markNetNow: -50 });
    expect(d.realizedPnlUsd).toBe(-200);
  });
});

describe('evaluateMultiLegExit — time-stop', () => {
  it('closes at ≤21 DTE and resolves WIN/LOSS by open-P&L sign', () => {
    const d = evaluateMultiLegExit({ ...base, markNetNow: -140, dte: 21 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe('dte_time_stop');
    expect(d.realizedPnlUsd).toBeCloseTo(40, 6); // openPnl = -140 + 180
  });

  it('weekly (entry DTE ≤ 21) uses the floor of 1 so it still resolves', () => {
    const weekly = { ...base, entryDte: 5, dte: 3 };
    // dte 3 > floor 1 → not yet stopped.
    expect(evaluateMultiLegExit(weekly).shouldExit).toBe(false);
    // dte 1 ≤ floor 1 → stops.
    const d = evaluateMultiLegExit({ ...weekly, dte: 1, markNetNow: -170 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe('dte_time_stop');
  });

  it('expiry (DTE ≤ 0) settles at intrinsic with the expiry_settle reason', () => {
    const d = evaluateMultiLegExit({ ...base, dte: 0, markNetNow: -180 });
    expect(d.shouldExit).toBe(true);
    expect(d.reason).toBe('expiry_settle');
    expect(d.realizedPnlUsd).toBe(0);
  });
});

describe('evaluateMultiLegExit — guardrails', () => {
  it('min_hold_bars blocks a same-tick scratch (barsHeld 0)', () => {
    // Even a TP-worthy mark HOLDs on the entry tick.
    const d = evaluateMultiLegExit({ ...base, markNetNow: -85, barsHeld: 0 });
    expect(d.shouldExit).toBe(false);
    expect(d.openPnlUsd).toBeCloseTo(95, 6);
  });

  it('degenerate max profit / loss → HOLD (no spurious close)', () => {
    expect(evaluateMultiLegExit({ ...base, maxProfitUsd: 0 }).shouldExit).toBe(false);
    expect(evaluateMultiLegExit({ ...base, maxLossUsd: -1 }).shouldExit).toBe(false);
    expect(evaluateMultiLegExit({ ...base, markNetNow: NaN }).shouldExit).toBe(false);
  });
});

describe('buildOccSymbol', () => {
  it('reconstructs the OCC symbol from (underlying, expiration, strike, type)', () => {
    expect(buildOccSymbol('AAPL', '2026-07-17', 170, 'call')).toBe('AAPL260717C00170000');
    expect(buildOccSymbol('AAPL', '2026-07-17', 172.5, 'put')).toBe('AAPL260717P00172500');
    expect(buildOccSymbol('spy', '2024-03-15', 500, 'put')).toBe('SPY240315P00500000');
  });

  it('returns null for a malformed expiration or non-positive strike', () => {
    expect(buildOccSymbol('AAPL', '07/17/2026', 170, 'call')).toBe(null);
    expect(buildOccSymbol('AAPL', '2026-07-17', 0, 'call')).toBe(null);
    expect(buildOccSymbol('AAPL', '2026-07-17', -5, 'call')).toBe(null);
  });
});
