import type { RequestHandler } from 'express';

// TRA-2298 — HTTP response hardening: security headers + a CORS allowlist.
//
// Split out of `index.ts` so the two decisions that can BREAK A LIVE CONSUMER
// (which origin gets an `Access-Control-Allow-Origin`, and whether HSTS goes
// out) are pure functions with a test around each branch, rather than four
// `res.setHeader` lines buried at line 1042 of a 10k-line file.
//
// ── Who actually talks to this server cross-origin ───────────────────────────
//
// TRA-2298's suggested fix said "allowlist `APP_URL` plus the Tauri desktop
// origin". That list is INCOMPLETE, and shipping it would have taken the public
// web app off the air. Measured 2026-07-25 against the live bytes:
//
//   $ curl -s https://networkgems.github.io/TradingAI-/assets/index-*.js \
//       | grep -o 'wss\?://[a-zA-Z0-9.-]*'
//   wss://tradingai-bqb1.onrender.com
//
// The GitHub Pages build (`deploy-pages.yml`, `VITE_BASE=/TradingAI-/`) is a
// real, live, CROSS-ORIGIN browser consumer of this API — see `server-url.ts`
// resolution step 4, which exists precisely because that site has no backend of
// its own. It is the one consumer for which `*` was actually load-bearing.
//
// The packaged Tauri desktop app is the opposite case: `server-url.ts` step 2
// resolves it to `ws://localhost:4242`, and the desktop release build does not
// bake `VITE_SERVER_URL` (only the Pages workflow does), so it talks to a LOCAL
// server — which runs this same middleware. Its webview origin still has to be
// on the list, just for the local hop.
//
// ── Why a non-allowlisted origin is answered, not refused ────────────────────
//
// CORS is enforced by the BROWSER, not by us. So a disallowed origin simply
// gets no `Access-Control-Allow-Origin` header and the browser drops the
// response. We never reject the request itself, because a request with NO
// `Origin` at all — curl, the ops scripts, `tra425_full_regression.mjs`, any
// server-to-server caller — is indistinguishable at the wire from a hostile one
// and is the overwhelming majority of non-browser traffic here. Refusing those
// would break every operational tool on the box to buy nothing: a non-browser
// client can forge any `Origin` it likes, so origin-based *rejection* is not a
// security boundary. The auth check is the boundary; this is defence in depth.

/** Tauri v2 webview origins. The scheme differs by platform, so all three ship. */
export const TAURI_ORIGINS: readonly string[] = [
  'tauri://localhost', // macOS, Linux, iOS
  'http://tauri.localhost', // Windows, Android
  'https://tauri.localhost', // Windows (older webview2 builds)
];

/** Loopback origins: Tauri dev (:1420), vite dev (:5173), server-hosted web (:4242). */
export const LOCAL_ORIGINS: readonly string[] = [
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4242',
  'http://127.0.0.1:4242',
];

/** The public web build. Proven live cross-origin consumer — see header. */
export const PAGES_ORIGIN = 'https://networkgems.github.io';

