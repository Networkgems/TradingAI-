#!/usr/bin/env node
/**
 * TRA-4986 — grade the candle hoist off `GET /api/health/heap-census?deep=true`.
 *
 * Four separate verdicts, and they are deliberately NOT collapsed into one
 * boolean, because three of the four can pass while the fourth is unmeasurable:
 *
 *  - **AC2 (structure)** — `signalEngine.candleCache` ABSENT **and**
 *    `marketData.minuteCandles` PRESENT with `owners == 1`, **in the same read**.
 *    The shipped hoist makes `candleCache` a prototype accessor, and the census
 *    walks own enumerable DATA properties, so it emits no row at all. A check
 *    written for `owners == 0` refuses a hoist that worked — that is the
 *    discriminator TRA-4158 had to correct and it is encoded here, once.
 *  - **AC1 (soundness)** — `census.candleShare.divergentSameInstant`. Non-zero
 *    means two callers genuinely disagreed about one symbol at one instant,
 *    which is the only shape under which one shared copy could be wrong for
 *    somebody. Reported with its witness.
 *  - **AC3 (bound)** — the `signalEngine.dynamicSymbols` ring ratio, plus
 *    whether the row carries a published `note`. ⚠️ A quiet-day `ratio 1.00` is
 *    VACUOUS: the measured growth lands overnight in the premarket slot, so a
 *    ring with no premarket build in it cannot discriminate a working bound from
 *    a day nothing was added. This grades the note, and reports the ratio WITH
 *    whether the ring covered a premarket slot.
 *  - **AC4 (the fold)** — matched-quiescent `heapUsed` before vs after.
 *
 * ## The AC4 category error this refuses to commit
 *
 * TRA-4158's AC2 clause exists because differencing a quiescent arm against an
 * in-session read measures the session, not the fix. So the window is verified
 * **market-shut at every sample it keeps**, by construction: a sample inside
 * 13:30–20:00Z on a Mon–Fri is grounds to REFUSE (exit 3 BLIND), never to
 * silently drop. Same for the warm-cache premise — a post arm whose boot has no
 * RTH session behind it has COLD caches and reads clean for the wrong reason, so
 * the arm must carry at least one RTH session since `startedAt`.
 *
 * Exit codes follow the repo convention: `0` PASS · `1` FAIL · `2` usage ·
 * `3` BLIND. BLIND > FAIL > PASS — "could not measure" must never share an exit
 * code with "measured and it is fine".
 *
 *   node scripts/tra4986-quiescent-grade.mjs                     # live read, auto window
 *   node scripts/tra4986-quiescent-grade.mjs --from=<Z> --to=<Z>  # pin the window
 *   node scripts/tra4986-quiescent-grade.mjs --census=<file.json> # grade a saved read
 *   node scripts/tra4986-quiescent-grade.mjs --selftest           # the controls
 */

import { readFileSync, existsSync } from 'node:fs';

const DEFAULT_BASE = 'https://tradingai-bqb1.onrender.com';
const BEFORE_ARM = 'reports/tra4986-quiescent-before-20261001.json';

const RTH_OPEN_MIN = 13 * 60 + 30; // 13:30Z
const RTH_CLOSE_MIN = 20 * 60; //     20:00Z

/** True when `ms` falls inside US equity RTH, i.e. the market is OPEN. */
export function isRthInstant(ms) {
  const d = new Date(ms);
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  if (dow === 0 || dow === 6) return false;
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return min >= RTH_OPEN_MIN && min < RTH_CLOSE_MIN;
}

