// TRA-3011 — the LOW-WATER MARK for the volume backing DATA_DIR.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `/data` on bqb1 returned `ENOSPC` on every write from 2026-07-30T23:40Z to
// 2026-08-04T~21:20Z. Six days. The `disk-near-full` alarm did not fire once —
// verified against the Render tape with a positive control on the same pulls
// (`ENOSPC` returned 100+ lines on each of 07-30…08-04; `disk-near-full`
// returned zero on every one of them). The reason is settled and already fixed:
// pre-TRA-2817 the alarm graded BLOCKS ONLY, the volume never ran out of blocks
// (383 MB of 1 GB free), and it was the INODE table that was empty. An alarm
// with no failing state on the axis that fired.
//
// TRA-2817 gave the alarm that axis. This module fixes what TRA-2817 could not:
// **the alarm has no memory, so afterwards nobody can tell that it happened.**
//
// Every disk signal on this box is INSTANTANEOUS:
//
//   • `disk.belowThreshold` is a live boolean. Today it reads `false`. It read
//     `false` all through the outage too (blocks-only), and it reads `false`
//     again now that the TRA-2817 prune freed the inodes. Recovered and
//     never-broken are BYTE-IDENTICAL on it.
//   • the alert ring is IN MEMORY and `RING_SIZE` is 100. bqb1 reboots several
//     times a day, so the ring is empty minutes after any incident.
//   • `alerts.jsonl` is the durable record — and it lives ON THE FULL DISK.
//     An `ENOSPC` box cannot append the artifact that says it is out of space.
//     That is not a gap that can be closed with more logging.
//   • the Render log tape is the only surviving evidence, and it retains ~7
//     days: the 07-29 control pull already returns nothing. The proof of a
//     six-day outage expires before most people would think to look for it.
//
// So the signal has to be a SERVED HEALTH FIELD that carries the WORST reading
// seen, not the current one. That is this module. It is fed by `readDiskSpace`
// — the PURE reader — so every caller contributes a sample and nothing here
// ever dispatches an alert or burns the `disk-near-full` throttle window.
//
// ── WHAT IT HONESTLY CANNOT DO ───────────────────────────────────────────────
// It is SINCE BOOT. It cannot be anything else: a durable watermark would have
// to be written to the disk whose exhaustion it is recording. On a box that
// reboots several times a day a fresh `belowThresholdSeen: false` therefore
// means "not since THIS boot", never "not recently" — which is why `bootedAt`
// and `readings` are published beside it. `readings: 0` is NOT MEASURED and is
// not a clean bill of health; a reader that folds it into a pass rebuilds the
// exact bug above.

import type { DiskReading } from './alerts.js';

/** Which exhaustible resource was below the threshold. See `DiskReading`. */
export type DiskExhaustedAxis = 'blocks' | 'inodes' | 'blocks+inodes' | null;

