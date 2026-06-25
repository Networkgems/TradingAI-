import { describe, it, expect, beforeEach } from 'vitest';
import {
  blackScholesPrice,
  daysToExpiration,
  realizedVolFromDailyCloses,
  type OptionChainRow,
} from '@trading-app/engine';
import {
  scanIvRvFromSnapshot,
  recordIvRvScan,
  summarizeIvRvScans,
  clearIvRvScans,
  type IvRvScanResult,
} from './iv-rv-scanner.js';

// TRA-1156 — the wiring seam between the warm RV-scanner chain snapshot and the
// pure TRA-1155 IV-vs-RV engine, plus the in-memory store backing /api/health/iv-rv.
// The engine math itself is exhaustively covered in iv-rv-mispricing.test.ts; here
// we prove the integration: realised vol is derived from the daily closes, the
// candidates flow through, the discriminating reasons are correct, and the store
// folds into the redacted diagnostics shape with caps + TTL.

const NOW = Date.parse('2024-01-15T15:00:00Z');
const EXP = '2024-02-15'; // ~31 DTE — inside the engine's 90-day window
const T = daysToExpiration(EXP, NOW) / 365;
const SPOT = 100;

/** A near-flat daily-close series → low realised vol (so a 0.45 IV reads rich). */
const CALM_CLOSES = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? 0.15 : -0.15));
const CALM_RV = realizedVolFromDailyCloses(CALM_CLOSES, 20)!;

function row(strike: number, impliedVol: number, overrides: Partial<OptionChainRow> = {}): OptionChainRow {
  const mark = blackScholesPrice({
    spot: SPOT,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: 0.045,
    volatility: impliedVol,
    optionType: 'call',
  });
  const halfSpread = mark * 0.02;
  return {
    optionSymbol: `TEST${strike}C`,
    underlying: 'TEST',
    optionType: 'call',
    strike,
    expiration: EXP,
    bid: mark - halfSpread,
    ask: mark + halfSpread,
    last: mark,
    volume: 500,
    openInterest: 2000,
    smvVol: impliedVol,
    midIv: impliedVol,
    ...overrides,
  };
}

function snap(rows: OptionChainRow[], over: Partial<{ spot: number; expiration: string }> = {}) {
  return { symbol: 'test', spot: SPOT, expiration: EXP, rows, ...over };
}

describe('scanIvRvFromSnapshot', () => {
  it('derives realised vol from the daily closes and surfaces SELL_PREMIUM candidates', () => {
    const out = scanIvRvFromSnapshot(snap([row(100, 0.45)]), CALM_CLOSES, { now: NOW });
    expect(out.symbol).toBe('TEST'); // upper-cased
    expect(out.reason).toBe('ok');
    expect(out.realizedVol).toBeCloseTo(CALM_RV, 10);
    expect(out.dailyCloseCount).toBe(CALM_CLOSES.length);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]!.action).toBe('SELL_PREMIUM');
    expect(out.candidates[0]!.ivRvRatio).toBeCloseTo(0.45 / CALM_RV, 6);
  });

  it('returns no_chain when the snapshot carries no rows', () => {
    const out = scanIvRvFromSnapshot(snap([]), CALM_CLOSES, { now: NOW });
    expect(out.reason).toBe('no_chain');
    expect(out.candidates).toHaveLength(0);
  });

  it('returns no_spot when spot is non-positive', () => {
    const out = scanIvRvFromSnapshot(snap([row(100, 0.45)], { spot: 0 }), CALM_CLOSES, { now: NOW });
    expect(out.reason).toBe('no_spot');
    expect(out.spot).toBeNull();
  });

  it('returns no_realized_vol when the daily-close history is too short', () => {
    const out = scanIvRvFromSnapshot(snap([row(100, 0.45)]), [100], { now: NOW });
    expect(out.reason).toBe('no_realized_vol');
    expect(out.realizedVol).toBeNull();
    expect(out.candidates).toHaveLength(0);
  });

  it('returns no_candidates when IV sits within the engine thresholds', () => {
    // IV ≈ realised vol → ratio ~1.0, well inside the 1.30 / 0.70 band.
    const out = scanIvRvFromSnapshot(snap([row(100, CALM_RV)]), CALM_CLOSES, { now: NOW });
    expect(out.reason).toBe('no_candidates');
    expect(out.realizedVol).toBeCloseTo(CALM_RV, 10);
    expect(out.candidates).toHaveLength(0);
  });
});

describe('IV-RV scan store / summarizeIvRvScans', () => {
  beforeEach(() => clearIvRvScans());

  it('folds recorded scans into the redacted diagnostics shape', () => {
    const result = scanIvRvFromSnapshot(snap([row(100, 0.45)]), CALM_CLOSES, { now: NOW });
    recordIvRvScan(result, NOW);

    const summary = summarizeIvRvScans(NOW);
    expect(summary.symbolCount).toBe(1);
    expect(summary.candidateCount).toBe(1);
    const view = summary.scans[0]!;
    expect(view.symbol).toBe('TEST');
    expect(view.reason).toBe('ok');
    expect(view.recordedAt).toBe(new Date(NOW).toISOString());
    // The acceptance fields the board reads off the surface.
    const c = view.candidates[0]!;
    expect(c.action).toBe('SELL_PREMIUM');
    expect(typeof c.ivRvRatio).toBe('number');
    expect(typeof c.mispricingPct).toBe('number');
    expect(typeof c.score).toBe('number');
  });

  it('keeps the latest scan per symbol (latest-wins)', () => {
    recordIvRvScan(scanIvRvFromSnapshot(snap([row(100, 0.45)]), CALM_CLOSES, { now: NOW }), NOW);
    recordIvRvScan(scanIvRvFromSnapshot(snap([]), CALM_CLOSES, { now: NOW }), NOW + 1000);
    const summary = summarizeIvRvScans(NOW + 1000);
    expect(summary.symbolCount).toBe(1);
    expect(summary.scans[0]!.reason).toBe('no_chain');
  });

  it('sorts symbols by strongest candidate score first', () => {
    const weak: IvRvScanResult = {
      symbol: 'AAA', spot: SPOT, expiration: EXP, realizedVol: 0.2, dailyCloseCount: 25,
      reason: 'ok',
      candidates: [{ ...scanIvRvFromSnapshot(snap([row(100, 0.45)]), CALM_CLOSES, { now: NOW }).candidates[0]!, score: 1 }],
    };
    const strong: IvRvScanResult = {
      ...weak, symbol: 'ZZZ',
      candidates: [{ ...weak.candidates[0]!, score: 99 }],
    };
    recordIvRvScan(weak, NOW);
    recordIvRvScan(strong, NOW);
    const summary = summarizeIvRvScans(NOW);
    expect(summary.scans.map((s) => s.symbol)).toEqual(['ZZZ', 'AAA']);
  });

  it('drops scans past the 30-minute TTL', () => {
    recordIvRvScan(scanIvRvFromSnapshot(snap([row(100, 0.45)]), CALM_CLOSES, { now: NOW }), NOW);
    expect(summarizeIvRvScans(NOW + 29 * 60_000).symbolCount).toBe(1);
    expect(summarizeIvRvScans(NOW + 31 * 60_000).symbolCount).toBe(0);
  });
});
