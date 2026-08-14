#!/usr/bin/env node
// TRA-2519 — grade one sentiment-capture partition against the TRA-2519 ratchet fix.
//
// WHY THIS EXISTS AS A SCRIPT RATHER THAN A HAND-READ CURL
// -------------------------------------------------------
// The acceptance read for `b7dd483` ("did the ratchet + reason-labelling code
// actually run in a real sweep window?") is a key-PRESENCE check on a live JSON
// artifact. Hand-reading it gets two things wrong, both of which manufacture a
// false FAIL:
//
//   1. THE GRADER'S CLIFF PREDATES THE FIELD IT GRADES. Every partition written
//      before the first boot carrying `b7dd483` is *structurally incapable* of
//      holding `attempts` / `sweptRecorded` / `preservedFromPrior` / `reasons`.
//      2026-07-24, -27, -28 and -29 are all in that population. Grading them on
//      key presence reads FAIL on days the fix could not possibly have touched.
//      So the first thing this script does is split on the carrier boot and
//      answer PRE-FIELD (exit 4) — never FAIL — for pre-cliff rows.
//   2. THE ROW-LEVEL `reason` IS NOT IN `_meta.json`. `_meta.perSymbol[]` is
//      projected down to `{symbol, outcome}` by the recorder itself
//      (`sentiment-snapshot-recorder.ts:322`) — it drops `reason`. The per-row
//      reason lives in `sentiment.json`'s `symbols[]`, and the aggregate lives in
//      `_meta.reasons`. Checking `perSymbol` for a reason fails 100% of the time
//      on correct output.
//
// USAGE
//   node scripts/grade-sentiment-partition.mjs 2026-07-30
//   node scripts/grade-sentiment-partition.mjs 2026-07-30 --host=https://tradingai-bqb1.onrender.com
//   node scripts/grade-sentiment-partition.mjs --file=./partition.json   # graded offline
//   node scripts/grade-sentiment-partition.mjs --selftest                # controls
//
// EXIT CODES (four, deliberately distinct — a zero must mean one thing only)
//   0  PASS       — post-cliff write, all four meta keys, every non-recorded row attributed
//   1  FAIL       — post-cliff write missing the instrument: the new code did not run
//   3  ABSENT     — no partition for that date (pre-window / never swept). BLIND, not a pass.
//   4  PRE-FIELD  — partition predates the first carrying boot: NOT GRADEABLE either way
//   2  ERROR      — transport/parse failure. Fails closed, never 0.
//
// `recorded: 0` is NOT a failure. An attributable zero (`reasons: {breaker_open: 25}`)
// is the fix working — that is the entire point of the commit. The accrual question
// (does this day count toward TRA-820 Step-1's 20 usable days?) is reported
// separately from the instrument verdict, because they have different answers.

const DEFAULT_HOST = 'https://tradingai-bqb1.onrender.com';

// The first Render deploy whose commit carries `b7dd483`, per
// `GET /v1/services/srv-d7mb7rr7uimc73ev0chg/deploys` cross-checked with
// `git merge-base --is-ancestor b7dd483 <deploy sha>` over the last 100 deploys:
// deploy of `d12d19ab`, finished 2026-07-30T00:29:50.769Z. The preceding deploy
// (`9e1b1123`, 07-29T12:57:54Z) does not carry it, so the cliff is exact, not a
// bracket. Override with --carrier-boot=<iso> if the fix is ever re-based.
//
// ⚠ IF YOU RE-RUN THAT CROSS-CHECK BY HAND, DO IT ON A COMPLETE CLONE (TRA-3722).
// This file imports no `child_process`; the command above is an instruction to a HUMAN,
// which is exactly why it carries no screen. `merge-base --is-ancestor` exits **1** both
// for "that deploy genuinely does not carry b7dd483" and for "a shallow clone grafted the
// path between them away" — same exit code, no stderr — and `cat-file -e` does not screen
// it, because in the grafted state BOTH shas resolve and it is the history BETWEEN them
// that is gone. A shallow checkout is the default shape of a fresh CI or agent workspace,
// so the bare loop would silently walk the cliff DOWN the history and re-date it later
// than it is. Check first:
//     git rev-parse --is-shallow-repository   # must print false
//     git fetch origin --unshallow            # if it does not
// Everything in this repo that runs the predicate in CODE now routes the negative through
// scripts/lib/shallow-ancestry.mjs (`gradedAncestry`) instead of believing it.
const FIRST_CARRYING_BOOT_MS = Date.parse('2026-07-30T00:29:50.769Z');