/**
 * TRA-4479 — the `trust proxy` setting, as a HOP COUNT rather than `true`.
 *
 * `app.set('trust proxy', true)` trusts the WHOLE `X-Forwarded-For` chain, and
 * express then reports the LEFTMOST entry as `req.ip`. The leftmost entry is
 * whatever the caller typed: Render's edge APPENDS the real address, it does not
 * replace the header. So `req.ip` was a caller-supplied string.
 *
 * Measured 2026-09-09 against express in this workspace, `X-Forwarded-For:
 * 9.9.9.9, 203.0.113.7` (a forged entry plus the one the proxy appended):
 *
 *     trust proxy = true   ->  req.ip = 9.9.9.9      (the forgery)
 *     trust proxy = 1      ->  req.ip = 203.0.113.7  (the proxy's own record)
 *     trust proxy = false  ->  req.ip = 127.0.0.1    (the socket; the proxy)
 *
 * Every per-IP auth throttle keys on `req.ip`. Under `true`, one extra header
 * per request bought a brand-new bucket, so the limiter was a no-op against any
 * attacker who bothered — while reading, from every angle available to us,
 * exactly like a limiter that was working. `false` is no better: it collapses
 * every caller onto the edge's address, i.e. ONE shared bucket for the whole
 * internet, which converts the throttle into a self-DoS.
 *
 * A hop count is the only setting that names the real topology. bqb1 sits behind
 * exactly one Render hop; `TRUST_PROXY_HOPS` exists so that adding a CDN in
 * front is an env change during a freeze rather than a code change.
 *
 * Accepts a positive integer, or `false`/`0` for "no proxy" (direct-to-socket,
 * for a local run). Anything unparseable falls back to 1 rather than to `true` —
 * a typo must not silently restore the spoofable setting.
 */
export function resolveTrustProxy(raw: string | undefined): number | false {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 1;
  if (value === 'false' || value === '0') return false;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 1) return 1;
  return hops;
}

/**
 * Reduce a URL to its origin (`scheme://host[:port]`), or null if unparseable.
 * `APP_URL` is a full app URL with a path in some deployments, and an `Origin`
 * header never carries one, so comparing raw strings would silently never match.
 */
export function toOrigin(value: string | undefined | null): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * The allowlist, built once at boot from the static set plus `APP_URL` and the
 * comma-separated `CORS_ALLOWED_ORIGINS` escape hatch (so onboarding a new
 * front end does not require a code change during a deploy freeze).
 */
export function buildAllowedOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>([PAGES_ORIGIN, ...TAURI_ORIGINS, ...LOCAL_ORIGINS]);

  const appOrigin = toOrigin(env['APP_URL']);
  if (appOrigin) origins.add(appOrigin);

  for (const entry of (env['CORS_ALLOWED_ORIGINS'] ?? '').split(',')) {
    // `tauri://localhost` parses to origin `null` in the WHATWG URL model
    // (non-special scheme), so accept a verbatim match against the known set
    // before falling back to normalisation.
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const normalised = toOrigin(trimmed);
    origins.add(normalised && normalised !== 'null' ? normalised : trimmed);
  }

  return origins;
}

/**
 * The value to echo in `Access-Control-Allow-Origin`, or null to send no such
 * header at all. Null covers BOTH "no Origin header" (non-browser caller: fine,
 * unaffected) and "origin not on the list" (browser: response blocked).
 */
export function resolveAllowedOrigin(
  origin: string | string[] | undefined,
  allowed: Set<string>,
): string | null {
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (!value) return null;
  // `Origin: null` is what a sandboxed iframe / `file://` document sends. Never
  // echo it — it is not an origin, and echoing it grants every such document.
  if (value === 'null') return null;
  return allowed.has(value) ? value : null;
}

export interface SecurityHeaderOptions {
  /** True only when the request reached us over TLS (`req.secure`, with `trust proxy` on). */
  secure: boolean;
  /** `req.headers.host`, used to name this origin's WebSocket in the CSP. */
  host?: string | undefined;
  /** TRA-4429 kill switch, resolved from env once by the middleware. Default `full`. */
  cspMode?: CspEnforcedMode;
}

/**
 * The pre-TRA-4429 enforced policy, and what the kill switch below falls back to.
 * `frame-ancestors` is the clickjacking fix TRA-2298 calls the sharpest edge, and it
 * cannot break a page that is never framed (nothing in this repo embeds the app —
 * grepped, zero `<iframe>`). It is present in BOTH enforced shapes, so pulling the
 * kill switch never reopens the clickjacking exposure.
 */
export const MINIMAL_ENFORCED_CSP = "frame-ancestors 'none'";

