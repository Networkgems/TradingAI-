import { describe, it, expect } from 'vitest';
import {
  buildAllowedOrigins,
  resolveAllowedOrigin,
  securityHeaders,
  securityHeadersMiddleware,
  enforcedCsp,
  resolveCspEnforcedMode,
  MINIMAL_ENFORCED_CSP,
  reportOnlyCsp,
  reportingEndpointsHeader,
  toOrigin,
  CSP_REPORT_PATH,
  PAGES_ORIGIN,
  TAURI_ORIGINS,
  LOCAL_ORIGINS,
  redactQueryString,
  REDACTED_QUERY_VALUE,
} from './http-security.js';

// TRA-2298. The expensive failure for this change is not "the header is
// missing" — QA will catch that on the next sweep. It is "the header is there
// and a live consumer is now dark", which looks identical to a healthy box from
// the server side. So the allowlist tests below are weighted toward the
// consumers that MUST keep working, and the whole suite refuses to pass if the
// resolver has collapsed to always-allow or always-deny.

const ENV_BASE: NodeJS.ProcessEnv = {};

describe('resolveAllowedOrigin — consumers that must not break', () => {
  const allowed = buildAllowedOrigins(ENV_BASE);

  it('allows the GitHub Pages web app — the live cross-origin consumer', () => {
    // Proven against the live bundle 2026-07-25: the Pages build has
    // `wss://tradingai-bqb1.onrender.com` baked in and no backend of its own.
    // This is the origin the ticket's suggested allowlist omitted.
    expect(resolveAllowedOrigin(PAGES_ORIGIN, allowed)).toBe(PAGES_ORIGIN);
  });

  it.each([...TAURI_ORIGINS])('allows the Tauri webview origin %s', origin => {
    expect(resolveAllowedOrigin(origin, allowed)).toBe(origin);
  });

  it.each([...LOCAL_ORIGINS])('allows the loopback dev/desktop origin %s', origin => {
    expect(resolveAllowedOrigin(origin, allowed)).toBe(origin);
  });

  it('leaves a caller that sends NO Origin header alone', () => {
    // curl, the ops scripts, tra425_full_regression.mjs, server-to-server.
    // These are not browsers, so no header is the correct answer — and the
    // request itself is never refused.
    expect(resolveAllowedOrigin(undefined, allowed)).toBeNull();
    expect(resolveAllowedOrigin('', allowed)).toBeNull();
  });
});

describe('resolveAllowedOrigin — origins that must be denied', () => {
  const allowed = buildAllowedOrigins(ENV_BASE);

  it('denies an arbitrary origin', () => {
    expect(resolveAllowedOrigin('https://evil.example', allowed)).toBeNull();
  });

  it('denies a literal `null` origin (sandboxed iframe / file://)', () => {
    expect(resolveAllowedOrigin('null', allowed)).toBeNull();
  });

  it('denies a prefix/suffix near-miss of an allowlisted origin', () => {
    // Substring matching is the classic way an allowlist quietly becomes `*`.
    expect(resolveAllowedOrigin('https://networkgems.github.io.evil.example', allowed)).toBeNull();
    expect(resolveAllowedOrigin('https://evil-networkgems.github.io', allowed)).toBeNull();
    expect(resolveAllowedOrigin('http://networkgems.github.io', allowed)).toBeNull();
    expect(resolveAllowedOrigin('https://tauri.localhost.evil.example', allowed)).toBeNull();
  });

  it('takes only the first value when Origin arrives duplicated', () => {
    expect(resolveAllowedOrigin(['https://evil.example', PAGES_ORIGIN], allowed)).toBeNull();
  });
});

describe('positive/negative control — the resolver has not collapsed', () => {
  // A resolver stuck at "always allow" passes every test in the first block;
  // one stuck at "always deny" passes every test in the second. Neither passes
  // this one, so the suite cannot go green one-sided.
  it('returns a non-null for an allowlisted origin AND null for a hostile one', () => {
    const allowed = buildAllowedOrigins(ENV_BASE);
    const yes = resolveAllowedOrigin(PAGES_ORIGIN, allowed);
    const no = resolveAllowedOrigin('https://evil.example', allowed);
    expect(yes).not.toBeNull();
    expect(no).toBeNull();
    expect(yes).not.toBe(no);
  });

  it('never emits a wildcard', () => {
    const allowed = buildAllowedOrigins(ENV_BASE);
    expect([...allowed]).not.toContain('*');
    expect(resolveAllowedOrigin('*', allowed)).toBeNull();
  });
});

