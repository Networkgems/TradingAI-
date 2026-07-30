import { describe, it, expect } from 'vitest';
import {
  sampleFromRecord,
  classifyRecord,
  summarizeMarketableMtm,
  marketableMtmVerdict,
  marketableMtmQuotedVerdict,
  foldMarketableMtmForwardValidation,
  resolveMarketableMtmGateThresholds,
  MARKETABLE_MTM_DEFAULT_H,
  MARKETABLE_MTM_DEFAULT_TOL,
  MARKETABLE_MTM_DEFAULT_MIN_N,
  MARKETABLE_MTM_DEFAULT_PER_STRUCTURE_MIN_N,
  MARKETABLE_MTM_OUTLIER_ABS_H,
} from './marketable-mtm-forward-validation.js';
import type { SandboxStrategyRecord, SandboxStrategyLeg } from './sandbox-strategy-journal.js';
// TRA-2600 — the REAL writer, imported so the dead-snap fixture below cannot decouple
// `requestedPx` from the quote snap the way a hand-authored leg literal can.
import { recordFromContractResult } from './sandbox-strategy-journal.js';
import { buildDecisionQuote } from './tradier-sandbox-options-smoke.js';
import type { SmokeLegResult } from './tradier-sandbox-options-smoke.js';

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

/**
 * TRA-2300 §3 — a leg as records were serialized BEFORE `4871bbc`: the `bid`/`ask` keys are
 * ABSENT, not null. `leg()` above always emits the keys (as null), which is the OTHER state.
 * The distinction is invisible to `== null` and is the whole point of the coverage split, so
 * the fixture has to be able to produce both.
 */
function legacyLeg(over: Partial<SandboxStrategyLeg>): SandboxStrategyLeg {
  const l = leg(over) as Partial<SandboxStrategyLeg>;
  delete l.bid;
  delete l.ask;
  return l as SandboxStrategyLeg;
}

