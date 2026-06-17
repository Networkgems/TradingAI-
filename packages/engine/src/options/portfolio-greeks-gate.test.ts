import { describe, it, expect } from 'vitest';
import {
  evaluatePortfolioGreeksGate,
  DEFAULT_PORTFOLIO_GREEKS_GATE,
  type PortfolioGreeksGateInput,
} from './portfolio-greeks-gate.js';

// A flat (empty) book with a small, well-behaved proposed structure that clears
// every default threshold. Individual tests perturb one field to drive a single
// reject path so the surfaced reason is unambiguous.
function baseInput(over: Partial<PortfolioGreeksGateInput> = {}): PortfolioGreeksGateInput {
  return {
    currentNetDelta: 0,
    currentNetVega: 0,
    // A diversified ~$10k book in OTHER names so a $400 add to a fresh name is
    // ~3.8% concentration — well inside the cap (an add on a truly empty book
    // would always be 100% of the book and could never clear concentration).
    currentBookNotional: 10_000,
    currentNameNotional: 0,
    currentOpenPositions: 0,
    tradeNetDelta: 50,
    tradeNetVega: -120, // short-premium structure: net short vega
    tradeMaxLossUsd: 400,
    tradeNotional: 400,
    ...over,
  };
}

describe('evaluatePortfolioGreeksGate', () => {
  it('accepts a small structure onto a flat book and projects post-trade exposures', () => {
    const v = evaluatePortfolioGreeksGate(baseInput());
    expect(v.allowed).toBe(true);
    if (v.allowed) {
      expect(v.postNetDelta).toBe(50);
      expect(v.postNetVega).toBe(-120);
      expect(v.postNameConcentrationPct).toBeCloseTo(400 / 10_400, 6);
      expect(v.postOpenPositions).toBe(1);
    }
  });

  it('rejects when post-trade net delta breaches the band (stacking onto an existing book)', () => {
    const v = evaluatePortfolioGreeksGate(
      baseInput({ currentNetDelta: 480, tradeNetDelta: 50 }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('net delta');
  });

  it('bounds SHORT vega: rejects when a short-premium add pushes net vega past the cap', () => {
    const v = evaluatePortfolioGreeksGate(
      baseInput({ currentNetVega: -700, tradeNetVega: -120 }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('net vega');
  });

  it('bounds LONG vega too (two-sided cap)', () => {
    const v = evaluatePortfolioGreeksGate(
      baseInput({ currentNetVega: 700, tradeNetVega: 120 }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('net vega');
  });

  it('rejects a trade whose own max loss exceeds the absolute per-trade ceiling', () => {
    const v = evaluatePortfolioGreeksGate(
      baseInput({ tradeMaxLossUsd: DEFAULT_PORTFOLIO_GREEKS_GATE.maxTradeLossUsd + 1 }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('max loss');
  });

  it('rejects when one underlying would dominate the book past the concentration cap', () => {
    // Book already holds $5k across other names; adding $4k more in the SAME
    // name would put this name at 9k / 10k = 90% > 35% cap.
    const v = evaluatePortfolioGreeksGate(
      baseInput({
        currentBookNotional: 6_000,
        currentNameNotional: 5_000,
        tradeNotional: 4_000,
        tradeMaxLossUsd: 1_000,
      }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('concentration');
  });

  it('allows a diversifying add even on a large book (concentration stays low)', () => {
    const v = evaluatePortfolioGreeksGate(
      baseInput({
        currentBookNotional: 9_000,
        currentNameNotional: 0, // brand-new name
        tradeNotional: 400,
        // keep delta/vega within band given a flat starting exposure
        currentNetDelta: 0,
        currentNetVega: 0,
      }),
    );
    expect(v.allowed).toBe(true);
  });

  it('rejects when the open would breach the open-position cap', () => {
    const v = evaluatePortfolioGreeksGate(
      baseInput({ currentOpenPositions: DEFAULT_PORTFOLIO_GREEKS_GATE.maxOpenPositions }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('open positions');
  });

  it('rejects non-finite Greeks input rather than passing NaN through', () => {
    const v = evaluatePortfolioGreeksGate(baseInput({ tradeNetDelta: Number.NaN }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('non-finite');
  });

  it('rejects a non-positive trade max loss', () => {
    const v = evaluatePortfolioGreeksGate(baseInput({ tradeMaxLossUsd: 0 }));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('positive');
  });

  it('honors a custom (tighter) config', () => {
    const v = evaluatePortfolioGreeksGate(
      baseInput({
        tradeNetDelta: 50,
        config: { ...DEFAULT_PORTFOLIO_GREEKS_GATE, maxAbsNetDelta: 40 },
      }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('net delta');
  });
});
