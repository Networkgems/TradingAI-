import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CSP_REPORT_PATH,
  CSP_REPORTS_READ_PATH,
  CSP_SNAPSHOT_FILENAME,
  MAX_BODY_BYTES,
  MAX_BUCKETS_PER_DAY,
  MAX_REPORTS_PER_REQUEST,
  OVERFLOW_BUCKET,
  RATE_BURST,
  cspReportRouter,
  extractViolations,
  flushCspReportsNow,
  ingestCspReport,
  initCspReportStore,
  normalizeBlockedUri,
  normalizeDirective,
  normalizeOrigin,
  recordViolation,
  resetCspReportStoreForTests,
  snapshotCspReports,
  takeRateToken,
} from './csp-report-collector.js';

// TRA-2344. What this suite is actually defending against, in priority order:
//
//  1. The collector counts NOTHING and says so with a clean-looking zero. That is
//     the failure that already happened once at the layer above — a Report-Only
//     header with no collector reads identically to a clean policy — and every
//     wire-format test below exists because the two formats are different enough
//     to produce exactly that outcome if either is mishandled.
//  2. The collector becomes the attack it was built to mitigate: unbounded buckets,
//     unbounded disk, or a stored URL still carrying a `?reset_code=`.
//
// The suite is written so a collector stuck at "accept everything" fails the bounds
// block, and one stuck at "accept nothing" fails the parsing block. Neither can go
// green one-sided.

const T0 = Date.UTC(2026, 6, 26, 18, 0, 0); // 2026-07-26 14:00 ET

beforeEach(() => {
  resetCspReportStoreForTests(T0);
});

// ── Wire formats: the "silent zero" guard ────────────────────────────────────