function record(strategy: string, entry: SandboxStrategyLeg, exit: SandboxStrategyLeg, etDay = '2026-07-24'): SandboxStrategyRecord {
  return { ts: 1, etDay, strategy, underlying: 'AAPL', ok: true, realizedRoundTripUsd: 0, legs: [entry, exit] };
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
    // TRA-2300 §5 — `structuresBelowMinN` is now measured against the PER-STRUCTURE floor (10),
    // not the pooled minN (30): csp (n=27) clears it, long_call (n=3) does not. The threshold
    // is pinned WITH the number on the payload so the basis is never assumed.
    expect(result.structuresBelowMinN).toEqual(['long_call']);
    expect(result.perStructureMinN).toBe(MARKETABLE_MTM_DEFAULT_PER_STRUCTURE_MIN_N);
    expect(result.perStructureMinN).toBe(10);
    expect(result.requirePerStructureMinN).toBe(true);
  });

  // ── TRA-2300 §5: the floor is ON at 10, and it is a FLOOR CHECK ─────────────
  it('§5: the per-structure floor ships ON at 10 against an unchanged pooled 30', () => {
    // 40 rows split 20/20: pooled n=40 clears 30 AND each structure clears the 10-row floor,
    // so a genuinely healthy corpus is not punished by the tightening.
    const healthy = foldMarketableMtmForwardValidation(synthCorpus(0.13));
    expect(healthy.minN).toBe(MARKETABLE_MTM_DEFAULT_MIN_N);
    expect(healthy.requirePerStructureMinN).toBe(true);
    expect(healthy.structuresBelowMinN).toEqual([]);
    expect(healthy.verdict.code).toBe('PASS');
    // …and the floor is stated as a floor, not as precision.
    expect(healthy.perStructureMinNNote).toMatch(/FLOOR CHECK, not an estimate/);
    expect(healthy.perStructureMinNNote).toMatch(/do NOT estimate a 90th percentile/i);
  });

  it('§5: a structure under the floor forces REVIEW by DEFAULT — no flag needed', () => {
    // 18 rows split 9/9: pooled n=18 already fails minN=30, so use a corpus that clears the
    // pool and fails only the floor: 34 csp + 6 long_call = 40 pooled, long_call n=6 < 10.
    // "A p90 off n=6 is not a tail estimate" — the ticket's own rationale, made executable.
    const recs: SandboxStrategyRecord[] = [];
    for (let i = 0; i < 34; i++) {
      recs.push(record('csp', leg({ side: 'sell', requestedPx: 2, fillPx: 2 }),
        leg({ side: 'buy', requestedPx: 2, bid: 2 * (1 - 0.13), ask: 2 * (1 + 0.13), fillPx: 2 * (1 + 0.13) })));
    }
    for (let i = 0; i < 6; i++) {
      recs.push(record('long_call', leg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        leg({ side: 'sell', requestedPx: 2, bid: 2 * (1 - 0.13), ask: 2 * (1 + 0.13), fillPx: 2 * (1 - 0.13) })));
    }
    const shipped = foldMarketableMtmForwardValidation(recs);
    expect(shipped.n).toBe(40);
    expect(shipped.structuresBelowMinN).toEqual(['long_call']);
    expect(shipped.verdict.code).toBe('REVIEW');
    expect(shipped.verdict.reason).toMatch(/insufficient per-structure n \(< 10\): long_call \(n=6\)/);
    // The NEGATIVE CONTROL: turn the floor off and the SAME corpus passes the advisory gate.
    // Without this, "REVIEW" could be coming from anything else in the fold.
    const off = foldMarketableMtmForwardValidation(recs, { requirePerStructureMinN: false });
    expect(off.verdict.code).toBe('PASS');
  });

  it('§5: both thresholds are param- and env-overridable, and a junk override cannot DISARM the floor', () => {
    const relaxed = foldMarketableMtmForwardValidation(synthCorpus(0.13), { perStructureMinN: 25 });
    expect(relaxed.perStructureMinN).toBe(25);
    expect(relaxed.structuresBelowMinN).toEqual(['csp', 'long_call']); // n=20 each, now below 25
    expect(relaxed.verdict.code).toBe('REVIEW');

    expect(resolveMarketableMtmGateThresholds({})).toEqual({
      minN: 30, perStructureMinN: 10, requirePerStructureMinN: true,
    });
    expect(resolveMarketableMtmGateThresholds({
      MARKETABLE_MTM_MIN_N: '50',
      MARKETABLE_MTM_PER_STRUCTURE_MIN_N: '15',
      MARKETABLE_MTM_REQUIRE_PER_STRUCTURE_MIN_N: 'off',
    })).toEqual({ minN: 50, perStructureMinN: 15, requirePerStructureMinN: false });
    // A junk value must fall back to the shipped floor, NOT to NaN: `n < NaN` is false, which
    // would silently disable the check while the payload still claimed it was enforced.
    const junk = resolveMarketableMtmGateThresholds({
      MARKETABLE_MTM_PER_STRUCTURE_MIN_N: 'ten', MARKETABLE_MTM_MIN_N: '-4',
    });
    expect(junk.perStructureMinN).toBe(10);
    expect(junk.minN).toBe(30);
    expect(Number.isNaN(junk.perStructureMinN)).toBe(false);
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

// ── TRA-2300: the gate grades quotedH; actualH is advisory ───────────────────
describe('TRA-2300 — the graded basis is quotedH', () => {
  /**
   * A corpus on THIS VENUE'S ACTUAL SHAPE: every leg fills at the decision mid — so `actualH`
   * is dead by construction, exactly as observed live — while the QUOTED book is real and
   * two-sided at `quotedHs[i]`. Values are applied round-robin; with an odd-length array and
   * the i%2 structure alternation, each structure receives each value equally, so a mixed book
   * (most rows tight, a few very wide) isolates the TAIL check from the MEDIAN check.
   *
   * `mid` is constant on purpose: it makes the modeled cross constant, so a quoted-tail
   * under-charge can only come from the quoted half-spread and not from a mid that happens to
   * be larger on the wide rows.
   */
  function quotedCorpus(
    quotedHs: readonly number[], n = 40, mid = 2.0, etDay = '2026-07-26',
  ): SandboxStrategyRecord[] {
    const recs: SandboxStrategyRecord[] = [];
    for (let i = 0; i < n; i++) {
      const isLong = i % 2 === 0;
      const qh = quotedHs[i % quotedHs.length];
      const book = { bid: mid * (1 - qh), ask: mid * (1 + qh) };
      recs.push(record(
        isLong ? 'long_call' : 'csp',
        leg({ side: isLong ? 'buy' : 'sell', requestedPx: mid, ...book, fillPx: mid }),
        leg({ side: isLong ? 'sell' : 'buy', requestedPx: mid, ...book, fillPx: mid }),
        etDay,
      ));
    }
    return recs;
  }

  // ── §1: the two verdicts, and which one grades ─────────────────────────────
  it('§1: PASSES on the graded basis while the ADVISORY basis reads REVIEW on the same corpus', () => {
    // This is the whole ticket in one assertion. Fills at the mid ⇒ actualH = 0 ⇒ the advisory
    // verdict says "median 0.0000 outside ±0.03 of 0.134". The QUOTED book says 0.13, which is
    // the model being right. Grading the advisory one would reject a correct model.
    const result = foldMarketableMtmForwardValidation(quotedCorpus([0.13]));
    expect(result.gradedBasis).toBe('quotedH');
    expect(result.quotedH.n).toBe(40);
    expect(result.quotedH.median).toBeCloseTo(0.13, 12);

    expect(result.quotedVerdict.code).toBe('PASS');
    expect(result.quotedVerdict.basis).toBe('quotedH');
    expect(result.quotedVerdict.reason).toMatch(/median QUOTED h 0\.1300 within ±0\.03 of modeled 0\.134/);
    expect(result.quotedVerdict.reason).toMatch(/quoted tail covered/);

    expect(result.actualH.median).toBeCloseTo(0, 12);
    expect(result.verdict.code).toBe('REVIEW');
    expect(result.verdict.basis).toBe('actualH');
    // `verdict` keeps its name AND its meaning; `actualVerdict` is the same object named plainly.
    expect(result.actualVerdict).toBe(result.verdict);
    expect(result.verdictBasisNote).toMatch(/quotedVerdict.*IS THE GATE/s);
    expect(result.verdictBasisNote).toMatch(/ADVISORY ONLY/);
  });

  it('§1: the quoted verdict is gated on quotedH.n, NOT summary.n', () => {
    // 40 rows with a usable FILL but no usable QUOTE. `summary.n` = 40 clears minN=30, so a
    // quoted verdict gated on `summary.n` would sail past the floor and grade a median of NaN
    // (`Math.abs(NaN - 0.134) <= 0.03` is false ⇒ it would emit a REVIEW with a NaN in the
    // reason, i.e. a graded-looking verdict computed from nothing).
    const noQuotes = quotedCorpus([0.13]).map((r) => ({
      ...r, legs: r.legs.map((l) => ({ ...l, bid: null, ask: null })),
    }));
    const result = foldMarketableMtmForwardValidation(noQuotes);
    expect(result.n).toBe(40);
    expect(result.n).toBeGreaterThanOrEqual(MARKETABLE_MTM_DEFAULT_MIN_N);
    expect(result.quotedH.n).toBe(0);
    expect(result.quotedVerdict.code).toBe('REVIEW');
    expect(result.quotedVerdict.reason).toMatch(/insufficient QUOTED-basis n \(0 < 30\)/);
    expect(result.quotedVerdict.reason).not.toMatch(/NaN/);
    // Moments stay NaN — never 0. A reader must not be able to grade "no measurement" as
    // "zero spread", which at h=0.134 would read as the model being maximally wrong.
    expect(Number.isNaN(result.quotedH.median)).toBe(true);
    expect(Number.isNaN(result.quotedCrossUsd.p90)).toBe(true);
  });

  // ── §2: the quoted-basis tail check — the prove-it-fires case ──────────────
  it('§2: a genuinely WIDE quoted book forces a quoted-basis REVIEW on the TAIL ALONE', () => {
    // 80% of rows quote at exactly the modeled 0.134 and 20% at 0.40. The MEDIAN is therefore
    // EXACTLY the modeled h — the tolerance check PASSES — so the only thing that can produce a
    // REVIEW here is the tail check. A tail-blind gate would call this corpus healthy while the
    // p90 book charges 3× what the mark haircuts.
    const result = foldMarketableMtmForwardValidation(
      quotedCorpus([0.134, 0.134, 0.134, 0.134, 0.40]),
    );
    expect(result.quotedH.n).toBe(40);
    expect(result.quotedH.median).toBeCloseTo(MARKETABLE_MTM_DEFAULT_H, 12); // tolerance: PASS
    expect(Math.abs(result.quotedH.median - MARKETABLE_MTM_DEFAULT_H))
      .toBeLessThanOrEqual(MARKETABLE_MTM_DEFAULT_TOL);
    expect(result.quotedH.p90).toBeCloseTo(0.40, 12);                        // tail: FAIL
    expect(result.quotedCrossUsd.p90).toBeCloseTo(80, 9);                    // 0.40 · 2 · 100
    expect(result.modeledCrossUsdOnQuoted.p90).toBeCloseTo(26.8, 9);         // 0.134 · 2 · 100

    expect(result.quotedVerdict.code).toBe('REVIEW');
    expect(result.quotedVerdict.reason).toMatch(/under-charges the tail/);
    expect(result.quotedVerdict.reason).toMatch(/3\.0×/);
    expect(result.quotedVerdict.reason).not.toMatch(/outside ±/); // NOT the median check
  });

  it('§2: D3\'s rule carries onto the quoted basis — one under-charged structure forces REVIEW', () => {
    // D3's masking mechanism was MID SIZE, not row count. csp quotes tight (0.13) on 30 rows at
    // a $10.00 mid; long_call quotes WIDE (0.45) on 10 rows at a $1.00 mid. Because the tail
    // check is in DOLLARS, csp's 10×-larger mids dominate the pooled p90 on BOTH sides
    // (modeled $134 ≥ quoted $130 ⇒ "covered"), and the pooled quotedH median is csp's 0.13,
    // inside tol. Every pooled check reads healthy while long_call's book charges 3.4× what the
    // mark haircuts. The per-structure rule is the only thing that can catch it.
    const quoted = (mid: number, qh: number) => ({ bid: mid * (1 - qh), ask: mid * (1 + qh) });
    const recs: SandboxStrategyRecord[] = [];
    for (let i = 0; i < 30; i++) {
      recs.push(record('csp',
        leg({ side: 'sell', requestedPx: 10, ...quoted(10, 0.13), fillPx: 10 }),
        leg({ side: 'buy', requestedPx: 10, ...quoted(10, 0.13), fillPx: 10 }), '2026-07-26'));
    }
    for (let i = 0; i < 10; i++) {
      recs.push(record('long_call',
        leg({ side: 'buy', requestedPx: 1, ...quoted(1, 0.45), fillPx: 1 }),
        leg({ side: 'sell', requestedPx: 1, ...quoted(1, 0.45), fillPx: 1 }), '2026-07-26'));
    }
    const result = foldMarketableMtmForwardValidation(recs);
    // The pooled tail literally reads "covered" — this is the masking, made explicit.
    expect(result.modeledCrossUsdOnQuoted.p90).toBeGreaterThanOrEqual(result.quotedCrossUsd.p90);
    expect(result.quotedH.median).toBeCloseTo(0.13, 12);
    // The pooled quoted checks, in isolation, would PASS…
    const pooledOnly = marketableMtmQuotedVerdict(result, MARKETABLE_MTM_DEFAULT_TOL, MARKETABLE_MTM_DEFAULT_MIN_N);
    expect(pooledOnly.code).toBe('PASS');
    // …and the shipped quoted verdict still REVIEWs, naming the structure and its multiple.
    expect(result.quotedVerdict.code).toBe('REVIEW');
    expect(result.quotedVerdict.reason).toMatch(/per-structure QUOTED tail UNDER-CHARGED/);
    expect(result.quotedVerdict.reason).toMatch(/long_call/);
    const lc = result.perStructure.find((s) => s.structure === 'long_call')!;
    expect(lc.quotedTailUnderCharged).toBe(true);
    expect(lc.quotedTailUnderChargeRatio).toBeCloseTo(0.45 / 0.134, 6);
    expect(lc.quotedVerdict.code).toBe('REVIEW');
    const csp = result.perStructure.find((s) => s.structure === 'csp')!;
    expect(csp.quotedTailUnderCharged).toBe(false);
    expect(csp.quotedTailUnderChargeRatio).toBeNull();
  });

  it('§2: an UNMEASURABLE quoted tail is not reported as a covered one', () => {
    // No quotes at all ⇒ both p90s are NaN. That must NOT flag as under-charged (it is not a
    // tail failure), and must NOT be absorbed as "covered" either — the n-floor is what speaks.
    const noQuotes = quotedCorpus([0.13]).map((r) => ({
      ...r, legs: r.legs.map((l) => ({ ...l, bid: null, ask: null })),
    }));
    const result = foldMarketableMtmForwardValidation(noQuotes);
    expect(result.perStructure.every((s) => s.quotedTailUnderCharged)).toBe(false);
    expect(result.quotedVerdict.code).toBe('REVIEW');
    // Every structure is NAMED as ungradeable — "nothing was flagged" and "nothing could be
    // checked" must not read identically.
    expect(result.structuresBelowQuotedMinN.sort()).toEqual(['csp', 'long_call']);
    expect(result.quotedVerdict.reason).toMatch(/NOT gradeable/);
  });

  // ── §3: the missing-quote zero, made separable ─────────────────────────────
  it('§3: separates legacy_no_quote_field from quote_null_at_snap — same zero, opposite diagnoses', () => {
    const recs: SandboxStrategyRecord[] = [
      // 4 legacy rows: the bid/ask KEYS are absent (record predates 4871bbc). Benign.
      ...Array.from({ length: 4 }, () => record('long_call',
        legacyLeg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        legacyLeg({ side: 'sell', requestedPx: 2, fillPx: 2 }), '2026-07-20')),
      // 3 post-writer rows whose snap returned NO BOOK: keys present, values null. NOT benign.
      ...Array.from({ length: 3 }, () => record('long_call',
        leg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        leg({ side: 'sell', requestedPx: 2, bid: null, ask: null, fillPx: 2 }), '2026-07-26')),
      // 2 rows with a populated but CROSSED book — corrupt, and its own bucket so the counts
      // reconcile instead of a corrupt book hiding inside one of the other two.
      ...Array.from({ length: 2 }, () => record('long_call',
        leg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        leg({ side: 'sell', requestedPx: 2, bid: 2.5, ask: 1.5, fillPx: 2 }), '2026-07-26')),
      // 5 healthy quoted rows.
      ...Array.from({ length: 5 }, () => record('long_call',
        leg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        leg({ side: 'sell', requestedPx: 2, bid: 1.74, ask: 2.26, fillPx: 2 }), '2026-07-27')),
    ];
    const { quoteCoverage: cov, ...result } = foldMarketableMtmForwardValidation(recs);
    expect(result.n).toBe(14);
    expect(cov.legacy_no_quote_field).toBe(4);
    expect(cov.quote_null_at_snap).toBe(3);
    expect(cov.quote_unusable).toBe(2);
    expect(cov.quoted).toBe(5);
    expect(cov.quoted).toBe(result.quotedH.n);
    // Exhaustive: the four buckets RECONCILE against n, so a reader never has to infer a
    // residual (which is where a fifth, unnamed state would hide).
    expect(cov.legacy_no_quote_field + cov.quote_null_at_snap + cov.quote_unusable + cov.quoted)
      .toBe(cov.retained);
    expect(cov.retained).toBe(result.n);
    // TRA-2600 — the dead-snap cross-reference is OUTSIDE that sum (a dropped record is never
    // retained), and this corpus drops nothing, so it is a MEASURED zero. ⚠️ The 3 asserted
    // above are reachable ONLY because this fixture hand-authors `bid: null, ask: null` next to
    // `requestedPx: 2`; the real writer cannot emit that leg. See the TRA-2600 describe block.
    expect(cov.unpricedExitQuoteDropped).toBe(0);
    // The two states are INDISTINGUISHABLE through quotedH alone — that is why they are split.
    const perRow = foldMarketableMtmForwardValidation(recs, { includeSamples: true }).samples!;
    const legacyRow = perRow.find((s) => s.quoteState === 'legacy_no_quote_field')!;
    const nullRow = perRow.find((s) => s.quoteState === 'quote_null_at_snap')!;
    expect(legacyRow.quotedH).toBeNull();
    expect(nullRow.quotedH).toBeNull();      // identical observable…
    expect(legacyRow.quoteState).not.toBe(nullRow.quoteState); // …separable state
  });

  it('§3: carries the etDay bounds of the QUOTE-BEARING rows so coverage can be pinned to the deploy', () => {
    // Only quote-bearing rows may set the bounds. A legacy row dated 2026-07-20 must NOT drag
    // etDayMin below the 4871bbc boundary — if it could, "coverage starts at the deploy" would
    // be unverifiable from this payload.
    const recs: SandboxStrategyRecord[] = [
      record('long_call', legacyLeg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        legacyLeg({ side: 'sell', requestedPx: 2, fillPx: 2 }), '2026-07-20'),
      record('long_call', leg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        leg({ side: 'sell', requestedPx: 2, bid: 1.74, ask: 2.26, fillPx: 2 }), '2026-07-25'),
      record('long_call', leg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        leg({ side: 'sell', requestedPx: 2, bid: 1.74, ask: 2.26, fillPx: 2 }), '2026-07-28'),
    ];
    const cov = foldMarketableMtmForwardValidation(recs).quoteCoverage;
    expect(cov.etDayMin).toBe('2026-07-25');   // the deploy boundary, not the legacy row
    expect(cov.etDayMax).toBe('2026-07-28');
    expect(foldMarketableMtmForwardValidation([recs[0]]).quoteCoverage.etDayMin).toBeNull();
  });

  it('§3: the quoted REVIEW reason names the split, so "not yet" never reads as "dead"', () => {
    const legacyOnly = foldMarketableMtmForwardValidation(
      Array.from({ length: 8 }, () => record('long_call',
        legacyLeg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        legacyLeg({ side: 'sell', requestedPx: 2, fillPx: 2 }), '2026-07-20')),
    );
    expect(legacyOnly.quotedVerdict.reason).toMatch(/8 predate the bid\/ask writer/);
    expect(legacyOnly.quotedVerdict.reason).toMatch(/0 had a null quote AT SNAP/);
    expect(legacyOnly.quotedVerdict.reason).toMatch(/4871bbc/);
  });

  // ── §4: dispersion rules out a synthesized constant quote ──────────────────
  it('§4: quotedH.min/max expose dispersion — a constant book is visible as min === max', () => {
    const varied = foldMarketableMtmForwardValidation(quotedCorpus([0.10, 0.134, 0.18, 0.22]));
    expect(varied.quotedH.min).toBeCloseTo(0.10, 12);
    expect(varied.quotedH.max).toBeCloseTo(0.22, 12);
    expect(varied.quotedH.min).not.toBeCloseTo(varied.quotedH.max!, 6);
    // A real chain snapped at 40 decision times cannot yield min === max. If it does, the
    // "quote" is a constant somebody wrote — the moments alone would look perfectly healthy.
    const constant = foldMarketableMtmForwardValidation(quotedCorpus([0.134]));
    expect(constant.quotedH.min).toBeCloseTo(constant.quotedH.max!, 12);
    expect(constant.quotedH.median).toBeCloseTo(MARKETABLE_MTM_DEFAULT_H, 12); // reads healthy…
    expect(constant.quotedVerdict.code).toBe('PASS');                          // …and PASSES
    // `clamped` survives alongside them (TRA-2283), and min/max are null — never 0 — at n=0.
    expect(constant.quotedH.clamped).toBe(0);
    const none = foldMarketableMtmForwardValidation(quotedCorpus([0.13]).map((r) => ({
      ...r, legs: r.legs.map((l) => ({ ...l, bid: null, ask: null })),
    })));
    expect(none.quotedH.min).toBeNull();
    expect(none.quotedH.max).toBeNull();
  });

  // ── the explicitly-NOT-wanted list, pinned so a later edit cannot drift into it ──
  it('does NOT retune h off the dead actualH median, and arms nothing', () => {
    const result = foldMarketableMtmForwardValidation(quotedCorpus([0.13]));
    // h stays the modeled 0.134 even though actualH's median here is 0.0000. Retuning to that
    // would collapse the marketable(bid) haircut to indistinguishable from mid-marking.
    expect(result.modeledH).toBe(MARKETABLE_MTM_DEFAULT_H);
    expect(result.modeledH).toBe(0.134);
    expect(result.actualH.median).toBeCloseTo(0, 12);
    expect(result.verdict.reason).toMatch(/do NOT retune h/);
    expect(result.actualHCaveat).toMatch(/MUST NOT be actioned/);
    // Read-only: the fold emits no enable/arm field of any kind.
    const keys = Object.keys(result);
    expect(keys).not.toContain('enabled');
    expect(keys.filter((k) => /^(enable|arm)/i.test(k))).toEqual([]);
  });
});

// ── TRA-2600: the dead-snap state, built THROUGH the writer ──────────────────
//
// Every fixture in this block goes `buildDecisionQuote` → `recordFromContractResult`. That is
// the point of the block, not a stylistic choice. The pre-existing green test at "§3: separates
// legacy_no_quote_field from quote_null_at_snap" asserts `cov.quote_null_at_snap === 3` off a
// hand-authored `leg({ requestedPx: 2, bid: null, ask: null })` — a leg shape the writer CANNOT
// emit, because `mapLeg` takes `requestedPx`, `bid` and `ask` off one `DecisionQuote` and
// `buildDecisionQuote` nulls the mid unless both sides are > 0. That test proves the branch
// COMPUTES; it proves nothing about REACHABILITY, and reading its green as coverage is what
// kept this defect latent. These tests are built the other way round on purpose.

/** One leg through the real `buildDecisionQuote`. `raw` is the venue's snap, verbatim. */
function writerLeg(
  side: 'buy' | 'sell',
  raw: { bid?: number; ask?: number },
  fill: number | null,
): SmokeLegResult {
  const q = buildDecisionQuote(raw, 1_000);
  return {
    side,
    orderId: 1,
    status: fill != null ? 'filled' : 'pending',
    reason: null,
    avgFillPrice: fill,
    execQuantity: fill != null ? 1 : null,
    decisionQuote: q,
    timeline: { tSignal: q.tSignal, tSubmit: q.tSignal + 40, tAck: q.tSignal + 60, tFill: fill != null ? q.tSignal + 560 : null },
    metrics: {
      latencyMs: { signalToSubmit: 40, submitToAck: 20, ackToFill: fill != null ? 500 : null },
      slippage: { fillMinusMid: null, fillMinusFarTouch: null },
      withinSpread: null,
    },
  };
}

/** A journal record through the real `recordFromContractResult`. */
function writerRecord(
  strategy: string,
  entry: SmokeLegResult,
  exit: SmokeLegResult,
  etDay = '2026-07-29',
): SandboxStrategyRecord {
  const rec = recordFromContractResult(
    strategy,
    {
      ok: true,
      optionType: 'call',
      underlying: 'SPY',
      realizedRoundTripUsd: 0,
      modeledCommissionUsd: 1.3,
      contract: { optionSymbol: 'SPY260729C00500000', strike: 500, expiration: '2026-07-29', dte: 0, underlyingRefPrice: 500 },
      entry,
      exit,
    },
    etDay,
    1,
  );
  expect(rec).not.toBeNull();
  return rec!;
}

/** A healthy two-sided round-trip through the writer: exit mid 2.0, book 1.74/2.26. */
const healthyWriterRecord = (strategy = 'long_call', etDay = '2026-07-29'): SandboxStrategyRecord =>
  writerRecord(strategy, writerLeg('buy', { bid: 1.74, ask: 2.26 }, 2), writerLeg('sell', { bid: 1.74, ask: 2.26 }, 2), etDay);

describe('TRA-2600: quote_null_at_snap is writer-unreachable; the dead-venue signal is a drop count', () => {
  // The coupling itself, stated as a test rather than as a comment. If a future writer
  // decouples `requestedPx` from the snap, THIS is the test that goes red first — and
  // `quote_null_at_snap` becomes reachable, which is exactly when its doc stops being true.
  it.each([
    ['an EMPTY book (no bid at all)', { ask: 5 } as { bid?: number; ask?: number }],
    ['a ZERO bid (no buyers)', { bid: 0, ask: 5 }],
    ['a ZERO ask', { bid: 5, ask: 0 }],
  ])('the writer couples requestedPx to the snap: %s yields requestedPx null WITH the keys present', (_label, raw) => {
    const rec = writerRecord('long_call', writerLeg('buy', { bid: 1.74, ask: 2.26 }, 2), writerLeg('sell', raw, 2));
    const exit = rec.legs[1];
    expect(exit.requestedPx).toBeNull();          // no mid ⇒ the row can never be classified…
    expect('bid' in exit && 'ask' in exit).toBe(true); // …even though the KEYS are present.
    // The state the fold WOULD have assigned is never reached: the row is dropped first.
    expect(classifyRecord(rec).drop).toBe('unpriced_exit_quote');
    expect(classifyRecord(rec).sample).toBeNull();
  });

  it('a DEAD venue leaves quote_null_at_snap at 0 — it is the drop counter that moves', () => {
    const recs = [
      ...Array.from({ length: 6 }, () => healthyWriterRecord()),
      // 4 dead snaps, built through the writer. A hand-authored leg would have put these in
      // `quote_null_at_snap`; the real writer cannot.
      ...Array.from({ length: 4 }, () => writerRecord('long_call',
        writerLeg('buy', { bid: 1.74, ask: 2.26 }, 2), writerLeg('sell', { ask: 5 }, 2))),
    ];
    const f = foldMarketableMtmForwardValidation(recs);
    // ⚠️ The whole defect in one assertion pair: the bucket documented as the dead-instrument
    // signal reads ZERO on a venue that was dead for 40% of its snaps…
    expect(f.quoteCoverage.quote_null_at_snap).toBe(0);
    // …while the counter that actually carries the signal is now visible IN quoteCoverage,
    // instead of only in a different section of the payload.
    expect(f.quoteCoverage.unpricedExitQuoteDropped).toBe(4);
    expect(f.exclusions.unpriced_exit_quote).toBe(4);
    expect(f.n).toBe(6);
  });

  it('the new field sits OUTSIDE the four-state reconcile sum', () => {
    const recs = [
      ...Array.from({ length: 6 }, () => healthyWriterRecord()),
      ...Array.from({ length: 4 }, () => writerRecord('long_call',
        writerLeg('buy', { bid: 1.74, ask: 2.26 }, 2), writerLeg('sell', { bid: 0, ask: 5 }, 2))),
    ];
    const cov = foldMarketableMtmForwardValidation(recs).quoteCoverage;
    // The TRA-2300 invariant is UNCHANGED: the four STATES still sum to retained.
    expect(cov.quoted + cov.legacy_no_quote_field + cov.quote_null_at_snap + cov.quote_unusable)
      .toBe(cov.retained);
    // And the cross-reference is deliberately not in it — a dropped record is never retained.
    expect(cov.unpricedExitQuoteDropped).toBe(4);
    expect(cov.retained).toBe(6);
  });

  it('the quoted REVIEW reason for a DEAD venue differs from the one for a pure legacy drain', () => {
    // Same shortfall, same `quotedH.n`, opposite diagnoses. Before TRA-2600 these two strings
    // were IDENTICAL — both rendered "0 had a null quote AT SNAP" and nothing else moved.
    const legacyDrain = foldMarketableMtmForwardValidation(
      Array.from({ length: 8 }, () => record('long_call',
        legacyLeg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        legacyLeg({ side: 'sell', requestedPx: 2, fillPx: 2 }), '2026-07-20')),
    );
    const deadVenue = foldMarketableMtmForwardValidation([
      ...Array.from({ length: 8 }, () => record('long_call',
        legacyLeg({ side: 'buy', requestedPx: 2, fillPx: 2 }),
        legacyLeg({ side: 'sell', requestedPx: 2, fillPx: 2 }), '2026-07-20')),
      ...Array.from({ length: 5 }, () => writerRecord('long_call',
        writerLeg('buy', { bid: 1.74, ask: 2.26 }, 2), writerLeg('sell', { ask: 5 }, 2))),
    ]);

    // Identical on every pre-existing observable the reason string was built from…
    expect(deadVenue.quotedH.n).toBe(legacyDrain.quotedH.n);
    expect(deadVenue.quoteCoverage.retained).toBe(legacyDrain.quoteCoverage.retained);
    expect(deadVenue.quoteCoverage.quote_null_at_snap)
      .toBe(legacyDrain.quoteCoverage.quote_null_at_snap);

    // …and now SEPARABLE in the sentence a reader acts on. This inequality is the assertion
    // that kills the bug; the two `toMatch`es below only say WHICH way it separated.
    expect(deadVenue.quotedVerdict.reason).not.toBe(legacyDrain.quotedVerdict.reason);
    expect(deadVenue.quotedVerdict.reason).toMatch(/DEAD VENUE: a further 5 record\(s\) were DROPPED/);
    expect(legacyDrain.quotedVerdict.reason).toMatch(/No record was dropped for a missing exit quote/);
    expect(legacyDrain.quotedVerdict.reason).not.toMatch(/DEAD VENUE/);
    // Both still REVIEW — the split is diagnostic, it does not change the gate.
    expect(deadVenue.quotedVerdict.code).toBe('REVIEW');
    expect(legacyDrain.quotedVerdict.code).toBe('REVIEW');
  });

  it('per-structure drops are ATTRIBUTED, not defaulted to 0', () => {
    const recs = [
      ...Array.from({ length: 4 }, () => healthyWriterRecord('long_call')),
      ...Array.from({ length: 4 }, () => healthyWriterRecord('csp')),
      // Dead snaps on csp ONLY. A per-structure field defaulted to 0 would report both
      // structures clean; attribution has to put all 3 on csp and leave long_call at a
      // MEASURED zero.
      ...Array.from({ length: 3 }, () => writerRecord('csp',
        writerLeg('buy', { bid: 1.74, ask: 2.26 }, 2), writerLeg('sell', { ask: 5 }, 2))),
    ];
    const f = foldMarketableMtmForwardValidation(recs);
    const csp = f.perStructure.find((s) => s.structure === 'csp')!;
    const longCall = f.perStructure.find((s) => s.structure === 'long_call')!;
    expect(csp.quoteCoverage.unpricedExitQuoteDropped).toBe(3);
    expect(longCall.quoteCoverage.unpricedExitQuoteDropped).toBe(0);
    // Pooled is the total, and the per-structure counts reconcile against it.
    expect(f.quoteCoverage.unpricedExitQuoteDropped).toBe(3);
    expect(f.perStructure.reduce((a, s) => a + (s.quoteCoverage.unpricedExitQuoteDropped ?? 0), 0)).toBe(3);
    // The per-structure REVIEW reason names the dead structure and NOT the clean one.
    expect(csp.quotedVerdict.reason).toMatch(/DEAD VENUE/);
    expect(longCall.quotedVerdict.reason).not.toMatch(/DEAD VENUE/);
    expect(f.structuresFullyDeadSnapped).toEqual([]);
  });

  it('a structure with NO retained row is named, not silently absent', () => {
    // `covered_call` dead on every snap ⇒ it has no perStructure[] entry to carry a count.
    // Absence reads as "not traded", which is worse than a 0, so the fold names it.
    const f = foldMarketableMtmForwardValidation([
      ...Array.from({ length: 4 }, () => healthyWriterRecord('long_call')),
      ...Array.from({ length: 2 }, () => writerRecord('covered_call',
        writerLeg('buy', { bid: 1.74, ask: 2.26 }, 2), writerLeg('sell', { ask: 5 }, 2))),
    ]);
    expect(f.perStructure.map((s) => s.structure)).toEqual(['long_call']);
    expect(f.structuresFullyDeadSnapped).toEqual(['covered_call']);
    // Pooled MINUS the sum of per-structure counts is exactly the fully-dead structures' drops.
    const attributed = f.perStructure.reduce((a, s) => a + (s.quoteCoverage.unpricedExitQuoteDropped ?? 0), 0);
    expect((f.quoteCoverage.unpricedExitQuoteDropped ?? 0) - attributed).toBe(2);
  });

  it('a bare summarize reports null (not attributed), never a false 0', () => {
    // `summarizeMarketableMtm` folds retained samples and structurally cannot see a drop. A 0
    // here would be the same no-failing-state bug one level down, so the type admits null.
    const samples = [healthyWriterRecord()]
      .map((r) => sampleFromRecord(r))
      .filter((s): s is NonNullable<typeof s> => s != null);
    const summary = summarizeMarketableMtm(samples, MARKETABLE_MTM_DEFAULT_H);
    expect(summary.quoteCoverage.unpricedExitQuoteDropped).toBeNull();
    // …and the verdict built off it says so, rather than claiming the venue was quoting.
    const v = marketableMtmQuotedVerdict(summary, MARKETABLE_MTM_DEFAULT_TOL, MARKETABLE_MTM_DEFAULT_MIN_N);
    expect(v.reason).toMatch(/NOT ATTRIBUTED at this level/);
    expect(v.reason).not.toMatch(/DEAD VENUE/);
    expect(v.reason).not.toMatch(/No record was dropped/);
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
