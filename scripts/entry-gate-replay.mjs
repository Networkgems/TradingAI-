#!/usr/bin/env node
/**
 * TRA-2918 acceptance 3 / TRA-2917 acceptance 4 — entry-gate replay.
 *
 * Fetches live OTM candidates and reports:
 *   - how many candidates flip classification (cheap/fair/expensive) per capture
 *   - specifically how many single_leg_otm 'cheap' gate decisions flip under
 *     production sleeve params (threshold 15%)
 *
 * IMPORTANT: we fetch with minMispricing=0 to get ALL candidates including fair,
 * but we cannot use c.classification from the wire because that was computed with
 * threshold=0 (the route passes mispricingThresholdPct = minMispricing when finite).
 * Instead we re-derive both repaired and raw classifications from theo/theoRaw on
 * the wire, using the production threshold of 15% = OTM_PANEL_MISPRICING_THRESHOLD.
 * We use the same theo-basis the sleeve uses: (mark − theo) / theo.
 */

const SYMBOLS = (process.env.THEO_ARB_SYMBOLS ?? 'SPY,TSLA,NVDA,QQQ,AAPL')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const HOST = process.env.BQB1_HOST ?? 'https://tradingai-bqb1.onrender.com';
const USER = process.env.TRADING_ADMIN_USERNAME ?? 'admin';
const PASS = process.env.TRADING_ADMIN_PASSWORD;
// Production single_leg_otm threshold — OTM_PANEL_MISPRICING_THRESHOLD
const THRESHOLD = 0.15;

const blind = (msg) => {
  console.error(`[entry-gate-replay] BLIND — ${msg}`);
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
console.log(`[entry-gate-replay] host  : ${HOST}`);
console.log(`[entry-gate-replay] live  : ${version?.commit ?? 'unknown'}`);
console.log(`[entry-gate-replay] at    : ${new Date().toISOString()}`);
console.log(`[entry-gate-replay] production cheap threshold: ${THRESHOLD * 100}%`);

// Theo-basis classification (matches single_leg_otm sleeve behavior)
const classify = (mark, theo) => {
  if (!Number.isFinite(theo) || theo <= 0) return null;
  const pct = (mark - theo) / theo;
  if (pct < -THRESHOLD) return 'cheap';
  if (pct > THRESHOLD) return 'expensive';
  return 'fair';
};

let totalCandidates = 0;
let withTheoRaw = 0;
let classFlips = 0;
let cheapGateNewFires = 0; // repaired=cheap, raw≠cheap (repair OPENED the gate)
let cheapGateLostFires = 0; // raw=cheap, repaired≠cheap (repair CLOSED the gate)
// TRA-2918 — the DENOMINATOR of the flip count, and the reason this exists:
// `classification flips: 0` reads IDENTICALLY in two completely different worlds
// — (a) the repair moved rows and none of them crossed a gate boundary, which is
// the informative result this acceptance item is asking for, and (b) the repair
// moved NOTHING in this pull, which makes the flip count vacuous. Without
// `rowsRepaired` the reader cannot tell them apart, and a vacuous zero would be
// reported as "the repair is entry-gate-neutral".
let rowsRepaired = 0; // theo !== theoRaw
let rowsUnclassifiable = 0; // classify() returned null on either surface
const flipRows = [];

for (const symbol of SYMBOLS) {
  // minTheo=0 / minDelta=0 / minMispricing=0 → widest ladder for complete picture
  // basis=max for consistency with check-theo-arb; we re-derive theo-basis pct from wire values
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

  for (const c of j.candidates ?? []) {
    totalCandidates += 1;
    if (!Number.isFinite(c.theoRaw)) continue;
    withTheoRaw += 1;
    if (c.theo !== c.theoRaw) rowsRepaired += 1;

    // Re-derive theo-basis pct for both repaired and raw theo
    const repairedClass = classify(c.mark, c.theo);
    const rawClass = classify(c.mark, c.theoRaw);
    if (repairedClass === null || rawClass === null) { rowsUnclassifiable += 1; continue; }

    if (rawClass !== repairedClass) {
      classFlips += 1;
      // Theo-basis pcts for reporting
      const repPct = (c.mark - c.theo) / c.theo;
      const rawPct = (c.mark - c.theoRaw) / c.theoRaw;
      flipRows.push({
        symbol,
        strike: c.strike,
        expiration: c.expiration,
        optionType: c.optionType,
        mark: c.mark,
        theoRaw: c.theoRaw,
        theoRepaired: c.theo,
        rawPct: rawPct.toFixed(4),
        repPct: repPct.toFixed(4),
        rawClass,
        repairedClass,
      });
    }

    // Cheap gate: single_leg_otm fires when classification === 'cheap'
    if (repairedClass === 'cheap' && rawClass !== 'cheap') cheapGateNewFires += 1;
    if (rawClass === 'cheap' && repairedClass !== 'cheap') cheapGateLostFires += 1;
  }
}

console.log(`\n[entry-gate-replay] total candidates        : ${totalCandidates}`);
console.log(`[entry-gate-replay] with theoRaw             : ${withTheoRaw}`);
console.log(`[entry-gate-replay] ROWS REPAIRED            : ${rowsRepaired}  <-- the flip count's denominator; 0 here makes the flip count VACUOUS`);
console.log(`[entry-gate-replay] unclassifiable rows      : ${rowsUnclassifiable}  (no verdict on either surface — excluded from the flip count, not counted as 'no flip')`);
console.log(`[entry-gate-replay] classification flips     : ${classFlips}  (cheap/fair/expensive changed)`);
console.log(`[entry-gate-replay] cheap gate new fires     : ${cheapGateNewFires}  (repaired=cheap, raw≠cheap — repair OPENED gate)`);
console.log(`[entry-gate-replay] cheap gate lost fires    : ${cheapGateLostFires}  (raw=cheap, repaired≠cheap — repair CLOSED gate)`);

if (flipRows.length > 0) {
  console.log(`\n[entry-gate-replay] flip detail (theo-basis pct, threshold ${THRESHOLD * 100}%):`);
  for (const r of flipRows) {
    console.log(
      `  ${r.symbol} ${r.optionType} K=${r.strike} exp=${r.expiration} ` +
        `mark=${r.mark} theoRaw=${r.theoRaw} theoRep=${r.theoRepaired} ` +
        `rawPct=${r.rawPct} repPct=${r.repPct} ${r.rawClass}→${r.repairedClass}`,
    );
  }
} else if (rowsRepaired === 0) {
  // ⛔ Do NOT report this as "the repair is entry-gate-neutral". The repair moved
  // nothing in this pull, so the flip count had nothing to count and carries no
  // information about gate behaviour either way. Exit 5 keeps it out of the PASS
  // bucket: a vacuous zero must not be graded as a clean result.
  console.log(`\n[entry-gate-replay] VACUOUS — the repair changed 0 of ${withTheoRaw} rows in this pull,`);
  console.log(`[entry-gate-replay] so "0 flips" is arithmetic, not evidence. Re-pull when the surface`);
  console.log(`[entry-gate-replay] actually violates monotonicity (check:theo-arb reports repair reach).`);
  process.exit(5);
} else {
  console.log(`\n[entry-gate-replay] no classification flips — the repair moved ${rowsRepaired} of ${withTheoRaw} rows`);
  console.log(`[entry-gate-replay] and NONE of them crossed a gate boundary. This is a real result: the`);
  console.log(`[entry-gate-replay] repair is entry-gate-neutral on this capture.`);
}
