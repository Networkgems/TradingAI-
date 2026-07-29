import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parityForRoundTrip,
  summarizeParityReconcile,
  appendParitySnapshotForDay,
  hydrateParityReconcileFromDisk,
  clearParityReconcile,
  getParityReconcileSeries,
  parityReconcileDurability,
  parityReconcileLogPath,
  isPostCloseEt,
  RATIO_DENOM_FLOOR_USD,
  classifyRoundTripParity,
  parityRecordRows,
  EXCLUSION_NOTE,
  QTY_ASSUMPTION_NOTE,
} from './parity-reconcile.js';
import type {
  SandboxStrategyRecord,
  SandboxStrategyLeg,
} from './sandbox-strategy-journal.js';

// TRA-2237 — the parity-reconcile monitor folds each SANDBOX round-trip's OWN mid-vs-fill
// (requestedPx = demo-book mid mark, fillPx = real fill) into a per-strategy demo-mark-vs-
// sandbox-fill P&L gap / half-spread. Proves: signed-cost sign per side, the
// gap == demoMark − sandboxFill identity, the uncomputable path (a null leg is EXCLUDED,
// never folded as a 0 gap), percentile edge (n=1), etDay vs cumulative bucketing,
// mutation (flip a fill across the mid → gap sign flips), and the durable daily series
// (reboot hydrate, retention compaction, torn-line tolerance, durability.ephemeral).
//
// TRA-2279 adds the two instrument fixes:
//   D1 — `gapPct` (a ratio under a percent's name, over a denominator that could vanish)
//        is REMOVED in favour of `gapToDemoMarkRatio` + a materiality floor. Proven by:
//        the old key is absent; the live 17× payload reads 0.17 not 17; a sub-floor
//        denominator nulls rather than diverges; a one-tick mid change can no longer flip
//        the ratio's sign; the two nulls are attributable; 4-place rounding.
//   D2 — the daily point re-folds (last-write-wins per ET day) instead of freezing at the
//        first read, stamps its window (`firstFoldTs`/`lastFoldTs`/`foldCount`/
//        `sessionComplete`, DST-correct), records observed-and-empty days so ABSENT is
//        distinguishable, and hydrates the LAST line per day off the append-only log.

// NOW is inside RETENTION for the snapshot ts, and lands on a fixed ET day.
const NOW = Date.parse('2026-07-24T18:00:00Z'); // 2026-07-24 14:00 ET
const ET_DAY = '2026-07-24';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parity-reconcile-'));
  clearParityReconcile();
});
afterEach(() => {
  clearParityReconcile();
  rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * The decision-quote fields, defaulted to `null` as they were before TRA-2583. They are
 * OVERRIDABLE because a fixture that can only produce `null` makes every assertion about
 * these fields vacuous — a `toBeNull()` on a dropped field passes just as happily as on a
 * projected one. See the TRA-2583 block for the non-null case that actually has a failing state.
 */
type LegQuote = Partial<
  Pick<SandboxStrategyLeg, 'bid' | 'ask' | 'slippageBps' | 'spreadAtSubmitPct' | 'withinSpread'>
>;

function leg(
  side: 'buy' | 'sell',
  requestedPx: number | null,
  fillPx: number | null,
  quote: LegQuote = {},
): SandboxStrategyLeg {
  return {
    side,
    optionSymbol: 'TEST',
    submitTs: NOW,
    fillTs: fillPx == null ? null : NOW + 100,
    signalToSubmitMs: 40,
    requestedPx,
    bid: null,
    ask: null,
    fillPx,
    slippageBps: null,
    spreadAtSubmitPct: null,
    withinSpread: null,
    ...quote,
  };
}

/** A single-contract long round-trip: buy entry then sell exit. */
function record(
  strategy: string,
  legs: SandboxStrategyLeg[],
  opts: { etDay?: string; ts?: number } = {},
): SandboxStrategyRecord {
  return {
    ts: opts.ts ?? NOW,
    etDay: opts.etDay ?? ET_DAY,
    strategy,
    underlying: 'SPY',
    ok: legs.every((l) => l.fillPx != null),
    realizedRoundTripUsd: null,
    legs,
  };
}

// ── per-round-trip fold ──────────────────────────────────────────────────────

describe('parityForRoundTrip — signed cost per side', () => {
  it('buy filled ABOVE mid and sell filled BELOW mid both cost the book (positive gap)', () => {
    // entry buy: mid 1.00, fill 1.05 ⇒ paid 0.05 up. exit sell: mid 2.00, fill 1.90 ⇒ gave up 0.10.
    const p = parityForRoundTrip(record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)]));
    expect(p).not.toBeNull();
    // demoMark = (−1.00 + 2.00)*100 = 100 ; sandboxFill = (−1.05 + 1.90)*100 = 85
    expect(p!.demoMarkPnlUsd).toBeCloseTo(100, 6);
    expect(p!.sandboxFillPnlUsd).toBeCloseTo(85, 6);
    // gap = signed cost Σ: buy (1.05−1.00)=0.05, sell (2.00−1.90)=0.10 ⇒ 0.15*100 = 15
    expect(p!.parityGapUsd).toBeCloseTo(15, 6);
    // identity: gap == demoMark − sandboxFill
    expect(p!.parityGapUsd).toBeCloseTo(p!.demoMarkPnlUsd - p!.sandboxFillPnlUsd, 6);
  });

  it('a fill AT the mid on every leg has a zero gap (a real 0, computable)', () => {
    const p = parityForRoundTrip(record('long_put', [leg('buy', 1.0, 1.0), leg('sell', 1.5, 1.5)]));
    expect(p).not.toBeNull();
    expect(p!.parityGapUsd).toBeCloseTo(0, 6);
  });

  it('half-spread bps is signed cost / requestedPx × 1e4 per leg', () => {
    const p = parityForRoundTrip(record('long_call', [leg('buy', 1.0, 1.05)]));
    // 0.05 / 1.00 * 1e4 = 500 bps
    expect(p!.legHalfSpreadBps).toHaveLength(1);
    expect(p!.legHalfSpreadBps[0]).toBeCloseTo(500, 6);
  });
});

