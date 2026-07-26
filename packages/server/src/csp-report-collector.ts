// TRA-2344 — CSP violation-report collector. The INSTRUMENT that TRA-2321
// (promote the Report-Only CSP to enforced) has to read before it can be graded.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// TRA-2298 shipped the full candidate policy as `Content-Security-Policy-Report-Only`
// and left only `frame-ancestors 'none'` enforced. Nothing collects the reports, so
// violations reach a browser console and stop there. The failure DIRECTION is what
// makes that expensive: a Report-Only header with no collector reads IDENTICALLY to
// a perfectly clean policy. Zero reports is not evidence of zero violations; it is
// the absence of a measurement. Promoting on that silence means learning about a
// dark panel from a user, on the live money-moving box.
//
// So: build the instrument, let it run one clean RTH session, and only then let
// TRA-2321 read it. This file promotes NOTHING. `http-security.ts` keeps the
// enforced slot at exactly `frame-ancestors 'none'`, and `http-security.test.ts`
// pins that with a control this ticket deliberately did not touch.
//
// ── Why this is hostile input, and what that buys ────────────────────────────
//
// Browsers post these UNAUTHENTICATED — that is not a design choice we get to
// make, it is how `report-uri`/`report-to` work. On bqb1 that means an
// unauthenticated POST that persists attacker-controlled JSON sits on the same
// host as the broker path. Anyone on the internet can post anything to it, as
// fast as they like, forever. Every bound below exists because of that, and the
// cardinality bound is the one that actually matters:
//
//   • BODY SIZE     — 8 KB, enforced by the route's own parser, not the global one.
//   • REPORTS/REQ   — a `reports+json` array is capped at 20 entries.
//   • REQUEST RATE  — a process-wide token bucket. Deliberately NOT per-IP: a
//                     per-IP map is itself an unbounded-cardinality store, so the
//                     obvious "fix" would reintroduce the bug it is guarding.
//                     Over-rate requests are counted and dropped; the response is
//                     unchanged (204) so the endpoint never becomes an oracle for
//                     how close you are to the limit.
//   • CARDINALITY   — the real one. A forged report can mint unlimited distinct
//                     `blocked-uri` values, so a naive `Map<blockedUri, count>` is
//                     a remote heap/disk filler wearing a hard hat. Two bounds:
//                     URIs are reduced to an ORIGIN (never a path), and each ET day
//                     accepts at most MAX_BUCKETS_PER_DAY distinct buckets — after
//                     that every further violation lands in one `__overflow__`
//                     bucket. Overflow is COUNTED and published, because a silently
//                     truncated counter would read exactly like a quiet session,
//                     which is the same failure this whole ticket exists to fix.
//   • DISK          — RETAIN_DAYS ET days x MAX_BUCKETS_PER_DAY rows, rewritten as
//                     one atomic snapshot. There is no append path, so there is no
//                     way to grow the file by posting more.
//
// A collector that can be used to fill the disk is a worse bug than the one we
// are hardening against.
//
// ── Why nothing here stores a URL path ───────────────────────────────────────
//
// `blocked-uri`, `document-uri` and `source-file` are all attacker-influenced AND
// can carry real session material from our own pages (`?reset_code=`, in this very
// app — see `email.ts`). Reports are reduced to `scheme://host[:port]` BEFORE they
// are counted, so a query string is dropped at the door and never reaches memory,
// the snapshot file, or the read route. That is also why the read route can be
// public: there is nothing in it to leak.

import express, { type RequestHandler, type Router } from 'express';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from './observability/index.js';
// The ET-correctness decision lives in ONE place (TRA-407). Re-typing
// `toLocaleDateString('en-CA', …)` here would fork it; `scheduler.ts` imports
// nothing but the logger, so this is not a cycle.
import { etDateString } from './scheduler.js';

const log = logger.child({ module: 'csp-report-collector' });

// The collector path and the `Reporting-Endpoints` group name live in
// `http-security.ts` because they appear in the CSP HEADER, and that module is the
// one thing on this path with no runtime imports. Importing them here (rather than
// re-typing the string) keeps the route this file mounts and the URL the browser is
// told to post to from ever drifting apart — a drift that would produce zero
// reports and no error anywhere.
import { CSP_REPORT_PATH, CSP_REPORT_GROUP } from './http-security.js';
export { CSP_REPORT_PATH, CSP_REPORT_GROUP };

