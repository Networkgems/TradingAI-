// TRA-4531 — control suite for the CSP bucket grader.
//
// The base scenario is `scripts/fixtures/tra4531-live-tape-2026-09-10.json`, a
// VERBATIM capture of bqb1 `b5c76cc1` (snapshot + both CSP headers) taken while the
// old checker was reading DIRTY on it. The green arm is therefore a real reading of
// the real tape, not buckets typed into a test.
//
// The suite has to prove the grader discriminates in BOTH directions: a checker
// that is always red gets ignored (the defect this ticket fixes), and one that is
// never red is the empty room TRA-2344 was built to end. So every green arm has a
// red twin that differs by exactly one thing.
//
//   node --test scripts/lib/csp-bucket-grade.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeBuckets, classifyBucket, parsePolicy, enforcedShape, EXIT, CLASS } from './csp-bucket-grade.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE = path.join(HERE, '..', 'fixtures', 'tra4531-live-tape-2026-09-10.json');
const capture = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(capture));

const ENFORCED = capture.headers['content-security-policy'];
const REPORT_ONLY = capture.headers['content-security-policy-report-only'];
const DOC = 'https://tradingai-bqb1.onrender.com';

const grade = (over = {}) => {
  const c = clone();
  return gradeBuckets({ violations: c.snapshot.violations, buckets: c.snapshot.buckets, enforced: ENFORCED, ...over });
};
const bucket = (directive, blockedUri, extra = {}) => ({
  day: '2026-09-10',
  directive,
  blockedUri,
  count: 1,
  dispositions: ['report'],
  documentOrigins: [DOC],
  ...extra,
});
const classOf = (directive, blockedUri, extra, enforced = ENFORCED) =>
  classifyBucket(bucket(directive, blockedUri, extra), parsePolicy(enforced)).class;

