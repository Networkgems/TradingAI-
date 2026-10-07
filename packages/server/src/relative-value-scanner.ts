import {
  TradierOptionsClient,
  findRelativeValueOpportunities,
  explainRelativeValueNoCandidates,
  findMispricedOtmContracts,
  findTermStructureDislocations,
  type OptionChainRow,
  type RelativeValueCandidate,
  type OtmMispricingCandidate,
  type OtmScannerOptions,
  type RelativeValueScannerOptions,
  type TermStructureOptions,
  type TermStructureReport,
} from '@trading-app/engine';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'relative-value-scanner' });

/**
 * How long a fetched chain snapshot is served from cache.
 *
 * TRA-4357 — EXPORTED because it is the coherent bound for the underlying SPOT
 * this scanner pairs the chain with, and `index.ts` now wires `fetchSpot` to it
 * by name. Every strike/delta decision in this module reads a spot and a chain
 * TOGETHER; holding the spot to a tighter freshness bound than the chain it is
 * compared against buys no accuracy (the chain is already up to this old) and
 * costs an upstream quote call per symbol per sweep. See the note at the
 * `fetchSpot` wiring for the quota failure that made this explicit.
 *
 * TRA-5006 — this constant, NOT `MAX_CHAIN_CACHE_ENTRIES`, is what sets the
 * floor on chain upstream calls. A sweep of S symbols × E in-window expirations
 * repeated every cycle cannot cost less than `S × E` calls per TTL no matter how
 * large the cache is: at the TRA-4830 universe of 100 symbols × 2–3 expirations
 * that is 200–300 calls/min against a ~120/min vendor quota, from the chain path
 * alone. Doubling the TTL halves that floor — but it also doubles the staleness
 * of every strike/delta decision AND of the spot this is the coherent bound for,
 * which is a trading-semantics change and not a cache-sizing one. It is
 * deliberately NOT made here; see the follow-up named in the TRA-5006 thread.
 */
export const CHAIN_CACHE_TTL_MS = 60_000;
/**
 * TRA-5006 — left at 6h. Once the size cap stops binding (it was the whole
 * defect), this TTL costs at most `keyspace × 4` upstream calls per day — about
 * 1.2/min at a 450-symbol keyspace, against the 180.8/min the thrashing cache
 * was spending. Listed expiration sets change daily at most, so a longer TTL is
 * cheap in correctness, but it is also worth almost nothing once the cap is
 * fixed, and a 24h TTL would delay a newly-listed weekly by up to a day. The
 * lever that mattered here was the cap.
 */
const EXPIRATIONS_CACHE_TTL_MS = 6 * 60 * 60_000;

// TRA-943 (TRA-908 Phase A) — bound the retained working set of these caches.
// Both maps were previously write-only: a stale entry (past its TTL) was never
// deleted, only overwritten when the SAME (symbol|expiration) key was re-fetched.
// The per-tick option-shadow pass (`evaluateOptionShadow`) calls `getSelectorChain`
// across the full active-symbol roster, and the in-window expiration rotates as
// days pass, so the keyspace grows without bound over a long-lived process — every
// combo ever scanned pins a full `OptionChainRow[]` (hundreds of rows) on the heap.
// That unbounded growth is the leading retained-footprint driver behind the
// TRA-937 OOM. Capping both caches to a fixed number of live entries (with
// TTL-expiry + oldest-first eviction on every write) holds the working set flat
// regardless of how many symbol/expiration combos the pass touches. The caps are
// generous vs. the realistic active roster (~15–30 symbols × 1 in-window
// expiration) so steady-state cache hits are unaffected; they only bite the
// long-tail accumulation of dead entries.
// TRA-4664 — 64 was undersized for the live workload, and the counters proved
// it: 4.9h of RTH on 2026-09-23 read chainCache 136,465 hits / 111,493
// capacityEvictions (evictions ≈ 82% of hits) and expirationsCache at an 81%
// miss rate. The chain cache is keyed `symbol|expiration`, so the
// TRADIER_SCAN_SYMBOL_LIMIT=100 universe (TRA-4830) × 2–3 in-window
// expirations needs ~200–300 entries; the expirations cache is per-symbol so
// 256 holds the whole capped universe for its 6h TTL. Chain entries die at
// their 60s TTL regardless, so the heap cost of the larger cap is bounded by
// churn, not by the cap.
// TRA-5006 — 256 was still undersized for the EXPIRATIONS cache, and this time
// the cache was pinned exactly full rather than merely busy. Live `faae9388`,
// 89.1h uptime, read 2026-10-01: `expirationsCacheSize 256 / max 256` with
// **282,047 capacityEvictions (52.7/min)** — every one an entry thrown away by
// the cap while still inside its SIX HOUR TTL, i.e. a refetch we paid for and
// then bought again. Against a `refusalCooldown.sinceBoot` census of 449
// DISTINCT refused `expirations|SYM` keys (`evicted: 0`, so a true census of
// the refused population and therefore a hard LOWER bound on the live one),
// a 256-slot cache cannot hold the keyspace at all: it is a permanent thrash,
// not a warm cache under pressure.
//
// The cap is raised to 2048 rather than to the measured lower bound, for two
// reasons. (1) 449 is a count of REFUSED symbols; the true keyspace is ≥449 and
// sizing to a lower bound re-arms the same bug one universe-expansion later.
// (2) An expirations entry is a `string[]` of ~20–40 `YYYY-MM-DD` strings keyed
// by one symbol — single-digit KB — so 2048 of them is a few MB, which buys
// 4.5x headroom over the lower bound for a cost the chain cache could not
// absorb. The honest sizing input is now MEASURED rather than argued: see
// {@link CacheDemand} and `expirationsCacheDemand.liveDemandPeak` /
// `capBinds` on the diagnostics route.
//
// ⛔ `chainCache` is deliberately LEFT at 256 in this pass. It read 213/256 —
// not full — and its entries are whole `OptionChainRow[]` snapshots (hundreds
// of rows each), so raising its cap is a heap decision (TRA-937, TRA-4158) that
// must follow its own `liveDemandPeak`, which this build is the first to
// measure. Its 73,524 capacity evictions (13.7/min) are a quarter of the
// expirations rate and its 60s TTL — not its cap — is what sets its floor on
// upstream calls; see the TTL note on `CHAIN_CACHE_TTL_MS`.
const MAX_CHAIN_CACHE_ENTRIES = 256;
const MAX_EXPIRATIONS_CACHE_ENTRIES = 2048;
/**
 * TRA-5006 — how many keys the per-cache DEMAND shadow (see {@link CacheDemand})
 * will track before it starts evicting and declaring itself truncated. It holds
 * `key -> lastReadAtMs` only — no payload — so an entry is a short string and a
 * number, and this cap exists to bound a pathological keyspace rather than to
 * bound normal operation. It is set well above both cache caps on purpose: a
 * demand census clamped to the cache's own size could never report the one fact
 * it exists to report, which is that demand EXCEEDS the cap.
 */
const MAX_CACHE_DEMAND_ENTRIES = 8192;
// TRA-417 — replaced the flat 1h cooldown with discriminated cooldowns.
// Tradier's rate limit is a ~60s sliding window (60/min sandbox, 120/min
// prod); a 1h breaker over-suppressed scanning by ~60x on any transient
// error. `tripBreaker` now picks the cooldown based on the error class:
//   • 429: RATE_LIMIT_429_COOLDOWN_MS (~90s = window + buffer). Repeated
//     429s inside BACKOFF_429_WINDOW_MS exponentially back off up to
//     BACKOFF_429_MAX_MS so a sustained bucket-exhaustion is not hammered
//     with retries. A single successful upstream call resets the counter.
//   • Non-429 (network blip, 5xx, parse error): UPSTREAM_ERROR_COOLDOWN_MS
//     (~5 min), short enough to recover quickly without 1h dead-time.
// NOTE: today the Tradier options-client (`packages/engine/src/tradier/
// options-client.ts`) swallows non-ok responses (including 429) in its
// private `getJson` and returns `null`/`[]` instead of throwing — so in
// practice only the non-429 branch fires (on fetch failures / JSON parse
// errors). The 429 branch is forward-compatible scaffolding; wiring 429
// into the throw path belongs in a follow-up. The immediate win is the
// 1h→5min shrink for transient blips.
// TRA-4664 — that follow-up. The scanner now reads expirations/chains through
// the status-preserving `fetch*` variants (TRA-4059) and raises a refusal as
// `TradierHttpRefusalError`, so 429 reaches the backoff branch and 5xx the
// upstream-error branch. A non-429 4xx is request-specific and does NOT trip.
const RATE_LIMIT_429_COOLDOWN_MS = 90_000;
const UPSTREAM_ERROR_COOLDOWN_MS = 5 * 60_000;
const BACKOFF_429_WINDOW_MS = 5 * 60_000;
const BACKOFF_429_MAX_MS = 10 * 60_000;
// TRA-4664 (second pass) — a non-429 4xx neither trips the breaker (correct:
// it refuses THIS request, not the vendor) nor gets cached (correct: a refusal
// must never read as an empty listing). But "never cached" made a persistently
// refused key a per-cycle upstream call: on 2026-09-23 bqb1 fired 1,079,861
// HTTP-400 expiration/chain requests in 4.9h (~61 rps) re-asking Tradier the
// same refused questions. So a non-429 4xx now arms a PER-KEY cooldown: for
// its duration the same key re-throws the refusal locally (still surfacing as
// `fetch_error`, never as `no_expirations`/`no_chain`) without an upstream
// call, and every suppressed retry is counted in diagnostics — a suppression
// that doesn't ship a counter is invisible. 429 and 5xx are excluded: those
// are vendor-wide states owned by the breaker/backoff, not per-key ones.
//
// ⛔ TRA-5005 — the premise in that paragraph ("a non-429 4xx refuses this KEY")
// is MEASURED FALSE for the only 400 this vendor actually sends. 100% of
// classified 400s on live `faae9388` were `Quota Violation` (5,923 of 5,923) —
// an ACCOUNT-level per-minute rate limit, so the cooldown named the wrong
// subject (whichever key was in flight), the wrong duration (10 min vs the <60s
// the vendor's own `Expires` states) and the wrong class (vendor-wide, not
// per-key). Those refusals now take the account-scoped gate instead — see
// `isQuotaViolationReason` and `RelativeValueScannerDiagnostics.quotaHold`. This
// constant still governs the 4xx reasons that genuinely ARE per-key (a bad
// parameter, a delisted symbol), which is the population it was right about.
export const REFUSAL_4XX_COOLDOWN_MS = 10 * 60_000;
const MAX_REFUSAL_COOLDOWN_ENTRIES = 1024;
// TRA-4664 (third pass) — how many cooling keys `diagnostics()` will NAME. The
// live census on 2026-09-24 was 110 keys, so this reports it whole; the cap
// only stops a pathological day from turning a health route into a page of
// payload, and `keysTruncated` says so out loud when it bites.
const MAX_REFUSAL_COOLDOWN_KEYS_REPORTED = 300;
// TRA-4865 — the third pass's census is a TEN-MINUTE WINDOW, not a session
// census, and it reads identically in a trough and in a burst. Measured on live
// `d26f58b9` 2026-09-24, one boot, counters monotone throughout:
// `size` 110 @17:0xZ → 8 @17:30Z → 8 → 3 → 24 @17:35Z. `REFUSAL_4XX_COOLDOWN_MS`
// is 10 min and `putBounded` sweeps every expired entry on EVERY insert, so
// `size`/`cooling`/`keys[]` name only what was refused in the preceding ≤10 min.
// A one-shot read landing in a trough reports 3 keys on a box where 20.8% of the
// live desk OTM book's symbol-evaluations died on a refusal re-throw that day
// (`/api/health/rv-scan` → `censusByEtDay`, otm/desk/live, 2,888 of 13,900).
// So the window census now ships a SINCE-BOOT twin: every key Tradier has
// actually refused this process, with how many times it was re-armed — one read,
// no sampling, and `refusals/distinctKeys` separates a transient refusal from a
// name that is permanently dark. Cap is a disclosure, never a silent clamp:
// `evicted > 0` ⇔ `distinctKeys` is a LOWER BOUND.
const MAX_REFUSED_KEY_CENSUS_ENTRIES = 4096;
// TRA-4865 (third pass) — how many characters of the vendor's refusal body are
// kept in `byReason`. Tradier's 400 fault bodies are one short sentence; this is
// long enough to carry the distinguishing clause and short enough that a
// pathological body cannot turn the health route into a payload dump.
const MAX_REFUSAL_REASON_LEN = 160;
// TRA-4865 (third pass) — how many DISTINCT reasons `byReason` will carry. The
// reason string is vendor-controlled, so an unbounded map is an unbounded
// allocation driven by the upstream. On overflow, further novel reasons fold
// into `"(other)"` — which is a disclosure, not a silent clamp.
const MAX_REFUSAL_REASONS_TRACKED = 64;

/**
 * TRA-4865 (fourth pass) — collapse per-occurrence numbers in a vendor reason to
 * a placeholder BEFORE it becomes a bucket key.
 *
 * Measured on live `faae9388`: Tradier expresses a rate limit as
 * `400 Quota Violation: Expires <epoch-ms>`, and that epoch is the quota's next
 * MINUTE boundary — so every refused minute minted a brand-new bucket. The
 * 64-bucket budget was spent inside the first 25h of an 89h boot (61 of 65
 * buckets were the same reason at 61 different minutes), after which 6,953
 * refusals — 54% of the population, and 100% of the most recent two days —
 * folded into `(other)`.
 *
 * A cap bounds a vendor that invents new reasons; it cannot defend against one
 * that stamps every occurrence, which is what this does. Runs of >=5 digits
 * only, so HTTP statuses and small counts stay literal while epochs, request
 * ids and account numbers collapse.
 */
