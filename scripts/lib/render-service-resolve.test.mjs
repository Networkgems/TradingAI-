// Discrimination suite for the shared Render service resolver (TRA-3743).
//
// The fixture is the VERBATIM live account as measured 2026-08-14T08:2xZ — two services,
// the money host among them, with its `name`/`slug` split intact. Nothing here is a
// hand-written approximation, because the class of bug under test is exactly "the field
// does not hold what I remember it holding".
//
// The `L-OLD-*` cases are REGRESSION CONTROLS: they replay the expression this resolver
// replaces and assert it still gets the WRONG answer on the same bytes. Without them a
// green run only proves the new code agrees with itself.
//
// The cases that matter most are the two MESSAGE cases. The shipped defect was never the
// refusal — the refusal is correct and fails closed. It was the refusal blaming the API
// key while holding no evidence about the API key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BQB1,
  DEFAULT_SERVICE_NAME,
  unwrapServices,
  describeService,
  resolveServiceByName,
  explainUnresolved,
} from './render-service-resolve.mjs';

// Live bytes, 2026-08-14. `?name=` is exact and case-sensitive (measured: TradingAI,
// tradingai, TRADINGAI- and tradingai-bqb1 all return []).
const LIVE = [
  { cursor: 'c0', service: { id: 'srv-d9c2ecflk1mc7391qk00', name: 'start-fresh', slug: 'start-fresh', type: 'web_service' } },
  { cursor: 'c1', service: { id: 'srv-d7mb7rr7uimc73ev0chg', name: 'TradingAI-', slug: 'tradingai-bqb1', type: 'web_service' } },
];

// A stub `get` that reproduces Render's filter semantics exactly: `?name=` is an exact,
// case-sensitive match on `name` only — it never consults `slug`.
function stubGet(services = LIVE, { onList } = {}) {
  const calls = [];
  const get = async path => {
    calls.push(path);
    const m = /\/services\?name=([^&]*)/.exec(path);
    if (m) {
      const wanted = decodeURIComponent(m[1]);
      return services.filter(x => (x.service ?? x).name === wanted);
    }
    if (onList) return onList();
    return services;
  };
  return { get, calls };
}

test('the default is the live `name`, not the slug that used to be hard-coded', () => {
  assert.equal(DEFAULT_SERVICE_NAME, 'TradingAI-');
  assert.equal(BQB1.name, 'TradingAI-');
  assert.equal(BQB1.slug, 'tradingai-bqb1');
  assert.notEqual(BQB1.name, BQB1.slug, 'the whole ticket is that these two differ');
  assert.ok(BQB1.host.includes(BQB1.slug), 'the hostname tracks the SLUG, never the name');
});

test('L-OLD-1 regression control: the shipped default still resolves to nothing', async () => {
  // The bytes as they were: `?name=tradingai-bqb1` then an exact `.name ===` match.
  const { get } = stubGet();
  const filtered = unwrapServices(await get('/services?name=tradingai-bqb1&limit=20'));
  assert.deepEqual(filtered, [], 'if this ever passes, the fixture stopped reproducing the defect');
  assert.equal(filtered.find(s => s.name === 'tradingai-bqb1'), undefined);
});

test('L-OLD-2 regression control: the old message asserts a key problem it cannot see', () => {
  const old = `no service named "tradingai-bqb1" visible to this API key.`;
  assert.match(old, /visible to this API key/);
  // …while the account the same key just enumerated holds two services. The message and
  // the evidence point in opposite directions; that is the defect, in one assertion.
  assert.equal(unwrapServices(LIVE).length, 2);
});

test('the default name now resolves, on the name path', async () => {
  const { service, matchedOn, visible } = await resolveServiceByName(DEFAULT_SERVICE_NAME, stubGet().get);
  assert.equal(service.id, BQB1.id);
  assert.equal(matchedOn, 'name');
  assert.equal(visible, null, 'the filter hit, so we must not claim to know the full account');
});

