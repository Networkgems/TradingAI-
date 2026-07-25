#!/usr/bin/env node
// TRA-2298 — verify the prod HTTP hardening against a LIVE host.
//
//   node scripts/tra2298-verify-headers.mjs [--host=https://tradingai-bqb1.onrender.com]
//
// Exit codes:
//   0  PASS   — every leg asserted and green
//   1  FAIL   — a leg asserted and RED
//   3  BLIND  — a leg could not be read at all (host down, DNS, timeout)
//
// BLIND is a distinct code on purpose. A checker that cannot reach the host has
// learned nothing about the host, and "no bad header observed" is not the same
// fact as "the bad header is gone" (TRA-2261). It must never fall through to 0.
//
// The suite is two-sided by construction and REFUSES TO RUN one-sided: it
// asserts both that a hostile origin is denied AND that the allowlisted GitHub
// Pages origin is still served. A server that is simply down, or that has been
// "hardened" by denying every origin, fails the second leg — which is the leg
// that protects the live public web app. A one-sided pass here would be exactly
// the false all-clear that ships an outage.

const HOST = (process.argv.find(a => a.startsWith('--host=')) ?? '')
  .split('=').slice(1).join('=') || 'https://tradingai-bqb1.onrender.com';
const TIMEOUT_MS = 30_000;

// The live public web app (`deploy-pages.yml`). Proven to call this API
// cross-origin — its bundle has `wss://tradingai-bqb1.onrender.com` baked in.
const ALLOWED_ORIGIN = 'https://networkgems.github.io';
const HOSTILE_ORIGIN = 'https://evil.example';

let pass = 0;
let fail = 0;
let blind = 0;
/** Set when a leg proves the allowlist can still say YES. Guards one-sidedness. */
let sawAllow = false;
/** Set when a leg proves the allowlist can say NO. */
let sawDeny = false;

function ok(label, detail = '') {
  pass++;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}
function bad(label, expected, actual) {
  fail++;
  console.log(`  FAIL  ${label}\n          expected: ${expected}\n          actual:   ${actual}`);
}
function unreadable(label, reason) {
  blind++;
  console.log(`  BLIND ${label} — ${reason}`);
}

