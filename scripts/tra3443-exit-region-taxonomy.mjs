#!/usr/bin/env node
// tra3443-exit-region-taxonomy.mjs — TRA-3443 (parent TRA-3438 / TRA-2305 / TRA-2268)
//
// Derive the PREFIX / RESIDUAL split of `tickExitRegionActive` FROM THE SOURCE, and
// grade a doTick phase census against it with the censoring made explicit.
//
// ── Why this replaces a hand-written list ────────────────────────────────────
// STEP 2 of routine `368ce26f` carried the taxonomy as ten + ten phase names typed
// into a routine description in 2026-07-30. By 2026-08-12 that list had three
// separate defects, and the tape read of 2026-08-12 surfaced all three at once:
//
//   1. WRONG DENOMINATOR — the fatal one. The list partitions the EXIT REGION, but
//      STEP 2 reported its sums as a share of `signal.doTick`. doTick is ~6x the
//      region: everything after `releaseTickExitRegion()` (otm-scan, cold-bar-scan,
//      short-premium-scan, mtf-refresh, agents-advisory, the entry scans …) is
//      OUTSIDE the interlock and was never in scope for either list. That produced
//      "UNCLASSIFIED = 83.99%" and the reading "the taxonomy covers 13% of the tick
//      it partitions". The taxonomy did not shrink; the denominator was six times
//      too large. Reported against the region instead, PREFIX is 97.5% of measured
//      region time, not 12.3% of the tick — an 8x difference in the one number the
//      narrowing decision turns on, and it points the OTHER WAY.
//
//   2. STALE MEMBERSHIP — `signal.doTick.equity-checkExits` and
//      `signal.doTick.broker-position-drift` are in-region and were in NEITHER list.
//      equity-checkExits is literally one of the calls the interlock docstring names.
//      A typed list cannot notice a phase added after it was typed; this script
//      re-derives on every run, so it cannot go stale in that direction again.
//
//   3. OVER-BROAD RESIDUAL — four of the ten RESIDUAL entries (the three reconciles
//      and shadow-chases) are NOT re-run by the decoupled pass. `refreshExitsOnly`
//      calls exactly `runEquityExitPass` then `runOptionsExitPass` and nothing else,
//      and its own docstring says so: "Reconciles, entry scans, cold-bar and MTF
//      refresh are deliberately NOT hoisted." They are still flagged CONTESTED
//      below, because the interlock's docstring names the pending-close reconciler
//      as a serialisation target — that conflict is TRA-2268's to rule on, not this
//      instrument's to silently resolve.
//
// ── The derivation, and why it is authoritative ──────────────────────────────
// RESIDUAL is not a matter of taste. The interlock exists to stop a SECOND
// concurrent caller of the exit path, and the decoupled pass is the only other
// caller. So:
//
//   RESIDUAL := the phases emitted by the code `refreshExitsOnly` re-runs
//               (= runEquityExitPass ∪ runOptionsExitPass)
//   PREFIX   := every other phase between openTickExitRegion() and
//               releaseTickExitRegion()
//   POST     := every phase after releaseTickExitRegion() — outside the interlock,
//               narrowing has nothing to say about it, and it is NOT "unclassified"
//
// All three are read out of `signal-engine.ts` by span arithmetic on each run.
//
// ── The censoring, and why every total here is an interval ───────────────────
// `recordPhaseDuration` is a no-op below PHASE_TIMING_SLOW_MS (default 1000ms,
// packages/server/src/phase-timing.ts). The tape is therefore LEFT-CENSORED: a
// phase contributes nothing until a single run crosses 1s. Two consequences that
// the old STEP 2 wording ("report sum(residual) AS A LOWER BOUND, explicitly")
// stated but never quantified, and an unquantified lower bound gets read as a level:
//
//   * ABSENT and MEASURED-ZERO are byte-identical. This script prints `<<ABSENT>>`,
//     never 0, and never lets an absent phase contribute a 0 to a share.
//   * The upper bound is enormous. An absent phase that ran on every tick under the
//     threshold carries up to nOpportunity x SLOW_MS. On the 2026-08-12 tape that is
//     10,946s PER ABSENT PHASE against a measured region total of 16,262s. With six
//     of seven RESIDUAL phases absent, sum(RESIDUAL) ∈ [392s, 66,068s] — the
//     instrument constrains it to within a factor of 168, i.e. not at all.
//
// So the gate is NOT "refuse when UNCLASSIFIED > x%" (that fraction is 0 by
// construction here and the gate would never fire — a control that cannot fire).
// The gate is on the CENSORING RATIO: refuse to publish a share whenever the
// censoring interval is wider than --max-censor-ratio. That is the defect that was
// actually present on 2026-08-12, so the control contains what it detects.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   node scripts/tra3443-exit-region-taxonomy.mjs                      # taxonomy only
//   node scripts/tra3443-exit-region-taxonomy.mjs --census=FILE        # + grade
//   node scripts/tra3443-exit-region-taxonomy.mjs --census=FILE --json
//
//   --census=FILE          JSON: either a tra2203-dotick-tape.mjs --dump array of
//                          {phase,durationMs,ts} records, or a pre-cut census
//                          {parent:{n,sumS}, phases:{<label>:{n,sumS,maxS}}}.
//   --slow-ms=N            PHASE_TIMING_SLOW_MS in force on the measured box (1000).
//   --max-censor-ratio=R   refuse to publish a share when hi/lo exceeds R (2.0).
//   --src=FILE             override the signal-engine.ts path.
//   --json                 machine-readable output.
//
// ── Exit codes ───────────────────────────────────────────────────────────────
//   0  taxonomy derived (and, with --census, a share published)
//   2  usage / unreadable source
//   3  REFUSED — the derivation is vacuous, the census names a phase this source
//      does not emit, or the censoring interval is too wide to publish a share.
//      Exit 3 is a RESULT, not an error: it is this instrument declining to supply
//      a number TRA-2268 would have to defend.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const valOf = name => {
  const hit = argv.find(a => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};
