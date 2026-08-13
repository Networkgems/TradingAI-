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
// ── TRA-3496: the UNCENSORED source, and why it OUTRANKS everything above ────
// Everything above this line grades the left-censored PHASE TAPE, and on the
// 2026-08-12 tape it refuses at a 15.6x censoring ratio — correctly, and forever,
// because no amount of tape fixes a floor of PHASE_TIMING_SLOW_MS.
//
// TRA-3444 shipped the answer as a DIRECT measurement:
// `/api/health/exit-cadence` -> `books.<book>.tickExitRegionMs.exitWorkMs`, a
// thresholdless bracket around exactly `runEquityExitPass` + `runOptionsExitPass`
// (i.e. exactly what `refreshExitsOnly` re-runs = exactly RESIDUAL above). So:
//
//     PREFIX = tickExitRegionMs.sumMs - exitWorkMs.sumMs,  EXACTLY
//
// with no threshold, no absent-vs-zero ambiguity and no dependence on the tape.
// This script reads it, and when it can, PUBLISHES on it — otherwise the field is
// live and nothing asks for it, which answers nobody (the TRA-3444 closing note).
//
// THE COUNTERS ARE CUMULATIVE SINCE BOOT. A single read therefore answers "since
// boot", and the RTH-scoped answer is the DIFFERENCE across a T0/T1 pair. Two
// exceptions matter and both are handled below:
//
//   * If the process BOOTED AT OR AFTER the RTH open, "since boot" is ALREADY
//     RTH-scoped and the implicit T0 is the zero vector at `build.startedAt` —
//     no second read exists that could be more exact. bqb1 restarts roughly
//     hourly, so at a 13:00 ET read this is the common case, and it is what lets
//     a SINGLE-FIRE routine step publish at all.
//   * If the process restarted BETWEEN T0 and T1, every counter reset and every
//     delta is garbage (it can go NEGATIVE). That is a REFUSAL, never a small
//     prefix. Pairing is on `build.pid` + `build.startedAt` + `build.commit`.
//
// Which fields may be subtracted is NOT typed here. `maxMs` is a running maximum
// and does not subtract; `samples`/`sumMs` are monotonic and do. That list is
// owned by `EXIT_CADENCE_NOT_DIFFERENCEABLE`
// (packages/server/src/observability/exit-cadence-snapshot.ts) and is read from
// the payload when the payload declares it (a TRA-2840 snapshot line does; the
// raw route does NOT — measured 2026-08-13), else parsed from that source. A
// hand-typed copy is defect #2 above, rebuilt one level in.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   node scripts/tra3443-exit-region-taxonomy.mjs                      # taxonomy only
//   node scripts/tra3443-exit-region-taxonomy.mjs --census=FILE        # + censored grade
//   node scripts/tra3443-exit-region-taxonomy.mjs --census=FILE --json
//
//   # the uncensored read — a T0/T1 pair, or a single read whose process booted
//   # at/after the RTH open (capture with: curl -s $HOST/api/health/exit-cadence > t1.json)
//   node scripts/tra3443-exit-region-taxonomy.mjs --exit-cadence-t1=t1.json
//   node scripts/tra3443-exit-region-taxonomy.mjs --exit-cadence-t0=t0.json --exit-cadence-t1=t1.json
//   # …and with the censored tape as a CROSS-CHECK (a contradiction REFUSES):
//   node scripts/tra3443-exit-region-taxonomy.mjs --census=FILE --exit-cadence-t1=t1.json
//
//   --census=FILE          JSON: either a tra2203-dotick-tape.mjs --dump array of
//                          {phase,durationMs,ts} records, or a pre-cut census
//                          {parent:{n,sumS}, phases:{<label>:{n,sumS,maxS}}}.
//   --exit-cadence-t0=FILE opening read. Either a raw /api/health/exit-cadence
//                          payload or a TRA-2840 `exit-cadence-snapshot` line.
//                          OMIT to use the implicit zero vector at process boot.
//   --exit-cadence-t1=FILE closing read, same two shapes.
//   --allow-outside-rth    publish a window that is not contained in RTH. LOUD:
//                          an off-hours split measures the INSTRUMENT, not the
//                          market, and must never reach TRA-2268 as an answer.
//   --slow-ms=N            PHASE_TIMING_SLOW_MS in force on the measured box (1000).
//   --max-censor-ratio=R   refuse to publish a CENSORED share when hi/lo exceeds R (2.0).
//   --src=FILE             override the signal-engine.ts path.
//   --snapshot-src=FILE    override the exit-cadence-snapshot.ts path.
//   --json                 machine-readable output.
//
// ── Exit codes ───────────────────────────────────────────────────────────────
//   0  taxonomy derived, and a share published by at least one source
//   2  usage / unreadable source
//   3  REFUSED — the derivation is vacuous, the census names a phase this source
//      does not emit, the censoring interval is too wide AND no uncensored read
//      rescued it, the uncensored pair is not differenceable (restart, negative
//      delta, broken containment, non-RTH window), or the two instruments
//      CONTRADICT each other.
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