export interface DiskWatermark {
  /** When this watermark started accumulating, i.e. process boot. */
  bootedAt: string;
  /**
   * Readings folded in. **`0` is NOT MEASURED**, never a pass: every field
   * below is `null`/`false` before the first sample, which is exactly what a
   * healthy box looks like. Read this before `belowThresholdSeen`.
   */
  readings: number;
  /**
   * Readings where `statfs` itself failed. A volume that cannot be measured is
   * not a volume that is fine — this is the count that separates the two.
   */
  failedReadings: number;
  lastReadingAt: string | null;
  /**
   * The verdict of the NEWEST reading — blocks or inodes below the threshold.
   *
   * `null` ⇒ no successful reading has been taken (or the newest one was a
   * `statfs` failure). Tri-state, never `false`, for the reason the rest of this
   * file exists: unmeasurable and healthy have to stay distinguishable.
   */
  lastBelowThreshold: boolean | null;
  /** Axis of the newest reading. `null` when neither is exhausted or nothing was read. */
  lastExhausted: DiskExhaustedAxis;
  /** Lowest free-blocks percentage seen. `null` ⇒ no successful reading. */
  freePctMin: number | null;
  /** Bytes available at the moment `freePctMin` was observed. */
  freeBytesMinAt: number | null;
  /**
   * Lowest free-inode percentage seen. `null` ⇒ never measured — which on a
   * filesystem that reports no inode table is permanent and correct, and is NOT
   * the same as "plenty free". See `DiskReading.inodesTotal`.
   */
  inodeFreePctMin: number | null;
  /** Free inodes at the moment `inodeFreePctMin` was observed. */
  inodesFreeMinAt: number | null;
  /**
   * **The field the incident needed.** TRUE ⇒ at least one reading since boot
   * had blocks or inodes below the threshold, whether or not it is below now.
   */
  belowThresholdSeen: boolean;
  /** How many readings were below. `1` of `2000` is a blip; most of them is an outage. */
  belowReadings: number;
  /**
   * Which axis (or both) has been below the threshold since boot. Unioned
   * across readings, so a box that exhausted blocks on Monday and inodes on
   * Tuesday reports `blocks+inodes` rather than only the most recent one.
   */
  exhaustedSeen: DiskExhaustedAxis;
  firstBelowAt: string | null;
  lastBelowAt: string | null;
  /**
   * The threshold in force at the worst reading. TRA-2357's lesson: the
   * 2026-07-25T20:33Z CRITICAL was `16.3% free — below 99%` — a healthy disk
   * against a bad threshold. A watermark without its threshold has the same
   * ambiguity.
   */
  minFreePctAtWorst: number | null;
}

/**
 * How stale a reading may be before the durability verdict calls the disk axis
 * UNMEASURED rather than clean. Matches `storage-health.ts`'s
 * `MONITOR_STALL_SEC`: the reader is the 60s observability monitor, so three
 * missed ticks means the loop that grades this stopped, not that the disk is
 * fine.
 */
export const DISK_READING_MAX_AGE_SEC = 180;

const bootedAt = new Date().toISOString();

let state = freshState();

function freshState() {
  return {
    bootedAt,
    readings: 0,
    failedReadings: 0,
    lastReadingAtMs: null as number | null,
    lastBelowThreshold: null as boolean | null,
    lastBlocksLow: false,
    lastInodesLow: false,
    freePctMin: null as number | null,
    freeBytesMinAt: null as number | null,
    inodeFreePctMin: null as number | null,
    inodesFreeMinAt: null as number | null,
    blocksBelowSeen: false,
    inodesBelowSeen: false,
    belowReadings: 0,
    firstBelowAtMs: null as number | null,
    lastBelowAtMs: null as number | null,
    minFreePctAtWorst: null as number | null,
  };
}

/**
 * Fold one reading into the watermark. Called from `readDiskSpace`, so a poll of
 * any surface that reads the disk contributes. NEVER dispatches and never
 * throws — a watermark that could fail is a watermark that stops recording
 * during exactly the incident it exists to record.
 *
 * `reading === null` (statfs failed) still counts: it increments `readings` and
 * `failedReadings` but touches no minimum, because an unreadable volume must
 * not manufacture a `freePctMin` of anything.
 */
