#!/usr/bin/env node
/**
 * TRA-2339 — liveness + grade checker for the dark-observation counters.
 *
 * The TRA-2339 defect was that `trims: 0` reads IDENTICALLY in "the throttle
 * never fired" and "the throttle fired on every entry and we were blind to it",
 * because `riskThrottleSizeMultiplier(throttle, armed=false)` returns 1 on its
 * first line, before it ever reads `throttle`. The fix stamps a DECIDED
 * term next to the applied one and counts `wouldTrims` regardless of `armed`.
 *
 * This script is the PROVER for that fix, and it is deliberately a *checker*,
 * not a dated green: a liveness proof is build-scoped and perishes the moment
 * the box redeploys (TRA-2342). Run it again rather than citing a past run.
 *
 * It answers three separate questions and never collapses them:
 *
 *   1. STRUCTURE — does the running build carry the fields at all?
 *      Absent `wouldTrims` on a path that reports `consults` means the box
 *      predates the fix. This is the deploy detector.
 *
 *   2. EXECUTION — has the telemetry ever RUN? `totalConsults: 0` means the
 *      counters are structurally untested no matter how green the code reads.
 *      Counters reset on boot, so a zero here is only ever a statement about
 *      THIS process's uptime — it can prove presence, never absence.
 *
 *   3. SEPARATION — the actual TRA-2339 acceptance test. On at least one
 *      UNARMED path we need `wouldTrims > 0` while `trims === 0`. That is the
 *      pair the old code could not produce, and it is the only observation
 *      that distinguishes the two states the ticket names.
 *
 * Exit codes: 0 = separation proven · 1 = hard fail (structure missing, or an
 * impossible `trims > wouldTrims`) · 2 = INDETERMINATE (live + structurally
 * correct, but not enough traffic yet to separate). 2 is NOT a pass and NOT a
 * failure — it is the honest reading of an unexercised counter, and the whole
 * point of keeping this ticket open.
 *
 * Usage:
 *   node scripts/tra2339-dark-observation-check.mjs
 *   node scripts/tra2339-dark-observation-check.mjs --base https://host --json
 *
 * Auth: reads ADMIN_USERNAME (default "admin") + ADMIN_PASSWORD from the env,
 * falling back to the repo .env. It NEVER writes a credential anywhere.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
};
const JSON_OUT = argv.includes('--json');
const BASE = String(argOf('base', 'https://tradingai-bqb1.onrender.com')).replace(/\/+$/, '');

function loadDotEnv() {
  const out = {};
  try {
    const raw = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    /* no .env is fine — env vars may carry it */
  }
  return out;
}

const dotenv = loadDotEnv();
const USER = process.env.ADMIN_USERNAME || dotenv.ADMIN_USERNAME || 'admin';
const PASS = process.env.ADMIN_PASSWORD || dotenv.ADMIN_PASSWORD || '';

const notes = [];
const note = (s) => {
  notes.push(s);
  if (!JSON_OUT) console.log(s);
};

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 400) };
  }
  return { status: res.status, body, res };
}

async function login() {
  if (!PASS) return null;
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  if (!res.ok) return null;
  const token = body.token || body.accessToken || body.jwt || null;
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = setCookie.map((c) => String(c).split(';')[0]).join('; ');
  return { token, cookie: cookie || null };
}

/** Pull the sizing snapshot out of whatever shape the health payload uses. */
function findSizing(payload) {
  const seen = new Set();
  const stack = [payload];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (
      Object.prototype.hasOwnProperty.call(cur, 'byPath') &&
      (Object.prototype.hasOwnProperty.call(cur, 'totalConsults') ||
        Object.prototype.hasOwnProperty.call(cur, 'armedScope'))
    ) {
      return cur;
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
  }
  return null;
}

const EXIT_FOR = {
  PROVEN: 0,
  NOT_LIVE: 1,
  INVARIANT_VIOLATED: 1,
  INDETERMINATE: 2,
};

/**
 * The whole verdict, as a pure function of the sizing snapshot.
 *
 * Pure on purpose: a checker whose logic only ever runs against the one live
 * box it is checking has never been shown to go RED, and an assertion that
 * cannot fail is decoration. `--selftest` drives this same function through
 * fixtures that MUST come back NOT_LIVE / INDETERMINATE / PROVEN — controlling
 * the grader in both directions before its green reading is worth anything.
 */