const has = f => argv.includes(f);

const SRC_PATH = valOf('--src')
  ?? fileURLToPath(new URL('../packages/server/src/signal-engine.ts', import.meta.url));
const SLOW_MS = Number(valOf('--slow-ms') ?? 1000);
const MAX_CENSOR_RATIO = Number(valOf('--max-censor-ratio') ?? 2.0);
const JSON_OUT = has('--json');

/**
 * In-region PREFIX phases whose EXCLUSION is a judgement call TRA-2268 owns, not a
 * mechanical consequence. Each needs a reason: an unjustified entry here is how a
 * "safe to exclude" list quietly grows.
 *
 * These are PREFIX (the decoupled pass does not re-run them, so narrowing CAN
 * exclude them) but the interlock's own docstring at signal-engine.ts:1252 names
 * "the pending-close reconciler" as something the region serialises. That is a
 * live conflict between two comments in the same file. This script reports the
 * conflict rather than resolving it, because resolving it is a money-book call.
 */
const CONTESTED = [
  {
    phase: 'signal.doTick.reconcile-pending-closes',
    why: 'the interlock docstring (signal-engine.ts:1252-1257) names "the pending-close reconciler" '
      + 'as a serialisation target, but refreshExitsOnly does not call it. Excluding it lets a '
      + 'decoupled pass interleave with reconcilePendingCloses over the same pending sell_to_close rows.',
  },
  {
    phase: 'signal.doTick.reconcile-live-portfolio',
    why: 'writes the local book from broker state; can race runOptionsExitPass\'s view of open rows.',
  },
  {
    phase: 'signal.doTick.reconcile-live-equity',
    why: 'same shape as reconcile-live-portfolio, on the equity mirror.',
  },
  {
    phase: 'signal.doTick.broker-position-drift',
    why: 'TRA-3067 observer, added AFTER the 2026-07-30 lists were typed and in neither of them. '
      + 'Read-only today, but it reads the same book the exit pass mutates.',
  },
  {
    phase: 'signal.doTick.shadow-chases',
    why: 'observe-only maker chases, deliberately ordered before the mark refresh so a chase reads '
      + 'the same-age chain snapshot the marks do; excluding it breaks that ordering guarantee.',
  },
];