describe('buildAllowedOrigins — env extension', () => {
  it('adds APP_URL, reduced to its origin', () => {
    // APP_URL carries a path in some deployments (`email.ts` appends
    // `/?reset_code=`); an Origin header never does, so a raw string compare
    // would silently never match.
    const allowed = buildAllowedOrigins({ APP_URL: 'https://app.example.com/dashboard/' });
    expect(resolveAllowedOrigin('https://app.example.com', allowed)).toBe('https://app.example.com');
  });

  it('ignores an unparseable APP_URL instead of throwing at boot', () => {
    expect(() => buildAllowedOrigins({ APP_URL: 'not a url' })).not.toThrow();
    expect(toOrigin('not a url')).toBeNull();
  });

  it('adds comma-separated CORS_ALLOWED_ORIGINS, trimming blanks', () => {
    const allowed = buildAllowedOrigins({
      CORS_ALLOWED_ORIGINS: ' https://staging.example.com , , https://other.example.com ',
    });
    expect(resolveAllowedOrigin('https://staging.example.com', allowed)).toBe('https://staging.example.com');
    expect(resolveAllowedOrigin('https://other.example.com', allowed)).toBe('https://other.example.com');
    expect(resolveAllowedOrigin('https://evil.example', allowed)).toBeNull();
  });

  it('keeps a non-special scheme verbatim rather than normalising it to "null"', () => {
    // `new URL('tauri://localhost').origin` is the STRING "null". Storing that
    // would put a literal "null" on the allowlist and let every sandboxed
    // iframe through.
    const allowed = buildAllowedOrigins({ CORS_ALLOWED_ORIGINS: 'tauri://other' });
    expect(allowed.has('tauri://other')).toBe(true);
    expect(allowed.has('null')).toBe(false);
    expect(resolveAllowedOrigin('null', allowed)).toBeNull();
  });

  it('still allows the built-in consumers when env adds nothing', () => {
    const allowed = buildAllowedOrigins({ CORS_ALLOWED_ORIGINS: '' });
    expect(resolveAllowedOrigin(PAGES_ORIGIN, allowed)).toBe(PAGES_ORIGIN);
  });
});