export function grade(sizing) {
  const lines = [];
  const byPath = sizing.byPath && typeof sizing.byPath === 'object' ? sizing.byPath : {};
  const paths = Object.entries(byPath);

  // ---- 1. STRUCTURE -------------------------------------------------------
  // Absence of the field is the deploy detector. Grade it on paths that have
  // actually been consulted: an untouched path may be a bare default.
  const consulted = paths.filter(([, s]) => Number(s?.consults || 0) > 0);
  const snapshotHasWould = Object.prototype.hasOwnProperty.call(sizing, 'totalWouldTrims');
  const missingWould = consulted.filter(([, s]) => !Object.prototype.hasOwnProperty.call(s, 'wouldTrims'));
  const structureOk = snapshotHasWould && missingWould.length === 0;

  lines.push(`armedScope=${JSON.stringify(sizing.armedScope ?? null)}`);
  lines.push(
    `structure  totalWouldTrims present=${snapshotHasWould}  consulted paths missing wouldTrims=${missingWould.length}`,
  );

  const structure = {
    ok: structureOk,
    armedScope: sizing.armedScope ?? null,
    snapshotHasTotalWouldTrims: snapshotHasWould,
    pathsMissingWouldTrims: missingWould.map(([p]) => p),
  };

  if (!structureOk) {
    lines.push('FAIL  the running build predates TRA-2339 (or a caller was reverted). Deploy before grading.');
    return { structure, execution: null, separation: null, verdict: 'NOT_LIVE', lines };
  }

  // ---- 2. EXECUTION -------------------------------------------------------
  const totalConsults = Number(sizing.totalConsults || 0);
  const execution = { totalConsults, consultedPaths: consulted.map(([p]) => p) };
  lines.push(`execution  totalConsults=${totalConsults} across ${consulted.length} consulted path(s)`);
  for (const [p, s] of paths) {
    lines.push(
      `  ${p.padEnd(22)} armed=${String(s.armed).padEnd(5)} consults=${String(s.consults ?? 0).padEnd(5)}` +
        ` trims=${String(s.trims ?? 0).padEnd(5)} wouldTrims=${String(s.wouldTrims ?? 'ABSENT').padEnd(5)}` +
        ` minMult=${s.minMultiplier ?? 'null'} minWouldMult=${s.minWouldMultiplier ?? 'null'}` +
        ` lastThrottle=${s.lastThrottle ?? 'null'}`,
    );
  }

  // ---- Invariant: the clamp is shared, so applied can never out-trim decided.
  const impossible = paths.filter(([, s]) => Number(s?.trims || 0) > Number(s?.wouldTrims || 0));
  if (impossible.length) {
    lines.push(`FAIL  invariant violated: trims > wouldTrims on ${impossible.map(([p]) => p).join(', ')}.`);
    lines.push('      The applied and decided terms have drifted apart — a real bug, not a grading gap.');
    return {
      structure,
      execution,
      separation: { proven: false, impossiblePaths: impossible.map(([p]) => p) },
      verdict: 'INVARIANT_VIOLATED',
      lines,
    };
  }

  // ---- 3. SEPARATION ------------------------------------------------------
  const darkCohort = paths.filter(
    ([, s]) => s.armed === false && Number(s.wouldTrims || 0) > 0 && Number(s.trims || 0) === 0,
  );
  if (darkCohort.length) {
    lines.push(`PASS  separation PROVEN on: ${darkCohort.map(([p]) => p).join(', ')}`);
    lines.push('      wouldTrims > 0 with trims === 0 on an unarmed path is exactly the observation');
    lines.push('      the pre-TRA-2339 code could not produce. The dark cohort is now measurable.');
    return {
      structure,
      execution,
      separation: { proven: true, paths: darkCohort.map(([p]) => p) },
      verdict: 'PROVEN',
      lines,
    };
  }

  if (totalConsults === 0) {
    lines.push('INDETERMINATE  the telemetry has never executed in this process (totalConsults=0).');
    lines.push('      Structurally correct and live, but a counter that has not run proves nothing.');
  } else {
    const wouldSum = paths.reduce((a, [, s]) => a + Number(s.wouldTrims || 0), 0);
    lines.push(`INDETERMINATE  telemetry ran (${totalConsults} consults) but wouldTrims total is ${wouldSum}.`);
    lines.push('      The autopilot throttle simply held at 1.0 — no trim decision to observe yet.');
    lines.push('      That is a reading about the market, not about the instrument.');
  }
  return { structure, execution, separation: { proven: false, paths: [] }, verdict: 'INDETERMINATE', lines };
}

/**
 * Red-branch controls. Each fixture must produce a DIFFERENT verdict, and the
 * pre-fix fixture must NOT be gradeable — otherwise the "deploy detector" is
 * detecting nothing.
 */