export const CSP_SNAPSHOT_FILENAME = 'csp-violations.json';

/** Max accepted request body. A real CSP report is a few hundred bytes. */
export const MAX_BODY_BYTES = 8 * 1024;

/** Max violations honoured from one `application/reports+json` array. */
export const MAX_REPORTS_PER_REQUEST = 20;

/** Max distinct (directive x blocked-origin) buckets retained per ET day. */
export const MAX_BUCKETS_PER_DAY = 200;

/** ET days of history kept on disk and in memory. */
export const RETAIN_DAYS = 7;

/** Token bucket: sustained rate and burst ceiling, process-wide. */
export const RATE_REFILL_PER_SEC = 1;
export const RATE_BURST = 120;

/** Hard truncation for any stored URI-ish string. */
const MAX_URI_LEN = 120;

/** Distinct document origins remembered per bucket (diagnostic, bounded). */
const MAX_DOC_ORIGINS_PER_BUCKET = 3;

/** Sentinel bucket that absorbs everything past the per-day cardinality cap. */
export const OVERFLOW_BUCKET = '__overflow__';

/**
 * CSP directive names we are willing to store verbatim. Anything else — including
 * a forged `"effective-directive": "<8kb of junk>"` — collapses to `other`, which
 * is what makes the directive half of the bucket key finite by construction rather
 * than by hoping browsers behave.
 */
const KNOWN_DIRECTIVES: ReadonlySet<string> = new Set([
  'base-uri',
  'block-all-mixed-content',
  'child-src',
  'connect-src',
  'default-src',
  'font-src',
  'form-action',
  'frame-ancestors',
  'frame-src',
  'img-src',
  'manifest-src',
  'media-src',
  'navigate-to',
  'object-src',
  'prefetch-src',
  'report-to',
  'report-uri',
  'require-trusted-types-for',
  'sandbox',
  'script-src',
  'script-src-attr',
  'script-src-elem',
  'style-src',
  'style-src-attr',
  'style-src-elem',
  'trusted-types',
  'upgrade-insecure-requests',
  'worker-src',
]);

/**
 * `blocked-uri` values that are CSP KEYWORDS, not URLs. These are the ones that
 * actually matter for grading TRA-2321 — `inline` and `eval` are what a
 * `script-src 'self'` promotion would break — so they must survive normalisation
 * intact rather than being mangled by a URL parse that was never going to succeed.
 */
const BLOCKED_URI_KEYWORDS: ReadonlySet<string> = new Set([
  'about',
  'blob',
  'data',
  'eval',
  'filesystem',
  'inline',
  'self',
  'trusted-types-policy',
  'trusted-types-sink',
  'wasm-eval',
  'wasm-unsafe-eval',
]);

export interface NormalizedViolation {
  /** A member of KNOWN_DIRECTIVES, or `other`. */
  directive: string;
  /** A CSP keyword, an origin (`scheme://host[:port]`), or `unknown`/`unparseable`. */
  blockedUri: string;
  /** Origin of the page that reported, or `unknown`. Never a path. */
  documentOrigin: string;
  /** `report` for Report-Only, `enforce` for the enforced policy, or `unknown`. */
  disposition: string;
}

export interface ViolationBucket {
  directive: string;
  blockedUri: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  dispositions: string[];
  documentOrigins: string[];
}

export interface CspCollectorTotals {
  /** Requests that reached the handler, before any bound was applied. */
  requestsReceived: number;
  /** Individual violations actually counted into a bucket. */
  violationsAccepted: number;
  /** Requests refused by the token bucket. */
  droppedRateLimited: number;
  /** Requests refused for body size. */
  droppedTooLarge: number;
  /** Requests whose body parsed but yielded no recognisable violation. */
  droppedMalformed: number;
  /** Violations that landed in the per-day overflow bucket. */
  overflowed: number;
}

interface DayRecord {
  day: string;
  buckets: Map<string, ViolationBucket>;
}

interface StoreState {
  startedAt: string;
  days: Map<string, DayRecord>;
  totals: CspCollectorTotals;
  lastReportAt: string | null;
}

function emptyTotals(): CspCollectorTotals {
  return {
    requestsReceived: 0,
    violationsAccepted: 0,
    droppedRateLimited: 0,
    droppedTooLarge: 0,
    droppedMalformed: 0,
    overflowed: 0,
  };
}

