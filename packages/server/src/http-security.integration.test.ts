import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildAllowedOrigins,
  corsMiddleware,
  notFoundHandler,
  securityHeadersMiddleware,
  PAGES_ORIGIN,
} from './http-security.js';

// TRA-2298 — the unit suite grades the DECISIONS; this one grades the WIRE.
//
// It mounts the same two handlers `index.ts` mounts, in the same order, and
// asserts on real response headers from a real socket. That is deliberate:
// QA's re-verification contract for this ticket is stated in terms of bytes on
// the wire ("each header present with the expected value, `x-powered-by`
// absent, a preflight from a non-allowlisted origin no longer returns
// `access-control-allow-origin: *`"), so the local gate should be phrased the
// same way. A green unit suite over a handler nobody mounted is exactly the
// shape that lets a header regression reach prod.

// TRA-2320 — the app under test now mirrors the FULL index.ts tail, not just
// the happy path: static dir (with a subdirectory, so the serve-static redirect
// is reachable) → SPA fallback → terminal 404 → error handler. The TRA-2298
// sweep shipped a real header regression to prod precisely because the gate
// only ever exercised a route that existed.
let distDir: string;

function buildApp(): express.Express {
  const app = express();
  // Mirrors index.ts: trust proxy (TRA-404) → disable x-powered-by → security
  // headers → CORS.
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(securityHeadersMiddleware());
  app.use(corsMiddleware(buildAllowedOrigins({})));
  app.get('/api/health/version', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/api/tra2320-throws', () => {
    throw new Error('boom');
  });

  // Mirrors index.ts' static/SPA block, including the `/api/` exclusion on the
  // fallback — which is why an unknown `/api` path reaches the 404 handler and
  // an unknown page path does not.
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(distDir, 'index.html'));
  });

  // Kept as a switch, not deleted: `TRA2320_CONTROL_NO_404_HANDLER=1` reproduces
  // the ticket's SUGGESTED remedy minus the write-time reassert, and vice versa
  // by commenting the reassert. Controls run 2026-07-25 — reassert off / handler
  // on: 1 red (the 301, unreachable by any 404 handler) · handler off / reassert
  // on: 1 red (the JSON body only — every CSP leg still green) · both off: 4 red,
  // matching live prod. Neither half is redundant; neither is load-bearing alone.
  if (process.env['TRA2320_CONTROL_NO_404_HANDLER'] !== '1') app.use(notFoundHandler());
  // Stand-in for `errorMiddleware` (same 4-arg shape, same 500 JSON contract);
  // importing the real one would drag the observability store into this suite.
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error', traceId: null });
  });
  return app;
}

let server: Server;
let base: string;

beforeAll(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'tra2320-dist-'));
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(distDir, 'assets', 'app.js'), '// bundle');

  server = createServer(buildApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(distDir, { recursive: true, force: true });
});