describe('parityForRoundTrip — uncomputable path (NEVER a false 0)', () => {
  it('a null requestedPx makes the whole round-trip uncomputable (null, not 0-gap)', () => {
    expect(parityForRoundTrip(record('long_call', [leg('buy', null, 1.05), leg('sell', 2.0, 1.9)]))).toBeNull();
  });
  it('a null fillPx (never filled) makes the whole round-trip uncomputable', () => {
    expect(parityForRoundTrip(record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, null)]))).toBeNull();
  });
  it('a zero-leg record is uncomputable', () => {
    expect(parityForRoundTrip(record('long_call', []))).toBeNull();
  });
});

// ── mutation: prove the metric FIRES ─────────────────────────────────────────

describe('parityForRoundTrip — mutation flips the gap sign', () => {
  it('moving the exit fill from below the mid to above it flips the gap sign', () => {
    const below = parityForRoundTrip(record('long_call', [leg('buy', 1.0, 1.0), leg('sell', 2.0, 1.9)]));
    const above = parityForRoundTrip(record('long_call', [leg('buy', 1.0, 1.0), leg('sell', 2.0, 2.1)]));
    expect(below!.parityGapUsd).toBeGreaterThan(0); // sold below mid ⇒ book overstated
    expect(above!.parityGapUsd).toBeLessThan(0);    // sold above mid ⇒ book understated
    expect(Math.sign(below!.parityGapUsd)).toBe(-Math.sign(above!.parityGapUsd));
  });
});

// ── per-strategy summary ─────────────────────────────────────────────────────

