// TRA-3980 — acceptance suite for the tape fold.
//
// ⚠ THE POSITIVE CONTROL IN THIS FILE IS THE `unwired` VS `empty` PAIR, and it
// is the reason the file exists. A fold that put both in the denominator would
// pass every quantile assertion here and still report "we observed 5 sessions"
// over a week in which the provider was never wired — a refusal dressed as a
// measurement, which is the single failure this ticket cannot make. If that
// test is deleted the rest of this suite proves the fold RUNS, not that it
// SEPARATES.
//
// The second control is the lower-bound split: a suite that only asserted the
// ALL quantiles would pass unchanged if the HARD subset were computed as an
// alias of ALL, and the HARD row is the only one a ceiling may be reasoned
// from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldTape, renderReport, quantile, shareOf, dollarsOf, etClock, isAfterSessionOpen, SAMPLE, REFUSAL } from './tra3980-concentration-tape.mjs';

const pin = { commit: 'deadbeef', pid: 42, startedAt: '2026-08-25T20:00:00.000Z' };

const sample = (o = {}) => ({
  kind: SAMPLE,
  session: '2026-08-25',
  slot: 'open',
  at: '2026-08-25T13:35:00.000Z',
  pin,
  status: 'measured',
  concentrationIsLowerBound: false,
  fleetAtRiskUsd: 444,
  distinctContracts: 3,
  maxContract: { key: 'NVTS261002C00012500', atRiskUsd: 305, contracts: 2, books: ['admin', 'v0nni'], bookCount: 2, shareOfFleetAtRisk: 0.687 },
  maxUnderlying: { key: 'NVTS', atRiskUsd: 305, contracts: 2, books: ['admin', 'v0nni'], bookCount: 2, shareOfFleetAtRisk: 0.687 },
  multiBookContracts: [],
  ...o,
});

test('quantile interpolates and refuses an empty sample with null, never 0', () => {
  assert.equal(quantile([], 0.5), null, 'an empty sample must not read as 0% concentration');
  assert.equal(quantile([0.4], 0.9), 0.4);
  assert.equal(quantile([0, 1], 0.5), 0.5);
  assert.equal(quantile([0, 0.5, 1], 0.25), 0.25);
  assert.equal(quantile([0.1, 0.2, 0.3, 0.4], 0), 0.1);
  assert.equal(quantile([0.1, 0.2, 0.3, 0.4], 1), 0.4);
  assert.throws(() => quantile([0.1], 1.5));
});

test('CONTROL — `unwired` is a refusal and `empty` is a reading', () => {
  const lines = [
    sample({ session: 'A' }),
    sample({ session: 'B', status: 'empty', maxContract: null, maxUnderlying: null, fleetAtRiskUsd: 0, distinctContracts: null }),
    sample({ session: 'C', status: 'unwired', maxContract: null, maxUnderlying: null }),
    { kind: REFUSAL, session: 'D', reason: 'pin_moved' },
  ];
  const f = foldTape(lines);
  // A and B only. C is a refusal that happens to arrive sample-shaped; D is one outright.
  assert.equal(f.census.sessionsObserved, 2, 'unwired/pin_moved must never enter the denominator');
  assert.deepEqual(f.sessions.map(s => s.session), ['A', 'B']);
  assert.equal(f.census.refusals, 2);
  assert.deepEqual(f.census.refusalsByReason, { unwired: 1, pin_moved: 1 });
  // The empty session is a real 0% observation, and it drags the median.
  assert.equal(f.census.samplesEmpty, 1);
  assert.equal(f.perSession.maxContract.n, 2);
  assert.equal(f.perSession.maxContract.quantiles.p0, 0, 'the flat session reads 0%, not n/a');
  assert.equal(f.perSession.maxContract.quantiles.p100, 0.687);
  assert.equal(f.sessions[1].distinctContracts, 0, 'a flat fleet held 0 distinct contracts');
});

