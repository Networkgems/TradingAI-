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

/**
 * ⛔ The SUBJECT of this grade is one host, and it is not negotiable by
 * environment. The BEFORE arm is a bqb1 read (`faae938837bf`, pid 76), so an
 * AFTER arm from anywhere else is a cross-HOST difference — the same category
 * error as a cross-population one, one layer out.
 *
 * This script deliberately does NOT honour `TRADING_API_BASE`. That variable
 * flips (it was `http://localhost:4242` on this box at 2026-10-02T00:45Z), and
 * the first run of this grader consequently read a 3-engine 73 MB dev process
 * and lined it up against a 68-engine 1,698 MB production arm. The population
 * gate caught it, which is luck: `--base=` is explicit or the default applies.
 */
const SUBJECT_HOST = 'https://tradingai-bqb1.onrender.com';
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

/**
 * The POPULATION the read was taken at — the number of per-user engines.
 *
 * Read off `signalEngine.*` owners and deliberately NOT as a max over all rows:
 * the whole point of the hoist is that `marketData.minuteCandles` is `owners: 1`
 * by design, so folding it in would peg the roster at 1 the moment the fix lands
 * and silently match a 4-context arm against a 68-context one.
 *
 * Max over the class rather than any single row: not every engine has every
 * property populated at every instant, so one row's `owners` can undercount the
 * fleet while the class maximum cannot.
 *
 * Returns `null` — never a number — when no `signalEngine.*` row is present.
 * "Could not read the roster" is its own value and must not join a fold.
 */
export function rosterOf(live) {
  if (!Array.isArray(live)) return null;
  const owners = live
    .filter((r) => typeof r?.name === 'string' && r.name.startsWith('signalEngine.'))
    .map((r) => r.owners)
    .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
  return owners.length === 0 ? null : Math.max(...owners);
}

/**
 * The same read off a SAVED arm. The before-arm report stores its rows as a
 * `liveDeep` object keyed by name rather than as the census's array, so the
 * array reader above cannot be pointed at it.
 */
export function rosterOfSavedArm(before) {
  if (before && typeof before.population === 'number' && before.population > 0) {
    return before.population;
  }
  const deep = before?.liveDeep;
  if (!deep || typeof deep !== 'object') return null;
  // `liveDeep` is keyed FLAT by full row name (`"signalEngine.candleCache"`),
  // which is indistinguishable from a nested `{signalEngine: {candleCache: …}}`
  // in a dotted-path dump — the reason the first version of this read returned
  // null against a report that plainly carried `owners: 68`. Accept both shapes.
  const rows = [];
  for (const [key, value] of Object.entries(deep)) {
    if (!value || typeof value !== 'object') continue;
    if (typeof value.owners === 'number') {
      rows.push({ name: typeof value.name === 'string' ? value.name : key, owners: value.owners });
      continue;
    }
    for (const [innerKey, row] of Object.entries(value)) {
      if (!row || typeof row !== 'object' || typeof row.owners !== 'number') continue;
      // A nested row's own `name` may be short (`"symbolState"`) or already
      // qualified (`"signalEngine.symbolState"`). Compose from the keys unless
      // it is already qualified, or the class prefix is lost and the row is
      // silently dropped by the `signalEngine.` filter.
      const qualified = typeof row.name === 'string' && row.name.includes('.')
        ? row.name
        : `${key}.${innerKey}`;
      rows.push({ name: qualified, owners: row.owners });
    }
  }
  return rosterOf(rows);
}

/**
 * ⭐ AC4's refusal, as one function.
 *
 * TRA-4902 deregistered 64 QA accounts at 2026-10-01T19:53Z and `destroyUserContext`
 * tore down 64 per-user contexts on the LIVE process with no restart. So the
 * same-build guard below is NOT sufficient: two arms can differ in BUILD and in
 * ROSTER at once, and a hoist whose entire saving is `(N-1)/N` of a duplicated
 * container reads as a spectacular win when N itself collapsed underneath it.
 *
 * A drop across a population change is not evidence the fix works, and a flat
 * reading is not evidence it does not. Both are BLIND, and `null` on either side
 * is BLIND too — a roster we could not read never joins an arm that we could.
 */