// ── TRA-3496: uncensored T0/T1 differencing ──────────────────────────────────

const SNAPSHOT_SRC_PATH = valOf('--snapshot-src')
  ?? fileURLToPath(new URL('../packages/server/src/observability/exit-cadence-snapshot.ts', import.meta.url));
const ALLOW_OUTSIDE_RTH = has('--allow-outside-rth');

/**
 * The four counters this instrument subtracts, per book.
 *
 * This names what we INTEND to difference. It is not the authority on what MAY be
 * differenced — that is `EXIT_CADENCE_NOT_DIFFERENCEABLE`, read below — and every
 * path here is checked against it on every run. If a future edit reclassifies one
 * of these as a running maximum, this script REFUSES instead of quietly
 * subtracting two extremes.
 */
const differencedPaths = book => [
  `books.${book}.tickExitRegionMs.samples`,
  `books.${book}.tickExitRegionMs.sumMs`,
  `books.${book}.tickExitRegionMs.exitWorkMs.samples`,
  `books.${book}.tickExitRegionMs.exitWorkMs.sumMs`,
];

/**
 * Read the authoritative not-differenceable list and the RTH bounds out of
 * `exit-cadence-snapshot.ts`. Returns nulls on a parse failure so the caller can
 * REFUSE — falling back to a typed list is the defect, not the recovery.
 */
function readSnapshotModule(path) {
  let src;
  try { src = readFileSync(path, 'utf8'); } catch { return { notDifferenceable: null, rthOpenMin: null, rthCloseMin: null, path }; }
  const listM = /EXIT_CADENCE_NOT_DIFFERENCEABLE[^=]*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/.exec(src);
  const list = listM ? [...listM[1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]) : [];
  const openM = /RTH_OPEN_UTC_MIN\s*=\s*(\d+)\s*\*\s*60\s*\+\s*(\d+)/.exec(src);
  const closeM = /RTH_CLOSE_UTC_MIN\s*=\s*(\d+)\s*\*\s*60/.exec(src);
  return {
    notDifferenceable: list.length ? list : null,
    rthOpenMin: openM ? Number(openM[1]) * 60 + Number(openM[2]) : null,
    rthCloseMin: closeM ? Number(closeM[1]) * 60 : null,
    path,
  };
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Normalise either accepted shape into one envelope.
 *
 *  * a TRA-2840 `exit-cadence-snapshot` log line — carries `.process`, `.rollup`
 *    AND its own `.notDifferenceable`, and survives every restart in Render's logs;
 *  * a raw `/api/health/exit-cadence` payload — carries `.build` and the rollup at
 *    top level, and does NOT declare `notDifferenceable` (measured 2026-08-13).
 */
function loadCadenceRead(file, mark) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (raw && raw.rollup && raw.process) {
    return {
      mark, file, shape: 'TRA-2840 exit-cadence-snapshot line',
      at: raw.at ?? null,
      process: {
        pid: raw.process.pid ?? null,
        startedAt: raw.process.startedAt ?? null,
        commit: raw.process.commit ?? null,
      },
      notDifferenceable: Array.isArray(raw.notDifferenceable) ? raw.notDifferenceable : null,
      partialWindow: raw.partialWindow ?? null,
      rollup: raw.rollup,
    };
  }
  if (raw && raw.books && raw.build) {
    return {
      mark, file, shape: '/api/health/exit-cadence payload',
      at: raw.time ?? null,
      process: {
        pid: raw.build.pid ?? null,
        startedAt: raw.build.startedAt ?? null,
        commit: raw.build.commit ?? null,
      },
      notDifferenceable: Array.isArray(raw.notDifferenceable) ? raw.notDifferenceable : null,
      partialWindow: null,
      rollup: raw,
    };
  }
  throw new Error(`${file}: not an exit-cadence read — expected either a TRA-2840 snapshot line `
    + '(.process + .rollup) or a /api/health/exit-cadence payload (.build + .books)');
}

