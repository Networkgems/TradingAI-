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

// ── TRA-4757 — the DURABLE non-blind observation counter ─────────────────────
//
// TRA-1729 made the observe pass visible; it did NOT make a PAST non-empty book
// visible. Every field it added is either last-pass-only or blind-inclusive, so a
// position that opens and closes between two daily reads leaves no trace. TRA-1318
// samples `observedPositionCount` once per trading day against a 6.5h session and its
// bear branch is "five consecutive zeros ⇒ NO-GO" — which is a FALSE NO-GO the moment
// the zeros are sampling artefacts.
//
// The control for every test below is the same: does the instrument READ DIFFERENTLY
// in the two states it must separate?

/** The standing high-water on the live build this ticket was filed against. */
const LIVE_HIGH_WATER = 0.15268065268065278;

/** Epoch of an instant, named so the ET-fold tests read as times and not as integers. */
function at(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`bad fixture instant: ${iso}`);
  return ms;
}

/** Seed the DATA_DIR with the PRE-TRA-4757 snapshot shape, byte-for-byte. */
function writeLegacySnapshot(gainPct: number, ts: number): void {
  writeFileSync(
    scaleoutLadderObservePath(dir),
    JSON.stringify({ gainPct, symbol: 'GEMI', positionId: 'legacy-pos', ts }) + '\n',
    'utf8',
  );
}

function readSnapshot(): Record<string, unknown> {
  return JSON.parse(readFileSync(scaleoutLadderObservePath(dir), 'utf8')) as Record<
    string,
    unknown
  >;
}

function nonBlindPass(ts: number, gainPct: number, positionId = 'p1'): void {
  recordScaleoutObservePass(
    { openPositionCount: 1, observed: [{ positionId, symbol: 'AAPL', gainPct }] },
    ts,
  );
}

function blindPass(ts: number): void {
  recordScaleoutObservePass({ openPositionCount: 0, observed: [] }, ts);
}

