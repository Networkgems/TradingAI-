import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateAndRecordScaleout,
  hydrateScaleoutLadderFromDisk,
  summarizeScaleoutLadder,
  clearScaleoutLadderLedger,
  scaleoutLadderLogPath,
  scaleoutFeeRate,
  SCALEOUT_LADDER_LOG_FILENAME,
  type ScaleoutObserveInput,
  type ScaleoutTrimRecord,
} from './scaleout-ladder-ledger.js';
import { SCALE_OUT_TAKER_FEE_CRYPTO, SCALE_OUT_TAKER_FEE_EQUITY } from '@trading-app/shared';

// TRA-1300 — the durable observe-only scale-out ladder ledger that backs the
// QuantTrader forward-validation gate. Proves: write-through append, restart-safe
// counts + per-position rung dedup via a full-JSONL hydrate, downside handoff (no
// record below entry), and that it never mutates a book.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scaleout-ladder-'));
  clearScaleoutLadderLedger();
});
afterEach(() => {
  clearScaleoutLadderLedger();
  rmSync(dir, { recursive: true, force: true });
});

function pos(over: Partial<ScaleoutObserveInput> = {}): ScaleoutObserveInput {
  return {
    positionId: 'pos-1',
    symbol: 'AAPL',
    side: 'buy',
    avgEntry: 100,
    markPrice: 125,
    baseQty: 1000,
    assetClass: 'equity',
    mode: 'demo',
    ...over,
  };
}

function readLines(path: string): ScaleoutTrimRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ScaleoutTrimRecord);
}

describe('scaleout-ladder-ledger — durable observe-only capture', () => {
  it('records a trim, appends one JSONL line, and folds into the summary', () => {
    hydrateScaleoutLadderFromDisk(dir); // configures dataDir (empty file)
    const d = evaluateAndRecordScaleout(pos(), 1_700_000_000_000);
    expect(d.triggered).toHaveLength(1);

    const s = summarizeScaleoutLadder();
    expect(s.trimCount).toBe(1);
    expect(s.positionCount).toBe(1);
    expect(s.fullExitCount).toBe(0);
    expect(s.recent).toHaveLength(1);
    expect(s.recent[0]!.up).toBe(0.25);
    expect(s.recent[0]!.symbol).toBe('AAPL');

    const path = scaleoutLadderLogPath(dir);
    expect(existsSync(path)).toBe(true);
    const lines = readLines(path);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.sellPctBase).toBeCloseTo(0.1, 10);
    expect(lines[0]!.feeRate).toBe(SCALE_OUT_TAKER_FEE_EQUITY);
  });

  it('crypto positions use the crypto taker fee', () => {
    hydrateScaleoutLadderFromDisk(dir);
    const d = evaluateAndRecordScaleout(pos({ symbol: 'BTC-USD', assetClass: 'crypto' }));
    expect(d.feeRate).toBe(SCALE_OUT_TAKER_FEE_CRYPTO);
    expect(scaleoutFeeRate('crypto')).toBe(SCALE_OUT_TAKER_FEE_CRYPTO);
    expect(scaleoutFeeRate('equity')).toBe(SCALE_OUT_TAKER_FEE_EQUITY);
  });

  it('does not re-fire a rung already recorded for the same position', () => {
    hydrateScaleoutLadderFromDisk(dir);
    evaluateAndRecordScaleout(pos({ markPrice: 125 })); // fires +25%
    const again = evaluateAndRecordScaleout(pos({ markPrice: 130 })); // still only +25% armed
    expect(again.triggered).toHaveLength(0);
    expect(summarizeScaleoutLadder().trimCount).toBe(1);
  });

  it('DOWNSIDE HANDOFF: below the average entry it records nothing', () => {
    hydrateScaleoutLadderFromDisk(dir);
    const d = evaluateAndRecordScaleout(pos({ markPrice: 80 })); // −20%
    expect(d.downsideDeferred).toBe(true);
    expect(d.triggered).toHaveLength(0);
    expect(summarizeScaleoutLadder().trimCount).toBe(0);
    expect(existsSync(scaleoutLadderLogPath(dir))).toBe(false); // no write at all
  });

  it('SURVIVES RESTART: counts and per-position fired rungs rebuild from disk', () => {
    hydrateScaleoutLadderFromDisk(dir);
    evaluateAndRecordScaleout(pos({ markPrice: 125 })); // +25% → sell 10%
    evaluateAndRecordScaleout(pos({ markPrice: 135 })); // +35% → sell 20%
    expect(summarizeScaleoutLadder().trimCount).toBe(2);

    // Simulate a process reboot: wipe memory, then hydrate from the same dir.
    clearScaleoutLadderLedger();
    const h = hydrateScaleoutLadderFromDisk(dir);
    expect(h.trimCount).toBe(2);
    expect(h.positionCount).toBe(1);

    // After restart the already-fired rungs must NOT re-fire.
    const after = evaluateAndRecordScaleout(pos({ markPrice: 135 }));
    expect(after.triggered).toHaveLength(0);
    // A fresh rung (+45%) still fires post-restart.
    const fresh = evaluateAndRecordScaleout(pos({ markPrice: 145 }));
    expect(fresh.triggered.map((t) => t.up)).toEqual([0.45]);
    expect(summarizeScaleoutLadder().trimCount).toBe(3);
  });

  it('the +100% remainder rung is counted as a full exit', () => {
    hydrateScaleoutLadderFromDisk(dir);
    // Fire the intermediate rungs first, then a jump to +100% exits the remainder.
    evaluateAndRecordScaleout(pos({ markPrice: 125 }));
    evaluateAndRecordScaleout(pos({ markPrice: 135 }));
    evaluateAndRecordScaleout(pos({ markPrice: 145 }));
    evaluateAndRecordScaleout(pos({ markPrice: 160 }));
    const exit = evaluateAndRecordScaleout(pos({ markPrice: 200 })); // +100%
    expect(exit.fullyExited).toBe(true);
    expect(summarizeScaleoutLadder().fullExitCount).toBe(1);
  });

  it('a torn trailing JSONL line is skipped, not thrown, on hydrate', () => {
    hydrateScaleoutLadderFromDisk(dir);
    evaluateAndRecordScaleout(pos({ markPrice: 125 }));
    // Corrupt the file with a partial trailing line.
    const path = scaleoutLadderLogPath(dir);
    const good = readFileSync(path, 'utf8');
    writeFileSync(path, good + '{"ts":123,"positionId":"x"', 'utf8');
    clearScaleoutLadderLedger();
    const h = hydrateScaleoutLadderFromDisk(dir);
    expect(h.trimCount).toBe(1); // only the intact line survives
  });

  it('SCALEOUT_LADDER_LOG_FILENAME is the expected file', () => {
    expect(scaleoutLadderLogPath(dir).endsWith(SCALEOUT_LADDER_LOG_FILENAME)).toBe(true);
  });
});