// ── source parsing ───────────────────────────────────────────────────────────

/** Blank out strings/comments so paren+brace counting is honest. (Mirrors dotick-phase-coverage.test.ts.) */
function mask(src) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i);
      const stop = j < 0 ? src.length : j;
      for (let k = i; k < stop; k++) out[k] = ' ';
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      const stop = j < 0 ? src.length : j + 2;
      for (let k = i; k < stop; k++) out[k] = ' ';
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      // Keep the quotes but blank the body, so a phase label is still findable in
      // the RAW source by offset while parens inside strings cannot skew counting.
      for (let k = i + 1; k < Math.min(j - 1, src.length) + 1; k++) out[k] = ' ';
      i = j;
    } else {
      i++;
    }
  }
  return out.join('');
}

function matchAt(masked, open, oc, cc) {
  let d = 0;
  for (let j = open; j < masked.length; j++) {
    if (masked[j] === oc) d++;
    else if (masked[j] === cc) { d--; if (d === 0) return j; }
  }
  return -1;
}

/** Span of a method body, located by a declaration regex. */
function bodySpan(masked, declRe) {
  const decl = declRe.exec(masked);
  if (!decl) return null;
  const start = masked.indexOf('{', decl.index + decl[0].length);
  if (start < 0) return null;
  const end = matchAt(masked, start, '{', '}');
  if (end < 0) return null;
  return { start, end };
}

/** Every withPhase / timeSyncPhase label in `src`, with its offset. Labels read from RAW source. */
function phaseSites(src, masked) {
  const sites = [];
  const re = /(?:withPhase|timeSyncPhase)(?:<[^>]*>)?\s*\(\s*/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const at = m.index + m[0].length;
    const q = src[at];
    if (q !== "'" && q !== '"' && q !== '`') continue; // computed label (e.g. `signal.supertrend:${sym}`)
    let j = at + 1;
    while (j < src.length && src[j] !== q) {
      if (src[j] === '\\') j++;
      j++;
    }
    const label = src.slice(at + 1, j);
    if (label.includes('${')) continue; // per-symbol template label, not a tick phase
    sites.push({ label, at: m.index });
  }
  return sites;
}