/**
 * TRA-4429 — kill switch for the promoted policy. A panel the enforced CSP breaks
 * mid-session on a real-money box must be a RESTART, not a rebuild-and-deploy under
 * pressure, so the shape is chosen from env:
 *
 *   CSP_ENFORCED_POLICY unset / `full`  → `enforcedCsp()` (the promoted policy)
 *   CSP_ENFORCED_POLICY=frame-ancestors → MINIMAL_ENFORCED_CSP only (pre-4429)
 *
 * An unrecognised value resolves to `full` and is reported by the caller: a typo in
 * a hardening switch must not silently weaken the header. The Report-Only header is
 * unaffected by this switch in both shapes.
 */
export type CspEnforcedMode = 'full' | 'frame-ancestors';

export function resolveCspEnforcedMode(env: NodeJS.ProcessEnv = process.env): {
  mode: CspEnforcedMode;
  unrecognised: string | null;
} {
  const raw = (env['CSP_ENFORCED_POLICY'] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'full') return { mode: 'full', unrecognised: null };
  if (raw === 'frame-ancestors') return { mode: 'frame-ancestors', unrecognised: null };
  return { mode: 'full', unrecognised: raw };
}

/** `connect-src` for a document served by `host`. Shared by both policies. */
function connectSrc(host: string | undefined): string {
  // A document served by this origin opens its dashboard socket back to the
  // same host. CSP3 says `'self'` should cover ws/wss on the same origin, but
  // that has been unevenly implemented, so name it explicitly when we know it.
  const socket = host ? ` wss://${host} ws://${host}` : '';
  return `connect-src 'self'${socket}`;
}

/**
 * TRA-4429 — the ENFORCED policy, promoted from the TRA-2321 candidate after the
 * TRA-2344 collector read 24 days with violations on ONE bucket only
 * (`script-src` / `wasm-eval`) and zero on the other ten directives.
 *
 * `script-src` is named explicitly, and it has to be: omitting it while enforcing
 * `default-src 'self'` does not leave scripts unenforced, it falls back to
 * `default-src` (CSP L3 fetch-directive fallback) — bit-for-bit the policy that
 * produced the wasm-eval reports. `'wasm-unsafe-eval'` permits
 * `WebAssembly.compile`/`instantiate` and NOTHING else: it does not enable `eval()`
 * or `new Function()` (that is `'unsafe-eval'`, which this policy does not grant).
 * The shipped client bundle makes no WebAssembly call (TRA-4429 grep of the live
 * bytes), so the carve-out is retirable once the Report-Only tape shows the
 * wasm-eval bucket has stopped arriving.
 *
 * `'unsafe-inline'` on style-src is PERMANENT BY DESIGN, not an oversight: React
 * inline `style={{...}}` props and the chart components emit inline styles
 * (TRA-2321 item 2). `worker-src` covers the vite-plugin-pwa service worker.
 *
 * No `report-uri`/`report-to` here on purpose: the instrument stays on the
 * Report-Only header, which carries the TIGHTER candidate (no wasm carve-out).
 */
export function enforcedCsp(host?: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    connectSrc(host),
  ].join('; ');
}

// ── TRA-2344 — where violation reports go ────────────────────────────────────
//
// These two constants are declared HERE, in the module with no runtime imports,
// because they appear in the CSP header, and `csp-report-collector.ts` imports them
// to mount its route. One definition, two consumers: if the route and the URL the
// browser is told to post to ever drifted apart, the result would be zero reports
// and no error on any surface — the same silence this ticket exists to end.

/** Path of the unauthenticated collector. See `csp-report-collector.ts`. */
export const CSP_REPORT_PATH = '/api/csp-report';

/** `Reporting-Endpoints` group name that the CSP's `report-to` refers to. */
export const CSP_REPORT_GROUP = 'csp-endpoint';

