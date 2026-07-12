import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { evaluateBacktestGate, type BacktestGateVerdict } from '@trading-app/shared';
import { computeTra1617Gate, computeMetrics, runStrategy, PRIMARY_PARAMS } from './run-tra1617-qqq-pcs-gate.js';

// TRA-1617 — the harness models the TRA-1614 "small-account options income"
// strategy (weekly QQQ 25-wide PCS + call-rescue) on real QQQ 2015-2025 daily bars
// and runs the result through the TRA-540 six-guard battery so the Stage-1 verdict
// is the gate's own, never hand-entered (TRA-527 §3). These tests lock:
//   (1) the metrics are structurally well-formed and span the full regime set,
//   (2) the strategy legitimately FAILS Stage-1 — the quantitative confirmation of
//       the TRA-1614 marketing teardown (NO-TRADE as marketed).
// Assertions are on signs/bands/verdict, not brittle floats.

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '..', 'data', 'qqq.json');

function loadBars(): Candle[] {
  const raw = JSON.parse(readFileSync(DATA, 'utf-8')) as { candles: Candle[] };
  return raw.candles.slice().sort((a, b) => a.timestamp - b.timestamp);
}

// The pinned Yahoo cache must be present for the gate test; skip cleanly if a
// contributor has not warmed it (the runner's fetch step writes it).
const dataPresent = existsSync(DATA);
const d = dataPresent ? describe : describe.skip;

d('TRA-1617 QQQ weekly PCS + rescue Stage-1 gate', () => {
  const bars = dataPresent ? loadBars() : [];
  const res = dataPresent ? computeTra1617Gate(bars) : null!;

  it('runs a full-decade weekly programme (≥ 100 trades, every regime sampled)', () => {
    expect(res.primary.tradeCount).toBeGreaterThanOrEqual(100);
    // The COVID crash and the 2022 bear must both be in the sample — the regimes
    // the single-bull marketing clip never showed.
    const regimes = res.perRegime.map((r) => r.regime);
    expect(regimes).toContain('2022 bear');
    expect(regimes.some((r) => r.includes('COVID'))).toBe(true);
  });

  it('all six overfitting guards are computed and finite', () => {
    for (const [id, g] of Object.entries(res.guards)) {
      expect(Number.isFinite(g.value), `${id} value finite`).toBe(true);
      expect(typeof g.pass).toBe('boolean');
    }
  });

  it('the credit-selling asymmetry is real: high win rate but NEGATIVE expectancy', () => {
    // A premium seller wins most weeks — that is NOT edge. Expectancy net of
    // fills/commissions/rescue is the honest figure, and it is < 0.
    expect(res.primary.winRate).toBeGreaterThan(0.5);
    expect(res.primary.expectancyR).toBeLessThan(0);
    expect(res.primary.sharpe).toBeLessThan(1); // fails the Stage-1 minSharpe = 1.0 outright
  });

  it('the verdict is the gate\'s own re-evaluation (anti-gaming)', () => {
    const gate = evaluateBacktestGate(
      {
        sharpe: res.backtestMetrics.sharpe,
        expectancy: res.backtestMetrics.expectancy,
        profitFactor: res.backtestMetrics.profitFactor,
        maxDrawdown: res.backtestMetrics.maxDrawdown,
        tradeCount: res.backtestMetrics.tradeCount,
      },
      undefined,
      { pass: res.verdict.pass, guards: res.verdict.guards } as BacktestGateVerdict,
    );
    expect(res.gate).toEqual(gate);
  });

  it('FAILS Stage-1 — the quantitative NO-TRADE verdict for the marketed strategy', () => {
    expect(res.verdict.pass).toBe(false);
    expect(res.gate.state).toBe('fail');
    // The failure names at least one failed guard (fail-closed six-guard battery).
    expect(res.gate.failedChecks.join(' ')).toMatch(/six-guard/);
  });

  it('the emitted registration body targets the optimization (six-guard) leg', () => {
    // Ready-to-POST for POST /api/promotion/optimization — registering a FAIL
    // verdict records the NO-GO but flips nothing (Stage-3 sign-off still gates go-live).
    expect(res.verdict.blessedParams).toMatchObject({ strategy: 'qqq_weekly_pcs_rescue' });
    expect(res.backtestMetrics.tradeCount).toBe(res.primary.tradeCount);
  });
});

describe('TRA-1617 metrics primitives', () => {
  it('computeMetrics reports 0 trades cleanly on an empty programme', () => {
    const m = computeMetrics([]);
    expect(m.tradeCount).toBe(0);
    expect(Number.isFinite(m.expectancyR)).toBe(true);
  });

  it('runStrategy is deterministic (same bars + params → identical trade series)', () => {
    if (!dataPresent) return;
    const bars = loadBars();
    const a = runStrategy(bars, PRIMARY_PARAMS);
    const b = runStrategy(bars, PRIMARY_PARAMS);
    expect(a.length).toBe(b.length);
    expect(a.map((t) => t.R)).toEqual(b.map((t) => t.R));
  });
});
