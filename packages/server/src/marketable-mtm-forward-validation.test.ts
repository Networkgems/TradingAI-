import { describe, it, expect } from 'vitest';
import {
  sampleFromRecord,
  classifyRecord,
  summarizeMarketableMtm,
  marketableMtmVerdict,
  foldMarketableMtmForwardValidation,
  MARKETABLE_MTM_DEFAULT_H,
  MARKETABLE_MTM_DEFAULT_TOL,
  MARKETABLE_MTM_DEFAULT_MIN_N,
  MARKETABLE_MTM_OUTLIER_ABS_H,
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
    bid: null,
    ask: null,
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
    // TRA-2283 D2 — symmetric two-sided book around each mid, so `quotedH` recovers EXACTLY
    // `halfSpread` on both exit branches (sell ⇒ mid→bid, buy ⇒ mid→ask).
    recs.push(record(
      strategy,
      leg({ side: entrySide, requestedPx: entryMid, bid: entryMid * (1 - halfSpread), ask: entryMid * (1 + halfSpread), fillPx: entryFill }),
      leg({ side: exitSide, requestedPx: exitMid, bid: exitMid * (1 - halfSpread), ask: exitMid * (1 + halfSpread), fillPx: exitFill }),
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

  // ── TRA-2283 D1 ────────────────────────────────────────────────────────────
  it('D1: EXCLUDES a false-$0 exit fill instead of folding it to actualH = ±1', () => {
    // Pre-fix this row was FOLDED: actualH = (2 − 0)/2 = +1 exactly — a 100% "half-spread"
    // manufactured out of a contract with a $2.00 decision mid. `reqExit` was guarded at
    // `<= 0` but `fillExit` only for finiteness, so the same false zero the null-check
    // above it exists to stop arrived through a different door.
    const sellExit = classifyRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: 2, fillPx: 0 })));
    expect(sellExit.sample).toBeNull();
    expect(sellExit.drop).toBe('zero_fill_exit');
    expect(sellExit.zeroFill!.wouldBeActualH).toBeCloseTo(1, 12);
    // …and the buy-exit branch yields exactly −1, the other value fillPx=0 produces.
    const buyExit = classifyRecord(record('csp', leg({ side: 'sell' }), leg({ side: 'buy', requestedPx: 2, fillPx: 0 })));
    expect(buyExit.drop).toBe('zero_fill_exit');
    expect(buyExit.zeroFill!.wouldBeActualH).toBeCloseTo(-1, 12);
    // A negative fill is the same defect.
    expect(classifyRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: 2, fillPx: -0.5 }))).drop)
      .toBe('zero_fill_exit');
    // An unfilled leg stays a DISTINCT reason — "unprovable" ≠ "corrupted".
    expect(classifyRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', fillPx: null }))).drop)
      .toBe('unfilled_exit');
  });

  it('D1: guards the ENTRY fill symmetrically — a zero-filled entry yields hEntry null, not ∓1', () => {
    // The observed live shape was BOTH legs at $0 (visible as meanSlippageBps ≈ −1262 on
    // sandbox-strategy-journal), which made each structure's entryH read as very nearly the
    // negative of its actualH. hEntry must be null, not a ∓1 reference value.
    const s = sampleFromRecord(record('long_call',
      leg({ side: 'buy', requestedPx: 1, fillPx: 0 }),
      leg({ side: 'sell', requestedPx: 2, fillPx: 1.8 })));
    expect(s).not.toBeNull();
    expect(s!.hEntry).toBeNull();
    expect(s!.actualH).toBeCloseTo(0.1, 12); // the exit leg is still perfectly good evidence
  });

  // ── TRA-2283 D2 ────────────────────────────────────────────────────────────
  it('D2: quotedH reads the QUOTED book on the exit side, even when the fill is at the mid', () => {
    // This is the whole point: a SANDBOX_SIMULATED venue fills at the decision mid, so
    // actualH is ~0 whatever the true spread is. The QUOTE is real regardless.
    const long = sampleFromRecord(record('long_call', leg({ side: 'buy' }),
      leg({ side: 'sell', requestedPx: 2, bid: 1.8, ask: 2.2, fillPx: 2 })));
    expect(long!.actualH).toBe(0);              // fill-derived: dead, as designed by the venue
    expect(long!.quotedH).toBeCloseTo(0.1, 12); // quote-derived: (2 − 1.8)/2 — ALIVE
    // A short exit pays the ASK, so its quoted haircut is (ask − mid)/mid.
    const short = sampleFromRecord(record('csp', leg({ side: 'sell' }),
      leg({ side: 'buy', requestedPx: 2, bid: 1.8, ask: 2.3, fillPx: 2 })));
    expect(short!.quotedH).toBeCloseTo(0.15, 12);
  });

  it('D2: quotedH is null on a corrupt/absent quote and never manufactures a mark', () => {
    // Pre-D2 records persisted no bid/ask at all — null, not 0.
    expect(sampleFromRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: 2, fillPx: 1.9 })))!.quotedH).toBeNull();
    // Crossed book (ask < bid).
    expect(sampleFromRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: 2, bid: 2.5, ask: 1.5, fillPx: 1.9 })))!.quotedH).toBeNull();
    // One-sided (no ask).
    expect(sampleFromRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: 2, bid: 1.8, fillPx: 1.9 })))!.quotedH).toBeNull();
    // A bid of exactly 0 IS a real quote (no buyers) — unlike a fill price it must be kept.
    const noBid = sampleFromRecord(record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: 2, bid: 0, ask: 4, fillPx: 1.9 })));
    expect(noBid!.quotedH).toBeCloseTo(0.5, 12); // clamped at MAX_MARKETABLE_HALF_SPREAD_FRAC
    expect(noBid!.quotedHClamped).toBe(true);
  });

  it('D2: quotedH.n is 0 (moments NaN, never 0) on a pre-D2 corpus with no persisted quotes', () => {
    const noQuotes = synthCorpus(0.13, 30).map((r) => ({
      ...r,
      legs: r.legs.map((l) => ({ ...l, bid: null, ask: null })),
    }));
    const result = foldMarketableMtmForwardValidation(noQuotes);
    expect(result.n).toBe(30);
    expect(result.quotedH.n).toBe(0);
    // NaN, NOT 0 — a reader must not be able to grade "no measurement" as "zero spread".
    expect(Number.isNaN(result.quotedH.median)).toBe(true);
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
    expect(result.excludedZeroFill).toBe(0);           // an UNFILLED leg is not a false zero
    expect(result.exclusions.unfilled_exit).toBe(1);
  });
});

