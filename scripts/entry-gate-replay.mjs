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
 *
 * TRA-4662: /api/options/otm-mispricing is EPISODICALLY unavailable (no_spot /
 * no_expirations / no_chain / edge HTML), measured 26.3% over one 9-min RTH window
 * and 100% 22 minutes later. A fail-fast on the first non-ok symbol therefore
 * discards captures that the remaining symbols would have completed — the only
 * reason the capture record was pre-market-biased. So: bounded per-symbol retry,
 * ABSENT symbols are reported (never silently pooled away), and a capture missing
 * symbols exits 6, distinct from clean (0) — same class of defect as the exit-5
 * rowsRepaired vacuity guard, applied to the symbol denominator.
 *
 * Exit codes (precedence 3 > 5 > 6 > 0):
 *   0 clean         — all symbols captured, rowsRepaired > 0
 *   3 BLIND         — structural: no credentials, login failed, or ZERO symbols captured
 *   5 VACUOUS       — repair moved 0 rows; flip count is arithmetic, not evidence
 *   6 PARTIAL       — real result but ≥1 symbol ABSENT; NOT comparable to a full capture
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
// TRA-4662 — bounded per-symbol retry against an episodically-available route
const RETRY_N = Number(process.env.REPLAY_RETRY_N ?? 8);
const RETRY_DELAY_MS = Number(process.env.REPLAY_RETRY_DELAY_MS ?? 12_000);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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
const cheapRows = []; // repaired-cheap rows with the wire fields (TRA-4662 §6.3)
// TRA-4662/TRA-4663 — pooled counters hid the per-symbol structure (SPY 90% cheap
// vs NVDA 3.6%); per-symbol rawCheap/repCheap is the measurement that discriminates.
const perSymbol = new Map(); // symbol → {tries, reasons[], n, repaired, rawCheap, repCheap}
const absent = [];

// Bounded retry: a non-ok reason on one symbol must not discard the capture the
// other symbols would have completed. Exhausted retries → ABSENT, never exit.
const fetchSymbol = async (symbol) => {
  // minTheo=0 / minDelta=0 / minMispricing=0 → widest ladder for complete picture
  // basis=max for consistency with check-theo-arb; we re-derive theo-basis pct from wire values
  const url =
    `${HOST}/api/options/otm-mispricing?symbol=${symbol}` +
    `&limit=50&minDelta=0&minTheo=0&minMispricing=0&basis=max`;
  const reasons = [];
  for (let attempt = 1; attempt <= RETRY_N; attempt += 1) {
    if (attempt > 1) await sleep(RETRY_DELAY_MS);
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { reasons.push(`http_${r.status}`); continue; }
      const j = await r.json(); // edge HTML pages land in the catch below
      if (j.reason !== 'ok') { reasons.push(j.reason ?? 'no_reason'); continue; }
      reasons.push('ok');
      return { j, tries: attempt, reasons };
    } catch (err) {
      reasons.push(`threw(${err.message?.slice(0, 40)})`);
    }
  }
  return { j: null, tries: RETRY_N, reasons };
};