test('CONTROL — the HARD subset is not an alias of ALL', () => {
  const lines = [
    sample({ session: 'A', concentrationIsLowerBound: true, maxContract: { ...sample().maxContract, shareOfFleetAtRisk: 0.20 }, maxUnderlying: { ...sample().maxUnderlying, shareOfFleetAtRisk: 0.20 } }),
    sample({ session: 'B', concentrationIsLowerBound: true, maxContract: { ...sample().maxContract, shareOfFleetAtRisk: 0.30 }, maxUnderlying: { ...sample().maxUnderlying, shareOfFleetAtRisk: 0.30 } }),
    sample({ session: 'C', concentrationIsLowerBound: false, maxContract: { ...sample().maxContract, shareOfFleetAtRisk: 0.90 }, maxUnderlying: { ...sample().maxUnderlying, shareOfFleetAtRisk: 0.90 } }),
  ];
  const f = foldTape(lines);
  assert.equal(f.census.samplesGraded, 3);
  assert.equal(f.census.samplesLowerBound, 2);
  assert.equal(f.census.samplesHard, 1);
  assert.equal(f.perSample.maxContract.n, 3);
  assert.equal(f.perSample.maxContractHardOnly.n, 1);
  assert.equal(f.perSample.maxContract.quantiles.p50, 0.30);
  assert.equal(f.perSample.maxContractHardOnly.quantiles.p50, 0.90,
    'the soft samples must not be able to pull the HARD median down');
  assert.notEqual(f.perSample.maxContract.quantiles.p50, f.perSample.maxContractHardOnly.quantiles.p50);
});

test('a session peak is the MAX over its samples — one read per session is blind', () => {
  // The 08-24 shape: two fills 19 minutes apart INSIDE one entry window.
  const lines = [
    sample({ session: 'S', slot: 'open', maxContract: { ...sample().maxContract, shareOfFleetAtRisk: 0.35 }, maxUnderlying: { ...sample().maxUnderlying, shareOfFleetAtRisk: 0.35 } }),
    sample({ session: 'S', slot: 'mid', maxContract: { ...sample().maxContract, shareOfFleetAtRisk: 0.687 }, maxUnderlying: { ...sample().maxUnderlying, shareOfFleetAtRisk: 0.687 } }),
    sample({ session: 'S', slot: 'post', maxContract: { ...sample().maxContract, shareOfFleetAtRisk: 0.10 }, maxUnderlying: { ...sample().maxUnderlying, shareOfFleetAtRisk: 0.10 } }),
  ];
  const f = foldTape(lines);
  assert.equal(f.census.sessionsObserved, 1);
  assert.equal(f.sessions[0].samples, 3);
  assert.deepEqual(f.sessions[0].slots, ['mid', 'open', 'post']);
  assert.equal(f.sessions[0].maxContractShare, 0.687,
    'the peak, not the last read and not the mean — concentration is a hazard');
  assert.equal(f.perSession.maxContract.n, 1);
  assert.equal(f.perSample.maxContract.n, 3);
});

test('multi-book occurrences are NAMED, and counted once per session', () => {
  const hazard = { key: 'NVTS261002C00012500', atRiskUsd: 305, contracts: 2, books: ['admin', 'v0nni'], bookCount: 2, shareOfFleetAtRisk: 0.687 };
  const lines = [
    sample({ session: 'A', slot: 'open', multiBookContracts: [hazard] }),
    sample({ session: 'A', slot: 'mid', multiBookContracts: [hazard] }),
    sample({ session: 'B', slot: 'open', multiBookContracts: [] }),
  ];
  const f = foldTape(lines);
  assert.equal(f.multiBook.sessions, 1, 'two samples of one standing position is ONE session');
  assert.equal(f.multiBook.occurrences.length, 2, 'but both observations stay on the record');
  const o = f.multiBook.occurrences[0];
  assert.equal(o.contract, 'NVTS261002C00012500');
  assert.equal(o.atRiskUsd, 305);
  assert.deepEqual(o.books, ['admin', 'v0nni']);
  assert.equal(o.shareOfFleetAtRisk, 0.687);
  assert.equal(f.sessions.find(s => s.session === 'A').multiBook, true);
  assert.equal(f.sessions.find(s => s.session === 'B').multiBook, false);
});

test('shareOf refuses a measured sample with no bucket rather than reading it as 0', () => {
  assert.equal(shareOf(sample({ status: 'measured', maxContract: null }), 'contract'), null);
  assert.equal(shareOf(sample({ status: 'empty' }), 'contract'), 0);
  assert.equal(shareOf(sample({ status: 'unwired' }), 'contract'), null);
  assert.equal(shareOf({ kind: REFUSAL }, 'contract'), null);
  // A null denominator in the fold (fleet at-risk 0 with rows present) is not a 0 share.
  assert.equal(shareOf(sample({ maxContract: { ...sample().maxContract, shareOfFleetAtRisk: null } }), 'contract'), null);
});

