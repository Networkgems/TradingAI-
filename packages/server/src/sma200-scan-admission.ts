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

/**
 * TRA-5065 — which leg produced a pull's bars. Carried through the memo so a
 * replayed pull still reports the provider that actually went to the wire;
 * a dedup that forgets its provenance turns "Tradier carried the sweep" into
 * "the sweep ran", which is the distinction this ticket exists to publish.
 */
export type Sma200CandleSource = 'primary' | 'fallback';

const candleMemo = new Map<string, { at: number; candles: Candle[]; source: Sma200CandleSource }>();
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

// TRA-5065 — THE SECOND LEG.
//
// `fetchDailyCandles` is `yf.chart(...)` and nothing else, and Yahoo 429s
// ~permanently on Render's shared egress (TRA-1230). Measured on bqb1
// 2026-10-02T14:2xZ: `starvedBreakerOpen` 400/400, `evaluated` 0 fleet-wide,
// while `tradierBreakerOpen` was FALSE and the chart fallback was already
// serving Tradier bars to every other daily-bar consumer on the box. So the
// sweep's zero was a single-provider dependency, not a market reading — and
// `evaluated: 0` makes every downstream sma200 number vacuous rather than
// reassuring.
//
// The remedy is the TRA-4424 shape, not a new one: ask the primary's breaker
// BEFORE the call (an un-asked breaker launders an outage into "answered
// empty"), then hand the symbol to the already-proven Tradier daily history.
// Depth was MEASURED before this was wired, because a 120-bar fallback would
// trip `candles.length < SMA200_MIN_BARS` and land in `starvedShortHistory` —
// the same zero wearing a different label. Tradier `/markets/history` over the
// 280-bar window returns 314 usable sessions (AAPL/SPY/NVTS/QQQ/ZM, 5/5,
// 2026-10-02), comfortably over the 250 floor.
//
// ⛔ THE FALLBACK IS BUDGETED, AND THE BUDGET IS NOT OPTIONAL. `runSma200Scan`
// is AWAITED inside `doTick`, whose duration is still the live exit-evaluation
// interval on the real-money book, and a Tradier history call costs ~350ms
// (measured, 10 concurrent). At `SCAN_BATCH` 5 an unbudgeted 750-symbol
// universe is ~52s of added exit latency and ~750 requests against a modelled
// 200 req/min account budget — which would trip the SHARED Tradier bar breaker
// and take the OTM daily series and the MTF backfill down with it. That is
// TRA-1391's lesson (a fan-out run while a breaker is open) pointed at the
// other vendor.
//
// Because the budget can cut a sweep short, the order it cuts matters: a fixed
// order would starve the same tail forever and read as an ordinary partial
// sweep. {@link orderSma200FallbackFairness} therefore walks least-recently-
// fallback-served first, so coverage rotates across sweeps instead of pinning a
// permanent blind spot. It is keyed by SYMBOL, not by index, because every
// engine sweeps its own universe (TRA-4830 tiers them per book) and an
// index cursor over heterogeneous lists is not a rotation.

/** Last time each symbol's bars came off the fallback leg, ms epoch. */
const fallbackServedAt = new Map<string, number>();

/**
 * Order a sweep's symbols least-recently-fallback-served first. Stable for the
 * never-served majority (they all read 0), so a healthy Yahoo sweep — which
 * never touches this map — keeps its natural order.
 */
export function orderSma200FallbackFairness(symbols: string[]): string[] {
  return [...symbols].sort(
    (a, b) => (fallbackServedAt.get(a) ?? 0) - (fallbackServedAt.get(b) ?? 0),
  );
}

/** TRA-5065 — why the fallback leg was not asked, when the primary came up empty. */
export type Sma200FallbackSkip = 'not_configured' | 'unavailable' | 'budget_exhausted';

export interface Sma200CandlePull {
  candles: Candle[];
  /** Served out of the process-wide memo, i.e. cost no request. */
  fromMemo: boolean;
  /**
   * Which leg produced these bars, or `null` when nobody served. A memo hit
   * reports the leg that originally went to the wire, not `null`.
   */
  source: Sma200CandleSource | null;
  /**
   * The primary was NOT ASKED because its breaker was open. Per-symbol and
   * taken BEFORE the call — strictly better than the post-hoc
   * `isYahooBreakerOpen()` sample the census used to attribute starves with,
   * which could not tell a mid-sweep breaker flip from a short listing.
   */
  primarySuppressed: boolean;
  /** The fallback leg actually issued a request. */
  fallbackAttempted: boolean;
  /** Why the fallback leg was skipped, or `null` if it was not skipped. */
  fallbackSkipped: Sma200FallbackSkip | null;
}