export function canonicalizeRefusalReason(reason: string): string {
  return reason.replace(/\d{5,}/g, '<n>');
}

/**
 * TRA-5005 — is this vendor refusal body an ACCOUNT-level quota violation?
 *
 * Measured on live `faae9388` (89.1h boot, read 2026-10-01 mid-RTH): **100% of
 * classified 400s are `Quota Violation` — 5,923 of 5,923, zero non-quota**, and
 * `quota + (other) === byStatus['400']` exactly, so no other 400 reason string
 * was ever bucketed. That refutes the premise the per-key cooldown was built on
 * (see {@link REFUSAL_4XX_COOLDOWN_MS}): a quota violation is not a property of
 * the (endpoint, symbol, date) KEY that happened to be in flight, it is a
 * property of the ACCOUNT at that minute. Routing it to a per-key cooldown
 * blacked out an innocent key for 10 minutes over a global condition that
 * resets in under 60s — which is why SPY and AAPL both sat in the refused
 * census next to names that priced fine minutes earlier.
 *
 * This is the discriminator that keeps the per-key cooldown for the 4xx reasons
 * that genuinely ARE per-key (a bad parameter, a delisted symbol). It is
 * deliberately a match on the vendor's own words and not on the status: Tradier
 * signals a rate limit with a **400**, which is exactly why `is429Error` —
 * `/\b429\b|Too Many Requests/i` — never saw it.
 */
export function isQuotaViolationReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && /quota\s+violation/i.test(reason);
}

/**
 * TRA-5005 — the quota's own reset instant, parsed out of `Expires <epoch-ms>`.
 *
 * Every `Expires` gap in the live census is a multiple of 60s, so the vendor's
 * bucket is per MINUTE and this epoch is when it refills. We already had the
 * datum that says the hold should last seconds; the old code held the key dark
 * for `REFUSAL_4XX_COOLDOWN_MS` (10 min) anyway — roughly 10x longer than the
 * vendor requires.
 *
 * Returns epoch MILLIS, or `null` when there is no readable datum. `null` is a
 * distinct answer from a number and the caller must treat it as UNKNOWN and
 * count it (see `quotaHold.expiresUnreadable`) — never as 0, which would read
 * as "the hold already expired" and silently restore the hammering this fixes.
 */
export function parseQuotaExpiresMs(reason: string | null | undefined): number | null {
  if (typeof reason !== 'string') return null;
  const m = /\bexpires\b\D{0,4}(\d{9,})/i.exec(reason);
  if (!m) return null;
  const raw = Number(m[1]);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  // Measured shape is epoch-MILLIS. Epoch-SECONDS is accepted too rather than
  // read as a 1970 instant: a 10-digit value taken for millis lands in 1970,
  // `Expires <= now` releases the hold immediately, and the failure is the
  // silent no-hold direction. Anything outside both plausible bands is `null`
  // (unknown) rather than a guess.
  if (raw >= 1e12) return raw;
  if (raw >= 1e9 && raw < 1e11) return raw * 1000;
  return null;
}

/**
 * TRA-5005 — the ceiling on a single quota hold, and the floor under it.
 *
 * The vendor's bucket is per minute, so a well-formed `Expires` is always <60s
 * out. The ceiling is a clamp on the VENDOR's datum, not a policy: a fat-
 * fingered or malicious epoch three days out must not black the scanner out for
 * three days, and `quotaHold.expiresClamped` says out loud when it bit. The
 * floor stops a boundary that is 1ms away from amounting to no hold at all and
 * re-opening the hammer loop this fix exists to close.
 */
export const MAX_QUOTA_HOLD_MS = 90_000;
export const MIN_QUOTA_HOLD_MS = 1_000;

/**
 * TRA-5005 — the fallback hold when `Expires` is unreadable: the next minute
 * boundary, because that is what the vendor's bucket is keyed to. Short on
 * purpose — the cost of over-holding is exactly the defect being fixed.
 */
function nextMinuteBoundaryMs(nowMs: number): number {
  return Math.floor(nowMs / 60_000) * 60_000 + 60_000;
}

function is429Error(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|Too Many Requests/i.test(msg);
}

interface BreakerState {
  openedAt: number;
  cooldownMs: number;
}

// TRA-373 — widened from 14–35 to 21–60 with a 35-day target. The previous
// 14–35 window collapsed RV signals to month-end past mid-month (the listed
// monthly was always the earliest-in-window pick), and the 14–21 DTE fit is
// gamma-/jump-dominated which produced false-positive "cheap" outliers.
// `pickExpiration` now selects the listed expiration whose DTE is closest to
// the target inside the window. Per-call overrides (from AccountSettings)
// flow through `scan()` / `getOptionMark()` so users can retune without a
// redeploy; the constants below remain the spec defaults.
const MIN_DTE_DAYS = 21;
const MAX_DTE_DAYS = 60;
const TARGET_DTE_DAYS = 35;

export interface DtePrefs {
  min?: number;
  max?: number;
  target?: number;
}

type ChainKey = `${string}|${string}`;

interface CacheEntry<T> {
  value: T;
  at: number;
}

/**
 * TRA-5006 — the bookkeeping behind one {@link CacheDemand}. `seen` is the
 * since-boot distinct-key set; it stops ADDING at
 * {@link MAX_CACHE_DEMAND_ENTRIES} and raises `truncated` rather than evicting,
 * so `seen.size` is always a true lower bound and never a rolling window
 * dressed up as a census. `truncated` is shared with the live-demand map's own
 * cap: either clamp makes the whole row a lower bound, so one flag is correct.
 */
interface DemandState {
  peak: number;
  seen: Set<string>;
  truncated: boolean;
}

export interface RelativeValueScanResult {
  symbol: string;
  spot: number | null;
  expiration: string | null;
  candidates: RelativeValueCandidate[];
  reason?:
    | 'ok'
    | 'no_credentials'
    | 'no_spot'
    | 'no_expirations'
    | 'no_chain'
    | 'breaker_open'
    /**
     * TRA-5005 — the ACCOUNT-level Tradier quota gate was held, so no upstream
     * call was made for this symbol. Split out of `fetch_error` because the two
     * are on opposite sides of the wire: `fetch_error` is "they refused or
     * failed", `quota_held` is "we suppressed the call". Pooling them made
     * 20.8% of a day's evaluations unattributable. See {@link TradierQuotaHoldError}.
     */
    | 'quota_held'
    | 'fetch_error';
  errorMessage?: string;
  /**
   * TRA-5154 — set iff `reason === 'ok'` and `candidates` is empty: the single
   * first-binding label for WHY (`min_group_size`, `row_gate:<gate>`, …). Absent
   * on a non-empty scan, so the caller can count one per `no_candidates` pass.
   */
  noCandidatesReason?: string;
}

/**
 * TRA-4413 item 4 — how many chains (one per expiration) a single
 * term-structure scan may fetch. The engine's term fit needs ≥3 distinct
 * expirations per delta bucket to z-score anything, so 4 buys one point of
 * redundancy; a fifth chain costs another Tradier call per symbol per capture
 * for marginal fit leverage. When the DTE window holds more than 4, the pick
 * is spread evenly across the ascending list (first/last always included) so
 * the √T axis keeps its span instead of clustering short-dated.
 */
export const MAX_TERM_EXPIRATIONS = 4;

/**
 * TRA-4413 item 4 — cross-expiration term-structure scan result. Mirrors
 * {@link RelativeValueScanResult}'s discriminated-reason contract; `report` is
 * the engine's {@link TermStructureReport} (present iff `reason === 'ok'`).
 * `no_expirations` here means "fewer than 2 listed expirations inside the DTE
 * window" — a single-expiration chain has no term axis at all, so the scan
 * refuses loudly rather than letting the engine report empty buckets.
 */
export interface TermStructureScanResult {
  symbol: string;
  spot: number | null;
  /** Expirations whose chains fed the report (ascending). Empty on failure. */
  expirations: string[];
  report: TermStructureReport | null;
  reason:
    | 'ok'
    | 'no_credentials'
    | 'breaker_open'
    | 'no_spot'
    | 'no_expirations'
    | 'no_chain'
    /** TRA-5005 — see {@link RelativeValueScanResult.reason}. */
    | 'quota_held'
    | 'fetch_error';
  errorMessage?: string;
}

/**
 * TRA-1207 — OTM-mispricing scan result. Mirrors {@link RelativeValueScanResult}
 * but surfaces {@link OtmMispricingCandidate}s. `scanOtm` reuses the SAME warm
 * chain cache / circuit breaker / DTE picker as `scan`, so when the OTM engine
 * runs it costs zero extra Tradier calls versus the RV path it replaces.
 */
export interface OtmMispricingScanResult {
  symbol: string;
  spot: number | null;
  expiration: string | null;
  candidates: OtmMispricingCandidate[];
  /** Every expiration actually priced (primary first). Absent on failure paths. */
  scannedExpirations?: string[];
  /**
   * TRA-161 — widened from `'ok' | 'unavailable'`. `scanOtm` used to flatten
   * every distinct failure of the snapshot path into a single `'unavailable'`,
   * because `getSelectorChain` returns a bare `null` for all of them. That is
   * fine for the in-process signal-engine caller (which only asks "did I get
   * rows?"), but it makes an empty scan UNDIAGNOSABLE for a human: a missing
   * Tradier credential, an open breaker, and a symbol with no listed chain all
   * render identically. The reason now survives the resolver so the desktop
   * panel can say WHICH one happened. `'unavailable'` is retained in the union
   * for callers that still switch on it, but the resolver no longer emits it.
   */
  reason?: OtmScanReason;
  /** Upstream error text when `reason === 'fetch_error'`. */
  errorMessage?: string;
}

/**
 * TRA-161 — why a snapshot-backed scan produced no rows. Mirrors the reason set
 * {@link RelativeValueScanResult} already discriminates, minus RV-only states.
 */
export type OtmScanReason =
  | 'ok'
  | 'no_credentials'
  | 'breaker_open'
  | 'no_spot'
  | 'no_expirations'
  | 'no_chain'
  /** TRA-5005 — see {@link RelativeValueScanResult.reason}. */
  | 'quota_held'
  | 'fetch_error'
  /** Legacy catch-all; no longer emitted, kept so existing switches still type. */
  | 'unavailable';

/**
 * TRA-161 — the snapshot resolution outcome. Exactly one of `snapshot` (with
 * `reason: 'ok'`) or a non-ok `reason` is meaningful.
 */
export interface SelectorChainResolution {
  snapshot: SelectorChainSnapshot | null;
  reason: OtmScanReason;
  errorMessage?: string;
}