function deriveTaxonomy(src) {
  const M = mask(src);
  const doTick = bodySpan(M, /async\s+doTick\s*\(/);
  const equityPass = bodySpan(M, /private\s+runEquityExitPass\s*\(/);
  const optionsPass = bodySpan(M, /private\s+async\s+runOptionsExitPass\s*\(/);
  const refresh = bodySpan(M, /private\s+async\s+refreshExitsOnly\s*\(/);

  const problems = [];
  if (!doTick) problems.push('could not locate the doTick body');
  if (!equityPass) problems.push('could not locate runEquityExitPass');
  if (!optionsPass) problems.push('could not locate runOptionsExitPass');
  if (!refresh) problems.push('could not locate refreshExitsOnly');
  if (problems.length) return { ok: false, problems };

  // The interlock markers, located INSIDE the doTick body only.
  const openAt = M.indexOf('this.openTickExitRegion()', doTick.start);
  const relAt = M.indexOf('this.releaseTickExitRegion()', doTick.start);
  if (openAt < 0 || openAt > doTick.end) problems.push('openTickExitRegion() not found inside doTick');
  if (relAt < 0 || relAt > doTick.end) problems.push('releaseTickExitRegion() not found inside doTick');
  if (relAt <= openAt) problems.push('releaseTickExitRegion() does not follow openTickExitRegion()');

  // Prove the decoupled pass really re-runs exactly the two exit containers. If it
  // grows a third call, RESIDUAL is understated and this derivation must be redone
  // rather than silently shipping a narrower set.
  const refreshBody = M.slice(refresh.start, refresh.end);
  const reRun = ['runEquityExitPass', 'runOptionsExitPass'].filter(n => refreshBody.includes(`this.${n}(`));
  const extraCalls = [...refreshBody.matchAll(/this\.(\w+)\s*\(/g)]
    .map(m => m[1])
    .filter(n => /Pass$|^reconcile|^refresh|^advance|^submit|^resolve/.test(n))
    .filter(n => !reRun.includes(n));
  if (reRun.length !== 2) {
    problems.push(`refreshExitsOnly re-runs ${reRun.length} exit containers, expected 2 — RESIDUAL must be re-derived`);
  }
  if (problems.length) return { ok: false, problems };

  const sites = phaseSites(src, M);
  const inSpan = (at, s) => at >= s.start && at <= s.end;

  const residual = [];
  const prefix = [];
  const post = [];
  const seen = new Set();

  // RESIDUAL: whatever the two re-run containers emit.
  for (const s of sites) {
    if (inSpan(s.at, equityPass) || inSpan(s.at, optionsPass)) {
      if (!seen.has(s.label)) { residual.push(s.label); seen.add(s.label); }
    }
  }
  // PREFIX / POST: doTick-body phases, split by the release marker.
  for (const s of sites) {
    if (!inSpan(s.at, doTick)) continue;
    if (seen.has(s.label)) continue;
    if (s.at > openAt && s.at < relAt) { prefix.push(s.label); seen.add(s.label); }
    else if (s.at > relAt) { post.push(s.label); seen.add(s.label); }
    // A phase BEFORE openTickExitRegion() would be pre-region; there are none
    // today (the interlock is claimed on the first statement of doTick) and one
    // appearing is caught by the non-vacuity assertions below.
  }

  // A CONTESTED entry that is no longer in-region is a stale justification.
  const contestedStale = CONTESTED.filter(c => !prefix.includes(c.phase));
  if (contestedStale.length) {
    problems.push(`CONTESTED names phases that are not in-region PREFIX: ${contestedStale.map(c => c.phase).join(', ')}`);
  }

  // Non-vacuity: a parse that silently failed would return empty sets and every
  // downstream assertion would pass trivially.
  if (residual.length < 5) problems.push(`only ${residual.length} RESIDUAL phases derived — parse is suspect`);
  if (prefix.length < 8) problems.push(`only ${prefix.length} PREFIX phases derived — parse is suspect`);
  if (post.length < 8) problems.push(`only ${post.length} POST phases derived — parse is suspect`);
  if (problems.length) return { ok: false, problems };

  return {
    ok: true,
    residual: residual.sort(),
    prefix: prefix.sort(),
    post: post.sort(),
    contested: CONTESTED,
    extraCallsInRefresh: extraCalls,
    lines: {
      open: src.slice(0, openAt).split('\n').length,
      release: src.slice(0, relAt).split('\n').length,
    },
  };
}

// ── census ───────────────────────────────────────────────────────────────────

/** Accept either a raw --dump record array or a pre-cut census object. */
function loadCensus(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(raw) || Array.isArray(raw.records)) {
    const records = Array.isArray(raw) ? raw : raw.records;
    const by = new Map();
    for (const r of records) {
      const cur = by.get(r.phase) ?? { n: 0, sumMs: 0, maxMs: 0 };
      cur.n += 1;
      cur.sumMs += Number(r.durationMs) || 0;
      cur.maxMs = Math.max(cur.maxMs, Number(r.durationMs) || 0);
      by.set(r.phase, cur);
    }
    const parent = by.get('signal.doTick') ?? { n: 0, sumMs: 0, maxMs: 0 };
    const phases = {};
    for (const [k, v] of by) {
      if (k === 'signal.doTick') continue;
      phases[k] = { n: v.n, sumS: v.sumMs / 1000, maxS: v.maxMs / 1000 };
    }
    return { parent: { n: parent.n, sumS: parent.sumMs / 1000 }, phases, source: `${file} (raw dump)` };
  }
  return { ...raw, source: raw.source ?? file };
}

/**
 * Left-censoring interval for one phase.
 * lo = what the tape actually recorded (0 runs recorded => ABSENT, not 0).
 * hi = lo + (opportunities not observed) x SLOW_MS, i.e. every unrecorded run
 *      sitting just under the threshold. LOOSE on purpose: a throttled or
 *      mode-gated phase has fewer opportunities than nParent, so the true bound is
 *      tighter. The point is that the TAPE supplies no tighter one.
 */
function censor(entry, nParent, slowMs) {
  const lo = entry ? entry.sumS : 0;
  const nObs = entry ? entry.n : 0;
  const hi = lo + Math.max(0, nParent - nObs) * (slowMs / 1000);
  return { lo, hi, nObs, absent: !entry };
}

function gradeClass(labels, census, nParent, slowMs) {
  const rows = labels.map(label => {
    const e = census.phases[label];
    return { label, ...censor(e, nParent, slowMs), maxS: e ? e.maxS : null };
  });
  const lo = rows.reduce((a, r) => a + r.lo, 0);
  const hi = rows.reduce((a, r) => a + r.hi, 0);
  return { rows, lo, hi, absentCount: rows.filter(r => r.absent).length };
}

function f1(x) { return Number(x).toFixed(1); }
function pct(x, d) { return d > 0 ? `${((x / d) * 100).toFixed(2)}%` : 'n/a'; }

// ── main ─────────────────────────────────────────────────────────────────────

let src;
try {
  src = readFileSync(SRC_PATH, 'utf8');
} catch (err) {
  console.error(`cannot read ${SRC_PATH}: ${err.message}`);
  process.exit(2);
}

const tax = deriveTaxonomy(src);
if (!tax.ok) {
  console.error('REFUSED — the taxonomy derivation is not trustworthy on this source:');
  for (const p of tax.problems) console.error(`  * ${p}`);
  console.error('\nThis is exit 3, not a fallback to the old hand-written list. A stale typed list is');
  console.error('what TRA-3443 exists to remove; silently reverting to one would re-create the defect.');
  process.exit(3);
}

const censusFile = valOf('--census');
if (!censusFile) {
  if (JSON_OUT) {
    console.log(JSON.stringify({ taxonomy: tax, slowMs: SLOW_MS }, null, 2));
  } else {
    console.log('TRA-3443 — tickExitRegionActive taxonomy, derived from source');
    console.log(`  source: ${SRC_PATH}`);
    console.log(`  region: signal-engine.ts:${tax.lines.open} (open) -> :${tax.lines.release} (release)\n`);
    console.log(`RESIDUAL — re-run by refreshExitsOnly, MUST stay inside a narrowed region (${tax.residual.length}):`);
    for (const p of tax.residual) console.log(`    ${p}`);
    console.log(`\nPREFIX — in-region, NOT re-run by the decoupled pass, narrowing WOULD exclude (${tax.prefix.length}):`);
    for (const p of tax.prefix) {
      const c = tax.contested.find(x => x.phase === p);
      console.log(`    ${p}${c ? '   [CONTESTED]' : ''}`);
    }
    console.log(`\nPOST-REGION — outside the interlock already; narrowing says NOTHING about these (${tax.post.length}).`);
    console.log('    NOT "unclassified". Dividing PREFIX/RESIDUAL by sum(signal.doTick) mixes these in');
    console.log('    and understates PREFIX by ~8x. The denominator is the REGION.');
    for (const p of tax.post) console.log(`    ${p}`);
    console.log('\nCONTESTED PREFIX — exclusion is TRA-2268\'s call, not this instrument\'s:');
    for (const c of tax.contested) console.log(`    ${c.phase}\n      ${c.why}`);
  }
  process.exit(0);
}

let census;
try {
  census = loadCensus(censusFile);
} catch (err) {
  console.error(`cannot read census ${censusFile}: ${err.message}`);
  process.exit(2);
}

const nParent = census.parent?.n ?? 0;
const sumParent = census.parent?.sumS ?? 0;
if (!(nParent > 0)) {
  console.error('REFUSED — census carries no signal.doTick parent records; there is no opportunity count,');
  console.error('so the censoring upper bound cannot be formed and no share is defensible.');
  process.exit(3);
}

// A census label this source does not emit means the tape and the build disagree.
const known = new Set([...tax.residual, ...tax.prefix, ...tax.post]);
const unknown = Object.keys(census.phases).filter(k => !known.has(k));

const R = gradeClass(tax.residual, census, nParent, SLOW_MS);
const P = gradeClass(tax.prefix, census, nParent, SLOW_MS);
const O = gradeClass(tax.post, census, nParent, SLOW_MS);

const regionLo = R.lo + P.lo;
const regionHi = R.hi + P.hi;
const censorRatio = regionLo > 0 ? regionHi / regionLo : Infinity;

const refusals = [];
if (unknown.length) {
  refusals.push(`census names ${unknown.length} phase(s) this source does not emit: ${unknown.slice(0, 6).join(', ')}`
    + ` — the tape and the build under measurement disagree; re-derive against the deployed commit`);
}
if (!(censorRatio <= MAX_CENSOR_RATIO)) {
  refusals.push(`censoring interval is ${censorRatio.toFixed(1)}x wide (max ${MAX_CENSOR_RATIO}x): region time is`
    + ` [${f1(regionLo)}s, ${f1(regionHi)}s] at PHASE_TIMING_SLOW_MS=${SLOW_MS}ms`
    + ` — ${R.absentCount}/${tax.residual.length} RESIDUAL and ${P.absentCount}/${tax.prefix.length} PREFIX phases are ABSENT`);
}

const verdict = refusals.length ? 'REFUSED' : 'PUBLISHED';

const report = {
  verdict,
  refusals,
  source: census.source,
  slowMs: SLOW_MS,
  maxCensorRatio: MAX_CENSOR_RATIO,
  parent: { n: nParent, sumS: sumParent },
  region: { lo: regionLo, hi: regionHi, censorRatio },
  classes: {
    RESIDUAL: { lo: R.lo, hi: R.hi, absent: R.absentCount, of: tax.residual.length, shareOfRegionLo: regionLo > 0 ? R.lo / regionLo : null },
    PREFIX: { lo: P.lo, hi: P.hi, absent: P.absentCount, of: tax.prefix.length, shareOfRegionLo: regionLo > 0 ? P.lo / regionLo : null },
    POST: { lo: O.lo, hi: O.hi, absent: O.absentCount, of: tax.post.length },
  },
  taxonomy: tax,
  rows: { RESIDUAL: R.rows, PREFIX: P.rows, POST: O.rows },
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(verdict === 'REFUSED' ? 3 : 0);
}

const line = (r) => `    ${r.label.replace('signal.doTick.', '').replace('signal.', '').padEnd(26)} `
  + `${(r.absent ? '<<ABSENT>>' : `n=${r.nObs}`).padStart(11)} `
  + `${(r.absent ? '<<ABSENT>>' : `${f1(r.lo)}s`).padStart(11)} `
  + `<= ${f1(r.hi).padStart(9)}s`;

console.log(`TRA-3443 exit-region split — ${verdict}`);
console.log(`  census : ${census.source}`);
console.log(`  source : ${SRC_PATH}  (region :${tax.lines.open} -> :${tax.lines.release})`);
console.log(`  floor  : PHASE_TIMING_SLOW_MS = ${SLOW_MS}ms — EVERY figure below is left-censored at this floor.`);
console.log(`  parent : signal.doTick  n=${nParent}  sum=${f1(sumParent)}s  <- NOT the denominator (see POST-REGION)\n`);

console.log(`  DENOMINATOR = measured region time = ${f1(regionLo)}s   (interval: ${f1(regionLo)}s .. ${f1(regionHi)}s, ${censorRatio.toFixed(1)}x)`);
console.log(`  For reference only, sum(signal.doTick) = ${f1(sumParent)}s — ${(sumParent / Math.max(regionLo, 1)).toFixed(1)}x the region.`);
console.log(`  Dividing by it is the 2026-07-30 defect this script exists to stop.\n`);

console.log(`RESIDUAL (stays inside a narrowed region) — ${R.absentCount}/${tax.residual.length} ABSENT`);
console.log(`    ${''.padEnd(26)} ${'observed'.padStart(11)} ${'lower'.padStart(11)}    upper`);
for (const r of R.rows) console.log(line(r));
console.log(`    ${'sum(RESIDUAL)'.padEnd(26)} ${''.padStart(11)} ${f1(R.lo).padStart(10)}s <= ${f1(R.hi).padStart(9)}s`
  + `   = ${pct(R.lo, regionLo)} .. ${pct(R.hi, regionHi)} of region\n`);

console.log(`PREFIX (narrowing would exclude) — ${P.absentCount}/${tax.prefix.length} ABSENT`);
for (const r of P.rows) {
  const c = tax.contested.find(x => x.phase === r.label);
  console.log(`${line(r)}${c ? '  [CONTESTED]' : ''}`);
}
console.log(`    ${'sum(PREFIX)'.padEnd(26)} ${''.padStart(11)} ${f1(P.lo).padStart(10)}s <= ${f1(P.hi).padStart(9)}s`
  + `   = ${pct(P.lo, regionLo)} .. ${pct(P.hi, regionHi)} of region\n`);

console.log(`POST-REGION (outside the interlock — NOT unclassified, NOT in scope for narrowing)`);
console.log(`    sum = ${f1(O.lo)}s over ${tax.post.length} phases, ${O.absentCount} ABSENT.`);
console.log(`    This is the ${pct(O.lo, sumParent)} of signal.doTick that the old STEP 2 reported as`);
console.log(`    "UNCLASSIFIED". It was never unclassified — it is outside the region by construction.\n`);

if (refusals.length) {
  console.log('== REFUSED TO PUBLISH A SHARE ==');
  for (const r of refusals) console.log(`  * ${r}`);
  console.log('\n  The lower bounds above are still on the record and are still true as LOWER BOUNDS.');
  console.log('  What is refused is the SHARE — the number a narrowing decision would lean on.');
  console.log('  A phase absent from the tape is indistinguishable from one that ran every tick at');
  console.log(`  ${SLOW_MS - 1}ms. Until PHASE_TIMING_SLOW_MS is lowered for a measurement session, or the`);
  console.log('  region is instrumented directly (an uncensored pre-exit-work vs exit-work split), no');
  console.log('  share computed from this tape is defensible in EITHER direction.');
  console.log('\n  Do NOT hand any figure above to TRA-2268 as a criterion.');
} else {
  console.log('== PUBLISHED ==');
  console.log(`  sum(PREFIX)   = ${pct(P.lo, regionLo)} of region  — reclaimable by narrowing`);
  console.log(`  sum(RESIDUAL) = ${pct(R.lo, regionLo)} of region  — the floor narrowing cannot reclaim`);
  console.log(`  Censoring interval ${censorRatio.toFixed(1)}x, within the ${MAX_CENSOR_RATIO}x bar.`);
}

process.exit(verdict === 'REFUSED' ? 3 : 0);
