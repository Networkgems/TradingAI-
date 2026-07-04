import { describe, it, expect, beforeEach } from 'vitest';
import {
  blackScholesPrice,
  daysToExpiration,
  realizedVolFromDailyCloses,
  type OptionChainRow,
} from '@trading-app/engine';
import {
  scanShortPremiumFromSnapshot,
  recordShortPremiumScan,
  summarizeShortPremiumScans,
  clearShortPremiumScans,
  SHORT_PREMIUM_MIN_IV_RANK,
} from './short-premium-scanner.js';

// TRA-1292 — the wiring seam between the warm RV-scanner chain snapshot and the
// pure short-premium engine, plus the in-memory store backing
// /api/health/short-premium. The engine math itself is exhaustively covered in
// short-premium-scanner.test.ts (engine); here we prove the integration:
// realised vol is derived from the daily closes, the IV-rank gate short-circuits,
// candidates flow through, the reasons are correct, and the store folds into the
// redacted diagnostics shape.

const NOW = Date.parse('2024-01-15T15:00:00Z');
const EXP = '2024-02-15'; // ~31 DTE
const T = daysToExpiration(EXP, NOW) / 365;
const SPOT = 100;

/** A near-flat daily-close series → low realised vol (so a 0.40 IV chain is VRP-positive). */
const CALM_CLOSES = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? 0.1 : -0.1));

function row(strike: number, optionType: 'call' | 'put', iv = 0.4): OptionChainRow {
  const mark = blackScholesPrice({
    spot: SPOT,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: 0.045,
    volatility: iv,
    optionType,
  });
  const halfSpread = Math.max(mark * 0.02, 0.01);
  return {
    optionSymbol: `TEST${strike}${optionType[0]!.toUpperCase()}`,
    underlying: 'TEST',
    optionType,
    strike,
    expiration: EXP,
    bid: mark - halfSpread,
    ask: mark + halfSpread,
    last: mark,
    volume: 500,
    openInterest: 2000,
    smvVol: iv,
    midIv: iv,
  };
}

function ladder(): OptionChainRow[] {
  const strikes = [82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 118];
  return strikes.flatMap((k) => [row(k, 'put'), row(k, 'call')]);
}

function snap(rows: OptionChainRow[], over: Partial<{ spot: number; expiration: string }> = {}) {
  return { symbol: 'test', spot: SPOT, expiration: EXP, rows, ...over };
}

describe('scanShortPremiumFromSnapshot', () => {
  it('derives realised vol and surfaces defined-risk structures when the desk gates clear', () => {
    const out = scanShortPremiumFromSnapshot(snap(ladder()), CALM_CLOSES, 70, { now: NOW }, 20);
    expect(out.symbol).toBe('TEST'); // upper-cased
    expect(out.reason).toBe('ok');
    expect(out.realizedVol).toBeCloseTo(realizedVolFromDailyCloses(CALM_CLOSES, 20)!, 10);
    expect(out.ivRank).toBe(70);
    expect(out.candidates.length).toBeGreaterThan(0);
    // every structure is VRP-positive, in the delta band, and defined risk.
    for (const c of out.candidates) {
      expect(c.ivRvRatio).toBeGreaterThanOrEqual(1);
      expect(c.maxLoss).toBeGreaterThan(0);
      if (c.structure !== 'iron_condor') {
        expect(c.shortDelta).toBeGreaterThanOrEqual(0.15);
        expect(c.shortDelta).toBeLessThanOrEqual(0.3);
      }
    }
  });

  it('stands the scan down with ivrank_low when a finite rank below 50 is passed', () => {
    const out = scanShortPremiumFromSnapshot(snap(ladder()), CALM_CLOSES, SHORT_PREMIUM_MIN_IV_RANK - 1);
    expect(out.reason).toBe('ivrank_low');
    expect(out.candidates).toHaveLength(0);
    expect(out.ivRank).toBe(SHORT_PREMIUM_MIN_IV_RANK - 1);
  });

  it('defers to observe-only (does not rank-gate) when IV-rank is unknown', () => {
    const out = scanShortPremiumFromSnapshot(snap(ladder()), CALM_CLOSES, null, { now: NOW });
    expect(out.reason).toBe('ok');
    expect(out.ivRank).toBeNull();
    expect(out.candidates.length).toBeGreaterThan(0);
  });

  it('returns no_chain / no_spot / no_realized_vol on missing preconditions', () => {
    expect(scanShortPremiumFromSnapshot(snap([]), CALM_CLOSES, 70).reason).toBe('no_chain');
    expect(scanShortPremiumFromSnapshot(snap(ladder(), { spot: 0 }), CALM_CLOSES, 70).reason).toBe('no_spot');
    expect(scanShortPremiumFromSnapshot(snap(ladder()), [100, 100], 70).reason).toBe('no_realized_vol');
  });
});

describe('short-premium store', () => {
  beforeEach(() => clearShortPremiumScans());

  it('folds recorded scans into the redacted diagnostics summary, sorted by top score', () => {
    const a = scanShortPremiumFromSnapshot(snap(ladder(), {}), CALM_CLOSES, 70, { now: NOW });
    recordShortPremiumScan({ ...a, symbol: 'AAA' }, NOW);
    recordShortPremiumScan(
      { ...a, symbol: 'BBB', candidates: [], reason: 'no_candidates' },
      NOW,
    );
    const summary = summarizeShortPremiumScans(NOW);
    expect(summary.symbolCount).toBe(2);
    // AAA (has structures) sorts before BBB (none).
    expect(summary.scans[0]!.symbol).toBe('AAA');
    expect(summary.scans[0]!.candidateCount).toBeGreaterThan(0);
    // legs + credit/PoP fields are present in the view.
    const top = summary.scans[0]!.candidates[0]!;
    expect(top.legs.length).toBeGreaterThanOrEqual(2);
    expect(top.netCredit).toBeGreaterThan(0);
    expect(top.estPoP).toBeGreaterThan(0);
  });

  it('drops entries past the 30-minute TTL', () => {
    const a = scanShortPremiumFromSnapshot(snap(ladder()), CALM_CLOSES, 70, { now: NOW });
    recordShortPremiumScan({ ...a, symbol: 'CCC' }, NOW);
    expect(summarizeShortPremiumScans(NOW).symbolCount).toBe(1);
    expect(summarizeShortPremiumScans(NOW + 31 * 60_000).symbolCount).toBe(0);
  });
});