test('the SLUG — the string in the runbook and in every hostname — also resolves', async () => {
  const { service, matchedOn, visible } = await resolveServiceByName(BQB1.slug, stubGet().get);
  assert.equal(service.id, BQB1.id);
  assert.equal(matchedOn, 'slug');
  assert.equal(visible.length, 2, 'the slug path paid for the enumeration, so it reports it');
});

test('a name beats a slug: one service cannot be shadowed by another service`s slug', async () => {
  const shadow = [
    { service: { id: 'srv-decoy', name: 'x', slug: 'tradingai-bqb1' } },
    { service: { id: 'srv-real', name: 'tradingai-bqb1', slug: 'other' } },
  ];
  const { service, matchedOn } = await resolveServiceByName('tradingai-bqb1', stubGet(shadow).get);
  assert.equal(service.id, 'srv-real');
  assert.equal(matchedOn, 'name');
});

test('an ambiguous slug REFUSES rather than picking one', async () => {
  const dupes = [
    { service: { id: 'srv-a', name: 'a', slug: 'dup' } },
    { service: { id: 'srv-b', name: 'b', slug: 'dup' } },
  ];
  const r = await resolveServiceByName('dup', stubGet(dupes).get);
  assert.equal(r.service, null);
  assert.equal(r.candidates.length, 2);
  const msg = explainUnresolved('dup', r);
  assert.match(msg, /AMBIGUOUS/);
  assert.match(msg, /srv-a/);
  assert.match(msg, /srv-b/);
});

test('MESSAGE — a wrong name is reported as a NAME problem, and refuses the key claim', async () => {
  const r = await resolveServiceByName('tradingai-bqb2', stubGet().get);
  assert.equal(r.service, null);
  const msg = explainUnresolved('tradingai-bqb2', r);
  assert.match(msg, /NAME problem/);
  assert.match(msg, /NOT a key-permission problem/);
  assert.match(msg, /CAN see 2 service\(s\)/, 'the count is the evidence; it must be printed');
  assert.match(msg, /TradingAI-/, 'and the operator must be told the string that does work');
  assert.match(msg, new RegExp(BQB1.id));
  // The regression that matters: it must NOT reproduce the old accusation.
  assert.doesNotMatch(msg, /visible to this API key/);
});

test('MESSAGE — a key that sees nothing IS reported as a key problem', async () => {
  const r = await resolveServiceByName('TradingAI-', stubGet([]).get);
  assert.equal(r.service, null);
  const msg = explainUnresolved('TradingAI-', r);
  assert.match(msg, /KEY problem/);
  assert.match(msg, /revoked, or scoped to a different Render owner/);
  assert.doesNotMatch(msg, /NAME problem/);
});

test('the two messages are actually different — a suite that cannot tell them apart is vacuous', async () => {
  const nameProblem = explainUnresolved('nope', await resolveServiceByName('nope', stubGet().get));
  const keyProblem = explainUnresolved('nope', await resolveServiceByName('nope', stubGet([]).get));
  assert.notEqual(nameProblem, keyProblem);
});

test('unwrapServices tolerates both response shapes and drops junk', () => {
  assert.equal(unwrapServices(LIVE).length, 2);
  assert.equal(unwrapServices([{ id: 'srv-bare', name: 'n' }])[0].id, 'srv-bare');
  assert.deepEqual(unwrapServices([null, undefined, 3, 'x']), []);
  assert.deepEqual(unwrapServices(null), [], 'a non-array body must not throw on .map');
});

test('describeService prints all three identity strings, never just one', () => {
  const s = describeService(unwrapServices(LIVE)[1]);
  assert.match(s, /srv-d7mb7rr7uimc73ev0chg/);
  assert.match(s, /"TradingAI-"/);
  assert.match(s, /"tradingai-bqb1"/);
});

test('the name path costs ONE call; only a miss pays for the enumeration', async () => {
  const hit = stubGet();
  await resolveServiceByName('TradingAI-', hit.get);
  assert.equal(hit.calls.length, 1);

  const miss = stubGet();
  await resolveServiceByName(BQB1.slug, miss.get);
  assert.equal(miss.calls.length, 2);
});