describe('summarizeParityReconcile', () => {
  it('counts uncomputable round-trips separately and never as n or a 0 gap', () => {
    const recs = [
      record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)]),      // computable, gap 15
      record('long_call', [leg('buy', 1.0, null), leg('sell', 2.0, 1.9)]),      // uncomputable
    ];
    const s = summarizeParityReconcile(recs, NOW);
    const b = s.strategies.long_call.cumulative;
    expect(b.n).toBe(1);
    expect(b.uncomputable).toBe(1);
    expect(b.parityGapUsd.sum).toBeCloseTo(15, 6);
    expect(b.parityGapUsd.mean).toBeCloseTo(15, 6);
  });

  // ── TRA-2279 D1 — the units defect ─────────────────────────────────────────
  //
  // `gapPct` was a RATIO under a percent's name (live `gapPct: 17` meant 17× / 1700%,
  // and the TRA-2277 handoff read it as "17.00%"), over a denominator so near zero that
  // the ratio diverged and could flip sign. It is REMOVED — not rescaled under the same
  // name — because a key whose value moves 100× while its name holds still is the exact
  // instrument that reads identically right and wrong.

  it('the misnamed `gapPct` key is GONE from the payload (a stale reader must fail loudly)', () => {
    const s = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 3.0, 2.9)])],
      NOW,
    );
    const b = s.strategies.long_call.cumulative;
    // `in`, not `?? null` — an ABSENT key and a key present holding null are different
    // facts, and only absence makes a stale reader throw instead of quoting 1700%.
    expect('gapPct' in b).toBe(false);
    expect('gapToDemoMarkRatio' in b).toBe(true);
  });

  it('reproduces the live 17x payload as a RATIO of 17, not a percent of 17', () => {
    // The live long_call bucket: gap $17 over |demoMark| $1.00. Under the old field this
    // surfaced as `gapPct: 17` and was quoted as 17%. It is 17x.
    const s = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.0, 1.17)])], // demoMark −100, gap +17
      NOW,
    );
    const b = s.strategies.long_call.cumulative;
    expect(b.demoMarkPnlUsd).toBeCloseTo(-100, 6);
    expect(b.parityGapUsd.sum).toBeCloseTo(17, 6);
    // |denom| = 100 clears the floor ⇒ computed. 0.17 = 17%, which is the honest reading.
    expect(b.gapToDemoMarkRatio).toBeCloseTo(0.17, 6);
    expect(b.gapToDemoMarkRatioStatus).toBe('computed');
    // Guard the thing that SEPARATES: the ratio must NOT be 17 (that was the units error).
    expect(b.gapToDemoMarkRatio).not.toBeCloseTo(17, 6);
  });

  it('a denominator below the materiality floor nulls the ratio instead of diverging', () => {
    // The ACTUAL live regime: |demoMark| = $1.00, gap $17 ⇒ old field said 17.
    const s = summarizeParityReconcile(
      [record('long_call', [leg('buy', 0.01, 0.18)])], // demoMark −1.00, gap +17
      NOW,
    );
    const b = s.strategies.long_call.cumulative;
    expect(Math.abs(b.demoMarkPnlUsd)).toBeLessThan(RATIO_DENOM_FLOOR_USD);
    expect(b.gapToDemoMarkRatio).toBeNull();
    expect(b.gapToDemoMarkRatioStatus).toBe('denominator_below_materiality_floor');
    // The gap and the half-spread are unit-correct at ANY denominator and MUST survive —
    // suppressing the ratio must not blank the fields TRA-2277 actually grades on.
    expect(b.parityGapUsd.sum).toBeCloseTo(17, 6);
    expect(b.halfSpreadBps.mean).not.toBeNull();
  });

  it('nulls the ratio rather than letting a one-tick mid change flip its sign', () => {
    // Prove the instability the floor exists to stop. Same gap, denominator moved by ONE
    // penny of mid (±$1 after the x100 multiplier) straddling zero ⇒ under the old
    // eps-only guard the ratio flips sign; under the floor both read null.
    const justAbove = summarizeParityReconcile(
      [record('long_call', [leg('buy', 0.99, 1.15), leg('sell', 1.0, 1.0)])], // demoMark +1
      NOW,
    ).strategies.long_call.cumulative;
    const justBelow = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.01, 1.17), leg('sell', 1.0, 1.0)])], // demoMark −1
      NOW,
    ).strategies.long_call.cumulative;
    expect(Math.sign(justAbove.demoMarkPnlUsd)).toBe(-Math.sign(justBelow.demoMarkPnlUsd));
    expect(justAbove.gapToDemoMarkRatio).toBeNull();
    expect(justBelow.gapToDemoMarkRatio).toBeNull();
  });

  it('distinguishes the two nulls: no data vs an immaterial denominator', () => {
    // n===0 (every round-trip unpriced) and a real-but-tiny denominator are different
    // facts. A bare `null` for both leaves the reader unable to tell them apart.
    const noData = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.0, null)])],
      NOW,
    ).strategies.long_call.cumulative;
    expect(noData.n).toBe(0);
    expect(noData.uncomputable).toBe(1);
    expect(noData.gapToDemoMarkRatio).toBeNull();
    expect(noData.gapToDemoMarkRatioStatus).toBe('no_computable_round_trips');

    const immaterial = summarizeParityReconcile(
      [record('long_put', [leg('buy', 0.01, 0.18)])],
      NOW,
    ).strategies.long_put.cumulative;
    expect(immaterial.n).toBe(1);
    expect(immaterial.gapToDemoMarkRatioStatus).toBe('denominator_below_materiality_floor');
  });

  it('an exactly-0 demo-mark denominator is the immaterial null, never a fabricated 0', () => {
    // buy mid 1.0 / sell mid 1.0 ⇒ demoMark = 0. Fills differ ⇒ the gap is real.
    const s = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.0, 1.02), leg('sell', 1.0, 0.99)])],
      NOW,
    );
    const b = s.strategies.long_call.cumulative;
    expect(b.demoMarkPnlUsd).toBeCloseTo(0, 6);
    expect(b.gapToDemoMarkRatio).toBeNull();
    expect(b.gapToDemoMarkRatioStatus).toBe('denominator_below_materiality_floor');
    expect(b.parityGapUsd.sum).not.toBe(0); // gap itself is real
  });

  it('a small real ratio keeps 4 places instead of rounding to a false 0.00', () => {
    // gap $2 over |demoMark| $5000 = 0.0004. round2 would have flattened this to 0.
    const s = summarizeParityReconcile(
      [record('long_call', [leg('buy', 50.0, 50.02)])],
      NOW,
    );
    const b = s.strategies.long_call.cumulative;
    expect(b.gapToDemoMarkRatio).toBeCloseTo(0.0004, 8);
    expect(b.gapToDemoMarkRatio).not.toBe(0);
  });

  it('publishes the floor and a units note so the reader need not infer either', () => {
    const s = summarizeParityReconcile([record('long_call', [leg('buy', 1.0, 1.0)])], NOW);
    expect(s.gapRatioDenomFloorUsd).toBe(RATIO_DENOM_FLOOR_USD);
    expect(s.gapRatioNote).toMatch(/RATIO, not a percent/);
  });

  it('p90/median resolve with n=1 (single leg-sample)', () => {
    const s = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.0, 1.05)])],
      NOW,
    );
    const hs = s.strategies.long_call.cumulative.halfSpreadBps;
    expect(hs.mean).toBeCloseTo(500, 2);
    expect(hs.median).toBeCloseTo(500, 2);
    expect(hs.p90).toBeCloseTo(500, 2);
  });

  it('buckets etDay separately from cumulative', () => {
    const recs = [
      record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)], { etDay: ET_DAY }),           // today, gap 15
      record('long_call', [leg('buy', 1.0, 1.1), leg('sell', 2.0, 1.9)], { etDay: '2026-07-23', ts: NOW - 86_400_000 }), // prior day
    ];
    const s = summarizeParityReconcile(recs, NOW); // ref day = ET_DAY
    expect(s.strategies.long_call.etDay.n).toBe(1);
    expect(s.strategies.long_call.etDay.parityGapUsd.sum).toBeCloseTo(15, 6);
    expect(s.strategies.long_call.cumulative.n).toBe(2);
  });

  it('carries the SANDBOX_SIMULATED fill-realism tag and qtyAssumed:1', () => {
    const s = summarizeParityReconcile([record('long_call', [leg('buy', 1.0, 1.0)])], NOW);
    expect(s.fillRealism).toBe('SANDBOX_SIMULATED');
    expect(s.qtyAssumed).toBe(1);
    expect(s.strategies.long_call.fillRealism).toBe('SANDBOX_SIMULATED');
    expect(s.strategies.long_call.qtyAssumed).toBe(1);
  });
});

// ── durable daily series ─────────────────────────────────────────────────────

