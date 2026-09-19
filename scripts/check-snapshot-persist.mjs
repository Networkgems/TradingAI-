#!/usr/bin/env node
/**
 * TRA-3407 (delivery of TRA-2892) — the SNAPSHOT WRITE-AXIS gate.
 *
 * WHAT IT ANSWERS
 * ---------------
 * "Are our snapshot writes landing?" — which is NOT the question
 * `/api/health/storage` answers. That one is the DISK axis: "is there room on
 * the volume". A write can fail on a healthy volume, and through the whole
 * 2026-07-30T23:40:19Z → 2026-08-04T21:20Z ENOSPC incident the disk payload was
 * green on this axis while every single write failed. Five days of total
 * durability loss surfaced as three option rows flickering for ~90 seconds.
 *
 * WHY A SHELL GATE AND NOT JUST THE ROUTE
 * ---------------------------------------
 * `/api/health/storage/detail` has published the raw `adminTradesStocksFile.mtime`
 * the whole time. It 401s without admin auth, it is per-file, and NOTHING GRADES
 * ITS AGE — so nobody looked at it for five days. A timestamp a human must
 * interpret is not an instrument. This is answerable from a shell:
 *
 *   pnpm check:snapshot-persist
 *   pnpm check:snapshot-persist -- --url=https://host/api/health/snapshot-persist
 *   pnpm check:snapshot-persist:controls     # both-direction mutation controls
 *
 * FAILS CLOSED
 * ------------
 * Unreachable host, non-200, unparseable JSON, a payload missing the verdict
 * key, or `stale: null` (NOT MEASURED) all exit non-zero. NEVER 0. A gate that
 * reports green because it could not read anything is worse than no gate — and a
 * `200` that is missing the key is the specific quiet-census failure TRA-3216
 * was bitten by. `stale: null` is NOT MEASURED and is not a pass; it gets its own
 * exit code so "the writer is dead" and "we could not tell" are distinguishable
 * at the shell, which is the distinction this whole issue is about.
 *
 * EXIT CODES
 * ----------
 *   0  CURRENT       every graded row is fresh, over a non-zero denominator
 *   1  STALE         at least one LIVE context's writer is not landing
 *   2  NOT_MEASURED  nothing gradeable, or an unreadable row and no outright red
 *   3  BLIND         could not read the route at all (fail-closed)
 */

const DEFAULT_URL = 'https://tradingai-bqb1.onrender.com/api/health/snapshot-persist';

const EXIT_CURRENT = 0;
const EXIT_STALE = 1;
const EXIT_NOT_MEASURED = 2;
const EXIT_BLIND = 3;

/**
 * Grade a payload. PURE — no I/O — so `--selftest` drives the identical code the
 * live run does. A checker whose selftest exercises a different branch than
 * production is a checker with no controls.
 *
 * Returns `{ code, lines }`.
 */
export function gradePayload(payload) {
  const lines = [];

  if (payload === null || typeof payload !== 'object') {
    return { code: EXIT_BLIND, lines: ['BLIND — payload is not an object'] };
  }

  // A 200 that does not carry the verdict key is a CENSUS FAILURE, not a pass.
  // `'stale' in payload` and not `payload.stale === undefined`, because `null`
  // is a legitimate value here (NOT MEASURED) and `undefined` is the route
  // having not shipped / having been renamed.
  if (!('stale' in payload)) {
    return {
      code: EXIT_BLIND,
      lines: ['BLIND — payload has no `stale` key (route not deployed, or renamed)'],
    };
  }
  if (typeof payload.gradedRowCount !== 'number') {
    return { code: EXIT_BLIND, lines: ['BLIND — payload has no numeric `gradedRowCount` denominator'] };
  }

  const {
    stale,
    gradedRowCount,
    staleRowCount = 0,
    currentRowCount = 0,
    notMeasuredRowCount = 0,
    idleRowCount = 0,
    contextCount = null,
    staleRows = [],
    notMeasuredRows = [],
  } = payload;

  // THE DENOMINATOR, always printed. `stale: false` over 0 rows and over 122 rows
  // are different claims and without this line they are the same reading.
  lines.push(
    `graded=${gradedRowCount} (stale=${staleRowCount} current=${currentRowCount} ` +
      `notMeasured=${notMeasuredRowCount}) idle=${idleRowCount} contexts=${contextCount ?? '?'}`,
  );

  if (stale === true) {
    lines.push(`STALE — ${staleRowCount} live writer(s) not landing:`);
    for (const r of staleRows) {
      lines.push(
        `  ${r.username}/${r.axis}: reason=${r.reason} fileAgeSec=${r.fileAgeSec} ` +
          `budgetSec=${r.budgetSec} consecutiveFailures=${r.consecutiveFailures}`,
      );
    }
    return { code: EXIT_STALE, lines };
  }

  if (stale === null) {
    lines.push('NOT MEASURED — this is NOT a pass.');
    if (gradedRowCount === 0) {
      lines.push('  nothing gradeable: no LIVE context on either axis.');
    }
    for (const r of notMeasuredRows) {
      lines.push(`  ${r.username}/${r.axis}: reason=${r.reason} (on-disk mtime unreadable)`);
    }
    return { code: EXIT_NOT_MEASURED, lines };
  }

  if (stale === false) {
    // Defence in depth against a fold that returns `false` over an empty cohort
    // (`[].every()` is `true` — the TRA-2630 shape). Even if the server-side fold
    // regressed, the gate refuses to call a zero-denominator green a pass.
    if (gradedRowCount === 0) {
      lines.push('NOT MEASURED — `stale:false` over a ZERO denominator is not a pass.');
      return { code: EXIT_NOT_MEASURED, lines };
    }
    lines.push(`CURRENT — ${currentRowCount} live writer(s) landing inside budget.`);
    return { code: EXIT_CURRENT, lines };
  }

  return { code: EXIT_BLIND, lines: [`BLIND — \`stale\` is ${JSON.stringify(stale)}, not true/false/null`] };
}

