import { createHmac, createPrivateKey, createSign, randomBytes, randomUUID } from 'crypto';
import type { KeyObject } from 'crypto';

import type { Side } from '@trading-app/shared';

const DEFAULT_BASE_URL = 'https://api.coinbase.com';
const CDP_JWT_TTL_SECONDS = 120;

export interface CoinbaseOrderClientOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Override clock — handy for tests so HMAC/JWT signatures are deterministic. */
  now?: () => number;
  /** Override JWT nonce — handy for tests so JWT headers are deterministic. */
  nonce?: () => string;
}

export interface CoinbaseAccountBalance {
  uuid: string;
  name: string;
  currency: string;
  available_balance: { value: string; currency: string };
  hold: { value: string; currency: string };
}

interface ListAccountsResponse {
  accounts?: CoinbaseAccountBalance[];
  has_next?: boolean;
  cursor?: string;
  size?: number;
}

/**
 * Coinbase caps `GET /accounts` at 250 results per page (default 49). We page
 * with the max so a user with many auto-created currency accounts gets the
 * USD/USDC/etc. wallets in as few round-trips as possible (TRA-224 follow-up —
 * users with 50+ accounts had their actual USD wallet on page 2 and saw $0
 * equity).
 */
const ACCOUNTS_PAGE_SIZE = 250;
/** Hard ceiling on pages followed; protects against runaway pagination loops. */
const ACCOUNTS_MAX_PAGES = 50;

export interface CoinbaseOrderSuccessResponse {
  order_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  client_order_id: string;
}

interface CreateOrderResponse {
  success: boolean;
  success_response?: CoinbaseOrderSuccessResponse;
  error_response?: { error?: string; message?: string; error_details?: string };
}

/**
 * Subset of `GET /api/v3/brokerage/orders/historical/{order_id}` that we use
 * to reconcile an executed market order to its actual fill price (TRA-156).
 * Coinbase returns more fields; we only model the ones we read.
 */
export interface CoinbaseOrderDetails {
  order_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  /** OPEN, FILLED, CANCELLED, EXPIRED, FAILED, PENDING — string-typed to tolerate forward additions. */
  status: string;
  /** VWAP of all fills so far. "0" while pending. */
  average_filled_price: string;
  /** Total base size filled across all partial fills. */
  filled_size: string;
}

interface GetOrderResponse {
  order: CoinbaseOrderDetails;
}

/**
 * Subset of `GET /api/v3/brokerage/products` we read for three things:
 *
 * - valuing non-USD holdings on the account screen (TRA-224),
 * - quantizing order sizes to the per-product `base_increment` Coinbase
 *   enforces (TRA-243),
 * - discovering the perp catalogue at startup (TRA-249).
 *
 * Coinbase returns many more fields per product; we only model what callers
 * consume.
 */
interface CoinbaseProduct {
  product_id: string;
  /**
   * `'SPOT'` or `'FUTURE'` (perpetuals are returned under FUTURE on the
   * Advanced Trade API). Optional because TRA-224's spot-price lookup ran
   * before this field was modelled and we don't want existing fixtures to
   * break.
   */
  product_type?: string;
  /** Last trade price, stringified — "0" or empty for inactive products. */
  price?: string;
  /**
   * Minimum size step for the base asset, stringified (e.g. `"0.00000001"`
   * for BTC, `"1"` for SHIB). Order amounts must be a multiple of this; sending
   * a finer-grained size yields `Too many decimals in order amount` (TRA-243).
   */
  base_increment?: string;
  /**
   * Coinbase exposes a few orthogonal "is this product currently usable"
   * flags. We treat any of them being true as "inactive" when the catalogue
   * is queried for the perp routing map (TRA-249).
   */
  trading_disabled?: boolean;
  is_disabled?: boolean;
  cancel_only?: boolean;
  /** Free-form lifecycle string, e.g. `online`, `offline`. */
  status?: string;
  /**
   * TRA-249-D — Coinbase nests INTX perpetual telemetry under
   * `future_product_details.perpetual_details`. We only model the funding
   * subset here; the full shape carries open interest, max leverage, etc.
   * Optional throughout because spot products and pre-perp fixtures don't
   * carry the field.
   */
  future_product_details?: {
    perpetual_details?: {
      /** Hourly funding rate as a decimal, stringified (e.g. `"0.0001"` = 0.01% / hour). */
      funding_rate?: string;
      /** ISO-8601 timestamp of the next funding settlement window. */
      funding_time?: string;
      /**
       * TRA-262 — total open interest on this perp, expressed in BASE units
       * (e.g. `"1234.5"` BTC). Multiply by `price` to derive a USD figure for
       * the §5 OI gate. Optional because Coinbase pre-perp fixtures don't
       * carry the field and a freshly-listed perp may publish it later.
       */
      open_interest?: string;
    };
  };
}

interface ListProductsResponse {
  products?: CoinbaseProduct[];
}

