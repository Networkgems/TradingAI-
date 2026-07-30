#!/usr/bin/env node
/**
 * TRA-2420 — attribute the unowned ~3.6 MB per trading day on bqb1's `/data`.
 *
 * TRA-2417 measured `/data` growing ~11.6 MB per trading day (~0 on weekends)
 * and attributed it to the TRA-779 option-chain capture. Measured directly, the
 * real 2026-07-24 partition is **8.02 MB** and the sentiment snapshots are
 * **0.008 MB** — leaving ~3.6 MB/day with no owner. A total minus one measured
 * component is not an attribution; it is a residual, and this script turns the
 * residual into a ranked list of named writers.
 *
 * ## Why this is a script and not a curl
 *
 * Every failure mode here reads like an answer:
 *
 *   - **Not deployed.** `/api/health/storage` 200s on the old build too — it
 *     just has no `usage` key. `jq '.usage.entries[0].bytes'` prints `null`,
 *     which compares false-y exactly like a real zero. Exit 2, never a verdict.
 *   - **The wrong histogram.** `modifiedBytesByDay` is the obvious one to read
 *     and it is the wrong one. A per-user snapshot rewritten in place every
 *     session contributes its ENTIRE size there every day while adding nothing
 *     to the volume — a big, plausible, wrong answer. Growth is
 *     `createdBytesByDay`; this script grades on that and prints the other only
 *     as contrast.
 *   - **Birthtime unusable.** On a filesystem without statx birth support the
 *     route publishes `createdBytesByDay: null`. That is exit 4 PARTIAL — the
 *     day's growth is unmeasurable, which is not the same as zero growth.
 *   - **A day that has not happened yet.** Today's partial day, a weekend, and
 *     a day where the writer genuinely stopped are all "small number". The
 *     graded day is the most recent COMPLETE weekday inside the window, and a
 *     zero total across every entry is NOT_GRADEABLE, never "nothing grew".
 *   - **A truncated or lossy scan.** `truncated` or a non-empty `errors` list
 *     makes every byte figure a floor. Floors do not get published as totals.
 *   - **A unit-mismatched residual.** THIS ONE SHIPPED (fixed 2026-07-30). The
 *     `unaccounted` guard below compared APPARENT bytes (`st_size`, what the walk
 *     sums) against `df`-used, which is ALLOCATED blocks PLUS the root reserve.
 *     On bqb1 those differ structurally by ~150 MB — ~100 MB of 4 KiB block
 *     rounding across ~48k small files, plus ext4's ~49 MB 5% reserve — so the
 *     residual read 35% and this script exited 1 UNATTRIBUTED on every run. No
 *     state of the real disk could have produced a pass: the guard was reading a
 *     constant. A working script and a broken one were byte-identical in output.
 *     Both sides are now allocated bytes, with the reserve subtracted because no
 *     writer owns it.
 *
 * Exit codes
 *   0  ATTRIBUTED     a complete weekday's growth, ranked by writer
 *   1  UNATTRIBUTED   deployed and measured, but the breakdown does not account
 *                     for the disk (large `unaccounted.pct`)
 *   2  NOT_DEPLOYED   200 without the `usage` key — the old build
 *   3  BLIND          unreachable / non-200 / unparseable / truncated / errors
 *   4  PARTIAL        deployed, but the growth histogram is unmeasurable, the
 *                     residual is ungradeable (allocation unusable / null), or the
 *                     window holds no complete weekday with any growth
 *
 * ## Controls
 *
 * `--self-test` drives this same script over a real socket against seven crafted
 * payloads and asserts every one of the five exit codes is REACHABLE. Without it, a
 * script that exits 2 on everything is indistinguishable from a working one, because
 * 2 is the only answer the live host can give until the deploy carrying `usage` lands.
 *
 * One control is the regression above: bqb1's real shape, where the apparent-basis
 * residual is 35% and the allocated-basis residual is ~9%. It must exit 0. Asserting
 * only that the codes DIFFER is not enough — two controls may legitimately share a
 * code, and the pre-fix script passed a distinctness check while being unable to
 * return 0 for any real disk.
 *
 * Usage
 *   node scripts/tra2420-data-dir-attribution.mjs [--host=…] [--day=YYYY-MM-DD]
 *                                                 [--max-unaccounted-pct=25]
 *   node scripts/tra2420-data-dir-attribution.mjs --self-test
 */

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const HOST = arg('host') ?? 'https://tradingai-bqb1.onrender.com';
const FORCE_DAY = arg('day') ?? null;
const MAX_UNACCOUNTED_PCT = Number(arg('max-unaccounted-pct') ?? '25');

