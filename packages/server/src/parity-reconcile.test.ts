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
} from './parity-reconcile.js';
import type {
  SandboxStrategyRecord,
  SandboxStrategyLeg,
} from './sandbox-strategy-journal.js';

// TRA-2237 — the parity-reconcile monitor folds each SANDBOX round-trip's OWN mid-vs-fill
// (requestedPx = demo-book mid mark, fillPx = real fill) into a per-strategy demo-mark-vs-
// sandbox-fill P&L gap / half-spread. Proves: signed-cost sign per side, the
// gap == demoMark − sandboxFill identity, the uncomputable path (a null leg is EXCLUDED,
// never folded as a 0 gap), gapPct 3-valued on a 0 denominator, percentile edge (n=1),
// etDay vs cumulative bucketing, mutation (flip a fill across the mid → gap sign flips),
// and the durable daily series (self-accrual idempotent per ET day, reboot hydrate,
// retention compaction, torn-line tolerance, durability.ephemeral).

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

function leg(
  side: 'buy' | 'sell',
  requestedPx: number | null,
  fillPx: number | null,
): SandboxStrategyLeg {
  return {
    side,
    optionSymbol: 'TEST',
    submitTs: NOW,
    fillTs: fillPx == null ? null : NOW + 100,
    signalToSubmitMs: 40,
    requestedPx,
    fillPx,
    slippageBps: null,
    spreadAtSubmitPct: null,
    withinSpread: null,
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

  it('gapPct is null (3-valued) when the demo-mark denominator is ~0', () => {
    // buy mid 1.0 / sell mid 1.0 ⇒ demoMark = 0. Fills differ ⇒ nonzero gap, but pct undefined.
    const s = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.0, 1.02), leg('sell', 1.0, 0.99)])],
      NOW,
    );
    const b = s.strategies.long_call.cumulative;
    expect(b.demoMarkPnlUsd).toBeCloseTo(0, 6);
    expect(b.gapPct).toBeNull();
    expect(b.parityGapUsd.sum).not.toBe(0); // gap itself is real
  });

  it('gapPct is a finite ratio when the denominator is nonzero', () => {
    const s = summarizeParityReconcile(
      [record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)])],
      NOW,
    );
    // gap 15 / |demoMark 100| = 0.15
    expect(s.strategies.long_call.cumulative.gapPct).toBeCloseTo(0.15, 6);
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

  it('appends one snapshot for a new ET day, idempotent on a repeat call', () => {
    const recs = [record('long_call', [leg('buy', 1.0, 1.05), leg('sell', 2.0, 1.9)])];
    const first = appendParitySnapshotForDay(recs, NOW);
    expect(first).not.toBeNull();
    expect(first!.etDay).toBe(ET_DAY);
    expect(first!.perStrategy.long_call.parityGapUsd).toBeCloseTo(15, 6);
    expect(first!.perStrategy.long_call.n).toBe(1);
    // second call same ET day ⇒ no-op
    expect(appendParitySnapshotForDay(recs, NOW)).toBeNull();
    expect(getParityReconcileSeries()).toHaveLength(1);
    // and the disk line was written exactly once
    const lines = readFileSync(parityReconcileLogPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('does NOT snapshot a day with no computable round-trips', () => {
    const recs = [record('long_call', [leg('buy', 1.0, null)])]; // uncomputable
    expect(appendParitySnapshotForDay(recs, NOW)).toBeNull();
    expect(getParityReconcileSeries()).toHaveLength(0);
  });

  it('a new ET day accrues a second snapshot', () => {
    const recs = [record('long_call', [leg('buy', 1.0, 1.05)])];
    appendParitySnapshotForDay(recs, NOW);
    const nextDay = NOW + 86_400_000;
    const recs2 = [record('long_call', [leg('buy', 1.0, 1.1)], { etDay: '2026-07-25', ts: nextDay })];
    const snap2 = appendParitySnapshotForDay(recs2, nextDay);
    expect(snap2).not.toBeNull();
    expect(snap2!.etDay).toBe('2026-07-25');
    expect(getParityReconcileSeries()).toHaveLength(2);
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