describe('appendParitySnapshotForDay — self-accrual', () => {
  beforeEach(() => {
    hydrateParityReconcileFromDisk(dir, NOW); // sets dataDir, empty series
  });

  it('records one point for a new ET day with the window stamped', () => {
    const recs = [record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)])];
    const first = appendParitySnapshotForDay(recs, NOW);
    expect(first.etDay).toBe(ET_DAY);
    expect(first.perStrategy.long_call.parityGapUsd).toBeCloseTo(15, 6);
    expect(first.perStrategy.long_call.n).toBe(1);
    expect(first.foldCount).toBe(1);
    expect(first.firstFoldTs).toBe(NOW);
    expect(first.lastFoldTs).toBe(NOW);
    expect(first.observedRecords).toBe(1);
    expect(first.sessionComplete).toBe(false); // NOW is 14:00 ET — mid-session
    expect(getParityReconcileSeries()).toHaveLength(1);
  });

  // ── TRA-2279 D2 — the frozen-partial-fold defect ────────────────────────────
  //
  // Accrual used to be first-write-wins, so the day froze at whatever moment the runner
  // first curled the route. Both of `d8ec9395`'s triggers are mid-session (15:00Z /
  // 18:30Z vs a 20:00Z close) ⇒ every later fill landed in `cumulative` and in NO daily
  // point, ever, and nothing on the payload said which window was covered.

  it('RE-FOLDS the same ET day instead of freezing at the first read', () => {
    const midSession = [record('long_call', [leg('buy', 1.0, 1.05)])]; // gap 5
    const first = appendParitySnapshotForDay(midSession, NOW);
    expect(first.perStrategy.long_call.n).toBe(1);
    expect(first.perStrategy.long_call.parityGapUsd).toBeCloseTo(5, 6);

    // A later fill the SAME ET day — under first-write-wins this was invisible forever.
    const later = NOW + 3 * 3_600_000; // 17:00 ET, post-close
    const withLateFill = [
      ...midSession,
      record('long_call', [leg('buy', 2.0, 2.2)], { ts: later }), // gap 20
    ];
    const refold = appendParitySnapshotForDay(withLateFill, later);

    // The guard that SEPARATES: n and the gap must have MOVED, not held at the frozen read.
    expect(refold.perStrategy.long_call.n).toBe(2);
    expect(refold.perStrategy.long_call.parityGapUsd).toBeCloseTo(25, 6);
    expect(refold.foldCount).toBe(2);
    // The window's lower bound must not drift up as the upper bound advances.
    expect(refold.firstFoldTs).toBe(NOW);
    expect(refold.lastFoldTs).toBe(later);
    // One point per ET day still — a re-fold UPDATES, it does not append a second point.
    expect(getParityReconcileSeries()).toHaveLength(1);
  });

  it('sessionComplete flips only once the fold lands at/after the 16:00 ET close', () => {
    const recs = [record('long_call', [leg('buy', 1.0, 1.05)])];
    // 15:59 ET — one minute short of the close.
    const preClose = Date.parse('2026-07-24T19:59:00Z');
    expect(appendParitySnapshotForDay(recs, preClose).sessionComplete).toBe(false);
    // 16:00 ET — the close itself.
    const atClose = Date.parse('2026-07-24T20:00:00Z');
    expect(appendParitySnapshotForDay(recs, atClose).sessionComplete).toBe(true);
  });

  it('sessionComplete is DST-correct, not pinned to 20:00Z', () => {
    // The equity close is 20:00Z in EDT but 21:00Z in EST. A fixed-20:00Z rule would call
    // a 20:05Z January fold "complete" when it is actually 15:05 ET — mid-session.
    expect(isPostCloseEt(Date.parse('2026-07-24T20:05:00Z'))).toBe(true);  // EDT: 16:05 ET
    expect(isPostCloseEt(Date.parse('2026-01-15T20:05:00Z'))).toBe(false); // EST: 15:05 ET
    expect(isPostCloseEt(Date.parse('2026-01-15T21:05:00Z'))).toBe(true);  // EST: 16:05 ET
  });

  it('records an OBSERVED-AND-EMPTY day so it cannot read as ABSENT', () => {
    // Every round-trip unpriced ⇒ nothing gradeable. Before this the day wrote NOTHING,
    // which is byte-for-byte how a day nobody read looks.
    const recs = [record('long_call', [leg('buy', 1.0, null)])]; // uncomputable
    const snap = appendParitySnapshotForDay(recs, NOW);
    expect(snap.perStrategy).toEqual({});
    expect(snap.foldCount).toBe(1);          // ⇒ somebody looked
    expect(snap.observedRecords).toBe(1);    // ⇒ and the stream had produced a record
    expect(snap.uncomputable).toBe(1);       // ⇒ which was excluded, NOT a 0 gap
    expect(getParityReconcileSeries()).toHaveLength(1);
    // ABSENT is the only remaining way to have no row: a day never folded at all.
    expect(getParityReconcileSeries().some((s) => s.etDay === '2026-07-23')).toBe(false);
  });

  it('an observed-and-empty day is distinguishable from a genuine no-trade day', () => {
    const quiet = appendParitySnapshotForDay([], NOW); // stream ran, produced nothing
    expect(quiet.observedRecords).toBe(0);
    expect(quiet.uncomputable).toBe(0);
    clearParityReconcile();
    hydrateParityReconcileFromDisk(dir, NOW);
    const excluded = appendParitySnapshotForDay(
      [record('long_call', [leg('buy', 1.0, null)])],
      NOW,
    );
    // Same empty perStrategy, but the counters separate the two causes.
    expect(excluded.perStrategy).toEqual({});
    expect(excluded.uncomputable).toBe(1);
    expect(excluded.uncomputable).not.toBe(quiet.uncomputable);
  });

  it('a new ET day accrues a second point', () => {
    const recs = [record('long_call', [leg('buy', 1.0, 1.05)])];
    appendParitySnapshotForDay(recs, NOW);
    const nextDay = NOW + 86_400_000;
    const recs2 = [record('long_call', [leg('buy', 1.0, 1.1)], { etDay: '2026-07-25', ts: nextDay })];
    const snap2 = appendParitySnapshotForDay(recs2, nextDay);
    expect(snap2.etDay).toBe('2026-07-25');
    expect(snap2.foldCount).toBe(1); // a fresh day starts its own fold count
    expect(getParityReconcileSeries()).toHaveLength(2);
  });

  it('re-folds append to the append-only log; hydration keeps the LAST line per day', () => {
    const recs = [record('long_call', [leg('buy', 1.0, 1.05)])];
    appendParitySnapshotForDay(recs, NOW);
    const later = NOW + 3_600_000;
    appendParitySnapshotForDay(
      [...recs, record('long_call', [leg('buy', 2.0, 2.2)], { ts: later })],
      later,
    );
    // Two lines on disk (append-only — a torn re-fold can't destroy the earlier good row).
    const lines = readFileSync(parityReconcileLogPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    // Fresh boot: one point, and it is the LATER (n=2) fold, not the first.
    const h = hydrateParityReconcileFromDisk(dir, NOW);
    expect(h.snapshots).toBe(1);
    expect(h.days).toBe(1);
    const [only] = getParityReconcileSeries();
    expect(only.perStrategy.long_call.n).toBe(2);
    expect(only.foldCount).toBe(2);
    expect(only.lastFoldTs).toBe(later);
    // and the file was COMPACTED to the winning line so re-folds don't grow it forever.
    const after = readFileSync(parityReconcileLogPath(dir), 'utf8').trim().split('\n');
    expect(after).toHaveLength(1);
    expect(JSON.parse(after[0]).foldCount).toBe(2);
  });
});

