#!/usr/bin/env node
// TRA-4782 — grade the Tradier stream's quote latency against TRA-4656 AC #1
// (<500ms from the exchange timestamp), and print which branch of the experiment
// the measurement lands on.
//
// WHY THIS IS A SCRIPT. The 2026-09-22 control (p50 35.6-46.1s over 786 symbols)
// was derived BY HAND off `/api/market-data/stream`. A verdict re-derived by hand
// on a different day, by a different reader, is not a comparison — the method has
// to be the constant. So this file IS the method, for both arms.
//
// It reports TWO p50s and they answer different questions:
//
//   PER-SYMBOL  — the median over each subscribed symbol's most recent quote.
//                 This is EXACTLY the 09-22 control's method, so it is the number
//                 the before/after comparison must be made on.
//   FEED SAMPLE — the server's own `latencyP50Ms`, over the trailing N quote
//                 FRAMES. Frame-weighted, so a hot mega-cap counts many times and
//                 a thin name once. Not comparable to the control; it is the
//                 first-class instrument going forward.
//
// Quoting one where you mean the other is how a 786-symbol median and a
// 5000-frame median end up in the same sentence.
//
// ⛔ THIS ONLY GRADES INSIDE RTH. Post-close the feed is quiet, so a read lands a
// handful of frames and produces a p50 that looks exactly like an RTH one — the
// first live run of this script, at 21:47Z, printed p50=918ms off n=63 and would
// have read as "the cap nearly fixed it". Outside 13:30-20:00Z Mon-Fri, and below
// MIN_GRADED_ROWS, the verdict is BLIND, never PASS and never FAIL.
//
// Usage:
//   node scripts/tra4782-grade-stream-latency.mjs                       # one read
//   node scripts/tra4782-grade-stream-latency.mjs --samples=4 --gap=30  # 4 reads, 30s apart
//   node scripts/tra4782-grade-stream-latency.mjs --json
//   node scripts/tra4782-grade-stream-latency.mjs --allow-outside-rth   # print, still BLIND
//
// Auth: TRADING_ADMIN_USERNAME / TRADING_ADMIN_PASSWORD (the route is requireAuth).
// Host: --host=, else TRA4782_HOST, else the bqb1 production host.
//
// Exit codes — "could not measure" and "measured and it is fine" never share one:
//   0 PASS   p50 under the 500ms budget
//   1 FAIL   p50 over the budget (this is a RESULT, not an error)
//   2 usage
//   3 BLIND  unreachable, unauthenticated, disabled, or nothing quoting

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';
const AC_BUDGET_MS = 500;
/**
 * Below this many gradeable per-symbol rows the median is noise, not a verdict —
 * UNLESS the subscription itself is smaller. The experiment arm is N=25 BY DESIGN
 * (the issue prescribes it), so an absolute 50 structurally refuses the exact arm
 * this script exists to grade: the first in-RTH capped run read BLIND at 25/25
 * quoted, which is EXHAUSTIVE coverage of the subscribed population, not a thin
 * read. The bar is therefore min(50, subscribed). Post-close thinness is still
 * caught by the RTH refusal above, and an early-open capped read with only 10 of
 * 25 quoting still refuses.
 */
const MIN_GRADED_ROWS = 50;
/**
 * The 09-22 uncapped RTH control (p50 35.6–46.1s; the low end, conservatively).
 * The experiment's BRANCH turns on collapse vs persistence against THIS — whose
 * backlog is it — not on the AC budget. A 708ms read is an AC FAIL and still a
 * 50x collapse; printing "vendor-side, board decision" off it would misname the
 * cause. The branch and the AC are different questions.
 */
const CONTROL_P50_MS = 35_600;

function usage(msg) {
  if (msg) console.error(`[tra4782] ${msg}`);
  console.error(`usage: node scripts/tra4782-grade-stream-latency.mjs [--host=URL] [--samples=N] [--gap=SECONDS] [--json] [--allow-outside-rth]`);
  process.exit(2);
}

