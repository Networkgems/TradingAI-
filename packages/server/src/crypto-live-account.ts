import type {
  LiveSkip,
  LiveTradeRoutingCrypto,
  Position,
  PositionQuoteSource,
  SignalType,
  TradeSignal,
} from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type {
  CoinbaseOrderClient,
  CoinbaseAccountBalance,
  CoinbaseFuturesPosition,
  CoinbaseListedProduct,
  CoinbaseOrderDetails,
  CoinbaseOrderSuccessResponse,
  CoinbasePerpMetrics,
  CoinbaseProductInfo,
  ShortFilterContext,
} from '@trading-app/engine';
import {
  isPerpShortSymbol,
  perpShortRiskFraction,
  evaluateShortNotionalCaps,
  dailyShortCircuitBreakerTripped,
} from '@trading-app/engine';
import { randomUUID } from 'crypto';

import { logger } from './observability/index.js';

const log = logger.child({ module: 'crypto-live-account' });

/**
 * TRA-264 — leverage and margin mode for perp shorts opened by the engine.
 * Phase-1 caps leverage at 1× isolated so liquidation risk on a 1% adverse move
 * is essentially zero while the integration is shaken out (TRA-249 epic plan).
 */
const PERP_SHORT_LEVERAGE = 1;
const PERP_SHORT_MARGIN_TYPE = 'ISOLATED' as const;
const PERP_SHORT_POSITION_SIDE = 'SHORT' as const;

/**
 * TRA-264 — skip reason emitted when the §7 daily-short circuit breaker has
 * tripped. Distinct from the §6 cap strings so the dashboard can group them
 * separately. Stamped on `signal.signalSkipReason` (strategy-side gate, not a
 * broker reject).
 */
const SKIP_DAILY_SHORT_CIRCUIT_BREAKER = 'daily short circuit breaker tripped';

/** Stable currencies treated 1:1 with USD when computing equity. */
const CASH_CURRENCIES = new Set(['USD', 'USDC', 'USDT']);
const BALANCE_REFRESH_MS = 30_000;

/**
 * TRA-285 — how fresh the Coinbase cash balance must be before we send a live
 * order. The dashboard refresh runs every 30s, but Coinbase can rebalance
 * `available_balance` mid-window (a separate Coinbase app fill, a hold from
 * another order, an internal funding move). When we relied on the 30s cache
 * we'd occasionally size a buy against cash that no longer existed and eat
 * `INSUFFICIENT_FUND` from Coinbase. 5s is short enough to catch fast-moving
 * holds while letting back-to-back signals in the same tick reuse the read
 * (≤30 watchlist symbols × 1 GET each would otherwise hammer /accounts).
 */
const BALANCE_PREFLIGHT_MAX_AGE_MS = 5_000;

/**
 * How long a cached set of Coinbase-tradable product_ids stays fresh before we
 * re-query Coinbase. Six hours is the right scale: Coinbase delistings/renames
 * (MATIC→POL, FTM→Sonic, etc.) happen on day-or-longer timelines, but we don't
 * want a stale snapshot to keep us trading a delisted ticker for weeks if the
 * server is long-lived. Refresh is cheap (one /products call) and tolerant —
 * a failure leaves the previous set in place rather than zeroing it (TRA-243).
 */
const TRADABLE_PRODUCTS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Floor `qty` to a multiple of Coinbase's per-product `base_increment` so the
 * resulting number, once stringified, never carries more decimals than Coinbase
 * accepts. Always rounds DOWN so the cash cap the caller already enforced is
 * never violated. Returns 0 when qty is smaller than a single step, which the
 * caller's `qty <= 0` skip path treats as "no spendable size".
 *
 * `incrementStr` is the canonical `base_increment` string straight from
 * `/products` (e.g. `"0.00000001"`, `"0.0001"`, `"1"`). We parse it twice:
 * once as a float to do the math, and once as a string to derive the exact
 * decimal count — `log10`-based decimal-count would mishandle padded forms
 * like `"0.10000000"` that JSON-decode to `0.1`.
 *
 * Implementation note: we work in integer-scaled space so that classic float
 * artefacts (`12.7 / 0.1 === 126.99999999999999`) don't cause us to floor a
 * value down by one increment. The 1e-9 epsilon absorbs precision loss on
 * `qty * scale` without ever rounding qty up past its true value (Coinbase
 * increments bottom out at 1e-8, so 1e-9 is safely below user-visible scale).
 *
 * Exported for unit tests; tied to TRA-243 ("Too many decimals in order amount").
 */
export function quantizeBaseSize(qty: number, incrementStr: string): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const inc = parseFloat(incrementStr);
  if (!Number.isFinite(inc) || inc <= 0) return 0;
  const trimmed = incrementStr.replace(/0+$/, '').replace(/\.$/, '');
  const dot = trimmed.indexOf('.');
  const decimals = dot === -1 ? 0 : trimmed.length - dot - 1;
  const scale = Math.pow(10, decimals);
  const scaledQty = qty * scale;
  const scaledInc = inc * scale;
  // Round scaledInc to nearest integer to absorb float artefacts on integer
  // increments (e.g. inc=1 with decimals=0 → scale=1 → scaledInc≈1).
  const intInc = Math.round(scaledInc);
  if (intInc <= 0) return 0;
  const stepped = Math.floor((scaledQty + 1e-9) / intInc) * intInc;
  return Math.round(stepped) / scale;
}

/**
 * Headroom against Coinbase Advanced Trade taker fees so a market BUY that
 * spends our entire reported `available_balance` doesn't get rejected for
 * insufficient funds at fill time. Non-stable taker is up to 0.6% — 0.5%
 * buffer absorbs that and small price drift between quote and fill (TRA-243).
 */
const CASH_FEE_BUFFER = 0.995;

/**
 * Coinbase Advanced Trade enforces a per-product minimum on the quote size of
 * a market order; for the major USD pairs this is $1. Below this we skip up
 * front rather than fire a guaranteed-reject — the SettingsPage `$1 BTC-USD`
 * smoke test uses the same floor (TRA-243).
 */
const MIN_NOTIONAL_USD = 1;

/**
 * Backoff schedule (ms) for polling `GET /orders/historical/{id}` after a
 * market IOC order succeeds. Coinbase usually fills these within tens of ms,
 * but the historical endpoint can briefly report PENDING; budget ~5s total
 * before treating the order as suspect (TRA-156).
 */
const FILL_POLL_DELAYS_MS = [0, 200, 400, 800, 1500, 2000];

const TERMINAL_FAILURE_STATUSES = new Set(['CANCELLED', 'EXPIRED', 'FAILED']);

/**
 * TRA-249-B — cap on the in-memory `LiveSkip` ring buffer. 50 entries is
 * enough to span a few minutes of strategy ticks across the watchlist (worst
 * case: every signal skips for a transient reason like cash cap) so the
 * dashboard can render a meaningful "last skips" panel without leaking
 * unbounded memory on a long-running server.
 */
const RECENT_SKIPS_CAP = 50;

/**
 * TRA-249-C — perp-catalog refresh cadence. Coinbase listings/delistings on
 * the INTX perp venue happen on day-or-longer timelines, so 1 hour is far
 * faster than the venue actually changes; the budget is dominated by the
 * single `/products?product_type=FUTURE` call. We refresh hourly rather than
 * piggybacking on the spot 6h TTL so a newly-listed perp (e.g. a fresh
 * altcoin perp launching mid-session) becomes routable within the hour
 * without waiting on a server restart.
 */
const PERP_CATALOG_TTL_MS = 60 * 60_000;

/**
 * TRA-249-C — minimum gap between INTX perp-position reconciliations triggered
 * from `refreshBalance`. 5 minutes is short enough to surface a position the
 * user opened in the Coinbase UI within one strategy-tick cycle, and long
 * enough that the every-30s balance refresh doesn't fan out into 2 extra
 * Coinbase round-trips on every call. Resolving the INTX portfolio uuid is
 * cached separately so the first hit is `listPortfolios` + `listFuturesPositions`
 * and subsequent hits are `listFuturesPositions` only.
 */
const PERP_RECONCILE_TTL_MS = 5 * 60_000;

/**
 * TRA-249-C — derive the spot symbol's base currency. Coinbase products
 * canonically use a `BASE-QUOTE` form (`BTC-USD`, `ETH-USDC`); Advanced Trade
 * perp products are `BASE-PERP-INTX` (`BTC-PERP-INTX`). The first token
 * before the first `-` is the base in both cases. Returns null on malformed
 * input so callers can route to a "no perp listed" skip rather than crash.
 */
function baseCurrency(productId: string): string | null {
  const idx = productId.indexOf('-');
  if (idx <= 0) return null;
  return productId.slice(0, idx).toUpperCase();
}

/**
 * TRA-249-C — recognise the Advanced Trade perp form `{BASE}-PERP-INTX`.
 * The `-PERP-` segment is the canonical marker on the Coinbase INTX venue;
 * spot products never carry it. Anchored on `-PERP-` rather than the
 * `-INTX` suffix so the catalog still picks up products if Coinbase ever
 * adds a second perp suffix in the future.
 */
function isPerpProductId(productId: string): boolean {
  return productId.includes('-PERP-');
}

/**
 * TRA-249-C — spot↔perp routing catalog. Owns the periodic
 * `listProducts('FUTURE')` refresh and exposes a flat
 * `getPerpFor(spotSymbol)` lookup so the SELL routing fork can resolve the
 * actual Coinbase INTX product_id (`BTC-PERP-INTX`) instead of submitting
 * the spot symbol (`BTC-USD`) to the perp endpoint and eating a 400.
 *
 * Built as a sibling of the existing tradable-products cache (TRA-243)
 * rather than fused with it on purpose: the spot cache enforces "is this
 * watchlist symbol still tradable?" via the `getProducts(productIds)` query
 * shape (silent drop for unknown ids), whereas the perp catalog needs the
 * full FUTURE catalogue listing — different endpoints, different freshness
 * needs (1h vs 6h), different failure modes.
 *
 * **Failure semantics:** a refresh that throws leaves the previous map and
 * `ready` flag intact, so a transient `/products` outage downgrades us to
 * "use stale catalog" rather than "spot-only forever". `isReady()` returns
 * `false` until the first successful refresh — first-tick callers should
 * treat the symbol as spot-only-skip if the catalog hasn't loaded yet.
 */
export class PerpCatalog {
  private perpBySpot: Map<string, string> = new Map();
  private ready = false;
  private lastRefreshAt = 0;

