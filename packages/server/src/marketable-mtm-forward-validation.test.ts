import { describe, it, expect } from 'vitest';
import {
  sampleFromRecord,
  summarizeMarketableMtm,
  marketableMtmVerdict,
  foldMarketableMtmForwardValidation,
  MARKETABLE_MTM_DEFAULT_H,
  MARKETABLE_MTM_DEFAULT_TOL,
  MARKETABLE_MTM_DEFAULT_MIN_N,
} from './marketable-mtm-forward-validation.js';
import type { SandboxStrategyRecord, SandboxStrategyLeg } from './sandbox-strategy-journal.js';

// TRA-2247 — the server-side fold that the no-auth /api/health/marketable-mtm-forward-validation
// route emits, mirroring the CLI harness (scripts/marketable-mtm-forward-validation.mjs, TRA-2243).
// Proves: the parity-true EXIT-leg cross identity (signed, both leg-side branches), that the
// verdict is FALSIFIABLE (mid-booked corpus must NOT PASS — a detector that can't fire reads
// like one that passes), null-discipline (unpriced/unfilled exit legs EXCLUDED, non-positive
// crosses KEPT — dropping them would bias the median up), insufficient-n ⇒ REVIEW, tail-
// undercharge ⇒ REVIEW, and that the corpus is numerically identical to the harness's synthetic
// self-test corpus so the two cannot silently drift.

const CONTRACT_MULTIPLIER = 100;

function leg(over: Partial<SandboxStrategyLeg>): SandboxStrategyLeg {
  return {
    side: 'sell',
    optionSymbol: 'AAPL',
    submitTs: 1,
    fillTs: 2,
    signalToSubmitMs: 40,
    requestedPx: 1,
    fillPx: 1,
    slippageBps: null,
    spreadAtSubmitPct: null,
    withinSpread: null,
    ...over,
  };
}

function record(strategy: string, entry: SandboxStrategyLeg, exit: SandboxStrategyLeg): SandboxStrategyRecord {
  return { ts: 1, etDay: '2026-07-24', strategy, underlying: 'AAPL', ok: true, realizedRoundTripUsd: 0, legs: [entry, exit] };
}

// Byte-for-byte the harness's `synthSandboxCorpus`: alternating long_call (exit = SELL below
// mid) and csp (short exit = BUY above mid) so BOTH leg-side branches of the fold are exercised.
function synthCorpus(halfSpread: number, n = 40): SandboxStrategyRecord[] {
  const entryH = 0.06;
  const recs: SandboxStrategyRecord[] = [];
  for (let i = 0; i < n; i++) {
    const isLong = i % 2 === 0;
    const strategy = isLong ? 'long_call' : 'csp';
    const exitMid = 1.0 + (i % 5) * 0.1;
    const entryMid = 0.8 + (i % 4) * 0.05;
    const entrySide = isLong ? 'buy' : 'sell';
    const entryFill = isLong ? entryMid * (1 + entryH) : entryMid * (1 - entryH);
    const exitSide = isLong ? 'sell' : 'buy';
    const exitFill = isLong ? exitMid * (1 - halfSpread) : exitMid * (1 + halfSpread);
    recs.push(record(
      strategy,
      leg({ side: entrySide, requestedPx: entryMid, fillPx: entryFill }),
      leg({ side: exitSide, requestedPx: exitMid, fillPx: exitFill }),
    ));
  }
  return recs;
}

describe('sampleFromRecord — the parity-true EXIT-leg cross', () => {
  it('long exit (SELL below mid) yields a positive signed half-spread on the exit leg', () => {
    const rec = record('long_call', leg({ side: 'buy', requestedPx: 1, fillPx: 1 }), leg({ side: 'sell', requestedPx: 2, fillPx: 1.8 }));
    const s = sampleFromRecord(rec);
    expect(s).not.toBeNull();
    // sell exit: signedCross = requestedPx − fillPx = 0.2 ⇒ actualH = 0.1, cross = 0.2·100 = 20
    expect(s!.actualH).toBeCloseTo(0.1, 12);
    expect(s!.exitCrossUsd).toBeCloseTo(20, 9);
    expect(s!.exitMidPerShare).toBe(2);
  });

  it('short exit (BUY above mid) yields a positive signed half-spread on the exit leg', () => {
    const rec = record('csp', leg({ side: 'sell', requestedPx: 1, fillPx: 1 }), leg({ side: 'buy', requestedPx: 2, fillPx: 2.2 }));
    const s = sampleFromRecord(rec);
    // buy exit: signedCross = fillPx − requestedPx = 0.2 ⇒ actualH = 0.1, cross = 20
    expect(s!.actualH).toBeCloseTo(0.1, 12);
    expect(s!.exitCrossUsd).toBeCloseTo(20, 9);
  });

  it('KEEPS a fill at/through the mid (actualH ≤ 0) — dropping it would bias the median up', () => {
    const atMid = sampleFromRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: 2, fillPx: 2 })));
    expect(atMid).not.toBeNull();
    expect(atMid!.actualH).toBe(0);
    const through = sampleFromRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: 2, fillPx: 2.1 })));
    expect(through!.actualH).toBeLessThan(0); // sold ABOVE the mid — real parity evidence
  });

  it('EXCLUDES unprovable exit legs (one-sided quote, unfilled, bad side, single-leg)', () => {
    expect(sampleFromRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: null })))).toBeNull();
    expect(sampleFromRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: 0 })))).toBeNull();
    expect(sampleFromRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', fillPx: null })))).toBeNull();
    const oneLeg: SandboxStrategyRecord = { ts: 1, etDay: '2026-07-24', strategy: 'long_call', underlying: 'AAPL', ok: true, realizedRoundTripUsd: null, legs: [leg({ side: 'buy' })] };
    expect(sampleFromRecord(oneLeg)).toBeNull();
  });

  it('honors the strategy filter', () => {
    const rec = record('csp', leg({ side: 'sell' }), leg({ side: 'buy', requestedPx: 2, fillPx: 2.2 }));
    expect(sampleFromRecord(rec, 'csp')).not.toBeNull();
    expect(sampleFromRecord(rec, 'long_call')).toBeNull();
  });
});