export function foldVerdict({ beforePopulation, afterPopulation }) {
  if (beforePopulation === null || beforePopulation === undefined) {
    return { verdict: 'BLIND', reason: 'could not read the BEFORE arm population — a fold needs both rosters, and null is its own value' };
  }
  if (afterPopulation === null || afterPopulation === undefined) {
    return { verdict: 'BLIND', reason: 'could not read the AFTER arm population — a fold needs both rosters, and null is its own value' };
  }
  if (beforePopulation !== afterPopulation) {
    return {
      verdict: 'BLIND',
      reason:
        `CROSS-POPULATION fold refused: BEFORE arm is ${beforePopulation} engines, AFTER arm is ${afterPopulation}. `
        + 'The hoist saves (N-1)/N of one container, so a roster change moves this number on its own '
        + '(TRA-4902 took bqb1 68 -> 4 at 2026-10-01T19:53Z with no restart). A drop here would not be '
        + 'evidence the fix works and a flat reading would not be evidence it does not. Match the roster '
        + 'or grade AC2 structurally instead.',
    };
  }
  return { verdict: 'PASS', reason: `both arms at ${beforePopulation} engines — population matched` };
}

/**
 * How much of the FILED lever survives at a different roster, from the arms'
 * own numbers rather than from a constant.
 *
 * The hoist eliminates `(N-1)` of `N` copies of a per-engine container, so the
 * absolute bytes it returns scale as `(N-1)` — not as `(N-1)/N`, which is the
 * share and is almost 1 at both 68 and 4. Both are reported because quoting the
 * share alone is how a 22x shrinkage reads as "75% vs 98%, basically the same".
 */