/**
 * The T0 implied by a lone T1. The counters are cumulative since boot, so the
 * process's own boot instant is a read whose every counter is zero BY
 * CONSTRUCTION — no fetch could be more exact. Only sound when boot >= RTH open,
 * which the caller asserts.
 */
function zeroReadAtBoot(t1) {
  const zero = () => ({ samples: 0, sumMs: 0, exitWorkMs: { samples: 0, sumMs: 0 } });
  const books = {};
  for (const b of Object.keys(t1.rollup.books ?? {})) books[b] = { tickExitRegionMs: zero() };
  return {
    mark: 'T0', file: '(implicit)', shape: 'implicit zero vector at process boot',
    at: t1.process.startedAt, process: { ...t1.process },
    notDifferenceable: null, partialWindow: null,
    rollup: { books, tickExitRegionMs: zero() },
  };
}

const utcMinOf = ms => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes();
const utcDayOf = ms => new Date(ms).toISOString().slice(0, 10);

/**
 * Difference a T0/T1 pair into a per-book PREFIX/RESIDUAL split.
 *
 * Every refusal here is a REFUSAL and not a warning, because each one has a
 * failure mode that produces a PLAUSIBLE SMALL NUMBER rather than an obvious
 * error — and a small prefix is exactly the reading that makes narrowing a
 * money-book interlock look cheap.
 */
