#!/usr/bin/env node
/**
 * TRA-2662 — static no-arbitrage guard for the OTM panel's `theo` surface.
 *
 * Vertical-spread monotonicity is model-free: calls must be non-increasing in
 * strike, puts non-decreasing. The MARKET satisfies it in every capture taken so
 * far; OUR MODEL does not. This turns that one-off measurement into a guard.
 *
 * ## Exit codes — it FAILS CLOSED
 *
 *   0  CLEAN   — theo 0 violations, mark 0 violations, over a non-zero pair count
 *   1  ARB     — `theo` violates: the defect is live
 *   2  CONTROL — `mark` violates: the DETECTOR (or the tape) is broken, and the
 *                theo arm of this run means nothing. Never reported as a pass.
 *   3  BLIND   — unreadable: login failed, non-200, reason != ok, or NOTHING
 *                testable (0 adjacent pairs). A guard that reports "0 violations"
 *                off an empty cohort is the vacuous green this ticket chain kept
 *                producing — so 0 pairs is BLIND, not CLEAN.
 *
 * ## Why the violation count is a LOWER bound
 *
 * The panel is already filtered, so "adjacent" means adjacent among SURVIVING
 * strikes. Monotonicity is transitive, so any violation found here is a genuine
 * violation of the full surface; the reverse does not hold. Non-zero is always
 * real. Zero is "none detected", not "proven arbitrage-free".
 *
 * ## ⛔ The acceptance trap — read before "fixing" anything to make this green
 *
 * This bar can be bought by OVER-SMOOTHING. `theo` is BS at each contract's own
 * `ivUsed`; flattening σ across strikes drives violations to exactly 0 while
 * destroying the strike-by-strike disagreement the panel exists to surface. So
 * this script also reports DISCRIMINATION (the spread of |mispricingPct| against
 * `mark`). A fix that zeroes the violations and collapses discrimination has not
 * fixed anything — grade both, plus stability across two captures hours apart,
 * because the failing cell has rotated in every capture so far.
 *
 * Usage:
 *   node scripts/check-theo-arb.mjs              # live sweep
 *   node scripts/check-theo-arb.mjs --selftest   # mutation controls, no network
 */

const SYMBOLS = (process.env.THEO_ARB_SYMBOLS ?? 'SPY,TSLA,NVDA,QQQ,AAPL')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/** Adjacent-strike vertical monotonicity, grouped by (expiration, optionType). */
function findViolations(candidates) {
  const buckets = new Map();
  for (const c of candidates) {
    const key = `${c.expiration}|${c.optionType}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  const theo = [];
  const mark = [];
  let pairs = 0;
  for (const bucket of buckets.values()) {
    const rows = [...bucket].sort((a, b) => a.strike - b.strike);
    if (rows.length < 2) continue;
    pairs += rows.length - 1;
    for (let i = 0; i + 1 < rows.length; i += 1) {
      const lo = rows[i];
      const hi = rows[i + 1];
      for (const basis of ['theo', 'mark']) {
        const lv = lo[basis];
        const hv = hi[basis];
        if (!Number.isFinite(lv) || !Number.isFinite(hv)) continue;
        const bad = lo.optionType === 'call' ? hv > lv : hv < lv;
        if (!bad) continue;
        const v = {
          basis,
          optionType: lo.optionType,
          lowStrike: lo.strike,
          highStrike: hi.strike,
          lowValue: lv,
          highValue: hv,
          gapPerContract: Math.abs(hv - lv) * 100,
        };
        (basis === 'theo' ? theo : mark).push(v);
      }
    }
  }
  return { pairs, theo, mark };
}

// ---------------------------------------------------------------- selftest --
// The controls exist because a monotonicity guard's failure mode is being
// unable to fail. Each arm is proven to swing BOTH ways.
if (process.argv.includes('--selftest')) {
  const mk = (strike, optionType, theo, mark) => ({
    strike, optionType, theo, mark, expiration: '2026-09-04',
  });
  const calls = [mk(100, 'call', 5, 5.2), mk(105, 'call', 3, 3.1), mk(110, 'call', 1.5, 1.6)];
  const puts = [mk(90, 'put', 0.5, 0.6), mk(95, 'put', 1.5, 1.6), mk(100, 'put', 3, 3.1)];
  const cases = [
    ['coherent calls          → theo 0', findViolations(calls).theo.length === 0],
    ['coherent puts           → theo 0', findViolations(puts).theo.length === 0],
    ['coherent both           → mark 0', findViolations([...calls, ...puts]).mark.length === 0],
    [
      'call theo RISES in K    → theo 1',
      findViolations([mk(100, 'call', 5, 5.2), mk(105, 'call', 5.4, 3.1)]).theo.length === 1,
    ],
    [
      'put theo FALLS in K     → theo 1',
      findViolations([mk(95, 'put', 1.5, 1.6), mk(100, 'put', 1.2, 3.1)]).theo.length === 1,
    ],
    [
      'MARK crossed            → mark 1 (control can fail)',
      findViolations([mk(100, 'call', 5, 5.2), mk(105, 'call', 3, 5.9)]).mark.length === 1,
    ],
    [
      'call vs put not compared',
      findViolations([mk(100, 'call', 5, 5.2), mk(105, 'put', 9, 9.1)]).theo.length === 0,
    ],
    [
      'expirations not compared',
      findViolations([
        mk(100, 'call', 5, 5.2),
        { ...mk(105, 'call', 9, 9.1), expiration: '2026-10-16' },
      ]).theo.length === 0,
    ],
    ['single row → 0 pairs (BLIND, not a pass)', findViolations([mk(100, 'call', 5, 5.2)]).pairs === 0],
    [
      'live 2026-08-05 SPY put 600/625 still flagged',
      findViolations([mk(600, 'put', 0.4634, 0.47), mk(625, 'put', 0.3442, 0.55)]).theo.length === 1,
    ],
  ];
  let bad = 0;
  for (const [name, ok] of cases) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) bad += 1;
  }
  console.log(bad === 0 ? '\n[theo-arb] controls OK — both arms can pass AND fail.' : `\n[theo-arb] ${bad} CONTROL FAILURES`);
  process.exit(bad === 0 ? 0 : 1);
}

// -------------------------------------------------------------------- live --
const HOST = process.env.BQB1_HOST ?? 'https://tradingai-bqb1.onrender.com';
const USER = process.env.TRADING_ADMIN_USERNAME ?? 'admin';
const PASS = process.env.TRADING_ADMIN_PASSWORD;

const blind = (msg) => {
  console.error(`[theo-arb] BLIND — ${msg}`);
  process.exit(3);
};

if (!PASS) blind('no TRADING_ADMIN_PASSWORD');

let token;
try {
  const r = await fetch(`${HOST}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!r.ok) blind(`login ${r.status}`);
  token = (await r.json()).token;
} catch (err) {
  blind(`login threw: ${err.message}`);
}
if (!token) blind('login returned no token');

