import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { evaluateBacktestGate, type BacktestGateVerdict } from '@trading-app/shared';
import { computeTra1616Gate, computeMetrics, runStrategy, PRIMARY_PARAMS } from './run-tra1616-xsp-pcs-gate.js';

// TRA-1616 — the harness models the TRA-1613 "$100 New Options Strategy" (XSP
// 1-wide ATM put-credit-spread + 20-day-SMA regime filter) per the machine-testable
// TRA-1615 spec, prices it on real SPX 2015-2025 daily bars (÷10 → XSP terms, since
// XSP cash-settles to SPX/10), and runs the result through the TRA-540 six-guard
// battery so the Stage-1 verdict is the gate's own, never hand-entered (TRA-527 §3).
// These tests lock:
//   (1) the metrics are structurally well-formed and span the crisis regimes,
//   (2) the defined-risk spread's loss is bounded at ~1R (no >1R artifacts),
//   (3) the strategy legitimately FAILS Stage-1 — the quantitative confirmation of
//       the TRA-1613 NO-TRADE-as-is teardown.
// Assertions are on signs/bands/verdict, not brittle floats.

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, '..', 'data', '^gspc.json');

/** Load cached SPX daily bars and scale OHLC ÷10 into XSP terms (mirror of loadXspBars). */
function loadBars(): Candle[] {
  const raw = JSON.parse(readFileSync(DATA, 'utf-8')) as { candles: Candle[] };
  return raw.candles
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((c) => ({ symbol: 'XSP', timestamp: c.timestamp, open: c.open / 10, high: c.high / 10, low: c.low / 10, close: c.close / 10, volume: c.volume }));
}

// The pinned Yahoo cache must be present for the gate test; skip cleanly if a
// contributor has not warmed it (the runner's fetch step writes it).
const dataPresent = existsSync(DATA);
const d = dataPresent ? describe : describe.skip;

d('TRA-1616 XSP ATM PCS + 20-SMA Stage-1 gate', () => {
  const bars = dataPresent ? loadBars() : [];
  const res = dataPresent ? computeTra1616Gate(bars) : null!;

  it('runs a full-decade programme with the required crisis regimes sampled', () => {
    // Regime-gated entries yield a modest count (the spec's tiny-sample critique);
    // the crisis windows the single-bull marketing clip never showed must be present.
    expect(res.primary.tradeCount).toBeGreaterThan(50);
    const regimes = res.perRegime.map((r) => r.regime);
    expect(regimes).toContain('2022 bear');
    expect(regimes.some((r) => r.includes('COVID') || r.includes('Q4-2018') || r.includes('tariff') || r.includes('VIX'))).toBe(true);
  });

  it('all six overfitting guards are computed and finite', () => {
    for (const [id, g] of Object.entries(res.guards)) {
      expect(Number.isFinite(g.value), `${id} value finite`).toBe(true);
      expect(typeof g.pass).toBe('boolean');
    }
  });

  it('the defined-risk loss is bounded at ~1R — no >1R modeling artifacts', () => {
    // A 1-wide vertical's max loss is the width; a rational operator never pays MORE
    // than that to close, so realized R must not run below ~−1 (a small commission tail).
    expect(res.primary.tailLoss.worstR).toBeGreaterThan(-1.15);
  });

  it('the credit-selling asymmetry is real: NEGATIVE expectancy net of realistic fills', () => {
    // Crossing two bid/asks on an ATM 1-wide vertical eats most of the mid credit
    // (the leg the video's mid-price math hand-waves). Expectancy net of that is < 0.
    expect(res.primary.expectancyR).toBeLessThan(0);
    expect(res.primary.sharpe).toBeLessThan(1); // fails the Stage-1 minSharpe = 1.0 outright
    expect(res.primary.profitFactor).toBeLessThan(1.3); // fails minProfitFactor
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
    expect(res.gate.failedChecks.join(' ')).toMatch(/six-guard/);
  });

  it('the emitted registration body targets the optimization (six-guard) leg', () => {
    // Ready-to-POST for POST /api/promotion/optimization — registering a FAIL
    // verdict records the NO-GO but flips nothing (Stage-3 sign-off still gates go-live).
    expect(res.verdict.blessedParams).toMatchObject({ strategy: 'xsp_atm_pcs_sma20' });
    expect(res.backtestMetrics.tradeCount).toBe(res.primary.tradeCount);
  });

  it('runs the full 9-trial DTE×strike-offset grid for the DSR/PBO guards', () => {
    expect(res.trials.length).toBe(9);
    for (const t of res.trials) expect(Number.isFinite(t.expectancyR)).toBe(true);
  });
});

describe('TRA-1616 metrics primitives', () => {
  it('computeMetrics reports 0 trades cleanly on an empty programme', () => {
    const m = computeMetrics([], []);
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