function gradeUncensored(t0, t1, snapModule) {
  const refusals = [];
  const notes = [];

  // 1. Which fields may be subtracted. Payload first, source second, never typed.
  const declared = t1.notDifferenceable ?? t0.notDifferenceable ?? null;
  if (t0.notDifferenceable && t1.notDifferenceable) {
    const a = [...t0.notDifferenceable].sort().join('|');
    const b = [...t1.notDifferenceable].sort().join('|');
    if (a !== b) refusals.push('T0 and T1 declare DIFFERENT notDifferenceable lists — the two reads came from '
      + 'builds that disagree about which counters subtract; re-take the pair against one build');
  }
  const notDifferenceable = declared ?? snapModule.notDifferenceable;
  const notDiffSource = declared
    ? `declared on the ${declared === t1.notDifferenceable ? 'T1' : 'T0'} payload`
    : `parsed from ${snapModule.path}`;
  if (!notDifferenceable) {
    refusals.push('cannot resolve EXIT_CADENCE_NOT_DIFFERENCEABLE — neither read declares it and '
      + `${snapModule.path} did not parse. Refusing rather than falling back to a typed list: a typed `
      + 'copy of that list is precisely the staleness defect this script exists to remove');
  }

  // 2. Process identity. A restart resets every counter; the delta then means nothing.
  const idFields = ['pid', 'startedAt', 'commit'];
  const drifted = idFields.filter(k => t0.process[k] != null && t1.process[k] != null && t0.process[k] !== t1.process[k]);
  if (drifted.length) {
    refusals.push(`the process RESTARTED between T0 and T1 (${drifted.map(k => `${k}: ${t0.process[k]} -> ${t1.process[k]}`).join('; ')})`
      + ' — the counters reset, so every delta below is garbage and can be negative. The verdict is BLIND, never zero');
  }
  if (t0.process.startedAt == null || t1.process.startedAt == null) {
    refusals.push('a read is missing `build.startedAt` — process identity cannot be established, so a '
      + 'mid-window restart would be invisible');
  }

  // 3. Window. An RTH-scoped criterion measured off-hours grades the instrument, not the market.
  const t0Ms = Date.parse(t0.at ?? '');
  const t1Ms = Date.parse(t1.at ?? '');
  let window = null;
  if (!Number.isFinite(t0Ms) || !Number.isFinite(t1Ms)) {
    refusals.push('a read carries no usable timestamp — the window it covers cannot be established');
  } else if (t1Ms <= t0Ms) {
    refusals.push(`T1 (${t1.at}) does not follow T0 (${t0.at}) — the pair is out of order`);
  } else {
    const spanMin = Math.round((t1Ms - t0Ms) / 60_000);
    const insideRth = snapModule.rthOpenMin != null && snapModule.rthCloseMin != null
      && utcDayOf(t0Ms) === utcDayOf(t1Ms)
      && utcMinOf(t0Ms) >= snapModule.rthOpenMin && utcMinOf(t1Ms) <= snapModule.rthCloseMin;
    window = { fromIso: t0.at, toIso: t1.at, spanMin, insideRth };
    if (!insideRth && !ALLOW_OUTSIDE_RTH) {
      refusals.push(`the window ${t0.at} -> ${t1.at} is NOT contained in RTH `
        + `(${String(Math.floor((snapModule.rthOpenMin ?? 0) / 60)).padStart(2, '0')}:`
        + `${String((snapModule.rthOpenMin ?? 0) % 60).padStart(2, '0')}Z-`
        + `${String(Math.floor((snapModule.rthCloseMin ?? 0) / 60)).padStart(2, '0')}:`
        + `${String((snapModule.rthCloseMin ?? 0) % 60).padStart(2, '0')}Z). Off-hours both exit passes have `
        + 'almost nothing to do, so the split measures the INSTRUMENT and not the market. Pass '
        + '--allow-outside-rth only for an instrument check, never for an answer');
    }
    if (!insideRth && ALLOW_OUTSIDE_RTH) {
      notes.push('WINDOW IS NOT RTH-CONTAINED and --allow-outside-rth was passed. This is an INSTRUMENT '
        + 'CHECK. Off-hours the exit passes are near-idle, so PREFIX runs to ~99% and means nothing about '
        + 'narrowing in either direction. This figure must NOT reach TRA-2268.');
    }
  }

  // 4. The per-book deltas.
  const books = {};
  const bookNames = Object.keys(t1.rollup.books ?? {});
  if (!bookNames.length) refusals.push('T1 carries no `books` partition — refusing to grade a fleet-only rollup (TRA-2645/TRA-2677)');

  for (const book of bookNames) {
    if (notDifferenceable) {
      const banned = differencedPaths(book).filter(p => notDifferenceable.includes(p));
      if (banned.length) {
        refusals.push(`this instrument differences ${banned.join(', ')}, but the authoritative list `
          + `(${notDiffSource}) says those are NOT differenceable — the counter changed shape under the script`);
      }
    }
    const region1 = getPath(t1.rollup, `books.${book}.tickExitRegionMs`);
    const region0 = getPath(t0.rollup, `books.${book}.tickExitRegionMs`);
    if (!region1 || !region0) { refusals.push(`books.${book}.tickExitRegionMs is missing from a read`); continue; }
    const work1 = region1.exitWorkMs;
    const work0 = region0.exitWorkMs;
    if (work1 == null) {
      refusals.push(`books.${book}.tickExitRegionMs.exitWorkMs is ABSENT on T1 — this build predates TRA-3444, `
        + 'so there is no uncensored split to read. Do not substitute the censored tape and call it uncensored');
      continue;
    }
    if (work0 == null) { refusals.push(`books.${book}.tickExitRegionMs.exitWorkMs is ABSENT on T0`); continue; }

    const d = {
      regionSamples: (region1.samples ?? 0) - (region0.samples ?? 0),
      regionMs: (region1.sumMs ?? 0) - (region0.sumMs ?? 0),
      workSamples: (work1.samples ?? 0) - (work0.samples ?? 0),
      workMs: (work1.sumMs ?? 0) - (work0.sumMs ?? 0),
    };
    const negative = Object.entries(d).filter(([, v]) => v < 0);
    if (negative.length) {
      refusals.push(`books.${book}: NEGATIVE delta on ${negative.map(([k, v]) => `${k}=${v}`).join(', ')}`
        + ' — a monotonic counter went backwards, which only happens on a counter reset. Publishing this as a '
        + 'small prefix is the expensive failure; refusing instead');
      continue;
    }
    if (d.regionSamples === 0) {
      refusals.push(`books.${book}: ZERO regions closed in the window — nothing was measured. That is BLIND, `
        + 'not a 0% prefix (a gate satisfiable by the absence of the thing it grades is not a gate)');
      continue;
    }
    if (d.regionMs <= 0) { refusals.push(`books.${book}: region time delta is ${d.regionMs}ms — no denominator`); continue; }
    if (d.workSamples !== d.regionSamples) {
      refusals.push(`books.${book}: sample parity BROKEN — ${d.regionSamples} regions closed but ${d.workSamples} `
        + 'exit-work samples banked. TRA-3444 puts the commit inside `releaseTickExitRegion`\'s idempotency guard '
        + 'so these are 1:1 by construction; a divergence means the two counters are measuring different populations');
      continue;
    }
    if (d.workMs > d.regionMs) {
      refusals.push(`books.${book}: CONTAINMENT BROKEN — exit work ${d.workMs}ms exceeds region ${d.regionMs}ms, `
        + 'so PREFIX is negative. Exit work is measured strictly inside the region and cannot exceed it');
      continue;
    }

    const prefixMs = d.regionMs - d.workMs;
    books[book] = {
      ...d,
      prefixMs,
      prefixShare: prefixMs / d.regionMs,
      residualShare: d.workMs / d.regionMs,
      enabled: getPath(t1.rollup, `books.${book}.enabled`) ?? null,
      armedEngineCount: getPath(t1.rollup, `books.${book}.armedEngineCount`) ?? null,
      notGradeableReason: getPath(t1.rollup, `books.${book}.notGradeableReason`) ?? null,
    };
  }

  // The fleet aggregate is computed for the CROSS-CHECK ONLY and is never an answer.
  let fleet = null;
  const fr1 = t1.rollup.tickExitRegionMs;
  const fr0 = t0.rollup.tickExitRegionMs;
  if (fr1?.exitWorkMs && fr0?.exitWorkMs) {
    const regionMs = (fr1.sumMs ?? 0) - (fr0.sumMs ?? 0);
    const workMs = (fr1.exitWorkMs.sumMs ?? 0) - (fr0.exitWorkMs.sumMs ?? 0);
    if (regionMs > 0 && workMs >= 0 && workMs <= regionMs) {
      fleet = { regionMs, workMs, prefixMs: regionMs - workMs, prefixShare: (regionMs - workMs) / regionMs };
    }
  }

  const publishable = refusals.length === 0 && Object.keys(books).length > 0;
  return {
    verdict: publishable ? 'PUBLISHED' : 'REFUSED',
    source: 'UNCENSORED — /api/health/exit-cadence tickExitRegionMs.exitWorkMs, T0/T1 differenced (TRA-3444)',
    refusals, notes, window, books, fleet,
    notDifferenceable, notDifferenceableSource: notDiffSource,
    reads: [t0, t1].map(r => ({ mark: r.mark, file: r.file, shape: r.shape, at: r.at, process: r.process })),
  };
}