// ── TRA-2283 D3: the pooled fold must not absolve a per-structure tail under-charge ──
describe('unpooled verdict', () => {
  /**
   * The live-corpus failure mode, minimally reproduced. Structure `long_call` (n=3, mid
   * $1.00, realized h 0.40) under-charges its own tail 3.0× ($40 actual vs $13.40 modeled).
   * Structure `csp` (n=27, mid $10.00, realized h = exactly the modeled 0.134) both fixes the
   * pooled median inside tol AND — because its mids are 10× larger — dominates the pooled p90
   * on BOTH sides, so the pooled tail check reads "covered" ($134 ≥ $134). That is the shape
   * seen live: pooled `modeled p90 $61.14 ≥ actual p90 $4.00` while long_call was under-
   * charged 2.8× and long_put 1.6×.
   */
  function maskedTailCorpus(): SandboxStrategyRecord[] {
    const recs: SandboxStrategyRecord[] = [];
    for (let i = 0; i < 3; i++) {
      recs.push(record('long_call',
        leg({ side: 'buy', requestedPx: 1, fillPx: 1 }),
        leg({ side: 'sell', requestedPx: 1, fillPx: 1 * (1 - 0.4) })));
    }
    for (let i = 0; i < 27; i++) {
      recs.push(record('csp',
        leg({ side: 'sell', requestedPx: 10, fillPx: 10 }),
        leg({ side: 'buy', requestedPx: 10, fillPx: 10 * (1 + MARKETABLE_MTM_DEFAULT_H) })));
    }
    return recs;
  }

  it('POOLED tail reads "covered" and the pooled median is in tol — yet the verdict is REVIEW', () => {
    const result = foldMarketableMtmForwardValidation(maskedTailCorpus());
    expect(result.n).toBe(30);
    // The two pre-D3 PASS conditions both hold on the pooled fold…
    expect(Math.abs(result.actualH.median - MARKETABLE_MTM_DEFAULT_H)).toBeLessThanOrEqual(MARKETABLE_MTM_DEFAULT_TOL);
    expect(result.modeledCrossUsd.p90).toBeGreaterThanOrEqual(result.actualCrossUsd.p90);
    expect(marketableMtmVerdict(result, MARKETABLE_MTM_DEFAULT_TOL, MARKETABLE_MTM_DEFAULT_MIN_N).code).toBe('PASS');
    // …and the shipped verdict still REVIEWs, naming the structure and the multiple.
    expect(result.verdict.code).toBe('REVIEW');
    expect(result.verdict.reason).toMatch(/per-structure tail UNDER-CHARGED/);
    expect(result.verdict.reason).toMatch(/long_call/);
    expect(result.verdict.reason).toMatch(/3\.0×/);
  });

  it('emits a per-structure breakdown with its own n, moments and verdict', () => {
    const result = foldMarketableMtmForwardValidation(maskedTailCorpus());
    expect(result.perStructure.map((s) => s.structure)).toEqual(['csp', 'long_call']); // n-descending
    const lc = result.perStructure.find((s) => s.structure === 'long_call')!;
    expect(lc.n).toBe(3);
    expect(lc.actualH.median).toBeCloseTo(0.4, 12);
    expect(lc.tailUnderCharged).toBe(true);
    expect(lc.tailUnderChargeRatio).toBeCloseTo(40 / 13.4, 6);
    expect(lc.verdict.code).toBe('REVIEW');
    const csp = result.perStructure.find((s) => s.structure === 'csp')!;
    expect(csp.n).toBe(27);
    expect(csp.tailUnderCharged).toBe(false);
    expect(csp.tailUnderChargeRatio).toBeNull();
    // Per-structure n is always REPORTED; enforcing minN per structure stays opt-in.
    expect(result.structuresBelowMinN).toEqual(['csp', 'long_call']);
    expect(result.requirePerStructureMinN).toBe(false);
  });

  it('does not unilaterally tighten minN per structure, but the switch works when asked', () => {
    // 40 rows split 20/20: pooled n clears minN=30, neither structure does.
    const lenient = foldMarketableMtmForwardValidation(synthCorpus(0.13));
    expect(lenient.verdict.code).toBe('PASS');
    expect(lenient.structuresBelowMinN).toEqual(['csp', 'long_call']);
    const strict = foldMarketableMtmForwardValidation(synthCorpus(0.13), { requirePerStructureMinN: true });
    expect(strict.verdict.code).toBe('REVIEW');
    expect(strict.verdict.reason).toMatch(/insufficient per-structure n/);
  });
});