export interface RelativeValueScannerDiagnostics {
  configured: boolean;
  /** Where chains come from. A config fact, named as one — not feed liveness. */
  marketData?: { env: 'sandbox' | 'production'; source: string; delayedQuotes: boolean; vendorGreeks: boolean };
  /** Self-imposed upstream chain budget (see `chainCallBudgetPerMin`). */
  chainBudget?: {
    limitPerMin: number | null;
    usedLastMin: number;
    upstreamCalls: number;
    deferred: number;
    lastDeferredAtMs: number | null;
  };
  /** Expirations priced per OTM scan. */
  otmMaxExpirations?: number;
  breakerOpen: boolean;
  breakerOpenedAtMs: number | null;
  cacheSize: number;
  expirationsCacheSize: number;
  /** TRA-943 — hard caps the retained working set is bounded to (live entries). */
  chainCacheMaxEntries: number;
  expirationsCacheMaxEntries: number;
  /**
   * TRA-4664 — the counters that decide whether `chainCacheMaxEntries` is
   * undersized. `cacheSize == max` alone cannot: a full cache of entries that
   * are re-read inside their TTL is healthy, and a full cache that evicts every
   * entry before its second read is a pass-through that multiplies upstream
   * spend. `capacityEvictions` counts only entries evicted while still LIVE
   * (TTL expiry is not counted) — that number, against `hits`, is the verdict.
   * Optional on the interface only so test doubles need not carry it; the
   * Tradier service always emits it. Process-lifetime counts, reset on boot.
   */
  chainCache?: CacheCounters;
  expirationsCache?: CacheCounters;
  /**
   * TRA-5006 — the sizing input. See {@link CacheDemand}. Absent on a build that
   * predates this field; absent is NOT "demand is zero".
   */
  chainCacheDemand?: CacheDemand;
  expirationsCacheDemand?: CacheDemand;
  /**
   * TRA-4664 — Tradier HTTP refusals (429/5xx/401) seen by this scanner, keyed
   * by HTTP status. Before TRA-4664 the client collapsed these into `[]`, which
   * the scanner reported as `no_expirations`/`no_chain` and CACHED (6h for
   * expirations). Absent key ≠ zero: an older build omits the whole object.
   */
  upstreamRefusals?: {
    byStatus: Record<string, number>;
    lastAtMs: number | null;
    lastStatus: number | null;
    /**
     * TRA-4865 (fourth pass) — the newest refusal's vendor reason, verbatim.
     * `byReason` is a bounded histogram and CAN saturate; this cannot, so the
     * current cause stays readable and datable (against `lastAtMs`) even when
     * every recent refusal has folded into `(other)`.
     */
    lastReason?: string | null;
  };
  /**
   * TRA-4664 (second pass) — the non-429-4xx per-key refusal cooldown.
   * `size` = keys currently under cooldown; `suppressed` = upstream calls NOT
   * made because the key was cooling (process-lifetime). `upstreamRefusals`
   * counts only real upstream responses, so the true refusal pressure is
   * `byStatus[4xx] + suppressed`.
   *
   * TRA-4664 (third pass) — WHICH keys, not just how many. The cooldown works
   * by making a permanently-refused key CHEAP, and a cheap permanent failure
   * reads exactly like a healthy fast path: on 2026-09-24 the live route
   * answered `fetch_error` in ~100ms for NVDA/AMZN/META/NFLX/AMD/IWM/COIN with
   * ZERO upstream calls, and nothing on any health surface named them. The only
   * way to find out was to probe symbol-by-symbol with an operator token. So
   * the census ships beside the counter (the TRA-3800 rule: a suppression must
   * ship a counter — and a counter that cannot be attributed is not one).
   * `cooling` is the LIVE count: `size` is the raw map size and includes
   * entries whose cooldown has expired but which nothing has swept yet, so
   * `size >= cooling`. Keys are `expirations|SYM` / `chain|SYM,YYYY-MM-DD` —
   * symbols and dates only, no credentials.
   *
   * TRA-4865 — `size`/`cooling`/`keys` are a TEN-MINUTE WINDOW (see
   * `MAX_REFUSED_KEY_CENSUS_ENTRIES`): they answer "what is being silenced right
   * now", which swung 110 → 3 → 24 inside half an hour on live `d26f58b9`.
   * `sinceBoot` is the session census — every key upstream has actually refused
   * this process, so ONE read is a census and no sampling schedule is needed.
   * `sinceBoot.refusals` counts upstream refusals only (suppressed re-throws are
   * in `suppressed`), so `refusals / distinctKeys` is the mean re-arm count: 1
   * is a transient refusal, a large number is a permanently dark key. Same
   * population as the cooldown (non-429 4xx), so `distinctKeys >= cooling`
   * always. `evicted > 0` ⇔ the census cap bit and `distinctKeys` is a LOWER
   * BOUND — the one reading that must never be mistaken for a complete census.
   *
   * ⛔ TRA-5005 — the POPULATION of this whole block changed. A `Quota Violation`
   * 400 no longer arms the per-key cooldown and no longer enters `sinceBoot`;
   * it arms the account-scoped {@link RelativeValueScannerDiagnostics.quotaHold}
   * gate instead. Since 100% of this vendor's classified 400s were quota
   * violations, a healthy box can now read `cooling: 0` and
   * `sinceBoot.distinctKeys: 0` where it previously read 110 keys. That is the
   * fix landing, NOT the instrument going dark — cross-read `quotaHold` before
   * concluding anything from a zero here.
   */
  refusalCooldown?: {
    size: number;
    suppressed: number;
    cooling?: number;
    byEndpoint?: { expirations: number; chain: number };
    keys?: string[];
    keysTruncated?: boolean;
    sinceBoot?: {
      distinctKeys: number;
      byEndpoint: { expirations: number; chain: number };
      refusals: number;
      refusalsByKey: Record<string, number>;
      keysTruncated: boolean;
      /**
       * TRA-4865 (third pass) — how many keys of each endpoint `refusalsByKey`
       * actually CARRIES, beside `byEndpoint`'s full-population count. The two
       * disagreeing is the whole point: they are the discriminator for the
       * truncation bug below, and a reader that assumes `refusalsByKey` is
       * representative of `byEndpoint` is the reader this field exists to stop.
       */
      reportedByEndpoint: { expirations: number; chain: number };
      evicted: number;
    };
    /**
     * TRA-4865 — WHY upstream refused, not just how often. `refuse()` only ever
     * saw an HTTP status: the vendor's fault body was dropped at the transport
     * boundary (`getJsonChecked`), so "3340 × HTTP 400" could not be separated
     * into throttle vs entitlement vs bad-parameter without an operator token
     * and a symbol-by-symbol probe. Keyed `"<status> <vendor reason>"`, bounded
     * and truncated per {@link MAX_REFUSAL_REASON_LEN}. `"<status> (no body)"`
     * when the vendor sent nothing, `"<status> (unreadable)"` when the body
     * could not be read — never silently folded into a success-shaped bucket.
     *
     * ANSWERED on live `faae9388` (2026-10-01): **100% of classified 400s are
     * `Quota Violation` — 5,923 of 5,923, zero non-quota 400s.** The refusal is
     * a RATE LIMIT expressed as a 400, not an entitlement gap and not a bad
     * parameter, so BOTH forks this field was built to decide are refuted. The
     * bucket key is canonicalised per {@link canonicalizeRefusalReason} because
     * the reason embeds the quota's reset epoch and was minting one bucket per
     * minute. Read `upstreamRefusals.lastReason` for the newest cause verbatim:
     * `(other)` being the largest bucket is a statement about the BUDGET, never
     * about the distribution.
     */
    byReason?: Record<string, number>;
  };
  /**
   * TRA-5005 — the ACCOUNT-scoped quota gate that replaced the per-key cooldown
   * for `Quota Violation` refusals. ONE global hold, released at the vendor's
   * own `Expires`, instead of N per-key 10-minute blackouts of whichever key
   * happened to be in flight when the account's minute ran out.
   *
   * A suppression must ship a counter (TRA-3800), and the suppression this
   * replaces shipped one (`refusalCooldown.suppressed` = 907,095 local re-throws,
   * 55.6% of all option cache misses). So every arm of the gate is counted here,
   * and the counts close a SUM IDENTITY against the old surface:
   *
   *   `upstreamRefusals + <non-quota 4xx refusals> === upstreamRefusals.byStatus['4xx']`
   *   `expiresHonoured + expiresUnreadable + expiresStale + expiresClamped === upstreamRefusals`
   *
   * ⚠ A quota refusal no longer enters `refusalCooldown` OR its `sinceBoot`
   * census — that is the fix, not a regression in those fields, but it does mean
   * a box whose only 400s are quota violations now reads `cooling: 0` /
   * `sinceBoot.distinctKeys: 0` where it used to read 110 keys. Read THIS block
   * for the quota population; read those for genuinely per-key 4xx.
   *
   * `heldNow`/`blockedUntilMs` are instantaneous and `null` when the gate is
   * open — an open gate is NOT the same statement as "no quota refusal has ever
   * happened", which is what `upstreamRefusals` answers.
   */
  quotaHold?: {
    /** Epoch-ms the gate is held until, or `null` when open RIGHT NOW. */
    blockedUntilMs: number | null;
    /** Remaining hold in ms, or `null` when open. Derived; saves a clock round-trip. */
    heldMsRemaining: number | null;
    /** Quota-violation refusals received from upstream this boot. */
    upstreamRefusals: number;
    /** Times the gate went from open → held. */
    holdsArmed: number;
    /** Times an already-held gate was pushed further out by a newer `Expires`. */
    holdsExtended: number;
    /** Times a held gate was observed expired and released. */
    holdsReleased: number;
    /** Upstream calls the gate skipped — the replacement for `refusalCooldown.suppressed`. */
    suppressed: number;
    /** `suppressed`, split by endpoint. Sums to `suppressed`. */
    suppressedByEndpoint: { expirations: number; chain: number };
    /** Refusals whose `Expires` parsed and was used verbatim. */
    expiresHonoured: number;
    /**
     * Refusals with NO readable `Expires`. The hold fell back to the next minute
     * boundary. `undefined`/absent is not 0 — a build without this field cannot
     * tell you, and a 0 here is a measured zero (TRA-3802).
     */
    expiresUnreadable: number;
    /** `Expires` parsed but already in the past (clock skew / a stale body). */
    expiresStale: number;
    /** `Expires` parsed but beyond {@link MAX_QUOTA_HOLD_MS}; the clamp bit. */
    expiresClamped: number;
    /** The clamp itself, disclosed so a reader can tell a clamp from a vendor datum. */
    maxHoldMs: number;
    /** Longest single hold armed this boot, in ms. */
    longestHoldMs: number;
    /** Newest `Expires` the vendor sent, verbatim. `null` = never readable. */
    lastExpiresAtMs: number | null;
    /** When the gate was last armed. `null` = never. */
    lastArmedAtMs: number | null;
  };
}

export interface CacheCounters {
  hits: number;
  misses: number;
  /** Entries evicted by the size cap while still inside their TTL. */
  capacityEvictions: number;
}

/**
 * TRA-5006 — how big this cache WOULD be with no cap, measured rather than
 * argued.
 *
 * `capacityEvictions` (TRA-4664) answers "is the cap biting", which is the right
 * alarm and the wrong sizing input: it tells you the number is too small and
 * says nothing about what number would be big enough. `expirationsCacheSize ==
 * max` is worse — a cache that is full because its working set fits exactly and
 * a cache that is full because it is thrashing read IDENTICALLY, which is how
 * 256/256 sat on the health route for a week reading like a warm cache.
 *
 * So this is a payload-free shadow of the cache with a much larger cap:
 * `key -> lastReadAtMs` for every key READ (hit, miss, or refused before the
 * wire — a key that was demanded is part of the keyspace whether or not the
 * vendor answered), swept at the cache's own TTL. `liveDemand` is therefore
 * exactly the size the real cache would have had at this instant with no cap,
 * and `liveDemandPeak` is the smallest cap that would have produced ZERO
 * capacity evictions this boot. That is the number to size to.
 *
 * ⚠ `truncated` is the discriminator that keeps this honest. The shadow has its
 * own cap ({@link MAX_CACHE_DEMAND_ENTRIES}); when it bites, `liveDemand`,
 * `liveDemandPeak` and `distinctKeys` all become LOWER BOUNDS and `capBinds`
 * may read `false` for a cache that in truth binds. A clamped census that does
 * not say so is the bug this whole field exists to retire — never read a
 * `truncated: true` row as a measurement.
 */
export interface CacheDemand {
  /** Distinct keys read within the last TTL — the uncapped size, right now. */
  liveDemand: number;
  /**
   * High-water mark of `liveDemand` this boot. The smallest `maxEntries` that
   * would have held the working set without one live eviction.
   */
  liveDemandPeak: number;
  /** Distinct keys read at any point this boot (`>= liveDemandPeak`). */
  distinctKeys: number;
  /** The cap this demand is measured against, echoed so one read is self-contained. */
  maxEntries: number;
  /**
   * `liveDemandPeak > maxEntries`. The acceptance signal: `false` with
   * `truncated: false` is the only reading that proves the cap is adequate.
   */
  capBinds: boolean;
  /** The shadow's own cap bit. When `true`, every number above is a lower bound. */
  truncated: boolean;
}

/**
 * TRA-4664 — a Tradier HTTP refusal, raised by the scanner so the refusal takes
 * the THROW path (breaker, `fetch_error`, never cached) instead of being read as
 * an empty listing. The message carries the status, so `is429Error` matches a
 * rate-limit refusal and the TRA-417 429 backoff finally engages.
 */
export class TradierHttpRefusalError extends Error {
  constructor(
    readonly endpoint: 'expirations' | 'chain',
    readonly httpStatus: number,
    detail: string,
    /**
     * TRA-5005 — the vendor said this was an ACCOUNT-level quota violation (see
     * {@link isQuotaViolationReason}). Carried on the error because the CAUSE
     * has to survive the throw: every caller's catch flattened a refusal to
     * `fetch_error`, which is why 20.8% of a day's symbol-evaluations were
     * indistinguishable at the census level from a real upstream failure.
     */
    readonly quotaViolation = false,
  ) {
    super(`Tradier ${endpoint} HTTP ${httpStatus} (${detail})`);
    this.name = 'TradierHttpRefusalError';
  }
}

/**
 * TRA-5005 — raised INSTEAD of an upstream call while the account-level quota
 * gate is held. Subclasses {@link TradierHttpRefusalError} with a 400 on
 * purpose: `tripBreaker` already declines to open the breaker on a non-429 4xx
 * refusal, so a quota hold inherits that exemption rather than re-stating it.
 *
 * It must stay distinguishable from the refusal the vendor actually sent — this
 * one is OUR suppression, not their answer, and the two belong on different
 * sides of the wire. `heldUntilMs` makes the hold's end instant readable from
 * the error itself.
 */
export class TradierQuotaHoldError extends TradierHttpRefusalError {
  constructor(endpoint: 'expirations' | 'chain', detail: string, readonly heldUntilMs: number) {
    super(endpoint, 400, `${detail}; account quota hold until ${new Date(heldUntilMs).toISOString()}`, true);
    this.name = 'TradierQuotaHoldError';
  }
}

/**
 * TRA-5005 — classify a thrown fetch failure for the scan-result `reason`.
 *
 * AC3: `censusByEtDay` must be able to separate quota-held evaluations from
 * other `fetch_error` causes. The census keys off `scan:${result.reason}`
 * (`signal-engine.ts`), so the split has to happen here, in the reason, or it
 * cannot happen at all downstream.
 */
function throwReason(err: unknown): 'quota_held' | 'fetch_error' {
  return err instanceof TradierHttpRefusalError && err.quotaViolation ? 'quota_held' : 'fetch_error';
}

/**
 * TRA-917 (TRA-908 Phase A) — a FULL chain snapshot for one symbol's nearest
 * in-window expiration, used by the shadow option selector. Distinct from
 * {@link RelativeValueScanResult}, which only surfaces the RV anomaly-flagged
 * candidates: the strategy selector needs every liquid strike to ladder a
 * defined-risk spread by delta, not just the mispriced outliers.
 */
