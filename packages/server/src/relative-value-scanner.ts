import {
  TradierOptionsClient,
  findRelativeValueOpportunities,
  findMispricedOtmContracts,
  type OptionChainRow,
  type RelativeValueCandidate,
  type OtmMispricingCandidate,
  type OtmScannerOptions,
  type RelativeValueScannerOptions,
} from '@trading-app/engine';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'relative-value-scanner' });

const CHAIN_CACHE_TTL_MS = 60_000;
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
const MAX_CHAIN_CACHE_ENTRIES = 64;
const MAX_EXPIRATIONS_CACHE_ENTRIES = 64;
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
const RATE_LIMIT_429_COOLDOWN_MS = 90_000;
const UPSTREAM_ERROR_COOLDOWN_MS = 5 * 60_000;
const BACKOFF_429_WINDOW_MS = 5 * 60_000;
const BACKOFF_429_MAX_MS = 10 * 60_000;

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
  reason?: 'ok' | 'unavailable';
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
   * Tradier load beyond what a same-symbol RV scan would. Returns
   * `reason: 'unavailable'` (empty candidates) when uncredentialed, the breaker
   * is open, or spot / expiration / chain can't be resolved. Never trades.
   */
  scanOtm(
    symbol: string,
    opts?: OtmScannerOptions,
    dtePrefs?: DtePrefs,
  ): Promise<OtmMispricingScanResult>;
  /**
   * Look up the current per-share mark for a contract belonging to `symbol`'s
   * `expiration` chain. Reads from the same cached snapshot used by `scan()`
   * so refreshing exits on an open RV position costs zero extra Tradier calls
   * when the cache is warm. Returns `null` for unknown contracts or rows
   * lacking usable bid/ask.
   */
  getOptionMark(symbol: string, expiration: string, optionSymbol: string): Promise<number | null>;
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
    const snap = await this.getSelectorChain(upper, dtePrefs);
    if (!snap) {
      return { symbol: upper, spot: null, expiration: null, candidates: [], reason: 'unavailable' };
    }
    const candidates = findMispricedOtmContracts(snap.rows, snap.spot, { now: this.now(), ...opts });
    return { symbol: snap.symbol, spot: snap.spot, expiration: snap.expiration, candidates, reason: 'ok' };
  }

  async getSelectorChain(
    symbol: string,
    dtePrefs: DtePrefs = {},
  ): Promise<SelectorChainSnapshot | null> {
    if (!this.client || this.isBreakerOpen()) return null;
    const upper = symbol.trim().toUpperCase();

    let spot: number | null;
    try {
      spot = await this.fetchSpot(upper);
    } catch {
      return null;
    }
    if (spot == null || !Number.isFinite(spot) || spot <= 0) return null;

    let expiration: string | null;
    try {
      expiration = await this.pickExpiration(upper, dtePrefs);
    } catch (err) {
      this.tripBreaker(`getExpirations(${upper}) failed`, err);
      return null;
    }
    if (!expiration) return null;

    let rows: OptionChainRow[];
    try {
      rows = await this.fetchChain(upper, expiration);
    } catch (err) {
      this.tripBreaker(`getChainSnapshot(${upper},${expiration}) failed`, err);
      return null;
    }
    if (rows.length === 0) return null;

    return { symbol: upper, spot, expiration, rows };
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
    }
  }

  private async pickExpiration(symbol: string, dtePrefs: DtePrefs = {}): Promise<string | null> {
    const cached = this.expirationsCache.get(symbol);
    let expirations: string[];
    if (cached && this.now() - cached.at < EXPIRATIONS_CACHE_TTL_MS) {
      expirations = cached.value;
    } else {
      expirations = await this.client!.getExpirations(symbol);
      this.noteUpstreamSuccess();
      this.putBounded(
        this.expirationsCache,
        symbol,
        expirations,
        EXPIRATIONS_CACHE_TTL_MS,
        MAX_EXPIRATIONS_CACHE_ENTRIES,
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
      .filter((e) => Number.isFinite(e.ms) && e.ms >= minMs && e.ms <= maxMs);
    if (inWindow.length === 0) return null;

    // Pick the expiration closest to `target`. On ties (equal absolute
    // distance) prefer the earlier expiration — matches the spec example
    // (target=35; 30d and 45d both 5d off → pick 30d) and biases sizing
    // toward shorter dated, less theta-sensitive contracts.
    inWindow.sort((a, b) => {
      const da = Math.abs(a.ms - targetMs);
      const db = Math.abs(b.ms - targetMs);
      if (da !== db) return da - db;
      return a.ms - b.ms;
    });
    return inWindow[0]!.d;
  }

  private async fetchChain(symbol: string, expiration: string): Promise<OptionChainRow[]> {
    const key: ChainKey = `${symbol}|${expiration}`;
    const cached = this.chainCache.get(key);
    if (cached && this.now() - cached.at < CHAIN_CACHE_TTL_MS) {
      return cached.value;
    }
    const rows = await this.client!.getChainSnapshot(symbol, expiration);
    this.noteUpstreamSuccess();
    this.putBounded(this.chainCache, key, rows, CHAIN_CACHE_TTL_MS, MAX_CHAIN_CACHE_ENTRIES);
    return rows;
  }
}
