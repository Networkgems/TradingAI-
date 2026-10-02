/**
 * TRA-4922 — the FLEET-FOLDED sma200 max-dist rejection surface (TRA-4921 AC7).
 *
 * The filed defect was not a wrong number, it was an ABSENT one: the substring
 * `reject` did not appear anywhere in `/api/health/sma200-forward-test`'s body
 * (re-measured 2026-10-02T05:36Z against bqb1 sha `b8996337c31c`, pid 72), so a
 * zero read there was an absent key rather than a measurement, and AC7's count
 * arm fell back to `/api/state` — ONE engine's book.
 *
 * The arms below are the ones that make a reader draw the wrong conclusion:
 *
 *  - a SIGMA over engines looks exactly like a count and is not one;
 *  - an absent key looks exactly like a zero and is not one;
 *  - the engine's bar-DAY dedupe identity and AC7's raw `barTimestamp` key
 *    disagree in precisely the population where nothing suppresses the drift;
 *  - the rejection ledger is PERSISTED while the census is not, so folding
 *    rejections behind the census gate drops real rows across a redeploy;
 *  - a ring eviction and a `forceReset` both SHRINK n, and a shrink with no
 *    published cause reads as a quiet tape.
 */
import { describe, it, expect } from 'vitest';
import { summarizeSma200Sweeps, FLEET_REJECTION_ROW_CAP } from './health-routes.js';
import type { EngineState } from '../signal-engine.js';
import type { Sma200GateRejectionRecord, Sma200RejectionLedgerMeta } from '@trading-app/shared';

const NOW = Date.UTC(2026, 9, 2, 5, 36, 0);
/** A settled daily bar. */
const BAR = Date.UTC(2026, 9, 1, 20, 0, 0);

function census(over: Record<string, unknown> = {}) {
  return {
    startedAt: NOW - 60_000,
    finishedAt: NOW - 30_000,
    considered: 0,
    evaluated: 0,
    starvedBreakerOpen: 0,
    starvedShortHistory: 0,
    fetchFailed: 0,
    fired: 0,
    voided: 0,
    maxDistAtr: 3,
    ...over,
  };
}

function rejection(over: Partial<Sma200GateRejectionRecord> = {}): Sma200GateRejectionRecord {
  return {
    symbol: 'NVDA',
    kind: 'sma200_pullback',
    barTimestamp: BAR,
    entryPrice: 180,
    stopLoss: 150,
    distAtr: 4.2,
    atr14: 7.1,
    maxDistAtr: 3,
    recordedAt: NOW - 120_000,
    ...over,
  };
}

const NO_RESET: Sma200RejectionLedgerMeta = {
  evicted: 0, resets: 0, lastResetAt: null, lastResetDropped: 0,
};

/** An engine on a build carrying BOTH the census and the rejection ledger. */
function engine(opts: {
  stats?: ReturnType<typeof census> | null;
  verdict?: 'SWEPT' | 'BLIND' | 'NO_UNIVERSE' | null;
  rejections?: Sma200GateRejectionRecord[];
  meta?: Sma200RejectionLedgerMeta;
  cap?: number;
  mode?: string;
}) {
  const stats = opts.stats === undefined ? census({ considered: 100, evaluated: 96 }) : opts.stats;
  return {
    mode: opts.mode ?? 'demo',
    state: {
      sma200ScanStats: stats,
      sma200SweepVerdict: opts.verdict === undefined ? 'SWEPT' : opts.verdict,
      sma200GateRejections: opts.rejections ?? [],
      sma200RejectionLedgerMeta: opts.meta ?? NO_RESET,
      sma200RejectionCap: opts.cap ?? 400,
    } as unknown as EngineState,
  };
}

/** A build predating TRA-4922 — neither the ledger nor the witness exists. */
function legacyEngine(mode = 'demo') {
  return {
    mode,
    state: {
      sma200ScanStats: census({ considered: 100, evaluated: 96 }),
      sma200SweepVerdict: 'SWEPT',
    } as unknown as EngineState,
  };
}

