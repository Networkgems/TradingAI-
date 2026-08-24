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
import { foldTape, renderReport, quantile, shareOf, SAMPLE, REFUSAL } from './tra3980-concentration-tape.mjs';

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
