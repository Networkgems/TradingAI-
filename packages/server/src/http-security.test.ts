import { describe, it, expect } from 'vitest';
import {
  buildAllowedOrigins,
  resolveAllowedOrigin,
  securityHeaders,
  reportOnlyCsp,
  toOrigin,
  PAGES_ORIGIN,
  TAURI_ORIGINS,
  LOCAL_ORIGINS,
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

  it('keeps the ENFORCED policy to frame-ancestors only', () => {
    // Guards against someone promoting the report-only policy into the enforced
    // slot without a session of clean reports: `default-src 'self'` enforced
    // today would be a live SPA outage, and this is the cheapest place to catch
    // that. Promotion is a deliberate edit to this assertion.
    const csp = securityHeaders({ secure: true, host: 'h' })['Content-Security-Policy'];
    expect(csp).toBe("frame-ancestors 'none'");
    expect(csp).not.toContain('default-src');
  });

  it('ships the candidate policy Report-Only', () => {
    const h = securityHeaders({ secure: true, host: 'tradingai-bqb1.onrender.com' });
    const ro = h['Content-Security-Policy-Report-Only'] ?? '';
    expect(ro).toContain("default-src 'self'");
    expect(ro).toContain("object-src 'none'");
    expect(ro).toContain("worker-src 'self' blob:"); // vite-plugin-pwa service worker
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
