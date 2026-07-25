import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordConvictionDcaFill,
  hydrateConvictionDcaFromDisk,
  summarizeConvictionDca,
  clearConvictionDcaLedger,
  convictionDcaLogPath,
  resolveConvictionDcaDeployAnchor,
  CONVICTION_DCA_LOG_FILENAME,
  type ConvictionDcaFill,
} from './conviction-dca-ledger.js';

// TRA-1278 — the durable conviction-DCA add ledger that unblocks the TRA-971
// forward-evidence gate. Proves: write-through append, restart-safe counts via
// a full-JSONL hydrate, the R-cap breach counter, and the "since deploy" anchor.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conviction-dca-'));
  clearConvictionDcaLedger();
});
afterEach(() => {
  clearConvictionDcaLedger();
  rmSync(dir, { recursive: true, force: true });
});

function fill(over: Partial<ConvictionDcaFill> = {}): ConvictionDcaFill {
  return {
    ts: 1_700_000_000_000,
    mode: 'demo',
    assetClass: 'equity',
    symbol: 'AAPL',
    positionId: 'pos-1',
    action: 'add',
    addQty: 10,
    addPrice: 190.5,
    blendedAvg: 189.0,
    stop: 185.0,
    totalQty: 20,
    realizedRiskDollars: 80.0,
    riskBudget: 100.0,
    withinBudget: true,
    reason: 'trend-confirmed pullback add',
    ...over,
  };
}

function readLines(path: string): ConvictionDcaFill[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

describe('recordConvictionDcaFill', () => {
  it('appends one JSONL line per fill under DATA_DIR and counts it', () => {
    hydrateConvictionDcaFromDisk(dir); // configures dataDir (empty file)
    recordConvictionDcaFill(fill());
    recordConvictionDcaFill(fill({ symbol: 'MSFT', positionId: 'pos-2', ts: 1_700_000_100_000 }));

    const path = convictionDcaLogPath(dir);
    expect(path.endsWith(CONVICTION_DCA_LOG_FILENAME)).toBe(true);
    const rows = readLines(path);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.symbol).toBe('AAPL');
    expect(rows[1]!.symbol).toBe('MSFT');

    const s = summarizeConvictionDca();
    expect(s.addCount).toBe(2);
    expect(s.breachCount).toBe(0);
    expect(s.lastAddAt).toBe(1_700_000_100_000);
    expect(s.recent).toHaveLength(2);
  });

  it('increments breachCount for a fill that busts the R-cap', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill());
    recordConvictionDcaFill(fill({ realizedRiskDollars: 120.0, riskBudget: 100.0, withinBudget: false }));
    const s = summarizeConvictionDca();
    expect(s.addCount).toBe(2);
    expect(s.breachCount).toBe(1);
  });

  it('counts in-memory even with no dataDir, and writes no file', () => {
    clearConvictionDcaLedger(); // no dataDir configured
    recordConvictionDcaFill(fill());
    expect(summarizeConvictionDca().addCount).toBe(1);
    expect(existsSync(convictionDcaLogPath(dir))).toBe(false);
  });
});

describe('hydrateConvictionDcaFromDisk (restart-safe)', () => {
  it('rebuilds counts from the full JSONL across a simulated restart', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ ts: 1_700_000_000_000 }));
    recordConvictionDcaFill(fill({ ts: 1_700_000_100_000, realizedRiskDollars: 130, withinBudget: false }));
    recordConvictionDcaFill(fill({ ts: 1_700_000_200_000 }));

    // Simulate a reboot: wipe memory, then hydrate from the same dir.
    clearConvictionDcaLedger();
    expect(summarizeConvictionDca().addCount).toBe(0);

    const h = hydrateConvictionDcaFromDisk(dir);
    expect(h.addCount).toBe(3);
    expect(h.breachCount).toBe(1);
    expect(h.firstAddAt).toBe(1_700_000_000_000);
    expect(h.lastAddAt).toBe(1_700_000_200_000);

    const s = summarizeConvictionDca();
    expect(s.addCount).toBe(3);
    expect(s.breachCount).toBe(1);
  });

  it('is a no-op empty hydration when the file is absent', () => {
    const h = hydrateConvictionDcaFromDisk(dir);
    expect(h.addCount).toBe(0);
    expect(h.firstAddAt).toBeNull();
  });

  it('skips a torn trailing line rather than throwing', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill());
    // Append a partial/corrupt line the way a crash mid-write would.
    appendFileSync(convictionDcaLogPath(dir), '{"ts":123,"symbol":"XY', 'utf8');
    const h = hydrateConvictionDcaFromDisk(dir);
    expect(h.addCount).toBe(1);
  });
});