/** RTH is 13:30-20:00Z Mon-Fri (the same window the deploy freeze is written in). */
function rthState(d = new Date()) {
  const day = d.getUTCDay();
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const weekday = day >= 1 && day <= 5;
  const inWindow = minutes >= 13 * 60 + 30 && minutes < 20 * 60;
  return { open: weekday && inWindow, label: `${d.toISOString().slice(11, 16)}Z ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]}` };
}

// Flags match NEGATIVELY (TRA-4420): an unrecognised flag is an error, never a
// silently-ignored one that lets the run proceed meaning something else.
const opts = { host: process.env['TRA4782_HOST'] || DEFAULT_HOST, samples: 1, gap: 30, json: false, allowOutsideRth: false };
for (const arg of process.argv.slice(2)) {
  if (arg === '--json') { opts.json = true; continue; }
  if (arg === '--allow-outside-rth') { opts.allowOutsideRth = true; continue; }
  if (arg === '--help' || arg === '-h') usage();
  const m = /^--(host|samples|gap)=(.+)$/.exec(arg);
  if (!m) usage(`unrecognised argument ${JSON.stringify(arg)} — values attach with '='`);
  if (m[1] === 'host') opts.host = m[2];
  else {
    const n = Number(m[2]);
    if (!Number.isInteger(n) || n < 1) usage(`--${m[1]} must be an integer >= 1, got ${JSON.stringify(m[2])}`);
    opts[m[1]] = n;
  }
}
opts.host = opts.host.replace(/\/$/, '');

function blind(reason) {
  console.error(`[tra4782] BLIND — ${reason}`);
  process.exit(3);
}

/** Nearest-rank percentile. `null` on an empty set — an unmeasured percentile is not 0. */
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))];
}