test('an empty tape reports zero sessions and no synthetic quantiles', () => {
  const f = foldTape([]);
  assert.equal(f.census.sessionsObserved, 0);
  assert.equal(f.perSample.maxContract.n, 0);
  assert.equal(f.perSample.maxContract.quantiles.p50, null);
  const md = renderReport(f);
  assert.match(md, /Sessions observed: 0/);
  assert.match(md, /No `multiBookContracts` occurrence/);
  // An all-refusal tape must not narrate a lower-bound census it does not have.
  assert.match(md, /Nothing was graded/);
  assert.doesNotMatch(md, /0 of 0 graded samples carry/);
});

test('renderReport states the lower-bound census beside the figures', () => {
  const f = foldTape([sample({ concentrationIsLowerBound: true })]);
  const md = renderReport(f, { note: 'NOTE-MARKER' });
  assert.match(md, /1 of 1 graded samples carry/);
  assert.match(md, /UNDER-state concentration/);
  assert.match(md, /68\.7%/);
  assert.match(md, /NOTE-MARKER/);
});

// ── AC2 amendment: the DOLLAR axis (CEO, TRA-3980 `20187555` / TRA-3703 `6245c427`) ──
//
// ⚠ CONTROL: the dollar axis must NOT be derivable from the share axis. Two
// samples with the SAME share and DIFFERENT fleets carry different dollars —
// which is the whole reason the CEO ruled dollars: `share × fleet` loosens as
// the fleet grows. A fold that computed dollars as `share × fleetAtRiskUsd`
// would pass a same-fleet fixture and still be reading the wrong field on a
// lower-bound sample (unpriced rows are in neither numerator).
test('CONTROL — the dollar axis reads `atRiskUsd`, not share × fleet', () => {
  const lines = [
    // 50% of a $200 fleet = $100
    sample({ session: 'A', fleetAtRiskUsd: 200,
      maxContract: { ...sample().maxContract, atRiskUsd: 100, shareOfFleetAtRisk: 0.5 },
      maxUnderlying: { ...sample().maxUnderlying, atRiskUsd: 100, shareOfFleetAtRisk: 0.5 } }),
    // 50% of a $500 fleet = $250 — same share, 2.5x the dollars
    sample({ session: 'B', fleetAtRiskUsd: 500,
      maxContract: { ...sample().maxContract, atRiskUsd: 250, shareOfFleetAtRisk: 0.5 },
      maxUnderlying: { ...sample().maxUnderlying, atRiskUsd: 250, shareOfFleetAtRisk: 0.5 } }),
  ];
  const f = foldTape(lines);
  assert.equal(f.perSample.maxContract.quantiles.p0, 0.5);
  assert.equal(f.perSample.maxContract.quantiles.p100, 0.5, 'share axis is flat across both');
  assert.equal(f.perSample.maxContractUsd.quantiles.p0, 100);
  assert.equal(f.perSample.maxContractUsd.quantiles.p100, 250, 'the dollar axis is not');
  assert.equal(f.perSession.maxContractUsd.n, 2);
  assert.equal(f.perSession.maxUnderlyingUsd.quantiles.p100, 250);
  assert.equal(f.sessions[1].maxContractUsd, 250);
  // The dollar field is read, never recomputed: a sample whose share and dollars
  // disagree (lower-bound shape) must surface the dollars it carries.
  const g = foldTape([sample({ session: 'C', fleetAtRiskUsd: 1000,
    maxContract: { ...sample().maxContract, atRiskUsd: 305, shareOfFleetAtRisk: 0.9 },
    maxUnderlying: { ...sample().maxUnderlying, atRiskUsd: 305, shareOfFleetAtRisk: 0.9 } })]);
  assert.equal(g.perSample.maxContractUsd.quantiles.p50, 305, 'not 900');
});

