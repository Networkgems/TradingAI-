import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendFundingHistory,
  fundingHistoryPath,
  FUNDING_HISTORY_FILENAME,
  type FundingHistoryEntry,
} from './perp-funding-history.js';

// TRA-1216 — the forward funding-history JSONL writer (the sole persisted
// artifact; unblocks a future carry backtest). Proves append semantics, the
// null-funding gap filter (a phantom row would poison a backtest), and size-based
// rotation to a single `.1` backup.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'perp-funding-hist-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(over: Partial<FundingHistoryEntry> = {}): FundingHistoryEntry {
  return { ts: 1_700_000_000_000, productId: 'BTC-PERP-INTX', fundingRate: 0.000012, intervalHours: 1, markPrice: 68000, ...over };
}

function readLines(path: string): FundingHistoryEntry[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

describe('appendFundingHistory', () => {
  it('appends one JSONL row per entry under DATA_DIR', () => {
    const n = appendFundingHistory(dir, [entry(), entry({ productId: 'ETH-PERP-INTX' })]);
    expect(n).toBe(2);
    const path = fundingHistoryPath(dir);
    expect(path.endsWith(FUNDING_HISTORY_FILENAME)).toBe(true);
    const rows = readLines(path);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(entry());
    expect(rows[1]!.productId).toBe('ETH-PERP-INTX');
  });

  it('appends across calls (append-only, not truncating)', () => {
    appendFundingHistory(dir, [entry()]);
    appendFundingHistory(dir, [entry({ ts: 1_700_000_003_600 })]);
    expect(readLines(fundingHistoryPath(dir))).toHaveLength(2);
  });

  it('skips null / non-finite funding rows (a gap, not a data point)', () => {
    const n = appendFundingHistory(dir, [
      entry({ fundingRate: 0.00001 }),
      entry({ fundingRate: NaN }),
      { ...entry(), fundingRate: null as unknown as number },
      entry({ intervalHours: 0 }), // bad interval ⇒ un-annualizable ⇒ dropped
    ]);
    expect(n).toBe(1);
    expect(readLines(fundingHistoryPath(dir))).toHaveLength(1);
  });

  it('writes nothing (and no file) when every row is filtered out', () => {
    const n = appendFundingHistory(dir, [entry({ fundingRate: NaN })]);
    expect(n).toBe(0);
    expect(existsSync(fundingHistoryPath(dir))).toBe(false);
  });

  it('rotates to a single .1 backup past the size cap', () => {
    const path = fundingHistoryPath(dir);
    // Pre-fill past a tiny cap so the next append rotates.
    writeFileSync(path, 'x'.repeat(500), 'utf8');
    appendFundingHistory(dir, [entry()], 100);
    expect(existsSync(`${path}.1`)).toBe(true);
    // The rolled backup holds the old bytes; the fresh file holds only the new row.
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('x'.repeat(500));
    expect(readLines(path)).toHaveLength(1);
  });
});
