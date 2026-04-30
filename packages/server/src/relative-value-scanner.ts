import {
  TradierOptionsClient,
  findRelativeValueOpportunities,
  type OptionChainRow,
  type RelativeValueCandidate,
  type RelativeValueScannerOptions,
} from '@trading-app/engine';

const CHAIN_CACHE_TTL_MS = 60_000;
const EXPIRATIONS_CACHE_TTL_MS = 6 * 60 * 60_000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const MIN_DTE_DAYS = 14;
const MAX_DTE_DAYS = 35;

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

export interface RelativeValueScannerDiagnostics {
  configured: boolean;
  breakerOpen: boolean;
  breakerOpenedAtMs: number | null;
  cacheSize: number;
  expirationsCacheSize: number;
}

export interface RelativeValueScannerService {
  scan(symbol: string, opts?: RelativeValueScannerOptions): Promise<RelativeValueScanResult>;
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
}

/**
 * Tradier-backed wrapper around `findRelativeValueOpportunities` (TRA-191).
 *
 *   • 60 s chain-snapshot cache — repeated scans of the same expiration serve
 *     from cache so we stay well under the 60/min Tradier sandbox cap.
 *   • 1 h circuit breaker — once an upstream fetch throws (typically 429 or
 *     outage), further scans short-circuit until the cooldown elapses.
 *   • Expiration auto-pick — closest weekly/monthly in the 14–35 day window,
 *     matching the existing OTM/ATM client behaviour.
 *
 * Pure data layer — does not place trades or modify any account.
 */
export class TradierRelativeValueScannerService implements RelativeValueScannerService {
  private readonly client: TradierOptionsClient | null;
  private readonly fetchSpot: (symbol: string) => Promise<number | null>;
  private readonly now: () => number;

  private readonly chainCache = new Map<ChainKey, CacheEntry<OptionChainRow[]>>();
  private readonly expirationsCache = new Map<string, CacheEntry<string[]>>();
  private breakerOpenedAtMs: number | null = null;

  constructor(config: RelativeValueScannerConfig) {
    this.fetchSpot = config.fetchSpot;
    this.now = config.now ?? Date.now;

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
      breakerOpenedAtMs: this.breakerOpenedAtMs,
      cacheSize: this.chainCache.size,
      expirationsCacheSize: this.expirationsCache.size,
    };
  }

  async scan(
    symbol: string,
    opts: RelativeValueScannerOptions = {},
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
      expiration = await this.pickExpiration(upper);
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
    console.warn(`[rv-scanner] breaker open ${RATE_LIMIT_COOLDOWN_MS / 60_000}m: ${label}: ${msg}`);
  }

  private async pickExpiration(symbol: string): Promise<string | null> {
    const cached = this.expirationsCache.get(symbol);
    let expirations: string[];
    if (cached && this.now() - cached.at < EXPIRATIONS_CACHE_TTL_MS) {
      expirations = cached.value;
    } else {
      expirations = await this.client!.getExpirations(symbol);
      this.expirationsCache.set(symbol, { value: expirations, at: this.now() });
    }
    if (expirations.length === 0) return null;

    const now = this.now();
    const minMs = now + MIN_DTE_DAYS * 24 * 60 * 60_000;
    const maxMs = now + MAX_DTE_DAYS * 24 * 60 * 60_000;

    const inWindow = expirations
      .map((d) => ({ d, ms: Date.parse(`${d}T00:00:00Z`) }))
      .filter((e) => Number.isFinite(e.ms) && e.ms >= minMs && e.ms <= maxMs)
      .sort((a, b) => a.ms - b.ms);

    return inWindow[0]?.d ?? null;
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