export interface SelectorChainSnapshot {
  symbol: string;
  spot: number;
  expiration: string;
  /** Every call + put row for `expiration` (greeks-enriched where Tradier has them). */
  rows: OptionChainRow[];
}

/**
 * TRA-3502 — the outcome of one two-sided-quote lookup, with the reason KEPT.
 *
 * Exhaustive and mutually exclusive. `bid`/`ask` are echoed on `one_sided` (whichever
 * side was there) so a reader can see that the book existed and was half-empty rather
 * than having to trust the label — the discriminator is on the payload, not in prose.
 */
export type OptionQuoteResolution =
  | { status: 'quoted'; bid: number; ask: number }
  | { status: 'one_sided'; bid: number | null; ask: number | null }
  | { status: 'absent' }
  | { status: 'breaker_open' }
  | { status: 'no_client' };

export interface RelativeValueScannerService {
  /**
   * TRA-917 — full chain snapshot (spot + nearest in-window expiration + ALL
   * rows) for the shadow option selector. Reuses the same 60s chain cache and
   * expiration auto-pick as {@link scan}, so when it runs right after an RV scan
   * on the same symbol it rides the warm snapshot and costs zero extra Tradier
   * calls. Returns `null` when uncredentialed, the breaker is open, or spot /
   * expiration / chain are unavailable. Never trades.
   */
  getSelectorChain(symbol: string, dtePrefs?: DtePrefs): Promise<SelectorChainSnapshot | null>;
  /**
   * TRA-4357 — {@link getSelectorChain}, with the failure reason PRESERVED.
   *
   * `getSelectorChain` collapses `no_spot`, `no_expirations`, `no_chain`,
   * `breaker_open`, `fetch_error` and `no_credentials` into one bare `null`.
   * `scanOtm` already keeps the discriminated reason off the same resolver, so
   * the OTM and directional paths were reporting the SAME underlying failure
   * under two different names: the OTM ledger said `scan:no_spot` while the
   * directional ledger said `no_chain`. TRA-4357 was filed on exactly that
   * artifact — it read as "one path prices these names, the other cannot",
   * when in fact neither did.
   *
   * OPTIONAL on the interface, same contract as {@link getOptionLastTrade}: a
   * scanner without it still works through `getSelectorChain`, it just cannot
   * name which precondition failed.
   */
  getSelectorChainDetailed?(
    symbol: string,
    dtePrefs?: DtePrefs,
  ): Promise<SelectorChainResolution>;
  /**
   * Scan a symbol for RV opportunities. `dtePrefs` lets callers override the
   * scanner's hardcoded DTE window per-call (TRA-373) — used by the signal
   * engine to flow per-user `AccountSettings.rvDte{Min,Max,Target}` into the
   * shared scanner singleton without rebuilding it. Absent fields fall back
   * to the service's constructor defaults.
   */
  scan(
    symbol: string,
    opts?: RelativeValueScannerOptions,
    dtePrefs?: DtePrefs,
  ): Promise<RelativeValueScanResult>;
  /**
   * TRA-1207 — scan a symbol for mispriced OUT-OF-THE-MONEY contracts (the
   * original TRA-158/TRA-159 options strategy the board re-enabled in place of
   * RV). Rides the same 60s chain snapshot cache + circuit breaker + DTE
   * auto-pick as {@link scan} / {@link getSelectorChain}, so it never adds
   * Tradier load beyond what a same-symbol RV scan would. Returns empty
   * candidates with a DISCRIMINATED {@link OtmScanReason} — `no_credentials`,
   * `breaker_open`, `no_spot`, `no_expirations`, `no_chain` or `fetch_error`
   * (TRA-161; it previously flattened all six into `'unavailable'`). Never
   * trades.
   */
  scanOtm(
    symbol: string,
    opts?: OtmScannerOptions,
    dtePrefs?: DtePrefs,
  ): Promise<OtmMispricingScanResult>;
  /**
   * TRA-4413 item 4 — SHADOW cross-expiration term-structure scan. Fetches up
   * to {@link MAX_TERM_EXPIRATIONS} chains inside the caller's DTE window
   * (riding the same 60s chain cache + breaker as {@link scan}) and runs the
   * engine's `findTermStructureDislocations` over the concatenated rows.
   * `opts.spot` lets a caller that JUST resolved the underlying spot (every
   * scan-path caller has) skip the second `fetchSpot` — the spot leg is the
   * quota-constrained one (TRA-4357). Observe-only: never trades, and the
   * result's `markCalendarViolations` is the negative control that voids the
   * scan's own dislocations when non-zero.
   *
   * OPTIONAL on the interface, same contract as {@link getOptionQuote}: a
   * scanner without it simply produces no term-structure shadow rows.
   */
  scanTermStructure?(
    symbol: string,
    dtePrefs?: DtePrefs,
    opts?: { spot?: number | null; termOptions?: TermStructureOptions },
  ): Promise<TermStructureScanResult>;
  /**
   * Look up the current per-share mark for a contract belonging to `symbol`'s
   * `expiration` chain. Reads from the same cached snapshot used by `scan()`
   * so refreshing exits on an open RV position costs zero extra Tradier calls
   * when the cache is warm. Returns `null` for unknown contracts or rows
   * lacking usable bid/ask.
   */
  getOptionMark(symbol: string, expiration: string, optionSymbol: string): Promise<number | null>;
  /**
   * TRA-1662 — the TWO-SIDED quote for a contract, for the shadow maker-chase
   * measurement. {@link getOptionMark} collapses the book to a scalar mid (and
   * falls back to `last`), which is exactly the information a maker chase needs
   * and cannot get: whether the ASK has come down to our resting limit.
   *
   * Rides the same cached snapshot as `scan()` / `getOptionMark()`, so polling an
   * open position's quote on the engine tick costs ZERO extra Tradier calls when
   * the cache is warm. Returns `null` for unknown contracts or a one-sided book —
   * there is no `last` fallback, because a chase cannot rest against a print.
   * Never trades.
   *
   * OPTIONAL on the interface: the shadow measurement is strictly additive and
   * degrades gracefully. A scanner that cannot serve a two-sided quote simply
   * produces no shadow chases (rather than a flattering half-measured one), so
   * the capability is opt-in per implementation.
   */
  getOptionQuote?(
    symbol: string,
    expiration: string,
    optionSymbol: string,
  ): Promise<{ bid: number; ask: number } | null>;
  /**
   * TRA-3502 — {@link getOptionQuote} with the REASON attached.
   *
   * `getOptionQuote` collapses three different worlds into one `null`: the breaker was
   * open so we never asked, the contract had no row in the snapshot, and the row was
   * there but one-sided. Those are a scanner outage, a stale/delisted contract, and a
   * genuinely illiquid book — and TRA-3502's fallback counter has to tell them apart,
   * because only the third one is a case the modeled `h` legitimately covers. A counter
   * whose one-sided bucket cannot be distinguished from its absent bucket is the
   * `UNKNOWN`-reads-as-`OFF` defect this ticket family exists to remove.
   *
   * Same cached snapshot, same zero-extra-Tradier-calls-when-warm property, same
   * OPTIONAL-capability contract as {@link getOptionQuote} — which is now a thin
   * projection of this, so the two can never disagree about what counts as usable.
   */
  getOptionQuoteDetail?(
    symbol: string,
    expiration: string,
    optionSymbol: string,
  ): Promise<OptionQuoteResolution>;
  /**
   * TRA-2890 — the broker-tape LAST TRADE for a contract, for the live
   * DISPLAY mark ({@link displayOptionMark} in shared). {@link getOptionMark}
   * collapses to the mid and only falls back to `last` on a one-sided book;
   * this reads `row.last` directly so the dashboard can value an open live
   * position the way Tradier's own positions view does. Rides the same cached
   * chain snapshot — polling it right after `getOptionMark` on the engine tick
   * costs ZERO extra Tradier calls. Returns `null` for unknown contracts or a
   * row that has never printed. Display-only: no risk-engine consumer may read
   * it. OPTIONAL on the interface, same contract as {@link getOptionQuote}: a
   * scanner without it simply leaves live display marks on the mid.
   */
  getOptionLastTrade?(
    symbol: string,
    expiration: string,
    optionSymbol: string,
  ): Promise<number | null>;
  /**
   * TRA-4888 — the full TAPE sample for a contract: the two-sided quote PLUS
   * `last`, `volume` and `openInterest`, in one read off the same cached chain
   * snapshot. Feeds the real-fill shadow's trade-through rule.
   *
   * Why this is not a composition of the three existing readers: the fill model
   * differences `volume` BETWEEN POLLS, so bid, ask, last and volume must come
   * from ONE snapshot instant. Stitching them from separate calls could pair a
   * quote with a volume read on the other side of a refresh and manufacture a
   * print that never happened.
   *
   * TRA-4893 item 4 — `lastTradeMs` IS populated now. Tradier's `trade_date`
   * (the last-trade clock, TRA-4870) is projected into `OptionChainRow`, giving
   * `detectNewPrint` a second tell independent of the cumulative-volume counter
   * and shrinking the ungraded population on contracts whose chain row omits
   * volume. It is `null` whenever the chain payload carries no usable stamp,
   * which is the pre-TRA-4893 behaviour (volume tell alone).
   *
   * ⛔ Do NOT reuse this field as a quote-freshness clock. It is frozen on any
   * contract that has not printed — measured up to 863.7 h stale beside a 0.9 s
   * old book (TRA-4870). Its only valid reading is "a print landed".
   *
   * OPTIONAL on the interface, same contract as {@link getOptionQuote}: a
   * scanner without it produces no shadow rows rather than half-measured ones.
   */
  getOptionTapeSample?(
    symbol: string,
    expiration: string,
    optionSymbol: string,
  ): Promise<{
    bid: number | null;
    ask: number | null;
    last: number | null;
    volume: number | null;
    openInterest: number | null;
    lastTradeMs: number | null;
  } | null>;
  diagnostics(): RelativeValueScannerDiagnostics;
}

export interface RelativeValueScannerConfig {
  tradierApiToken?: string;
  tradierAccountId?: string;
  tradierEnv?: 'sandbox' | 'production';
  /** Resolves the underlying spot price — server callers wire this to Yahoo. */
  fetchSpot: (symbol: string) => Promise<number | null>;
  /** Test seam — defaults to constructing a real `TradierOptionsClient`. */
  clientFactory?: (
    token: string,
    accountId: string,
    env: 'sandbox' | 'production',
  ) => TradierOptionsClient;
  /** Test seam for time. */
  now?: () => number;
  /**
   * TRA-373 — process-wide defaults for the DTE expiration window. Per-call
   * overrides on `scan()` win when supplied; absent fields here fall back to
   * the spec constants (21 / 60 / 35).
   */
  dteMin?: number;
  dteMax?: number;
  dteTarget?: number;
  /**
   * Self-imposed ceiling on UPSTREAM expirations+chain calls per rolling minute.
   * Needed once chains ride the production market-data token, which they then
   * share with quotes and timesales (Tradier: 120 req/min per token). `null` /
   * absent = no ceiling (legacy). A call over budget is suppressed and reported
   * as `quota_held` with its own `chainBudget` counters — our suppression, not
   * a vendor refusal.
   */
  chainCallBudgetPerMin?: number | null;
  /**
   * How many in-window expirations `scanOtm` prices (the DTE-picked one plus
   * the nearest others). Default 1 = legacy single-expiration scan.
   */
  otmMaxExpirations?: number;
  /** Label for diagnostics: which Tradier environment the chains come from. */
  marketDataSource?: string;
}

/**
 * Raised INSTEAD of an upstream call when {@link RelativeValueScannerConfig.chainCallBudgetPerMin}
 * is spent. Subclasses the quota hold so every caller already maps it to
 * `quota_held` and the breaker already declines to trip on it.
 */
export class TradierChainBudgetHoldError extends TradierQuotaHoldError {
  constructor(endpoint: 'expirations' | 'chain', detail: string, heldUntilMs: number) {
    super(endpoint, `${detail}; self-imposed chain budget spent`, heldUntilMs);
    this.name = 'TradierChainBudgetHoldError';
  }
}

/**
 * Tradier-backed wrapper around `findRelativeValueOpportunities` (TRA-191).
 *
 *   • 60 s chain-snapshot cache — repeated scans of the same expiration serve
 *     from cache so we stay well under the 60/min Tradier sandbox cap.
 *   • Discriminated circuit breaker (TRA-417) — once an upstream fetch
 *     throws, further scans short-circuit until a cooldown elapses. The
 *     cooldown is short (~90s) for 429-shaped errors with exponential
 *     backoff on repeated trips, and ~5 min for other upstream errors,
 *     replacing the previous flat 1 h cooldown.
 *   • Expiration auto-pick — selects the listed expiration whose DTE is
 *     closest to the target (default 35d) inside the [min, max] window
 *     (default 21–60d, TRA-373). Per-call overrides on `scan()` carry the
 *     per-user `AccountSettings.rvDte*` knobs through the shared singleton.
 *
 * Pure data layer — does not place trades or modify any account.
 */
export class TradierRelativeValueScannerService implements RelativeValueScannerService {
  private readonly client: TradierOptionsClient | null;
  private readonly fetchSpot: (symbol: string) => Promise<number | null>;
  private readonly now: () => number;
  private readonly defaultDteMin: number;
  private readonly defaultDteMax: number;
  private readonly defaultDteTarget: number;