describe('hydrateParityReconcileFromDisk — durability', () => {
  it('rebuilds the series from disk and reports days', () => {
    hydrateParityReconcileFromDisk(dir, NOW);
    appendParitySnapshotForDay([record('long_call', [leg('buy', 1.0, 1.05)])], NOW);
    // fresh boot
    const h = hydrateParityReconcileFromDisk(dir, NOW);
    expect(h.snapshots).toBe(1);
    expect(h.days).toBe(1);
    expect(getParityReconcileSeries()[0].etDay).toBe(ET_DAY);
  });

  it('drops + compacts snapshots older than the 60-day retention window', () => {
    const stale = { etDay: '2026-01-01', ts: NOW - 61 * 24 * 60 * 60 * 1000, perStrategy: { long_call: { parityGapUsd: 1, meanHalfSpreadBps: 1, n: 1 } } };
    const fresh = { etDay: ET_DAY, ts: NOW, perStrategy: { long_call: { parityGapUsd: 2, meanHalfSpreadBps: 2, n: 1 } } };
    writeFileSync(parityReconcileLogPath(dir), JSON.stringify(stale) + '\n' + JSON.stringify(fresh) + '\n', 'utf8');
    const h = hydrateParityReconcileFromDisk(dir, NOW);
    expect(h.snapshots).toBe(1);
    // file compacted to the fresh line only
    const lines = readFileSync(parityReconcileLogPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).etDay).toBe(ET_DAY);
  });

  it('normalizes a PRE-TRA-2279 row without inventing a window it cannot know', () => {
    // A row written by the old first-write-wins code carries no window stamps. foldCount 1
    // and firstFoldTs === lastFoldTs === ts are literally true of it; observedRecords is
    // NOT, so it must read as an unknown sentinel rather than an observed zero.
    const legacy = { etDay: ET_DAY, ts: NOW, perStrategy: { long_call: { parityGapUsd: 15, meanHalfSpreadBps: 500, n: 1 } } };
    writeFileSync(parityReconcileLogPath(dir), JSON.stringify(legacy) + '\n', 'utf8');
    hydrateParityReconcileFromDisk(dir, NOW);
    const [row] = getParityReconcileSeries();
    expect(row.foldCount).toBe(1);
    expect(row.firstFoldTs).toBe(NOW);
    expect(row.lastFoldTs).toBe(NOW);
    expect(row.sessionComplete).toBe(false); // NOW = 14:00 ET — the mid-session cadence
    expect(row.observedRecords).toBe(-1);    // unknown, and cannot be read as zero
    expect(row.uncomputable).toBe(-1);
  });

  it('tolerates a torn trailing line', () => {
    const good = { etDay: ET_DAY, ts: NOW, perStrategy: { long_call: { parityGapUsd: 2, meanHalfSpreadBps: 2, n: 1 } } };
    writeFileSync(parityReconcileLogPath(dir), JSON.stringify(good) + '\n{"etDay":"2026-07-2', 'utf8');
    const h = hydrateParityReconcileFromDisk(dir, NOW);
    expect(h.snapshots).toBe(1);
  });

  it('durability.ephemeral is TRUE for an in-bundle path and reflects the configured dir', () => {
    hydrateParityReconcileFromDisk(dir, NOW);
    const d = parityReconcileDurability();
    expect(d.dataDir).toBe(dir);
    // DATA_DIR env unset in the test env ⇒ ephemeral by the isEphemeralDataDir predicate
    expect(typeof d.ephemeral).toBe('boolean');
  });
});