/**
 * The positive control: two independent instruments over the same quantity.
 *
 * Compared as a SHARE, never as seconds — the tape and the T0/T1 pair cover
 * different windows, so their absolute totals are not commensurable but their
 * PREFIX shares are. The censored share is an interval because both terms are
 * intervals: it is widest when PREFIX is smallest against the largest RESIDUAL,
 * and narrowest the other way round.
 *
 * The uncensored figure is fleet-wide here ONLY because the doTick tape is
 * fleet-wide. It is a consistency check, never the published answer (TRA-2645).
 */
function crossCheck(censored, unc) {
  if (!unc?.fleet) return null;
  const { P, R } = censored;
  const loDen = P.lo + R.hi;
  const hiDen = P.hi + R.lo;
  if (!(loDen > 0) || !(hiDen > 0)) return null;
  const lo = P.lo / loDen;
  const hi = P.hi / hiDen;
  const observed = unc.fleet.prefixShare;
  const agrees = observed >= Math.min(lo, hi) - 1e-9 && observed <= Math.max(lo, hi) + 1e-9;
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi), observed, agrees };
}

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
const t0File = valOf('--exit-cadence-t0');
const t1File = valOf('--exit-cadence-t1') ?? valOf('--exit-cadence');
if (t0File && !t1File) {
  console.error('--exit-cadence-t0 requires --exit-cadence-t1: a T0 alone bounds nothing.');
  process.exit(2);
}