const META_KEYS = ['attempts', 'sweptRecorded', 'preservedFromPrior', 'reasons'];
const VALID_REASONS = new Set(['breaker_open', 'fetch_failed']);

function parseArgs(argv) {
  const out = { date: null, host: DEFAULT_HOST, file: null, selftest: false, carrierBootMs: FIRST_CARRYING_BOOT_MS };
  for (const arg of argv) {
    if (arg === '--selftest') out.selftest = true;
    else if (arg.startsWith('--host=')) out.host = arg.slice(7).replace(/\/$/, '');
    else if (arg.startsWith('--file=')) out.file = arg.slice(7);
    else if (arg.startsWith('--carrier-boot=')) {
      const ms = Date.parse(arg.slice(15));
      if (Number.isNaN(ms)) throw new Error(`--carrier-boot is not a parseable date: ${arg}`);
      out.carrierBootMs = ms;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) out.date = arg;
    else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
  }
  return out;
}

/**
 * Grade a partition payload — the exact shape
 * `GET /api/health/sentiment-capture/partition/:date` returns. Pure, so the
 * controls below exercise the same code path the live read does.
 */
export function gradePartition(payload, carrierBootMs = FIRST_CARRYING_BOOT_MS) {
  const lines = [];
  const meta = payload?.meta ?? null;
  const rows = Array.isArray(payload?.sentiment?.symbols) ? payload.sentiment.symbols : null;

  if (meta === null && rows === null) {
    return { verdict: 'ABSENT', code: 3, lines: ['no `meta` and no `sentiment.symbols` in payload'] };
  }

  // --- the cliff split, BEFORE any key check ------------------------------
  const writtenAtMs = Number(meta?.recordedAt ?? payload?.sentiment?.recordedAt ?? NaN);
  if (!Number.isFinite(writtenAtMs)) {
    return { verdict: 'ERROR', code: 2, lines: ['no `recordedAt` on either artifact — cannot place the write against the carrier boot'] };
  }
  lines.push(`write  : recordedAt ${new Date(writtenAtMs).toISOString()}`);
  lines.push(`cliff  : first carrying boot ${new Date(carrierBootMs).toISOString()}`);
  if (writtenAtMs < carrierBootMs) {
    const hrs = ((carrierBootMs - writtenAtMs) / 3_600_000).toFixed(2);
    lines.push(`         write precedes the carrier boot by ${hrs}h — the fields did not exist yet`);
    return { verdict: 'PRE-FIELD', code: 4, lines };
  }

  // --- the instrument ------------------------------------------------------
  const missing = META_KEYS.filter((k) => meta === null || !(k in meta));
  lines.push(`meta   : ${META_KEYS.length - missing.length}/${META_KEYS.length} keys present${missing.length ? ` — MISSING ${missing.join(', ')}` : ''}`);

  if (rows === null) {
    lines.push('rows   : sentiment.symbols is absent or not an array');
    return { verdict: 'FAIL', code: 1, lines };
  }
  // Count the rows checked and fail at zero: an empty universe would otherwise
  // satisfy "every non-recorded row is attributed" vacuously and read PASS.
  if (rows.length === 0) {
    lines.push('rows   : 0 rows in the partition — nothing to grade, refusing to pass vacuously');
    return { verdict: 'FAIL', code: 1, lines };
  }

  const nonRecorded = rows.filter((r) => r?.outcome !== 'recorded');
  const unattributed = nonRecorded.filter((r) => !VALID_REASONS.has(r?.reason));
  lines.push(
    `rows   : ${rows.length} total · ${rows.length - nonRecorded.length} recorded · ${nonRecorded.length} non-recorded` +
      (nonRecorded.length === 0
        ? ' (reason arm VACUOUS this day — nothing unrecorded to attribute)'
        : ` · ${nonRecorded.length - unattributed.length}/${nonRecorded.length} attributed`),
  );
  if (unattributed.length > 0) {
    const sample = unattributed.slice(0, 5).map((r) => `${r?.symbol ?? '?'}=${JSON.stringify(r?.reason)}`).join(' ');
    lines.push(`         UNATTRIBUTED: ${sample}${unattributed.length > 5 ? ` …+${unattributed.length - 5}` : ''}`);
  }

  const verdictFail = missing.length > 0 || unattributed.length > 0;
  return { verdict: verdictFail ? 'FAIL' : 'PASS', code: verdictFail ? 1 : 0, lines };
}