describe('TRA-4922 AC-a — the DISTINCT (symbol, barTimestamp) fleet union', () => {
  it('THE FILED DEFECT, as a test: 68 engines holding ONE rejection give sigma 68 and n 1', () => {
    // This is the whole reason a counter does not fix the ticket. 68 engines
    // sweeping overlapping universes refuse the same name on the same bar; the
    // sigma crosses AC7's n=30 on ONE market event, the distinct count does not.
    const fleet = Array.from({ length: 68 }, () => engine({
      stats: census({ considered: 100, evaluated: 96, rejectedMaxDist: 1 }),
      rejections: [rejection()],
    }));
    const r = summarizeSma200Sweeps(fleet, NOW);
    expect(r.totals.rejectedMaxDist).toBe(68);
    expect(r.totals.rejectedMaxDistIs).toBe('SIGMA_OVER_ENGINES_NOT_AC7_N');
    expect(r.rejections.distinctCount).toBe(1);
    expect(r.rejections.rowsBeforeDedupe).toBe(68);
    expect(r.rejections.contributingEngines).toBe(68);
    expect(r.rejections.rows[0]!.seenByEngines).toBe(68);
  });

  it('distinct rows survive: two symbols on one bar, one symbol on two bars = 3', () => {
    const r = summarizeSma200Sweeps([
      engine({ rejections: [rejection(), rejection({ symbol: 'AMD' })] }),
      engine({ rejections: [rejection({ barTimestamp: BAR - 86_400_000 })] }),
    ], NOW);
    expect(r.rejections.distinctCount).toBe(3);
    expect(r.rejections.rows.map(x => x.symbol)).toEqual(['NVDA', 'NVDA', 'AMD']);
    // Oldest bar first, so a cohort walk reads in accrual order.
    expect(r.rejections.rows[0]!.barTimestamp).toBe(BAR - 86_400_000);
  });

  it('BOTH MODES: a live engine contributes its rejections, it is not filtered out', () => {
    const r = summarizeSma200Sweeps([
      engine({ mode: 'live', rejections: [rejection({ symbol: 'SPY' })] }),
      engine({ mode: 'demo', rejections: [rejection({ symbol: 'QQQ' })] }),
    ], NOW);
    expect(r.liveEngines).toBe(1);
    expect(r.rejections.distinctCount).toBe(2);
  });

  it('THE RATIFIED KEY IS INFLATABLE: a drifting sub-day bar splits one logical row in two', () => {
    // TRA-1926: "Yahoo can hand back the same session with a drifting sub-day
    // timestamp". Inside ONE engine the day-keyed dedupe suppresses that; across
    // engines nothing does, and the fleet union is where it bites. So the
    // ratified (symbol, barTimestamp) key over-counts and the day-keyed number
    // is the defensible one — which is why both are published.
    const r = summarizeSma200Sweeps([
      engine({ rejections: [rejection({ barTimestamp: BAR })] }),
      engine({ rejections: [rejection({ barTimestamp: BAR + 3_600_000 })] }),
    ], NOW);
    expect(r.rejections.distinctCount).toBe(2);
    expect(r.rejections.distinctByBarDayCount).toBe(1);
  });

  it('no drift ⇒ the two keys AGREE, so a divergence is signal and not noise', () => {
    const r = summarizeSma200Sweeps([
      engine({ rejections: [rejection(), rejection({ symbol: 'AMD' })] }),
    ], NOW);
    expect(r.rejections.distinctCount).toBe(2);
    expect(r.rejections.distinctByBarDayCount).toBe(2);
  });

  it('two books measuring the SAME setup differently is flagged, not silently resolved', () => {
    const r = summarizeSma200Sweeps([
      engine({ rejections: [rejection({ distAtr: 4.2, recordedAt: NOW - 200_000 })] }),
      engine({ rejections: [rejection({ distAtr: 4.9, recordedAt: NOW - 100_000 })] }),
    ], NOW);
    expect(r.rejections.distinctCount).toBe(1);
    const row = r.rejections.rows[0]!;
    expect(row.conflicting).toBe(true);
    // The kept row is the earliest-RECORDED one, deterministically.
    expect(row.distAtr).toBe(4.2);
    expect(row.firstRecordedAt).toBe(new Date(NOW - 200_000).toISOString());
  });

  it('every field AC7 needs for the R comparison survives the fold', () => {
    const r = summarizeSma200Sweeps([engine({ rejections: [rejection()] })], NOW);
    expect(r.rejections.rows[0]).toMatchObject({
      symbol: 'NVDA', distAtr: 4.2, atr14: 7.1, maxDistAtr: 3,
      entryPrice: 180, stopLoss: 150,
    });
    expect(r.rejections.rows[0]!.barAt).toBe(new Date(BAR).toISOString());
  });

  it('THE REDEPLOY ARM: the ledger is PERSISTED and the census is NOT, so an ungraded engine still contributes', () => {
    // A just-rebooted engine carries a snapshot-restored rejection ledger and a
    // `null` census. Folding rejections behind the census gate would drop real
    // AC7 rows for as long as the first sweep takes — and a redeploy is exactly
    // when a grader looks.
    const r = summarizeSma200Sweeps([
      engine({ stats: null, verdict: null, rejections: [rejection()] }),
    ], NOW);
    expect(r.graded).toBe(0);
    expect(r.neverSwept).toBe(1);
    expect(r.verdict).toBe('NO_SWEEP_YET');
    expect(r.rejections.distinctCount).toBe(1);
  });

  it('a malformed barTimestamp is dropped from the union, never keyed as NaN', () => {
    const bad = { ...rejection(), barTimestamp: Number.NaN };
    const r = summarizeSma200Sweeps([
      engine({ rejections: [bad as Sma200GateRejectionRecord, rejection({ symbol: 'AMD' })] }),
    ], NOW);
    expect(r.rejections.distinctCount).toBe(1);
    expect(r.rejections.rows[0]!.symbol).toBe('AMD');
  });

  it('n is counted BEFORE the row clip, so a truncated read still reports the true n', () => {
    const many = Array.from({ length: FLEET_REJECTION_ROW_CAP + 7 }, (_v, i) =>
      rejection({ symbol: `S${i}` }));
    const r = summarizeSma200Sweeps([engine({ rejections: many })], NOW);
    expect(r.rejections.distinctCount).toBe(FLEET_REJECTION_ROW_CAP + 7);
    expect(r.rejections.rows.length).toBe(FLEET_REJECTION_ROW_CAP);
    expect(r.rejections.rowsTruncated).toBe(true);
  });

  it('an empty fleet publishes a ZERO, not an absent key — the defect this ticket is about', () => {
    const r = summarizeSma200Sweeps([], NOW);
    expect(r.rejections.distinctCount).toBe(0);
    expect(r.rejections.rows).toEqual([]);
    expect(r.rejections.oldestBarAt).toBeNull();
    expect(r.rejections.newestBarAt).toBeNull();
    expect(r.totals.rejectedMaxDist).toBe(0);
  });
});