const SELFTEST_CASES = [
  {
    name: 'pre-TRA-2339 build (no wouldTrims anywhere) => NOT_LIVE',
    expect: 'NOT_LIVE',
    sizing: {
      armedScope: 'demo',
      totalConsults: 40,
      totalTrims: 0,
      byPath: {
        equity_demo: { armed: true, consults: 20, trims: 0, minMultiplier: null, lastThrottle: 0.4 },
        equity_live: { armed: false, consults: 20, trims: 0, minMultiplier: null, lastThrottle: 0.4 },
      },
    },
  },
  {
    name: 'post-fix, never executed => INDETERMINATE',
    expect: 'INDETERMINATE',
    sizing: { armedScope: 'demo', totalConsults: 0, totalTrims: 0, totalWouldTrims: 0, byPath: {} },
  },
  {
    name: 'post-fix, ran but the throttle held at 1.0 => INDETERMINATE (not a pass)',
    expect: 'INDETERMINATE',
    sizing: {
      armedScope: 'demo',
      totalConsults: 30,
      totalTrims: 0,
      totalWouldTrims: 0,
      byPath: {
        equity_live: { armed: false, consults: 30, trims: 0, wouldTrims: 0, minWouldMultiplier: null, lastThrottle: 1 },
      },
    },
  },
  {
    name: 'post-fix, dark path would have trimmed => PROVEN',
    expect: 'PROVEN',
    sizing: {
      armedScope: 'demo',
      totalConsults: 30,
      totalTrims: 0,
      totalWouldTrims: 12,
      byPath: {
        equity_live: {
          armed: false,
          consults: 30,
          trims: 0,
          wouldTrims: 12,
          minMultiplier: null,
          minWouldMultiplier: 0.35,
          lastThrottle: 0.35,
        },
      },
    },
  },
  {
    name: 'applied out-trims decided (clamps drifted) => INVARIANT_VIOLATED',
    expect: 'INVARIANT_VIOLATED',
    sizing: {
      armedScope: 'all',
      totalConsults: 10,
      totalTrims: 5,
      totalWouldTrims: 2,
      byPath: {
        equity_demo: { armed: true, consults: 10, trims: 5, wouldTrims: 2, minMultiplier: 0.5, minWouldMultiplier: 0.5 },
      },
    },
  },
];

function selftest() {
  let failed = 0;
  for (const c of SELFTEST_CASES) {
    const got = grade(c.sizing).verdict;
    const ok = got === c.expect;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.name}${ok ? '' : `  (got ${got})`}`);
  }
  const verdicts = new Set(SELFTEST_CASES.map((c) => c.expect));
  console.log(`\n${SELFTEST_CASES.length - failed}/${SELFTEST_CASES.length} controls pass, ${verdicts.size} distinct verdicts reachable.`);
  if (verdicts.size < 3) {
    console.log('FAIL  the control set does not exercise enough branches to be a control.');
    failed += 1;
  }
  process.exit(failed ? 1 : 0);
}

async function main() {
  if (argv.includes('--selftest')) return selftest();
  const result = {
    issue: 'TRA-2339',
    base: BASE,
    checkedAt: new Date().toISOString(),
    build: null,
    structure: null,
    execution: null,
    separation: null,
    verdict: null,
    notes,
  };

  const ver = await getJson(`${BASE}/api/health/version`);
  if (ver.status !== 200) {
    note(`FAIL  /api/health/version -> HTTP ${ver.status}. Box unreachable; nothing is proven.`);
    result.verdict = 'UNREACHABLE';
    if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  result.build = ver.body;
  note(`build   commit=${ver.body.commitShort || ver.body.commit} pid=${ver.body.pid} uptimeSec=${ver.body.uptimeSec}`);
  note(`        startedAt=${ver.body.startedAt}  <- counters reset here; a 0 below is scoped to THIS uptime only`);

  const auth = await login();
  if (!auth) {
    note('FAIL  could not authenticate (ADMIN_PASSWORD unset or rejected). Set ADMIN_USERNAME/ADMIN_PASSWORD.');
    note('      NOTE: do NOT rotate bqb1 ADMIN_PASSWORD to fix this (TRA-425).');
    result.verdict = 'NO_AUTH';
    if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  const headers = { Accept: 'application/json' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (auth.cookie) headers.Cookie = auth.cookie;

  const live = await getJson(`${BASE}/api/health/live`, headers);
  if (live.status !== 200) {
    note(`FAIL  /api/health/live -> HTTP ${live.status}`);
    result.verdict = 'NO_READ';
    if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const sizing = findSizing(live.body);
  if (!sizing) {
    note('FAIL  no risk-throttle sizing snapshot on /api/health/live — cannot grade.');
    result.verdict = 'NO_SNAPSHOT';
    if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  const graded = grade(sizing);
  Object.assign(result, graded);
  for (const line of graded.lines) note(line);

  if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
  process.exit(EXIT_FOR[graded.verdict] ?? 1);
}

main().catch((err) => {
  console.error('ERROR', err?.stack || err);
  process.exit(1);
});