export function recordDiskReading(
  reading: DiskReading | null,
  minFreePct: number,
  nowMs: number = Date.now(),
): void {
  try {
    state.readings += 1;
    state.lastReadingAtMs = nowMs;
    if (!reading) {
      state.failedReadings += 1;
      // A failed statfs makes the CURRENT verdict unknown again. Leaving the
      // last good `false` in place would let one successful boot-time reading
      // certify a volume that has been unreadable ever since.
      state.lastBelowThreshold = null;
      state.lastBlocksLow = false;
      state.lastInodesLow = false;
      return;
    }

    // Track the worst on each axis INDEPENDENTLY. They exhaust separately (the
    // whole TRA-2817 finding is that one can be at 37% while the other is at
    // 0.02%), so a single "worst reading" record would drop whichever axis was
    // not the one that happened to co-occur with the lowest block figure.
    const worseBlocks = state.freePctMin === null || reading.freePct < state.freePctMin;
    if (worseBlocks) {
      state.freePctMin = reading.freePct;
      state.freeBytesMinAt = reading.freeBytes;
      state.minFreePctAtWorst = minFreePct;
    }
    if (
      reading.inodeFreePct !== null
      && (state.inodeFreePctMin === null || reading.inodeFreePct < state.inodeFreePctMin)
    ) {
      state.inodeFreePctMin = reading.inodeFreePct;
      state.inodesFreeMinAt = reading.inodesFree;
      // Only claim the threshold for the worst reading when the blocks axis did
      // not already set it this tick; either is truthful, and this keeps a
      // single-axis box reporting the threshold it was actually graded against.
      if (!worseBlocks) state.minFreePctAtWorst = minFreePct;
    }

    // Same predicate as `checkDiskSpace`, deliberately duplicated in ONE
    // direction only: this module never decides, it only remembers what the
    // alarm's own rule would have said. `inodeFreePct === null` contributes
    // nothing — NOT MEASURED is not an exhaustion.
    const blocksLow = reading.freePct < minFreePct;
    const inodesLow = reading.inodeFreePct !== null && reading.inodeFreePct < minFreePct;
    state.lastBelowThreshold = blocksLow || inodesLow;
    state.lastBlocksLow = blocksLow;
    state.lastInodesLow = inodesLow;
    if (blocksLow) state.blocksBelowSeen = true;
    if (inodesLow) state.inodesBelowSeen = true;
    if (blocksLow || inodesLow) {
      state.belowReadings += 1;
      state.firstBelowAtMs ??= nowMs;
      state.lastBelowAtMs = nowMs;
    }
  } catch {
    // Unreachable by construction; swallowed anyway so an instrument can never
    // be the thing that takes down the process it is instrumenting.
  }
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Read the watermark. PURE and synchronous — safe from any health route. */
function axis(blocks: boolean, inodes: boolean): DiskExhaustedAxis {
  if (blocks && inodes) return 'blocks+inodes';
  if (inodes) return 'inodes';
  if (blocks) return 'blocks';
  return null;
}

export function getDiskWatermark(): DiskWatermark {
  const exhaustedSeen = axis(state.blocksBelowSeen, state.inodesBelowSeen);
  return {
    bootedAt: state.bootedAt,
    readings: state.readings,
    failedReadings: state.failedReadings,
    lastReadingAt: iso(state.lastReadingAtMs),
    lastBelowThreshold: state.lastBelowThreshold,
    lastExhausted: axis(state.lastBlocksLow, state.lastInodesLow),
    freePctMin: state.freePctMin,
    freeBytesMinAt: state.freeBytesMinAt,
    inodeFreePctMin: state.inodeFreePctMin,
    inodesFreeMinAt: state.inodesFreeMinAt,
    belowThresholdSeen: state.blocksBelowSeen || state.inodesBelowSeen,
    belowReadings: state.belowReadings,
    exhaustedSeen,
    firstBelowAt: iso(state.firstBelowAtMs),
    lastBelowAt: iso(state.lastBelowAtMs),
    minFreePctAtWorst: state.minFreePctAtWorst,
  };
}

/**
 * Age of the newest reading, in seconds. `null` ⇒ NOTHING HAS BEEN MEASURED,
 * which is the state a caller must not read as fresh. Deliberately not folded
 * into `getDiskWatermark()` so the snapshot stays a pure value with no clock in
 * it — the caller owns `now`.
 */
export function diskReadingAgeSec(
  watermark: DiskWatermark,
  nowMs: number = Date.now(),
): number | null {
  if (watermark.lastReadingAt === null) return null;
  return Math.round((nowMs - Date.parse(watermark.lastReadingAt)) / 1000);
}

/** Test-only. */
export function __resetDiskWatermarkForTest(): void {
  state = freshState();
}