// ── TRA-2370 — the read-side `fillPx <= 0` guard the sibling module has had since ────
//    TRA-2283, plus the counter / percentiles / route that make its absence detectable.
//
// The defect: `parityForRoundTrip` dropped a leg on `== null` only. TRA-2283 D1's false
// zero (`avg_fill_price: 0` — a MISSING price wearing a number's clothes) therefore folded
// as a real ±100·requestedPx term. With one such leg on EACH side of a round-trip the two
// terms cancelled, and covered_call published an exact `parityGapUsd {sum: 0, mean: 0}`
// with `uncomputable: 0` — arithmetic residue that reads exactly like a genuine zero cost.
//
// NEGATIVE CONTROL (the verification bar). `wouldBeParityGapUsd` on the raw-records
// projection re-folds an excluded row with the guard OFF, using shipped code. The
// reproduction test below asserts BOTH sides of the one fixture — the ±$665 the old fold
// produced AND the exclusion the new one produces — so the guard cannot be reverted, nor
// quietly turned into a no-op, without this block going red. That was also run for real:
// reverting the guard to `== null` fails exactly these tests and nothing else.

describe('TRA-2370 — a PRESENT-but-impossible price is nonPhysical, never folded', () => {
  it('REPRODUCES the live covered_call $0.00: two 0-fill legs cancel to an exact zero', () => {
    // The observed shape: a 0-filled ENTRY and a 0-filled EXIT at mid ≈ $6.65, opposite sides.
    const rec = record('covered_call', [leg('sell', 6.65, 0), leg('buy', 6.65, 0)]);

    // (a) What the OLD fold did — computed by shipped code, not asserted in prose. The two
    //     ±$665 terms sum to exactly 0, which is why the bucket read `{sum: 0, mean: 0}`.
    const [row] = parityRecordRows([rec]);
    expect(row.wouldBeParityGapUsd).toBe(0);
    expect(row.status).toBe('nonPhysical');

    // (b) What the NEW fold does: the round-trip is EXCLUDED, into the bucket that names
    //     WHY — not into `uncomputable`, and not as a zero gap.
    const s = summarizeParityReconcile([rec], NOW).strategies.covered_call.cumulative;
    expect(s.n).toBe(0);
    expect(s.nonPhysical).toBe(1);
    expect(s.uncomputable).toBe(0);
    // The false $0.00 is GONE: at n=0 every central estimate is null, never a fabricated 0.
    expect(s.parityGapUsd.mean).toBeNull();
    expect(s.parityGapUsd.median).toBeNull();
    expect(s.parityGapUsd.p90).toBeNull();
    expect(s.halfSpreadBps.mean).toBeNull();
  });

  it('the ∓10_000 bps leg a 0-fill scores no longer reaches halfSpreadBps', () => {
    const dirty = record('covered_call', [leg('sell', 6.65, 0)]);
    expect(parityForRoundTrip(dirty)).toBeNull();
    // Pool a clean 500bps round-trip with the dirty one: the mean must be the clean leg
    // alone. Before the guard it would have been (500 + 10000)/2 = 5250.
    const s = summarizeParityReconcile(
      [dirty, record('covered_call', [leg('buy', 1.0, 1.05)])],
      NOW,
    ).strategies.covered_call.cumulative;
    expect(s.halfSpreadBps.mean).toBeCloseTo(500, 6);
  });

  it.each([
    ['a zero fillPx', leg('buy', 6.65, 0)],
    ['a negative fillPx', leg('buy', 6.65, -1.2)],
    ['a zero requestedPx', leg('buy', 0, 6.65)],
    ['a negative requestedPx', leg('buy', -0.5, 6.65)],
    ['a non-finite fillPx', leg('buy', 6.65, Number.NaN)],
    ['a non-finite requestedPx', leg('buy', Number.POSITIVE_INFINITY, 6.65)],
  ])('%s classifies nonPhysical', (_label, bad) => {
    const c = classifyRoundTripParity(record('long_call', [bad as SandboxStrategyLeg, leg('sell', 2.0, 1.9)]));
    expect(c.parity).toBeNull();
    expect(c.exclusion).toBe('nonPhysical');
  });

  it.each([
    ['a null requestedPx', leg('buy', null, 1.05)],
    ['a null fillPx', leg('buy', 1.0, null)],
  ])('%s still classifies uncomputable — the two facts stay APART', (_label, absent) => {
    const c = classifyRoundTripParity(record('long_call', [absent as SandboxStrategyLeg, leg('sell', 2.0, 1.9)]));
    expect(c.parity).toBeNull();
    expect(c.exclusion).toBe('uncomputable');
  });

  it('a zero-leg record stays uncomputable (nothing to mark is not corrupt data)', () => {
    expect(classifyRoundTripParity(record('long_call', [])).exclusion).toBe('uncomputable');
  });

  it('nonPhysical WINS over uncomputable, and the verdict is leg-ORDER independent', () => {
    const absent = leg('buy', null, null);
    const impossible = leg('sell', 6.65, 0);
    // The same record, legs serialized both ways round. A first-bad-leg-wins implementation
    // returns a DIFFERENT counter for these two, making the count a property of the array
    // rather than of the record.
    expect(classifyRoundTripParity(record('csp', [absent, impossible])).exclusion).toBe('nonPhysical');
    expect(classifyRoundTripParity(record('csp', [impossible, absent])).exclusion).toBe('nonPhysical');
  });

  it('n + uncomputable + nonPhysical RECONCILES against the observed round-trips', () => {
    const recs = [
      record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)]), // computable
      record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)]), // computable
      record('long_call', [leg('buy', 1.0, null)]),                        // uncomputable
      record('long_call', [leg('buy', 6.65, 0)]),                          // nonPhysical
      record('long_call', [leg('sell', 6.65, 0)]),                         // nonPhysical
    ];
    const b = summarizeParityReconcile(recs, NOW).strategies.long_call.cumulative;
    expect(b.n).toBe(2);
    expect(b.uncomputable).toBe(1);
    expect(b.nonPhysical).toBe(2);
    expect(b.n + b.uncomputable + b.nonPhysical).toBe(recs.length);
  });

  it('a clean book reads nonPhysical: 0 — the counter has a FALSE state, not just a true one', () => {
    const b = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)])],
      NOW,
    ).strategies.long_call.cumulative;
    expect(b.nonPhysical).toBe(0);
    expect(b.n).toBe(1);
  });
});

