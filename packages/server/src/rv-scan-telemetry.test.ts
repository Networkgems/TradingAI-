// TRA-2193 — the instrument whose correct output is "nothing happened" has to be
// PROVEN capable of reporting "something happened", and the two must not render
// the same. That is the whole acceptance criterion, so it is the whole test file.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginRvScan,
  summarizeRvScanPath,
  __resetRvScanTelemetry,
  UNATTRIBUTED_GATE,
} from './rv-scan-telemetry.js';

const T0 = 1_784_700_000_000;
const clock = (): number => T0;

beforeEach(() => {
  __resetRvScanTelemetry();
});

describe('TRA-2193 rv-scan telemetry — unran vs ran-empty', () => {
  it('reports the NEVER-RAN state with null timestamps, not zeros', () => {
    const view = summarizeRvScanPath('directional', { enabled: false, instrumented: true });

    // The false zero this whole issue exists to kill. A `0` here is a valid epoch
    // (1970-01-01) and would pass any `typeof === number` / finite guard on the
    // consumer side while asserting a measurement nobody took.
    expect(view.lastScanAt).toBeNull();
    expect(view.lastFetchOkAt).toBeNull();
    expect(view.lastScan).toBeNull();
    expect(view.scanCountSinceBoot).toBe(0);
  });

  it('MUTATION CHECK: a scan that ran and found nothing is DISTINCT from never having run', () => {
    const unran = summarizeRvScanPath('directional', { enabled: true, instrumented: true });

    // Drive one real pass that evaluates symbols and opens nothing — the "drought".
    const run = beginRvScan('directional', 3, clock);
    for (let i = 0; i < 3; i += 1) {
      run.enterSymbol();
      run.reject('no_trend_confluence');
    }
    run.finish();

    const drought = summarizeRvScanPath('directional', { enabled: true, instrumented: true });

    // Both produced zero opens. If the route could not separate them, this issue
    // would still be open.
    expect(unran.lastScan).toBeNull();
    expect(drought.lastScan).not.toBeNull();
    expect(drought.lastScanAt).toBe(T0);
    expect(drought.scanCountSinceBoot).toBe(1);
    expect(drought.lastScan?.opensPlaced).toBe(0);
    // ...and the drought states WHY it was empty, which the unran state cannot.
    expect(drought.lastScan?.rejectionsByGate).toEqual({ no_trend_confluence: 3 });
  });

  it('an EMPTY UNIVERSE (ran, zero symbols) is distinct from never having run', () => {
    beginRvScan('directional', 0, clock).finish();
    const view = summarizeRvScanPath('directional', { enabled: true, instrumented: true });

    // `universeSize: 0` is a measurement. It is legible only because `lastScan` is
    // a non-null object — the never-ran case has no object at all, rather than an
    // object full of indistinguishable zeros.
    expect(view.lastScan).not.toBeNull();
    expect(view.lastScan?.universeSize).toBe(0);
    expect(view.lastScan?.candidatesEvaluated).toBe(0);
    expect(view.lastScanAt).toBe(T0);
  });

  it('PROOF OF FIRE: a productive scan reports non-null lastScanAt and non-zero candidatesEvaluated', () => {
    const run = beginRvScan('directional', 4, clock);
    run.enterSymbol(); run.reject('no_chain');
    run.enterSymbol(); run.reject('churn_brake');
    run.enterSymbol(); run.pass(); run.opened();
    run.enterSymbol(); run.pass(); run.opened();
    run.fetchOk();
    run.finish();

    const view = summarizeRvScanPath('directional', { enabled: true, instrumented: true });
    expect(view.lastScanAt).not.toBeNull();
    expect(view.lastScan?.candidatesEvaluated).toBe(4);
    expect(view.lastScan?.candidatesPassed).toBe(2);
    expect(view.lastScan?.opensPlaced).toBe(2);
    expect(view.lastFetchOkAt).toBe(T0);
  });
});

describe('TRA-2193 rv-scan telemetry — the buckets must sum', () => {
  it('rejectionsByGate sums to candidatesEvaluated - candidatesPassed', () => {
    const run = beginRvScan('rv_scan', 6, clock);
    run.enterSymbol(); run.reject('no_candidates');
    run.enterSymbol(); run.reject('no_candidates');
    run.enterSymbol(); run.reject('ivr_ceiling');
    run.enterSymbol(); run.reject('earnings_before_expiry');
    run.enterSymbol(); run.pass(); run.opened();
    run.enterSymbol(); run.pass();
    const rec = run.finish();

    const summed = Object.values(rec.rejectionsByGate).reduce((a, b) => a + b, 0);
    // Overshoot = double-counting, undershoot = a silent drop. Either one means
    // the taxonomy is lying about where the symbols went.
    expect(summed).toBe(rec.candidatesEvaluated - rec.candidatesPassed);
    expect(rec.bucketsBalance).toBe(true);
    // Passed-but-not-opened is an ACCOUNT refusal, not a scanner rejection, so it
    // must not appear in the gate buckets.
    expect(rec.candidatesPassed - rec.opensPlaced).toBe(1);
    expect(summed).toBe(4);
  });

  it('an UNTAGGED continue surfaces as a named `unattributed` bucket rather than an unbalanced set', () => {
    const run = beginRvScan('rv_scan', 3, clock);
    run.enterSymbol(); run.reject('no_candidates');
    run.enterSymbol(); // simulates a `continue` with no scanRun.reject() call
    run.enterSymbol(); run.pass(); run.opened();
    const rec = run.finish();

    // The invariant still holds — but the shortfall is NAMED, so an untagged drop
    // is a number someone can act on instead of a silently broken sum.
    expect(rec.rejectionsByGate[UNATTRIBUTED_GATE]).toBe(1);
    expect(rec.bucketsBalance).toBe(true);
    expect(
      Object.values(rec.rejectionsByGate).reduce((a, b) => a + b, 0),
    ).toBe(rec.candidatesEvaluated - rec.candidatesPassed);
  });

  it('MUTATION CHECK: DOUBLE-COUNTING is reported, not clamped away', () => {
    const run = beginRvScan('rv_scan', 2, clock);
    run.enterSymbol(); run.reject('no_candidates');
    // The bug being mutated in: a second `reject()` on the same symbol, which is
    // what a mis-placed tag inside a nested branch produces.
    run.reject('ivr_ceiling');
    run.enterSymbol(); run.pass(); run.opened();
    const rec = run.finish();

    const summed = Object.values(rec.rejectionsByGate).reduce((a, b) => a + b, 0);
    expect(summed).toBe(2);
    expect(rec.candidatesEvaluated - rec.candidatesPassed).toBe(1);
    // Clamping the overshoot to make the sum "work" would hide exactly the defect
    // the invariant is for. It ships as false instead.
    expect(rec.bucketsBalance).toBe(false);
    expect(rec.rejectionsByGate[UNATTRIBUTED_GATE]).toBeUndefined();
  });
});