for (const symbol of SYMBOLS) {
  const { j, tries, reasons } = await fetchSymbol(symbol);
  const stats = { tries, reasons, n: 0, repaired: 0, rawCheap: 0, repCheap: 0 };
  perSymbol.set(symbol, stats);
  if (!j) {
    absent.push(symbol);
    console.log(`[entry-gate-replay] ${symbol} ABSENT after ${tries} tries: [${reasons.join(', ')}]`);
    continue;
  }
  console.log(`[entry-gate-replay] ${symbol} ok on try ${tries}/${RETRY_N} [${reasons.join(', ')}]`);

  for (const c of j.candidates ?? []) {
    stats.n += 1;
    totalCandidates += 1;
    if (!Number.isFinite(c.theoRaw)) continue;
    withTheoRaw += 1;
    if (c.theo !== c.theoRaw) { rowsRepaired += 1; stats.repaired += 1; }

    // Re-derive theo-basis pct for both repaired and raw theo
    const repairedClass = classify(c.mark, c.theo);
    const rawClass = classify(c.mark, c.theoRaw);
    if (repairedClass === null || rawClass === null) { rowsUnclassifiable += 1; continue; }
    if (rawClass === 'cheap') stats.rawCheap += 1;
    if (repairedClass === 'cheap') {
      stats.repCheap += 1;
      // TRA-4662 §6.3 — the wire fields the bias diagnosis needed, previously discarded
      const spread = Number.isFinite(c.ask) && Number.isFinite(c.bid) ? c.ask - c.bid : NaN;
      const edge = c.theo - c.mark; // claimed $ edge on a cheap row
      cheapRows.push({
        symbol,
        strike: c.strike,
        expiration: c.expiration,
        optionType: c.optionType,
        mark: c.mark,
        theoRepaired: c.theo,
        ivUsed: c.ivUsed,
        bid: c.bid,
        ask: c.ask,
        volume: c.volume,
        openInterest: c.openInterest,
        delta: c.delta,
        edgeOverSpread: Number.isFinite(spread) && spread > 0 ? (edge / spread).toFixed(1) : 'n/a',
      });
    }

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

const capturedSymbols = SYMBOLS.filter((s) => !absent.includes(s));
if (capturedSymbols.length === 0) {
  blind(`ZERO of ${SYMBOLS.length} symbols captured after ${RETRY_N} tries each`);
}

// TRA-4662 §6.2 — the summary must state the symbol denominator: a 3-symbol pooled
// cheap-share must never read comparable to a 5-symbol one.
console.log(`\n[entry-gate-replay] SYMBOLS CAPTURED         : ${capturedSymbols.length}/${SYMBOLS.length}` +
  (absent.length > 0 ? `  ABSENT: [${absent.join(', ')}]  <-- pooled figures NOT comparable to a full capture` : ''));
console.log(`[entry-gate-replay] per-symbol (TRA-4663 — pooled counters hide this):`);
for (const [sym, s] of perSymbol) {
  const line = absent.includes(sym)
    ? `  ${sym.padEnd(5)} ABSENT  tries=${s.tries} [${s.reasons.join(', ')}]`
    : `  ${sym.padEnd(5)} n=${s.n}  repaired=${s.repaired}  rawCheap=${s.rawCheap}  repCheap=${s.repCheap}` +
      (s.n > 0 ? `  (${((100 * s.repCheap) / s.n).toFixed(1)}% cheap)` : '');
  console.log(line);
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
}

if (cheapRows.length > 0) {
  console.log(`\n[entry-gate-replay] repaired-cheap detail (${cheapRows.length} rows — wire fields per TRA-4662 §6.3):`);
  for (const r of cheapRows) {
    console.log(
      `  ${r.symbol} ${r.optionType} K=${r.strike} exp=${r.expiration} ` +
        `mark=${r.mark} theoRep=${r.theoRepaired} ivUsed=${r.ivUsed ?? 'absent'} ` +
        `bid/ask=${r.bid ?? '?'}/${r.ask ?? '?'} vol=${r.volume ?? '?'} oi=${r.openInterest ?? '?'} ` +
        `delta=${r.delta ?? '?'} edge/spread=${r.edgeOverSpread}x`,
    );
  }
}

if (rowsRepaired === 0 && flipRows.length === 0) {
  // ⛔ Do NOT report this as "the repair is entry-gate-neutral". The repair moved
  // nothing in this pull, so the flip count had nothing to count and carries no
  // information about gate behaviour either way. Exit 5 keeps it out of the PASS
  // bucket: a vacuous zero must not be graded as a clean result.
  console.log(`\n[entry-gate-replay] VACUOUS — the repair changed 0 of ${withTheoRaw} rows in this pull,`);
  console.log(`[entry-gate-replay] so "0 flips" is arithmetic, not evidence. Re-pull when the surface`);
  console.log(`[entry-gate-replay] actually violates monotonicity (check:theo-arb reports repair reach).`);
  process.exit(5);
}
if (flipRows.length === 0) {
  console.log(`\n[entry-gate-replay] no classification flips — the repair moved ${rowsRepaired} of ${withTheoRaw} rows`);
  console.log(`[entry-gate-replay] and NONE of them crossed a gate boundary. This is a real result: the`);
  console.log(`[entry-gate-replay] repair is entry-gate-neutral on this capture.`);
}
if (absent.length > 0) {
  // TRA-4662 §6.2 — "completed but incomplete" must not be gradable as clean.
  console.log(`\n[entry-gate-replay] PARTIAL — capture is real but MISSING [${absent.join(', ')}]; exit 6, not comparable to a full capture.`);
  process.exit(6);
}
