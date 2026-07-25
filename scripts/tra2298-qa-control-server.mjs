#!/usr/bin/env node
// TRA-2298 — POSITIVE CONTROLS for the QA re-verification instrument.
//
// A green checker proves nothing until it has been shown to go red on the state
// it claims to detect. This server reproduces, byte for byte, the header sets
// that `tra2298-qa-reverify.mjs` must catch — so the control CONTAINS what the
// instrument detects, rather than merely being "a server that is different".
//
// MODES:
//   prefix     the state the ticket reported, verbatim from its own curl dump:
//              `x-powered-by: Express`, `access-control-allow-origin: *`, and
//              not one security header. The instrument must go RED.
//   outage     headers correct, but the allowlist echoes NOTHING — this is the
//              failure the ticket's OWN suggested allowlist would have caused
//              (public web app dark, server looking perfectly healthy). The
//              instrument must go RED on the allow legs specifically.
//   promiscuous headers correct, but every origin is echoed back. The wildcard
//              bug wearing a different hat. Instrument must go RED on deny legs.
//   hsts-plain everything correct EXCEPT it ships HSTS over plain http — the
//              year-long, user-unclearable localhost break. Must go RED.
//   fixed      the current prod behaviour, over plain http. Used to prove the
//              instrument can still say PASS (a checker that only ever fails is
//              as useless as one that only ever passes).
//
// USAGE: node scripts/tra2298-qa-control-server.mjs --mode=prefix --port=4299

import http from 'node:http';

const modeArg = process.argv.find((a) => a.startsWith('--mode='));
const MODE = modeArg ? modeArg.slice('--mode='.length) : 'prefix';
const portArg = process.argv.find((a) => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.slice('--port='.length)) : 4299;

const ALLOWED = new Set([
  'https://networkgems.github.io',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:1420',
]);

const REPORT_ONLY = [
  "default-src 'self'", "base-uri 'self'", "object-src 'none'",
  "frame-ancestors 'none'", "form-action 'self'", "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "worker-src 'self' blob:", "manifest-src 'self'",
  "connect-src 'self'",
].join('; ');

function securityHeaders(res, { hstsOnPlain = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Content-Security-Policy-Report-Only', REPORT_ONLY);
  if (hstsOnPlain) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (MODE === 'prefix') {
    // The reported state, reproduced exactly. Note `x-powered-by` and the
    // wildcard: these are the two the ticket called out by name.
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Trace-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-Trace-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
    // deliberately NO security headers, NO Vary
  } else {
    securityHeaders(res, { hstsOnPlain: MODE === 'hsts-plain' });
    res.setHeader('Vary', 'Origin');
    if (MODE === 'promiscuous' && origin && origin !== 'null') {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    } else if (MODE !== 'outage' && MODE !== 'promiscuous' && origin && ALLOWED.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Trace-Id');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    // MODE === 'outage' => never echo anything: the silent-outage case.
  }

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  // Route shims so the instrument's real probes have something to grade.
  if (url.pathname === '/api/health/version') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ commit: `control-${MODE}`, commitShort: `control-${MODE}` }));
    return;
  }
  if (url.pathname === '/api/account/settings') {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>control</title>');
});

server.listen(PORT, () => console.log(`control server mode=${MODE} on http://localhost:${PORT}`));