test('the dollar axis carries the same HARD split and the same empty ⇒ $0 rule', () => {
  const lines = [
    sample({ session: 'A', concentrationIsLowerBound: true,
      maxContract: { ...sample().maxContract, atRiskUsd: 20 }, maxUnderlying: { ...sample().maxUnderlying, atRiskUsd: 20 } }),
    sample({ session: 'B', concentrationIsLowerBound: false,
      maxContract: { ...sample().maxContract, atRiskUsd: 305 }, maxUnderlying: { ...sample().maxUnderlying, atRiskUsd: 305 } }),
    sample({ session: 'C', status: 'empty', maxContract: null, maxUnderlying: null, fleetAtRiskUsd: 0, distinctContracts: null }),
    sample({ session: 'D', status: 'unwired', maxContract: null, maxUnderlying: null }),
  ];
  const f = foldTape(lines);
  assert.equal(f.perSample.maxContractUsd.n, 3, 'A, B and the empty C; unwired D is a refusal');
  assert.equal(f.perSample.maxContractUsd.quantiles.p0, 0, 'a flat fleet held $0 in its top bucket');
  assert.equal(f.perSample.maxContractUsdHardOnly.n, 2, 'B and C — the soft A is out');
  assert.equal(f.perSample.maxContractUsdHardOnly.quantiles.p100, 305);
  assert.equal(f.perSample.maxContractUsd.quantiles.p50, 20);
  assert.equal(f.perSample.maxContractUsdHardOnly.quantiles.p50, 152.5,
    'the soft sample must not be able to pull the HARD median down');
  assert.equal(dollarsOf(sample({ maxContract: { ...sample().maxContract, atRiskUsd: null } }), 'contract'), null,
    'an unpriced top bucket is not $0');
  assert.equal(dollarsOf({ kind: REFUSAL }, 'contract'), null);
});

