import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateAndRecordScaleout,
  recordScaleoutObservePass,
  runScaleoutLadderObservePass,
  hydrateScaleoutLadderFromDisk,
  summarizeScaleoutLadder,
  clearScaleoutLadderLedger,
  scaleoutLadderLogPath,
  scaleoutLadderObservePath,
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

// TRA-1729 — the ladder was ARMED but BLIND. `{trimCount:0, positionCount:0}` was
// BYTE-IDENTICAL between "iterating an empty book forever, gate can never clear" and
// "watching a live long 1% under the +25% rung". These prove the two now differ.
describe('scaleout-ladder-ledger — TRA-1729 observe-pass instrumentation', () => {
  // THE ACCEPTANCE TEST. Both halves drive `runScaleoutLadderObservePass` — the exact
  // function SignalEngine.evaluateScaleoutLadder() calls — so the empty-book pass is
  // proven to FIRE, not merely proven to be recordable. (An instrument whose correct
  // output is "0" must be shown to actually emit that 0; never-ran and ran-empty were
  // the same observation, and that is the bug.)
  it('BLIND vs CLOSE are no longer the same reading', () => {
    // (a) flag on, EMPTY book — the demo-equity book has been empty for 8 days.
    hydrateScaleoutLadderFromDisk(dir);
    runScaleoutLadderObservePass([], new Map(), 1_700_000_000_000);

    const blind = summarizeScaleoutLadder();
    expect(blind.trimCount).toBe(0);
    expect(blind.observedPositionCount).toBe(0); // ← THE ALARM
    expect(blind.observeStatus).toBe('blind');
    expect(blind.lastObservePassAt).toBe(1_700_000_000_000);
    // An empty pass observed NO gain — not a 0% gain. `0` is never the "not measured"
    // sentinel; `null` is.
    expect(blind.maxGainPctLastPass).toBeNull();
    expect(blind.maxGainPctObserved).toBeNull();

    // (b) flag on, one open long sitting 1% UNDER the first rung (+24% vs the +25% rung).
    clearScaleoutLadderLedger();
    hydrateScaleoutLadderFromDisk(dir);
    runScaleoutLadderObservePass(
      [{ id: 'pos-1', symbol: 'AAPL', side: 'buy', entryPrice: 100, quantity: 1000 }],
      new Map([['AAPL', 124]]),
      1_700_000_100_000,
    );

    const close = summarizeScaleoutLadder();
    expect(close.trimCount).toBe(0); // SAME as the blind case…
    expect(close.positionCount).toBe(0); // …and so is the old positionCount…
    expect(close.observedPositionCount).toBe(1); // …but the pass is demonstrably WATCHING
    expect(close.observeStatus).toBe('observing');
    expect(close.maxGainPctLastPass).toBeCloseTo(0.24, 10);
    expect(close.maxGainPctObserved).toBeCloseTo(0.24, 10); // 1pp under firstRungUp
    expect(close.firstRungUp).toBe(0.25);
    expect(close.maxGainObserved?.symbol).toBe('AAPL');
  });

  it('the pass fires the ladder AND reports itself when a rung is crossed', () => {
    hydrateScaleoutLadderFromDisk(dir);
    runScaleoutLadderObservePass(
      [{ id: 'pos-1', symbol: 'AAPL', side: 'buy', entryPrice: 100, quantity: 1000 }],
      new Map([['AAPL', 125]]), // +25% — the first rung
      1_000,
    );
    const s = summarizeScaleoutLadder();
    expect(s.trimCount).toBe(1); // the ladder still works…
    expect(s.recent[0]!.up).toBe(0.25);
    expect(s.observedPositionCount).toBe(1); // …and the pass now reports itself too
    expect(s.maxGainPctObserved).toBeCloseTo(0.25, 10);
  });

  it('an UNPRICED position is walked but not observed — the gap is visible, not swallowed', () => {
    hydrateScaleoutLadderFromDisk(dir);
    runScaleoutLadderObservePass(
      [
        { id: 'p1', symbol: 'AAPL', side: 'buy', entryPrice: 100, quantity: 10 },
        { id: 'p2', symbol: 'NOQUOTE', side: 'buy', entryPrice: 100, quantity: 10 }, // no mark
        { id: 'p3', symbol: 'BADENTRY', side: 'buy', entryPrice: 0, quantity: 10 }, // degenerate
      ],
      new Map([['AAPL', 110], ['BADENTRY', 50]]),
      1_000,
    );
    const s = summarizeScaleoutLadder();
    expect(s.openPositionCount).toBe(3); // the book had 3…
    expect(s.observedPositionCount).toBe(1); // …the pass could only evaluate 1
    // The degenerate row's `gainPct: 0` must NOT have become the high-water — a false
    // zero there would read as a real "sitting at entry" observation.
    expect(s.maxGainPctObserved).toBeCloseTo(0.1, 10);
  });

  it('a pass with no observation NEVER stamps a false 0 over a real high-water', () => {
    hydrateScaleoutLadderFromDisk(dir);
    recordScaleoutObservePass(
      { openPositionCount: 1, observed: [{ positionId: 'p1', symbol: 'MSFT', gainPct: 0.18 }] },
      1_000,
    );
    // The position closes; the next pass sees an empty book.
    recordScaleoutObservePass({ openPositionCount: 0, observed: [] }, 2_000);

    const s = summarizeScaleoutLadder();
    expect(s.observedPositionCount).toBe(0);
    expect(s.maxGainPctLastPass).toBeNull(); // this pass measured nothing…
    expect(s.maxGainPctObserved).toBeCloseTo(0.18, 10); // …and the high-water HELD
  });

  it('the high-water is a MONOTONE max — a lower later reading does not pull it down', () => {
    hydrateScaleoutLadderFromDisk(dir);
    recordScaleoutObservePass(
      { openPositionCount: 1, observed: [{ positionId: 'p1', symbol: 'NVDA', gainPct: 0.22 }] },
      1_000,
    );
    recordScaleoutObservePass(
      { openPositionCount: 1, observed: [{ positionId: 'p1', symbol: 'NVDA', gainPct: 0.05 }] },
      2_000,
    );
    const s = summarizeScaleoutLadder();
    expect(s.maxGainPctObserved).toBeCloseTo(0.22, 10);
    expect(s.maxGainPctLastPass).toBeCloseTo(0.05, 10);
    expect(s.maxGainObserved?.ts).toBe(1_000); // the high-water keeps ITS OWN timestamp
  });

  it('the pass max is the BEST of the positions observed, not the first or last', () => {
    hydrateScaleoutLadderFromDisk(dir);
    recordScaleoutObservePass(
      {
        openPositionCount: 3,
        observed: [
          { positionId: 'p1', symbol: 'AAPL', gainPct: 0.03 },
          { positionId: 'p2', symbol: 'MSFT', gainPct: 0.19 },
          { positionId: 'p3', symbol: 'TSLA', gainPct: -0.11 }, // underwater: still OBSERVED
        ],
      },
      1_000,
    );
    const s = summarizeScaleoutLadder();
    expect(s.observedPositionCount).toBe(3);
    expect(s.openPositionCount).toBe(3);
    expect(s.maxGainPctLastPass).toBeCloseTo(0.19, 10);
    expect(s.maxGainObserved?.symbol).toBe('MSFT');
  });

  it('NEVER_RAN is not BLIND: no pass yet reads null, not 0', () => {
    hydrateScaleoutLadderFromDisk(dir);
    const s = summarizeScaleoutLadder();
    expect(s.observeStatus).toBe('never_ran');
    expect(s.observedPositionCount).toBeNull(); // null = no reading — NOT "saw an empty book"
    expect(s.lastObservePassAt).toBeNull();
    expect(s.observePassCount).toBe(0);
  });

  it('observePassCount PROVES the pass fires — an empty pass still ticks it', () => {
    hydrateScaleoutLadderFromDisk(dir);
    recordScaleoutObservePass({ openPositionCount: 0, observed: [] }, 1_000);
    recordScaleoutObservePass({ openPositionCount: 0, observed: [] }, 2_000);
    expect(summarizeScaleoutLadder().observePassCount).toBe(2);
  });

  it('an unpriced/degenerate row shows up as openPositionCount > observedPositionCount', () => {
    hydrateScaleoutLadderFromDisk(dir);
    // The engine drops rows it cannot price or whose entry/qty is degenerate; the pass
    // still reports the book size, so the gap is visible rather than silently swallowed.
    recordScaleoutObservePass(
      { openPositionCount: 2, observed: [{ positionId: 'p1', symbol: 'AAPL', gainPct: 0.05 }] },
      1_000,
    );
    const s = summarizeScaleoutLadder();
    expect(s.openPositionCount).toBe(2);
    expect(s.observedPositionCount).toBe(1);
    expect(s.observeStatus).toBe('observing');
  });

  it('SURVIVES RESTART: the high-water rehydrates from DATA_DIR, the pass counters do NOT', () => {
    hydrateScaleoutLadderFromDisk(dir);
    recordScaleoutObservePass(
      { openPositionCount: 1, observed: [{ positionId: 'p1', symbol: 'AAPL', gainPct: 0.21 }] },
      1_000,
    );
    expect(existsSync(scaleoutLadderObservePath(dir))).toBe(true);

    // Simulate the ~daily demo-host reboot.
    clearScaleoutLadderLedger();
    const h = hydrateScaleoutLadderFromDisk(dir);
    expect(h.maxGainPctObserved).toBeCloseTo(0.21, 10);

    const s = summarizeScaleoutLadder();
    expect(s.maxGainPctObserved).toBeCloseTo(0.21, 10); // durable: how close we ever got
    // …but the LIVENESS fields are deliberately since-boot. A pass that ran before the
    // reboot is no evidence the pass runs NOW, so they must not survive it.
    expect(s.observeStatus).toBe('never_ran');
    expect(s.observedPositionCount).toBeNull();
    expect(s.observePassCount).toBe(0);
  });

  it('a corrupt high-water snapshot is ignored, not laundered into a 0', () => {
    hydrateScaleoutLadderFromDisk(dir);
    writeFileSync(scaleoutLadderObservePath(dir), '{"gainPct":"NOT_A_NUMBER"', 'utf8');
    clearScaleoutLadderLedger();
    const h = hydrateScaleoutLadderFromDisk(dir);
    expect(h.maxGainPctObserved).toBeNull(); // null (never measured), NOT 0 (at entry)
    expect(summarizeScaleoutLadder().maxGainPctObserved).toBeNull();
  });

  it('OBSERVE-ONLY: the pass writes only the high-water snapshot — no trim, no order', () => {
    hydrateScaleoutLadderFromDisk(dir);
    recordScaleoutObservePass(
      { openPositionCount: 1, observed: [{ positionId: 'p1', symbol: 'AAPL', gainPct: 0.24 }] },
      1_000,
    );
    const s = summarizeScaleoutLadder();
    expect(s.trimCount).toBe(0); // under the rung ⇒ NOTHING was recorded as a trim
    expect(s.recent).toHaveLength(0);
    expect(existsSync(scaleoutLadderLogPath(dir))).toBe(false); // trim log untouched
  });
});
