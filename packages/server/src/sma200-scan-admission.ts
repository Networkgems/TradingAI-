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

import type { Candle } from '@trading-app/shared';

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

// TRA-4457 S2 — PROCESS-WIDE DAILY-BAR MEMO FOR THE SWEEP.
//
// The slot above serialises the engines' sweeps; it does not DEDUPLICATE them.
// Every engine re-pulls every symbol in its own universe, and the universes
// overlap almost entirely. Measured on bqb1 2026-09-10 off the S1 census: one
// fleet batch handed the sweep 18,291-29,008 symbols against a union of <= 755
// (identical 288- and 282-symbol universes recurring 18x and 14x) — ~25 daily
// pulls per distinct name per batch. The only sighted sweeps that day ran in
// the first ~40s after a boot and were then tripped by their OWN pulls
// (`dailyChart(ZM)` 20:15:23Z, `dailyChart(GNRC)` 20:19:43Z) after ~2,400
// requests. A per-source breaker split cannot help there — a bar storm backing
// off bar pulls is the split working as designed. Fetching each name once is.
//
// Three rules:
//
//   1. NEVER MEMOIZE AN EMPTY RESULT. `[]` is what `fetchDailyCandles` returns
//      while the Yahoo breaker is open, without asking. Caching it would pin one
//      engine's starve onto the whole fleet for the TTL — the exact defect this
//      memo exists to relieve, made worse.
//   2. SHORT TTL. A fleet batch spans minutes; a sweep recurs every 4h. The TTL
//      only has to outlive one batch, and must never carry a pre-open pull into
//      the session whose bar it cannot see (bar-rollover voiding reads the
//      latest bar off these very candles).
//   3. NOTHING RESIDENT BETWEEN BATCHES. A full union is ~755 x 280 candles
//      (~20MB) on a memory-watched host, so a timer drops expired entries
//      instead of holding them until the next sweep 4h later.
//
// The memo is keyed by depth as well as symbol and is private to the sweep; the
// other `fetchDailyCandles` callers (OTM ATR, MTF snapshots) keep their own
// caching and are untouched.

/** How long one sweep's pull may serve the next engine's sweep. */
export const SMA200_CANDLE_MEMO_MS = 10 * 60_000;

const candleMemo = new Map<string, { at: number; candles: Candle[] }>();
let memoPruneTimer: ReturnType<typeof setTimeout> | null = null;

function pruneCandleMemo(now: number): void {
  for (const [key, entry] of candleMemo) {
    if (now - entry.at >= SMA200_CANDLE_MEMO_MS) candleMemo.delete(key);
  }
}

function scheduleCandleMemoPrune(): void {
  if (memoPruneTimer) return;
  memoPruneTimer = setTimeout(() => {
    memoPruneTimer = null;
    pruneCandleMemo(Date.now());
    if (candleMemo.size > 0) scheduleCandleMemoPrune();
  }, SMA200_CANDLE_MEMO_MS);
  memoPruneTimer.unref?.();
}

/**
 * Daily bars for the SMA-200 sweep, shared across every engine in the process.
 * `fromMemo` is reported so the sweep census can say how many of its scored
 * symbols cost a request — a dedup nobody can observe is not a control.
 */
export async function fetchSma200CandlesShared(
  symbol: string,
  count: number,
  fetch: (symbol: string, count: number) => Promise<Candle[]>,
): Promise<{ candles: Candle[]; fromMemo: boolean }> {
  const key = `${symbol}:${count}`;
  const hit = candleMemo.get(key);
  if (hit && Date.now() - hit.at < SMA200_CANDLE_MEMO_MS) {
    return { candles: hit.candles, fromMemo: true };
  }
  const candles = await fetch(symbol, count);
  if (candles.length > 0) {
    candleMemo.set(key, { at: Date.now(), candles });
    scheduleCandleMemoPrune();
  }
  return { candles, fromMemo: false };
}

/** Test-only reset so a suite cannot inherit another test's memoized bars. */
export function __resetSma200CandleMemoForTest(): void {
  candleMemo.clear();
  if (memoPruneTimer) clearTimeout(memoPruneTimer);
  memoPruneTimer = null;
}

/** Test-only probe of how many entries are resident. */
export function __sma200CandleMemoSizeForTest(): number {
  return candleMemo.size;
}