function emptyState(nowIso: string): StoreState {
  return { startedAt: nowIso, days: new Map(), totals: emptyTotals(), lastReportAt: null };
}

let state: StoreState = emptyState(new Date(0).toISOString());
let dataDir: string | null = null;

// ── Normalisation (pure — this is the part worth testing hardest) ────────────

/**
 * Reduce a reported directive to a bounded label.
 *
 * `violated-directive` (the legacy field) carries the whole source expression,
 * e.g. `"script-src 'self' https://cdn.example"`, so take the first token. Then
 * check it against the allowlist: an unrecognised value is `other`, never stored
 * verbatim, because the directive is half of the bucket key and a key an attacker
 * can choose freely is a cardinality hole.
 */
export function normalizeDirective(raw: unknown): string {
  if (typeof raw !== 'string') return 'other';
  const first = raw.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return KNOWN_DIRECTIVES.has(first) ? first : 'other';
}

/**
 * Reduce any URL to `scheme://host[:port]`, dropping path, query and fragment.
 *
 * This is the credential-shedding step. `document-uri` on this app can legitimately
 * contain `?reset_code=…` (`email.ts` builds exactly that link), and `blocked-uri`
 * is whatever a remote page chose. Neither may reach a store, so the path is
 * discarded before the value is ever retained — not redacted afterwards.
 *
 * Non-special schemes (`data:`, `chrome-extension:`, `tauri:`) have no meaningful
 * origin in the WHATWG model — `new URL('data:x').origin` is the string `"null"` —
 * so those collapse to the bare scheme, which is the fact worth keeping anyway.
 */
export function normalizeOrigin(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const trimmed = raw.trim();
  if (!trimmed) return 'unknown';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'unparseable';
  }
  const origin = url.origin;
  if (origin && origin !== 'null') return origin.slice(0, MAX_URI_LEN);
  // `url.protocol` is e.g. `data:` — already includes the colon.
  return url.protocol.slice(0, 32);
}

/**
 * Normalise `blocked-uri` / `blockedURL`.
 *
 * Keywords first: browsers report `"inline"` and `"eval"` as bare words, and those
 * are precisely the two that decide whether TRA-2321's `script-src 'self'` promotion
 * is safe. Passing them through a URL parse would turn both into `unparseable` and
 * destroy the one signal the ticket is being built to collect.
 */
export function normalizeBlockedUri(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const trimmed = raw.trim();
  if (!trimmed) return 'unknown';
  const lower = trimmed.toLowerCase();
  if (BLOCKED_URI_KEYWORDS.has(lower)) return lower;
  return normalizeOrigin(trimmed);
}