/**
 * The `Reporting-Endpoints` header value, or null when the host is unknown.
 *
 * The Reporting API resolves this endpoint against the DOCUMENT, and browser
 * implementations have been inconsistent about relative URLs here, so an absolute
 * one is built whenever the host is known. The scheme has to follow the actual
 * transport: hardcoding `https://` would name an endpoint that does not exist on
 * `http://localhost:4242`, where the desktop app and every dev loop live.
 *
 * With no host there is nothing safe to name — a bare path may or may not be
 * honoured — so the header is omitted, and only the legacy `report-uri` (which
 * takes a relative URL unambiguously) carries reports in that case.
 */
export function reportingEndpointsHeader(host: string | undefined, secure: boolean): string | null {
  if (!host) return null;
  const scheme = secure ? 'https' : 'http';
  return `${CSP_REPORT_GROUP}="${scheme}://${host}${CSP_REPORT_PATH}"`;
}

/**
 * The TIGHTER candidate, shipped Report-Only so a violation is a console entry,
 * never a broken panel. TRA-4429 promoted this policy to enforced WITH a
 * `'wasm-unsafe-eval'` carve-out on script-src (see `enforcedCsp`); this header
 * deliberately keeps `script-src 'self'` WITHOUT it, so the collector keeps
 * measuring whether the wasm-eval dependency ever disappears and the carve-out can
 * be retired. A Report-Only header identical to the enforced one measures nothing —
 * do not "sync" the two. Nor is there checker pressure to: `check-csp-collector.mjs`
 * grades buckets against the ENFORCED header, so the wasm-eval reports this divergence
 * produces read allowed-by-enforced, not DIRTY (TRA-4531, scripts/lib/csp-bucket-grade.mjs).
 *
 * TRA-2344 appends `report-uri` + `report-to` — to THIS header only. Both ship
 * because they are not interchangeable: `report-uri` is deprecated but is what
 * Safari and older Chrome/Firefox actually implement, and `report-to` is the only
 * one current Chrome honours. Sending one alone silently loses a browser family,
 * and a browser family reporting nothing looks exactly like a browser family with
 * no violations — which is the reading error TRA-2321 must not make.
 */
export function reportOnlyCsp(host?: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    connectSrc(host),
    // Relative URL on purpose: `report-uri` resolves against the document, this
    // endpoint is same-origin, and naming an absolute host here would break the
    // moment the app is served from a hostname this code did not predict.
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join('; ');
}

/**
 * Security headers for one response.
 *
 * HSTS is emitted ONLY over TLS. This is not cosmetic RFC-6797 compliance: the
 * desktop app and every dev loop talk to this same server over plain
 * `http://localhost:4242`. A browser that ever honoured an HSTS header from
 * that origin would force-upgrade localhost to https for a YEAR, with no server
 * on the other side and no way to clear it short of editing browser internals.
 * Gate on transport, not on NODE_ENV.
 */
export function securityHeaders(opts: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // TRA-4429 — the promoted policy, pinned to its exact string in the test suite
    // so the next widening is a deliberate edit. `CSP_ENFORCED_POLICY=frame-ancestors`
    // (restart, no rebuild) drops it back to the pre-promotion clickjacking-only slot.
    'Content-Security-Policy':
      opts.cspMode === 'frame-ancestors' ? MINIMAL_ENFORCED_CSP : enforcedCsp(opts.host),
    'Content-Security-Policy-Report-Only': reportOnlyCsp(opts.host),
  };
  // TRA-2344 — `report-to` is inert without this header; the group name in the
  // CSP is just a label until something binds it to a URL.
  const reporting = reportingEndpointsHeader(opts.host, opts.secure);
  if (reporting) headers['Reporting-Endpoints'] = reporting;
  if (opts.secure) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

// ── Middleware ───────────────────────────────────────────────────────────────
//
// These live here rather than inline in `index.ts` so the integration test
// exercises the EXACT handlers the server mounts. A test that re-implemented
// the wiring would keep passing after the wiring in `index.ts` drifted, which
// is the failure mode that makes a green suite worse than no suite.