/** Ordinary least squares slope of y over x, or null when undetermined. */
export function olsSlope(xs, ys) {
  if (xs.length < 2) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

/**
 * AC2, as ONE function so the discriminator cannot be re-derived differently by
 * a future reader. `live` is the census's own `live` row array.
 */
export function gradeStructure(live) {
  if (!Array.isArray(live)) {
    return { verdict: 'BLIND', reason: 'census.live is not an array — the instrument did not report' };
  }
  const perEngine = live.find((r) => r.name === 'signalEngine.candleCache');
  const shared = live.find((r) => r.name === 'marketData.minuteCandles');
  // The read has to be able to SEE signalEngine at all, or an absent per-engine
  // row is the instrument going blind rather than the hoist having landed.
  const sawEngines = live.some((r) => r.name.startsWith('signalEngine.') && r.owners > 0);
  if (!sawEngines) {
    return { verdict: 'BLIND', reason: 'no signalEngine row with owners>0 — cannot tell "moved" from "stopped looking"' };
  }
  if (perEngine) {
    return {
      verdict: 'FAIL',
      reason: `signalEngine.candleCache is STILL PRESENT (owners ${perEngine.owners}, entries ${perEngine.entries}) — the hoist is not live`,
      perEngine,
    };
  }
  if (!shared) {
    // signalEngine rows ARE visible (checked above), so the instrument is not
    // blind — the replacement subject simply is not registered. That is a real
    // failure: without it, the absent per-engine row proves nothing.
    return { verdict: 'FAIL', reason: 'marketData.minuteCandles is ABSENT while signalEngine rows are visible — the replacement census subject is not wired, so the absent per-engine row proves nothing' };
  }
  if (shared.owners !== 1) {
    return { verdict: 'FAIL', reason: `marketData.minuteCandles owners is ${shared.owners}, expected exactly 1`, shared };
  }
  return {
    verdict: 'PASS',
    reason: 'per-engine row ABSENT and marketData.minuteCandles PRESENT with owners 1, in the same read',
    shared,
  };
}

/** Keep only samples at which the market was shut. Refuses rather than drops. */
export function quiescentWindow(tape, fromMs, toMs) {
  const inRange = tape.filter((s) => s.atMs >= fromMs && s.atMs <= toMs);
  if (inRange.length < 2) {
    return { verdict: 'BLIND', reason: `only ${inRange.length} sample(s) in the requested window` };
  }
  const open = inRange.filter((s) => isRthInstant(s.atMs));
  if (open.length > 0) {
    return {
      verdict: 'BLIND',
      reason:
        `${open.length} of ${inRange.length} samples are INSIDE RTH `
        + `(first ${new Date(open[0].atMs).toISOString()}) — differencing a quiescent arm against an `
        + 'in-session read measures the session, not the fix (TRA-4158 AC2 clause). Narrow the window.',
    };
  }
  return { verdict: 'PASS', samples: inRange };
}

/** The widest market-shut run at the END of the tape — the default window. */
export function autoQuiescentWindow(tape) {
  let i = tape.length - 1;
  while (i >= 0 && isRthInstant(tape[i].atMs)) i -= 1; // skip a live session at the tail
  const end = i;
  while (i >= 0 && !isRthInstant(tape[i].atMs)) i -= 1;
  const start = i + 1;
  if (end < start) return null;
  return { fromMs: tape[start].atMs, toMs: tape[end].atMs };
}

function stats(samples, key) {
  const v = samples.map((s) => s[key]);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    mean: Math.round(mean * 10) / 10,
    min: Math.min(...v),
    max: Math.max(...v),
  };
}

function fmt(n) {
  return n === null || n === undefined ? 'n/a' : String(n);
}