/**
 * Per-product market metadata read off `/products` (TRA-243). `price` is the
 * last spot trade and `baseIncrement` is the canonical `base_increment` string
 * preserved verbatim from Coinbase so callers can derive both the numeric
 * step and its exact decimal count without floating-point drift.
 */
export interface CoinbaseProductInfo {
  price: number;
  baseIncrement: string;
}

/**
 * TRA-249-D — current funding telemetry for one Coinbase INTX perp product.
 *
 * Coinbase publishes the funding rate as an hourly fraction (e.g. `0.0001`
 * = 0.01% per hour). The {@link FundingRateTracker} multiplies this by
 * position notional once per hourly tick to charge longs / credit shorts;
 * the magnitude is small but compounds over a multi-hour open and is the
 * difference between matching a Coinbase statement and silently drifting.
 *
 * `nextFundingTimeMs` is informational — useful for diagnostics but not on
 * the accrual hot path; we charge once per local hourly tick rather than
 * trying to align with Coinbase's settlement clock.
 */
export interface CoinbaseFundingRate {
  /** Hourly rate as a decimal. Positive: longs pay shorts. Negative: shorts pay longs. */
  rate: number;
  /** Optional next funding settlement time, ms epoch. */
  nextFundingTimeMs?: number;
}

/**
 * Coinbase perp-only margin mode. Cross is intentionally out of scope for the
 * TRA-249 epic (smaller blast radius, simpler liquidation math); the order
 * client rejects {@link CoinbaseMarginType} `'CROSS'` at submit time so future
 * callers don't accidentally enable it before the engine is ready for it.
 */
export type CoinbaseMarginType = 'ISOLATED' | 'CROSS';

/** Direction of the perp position the order opens or manages. */
export type CoinbasePositionSide = 'LONG' | 'SHORT';

/** Public subset of a Coinbase product entry exposed by {@link CoinbaseOrderClient.listProducts}. */
export interface CoinbaseListedProduct {
  product_id: string;
  product_type?: string;
  price?: string;
  status?: string;
  /**
   * TRA-262 — perp-only telemetry parsed off `future_product_details.perpetual_details`.
   * Spot products and perps with no published values omit the field entirely so
   * callers can `if (p.perp)` to gate perp-specific code paths without
   * defensive null checks at every read site.
   */
  perp?: CoinbasePerpMetrics;
}

/**
 * TRA-262 — per-perp metrics needed by the strategy-layer §5 short filters.
 *
 * Funding rate is the hourly fraction Coinbase publishes; the funding gate
 * trips at ≤ -0.05%/h (TRA-261 spec). `openInterestUsd` is precomputed at
 * fetch time (`open_interest × mark/last price`) so the live broker doesn't
 * have to redo the conversion on every gate evaluation, and so a missing
 * price (perp without a last trade) cleanly degrades the field to undefined
 * instead of producing a `NaN` that would silently bypass the OI gate.
 *
 * All fields are optional: a perp that publishes funding but not OI yet
 * (or vice versa) still routes the available field through and skips the
 * gate that's missing input.
 */
export interface CoinbasePerpMetrics {
  /** Hourly funding rate as a decimal (positive = longs pay shorts). */
  fundingRatePerHour?: number;
  /** Optional next funding settlement time, ms epoch. Informational. */
  nextFundingTimeMs?: number;
  /** 24h open interest in USD: `open_interest (base units) × price`. */
  openInterestUsd?: number;
}

/**
 * TRA-262 — top-of-book snapshot for one Coinbase product, used by the §5
 * spread gate to suppress perp shorts when round-trip cost on the book would
 * exceed 10 bps of mid. Keeps numeric vs. string parsing centralised in
 * {@link CoinbaseOrderClient.getProductBook} so the live broker reads
 * already-validated floats.
 *
 * `spreadFraction = (bestAsk - bestBid) / mid`, with `mid = (bestBid + bestAsk) / 2`.
 * Undefined when either side is missing or when both sides are zero (a halted
 * book) — the spread gate degrades to "skipped" rather than being fed a
 * synthetic value that would silently pass.
 */
export interface CoinbaseProductBook {
  bestBid?: number;
  bestAsk?: number;
  midPrice?: number;
  spreadFraction?: number;
}

interface ProductBookEntry {
  price?: string;
  size?: string;
}

interface ProductBookResponse {
  pricebook?: {
    product_id?: string;
    bids?: ProductBookEntry[];
    asks?: ProductBookEntry[];
    time?: string;
  };
}

/**
 * Subset of `GET /api/v3/brokerage/portfolios` we read to resolve the INTX
 * (perpetuals) portfolio uuid before fetching positions. Coinbase splits a
 * user's account across multiple portfolios — DEFAULT for spot, INTX for
 * perpetual futures — and the positions endpoint is portfolio-scoped.
 */