// ── the live-corpus prediction this ticket is falsifiable against ────────────
describe('TRA-2283 acceptance — the live 30-record corpus shape', () => {
  /**
   * The live bqb1 corpus as diagnosed: 30 records over four structures (8 long_call, 8
   * long_put, 7 csp, 7 covered_call), of which FOUR — one per structure — have BOTH legs
   * reporting a false `$0` fill. The clean rows sit at a pennies-wide realized cross
   * (`actualH` ≈ 0.0025, `actualCrossUsd` ≈ $1) because the venue fills at the decision mid.
   */
  function liveShapeCorpus(): SandboxStrategyRecord[] {
    const plan: Array<[string, number, 'long' | 'short']> = [
      ['long_call', 8, 'long'], ['long_put', 8, 'long'],
      ['csp', 7, 'short'], ['covered_call', 7, 'short'],
    ];
    const recs: SandboxStrategyRecord[] = [];
    for (const [strategy, n, dir] of plan) {
      for (let i = 0; i < n; i++) {
        const mid = 2.0;
        const zero = i === 0; // exactly one poisoned round-trip per structure
        const entrySide = dir === 'long' ? 'buy' : 'sell';
        const exitSide = dir === 'long' ? 'sell' : 'buy';
        const h = 0.0025;
        recs.push(record(strategy,
          leg({ side: entrySide, requestedPx: mid, fillPx: zero ? 0 : mid * (dir === 'long' ? 1 + h : 1 - h) }),
          leg({ side: exitSide, requestedPx: mid, fillPx: zero ? 0 : mid * (dir === 'long' ? 1 - h : 1 + h) })));
      }
    }
    return recs;
  }

  it('excludedZeroFill reads 4 of 30, n reads 26, verdict is REVIEW (insufficient n)', () => {
    const result = foldMarketableMtmForwardValidation(liveShapeCorpus());
    expect(result.totalRecords).toBe(30);
    expect(result.excludedZeroFill).toBe(4);        // the falsifiable prediction
    expect(result.n).toBe(26);                      // 30 − 4
    expect(result.verdict.code).toBe('REVIEW');
    expect(result.verdict.reason).toMatch(/insufficient n \(26 < 30\)/);
    // …and NOT because of a manufactured tail failure: with the false zeros gone, no
    // structure under-charges any more.
    expect(result.verdict.reason).not.toMatch(/UNDER-CHARGED/);
    expect(result.perStructure.every((s) => !s.tailUnderCharged)).toBe(true);
  });

  it('the ±0.13 per-structure means and the 2.8× tail under-charge were the false zeros', () => {
    const corpus = liveShapeCorpus();
    // Fold the SAME corpus with the zero rows folded (i.e. the pre-D1 behaviour) by
    // reading them straight off classifyRecord's would-be value.
    const wouldBe = corpus
      .map((r) => classifyRecord(r))
      .filter((c) => c.zeroFill != null)
      .map((c) => c.zeroFill!.wouldBeActualH);
    expect(wouldBe).toHaveLength(4);
    // Four rows, all at |h| = 1.00 — the exact and only value fillPx = 0 produces. Signs
    // flip with structure DIRECTION (+1 for long exits which SELL, −1 for short exits which BUY),
    // which is why pooling four structures cancelled them to ~0.0026.
    expect(wouldBe.map((h) => Math.abs(h))).toEqual([1, 1, 1, 1]);
    expect(wouldBe.filter((h) => h > 0)).toHaveLength(2);
    expect(wouldBe.filter((h) => h < 0)).toHaveLength(2);
    // Post-fix, every retained row is a pennies-wide cross — nothing near |h| = 1 survives.
    const result = foldMarketableMtmForwardValidation(corpus);
    expect(Math.abs(result.actualH.mean)).toBeLessThan(0.01);
    expect(result.perStructure.every((s) => Math.abs(s.actualH.mean) < 0.01)).toBe(true);
  });

  // ── TRA-2283 D4 ────────────────────────────────────────────────────────────
  it('D4: diagnostics make the diagnosis a direct read, not a reconstruction', () => {
    const result = foldMarketableMtmForwardValidation(liveShapeCorpus(), { includeSamples: true });
    expect(result.diagnostics.zeroFillRows).toHaveLength(4);
    const row = result.diagnostics.zeroFillRows[0];
    expect(row.exitFillPx).toBe(0);
    expect(Math.abs(row.wouldBeActualH)).toBeCloseTo(1, 12);
    expect(row.entryAlsoZeroFill).toBe(true); // the observed live shape: BOTH legs at $0
    expect(result.diagnostics.zeroFillRows.map((r) => r.structure).sort())
      .toEqual(['covered_call', 'csp', 'long_call', 'long_put']);
    // No |actualH| > 0.5 row survives the fold any more.
    expect(result.diagnostics.outlierAbsHThreshold).toBe(MARKETABLE_MTM_OUTLIER_ABS_H);
    expect(result.diagnostics.outlierCount).toBe(0);
    expect(result.diagnostics.outlierRows).toEqual([]);
    expect(Math.abs(result.diagnostics.minActualH!)).toBeLessThan(0.01);
    expect(Math.abs(result.diagnostics.maxActualH!)).toBeLessThan(0.01);
    expect(result.samples).toHaveLength(26);
    expect(result.diagnostics.truncated).toBe(false);
  });

  it('D4: an outlier that DOES survive is named rather than averaged into a moment', () => {
    // A non-zero but implausible fill (|actualH| = 0.9) is not a false zero, so it is KEPT —
    // and must be visible instead of silently moving a mean.
    const corpus = [...synthCorpus(0.13, 30),
      record('long_call', leg({ side: 'buy' }), leg({ side: 'sell', requestedPx: 2, fillPx: 0.2 }))];
    const result = foldMarketableMtmForwardValidation(corpus);
    expect(result.n).toBe(31);
    expect(result.excludedZeroFill).toBe(0);
    expect(result.diagnostics.outlierCount).toBe(1);
    expect(result.diagnostics.outlierRows[0].actualH).toBeCloseTo(0.9, 12);
    expect(result.diagnostics.maxActualH).toBeCloseTo(0.9, 12);
  });

  it('samples are omitted unless asked for (payload stays bounded by default)', () => {
    expect(foldMarketableMtmForwardValidation(synthCorpus(0.13, 30)).samples).toBeUndefined();
  });

  it('carries the caveat that actualH cannot falsify a bid model on this venue', () => {
    const result = foldMarketableMtmForwardValidation(liveShapeCorpus());
    expect(result.fillRealism).toBe('SANDBOX_SIMULATED');
    expect(result.actualHCaveat).toMatch(/DECISION MID/);
    expect(result.actualHCaveat).toMatch(/MUST NOT be actioned/);
  });

  it('the verdict string no longer reads as an instruction to retune h', () => {
    // The live payload said `(retune h ≈ 0.002)`. Actioning that would collapse the
    // marketable(bid) haircut to indistinguishable from mid-marking — the TRA-2131 shape
    // TRA-2233 exists to prevent.
    const result = foldMarketableMtmForwardValidation(synthCorpus(0.0));
    expect(result.verdict.code).toBe('REVIEW');
    expect(result.verdict.reason).toMatch(/outside/);
    expect(result.verdict.reason).not.toMatch(/\(retune h/);
    expect(result.verdict.reason).toMatch(/do NOT retune h/);
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