export interface Sma200FallbackLeg {
  fetch: (symbol: string, count: number) => Promise<Candle[]>;
  /** Vendor-side health: client configured and its breaker closed. */
  available: () => boolean;
  /** Our-side budget: true once this sweep has spent its fallback allowance. */
  budgetExhausted?: () => boolean;
}

export interface Sma200PullOptions {
  /** Asked BEFORE the primary call, never after it. */
  breakerOpen?: () => boolean;
  fallback?: Sma200FallbackLeg;
}

/**
 * Daily bars for the SMA-200 sweep, shared across every engine in the process.
 * `fromMemo` is reported so the sweep census can say how many of its scored
 * symbols cost a request — a dedup nobody can observe is not a control.
 *
 * TRA-5065 — and `source` is reported for the same reason one layer out: the
 * census must be able to say "Yahoo served" / "Tradier served" / "nobody
 * served". Letting the fallback hide inside `evaluated` would buy back the
 * sweep and lose the one fact that explains it.
 */
export async function fetchSma200CandlesShared(
  symbol: string,
  count: number,
  fetch: (symbol: string, count: number) => Promise<Candle[]>,
  opts: Sma200PullOptions = {},
): Promise<Sma200CandlePull> {
  const key = `${symbol}:${count}`;
  const hit = candleMemo.get(key);
  if (hit && Date.now() - hit.at < SMA200_CANDLE_MEMO_MS) {
    return {
      candles: hit.candles,
      fromMemo: true,
      source: hit.source,
      primarySuppressed: false,
      fallbackAttempted: false,
      fallbackSkipped: null,
    };
  }
  const primarySuppressed = opts.breakerOpen?.() === true;
  let candles: Candle[] = [];
  let source: Sma200CandleSource | null = null;
  // A primary throw is only fatal when there is no second leg that can serve.
  // Held rather than swallowed so the caller's `fetchFailed` accounting is
  // unchanged in exactly the world it already described.
  let primaryError: unknown = null;
  if (!primarySuppressed) {
    try {
      candles = await fetch(symbol, count);
      if (candles.length > 0) source = 'primary';
    } catch (err: unknown) {
      candles = [];
      primaryError = err;
    }
  }

  let fallbackAttempted = false;
  let fallbackSkipped: Sma200FallbackSkip | null = null;
  if (candles.length === 0) {
    const leg = opts.fallback;
    if (!leg) fallbackSkipped = 'not_configured';
    else if (!leg.available()) fallbackSkipped = 'unavailable';
    else if (leg.budgetExhausted?.() === true) fallbackSkipped = 'budget_exhausted';
    else {
      fallbackAttempted = true;
      // Charged on the ATTEMPT, not on the answer: a symbol Tradier refuses is
      // still a symbol we spent a slot on, and a fairness order that only
      // advanced on success would re-pick the same refusals every sweep.
      fallbackServedAt.set(symbol, Date.now());
      const got = await leg.fetch(symbol, count);
      if (got.length > 0) {
        candles = got;
        source = 'fallback';
      }
    }
  }

  if (candles.length === 0 && primaryError !== null) throw primaryError;

  if (candles.length > 0 && source !== null) {
    candleMemo.set(key, { at: Date.now(), candles, source });
    scheduleCandleMemoPrune();
  }
  return { candles, fromMemo: false, source, primarySuppressed, fallbackAttempted, fallbackSkipped };
}

/** Test-only reset so a suite cannot inherit another test's memoized bars. */
export function __resetSma200CandleMemoForTest(): void {
  candleMemo.clear();
  fallbackServedAt.clear();
  if (memoPruneTimer) clearTimeout(memoPruneTimer);
  memoPruneTimer = null;
}

/** Test-only probe of how many entries are resident. */
export function __sma200CandleMemoSizeForTest(): number {
  return candleMemo.size;
}