interface CoinbasePortfolio {
  uuid: string;
  name?: string;
  type?: string;
  deleted?: boolean;
}

interface ListPortfoliosResponse {
  portfolios?: CoinbasePortfolio[];
}

/**
 * Subset of a Coinbase INTX position entry. Coinbase returns more telemetry
 * (margin contributions, mark price decay, etc.) but the live account only
 * needs enough to reconcile open size, direction, and P&L on startup
 * (TRA-249).
 */
export interface CoinbaseFuturesPosition {
  product_id: string;
  position_side: CoinbasePositionSide;
  /** Open size in the base asset, stringified. Always non-negative; direction is conveyed by `position_side`. */
  net_size: string;
  /** Volume-weighted average entry price across all fills that built this position. */
  vwap?: string;
  mark_price?: string;
  liquidation_price?: string;
  unrealized_pnl?: string;
  leverage?: string;
  margin_type?: CoinbaseMarginType;
}

interface ListIntxPositionsResponse {
  positions?: CoinbaseFuturesPosition[];
}

export interface MarketOrderParams {
  productId: string;
  side: Side;
  /** Amount of the base asset to trade (e.g. 0.001 BTC). Used for SELL and for size-based BUYs. */
  baseSize?: number;
  /** Amount of the quote asset to spend (e.g. 25 USD). Used for BUYs when sizing in dollars. */
  quoteSize?: number;
  clientOrderId?: string;
  /**
   * Perp leverage multiplier (TRA-249). Omit for spot — when present and
   * combined with {@link MarketOrderParams.positionSide}, the order client
   * adds the `leverage` / `margin_type` / `position_side` fields Coinbase's
   * INTX perp endpoint expects. The first epic pass caps at 1x.
   */
  leverage?: number;
  /** Perp margin mode (TRA-249). Only `'ISOLATED'` is in scope; `'CROSS'` is rejected at submit time. */
  marginType?: CoinbaseMarginType;
  /**
   * Direction of the underlying perp position (TRA-249). Required for perp
   * orders so that BUY/SELL refers to the trade and `position_side` carries
   * the directional intent: opening a SHORT is `side: 'sell', positionSide:
   * 'SHORT'`; closing it is `side: 'buy', positionSide: 'SHORT'`.
   */
  positionSide?: CoinbasePositionSide;
}

export interface LimitOrderParams {
  productId: string;
  side: Side;
  baseSize: number;
  limitPrice: number;
  postOnly?: boolean;
  clientOrderId?: string;
}

export type CoinbaseAuthScheme = 'hmac' | 'cdp';

/**
 * Coinbase Advanced Trade REST client.
 *
 * Supports both auth flavours Coinbase exposes today:
 *
 * - **HMAC** (legacy): apiSecret is a printable shared secret. Each request is
 *   signed with `CB-ACCESS-KEY` / `CB-ACCESS-TIMESTAMP` / `CB-ACCESS-SIGN`,
 *   where the signature is HMAC-SHA256 of `timestamp + method + path + body`.
 * - **CDP / JWT** (current): apiKey is the key name (e.g.
 *   `organizations/.../apiKeys/...`) and apiSecret is a PEM-encoded EC private
 *   key. Each request is authenticated with a short-lived ES256 JWT in the
 *   `Authorization: Bearer ...` header, claiming `uri = METHOD host+path` and
 *   expiring after {@link CDP_JWT_TTL_SECONDS}.
 *
 * The scheme is detected at construction by sniffing the secret for a PEM
 * `-----BEGIN` marker, so callers (e.g. `CryptoLiveAccount`) don't need to know
 * which credential type the operator provisioned.
 *
 * The base/quote sizes are stringified with toFixed(8) before signing so the
 * body sent over the wire matches the body fed into the signer, and so we
 * don't lose precision on small fractional crypto amounts.
 */