async function main(argv) {
  const urlArg = argv.find((a) => a.startsWith('--url='));
  const url = urlArg ? urlArg.slice('--url='.length) : DEFAULT_URL;
  console.log(`[check:snapshot-persist] GET ${url}`);

  let payload;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      console.log(`BLIND — HTTP ${res.status} ${res.statusText}`);
      return EXIT_BLIND;
    }
    payload = await res.json();
  } catch (err) {
    // Unreachable, DNS, timeout, non-JSON body. All BLIND, never 0.
    console.log(`BLIND — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_BLIND;
  }

  const { code, lines } = gradePayload(payload);
  for (const l of lines) console.log(l);
  console.log(`[check:snapshot-persist] exit=${code}`);
  return code;
}

/**
 * BOTH-DIRECTION CONTROLS. Every case asserts the gate can reach the verdict AND
 * that a green is not reachable from a payload that should be red — a control
 * suite that only feeds it healthy payloads proves nothing.
 */
function selftest() {
  let failures = 0;
  const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${actual}, want ${expected})`);
  };

  const healthy = {
    stale: false,
    verdict: 'CURRENT',
    gradedRowCount: 4,
    staleRowCount: 0,
    currentRowCount: 4,
    notMeasuredRowCount: 0,
    idleRowCount: 118,
    contextCount: 61,
    staleRows: [],
    notMeasuredRows: [],
  };
  check('healthy fleet ⇒ CURRENT', gradePayload(healthy).code, EXIT_CURRENT);

  // THE FAILING DIRECTION. One book's writer is throwing.
  check(
    'one live writer failing ⇒ STALE',
    gradePayload({
      ...healthy,
      stale: true,
      verdict: 'STALE',
      staleRowCount: 1,
      currentRowCount: 3,
      staleRows: [
        {
          username: 'enock',
          axis: 'stocks',
          reason: 'persist-failing',
          fileAgeSec: 4.1,
          budgetSec: 300,
          consecutiveFailures: 7,
        },
      ],
    }).code,
    EXIT_STALE,
  );

  // The five-day ENOSPC shape as the ROUTE would have reported it: nothing in
  // process failed to be counted, the file simply stopped moving.
  check(
    'live box, file frozen past budget ⇒ STALE',
    gradePayload({
      ...healthy,
      stale: true,
      verdict: 'STALE',
      staleRowCount: 4,
      currentRowCount: 0,
      staleRows: [
        { username: 'admin', axis: 'stocks', reason: 'file-age', fileAgeSec: 432000, budgetSec: 300, consecutiveFailures: 0 },
      ],
    }).code,
    EXIT_STALE,
  );

  check(
    'unreadable mtime ⇒ NOT MEASURED, never CURRENT',
    gradePayload({
      ...healthy,
      stale: null,
      verdict: null,
      gradedRowCount: 4,
      currentRowCount: 3,
      notMeasuredRowCount: 1,
      notMeasuredRows: [{ username: 'admin', axis: 'stocks', reason: 'file-unreadable' }],
    }).code,
    EXIT_NOT_MEASURED,
  );

  check(
    'quiet box, zero graded rows ⇒ NOT MEASURED, not a pass',
    gradePayload({ ...healthy, stale: null, verdict: null, gradedRowCount: 0, currentRowCount: 0, idleRowCount: 122 }).code,
    EXIT_NOT_MEASURED,
  );

  // THE `[].every()` SHAPE. Even if the server-side fold regressed to `false`
  // over an empty cohort, the gate must not print a pass.
  check(
    'stale:false over a ZERO denominator ⇒ NOT MEASURED (not a pass)',
    gradePayload({ ...healthy, stale: false, gradedRowCount: 0, currentRowCount: 0 }).code,
    EXIT_NOT_MEASURED,
  );

  // FAIL-CLOSED shapes.
  check('200 with no `stale` key ⇒ BLIND', gradePayload({ issue: 'TRA-3407', ok: true }).code, EXIT_BLIND);
  check('no denominator ⇒ BLIND', gradePayload({ stale: false }).code, EXIT_BLIND);
  check('non-object payload ⇒ BLIND', gradePayload('CURRENT').code, EXIT_BLIND);
  check('null payload ⇒ BLIND', gradePayload(null).code, EXIT_BLIND);
  check('`stale` is a string ⇒ BLIND', gradePayload({ stale: 'false', gradedRowCount: 4 }).code, EXIT_BLIND);

  // The negative control ON THE CONTROLS: a gate hardcoded to 0 would pass every
  // healthy case above. These assert the non-zero codes are actually reachable
  // and DISTINCT, so `STALE` and `NOT MEASURED` cannot be conflated at the shell.
  const distinct = new Set([EXIT_CURRENT, EXIT_STALE, EXIT_NOT_MEASURED, EXIT_BLIND]);
  check('four distinct exit codes', distinct.size, 4);

  console.log(failures === 0 ? '\nAll controls PASS' : `\n${failures} control(s) FAILED`);
  return failures === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
const run = argv.includes('--selftest')
  ? Promise.resolve(selftest())
  : main(argv);
run.then((code) => process.exit(code));
