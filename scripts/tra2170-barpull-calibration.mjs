#!/usr/bin/env node
// TRA-2170 — bar-pull ceiling calibration reader.
//
// WHY THIS EXISTS
// ---------------
// `TRADIER_BAR_PULL_CEILING` is an ABSOLUTE req/min constant, but the quantity it
// bounds — the process-global Tradier bar-pull rate — scales with the SYMBOL
// UNIVERSE, which grows. The enable target of ~200 was recalibrated (TRA-2170
// disposition A, 2026-07-24) against a steady-state measured at **568 symbols**.
// A ceiling set BELOW steady state defers COLD pulls continuously and ages cold
// candles past the shard cadence — the TRA-1539 regression the recalibration
// existed to prevent. So the value is only safe relative to a steady state
// measured at the CURRENT universe size, and it must be RE-MEASURED, never
// inherited from a prior session's note.
//
// THE MEASUREMENT, AND WHY IT IS SHAPED THIS WAY
// ---------------------------------------------
// `results.tradierBarPullRate.requestsLastMin` is a 60s ROLLING meter: transient,
// noisy, and it cannot be read after the fact. Percentiles off it need dense
// in-RTH polling, and `/api/health/quotes` is not a free read — it runs the
// minute-bar and daily-bar candle cascades, so a dense poll PERTURBS THE VERY
// QUANTITY IT MEASURES (and dense sampling of this route is what caused the
// 2026-06-08 outage, TRA-707/708).
//
// `results.fallbackRequestsToday.tradier` is the cumulative per-instance bar-pull
// counter over the same call sites. Differencing it across TWO SPARSE reads gives
// the exact MEAN bar-pull rate over the bracketed interval with two route calls
// instead of hundreds — strictly better for the question that decides the ceiling
// ("does steady state exceed the candidate value?"), and near-zero observer
// effect. The rolling meter is still recorded alongside for the burst tail.
//
// The counter resets on process restart AND at UTC midnight, so an interval is
// only valid when the build pin (commit/pid/startedAt) is IDENTICAL at both ends
// and the UTC day did not roll. Both are asserted; a violated interval is printed
// as BLIND and excluded, never silently differenced into a negative or a bogus rate.
//
// USAGE
//   node scripts/tra2170-barpull-calibration.mjs --mark            # one datapoint -> ledger
//   node scripts/tra2170-barpull-calibration.mjs --report          # intervals + verdict
//   node scripts/tra2170-barpull-calibration.mjs --mark --report
//   node scripts/tra2170-barpull-calibration.mjs --burst=8         # ts-deduped rolling-meter samples
//   ...  --ceiling=200                                             # candidate to grade against
//
// Env: TRADING_ADMIN_USERNAME / TRADING_ADMIN_PASSWORD (shell env, NOT a .env file)
// are needed only for the universe-size read; without them universe is recorded
// as `<<ABSENT>>` — never as 0, which would read as "the universe is empty".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env['TRA2170_HOST'] || 'https://tradingai-bqb1.onrender.com';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_DIR = path.join(__dirname, '..', '.tra2170');
const LEDGER = path.join(LEDGER_DIR, 'barpull-ledger.jsonl');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const hit = argv.find((a) => a.startsWith(`${f}=`));
  return hit ? hit.slice(f.length + 1) : d;
};
const CANDIDATE_CEILING = Number(val('--ceiling', '200'));

async function getJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000), ...opts });
  const text = await res.text();
  // A 5xx wrapping a plausible body is still a failed read — check the code
  // BEFORE parsing (TRA-2940).
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/**
 * Build identity, asserted FIRST. `/api/health` is a 45-byte {ok,time} with no
 * `build` block at all, so a pin read from there is `undefined` on a perfectly
 * healthy box (TRA-1655). The pin lives on /api/health/options-live.
 */
async function readPin() {
  const j = await getJson(`${HOST}/api/health/options-live`);
  const b = j.build;
  if (!b || b.pid === undefined || !b.startedAt || !b.commit) {
    throw new Error(`BLIND: no usable build pin on ${HOST}/api/health/options-live — refusing to record`);
  }
  return { commit: b.commit, commitShort: b.commitShort, pid: b.pid, startedAt: b.startedAt, uptimeSec: b.uptimeSec };
}