test('the fixture is the tape the ticket was filed on', () => {
  assert.equal(capture.snapshot.violations, 7);
  assert.equal(capture.snapshot.buckets.length, 4);
  assert.match(ENFORCED, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(REPORT_ONLY, /script-src 'self';/);
  assert.equal(enforcedShape(ENFORCED), 'promoted');
});

test('ACCEPTANCE — the live tape grades GRADABLE with all 4 buckets classified, none unexplained', () => {
  const g = grade();
  assert.equal(g.exitCode, EXIT.GRADABLE);
  assert.equal(g.verdict, 'GRADABLE (controls/allowed only)');
  assert.equal(g.rows.length, 4);
  assert.deepEqual(g.counts, { [CLASS.ALLOWED]: 6, [CLASS.CONTROL]: 1, [CLASS.UNEXPLAINED]: 0 });

  const wasm = g.rows.filter(r => r.bucket.blockedUri === 'wasm-eval');
  assert.equal(wasm.length, 3);
  for (const r of wasm) {
    assert.equal(r.class, CLASS.ALLOWED);
    assert.equal(r.permittedBy, "'wasm-unsafe-eval'");
  }
  const control = g.rows.find(r => r.bucket.directive === 'img-src');
  assert.equal(control.class, CLASS.CONTROL);

  const text = g.lines.join('\n');
  assert.doesNotMatch(text, /must NOT promote/, 'the stale promotion sentence is gone in the enforced world');
  assert.match(text, /0 unexplained violations against the ENFORCED policy/);
  assert.match(text, /carve-out 'wasm-unsafe-eval' still exercised on 3 day\(s\), last 2026-09-01/);
});

test('NEGATIVE CONTROL — one injected `script-src <- https://evil.example` bucket goes DIRTY and is named', () => {
  const c = clone();
  const evil = bucket('script-src', 'https://evil.example');
  const g = gradeBuckets({
    violations: c.snapshot.violations + 1,
    buckets: [...c.snapshot.buckets, evil],
    enforced: ENFORCED,
  });
  assert.equal(g.exitCode, EXIT.DIRTY);
  assert.equal(g.counts[CLASS.UNEXPLAINED], 1);
  assert.equal(g.rows[0].class, CLASS.UNEXPLAINED, 'unexplained buckets sort first');
  assert.equal(g.rows[0].bucket.blockedUri, 'https://evil.example');
  const text = g.lines.join('\n');
  assert.match(text, /1 unexplained violation\(s\) against the ENFORCED policy/);
  assert.doesNotMatch(text, /must NOT promote/);
});

test('RED TWIN of the acceptance — the same tape graded against the Report-Only candidate is DIRTY', () => {
  // This is the defect: grading against the candidate instead of what is enforced.
  // It proves the classifier READS the header rather than whitelisting `wasm-eval`.
  const g = grade({ enforced: REPORT_ONLY });
  assert.equal(g.exitCode, EXIT.DIRTY);
  assert.equal(g.counts[CLASS.UNEXPLAINED], 6);
  assert.equal(g.counts[CLASS.CONTROL], 1);
});

test('kill switch — unrestricted is NOT allowed: frame-ancestors-only enforcement goes DIRTY with candidate wording', () => {
  const g = grade({ enforced: "frame-ancestors 'none'" });
  assert.equal(enforcedShape("frame-ancestors 'none'"), 'frame-ancestors-only');
  assert.equal(g.exitCode, EXIT.DIRTY);
  assert.equal(g.counts[CLASS.UNEXPLAINED], 6);
  assert.equal(g.counts[CLASS.CONTROL], 1, 'a planted control stays a control whatever is enforced');
  assert.match(g.lines.join('\n'), /NOT enforced on this host \(enforced shape: frame-ancestors-only\)/);
});

test('no enforced CSP at all — every non-control bucket is unexplained', () => {
  const g = grade({ enforced: '' });
  assert.equal(enforcedShape(''), 'none');
  assert.equal(g.exitCode, EXIT.DIRTY);
  assert.equal(g.counts[CLASS.UNEXPLAINED], 6);
});

test('class: allowed-by-enforced — each permitting source the live header carries', () => {
  assert.equal(classOf('img-src', 'data'), CLASS.ALLOWED);
  assert.equal(classOf('img-src', 'blob'), CLASS.ALLOWED);
  assert.equal(classOf('img-src', DOC), CLASS.ALLOWED, "'self' admits the document's own origin");
  assert.equal(classOf('style-src-elem', 'inline'), CLASS.ALLOWED, 'falls back to style-src');
  assert.equal(classOf('connect-src', 'wss://tradingai-bqb1.onrender.com'), CLASS.ALLOWED);
  assert.equal(classOf('worker-src', 'blob'), CLASS.ALLOWED);
  assert.equal(classOf('media-src', DOC), CLASS.ALLOWED, 'falls back to default-src');
});

test('class: unexplained — what the enforced policy does NOT admit', () => {
  assert.equal(classOf('script-src', 'eval'), CLASS.UNEXPLAINED, 'the wasm carve-out never grants eval()');
  assert.equal(classOf('script-src', 'inline'), CLASS.UNEXPLAINED);
  assert.equal(classOf('script-src-elem', 'https://evil.example'), CLASS.UNEXPLAINED);
  assert.equal(classOf('img-src', 'https://cdn.example.com'), CLASS.UNEXPLAINED);
  assert.equal(classOf('connect-src', 'wss://other.onrender.com'), CLASS.UNEXPLAINED);
  assert.equal(classOf('object-src', DOC), CLASS.UNEXPLAINED, "object-src 'none'");
  assert.equal(classOf('img-src', DOC, { documentOrigins: ['https://elsewhere.example'] }), CLASS.UNEXPLAINED,
    "'self' is the DOCUMENT's origin, not any origin");
  assert.equal(classOf('__overflow__', '__overflow__'), CLASS.UNEXPLAINED, 'the cardinality overflow bucket hides unknowns');
  assert.equal(classOf('other', 'unknown'), CLASS.UNEXPLAINED);
  assert.equal(classOf('script-src', 'wasm-eval', { dispositions: ['enforce'] }), CLASS.UNEXPLAINED,
    'an ENFORCE report means the live policy blocked it');
});

test('class: labelled-control — only a host ON the .invalid TLD', () => {
  assert.equal(classOf('img-src', 'https://csp-control-tra4429-chromium.invalid'), CLASS.CONTROL);
  assert.equal(classOf('script-src', 'https://anything.invalid'), CLASS.CONTROL);
  assert.equal(classOf('img-src', 'https://x.invalid.evil.example'), CLASS.UNEXPLAINED, '.invalid mid-host is not the TLD');
  assert.equal(classOf('img-src', 'https://invalid-looking.example'), CLASS.UNEXPLAINED);
});

test("'unsafe-inline' is void next to a nonce or hash (CSP3), so it admits nothing", () => {
  const p = "default-src 'self'; style-src 'self' 'unsafe-inline' 'nonce-abc'";
  assert.equal(classOf('style-src', 'inline', {}, p), CLASS.UNEXPLAINED);
});

test('a path-scoped host-source never admits an origin-only blocked-uri', () => {
  const p = "default-src 'self'; img-src https://cdn.example.com/assets/";
  assert.equal(classOf('img-src', 'https://cdn.example.com', {}, p), CLASS.UNEXPLAINED);
  assert.equal(classOf('img-src', 'https://cdn.example.com', {}, "default-src 'self'; img-src https://cdn.example.com"), CLASS.ALLOWED);
  assert.equal(classOf('img-src', 'https://a.cdn.example.com', {}, "default-src 'self'; img-src *.cdn.example.com"), CLASS.ALLOWED);
});

test('a counted violation outside every visible bucket is unexplained, never dropped', () => {
  const g = grade({ violations: 8 });
  assert.equal(g.exitCode, EXIT.DIRTY);
  assert.equal(g.counts[CLASS.UNEXPLAINED], 1);
  assert.match(g.lines.join('\n'), /1 counted violation\(s\) are in no bucket this reader can see/);
});

test('enforcedShape — only the reviewed promotion reads `promoted`', () => {
  assert.equal(enforcedShape(ENFORCED.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'")), 'unsanctioned');
  assert.equal(enforcedShape(ENFORCED.replace(" 'wasm-unsafe-eval'", '')), 'unsanctioned');
  assert.equal(enforcedShape(REPORT_ONLY), 'unsanctioned');
});