if (!censusFile && !t1File) {
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

// ── leg 1: the censored phase tape (optional) ────────────────────────────────
let census = null;
let censored = null;
if (censusFile) {
  try {
    census = loadCensus(censusFile);
  } catch (err) {
    console.error(`cannot read census ${censusFile}: ${err.message}`);
    process.exit(2);
  }

  const nParent = census.parent?.n ?? 0;
  const sumParent = census.parent?.sumS ?? 0;

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
  if (!(nParent > 0)) {
    refusals.push('census carries no signal.doTick parent records; there is no opportunity count, so the '
      + 'censoring upper bound cannot be formed and no share is defensible');
  }
  if (unknown.length) {
    refusals.push(`census names ${unknown.length} phase(s) this source does not emit: ${unknown.slice(0, 6).join(', ')}`
      + ` — the tape and the build under measurement disagree; re-derive against the deployed commit`);
  }
  if (!(censorRatio <= MAX_CENSOR_RATIO)) {
    refusals.push(`censoring interval is ${censorRatio.toFixed(1)}x wide (max ${MAX_CENSOR_RATIO}x): region time is`
      + ` [${f1(regionLo)}s, ${f1(regionHi)}s] at PHASE_TIMING_SLOW_MS=${SLOW_MS}ms`
      + ` — ${R.absentCount}/${tax.residual.length} RESIDUAL and ${P.absentCount}/${tax.prefix.length} PREFIX phases are ABSENT`);
  }

  censored = {
    verdict: refusals.length ? 'REFUSED' : 'PUBLISHED',
    refusals, R, P, O, regionLo, regionHi, censorRatio, nParent, sumParent, unknown,
    // Usable AS A CROSS-CHECK even when its SHARE is refused: a 15.6x-wide interval
    // is a weak bound, but it is a real one. A tape that names phases this build
    // does not emit is measuring a different program and bounds nothing.
    usableForCrossCheck: nParent > 0 && unknown.length === 0 && regionLo > 0,
  };
}

// ── leg 2: the uncensored T0/T1 delta (optional) ─────────────────────────────
let unc = null;
if (t1File) {
  const snapModule = readSnapshotModule(SNAPSHOT_SRC_PATH);
  let t1;
  let t0;
  try {
    t1 = loadCadenceRead(t1File, 'T1');
    t0 = t0File ? loadCadenceRead(t0File, 'T0') : zeroReadAtBoot(t1);
  } catch (err) {
    console.error(`cannot read exit-cadence pair: ${err.message}`);
    process.exit(2);
  }
  unc = gradeUncensored(t0, t1, snapModule);
  if (!t0File) {
    unc.notes.push('T0 is the IMPLICIT ZERO VECTOR at `build.startedAt` — sound only because the counters are '
      + 'cumulative since boot. If the window above is not RTH-contained, this process booted before the open '
      + 'and a real T0/T1 pair (--exit-cadence-t0=) is required.');
  }
}

// ── the combined verdict ─────────────────────────────────────────────────────
const xc = censored?.usableForCrossCheck && unc?.verdict === 'PUBLISHED' ? crossCheck(censored, unc) : null;
const contradiction = xc != null && !xc.agrees;

const verdict = contradiction ? 'REFUSED'
  : unc?.verdict === 'PUBLISHED' ? 'PUBLISHED'
  : censored?.verdict === 'PUBLISHED' ? 'PUBLISHED'
  : 'REFUSED';

// Which source the published number came from, named out loud. A figure whose
// provenance is not stated gets re-used as if it were the other one.
const publishedSource = verdict !== 'PUBLISHED' ? null
  : unc?.verdict === 'PUBLISHED' ? unc.source
  : `CENSORED phase tape (${census.source}) at PHASE_TIMING_SLOW_MS=${SLOW_MS}ms`;

const refusals = [
  ...(contradiction ? [`the two instruments CONTRADICT each other: the uncensored fleet PREFIX share is `
    + `${(xc.observed * 100).toFixed(2)}%, outside the censored tape's interval `
    + `[${(xc.lo * 100).toFixed(2)}%, ${(xc.hi * 100).toFixed(2)}%]. That is not a reason to prefer one — it `
    + 'means one of them is measuring something other than what it claims. Resolve it before publishing either'] : []),
  ...(unc?.refusals ?? []).map(r => `uncensored: ${r}`),
  ...(unc?.verdict === 'PUBLISHED' ? [] : (censored?.refusals ?? []).map(r => `censored: ${r}`)),
];

const report = {
  verdict,
  publishedSource,
  refusals,
  crossCheck: xc,
  uncensored: unc,
  censored: censored && {
    verdict: censored.verdict,
    refusals: censored.refusals,
    source: census.source,
    slowMs: SLOW_MS,
    maxCensorRatio: MAX_CENSOR_RATIO,
    parent: { n: censored.nParent, sumS: censored.sumParent },
    region: { lo: censored.regionLo, hi: censored.regionHi, censorRatio: censored.censorRatio },
    classes: {
      RESIDUAL: { lo: censored.R.lo, hi: censored.R.hi, absent: censored.R.absentCount, of: tax.residual.length, shareOfRegionLo: censored.regionLo > 0 ? censored.R.lo / censored.regionLo : null },
      PREFIX: { lo: censored.P.lo, hi: censored.P.hi, absent: censored.P.absentCount, of: tax.prefix.length, shareOfRegionLo: censored.regionLo > 0 ? censored.P.lo / censored.regionLo : null },
      POST: { lo: censored.O.lo, hi: censored.O.hi, absent: censored.O.absentCount, of: tax.post.length },
    },
    rows: { RESIDUAL: censored.R.rows, PREFIX: censored.P.rows, POST: censored.O.rows },
  },
  taxonomy: tax,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(verdict === 'REFUSED' ? 3 : 0);
}

// ── the uncensored report ────────────────────────────────────────────────────
if (unc) {
  console.log(`TRA-3496 uncensored exit-region split — ${unc.verdict}`);
  console.log(`  source : ${unc.source}`);
  for (const r of unc.reads) {
    console.log(`  ${r.mark.padEnd(2)}     : ${r.at ?? '(no timestamp)'}  pid=${r.process.pid ?? '?'} `
      + `startedAt=${r.process.startedAt ?? '?'} commit=${(r.process.commit ?? '?').slice(0, 12)}`);
    console.log(`           ${r.shape}${r.file === '(implicit)' ? '' : `  <- ${r.file}`}`);
  }
  if (unc.window) {
    console.log(`  window : ${unc.window.spanMin} min${unc.window.insideRth ? ', RTH-contained' : ', NOT RTH-contained'}`);
  }
  console.log(`  notDifferenceable: ${unc.notDifferenceableSource}`
    + `${unc.notDifferenceable ? ` (${unc.notDifferenceable.length} entries, honoured)` : ' — UNRESOLVED'}`);
  console.log();

  const bookNames = Object.keys(unc.books);
  if (bookNames.length) {
    console.log(`  ${'book'.padEnd(6)} ${'regions'.padStart(8)} ${'region'.padStart(11)} ${'exit work'.padStart(11)} `
      + `${'PREFIX'.padStart(11)} ${'PREFIX%'.padStart(9)}`);
    for (const b of bookNames) {
      const v = unc.books[b];
      console.log(`  ${b.padEnd(6)} ${String(v.regionSamples).padStart(8)} ${`${f1(v.regionMs / 1000)}s`.padStart(11)} `
        + `${`${f1(v.workMs / 1000)}s`.padStart(11)} ${`${f1(v.prefixMs / 1000)}s`.padStart(11)} `
        + `${`${(v.prefixShare * 100).toFixed(2)}%`.padStart(9)}`);
    }
    console.log('\n  PREFIX   = region - exit work, EXACTLY. No threshold, no absent-vs-zero, no censoring.');
    console.log('  RESIDUAL = exit work = runEquityExitPass + runOptionsExitPass = what refreshExitsOnly re-runs.');
    for (const b of bookNames) {
      const v = unc.books[b];
      if (v.enabled === false) {
        console.log(`\n  NOTE books.${b}: enabled=false, armedEngineCount=${v.armedEngineCount} — the decoupled `
          + 'hoist is DISARMED on this book. The region timing above is still real (doTick runs regardless); what');
        console.log('       is disarmed is the decoupled pass. Relevant context for TRA-2268, not a reason to discard.');
      }
    }
    console.log('\n  The fleet aggregate is deliberately NOT published (TRA-2645/TRA-2677): a demo engine cannot');
    console.log('  contribute evidence to a real-money criterion. Read books.live for the money book.');
  }
  for (const n of unc.notes) console.log(`\n  ** ${n}`);
  if (unc.refusals.length) {
    console.log('\n  == UNCENSORED READ REFUSED ==');
    for (const r of unc.refusals) console.log(`    * ${r}`);
  }
  console.log();
}

if (xc) {
  console.log(`CROSS-CHECK (positive control) — ${xc.agrees ? 'AGREE' : 'CONTRADICT'}`);
  console.log(`  censored tape PREFIX share interval : [${(xc.lo * 100).toFixed(2)}%, ${(xc.hi * 100).toFixed(2)}%]`);
  console.log(`  uncensored fleet PREFIX share       :  ${(xc.observed * 100).toFixed(2)}%`);
  console.log('  Compared as SHARES, not seconds: the two instruments cover different windows, so their');
  console.log('  absolute totals are not commensurable. The fleet figure is used HERE ONLY, because the');
  console.log('  doTick tape is fleet-wide; it is never the published answer.');
  console.log();
}

if (!censored) {
  if (verdict === 'PUBLISHED') {
    console.log('== PUBLISHED ==');
    console.log(`  source: ${publishedSource}`);
    for (const b of Object.keys(unc.books)) {
      const v = unc.books[b];
      console.log(`  books.${b.padEnd(5)} PREFIX = ${(v.prefixShare * 100).toFixed(2)}% of region  `
        + `(RESIDUAL = ${(v.residualShare * 100).toFixed(2)}%, the floor narrowing cannot reclaim)`);
    }
    console.log('\n  No censored tape was supplied, so the cross-check did not run. Pass --census= to run it.');
  } else {
    console.log('== REFUSED ==');
    for (const r of refusals) console.log(`  * ${r}`);
  }
  process.exit(verdict === 'REFUSED' ? 3 : 0);
}

const { R, P, O, regionLo, regionHi, censorRatio, nParent, sumParent } = censored;

const line = (r) => `    ${r.label.replace('signal.doTick.', '').replace('signal.', '').padEnd(26)} `
  + `${(r.absent ? '<<ABSENT>>' : `n=${r.nObs}`).padStart(11)} `
  + `${(r.absent ? '<<ABSENT>>' : `${f1(r.lo)}s`).padStart(11)} `
  + `<= ${f1(r.hi).padStart(9)}s`;

console.log(`TRA-3443 CENSORED exit-region split (phase tape) — ${censored.verdict}`);
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

if (censored.refusals.length) {
  console.log('== THE CENSORED TAPE REFUSES TO PUBLISH A SHARE ==');
  for (const r of censored.refusals) console.log(`  * ${r}`);
  console.log('\n  The lower bounds above are still on the record and are still true as LOWER BOUNDS.');
  console.log('  What is refused is the SHARE — the number a narrowing decision would lean on.');
  console.log('  A phase absent from the tape is indistinguishable from one that ran every tick at');
  console.log(`  ${SLOW_MS - 1}ms.`);
} else {
  console.log('== THE CENSORED TAPE PUBLISHES ==');
  console.log(`  sum(PREFIX)   = ${pct(P.lo, regionLo)} of region  — reclaimable by narrowing`);
  console.log(`  sum(RESIDUAL) = ${pct(R.lo, regionLo)} of region  — the floor narrowing cannot reclaim`);
  console.log(`  Censoring interval ${censorRatio.toFixed(1)}x, within the ${MAX_CENSOR_RATIO}x bar.`);
}

console.log(`\n================ VERDICT: ${verdict} ================`);
if (verdict === 'PUBLISHED') {
  console.log(`  SOURCE: ${publishedSource}`);
  if (unc?.verdict === 'PUBLISHED') {
    for (const b of Object.keys(unc.books)) {
      const v = unc.books[b];
      console.log(`  books.${b.padEnd(5)} PREFIX = ${(v.prefixShare * 100).toFixed(2)}% of region  `
        + `(RESIDUAL = ${(v.residualShare * 100).toFixed(2)}%, the floor narrowing cannot reclaim)`);
    }
    if (censored.refusals.length) {
      console.log('\n  The censored tape above still refuses, and that refusal is CORRECT for the tape — no');
      console.log('  amount of tape survives a floor at PHASE_TIMING_SLOW_MS. It is not overridden here; it is');
      console.log('  SUPERSEDED by a source that has no floor at all. The published figures come from the');
      console.log('  uncensored counters, never from the lower bounds above.');
    }
  }
} else {
  for (const r of refusals) console.log(`  * ${r}`);
  console.log('\n  Do NOT hand any figure above to TRA-2268 as a criterion.');
}

process.exit(verdict === 'REFUSED' ? 3 : 0);
