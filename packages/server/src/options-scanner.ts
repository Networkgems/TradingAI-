import {
  TradierOptionsClient,
  findMispricedOtmContracts,
  type OptionChainRow,
  type OtmMispricingCandidate,
  type OtmScannerOptions,
} from '@trading-app/engine';

const CHAIN_CACHE_TTL_MS = 60_000;          // 1 min — chain snapshots stale that fast anyway
const EXPIRATIONS_CACHE_TTL_MS = 6 * 60 * 60_000; // 6h — expirations don't move during the day
const RATE_LIMIT_COOLDOWN_MS = 60 * 60_000; // 1h — Tradier sandbox: 60 req/min, prod: 120/min
// TRA-373 — widened from 14–35 to 21–60 with a 35-day target; see the matching
// note in relative-value-scanner.ts. The OTM service is no longer wired into
// the live signal-engine path (TRA-191 left RV as the only enabled scanner),
// but its DTE window stays aligned with RV so revivals don't reintroduce the
// month-end-only-firing bug.
const MIN_DTE_DAYS = 21;
const MAX_DTE_DAYS = 60;
const TARGET_DTE_DAYS = 35;

export interface DtePrefs {
  min?: number;
  max?: number;
  target?: number;
}

type ChainKey = `${string}|${string}`; // `${symbol}|${expiration}`

interface CacheEntry<T> {
  value: T;
  at: number;
}

export interface OtmMispricingService {
  /**
   * TRA-373 — `dtePrefs` overrides the expiration window per-call (per-user
   * `AccountSettings.rvDte{Min,Max,Target}` flow through the shared service
   * singleton). Absent fields fall back to the service's constructor
   * defaults, then to the spec constants (21 / 60 / 35).
   */
  scan(
    symbol: string,
    opts?: OtmScannerOptions,
    dtePrefs?: DtePrefs,
  ): Promise<OtmMispricingScanResult>;
  /**
   * Look up the current mid (per-share mark) for an option contract belonging
   * to `symbol`'s `expiration` chain. Reads from the same 60s-cached chain
   * snapshot used by `scan()` so a refresh on a symbol with an open OTM
   * position costs zero extra Tradier calls when the cache is warm.
   * Returns `null` when the contract is not in the cached snapshot or the
   * chain row has no usable bid/ask.
   */
  getOptionMark(
    symbol: string,
    expiration: string,
    optionSymbol: string,
  ): Promise<number | null>;
  diagnostics(): OtmMispricingDiagnostics;
}

export interface OtmMispricingScanResult {
  symbol: string;
  spot: number | null;
  expiration: string | null;
  candidates: OtmMispricingCandidate[];
  /** Why a scan returned an empty list — useful for debugging the data path. */
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

export interface OtmMispricingDiagnostics {
  configured: boolean;
  breakerOpen: boolean;
  breakerOpenedAtMs: number | null;
  cacheSize: number;
  expirationsCacheSize: number;
}

export interface OtmMispricingServiceConfig {
  tradierApiToken?: string;
  tradierAccountId?: string;
  tradierEnv?: 'sandbox' | 'production';
  /**
   * Resolves the underlying spot price for a symbol. Server callers wire this to
   * the existing equity quote pipeline (Yahoo + fallbacks); tests inject a stub.
   */
  fetchSpot: (symbol: string) => Promise<number | null>;
  /** Test seam — defaults to constructing a real `TradierOptionsClient`. */
  clientFactory?: (token: string, accountId: string, env: 'sandbox' | 'production') => TradierOptionsClient;
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
 * Server-side wrapper around `findMispricedOtmContracts` that adds:
 *
 *   • Chain-snapshot caching (60 s TTL) — Tradier's free tier is rate-limited so
 *     repeated scans of the same symbol within a minute serve from cache.
 *   • Circuit breaker on transient errors — once a fetch throws (typically a 429
 *     or upstream outage), the breaker opens for 1 h so we don't spam the API.
 *   • Expiration auto-pick — closest-to-target inside the configured DTE
 *     window (default 21–60d, target 35d, TRA-373). Per-call overrides on
 *     `scan()` carry per-user `AccountSettings.rvDte*` knobs through.
 *
 * Pure data layer. Does not place trades and does not modify any account state —
 * downstream signal/account integration tracks via child issues of TRA-158.
 */
export class TradierOtmMispricingService implements OtmMispricingService {
  private readonly client: TradierOptionsClient | null;
  private readonly fetchSpot: (symbol: string) => Promise<number | null>;
  private readonly now: () => number;
  private readonly defaultDteMin: number;
  private readonly defaultDteMax: number;
  private readonly defaultDteTarget: number;

  private readonly chainCache = new Map<ChainKey, CacheEntry<OptionChainRow[]>>();
  private readonly expirationsCache = new Map<string, CacheEntry<string[]>>();
  private breakerOpenedAtMs: number | null = null;

  constructor(config: OtmMispricingServiceConfig) {
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

  diagnostics(): OtmMispricingDiagnostics {
    return {
      configured: this.client !== null,
      breakerOpen: this.isBreakerOpen(),
      breakerOpenedAtMs: this.breakerOpenedAtMs,
      cacheSize: this.chainCache.size,
      expirationsCacheSize: this.expirationsCache.size,
    };
  }

  async scan(
    symbol: string,
    opts: OtmScannerOptions = {},
    dtePrefs: DtePrefs = {},
  ): Promise<OtmMispricingScanResult> {
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

    const candidates = findMispricedOtmContracts(chain, spot, { now: this.now(), ...opts });
    return { symbol: upper, spot, expiration, candidates, reason: 'ok' };
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
    if (this.breakerOpenedAtMs == null) return false;
    if (this.now() - this.breakerOpenedAtMs >= RATE_LIMIT_COOLDOWN_MS) {
      this.breakerOpenedAtMs = null;
      return false;
    }
    return true;
  }

  private tripBreaker(label: string, err: unknown): void {
    this.breakerOpenedAtMs = this.now();
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[options-scanner] breaker open ${RATE_LIMIT_COOLDOWN_MS / 60_000}m: ${label}: ${msg}`);
  }

  private async pickExpiration(symbol: string, dtePrefs: DtePrefs = {}): Promise<string | null> {
    const cached = this.expirationsCache.get(symbol);
    let expirations: string[];
    if (cached && this.now() - cached.at < EXPIRATIONS_CACHE_TTL_MS) {
      expirations = cached.value;
    } else {
      expirations = await this.client!.getExpirations(symbol);
      this.expirationsCache.set(symbol, { value: expirations, at: this.now() });
    }
    if (expirations.length === 0) return null;

    // TRA-373 — per-call overrides win, then service defaults, then spec
    // constants. See the matching block in relative-value-scanner.ts.
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

    // Closest-to-target; on ties prefer the earlier expiration (less theta).
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
    this.chainCache.set(key, { value: rows, at: this.now() });
    return rows;
  }
}
