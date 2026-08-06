import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordDiskReading,
  getDiskWatermark,
  diskReadingAgeSec,
  __resetDiskWatermarkForTest,
} from './disk-watermark.js';
import type { DiskReading } from './alerts.js';

// TRA-3011 — `/data` on bqb1 returned ENOSPC on every write from 2026-07-30T23:40Z
// to 2026-08-04T~21:20Z and NOTHING alerted. The alarm's blindness is TRA-2817's
// (it graded blocks only; the volume ran out of inodes). What is left, and what
// these tests pin, is that the alarm had no MEMORY: afterwards there was no field
// anywhere that could distinguish a box that filled and recovered from one that
// was never full.
//
// So the control that matters throughout is: build the RECOVERED state — a
// current reading that is completely healthy — and assert it does NOT read as
// never-broken.

const T0 = Date.parse('2026-08-01T00:00:00Z');

/** A reading. Defaults are healthy; override one axis to build a failing one. */
function reading(over: Partial<DiskReading> = {}): DiskReading {
  return {
    path: '/data',
    totalBytes: 1_020_702_720,
    freeBytes: 692_854_784,
    freePct: 67.88,
    reservedBytes: 16_777_216,
    inodesTotal: 65_536,
    inodesFree: 42_470,
    inodeFreePct: 64.8,
    ...over,
  };
}

/** bqb1 on 2026-07-30: bytes fine, inode table empty. The reading that fired. */
const TRA2817 = reading({
  freeBytes: 383_434_752,
  freePct: 37.566,
  inodesFree: 12,
  inodeFreePct: 0.018,
});

describe('disk watermark (TRA-3011)', () => {
  beforeEach(() => __resetDiskWatermarkForTest());

  it('records nothing as NOT MEASURED — the empty watermark is not a pass', () => {
    const w = getDiskWatermark();
    expect(w.readings).toBe(0);
    // The failing state that must exist: no reading is UNKNOWN, and the caller
    // has to be able to see that rather than infer health from a quiet object.
    expect(w.lastBelowThreshold).toBeNull();
    expect(w.freePctMin).toBeNull();
    expect(w.inodeFreePctMin).toBeNull();
    expect(w.belowThresholdSeen).toBe(false);
    expect(diskReadingAgeSec(w, T0)).toBeNull();
  });

  it('★ RECOVERED does not read as NEVER-BROKEN — the whole point of the module', () => {
    recordDiskReading(TRA2817, 10, T0);
    recordDiskReading(reading(), 10, T0 + 60_000); // the TRA-2817 prune ran

    const w = getDiskWatermark();
    // Every INSTANTANEOUS field is now clean. This is what /api/health/storage,
    // /api/health/durability and the alert ring all showed on 2026-08-05.
    expect(w.lastBelowThreshold).toBe(false);
    expect(w.lastExhausted).toBeNull();
    // And the memory says otherwise.
    expect(w.belowThresholdSeen).toBe(true);
    expect(w.exhaustedSeen).toBe('inodes');
    expect(w.belowReadings).toBe(1);
    expect(w.firstBelowAt).toBe(new Date(T0).toISOString());
    expect(w.lastBelowAt).toBe(new Date(T0).toISOString());
    expect(w.inodeFreePctMin).toBe(0.018);
    expect(w.inodesFreeMinAt).toBe(12);
  });

  it('the negative control: a box that was never full reads clean on the SAME fields', () => {
    recordDiskReading(reading(), 10, T0);
    recordDiskReading(reading(), 10, T0 + 60_000);
    const w = getDiskWatermark();
    expect(w.belowThresholdSeen).toBe(false);
    expect(w.exhaustedSeen).toBeNull();
    expect(w.belowReadings).toBe(0);
    expect(w.firstBelowAt).toBeNull();
    expect(w.readings).toBe(2);
  });

  it('tracks the two axes INDEPENDENTLY — the worst inode reading is not the worst byte reading', () => {
    // TRA-2817's finding is that these exhaust separately. A single "worst
    // reading" record would keep whichever row happened to carry the lowest
    // block figure and silently drop the inode minimum that actually mattered.
    recordDiskReading(reading({ freePct: 12, inodeFreePct: 64 }), 10, T0);
    recordDiskReading(reading({ freePct: 60, inodeFreePct: 0.5, inodesFree: 300 }), 10, T0 + 1000);

    const w = getDiskWatermark();
    expect(w.freePctMin).toBe(12);
    expect(w.inodeFreePctMin).toBe(0.5);
    expect(w.inodesFreeMinAt).toBe(300);
    expect(w.exhaustedSeen).toBe('inodes'); // 12% > 10% threshold; only inodes tripped
  });

  it('unions the axes across readings, so Monday-blocks + Tuesday-inodes reads as both', () => {
    recordDiskReading(reading({ freePct: 2 }), 10, T0);
    recordDiskReading(reading({ inodeFreePct: 1, inodesFree: 600 }), 10, T0 + 86_400_000);
    const w = getDiskWatermark();
    expect(w.exhaustedSeen).toBe('blocks+inodes');
    // …while the NEWEST reading names only the axis that is live right now.
    expect(w.lastExhausted).toBe('inodes');
  });

  it('a filesystem with no inode table contributes NOTHING — null is not an exhaustion', () => {
    // NTFS/tmpfs report `files === 0`, which `readDiskSpace` maps to null. A
    // synthesised 0% there would make this a permanent false alarm.
    recordDiskReading(reading({ inodesTotal: null, inodesFree: null, inodeFreePct: null }), 10, T0);
    const w = getDiskWatermark();
    expect(w.belowThresholdSeen).toBe(false);
    expect(w.inodeFreePctMin).toBeNull();
    expect(w.readings).toBe(1);
  });

  it('a failed statfs is a RECORDED reading that RESETS the current verdict to unknown', () => {
    recordDiskReading(reading(), 10, T0);
    expect(getDiskWatermark().lastBelowThreshold).toBe(false);

    recordDiskReading(null, 10, T0 + 60_000);
    const w = getDiskWatermark();
    // The failing state: one good boot-time sample must not go on certifying a
    // volume that has been unreadable ever since.
    expect(w.lastBelowThreshold).toBeNull();
    expect(w.failedReadings).toBe(1);
    expect(w.readings).toBe(2);
    // …but the historical minima survive: an unreadable disk says nothing about
    // what was seen before it went unreadable.
    expect(w.freePctMin).toBe(67.88);
  });

  it('remembers the THRESHOLD in force at the worst reading (TRA-2357)', () => {
    // The 2026-07-25T20:33Z CRITICAL was "16.3% free — below 99%": a healthy
    // disk against a bad threshold. A watermark without its threshold carries
    // the same ambiguity.
    recordDiskReading(reading({ freePct: 16.3 }), 99, T0);
    const w = getDiskWatermark();
    expect(w.freePctMin).toBe(16.3);
    expect(w.minFreePctAtWorst).toBe(99);
    expect(w.belowThresholdSeen).toBe(true);
  });

  it('ages the newest reading so a stopped feeder is visible', () => {
    recordDiskReading(reading(), 10, T0);
    expect(diskReadingAgeSec(getDiskWatermark(), T0 + 120_000)).toBe(120);
  });
});
