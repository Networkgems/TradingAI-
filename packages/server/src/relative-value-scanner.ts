import {
  TradierOptionsClient,
  findRelativeValueOpportunities,
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
 */
export const CHAIN_CACHE_TTL_MS = 60_000;
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
const MAX_CHAIN_CACHE_ENTRIES = 256;
const MAX_EXPIRATIONS_CACHE_ENTRIES = 256;
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
export const REFUSAL_4XX_COOLDOWN_MS = 10 * 60_000;
const MAX_REFUSAL_COOLDOWN_ENTRIES = 1024;

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
    | 'fetch_error';
  errorMessage?: string;
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
   * TRA-4664 — Tradier HTTP refusals (429/5xx/401) seen by this scanner, keyed
   * by HTTP status. Before TRA-4664 the client collapsed these into `[]`, which
   * the scanner reported as `no_expirations`/`no_chain` and CACHED (6h for
   * expirations). Absent key ≠ zero: an older build omits the whole object.
   */
  upstreamRefusals?: { byStatus: Record<string, number>; lastAtMs: number | null; lastStatus: number | null };
  /**
   * TRA-4664 (second pass) — the non-429-4xx per-key refusal cooldown.
   * `size` = keys currently under cooldown; `suppressed` = upstream calls NOT
   * made because the key was cooling (process-lifetime). `upstreamRefusals`
   * counts only real upstream responses, so the true refusal pressure is
   * `byStatus[4xx] + suppressed`.
   */
  refusalCooldown?: { size: number; suppressed: number };
}

export interface CacheCounters {
  hits: number;
  misses: number;
  /** Entries evicted by the size cap while still inside their TTL. */
  capacityEvictions: number;
}

/**
 * TRA-4664 — a Tradier HTTP refusal, raised by the scanner so the refusal takes
 * the THROW path (breaker, `fetch_error`, never cached) instead of being read as
 * an empty listing. The message carries the status, so `is429Error` matches a
 * rate-limit refusal and the TRA-417 429 backoff finally engages.
 */
export class TradierHttpRefusalError extends Error {
  constructor(readonly endpoint: 'expirations' | 'chain', readonly httpStatus: number, detail: string) {
    super(`Tradier ${endpoint} HTTP ${httpStatus} (${detail})`);
    this.name = 'TradierHttpRefusalError';
  }
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
  private readonly refusalsByStatus: Record<string, number> = {};
  private lastRefusalAtMs: number | null = null;
  private lastRefusalStatus: number | null = null;
  // TRA-4664 (second pass) — see `RelativeValueScannerDiagnostics.refusalCooldown`.
  // Key shapes match the caches: `expirations|SYM` and `chain|SYM|EXPIRATION`.
  private readonly refusalCooldown = new Map<string, CacheEntry<TradierHttpRefusalError>>();
  private suppressedRefusals = 0;

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
  }

  diagnostics(): RelativeValueScannerDiagnostics {
    return {
      configured: this.client !== null,
      breakerOpen: this.isBreakerOpen(),
      breakerOpenedAtMs: this.breakerState?.openedAt ?? null,
      cacheSize: this.chainCache.size,
      expirationsCacheSize: this.expirationsCache.size,
      chainCacheMaxEntries: MAX_CHAIN_CACHE_ENTRIES,
      expirationsCacheMaxEntries: MAX_EXPIRATIONS_CACHE_ENTRIES,
      chainCache: { ...this.chainCounters },
      expirationsCache: { ...this.expirationsCounters },
      upstreamRefusals: {
        byStatus: { ...this.refusalsByStatus },
        lastAtMs: this.lastRefusalAtMs,
        lastStatus: this.lastRefusalStatus,
      },
      refusalCooldown: { size: this.refusalCooldown.size, suppressed: this.suppressedRefusals },
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
        reason: 'fetch_error', errorMessage: err instanceof Error ? err.message : String(err),
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
        reason: 'fetch_error', errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    if (chain.length === 0) {
      return { symbol: upper, spot, expiration, candidates: [], reason: 'no_chain' };
    }

    const candidates = findRelativeValueOpportunities(chain, spot, { now: this.now(), ...opts });
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
    const candidates = findMispricedOtmContracts(snap.rows, snap.spot, { now: this.now(), ...opts });
    return { symbol: snap.symbol, spot: snap.spot, expiration: snap.expiration, candidates, reason: 'ok' };
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
      return fail('fetch_error', spot, err instanceof Error ? err.message : String(err));
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
        return fail('fetch_error', spot, err instanceof Error ? err.message : String(err));
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
        reason: 'fetch_error',
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
        reason: 'fetch_error',
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

  /** TRA-4664 — record a Tradier HTTP refusal and raise it on the throw path. */
  private refuse(endpoint: 'expirations' | 'chain', httpStatus: number, detail: string): never {
    const key = String(httpStatus);
    this.refusalsByStatus[key] = (this.refusalsByStatus[key] ?? 0) + 1;
    this.lastRefusalAtMs = this.now();
    this.lastRefusalStatus = httpStatus;
    const err = new TradierHttpRefusalError(endpoint, httpStatus, detail);
    // TRA-4664 (second pass) — a non-429 4xx refuses this KEY, and Tradier will
    // refuse it identically next cycle: stop asking for a cooldown period.
    // 429/5xx stay out — the breaker/backoff owns vendor-wide states, and a
    // per-key cooldown would outlive the vendor's recovery.
    if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
      this.putBounded(
        this.refusalCooldown,
        `${endpoint}|${detail}`,
        err,
        REFUSAL_4XX_COOLDOWN_MS,
        MAX_REFUSAL_COOLDOWN_ENTRIES,
      );
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
      this.throwIfCooling('expirations', symbol);
      const client = this.client!;
      if (typeof client.fetchExpirations === 'function') {
        const r = await client.fetchExpirations(symbol);
        if (!r.ok) this.refuse('expirations', r.httpStatus, symbol);
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
    const cached = this.chainCache.get(key);
    if (cached && this.now() - cached.at < CHAIN_CACHE_TTL_MS) {
      this.chainCounters.hits += 1;
      return cached.value;
    }
    this.chainCounters.misses += 1;
    // TRA-4664 — same as `resolveWindowedExpirations`: a refusal was `[]`,
    // cached for the chain TTL and reported as `no_chain`. Now it throws.
    this.throwIfCooling('chain', `${symbol},${expiration}`);
    const client = this.client!;
    let rows: OptionChainRow[];
    if (typeof client.fetchChainSnapshot === 'function') {
      const r = await client.fetchChainSnapshot(symbol, expiration);
      if (!r.ok) this.refuse('chain', r.httpStatus, `${symbol},${expiration}`);
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