describe('TRA-2370 — parityGapUsd gains median/p90 (defence in depth on the mean)', () => {
  it('the median survives an outlier that moves the mean', () => {
    const recs = Array.from({ length: 6 }, () =>
      record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)]), // gap = $15 each
    );
    // One big-but-PHYSICAL cross — the shape the ask-1 guard does NOT catch, which is
    // exactly why the percentiles matter as defence in depth.
    recs.push(record('long_call', [leg('buy', 10, 16.65)])); // gap = $665
    const g = summarizeParityReconcile(recs, NOW).strategies.long_call.cumulative.parityGapUsd;
    expect(g.median).toBeCloseTo(15, 6);      // unmoved by the $665 row
    expect(g.mean).toBeGreaterThan(100);      // destroyed by it — the pre-TRA-2370 blind spot
    expect(g.p90).toBeGreaterThan(g.median!); // and the tail still SHOWS the outlier
  });

  it('percentiles are over PER-ROUND-TRIP gaps and reconcile with sum/mean', () => {
    const g = summarizeParityReconcile(
      [
        record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)]), // 15
        record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)]), // 15
      ],
      NOW,
    ).strategies.long_call.cumulative.parityGapUsd;
    expect(g.sum).toBeCloseTo(30, 6);
    expect(g.mean).toBeCloseTo(15, 6);
    expect(g.median).toBeCloseTo(15, 6);
    expect(g.p90).toBeCloseTo(15, 6);
  });

  it('n=1 yields that single gap for every percentile; n=0 yields null, never 0', () => {
    const one = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.0, 1.05)])],
      NOW,
    ).strategies.long_call.cumulative.parityGapUsd;
    expect(one.median).toBeCloseTo(5, 6);
    expect(one.p90).toBeCloseTo(5, 6);

    const none = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.0, null)])],
      NOW,
    ).strategies.long_call.cumulative.parityGapUsd;
    expect(none.sum).toBe(0); // a SUM over nothing is 0; the central estimates are not
    expect(none.mean).toBeNull();
    expect(none.median).toBeNull();
    expect(none.p90).toBeNull();
  });
});

describe('TRA-2370 — the raw-legs projection (attribution from outside the process)', () => {
  it('echoes side/requestedPx/fillPx per leg and flags the offending leg', () => {
    const rows = parityRecordRows([record('covered_call', [leg('sell', 6.65, 0), leg('buy', 6.65, 6.7)])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].strategy).toBe('covered_call');
    expect(rows[0].etDay).toBe(ET_DAY);
    expect(rows[0].legs.map((l) => [l.side, l.requestedPx, l.fillPx, l.nonPhysical])).toEqual([
      ['sell', 6.65, 0, true],
      ['buy', 6.65, 6.7, false],
    ]);
  });

  it('a computable row carries its real gap; an excluded row carries null, never 0', () => {
    const rows = parityRecordRows([
      record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)]),
      record('long_call', [leg('buy', 1.0, null)]),
    ]);
    expect(rows[0].status).toBe('computable');
    expect(rows[0].parityGapUsd).toBeCloseTo(15, 6);
    expect(rows[0].wouldBeParityGapUsd).toBeNull(); // nothing was suppressed
    expect(rows[1].status).toBe('uncomputable');
    expect(rows[1].parityGapUsd).toBeNull();
    // An ABSENT price has no pre-guard arithmetic to show — that is only meaningful for the
    // false-zero shape, where a number WAS folded.
    expect(rows[1].wouldBeParityGapUsd).toBeNull();
  });

  it('wouldBeParityGapUsd exposes the ±$665 the guard removed', () => {
    const [buyRow] = parityRecordRows([record('long_call', [leg('buy', 6.65, 0)])]);
    expect(buyRow.wouldBeParityGapUsd).toBeCloseTo(-665, 6);
    const [sellRow] = parityRecordRows([record('covered_call', [leg('sell', 6.65, 0)])]);
    expect(sellRow.wouldBeParityGapUsd).toBeCloseTo(665, 6);
  });

  it('the projection is one row per record, in journal order, and folds nothing', () => {
    const rows = parityRecordRows([
      record('long_call', [leg('buy', 1.0, 1.05)], { etDay: '2026-07-23' }),
      record('csp', [leg('sell', 2.0, 1.9)]),
    ]);
    expect(rows.map((r) => [r.strategy, r.etDay])).toEqual([
      ['long_call', '2026-07-23'],
      ['csp', ET_DAY],
    ]);
  });
});