export class CoinbaseOrderClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly host: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly authScheme: CoinbaseAuthScheme;
  private readonly cdpPrivateKey: KeyObject | null;

  constructor(opts: CoinbaseOrderClientOptions) {
    if (!opts.apiKey || !opts.apiSecret) {
      throw new Error('CoinbaseOrderClient requires apiKey and apiSecret');
    }
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.host = new URL(this.baseUrl).host;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.nonce = opts.nonce ?? (() => randomBytes(16).toString('hex'));

    const normalized = normalizeCdpSecret(opts.apiSecret);
    if (looksLikePem(normalized)) {
      this.authScheme = 'cdp';
      try {
        this.cdpPrivateKey = createPrivateKey({ key: normalized, format: 'pem' });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `CoinbaseOrderClient: failed to parse CDP private key: ${msg}. ` +
            `Make sure you pasted the entire key including the -----BEGIN/-----END lines.`,
        );
      }
    } else {
      this.authScheme = 'hmac';
      this.cdpPrivateKey = null;
    }
  }

  /** Returns the auth scheme detected from the supplied credentials. Exposed for diagnostics. */
  getAuthScheme(): CoinbaseAuthScheme {
    return this.authScheme;
  }

  /** Compute the CB-ACCESS-SIGN header for a given request (HMAC scheme only). Exposed for testing. */
  signRequest(timestamp: string, method: string, requestPath: string, body: string): string {
    return createHmac('sha256', this.apiSecret)
      .update(timestamp + method.toUpperCase() + requestPath + body)
      .digest('hex');
  }

  /**
   * Build a short-lived ES256 JWT for the given request (CDP scheme only).
   * Throws if the client was constructed with HMAC credentials. Exposed for testing.
   */
  buildCdpJwt(method: string, requestPath: string): string {
    if (!this.cdpPrivateKey) {
      throw new Error('buildCdpJwt called on a non-CDP client');
    }
    const nowSec = this.now();
    const header = {
      alg: 'ES256',
      kid: this.apiKey,
      typ: 'JWT',
      nonce: this.nonce(),
    };
    // Coinbase's CDP authenticator strips the query string before validating
    // the `uri` claim (their official SDK builds the claim from
    // `urlparse(url).path` only). Including the query here makes
    // GET /api/v3/brokerage/products?product_ids=... 401 with `Unauthorized`,
    // which silently broke the TRA-224 spot-price lookup. Strip it here so
    // the claim matches what Coinbase computes server-side, while the actual
    // fetch URL still carries the full query string (TRA-224 follow-up).
    const queryIdx = requestPath.indexOf('?');
    const pathOnly = queryIdx >= 0 ? requestPath.slice(0, queryIdx) : requestPath;
    const payload = {
      sub: this.apiKey,
      iss: 'cdp',
      nbf: nowSec,
      exp: nowSec + CDP_JWT_TTL_SECONDS,
      // Coinbase verifies this claim against the actual request — METHOD + space + host + path, no query, no scheme.
      uri: `${method.toUpperCase()} ${this.host}${pathOnly}`,
    };
    const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
    const signingInput = `${headerB64}.${payloadB64}`;
    // dsaEncoding: 'ieee-p1363' yields the raw R||S 64-byte signature JWS expects;
    // without it Node returns a DER-encoded blob and Coinbase rejects with `Invalid signature`.
    const sig = createSign('SHA256')
      .update(signingInput)
      .sign({ key: this.cdpPrivateKey, dsaEncoding: 'ieee-p1363' });
    return `${signingInput}.${base64UrlEncode(sig)}`;
  }

  /**
   * GET /api/v3/brokerage/accounts — returns balances by currency.
   *
   * Coinbase auto-creates an account for every supported currency the user
   * has interacted with, and the endpoint paginates (default 49, max 250).
   * We follow `cursor` while `has_next` is true so the primary USD/USDC
   * wallet is included even when it lands past page 1 — without this,
   * `refreshBalance` saw only a slice of the user's accounts and reported
   * a fraction of true equity (TRA-224 follow-up).
   */
  async listAccounts(): Promise<CoinbaseAccountBalance[]> {
    const all: CoinbaseAccountBalance[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ACCOUNTS_MAX_PAGES; page++) {
      const params = new URLSearchParams();
      params.set('limit', String(ACCOUNTS_PAGE_SIZE));
      if (cursor) params.set('cursor', cursor);
      const path = `/api/v3/brokerage/accounts?${params.toString()}`;
      const data = await this.request<ListAccountsResponse>('GET', path, '');
      if (data.accounts) all.push(...data.accounts);
      if (!data.has_next || !data.cursor) return all;
      cursor = data.cursor;
    }
    console.warn(
      `[coinbase] listAccounts hit page cap (${ACCOUNTS_MAX_PAGES}); returning ${all.length} accounts. ` +
        `Some balances may be missing.`,
    );
    return all;
  }

  /**
   * GET /api/v3/brokerage/products?product_ids=... — return spot prices and
   * sizing increments for the requested products (TRA-224, TRA-243).
   *
   * Used both to value non-USD holdings into USD equity (price) and to quantize
   * market-order base sizes to Coinbase's per-product step (baseIncrement). The
   * returned Map's keys double as the "tradable" set: a product Coinbase no
   * longer lists is silently absent rather than an error, which matches how
   * `CryptoLiveAccount.refreshTradableProducts` uses this to skip stale tickers
   * (TRA-243). Products with an unparseable price OR increment are dropped —
   * sending an order without a known step is the more harmful failure mode.
   */
  async getProducts(productIds: string[]): Promise<Map<string, CoinbaseProductInfo>> {
    const out = new Map<string, CoinbaseProductInfo>();
    if (productIds.length === 0) return out;
    const params = new URLSearchParams();
    for (const id of productIds) params.append('product_ids', id);
    const path = `/api/v3/brokerage/products?${params.toString()}`;
    const data = await this.request<ListProductsResponse>('GET', path, '');
    for (const p of data.products ?? []) {
      const price = parseFloat(p.price ?? '');
      if (!Number.isFinite(price) || price <= 0) continue;
      const incrementStr = (p.base_increment ?? '').trim();
      const incrementNum = parseFloat(incrementStr);
      if (!Number.isFinite(incrementNum) || incrementNum <= 0) continue;
      out.set(p.product_id, { price, baseIncrement: incrementStr });
    }
    return out;
  }

  /**
   * Spot-price-only lookup for valuation paths (TRA-224). Used for sizing
   * non-USD account balances on the live dashboard equity. Looser filtering
   * than {@link getProducts}: a product with a price but no `base_increment`
   * still values into equity rather than being dropped, since a missing
   * increment only blocks order placement (not display).
   */
  async getProductPrices(productIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (productIds.length === 0) return out;
    const params = new URLSearchParams();
    for (const id of productIds) params.append('product_ids', id);
    const path = `/api/v3/brokerage/products?${params.toString()}`;
    const data = await this.request<ListProductsResponse>('GET', path, '');
    for (const p of data.products ?? []) {
      const v = parseFloat(p.price ?? '');
      if (Number.isFinite(v) && v > 0) out.set(p.product_id, v);
    }
    return out;
  }

  /**
   * GET /api/v3/brokerage/products?product_ids=... — pull the per-product
   * funding rate for one or more INTX perp products (TRA-249-D).
   *
   * Coinbase nests funding under `future_product_details.perpetual_details`;
   * a product without that block (spot, or a perp with no published rate)
   * is silently absent from the returned map so callers can iterate without
   * special-casing missing entries. Same `?product_ids=...` shape as
   * {@link getProducts} so a single round-trip covers every open perp the
   * funding tracker is accruing.
   *
   * Best-effort: a non-finite or unparseable rate is dropped rather than
   * coerced to 0 — a phantom 0 charge would silently mask a real Coinbase
   * outage.
   */
  async getFundingRates(productIds: string[]): Promise<Map<string, CoinbaseFundingRate>> {
    const out = new Map<string, CoinbaseFundingRate>();
    if (productIds.length === 0) return out;
    const params = new URLSearchParams();
    for (const id of productIds) params.append('product_ids', id);
    const path = `/api/v3/brokerage/products?${params.toString()}`;
    const data = await this.request<ListProductsResponse>('GET', path, '');
    for (const p of data.products ?? []) {
      const rateStr = p.future_product_details?.perpetual_details?.funding_rate;
      if (rateStr == null) continue;
      const rate = parseFloat(rateStr);
      if (!Number.isFinite(rate)) continue;
      const fundingTimeStr = p.future_product_details?.perpetual_details?.funding_time;
      const nextFundingMs = fundingTimeStr ? Date.parse(fundingTimeStr) : NaN;
      out.set(p.product_id, {
        rate,
        nextFundingTimeMs: Number.isFinite(nextFundingMs) ? nextFundingMs : undefined,
      });
    }
    return out;
  }

  /**
   * GET /api/v3/brokerage/products?product_type=... — list the active product
   * catalogue for one Coinbase product family (TRA-249).
   *
   * Used by the live account to discover the perp catalogue at startup so the
   * spot→perp routing map is data-driven instead of hard-coded. Inactive
   * entries (`trading_disabled`, `is_disabled`, or `cancel_only`) are dropped
   * here so callers don't need to redo that filter. Coinbase exposes a few
   * orthogonal lifecycle flags; we treat any of them being true as inactive.
   *
   * TRA-262 — for `productType === 'FUTURE'` we additionally surface the
   * perp telemetry needed by the §5 short filters (funding rate per-hour,
   * next funding time, 24h open interest in USD). Fields are optional on the
   * returned shape: a perp that publishes funding but not OI yet (or vice
   * versa) routes the partial set through, and the strategy layer's gate
   * pipeline skips any filter whose input is undefined per its "best effort"
   * contract.
   */
  async listProducts(productType: 'SPOT' | 'FUTURE'): Promise<CoinbaseListedProduct[]> {
    const params = new URLSearchParams();
    params.set('product_type', productType);
    const path = `/api/v3/brokerage/products?${params.toString()}`;
    const data = await this.request<ListProductsResponse>('GET', path, '');
    const out: CoinbaseListedProduct[] = [];
    for (const p of data.products ?? []) {
      if (p.trading_disabled || p.is_disabled || p.cancel_only) continue;
      out.push({
        product_id: p.product_id,
        product_type: p.product_type,
        price: p.price,
        status: p.status,
        perp: parsePerpMetrics(p),
      });
    }
    return out;
  }

  /**
   * GET /api/v3/brokerage/product_book?product_id=...&limit=1 — fetch the top
   * of book for one product so callers can derive the live `(ask - bid) / mid`
   * spread (TRA-262).
   *
   * Coinbase's Advanced Trade product_book endpoint returns the L2 book at
   * the requested depth; `limit=1` is the cheapest call and is sufficient for
   * the §5 spread gate, which only inspects the best bid/ask pair. Numeric
   * parsing is centralised here so the live broker can read already-validated
   * floats — a missing or non-finite side degrades the whole snapshot to
   * undefined fields rather than emitting a synthetic spread that would
   * silently pass the gate.
   *
   * Best-effort: a non-2xx response throws (so transient outages are loud,
   * not silent), but a stale or one-sided book yields an object with the
   * bidside / askside left undefined. The 10 bps gate inside
   * `evaluateShortFilters` skips when its `spreadFraction` input is undefined.
   */
  async getProductBook(productId: string): Promise<CoinbaseProductBook> {
    if (!productId) throw new Error('getProductBook requires productId');
    const params = new URLSearchParams();
    params.set('product_id', productId);
    params.set('limit', '1');
    const path = `/api/v3/brokerage/product_book?${params.toString()}`;
    const data = await this.request<ProductBookResponse>('GET', path, '');
    const bidStr = data.pricebook?.bids?.[0]?.price;
    const askStr = data.pricebook?.asks?.[0]?.price;
    const bid = bidStr != null ? parseFloat(bidStr) : NaN;
    const ask = askStr != null ? parseFloat(askStr) : NaN;
    const bestBid = Number.isFinite(bid) && bid > 0 ? bid : undefined;
    const bestAsk = Number.isFinite(ask) && ask > 0 ? ask : undefined;
    if (bestBid == null || bestAsk == null) return { bestBid, bestAsk };
    if (bestAsk < bestBid) {
      // Crossed/inverted book — Coinbase shouldn't return this on a live
      // product but we've seen one-tick crosses on illiquid alts. Drop the
      // spread rather than emitting a negative fraction the gate would
      // misread as "tight".
      return { bestBid, bestAsk };
    }
    const midPrice = (bestBid + bestAsk) / 2;
    if (!(midPrice > 0)) return { bestBid, bestAsk };
    const spreadFraction = (bestAsk - bestBid) / midPrice;
    return { bestBid, bestAsk, midPrice, spreadFraction };
  }

  /**
   * GET /api/v3/brokerage/portfolios — return the user's portfolios, optionally
   * filtered by type. Coinbase splits an account across multiple portfolios
   * (`DEFAULT` for spot, `INTX` for perpetual futures); the perp positions
   * endpoint is portfolio-scoped, so we expose this so the live account can
   * resolve the INTX uuid at startup before reconciling open perp positions
   * (TRA-249). Deleted portfolios are filtered out so callers never reconcile
   * against a tombstoned account.
   */
  async listPortfolios(portfolioType?: 'DEFAULT' | 'INTX' | 'CONSUMER' | 'CFM'): Promise<CoinbasePortfolio[]> {
    const params = new URLSearchParams();
    if (portfolioType) params.set('portfolio_type', portfolioType);
    const qs = params.toString();
    const path = `/api/v3/brokerage/portfolios${qs ? `?${qs}` : ''}`;
    const data = await this.request<ListPortfoliosResponse>('GET', path, '');
    return (data.portfolios ?? []).filter((p) => !p.deleted);
  }

  /**
   * GET /api/v3/brokerage/intx/positions/{portfolio_uuid} — list open perp
   * positions for one INTX portfolio (TRA-249).
   *
   * Used by the live account on startup to reconcile any positions opened
   * directly in the Coinbase UI before the engine took over. The portfolio
   * uuid is caller-supplied so the order client stays single-purpose; pair
   * with {@link CoinbaseOrderClient.listPortfolios} on the caller side to
   * resolve the INTX uuid first.
   */
  async listFuturesPositions(portfolioUuid: string): Promise<CoinbaseFuturesPosition[]> {
    if (!portfolioUuid) {
      throw new Error('listFuturesPositions requires a portfolio uuid');
    }
    const path = `/api/v3/brokerage/intx/positions/${encodeURIComponent(portfolioUuid)}`;
    const data = await this.request<ListIntxPositionsResponse>('GET', path, '');
    return data.positions ?? [];
  }

  /**
   * Convenience wrapper that flattens an open perp position via a market
   * order (TRA-249).
   *
   * For an open `SHORT`, closing means buying back the base asset, so the
   * trade `side` flips to BUY while `position_side` stays `SHORT` — Coinbase
   * uses `position_side` to identify *which* directional position the order
   * is touching, not which way the trade goes. Symmetric for `LONG`.
   * `leverage` and `marginType` should match the open position so the close
   * order doesn't accidentally inflate the margin requirement.
   */
  async closeFuturesPosition(params: {
    productId: string;
    positionSide: CoinbasePositionSide;
    baseSize: number;
    leverage?: number;
    marginType?: CoinbaseMarginType;
    clientOrderId?: string;
  }): Promise<CoinbaseOrderSuccessResponse> {
    const closeSide: Side = params.positionSide === 'LONG' ? 'sell' : 'buy';
    return this.placeMarketOrder({
      productId: params.productId,
      side: closeSide,
      baseSize: params.baseSize,
      leverage: params.leverage,
      marginType: params.marginType,
      positionSide: params.positionSide,
      clientOrderId: params.clientOrderId,
    });
  }

  /**
   * GET /api/v3/brokerage/orders/historical/{order_id} — fetch the canonical
   * order record so callers can reconcile a market order to its actual fill
   * price and filled size (TRA-156).
   */
  async getOrder(orderId: string): Promise<CoinbaseOrderDetails> {
    const path = `/api/v3/brokerage/orders/historical/${encodeURIComponent(orderId)}`;
    const data = await this.request<GetOrderResponse>('GET', path, '');
    return data.order;
  }

  /**
   * POST /api/v3/brokerage/orders — places an immediate-or-cancel market order.
   *
   * For `side: 'buy'` you may pass either `quoteSize` (USD to spend) or
   * `baseSize` (units of base). For `side: 'sell'` pass `baseSize`.
   */
  async placeMarketOrder(params: MarketOrderParams): Promise<CoinbaseOrderSuccessResponse> {
    if (!params.baseSize && !params.quoteSize) {
      throw new Error('placeMarketOrder requires baseSize or quoteSize');
    }
    // CROSS margin is intentionally out of scope for the TRA-249 perp epic.
    // Reject here so a typo in a downstream caller can't quietly route a CROSS
    // order through to Coinbase before the engine knows how to manage one.
    if (params.marginType === 'CROSS') {
      throw new Error('placeMarketOrder: CROSS margin is not supported (TRA-249 scope: ISOLATED only)');
    }

    const market: Record<string, string> = {};
    if (params.baseSize != null) market.base_size = formatSize(params.baseSize);
    if (params.quoteSize != null) market.quote_size = formatSize(params.quoteSize);

    // Body construction is intentionally additive: when no perp fields are
    // supplied, the resulting JSON is byte-identical to the pre-TRA-249 spot
    // body so existing spot callers see no behavioural change.
    const body: Record<string, unknown> = {
      client_order_id: params.clientOrderId ?? randomUUID(),
      product_id: params.productId,
      side: params.side.toUpperCase(),
      order_configuration: { market_market_ioc: market },
    };
    if (params.leverage != null) body.leverage = String(params.leverage);
    if (params.marginType != null) body.margin_type = params.marginType;
    if (params.positionSide != null) body.position_side = params.positionSide;

    return this.submitOrder(body);
  }

  /**
   * POST /api/v3/brokerage/orders — places a good-till-cancelled limit order.
   * Used for take-profit / stop levels when a strategy wants resting orders
   * rather than reactive market exits.
   */
  async placeLimitOrder(params: LimitOrderParams): Promise<CoinbaseOrderSuccessResponse> {
    const body = {
      client_order_id: params.clientOrderId ?? randomUUID(),
      product_id: params.productId,
      side: params.side.toUpperCase(),
      order_configuration: {
        limit_limit_gtc: {
          base_size: formatSize(params.baseSize),
          limit_price: formatSize(params.limitPrice),
          post_only: params.postOnly ?? false,
        },
      },
    };

    return this.submitOrder(body);
  }

  private async submitOrder(body: unknown): Promise<CoinbaseOrderSuccessResponse> {
    const path = '/api/v3/brokerage/orders';
    const resp = await this.request<CreateOrderResponse>('POST', path, body);
    if (!resp.success || !resp.success_response) {
      const err = resp.error_response;
      // TRA-243 — `||` not `??`: Coinbase sometimes returns an error_response
      // shaped like `{ error_details: "" }` (empty strings, not nulls), and
      // `??` would short-circuit on the empty string and emit "Coinbase order
      // rejected:" with no diagnosis text. `||` falls through empty fields
      // to the next non-empty one, ending at "unknown error" if all blank.
      const detail = err?.error_details || err?.message || err?.error || 'unknown error';
      throw new Error(`Coinbase order rejected: ${detail}`);
    }
    return resp.success_response;
  }

  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    const bodyString = body === '' || body == null ? '' : JSON.stringify(body);
    const headers = this.buildAuthHeaders(method, path, bodyString);

    const resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: method === 'GET' || bodyString === '' ? undefined : bodyString,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Coinbase ${method} ${path} failed (${resp.status}): ${text || resp.statusText}`);
    }

    return resp.json() as Promise<T>;
  }

  private buildAuthHeaders(method: string, path: string, bodyString: string): Record<string, string> {
    const base: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.authScheme === 'cdp') {
      base.Authorization = `Bearer ${this.buildCdpJwt(method, path)}`;
      return base;
    }
    const timestamp = String(this.now());
    base['CB-ACCESS-KEY'] = this.apiKey;
    base['CB-ACCESS-TIMESTAMP'] = timestamp;
    base['CB-ACCESS-SIGN'] = this.signRequest(timestamp, method, path, bodyString);
    return base;
  }
}

/** Format a size/price for Coinbase. Coinbase accepts up to 8 decimal places. */
function formatSize(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`invalid size: ${n}`);
  return n.toFixed(8).replace(/\.?0+$/, '') || '0';
}

/**
 * TRA-262 — extract {@link CoinbasePerpMetrics} from one raw `/products`
 * entry. Returns `undefined` for spot products (no `future_product_details`
 * block) and for perps that publish neither funding nor OI yet, so the
 * caller's `if (p.perp)` check stays meaningful. OI is converted to USD here
 * (`open_interest × price`) because the §5 OI gate takes USD; doing the
 * conversion at parse time avoids redoing it on every gate evaluation and
 * cleanly degrades a missing price to "OI undefined" instead of producing
 * a NaN that would silently bypass the gate.
 */
function parsePerpMetrics(p: CoinbaseProduct): CoinbasePerpMetrics | undefined {
  const perp = p.future_product_details?.perpetual_details;
  if (!perp) return undefined;
  const out: CoinbasePerpMetrics = {};
  if (perp.funding_rate != null) {
    const r = parseFloat(perp.funding_rate);
    if (Number.isFinite(r)) out.fundingRatePerHour = r;
  }
  if (perp.funding_time) {
    const ms = Date.parse(perp.funding_time);
    if (Number.isFinite(ms)) out.nextFundingTimeMs = ms;
  }
  if (perp.open_interest != null) {
    const oiBase = parseFloat(perp.open_interest);
    const px = parseFloat(p.price ?? '');
    if (Number.isFinite(oiBase) && oiBase >= 0 && Number.isFinite(px) && px > 0) {
      out.openInterestUsd = oiBase * px;
    }
  }
  if (
    out.fundingRatePerHour === undefined
    && out.nextFundingTimeMs === undefined
    && out.openInterestUsd === undefined
  ) {
    return undefined;
  }
  return out;
}

function looksLikePem(s: string): boolean {
  return s.includes('-----BEGIN') && s.includes('-----END');
}

/**
 * Coerce whatever the user pasted into the API Secret field into a PEM string
 * Node's `createPrivateKey` will accept (TRA-222).
 *
 * The Settings UI stores this value in a single-line `<input type="password">`,
 * which strips the real newlines out of a pasted multi-line PEM. JSON-flavoured
 * downloads from the Coinbase CDP console come with literal "\n" escape
 * sequences instead of real newlines. Either form fails OpenSSL with
 * `DECODER routines::unsupported`. Recover by:
 *
 *   1. trimming whitespace and any wrapping quote characters,
 *   2. unwrapping a `{ "name": ..., "privateKey": "..." }` blob if present,
 *   3. converting literal "\n" / "\r\n" sequences to real newlines,
 *   4. re-flowing the body into 64-char base64 lines if everything ended up on
 *      a single line (the no-newline paste case).
 *
 * The result is only used to parse the key — the original `apiSecret` is kept
 * verbatim for the HMAC path so legacy printable-secret callers are unaffected.
 */
export function normalizeCdpSecret(raw: string): string {
  let s = raw.trim();
  // Strip a single layer of wrapping quotes (users sometimes paste with the
  // surrounding "..." from a JSON snippet or shell variable).
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Coinbase's CDP key download is a JSON blob with `name` + `privateKey`. If
  // the user pasted the whole file, extract the private key field.
  if (s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s) as { privateKey?: unknown };
      if (typeof parsed.privateKey === 'string') {
        s = parsed.privateKey.trim();
      }
    } catch {
      // Fall through — not JSON, treat as raw text.
    }
  }
  // JSON-escaped or single-line-input pastes contain literal "\n" / "\r\n"
  // escape sequences. Real PEM needs real newlines.
  s = s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
  // If the input still has BEGIN/END markers but no real newline anywhere
  // (the single-line `<input>` strip case), rebuild a proper PEM by
  // re-wrapping the base64 body at 64 chars.
  if (!s.includes('\n') && /-----BEGIN [^-]+-----/.test(s) && /-----END [^-]+-----/.test(s)) {
    const beginMatch = s.match(/-----BEGIN [^-]+-----/);
    const endMatch = s.match(/-----END [^-]+-----/);
    if (beginMatch && endMatch) {
      const begin = beginMatch[0];
      const end = endMatch[0];
      const bodyStart = (beginMatch.index ?? 0) + begin.length;
      const bodyEnd = endMatch.index ?? s.length;
      const body = s.slice(bodyStart, bodyEnd).replace(/\s+/g, '');
      const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
      s = `${begin}\n${wrapped}\n${end}\n`;
    }
  }
  return s;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