describe('TRA-4922 AC-b — the sigma is published AND labelled as not-the-count', () => {
  it('ABSENT ≠ ZERO: a census without `rejectedMaxDist` is counted unpublished, not as 0', () => {
    const r = summarizeSma200Sweeps([
      engine({ stats: census({ considered: 10, evaluated: 10 }) }),               // no key
      engine({ stats: census({ considered: 10, evaluated: 10, rejectedMaxDist: 2 }) }),
    ], NOW);
    expect(r.totals.rejectedMaxDist).toBe(2);
    expect(r.totals.rejectedMaxDistUnpublished).toBe(1);
  });

  it('the label rides on the wire, where a doc comment cannot', () => {
    const r = summarizeSma200Sweeps([engine({})], NOW);
    expect(r.totals.rejectedMaxDistIs).toBe('SIGMA_OVER_ENGINES_NOT_AC7_N');
    expect(r.rejections.note).toContain('distinctCount IS the TRA-3688 AC7 n');
    expect(r.rejections.note).toContain('NOT this number');
  });
});

describe('TRA-4922 AC-c — the DISTINCT swept symbol union', () => {
  it('a union is not a sigma: overlapping universes give 4 distinct against a sigma of 6', () => {
    const r = summarizeSma200Sweeps([
      engine({ stats: census({ considered: 3, evaluated: 3, consideredSymbols: ['A', 'B', 'C'] }) }),
      engine({ stats: census({ considered: 3, evaluated: 3, consideredSymbols: ['B', 'C', 'D'] }) }),
    ], NOW);
    expect(r.universe.distinctSymbols).toBe(4);
    expect(r.universe.consideredSigma).toBe(6);
    expect(r.universe.maxEngineUniverse).toBe(3);
    expect(r.universe.minEngineUniverse).toBe(3);
    expect(r.universe.symbolsUnpublished).toBe(0);
  });

  it('per-engine universes genuinely differ in SIZE, and both ends are published', () => {
    const r = summarizeSma200Sweeps([
      engine({ stats: census({ considered: 1, evaluated: 1, consideredSymbols: ['A'] }) }),
      engine({ stats: census({ considered: 4, evaluated: 4, consideredSymbols: ['A', 'B', 'C', 'D'] }) }),
    ], NOW);
    expect(r.universe.distinctSymbols).toBe(4);
    expect(r.universe.minEngineUniverse).toBe(1);
    expect(r.universe.maxEngineUniverse).toBe(4);
  });

  it('NO graded engine publishing a symbol list reads NULL, never 0', () => {
    const r = summarizeSma200Sweeps([
      engine({ stats: census({ considered: 100, evaluated: 96 }) }),
      engine({ stats: census({ considered: 100, evaluated: 96 }) }),
    ], NOW);
    expect(r.universe.distinctSymbols).toBeNull();
    expect(r.universe.symbolsUnpublished).toBe(2);
    expect(r.universe.consideredSigma).toBe(200);
  });

  it('a PARTIAL fleet yields a lower bound that says so', () => {
    const r = summarizeSma200Sweeps([
      engine({ stats: census({ considered: 2, evaluated: 2, consideredSymbols: ['A', 'B'] }) }),
      engine({ stats: census({ considered: 500, evaluated: 500 }) }),
    ], NOW);
    expect(r.universe.distinctSymbols).toBe(2);
    expect(r.universe.symbolsUnpublished).toBe(1);
  });
});