  private readonly chainCache = new Map<ChainKey, CacheEntry<OptionChainRow[]>>();
  private readonly expirationsCache = new Map<string, CacheEntry<string[]>>();
  // TRA-417 — breaker state holds the dynamic cooldown chosen at trip time
  // (90s for 429 with backoff, 5min for other upstream errors). Backoff
  // tracking is separate so a long quiet period between 429s resets the
  // counter without clearing an in-flight cooldown.
  private breakerState: BreakerState | null = null;
  private last429AtMs: number | null = null;
  private consecutive429 = 0;
  // TRA-4664 — see `RelativeValueScannerDiagnostics.chainCache`/`upstreamRefusals`.
  private readonly chainCounters: CacheCounters = { hits: 0, misses: 0, capacityEvictions: 0 };
  private readonly expirationsCounters: CacheCounters = { hits: 0, misses: 0, capacityEvictions: 0 };
  // TRA-5006 — the payload-free demand shadows. See `CacheDemand`. Insertion
  // order is ascending `lastReadAtMs` because `noteKeyDemand` deletes before it
  // sets, which is what lets the TTL sweep stop at the first live entry.
  private readonly chainDemand = new Map<string, number>();
  private readonly expirationsDemand = new Map<string, number>();
  private readonly chainDemandState: DemandState = { peak: 0, seen: new Set(), truncated: false };
  private readonly expirationsDemandState: DemandState = { peak: 0, seen: new Set(), truncated: false };
  private readonly refusalsByStatus: Record<string, number> = {};
  private lastRefusalAtMs: number | null = null;
  private lastRefusalStatus: number | null = null;
  // TRA-4865 (fourth pass) — see `noteRefusalReason`. Pairs with the two fields
  // above: `lastStatus`/`lastAtMs`/`lastReason` all describe ONE refusal, the
  // newest.
  private lastRefusalReason: string | null = null;
  // TRA-4664 (second pass) — see `RelativeValueScannerDiagnostics.refusalCooldown`.
  // Key shapes match the caches: `expirations|SYM` and `chain|SYM|EXPIRATION`.
  private readonly refusalCooldown = new Map<string, CacheEntry<TradierHttpRefusalError>>();
  private suppressedRefusals = 0;
  // TRA-4865 — the since-boot twin of `refusalCooldown`: same key shapes, same
  // population, but nothing ever expires out of it. Value = how many times this
  // key was refused UPSTREAM (i.e. how many times the cooldown was re-armed on
  // it), which is what separates a one-off refusal from a permanently dark name.
  private readonly refusedKeysSinceBoot = new Map<string, number>();
  private refusedKeyCensusEvicted = 0;
  // TRA-4865 — WHY upstream refused. See `RelativeValueScannerDiagnostics`.
  private readonly refusalsByReason: Record<string, number> = {};
  // TRA-5005 — the ACCOUNT-scoped quota gate. ONE instant for the whole scanner,
  // not a per-key map: the condition it models is a property of the account at a
  // minute, so there is nothing to key it by. `null` = open.
  // See `RelativeValueScannerDiagnostics.quotaHold`.
  private quotaBlockedUntilMs: number | null = null;
  private lastQuotaExpiresAtMs: number | null = null;
  private lastQuotaHoldArmedAtMs: number | null = null;
  private readonly quotaHoldCounters = {
    upstreamRefusals: 0,
    holdsArmed: 0,
    holdsExtended: 0,
    holdsReleased: 0,
    suppressed: 0,
    suppressedExpirations: 0,
    suppressedChain: 0,
    expiresHonoured: 0,
    expiresUnreadable: 0,
    expiresStale: 0,
    expiresClamped: 0,
    longestHoldMs: 0,
  };

  /**
   * TRA-4865 — fold one upstream refusal into the reason histogram. The bucket
   * is always prefixed with the status, so a vendor that changes its wording
   * splits a bucket rather than silently merging into an unrelated one.
   *
   * `undefined` (the caller had no body to offer) and `null` (there was no
   * body, or it was unreadable) are kept DISTINCT from any real reason: folding
   * either into a populated bucket would manufacture evidence about a refusal
   * whose cause we never saw, which is the defect this whole field answers.
   */
  private noteRefusalReason(httpStatus: number, reason?: string | null): void {
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    const captured = trimmed.length > 0;
    const suffix = captured
      ? trimmed.slice(0, MAX_REFUSAL_REASON_LEN)
      : reason === undefined
        ? '(not captured)'
        : '(no body)';
    // TRA-4865 (fourth pass) — the newest refusal's reason, VERBATIM and
    // un-canonicalised, held outside the bucket budget. A saturated `byReason`
    // must never make the CURRENT cause unreadable: on live `faae9388` every
    // refusal of the last two days sat in `(other)`, so the freshest datable
    // reason was two days stale while the counter kept climbing.
    this.lastRefusalReason = suffix;
    // Canonicalise only a real vendor body — the two sentinels are ours, not the
    // vendor's, and stay byte-exact so neither can collide with a real reason.
    let bucket = `${httpStatus} ${captured ? canonicalizeRefusalReason(suffix) : suffix}`;
    if (
      this.refusalsByReason[bucket] === undefined &&
      Object.keys(this.refusalsByReason).length >= MAX_REFUSAL_REASONS_TRACKED
    ) {
      bucket = `${httpStatus} (other)`;
    }
    this.refusalsByReason[bucket] = (this.refusalsByReason[bucket] ?? 0) + 1;
  }

  constructor(config: RelativeValueScannerConfig) {
    this.fetchSpot = config.fetchSpot;
    this.now = config.now ?? Date.now;
    this.defaultDteMin =
      Number.isFinite(config.dteMin) && (config.dteMin as number) > 0 ? (config.dteMin as number) : MIN_DTE_DAYS;
    this.defaultDteMax =
      Number.isFinite(config.dteMax) && (config.dteMax as number) > 0 ? (config.dteMax as number) : MAX_DTE_DAYS;
    this.defaultDteTarget =
      Number.isFinite(config.dteTarget) && (config.dteTarget as number) > 0
        ? (config.dteTarget as number)
        : TARGET_DTE_DAYS;

    const token = config.tradierApiToken ?? '';
    const accountId = config.tradierAccountId ?? '';
    const env = config.tradierEnv ?? 'sandbox';
    if (token && accountId) {
      const factory = config.clientFactory ?? ((t, a, e) => new TradierOptionsClient(t, a, e));
      this.client = factory(token, accountId, env);
    } else {
      this.client = null;
    }
    const budget = config.chainCallBudgetPerMin;
    this.chainBudgetPerMin =
      typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : null;
    const maxExp = config.otmMaxExpirations;
    this.otmMaxExpirations =
      typeof maxExp === 'number' && Number.isFinite(maxExp) && maxExp >= 1 ? Math.min(6, Math.floor(maxExp)) : 1;
    this.marketDataEnv = env;
    this.marketDataSource = config.marketDataSource ?? `TRADIER_ENV=${env}`;
  }

  private readonly chainBudgetPerMin: number | null;
  private readonly otmMaxExpirations: number;
  private readonly marketDataEnv: 'sandbox' | 'production';
  private readonly marketDataSource: string;
  /** Upstream call stamps inside the rolling minute (budget accounting). */
  private upstreamCallStamps: number[] = [];
  private readonly chainBudgetCounters = { upstreamCalls: 0, deferred: 0, lastDeferredAtMs: null as number | null };

  /** Spend one unit of the self-imposed chain budget, or throw if it is spent. */
  private spendChainBudget(endpoint: 'expirations' | 'chain', detail: string): void {
    const now = this.now();
    const cutoff = now - 60_000;
    while (this.upstreamCallStamps.length > 0 && this.upstreamCallStamps[0]! <= cutoff) {
      this.upstreamCallStamps.shift();
    }
    if (this.chainBudgetPerMin != null && this.upstreamCallStamps.length >= this.chainBudgetPerMin) {
      this.chainBudgetCounters.deferred += 1;
      this.chainBudgetCounters.lastDeferredAtMs = now;
      throw new TradierChainBudgetHoldError(endpoint, detail, this.upstreamCallStamps[0]! + 60_000);
    }
    this.upstreamCallStamps.push(now);
    this.chainBudgetCounters.upstreamCalls += 1;
  }

  diagnostics(): RelativeValueScannerDiagnostics {
    return {
      configured: this.client !== null,
      marketData: {
        env: this.marketDataEnv,
        source: this.marketDataSource,
        // Sandbox chains are 15-min delayed and carry no greeks/IV (Tradier docs).
        delayedQuotes: this.marketDataEnv === 'sandbox',
        vendorGreeks: this.marketDataEnv === 'production',
      },
      chainBudget: {
        limitPerMin: this.chainBudgetPerMin,
        usedLastMin: this.upstreamCallStamps.filter((t) => t > this.now() - 60_000).length,
        ...this.chainBudgetCounters,
      },
      otmMaxExpirations: this.otmMaxExpirations,
      breakerOpen: this.isBreakerOpen(),
      breakerOpenedAtMs: this.breakerState?.openedAt ?? null,
      cacheSize: this.chainCache.size,
      expirationsCacheSize: this.expirationsCache.size,
      chainCacheMaxEntries: MAX_CHAIN_CACHE_ENTRIES,
      expirationsCacheMaxEntries: MAX_EXPIRATIONS_CACHE_ENTRIES,
      chainCache: { ...this.chainCounters },
      expirationsCache: { ...this.expirationsCounters },
      chainCacheDemand: this.cacheDemandCensus(
        this.chainDemand,
        this.chainDemandState,
        CHAIN_CACHE_TTL_MS,
        MAX_CHAIN_CACHE_ENTRIES,
      ),
      expirationsCacheDemand: this.cacheDemandCensus(
        this.expirationsDemand,
        this.expirationsDemandState,
        EXPIRATIONS_CACHE_TTL_MS,
        MAX_EXPIRATIONS_CACHE_ENTRIES,
      ),
      upstreamRefusals: {
        byStatus: { ...this.refusalsByStatus },
        lastAtMs: this.lastRefusalAtMs,
        lastStatus: this.lastRefusalStatus,
        lastReason: this.lastRefusalReason,
      },
      refusalCooldown: {
        size: this.refusalCooldown.size,
        suppressed: this.suppressedRefusals,
        ...this.refusalCooldownCensus(),
        sinceBoot: this.refusedKeySinceBootCensus(),
        byReason: { ...this.refusalsByReason },
      },
      quotaHold: this.quotaHoldDiagnostics(),
    };
  }

  /**
   * TRA-5005 — the quota gate's counters. Read-only, like every other census
   * here: it reports an expired hold as still-set `blockedUntilMs` with a
   * non-positive remaining time rather than releasing it, because a read that
   * changes what the next read sees is not an instrument (the TRA-4664 third-pass
   * rule). `heldMsRemaining` is `null` exactly when the gate is open.
   */
  private quotaHoldDiagnostics(): NonNullable<RelativeValueScannerDiagnostics['quotaHold']> {
    const c = this.quotaHoldCounters;
    const until = this.quotaBlockedUntilMs;
    const remaining = until == null ? null : until - this.now();
    const held = remaining != null && remaining > 0;
    return {
      blockedUntilMs: held ? until : null,
      heldMsRemaining: held ? remaining : null,
      upstreamRefusals: c.upstreamRefusals,
      holdsArmed: c.holdsArmed,
      holdsExtended: c.holdsExtended,
      holdsReleased: c.holdsReleased,
      suppressed: c.suppressed,
      suppressedByEndpoint: { expirations: c.suppressedExpirations, chain: c.suppressedChain },
      expiresHonoured: c.expiresHonoured,
      expiresUnreadable: c.expiresUnreadable,
      expiresStale: c.expiresStale,
      expiresClamped: c.expiresClamped,
      maxHoldMs: MAX_QUOTA_HOLD_MS,
      longestHoldMs: c.longestHoldMs,
      lastExpiresAtMs: this.lastQuotaExpiresAtMs,
      lastArmedAtMs: this.lastQuotaHoldArmedAtMs,
    };
  }

  /**
   * TRA-5005 — arm (or extend) the ACCOUNT-scoped quota gate off the vendor's own
   * reset instant.
   *
   * Three things this deliberately does NOT do:
   *
   * 1. **It does not touch the per-key cooldown.** The key in flight did nothing
   *    wrong; blacking it out is the defect. AC1.
   * 2. **It does not trip the breaker.** The breaker opens the WHOLE scanner, and
   *    a quota that refills in <60s does not warrant that — it would trade 55.6%
   *    silent misses for 100% darkness. A short, precisely-dated global hold is
   *    the point.
   * 3. **It never shortens an existing hold.** Extensions only, so a stale body
   *    arriving after a fresher one cannot re-open the gate early.
   */
  private armQuotaHold(reason?: string | null): void {
    const now = this.now();
    const c = this.quotaHoldCounters;
    c.upstreamRefusals += 1;
    const parsed = parseQuotaExpiresMs(reason);
    // `lastExpiresAtMs` carries the vendor datum VERBATIM — `null` when there was
    // none. Never coalesced to 0: an unreadable datum and an epoch of 0 are
    // different statements and only one of them is a measurement (TRA-3802).
    this.lastQuotaExpiresAtMs = parsed;
    let until: number;
    if (parsed == null) {
      c.expiresUnreadable += 1;
      until = nextMinuteBoundaryMs(now);
    } else if (parsed <= now) {
      c.expiresStale += 1;
      until = nextMinuteBoundaryMs(now);
    } else if (parsed - now > MAX_QUOTA_HOLD_MS) {
      c.expiresClamped += 1;
      until = now + MAX_QUOTA_HOLD_MS;
    } else {
      c.expiresHonoured += 1;
      until = parsed;
    }
    if (until < now + MIN_QUOTA_HOLD_MS) until = now + MIN_QUOTA_HOLD_MS;

    const prior = this.quotaBlockedUntilMs;
    if (prior != null && prior > now) {
      if (until > prior) {
        this.quotaBlockedUntilMs = until;
        c.holdsExtended += 1;
      }
    } else {
      this.quotaBlockedUntilMs = until;
      c.holdsArmed += 1;
      this.lastQuotaHoldArmedAtMs = now;
      log.warn('tradier account quota hold armed (global, not per-key)', {
        holdMs: until - now,
        expiresAtMs: parsed,
        reason: reason ?? null,
      });
    }
    const span = (this.quotaBlockedUntilMs ?? now) - now;
    if (span > c.longestHoldMs) c.longestHoldMs = span;
  }