describe('security headers on the wire', () => {
  it('stamps the hardening headers on an API response', async () => {
    const res = await fetch(`${base}/api/health/version`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-security-policy-report-only')).toContain("default-src 'self'");
  });

  it('drops x-powered-by', async () => {
    const res = await fetch(`${base}/api/health/version`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('withholds HSTS over plain http but sends it when the proxy says https', async () => {
    // Negative: a real plain-http request. This is the localhost case that must
    // never receive an HSTS pin.
    const plain = await fetch(`${base}/api/health/version`);
    expect(plain.headers.get('strict-transport-security')).toBeNull();

    // Positive: `trust proxy` is on, so X-Forwarded-Proto is how Render's edge
    // tells us the client leg was TLS. Without this leg the test above would
    // also pass on a build that never sends HSTS at all.
    const forwarded = await fetch(`${base}/api/health/version`, {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    expect(forwarded.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });
});

describe('CORS on the wire', () => {
  it('echoes the allowlisted Pages origin and never a wildcard', async () => {
    const res = await fetch(`${base}/api/health/version`, {
      headers: { Origin: PAGES_ORIGIN },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGES_ORIGIN);
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('sends NO allow-origin for a hostile origin — the fix', async () => {
    const res = await fetch(`${base}/api/health/version`, {
      headers: { Origin: 'https://evil.example' },
    });
    // The request still succeeds; the BROWSER is what refuses to hand the body
    // to evil.example, because this header is absent.
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a preflight 204 from an allowlisted origin, with the CORS headers', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: PAGES_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGES_ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
  });

  it('answers a preflight from a non-allowlisted origin WITHOUT allow-origin', async () => {
    // This is QA's stated assertion for TRA-2298, verbatim.
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-headers')).toBeNull();
  });

  it('serves an Origin-less caller normally — the ops scripts must not break', async () => {
    // `tra425_full_regression.mjs`, curl, and every script on the box send no
    // Origin. They must be completely unaffected by this change.
    const res = await fetch(`${base}/api/health/version`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never sends Access-Control-Allow-Credentials', async () => {
    // Auth is a Bearer token in same-origin storage; enabling credentialed CORS
    // would turn the allowlist into a CSRF surface rather than a hardening.
    const res = await fetch(`${base}/api/health/version`, { headers: { Origin: PAGES_ORIGIN } });
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

// TRA-2320 — the enforced CSP survives EVERY response class, not just 200s.
//
// Express ships `default-src 'none'` from two of its own terminal paths
// (`finalhandler/index.js:295`, `serve-static/index.js:204`). Because
// `frame-ancestors` has no fallback to `default-src`, that clobber removes the
// directive outright rather than weakening it. All four cases below were RED on
// live prod (bqb1, 2026-07-25) before this fix.
describe('TRA-2320 — enforced CSP survives every response class', () => {
  const CLASSES: Array<{ name: string; path: string; method?: string; status: number }> = [
    { name: 'unknown /api path (404, finalhandler)', path: '/api/tra2320-no-such-route', status: 404 },
    { name: 'non-GET on a non-API path (404, finalhandler)', path: '/nope', method: 'POST', status: 404 },
    { name: 'thrown route handler (500, error middleware)', path: '/api/tra2320-throws', status: 500 },
    { name: 'SPA fallback (200)', path: '/some/deep/page', status: 200 },
  ];

  for (const c of CLASSES) {
    it(`keeps frame-ancestors on: ${c.name}`, async () => {
      const res = await fetch(`${base}${c.path}`, { method: c.method ?? 'GET' });
      expect(res.status).toBe(c.status);
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      // The headers finalhandler does NOT touch must still be there too, so a
      // regression that dropped the whole middleware can't hide behind this.
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });
  }

  // NEGATIVE CONTROL for the remedy, not just for the bug. The ticket's
  // suggested fix — "add a terminal /api 404 handler" — cannot reach this
  // response: serve-static answers a directory request with a 301 itself and
  // never calls next(), so no 404 handler at any mount point sees it. Only the
  // write-time reassert covers it. If someone later deletes that reassert on
  // the grounds that `notFoundHandler` makes it redundant, THIS test goes red.
  it('keeps frame-ancestors on the serve-static directory redirect (301) — unreachable by any 404 handler', async () => {
    const res = await fetch(`${base}/assets`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/assets/');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });

  it('answers an unknown /api path with JSON, not finalhandler HTML', async () => {
    const res = await fetch(`${base}/api/tra2320-no-such-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not found', path: '/api/tra2320-no-such-route' });
  });

  it('still serves real static assets and the SPA shell', async () => {
    // The 404 handler is mounted last; it must not have swallowed anything that
    // previously worked.
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('// bundle');

    const shell = await fetch(`${base}/some/deep/page`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<title>app</title>');
  });

  it('leaves the Report-Only policy intact on a clobbered class', async () => {
    // finalhandler only rewrites the ENFORCED slot, so a fix that accidentally
    // reasserted the wrong header would show up here.
    const res = await fetch(`${base}/api/tra2320-no-such-route`);
    expect(res.headers.get('content-security-policy-report-only')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy-report-only')).toContain("frame-ancestors 'none'");
  });
});