export function leverScaling(filedPopulation, nowPopulation) {
  if (!filedPopulation || !nowPopulation || nowPopulation < 1) return null;
  // A single-engine filed roster had NOTHING duplicated, so the lever it is
  // being scaled against is undefined rather than zero. Returning a row whose
  // `absoluteLeverRetained` is null would print as "0.0%" at the call site —
  // a precise-looking claim about a quantity that does not exist.
  if (filedPopulation < 2) return null;
  const filedCopies = filedPopulation - 1;
  const nowCopies = nowPopulation - 1;
  return {
    filedPopulation,
    nowPopulation,
    filedCopiesEliminated: filedCopies,
    nowCopiesEliminated: nowCopies,
    shareOfContainerFiled: filedCopies / filedPopulation,
    shareOfContainerNow: nowCopies / nowPopulation,
    absoluteLeverRetained: nowCopies / filedCopies,
  };
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

/** The host this run actually read, normalised. `null` for a saved census. */
export function resolveBase(args) {
  if (args.census) return null;
  return (args.base ?? SUBJECT_HOST).replace(/\/$/, '');
}

async function readCensus(args) {
  if (args.census) {
    if (!existsSync(args.census)) throw new Error(`--census file not found: ${args.census}`);
    return JSON.parse(readFileSync(args.census, 'utf-8'));
  }
  const url = `${resolveBase(args)}/api/health/heap-census?deep=true`;
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
  let ran = 0;
  // Counted rather than hand-totalled: the old literal would have kept printing
  // "15 controls passed" after this suite grew, which is a green that stops
  // tracking what it covers.
  const check = (name, cond) => { ran += 1; if (!cond) fails.push(name); };

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

  // ── population, the TRA-4902 confound ─────────────────────────────────────
  check('roster is the MAX over signalEngine.* owners', rosterOf([
    { name: 'signalEngine.symbolState', owners: 4 },
    { name: 'signalEngine.dynamicSymbols', owners: 3 },
    { name: 'marketData.minuteCandles', owners: 1 },
  ]) === 4);
  // ⭐ The control that defines the reader: the hoisted store must NOT drag the
  // roster to 1, or every post-fix arm matches every pre-fix arm.
  check('roster IGNORES the owners:1 hoisted store', rosterOf([
    { name: 'marketData.minuteCandles', owners: 1 },
    { name: 'signalEngine.symbolState', owners: 68 },
  ]) === 68);
  check('roster is NULL when no signalEngine row is present', rosterOf([
    { name: 'marketData.minuteCandles', owners: 1 },
  ]) === null);
  check('roster is NULL on a non-array', rosterOf(null) === null);
  check('roster off a saved arm reads liveDeep', rosterOfSavedArm({
    liveDeep: { signalEngine: { symbolState: { name: 'symbolState', owners: 68 } } },
  }) === 68);
  check('roster off a saved arm prefers an explicit population', rosterOfSavedArm({
    population: 68,
    liveDeep: { signalEngine: { symbolState: { name: 'symbolState', owners: 4 } } },
  }) === 68);

  check('fold PASSES when both rosters match', foldVerdict({ beforePopulation: 68, afterPopulation: 68 }).verdict === 'PASS');
  // ⭐ The incident control: 68 -> 4 must REFUSE, not report a win.
  check('fold REFUSES 68 -> 4 (the TRA-4902 teardown)', foldVerdict({ beforePopulation: 68, afterPopulation: 4 }).verdict === 'BLIND');
  check('fold REFUSES a roster GROWING too (4 -> 68)', foldVerdict({ beforePopulation: 4, afterPopulation: 68 }).verdict === 'BLIND');
  check('fold REFUSES a null BEFORE roster', foldVerdict({ beforePopulation: null, afterPopulation: 4 }).verdict === 'BLIND');
  check('fold REFUSES a null AFTER roster', foldVerdict({ beforePopulation: 68, afterPopulation: null }).verdict === 'BLIND');

  // The scaling has to make the ABSOLUTE collapse visible, not the share.
  const scale = leverScaling(68, 4);
  check('lever scaling: 3 of 67 copies survive', scale.nowCopiesEliminated === 3 && scale.filedCopiesEliminated === 67);
  check('lever scaling: absolute lever retained is ~4.5%', Math.abs(scale.absoluteLeverRetained - 3 / 67) < 1e-12);
  // ⭐ The share barely moves while the absolute lever falls 22x — the exact
  // misreading this function exists to prevent.
  check('lever scaling: the SHARE stays high (98.5% -> 75%)', scale.shareOfContainerFiled > 0.98 && scale.shareOfContainerNow === 0.75);
  check('lever scaling is null at a 0 roster', leverScaling(0, 4) === null);
  check('lever scaling is null at a 1-engine filed roster', leverScaling(1, 4) === null);

  // ⭐ The flat-vs-nested control. The first version of this read returned null
  // against the real report, which the fold then refused for the RIGHT reason
  // with the WRONG cause — a refusal that hides a reader bug is not a pass.
  check('saved-arm roster reads the FLAT liveDeep shape the report actually uses', rosterOfSavedArm({
    liveDeep: {
      'signalEngine.dynamicSymbols': { name: 'signalEngine.dynamicSymbols', owners: 68 },
      'marketData.dailyCloses': { name: 'marketData.dailyCloses', owners: 1 },
    },
  }) === 68);
  check('saved-arm roster still reads a NESTED liveDeep', rosterOfSavedArm({
    liveDeep: { signalEngine: { symbolState: { name: 'signalEngine.symbolState', owners: 12 } } },
  }) === 12);
  check('saved-arm roster is NULL with no liveDeep', rosterOfSavedArm({}) === null);
  // The real report on disk must be readable — a fixture passing while the
  // artifact it models does not is the whole defect above.
  if (existsSync(BEFORE_ARM)) {
    const arm = JSON.parse(readFileSync(BEFORE_ARM, 'utf-8'));
    check('the REAL before-arm report yields a population', rosterOfSavedArm(arm) === 68);
    check('the REAL before-arm report names its host', typeof arm.base === 'string' && arm.base.includes('bqb1'));
  }

  // Host pinning: the env var that flipped must not be a silent input.
  check('base defaults to the subject host', resolveBase({}) === SUBJECT_HOST);
  check('--base overrides and is normalised', resolveBase({ base: 'https://example.test/' }) === 'https://example.test');
  check('a saved census has no base', resolveBase({ census: 'x.json' }) === null);

  if (fails.length > 0) {
    console.error('[tra4986-grade] SELFTEST FAILED:');
    for (const f of fails) console.error(`  - ${f}`);
    return 1;
  }
  console.log(`[tra4986-grade] SELFTEST OK — ${ran} controls passed.`);
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
  const base = resolveBase(args);
  console.log(`[tra4986-grade] subject ${base ?? `saved census ${args.census}`}`);
  console.log(`[tra4986-grade] read ${payload.time ?? '(no time)'} — build ${build.commitShort ?? '?'} pid ${build.pid ?? '?'} startedAt ${build.startedAt ?? '?'}`);
  console.log(`[tra4986-grade] tape ${tape.length} samples, spanSec ${fmt(census.spanSec)}, deep ${census.deep === true}`);

  let worst = 0;
  const bump = (code) => { if (code > worst) worst = code; };

  // ── AC2 ────────────────────────────────────────────────────────────────────
  const structure = gradeStructure(census.live);
  console.log(`\n[AC2 structure] ${structure.verdict} — ${structure.reason}`);
  if (structure.shared) {
    console.log(`  marketData.minuteCandles: entries ${structure.shared.entries}, nested ${fmt(structure.shared.nested)}`);
    const nowPop = rosterOf(census.live);
    console.log(`  |union| is this entries count, at the CURRENT roster of ${fmt(nowPop)} engines.`);
    console.log('  Pre-hoist fleet total was 6,608 entries over 68 owners — a 2026-10-01 measurement at a roster');
    console.log('  that TRA-4902 has since changed, so it is provenance, not a live comparand.');
    if (structure.shared.entries === 0) {
      console.log('  ⚠️  entries 0 — the row is PRESENT but UNEXERCISED. AC2 is structural and passes; the');
      console.log('      content claim (AC1) needs an RTH session to write anything into it.');
    }
  }
  bump(structure.verdict === 'PASS' ? 0 : structure.verdict === 'FAIL' ? 1 : 3);

  // ── AC1 ────────────────────────────────────────────────────────────────────
  const share = census.candleShare;
  if (!share) {
    console.log('\n[AC1 soundness] BLIND — census.candleShare is absent (pre-TRA-4986 build)');
    bump(3);
  } else if (share.writes === 0) {
    // ⭐ `divergentSameInstant: 0` over ZERO writes is the instrument reporting
    // that it was never exercised, not a soundness result. One shared copy
    // cannot have been wrong for anybody if nothing was ever written to it.
    // A fresh boot outside RTH reads exactly like a clean week.
    console.log('\n[AC1 soundness] BLIND — 0 writes since boot: the falsifier was never exercised, so divergentSameInstant 0 is VACUOUS');
    console.log('  the shared store is written by refreshCandles, which needs a cold-bar scan — i.e. an RTH session');
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
  console.log(`\n[AC3 bound] disposition arm ${hasNote ? 'PASS' : 'FAIL'} — published disposition ${hasNote ? 'PRESENT' : 'ABSENT'} on the census row`);
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
    const spanH = tape.length >= 2 ? (tape[tape.length - 1].atMs - tape[0].atMs) / 3.6e6 : 0;
    console.log(`  ring ratio ${fmt(dynTrend.ratio)} (delta ${dynTrend.delta}, ${dynTrend.first} -> ${dynTrend.last})`);
    console.log(`  ring span ${spanH.toFixed(2)}h · covers a premarket slot: ${coversPremarket}`);
    // AC3 has TWO arms and they must be graded apart. The disposition arm is
    // satisfied by a published reason (above). The ratio arm is only measurable
    // over a FULL ring that contains the slot the growth lands in — the measured
    // +433 arrived entirely inside the overnight premarket window. A 2.8h ring
    // on a fresh boot shows ratio 1.00 because nothing has had a chance to be
    // added, which is the quiet-day false green this clause exists to refuse.
    if (!coversPremarket || spanH < 24) {
      console.log(`  ⚠️  ratio arm UNMEASURED: AC3 asks for ratio -> 1.00 over a FULL 24h ring containing a premarket`);
      console.log(`      slot; this ring is ${spanH.toFixed(2)}h with premarket=${coversPremarket}. The disposition arm PASSES;`);
      console.log('      the ratio arm is BLIND, not green.');
      bump(3);
    } else {
      console.log('  ratio arm MEASURED over a full ring with a premarket slot in it.');
    }
  } else {
    console.log('  ⚠️  no ring trend row for dynamicSymbols — ratio arm BLIND');
    bump(3);
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
        const beforePopulation = rosterOfSavedArm(before);
        const afterPopulation = rosterOf(census.live);
        console.log(`\n  BEFORE arm (${BEFORE_ARM}): ${before.window.fromZ} -> ${before.window.toZ}, n ${before.window.n}, ${before.window.spanH}h`);
        console.log(`    build ${before.build} · uptime ${before.uptimeClassH.at}h -> ${before.uptimeClassH.to}h · heapUsed mean ${before.heapUsedMB.mean} MB`);
        console.log(`    population ${fmt(beforePopulation)} engines`);
        console.log(`  AFTER arm population ${fmt(afterPopulation)} engines`);

        // ⭐ The population gate comes BEFORE the number is allowed to mean
        // anything. Printing a fold and then disclaiming it is how a confounded
        // delta gets quoted out of a log.
        //
        // Host identity is checked in the same breath, and for the same reason:
        // the before arm is a bqb1 read, so a differently-based after arm is a
        // cross-machine difference wearing a cross-build costume.
        const beforeBase = (before.base ?? SUBJECT_HOST).replace(/\/$/, '');
        const pop = base !== null && base !== beforeBase
          ? {
            verdict: 'BLIND',
            reason:
              `CROSS-HOST fold refused: the BEFORE arm is a ${beforeBase} read and this AFTER arm came from `
              + `${base}. Point --base at the subject host, or grade a saved census from it.`,
          }
          : foldVerdict({ beforePopulation, afterPopulation });
        if (pop.verdict !== 'PASS') {
          console.log(`\n  [AC4 fold] BLIND — ${pop.reason}`);
          console.log(`    (unfolded, for the record only: heapUsed ${before.heapUsedMB.mean} -> ${heap.mean} MB, rss ${before.rssMB.mean} -> ${rss.mean} MB — DO NOT quote these as a fold)`);
          const scale = leverScaling(beforePopulation, afterPopulation);
          if (scale) {
            console.log(
              `    lever scaling: the hoist eliminated ${scale.filedCopiesEliminated} duplicate copies at the filed roster `
              + `and would eliminate ${scale.nowCopiesEliminated} at the current one — `
              + `${(scale.absoluteLeverRetained * 100).toFixed(1)}% of the filed ABSOLUTE lever, `
              + `while the SHARE of the container removed barely moves `
              + `(${(scale.shareOfContainerFiled * 100).toFixed(1)}% -> ${(scale.shareOfContainerNow * 100).toFixed(1)}%).`,
            );
            console.log(
              `    within-arm spread of the BEFORE arm alone is ${(before.heapUsedMB.max - before.heapUsedMB.min).toFixed(1)} MB `
              + '— compare any predicted saving against THAT before calling a quiescent fold powered.',
            );
          }
          bump(3);
        } else {
          console.log(`\n  MATCHED-QUIESCENT FOLD: ${d >= 0 ? '+' : ''}${d.toFixed(1)} MB heapUsed (${before.heapUsedMB.mean} -> ${heap.mean})`);
          console.log(`    rss: ${(rss.mean - before.rssMB.mean >= 0 ? '+' : '')}${(rss.mean - before.rssMB.mean).toFixed(1)} MB (${before.rssMB.mean} -> ${rss.mean})`);
          console.log(`    population: ${pop.reason}`);
        }
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