const version = await fetch(`${HOST}/api/health/version`)
  .then((r) => r.json())
  .catch(() => null);
console.log(`[theo-arb] host  : ${HOST}`);
console.log(`[theo-arb] live  : ${version?.commit ?? 'unknown'}`);
console.log(`[theo-arb] at    : ${new Date().toISOString()}`);

let pairs = 0;
const theo = [];
const mark = [];
let servedBlockSeen = 0;
const disc = [];

for (const symbol of SYMBOLS) {
  // minTheo=0 / minDelta=0 keep the widest testable strike ladder: every filtered
  // strike destroys an adjacent pair, so filtering here would weaken the guard.
  const url =
    `${HOST}/api/options/otm-mispricing?symbol=${symbol}` +
    `&limit=50&minDelta=0&minTheo=0&minMispricing=0&basis=max`;
  let j;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) blind(`${symbol} http ${r.status}`);
    j = await r.json();
  } catch (err) {
    blind(`${symbol} threw: ${err.message}`);
  }
  if (j.reason !== 'ok') blind(`${symbol} reason=${j.reason}`);
  if (j.noArbitrage) servedBlockSeen += 1;

  const v = findViolations(j.candidates ?? []);
  pairs += v.pairs;
  for (const x of v.theo) theo.push({ symbol, ...x });
  for (const x of v.mark) mark.push({ symbol, ...x });
  for (const c of j.candidates ?? []) {
    if (Number.isFinite(c.mispricingPct)) disc.push(Math.abs(c.mispricingPct));
  }
  console.log(
    `[theo-arb]   ${symbol.padEnd(5)} rows=${String(j.candidates?.length ?? 0).padStart(3)}` +
    ` pairs=${String(v.pairs).padStart(3)} theo=${String(v.theo.length).padStart(2)} mark=${String(v.mark.length).padStart(2)}`,
  );
}

// A guard that cannot see anything must not report a pass.
if (pairs === 0) blind('0 adjacent pairs testable across the whole sweep');

// Discrimination — the over-smoothing tripwire. If a future "fix" zeroes the
// violations by flattening the surface, this collapses toward 0 and the fix is
// not a fix. Reported, never auto-failed: there is no pre-registered floor yet.
disc.sort((a, b) => a - b);
const median = disc.length ? disc[Math.floor(disc.length / 2)] : 0;
const p90 = disc.length ? disc[Math.floor(disc.length * 0.9)] : 0;

console.log(`\n[theo-arb] pairs tested     : ${pairs}`);
console.log(`[theo-arb] THEO violations  : ${theo.length}`);
console.log(`[theo-arb] MARK violations  : ${mark.length}   (negative control, expect 0)`);
console.log(`[theo-arb] discrimination   : median |mispricingPct| ${(median * 100).toFixed(2)}%, p90 ${(p90 * 100).toFixed(2)}%`);
console.log(
  `[theo-arb] served noArbitrage block on ${servedBlockSeen}/${SYMBOLS.length} responses` +
  `${servedBlockSeen === 0 ? '  ← build predates TRA-2662' : ''}`,
);

const show = (list, label) => {
  if (!list.length) return;
  console.log(`\n[theo-arb] ${label}:`);
  for (const v of list.sort((a, b) => b.gapPerContract - a.gapPerContract).slice(0, 12)) {
    console.log(
      `  ${v.symbol.padEnd(5)} ${v.optionType.padEnd(4)} ${String(v.lowStrike).padStart(6)}/${String(v.highStrike).padEnd(6)}` +
      ` ${v.lowValue.toFixed(4)} → ${v.highValue.toFixed(4)}   $${v.gapPerContract.toFixed(2)}/contract`,
    );
  }
};
show(mark, 'MARK violations (control breach — invalidates the theo arm)');
show(theo, 'THEO violations');

if (mark.length > 0) {
  console.error('\n[theo-arb] CONTROL BREACH — the market surface violates too. The detector or');
  console.error('[theo-arb] the tape is wrong; the theo arm of this run proves nothing.');
  process.exit(2);
}
if (theo.length > 0) {
  console.error(`\n[theo-arb] ARB — ${theo.length}/${pairs} adjacent pairs violate on \`theo\` while the`);
  console.error('[theo-arb] market violates 0. The model surface is not arbitrage-free (TRA-2662).');
  process.exit(1);
}
console.log('\n[theo-arb] CLEAN — theo 0, mark 0, over a non-empty pair set.');