describe('summarizeConvictionDca deploy anchor', () => {
  it('restricts counts/tail to fills at/after the anchor', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ ts: 1_000 }));
    recordConvictionDcaFill(fill({ ts: 5_000, realizedRiskDollars: 200, withinBudget: false }));
    recordConvictionDcaFill(fill({ ts: 9_000 }));

    const all = summarizeConvictionDca(null);
    expect(all.addCount).toBe(3);
    expect(all.deployAnchor).toBeNull();

    const anchored = summarizeConvictionDca(5_000);
    expect(anchored.addCount).toBe(2);
    expect(anchored.breachCount).toBe(1);
    expect(anchored.deployAnchor).toBe(5_000);
    expect(anchored.firstAddAt).toBe(5_000);
  });
});

// ── TRA-2265 — per-class / per-mode partition ────────────────────────────────
//
// The pooled addCount/breachCount fold the equity and option add legs together,
// but the legs are checked by DIFFERENT rules at the fill site. The TRA-971 gate
// reads those numbers as evidence about the EQUITY R-cap, so a pooled
// `breachCount: 0` reads byte-identical whether the equity cap held or the equity
// add path never ran. These tests pin the separator.

/** Sum a bucket field across every partition key — the reconciliation basis. */
function sumBuckets(
  buckets: Record<string, { addCount: number; breachCount: number }>,
  field: 'addCount' | 'breachCount',
): number {
  return Object.values(buckets).reduce((acc, b) => acc + b[field], 0);
}