  /**
   * Pull the live FUTURE product catalogue from Coinbase and rebuild the
   * spot→perp map keyed by base currency. Inactive perps are already filtered
   * by the order client's `listProducts` so the catalog never points the
   * router at a halted product. Multiple perps on the same base are unlikely
   * today; the first match wins so the map stays deterministic if Coinbase
   * ever lists e.g. dated futures alongside the perpetual.
   */
  async refresh(coinbase: CoinbaseOrderClient, spotSymbols: readonly string[]): Promise<void> {
    let products: CoinbaseListedProduct[];
    try {
      products = await coinbase.listProducts('FUTURE');
    } catch (err: unknown) {
      log.warn('perp catalog refresh failed', { reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.applyProducts(products, spotSymbols);
  }

  /**
   * TRA-262 — rebuild the spot→perp map from a pre-fetched products list.
   * Factored out of {@link refresh} so a sibling caller (the live account's
   * perp-metrics refresh) can issue ONE `listProducts('FUTURE')` round-trip
   * and feed both this map and its own per-perp metrics cache without
   * doubling the Coinbase API budget.
   */
  applyProducts(products: readonly CoinbaseListedProduct[], spotSymbols: readonly string[]): void {
    const perpByBase = new Map<string, string>();
    for (const p of products) {
      if (!isPerpProductId(p.product_id)) continue;
      const base = baseCurrency(p.product_id);
      if (!base) continue;
      if (!perpByBase.has(base)) perpByBase.set(base, p.product_id);
    }
    const next = new Map<string, string>();
    for (const sym of spotSymbols) {
      const base = baseCurrency(sym);
      if (!base) continue;
      const perp = perpByBase.get(base);
      if (perp) next.set(sym, perp);
    }
    this.perpBySpot = next;
    this.ready = true;
    this.lastRefreshAt = Date.now();
  }

  getPerpFor(spotSymbol: string): string | null {
    return this.perpBySpot.get(spotSymbol) ?? null;
  }

  isReady(): boolean {
    return this.ready;
  }

  isStale(): boolean {
    return !this.ready || Date.now() - this.lastRefreshAt > PERP_CATALOG_TTL_MS;
  }

  /** Defensive snapshot of the underlying spot→perp map. Tests + diagnostics. */
  snapshot(): Map<string, string> {
    return new Map(this.perpBySpot);
  }
}

export interface CryptoLiveAccountState {
  totalEquity: number;
  availableCash: number;
  openPositions: Position[];
  dailyPnl: number;
  /**
   * TRA-249-B — most recent 50 live-broker skip events, oldest first. See
   * `LiveSkip` in `@trading-app/shared`. Surfaced via the engine state so
   * operators can diagnose silent skips without mining server logs.
   */
  recentSkips: LiveSkip[];
}

export interface CryptoLiveAccountOptions {
  /** Override sleep so tests can advance time without real timers. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * TRA-249-C — initial routing mode for SELL-side strategy signals. Defaults
   * to `'hybrid'`. The engine reapplies via {@link CryptoLiveAccount.setRoutingMode}
   * on every settings save, so the field's only purpose here is to seed
   * pre-init construction. Pass `'spot_only'` from tests to force the skip
   * branch.
   */
  routingMode?: LiveTradeRoutingCrypto;
  /**
   * TRA-249-C — inject a custom perp catalog (handy for tests that want to
   * pre-seed the spot→perp map without round-tripping through `listProducts`).
   * Production callers leave this off and let the account own its own catalog.
   */
  perpCatalog?: PerpCatalog;
}

interface ReconciledFill {
  /** Volume-weighted average fill price across all partial fills. */
  price: number;
  /** Total base size actually filled. */
  size: number;
}

/**
 * Live crypto trading account backed by a Coinbase Advanced Trade order client.
 *
 * Mirrors the surface of CryptoPaperAccount (size sizing, openPosition, checkExits,
 * closePosition, snapshot import/export) so the engine can swap implementations
 * without changing call sites. All orders are routed through Coinbase; the local
 * `positions` map is a mirror of in-flight trades that we opened in this session.
 *
 * Cash and equity are sourced from Coinbase account balances on a 30s refresh.
 * Today's P&L is tracked locally as the running sum of realized P&L on closes.
 *
 * **Failure semantics:** if Coinbase rejects an order we throw and the local
 * mirror is left untouched — the engine treats the signal as unfilled. Stale
 * positions on Coinbase that were not opened by us are intentionally NOT
 * imported (we'd risk unwinding pre-existing user holdings).
 */
export class CryptoLiveAccount {
  private readonly coinbase: CoinbaseOrderClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly positions: Map<string, Position> = new Map();
  private cashUsd = 0;
  private equityUsd = 0;
  private realizedPnlToday = 0;
  /**
   * TRA-264 — realised short P&L accumulated today. Feeds the §7 daily short
   * circuit breaker so a streak of stopped-out shorts halts new short entries
   * before the loss compounds into a full-account drawdown. Reset on UTC day
   * rollover via `rolloverDay`.
   */
  private realizedShortPnlToday = 0;
  /**
   * TRA-264 — last computed unrealised P&L summed across all open shorts, in
   * USD. Refreshed on every `checkExits` tick (the only call site with a full
   * `prices` map for every open symbol). Used by `openPosition` to feed the
   * §7 daily short circuit breaker without forcing every caller to plumb a
   * prices map. Stale by at most one tick — the realised side stays exact.
   */
  private openShortsUnrealisedPnlUsd = 0;
  private lastBalanceRefresh = 0;
  /**
   * TRA-243 — per-product metadata Coinbase Advanced Trade currently exposes
   * (price + base_increment), keyed by product_id. Two responsibilities:
   *
   * 1. **Tradable validation** — the keyset is the set of products Coinbase
   *    actually lists. Watchlist symbols absent from this map are stale
   *    (renamed/delisted, e.g. MATIC→POL Sept 2024) and `openPosition` skips
   *    them with a "not listed" reason instead of eating a 400.
   * 2. **Order quantization** — `base_increment` (e.g. `0.00000001` for BTC,
   *    `1` for SHIB) tells us the minimum size step Coinbase enforces.
   *    Sending a finer-grained `base_size` returns "Too many decimals in
   *    order amount" (TRA-243 follow-up); we floor qty to the step before
   *    submitting.
   *
   * Populated on live broker init via `refreshTradableProducts`. `null` means
   * the lookup never succeeded (e.g. /products was down at startup), in which
   * case `openPosition` falls through to the legacy 6-decimal rounding so a
   * Coinbase outage doesn't freeze trading on otherwise-fine symbols.
   */
  private tradableProducts: Map<string, CoinbaseProductInfo> | null = null;
  private lastTradableProductsRefresh = 0;
  /**
   * TRA-249-B — ring buffer of the most recent 50 live-broker skip events,
   * oldest first. Pushed to by `recordSkip` (every early-return path in
   * `openPosition`); read by `getState` so the engine can surface them to
   * the dashboard. Plain array + shift-when-full is fine at cap=50 — the
   * O(n) shift cost is dwarfed by the order-placement work that did NOT
   * happen on the skip path.
   */
  private recentSkips: LiveSkip[] = [];
  // TRA-232 — risk knobs come from per-user AccountSettings instead of the
  // hardcoded MANAGED_ACCOUNT_RATIO / DEFAULT_RISK_PER_TRADE constants. The
  // engine pushes fresh values via updateRiskConfig on every settings save so
  // the Crypto dashboard honors what the user enters in Settings.
  private managedAccountRatio: number = DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
  private riskPerTrade: number = DEFAULT_ACCOUNT_SETTINGS.riskPerTrade;
  /**
   * TRA-341 — operator override for the §6 single-symbol short cap, expressed
   * as a fraction of strategy equity. Undefined ↔ engine default (0.15) per
   * spec. Pushed in via `updateRiskConfig` whenever settings save so a knob
   * change takes effect on the next signal evaluation; the engine-side
   * `resolveSingleSymbolShortCap` clamps unsafe values back into range so we
   * don't replicate that bound here.
   */
  private singleSymbolShortCap: number | undefined = undefined;
  /**
   * TRA-249-C — routing mode for SELL-side strategy signals. `'hybrid'`
   * routes to a listed Coinbase perp when one exists AND the strategy
   * universe gate passes; `'spot_only'` forces the spot-only-skip branch
   * even when both checks would otherwise route. Default `'hybrid'` matches
   * {@link DEFAULT_ACCOUNT_SETTINGS.liveTradeRoutingCrypto} so an operator
   * that pre-dates TRA-249-E (settings UI) gets perp routing without a
   * settings save.
   */
  private routingMode: LiveTradeRoutingCrypto = 'hybrid';
  /** TRA-249-C — spot↔perp catalog. Lazily refreshed by the engine; pre-load via {@link refreshPerpCatalog}. */
  private readonly perpCatalog: PerpCatalog;
  /**
   * TRA-249-C — perp Coinbase product_id we routed each perp position
   * through, keyed by `Position.id`. Kept out of the shared `Position` shape
   * so the dashboard's per-position serializer stays Coinbase-agnostic;
   * `checkExits` and `closePosition` look up the productId here when
   * `productType === 'perp'` (and fall back to `pos.symbol` for legacy
   * perp records that pre-date this map). Cleared on close.
   */
  private perpProductByPositionId: Map<string, string> = new Map();
  /**
   * TRA-249-C — cached uuid of the user's INTX (perpetuals) portfolio.
   * Resolved lazily on the first reconcile via `listPortfolios('INTX')` and
   * reused for subsequent `listFuturesPositions` calls so the every-30s
   * balance refresh doesn't issue 2 round-trips per call. Reset to null on
   * auth failure so a later refresh re-resolves; intentionally not
   * invalidated by the catalog TTL because the portfolio uuid itself is
   * stable for the life of the user.
   */
  private intxPortfolioUuid: string | null = null;
  /** TRA-249-C — last successful reconcile against `listFuturesPositions`. Drives `PERP_RECONCILE_TTL_MS` rate-limit. */
  private lastPerpReconcileAt = 0;
  /**
   * TRA-262 — funding rate + 24h OI per perp product_id (e.g. `BTC-PERP-INTX`).
   * Sourced from the same `listProducts('FUTURE')` round-trip the perp catalog
   * already issues, so the metrics cache costs zero extra Coinbase calls.
   * Fields default to undefined when Coinbase hasn't published a value yet —
   * `getPerpShortFilterContext` propagates undefined to {@link ShortFilterContext}
   * and the §5 gate skips the corresponding filter per its best-effort contract.
   */
  private perpMetricsByPerpProduct: Map<string, CoinbasePerpMetrics> = new Map();
  /**
   * TRA-262 — last live order-book spread per perp product_id, as a fraction
   * of mid (`(ask - bid) / mid`). Refreshed at the top of each live tick
   * across the perp universe so the §5 spread gate reads a near-real-time
   * value without firing a per-signal Coinbase call (would 4-5× the API
   * budget on a tick that emits multiple short candidates). Per-product
   * undefined entries are kept (signalled by the absence in the map) — a
   * fetch failure or one-sided book leaves the entry unset and the gate
   * skips that signal until the next refresh succeeds.
   */
  private perpSpreadByPerpProduct: Map<string, number> = new Map();
  /**
   * TRA-318 — synthetic spot positions imported from the Coinbase wallet.
   * Keyed by `{currency}-USD` (e.g. `BTC-USD`). These represent the slice of
   * the user's wallet balance that the engine did NOT open in the current
   * session — pre-existing holdings, manual buys via Coinbase Advanced, fills
   * from a previous server run, etc. Surfaced in {@link getState} so the
   * crypto dashboard shows everything the user actually owns on Coinbase
   * instead of only positions the bot opened. Excluded from `checkExits` and
   * `hasOpenPositionForSignalType` — the engine has no TP/SL for these so it
   * has no business auto-managing them; the user closes manually via the
   * dashboard or directly on Coinbase. Refreshed on every `refreshBalance`.
   */
  private importedSpotPositions: Map<string, Position> = new Map();

  constructor(coinbase: CoinbaseOrderClient, opts: CryptoLiveAccountOptions = {}) {
    this.coinbase = coinbase;
    this.sleep = opts.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
    this.routingMode = opts.routingMode ?? 'hybrid';
    this.perpCatalog = opts.perpCatalog ?? new PerpCatalog();
  }

  /**
   * TRA-249-D — expose the underlying Coinbase order client so sibling
   * services (e.g. {@link FundingRateTracker}) can issue independent
   * Coinbase calls without piping the credentials through twice. Read-only
   * — callers must not mutate or retain a reference for write operations
   * outside the live-account contract.
   */
  getCoinbaseClient(): CoinbaseOrderClient {
    return this.coinbase;
  }

  /**
   * Apply per-user risk settings so live crypto orders sized through Coinbase
   * honor the values entered on the Settings page. Called by the engine on
   * init and on every settings save.
   *
   * Fields:
   *   - managedAccountRatio / riskPerTrade — TRA-232 sizing knobs.
   *   - singleSymbolShortCap — TRA-341 operator override for the §6
   *     single-symbol short cap (fraction of strategy equity). `null` clears
   *     a previously-set override back to the engine default; `undefined`
   *     leaves the existing value untouched (so partial-config callers like
   *     a managedAccountRatio-only update don't accidentally reset it).
   */
  updateRiskConfig(config: {
    managedAccountRatio?: number;
    riskPerTrade?: number;
    singleSymbolShortCap?: number | null;
  }): void {
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.riskPerTrade !== undefined) this.riskPerTrade = config.riskPerTrade;
    if (config.singleSymbolShortCap === null) {
      this.singleSymbolShortCap = undefined;
    } else if (config.singleSymbolShortCap !== undefined) {
      this.singleSymbolShortCap = config.singleSymbolShortCap;
    }
  }

  /**
   * Refresh USD-equivalent cash and equity from Coinbase.
   *
   * Cash is summed across stable currencies (USD, USDC, USDT). Non-cash
   * holdings (BTC, ETH, SOL, …) are valued at the current Coinbase spot
   * price for `{currency}-USD` so the dashboard reflects the user's full
   * portfolio rather than just the stable-cash slice (TRA-224 — users with
   * pre-existing crypto on Coinbase were seeing equity = $0).
   *
   * Spot-pricing is best-effort: a failed `getProductPrices` call leaves
   * crypto holdings unvalued (logged as a warning) rather than blowing up
   * the whole refresh. Currencies without a USD pair on Coinbase are simply
   * skipped — the absent price drops out of the Map.
   *
   * Coinbase's `available_balance` already reflects fills from orders we've
   * placed, so we no longer add a separate "open-position notional" term —
   * doing so would double-count the local mirror against the real wallet.
   */
  async refreshBalance(): Promise<void> {
    let accounts: CoinbaseAccountBalance[];
    try {
      accounts = await this.coinbase.listAccounts();
    } catch (err: unknown) {
      log.warn('balance refresh failed', { reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    let cash = 0;
    const cryptoBalances = new Map<string, number>();
    for (const a of accounts) {
      const currency = a.currency.toUpperCase();
      const v = parseFloat(a.available_balance.value);
      if (!Number.isFinite(v) || v === 0) continue;
      if (CASH_CURRENCIES.has(currency)) {
        cash += v;
      } else {
        cryptoBalances.set(`${currency}-USD`, v);
      }
    }

    let cryptoValue = 0;
    let prices: Map<string, number> = new Map();
    if (cryptoBalances.size > 0) {
      try {
        prices = await this.coinbase.getProductPrices(Array.from(cryptoBalances.keys()));
      } catch (err: unknown) {
        log.warn('product price lookup failed', { reason: err instanceof Error ? err.message : String(err) });
        prices = new Map();
      }
      for (const [productId, balance] of cryptoBalances) {
        const price = prices.get(productId);
        if (price != null) cryptoValue += balance * price;
      }
    }

    this.cashUsd = cash;
    this.equityUsd = cash + cryptoValue;
    this.lastBalanceRefresh = Date.now();

    // TRA-318 — surface every Coinbase wallet holding as a visible spot
    // position so the dashboard shows what the user actually owns on
    // Coinbase, not just positions the bot opened in this session. The
    // engine-tracked qty for each symbol is netted out below so we never
    // double-count an in-session open against the wallet balance it
    // produced.
    this.reconcileSpotHoldings(cryptoBalances, prices);

    // TRA-249-C — opportunistic INTX position reconciliation so a perp the
    // user opened in the Coinbase UI (or that survived a server restart) is
    // surfaced in the local mirror without re-firing an open. Rate-limited so
    // the every-30s balance refresh doesn't fan out into 2 extra round-trips
    // per call. Failure is logged inside the helper and never poisons the
    // balance refresh.
    if (Date.now() - this.lastPerpReconcileAt > PERP_RECONCILE_TTL_MS) {
      await this.reconcilePerpPositions();
    }
  }

  /**
   * TRA-318 — rebuild {@link importedSpotPositions} from the latest wallet
   * snapshot. For each non-zero non-cash currency we compute the qty already
   * tracked by an engine-opened spot BUY and import the excess as a synthetic
   * position. Imported positions carry sentinel TP=+Inf / SL=0 so a stray
   * `checkExits` call never fires against them, and they live in their own
   * map so `hasOpenPositionForSignalType` doesn't block strategies from
   * opening their own engine-managed positions on the same symbol.
   *
   * Tolerance is the larger of 1e-8 (Coinbase's smallest base_increment) or
   * 0.01% of the wallet balance — small enough to surface a 0.0001 BTC
   * holding, large enough to absorb the float drift between the engine's
   * recorded qty and Coinbase's `available_balance` after fees.
   */
  private reconcileSpotHoldings(
    walletBalances: ReadonlyMap<string, number>,
    prices: ReadonlyMap<string, number>,
  ): void {
    const next = new Map<string, Position>();
    for (const [productId, walletQty] of walletBalances) {
      const price = prices.get(productId);
      if (price == null || !Number.isFinite(price) || price <= 0) continue;
      let engineSpotQty = 0;
      for (const pos of this.positions.values()) {
        if (pos.symbol !== productId) continue;
        if (pos.productType === 'perp') continue;
        if (pos.side !== 'buy') continue;
        engineSpotQty += pos.quantity;
      }
      const excess = walletQty - engineSpotQty;
      const tolerance = Math.max(1e-8, walletQty * 1e-4);
      if (excess <= tolerance) continue;
      next.set(productId, {
        // Stable id so re-renders keyed on `position.id` don't churn.
        id: `imported-spot-${productId}`,
        symbol: productId,
        side: 'buy',
        signalType: 'reversal',
        entryPrice: price,
        quantity: excess,
        // Sentinel TP/SL — `checkExits` reads from `this.positions` (not
        // this map) so these are advisory; if a future call site iterates
        // imported positions, the sentinels guarantee no auto-exit fires.
        // We use `Number.MAX_VALUE` instead of `Infinity` because the latter
        // serializes to `null` through JSON.stringify, which then crashes
        // the dashboard formatters (TRA-318 follow-up).
        stopLoss: 0,
        takeProfit: Number.MAX_VALUE,
        openedAt: Date.now(),
        productType: 'spot',
      });
    }
    this.importedSpotPositions = next;
  }

  getState(): CryptoLiveAccountState {
    // TRA-318 — merge engine-tracked positions with the imported wallet
    // holdings. Engine-tracked entries take precedence implicitly: their qty
    // is already netted out of the imported entry inside `reconcileSpotHoldings`,
    // so a position the bot opened this session shows once (with TP/SL) and
    // any extra wallet balance shows separately as an imported holding (no
    // TP/SL).
    const openPositions: Position[] = [
      ...this.positions.values(),
      ...this.importedSpotPositions.values(),
    ];
    return {
      totalEquity: this.equityUsd,
      availableCash: this.cashUsd,
      openPositions,
      dailyPnl: this.realizedPnlToday,
      // Defensive copy so a caller mutating the array (e.g. the engine
      // re-stamping `mode` on positions) can't corrupt the ring buffer.
      recentSkips: this.recentSkips.slice(),
    };
  }

  /**
   * TRA-249-B — record a structured skip event and stamp the originating
   * signal so the dashboard's existing per-signal skip-reason channel still
   * lights up. Three things happen on every skip:
   *
   *   1. `signal.liveSkipReason = reason` — the per-signal annotation the
   *      Signals panel reads (TRA-243).
   *   2. push onto the recent-skips ring buffer (cap 50, oldest dropped) —
   *      the aggregate channel surfaced via `getState`.
   *   3. `console.warn(...)` — keeps the server log line a human operator
   *      grepping logs has relied on since TRA-243.
   *
   * Centralising these three writes here keeps the call sites in
   * `openPosition` to a single line and guarantees they don't drift.
   */
  private recordSkip(signal: TradeSignal, reason: string): null {
    signal.liveSkipReason = reason;
    this.recentSkips.push({
      symbol: signal.symbol,
      side: signal.side,
      reason,
      at: Date.now(),
    });
    if (this.recentSkips.length > RECENT_SKIPS_CAP) {
      this.recentSkips.splice(0, this.recentSkips.length - RECENT_SKIPS_CAP);
    }
    log.warn('skip', { symbol: signal.symbol, signalType: signal.type, side: signal.side, reason });
    return null;
  }

  /** TRA-249-B — defensive snapshot of the recent-skips ring buffer. */
  getRecentSkips(): LiveSkip[] {
    return this.recentSkips.slice();
  }

  /**
   * TRA-249-D — open perp positions only. The {@link FundingRateTracker}
   * iterates this list once per hourly tick to charge/credit each position
   * its `fundingRate × notional` accrual. Returns a defensive shallow copy
   * so callers can iterate while the tracker mutates `fundingPnl` via
   * {@link applyFundingAccrual}.
   */
  getOpenPerpPositions(): Position[] {
    const out: Position[] = [];
    for (const pos of this.positions.values()) {
      if (pos.productType === 'perp') out.push(pos);
    }
    return out;
  }

  /**
   * TRA-249-D — Coinbase INTX product_id (`BTC-PERP-INTX`) the given perp
   * position was routed through. Used by the funding tracker to batch-fetch
   * funding rates by perp product rather than by spot symbol. Returns null
   * for spot positions and for legacy perp records that pre-date
   * {@link perpProductByPositionId} (the funding tracker treats null as
   * "skip — no rate to apply").
   */
  getPerpProductId(positionId: string): string | null {
    return this.perpProductByPositionId.get(positionId) ?? null;
  }

  /**
   * TRA-249-D — apply one hourly funding accrual to an open perp position.
   *
   * Bookkeeping invariants the funding tracker relies on:
   *
   * 1. `pos.fundingPnl` accumulates monotonically across hourly ticks. The
   *    closed-positions API surfaces the final value via `pos.pnl` once
   *    the position closes (see `checkExits` / `closePosition`).
   * 2. `realizedPnlToday` increases by the same amount, so the dashboard's
   *    daily P&L reflects funding within the hour it was charged — not only
   *    at close. This is the spec's primary "Done when" target: funding
   *    shows up in `dailyPnl` within an hour of opening a perp short.
   * 3. `equityUsd` advances by the same amount because INTX margin settles
   *    funding hourly (the realised side of the §7 circuit breaker already
   *    advances equity on close — funding is the same flow at smaller
   *    cadence).
   * 4. Short funding feeds `realizedShortPnlToday` so the §7 daily short
   *    circuit breaker (TRA-264) sees the cost in real time and doesn't
   *    blow through the 2% daily-loss budget after a long funding-heavy
   *    open.
   *
   * Idempotency: the caller (FundingRateTracker) is responsible for
   * scheduling exactly one accrual per hour. This method does not attempt
   * to dedupe within the hour; it just applies the delta and stamps
   * `lastFundingAccrualAt` for diagnostics.
   *
   * No-op for unknown positions, non-perp positions, and non-finite amounts.
   * Spot positions don't carry funding on Coinbase, so an accidental call
   * for a spot symbol must not poison the day's P&L.
   */
  applyFundingAccrual(positionId: string, amountUsd: number): void {
    if (!Number.isFinite(amountUsd)) return;
    const pos = this.positions.get(positionId);
    if (!pos || pos.productType !== 'perp') return;
    pos.fundingPnl = (pos.fundingPnl ?? 0) + amountUsd;
    pos.lastFundingAccrualAt = Date.now();
    this.realizedPnlToday += amountUsd;
    if (pos.side === 'sell') {
      this.realizedShortPnlToday += amountUsd;
    }
    this.equityUsd += amountUsd;
  }

  /**
   * TRA-264 — strategy-spec skip channel for §6 notional caps and §7 daily
   * circuit breaker. Mirrors `recordSkip` but stamps `signalSkipReason`
   * (strategy-side gate) instead of `liveSkipReason` (broker reject). The
   * dashboard surfaces both channels via the same per-signal skip badge, so
   * pushing onto the aggregate `recentSkips` ring buffer keeps a single place
   * for operators to scan recent skip activity.
   */
  private recordStrategySkip(signal: TradeSignal, reason: string): null {
    signal.signalSkipReason = reason;
    this.recentSkips.push({
      symbol: signal.symbol,
      side: signal.side,
      reason,
      at: Date.now(),
    });
    if (this.recentSkips.length > RECENT_SKIPS_CAP) {
      this.recentSkips.splice(0, this.recentSkips.length - RECENT_SKIPS_CAP);
    }
    log.warn('strategy-skip', { symbol: signal.symbol, signalType: signal.type, side: signal.side, reason });
    return null;
  }

  isStale(): boolean {
    return Date.now() - this.lastBalanceRefresh > BALANCE_REFRESH_MS;
  }

  /**
   * TRA-243 — pre-validate watchlist symbols against Coinbase's live product
   * catalogue so signals on delisted/renamed tickers (e.g. MATIC after the
   * POL rename) are skipped with a clear reason BEFORE we POST /orders and
   * eat a 400 INVALID_ARGUMENT. We piggyback on `getProductPrices` because
   * Coinbase silently drops unknown product_ids from that response — the
   * returned Map's keys are exactly the tradable subset of what we asked for.
   *
   * Best-effort: a failed lookup leaves the previous cache in place rather
   * than nulling it, so a transient /products outage can't false-positive
   * every signal as "delisted".
   */
  async refreshTradableProducts(productIds: readonly string[]): Promise<void> {
    if (productIds.length === 0) return;
    let products: Map<string, CoinbaseProductInfo>;
    try {
      products = await this.coinbase.getProducts(Array.from(productIds));
    } catch (err: unknown) {
      log.warn('tradable products refresh failed', { reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.tradableProducts = products;
    this.lastTradableProductsRefresh = Date.now();
  }

  isTradableProductsStale(): boolean {
    return Date.now() - this.lastTradableProductsRefresh > TRADABLE_PRODUCTS_TTL_MS;
  }

  /**
   * TRA-249-C / TRA-262 — refresh the spot↔perp routing catalog AND the
   * per-perp metrics cache (funding rate + 24h OI) from one Coinbase
   * `/products?product_type=FUTURE` round-trip.
   *
   * The two concerns share the same network call so adding metrics costs
   * zero extra API budget vs. the pre-TRA-262 catalog-only refresh. Failure
   * is best-effort: an exception leaves both the catalog map AND the metrics
   * map intact (transient outage degrades to stale data, never to "spot-only
   * forever" or "all gates skipped forever").
   *
   * The engine pre-loads on init alongside `refreshTradableProducts` and
   * refreshes hourly from `runLiveTick` via {@link isPerpCatalogStale}. The
   * 1h cadence is well under Coinbase's published ~8h funding settlement
   * window so an operator never sees a stale funding rate at gate time.
   */
  async refreshPerpCatalog(spotSymbols: readonly string[]): Promise<void> {
    if (spotSymbols.length === 0) return;
    let products: CoinbaseListedProduct[];
    try {
      products = await this.coinbase.listProducts('FUTURE');
    } catch (err: unknown) {
      log.warn('perp catalog refresh failed', { reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.perpCatalog.applyProducts(products, spotSymbols);
    const nextMetrics = new Map<string, CoinbasePerpMetrics>();
    for (const p of products) {
      if (p.perp) nextMetrics.set(p.product_id, p.perp);
    }
    this.perpMetricsByPerpProduct = nextMetrics;
  }

  isPerpCatalogStale(): boolean {
    return this.perpCatalog.isStale();
  }

  /** TRA-249-C — exposed for diagnostics + tests; the routing fork uses the catalog directly. */
  getPerpCatalog(): PerpCatalog {
    return this.perpCatalog;
  }

  /**
   * TRA-262 — refresh live order-book spread per perp product across the
   * supplied spot symbols. One `getProductBook` call per perp the catalog
   * resolves; runs at the top of each live tick so the §5 spread gate sees
   * a near-real-time fraction without per-signal network I/O. Failures are
   * absorbed per-product (a single thin alt going one-sided does not poison
   * the rest of the universe), and the previous spread for that product is
   * cleared so the gate degrades to "skipped" rather than acting on a stale
   * fraction that may now be wildly off.
   *
   * Costs are bounded by the perp universe size (5 symbols today per
   * {@link PERP_SHORTS_UNIVERSE}); a routine maintenance pass is acceptable
   * even on every tick. Spot symbols without a resolved perp are silently
   * skipped — the catalog refresh owns the "is this perp listed?" decision
   * and we don't want to second-guess it here.
   */
  async refreshPerpOrderBookSpreads(spotSymbols: readonly string[]): Promise<void> {
    if (spotSymbols.length === 0) return;
    const perpIds: string[] = [];
    for (const sym of spotSymbols) {
      const perpId = this.perpCatalog.getPerpFor(sym);
      if (perpId) perpIds.push(perpId);
    }
    if (perpIds.length === 0) return;
    const next = new Map<string, number>(this.perpSpreadByPerpProduct);
    await Promise.all(
      perpIds.map(async (perpId) => {
        try {
          const book = await this.coinbase.getProductBook(perpId);
          if (book.spreadFraction != null && Number.isFinite(book.spreadFraction)) {
            next.set(perpId, book.spreadFraction);
          } else {
            // A one-sided / inverted book or a missing top-of-book — drop the
            // stale value so the gate skips this signal until a valid book
            // shows up next tick. Better to skip than to act on a fraction
            // that may have moved several bps since the cached read.
            next.delete(perpId);
          }
        } catch (err: unknown) {
          log.warn('product_book lookup failed', {
            perpId,
            reason: err instanceof Error ? err.message : String(err),
          });
          next.delete(perpId);
        }
      }),
    );
    this.perpSpreadByPerpProduct = next;
  }

  /**
   * TRA-262 — assemble the data-feed inputs for {@link evaluateShortFilters}
   * for one spot symbol. Each field comes from a separate cache:
   *
   *   - funding rate + OI: hourly perp catalog refresh (`refreshPerpCatalog`)
   *   - spread: per-tick order-book refresh (`refreshPerpOrderBookSpreads`)
   *
   * Returns an object with whatever subset of fields the caches currently
   * carry; missing fields stay undefined so the strategy gate skips them per
   * its best-effort contract instead of reading a synthetic zero. Symbols
   * without a resolved perp catalog entry get an empty object — the universe
   * gate higher in the pipeline already suppresses non-perp shorts, so this
   * helper only needs to be safe (not authoritative) on those symbols.
   */
  getPerpShortFilterContext(spotSymbol: string): ShortFilterContext {
    const perpId = this.perpCatalog.getPerpFor(spotSymbol);
    if (!perpId) return {};
    const metrics = this.perpMetricsByPerpProduct.get(perpId);
    const spread = this.perpSpreadByPerpProduct.get(perpId);
    const ctx: ShortFilterContext = {};
    if (metrics?.fundingRatePerHour !== undefined) ctx.fundingRatePerHour = metrics.fundingRatePerHour;
    if (metrics?.openInterestUsd !== undefined) ctx.openInterestUsd = metrics.openInterestUsd;
    if (spread !== undefined) ctx.spreadFraction = spread;
    return ctx;
  }

  /**
   * TRA-249-C — switch the routing mode for SELL-side strategy signals. The
   * engine calls this on every settings save so a user toggling
   * `liveTradeRoutingCrypto` between `'hybrid'` and `'spot_only'` takes effect
   * on the very next tick without a server restart. Idempotent.
   */
  setRoutingMode(mode: LiveTradeRoutingCrypto): void {
    this.routingMode = mode;
  }

  getRoutingMode(): LiveTradeRoutingCrypto {
    return this.routingMode;
  }

  /**
   * TRA-249-C — merge any open INTX perp positions into the local mirror so a
   * position the user opened in the Coinbase UI (or that survived a server
   * restart) is visible to `checkExits` / `hasOpenPosition` instead of
   * getting silently re-opened by the next strategy signal.
   *
   * Two-phase lookup:
   *   1. Resolve the INTX portfolio uuid via `listPortfolios('INTX')` and
   *      cache it. Coinbase splits a user's account across DEFAULT (spot) and
   *      INTX (perps) portfolios; the positions endpoint is portfolio-scoped.
   *   2. List the current open positions via `listFuturesPositions(uuid)` and
   *      add anything we don't already track.
   *
   * Best-effort: a failure on either call is logged and skipped — we never
   * want broken reconciliation to abort the host `refreshBalance`. A user
   * without an INTX portfolio (no perps enabled) yields a no-op after the
   * first `listPortfolios` call returns empty; the cached
   * `intxPortfolioUuid` stays null and we keep retrying on the rate-limit
   * cadence.
   */
  async reconcilePerpPositions(): Promise<void> {
    const uuid = await this.resolveIntxPortfolioUuid();
    if (!uuid) {
      // No INTX portfolio (perps not enabled, or list call failed). Mark as
      // "tried" so the rate-limit doesn't hammer Coinbase from every
      // refreshBalance call.
      this.lastPerpReconcileAt = Date.now();
      return;
    }
    let openPerps: CoinbaseFuturesPosition[];
    try {
      openPerps = await this.coinbase.listFuturesPositions(uuid);
    } catch (err: unknown) {
      log.warn('perp position reconcile failed', { reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.mergePerpPositions(openPerps);
    this.lastPerpReconcileAt = Date.now();
  }

  private async resolveIntxPortfolioUuid(): Promise<string | null> {
    if (this.intxPortfolioUuid) return this.intxPortfolioUuid;
    try {
      const portfolios = await this.coinbase.listPortfolios('INTX');
      // Coinbase returns one INTX portfolio per user; the first non-deleted
      // entry is the canonical one. listPortfolios already filters tombstones.
      const intx = portfolios.find((p) => (p.type ?? '').toUpperCase() === 'INTX') ?? portfolios[0];
      if (!intx) return null;
      this.intxPortfolioUuid = intx.uuid;
      return this.intxPortfolioUuid;
    } catch (err: unknown) {
      log.warn('INTX portfolio lookup failed', { reason: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * Merge a snapshot of Coinbase-reported perp positions into the local
   * mirror. A position that we already track (matched by perp product_id) is
   * left untouched — re-opening it would double-count notional and corrupt
   * the local accounting. Anything new is added with `productType: 'perp'`
   * and the spot symbol the perp routes for so the existing price-keyed
   * `checkExits` path keeps working without special-casing.
   *
   * `signalType` and TP/SL are unknown for UI-opened positions: `'reversal'`
   * stamps a benign default and sentinel TP/SL values keep `checkExits` from
   * tripping. The user closes manually via the dashboard; the §6 notional
   * caps in `openPerpShort` already factor open shorts into per-symbol /
   * total caps via `sumOpenShortNotional`, so the reconciled position
   * counts toward those caps automatically.
   */
  private mergePerpPositions(openPerps: readonly CoinbaseFuturesPosition[]): void {
    const knownPerpIds = new Set(this.perpProductByPositionId.values());
    for (const p of openPerps) {
      if (knownPerpIds.has(p.product_id)) continue;
      const size = parseFloat(p.net_size);
      if (!Number.isFinite(size) || size <= 0) continue;
      const base = baseCurrency(p.product_id);
      if (!base) continue;
      const spotSymbol = `${base}-USD`;
      const entryPrice = parseFloat(p.vwap ?? p.mark_price ?? '0');
      const leverageNum = parseFloat(p.leverage ?? String(PERP_SHORT_LEVERAGE));
      const leverage = Number.isFinite(leverageNum) && leverageNum > 0 ? leverageNum : PERP_SHORT_LEVERAGE;
      const liquidationPrice = parseFloat(p.liquidation_price ?? '0');
      const side: 'buy' | 'sell' = p.position_side === 'LONG' ? 'buy' : 'sell';
      const positionId = randomUUID();
      const position: Position = {
        id: positionId,
        symbol: spotSymbol,
        side,
        signalType: 'reversal',
        entryPrice,
        quantity: size,
        // UI-opened positions have no engine-defined TP/SL. Use ±Infinity
        // sentinels so `checkExits` never trips them; manual close via the
        // dashboard is the only exit path until the user takes ownership.
        stopLoss: side === 'buy' ? 0 : Number.POSITIVE_INFINITY,
        takeProfit: side === 'buy' ? Number.POSITIVE_INFINITY : 0,
        openedAt: Date.now(),
        productType: 'perp',
        leverage,
        marginUsd: Number.isFinite(entryPrice) && entryPrice > 0
          ? (entryPrice * size) / leverage
          : 0,
        liquidationPrice: Number.isFinite(liquidationPrice) && liquidationPrice > 0 ? liquidationPrice : undefined,
        // TRA-338 — Coinbase reconciliation, so the entry came from Coinbase.
        quoteSource: 'coinbase',
      };
      this.positions.set(positionId, position);
      this.perpProductByPositionId.set(positionId, p.product_id);
      log.info('reconcile imported perp (no engine TP/SL — manual close only)', {
        productId: p.product_id,
        positionSide: p.position_side,
        size,
      });
    }
  }

  managedEquity(): number {
    return this.equityUsd * this.managedAccountRatio;
  }

  maxRiskPerTrade(): number {
    return this.managedEquity() * this.riskPerTrade;
  }

  /** Same fractional sizing as the paper account — 6 decimal places. */
  sizeFromStop(entryPrice: number, stopPrice: number): number {
    const dist = Math.abs(entryPrice - stopPrice);
    if (dist === 0) return 0;
    const rawQty = this.maxRiskPerTrade() / dist;
    return Math.round(rawQty * 1_000_000) / 1_000_000;
  }

  /**
   * TRA-264 — risk-fraction-aware sizing for perp shorts. Tier-1 majors size
   * at 0.50% of managed equity; Tier-2 (DOGE) at 0.30% per `perpShortRiskFraction`.
   * The long-side `sizeFromStop` keeps using `riskPerTrade` (1% baseline) so
   * BUY behaviour is byte-identical.
   */
  sizeShortFromStop(symbol: string, entryPrice: number, stopPrice: number): number {
    const dist = Math.abs(entryPrice - stopPrice);
    if (dist === 0) return 0;
    const riskFrac = perpShortRiskFraction(symbol);
    const maxRiskUsd = this.managedEquity() * riskFrac;
    const rawQty = maxRiskUsd / dist;
    return Math.round(rawQty * 1_000_000) / 1_000_000;
  }

  /**
   * TRA-264 — sum open-short notional (entryPrice × quantity) across positions
   * matching `predicate`. Used to feed `evaluateShortNotionalCaps` with the
   * §6 inputs (this strategy + this symbol, all strategies + this symbol,
   * total). Notional is computed off the entry price rather than current
   * mark, matching the spec wording "sum of open short notional".
   */
  private sumOpenShortNotional(predicate: (pos: Position) => boolean = () => true): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      if (pos.side !== 'sell') continue;
      if (!predicate(pos)) continue;
      total += pos.entryPrice * pos.quantity;
    }
    return total;
  }

  hasOpenPosition(symbol: string): boolean {
    return Array.from(this.positions.values()).some(p => p.symbol === symbol);
  }

  hasOpenPositionForSignalType(symbol: string, signalType: SignalType): boolean {
    return Array.from(this.positions.values()).some(
      p => p.symbol === symbol && p.signalType === signalType,
    );
  }

  /**
   * Submit a market order to Coinbase and, on success, record the resulting
   * position locally. Returns null if the trade was skipped before order
   * submission (qty too small, insufficient cash, spot-only SELL). Throws if
   * Coinbase rejects.
   *
   * TRA-243 / TRA-249-B — every skip path stamps `signal.liveSkipReason` AND
   * pushes a structured `LiveSkip` onto the recent-skips ring buffer (via
   * `recordSkip`). Without this, skips were `console.warn`-only and operators
   * saw "8 signals, 0 positions" with no way to self-diagnose.
   */
  async openPosition(
    signal: TradeSignal,
    currentPrice: number,
    quoteSource?: PositionQuoteSource,
    sizeMultiplier = 1,
  ): Promise<Position | null> {
    // TRA-264 — SELL-side fork. Symbols inside the Phase-1 perp shorts
    // universe (TRA-261 / TRA-255 §2: BTC, ETH, SOL, XRP, DOGE) route to
    // Coinbase INTX as 1× isolated perp shorts. Anything else falls back to
    // the TRA-249-B spot-only guard so a stray SELL on a non-perp watchlist
    // symbol can't nibble at the user's pre-existing spot holdings (TRA-224).
    if (signal.side === 'sell') {
      // TRA-249-C — `'spot_only'` routing mode is the operator-facing safety
      // hatch (Settings: liveTradeRoutingCrypto = 'spot_only'). Forces every
      // SELL through the spot-only-skip branch even when the strategy
      // universe gate would otherwise route to perp. Same skip wording as
      // the universe-gate miss so the dashboard's per-signal reason format
      // doesn't shift between the two modes.
      if (this.routingMode === 'spot_only') {
        return this.recordSkip(signal, `spot only — no perp listed for ${signal.symbol}`);
      }
      if (!isPerpShortSymbol(signal.symbol)) {
        return this.recordSkip(signal, `spot only — no perp listed for ${signal.symbol}`);
      }
      return this.openPerpShort(signal, currentPrice, quoteSource);
    }

    // TRA-243 — refuse to fire orders against tickers Coinbase doesn't list
    // (renamed or delisted from the watchlist — e.g. MATIC after the POL
    // rename, FTM after Sonic). Without this check Coinbase rejects with
    // `INVALID_ARGUMENT: Invalid product_id` after we've already debited
    // sizing slots, and the user sees a confusing 400 in the UI. We only
    // enforce when we have a verified product list — a null cache means we
    // never successfully fetched /products, in which case fall through to
    // the existing cash/min-notional gate so a /products outage doesn't
    // freeze trading entirely.
    if (this.tradableProducts && !this.tradableProducts.has(signal.symbol)) {
      return this.recordSkip(
        signal,
        `${signal.symbol} not listed on Coinbase Advanced Trade — likely delisted or renamed (e.g. MATIC→POL); remove it from the watchlist`,
      );
    }

    // TRA-285 — refresh `available_balance` from Coinbase right before sizing
    // so a hold/withdrawal that happened since the last 30s dashboard refresh
    // doesn't have us submit a buy that's guaranteed to fail with
    // `INSUFFICIENT_FUND`. We coalesce within BALANCE_PREFLIGHT_MAX_AGE_MS so
    // a tick that opens multiple signals doesn't spam /accounts. Doing the
    // refresh BEFORE the managed-equity guard means an account that just got
    // funded sees the new equity on the very next tick rather than the next
    // 30s dashboard refresh.
    if (Date.now() - this.lastBalanceRefresh > BALANCE_PREFLIGHT_MAX_AGE_MS) {
      await this.refreshBalance();
    }

    // TRA-249-B — explicit guard for managed-equity-too-small BEFORE sizing.
    // `sizeFromStop` derives qty from `maxRiskPerTrade() = managedEquity() ×
    // riskPerTrade`, so a zero-equity or zero-ratio account would otherwise
    // trip the qty<=0 path with a generic "qty too small" reason — checking
    // here gives the user the actually-actionable diagnosis (fund the
    // account / raise managedAccountRatio).
    if (this.managedEquity() <= 0) {
      return this.recordSkip(
        signal,
        `managed equity too small (equity=${this.equityUsd.toFixed(2)}, managedRatio=${this.managedAccountRatio})`,
      );
    }
    let qty = this.sizeFromStop(signal.entryPrice, signal.stopLoss);
    if (qty <= 0) {
      return this.recordSkip(
        signal,
        `qty too small after sizing (entry=${signal.entryPrice} stop=${signal.stopLoss}, maxRisk=${this.maxRiskPerTrade().toFixed(2)})`,
      );
    }
    // Cap by managed equity: never spend more than the user has authorised
    // the engine to trade with (managedAccountRatio × total equity).
    const maxQtyForManagedEquity = this.managedEquity() / currentPrice;
    qty = Math.min(qty, maxQtyForManagedEquity);
    // TRA-243 — Cap by available USD cash so accounts whose equity is mostly
    // held in crypto (or whose user-configured risk targets a bigger fund) can
    // still trade. Without this the engine would skip every signal for a
    // small-cash account on `cost > cash`. Risk-per-trade remains an upper
    // bound; capping here only ever sizes positions DOWN.
    const maxCashSpend = this.cashUsd * CASH_FEE_BUFFER;
    const maxQtyForCash = maxCashSpend / currentPrice;
    qty = Math.min(qty, maxQtyForCash);
    // TRA-423 — correlation / concentration cap scale-down (1 ↔ no-op).
    // Applied to the long (spot BUY) path only; perp shorts route through
    // `openPerpShort`, which is governed by the TRA-261 short notional caps.
    if (Number.isFinite(sizeMultiplier) && sizeMultiplier > 0 && sizeMultiplier < 1) {
      qty *= sizeMultiplier;
    }
    // TRA-243 — Coinbase enforces a per-product `base_increment` (e.g.
    // `0.00000001` for BTC, `1` for SHIB). Sending finer-grained sizes
    // returns "Too many decimals in order amount". Quantize here using the
    // cached increment when we have one; fall back to legacy 6-decimal
    // rounding when the /products lookup never succeeded so a Coinbase
    // outage doesn't freeze trading.
    const productInfo = this.tradableProducts?.get(signal.symbol);
    qty = productInfo
      ? quantizeBaseSize(qty, productInfo.baseIncrement)
      : Math.round(qty * 1_000_000) / 1_000_000;
    if (qty <= 0) {
      return this.recordSkip(
        signal,
        `no spendable cash (USD=${this.cashUsd.toFixed(2)}, managedEquity=${this.managedEquity().toFixed(2)} — fund the Coinbase USD wallet or sell crypto holdings to free cash)`,
      );
    }
    const cost = currentPrice * qty;
    if (cost < MIN_NOTIONAL_USD) {
      return this.recordSkip(
        signal,
        `cost $${cost.toFixed(2)} below Coinbase $${MIN_NOTIONAL_USD} minimum (USD=${this.cashUsd.toFixed(2)}, maxRisk=${this.maxRiskPerTrade().toFixed(2)})`,
      );
    }
    // TRA-285 — final pre-flight: re-verify the resulting cost fits inside
    // available cash with the fee buffer before we hit the wire. Without this
    // any sizing path that bypassed `maxQtyForCash` (e.g. risk-derived qty
    // when cash isn't the binding constraint and the fee buffer becomes the
    // binding one, or a future quantizer change that doesn't strictly floor)
    // could still ship an order Coinbase rejects for INSUFFICIENT_FUND. Skip
    // through `recordSkip` so the dashboard surfaces actionable text and the
    // user can fund the wallet instead of seeing a Coinbase error.
    if (cost > maxCashSpend) {
      return this.recordSkip(
        signal,
        `cost $${cost.toFixed(2)} exceeds available cash $${this.cashUsd.toFixed(2)} (with ${((1 - CASH_FEE_BUFFER) * 100).toFixed(1)}% fee headroom — fund the Coinbase USD wallet or sell crypto holdings to free cash)`,
      );
    }

    let resp: CoinbaseOrderSuccessResponse;
    try {
      resp = await this.coinbase.placeMarketOrder({
        productId: signal.symbol,
        side: signal.side,
        baseSize: qty,
      });
    } catch (err: unknown) {
      // TRA-243 — bubble the Coinbase rejection text onto the signal so the
      // user sees "Insufficient funds" / "Order size below minimum" in the
      // UI, not just in stderr. We still rethrow so the engine's existing
      // catch path logs at warn level. Routed through recordSkip so the
      // rejection lands in the aggregate skip channel too.
      const msg = err instanceof Error ? err.message : String(err);
      this.recordSkip(signal, `Coinbase rejected order: ${msg}`);
      log.error('open failed', { symbol: signal.symbol, reason: msg });
      throw err;
    }

    // Reconcile against the real fill so the local mirror reflects what Coinbase
    // actually executed (TRA-156). Falls back to the quote price/requested qty
    // if the API hasn't caught up — refreshBalance() will smooth out any drift.
    const fill = await this.awaitFill(resp.order_id, signal.symbol);
    const entryPrice = fill?.price ?? currentPrice;
    const filledQty = fill?.size ?? qty;

    const position: Position = {
      id: randomUUID(),
      symbol: signal.symbol,
      side: signal.side,
      signalType: signal.type,
      signalId: signal.id,
      entryPrice,
      quantity: filledQty,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      openedAt: Date.now(),
      // TRA-338 — record provenance. The engine only routes Coinbase-priced
      // signals here, but `currentPrice` is also reconciled against the
      // actual Coinbase fill (`fill?.price`); either way this stamp is
      // 'coinbase' on the live path.
      quoteSource: quoteSource ?? 'coinbase',
    };
    this.positions.set(position.id, position);
    // Optimistic cash debit; refreshBalance() will reconcile from Coinbase.
    this.cashUsd -= entryPrice * filledQty;
    const reconciled = fill ? `@ ${entryPrice.toFixed(2)} (filled ${filledQty})` : `@ ~${currentPrice.toFixed(2)} (unreconciled)`;
    log.info('OPEN', {
      side: signal.side.toUpperCase(),
      symbol: signal.symbol,
      reconciled,
      coinbaseOrderId: resp.order_id,
    });
    return position;
  }

  /**
   * TRA-264 — open a 1× isolated perp SHORT on Coinbase INTX. Caller has
   * already established that `signal.symbol` is in the Phase-1 perp universe.
   *
   * Order of guards before order submit:
   *   1. Daily short circuit breaker (TRA-255 §7) — realised + unrealised
   *      short P&L for the day ≤ -2% equity halts new shorts until UTC day
   *      rollover.
   *   2. Tradable-product validation (TRA-243) — never fire against a symbol
   *      Coinbase no longer lists.
   *   3. Managed-equity / sizing / quantization gates — same shape as the
   *      BUY path, but per-trade risk comes from `perpShortRiskFraction`
   *      (Tier-1 0.50%, Tier-2 0.30%) so shorts size at half the long-side
   *      budget per spec §6.
   *   4. §6 notional caps (single-symbol / cross-strategy / total) via
   *      `evaluateShortNotionalCaps` — fire as `signalSkipReason` so the
   *      dashboard groups them with the other strategy gates.
   *
   * Cash bookkeeping: ISOLATED perp margin sits in the Coinbase INTX
   * portfolio, not the spot USD wallet — this method intentionally does NOT
   * debit `cashUsd`. Realised P&L on close still flows through
   * `realizedPnlToday` so the dashboard's daily P&L matches reality, with a
   * parallel `realizedShortPnlToday` tally feeding the §7 circuit breaker.
   */
  private async openPerpShort(signal: TradeSignal, currentPrice: number, quoteSource?: PositionQuoteSource): Promise<Position | null> {
    if (
      dailyShortCircuitBreakerTripped({
        shortPnlTodayUsd: this.realizedShortPnlToday + this.openShortsUnrealisedPnlUsd,
        totalEquityUsd: this.equityUsd,
      })
    ) {
      return this.recordStrategySkip(signal, SKIP_DAILY_SHORT_CIRCUIT_BREAKER);
    }

    // TRA-243 — refuse to fire against tickers Coinbase doesn't list. The
    // tradable-products cache covers spot SKUs today; once perp catalogue
    // discovery lands we'll either share the same cache or split — for now
    // we treat a missing entry the same way the BUY path does.
    if (this.tradableProducts && !this.tradableProducts.has(signal.symbol)) {
      return this.recordSkip(
        signal,
        `${signal.symbol} not listed on Coinbase Advanced Trade — likely delisted or renamed (e.g. MATIC→POL); remove it from the watchlist`,
      );
    }

    if (this.managedEquity() <= 0) {
      return this.recordSkip(
        signal,
        `managed equity too small (equity=${this.equityUsd.toFixed(2)}, managedRatio=${this.managedAccountRatio})`,
      );
    }

    let qty = this.sizeShortFromStop(signal.symbol, signal.entryPrice, signal.stopLoss);
    if (qty <= 0) {
      return this.recordSkip(
        signal,
        `qty too small after sizing (entry=${signal.entryPrice} stop=${signal.stopLoss}, riskFrac=${perpShortRiskFraction(signal.symbol)})`,
      );
    }
    // Cap by managed equity at 1× leverage — never short more notional than
    // the user has authorised the engine to risk. Higher leverage would
    // soften this; we explicitly do not multiply here so a future leverage
    // bump is a deliberate edit, not an accidental capacity expansion.
    const maxQtyForManagedEquity = (this.managedEquity() * PERP_SHORT_LEVERAGE) / currentPrice;
    qty = Math.min(qty, maxQtyForManagedEquity);

    const productInfo = this.tradableProducts?.get(signal.symbol);
    qty = productInfo
      ? quantizeBaseSize(qty, productInfo.baseIncrement)
      : Math.round(qty * 1_000_000) / 1_000_000;
    if (qty <= 0) {
      return this.recordSkip(
        signal,
        `qty too small after quantization (entry=${signal.entryPrice} stop=${signal.stopLoss}, riskFrac=${perpShortRiskFraction(signal.symbol)})`,
      );
    }

    const candidateNotional = currentPrice * qty;
    if (candidateNotional < MIN_NOTIONAL_USD) {
      return this.recordSkip(
        signal,
        `cost $${candidateNotional.toFixed(2)} below Coinbase $${MIN_NOTIONAL_USD} minimum (managedEquity=${this.managedEquity().toFixed(2)}, riskFrac=${perpShortRiskFraction(signal.symbol)})`,
      );
    }

    // §6 notional caps — single-symbol (per-strategy 15% strategy equity),
    // cross-strategy per-symbol (20% total equity), total short notional
    // ceiling (30% total equity). Strategy slice is the same managed-equity
    // ratio used everywhere else; engine doesn't carry a per-strategy split
    // through to live so each strategy is allowed up to the full slice for
    // its single-symbol budget. Cross-strategy / total caps are global and
    // do the heavy lifting.
    const capReason = evaluateShortNotionalCaps({
      totalEquityUsd: this.equityUsd,
      strategyEquityUsd: this.managedEquity(),
      candidateShortNotionalUsd: candidateNotional,
      openShortsThisStrategyThisSymbolUsd: this.sumOpenShortNotional(
        (p) => p.signalType === signal.type && p.symbol === signal.symbol,
      ),
      openShortsAllStrategiesThisSymbolUsd: this.sumOpenShortNotional(
        (p) => p.symbol === signal.symbol,
      ),
      openShortsTotalUsd: this.sumOpenShortNotional(),
      // TRA-341 — operator override. Undefined here ↔ engine default (0.15).
      singleSymbolCapOverride: this.singleSymbolShortCap,
    });
    if (capReason) {
      return this.recordStrategySkip(signal, capReason);
    }

    // TRA-249-C — resolve the actual Coinbase INTX product_id (e.g.
    // `BTC-PERP-INTX`) for this spot symbol via the perp catalog.
    // Pre-TRA-249-C the order body submitted `signal.symbol` directly, which
    // is the spot pair (`BTC-USD`) — Coinbase's perp endpoint would reject
    // that with INVALID_ARGUMENT. The catalog is a no-op when not loaded
    // (returns null) and we fall back to `signal.symbol` so existing tests
    // that don't pre-load the catalog keep behaving as they did under
    // TRA-264. In production the engine pre-loads the catalog at broker
    // init alongside refreshTradableProducts so first-tick callers always
    // see a populated map.
    const perpProductId = this.perpCatalog.getPerpFor(signal.symbol) ?? signal.symbol;

    let resp: CoinbaseOrderSuccessResponse;
    try {
      resp = await this.coinbase.placeMarketOrder({
        productId: perpProductId,
        side: 'sell',
        baseSize: qty,
        leverage: PERP_SHORT_LEVERAGE,
        marginType: PERP_SHORT_MARGIN_TYPE,
        positionSide: PERP_SHORT_POSITION_SIDE,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordSkip(signal, `Coinbase rejected order: ${msg}`);
      log.error('perp short open failed', { symbol: signal.symbol, reason: msg });
      throw err;
    }

    const fill = await this.awaitFill(resp.order_id, perpProductId);
    const entryPrice = fill?.price ?? currentPrice;
    const filledQty = fill?.size ?? qty;

    const positionId = randomUUID();
    const position: Position = {
      id: positionId,
      // Keep `symbol` as the spot pair so the dashboard's price-keyed
      // `checkExits` lookup, the watchlist UI, and the §6-cap aggregation
      // (which keys on `pos.symbol`) all keep working without special-casing
      // `BTC-PERP-INTX` strings. The actual perp product_id is stashed in
      // `perpProductByPositionId` for the exit-side close.
      symbol: signal.symbol,
      side: 'sell',
      signalType: signal.type,
      signalId: signal.id,
      entryPrice,
      quantity: filledQty,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      openedAt: Date.now(),
      productType: 'perp',
      leverage: PERP_SHORT_LEVERAGE,
      // marginUsd ≈ entry × qty / leverage. At 1× the margin equals the
      // notional — TRA-249 follow-ups will revisit when leverage > 1.
      marginUsd: (entryPrice * filledQty) / PERP_SHORT_LEVERAGE,
      // Informational liquidation price: at 1× isolated, a SHORT liquidates
      // when the underlying doubles (margin = entry × qty exhausted at 2×
      // entry). Coinbase recomputes against funding + mark price as the
      // position moves; we surface the open-time approximation only.
      liquidationPrice: entryPrice * 2,
      // TRA-338 — perp shorts trade off Coinbase INTX, so the entry price
      // necessarily came from Coinbase telemetry; threading the engine's
      // tick-supplied source through keeps the audit trail honest if a
      // future caller (e.g. a manual operator open) supplies something else.
      quoteSource: quoteSource ?? 'coinbase',
    };
    this.positions.set(positionId, position);
    this.perpProductByPositionId.set(positionId, perpProductId);
    // Intentionally no cashUsd debit: ISOLATED perp margin lives in the INTX
    // portfolio, separate from the spot USD wallet `refreshBalance` reads.
    const reconciled = fill
      ? `@ ${entryPrice.toFixed(2)} (filled ${filledQty})`
      : `@ ~${currentPrice.toFixed(2)} (unreconciled)`;
    log.info('OPEN SHORT', {
      symbol: signal.symbol,
      reconciled,
      perpProductId,
      leverage: PERP_SHORT_LEVERAGE,
      marginType: PERP_SHORT_MARGIN_TYPE,
      coinbaseOrderId: resp.order_id,
    });
    return position;
  }

  /**
   * For each open position whose current price has hit TP or SL, send a
   * market order to flatten and record realized P&L locally.
   *
   * TRA-264 — every tick also re-tallies the unrealised P&L of all open
   * shorts and stores it on `openShortsUnrealisedPnlUsd`. This is the only
   * call site with a full prices map, so we hijack it as the refresh point
   * for the §7 daily short circuit breaker's mark-to-market input. Symbols
   * missing from `prices` contribute nothing — the realised side stays
   * exact, the unrealised tally is best-effort.
   */
  async checkExits(prices: Map<string, number>): Promise<Position[]> {
    const closed: Position[] = [];
    let openShortsUnrealised = 0;
    for (const [id, pos] of Array.from(this.positions.entries())) {
      const price = prices.get(pos.symbol);
      if (price == null) continue;

      // Tally unrealised P&L for any open short BEFORE we evaluate exit
      // conditions; if the position closes on this tick we exclude it from
      // the cache (it's about to land in `realizedShortPnlToday` instead).
      if (pos.side === 'sell') {
        openShortsUnrealised += (pos.entryPrice - price) * pos.quantity;
      }

      let hit: 'tp' | 'sl' | null = null;
      if (pos.side === 'buy') {
        if (price >= pos.takeProfit) hit = 'tp';
        else if (price <= pos.stopLoss) hit = 'sl';
      } else {
        if (price <= pos.takeProfit) hit = 'tp';
        else if (price >= pos.stopLoss) hit = 'sl';
      }
      if (!hit) continue;

      // Closing this short — back its mark-to-market contribution out of the
      // tally so realised + cached unrealised don't double-count it.
      if (pos.side === 'sell') {
        openShortsUnrealised -= (pos.entryPrice - price) * pos.quantity;
      }

      // TRA-249-C — resolve the actual perp product_id for the close. Falls
      // back to `pos.symbol` so positions opened pre-catalog (or in tests
      // that don't seed the map) still close cleanly.
      const perpProductId = pos.side === 'sell'
        ? this.perpProductByPositionId.get(id) ?? pos.symbol
        : pos.symbol;

      let exitOrder: CoinbaseOrderSuccessResponse;
      try {
        if (pos.side === 'sell') {
          // TRA-264 — perp short close: route through `closeFuturesPosition`
          // so Coinbase identifies the right INTX position via `position_side`
          // (the trade `side` flips to BUY internally). Same leverage / margin
          // mode the open used so Coinbase doesn't re-quote margin.
          exitOrder = await this.coinbase.closeFuturesPosition({
            productId: perpProductId,
            positionSide: PERP_SHORT_POSITION_SIDE,
            baseSize: pos.quantity,
            leverage: PERP_SHORT_LEVERAGE,
            marginType: PERP_SHORT_MARGIN_TYPE,
          });
        } else {
          exitOrder = await this.coinbase.placeMarketOrder({
            productId: pos.symbol,
            side: 'sell',
            baseSize: pos.quantity,
          });
        }
      } catch (err: unknown) {
        log.error('exit failed — leaving position open, will retry next tick', {
          symbol: pos.symbol,
          reason: err instanceof Error ? err.message : String(err),
        });
        // Re-add the unrealised contribution since we did not actually close.
        if (pos.side === 'sell') {
          openShortsUnrealised += (pos.entryPrice - price) * pos.quantity;
        }
        continue;
      }

      // Prefer the real fill VWAP from Coinbase over our TP/SL trigger price so
      // realized P&L matches the Coinbase statement (TRA-156). Fall back to the
      // trigger price if the historical-orders endpoint doesn't settle in time.
      const exitFill = await this.awaitFill(exitOrder.order_id, perpProductId);
      const triggerPrice = hit === 'tp' ? pos.takeProfit : pos.stopLoss;
      const exitPrice = exitFill?.price ?? triggerPrice;
      const exitQty = exitFill?.size ?? pos.quantity;
      const multiplier = pos.side === 'buy' ? 1 : -1;
      const pricePnl = (exitPrice - pos.entryPrice) * exitQty * multiplier;
      // TRA-249-D — settle accumulated funding into the closed-position
      // record so realized P&L on the closed-positions API matches the
      // Coinbase statement. Funding already flowed into `realizedPnlToday`
      // hourly via `applyFundingAccrual`; only the price-side P&L is
      // accumulated here, otherwise the day's funding would double-count.
      const fundingPnl = pos.fundingPnl ?? 0;
      pos.pnl = pricePnl + fundingPnl;
      pos.closedAt = Date.now();
      pos.exitPrice = exitPrice;
      pos.quantity = exitQty;
      this.realizedPnlToday += pricePnl;
      if (pos.side === 'sell') {
        // TRA-264 — feed the §7 circuit breaker's realised side. Funding has
        // already been counted on each hourly accrual, so only the price
        // side flows in here.
        this.realizedShortPnlToday += pricePnl;
        // Perp short cash settles in INTX, not the spot wallet — leave
        // cashUsd alone. Equity still advances by realised pnl so the
        // dashboard daily P&L stays correct.
        this.equityUsd += pricePnl;
        // TRA-249-C — drop the perp product_id mapping for this position
        // now that the close has settled.
        this.perpProductByPositionId.delete(id);
      } else {
        this.cashUsd += exitPrice * exitQty;
        this.equityUsd += pricePnl;
      }
      this.positions.delete(id);
      closed.push({ ...pos });
      log.info('CLOSE', {
        symbol: pos.symbol,
        hit: hit.toUpperCase(),
        exitPrice: exitPrice.toFixed(2),
        pnl: pos.pnl.toFixed(2),
        ...(fundingPnl !== 0
          ? { pricePnl: pricePnl.toFixed(2), fundingPnl: fundingPnl.toFixed(2) }
          : {}),
      });
    }
    this.openShortsUnrealisedPnlUsd = openShortsUnrealised;
    return closed;
  }

  /**
   * Manual close — flatten via market order at current price. TRA-264 routes
   * perp shorts through `closeFuturesPosition` so Coinbase keys the close to
   * the right INTX position via `position_side`. TRA-318 also accepts
   * imported wallet-holding positions: closing one fires a spot SELL for the
   * full reconciled qty, identical to flattening an engine-opened spot BUY.
   */
  async closePosition(positionId: string, currentPrice: number): Promise<Position | null> {
    const imported = this.importedSpotPositions.get(this.importedKeyFromId(positionId) ?? '');
    if (imported) {
      return this.closeImportedSpot(imported, currentPrice);
    }
    const pos = this.positions.get(positionId);
    if (!pos) return null;
    // TRA-249-C — perp closes route to the actual INTX product_id resolved
    // via the catalog at open time; spot closes keep using the spot symbol.
    const perpProductId = pos.side === 'sell'
      ? this.perpProductByPositionId.get(positionId) ?? pos.symbol
      : pos.symbol;
    let exitOrder: CoinbaseOrderSuccessResponse;
    if (pos.side === 'sell') {
      exitOrder = await this.coinbase.closeFuturesPosition({
        productId: perpProductId,
        positionSide: PERP_SHORT_POSITION_SIDE,
        baseSize: pos.quantity,
        leverage: PERP_SHORT_LEVERAGE,
        marginType: PERP_SHORT_MARGIN_TYPE,
      });
    } else {
      exitOrder = await this.coinbase.placeMarketOrder({
        productId: pos.symbol,
        side: 'sell',
        baseSize: pos.quantity,
      });
    }
    const exitFill = await this.awaitFill(exitOrder.order_id, perpProductId);
    const exitPrice = exitFill?.price ?? currentPrice;
    const exitQty = exitFill?.size ?? pos.quantity;
    const multiplier = pos.side === 'buy' ? 1 : -1;
    const pricePnl = (exitPrice - pos.entryPrice) * exitQty * multiplier;
    // TRA-249-D — same settlement model as `checkExits`: funding was already
    // accrued into `realizedPnlToday` hourly, so only price P&L flows in
    // here. The closed-position record carries the total (price + funding).
    const fundingPnl = pos.fundingPnl ?? 0;
    pos.pnl = pricePnl + fundingPnl;
    pos.exitPrice = exitPrice;
    pos.quantity = exitQty;
    pos.closedAt = Date.now();
    this.realizedPnlToday += pricePnl;
    if (pos.side === 'sell') {
      this.realizedShortPnlToday += pricePnl;
      this.equityUsd += pricePnl;
      this.perpProductByPositionId.delete(positionId);
    } else {
      this.cashUsd += exitPrice * exitQty;
      this.equityUsd += pricePnl;
    }
    this.positions.delete(positionId);
    return { ...pos };
  }

  /**
   * TRA-318 — extract the product_id ({CCY}-USD) from an imported-spot
   * position id of the form `imported-spot-{CCY}-USD`. Returns null for any
   * other id shape so callers can distinguish engine vs imported lookups.
   */
  private importedKeyFromId(positionId: string): string | null {
    const prefix = 'imported-spot-';
    if (!positionId.startsWith(prefix)) return null;
    return positionId.slice(prefix.length);
  }

  /**
   * TRA-318 — flatten an imported wallet holding via spot SELL. Mirrors the
   * spot branch of {@link closePosition} but skips the `this.positions` map
   * (imported positions live in their own map) and drops the entry from
   * `importedSpotPositions` on success. The next `refreshBalance` will
   * rebuild from the post-sell wallet snapshot.
   */
  private async closeImportedSpot(pos: Position, currentPrice: number): Promise<Position> {
    let baseSize = pos.quantity;
    const productInfo = this.tradableProducts?.get(pos.symbol);
    if (productInfo) {
      baseSize = quantizeBaseSize(baseSize, productInfo.baseIncrement);
    }
    if (!Number.isFinite(baseSize) || baseSize <= 0) {
      throw new Error(
        `imported spot ${pos.symbol} qty ${pos.quantity} below Coinbase base_increment — cannot place SELL`,
      );
    }
    const exitOrder = await this.coinbase.placeMarketOrder({
      productId: pos.symbol,
      side: 'sell',
      baseSize,
    });
    const exitFill = await this.awaitFill(exitOrder.order_id, pos.symbol);
    const exitPrice = exitFill?.price ?? currentPrice;
    const exitQty = exitFill?.size ?? baseSize;
    // Imported positions have synthetic entry price (current spot at the
    // last refresh), so realised P&L here is at best a rough mark-to-mark
    // delta. Fold it into the dashboard's daily P&L so the user can see the
    // sale impact, but tag the closed record so reports can ignore it if
    // they care about strictly engine-attributed P&L.
    const pricePnl = (exitPrice - pos.entryPrice) * exitQty;
    const closed: Position = {
      ...pos,
      pnl: pricePnl,
      exitPrice,
      quantity: exitQty,
      closedAt: Date.now(),
    };
    this.realizedPnlToday += pricePnl;
    this.cashUsd += exitPrice * exitQty;
    this.equityUsd += pricePnl;
    this.importedSpotPositions.delete(pos.symbol);
    log.info('CLOSE imported spot', {
      symbol: pos.symbol,
      exitPrice: exitPrice.toFixed(2),
      pnl: pricePnl.toFixed(2),
    });
    return closed;
  }

  /**
   * Reset realized P&L trackers — called on UTC day rollover by the engine.
   * TRA-264 also resets the short-side tally so the §7 circuit breaker
   * starts each new UTC day with a clean slate (per spec: held shorts are
   * NOT auto-flatted, but the day-bound limit resets).
   */
  rolloverDay(): void {
    this.realizedPnlToday = 0;
    this.realizedShortPnlToday = 0;
  }

  /**
   * Poll `GET /orders/historical/{order_id}` until the order reports FILLED,
   * or until the backoff schedule is exhausted. Returns the VWAP price + total
   * filled size. Returns null on:
   *
   * - terminal failure statuses (CANCELLED / EXPIRED / FAILED) — caller should
   *   keep its requested values; refreshBalance will rebalance cash next tick;
   * - timeout (Coinbase still reports OPEN/PENDING after ~5s);
   * - repeated lookup errors.
   *
   * Throwing here would invert the API contract — `placeMarketOrder` already
   * succeeded, so we'd lose the position record entirely. A warning + null
   * keeps us aligned with the legacy "use quote price" behaviour.
   */
  private async awaitFill(orderId: string, symbol: string): Promise<ReconciledFill | null> {
    let lastStatus = 'unknown';
    for (let i = 0; i < FILL_POLL_DELAYS_MS.length; i++) {
      const delay = FILL_POLL_DELAYS_MS[i];
      if (delay > 0) await this.sleep(delay);
      let order: CoinbaseOrderDetails;
      try {
        order = await this.coinbase.getOrder(orderId);
      } catch (err: unknown) {
        log.warn('fill lookup attempt failed', {
          orderId,
          symbol,
          attempt: i + 1,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      lastStatus = (order.status ?? 'unknown').toUpperCase();
      if (lastStatus === 'FILLED') {
        const price = parseFloat(order.average_filled_price);
        const size = parseFloat(order.filled_size);
        if (Number.isFinite(price) && Number.isFinite(size) && price > 0 && size > 0) {
          return { price, size };
        }
        log.warn('fill FILLED with bad numbers', {
          orderId,
          symbol,
          price: order.average_filled_price,
          size: order.filled_size,
        });
        return null;
      }
      if (TERMINAL_FAILURE_STATUSES.has(lastStatus)) {
        log.warn('fill terminal status; cannot reconcile', { orderId, symbol, status: lastStatus });
        return null;
      }
      // OPEN / PENDING — keep polling.
    }
    log.warn('fill did not settle within attempt budget', {
      orderId,
      symbol,
      attempts: FILL_POLL_DELAYS_MS.length,
      lastStatus,
    });
    return null;
  }
}