/** The accrual question, reported separately from the instrument verdict. */
function accrualLines(payload) {
  const meta = payload?.meta ?? {};
  const rows = Array.isArray(payload?.sentiment?.symbols) ? payload.sentiment.symbols : [];
  const recorded = rows.filter((r) => r?.outcome === 'recorded').length;
  const out = [
    `accrual: recorded ${recorded}/${rows.length}` +
      ` · usable-day for TRA-820 Step-1: ${recorded > 0 ? `YES (${recorded} symbols)` : 'NO (zero capture)'}`,
    `ratchet: attempts=${JSON.stringify(meta.attempts)}` +
      ` sweptRecorded=${JSON.stringify(meta.sweptRecorded)}` +
      ` preservedFromPrior=${Array.isArray(meta.preservedFromPrior) ? meta.preservedFromPrior.length : JSON.stringify(meta.preservedFromPrior)}`,
    `reasons: ${JSON.stringify(meta.reasons ?? null)}`,
  ];
  // sweptRecorded < recorded is the merge having protected an earlier read — the
  // exact gap the old blind overwrite destroyed silently.
  if (typeof meta.sweptRecorded === 'number' && meta.sweptRecorded < recorded) {
    out.push(`         ⭐ merge SAVED ${recorded - meta.sweptRecorded} symbol-day(s) a late sweep would have erased pre-fix`);
  }
  return out;
}