/**
 * Stamps the security headers on every response, including static and error paths.
 *
 * TRA-4429: the CSP kill switch is read from `env` ONCE, here, so a flip takes
 * effect on restart and every response of one process carries the same policy.
 * An unrecognised value is announced on stderr at mount (this module has no
 * runtime imports, so no logger) and resolves to the promoted policy.
 */
export function securityHeadersMiddleware(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const { mode: cspMode, unrecognised } = resolveCspEnforcedMode(env);
  if (unrecognised !== null) {
    console.warn(
      `[http-security] CSP_ENFORCED_POLICY=${JSON.stringify(unrecognised)} is not "full" or ` +
        '"frame-ancestors"; enforcing the FULL promoted policy (TRA-4429).',
    );
  }
  return (req, res, next) => {
    // `req.secure` is only truthful because `app.set('trust proxy', true)` is
    // set (TRA-404) — behind Render's proxy the TLS terminates upstream and the
    // signal arrives as `X-Forwarded-Proto`. Without trust proxy this would be
    // false on prod and HSTS would never ship.
    const headers = securityHeaders({ secure: req.secure, host: req.headers.host, cspMode });
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);

    // TRA-2320 — A HEADER SET IN MIDDLEWARE IS NOT FINAL. Two of Express's own
    // terminal paths call `res.setHeader('Content-Security-Policy',
    // "default-src 'none'")` on their way out, CLOBBERING the line above:
    //
    //   finalhandler/index.js:295   — every generated 404/error body
    //   serve-static/index.js:204   — the trailing-slash directory redirect
    //
    // and `frame-ancestors` has NO fallback to `default-src` (CSP L2/L3), so on
    // those responses the clickjacking directive is not weakened, it is GONE.
    // Measured live on bqb1 2026-07-25: `/api/<unknown>` 404, `POST /nope` 404,
    // and `GET /assets` 301 all shipped `default-src 'none'`.
    //
    // The obvious remedy — mount a 404 handler we own — fixes the first two and
    // does nothing for the third, which never reaches a 404 handler at all. So
    // reassert at write time instead: this is the last point before the status
    // line goes out, and it is indifferent to WHICH library rewrote the header,
    // including one added after this comment. (`notFoundHandler` below is still
    // worth mounting, for the JSON body — but it is no longer load-bearing.)
    //
    // Caveat, deliberately not handled: headers passed as an explicit object to
    // `writeHead(status, headers)` are merged by Node AFTER this and would win.
    // Nothing in this tree does that, and a caller that did would be stating an
    // intent worth honouring — unlike these two, which are stating a default.
    const writeHead = res.writeHead.bind(res);
    res.writeHead = function reassertCsp(this: typeof res, ...args: unknown[]) {
      try {
        if (!res.headersSent) {
          res.setHeader('Content-Security-Policy', headers['Content-Security-Policy'] ?? MINIMAL_ENFORCED_CSP);
        }
      } catch {
        // A hardening header must never be the reason a response fails to send.
      }
      return (writeHead as (...a: unknown[]) => unknown)(...args);
    } as unknown as typeof res.writeHead;

    next();
  };
}

/**
 * Terminal 404. Mounted after the routes and the static/SPA block, before the
 * error middleware.
 *
 * Express's built-in `finalhandler` would otherwise generate this response, and
 * it answers an unknown `/api` path with an HTML body (`Cannot GET /api/x`) —
 * which no API consumer can parse. A handler we own returns JSON there, and
 * keeps the header rewrite described above out of the picture on the two 404
 * classes that reach it: unknown `/api/*`, and any non-GET on a non-API path
 * (the SPA fallback is registered with `app.get`, so `POST /whatever` falls
 * through to here).
 */