const EXIT = { ATTRIBUTED: 0, UNATTRIBUTED: 1, NOT_DEPLOYED: 2, BLIND: 3, PARTIAL: 4 };
const MB = (b) => `${(b / 1048576).toFixed(3)} MB`;

function done(code, label, lines) {
  console.log(`\n[TRA-2420] ${label} (exit ${code})`);
  for (const l of lines) console.log(`  ${l}`);
  process.exit(code);
}

/** Sat/Sun in UTC. The residual is trading-day shaped; a weekend zero is expected, not evidence. */
function isWeekend(day) {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

async function main() {
  let res;
  try {
    res = await fetch(`${HOST}/api/health/storage`, { signal: AbortSignal.timeout(45_000) });
  } catch (err) {
    done(EXIT.BLIND, 'BLIND — /api/health/storage unreachable', [String(err?.message ?? err)]);
  }
  if (!res.ok) done(EXIT.BLIND, `BLIND — /api/health/storage returned ${res.status}`, []);

  let body;
  try {
    body = await res.json();
  } catch (err) {
    done(EXIT.BLIND, 'BLIND — /api/health/storage body did not parse', [String(err?.message ?? err)]);
  }

  const usage = body?.usage;
  // Key-in-body deploy detector: the old build answers 200 on this same route.
  if (!usage || !Array.isArray(usage.entries)) {
    done(EXIT.NOT_DEPLOYED, 'NOT_DEPLOYED — 200 but no `usage` block on /api/health/storage', [
      `host      ${HOST}`,
      `disk      ${body?.disk?.freePct ?? '?'}% free`,
      'The TRA-2420 breakdown is not on this build. Deploy, then re-run.',
    ]);
  }

  const ctx = [
    `host        ${HOST}`,
    `dataDir     ${usage.root}`,
    `scannedAt   ${usage.scannedAt} (${usage.durationMs} ms, ${usage.totalFiles} files)`,
    `measured    ${MB(usage.totalBytes)} apparent / ${
      typeof usage.totalAllocatedBytes === 'number' ? MB(usage.totalAllocatedBytes) : 'unmeasurable'
    } allocated across ${usage.entries.length} top-level entries`,
    `disk        ${MB(body?.disk?.usedBytes ?? 0)} used (${MB(
      body?.disk?.reservedBytes ?? 0,
    )} root-reserved), ${body?.disk?.freePct ?? '?'}% free`,
  ];

  if (usage.truncated) {
    done(EXIT.BLIND, 'BLIND — the scan hit its file cap; every byte figure is a floor', ctx);
  }
  if (Array.isArray(usage.errors) && usage.errors.length > 0) {
    done(EXIT.BLIND, 'BLIND — part of the tree was unreadable, so the total is short by an unknown amount', [
      ...ctx,
      ...usage.errors.slice(0, 5).map((e) => `unreadable  ${e.path} — ${e.reason}`),
    ]);
  }

  // TRA-2420 — the residual is only meaningful if BOTH sides are allocated bytes.
  // `allocation.usable: false` means the filesystem declined to report `st_blocks`,
  // which makes the residual unknown — NOT small, and not a licence to fall back to
  // the apparent figure, whose gap on this volume is ~150 MB of block rounding plus
  // root reserve. That fallback is what made this script exit 1 unconditionally.
  if (!usage.allocation?.usable || typeof usage.totalAllocatedBytes !== 'number') {
    done(EXIT.PARTIAL, 'PARTIAL — allocated bytes are unmeasurable, so the residual cannot be graded', [
      ...ctx,
      `allocation  sampled ${usage.allocation?.sampledPaths ?? 0}, answered ${
        usage.allocation?.answeredPaths ?? 0
      }, non-empty ${usage.allocation?.nonEmptyPaths ?? 0}`,
      'Only apparent (st_size) bytes are available. Grading the residual on those',
      'counts block rounding and the root reserve as an unowned writer.',
    ]);
  }

  const unaccountedPct = usage.unaccounted?.pct;
  if (typeof unaccountedPct !== 'number') {
    done(EXIT.PARTIAL, 'PARTIAL — the residual is null, so the breakdown cannot be checked against the disk', [
      ...ctx,
      `unaccounted ${JSON.stringify(usage.unaccounted ?? null)}`,
      'statfs did not answer, or the reserve is unknown. A null residual is not a small one.',
    ]);
  }
  if (unaccountedPct > MAX_UNACCOUNTED_PCT) {
    done(EXIT.UNATTRIBUTED, `UNATTRIBUTED — ${unaccountedPct}% of the used disk is outside this breakdown`, [
      ...ctx,
      `attributable ${MB(usage.unaccounted.attributableUsedBytes)} used less root reserve`,
      `unaccounted ${MB(usage.unaccounted.bytes)} (${unaccountedPct}%, limit ${MAX_UNACCOUNTED_PCT}%)`,
      `contrast    apparent-basis residual would read ${usage.unaccounted.apparent?.pct ?? '?'}% — unit-mismatched, do not grade on it`,
      'Something on the volume is not under DATA_DIR. Ranking the entries below would',
      'name a writer for the wrong bytes.',
    ]);
  }

  if (!usage.birthtime?.usable) {
    done(EXIT.PARTIAL, 'PARTIAL — birthtime is unusable on this volume, so per-day GROWTH is unmeasurable', [
      ...ctx,
      `birthtime   sampled ${usage.birthtime?.sampledFiles ?? 0}, missing ${usage.birthtime?.missing ?? 0}`,
      'Only `modifiedBytesByDay` is available, and an in-place rewriter dominates it.',
      'That is activity, not growth — it must not be published as the attribution.',
    ]);
  }

  const growthOn = (day) =>
    usage.entries.reduce((n, e) => n + (e.createdBytesByDay?.[day] ?? 0), 0);

  // Today is partial and a weekend is expected-flat; both are small numbers that
  // read like "the writer stopped". Grade the most recent COMPLETE weekday that
  // actually shows growth, and say which one that was.
  const today = usage.days[0];
  const candidates = FORCE_DAY
    ? [FORCE_DAY]
    : usage.days.filter((d) => d !== today && !isWeekend(d));
  const day = candidates.find((d) => growthOn(d) > 0) ?? null;

  if (!day) {
    done(EXIT.PARTIAL, 'NOT_GRADEABLE — no complete weekday in the window shows any growth', [
      ...ctx,
      `window      ${usage.days[usage.days.length - 1]} .. ${today} (today excluded, weekends excluded)`,
      ...candidates.map((d) => `  ${d}  created ${MB(growthOn(d))}`),
      'A zero here is ambiguous: a fresh volume, a boot inside the window, and a',
      'writer that stopped all look identical. Widen with --day= or re-run later.',
    ]);
  }

  const ranked = usage.entries
    .map((e) => ({
      name: e.name,
      created: e.createdBytesByDay?.[day] ?? 0,
      modified: e.modifiedBytesByDay?.[day] ?? 0,
      bytes: e.bytes,
      top: (e.byFile ?? [])
        .filter((p) => (p.createdBytesInWindow ?? 0) > 0)
        .slice(0, 3)
        .map((p) => `${p.pattern} ${MB(p.createdBytesInWindow)}`),
    }))
    .sort((a, b) => b.created - a.created);

  const total = ranked.reduce((n, e) => n + e.created, 0);
  const lines = [
    ...ctx,
    '',
    `graded day  ${day} (most recent complete weekday with growth)`,
    `grew        ${MB(total)} on ${day}`,
    '',
    'rank  entry                       created that day   held total   (modified that day)',
  ];
  ranked.forEach((e, i) => {
    if (e.created === 0 && i > 6) return;
    lines.push(
      `  ${String(i + 1).padStart(2)}  ${e.name.padEnd(26)} ${MB(e.created).padStart(12)} ${MB(e.bytes).padStart(12)}   (${MB(e.modified)})`,
    );
    for (const t of e.top) lines.push(`        └─ ${t}`);
  });

  const chains = ranked.find((e) => e.name === 'option-chains')?.created ?? 0;
  const residual = total - chains;
  lines.push(
    '',
    `option-chains  ${MB(chains)}`,
    `everything else ${MB(residual)}  ← the TRA-2420 residual, now named above`,
  );

  done(EXIT.ATTRIBUTED, `ATTRIBUTED — ${MB(total)} of growth on ${day}, ranked by writer`, lines);
}

// ── Controls ────────────────────────────────────────────────────────────────
// Four crafted payloads, served over a real socket, driven through this same
// file as a child process. Asserts the codes AND that they differ from each
// other — a grader whose branches all return the same thing is not a grader.
async function selfTest() {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const days = ['2026-07-29', '2026-07-28', '2026-07-27', '2026-07-26', '2026-07-25'];
  const entry = (name, bytes, created, modified, byFile = []) => ({
    name,
    kind: 'dir',
    bytes,
    files: 1,
    dirs: 1,
    newestMtime: `${days[0]}T12:00:00.000Z`,
    modifiedBytesByDay: Object.fromEntries(days.map((d) => [d, modified[d] ?? 0])),
    createdBytesByDay: created === null ? null : Object.fromEntries(days.map((d) => [d, created[d] ?? 0])),
    byFile,
  });
  const base = (over = {}) => ({
    disk: { usedBytes: 20 * 1048576, reservedBytes: 1048576, freePct: 42.6 },
    usage: {
      root: '/data',
      scannedAt: `${days[0]}T13:00:00.000Z`,
      durationMs: 12,
      totalBytes: 18 * 1048576,
      totalAllocatedBytes: 19 * 1048576,
      totalFiles: 4,
      days,
      truncated: false,
      errors: [],
      birthtime: { usable: true, sampledFiles: 4, missing: 0, distinctFromMtime: 2 },
      allocation: { usable: true, sampledPaths: 6, answeredPaths: 6, nonEmptyPaths: 4 },
      unaccounted: {
        diskUsedBytes: 20 * 1048576,
        reservedBytes: 1048576,
        attributableUsedBytes: 19 * 1048576,
        allocatedBytes: 19 * 1048576,
        bytes: 0,
        pct: 0,
        apparent: { measuredBytes: 18 * 1048576, bytes: 2 * 1048576, pct: 10 },
      },
      entries: [
        entry('option-chains', 12 * 1048576, { '2026-07-28': 1048576 }, { '2026-07-28': 1048576 }, [
          { pattern: 'AAPL.json.gz', files: 1, bytes: 1048576, createdBytesInWindow: 1048576 },
        ]),
        // The trap: 4 MB "modified" every day, zero growth. A grader reading the
        // wrong histogram ranks this first and names the wrong writer.
        entry('users', 6 * 1048576, { '2026-07-28': 3 * 1048576 }, { '2026-07-28': 6 * 1048576 }, [
          { pattern: 'eod-report-<date>.json', files: 2, bytes: 3 * 1048576, createdBytesInWindow: 3 * 1048576 },
        ]),
      ],
      ...over,
    },
  });

  const CASES = [
    ['ATTRIBUTED (positive mark)', base(), EXIT.ATTRIBUTED],
    ['NOT_DEPLOYED (old build, 200 with no usage key)', { disk: { freePct: 42.6 } }, EXIT.NOT_DEPLOYED],
    [
      'PARTIAL (birthtime unusable — growth unmeasurable, NOT zero growth)',
      base({
        birthtime: { usable: false, sampledFiles: 4, missing: 4, distinctFromMtime: 0 },
        entries: base().usage.entries.map((e) => ({ ...e, createdBytesByDay: null })),
      }),
      EXIT.PARTIAL,
    ],
    [
      'UNATTRIBUTED (the breakdown does not account for the disk)',
      base({
        unaccounted: {
          diskUsedBytes: 20 * 1048576,
          reservedBytes: 1048576,
          attributableUsedBytes: 19 * 1048576,
          allocatedBytes: 2 * 1048576,
          bytes: 17 * 1048576,
          pct: 89.474,
          apparent: { measuredBytes: 2 * 1048576, bytes: 18 * 1048576, pct: 90 },
        },
      }),
      EXIT.UNATTRIBUTED,
    ],
    ['BLIND (truncated scan — every figure is a floor)', base({ truncated: true }), EXIT.BLIND],
    // ── The TRA-2420 regression control ──────────────────────────────────────
    // bqb1's real shape as measured 2026-07-30: 373.8 MB apparent under /data,
    // 575 MB `df`-used, of which ~49 MB is ext4 root reserve and ~100 MB is 4 KiB
    // block rounding across ~48k small files. On the APPARENT basis the residual is
    // 35% and this script exits 1 UNATTRIBUTED; on the correct ALLOCATED basis it is
    // ~9% and the ranking is publishable. The pre-fix script had NO input that could
    // exit 0 on this host, so a working script and a broken one read identically.
    [
      'ATTRIBUTED despite a 35% APPARENT residual (bqb1 shape — the unit-mismatch regression)',
      base({
        totalBytes: 373 * 1048576,
        totalAllocatedBytes: 478 * 1048576,
        unaccounted: {
          diskUsedBytes: 575 * 1048576,
          reservedBytes: 49 * 1048576,
          attributableUsedBytes: 526 * 1048576,
          allocatedBytes: 478 * 1048576,
          bytes: 48 * 1048576,
          pct: 9.125,
          apparent: { measuredBytes: 373 * 1048576, bytes: 202 * 1048576, pct: 35.13 },
        },
      }),
      EXIT.ATTRIBUTED,
    ],
    [
      'PARTIAL (st_blocks unavailable — residual UNKNOWN, must not fall back to apparent)',
      base({
        totalAllocatedBytes: null,
        allocation: { usable: false, sampledPaths: 6, answeredPaths: 0, nonEmptyPaths: 4 },
        unaccounted: {
          diskUsedBytes: 20 * 1048576,
          reservedBytes: 1048576,
          attributableUsedBytes: 19 * 1048576,
          allocatedBytes: null,
          bytes: null,
          pct: null,
          apparent: { measuredBytes: 18 * 1048576, bytes: 2 * 1048576, pct: 10 },
        },
      }),
      EXIT.PARTIAL,
    ],
  ];

  let payload = null;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;

  let failures = 0;
  const seen = [];
  for (const [label, body, want] of CASES) {
    payload = body;
    let code = 0;
    let out = '';
    try {
      const r = await execFileAsync(process.execPath, [process.argv[1], `--host=${host}`]);
      out = r.stdout;
    } catch (err) {
      code = err.code ?? -1;
      out = err.stdout ?? '';
    }
    seen.push(code);
    const ok = code === want;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  exit ${code} (want ${want})  ${label}`);
    if (!ok) console.log(out);
  }
  // Positive mark: the ATTRIBUTED case must actually rank by GROWTH, so
  // option-chains (1 MB created) sorts below users (3 MB created) even though
  // users' modified figure is twice as large.
  payload = base();
  const r = await execFileAsync(process.execPath, [process.argv[1], `--host=${host}`]);
  const order = [...r.stdout.matchAll(/^\s+\d+\s+(\S+)/gm)].map((m) => m[1]);
  if (order[0] !== 'users' || order[1] !== 'option-chains') {
    failures += 1;
    console.log(`  FAIL  ranked by the wrong histogram: ${order.join(' > ')}`);
  } else {
    console.log(`  ok    ranked by GROWTH not activity: ${order.join(' > ')}`);
  }
  // A grader whose branches all return the same thing is not a grader. The check
  // is that every one of the five codes is REACHABLE — not that each case is
  // unique, since two cases may legitimately share a code (the bqb1-shape control
  // shares 0 with the positive mark, which is the entire point of it).
  const reached = new Set(seen);
  const missing = Object.entries(EXIT)
    .filter(([, code]) => !reached.has(code))
    .map(([name, code]) => `${name}(${code})`);
  if (missing.length > 0) {
    failures += 1;
    console.log(`  FAIL  exit codes never reached by any control: ${missing.join(', ')}`);
  } else {
    console.log(`  ok    all ${reached.size} exit codes reachable across ${seen.length} controls`);
  }
  server.close();
  console.log(`\n[TRA-2420 self-test] ${failures === 0 ? 'PASS' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv.includes('--self-test')) {
  selfTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    done(EXIT.BLIND, 'BLIND — unexpected failure', [String(err?.stack ?? err)]);
  });
}