describe('extractViolations — both wire formats', () => {
  it('parses the legacy application/csp-report envelope (kebab-case)', () => {
    const v = extractViolations({
      'csp-report': {
        'document-uri': 'https://tradingai-bqb1.onrender.com/dashboard',
        'effective-directive': 'script-src',
        'blocked-uri': 'https://cdn.example.com/a.js',
        disposition: 'report',
      },
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toEqual({
      directive: 'script-src',
      blockedUri: 'https://cdn.example.com',
      documentOrigin: 'https://tradingai-bqb1.onrender.com',
      disposition: 'report',
    });
  });

  it('parses the Reporting API array (camelCase, and it is blockedURL not blockedUri)', () => {
    // The single most likely way to ship a collector that reports zero forever:
    // read `blockedUri` off a payload whose field is `blockedURL`, get `undefined`,
    // and bucket every modern-Chrome violation as `unknown`.
    const v = extractViolations([
      {
        type: 'csp-violation',
        age: 12,
        url: 'https://tradingai-bqb1.onrender.com/dashboard',
        body: {
          documentURL: 'https://tradingai-bqb1.onrender.com/dashboard',
          effectiveDirective: 'connect-src',
          blockedURL: 'https://telemetry.example.com/beacon',
          disposition: 'report',
        },
      },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.directive).toBe('connect-src');
    expect(v[0]?.blockedUri).toBe('https://telemetry.example.com');
    expect(v[0]?.blockedUri).not.toBe('unknown');
  });

  it('ignores non-CSP report types that share the Reporting endpoint', () => {
    // Deprecation / intervention / crash reports arrive on the same endpoint.
    // Counting them as violations would manufacture a dirty session and block
    // TRA-2321 on noise.
    const v = extractViolations([
      { type: 'deprecation', body: { id: 'x', message: 'y' } },
      { type: 'intervention', body: { id: 'z' } },
    ]);
    expect(v).toHaveLength(0);
  });

  it('accepts a bare violation object with no envelope', () => {
    const v = extractViolations({ 'violated-directive': "img-src 'self'", 'blocked-uri': 'data' });
    expect(v).toHaveLength(1);
    expect(v[0]?.directive).toBe('img-src');
    expect(v[0]?.blockedUri).toBe('data');
  });

  it('caps the number of violations honoured from one request', () => {
    const many = Array.from({ length: MAX_REPORTS_PER_REQUEST + 50 }, () => ({
      type: 'csp-violation',
      body: { effectiveDirective: 'img-src', blockedURL: 'https://a.example' },
    }));
    expect(extractViolations(many)).toHaveLength(MAX_REPORTS_PER_REQUEST);
  });

  it('returns nothing for junk rather than throwing', () => {
    for (const junk of [null, 'a string', 42, [], {}, { csp: 1 }, [null, 3]]) {
      expect(() => extractViolations(junk)).not.toThrow();
      expect(extractViolations(junk)).toHaveLength(0);
    }
  });
});

// ── Normalisation: cardinality and credential shedding ───────────────────────

describe('normalizeDirective — the bucket key must be finite by construction', () => {
  it('keeps a known directive, and takes the first token of a full expression', () => {
    expect(normalizeDirective('script-src')).toBe('script-src');
    expect(normalizeDirective("style-src 'self' 'unsafe-inline'")).toBe('style-src');
    expect(normalizeDirective('SCRIPT-SRC-ELEM')).toBe('script-src-elem');
  });

  it('collapses anything unrecognised to `other`', () => {
    // A forged directive is half of an attacker-chosen bucket key otherwise.
    expect(normalizeDirective('x'.repeat(5000))).toBe('other');
    expect(normalizeDirective('made-up-src')).toBe('other');
    expect(normalizeDirective(undefined)).toBe('other');
    expect(normalizeDirective({ evil: true })).toBe('other');
  });
});

describe('normalizeBlockedUri / normalizeOrigin', () => {
  it('preserves the CSP keywords that decide the TRA-2321 promotion', () => {
    // `inline` and `eval` are the two answers that make `script-src 'self'` safe
    // or unsafe to enforce. A URL parse would turn both into `unparseable` and
    // delete the entire signal this collector was built to gather.
    expect(normalizeBlockedUri('inline')).toBe('inline');
    expect(normalizeBlockedUri('eval')).toBe('eval');
    expect(normalizeBlockedUri('wasm-eval')).toBe('wasm-eval');
    expect(normalizeBlockedUri('data')).toBe('data');
  });

  it('STRIPS the path and query — no credential may reach the store', () => {
    // `email.ts` builds real links of this shape. If a reset link is open when a
    // violation fires, `document-uri` carries the code.
    const doc = normalizeOrigin('https://app.example.com/reset?reset_code=SECRET123&u=bob');
    expect(doc).toBe('https://app.example.com');
    expect(doc).not.toContain('SECRET123');
    expect(doc).not.toContain('?');

    const blocked = normalizeBlockedUri('https://evil.example/steal?token=abc#frag');
    expect(blocked).toBe('https://evil.example');
    expect(blocked).not.toContain('abc');
  });

  it('keeps the port, which distinguishes real origins', () => {
    expect(normalizeOrigin('http://localhost:4242/x')).toBe('http://localhost:4242');
  });

  it('reduces a non-special scheme to the scheme alone', () => {
    // `new URL('data:...').origin` is the string "null"; storing that would be
    // both wrong and indistinguishable from the sandboxed-iframe origin.
    expect(normalizeOrigin('data:image/png;base64,AAAA')).toBe('data:');
    expect(normalizeOrigin('chrome-extension://abcdef/inject.js')).toBe('chrome-extension:');
  });

  it('bounds the length of anything it returns', () => {
    const huge = `https://${'a'.repeat(9000)}.example/x`;
    expect(normalizeOrigin(huge).length).toBeLessThanOrEqual(120);
  });

  it('answers `unparseable`/`unknown` instead of echoing junk back', () => {
    expect(normalizeOrigin('not a url')).toBe('unparseable');
    expect(normalizeBlockedUri('')).toBe('unknown');
    expect(normalizeBlockedUri(null)).toBe('unknown');
  });
});

// ── Bounds: the collector must not become the vulnerability ──────────────────

describe('cardinality cap', () => {
  it('folds everything past the per-day cap into ONE overflow bucket', () => {
    // A forged report can mint unlimited distinct blocked-uri values. Without this
    // the store is a remote heap/disk filler.
    for (let i = 0; i < MAX_BUCKETS_PER_DAY + 500; i += 1) {
      recordViolation(
        {
          directive: 'connect-src',
          blockedUri: `https://h${i}.example`,
          documentOrigin: 'https://app.example',
          disposition: 'report',
        },
        T0,
      );
    }
    const snap = snapshotCspReports(null, T0);
    // At most the cap, plus the single overflow bucket.
    expect(snap.buckets.length).toBeLessThanOrEqual(MAX_BUCKETS_PER_DAY + 1);
    const overflow = snap.buckets.filter(b => b.blockedUri === OVERFLOW_BUCKET);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.count).toBe(500);
    // Published, not swallowed: a silently truncated counter reads like a quiet
    // session, which is the exact misreading this whole ticket removes.
    expect(snap.totals.overflowed).toBe(500);
    // Nothing was lost from the running total.
    expect(snap.violations).toBe(MAX_BUCKETS_PER_DAY + 500);
  });

  it('bounds the document origins remembered per bucket', () => {
    for (let i = 0; i < 40; i += 1) {
      recordViolation(
        {
          directive: 'img-src',
          blockedUri: 'data',
          documentOrigin: `https://doc${i}.example`,
          disposition: 'report',
        },
        T0,
      );
    }
    const bucket = snapshotCspReports(null, T0).buckets[0];
    expect(bucket?.count).toBe(40);
    expect(bucket?.documentOrigins.length).toBeLessThanOrEqual(3);
  });
});

describe('rate limit', () => {
  it('admits the burst, then refuses, then recovers as tokens refill', () => {
    for (let i = 0; i < RATE_BURST; i += 1) {
      expect(takeRateToken(T0)).toBe(true);
    }
    expect(takeRateToken(T0)).toBe(false);
    // One token per second.
    expect(takeRateToken(T0 + 1_000)).toBe(true);
    expect(takeRateToken(T0 + 1_000)).toBe(false);
  });

  it('never refills past the burst ceiling after a long idle', () => {
    for (let i = 0; i < RATE_BURST; i += 1) takeRateToken(T0);
    const idle = T0 + 30 * 24 * 3600 * 1000;
    let admitted = 0;
    while (takeRateToken(idle)) admitted += 1;
    expect(admitted).toBe(RATE_BURST);
  });
});

describe('ingestCspReport — outcomes', () => {
  const legacy = {
    'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'inline' },
  };

  it('accepts a well-formed report and counts it', () => {
    expect(ingestCspReport(legacy, 200, T0)).toBe('accepted');
    const snap = snapshotCspReports(null, T0);
    expect(snap.violations).toBe(1);
    expect(snap.buckets[0]?.blockedUri).toBe('inline');
    expect(snap.lastReportAt).not.toBeNull();
  });

  it('refuses an oversize body without counting a violation', () => {
    expect(ingestCspReport(legacy, MAX_BODY_BYTES + 1, T0)).toBe('too-large');
    const snap = snapshotCspReports(null, T0);
    expect(snap.violations).toBe(0);
    expect(snap.totals.droppedTooLarge).toBe(1);
  });

  it('counts a malformed body separately from a clean session', () => {
    expect(ingestCspReport({ nothing: 'useful' }, 40, T0)).toBe('malformed');
    expect(snapshotCspReports(null, T0).totals.droppedMalformed).toBe(1);
    expect(snapshotCspReports(null, T0).violations).toBe(0);
  });

  it('refuses past the rate ceiling, and says so on the read route', () => {
    for (let i = 0; i < RATE_BURST; i += 1) ingestCspReport(legacy, 200, T0);
    expect(ingestCspReport(legacy, 200, T0)).toBe('rate-limited');
    const snap = snapshotCspReports(null, T0);
    expect(snap.totals.droppedRateLimited).toBe(1);
    // The distinction TRA-2321 must be able to make: "clean session" vs "we were
    // being sprayed and stopped listening".
    expect(snap.totals.droppedRateLimited).toBeGreaterThan(0);
  });
});

// ── Read path ────────────────────────────────────────────────────────────────

describe('snapshotCspReports', () => {
  it('filters by ET day and reports the filter it applied', () => {
    const dayBefore = T0 - 24 * 3600 * 1000;
    recordViolation(
      { directive: 'img-src', blockedUri: 'data', documentOrigin: 'https://a', disposition: 'report' },
      dayBefore,
    );
    recordViolation(
      { directive: 'script-src', blockedUri: 'inline', documentOrigin: 'https://a', disposition: 'report' },
      T0,
    );
    expect(snapshotCspReports(null, T0).violations).toBe(2);
    const today = snapshotCspReports('2026-07-26', T0);
    expect(today.violations).toBe(1);
    expect(today.since).toBe('2026-07-26');
    expect(today.buckets[0]?.blockedUri).toBe('inline');
  });

  it('publishes `durable` so a zero can be told apart from a fresh boot', () => {
    // A grader reading `violations: 0` off an ephemeral DATA_DIR is reading a box
    // that rebooted, not a clean session.
    expect(snapshotCspReports(null, T0).durable).toBe(false);
  });
});

// ── Persistence ──────────────────────────────────────────────────────────────

describe('persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra2344-'));
  });
  afterEach(() => {
    resetCspReportStoreForTests(T0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips counters across a restart', () => {
    initCspReportStore(dir, T0);
    ingestCspReport({ 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'inline' } }, 200, T0);
    flushCspReportsNow();

    initCspReportStore(dir, T0 + 60_000); // "restart"
    const snap = snapshotCspReports(null, T0 + 60_000);
    expect(snap.violations).toBe(1);
    expect(snap.buckets[0]?.directive).toBe('script-src');
    expect(snap.durable).toBe(true);
  });

  it('writes ONE snapshot file, never an append log', () => {
    // An append-per-report file is exactly the unbounded growth an unauthenticated
    // POST must not be able to drive.
    initCspReportStore(dir, T0);
    for (let i = 0; i < 50; i += 1) {
      ingestCspReport({ 'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'data' } }, 200, T0);
    }
    flushCspReportsNow();
    const first = readFileSync(join(dir, CSP_SNAPSHOT_FILENAME), 'utf8').length;
    for (let i = 0; i < 50; i += 1) {
      ingestCspReport({ 'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'data' } }, 200, T0);
    }
    flushCspReportsNow();
    const second = readFileSync(join(dir, CSP_SNAPSHOT_FILENAME), 'utf8').length;
    // 100 reports, same bucket — the file grew by a count, not by 50 rows.
    expect(Math.abs(second - first)).toBeLessThan(20);
    expect(snapshotCspReports(null, T0).violations).toBe(100);
  });

  it('re-normalises a poisoned snapshot on hydrate', () => {
    // The file is only as trustworthy as whatever wrote it. An edited snapshot
    // must not be able to reintroduce a path-bearing key past the write-path caps.
    writeFileSync(
      join(dir, CSP_SNAPSHOT_FILENAME),
      JSON.stringify({
        version: 1,
        startedAt: new Date(T0).toISOString(),
        days: [
          {
            day: '2026-07-26',
            buckets: [
              {
                directive: 'totally-made-up',
                blockedUri: 'https://evil.example/steal?token=SECRET',
                count: 3,
              },
            ],
          },
        ],
      }),
      'utf8',
    );
    initCspReportStore(dir, T0);
    const bucket = snapshotCspReports(null, T0).buckets[0];
    expect(bucket?.directive).toBe('other');
    expect(bucket?.blockedUri).toBe('https://evil.example');
    expect(JSON.stringify(bucket)).not.toContain('SECRET');
  });

  it('starts clean on an unreadable snapshot instead of throwing at boot', () => {
    writeFileSync(join(dir, CSP_SNAPSHOT_FILENAME), '{not json', 'utf8');
    expect(() => initCspReportStore(dir, T0)).not.toThrow();
    expect(snapshotCspReports(null, T0).violations).toBe(0);
  });
});

// ── Wire ─────────────────────────────────────────────────────────────────────
//
// The unit blocks grade the decisions; this one grades real bytes over a real
// socket through the SAME router `index.ts` mounts. The specific thing it proves
// is the one a unit test structurally cannot: that a body sent as
// `application/csp-report` is actually READ. Under the global `express.json()`
// that body arrives as `{}` — no error, no log, a permanent silent zero.

describe('wire', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(cspReportRouter());
    // Mounted AFTER, mirroring index.ts — if the router ever stopped consuming the
    // body, this parser would silently take over and the content-type test below
    // would start failing, which is the point.
    app.use(express.json());
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const post = (body: string, contentType: string): Promise<Response> =>
    fetch(`${base}${CSP_REPORT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });

  it('reads a body sent as application/csp-report', async () => {
    const res = await post(
      JSON.stringify({
        'csp-report': {
          'document-uri': 'https://app.example/dash',
          'effective-directive': 'script-src',
          'blocked-uri': 'inline',
        },
      }),
      'application/csp-report',
    );
    expect(res.status).toBe(204);

    const read = await fetch(`${base}${CSP_REPORTS_READ_PATH}`);
    const json = (await read.json()) as { violations: number; buckets: { blockedUri: string }[] };
    expect(json.violations).toBe(1);
    expect(json.buckets[0]?.blockedUri).toBe('inline');
  });

  it('reads a body sent as application/reports+json', async () => {
    const before = ((await (await fetch(`${base}${CSP_REPORTS_READ_PATH}`)).json()) as { violations: number })
      .violations;
    const res = await post(
      JSON.stringify([
        {
          type: 'csp-violation',
          body: { effectiveDirective: 'connect-src', blockedURL: 'https://x.example/a?k=1' },
        },
      ]),
      'application/reports+json',
    );
    expect(res.status).toBe(204);
    const json = (await (await fetch(`${base}${CSP_REPORTS_READ_PATH}`)).json()) as {
      violations: number;
      buckets: { blockedUri: string }[];
    };
    expect(json.violations).toBe(before + 1);
    expect(json.buckets.map(b => b.blockedUri)).toContain('https://x.example');
  });

  it('answers 204 for junk and for an oversize body — never an oracle', async () => {
    // A status that varied by outcome would tell an attacker exactly where the
    // limits sit. Refusals show up on the read route instead.
    expect((await post('not json at all', 'application/csp-report')).status).toBe(204);
    expect((await post('', 'application/csp-report')).status).toBe(204);
    const huge = JSON.stringify({
      'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': `https://${'a'.repeat(MAX_BODY_BYTES)}.x` },
    });
    const res = await post(huge, 'application/csp-report');
    expect(res.status).toBe(204);

    const json = (await (await fetch(`${base}${CSP_REPORTS_READ_PATH}`)).json()) as {
      totals: { droppedTooLarge: number; droppedMalformed: number };
    };
    expect(json.totals.droppedTooLarge).toBeGreaterThan(0);
    expect(json.totals.droppedMalformed).toBeGreaterThan(0);
  });

  it('serves the read route unauthenticated, with the limits it enforces', async () => {
    const res = await fetch(`${base}${CSP_REPORTS_READ_PATH}?since=2026-07-26`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; limits: { maxBodyBytes: number } };
    expect(json.ok).toBe(true);
    expect(json.limits.maxBodyBytes).toBe(MAX_BODY_BYTES);
  });

  it('ignores a malformed `since` rather than guessing at the window', async () => {
    const json = (await (
      await fetch(`${base}${CSP_REPORTS_READ_PATH}?since=last-tuesday`)
    ).json()) as { since: string | null };
    expect(json.since).toBeNull();
  });
});