describe('TRA-4922 AC-d + AC-e — a SHRINKING n has a named cause', () => {
  it('AC-e: a forceReset wipe is published, so the union shrinking is not read as a quiet tape', () => {
    const resetAt = NOW - 3_600_000;
    const r = summarizeSma200Sweeps([
      engine({ rejections: [rejection()] }),
      engine({
        rejections: [],
        meta: { evicted: 0, resets: 1, lastResetAt: resetAt, lastResetDropped: 12 },
      }),
    ], NOW);
    expect(r.rejections.integrity.resets).toBe(1);
    expect(r.rejections.integrity.newestResetAt).toBe(new Date(resetAt).toISOString());
    expect(r.rejections.integrity.lastResetDropped).toBe(12);
    expect(r.rejections.integrity.nonMonotonic).toBe(true);
  });

  it('AC-d: a cap eviction is published and also breaks monotonicity', () => {
    const r = summarizeSma200Sweeps([
      engine({
        rejections: [rejection()],
        meta: { evicted: 5, resets: 0, lastResetAt: null, lastResetDropped: 0 },
      }),
    ], NOW);
    expect(r.rejections.integrity.evicted).toBe(5);
    expect(r.rejections.integrity.resets).toBe(0);
    expect(r.rejections.integrity.nonMonotonic).toBe(true);
  });

  it('AC-d: a ring sitting AT the cap is flagged BEFORE it evicts anything', () => {
    const full = Array.from({ length: 4 }, (_v, i) => rejection({ symbol: `S${i}` }));
    const r = summarizeSma200Sweeps([
      engine({ cap: 4, rejections: full }),
      engine({ cap: 4, rejections: [rejection()] }),
    ], NOW);
    expect(r.rejections.integrity.cap).toBe(4);
    expect(r.rejections.integrity.enginesAtCap).toBe(1);
    // Nothing has been lost yet — the warning must not masquerade as a loss.
    expect(r.rejections.integrity.evicted).toBe(0);
    expect(r.rejections.integrity.nonMonotonic).toBe(false);
  });

  it('a MIXED-build fleet publishes the SMALLEST cap — the weakest book bounds the evidence', () => {
    const r = summarizeSma200Sweeps([
      engine({ cap: 400, rejections: [rejection()] }),
      engine({ cap: 50, rejections: [] }),
    ], NOW);
    expect(r.rejections.integrity.cap).toBe(50);
  });

  it('a clean fleet is monotonic ONLY when nothing is unpublished', () => {
    const clean = summarizeSma200Sweeps([engine({ rejections: [rejection()] })], NOW);
    expect(clean.rejections.integrity.nonMonotonic).toBe(false);
    expect(clean.rejections.integrity.metaUnpublished).toBe(0);

    // A legacy book could have reset without saying so, so `nonMonotonic: false`
    // on its own is NOT an all-clear — `metaUnpublished` is the second read.
    const mixed = summarizeSma200Sweeps([engine({ rejections: [rejection()] }), legacyEngine()], NOW);
    expect(mixed.rejections.integrity.nonMonotonic).toBe(false);
    expect(mixed.rejections.integrity.metaUnpublished).toBe(1);
    expect(mixed.rejections.ledgerUnpublished).toBe(1);
  });

  it('ABSENT ≠ EMPTY: a legacy build is ledgerUnpublished, not an engine that refused nothing', () => {
    const r = summarizeSma200Sweeps([legacyEngine(), legacyEngine()], NOW);
    expect(r.rejections.ledgerUnpublished).toBe(2);
    expect(r.rejections.contributingEngines).toBe(0);
    expect(r.rejections.distinctCount).toBe(0);
    expect(r.rejections.integrity.cap).toBeNull();
  });
});