async function readCounters() {
  const j = await getJson(`${HOST}/api/health/quotes`);
  const r = j.results || {};
  const barRate = r.tradierBarPullRate;
  const quoteRate = r.tradierQuoteRate;
  const today = r.fallbackRequestsToday;
  for (const [name, v] of [['tradierBarPullRate', barRate], ['tradierQuoteRate', quoteRate], ['fallbackRequestsToday', today]]) {
    if (!v || typeof v !== 'object' || 'error' in v || 'skipped' in v) {
      throw new Error(`BLIND: ${name} unusable on /api/health/quotes: ${JSON.stringify(v)}`);
    }
  }
  if (typeof today.tradier !== 'number') {
    throw new Error(`BLIND: fallbackRequestsToday.tradier is ${JSON.stringify(today.tradier)}, not a number`);
  }
  const fd = (j.feedDegradation || {}).tradier || {};
  return {
    snapshotTs: j.ts,                       // server snapshot instant (route caches 20s)
    cached: j.cached === true,
    day: today.day,
    cumulativeBarPulls: today.tradier,
    barPullsLastMin: barRate.requestsLastMin,
    quoteReqLastMin: quoteRate.requestsLastMin,
    cachedSymbols: quoteRate.cachedSymbols,
    // TRA-2073: `requestsLastMin: 0` has two parents — nobody asked, or everybody
    // was refused. Grade a zero against the gate state that could have caused it.
    quotePathOpen: fd.quotePathOpen ?? '<<ABSENT>>',
    barPathOpen: fd.barPathOpen ?? '<<ABSENT>>',
    tradierBreakerOpen: fd.open ?? '<<ABSENT>>',
  };
}

/**
 * Universe size. `state.symbols` is PER-USER scoped and its elements are OBJECTS,
 * not strings (TRA-2716) — `indexOf('AAPL')` is -1 always. Assert a positive
 * control in the same beat or an ABSENT reading is just as likely a broken read.
 */