async function login() {
  const username = process.env['TRADING_ADMIN_USERNAME'];
  const password = process.env['TRADING_ADMIN_PASSWORD'];
  if (!username || !password) blind('TRADING_ADMIN_USERNAME / TRADING_ADMIN_PASSWORD are not set');
  const r = await fetch(`${opts.host}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch((e) => blind(`login request failed: ${e.message}`));
  if (!r.ok) blind(`login returned HTTP ${r.status}`);
  const token = (await r.json())?.token;
  if (!token) blind('login returned no token');
  return token;
}

async function readStream(token) {
  const r = await fetch(`${opts.host}/api/market-data/stream`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch((e) => blind(`stream read failed: ${e.message}`));
  if (!r.ok) blind(`/api/market-data/stream returned HTTP ${r.status}`);
  const p = await r.json();
  if (p?.enabled !== true) blind(`stream is disabled (reason: ${p?.reason ?? 'unknown'}) — nothing to grade`);
  return p;
}

/**
 * The per-symbol arm. The 09-22 control's method, with one correction the control
 * could not make: rows whose exchange stamp is beyond the feed's sanity bound are
 * SEGREGATED, not averaged in. A halted book is not a late feed.
 *
 * `staleEventTime` is three-valued. Absent means the server predates the field —
 * we then fall back to the bound and SAY we did, rather than treating absent as
 * false, which would fold the halted books straight back in.
 */
function gradePerSymbol(payload) {
  const boundMs = typeof payload.latencySanityBoundMs === 'number' ? payload.latencySanityBoundMs : 600_000;
  const boundSource = typeof payload.latencySanityBoundMs === 'number' ? 'server' : 'client-default (server did not publish it)';
  const quoted = payload.symbols.filter((r) => !r.neverQuoted && typeof r.latencyMs === 'number');
  const isSegregated = (r) => (typeof r.staleEventTime === 'boolean' ? r.staleEventTime : Math.abs(r.latencyMs) > boundMs);
  const segregated = quoted.filter(isSegregated);
  const graded = quoted.filter((r) => !isSegregated(r)).map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    boundMs,
    boundSource,
    subscribed: payload.symbols.length,
    quoted: quoted.length,
    segregated: segregated.length,
    segregatedTop: segregated.sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 5).map((r) => `${r.symbol}=${(r.latencyMs / 86_400_000).toFixed(1)}d`),
    graded: graded.length,
    p50: percentile(graded, 0.5),
    p95: percentile(graded, 0.95),
    underBudget: graded.filter((v) => v <= AC_BUDGET_MS).length,
  };
}

const rth = rthState();
if (!rth.open && !opts.allowOutsideRth) {
  blind(`${rth.label} is outside RTH (13:30-20:00Z Mon-Fri). The feed is quiet, so a p50 here is a handful of frames ` +
    `and reads identically to an RTH grade — the first live run printed p50=918ms off n=63 at 21:47Z. ` +
    `Re-run inside the window, or pass --allow-outside-rth to print the numbers (the verdict stays BLIND).`);
}

const token = await login();
const reads = [];
for (let i = 0; i < opts.samples; i++) {
  if (i > 0) await new Promise((r) => setTimeout(r, opts.gap * 1000));
  const payload = await readStream(token);
  reads.push({ at: new Date().toISOString(), payload, perSymbol: gradePerSymbol(payload) });
}

const last = reads[reads.length - 1];
const p = last.payload;
const capped = typeof p.symbolLimit === 'number';
// The per-symbol p50 across reads is what the branch turns on; a single read can
// catch a burst, and the control itself drifted 41.4 -> 35.6s over 101 seconds.
const p50s = reads.map((r) => r.perSymbol.p50).filter((v) => v != null);
if (p50s.length === 0) blind('no symbol quoted with a gradeable exchange stamp — the market may be closed');
const worstP50 = Math.max(...p50s);
// A thin read is BLIND, not a verdict. Both directions matter: a thin FAIL is an
// accusation off noise, and a thin PASS closes the ticket on nothing. "Thin" is
// relative to the subscribed population: a capped run's ceiling IS the cap.
const minRowsFor = (r) => Math.min(MIN_GRADED_ROWS, r.perSymbol.subscribed);
const thinRead = reads.find((r) => r.perSymbol.graded < minRowsFor(r));
const gradeable = rth.open && !thinRead;
const verdict = !gradeable ? 'BLIND' : worstP50 <= AC_BUDGET_MS ? 'PASS' : 'FAIL';
const blindReason = gradeable ? null
  : !rth.open ? `outside RTH (${rth.label}) — forced with --allow-outside-rth`
  : `a read has only ${thinRead.perSymbol.graded} gradeable rows of ${minRowsFor(thinRead)} required (subscribed=${thinRead.perSymbol.subscribed})`;
// The branch: whose backlog was the 40s? Collapse ≥10x vs the control names our
// fan-out; persistence at ≥half the control names the vendor; in between, say
// "partial collapse" rather than guess a side.
const branch = !gradeable ? null
  : !capped ? 'uncapped-control'
  : worstP50 <= CONTROL_P50_MS / 10 ? 'our-fanout'
  : worstP50 >= CONTROL_P50_MS / 2 ? 'vendor-side'
  : 'partial-collapse';

if (opts.json) {
  console.log(JSON.stringify({ verdict, branch, blindReason, rth: rth.open, acBudgetMs: AC_BUDGET_MS, controlP50Ms: CONTROL_P50_MS, worstP50, capped, reads: reads.map((r) => ({ at: r.at, perSymbol: r.perSymbol, feed: {
    latencyP50Ms: r.payload.latencyP50Ms, latencyP95Ms: r.payload.latencyP95Ms, latencySampleSize: r.payload.latencySampleSize,
    quotesReceived: r.payload.quotesReceived, quotesLatencyGraded: r.payload.quotesLatencyGraded,
    quotesWithStaleEventTime: r.payload.quotesWithStaleEventTime, quotesWithFutureEventTime: r.payload.quotesWithFutureEventTime,
    maxLatencyMs: r.payload.maxLatencyMs,
  }, cap: { symbolLimit: r.payload.symbolLimit ?? null, symbolLimitRaw: r.payload.symbolLimitRaw ?? null, symbolLimitError: r.payload.symbolLimitError ?? null,
    subscribedSymbols: r.payload.subscribedSymbols, symbolsBeforeLimit: r.payload.symbolsBeforeLimit ?? null } } )) }, null, 2));
} else {
  const cell = (v) => (v === undefined ? 'not published' : v === null ? 'no sample' : `${v}ms`);
  console.log(`host      : ${opts.host}  state=${p.state}`);
  console.log(`cap       : ${capped ? `TRADIER_STREAM_SYMBOL_LIMIT=${p.symbolLimit}` : 'NONE (full fleet union)'}` +
    `  subscribed=${p.subscribedSymbols}` + (p.symbolsBeforeLimit == null ? '' : ` of ${p.symbolsBeforeLimit}`) +
    (p.symbolLimitError ? `  ⚠ ${p.symbolLimitError}` : ''));
  for (const r of reads) {
    const s = r.perSymbol;
    console.log(`\nread ${r.at}`);
    console.log(`  PER-SYMBOL  p50=${s.p50}ms p95=${s.p95}ms   graded=${s.graded}/${s.quoted} quoted   under ${AC_BUDGET_MS}ms: ${s.underBudget}`);
    console.log(`  segregated  ${s.segregated} rows beyond ±${s.boundMs}ms [${s.boundSource}]${s.segregatedTop.length ? `  top: ${s.segregatedTop.join(' ')}` : ''}`);
    console.log(`  FEED SAMPLE p50=${cell(r.payload.latencyP50Ms)} p95=${cell(r.payload.latencyP95Ms)} n=${r.payload.latencySampleSize ?? 'not published'}  (frame-weighted; NOT comparable to the control)`);
    console.log(`  counters    received=${r.payload.quotesReceived} graded=${r.payload.quotesLatencyGraded ?? 'not published'} staleStamp=${r.payload.quotesWithStaleEventTime ?? 'not published'} future=${r.payload.quotesWithFutureEventTime ?? 'not published'} max=${cell(r.payload.maxLatencyMs)}`);
  }
  console.log(`\nVERDICT   : ${verdict} — worst per-symbol p50 across ${reads.length} read(s) = ${worstP50}ms vs the ${AC_BUDGET_MS}ms AC`);
  if (!gradeable) {
    console.log(`BRANCH    : NOT GRADED — ${blindReason}. These numbers are printed, not believed.`);
  } else if (branch === 'uncapped-control') {
    console.log(`BRANCH    : UNCAPPED — this read is the control arm, not the experiment. Set TRADIER_STREAM_SYMBOL_LIMIT and re-deploy.`);
  } else {
    console.log(`BRANCH    : ${{
      'our-fanout': `capped and p50 collapsed ${(CONTROL_P50_MS / worstP50).toFixed(0)}x vs the ${CONTROL_P50_MS}ms control ⇒ the 40s backlog was OUR 822-symbol fan-out / consumer backpressure. Remedy: a bounded subscription.`,
      'vendor-side': `capped AND p50 still at ≥half the ${CONTROL_P50_MS}ms control ⇒ the cause is VENDOR-SIDE on /markets/events. AC #1 is not reachable on this path as configured — board decision.`,
      'partial-collapse': `capped and p50 fell to ${worstP50}ms — under half the ${CONTROL_P50_MS}ms control but not a ≥10x collapse. PARTIAL: name it, don't guess a side.`,
    }[branch]}`);
    console.log(`AC #1     : ${verdict} at N=${p.symbolLimit} — worst per-symbol p50 ${worstP50}ms vs the ${AC_BUDGET_MS}ms budget. The branch and the AC are different questions; this line is the AC's.`);
  }
}

process.exit(verdict === 'BLIND' ? 3 : verdict === 'PASS' ? 0 : 1);
