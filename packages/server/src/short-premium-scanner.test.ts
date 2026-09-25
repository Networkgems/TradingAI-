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
import { MIN_IV_SAMPLES, type IvRankCoverageReading } from './iv-rank-store.js';

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

describe('IV-rank coverage stamp + rollup (TRA-4917)', () => {
  beforeEach(() => clearShortPremiumScans());

  const reading = (over: Partial<IvRankCoverageReading> = {}): IvRankCoverageReading => ({
    ivRank: null,
    atmIv: 0.4,
    ivSampleDepth: 3,
    coverage: 'insufficient_history',
    ...over,
  });

  it('carries atmIv / ivSampleDepth / ivRankCoverage onto the scan record', () => {
    const out = scanShortPremiumFromSnapshot(
      snap(ladder()),
      CALM_CLOSES,
      reading({ ivRank: 70, ivSampleDepth: 240, coverage: 'covered' }),
      { now: NOW },
    );
    expect(out.reason).toBe('ok');
    expect(out.ivRank).toBe(70);
    expect(out.atmIv).toBe(0.4);
    expect(out.ivSampleDepth).toBe(240);
    expect(out.ivRankCoverage).toBe('covered');
  });

  it('the legacy number|null form stamps not_evaluated and does NOT fabricate 0-depth', () => {
    const out = scanShortPremiumFromSnapshot(snap(ladder()), CALM_CLOSES, null, { now: NOW });
    expect(out.ivRank).toBeNull();
    expect(out.ivRankCoverage).toBe('not_evaluated');
    // 0 / 0.0 here would read identically to a genuine `uncovered` / `no_atm_iv`.
    expect(out.ivSampleDepth).toBeNull();
    expect(out.atmIv).toBeNull();
  });

  it('a null rank still fails OPEN — the diagnostic changes nothing about the gate', () => {
    for (const code of ['no_atm_iv', 'uncovered', 'insufficient_history', 'flat_window'] as const) {
      const out = scanShortPremiumFromSnapshot(
        snap(ladder()),
        CALM_CLOSES,
        reading({ coverage: code, atmIv: code === 'no_atm_iv' ? null : 0.4 }),
        { now: NOW },
      );
      expect(out.reason).toBe('ok');
      expect(out.candidates.length).toBeGreaterThan(0);
      expect(out.ivRank).toBeNull();
      expect(out.ivRankCoverage).toBe(code);
    }
    // …and a FINITE low rank still stands the scan down, unchanged.
    const low = scanShortPremiumFromSnapshot(
      snap(ladder()),
      CALM_CLOSES,
      reading({ ivRank: SHORT_PREMIUM_MIN_IV_RANK - 1, coverage: 'covered' }),
      { now: NOW },
    );
    expect(low.reason).toBe('ivrank_low');
  });

  it('reproduces the incident shape: the counters partition the whole wire payload', () => {
    // Three unknown scans on three DIFFERENT branches, one covered scan.
    const withCands = scanShortPremiumFromSnapshot(
      snap(ladder()),
      CALM_CLOSES,
      reading({ coverage: 'uncovered', ivSampleDepth: 0 }),
      { now: NOW },
    );
    expect(withCands.candidates.length).toBeGreaterThan(0);
    recordShortPremiumScan({ ...withCands, symbol: 'AAA' }, NOW);
    recordShortPremiumScan(
      { ...withCands, symbol: 'BBB', ivRankCoverage: 'no_atm_iv', atmIv: null, ivSampleDepth: 12 },
      NOW,
    );
    recordShortPremiumScan(
      { ...withCands, symbol: 'CCC', candidates: [], reason: 'no_candidates', ivRankCoverage: 'flat_window', ivSampleDepth: 31 },
      NOW,
    );
    const covered = scanShortPremiumFromSnapshot(
      snap(ladder()),
      CALM_CLOSES,
      reading({ ivRank: 70, ivSampleDepth: 240, coverage: 'covered' }),
      { now: NOW },
    );
    recordShortPremiumScan({ ...covered, symbol: 'DDD' }, NOW);

    const s = summarizeShortPremiumScans(NOW);
    const cov = s.ivRankCoverage;
    expect(cov.scanCount).toBe(4);
    expect(cov.ivRankMeasured).toBe(1);
    expect(cov.ivRankUnknown).toBe(3);
    expect(cov.ivRankMeasured + cov.ivRankUnknown).toBe(cov.scanCount);

    // The branch split is the whole point: 1 covered + 3 distinct unknown reasons.
    expect(cov.byCode).toMatchObject({
      covered: 1,
      uncovered: 1,
      no_atm_iv: 1,
      flat_window: 1,
      insufficient_history: 0,
      store_unloaded: 0,
      not_evaluated: 0,
    });
    expect(cov.unknownByCode.covered).toBe(0);
    expect(Object.values(cov.byCode).reduce((a, b) => a + b, 0)).toBe(cov.scanCount);
    expect(Object.values(cov.unknownByCode).reduce((a, b) => a + b, 0)).toBe(cov.ivRankUnknown);

    // The 164-row identity from the incident, on this fixture's scale.
    expect(cov.candidateCount).toBe(s.candidateCount);
    expect(cov.wireRowCount).toBe(cov.scanCount + cov.candidateCount);
    expect(cov.wireRowsMeasured + cov.wireRowsUnknown).toBe(cov.wireRowCount);
    // Candidate ranks are ECHOES of their scan's, so AAA/BBB's structures are all null
    // and only DDD's carry 70 — never counted as independent observations.
    expect(cov.candidateIvRankMeasured).toBe(covered.candidates.length);
    expect(cov.candidateIvRankUnknown).toBe(cov.candidateCount - covered.candidates.length);

    // The gate's reach, published rather than inferred.
    expect(cov.ivRankFloor).toBe(SHORT_PREMIUM_MIN_IV_RANK);
    expect(cov.gateEvaluable).toBe(1);
    expect(cov.gateInert).toBe(3);
    expect(cov.minSamples).toBe(MIN_IV_SAMPLES);
    expect(cov.partitionOk).toBe(true);
    expect(cov.partitionMismatch).toBeNull();

    // The reason split the incident had to fold by hand.
    expect(s.reasonCounts).toEqual({ ok: 3, no_candidates: 1 });
  });

  it('partitionOk CAN go red: a `covered` code beside a null rank is caught', () => {
    const out = scanShortPremiumFromSnapshot(
      snap(ladder()),
      CALM_CLOSES,
      reading({ coverage: 'uncovered', ivSampleDepth: 0 }),
      { now: NOW },
    );
    // The inconsistency a future producer could introduce: the code says a number
    // was computed, the value says it wasn't. Two separately-stored fields, so the
    // cross-check is not agreeing with itself.
    recordShortPremiumScan({ ...out, symbol: 'EEE', ivRankCoverage: 'covered' }, NOW);
    const cov = summarizeShortPremiumScans(NOW).ivRankCoverage;
    expect(cov.partitionOk).toBe(false);
    expect(cov.partitionMismatch).toContain('covered');
    expect(cov.unknownByCode.covered).toBe(1);
  });

  it('partitionOk goes red in the OTHER direction too: a finite rank under a null code', () => {
    // The mirror of the test above, and the one that stops `byCode` from being a
    // relabelled copy of `ivRank`: if the rollup ever derived the code from the
    // value it would silently read this row as `covered` and stay green.
    const out = scanShortPremiumFromSnapshot(
      snap(ladder()),
      CALM_CLOSES,
      reading({ ivRank: 70, ivSampleDepth: 240, coverage: 'covered' }),
      { now: NOW },
    );
    recordShortPremiumScan({ ...out, symbol: 'FFF', ivRankCoverage: 'insufficient_history' }, NOW);
    const cov = summarizeShortPremiumScans(NOW).ivRankCoverage;
    expect(cov.ivRankMeasured).toBe(1);
    expect(cov.byCode.covered).toBe(0);
    expect(cov.byCode.insufficient_history).toBe(1);
    expect(cov.partitionOk).toBe(false);
    expect(cov.partitionMismatch).toContain('ivRankMeasured');
  });

  it('an empty fold is an honest all-zero, not a divide-by-zero or a pass', () => {
    const cov = summarizeShortPremiumScans(NOW).ivRankCoverage;
    expect(cov.scanCount).toBe(0);
    expect(cov.ivRankMeasured).toBe(0);
    expect(cov.ivRankUnknown).toBe(0);
    expect(cov.wireRowCount).toBe(0);
    expect(cov.partitionOk).toBe(true);
  });
});
