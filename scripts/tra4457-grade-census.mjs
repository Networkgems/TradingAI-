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
for (const k of ['startedAt', 'finishedAt', 'considered', 'evaluated', 'starvedBreakerOpen', 'starvedShortHistory', 'fetchFailed', 'fired', 'voided', 'maxDistAtr', 'memoHits']) {
  console.log(`  ${k.padEnd(20)} ${JSON.stringify(stats[k])}`);
}
// TRA-4457 S2 — `memoHits` is ABSENT on builds before the shared daily-bar memo;
// absent is "this build cannot dedup", not "0 hits". Say which.
console.log(`  ${'networkPulls'.padEnd(20)} ${'memoHits' in stats
  ? stats.considered - stats.memoHits + '  (considered - memoHits; upper bound, starves included)'
  : 'UNREAD — build predates the S2 memo'}`);
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

// ---------------------------------------------------------------------------
// PRE-REGISTERED SIGHTED-SWEEP SHAPE (TRA-3688 spec owner, 2026-09-10)
// ---------------------------------------------------------------------------
// Fixed in advance, off the S-1 replay that walked THIS SAME 751-name universe
// over 10 years. Pre-registration is the point: it turns "does the blind rate
// look acceptable?" — a question answerable by eyeballing, hence unfalsifiable —
// into a comparison against numbers written down before the read.
//
// 🔴 The discriminator is `starvedShortHistory`, NOT the blind rate. On a sighted
// sweep it must sit near 55, because 55 of the 751 genuinely list under 250 daily
// bars. On 2026-09-10T00:06:25Z it read 0 with all 751 charged to
// `starvedBreakerOpen` — the breaker was swallowing symbols that would OTHERWISE
// have been attributed to short history. So a sweep can only have issued real
// requests if those ~55 come back. A low `starvedBreakerOpen` percentage proves
// nothing on its own; `starvedShortHistory ≈ 0` with `evaluated` well under ~692
// is STILL STARVING however healthy the rate looks.
const EXPECTED = {
  considered: 751,
  evaluated: 692,            // 751 − 55 short-history − 4 hard 404
  starvedShortHistory: 55,
  fetchFailed: 4,            // SBLX / SELX / SATS / ATLN — Yahoo 404, permanent
  starvedBreakerOpen: 0,
};
// Tolerances: listings change and a 404 can resolve, so these are bands, not
// equalities. `evaluated` gets the widest band and still cannot reach 0.
const TOL = { evaluated: 60, starvedShortHistory: 25, fetchFailed: 6, starvedBreakerOpen: 40 };

console.log('\n--- vs the PRE-REGISTERED sighted-sweep shape ---');
const dev = [];
for (const k of ['considered', 'evaluated', 'starvedShortHistory', 'fetchFailed', 'starvedBreakerOpen']) {
  const got = stats[k] ?? 0;
  const want = EXPECTED[k];
  const tol = TOL[k] ?? 0;
  const ok = Math.abs(got - want) <= tol;
  if (!ok) dev.push(k);
  console.log(`  ${k.padEnd(20)} got ${String(got).padStart(4)}  expected ~${String(want).padStart(3)} ±${tol}  ${ok ? 'OK' : 'DEVIATES'}`);
}

// The composite test the spec owner actually pre-registered. Kept as ONE boolean
// so it cannot be passed by picking whichever counter happens to look good.
const stillStarving =
  (stats.evaluated ?? 0) < EXPECTED.evaluated - TOL.evaluated
  && (stats.starvedShortHistory ?? 0) < 10;
console.log(`\n  STILL-STARVING predicate (evaluated < ${EXPECTED.evaluated - TOL.evaluated} AND shortHistory < 10): ${stillStarving ? 'TRUE — starving' : 'false'}`);
if (stillStarving) {
  console.log('  ⇒ Whatever the blind-rate reads, this sweep did not issue real requests.');
  console.log('    The ~55 genuinely-short listings are the witness, and they are absent.');
} else if (dev.length === 0) {
  console.log('  ⇒ Sweep matches the pre-registered HEALTHY shape on every counter.');
}

// ---------------------------------------------------------------------------
// THE S-3 VOID-PATH ARM (TRA-3688 AC5 witness / the second starve)
// ---------------------------------------------------------------------------
// Both `voidSma200Signals` call sites are downstream of the breaker: the bar arm
// sits behind `if (candles.length < SMA200_MIN_BARS) return;`, and the only other
// caller is the QUOTE path — which is what holds the global Yahoo breaker open in
// the first place. So a BLIND sweep can neither refresh the queue nor expire it.
//
// 🔴 The trap this section exists to close: a row that was never checked is
// served with NO `voidReason` AT ALL (measured on live bytes 2026-09-10 — the key
// is ABSENT, not even `null`), which renders identically to "checked this sweep
// and still valid". The absence is therefore uninterpretable ON ITS OWN. The
// VERDICT is what disambiguates it, which is why this arm is keyed on the verdict
// and never on the rows alone.
console.log('\n--- resting rows: were they actually CHECKED this sweep? ---');
const fmt = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 16) + 'Z' : String(ms));
if (sma.length === 0) {
  console.log('  (no resting sma200 rows — nothing for the void path to act on)');
} else {
  for (const s of sma) {
    const bar = s.barTimestamp ?? s.validForBarTimestamp;
    const vr = 'voidReason' in s ? JSON.stringify(s.voidReason) : 'ABSENT';
    console.log(`  ${String(s.symbol).padEnd(6)} bar=${fmt(bar)} minted=${fmt(s.timestamp)} voidReason=${vr}`);
  }
  if (verdict === 'SWEPT') {
    // The void path DID run. A row that survives is affirmatively still valid:
    // the engine compared `latestBarTs > barTimestamp` for it this sweep.
    console.log(`\n  SWEPT ⇒ the void path RAN. The ${sma.length} surviving row(s) were CHECKED and are`);
    console.log('  affirmatively still valid; any that rolled over are in `sma200SignalVoids`.');
    if (voids.length > 0) {
      const roll = voids.filter((v) => v.voidReason === 'bar_rollover');
      console.log(`  voids: ${voids.length} total, ${roll.length} bar_rollover.`);
      for (const v of voids.slice(-8)) console.log(`    ${String(v.symbol).padEnd(6)} ${v.voidReason} @${fmt(v.voidedAt)}`);
      if (roll.length > 0) {
        console.log('  ✅ TRA-3693 AC5 WITNESS: a resting population was voided with a recorded');
        console.log('     reason. AC5 has been declared-empty three times; this is its first');
        console.log('     non-empty grade and it may now be discharged on evidence.');
      }
    } else {
      console.log('  voids: 0 — consistent ONLY if no newer bar existed for any resting row.');
    }
  } else if (verdict === 'BLIND') {
    console.log(`\n  🔴 BLIND ⇒ the void path was INERT. The ${sma.length} row(s) above were NOT checked`);
    console.log('  this sweep. Their missing `voidReason` is NOT evidence of validity — it is the');
    console.log('  absence of a check, and the two are indistinguishable on the wire. Treat every');
    console.log('  row as UNVERIFIED; do not grade setup quality off them, and do not report them');
    console.log('  as fresh finds — `evaluated: 0` means a PREVIOUS sweep minted them.');
  }
}