async function req(path, { method = 'GET', headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${HOST}${path}`, { method, headers, signal: ctl.signal, redirect: 'manual' });
    return { res };
  } catch (err) {
    return { err: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

function assertHeader(res, label, name, expected) {
  // Grade the VALUE, not presence (TRA-2163/TRA-2296): a present-but-wrong
  // header is not a restored header.
  const actual = res.headers.get(name);
  if (actual === null) return bad(label, expected, '<header absent>');
  const hit = typeof expected === 'string' ? actual === expected : expected.test(actual);
  return hit ? ok(label, actual) : bad(label, String(expected), actual);
}

function assertAbsent(res, label, name) {
  const actual = res.headers.get(name);
  return actual === null ? ok(label, '<absent>') : bad(label, '<absent>', actual);
}

async function main() {
  console.log(`[tra2298] host: ${HOST}`);
  console.log(`[tra2298] ${new Date().toISOString()}\n`);

  // ── Leg 1: security headers on an API response ────────────────────────────
  console.log('Leg 1 — security headers (GET /api/health/version)');
  {
    const { res, err } = await req('/api/health/version');
    if (err) {
      unreadable('GET /api/health/version', err);
    } else if (res.status !== 200) {
      bad('GET /api/health/version status', '200', String(res.status));
    } else {
      assertHeader(res, 'Strict-Transport-Security', 'strict-transport-security', 'max-age=31536000; includeSubDomains');
      assertHeader(res, 'X-Content-Type-Options', 'x-content-type-options', 'nosniff');
      assertHeader(res, 'X-Frame-Options', 'x-frame-options', 'DENY');
      assertHeader(res, 'Referrer-Policy', 'referrer-policy', 'strict-origin-when-cross-origin');
      assertHeader(res, 'Content-Security-Policy (frame-ancestors)', 'content-security-policy', /frame-ancestors 'none'/);
      assertHeader(res, 'CSP-Report-Only (staged full policy)', 'content-security-policy-report-only', /default-src 'self'/);
      assertAbsent(res, 'x-powered-by removed', 'x-powered-by');
    }
  }

  // ── Leg 2: the SPA shell carries them too, not just /api ──────────────────
  console.log('\nLeg 2 — security headers on the SPA shell (GET /)');
  {
    const { res, err } = await req('/');
    if (err) {
      unreadable('GET /', err);
    } else {
      // Clickjacking is a threat to the DOCUMENT, so this is the leg that
      // actually closes the kill-switch/close-position exposure. A build that
      // mounted the middleware after the static handler would pass Leg 1 and
      // fail here.
      assertHeader(res, 'X-Frame-Options on /', 'x-frame-options', 'DENY');
      assertHeader(res, 'CSP frame-ancestors on /', 'content-security-policy', /frame-ancestors 'none'/);
      assertAbsent(res, 'x-powered-by removed on /', 'x-powered-by');
    }
  }

  // ── Leg 3: NEGATIVE — a hostile origin gets no allow-origin ───────────────
  console.log('\nLeg 3 — CORS denies a non-allowlisted origin');
  {
    const { res, err } = await req('/api/auth/login', {
      method: 'OPTIONS',
      headers: { Origin: HOSTILE_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    if (err) {
      unreadable('OPTIONS /api/auth/login (hostile origin)', err);
    } else {
      const acao = res.headers.get('access-control-allow-origin');
      if (acao === null) {
        sawDeny = true;
        ok('preflight from evil.example carries no access-control-allow-origin');
      } else {
        bad('preflight from evil.example', '<no access-control-allow-origin>', acao);
      }
    }
  }

  // ── Leg 4: POSITIVE — the live web app is still served ────────────────────
  console.log('\nLeg 4 — CORS still serves the allowlisted GitHub Pages origin');
  {
    const { res, err } = await req('/api/auth/login', {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
    });
    if (err) {
      unreadable('OPTIONS /api/auth/login (pages origin)', err);
    } else {
      const acao = res.headers.get('access-control-allow-origin');
      if (acao === ALLOWED_ORIGIN) {
        sawAllow = true;
        ok('preflight from the Pages origin is echoed exactly', acao);
      } else {
        bad('preflight from the Pages origin', ALLOWED_ORIGIN, acao ?? '<absent> — THE PUBLIC WEB APP IS DARK');
      }
      const allowHeaders = res.headers.get('access-control-allow-headers');
      if (allowHeaders && /authorization/i.test(allowHeaders)) ok('Authorization still permitted for the web app', allowHeaders);
      else bad('access-control-allow-headers', 'contains Authorization', allowHeaders ?? '<absent>');
    }
  }

  // ── Leg 5: no wildcard anywhere, and Vary: Origin is set ──────────────────
  console.log('\nLeg 5 — no wildcard, and the response varies by Origin');
  {
    const { res, err } = await req('/api/health/version', { headers: { Origin: ALLOWED_ORIGIN } });
    if (err) {
      unreadable('GET /api/health/version (pages origin)', err);
    } else {
      const acao = res.headers.get('access-control-allow-origin');
      if (acao === '*') bad('access-control-allow-origin is not a wildcard', ALLOWED_ORIGIN, '*');
      else ok('access-control-allow-origin is not a wildcard', String(acao));
      // Without `Vary: Origin`, Cloudflare can replay one origin's cached
      // response to another — handing the `*` behaviour back through the cache.
      assertHeader(res, 'Vary includes Origin', 'vary', /Origin/i);
      assertAbsent(res, 'no access-control-allow-credentials', 'access-control-allow-credentials');
    }
  }

  // ── Leg 6: an Origin-less caller (curl / the ops scripts) is unaffected ────
  console.log('\nLeg 6 — Origin-less callers still work (curl, ops scripts, QA harness)');
  {
    const { res, err } = await req('/api/health/version');
    if (err) {
      unreadable('GET /api/health/version (no Origin)', err);
    } else if (res.status === 200) {
      ok('no-Origin request still returns 200');
    } else {
      bad('no-Origin request status', '200', String(res.status));
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log(`\n[tra2298] pass=${pass} fail=${fail} blind=${blind}`);

  // ORDER MATTERS. A red leg is a fact about the world even when a DIFFERENT
  // leg was unreadable or one-sided, so FAIL outranks BLIND. Graded the other
  // way round, this checker run against the pre-fix build printed
  // "BLIND — refusing to grade" while holding 14 red legs, which reads to the
  // next operator as "the instrument didn't work" rather than "the box is
  // unhardened". BLIND is for when there is NOTHING decisive to say.
  if (fail > 0) {
    console.log(`[tra2298] FAIL — ${fail} leg(s) red.${blind > 0 ? ` (${blind} additional leg unreadable.)` : ''}`);
    process.exit(1);
  }
  if (blind > 0) {
    console.log('[tra2298] BLIND — at least one leg could not be read. This is NOT a pass.');
    process.exit(3);
  }
  if (!sawAllow || !sawDeny) {
    // No red legs, but the allowlist never demonstrated both answers — e.g. a
    // wildcard build satisfies neither. Nothing decisive: refuse to grade.
    console.log(
      `[tra2298] BLIND — one-sided run (sawAllow=${sawAllow}, sawDeny=${sawDeny}). ` +
        'An allowlist that only ever says NO is an outage, and one that only ever says YES is the bug. Refusing to grade.',
    );
    process.exit(3);
  }
  console.log('[tra2298] PASS — hardening live, and the public web app is still served.');
  process.exit(0);
}

main().catch(err => {
  console.error('[tra2298] BLIND — checker threw:', err);
  process.exit(3);
});