  /**
   * TRA-5005 — skip the upstream call for EVERY key while the account's quota
   * gate is held, and count it.
   *
   * Runs ahead of {@link throwIfCooling} because the condition is global: there
   * is no point consulting a per-key map about a state that belongs to the
   * account. The warm chain/expirations caches are checked by the callers BEFORE
   * this, so a held gate never invalidates data we already have — it only stops
   * new calls that the vendor would refuse anyway.
   */
  private throwIfQuotaHeld(endpoint: 'expirations' | 'chain', detail: string): void {
    const until = this.quotaBlockedUntilMs;
    if (until == null) return;
    const now = this.now();
    if (now >= until) {
      this.quotaBlockedUntilMs = null;
      this.quotaHoldCounters.holdsReleased += 1;
      return;
    }
    this.quotaHoldCounters.suppressed += 1;
    if (endpoint === 'chain') this.quotaHoldCounters.suppressedChain += 1;
    else this.quotaHoldCounters.suppressedExpirations += 1;
    throw new TradierQuotaHoldError(endpoint, detail, until);
  }

  /**
   * TRA-4664 (third pass) — name the keys the cooldown is currently silencing.
   * Read-only: it must NOT sweep the expired entries it filters out, because
   * `size` is the number the second pass's grade was written against and a
   * read that changes what the next read sees is not an instrument. Only keys
   * still inside `REFUSAL_4XX_COOLDOWN_MS` are reported.
   */
  private refusalCooldownCensus(): {
    cooling: number;
    byEndpoint: { expirations: number; chain: number };
    keys: string[];
    keysTruncated: boolean;
  } {
    const now = this.now();
    const byEndpoint = { expirations: 0, chain: 0 };
    const keys: string[] = [];
    for (const [key, entry] of this.refusalCooldown) {
      if (now - entry.at >= REFUSAL_4XX_COOLDOWN_MS) continue;
      if (key.startsWith('chain|')) byEndpoint.chain += 1;
      else byEndpoint.expirations += 1;
      keys.push(key);
    }
    keys.sort();
    return {
      cooling: keys.length,
      byEndpoint,
      keys: keys.slice(0, MAX_REFUSAL_COOLDOWN_KEYS_REPORTED),
      keysTruncated: keys.length > MAX_REFUSAL_COOLDOWN_KEYS_REPORTED,
    };
  }

  /**
   * TRA-4865 — record an UPSTREAM refusal against the since-boot census. Never
   * called from the suppression path: a re-thrown cooling refusal is not a new
   * refusal, and counting it here would turn "how permanently dark is this key"
   * into "how often did anything ask for it".
   *
   * The cap evicts oldest-inserted and BOOKS the eviction, because a census that
   * silently clamps is the window census all over again.
   */
  private noteRefusedKeySinceBoot(key: string): void {
    const prior = this.refusedKeysSinceBoot.get(key);
    this.refusedKeysSinceBoot.set(key, (prior ?? 0) + 1);
    while (this.refusedKeysSinceBoot.size > MAX_REFUSED_KEY_CENSUS_ENTRIES) {
      const oldest = this.refusedKeysSinceBoot.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.refusedKeysSinceBoot.delete(oldest);
      this.refusedKeyCensusEvicted += 1;
    }
  }

  /**
   * TRA-4865 — the session census. Read-only, like `refusalCooldownCensus`, and
   * deliberately NOT filtered by the cooldown clock: a key Tradier refused at
   * 14:02Z is still a key Tradier refuses, and the whole defect this answers is
   * that the ten-minute view forgets it by 14:13Z.
   */
  private refusedKeySinceBootCensus(): {
    distinctKeys: number;
    byEndpoint: { expirations: number; chain: number };
    refusals: number;
    refusalsByKey: Record<string, number>;
    keysTruncated: boolean;
    reportedByEndpoint: { expirations: number; chain: number };
    evicted: number;
  } {
    const byEndpoint = { expirations: 0, chain: 0 };
    let refusals = 0;
    const chainKeys: string[] = [];
    const expirationKeys: string[] = [];
    for (const [key, count] of this.refusedKeysSinceBoot) {
      if (key.startsWith('chain|')) {
        byEndpoint.chain += 1;
        chainKeys.push(key);
      } else {
        byEndpoint.expirations += 1;
        expirationKeys.push(key);
      }
      refusals += count;
    }

    // TRA-4865 (third pass) — the truncation used to be the head of ONE lexical
    // sort over both endpoints. `chain|` sorts before `expirations|`, so once
    // the population passed the cap the published rows were 100% chain and 0%
    // expirations — on live `66a8a1ab` 2026-09-25, 300 chain rows and zero
    // expirations rows while `byEndpoint` read {expirations: 445, chain: 307}.
    // The issue's PRIMARY fork is "which endpoint dominates", so the reported
    // sample was partitioned on exactly the axis it was being read to decide,
    // and it answered "chain, unanimously" on a population that is 59%
    // expirations. A lexical head reads like a sample and is a partition.
    //
    // So: rank each endpoint independently by refusal COUNT descending — which
    // is the stated purpose of the counter ("what separates a one-off refusal
    // from a permanently dark name") — and give each endpoint at least half the
    // budget before either is allowed to spend the other's share.
    const byCountDesc = (a: string, b: string): number => {
      const ca = this.refusedKeysSinceBoot.get(a)!;
      const cb = this.refusedKeysSinceBoot.get(b)!;
      if (ca !== cb) return cb - ca;
      return a < b ? -1 : a > b ? 1 : 0;
    };
    chainKeys.sort(byCountDesc);
    expirationKeys.sort(byCountDesc);

    const half = Math.floor(MAX_REFUSAL_COOLDOWN_KEYS_REPORTED / 2);
    // Each endpoint is guaranteed `half`; whatever the smaller one leaves
    // unspent goes to the larger, so a cap of 300 still reports 300 keys when
    // one endpoint has fewer than 150.
    const chainQuota = Math.min(chainKeys.length, Math.max(half, MAX_REFUSAL_COOLDOWN_KEYS_REPORTED - expirationKeys.length));
    const expirationQuota = Math.min(
      expirationKeys.length,
      MAX_REFUSAL_COOLDOWN_KEYS_REPORTED - chainQuota,
    );

    const picked = [...chainKeys.slice(0, chainQuota), ...expirationKeys.slice(0, expirationQuota)];
    picked.sort();
    const refusalsByKey: Record<string, number> = {};
    for (const key of picked) refusalsByKey[key] = this.refusedKeysSinceBoot.get(key)!;

    return {
      distinctKeys: this.refusedKeysSinceBoot.size,
      byEndpoint,
      refusals,
      refusalsByKey,
      keysTruncated: this.refusedKeysSinceBoot.size > picked.length,
      reportedByEndpoint: { expirations: expirationQuota, chain: chainQuota },
      evicted: this.refusedKeyCensusEvicted,
    };
  }