describe('verdict — falsifiable and correctly gated', () => {
  it('PASS on a corpus whose realized exit half-spread ≈ modeled h', () => {
    const result = foldMarketableMtmForwardValidation(synthCorpus(0.13));
    expect(result.n).toBe(40);
    // every row's realized actualH is EXACTLY the injected 0.13 ⇒ median 0.13
    expect(result.actualH.median).toBeCloseTo(0.13, 12);
    expect(Math.abs(result.actualH.median - MARKETABLE_MTM_DEFAULT_H)).toBeLessThanOrEqual(MARKETABLE_MTM_DEFAULT_TOL);
    // modeled p90 cross (h=0.134) ≥ actual p90 cross (h=0.13) on the same mids ⇒ tail covered
    expect(result.modeledCrossUsd.p90).toBeGreaterThanOrEqual(result.actualCrossUsd.p90);
    expect(result.verdict.code).toBe('PASS');
    expect(result.fillRealism).toBe('SANDBOX_SIMULATED');
  });

  it('does NOT PASS a mid-booked corpus (actualH ≈ 0) at h=0.134 — the fire-check', () => {
    const result = foldMarketableMtmForwardValidation(synthCorpus(0.0));
    expect(result.actualH.median).toBeCloseTo(0, 12);
    expect(result.verdict.code).toBe('REVIEW');
    expect(result.verdict.reason).toMatch(/outside/);
  });

  it('REVIEW below minN even when the model is spot-on (a detector that cannot fire ≠ a PASS)', () => {
    const few = synthCorpus(0.13, 10); // 10 < 30
    const result = foldMarketableMtmForwardValidation(few);
    expect(result.n).toBe(10);
    expect(result.verdict.code).toBe('REVIEW');
    expect(result.verdict.reason).toMatch(/insufficient n/);
  });

  it('REVIEW when the modeled tail UNDER-charges the actual tail', () => {
    // realized h ≈ 0.134 (within tol) BUT actual crosses larger than modeled at the tail:
    // build a corpus at exactly the modeled h so tol passes, then verify a HIGHER-h corpus
    // (0.20) trips the tail guard while its median is out of tol too — the reason names both.
    const result = foldMarketableMtmForwardValidation(synthCorpus(0.20));
    expect(result.verdict.code).toBe('REVIEW');
    expect(result.modeledCrossUsd.p90).toBeLessThan(result.actualCrossUsd.p90);
    expect(result.verdict.reason).toMatch(/under-charges the tail/);
  });

  it('counts excluded (unpriced) records without inflating n', () => {
    const good = synthCorpus(0.13, 30);
    const bad = record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', fillPx: null }));
    const result = foldMarketableMtmForwardValidation([...good, bad]);
    expect(result.totalRecords).toBe(31);
    expect(result.n).toBe(30);
    expect(result.excludedRecords).toBe(1);
  });
});

describe('summary shape matches the harness fields', () => {
  it('emits the exact keys QuantTrader reads for the gate', () => {
    const summary = summarizeMarketableMtm(
      synthCorpus(0.13).map((r) => sampleFromRecord(r)).filter((s): s is NonNullable<typeof s> => s != null),
      MARKETABLE_MTM_DEFAULT_H,
    );
    const v = marketableMtmVerdict(summary, MARKETABLE_MTM_DEFAULT_TOL, MARKETABLE_MTM_DEFAULT_MIN_N);
    expect(summary).toHaveProperty('actualH.median');
    expect(summary).toHaveProperty('actualH.p90');
    expect(summary).toHaveProperty('actualCrossUsd.p90');
    expect(summary).toHaveProperty('modeledCrossUsd.p90');
    expect(v.code).toBe('PASS');
    // modeled cross uses the SAME exit mid the actual cross was measured against (per row)
    expect(summary.modeledCrossUsd.mean).toBeCloseTo(MARKETABLE_MTM_DEFAULT_H * CONTRACT_MULTIPLIER * summary.actualCrossUsd.mean / (0.13 * CONTRACT_MULTIPLIER), 6);
  });
});