// --- controls: the verdicts must each be reachable ------------------------
const POST = FIRST_CARRYING_BOOT_MS + 60_000;
const PRE = FIRST_CARRYING_BOOT_MS - 60_000;
const row = (symbol, outcome, reason) => ({ symbol, outcome, sentiment: null, ...(reason ? { reason } : {}) });
const CONTROLS = [
  {
    name: 'post-cliff, new format, attributable zero',
    expect: 'PASS',
    payload: {
      meta: { recordedAt: POST, attempts: 3, sweptRecorded: 0, preservedFromPrior: [], reasons: { breaker_open: 2 } },
      sentiment: { recordedAt: POST, symbols: [row('AAPL', 'no_data', 'breaker_open'), row('MSFT', 'no_data', 'breaker_open')] },
    },
  },
  {
    name: 'post-cliff, OLD format (pre-fix code ran in a post-fix window)',
    expect: 'FAIL',
    payload: {
      meta: { recordedAt: POST, symbolCount: 2, recorded: 0, noData: 2 },
      sentiment: { recordedAt: POST, symbols: [row('AAPL', 'no_data'), row('MSFT', 'no_data')] },
    },
  },
  {
    name: 'post-cliff, meta keys present but rows UNATTRIBUTED (describeUnavailable unwired)',
    expect: 'FAIL',
    payload: {
      meta: { recordedAt: POST, attempts: 1, sweptRecorded: 0, preservedFromPrior: [], reasons: { unspecified: 2 } },
      sentiment: { recordedAt: POST, symbols: [row('AAPL', 'no_data'), row('MSFT', 'no_data')] },
    },
  },
  {
    name: 'post-cliff, new format but ZERO rows (vacuous-pass guard)',
    expect: 'FAIL',
    payload: {
      meta: { recordedAt: POST, attempts: 1, sweptRecorded: 0, preservedFromPrior: [], reasons: {} },
      sentiment: { recordedAt: POST, symbols: [] },
    },
  },
  {
    name: 'PRE-cliff, old format — must NOT be graded FAIL',
    expect: 'PRE-FIELD',
    payload: {
      meta: { recordedAt: PRE, symbolCount: 2, recorded: 0, noData: 2 },
      sentiment: { recordedAt: PRE, symbols: [row('AAPL', 'no_data'), row('MSFT', 'no_data')] },
    },
  },
  {
    name: 'PRE-cliff, fully recorded day (2026-07-24 shape) — also NOT GRADEABLE',
    expect: 'PRE-FIELD',
    payload: {
      meta: { recordedAt: PRE, symbolCount: 2, recorded: 2, noData: 0 },
      sentiment: { recordedAt: PRE, symbols: [row('AAPL', 'recorded'), row('MSFT', 'recorded')] },
    },
  },
  { name: 'no partition at all', expect: 'ABSENT', payload: { error: 'partition not found', date: '2026-07-31' } },
];

function selftest() {
  let failures = 0;
  for (const c of CONTROLS) {
    const got = gradePartition(c.payload).verdict;
    const ok = got === c.expect;
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  expect=${c.expect.padEnd(9)} got=${got.padEnd(9)} ${c.name}`);
  }
  const reached = new Set(CONTROLS.map((c) => c.expect));
  for (const v of ['PASS', 'FAIL', 'PRE-FIELD', 'ABSENT']) {
    if (!reached.has(v)) {
      failures += 1;
      console.log(`FAIL  verdict ${v} has no control — it may be unreachable`);
    }
  }
  console.log(`\n${failures === 0 ? 'SELFTEST PASS' : `SELFTEST FAIL (${failures})`} — ${CONTROLS.length} controls, 4 verdicts reachable`);
  return failures === 0 ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) process.exit(selftest());

  let payload;
  let source;
  if (args.file) {
    const { readFile } = await import('node:fs/promises');
    source = args.file;
    payload = JSON.parse(await readFile(args.file, 'utf-8'));
  } else {
    if (!args.date) {
      console.error('usage: grade-sentiment-partition.mjs <YYYY-MM-DD> [--host=…] | --file=… | --selftest');
      process.exit(2);
    }
    source = `${args.host}/api/health/sentiment-capture/partition/${args.date}`;
    let res;
    try {
      res = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      console.log(`source : ${source}\nERROR  : ${err instanceof Error ? err.message : String(err)}`);
      console.log('\nVERDICT: ERROR (fails closed — an unreachable route is never a pass)');
      process.exit(2);
    }
    const text = await res.text();
    try {
      payload = JSON.parse(text);
    } catch {
      console.log(`source : ${source}\nERROR  : HTTP ${res.status}, body is not JSON: ${text.slice(0, 200)}`);
      process.exit(2);
    }
    if (res.status === 404) {
      console.log(`source : ${source}\nstatus : 404 ${JSON.stringify(payload)}`);
      console.log('\nVERDICT: ABSENT (no partition for this date — BLIND, not a pass)');
      process.exit(3);
    }
  }

  const result = gradePartition(payload, args.carrierBootMs);
  console.log(`source : ${source}`);
  for (const line of result.lines) console.log(line);
  if (result.verdict === 'PASS' || result.verdict === 'FAIL') for (const line of accrualLines(payload)) console.log(line);
  console.log(`\nVERDICT: ${result.verdict}`);
  process.exit(result.code);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