test('renderReport carries the dollar rows beside the share rows, with the census', () => {
  const f = foldTape([sample({ concentrationIsLowerBound: true })]);
  const md = renderReport(f);
  assert.match(md, /Dollar axis \(AC2 amendment/);
  assert.match(md, /\(1 of 1 soft\)/, 'the same census is stated on the dollar block');
  assert.match(md, /`maxContract\.atRiskUsd` — per sample, ALL \| 1 \| \$305\.00/);
  assert.match(md, /`maxContract\.atRiskUsd` — per sample, HARD only \| 0 \| n\/a/);
  assert.match(md, /`maxUnderlying\.atRiskUsd` — per SESSION peak \| 1 \| \$305\.00/);
  assert.match(md, /peak contract \$/, 'per-session detail names the dollar column');
});

// ── Session COVERAGE: a session sampled only before its own open ─────────────
//
// ⚠ THE CONTROL HERE IS THAT COVERAGE AND ROW-SOFTNESS ARE ORTHOGONAL. A
// pre-open probe returns a perfectly HARD reading — every row keyed and priced —
// of a book that predates the entry window. So a fold that reused
// `concentrationIsLowerBound` to express coverage would report
// `samplesHard == samplesGraded` on exactly the tape that observed nothing, and
// every assertion in the HARD-split test above would still pass.

test('etClock reads the ET wall clock, not a hardcoded UTC offset', () => {
  // EDT (UTC-4): 13:36Z is 09:36 ET, six minutes after the bell.
  assert.deepEqual(etClock('2026-08-26T13:36:12.980Z'), { date: '2026-08-26', minutes: 9 * 60 + 36 });
  // EST (UTC-5): the SAME UTC clock time is 08:36 ET — pre-open. A 13:30-20:00Z
  // window would have called this in-session.
  assert.deepEqual(etClock('2026-01-14T13:36:00.000Z'), { date: '2026-01-14', minutes: 8 * 60 + 36 });
  assert.equal(etClock('not-a-date'), null);
  assert.equal(etClock(undefined), null);
});

test('CONTROL — coverage is NOT an alias of the HARD/soft split', () => {
  const lines = [
    // A: sampled 05:28 ET only. Fully HARD, and blind to everything opened that day.
    sample({ session: '2026-09-01', slot: 'adhoc', at: '2026-09-01T09:28:55.160Z',
      concentrationIsLowerBound: false }),
    // B: sampled 09:36 ET. Also fully HARD, and it saw the entry window.
    sample({ session: '2026-08-26', slot: 'open', at: '2026-08-26T13:36:12.980Z',
      concentrationIsLowerBound: false }),
  ];
  const f = foldTape(lines);
  assert.equal(f.census.samplesHard, 2, 'both samples are HARD readings');
  assert.equal(f.census.samplesLowerBound, 0, '...and the soft census sees nothing wrong');
  // ...yet exactly one session observed its own entry window.
  assert.equal(f.census.sessionsPreOpenOnly, 1);
  assert.equal(f.census.sessionsCovered, 1);
  assert.equal(f.census.samplesAfterOpen, 1);
  const a = f.sessions.find(s => s.session === '2026-09-01');
  const b = f.sessions.find(s => s.session === '2026-08-26');
  assert.equal(a.peakIsSessionLowerBound, true);
  assert.equal(a.samplesAfterOpen, 0);
  assert.equal(b.peakIsSessionLowerBound, false);
  assert.equal(b.samplesAfterOpen, 1);
});

test('one after-open sample covers the session; post-close counts, pre-open does not', () => {
  const f = foldTape([
    sample({ session: '2026-08-26', slot: 'adhoc', at: '2026-08-26T07:21:58.413Z' }),
    // 16:15 ET post-close: a position opened intraday is still held, so this SEES it.
    sample({ session: '2026-08-26', slot: 'post', at: '2026-08-26T20:15:00.000Z' }),
  ]);
  assert.equal(f.census.sessionsPreOpenOnly, 0, 'a post-close read is not blind to the session');
  assert.equal(f.sessions[0].samplesAfterOpen, 1);
  assert.equal(f.sessions[0].peakIsSessionLowerBound, false);
  // Exactly at the bell is in.
  assert.equal(isAfterSessionOpen(sample({ session: '2026-08-26', at: '2026-08-26T13:30:00.000Z' })), true);
  assert.equal(isAfterSessionOpen(sample({ session: '2026-08-26', at: '2026-08-26T13:29:59.000Z' })), false);
  // A sample filed under a session it was not taken in cannot vouch for it —
  // conservative direction: it can only ADD softness.
  assert.equal(isAfterSessionOpen(sample({ session: '2026-08-27', at: '2026-08-26T18:00:00.000Z' })), false);
  assert.equal(isAfterSessionOpen({ kind: REFUSAL, at: '2026-08-26T18:00:00.000Z' }), false);
});

test('renderReport states the coverage gap and marks the soft session peaks', () => {
  const soft = foldTape([sample({ session: '2026-09-01', at: '2026-09-01T09:28:55.160Z' })]);
  const md = renderReport(soft);
  assert.match(md, /1 of 1 observed session\(s\) were sampled\s+ONLY before their own 09:30 ET open/);
  assert.match(md, /LOWER BOUNDS ON THE SESSION/);
  assert.match(md, /no sample at or after its own 09:30 ET open/);
  assert.match(md, /68\.7% ≥/, 'the peak itself carries the marker');
  // ...and the clean case must NOT narrate a gap it does not have.
  const covered = foldTape([sample({ session: '2026-08-26', at: '2026-08-26T13:36:12.980Z' })]);
  const md2 = renderReport(covered);
  assert.match(md2, /All 1 observed session\(s\) carry at least one sample/);
  assert.doesNotMatch(md2, /LOWER BOUNDS ON THE SESSION/);
  assert.doesNotMatch(md2, /68\.7% ≥/);
});

test('renderReport does NOT narrate a soft census over a tape with zero lower bounds', () => {
  // First live sample 08-26 (0 of 1 lower-bound) rendered "shares are soft ...
  // the ALL rows UNDER-state concentration" -- the inverse of what the tape held.
  const f = foldTape([sample({ concentrationIsLowerBound: false })]);
  const md = renderReport(f, { note: 'NOTE-MARKER' });
  assert.match(md, /0 of 1 graded samples carry/);
  assert.match(md, /every share below is a HARD reading/);
  assert.doesNotMatch(md, /UNDER-state concentration/);
  assert.doesNotMatch(md, /shares are soft/);
});

test('a session peak row whose two axes come from DIFFERENT samples is marked', () => {
  // The divergence is systematic, not a coincidence: share peaks when the fleet
  // denominator is smallest, dollars peak when the position is largest.
  //   sample 1: $100 in a $150 fleet -> 66.7%, $100
  //   sample 2: $200 in a $600 fleet -> 33.3%, $200
  // Peak share 66.7% (sample 1) and peak $ $200 (sample 2) describe a $300
  // fleet that never existed.
  const f = foldTape([
    sample({ session: '2026-09-01', slot: 'open', at: '2026-09-01T13:35:00.000Z',
      fleetAtRiskUsd: 150,
      maxContract: { key: 'AAA261002C00010000', atRiskUsd: 100, contracts: 1, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 2 / 3 },
      maxUnderlying: { key: 'AAA', atRiskUsd: 100, contracts: 1, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 2 / 3 } }),
    sample({ session: '2026-09-01', slot: 'mid', at: '2026-09-01T16:30:00.000Z',
      fleetAtRiskUsd: 600,
      maxContract: { key: 'AAA261002C00010000', atRiskUsd: 200, contracts: 2, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 1 / 3 },
      maxUnderlying: { key: 'AAA', atRiskUsd: 200, contracts: 2, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 1 / 3 } }),
  ]);
  const s = f.sessions[0];
  assert.equal(s.peakAxesAgree, false);
  assert.equal(s.maxContractShareAt, '2026-09-01T13:35:00.000Z');
  assert.equal(s.maxContractUsdAt, '2026-09-01T16:30:00.000Z');
  assert.ok(Math.abs(s.maxContractShare - 2 / 3) < 1e-9);
  assert.equal(s.maxContractUsd, 200);
  const md = renderReport(f);
  assert.match(md, /66\.7% †/);
  assert.match(md, /\$200\.00 †/);
  assert.match(md, /peak share and peak dollars come from DIFFERENT samples/);
  // ⛔ THE CONTROL FOR THIS MARKER: the session IS covered and every sample is
  // HARD, so `†` cannot be an alias of the coverage flag or the soft census.
  assert.equal(s.peakIsSessionLowerBound, false);
  assert.equal(f.census.samplesLowerBound, 0);
  assert.doesNotMatch(md, /66\.7% ≥/);
});

test('CONTROL — peaks from ONE sample agree, and the report stays silent', () => {
  // Same numbers, but the larger position arrives with the SMALLER fleet, so
  // both maxima land on sample 2. A fold that always emitted `†` on a
  // multi-sample session would pass the test above and fail here.
  const f = foldTape([
    sample({ session: '2026-09-01', slot: 'open', at: '2026-09-01T13:35:00.000Z',
      fleetAtRiskUsd: 600,
      maxContract: { key: 'AAA261002C00010000', atRiskUsd: 100, contracts: 1, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 1 / 6 },
      maxUnderlying: { key: 'AAA', atRiskUsd: 100, contracts: 1, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 1 / 6 } }),
    sample({ session: '2026-09-01', slot: 'mid', at: '2026-09-01T16:30:00.000Z',
      fleetAtRiskUsd: 300,
      maxContract: { key: 'AAA261002C00010000', atRiskUsd: 200, contracts: 2, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 2 / 3 },
      maxUnderlying: { key: 'AAA', atRiskUsd: 200, contracts: 2, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 2 / 3 } }),
  ]);
  const s = f.sessions[0];
  assert.equal(s.peakAxesAgree, true);
  assert.equal(s.maxContractShareAt, s.maxContractUsdAt);
  const md = renderReport(f);
  assert.doesNotMatch(md, /†/);
  assert.doesNotMatch(md, /DIFFERENT samples/);
  // A single-sample session is trivially one moment.
  assert.equal(foldTape([sample()]).sessions[0].peakAxesAgree, true);
});

test('a TIE on one axis attributes the row to the FIRST sample that attained it', () => {
  // The live 09-01 shape: the same contract at the same dollars in both
  // samples, but the fleet grew, so only the SHARE moved. The dollar axis is
  // tied -- and a `>=` argmax would hand the row to the later sample and
  // report the axes as agreeing when the share peak is genuinely elsewhere.
  const f = foldTape([
    sample({ session: '2026-09-01', slot: 'adhoc', at: '2026-09-01T09:28:55.160Z',
      fleetAtRiskUsd: 313,
      maxContract: { key: 'KO261002C00090000', atRiskUsd: 183, contracts: 1, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 0.585 },
      maxUnderlying: { key: 'KO', atRiskUsd: 183, contracts: 1, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 0.585 } }),
    sample({ session: '2026-09-01', slot: 'mid', at: '2026-09-01T16:37:00.000Z',
      fleetAtRiskUsd: 409,
      maxContract: { key: 'KO261002C00090000', atRiskUsd: 183, contracts: 1, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 0.447 },
      maxUnderlying: { key: 'KO', atRiskUsd: 183, contracts: 1, books: ['admin'], bookCount: 1, shareOfFleetAtRisk: 0.447 } }),
  ]);
  const s = f.sessions[0];
  assert.equal(s.maxContractShareAt, '2026-09-01T09:28:55.160Z');
  assert.equal(s.maxContractUsdAt, '2026-09-01T09:28:55.160Z', 'the tie goes to the first attainer');
  assert.equal(s.peakAxesAgree, true, 'and the row IS one moment: 58.5% of $313 is $183');
  assert.equal(s.maxContractUsd, 183);
});