async function readUniverse() {
  const u = process.env['TRADING_ADMIN_USERNAME'];
  const p = process.env['TRADING_ADMIN_PASSWORD'];
  if (!u || !p) return { universe: '<<ABSENT>>', universeNote: 'TRADING_ADMIN_USERNAME/PASSWORD unset — universe not read' };
  try {
    const login = await getJson(`${HOST}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    // bqb1 auth is a BEARER TOKEN, not a cookie (TRA-2627).
    if (!login.token) return { universe: '<<ABSENT>>', universeNote: 'login returned no token' };
    const st = await getJson(`${HOST}/api/state`, { headers: { Authorization: `Bearer ${login.token}` } });
    const syms = st.symbols;
    if (!Array.isArray(syms)) return { universe: '<<ABSENT>>', universeNote: 'state.symbols is not an array' };
    const ctlAapl = syms.findIndex((r) => r && r.symbol === 'AAPL');
    if (ctlAapl < 0) return { universe: '<<ABSENT>>', universeNote: 'positive control failed: AAPL not found in state.symbols' };
    return { universe: syms.length, universeNote: `positive control ok (AAPL at index ${ctlAapl})`, universeScope: 'admin book, per-user scoped' };
  } catch (err) {
    return { universe: '<<ABSENT>>', universeNote: `universe read failed: ${err.message}` };
  }
}

async function mark() {
  const pin = await readPin();
  const counters = await readCounters();
  const universe = await readUniverse();
  const row = { wallClock: new Date().toISOString(), ...pin, ...counters, ...universe };
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  fs.appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
  console.log('MARK', JSON.stringify(row, null, 2));
  return row;
}

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function report() {
  const rows = loadLedger();
  console.log(`\n=== TRA-2170 bar-pull calibration — ${rows.length} marks in ${LEDGER}`);
  if (rows.length < 2) {
    console.log('Need >= 2 marks to difference the cumulative counter. Nothing to report.');
    return;
  }
  const intervals = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    const minutes = (Date.parse(b.wallClock) - Date.parse(a.wallClock)) / 60_000;
    const samePin = a.commit === b.commit && a.pid === b.pid && a.startedAt === b.startedAt;
    const sameDay = a.day === b.day;
    const distinctSnapshot = a.snapshotTs !== b.snapshotTs;
    const blindReasons = [];
    if (!samePin) blindReasons.push('RESTART between marks (counter reset) — pin changed');
    if (!sameDay) blindReasons.push('UTC day rolled (counter reset)');
    if (!distinctSnapshot) blindReasons.push('same cached snapshot ts (marks < 20s apart)');
    if (minutes < 5) blindReasons.push(`interval ${minutes.toFixed(1)}min < 5min — too short for a steady-state mean`);
    const delta = b.cumulativeBarPulls - a.cumulativeBarPulls;
    if (delta < 0) blindReasons.push(`counter went BACKWARDS (${a.cumulativeBarPulls} -> ${b.cumulativeBarPulls})`);
    intervals.push({
      from: a.wallClock, to: b.wallClock, minutes,
      meanBarPullsPerMin: blindReasons.length ? null : delta / minutes,
      delta, universeFrom: a.universe, universeTo: b.universe,
      rollingAtEnds: [a.barPullsLastMin, b.barPullsLastMin],
      blind: blindReasons.length > 0, blindReasons,
    });
  }
  for (const iv of intervals) {
    const head = `${iv.from} -> ${iv.to}  (${iv.minutes.toFixed(1)} min, universe ${iv.universeFrom}->${iv.universeTo})`;
    if (iv.blind) {
      console.log(`  BLIND  ${head}\n         ${iv.blindReasons.join('; ')}`);
    } else {
      console.log(`  MEAN   ${head}\n         ${iv.delta} bar pulls => ${iv.meanBarPullsPerMin.toFixed(1)} req/min   (rolling meter at ends: ${iv.rollingAtEnds.join(', ')})`);
    }
  }
  const valid = intervals.filter((i) => !i.blind);
  console.log(`\n  usable intervals: ${valid.length}/${intervals.length}`);
  if (!valid.length) {
    console.log('  VERDICT: BLIND — no usable interval. A ceiling MUST NOT be set from this ledger.');
    return;
  }
  const means = valid.map((i) => i.meanBarPullsPerMin);
  const maxMean = Math.max(...means);
  console.log(`  steady-state mean bar-pull rate: min ${Math.min(...means).toFixed(1)} / max ${maxMean.toFixed(1)} req/min`);
  console.log(`  candidate ceiling: ${CANDIDATE_CEILING}`);
  if (maxMean >= CANDIDATE_CEILING) {
    console.log(`  VERDICT: DO NOT SET ${CANDIDATE_CEILING} — steady-state mean ${maxMean.toFixed(1)} >= ceiling.`);
    console.log('           A ceiling at or below steady state defers COLD pulls CONTINUOUSLY and ages');
    console.log('           cold candles past the shard cadence (the TRA-1539 regression).');
  } else {
    const headroomPct = ((CANDIDATE_CEILING - maxMean) / maxMean) * 100;
    console.log(`  VERDICT: ${CANDIDATE_CEILING} sits ${headroomPct.toFixed(0)}% above the measured steady-state mean.`);
    console.log('           NOTE: a mean is not the burst tail. The ceiling is intended to bite only on');
    console.log('           MTF-burst minutes; use --burst samples to see how often the rolling meter');
    console.log('           crosses the candidate before treating this as sufficient.');
  }
}

async function burst(n) {
  console.log(`=== burst: ${n} DISTINCT snapshots (route caches 20s; polling 8s, recording only on a changed ts)`);
  const seen = [];
  let lastTs = null;
  const t0 = Date.now();
  const pin0 = await readPin();
  while (seen.length < n && Date.now() - t0 < 10 * 60_000) {
    try {
      const c = await readCounters();
      if (c.snapshotTs !== lastTs) {
        lastTs = c.snapshotTs;
        seen.push(c.barPullsLastMin);
        console.log(`  ${new Date(c.snapshotTs).toISOString()}  barPullsLastMin=${c.barPullsLastMin}  quoteReq=${c.quoteReqLastMin}  breakerOpen=${c.tradierBreakerOpen} quotePathOpen=${c.quotePathOpen}`);
      }
    } catch (err) {
      console.log(`  read error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  const pin1 = await readPin();
  if (pin1.pid !== pin0.pid || pin1.startedAt !== pin0.startedAt) {
    console.log('  *** RESTART DURING BURST — these samples span two processes, do not pool them ***');
  }
  const sorted = [...seen].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  console.log(`  n=${sorted.length}  p50=${q(50)}  p90=${q(90)}  max=${sorted[sorted.length - 1]}  >= ${CANDIDATE_CEILING}: ${sorted.filter((v) => v >= CANDIDATE_CEILING).length}/${sorted.length}`);
}

const doMark = has('--mark') || argv.length === 0;
const doReport = has('--report') || argv.length === 0;
const burstN = Number(val('--burst', '0'));

try {
  if (burstN > 0) await burst(burstN);
  if (doMark) await mark();
  if (doReport) report();
} catch (err) {
  console.error(`FAILED: ${err.message}`);
  process.exit(3);
}
