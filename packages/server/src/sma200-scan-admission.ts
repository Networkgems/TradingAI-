// TRA-2171 phase 2 — PROCESS-WIDE ADMISSION FOR THE SMA-200 DAILY-BAR SCAN.
//
// `SignalEngine.lastSma200ScanAt` is per-engine and starts at 0, so at cold
// start EVERY engine's throttle reads "never scanned" and all of them fan the
// full daily-bar scan out on their FIRST tick. bqb1 runs >= 5 engines in one
// process (TRA-2205 measured the count from the boot fires), and
// `runSma200Scan` itself fans out 5 concurrent `fetchDailyCandles` at a time —
// so a cold boot puts ~25 concurrent 250-bar daily pulls on one upstream and
// the scans self-contend.
//
// Measured on the 2026-07-24T01:27Z boot (`scripts/tra2203-dotick-tape.mjs`),
// the per-call durations climb monotonically as engines pile on:
//   5.6s -> 5.7s -> 6.1s -> 15.2s -> 17.6s -> 16.1s -> 33.6s -> 46.9s
// The same scan costs ~5.6s uncontended and 46.9s contended (8x), and it
// dragged `doTick`'s max to 60.3s against a 17.3s boot-excluded steady-state
// max. That is self-inflicted queueing, not work.
//
// So admit ONE scan at a time process-wide. Four rules, and the call site
// depends on all four:
//
//   1. TRY, NEVER WAIT. A losing engine gets a synchronous `false` and leaves
//      its throttle UNSTAMPED, so it stays due and retries on its next tick
//      (~30s later). Parking on a mutex instead would just move the 47s from
//      the feed to the lock and leave `doTick` no better off.
//   2. STAMP ONLY ON SUCCESS. No scan is ever dropped — they are only spread
//      across a few ticks instead of colliding on one.
//   3. RELEASE IN A `finally`. A throwing scan must not strand the slot.
//   4. THE SLOT IS A LEASE, NOT A LOCK. If a holder never releases (a hung
//      fetch that outlives its own timeout), the lease expires and the next
//      engine takes it, so one stuck scan can never wedge the scan off for
//      good.
//
// Cost of the deferral is nil: daily bars only change at the daily close, and
// per `runSma200Scan`'s contract BOTH sma200 signals are DISPLAY-ONLY
// (TRA-819), so nothing capital-facing waits on this.

/** How long a holder may hold the slot before the lease is considered stale. */
export const SMA200_SCAN_LEASE_MS = 10 * 60_000;

let leaseUntil = 0;

/**
 * Try to take the process-wide scan slot. Returns synchronously — `false` means
 * another engine holds it and the caller should leave its throttle unstamped
 * and retry next tick. NEVER awaits.
 */
export function trySma200ScanSlot(now: number = Date.now()): boolean {
  if (now < leaseUntil) return false;
  leaseUntil = now + SMA200_SCAN_LEASE_MS;
  return true;
}

/** Hand the slot back. Safe to call when not held. */
export function releaseSma200ScanSlot(): void {
  leaseUntil = 0;
}

/** Test-only reset so a suite cannot inherit another test's held lease. */
export function __resetSma200ScanSlotForTest(): void {
  leaseUntil = 0;
}
