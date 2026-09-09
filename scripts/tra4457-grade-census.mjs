#!/usr/bin/env node
// tra4457-grade-census.mjs — read the S1 sweep census off live bqb1 and say what
// an empty `signals[]` is allowed to mean.
//
// The whole point of TRA-4457 is that `signals: []` had two byte-identical
// causes: a quiet market, and a sweep that never got any bars to look at
// (Yahoo's 429 breaker is one GLOBAL flag, so a quote-side storm starves the
// daily-BAR pull). This script reads the discriminator — `sma200ScanStats` —
// and refuses to grade if the field is absent, because an OLD BUILD serves an
// empty `signals[]` with no census at all, and that must never be scored as a
// clean SWEPT.
//
// Usage: node scripts/tra4457-grade-census.mjs [--base=https://…] [--expect-sha=21b15106]
// Exit 0 = a verdict was reached (SWEPT or BLIND, both are real readings).
// Exit 3 = BLIND on the INSTRUMENT: the field is missing, i.e. the build
//          predates S1 and this read cannot discriminate anything.

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  }),
);
const BASE = args.base || 'https://tradingai-bqb1.onrender.com';
const EXPECT_SHA = args['expect-sha'] || null;

// `/api/health/options-live` is public; `/api/state` is not (401 without a
// bearer). Log in lazily so a build-pin read still works with no credentials.
let authHeaders = {};
async function login() {
  const user = process.env.TRADING_ADMIN_USERNAME || 'admin';
  const pass = process.env.TRADING_ADMIN_PASSWORD;
  if (!pass) {
    console.error('no TRADING_ADMIN_PASSWORD — /api/state is 401 without it');
    process.exit(2);
  }
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.error(`login → HTTP ${res.status}`);
    process.exit(2);
  }
  authHeaders = { Authorization: `Bearer ${(await res.json()).token}` };
}

async function get(path, auth = false) {
  if (auth && !authHeaders.Authorization) await login();
  const res = await fetch(`${BASE}${path}`, {
    headers: auth ? authHeaders : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

const health = await get('/api/health/options-live');
const build = health.build || {};
console.log(`build   : ${build.commitShort} pid=${build.pid} started=${build.startedAt} up=${build.uptimeSec}s`);

// Pin the build IN THE BEAT WE GRADE. A census read against a build that does
// not carry S1 is not a market reading, it is a reading of the wrong bytes.
if (EXPECT_SHA && !String(build.commitShort || '').startsWith(EXPECT_SHA)) {
  console.log(`\nINSTRUMENT BLIND — live build ${build.commitShort} is not the expected ${EXPECT_SHA}.`);
  process.exit(3);
}

const state = await get('/api/state', true);
const signals = state.signals || [];
const sma = signals.filter((s) => String(s.type || '').startsWith('sma200'));
const voids = state.sma200SignalVoids || [];
const stats = state.sma200ScanStats;

console.log(`symbols : ${(state.symbols || []).length}`);
console.log(`signals : ${signals.length} total, ${sma.length} sma200`);
console.log(`voids   : ${voids.length}`);

if (stats === undefined || stats === null) {
  // FIELD PRESENCE is the deployed-bytes proof (TRA-3913). `undefined` means an
  // old build; `null` means S1 is live but no sweep has completed in this
  // process yet — different facts, so they are not folded.
  console.log(
    stats === undefined
      ? '\nINSTRUMENT BLIND — `sma200ScanStats` ABSENT. This build predates S1; the empty feed is uninterpretable.'
      : '\nNO SWEEP YET — `sma200ScanStats` is null. S1 is live but no sweep has completed since boot; re-read after one.',
  );
  process.exit(3);
}

const starved = (stats.starvedBreakerOpen || 0) + (stats.starvedShortHistory || 0) + (stats.fetchFailed || 0);
const verdict = stats.considered <= 0 ? 'NO_UNIVERSE' : stats.evaluated > 0 ? 'SWEPT' : 'BLIND';

console.log('\n--- sweep census (TRA-4457 S1) ---');
for (const k of ['startedAt', 'finishedAt', 'considered', 'evaluated', 'starvedBreakerOpen', 'starvedShortHistory', 'fetchFailed', 'fired', 'voided', 'maxDistAtr']) {
  console.log(`  ${k.padEnd(20)} ${JSON.stringify(stats[k])}`);
}
console.log(`  ${'starved(total)'.padEnd(20)} ${starved}`);
console.log(`  ${'verdict'.padEnd(20)} ${verdict}`);
console.log(`  ${'sweptAgo'.padEnd(20)} ${Math.round((Date.now() - stats.finishedAt) / 1000)}s`);

console.log('\n--- what the empty feed is allowed to mean ---');
if (verdict === 'SWEPT' && sma.length === 0) {
  console.log(`  SWEPT with ${stats.evaluated} symbols scored and 0 sma200 signals.`);
  console.log('  ⇒ The market really was quiet. An empty queue is now an HONEST empty,');
  console.log('    and TRA-3693 AC5 may be discharged as "empty at grade time, denominator shown".');
} else if (verdict === 'SWEPT') {
  console.log(`  SWEPT with ${stats.evaluated} scored and ${sma.length} sma200 rows resting — grade the rows.`);
} else if (verdict === 'BLIND') {
  console.log(`  BLIND — 0 of ${stats.considered} symbols scored (${stats.starvedBreakerOpen} breaker-open,`);
  console.log(`    ${stats.starvedShortHistory} short-history, ${stats.fetchFailed} threw).`);
  console.log('  ⇒ The 2026-09-09 diagnosis is CONFIRMED LIVE. No conclusion about the market');
  console.log('    may be drawn from the empty feed, and S2 (per-source Yahoo breaker) is the real question.');
} else {
  console.log('  NO_UNIVERSE — the sweep was handed no symbols. Upstream watchlist fault, not a feed starve.');
}
