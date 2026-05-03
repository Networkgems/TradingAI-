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
 * Subset of `GET /api/v3/brokerage/products` we read for valuing non-USD
 * holdings on the account screen (TRA-224) and quantizing order sizes to the
 * per-product `base_increment` Coinbase enforces (TRA-243).
 */
interface CoinbaseProduct {
  product_id: string;
  /** Last trade price, stringified — "0" or empty for inactive products. */
  price?: string;
  /**
   * Minimum size step for the base asset, stringified (e.g. `"0.00000001"`
   * for BTC, `"1"` for SHIB). Order amounts must be a multiple of this; sending
   * a finer-grained size yields `Too many decimals in order amount` (TRA-243).
   */
  base_increment?: string;
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

export interface MarketOrderParams {
  productId: string;
  side: Side;
  /** Amount of the base asset to trade (e.g. 0.001 BTC). Used for SELL and for size-based BUYs. */
  baseSize?: number;
  /** Amount of the quote asset to spend (e.g. 25 USD). Used for BUYs when sizing in dollars. */
  quoteSize?: number;
  clientOrderId?: string;
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

    const market: Record<string, string> = {};
    if (params.baseSize != null) market.base_size = formatSize(params.baseSize);
    if (params.quoteSize != null) market.quote_size = formatSize(params.quoteSize);

    const body = {
      client_order_id: params.clientOrderId ?? randomUUID(),
      product_id: params.productId,
      side: params.side.toUpperCase(),
      order_configuration: { market_market_ioc: market },
    };

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
