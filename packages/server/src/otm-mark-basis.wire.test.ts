import { describe, it, expect } from 'vitest';
import {
  findMispricedOtmContracts,
  blackScholesPrice,
  daysToExpiration,
  type OptionChainRow,
} from '@trading-app/engine';
import { rebaseOnMark, OTM_MISPRICING_BASIS } from './otm-mark-basis.js';
import { applyTheoFloor, OTM_PANEL_THEO_FLOOR } from './otm-theo-floor.js';
import { applyDeltaFloor, OTM_PANEL_DELTA_FLOOR } from './otm-delta-floor.js';

/**
 * TRA-2564 acceptance, executed off-host.
 *
 * The ticket's acceptance is a property of the LIVE 200 response, and QuantTrader
 * runs the RTH re-measure after deploy. This pins the same three properties
 * against the REAL engine and the REAL route pipeline so that a regression is
 * caught in CI rather than by a human reading a live panel — and, more to the
 * point, so the acceptance has a defined FAILING state that does not depend on
 * bqb1 being reachable.
 *
 * ⚠️ What this CANNOT do: it cannot prove the live box serves this build. That
 * is a deploy question (`pnpm check:deploy-drift`), not a test question. A green
 * run here says the code is right, never that it is running.
 */

const NOW = Date.parse('2026-07-30T15:00:00Z');
const EXP = '2026-08-31';
const T = daysToExpiration(EXP, NOW) / 365;
const R = 0.045;
const SPOT = 738.93; // SPY on the 2026-07-25 read TRA-2341 tabulates

/**
 * A SPY-shaped chain reproducing the artifact regime: far-OTM puts whose theo
 * collapses under a flat σ while the bid stays pinned near the minimum tick,
 * plus near-the-money strikes that price honestly. This is the shape that made
 * the theo basis read +74215.7% / +1510.9%.
 */
function chain(): OptionChainRow[] {
  const rows: OptionChainRow[] = [];
  for (const strike of [420, 470, 490, 620, 680, 700, 720, 730]) {
    const sigma = 0.18;
    const theo = blackScholesPrice({
      spot: SPOT,
      strike,
      timeToExpiryYears: T,
      riskFreeRate: R,
      volatility: sigma,
      optionType: 'put',
    });
    // Far OTM the tape will not quote below a tick, whatever the model says —
    // that floor on the NUMERATOR against a collapsing denominator is the whole
    // artifact. Near the money the market and the model agree to within a few %.
    const mark = Math.max(0.1, theo * 1.04);
    const half = Math.max(0.01, mark * 0.02);
    rows.push({
      optionSymbol: `SPY260831P00${strike}000`,
      underlying: 'SPY',
      optionType: 'put',
      strike,
      expiration: EXP,
      bid: mark - half,
      ask: mark + half,
      volume: 500,
      openInterest: 1000,
      smvVol: sigma,
      midIv: sigma,
    });
  }
  return rows;
}

/** The exact composition `/api/options/otm-mispricing` performs, in order. */
function route(opts: { minDelta?: number; minTheo?: number; limit?: number } = {}) {
  const candidates = findMispricedOtmContracts(chain(), SPOT, { now: NOW });
  const rebased = rebaseOnMark(candidates);
  const floored = applyTheoFloor(rebased.candidates, opts.minTheo ?? OTM_PANEL_THEO_FLOOR);
  const deltaFloored = applyDeltaFloor(floored.kept, opts.minDelta ?? OTM_PANEL_DELTA_FLOOR);
  const body = {
    symbol: 'SPY',
    candidates: deltaFloored.kept.slice(0, opts.limit ?? 15),
    mispricingBasis: OTM_MISPRICING_BASIS,
    markBasis: { threshold: rebased.threshold, unbasisable: rebased.unbasisable },
    theoFloor: {
      applied: floored.floor,
      suppressed: floored.suppressed,
      maxSuppressedMispricingPct: floored.maxSuppressedMispricingPct,
    },
    deltaFloor: {
      applied: deltaFloored.floor,
      suppressed: deltaFloored.suppressed,
      maxSuppressedMispricingPct: deltaFloored.maxSuppressedMispricingPct,
    },
  };
  // Round-trip through the wire. `res.json` is `JSON.stringify` — a field that
  // does not survive it is not an instrument, however present it is in the type.
  return JSON.parse(JSON.stringify(body)) as typeof body;
}

describe('TRA-2564 acceptance — off-host', () => {
  it('the fixture really is in the artifact regime under the OLD basis', () => {
    // Negative control for the whole file: if this stops holding, the tests
    // below prove nothing, because there was no defect to fix.
    const raw = findMispricedOtmContracts(chain(), SPOT, { now: NOW });
    const worst = Math.max(...raw.map((c) => Math.abs(c.mispricingPct)));
    expect(worst).toBeGreaterThan(1.0); // theo basis blows past 100%
  });

  it('`mispricingBasis: "mark"` survives JSON serialisation', () => {
    expect(route().mispricingBasis).toBe('mark');
    expect(Object.keys(route())).toContain('mispricingBasis');
  });

  it('max |mispricingPct| reads below 100% at minDelta=0 — the headline number', () => {
    const body = route({ minDelta: 0 });
    expect(body.candidates.length).toBeGreaterThan(0); // not vacuously true
    const worst = Math.max(...body.candidates.map((c) => Math.abs(c.mispricingPct)));
    expect(worst).toBeLessThan(1.0);
    // The ticket's re-measure bar is 75%; this fixture should clear it too.
    expect(worst).toBeLessThan(0.75);
  });

  it('the suppressed footnotes are quoted in the mark basis, not the theo basis', () => {
    const body = route();
    for (const f of [body.theoFloor, body.deltaFloor]) {
      if (f.maxSuppressedMispricingPct !== null) {
        // A theo-basis leak here would be >1 on this fixture.
        expect(Math.abs(f.maxSuppressedMispricingPct)).toBeLessThan(1.0);
      }
    }
  });

  it('rows are ranked by the NEW |mispricingPct|, descending', () => {
    const pcts = route({ minDelta: 0 }).candidates.map((c) => Math.abs(c.mispricingPct));
    for (let i = 1; i < pcts.length; i += 1) {
      expect(pcts[i - 1]).toBeGreaterThanOrEqual(pcts[i]);
    }
  });

  it('every emitted row is self-consistent: pct === (mark − theo) / mark', () => {
    for (const c of route({ minDelta: 0 }).candidates) {
      expect(c.mispricingPct).toBeCloseTo((c.mark - c.theo) / c.mark, 12);
    }
  });
});
