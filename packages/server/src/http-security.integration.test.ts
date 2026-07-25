import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  buildAllowedOrigins,
  corsMiddleware,
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
  return app;
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(buildApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
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