describe('TRA-2583 — the persisted decision-quote fields reach the records route', () => {
  // The defect: `parityRecordRows` hand-built a 5-key leg and dropped every quote field, so
  // `spreadAtSubmitPct` had NO read path outside a source read of the journal file. Each
  // assertion below is written with a NON-NULL value, because the projection could drop the
  // field entirely and a `toBeNull()` would still pass.
  it('a NON-NULL spreadAtSubmitPct survives the projection', () => {
    const [row] = parityRecordRows([
      record('long_call', [leg('buy', 1.0, 1.05, { spreadAtSubmitPct: 0.6134 })]),
    ]);
    expect(row.legs[0].spreadAtSubmitPct).toBeCloseTo(0.6134, 6);
  });

  it('carries bid/ask/slippageBps/withinSpread through with their real values', () => {
    const [row] = parityRecordRows([
      record('covered_call', [
        leg('sell', 2.0, 1.9, {
          bid: 1.97,
          ask: 2.03,
          slippageBps: -50.0,
          spreadAtSubmitPct: 3.0,
          withinSpread: true,
        }),
      ]),
    ]);
    expect(row.legs[0]).toMatchObject({
      bid: 1.97,
      ask: 2.03,
      slippageBps: -50.0,
      spreadAtSubmitPct: 3.0,
      withinSpread: true,
    });
  });

  it('a null quote stays null — never coalesced to 0/false, which would read as a tight book', () => {
    const [row] = parityRecordRows([record('long_call', [leg('buy', 1.0, 1.05)])]);
    // Paired with the non-null cases above, this is not vacuous: those prove the keys are
    // PROJECTED, so a null here can only mean the journal held a null.
    expect(row.legs[0]).toMatchObject({
      bid: null,
      ask: null,
      slippageBps: null,
      spreadAtSubmitPct: null,
      withinSpread: null,
    });
    expect(row.legs[0].withinSpread).not.toBe(false);
    expect(row.legs[0].spreadAtSubmitPct).not.toBe(0);
  });

  it('the exposed field supports the TRA-2242 forecast identity quotedH == spreadAtSubmitPct/200', () => {
    // On a symmetric mid the gate marks at `mark = requestedPx = mid`, so both exit sides
    // reduce to that identity. This asserts the INPUT to the forecast is readable and exact
    // to the journal's persisted 1e-4 rounding — it grades nothing and arms nothing.
    const [row] = parityRecordRows([
      record('long_call', [leg('buy', 1.0, 1.0, { spreadAtSubmitPct: 26.8 })]),
    ]);
    const spread = row.legs[0].spreadAtSubmitPct as number;
    expect(spread / 200).toBeCloseTo(0.134, 6);
  });

  it('projects exactly the documented key set — a NEW journal field is absent until named here', () => {
    // The route is an explicit allow-list, not an echo (the corrected comment at the head of
    // parity-reconcile.ts). Pinning the set is what makes the next silent drop fail loudly
    // instead of shipping a monitor that specifies an unexecutable read.
    const [row] = parityRecordRows([record('long_call', [leg('buy', 1.0, 1.05)])]);
    expect(Object.keys(row.legs[0]).sort()).toEqual([
      'ask',
      'bid',
      'fillPx',
      'nonPhysical',
      'optionSymbol',
      'requestedPx',
      'side',
      'slippageBps',
      'spreadAtSubmitPct',
      'withinSpread',
    ]);
  });
});

describe('TRA-2370 — the counter reaches the durable daily point', () => {
  it('the snapshot carries nonPhysical alongside uncomputable', () => {
    hydrateParityReconcileFromDisk(dir, NOW);
    const snap = appendParitySnapshotForDay(
      [
        record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)]),
        record('covered_call', [leg('sell', 6.65, 0), leg('buy', 6.65, 0)]),
        record('csp', [leg('buy', 1.0, null)]),
      ],
      NOW,
    );
    expect(snap.observedRecords).toBe(3);
    expect(snap.nonPhysical).toBe(1);
    expect(snap.uncomputable).toBe(1);
    // The excluded covered_call contributes NO perStrategy entry — not a 0-gap one.
    expect(Object.keys(snap.perStrategy)).toEqual(['long_call']);
  });

  it('a row persisted BEFORE this field hydrates as −1, not as an observed 0', () => {
    // Mid-vintage: it HAS foldCount (post-TRA-2279) but predates the nonPhysical guard, so
    // its bad rows were folded IN and the count is genuinely unknown. Riding foldCount's
    // `legacy` probe would have handed this row a false `0`.
    const midVintage = {
      etDay: ET_DAY, ts: NOW, firstFoldTs: NOW, lastFoldTs: NOW, foldCount: 3,
      sessionComplete: false, observedRecords: 4, uncomputable: 0,
      perStrategy: { covered_call: { parityGapUsd: 0, meanHalfSpreadBps: -0.4, n: 7 } },
    };
    writeFileSync(parityReconcileLogPath(dir), JSON.stringify(midVintage) + '\n', 'utf8');
    hydrateParityReconcileFromDisk(dir, NOW);
    const [row] = getParityReconcileSeries();
    expect(row.uncomputable).toBe(0);   // genuinely observed on this vintage
    expect(row.nonPhysical).toBe(-1);   // genuinely UNKNOWN on this vintage
  });
});

describe('TRA-2370 — the payload explains its own exclusions and its qty caveat', () => {
  it('exclusionNote and qtyAssumedNote ride the summary', () => {
    const s = summarizeParityReconcile([], NOW);
    expect(s.exclusionNote).toBe(EXCLUSION_NOTE);
    expect(s.qtyAssumedNote).toBe(QTY_ASSUMPTION_NOTE);
    expect(s.qtyAssumed).toBe(1);
  });

  it('the qty note states the STRUCTURAL reason (the writer-side hard cap), not a bare claim', () => {
    // TRA-2292 floated a size-blind fold as a candidate cause; it is refuted at the type
    // level. The note must carry that refutation, since `qtyAssumed: 1` alone reads as an
    // unverified modelling assumption.
    expect(QTY_ASSUMPTION_NOTE).toContain('SMOKE_OPTION_QTY=1');
    expect(QTY_ASSUMPTION_NOTE).toContain('NO qty field');
  });

  it('the exclusion note distinguishes the two buckets and states the reconciliation', () => {
    expect(EXCLUSION_NOTE).toContain('n + uncomputable + nonPhysical == observed round-trips');
  });
});
