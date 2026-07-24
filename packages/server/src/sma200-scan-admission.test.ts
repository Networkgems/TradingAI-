import { describe, it, expect, beforeEach } from 'vitest';
import {
  SMA200_SCAN_LEASE_MS,
  trySma200ScanSlot,
  releaseSma200ScanSlot,
  __resetSma200ScanSlotForTest,
} from './sma200-scan-admission.js';

// TRA-2171 phase 2 — pin the four admission rules the doTick call site depends
// on. `trySma200ScanSlot` takes `now` as a parameter precisely so this suite can
// advance the clock without faking timers.

describe('TRA-2171 sma200 scan admission', () => {
  const T0 = Date.parse('2026-07-24T01:27:42Z');

  beforeEach(() => {
    __resetSma200ScanSlotForTest();
  });

  it('admits exactly one of five engines racing on the same cold-start tick', () => {
    // Five engines, all due (throttle 0), all calling within the same tick.
    const admitted = [0, 1, 2, 3, 4].filter(() => trySma200ScanSlot(T0));
    expect(admitted).toHaveLength(1);
  });

  it('rule 1 — try, never wait: a losing engine gets a synchronous false', () => {
    expect(trySma200ScanSlot(T0)).toBe(true);
    // If this parked instead of returning, the 47s would move from the feed to
    // the lock and doTick would be no better off — the whole reason it is a
    // try-acquire. A boolean return type is the enforcement.
    const result: boolean = trySma200ScanSlot(T0 + 1);
    expect(result).toBe(false);
  });

  it('rule 3 — release hands the slot to the next engine', () => {
    expect(trySma200ScanSlot(T0)).toBe(true);
    expect(trySma200ScanSlot(T0 + 1)).toBe(false);
    releaseSma200ScanSlot();
    expect(trySma200ScanSlot(T0 + 2)).toBe(true);
  });

  it('rule 2 — five due engines spread across five ticks; none is dropped', () => {
    const TICK_MS = 30_000;
    // A losing engine leaves its throttle unstamped, so it stays due and
    // retries. Model that: 5 due engines, one tick at a time, the winner
    // completes its scan inside the tick.
    let due = 5;
    let ticks = 0;
    let now = T0;
    while (due > 0 && ticks < 20) {
      ticks++;
      if (trySma200ScanSlot(now)) {
        due--;
        releaseSma200ScanSlot();
      }
      now += TICK_MS;
    }
    expect(due).toBe(0);
    expect(ticks).toBe(5); // spread across ticks, not dropped
  });

  it('rule 4 — the lease expires so a hung scan cannot wedge the scan off', () => {
    expect(trySma200ScanSlot(T0)).toBe(true);
    // Holder hangs: `releaseSma200ScanSlot` is never reached.
    expect(trySma200ScanSlot(T0 + SMA200_SCAN_LEASE_MS - 1)).toBe(false);
    expect(trySma200ScanSlot(T0 + SMA200_SCAN_LEASE_MS)).toBe(true);
  });

  it('the lease is long enough to cover a contended scan, short enough to self-heal', () => {
    // The worst measured contended scan was 46.9s; the lease must exceed that by
    // a wide margin or a slow-but-healthy scan would have its slot stolen and
    // the contention would come straight back.
    expect(SMA200_SCAN_LEASE_MS).toBeGreaterThan(47_000 * 4);
    // …and it must be well under the 4h scan cadence, or an expiry would race
    // the next scheduled scan instead of just recovering a stuck one.
    expect(SMA200_SCAN_LEASE_MS).toBeLessThan(4 * 60 * 60_000);
  });
});