  async scan(
    symbol: string,
    opts: RelativeValueScannerOptions = {},
    dtePrefs: DtePrefs = {},
  ): Promise<RelativeValueScanResult> {
    const upper = symbol.trim().toUpperCase();
    if (!this.client) {
      return { symbol: upper, spot: null, expiration: null, candidates: [], reason: 'no_credentials' };
    }
    if (this.isBreakerOpen()) {
      return { symbol: upper, spot: null, expiration: null, candidates: [], reason: 'breaker_open' };
    }

    let spot: number | null;
    try {
      spot = await this.fetchSpot(upper);
    } catch (err) {
      return {
        symbol: upper, spot: null, expiration: null, candidates: [],
        reason: 'fetch_error', errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    if (spot == null || !Number.isFinite(spot) || spot <= 0) {
      return { symbol: upper, spot: null, expiration: null, candidates: [], reason: 'no_spot' };
    }

    let expiration: string | null;
    try {
      expiration = await this.pickExpiration(upper, dtePrefs);
    } catch (err) {
      this.tripBreaker(`getExpirations(${upper}) failed`, err);
      return {
        symbol: upper, spot, expiration: null, candidates: [],
        // TRA-5005 — `quota_held` when the account quota gate suppressed or the
        // vendor quota-refused this call; `fetch_error` otherwise.
        reason: throwReason(err), errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    if (!expiration) {
      return { symbol: upper, spot, expiration: null, candidates: [], reason: 'no_expirations' };
    }

    let chain: OptionChainRow[];
    try {
      chain = await this.fetchChain(upper, expiration);
    } catch (err) {
      this.tripBreaker(`getChainSnapshot(${upper},${expiration}) failed`, err);
      return {
        symbol: upper, spot, expiration, candidates: [],
        reason: throwReason(err), errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    if (chain.length === 0) {
      return { symbol: upper, spot, expiration, candidates: [], reason: 'no_chain' };
    }

    const scanOpts = { now: this.now(), ...opts };
    const candidates = findRelativeValueOpportunities(chain, spot, scanOpts);
    if (candidates.length === 0) {
      const why = explainRelativeValueNoCandidates(chain, spot, scanOpts);
      return {
        symbol: upper, spot, expiration, candidates, reason: 'ok',
        noCandidatesReason: why?.reason ?? 'unattributed',
      };
    }
    return { symbol: upper, spot, expiration, candidates, reason: 'ok' };
  }

  async scanOtm(
    symbol: string,
    opts: OtmScannerOptions = {},
    dtePrefs: DtePrefs = {},
  ): Promise<OtmMispricingScanResult> {
    const upper = symbol.trim().toUpperCase();
    // Reuse the hardened snapshot path (spot + DTE-picked expiration + full
    // cached chain, breaker-guarded) so OTM rides the same 60s cache as RV.
    const { snapshot: snap, reason, errorMessage } = await this.resolveSelectorChain(upper, dtePrefs);
    if (!snap) {
      return {
        symbol: upper,
        spot: null,
        expiration: null,
        candidates: [],
        reason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      };
    }
    // Price more than the one DTE-picked expiration when configured: the
    // nearest other in-window expirations (by distance to the target) are
    // appended. Extras ride the same 60s cache, budget and breaker; a failure
    // on an extra drops that extra only — the primary result still stands.
    let rows = snap.rows;
    const scannedExpirations = [snap.expiration];
    if (this.otmMaxExpirations > 1) {
      try {
        const windowed = await this.resolveWindowedExpirations(upper, dtePrefs);
        const extras = (windowed?.inWindow ?? [])
          .filter((e) => e.d !== snap.expiration)
          .sort((a, b) => Math.abs(a.ms - windowed!.targetMs) - Math.abs(b.ms - windowed!.targetMs))
          .slice(0, this.otmMaxExpirations - 1);
        for (const e of extras) {
          try {
            const extra = await this.fetchChain(upper, e.d);
            if (extra.length > 0) {
              rows = rows.concat(extra);
              scannedExpirations.push(e.d);
            }
          } catch (err) {
            this.tripBreaker(`getChainSnapshot(${upper},${e.d}) failed`, err);
            break;
          }
        }
      } catch (err) {
        this.tripBreaker(`getExpirations(${upper}) failed`, err);
      }
    }
    const candidates = findMispricedOtmContracts(rows, snap.spot, { now: this.now(), ...opts });
    return {
      symbol: snap.symbol, spot: snap.spot, expiration: snap.expiration, candidates, reason: 'ok',
      scannedExpirations,
    };
  }

  /**
   * TRA-4413 item 4 — see the interface doc. Chain fetches ride the 60s cache,
   * so a capture that follows a same-symbol RV/OTM scan re-uses that scan's
   * chain for its expiration and pays only for the ADDITIONAL expirations
   * (≤ {@link MAX_TERM_EXPIRATIONS} − 1 upstream calls when the cache is warm).
   */
  async scanTermStructure(
    symbol: string,
    dtePrefs: DtePrefs = {},
    opts: { spot?: number | null; termOptions?: TermStructureOptions } = {},
  ): Promise<TermStructureScanResult> {
    const upper = symbol.trim().toUpperCase();
    const fail = (
      reason: TermStructureScanResult['reason'],
      spot: number | null = null,
      errorMessage?: string,
    ): TermStructureScanResult => ({
      symbol: upper,
      spot,
      expirations: [],
      report: null,
      reason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });

    if (!this.client) return fail('no_credentials');
    if (this.isBreakerOpen()) return fail('breaker_open');

    // Spot: trust a caller-provided read (the scan paths resolved one moments
    // ago against the SAME 60s-coherent chain cache — TRA-4357) and only fetch
    // when running standalone.
    let spot: number | null;
    if (opts.spot != null && Number.isFinite(opts.spot) && opts.spot > 0) {
      spot = opts.spot;
    } else {
      try {
        spot = await this.fetchSpot(upper);
      } catch (err) {
        return fail('fetch_error', null, err instanceof Error ? err.message : String(err));
      }
      if (spot == null || !Number.isFinite(spot) || spot <= 0) return fail('no_spot');
    }

    let windowed: Awaited<ReturnType<typeof this.resolveWindowedExpirations>>;
    try {
      windowed = await this.resolveWindowedExpirations(upper, dtePrefs);
    } catch (err) {
      this.tripBreaker(`getExpirations(${upper}) failed`, err);
      return fail(throwReason(err), spot, err instanceof Error ? err.message : String(err));
    }
    // A term axis needs at least two expirations; below that the scan refuses
    // with its own reason rather than handing the engine a degenerate input
    // (whose per-bucket `insufficient_expirations` would misattribute a
    // symbol-level fact to every bucket).
    if (!windowed || windowed.inWindow.length < 2) return fail('no_expirations', spot);

    // Up to MAX_TERM_EXPIRATIONS, spread evenly across the ascending in-window
    // list with first/last always kept — the √T fit's leverage lives in the
    // span, not in adjacent weeklies.
    const all = windowed.inWindow;
    let picked: Array<{ d: string; ms: number }>;
    if (all.length <= MAX_TERM_EXPIRATIONS) {
      picked = all;
    } else {
      const idx = new Set<number>();
      for (let i = 0; i < MAX_TERM_EXPIRATIONS; i += 1) {
        idx.add(Math.round((i * (all.length - 1)) / (MAX_TERM_EXPIRATIONS - 1)));
      }
      picked = [...idx].sort((a, b) => a - b).map((i) => all[i]!);
    }

    const rows: OptionChainRow[] = [];
    for (const exp of picked) {
      let chain: OptionChainRow[];
      try {
        chain = await this.fetchChain(upper, exp.d);
      } catch (err) {
        this.tripBreaker(`getChainSnapshot(${upper},${exp.d}) failed`, err);
        return fail(throwReason(err), spot, err instanceof Error ? err.message : String(err));
      }
      if (chain) rows.push(...chain);
    }
    if (rows.length === 0) return fail('no_chain', spot);

    const report = findTermStructureDislocations(rows, spot, {
      now: this.now(),
      ...opts.termOptions,
    });
    return {
      symbol: upper,
      spot,
      expirations: picked.map((e) => e.d),
      report,
      reason: 'ok',
    };
  }

  async getSelectorChain(
    symbol: string,
    dtePrefs: DtePrefs = {},
  ): Promise<SelectorChainSnapshot | null> {
    // TRA-161 — thin wrapper over `resolveSelectorChain`. Signature and
    // behaviour are unchanged (null on any failure); the discriminated reason
    // is only consumed by `scanOtm` / the desktop panel.
    return (await this.resolveSelectorChain(symbol, dtePrefs)).snapshot;
  }

  /**
   * TRA-4357 — the reason-preserving twin of {@link getSelectorChain}. Same
   * resolver, same cache, same breaker, same upstream cost; it simply does not
   * throw the reason away. See the interface declaration for why that mattered.
   */
  async getSelectorChainDetailed(
    symbol: string,
    dtePrefs: DtePrefs = {},
  ): Promise<SelectorChainResolution> {
    return this.resolveSelectorChain(symbol, dtePrefs);
  }

  /**
   * TRA-161 — the snapshot path with its failure reason preserved. Every early
   * return that used to be a bare `null` now names WHICH precondition failed.
   * The control flow, breaker trips and cache use are byte-for-byte the same as
   * the pre-split `getSelectorChain`; only the return shape is richer.
   */
  private async resolveSelectorChain(
    symbol: string,
    dtePrefs: DtePrefs = {},
  ): Promise<SelectorChainResolution> {
    if (!this.client) return { snapshot: null, reason: 'no_credentials' };
    if (this.isBreakerOpen()) return { snapshot: null, reason: 'breaker_open' };
    const upper = symbol.trim().toUpperCase();

    let spot: number | null;
    try {
      spot = await this.fetchSpot(upper);
    } catch (err) {
      return {
        snapshot: null,
        reason: 'fetch_error',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    if (spot == null || !Number.isFinite(spot) || spot <= 0) {
      return { snapshot: null, reason: 'no_spot' };
    }

    let expiration: string | null;
    try {
      expiration = await this.pickExpiration(upper, dtePrefs);
    } catch (err) {
      this.tripBreaker(`getExpirations(${upper}) failed`, err);
      return {
        snapshot: null,
        // TRA-5005 — this is the OTM/desk/live path whose `scan:fetch_error` was
        // 20.8% of 13,900 evaluations on 2026-09-24. Splitting it here is what
        // makes `censusByEtDay` able to answer AC3.
        reason: throwReason(err),
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    if (!expiration) return { snapshot: null, reason: 'no_expirations' };

    let rows: OptionChainRow[];
    try {
      rows = await this.fetchChain(upper, expiration);
    } catch (err) {
      this.tripBreaker(`getChainSnapshot(${upper},${expiration}) failed`, err);
      return {
        snapshot: null,
        reason: throwReason(err),
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    // TRA-161 — `!rows` as well as the empty check. `getChainSnapshot` is TYPED
    // to return an array, but a provider/client that hands back null or
    // undefined would throw a TypeError on `.length` HERE, outside the try —
    // i.e. out of `scanOtm` entirely. That was survivable while the only caller
    // was the in-process signal engine; it is not now that this path is behind
    // an async Express handler, where an unhandled rejection leaves the request
    // hanging rather than answering. Fail closed to `no_chain` instead.
    if (!rows || rows.length === 0) return { snapshot: null, reason: 'no_chain' };

    return { snapshot: { symbol: upper, spot, expiration, rows }, reason: 'ok' };
  }

  async getOptionMark(
    symbol: string,
    expiration: string,
    optionSymbol: string,
  ): Promise<number | null> {
    if (!this.client) return null;
    if (this.isBreakerOpen()) return null;
    const upper = symbol.trim().toUpperCase();
    let chain: OptionChainRow[];
    try {
      chain = await this.fetchChain(upper, expiration);
    } catch (err) {
      this.tripBreaker(`getChainSnapshot(${upper},${expiration}) failed`, err);
      return null;
    }
    const row = chain.find((r) => r.optionSymbol === optionSymbol);
    if (!row) return null;
    const bid = row.bid ?? 0;
    const ask = row.ask ?? 0;
    if (bid > 0 && ask > 0 && ask >= bid) return (bid + ask) / 2;
    if (typeof row.last === 'number' && row.last > 0) return row.last;
    return null;
  }

  // TRA-2890 — `row.last` verbatim for the live display mark. See the
  // interface doc: display-only, rides the same cached snapshot as
  // getOptionMark, and deliberately does NOT fall back to the mid — a `null`
  // here means "the tape has never printed", and the caller's display rule
  // (`displayOptionMark`) owns the fallback.
  async getOptionLastTrade(
    symbol: string,
    expiration: string,
    optionSymbol: string,
  ): Promise<number | null> {
    if (!this.client) return null;
    if (this.isBreakerOpen()) return null;
    const upper = symbol.trim().toUpperCase();
    let chain: OptionChainRow[];
    try {
      chain = await this.fetchChain(upper, expiration);
    } catch (err) {
      this.tripBreaker(`getChainSnapshot(${upper},${expiration}) failed`, err);
      return null;
    }
    const row = chain.find((r) => r.optionSymbol === optionSymbol);
    if (!row) return null;
    return typeof row.last === 'number' && Number.isFinite(row.last) && row.last > 0
      ? row.last
      : null;
  }

  /**
   * TRA-4888 — one tape sample off ONE cached chain snapshot. See the interface
   * doc for why the fields must not be stitched from separate reads.
   *
   * Every field is independently nullable: a row that carries a quote but no
   * volume is a real state on this feed, and the fill model needs to see it as
   * "volume unreadable" rather than as zero traded.
   */
  async getOptionTapeSample(
    symbol: string,
    expiration: string,
    optionSymbol: string,
  ): Promise<{
    bid: number | null;
    ask: number | null;
    last: number | null;
    volume: number | null;
    openInterest: number | null;
    lastTradeMs: number | null;
  } | null> {
    if (!this.client) return null;
    if (this.isBreakerOpen()) return null;
    const upper = symbol.trim().toUpperCase();
    let chain: OptionChainRow[];
    try {
      chain = await this.fetchChain(upper, expiration);
    } catch (err) {
      this.tripBreaker(`getChainSnapshot(${upper},${expiration}) failed`, err);
      return null;
    }
    const row = chain.find((r) => r.optionSymbol === optionSymbol);
    if (!row) return null;
    const num = (v: number | undefined, requirePositive = true): number | null =>
      typeof v === 'number' && Number.isFinite(v) && (requirePositive ? v > 0 : v >= 0) ? v : null;
    return {
      bid: num(row.bid),
      ask: num(row.ask),
      last: num(row.last),
      // Volume and OI are legitimately ZERO on a live contract — a zero here is
      // a measurement, not an absence, so they do not require positivity.
      volume: num(row.volume, false),
      openInterest: num(row.openInterest, false),
      // TRA-4893 item 4 — the second print tell. Positivity IS required: a zero
      // last-trade stamp is an absent clock, and treating it as epoch 0 would
      // make the very next poll look like an advancing clock and manufacture a
      // print that never happened.
      lastTradeMs: num(row.lastTradeMs),
    };
  }

  // TRA-3502 — the reason-carrying form. `getOptionQuote` below is now a projection
  // of THIS, so the usability predicate (`bid > 0 && ask > 0 && ask >= bid`) exists
  // exactly once and the counter's `one_sided` bucket can never disagree with what
  // the maker chase treats as unusable.
  //
  // A thrown fetch trips the breaker and reports `breaker_open` rather than `absent`:
  // an outage is not an empty book, and the whole point of the split is that a
  // fallback rate driven by scanner outages demands a different fix than one driven
  // by genuinely illiquid contracts.
  async getOptionQuoteDetail(
    symbol: string,
    expiration: string,
    optionSymbol: string,
  ): Promise<OptionQuoteResolution> {
    if (!this.client) return { status: 'no_client' };
    if (this.isBreakerOpen()) return { status: 'breaker_open' };
    const upper = symbol.trim().toUpperCase();
    let chain: OptionChainRow[];
    try {
      chain = await this.fetchChain(upper, expiration);
    } catch (err) {
      this.tripBreaker(`getChainSnapshot(${upper},${expiration}) failed`, err);
      return { status: 'breaker_open' };
    }
    const row = chain.find((r) => r.optionSymbol === optionSymbol);
    if (!row) return { status: 'absent' };
    const bid = row.bid ?? 0;
    const ask = row.ask ?? 0;
    // Two-sided and sane, or nothing. A one-sided book gives a maker chase no
    // midpoint to rest against, and `last` is a print, not a resting price.
    if (bid > 0 && ask > 0 && ask >= bid) return { status: 'quoted', bid, ask };
    // Echo whichever side WAS there (null for the missing/invalid one) so the
    // half-empty book is visible as data. A crossed book (`ask < bid`) lands here
    // too, with both sides echoed — it is unusable, not absent.
    return {
      status: 'one_sided',
      bid: row.bid != null && row.bid >= 0 ? row.bid : null,
      ask: row.ask != null && row.ask > 0 ? row.ask : null,
    };
  }

  async getOptionQuote(
    symbol: string,
    expiration: string,
    optionSymbol: string,
  ): Promise<{ bid: number; ask: number } | null> {
    const detail = await this.getOptionQuoteDetail(symbol, expiration, optionSymbol);
    return detail.status === 'quoted' ? { bid: detail.bid, ask: detail.ask } : null;
  }

  private isBreakerOpen(): boolean {
    if (this.breakerState == null) return false;
    if (this.now() - this.breakerState.openedAt >= this.breakerState.cooldownMs) {
      this.breakerState = null;
      return false;
    }
    return true;
  }

  private tripBreaker(label: string, err: unknown): void {
    const now = this.now();
    const msg = err instanceof Error ? err.message : String(err);
    // TRA-4664 — a non-429 4xx is a refusal of THIS request (bad symbol/params),
    // not an upstream outage: it must not black out every other symbol's scan.
    if (
      err instanceof TradierHttpRefusalError &&
      err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 429
    ) {
      // TRA-5005 — a quota HOLD is our own suppression, not an upstream event, and
      // it fires on every suppressed key for the length of the hold. Logging it at
      // `warn` would put the gate's whole suppression volume (the old surface
      // counted 907,095 local re-throws) into the warn stream. The counters in
      // `quotaHold` are the attributable record; the `warn` is reserved for the
      // single arming event in `armQuotaHold`.
      if (err instanceof TradierQuotaHoldError) {
        log.debug('upstream call skipped (account quota hold)', {
          label, heldUntilMs: err.heldUntilMs, reason: msg,
        });
        return;
      }
      log.warn('upstream request refused (breaker not tripped)', { label, reason: msg });
      return;
    }
    if (is429Error(err)) {
      if (this.last429AtMs != null && now - this.last429AtMs <= BACKOFF_429_WINDOW_MS) {
        this.consecutive429 += 1;
      } else {
        this.consecutive429 = 1;
      }
      this.last429AtMs = now;
      const cooldownMs = Math.min(
        RATE_LIMIT_429_COOLDOWN_MS * 2 ** (this.consecutive429 - 1),
        BACKOFF_429_MAX_MS,
      );
      this.breakerState = { openedAt: now, cooldownMs };
      log.warn('breaker open (rate limit)', {
        cooldownSeconds: Math.round(cooldownMs / 1000),
        consecutive429: this.consecutive429,
        label,
        reason: msg,
      });
    } else {
      this.breakerState = { openedAt: now, cooldownMs: UPSTREAM_ERROR_COOLDOWN_MS };
      log.warn('breaker open (upstream error)', {
        cooldownSeconds: Math.round(UPSTREAM_ERROR_COOLDOWN_MS / 1000),
        label,
        reason: msg,
      });
    }
  }

  /**
   * Reset the consecutive-429 counter when an upstream call returns without
   * throwing. Cache hits do not call this (no network traffic = no fresh
   * signal about the rate-limit bucket).
   */
  private noteUpstreamSuccess(): void {
    if (this.consecutive429 !== 0) {
      this.consecutive429 = 0;
      this.last429AtMs = null;
    }
  }

  /**
   * TRA-943 — insert into a TTL cache while keeping its retained working set
   * bounded. On every write we (1) drop the key first so a refresh re-inserts at
   * the tail (Map preserves insertion order, so the tail is the most-recently
   * written), (2) sweep out every entry already past its TTL — a stale snapshot
   * is never served again (`fetchChain`/`pickExpiration` re-fetch on a miss), so
   * retaining it only wastes heap, and (3) if still over the hard cap, evict
   * oldest-inserted first until we fit. The result: the cache holds at most
   * `maxEntries` live snapshots no matter how many distinct keys are scanned over
   * the process lifetime, which is what bounds the per-tick option-shadow
   * footprint (TRA-937).
   */
  private putBounded<K extends string, T>(
    cache: Map<K, CacheEntry<T>>,
    key: K,
    value: T,
    ttlMs: number,
    maxEntries: number,
    counters?: CacheCounters,
  ): void {
    const now = this.now();
    cache.delete(key);
    for (const [k, entry] of cache) {
      if (now - entry.at >= ttlMs) cache.delete(k);
    }
    cache.set(key, { value, at: now });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
      // Every entry still here survived the TTL sweep above, so this one was
      // evicted LIVE — the cap, not the clock, threw it away (TRA-4664).
      if (counters) counters.capacityEvictions += 1;
    }
  }

  /**
   * TRA-5006 — record that `key` was DEMANDED of a cache, for the payload-free
   * demand shadow behind {@link CacheDemand}.
   *
   * Called on every read of the key, before any gate — a key suppressed by the
   * quota hold or a per-key cooldown is still part of the keyspace the cache has
   * to cover, and excluding it would shrink the measured demand by exactly the
   * population a quota storm creates, i.e. understate the cap in the one regime
   * where the cap matters.
   *
   * `delete` before `set` keeps the Map in ascending-`lastReadAt` order, so the
   * TTL sweep can stop at the first live entry instead of walking the whole map
   * (`putBounded` does walk it, which is affordable at a 2048 cap and would not
   * be here). The cap evicts oldest and DISCLOSES, never silently.
   */
  private noteKeyDemand(
    demand: Map<string, number>,
    state: DemandState,
    key: string,
    ttlMs: number,
  ): void {
    const now = this.now();
    demand.delete(key);
    for (const [k, at] of demand) {
      if (now - at < ttlMs) break;
      demand.delete(k);
    }
    demand.set(key, now);
    while (demand.size > MAX_CACHE_DEMAND_ENTRIES) {
      const oldest = demand.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      demand.delete(oldest);
      state.truncated = true;
    }
    if (demand.size > state.peak) state.peak = demand.size;
    if (state.seen.size < MAX_CACHE_DEMAND_ENTRIES) state.seen.add(key);
    else if (!state.seen.has(key)) state.truncated = true;
  }

  /**
   * TRA-5006 — read one demand shadow. Read-only by the TRA-4664 third-pass
   * rule: it does NOT sweep the expired entries it filters out, so a health poll
   * cannot change what the next poll sees. `liveDemand` is therefore computed by
   * filtering on the clock, not by trusting `demand.size`.
   */
  private cacheDemandCensus(
    demand: Map<string, number>,
    state: DemandState,
    ttlMs: number,
    maxEntries: number,
  ): CacheDemand {
    const now = this.now();
    let liveDemand = 0;
    for (const at of demand.values()) {
      if (now - at < ttlMs) liveDemand += 1;
    }
    const liveDemandPeak = Math.max(state.peak, liveDemand);
    return {
      liveDemand,
      liveDemandPeak,
      distinctKeys: state.seen.size,
      maxEntries,
      capBinds: liveDemandPeak > maxEntries,
      truncated: state.truncated,
    };
  }

  /** TRA-4664 — record a Tradier HTTP refusal and raise it on the throw path. */
  private refuse(
    endpoint: 'expirations' | 'chain',
    httpStatus: number,
    detail: string,
    reason?: string | null,
  ): never {
    const key = String(httpStatus);
    this.refusalsByStatus[key] = (this.refusalsByStatus[key] ?? 0) + 1;
    this.lastRefusalAtMs = this.now();
    this.lastRefusalStatus = httpStatus;
    this.noteRefusalReason(httpStatus, reason);
    // TRA-5005 — the fork. `isQuotaViolationReason` is the discriminator the
    // TRA-4865 `byReason` histogram was built to produce, now consumed: an
    // ACCOUNT-level quota violation arms ONE global, vendor-dated gate, while a
    // genuinely per-key 4xx keeps the per-key cooldown below unchanged.
    const quota = isQuotaViolationReason(reason);
    const err = new TradierHttpRefusalError(endpoint, httpStatus, detail, quota);
    if (quota) {
      this.armQuotaHold(reason);
    } else if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
      // TRA-4664 (second pass) — a non-429 4xx refuses this KEY, and Tradier will
      // refuse it identically next cycle: stop asking for a cooldown period.
      // 429/5xx stay out — the breaker/backoff owns vendor-wide states, and a
      // per-key cooldown would outlive the vendor's recovery.
      //
      // TRA-5005 — and a quota violation stays out too, for the mirror-image
      // reason: it is a vendor-wide (account-wide) state wearing a 400, so a
      // per-key cooldown both named the wrong subject and outlived the vendor's
      // recovery by ~10x. It takes the gate above instead.
      this.putBounded(
        this.refusalCooldown,
        `${endpoint}|${detail}`,
        err,
        REFUSAL_4XX_COOLDOWN_MS,
        MAX_REFUSAL_COOLDOWN_ENTRIES,
      );
      this.noteRefusedKeySinceBoot(`${endpoint}|${detail}`);
    }
    throw err;
  }

  /**
   * TRA-4664 (second pass) — re-raise a still-cooling refusal without an
   * upstream call. The re-thrown error is the original refusal, so callers see
   * exactly what a live refusal produces (`fetch_error`, breaker untouched).
   */
  private throwIfCooling(endpoint: 'expirations' | 'chain', detail: string): void {
    const entry = this.refusalCooldown.get(`${endpoint}|${detail}`);
    if (!entry) return;
    if (this.now() - entry.at >= REFUSAL_4XX_COOLDOWN_MS) {
      this.refusalCooldown.delete(`${endpoint}|${detail}`);
      return;
    }
    this.suppressedRefusals += 1;
    throw entry.value;
  }

  private async pickExpiration(symbol: string, dtePrefs: DtePrefs = {}): Promise<string | null> {
    const windowed = await this.resolveWindowedExpirations(symbol, dtePrefs);
    if (!windowed || windowed.inWindow.length === 0) return null;

    // Pick the expiration closest to `target`. On ties (equal absolute
    // distance) prefer the earlier expiration — matches the spec example
    // (target=35; 30d and 45d both 5d off → pick 30d) and biases sizing
    // toward shorter dated, less theta-sensitive contracts.
    const byTarget = [...windowed.inWindow].sort((a, b) => {
      const da = Math.abs(a.ms - windowed.targetMs);
      const db = Math.abs(b.ms - windowed.targetMs);
      if (da !== db) return da - db;
      return a.ms - b.ms;
    });
    return byTarget[0]!.d;
  }

  /**
   * TRA-4413 item 4 — the DTE-window resolution `pickExpiration` has always
   * performed, extracted so the term-structure scan can read the WHOLE
   * in-window list instead of the single target-nearest pick. Same cache,
   * same coercion rules, same window arithmetic; `pickExpiration`'s selection
   * semantics are unchanged (its target-distance sort now runs on a copy).
   * Returns the in-window expirations ASCENDING by date.
   */
  private async resolveWindowedExpirations(
    symbol: string,
    dtePrefs: DtePrefs = {},
  ): Promise<{ inWindow: Array<{ d: string; ms: number }>; targetMs: number } | null> {
    // TRA-5006 — demand is noted for every read, hit or miss, and before the
    // gates below. See `noteKeyDemand`.
    this.noteKeyDemand(
      this.expirationsDemand,
      this.expirationsDemandState,
      symbol,
      EXPIRATIONS_CACHE_TTL_MS,
    );
    const cached = this.expirationsCache.get(symbol);
    let expirations: string[];
    if (cached && this.now() - cached.at < EXPIRATIONS_CACHE_TTL_MS) {
      this.expirationsCounters.hits += 1;
      expirations = cached.value;
    } else {
      this.expirationsCounters.misses += 1;
      // TRA-4664 — the status-preserving read. `getExpirations` collapses a 429
      // into `[]`, which this method used to cache for SIX HOURS and report as
      // `no_expirations` — a quota blip poisoning the symbol until the size cap
      // happened to evict it. A refusal now throws: never cached, and the
      // caller's catch trips the breaker and reports `fetch_error`.
      // TRA-5005 — the account-scoped gate runs FIRST: a quota violation is not a
      // property of this key, so there is no point asking a per-key map about it.
      this.throwIfQuotaHeld('expirations', symbol);
      this.throwIfCooling('expirations', symbol);
      this.spendChainBudget('expirations', symbol);
      const client = this.client!;
      if (typeof client.fetchExpirations === 'function') {
        const r = await client.fetchExpirations(symbol);
        if (!r.ok) this.refuse('expirations', r.httpStatus, symbol, r.reason);
        expirations = r.value;
      } else {
        expirations = await client.getExpirations(symbol);
      }
      this.noteUpstreamSuccess();
      this.putBounded(
        this.expirationsCache,
        symbol,
        expirations,
        EXPIRATIONS_CACHE_TTL_MS,
        MAX_EXPIRATIONS_CACHE_ENTRIES,
        this.expirationsCounters,
      );
    }
    if (expirations.length === 0) return null;

    // TRA-373 — per-call overrides win, then service defaults, then spec
    // constants. Coerce non-finite/non-positive to the defaults so a fat-
    // finger settings save can't disable the scanner; flip min/max back to
    // defaults if the caller swapped them.
    let min =
      Number.isFinite(dtePrefs.min) && (dtePrefs.min as number) > 0
        ? (dtePrefs.min as number)
        : this.defaultDteMin;
    let max =
      Number.isFinite(dtePrefs.max) && (dtePrefs.max as number) > 0
        ? (dtePrefs.max as number)
        : this.defaultDteMax;
    if (max < min) {
      min = this.defaultDteMin;
      max = this.defaultDteMax;
    }
    let target =
      Number.isFinite(dtePrefs.target) && (dtePrefs.target as number) > 0
        ? (dtePrefs.target as number)
        : this.defaultDteTarget;
    if (target < min) target = min;
    if (target > max) target = max;

    const now = this.now();
    const minMs = now + min * 24 * 60 * 60_000;
    const maxMs = now + max * 24 * 60 * 60_000;
    const targetMs = now + target * 24 * 60 * 60_000;

    const inWindow = expirations
      .map((d) => ({ d, ms: Date.parse(`${d}T00:00:00Z`) }))
      .filter((e) => Number.isFinite(e.ms) && e.ms >= minMs && e.ms <= maxMs)
      .sort((a, b) => a.ms - b.ms);
    return { inWindow, targetMs };
  }

  private async fetchChain(symbol: string, expiration: string): Promise<OptionChainRow[]> {
    const key: ChainKey = `${symbol}|${expiration}`;
    // TRA-5006 — see `resolveWindowedExpirations`; same contract, chain TTL.
    this.noteKeyDemand(this.chainDemand, this.chainDemandState, key, CHAIN_CACHE_TTL_MS);
    const cached = this.chainCache.get(key);
    if (cached && this.now() - cached.at < CHAIN_CACHE_TTL_MS) {
      this.chainCounters.hits += 1;
      return cached.value;
    }
    this.chainCounters.misses += 1;
    // TRA-4664 — same as `resolveWindowedExpirations`: a refusal was `[]`,
    // cached for the chain TTL and reported as `no_chain`. Now it throws.
    // TRA-5005 — see `resolveWindowedExpirations`: global gate before per-key.
    this.throwIfQuotaHeld('chain', `${symbol},${expiration}`);
    this.throwIfCooling('chain', `${symbol},${expiration}`);
    this.spendChainBudget('chain', `${symbol},${expiration}`);
    const client = this.client!;
    let rows: OptionChainRow[];
    if (typeof client.fetchChainSnapshot === 'function') {
      const r = await client.fetchChainSnapshot(symbol, expiration);
      if (!r.ok) this.refuse('chain', r.httpStatus, `${symbol},${expiration}`, r.reason);
      rows = r.value;
    } else {
      rows = await client.getChainSnapshot(symbol, expiration);
    }
    this.noteUpstreamSuccess();
    this.putBounded(
      this.chainCache, key, rows, CHAIN_CACHE_TTL_MS, MAX_CHAIN_CACHE_ENTRIES, this.chainCounters,
    );
    return rows;
  }
}