export function notFoundHandler(): RequestHandler {
  return (req, res) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'not found', path: req.path });
      return;
    }
    // Non-API: plain text, never an echo of the URL. `nosniff` is already set,
    // so there is no content-type confusion to exploit here either.
    res.status(404).type('txt').send('Not Found');
  };
}

/**
 * Emits CORS headers only for an allowlisted origin, and answers preflight with
 * 204 either way. Never rejects a request — see the header of this file.
 */
export function corsMiddleware(allowed: Set<string>): RequestHandler {
  return (req, res, next) => {
    // Required whenever the response varies by request origin: Cloudflare sits
    // in front of this service, and without `Vary` a response cached for an
    // allowlisted origin can be replayed to a different one — which would hand
    // the `*` behaviour straight back through the cache.
    res.setHeader('Vary', 'Origin');

    const allowOrigin = resolveAllowedOrigin(req.headers.origin, allowed);
    if (allowOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      // TRA-413 — allow the desktop client to send `X-Trace-Id` (not a CORS-
      // safelisted header) so its requests correlate with the traces they
      // produce, and expose the response header so a client can read the id the
      // server filed under. `Max-Age` lets the browser cache the preflight so a
      // polling client does not re-preflight every request.
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Trace-Id');
      res.setHeader('Access-Control-Expose-Headers', 'X-Trace-Id');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
      // Status stays 204 whether or not the origin is allowed: the browser gates
      // on the ABSENCE of `Access-Control-Allow-Origin`, and a 4xx here would
      // differ only for non-browser callers, who are not the threat.
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * TRA-4488 item 4 — strip query-string VALUES out of anything we log.
 *
 * The WS ticket handshake in `ws-auth.ts` takes the session token out of the
 * URL, which fixes the one parameter we know about. This exists so the *class*
 * does not come back through the next one: `req.originalUrl` carries the query
 * string, and two live log surfaces interpolate it (`recordBootArmRepair` and
 * its paired `log.warn`, both in `index.ts`, both shipped by TRA-3809/TRA-3810
 * specifically so a settings write is attributable — so they are not going
 * away).
 *
 * Parameter NAMES survive, every VALUE becomes `[redacted]`. That keeps the
 * thing those two call sites actually need — which parameters a caller sent,
 * the same reasoning as their `bodyFields: Object.keys(body)` — while making it
 * impossible for a value to reach a log by being newly added and forgotten.
 *
 * Deliberately NOT a denylist of sensitive names (`token`, `ticket`, `code`, …)
 * and deliberately not an allowlist of benign ones. Both are the same object:
 * a list someone has to remember to extend, whose failure mode is a silent leak
 * of exactly the parameter nobody thought about. A redact-everything rule has no
 * such state. Cost is that `?date=2026-09-10` is no longer readable from the
 * log line; that value is recoverable from the route's own handler logging if
 * anyone ever needs it, and a leaked session token is not recoverable at all.
 *
 * Never throws: a URL this cannot parse is truncated at the first `?`, which is
 * the safe direction.
 */
export const REDACTED_QUERY_VALUE = '[redacted]';

export function redactQueryString(url: string | undefined | null): string {
  if (!url) return '';
  const q = url.indexOf('?');
  if (q === -1) return stripFragment(url);
  const path = url.slice(0, q);
  const rest = url.slice(q + 1);
  // A fragment never reaches a server, but `redactQueryString` is also handed
  // client-supplied strings (`Referer`), where it does.
  const hash = rest.indexOf('#');
  const query = hash === -1 ? rest : rest.slice(0, hash);
  if (query === '') return path;
  const names = query
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const eq = pair.indexOf('=');
      // A bare `?flag` has no value to redact, so it is left intact — there is
      // nothing in it but the name we were going to keep anyway.
      return eq === -1 ? pair : `${pair.slice(0, eq)}=${REDACTED_QUERY_VALUE}`;
    });
  return names.length === 0 ? path : `${path}?${names.join('&')}`;
}

function stripFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}