describe('scaleout-ladder-ledger — TRA-4757 durable non-blind accumulator', () => {
  it('THE INCIDENT: a whole position lives and dies invisibly to every TRA-1729 field', () => {
    // The ticket's own worked example, with the live standing high-water in place:
    // a demo equity long opens 14:00Z, is iterated all session, peaks at +3%, exits
    // 18:00Z. By 18:00:01Z the route is back to reporting a dead book.
    writeLegacySnapshot(LIVE_HIGH_WATER, at('2026-07-26T13:50:53Z'));
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-21T00:05:00Z'));

    const open = at('2026-09-21T14:00:00Z');
    for (let i = 0; i < 40; i += 1) nonBlindPass(open + i * 1_000, 0.01 + i * 0.0005);
    const lastSeen = open + 39 * 1_000; // peak 0.0295 — well under the high-water
    blindPass(at('2026-09-21T18:00:01Z'));
    blindPass(at('2026-09-21T18:00:02Z'));

    const s = summarizeScaleoutLadder();

    // ── The three fields that CANNOT see it (this is the bug, asserted) ───────
    expect(s.observedPositionCount).toBe(0); // instant cell: last pass only
    expect(s.observeStatus).toBe('blind');
    expect(s.maxGainPctObserved).toBeCloseTo(LIVE_HIGH_WATER, 12); // high-water unmoved
    expect(s.maxGainPctLastPass).toBeNull();
    // `observePassCount` ticked — but it ticks when blind too, so it is not evidence.
    // The measured live behaviour: two reads apart by nothing but EMPTY passes still
    // show it advancing (3275 → 3277 over ~0.6s against an empty book).
    const before = summarizeScaleoutLadder().observePassCount;
    blindPass(at('2026-09-21T18:00:03Z'));
    blindPass(at('2026-09-21T18:00:04Z'));
    expect(summarizeScaleoutLadder().observePassCount).toBe(before + 2);

    // ── The accumulator, which does see it ───────────────────────────────────
    expect(s.observedNonBlindPassCount).toBe(40);
    expect(s.firstObservedNonBlindAt).toBe(open);
    expect(s.lastObservedNonBlindAt).toBe(lastSeen);
    expect(s.observedEtDaysSeen).toBe(1);
    expect(s.lastObservedEtDay).toBe('2026-09-21');
    // …and a later blind pass does not erase it — that is the whole point.
    expect(summarizeScaleoutLadder().observedNonBlindPassCount).toBe(40);
  });

  it('SURVIVES RESTART: the accumulator rehydrates, so a daily read is a SUPERSET', () => {
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-21T00:05:00Z'));
    nonBlindPass(at('2026-09-21T14:00:00Z'), 0.02);
    nonBlindPass(at('2026-09-21T14:02:00Z'), 0.03); // >60s later ⇒ past the throttle

    // Simulate the mid-week bqb1 reboot. A SINCE-BOOT counter would read 0 here —
    // identical to a durable counter over a genuinely dead book, which trap 2 of the
    // ticket calls out as actively worse than the known-blind instrument.
    clearScaleoutLadderLedger();
    const h = hydrateScaleoutLadderFromDisk(dir, at('2026-09-22T00:05:00Z'));
    expect(h.observedNonBlindPassCount).toBe(2);

    const s = summarizeScaleoutLadder();
    expect(s.observedNonBlindPassCount).toBe(2);
    expect(s.firstObservedNonBlindAt).toBe(at('2026-09-21T14:00:00Z'));
    expect(s.observedEtDaysSeen).toBe(1);
    expect(s.lastObservedEtDay).toBe('2026-09-21');
    // The since-boot liveness fields still do NOT survive — unchanged from TRA-1729.
    expect(s.observeStatus).toBe('never_ran');
    expect(s.observePassCount).toBe(0);

    // Next session accrues ON TOP of the restored total.
    nonBlindPass(at('2026-09-22T14:00:00Z'), 0.04);
    expect(summarizeScaleoutLadder().observedNonBlindPassCount).toBe(3);
  });

  it('NULL IS NOT ZERO: unarmed reports null on every field; armed-and-empty reports 0', () => {
    // Unarmed — no DATA_DIR ever configured. "I have no durable measurement."
    clearScaleoutLadderLedger();
    blindPass(1_000);
    const unarmed = summarizeScaleoutLadder();
    expect(unarmed.observedNonBlindArmedAt).toBeNull();
    expect(unarmed.observedNonBlindPassCount).toBeNull();
    expect(unarmed.firstObservedNonBlindAt).toBeNull();
    expect(unarmed.observedEtDaysSeen).toBeNull();
    expect(unarmed.lastObservedEtDay).toBeNull();

    // Armed against a store, nothing ever seen. "I have watched since armedAt and the
    // book was never non-empty." That is a MEASUREMENT, and a damning one — it must
    // NOT read the same as the line above.
    const armedAt = at('2026-09-21T00:05:00Z');
    hydrateScaleoutLadderFromDisk(dir, armedAt);
    blindPass(at('2026-09-21T14:00:00Z'));
    const armed = summarizeScaleoutLadder();
    expect(armed.observedNonBlindArmedAt).toBe(armedAt);
    expect(armed.observedNonBlindPassCount).toBe(0);
    expect(armed.observedEtDaysSeen).toBe(0);
    // The timestamps stay null — a "never happened" instant has no zero to collide with.
    expect(armed.firstObservedNonBlindAt).toBeNull();
    expect(armed.lastObservedNonBlindAt).toBeNull();
    expect(armed.lastObservedEtDay).toBeNull();
  });

  it('arming is DURABLE and stamped ONCE — a reboot does not restart the counted window', () => {
    const armedAt = at('2026-09-21T00:05:00Z');
    hydrateScaleoutLadderFromDisk(dir, armedAt);
    expect(summarizeScaleoutLadder().observedNonBlindArmedAt).toBe(armedAt);

    clearScaleoutLadderLedger();
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-25T11:00:00Z'));
    // If arming re-stamped on every boot, a `0` would only ever cover the current
    // uptime — which is the since-boot counter wearing a durable counter's clothes.
    expect(summarizeScaleoutLadder().observedNonBlindArmedAt).toBe(armedAt);
  });

  it('BLIND passes never move the accumulator, in any of its fields', () => {
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-21T00:05:00Z'));
    nonBlindPass(at('2026-09-21T14:00:00Z'), 0.02);
    const after = summarizeScaleoutLadder();
    for (let i = 0; i < 500; i += 1) blindPass(at('2026-09-21T15:00:00Z') + i * 450);
    const later = summarizeScaleoutLadder();

    expect(later.observedNonBlindPassCount).toBe(after.observedNonBlindPassCount);
    expect(later.lastObservedNonBlindAt).toBe(after.lastObservedNonBlindAt);
    expect(later.observedEtDaysSeen).toBe(after.observedEtDaysSeen);
    expect(later.lastObservedEtDay).toBe(after.lastObservedEtDay);
    // …and the 500 blind ticks wrote nothing to disk either.
    expect(readSnapshot()).toEqual(readSnapshot());
    const nb = readSnapshot()['nonBlind'] as Record<string, unknown>;
    expect(nb['passCount']).toBe(1);
  });

  it('a row the pass could not PRICE still counts as a non-empty book', () => {
    // Keyed on `observed.length`, not on a finite gainPct: the question is "was there
    // anything there", and a NaN excursion is a pricing defect, not an empty book.
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-21T00:05:00Z'));
    recordScaleoutObservePass(
      { openPositionCount: 1, observed: [{ positionId: 'p1', symbol: 'AAPL', gainPct: NaN }] },
      at('2026-09-21T14:00:00Z'),
    );
    const s = summarizeScaleoutLadder();
    expect(s.observedNonBlindPassCount).toBe(1);
    expect(s.maxGainPctLastPass).toBeNull(); // the excursion is still honestly unknown
    expect(s.maxGainPctObserved).toBeNull();
  });

  it('DAY FOLD IS ET, NOT UTC: a 22:30 ET pass belongs to the session that opened at 09:30 ET', () => {
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-20T12:00:00Z'));
    // 2026-09-21 13:35Z = 09:35 ET, and 2026-09-22 02:30Z = 2026-09-21 22:30 ET.
    // A UTC fold would call these two different days and report etDaysSeen: 2.
    nonBlindPass(at('2026-09-21T13:35:00Z'), 0.02);
    nonBlindPass(at('2026-09-22T02:30:00Z'), 0.02);
    const sameDay = summarizeScaleoutLadder();
    expect(sameDay.observedEtDaysSeen).toBe(1);
    expect(sameDay.lastObservedEtDay).toBe('2026-09-21');

    // The next ET day genuinely rolls it.
    nonBlindPass(at('2026-09-22T13:35:00Z'), 0.02);
    const nextDay = summarizeScaleoutLadder();
    expect(nextDay.observedEtDaysSeen).toBe(2);
    expect(nextDay.lastObservedEtDay).toBe('2026-09-22');
  });

  it('BACK-COMPAT: a pre-TRA-4757 snapshot keeps its ~56-day-old high-water AND gets armed', () => {
    // The live bqb1 store: a GEMI high-water stamped 2026-07-26 that survived a boot at
    // ~55.97 days old. Shipping this must not cost that.
    const stamped = at('2026-07-26T13:50:53Z');
    writeLegacySnapshot(LIVE_HIGH_WATER, stamped);
    const armedAt = at('2026-09-21T00:05:00Z');
    const h = hydrateScaleoutLadderFromDisk(dir, armedAt);

    expect(h.maxGainPctObserved).toBeCloseTo(LIVE_HIGH_WATER, 12);
    const s = summarizeScaleoutLadder();
    expect(s.maxGainObserved).toEqual({
      gainPct: LIVE_HIGH_WATER,
      symbol: 'GEMI',
      positionId: 'legacy-pos',
      ts: stamped,
    });
    expect(s.observedNonBlindArmedAt).toBe(armedAt);
    expect(s.observedNonBlindPassCount).toBe(0); // armed, nothing seen — not null
  });

  it('FORWARD-COMPAT: the widened file still satisfies the OLD build\'s shape check', () => {
    // A rollback past this commit must still hydrate the high-water. The predicate
    // below is the pre-TRA-4757 validator, transcribed verbatim from the shape check
    // that shipped with TRA-1729 — the nested `nonBlind` key is simply ignored by it.
    const stamped = at('2026-07-26T13:50:53Z');
    writeLegacySnapshot(LIVE_HIGH_WATER, stamped);
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-21T00:05:00Z'));
    nonBlindPass(at('2026-09-21T14:00:00Z'), 0.02);

    const rec = readSnapshot();
    expect(rec['nonBlind']).toBeTruthy(); // the new block IS there
    const oldBuildAccepts =
      typeof rec['gainPct'] === 'number' &&
      Number.isFinite(rec['gainPct']) &&
      typeof rec['symbol'] === 'string' &&
      typeof rec['positionId'] === 'string' &&
      typeof rec['ts'] === 'number';
    expect(oldBuildAccepts).toBe(true);
    expect(rec['gainPct']).toBeCloseTo(LIVE_HIGH_WATER, 12);
  });

  it('a corrupt accumulator block reads NULL and re-arms — and does not take the high-water down', () => {
    const stamped = at('2026-07-26T13:50:53Z');
    writeFileSync(
      scaleoutLadderObservePath(dir),
      JSON.stringify({
        gainPct: LIVE_HIGH_WATER,
        symbol: 'GEMI',
        positionId: 'legacy-pos',
        ts: stamped,
        nonBlind: { armedAt: 'NOT_A_NUMBER', passCount: 12 },
      }) + '\n',
      'utf8',
    );
    const reArmedAt = at('2026-09-21T00:05:00Z');
    hydrateScaleoutLadderFromDisk(dir, reArmedAt);

    const s = summarizeScaleoutLadder();
    // The garbage `passCount: 12` is NOT laundered through — a corrupt block is an
    // absence of measurement, and the re-arm says truthfully that the window starts now.
    expect(s.observedNonBlindPassCount).toBe(0);
    expect(s.observedNonBlindArmedAt).toBe(reArmedAt);
    // …and the two blocks are validated independently, so the high-water survives.
    expect(s.maxGainPctObserved).toBeCloseTo(LIVE_HIGH_WATER, 12);
  });

  it('the LOAD-BEARING edge (0 → >=1) is flushed immediately, never throttled away', () => {
    // The durable count is a lower bound: the rewrite is throttled to 60s, so a hard
    // reboot can drop ticks. It must NEVER be able to drop the FIRST one — that is the
    // difference between "the book was non-empty at some point" and a false NO-GO.
    //
    // ⚠️ THE FIXTURE IS THE TEST, and it has THREE masks to defeat. All three were
    // found by mutation — each one made this test green against an implementation with
    // no immediate flush at all:
    //   1. TIMING — arming writes the snapshot and therefore STARTS the throttle clock,
    //      so a first pass an hour later gets flushed by the ordinary throttle branch.
    //      The pass below lands 5s after the arm, inside the window.
    //   2. THE HIGH-WATER — a pass that sets a NEW high-water flushes through that path
    //      instead. So the store is seeded with the live standing high-water (0.15268)
    //      and the pass sits at +2%, which advances nothing. That is also the realistic
    //      case: on bqb1 the high-water has stood since 2026-07-26, so essentially no
    //      ordinary pass advances it.
    //   3. EACH OTHER — and this one is NOT defeated by the fixture, because it cannot
    //      be. The first non-blind pass ever ALWAYS also changes the ET day (from
    //      `null`), so the edge flush and the day-rollover flush are redundant by
    //      construction: mutating away EITHER ONE leaves this test green, and only
    //      removing BOTH turns it red (measured). What this test grades is therefore
    //      the PROPERTY — "the first non-blind pass is durable across an immediate
    //      crash" — not one particular line.
    //      ⛔ So do NOT read a green here as licence to delete one of the two as dead
    //      code. The ticket calls the ET day fields a nice-to-have that may be dropped;
    //      the moment they go, the edge flush is the only thing left holding this up.
    writeLegacySnapshot(LIVE_HIGH_WATER, at('2026-07-26T13:50:53Z'));
    const armedAt = at('2026-09-21T12:50:54Z'); // bqb1's actual pre-open boot instant
    hydrateScaleoutLadderFromDisk(dir, armedAt);
    const first = armedAt + 5_000;
    nonBlindPass(first, 0.02);
    // Crash here: nothing else ran, nothing else flushed.
    clearScaleoutLadderLedger();
    const h = hydrateScaleoutLadderFromDisk(dir, first + 2_000);
    expect(h.observedNonBlindPassCount).toBe(1);
    expect(summarizeScaleoutLadder().firstObservedNonBlindAt).toBe(first);
  });

  it('an ET DAY ROLLOVER inside the throttle window is flushed immediately too', () => {
    // Same trap, same fixture discipline: the two passes below are 40s apart, so the
    // throttle branch cannot save the second one. Only the rollover's own immediate
    // flush persists `etDaysSeen: 2` across the crash. Spaced further apart, this test
    // would be green against an implementation that had no day flush at all. The
    // standing high-water is seeded for the same reason as the test above: a pass that
    // advances it flushes through that path and masks the one being graded here.
    writeLegacySnapshot(LIVE_HIGH_WATER, at('2026-07-26T13:50:53Z'));
    const armedAt = at('2026-09-21T03:50:00Z'); // 23:50 ET on 09-20
    hydrateScaleoutLadderFromDisk(dir, armedAt);
    nonBlindPass(at('2026-09-21T03:59:30Z'), 0.02); // 23:59:30 ET 09-20 — the 0 → 1 edge
    nonBlindPass(at('2026-09-21T04:00:10Z'), 0.02); // 00:00:10 ET 09-21 — 40s later

    clearScaleoutLadderLedger();
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-21T04:01:00Z'));
    const s = summarizeScaleoutLadder();
    expect(s.observedEtDaysSeen).toBe(2);
    expect(s.lastObservedEtDay).toBe('2026-09-21');
  });

  it('the durable count LAGS the in-memory one by at most the throttle, and only DOWNWARD', () => {
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-21T00:05:00Z'));
    const t0 = at('2026-09-21T14:00:00.000Z');
    // 100 passes inside one 60s window: the first flushes (it is the 0 → 1 edge), the
    // other 99 ride the throttle.
    for (let i = 0; i < 100; i += 1) nonBlindPass(t0 + i * 450, 0.02);
    expect(summarizeScaleoutLadder().observedNonBlindPassCount).toBe(100); // exact live

    const persisted = (readSnapshot()['nonBlind'] as Record<string, unknown>)['passCount'] as number;
    expect(persisted).toBeLessThan(100); // lagging…
    expect(persisted).toBeGreaterThanOrEqual(1); // …but never below the edge, and never
    // above the truth — an over-count would be a manufactured sighting, which is the one
    // direction a gate must not be wrong in.
    expect(persisted).toBeLessThanOrEqual(100);

    // Past the throttle it catches up.
    nonBlindPass(t0 + 61_000, 0.02);
    expect((readSnapshot()['nonBlind'] as Record<string, unknown>)['passCount']).toBe(101);
  });

  it('OBSERVE-ONLY still: the accumulator never touches the trim log or a book', () => {
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-21T00:05:00Z'));
    for (let i = 0; i < 50; i += 1) nonBlindPass(at('2026-09-21T14:00:00Z') + i * 450, 0.02);
    expect(summarizeScaleoutLadder().trimCount).toBe(0);
    expect(summarizeScaleoutLadder().recent).toHaveLength(0);
    expect(existsSync(scaleoutLadderLogPath(dir))).toBe(false);
  });

  it('the pass the ENGINE runs feeds the accumulator (not just the direct recorder)', () => {
    // The same-function discipline TRA-1729 set: grade the loop that actually runs.
    hydrateScaleoutLadderFromDisk(dir, at('2026-09-21T00:05:00Z'));
    runScaleoutLadderObservePass(
      [{ id: 'p1', symbol: 'AAPL', side: 'buy', entryPrice: 100, quantity: 10 }],
      new Map([['AAPL', 103]]),
      at('2026-09-21T14:00:00Z'),
    );
    expect(summarizeScaleoutLadder().observedNonBlindPassCount).toBe(1);

    // An empty book through the same entry point stays blind.
    runScaleoutLadderObservePass([], new Map(), at('2026-09-21T14:00:01Z'));
    const s = summarizeScaleoutLadder();
    expect(s.observeStatus).toBe('blind');
    expect(s.observedNonBlindPassCount).toBe(1); // …and the accumulator remembers
  });
});