describe('securityHeaders', () => {
  it('sets the four always-on headers', () => {
    const h = securityHeaders({ secure: true, host: 'tradingai-bqb1.onrender.com' });
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });

  it('sends HSTS over TLS', () => {
    const h = securityHeaders({ secure: true, host: 'tradingai-bqb1.onrender.com' });
    expect(h['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('does NOT send HSTS over plain http', () => {
    // The desktop app and every dev loop hit http://localhost:4242. An HSTS
    // header honoured from that origin force-upgrades localhost to https for a
    // year, with nothing listening — effectively unrecoverable for the user.
    const h = securityHeaders({ secure: false, host: 'localhost:4242' });
    expect(h['Strict-Transport-Security']).toBeUndefined();
    // ...but the rest of the hardening still applies.
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('pins the ENFORCED policy to the exact TRA-4429 promoted string', () => {
    // TRA-4429 promoted the TRA-2321 candidate, so this pin moved — it was NOT
    // deleted. It is still exact equality on purpose: the next widening (a new
    // source, `'unsafe-eval'`, a dropped directive) must be a deliberate edit to
    // this string, never a silent one.
    const csp = securityHeaders({ secure: true, host: 'tradingai-bqb1.onrender.com' })['Content-Security-Policy'];
    expect(csp).toBe(
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
        "form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
        "worker-src 'self' blob:; manifest-src 'self'; " +
        'connect-src \'self\' wss://tradingai-bqb1.onrender.com ws://tradingai-bqb1.onrender.com',
    );
  });

  it('never grants eval() — the wasm carve-out is NOT unsafe-eval', () => {
    // `'wasm-unsafe-eval'` contains the substring `unsafe-eval`, so a toContain
    // check would pass on the dangerous token too. Tokenise and compare exactly.
    const csp = securityHeaders({ secure: true, host: 'h' })['Content-Security-Policy'] ?? '';
    const scriptSrc = csp.split(';').map(d => d.trim()).find(d => d.startsWith('script-src ')) ?? '';
    const tokens = scriptSrc.split(/\s+/);
    expect(tokens).toContain("'wasm-unsafe-eval'");
    expect(tokens).not.toContain("'unsafe-eval'");
    expect(tokens).not.toContain("'unsafe-inline'");
  });

  it('ships the TIGHTER candidate Report-Only — no wasm carve-out there', () => {
    // Promotion must not blind the instrument: Report-Only keeps measuring whether
    // the wasm-eval dependency ever disappears, so the carve-out can be retired.
    const h = securityHeaders({ secure: true, host: 'tradingai-bqb1.onrender.com' });
    const ro = h['Content-Security-Policy-Report-Only'] ?? '';
    expect(ro).toContain("default-src 'self'");
    expect(ro).toContain("object-src 'none'");
    expect(ro).toContain("worker-src 'self' blob:"); // vite-plugin-pwa service worker
    expect(ro).toContain("script-src 'self';");
    expect(ro).not.toContain('wasm-unsafe-eval');
    expect(ro).not.toBe(h['Content-Security-Policy']);
  });
});

describe('TRA-4429 — CSP_ENFORCED_POLICY kill switch', () => {
  it('defaults to the promoted policy when unset', () => {
    expect(resolveCspEnforcedMode({})).toEqual({ mode: 'full', unrecognised: null });
  });

  it('drops to frame-ancestors only when pulled, and clickjacking stays enforced', () => {
    expect(resolveCspEnforcedMode({ CSP_ENFORCED_POLICY: ' Frame-Ancestors ' }).mode).toBe('frame-ancestors');
    const h = securityHeaders({ secure: true, host: 'h', cspMode: 'frame-ancestors' });
    expect(h['Content-Security-Policy']).toBe(MINIMAL_ENFORCED_CSP);
    expect(MINIMAL_ENFORCED_CSP).toBe("frame-ancestors 'none'");
    // The instrument is untouched by the switch.
    expect(h['Content-Security-Policy-Report-Only']).toBe(reportOnlyCsp('h'));
  });

  it('resolves a typo to the promoted policy and reports it, never to the weaker one', () => {
    expect(resolveCspEnforcedMode({ CSP_ENFORCED_POLICY: 'frame-ancestor' })).toEqual({
      mode: 'full',
      unrecognised: 'frame-ancestor',
    });
  });

  it('the middleware honours the switch on the wire, including the writeHead reassert', async () => {
    // Positive/negative pair through the EXACT handler the server mounts.
    const run = (env: NodeJS.ProcessEnv) => {
      const headers: Record<string, string> = {};
      const res = {
        headersSent: false,
        setHeader: (k: string, v: string) => { headers[k] = v; },
        writeHead: () => undefined,
      };
      securityHeadersMiddleware(env)({ secure: true, headers: { host: 'h' } } as never, res as never, () => undefined);
      // Simulate finalhandler clobbering the header, then the status line going out.
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      (res.writeHead as () => void)();
      return headers['Content-Security-Policy'];
    };
    expect(run({})).toBe(enforcedCsp('h'));
    expect(run({ CSP_ENFORCED_POLICY: 'frame-ancestors' })).toBe("frame-ancestors 'none'");
  });
});

describe('TRA-2344 — reporting wired to Report-Only, and ONLY Report-Only', () => {
  // This is the ticket's positive control, and it is deliberately two-sided.
  //
  // Asserting only "the enforced header is still `frame-ancestors 'none'`" would
  // also pass if TRA-2344 had wired up nothing at all — a control that cannot tell
  // "promoted nothing" from "did nothing" proves neither. So each assertion below
  // pairs the thing that must NOT have moved with the thing that must have
  // arrived, in the slot it belongs in.

  it('adds report-uri/report-to to Report-Only and NOTHING to the enforced slot', () => {
    const h = securityHeaders({ secure: true, host: 'tradingai-bqb1.onrender.com' });
    const enforced = h['Content-Security-Policy'] ?? '';
    const ro = h['Content-Security-Policy-Report-Only'] ?? '';

    // Detects: reporting directives leaking into the enforced policy. (TRA-4429
    // moved the enforced slot to the promoted policy; it still carries NO
    // reporting — the instrument lives one slot over, on the tighter candidate.)
    expect(enforced).toBe(enforcedCsp('tradingai-bqb1.onrender.com'));
    expect(enforced).not.toContain('report-uri');
    expect(enforced).not.toContain('report-to');

    // Contains what it detects: the directives DO exist, one slot over. Without
    // these three lines the block above is satisfied by an empty change.
    expect(ro).toContain('report-uri /api/csp-report');
    expect(ro).toContain('report-to csp-endpoint');
    expect(ro).toContain("default-src 'self'");
  });

  it('binds the report-to group to a real URL via Reporting-Endpoints', () => {
    // `report-to csp-endpoint` is inert on its own — the group name is just a
    // label until this header maps it to a URL. Shipping the CSP directive without
    // this header would collect zero reports from every modern Chrome, silently.
    const h = securityHeaders({ secure: true, host: 'tradingai-bqb1.onrender.com' });
    expect(h['Reporting-Endpoints']).toBe(
      'csp-endpoint="https://tradingai-bqb1.onrender.com/api/csp-report"',
    );
  });

  it('names the endpoint over http when the request was not TLS', () => {
    // The desktop app and every dev loop are http://localhost:4242. A hardcoded
    // `https://` here would point the browser at an endpoint that does not exist.
    const h = securityHeaders({ secure: false, host: 'localhost:4242' });
    expect(h['Reporting-Endpoints']).toBe('csp-endpoint="http://localhost:4242/api/csp-report"');
  });

  it('omits Reporting-Endpoints when the host is unknown, keeping report-uri', () => {
    const h = securityHeaders({ secure: true, host: undefined });
    expect(h['Reporting-Endpoints']).toBeUndefined();
    // The legacy directive takes a relative URL unambiguously, so reports still
    // flow from the browsers that implement it.
    expect(h['Content-Security-Policy-Report-Only']).toContain('report-uri /api/csp-report');
  });

  it('keeps the collector path in the header identical to the mounted route', () => {
    // One constant, two consumers. A drift here yields zero reports and no error
    // on any surface — the exact silence this ticket exists to end.
    expect(reportOnlyCsp('h')).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(reportingEndpointsHeader('h', true)).toContain(CSP_REPORT_PATH);
  });
});

describe('reportOnlyCsp', () => {
  it('names this host’s WebSocket in connect-src', () => {
    // The dashboard bus is a wss:// connection back to the serving host, and
    // `'self'` covering ws/wss is unevenly implemented across browsers.
    const csp = reportOnlyCsp('tradingai-bqb1.onrender.com');
    expect(csp).toContain('wss://tradingai-bqb1.onrender.com');
  });

  it('omits the socket clause when the host is unknown', () => {
    expect(reportOnlyCsp(undefined)).toContain("connect-src 'self'");
    expect(reportOnlyCsp(undefined)).not.toContain('wss://');
  });
});

// TRA-4488 item 4 — query-string redaction for anything that reaches a log.
describe('redactQueryString', () => {
  it('keeps the path and every parameter NAME, and destroys every VALUE', () => {
    expect(redactQueryString('/api/state?token=abc.def&mode=live')).toBe(
      `/api/state?token=${REDACTED_QUERY_VALUE}&mode=${REDACTED_QUERY_VALUE}`,
    );
  });

  it('redacts a parameter nobody has thought of yet', () => {
    // The point of the whole helper. A denylist of (`token`, `ticket`, `code`)
    // would pass the case above and leak this one, and the leak would be silent
    // — the failure direction this issue exists to close.
    const out = redactQueryString('/api/x?some_new_credential=SECRET');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('some_new_credential');
  });

  it('redacts the WS upgrade URL shape specifically', () => {
    for (const url of ['/?token=SESSIONTOKEN', '/?ticket=TICKETVALUE']) {
      expect(redactQueryString(url)).not.toMatch(/SESSIONTOKEN|TICKETVALUE/);
    }
  });

  it('passes a query-less URL through unchanged', () => {
    expect(redactQueryString('/api/health/version')).toBe('/api/health/version');
  });

  it('drops a fragment, which a Referer can carry', () => {
    expect(redactQueryString('https://app.example/page?q=SECRET#tok=ALSOSECRET')).toBe(
      `https://app.example/page?q=${REDACTED_QUERY_VALUE}`,
    );
    expect(redactQueryString('https://app.example/page#tok=SECRET')).toBe('https://app.example/page');
  });

  it('never throws and never returns the input on a malformed query', () => {
    // `?` with nothing after it, repeated separators, a bare flag, a value
    // containing `=`. A throw here would take out the log call site it wraps.
    expect(redactQueryString('/api/x?')).toBe('/api/x');
    expect(redactQueryString('/api/x?&&')).toBe('/api/x');
    expect(redactQueryString('/api/x?flag')).toBe('/api/x?flag');
    expect(redactQueryString('/api/x?a=b=SECRET')).toBe(`/api/x?a=${REDACTED_QUERY_VALUE}`);
    expect(redactQueryString(undefined)).toBe('');
    expect(redactQueryString(null)).toBe('');
    expect(redactQueryString('')).toBe('');
  });
});