async function readCensus(args) {
  if (args.census) {
    if (!existsSync(args.census)) throw new Error(`--census file not found: ${args.census}`);
    return JSON.parse(readFileSync(args.census, 'utf-8'));
  }
  const base = args.base ?? process.env.TRADING_API_BASE ?? DEFAULT_BASE;
  const url = `${base.replace(/\/$/, '')}/api/health/heap-census?deep=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === '--selftest') { out.selftest = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m) {
      // Positive matching was the TRA-4420 defect. Anything unrecognised is loud.
      throw new Error(`unrecognised argument ${JSON.stringify(a)} — values attach with '='`);
    }
    out[m[1].replace(/-(.)/g, (_, c) => c.toUpperCase())] = m[2];
  }
  return out;
}

function selftest() {
  const fails = [];
  const check = (name, cond) => { if (!cond) fails.push(name); };

  // RTH predicate
  check('Thu 14:00Z is RTH', isRthInstant(Date.parse('2026-10-01T14:00:00Z')));
  check('Thu 20:00Z is NOT RTH (close is exclusive)', !isRthInstant(Date.parse('2026-10-01T20:00:00Z')));
  check('Thu 13:29Z is NOT RTH', !isRthInstant(Date.parse('2026-10-01T13:29:00Z')));
  check('Sat 15:00Z is NOT RTH', !isRthInstant(Date.parse('2026-10-03T15:00:00Z')));

  // AC2 — the discriminator, in BOTH directions
  check('AC2 PASS on absent+present(1)', gradeStructure([
    { name: 'signalEngine.symbolState', owners: 68, entries: 6800 },
    { name: 'marketData.minuteCandles', owners: 1, entries: 150 },
  ]).verdict === 'PASS');
  check('AC2 FAIL when the per-engine row is still there', gradeStructure([
    { name: 'signalEngine.candleCache', owners: 68, entries: 6608 },
    { name: 'marketData.minuteCandles', owners: 1, entries: 150 },
  ]).verdict === 'FAIL');
  // ⭐ The control that matters: both rows gone is BLIND, not PASS. An
  // instrument that stopped looking must never grade as a successful hoist.
  check('AC2 FAIL when BOTH rows are gone', gradeStructure([
    { name: 'signalEngine.symbolState', owners: 68, entries: 6800 },
  ]).verdict === 'FAIL');
  check('AC2 BLIND when no signalEngine row is visible at all', gradeStructure([
    { name: 'marketData.minuteCandles', owners: 1, entries: 150 },
  ]).verdict === 'BLIND');
  check('AC2 FAIL on owners!=1', gradeStructure([
    { name: 'signalEngine.symbolState', owners: 68, entries: 6800 },
    { name: 'marketData.minuteCandles', owners: 2, entries: 150 },
  ]).verdict === 'FAIL');

  // The window guard refuses an in-session sample rather than dropping it
  const mixed = [
    { atMs: Date.parse('2026-10-01T12:00:00Z'), heapUsedMB: 400 },
    { atMs: Date.parse('2026-10-01T14:00:00Z'), heapUsedMB: 500 },
  ];
  check('window REFUSES a mixed arm', quiescentWindow(mixed, mixed[0].atMs, mixed[1].atMs).verdict === 'BLIND');
  const shut = [
    { atMs: Date.parse('2026-10-03T12:00:00Z'), heapUsedMB: 400 },
    { atMs: Date.parse('2026-10-03T14:00:00Z'), heapUsedMB: 410 },
  ];
  check('window ACCEPTS a weekend arm', quiescentWindow(shut, shut[0].atMs, shut[1].atMs).verdict === 'PASS');
  check('window BLIND on a 1-sample arm', quiescentWindow(shut, shut[0].atMs, shut[0].atMs).verdict === 'BLIND');

  // auto-window skips a live session at the tail
  const tail = [
    { atMs: Date.parse('2026-10-01T11:00:00Z') },
    { atMs: Date.parse('2026-10-01T12:00:00Z') },
    { atMs: Date.parse('2026-10-01T14:00:00Z') },
  ];
  const auto = autoQuiescentWindow(tail);
  check('auto window excludes the RTH tail', auto && auto.toMs === tail[1].atMs);

  check('OLS slope of a flat series is 0', olsSlope([0, 1, 2], [5, 5, 5]) === 0);
  check('OLS slope is null on one point', olsSlope([0], [5]) === null);

  if (fails.length > 0) {
    console.error('[tra4986-grade] SELFTEST FAILED:');
    for (const f of fails) console.error(`  - ${f}`);
    return 1;
  }
  console.log(`[tra4986-grade] SELFTEST OK — ${15 - fails.length} controls passed.`);
  return 0;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[tra4986-grade] ${err.message}`);
    return 2;
  }
  if (args.help) {
    console.log('usage: node scripts/tra4986-quiescent-grade.mjs [--from=<ISO Z>] [--to=<ISO Z>] [--census=<file>] [--base=<url>] [--selftest]');
    return 0;
  }
  if (args.selftest) return selftest();

  let payload;
  try {
    payload = await readCensus(args);
  } catch (err) {
    console.error(`[tra4986-grade] BLIND — could not read the census: ${err.message}`);
    return 3;
  }

  const census = payload.census ?? payload;
  const build = payload.build ?? {};
  const tape = census.tape ?? [];
  console.log(`[tra4986-grade] read ${payload.time ?? '(no time)'} — build ${build.commitShort ?? '?'} pid ${build.pid ?? '?'} startedAt ${build.startedAt ?? '?'}`);
  console.log(`[tra4986-grade] tape ${tape.length} samples, spanSec ${fmt(census.spanSec)}, deep ${census.deep === true}`);

  let worst = 0;
  const bump = (code) => { if (code > worst) worst = code; };

  // ── AC2 ────────────────────────────────────────────────────────────────────
  const structure = gradeStructure(census.live);
  console.log(`\n[AC2 structure] ${structure.verdict} — ${structure.reason}`);
  if (structure.shared) {
    console.log(`  marketData.minuteCandles: entries ${structure.shared.entries}, nested ${fmt(structure.shared.nested)}`);
    console.log('  |union| is this entries count. Pre-hoist fleet total was 6,608 over 68 owners.');
  }
  bump(structure.verdict === 'PASS' ? 0 : structure.verdict === 'FAIL' ? 1 : 3);

  // ── AC1 ────────────────────────────────────────────────────────────────────
  const share = census.candleShare;
  if (!share) {
    console.log('\n[AC1 soundness] BLIND — census.candleShare is absent (pre-TRA-4986 build)');
    bump(3);
  } else {
    const ok = share.divergentSameInstant === 0;
    console.log(`\n[AC1 soundness] ${ok ? 'PASS' : 'FAIL'} — divergentSameInstant ${share.divergentSameInstant} over ${share.rewrites} rewrites of ${share.writes} writes`);
    console.log(`  symbols(|union|) ${share.symbols} · equalByValue ${share.equalByValue} · newerSeries ${share.newerSeries} · olderSeries ${share.olderSeries} · sameReference ${share.sameReference}`);
    if (share.olderSeries > 0) {
      console.log(`  ⚠️  olderSeries ${share.olderSeries} — the backwards-write hazard IS real. This is the measured case for a monotone guard; it is not itself a failure (last-writer-wins is pre-existing semantics).`);
    }
    for (const w of share.divergentWitness ?? []) {
      console.log(`  WITNESS ${w.symbol} @${new Date(w.newestMs).toISOString()} idx ${w.atIndex} ${w.field}: held ${w.heldValue} vs incoming ${w.incomingValue} (len ${w.heldLength}/${w.incomingLength})`);
    }
    bump(ok ? 0 : 1);
  }

  // ── AC3 ────────────────────────────────────────────────────────────────────
  const dynRow = (census.live ?? []).find((r) => r.name === 'signalEngine.dynamicSymbols');
  const dynTrend = (census.trends ?? []).find((r) => r.name === 'signalEngine.dynamicSymbols');
  const hasNote = dynRow?.note != null;
  console.log(`\n[AC3 bound] ${hasNote ? 'PASS' : 'FAIL'} — published disposition ${hasNote ? 'PRESENT' : 'ABSENT'} on the census row`);
  if (hasNote) {
    console.log(`  bound: ${JSON.stringify(dynRow.note.bound)} · boundedBy: ${dynRow.note.boundedBy ?? '(none)'}`);
  }
  if (dynTrend) {
    // A premarket slot is ~11:00–13:30Z on a weekday. Without one in the ring,
    // ratio 1.00 is vacuous — the growth this row shows lands overnight.
    const coversPremarket = tape.some((s) => {
      const d = new Date(s.atMs);
      const dow = d.getUTCDay();
      const min = d.getUTCHours() * 60 + d.getUTCMinutes();
      return dow >= 1 && dow <= 5 && min >= 11 * 60 && min < RTH_OPEN_MIN;
    });
    console.log(`  ring ratio ${fmt(dynTrend.ratio)} (delta ${dynTrend.delta}, ${dynTrend.first} -> ${dynTrend.last})`);
    console.log(`  ring covers a premarket slot: ${coversPremarket} ${coversPremarket ? '' : '<-- ratio 1.00 would be VACUOUS without one'}`);
  }
  bump(hasNote ? 0 : 1);

  // ── AC4 ────────────────────────────────────────────────────────────────────
  let window = null;
  if (args.from && args.to) {
    window = { fromMs: Date.parse(args.from), toMs: Date.parse(args.to) };
    if (Number.isNaN(window.fromMs) || Number.isNaN(window.toMs)) {
      console.error('\n[AC4 fold] BLIND — --from/--to must be parseable ISO instants ending in Z');
      return 3;
    }
  } else {
    window = autoQuiescentWindow(tape);
    if (!window) {
      console.log('\n[AC4 fold] BLIND — no market-shut run in the tape');
      bump(3);
    }
  }

  if (window) {
    const q = quiescentWindow(tape, window.fromMs, window.toMs);
    if (q.verdict !== 'PASS') {
      console.log(`\n[AC4 fold] BLIND — ${q.reason}`);
      bump(3);
    } else {
      const s = q.samples;
      const spanH = (s[s.length - 1].atMs - s[0].atMs) / 3.6e6;
      const bootMs = build.startedAt ? Date.parse(build.startedAt) : null;
      const heap = stats(s, 'heapUsedMB');
      const rss = stats(s, 'rssMB');
      const t0 = s[0].atMs;
      const slope = olsSlope(s.map((x) => (x.atMs - t0) / 3.6e6), s.map((x) => x.heapUsedMB));

      // Warm-cache premise: the arm needs at least one RTH session behind the boot.
      let warm = null;
      if (bootMs !== null) {
        warm = false;
        for (let t = bootMs; t < s[0].atMs; t += 15 * 60_000) {
          if (isRthInstant(t)) { warm = true; break; }
        }
      }

      console.log(`\n[AC4 fold] AFTER arm — ${new Date(s[0].atMs).toISOString()} -> ${new Date(s[s.length - 1].atMs).toISOString()}`);
      console.log(`  n ${s.length}, span ${spanH.toFixed(2)}h, market shut throughout (verified per-sample)`);
      if (bootMs !== null) {
        console.log(`  uptime class ${((s[0].atMs - bootMs) / 3.6e6).toFixed(2)}h -> ${((s[s.length - 1].atMs - bootMs) / 3.6e6).toFixed(2)}h`);
      }
      console.log(`  caches warm (an RTH session since boot): ${warm === null ? 'UNKNOWN' : warm}`);
      console.log(`  heapUsed mean ${heap.mean} MB (min ${heap.min} / max ${heap.max})`);
      console.log(`  rss      mean ${rss.mean} MB (min ${rss.min} / max ${rss.max})`);
      console.log(`  OLS slope ${slope === null ? 'n/a' : slope.toFixed(3)} MB/h`);

      if (warm === false) {
        console.log('  ⚠️  BLIND for AC4: no RTH session between boot and this arm — cold caches read clean for the WRONG REASON.');
        bump(3);
      }

      if (existsSync(BEFORE_ARM)) {
        const before = JSON.parse(readFileSync(BEFORE_ARM, 'utf-8'));
        const d = heap.mean - before.heapUsedMB.mean;
        console.log(`\n  BEFORE arm (${BEFORE_ARM}): ${before.window.fromZ} -> ${before.window.toZ}, n ${before.window.n}, ${before.window.spanH}h`);
        console.log(`    build ${before.build} · uptime ${before.uptimeClassH.at}h -> ${before.uptimeClassH.to}h · heapUsed mean ${before.heapUsedMB.mean} MB`);
        console.log(`\n  MATCHED-QUIESCENT FOLD: ${d >= 0 ? '+' : ''}${d.toFixed(1)} MB heapUsed (${before.heapUsedMB.mean} -> ${heap.mean})`);
        console.log(`    rss: ${(rss.mean - before.rssMB.mean >= 0 ? '+' : '')}${(rss.mean - before.rssMB.mean).toFixed(1)} MB (${before.rssMB.mean} -> ${rss.mean})`);
        if (before.build === (build.commitShort ?? '')) {
          console.log('    ⚠️  BLIND: both arms are the SAME build — this differences two reads of one binary, not the fix.');
          bump(3);
        }
      } else {
        console.log(`\n  BLIND for the fold — BEFORE arm ${BEFORE_ARM} not found`);
        bump(3);
      }
    }
  }

  const label = worst === 0 ? 'PASS' : worst === 1 ? 'FAIL' : 'BLIND';
  console.log(`\n[tra4986-grade] ${label} (exit ${worst}) — BLIND > FAIL > PASS`);
  return worst;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`[tra4986-grade] BLIND — unhandled: ${err?.stack ?? err}`);
  process.exit(3);
});