describe('summarizeConvictionDca byClass / byMode (TRA-2265)', () => {
  it('separates equity and option breaches — pooling the classes makes this red', () => {
    hydrateConvictionDcaFromDisk(dir);
    // Mixed set: 3 equity (1 breaching), 2 option (1 breaching).
    recordConvictionDcaFill(fill({ ts: 1_000, assetClass: 'equity' }));
    recordConvictionDcaFill(fill({ ts: 2_000, assetClass: 'equity' }));
    recordConvictionDcaFill(
      fill({ ts: 3_000, assetClass: 'equity', realizedRiskDollars: 140, withinBudget: false }),
    );
    recordConvictionDcaFill(fill({ ts: 4_000, assetClass: 'option', stop: null }));
    recordConvictionDcaFill(
      fill({
        ts: 5_000,
        assetClass: 'option',
        stop: null,
        realizedRiskDollars: 175,
        withinBudget: false,
      }),
    );

    const s = summarizeConvictionDca();

    // The pooled pair is unchanged (back-compat).
    expect(s.addCount).toBe(5);
    expect(s.breachCount).toBe(2);

    // …and the partition attributes each breach to the leg that produced it.
    // If applyFill ignored the class key, BOTH buckets would read 5/2 and every
    // assertion below fails — this is the prove-it-fires mutation.
    expect(s.byClass.equity.addCount).toBe(3);
    expect(s.byClass.equity.breachCount).toBe(1);
    expect(s.byClass.option.addCount).toBe(2);
    expect(s.byClass.option.breachCount).toBe(1);
    expect(s.byClass.unknown.addCount).toBe(0);

    // Per-class first/last are per-class, not copies of the pooled window.
    expect(s.byClass.equity.firstAddAt).toBe(1_000);
    expect(s.byClass.equity.lastAddAt).toBe(3_000);
    expect(s.byClass.option.firstAddAt).toBe(4_000);
    expect(s.byClass.option.lastAddAt).toBe(5_000);

    // A partition that merely mirrors the pooled count is NOT a partition.
    expect(s.byClass.equity.addCount).not.toBe(s.addCount);
    expect(s.byClass.option.addCount).not.toBe(s.addCount);
  });

  it('reconciles arithmetically against the pooled counts, so a dropped class cannot pass', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ ts: 1_000, assetClass: 'equity', mode: 'demo' }));
    recordConvictionDcaFill(
      fill({ ts: 2_000, assetClass: 'option', mode: 'demo', realizedRiskDollars: 900, withinBudget: false }),
    );
    recordConvictionDcaFill(fill({ ts: 3_000, assetClass: 'option', mode: 'live' }));

    const s = summarizeConvictionDca();
    expect(s.byClass.equity.addCount + s.byClass.option.addCount).toBe(s.addCount);
    expect(sumBuckets(s.byClass, 'addCount')).toBe(s.addCount);
    expect(sumBuckets(s.byClass, 'breachCount')).toBe(s.breachCount);
    expect(sumBuckets(s.byMode, 'addCount')).toBe(s.addCount);
    expect(sumBuckets(s.byMode, 'breachCount')).toBe(s.breachCount);

    expect(s.byMode.demo.addCount).toBe(2);
    expect(s.byMode.live.addCount).toBe(1);
    expect(s.byMode.unknown.addCount).toBe(0);
  });

  it('reports a STATED zero for a class that never fired (the TRA-971 failure mode)', () => {
    hydrateConvictionDcaFromDisk(dir);
    // The live host's actual shape: 100% option, 0% equity.
    for (let i = 0; i < 8; i += 1) {
      recordConvictionDcaFill(fill({ ts: 1_000 + i, assetClass: 'option', stop: null }));
    }
    const s = summarizeConvictionDca();
    expect(s.breachCount).toBe(0); // pooled: indistinguishable from a held equity cap
    expect(s.byClass.equity).toEqual({
      addCount: 0,
      breachCount: 0,
      firstAddAt: null,
      lastAddAt: null,
    }); // partitioned: says plainly that the equity leg has no evidence at all
    expect(s.byClass.option.addCount).toBe(8);
  });

  it('rebuilds partitions from the FULL JSONL on boot, not the 50-fill tail', () => {
    hydrateConvictionDcaFromDisk(dir);
    // 60 option + 4 equity = 64 fills, well past MAX_RECENT_FILLS (50). The equity
    // fills go FIRST so the rolling tail evicts every one of them — re-deriving
    // byClass from `recentFills` would report equity 0 and option 50.
    for (let i = 0; i < 4; i += 1) {
      recordConvictionDcaFill(fill({ ts: 1_000 + i, assetClass: 'equity' }));
    }
    for (let i = 0; i < 60; i += 1) {
      recordConvictionDcaFill(fill({ ts: 10_000 + i, assetClass: 'option', stop: null }));
    }

    clearConvictionDcaLedger();
    const h = hydrateConvictionDcaFromDisk(dir);
    expect(h.addCount).toBe(64);
    expect(h.byClass.equity.addCount).toBe(4);
    expect(h.byClass.option.addCount).toBe(60);

    const s = summarizeConvictionDca();
    expect(s.recent).toHaveLength(50); // the tail HAS dropped the equity fills…
    expect(s.recent.every((f) => f.assetClass === 'option')).toBe(true);
    expect(s.byClass.equity.addCount).toBe(4); // …and the counters kept them anyway
    expect(s.byClass.option.addCount).toBe(60);
    expect(sumBuckets(s.byClass, 'addCount')).toBe(s.addCount);
  });

  it('keeps the partition monotonic across a restart, like the pooled counts', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ ts: 1_000, assetClass: 'equity' }));
    recordConvictionDcaFill(fill({ ts: 2_000, assetClass: 'option', stop: null }));

    clearConvictionDcaLedger();
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ ts: 3_000, assetClass: 'equity' }));

    const s = summarizeConvictionDca();
    expect(s.byClass.equity.addCount).toBe(2);
    expect(s.byClass.option.addCount).toBe(1);
    expect(sumBuckets(s.byClass, 'addCount')).toBe(s.addCount);
  });

  it('buckets an off-contract assetClass as unknown instead of absorbing it into equity', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ ts: 1_000, assetClass: 'equity' }));
    // A line predating (or violating) the assetClass contract. Folding this into
    // `equity` would manufacture equity evidence that does not exist.
    appendFileSync(
      convictionDcaLogPath(dir),
      JSON.stringify({ ...fill({ ts: 2_000 }), assetClass: undefined }) + '\n',
      'utf8',
    );

    clearConvictionDcaLedger();
    const h = hydrateConvictionDcaFromDisk(dir);
    expect(h.addCount).toBe(2);
    expect(h.byClass.equity.addCount).toBe(1);
    expect(h.byClass.unknown.addCount).toBe(1);
    expect(sumBuckets(h.byClass, 'addCount')).toBe(h.addCount);
  });

  it('partitions the anchored window too, and still reconciles there', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ ts: 1_000, assetClass: 'equity' }));
    recordConvictionDcaFill(fill({ ts: 5_000, assetClass: 'option', stop: null }));
    recordConvictionDcaFill(
      fill({ ts: 9_000, assetClass: 'option', stop: null, realizedRiskDollars: 300, withinBudget: false }),
    );

    const anchored = summarizeConvictionDca(5_000);
    expect(anchored.addCount).toBe(2);
    expect(anchored.byClass.equity.addCount).toBe(0); // the pre-anchor equity fill is out
    expect(anchored.byClass.option.addCount).toBe(2);
    expect(anchored.byClass.option.breachCount).toBe(1);
    expect(sumBuckets(anchored.byClass, 'addCount')).toBe(anchored.addCount);
    expect(sumBuckets(anchored.byClass, 'breachCount')).toBe(anchored.breachCount);
  });

  // ── TRA-2303 — the anchored branch must not re-derive over the display tail ──
  //
  // Live shape this reproduces (bqb1, 2026-07-25): 600 fills over 18.3 days
  // (32.8/day), all 3 equity fills on day one, a 50-fill tail reaching back ~1.5
  // days. Setting CONVICTION_DCA_DEPLOY_ANCHOR to ANY pre-ledger value therefore
  // dropped byClass.equity.addCount from 3 to 0 — honestly (sums still reconciled),
  // which is what made it undetectable.
  //
  // Prove-it-fires by mutation: restore `MAX_RETAINED_FILLS = 50` (or point the
  // anchored filter back at a 50-fill tail) and this case goes red on the equity
  // assertion — 3 → 0. The sum-reconciliation assertions below stay GREEN under
  // that mutation, which is the whole point: reconciliation cannot detect this.
  it('sees the early minority-class fills under an anchor, far outside the 50-fill tail', () => {
    hydrateConvictionDcaFromDisk(dir);
    // Day one: the 3 equity fills — the only evidence the TRA-971 gate can grade.
    const dayOne = 1_783_348_961_134; // 2026-07-06T13:36Z, the live firstAddAt
    for (let i = 0; i < 3; i += 1) {
      recordConvictionDcaFill(fill({ ts: dayOne + i * 1_000, assetClass: 'equity' }));
    }
    // Then 597 option fills over the following ~18 days, burying them far past 50.
    for (let i = 0; i < 597; i += 1) {
      recordConvictionDcaFill(
        fill({ ts: dayOne + 86_400_000 + i * 2_600_000, assetClass: 'option', stop: null, symbol: 'SPY' }),
      );
    }

    const unanchored = summarizeConvictionDca();
    expect(unanchored.addCount).toBe(600);
    expect(unanchored.byClass.equity.addCount).toBe(3);
    expect(unanchored.countsBasis).toBe('monotonic-full');

    // An anchor set BEFORE the first fill must be a no-op on every count.
    const anchored = summarizeConvictionDca(dayOne - 86_400_000);
    expect(anchored.byClass.equity.addCount).toBe(3); // ← 0 under the old tail derivation
    expect(anchored.byClass.equity.firstAddAt).toBe(dayOne);
    expect(anchored.addCount).toBe(600);
    expect(anchored.byClass.option.addCount).toBe(597);
    expect(anchored.countsBasis).toBe('retained-full');
    expect(anchored.countsExact).toBe(true);
    expect(anchored.droppedFillCount).toBe(0);

    // The pre-anchor branch and the anchored branch must agree exactly — the
    // stronger statement, and the one a gate reader actually relies on.
    expect(anchored.byClass).toEqual(unanchored.byClass);
    expect(anchored.byMode).toEqual(unanchored.byMode);
    expect(anchored.breachCount).toBe(unanchored.breachCount);

    // Still reconciles (it always did — that is why this was invisible).
    expect(sumBuckets(anchored.byClass, 'addCount')).toBe(anchored.addCount);

    // `recent` stays a 50-fill DISPLAY tail; it is no longer the count basis.
    expect(anchored.recent).toHaveLength(50);
  });

  it('survives a restart — the anchored partition rehydrates from the full JSONL', () => {
    hydrateConvictionDcaFromDisk(dir);
    const dayOne = 1_783_348_961_134;
    recordConvictionDcaFill(fill({ ts: dayOne, assetClass: 'equity' }));
    for (let i = 0; i < 120; i += 1) {
      recordConvictionDcaFill(fill({ ts: dayOne + 86_400_000 + i * 1_000, assetClass: 'option', stop: null }));
    }

    hydrateConvictionDcaFromDisk(dir); // simulated reboot — re-reads the JSONL
    const anchored = summarizeConvictionDca(dayOne - 1);
    expect(anchored.addCount).toBe(121);
    expect(anchored.byClass.equity.addCount).toBe(1);
    expect(anchored.countsExact).toBe(true);
  });

  it('marks anchored counts INEXACT once retention truncates — no silent short count', () => {
    clearConvictionDcaLedger(); // no dataDir: counters only, skip 25k sync appends
    const base = 1_000_000;
    // One equity fill first, then enough option fills to push past MAX_RETAINED_FILLS
    // (25 000) and evict it. No dataDir writes are asserted here; this is the cap.
    recordConvictionDcaFill(fill({ ts: base, assetClass: 'equity' }));
    for (let i = 0; i < 25_000; i += 1) {
      recordConvictionDcaFill(fill({ ts: base + 1_000 + i, assetClass: 'option', stop: null }));
    }

    const anchored = summarizeConvictionDca(base - 1);
    expect(anchored.droppedFillCount).toBeGreaterThan(0);
    expect(anchored.countsBasis).toBe('retained-truncated');
    expect(anchored.countsExact).toBe(false);
    // The count really IS short — which is exactly why it must be labelled.
    expect(anchored.byClass.equity.addCount).toBe(0);

    // The un-anchored branch is unaffected: monotonic counters stay exact and say so.
    const unanchored = summarizeConvictionDca();
    expect(unanchored.addCount).toBe(25_001);
    expect(unanchored.byClass.equity.addCount).toBe(1);
    expect(unanchored.countsExact).toBe(true);
    expect(unanchored.countsBasis).toBe('monotonic-full');
  });

  it('hands out a copy — a summary caller cannot mutate ledger state', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ ts: 1_000, assetClass: 'equity' }));
    const first = summarizeConvictionDca();
    first.byClass.equity.addCount = 999;
    expect(summarizeConvictionDca().byClass.equity.addCount).toBe(1);
  });
});

describe('resolveConvictionDcaDeployAnchor', () => {
  it('parses a ms-epoch number', () => {
    expect(resolveConvictionDcaDeployAnchor({ CONVICTION_DCA_DEPLOY_ANCHOR: '1700000000000' })).toBe(1_700_000_000_000);
  });
  it('parses an ISO date', () => {
    expect(resolveConvictionDcaDeployAnchor({ CONVICTION_DCA_DEPLOY_ANCHOR: '2026-06-19T00:00:00Z' })).toBe(
      Date.parse('2026-06-19T00:00:00Z'),
    );
  });
  it('returns null when unset or unparseable', () => {
    expect(resolveConvictionDcaDeployAnchor({})).toBeNull();
    expect(resolveConvictionDcaDeployAnchor({ CONVICTION_DCA_DEPLOY_ANCHOR: 'not-a-date' })).toBeNull();
  });
});