describe('TRA-2193 rv-scan telemetry — counting the input, not the output', () => {
  it('an ALL-CONTINUE scan reports the symbols it considered, not zero', () => {
    const run = beginRvScan('directional', 5, clock);
    for (let i = 0; i < 5; i += 1) {
      run.enterSymbol();
      run.reject('no_shadow_series');
    }
    const rec = run.finish();

    // Derived-from-results counting would report 0 here — bit-identical to a scan
    // that never ran, re-creating the false zero one layer down (TRA-1729).
    expect(rec.candidatesEvaluated).toBe(5);
    expect(rec.candidatesPassed).toBe(0);
    expect(rec.opensPlaced).toBe(0);
    // And it names the cause: every symbol lacked a 5m series — a FEED problem,
    // which is a different remedy from a quiet tape.
    expect(rec.rejectionsByGate).toEqual({ no_shadow_series: 5 });
  });

  it('an early BREAK leaves universeSize > candidatesEvaluated with a stated reason', () => {
    const run = beginRvScan('rv_scan', 10, clock);
    run.enterSymbol(); run.reject('no_candidates');
    run.enterSymbol(); run.reject('no_candidates');
    run.stopEarly('iv_rv_cap_headroom');
    const rec = run.finish();

    // The gap is real and must not read as a partial crash.
    expect(rec.universeSize).toBe(10);
    expect(rec.candidatesEvaluated).toBe(2);
    expect(rec.stoppedEarlyReason).toBe('iv_rv_cap_headroom');
    expect(rec.bucketsBalance).toBe(true);
  });

  it('an ABANDONED run (thrown out of, never finished) records NOTHING', () => {
    const run = beginRvScan('directional', 3, clock);
    run.enterSymbol();
    run.enterSymbol();
    // no finish() — the scan died mid-loop

    const view = summarizeRvScanPath('directional', { enabled: true, instrumented: true });
    // A crashed scan must not be able to present itself as a completed empty one.
    expect(view.lastScan).toBeNull();
    expect(view.lastScanAt).toBeNull();
    expect(view.scanCountSinceBoot).toBe(0);
  });

  it('finish() is idempotent — a double commit cannot inflate scanCountSinceBoot', () => {
    const run = beginRvScan('directional', 1, clock);
    run.enterSymbol(); run.pass(); run.opened();
    run.finish();
    run.finish();

    expect(
      summarizeRvScanPath('directional', { enabled: true, instrumented: true }).scanCountSinceBoot,
    ).toBe(1);
  });
});

describe('TRA-2193 rv-scan telemetry — instrumented vs unwatched', () => {
  it('an UN-INSTRUMENTED path reports null counters, never zeros', () => {
    const view = summarizeRvScanPath('iv_rv_buy_premium', { enabled: true, instrumented: false });

    // `0` would be a claim about a measurement we never took. The honest report is
    // "we do not watch this path", carried by `instrumented` + nulls.
    expect(view.instrumented).toBe(false);
    expect(view.scanCountSinceBoot).toBeNull();
    expect(view.lastScanAt).toBeNull();
    expect(view.lastScan).toBeNull();
  });

  it('paths are independent — one path scanning does not imply another did', () => {
    beginRvScan('directional', 2, clock).finish();

    expect(
      summarizeRvScanPath('directional', { enabled: true, instrumented: true }).scanCountSinceBoot,
    ).toBe(1);
    // The RV scan is a different sleeve wearing the same journal STRUCTURE label
    // (TRA-1682). Conflating them is the confound this route exists to break.
    expect(
      summarizeRvScanPath('rv_scan', { enabled: false, instrumented: true }).lastScanAt,
    ).toBeNull();
  });

  it('a market-data failure is retained as an error string, distinct from a quiet scan', () => {
    const run = beginRvScan('directional', 2, clock);
    run.enterSymbol(); run.reject('scan_error');
    run.fetchError('AAPL: chain fetch 401');
    run.enterSymbol(); run.reject('scan_error');
    run.finish();

    const view = summarizeRvScanPath('directional', { enabled: true, instrumented: true });
    // OUTAGE: never got a good fetch, and says so.
    expect(view.lastFetchOkAt).toBeNull();
    expect(view.lastFetchError).toBe('AAPL: chain fetch 401');
    expect(view.lastScan?.rejectionsByGate).toEqual({ scan_error: 2 });
  });
});