function normalizeDisposition(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const lower = raw.trim().toLowerCase();
  return lower === 'report' || lower === 'enforce' ? lower : 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pull normalised violations out of either wire format.
 *
 * The two formats are NOT the same shape, and the difference is easy to get wrong
 * in a way that silently yields zero violations forever:
 *
 *   `application/csp-report`   (legacy `report-uri`)  — one object,
 *       `{ "csp-report": { "effective-directive": …, "blocked-uri": … } }`, kebab-case.
 *   `application/reports+json` (Reporting API `report-to`) — an ARRAY of envelopes,
 *       `[{ "type": "csp-violation", "body": { "effectiveDirective": …, "blockedURL": … } }]`,
 *       camelCase, and `blockedURL` — not `blockedUri`.
 *
 * Both are accepted regardless of the declared content type, because proxies and
 * older browsers mislabel these often enough that keying on the header would drop
 * real reports. Envelopes whose `type` is not `csp-violation` (deprecation,
 * intervention, crash reports also arrive on a Reporting endpoint) are ignored.
 */
export function extractViolations(body: unknown): NormalizedViolation[] {
  const out: NormalizedViolation[] = [];

  const pushLegacy = (rep: Record<string, unknown>): void => {
    out.push({
      directive: normalizeDirective(rep['effective-directive'] ?? rep['violated-directive']),
      blockedUri: normalizeBlockedUri(rep['blocked-uri']),
      documentOrigin: normalizeOrigin(rep['document-uri']),
      disposition: normalizeDisposition(rep['disposition'] ?? 'report'),
    });
  };

  const pushModern = (rep: Record<string, unknown>): void => {
    out.push({
      directive: normalizeDirective(rep['effectiveDirective'] ?? rep['violatedDirective']),
      blockedUri: normalizeBlockedUri(rep['blockedURL'] ?? rep['blockedUrl']),
      documentOrigin: normalizeOrigin(rep['documentURL'] ?? rep['documentUrl']),
      disposition: normalizeDisposition(rep['disposition'] ?? 'report'),
    });
  };

  if (Array.isArray(body)) {
    for (const entry of body.slice(0, MAX_REPORTS_PER_REQUEST)) {
      const envelope = asRecord(entry);
      if (!envelope) continue;
      const type = typeof envelope['type'] === 'string' ? envelope['type'] : '';
      if (type && type !== 'csp-violation') continue;
      const inner = asRecord(envelope['body']);
      if (!inner) continue;
      // A Reporting-API envelope carrying a legacy-shaped body is not a thing any
      // browser sends, but accepting it costs one branch and turns a mislabelled
      // proxy rewrite from "silent zero" into a counted violation.
      if ('csp-report' in inner) {
        const legacy = asRecord(inner['csp-report']);
        if (legacy) pushLegacy(legacy);
        continue;
      }
      pushModern(inner);
    }
    return out;
  }

  const obj = asRecord(body);
  if (!obj) return out;
  const legacy = asRecord(obj['csp-report']);
  if (legacy) {
    pushLegacy(legacy);
    return out;
  }
  // A bare violation object (no envelope). Some tooling and older WebKit post this.
  if ('effective-directive' in obj || 'violated-directive' in obj || 'blocked-uri' in obj) {
    pushLegacy(obj);
    return out;
  }
  if ('effectiveDirective' in obj || 'blockedURL' in obj) {
    pushModern(obj);
  }
  return out;
}

// ── Rate limiting ────────────────────────────────────────────────────────────

let tokens = RATE_BURST;
let lastRefillMs = 0;

/**
 * Process-wide token bucket. Returns false when the request must be dropped.
 *
 * Deliberately not keyed by IP: a `Map<ip, bucket>` is an unbounded-cardinality
 * store fed by an unauthenticated endpoint, i.e. the exact hazard the rest of this
 * file is built to avoid. The thing worth bounding here is OUR work per second, and
 * a global bucket bounds that under any distribution of sources. The cost is that a
 * flood can crowd out real reports — which is why `droppedRateLimited` is published
 * rather than swallowed, so TRA-2321 can tell "clean session" from "we were being
 * sprayed and stopped listening".
 */
export function takeRateToken(nowMs: number): boolean {
  if (lastRefillMs === 0) lastRefillMs = nowMs;
  const elapsedSec = Math.max(0, (nowMs - lastRefillMs) / 1000);
  if (elapsedSec > 0) {
    tokens = Math.min(RATE_BURST, tokens + elapsedSec * RATE_REFILL_PER_SEC);
    lastRefillMs = nowMs;
  }
  if (tokens < 1) return false;
  tokens -= 1;
  return true;
}

// ── Store ────────────────────────────────────────────────────────────────────

function bucketKey(directive: string, blockedUri: string): string {
  return `${directive}|${blockedUri}`;
}

function pruneDays(): void {
  if (state.days.size <= RETAIN_DAYS) return;
  const sorted = [...state.days.keys()].sort();
  for (const day of sorted.slice(0, sorted.length - RETAIN_DAYS)) state.days.delete(day);
}

/**
 * Count one violation into its (ET day, directive, blocked-origin) bucket.
 *
 * Returns the bucket key actually used, which is NOT always the one implied by the
 * violation: past MAX_BUCKETS_PER_DAY distinct buckets in a day, everything folds
 * into `__overflow__|__overflow__`. The caller does not get to opt out of that.
 */
export function recordViolation(v: NormalizedViolation, nowMs: number = Date.now()): string {
  const day = etDateString(new Date(nowMs));
  const iso = new Date(nowMs).toISOString();
  let record = state.days.get(day);
  if (!record) {
    record = { day, buckets: new Map() };
    state.days.set(day, record);
    pruneDays();
  }

  let key = bucketKey(v.directive, v.blockedUri);
  let directive = v.directive;
  let blockedUri = v.blockedUri;
  if (!record.buckets.has(key) && record.buckets.size >= MAX_BUCKETS_PER_DAY) {
    directive = OVERFLOW_BUCKET;
    blockedUri = OVERFLOW_BUCKET;
    key = bucketKey(directive, blockedUri);
    state.totals.overflowed += 1;
  }

  let bucket = record.buckets.get(key);
  if (!bucket) {
    bucket = {
      directive,
      blockedUri,
      count: 0,
      firstSeen: iso,
      lastSeen: iso,
      dispositions: [],
      documentOrigins: [],
    };
    record.buckets.set(key, bucket);
  }
  bucket.count += 1;
  bucket.lastSeen = iso;
  if (!bucket.dispositions.includes(v.disposition)) bucket.dispositions.push(v.disposition);
  if (
    bucket.documentOrigins.length < MAX_DOC_ORIGINS_PER_BUCKET
    && !bucket.documentOrigins.includes(v.documentOrigin)
  ) {
    bucket.documentOrigins.push(v.documentOrigin);
  }

  state.totals.violationsAccepted += 1;
  state.lastReportAt = iso;
  return key;
}

export interface CspCollectorSnapshot {
  ok: true;
  /** When this process (or this DATA_DIR) started counting. */
  startedAt: string;
  /** ISO of the most recent counted violation, or null. THE liveness field. */
  lastReportAt: string | null;
  /** ET day the read was served on. */
  today: string;
  /** True when the snapshot survives a redeploy; false ⇒ counters are since-boot. */
  durable: boolean;
  /** ET day filter applied, if any. */
  since: string | null;
  /** Total violations across the returned days. */
  violations: number;
  /** One row per (day, directive, blocked-origin). */
  buckets: (ViolationBucket & { day: string })[];
  totals: CspCollectorTotals;
  limits: {
    maxBodyBytes: number;
    maxReportsPerRequest: number;
    maxBucketsPerDay: number;
    retainDays: number;
    rateBurst: number;
    rateRefillPerSec: number;
  };
}

/**
 * Read path. `since` is an ET day (`YYYY-MM-DD`) and filters by DAY, not instant —
 * exact at the granularity the counters are kept at. That is the honest bound: a
 * finer filter would have to be approximated from `lastSeen`, and an approximate
 * count published as an exact one is how a grader ends up confidently wrong.
 */
export function snapshotCspReports(
  since: string | null = null,
  nowMs: number = Date.now(),
): CspCollectorSnapshot {
  const days = [...state.days.values()]
    .filter(d => !since || d.day >= since)
    .sort((a, b) => a.day.localeCompare(b.day));
  const buckets = days.flatMap(d =>
    [...d.buckets.values()]
      .sort((a, b) => b.count - a.count)
      .map(b => ({ day: d.day, ...b })),
  );
  return {
    ok: true,
    startedAt: state.startedAt,
    lastReportAt: state.lastReportAt,
    today: etDateString(new Date(nowMs)),
    durable: dataDir !== null,
    since,
    violations: buckets.reduce((sum, b) => sum + b.count, 0),
    buckets,
    totals: { ...state.totals },
    limits: {
      maxBodyBytes: MAX_BODY_BYTES,
      maxReportsPerRequest: MAX_REPORTS_PER_REQUEST,
      maxBucketsPerDay: MAX_BUCKETS_PER_DAY,
      retainDays: RETAIN_DAYS,
      rateBurst: RATE_BURST,
      rateRefillPerSec: RATE_REFILL_PER_SEC,
    },
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────
//
// One atomic snapshot rewrite, debounced. There is no append path on purpose:
// an append-per-report file is exactly the unbounded growth an unauthenticated
// POST must never be able to drive. The file's size is capped by
// RETAIN_DAYS x MAX_BUCKETS_PER_DAY regardless of traffic.

const FLUSH_DEBOUNCE_MS = 15_000;
let flushTimer: NodeJS.Timeout | null = null;

function snapshotFilePath(dir: string): string {
  return join(dir, CSP_SNAPSHOT_FILENAME);
}

export function flushCspReportsNow(): void {
  if (!dataDir) return;
  const payload = {
    version: 1,
    startedAt: state.startedAt,
    lastReportAt: state.lastReportAt,
    totals: state.totals,
    days: [...state.days.values()].map(d => ({ day: d.day, buckets: [...d.buckets.values()] })),
  };
  const target = snapshotFilePath(dataDir);
  const tmp = `${target}.tmp`;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    // Best-effort. A hardening counter must never be the reason a response fails.
    log.warn('csp snapshot write failed', { error: String(err) });
  }
}

function scheduleFlush(): void {
  if (!dataDir || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushCspReportsNow();
  }, FLUSH_DEBOUNCE_MS);
  // Never hold the process open for a counter flush.
  flushTimer.unref?.();
}

/**
 * Boot hydrate. Counters resume across a restart when DATA_DIR is durable, and
 * silently start from zero when it is not — which is why `durable` is published on
 * the read route rather than inferred. A grader reading `violations: 0` needs to
 * know whether that is a clean session or a box that rebooted an hour ago.
 */
export function initCspReportStore(dir: string | null, nowMs: number = Date.now()): void {
  dataDir = dir;
  state = emptyState(new Date(nowMs).toISOString());
  if (!dir) return;
  try {
    const raw = JSON.parse(readFileSync(snapshotFilePath(dir), 'utf8')) as unknown;
    const obj = asRecord(raw);
    if (!obj) return;
    if (typeof obj['startedAt'] === 'string') state.startedAt = obj['startedAt'];
    if (typeof obj['lastReportAt'] === 'string') state.lastReportAt = obj['lastReportAt'];
    const totals = asRecord(obj['totals']);
    if (totals) {
      for (const key of Object.keys(state.totals) as (keyof CspCollectorTotals)[]) {
        const v = totals[key];
        if (typeof v === 'number' && Number.isFinite(v)) state.totals[key] = v;
      }
    }
    for (const entry of Array.isArray(obj['days']) ? obj['days'] : []) {
      const dayRec = asRecord(entry);
      const day = dayRec && typeof dayRec['day'] === 'string' ? dayRec['day'] : null;
      if (!day) continue;
      const buckets = new Map<string, ViolationBucket>();
      for (const b of Array.isArray(dayRec?.['buckets']) ? (dayRec['buckets'] as unknown[]) : []) {
        const rec = asRecord(b);
        if (!rec) continue;
        // Re-normalise on the way IN. The file is only as trustworthy as whatever
        // wrote it, and an older/edited snapshot must not be able to reintroduce a
        // path-bearing or unbounded key past the caps enforced on the write path.
        const directive
          = rec['directive'] === OVERFLOW_BUCKET ? OVERFLOW_BUCKET : normalizeDirective(rec['directive']);
        const blockedUri
          = rec['blockedUri'] === OVERFLOW_BUCKET ? OVERFLOW_BUCKET : normalizeBlockedUri(rec['blockedUri']);
        if (buckets.size >= MAX_BUCKETS_PER_DAY) break;
        const count = typeof rec['count'] === 'number' && Number.isFinite(rec['count']) ? rec['count'] : 0;
        buckets.set(bucketKey(directive, blockedUri), {
          directive,
          blockedUri,
          count,
          firstSeen: typeof rec['firstSeen'] === 'string' ? rec['firstSeen'] : state.startedAt,
          lastSeen: typeof rec['lastSeen'] === 'string' ? rec['lastSeen'] : state.startedAt,
          dispositions: (Array.isArray(rec['dispositions']) ? rec['dispositions'] : [])
            .filter((d): d is string => typeof d === 'string')
            .slice(0, 3),
          documentOrigins: (Array.isArray(rec['documentOrigins']) ? rec['documentOrigins'] : [])
            .filter((d): d is string => typeof d === 'string')
            .slice(0, MAX_DOC_ORIGINS_PER_BUCKET),
        });
      }
      state.days.set(day, { day, buckets });
    }
    pruneDays();
    log.info('csp report store hydrated', { days: state.days.size, since: state.startedAt });
  } catch {
    // No file yet (the overwhelming case) or an unreadable one. Start clean.
  }
}

/** Test seam — drops all state and detaches from disk. */
export function resetCspReportStoreForTests(nowMs = 0): void {
  dataDir = null;
  state = emptyState(new Date(nowMs).toISOString());
  tokens = RATE_BURST;
  lastRefillMs = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

// ── Ingest ───────────────────────────────────────────────────────────────────

export type IngestOutcome = 'accepted' | 'rate-limited' | 'too-large' | 'malformed';

/**
 * The whole ingest decision, with no express types in sight so it can be graded
 * directly. Order matters: rate first (cheapest, and the one that has to hold under
 * a flood), then size, then parse.
 */
export function ingestCspReport(
  body: unknown,
  byteLength: number,
  nowMs: number = Date.now(),
): IngestOutcome {
  state.totals.requestsReceived += 1;
  if (!takeRateToken(nowMs)) {
    state.totals.droppedRateLimited += 1;
    return 'rate-limited';
  }
  if (byteLength > MAX_BODY_BYTES) {
    state.totals.droppedTooLarge += 1;
    return 'too-large';
  }
  const violations = extractViolations(body);
  if (violations.length === 0) {
    state.totals.droppedMalformed += 1;
    return 'malformed';
  }
  for (const v of violations) recordViolation(v, nowMs);
  scheduleFlush();
  return 'accepted';
}

// ── Routes ───────────────────────────────────────────────────────────────────

export const CSP_REPORTS_READ_PATH = '/api/health/csp-reports';

/**
 * The collector's OWN body parser.
 *
 * Route-scoped, and mounted ahead of the global `express.json()` in `index.ts`,
 * for two reasons that both bite silently:
 *
 *  1. SIZE. The global parser's limit is the default 100 KB. This endpoint is
 *     unauthenticated, so its cap has to be its own — 8 KB — and it has to be the
 *     parser that actually runs.
 *  2. CONTENT TYPE. The global `express.json()` matches `application/json`.
 *     Browsers post CSP reports as `application/csp-report` and
 *     `application/reports+json`. Whether `type-is` treats the `+json` suffix as a
 *     match is a library-version detail, and getting it wrong yields `req.body`
 *     `{}` and a permanent, silent zero — indistinguishable from a clean policy,
 *     which is the exact failure this ticket exists to remove. So: accept ANY
 *     content type as raw bytes and parse them here, where the behaviour is ours.
 */
const rawBodyParser = express.raw({ type: () => true, limit: MAX_BODY_BYTES });

/**
 * Always answers `204`, for every outcome including refusals.
 *
 * A browser has nothing useful to do with an error from a reporting endpoint, and
 * a status that varied by outcome would turn this into an oracle telling an
 * attacker exactly where the rate and size limits sit. Refusals are visible on the
 * read route instead, where they belong.
 */
export const cspReportHandler: RequestHandler = (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let parsed: unknown = null;
  try {
    parsed = buf.length > 0 ? JSON.parse(buf.toString('utf8')) : null;
  } catch {
    parsed = null;
  }
  const outcome = ingestCspReport(parsed, buf.length, Date.now());
  if (outcome === 'accepted') {
    log.debug('csp violation reported', { bytes: buf.length });
  }
  res.status(204).end();
};

export const cspReportsReadHandler: RequestHandler = (req, res) => {
  // Only `YYYY-MM-DD` is honoured; anything else is ignored rather than guessed at,
  // so a malformed filter can never quietly widen or narrow the window a grader
  // thinks they asked for.
  const raw = typeof req.query['since'] === 'string' ? req.query['since'] : '';
  const since = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  res.json(snapshotCspReports(since));
};

/**
 * Both routes, mounted UNAUTHENTICATED.
 *
 * The POST has no choice — browsers send these with no credentials and no
 * opportunity to attach any; an auth check there would collect nothing forever.
 *
 * The GET is a deliberate call. bqb1 exposes no log surface to a grader (no
 * `TRADING_ADMIN_*`), only the public `/api/health/*` family, so an authenticated
 * read would leave TRA-2321 unable to grade this from off-box — an instrument
 * nobody can read is the problem this ticket was filed about, one layer up. What
 * it discloses is bounded by the normalisation above: directive names, blocked
 * ORIGINS, and counts. No paths, no query strings, no bodies, no user data. That is
 * strictly less than `/api/health/options-live` already publishes on this host.
 */
export function cspReportRouter(): Router {
  const router = express.Router();
  router.post(CSP_REPORT_PATH, (req, res, next) => {
    rawBodyParser(req, res, err => {
      if (err) {
        // Overwhelmingly `entity.too.large`. Count it and answer 204 like every
        // other outcome — never let it reach the error middleware, which would
        // both leak the limit and log a 413 per hostile request.
        state.totals.requestsReceived += 1;
        state.totals.droppedTooLarge += 1;
        res.status(204).end();
        return;
      }
      next();
    });
  }, cspReportHandler);
  router.get(CSP_REPORTS_READ_PATH, cspReportsReadHandler);
  return router;
}
