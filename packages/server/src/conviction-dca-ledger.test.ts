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
